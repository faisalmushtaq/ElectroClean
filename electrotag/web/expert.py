"""The expert area's operations (``POST /expert/{op}``, ``et_expert``; docs/web/api.md, "Experts").

Experts open anyone's saved work to correct it, replay sessions, adjudicate conflicts and supply
training material; administrators may do everything an expert does. :meth:`Expert.run` checks that
the caller is an expert (or an administrator) and runs one operation from :data:`EXPERT_OPS`; the few
operations of :data:`OPEN_OPS` (an annotator's own corrected version, the experts' sessions a trainee may
watch) may be asked by anyone signed in, and check themselves who may see what.

**The registry.** Each part of the expert work lives in a module of its own that registers its
operations with :func:`expert_op` when it is imported; :data:`EXPERT_MODULES` lists those modules
(one line each), and they are imported the first time an expert operation is asked for, so that a
Firebase function answering an annotator never loads them. An operation is a function
``(service, user, body) -> dict``.

**Reads and saves.** An operation whose name ends in ``_get`` or ``_list`` only reads (:func:`is_read`):
the browser may ask it again after a failure. Every other operation saves, and is never repeated by
the browser; each of those is idempotent where a second press could reach the study (an ID made by
the browser, or the same state from the same request), and appends to the study's audit log.

**Feedback.** ``GET /me/feedback`` gathers what the study shows an annotator about their own work from
:data:`FEEDBACK_PARTS`: ``corrections`` and ``adjudications``, each ``(service, user) -> list`` and
registered by its module with :func:`feedback_part`.

**Replay consent.** An expert decides whether trainees may watch replays of the expert's own sessions
for teaching (``replay_consent_get`` and ``replay_consent_set``); the choice is kept with the
person's record and every change is audited.
"""

from __future__ import annotations

import importlib
import re
import threading
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from electrotag.app.common import now_local_iso
from electrotag.web import audit
from electrotag.web.errors import ApiError
from electrotag.web.store import AccountProblem, User

if TYPE_CHECKING:
    from electrotag.web.service import StudyService

#: An operation of the expert area: ``(service, user, body) -> answer``.
ExpertOp = Callable[["StudyService", User, dict[str, Any]], dict[str, Any]]
#: Operation name -> function, filled by :func:`expert_op` as the modules of EXPERT_MODULES are imported.
EXPERT_OPS: dict[str, ExpertOp] = {}
#: The modules that register expert operations (one line per part of the expert work).
EXPERT_MODULES: tuple[str, ...] = (
    "electrotag.web.expert",  # replay consent (below)
    "electrotag.web.corrections",  # corrections of saved work, and the annotator's view of them
    "electrotag.web.replay",  # replays of sessions from the interaction log
    "electrotag.web.training_path",  # the snippets of the training path (snippets_list, snippet_add, snippet_remove)
    "electrotag.web.adjudication",  # the adjudication queue, its decisions and what annotators see of them
    "electrotag.web.library",  # the library of contradictory annotations
)
#: Operations that people without the expert role may ask for too; each checks itself who may see what (an
#: annotator's own corrected version, an expert's session shown to trainees with the expert's consent).
OPEN_OPS: set[str] = set()
#: What ``GET /me/feedback`` shows, by part: ``(service, user) -> [item]`` (filled by the modules above).
FEEDBACK_PARTS: dict[str, Callable[["StudyService", User], list[dict[str, Any]]]] = {}
OP_RE = re.compile(r"^[a-z][a-z_]{0,40}$")
READ_RE = re.compile(r"_(list|get)$")
_loaded = threading.Event()
_loading = threading.Lock()


def is_read(op: str) -> bool:
    """True for an operation that only reads (its name ends in ``_get`` or ``_list``)."""
    return bool(READ_RE.search(str(op)))


def expert_op(name: str, *, open_to_all: bool = False) -> Callable[[ExpertOp], ExpertOp]:
    """Register a function as the expert operation ``name`` (one name, one function); with ``open_to_all``
    anyone signed in to the study may ask for it (:data:`OPEN_OPS`), and the operation checks the rest."""
    if not OP_RE.match(name):
        raise ValueError(f"Unsuitable name for an expert operation: {name!r}")

    def register(fn: ExpertOp) -> ExpertOp:
        if EXPERT_OPS.get(name, fn) is not fn:
            raise ValueError(f"The expert operation {name} is registered twice")
        EXPERT_OPS[name] = fn
        if open_to_all:
            OPEN_OPS.add(name)
        return fn

    return register


