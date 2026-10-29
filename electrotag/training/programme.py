"""The training programme: three stages that unlock one after the other.

1. **Learn with the experts** (``guided``): the trainee matches the experts' annotations step
   by step, with feedback, on the reference set's guided recordings.
2. **On your own** (``practice``): the trainee annotates practice recordings independently and
   is scored against the experts; passing (:class:`PassRule`) unlocks the next stage.
3. **Competency assessment** (``assessment``): blinded, as before.

A stage without recordings in the reference set is skipped. Completion comes from the
completion register (the source of truth for what was saved); stars, scores and times are kept in
a progress file per trainee and reference set, ``<results>/training_progress/<set>/annotator-<ID>.json``,
and can be rebuilt from the saved session files if that file is lost.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from electrotag.app.common import now_local_iso
from electrotag.app.io.atomic import atomic_write_json
from electrotag.app.io.naming import OutputLayout
from electrotag.app.session.register import CompletionRegister, RegisterError
from electrotag.training.reference import ReferenceSet

SCHEMA = "electrotag.training_progress"
STAGES = ("guided", "practice", "assessment")
STAGE_TITLES = {
    "guided": "Learn with the experts",
    "practice": "On your own",
    "assessment": "Competency assessment",
}
STAGE_TEXT = {
    "guided": "Mark each artifact the way the experts did, one at a time, with help and instant feedback.",
    "practice": "Annotate a recording by yourself, then see your score and what you missed.",
    "assessment": "Annotate without feedback. Your result appears here when every recording is done.",
}
#: What the practice score measures, in plain words (the score is the event F1 of the agreement analysis).
SCORE_EXPLAINED = ("The score is highest when you find every artifact the experts marked, with the right type, "
                   "and make no marks they did not make; each missed artifact, extra mark or wrong type lowers it.")
#: The assessment's result on the training path, by the competency report's status.
ASSESSMENT_RESULTS = ("met", "not_met", "not_determined")


def percent(value: float) -> str:
    """78% for 0.78, rounded as the browser rounds (Math.round), so both say the same."""
    return f"{math.floor(value * 100 + 0.5):.0f}%"


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def score_sentence(counts: dict[str, Any]) -> str:
    """What a practice score is made of, in plain words ("You found 7 of the experts' 8 artifacts and
    made 3 marks they did not make."), from the counts of ``PassRule.evaluate``. The same words as the
    browser's ``scoreSentence`` (js/training/scoring.js)."""
    n_ref, n_you = int(counts.get("reference_events", 0)), int(counts.get("your_events", 0))
    found, extra = int(counts.get("found", 0)), int(counts.get("extra", 0))
    if n_ref == 0:
        if n_you == 0:
            return "The experts marked no artifacts in this recording, and neither did you."
        return f"The experts marked no artifacts in this recording; you made {_plural(n_you, 'mark')}."
    extra_text = "no marks they did not make" if extra == 0 else (
        f"{_plural(extra, 'mark')} they did not make")
    text = f"You found {found} of the experts' {_plural(n_ref, 'artifact')} and made {extra_text}."
    other = int(counts.get("other_type", 0))
    if other:
        text += f" {other} of the {found} you found {'has' if other == 1 else 'have'} another type than theirs."
    return text


@dataclass(frozen=True)
class PassRule:
    """What a practice recording needs to pass Stage 2 (each measure at least this, 0 to 1)."""

    event_f1: float = 0.8
    label_accuracy: float = 0.8

    def to_dict(self) -> dict[str, float]:
        return {"event_f1": self.event_f1, "label_accuracy": self.label_accuracy}

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> PassRule:
        d = dict(d or {})
        rule = cls(event_f1=float(d.get("event_f1", cls.event_f1)),
                   label_accuracy=float(d.get("label_accuracy", cls.label_accuracy)))
        for name, value in rule.to_dict().items():
            if not 0.0 <= value <= 1.0:
                raise ValueError(f"practice_pass.{name} must be between 0 and 1")
        return rule

    def describe(self) -> str:
        """The pass mark in plain words (the same as the browser's ``describePassRule``)."""
        return (f"a score of at least {percent(self.event_f1)} and the right type for at least "
                f"{percent(self.label_accuracy)} of the artifacts you find")

    def evaluate(self, feedback: dict[str, Any]) -> dict[str, Any]:
        """Apply the rule to practice feedback (training.assessment.practice_feedback). The result
        also counts what the score is made of (``score_sentence``)."""
        overall = feedback.get("overall", {})
        n_ref = sum(c.get("reference_events", 0) for c in feedback.get("per_category", []))
        n_you = sum(c.get("your_events", 0) for c in feedback.get("per_category", []))
        counts = {"reference_events": int(n_ref), "your_events": int(n_you),
                  "found": max(0, int(n_ref) - len(feedback.get("missed", []))),
                  "extra": len(feedback.get("extra", [])), "other_type": len(feedback.get("label_differences", []))}
        f1 = _num(overall.get("event_f1"))
        acc = _num(overall.get("label_accuracy"))
        if n_ref == 0 and n_you == 0:  # a clean recording left clean is a perfect result
            f1 = acc = 1.0
        elif n_ref == 0 or n_you == 0:
            f1 = 0.0 if f1 is None else f1
        if acc is None:  # nothing matched, so no type to judge
            acc = 0.0
        f1 = 0.0 if f1 is None else f1
        passed = f1 >= self.event_f1 and acc >= self.label_accuracy
        return {"event_f1": f1, "label_accuracy": acc, "passed": passed, "rule": self.to_dict(), **counts}


def practice_detail(best: dict[str, Any] | None, rule: PassRule, passed: bool) -> str:
    """The practice stage's line on the training path: the best score so far and the pass mark
    (the same words as the browser's ``practiceDetail``)."""
    need = f"To pass, you need {rule.describe()}."
    if best is None:
        return need
    text = (f"Best score: {percent(float(best.get('event_f1') or 0.0))}, with the right type for "
            f"{percent(float(best.get('label_accuracy') or 0.0))} of the artifacts found.")
    if "reference_events" in best:
        text += " " + score_sentence(best)
    return f"{text} {'Passed.' if passed else need}"


def practice_verdict(passed: bool, rule: PassRule, n_practice: int, unlocked: str = "") -> str:
    """The verdict at the top of a practice review (the same words as the browser's ``practiceVerdict``)."""
    if passed:
        return f"Passed: you reached the pass mark, {rule.describe()}.{(' ' + unlocked) if unlocked else ''}"
    again = ("then try this recording again from your training path" if n_practice <= 1
             else "then go on from your training path to another practice recording")
    return f"Not yet: you need {rule.describe()}. Look at what you missed below, {again}."


def _num(value: Any) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) else v


