"""Where a study's records are kept: the storage interface of the web service.

:class:`~electrotag.web.service.StudyService` performs every operation of docs/web/api.md
against a :class:`Store`. There are two implementations:

* :class:`~electrotag.web.store_files.FilesStore`: a study folder with an SQLite file, used by the
  ElectroTag server (``electrotag-web serve`` and ``demo``). Results are written straight into
  ElectroTag's usual folders.
* :class:`~electrotag.web.store_firestore.FirestoreStore`: Firestore, used by the Firebase
  functions. Results are kept as documents and exported into the same folders with
  ``electrotag-web export``.

Both run the desktop application's own code to produce the result files, so the files are the same
whichever store is used.
"""

from __future__ import annotations

import copy
import hashlib
import re
from abc import ABC, abstractmethod
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from electrotag.config.settings import Settings, deep_merge, load_default_settings_dict

if TYPE_CHECKING:
    from electrotag.app.annotations.labels import LabelCatalogue
    from electrotag.app.session.session import AnnotationSession, FinishResult
    from electrotag.training.programme import Progress
    from electrotag.training.reference import ReferenceSet

MODES = ("standard", "guided", "practice", "assessment")
#: The kinds of record kept with :meth:`Store.update_record`: problem reports, reviews of saved work, the
#: marks of assignments that cannot be annotated (each annotator's, by item key), and the records of the
#: expert work: tasks (``annotator_id`` ""), corrections (the corrected person's), adjudications (the
#: adjudicator's) and gold scores (docs/web/api.md, "Experts").
RECORD_KINDS = ("problems", "reviews", "unusable", "tasks", "corrections", "adjudications", "gold")
#: The records of the study's datasets (electrotag/web/datasets.py; docs/web/api.md, "Datasets, collections, groups
#: and hand-outs"): the details of source datasets, collections, groups of people, hand-outs and the notices that
#: would be sent about them, each with ``annotator_id`` "".
RECORD_KINDS += ("datasets", "collections", "groups", "handouts", "notices")
#: The sign-up questionnaire's answers and each person's contact details, kept apart (electrotag/web/questionnaire.py).
RECORD_KINDS += ("questionnaires", "contacts")
#: A record's ID: letters, digits, "_" and "-" (the browser makes 32 hexadecimal characters).
RECORD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
#: The roles a person can be given now. One person may hold several (an expert who also annotates).
ROLES = ("annotator", "expert", "admin")
#: Roles that are read and kept but cannot be given yet (the crowd participant of a later study).
RESERVED_ROLES = ("participant",)
KNOWN_ROLES = ROLES + RESERVED_ROLES
#: The roles that open more than annotating; on Firebase they count only when both the person's claims
#: and their account in the study grant them.
PRIVILEGED_ROLES = ("expert", "admin")
#: The order of precedence: a person's primary role (the old ``role`` field) is the first they hold.
ROLE_ORDER = ("admin", "expert", "annotator", "participant")
#: IDs that are never accounts: the adjudicated version's and a training reference's annotator.
RESERVED_IDS = ("ADJUDICATED", "REFERENCE")
#: The kinds of derived version (:meth:`Store.save_derived`): an expert's correction of someone's saved
#: work, and the adjudicated version of a task. Each has its own results tree and completion register.
DERIVED_KINDS = ("corrections", "adjudications")
#: Where the derived versions are kept below the results folder (``Annotated_Events/derived/<kind>/``).
DERIVED_DIR = "derived"
#: How many closed browser sessions are remembered per draft (Store.delete_draft).
CLOSED_SESSIONS_KEPT = 20
STATUSES = ("active", "disabled")
#: Who changed something, in the audit log, when it was an ``electrotag-web`` command.
BY_COMMAND = "command"
#: The answer of :meth:`Store.create_account` and :meth:`Store.reset_password`.
Credentials = dict[str, Any]  # {"invite_link": str | None, "temporary_password": str | None}
#: The answer of :meth:`Store.create_invitation`.
Invitation = dict[str, Any]  # {"invite_token": str | None, "invite_link": str | None, "expires_at": str | None}


