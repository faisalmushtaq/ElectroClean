"""How sure annotators said they were, and agreement without the marks they doubted.

Each annotation may carry a confidence (``definite``, ``probable`` or ``possible``; see
``docs/design_decisions.md``). With the study setting ``annotation.confidence`` = ``"every_mark"``
every new mark starts as definite and the annotator changes it when unsure; with ``"optional"``
(the default) a confidence is given only when the annotator wishes, so the marks with one are a
self-selected subset.

Two tables are made:

``confidence_by_annotator``
    For each annotator, how many marks had a confidence given and how they were distributed over
    the three levels, and how many carry a note.
``confidence_sensitivity``
    The definite-confidence sensitivity analysis, made only when some confidence was given: the main agreement measures
    (positive agreement and Cohen's kappa sample by sample, all recordings pooled, and event F1 at
    the main threshold) for all marks and again without the marks given *probable* or *possible*.
    Marks without a confidence are kept in both, so in an optional study the second set is "all
    marks except those the annotator doubted"; in an every-mark study it is the definite marks.

Notes are research content: they are listed with each annotation in ``events_matched`` and
``events_unmatched`` and take part in none of the statistics.
"""

from __future__ import annotations

import dataclasses
from typing import Any

from electrotag.app.annotations.model import CONFIDENCE_LEVELS
from electrotag.reliability.config import AnalysisConfig
from electrotag.reliability.data import AgreementDataset, RecordingGroup
from electrotag.reliability.matching import event_agreement
from electrotag.reliability.statistics import PairTable, pair_statistics
from electrotag.reliability.timeresolved import categories_for, category_label_set, recording_tables

#: Confidences left out of the sensitivity analysis.
DOUBTFUL = ("probable", "possible")
NOT_RECORDED = "not recorded"

BY_ANNOTATOR_COLUMNS = ["annotator", "confidence_setting", "n_recordings", "n_annotations", "n_confidence_given",
                        "share_confidence_given", "n_definite", "n_probable", "n_possible", "n_not_given",
                        "share_definite", "share_probable", "share_possible", "n_with_note"]
SENSITIVITY_COLUMNS = ["category", "channel_mode", "rater_1", "rater_2", "n_marks_all", "n_marks_without_doubtful",
                       "positive_agreement_all", "positive_agreement_without_doubtful", "cohen_kappa_all",
                       "cohen_kappa_without_doubtful", "f1_all", "f1_without_doubtful"]


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
    """True when at least one analysed annotation has a confidence."""
    labels = _labels(ds, cfg) if cfg is not None else None
    return any(a.confidence for g in ds.groups.values() for d in g.docs.values() for a in d.annotations
               if labels is None or a.label in labels)


def without_doubtful(ds: AgreementDataset) -> AgreementDataset:
    """The dataset without the annotations given probable or possible (the rest kept as they are)."""
    groups = {}
    for rid, g in ds.groups.items():
        docs = {aid: dataclasses.replace(doc, annotations=[a for a in doc.annotations if a.confidence not in DOUBTFUL])
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
        counts = {lv: sum(1 for a in anns if a.confidence == lv) for lv in CONFIDENCE_LEVELS}
        given = sum(counts.values())
        nan = float("nan")
        rows.append({
            "annotator": aid,
            "confidence_setting": setting_of(p["modes"]),
            "n_recordings": p["recordings"],
            "n_annotations": len(anns),
            "n_confidence_given": given,
            "share_confidence_given": given / len(anns) if anns else nan,
            **{f"n_{lv}": counts[lv] for lv in CONFIDENCE_LEVELS},
            "n_not_given": len(anns) - given,
            **{f"share_{lv}": counts[lv] / given if given else nan for lv in CONFIDENCE_LEVELS},
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
    """Agreement for all marks and without those given probable or possible (empty when no confidence was given)."""
    if not confidence_given(ds, cfg):
        return []
    sub = without_doubtful(ds)
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
            "n_marks_all": fa.get("n_marks", 0), "n_marks_without_doubtful": fs.get("n_marks", 0),
            "positive_agreement_all": ea.get("positive_agreement", nan),
            "positive_agreement_without_doubtful": es.get("positive_agreement", nan),
            "cohen_kappa_all": ea.get("cohen_kappa", nan), "cohen_kappa_without_doubtful": es.get("cohen_kappa", nan),
            "f1_all": fa.get("f1", nan), "f1_without_doubtful": fs.get("f1", nan),
        })
    return rows


def confidence_measure(ds: AgreementDataset, cfg: AnalysisConfig) -> dict[str, list[dict[str, Any]]]:
    return {"by_annotator": by_annotator(ds, cfg), "sensitivity": sensitivity(ds, cfg)}


def explanation(ds: AgreementDataset, cfg: AnalysisConfig) -> str:
    """A plain statement of what the confidence tables mean for this data (for the report and the settings)."""
    setting = dataset_setting(ds)
    if not confidence_given(ds, cfg):
        return ("No annotation in this analysis has a confidence, so agreement is reported once, for all marks.")
    common = ("Agreement is reported twice: for all marks, and again as definite-confidence agreement, without the "
              "marks the annotators gave probable or possible (a sensitivity analysis). ")
    if setting == "every_mark":
        return common + ("In this study every new mark started as definite and annotators changed it when unsure, "
                         "so the second set is the marks left as definite. Some annotators may rarely change the "
                         "default; compare their distributions of confidence before reading much into the difference.")
    if setting == "optional":
        return common + ("In this study a confidence was optional: annotators gave one only when they wished, so the "
                         "marks with a confidence are a self-selected subset, and the confidence of a mark without one "
                         "is unknown. Marks without a confidence are kept in both sets.")
    return common + ("The files analysed come from different confidence settings (or older files that do not record "
                     "the setting), so whether a confidence was volunteered or asked for every mark differs between "
                     "them; marks without a confidence are kept in both sets.")
