"""The admin area's operations (``POST /admin/{op}``, ``et_admin``; docs/web/api.md, "Administration").

:meth:`Admin.run` checks that the caller is an administrator and runs one operation; every
operation that changes the study appends an entry to the audit log (:mod:`electrotag.web.audit`).
Reference sets are changed with the desktop's own code (:class:`electrotag.training.reference.ReferenceSet`):
the stored set is written into a scratch folder, changed there and stored again, so a set made in
the browser is the same as one made with ``electrotag-admin``, provenance included. The analyses
are in :mod:`electrotag.web.analyses` and the example set in :mod:`electrotag.web.example`.
"""

from __future__ import annotations

import base64
import copy
import json
import math
import re
import secrets
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

from electrotag.app.common import now_local_iso
from electrotag.training.reference import GUIDANCE_LEVELS, NONE_OPTION, USES, ReferenceSet, ReferenceSetError
from electrotag.web import audit
from electrotag.web.errors import ApiError
from electrotag.web.manifest import SCOPE_STUDY, fingerprint_of, manifest_info, set_scope
from electrotag.web.store import (
    KNOWN_ROLES, MODES, RESERVED_IDS, RESERVED_ROLES, ROLES, STATUSES, AccountProblem, StoreError, User, attempt_of,
    item_key, latest_entry, parse_roles, primary_role, roles_text,
)

if TYPE_CHECKING:
    from electrotag.app.annotations.model import AnnotationDocument
    from electrotag.web.service import StudyService

#: The blocks of electrotag_study.json's settings that the admin area may read and change.
SETTINGS_BLOCKS = ("filters", "display", "channels", "selection", "logging", "annotation", "loading", "discovery",
                   "gamification", "review", "training", "replay")
SET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
ITEM_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,63}$")
MAX_DOCUMENT_BYTES = 8_000_000
QUIZ_FEEDBACK = ("immediate", "end")
#: How long an invitation link lasts unless the administrator chooses otherwise, and the longest allowed.
INVITE_DAYS, INVITE_MAX_DAYS = 14, 90
#: Why an administrator's account is not given an invitation link.
ADMIN_NOT_INVITED = ("Invitation links are for annotators: a link sent by email must not open the admin area. Give "
                     "an administrator a password instead (a temporary one, or one you choose).")
#: ``stats``: the days of the daily completions, the days whose pace projects the finish, and the
#: fewest completions in them for a projection.
STATS_DAYS, PACE_DAYS, PACE_MIN = 30, 14, 3
#: The fewest days since the first completion before the pace projects a finish: in a study's first days
#: the pace is the completions so far over the days so far, and a single day says too little.
PACE_MIN_DAYS = 3
#: The words for each mode in the audit log's summaries (as the admin area shows them).
MODE_WORDS = {"standard": "Annotation", "guided": "Guided training", "practice": "Practice",
              "assessment": "Assessment"}
#: What ``stats`` counts: the study's own annotation, or every mode (training too).
STATS_WORK = ("study", "all")

#: Operations that only read (every other one appends an audit entry).
READ_ONLY = ("overview", "settings_get", "users_list", "assignments_list", "recordings_list", "sets_list",
             "set_guided_notes", "quiz_items", "progress", "stats", "agreement", "activity", "competency",
             "results_zip", "audit", "visits", "problems_list", "reviews_list", "saved_attempt_get")
OPERATIONS = READ_ONLY + (
    "settings_update", "user_add", "user_update", "user_reset_password", "user_invite", "user_invite_revoke",
    "user_remove", "assign", "unassign",
    "programme_set", "recordings_register", "recording_update", "recording_remove", "set_create", "set_update",
    "set_delete", "set_add_reference", "set_recording_update", "set_remove_recording", "set_guided_note",
    "set_example_create", "quiz_item_add", "quiz_item_remove", "problem_resolve", "problem_return",
    "problem_reassign", "review_save")
# The training path (electrotag/web/training_path.py): the snippets of a set, a trainee's path and the gate, and
# what the study team does after an assessment that did not meet the criteria.
READ_ONLY += ("snippets_list", "training_gate_get")
OPERATIONS += ("snippets_list", "training_gate_get", "snippet_add", "snippet_remove", "training_reopen",
               "training_assessment_set")


# ------------------------------------------------------------------ checking input
def _bad(message: str, code: str = "bad_request") -> ApiError:
    return ApiError(400, code, message)


def _rec_roles(rec: dict[str, Any]) -> tuple[str, ...]:
    """The roles of an account record (``roles``, or the older single ``role``)."""
    return parse_roles(rec.get("roles") or rec.get("role"))


def _text(body: dict[str, Any], key: str, *, required: bool = False, limit: int = 200, default: str = "") -> str:
    value = body.get(key)
    if value is None:
        if required:
            raise _bad(f"{key} is missing")
        return default
    if not isinstance(value, str) or len(value) > limit:
        raise _bad(f"{key} must be text of at most {limit} characters")
    value = value.strip()
    if required and not value:
        raise _bad(f"{key} is missing")
    return value


def _bool(body: dict[str, Any], key: str) -> bool | None:
    value = body.get(key)
    if value is None:
        return None
    if not isinstance(value, bool):
        raise _bad(f"{key} must be true or false")
    return value


def _number(body: dict[str, Any], key: str, *, minimum: float, maximum: float, default: float | None = None) -> float:
    value = body.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) \
            or not minimum <= value <= maximum:
        raise _bad(f"{key} must be a number from {minimum:g} to {maximum:g}")
    return float(value)


def _aid(value: Any, what: str = "annotator_id") -> str:
    from electrotag.web.accounts import AccountError, normalise_id

    if not isinstance(value, str):
        raise _bad(f"{what} is missing")
    try:
        return normalise_id(value)
    except AccountError as exc:
        raise _bad(f"{what}: {exc}") from exc


def roles_from(body: dict[str, Any], *, required: bool) -> tuple[str, ...] | None:
    """The roles a request asks for: ``roles`` (a list), ``role`` (one, the older form) or both, when they agree
    (``role`` is then the primary role of ``roles``). None when neither is given and none is required."""
    role, roles = body.get("role"), body.get("roles")
    if roles is None and role is None:
        return ("annotator",) if required else None
    asked: list[str] = []
    if roles is not None:
        if not isinstance(roles, list) or not roles or not all(isinstance(r, str) for r in roles):
            raise _bad("roles must be a list of at least one role (annotator, expert, admin)")
        asked = list(roles)
    if role is not None:
        if not isinstance(role, str):
            raise _bad(f"role must be one of {', '.join(ROLES)}")
        asked = asked or [role]
    for r in asked + ([role] if isinstance(role, str) else []):
        if r in RESERVED_ROLES:
            raise ApiError(400, "role_not_offered", f"The role {r!r} is kept for a later kind of study and cannot be "
                           "given yet.")
        if r not in KNOWN_ROLES:
            raise _bad(f"role must be one of {', '.join(ROLES)}")
    kept = parse_roles(asked)
    if roles is not None and role is not None and role != primary_role(kept):
        raise _bad(f"role ({role}) and roles ({', '.join(kept)}) say different things: role is the first of the "
                   "roles, in the order admin, expert, annotator; give roles alone")
    return kept


def _ids(value: Any, what: str, *, minimum: int = 1) -> list[str]:
    if not isinstance(value, list) or len(value) < minimum or len(value) > 1000:
        raise _bad(f"{what} must be a list of at least {minimum} ID(s)")
    out = [_aid(v, what) for v in value]
    if len(set(out)) != len(out):
        raise _bad(f"{what} names someone twice")
    return out


def _rid(value: Any, what: str = "recording_id") -> str:
    if not isinstance(value, str) or not value or len(value) > 512:
        raise _bad(f"{what} is missing")
    return value


def _mode_ctx(body: dict[str, Any]) -> tuple[str, str]:
    mode = body.get("mode") or "standard"
    if mode not in MODES:
        raise _bad(f"mode must be one of {', '.join(MODES)}")
    ctx = body.get("context_id") or ""
    if not isinstance(ctx, str):
        raise _bad("context_id must be a reference set ID")
    return mode, (ctx if mode != "standard" else "")


def _seconds(value: Any) -> float | None:
    """A number of the completion register or a draft (text in the register's TSV), or None."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) and v >= 0 else None


def _median(values: list[float]) -> float | None:
    from statistics import median

    return float(median(values)) if values else None


def _day(stamp: Any) -> date | None:
    """The local date at the start of a time stamp such as 2026-10-28T10:15:02.120+00:00."""
    try:
        return date.fromisoformat(str(stamp or "")[:10])
    except ValueError:
        return None


def pace_projection(days: list[date], today: date, *, assigned: int,
                    remaining: int) -> tuple[float, int, dict[str, Any]]:
    """The pace of work (recordings a day), the days it is measured over, and the projected finish.

    ``days`` are the days on which recordings were completed. The pace is that of the last 14 days, or
    of the days since the first completion when the study is younger, so that a team in its first week
    is not divided by days on which nobody could have worked yet. Until three days have passed since
    the first completion, the finish is not projected (``reason: too_early``): one day says too little.
    """
    done = [d for d in days if d <= today]
    history = (today - min(done)).days + 1 if done else 0
    pace_days = max(1, min(PACE_DAYS, history))
    first = today - timedelta(days=pace_days - 1)
    recent = sum(1 for d in done if d >= first)
    pace = recent / pace_days
    if assigned and not remaining:
        projection: dict[str, Any] = {"status": "complete", "date": None}
    elif remaining and recent >= PACE_MIN and history < PACE_MIN_DAYS:
        projection = {"status": "not_enough", "date": None, "reason": "too_early"}
    elif remaining and recent >= PACE_MIN:
        projection = {"status": "projected", "date": (today + timedelta(days=math.ceil(remaining / pace))).isoformat()}
    else:
        projection = {"status": "not_enough", "date": None}
    return pace, pace_days, projection


def _setting_value(value: Any) -> str:
    if isinstance(value, bool):
        return "on" if value else "off"
    if value is None or value == "" or value == [] or value == {}:
        return "nothing"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, list):
        return ", ".join(str(v) for v in value)
    if isinstance(value, dict):
        return ", ".join(f"{k} {v}" for k, v in value.items())
    return str(value)


def setting_change_text(key: str, old: Any, new: Any) -> str:
    """A setting's change in words for the audit log: "allow reviews (annotation) from on to off"."""
    block, name = key.split(".", 1)
    return f"{name.replace('_', ' ')} ({block}) from {_setting_value(old)} to {_setting_value(new)}"


