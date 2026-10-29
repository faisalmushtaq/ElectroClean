"""Crash-safe commit of a session's output files.

Saving a session is a small transaction recorded in a journal file
(``transaction.json``) inside ``.electrotag/staging/<session_id>/``:

1. ``staging``    all output files are written (atomically) into the staging folder;
2. ``validated``  the staged files are read back and validated;
3. ``committing`` each file is moved into its final folder (same file system,
   so each move is atomic, and a move never replaces an existing file) and
   its checksum is re-verified;
4. ``files_committed`` all final files are in place and verified;
5. the completion register is updated;
6. ``complete``   the staging folder is removed.

While a save is in progress its session holds ``staging/<session_id>.lock``.

If ElectroTag stops at any point, :func:`recover_interrupted_exports` (run
at start-up) inspects the journals, skipping any save whose lock is still held
by a running session (another window, or another computer on the same
network drive). A transaction that reached ``files_committed``, or that was
``committing`` and whose final files are all present and verified, is rolled
forward (the register is updated, because the annotator did press Save and
Finish and every file was validated). Anything else is rolled back: files
already moved are taken out of the output folders and, together with the
staged files, kept in ``.electrotag/interrupted/`` for manual inspection. If
a file cannot be moved back (for example because it is open in another
program), the journal is kept and the roll-back is retried at the next start.
A recording is therefore never marked complete unless all of its outputs
exist and match their verified checksums.

The journal records the final folder relative to the output folder, so a
results folder reached through another drive letter or mount point (or
moved) is still recovered correctly.
"""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from electrotag.app.common import now_local_iso
from electrotag.app.io.atomic import (
    OutputWriteError,
    atomic_write_bytes,
    atomic_write_json,
    check_free_space,
    fsync_directory,
    move_no_clobber,
    sha256_bytes,
    sha256_file,
)
from electrotag.app.io.locking import FileLock, LockError
from electrotag.app.io.naming import OutputLayout
from electrotag.app.session.failures import SessionLog
from electrotag.app.session.register import CompletionRegister

JOURNAL = "transaction.json"
#: A save lock older than this (without its process being visibly alive) is stale.
SAVE_LOCK_STALE_S = 600.0


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
    action: str  # "rolled_forward", "rolled_back", "rollback_incomplete", "cleaned_up", "in_progress", "unreadable"
    message: str
    details: dict[str, Any] = field(default_factory=dict)


def _write_journal(staging: Path, journal: dict[str, Any]) -> None:
    journal["updated_at"] = now_local_iso()
    atomic_write_json(staging / JOURNAL, journal)


def save_lock(layout: OutputLayout, session_id: str) -> FileLock:
    return FileLock(
        layout.staging / f"{session_id}.lock", {"purpose": "saving", "session_id": session_id},
        stale_after_s=SAVE_LOCK_STALE_S,
    )


def _final_dir(layout: OutputLayout, journal: dict[str, Any]) -> Path:
    rel = journal.get("final_dir_rel")
    if rel is not None:
        return layout.root / rel
    return Path(journal.get("final_dir", ""))


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
    lock = save_lock(layout, session_id)
    try:
        lock.acquire(timeout_s=0)
    except (LockError, OSError) as exc:
        raise ExportCommitError(f"Another save of session {session_id} is in progress ({exc})") from exc
    try:
        return _commit(layout, session_id, final_dir, files, validate, register, register_entry, fault)
    finally:
        lock.release()


