"""The operations of docs/web/api.md, independent of how they are called and where records are kept.

:class:`StudyService` is called by the ElectroTag server (app.py, over HTTP) and by the Firebase
functions (firebase/functions/main.py, as callables) with the same JSON, and keeps its records in a
:class:`~electrotag.web.store.Store` (a study folder, or Firestore). The training programme is in
:mod:`electrotag.web.coach` and the interaction logs in :mod:`electrotag.web.visits`.

Importing this module is light (no numpy, pandas, SciPy or MNE-Python), so a Firebase function
answering a guided check starts quickly; saving and practice scoring import what they need.
"""

from __future__ import annotations

import json
import logging
import math
import random
import re
from dataclasses import dataclass
from typing import Any

from electrotag import __version__
from electrotag.app.annotations.model import (
    AnnotationError,
    ArtifactAnnotation,
    RecordingInfo,
    check_note,
    is_confidence,
    normalise_channels,
    validate_annotation,
)
from electrotag.app.common import now_local_iso
from electrotag.app.session.selection import seeded_order
from electrotag.config.settings import FilterSettings, SettingsError
from electrotag.training.reference import ReferenceSet, ReferenceSetError
from electrotag.web.errors import ApiError
from electrotag.web.manifest import SCOPE_STUDY, fingerprint_of, public_manifest, set_scope
from electrotag.web.store import MODES, Store, User, attempt_of, item_key, latest_entry