def invitation_out(inv: dict[str, Any] | None) -> dict[str, Any]:
    """A UserRecord's ``invitation``: its state (none, invited, accepted, expired, revoked) and dates."""
    inv = inv or {}
    return {"state": inv.get("state") or "none", "invited_at": inv.get("invited_at") or None,
            "expires_at": inv.get("expires_at") or None, "ended_at": inv.get("ended_at") or None}


def _plain(value: Any, what: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _bad(f"{what} must be an object")
    return value


def _numbers(value: Any, what: str, keys: tuple[str, ...]) -> dict[str, float]:
    """An object of the named numbers (only those), each a finite number."""
    d = _plain(value, what)
    out = {}
    for k, v in d.items():
        if k not in keys:
            raise ApiError(400, "invalid_set", f"{what} has no setting {k!r}; it has {', '.join(keys)}")
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            raise ApiError(400, "invalid_set", f"{what}.{k} must be a number")
        out[k] = float(v)
    return out


def _accepted(value: Any, catalogue: Any) -> dict[str, list[str]]:
    if not isinstance(value, dict) or not all(isinstance(v, list) for v in value.values()):
        raise ApiError(400, "invalid_set", "guided_tolerance.accepted_labels must map an artifact type to the types "
                       "also accepted for it")
    labels = [str(k) for k in value] + [str(x) for v in value.values() for x in v]
    unknown = sorted({lab for lab in labels if not catalogue.is_permitted(lab)})
    if unknown:
        raise ApiError(400, "invalid_set", f"guided_tolerance.accepted_labels: {unknown[0]} is not an artifact type "
                       "of the catalogue")
    return {str(k): [str(x) for x in v] for k, v in value.items()}


def _criteria(value: Any) -> dict[str, Any]:
    """Competency criteria checked as the desktop checks them, with plain reasons."""
    from electrotag.training.assessment import METRICS, CompetencyCriteria

    d = _plain(value, "criteria")
    items = d.get("criteria", [])
    if not isinstance(items, list):
        raise ApiError(400, "invalid_set", "criteria.criteria must be a list of criteria")
    for i, c in enumerate(items, start=1):
        if not isinstance(c, dict) or c.get("metric") not in METRICS:
            raise ApiError(400, "invalid_set", f"Criterion {i} must name one of the measures "
                           f"{', '.join(sorted(METRICS))}")
        t = c.get("threshold")
        if isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t):
            raise ApiError(400, "invalid_set", f"Criterion {i} ({c['metric']}) needs a number as its threshold")
    n = d.get("min_reference_events", 3)
    if isinstance(n, bool) or not isinstance(n, int) or n < 1:
        raise ApiError(400, "invalid_set", "criteria.min_reference_events must be a whole number of at least 1")
    cats = d.get("categories")
    if cats is not None and (not isinstance(cats, list) or not all(isinstance(x, str) for x in cats)):
        raise ApiError(400, "invalid_set", "criteria.categories must be a list of artifact types, or null for all")
    try:
        return CompetencyCriteria.from_dict(d).to_dict()
    except ValueError as exc:
        raise ApiError(400, "invalid_set", f"The competency criteria cannot be used: {exc}") from exc


