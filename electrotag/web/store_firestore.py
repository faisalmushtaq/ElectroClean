"""The Firestore store: a study's records as Firestore documents (used by the Firebase functions).

Everything lives under ``studies/{study_id}``::

    studies/{study}                         name, settings (the overrides of electrotag_study.json),
                                            logging notice
        manifests/{key}                     one per registered recording (packed), with its fingerprint
                                            and how it was registered
        reference_sets/{set_id}             a training reference set and its reference files (packed)
        users/{annotator_id}                display name, email, roles (and the primary role), status,
                                            notes, the Firebase Authentication user
        assignments/{annotator_id}          the annotator's recordings and training programme
        drafts/{annotator_id}_{key}         unfinished work (packed)
        guided/{annotator_id}_{set}_{key}   where a trainee is in a guided recording
        quiz/{annotator_id}_{set}           a quiz's answers so far, and its score once finished
        annotators/{annotator_id}           the annotator's own record: a personal goal, being hidden from
                                            the leaderboard, the share of each saved recording viewed
        private/secrets                     the study's random secrets (the leaderboard's pseudonym key)
        problems/{problem_id}               a problem an annotator reported with a recording
        reviews/{review_id}                 an administrator's review of a saved recording
        unusable/{annotator_id}_{key}       an assignment its annotator found could not be annotated
        submissions/{annotator_id}_{key}_{attempt}   a saved recording: its register row and its files
        derived/{kind}_{annotator_id}_{key}_{attempt}   a derived version (a correction, an adjudicated
                                            version): its register row and files, kept apart from the
                                            submissions so it is never anyone's attempt
        tasks/, corrections/, adjudications/, gold/   the records of the expert work (record_json)
        result_files/{key}                  other result files, as written (the quiz results)
        progress/{set}_{annotator_id}       stars, scores and times (training_progress)
        reports/{set}_{annotator_id}        the competency report
        visits/{visit_id}                   a visit's log header and the index of the recordings it
                                            opened (recordings); its events in visits/{id}/batches/{seq}
        audit/{newest first}                the audit log of the administrators' changes

Saving runs the desktop application's own code (:class:`~electrotag.web.saving.WebSession`) into a
scratch folder and keeps the files it wrote in the submission document, so ``electrotag-web
export`` (:func:`export_study`) can put exactly those files into ElectroTag's usual folders.
Large values are kept compressed (zlib JSON), split over several documents when they would not fit
in one (Firestore allows about 1 MiB per document): the pieces (``chunks``) are written first, under
a name of their own, and the document last, so a reader never meets half a value and two writers
never mix their pieces; pieces left by an interrupted write are removed by
:meth:`FirestoreStore.recover_interrupted`.

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
import uuid
import zlib
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from electrotag import __version__
from electrotag.app.common import now_local_iso
from electrotag.web.errors import ApiError
from electrotag.web.manifest import SCHEMA as MANIFEST_SCHEMA
from electrotag.web.manifest import SCHEMA_VERSION as MANIFEST_VERSION
from electrotag.web.manifest import fingerprint_of, manifest_key
from electrotag.web.store import (
    DERIVED_DIR,
    DERIVED_KINDS,
    MODES,
    RECORD_ID_RE,
    RECORD_KINDS,
    ROLES,
    AccountProblem,
    Assignment,
    Credentials,
    Invitation,
    ResultExists,
    SavedResult,
    Store,
    StoreError,
    User,
    index_rows,
    item_key,
    page_of,
    parse_roles,
    primary_role,
    settings_from_overrides,
)

if TYPE_CHECKING:
    from electrotag.config.settings import Settings
    from electrotag.training.programme import Progress
    from electrotag.training.reference import ReferenceSet

STUDY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
ID_RE = re.compile(r"^[A-Z0-9][A-Z0-9_-]{0,31}$")
AUDIT_ID_RE = re.compile(r"^[0-9]{13}-[0-9a-f]{8}$")
BLOB_LIMIT = 900_000  # bytes kept in one document before splitting
CACHE_S = 30.0
#: Chunks not used by their document for this long are left over from an interrupted write.
STALE_CHUNK_S = 600.0


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


def _roles(d: dict[str, Any]) -> tuple[str, ...]:
    """An account's roles: its ``roles`` list, or (an account kept before roles became a set) its ``role``."""
    return parse_roles(d.get("roles") or d.get("role"))


def _check_roles(roles: Any, role: str | None) -> tuple[str, ...]:
    given = list(roles) if roles else [role or "annotator"]
    if any(r not in ROLES for r in given):
        raise AccountProblem("invalid_user", f"The role must be one of {', '.join(ROLES)}", 400)
    return parse_roles(given)


