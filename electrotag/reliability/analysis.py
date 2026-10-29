"""Running an agreement analysis and writing its outputs.

Measures are registered in :data:`MEASURES`. Each takes the loaded
:class:`AgreementDataset` and the :class:`AnalysisConfig` and returns named
tables (lists of row dictionaries). New measures, for example Krippendorff's
unitizing alpha or the gamma method, can be added with :func:`register_measure`
without changing anything else; their tables are written and included in the
report automatically.
"""

from __future__ import annotations

import json
import platform
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd

from electrotag import __version__
from electrotag.app.io.atomic import atomic_write_bytes, atomic_write_text
from electrotag.hints import unknown_names
from electrotag.reliability.confidence import (
    BY_ANNOTATOR_COLUMNS,
    CALIBRATION_COLUMNS,
    SENSITIVITY_COLUMNS,
    confidence_measure,
    dataset_setting,
)
from electrotag.reliability.confidence import explanation as confidence_explanation
from electrotag.reliability.config import AnalysisConfig
from electrotag.reliability.data import AgreementDataset, load_dataset
from electrotag.reliability.intervals import total_length, union
from electrotag.reliability.matching import event_agreement
from electrotag.reliability.timeresolved import category_confusion, time_resolved_agreement

MeasureFunc = Callable[[AgreementDataset, AnalysisConfig], dict[str, list[dict[str, Any]]]]
MEASURES: dict[str, MeasureFunc] = {}
ProgressFunc = Callable[[str], None]
CancelFunc = Callable[[], bool]

#: Columns of the built-in tables, so that a table without rows is still written with its header row.
TABLE_COLUMNS: dict[str, list[str]] = {
    "descriptives_recordings": ["recording", "duration_s", "sfreq", "n_channels", "n_annotators", "annotators",
                                "warnings"],
    "descriptives_annotations_by_annotator": ["recording", "annotator", "category", "n_annotations",
                                              "total_duration_s", "n_whole_montage", "n_channel_specific",
                                              "proportion_of_recording"],
    "timeresolved_pairwise": ["recording", "category", "channel_mode", "representation", "unit", "rater_1", "rater_2",
                              "n", "both", "only_1", "only_2", "neither", "prevalence_1", "prevalence_2",
                              "proportion_agreement", "positive_agreement", "negative_agreement", "cohen_kappa",
                              "prevalence_index", "bias_index", "pabak", "note", "n_recordings"],
    "timeresolved_multirater": ["recording", "category", "channel_mode", "representation", "unit", "raters",
                                "raters_per_unit", "n_units", "fleiss_kappa", "fleiss_note", "krippendorff_alpha",
                                "alpha_note", "mean_pairwise_kappa"],
    "events_summary": ["category", "channel_mode", "criterion", "threshold", "onset_tolerance_s", "offset_tolerance_s",
                       "matching", "reference", "compared", "n_reference", "n_compared", "matched_reference",
                       "matched_compared", "missed", "extra", "precision", "recall", "f1", "mean_iou",
                       "mean_channel_jaccard", "onset_diff_mean_s", "onset_diff_sd_s", "onset_diff_median_s",
                       "onset_diff_mean_abs_s", "onset_diff_loa_low_s", "onset_diff_loa_high_s", "offset_diff_mean_s",
                       "offset_diff_sd_s", "offset_diff_median_s", "offset_diff_mean_abs_s", "offset_diff_loa_low_s",
                       "offset_diff_loa_high_s", "duration_diff_mean_s", "duration_diff_sd_s",
                       "duration_diff_median_s", "duration_diff_mean_abs_s", "duration_diff_loa_low_s",
                       "duration_diff_loa_high_s"],
    "events_matched": ["recording", "category", "channel_mode", "threshold", "criterion", "reference", "compared",
                       "reference_id", "compared_id", "reference_label", "compared_label", "reference_onset_s",
                       "reference_offset_s", "compared_onset_s", "compared_offset_s", "iou", "onset_diff_s",
                       "offset_diff_s", "duration_diff_s", "channel_jaccard", "reference_channels",
                       "compared_channels", "reference_confidence", "compared_confidence", "reference_note",
                       "compared_note"],
    "events_unmatched": ["recording", "category", "channel_mode", "threshold", "criterion", "reference", "compared",
                         "side", "kind", "annotator", "annotation_id", "label", "onset_s", "offset_s", "channels",
                         "confidence", "note"],
    "confusion_time_weighted": ["rater_1", "rater_2", "label_rater_1", "label_rater_2", "seconds"],
    "confidence_by_annotator": BY_ANNOTATOR_COLUMNS,
    "confidence_sensitivity": SENSITIVITY_COLUMNS,
    "confidence_calibration": CALIBRATION_COLUMNS,
}

