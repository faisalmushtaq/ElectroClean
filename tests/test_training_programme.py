"""The training programme's rules: Stage 1 (learn with the experts, step by step) and Stage 2 (on
your own, with a pass mark and flags in the review), self-contained and example sets, and the
administrator's commands. The browser's coach and review are tested with the web server
(tests/test_web_server.py) and in the browser (web_tests/)."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from electrotag.app.annotations.labels import default_catalogue
from electrotag.app.annotations.model import ArtifactAnnotation
from electrotag.app.io.canonical import write_annotations_json
from electrotag.app.io.discovery import discover_recordings
from electrotag.synthetic import truth_document, write_recording
from electrotag.training.examples import create_example_training_set
from electrotag.training.guided import (
    Step,
    Tolerance,
    build_steps,
    check_step,
    extras,
    stars_for,
)
from electrotag.training.programme import PassRule
from electrotag.training.reference import (
    ReferenceSet,
    import_expert_recording,
    reference_sets_dir,
)
from electrotag.training.review import review_flags

CAT = default_catalogue()
SF = 250.0


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
    tol = Tolerance.from_dict({"seconds": 0.05, "fraction": 0.0,
                               "accepted_labels": {"Eye-blink-artifact": ["Eye-artifact"]}})
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
    fb = {"overall": {"event_f1": 0.85, "label_accuracy": 0.9},
          "per_category": [{"reference_events": 5, "your_events": 5}]}
    assert rule.evaluate(fb)["passed"]
    fb["overall"]["label_accuracy"] = 0.5
    assert not rule.evaluate(fb)["passed"]
    clean = {"overall": {"event_f1": float("nan"), "label_accuracy": float("nan")}, "per_category": []}
    assert rule.evaluate(clean)["passed"]  # a clean recording left clean
    assert "80%" in rule.describe()
    with pytest.raises(ValueError):
        PassRule.from_dict({"event_f1": 2})


# ------------------------------------------------------------------ the example set
def test_example_set_is_self_contained_and_never_a_study_recording(example):
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
    assert not any("example" in r.recording_id for r in discover_recordings(root))  # never study work


def test_import_a_real_expert_recording_into_a_set(dataset, tmp_path):
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


# ------------------------------------------------------------- the review
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
def test_cli_for_the_programme(dataset, tmp_path, capsys):
    from electrotag.training.cli import main

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


def test_a_simulated_eye_movement_shows_where_it_really_would():
    """Largest on the horizontal EOG and beside the eyes, smaller above them, opposite on the two sides."""
    import numpy as np

    from electrotag.synthetic import ALL_CHANNELS, EYE_MOVEMENT_CHANNELS, SyntheticArtifact, synthesise_signal

    plan = [SyntheticArtifact("Horizontal-eye-movement-artifact", 5.0, 1.2, EYE_MOVEMENT_CHANNELS)]
    data = synthesise_signal(plan, SF, 10.0, 50.0, np.random.default_rng(1))
    base = synthesise_signal([], SF, 10.0, 50.0, np.random.default_rng(1))
    mid = slice(int(5.4 * SF), int(5.8 * SF))
    shift = {c: float((data[i, mid] - base[i, mid]).mean() * 1e6) for i, c in enumerate(ALL_CHANNELS)}
    assert shift["HEOG"] > 150 and shift["F7"] > 60 and shift["F8"] < -60
    assert shift["Fp1"] > 25 and shift["Fp2"] < -25
    assert abs(shift["O1"]) < 1 and abs(shift["Cz"]) < 1
    assert EYE_MOVEMENT_CHANNELS == ("Fp1", "Fp2", "F7", "F8", "HEOG")
