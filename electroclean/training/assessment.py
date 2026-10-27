"""Competency assessment against reference annotations.

The comparison uses exactly the same machinery as the inter-rater analysis
(Component B), with the reference as the fixed comparator. Competency criteria
are set by the administrator per reference set; ElectroClean ships with none,
because suitable thresholds depend on pilot data, expert agreement and how the
labels will be used.
"""

from __future__ import annotations

import hashlib
import html
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd

from electroclean import __version__
from electroclean.app.annotations.model import AnnotationDocument
from electroclean.app.common import now_local_iso
from electroclean.app.io.atomic import atomic_write_json, atomic_write_text, sha256_file
from electroclean.app.io.canonical import read_annotations_json
from electroclean.app.io.naming import OutputLayout
from electroclean.reliability.analysis import run_analysis
from electroclean.reliability.config import ANY_ARTIFACT, AnalysisConfig
from electroclean.reliability.data import build_dataset
from electroclean.training.reference import REFERENCE_ANNOTATOR, ReferenceSet

MICRO = "ALL categories (micro-average)"

METRICS: dict[str, dict[str, str]] = {
    "event_f1": {"label": "Event F1 (time only)", "better": "higher"},
    "event_recall": {"label": "Sensitivity: proportion of reference events found", "better": "higher"},
    "event_precision": {"label": "Precision: proportion of your events that match the reference", "better": "higher"},
    "time_kappa": {"label": "Cohen's kappa over time (exact)", "better": "higher"},
    "time_positive_agreement": {"label": "Positive agreement over time (exact)", "better": "higher"},
    "channel_positive_agreement": {"label": "Positive agreement over time and channels", "better": "higher"},
    "mean_iou": {"label": "Mean temporal overlap (IoU) of matched events", "better": "higher"},
    "mean_channel_jaccard": {"label": "Mean channel overlap (Jaccard) of matched events", "better": "higher"},
    "label_accuracy": {"label": "Same label as the reference for detected artifacts", "better": "higher"},
    "false_positives_per_min": {"label": "Extra events (matching no reference artifact) per minute", "better": "lower"},
}


@dataclass
class Criterion:
    metric: str
    threshold: float
    scope: str = "overall"  # or "each_category"

    def passes(self, value: float) -> bool | None:
        if value is None or (isinstance(value, float) and math.isnan(value)):
            return None
        if METRICS[self.metric]["better"] == "lower":
            return value <= self.threshold + 1e-12
        return value >= self.threshold - 1e-12

    def describe(self) -> str:
        op = "≤" if METRICS[self.metric]["better"] == "lower" else "≥"
        where = "overall" if self.scope == "overall" else "in every assessed category"
        return f"{METRICS[self.metric]['label']} {op} {self.threshold:g} ({where})"


@dataclass
class CompetencyCriteria:
    criteria: list[Criterion] = field(default_factory=list)
    min_reference_events: int = 3
    categories: list[str] | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> CompetencyCriteria:
        d = d or {}
        crits = []
        for c in d.get("criteria", []):
            if c["metric"] not in METRICS:
                raise ValueError(f"Unknown metric {c['metric']!r}; choose from {sorted(METRICS)}")
            scope = c.get("scope", "overall")
            if scope not in ("overall", "each_category"):
                raise ValueError("scope must be 'overall' or 'each_category'")
            if scope == "each_category" and c["metric"] in ("label_accuracy", "false_positives_per_min"):
                raise ValueError(f"{c['metric']} is only available overall")
            crits.append(Criterion(c["metric"], float(c["threshold"]), scope))
        return cls(crits, int(d.get("min_reference_events", 3)), d.get("categories"))

    def to_dict(self) -> dict[str, Any]:
        return {
            "criteria": [{"metric": c.metric, "threshold": c.threshold, "scope": c.scope} for c in self.criteria],
            "min_reference_events": self.min_reference_events,
            "categories": self.categories,
        }