def progress_path(layout: OutputLayout, set_id: str, annotator_id: str) -> Path:
    return layout.root / "training_progress" / set_id / f"annotator-{annotator_id}.json"


@dataclass
class Progress:
    """Stars, scores and times of one trainee in one reference set."""

    path: Path
    annotator_id: str
    set_id: str
    guided: dict[str, dict[str, Any]] = field(default_factory=dict)  # recording -> summary
    practice: dict[str, list[dict[str, Any]]] = field(default_factory=dict)  # recording -> attempts
    events: list[dict[str, Any]] = field(default_factory=list)  # stage started / completed, with times

    @classmethod
    def load(cls, layout: OutputLayout, set_id: str, annotator_id: str) -> Progress:
        path = progress_path(layout, set_id, annotator_id)
        out = cls(path=path, annotator_id=annotator_id, set_id=set_id)
        try:
            d = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return out
        out.update_from(d)
        return out

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": SCHEMA, "annotator_id": self.annotator_id, "reference_set_id": self.set_id,
            "updated_at": now_local_iso(), "guided": self.guided, "practice": self.practice, "events": self.events,
        }

    def update_from(self, d: dict[str, Any]) -> None:
        """Take the stars, scores and events of a saved progress record (``to_dict``)."""
        if d.get("schema") != SCHEMA:
            return
        self.guided = dict(d.get("guided", {}))
        self.practice = {k: list(v) for k, v in dict(d.get("practice", {})).items()}
        self.events = list(d.get("events", []))

    def save(self) -> None:
        atomic_write_json(self.path, self.to_dict())

    def record_guided(self, recording_id: str, summary: dict[str, Any]) -> None:
        self.guided[recording_id] = {**summary, "completed_at": now_local_iso()}
        self.save()

    def record_practice(self, recording_id: str, result: dict[str, Any], seconds: float | None = None) -> None:
        entry = {**result, "completed_at": now_local_iso()}
        if seconds is not None:
            entry["seconds"] = round(float(seconds), 3)
        self.practice.setdefault(recording_id, []).append(entry)
        self.save()

    def note(self, event: str, **fields: Any) -> None:
        self.events.append({"event": event, "at": now_local_iso(), **fields})
        self.save()

    @property
    def practice_passed(self) -> bool:
        return any(a.get("passed") for attempts in self.practice.values() for a in attempts)

    def best_practice(self) -> dict[str, Any] | None:
        attempts = [a for v in self.practice.values() for a in v]
        if not attempts:
            return None
        return max(attempts, key=lambda a: (bool(a.get("passed")), a.get("event_f1", 0.0), a.get("label_accuracy", 0.0)))


