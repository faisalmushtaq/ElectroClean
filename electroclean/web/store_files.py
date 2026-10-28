"""The files store: a study folder and an SQLite file (the ElectroClean server's storage).

Results go straight into ElectroClean's usual folders below the study (``Annotated_Events/...``,
``interaction_logs/...``, ``training_progress/...``), written by the desktop application's code, so
``electroclean-agreement`` and ``electroclean-activity`` read them as they are. See
:mod:`electroclean.web.study` for the folder layout.
"""

from __future__ import annotations

import json
import re
import threading
from collections.abc import Callable
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

from electroclean.app.io.atomic import atomic_write_bytes, atomic_write_json
from electroclean.app.session.register import CompletionRegister, RegisterError
from electroclean.config.settings import Settings
from electroclean.web.accounts import Accounts
from electroclean.web.store import Assignment, SavedResult, Store, StoreError, User
from electroclean.web.study import StudyError, WebStudy

if TYPE_CHECKING:
    from electroclean.training.programme import Progress
    from electroclean.training.reference import ReferenceSet

ATTEMPT_RE = re.compile(r"_attempt-(\d+)$")


def _jsonl(obj: dict[str, Any]) -> str:
    from electroclean.app.session.interaction_log import _jsonable

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
    def layout(self) -> Any:
        return self.study.layout

    # -------------------------------------------------------------- manifests
    def manifest(self, scope: str, recording_id: str) -> dict[str, Any] | None:
        return self.study.manifests.get(scope, recording_id)

    def manifests(self) -> list[dict[str, Any]]:
        return self.study.manifests.all()

    def manifests_by_fingerprint(self, sha256: str, size: int) -> list[dict[str, Any]]:
        return self.study.manifests.by_fingerprint(sha256, size)

    def add_manifest(self, m: dict[str, Any]) -> None:
        self.study.manifests.add(m)

    # --------------------------------------------------------- reference sets
    def reference_sets(self) -> list[ReferenceSet]:
        return self.study.reference_sets()

    def add_reference_set(self, definition: dict[str, Any], files: dict[str, bytes]) -> None:
        set_id = str(definition["set_id"])
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", set_id):
            raise StoreError(f"Unsuitable reference set ID {set_id!r}")
        folder = self.study.reference_sets_dir / set_id
        recordings_dir = str(definition.get("recordings_dir") or "")
        for rel, data in files.items():
            parts = PurePosixPath(rel).parts
            if not parts or ".." in parts or PurePosixPath(rel).is_absolute() or (recordings_dir and parts[0] == recordings_dir):
                raise StoreError(f"Refusing to store {rel!r} with reference set {set_id}")
            atomic_write_bytes(folder / Path(*parts), data)
        atomic_write_json(folder / "reference_set.json", definition)

    # -------------------------------------------------- people and their work
    def user(self, annotator_id: str) -> User | None:
        return self.db.user(annotator_id)

    def users(self) -> list[dict[str, Any]]:
        return self.db.users()

    def assignments(self, annotator_id: str | None = None) -> list[Assignment]:
        return self.db.assignments(annotator_id)

    def assign(self, annotator_id: str, recording_ids: list[str], *, mode: str = "standard",
               context_id: str = "") -> int:
        return self.db.assign(annotator_id, recording_ids, mode=mode, context_id=context_id)

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
        try:
            entries = CompletionRegister(self.layout, self.settings.register_lock_timeout_s).entries()
        except RegisterError:
            return []
        return [e for e in entries if annotator_id is None or e.get("annotator_id") == annotator_id]

    def save_results(self, make_session: Callable[[Any], Any], *, elapsed_s: float, started_at: str) -> SavedResult:
        from electroclean.web.saving import run_session

        session = make_session(self.layout)
        result = run_session(session, elapsed_s=elapsed_s, started_at=started_at)
        files: dict[str, bytes] = {}
        attempt = 1
        if result is not None:
            files = {p.name: p.read_bytes() for p in result.commit.paths.values()}
            m = ATTEMPT_RE.search(result.output_basename)
            attempt = int(m.group(1)) if m else 1
        return SavedResult(session=session, result=result, files=files, attempt=attempt)

    def progress(self, rs: ReferenceSet, annotator_id: str) -> Progress:
        from electroclean.training.programme import load_progress

        return load_progress(self.layout, rs, annotator_id)

    def competency(self, rs: ReferenceSet, annotator_id: str) -> dict[str, Any]:
        from electroclean.training.assessment import competency_report

        return competency_report(self.layout, rs, annotator_id)

    def report_text(self, set_id: str, annotator_id: str) -> str:
        path = self.layout.root / "training" / set_id / "reports" / f"annotator-{annotator_id}_competency_report.json"
        try:
            return str(json.loads(path.read_text(encoding="utf-8")).get("status_text", ""))
        except (OSError, ValueError):
            return ""

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
            text = "".join(_jsonl({"seq": first + k, **e}) for k, e in enumerate(events))
            with open(v["path"], "a", encoding="utf-8") as fh:
                fh.write(text)
        return len(events)

    def visit_close(self, visit_id: str, event: dict[str, Any]) -> None:
        self.visit_append(visit_id, [event])
        self.db.close_visit(visit_id)
