"""Automatic saving of unfinished work.

While a recording is open, its annotations and the time spent on it are
written every few seconds (only when something changed, and at least once a
minute while the timer runs) to
``<results>/.electrotag/autosave/<annotator>-<key>.json``. The file is
written atomically, so it is always either the previous or the new complete
version.

An autosave is never an output: the recording only becomes complete through
Save and Finish. The file is removed when the recording is saved, or when the
annotator explicitly discards the work. If ElectroTag stops unexpectedly (or
the annotator chooses *Close and finish later*), the file stays, and the next
time that annotator opens the recording, or starts a session, ElectroTag
offers to continue where they left off, with the time already spent carried
over. Autosaves that no longer fit the recording (its files changed) are moved
to ``.electrotag/interrupted/`` instead of being restored.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from electrotag.app.annotations.model import AnnotationDocument
from electrotag.app.common import now_local_iso
from electrotag.app.io.atomic import atomic_write_json
from electrotag.app.io.canonical import document_from_dict, document_to_dict
from electrotag.app.io.naming import OutputLayout

SCHEMA = "electrotag.autosave"
SCHEMA_VERSION = "1.0.0"


def autosave_path(layout: OutputLayout, recording_id: str, annotator_id: str, mode: str, context: str) -> Path:
    digest = hashlib.sha1(f"{recording_id}|{mode}|{context}".encode()).hexdigest()[:16]
    return layout.autosave / f"{annotator_id}-{digest}.json"


@dataclass
class AutosaveRecord:
    """An unfinished annotation of one recording by one annotator."""

    path: Path
    document: AnnotationDocument
    elapsed_s: float
    saved_at: str
    session_id: str
    filters: dict[str, Any] = field(default_factory=dict)
    previous_sessions: list[dict[str, Any]] = field(default_factory=list)
    source_fingerprint: dict[str, Any] = field(default_factory=dict)

    @property
    def recording_id(self) -> str:
        return self.document.recording.recording_id

    @property
    def n_annotations(self) -> int:
        return len(self.document.annotations)

    def describe(self) -> str:
        from electrotag.app.common import friendly_duration, friendly_time

        return (
            f"{self.n_annotations} annotation(s) and {friendly_duration(self.elapsed_s)} of work on "
            f"{self.recording_id}, saved automatically {friendly_time(self.saved_at)}"
        )

    def problems_with(self, loaded: Any) -> list[str]:
        """Reasons why this autosave cannot be restored onto ``loaded`` (empty if it fits)."""
        problems = []
        if self.document.recording.timing != loaded.info.timing:
            problems.append("the recording's sampling rate or length differs")
        if tuple(self.document.recording.ch_names) != tuple(loaded.info.ch_names):
            problems.append("the recording's channels (or the channels shown) differ")
        for role in ("eeg", "vhdr", "vmrk"):
            before = (self.source_fingerprint.get(role) or {})
            now = (loaded.fingerprint.get(role) or {})
            if before.get("sha256") and now.get("sha256") and before["sha256"] != now["sha256"]:
                problems.append(f"the {role} file has changed")
            elif before and now and before.get("size") != now.get("size"):
                problems.append(f"the {role} file has changed")
        return problems


def write_autosave(
    path: Path,
    document: AnnotationDocument,
    *,
    elapsed_s: float,
    session_id: str,
    filters: dict[str, Any],
    source_fingerprint: dict[str, Any],
    previous_sessions: list[dict[str, Any]],
) -> None:
    atomic_write_json(
        path,
        {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "note": "Unfinished work, saved automatically. Not an output: use Save and Finish in ElectroTag.",
            "saved_at": now_local_iso(),
            "session_id": session_id,
            "elapsed_s": round(float(elapsed_s), 3),
            "filters": filters,
            "previous_sessions": previous_sessions,
            "source_fingerprint": source_fingerprint,
            "document": document_to_dict(document),
        },
    )


def read_autosave(path: Path) -> AutosaveRecord:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if data.get("schema") != SCHEMA:
        raise ValueError(f"{path} is not an ElectroTag autosave file")
    return AutosaveRecord(
        path=Path(path),
        document=document_from_dict(data["document"]),
        elapsed_s=float(data.get("elapsed_s", 0.0)),
        saved_at=str(data.get("saved_at", "")),
        session_id=str(data.get("session_id", "")),
        filters=dict(data.get("filters") or {}),
        previous_sessions=list(data.get("previous_sessions") or []),
        source_fingerprint=dict(data.get("source_fingerprint") or {}),
    )


def find_autosave(
    layout: OutputLayout, recording_id: str, annotator_id: str, mode: str, context: str
) -> AutosaveRecord | None:
    path = autosave_path(layout, recording_id, annotator_id, mode, context)
    if not path.is_file():
        return None
    try:
        record = read_autosave(path)
    except (OSError, ValueError, KeyError):
        set_aside(layout, path, "unreadable")
        return None
    if record.document.annotator_id != annotator_id or record.recording_id != recording_id:
        return None
    return record


def autosaves_for(layout: OutputLayout, annotator_id: str, mode: str, context: str) -> list[AutosaveRecord]:
    """Every readable autosave of this annotator in this mode and context, newest first."""
    out = []
    if not layout.autosave.is_dir():
        return out
    for path in sorted(layout.autosave.glob(f"{annotator_id}-*.json")):
        try:
            record = read_autosave(path)
        except (OSError, ValueError, KeyError):
            continue
        doc = record.document
        if (doc.annotator_id == annotator_id and doc.mode == mode
                and str((doc.context or {}).get("reference_set_id", "")) == context):
            out.append(record)
    out.sort(key=lambda r: r.saved_at, reverse=True)
    return out


def delete_autosave(path: Path) -> None:
    try:
        Path(path).unlink()
    except FileNotFoundError:
        pass


def set_aside(layout: OutputLayout, path: Path, reason: str) -> Path | None:
    """Move an autosave that will not be restored to ``.electrotag/interrupted/`` (never deleted)."""
    path = Path(path)
    if not path.exists():
        return None
    dest = layout.quarantine / "autosave" / f"{path.stem}-{reason}-{now_local_iso().replace(':', '')}.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(path, dest)
    except OSError:
        return None
    return dest