ANN_ID_RE = re.compile(r"^[0-9A-Za-z_-]{1,64}$")
STAMP_RE = re.compile(r"^[0-9T:.+\-Z ]{0,40}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
SESSION_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_ANNOTATIONS = 20000
#: The most time worked on one recording that is recorded (a week): the browser's clock pauses when the
#: annotator is away, so more is a fault or a forged figure, and it would distort the study's totals.
MAX_ELAPSED_S = 7 * 24 * 3600.0
#: At most this many [start_s, end_s] stretches of a draft's ``viewed`` (the browser keeps fewer).
MAX_VIEWED = 5000
#: What annotators are told when the study records how they use ElectroTag (as on the desktop).
LOGGING_NOTICE = ("This study records how you use ElectroTag (times, clicks, keys and what is on screen) for "
                  "research. The study team can replay a session from this record, step by step, and an expert's "
                  "sessions may be shown to trainees when the expert agrees. It never records what you type, such as "
                  "notes or passwords. Ask the study team if you have questions.")

__all__ = ["ApiError", "StudyService", "WorkItem", "annotation_dict", "parse_annotations"]
log = logging.getLogger("electrotag.web")


# ------------------------------------------------------------------ annotations
def _int(value: Any, what: str) -> int:
    if (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
            or int(value) != value):
        raise ApiError(422, "invalid_annotation", f"{what} must be a whole number of samples")
    return int(value)


def _stamp(value: Any) -> str:
    text = str(value or "")
    return text if STAMP_RE.match(text) else ""


def _number(value: Any, what: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ApiError(422, "invalid_session", f"{what} must be a number")
    if minimum is not None and value < minimum:
        raise ApiError(422, "invalid_session", f"{what} must be at least {minimum:g}")
    return float(value)


def confidence_and_note(a: dict[str, Any], where: str,
                        code: str = "invalid_annotation") -> tuple[int | None, str]:
    """An annotation's ``confidence`` (a whole number from 1 to 5, or none: missing or null) and ``note``
    (text of at most 200 characters on one line, or none), checked."""
    confidence = a.get("confidence")
    if confidence is not None and not is_confidence(confidence):
        raise ApiError(422, code, f"{where}: confidence must be a whole number from 1 to 5, or none")
    try:
        note = check_note(a.get("note"))
    except AnnotationError as exc:
        raise ApiError(422, code, f"{where}: {exc}") from exc
    return confidence, note


def parse_annotations(items: Any, info: RecordingInfo, catalogue: Any, min_samples: int) -> list[ArtifactAnnotation]:
    """The browser's annotations as ElectroTag annotations, each checked as the desktop checks them."""
    if not isinstance(items, list):
        raise ApiError(422, "invalid_annotation", "annotations must be a list")
    if len(items) > MAX_ANNOTATIONS:
        raise ApiError(422, "invalid_annotation", f"At most {MAX_ANNOTATIONS} annotations can be saved")
    out: list[ArtifactAnnotation] = []
    seen: set[str] = set()
    now = now_local_iso()
    for i, a in enumerate(items, start=1):
        if not isinstance(a, dict):
            raise ApiError(422, "invalid_annotation", f"Annotation {i} is not an object")
        aid = a.get("annotation_id")
        if not isinstance(aid, str) or not ANN_ID_RE.match(aid):
            raise ApiError(422, "invalid_annotation", f"Annotation {i} has no valid annotation_id")
        if aid in seen:
            raise ApiError(422, "invalid_annotation", f"Annotation {aid} appears twice")
        seen.add(aid)
        label = a.get("label")
        if not isinstance(label, str):
            raise ApiError(422, "invalid_annotation", f"Annotation {i} has no label")
        onset = _int(a.get("onset_sample"), f"Annotation {i}: onset_sample")
        dur = _int(a.get("duration_samples"), f"Annotation {i}: duration_samples")
        channels = a.get("channels", [])
        if not isinstance(channels, list) or not all(isinstance(c, str) for c in channels):
            raise ApiError(422, "invalid_annotation", f"Annotation {i}: channels must be a list of channel names")
        if len(set(channels)) != len(channels):
            raise ApiError(422, "invalid_annotation", f"Annotation {i} ({label}) lists a channel more than once")
        confidence, note = confidence_and_note(a, f"Annotation {i} ({label})")
        try:
            ann = ArtifactAnnotation(
                annotation_id=aid, label=label, onset_sample=onset, duration_samples=dur,
                channels=normalise_channels(channels, info.ch_names),
                created_at=_stamp(a.get("created_at")) or now, modified_at=_stamp(a.get("modified_at")) or now,
                confidence=confidence, note=note,
            )
            validate_annotation(ann, info, catalogue, min_samples)
        except AnnotationError as exc:
            raise ApiError(422, "invalid_annotation", f"Annotation {i} ({label} at sample {onset}): {exc}") from exc
        out.append(ann)
    return out


def annotation_dict(a: ArtifactAnnotation) -> dict[str, Any]:
    return {"annotation_id": a.annotation_id, "label": a.label, "onset_sample": a.onset_sample,
            "duration_samples": a.duration_samples, "channels": list(a.channels),
            "created_at": a.created_at, "modified_at": a.modified_at, "confidence": a.confidence,
            "note": a.note}


def _float_or_none(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _int_or_none(value: Any) -> int | None:
    out = _float_or_none(value)
    return int(out) if out is not None else None


def parse_viewed(value: Any) -> list[list[float]]:
    """A draft's ``viewed``: the stretches of the recording on screen so far, as [start_s, end_s] pairs."""
    if value is None:
        return []
    what = "draft.viewed must be a list of [start_s, end_s] pairs of seconds"
    if not isinstance(value, list) or len(value) > MAX_VIEWED:
        raise ApiError(422, "invalid_draft", what)
    out: list[list[float]] = []
    for pair in value:
        if (not isinstance(pair, list) or len(pair) != 2
                or any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in pair)
                or not 0 <= pair[0] <= pair[1]):
            raise ApiError(422, "invalid_draft", what)
        out.append([float(pair[0]), float(pair[1])])
    return out


def viewed_seconds(viewed: list[list[float]]) -> float:
    """Seconds of the recording covered by ``viewed`` (overlaps counted once)."""
    total, end = 0.0, -math.inf
    for a, b in sorted(viewed):
        if b <= end:
            continue
        total += b - max(a, end)
        end = b
    return total


def clean_json(v: Any) -> Any:
    """JSON-safe: NaN and infinity become null, numpy numbers Python numbers."""
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, dict):
        return {str(k): clean_json(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean_json(x) for x in v]
    if isinstance(v, (str, int, bool)) or v is None:
        return v
    try:
        return clean_json(v.item())
    except AttributeError:
        return str(v)


# ------------------------------------------------------------------- work items
@dataclass
class WorkItem:
    """A recording an annotator may open now, in one mode and context."""

    recording_id: str
    mode: str
    context_id: str
    manifest: dict[str, Any]
    status: str  # todo, in_progress, done, unusable (reported as one that cannot be annotated), locked (training first)
    position: int = 0
    repeat: bool = False  # a practice recording that may be annotated again
    source: str = "assignment"  # or "programme"
    result: dict[str, str] | None = None  # the completion register's row of the latest attempt, when done
    saved: dict[str, Any] | None = None  # the history's figures of every saved attempt (games.saved_summary)
    revising: bool = False  # done, with a revision under way (its draft is kept)
    task_id: str = ""  # the task the assignment belongs to (electrotag/web/tasks.py), "" for none
    handout_id: str = ""  # the hand-out that gave the assignment or was linked to it (datasets.py), "" for none

    @property
    def key(self) -> str:
        return item_key(self.recording_id, self.mode, self.context_id)

    def to_dict(self) -> dict[str, Any]:
        timing = self.manifest["timing"]
        _sha, size = fingerprint_of(self.manifest)
        done = self.result if self.status == "done" and self.result else None
        return {
            "recording_id": self.recording_id, "file_name": self.manifest["file_name"],
            "format": self.manifest["format"], "mode": self.mode, "context_id": self.context_id,
            "status": self.status, "duration_s": float(timing["n_samples"]) / float(timing["sfreq"]),
            "locked": "training_required" if self.status == "locked" else None,
            "n_channels": len(self.manifest["ch_names"]), "size_bytes": size, "repeat": self.repeat,
            # what the completion register says of a finished recording (null otherwise)
            "elapsed_s": _float_or_none(done.get("elapsed_s")) if done else None,
            "n_annotations": _int_or_none(done.get("n_annotations")) if done else None,
            "completed_at": (done.get("completed_at") or None) if done else None,
        }


class StudyService:
    """The web service of one study (see the module docstring)."""

    def __init__(self, store: Store) -> None:
        self.store = store
        from electrotag.web.admin import Admin
        from electrotag.web.analyses import Analyses
        from electrotag.web.coach import Coach
        from electrotag.web.quiz import Quizzes
        from electrotag.web.visits import Visits

        self.coach = Coach(self)
        from electrotag.web.training_path import TrainingPath

        self.training_path = TrainingPath(self)
        self.visits = Visits(self)
        self.administration = Admin(self)
        self.analyses = Analyses(self)
        self.quizzes = Quizzes(self)
        from electrotag.web.games import Games

        self.games = Games(self)
        from electrotag.web.feedback import Feedback

        self.feedback = Feedback(self)
        from electrotag.web.expert import Expert

        self.expert = Expert(self)
        from electrotag.web.tasks import Tasks

        self.tasks = Tasks(self)
        # datasets, collections, groups and hand-outs, and the tracking of them (docs/web/api.md, "Datasets, ...")
        from electrotag.web.datasets import Datasets
        from electrotag.web.tracking import Tracking

        self.datasets = Datasets(self)
        self.tracking = Tracking(self)

    # ----------------------------------------------------------------- basics
    @property
    def settings(self) -> Any:
        return self.store.settings

    def reference_set(self, set_id: str) -> ReferenceSet:
        try:
            return self.store.reference_set(set_id)
        except ReferenceSetError as exc:
            raise ApiError(404, "no_reference_set", str(exc)) from exc

    def scope_for(self, mode: str, context_id: str) -> str:
        """Where a recording's manifest is: the study's register, or a self-contained training set."""
        if mode == "standard" or not context_id:
            return SCOPE_STUDY
        try:
            rs = self.store.reference_set(context_id)
        except ReferenceSetError:
            return SCOPE_STUDY
        return set_scope(rs.set_id) if rs.self_contained else SCOPE_STUDY

    def health(self) -> dict[str, Any]:
        return {"ok": True, "version": __version__, "study": self.store.name, "demo": bool(self.store.demo)}

    def study_info(self) -> dict[str, Any]:
        s = self.settings
        f = s.filters
        cat = self.store.catalogue
        return {
            "study_id": self.store.study_id,
            "name": self.store.name,
            "filters": {"highpass_enabled": f.highpass_enabled, "highpass_hz": f.highpass_hz,
                        "notch_enabled": f.notch_enabled, "notch_hz": f.notch_hz,
                        "notch_harmonics": f.notch_harmonics, "locked": f.locked},
            "display": {"duration_s": s.display.duration_s, "n_channels": s.display.n_channels,
                        "scalings": dict(s.display.scalings), "channel_colours": s.display.channel_colours},
            "annotation": {"min_duration_samples": s.min_duration_samples,
                           "quick_labels": [q for q in s.quick_labels if cat.is_permitted(q)],
                           "break_reminder_minutes": s.break_reminder_minutes,
                           "idle_pause_minutes": s.idle_pause_minutes, "coverage_check": s.coverage_check,
                           "allow_revisions": s.allow_revisions, "allow_reviews": s.allow_reviews,
                           "show_reviews_to_annotators": s.show_reviews_to_annotators, "confidence": s.confidence},
            "gamification": {"enabled": s.gamification_enabled,
                             "leaderboard": s.gamification_enabled and s.gamification_leaderboard},
            "review": {"show_corrections_to_annotators": s.review.show_corrections_to_annotators,
                       "show_outcomes_to_annotators": s.review.show_outcomes_to_annotators},
            "training": {"skippable": list(s.training.skippable), "gate": s.training.gate},
            "replay": {"enabled": s.replay.enabled, "trainees_watch_experts": s.replay.trainees_watch_experts},
            "logging": self.logging_info(),
            "logging_notice": (self.store.logging_notice or LOGGING_NOTICE) if s.logging_interactions else "",
        }

    def logging_info(self) -> dict[str, Any]:
        s = self.settings
        return {"interactions": s.logging_interactions, "pointer_hz": s.logging_pointer_hz,
                "idle_after_s": s.logging_idle_after_s}

    def catalogue_info(self) -> dict[str, Any]:
        return {"labels": [
            {"label": lab.label, "value": lab.value, "short_code": lab.short_code, "colour": lab.colour,
             "section": lab.section, "is_group": lab.is_group, "parent": lab.parent, "description": lab.description}
            for lab in self.store.catalogue.labels
        ]}

    # --------------------------------------------------------------------- me
    def me(self, user: User, body: dict[str, Any] | None = None) -> dict[str, Any]:
        prog = None
        set_id = self.store.programme(user.annotator_id)
        if set_id:
            try:
                rs = self.store.reference_set(set_id)
                prog = {"set_id": rs.set_id, "name": rs.name or rs.set_id,
                        "complete": self.coach.programme_complete(user, rs)}
            except ReferenceSetError:
                prog = None
        return {"annotator_id": user.annotator_id, "display_name": user.display_name, "role": user.role,
                "roles": list(user.roles), "study": self.study_info(), "catalogue": self.catalogue_info(),
                "programme": prog, "training_gate": self.training_path.gate(user),
                "quizzes": self.quizzes.available(user)}

    # ---------------------------------------------------------- what to do
    def work_items(self, user: User) -> list[WorkItem]:
        aid = user.annotator_id
        drafts = self.store.draft_keys(aid)
        unusable = self.feedback.unusable_keys(aid)
        entries = self.store.completion_entries(aid)
        done: dict[tuple[str, str], set[str]] = {}
        saved: dict[tuple[str, str, str], list[dict[str, str]]] = {}
        for e in entries:
            if e.get("status") == "completed":
                mode_ctx = (e.get("mode", "standard"), e.get("context", ""))
                done.setdefault(mode_ctx, set()).add(e["recording_id"])
                saved.setdefault((e["recording_id"], *mode_ctx), []).append(e)
        items: list[WorkItem] = []
        seen: set[tuple[str, str, str]] = set()

        def add(rid: str, mode: str, ctx: str, position: int, source: str, repeat: bool = False,
                task_id: str = "", handout_id: str = "") -> None:
            ctx = ctx if mode != "standard" else ""
            key = (rid, mode, ctx)
            if key in seen:
                return
            m = self.store.manifest(self.scope_for(mode, ctx), rid)
            if m is None:
                return  # not registered (yet): nothing the browser could match
            seen.add(key)
            if rid in done.get((mode, ctx), set()) and not repeat:
                status = "done"
            elif item_key(rid, mode, ctx) in unusable:
                status = "unusable"
            elif item_key(rid, mode, ctx) in drafts or (
                    mode == "guided" and self.store.guided_state(aid, ctx, rid) is not None):
                status = "in_progress"
            else:
                status = "todo"
            # the latest attempt by its number (a revision is always the latest), whatever the clocks said
            item = WorkItem(rid, mode, ctx, m, status, position, repeat, source,
                            latest_entry(saved[key]) if key in saved else None, task_id=task_id,
                            handout_id=handout_id)
            if key in saved:
                from electrotag.web.games import saved_summary

                item.saved = saved_summary(saved[key])
                item.revising = status == "done" and item_key(rid, mode, ctx) in drafts
            items.append(item)

        set_id = self.store.programme(aid)
        if set_id:
            for rid, mode, repeat in self.coach.programme_recordings(user, set_id):
                add(rid, mode, set_id, 0, "programme", repeat)
        for a in self.store.assignments(aid):
            add(a.recording_id, a.mode, a.context_id, a.position, "assignment", task_id=a.task_id,
                handout_id=a.handout_id)
        # Real study work waits for the competency assessment (electrotag/web/training_path.py): a study recording
        # not yet saved is "locked" while the gate is closed, so it is never the next one and cannot be opened.
        gated = [i for i in items if self.training_path.gated(i) and i.status in ("todo", "in_progress")]
        if gated and not self.training_path.gate(user)["open"]:
            for i in gated:
                i.status = "locked"
        return items

    def _next(self, user: User, items: list[WorkItem]) -> WorkItem | None:
        set_id = self.store.programme(user.annotator_id)
        if set_id:
            nxt = self.coach.next_item(user, set_id, items)
            if nxt is not None:
                return nxt
        open_items = [i for i in items if i.status not in ("done", "unusable", "locked") and i.source == "assignment"]
        if not open_items:
            return None
        started = [i for i in open_items if i.status == "in_progress"]
        if started:
            return started[0]
        s = self.settings
        if s.selection_strategy == "manual":
            return min(open_items, key=lambda i: i.position)
        if s.selection_strategy == "seeded":
            first = seeded_order([i.recording_id for i in open_items], int(s.selection_seed or 0),
                                 user.annotator_id)[0]
            return next(i for i in open_items if i.recording_id == first)
        # random: a random choice that stays the same until something more is completed
        n_done = sum(1 for i in items if i.status == "done")
        rng = random.Random(f"{self.store.study_id}:{user.annotator_id}:{n_done}")
        return rng.choice(sorted(open_items, key=lambda i: (i.recording_id, i.mode, i.context_id)))

    def assignments(self, user: User, body: dict[str, Any] | None = None) -> dict[str, Any]:
        items = self.work_items(user)
        nxt = self._next(user, items)
        problems = self.feedback.latest_problems(user.annotator_id)
        tasks = self.tasks.by_id() if any(i.task_id for i in items) else {}
        out = []
        for i in items:
            d = i.to_dict()
            d["draft"] = self._draft_summary(user, i) if i.status == "in_progress" or i.revising else None
            # what only the history needs: the latest version's number, the first save and the time of all versions
            d["saved"] = ({k: i.saved[k] for k in ("version", "first_saved_at", "total_elapsed_s")}
                          if i.saved is not None else None)
            d["revising"] = i.revising
            p = problems.get(i.key)
            d["problem"] = self.feedback.problem_out(p, mine=True) if p is not None else None
            d["task"] = self.tasks.item_task(i, tasks)  # {task_id, window} of a task (docs/web/api.md), or null
            out.append(d)
        # the hand-outs of the study team (datasets.py): titles and due dates only, never a dataset's details
        per_item, due = self.datasets.annotator_view(user, items)
        for i, d in zip(items, out, strict=True):
            d["handout"] = per_item.get(i.key)
        return {"items": out, "due": due,
                "next": nxt.recording_id if nxt is not None else None,
                "next_item": ({"recording_id": nxt.recording_id, "mode": nxt.mode, "context_id": nxt.context_id}
                              if nxt is not None else None)}

    def _draft_summary(self, user: User, item: WorkItem) -> dict[str, Any] | None:
        """What the home page shows of unfinished work: its time, annotations, what was viewed, when saved."""
        record = self.store.draft(user.annotator_id, item.key) or {}
        d = record.get("draft") if isinstance(record.get("draft"), dict) else None
        if d is None:
            return None
        try:
            viewed = viewed_seconds(parse_viewed(d.get("viewed")))
        except ApiError:
            viewed = None
        anns = d.get("annotations")
        return {"elapsed_s": _float_or_none(d.get("elapsed_s")),
                "n_annotations": len(anns) if isinstance(anns, list) else None,
                "viewed_s": viewed, "saved_at": d.get("saved_at") or record.get("saved_at") or None}

    def find_item(self, user: User, recording_id: Any, mode: Any, context_id: Any) -> WorkItem:
        if not isinstance(recording_id, str) or not recording_id:
            raise ApiError(400, "bad_request", "recording_id is missing")
        mode = mode or "standard"
        if mode not in MODES:
            raise ApiError(400, "bad_request", f"mode must be one of {', '.join(MODES)}")
        ctx = str(context_id or "") if mode != "standard" else ""
        for i in self.work_items(user):
            if (i.recording_id, i.mode, i.context_id) == (recording_id, mode, ctx):
                return i
        if self.store.manifest(self.scope_for(mode, ctx), recording_id) is None:
            raise ApiError(404, "unknown_recording", f"{recording_id} is not a registered recording of this study")
        raise ApiError(403, "not_assigned", f"{recording_id} is not one of your recordings at the moment")

    # ------------------------------------------------------------- matching
    def match(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        sha = str(body.get("sha256") or "").lower()
        if not SHA_RE.match(sha):
            raise ApiError(400, "bad_request", "sha256 must be the 64-character hexadecimal checksum of the file")
        size = body.get("size_bytes")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise ApiError(400, "bad_request", "size_bytes must be the size of the file in bytes")
        items = self.work_items(user)
        nxt = self._next(user, items)
        revise = body.get("revise") is True
        view_saved = body.get("view_saved") is True
        exact = self.store.manifests_by_fingerprint(sha, size)
        if exact:
            return self._match_answer(user, items, exact, "matched", [], nxt, revise=revise, view_saved=view_saved)
        candidates = self._metadata_matches(body)
        # The study's copy of a recording and a reference set's copy of it (recording_scope "study") are one
        # recording: the same ID and fingerprint in two scopes. They are matched together, as by fingerprint.
        recordings = {(m["recording_id"], fingerprint_of(m)) for m, _d in candidates}
        if len(recordings) == 1:
            differences = candidates[0][1]
            return self._match_answer(user, items, [m for m, _d in candidates], "matched_metadata", differences, nxt,
                                      revise=revise, view_saved=view_saved)
        if len(candidates) > 1:
            return self._answer("unknown", "This file looks like several recordings of the study and cannot be told "
                                "apart from them. Open the exact file you were given, or ask your study administrator.")
        return self._answer("unknown", "This file is not one of the recordings of this study. Check that you opened "
                            "the file you were given (the name is shown in your list of recordings).")

    @staticmethod
    def _answer(status: str, message: str, **fields: Any) -> dict[str, Any]:
        out = {"status": status, "message": message, "recording_id": None, "mode": None, "context_id": None,
               "manifest": None, "draft": None, "differences": [], "repeat": False, "revision": None, "saved": None,
               "task": None}
        out.update(fields)
        return out

    def _metadata_matches(self, body: dict[str, Any]) -> list[tuple[dict[str, Any], list[str]]]:
        name = str(body.get("file_name") or "").strip().lower()
        try:
            sfreq = float(body.get("sfreq"))
            n_samples = int(body.get("n_samples"))
        except (TypeError, ValueError):
            return []
        chans = body.get("ch_names")
        if not name or not isinstance(chans, list):
            return []
        chans = [str(c) for c in chans]
        out = []
        for m in self.store.manifests():
            t = m["timing"]
            if (m["file_name"].lower() != name or abs(float(t["sfreq"]) - sfreq) > 1e-6
                    or int(t["n_samples"]) != n_samples):
                continue
            shown = set(m["ch_names"])
            if not shown.issubset(chans):
                continue
            differences = ["The file's checksum differs from that of the study's copy, so its contents are not "
                           "exactly the same (it may have been copied with changes, exported again or edited)."]
            _sha, size = fingerprint_of(m)
            if size and body.get("size_bytes") != size:
                differences.append(f"The file is {body.get('size_bytes')} bytes; the study's copy is {size} bytes.")
            extra = [c for c in chans if c not in shown and c not in m.get("hidden_channels", [])]
            if extra:
                differences.append("The file has channels the study's copy does not: " + ", ".join(extra[:10])
                                   + (" …" if len(extra) > 10 else ""))
            if [c for c in chans if c in shown] != list(m["ch_names"]):
                differences.append("The channels are in a different order from the study's copy.")
            out.append((m, differences))
        return out

    def _match_answer(self, user: User, items: list[WorkItem], manifests: list[dict[str, Any]], status: str,
                      differences: list[str], nxt: WorkItem | None, *, revise: bool = False,
                      view_saved: bool = False) -> dict[str, Any]:
        keys = {(m["scope"], m["recording_id"]) for m in manifests}
        mine = [i for i in items if (self.scope_for(i.mode, i.context_id), i.recording_id) in keys]
        rid = manifests[0]["recording_id"]
        if not mine:
            return self._answer("not_assigned", f"{rid} is a recording of this study, but it is not one of yours "
                                "at the moment. Open one of the recordings in your list, or ask your study "
                                "administrator.", recording_id=rid)
        open_items = [i for i in mine if i.status not in ("done", "unusable")]
        if not open_items and any(i.status == "unusable" for i in mine):
            i = next(i for i in mine if i.status == "unusable")
            return self._answer("unusable", f"You reported that {rid} cannot be annotated, so it is set aside. If the "
                                "study team returns it to your list, you can annotate it then. Choose another "
                                "recording from your list.", recording_id=rid, mode=i.mode, context_id=i.context_id)
        if not open_items:
            i = mine[0]
            revisable = next((x for x in mine if self.can_revise(x)), None)
            viewable = next((x for x in mine if x.mode == "standard" and x.saved is not None), None)
            if view_saved and viewable is not None:  # to read the feedback on it (docs/web/api.md, "Reviews")
                return self._answer(status, f"Recording found: {viewable.recording_id}. Your latest saved version opens "
                                    "to read, with the feedback on it.", recording_id=viewable.recording_id,
                                    mode=viewable.mode, context_id=viewable.context_id,
                                    manifest=self.public_manifest(viewable.manifest), differences=differences,
                                    task=self.tasks.item_task(viewable),
                                    saved={"version": int((viewable.saved or {}).get("version") or 1),
                                           "saved_at": (viewable.saved or {}).get("saved_at"),
                                           "annotations": self.saved_annotations(user, viewable)})
            if revise and revisable is not None:
                self.training_path.require_open(user, revisable)  # a revision is study work too
                return self._revision_answer(user, revisable, status, differences)
            hint = (" To change your annotations, open it from your history with Open to revise."
                    if revisable is not None else "")
            return self._answer("done", f"You have already completed {rid}.{hint} Choose another recording from your "
                                "list.", recording_id=rid, mode=i.mode, context_id=i.context_id)
        unlocked = [i for i in open_items if i.status != "locked"]
        if not unlocked:  # only study recordings, and real study work waits for the competency assessment
            raise self.training_path.refusal(self.training_path.gate(user))
        open_items = unlocked
        chosen = next((i for i in open_items if nxt is not None and (i.recording_id, i.mode, i.context_id)
                       == (nxt.recording_id, nxt.mode, nxt.context_id)), None)
        if chosen is None:
            chosen = next((i for i in open_items if i.status == "in_progress"), open_items[0])
        self.coach.require_unlocked(user, chosen)
        draft = self.store.draft(user.annotator_id, chosen.key)
        message = ("Recording found: " + chosen.recording_id if status == "matched" else
                   "This file has the name, sampling rate, length and channels of " + chosen.recording_id
                   + " but is not byte for byte the study's copy. Continue only if you are sure it is the same "
                   "recording.")
        return self._answer(status, message, recording_id=chosen.recording_id, mode=chosen.mode,
                            context_id=chosen.context_id, manifest=self.public_manifest(chosen.manifest),
                            draft=(draft or {}).get("draft"), differences=differences, repeat=chosen.repeat,
                            task=self.tasks.item_task(chosen))

    def public_manifest(self, m: dict[str, Any]) -> dict[str, Any]:
        return public_manifest(m, self.settings.display.scalings)

    # ------------------------------------------------------------- revisions
    def can_revise(self, item: WorkItem) -> bool:
        """A finished study recording may be opened again, changed and submitted as a new attempt."""
        return (item.status == "done" and item.mode == "standard" and item.saved is not None
                and bool(self.settings.allow_revisions))

    def saved_annotations(self, user: User, item: WorkItem) -> list[dict[str, Any]]:
        """The annotations of the latest saved attempt, as the browser's annotations."""
        raw = self.store.saved_document(user.annotator_id, item.recording_id, item.mode, item.context_id)
        if raw is None:
            return []
        try:
            doc = json.loads(raw)
        except ValueError:
            return []
        keys = ("annotation_id", "label", "onset_sample", "duration_samples", "channels", "created_at", "modified_at",
                "confidence", "note")
        defaults: dict[str, Any] = {"channels": [], "confidence": None}
        return [{k: a.get(k, defaults.get(k, "")) for k in keys}
                for a in doc.get("annotations", []) if isinstance(a, dict)]

    def _revision_answer(self, user: User, item: WorkItem, status: str, differences: list[str]) -> dict[str, Any]:
        version = int((item.saved or {}).get("version") or 1)
        record = self.store.draft(user.annotator_id, item.key) or {}
        draft = record.get("draft") if record.get("revises") == version else None
        message = (f"Recording found: {item.recording_id}. You are revising it: your version {version} opens, and "
                   f"submitting the revision saves version {version + 1}, keeping the earlier one."
                   if status == "matched" else
                   "This file has the name, sampling rate, length and channels of " + item.recording_id
                   + " but is not byte for byte the study's copy. Continue only if you are sure it is the same "
                   "recording.")
        return self._answer(status, message, recording_id=item.recording_id, mode=item.mode,
                            context_id=item.context_id, manifest=self.public_manifest(item.manifest), draft=draft,
                            differences=differences, task=self.tasks.item_task(item),
                            revision={"version": version + 1, "revises": version,
                                      "saved_at": (item.saved or {}).get("saved_at"),
                                      "annotations": self.saved_annotations(user, item)})

    @staticmethod
    def _refuse_unusable(item: WorkItem) -> None:
        if item.status == "unusable":
            raise ApiError(409, "unusable", f"You reported that {item.recording_id} cannot be annotated, so it is set "
                           "aside. If the study team returns it to your list, you can annotate it then.")

    # ---------------------------------------------------------------- drafts
    def put_draft(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``PUT /drafts/{recording_id}?mode=&context=`` with the Draft as body (``et_put_draft``:
        ``{"recording_id", "mode", "context_id", "draft": Draft}``)."""
        item = self.find_item(user, body.get("recording_id"), body.get("mode"), body.get("context_id"))
        self._refuse_unusable(item)
        self.training_path.require_open(user, item)
        revises = None
        if item.status == "done" and not item.repeat:
            if not self.can_revise(item):
                raise ApiError(409, "already_done", f"{item.recording_id} has already been completed")
            revises = int((item.saved or {}).get("version") or 1)  # the draft of a revision
        draft = body.get("draft")
        if not isinstance(draft, dict):
            raise ApiError(400, "bad_request", "A draft must be an object")
        session_id = draft.get("session_id")
        if session_id is not None and (not isinstance(session_id, str) or len(session_id) > 64):
            raise ApiError(422, "invalid_draft", "draft.session_id must be a short string")
        if session_id and self.store.draft_session_closed(user.annotator_id, item.key, session_id):
            # Sent before its work was discarded and closed, but arriving after: keeping it would bring the work back.
            raise ApiError(409, "draft_discarded", "This draft belongs to work that was discarded when it was closed, "
                           "so it is not kept.")
        anns = draft.get("annotations", [])
        if not isinstance(anns, list) or len(anns) > MAX_ANNOTATIONS or not all(isinstance(a, dict) for a in anns):
            raise ApiError(422, "invalid_draft", "draft.annotations must be a list of annotations")
        for i, a in enumerate(anns, start=1):  # kept as sent; checked in full when the recording is saved
            confidence_and_note(a, f"draft annotation {i}", "invalid_draft")
        self.tasks.check_item(item, anns)  # a task's window: nothing outside it (422 outside_window)
        view = draft.get("view")
        if view is not None and not isinstance(view, dict):
            raise ApiError(422, "invalid_draft", "draft.view must be an object")
        elapsed = draft.get("elapsed_s", 0)
        if (isinstance(elapsed, bool) or not isinstance(elapsed, (int, float)) or not math.isfinite(elapsed)
                or elapsed < 0):
            raise ApiError(422, "invalid_draft", "draft.elapsed_s must be a number of seconds")
        elapsed = min(float(elapsed), MAX_ELAPSED_S)
        viewed = parse_viewed(draft.get("viewed"))
        saved_at = now_local_iso()
        record = {"schema": "electrotag.web_draft", "recording_id": item.recording_id, "mode": item.mode,
                  "context_id": item.context_id, "annotator_id": user.annotator_id, "saved_at": saved_at,
                  "draft": {"annotations": anns, "view": view or {}, "elapsed_s": float(elapsed), "viewed": viewed,
                            "saved_at": saved_at}}
        if revises is not None:
            record["revises"] = revises
            record["draft"]["revises"] = revises
        if len(json.dumps(record)) > 8 * 1024 * 1024:
            raise ApiError(413, "too_large", "The draft is too large to keep")
        self.store.put_draft(user.annotator_id, item.key, record)
        return {"saved_at": saved_at}

    def delete_draft(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rid, mode = body.get("recording_id"), body.get("mode") or "standard"
        if not isinstance(rid, str) or mode not in MODES:
            raise ApiError(400, "bad_request", "recording_id and mode are needed")
        ctx = str(body.get("context_id") or "") if mode != "standard" else ""
        session_id = body.get("session_id")
        if session_id is not None and (not isinstance(session_id, str) or len(session_id) > 64):
            raise ApiError(400, "bad_request", "session_id must be a short string")
        self.store.delete_draft(user.annotator_id, item_key(rid, mode, ctx), closed_session=session_id or None)
        return {}

    # ---------------------------------------------------------------- saving
    def _filters(self, chosen: Any, warnings: list[str]) -> tuple[FilterSettings, dict[str, Any]]:
        study_filters = self.settings.filters
        if not isinstance(chosen, dict):
            return study_filters, {}
        shown = clean_json({k: chosen.get(k) for k in ("highpass_hz", "notch_hz", "notch_harmonics", "method")
                            if k in chosen})
        if study_filters.locked:
            return study_filters, shown
        hp, notch = chosen.get("highpass_hz"), chosen.get("notch_hz")
        try:
            f = FilterSettings(
                highpass_enabled=hp is not None,
                highpass_hz=float(hp) if hp is not None else study_filters.highpass_hz,
                notch_enabled=notch is not None,
                notch_hz=float(notch) if notch is not None else study_filters.notch_hz,
                notch_harmonics=bool(chosen.get("notch_harmonics", False)),
                method="fir",
            )
            f.validate()
        except (TypeError, ValueError, SettingsError):
            warnings.append(f"The browser reported display filters ElectroTag does not offer ({shown}); the "
                            "study's filters are recorded instead.")
            return study_filters, shown
        return f, shown

    def submit(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.web.manifest import ManifestRecording
        from electrotag.web.saving import WebSession

        item = self.find_item(user, body.get("recording_id"), body.get("mode"), body.get("context_id"))
        self._refuse_unusable(item)
        self.training_path.require_open(user, item)
        rid = item.recording_id
        revision: dict[str, Any] | None = None
        if item.status == "done" and not item.repeat:
            revises = body.get("revises")
            if revises is None:
                raise ApiError(409, "already_done", f"You have already completed {rid}; it is not saved twice.")
            if not self.can_revise(item):
                raise ApiError(409, "revisions_off", f"You have already completed {rid}, and this study does not "
                               "take revisions of finished recordings.")
            if isinstance(revises, bool) or not isinstance(revises, int):
                raise ApiError(400, "bad_request", "revises must be the version being revised (a whole number)")
            latest = latest_entry([e for e in self.store.completion_entries(user.annotator_id)
                                   if e.get("recording_id") == rid and e.get("mode", "standard") == item.mode
                                   and e.get("context", "") == item.context_id and e.get("status") == "completed"])
            version = attempt_of(latest)
            if revises != version:
                raise ApiError(409, "already_revised", f"{rid} has been saved again since you opened it (version "
                               f"{version}). Open it again from your history to revise the latest version.")
            revision = {"version": version + 1, "revises_version": version,
                        "revises_session_id": latest.get("session_id", ""),
                        "revises_output_basename": latest.get("output_basename", "")}
        self.coach.require_unlocked(user, item)
        info = body.get("session") if isinstance(body.get("session"), dict) else {}
        sha = str(body.get("sha256") or "").lower()
        if not SHA_RE.match(sha):
            raise ApiError(400, "bad_request", "sha256 (the checksum of the annotated file) is missing")
        elapsed = _number(info.get("elapsed_s", 0.0), "session.elapsed_s", minimum=0.0)
        warnings: list[str] = []
        if elapsed > MAX_ELAPSED_S:  # kept, never refused: the annotations are what matters
            warnings.append(f"The browser reported {elapsed:.0f} s of work on this recording, more than a week; "
                            f"{MAX_ELAPSED_S:.0f} s is recorded instead.")
            elapsed = MAX_ELAPSED_S
        filters, shown_filters = self._filters(info.get("filters"), warnings)
        loaded = ManifestRecording(item.manifest, display_filters=shown_filters)
        reg_sha, _size = fingerprint_of(item.manifest)
        if sha == reg_sha:
            loaded.notes.append("Annotated in the browser; the data file's SHA-256 matched the registered recording.")
        else:
            loaded.warnings.append(f"The file annotated in the browser (SHA-256 {sha}) is not byte for byte the "
                                   f"registered recording (SHA-256 {reg_sha}); its name, sampling rate, length and "
                                   "channels matched and the annotator confirmed it is the same recording.")
        loaded.warnings.extend(warnings)
        anns = parse_annotations(body.get("annotations"), loaded.info, self.store.catalogue,
                                 self.settings.min_duration_samples)
        self.tasks.check_item(item, anns)  # a task's window: nothing outside it (422 outside_window)
        context: dict[str, Any] = {}
        if revision is not None:
            context["revision"] = dict(revision)  # in the saved _annotations.json and _session.json
        rs: ReferenceSet | None = None
        guided_summary = None
        if item.mode != "standard":
            rs = self.reference_set(item.context_id)
            context = {"reference_set_id": rs.set_id, "reference_set_name": rs.name}
            if item.mode == "guided":
                guided_summary = self.coach.verify_for_saving(user, rs, rid, anns, loaded.info.timing.sfreq)
                context["guided"] = dict(guided_summary)
        client = clean_json(info.get("client")) if isinstance(info.get("client"), dict) else {}
        session_id = info.get("session_id")
        if session_id is not None:
            if not isinstance(session_id, str) or not SESSION_RE.match(session_id.lower()):
                raise ApiError(400, "bad_request", "session.session_id must be 32 hexadecimal characters")
            session_id = session_id.lower()
            if any(e.get("session_id") == session_id for e in self.store.completion_entries(user.annotator_id)):
                session_id = None  # already the ID of a saved result: this save gets its own
        view = info.get("view") if isinstance(info.get("view"), dict) else {}
        display_state = {k: float(view[k]) for k in ("start_s", "duration_s", "first_channel", "n_channels",
                                                     "scale_factor")
                         if isinstance(view.get(k), (int, float)) and not isinstance(view.get(k), bool)
                         and math.isfinite(view[k])}
        from electrotag.web.games import viewed_fraction

        viewed = viewed_fraction(info.get("viewed_fraction"))
        if viewed is not None:
            display_state["viewed_fraction"] = viewed

        def make_session(layout: Any) -> WebSession:
            s = WebSession(layout=layout, settings=self.settings, filters=filters, catalogue=self.store.catalogue,
                           loaded=loaded, annotator_id=user.annotator_id, display_name=user.display_name,
                           mode=item.mode, context=context, initial_annotations=anns,
                           allow_repeat=item.repeat or revision is not None, autosave_enabled=False, client=client,
                           server=self.store.kind, session_id=session_id,
                           expected_attempt=revision["version"] if revision is not None else None)
            s.display_state = display_state
            return s

        saved = self.store.save_results(make_session, elapsed_s=elapsed, started_at=_stamp(info.get("started_at")))
        self.store.delete_draft(user.annotator_id, item.key)
        out: dict[str, Any] = {"saved": True, "files": sorted(saved.files), "attempt": saved.attempt,
                               "feedback": None, "guided": None, "assessment": None,
                               "revision": ({"version": saved.attempt, "revises": revision["revises_version"]}
                                            if revision is not None else None)}
        if viewed is not None:
            try:
                self.games.record_viewed(user, rid, item.mode, item.context_id, viewed)
            except Exception:  # noqa: BLE001 - the results are saved; a lost coverage figure only affects a badge
                log.exception("The share viewed of %s could not be kept", rid)
        if item.task_id:
            try:  # a known-answer task is scored now; quality_list scores any save whose scoring was interrupted
                self.tasks.after_save(user, item, saved)
            except Exception:  # noqa: BLE001 - the results are saved; the score is made again when asked for
                log.exception("The known-answer score of %s could not be kept", rid)
        if item.mode == "practice" and rs is not None:
            out["feedback"] = self.coach.practice_result(user, rs, rid, saved.session.build_document(), elapsed,
                                                         loaded.info.timing.sfreq)
        elif item.mode == "guided" and rs is not None and guided_summary is not None:
            out["guided"] = self.coach.record_guided(user, rs, rid, guided_summary, saved.session.build_document())
        elif item.mode == "assessment" and rs is not None:
            out["assessment"] = self.coach.assessment_result(user, rs)
        out["next"] = self.assignments(user)["next"]
        return out

    # -------------------------------------------------------------- training
    def training(self, user: User, body: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.coach.programme_view(user)

    def guided_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.coach.guided_view(user, _rid(body))

    def guided_check(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.coach.guided_check(user, _rid(body), body)

    def guided_continue(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.coach.guided_continue(user, _rid(body), body)

    def guided_show_me(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.coach.guided_show_me(user, _rid(body), body)

    def training_stage(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``POST /training/stage {stage, action}``: skip, finish or resume a stage of the training path
        (electrotag/web/coach.py). Saves; the browser never repeats it by itself."""
        return self.coach.stage_action(user, body)

    def training_snippets(self, user: User, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """``GET /training/snippets``: the artifact snippets of the trainee's set (electrotag/web/coach.py)."""
        return self.coach.snippets_view(user)

    # ----------------------------------------------- feedback on one's own work
    def my_feedback(self, user: User, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """``GET /me/feedback``: the corrections of the annotator's saved work and the outcomes of the conflicts
        in it, each when the study shows them (electrotag/web/expert.py, ``FEEDBACK_PARTS``)."""
        return self.expert.my_feedback(user)

    # ---------------------------------------------------------- achievements
    def achievements(self, user: User, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """``GET /me/achievements`` (and ``POST`` with ``goal_per_week`` or ``leaderboard_hidden``)."""
        return self.games.achievements(user, body or {})

    # ------------------------------------------- problem reports and reviews
    def problem_report(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``POST /problems``: report a problem with a recording (electrotag/web/feedback.py)."""
        return self.feedback.problem_report(user, body)

    def my_reviews(self, user: User, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """``GET /me/reviews``: the reviews of the annotator's saved work, when the study shows them."""
        return self.feedback.my_reviews(user, body or {})

    # ---------------------------------------------------------------- visits
    def visit_open(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.visits.open(user, body)

    def visit_events(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.visits.events(user, body)

    def visit_close(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return self.visits.close(user, body)

    # ---------------------------------------------------------- administration
    def admin_progress(self, user: User, body: dict[str, Any] | None = None) -> dict[str, Any]:
        if not user.is_admin:
            raise ApiError(403, "forbidden", "Only study administrators can see the progress of the study")
        entries = self.store.completion_entries()
        out = []
        for u in self.store.users():
            person = User(u["annotator_id"], u.get("display_name", ""), u.get("role", "annotator"))
            items = []
            for i in self.work_items(person):
                mine = [e for e in entries if e.get("annotator_id") == person.annotator_id
                        and e.get("recording_id") == i.recording_id and e.get("mode", "standard") == i.mode
                        and e.get("context", "") == i.context_id and e.get("status") == "completed"]
                draft = self.store.draft(person.annotator_id, i.key) or {}
                last = max([e.get("completed_at", "") for e in mine] + [draft.get("saved_at", "")])
                items.append({"recording_id": i.recording_id, "mode": i.mode, "context_id": i.context_id,
                              "status": i.status, "attempts": len(mine), "last_activity": last or None})
            entry: dict[str, Any] = {"annotator_id": person.annotator_id, "display_name": person.display_name,
                                     "role": person.role, "last_seen": u.get("last_seen") or None, "items": items,
                                     "programme": None}
            if self.store.programme(person.annotator_id):
                try:
                    entry["programme"] = self.coach.programme_view(person)
                except ApiError as exc:
                    entry["programme"] = {"error": exc.code, "message": exc.message}
            out.append(entry)
        return {"study": self.store.name, "generated_at": now_local_iso(), "annotators": out}

    # ------------------------------------------------------------ invitations
    #: What a person is told when their invitation link cannot be used, by the reason.
    INVITE_PROBLEMS = {
        "unknown": (404, "This invitation link is not known to the study. It may have been replaced by a newer "
                         "link or withdrawn. To get a new link, contact the study team who invited you, for "
                         "example by replying to the email that brought you this one."),
        "used": (409, "This invitation link has been used already. Sign in with your annotator ID and the "
                      "password you chose, or ask the study team for a new link."),
        "expired": (409, "This invitation link has expired. To get a new link, contact the study team who invited "
                         "you, for example by replying to the email that brought you this one."),
    }

    def _invite_problem(self, reason: str) -> ApiError:
        status, message = self.INVITE_PROBLEMS[reason]
        return ApiError(status, f"invite_{reason}", message)

    def invite_check(self, body: dict[str, Any]) -> dict[str, Any]:
        """``POST /invite/check {token}`` (no sign-in): whose invitation this is, for the welcome card."""
        token = body.get("token")
        inv = self.store.invitation_for_token(token) if isinstance(token, str) else None
        if inv is None:
            raise self._invite_problem("unknown")
        if inv["state"] in ("accepted", "expired"):
            raise self._invite_problem("used" if inv["state"] == "accepted" else "expired")
        if inv["state"] != "invited":
            raise self._invite_problem("unknown")
        return {"annotator_id": inv["annotator_id"], "display_name": inv.get("display_name", ""),
                "study_name": self.store.name, "expires_at": inv["expires_at"]}

    def invite_accept(self, body: dict[str, Any]) -> User:
        """``POST /invite/accept {token, password}`` (no sign-in): the person's own password, set once."""
        from electrotag.web.store import AccountProblem

        token, password = body.get("token"), body.get("password")
        if not isinstance(password, str) or not 8 <= len(password) <= 200:
            raise ApiError(400, "bad_password", "Choose a password of at least 8 characters.")
        if not isinstance(token, str):
            raise self._invite_problem("unknown")
        try:
            return self.store.accept_invitation(token, password)
        except AccountProblem as exc:
            reason = exc.code.removeprefix("invite_")
            if reason in self.INVITE_PROBLEMS:
                raise self._invite_problem(reason) from exc
            raise ApiError(exc.status, exc.code, exc.message or "The invitation could not be used.") from exc

    def admin(self, op: Any, user: User, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """One operation of the admin area (docs/web/api.md, "Administration"; electrotag/web/admin.py)."""
        return self.administration.run(op, user, body or {})

    def expert_op(self, op: Any, user: User, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """One operation of the expert area (docs/web/api.md, "Experts"; electrotag/web/expert.py)."""
        return self.expert.run(op, user, body or {})

    # ------------------------------------------------------------------ quiz
    def quiz(self, user: User, set_id: Any, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """The short-segment quiz of a reference set: get, answer, finish (electrotag/web/quiz.py)."""
        return self.quizzes.run(user, set_id, body or {})

    #: Operation name -> method, for the HTTP routes and the Firebase functions. ``admin`` and ``expert`` take
    #: the operation in the body's ``op`` and ``quiz`` the set in its ``set_id``.
    OPERATIONS = ("me", "assignments", "match", "put_draft", "delete_draft", "submit", "training", "guided_get",
                  "guided_check", "guided_continue", "guided_show_me", "visit_open", "visit_events", "visit_close",
                  "admin_progress", "admin", "quiz", "achievements", "problem_report", "my_reviews", "expert",
                  "my_feedback", "training_stage", "training_snippets")

    def call(self, operation: str, user: User, body: dict[str, Any] | None) -> dict[str, Any]:
        if operation not in self.OPERATIONS:
            raise ApiError(404, "not_found", f"Unknown operation {operation}")
        if body is not None and not isinstance(body, dict):
            raise ApiError(400, "bad_request", "The request must be a JSON object")
        body = body or {}
        if operation == "admin":
            return self.admin(body.get("op"), user, {k: v for k, v in body.items() if k != "op"})
        if operation == "expert":
            return self.expert_op(body.get("op"), user, {k: v for k, v in body.items() if k != "op"})
        if operation == "quiz":
            return self.quiz(user, body.get("set_id"), {k: v for k, v in body.items() if k != "set_id"})
        return getattr(self, operation)(user, body)


def _rid(body: dict[str, Any]) -> str:
    rid = body.get("recording_id")
    if not isinstance(rid, str) or not rid:
        raise ApiError(400, "bad_request", "recording_id is missing")
    return rid
