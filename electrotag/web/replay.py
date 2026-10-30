"""Replays of annotation sessions from the interaction log (docs/web/api.md, "Corrections and replay").

The interaction log already records everything a session needs to be played back: the view, the
pointer, the keys, every change of an annotation with its full summary, the dialogs, pauses and how
the session ended. A **segment** is one recording opened in one browser window of a visit, from its
``recording_opened`` to its ``recording_finished`` or ``closed_without_saving`` (the store's visit
index, :meth:`~electrotag.web.store.Store.visit_index`, lists them). ``replay_index_get`` lists the
segments of one person and recording, oldest first, with the attempt each saved (matched by the
session's ID, which the browser sends with its save; for older logs, the n-th finished segment is
the n-th attempt) and the saved annotations to compare the end of the replay with;
``replay_events_get`` pages through one segment's events (at most 10,000 at a time, the pointer's
optionally left out). Since the browser logs an ``annotations_snapshot`` when a session opens with
annotations already present (a restored draft, a revision); a segment logged before that starts
from where the segment before it ended.

**Who may watch.** Experts and administrators may replay anyone's sessions while the study's
``replay.enabled`` is on. Anyone else (a trainee, or an annotator) may watch an expert's sessions only
when that expert agrees to their sessions being used for teaching (``replay_consent_set``) and the
study's ``replay.trainees_watch_experts`` is on, and then only the expert's sessions on a **teaching
recording** (:func:`teaching_recording`): a recording of a self-contained training set, used there for
learning with the experts, which the study's own register does not hold under its ID or its
fingerprint. Annotations stay independent that way: nobody watches an expert mark a recording they
hold, or may later be given, as study work, nor one of the practice or assessment recordings, whose
answers it would give away (the rule for snippets in ``training/reference.py``). ``teaching_list``
lists what there is to watch. These are checked here, on the server, for every request, and
``replay_events_get`` gives such a watcher one segment at a time, never a whole visit.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from electrotag.web.errors import ApiError
from electrotag.web.expert import consent_of, expert_op
from electrotag.web.manifest import SCOPE_STUDY, fingerprint_of, set_scope
from electrotag.web.store import MODES, StoreError, User, attempt_of, latest_entry, parse_roles

if TYPE_CHECKING:
    from electrotag.web.service import StudyService

#: How many of the person's visits are looked through for a recording's segments (newest first).
MAX_VISITS = 200
MAX_PAGE = 10000
OUTCOMES = {"finished": "finished", "closed_without_saving": "closed_without_saving", "": "not_finished"}


def _bad(message: str, code: str = "bad_request", status: int = 400) -> ApiError:
    return ApiError(status, code, message)


def _is_expert_account(service: StudyService, aid: str) -> bool:
    rec = service.store.user_record(aid) or {}
    roles = parse_roles(rec.get("roles") or rec.get("role"))
    return rec.get("status", "active") == "active" and ("expert" in roles or "admin" in roles)


def may_replay(service: StudyService, user: User, annotator_id: str) -> None:
    """Raise unless ``user`` may watch ``annotator_id``'s sessions (see the module docstring)."""
    r = service.settings.replay
    if user.is_expert:
        if not r.enabled:
            raise ApiError(409, "replays_off", "This study does not replay sessions at the moment. The study team "
                           "can switch replays on in the study settings.")
        return
    if not (r.enabled and r.trainees_watch_experts):
        raise ApiError(403, "forbidden", "This study does not show experts' sessions to trainees at the moment.")
    if not _is_expert_account(service, annotator_id) or not consent_of(service, annotator_id)["teaching"]:
        raise ApiError(403, "forbidden", "You can watch the sessions of experts who have agreed to it for teaching; "
                       "this one is not among them.")


#: Why a trainee may not watch an expert's session on a recording (403 ``forbidden``).
NOT_FOR_TEACHING = ("Trainees watch experts only on the training recordings for learning with the experts, so that "
                    "what you annotate for the study stays your own judgement. This session is not on one of them.")


