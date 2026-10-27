"""The training programme: Stage 1 (learn with the experts, step by step), Stage 2 (on your own,
with a pass mark and flags in the review), the training path, self-contained and example sets."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

pytest.importorskip("PySide6")

import pyqtgraph as pg  # noqa: E402
from qtpy.QtCore import Qt  # noqa: E402
from qtpy.QtTest import QTest  # noqa: E402
from qtpy.QtWidgets import QApplication  # noqa: E402

from electroclean.app.annotations.labels import default_catalogue  # noqa: E402
from electroclean.app.annotations.model import ArtifactAnnotation  # noqa: E402
from electroclean.app.gui.app_controller import AppController  # noqa: E402
from electroclean.app.gui.dialogs import ScriptedPrompts  # noqa: E402
from electroclean.app.gui.start_window import StartRequest  # noqa: E402
from electroclean.app.io.canonical import write_annotations_json  # noqa: E402
from electroclean.app.io.discovery import discover_recordings  # noqa: E402
from electroclean.app.session.interaction_log import InteractionLog  # noqa: E402
from electroclean.app.session.register import CompletionRegister  # noqa: E402
from electroclean.synthetic import truth_document, write_recording  # noqa: E402
from electroclean.training.examples import EXAMPLE_SET_ID, create_example_training_set  # noqa: E402
from electroclean.training.guided import (  # noqa: E402
    Step,
    Tolerance,
    build_steps,
    check_step,
    extras,
    stars_for,
)
from electroclean.training.guided_gui import continue_programme, leave_programme, review_flags  # noqa: E402
from electroclean.training.programme import (  # noqa: E402
    PassRule,
    load_progress,
    next_step,
    programme_state,
    progress_path,
)
from electroclean.training.reference import (  # noqa: E402
    ReferenceSet,
    import_expert_recording,
    reference_sets_dir,
)

pytestmark = pytest.mark.gui
CAT = default_catalogue()
SF = 250.0


@pytest.fixture(scope="module")
def qapp():
    return pg.mkQApp("ElectroClean-tests")


def wait(ms: int = 40) -> None:
    QTest.qWait(ms)
    QApplication.processEvents()


@pytest.fixture
def example(dataset):
    root, _ = dataset
    rs = create_example_training_set(root)
    return root, rs


def ann(label, start_s, dur_s, channels=(), aid="a") -> ArtifactAnnotation:
    return ArtifactAnnotation(aid, label, int(round(start_s * SF)), int(round(dur_s * SF)), tuple(channels))


def step(target: ArtifactAnnotation, index: int = 0) -> Step:
    return Step(index, replace(target, annotation_id=f"ref{index}"))


# ---------------------------------------------------------------- matching rules
def test_each_rule_gives_specific_feedback():
    blink = step(ann("Eye-blink-artifact", 4.0, 0.4, ("Fp1", "Fp2", "VEOG")))
    tol = Tolerance()
    keys = {"Eye-blink-artifact": 1}
    assert check_step(blink, [], SF, tol).problems == ["missing"]
    ok = check_step(blink, [ann("Eye-blink-artifact", 4.1, 0.4, ("Fp1", "Fp2", "VEOG"))], SF, tol)
    assert ok.matched and ok.messages == ["Right type, timing and channels."]
    wrong = check_step(blink, [ann("EMG-artifact", 4.0, 0.4, ("Fp1", "Fp2", "VEOG"))], SF, tol, quick_keys=keys)
    assert wrong.problems == ["type"]
    assert "marked this as an Eye-blink-artifact (press 1); yours is an EMG-artifact" in wrong.messages[0]
    early = check_step(blink, [ann("Eye-blink-artifact", 3.6, 0.8, ("Fp1", "Fp2", "VEOG"))], SF, tol)
    assert early.problems == ["start"] and "the start is 0.40 s too early" in early.messages[0]
    late_end = check_step(blink, [ann("Eye-blink-artifact", 4.0, 0.9, ("Fp1", "Fp2", "VEOG"))], SF, tol)
    assert late_end.problems == ["end"] and "the end is 0.50 s too late" in late_end.messages[0]
    whole = check_step(blink, [ann("Eye-blink-artifact", 4.0, 0.4)], SF, tol)
    assert whole.problems == ["scope"] and "on Fp1, Fp2 and VEOG only" in whole.messages[0]
    missing = check_step(blink, [ann("Eye-blink-artifact", 4.0, 0.4, ("Fp1", "Fp2"))], SF, tol)
    assert missing.problems == ["channels"] and "VEOG is missing" in missing.messages[0]
    extra_ch = check_step(blink, [ann("Eye-blink-artifact", 4.0, 0.4, ("Fp1", "Fp2", "VEOG", "F7", "F8"))], SF, tol)
    assert extra_ch.problems == ["channels"] and "F7 and F8 are not part of it" in extra_ch.messages[0]
    move = step(ann("Movement-artifact", 20.0, 2.0))
    on_channels = check_step(move, [ann("Movement-artifact", 20.0, 2.0, ("C3",))], SF, tol)
    assert on_channels.problems == ["scope"] and "whole montage" in on_channels.messages[0]
    # The time allowed grows with long artifacts (20 % of 2 s = 0.4 s here).
    assert check_step(move, [ann("Movement-artifact", 20.35, 1.65)], SF, tol).matched


def test_tolerance_settings_and_accepted_alternatives():
    blink = step(ann("Eye-blink-artifact", 4.0, 0.4))
    tol = Tolerance.from_dict({"seconds": 0.05, "fraction": 0.0, "accepted_labels": {"Eye-blink-artifact": ["Eye-artifact"]}})
    assert not check_step(blink, [ann("Eye-blink-artifact", 4.1, 0.4)], SF, tol).matched
    assert check_step(blink, [ann("Eye-artifact", 4.0, 0.4)], SF, tol).matched
    with pytest.raises(ValueError):
        Tolerance.from_dict({"channel_jaccard": 0})


def test_extras_are_marks_the_experts_did_not_make_and_second_attempts():
    steps = build_steps(type("D", (), {"annotations": [ann("Eye-blink-artifact", 4.0, 0.4, aid="r1"),
                                                       ann("EMG-artifact", 10.0, 1.0, aid="r2")]})())
    first = ann("Eye-blink-artifact", 4.0, 0.4, aid="mine")
    ahead = ann("EMG-artifact", 10.0, 1.0, aid="ahead")  # the next one, marked early: fine
    stray = ann("Sweat-artifact", 30.0, 1.0, aid="stray")
    twice = ann("Eye-blink-artifact", 4.05, 0.4, aid="twice")
    result = check_step(steps[0], [first, ahead, stray, twice], SF, Tolerance())
    assert result.candidate_id in ("mine", "twice")
    assert {a.annotation_id for a in extras(steps, [first, ahead, stray, twice], {}, result, 0)} == {
        "stray", "twice" if result.candidate_id == "mine" else "mine"}


def test_stars():
    assert stars_for(0, False) == 3 and stars_for(2, False) == 2 and stars_for(3, False) == 1
    assert stars_for(0, True) == 1


def test_pass_rule():
    rule = PassRule()
    fb = {"overall": {"event_f1": 0.85, "label_accuracy": 0.9}, "per_category": [{"reference_events": 5, "your_events": 5}]}
    assert rule.evaluate(fb)["passed"]
    fb["overall"]["label_accuracy"] = 0.5
    assert not rule.evaluate(fb)["passed"]
    clean = {"overall": {"event_f1": float("nan"), "label_accuracy": float("nan")}, "per_category": []}
    assert rule.evaluate(clean)["passed"]  # a clean recording left clean
    assert "80%" in rule.describe()
    with pytest.raises(ValueError):
        PassRule.from_dict({"event_f1": 2})


# ------------------------------------------------------------------ the example set
def test_example_set_is_self_contained_and_never_a_study_recording(qapp, example):
    root, rs = example
    assert rs.self_contained and (rs.directory / "recordings").is_dir()
    assert len(rs.guided_recordings) == 2 and len(rs.practice_recordings) == 1
    assert [rs.guidance_for(r) for r in rs.guided_recordings] == ["show", "find"]
    assert "placeholder" in rs.name.lower()
    reloaded = ReferenceSet.load(rs.directory)
    notes = reloaded.guided["notes"]
    first = reloaded.reference_document(reloaded.guided_recordings[0])
    assert all(a.annotation_id in notes for a in first.annotations)
    assert "Placeholder note (simulated data)" in next(iter(notes.values()))
    found = {r.recording_id for r in discover_recordings(rs.recordings_root())}
    assert set(rs.recordings) == found
    ctrl = AppController(prompts=ScriptedPrompts({"Continue?": "Quit"}), synchronous_loading=True)
    ctrl.begin(StartRequest("A01", "", root, None, "standard"))
    assert not any("example" in r.recording_id for r in ctrl.recordings)
    ctrl.workspace and ctrl.workspace.close()
    wait()


def test_import_a_real_expert_recording_into_a_set(qapp, dataset, tmp_path):
    root, _ = dataset
    _, study = None, None
    rs = ReferenceSet.create(reference_sets_dir(root, study), "real", name="Real experts", experts=["E1"])
    src = tmp_path / "incoming" / "sub-x1" / "eeg"
    vhdr, plan, timing = write_recording(src, "sub-x1_task-rest", sfreq=SF, duration_s=30.0, seed=9)
    truth = truth_document("whatever/it/was/called.vhdr", plan, timing, CAT, annotator_id="E1")
    expert = tmp_path / "E1_annotations.json"
    write_annotations_json(expert, truth)
    rid = import_expert_recording(rs, vhdr, expert, use="guided", guidance="find")
    assert rid == "sub-x1/eeg/sub-x1_task-rest_eeg.vhdr"
    folder = rs.directory / "recordings" / "sub-x1" / "eeg"
    names = {p.name for p in folder.iterdir()}
    assert {"sub-x1_task-rest_eeg.vhdr", "sub-x1_task-rest_eeg.vmrk", "sub-x1_task-rest_eeg.eeg",
            "sub-x1_task-rest_events.tsv", "sub-x1_task-rest_channels.tsv"} <= names
    loaded = ReferenceSet.load(rs.directory)
    assert loaded.recordings[rid]["use"] == "guided" and loaded.guidance_for(rid) == "find"
    assert loaded.reference_document(rid).recording.recording_id == rid
    assert len(loaded.reference_document(rid).annotations) == len(plan)


# ------------------------------------------------------------- the programme
def _start(root, prompts=None, annotator="T01"):
    ctrl = AppController(prompts=prompts or ScriptedPrompts({"Save and Finish": True}), synchronous_loading=True)
    assert ctrl.begin(StartRequest(annotator, "", root, None, "practice", reference_set_id=EXAMPLE_SET_ID,
                                   programme=True))
    return ctrl


def _finish_with_show_me(ws):
    coach = ws.coach
    while not coach.complete:
        coach.show_me()
        wait(10)
        coach.next_step()
    assert ws.save_and_finish()
    wait(60)


def test_programme_path_stages_unlock_in_order(qapp, example, tmp_path):
    root, rs = example
    ctrl = _start(root)
    ctrl.log = InteractionLog(tmp_path / "visit.jsonl")
    path = ctrl.training_path
    assert path.isVisible() and not ctrl.start_window.isVisible()
    states = {s.key: s.status for s in path.states}
    assert states == {"guided": "available", "practice": "locked", "assessment": "not_used"}
    assert path.continue_btn.text() == "Start recording 1 of 2"
    # Stage 1, recording 1: the coach shows each expert annotation; Save waits for the last one.
    continue_programme(ctrl)
    ws = ctrl.workspace
    assert ws.session.mode == "guided" and ws.coach.guidance == "show"
    assert not ws.save_btn.isEnabled()
    assert not ws.save_and_finish()
    assert any(title == "Not finished yet" for k, title, _ in ctrl.prompts.log)
    coach = ws.coach
    t = coach.current.target
    store = ws.session.store
    store.add("EMG-artifact", t.onset_sample, t.duration_samples, t.channels)  # the wrong type
    wait()
    assert not coach.continue_btn.isEnabled() and coach.failed[0] == 1
    assert "Type:" in coach.feedback.text()
    wrong = store.annotations()[0].annotation_id
    store.set_label(wrong, t.label)  # put right with the same annotation
    wait()
    assert coach.continue_btn.isEnabled() and "Right type" in coach.feedback.text()
    QTest.keyClick(ws.browser, Qt.Key_Return)  # Enter continues
    wait()
    assert coach.index == 1 and coach.stars[0] == 2
    # A mark the experts did not make blocks Continue until it is deleted.
    t2 = coach.current.target
    store.add(t2.label, t2.onset_sample, t2.duration_samples, t2.channels)
    store.add("Sweat-artifact", int(57 * SF), int(1 * SF), ())
    wait()
    assert not coach.continue_btn.isEnabled() and "Nothing is marked at 57.00" in coach.feedback.text()
    store.delete(ws.controller.selected_id)
    wait()
    assert coach.continue_btn.isEnabled()
    coach.next_step()
    assert coach.stars[1] == 3
    _finish_with_show_me(ws)
    assert CompletionRegister(ctrl.layout).is_completed(rs.guided_recordings[0], "T01", "guided", EXAMPLE_SET_ID)
    assert not CompletionRegister(ctrl.layout).is_completed(rs.guided_recordings[0], "T01")  # never study work
    prog = load_progress(ctrl.layout, rs, "T01")
    summary = prog.guided[rs.guided_recordings[0]]
    assert summary["steps"] == 6 and summary["stars"] == 2 + 3 + 4 * 1 and summary["shown"] == 4
    assert path.isVisible() and "stars" in path.message.text()
    # Stage 1, recording 2: the type is named but the artifact must be found.
    continue_programme(ctrl)
    ws = ctrl.workspace
    assert ws.coach.guidance == "find" and not ws.coach._ghost
    assert ws.coach.title.text().startswith("Find the ")
    _finish_with_show_me(ws)
    states = {s.key: s.status for s in path.states}
    assert states["guided"] == "completed" and states["practice"] == "available"
    # Stage 2: annotate exactly as the experts did; the score passes and the programme is complete.
    continue_programme(ctrl)
    ws = ctrl.workspace
    assert ws.session.mode == "practice" and getattr(ws, "coach", None) is None
    ref = rs.reference_document(ws.session.recording_id)
    for a in ref.annotations:
        ws.session.store.add(a.label, a.onset_sample, a.duration_samples, a.channels)
    ctrl.prompts.answers["Practice feedback"] = "Continue"
    assert ws.save_and_finish()
    wait(60)
    feedback = [t for k, title, t in ctrl.prompts.log if title == "Practice feedback"][-1]
    assert "Passed:" in feedback
    assert load_progress(ctrl.layout, rs, "T01").practice_passed
    states = {s.key: s.status for s in path.states}
    assert states["practice"] == "completed" and path.next.stage is None
    assert path.continue_btn.isHidden()
    # The visit's log has the training events.
    ctrl.log.close()
    kinds = [json.loads(line)["type"] for line in (tmp_path / "visit.jsonl").read_text(encoding="utf-8").splitlines()]
    for kind in ("training_path_opened", "stage_started", "guided_step_started", "guided_check", "guided_show_me",
                 "guided_step_completed", "guided_recording_completed", "practice_scored", "stage_completed"):
        assert kind in kinds, kind
    leave_programme(ctrl)
    assert ctrl.start_window.isVisible() and not path.isVisible()
    ctrl.start_window.hide()


def test_practice_not_passed_offers_a_retry_and_flags_the_review(qapp, example):
    root, rs = example
    prompts = ScriptedPrompts({"Save and Finish": True, "Practice feedback": "Review in the viewer"})
    ctrl = _start(root, prompts)
    for _ in rs.guided_recordings:
        continue_programme(ctrl)
        _finish_with_show_me(ctrl.workspace)
    continue_programme(ctrl)
    ws = ctrl.workspace
    rid = ws.session.recording_id
    ref = rs.reference_document(rid)
    anns = sorted(ref.annotations, key=lambda a: a.onset_sample)
    ws.session.store.add("Sweat-artifact", anns[3].onset_sample, anns[3].duration_samples, ())  # another type
    ws.session.store.add(anns[0].label, anns[0].onset_sample, anns[0].duration_samples, anns[0].channels)
    ws.session.store.add("Rocking-patting-artifact", int(86 * SF), int(1 * SF), ())  # extra
    assert ws.save_and_finish()
    wait(80)
    feedback = [t for k, title, t in prompts.log if title == "Practice feedback"][-1]
    assert "Not yet:" in feedback
    review = ctrl.review_workspace
    kinds = {f["kind"] for f in review.review_flags}
    assert kinds == {"MISSED", "EXTRA", "TYPE"}
    prefixes = set(review.controller.display_prefix.values())
    assert "MISSED · REF: " in prefixes and "EXTRA · YOU: " in prefixes
    assert any(p.startswith("TYPE: should be") for p in prefixes)
    review.review_step(1)  # N goes to the first item
    first = review.review_flags[0]
    assert review.controller.selected_id == first["region"]
    QTest.keyClick(review.browser, Qt.Key_N)
    wait()
    assert review.controller.selected_id == review.review_flags[1]["region"]
    review.browser.close()
    wait(60)
    path = ctrl.training_path
    assert path.next.stage == "practice" and path.next.repeat and path.next.recording_id == rid
    # Try again: the same recording can be annotated once more (saved as a second attempt).
    continue_programme(ctrl)
    ws = ctrl.workspace
    assert ws.session.recording_id == rid and ws.session.allow_repeat
    for a in ref.annotations:
        ws.session.store.add(a.label, a.onset_sample, a.duration_samples, a.channels)
    prompts.answers["Practice feedback"] = "Continue"
    assert ws.save_and_finish()
    wait(60)
    assert load_progress(ctrl.layout, rs, "T01").practice_passed
    attempts = list((ctrl.layout.recording_dir("T01", rid, "practice", EXAMPLE_SET_ID)).glob("*attempt-02*"))
    assert attempts


def test_progress_is_rebuilt_from_saved_outputs(qapp, example):
    root, rs = example
    ctrl = _start(root)
    continue_programme(ctrl)
    _finish_with_show_me(ctrl.workspace)
    path_file = progress_path(ctrl.layout, rs.set_id, "T01")
    stars = json.loads(path_file.read_text(encoding="utf-8"))["guided"][rs.guided_recordings[0]]["stars"]
    path_file.unlink()
    rebuilt = load_progress(ctrl.layout, rs, "T01")
    assert rebuilt.guided[rs.guided_recordings[0]]["stars"] == stars
    states = programme_state(ctrl.layout, rs, "T01", rebuilt)
    assert states[0].done == 1 and next_step(ctrl.layout, rs, "T01", states).recording_id == rs.guided_recordings[1]
    leave_programme(ctrl)
    ctrl.start_window.hide()


def test_restored_work_skips_matched_steps(qapp, example):
    root, rs = example
    ctrl = _start(root)
    continue_programme(ctrl)
    ws = ctrl.workspace
    coach = ws.coach
    # As if restored from an autosave: the first two steps were already marked correctly.
    for s in coach.steps[:2]:
        t = s.target
        ws.session.store.add(t.label, t.onset_sample, t.duration_samples, t.channels)
    coach._start_step(0)
    coach._fast_forward()
    assert coach.index == 2 and coach.stars == {0: 3, 1: 3}
    ws._closing_ok = True
    ws.session.abandon()
    ws.browser.close()
    wait()
    leave_programme(ctrl)
    ctrl.start_window.hide()


def test_start_window_offers_the_programme(qapp, example):
    root, _ = example
    ctrl = AppController(prompts=ScriptedPrompts(), synchronous_loading=True)
    sw = ctrl.start_window
    sw.dataset.setText(str(root))
    sw.refresh()
    sw.annotator.setEditText("T01")
    sw.mode_practice.setChecked(True)
    assert sw.mode_practice.text() == "Training programme"
    sw.reference_combo.setCurrentIndex(sw.reference_combo.findData(EXAMPLE_SET_ID))
    req = sw.build_request()
    assert req.mode == "practice" and req.programme and req.reference_set_id == EXAMPLE_SET_ID
    assert ctrl.begin(req) and ctrl.training_path is not None
    leave_programme(ctrl)
    ctrl.start_window.hide()


def test_review_flags_tie_each_disagreement_to_an_annotation():
    ref = [ann("Eye-blink-artifact", 3.0, 0.4, aid="r1"), ann("EMG-artifact", 9.0, 1.0, aid="r2")]
    mine = [ann("Chewing-artifact", 9.0, 1.0, aid="m1"), ann("Sweat-artifact", 30.0, 1.0, aid="m2")]
    fb = {"missed": [{"label": "Eye-blink-artifact", "onset_s": 3.0, "offset_s": 3.4}],
          "extra": [{"label": "Sweat-artifact", "onset_s": 30.0, "offset_s": 31.0}],
          "label_differences": [{"reference_label": "EMG-artifact", "your_label": "Chewing-artifact",
                                 "onset_s": 9.0, "offset_s": 10.0}]}
    flags = review_flags(fb, mine, ref, SF)
    assert [(f["kind"], f["region"]) for f in flags] == [("MISSED", "ref-r1"), ("TYPE", "you-m1"), ("EXTRA", "you-m2")]


# ----------------------------------------------------------- administration
def test_admin_tools_create_the_example_and_save_programme_settings(qapp, dataset):
    from electroclean.training.gui import AdminDialog

    root, _ = dataset
    ctrl = AppController(prompts=ScriptedPrompts(), synchronous_loading=True)
    dlg = AdminDialog(ctrl, root, ctrl.prompts)
    dlg.create_example_set()
    rs = dlg.current_set()
    assert rs is not None and rs.set_id == EXAMPLE_SET_ID
    assert dlg.rec_table.rowCount() == 3
    uses = {dlg.rec_table.item(r, 1).text() for r in range(3)}
    assert uses == {"guided (show)", "guided (find)", "practice"}
    dlg.pass_f1.setValue(70)
    dlg.tol_seconds.setValue(0.3)
    dlg.save_programme()
    rs = ReferenceSet.load(rs.directory)
    assert rs.practice_pass["event_f1"] == pytest.approx(0.7)
    assert rs.guided["tolerance"]["seconds"] == pytest.approx(0.3)
    assert rs.guided["notes"]  # the notes survive a settings change
    dlg.close()


def test_cli_for_the_programme(qapp, dataset, tmp_path, capsys):
    from electroclean.training.cli import main

    root, _ = dataset
    assert main(["create-example-set", str(root)]) == 0
    assert main(["set-programme", str(root), "example", "--pass-f1", "0.9", "--tolerance-s", "0.25"]) == 0
    rs = ReferenceSet.load(reference_sets_dir(root, None) / "example")
    assert rs.practice_pass["event_f1"] == 0.9 and rs.guided["tolerance"]["seconds"] == 0.25
    rid = rs.guided_recordings[1]
    assert main(["set-guidance", str(root), "example", rid, "find_unnamed"]) == 0
    assert ReferenceSet.load(rs.directory).guidance_for(rid) == "find_unnamed"
    first = rs.reference_document(rs.guided_recordings[0]).annotations[0].annotation_id
    assert main(["set-note", str(root), "example", first, "Look at Fp1 and Fp2 first."]) == 0
    assert ReferenceSet.load(rs.directory).guided_note(first) == "Look at Fp1 and Fp2 first."
    src = tmp_path / "in" / "sub-y1" / "eeg"
    vhdr, plan, timing = write_recording(src, "sub-y1_task-rest", sfreq=SF, duration_s=20.0, seed=4)
    expert = tmp_path / "y1_annotations.json"
    write_annotations_json(expert, truth_document("x", plan, timing, CAT, annotator_id="E7"))
    assert main(["import-recording", str(root), "example", str(vhdr), str(expert), "--use", "practice"]) == 0
    assert "sub-y1/eeg/sub-y1_task-rest_eeg.vhdr" in ReferenceSet.load(rs.directory).practice_recordings
    assert main(["progress", str(root), "example", "--annotators", "T01"]) == 0
    assert "guided 0/2" in capsys.readouterr().out


def test_old_reference_sets_still_load(dataset):
    root, truths = dataset
    rs = ReferenceSet.create(reference_sets_dir(root, None), "old", experts=["E1"])
    data = json.loads(rs.path.read_text(encoding="utf-8"))
    for key in ("recordings_dir", "guided", "practice_pass"):
        data.pop(key, None)
    rs.path.write_text(json.dumps(data), encoding="utf-8")
    old = ReferenceSet.load(rs.directory)
    assert not old.self_contained and old.guided == {} and old.practice_pass == {}
    assert old.guided_recordings == [] and Path(old.directory).is_dir()
