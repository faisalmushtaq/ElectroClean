"""Crash-safe commit of a session's output files.

Saving a session is a small transaction recorded in a journal file
(``transaction.json``) inside ``.electroclean/staging/<session_id>/``:

1. ``staging``    all output files are written (atomically) into the staging folder;
2. ``validated``  the staged files are read back and validated;
3. ``committing`` each file is moved into its final folder (same file system,
   so each move is atomic) and its checksum is re-verified;
4. ``files_committed`` all final files are in place and verified;
5. the completion register is updated;
6. ``complete``   the staging folder is removed.

If ElectroClean stops at any point, :func:`recover_interrupted_exports` (run
at start-up) inspects the journals. A transaction that reached
``files_committed``, or that was ``committing`` and whose final files are all
present and verified, is rolled forward (the register is updated, because the
annotator did press Save and Finish and every file was validated). Anything
else is rolled back: files already moved are taken out of the output folders
and, together with the staged files, kept in ``.electroclean/interrupted/`` for
manual inspection. A recording is therefore never marked complete unless all
of its outputs exist and match their verified checksums.
"""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from electroclean.app.common import now_local_iso
from electroclean.app.io.atomic import (
    OutputWriteError,
    atomic_write_bytes,
    atomic_write_json,
    check_free_space,
    fsync_directory,
    sha256_bytes,
    sha256_file,
)
from electroclean.app.io.naming import OutputLayout
from electroclean.app.session.failures import SessionLog
from electroclean.app.session.register import CompletionRegister

JOURNAL = "transaction.json"


class ExportCommitError(RuntimeError):
    """Saving failed. ``committed`` tells whether outputs are nevertheless final."""

    def __init__(self, message: str, *, committed: bool = False) -> None:
        super().__init__(message)
        self.committed = committed


@dataclass
class CommitResult:
    final_dir: Path
    paths: dict[str, Path]
    sha256: dict[str, str]
    register_updated: bool


@dataclass
class RecoveryAction:
    session_id: str
    action: str  # "rolled_forward", "rolled_back", "cleaned_up", "unreadable"
    message: str
    details: dict[str, Any] = field(default_factory=dict)


def _write_journal(staging: Path, journal: dict[str, Any]) -> None:
    journal["updated_at"] = now_local_iso()
    atomic_write_json(staging / JOURNAL, journal)


# Test hook: a callable(stage_name) that may raise to simulate a crash.
FaultHook = Callable[[str], None]


def commit_outputs(
    layout: OutputLayout,
    session_id: str,
    final_dir: Path,
    files: dict[str, tuple[str, bytes]],
    validate: Callable[[dict[str, bytes]], None],
    register: CompletionRegister,
    register_entry: dict[str, Any],
    *,
    fault: FaultHook | None = None,
) -> CommitResult:
    """Write, validate and commit ``files`` (key -> (file name, bytes))."""

    def hook(stage: str) -> None:
        if fault is not None:
            fault(stage)

    staging = layout.staging / session_id
    total = sum(len(b) for _, b in files.values())
    check_free_space(layout.root, 3 * total)
    final_paths = {k: final_dir / name for k, (name, _) in files.items()}
    existing = [p for p in final_paths.values() if p.exists()]
    if existing:
        raise ExportCommitError(
            "Refusing to overwrite existing output files: " + ", ".join(str(p) for p in existing)
        )
    if staging.exists():
        raise ExportCommitError(f"A staging folder for session {session_id} already exists")
    staging.mkdir(parents=True)
    journal: dict[str, Any] = {
        "session_id": session_id,
        "state": "staging",
        "created_at": now_local_iso(),
        "final_dir": str(final_dir),
        "files": {k: {"name": name, "sha256": sha256_bytes(b)} for k, (name, b) in files.items()},
        "register_entry": register_entry,
    }
    try:
        _write_journal(staging, journal)
        for key, (name, data) in files.items():
            hook(f"write:{key}")
            atomic_write_bytes(staging / name, data, overwrite=False)
        hook("validate")
        staged = {k: (staging / name).read_bytes() for k, (name, _) in files.items()}
        for k, data in staged.items():
            if sha256_bytes(data) != journal["files"][k]["sha256"]:
                raise ExportCommitError(f"Staged file for {k} does not match what was written")
        validate(staged)
        journal["state"] = "validated"
        _write_journal(staging, journal)
    except Exception as exc:
        shutil.rmtree(staging, ignore_errors=True)
        if isinstance(exc, ExportCommitError):
            raise
        raise ExportCommitError(f"Outputs could not be written or validated: {exc}") from exc

    # Point of no return for the staging stage: move files into place.
    try:
        final_dir.mkdir(parents=True, exist_ok=True)
        journal["state"] = "committing"
        _write_journal(staging, journal)
        for key, (name, _) in files.items():
            hook(f"commit:{key}")
            target = final_paths[key]
            if target.exists():
                raise ExportCommitError(f"Output file appeared while saving: {target}")
            os.replace(staging / name, target)
        fsync_directory(final_dir)
        hook("verify")
        for key, target in final_paths.items():
            if sha256_file(target) != journal["files"][key]["sha256"]:
                raise ExportCommitError(f"Final file {target.name} does not match its verified checksum")
        journal["state"] = "files_committed"
        _write_journal(staging, journal)
    except Exception as exc:
        # Undo the partial commit so that no incomplete output set is left behind.
        _roll_back(layout, staging, journal, reason=f"commit failed: {exc}")
        if isinstance(exc, ExportCommitError):
            raise
        raise ExportCommitError(f"Outputs could not be moved into place: {exc}") from exc

    try:
        hook("register")
        updated = register.add(register_entry)
    except Exception as exc:
        raise ExportCommitError(
            "Your annotations were saved and verified, but the completion register could not be updated "
            f"({exc}). ElectroClean will finish this automatically the next time it starts.",
            committed=True,
        ) from exc
    journal["state"] = "complete"
    _write_journal(staging, journal)
    shutil.rmtree(staging, ignore_errors=True)
    return CommitResult(
        final_dir=final_dir,
        paths=final_paths,
        sha256={k: v["sha256"] for k, v in journal["files"].items()},
        register_updated=updated,
    )


