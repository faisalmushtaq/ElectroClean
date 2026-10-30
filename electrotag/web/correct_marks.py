"""Correct the marks: exercises made from a guided recording's reference (docs/web/api.md, "Derived versions in
the analyses" and "Correct the marks").

The study keeps, with a reference set, a flawed copy of the experts' marks for some of its guided recordings:
``rs.guided["planted"][recording_id] = {"annotations", "errors", "seed", "counts", "capped", "notes",
"made_by", "made_at", "method", "reference_sha256"}``. :mod:`electrotag.training.planted` makes it (from a seed,
so that every trainee meets the same exercise) or finds the mistakes in an expert's own deliberately flawed
annotations, and scores a trainee's corrections. Experts and administrators make, look at, replace and remove
the exercises through the expert channel (``planted_list``, ``planted_get``, ``set_planted_make``,
``set_planted_from``, ``set_planted_remove``); the admin channel offers the same as ``set_planted_get``,
``set_planted_make``, ``set_planted_from`` and ``set_planted_remove``. Every change is audited.

What a trainee sees is :func:`trainee_view` (the copy and one instruction, never which marks are wrong) and
:func:`trainee_score` (practice feedback against the reference, and the planted mistakes fixed, not fixed, and
the new ones); the training path's "Learn with the experts" stage calls them for a guided recording whose
exercise is "correct the marks".
"""

from __future__ import annotations

import secrets
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from electrotag.app.common import now_local_iso
from electrotag.web import audit
from electrotag.web.errors import ApiError
from electrotag.web.expert import expert_op
from electrotag.web.store import User

if TYPE_CHECKING:
    from electrotag.app.annotations.model import AnnotationDocument
    from electrotag.training.reference import ReferenceSet
    from electrotag.web.service import StudyService

INSTRUCTION = ("Some of these marks are wrong and some artifacts are not marked. Look through the recording, correct "
               "the type, start, end or channels of any mark that is wrong, remove marks where there is no artifact "
               "and mark what is missing. Then press Save and Finish to see how you did.")
SEED_MAX = 1_000_000


def _bad(message: str, code: str = "bad_request", status: int = 400, **extra: Any) -> ApiError:
    return ApiError(status, code, message, **extra)


# ------------------------------------------------------------------ reading
def _rid(body: dict[str, Any]) -> str:
    rid = body.get("recording_id")
    if not isinstance(rid, str) or not rid.strip() or len(rid) > 500:
        raise _bad("recording_id is missing")
    return rid.strip()


def _set_and_recording(service: StudyService, body: dict[str, Any]) -> tuple[ReferenceSet, str]:
    set_id = body.get("set_id")
    if not isinstance(set_id, str) or not set_id:
        raise _bad("set_id is missing")
    rs = service.reference_set(set_id)
    rid = _rid(body)
    if rid not in rs.recordings:
        raise _bad(f"{rid} is not one of the recordings of {rs.name or rs.set_id}", "not_in_set", 404)
    if rs.recordings[rid].get("use") != "guided":
        raise _bad(f"Correct the marks uses a recording for learning with the experts (guided); {rid} is used for "
                   f"{rs.recordings[rid].get('use')}. Change what it is used for in Training first.", "not_guided", 409)
    return rs, rid


def _reference(rs: ReferenceSet, rid: str) -> AnnotationDocument:
    from electrotag.training.reference import ReferenceSetError

    try:
        return rs.reference_document(rid)
    except (ReferenceSetError, OSError, ValueError) as exc:
        raise _bad("The reference of this recording cannot be read", "reference_unavailable", 500) from exc


def _tolerance(rs: ReferenceSet) -> Any:
    from electrotag.training.guided import Tolerance

    try:
        return Tolerance.from_dict(rs.guided.get("tolerance"))
    except (ValueError, TypeError):
        return Tolerance()