# ---------------------------------------------------------------------- the operations
class Admin:
    def __init__(self, service: StudyService) -> None:
        self.service = service

    @property
    def store(self) -> Any:
        return self.service.store

    def run(self, op: Any, user: User, body: dict[str, Any]) -> dict[str, Any]:
        if not user.is_admin:
            raise ApiError(403, "forbidden", "Only study administrators can use the admin area")
        if not isinstance(op, str) or op not in OPERATIONS:
            raise ApiError(404, "not_found", f"This server does not offer the administrative operation {op!r}")
        if not isinstance(body, dict):
            raise _bad("The request must be a JSON object")
        self.store.refresh()
        with self.store.memo():
            try:
                return getattr(self, f"op_{op}")(user, body)
            except AccountProblem as exc:
                raise ApiError(exc.status, exc.code, exc.message) from exc

    def _audit(self, user: User, op: str, summary: str, **details: Any) -> None:
        audit.record(self.store, user.annotator_id, op, summary, details)

    # ------------------------------------------------------------- helpers
    def _set(self, set_id: Any) -> ReferenceSet:
        if not isinstance(set_id, str) or not set_id:
            raise _bad("set_id is missing")
        return self.service.reference_set(set_id)

    def _set_scope(self, rs: ReferenceSet) -> str:
        return set_scope(rs.set_id) if rs.self_contained else SCOPE_STUDY

    def _scope(self, value: Any, *, default: str | None = SCOPE_STUDY) -> str:
        if value is None and default is not None:
            return default
        if value == SCOPE_STUDY:
            return SCOPE_STUDY
        if isinstance(value, str) and value.startswith("set:"):
            rs = self._set(value[4:])
            if not rs.self_contained:
                raise _bad(f"The reference set {rs.set_id} uses the study's own recordings (scope 'study')")
            return set_scope(rs.set_id)
        raise _bad("scope must be 'study' or 'set:<reference set ID>'")

    def _user_record(self, aid: str) -> dict[str, Any]:
        rec = self.store.user_record(aid)
        if rec is None:
            raise ApiError(404, "unknown_user", f"{aid} has no account in this study")
        return rec

    @contextmanager
    def _editing(self, set_id: str) -> Iterator[ReferenceSet]:
        """The stored set in a scratch folder; stored again when the block ends without an error."""
        from electrotag.web.registration import reference_set_payload

        try:
            definition, files = self.store.reference_set_payload(set_id)
        except StoreError as exc:
            raise ApiError(404, "no_reference_set", str(exc)) from exc
        with tempfile.TemporaryDirectory(prefix="electrotag-set-") as tmp:
            folder = Path(tmp) / set_id
            for rel, data in files.items():
                p = folder / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "reference_set.json").write_text(json.dumps(definition, indent=2), encoding="utf-8")
            try:
                rs = ReferenceSet.load(folder)
            except ReferenceSetError as exc:
                raise ApiError(500, "reference_unavailable", "The reference set cannot be read") from exc
            try:
                yield rs
            except (ValueError, KeyError, TypeError) as exc:
                if isinstance(exc, ApiError):
                    raise
                raise ApiError(400, "invalid_set", str(exc)) from exc
            definition, files = reference_set_payload(folder)
            self.store.put_reference_set(definition, files)

    def _entries(self) -> list[dict[str, str]]:
        return [e for e in self.store.completion_entries() if e.get("status") == "completed"]

    def _has_results(self, scope: str, rid: str, entries: list[dict[str, str]] | None = None) -> bool:
        for e in entries if entries is not None else self._entries():
            if e.get("recording_id") == rid and self.service.scope_for(e.get("mode", "standard"),
                                                                        e.get("context", "")) == scope:
                return True
        return False

    def _items_of(self, person: User, entries: list[dict[str, str]]) -> list[dict[str, Any]]:
        out = []
        for i in self.service.work_items(person):
            mine = [e for e in entries if e.get("annotator_id") == person.annotator_id
                    and e.get("recording_id") == i.recording_id and e.get("mode", "standard") == i.mode
                    and e.get("context", "") == i.context_id]
            draft = self.store.draft(person.annotator_id, i.key) or {} if i.status == "in_progress" else {}
            last = max([e.get("completed_at", "") for e in mine] + [draft.get("saved_at", "")])
            # A revision is a later attempt: the latest attempt by its number gives the annotations and the
            # date, and the time is that of every saved attempt together (the work the recording took).
            latest = latest_entry(mine) if mine else {}
            if latest:
                times = [t for e in mine if (t := _seconds(e.get("elapsed_s"))) is not None]
                elapsed = sum(times) if times else None
            else:
                elapsed = _seconds((draft.get("draft") or {}).get("elapsed_s")) if draft else None
            n_ann = _seconds(latest.get("n_annotations")) if latest else None
            out.append({"annotator_id": person.annotator_id, "recording_id": i.recording_id, "mode": i.mode,
                        "context_id": i.context_id, "status": i.status, "attempts": len(mine),
                        "last_activity": last or None, "elapsed_s": elapsed,
                        "n_annotations": int(n_ann) if n_ann is not None else None,
                        "saved_at": (latest.get("completed_at") or None) if latest else None})
        return out

    def _counts(self) -> tuple[dict[tuple[str, str], int], dict[tuple[str, str], int]]:
        """How many annotators are given, and have saved, each (scope, recording)."""
        assigned: dict[tuple[str, str], int] = {}
        for a in self.store.assignments():
            key = (self.service.scope_for(a.mode, a.context_id), a.recording_id)
            assigned[key] = assigned.get(key, 0) + 1
        for u in self.store.user_records():
            set_id = self.store.programme(u["annotator_id"])
            if not set_id:
                continue
            try:
                rs = self.store.reference_set(set_id)
            except ReferenceSetError:
                continue
            for rid, entry in rs.recordings.items():
                key = (self.service.scope_for(str(entry.get("use", "practice")), rs.set_id), rid)
                assigned[key] = assigned.get(key, 0) + 1
        done: dict[tuple[str, str], set[tuple[str, str, str]]] = {}
        for e in self._entries():
            key = (self.service.scope_for(e.get("mode", "standard"), e.get("context", "")), e["recording_id"])
            done.setdefault(key, set()).add((e.get("annotator_id", ""), e.get("mode", ""), e.get("context", "")))
        return assigned, {k: len(v) for k, v in done.items()}

    def recording_record(self, m: dict[str, Any], counts: Any = None) -> dict[str, Any]:
        assigned, done = counts if counts is not None else self._counts()
        reg = dict(m.get("registration") or {})
        sha, size = fingerprint_of(m)
        t = m["timing"]
        key = (m["scope"], m["recording_id"])
        return {"scope": m["scope"], "recording_id": m["recording_id"], "file_name": m["file_name"],
                "format": m["format"], "sfreq": float(t["sfreq"]), "n_samples": int(t["n_samples"]),
                "duration_s": float(t["n_samples"]) / float(t["sfreq"]), "n_channels": len(m["ch_names"]),
                "size_bytes": size, "sha256": sha, "registered_at": reg.get("registered_at") or m.get("created_at", ""),
                "registered_by": reg.get("registered_by", ""), "registered_via": reg.get("registered_via", "command"),
                "notes": reg.get("notes", ""), "retired": bool(reg.get("retired", False)),
                "assigned": assigned.get(key, 0), "done": done.get(key, 0), "warnings": list(m.get("warnings", []))}

    def set_record(self, rs: ReferenceSet) -> dict[str, Any]:
        from electrotag.training.assessment import CompetencyCriteria
        from electrotag.training.guided import Tolerance
        from electrotag.training.programme import PassRule
        from electrotag.web.quiz import feedback_of

        scope = self._set_scope(rs)
        recs = []
        for rid, e in rs.recordings.items():
            use = str(e.get("use", ""))
            recs.append({"recording_id": rid, "use": use, "guidance": str(e.get("guidance") or "auto"),
                         "effective_guidance": rs.guidance_for(rid) if use == "guided" else None,
                         "provenance": dict(e.get("provenance") or {}),
                         "n_reference_events": int(e.get("n_annotations", 0) or 0),
                         "registered": self.store.manifest(scope, rid) is not None})
        try:
            criteria = CompetencyCriteria.from_dict(rs.criteria).to_dict()
        except (ValueError, KeyError, TypeError):
            criteria = dict(rs.criteria)
        try:
            tolerance = Tolerance.from_dict(rs.guided.get("tolerance")).to_dict()
        except (ValueError, TypeError):
            tolerance = dict(rs.guided.get("tolerance") or {})
        try:
            practice_pass = PassRule.from_dict(rs.practice_pass).to_dict()
        except (ValueError, TypeError):
            practice_pass = dict(rs.practice_pass)
        return {"set_id": rs.set_id, "name": rs.name, "description": rs.description, "created_at": rs.created_at,
                "created_by": rs.created_by, "practice_review": rs.practice_review,
                "allowed_annotators": list(rs.assigned_annotators), "practice_pass": practice_pass,
                "guided_tolerance": tolerance, "criteria": criteria, "recordings": recs,
                "quiz_items": len(rs.quiz_items), "self_contained": rs.self_contained, "scope": scope,
                "provenance": dict(rs.provenance),
                "quiz": {"include_none_option": bool(rs.quiz.get("include_none_option", False)),
                         "feedback": feedback_of(rs)},
                "show_full_report_to_annotator": rs.show_full_report_to_annotator}

    def user_out(self, rec: dict[str, Any], invitations: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
        roles = _rec_roles(rec)
        person = User(rec["annotator_id"], rec.get("display_name", ""), roles=roles)
        items = self.service.work_items(person)
        if invitations is None:
            invitations = self.store.invitations()
        return {"annotator_id": rec["annotator_id"], "display_name": rec.get("display_name", ""),
                "email": rec.get("email") or None, "role": primary_role(roles), "roles": list(roles),
                "status": rec.get("status", "active"), "created_at": rec.get("created_at", ""),
                "last_seen": rec.get("last_seen") or None, "notes": rec.get("notes", ""),
                "assigned": len(items), "done": sum(1 for i in items if i.status == "done"),
                "programme": self.store.programme(rec["annotator_id"]),
                "invitation": invitation_out(invitations.get(rec["annotator_id"]))}

    # ------------------------------------------------------------ overview
    def op_overview(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        records = self.store.user_records()
        active = [u for u in records if u.get("status") == "active"]
        counts = {"recordings": sum(1 for m in self.store.manifests() if m["scope"] == SCOPE_STUDY),
                  "annotators": sum(1 for u in active if "annotator" in _rec_roles(u)),
                  "experts": sum(1 for u in active if "expert" in _rec_roles(u)),
                  "admins": sum(1 for u in active if "admin" in _rec_roles(u)),
                  "assignments": 0, "done": 0, "in_progress": 0, "todo": 0, "unusable": 0}
        for u in active:
            for i in self.service.work_items(User(u["annotator_id"], u.get("display_name", ""), u["role"])):
                counts["assignments"] += 1
                counts["todo" if i.status == "locked" else i.status] += 1  # locked: to do once training is passed
        counts.update(self._feedback_counts())
        recent, _next = self.store.audit_page(None, 10)
        saved = sorted(self._entries(), key=lambda e: e.get("completed_at", ""), reverse=True)[:10]
        return {"study": {"study_id": self.store.study_id, "name": self.store.name}, "counts": counts,
                "recent": recent,
                "last_saved": [{"annotator_id": e.get("annotator_id"), "recording_id": e.get("recording_id"),
                                "mode": e.get("mode", "standard"), "context_id": e.get("context", ""),
                                "at": e.get("completed_at", "")} for e in saved]}

    def _feedback_counts(self) -> dict[str, int]:
        """Open problem reports and the study recordings reviewed (Overview and Progress)."""
        fb = self.service.feedback
        return {"problems_open": sum(1 for r in self.store.records("problems") if r.get("state") == "open"),
                "reviewed": len(fb.reviewed_recordings())}

    # ----------------------------------------------- problem reports and reviews
    def op_problems_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.feedback.problems_list(user, body)

    def op_problem_resolve(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.feedback.problem_resolve(user, body)

    def op_problem_return(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.feedback.problem_return(user, body)

    def op_problem_reassign(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.feedback.problem_reassign(user, body)

    def op_saved_attempt_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.feedback.saved_attempt_get(user, body)

    def op_review_save(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.feedback.review_save(user, body)

    def op_reviews_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.feedback.reviews_list(user, body)

    # ------------------------------------------------------------ settings
    def op_settings_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.web.service import LOGGING_NOTICE

        raw = self.store.settings.raw
        return {"name": self.store.name, "settings": {b: copy.deepcopy(raw.get(b, {})) for b in SETTINGS_BLOCKS},
                "logging_notice": self.store.logging_notice or LOGGING_NOTICE,
                "logging_notice_is_default": not self.store.logging_notice}

    def op_settings_update(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.config.settings import load_default_settings_dict

        name = body.get("name")
        if name is not None:
            name = _text(body, "name", required=True, limit=200)
        notice = body.get("logging_notice")
        if notice is not None:
            notice = _text(body, "logging_notice", limit=2000)
        changes = body.get("settings")
        overrides = None
        changed: list[str] = []
        if changes is not None:
            if not isinstance(changes, dict):
                raise ApiError(400, "invalid_settings", "settings must be an object of setting blocks")
            defaults = load_default_settings_dict()
            overrides = copy.deepcopy(self.store.settings_overrides)
            for block, values in changes.items():
                if block not in SETTINGS_BLOCKS:
                    raise ApiError(400, "invalid_settings", f"The settings block {block!r} cannot be changed here; "
                                   f"these can: {', '.join(SETTINGS_BLOCKS)}")
                if not isinstance(values, dict):
                    raise ApiError(400, "invalid_settings", f"settings.{block} must be an object")
                for key, value in values.items():
                    if key not in defaults.get(block, {}):
                        raise ApiError(400, "invalid_settings", f"There is no setting {block}.{key}")
                    overrides.setdefault(block, {})[key] = copy.deepcopy(value)
                    changed.append(f"{block}.{key}")
        if name is None and notice is None and overrides is None:
            raise _bad("Nothing to change: give name, settings or logging_notice")
        before = self.store.settings.raw
        what = [setting_change_text(k, (before.get(k.split(".")[0]) or {}).get(k.split(".", 1)[1]),
                                    body["settings"][k.split(".")[0]][k.split(".", 1)[1]]) for k in changed]
        what += ["the study's name"] if name is not None else []
        what += ["the logging notice"] if notice is not None else []
        try:
            self.store.update_study(name=name, overrides=overrides, logging_notice=notice)
        except ValueError as exc:
            raise ApiError(400, "invalid_settings", f"These settings cannot be used: {exc}") from exc
        self._audit(user, "settings_update", "Changed " + "; ".join(what),
                    changes={k: body["settings"][k.split(".")[0]][k.split(".", 1)[1]] for k in changed},
                    name=name, logging_notice=notice)
        return self.op_settings_get(user, {})

    # --------------------------------------------------------------- users
    def op_users_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        invitations = self.store.invitations()
        return {"users": [self.user_out(r, invitations) for r in self.store.user_records()]}

    def op_user_add(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        aid = _aid(body.get("annotator_id"))
        name = _text(body, "display_name")
        email = _text(body, "email", limit=254)
        if email and not EMAIL_RE.match(email):
            raise _bad(f"{email} is not an email address")
        roles = roles_from(body, required=True) or ("annotator",)
        if aid in RESERVED_IDS:
            raise ApiError(400, "reserved_id", f"{aid} is kept for ElectroTag's own versions (the adjudicated version "
                           "and training references) and cannot be an account; choose another ID.")
        password = body.get("password")
        if password is not None and (not isinstance(password, str) or not 8 <= len(password) <= 200):
            raise _bad("A password must have 8 to 200 characters")
        invite = _bool(body, "invite") or False
        if invite and password is not None:
            raise _bad("Give a password or ask for an invitation link, not both")
        if invite and "admin" in roles:
            raise ApiError(409, "admin_account", ADMIN_NOT_INVITED)
        days = self._invite_days(body)
        if invite:
            # Nobody knows this password: the person chooses their own with the invitation.
            password = secrets.token_urlsafe(24)
        creds = self.store.create_account(aid, display_name=name, role=primary_role(roles), email=email,
                                          password=password, roles=roles)
        inv: dict[str, Any] = {}
        if invite:
            inv = self.store.create_invitation(aid, days=days, by=user.annotator_id)
        kind = roles_text(roles)
        how = ""
        if invite:
            how = " with an invitation link" + (f" (until {inv['expires_at'][:10]})" if inv.get("expires_at") else "")
        self._audit(user, "user_add", f"Added {aid}" + (f" ({name})" if name else "") + f" as {kind}{how}",
                    annotator_id=aid, display_name=name, role=primary_role(roles), roles=list(roles),
                    email=email or None, invited=invite,
                    expires_at=inv.get("expires_at"))
        out = {"user": self.user_out(self._user_record(aid)),
               "invite_link": inv.get("invite_link") or creds.get("invite_link"),
               "temporary_password": creds.get("temporary_password")}
        if invite:
            out.update(invite_token=inv.get("invite_token"), expires_at=inv.get("expires_at"))
        return out

    @staticmethod
    def _invite_days(body: dict[str, Any]) -> float:
        if body.get("expires_days") is None:
            return float(INVITE_DAYS)
        return _number(body, "expires_days", minimum=1, maximum=INVITE_MAX_DAYS)

    def op_user_invite(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        aid = _aid(body.get("annotator_id"))
        if "admin" in _rec_roles(self._user_record(aid)):
            raise ApiError(409, "admin_account", ADMIN_NOT_INVITED)
        days = self._invite_days(body)
        inv = self.store.create_invitation(aid, days=days, by=user.annotator_id)
        until = f" (until {inv['expires_at'][:10]})" if inv.get("expires_at") else ""
        self._audit(user, "user_invite", f"Made an invitation link for {aid}{until}; any earlier link stops working",
                    annotator_id=aid, expires_at=inv.get("expires_at"))
        return {"invite_token": inv.get("invite_token"), "invite_link": inv.get("invite_link"),
                "expires_at": inv.get("expires_at"),
                "invitation": invitation_out(self.store.invitations().get(aid))}

    def op_user_invite_revoke(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        aid = _aid(body.get("annotator_id"))
        self._user_record(aid)
        if not self.store.revoke_invitation(aid):
            raise ApiError(409, "no_invitation", f"{aid} has no invitation link that is still open.")
        self._audit(user, "user_invite_revoke", f"Withdrew the invitation link of {aid}", annotator_id=aid)
        return {"invitation": invitation_out(self.store.invitations().get(aid))}

    def op_user_update(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        aid = _aid(body.get("annotator_id"))
        rec = self._user_record(aid)
        name = body.get("display_name")
        if name is not None:
            name = _text(body, "display_name")
        notes = body.get("notes")
        if notes is not None:
            notes = _text(body, "notes", limit=5000)
        roles = roles_from(body, required=False)
        status = body.get("status")
        if status is not None and status not in STATUSES:
            raise _bad(f"status must be one of {', '.join(STATUSES)}")
        if aid == user.annotator_id and ((roles is not None and "admin" not in roles) or status == "disabled"):
            raise ApiError(409, "self", "You cannot take away your own administrator role or disable your own "
                           "account; ask another administrator.")
        said = []
        before = _rec_roles(rec)
        if roles is not None and roles != before:
            said.append(f"made them {roles_text(roles)}")
        if status is not None and status != rec.get("status"):
            said.append("disabled the account" if status == "disabled" else "enabled the account")
        if name is not None and name != rec.get("display_name", ""):
            said.append(f"renamed them {name!r}")
        if notes is not None and notes != rec.get("notes", ""):
            said.append("changed the notes")
        if not said:
            # Nothing to change (an account switched off already, say): nothing is written or audited.
            return {"user": self.user_out(rec), "changed": False}
        changed_roles = roles if roles is not None and roles != before else None
        self.store.update_account(aid, display_name=name, status=status, notes=notes, roles=changed_roles,
                                  role=primary_role(changed_roles) if changed_roles else None)
        self._audit(user, "user_update", f"{aid}: " + ", ".join(said), annotator_id=aid,
                    display_name=name, role=primary_role(changed_roles) if changed_roles else None,
                    roles=list(changed_roles) if changed_roles else None, status=status, notes=notes)
        return {"user": self.user_out(self._user_record(aid)), "changed": True}

    def op_user_reset_password(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        aid = _aid(body.get("annotator_id"))
        self._user_record(aid)
        creds = self.store.reset_password(aid)
        how = "a link to choose a new password" if creds.get("invite_link") else "a new temporary password"
        self._audit(user, "user_reset_password", f"Gave {aid} {how}", annotator_id=aid)
        return {"invite_link": creds.get("invite_link"), "temporary_password": creds.get("temporary_password")}

    def op_user_remove(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        aid = _aid(body.get("annotator_id"))
        if aid == user.annotator_id:
            raise ApiError(409, "self", "You cannot remove your own account; ask another administrator.")
        rec = self._user_record(aid)
        self.store.remove_account(aid)
        self._audit(user, "user_remove", f"Removed {aid} from the study (their results and logs stay)",
                    annotator_id=aid, display_name=rec.get("display_name", ""), role=rec.get("role"),
                    roles=list(_rec_roles(rec)))
        return {}

    # --------------------------------------------------------- assignments
    def op_assignments_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        entries = self._entries()
        if body.get("annotator_id") is not None:
            rec = self._user_record(_aid(body.get("annotator_id")))
            records = [rec]
        else:
            records = self.store.user_records()
        items = []
        for rec in records:
            items.extend(self._items_of(User(rec["annotator_id"], rec.get("display_name", ""),
                                             rec.get("role", "annotator")), entries))
        return {"items": items}

    def _allowed(self, rs: ReferenceSet, aid: str) -> None:
        names = [a.upper() for a in rs.assigned_annotators]
        if names and aid not in names:
            raise ApiError(409, "not_allowed", f"The reference set {rs.set_id} is only for "
                           f"{', '.join(names)}; add {aid} to its allowed annotators first.")

    def op_assign(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        aids = _ids(body.get("annotator_ids"), "annotator_ids")
        for aid in aids:
            self._user_record(aid)
        mode, ctx = _mode_ctx(body)
        rs = None
        if mode != "standard":
            if not ctx:
                raise _bad("Training assignments need the reference set (context_id)")
            rs = self._set(ctx)
            for aid in aids:
                self._allowed(rs, aid)
        scope = self.service.scope_for(mode, ctx)
        registered = {m["recording_id"]: m for m in self.store.manifests() if m["scope"] == scope}
        retired = {r for r, m in registered.items() if (m.get("registration") or {}).get("retired")}
        if body.get("all") is True:
            wanted = sorted(registered)
            if rs is not None:
                wanted = [r for r in wanted if r in rs.recordings]
        else:
            wanted = body.get("recording_ids")
            if not isinstance(wanted, list) or not wanted or not all(isinstance(r, str) for r in wanted):
                raise _bad("Give recording_ids (a list) or \"all\": true")
            unknown = [r for r in wanted if r not in registered]
            if unknown:
                raise ApiError(404, "unknown_recording", "Not registered here: " + ", ".join(unknown[:10]))
            if rs is not None:
                outside = [r for r in wanted if r not in rs.recordings]
                if outside:
                    raise _bad(f"Not part of the reference set {rs.set_id}: " + ", ".join(outside[:10]),
                               "not_in_set")
        skipped = [r for r in wanted if r in retired]
        wanted = [r for r in wanted if r not in retired]
        added = 0
        for aid in aids:
            added += self.store.assign(aid, wanted, mode=mode, context_id=ctx) if wanted else 0
        already = len(wanted) * len(aids) - added
        where = MODE_WORDS.get(mode, mode) if mode == "standard" else f"{MODE_WORDS.get(mode, mode)}, {ctx}"
        self._audit(user, "assign", f"Assigned {audit.count(len(wanted), 'recording')} to {', '.join(aids)} "
                    f"({where}): {added} new", annotator_ids=aids, recording_ids=wanted, mode=mode, context_id=ctx,
                    added=added, already=already, retired=skipped)
        return {"added": added, "already": already, "retired": len(skipped)}

    def op_unassign(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        aid = _aid(body.get("annotator_id"))
        rid = _rid(body.get("recording_id"))
        mode, ctx = _mode_ctx(body)
        if rid in self.store.completed(aid, mode, ctx):
            raise ApiError(409, "done", f"{aid} has already saved {rid}; a completed recording stays assigned.")
        if item_key(rid, mode, ctx) in self.service.feedback.unusable_keys(aid):
            raise ApiError(409, "set_aside", f"{aid} set {rid} aside as a recording that cannot be annotated, so it "
                           "stays with their work. Deal with their report in Problems: return the recording to "
                           f"{aid}'s list, or give it to someone else.")
        if not self.store.unassign_item(aid, rid, mode, ctx):
            raise ApiError(404, "not_assigned", f"{rid} is not assigned to {aid} in that mode")
        # A recording set aside and then taken away starts afresh if it is ever given back.
        self.service.feedback.clear_mark(aid, rid, mode, ctx)
        self._audit(user, "unassign", f"Took {rid} away from {aid}", annotator_id=aid, recording_id=rid, mode=mode,
                    context_id=ctx)
        return {}

    def op_programme_set(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        aid = _aid(body.get("annotator_id"))
        self._user_record(aid)
        set_id = body.get("set_id")
        if set_id is not None:
            rs = self._set(set_id)
            self._allowed(rs, aid)
            set_id = rs.set_id
        self.store.enrol(aid, set_id or None)
        self._audit(user, "programme_set", f"{aid} " + (f"takes the training programme {set_id}" if set_id else
                                                       "no longer takes a training programme"),
                    annotator_id=aid, set_id=set_id)
        return {}

    # ---------------------------------------------------------- recordings
    def op_recordings_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        scope = self._scope(body.get("scope"), default=None) if body.get("scope") is not None else None
        counts = self._counts()
        ms = [m for m in self.store.manifests() if scope is None or m["scope"] == scope]
        ms.sort(key=lambda m: (m["scope"] != SCOPE_STUDY, m["scope"], m["recording_id"]))
        return {"recordings": [self.recording_record(m, counts) for m in ms]}

    def op_recordings_register(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.web.manifest_check import MAX_MANIFESTS, ManifestProblem, check_manifest

        scope = self._scope(body.get("scope"))
        manifests = body.get("manifests")
        if not isinstance(manifests, list) or not manifests:
            raise _bad("manifests must be a list of the recordings' manifests")
        if len(manifests) > MAX_MANIFESTS:
            raise ApiError(413, "too_large", f"At most {MAX_MANIFESTS} recordings can be registered at once; send "
                           "the rest in another request")
        replace_ = _bool(body, "replace") or False
        # A byte-identical copy of a registered recording would be assigned and annotated as another recording,
        # inflating the counts and the agreement: it is skipped unless the administrator confirms it.
        duplicates_ok = _bool(body, "allow_duplicates") or False
        suffixes = tuple(self.store.settings.discovery_suffixes)
        entries = self._entries()
        added: list[str] = []
        replaced: list[str] = []
        skipped: list[dict[str, str]] = []
        seen: set[str] = set()
        prints: dict[tuple[str, int], str] = {}
        for raw in manifests:
            rid = raw.get("recording_id") if isinstance(raw, dict) and isinstance(raw.get("recording_id"), str) else ""
            try:
                m = check_manifest(raw, scope=scope, suffixes=suffixes)
            except ManifestProblem as exc:
                skipped.append({"recording_id": rid, "reason": str(exc)})
                continue
            rid = m["recording_id"]
            if rid in seen:
                skipped.append({"recording_id": rid, "reason": "This recording appears twice in the request"})
                continue
            seen.add(rid)
            old = self.store.manifest(scope, rid)
            if old is not None and not replace_:
                skipped.append({"recording_id": rid, "reason": "Already registered (choose to replace it to "
                                "register it again)"})
                continue
            fp = fingerprint_of(m)
            if not duplicates_ok and fp[0]:
                same = prints.get(fp) or next((o["recording_id"] for o in self.store.manifests_by_fingerprint(*fp)
                                               if o.get("scope") == scope and o["recording_id"] != rid), None)
                if same:
                    skipped.append({"recording_id": rid, "duplicate_of": same,
                                    "reason": f"The same file as {same} (the same fingerprint), so it would be "
                                    "annotated twice under two IDs. Add it only if that is intended."})
                    continue
            prints.setdefault(fp, rid)
            if old is not None and fingerprint_of(old) != fingerprint_of(m) and self._has_results(scope, rid, entries):
                skipped.append({"recording_id": rid, "reason": "Annotations of this recording have been saved, so "
                                "it can only be registered again from the same file (the same checksum)"})
                continue
            old_reg = dict((old or {}).get("registration") or {})
            m["registration"] = {"registered_at": now_local_iso(), "registered_by": user.annotator_id,
                                 "registered_via": "browser", "notes": old_reg.get("notes", ""),
                                 "retired": bool(old_reg.get("retired", False))}
            self.store.add_manifest(m)
            (replaced if old is not None else added).append(rid)
        if added or replaced:
            extra = (f", replaced {audit.count(len(replaced), 'recording')}" if replaced else "") + (
                f", {len(skipped)} not registered" if skipped else "")
            self._audit(user, "recordings_register", f"Registered {audit.count(len(added), 'new recording')}"
                        f"{extra} in {scope}", scope=scope, added=added, replaced=replaced,
                        skipped=[s["recording_id"] for s in skipped])
        return {"added": added, "replaced": replaced, "skipped": skipped}

    def _manifest(self, body: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
        scope = self._scope(body.get("scope"))
        rid = _rid(body.get("recording_id"))
        m = self.store.manifest(scope, rid)
        if m is None:
            raise ApiError(404, "unknown_recording", f"{rid} is not registered in {scope}")
        return scope, rid, m

    def op_recording_update(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        scope, rid, m = self._manifest(body)
        notes = body.get("notes")
        if notes is not None:
            notes = _text(body, "notes", limit=5000)
        retired = _bool(body, "retired")
        reg = dict(m.get("registration") or {"registered_at": m.get("created_at", ""), "registered_by": "",
                                               "registered_via": "command"})
        said = []
        if notes is not None and notes != reg.get("notes", ""):
            reg["notes"] = notes
            said.append("changed the notes")
        if retired is not None and retired != bool(reg.get("retired", False)):
            reg["retired"] = retired
            said.append("retired it (no new assignments)" if retired else "offered it for assignments again")
        m = {**m, "registration": reg}
        self.store.add_manifest(m)
        self._audit(user, "recording_update", f"{rid}: " + (", ".join(said) if said else "no change"), scope=scope,
                    recording_id=rid, notes=notes, retired=retired)
        return {"recording": self.recording_record(m)}

    def op_recording_remove(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        scope, rid, _m = self._manifest(body)
        if self._has_results(scope, rid):
            raise ApiError(409, "has_results", f"Annotations of {rid} have been saved, so it stays registered "
                           "(retire it instead, to offer it for no new assignments).")
        for rs in self.store.reference_sets():
            if self._set_scope(rs) == scope and (rid in rs.recordings
                                                 or any(it.recording_id == rid for it in rs.quiz_items)):
                raise ApiError(409, "has_results", f"The reference set {rs.set_id} uses {rid}; remove it from the "
                               "set first.")
        self.store.remove_manifest(scope, rid)
        if scope == SCOPE_STUDY:
            self.store.remove_assignments(recording_id=rid, modes=("standard",))
        else:
            self.store.remove_assignments(recording_id=rid, context_id=scope[4:])
        self._audit(user, "recording_remove", f"Removed {rid} from {scope}", scope=scope, recording_id=rid)
        return {}

    # ------------------------------------------------------- reference sets
    def op_sets_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return {"sets": [self.set_record(rs) for rs in self.store.reference_sets()]}

    def op_set_create(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.training.reference import METHODS
        from electrotag.web.registration import reference_set_payload

        set_id = _text(body, "set_id", required=True, limit=64)
        if not SET_ID_RE.match(set_id):
            raise _bad("A reference set ID is 1 to 64 letters, digits, dots, hyphens or underscores")
        if any(rs.set_id == set_id for rs in self.store.reference_sets()):
            raise ApiError(409, "set_exists", f"There is already a reference set {set_id}")
        name = _text(body, "name", limit=200)
        description = _text(body, "description", limit=5000)
        method = body.get("method") or "single_expert"
        if method not in METHODS:
            raise _bad(f"method must be one of {', '.join(METHODS)}")
        experts = _ids(body["experts"], "experts", minimum=0) if body.get("experts") is not None else []
        notes = _text(body, "notes", limit=5000)
        with tempfile.TemporaryDirectory(prefix="electrotag-set-") as tmp:
            try:
                rs = ReferenceSet.create(Path(tmp), set_id, name=name, description=description,
                                         created_by=user.annotator_id, method=method, experts=experts, notes=notes)
            except ReferenceSetError as exc:
                raise _bad(str(exc)) from exc
            rs.recordings_dir = "recordings"  # self-contained: its recordings are never study recordings
            rs.save()
            definition, files = reference_set_payload(rs.directory)
        self.store.put_reference_set(definition, files)
        self._audit(user, "set_create", f"Created the reference set {set_id}" + (f" ({name})" if name else ""),
                    set_id=set_id, name=name, method=method, experts=experts)
        return {"set": self.set_record(self.service.reference_set(set_id))}

    def op_set_update(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rs0 = self._set(body.get("set_id"))
        changed: list[str] = []
        with self._editing(rs0.set_id) as rs:
            if body.get("name") is not None:
                rs.name = _text(body, "name", limit=200)
                changed.append("name")
            if body.get("description") is not None:
                rs.description = _text(body, "description", limit=5000)
                changed.append("description")
            review = _bool(body, "practice_review")
            if review is not None:
                rs.practice_review = review
                changed.append("practice review")
            full = _bool(body, "show_full_report_to_annotator")
            if full is not None:
                rs.show_full_report_to_annotator = full
                changed.append("full report for annotators")
            if body.get("allowed_annotators") is not None:
                rs.assigned_annotators = sorted(set(_ids(body["allowed_annotators"], "allowed_annotators",
                                                         minimum=0)))
                changed.append("allowed annotators")
            if body.get("practice_pass") is not None:
                rs.set_practice_pass({**rs.practice_pass, **_numbers(body["practice_pass"], "practice_pass",
                                                                     ("event_f1", "label_accuracy"))})
                changed.append("practice pass mark")
            if body.get("guided_tolerance") is not None:
                given = _plain(body["guided_tolerance"], "guided_tolerance")
                numbers = _numbers({k: v for k, v in given.items() if k != "accepted_labels"}, "guided_tolerance",
                                   ("seconds", "fraction", "channel_jaccard"))
                if "accepted_labels" in given:
                    numbers["accepted_labels"] = _accepted(given["accepted_labels"], self.store.catalogue)
                rs.set_guided_tolerance({**dict(rs.guided.get("tolerance") or {}), **numbers})
                changed.append("guided tolerance")
            if body.get("criteria") is not None:
                rs.set_criteria(_criteria(body["criteria"]))
                changed.append("competency criteria")
            if body.get("quiz") is not None:
                quiz = _plain(body["quiz"], "quiz")
                unknown = set(quiz) - {"include_none_option", "feedback"}
                if unknown:
                    raise ApiError(400, "invalid_set", f"Unknown quiz option {sorted(unknown)[0]!r}")
                if "include_none_option" in quiz:
                    if not isinstance(quiz["include_none_option"], bool):
                        raise ApiError(400, "invalid_set", "quiz.include_none_option must be true or false")
                    if not quiz["include_none_option"] and any(it.correct_label == NONE_OPTION
                                                               for it in rs.quiz_items):
                        raise ApiError(400, "invalid_set", f"Some quiz items have {NONE_OPTION!r} as their answer; "
                                       "remove them first")
                    rs.quiz["include_none_option"] = quiz["include_none_option"]
                if "feedback" in quiz:
                    if quiz["feedback"] not in QUIZ_FEEDBACK:
                        raise ApiError(400, "invalid_set", "quiz.feedback must be 'immediate' or 'end'")
                    rs.quiz["feedback"] = quiz["feedback"]
                changed.append("quiz options")
            if not changed:
                raise _bad("Nothing to change")
            rs.save()
        self._audit(user, "set_update", f"Changed the reference set {rs0.set_id}: {', '.join(changed)}",
                    set_id=rs0.set_id, **{k: body[k] for k in ("name", "description", "practice_review",
                                                               "allowed_annotators", "practice_pass",
                                                               "guided_tolerance", "criteria", "quiz",
                                                               "show_full_report_to_annotator") if k in body})
        return {"set": self.set_record(self.service.reference_set(rs0.set_id))}

    def op_set_delete(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rs = self._set(body.get("set_id"))
        if any(e.get("context") == rs.set_id for e in self._entries()):
            raise ApiError(409, "in_use", f"Trainees have saved recordings in {rs.set_id}, so it stays.")
        records = self.store.user_records()
        enrolled = [u["annotator_id"] for u in records if self.store.programme(u["annotator_id"]) == rs.set_id]
        if enrolled:
            raise ApiError(409, "in_use", f"{', '.join(enrolled)} take the training programme {rs.set_id}; take "
                           "them out of it first.")
        if any((self.store.quiz_state(u["annotator_id"], rs.set_id) or {}).get("finished") for u in records):
            raise ApiError(409, "in_use", f"Annotators have finished the quiz of {rs.set_id}, so it stays.")
        for m in [m for m in self.store.manifests() if m["scope"] == set_scope(rs.set_id)]:
            self.store.remove_manifest(m["scope"], m["recording_id"])
        self.store.remove_assignments(context_id=rs.set_id)
        self.store.delete_reference_set(rs.set_id)
        self._audit(user, "set_delete", f"Deleted the reference set {rs.set_id}", set_id=rs.set_id, name=rs.name)
        return {}

    # ----------------------------------------------- references from sources
    def _saved_doc(self, aid: str, rid: str, mode: str, ctx: str) -> tuple[AnnotationDocument, bytes, str]:
        from electrotag.app.annotations.model import AnnotationError
        from electrotag.app.io.canonical import document_from_dict

        files = self.store.saved_files(aid, rid, mode, ctx)
        name = next((n for n in sorted(files) if n.endswith("_annotations.json")), None)
        if name is None:
            raise ApiError(404, "no_saved_annotations", f"{aid} has not saved {rid}"
                           + ("" if mode == "standard" else f" ({mode}, {ctx})"))
        try:
            return document_from_dict(json.loads(files[name])), files[name], name
        except (AnnotationError, ValueError, KeyError) as exc:
            raise ApiError(500, "reference_unavailable", f"The saved annotations of {aid} cannot be read") from exc

    def _source(self, source: Any, rid: str, folder: Path) -> dict[str, Any]:
        """The reference document and how it was made, from a Source of docs/web/api.md."""
        from electrotag.app.annotations.model import AnnotationError
        from electrotag.app.io.canonical import document_from_dict
        from electrotag.training.consensus import build_consensus

        if not isinstance(source, dict) or source.get("kind") not in ("annotator", "document", "consensus",
                                                                       "adjudicated"):
            raise _bad("source.kind must be annotator, document, consensus or adjudicated")
        kind = source["kind"]
        mode, ctx = _mode_ctx(source)

        def keep(name: str, data: bytes) -> Path:
            p = folder / name
            p.write_bytes(data)
            return p

        if kind == "annotator":
            aid = _aid(source.get("annotator_id"), "source.annotator_id")
            doc, data, name = self._saved_doc(aid, rid, mode, ctx)
            return {"doc": doc, "method": "single_expert", "experts": [aid], "files": [keep(name, data)]}
        if kind == "document":
            raw = source.get("document")
            if not isinstance(raw, dict):
                raise _bad("source.document must be the contents of an _annotations.json file")
            data = json.dumps(raw).encode("utf-8")
            if len(data) > MAX_DOCUMENT_BYTES:
                raise ApiError(413, "too_large", "The annotation file is too large")
            try:
                doc = document_from_dict(raw)
            except (AnnotationError, ValueError, KeyError, TypeError) as exc:
                raise ApiError(422, "invalid_document", f"This is not a valid ElectroTag annotation file: {exc}") \
                    from exc
            cat = self.store.catalogue
            if doc.catalogue.sha256 != cat.sha256 and not doc.catalogue.compatible_with(cat):
                raise ApiError(422, "invalid_document", "The file uses a label catalogue that gives labels or codes "
                               "other meanings than this study's")
            expert = doc.annotator_id or "EXPERT"
            return {"doc": doc, "method": "single_expert", "experts": [expert],
                    "files": [keep(f"uploaded_{re.sub(r'[^A-Za-z0-9_-]', '-', expert)}_annotations.json", data)]}
        if kind == "consensus":
            aids = _ids(source.get("annotator_ids"), "source.annotator_ids", minimum=2)
            docs, files = [], []
            for aid in aids:
                doc, data, name = self._saved_doc(aid, rid, mode, ctx)
                docs.append(doc)
                files.append(keep(name, data))
            k = source.get("min_agreement")
            if k is not None and (isinstance(k, bool) or not isinstance(k, int)):
                raise _bad("source.min_agreement must be a whole number of experts (or null for a majority)")
            try:
                res = build_consensus(docs, min_agreement=k,
                                      min_duration_s=_number(source, "min_duration_s", minimum=0, maximum=3600,
                                                             default=0.0),
                                      merge_gap_s=_number(source, "merge_gap_s", minimum=0, maximum=3600, default=0.0))
            except AnnotationError as exc:
                raise ApiError(422, "invalid_consensus", str(exc)) from exc
            return {"doc": res.document, "method": "consensus", "experts": list(res.rule["experts"]),
                    "files": files, "details": {"consensus_rule": res.rule}, "disagreements": res.disagreements}
        adj = _aid(source.get("adjudicator_id"), "source.adjudicator_id")
        experts = _ids(source.get("expert_ids"), "source.expert_ids", minimum=2)
        doc, data, name = self._saved_doc(adj, rid, mode, ctx)
        files = [keep(name, data)]
        for aid in experts:  # the experts' own files are kept as sources when they were saved here
            saved = self.store.saved_files(aid, rid, mode, ctx)
            ename = next((n for n in sorted(saved) if n.endswith("_annotations.json")), None)
            if ename is not None and ename != name:
                files.append(keep(ename, saved[ename]))
        return {"doc": doc, "method": "adjudicated", "experts": experts, "adjudicator": adj, "files": files}

    def op_set_add_reference(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.app.annotations.model import AnnotationError, validate_annotation
        from electrotag.web.service import clean_json

        rs0 = self._set(body.get("set_id"))
        rid = _rid(body.get("recording_id"))
        use = body.get("use")
        if use not in USES:
            raise _bad(f"use must be one of {', '.join(USES)}")
        from_scope = self._scope(body.get("recording_scope"))
        m = self.store.manifest(from_scope, rid)
        if m is None:
            raise ApiError(404, "unknown_recording", f"{rid} is not registered in {from_scope}")
        target = self._set_scope(rs0)
        if not rs0.self_contained and from_scope != SCOPE_STUDY:
            raise _bad(f"The reference set {rs0.set_id} uses the study's recordings (recording_scope 'study')")
        if target != from_scope:
            existing = self.store.manifest(target, rid)
            if existing is not None and fingerprint_of(existing) != fingerprint_of(m):
                raise ApiError(409, "conflict", f"The set already holds a different recording called {rid}")
        prov = body.get("provenance") or {}
        if not isinstance(prov, dict):
            raise _bad("provenance must be an object")
        notes = _text(prov, "notes", limit=5000)
        info = manifest_info(m)
        with tempfile.TemporaryDirectory(prefix="electrotag-sources-") as tmp:
            src = self._source(body.get("source"), rid, Path(tmp))
            doc = src["doc"]
            t = doc.recording.timing
            if abs(float(t.sfreq) - info.timing.sfreq) > 1e-6 or int(t.n_samples) != info.timing.n_samples:
                raise ApiError(422, "invalid_document", f"The annotations describe a recording of {t.n_samples} "
                               f"samples at {t.sfreq:g} Hz, but {rid} has {info.timing.n_samples} samples at "
                               f"{info.timing.sfreq:g} Hz")
            doc = replace(doc, recording=info)
            try:
                for a in doc.annotations:
                    validate_annotation(a, info, self.store.catalogue, 1)
            except AnnotationError as exc:
                raise ApiError(422, "invalid_document", f"An annotation does not fit {rid}: {exc}") from exc
            details = dict(src.get("details") or {})
            if notes:
                details["notes"] = notes
            if target != from_scope:  # copied into the set, so it is never offered for study annotation
                copied = copy.deepcopy(m)
                copied["scope"] = target
                copied["registration"] = {**dict(m.get("registration") or {}), "registered_at": now_local_iso(),
                                          "registered_by": user.annotator_id, "copied_from": from_scope,
                                          "retired": False}
                self.store.add_manifest(copied)
            with self._editing(rs0.set_id) as rs:
                try:
                    rs.add_reference(doc, use=use, method=src["method"], experts=src["experts"],
                                     source_files=src["files"], adjudicator=src.get("adjudicator", ""),
                                     details=details)
                except (AnnotationError, ReferenceSetError) as exc:
                    raise ApiError(422, "invalid_document", str(exc)) from exc
        experts = ", ".join(src["experts"])
        how = {"single_expert": f"{experts}'s annotations", "consensus": f"consensus of {experts}",
               "adjudicated": f"{src.get('adjudicator')} adjudicating {experts}"}[src["method"]]
        self._audit(user, "set_add_reference", f"Added {rid} to {rs0.set_id} for {use} ({how})", set_id=rs0.set_id,
                    recording_id=rid, use=use, method=src["method"], experts=src["experts"],
                    adjudicator=src.get("adjudicator"), recording_scope=from_scope, n_annotations=len(doc.annotations))
        dis = src.get("disagreements")
        return {"set": self.set_record(self.service.reference_set(rs0.set_id)),
                "disagreements": clean_json(dis) if dis is not None else None}

    def op_set_recording_update(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rs0 = self._set(body.get("set_id"))
        rid = _rid(body.get("recording_id"))
        if rid not in rs0.recordings:
            raise ApiError(404, "not_in_set", f"{rid} is not in the reference set {rs0.set_id}")
        use, guidance = body.get("use"), body.get("guidance")
        if use is not None and use not in USES:
            raise _bad(f"use must be one of {', '.join(USES)}")
        if guidance is not None and guidance not in ("auto", *GUIDANCE_LEVELS):
            raise _bad(f"guidance must be one of auto, {', '.join(GUIDANCE_LEVELS)}")
        if use is None and guidance is None:
            raise _bad("Nothing to change: give use or guidance")
        warnings: list[str] = []
        old_use = rs0.recordings[rid].get("use")
        if use is not None and use != old_use:
            saved = sorted({(e.get("annotator_id", ""), e.get("mode", "")) for e in self._entries()
                            if e.get("context") == rs0.set_id and e.get("recording_id") == rid})
            others = sorted({a for a, mode in saved if mode != use})
            if others and use == "assessment":
                warnings.append(f"{', '.join(others)} already annotated this recording with feedback, so their "
                                "assessment on it would not be blind.")
            elif others:
                warnings.append(f"{', '.join(others)} already saved this recording as {old_use}; their results stay.")
        if guidance is not None and (use or old_use) != "guided":
            warnings.append("How much help a recording gives matters only for guided recordings.")
        with self._editing(rs0.set_id) as rs:
            if use is not None:
                rs.set_use(rid, use)
            if guidance is not None:
                rs.set_guidance(rid, "" if guidance == "auto" else guidance)
        said = ([f"now used for {use}"] if use is not None and use != old_use else []) + (
            [f"guidance {guidance}"] if guidance is not None else [])
        self._audit(user, "set_recording_update", f"{rid} in {rs0.set_id}: " + (", ".join(said) or "no change"),
                    set_id=rs0.set_id, recording_id=rid, use=use, guidance=guidance, warnings=warnings)
        return {"set": self.set_record(self.service.reference_set(rs0.set_id)), "warnings": warnings}

    def op_set_remove_recording(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rs0 = self._set(body.get("set_id"))
        rid = _rid(body.get("recording_id"))
        if rid not in rs0.recordings:
            raise ApiError(404, "not_in_set", f"{rid} is not in the reference set {rs0.set_id}")
        with self._editing(rs0.set_id) as rs:
            rs.remove_recording(rid)
        self._audit(user, "set_remove_recording", f"Took {rid} out of the reference set {rs0.set_id}",
                    set_id=rs0.set_id, recording_id=rid)
        return {"set": self.set_record(self.service.reference_set(rs0.set_id))}

    def op_set_guided_notes(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rs = self._set(body.get("set_id"))
        rid = _rid(body.get("recording_id"))
        try:
            ref = rs.reference_document(rid)
        except ReferenceSetError as exc:
            raise ApiError(404, "not_in_set", str(exc)) from exc
        t = ref.recording.timing
        return {"notes": [{"annotation_id": a.annotation_id, "label": a.label, "onset_s": a.onset(t),
                           "offset_s": a.offset(t), "note": rs.guided_note(a.annotation_id)}
                          for a in ref.sorted_annotations()]}

    def op_set_guided_note(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rs0 = self._set(body.get("set_id"))
        ann_id = _text(body, "annotation_id", required=True, limit=64)
        text = _text(body, "text", limit=2000)
        with self._editing(rs0.set_id) as rs:
            try:
                rs.set_guided_note(ann_id, text)
            except ReferenceSetError as exc:
                raise ApiError(404, "unknown_annotation", str(exc)) from exc
        self._audit(user, "set_guided_note", f"{'Changed' if text else 'Removed'} the experts' note on annotation "
                    f"{ann_id} in {rs0.set_id}", set_id=rs0.set_id, annotation_id=ann_id, text=text)
        return {}

    def op_set_example_create(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.training.examples import EXAMPLE_SET_ID
        from electrotag.web.example import ZIP_NAME, ExampleUnavailable, build_example

        if any(rs.set_id == EXAMPLE_SET_ID for rs in self.store.reference_sets()):
            raise ApiError(409, "set_exists", f"There is already a reference set {EXAMPLE_SET_ID}")
        try:
            ex = build_example(self.store.settings, self.store.catalogue)
        except ExampleUnavailable as exc:
            raise ApiError(422, "example_unavailable", str(exc)) from exc
        for m in ex.manifests:
            m["registration"] = {"registered_at": now_local_iso(), "registered_by": user.annotator_id,
                                 "registered_via": "browser", "notes": "ElectroTag's simulated example recording",
                                 "retired": False}
            self.store.add_manifest(m)
        self.store.put_reference_set(ex.definition, ex.files)
        self._audit(user, "set_example_create", f"Added ElectroTag's example training set ({ex.set_id}) with "
                    f"{audit.count(len(ex.manifests), 'simulated recording')}", set_id=ex.set_id,
                    recordings=[m["recording_id"] for m in ex.manifests], registered_with=ex.registered_with)
        return {"set": self.set_record(self.service.reference_set(ex.set_id)),
                "recordings_zip": {"file_name": ZIP_NAME, "base64": base64.b64encode(ex.recordings_zip).decode("ascii"),
                                   "size_bytes": len(ex.recordings_zip)}}

    # ----------------------------------------------------------------- quiz
    def op_quiz_items(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rs = self._set(body.get("set_id"))
        return {"items": [it.to_dict() for it in rs.quiz_items]}

    def op_quiz_item_add(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.training.reference import QuizItem

        rs0 = self._set(body.get("set_id"))
        rid = _rid(body.get("recording_id"))
        m = self.store.manifest(self._set_scope(rs0), rid)
        if m is None:
            raise ApiError(404, "unknown_recording", f"{rid} is not one of the reference set's registered recordings")
        duration = float(m["timing"]["n_samples"]) / float(m["timing"]["sfreq"])
        start = _number(body, "start_s", minimum=0, maximum=duration)
        end = _number(body, "end_s", minimum=0, maximum=duration)
        if end <= start:
            raise _bad("end_s must be after start_s")
        context = _number(body, "context_s", minimum=0, maximum=60, default=2.0)
        cat = self.store.catalogue
        label = body.get("correct_label")
        if label != NONE_OPTION and (not isinstance(label, str) or not cat.is_permitted(label)):
            raise _bad("correct_label must be one of the catalogue's artifact types")
        accepted = body.get("accepted_labels") or []
        if not isinstance(accepted, list) or not all(isinstance(x, str) and (cat.is_permitted(x) or x == NONE_OPTION)
                                                     for x in accepted):
            raise _bad("accepted_labels must be artifact types of the catalogue")
        explanation = _text(body, "explanation", limit=2000)
        item_id = body.get("item_id")
        if item_id is None:
            have = {it.item_id for it in rs0.quiz_items}
            n = len(have) + 1
            while f"q{n:02d}" in have:
                n += 1
            item_id = f"q{n:02d}"
        elif not isinstance(item_id, str) or not ITEM_ID_RE.match(item_id):
            raise _bad("item_id must be 1 to 64 letters, digits, dots, hyphens or underscores")
        item = QuizItem(item_id, rid, start, end, label, list(dict.fromkeys(accepted)), explanation, context)
        replacing = any(it.item_id == item_id for it in rs0.quiz_items)
        with self._editing(rs0.set_id) as rs:
            try:
                rs.add_quiz_item(item, cat.label_names)
            except ReferenceSetError as exc:
                raise _bad(str(exc)) from exc
        self._audit(user, "quiz_item_add", f"{'Changed' if replacing else 'Added'} quiz item {item_id} in "
                    f"{rs0.set_id} ({label}, {start:g} to {end:g} s of {rid})", set_id=rs0.set_id, item=item.to_dict())
        return {"item": item.to_dict()}

    def op_quiz_item_remove(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rs0 = self._set(body.get("set_id"))
        item_id = _text(body, "item_id", required=True, limit=64)
        with self._editing(rs0.set_id) as rs:
            try:
                rs.remove_quiz_item(item_id)
            except ReferenceSetError as exc:
                raise ApiError(404, "unknown_item", str(exc)) from exc
        self._audit(user, "quiz_item_remove", f"Removed quiz item {item_id} from {rs0.set_id}", set_id=rs0.set_id,
                    item_id=item_id)
        return {}

    # ------------------------------------------------------------ analyses
    def op_progress(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.admin_progress(user, {})

    def op_stats(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """How far the study has got and how long the work takes (docs/web/api.md, ``stats``)."""
        work = body.get("work") or "study"
        if work not in STATS_WORK:
            raise _bad("work must be 'study' (the study's own annotation) or 'all' (training too)")

        def counted(mode: str) -> bool:
            return work == "all" or mode == "standard"

        today = _day(now_local_iso()) or date.today()
        days = [today - timedelta(days=STATS_DAYS - 1 - i) for i in range(STATS_DAYS)]
        index = {d: i for i, d in enumerate(days)}
        entries = [e for e in self._entries() if counted(e.get("mode", "standard"))]
        last_visit: dict[str, str] = {}
        for v in self.store.visit_records(None, 1000):
            aid = v.get("annotator_id", "")
            last_visit[aid] = max(last_visit.get(aid, ""), str(v.get("started_at") or ""))

        def daily(rows: list[dict[str, Any]]) -> list[int]:
            out = [0] * STATS_DAYS
            for e in rows:
                d = _day(e.get("completed_at"))
                if d in index:
                    out[index[d]] += 1
            return out

        def since(rows: list[dict[str, Any]], n: int) -> int:
            first = today - timedelta(days=n - 1)
            return sum(1 for e in rows if (d := _day(e.get("completed_at"))) is not None and first <= d <= today)

        # A recording saved again (a revision, or a practice recording repeated) has several attempts: it is
        # one recording done, on the day of its first save, with the annotations of its latest attempt and
        # the time of all its attempts together.
        groups: dict[tuple[str, str, str, str], list[dict[str, str]]] = {}
        for e in entries:
            groups.setdefault((e.get("annotator_id", ""), e.get("recording_id", ""), e.get("mode", "standard"),
                               e.get("context", "")), []).append(e)
        works = []
        for rows in groups.values():
            first = min(rows, key=lambda e: (attempt_of(e), str(e.get("completed_at", ""))))
            times = [t for e in rows if (t := _seconds(e.get("elapsed_s"))) is not None]
            works.append({"annotator_id": first.get("annotator_id", ""), "recording_id": first.get("recording_id", ""),
                          "mode": first.get("mode", "standard"), "context": first.get("context", ""),
                          "completed_at": first.get("completed_at", ""), "last_at": max(str(e.get("completed_at") or "")
                                                                                         for e in rows),
                          "elapsed_s": sum(times) if times else None,
                          "n_annotations": latest_entry(rows).get("n_annotations")})
        by_person: dict[str, list[dict[str, Any]]] = {}
        for w in works:
            by_person.setdefault(w["annotator_id"], []).append(w)
        recordings: dict[tuple[str, str], dict[str, Any]] = {}
        scopes: dict[tuple[str, str], str] = {}

        def scope_of(mode: str, context_id: str) -> str:
            """Where a recording is kept, asked once for each mode and context (a reference set is read once)."""
            if (mode, context_id) not in scopes:
                scopes[(mode, context_id)] = self.service.scope_for(mode, context_id)
            return scopes[(mode, context_id)]

        people = []
        totals = {"assigned": 0, "done": 0, "in_progress": 0, "todo": 0, "unusable": 0}
        draft_s = 0.0
        for rec in self.store.user_records():
            aid = rec["annotator_id"]
            person = User(aid, rec.get("display_name", ""), rec.get("role", "annotator"))
            active = rec.get("status", "active") == "active"
            items = [i for i in self.service.work_items(person) if counted(i.mode)]
            mine = by_person.get(aid, [])
            status = {id(i): "todo" if i.status == "locked" else i.status for i in items}  # locked: to do after training
            counts = {k: sum(1 for i in items if status[id(i)] == k) for k in ("done", "in_progress", "todo", "unusable")}
            in_progress_s, last = 0.0, [str(rec.get("last_seen") or ""), last_visit.get(aid, "")]
            for i in items:
                if i.status == "in_progress":
                    d = self.store.draft(aid, i.key) or {}
                    in_progress_s += _seconds((d.get("draft") or {}).get("elapsed_s")) or 0.0
                    last.append(str(d.get("saved_at") or ""))
                if active:
                    key = (scope_of(i.mode, i.context_id), i.recording_id)
                    r = recordings.setdefault(key, {"scope": key[0], "recording_id": i.recording_id,
                                                    "file_name": i.manifest.get("file_name", ""), "assigned": 0,
                                                    "done": 0, "in_progress": 0, "unusable": 0})
                    r["assigned"] += 1
                    if i.status in ("done", "in_progress", "unusable"):
                        r[i.status] += 1
            if active:
                totals["assigned"] += len(items)
                for k, n in counts.items():
                    totals[k] += n
                draft_s += in_progress_s
            times = [t for e in mine if (t := _seconds(e.get("elapsed_s"))) is not None]
            n_anns = [n for e in mine if (n := _seconds(e.get("n_annotations"))) is not None]
            last.extend(str(e.get("last_at") or "") for e in mine)
            people.append({
                "annotator_id": aid, "display_name": rec.get("display_name", ""), "role": rec.get("role", "annotator"),
                "status": rec.get("status", "active"), "assigned": len(items), **counts,
                "share_done": counts["done"] / len(items) if items else None,
                "time_s": sum(times), "in_progress_s": in_progress_s, "median_s": _median(times),
                "median_annotations": _median(n_anns), "last_active": max(last) or None,
                "done_7d": since(mine, 7), "daily": daily(mine)})
        by_recording: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for e in works:
            key = (scope_of(e.get("mode", "standard"), e.get("context", "")), e.get("recording_id", ""))
            by_recording.setdefault(key, []).append(e)
        for key, r in recordings.items():
            rows = by_recording.get(key, [])
            times = [t for e in rows if (t := _seconds(e.get("elapsed_s"))) is not None]
            n_anns = [n for e in rows if (n := _seconds(e.get("n_annotations"))) is not None]
            r.update(median_s=_median(times), median_annotations=_median(n_anns),
                     min_annotations=min(n_anns) if n_anns else None, max_annotations=max(n_anns) if n_anns else None,
                     saved=len(rows))
        times = [t for e in works if (t := _seconds(e.get("elapsed_s"))) is not None]
        # A recording that cannot be annotated is finished for its annotator, but it is not done.
        remaining = totals["assigned"] - totals["done"] - totals["unusable"]
        pace, pace_days, projection = pace_projection(
            [d for e in works if (d := _day(e.get("completed_at"))) is not None], today,
            assigned=totals["assigned"], remaining=remaining)
        return {
            "generated_at": now_local_iso(), "work": work, "today": today.isoformat(),
            "days": [d.isoformat() for d in days],
            "totals": {**totals, "share_done": totals["done"] / totals["assigned"] if totals["assigned"] else None,
                       "remaining": remaining, "annotator_hours": (sum(times) + draft_s) / 3600,
                       "median_minutes": (m / 60 if (m := _median(times)) is not None else None),
                       "done_7d": since(works, 7), "done_30d": since(works, 30),
                       "pace_per_day": pace, "pace_days": pace_days, "projection": projection,
                       **self._feedback_counts()},
            "daily": daily(works),
            "annotators": people,
            "recordings": sorted(recordings.values(), key=lambda r: (r["scope"] != SCOPE_STUDY, r["scope"],
                                                                     r["recording_id"])),
        }

    def op_agreement(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.analyses.agreement(body)

    def op_activity(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.analyses.activity(body)

    def op_competency(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.analyses.competency(body)

    def op_results_zip(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.analyses.results_zip(body)

    # ------------------------------------------------------------ the record
    def op_audit(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        limit = int(_number(body, "limit", minimum=1, maximum=500, default=50))
        before = body.get("before")
        if before is not None and (not isinstance(before, str) or len(before) > 64):
            raise _bad("before must be the 'next' value of an earlier page")
        try:
            entries, nxt = self.store.audit_page(before or None, limit)
        except StoreError as exc:
            raise _bad(str(exc)) from exc
        return {"entries": entries, "next": nxt}

    def op_visits(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        limit = int(_number(body, "limit", minimum=1, maximum=1000, default=100))
        aid = _aid(body.get("annotator_id")) if body.get("annotator_id") is not None else None
        return {"visits": self.store.visit_records(aid, limit)}

    # ------------------------------------------------------- the training path
    # (electrotag/web/training_path.py; the snippets are the expert channel's operations too)
    def op_snippets_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.training_path.snippets_list(user, body)

    def op_snippet_add(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.training_path.snippet_add(user, body)

    def op_snippet_remove(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.training_path.snippet_remove(user, body)

    def op_training_gate_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.training_path.admin_gate_get(user, body)

    def op_training_reopen(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.training_path.admin_reopen(user, body)

    def op_training_assessment_set(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.training_path.admin_assessment_set(user, body)
