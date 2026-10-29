"""``electrotag-activity``: tables and learning curves from the interaction logs.

    electrotag-activity RESULTS_FOLDER [--out FOLDER] [--annotator ID ...] [--events] [--no-report]

RESULTS_FOLDER is the results folder of a study (the one holding ``interaction_logs``), the
``interaction_logs`` folder itself, or individual log files. The tables (``visits.tsv``,
``recordings.tsv`` and, with ``--events``, ``events.tsv``), a description of their columns and the
HTML report are written to ``--out`` (by default ``activity_reports/<date and time>`` inside the
results folder).
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Iterable, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

from electrotag.activity.logs import find_logs, read_logs
from electrotag.activity.report import report_html
from electrotag.activity.summary import (
    EVENT_COLUMNS,
    RECORDING_COLUMNS,
    VISIT_COLUMNS,
    ActivityTables,
    columns_text,
    summarise,
    write_tsv,
)


class NoLogsError(ValueError):
    pass


def default_out(first_input: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    base = first_input if first_input.is_dir() else first_input.parent
    if base.name == "interaction_logs" or base.parent.name == "interaction_logs":
        base = base.parent if base.name == "interaction_logs" else base.parent.parent
    return base / "activity_reports" / stamp


def write_activity(inputs: Iterable[Path | str], out_dir: Path | str, *, annotators: Sequence[str] | None = None,
                   with_events: bool = False, report: bool = True) -> tuple[ActivityTables, dict[str, Path]]:
    """Read the logs, write the tables (and the report); returns the tables and the files written."""
    logs = find_logs(inputs)
    if not logs:
        raise NoLogsError("No interaction logs were found (they are in the results folder, under interaction_logs).")
    visits, warnings = read_logs(logs)
    if not visits:
        raise NoLogsError("None of the files is an ElectroTag interaction log:\n" + "\n".join(warnings))
    tables = summarise(visits, annotators=annotators, with_events=with_events, warnings=warnings)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {
        "visits": out / "visits.tsv",
        "recordings": out / "recordings.tsv",
        "columns": out / "about_these_tables.txt",
    }
    write_tsv(paths["visits"], tables.visits, [c for c, _ in VISIT_COLUMNS])
    write_tsv(paths["recordings"], tables.recordings, [c for c, _ in RECORDING_COLUMNS])
    paths["columns"].write_text(columns_text(), encoding="utf-8")
    if with_events:
        paths["events"] = out / "events.tsv"
        write_tsv(paths["events"], tables.events, EVENT_COLUMNS)
    if report:
        paths["report"] = out / "activity_report.html"
        listed = {k: v.name for k, v in paths.items() if k != "report"}
        paths["report"].write_text(report_html(tables, files=listed), encoding="utf-8")
    return tables, paths


def summary_text(tables: ActivityTables, paths: dict[str, Any]) -> str:
    finished = sum(1 for r in tables.recordings if r["segment"] == "recording" and r["outcome"] == "finished")
    annotators = sorted({v["annotator_id"] for v in tables.visits})
    lines = [f"{len(tables.visits)} visit(s) by {len(annotators)} annotator(s); {finished} recording(s) finished."]
    lines += [f"{k}: {v}" for k, v in paths.items()]
    if tables.warnings:
        lines.append(f"{len(tables.warnings)} note(s) about the logs, listed in the report.")
    return "\n".join(lines)


def main(argv: list[str] | None = None, prog: str = "electrotag-activity") -> int:
    ap = argparse.ArgumentParser(prog=prog, description=__doc__.split("\n\n")[0])
    ap.add_argument("inputs", nargs="+", type=Path, help="results folder, interaction_logs folder or log files")
    ap.add_argument("--out", type=Path, help="folder for the tables and the report")
    ap.add_argument("--annotator", action="append", help="only this annotator (may be repeated)")
    ap.add_argument("--events", action="store_true", help="also write every event to events.tsv")
    ap.add_argument("--no-report", action="store_true", help="write the tables only")
    args = ap.parse_args(argv)
    missing = [p for p in args.inputs if not p.exists()]
    if missing:
        print("Not found: " + ", ".join(str(p) for p in missing), file=sys.stderr)
        return 2
    out = args.out or default_out(args.inputs[0])
    try:
        tables, paths = write_activity(args.inputs, out, annotators=args.annotator, with_events=args.events,
                                       report=not args.no_report)
    except NoLogsError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(summary_text(tables, paths))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