def parse_roles(value: str | list[Any] | tuple[Any, ...] | None, fallback: str = "annotator") -> tuple[str, ...]:
    """A person's roles from what a store or the claims keep: ``"annotator,expert"``, a list, or the old single
    ``role``. Unknown names are dropped; the result is in :data:`ROLE_ORDER` and never empty (``fallback``)."""
    if value is None:
        items: list[Any] = []
    elif isinstance(value, str):
        items = [x.strip() for x in value.split(",")]
    elif isinstance(value, (list, tuple)):
        items = [str(x).strip() for x in value if isinstance(x, str)]
    else:
        items = []
    found = {x for x in items if x in KNOWN_ROLES}
    out = tuple(r for r in ROLE_ORDER if r in found)
    return out or ((fallback,) if fallback else ())


def primary_role(roles: tuple[str, ...] | list[str]) -> str:
    """The first of ``roles`` in :data:`ROLE_ORDER` (kept as the old ``role``); "annotator" when there is none."""
    return next((r for r in ROLE_ORDER if r in roles), "annotator")


def roles_text(roles: tuple[str, ...] | list[str]) -> str:
    """``an annotator and expert``, ``an administrator``: the roles as the audit log's summaries say them."""
    words = {"annotator": "annotator", "expert": "expert", "admin": "administrator", "participant": "participant"}
    names = [words[r] for r in ("annotator", "expert", "admin", "participant") if r in roles] or ["annotator"]
    joined = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]
    return ("an " if joined[0] in "aeiou" else "a ") + joined


@dataclass(frozen=True)
class User:
    """A person signed in to the study. ``role`` is the primary role (every positional ``User(aid, name,
    role)`` keeps working) and ``roles`` all of them; one fills the other (:func:`primary_role`)."""

    annotator_id: str
    display_name: str = ""
    role: str = "annotator"
    roles: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.roles:
            roles = parse_roles(list(self.roles), fallback="")
            object.__setattr__(self, "roles", roles or ("annotator",))
            object.__setattr__(self, "role", primary_role(self.roles))
        else:
            object.__setattr__(self, "roles", parse_roles(self.role))
            object.__setattr__(self, "role", primary_role(self.roles))

    def has_role(self, role: str) -> bool:
        return role in self.roles

    @property
    def is_admin(self) -> bool:
        return "admin" in self.roles

    @property
    def is_expert(self) -> bool:
        """An expert, or an administrator (who may do everything an expert does)."""
        return "expert" in self.roles or self.is_admin


@dataclass(frozen=True)
class Assignment:
    annotator_id: str
    recording_id: str
    mode: str = "standard"
    context_id: str = ""
    position: int = 0
    #: The task this assignment belongs to ("" for an assignment made without one: docs/web/api.md, "Tasks").
    task_id: str = ""
    #: The hand-out that gave the assignment, or that it was linked to later ("" for none: docs/web/api.md,
    #: "Datasets, collections, groups and hand-outs").
    handout_id: str = ""
    #: When the assignment was made, where the store keeps it (the files store); "" otherwise (Firestore, where
    #: the hand-out's ``recipients`` say when it was given).
    assigned_at: str = ""


@dataclass
class SavedResult:
    """What saving a submission produced (see :meth:`Store.save_results`)."""

    session: AnnotationSession
    result: FinishResult | None  # None when the files were written but the register update is pending
    files: dict[str, bytes]  # file name -> contents, as written
    attempt: int


_ATTEMPT_RE = re.compile(r"_attempt-(\d+)$")


def attempt_of(entry: dict[str, Any]) -> int:
    """The attempt number of a completion register row: 1 for ``..._annotator-A01``, n for ``..._attempt-0n``."""
    m = _ATTEMPT_RE.search(str(entry.get("output_basename") or ""))
    return int(m.group(1)) if m else 1


