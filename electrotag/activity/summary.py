"""Tidy tables from interaction logs: one row per visit, and one per annotator × recording × visit.

Every column is described in :data:`VISIT_COLUMNS` and :data:`RECORDING_COLUMNS` (also written next
to the tables and in docs/activity_logs.md).

Active time
    The time between two inputs (mouse, wheel, keys, pointer movement over the EEG) counts in full
    up to ``idle_after_s`` (from the log's header, 30 s by default); a longer gap counts only its
    first ``idle_after_s`` seconds. Time while ElectroTag was not the active application does not
    count. The opening and the closing of the recording count as inputs, so a recording's active
    time is never longer than its wall-clock time.

Ratings and notes of the annotations saved
    The annotations are followed through a recording's events (each change carries the annotations
    it touched, with their ``confidence`` and ``note_length``), so the ratings and notes of the
    annotations at the end are known. Annotations restored at opening (a draft continued, or the
    version a revision starts from) are taken from the annotator's previous row for the same
    recording and mode when that row ended with the same number of annotations; otherwise the
    columns are left empty. The text of a note is never in the log, and only its length is used.
"""

from __future__ import annotations

import json
import math
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from electrotag.activity.logs import VisitLog

#: Events that show the annotator was doing something.
INPUT_EVENTS = frozenset({"mouse_press", "mouse_release", "double_click", "wheel", "key", "shortcut", "pointer",
                          "field_edited"})
INACTIVE_STATES = frozenset({"inactive", "hidden", "suspended"})
TRAINING_PREFIXES = ("guided_", "practice_", "assessment_", "training_", "stage_")
#: Events that change annotations; each carries the annotations it touched.
ANNOTATION_CHANGES = frozenset({"annotation_created", "annotation_deleted", "annotation_edited",
                                "annotation_relabelled", "annotation_channels_changed", "confidence_set", "note_set",
                                "undo", "redo", "annotations_merged", "annotations_reset"})

VISIT_COLUMNS: list[tuple[str, str]] = [
    ("visit_id", "Identifier of the visit (one log file: in the browser, from signing in until signing out "
                 "or closing the page)."),
    ("annotator_id", "The annotator's ID."),
    ("mode", "standard, practice, assessment (or a training mode)."),
    ("context_id", "Reference set of a training visit (empty for standard annotation)."),
    ("file", "The log file."),
    ("started_at", "Local date and time the visit started, with its UTC offset."),
    ("ended", "How the visit ended: sign_out or page_closed in the browser (back_to_start, quit, exit or "
              "new_visit in logs of the desktop application), or 'not closed' when the log stopped unexpectedly."),
    ("wall_s", "Seconds from the start of the visit to its last event."),
    ("active_s", "Active seconds in the visit (see 'Active time')."),
    ("recordings_opened", "Recordings opened for annotation."),
    ("recordings_finished", "Recordings saved with Save and Finish."),
    ("recordings_closed_without_saving", "Recordings closed without saving."),
    ("annotations_saved", "Annotations in the recordings saved during the visit."),
    ("clicks", "Mouse button presses anywhere in ElectroTag."),
    ("key_presses", "Key presses (not counting held-down repeats or keys typed into text fields)."),
    ("shortcuts", "Keyboard shortcuts used (for example 1 to 9, M, N, Delete, Ctrl+Z)."),
    ("ratings_given", "Confidence ratings from 1 to 5 given to annotations (a mark rated again counts again)."),
    ("notes_written", "Notes added to annotations or changed (a count: the text of a note is never logged)."),
    ("problems_reported", "Problems reported with recordings, from the list of recordings or the annotation view."),
    ("feedback_views", "Times the feedback on reviewed work was shown, read only or beside a revision."),
    ("events", "Events in the log."),
    ("bad_lines", "Lines that could not be read (usually the last line after a crash)."),
    ("electrotag_version", "ElectroTag version."),
    ("os", "Operating system."),
    ("screen", "Size of the primary screen in pixels (width x height)."),
    ("device_pixel_ratio", "Pixel ratio of the primary screen (2 on most high-resolution screens)."),
]