def teaching_recording(service: StudyService, recording_id: str, mode: str, context_id: str) -> bool:
    """True when an expert's session on this recording, in this mode and training set, may be shown to trainees: a
    recording of a self-contained training set (never the study's own register), used there for learning with the
    experts (``guided``: practice and assessment recordings would give their answers away), neither its ID nor
    its fingerprint in the study's register, so that nobody can be given it as study work, and not the same file as
    a practice or assessment recording of any other set."""
    from electrotag.training.reference import ReferenceSetError

    if mode == "standard" or not context_id:
        return False
    try:
        rs = service.store.reference_set(context_id)
    except ReferenceSetError:
        return False
    if not rs.self_contained or (rs.recordings.get(recording_id) or {}).get("use") != "guided":
        return False
    m = service.store.manifest(set_scope(rs.set_id), recording_id)
    if m is None or service.store.manifest(SCOPE_STUDY, recording_id) is not None:
        return False
    sha, size = fingerprint_of(m)
    if sha and any(o.get("scope") == SCOPE_STUDY for o in service.store.manifests_by_fingerprint(sha, size)):
        return False
    # the same file as a practice or assessment recording of another set would give that set's answers away
    return not service.training_path.answer_sets(recording_id, scope=set_scope(rs.set_id))


def may_watch(service: StudyService, user: User, annotator_id: str, recording_id: str, mode: str,
              context_id: str) -> None:
    """Raise unless ``user`` may watch ``annotator_id``'s sessions on this recording (see the module docstring)."""
    may_replay(service, user, annotator_id)
    if not user.is_expert and not teaching_recording(service, recording_id, mode, context_id):
        raise ApiError(403, "forbidden", NOT_FOR_TEACHING)


def _when(started_at: Any, offset_s: Any) -> str | None:
    try:
        return (datetime.fromisoformat(str(started_at)) + timedelta(seconds=float(offset_s or 0.0))).isoformat(
            timespec="milliseconds")
    except (TypeError, ValueError):
        return None


def segments_of(service: StudyService, annotator_id: str, recording_id: str, mode: str = "standard",
                context_id: str = "") -> list[dict[str, Any]]:
    """The segments of one person's sessions on a recording (in one mode and context), oldest first, each with the
    attempt it saved (or None)."""
    store = service.store
    visits = sorted(store.visit_records(annotator_id, limit=MAX_VISITS), key=lambda v: str(v.get("started_at") or ""))
    out: list[dict[str, Any]] = []
    for v in visits:
        for row in store.visit_index(v["visit_id"]):
            if row.get("recording_id") != recording_id or (row.get("mode") or "standard") != mode:
                continue
            if mode != "standard" and str(row.get("context_id") or "") != context_id:
                continue
            last = row.get("last_seq")
            out.append({"visit_id": v["visit_id"], "window_no": row.get("window_no"),
                        "session_id": str(row.get("session_id") or ""),
                        "started_at": _when(v.get("started_at"), row.get("opened_t")),
                        "ended_at": _when(v.get("started_at"), row.get("ended_t")) if row.get("ended_t") is not None
                        else None,
                        "outcome": OUTCOMES.get(str(row.get("outcome") or ""), "not_finished"),
                        "attempt": None, "first_seq": int(row.get("first_seq") or 0),
                        "last_seq": int(last) if last is not None else None,
                        "n_events": (int(last) if last is not None else int(v.get("n_events") or 0))
                        - int(row.get("first_seq") or 0) + 1})
    entries = sorted((e for e in store.completion_entries(annotator_id) if e.get("recording_id") == recording_id
                      and e.get("mode", "standard") == mode and e.get("status") == "completed"
                      and (mode == "standard" or e.get("context", "") == context_id)), key=attempt_of)
    by_session = {str(e.get("session_id") or ""): attempt_of(e) for e in entries if e.get("session_id")}
    claimed: set[int] = set()
    for s in out:
        if s["outcome"] == "finished" and s["session_id"] in by_session:
            s["attempt"] = by_session[s["session_id"]]
            claimed.add(s["attempt"])
    free = [attempt_of(e) for e in entries if attempt_of(e) not in claimed]
    for s in out:  # logs from before the browser sent its session's ID with the save: in order
        if s["outcome"] == "finished" and s["attempt"] is None and free:
            s["attempt"] = free.pop(0)
    return out