def _roll_back(layout: OutputLayout, staging: Path, journal: dict[str, Any], reason: str) -> dict[str, Any]:
    """Move any committed final files back out of the output folders."""
    session_id = journal.get("session_id", staging.name)
    dest = layout.quarantine / session_id
    dest.mkdir(parents=True, exist_ok=True)
    moved = []
    final_dir = Path(journal.get("final_dir", ""))
    for key, info in journal.get("files", {}).items():
        name = info["name"]
        final = final_dir / name
        staged = staging / name
        if final.exists():
            try:
                if sha256_file(final) == info["sha256"]:
                    os.replace(final, dest / name)
                    moved.append(name)
            except OSError:
                pass
        if staged.exists():
            try:
                os.replace(staged, dest / name)
            except OSError:
                pass
    journal["state"] = "rolled_back"
    journal["rollback_reason"] = reason
    journal["moved_out_of_outputs"] = moved
    try:
        atomic_write_json(dest / JOURNAL, journal)
    except OutputWriteError:
        pass
    shutil.rmtree(staging, ignore_errors=True)
    return {"quarantine": str(dest), "moved_out_of_outputs": moved}


def recover_interrupted_exports(
    layout: OutputLayout, register: CompletionRegister, session_log: SessionLog | None = None
) -> list[RecoveryAction]:
    """Inspect leftover staging folders and roll each forward or back."""
    actions: list[RecoveryAction] = []
    if not layout.staging.exists():
        return actions
    for staging in sorted(p for p in layout.staging.iterdir() if p.is_dir()):
        sid = staging.name
        jpath = staging / JOURNAL
        try:
            journal = json.loads(jpath.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            journal = {"session_id": sid, "files": {}, "state": "unknown"}
            info = _roll_back(layout, staging, journal, reason="journal missing or unreadable")
            actions.append(RecoveryAction(sid, "rolled_back", "Interrupted save without a readable journal", info))
            continue
        state = journal.get("state")
        if state == "complete":
            shutil.rmtree(staging, ignore_errors=True)
            actions.append(RecoveryAction(sid, "cleaned_up", "Removed leftover staging folder of a completed save"))
            continue
        final_dir = Path(journal.get("final_dir", ""))
        all_final_ok = bool(journal.get("files")) and all(
            (final_dir / f["name"]).exists() and sha256_file(final_dir / f["name"]) == f["sha256"]
            for f in journal["files"].values()
        )
        if state in ("files_committed", "committing") and all_final_ok:
            try:
                register.add(journal["register_entry"])
            except Exception as exc:  # leave for the next start-up
                actions.append(RecoveryAction(sid, "unreadable", f"Register update still failing: {exc}"))
                continue
            journal["state"] = "complete"
            _write_journal(staging, journal)
            shutil.rmtree(staging, ignore_errors=True)
            entry = journal.get("register_entry", {})
            actions.append(
                RecoveryAction(
                    sid,
                    "rolled_forward",
                    f"Completed an interrupted save of {entry.get('recording_id')} by {entry.get('annotator_id')}",
                    {"final_dir": str(final_dir)},
                )
            )
        else:
            info = _roll_back(layout, staging, journal, reason=f"interrupted in state {state!r}")
            entry = journal.get("register_entry", {})
            actions.append(
                RecoveryAction(
                    sid,
                    "rolled_back",
                    f"An interrupted save of {entry.get('recording_id', '?')} by {entry.get('annotator_id', '?')} "
                    "was not completed; the recording was NOT marked as complete. The partial files were kept in "
                    f"{info['quarantine']}.",
                    info,
                )
            )
    if session_log is not None:
        for a in actions:
            session_log.write("export_recovery", session_id=a.session_id, action=a.action, message=a.message)
    return actions
