"""Time-resolved agreement.

For every recording, artifact category and pair of annotators, the recording
is divided into four parts: time marked by both, by only one or the other, and
by neither. This is done in two representations:

``exact``
    Sample-level interval arithmetic. Counts are seconds (time-only mode) or
    channel-seconds (time-and-channel mode). Nothing is approximated.
``bins_<r>s``
    The recording is cut into consecutive bins of ``r`` seconds; a bin counts
    as positive for an annotator when the annotator's intervals cover at least
    ``min_bin_coverage`` of it (0 = any overlap). Counts are numbers of bins
    (or channel-bins). Changing ``r`` shows how much agreement depends on
    boundary precision.

Overlapping annotations of the same category by one annotator are combined
(union) for these analyses: the question is *whether* an annotator considered
that time affected by that artifact type. Whole-montage annotations cover
every channel of the recording in time-and-channel mode.

In time-and-channel mode most channels of a recording carry the same
intervals for every annotator (the whole-montage annotations only, or none at
all), so the contribution of each distinct combination of intervals is
computed once and added for every channel that has it, in channel order; the
results are identical to computing every channel separately.
"""

from __future__ import annotations

from collections.abc import Iterable
from itertools import combinations
from typing import Any

import numpy as np

from electrotag.app.annotations.model import AnnotationDocument
from electrotag.app.annotations.labels import LabelCatalogue
from electrotag.reliability.config import ANY_ARTIFACT, ROLLUP_SUFFIX, AnalysisConfig, is_rollup, rollup_name
from electrotag.reliability.data import AgreementDataset, RecordingGroup
from electrotag.reliability.intervals import (
    Interval,
    intersection_length,
    positive_bins,
    total_length,
    union,
)
from electrotag.reliability.statistics import (
    PairTable,
    fleiss_kappa,
    krippendorff_alpha_binary,
    pair_statistics,
)


def category_label_set(category: str, catalogue: LabelCatalogue, config: AnalysisConfig) -> frozenset[str]:
    """The labels an analysis category covers.

    A label covers itself; ANY-artifact covers every analysed label; a group
    roll-up ("Eye-artifact + subtypes") covers the group term and every
    analysed label below it.
    """
    analysed = set(config.categories) if config.categories else set(catalogue.label_names)
    if category == ANY_ARTIFACT:
        return frozenset(analysed)
    if is_rollup(category):
        group = category[: -len(ROLLUP_SUFFIX)]
        return frozenset(({group} | set(catalogue.descendants(group))) & analysed)
    return frozenset({category})


def category_intervals(
    doc: AnnotationDocument, category: str, channel: str | None = None, categories: tuple[str, ...] | None = None,
    labels: frozenset[str] | set[str] | None = None,
) -> list[Interval]:
    """Union of one annotator's intervals for a category (and channel).

    ``labels`` (from :func:`category_label_set`) gives the labels the category
    covers; without it, ANY-artifact pools the ``categories`` being analysed
    (``None`` = all) and any other category is a single label.
    """
    anns = _category_annotations(doc, category, categories, labels)
    if channel is not None:
        anns = [a for a in anns if a.is_global or channel in a.channels]
    return union((a.onset_sample, a.end_sample) for a in anns)


def _category_annotations(
    doc: AnnotationDocument, category: str, categories: tuple[str, ...] | None, labels: frozenset[str] | set[str] | None,
) -> list[Any]:
    if labels is not None:
        return [a for a in doc.annotations if a.label in labels]
    if category == ANY_ARTIFACT:
        return [a for a in doc.annotations if not categories or a.label in categories]
    return [a for a in doc.annotations if a.label == category]


def _intervals_by_unit(
    doc: AnnotationDocument, category: str, units: list[str | None], categories: tuple[str, ...] | None,
    labels: frozenset[str] | None,
) -> list[tuple[Interval, ...]]:
    """:func:`category_intervals` for every unit (``None`` = time only, or a channel), in one pass.

    Channels with no channel-specific annotation share one tuple (the union of
    the whole-montage annotations), which lets callers recognise them.
    """
    anns = _category_annotations(doc, category, categories, labels)
    whole = [(a.onset_sample, a.end_sample) for a in anns if a.is_global]
    per_channel: dict[str, list[Interval]] = {}
    for a in anns:
        if not a.is_global:
            for ch in set(a.channels):
                per_channel.setdefault(ch, []).append((a.onset_sample, a.end_sample))
    everything = tuple(union((a.onset_sample, a.end_sample) for a in anns))
    shared = tuple(union(whole))
    out: list[tuple[Interval, ...]] = []
    for unit in units:
        if unit is None:
            out.append(everything)
        elif unit in per_channel:
            out.append(tuple(union(whole + per_channel[unit])))
        else:
            out.append(shared)
    return out


