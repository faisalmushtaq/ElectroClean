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

from electroclean.app.common import now_local_iso
from electroclean.app.io.atomic import atomic_write_json
from electroclean.app.io.naming import OutputLayout
from electroclean.app.session.register import CompletionRegister, RegisterError
from electroclean.training.reference import ReferenceSet

SCHEMA = "electroclean.training_progress"
STAGES = ("guided", "practice", "assessment")
STAGE_TITLES = {
    "guided": "Learn with the experts",
    "practice": "On your own",
    "assessment": "Competency assessment",
}
STAGE_TEXT = {
    "guided": "Mark each artifact the way the experts did, one at a time, with help and instant feedback.",
    "practice": "Annotate a recording by yourself, then see your score and what you missed.",
    "assessment": "Annotate without feedback. Your result is shown when every recording is done.",
}


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
        if self.event_f1 == self.label_accuracy:
            return f"{self.event_f1:.0%} for finding the artifacts and for their types"
        return f"{self.event_f1:.0%} for finding the artifacts and {self.label_accuracy:.0%} for their types"

    def evaluate(self, feedback: dict[str, Any]) -> dict[str, Any]:
        """Apply the rule to practice feedback (training.assessment.practice_feedback)."""
        overall = feedback.get("overall", {})
        n_ref = sum(c.get("reference_events", 0) for c in feedback.get("per_category", []))
        n_you = sum(c.get("your_events", 0) for c in feedback.get("per_category", []))
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
        return {"event_f1": f1, "label_accuracy": acc, "passed": passed, "rule": self.to_dict()}


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
    from electroclean.app.io.canonical import read_annotations_json

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
                from electroclean.training.assessment import practice_feedback

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

    @property
    def unlocked(self) -> bool:
        return self.status in ("available", "in_progress", "completed")

    @property
    def finished(self) -> bool:
        return self.status in ("completed", "not_used")

    def to_log(self) -> dict[str, Any]:
        return {"stage": self.key, "status": self.status, "done": self.done, "total": self.total,
                "stars": self.stars, "max_stars": self.max_stars, "detail": self.detail}


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
                    report_text: Callable[[], str] | None = None) -> list[StageState]:
    """The three stages for one trainee. The web server's Firestore store passes ``progress``,
    ``completed`` and ``report_text`` (the competency result's sentence) instead of a results folder."""
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
    detail = f"You need {rule.describe()}."
    if best is not None:
        detail = (f"Best: {best.get('event_f1', 0):.0%} found, {best.get('label_accuracy', 0):.0%} right type. "
                  + ("Passed." if passed else f"You need {rule.describe()}."))
    out.append(StageState("practice", STAGE_TITLES["practice"], STAGE_TEXT["practice"], status, len(p_done),
                          len(p_total), seconds=p_seconds, detail=detail))
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
    a_detail = ""
    if status == "completed" and report_text is not None:
        a_detail = report_text()
    elif status == "completed" and layout is not None:
        report = layout.root / "training" / rs.set_id / "reports" / f"annotator-{annotator_id}_competency_report.json"
        try:
            a_detail = str(json.loads(report.read_text(encoding="utf-8")).get("status_text", ""))
        except (OSError, ValueError):
            a_detail = ""
    out.append(StageState("assessment", STAGE_TITLES["assessment"], STAGE_TEXT["assessment"], status, len(a_done),
                          len(a_total), detail=a_detail))
    return out


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
        # Every practice recording was done without passing: try the best-scoring one again.
        prog = progress if progress is not None else load_progress(layout, rs, annotator_id)
        tried = sorted(rs.practice_recordings,
                       key=lambda r: max((a.get("event_f1", 0.0) for a in prog.practice.get(r, [])), default=0.0))
        rid = tried[0] if tried else rs.practice_recordings[0]
        return NextStep("practice", rid, repeat=True, label="Try a practice recording again",
                        text="Not passed yet. Try a practice recording again; the review shows what you missed.")
    a = by_key["assessment"]
    if a.unlocked and not a.finished:
        return NextStep("assessment", None, label="Start the assessment",
                        text=f"Next: {STAGE_TITLES['assessment']}.")
    return NextStep(None, label="Training complete", text="You have completed every stage of this training programme.")
