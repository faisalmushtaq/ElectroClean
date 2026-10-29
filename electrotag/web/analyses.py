"""Analyses the admin area runs on demand, with ElectroTag's own analysis code.

* ``agreement``: :mod:`electrotag.reliability` (the tables and the self-contained HTML report of
  ``electrotag-agreement``);
* ``activity``: :mod:`electrotag.activity` (the tables and report of ``electrotag-activity``);
* ``competency``: :func:`electrotag.training.assessment.competency_report` and its HTML;
* ``results_zip``: the results folder as a zip, as ``GET /admin/results.zip`` gives it.

The analyses read a results folder in ElectroTag's results layout: the files store's own folder,
or, for Firestore, the saved files written into a temporary folder for the time of the analysis
(:meth:`~electrotag.web.store.Store.results_tree`). Nothing here needs MNE-Python; the agreement
report draws its figures with matplotlib.
"""

from __future__ import annotations

import base64
import json
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from electrotag.web.errors import ApiError

if TYPE_CHECKING:
    from electrotag.web.service import StudyService

#: Above this, the agreement's largest tables are left out of the answer (the report keeps its summary).
MAX_TABLES_BYTES = 12_000_000
#: Tables dropped first when the answer would be too large (they list every matched or unmatched event).
LARGE_TABLES = ("events_matched", "events_unmatched")
#: The columns of annotation_notes.tsv, the annotators' notes, which is always sent.
NOTE_COLUMNS = ("recording_id", "annotator_id", "mode", "annotation_id", "label", "onset_s", "duration_s", "channels",
                "confidence", "note")


def notes_table(result: Any) -> str:
    """annotation_notes.tsv: every annotation that carries a note, in the analysis's recordings."""
    import csv
    import io

    buf = io.StringIO()
    w = csv.writer(buf, delimiter="\t", lineterminator="\n")
    w.writerow(NOTE_COLUMNS)
    for rid, group in sorted(result.dataset.groups.items()):
        for aid, doc in sorted(group.docs.items()):
            timing = doc.recording.timing
            for a in doc.sorted_annotations():
                if not a.note:
                    continue
                w.writerow([rid, aid, doc.mode, a.annotation_id, a.label, f"{a.onset(timing):.6g}",
                            f"{a.duration(timing):.6g}", ",".join(a.channels) or "n/a",
                            "n/a" if a.confidence is None else a.confidence,
                            " ".join(str(a.note).split())])
    return buf.getvalue()


def agreement_command(settings_name: str = "agreement_settings.json") -> str:
    """The command that repeats the admin area's agreement analysis on the study's results folder."""
    return f"electrotag-agreement Annotated_Events --config {settings_name}"
ANALYSIS_MODES = ("standard", "practice", "assessment")


def _with_note(html: str, note: str) -> str:
    """The agreement report with a paragraph about the recordings left out, at the top of its body."""
    from html import escape

    para = (f'<p class="note" data-note="unusable"><b>Left out:</b> {escape(note)}</p>')
    i = html.find("<body")
    j = html.find(">", i) if i >= 0 else -1
    return html[:j + 1] + para + html[j + 1:] if j >= 0 else para + html


def _ids(value: Any, what: str) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not value or not all(isinstance(v, str) and v.strip() for v in value) \
            or len(value) > 1000:
        raise ApiError(400, "bad_request", f"{what} must be a list of IDs")
    return [v.strip() for v in value]