def _commit(
    layout: OutputLayout,
    session_id: str,
    final_dir: Path,
    files: dict[str, tuple[str, bytes]],
    validate: Callable[[dict[str, bytes]], None],
    register: CompletionRegister,
    register_entry: dict[str, Any],
    fault: FaultHook | None,
) -> CommitResult:
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
    try:
        final_rel: str | None = final_dir.relative_to(layout.root).as_posix()
    except ValueError:
        final_rel = None
    journal: dict[str, Any] = {
        "session_id": session_id,
        "state": "staging",
        "created_at": now_local_iso(),
        "final_dir": str(final_dir),
        "final_dir_rel": final_rel,
        "files": {k: {"name": name, "sha256": sha256_bytes(b)} for k, (name, b) in files.items()},
        "register_entry": register_entry,
    }
    if final_rel is None:
        del journal["final_dir_rel"]
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
            try:
                move_no_clobber(staging / name, target)
            except FileExistsError:
                raise ExportCommitError(f"Output file appeared while saving: {target}") from None
        fsync_directory(final_dir)
        hook("verify")
        for key, target in final_paths.items():
            if sha256_file(target) != journal["files"][key]["sha256"]:
                raise ExportCommitError(f"Final file {target.name} does not match its verified checksum")
        journal["state"] = "files_committed"
        _write_journal(staging, journal)
    except Exception as exc:
        # Undo the partial commit so that no incomplete output set is left behind.
        info = _roll_back(layout, staging, journal, reason=f"commit failed: {exc}")
        extra = ""
        if info.get("not_moved"):
            extra = (
                " Some files could not be moved out of the results folder ("
                + ", ".join(info["not_moved"])
                + "); ElectroTag will retry the next time it starts."
            )
        if isinstance(exc, ExportCommitError):
            raise ExportCommitError(str(exc) + extra) from exc
        raise ExportCommitError(f"Outputs could not be moved into place: {exc}.{extra}") from exc

    try:
        hook("register")
        updated = register.add(register_entry)
    except Exception as exc:
        raise ExportCommitError(
            "Your annotations were saved and verified, but the completion register could not be updated "
            f"({exc}). ElectroTag will finish this automatically the next time it starts.",
            committed=True,
        ) from exc
    # The outputs are final and registered. Failing to tidy up the journal does not change
    # that: recovery finds "files_committed", re-adds the (identical) register row and cleans up.
    try:
        hook("cleanup")
        journal["state"] = "complete"
        _write_journal(staging, journal)
    except Exception:
        pass
    shutil.rmtree(staging, ignore_errors=True)
    return CommitResult(
        final_dir=final_dir,
        paths=final_paths,
        sha256={k: v["sha256"] for k, v in journal["files"].items()},
        register_updated=updated,
    )


def _roll_back(layout: OutputLayout, staging: Path, journal: dict[str, Any], reason: str) -> dict[str, Any]:
    """Move committed final files back out of the output folders, and keep everything staged.

    Every file is moved into ``.electrotag/interrupted/<session>/``; nothing
    is deleted. If a committed file cannot be moved, the journal is kept (state
    ``rollback_incomplete``) so that the next start-up retries.
    """
    session_id = journal.get("session_id", staging.name)
    dest = layout.quarantine / session_id
    dest.mkdir(parents=True, exist_ok=True)
    moved: list[str] = []
    not_moved: list[str] = []
    final_dir = _final_dir(layout, journal)
    for _key, info in journal.get("files", {}).items():
        name = info["name"]
        final = final_dir / name
        try:
            ours = final.exists() and sha256_file(final) == info["sha256"]
        except OSError:  # exists but cannot be read now: try again later
            not_moved.append(name)
            continue
        if ours:
            try:
                os.replace(final, dest / name)
                moved.append(name)
            except OSError:
                not_moved.append(name)
    # Keep every staged file (named in the journal or not, e.g. when the journal is unreadable).
    if staging.exists():
        for f in sorted(staging.iterdir()):
            if f.is_file() and f.name != JOURNAL:
                target = dest / f.name
                if target.exists():
                    target = dest / f"staged-{f.name}"
                try:
                    os.replace(f, target)
                except OSError:
                    pass
        unreadable_journal = staging / JOURNAL
        if not journal.get("files") and unreadable_journal.exists():
            try:
                shutil.copy2(unreadable_journal, dest / "transaction-unreadable.json")
            except OSError:
                pass
    journal["rollback_reason"] = reason
    journal["moved_out_of_outputs"] = sorted(set(journal.get("moved_out_of_outputs", [])) | set(moved))
    if not_moved:
        journal["state"] = "rollback_incomplete"
        journal["not_moved"] = not_moved
        try:
            _write_journal(staging, journal)
        except OutputWriteError:
            pass
        return {"quarantine": str(dest), "moved_out_of_outputs": moved, "not_moved": not_moved}
    journal["state"] = "rolled_back"
    try:
        atomic_write_json(dest / JOURNAL, journal)
    except OutputWriteError:
        pass
    shutil.rmtree(staging, ignore_errors=True)
    return {"quarantine": str(dest), "moved_out_of_outputs": moved, "not_moved": []}