def _analysis_config(rs: ReferenceSet | None) -> AnalysisConfig:
    base = AnalysisConfig(resolutions_s=(0.1,), modes=("reference", "practice", "assessment", "standard"))
    data = base.to_dict()
    if rs is not None and rs.analysis:
        data.update(rs.analysis)
    data["reference_annotator"] = REFERENCE_ANNOTATOR
    data["modes"] = ["reference", "practice", "assessment", "standard"]
    # The competency measures need the ANY-artifact rows and both channel modes.
    data["include_any_artifact"] = True
    data["channel_modes"] = ["time_only", "time_and_channel"]
    return AnalysisConfig.from_dict(data)


def compare_with_reference(
    annotator_docs: list[AnnotationDocument], reference_docs: list[AnnotationDocument], config: AnalysisConfig
) -> dict[str, Any]:
    """Overall and per-category metrics of one annotator against the reference."""
    docs = [(f"ref:{d.recording.recording_id}", d) for d in reference_docs]
    docs += [(f"ann:{d.recording.recording_id}", d) for d in annotator_docs]
    dataset = build_dataset(docs, config)
    result = run_analysis(dataset, config)
    # A reference recording without a comparable annotation (missing, or excluded because
    # its timing differs) would silently drop the reference events from every measure.
    not_compared = sorted(
        d.recording.recording_id for d in reference_docs
        if len(getattr(dataset.groups.get(d.recording.recording_id), "docs", {})) < 2
    )
    compared_refs = [d for d in reference_docs if d.recording.recording_id not in not_compared]
    data_warnings = list(dataset.warnings) + [w for g in dataset.groups.values() for w in g.warnings]
    ev = result.table("events_summary")
    tr = result.table("timeresolved_pairwise")
    matched = result.table("events_matched")
    unmatched = result.table("events_unmatched")
    thr = config.primary_iou_threshold

    def ev_rows(mode: str) -> pd.DataFrame:
        if ev.empty:
            return ev
        sel = ev[ev.channel_mode == mode]
        if config.match_criterion != "tolerance":
            sel = sel[sel.threshold == thr]
        return sel

    def tr_rows(mode: str) -> pd.DataFrame:
        if tr.empty:
            return tr
        return tr[(tr.recording == "ALL (pooled)") & (tr.representation == "exact") & (tr.channel_mode == mode)]

    e_t, e_c = ev_rows("time_only"), ev_rows("time_and_channel")
    t_t, t_c = tr_rows("time_only"), tr_rows("time_and_channel")
    minutes = sum(d.recording.timing.duration_s for d in compared_refs) / 60.0

    def get(df: pd.DataFrame, cat: str, col: str) -> float:
        if df.empty:
            return float("nan")
        r = df[df.category == cat]
        return float(r.iloc[0][col]) if len(r) else float("nan")

    m_any = matched[(matched.category == ANY_ARTIFACT) & (matched.channel_mode == "time_only")] if not matched.empty else matched
    if not m_any.empty and config.match_criterion != "tolerance":
        m_any = m_any[m_any.threshold == thr]
    label_acc = float((m_any.reference_label == m_any.compared_label).mean()) if len(m_any) else float("nan")
    overall = {
        "event_f1": get(e_t, MICRO, "f1"),
        "event_recall": get(e_t, MICRO, "recall"),
        "event_precision": get(e_t, MICRO, "precision"),
        "time_kappa": get(t_t, ANY_ARTIFACT, "cohen_kappa"),
        "time_positive_agreement": get(t_t, ANY_ARTIFACT, "positive_agreement"),
        "channel_positive_agreement": get(t_c, ANY_ARTIFACT, "positive_agreement"),
        "mean_iou": get(e_t, MICRO, "mean_iou"),
        "mean_channel_jaccard": get(e_t, MICRO, "mean_channel_jaccard"),
        "label_accuracy": label_acc,
        # Events that match no reference artifact of any category (a relabelled artifact is not counted).
        "false_positives_per_min": (get(e_t, ANY_ARTIFACT, "extra") / minutes) if minutes > 0 else float("nan"),
    }
    per_cat = []
    labels = dataset.catalogue.label_names if reference_docs else ()
    for lab in labels:
        n_ref = int(get(e_t, lab, "n_reference")) if not math.isnan(get(e_t, lab, "n_reference")) else 0
        n_you = int(get(e_t, lab, "n_compared")) if not math.isnan(get(e_t, lab, "n_compared")) else 0
        if n_ref == 0 and n_you == 0:
            continue
        per_cat.append({
            "category": lab,
            "reference_events": n_ref,
            "your_events": n_you,
            "found": int(get(e_t, lab, "matched_reference")) if n_ref else 0,
            "event_f1": get(e_t, lab, "f1"),
            "event_recall": get(e_t, lab, "recall"),
            "event_precision": get(e_t, lab, "precision"),
            "time_kappa": get(t_t, lab, "cohen_kappa"),
            "time_positive_agreement": get(t_t, lab, "positive_agreement"),
            "channel_positive_agreement": get(t_c, lab, "positive_agreement"),
            "mean_iou": get(e_t, lab, "mean_iou"),
            "mean_channel_jaccard": get(e_t, lab, "mean_channel_jaccard"),
            "onset_diff_mean_s": get(e_t, lab, "onset_diff_mean_s"),
            "offset_diff_mean_s": get(e_t, lab, "offset_diff_mean_s"),
        })
    # Missed, extra and relabelled artifacts come from the ANY-artifact matching, so that each
    # disagreement is listed once: an artifact found with another label is a label difference.
    missed = []
    extra = []
    if not unmatched.empty:
        u = unmatched[(unmatched.channel_mode == "time_only") & (unmatched.category == ANY_ARTIFACT)]
        if config.match_criterion != "tolerance":
            u = u[u.threshold == thr]
        for _, r in u.sort_values(["recording", "onset_s"]).iterrows():
            item = {"recording": r.recording, "label": r.label, "onset_s": float(r.onset_s), "offset_s": float(r.offset_s),
                    "channels": r.channels}
            (missed if r.side == "reference" else extra).append(item)
    confusions = []
    if len(m_any):
        for _, r in m_any[m_any.reference_label != m_any.compared_label].iterrows():
            confusions.append({"recording": r.recording, "reference_label": r.reference_label, "your_label": r.compared_label,
                               "onset_s": float(r.reference_onset_s), "offset_s": float(r.reference_offset_s)})
    return {
        "overall": overall,
        "per_category": per_cat,
        "missed": missed,
        "extra": extra,
        "label_differences": confusions,
        "minutes_assessed": minutes,
        "recordings_not_compared": not_compared,
        "warnings": data_warnings,
        "analysis_config": config.to_dict(),
    }