def coverage_count_histogram(interval_lists: list[list[Interval]], n_samples: int) -> dict[int, int]:
    """Number of samples covered by exactly k of the interval lists, for each k."""
    deltas: dict[int, int] = {0: 0, n_samples: 0}
    for ints in interval_lists:
        for a, b in ints:
            a, b = max(0, a), min(n_samples, b)
            if b > a:
                deltas[a] = deltas.get(a, 0) + 1
                deltas[b] = deltas.get(b, 0) - 1
    hist: dict[int, int] = {}
    level = 0
    points = sorted(deltas)
    for x0, x1 in zip(points[:-1], points[1:]):
        level += deltas[x0]
        if x1 > x0:
            hist[level] = hist.get(level, 0) + (x1 - x0)
    return hist


def _units(group: RecordingGroup, mode: str) -> list[str | None]:
    return [None] if mode == "time_only" else list(group.ch_names)


def _pairs(raters: list[str], reference: str | None) -> list[tuple[str, str]]:
    if reference is not None:
        return [(reference, r) for r in raters if r != reference] if reference in raters else []
    return list(combinations(raters, 2))


def recording_tables(
    group: RecordingGroup,
    category: str,
    mode: str,
    representation: str,
    config: AnalysisConfig,
    labels: frozenset[str] | None = None,
) -> tuple[dict[tuple[str, str], PairTable], dict[tuple[int, int], float], float]:
    """Pair tables and the multi-rater histogram for one recording.

    Returns ``(pair_tables, histogram, unit_weight)``. For the exact
    representation the pair tables are in seconds (or channel-seconds) and the
    multi-rater histogram counts samples (or channel-samples); for bins both
    count bins (or channel-bins).
    """
    raters = group.annotators
    m = len(raters)
    timing = group.timing
    pair_tables: dict[tuple[str, str], PairTable] = {}
    hist: dict[tuple[int, int], float] = {}
    pairs = list(combinations(raters, 2))
    units = _units(group, mode)
    per_rater = {r: _intervals_by_unit(group.docs[r], category, units, config.categories, labels) for r in raters}
    # One contribution per distinct combination of the raters' intervals (most channels share one:
    # unmarked, or marked only by whole-montage annotations), added for each unit in unit order so
    # that the sums are exactly those of a channel-by-channel computation.
    contributions: dict[tuple[tuple[Interval, ...], ...], _Contribution] = {}
    vectors: dict[tuple[Interval, ...], tuple[int, np.ndarray]] = {}
    for i in range(len(units)):
        key = tuple(per_rater[r][i] for r in raters)
        part = contributions.get(key)
        if part is None:
            ints = dict(zip(raters, key))
            if representation == "exact":
                part = _exact_contribution(ints, pairs, m, timing.n_samples, timing.sfreq)
            else:
                part = _binned_contribution(ints, raters, pairs, m, timing, resolution_of(representation),
                                            config.min_bin_coverage, vectors)
            contributions[key] = part
        for pair, t in part[0]:
            pair_tables[pair] = pair_tables.get(pair, PairTable(0, 0, 0, 0)) + t
        for k, w in part[1]:
            hist[k] = hist.get(k, 0.0) + w
    return pair_tables, hist, 1.0


# Pair tables and multi-rater histogram entries that one unit adds, in the order they are added.
_Contribution = tuple[list[tuple[tuple[str, str], PairTable]], list[tuple[tuple[int, int], float]]]


def _exact_contribution(
    ints: dict[str, tuple[Interval, ...]], pairs: list[tuple[str, str]], m: int, n: int, sfreq: float,
) -> _Contribution:
    scale = 1.0 / sfreq
    lengths = {r: total_length(v) for r, v in ints.items()}
    tables = []
    for a, b in pairs:
        both = intersection_length(list(ints[a]), list(ints[b]))
        tables.append(((a, b), PairTable(
            both * scale,
            (lengths[a] - both) * scale,
            (lengths[b] - both) * scale,
            (n - lengths[a] - lengths[b] + both) * scale,
        )))
    # Multi-rater statistics use samples as units: Krippendorff's alpha has a
    # small-sample term (n - 1) and must not depend on the unit of time.
    histogram = coverage_count_histogram([list(v) for v in ints.values()], n)
    return tables, [((m, k), float(samples)) for k, samples in histogram.items()]