class Analyses:
    def __init__(self, service: StudyService) -> None:
        self.service = service

    @property
    def store(self) -> Any:
        return self.service.store

    # ------------------------------------------------------------ agreement
    def agreement(self, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.app.annotations.model import AnnotationError
        from electrotag.reliability.analysis import run_analysis
        from electrotag.reliability.config import AnalysisConfig
        from electrotag.reliability.report import build_html_report, key_results
        from electrotag.web.service import clean_json

        annotators = _ids(body.get("annotator_ids"), "annotator_ids")
        annotators = [a.upper() for a in annotators] if annotators else None
        recordings = _ids(body.get("recording_ids"), "recording_ids")
        modes = body.get("modes", ["standard"])
        if not isinstance(modes, list) or not modes or any(m not in ANALYSIS_MODES for m in modes):
            raise ApiError(400, "bad_request", f"modes must be a list drawn from {', '.join(ANALYSIS_MODES)}")
        given = body.get("config") or {}
        if not isinstance(given, dict):
            raise ApiError(400, "invalid_config", "config must be an object of analysis settings")
        if {"annotators", "modes"} & set(given):
            raise ApiError(400, "invalid_config", "Choose the annotators and modes with annotator_ids and modes")
        try:
            cfg = AnalysisConfig.from_dict({**AnalysisConfig().to_dict(), **given, "annotators": annotators,
                                            "modes": list(modes)})
        except (ValueError, TypeError) as exc:
            raise ApiError(400, "invalid_config", f"The analysis settings are not valid: {exc}") from exc
        with tempfile.TemporaryDirectory(prefix="electrotag-agreement-") as tmp:
            root = self.store.results_tree(Path(tmp), annotator_ids=set(annotators) if annotators else None,
                                           modes=set(modes))
            # A recording an annotator reported as one that cannot be annotated is left out for everyone: its
            # other annotations would be compared with a judgement nobody could make (docs/web/api.md).
            unusable = self.service.feedback.unusable_recordings() if "standard" in modes else {}
            wanted = set(recordings) if recordings else None
            files = self._annotation_files(root, wanted, leave_out=set(unusable))
            left_out = sorted(r for r in unusable if wanted is None or r in wanted)
            if not files:
                raise ApiError(422, "not_enough", "No saved annotations match: nothing to compare yet.")
            try:
                result = run_analysis(files, cfg, strict=True)
            except (ValueError, FileNotFoundError, AnnotationError) as exc:
                raise ApiError(400, "invalid_config", str(exc)) from exc
        if not result.has_comparisons:
            raise ApiError(422, "not_enough", "No recording has been saved by two of the annotators being compared, "
                           "so there is no agreement to measure yet.")
        warnings = list(result.settings_record.get("warnings", []))
        unusable_note = ""
        if left_out:
            people = sum(unusable[r] for r in left_out)
            unusable_note = (f"{len(left_out)} recording{'s' if len(left_out) != 1 else ''} "
                             f"{'were' if len(left_out) != 1 else 'was'} left out because an annotator reported "
                             f"{'them' if len(left_out) != 1 else 'it'} as impossible to annotate "
                             f"({people} report{'s' if people != 1 else ''} of a recording that cannot be annotated). "
                             "Returning a recording to its annotator's list brings it back into the analysis. The "
                             "settings used (JSON) name the recordings left out, so " + agreement_command()
                             + " leaves them out too.")
            warnings.append(unusable_note)
        tables = {f"{name}.tsv": df.to_csv(sep="\t", index=False, na_rep="n/a", float_format="%.6g")
                  for name, df in result.tables.items()}
        if sum(len(t) for t in tables.values()) > MAX_TABLES_BYTES:
            for name in LARGE_TABLES:
                if tables.pop(f"{name}.tsv", None) is not None:
                    warnings.append(f"The table {name}.tsv was too large to send through the page. The annotators' "
                                    "notes are in annotation_notes.tsv; for the whole table, download the results "
                                    "zip and The settings used (JSON), and run " + agreement_command() + ".")
        # The annotators' notes, small enough to send whatever the size of the other tables.
        tables["annotation_notes.tsv"] = notes_table(result)
        record = result.settings_record
        # The settings in the form electrotag-agreement --config reads, with the recordings chosen and those set
        # aside, so that the command analyses the same recordings and gives the same numbers.
        settings_file = clean_json({"config": record.get("config"), "recording_ids": recordings,
                                    "exclude_recording_ids": sorted(unusable),
                                    "command": agreement_command()})
        summary = clean_json({
            "n_recordings": record.get("n_recordings"),
            "n_comparable_recordings": record.get("n_comparable_recordings"),
            "annotators": record.get("annotators"), "config": record.get("config"),
            "key_results": json.loads(key_results(result).to_json(orient="records")),
        })
        summary["unusable"] = {"recordings_left_out": len(left_out), "recording_ids": left_out,
                               "assignments": sum(unusable[r] for r in left_out)}
        html = build_html_report(result)
        if unusable_note:
            html = _with_note(html, unusable_note)
        return {"summary": summary, "report_html": html, "tables": tables, "warnings": warnings,
                "settings_file": settings_file}

    @staticmethod
    def _annotation_files(root: Path, recordings: set[str] | None, leave_out: set[str] | None = None) -> list[Path]:
        from electrotag.app.io.naming import INTERNAL_DIR
        from electrotag.reliability.data import select_annotation_files

        out = []
        for p in sorted(root.rglob("*_annotations.json")):
            rel = p.relative_to(root).parts
            if rel and rel[0] in (INTERNAL_DIR, "interaction_logs", "activity_reports"):
                continue
            if "reports" in rel or "references" in rel:
                continue
            out.append(p)
        # The same choice as electrotag-agreement --recordings and --exclude-recordings makes.
        return select_annotation_files(out, recordings=recordings, exclude=leave_out)

    # ------------------------------------------------------------- activity
    def activity(self, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.activity.logs import find_logs, read_logs
        from electrotag.activity.report import report_html
        from electrotag.activity.summary import RECORDING_COLUMNS, VISIT_COLUMNS, summarise, write_tsv

        annotators = _ids(body.get("annotator_ids"), "annotator_ids")
        annotators = [a.upper() for a in annotators] if annotators else None
        with tempfile.TemporaryDirectory(prefix="electrotag-activity-") as tmp:
            root = self.store.results_tree(Path(tmp) / "results", logs=True,
                                           annotator_ids=set(annotators) if annotators else None)
            logs = find_logs([root / "interaction_logs"]) if (root / "interaction_logs").is_dir() else []
            visits, warnings = read_logs(logs) if logs else ([], [])
            if annotators:
                visits = [v for v in visits if str(v.header.get("annotator_id", "")).upper() in annotators]
            if not visits:
                raise ApiError(422, "no_logs", "There are no interaction logs to summarise yet (they are kept when "
                               "the study records interactions and annotators have used ElectroTag).")
            tables = summarise(visits, annotators=annotators, with_events=False, warnings=warnings)
            out_tables = {}
            for name, rows, columns in (("visits", tables.visits, [c for c, _ in VISIT_COLUMNS]),
                                        ("recordings", tables.recordings, [c for c, _ in RECORDING_COLUMNS])):
                path = Path(tmp) / f"{name}.tsv"
                write_tsv(path, rows, columns)
                out_tables[f"{name}.tsv"] = path.read_text(encoding="utf-8")
        html = report_html(tables, files={"visits": "visits.tsv", "recordings": "recordings.tsv"})
        return {"report_html": html, "tables": out_tables}

    # ----------------------------------------------------------- competency
    def competency(self, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.training.assessment import competency_html
        from electrotag.web.service import clean_json

        set_id, aid = body.get("set_id"), body.get("annotator_id")
        if not isinstance(set_id, str) or not isinstance(aid, str) or not aid.strip():
            raise ApiError(400, "bad_request", "Give set_id and annotator_id")
        aid = aid.strip().upper()
        rs = self.service.reference_set(set_id)
        required = rs.assessment_recordings
        if not required:
            raise ApiError(404, "not_complete", f"{rs.name or rs.set_id} has no assessment recordings. Mark some of "
                           "its recordings for assessment in Training first.")
        done = self.store.completed(aid, "assessment", rs.set_id) & set(required)
        if len(done) < len(required):
            raise ApiError(404, "not_complete", f"{aid} has saved {len(done)} of the {len(required)} assessment "
                           "recordings; the report is made when every one is saved. Progress shows how far they "
                           "have got.")
        report = dict(self.store.competency(rs, aid))
        report.pop("paths", None)
        return {"report": clean_json(report), "html": competency_html(report)}

    # ---------------------------------------------------------- results zip
    def results_zip(self, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.web.export import MAX_RESULTS_ZIP, results_zip_file

        path = results_zip_file(self.store)
        try:
            size = path.stat().st_size
            if size > MAX_RESULTS_ZIP:
                raise ApiError(413, "too_large", f"The results are {size / 1e6:.0f} MB, more than the "
                               f"{MAX_RESULTS_ZIP // 1_000_000} MB the admin area downloads. Export them with "
                               "'electrotag-web export' instead.", size_bytes=size)
            data = path.read_bytes()
        finally:
            path.unlink(missing_ok=True)
        return {"file_name": f"{self.store.study_id}_results.zip", "base64": base64.b64encode(data).decode("ascii"),
                "size_bytes": size}