def _has_snapshot(service: StudyService, seg: dict[str, Any]) -> bool:
    try:
        page = service.store.visit_log(seg["visit_id"], from_seq=seg["first_seq"], limit=6)
    except StoreError:
        return False
    return any(e.get("type") == "annotations_snapshot" for e in page["events"])


def _strip(seg: dict[str, Any]) -> dict[str, Any]:
    return {k: seg[k] for k in ("visit_id", "window_no", "session_id", "started_at", "ended_at", "outcome", "attempt",
                                "n_events", "first_seq", "last_seq")}


def _training_entries(service: StudyService, aid: str, rid: str, mode: str, ctx: str) -> list[dict[str, Any]]:
    return sorted((e for e in service.store.completion_entries(aid) if e.get("recording_id") == rid
                   and e.get("mode", "standard") == mode and e.get("context", "") == ctx
                   and e.get("status") == "completed"), key=attempt_of)


def _saved_training(service: StudyService, aid: str, rid: str, mode: str, ctx: str,
                    attempt: int | None) -> dict[str, Any] | None:
    """The saved version of a training recording to compare the end of a replay with (the latest, or ``attempt``)."""
    from electrotag.web.corrections import _document, wire_annotations

    entries = _training_entries(service, aid, rid, mode, ctx)
    entry = next((e for e in entries if attempt_of(e) == attempt), None) if attempt is not None else (
        latest_entry(entries) if entries else None)
    if entry is None:
        return None
    doc, raw = _document(service.store.saved_files(aid, rid, mode, ctx, attempt_of(entry)))
    if raw is None:
        return None
    return {"attempt": attempt_of(entry), "saved_at": entry.get("completed_at") or None,
            "annotations": wire_annotations(doc)}


