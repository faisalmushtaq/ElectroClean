"""Tidy tables from interaction logs: one row per visit, and one per annotator × recording × visit.

Every column is described in :data:`VISIT_COLUMNS` and :data:`RECORDING_COLUMNS` (also written next
to the tables and in docs/activity_logs.md).

Active time
    The time between two inputs (mouse, wheel, keys, pointer movement over the EEG) counts in full
    up to ``idle_after_s`` (from the log's header, 30 s by default); a longer gap counts only its
    first ``idle_after_s`` seconds. Time while ElectroClean was not the active application does not
    count. The opening and the closing of the recording count as inputs, so a recording's active
    time is never longer than its wall-clock time.
"""

from __future__ import annotations

import json
import math
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from electroclean.activity.logs import VisitLog

#: Events that show the annotator was doing something.
INPUT_EVENTS = frozenset({"mouse_press", "mouse_release", "double_click", "wheel", "key", "shortcut", "pointer",
                          "field_edited"})
INACTIVE_STATES = frozenset({"inactive", "hidden", "suspended"})
TRAINING_PREFIXES = ("guided_", "practice_", "assessment_", "training_", "stage_")

VISIT_COLUMNS: list[tuple[str, str]] = [
    ("visit_id", "Identifier of the visit (one log file: from Begin until the start window or quitting)."),
    ("annotator_id", "The annotator's ID."),
    ("mode", "standard, practice, assessment (or a training mode)."),
    ("context_id", "Reference set of a training visit (empty for standard annotation)."),
    ("file", "The log file."),
    ("started_at", "Local date and time the visit started, with its UTC offset."),
    ("ended", "How the visit ended: back_to_start, quit, exit, new_visit, or 'not closed' after a crash."),
    ("wall_s", "Seconds from the start of the visit to its last event."),
    ("active_s", "Active seconds in the visit (see 'Active time')."),
    ("recordings_opened", "Recording windows opened."),
    ("recordings_finished", "Recordings saved with Save and Finish."),
    ("recordings_closed_without_saving", "Recording windows closed without saving."),
    ("annotations_saved", "Annotations in the recordings saved during the visit."),
    ("clicks", "Mouse button presses anywhere in ElectroClean."),
    ("key_presses", "Key presses (not counting held-down repeats or keys typed into text fields)."),
    ("shortcuts", "Keyboard shortcuts used (for example 1 to 9, M, N, Delete, Ctrl+Z)."),
    ("events", "Events in the log."),
    ("bad_lines", "Lines that could not be read (usually the last line after a crash)."),
    ("electroclean_version", "ElectroClean version."),
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
    ("segment", "recording (an annotation window), review (a practice recording reviewed against the reference), "
                "quiz, or training (training events outside a window)."),
    ("window_no", "Number of the annotation window within the visit (1, 2, ...)."),
    ("order", "Position among all of this annotator's rows, in the order they were started (1 = first)."),
    ("order_in_mode", "The same, counting only rows of the same mode."),
    ("started_at", "Local date and time the window opened, with its UTC offset."),
    ("outcome", "finished (Save and Finish), closed_without_saving, or not_finished (the log ended first)."),
    ("resumed", "True if unfinished work from an earlier visit was restored."),
    ("recording_duration_s", "Length of the recording in seconds."),
    ("n_channels_shown", "Channels shown in the viewer."),
    ("wall_s", "Seconds from opening the window to finishing or closing it."),
    ("active_s", "Active seconds (see 'Active time')."),
    ("inactive_s", "Seconds while ElectroClean was not the active application."),
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
    ("final_annotations", "Annotations when the recording was saved (or when the window closed)."),
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
    ("status_messages", "Messages shown in the status bar."),
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
    """Periods while ElectroClean was not the active application (from ``app_state`` events)."""
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


def segments(visit: VisitLog) -> list[Segment]:
    """Split a visit into annotation windows (by ``window_no``), plus quiz and other training events."""
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
    closed = _last(ev, "closed_without_saving") or _last(ev, "practice_review_closed")
    t0 = _num(ev[0].get("t")) if ev else 0.0
    end_event = finished or closed
    t_end = _num(end_event.get("t")) if end_event else (_num(ev[-1].get("t")) if ev else t0)
    if seg.kind in ("recording", "review") and opened:
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
    if seg.kind == "review":
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
    return row


def visit_row(v: VisitLog, rows: list[dict[str, Any]]) -> dict[str, Any]:
    ev = v.events
    end = _num(ev[-1].get("t")) if ev else 0.0
    inputs = [_num(e.get("t")) for e in ev if e.get("type") in INPUT_EVENTS]
    kinds = Counter(str(e.get("type")) for e in ev)
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
        "recordings_opened": kinds["recording_opened"] - kinds["practice_review_opened"],  # reviews aside
        "recordings_finished": kinds["recording_finished"],
        "recordings_closed_without_saving": kinds["closed_without_saving"],
        "annotations_saved": sum(int(e.get("n_annotations", 0) or 0) for e in ev if e.get("type") == "recording_finished"),
        "clicks": kinds["mouse_press"],
        "key_presses": sum(1 for e in ev if e.get("type") == "key" and not e.get("auto_repeat")),
        "shortcuts": kinds["shortcut"],
        "events": len(ev),
        "bad_lines": v.bad_lines,
        "electroclean_version": (v.header.get("versions") or {}).get("electroclean", ""),
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
    names = [c for c, _ in RECORDING_COLUMNS]
    rrows = [{c: r.get(c, "") for c in names} for r in sorted(rrows, key=lambda r: (r["annotator_id"], r["order"]))]
    return ActivityTables(visits=vrows, recordings=rrows, events=erows, warnings=list(warnings or []))


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
            "ElectroClean was not the active application does not count. See docs/activity_logs.md."]
    return "\n".join(out) + "\n"