RESULT_FILES = ("analysis_settings.json", "agreement_report.html")


class AnalysisCancelled(RuntimeError):
    """The analysis was stopped by the user before its results were written."""


def register_measure(name: str, func: MeasureFunc) -> None:
    """Add an analysis; its tables are named ``<name>_<table>``."""
    MEASURES[name] = func


def descriptives(dataset: AgreementDataset, config: AnalysisConfig) -> dict[str, list[dict[str, Any]]]:
    rows = []
    rec_rows = []
    labels = list(config.categories) if config.categories else list(dataset.catalogue.label_names)
    for rid, g in sorted(dataset.groups.items()):
        rec_rows.append({
            "recording": rid,
            "duration_s": g.timing.duration_s,
            "sfreq": g.timing.sfreq,
            "n_channels": len(g.ch_names),
            "n_annotators": len(g.docs),
            "annotators": ", ".join(g.annotators),
            "warnings": "; ".join(g.warnings),
        })
        for aid, doc in sorted(g.docs.items()):
            for lab in labels:
                anns = [a for a in doc.annotations if a.label == lab]
                if not anns:
                    continue
                rows.append({
                    "recording": rid,
                    "annotator": aid,
                    "category": lab,
                    "n_annotations": len(anns),
                    "total_duration_s": sum(a.duration(g.timing) for a in anns),
                    "n_whole_montage": sum(a.is_global for a in anns),
                    "n_channel_specific": sum(not a.is_global for a in anns),
                    # Overlapping annotations of one category are counted once here.
                    "proportion_of_recording": total_length(union((a.onset_sample, a.end_sample) for a in anns))
                    / g.timing.n_samples,
                })
    return {"recordings": rec_rows, "annotations_by_annotator": rows}


def _time_resolved(ds: AgreementDataset, cfg: AnalysisConfig) -> dict[str, list[dict[str, Any]]]:
    return time_resolved_agreement(ds, cfg)


def _events(ds: AgreementDataset, cfg: AnalysisConfig) -> dict[str, list[dict[str, Any]]]:
    return event_agreement(ds, cfg)


def _confusion(ds: AgreementDataset, cfg: AnalysisConfig) -> dict[str, list[dict[str, Any]]]:
    return {"time_weighted": category_confusion(ds, cfg)}


register_measure("descriptives", descriptives)
register_measure("timeresolved", _time_resolved)
register_measure("events", _events)
register_measure("confusion", _confusion)
register_measure("confidence", confidence_measure)


@dataclass
class AnalysisResult:
    config: AnalysisConfig
    dataset: AgreementDataset
    tables: dict[str, pd.DataFrame]
    settings_record: dict[str, Any] = field(default_factory=dict)

    def table(self, name: str) -> pd.DataFrame:
        return self.tables[name]

    @property
    def has_comparisons(self) -> bool:
        """True when at least one recording was annotated by two annotators who are compared."""
        return bool(self.settings_record.get("n_comparable_recordings"))


def comparable_recordings(ds: AgreementDataset, cfg: AnalysisConfig) -> list[str]:
    """Recordings that contribute to the agreement measures (two or more annotators to compare)."""
    out = []
    for rid, g in ds.groups.items():
        if len(g.docs) < 2:
            continue
        if cfg.reference_annotator and cfg.reference_annotator not in g.docs:
            continue
        out.append(rid)
    return sorted(out)


def comparison_warnings(ds: AgreementDataset, cfg: AnalysisConfig) -> list[str]:
    """Plain statements of what cannot be compared, shown first in every output."""
    comparable = comparable_recordings(ds, cfg)
    n = len(ds.groups)
    if not comparable:
        if cfg.reference_annotator:
            return [
                f"No recording was annotated by both the reference annotator {cfg.reference_annotator} and another "
                "selected annotator, so there is nothing to compare: the agreement tables are empty and only the "
                "descriptive tables are filled."
            ]
        return [
            "No recording was annotated by at least two of the selected annotators, so there is nothing to compare: "
            "the agreement tables are empty and only the descriptive tables are filled."
        ]
    if len(comparable) < n:
        return [
            f"{n - len(comparable)} of {n} recordings were annotated by only one of the annotators being compared "
            "and add nothing to the agreement measures."
        ]
    return []


def selection_problems(ds: AgreementDataset, cfg: AnalysisConfig) -> list[str]:
    """Categories and reference annotator that do not exist in the data (strict mode)."""
    problems = []
    if cfg.categories:
        msg = unknown_names("category", cfg.categories, ds.catalogue.label_names)
        if msg:
            problems.append(msg)
    if cfg.reference_annotator and cfg.reference_annotator not in ds.annotators:
        msg = unknown_names("reference annotator", [cfg.reference_annotator], ds.annotators)
        if msg:
            problems.append(msg)
    return problems