def rebuild_progress(layout: OutputLayout, rs: ReferenceSet, annotator_id: str) -> Progress:
    """Rebuild a lost progress file from the register and the saved session files."""
    from electrotag.app.io.canonical import read_annotations_json

    prog = Progress(progress_path(layout, rs.set_id, annotator_id), annotator_id, rs.set_id)
    try:
        entries = CompletionRegister(layout).entries()
    except RegisterError:
        entries = []
    rule = PassRule.from_dict(rs.practice_pass)
    for e in entries:
        if e.get("annotator_id") != annotator_id or e.get("context") != rs.set_id:
            continue
        rid, mode = e.get("recording_id", ""), e.get("mode", "")
        folder = layout.root / e.get("output_dir", "")
        base = e.get("output_basename", "")
        if mode == "guided" and rid in rs.recordings:
            try:
                meta = json.loads((folder / f"{base}_session.json").read_text(encoding="utf-8"))
                summary = dict(meta.get("context", {}).get("guided", {}))
            except (OSError, ValueError):
                summary = {}
            prog.guided[rid] = {**summary, "completed_at": e.get("completed_at", "")}
        elif mode == "practice" and rid in rs.recordings:
            try:  # scoring needs pandas: imported only when there is a practice recording to score
                from electrotag.training.assessment import practice_feedback

                mine = read_annotations_json(folder / f"{base}_annotations.json")
                result = rule.evaluate(practice_feedback(mine, rs.reference_document(rid), rs))
            except Exception:  # noqa: BLE001 - a missing file only loses that score
                continue
            prog.practice.setdefault(rid, []).append({**result, "completed_at": e.get("completed_at", ""),
                                                      "seconds": _num(e.get("elapsed_s"))})
    return prog


def load_progress(layout: OutputLayout, rs: ReferenceSet, annotator_id: str) -> Progress:
    prog = Progress.load(layout, rs.set_id, annotator_id)
    if not prog.path.exists():
        rebuilt = rebuild_progress(layout, rs, annotator_id)
        if rebuilt.guided or rebuilt.practice:
            rebuilt.save()
        return rebuilt
    return prog


@dataclass
class StageState:
    key: str
    title: str
    description: str
    status: str  # locked, available, in_progress, completed, not_used
    done: int = 0
    total: int = 0
    stars: int = 0
    max_stars: int = 0
    seconds: float = 0.0
    detail: str = ""  # a line about results (best score, assessment result)
    result: str = ""  # the assessment's result (ASSESSMENT_RESULTS); practice: "passed" or "not_passed"

    @property
    def unlocked(self) -> bool:
        return self.status in ("available", "in_progress", "completed")

    @property
    def finished(self) -> bool:
        return self.status in ("completed", "not_used")

    def to_log(self) -> dict[str, Any]:
        return {"stage": self.key, "status": self.status, "done": self.done, "total": self.total,
                "stars": self.stars, "max_stars": self.max_stars, "detail": self.detail, "result": self.result}


