"""How confident annotators said they were of their marks, and what that tells about agreement.

Each annotation may carry a confidence rating on an ordinal 5-point Likert scale, from 1 (not at all
confident) to 5 (completely confident); see ``docs/design_decisions.md``. With the study setting
``annotation.confidence`` = ``"every_mark"`` annotators are asked to rate each new mark (no mark
starts with a rating); with ``"optional"`` (the default) they rate a mark only when they wish, so
the rated marks are a self-selected subset.

Three tables are made:

``confidence_by_annotator``
    For each annotator: how many marks were rated, the distribution over 1 to 5, the median rating,
    and how many marks carry a note.
``confidence_sensitivity``
    Made only when some mark was rated: the main agreement measures (positive agreement and Cohen's
    kappa sample by sample, all recordings pooled, and event F1 at the main threshold) for all marks,
    and again without the marks of low confidence (ratings 1 and 2). Unrated marks are kept in both,
    so in an optional study the second set is "all marks except those the annotator doubted".
``confidence_calibration``
    For each annotator and rating (and all annotators together): the share of their marks matched by
    a mark of the same type from at least one other annotator of the recording (time only, at the
    main threshold). If confident marks are matched more often, the ratings carry information.

Notes are research content: they are listed with each annotation in ``events_matched`` and
``events_unmatched`` and take part in none of the statistics.
"""

from __future__ import annotations

import dataclasses
import statistics
from typing import Any

from electrotag.app.annotations.model import CONFIDENCE_ANCHORS, CONFIDENCE_LEVELS
from electrotag.reliability.config import AnalysisConfig
from electrotag.reliability.data import AgreementDataset, RecordingGroup
from electrotag.reliability.matching import event_agreement, events_for, match_events
from electrotag.reliability.statistics import PairTable, pair_statistics
from electrotag.reliability.timeresolved import categories_for, category_label_set, recording_tables

#: Ratings left out of the sensitivity analysis.
LOW_CONFIDENCE = (1, 2)
NOT_RECORDED = "not recorded"
NOT_RATED = "not rated"
ALL_ANNOTATORS = "ALL annotators"

BY_ANNOTATOR_COLUMNS = ["annotator", "confidence_setting", "n_recordings", "n_annotations", "n_rated", "share_rated",
                        *[f"n_rated_{lv}" for lv in CONFIDENCE_LEVELS], "n_not_rated", "median_confidence",
                        "n_with_note"]
SENSITIVITY_COLUMNS = ["category", "channel_mode", "rater_1", "rater_2", "n_marks_all",
                       "n_marks_without_low_confidence", "positive_agreement_all",
                       "positive_agreement_without_low_confidence", "cohen_kappa_all",
                       "cohen_kappa_without_low_confidence", "f1_all", "f1_without_low_confidence"]
CALIBRATION_COLUMNS = ["annotator", "confidence", "anchor", "n_marks", "n_matched", "share_matched"]


def _labels(ds: AgreementDataset, cfg: AnalysisConfig) -> set[str]:
    return set(cfg.categories) if cfg.categories else set(ds.catalogue.label_names)


def setting_of(modes: set[str]) -> str:
    """The confidence setting of a set of files: the one they share, "mixed", or "not recorded"."""
    known = {m for m in modes if m}
    if not known:
        return NOT_RECORDED
    if len(known) == 1 and "" not in modes:
        return next(iter(known))
    return "mixed"


def dataset_setting(ds: AgreementDataset) -> str:
    return setting_of({d.confidence_mode for g in ds.groups.values() for d in g.docs.values()})


def confidence_given(ds: AgreementDataset, cfg: AnalysisConfig | None = None) -> bool:
    """True when at least one analysed annotation was rated."""
    labels = _labels(ds, cfg) if cfg is not None else None
    return any(a.confidence is not None for g in ds.groups.values() for d in g.docs.values() for a in d.annotations
               if labels is None or a.label in labels)


def without_low_confidence(ds: AgreementDataset) -> AgreementDataset:
    """The dataset without the annotations rated 1 or 2 (the rest, unrated ones included, kept as they are)."""
    groups = {}
    for rid, g in ds.groups.items():
        docs = {aid: dataclasses.replace(doc, annotations=[a for a in doc.annotations
                                                           if a.confidence not in LOW_CONFIDENCE])
                for aid, doc in g.docs.items()}
        groups[rid] = RecordingGroup(g.recording_id, g.timing, g.ch_names, docs, list(g.warnings))
    return AgreementDataset(groups=groups, catalogue=ds.catalogue, files=ds.files, warnings=list(ds.warnings))