def evaluate_criteria(metrics: dict[str, Any], criteria: CompetencyCriteria) -> dict[str, Any]:
    checks = []
    judged = [
        c for c in metrics["per_category"]
        if c["reference_events"] >= criteria.min_reference_events
        and (criteria.categories is None or c["category"] in criteria.categories)
    ]
    for crit in criteria.criteria:
        if crit.scope == "overall":
            v = metrics["overall"].get(crit.metric, float("nan"))
            checks.append({"criterion": crit.describe(), "where": "overall", "value": v, "passed": crit.passes(v)})
        elif judged:
            for c in judged:
                v = c.get(crit.metric, float("nan"))
                checks.append({"criterion": crit.describe(), "where": c["category"], "value": v, "passed": crit.passes(v)})
        else:
            # A per-category criterion with no category to judge must not count as passed.
            checks.append({
                "criterion": crit.describe(),
                "where": f"no category has at least {criteria.min_reference_events} reference events",
                "value": float("nan"), "passed": None,
            })
    not_compared = metrics.get("recordings_not_compared") or []
    if not criteria.criteria:
        status = "not_determined"
        text = "Not determined: the administrator has not set competency criteria for this reference set."
    elif not_compared:
        status = "not_determined"
        text = (f"Not determined: {len(not_compared)} assessment recording(s) could not be compared with the reference "
                "(see the warnings below).")
    elif any(ch["passed"] is False for ch in checks):
        status = "not_met"
        text = "Does not yet meet the competency criteria."
    elif any(ch["passed"] is None for ch in checks):
        status = "not_determined"
        text = ("Not determined: some criteria could not be evaluated because the measure is undefined for these "
                "annotations (for example, mean overlap when no events were matched, or a per-category criterion "
                "when no category has enough reference events).")
    else:
        status = "met"
        text = "Meets the competency criteria."
    not_judged = [c["category"] for c in metrics["per_category"] if c not in judged]
    return {"status": status, "status_text": text, "checks": checks, "categories_not_judged": not_judged}


