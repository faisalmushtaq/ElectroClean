"""The Firestore store: a study's records as Firestore documents (used by the Firebase functions).

Everything lives under ``studies/{study_id}``::

    studies/{study}                         name, settings (the overrides of electroclean_study.json)
        manifests/{key}                     one per registered recording (packed), with its fingerprint
        reference_sets/{set_id}             a training reference set and its reference files (packed)
        users/{annotator_id}                display name, role, the Firebase Authentication user
        assignments/{annotator_id}          the annotator's recordings and training programme
        drafts/{annotator_id}_{key}         unfinished work (packed)
        guided/{annotator_id}_{set}_{key}   where a trainee is in a guided recording
        submissions/{annotator_id}_{key}_{attempt}   a saved recording: its register row and its files
        progress/{set}_{annotator_id}       stars, scores and times (training_progress)
        reports/{set}_{annotator_id}        the competency report
        visits/{visit_id}                   a visit's log header; its events in visits/{id}/batches/{seq}

Saving runs the desktop application's own code (:class:`~electroclean.web.saving.WebSession`) into a
scratch folder and keeps the files it wrote in the submission document, so ``electroclean-web
export`` (:func:`export_study`) can put exactly those files into ElectroClean's usual folders.
Large values are kept compressed (zlib JSON), split over several documents when they would not fit
in one (Firestore allows about 1 MiB per document).

Clients never read or write these documents (firestore.rules denies everything); only the
functions and the administrator's command do, with the Admin SDK.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import shutil
import tempfile
import threading
import time
import zlib
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from electroclean import __version__
from electroclean.app.common import now_local_iso
from electroclean.web.errors import ApiError
from electroclean.web.manifest import SCHEMA as MANIFEST_SCHEMA
from electroclean.web.manifest import SCHEMA_VERSION as MANIFEST_VERSION
from electroclean.web.manifest import fingerprint_of, manifest_key
from electroclean.web.store import (
    MODES,
    ROLES,
    Assignment,
    SavedResult,
    Store,
    StoreError,
    User,
    item_key,
    settings_from_overrides,
)

if TYPE_CHECKING:
    from electroclean.config.settings import Settings
    from electroclean.training.programme import Progress
    from electroclean.training.reference import ReferenceSet

STUDY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
ID_RE = re.compile(r"^[A-Z0-9][A-Z0-9_-]{0,31}$")
BLOB_LIMIT = 900_000  # bytes kept in one document before splitting
CACHE_S = 30.0


def pack(obj: Any) -> bytes:
    return zlib.compress(json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8"), 6)


def unpack(data: bytes) -> Any:
    return json.loads(zlib.decompress(data).decode("utf-8"))


def _batches(events: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Split numbered events into parts that each fit in one document."""
    if len(events) <= 1 or len(pack(events)) <= BLOB_LIMIT:
        return [events]
    half = len(events) // 2
    return _batches(events[:half]) + _batches(events[half:])


