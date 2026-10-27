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
"""

from __future__ import annotations

from collections.abc import Iterable
from itertools import combinations
from typing import Any

import numpy as np

from electroclean.app.annotations.model import AnnotationDocument
from electroclean.app.annotations.labels import LabelCatalogue
from electroclean.reliability.config import ANY_ARTIFACT, ROLLUP_SUFFIX, AnalysisConfig, is_rollup, rollup_name
from electroclean.reliability.data import AgreementDataset, RecordingGroup
from electroclean.reliability.intervals import (
    Interval,
    binarise,
    coverage_per_bin,
    intersection_length,
    total_length,
    union,
)
from electroclean.reliability.statistics import (
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
    if labels is not None:
        anns = [a for a in doc.annotations if a.label in labels]
    elif category == ANY_ARTIFACT:
        anns = [a for a in doc.annotations if not categories or a.label in categories]
    else:
        anns = [a for a in doc.annotations if a.label == category]
    if channel is not None:
        anns = [a for a in anns if a.is_global or channel in a.channels]
    return union((a.onset_sample, a.end_sample) for a in anns)


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
    for unit in _units(group, mode):
        ints = {r: category_intervals(group.docs[r], category, unit, config.categories, labels) for r in raters}
        if representation == "exact":
            n = timing.n_samples
            scale = 1.0 / timing.sfreq
            lengths = {r: total_length(v) for r, v in ints.items()}
            for a, b in pairs:
                both = intersection_length(ints[a], ints[b])
                t = PairTable(
                    both * scale,
                    (lengths[a] - both) * scale,
                    (lengths[b] - both) * scale,
                    (n - lengths[a] - lengths[b] + both) * scale,
                )
                pair_tables[(a, b)] = pair_tables.get((a, b), PairTable(0, 0, 0, 0)) + t
            # Multi-rater statistics use samples as units: Krippendorff's alpha has a
            # small-sample term (n - 1) and must not depend on the unit of time.
            for k, samples in coverage_count_histogram(list(ints.values()), n).items():
                hist[(m, k)] = hist.get((m, k), 0.0) + float(samples)
        else:
            res = resolution_of(representation)
            vec = {
                r: binarise(coverage_per_bin(v, timing.sfreq, res, timing.duration_s), config.min_bin_coverage)
                for r, v in ints.items()
            }
            for a, b in pairs:
                va, vb = vec[a], vec[b]
                t = PairTable(
                    float(np.sum(va & vb)), float(np.sum(va & ~vb)), float(np.sum(~va & vb)), float(np.sum(~va & ~vb))
                )
                pair_tables[(a, b)] = pair_tables.get((a, b), PairTable(0, 0, 0, 0)) + t
            if raters:
                counts = np.sum(np.vstack([vec[r] for r in raters]), axis=0)
                for k, w in enumerate(np.bincount(counts, minlength=m + 1)):
                    if w:
                        hist[(m, k)] = hist.get((m, k), 0.0) + float(w)
    return pair_tables, hist, 1.0


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