def _binned_contribution(
    ints: dict[str, tuple[Interval, ...]], raters: list[str], pairs: list[tuple[str, str]], m: int, timing: Any,
    res: float, min_coverage: float, vectors: dict[tuple[Interval, ...], tuple[int, np.ndarray]],
) -> _Contribution:
    # Each rater's positive bins as sorted indices (most bins of a channel are empty); the counts are
    # integers, so they are exactly those of whole vectors of bins.
    pos: dict[str, np.ndarray] = {}
    n_bins = 0
    for r, v in ints.items():
        if v not in vectors:  # the same intervals give the same bins, whoever drew them
            vectors[v] = positive_bins(list(v), timing.sfreq, res, timing.duration_s, min_coverage)
        n_bins, pos[r] = vectors[v]
    tables = []
    for a, b in pairs:
        pa, pb = pos[a], pos[b]
        both = len(np.intersect1d(pa, pb, assume_unique=True))
        tables.append(((a, b), PairTable(
            float(both), float(len(pa) - both), float(len(pb) - both), float(n_bins - len(pa) - len(pb) + both)
        )))
    counts: list[tuple[tuple[int, int], float]] = []
    if raters:
        _, per_bin = np.unique(np.concatenate([pos[r] for r in raters]), return_counts=True)
        hist = np.bincount(per_bin, minlength=m + 1)
        hist[0] = n_bins - len(per_bin)
        counts = [((m, k), float(w)) for k, w in enumerate(hist) if w]
    return tables, counts


def representation_name(resolution_s: float) -> str:
    """Name of a binned representation; reading it back gives exactly ``resolution_s``."""
    text = f"{resolution_s:g}"
    if float(text) != resolution_s:
        text = repr(float(resolution_s))
    return f"bins_{text}s"


def resolution_of(representation: str) -> float:
    return float(representation.removeprefix("bins_").removesuffix("s"))


def representations(config: AnalysisConfig) -> list[str]:
    return ["exact"] + [representation_name(r) for r in config.resolutions_s]


def categories_for(dataset: AgreementDataset, config: AnalysisConfig) -> list[str]:
    """Analysis categories: each label, the roll-up of each group term just after it, then ANY-artifact.

    Data-artifact is the top of the hierarchy, so its roll-up would repeat
    ANY-artifact and is not added.
    """
    cat = dataset.catalogue
    labels = list(config.categories) if config.categories else list(cat.label_names)
    analysed = set(labels)
    cats: list[str] = []
    for lab in labels:
        cats.append(lab)
        if (
            config.include_group_rollups and cat.is_permitted(lab) and cat.get(lab).is_group
            and cat.get(lab).parent is not None and set(cat.descendants(lab)) & analysed
        ):
            cats.append(rollup_name(lab))
    if config.include_any_artifact:
        cats.append(ANY_ARTIFACT)
    return cats


def _unit_name(mode: str, rep: str, multirater: bool = False) -> str:
    base = ("samples" if multirater else "seconds") if rep == "exact" else "bins"
    return base if mode == "time_only" else f"channel-{base}"


def time_resolved_agreement(dataset: AgreementDataset, config: AnalysisConfig) -> dict[str, list[dict[str, Any]]]:
    """Pairwise and multi-rater time-resolved agreement (per recording and pooled)."""
    pair_rows: list[dict[str, Any]] = []
    multi_rows: list[dict[str, Any]] = []
    cats = categories_for(dataset, config)
    for mode in config.channel_modes:
        for rep in representations(config):
            for cat in cats:
                labels = category_label_set(cat, dataset.catalogue, config)
                pooled_pairs: dict[tuple[str, str], PairTable] = {}
                pooled_hist: dict[tuple[int, int], float] = {}
                pooled_raters: set[str] = set()
                n_recordings: dict[tuple[str, str], int] = {}
                for rid, group in sorted(dataset.groups.items()):
                    if len(group.docs) < 2:
                        continue
                    tables, hist, _ = recording_tables(group, cat, mode, rep, config, labels)
                    if config.reference_annotator:
                        tables = {k: t for k, t in tables.items() if config.reference_annotator in k}
                    pooled_raters.update(group.annotators)
                    for (a, b), t in tables.items():
                        key = _orient(a, b, config.reference_annotator)
                        tt = t if key == (a, b) else PairTable(t.a, t.c, t.b, t.d)
                        pooled_pairs[key] = pooled_pairs.get(key, PairTable(0, 0, 0, 0)) + tt
                        n_recordings[key] = n_recordings.get(key, 0) + 1
                        pair_rows.append(_pair_row(rid, cat, mode, rep, key, tt))
                    for k, w in hist.items():
                        pooled_hist[k] = pooled_hist.get(k, 0.0) + w
                    multi_rows.append(_multi_row(rid, cat, mode, rep, hist, tables, group.annotators))
                for key, t in sorted(pooled_pairs.items()):
                    row = _pair_row("ALL (pooled)", cat, mode, rep, key, t)
                    row["n_recordings"] = n_recordings[key]
                    pair_rows.append(row)
                if pooled_hist:
                    multi_rows.append(
                        _multi_row("ALL (pooled)", cat, mode, rep, pooled_hist, pooled_pairs, sorted(pooled_raters))
                    )
    return {"pairwise": pair_rows, "multirater": multi_rows}