def run_analysis(
    source: AgreementDataset | Iterable[Path | str],
    config: AnalysisConfig | None = None,
    *,
    strict: bool = False,
    progress: ProgressFunc | None = None,
    cancel: CancelFunc | None = None,
) -> AnalysisResult:
    """Run every registered measure.

    With ``strict`` (used by the command line), categories,
    annotators or a reference annotator that do not occur in the data are an
    error with a suggestion, rather than an empty result. ``progress`` receives
    a short description of each step; when ``cancel`` returns True the
    analysis stops at the next step with :class:`AnalysisCancelled`.
    """

    def step(text: str) -> None:
        if cancel is not None and cancel():
            raise AnalysisCancelled("The analysis was cancelled; no results were written.")
        if progress is not None:
            progress(text)

    cfg = config or AnalysisConfig()
    cfg.validate()
    step("Reading the annotation files")
    ds = source if isinstance(source, AgreementDataset) else load_dataset(source, cfg, strict=strict)
    if strict:
        problems = selection_problems(ds, cfg)
        if problems:
            raise ValueError(" ".join(problems))
    if cfg.reference_annotator and cfg.reference_annotator not in ds.annotators:
        ds.warnings.append(
            f"The reference annotator {cfg.reference_annotator} has no annotation files in this analysis, so there are "
            "no pairwise comparisons"
        )
    titles = {"descriptives": "Counting the annotations", "timeresolved": "Time-resolved agreement",
              "events": "Matching events", "confusion": "Category disagreements",
              "confidence": "Confidence of the annotations"}
    tables: dict[str, pd.DataFrame] = {}
    names = ["descriptives", "timeresolved", "events", "confusion", "confidence", *cfg.extra_measures]
    for name in names:
        if name not in MEASURES:
            raise ValueError(f"Unknown measure {name!r}; registered: {sorted(MEASURES)}")
        step(titles.get(name, f"Measure {name}"))
        for tname, rows in MEASURES[name](ds, cfg).items():
            key = f"{name}_{tname}"
            tables[key] = pd.DataFrame(rows) if rows else pd.DataFrame(columns=TABLE_COLUMNS.get(key))
    first = comparison_warnings(ds, cfg)
    record = {
        "generated_by": f"ElectroTag {__version__}",
        "python": platform.python_version(),
        "pandas": pd.__version__,
        "config": cfg.to_dict(),
        "label_catalogue": ds.catalogue.to_metadata(),
        "n_recordings": len(ds.groups),
        "n_comparable_recordings": len(comparable_recordings(ds, cfg)),
        "annotators": ds.annotators,
        "input_files": ds.files,
        "confidence": {"setting": dataset_setting(ds), "explanation": confidence_explanation(ds, cfg)},
        "warnings": first + ds.warnings + [w for g in ds.groups.values() for w in g.warnings],
    }
    return AnalysisResult(cfg, ds, tables, record)


def has_earlier_results(out_dir: Path | str) -> bool:
    """True when the folder already holds the results of an analysis (they would be replaced)."""
    out = Path(out_dir)
    return any((out / name).exists() for name in RESULT_FILES)


def write_outputs(
    result: AnalysisResult,
    out_dir: Path | str,
    *,
    html: bool = True,
    progress: ProgressFunc | None = None,
    cancel: CancelFunc | None = None,
) -> dict[str, Path]:
    """Write every table as TSV, the settings as JSON and (optionally) the HTML report.

    The report is drawn before anything is written, so cancelling (``cancel``
    returning True) during the drawing leaves the folder untouched.
    """

    def step(text: str) -> None:
        if cancel is not None and cancel():
            raise AnalysisCancelled("The analysis was cancelled; no results were written.")
        if progress is not None:
            progress(text)

    report_html = None
    if html:
        from electrotag.reliability.report import build_html_report

        step("Drawing the report")
        report_html = build_html_report(result)
    step("Writing the results")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {}
    for name, df in result.tables.items():
        p = out / f"{name}.tsv"
        atomic_write_text(p, df.to_csv(sep="\t", index=False, na_rep="n/a", float_format="%.6g"))
        paths[name] = p
    sp = out / "analysis_settings.json"
    atomic_write_bytes(sp, (json.dumps(result.settings_record, indent=2, default=str) + "\n").encode("utf-8"))
    paths["settings"] = sp
    if report_html is not None:
        rp = out / "agreement_report.html"
        atomic_write_text(rp, report_html)
        paths["report"] = rp
    return paths