# --------------------------------------------------------------- practice
def practice_feedback(annotator_doc: AnnotationDocument, reference_doc: AnnotationDocument,
                      rs: ReferenceSet | None = None) -> dict[str, Any]:
    cfg = _analysis_config(rs)
    m = compare_with_reference([annotator_doc], [reference_doc], cfg)
    m["recording_id"] = reference_doc.recording.recording_id
    return m


def feedback_html(fb: dict[str, Any]) -> str:
    o = fb["overall"]
    n_ref = sum(c["reference_events"] for c in fb["per_category"])
    n_found = sum(c["found"] for c in fb["per_category"])

    def pct(v: float) -> str:
        return "n/a" if v is None or (isinstance(v, float) and math.isnan(v)) else f"{100 * v:.0f}%"

    def f1_text(v: float) -> str:
        return "n/a" if math.isnan(v) else f"{v:.2f}"

    parts = [f"<h2>Feedback: {html.escape(fb.get('recording_id', ''))}</h2>"]
    parts.append(
        f"<p>You found <b>{n_found} of {n_ref}</b> reference artifacts "
        f"(F1 {f1_text(o['event_f1'])}; precision {pct(o['event_precision'])}; sensitivity {pct(o['event_recall'])}). "
        f"Matched artifacts overlapped the reference by {pct(o['mean_iou'])} on average and had the same label "
        f"{pct(o['label_accuracy'])} of the time. Channel selection overlap: {pct(o['mean_channel_jaccard'])}.</p>"
        if n_ref else "<p>The reference contains no artifacts for this recording.</p>"
    )
    rows = "".join(
        f"<tr><td>{html.escape(c['category'])}</td><td>{c['reference_events']}</td><td>{c['your_events']}</td>"
        f"<td>{c['found']}</td><td>{f1_text(c['event_f1'])}</td></tr>"
        for c in fb["per_category"]
    )
    parts.append("<table border='1' cellspacing='0' cellpadding='4'><tr><th>Category</th><th>Reference</th><th>You</th>"
                 f"<th>Found</th><th>F1</th></tr>{rows}</table>")
    for title, key, fmt in (
        ("Artifacts you missed", "missed", lambda x: f"{x['label']} at {x['onset_s']:.2f}–{x['offset_s']:.2f} s ({x['channels']})"),
        ("Extra annotations (not in the reference)", "extra", lambda x: f"{x['label']} at {x['onset_s']:.2f}–{x['offset_s']:.2f} s"),
        ("Different label from the reference", "label_differences",
         lambda x: f"{x['onset_s']:.2f}–{x['offset_s']:.2f} s: you chose {x['your_label']}, reference {x['reference_label']}"),
    ):
        items = fb.get(key, [])
        if items:
            parts.append(f"<h3>{title} ({len(items)})</h3><ul>" + "".join(f"<li>{html.escape(fmt(x))}</li>" for x in items[:50]) + "</ul>")
    return "\n".join(parts)


# ------------------------------------------------------------- competency
def find_assessment_documents(layout: OutputLayout, rs: ReferenceSet, annotator_id: str) -> dict[str, tuple[Path, AnnotationDocument]]:
    base = layout.annotator_dir(annotator_id, "assessment", rs.set_id)
    out: dict[str, tuple[Path, AnnotationDocument]] = {}
    if not base.exists():
        return out
    for p in sorted(base.rglob("*_annotations.json")):
        try:
            d = read_annotations_json(p)
        except Exception:
            continue
        if d.recording.recording_id in rs.assessment_recordings and d.annotator_id == annotator_id:
            prev = out.get(d.recording.recording_id)
            if prev is None or (d.created_at, str(p)) > (prev[1].created_at, str(prev[0])):
                out[d.recording.recording_id] = (p, d)
    return out