def latest_entry(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """The latest attempt among the register rows of one recording, annotator, mode and context.

    Attempt numbers only grow (each save takes the next free one), so they order the attempts even when
    the times were written on computers in different time zones."""
    return max(entries, key=lambda e: (attempt_of(e), str(e.get("completed_at", ""))))


def index_rows(rows: list[dict[str, Any]], events: list[dict[str, Any]], context_id: str = "") -> list[dict[str, Any]]:
    """The visit index (:meth:`Store.visit_index`) brought up to date with numbered events.

    Each ``recording_opened`` starts a row; ``recording_finished`` or ``closed_without_saving`` of the same
    window ends it (``last_seq``, ``ended_t``, ``outcome``), and ``log_closed`` ends every row still open
    (``outcome`` stays ""). ``context_id`` is the visit's (the reference set of a training visit)."""
    out = [dict(r) for r in rows]
    for e in events:
        kind = e.get("type")
        seq = int(e.get("seq") or 0)
        t = float(e.get("t") or 0.0)
        if kind == "recording_opened":
            mode = str(e.get("mode") or "standard")
            win = e.get("window_no")
            out.append({"window_no": int(win) if isinstance(win, (int, float)) and not isinstance(win, bool) else None,
                        "recording_id": str(e.get("recording") or e.get("recording_id") or ""),
                        "session_id": str(e.get("session_id") or ""), "mode": mode,
                        "context_id": context_id if mode != "standard" else "", "first_seq": seq, "last_seq": None,
                        "opened_t": t, "ended_t": None, "outcome": ""})
        elif kind in ("recording_finished", "closed_without_saving"):
            win = e.get("window_no")
            open_rows = [r for r in out if r["last_seq"] is None and (win is None or r["window_no"] in (win, None))]
            if open_rows:
                r = open_rows[-1]
                r.update(last_seq=seq, ended_t=t, outcome="finished" if kind == "recording_finished"
                         else "closed_without_saving")
        elif kind == "log_closed":
            for r in out:
                if r["last_seq"] is None:
                    r.update(last_seq=seq, ended_t=t)
    return out


def page_of(events: list[dict[str, Any]], from_seq: int, limit: int) -> tuple[list[dict[str, Any]], int | None]:
    """The events with ``seq`` from ``from_seq`` on, at most ``limit`` of them (in order), and the ``seq`` of
    the next event after the page (None when the page reaches the end)."""
    wanted = sorted((e for e in events if int(e.get("seq") or 0) >= from_seq), key=lambda e: int(e.get("seq") or 0))
    page = wanted[: max(1, int(limit))]
    return page, (int(wanted[len(page)]["seq"]) if len(wanted) > len(page) else None)


def item_key(recording_id: str, mode: str, context_id: str) -> str:
    """A short, path-safe key for one recording in one mode and context."""
    return hashlib.sha1(f"{recording_id}|{mode}|{context_id}".encode()).hexdigest()[:20]


def settings_from_overrides(overrides: dict[str, Any] | None) -> Settings:
    """The desktop's settings: the defaults with a study's overrides (as in electrotag_study.json)."""
    return Settings.from_dict(deep_merge(load_default_settings_dict(), copy.deepcopy(overrides or {})))


class StoreError(RuntimeError):
    """The store cannot be used (for example a study that does not exist)."""


class TooManyAssignments(StoreError):
    """One person would hold more assignments than the store can keep for them (a Firestore document's size)."""


class ResultExists(StoreError):
    """A result file is kept already under that name (result files are never replaced)."""


class AccountProblem(ValueError):
    """An account cannot be created or changed as asked; ``code`` is the API's error code."""

    def __init__(self, code: str, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class Store(ABC):
    """Everything the web service reads and writes. Methods raise :class:`StoreError` on failure."""

    demo: bool = False
    #: The store's name in messages and in ``GET /health`` (``files`` or ``firestore``).
    kind: str = ""

    def refresh(self) -> None:  # noqa: B027 - a store without caches has nothing to forget
        """Forget what is cached (the administrator's operations read everything afresh)."""

    @contextmanager
    def memo(self) -> Iterator[None]:
        """Within the block, a store may answer repeated reads (manifests) from memory."""
        yield

    def recover_interrupted(self) -> list[dict[str, Any]]:
        """Finish or undo what an interrupted save left behind (``{"action", "message", ...}`` for each)."""
        return []

    # ------------------------------------------------------------- the study
    @property
    @abstractmethod
    def study_id(self) -> str: ...

    @property
    @abstractmethod
    def name(self) -> str: ...

    @property
    @abstractmethod
    def settings(self) -> Settings: ...

    @property
    @abstractmethod
    def settings_overrides(self) -> dict[str, Any]:
        """The study's own settings (the ``settings`` block of electrotag_study.json)."""

    @property
    @abstractmethod
    def logging_notice(self) -> str:
        """The study's own notice about interaction logging ("" for ElectroTag's)."""

    @abstractmethod
    def update_study(self, *, name: str | None = None, overrides: dict[str, Any] | None = None,
                     logging_notice: str | None = None) -> None:
        """Change the study's name, settings overrides (checked first) or logging notice."""

    @property
    def catalogue(self) -> LabelCatalogue:
        from electrotag.app.annotations.labels import default_catalogue

        cat = getattr(self, "_catalogue", None)
        if cat is None:
            cat = default_catalogue()
            self._catalogue = cat
        return cat

    # -------------------------------------------------------------- manifests
    @abstractmethod
    def manifest(self, scope: str, recording_id: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def manifests(self) -> list[dict[str, Any]]: ...

    @abstractmethod
    def manifests_by_fingerprint(self, sha256: str, size: int) -> list[dict[str, Any]]: ...

    @abstractmethod
    def add_manifest(self, m: dict[str, Any]) -> None: ...

    @abstractmethod
    def remove_manifest(self, scope: str, recording_id: str) -> None: ...

    # --------------------------------------------------------- reference sets
    @abstractmethod
    def reference_sets(self) -> list[ReferenceSet]: ...

    def reference_set(self, set_id: str) -> ReferenceSet:
        from electrotag.training.reference import ReferenceSetError

        for rs in self.reference_sets():
            if rs.set_id == set_id:
                return rs
        raise ReferenceSetError(f"Reference set {set_id!r} was not found in this study")

    @abstractmethod
    def add_reference_set(self, definition: dict[str, Any], files: dict[str, bytes]) -> None:
        """Store a reference set: its ``reference_set.json`` and its other files (paths relative to its folder),
        never its recordings."""

    @abstractmethod
    def reference_set_payload(self, set_id: str) -> tuple[dict[str, Any], dict[str, bytes]]:
        """A stored set's ``reference_set.json`` and other files (raises :class:`StoreError` if there is none)."""

    @abstractmethod
    def put_reference_set(self, definition: dict[str, Any], files: dict[str, bytes]) -> None:
        """Store a reference set in place of the one with its ID: files it no longer has are removed."""

    @abstractmethod
    def delete_reference_set(self, set_id: str) -> None: ...

    # -------------------------------------------------- people and their work
    @abstractmethod
    def user(self, annotator_id: str) -> User | None:
        """The account, if it takes part in the study and is not disabled."""

    @abstractmethod
    def users(self) -> list[dict[str, Any]]:
        """The active accounts (``annotator_id``, ``display_name``, ``role`` (the primary role), ``roles``,
        ``created_at``, ``last_seen``)."""

    @abstractmethod
    def user_records(self) -> list[dict[str, Any]]:
        """Every account, disabled ones too: ``annotator_id``, ``display_name``, ``email``, ``role`` (the
        primary role), ``roles``, ``status``, ``created_at``, ``last_seen``, ``notes``."""

    def user_record(self, annotator_id: str) -> dict[str, Any] | None:
        aid = str(annotator_id or "").strip().upper()
        return next((u for u in self.user_records() if u["annotator_id"] == aid), None)

    @abstractmethod
    def create_account(self, annotator_id: str, *, display_name: str, role: str, email: str,
                       password: str | None, roles: tuple[str, ...] | None = None) -> Credentials:
        """A new account (:class:`AccountProblem` ``user_exists`` if the ID has one) with ``roles`` (or
        ``role`` alone); ``role`` is kept as the primary role."""

    @abstractmethod
    def update_account(self, annotator_id: str, *, display_name: str | None = None, role: str | None = None,
                       status: str | None = None, notes: str | None = None,
                       roles: tuple[str, ...] | None = None) -> None:
        """Change an account; disabling it stops it signing in, at once. ``roles`` replaces every role (the
        primary role follows); ``role`` alone makes it the only one."""

    @abstractmethod
    def reset_password(self, annotator_id: str) -> Credentials: ...

    @abstractmethod
    def remove_account(self, annotator_id: str) -> None:
        """The account leaves the study with its assignments, programme, drafts and guided progress; its
        results and logs stay."""

    # ------------------------------------------------------------ invitations
    def create_invitation(self, annotator_id: str, *, days: float, by: str) -> Invitation:
        """A new private invitation for the account, replacing any earlier one (docs/web/api.md,
        ``user_invite``): ``{"invite_token", "invite_link", "expires_at"}``, with a token the browser
        makes a link from (the files store) or a link to choose a password (Firebase)."""
        raise AccountProblem("not_offered", "This study cannot make invitation links.", 422)

    def revoke_invitation(self, annotator_id: str) -> bool:
        """Withdraw the account's open invitation; False if it had none."""
        raise AccountProblem("not_offered", "This study cannot withdraw invitation links.", 422)

    def invitations(self) -> dict[str, dict[str, Any]]:
        """Each account's latest invitation (``state``: invited, accepted, expired or revoked; ``invited_at``,
        ``expires_at``, ``ended_at``), by annotator ID. Never the token."""
        return {}

    def invitation_for_token(self, token: str) -> dict[str, Any] | None:
        """The invitation a token belongs to, for ``POST /invite/check``; None when it is not known."""
        return None

    def accept_invitation(self, token: str, password: str) -> User:
        """Set the password from a valid invitation and end it (``POST /invite/accept``)."""
        raise AccountProblem("not_offered", "This study does not accept invitation links.", 404)

    @abstractmethod
    def assignments(self, annotator_id: str | None = None) -> list[Assignment]: ...

    @abstractmethod
    def assign(self, annotator_id: str, recording_ids: list[str], *, mode: str = "standard",
               context_id: str = "", task_id: str = "", handout_id: str = "") -> int:
        """Add assignments (those already there are kept as they are, except that one without a task is
        linked to ``task_id`` when one is given, and one without a hand-out to ``handout_id``); returns how
        many were added."""

    # ----------------------------------------------- datasets and hand-outs (datasets.py)
    def assign_many(self, annotator_id: str, items: list[tuple[str, str]], *, handout_id: str = "") -> int:
        """Study assignments (mode ``standard``) of one person, ``items`` being ``(recording_id, task_id)``
        pairs, in one step where the store can (one transaction on Firestore); the same rules as
        :meth:`assign`. Returns how many were added."""
        by_task: dict[str, list[str]] = {}
        for rid, tid in items:
            by_task.setdefault(tid, []).append(rid)
        return sum(self.assign(annotator_id, rids, task_id=tid, handout_id=handout_id)
                   for tid, rids in by_task.items())

    def unlink_handout(self, handout_id: str) -> int:
        """Clear ``handout_id`` from every assignment that carries it (the assignments stay); returns how many."""
        raise StoreError("This store cannot unlink hand-outs")

    def manifest_heads(self, scope: str = "study") -> list[dict[str, Any]]:
        """Light rows of the manifests of ``scope``, without reading their channels and events where the store
        can: ``recording_id``, ``file_name``, ``format``, ``dataset_id`` ("" for the default dataset),
        ``retired``, ``registered_at``, ``sfreq``, ``n_samples``, ``n_channels``, ``size_bytes``."""
        from electrotag.web.manifest import manifest_head

        return [manifest_head(m) for m in self.manifests() if m.get("scope") == scope]

    def opened_index(self) -> list[dict[str, Any]]:
        """Every opening of a recording that the visit index knows: ``{"annotator_id", "recording_id", "mode",
        "opened_at"}`` (``opened_at`` is the visit's start plus the opening's ``opened_t``)."""
        from electrotag.web.manifest import opened_at

        out = []
        for v in self.visit_records(None, 100_000):
            for r in self.visit_index(v["visit_id"]):
                out.append({"annotator_id": v["annotator_id"], "recording_id": r.get("recording_id", ""),
                            "mode": r.get("mode", "standard"),
                            "opened_at": opened_at(v.get("started_at", ""), r.get("opened_t"))})
        return out

    @abstractmethod
    def unassign_item(self, annotator_id: str, recording_id: str, mode: str, context_id: str) -> bool:
        """Remove one assignment; False if there was none."""

    @abstractmethod
    def remove_assignments(self, *, recording_id: str | None = None, context_id: str | None = None,
                           modes: tuple[str, ...] | None = None) -> int:
        """Remove every assignment of a recording and/or of a reference set (in the given modes)."""

    @abstractmethod
    def programme(self, annotator_id: str) -> str | None: ...

    @abstractmethod
    def enrol(self, annotator_id: str, set_id: str | None) -> None: ...

    # ------------------------------------------------------------------ drafts
    @abstractmethod
    def draft(self, annotator_id: str, key: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def draft_keys(self, annotator_id: str) -> set[str]: ...

    @abstractmethod
    def put_draft(self, annotator_id: str, key: str, record: dict[str, Any]) -> None: ...

    @abstractmethod
    def delete_draft(self, annotator_id: str, key: str, closed_session: str | None = None) -> None:
        """Delete a draft. ``closed_session`` names the browser session that discarded its work and closed:
        it is remembered (with the last few before it), so that a draft of it arriving late is refused."""

    @abstractmethod
    def draft_session_closed(self, annotator_id: str, key: str, session_id: str) -> bool:
        """True when ``session_id`` was named as ``closed_session`` when this draft was deleted."""

    # ---------------------------------------------------------- guided state
    @abstractmethod
    def guided_state(self, annotator_id: str, set_id: str, recording_id: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def save_guided_state(self, annotator_id: str, set_id: str, recording_id: str, state: dict[str, Any]) -> None: ...

    @abstractmethod
    def clear_guided_state(self, annotator_id: str, set_id: str, recording_id: str) -> None: ...

    # ----------------------------------------------------------------- results
    @abstractmethod
    def completion_entries(self, annotator_id: str | None = None) -> list[dict[str, str]]:
        """Rows of the completion register (``completion_register.tsv`` columns)."""

    def completed(self, annotator_id: str, mode: str, context_id: str) -> set[str]:
        return {e["recording_id"] for e in self.completion_entries(annotator_id)
                if e.get("mode", "standard") == mode and e.get("context", "") == context_id
                and e.get("status") == "completed"}

    @abstractmethod
    def save_results(self, make_session: Callable[[Any], AnnotationSession], *, elapsed_s: float,
                     started_at: str) -> SavedResult:
        """Run Save and Finish of the session ``make_session(layout)`` makes, keeping the files it writes."""

    @abstractmethod
    def progress(self, rs: ReferenceSet, annotator_id: str) -> Progress:
        """The trainee's stars, scores and times (``Progress.save`` keeps changes)."""

    @abstractmethod
    def competency(self, rs: ReferenceSet, annotator_id: str) -> dict[str, Any]:
        """Produce and keep the competency report (as ``competency_report``) and return it."""

    @abstractmethod
    def report_result(self, set_id: str, annotator_id: str) -> dict[str, str]:
        """The result of the trainee's competency report, ``{"status", "status_text"}``, or {} without one."""

    def report_status(self, set_id: str, annotator_id: str) -> str:
        """The status of the trainee's competency report (``met``, ``not_met``, ``not_determined``), or ""
        when there is none yet (the competency gate of real study work reads it)."""
        return str(self.report_result(set_id, annotator_id).get("status") or "")

    @abstractmethod
    def saved_files(self, annotator_id: str, recording_id: str, mode: str, context_id: str,
                    attempt: int | None = None) -> dict[str, bytes]:
        """The files of the latest saved attempt, or of attempt ``attempt`` (file name -> contents), or {} if
        there is no such attempt."""

    def saved_document(self, annotator_id: str, recording_id: str, mode: str, context_id: str,
                       attempt: int | None = None) -> bytes | None:
        """The ``_annotations.json`` of the latest saved attempt (or of ``attempt``), or None."""
        files = self.saved_files(annotator_id, recording_id, mode, context_id, attempt)
        return next((b for n, b in sorted(files.items()) if n.endswith("_annotations.json")), None)

    # ------------------------------------------------------- derived versions
    @abstractmethod
    def save_derived(self, kind: str, make_session: Callable[[Any], AnnotationSession], *, elapsed_s: float,
                     started_at: str) -> SavedResult:
        """Save a derived version (one of :data:`DERIVED_KINDS`): Save and Finish of ``make_session(layout)``
        with the five files written, read back and verified, into the derived tree of ``kind``
        (``Annotated_Events/derived/<kind>/``, a layout of its own with its own completion register), so that
        it is never anyone's attempt, completion or time. ``attempt`` counts the versions of that kind of the
        session's annotator and recording. Repeats are always allowed."""

    @abstractmethod
    def derived_entries(self, kind: str, annotator_id: str | None = None) -> list[dict[str, str]]:
        """The completion register rows of the derived tree of ``kind`` (``output_dir`` is relative to it)."""

    @abstractmethod
    def derived_files(self, kind: str, annotator_id: str, recording_id: str,
                      attempt: int | None = None) -> dict[str, bytes]:
        """The files of a derived version (the latest, or ``attempt``), or {} if there is none."""

    @abstractmethod
    def results_tree(self, dest: Path, *, logs: bool = False, annotator_ids: set[str] | None = None,
                     modes: set[str] | None = None) -> Path:
        """A results folder laid out as the desktop's (``Annotated_Events``) for the analyses to read.

        The files store answers its own folder (``dest`` is not used); the Firestore store writes the
        saved files (and, with ``logs``, the interaction logs) below ``dest``. Only reading is allowed."""

    @abstractmethod
    def put_result_file(self, rel_path: str, data: bytes) -> None:
        """Keep a result file (for example a quiz result) at ``rel_path`` below the results folder."""

    # ------------------------------------------------------------------- quiz
    @abstractmethod
    def quiz_state(self, annotator_id: str, set_id: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def update_quiz_state(self, annotator_id: str, set_id: str,
                          change: Callable[[dict[str, Any] | None], dict[str, Any] | None]) -> dict[str, Any] | None:
        """Read, change and write an annotator's quiz state in one step (``change`` returns the new state,
        or None to leave it as it was); returns the state kept."""

    # ------------------------------------------- the annotator's own record (games)
    @abstractmethod
    def annotator_record(self, annotator_id: str) -> dict[str, Any]:
        """What an annotator chose or reached outside their results (a personal goal, being hidden from the
        leaderboard, how much of each saved recording they viewed): {} when nothing is kept yet."""

    @abstractmethod
    def annotator_records(self) -> dict[str, dict[str, Any]]:
        """Every annotator's record, by annotator ID (for the leaderboard)."""

    @abstractmethod
    def update_annotator_record(self, annotator_id: str,
                                change: Callable[[dict[str, Any]], dict[str, Any] | None]) -> dict[str, Any]:
        """Read, change and write an annotator's record in one step (``change`` returns the new record, or
        None to leave it as it was); returns the record kept."""

    @abstractmethod
    def study_secret(self, name: str) -> str:
        """A random secret of the study (64 hexadecimal characters), made the first time it is asked for and
        kept by the store, never sent to a browser (the key of the leaderboard's pseudonyms)."""

    # ------------------------------------------- problem reports and reviews
    @abstractmethod
    def records(self, kind: str, annotator_id: str | None = None) -> list[dict[str, Any]]:
        """The records of one of :data:`RECORD_KINDS` (every annotator's, or one annotator's), in no order."""

    @abstractmethod
    def update_record(self, kind: str, record_id: str, annotator_id: str,
                      change: Callable[[dict[str, Any] | None], dict[str, Any] | None]) -> dict[str, Any] | None:
        """Read, change and write one record in one step: ``change`` gets the record kept (None when there is
        none) and returns the new one, or None to leave it as it was; returns the record kept. Records are
        never deleted (docs/web/api.md, "Problem reports" and "Reviews")."""

    # ------------------------------------------------------------------ audit
    @abstractmethod
    def audit_append(self, entry: dict[str, Any]) -> None:
        """Add an entry ``{"at", "by", "op", "summary", "details"}`` to the audit log."""

    @abstractmethod
    def audit_page(self, before: str | None, limit: int) -> tuple[list[dict[str, Any]], str | None]:
        """Entries newest first, from just after the cursor ``before``; and the cursor of the next page."""

    # ----------------------------------------------------------------- visits
    @abstractmethod
    def visit_open(self, visit_id: str, annotator_id: str, mode: str, context_id: str, header: dict[str, Any],
                   started: Any) -> None:
        """Start a visit's interaction log with its header line (``started``: local datetime, for the name)."""

    @abstractmethod
    def visit(self, visit_id: str) -> dict[str, Any] | None:
        """``{"annotator_id", "closed", "last_t", "opened_at", "seq"}`` or None."""

    @abstractmethod
    def visit_append(self, visit_id: str, events: list[dict[str, Any]]) -> int:
        """Append events (without ``seq``): numbers them in order and returns how many were written."""

    @abstractmethod
    def visit_close(self, visit_id: str, event: dict[str, Any]) -> None:
        """Append the closing event (without ``seq``) and mark the visit closed."""

    @abstractmethod
    def visit_records(self, annotator_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        """Visits, newest first: ``visit_id``, ``annotator_id``, ``mode``, ``context_id``, ``started_at``,
        ``closed_at`` (or None) and ``n_events``."""

    @abstractmethod
    def visit_log(self, visit_id: str, *, from_seq: int = 0, limit: int = 4000) -> dict[str, Any]:
        """One page of a visit's interaction log: ``{"header": dict, "events": [...], "next_seq": int | None}``,
        the events with ``seq`` from ``from_seq`` on, at most ``limit`` (in order), and the ``seq`` to ask for
        next (None at the end). Raises :class:`StoreError` for an unknown visit."""

    @abstractmethod
    def visit_index(self, visit_id: str) -> list[dict[str, Any]]:
        """The recordings a visit opened, in order (:func:`index_rows`): ``window_no``, ``recording_id``,
        ``session_id``, ``mode``, ``context_id``, ``first_seq``, ``last_seq`` (None while open), ``opened_t``,
        ``ended_t``, ``outcome`` (``finished``, ``closed_without_saving`` or ""). Kept as the events arrive;
        a log written before the index existed is read through instead. [] for an unknown visit."""


def generated_password() -> str:
    """A temporary password that is easy to read out and type: three groups of four characters."""
    import secrets

    alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O, 1/l/I
    return "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(3))


__all__ = ["BY_COMMAND", "DERIVED_DIR", "DERIVED_KINDS", "KNOWN_ROLES", "MODES", "PRIVILEGED_ROLES", "RECORD_ID_RE",
           "RECORD_KINDS", "RESERVED_IDS", "RESERVED_ROLES", "ROLES", "ROLE_ORDER", "STATUSES", "AccountProblem",
           "Assignment", "Credentials", "Invitation", "ResultExists", "SavedResult", "Store", "StoreError",
           "TooManyAssignments", "User",
           "attempt_of", "generated_password", "index_rows", "item_key", "latest_entry", "page_of", "parse_roles",
           "primary_role", "roles_text", "settings_from_overrides"]