def by_annotator(ds: AgreementDataset, cfg: AnalysisConfig) -> list[dict[str, Any]]:
    labels = _labels(ds, cfg)
    per: dict[str, dict[str, Any]] = {}
    for g in ds.groups.values():
        for aid, doc in g.docs.items():
            p = per.setdefault(aid, {"modes": set(), "recordings": 0, "anns": []})
            p["modes"].add(doc.confidence_mode)
            p["recordings"] += 1
            p["anns"].extend(a for a in doc.annotations if a.label in labels)
    rows = []
    for aid, p in sorted(per.items()):
        anns = p["anns"]
        ratings = [a.confidence for a in anns if a.confidence is not None]
        nan = float("nan")
        rows.append({
            "annotator": aid,
            "confidence_setting": setting_of(p["modes"]),
            "n_recordings": p["recordings"],
            "n_annotations": len(anns),
            "n_rated": len(ratings),
            "share_rated": len(ratings) / len(anns) if anns else nan,
            **{f"n_rated_{lv}": sum(1 for r in ratings if r == lv) for lv in CONFIDENCE_LEVELS},
            "n_not_rated": len(anns) - len(ratings),
            "median_confidence": float(statistics.median(ratings)) if ratings else nan,
            "n_with_note": sum(1 for a in anns if a.note),
        })
    return rows


def _pooled_exact(ds: AgreementDataset, cfg: AnalysisConfig) -> dict[tuple[str, str, str, str], dict[str, float]]:
    """Positive agreement and kappa sample by sample, all recordings pooled, by (category, mode, pair)."""
    out: dict[tuple[str, str, str, str], dict[str, float]] = {}
    ref = cfg.reference_annotator
    for mode in cfg.channel_modes:
        for cat in categories_for(ds, cfg):
            labels = category_label_set(cat, ds.catalogue, cfg)
            pooled: dict[tuple[str, str], PairTable] = {}
            for g in ds.groups.values():
                if len(g.docs) < 2:
                    continue
                tables, _hist, _w = recording_tables(g, cat, mode, "exact", cfg, labels)
                for (a, b), t in tables.items():
                    if ref and ref not in (a, b):
                        continue
                    key, tt = ((a, b), t) if not (ref and b == ref) else ((b, a), PairTable(t.a, t.c, t.b, t.d))
                    pooled[key] = pooled.get(key, PairTable(0, 0, 0, 0)) + tt
            for (a, b), t in pooled.items():
                s = pair_statistics(t)
                out[(cat, mode, a, b)] = {"positive_agreement": s.positive_agreement, "cohen_kappa": s.cohen_kappa}
    return out


def _f1(ds: AgreementDataset, cfg: AnalysisConfig) -> dict[tuple[str, str, str, str], dict[str, float]]:
    one = dataclasses.replace(cfg, iou_thresholds=(cfg.primary_iou_threshold,))
    rows = event_agreement(ds, one)["summary"]
    return {(r["category"], r["channel_mode"], r["reference"], r["compared"]):
            {"f1": r["f1"], "n_marks": r["n_reference"] + r["n_compared"]} for r in rows}


def sensitivity(ds: AgreementDataset, cfg: AnalysisConfig) -> list[dict[str, Any]]:
    """Agreement for all marks and without those rated 1 or 2 (empty when no mark was rated)."""
    if not confidence_given(ds, cfg):
        return []
    sub = without_low_confidence(ds)
    exact_all, exact_sub = _pooled_exact(ds, cfg), _pooled_exact(sub, cfg)
    f1_all, f1_sub = _f1(ds, cfg), _f1(sub, cfg)
    nan = float("nan")
    rows = []
    for key in sorted(set(exact_all) | set(f1_all), key=lambda k: (k[1], k[0], k[2], k[3])):
        cat, mode, a, b = key
        ea, es = exact_all.get(key, {}), exact_sub.get(key, {})
        fa, fs = f1_all.get(key, {}), f1_sub.get(key, {})
        if not fa.get("n_marks") and not ea:
            continue
        rows.append({
            "category": cat, "channel_mode": mode, "rater_1": a, "rater_2": b,
            "n_marks_all": fa.get("n_marks", 0), "n_marks_without_low_confidence": fs.get("n_marks", 0),
            "positive_agreement_all": ea.get("positive_agreement", nan),
            "positive_agreement_without_low_confidence": es.get("positive_agreement", nan),
            "cohen_kappa_all": ea.get("cohen_kappa", nan),
            "cohen_kappa_without_low_confidence": es.get("cohen_kappa", nan),
            "f1_all": fa.get("f1", nan), "f1_without_low_confidence": fs.get("f1", nan),
        })
    return rows


