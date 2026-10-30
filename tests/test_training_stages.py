"""The five stages of the training path (electrotag/training/programme.py): how they unlock when stages
are skipped, that the assessment is never skipped, the study's policy, taking a skipped stage up again,
what the study team does after an assessment (reopening the training, a new assessment set), the
snippets of a reference set, and that a rebuilt progress file keeps its events. The web side is in
tests/test_web_training_stages.py."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from electrotag.app.annotations.labels import default_catalogue
from electrotag.app.io.naming import OutputLayout
from electrotag.training.examples import create_example_training_set
from electrotag.training.programme import (
    REOPENED_TEXT,
    SKIPPED_TEXT,
    STAGES,
    Progress,
    StagePolicy,
    next_step,
    programme_state,
    rebuild_progress,
    snippet_count,
    snippets_detail,
    stage_marks,
)
from electrotag.training.reference import ReferenceSet, ReferenceSetError, Snippet, guided_snippets, set_snippets

LABELS = tuple(lab.label for lab in default_catalogue().labels)


@pytest.fixture(scope="module")
def example(tmp_path_factory: pytest.TempPathFactory) -> ReferenceSet:
    root = tmp_path_factory.mktemp("stages")
    return create_example_training_set(root)


class Saved:
    """What the completion register would say: recordings saved, by mode, with how many times."""

    def __init__(self) -> None:
        self.n: dict[tuple[str, str], int] = {}

    def save(self, mode: str, rid: str) -> None:
        self.n[(mode, rid)] = self.n.get((mode, rid), 0) + 1

    def completed(self, aid: str, mode: str, set_id: str) -> set[str]:
        return {r for (m, r) in self.n if m == mode}

    def saves(self, aid: str, mode: str, set_id: str) -> dict[str, int]:
        return {r: k for (m, r), k in self.n.items() if m == mode}


def progress(rs: ReferenceSet, events: list[dict] | None = None) -> Progress:
    p = Progress(Path("/nonexistent/progress.json"), "T01", rs.set_id, events=list(events or []))
    p.save = lambda: None  # type: ignore[method-assign]
    return p


def states(rs: ReferenceSet, prog: Progress, saved: Saved | None = None, policy: StagePolicy | None = None,
           report: dict | None = None) -> dict[str, object]:
    saved = saved or Saved()
    out = programme_state(None, rs, "T01", prog, completed=saved.completed, saves=saved.saves, policy=policy,
                          report=lambda: report or {})
    return {s.key: s for s in out}


def statuses(st: dict) -> list[str]:
    return [st[k].status for k in STAGES]


def finish_guided(rs: ReferenceSet, saved: Saved, prog: Progress) -> None:
    for rid in rs.guided_recordings:
        saved.save("guided", rid)
        prog.guided[rid] = {"stars": 3, "max_stars": 3, "seconds": 10.0}


# ------------------------------------------------------------------ unlocking
def test_the_stages_unlock_in_order_and_a_skipped_stage_counts_as_finished(example: ReferenceSet) -> None:
    rs = example
    prog = progress(rs)
    st = states(rs, prog)
    assert statuses(st) == ["available", "locked", "locked", "locked", "not_used"]
    assert st["tour"].can_skip and not st["snippets"].can_skip  # a locked stage is not skipped
    prog.note("stage_skipped", stage="tour")
    st = states(rs, prog)
    assert statuses(st) == ["skipped", "available", "locked", "locked", "not_used"]
    assert st["tour"].detail == SKIPPED_TEXT and st["tour"].can_resume and st["tour"].finished
    prog.note("stage_completed", stage="snippets")
    prog.note("stage_skipped", stage="guided")
    st = states(rs, prog)
    assert statuses(st) == ["skipped", "completed", "skipped", "available", "not_used"]
    assert not st["guided"].unlocked  # a skipped stage's recordings are not offered
    nxt = next_step(None, rs, "T01", list(st.values()), prog)
    assert nxt.stage == "practice" and nxt.recording_id == rs.practice_recordings[0]


def test_next_step_goes_from_the_tour_to_the_snippets_to_the_experts(example: ReferenceSet) -> None:
    rs = example
    prog = progress(rs)
    first = next_step(None, rs, "T01", list(states(rs, prog).values()), prog)
    assert (first.stage, first.recording_id, first.label) == ("tour", None, "Start the tour")
    prog.note("stage_completed", stage="tour")
    second = next_step(None, rs, "T01", list(states(rs, prog).values()), prog)
    assert (second.stage, second.label) == ("snippets", "See the artifacts")
    prog.note("stage_completed", stage="snippets")
    third = next_step(None, rs, "T01", list(states(rs, prog).values()), prog)
    assert third.stage == "guided" and third.recording_id == rs.guided_recordings[0]


def test_the_assessment_is_never_skipped(example: ReferenceSet) -> None:
    rs = ReferenceSet.load(example.directory)
    rs.recordings[rs.practice_recordings[0]]["use"] = "assessment"
    assert not StagePolicy(skippable=("tour", "snippets", "guided", "practice", "assessment")).may_skip("assessment")
    prog = progress(rs, [{"event": "stage_skipped", "stage": s} for s in ("tour", "snippets", "guided", "assessment")])
    st = states(rs, prog)
    assert st["assessment"].status == "available" and not st["assessment"].can_skip
    assert stage_marks(prog.events).skipped == ["tour", "snippets", "guided"]


# --------------------------------------------------------------------- policy
def test_the_policy_decides_what_may_be_skipped_and_whether_there_is_a_tour(example: ReferenceSet) -> None:
    rs = example
    st = states(rs, progress(rs), policy=StagePolicy(skippable=("snippets",), tour=False))
    assert st["tour"].status == "not_used" and st["snippets"].status == "available"
    assert st["snippets"].can_skip and not st["guided"].can_skip
    prog = progress(rs, [{"event": "stage_completed", "stage": "snippets"}])
    st = states(rs, prog, policy=StagePolicy(skippable=("snippets",), tour=False))
    assert st["guided"].status == "available" and not st["guided"].can_skip
    # a tour done before the study switched it off stays done; one skipped is simply not part of the path
    assert states(rs, progress(rs, [{"event": "stage_completed", "stage": "tour"}]),
                  policy=StagePolicy(tour=False))["tour"].status == "completed"
    assert states(rs, progress(rs, [{"event": "stage_skipped", "stage": "tour"}]),
                  policy=StagePolicy(tour=False))["tour"].status == "not_used"


def test_policy_from_the_study_settings() -> None:
    from electrotag.config.settings import TrainingPolicy

    p = StagePolicy.from_settings(TrainingPolicy.from_dict({"skippable": ["practice", "tour"], "tour": False,
                                                            "snippets_quiz_required": True}))
    assert p == StagePolicy(skippable=("tour", "practice"), tour=False, snippets_quiz_required=True)
    assert StagePolicy.from_settings(None) == StagePolicy()


def test_a_skipped_stage_taken_up_again_holds_back_the_unfinished_stages_after_it(example: ReferenceSet) -> None:
    rs = ReferenceSet.load(example.directory)
    rs.recordings[rs.practice_recordings[0]]["use"] = "assessment"
    saved = Saved()
    prog = progress(rs, [{"event": "stage_skipped", "stage": s} for s in ("tour", "snippets", "guided")])
    assert states(rs, prog, saved)["assessment"].status == "available"
    prog.note("stage_resumed", stage="guided")
    st = states(rs, prog, saved)
    assert st["guided"].status == "available" and st["assessment"].status == "locked"
    prog.note("stage_resumed", stage="guided")  # again: nothing more changes
    assert statuses(states(rs, prog, saved)) == statuses(st)
    # once the assessment is done, it stays done whatever is taken up again
    finish_guided(rs, saved, prog)
    saved.save("assessment", rs.assessment_recordings[0])
    prog.note("stage_resumed", stage="tour")
    st = states(rs, prog, saved)
    assert st["tour"].status == "available" and st["assessment"].status == "completed"


# ------------------------------------------------------------------ the snippets
def test_snippets_come_from_the_guided_references_and_the_study_teams_own(example: ReferenceSet) -> None:
    rs = ReferenceSet.load(example.directory)
    derived = guided_snippets(rs)
    n_guided = sum(len(rs.reference_document(r).annotations) for r in rs.guided_recordings)
    assert len(derived) == n_guided == snippet_count(rs)
    assert all(s.recording_id in rs.guided_recordings and s.source["kind"] == "guided" for s in derived)
    first = derived[0]
    assert first.snippet_id == f"g-{first.source['annotation_id']}" and first.explanation  # the experts' note
    assert first.start_s < first.end_s and first.context_s == 2.0
    assert all(s.recording_id not in rs.practice_recordings for s in set_snippets(rs))  # never the answers
    # the study team's own
    rid = rs.guided_recordings[1]
    rs.add_snippet(Snippet(rs.next_snippet_id(), rid, 1.0, 2.5, "EMG-artifact", "Fast and spiky", 2.0), LABELS)
    assert rs.own_snippets[0].snippet_id == "s01" and rs.next_snippet_id() == "s02"
    assert set_snippets(rs)[0].snippet_id == "s01" and snippet_count(rs) == n_guided + 1
    rs.add_snippet(Snippet("s01", rid, 1.0, 3.0, "EMG-artifact"), LABELS)  # the same ID replaces it
    assert len(rs.own_snippets) == 1 and rs.own_snippets[0].end_s == 3.0
    for bad, why in ((Snippet("s9", rs.practice_recordings[0], 1, 2, "EMG-artifact"), "answers"),
                     (Snippet("s9", rid, 2, 1, "EMG-artifact"), "after its start"),
                     (Snippet("s9", rid, 0, 61, "EMG-artifact"), "at most"),
                     (Snippet("s9", rid, 0, 1, "Banana"), "permitted")):
        with pytest.raises(ReferenceSetError, match=why):
            rs.add_snippet(bad, LABELS)
    again = ReferenceSet.load(rs.directory)  # kept in reference_set.json
    assert [s.to_dict() for s in again.own_snippets] == [s.to_dict() for s in rs.own_snippets]
    # a snippet promoted from the library of conflicts comes as a dict, without channels (library.py)
    rs.add_snippet({"snippet_id": "s02", "recording_id": rid, "start_s": 4.0, "end_s": 5.0, "label": "EMG-artifact",
                    "explanation": "", "context_s": 2.0, "source": {"library_entry": "t-1:c-1", "promote_id": "9" * 32}})
    promoted = next(x for x in set_snippets(rs) if x.snippet_id == "s02")
    assert promoted.channels == [] and promoted.source["promote_id"] == "9" * 32
    with pytest.raises(ReferenceSetError):
        rs.add_snippet({"snippet_id": "", "recording_id": rid, "start_s": 1, "end_s": 2, "label": "EMG-artifact"})
    rs.remove_snippet("s02")
    rs.remove_snippet("s01")
    assert rs.own_snippets == []
    with pytest.raises(ReferenceSetError):
        rs.remove_snippet("s01")


def test_a_set_without_guided_recordings_or_snippets_has_no_snippets_stage(example: ReferenceSet) -> None:
    rs = ReferenceSet.load(example.directory)
    for rid in rs.guided_recordings:
        rs.recordings[rid]["use"] = "practice"
    assert snippet_count(rs) == 0
    st = states(rs, progress(rs, [{"event": "stage_completed", "stage": "tour"}]))
    assert st["snippets"].status == "not_used" and st["guided"].status == "not_used"
    assert st["practice"].status == "available"
    assert snippets_detail(3, True, True) == ("3 examples of the experts' artifacts, with their notes, then a quick "
                                              "recognition check. To finish this stage, also finish the recognition "
                                              "check.")
    assert snippets_detail(1, False, False) == "1 example of the experts' artifacts, with their notes."


# -------------------------------------------- what the study team does after an assessment
def assessment_set(example: ReferenceSet) -> ReferenceSet:
    rs = ReferenceSet.load(example.directory)
    rs.recordings[rs.practice_recordings[0]]["use"] = "assessment"
    rs.recordings[rs.guided_recordings[1]]["use"] = "practice"
    return rs


def test_reopening_counts_only_what_is_saved_afterwards(example: ReferenceSet) -> None:
    rs = assessment_set(example)
    saved = Saved()
    prog = progress(rs, [{"event": "stage_completed", "stage": s} for s in ("tour", "snippets")])
    finish_guided(rs, saved, prog)
    p_rid, a_rid = rs.practice_recordings[0], rs.assessment_recordings[0]
    saved.save("practice", p_rid)
    prog.practice[p_rid] = [{"passed": True, "event_f1": 0.9, "label_accuracy": 1.0, "completed_at": "1"}]
    saved.save("assessment", a_rid)
    st = states(rs, prog, saved, report={"status": "not_met", "status_text": "Does not yet meet the criteria."})
    assert st["assessment"].status == "completed" and st["assessment"].result == "not_met"
    # the study team reopens it from practice
    prog.note("training_reopened", **{"from": "practice", "by": "ADMIN",
                                      "baseline": {"practice": {p_rid: 1}, "assessment": {a_rid: 1}},
                                      "practice_seen": {p_rid: 1}})
    st = states(rs, prog, saved)
    assert st["guided"].status == "completed"  # before the stage reopened: as it was
    assert st["practice"].status == "available" and st["practice"].redo == (p_rid,) and st["practice"].done == 0
    assert st["assessment"].status == "locked" and st["assessment"].detail == REOPENED_TEXT
    nxt = next_step(None, rs, "T01", list(st.values()), prog)
    assert (nxt.stage, nxt.recording_id, nxt.repeat) == ("practice", p_rid, True)
    # practising again: only the new attempt counts
    saved.save("practice", p_rid)
    prog.practice[p_rid].append({"passed": False, "event_f1": 0.5, "label_accuracy": 1.0, "completed_at": "2"})
    st = states(rs, prog, saved)
    assert st["practice"].status == "in_progress" and st["practice"].result == "not_passed"
    prog.practice[p_rid].append({"passed": True, "event_f1": 0.95, "label_accuracy": 1.0, "completed_at": "3"})
    saved.save("practice", p_rid)
    st = states(rs, prog, saved)
    assert st["practice"].status == "completed" and st["assessment"].status == "available"
    assert st["assessment"].redo == (a_rid,)
    saved.save("assessment", a_rid)
    st = states(rs, prog, saved, report={"status": "met", "status_text": "Meets the competency criteria."})
    assert st["assessment"].status == "completed" and st["assessment"].result == "met"


def test_a_new_assessment_set_counts_the_learning_stages_as_done(example: ReferenceSet) -> None:
    rs = assessment_set(example)
    prog = progress(rs, [{"event": "assessment_set_assigned", "from_set": "pilot", "from_set_name": "Pilot set"}])
    st = states(rs, prog)
    assert [st[k].status for k in ("tour", "snippets", "guided", "practice")] == ["completed"] * 4
    learning = ("tour", "snippets", "guided", "practice")
    assert all(st[k].carried and st[k].detail == "Done in Pilot set." for k in learning)
    assert st["assessment"].status == "available"
    assert next_step(None, rs, "T01", list(st.values()), prog).stage == "assessment"


def test_a_new_assessment_set_keeps_each_stage_as_it_was_and_every_skip(example: ReferenceSet) -> None:
    rs = assessment_set(example)
    carried = {"tour": {"status": "skipped", "set_id": "pilot", "set_name": "Pilot set"},
               "snippets": {"status": "completed", "set_id": "pilot", "set_name": "Pilot set"},
               "guided": {"status": "skipped", "set_id": "first", "set_name": "First set"},
               "practice": {"status": "not_used", "set_id": "pilot", "set_name": "Pilot set"}}
    skips = [{"stage": "tour", "at": "1", "set_id": "pilot", "set_name": "Pilot set"},
             {"stage": "guided", "at": "0", "set_id": "first", "set_name": "First set"}]
    rounds = [{"set_id": "first", "set_name": "First set", "status": "not_met", "status_text": "x", "at": "0"}]
    events = [{"event": "assessment_set_assigned", "from_set": "pilot", "from_set_name": "Pilot set", "stages": carried,
               "skips": skips, "earlier_rounds": rounds,
               "round": {"set_id": "pilot", "set_name": "Pilot set", "status": "not_met", "status_text": "y", "at": "1"}}]
    st = states(rs, progress(rs, events))
    assert [st[k].status for k in ("tour", "snippets", "guided", "practice")] == [
        "skipped", "completed", "skipped", "not_used"]
    assert st["tour"].detail == "Skipped in Pilot set." and st["guided"].detail == "Skipped in First set."
    assert st["snippets"].detail == "Done in Pilot set." and not st["tour"].can_resume and not st["tour"].can_skip
    assert st["assessment"].status == "available"
    marks = stage_marks(events)
    assert marks.skipped == ["tour", "guided"] and marks.skipped_in == {"tour": "Pilot set", "guided": "First set"}
    assert [x["stage"] for x in marks.skip_history] == ["tour", "guided"]
    assert [(r["round"], r["set_id"]) for r in marks.rounds] == [(1, "first"), (2, "pilot")]


def test_stages_the_study_team_reopened_cannot_be_skipped_until_done(example: ReferenceSet) -> None:
    rs = assessment_set(example)
    events = [{"event": "stage_skipped", "stage": s} for s in ("tour", "snippets", "guided")]
    events.append({"event": "training_reopened", "from": "guided", "baseline": {}, "practice_seen": {}})
    st = states(rs, progress(rs, events))
    assert st["tour"].status == "skipped" and st["tour"].can_resume  # before the reopening: as it was
    assert st["guided"].status == "available" and not st["guided"].can_skip
    assert stage_marks(events).reopened_stage("practice") and not stage_marks(events).reopened_stage("snippets")


# -------------------------------------------------------------- the progress file
def test_a_rebuilt_progress_file_keeps_the_stage_events(example: ReferenceSet, tmp_path: Path) -> None:
    layout = OutputLayout(tmp_path / "Annotated_Events")
    prog = Progress.load(layout, example.set_id, "T01")
    prog.note("stage_skipped", stage="tour", policy=["tour"])
    prog.note("stage_completed", stage="snippets")
    rebuilt = rebuild_progress(layout, example, "T01")
    assert [e["event"] for e in rebuilt.events] == ["stage_skipped", "stage_completed"]
    data = json.loads(prog.path.read_text())
    assert data["events"][0]["stage"] == "tour" and data["events"][0]["at"]
    st = programme_state(layout, example, "T01")
    assert [s.status for s in st][:3] == ["skipped", "completed", "available"]
