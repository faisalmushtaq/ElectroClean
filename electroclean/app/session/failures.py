"""Failure logging and the session log.

``failed_load.txt`` keeps the originally proposed simple format: one line per
failure with the time stamp, recording and error message separated by tabs.
``failure_log.jsonl`` holds the same information in structured form, together
with a cheap fingerprint (size and modification time) of the recording's files
and the settings that caused the failure. A recording whose most recent
failure still applies (same files, same relevant settings, not marked as
resolved) is left out of automatic selection, so annotators are not offered the
same broken file again. Once the files are replaced, the setting is changed,
or an administrator records a resolution, it becomes eligible again.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from electroclean.app.common import now_local_iso
from electroclean.app.io.atomic import append_line
from electroclean.app.io.discovery import RecordingFiles
from electroclean.app.io.naming import OutputLayout


def cheap_fingerprint(files: RecordingFiles) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for role, path in files.source_files().items():
        try:
            st = path.stat()
            out[role] = [st.st_size, st.st_mtime_ns]
        except OSError:
            out[role] = [-1, -1]
    for role, path in (("eeg", files.eeg), ("vmrk", files.vmrk)):
        if path is not None and role not in out:
            out[role] = [-1, -1]  # referenced but missing
    return out


@dataclass
class FailureLog:
    layout: OutputLayout

    def record(
        self,
        files: RecordingFiles | None,
        recording_id: str,
        kind: str,
        message: str,
        *,
        annotator_id: str = "",
        session_id: str = "",
        conditions: dict[str, Any] | None = None,
        details: str = "",
    ) -> None:
        stamp = now_local_iso()
        one_line = " ".join(message.split())
        append_line(self.layout.failed_load_txt, f"{stamp}\t{recording_id}\t{one_line}")
        entry = {
            "event": "failure",
            "timestamp": stamp,
            "recording_id": recording_id,
            "kind": kind,
            "message": message,
            "details": details,
            "annotator_id": annotator_id,
            "session_id": session_id,
            "fingerprint": cheap_fingerprint(files) if files is not None else {},
            "conditions": conditions or {},
        }
        append_line(self.layout.failure_log, json.dumps(entry, ensure_ascii=False))

    def mark_resolved(self, recording_id: str, note: str, by: str = "") -> None:
        entry = {
            "event": "resolved",
            "timestamp": now_local_iso(),
            "recording_id": recording_id,
            "note": note,
            "by": by,
        }
        append_line(self.layout.failure_log, json.dumps(entry, ensure_ascii=False))

    def entries(self) -> list[dict[str, Any]]:
        path = self.layout.failure_log
        if not path.exists():
            return []
        out = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                continue  # a partially written last line after a crash
        return out

    def unresolved(self, recordings: list[RecordingFiles], current_conditions: dict[str, Any]) -> dict[str, dict[str, Any]]:
        """Recording ID -> latest failure entry, for failures that still apply."""
        latest: dict[str, dict[str, Any]] = {}
        for e in self.entries():
            rid = e.get("recording_id", "")
            if e.get("event") == "resolved":
                latest.pop(rid, None)
            elif e.get("event") == "failure":
                latest[rid] = e
        by_id = {r.recording_id: r for r in recordings}
        out = {}
        for rid, e in latest.items():
            files = by_id.get(rid)
            if files is None:
                continue
            if e.get("fingerprint") and e["fingerprint"] != cheap_fingerprint(files):
                continue  # files changed since the failure: try again
            cond = e.get("conditions") or {}
            if any(current_conditions.get(k) != v for k, v in cond.items()):
                continue  # the setting that caused the failure has changed
            out[rid] = e
        return out


@dataclass
class SessionLog:
    """Append-only log of session events (started, completed, abandoned, ...)."""

    layout: OutputLayout

    def write(self, event: str, **fields: Any) -> None:
        entry = {"event": event, "timestamp": now_local_iso(), **fields}
        append_line(self.layout.session_log, json.dumps(entry, ensure_ascii=False, default=str))

    def entries(self) -> list[dict[str, Any]]:
        path: Path = self.layout.session_log
        if not path.exists():
            return []
        out = []
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out