def recover_interrupted_exports(
    layout: OutputLayout, register: CompletionRegister, session_log: SessionLog | None = None
) -> list[RecoveryAction]:
    """Inspect leftover staging folders and roll each forward or back.

    Saves still in progress in another running session are left alone.
    """
    actions: list[RecoveryAction] = []
    if not layout.staging.exists():
        return actions
    for staging in sorted(p for p in layout.staging.iterdir() if p.is_dir()):
        sid = staging.name
        lock = save_lock(layout, sid)
        try:
            lock.acquire(timeout_s=0)
        except (LockError, OSError):
            actions.append(RecoveryAction(sid, "in_progress", "A save is in progress in another session; left alone"))
            continue
        try:
            if staging.exists():
                actions.append(_recover_one(layout, register, staging))
        finally:
            lock.release()
    if session_log is not None:
        for a in actions:
            if a.action != "in_progress":
                session_log.write("export_recovery", session_id=a.session_id, action=a.action, message=a.message)
    return actions


def _recover_one(layout: OutputLayout, register: CompletionRegister, staging: Path) -> RecoveryAction:
    sid = staging.name
    jpath = staging / JOURNAL
    try:
        journal = json.loads(jpath.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        journal = {"session_id": sid, "files": {}, "state": "unknown"}
        info = _roll_back(layout, staging, journal, reason="journal missing or unreadable")
        return RecoveryAction(
            sid, "rolled_back",
            f"An interrupted save without a readable journal was found; its files were kept in {info['quarantine']}.",
            info,
        )
    state = journal.get("state")
    if state == "complete":
        shutil.rmtree(staging, ignore_errors=True)
        return RecoveryAction(sid, "cleaned_up", "Removed leftover staging folder of a completed save")
    final_dir = _final_dir(layout, journal)

    def final_ok(f: dict[str, Any]) -> bool:
        path = final_dir / f["name"]
        try:
            return path.exists() and sha256_file(path) == f["sha256"]
        except OSError:
            return False

    all_final_ok = bool(journal.get("files")) and all(final_ok(f) for f in journal["files"].values())
    entry = journal.get("register_entry", {})
    if state in ("files_committed", "committing") and all_final_ok:
        try:
            register.add(entry)
        except Exception as exc:  # leave for the next start-up
            return RecoveryAction(sid, "unreadable", f"Register update still failing: {exc}")
        journal["state"] = "complete"
        try:
            _write_journal(staging, journal)
        except OutputWriteError:
            pass
        shutil.rmtree(staging, ignore_errors=True)
        return RecoveryAction(
            sid,
            "rolled_forward",
            f"Completed an interrupted save of {entry.get('recording_id')} by {entry.get('annotator_id')}",
            {"final_dir": str(final_dir)},
        )
    info = _roll_back(layout, staging, journal, reason=f"interrupted in state {state!r}")
    who = f"{entry.get('recording_id', '?')} by {entry.get('annotator_id', '?')}"
    if info["not_moved"]:
        return RecoveryAction(
            sid,
            "rollback_incomplete",
            f"An interrupted save of {who} was not completed and the recording was NOT marked as complete. "
            f"These files could not be moved out of the results folder and will be retried next time: "
            f"{', '.join(info['not_moved'])} (close any program that has them open).",
            info,
        )
    return RecoveryAction(
        sid,
        "rolled_back",
        f"An interrupted save of {who} was not completed; the recording was NOT marked as complete. "
        f"The partial files were kept in {info['quarantine']}.",
        info,
    )
