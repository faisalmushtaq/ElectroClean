"""Reading interaction logs (JSON Lines written by electrotag/app/session/interaction_log.py).

Reading is forgiving: a last line cut short by a crash, a line that is not JSON and unknown
event kinds are counted and skipped or kept, never fatal. Logs of a different major schema
version are refused with a warning, since their fields could mean something else.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from electrotag.app.session.interaction_log import SCHEMA, SCHEMA_VERSION

#: Major versions of the log format this reader understands.
SUPPORTED_MAJOR = {SCHEMA_VERSION.split(".")[0]}


@dataclass
class VisitLog:
    path: Path
    header: dict[str, Any]
    events: list[dict[str, Any]] = field(default_factory=list)
    bad_lines: int = 0  # lines that could not be read (for example the last one after a crash)

    @property
    def visit_id(self) -> str:
        return str(self.header.get("visit_id") or self.path.stem)

    @property
    def annotator_id(self) -> str:
        return str(self.header.get("annotator_id", ""))

    @property
    def closed(self) -> bool:
        return bool(self.events) and self.events[-1].get("type") == "log_closed"

    @property
    def close_reason(self) -> str:
        return str(self.events[-1].get("reason", "")) if self.closed else "not closed (ended unexpectedly)"

    @property
    def idle_after_s(self) -> float:
        try:
            return float((self.header.get("logging") or {}).get("idle_after_s", 30.0))
        except (TypeError, ValueError):
            return 30.0


class LogError(ValueError):
    pass


def read_visit_log(path: Path | str) -> VisitLog:
    """Read one visit's log. Raises :class:`LogError` if it is not an ElectroTag interaction log."""
    path = Path(path)
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise LogError(f"{path}: {exc}") from exc
    header: dict[str, Any] | None = None
    events: list[dict[str, Any]] = []
    bad = 0
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            bad += 1
            continue
        if not isinstance(obj, dict):
            bad += 1
            continue
        if header is None:
            if obj.get("type") != "header" or obj.get("schema") != SCHEMA:
                raise LogError(f"{path}: not an ElectroTag interaction log")
            major = str(obj.get("schema_version", "")).split(".")[0]
            if major not in SUPPORTED_MAJOR:
                raise LogError(f"{path}: log format version {obj.get('schema_version')} is not supported by this "
                               f"version of ElectroTag (it reads version {SCHEMA_VERSION})")
            header = obj
            continue
        if "type" not in obj or "t" not in obj:
            bad += 1
            continue
        events.append(obj)
    if header is None:
        raise LogError(f"{path}: empty or not an ElectroTag interaction log")
    events.sort(key=lambda e: (float(e.get("t", 0.0)), int(e.get("seq", 0))))
    return VisitLog(path=path, header=header, events=events, bad_lines=bad)


def find_logs(inputs: Iterable[Path | str]) -> list[Path]:
    """Every ``*.jsonl`` log in the given files and folders.

    A results folder (the one holding ``interaction_logs``) or the ``interaction_logs`` folder itself
    can be given; folders are searched recursively."""
    found: list[Path] = []
    for item in inputs:
        p = Path(item)
        if p.is_file():
            found.append(p)
        elif p.is_dir():
            base = p / "interaction_logs" if (p / "interaction_logs").is_dir() else p
            found.extend(sorted(base.rglob("*.jsonl")))
    seen: set[Path] = set()
    out = []
    for f in found:
        r = f.resolve()
        if r not in seen:
            seen.add(r)
            out.append(f)
    return out


def read_logs(paths: Iterable[Path | str]) -> tuple[list[VisitLog], list[str]]:
    """Read every log; files that are not interaction logs become warnings."""
    visits: list[VisitLog] = []
    warnings: list[str] = []
    for p in paths:
        try:
            v = read_visit_log(p)
        except LogError as exc:
            warnings.append(str(exc))
            continue
        if v.bad_lines:
            warnings.append(f"{p}: {v.bad_lines} line(s) could not be read and were skipped")
        visits.append(v)
    visits.sort(key=lambda v: (v.annotator_id, str(v.header.get("started_at", "")), str(v.path)))
    return visits, warnings
