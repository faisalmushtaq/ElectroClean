"""Datasets, collections, groups and hand-outs (docs/web/api.md, "Datasets, collections, groups and hand-outs").

A study recording belongs to one *source dataset* (``registration.dataset_id`` in its manifest; none means the
built-in default dataset, :data:`DEFAULT_DATASET_ID`, which has a record only once it is edited, so no manifest is
ever rewritten for it). A *collection* is a hand-picked, ordered list of study recordings from any datasets, a
*group* a named set of people with the history of who joined and left, and a *hand-out* gives a dataset or a
collection to people and groups: everyone gets all of it (ordinary assignments carrying the hand-out's ID), or it
is shared out k per recording through the Tasks section's own :meth:`~electrotag.web.tasks.Tasks.plan` and
:meth:`~electrotag.web.tasks.Tasks.op_create`. Every record is kept with :meth:`Store.update_record` and never
deleted; a dataset, collection or group that is removed is marked ``removed`` and left out of the lists.

Annotators see a hand-out only by its title (:func:`default_title`): the names, descriptions and notes of datasets
and collections, and the team's note on a hand-out, never leave the admin area. Statuses and counts are derived
from the assignments, the completion register, the drafts, the visit index and the reports of recordings that
cannot be annotated (:class:`Progress`); nothing of them is stored.
"""

from __future__ import annotations

import hashlib
import re
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import TYPE_CHECKING, Any

from electrotag.app.common import now_local_iso
from electrotag.web import audit
from electrotag.web.errors import ApiError
from electrotag.web.manifest import SCOPE_STUDY, dataset_of
from electrotag.web.store import StoreError, TooManyAssignments, User, item_key

if TYPE_CHECKING:
    from electrotag.web.service import StudyService

#: The built-in dataset of the recordings registered without one (it has a record only once it is edited).
DEFAULT_DATASET_ID = "study-recordings"
DEFAULT_DATASET_NAME = "Study recordings"
DEFAULT_DATASET_DESCRIPTION = ("Recordings registered before datasets existed, and those added without choosing "
                               "one.")
