"""Per-annotator completion register.

``completion_register.tsv`` (in the output folder) is the authoritative record
of which annotator has completed which recording. Rows are only added after
all output files have been written and verified. Completion is tracked per
(recording, annotator, mode, context), so a recording completed by one
annotator stays available to every other annotator.

For compatibility with the originally proposed ``completed_datasets.txt``,
each annotator folder also contains a ``completed_datasets.txt`` listing the
recording IDs that annotator has completed (one per line). It is regenerated
from the register after every update and is never read back.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from electrotag.app.io.atomic import atomic_write_bytes, atomic_write_text
from electrotag.app.io.locking import FileLock
from electrotag.app.io.naming import OutputLayout
from electrotag.app.io.tsv import TSVError, parse_tsv_text, tsv_bytes

REGISTER_COLUMNS = [
    "recording_id",
    "annotator_id",
    "mode",
    "context",
    "status",
    "session_id",
    "completed_at",
    "elapsed_s",
    "n_annotations",
    "output_dir",
    "output_basename",
    "app_version",
]

STATUS_COMPLETED = "completed"


class RegisterError(RuntimeError):
    pass


@dataclass
class CompletionRegister:
    layout: OutputLayout
    lock_timeout_s: float = 30.0

    @property
    def path(self) -> Path:
        return self.layout.register

    def _lock(self) -> FileLock:
        return FileLock(self.layout.locks / "register.lock", {"purpose": "completion register"}, stale_after_s=300)

    def entries(self) -> list[dict[str, str]]:
        if not self.path.exists():
            return []
        try:
            columns, rows = parse_tsv_text(self.path.read_text(encoding="utf-8"), str(self.path))
        except (OSError, TSVError) as exc:
            raise RegisterError(f"The completion register {self.path} cannot be read: {exc}") from exc
        missing = [c for c in ("recording_id", "annotator_id", "status") if c not in columns]
        if missing:
            raise RegisterError(f"The completion register lacks columns {missing}")
        return [dict(zip(columns, r)) for r in rows]

    def completed(self, annotator_id: str, mode: str = "standard", context: str = "") -> set[str]:
        return {
            e["recording_id"]
            for e in self.entries()
            if e.get("annotator_id") == annotator_id
            and e.get("mode", "standard") == mode
            and e.get("context", "") == context
            and e.get("status") == STATUS_COMPLETED
        }

    def is_completed(self, recording_id: str, annotator_id: str, mode: str = "standard", context: str = "") -> bool:
        return recording_id in self.completed(annotator_id, mode, context)

    def annotators_for(self, recording_id: str, mode: str = "standard") -> set[str]:
        return {
            e["annotator_id"]
            for e in self.entries()
            if e["recording_id"] == recording_id and e.get("mode", "standard") == mode and e["status"] == STATUS_COMPLETED
        }

    def has_session(self, session_id: str) -> bool:
        return any(e.get("session_id") == session_id for e in self.entries())

    def add(self, entry: dict[str, Any]) -> bool:
        """Append a completed session. Returns False if it was already present."""
        row = {c: str(entry.get(c, "")) for c in REGISTER_COLUMNS}
        if not row["recording_id"] or not row["annotator_id"] or not row["session_id"]:
            raise RegisterError("Register entries need recording_id, annotator_id and session_id")
        row["status"] = row["status"] or STATUS_COMPLETED
        lock = self._lock()
        lock.acquire(timeout_s=self.lock_timeout_s)
        try:
            entries = self.entries()
            if any(e.get("session_id") == row["session_id"] for e in entries):
                # Already registered (e.g. by recovery). Regenerate the list in case an
                # earlier attempt stopped between the register and the list.
                if row["mode"] == "standard":
                    self._write_completed_list(row["annotator_id"], entries)
                return False
            entries.append(row)
            columns = list(REGISTER_COLUMNS)
            for e in entries:
                for k in e:
                    if k not in columns:
                        columns.append(k)
            data = tsv_bytes(columns, [[e.get(c, "") for c in columns] for e in entries])
            atomic_write_bytes(self.path, data)
            if row["mode"] == "standard":
                self._write_completed_list(row["annotator_id"], entries)
            return True
        finally:
            lock.release()

    def _write_completed_list(self, annotator_id: str, entries: list[dict[str, str]]) -> None:
        ids = sorted(
            {
                e["recording_id"]
                for e in entries
                if e.get("annotator_id") == annotator_id
                and e.get("mode", "standard") == "standard"
                and e.get("status") == STATUS_COMPLETED
            }
        )
        atomic_write_text(self.layout.completed_list(annotator_id), "".join(f"{i}\n" for i in ids))