class FirestoreStore(Store):
    kind = "firestore"

    def __init__(self, client: Any, study_id: str, *, cache_dir: Path | None = None, auth_app: Any = None) -> None:
        if not STUDY_ID_RE.match(study_id or ""):
            raise StoreError(f"Unsuitable study ID {study_id!r}")
        self.client = client
        self._study_id = study_id
        self.doc = client.collection("studies").document(study_id)
        self.cache_dir = Path(cache_dir or Path(tempfile.gettempdir()) / "electrotag-firestore") / study_id
        self._study_cache: tuple[float, dict[str, Any]] | None = None
        self._settings_cache: tuple[str, Settings] | None = None
        self._sets_cache: tuple[float, list[ReferenceSet]] | None = None
        self._lock = threading.Lock()
        self._auth_app = auth_app
        self._local = threading.local()  # the memo of one request (memo())

    def refresh(self) -> None:
        with self._lock:
            self._study_cache = None
            self._sets_cache = None

    @contextmanager
    def memo(self) -> Iterator[None]:
        outer = getattr(self._local, "manifests", None)
        if outer is None:
            self._local.manifests = {}
        try:
            yield
        finally:
            if outer is None:
                self._local.manifests = None

    def _memo(self) -> dict[tuple[str, str], dict[str, Any]] | None:
        memo = getattr(self._local, "manifests", None)
        if memo is not None and not memo:
            for snap in self.doc.collection("manifests").stream():
                m = self._get_blob(snap)
                memo[(m["scope"], m["recording_id"])] = m
            memo[("", "")] = {}  # loaded (even when the study has no recordings)
        return memo

    @property
    def auth_app(self) -> Any:
        """The Firebase app whose Authentication holds the accounts (the functions' default app)."""
        if self._auth_app is None:
            import firebase_admin

            try:
                self._auth_app = firebase_admin.get_app()
            except ValueError as exc:
                raise ApiError(503, "auth_unavailable", "Accounts cannot be changed here: Firebase Authentication "
                               "is not available.") from exc
        return self._auth_app

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
                "electrotag_version": __version__, "updated_at": now_local_iso()}
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
                                 "(create it with 'electrotag-web init-study')")
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

    @property
    def logging_notice(self) -> str:
        return str(self._study().get("logging_notice") or "")

    def update_study(self, *, name: str | None = None, overrides: dict[str, Any] | None = None,
                     logging_notice: str | None = None) -> None:
        changes: dict[str, Any] = {"updated_at": now_local_iso()}
        if overrides is not None:
            try:
                settings_from_overrides(overrides)
            except (ValueError, TypeError, KeyError, AttributeError) as exc:
                raise ValueError(str(exc)) from exc
            changes["settings_json"] = json.dumps(overrides)
        if name is not None:
            changes["name"] = name
        if logging_notice is not None:
            changes["logging_notice"] = logging_notice
        self._study()  # the study must exist
        self.doc.set(changes, merge=True)
        self.refresh()

    # --------------------------------------------------------------- blobs
    def _put_blob(self, ref: Any, fields: dict[str, Any], payload: Any, *, create: bool = False,
                  transaction: Any = None) -> None:
        data = pack(payload)
        if len(data) <= BLOB_LIMIT:
            doc = {**fields, "blob": data, "chunks": 0, "chunk_prefix": None}
            self._write(ref, doc, create=create, transaction=transaction)
            self._drop_stale_chunks(ref, None)
            return
        parts = [data[i:i + BLOB_LIMIT] for i in range(0, len(data), BLOB_LIMIT)]
        # The chunks first, so the document never points to missing ones, under a name of their own, so two
        # requests writing the same document at once never mix their chunks.
        prefix = uuid.uuid4().hex[:12]
        for i, part in enumerate(parts):
            ref.collection("chunks").document(f"{prefix}-{i:04d}").set(
                {"data": part, "prefix": prefix, "written_at": time.time()})
        self._write(ref, {**fields, "blob": None, "chunks": len(parts), "chunk_prefix": prefix}, create=create,
                    transaction=transaction)
        self._drop_stale_chunks(ref, prefix)

    @staticmethod
    def _drop_stale_chunks(ref: Any, current: str | None) -> None:
        """Remove the chunks of earlier versions of a document (those of a write still in progress elsewhere,
        younger than STALE_CHUNK_S, are left for later)."""
        cutoff = time.time() - STALE_CHUNK_S
        for c in ref.collection("chunks").select(["prefix", "written_at"]).stream():
            d = c.to_dict() or {}
            if d.get("prefix") != current and (not d.get("prefix") or float(d.get("written_at", 0)) < cutoff):
                c.reference.delete()

    @staticmethod
    def _write(ref: Any, doc: dict[str, Any], *, create: bool, transaction: Any) -> None:
        if transaction is not None:
            (transaction.create if create else transaction.set)(ref, doc)
        elif create:
            ref.create(doc)
        else:
            ref.set(doc)

    def _get_blob(self, snap: Any) -> Any:
        d = snap.to_dict() or {}
        if d.get("chunks"):
            n, prefix = int(d["chunks"]), d.get("chunk_prefix")
            chunks = snap.reference.collection("chunks")
            if prefix:
                got = {s.id: s for s in self.client.get_all([chunks.document(f"{prefix}-{i:04d}") for i in range(n)])}
                parts = [got[f"{prefix}-{i:04d}"].to_dict()["data"] for i in range(n)]
            else:  # written before chunks had names of their own
                parts = [c.to_dict()["data"] for c in chunks.order_by("__name__").stream()][:n]
            return unpack(b"".join(parts))
        return unpack(d["blob"]) if d.get("blob") is not None else None

    def recover_interrupted(self) -> list[dict[str, Any]]:
        """Remove the chunks an interrupted write left behind: those whose document was never written, or
        that belong to an earlier version of it (older than STALE_CHUNK_S, so a write in progress is left
        alone). A save that stopped before its document was written is not a result: the annotator saves
        again. Run by ``electrotag-web export`` and the admin area's results zip."""
        cutoff = time.time() - STALE_CHUNK_S
        base = self.doc.path + "/"
        by_parent: dict[str, list[Any]] = {}
        for snap in self.client.collection_group("chunks").select(["prefix", "written_at"]).stream():
            if snap.reference.path.startswith(base):
                by_parent.setdefault(snap.reference.parent.parent.path, []).append(snap)
        out = []
        for path, chunks in sorted(by_parent.items()):
            parent = self.client.document(path).get()
            d = (parent.to_dict() or {}) if parent.exists else {}
            current = d.get("chunk_prefix") if parent.exists else "(missing)"
            stale = []
            for c in chunks:
                cd = c.to_dict() or {}
                if not cd.get("prefix") and parent.exists and d.get("chunks") and not current:
                    continue  # the chunks of a document written before chunks had names of their own
                if cd.get("prefix") != current and float(cd.get("written_at", 0)) < cutoff:
                    stale.append(c)
            for c in stale:
                c.reference.delete()
            if stale:
                out.append({"document": path[len(base):], "action": "cleaned_up",
                            "message": f"Removed {len(stale)} piece(s) of an interrupted write"})
        return out

    @staticmethod
    def _delete(ref: Any) -> None:
        for c in ref.collection("chunks").stream():
            c.reference.delete()
        ref.delete()

    # -------------------------------------------------------------- manifests
    def manifest(self, scope: str, recording_id: str) -> dict[str, Any] | None:
        memo = self._memo()
        if memo is not None:
            return memo.get((scope, recording_id))
        snap = self.doc.collection("manifests").document(manifest_key(scope, recording_id)).get()
        return self._get_blob(snap) if snap.exists else None

    def manifests(self) -> list[dict[str, Any]]:
        memo = self._memo()
        if memo is not None:
            return [m for k, m in memo.items() if k != ("", "")]
        return [self._get_blob(s) for s in self.doc.collection("manifests").stream()]

    def _forget_memo(self) -> None:
        if getattr(self._local, "manifests", None) is not None:
            self._local.manifests = {}

    def remove_manifest(self, scope: str, recording_id: str) -> None:
        self._delete(self.doc.collection("manifests").document(manifest_key(scope, recording_id)))
        self._forget_memo()

    def manifests_by_fingerprint(self, sha256: str, size: int) -> list[dict[str, Any]]:
        from google.cloud.firestore_v1.base_query import FieldFilter

        q = self.doc.collection("manifests").where(filter=FieldFilter("fp_sha256", "==", (sha256 or "").lower()))
        out = [self._get_blob(s) for s in q.stream()]
        return [m for m in out if fingerprint_of(m) == ((sha256 or "").lower(), int(size))]

    def add_manifest(self, m: dict[str, Any]) -> None:
        if m.get("schema") != MANIFEST_SCHEMA or "recording_id" not in m or "scope" not in m:
            raise StoreError("Not an ElectroTag web manifest")
        if str(m.get("schema_version", "")).split(".")[0] != MANIFEST_VERSION.split(".")[0]:
            raise StoreError(f"Manifest version {m.get('schema_version')} is not supported")
        sha, size = fingerprint_of(m)
        ref = self.doc.collection("manifests").document(manifest_key(m["scope"], m["recording_id"]))
        self._put_blob(ref, {"scope": m["scope"], "recording_id": m["recording_id"], "file_name": m["file_name"],
                             "fp_sha256": sha, "fp_size": size, "registered_at": now_local_iso()}, m)
        self._forget_memo()

    # --------------------------------------------------------- reference sets
    def reference_sets(self) -> list[ReferenceSet]:
        from electrotag.training.reference import ReferenceSet, ReferenceSetError

        now = time.monotonic()
        with self._lock:
            if self._sets_cache is not None and now - self._sets_cache[0] < CACHE_S:
                return self._sets_cache[1]
            out = []
            # Only the digests are read; a set's contents only when this instance has no copy of that version.
            for snap in self.doc.collection("reference_sets").select(["digest"]).stream():
                d = snap.to_dict() or {}
                folder = self.cache_dir / "reference_sets" / f"{snap.id}-{d.get('digest', 'x')[:16]}"
                if not (folder / "reference_set.json").is_file():
                    payload = self._get_blob(snap.reference.get())
                    tmp = folder.with_name(folder.name + f".tmp{time.monotonic_ns()}")
                    tmp.mkdir(parents=True, exist_ok=True)  # a new set has no files besides its definition
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

    def reference_set_payload(self, set_id: str) -> tuple[dict[str, Any], dict[str, bytes]]:
        if not STUDY_ID_RE.match(str(set_id or "")):
            raise StoreError(f"Unsuitable reference set ID {set_id!r}")
        snap = self.doc.collection("reference_sets").document(set_id).get()
        if not snap.exists:
            raise StoreError(f"Reference set {set_id!r} was not found in this study")
        payload = self._get_blob(snap) or {}
        return dict(payload.get("definition") or {}), {rel: base64.b64decode(b64)
                                                        for rel, b64 in dict(payload.get("files") or {}).items()}

    def put_reference_set(self, definition: dict[str, Any], files: dict[str, bytes]) -> None:
        """The document holds the whole set, so storing it again replaces every file."""
        if any(Path(rel).as_posix() == "reference_set.json" for rel in files):
            raise StoreError("reference_set.json is the set's definition, not one of its files")
        self.add_reference_set(definition, files)

    def delete_reference_set(self, set_id: str) -> None:
        from google.cloud.firestore_v1.base_query import FieldFilter

        if not STUDY_ID_RE.match(str(set_id or "")):
            raise StoreError(f"Unsuitable reference set ID {set_id!r}")
        self._delete(self.doc.collection("reference_sets").document(set_id))
        for name in ("guided", "quiz"):
            for snap in self.doc.collection(name).where(filter=FieldFilter("set_id", "==", set_id)).stream():
                snap.reference.delete()
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
        roles = _roles(d)
        return User(aid, str(d.get("display_name", "")), primary_role(roles), roles)

    def users(self) -> list[dict[str, Any]]:
        out = []
        for s in self.doc.collection("users").stream():
            d = s.to_dict() or {}
            if not d.get("disabled"):
                out.append({"annotator_id": s.id, "display_name": d.get("display_name", ""),
                            "role": primary_role(_roles(d)), "roles": list(_roles(d)), "email": d.get("email", ""),
                            "created_at": d.get("created_at", ""), "last_seen": d.get("last_seen", "")})
        return sorted(out, key=lambda u: u["annotator_id"])

    def put_user(self, annotator_id: str, *, display_name: str = "", role: str = "annotator", uid: str = "",
                 email: str = "", roles: Any = None) -> User:
        aid = str(annotator_id or "").strip().upper()
        if not ID_RE.match(aid):
            raise StoreError("An ID must be 1 to 32 letters, digits, hyphens or underscores (for example A01)")
        given = list(roles) if roles else [role]
        if any(r not in ROLES for r in given):
            raise StoreError(f"The role must be one of {', '.join(ROLES)}")
        kept = parse_roles(given)
        ref = self.doc.collection("users").document(aid)
        data = {"annotator_id": aid, "display_name": display_name, "role": primary_role(kept), "roles": list(kept),
                "uid": uid, "email": email, "disabled": False}
        if not ref.get().exists:
            data.update(created_at=now_local_iso(), notes="")
        ref.set(data, merge=True)
        return User(aid, display_name, primary_role(kept), kept)

    def user_records(self) -> list[dict[str, Any]]:
        out = []
        for s in self.doc.collection("users").stream():
            d = s.to_dict() or {}
            out.append({"annotator_id": s.id, "display_name": d.get("display_name", ""),
                        "email": d.get("email") or None, "role": primary_role(_roles(d)), "roles": list(_roles(d)),
                        "status": "disabled" if d.get("disabled") else "active",
                        "created_at": d.get("created_at", ""), "last_seen": d.get("last_seen") or None,
                        "notes": d.get("notes", "")})
        return sorted(out, key=lambda u: u["annotator_id"])

    def _user_doc(self, annotator_id: str) -> tuple[Any, dict[str, Any]]:
        aid = str(annotator_id or "").strip().upper()
        ref = self.doc.collection("users").document(aid) if ID_RE.match(aid) else None
        snap = ref.get() if ref is not None else None
        if snap is None or not snap.exists:
            raise AccountProblem("unknown_user", f"{aid} has no account in this study", 404)
        return ref, snap.to_dict() or {}

    def create_account(self, annotator_id: str, *, display_name: str, role: str, email: str,
                       password: str | None, roles: tuple[str, ...] | None = None) -> Credentials:
        from electrotag.web.firebase import AuthProblem, ensure_auth_user

        aid = str(annotator_id or "").strip().upper()
        if not ID_RE.match(aid):
            raise AccountProblem("invalid_user", "An ID must be 1 to 32 letters, digits, hyphens or underscores, "
                                 "starting with a letter or digit (for example A01)", 400)
        kept = _check_roles(roles, role)
        if not email:
            raise AccountProblem("email_required", "On Firebase each person signs in with their email address: "
                                 "give it", 400)
        if self.doc.collection("users").document(aid).get().exists:
            raise AccountProblem("user_exists", f"{aid} already has an account in this study.")
        if any((u.get("email") or "").lower() == email.lower() for u in self.user_records()):
            raise AccountProblem("email_in_use", f"{email} already signs in to this study under another ID")
        try:
            uid, link = ensure_auth_user(self.auth_app, email=email, annotator_id=aid, study=self.study_id,
                                         role=primary_role(kept), roles=kept, display_name=display_name,
                                         password=password, update_existing=False)
        except AuthProblem as exc:
            raise AccountProblem(exc.code, exc.message, 409 if exc.code == "email_in_use" else 400) from exc
        self.put_user(aid, display_name=display_name, roles=kept, uid=uid, email=email)
        if link:
            self.doc.collection("users").document(aid).set({"invite": {"invited_at": now_local_iso(), "by": ""}},
                                                           merge=True)
        return {"invite_link": link, "temporary_password": None}

    def update_account(self, annotator_id: str, *, display_name: str | None = None, role: str | None = None,
                       status: str | None = None, notes: str | None = None,
                       roles: tuple[str, ...] | None = None) -> None:
        from electrotag.web.firebase import set_disabled, set_roles

        ref, d = self._user_doc(annotator_id)
        changes: dict[str, Any] = {}
        if display_name is not None:
            changes["display_name"] = display_name
        if notes is not None:
            changes["notes"] = notes
        if roles or role is not None:
            kept = _check_roles(roles, role)
            if kept != _roles(d) or not d.get("roles"):
                if d.get("uid"):
                    set_roles(self.auth_app, d["uid"], ref.id, self.study_id, kept)
                changes.update(role=primary_role(kept), roles=list(kept))
        if status is not None and (status == "disabled") != bool(d.get("disabled")):
            if d.get("uid"):
                set_disabled(self.auth_app, d["uid"], status == "disabled")
            changes["disabled"] = status == "disabled"
        if changes:
            ref.set(changes, merge=True)

    def reset_password(self, annotator_id: str) -> Credentials:
        from electrotag.web.firebase import password_link

        _ref, d = self._user_doc(annotator_id)
        if not d.get("email"):
            raise AccountProblem("no_email", f"{annotator_id} has no email address, so no link can be made")
        return {"invite_link": password_link(self.auth_app, d["email"]), "temporary_password": None}

    def create_invitation(self, annotator_id: str, *, days: float, by: str) -> Invitation:
        """A Firebase Authentication link with which the person chooses a password; its expiry is
        Firebase's own, so none is given."""
        from electrotag.web.firebase import password_link

        ref, d = self._user_doc(annotator_id)
        if d.get("disabled"):
            raise AccountProblem("disabled", f"{ref.id} is switched off; switch the account on before inviting "
                                 "them")
        if not d.get("email"):
            raise AccountProblem("no_email", f"{ref.id} has no email address, so no link can be made")
        link = password_link(self.auth_app, d["email"])
        ref.set({"invite": {"invited_at": now_local_iso(), "by": by}}, merge=True)
        return {"invite_token": None, "invite_link": link, "expires_at": None}

    def revoke_invitation(self, annotator_id: str) -> bool:
        raise AccountProblem("cannot_revoke", "On Firebase an invitation link cannot be withdrawn once it is made. "
                             "Switch the account off to stop the person signing in.", 422)

    def invitations(self) -> dict[str, dict[str, Any]]:
        """Invited when a link was made; accepted once the person has signed in after it."""
        out = {}
        for s in self.doc.collection("users").stream():
            d = s.to_dict() or {}
            inv = d.get("invite")
            if not isinstance(inv, dict) or not inv.get("invited_at"):
                continue
            seen = str(d.get("last_seen") or "")
            accepted = bool(seen) and seen >= str(inv["invited_at"])
            out[s.id] = {"state": "accepted" if accepted else "invited", "invited_at": inv["invited_at"],
                         "expires_at": None, "ended_at": seen if accepted else None, "by": inv.get("by", "")}
        return out

    def remove_account(self, annotator_id: str) -> None:
        from google.cloud.firestore_v1.base_query import FieldFilter

        from electrotag.web.firebase import leave_study

        ref, d = self._user_doc(annotator_id)
        if d.get("uid"):
            leave_study(self.auth_app, d["uid"], self.study_id)
        aid = ref.id
        for name in ("drafts", "guided", "quiz"):
            for snap in self.doc.collection(name).where(filter=FieldFilter("annotator_id", "==", aid)).stream():
                self._delete(snap.reference)
        self.doc.collection("assignments").document(aid).delete()
        self.doc.collection("annotators").document(aid).delete()
        ref.delete()

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
                                      int(a.get("position", i)), str(a.get("task_id") or "")))
        return out

    def assign(self, annotator_id: str, recording_ids: list[str], *, mode: str = "standard",
               context_id: str = "", task_id: str = "") -> int:
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
                    item = {"recording_id": rid, "mode": mode, "context_id": ctx, "position": len(items) + 1}
                    if task_id:
                        item["task_id"] = task_id
                    items.append(item)
                    have.add((rid, mode, ctx))
                    n += 1
                elif task_id:  # an assignment made before its task: linked to it
                    for a in items:
                        if ((a["recording_id"], a.get("mode", "standard"), a.get("context_id", "")) == (rid, mode, ctx)
                                and not a.get("task_id")):
                            a["task_id"] = task_id
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

    def _drop_items(self, ref: Any, drop: Callable[[dict[str, Any]], bool]) -> int:
        from google.cloud import firestore

        @firestore.transactional
        def update(tx: Any) -> int:
            snap = ref.get(transaction=tx)
            d = (snap.to_dict() or {}) if snap.exists else {}
            items = list(d.get("items", []))
            keep = [a for a in items if not drop(a)]
            if len(keep) != len(items):
                tx.set(ref, {**d, "items": keep, "updated_at": now_local_iso()})
            return len(items) - len(keep)

        return update(self.client.transaction())

    def unassign_item(self, annotator_id: str, recording_id: str, mode: str, context_id: str) -> bool:
        ctx = context_id if mode != "standard" else ""
        ref = self.doc.collection("assignments").document(str(annotator_id).upper())
        return bool(self._drop_items(ref, lambda a: (a["recording_id"], a.get("mode", "standard"),
                                                     a.get("context_id", "")) == (recording_id, mode, ctx)))

    def remove_assignments(self, *, recording_id: str | None = None, context_id: str | None = None,
                           modes: tuple[str, ...] | None = None) -> int:
        if recording_id is None and context_id is None and modes is None:
            return 0

        def drop(a: dict[str, Any]) -> bool:
            return ((recording_id is None or a["recording_id"] == recording_id)
                    and (context_id is None or a.get("context_id", "") == context_id)
                    and (modes is None or a.get("mode", "standard") in modes))

        return sum(self._drop_items(s.reference, drop) for s in self.doc.collection("assignments").stream())

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
        return self._save_into("submissions", None, make_session, elapsed_s=elapsed_s, started_at=started_at)

    def save_derived(self, kind: str, make_session: Callable[[Any], Any], *, elapsed_s: float,
                     started_at: str) -> SavedResult:
        if kind not in DERIVED_KINDS:
            raise StoreError(f"Unknown kind of derived version {kind!r}")
        return self._save_into("derived", kind, make_session, elapsed_s=elapsed_s, started_at=started_at)

    def _save_into(self, collection: str, kind: str | None, make_session: Callable[[Any], Any], *, elapsed_s: float,
                   started_at: str) -> SavedResult:
        """Save and Finish into a scratch folder, then keep the files in one document of ``collection``:
        ``submissions`` (a person's attempt) or ``derived`` (a derived version of ``kind``)."""
        from electrotag.app.io.naming import OutputLayout, output_basename, output_filenames
        from electrotag.app.session.register import CompletionRegister
        from electrotag.web.saving import run_session

        with tempfile.TemporaryDirectory(prefix="electrotag-save-") as tmp:
            root = Path(tmp) / "Annotated_Events"
            layout = OutputLayout(root / DERIVED_DIR / kind if kind else root)
            session = make_session(layout)
            if kind:
                session.allow_repeat = True  # each derived version of the same work is a new attempt of its tree
            aid, rid, mode, ctx = session.annotator_id, session.recording_id, session.mode, session.context_id
            kept = self.completion_entries(aid) if not kind else self.derived_entries(kind, aid)
            earlier = [e for e in kept if e.get("recording_id") == rid
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
            name = f"{aid}_{item_key(rid, mode, ctx)}_{attempt:02d}"
            ref = self.doc.collection(collection).document(f"{kind}_{name}" if kind else name)
            payload = {"files": {n: base64.b64encode(b).decode("ascii") for n, b in files.items()},
                       "session_log": log_lines}
            fields: dict[str, Any] = {"annotator_id": aid, "recording_id": rid, "mode": mode, "context_id": ctx,
                                      "attempt": attempt, "entry": entry, "saved_at": now_local_iso()}
            if kind:
                fields["kind"] = kind
            try:
                self._put_blob(ref, fields, payload, create=True)
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

    # ------------------------------------------------------- derived versions
    def _derived(self, kind: str, annotator_id: str | None, fields: list[str] | None = None) -> list[Any]:
        from google.cloud.firestore_v1.base_query import FieldFilter

        if kind not in DERIVED_KINDS:
            raise StoreError(f"Unknown kind of derived version {kind!r}")
        q: Any = self.doc.collection("derived").where(filter=FieldFilter("kind", "==", kind))
        if annotator_id is not None:  # filtered here: two equality filters would need a composite index
            q = self.doc.collection("derived").where(filter=FieldFilter("annotator_id", "==", annotator_id))
        if fields is not None:
            q = q.select(list(dict.fromkeys(["kind", *fields])))
        return [s for s in q.stream() if (s.to_dict() or {}).get("kind") == kind]

    def derived_entries(self, kind: str, annotator_id: str | None = None) -> list[dict[str, str]]:
        return [dict((s.to_dict() or {}).get("entry", {})) for s in self._derived(kind, annotator_id, ["entry"])]

    def derived_files(self, kind: str, annotator_id: str, recording_id: str,
                      attempt: int | None = None) -> dict[str, bytes]:
        mine = [s for s in self._derived(kind, annotator_id, ["recording_id", "attempt"])
                if (s.to_dict() or {}).get("recording_id") == recording_id
                and (attempt is None or int((s.to_dict() or {}).get("attempt", 0)) == int(attempt))]
        return self._files_of_latest(mine)

    def _files_of_latest(self, snaps: list[Any]) -> dict[str, bytes]:
        if not snaps:
            return {}
        last = max(snaps, key=lambda s: int((s.to_dict() or {}).get("attempt", 0)))
        payload = self._get_blob(last.reference.get()) or {}
        return {n: base64.b64decode(b) for n, b in payload.get("files", {}).items()}

    def derived_submission_files(self) -> list[tuple[str, dict[str, Any], dict[str, bytes], list[str]]]:
        """(kind, register row, files, session log lines) of every derived version (for the export)."""
        out = []
        for snap in self.doc.collection("derived").stream():
            d = snap.to_dict() or {}
            if d.get("kind") not in DERIVED_KINDS:
                continue
            payload = self._get_blob(snap) or {}
            files = {n: base64.b64decode(b) for n, b in payload.get("files", {}).items()}
            out.append((str(d["kind"]), dict(d.get("entry", {})), files, list(payload.get("session_log", []))))
        return out

    def progress(self, rs: ReferenceSet, annotator_id: str) -> Progress:
        from electrotag.training.programme import Progress

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
        from electrotag.app.io.naming import OutputLayout
        from electrotag.training.assessment import competency_report

        with tempfile.TemporaryDirectory(prefix="electrotag-report-") as tmp:
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

    def report_result(self, set_id: str, annotator_id: str) -> dict[str, str]:
        snap = self.doc.collection("reports").document(f"{set_id}_{annotator_id}").get()
        if not snap.exists:
            return {}
        d = snap.to_dict() or {}
        return {"status": str(d.get("status", "")), "status_text": str(d.get("status_text", ""))}

    def reports(self) -> list[tuple[str, str, dict[str, str]]]:
        out = []
        for snap in self.doc.collection("reports").stream():
            d = snap.to_dict() or {}
            out.append((d.get("set_id", ""), d.get("annotator_id", ""), self._get_blob(snap) or {}))
        return out

    def saved_files(self, annotator_id: str, recording_id: str, mode: str, context_id: str,
                    attempt: int | None = None) -> dict[str, bytes]:
        ctx = context_id if mode != "standard" else ""
        mine = [s for s in self._submissions(annotator_id, ["recording_id", "mode", "context_id", "attempt"])
                if (s.to_dict() or {}).get("recording_id") == recording_id
                and (s.to_dict() or {}).get("mode", "standard") == mode
                and (s.to_dict() or {}).get("context_id", "") == ctx
                and (attempt is None or int((s.to_dict() or {}).get("attempt", 0)) == int(attempt))]
        return self._files_of_latest(mine)

    def results_tree(self, dest: Path, *, logs: bool = False, annotator_ids: set[str] | None = None,
                     modes: set[str] | None = None) -> Path:
        """The saved files (and the interaction logs) written below ``dest`` as ``electrotag-web export``
        writes them, for an analysis to read."""
        from electrotag.app.io.naming import OutputLayout
        from electrotag.app.session.register import CompletionRegister
        from electrotag.web.export import safe_path, visit_log_text

        layout = OutputLayout(Path(dest) / self.settings.output_directory_name)
        layout.root.mkdir(parents=True, exist_ok=True)
        register = CompletionRegister(layout)
        for snap in self._submissions(None):
            d = snap.to_dict() or {}
            if annotator_ids is not None and d.get("annotator_id") not in annotator_ids:
                continue
            if modes is not None and d.get("mode", "standard") not in modes:
                continue
            entry = dict(d.get("entry", {}))
            payload = self._get_blob(snap) or {}
            folder = safe_path(layout.root, entry["output_dir"])
            folder.mkdir(parents=True, exist_ok=True)
            for name, b64 in payload.get("files", {}).items():
                if "/" not in name and "\\" not in name:
                    (folder / name).write_bytes(base64.b64decode(b64))
            register.add(entry)
        for kind, entry, files, _log in self.derived_submission_files():  # derived/<kind>/, a register of its own
            if annotator_ids is not None and entry.get("annotator_id") not in annotator_ids:
                continue
            if modes is not None and entry.get("mode", "standard") not in modes:
                continue
            tree = OutputLayout(layout.root / DERIVED_DIR / kind)
            folder = safe_path(tree.root, entry["output_dir"])
            folder.mkdir(parents=True, exist_ok=True)
            for name, data in files.items():
                if "/" not in name and "\\" not in name:
                    (folder / name).write_bytes(data)
            CompletionRegister(tree).add(entry)
        if logs:
            for visit, header, events in self.visit_logs():
                if annotator_ids is not None and visit.get("annotator_id") not in annotator_ids:
                    continue
                folder = layout.interaction_logs / f"annotator-{visit['annotator_id']}"
                folder.mkdir(parents=True, exist_ok=True)
                (folder / f"{visit.get('stem') or visit['visit_id']}-{visit['visit_id'][:8]}.jsonl").write_text(
                    visit_log_text(header, events), encoding="utf-8")
        return layout.root

    def put_result_file(self, rel_path: str, data: bytes) -> None:
        from electrotag.web.export import safe_path

        safe_path(Path("/"), rel_path)  # refuses paths that would leave the results folder
        ref = self.doc.collection("result_files").document(hashlib.sha1(rel_path.encode()).hexdigest()[:24])
        try:
            self._put_blob(ref, {"path": rel_path, "saved_at": now_local_iso()},
                           base64.b64encode(data).decode("ascii"), create=True)
        except Exception as exc:  # AlreadyExists: result files are never replaced
            if type(exc).__name__ in ("AlreadyExists", "Conflict"):
                raise ResultExists(f"{rel_path} has already been saved") from exc
            raise

    def result_files(self) -> list[tuple[str, bytes]]:
        """(path below the results folder, contents) of every result file kept (for the export)."""
        return [((s.to_dict() or {}).get("path", ""), base64.b64decode(self._get_blob(s) or ""))
                for s in self.doc.collection("result_files").stream()]

    # ------------------------------------------- the annotator's own record (games)
    def annotator_record(self, annotator_id: str) -> dict[str, Any]:
        snap = self.doc.collection("annotators").document(str(annotator_id).upper()).get()
        return json.loads((snap.to_dict() or {}).get("record_json") or "{}") if snap.exists else {}

    def annotator_records(self) -> dict[str, dict[str, Any]]:
        return {s.id: json.loads((s.to_dict() or {}).get("record_json") or "{}")
                for s in self.doc.collection("annotators").stream()}

    def update_annotator_record(self, annotator_id: str,
                                change: Callable[[dict[str, Any]], dict[str, Any] | None]) -> dict[str, Any]:
        from google.cloud import firestore

        aid = str(annotator_id).upper()
        ref = self.doc.collection("annotators").document(aid)

        @firestore.transactional
        def update(tx: Any) -> dict[str, Any]:
            snap = ref.get(transaction=tx)
            old = json.loads((snap.to_dict() or {}).get("record_json") or "{}") if snap.exists else {}
            new = change(dict(old))
            if new is None:
                return old
            tx.set(ref, {"annotator_id": aid, "record_json": json.dumps(new), "updated_at": now_local_iso()})
            return new

        return update(self.client.transaction())

    def study_secret(self, name: str) -> str:
        import secrets

        from google.cloud import firestore

        ref = self.doc.collection("private").document("secrets")

        @firestore.transactional
        def get_or_make(tx: Any) -> str:
            snap = ref.get(transaction=tx)
            kept = dict((snap.to_dict() or {}).get("values") or {}) if snap.exists else {}
            if name in kept:
                return str(kept[name])
            kept[name] = secrets.token_hex(32)
            tx.set(ref, {"values": kept, "updated_at": now_local_iso()})
            return kept[name]

        return get_or_make(self.client.transaction())

    # ------------------------------------------- problem reports and reviews
    def _record_ref(self, kind: str, record_id: str) -> Any:
        if kind not in RECORD_KINDS or not RECORD_ID_RE.match(str(record_id)):
            raise StoreError(f"Unsuitable record {kind!r} {record_id!r}")
        return self.doc.collection(kind).document(record_id)

    def records(self, kind: str, annotator_id: str | None = None) -> list[dict[str, Any]]:
        from google.cloud.firestore_v1.base_query import FieldFilter

        if kind not in RECORD_KINDS:
            raise StoreError(f"Unsuitable record kind {kind!r}")
        q: Any = self.doc.collection(kind)
        if annotator_id is not None:
            q = q.where(filter=FieldFilter("annotator_id", "==", annotator_id))
        return [json.loads((s.to_dict() or {}).get("record_json") or "{}") for s in q.stream()]

    def update_record(self, kind: str, record_id: str, annotator_id: str,
                      change: Callable[[dict[str, Any] | None], dict[str, Any] | None]) -> dict[str, Any] | None:
        from google.cloud import firestore

        ref = self._record_ref(kind, record_id)

        @firestore.transactional
        def update(tx: Any) -> dict[str, Any] | None:
            snap = ref.get(transaction=tx)
            old = json.loads((snap.to_dict() or {}).get("record_json") or "{}") if snap.exists else None
            new = change(None if old is None else dict(old))
            if new is None:
                return old
            text = json.dumps(new, separators=(",", ":"))
            if len(text.encode("utf-8")) > BLOB_LIMIT:
                raise StoreError("The record is too large to keep")
            tx.set(ref, {"annotator_id": annotator_id, "record_json": text, "updated_at": now_local_iso()})
            return new

        return update(self.client.transaction())

    # ------------------------------------------------------------------- quiz
    def _quiz_ref(self, annotator_id: str, set_id: str) -> Any:
        return self.doc.collection("quiz").document(f"{annotator_id}_{_short(set_id)}")

    def quiz_state(self, annotator_id: str, set_id: str) -> dict[str, Any] | None:
        snap = self._quiz_ref(annotator_id, set_id).get()
        return json.loads((snap.to_dict() or {})["state_json"]) if snap.exists else None

    def update_quiz_state(self, annotator_id: str, set_id: str,
                          change: Callable[[dict[str, Any] | None], dict[str, Any] | None]) -> dict[str, Any] | None:
        from google.cloud import firestore

        ref = self._quiz_ref(annotator_id, set_id)

        @firestore.transactional
        def update(tx: Any) -> dict[str, Any] | None:
            snap = ref.get(transaction=tx)
            old = json.loads((snap.to_dict() or {})["state_json"]) if snap.exists else None
            new = change(old)
            if new is None:
                return old
            tx.set(ref, {"annotator_id": annotator_id, "set_id": set_id, "state_json": json.dumps(new),
                         "updated_at": now_local_iso()})
            return new

        return update(self.client.transaction())

    # ------------------------------------------------------------------ audit
    def audit_append(self, entry: dict[str, Any]) -> None:
        # Document IDs sort newest first: the time counted down from the year 2286, then a random part.
        doc_id = f"{10**13 - int(time.time() * 1000):013d}-{uuid.uuid4().hex[:8]}"
        self.doc.collection("audit").document(doc_id).set({
            "at": str(entry.get("at", "")), "by": str(entry.get("by", "")), "op": str(entry.get("op", "")),
            "summary": str(entry.get("summary", "")),
            "details_json": json.dumps(entry.get("details") or {}, default=str)})

    def audit_page(self, before: str | None, limit: int) -> tuple[list[dict[str, Any]], str | None]:
        coll = self.doc.collection("audit")
        q = coll.order_by("__name__").limit(int(limit) + 1)
        if before:
            if not AUDIT_ID_RE.match(before):
                raise StoreError("The audit cursor is not valid")
            q = q.start_after({"__name__": coll.document(before)})
        snaps = list(q.stream())
        more = len(snaps) > limit
        snaps = snaps[:limit]
        entries = []
        for s in snaps:
            d = s.to_dict() or {}
            entries.append({"at": d.get("at", ""), "by": d.get("by", ""), "op": d.get("op", ""),
                            "summary": d.get("summary", ""), "details": json.loads(d.get("details_json") or "{}")})
        return entries, (snaps[-1].id if more and snaps else None)

    # ----------------------------------------------------------------- visits
    def visit_open(self, visit_id: str, annotator_id: str, mode: str, context_id: str, header: dict[str, Any],
                   started: datetime) -> None:
        self.doc.collection("visits").document(visit_id).create({
            "annotator_id": annotator_id, "mode": mode, "context_id": context_id,
            "header_json": json.dumps(header), "opened_at": now_local_iso(),
            "stem": f"{started.strftime('%Y%m%dT%H%M%S')}_{mode}", "seq": 0, "last_t": 0.0, "closed": False,
            "recordings": []})  # the index of the recordings it opens (visit_index)
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
            if isinstance(d.get("recordings"), list):  # indexed as it goes (visits opened since the index exists)
                rows = index_rows(list(d["recordings"]), numbered, str(d.get("context_id") or ""))
                if rows != d["recordings"]:
                    update["recordings"] = rows
            if close:
                update.update(closed=True, closed_at=now_local_iso())
            tx.update(ref, update)
            return len(numbered)

        return append(self.client.transaction())

    def visit_close(self, visit_id: str, event: dict[str, Any]) -> None:
        self.visit_append(visit_id, [event], close=True)

    def visit_records(self, annotator_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        from google.cloud import firestore
        from google.cloud.firestore_v1.base_query import FieldFilter

        fields = ["annotator_id", "mode", "context_id", "opened_at", "closed_at", "seq"]
        coll = self.doc.collection("visits")
        if annotator_id is None:
            snaps = list(coll.order_by("opened_at", direction=firestore.Query.DESCENDING).limit(int(limit))
                         .select(fields).stream())
        else:  # filtered here rather than sorted by Firestore, which would need a composite index
            q = coll.where(filter=FieldFilter("annotator_id", "==", str(annotator_id).upper())).select(fields)
            snaps = sorted(q.stream(), key=lambda s: (s.to_dict() or {}).get("opened_at", ""), reverse=True)
            snaps = snaps[: int(limit)]
        out = []
        for s in snaps:
            d = s.to_dict() or {}
            out.append({"visit_id": s.id, "annotator_id": d.get("annotator_id", ""), "mode": d.get("mode", ""),
                        "context_id": d.get("context_id", ""), "started_at": d.get("opened_at", ""),
                        "closed_at": d.get("closed_at") or None, "n_events": int(d.get("seq", 0))})
        return out

    def _visit_snap(self, visit_id: str) -> Any:
        snap = self.doc.collection("visits").document(visit_id).get() if re.fullmatch(r"[0-9a-f]{32}", str(visit_id)) \
            else None
        if snap is None or not snap.exists:
            raise StoreError(f"Unknown visit {visit_id}")
        return snap

    def visit_log(self, visit_id: str, *, from_seq: int = 0, limit: int = 4000) -> dict[str, Any]:
        snap = self._visit_snap(visit_id)
        d = snap.to_dict() or {}
        batches = snap.reference.collection("batches")
        # Only the batches that hold the page are read (their sizes first, without the events).
        heads = sorted(((int((b.to_dict() or {}).get("first_seq", 0)), int((b.to_dict() or {}).get("n", 0)), b.id)
                        for b in batches.select(["first_seq", "n"]).stream()))
        wanted, n = [], 0
        for first, count, bid in heads:
            last = first + count - 1
            if last < from_seq:
                continue
            wanted.append(bid)
            n += last - max(first, int(from_seq)) + 1
            if n > int(limit):  # at least one event past the page: page_of finds where the next page starts
                break
        events: list[dict[str, Any]] = []
        if wanted:
            for b in self.client.get_all([batches.document(bid) for bid in wanted]):
                events.extend(unpack((b.to_dict() or {})["blob"]))
        page, nxt = page_of(events, int(from_seq), int(limit))
        return {"header": json.loads(d.get("header_json") or "{}"), "events": page, "next_seq": nxt}

    def visit_index(self, visit_id: str) -> list[dict[str, Any]]:
        try:
            snap = self._visit_snap(visit_id)
        except StoreError:
            return []
        d = snap.to_dict() or {}
        if isinstance(d.get("recordings"), list):
            return [dict(r) for r in d["recordings"]]
        events: list[dict[str, Any]] = []  # a visit opened before the index existed: read through its log
        for b in snap.reference.collection("batches").order_by("first_seq").stream():
            events.extend(unpack((b.to_dict() or {})["blob"]))
        events.sort(key=lambda e: int(e.get("seq", 0)))
        return index_rows([], events, str(d.get("context_id") or ""))

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