def stored(rs: ReferenceSet, rid: str) -> dict[str, Any] | None:
    rec = dict(rs.guided.get("planted") or {}).get(rid)
    return dict(rec) if isinstance(rec, dict) else None


def is_current(rs: ReferenceSet, rid: str, rec: dict[str, Any] | None = None) -> bool:
    """True when the recording has an exercise made from its reference as it is now (a reference replaced since
    makes the exercise stale)."""
    from electrotag.training.planted import reference_sha256

    rec = rec if rec is not None else stored(rs, rid)
    if not rec:
        return False
    try:
        return rec.get("reference_sha256") == reference_sha256(rs.reference_document(rid))
    except Exception:  # noqa: BLE001 - an unreadable reference makes no exercise
        return False


def planted_out(rs: ReferenceSet, rid: str, rec: dict[str, Any] | None) -> dict[str, Any] | None:
    """The exercise as experts see it: the flawed copy, each mistake (with its times in seconds), how it was made."""
    if not rec:
        return None
    sf = float(_reference(rs, rid).recording.timing.sfreq)
    errors = [{**e, "onset_s": round(int(e.get("onset_sample", 0)) / sf, 4),
               "offset_s": round(int(e.get("end_sample", 0)) / sf, 4)} for e in rec.get("errors") or []]
    return {"annotations": list(rec.get("annotations") or []), "errors": errors, "n_errors": len(errors),
            "seed": rec.get("seed"), "counts": rec.get("counts"), "capped": bool(rec.get("capped")),
            "notes": list(rec.get("notes") or []), "method": rec.get("method", "auto"),
            "made_by": rec.get("made_by", ""), "made_at": rec.get("made_at", ""),
            "stale": not is_current(rs, rid, rec)}


def _done_by(service: StudyService, rs: ReferenceSet, rid: str) -> list[str]:
    """The trainees who saved the guided recording already (an exercise changed now differs from theirs)."""
    return sorted({e["annotator_id"] for e in service.store.completion_entries() if e.get("recording_id") == rid
                   and e.get("mode") == "guided" and e.get("context", "") == rs.set_id
                   and e.get("status") == "completed"})


def _scope(service: StudyService, rs: ReferenceSet) -> str:
    return service.administration._set_scope(rs)