@dataclass
class NextStep:
    stage: str | None  # None when everything is done
    recording_id: str | None = None  # None: let the usual selection choose (assessment)
    repeat: bool = False  # annotate an already completed practice recording again
    label: str = ""  # the Continue button's text
    text: str = ""  # one line saying what comes next


def completed_in(layout: OutputLayout, annotator_id: str, mode: str, set_id: str) -> set[str]:
    try:
        return CompletionRegister(layout).completed(annotator_id, mode, set_id)
    except RegisterError:
        return set()


_completed_in = completed_in


#: What was completed: ``completed(annotator_id, mode, set_id) -> recording IDs`` (by default the register).
Completed = Callable[[str, str, str], set[str]]


def programme_state(layout: OutputLayout | None, rs: ReferenceSet, annotator_id: str,
                    progress: Progress | None = None, *, completed: Completed | None = None,
                    report: Callable[[], dict[str, Any]] | None = None) -> list[StageState]:
    """The three stages for one trainee. The web server's stores pass ``progress``, ``completed``
    and ``report`` (the competency report's ``status`` and ``status_text``, {} without one) instead
    of a results folder."""
    prog = progress if progress is not None else load_progress(layout, rs, annotator_id)

    def completed_in(layout: OutputLayout | None, annotator_id: str, mode: str, set_id: str) -> set[str]:
        return completed(annotator_id, mode, set_id) if completed is not None else _completed_in(
            layout, annotator_id, mode, set_id)
    rule = PassRule.from_dict(rs.practice_pass)
    out: list[StageState] = []
    # Stage 1
    g_total = rs.guided_recordings
    g_done = completed_in(layout, annotator_id, "guided", rs.set_id) & set(g_total)
    stars = sum(int(prog.guided.get(r, {}).get("stars", 0)) for r in g_done)
    max_stars = sum(int(prog.guided.get(r, {}).get("max_stars", 0)) for r in g_done)
    seconds = sum(float(prog.guided.get(r, {}).get("seconds", 0.0)) for r in g_done)
    if not g_total:
        status = "not_used"
    elif len(g_done) == len(g_total):
        status = "completed"
    else:
        status = "in_progress" if g_done else "available"
    out.append(StageState("guided", STAGE_TITLES["guided"], STAGE_TEXT["guided"], status, len(g_done), len(g_total),
                          stars, max_stars, seconds))
    # Stage 2
    p_total = rs.practice_recordings
    p_done = completed_in(layout, annotator_id, "practice", rs.set_id) & set(p_total)
    best = prog.best_practice()
    passed = prog.practice_passed
    p_seconds = sum(float(a.get("seconds") or 0.0) for v in prog.practice.values() for a in v)
    if not p_total:
        status = "not_used"
    elif not out[0].finished:
        status = "locked"
    elif passed:
        status = "completed"
    else:
        status = "in_progress" if prog.practice else "available"
    detail = practice_detail(best, rule, passed)
    out.append(StageState("practice", STAGE_TITLES["practice"], STAGE_TEXT["practice"], status, len(p_done),
                          len(p_total), seconds=p_seconds, detail=detail,
                          result="" if best is None else ("passed" if passed else "not_passed")))
    # Stage 3
    a_total = rs.assessment_recordings
    a_done = completed_in(layout, annotator_id, "assessment", rs.set_id) & set(a_total)
    if not a_total:
        status = "not_used"
    elif not (out[0].finished and out[1].finished):
        status = "locked"
    elif len(a_done) == len(a_total):
        status = "completed"
    else:
        status = "in_progress" if a_done else "available"
    rep: dict[str, Any] = {}
    if status == "completed" and report is not None:
        rep = dict(report() or {})
    elif status == "completed" and layout is not None:
        path = layout.root / "training" / rs.set_id / "reports" / f"annotator-{annotator_id}_competency_report.json"
        try:
            rep = dict(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            rep = {}
    a_result, a_detail = assessment_result(rep) if status == "completed" else ("", "")
    out.append(StageState("assessment", STAGE_TITLES["assessment"], STAGE_TEXT["assessment"], status, len(a_done),
                          len(a_total), detail=a_detail, result=a_result))
    return out


#: What the trainee does next after the assessment, by its result (the competency report's
#: ``NEXT_STEPS``, kept here so that the training path needs no analysis code).
ASSESSMENT_NEXT = {
    "met": "Your study administrator will confirm what happens next.",
    "not_met": "Please talk to your study administrator, who can go through the results with you and suggest "
               "further practice before you take the assessment again.",
    "not_determined": "Your study administrator will look at the results and tell you what happens next.",
}


def assessment_result(report: dict[str, Any]) -> tuple[str, str]:
    """The result of a finished assessment and its line on the training path, from the competency
    report: ``met``, ``not_met`` or ``not_determined`` (also when there is no report yet)."""
    status = str(report.get("status") or "")
    if status not in ("met", "not_met"):
        status = "not_determined"
    text = str(report.get("status_text") or "") or "Your result is not available yet."
    return status, f"{text} {ASSESSMENT_NEXT[status]}"


def next_step(layout: OutputLayout | None, rs: ReferenceSet, annotator_id: str, states: list[StageState],
              progress: Progress | None = None, *, completed: Completed | None = None) -> NextStep:
    """What the Continue button of the training path does next (``completed`` as for programme_state)."""
    by_key = {s.key: s for s in states}

    def completed_in(layout: OutputLayout | None, annotator_id: str, mode: str, set_id: str) -> set[str]:
        return completed(annotator_id, mode, set_id) if completed is not None else _completed_in(
            layout, annotator_id, mode, set_id)
    g = by_key["guided"]
    if g.unlocked and not g.finished:
        done = completed_in(layout, annotator_id, "guided", rs.set_id)
        rid = next(r for r in rs.guided_recordings if r not in done)
        n = rs.guided_recordings.index(rid) + 1
        return NextStep("guided", rid, label=f"Start recording {n} of {len(rs.guided_recordings)}",
                        text=f"Next: {STAGE_TITLES['guided']}, recording {n} of {len(rs.guided_recordings)}.")
    p = by_key["practice"]
    if p.unlocked and not p.finished:
        done = completed_in(layout, annotator_id, "practice", rs.set_id)
        left = [r for r in rs.practice_recordings if r not in done]
        if left:
            n = rs.practice_recordings.index(left[0]) + 1
            return NextStep("practice", left[0], label="Start a practice recording",
                            text=f"Next: {STAGE_TITLES['practice']}, practice recording {n} of {len(rs.practice_recordings)}.")
        # Every practice recording was done without passing: the one practised longest ago comes
        # again, so that the answers the trainee has just seen in a review are not the next test.
        prog = progress if progress is not None else load_progress(layout, rs, annotator_id)
        rid = retry_recording(rs.practice_recordings, prog.practice)
        if len(rs.practice_recordings) == 1:
            return NextStep("practice", rid, repeat=True, label="Try the practice recording again",
                            text="Not passed yet. Try the practice recording again, looking out for what "
                                 "its review showed you.")
        n = rs.practice_recordings.index(rid) + 1
        return NextStep("practice", rid, repeat=True, label=f"Try practice recording {n} again",
                        text=f"Not passed yet. Try practice recording {n} of {len(rs.practice_recordings)} again, "
                             "the one you did longest ago.")
    a = by_key["assessment"]
    if a.unlocked and not a.finished:
        return NextStep("assessment", None, label="Start the assessment",
                        text=f"Next: {STAGE_TITLES['assessment']}.")
    if a.status == "completed" and a.result != "met":
        return NextStep(None, label="Training complete",
                        text="You have done every stage of this training programme. " + ASSESSMENT_NEXT.get(
                            a.result, ASSESSMENT_NEXT["not_determined"]))
    return NextStep(None, label="Training complete", text="You have completed every stage of this training programme.")


def retry_recording(recordings: list[str], attempts: dict[str, list[dict[str, Any]]]) -> str:
    """The practice recording to try again: the one practised longest ago (never tried first), so
    that the trainee does not repeat, from memory, the answers a review has just shown."""
    def last(rid: str) -> str:
        return max((str(a.get("completed_at") or "") for a in attempts.get(rid, [])), default="")
    return min(recordings, key=lambda r: (last(r), recordings.index(r)))