def competency_report(layout: OutputLayout, rs: ReferenceSet, annotator_id: str, *, write: bool = True) -> dict[str, Any]:
    """Evaluate an annotator's assessment recordings; optionally write JSON and HTML reports.

    The result is reproducible: it records the checksums of every input and a
    digest of the results, which is identical when the report is regenerated
    from the same files.
    """
    docs = find_assessment_documents(layout, rs, annotator_id)
    required = rs.assessment_recordings
    missing = [r for r in required if r not in docs]
    criteria = CompetencyCriteria.from_dict(rs.criteria)
    def rel(p: Path) -> str:
        try:
            return p.resolve().relative_to(layout.root.resolve()).as_posix()
        except ValueError:
            return p.name

    inputs = {
        "reference_set": {"file": f"{rs.set_id}/{rs.path.name}", "sha256": sha256_file(rs.path)},
        "references": {r: rs.recordings[r].get("sha256") for r in sorted(required)},
        "annotations": {r: {"file": rel(p), "sha256": sha256_file(p)} for r, (p, _d) in sorted(docs.items())},
    }
    report: dict[str, Any] = {
        "schema": "electroclean.competency_report",
        "schema_version": "1.0.0",
        "annotator_id": annotator_id,
        "reference_set": {"set_id": rs.set_id, "name": rs.name, "provenance": rs.provenance},
        "required_recordings": required,
        "missing_recordings": missing,
        "criteria": criteria.to_dict(),
        "inputs": inputs,
        "software": {"electroclean": __version__},
    }
    if not required:
        report.update(status="not_determined", status_text="This reference set has no assessment recordings.")
    elif missing:
        report.update(status="incomplete", status_text=f"Incomplete: {len(missing)} of {len(required)} assessment recordings not yet completed.")
    else:
        cfg = _analysis_config(rs)
        refs = [rs.reference_document(r) for r in required]
        mine = [docs[r][1] for r in required]
        metrics = compare_with_reference(mine, refs, cfg)
        evaluation = evaluate_criteria(metrics, criteria)
        report.update(metrics=metrics, **evaluation)
    report = _clean(report)
    report["results_sha256"] = results_digest(report)
    report["generated_at"] = now_local_iso()
    if write:
        out_dir = layout.root / "training" / rs.set_id / "reports"
        base = out_dir / f"annotator-{annotator_id}_competency_report"
        atomic_write_json(base.with_suffix(".json"), report)
        atomic_write_text(base.with_suffix(".html"), competency_html(report))
        report["paths"] = {"json": str(base.with_suffix(".json")), "html": str(base.with_suffix(".html"))}
    return report


DIGEST_EXCLUDED = ("generated_at", "results_sha256", "paths")


def results_digest(report: dict[str, Any]) -> str:
    """SHA-256 of a competency report's results, as written in its JSON file.

    It covers everything except the generation time, the digest itself, the
    output paths and the checksum of ``reference_set.json`` (that file also
    changes when annotators are assigned or quiz items added; the reference
    annotations, criteria and analysis settings are covered separately).
    Recompute it from a saved report with ``verify_competency_report``.
    """
    src = {k: v for k, v in report.items() if k not in DIGEST_EXCLUDED}
    inputs = dict(src.get("inputs") or {})
    if "reference_set" in inputs:
        inputs["reference_set"] = {k: v for k, v in inputs["reference_set"].items() if k != "sha256"}
    src["inputs"] = inputs
    text = json.dumps(_clean(src), sort_keys=True, ensure_ascii=False, allow_nan=False, default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def verify_competency_report(path: Path | str) -> bool:
    """True when a saved competency report's ``results_sha256`` matches its contents."""
    report = json.loads(Path(path).read_text(encoding="utf-8"))
    return report.get("results_sha256") == results_digest(report)


def _clean(obj: Any) -> Any:
    if isinstance(obj, float) and math.isnan(obj):
        return None
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean(v) for v in obj]
    return obj