def _orient(a: str, b: str, reference: str | None) -> tuple[str, str]:
    if reference is not None and b == reference:
        return (b, a)
    return (a, b)


def _pair_row(scope: str, cat: str, mode: str, rep: str, key: tuple[str, str], t: PairTable) -> dict[str, Any]:
    s = pair_statistics(t)
    return {
        "recording": scope,
        "category": cat,
        "channel_mode": mode,
        "representation": rep,
        "unit": _unit_name(mode, rep),
        "rater_1": key[0],
        "rater_2": key[1],
        **s.as_dict(),
    }


def _multi_row(
    scope: str, cat: str, mode: str, rep: str, hist: dict[tuple[int, int], float],
    tables: dict[tuple[str, str], PairTable], raters: Iterable[str],
) -> dict[str, Any]:
    fk, fk_note = fleiss_kappa(hist)
    alpha, a_note = krippendorff_alpha_binary(hist)
    kappas = [pair_statistics(t).cohen_kappa for t in tables.values()]
    kappas = [k for k in kappas if not np.isnan(k)]
    ms = sorted({m for (m, _k) in hist})
    return {
        "recording": scope,
        "category": cat,
        "channel_mode": mode,
        "representation": rep,
        "unit": _unit_name(mode, rep, multirater=True),
        "raters": ", ".join(sorted(raters)),
        "raters_per_unit": ",".join(str(m) for m in ms),
        "n_units": sum(hist.values()),
        "fleiss_kappa": fk,
        "fleiss_note": fk_note,
        "krippendorff_alpha": alpha,
        "alpha_note": a_note,
        "mean_pairwise_kappa": float(np.mean(kappas)) if kappas else float("nan"),
    }


def category_confusion(dataset: AgreementDataset, config: AnalysisConfig) -> list[dict[str, Any]]:
    """Time (s) where rater 1 assigned category x while rater 2 assigned y (exact, time-only).

    ``none`` means no artifact label. Time with several labels from one rater
    is counted once for each label combination.
    """
    labels = list(config.categories) if config.categories else list(dataset.catalogue.label_names)
    totals: dict[tuple[str, str, str, str], float] = {}
    for _rid, group in sorted(dataset.groups.items()):
        raters = group.annotators
        if len(raters) < 2:
            continue
        sf = group.timing.sfreq
        per = {r: {c: category_intervals(group.docs[r], c) for c in labels} for r in raters}
        for a, b in _pairs(raters, config.reference_annotator):
            points = {0, group.timing.n_samples}
            for r in (a, b):
                for ints in per[r].values():
                    for s0, s1 in ints:
                        points.update((s0, s1))
            pts = sorted(points)
            for x0, x1 in zip(pts[:-1], pts[1:]):
                if x1 <= x0:
                    continue
                mid = x0
                la = [c for c, ints in per[a].items() if _covers(ints, mid)] or ["none"]
                lb = [c for c, ints in per[b].items() if _covers(ints, mid)] or ["none"]
                for x in la:
                    for y in lb:
                        key = (a, b, x, y)
                        totals[key] = totals.get(key, 0.0) + (x1 - x0) / sf
    return [
        {"rater_1": a, "rater_2": b, "label_rater_1": x, "label_rater_2": y, "seconds": v}
        for (a, b, x, y), v in sorted(totals.items())
    ]


def _covers(ints: list[Interval], sample: int) -> bool:
    lo, hi = 0, len(ints)
    while lo < hi:
        mid = (lo + hi) // 2
        if ints[mid][1] <= sample:
            lo = mid + 1
        else:
            hi = mid
    return lo < len(ints) and ints[lo][0] <= sample < ints[lo][1]