def _short(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()[:16]


class FirestoreStore(Store):
    kind = "firestore"

    def __init__(self, client: Any, study_id: str, *, cache_dir: Path | None = None) -> None:
        if not STUDY_ID_RE.match(study_id or ""):
            raise StoreError(f"Unsuitable study ID {study_id!r}")
        self.client = client
        self._study_id = study_id
        self.doc = client.collection("studies").document(study_id)
        self.cache_dir = Path(cache_dir or Path(tempfile.gettempdir()) / "electroclean-firestore") / study_id
        self._study_cache: tuple[float, dict[str, Any]] | None = None
        self._settings_cache: tuple[str, Settings] | None = None
        self._sets_cache: tuple[float, list[ReferenceSet]] | None = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------- the study
    @classmethod
    def create_study(cls, client: Any, study_id: str, *, name: str = "", settings: dict[str, Any] | None = None,
                     exist_ok: bool = False) -> FirestoreStore:
        store = cls(client, study_id)
        settings_from_overrides(settings)  # check them before saving
        snap = store.doc.get()
        if snap.exists and not exist_ok:
            raise StoreError(f"The study {study_id} already exists in this Firebase project")
        data = {"study_id": study_id, "name": name or study_id, "settings_json": json.dumps(settings or {}),
                "electroclean_version": __version__, "updated_at": now_local_iso()}
        if not snap.exists:
            data["created_at"] = now_local_iso()
        store.doc.set(data, merge=True)
        return store

    def _study(self) -> dict[str, Any]:
        now = time.monotonic()
        if self._study_cache is None or now - self._study_cache[0] > CACHE_S:
            snap = self.doc.get()
            if not snap.exists:
                raise StoreError(f"There is no study {self._study_id} in this Firebase project "
                                 "(create it with 'electroclean-web init-study')")
            self._study_cache = (now, snap.to_dict() or {})
        return self._study_cache[1]

    @property
    def study_id(self) -> str:
        return self._study_id

    @property
    def name(self) -> str:
        return str(self._study().get("name") or self._study_id)

    @property
    def settings_overrides(self) -> dict[str, Any]:
        return json.loads(self._study().get("settings_json") or "{}")

    @property
    def settings(self) -> Settings:
        raw = self._study().get("settings_json") or "{}"
        if self._settings_cache is None or self._settings_cache[0] != raw:
            self._settings_cache = (raw, settings_from_overrides(json.loads(raw)))
        return self._settings_cache[1]

    def update_settings(self, overrides: dict[str, Any]) -> None:
        settings_from_overrides(overrides)
        self.doc.set({"settings_json": json.dumps(overrides), "updated_at": now_local_iso()}, merge=True)
        self._study_cache = None

    # --------------------------------------------------------------- blobs
    def _put_blob(self, ref: Any, fields: dict[str, Any], payload: Any, *, create: bool = False,
                  transaction: Any = None) -> None:
        data = pack(payload)
        if len(data) <= BLOB_LIMIT:
            doc = {**fields, "blob": data, "chunks": 0}
            self._write(ref, doc, create=create, transaction=transaction)
            return
        parts = [data[i:i + BLOB_LIMIT] for i in range(0, len(data), BLOB_LIMIT)]
        for i, part in enumerate(parts):  # the chunks first, so the document never points to missing ones
            ref.collection("chunks").document(f"{i:04d}").set({"data": part})
        self._write(ref, {**fields, "blob": None, "chunks": len(parts)}, create=create, transaction=transaction)

    @staticmethod
    def _write(ref: Any, doc: dict[str, Any], *, create: bool, transaction: Any) -> None:
        if transaction is not None:
            (transaction.create if create else transaction.set)(ref, doc)
        elif create:
            ref.create(doc)
        else:
            ref.set(doc)

    @staticmethod
    def _get_blob(snap: Any) -> Any:
        d = snap.to_dict() or {}
        if d.get("chunks"):
            parts = [c.to_dict()["data"] for c in snap.reference.collection("chunks").order_by("__name__").stream()]
            return unpack(b"".join(parts[: int(d["chunks"])]))
        return unpack(d["blob"]) if d.get("blob") is not None else None

    @staticmethod
    def _delete(ref: Any) -> None:
        for c in ref.collection("chunks").stream():
            c.reference.delete()
        ref.delete()

    # -------------------------------------------------------------- manifests
    def manifest(self, scope: str, recording_id: str) -> dict[str, Any] | None:
        snap = self.doc.collection("manifests").document(manifest_key(scope, recording_id)).get()
        return self._get_blob(snap) if snap.exists else None

    def manifests(self) -> list[dict[str, Any]]:
        return [self._get_blob(s) for s in self.doc.collection("manifests").stream()]

    def manifests_by_fingerprint(self, sha256: str, size: int) -> list[dict[str, Any]]:
        from google.cloud.firestore_v1.base_query import FieldFilter

        q = self.doc.collection("manifests").where(filter=FieldFilter("fp_sha256", "==", (sha256 or "").lower()))
        out = [self._get_blob(s) for s in q.stream()]
        return [m for m in out if fingerprint_of(m) == ((sha256 or "").lower(), int(size))]

    def add_manifest(self, m: dict[str, Any]) -> None:
        if m.get("schema") != MANIFEST_SCHEMA or "recording_id" not in m or "scope" not in m:
            raise StoreError("Not an ElectroClean web manifest")
        if str(m.get("schema_version", "")).split(".")[0] != MANIFEST_VERSION.split(".")[0]:
            raise StoreError(f"Manifest version {m.get('schema_version')} is not supported")
        sha, size = fingerprint_of(m)
        ref = self.doc.collection("manifests").document(manifest_key(m["scope"], m["recording_id"]))
        self._put_blob(ref, {"scope": m["scope"], "recording_id": m["recording_id"], "file_name": m["file_name"],
                             "fp_sha256": sha, "fp_size": size, "registered_at": now_local_iso()}, m)

    # --------------------------------------------------------- reference sets
    def reference_sets(self) -> list[ReferenceSet]:
        from electroclean.training.reference import ReferenceSet, ReferenceSetError

        now = time.monotonic()
        with self._lock:
            if self._sets_cache is not None and now - self._sets_cache[0] < CACHE_S:
                return self._sets_cache[1]
            out = []
            for snap in self.doc.collection("reference_sets").stream():
                d = snap.to_dict() or {}
                folder = self.cache_dir / "reference_sets" / f"{snap.id}-{d.get('digest', 'x')[:16]}"
                if not (folder / "reference_set.json").is_file():
                    payload = self._get_blob(snap)
                    tmp = folder.with_name(folder.name + f".tmp{time.monotonic_ns()}")
                    for rel, b64 in payload["files"].items():
                        dest = tmp / rel
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        dest.write_bytes(base64.b64decode(b64))
                    (tmp / "reference_set.json").write_text(json.dumps(payload["definition"], indent=2),
                                                            encoding="utf-8")
                    if folder.exists():
                        shutil.rmtree(tmp, ignore_errors=True)
                    else:
                        tmp.rename(folder)
                try:
                    out.append(ReferenceSet.load(folder))
                except ReferenceSetError:
                    continue
            out.sort(key=lambda rs: rs.set_id)
            self._sets_cache = (now, out)
            return out

    def add_reference_set(self, definition: dict[str, Any], files: dict[str, bytes]) -> None:
        set_id = str(definition["set_id"])
        if not STUDY_ID_RE.match(set_id):
            raise StoreError(f"Unsuitable reference set ID {set_id!r}")
        recordings_dir = str(definition.get("recordings_dir") or "")
        clean: dict[str, str] = {}
        for rel, data in sorted(files.items()):
            parts = Path(rel).parts
            if not parts or ".." in parts or Path(rel).is_absolute() or (recordings_dir and parts[0] == recordings_dir):
                raise StoreError(f"Refusing to store {rel!r} with reference set {set_id}")
            clean[Path(rel).as_posix()] = base64.b64encode(data).decode("ascii")
        payload = {"definition": definition, "files": clean}
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        ref = self.doc.collection("reference_sets").document(set_id)
        self._put_blob(ref, {"set_id": set_id, "name": definition.get("name", ""), "digest": digest,
                             "updated_at": now_local_iso()}, payload)
        self._sets_cache = None

    # -------------------------------------------------- people and their work
    def user(self, annotator_id: str) -> User | None:
        aid = str(annotator_id or "").upper()
        if not ID_RE.match(aid):
            return None
        snap = self.doc.collection("users").document(aid).get()
        if not snap.exists:
            return None
        d = snap.to_dict() or {}
        if d.get("disabled"):
            return None
        return User(aid, str(d.get("display_name", "")), str(d.get("role", "annotator")))

    def users(self) -> list[dict[str, Any]]:
        out = []
        for s in self.doc.collection("users").stream():
            d = s.to_dict() or {}
            if not d.get("disabled"):
                out.append({"annotator_id": s.id, "display_name": d.get("display_name", ""),
                            "role": d.get("role", "annotator"), "email": d.get("email", ""),
                            "created_at": d.get("created_at", ""), "last_seen": d.get("last_seen", "")})
        return sorted(out, key=lambda u: u["annotator_id"])

    def put_user(self, annotator_id: str, *, display_name: str = "", role: str = "annotator", uid: str = "",
                 email: str = "") -> User:
        aid = str(annotator_id or "").strip().upper()
        if not ID_RE.match(aid):
            raise StoreError("An ID must be 1 to 32 letters, digits, hyphens or underscores (for example A01)")
        if role not in ROLES:
            raise StoreError(f"The role must be one of {', '.join(ROLES)}")
        self.doc.collection("users").document(aid).set(
            {"annotator_id": aid, "display_name": display_name, "role": role, "uid": uid, "email": email,
             "disabled": False, "created_at": now_local_iso()}, merge=True)
        return User(aid, display_name, role)

    def _assignment_doc(self, annotator_id: str) -> dict[str, Any]:
        snap = self.doc.collection("assignments").document(str(annotator_id).upper()).get()
        return (snap.to_dict() or {}) if snap.exists else {}

    def assignments(self, annotator_id: str | None = None) -> list[Assignment]:
        if annotator_id is None:
            docs = [(s.id, s.to_dict() or {}) for s in self.doc.collection("assignments").stream()]
        else:
            docs = [(str(annotator_id).upper(), self._assignment_doc(annotator_id))]
        out = []
        for aid, d in docs:
            for i, a in enumerate(d.get("items", []), start=1):
                out.append(Assignment(aid, a["recording_id"], a.get("mode", "standard"), a.get("context_id", ""),
                                      int(a.get("position", i))))
        return out

    def assign(self, annotator_id: str, recording_ids: list[str], *, mode: str = "standard",
               context_id: str = "") -> int:
        from google.cloud import firestore

        aid = str(annotator_id).upper()
        if mode not in MODES:
            raise StoreError(f"The mode must be one of {', '.join(MODES)}")
        if mode != "standard" and not context_id:
            raise StoreError("Training assignments need a reference set")
        ctx = context_id if mode != "standard" else ""
        ref = self.doc.collection("assignments").document(aid)

        @firestore.transactional
        def update(tx: Any) -> int:
            snap = ref.get(transaction=tx)
            d = (snap.to_dict() or {}) if snap.exists else {}
            items = list(d.get("items", []))
            have = {(a["recording_id"], a.get("mode", "standard"), a.get("context_id", "")) for a in items}
            n = 0
            for rid in recording_ids:
                if (rid, mode, ctx) not in have:
                    items.append({"recording_id": rid, "mode": mode, "context_id": ctx, "position": len(items) + 1})
                    have.add((rid, mode, ctx))
                    n += 1
            tx.set(ref, {**d, "items": items, "updated_at": now_local_iso()})
            return n

        return update(self.client.transaction())

    def unassign(self, annotator_id: str, recording_ids: list[str] | None = None) -> int:
        ref = self.doc.collection("assignments").document(str(annotator_id).upper())
        d = self._assignment_doc(annotator_id)
        items = list(d.get("items", []))
        keep = [] if recording_ids is None else [a for a in items if a["recording_id"] not in set(recording_ids)]
        ref.set({**d, "items": keep, "updated_at": now_local_iso()})
        return len(items) - len(keep)

    def programme(self, annotator_id: str) -> str | None:
        return self._assignment_doc(annotator_id).get("programme") or None

    def enrol(self, annotator_id: str, set_id: str | None) -> None:
        ref = self.doc.collection("assignments").document(str(annotator_id).upper())
        ref.set({"programme": set_id or None, "updated_at": now_local_iso()}, merge=True)

    # ------------------------------------------------------------------ drafts
    def _draft_ref(self, annotator_id: str, key: str) -> Any:
        if not re.fullmatch(r"[0-9a-f]{1,64}", key):
            raise StoreError("Unsuitable draft key")
        return self.doc.collection("drafts").document(f"{annotator_id}_{key}")

    def draft(self, annotator_id: str, key: str) -> dict[str, Any] | None:
        snap = self._draft_ref(annotator_id, key).get()
        return self._get_blob(snap) if snap.exists else None

    def draft_keys(self, annotator_id: str) -> set[str]:
        from google.cloud.firestore_v1.base_query import FieldFilter

        q = (self.doc.collection("drafts").where(filter=FieldFilter("annotator_id", "==", annotator_id))
             .select(["key"]))
        return {(s.to_dict() or {}).get("key", "") for s in q.stream()}

    def put_draft(self, annotator_id: str, key: str, record: dict[str, Any]) -> None:
        self._put_blob(self._draft_ref(annotator_id, key),
                       {"annotator_id": annotator_id, "key": key, "recording_id": record.get("recording_id", ""),
                        "saved_at": record.get("saved_at", now_local_iso())}, record)

    def delete_draft(self, annotator_id: str, key: str) -> None:
        self._delete(self._draft_ref(annotator_id, key))

    # ---------------------------------------------------------- guided state
    def _guided_ref(self, annotator_id: str, set_id: str, recording_id: str) -> Any:
        return self.doc.collection("guided").document(f"{annotator_id}_{_short(set_id)}_{_short(recording_id)}")

    def guided_state(self, annotator_id: str, set_id: str, recording_id: str) -> dict[str, Any] | None:
        snap = self._guided_ref(annotator_id, set_id, recording_id).get()
        return json.loads((snap.to_dict() or {})["state_json"]) if snap.exists else None

    def save_guided_state(self, annotator_id: str, set_id: str, recording_id: str, state: dict[str, Any]) -> None:
        self._guided_ref(annotator_id, set_id, recording_id).set(
            {"annotator_id": annotator_id, "set_id": set_id, "recording_id": recording_id,
             "state_json": json.dumps(state), "updated_at": now_local_iso()})

    def clear_guided_state(self, annotator_id: str, set_id: str, recording_id: str) -> None:
        self._guided_ref(annotator_id, set_id, recording_id).delete()

    # ----------------------------------------------------------------- results
    def _submissions(self, annotator_id: str | None, fields: list[str] | None = None) -> list[Any]:
        from google.cloud.firestore_v1.base_query import FieldFilter

        q: Any = self.doc.collection("submissions")
        if annotator_id is not None:
            q = q.where(filter=FieldFilter("annotator_id", "==", annotator_id))
        if fields is not None:
            q = q.select(fields)
        return list(q.stream())

    def completion_entries(self, annotator_id: str | None = None) -> list[dict[str, str]]:
        return [dict((s.to_dict() or {}).get("entry", {})) for s in self._submissions(annotator_id, ["entry"])]

    def save_results(self, make_session: Callable[[Any], Any], *, elapsed_s: float, started_at: str) -> SavedResult:
        from electroclean.app.io.naming import OutputLayout, output_basename, output_filenames
        from electroclean.app.session.register import CompletionRegister
        from electroclean.web.saving import run_session

        with tempfile.TemporaryDirectory(prefix="electroclean-save-") as tmp:
            layout = OutputLayout(Path(tmp) / "Annotated_Events")
            session = make_session(layout)
            aid, rid, mode, ctx = session.annotator_id, session.recording_id, session.mode, session.context_id
            earlier = [e for e in self.completion_entries(aid) if e.get("recording_id") == rid
                       and e.get("mode", "standard") == mode and e.get("context", "") == ctx]
            if earlier and not session.allow_repeat:
                raise ApiError(409, "already_done", f"You have already completed {rid}; it is not saved twice.")
            final_dir = layout.recording_dir(aid, rid, mode, ctx)
            for j in range(1, len(earlier) + 1):  # so that this save gets the next attempt number
                for name in output_filenames(output_basename(session.loaded.files.stem, aid, j)).values():
                    final_dir.mkdir(parents=True, exist_ok=True)
                    (final_dir / name).write_bytes(b"")
            result = run_session(session, elapsed_s=elapsed_s, started_at=started_at)
            if result is None:
                raise ApiError(500, "save_failed", "The annotations could not be saved; please try again.")
            files = {p.name: p.read_bytes() for p in result.commit.paths.values()}
            entry = next(e for e in CompletionRegister(layout).entries() if e.get("session_id") == session.session_id)
            log_lines = []
            if layout.session_log.is_file():
                log_lines = [ln for ln in layout.session_log.read_text(encoding="utf-8").splitlines() if ln.strip()]
            attempt = len(earlier) + 1
            ref = self.doc.collection("submissions").document(f"{aid}_{item_key(rid, mode, ctx)}_{attempt:02d}")
            payload = {"files": {n: base64.b64encode(b).decode("ascii") for n, b in files.items()},
                       "session_log": log_lines}
            try:
                self._put_blob(ref, {"annotator_id": aid, "recording_id": rid, "mode": mode, "context_id": ctx,
                                     "attempt": attempt, "entry": entry, "saved_at": now_local_iso()},
                               payload, create=True)
            except Exception as exc:  # AlreadyExists: saved by another request at the same moment
                if type(exc).__name__ in ("AlreadyExists", "Conflict"):
                    raise ApiError(409, "already_done", f"{rid} was saved by another request just now.") from exc
                raise
        return SavedResult(session=session, result=result, files=files, attempt=attempt)

    def submission_files(self, annotator_id: str | None = None) -> list[tuple[dict[str, Any], dict[str, bytes],
                                                                              list[str]]]:
        """(register row, files, session log lines) of every saved recording (for the export)."""
        out = []
        for snap in self._submissions(annotator_id):
            d = snap.to_dict() or {}
            payload = self._get_blob(snap) or {}
            files = {n: base64.b64decode(b) for n, b in payload.get("files", {}).items()}
            out.append((dict(d.get("entry", {})), files, list(payload.get("session_log", []))))
        return out

    def progress(self, rs: ReferenceSet, annotator_id: str) -> Progress:
        from electroclean.training.programme import Progress

        ref = self.doc.collection("progress").document(f"{rs.set_id}_{annotator_id}")

        class StoredProgress(Progress):
            def save(self) -> None:  # noqa: D102 - kept in Firestore instead of a file
                ref.set({"set_id": self.set_id, "annotator_id": self.annotator_id, "updated_at": now_local_iso(),
                         "data_json": json.dumps(self.to_dict())})

        prog = StoredProgress(path=Path("training_progress") / rs.set_id / f"annotator-{annotator_id}.json",
                              annotator_id=annotator_id, set_id=rs.set_id)
        snap = ref.get()
        if snap.exists:
            prog.update_from(json.loads((snap.to_dict() or {}).get("data_json") or "{}"))
        return prog

    def progress_records(self) -> list[dict[str, Any]]:
        return [json.loads((s.to_dict() or {}).get("data_json") or "{}")
                for s in self.doc.collection("progress").stream()]

    def competency(self, rs: ReferenceSet, annotator_id: str) -> dict[str, Any]:
        from electroclean.app.io.naming import OutputLayout
        from electroclean.training.assessment import competency_report

        with tempfile.TemporaryDirectory(prefix="electroclean-report-") as tmp:
            layout = OutputLayout(Path(tmp) / "Annotated_Events")
            for entry, files, _log in self.submission_files(annotator_id):
                if entry.get("mode") != "assessment" or entry.get("context") != rs.set_id:
                    continue
                folder = layout.root / entry["output_dir"]
                folder.mkdir(parents=True, exist_ok=True)
                for name, data in files.items():
                    if name.endswith("_annotations.json"):
                        (folder / name).write_bytes(data)
            report = competency_report(layout, rs, annotator_id)
            paths = report.pop("paths", {})
            stored = {"json": Path(paths["json"]).read_text(encoding="utf-8") if paths else json.dumps(report),
                      "html": Path(paths["html"]).read_text(encoding="utf-8") if paths else ""}
        self._put_blob(self.doc.collection("reports").document(f"{rs.set_id}_{annotator_id}"),
                       {"set_id": rs.set_id, "annotator_id": annotator_id, "status": report.get("status", ""),
                        "status_text": report.get("status_text", ""), "generated_at": now_local_iso()}, stored)
        return report

    def report_text(self, set_id: str, annotator_id: str) -> str:
        snap = self.doc.collection("reports").document(f"{set_id}_{annotator_id}").get()
        return str((snap.to_dict() or {}).get("status_text", "")) if snap.exists else ""

    def reports(self) -> list[tuple[str, str, dict[str, str]]]:
        out = []
        for snap in self.doc.collection("reports").stream():
            d = snap.to_dict() or {}
            out.append((d.get("set_id", ""), d.get("annotator_id", ""), self._get_blob(snap) or {}))
        return out

    # ----------------------------------------------------------------- visits
    def visit_open(self, visit_id: str, annotator_id: str, mode: str, context_id: str, header: dict[str, Any],
                   started: datetime) -> None:
        self.doc.collection("visits").document(visit_id).create({
            "annotator_id": annotator_id, "mode": mode, "context_id": context_id,
            "header_json": json.dumps(header), "opened_at": now_local_iso(),
            "stem": f"{started.strftime('%Y%m%dT%H%M%S')}_{mode}", "seq": 0, "last_t": 0.0, "closed": False})
        self.doc.collection("users").document(annotator_id).set({"last_seen": now_local_iso()}, merge=True)

    def visit(self, visit_id: str) -> dict[str, Any] | None:
        snap = self.doc.collection("visits").document(visit_id).get()
        if not snap.exists:
            return None
        d = snap.to_dict() or {}
        return {"annotator_id": d.get("annotator_id"), "closed": bool(d.get("closed")),
                "last_t": float(d.get("last_t", 0.0)), "opened_at": d.get("opened_at", ""), "seq": int(d.get("seq", 0))}

    def visit_append(self, visit_id: str, events: list[dict[str, Any]], *, close: bool = False) -> int:
        from google.cloud import firestore

        if not events:
            return 0
        ref = self.doc.collection("visits").document(visit_id)

        @firestore.transactional
        def append(tx: Any) -> int:
            snap = ref.get(transaction=tx)
            if not snap.exists:
                raise StoreError(f"Unknown visit {visit_id}")
            d = snap.to_dict() or {}
            first = int(d.get("seq", 0)) + 1
            numbered = [{"seq": first + k, **e} for k, e in enumerate(events)]
            for part in _batches(numbered):
                batch = ref.collection("batches").document(f"{part[0]['seq']:09d}")
                tx.set(batch, {"first_seq": part[0]["seq"], "n": len(part), "blob": pack(part)})
            update = {"seq": first + len(numbered) - 1,
                      "last_t": max([float(d.get("last_t", 0.0))] + [float(e.get("t", 0.0)) for e in events])}
            if close:
                update.update(closed=True, closed_at=now_local_iso())
            tx.update(ref, update)
            return len(numbered)

        return append(self.client.transaction())

    def visit_close(self, visit_id: str, event: dict[str, Any]) -> None:
        self.visit_append(visit_id, [event], close=True)

    def visit_logs(self) -> list[tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]]:
        """(visit record, header, events in order) of every visit (for the export)."""
        out = []
        for snap in self.doc.collection("visits").stream():
            d = snap.to_dict() or {}
            events: list[dict[str, Any]] = []
            for b in snap.reference.collection("batches").order_by("first_seq").stream():
                events.extend(unpack((b.to_dict() or {})["blob"]))
            events.sort(key=lambda e: int(e.get("seq", 0)))
            out.append(({"visit_id": snap.id, **{k: v for k, v in d.items() if k != "header_json"}},
                        json.loads(d.get("header_json") or "{}"), events))
        return out