def calibration(ds: AgreementDataset, cfg: AnalysisConfig) -> list[dict[str, Any]]:
    """For each annotator and rating, the share of their marks that another annotator also found.

    A mark counts as found when, on the same recording, at least one other annotator has a mark of the
    same type that matches it (time only, the study's matching criterion at the main threshold,
    one-to-one within each pair). Empty when no mark was rated or no recording has two annotators."""
    if not confidence_given(ds, cfg):
        return []
    labels = _labels(ds, cfg)
    counts: dict[tuple[str, Any], list[int]] = {}
    for g in ds.groups.values():
        if len(g.docs) < 2:
            continue
        sf = g.timing.sfreq
        for label in sorted(labels):
            evs = {aid: events_for(doc, label, g.ch_names) for aid, doc in g.docs.items()}
            found: dict[str, set[str]] = {aid: set() for aid in evs}
            names = sorted(evs)
            for i, a in enumerate(names):
                for b in names[i + 1:]:
                    out = match_events(evs[a], evs[b], sfreq=sf, criterion=cfg.match_criterion,
                                       iou_threshold=cfg.primary_iou_threshold,
                                       onset_tolerance_s=cfg.onset_tolerance_s,
                                       offset_tolerance_s=cfg.offset_tolerance_s, require_channels=False,
                                       min_channel_jaccard=cfg.min_channel_jaccard,
                                       many_to_one=cfg.allow_many_to_one)
                    for x, y in out.pairs:
                        found[a].add(evs[a][x].annotation_id)
                        found[b].add(evs[b][y].annotation_id)
            for aid, events in evs.items():
                for e in events:
                    level = e.confidence if e.confidence is not None else NOT_RATED
                    for who in (aid, ALL_ANNOTATORS):
                        c = counts.setdefault((who, level), [0, 0])
                        c[0] += 1
                        c[1] += e.annotation_id in found[aid]
    order = {lv: i for i, lv in enumerate([*CONFIDENCE_LEVELS, NOT_RATED])}
    rows = []
    for (who, level), (n, m) in sorted(counts.items(), key=lambda kv: (kv[0][0] == ALL_ANNOTATORS, kv[0][0],
                                                                      order[kv[0][1]])):
        rows.append({"annotator": who, "confidence": level, "anchor": CONFIDENCE_ANCHORS.get(level, ""),
                     "n_marks": n, "n_matched": m, "share_matched": m / n if n else float("nan")})
    return rows


def confidence_measure(ds: AgreementDataset, cfg: AnalysisConfig) -> dict[str, list[dict[str, Any]]]:
    return {"by_annotator": by_annotator(ds, cfg), "sensitivity": sensitivity(ds, cfg),
            "calibration": calibration(ds, cfg)}


def explanation(ds: AgreementDataset, cfg: AnalysisConfig) -> str:
    """A plain statement of what the confidence tables mean for this data (for the report and the settings)."""
    setting = dataset_setting(ds)
    if not confidence_given(ds, cfg):
        return "No annotation in this analysis has a confidence rating, so agreement is reported once, for all marks."
    common = ("Confidence was rated on a 5-point scale, from 1 (not at all confident) to 5 (completely confident). "
              "Agreement is reported twice: for all marks, and again without the marks of low confidence, rated "
              "1 or 2 (a sensitivity analysis); unrated marks are kept in both. ")
    if setting == "every_mark":
        return common + ("In this study annotators were asked to rate each new mark, and no mark started with a "
                         "rating; marks left unrated are counted as not rated.")
    if setting == "optional":
        return common + ("In this study ratings were optional: annotators rated a mark only when they wished, so the "
                         "rated marks are a self-selected subset, and the confidence of an unrated mark is unknown.")
    return common + ("The files analysed come from different confidence settings (or older files that do not record "
                     "the setting), so whether ratings were volunteered or asked for differs between them.")
