"""The files store: a study folder and an SQLite file (the ElectroTag server's storage).

Results go straight into ElectroTag's usual folders below the study (``Annotated_Events/...``,
``interaction_logs/...``, ``training_progress/...``), written by the desktop application's code, so
``electrotag-agreement`` and ``electrotag-activity`` read them as they are. See
:mod:`electrotag.web.study` for the folder layout. Derived versions (an expert's correction, an
adjudicated version) are saved by the same code into trees of their own below the results folder,
``Annotated_Events/derived/<kind>/``, each with its own completion register, so they are never anyone's
attempt; the saves of every tree are recovered in the same way when the study is opened.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import tempfile
import threading
from collections.abc import Callable
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

from electrotag.app.io.atomic import atomic_write_bytes, atomic_write_json
from electrotag.app.session.register import CompletionRegister, RegisterError
from electrotag.config.settings import Settings
from electrotag.web.accounts import AccountError, AccountExists, Accounts, InvitationProblem
from electrotag.web.store import (
    DERIVED_DIR,
    DERIVED_KINDS,
    RECORD_ID_RE,
    RECORD_KINDS,
    AccountProblem,
    Assignment,
    Credentials,
    Invitation,
    ResultExists,
    SavedResult,
    Store,
    StoreError,
    User,
    attempt_of,
    generated_password,
    index_rows,
    latest_entry,
    page_of,
)
from electrotag.web.study import StudyError, WebStudy

if TYPE_CHECKING:
    from electrotag.training.programme import Progress
    from electrotag.training.reference import ReferenceSet

log = logging.getLogger("electrotag.web")
ATTEMPT_RE = re.compile(r"_attempt-(\d+)$")
SET_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


def _jsonl(obj: dict[str, Any]) -> str:
    from electrotag.app.session.interaction_log import _jsonable

    return json.dumps(_jsonable(obj), ensure_ascii=False, separators=(",", ":")) + "\n"


class FilesStore(Store):
    kind = "files"

    def __init__(self, root: Path | str, *, demo: bool = False) -> None:
        try:
            self.study = WebStudy.open(root)
        except StudyError as exc:
            raise StoreError(str(exc)) from exc
        self.db = Accounts(self.study.db_path)
        self.demo = demo
        self._log_locks: dict[str, threading.Lock] = {}
        self._log_locks_guard = threading.Lock()
        #: What the journalled saves of an earlier run left behind and what was done about it.
        self.recovered = self.recover_interrupted()

    def recover_interrupted(self) -> list[dict[str, Any]]:
        """The desktop's recovery of interrupted saves (``recover_interrupted_exports``), run when the study
        folder is opened and after a save whose register update was interrupted: a save whose files were
        all written and verified is rolled forward (the register is updated), anything else rolled back
        (its files kept in ``.electrotag/interrupted/``). Saves still in progress are left alone."""
        from electrotag.app.session.failures import SessionLog
        from electrotag.app.session.transaction import recover_interrupted_exports
        from electrotag.web import audit

        out = []
        for kind, layout in [("", self.layout)] + [(k, self.derived_layout(k)) for k in DERIVED_KINDS]:
            if not layout.staging.exists():
                continue
            register = CompletionRegister(layout, self.settings.register_lock_timeout_s)
            try:
                actions = recover_interrupted_exports(layout, register, SessionLog(layout))
            except Exception:  # noqa: BLE001 - the study must still open; the next opening tries again
                log.exception("Interrupted saves in %s could not be checked", layout.root)
                continue
            for a in actions:
                out.append({"session_id": a.session_id, "action": a.action, "message": a.message,
                            **({"derived": kind} if kind else {})})
                if a.action in ("rolled_forward", "rolled_back", "rollback_incomplete"):
                    log.warning("Interrupted save %s: %s", a.session_id, a.message)
                    where = {"derived": kind} if kind else {}
                    audit.record(self, "server", "save_recovered", a.message,
                                 {"session_id": a.session_id, "action": a.action, **where})
        return out

    def close(self) -> None:
        self.db.close()

    # ------------------------------------------------------------- the study
    @property
    def root(self) -> Path:
        return self.study.root

    @property
    def study_id(self) -> str:
        return self.study.study_id

    @property
    def name(self) -> str:
        return self.study.name

    @property
    def settings(self) -> Settings:
        return self.study.settings

    @property
    def settings_overrides(self) -> dict[str, Any]:
        return dict(self.study.raw_config.get("settings") or {})

    @property
    def logging_notice(self) -> str:
        return str(self.study.raw_config.get("logging_notice") or "")

    def update_study(self, *, name: str | None = None, overrides: dict[str, Any] | None = None,
                     logging_notice: str | None = None) -> None:
        try:
            self.study.update(name=name, overrides=overrides, logging_notice=logging_notice)
        except StudyError as exc:
            raise ValueError(str(exc)) from exc

    @property
    def layout(self) -> Any:
        return self.study.layout

    def derived_layout(self, kind: str) -> Any:
        """The results tree of one kind of derived version (``Annotated_Events/derived/<kind>``)."""
        from electrotag.app.io.naming import OutputLayout

        if kind not in DERIVED_KINDS:
            raise StoreError(f"Unknown kind of derived version {kind!r}")
        return OutputLayout(self.layout.root / DERIVED_DIR / kind)

    # -------------------------------------------------------------- manifests
    def manifest(self, scope: str, recording_id: str) -> dict[str, Any] | None:
        return self.study.manifests.get(scope, recording_id)

    def manifests(self) -> list[dict[str, Any]]:
        return self.study.manifests.all()

    def manifests_by_fingerprint(self, sha256: str, size: int) -> list[dict[str, Any]]:
        return self.study.manifests.by_fingerprint(sha256, size)

    def add_manifest(self, m: dict[str, Any]) -> None:
        self.study.manifests.add(m)

    def remove_manifest(self, scope: str, recording_id: str) -> None:
        self.study.manifests.remove(scope, recording_id)

    # --------------------------------------------------------- reference sets
    def reference_sets(self) -> list[ReferenceSet]:
        return self.study.reference_sets()

    @staticmethod
    def _set_files(definition: dict[str, Any], files: dict[str, bytes]) -> tuple[str, dict[Path, bytes]]:
        set_id = str(definition["set_id"])
        if not SET_ID_RE.fullmatch(set_id):
            raise StoreError(f"Unsuitable reference set ID {set_id!r}")
        recordings_dir = str(definition.get("recordings_dir") or "")
        out: dict[Path, bytes] = {}
        for rel, data in files.items():
            parts = PurePosixPath(rel).parts
            if (not parts or ".." in parts or PurePosixPath(rel).is_absolute() or rel == "reference_set.json"
                    or (recordings_dir and parts[0] == recordings_dir)):
                raise StoreError(f"Refusing to store {rel!r} with reference set {set_id}")
            out[Path(*parts)] = data
        return set_id, out

    def add_reference_set(self, definition: dict[str, Any], files: dict[str, bytes]) -> None:
        set_id, clean = self._set_files(definition, files)
        folder = self.study.reference_sets_dir / set_id
        for rel, data in clean.items():
            atomic_write_bytes(folder / rel, data)
        atomic_write_json(folder / "reference_set.json", definition)

    def _set_folder(self, set_id: str) -> Path:
        if not SET_ID_RE.fullmatch(str(set_id or "")):
            raise StoreError(f"Unsuitable reference set ID {set_id!r}")
        return self.study.reference_sets_dir / set_id

    def reference_set_payload(self, set_id: str) -> tuple[dict[str, Any], dict[str, bytes]]:
        from electrotag.training.reference import ReferenceSetError
        from electrotag.web.registration import reference_set_payload

        folder = self._set_folder(set_id)
        try:
            return reference_set_payload(folder)
        except ReferenceSetError as exc:
            raise StoreError(str(exc)) from exc

    def put_reference_set(self, definition: dict[str, Any], files: dict[str, bytes]) -> None:
        """Written beside the study, then moved into place, so a reader never sees half a set."""
        set_id, clean = self._set_files(definition, files)
        folder = self.study.reference_sets_dir / set_id
        scratch = self.root / ".electrotag-tmp"
        scratch.mkdir(exist_ok=True)
        new = Path(tempfile.mkdtemp(prefix=f"{set_id}.", dir=scratch))
        try:
            for rel, data in clean.items():
                atomic_write_bytes(new / rel, data)
            atomic_write_json(new / "reference_set.json", definition)
            folder.parent.mkdir(parents=True, exist_ok=True)
            old = None
            if folder.exists():
                old = Path(tempfile.mkdtemp(prefix=f"{set_id}.old.", dir=scratch))
                old.rmdir()
                folder.rename(old)
            new.rename(folder)
            if old is not None:
                shutil.rmtree(old, ignore_errors=True)
        finally:
            if new.exists():
                shutil.rmtree(new, ignore_errors=True)

    def delete_reference_set(self, set_id: str) -> None:
        folder = self._set_folder(set_id)
        if folder.exists():
            scratch = self.root / ".electrotag-tmp"
            scratch.mkdir(exist_ok=True)
            gone = Path(tempfile.mkdtemp(prefix=f"{set_id}.deleted.", dir=scratch))
            gone.rmdir()
            folder.rename(gone)
            shutil.rmtree(gone, ignore_errors=True)
        self.db.delete_quiz_states(set_id)
        self.db.delete_guided_states(set_id)

    # -------------------------------------------------- people and their work
    def user(self, annotator_id: str) -> User | None:
        return self.db.user(annotator_id)

    def users(self) -> list[dict[str, Any]]:
        return self.db.users()

    def user_records(self) -> list[dict[str, Any]]:
        return self.db.user_records()

    def create_account(self, annotator_id: str, *, display_name: str, role: str, email: str,
                       password: str | None, roles: tuple[str, ...] | None = None) -> Credentials:
        temporary = None if password else generated_password()
        try:
            self.db.add_user(annotator_id, password or str(temporary), display_name=display_name, role=role,
                             roles=roles)
        except AccountExists as exc:
            raise AccountProblem("user_exists", f"{annotator_id.upper()} already has an account in this "
                                 "study.") from exc
        except AccountError as exc:
            raise AccountProblem("invalid_user", str(exc), 400) from exc
        if email:
            self.db.update_user(annotator_id, email=email)
        return {"invite_link": None, "temporary_password": temporary}

    def update_account(self, annotator_id: str, *, display_name: str | None = None, role: str | None = None,
                       status: str | None = None, notes: str | None = None,
                       roles: tuple[str, ...] | None = None) -> None:
        try:
            self.db.update_user(annotator_id, display_name=display_name, role=role, notes=notes, roles=roles,
                                disabled=None if status is None else status == "disabled")
        except AccountError as exc:
            raise AccountProblem("invalid_user", str(exc), 400) from exc

    def reset_password(self, annotator_id: str) -> Credentials:
        temporary = generated_password()
        try:
            self.db.set_password(annotator_id, temporary)
        except AccountError as exc:
            raise AccountProblem("invalid_user", str(exc), 400) from exc
        return {"invite_link": None, "temporary_password": temporary}

    def remove_account(self, annotator_id: str) -> None:
        aid = str(annotator_id).upper()
        self.db.delete_user(aid)
        shutil.rmtree(self.study.drafts_dir / f"annotator-{aid}", ignore_errors=True)

    def create_invitation(self, annotator_id: str, *, days: float, by: str) -> Invitation:
        try:
            token, expires = self.db.create_invitation(annotator_id, days=days, by=by)
        except AccountError as exc:
            code = ("disabled" if "switched off" in str(exc) else "admin_account" if "administrator" in str(exc)
                    else "invalid_user")
            raise AccountProblem(code, str(exc), 400 if code == "invalid_user" else 409) from exc
        return {"invite_token": token, "invite_link": None, "expires_at": expires}

    def revoke_invitation(self, annotator_id: str) -> bool:
        return self.db.revoke_invitation(annotator_id)

    def invitations(self) -> dict[str, dict[str, Any]]:
        return self.db.invitations()

    def invitation_for_token(self, token: str) -> dict[str, Any] | None:
        return self.db.invitation_for_token(token)

    def accept_invitation(self, token: str, password: str) -> User:
        try:
            return self.db.accept_invitation(token, password)
        except InvitationProblem as exc:
            raise AccountProblem(f"invite_{exc.reason}", "", 404 if exc.reason == "unknown" else 409) from exc
        except AccountError as exc:
            raise AccountProblem("bad_password", str(exc), 400) from exc

    def assignments(self, annotator_id: str | None = None) -> list[Assignment]:
        return self.db.assignments(annotator_id)

    def assign(self, annotator_id: str, recording_ids: list[str], *, mode: str = "standard",
               context_id: str = "", task_id: str = "") -> int:
        return self.db.assign(annotator_id, recording_ids, mode=mode, context_id=context_id, task_id=task_id)

    def unassign_item(self, annotator_id: str, recording_id: str, mode: str, context_id: str) -> bool:
        return self.db.unassign_item(annotator_id, recording_id, mode, context_id)

    def remove_assignments(self, *, recording_id: str | None = None, context_id: str | None = None,
                           modes: tuple[str, ...] | None = None) -> int:
        return self.db.remove_assignments(recording_id=recording_id, context_id=context_id, modes=modes)

    def programme(self, annotator_id: str) -> str | None:
        return self.db.programme(annotator_id)

    def enrol(self, annotator_id: str, set_id: str | None) -> None:
        if set_id:
            self.db.enrol(annotator_id, set_id)
        else:
            self.db.unenrol(annotator_id)

    # ------------------------------------------------------------------ drafts
    def _draft_path(self, annotator_id: str, key: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{1,64}", key):
            raise StoreError("Unsuitable draft key")
        return self.study.drafts_dir / f"annotator-{annotator_id}" / f"{key}.json"

    def draft(self, annotator_id: str, key: str) -> dict[str, Any] | None:
        try:
            return json.loads(self._draft_path(annotator_id, key).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def draft_keys(self, annotator_id: str) -> set[str]:
        d = self.study.drafts_dir / f"annotator-{annotator_id}"
        return {p.stem for p in d.glob("*.json")} if d.is_dir() else set()

    def put_draft(self, annotator_id: str, key: str, record: dict[str, Any]) -> None:
        atomic_write_json(self._draft_path(annotator_id, key), record)

    def delete_draft(self, annotator_id: str, key: str) -> None:
        self._draft_path(annotator_id, key).unlink(missing_ok=True)

    # ---------------------------------------------------------- guided state
    def guided_state(self, annotator_id: str, set_id: str, recording_id: str) -> dict[str, Any] | None:
        return self.db.guided_state(annotator_id, set_id, recording_id)

    def save_guided_state(self, annotator_id: str, set_id: str, recording_id: str, state: dict[str, Any]) -> None:
        self.db.save_guided_state(annotator_id, set_id, recording_id, state)

    def clear_guided_state(self, annotator_id: str, set_id: str, recording_id: str) -> None:
        self.db.clear_guided_state(annotator_id, set_id, recording_id)

    # ----------------------------------------------------------------- results
    def completion_entries(self, annotator_id: str | None = None) -> list[dict[str, str]]:
        return _register_entries(self.layout, self.settings, annotator_id)

    def save_results(self, make_session: Callable[[Any], Any], *, elapsed_s: float, started_at: str) -> SavedResult:
        return self._save_into(self.layout, make_session, elapsed_s=elapsed_s, started_at=started_at)

    def _save_into(self, layout: Any, make_session: Callable[[Any], Any], *, elapsed_s: float, started_at: str,
                   derived: bool = False) -> SavedResult:
        from electrotag.web.saving import run_session

        session = make_session(layout)
        if derived:
            session.allow_repeat = True  # each derived version of the same work is a new attempt of its tree
        result = run_session(session, elapsed_s=elapsed_s, started_at=started_at)
        files: dict[str, bytes] = {}
        attempt = 1
        if result is not None:
            files = {p.name: p.read_bytes() for p in result.commit.paths.values()}
            m = ATTEMPT_RE.search(result.output_basename)
            attempt = int(m.group(1)) if m else 1
        else:  # the files were written and verified but the register could not be updated: roll it forward now
            self.recover_interrupted()
            entry = next((e for e in _register_entries(layout, self.settings, session.annotator_id)
                          if e.get("session_id") == session.session_id), None)
            if entry is not None:
                files = _files_of(layout.root, entry)
                attempt = attempt_of(entry)
        return SavedResult(session=session, result=result, files=files, attempt=attempt)

    # ------------------------------------------------------- derived versions
    def save_derived(self, kind: str, make_session: Callable[[Any], Any], *, elapsed_s: float,
                     started_at: str) -> SavedResult:
        return self._save_into(self.derived_layout(kind), make_session, elapsed_s=elapsed_s, started_at=started_at,
                               derived=True)

    def derived_entries(self, kind: str, annotator_id: str | None = None) -> list[dict[str, str]]:
        return _register_entries(self.derived_layout(kind), self.settings, annotator_id)

    def derived_files(self, kind: str, annotator_id: str, recording_id: str,
                      attempt: int | None = None) -> dict[str, bytes]:
        mine = [e for e in self.derived_entries(kind, annotator_id) if e.get("recording_id") == recording_id
                and e.get("status") == "completed" and e.get("output_dir") and e.get("output_basename")]
        return _chosen_files(self.derived_layout(kind).root, mine, attempt)

    def progress(self, rs: ReferenceSet, annotator_id: str) -> Progress:
        from electrotag.training.programme import load_progress

        return load_progress(self.layout, rs, annotator_id)

    def competency(self, rs: ReferenceSet, annotator_id: str) -> dict[str, Any]:
        from electrotag.training.assessment import competency_report

        return competency_report(self.layout, rs, annotator_id)

    def report_result(self, set_id: str, annotator_id: str) -> dict[str, str]:
        path = self.layout.root / "training" / set_id / "reports" / f"annotator-{annotator_id}_competency_report.json"
        try:
            rep = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return {"status": str(rep.get("status", "")), "status_text": str(rep.get("status_text", ""))}

    def saved_files(self, annotator_id: str, recording_id: str, mode: str, context_id: str,
                    attempt: int | None = None) -> dict[str, bytes]:
        mine = [e for e in self.completion_entries(annotator_id) if e.get("recording_id") == recording_id
                and e.get("mode", "standard") == mode and e.get("context", "") == (context_id if mode != "standard"
                                                                                     else "")
                and e.get("status") == "completed" and e.get("output_dir") and e.get("output_basename")]
        return _chosen_files(self.layout.root, mine, attempt)

    def results_tree(self, dest: Path, *, logs: bool = False, annotator_ids: set[str] | None = None,
                     modes: set[str] | None = None) -> Path:
        return self.layout.root

    def put_result_file(self, rel_path: str, data: bytes) -> None:
        path = _inside(self.layout.root, rel_path)
        if path.exists():
            raise ResultExists(f"{rel_path} has already been saved")
        try:
            atomic_write_bytes(path, data, overwrite=False)
        except OSError as exc:
            if path.exists():
                raise ResultExists(f"{rel_path} has already been saved") from exc
            raise

    # ------------------------------------------- the annotator's own record (games)
    def annotator_record(self, annotator_id: str) -> dict[str, Any]:
        return self.db.annotator_record(annotator_id)

    def annotator_records(self) -> dict[str, dict[str, Any]]:
        return self.db.annotator_records()

    def update_annotator_record(self, annotator_id: str,
                                change: Callable[[dict[str, Any]], dict[str, Any] | None]) -> dict[str, Any]:
        return self.db.update_annotator_record(annotator_id, change)

    def study_secret(self, name: str) -> str:
        return self.db.study_secret(name)

    # ------------------------------------------- problem reports and reviews
    def records(self, kind: str, annotator_id: str | None = None) -> list[dict[str, Any]]:
        _check_kind(kind)
        return self.db.records(kind, annotator_id)

    def update_record(self, kind: str, record_id: str, annotator_id: str,
                      change: Callable[[dict[str, Any] | None], dict[str, Any] | None]) -> dict[str, Any] | None:
        _check_kind(kind, record_id)
        return self.db.update_record(kind, record_id, annotator_id, change)

    # ------------------------------------------------------------------- quiz
    def quiz_state(self, annotator_id: str, set_id: str) -> dict[str, Any] | None:
        return self.db.quiz_state(annotator_id, set_id)

    def update_quiz_state(self, annotator_id: str, set_id: str,
                          change: Callable[[dict[str, Any] | None], dict[str, Any] | None]) -> dict[str, Any] | None:
        return self.db.update_quiz_state(annotator_id, set_id, change)

    # ------------------------------------------------------------------ audit
    def audit_append(self, entry: dict[str, Any]) -> None:
        self.db.audit_append(entry)

    def audit_page(self, before: str | None, limit: int) -> tuple[list[dict[str, Any]], str | None]:
        try:
            return self.db.audit_page(before, limit)
        except AccountError as exc:
            raise StoreError(str(exc)) from exc

    # ----------------------------------------------------------------- visits
    def _log_lock(self, visit_id: str) -> threading.Lock:
        with self._log_locks_guard:
            return self._log_locks.setdefault(visit_id, threading.Lock())

    def visit_open(self, visit_id: str, annotator_id: str, mode: str, context_id: str, header: dict[str, Any],
                   started: datetime) -> None:
        path = self.layout.visit_log_path(annotator_id, mode, started)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "x", encoding="utf-8") as fh:
            fh.write(_jsonl(header))
        self.db.open_visit(visit_id, annotator_id, path, mode, context_id)

    def visit(self, visit_id: str) -> dict[str, Any] | None:
        v = self.db.visit(visit_id)
        if v is None:
            return None
        return {"annotator_id": v["annotator_id"], "closed": bool(v["closed_at"]), "last_t": float(v["last_t"]),
                "opened_at": v["opened_at"], "seq": int(v["seq"]), "path": v["path"]}

    def visit_append(self, visit_id: str, events: list[dict[str, Any]]) -> int:
        if not events:
            return 0
        v = self.db.visit(visit_id)
        if v is None:
            raise StoreError(f"Unknown visit {visit_id}")
        with self._log_lock(visit_id):
            first = self.db.advance_visit(visit_id, len(events), max(float(e.get("t", 0.0)) for e in events))
            numbered = [{"seq": first + k, **e} for k, e in enumerate(events)]
            text = "".join(_jsonl(e) for e in numbered)
            with open(v["path"], "a", encoding="utf-8") as fh:
                fh.write(text)
            self.db.index_visit(visit_id, numbered, v["context_id"])
        return len(events)

    def visit_close(self, visit_id: str, event: dict[str, Any]) -> None:
        self.visit_append(visit_id, [event])
        self.db.close_visit(visit_id)

    def visit_records(self, annotator_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        return [{"visit_id": v["visit_id"], "annotator_id": v["annotator_id"], "mode": v["mode"],
                 "context_id": v["context_id"], "started_at": v["opened_at"], "closed_at": v["closed_at"] or None,
                 "n_events": int(v["seq"])} for v in self.db.visit_rows(annotator_id, limit)]

    def _read_log(self, visit_id: str) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
        """(the visit's row, its header, its numbered events) read from its JSON Lines file."""
        v = self.db.visit(visit_id)
        if v is None:
            raise StoreError(f"Unknown visit {visit_id}")
        header: dict[str, Any] = {}
        events: list[dict[str, Any]] = []
        with self._log_lock(visit_id):
            try:
                text = Path(v["path"]).read_text(encoding="utf-8")
            except OSError as exc:
                raise StoreError(f"The log of visit {visit_id} cannot be read") from exc
        for line in text.splitlines():
            try:
                obj = json.loads(line)
            except ValueError:
                continue  # a line cut short by a crash: the rest of the log is still read
            if not isinstance(obj, dict):
                continue
            if obj.get("type") == "header" and "seq" not in obj:
                header = obj
            elif isinstance(obj.get("seq"), int):
                events.append(obj)
        return v, header, events

    def visit_log(self, visit_id: str, *, from_seq: int = 0, limit: int = 4000) -> dict[str, Any]:
        _v, header, events = self._read_log(visit_id)
        page, nxt = page_of(events, int(from_seq), int(limit))
        return {"header": header, "events": page, "next_seq": nxt}

    def visit_index(self, visit_id: str) -> list[dict[str, Any]]:
        rows = self.db.visit_index_rows(visit_id)
        if rows is not None:
            return rows
        v, _header, events = self._read_log(visit_id)  # a visit opened before the index existed
        return index_rows([], events, v["context_id"])


def _register_entries(layout: Any, settings: Settings, annotator_id: str | None) -> list[dict[str, str]]:
    try:
        entries = CompletionRegister(layout, settings.register_lock_timeout_s).entries()
    except RegisterError:
        return []
    return [e for e in entries if annotator_id is None or e.get("annotator_id") == annotator_id]


def _files_of(root: Path, entry: dict[str, str]) -> dict[str, bytes]:
    """The result files of one register row (those that exist)."""
    from electrotag.app.io.naming import OUTPUT_SUFFIXES

    folder = _inside(root, entry["output_dir"])
    out = {}
    for suffix in OUTPUT_SUFFIXES.values():
        p = folder / f"{entry['output_basename']}{suffix}"
        if p.is_file():
            out[p.name] = p.read_bytes()
    return out


def _chosen_files(root: Path, entries: list[dict[str, str]], attempt: int | None) -> dict[str, bytes]:
    """The files of the latest of ``entries`` by attempt number (a revision is always the latest), or of
    attempt ``attempt``; {} when there is none."""
    if attempt is not None:
        entries = [e for e in entries if attempt_of(e) == int(attempt)]
    if not entries:
        return {}
    return _files_of(root, latest_entry(entries))


def _check_kind(kind: str, record_id: str | None = None) -> None:
    if kind not in RECORD_KINDS or (record_id is not None and not RECORD_ID_RE.match(str(record_id))):
        raise StoreError(f"Unsuitable record {kind!r} {record_id!r}")


def _inside(root: Path, rel: str) -> Path:
    """``root / rel``, refusing anything that would leave ``root``."""
    parts = PurePosixPath(str(rel)).parts
    if not parts or ".." in parts or PurePosixPath(str(rel)).is_absolute() or "\\" in str(rel):
        raise StoreError(f"Refusing a path outside the results folder: {rel!r}")
    return root.joinpath(*parts)