@expert_op("replay_index_get", open_to_all=True)
def replay_index_get(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """The segments of one person's sessions on a recording, with what the replay needs to show them."""
    from electrotag.web.admin import _aid, _rid
    from electrotag.web.corrections import saved_attempt

    aid = _aid(body.get("annotator_id"))
    rid = _rid(body.get("recording_id"))
    mode = body.get("mode") or "standard"
    if mode not in MODES:
        raise _bad(f"mode must be one of {', '.join(MODES)}")
    ctx = str(body.get("context_id") or "") if mode != "standard" else ""
    may_watch(service, user, aid, rid, mode, ctx)
    scope = service.scope_for(mode, ctx)
    m = service.store.manifest(scope, rid)
    if m is None:
        raise ApiError(404, "unknown_recording", f"{rid} is not a registered recording of this study")
    segs = segments_of(service, aid, rid, mode, ctx)
    for s in segs:
        s["has_snapshot"] = _has_snapshot(service, s)
    attempt = body.get("attempt")
    if attempt is not None and (isinstance(attempt, bool) or not isinstance(attempt, int)):
        raise _bad("attempt must be the version to compare with (a whole number)")
    saved = None
    if mode == "standard":
        try:
            entry, annotations, _raw = saved_attempt(service, aid, rid, attempt)
            saved = {"attempt": attempt_of(entry), "saved_at": entry.get("completed_at") or None,
                     "annotations": annotations}
        except ApiError:
            saved = None
    else:
        saved = _saved_training(service, aid, rid, mode, ctx, attempt)
    rec = service.store.user_record(aid) or {}
    return {"logging": bool(service.settings.logging_interactions), "annotator_id": aid,
            "display_name": str(rec.get("display_name") or ""), "recording_id": rid, "mode": mode, "context_id": ctx,
            "file_name": m.get("file_name", ""), "manifest": service.public_manifest(m),
            "segments": [{**_strip(s), "has_snapshot": s["has_snapshot"]} for s in segs], "saved": saved}


@expert_op("replay_events_get", open_to_all=True)
def replay_events_get(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """One page of a segment's events (or of a whole visit's, without ``window_no``), in order."""
    import re

    vid = body.get("visit_id")
    if not isinstance(vid, str) or not re.fullmatch(r"[0-9a-f]{32}", vid):
        raise _bad("visit_id is missing or not valid")
    v = service.store.visit(vid)
    if v is None:
        raise ApiError(404, "unknown_visit", "This visit's log was not found")
    may_replay(service, user, str(v["annotator_id"]))
    window = body.get("window_no")
    if window is not None and (isinstance(window, bool) or not isinstance(window, int)):
        raise _bad("window_no must be a whole number")
    if not user.is_expert:  # a trainee: one segment, on a teaching recording (the module docstring)
        row = next((r for r in service.store.visit_index(vid) if r.get("window_no") == window), None) \
            if window is not None else None
        if row is None or not teaching_recording(service, str(row.get("recording_id") or ""),
                                                 str(row.get("mode") or "standard"), str(row.get("context_id") or "")):
            raise ApiError(403, "forbidden", NOT_FOR_TEACHING)
    start = body.get("from_seq", 0)
    limit = body.get("limit", 4000)
    for value, what in ((start, "from_seq"), (limit, "limit")):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise _bad(f"{what} must be a whole number")
    limit = max(1, min(int(limit), MAX_PAGE))
    pointer = body.get("pointer", True)
    if not isinstance(pointer, bool):
        raise _bad("pointer must be true or false")
    first, last = 0, None
    if window is not None:
        row = next((r for r in service.store.visit_index(vid) if r.get("window_no") == window), None)
        if row is None:
            raise ApiError(404, "unknown_segment", "This part of the visit's log was not found")
        first = int(row.get("first_seq") or 0)
        last = row.get("last_seq")
    page = service.store.visit_log(vid, from_seq=max(int(start), first), limit=limit)
    events = page["events"]
    nxt = page["next_seq"]
    if last is not None:
        events = [e for e in events if int(e.get("seq") or 0) <= int(last)]
        if nxt is not None and nxt > int(last):
            nxt = None
    if window is not None:
        events = [e for e in events if e.get("window_no") == window]
    if not pointer:
        events = [e for e in events if e.get("type") != "pointer"]
    head = page.get("header") or {}
    return {"header": {"started_at": head.get("started_at"), "logging": head.get("logging"),
                       "screens": head.get("screens") or []},
            "events": events, "next_seq": nxt}


@expert_op("teaching_list", open_to_all=True)
def teaching_list(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """What a trainee may watch: the sessions of the experts who agree to their sessions being used for teaching,
    on teaching recordings only (:func:`teaching_recording`), the latest saved version of each, with a session in
    the log to replay."""
    r = service.settings.replay
    shown = bool(r.enabled and r.trainees_watch_experts)
    out: list[dict[str, Any]] = []
    if shown:
        allowed: dict[tuple[str, str, str], bool] = {}

        def teaching(rid: str, mode: str, ctx: str) -> bool:
            key = (rid, mode, ctx)
            if key not in allowed:
                allowed[key] = teaching_recording(service, rid, mode, ctx)
            return allowed[key]

        for u in service.store.user_records():
            aid = u["annotator_id"]
            if aid == user.annotator_id or not _is_expert_account(service, aid):
                continue
            if not consent_of(service, aid)["teaching"]:
                continue
            finished: set[tuple[str, str, str]] = set()
            for v in service.store.visit_records(aid, limit=MAX_VISITS):
                for row in service.store.visit_index(v["visit_id"]):
                    key = (str(row.get("recording_id")), str(row.get("mode") or "standard"),
                           str(row.get("context_id") or ""))
                    if row.get("outcome") == "finished" and teaching(*key):
                        finished.add(key)
            for rid, mode, ctx in sorted(finished):
                entries = _training_entries(service, aid, rid, mode, ctx)
                if not entries:
                    continue
                e = latest_entry(entries)
                m = service.store.manifest(set_scope(ctx), rid)
                if m is None:
                    continue
                out.append({"annotator_id": aid, "display_name": u.get("display_name", ""), "recording_id": rid,
                            "file_name": m.get("file_name", ""), "mode": mode, "context_id": ctx,
                            "attempt": attempt_of(e), "saved_at": e.get("completed_at") or None,
                            "n_annotations": _int(e.get("n_annotations"))})
    out.sort(key=lambda i: (i["annotator_id"], i["file_name"], i["mode"]))
    return {"shown": shown, "sessions": out}


def _int(value: Any) -> int | None:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


__all__ = ["MAX_PAGE", "NOT_FOR_TEACHING", "may_replay", "may_watch", "segments_of", "teaching_recording"]