DATASET_SCHEMA, COLLECTION_SCHEMA = "electrotag.dataset", "electrotag.collection"
GROUP_SCHEMA, HANDOUT_SCHEMA = "electrotag.group", "electrotag.handout"
#: The IDs a study team may choose for a dataset, collection or group (a record's ID: no dots).
CHOSEN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
REQUEST_RE = re.compile(r"^[0-9a-f]{32}$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STATES = ("active", "archived")
#: The details of a dataset and how long each may be.
DATASET_TEXT = {"name": 120, "description": 5000, "origin": 500, "licence": 200, "citation": 2000, "contact": 200,
                "notes": 5000}
#: How many people's saved ratings make a recording "rated" (decision 3 of the project lead), and the range.
RATINGS_TARGET, RATINGS_MIN, RATINGS_MAX = 2, 1, 20
MAX_COLLECTION = 2000
MAX_GROUP_MEMBERS, MAX_GROUP_HISTORY = 200, 1000
#: The changes kept in a record's ``changes`` (the audit log keeps every one).
CHANGES_KEPT = 100
#: The pairs linked to a hand-out (assignments it found and did not make) that its record keeps; past this, a
#: withdrawal keeps every assignment of the hand-out, so that nobody loses one the hand-out did not give.
MAX_LINKED = 5000
MODES = ("all", "k")
TARGET_KINDS = ("dataset", "collection")


def _bad(message: str, code: str = "bad_request") -> ApiError:
    return ApiError(400, code, message)


def _now() -> str:
    return now_local_iso()


def today() -> date:
    """The study's local date (a hand-out is overdue from the day after its due date)."""
    return datetime.fromisoformat(_now()).date()


def _hex(*parts: str, n: int = 10) -> str:
    return hashlib.sha256(":".join(parts).encode()).hexdigest()[:n]


def _request_id(body: dict[str, Any]) -> str:
    rid = body.get("request_id")
    if not isinstance(rid, str) or not REQUEST_RE.match(rid):
        raise _bad("request_id must be 32 hexadecimal characters, made by the browser for this request")
    return rid


def _ratings_target(body: dict[str, Any], default: int | None = RATINGS_TARGET) -> int | None:
    value = body.get("ratings_target", default)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not RATINGS_MIN <= value <= RATINGS_MAX:
        raise _bad(f"ratings_target (the people who should rate each recording) must be a whole number from "
                   f"{RATINGS_MIN} to {RATINGS_MAX}")
    return value


def _state(body: dict[str, Any]) -> str | None:
    state = body.get("state")
    if state is not None and state not in STATES:
        raise _bad("state must be 'active' or 'archived'")
    return state


def _due(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not DAY_RE.match(value):
        raise _bad("due_at must be a date, YYYY-MM-DD, or null")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise _bad("due_at must be a date, YYYY-MM-DD, or null") from exc
    return value


def day_words(day: str) -> str:
    """``20 November`` (a due date as the titles say it)."""
    d = date.fromisoformat(day)
    return f"{d.day} {d.strftime('%B')}"


def default_title(target_kind: str, target_name: str, due_at: str | None) -> str:
    """What annotators see of a hand-out unless the study team says otherwise: a source dataset's name, and for a
    collection "Recordings due 20 November" (or "Recordings to annotate"), so a collection's name never reaches
    them (decision 1 of the project lead)."""
    if target_kind == "dataset":
        return target_name
    return f"Recordings due {day_words(due_at)}" if due_at else "Recordings to annotate"


def prefix_problem(prefix: Any) -> str:
    """Why a ``path_prefix`` cannot be used ("" when it can): a plain relative folder, without ``.`` or ``..``."""
    from electrotag.web.manifest_check import ManifestProblem, safe_relative_path

    if not isinstance(prefix, str):
        return "path_prefix must be text"
    text = prefix.strip().strip("/")
    if not text:
        return ""
    try:
        safe_relative_path(text, "path_prefix")
    except ManifestProblem as exc:
        return str(exc)
    if any(p in (".", "..") for p in text.split("/")) or len(text) > 120:
        return "path_prefix must be a plain relative folder of at most 120 characters, without '.' or '..'"
    return ""


def ratings_by_recording(entries: list[dict[str, str]]) -> dict[str, int]:
    """How many different people have saved each study recording (study mode, a revision counted once per person;
    the derived versions are in their own registers and never counted)."""
    people: dict[str, set[str]] = {}
    for e in entries:
        if e.get("status") == "completed" and e.get("mode", "standard") == "standard" and not e.get("context"):
            people.setdefault(e["recording_id"], set()).add(str(e.get("annotator_id", "")).upper())
    return {rid: len(p) for rid, p in people.items()}


def ratings_histogram(rids: list[str], rated: dict[str, int]) -> dict[str, int]:
    """Recordings by the number of people who saved them: ``{"0", "1", "2", "3+"}``."""
    out = {"0": 0, "1": 0, "2": 0, "3+": 0}
    for rid in rids:
        n = rated.get(rid, 0)
        out["3+" if n >= 3 else str(n)] += 1
    return out


def _changes(record: dict[str, Any], entry: dict[str, Any]) -> list[dict[str, Any]]:
    return ([*record.get("changes", []), entry])[-CHANGES_KEPT:]


def _summary(heads: list[dict[str, Any]]) -> dict[str, Any]:
    """The channel and format summary of a dataset's recordings (derived, never stored)."""
    formats: dict[str, int] = {}
    for h in heads:
        formats[h["format"]] = formats.get(h["format"], 0) + 1
    chans = [h["n_channels"] for h in heads]
    regs = sorted(h["registered_at"] for h in heads if h.get("registered_at"))
    return {"n_recordings": len(heads), "n_retired": sum(1 for h in heads if h["retired"]), "formats": formats,
            "sfreq": sorted({float(h["sfreq"]) for h in heads}),
            "n_channels": {"min": min(chans) if chans else None, "max": max(chans) if chans else None},
            "duration_s": sum(h["n_samples"] / h["sfreq"] for h in heads if h["sfreq"]),
            "size_bytes": sum(int(h.get("size_bytes") or 0) for h in heads),
            "first_registered_at": regs[0] if regs else None, "last_registered_at": regs[-1] if regs else None}


# ------------------------------------------------------------------ progress of hand-outs
@dataclass
class Progress:
    """What has happened to each (person, recording) of the study's own annotation, read once per request:
    saved (by whom), set aside, drafts of the people asked about, and openings."""

    service: StudyService
    saved: dict[tuple[str, str], int] = field(default_factory=dict)  # (aid, rid) -> versions
    unusable: set[tuple[str, str]] = field(default_factory=set)  # (aid, item key) set aside now
    _drafts: dict[str, set[str]] = field(default_factory=dict)
    _opened: set[tuple[str, str]] | None = None

    @classmethod
    def read(cls, service: StudyService) -> Progress:
        p = cls(service)
        for e in service.store.completion_entries():
            if e.get("status") == "completed" and e.get("mode", "standard") == "standard" and not e.get("context"):
                key = (str(e.get("annotator_id", "")).upper(), e["recording_id"])
                p.saved[key] = p.saved.get(key, 0) + 1
        for r in service.store.records("unusable"):
            if r.get("active") and isinstance(r.get("key"), str):
                p.unusable.add((str(r.get("annotator_id", "")).upper(), r["key"]))
        return p

    def is_set_aside(self, aid: str, rid: str) -> bool:
        return (aid, item_key(rid, "standard", "")) in self.unusable

    def in_progress(self, aid: str, rid: str) -> bool:
        if aid not in self._drafts:
            self._drafts[aid] = self.service.store.draft_keys(aid)
        return item_key(rid, "standard", "") in self._drafts[aid]

    def opened(self, aid: str, rid: str) -> bool:
        if self._opened is None:
            self._opened = {(str(o["annotator_id"]).upper(), o["recording_id"])
                            for o in self.service.store.opened_index() if o.get("mode", "standard") == "standard"}
        return (aid, rid) in self._opened

    def finished(self, aid: str, rid: str) -> bool:
        """Saved or set aside: nothing remains to do."""
        return (aid, rid) in self.saved or self.is_set_aside(aid, rid)


def _reads(fn: Any) -> Any:
    """An operation that only reads: the study's register is read once in it (:meth:`Datasets.reading`)."""
    def run(self: Datasets, *args: Any, **kw: Any) -> Any:
        with self.reading():
            return fn(self, *args, **kw)

    run.__name__, run.__doc__ = fn.__name__, fn.__doc__
    return run


# ------------------------------------------------------------------ the operations
class Datasets:
    """The admin operations on datasets, collections, groups and hand-outs (``Admin.op_<name>`` delegates here),
    and what the annotator's own calls need of hand-outs (:meth:`annotator_view`)."""

    def __init__(self, service: StudyService) -> None:
        self.service = service
        self._local = threading.local()

    @property
    def store(self) -> Any:
        return self.service.store

    def _audit(self, user: User, op: str, summary: str, **details: Any) -> None:
        audit.record(self.store, user.annotator_id, op, summary, details)

    # ------------------------------------------------------------- records
    def _records(self, kind: str, *, removed: bool = False) -> list[dict[str, Any]]:
        return [r for r in self.store.records(kind) if removed or r.get("state") != "removed"]

    def _record(self, kind: str, record_id: str) -> dict[str, Any] | None:
        found: list[dict[str, Any]] = []

        def peek(old: dict[str, Any] | None) -> None:
            if old is not None:
                found.append(old)

        try:
            self.store.update_record(kind, record_id, "", peek)
        except StoreError:
            return None
        return found[0] if found else None

    def _put(self, kind: str, record_id: str, change: Any) -> dict[str, Any] | None:
        return self.store.update_record(kind, record_id, "", change)

    def _by_request(self, kind: str, request_id: str) -> dict[str, Any] | None:
        return next((r for r in self.store.records(kind) if r.get("request_id") == request_id), None)

    # ------------------------------------------------------------- datasets
    @contextmanager
    def reading(self) -> Iterator[None]:
        """Within the block, :meth:`heads` reads the study's register once (the lists and counts of hand-outs read
        it for every hand-out otherwise). Only for blocks that do not change the register."""
        outer = getattr(self._local, "heads", None)
        self._local.heads = outer if outer is not None else []
        try:
            yield
        finally:
            if outer is None:
                self._local.heads = None

    def heads(self) -> list[dict[str, Any]]:
        """The study's recordings (light rows; ``dataset_id`` is the effective dataset, never "")."""
        memo = getattr(self._local, "heads", None)
        if memo:
            return memo[0]
        out = []
        for h in self.store.manifest_heads(SCOPE_STUDY):
            out.append({**h, "dataset_id": h.get("dataset_id") or DEFAULT_DATASET_ID})
        out.sort(key=lambda h: h["recording_id"])
        if memo is not None:
            memo.append(out)
        return out

    def dataset_record(self, dataset_id: str) -> dict[str, Any] | None:
        """The stored record of a dataset, the virtual one of the default dataset, or None."""
        rec = self._record("datasets", dataset_id) if CHOSEN_ID_RE.match(dataset_id or "") else None
        if rec is not None and rec.get("state") == "removed":
            return None
        if rec is None and dataset_id == DEFAULT_DATASET_ID:
            rec = self._virtual_default()
        return rec

    @staticmethod
    def _virtual_default() -> dict[str, Any]:
        return {"schema": DATASET_SCHEMA, "schema_version": 1, "dataset_id": DEFAULT_DATASET_ID,
                "name": DEFAULT_DATASET_NAME, "description": DEFAULT_DATASET_DESCRIPTION, "origin": "", "licence": "",
                "citation": "", "contact": "", "notes": "", "path_prefix": "", "ratings_target": RATINGS_TARGET,
                "default": True, "state": "active", "created_at": "", "created_by": "", "updated_at": "",
                "changes": []}

    def all_datasets(self) -> list[dict[str, Any]]:
        recs = {r["dataset_id"]: r for r in self._records("datasets") if r.get("dataset_id")}
        recs.setdefault(DEFAULT_DATASET_ID, self._virtual_default())
        return sorted(recs.values(), key=lambda r: (not r.get("default"), str(r.get("name", "")).lower()))

    def need_dataset(self, dataset_id: Any, *, active: bool = False) -> dict[str, Any]:
        if not isinstance(dataset_id, str) or not dataset_id:
            raise _bad("dataset_id is missing")
        rec = self.dataset_record(dataset_id)
        if rec is None:
            raise ApiError(404, "unknown_dataset", f"This study has no dataset {dataset_id!r}")
        if active and rec.get("state") == "archived":
            raise ApiError(409, "archived", f"The dataset {rec['name']} is archived: make it active again first")
        return rec

    def _dataset_out(self, rec: dict[str, Any], heads: list[dict[str, Any]], rated: dict[str, int],
                     handouts: list[dict[str, Any]]) -> dict[str, Any]:
        did = rec["dataset_id"]
        mine = [h for h in heads if h["dataset_id"] == did]
        live = [h["recording_id"] for h in mine if not h["retired"]]
        target = int(rec.get("ratings_target") or RATINGS_TARGET)
        n_rated = sum(1 for r in live if rated.get(r, 0) >= target)
        return {**{k: rec.get(k, "") for k in ("dataset_id", *DATASET_TEXT, "path_prefix", "created_at",
                                               "created_by", "updated_at")},
                "ratings_target": target, "default": did == DEFAULT_DATASET_ID, "state": rec.get("state", "active"),
                "summary": _summary(mine),
                "n_handouts": sum(1 for h in handouts if h.get("target") == {"kind": "dataset", "id": did}
                                  and h.get("state") == "open"),
                "ratings": ratings_histogram([h["recording_id"] for h in mine], rated), "n_rated": n_rated,
                "fully_rated": bool(live) and n_rated == len(live)}

    def _rows(self, heads: list[dict[str, Any]], rated: dict[str, int]) -> list[dict[str, Any]]:
        given: dict[str, set[str]] = {}
        for a in self.store.assignments():
            if a.mode == "standard":
                given.setdefault(a.recording_id, set()).add(a.annotator_id)
        return [{"recording_id": h["recording_id"], "file_name": h["file_name"], "format": h["format"],
                 "duration_s": h["n_samples"] / h["sfreq"] if h["sfreq"] else 0.0, "n_channels": h["n_channels"],
                 "dataset_id": h["dataset_id"], "retired": h["retired"], "registered_at": h["registered_at"],
                 "n_given": len(given.get(h["recording_id"], ())), "n_rated": rated.get(h["recording_id"], 0)}
                for h in heads]

    @_reads
    def op_datasets_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        state = _state(body)
        heads, rated, handouts = self.heads(), ratings_by_recording(self.store.completion_entries()), \
            self._records("handouts")
        out = [self._dataset_out(r, heads, rated, handouts) for r in self.all_datasets()
               if state is None or r.get("state", "active") == state]
        return {"datasets": out, "default_id": DEFAULT_DATASET_ID}

    @_reads
    def op_dataset_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rec = self.need_dataset(body.get("dataset_id"))
        heads, rated = self.heads(), ratings_by_recording(self.store.completion_entries())
        mine = [h for h in heads if h["dataset_id"] == rec["dataset_id"]]
        return {"dataset": self._dataset_out(rec, heads, rated, self._records("handouts")),
                "recordings": self._rows(mine, rated)}

    def _dataset_fields(self, body: dict[str, Any], *, creating: bool) -> dict[str, Any]:
        from electrotag.web.admin import _text

        out: dict[str, Any] = {}
        for key, limit in DATASET_TEXT.items():
            if creating or body.get(key) is not None:
                out[key] = _text(body, key, required=creating and key == "name", limit=limit)
        if creating or body.get("path_prefix") is not None:
            problem = prefix_problem(body.get("path_prefix") or "")
            if problem:
                raise _bad(problem)
            out["path_prefix"] = str(body.get("path_prefix") or "").strip().strip("/")
        target = _ratings_target(body, RATINGS_TARGET if creating else None)
        if target is not None:
            out["ratings_target"] = target
        if "name" in out and not out["name"]:
            raise _bad("name is missing")
        return out

    def op_dataset_create(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        request_id = _request_id(body)
        done = self._by_request("datasets", request_id)
        if done is not None:
            return {"dataset": self._out_one(done), "already": True}
        fields = self._dataset_fields(body, creating=True)
        did = body.get("dataset_id")
        if did is None:
            base = re.sub(r"[^a-z0-9]+", "-", fields["name"].lower()).strip("-")[:40] or "dataset"
            did = base if self.dataset_record(base) is None and self._record("datasets", base) is None \
                else f"{base}-{_hex(request_id, n=6)}"
        if not isinstance(did, str) or not CHOSEN_ID_RE.match(did):
            raise _bad("dataset_id must be 1 to 64 letters, digits, '-' or '_', starting with a letter or digit")
        if did == DEFAULT_DATASET_ID or self._record("datasets", did) is not None:
            raise ApiError(409, "dataset_exists", f"This study has a dataset with the ID {did} already; choose "
                           "another ID")
        now = _now()
        record = {"schema": DATASET_SCHEMA, "schema_version": 1, "dataset_id": did, **fields, "default": False,
                  "state": "active", "created_at": now, "created_by": user.annotator_id, "request_id": request_id,
                  "updated_at": now, "changes": []}
        kept = self._put("datasets", did, lambda old: record if old is None else None)
        if kept is not None and kept.get("request_id") != request_id:
            raise ApiError(409, "dataset_exists", f"This study has a dataset with the ID {did} already")
        self._audit(user, "dataset_create", f"Made the dataset {fields['name']} ({did})", dataset_id=did,
                    name=fields["name"], path_prefix=fields["path_prefix"], ratings_target=fields["ratings_target"])
        return {"dataset": self._out_one(record), "already": False}

    def _out_one(self, rec: dict[str, Any]) -> dict[str, Any]:
        return self._dataset_out(rec, self.heads(), ratings_by_recording(self.store.completion_entries()),
                                 self._records("handouts"))

    def op_dataset_update(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rec = self.need_dataset(body.get("dataset_id"))
        did = rec["dataset_id"]
        fields = self._dataset_fields(body, creating=False)
        state = _state(body)
        if state is not None:
            if did == DEFAULT_DATASET_ID and state != "active":
                raise ApiError(409, "default_dataset", "The study's built-in dataset stays active: recordings "
                               "registered without a dataset go into it")
            fields["state"] = state
        changed = sorted(k for k, v in fields.items() if rec.get(k, "" if k != "state" else "active") != v)
        if "path_prefix" in changed and did == DEFAULT_DATASET_ID:
            raise ApiError(409, "default_dataset", "The built-in dataset has no prefix: make a new dataset with one")
        if "path_prefix" in changed and any(h["dataset_id"] == did for h in self.heads()):
            raise ApiError(409, "has_recordings", "Recordings are registered in this dataset under its prefix, so "
                           "the prefix stays as it is")
        if not changed:
            return {"dataset": self._out_one(rec), "changed": []}
        now = _now()

        def change(old: dict[str, Any] | None) -> dict[str, Any]:
            base = old if old is not None else {**self._virtual_default(), "created_at": now,
                                                "created_by": user.annotator_id}
            return {**base, **{k: fields[k] for k in changed}, "updated_at": now,
                    "changes": _changes(base, {"at": now, "by": user.annotator_id, "fields": changed})}

        kept = self._put("datasets", did, change) or rec
        self._audit(user, "dataset_update", f"Changed the dataset {kept.get('name', did)}: {', '.join(changed)}",
                    dataset_id=did, fields=changed, state=fields.get("state"))
        return {"dataset": self._out_one(kept), "changed": changed}

    def op_dataset_remove(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rec = self.need_dataset(body.get("dataset_id"))
        did = rec["dataset_id"]
        if did == DEFAULT_DATASET_ID:
            raise ApiError(409, "default_dataset", "The study's built-in dataset cannot be removed")
        n = sum(1 for h in self.heads() if h["dataset_id"] == did)
        if n:
            raise ApiError(409, "not_empty", f"The dataset {rec['name']} holds {audit.count(n, 'recording')}: move "
                           "them to another dataset first, or archive the dataset")
        if any(h.get("state") == "open" and h.get("target") == {"kind": "dataset", "id": did}
               for h in self._records("handouts")):
            raise ApiError(409, "in_use", f"The dataset {rec['name']} has an open hand-out: withdraw it first")
        now = _now()
        self._put("datasets", did, lambda old: {**(old or rec), "state": "removed", "updated_at": now,
                                                 "removed_at": now, "removed_by": user.annotator_id})
        self._audit(user, "dataset_remove", f"Removed the dataset {rec['name']} ({did})", dataset_id=did)
        return {}

    def op_recordings_move(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rids = body.get("recording_ids")
        if not isinstance(rids, list) or not rids or len(rids) > 5000 or not all(isinstance(r, str) for r in rids):
            raise _bad("recording_ids must be a list of the study's recording IDs")
        rec = self.need_dataset(body.get("dataset_id"), active=True)
        did = rec["dataset_id"]
        manifests = {r: self.store.manifest(SCOPE_STUDY, r) for r in dict.fromkeys(rids)}
        unknown = [r for r, m in manifests.items() if m is None]
        if unknown:
            raise ApiError(404, "unknown_recording", "Not registered in the study: " + ", ".join(unknown[:10]))
        moved, already, froms = [], [], set()
        for r, m in manifests.items():
            assert m is not None
            here = dataset_of(m) or DEFAULT_DATASET_ID
            if here == did:
                already.append(r)
                continue
            reg = dict(m.get("registration") or {"registered_at": m.get("created_at", ""), "registered_by": "",
                                                   "registered_via": "command"})
            if did == DEFAULT_DATASET_ID:
                reg.pop("dataset_id", None)
            else:
                reg["dataset_id"] = did
            self.store.add_manifest({**m, "registration": reg})
            moved.append(r)
            froms.add(here)
        if moved:
            self._audit(user, "recordings_move", f"Moved {audit.count(len(moved), 'recording')} to the dataset "
                        f"{rec['name']}", dataset_id=did, recording_ids=moved, from_datasets=sorted(froms))
        return {"moved": moved, "already": already}

    # ------------------------------------------------- registration (admin.py and the command line)
    def registration_target(self, dataset_id: Any) -> tuple[str, str]:
        """The dataset a registration goes into, ``(dataset_id, path_prefix)``: the default dataset when none is
        named; 404 ``unknown_dataset`` and 409 ``archived`` otherwise."""
        if dataset_id is None or dataset_id == "":
            return DEFAULT_DATASET_ID, ""
        rec = self.need_dataset(dataset_id, active=True)
        return rec["dataset_id"], str(rec.get("path_prefix") or "")

    @staticmethod
    def collision(old: dict[str, Any] | None, dataset_id: str) -> str:
        """Why a recording cannot be registered into ``dataset_id`` under its ID ("" when it can): the ID belongs to
        a recording of another dataset, which neither "Already registered" nor ``replace`` may touch."""
        if old is None:
            return ""
        here = dataset_of(old) or DEFAULT_DATASET_ID
        if here == dataset_id:
            return ""
        return (f"Registered already in the dataset {here} under this ID, so it is left as it is (even when "
                "replacing). Register it into a new dataset with a path prefix, which keeps the two apart.")

    def remove_from_collections(self, user: User, recording_id: str) -> list[str]:
        """Take a removed recording out of every collection (``recording_remove``); the collections' IDs."""
        out = []
        now = _now()
        for c in self._records("collections"):
            if recording_id not in c.get("recording_ids", []):
                continue

            def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
                if old is None or recording_id not in old.get("recording_ids", []):
                    return None
                return {**old, "recording_ids": [r for r in old["recording_ids"] if r != recording_id],
                        "updated_at": now, "changes": _changes(old, {"at": now, "by": user.annotator_id, "added": 0,
                                                                     "removed": 1, "reordered": False,
                                                                     "why": "recording_removed"})}

            self._put("collections", c["collection_id"], change)
            out.append(c["collection_id"])
        return out

    # ------------------------------------------------------------- collections
    def need_collection(self, collection_id: Any) -> dict[str, Any]:
        if not isinstance(collection_id, str) or not collection_id:
            raise _bad("collection_id is missing")
        rec = self._record("collections", collection_id) if CHOSEN_ID_RE.match(collection_id) else None
        if rec is None or rec.get("state") == "removed":
            raise ApiError(404, "unknown_collection", f"This study has no collection {collection_id!r}")
        return rec

    def _collection_out(self, rec: dict[str, Any], heads: dict[str, dict[str, Any]], rated: dict[str, int], *,
                        ids: bool = False) -> dict[str, Any]:
        rids = list(rec.get("recording_ids", []))
        present = [heads[r] for r in rids if r in heads]
        live = [h["recording_id"] for h in present if not h["retired"]]
        target = int(rec.get("ratings_target") or RATINGS_TARGET)
        datasets: dict[str, int] = {}
        for h in present:
            datasets[h["dataset_id"]] = datasets.get(h["dataset_id"], 0) + 1
        n_rated = sum(1 for r in live if rated.get(r, 0) >= target)
        out = {"collection_id": rec["collection_id"], "name": rec.get("name", ""),
               "description": rec.get("description", ""), "ratings_target": target, "n_recordings": len(rids),
               "n_missing": len(rids) - len(present), "n_retired": len(present) - len(live), "datasets": datasets,
               "built_from": rec.get("built_from"), "state": rec.get("state", "active"),
               "created_at": rec.get("created_at", ""), "created_by": rec.get("created_by", ""),
               "updated_at": rec.get("updated_at", ""), "changes": list(rec.get("changes", [])),
               "ratings": ratings_histogram(rids, rated), "n_rated": n_rated,
               "fully_rated": bool(live) and n_rated == len(live)}
        if ids:
            out["recording_ids"] = rids
        return out

    def _heads_by_id(self) -> dict[str, dict[str, Any]]:
        return {h["recording_id"]: h for h in self.heads()}

    @_reads
    def op_collections_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        heads, rated = self._heads_by_id(), ratings_by_recording(self.store.completion_entries())
        recs = sorted(self._records("collections"), key=lambda r: str(r.get("name", "")).lower())
        return {"collections": [self._collection_out(r, heads, rated) for r in recs]}

    @_reads
    def op_collection_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rec = self.need_collection(body.get("collection_id"))
        heads, rated = self._heads_by_id(), ratings_by_recording(self.store.completion_entries())
        return {"collection": self._collection_out(rec, heads, rated, ids=True),
                "recordings": self._rows([heads[r] for r in rec.get("recording_ids", []) if r in heads], rated)}

    @staticmethod
    def _rid_list(value: Any, what: str) -> list[str]:
        if not isinstance(value, list) or not all(isinstance(r, str) and 0 < len(r) <= 512 for r in value):
            raise _bad(f"{what} must be a list of recording IDs")
        if len(value) > MAX_COLLECTION:
            raise ApiError(413, "too_large", f"A collection holds at most {MAX_COLLECTION:,} recordings")
        return list(value)

    @staticmethod
    def _built_from(value: Any) -> dict[str, Any] | None:
        import json

        if value is None:
            return None
        if not isinstance(value, dict) or len(json.dumps(value)) > 4000:
            raise _bad("built_from must be an object describing the filters (at most 4,000 characters)")
        return value

    def op_collection_create(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.web.admin import _text

        request_id = _request_id(body)
        done = self._by_request("collections", request_id)
        heads, rated = self._heads_by_id(), ratings_by_recording(self.store.completion_entries())
        if done is not None:
            return {"collection": self._collection_out(done, heads, rated, ids=True), "skipped": [], "already": True}
        name = _text(body, "name", required=True, limit=120)
        description = _text(body, "description", limit=5000)
        target = _ratings_target(body)
        wanted = self._rid_list(body.get("recording_ids"), "recording_ids")
        cid = body.get("collection_id")
        if cid is None:
            cid = f"c-{_hex(request_id)}"
        if not isinstance(cid, str) or not CHOSEN_ID_RE.match(cid):
            raise _bad("collection_id must be 1 to 64 letters, digits, '-' or '_'")
        if self._record("collections", cid) is not None:
            raise ApiError(409, "collection_exists", f"This study has a collection with the ID {cid} already")
        kept_ids, skipped, seen = [], [], set()
        for r in wanted:
            if r in seen:
                skipped.append({"recording_id": r, "reason": "twice"})
            elif r not in heads:
                skipped.append({"recording_id": r, "reason": "not_registered"})
            else:
                kept_ids.append(r)
            seen.add(r)
        now = _now()
        record = {"schema": COLLECTION_SCHEMA, "schema_version": 1, "collection_id": cid, "name": name,
                  "description": description, "ratings_target": target, "recording_ids": kept_ids,
                  "built_from": self._built_from(body.get("built_from")), "state": "active", "created_at": now,
                  "created_by": user.annotator_id, "request_id": request_id, "updated_at": now, "changes": []}
        self._put("collections", cid, lambda old: record if old is None else None)
        self._audit(user, "collection_create", f"Made the collection {name} of "
                    f"{audit.count(len(kept_ids), 'recording')}", collection_id=cid, n_recordings=len(kept_ids),
                    skipped=[s["recording_id"] for s in skipped])
        return {"collection": self._collection_out(record, heads, rated, ids=True), "skipped": skipped,
                "already": False}

    def op_collection_update(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.web.admin import _text

        rec = self.need_collection(body.get("collection_id"))
        heads = self._heads_by_id()
        new: dict[str, Any] = {}
        for key, limit in (("name", 120), ("description", 5000)):
            if body.get(key) is not None:
                new[key] = _text(body, key, required=key == "name", limit=limit)
        target = _ratings_target(body, None)
        if target is not None:
            new["ratings_target"] = target
        state = _state(body)
        if state is not None:
            new["state"] = state
        ids = list(rec.get("recording_ids", []))
        added = removed = 0
        reordered = False
        if body.get("remove") is not None:
            drop = set(self._rid_list(body["remove"], "remove"))
            removed = sum(1 for r in ids if r in drop)
            ids = [r for r in ids if r not in drop]
        if body.get("add") is not None:
            add = self._rid_list(body["add"], "add")
            unknown = [r for r in add if r not in heads]
            if unknown:
                raise ApiError(404, "unknown_recording", "Not registered in the study: " + ", ".join(unknown[:10]))
            for r in add:
                if r not in ids:
                    ids.append(r)
                    added += 1
        if body.get("order") is not None:
            order = self._rid_list(body["order"], "order")
            if sorted(order) != sorted(ids) or len(set(order)) != len(order):
                raise _bad("order must hold the collection's recordings, each once, in their new order")
            reordered = order != ids
            ids = order
        if len(ids) > MAX_COLLECTION:
            raise ApiError(413, "too_large", f"A collection holds at most {MAX_COLLECTION:,} recordings")
        changed = sorted(k for k, v in new.items() if rec.get(k) != v)
        if added or removed or reordered:
            changed.append("recordings")
        rated = ratings_by_recording(self.store.completion_entries())
        if not changed:
            return {"collection": self._collection_out(rec, heads, rated, ids=True), "changed": []}
        now = _now()

        def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
            if old is None:
                return None
            return {**old, **new, "recording_ids": ids, "updated_at": now,
                    "changes": _changes(old, {"at": now, "by": user.annotator_id, "added": added, "removed": removed,
                                              "reordered": reordered, "fields": [c for c in changed
                                                                                 if c != "recordings"]})}

        kept = self._put("collections", rec["collection_id"], change) or rec
        self._audit(user, "collection_update", f"Changed the collection {kept.get('name')}: "
                    + ", ".join(changed), collection_id=rec["collection_id"], fields=changed, added=added,
                    removed=removed, reordered=reordered)
        return {"collection": self._collection_out(kept, heads, rated, ids=True), "changed": changed}

    def op_collection_remove(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rec = self.need_collection(body.get("collection_id"))
        cid = rec["collection_id"]
        if any(h.get("state") == "open" and h.get("target") == {"kind": "collection", "id": cid}
               for h in self._records("handouts")):
            raise ApiError(409, "in_use", f"The collection {rec.get('name')} has an open hand-out: withdraw it first")
        now = _now()
        self._put("collections", cid, lambda old: {**(old or rec), "state": "removed", "updated_at": now,
                                                    "removed_at": now, "removed_by": user.annotator_id})
        self._audit(user, "collection_remove", f"Removed the collection {rec.get('name')}", collection_id=cid)
        return {}

    # ------------------------------------------------------------- groups
    @staticmethod
    def members(group: dict[str, Any]) -> list[str]:
        """The group's current members (history rows not yet closed), in the order they joined."""
        return list(dict.fromkeys(r["annotator_id"] for r in group.get("history", []) if not r.get("removed_at")))

    def need_group(self, group_id: Any) -> dict[str, Any]:
        if not isinstance(group_id, str) or not group_id:
            raise _bad("group_id is missing")
        rec = self._record("groups", group_id) if CHOSEN_ID_RE.match(group_id) else None
        if rec is None or rec.get("state") == "removed":
            raise ApiError(404, "unknown_group", f"This study has no group {group_id!r}")
        return rec

    def _group_out(self, rec: dict[str, Any]) -> dict[str, Any]:
        return {"group_id": rec["group_id"], "name": rec.get("name", ""), "description": rec.get("description", ""),
                "state": rec.get("state", "active"), "members": self.members(rec),
                "history": [dict(r) for r in rec.get("history", [])], "created_at": rec.get("created_at", ""),
                "created_by": rec.get("created_by", "")}

    def _people(self, value: Any, what: str) -> list[str]:
        from electrotag.web.admin import _ids

        aids = _ids(value, what, minimum=0)
        for aid in aids:
            if self.store.user_record(aid) is None:
                raise ApiError(404, "unknown_user", f"{aid} has no account in this study")
        return aids

    def op_groups_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        recs = sorted(self._records("groups"), key=lambda r: str(r.get("name", "")).lower())
        return {"groups": [self._group_out(r) for r in recs]}

    def op_group_create(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.web.admin import _text

        request_id = _request_id(body)
        done = self._by_request("groups", request_id)
        if done is not None:
            return {"group": self._group_out(done), "already": True}
        name = _text(body, "name", required=True, limit=120)
        description = _text(body, "description", limit=2000)
        members = self._people(body.get("members", []), "members")
        if len(members) > MAX_GROUP_MEMBERS:
            raise ApiError(413, "too_large", f"A group holds at most {MAX_GROUP_MEMBERS} people")
        gid = body.get("group_id")
        if gid is None:
            gid = f"g-{_hex(request_id)}"
        if not isinstance(gid, str) or not CHOSEN_ID_RE.match(gid):
            raise _bad("group_id must be 1 to 64 letters, digits, '-' or '_'")
        if self._record("groups", gid) is not None:
            raise ApiError(409, "group_exists", f"This study has a group with the ID {gid} already")
        now = _now()
        record = {"schema": GROUP_SCHEMA, "schema_version": 1, "group_id": gid, "name": name,
                  "description": description, "state": "active",
                  "history": [{"annotator_id": a, "added_at": now, "added_by": user.annotator_id, "removed_at": None,
                               "removed_by": None} for a in members],
                  "created_at": now, "created_by": user.annotator_id, "request_id": request_id, "updated_at": now}
        self._put("groups", gid, lambda old: record if old is None else None)
        self._audit(user, "group_create", f"Made the group {name}" + (f" of {', '.join(members[:10])}"
                                                                      if members else ""),
                    group_id=gid, members=members)
        return {"group": self._group_out(record), "already": False}

    def op_group_update(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.web.admin import _bool, _text

        rec = self.need_group(body.get("group_id"))
        gid = rec["group_id"]
        new: dict[str, Any] = {}
        for key, limit in (("name", 120), ("description", 2000)):
            if body.get(key) is not None:
                new[key] = _text(body, key, required=key == "name", limit=limit)
        state = _state(body)
        if state is not None:
            new["state"] = state
        give = _bool(body, "give_existing")
        give = True if give is None else give
        current = self.members(rec)
        add = [a for a in self._people(body.get("add", []), "add") if a not in current]
        drop = [a for a in self._people(body.get("remove", []), "remove") if a in current]
        if len(current) + len(add) - len(drop) > MAX_GROUP_MEMBERS:
            raise ApiError(413, "too_large", f"A group holds at most {MAX_GROUP_MEMBERS} people")
        if len(rec.get("history", [])) + len(add) > MAX_GROUP_HISTORY:
            raise ApiError(413, "too_large", f"A group keeps at most {MAX_GROUP_HISTORY} rows of history; make a new "
                           "group")
        changed = sorted(k for k, v in new.items() if rec.get(k, "active" if k == "state" else "") != v)
        if add:
            changed.append("added")
        if drop:
            changed.append("removed")
        if not changed:
            return {"group": self._group_out(rec), "changed": [], "given": []}
        now = _now()

        def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
            if old is None:
                return None
            history = [dict(r) for r in old.get("history", [])]
            for r in history:
                if r["annotator_id"] in drop and not r.get("removed_at"):
                    r.update(removed_at=now, removed_by=user.annotator_id)
            history += [{"annotator_id": a, "added_at": now, "added_by": user.annotator_id, "removed_at": None,
                         "removed_by": None} for a in add]
            return {**old, **new, "history": history, "updated_at": now}

        kept = self._put("groups", gid, change) or rec
        given: list[dict[str, Any]] = []
        if add and give and kept.get("state", "active") == "active":
            given = self._follow(user, gid, add)
        self._audit(user, "group_update", f"Changed the group {kept.get('name')}"
                    + (f": added {', '.join(add[:10])}" if add else "")
                    + (f"; took out {', '.join(drop[:10])}" if drop else "")
                    + (f"; gave {audit.count(sum(g['added'] for g in given), 'recording')} of "
                       f"{audit.count(len({g['handout_id'] for g in given}), 'hand-out')}" if given else ""),
                    group_id=gid, fields=changed, added=add, removed=drop,
                    given=[{k: g[k] for k in ("handout_id", "annotator_id", "added")} for g in given])
        return {"group": self._group_out(kept), "changed": changed, "given": given}

    def op_group_remove(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rec = self.need_group(body.get("group_id"))
        gid = rec["group_id"]
        if any(h.get("state") == "open" and gid in h.get("groups", []) for h in self._records("handouts")):
            raise ApiError(409, "in_use", f"An open hand-out names the group {rec.get('name')}: withdraw it first")
        now = _now()
        self._put("groups", gid, lambda old: {**(old or rec), "state": "removed", "updated_at": now,
                                               "removed_at": now, "removed_by": user.annotator_id})
        self._audit(user, "group_remove", f"Removed the group {rec.get('name')}", group_id=gid)
        return {}

    def account_removed(self, annotator_id: str) -> list[str]:
        """Close the open rows of a person whose account was removed (``user_remove``); the groups' IDs."""
        out = []
        now = _now()
        for g in self._records("groups"):
            if annotator_id not in self.members(g):
                continue

            def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
                if old is None:
                    return None
                history = [dict(r) for r in old.get("history", [])]
                for r in history:
                    if r["annotator_id"] == annotator_id and not r.get("removed_at"):
                        r.update(removed_at=now, removed_by="account removed")
                return {**old, "history": history, "updated_at": now}

            self._put("groups", g["group_id"], change)
            out.append(g["group_id"])
        return out

    # ------------------------------------------------------------- hand-outs
    def need_handout(self, handout_id: Any) -> dict[str, Any]:
        if not isinstance(handout_id, str) or not re.fullmatch(r"h-[0-9a-f]{10}", handout_id):
            raise ApiError(404, "unknown_handout", "This study has no such hand-out")
        rec = self._record("handouts", handout_id)
        if rec is None:
            raise ApiError(404, "unknown_handout", f"This study has no hand-out {handout_id}")
        return rec

    def target_of(self, target: Any, *, active: bool = True) -> dict[str, Any]:
        """``{"kind", "id", "name", "rids": every recording of it, in order}`` (the dataset's by ID)."""
        if not isinstance(target, dict) or target.get("kind") not in TARGET_KINDS:
            raise _bad("target must be {\"kind\": \"dataset\" or \"collection\", \"id\"}")
        if target["kind"] == "dataset":
            rec = self.need_dataset(target.get("id"), active=active)
            rids = [h["recording_id"] for h in self.heads() if h["dataset_id"] == rec["dataset_id"]]
            return {"kind": "dataset", "id": rec["dataset_id"], "name": rec.get("name", ""), "rids": rids}
        rec = self.need_collection(target.get("id"))
        if active and rec.get("state") == "archived":
            raise ApiError(409, "archived", f"The collection {rec.get('name')} is archived: make it active again first")
        return {"kind": "collection", "id": rec["collection_id"], "name": rec.get("name", ""),
                "rids": list(rec.get("recording_ids", []))}

    def _live(self, rids: list[str]) -> tuple[list[str], list[dict[str, str]]]:
        """The recordings of a target that can be handed out now, and the others with the reason."""
        heads = self._heads_by_id()
        live, skipped = [], []
        for r in rids:
            if r not in heads:
                skipped.append({"recording_id": r, "reason": "not_registered"})
            elif heads[r]["retired"]:
                skipped.append({"recording_id": r, "reason": "retired"})
            else:
                live.append(r)
        return live, skipped

    def _recipients(self, people: list[str], groups: list[str]) -> tuple[list[tuple[str, str]], list[str]]:
        """``[(annotator_id, via)]``: the people named, then the active members of the groups; and warnings about
        members left out because their accounts are switched off."""
        out: dict[str, str] = {}
        for aid in people:
            rec = self.store.user_record(aid)
            if rec is not None and rec.get("status", "active") != "active":
                raise ApiError(409, "disabled", f"{aid}'s account is switched off; switch it on, or leave {aid} out")
            out[aid] = "person"
        off = []
        for gid in groups:
            g = self.need_group(gid)
            if g.get("state") == "archived":
                raise ApiError(409, "archived", f"The group {g.get('name')} is archived")
            for aid in self.members(g):
                rec = self.store.user_record(aid)
                if rec is None:
                    continue
                if rec.get("status", "active") != "active":
                    off.append(aid)
                    continue
                out.setdefault(aid, f"group:{gid}")
        warnings = ([f"{', '.join(sorted(set(off))[:10])} {'is' if len(set(off)) == 1 else 'are'} in a chosen group "
                     "but switched off, so left out."] if off else [])
        return list(out.items()), warnings

    def _request(self, body: dict[str, Any]) -> dict[str, Any]:
        """A checked ``HandoutRequest``."""
        from electrotag.web.admin import _bool, _text
        from electrotag.web.tasks import K_MAX, K_MIN

        target = self.target_of(body.get("target"))
        people = self._people(body.get("people", []), "people")
        groups = body.get("groups", [])
        if not isinstance(groups, list) or not all(isinstance(g, str) for g in groups) \
                or len(set(groups)) != len(groups):
            raise _bad("groups must be a list of group IDs, each once")
        mode = body.get("mode", "all")
        if mode not in MODES:
            raise _bad("mode must be 'all' (everyone gets all of it) or 'k' (each recording to k people)")
        k = None
        if mode == "k":
            k = body.get("k", int(self.service.settings.review.k_default))
            if isinstance(k, bool) or not isinstance(k, int) or not K_MIN <= k <= K_MAX:
                raise _bad(f"k (people per recording) must be a whole number from {K_MIN} to {K_MAX}")
        due_at = _due(body.get("due_at"))
        recipients, warnings = self._recipients(people, groups)
        if not recipients:
            raise _bad("Choose the people or groups to give it to")
        follow = _bool(body, "follow_groups") or False
        name = _text(body, "name", limit=120) or target["name"]
        title = _text(body, "title", limit=120) or default_title(target["kind"], target["name"], due_at)
        return {"target": target, "people": people, "groups": list(groups), "mode": mode, "k": k, "due_at": due_at,
                "recipients": recipients, "warnings": warnings, "follow_groups": follow and mode == "all",
                "name": name, "title": title, "note": _text(body, "note", limit=2000)}

    def _held(self) -> dict[str, dict[str, tuple[str, str]]]:
        """aid -> rid -> (task_id, handout_id) of every study assignment."""
        out: dict[str, dict[str, tuple[str, str]]] = {}
        for a in self.store.assignments():
            if a.mode == "standard":
                out.setdefault(a.annotator_id.upper(), {})[a.recording_id] = (a.task_id, a.handout_id)
        return out

    @staticmethod
    def _tasks_body(req: dict[str, Any], rids: list[str], request_id: str | None = None) -> dict[str, Any]:
        body = {"annotator_ids": [a for a, _via in req["recipients"]], "recording_ids": rids, "k": req["k"],
                "batch": req["name"][:80], "notes": req["note"][:1000]}
        if request_id is not None:
            body["request_id"] = request_id
        return body

    @_reads
    def op_handouts_preview_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        req = self._request(body)
        live, skipped = self._live(req["target"]["rids"])
        standing = self.service.tasks._standing([a for a, _v in req["recipients"]])
        warnings = list(req["warnings"])
        if req["mode"] == "k":
            preview = self.service.tasks.op_preview(user, self._tasks_body(req, live)) if live else None
            per = {p["annotator_id"]: p for p in (preview or {}).get("per_annotator", [])}
            recipients = []
            for a, via in req["recipients"]:
                mine = per.get(a, {})
                recipients.append({"annotator_id": a, "via": via, "new": mine.get("new", 0) - mine.get("linked", 0),
                                   "already": mine.get("linked", 0), **standing[a]})
            if preview is not None:
                skipped += preview["skipped"]
                warnings += preview["warnings"]
                has_task = sum(1 for s in preview["skipped"] if s.get("reason") == "has_task")
                if has_task:
                    warnings.append(f"{audit.count(has_task, 'recording')} {'has' if has_task == 1 else 'have'} an "
                                    "open task already, so the share-out leaves them out. Close those tasks first "
                                    "to share them out again.")
            return {"recipients": recipients, "recordings": len(live), "skipped": skipped, "tasks_preview": preview,
                    "warnings": warnings}
        held = self._held()
        recipients = []
        for a, via in req["recipients"]:
            mine = held.get(a, {})
            have = sum(1 for r in live if r in mine)
            recipients.append({"annotator_id": a, "via": via, "new": len(live) - have, "already": have, **standing[a]})
        warnings += self.service.tasks._warnings(recipients)
        return {"recipients": recipients, "recordings": len(live), "skipped": skipped, "tasks_preview": None,
                "warnings": warnings}

    def _give_all(self, hid: str, aid: str, rids: list[str], held: dict[str, tuple[str, str]]) -> tuple[int, list[str]]:
        """Give one person the recordings of an "all" hand-out; (how many were added, the IDs linked)."""
        linked = [r for r in rids if r in held and not held[r][1]]
        try:
            added = self.store.assign_many(aid, [(r, "") for r in rids], handout_id=hid) if rids else 0
        except TooManyAssignments as exc:
            raise ApiError(413, "too_many_assignments", f"{exc} Give them fewer recordings, or share the recordings "
                           "out k per recording instead.") from exc
        return added, linked

    def _note_linked(self, record: dict[str, Any], aid: str, linked: list[str]) -> None:
        if not linked or record.get("linked_overflow"):
            return
        mine = record.setdefault("linked", {})
        mine[aid] = sorted(set(mine.get(aid, [])) | set(linked))
        if sum(len(v) for v in mine.values()) > MAX_LINKED:
            record["linked"], record["linked_overflow"] = {}, True

    def op_handout_create(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        request_id = _request_id(body)
        hid = f"h-{_hex(request_id)}"
        done = self._record("handouts", hid)
        if done is not None and done.get("request_id") == request_id:
            return self._again(user, done)
        req = self._request(body)
        live, skipped = self._live(req["target"]["rids"])
        now = _now()
        record: dict[str, Any] = {
            "schema": HANDOUT_SCHEMA, "schema_version": 1, "handout_id": hid, "name": req["name"],
            "title": req["title"], "target": {"kind": req["target"]["kind"], "id": req["target"]["id"]},
            "mode": req["mode"], "k": req["k"], "people": req["people"], "groups": req["groups"],
            "follow_groups": req["follow_groups"], "due_at": req["due_at"], "note": req["note"], "state": "open",
            "handed_out_at": now, "handed_out_by": user.annotator_id, "request_id": request_id,
            "task_request_id": _hex(request_id, "tasks", n=32) if req["mode"] == "k" else None,
            "recipients": [{"annotator_id": a, "via": via, "given_at": now, "given_by": user.annotator_id,
                            "added": 0, "already": 0} for a, via in req["recipients"]],
            "changes": []}
        self._put("handouts", hid, lambda old: record if old is None else None)
        tasks = None
        added = already = 0
        if req["mode"] == "all":
            held = self._held()
            for row in record["recipients"]:
                n, linked = self._give_all(hid, row["annotator_id"], live, held.get(row["annotator_id"], {}))
                row["added"], row["already"] = n, len(live) - n
                self._note_linked(record, row["annotator_id"], linked)
                added += n
                already += len(live) - n
        elif live:
            tasks = self.service.tasks.op_create(user, self._tasks_body(req, live, record["task_request_id"]),
                                                 handout_id=hid)
            skipped += tasks["skipped"]
            per = {p["annotator_id"]: p for p in tasks["per_annotator"]}
            for row in record["recipients"]:
                p = per.get(row["annotator_id"], {})
                row["added"], row["already"] = p.get("new", 0) - p.get("linked", 0), p.get("linked", 0)
            added = tasks["assigned"]
            already = sum(r["already"] for r in record["recipients"])
        self._put("handouts", hid, lambda old: {**(old or record), "recipients": record["recipients"],
                                                 "linked": record.get("linked", {}),
                                                 "linked_overflow": record.get("linked_overflow", False)})
        people = [a for a, _v in req["recipients"]]
        how = "to everyone" if req["mode"] == "all" else f"shared out {req['k']} per recording"
        self._audit(user, "handout_create", f"Handed out {req['target']['kind']} {req['target']['name']} ({how}) to "
                    f"{', '.join(people[:6])}{' …' if len(people) > 6 else ''}: "
                    f"{audit.count(added, 'new assignment')}", handout_id=hid, target=record["target"],
                    mode=req["mode"], k=req["k"], annotator_ids=people, groups=req["groups"], due_at=req["due_at"],
                    added=added, already=already, skipped=[s["recording_id"] for s in skipped],
                    note_chars=len(req["note"]))
        return {"handout": self.handout_out(self._record("handouts", hid) or record), "added": added,
                "already_had": already, "skipped": skipped, "tasks": tasks, "already": False}

    def _again(self, user: User, record: dict[str, Any]) -> dict[str, Any]:
        """``handout_create`` sent again (a late answer): the hand-out kept, with anything still missing given."""
        tasks = None
        if record.get("state") == "open":
            if record["mode"] == "all":
                live, _skipped = self._live(self.target_of(record["target"], active=False)["rids"])
                for row in record.get("recipients", []):
                    self.store.assign_many(row["annotator_id"], [(r, "") for r in live],
                                           handout_id=record["handout_id"])
            elif record.get("task_request_id"):
                live, _skipped = self._live(self.target_of(record["target"], active=False)["rids"])
                req = {"recipients": [(r["annotator_id"], r["via"]) for r in record.get("recipients", [])],
                       "k": record["k"], "name": record.get("name", ""), "note": record.get("note", "")}
                if live:
                    tasks = self.service.tasks.op_create(user, self._tasks_body(req, live, record["task_request_id"]),
                                                         handout_id=record["handout_id"])
        return {"handout": self.handout_out(record), "added": 0, "already_had": 0, "skipped": [], "tasks": tasks,
                "already": True}

    # ------------------------------------------------------------- what a hand-out covers
    def covered(self, record: dict[str, Any], *, held: dict[str, dict[str, tuple[str, str]]] | None = None,
                tasks: list[dict[str, Any]] | None = None,
                target_rids: list[str] | None = None) -> dict[str, list[str]]:
        """The (person, recording) pairs a hand-out covers, by person: in "all" mode its recipients' assignments of
        the target's recordings (however they were made), in k mode the people of its tasks. Derived, never
        stored."""
        hid = record["handout_id"]
        out: dict[str, list[str]] = {}
        if record.get("mode") == "k":
            for t in tasks if tasks is not None else self.service.tasks.all():
                if t.get("handout_id") == hid:
                    for aid in t.get("annotators", []):
                        out.setdefault(aid, []).append(t["recording_id"])
            return out
        held = held if held is not None else self._held()
        if target_rids is None:
            try:
                target_rids = self.target_of(record["target"], active=False)["rids"]
            except ApiError:
                target_rids = []
        rids = set(target_rids)
        for row in record.get("recipients", []):
            aid = row["annotator_id"]
            mine = held.get(aid, {})
            out[aid] = sorted({r for r in mine if r in rids} | {r for r, (_t, h) in mine.items() if h == hid})
        return out

    def new_recordings(self, record: dict[str, Any], covered: dict[str, list[str]],
                       target_rids: list[str] | None = None) -> list[str]:
        """The target's recordings that can be handed out and that the hand-out has not given yet."""
        if target_rids is None:
            try:
                target_rids = self.target_of(record["target"], active=False)["rids"]
            except ApiError:
                return []
        live, _skipped = self._live(target_rids)
        if record.get("mode") == "k":
            given = {r for rs in covered.values() for r in rs}
            return [r for r in live if r not in given]
        people = [row["annotator_id"] for row in record.get("recipients", [])]
        have = {a: set(covered.get(a, [])) for a in people}
        return [r for r in live if any(r not in have[a] for a in people)]

    def handout_out(self, record: dict[str, Any], progress: Progress | None = None, *,
                    held: dict[str, dict[str, tuple[str, str]]] | None = None,
                    tasks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        """``HandoutOut`` (docs/web/api.md)."""
        p = progress or Progress.read(self.service)
        try:
            target = self.target_of(record["target"], active=False)
        except ApiError:
            target = {**record["target"], "name": "", "rids": []}
        cov = self.covered(record, held=held, tasks=tasks, target_rids=target["rids"])
        due = record.get("due_at")
        late = bool(due) and record.get("state") == "open" and today() > date.fromisoformat(due)
        counts = {"people": len(record.get("recipients", [])),
                  "recordings": len({r for rs in cov.values() for r in rs}), "given": 0, "opened": 0,
                  "in_progress": 0, "saved": 0, "set_aside": 0, "overdue_people": 0}
        per = []
        for row in record.get("recipients", []):
            aid = row["annotator_id"]
            mine = cov.get(aid, [])
            saved = sum(1 for r in mine if (aid, r) in p.saved)
            aside = sum(1 for r in mine if (aid, r) not in p.saved and p.is_set_aside(aid, r))
            remaining = len(mine) - saved - aside
            counts["given"] += len(mine)
            counts["saved"] += saved
            counts["set_aside"] += aside
            counts["in_progress"] += sum(1 for r in mine if not p.finished(aid, r) and p.in_progress(aid, r))
            counts["opened"] += sum(1 for r in mine if p.opened(aid, r))
            overdue = late and remaining > 0
            counts["overdue_people"] += int(overdue)
            per.append({"annotator_id": aid, "given": len(mine), "saved": saved, "set_aside": aside,
                        "remaining": remaining, "overdue": overdue})
        n_tasks = None
        if record.get("mode") == "k":
            n_tasks = sum(1 for t in (tasks if tasks is not None else self.service.tasks.all())
                          if t.get("handout_id") == record["handout_id"])
        return {"handout_id": record["handout_id"], "name": record.get("name", ""), "title": record.get("title", ""),
                "target": {"kind": target["kind"], "id": target["id"], "name": target.get("name", "")},
                "mode": record.get("mode", "all"), "k": record.get("k"), "people": list(record.get("people", [])),
                "groups": list(record.get("groups", [])), "follow_groups": bool(record.get("follow_groups")),
                "due_at": due, "note": record.get("note", ""), "state": record.get("state", "open"),
                "handed_out_at": record.get("handed_out_at", ""), "handed_out_by": record.get("handed_out_by", ""),
                "recipients": [dict(r) for r in record.get("recipients", [])], "n_tasks": n_tasks,
                "new_recordings": len(self.new_recordings(record, cov, target["rids"])) if record.get("state") == "open"
                else 0, "counts": counts, "per_person": per,
                "complete": counts["given"] > 0 and all(x["remaining"] == 0 for x in per)}

    @_reads
    def op_handouts_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.web.admin import _aid, _bool

        state = body.get("state")
        if state is not None and state not in ("open", "withdrawn"):
            raise _bad("state must be 'open' or 'withdrawn'")
        target = body.get("target")
        if target is not None and (not isinstance(target, dict) or target.get("kind") not in TARGET_KINDS):
            raise _bad("target must be {\"kind\": \"dataset\" or \"collection\", \"id\"}")
        aid = _aid(body["annotator_id"]) if body.get("annotator_id") is not None else None
        overdue = _bool(body, "overdue")
        p, held, tasks = Progress.read(self.service), self._held(), self.service.tasks.all()
        out = []
        for r in sorted(self.store.records("handouts"), key=lambda r: str(r.get("handed_out_at", "")), reverse=True):
            if state is not None and r.get("state") != state:
                continue
            if target is not None and r.get("target") != {"kind": target["kind"], "id": target.get("id")}:
                continue
            if aid is not None and aid not in [x["annotator_id"] for x in r.get("recipients", [])]:
                continue
            o = self.handout_out(r, p, held=held, tasks=tasks)
            if overdue is not None:
                late = any(x["overdue"] for x in o["per_person"] if aid is None or x["annotator_id"] == aid)
                if late != overdue:
                    continue
            out.append(o)
        return {"handouts": out, "today": today().isoformat()}

    def op_handout_update(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.web.admin import _bool, _text

        rec = self.need_handout(body.get("handout_id"))
        hid = rec["handout_id"]
        if rec.get("state") != "open":
            raise ApiError(409, "withdrawn", "This hand-out was withdrawn, so it cannot change")
        new: dict[str, Any] = {}
        if "due_at" in body:
            new["due_at"] = _due(body.get("due_at"))
        for key, limit in (("name", 120), ("title", 120), ("note", 2000)):
            if body.get(key) is not None:
                new[key] = _text(body, key, required=key in ("name", "title"), limit=limit)
        follow = _bool(body, "follow_groups")
        if follow is not None:
            if follow and rec.get("mode") == "k":
                raise _bad("A hand-out shared out k per recording cannot follow its groups: a later member joins the "
                           "next share-out")
            new["follow_groups"] = follow
        add_people = self._people(body.get("add_people", []), "add_people")
        give_new = _bool(body, "give_new_recordings") or False
        if add_people and rec.get("mode") == "k":
            raise _bad("People join a hand-out shared out k per recording through a new hand-out of the same "
                       "recordings, once its tasks are closed")
        changed = sorted(k for k, v in new.items() if rec.get(k) != v)
        now = _now()
        record = {**rec, **new}
        record["recipients"] = [dict(r) for r in rec.get("recipients", [])]
        have = {r["annotator_id"] for r in record["recipients"]}
        added, tasks = 0, None
        entries: list[dict[str, Any]] = [{"at": now, "by": user.annotator_id, "what": k} for k in changed]
        live, _skipped = self._live(self.target_of(rec["target"], active=False)["rids"])
        held = self._held()
        joiners = [a for a in add_people if a not in have]
        if joiners:
            self._recipients(joiners, [])  # refuses an account that is switched off
        for aid in joiners:
            n, linked = self._give_all(hid, aid, live, held.get(aid, {}))
            record["recipients"].append({"annotator_id": aid, "via": "person", "given_at": now,
                                         "given_by": user.annotator_id, "added": n, "already": len(live) - n})
            record["people"] = [*record.get("people", []), aid]
            self._note_linked(record, aid, linked)
            added += n
        if joiners:
            entries.append({"at": now, "by": user.annotator_id, "what": "add_people", "people": joiners})
        fresh: list[str] = []
        if give_new:
            fresh = self.new_recordings(record, self.covered(record, held=self._held()))
            if fresh and rec.get("mode") == "all":
                held = self._held()
                for row in record["recipients"]:
                    n, linked = self._give_all(hid, row["annotator_id"], fresh, held.get(row["annotator_id"], {}))
                    row["added"] = int(row.get("added", 0)) + n
                    self._note_linked(record, row["annotator_id"], linked)
                    added += n
            elif fresh:
                req = {"recipients": [(r["annotator_id"], r["via"]) for r in record["recipients"]], "k": rec["k"],
                       "name": record.get("name", ""), "note": record.get("note", "")}
                tasks = self.service.tasks.op_create(
                    user, self._tasks_body(req, fresh, _hex(hid, *sorted(fresh), n=32)), handout_id=hid)
                added += tasks["assigned"]
            if fresh:
                entries.append({"at": now, "by": user.annotator_id, "what": "new_recordings", "n": len(fresh)})
        if not entries:
            return {"handout": self.handout_out(rec), "added": 0}
        record["changes"] = ([*rec.get("changes", []), *entries])[-CHANGES_KEPT:]
        self._put("handouts", hid, lambda old: {**(old or rec), **{k: record[k] for k in (
            *new, "recipients", "people", "changes")}, "linked": record.get("linked", {}),
            "linked_overflow": record.get("linked_overflow", False)})
        said = [*changed] + ([f"gave it to {', '.join(joiners[:10])}"] if joiners else []) + (
            [f"gave {audit.count(len(fresh), 'new recording')}"] if fresh else [])
        self._audit(user, "handout_update", f"Changed the hand-out {record.get('name')}: {', '.join(said)}",
                    handout_id=hid, fields=changed, due_at=record.get("due_at"), added_people=joiners,
                    new_recordings=len(fresh), added=added,
                    note_chars=len(new["note"]) if "note" in new else None)
        out = {"handout": self.handout_out(self._record("handouts", hid) or record), "added": added}
        if tasks is not None:
            out["tasks"] = tasks
        return out

    def op_handout_withdraw(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rec = self.need_handout(body.get("handout_id"))
        hid = rec["handout_id"]
        if rec.get("state") != "open":
            raise ApiError(409, "already_withdrawn", "This hand-out was withdrawn already")
        p = Progress.read(self.service)
        removed = kept = 0
        if rec.get("mode") == "k":
            for t in self.service.tasks.all():
                if t.get("handout_id") != hid or t.get("state") == "removed":
                    continue
                if any((a, t["recording_id"]) in p.saved for a in t.get("annotators", [])):
                    if t.get("state") == "open":
                        self.service.tasks.op_update(user, {"task_id": t["task_id"], "state": "closed"})
                    kept += 1
                else:
                    self.service.tasks.op_remove(user, {"task_id": t["task_id"]})
                    removed += 1
        else:
            linked = {a: set(rs) for a, rs in (rec.get("linked") or {}).items()}
            for a in self.store.assignments():
                if a.mode != "standard" or a.handout_id != hid:
                    continue
                aid, rid = a.annotator_id.upper(), a.recording_id
                started = (aid, rid) in p.saved or p.is_set_aside(aid, rid) or p.in_progress(aid, rid)
                if rec.get("linked_overflow") or rid in linked.get(aid, set()) or a.task_id or started:
                    kept += 1
                    continue
                if self.store.unassign_item(aid, rid, "standard", ""):
                    removed += 1
            self.store.unlink_handout(hid)
        now = _now()
        kept_rec = self._put("handouts", hid, lambda old: {**(old or rec), "state": "withdrawn", "changes": (
            [*(old or rec).get("changes", []), {"at": now, "by": user.annotator_id, "what": "withdraw",
                                                "removed": removed, "kept": kept}])[-CHANGES_KEPT:]}) or rec
        self._audit(user, "handout_withdraw", f"Withdrew the hand-out {rec.get('name')}: took back "
                    f"{audit.count(removed, 'unstarted assignment' if rec.get('mode') == 'all' else 'unstarted task')}"
                    f", kept {kept}", handout_id=hid, removed=removed, kept=kept)
        return {"handout": self.handout_out(kept_rec, p), "removed": removed, "kept": kept}

    def _follow(self, user: User, gid: str, joiners: list[str]) -> list[dict[str, Any]]:
        """Give people who joined a group what its open "all" hand-outs that follow it hold."""
        out = []
        now = _now()
        held = self._held()
        for h in self.store.records("handouts"):
            if h.get("state") != "open" or h.get("mode") != "all" or not h.get("follow_groups") \
                    or gid not in h.get("groups", []):
                continue
            hid = h["handout_id"]
            have = {r["annotator_id"] for r in h.get("recipients", [])}
            new_people = [a for a in joiners if a not in have]
            if not new_people:
                continue
            live, _skipped = self._live(self.target_of(h["target"], active=False)["rids"])
            record = {**h, "recipients": [dict(r) for r in h.get("recipients", [])]}
            for aid in new_people:
                rec = self.store.user_record(aid)
                if rec is None or rec.get("status", "active") != "active":
                    continue
                n, linked = self._give_all(hid, aid, live, held.get(aid, {}))
                record["recipients"].append({"annotator_id": aid, "via": f"group:{gid}", "given_at": now,
                                             "given_by": user.annotator_id, "added": n, "already": len(live) - n})
                self._note_linked(record, aid, linked)
                out.append({"handout_id": hid, "annotator_id": aid, "added": n})
            entry = {"at": now, "by": user.annotator_id, "what": "group_join", "group_id": gid,
                     "people": [o["annotator_id"] for o in out if o["handout_id"] == hid]}
            self._put("handouts", hid, lambda old, record=record, entry=entry: {
                **(old or record), "recipients": record["recipients"], "linked": record.get("linked", {}),
                "linked_overflow": record.get("linked_overflow", False),
                "changes": ([*(old or record).get("changes", []), entry])[-CHANGES_KEPT:]})
        return out

    # ------------------------------------------------------------- the annotator's side
    def annotator_view(self, user: User, items: list[Any]) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
        """For ``GET /assignments``: each study item's open hand-out (by item key: ``{"handout_id", "title",
        "due_at", "overdue"}``, the one due earliest), and the ``due`` list. Only titles and dates: never a
        dataset's or collection's name, description or notes, nor the team's note."""
        aid = user.annotator_id.upper()
        mine = [h for h in self.store.records("handouts") if h.get("state") == "open"
                and aid in [r["annotator_id"] for r in h.get("recipients", [])]]
        if not mine:
            return {}, []
        study = {i.recording_id: i for i in items if i.mode == "standard" and i.source == "assignment"}
        tasks = self.service.tasks.all() if any(h.get("mode") == "k" for h in mine) else []
        the_day = today()
        per_item: dict[str, dict[str, Any]] = {}
        due = []
        for h in sorted(mine, key=lambda h: (h.get("due_at") or "9999-12-31", h.get("handed_out_at", ""))):
            if h.get("mode") == "k":
                rids = [r for r in self.covered(h, tasks=tasks).get(aid, []) if r in study]
            else:  # the person's study items given by it, or of its target (read from the items, not the register)
                in_target = self._member_test(h["target"])
                rids = [r for r, i in study.items() if i.handout_id == h["handout_id"] or in_target(i.manifest)]
            if not rids:
                continue
            remaining = sum(1 for r in rids if study[r].status not in ("done", "unusable"))
            late = bool(h.get("due_at")) and the_day > date.fromisoformat(h["due_at"]) and remaining > 0
            for r in rids:
                i = study[r]
                per_item.setdefault(i.key, {"handout_id": h["handout_id"], "title": h.get("title", ""),
                                            "due_at": h.get("due_at"),
                                            "overdue": late and i.status not in ("done", "unusable")})
            if h.get("due_at"):
                due.append({"handout_id": h["handout_id"], "title": h.get("title", ""), "due_at": h["due_at"],
                            "total": len(rids), "remaining": remaining, "overdue": late})
        return per_item, due

    def _member_test(self, target: dict[str, Any]) -> Any:
        """Whether a study manifest is one of a target's recordings, without reading the study's register."""
        if target.get("kind") == "dataset":
            return lambda m: (dataset_of(m) or DEFAULT_DATASET_ID) == target.get("id")
        rec = self._record("collections", str(target.get("id") or "")) or {}
        ids = set(rec.get("recording_ids", []))
        return lambda m: m.get("recording_id") in ids

    @_reads
    def overview_counts(self) -> dict[str, int]:
        """``overview``: the people with an overdue hand-out and the open hand-outs."""
        open_ = [h for h in self.store.records("handouts") if h.get("state") == "open"]
        if not open_:
            return {"overdue": 0, "handouts_open": 0}
        late_people: set[str] = set()
        dated = [h for h in open_ if h.get("due_at") and today() > date.fromisoformat(h["due_at"])]
        if dated:
            p, held, tasks = Progress.read(self.service), self._held(), self.service.tasks.all()
            for h in dated:
                for x in self.handout_out(h, p, held=held, tasks=tasks)["per_person"]:
                    if x["overdue"]:
                        late_people.add(x["annotator_id"])
        return {"overdue": len(late_people), "handouts_open": len(open_)}


__all__ = ["CHOSEN_ID_RE", "DEFAULT_DATASET_ID", "DEFAULT_DATASET_NAME", "MAX_COLLECTION", "RATINGS_TARGET",
           "Datasets", "Progress", "default_title", "prefix_problem", "ratings_by_recording",
           "ratings_histogram", "today"]