def get(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """The exercise of one guided recording with what an expert needs to judge it: the reference's marks, the
    guided tolerance, the recording's manifest."""
    from electrotag.training.planted import wire

    rs, rid = _set_and_recording(service, body)
    ref = _reference(rs, rid)
    m = service.store.manifest(_scope(service, rs), rid)
    return {"set_id": rs.set_id, "set_name": rs.name, "recording_id": rid,
            "file_name": (m or {}).get("file_name") or rid.rsplit("/", 1)[-1],
            "manifest": service.public_manifest(m) if m else None,
            "reference": [wire(a) for a in ref.sorted_annotations()], "tolerance": _tolerance(rs).to_dict(),
            "planted": planted_out(rs, rid, stored(rs, rid)), "done_by": len(_done_by(service, rs, rid)),
            "instruction": INSTRUCTION}


def listing(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """Every reference set's guided recordings, each with its exercise (or none)."""
    sets = []
    for rs in service.store.reference_sets():
        rows = []
        for rid in rs.guided_recordings:
            rec = stored(rs, rid)
            rows.append({"recording_id": rid, "n_reference": int(rs.recordings[rid].get("n_annotations", 0) or 0),
                         "planted": None if not rec else {
                             "n_errors": len(rec.get("errors") or []), "seed": rec.get("seed"),
                             "method": rec.get("method", "auto"), "made_by": rec.get("made_by", ""),
                             "made_at": rec.get("made_at", ""), "capped": bool(rec.get("capped")),
                             "stale": not is_current(rs, rid, rec)}})
        if rows:
            sets.append({"set_id": rs.set_id, "name": rs.name, "recordings": rows})
    return {"sets": sets}


# ------------------------------------------------------------------ saving
def _keep(service: StudyService, user: User, rs: ReferenceSet, rid: str, rec: dict[str, Any] | None,
          op: str, summary: str, details: dict[str, Any]) -> dict[str, Any]:
    """Store (or, with None, remove) the exercise of ``rid`` in the set, audited."""
    with service.administration._editing(rs.set_id) as edited:
        planted = dict(edited.guided.get("planted") or {})
        if rec is None:
            planted.pop(rid, None)
        else:
            planted[rid] = rec
        edited.guided["planted"] = planted
        edited.save()
    audit.record(service.store, user.annotator_id, op, summary, {"set_id": rs.set_id, "recording_id": rid, **details})
    rs = service.reference_set(rs.set_id)
    done = _done_by(service, rs, rid)
    warnings = ([f"{audit.count(len(done), 'trainee')} did this recording with the earlier exercise or without one; "
                 "their results stay as they were."] if done and rec is not None else [])
    return {"planted": planted_out(rs, rid, stored(rs, rid)), "warnings": warnings,
            "set": service.administration.set_record(rs)}


def make(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """``set_planted_make``: plant mistakes in a copy of the reference, from ``seed`` (a new one when none is given)
    and ``counts``, replacing the recording's earlier exercise."""
    from electrotag.training.planted import check_counts, plant_errors, reference_sha256, wire

    rs, rid = _set_and_recording(service, body)
    seed = body.get("seed")
    if seed is None:
        seed = secrets.randbelow(SEED_MAX - 1) + 1
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < SEED_MAX:
        raise _bad(f"seed must be a whole number from 0 to {SEED_MAX - 1}")
    try:
        counts = check_counts(body.get("counts"))
    except ValueError as exc:
        raise _bad(str(exc)) from exc
    ref = _reference(rs, rid)
    if not ref.annotations:
        raise _bad("The reference of this recording has no marks, so there is nothing to put mistakes in.",
                   "no_reference_marks", 422)
    p = plant_errors(ref, seed=seed, counts=counts, catalogue=service.store.catalogue, tolerance=_tolerance(rs))
    rec = {"annotations": [wire(a) for a in p.annotations], "errors": p.errors, "seed": p.seed, "counts": p.made,
           "requested": p.requested, "capped": p.capped, "notes": p.notes, "method": "auto",
           "made_by": user.annotator_id, "made_at": now_local_iso(), "reference_sha256": reference_sha256(ref)}
    return _keep(service, user, rs, rid, rec, "set_planted_make",
                 f"Made a correct-the-marks exercise of {rid} in {rs.set_id}: "
                 f"{audit.count(len(p.errors), 'planted mistake')} (seed {p.seed})",
                 {"seed": p.seed, "counts": p.made, "capped": p.capped})


def make_from(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """``set_planted_from``: an expert's own deliberately flawed annotations as the exercise (Source ``annotator``,
    someone's saved annotations of the recording, or ``document``, an annotation file), the mistakes found by
    comparing them with the reference."""
    from electrotag.training.planted import errors_from, reference_sha256, wire

    rs, rid = _set_and_recording(service, body)
    source = body.get("source")
    if not isinstance(source, dict) or source.get("kind") not in ("annotator", "document"):
        raise _bad("source.kind must be annotator (someone's saved annotations) or document (an annotation file)")
    ref = _reference(rs, rid)
    with tempfile.TemporaryDirectory(prefix="electrotag-planted-") as tmp:
        src = service.administration._source(source, rid, Path(tmp))
    doc = src["doc"]
    t = doc.recording.timing
    if abs(float(t.sfreq) - float(ref.recording.timing.sfreq)) > 1e-6 or int(t.n_samples) != \
            int(ref.recording.timing.n_samples):
        raise _bad(f"These annotations describe a recording of {t.n_samples} samples at {t.sfreq:g} Hz, not {rid}",
                   "invalid_document", 422)
    errors = errors_from(doc, ref, _tolerance(rs))
    if not errors:
        raise _bad("These annotations agree with the reference within the guided tolerance, so they hold no mistakes "
                   "to correct.", "no_mistakes", 422)
    rec = {"annotations": [wire(a) for a in doc.sorted_annotations()], "errors": errors, "seed": None,
           "counts": {k: sum(1 for e in errors if e["kind"] == k) for k in sorted({e["kind"] for e in errors})},
           "requested": None, "capped": False, "notes": [], "method": "from_annotations",
           "source": {"kind": source.get("kind"), "experts": list(src.get("experts") or [])},
           "made_by": user.annotator_id, "made_at": now_local_iso(), "reference_sha256": reference_sha256(ref)}
    return _keep(service, user, rs, rid, rec, "set_planted_from",
                 f"Made a correct-the-marks exercise of {rid} in {rs.set_id} from "
                 f"{', '.join(src.get('experts') or []) or 'an annotation file'}: "
                 f"{audit.count(len(errors), 'mistake')}", {"source": rec["source"], "n_errors": len(errors)})


def remove(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """``set_planted_remove``: the recording goes back to the guided coach's steps."""
    rs, rid = _set_and_recording(service, body)
    if stored(rs, rid) is None:
        raise _bad(f"{rid} has no correct-the-marks exercise", "no_exercise", 404)
    out = _keep(service, user, rs, rid, None, "set_planted_remove",
                f"Removed the correct-the-marks exercise of {rid} in {rs.set_id}", {})
    return {"set": out["set"]}


# ------------------------------------------------------------------ the trainee's side
def trainee_view(service: StudyService, rs: ReferenceSet, rid: str) -> dict[str, Any]:
    """What the trainee opens with (``GET /training/guided/{rid}`` for an exercise): the flawed copy and the
    instruction, never which marks are wrong. 409 ``no_exercise`` when the recording has none, or only one made
    from an earlier reference."""
    rec = stored(rs, rid)
    if not rec or not is_current(rs, rid, rec):
        raise _bad("This recording's exercise is not ready. Tell the study team.", "no_exercise", 409)
    return {"guidance": "correct", "n_steps": 0, "start_annotations": list(rec.get("annotations") or []),
            "instruction": INSTRUCTION, "n_planted": len(rec.get("errors") or [])}


def trainee_score(service: StudyService, rs: ReferenceSet, rid: str, document: AnnotationDocument
                  ) -> dict[str, Any]:
    """The trainee's saved corrections scored: practice feedback against the reference (``event_f1`` and the
    review's flags) and the planted mistakes (``planted``: fixed, not fixed, new mistakes, each item)."""
    from electrotag.training.assessment import practice_feedback
    from electrotag.training.planted import from_wire, score_corrections

    rec = stored(rs, rid) or {}
    ref = _reference(rs, rid)
    fb = practice_feedback(document, ref, rs)
    score = score_corrections(list(rec.get("errors") or []), list(document.annotations), list(ref.annotations),
                              float(ref.recording.timing.sfreq), _tolerance(rs),
                              planted=[from_wire(a) for a in rec.get("annotations") or []])
    return {"kind": "correct", "event_f1": fb["overall"].get("event_f1"), "feedback": fb, "planted": score,
            "fixed": score["fixed"], "n_errors": score["n_errors"], "new_mistakes": score["new_mistakes"]}


# ------------------------------------------------------------------ the expert channel
@expert_op("planted_list")
def _planted_list(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    return listing(service, user, body)


@expert_op("planted_get")
def _planted_get(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    return get(service, user, body)


@expert_op("set_planted_make")
def _set_planted_make(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    return make(service, user, body)


@expert_op("set_planted_from")
def _set_planted_from(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    return make_from(service, user, body)


@expert_op("set_planted_remove")
def _set_planted_remove(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    return remove(service, user, body)


__all__ = ["INSTRUCTION", "get", "is_current", "listing", "make", "make_from", "planted_out", "remove", "stored",
           "trainee_score", "trainee_view"]