def competency_html(report: dict[str, Any]) -> str:
    def f(v: Any) -> str:
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return "n/a"
        return f"{v:.3f}" if isinstance(v, float) else html.escape(str(v))

    colour = {"met": "#1B5E20", "not_met": "#B71C1C", "incomplete": "#E65100"}.get(report["status"], "#37474F")
    p = ["<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'><title>Competency report</title>",
         "<style>body{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;max-width:1000px;margin:2em auto;"
         "padding:0 1em;color:#0b0b0b;background:#fcfcfb} table{border-collapse:collapse;font-size:13px} "
         "td,th{border-top:1px solid #e4e3df;padding:4px 8px;text-align:left} th{background:#f1f0ec}"
         ".muted{color:#52514e}</style></head><body>"]
    rs = report["reference_set"]
    p.append(f"<h1>Competency report: annotator {html.escape(report['annotator_id'])}</h1>")
    p.append(f"<p class='muted'>Reference set {html.escape(rs['set_id'])} – {html.escape(rs.get('name') or '')} · "
             f"generated {html.escape(report.get('generated_at', ''))} · ElectroClean {html.escape(report['software']['electroclean'])}</p>")
    p.append(f"<h2 style='color:{colour}'>{html.escape(report['status_text'])}</h2>")
    m0 = report.get("metrics") or {}
    if m0.get("recordings_not_compared"):
        p.append("<p>Recordings that could not be compared with the reference:</p><ul>"
                 + "".join(f"<li>{html.escape(r)}</li>" for r in m0["recordings_not_compared"]) + "</ul>")
    if m0.get("warnings"):
        p.append("<h3>Warnings</h3><ul>" + "".join(f"<li>{html.escape(w)}</li>" for w in m0["warnings"]) + "</ul>")
    if report.get("missing_recordings"):
        p.append("<p>Recordings still to complete:</p><ul>" + "".join(f"<li>{html.escape(r)}</li>" for r in report["missing_recordings"]) + "</ul>")
    if report.get("checks"):
        p.append("<h3>Criteria</h3><table><tr><th>Criterion</th><th>Where</th><th>Value</th><th>Result</th></tr>")
        for ch in report["checks"]:
            res = {True: "pass", False: "FAIL", None: "no data"}[ch["passed"]]
            p.append(f"<tr><td>{html.escape(ch['criterion'])}</td><td>{html.escape(ch['where'])}</td><td>{f(ch['value'])}</td><td>{res}</td></tr>")
        p.append("</table>")
        if report.get("categories_not_judged"):
            p.append(f"<p class='muted'>Categories with fewer than {report['criteria']['min_reference_events']} reference "
                     f"events are reported but not judged: {html.escape(', '.join(report['categories_not_judged']))}.</p>")
    m = report.get("metrics")
    if m:
        p.append("<h3>Overall</h3><table><tr><th>Measure</th><th>Value</th></tr>")
        for k, v in m["overall"].items():
            p.append(f"<tr><td>{html.escape(METRICS[k]['label'])}</td><td>{f(v)}</td></tr>")
        p.append("</table><h3>By artifact category</h3>")
        df = pd.DataFrame(m["per_category"])
        p.append(df.to_html(index=False, float_format=lambda x: f"{x:.3f}", na_rep="n/a", border=0))
        for title, key in (("Missed reference artifacts", "missed"), ("Extra annotations", "extra"),
                           ("Different labels", "label_differences")):
            items = m.get(key, [])
            p.append(f"<h3>{title} ({len(items)})</h3>")
            if items:
                p.append(pd.DataFrame(items).to_html(index=False, float_format=lambda x: f"{x:.2f}", border=0))
        p.append(f"<p class='muted'>Matching: {html.escape(json.dumps({k: m['analysis_config'][k] for k in ('match_criterion', 'primary_iou_threshold', 'allow_many_to_one')}))}. "
                 f"Total assessed time {m['minutes_assessed']:.1f} min.</p>")
    p.append("<h3>Reference provenance</h3><pre>" + html.escape(json.dumps(rs.get("provenance", {}), indent=2)) + "</pre>")
    p.append("<h3>Reproducibility</h3><pre>" + html.escape(json.dumps(report["inputs"], indent=2)) + "</pre>")
    p.append(f"<p class='muted'>Results digest: {html.escape(report.get('results_sha256', ''))}</p></body></html>")
    return "\n".join(p)