def feedback_part(name: str) -> Callable[[Callable[..., list[dict[str, Any]]]], Callable[..., list[dict[str, Any]]]]:
    """Register what ``GET /me/feedback`` lists under ``name`` (``corrections`` or ``adjudications``)."""

    def register(fn: Callable[..., list[dict[str, Any]]]) -> Callable[..., list[dict[str, Any]]]:
        FEEDBACK_PARTS[name] = fn
        return fn

    return register


def load_operations() -> dict[str, ExpertOp]:
    """Import the modules of EXPERT_MODULES once, so that their operations are registered."""
    if not _loaded.is_set():
        with _loading:
            if not _loaded.is_set():
                for name in EXPERT_MODULES:
                    importlib.import_module(name)
                _loaded.set()
    return EXPERT_OPS


class Expert:
    """The expert area of one study (see the module docstring)."""

    def __init__(self, service: StudyService) -> None:
        self.service = service

    @property
    def store(self) -> Any:
        return self.service.store

    def run(self, op: Any, user: User, body: dict[str, Any]) -> dict[str, Any]:
        ops = load_operations()
        if not user.is_expert and not (isinstance(op, str) and op in OPEN_OPS):
            raise ApiError(403, "forbidden", "Only the study's experts and administrators can use the expert area")
        if not isinstance(op, str) or op not in ops:
            raise ApiError(404, "not_found", f"This study does not offer the expert operation {op!r}")
        if not isinstance(body, dict):
            raise ApiError(400, "bad_request", "The request must be a JSON object")
        self.store.refresh()
        with self.store.memo():
            try:
                return ops[op](self.service, user, body)
            except AccountProblem as exc:
                raise ApiError(exc.status, exc.code, exc.message) from exc

    def my_feedback(self, user: User) -> dict[str, Any]:
        """``GET /me/feedback``: each part shown when the study's settings show it (review block)."""
        load_operations()
        review = self.service.settings.review
        shown = {"corrections": bool(review.show_corrections_to_annotators),
                 "adjudications": bool(review.show_outcomes_to_annotators)}
        out: dict[str, Any] = {}
        for part, on in shown.items():
            fn = FEEDBACK_PARTS.get(part)
            out[part] = {"shown": on, "items": list(fn(self.service, user)) if (on and fn is not None) else []}
        return out


# ------------------------------------------------------------------ replay consent
def consent_of(service: StudyService, annotator_id: str) -> dict[str, Any]:
    """Whether the person agrees to trainees watching replays of their sessions, and since when."""
    rec = service.store.annotator_record(annotator_id).get("replay_consent")
    rec = rec if isinstance(rec, dict) else {}
    return {"teaching": rec.get("teaching") is True, "changed_at": rec.get("changed_at") or None}


def _consent_answer(service: StudyService, user: User) -> dict[str, Any]:
    r = service.settings.replay
    return {"consent": consent_of(service, user.annotator_id),
            "replays": {"enabled": bool(r.enabled), "trainees_watch_experts": bool(r.trainees_watch_experts)}}


@expert_op("replay_consent_get")
def replay_consent_get(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """The caller's own consent to their sessions being shown to trainees."""
    return _consent_answer(service, user)


@expert_op("replay_consent_set")
def replay_consent_set(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """``{"teaching": bool}``: the caller's own consent, changed (and audited); the same value again changes
    nothing and writes nothing."""
    teaching = body.get("teaching")
    if not isinstance(teaching, bool):
        raise ApiError(400, "bad_request", "teaching must be true (trainees may watch replays of your sessions) or "
                       "false")
    now = now_local_iso()
    changed = {"value": False}

    def change(old: dict[str, Any]) -> dict[str, Any] | None:
        before = old.get("replay_consent") if isinstance(old.get("replay_consent"), dict) else {}
        if (before.get("teaching") is True) == teaching and before:
            return None
        changed["value"] = True
        return {**old, "replay_consent": {"teaching": teaching, "changed_at": now}}

    service.store.update_annotator_record(user.annotator_id, change)
    if changed["value"]:
        audit.record(service.store, user.annotator_id, "replay_consent_set",
                     f"{user.annotator_id} {'agreed' if teaching else 'no longer agrees'} to trainees watching "
                     "replays of their sessions", {"annotator_id": user.annotator_id, "teaching": teaching})
    return {**_consent_answer(service, user), "changed": changed["value"]}


__all__ = ["EXPERT_MODULES", "EXPERT_OPS", "FEEDBACK_PARTS", "OPEN_OPS", "Expert", "consent_of", "expert_op",
           "feedback_part", "is_read", "load_operations"]
