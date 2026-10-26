"""Event-based (interval) agreement.

Each annotation is treated as an event. For a pair of annotators (one acting
as the reference) and a category, every reference event is compared with every
event of the other annotator:

* **Eligibility.** With the ``iou`` criterion a pair is eligible when its
  temporal intersection over union (IoU) reaches the threshold; a threshold of
  0 means any overlap. With ``tolerance`` the onsets and the offsets must each
  differ by no more than the configured tolerances (overlap is not required).
  ``iou_and_tolerance`` requires both. In time-and-channel mode the two events
  must also share channels (channel Jaccard index above ``min_channel_jaccard``;
  whole-montage events cover every channel).
* **Matching.** By default each event can be matched at most once
  (one-to-one). Among all one-to-one assignments of eligible pairs, the one
  with the most matches is chosen and, among those, the one with the largest
  total IoU. The problem is solved exactly with the Hungarian algorithm
  (``scipy.optimize.linear_sum_assignment``) after sorting events by onset,
  offset and identifier, so the result is deterministic. If many-to-one
  matching is explicitly allowed, every eligible pair counts as a match.

Precision is the fraction of the compared annotator's events that are matched,
recall the fraction of reference events that are matched, and F1 their
harmonic mean. For one-to-one matching, F1 does not depend on which annotator
is the reference.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from typing import Any

import numpy as np
from scipy.optimize import linear_sum_assignment

from electroclean.app.annotations.model import AnnotationDocument
from electroclean.reliability.config import ANY_ARTIFACT, AnalysisConfig
from electroclean.reliability.data import AgreementDataset
from electroclean.reliability.intervals import iou


@dataclass(frozen=True)
class Event:
    annotator: str
    annotation_id: str
    label: str
    start: int
    stop: int
    channels: frozenset[str]
    whole_montage: bool


def events_for(doc: AnnotationDocument, category: str, ch_names: tuple[str, ...]) -> list[Event]:
    allowed = set(ch_names)
    out = []
    for a in doc.annotations:
        if category != ANY_ARTIFACT and a.label != category:
            continue
        chans = frozenset(ch_names) if a.is_global else frozenset(c for c in a.channels if c in allowed)
        out.append(Event(doc.annotator_id, a.annotation_id, a.label, a.onset_sample, a.end_sample, chans, a.is_global))
    out.sort(key=lambda e: (e.start, e.stop, e.annotation_id))
    return out


def channel_jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    u = len(a | b)
    return len(a & b) / u if u else 0.0


@dataclass
class MatchOutcome:
    pairs: list[tuple[int, int]]
    unmatched_ref: list[int]
    unmatched_test: list[int]
    matched_ref: int
    matched_test: int


def match_events(
    ref: list[Event],
    test: list[Event],
    *,
    sfreq: float,
    criterion: str,
    iou_threshold: float,
    onset_tolerance_s: float,
    offset_tolerance_s: float,
    require_channels: bool,
    min_channel_jaccard: float,
    many_to_one: bool,
) -> MatchOutcome:
    n, m = len(ref), len(test)
    if n == 0 or m == 0:
        return MatchOutcome([], list(range(n)), list(range(m)), 0, 0)
    eligible = np.zeros((n, m), dtype=bool)
    score = np.zeros((n, m))
    for i, r in enumerate(ref):
        for j, t in enumerate(test):
            ov = iou((r.start, r.stop), (t.start, t.stop))
            d_on = abs(t.start - r.start) / sfreq
            d_off = abs(t.stop - r.stop) / sfreq
            ok_iou = ov > 0 if iou_threshold <= 0 else ov >= iou_threshold - 1e-12
            ok_tol = d_on <= onset_tolerance_s + 1e-12 and d_off <= offset_tolerance_s + 1e-12
            if criterion == "iou":
                ok = ok_iou
            elif criterion == "tolerance":
                ok = ok_tol
            else:
                ok = ok_iou and ok_tol
            if ok and require_channels:
                jac = channel_jaccard(r.channels, t.channels)
                ok = jac > 0 if min_channel_jaccard <= 0 else jac >= min_channel_jaccard - 1e-12
            if ok:
                eligible[i, j] = True
                score[i, j] = ov if criterion != "tolerance" else 1.0 / (1.0 + d_on + d_off)
    if many_to_one:
        pairs = [(int(i), int(j)) for i, j in zip(*np.nonzero(eligible))]
        mr = set(i for i, _ in pairs)
        mt = set(j for _, j in pairs)
        return MatchOutcome(
            pairs, [i for i in range(n) if i not in mr], [j for j in range(m) if j not in mt], len(mr), len(mt)
        )
    big = min(n, m) + 1.0  # lexicographic: number of matches first, then total score
    weights = np.where(eligible, big + score, 0.0)
    rows, cols = linear_sum_assignment(weights, maximize=True)
    pairs = [(int(i), int(j)) for i, j in zip(rows, cols) if eligible[i, j]]
    pairs.sort()
    mr = {i for i, _ in pairs}
    mt = {j for _, j in pairs}
    return MatchOutcome(pairs, [i for i in range(n) if i not in mr], [j for j in range(m) if j not in mt], len(mr), len(mt))


def _pairs(raters: list[str], reference: str | None) -> list[tuple[str, str]]:
    if reference is not None:
        return [(reference, r) for r in raters if r != reference] if reference in raters else []
    return list(combinations(raters, 2))


def _summary(values: list[float]) -> dict[str, float]:
    if not values:
        nan = float("nan")
        return {"mean": nan, "sd": nan, "median": nan, "mean_abs": nan, "loa_low": nan, "loa_high": nan}
    v = np.asarray(values, dtype=float)
    sd = float(v.std(ddof=1)) if len(v) > 1 else float("nan")
    mean = float(v.mean())
    return {
        "mean": mean,
        "sd": sd,
        "median": float(np.median(v)),
        "mean_abs": float(np.mean(np.abs(v))),
        "loa_low": mean - 1.96 * sd if not np.isnan(sd) else float("nan"),
        "loa_high": mean + 1.96 * sd if not np.isnan(sd) else float("nan"),
    }


def event_agreement(dataset: AgreementDataset, config: AnalysisConfig) -> dict[str, list[dict[str, Any]]]:
    """Matching results: summary rows, matched pairs and unmatched events."""
    cats = list(config.categories) if config.categories else list(dataset.catalogue.label_names)
    if config.include_any_artifact:
        cats.append(ANY_ARTIFACT)
    summary: list[dict[str, Any]] = []
    matched_rows: list[dict[str, Any]] = []
    unmatched_rows: list[dict[str, Any]] = []
    for mode in config.channel_modes:
        require_channels = mode == "time_and_channel"
        for thr in config.matching_thresholds:
            micro: dict[tuple[str, str], dict[str, float]] = {}
            for cat in cats:
                pooled: dict[tuple[str, str], dict[str, Any]] = {}
                for rid, group in sorted(dataset.groups.items()):
                    raters = group.annotators
                    if len(raters) < 2:
                        continue
                    sf = group.timing.sfreq
                    evs = {r: events_for(group.docs[r], cat, group.ch_names) for r in raters}
                    for a, b in _pairs(raters, config.reference_annotator):
                        out = match_events(
                            evs[a], evs[b], sfreq=sf, criterion=config.match_criterion, iou_threshold=thr,
                            onset_tolerance_s=config.onset_tolerance_s, offset_tolerance_s=config.offset_tolerance_s,
                            require_channels=require_channels, min_channel_jaccard=config.min_channel_jaccard,
                            many_to_one=config.allow_many_to_one,
                        )
                        acc = pooled.setdefault((a, b), {"n_ref": 0, "n_test": 0, "matched_ref": 0, "matched_test": 0,
                                                          "iou": [], "d_on": [], "d_off": [], "d_dur": [], "jac": []})
                        acc["n_ref"] += len(evs[a])
                        acc["n_test"] += len(evs[b])
                        acc["matched_ref"] += out.matched_ref
                        acc["matched_test"] += out.matched_test
                        for i, j in out.pairs:
                            r, t = evs[a][i], evs[b][j]
                            ov = iou((r.start, r.stop), (t.start, t.stop))
                            d_on = (t.start - r.start) / sf
                            d_off = (t.stop - r.stop) / sf
                            d_dur = ((t.stop - t.start) - (r.stop - r.start)) / sf
                            jac = channel_jaccard(r.channels, t.channels)
                            acc["iou"].append(ov)
                            acc["d_on"].append(d_on)
                            acc["d_off"].append(d_off)
                            acc["d_dur"].append(d_dur)
                            acc["jac"].append(jac)
                            matched_rows.append({
                                "recording": rid, "category": cat, "channel_mode": mode, "threshold": thr,
                                "criterion": config.match_criterion, "reference": a, "compared": b,
                                "reference_id": r.annotation_id, "compared_id": t.annotation_id,
                                "reference_label": r.label, "compared_label": t.label,
                                "reference_onset_s": r.start / sf, "reference_offset_s": r.stop / sf,
                                "compared_onset_s": t.start / sf, "compared_offset_s": t.stop / sf,
                                "iou": ov, "onset_diff_s": d_on, "offset_diff_s": d_off, "duration_diff_s": d_dur,
                                "channel_jaccard": jac,
                                "reference_channels": "ALL" if r.whole_montage else ",".join(sorted(r.channels)),
                                "compared_channels": "ALL" if t.whole_montage else ",".join(sorted(t.channels)),
                            })
                        for who, idx_list, events in (("reference", out.unmatched_ref, evs[a]), ("compared", out.unmatched_test, evs[b])):
                            for i in idx_list:
                                e = events[i]
                                unmatched_rows.append({
                                    "recording": rid, "category": cat, "channel_mode": mode, "threshold": thr,
                                    "criterion": config.match_criterion, "reference": a, "compared": b,
                                    "side": who, "kind": "missed (false negative)" if who == "reference" else "extra (false positive)",
                                    "annotator": e.annotator, "annotation_id": e.annotation_id, "label": e.label,
                                    "onset_s": e.start / sf, "offset_s": e.stop / sf,
                                    "channels": "ALL" if e.whole_montage else ",".join(sorted(e.channels)),
                                })
                for (a, b), acc in sorted(pooled.items()):
                    summary.append(_summary_row(cat, mode, thr, config, a, b, acc))
                    if cat != ANY_ARTIFACT:
                        mi = micro.setdefault((a, b), {"n_ref": 0, "n_test": 0, "matched_ref": 0, "matched_test": 0,
                                                       "iou": [], "d_on": [], "d_off": [], "d_dur": [], "jac": []})
                        for k in ("n_ref", "n_test", "matched_ref", "matched_test"):
                            mi[k] += acc[k]
                        for k in ("iou", "d_on", "d_off", "d_dur", "jac"):
                            mi[k].extend(acc[k])
            for (a, b), acc in sorted(micro.items()):
                summary.append(_summary_row("ALL categories (micro-average)", mode, thr, config, a, b, acc))
    return {"summary": summary, "matched": matched_rows, "unmatched": unmatched_rows}


def _summary_row(cat: str, mode: str, thr: float, config: AnalysisConfig, a: str, b: str, acc: dict[str, Any]) -> dict[str, Any]:
    n_ref, n_test = acc["n_ref"], acc["n_test"]
    recall = acc["matched_ref"] / n_ref if n_ref else float("nan")
    precision = acc["matched_test"] / n_test if n_test else float("nan")
    if n_ref == 0 and n_test == 0:
        f1 = float("nan")
    elif np.isnan(recall) or np.isnan(precision) or (precision + recall) == 0:
        f1 = 0.0
    else:
        f1 = 2 * precision * recall / (precision + recall)
    row = {
        "category": cat, "channel_mode": mode, "criterion": config.match_criterion,
        "threshold": thr if config.match_criterion != "tolerance" else float("nan"),
        "onset_tolerance_s": config.onset_tolerance_s if config.match_criterion != "iou" else float("nan"),
        "offset_tolerance_s": config.offset_tolerance_s if config.match_criterion != "iou" else float("nan"),
        "matching": "many-to-one allowed" if config.allow_many_to_one else "one-to-one",
        "reference": a, "compared": b, "n_reference": n_ref, "n_compared": n_test,
        "matched_reference": acc["matched_ref"], "matched_compared": acc["matched_test"],
        "missed": n_ref - acc["matched_ref"], "extra": n_test - acc["matched_test"],
        "precision": precision, "recall": recall, "f1": f1,
        "mean_iou": float(np.mean(acc["iou"])) if acc["iou"] else float("nan"),
        "mean_channel_jaccard": float(np.mean(acc["jac"])) if acc["jac"] else float("nan"),
    }
    for name, key in (("onset_diff", "d_on"), ("offset_diff", "d_off"), ("duration_diff", "d_dur")):
        for stat, v in _summary(acc[key]).items():
            row[f"{name}_{stat}_s"] = v
    return row