RECORDING_COLUMNS: list[tuple[str, str]] = [
    ("annotator_id", "The annotator's ID."),
    ("visit_id", "The visit (see visits.tsv)."),
    ("mode", "standard, guided, practice or assessment: the recording's own mode (in the training programme "
             "one visit has recordings of several modes)."),
    ("context_id", "Reference set of training work (empty for standard annotation)."),
    ("recording", "Recording ID (path relative to the dataset); 'quiz' for the short-segment quiz."),
    ("segment", "recording (a recording opened for annotation), review (a practice recording reviewed against "
                "the reference), feedback (the annotator reading the reviews of their saved work, read only), "
                "quiz, or training (training events outside a recording)."),
    ("window_no", "Number of the recording opened within the visit (1, 2, ...)."),
    ("order", "Position among all of this annotator's rows, in the order they were started (1 = first)."),
    ("order_in_mode", "The same, counting only rows of the same mode."),
    ("started_at", "Local date and time the recording opened, with its UTC offset."),
    ("outcome", "finished (Save and Finish; for a review or feedback row, closed), closed_without_saving, or "
                "not_finished (the log ended first)."),
    ("resumed", "True if unfinished work from an earlier visit was restored."),
    ("recording_duration_s", "Length of the recording in seconds."),
    ("n_channels_shown", "Channels shown in the viewer."),
    ("wall_s", "Seconds from opening the recording to finishing or closing it."),
    ("active_s", "Active seconds (see 'Active time')."),
    ("inactive_s", "Seconds while ElectroTag was not the active application."),
    ("idle_s", "Seconds without input beyond the idle threshold (wall_s minus active_s and inactive_s)."),
    ("idle_periods", "Number of idle periods logged."),
    ("clicks", "Mouse button presses."),
    ("eeg_clicks", "Mouse button presses on the EEG traces."),
    ("double_clicks", "Double-clicks."),
    ("wheel_turns", "Mouse wheel or trackpad scroll events."),
    ("key_presses", "Key presses (not counting held-down repeats or keys typed into text fields)."),
    ("key_repeats", "Repeats while a key was held down."),
    ("shortcuts", "Keyboard shortcuts used."),
    ("shortcuts_by_name", "Each shortcut used and how often (JSON)."),
    ("keys_by_name", "Each key pressed (outside shortcuts and text fields) and how often (JSON)."),
    ("annotations_created", "Annotations created (by dragging, keys or otherwise)."),
    ("created_by_drag", "Annotations created by dragging across the EEG."),
    ("created_by_keys", "Annotations created with the M, [ and ] keys."),
    ("annotations_deleted", "Annotations deleted."),
    ("annotations_edited", "Changes of start, end or channels."),
    ("annotations_relabelled", "Changes of artifact type."),
    ("annotations_merged", "Merges (by the Merge button or automatically when same-type annotations overlapped)."),
    ("undos", "Undo steps."),
    ("redos", "Redo steps."),
    ("final_annotations", "Annotations when the recording was saved (or when it was closed)."),
    ("time_to_first_annotation_s", "Seconds from the viewer being ready to the first annotation."),
    ("seconds_per_annotation", "active_s divided by final_annotations (empty when there are none)."),
    ("annotations_per_active_minute", "annotations_created per active minute."),
    ("share_seen", "Proportion of the recording's time that was on screen at some point (0 to 1)."),
    ("share_channels_seen", "Proportion of the channels that were on screen at some point (0 to 1)."),
    ("screens_viewed", "Number of different views (after scrolling, zooming or scaling settled)."),
    ("mean_dwell_s", "active_s divided by screens_viewed."),
    ("scale_changes", "Changes of the amplitude scale."),
    ("pointer_samples", "Pointer positions sampled over the EEG."),
    ("pointer_distance_px", "Distance the pointer travelled over the EEG, in screen pixels."),
    ("dialogs", "Dialogs shown (questions, channel chooser, type picker and so on)."),
    ("status_messages", "Messages shown in the status line."),
    ("ratings_given", "Confidence ratings from 1 to 5 given to annotations (a mark rated again counts again)."),
    ("ratings_cleared", "Confidence ratings cleared."),
    ("annotations_rated", "Annotations with a confidence rating among final_annotations (empty when the log does "
                          "not show the ratings of annotations restored at opening)."),
    ("share_rated", "annotations_rated divided by final_annotations (0 to 1)."),
    ("confidence_prompts", "Requests for a rating (after D, after a new mark in an every-mark study, or with "
                           "Rate them before Save and Finish)."),
    ("confidence_prompts_by_outcome", "How the requests for a rating ended (rated, cleared, cancelled, later, "
                                      "other_input, replaced, deleted, and timeout in older logs) and how often "
                                      "(JSON)."),
    ("confidence_checks", "Times Save and Finish found marks without a rating in an every-mark study."),
    ("confidence_check_choices", "The choices at those checks (rate, save, cancel) and how often (JSON)."),
    ("notes_written", "Notes added to annotations or changed (a count: the text of a note is never logged)."),
    ("notes_removed", "Notes removed."),
    ("annotations_with_note", "Annotations with a note among final_annotations (empty as for annotations_rated)."),
    ("problems_reported", "Problems reported with the recording from the annotation view."),
    ("set_aside", "True if a problem report set the recording aside as one that cannot be annotated."),
    ("reviews_received", "Reviews of the recording shown to the annotator (in the feedback view, or beside a "
                         "revision)."),
    ("feedback_items", "Items of feedback shown (reviewed annotations and stretches without one)."),
    ("feedback_items_opened", "Items of feedback the annotator went to."),
    ("guided_steps", "Guided training: steps completed."),
    ("guided_attempts", "Guided training: attempts at the steps."),
    ("guided_show_me", "Guided training: times the expert's answer was shown."),
    ("guided_stars_mean", "Guided training: mean stars per completed step."),
    ("guided_seconds_per_step", "Guided training: mean seconds per completed step."),
    ("practice_score", "Practice: the score against the reference (event F1 when given)."),
    ("practice_passed", "Practice: True if the recording reached the reference set's pass mark (empty otherwise)."),
    ("quiz_items", "Quiz: items answered."),
    ("quiz_correct", "Quiz: correct answers."),
    ("quiz_proportion_correct", "Quiz: proportion correct."),
    ("quiz_mean_response_s", "Quiz: mean seconds from showing a segment to answering."),
    ("score", "practice_score if there is one, otherwise quiz_proportion_correct."),
]


