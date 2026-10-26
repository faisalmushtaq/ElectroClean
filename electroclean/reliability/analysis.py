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

from electroclean import __version__
from electroclean.app.io.atomic import atomic_write_bytes, atomic_write_text
from electroclean.reliability.config import AnalysisConfig
from electroclean.reliability.data import AgreementDataset, load_dataset
from electroclean.reliability.intervals import total_length, union
from electroclean.reliability.matching import event_agreement
from electroclean.reliability.timeresolved import category_confusion, time_resolved_agreement

MeasureFunc = Callable[[AgreementDataset, AnalysisConfig], dict[str, list[dict[str, Any]]]]
MEASURES: dict[str, MeasureFunc] = {}


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


@dataclass
class AnalysisResult:
    config: AnalysisConfig
    dataset: AgreementDataset
    tables: dict[str, pd.DataFrame]
    settings_record: dict[str, Any] = field(default_factory=dict)

    def table(self, name: str) -> pd.DataFrame:
        return self.tables[name]


def run_analysis(
    source: AgreementDataset | Iterable[Path | str], config: AnalysisConfig | None = None
) -> AnalysisResult:
    cfg = config or AnalysisConfig()
    cfg.validate()
    ds = source if isinstance(source, AgreementDataset) else load_dataset(source, cfg)
    if cfg.reference_annotator and cfg.reference_annotator not in ds.annotators:
        ds.warnings.append(
            f"The reference annotator {cfg.reference_annotator} has no annotation files in this analysis, so there are "
            "no pairwise comparisons"
        )
    tables: dict[str, pd.DataFrame] = {}
    names = ["descriptives", "timeresolved", "events", "confusion", *cfg.extra_measures]
    for name in names:
        if name not in MEASURES:
            raise ValueError(f"Unknown measure {name!r}; registered: {sorted(MEASURES)}")
        for tname, rows in MEASURES[name](ds, cfg).items():
            tables[f"{name}_{tname}"] = pd.DataFrame(rows)
    record = {
        "generated_by": f"ElectroClean {__version__}",
        "python": platform.python_version(),
        "pandas": pd.__version__,
        "config": cfg.to_dict(),
        "label_catalogue": ds.catalogue.to_metadata(),
        "n_recordings": len(ds.groups),
        "annotators": ds.annotators,
        "input_files": ds.files,
        "warnings": ds.warnings + [w for g in ds.groups.values() for w in g.warnings],
    }
    return AnalysisResult(cfg, ds, tables, record)


def write_outputs(result: AnalysisResult, out_dir: Path | str, *, html: bool = True) -> dict[str, Path]:
    """Write every table as TSV, the settings as JSON and (optionally) the HTML report."""
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
    if html:
        from electroclean.reliability.report import build_html_report

        rp = out / "agreement_report.html"
        atomic_write_text(rp, build_html_report(result))
        paths["report"] = rp
    return paths