# ------------------------------------------------------------------ helpers
def _nan() -> float:
    return float("nan")


def _num(value: Any) -> float:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return _nan()
    return f


def _parse_time(text: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(text))
    except (TypeError, ValueError):
        return None


def _merge(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for a, b in sorted(intervals):
        if b <= a:
            continue
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def _overlap(a: float, b: float, intervals: list[tuple[float, float]]) -> float:
    return sum(max(0.0, min(b, y) - max(a, x)) for x, y in intervals)


def inactive_intervals(events: list[dict[str, Any]], end: float) -> list[tuple[float, float]]:
    """Periods while ElectroTag was not the active application (from ``app_state`` events)."""
    out = []
    since: float | None = None
    for e in events:
        if e.get("type") != "app_state":
            continue
        t = _num(e.get("t"))
        if e.get("state") in INACTIVE_STATES:
            if since is None:
                since = t
        elif since is not None:
            out.append((since, t))
            since = None
    if since is not None:
        out.append((since, end))
    return _merge(out)


def active_seconds(times: Iterable[float], start: float, end: float, idle_after: float,
                   inactive: list[tuple[float, float]] = ()) -> float:
    """Active time between ``start`` and ``end`` given the times of inputs (see the module's notes)."""
    if end <= start:
        return 0.0
    pts = sorted({start, end, *(t for t in times if start <= t <= end)})
    total = 0.0
    for a, b in zip(pts, pts[1:]):
        stop = a + min(b - a, idle_after)
        total += (stop - a) - _overlap(a, stop, list(inactive))
    return max(0.0, total)


def _union_length(intervals: list[tuple[float, float]]) -> float:
    return sum(b - a for a, b in _merge(intervals))


# ----------------------------------------------------------------- segments
@dataclass
class Segment:
    visit: VisitLog
    kind: str  # recording, quiz, training
    recording: str
    window_no: int | None
    events: list[dict[str, Any]] = field(default_factory=list)


def _is_rating(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 1 <= value <= 5


def _most(events: list[dict[str, Any]], key: str) -> int:
    """The largest whole number in ``key`` of the events (0 for none)."""
    values = [_num(e.get(key)) for e in events]
    return max((int(x) for x in values if not math.isnan(x)), default=0)


def _length(item: dict[str, Any]) -> int:
    x = _num(item.get("note_length"))
    return 0 if math.isnan(x) else int(x)


def _ann_id(item: Any) -> str | None:
    if isinstance(item, dict):
        return str(item["id"]) if item.get("id") is not None else None
    return str(item) if item is not None else None


def replay_annotations(start: dict[str, dict[str, Any]],
                       events: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]] | None:
    """The annotations after ``events`` (id -> ``confidence`` and ``note_length``), from ``start``.

    None when an event does not say which annotations it touched, so the result cannot be known."""
    state = {k: dict(v) for k, v in start.items()}
    for e in events:
        kind = e.get("type")
        if kind not in ANNOTATION_CHANGES:
            continue
        if kind in ("confidence_set", "note_set"):
            items = e.get("annotations")
            if not isinstance(items, list):
                return None
            for a in items:
                aid = _ann_id(a) if isinstance(a, dict) else None
                if aid is None:
                    return None
                cur = state.setdefault(aid, {"confidence": None, "note_length": 0})
                if kind == "confidence_set":
                    cur["confidence"] = a.get("confidence")
                else:
                    cur["note_length"] = _length(a)
            continue
        if kind in ("undo", "redo", "annotations_merged", "annotations_reset"):
            lists = [e.get(k) for k in ("removed", "added", "changed")]
            if not all(isinstance(x, list) for x in lists):
                return None
            removed, put = lists[0], lists[1] + lists[2]
        elif kind == "annotation_deleted":
            removed, put = e.get("annotations"), []
        else:
            removed, put = e.get("merged_away") or [], e.get("annotations")
        if not isinstance(removed, list) or not isinstance(put, list):
            return None
        for a in removed:
            state.pop(_ann_id(a) or "", None)
        for a in put:
            aid = _ann_id(a)
            if aid is None:
                return None
            if not isinstance(a, dict):
                return None
            state[aid] = {"confidence": a.get("confidence"), "note_length": _length(a)}
    return state


def segments(visit: VisitLog) -> list[Segment]:
    """Split a visit into the recordings opened (by ``window_no``), plus quiz and other training events."""
    by_window: dict[int, Segment] = {}
    order: list[Segment] = []
    quiz: Segment | None = None
    training: Segment | None = None
    latest_for: dict[str, Segment] = {}
    for e in visit.events:
        w = e.get("window_no")
        kind = str(e.get("type", ""))
        if isinstance(w, int):
            seg = by_window.get(w)
            if seg is None:
                seg = Segment(visit, "recording", str(e.get("recording", "")), w)
                by_window[w] = seg
                order.append(seg)
            seg.events.append(e)
            latest_for[seg.recording] = seg
            if kind == "practice_review_opened":
                seg.kind = "review"
            elif kind == "recording_opened" and e.get("segment") == "feedback":
                seg.kind = "feedback"
        elif kind.startswith("quiz_"):
            if quiz is None:
                quiz = Segment(visit, "quiz", "quiz", None)
                order.append(quiz)
            quiz.events.append(e)
        elif kind.startswith(TRAINING_PREFIXES):
            rid = str(e.get("recording") or e.get("recording_id") or "")
            if rid in latest_for:
                latest_for[rid].events.append(e)
            else:
                if training is None:
                    training = Segment(visit, "training", rid or "training", None)
                    order.append(training)
                training.events.append(e)
    for seg in order:
        seg.events.sort(key=lambda e: (_num(e.get("t")), int(e.get("seq", 0))))
    return order


def _first(events: list[dict[str, Any]], kind: str) -> dict[str, Any] | None:
    return next((e for e in events if e.get("type") == kind), None)


def _last(events: list[dict[str, Any]], kind: str) -> dict[str, Any] | None:
    return next((e for e in reversed(events) if e.get("type") == kind), None)


def segment_row(seg: Segment) -> dict[str, Any]:
    v, ev = seg.visit, seg.events
    h = v.header
    idle = v.idle_after_s
    opened = _first(ev, "recording_opened") or {}
    ready = _first(ev, "viewer_ready")
    finished = _last(ev, "recording_finished")
    closed = _last(ev, "closed_without_saving") or _last(ev, "practice_review_closed") or _last(ev, "feedback_closed")
    t0 = _num(ev[0].get("t")) if ev else 0.0
    end_event = finished or closed
    t_end = _num(end_event.get("t")) if end_event else (_num(ev[-1].get("t")) if ev else t0)
    if seg.kind in ("recording", "review", "feedback") and opened:
        t0 = _num(opened.get("t"))
    wall = max(0.0, t_end - t0)
    inactive = [(max(a, t0), min(b, t_end)) for a, b in inactive_intervals(v.events, t_end) if b > t0 and a < t_end]
    inputs = [_num(e.get("t")) for e in ev if e.get("type") in INPUT_EVENTS]
    active = active_seconds(inputs, t0, t_end, idle, inactive)
    inactive_s = _union_length(inactive)
    kinds = Counter(str(e.get("type")) for e in ev)
    keys = [e for e in ev if e.get("type") == "key"]
    shortcuts = Counter(str(e.get("action", "")) for e in ev if e.get("type") == "shortcut")
    created = [e for e in ev if e.get("type") == "annotation_created"]
    merged = kinds["annotations_merged"] + sum(1 for e in created if e.get("auto_merged"))
    totals = [e.get("n_total") for e in ev if isinstance(e.get("n_total"), int)]
    if finished is not None and isinstance(finished.get("n_annotations"), int):
        final = int(finished["n_annotations"])
    elif closed is not None and isinstance(closed.get("n_annotations"), int):
        final = int(closed["n_annotations"])
    elif totals:
        final = int(totals[-1])
    else:
        final = int(opened.get("annotations_restored", 0) or 0) if opened else 0
    start_ref = _num(ready.get("t")) if ready else t0
    first_created = _num(created[0].get("t")) - start_ref if created else _nan()
    views = [e for e in ev if e.get("type") == "view"]
    duration = _num(opened.get("duration_s")) if opened else _nan()
    n_ch = int(opened.get("n_channels_shown", 0) or 0) if opened else 0
    seen = [(_num(e.get("t_start")), _num(e.get("t_start")) + _num(e.get("duration"))) for e in views]
    if not math.isnan(duration) and duration > 0 and seen:
        share_seen = min(1.0, _union_length([(max(0.0, a), min(duration, b)) for a, b in seen]) / duration)
    else:
        share_seen = _nan()
    ch_seen = [(int(e.get("ch_start", 0)), int(e.get("ch_start", 0)) + int(e.get("n_channels", 0))) for e in views]
    share_ch = min(1.0, _union_length([(a, min(n_ch, b)) for a, b in ch_seen]) / n_ch) if n_ch and ch_seen else _nan()
    scales = [e.get("scale_factor") for e in views]
    scale_changes = sum(1 for a, b in zip(scales, scales[1:]) if a != b)
    completed_steps = [e for e in ev if e.get("type") == "guided_step_completed"]
    attempts = [_num(e.get("attempts")) for e in completed_steps if e.get("attempts") is not None]
    stars = [_num(e.get("stars")) for e in completed_steps if e.get("stars") is not None]
    step_secs = [_num(e.get("seconds", e.get("duration_s", e.get("elapsed_s")))) for e in completed_steps
                 if any(k in e for k in ("seconds", "duration_s", "elapsed_s"))]
    # Each press of Show me is a guided_show_me event; the steps' used_show_me only stands in when those are absent.
    show_me = kinds["guided_show_me"] or sum(
        1 for e in completed_steps if e.get("used_show_me") or e.get("show_me") or e.get("shown"))
    practice = _last(ev, "practice_scored") if seg.kind != "review" else None
    practice_score = _nan()
    practice_passed: Any = ""
    if practice is not None:
        for k in ("event_f1", "f1", "score"):
            if practice.get(k) is not None:
                practice_score = _num(practice[k])
                break
        if isinstance(practice.get("passed"), bool):
            practice_passed = practice["passed"]
    answers = [e for e in ev if e.get("type") == "quiz_answer"]
    quiz_correct = sum(1 for e in answers if e.get("correct"))
    rts = [_num(e.get("response_time_s")) for e in answers if e.get("response_time_s") is not None]
    quiz_prop = quiz_correct / len(answers) if answers else _nan()
    outcome = "finished" if finished else ("closed_without_saving" if closed else "not_finished")
    ratings = [a.get("confidence") for e in ev if e.get("type") == "confidence_set"
               for a in (e.get("annotations") or []) if isinstance(a, dict)]
    prompts = Counter(str(e.get("outcome", "")) for e in ev if e.get("type") == "confidence_prompt")
    checks = Counter(str(e.get("choice", "")) for e in ev if e.get("type") == "confidence_check")
    note_changes = Counter(str(a.get("change", "")) for e in ev if e.get("type") == "note_set"
                           for a in (e.get("annotations") or []) if isinstance(a, dict))
    problems = [e for e in ev if e.get("type") == "problem_reported"]
    shown = [e for e in ev if e.get("type") == "feedback_shown"]
    revision = _first(ev, "revision_started")
    if revision is not None and isinstance(revision.get("annotations_loaded"), int):
        start_n = int(revision["annotations_loaded"])
    else:
        start_n = int(opened.get("annotations_restored", 0) or 0) if opened else 0
    if seg.kind in ("review", "feedback"):
        outcome = "finished" if closed else "not_finished"
    elif seg.kind != "recording":
        outcome = "finished" if (_last(ev, "quiz_finished") or (seg.kind == "training" and ev)) else "not_finished"
    row: dict[str, Any] = {
        "annotator_id": v.annotator_id,
        "visit_id": v.visit_id,
        "mode": opened.get("mode") or h.get("mode", ""),
        "context_id": h.get("context_id", ""),
        "recording": seg.recording,
        "segment": seg.kind,
        "window_no": seg.window_no if seg.window_no is not None else "",
        "started_at": ev[0].get("wall", "") if ev else "",
        "outcome": outcome,
        "resumed": bool(opened.get("resumed")) if opened else False,
        "recording_duration_s": duration,
        "n_channels_shown": n_ch or "",
        "wall_s": wall,
        "active_s": active,
        "inactive_s": inactive_s,
        "idle_s": max(0.0, wall - active - inactive_s),
        "idle_periods": kinds["idle_start"],
        "clicks": kinds["mouse_press"],
        "eeg_clicks": sum(1 for e in ev if e.get("type") == "mouse_press" and e.get("area") == "eeg"),
        "double_clicks": kinds["double_click"],
        "wheel_turns": kinds["wheel"],
        "key_presses": sum(1 for e in keys if not e.get("auto_repeat")),
        "key_repeats": sum(1 for e in keys if e.get("auto_repeat")),
        "shortcuts": sum(shortcuts.values()),
        "shortcuts_by_name": json.dumps(dict(shortcuts.most_common()), ensure_ascii=False),
        "keys_by_name": json.dumps(dict(Counter(str(e.get("key")) for e in keys if not e.get("auto_repeat"))
                                        .most_common()), ensure_ascii=False),
        "annotations_created": len(created),
        "created_by_drag": sum(1 for e in created if str(e.get("via", "")).startswith("eeg_")),
        "created_by_keys": sum(1 for e in created if str(e.get("via", "")).startswith("shortcut:Mark")),
        "annotations_deleted": kinds["annotation_deleted"],
        "annotations_edited": kinds["annotation_edited"] + kinds["annotation_channels_changed"],
        "annotations_relabelled": kinds["annotation_relabelled"],
        "annotations_merged": merged,
        "undos": kinds["undo"],
        "redos": kinds["redo"],
        "final_annotations": final if seg.kind == "recording" else "",
        "time_to_first_annotation_s": first_created,
        "seconds_per_annotation": active / final if seg.kind == "recording" and final > 0 else _nan(),
        "annotations_per_active_minute": len(created) / (active / 60.0) if active > 0 and seg.kind == "recording"
        else _nan(),
        "share_seen": share_seen,
        "share_channels_seen": share_ch,
        "screens_viewed": len(views),
        "mean_dwell_s": active / len(views) if views else _nan(),
        "scale_changes": scale_changes,
        "pointer_samples": kinds["pointer"],
        "pointer_distance_px": sum(_num(e.get("dist_px")) for e in ev if e.get("type") == "pointer"
                                   and e.get("dist_px") is not None),
        "dialogs": kinds["dialog_shown"],
        "status_messages": kinds["status_message"],
        "ratings_given": sum(1 for c in ratings if _is_rating(c)),
        "ratings_cleared": sum(1 for c in ratings if c is None),
        "annotations_rated": "",  # from the annotations followed through the rows (summarise)
        "share_rated": _nan(),
        "confidence_prompts": sum(prompts.values()),
        "confidence_prompts_by_outcome": json.dumps(dict(prompts.most_common()), ensure_ascii=False),
        "confidence_checks": sum(checks.values()),
        "confidence_check_choices": json.dumps(dict(checks.most_common()), ensure_ascii=False),
        "notes_written": note_changes["added"] + note_changes["changed"],
        "notes_removed": note_changes["removed"],
        "annotations_with_note": "",
        "problems_reported": len(problems),
        "set_aside": any(e.get("outcome") == "unusable" for e in problems),
        "reviews_received": _most(shown, "reviews"),
        "feedback_items": _most(shown, "items"),
        "feedback_items_opened": kinds["feedback_item_jumped"],
        "guided_steps": len(completed_steps),
        "guided_attempts": sum(attempts) if attempts else (kinds["guided_check"] or 0),
        "guided_show_me": show_me,
        "guided_stars_mean": sum(stars) / len(stars) if stars else _nan(),
        "guided_seconds_per_step": sum(step_secs) / len(step_secs) if step_secs else _nan(),
        "practice_score": practice_score,
        "practice_passed": practice_passed,
        "quiz_items": len(answers),
        "quiz_correct": quiz_correct,
        "quiz_proportion_correct": quiz_prop,
        "quiz_mean_response_s": sum(rts) / len(rts) if rts else _nan(),
    }
    row["score"] = practice_score if not math.isnan(practice_score) else quiz_prop
    # For following the annotations across rows (summarise); not written to the tables.
    row["_changes"] = [e for e in ev if e.get("type") in ANNOTATION_CHANGES]
    row["_start_n"] = start_n
    return row


def visit_row(v: VisitLog, rows: list[dict[str, Any]]) -> dict[str, Any]:
    ev = v.events
    end = _num(ev[-1].get("t")) if ev else 0.0
    inputs = [_num(e.get("t")) for e in ev if e.get("type") in INPUT_EVENTS]
    kinds = Counter(str(e.get("type")) for e in ev)
    feedback_opened = sum(1 for e in ev if e.get("type") == "recording_opened" and e.get("segment") == "feedback")
    ratings = [a.get("confidence") for e in ev if e.get("type") == "confidence_set"
               for a in (e.get("annotations") or []) if isinstance(a, dict)]
    notes = [a for e in ev if e.get("type") == "note_set" for a in (e.get("annotations") or [])
             if isinstance(a, dict) and a.get("change") in ("added", "changed")]
    screens = v.header.get("screens") or []
    primary = screens[0] if screens else {}
    geo = primary.get("geometry") or []
    return {
        "visit_id": v.visit_id,
        "annotator_id": v.annotator_id,
        "mode": v.header.get("mode", ""),
        "context_id": v.header.get("context_id", ""),
        "file": str(v.path),
        "started_at": v.header.get("started_at", ""),
        "ended": v.close_reason,
        "wall_s": end,
        "active_s": active_seconds(inputs, 0.0, end, v.idle_after_s, inactive_intervals(ev, end)),
        # practice reviews and the feedback on reviewed work aside
        "recordings_opened": kinds["recording_opened"] - kinds["practice_review_opened"] - feedback_opened,
        "recordings_finished": kinds["recording_finished"],
        "recordings_closed_without_saving": kinds["closed_without_saving"],
        "annotations_saved": sum(int(e.get("n_annotations", 0) or 0) for e in ev if e.get("type") == "recording_finished"),
        "clicks": kinds["mouse_press"],
        "key_presses": sum(1 for e in ev if e.get("type") == "key" and not e.get("auto_repeat")),
        "shortcuts": kinds["shortcut"],
        "ratings_given": sum(1 for c in ratings if _is_rating(c)),
        "notes_written": len(notes),
        "problems_reported": kinds["problem_reported"],
        "feedback_views": kinds["feedback_shown"],
        "events": len(ev),
        "bad_lines": v.bad_lines,
        "electrotag_version": (v.header.get("versions") or {}).get("electrotag", ""),
        "os": v.header.get("os", ""),
        "screen": f"{geo[2]}x{geo[3]}" if len(geo) == 4 else "",
        "device_pixel_ratio": primary.get("device_pixel_ratio", ""),
    }


@dataclass
class ActivityTables:
    visits: list[dict[str, Any]]
    recordings: list[dict[str, Any]]
    events: list[dict[str, Any]]
    warnings: list[str] = field(default_factory=list)


def summarise(visits: list[VisitLog], *, annotators: Iterable[str] | None = None, with_events: bool = False,
              warnings: list[str] | None = None) -> ActivityTables:
    wanted = {a.upper() for a in annotators} if annotators else None
    vrows: list[dict[str, Any]] = []
    rrows: list[dict[str, Any]] = []
    erows: list[dict[str, Any]] = []
    for v in visits:
        if wanted is not None and v.annotator_id.upper() not in wanted:
            continue
        rows = [segment_row(s) for s in segments(v)]
        rrows.extend(rows)
        vrows.append(visit_row(v, rows))
        if with_events:
            for e in v.events:
                rest = {k: x for k, x in e.items() if k not in ("seq", "t", "wall", "type", "recording", "window_no")}
                erows.append({"visit_id": v.visit_id, "annotator_id": v.annotator_id, "seq": e.get("seq"),
                              "t": e.get("t"), "wall": e.get("wall"), "type": e.get("type"),
                              "recording": e.get("recording", ""), "window_no": e.get("window_no", ""),
                              "data": json.dumps(rest, ensure_ascii=False, separators=(",", ":"))})
    # Order of each annotator's rows, across visits, by the time they started.
    def when(r: dict[str, Any]) -> tuple[Any, ...]:
        dt = _parse_time(r["started_at"])
        return (dt.timestamp() if dt is not None else float("inf"), str(r["started_at"]))

    for key in ("order", "order_in_mode"):
        groups: dict[tuple[str, ...], list[dict[str, Any]]] = {}
        for r in rrows:
            g = (r["annotator_id"],) if key == "order" else (r["annotator_id"], r["mode"])
            groups.setdefault(g, []).append(r)
        for rows in groups.values():
            for i, r in enumerate(sorted(rows, key=when), start=1):
                r[key] = i
    _follow_annotations(rrows)
    names = [c for c, _ in RECORDING_COLUMNS]
    rrows = [{c: r.get(c, "") for c in names} for r in sorted(rrows, key=lambda r: (r["annotator_id"], r["order"]))]
    return ActivityTables(visits=vrows, recordings=rrows, events=erows, warnings=list(warnings or []))


def _follow_annotations(rows: list[dict[str, Any]]) -> None:
    """annotations_rated, share_rated and annotations_with_note of each recording row (see the module's notes)."""
    ends: dict[tuple[Any, ...], dict[str, dict[str, Any]] | None] = {}
    for r in sorted(rows, key=lambda r: (r["annotator_id"], r["order"])):
        if r["segment"] != "recording":
            continue
        key = (r["annotator_id"], r["recording"], r["mode"])
        before = ends.get(key)
        if r["_start_n"] == 0:
            start: dict[str, dict[str, Any]] | None = {}
        elif before is not None and len(before) == r["_start_n"]:
            start = before
        else:
            start = None
        state = replay_annotations(start, r["_changes"]) if start is not None else None
        if state is not None and len(state) != r["final_annotations"]:
            state = None  # the log and the count saved disagree: better empty than wrong
        ends[key] = state
        if state is None:
            continue
        rated = sum(1 for a in state.values() if _is_rating(a.get("confidence")))
        r["annotations_rated"] = rated
        r["share_rated"] = rated / len(state) if state else _nan()
        r["annotations_with_note"] = sum(1 for a in state.values() if a.get("note_length"))


# ------------------------------------------------------------------ writing
def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return ""
        return f"{value:.4f}".rstrip("0").rstrip(".") if value != int(value) else str(int(value))
    return str(value).replace("\t", " ").replace("\n", " ")


def write_tsv(path: Any, rows: list[dict[str, Any]], columns: list[str]) -> None:
    from pathlib import Path

    lines = ["\t".join(columns)]
    lines += ["\t".join(_cell(r.get(c)) for c in columns) for r in rows]
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


EVENT_COLUMNS = ["visit_id", "annotator_id", "seq", "t", "wall", "type", "recording", "window_no", "data"]


def columns_text() -> str:
    """What every column means (written next to the tables)."""
    out = ["visits.tsv: one row per visit", ""]
    out += [f"  {c}: {d}" for c, d in VISIT_COLUMNS]
    out += ["", "recordings.tsv: one row per annotator x recording x visit (plus quiz and training rows)", ""]
    out += [f"  {c}: {d}" for c, d in RECORDING_COLUMNS]
    out += ["", "events.tsv (with --events): every event, with its own fields as JSON in 'data'", "",
            "Active time: the time between two inputs counts in full up to the idle threshold of the log",
            "(logging.idle_after_s, 30 s by default); a longer gap counts only that much. Time while",
            "ElectroTag was not the active application does not count. See docs/activity_logs.md."]
    return "\n".join(out) + "\n"
