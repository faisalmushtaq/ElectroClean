"""Training, reference sets, consensus, competency assessment and quiz (Component C)."""

from __future__ import annotations

import json

import pytest

from electroclean.app.annotations.labels import default_catalogue
from electroclean.app.annotations.model import AnnotationDocument, AnnotationError, ArtifactAnnotation, RecordingInfo
from electroclean.app.annotations.timing import RecordingTiming
from electroclean.app.eeg.loading import load_recording
from electroclean.app.io.canonical import write_annotations_json
from electroclean.app.io.discovery import discover_recordings
from electroclean.app.io.naming import OutputLayout
from electroclean.app.session.session import AnnotationSession
from electroclean.config.settings import load_settings
from electroclean.training import admin
from electroclean.training.assessment import (
    CompetencyCriteria,
    _analysis_config,
    compare_with_reference,
    competency_report,
    evaluate_criteria,
    practice_feedback,
    verify_competency_report,
)
from electroclean.training.consensus import build_consensus
from electroclean.training.quiz import NONE_OPTION, QuizSession, item_order
from electroclean.training.reference import (
    QuizItem,
    ReferenceSet,
    ReferenceSetError,
    import_expert_reference,
    load_reference_set_by_id,
    reference_sets_dir,
)

CAT = default_catalogue()
CH = ("C1", "C2", "C3", "C4")


def doc(annotator, anns, rid="rec.vhdr", n=1000, sf=100.0):
    rec = RecordingInfo(rid, RecordingTiming(sf, n), CH)
    items = [ArtifactAnnotation(f"{annotator}{i}", lab, int(a * sf), int((b - a) * sf), tuple(c)) for i, (lab, a, b, c) in enumerate(anns)]
    return AnnotationDocument(rec, annotator, items, CAT, session_id=annotator)


# ---------------------------------------------------------------- consensus
def test_consensus_majority_in_time_and_channels():
    e1 = doc("E1", [("EMG-artifact", 1, 3, ())])
    e2 = doc("E2", [("EMG-artifact", 2, 4, ("C1",))])
    e3 = doc("E3", [("EMG-artifact", 2.5, 5, ())])
    res = build_consensus([e1, e2, e3])
    assert res.rule["min_agreement"] == 2
    (ann,) = res.document.annotations
    assert (ann.onset_sample, ann.end_sample) == (200, 400)
    assert ann.is_global  # two of three experts used whole montage
    times = [(d["onset_s"], d["offset_s"], d["note"]) for d in res.disagreements if d["kind"] == "time"]
    assert (1.0, 2.0, "1 of 3 experts; not in consensus") in times
    assert (4.0, 5.0, "1 of 3 experts; not in consensus") in times
    unanimous = build_consensus([e1, e2, e3], min_agreement=3)
    assert [(a.onset_sample, a.end_sample) for a in unanimous.document.annotations] == [(250, 300)]


def test_consensus_disagreements_are_exact():
    blink = "Eye-blink-artifact"
    # Adjacent stretches marked by different single experts are listed separately.
    res = build_consensus([doc("A", [(blink, 1, 2, ())]), doc("B", [(blink, 2, 3, ())]), doc("C", [])])
    rows = [(d["onset_s"], d["offset_s"], d["experts_marking"]) for d in res.disagreements if d["kind"] == "time"]
    assert rows == [(1.0, 2.0, "A"), (2.0, 3.0, "B")]
    # The note reflects the final consensus after the minimum-duration rule.
    res = build_consensus([doc("A", [(blink, 1, 1.05, ())]), doc("B", [(blink, 1, 1.05, ())]), doc("C", [])],
                          min_duration_s=0.1)
    assert res.document.annotations == []
    (d,) = res.disagreements
    assert d["note"].startswith("2 of 3 experts; not in consensus")
    # Partial channel disagreements are listed, with every expert's selection.
    e1 = doc("A", [("Electrode-pops-artifact", 1, 2, ("C1", "C2"))])
    e2 = doc("B", [("Electrode-pops-artifact", 1, 2, ("C1",))])
    e3 = doc("C", [("Electrode-pops-artifact", 1, 2, ("C1", "C3"))])
    res = build_consensus([e1, e2, e3])
    assert res.document.annotations[0].channels == ("C1",)
    (d,) = [d for d in res.disagreements if d["kind"] == "channels"]
    assert "A: C1,C2" in d["note"] and "consensus: C1" in d["note"]
    # Unanimous channel choices are not disagreements.
    same = [doc(x, [("Electrode-pops-artifact", 1, 2, ("C1",))]) for x in "ABC"]
    assert build_consensus(same).disagreements == []


def test_competency_status_needs_evaluated_criteria():
    blink, emg = "Eye-blink-artifact", "EMG-artifact"
    ref = doc("REFERENCE", [(blink, 1, 1.3, ()), (blink, 4, 4.3, ()), (emg, 6, 7, ())])
    nothing = doc("CAM", [])
    metrics = compare_with_reference([nothing], [ref], _analysis_config(None))
    crit = CompetencyCriteria.from_dict({"criteria": [{"metric": "event_recall", "threshold": 0.7,
                                                       "scope": "each_category"}], "min_reference_events": 3})
    ev = evaluate_criteria(metrics, crit)
    assert ev["status"] == "not_determined" and ev["checks"][0]["passed"] is None
    # A recording that cannot be compared with the reference makes the result undetermined.
    odd = AnnotationDocument(RecordingInfo("rec.vhdr", RecordingTiming(100.0, 999), CH), "CAM", [], CAT)
    metrics = compare_with_reference([odd], [ref], _analysis_config(None))
    assert metrics["recordings_not_compared"] == ["rec.vhdr"] and metrics["warnings"]
    assert metrics["minutes_assessed"] == 0
    crit = CompetencyCriteria.from_dict({"criteria": [{"metric": "event_recall", "threshold": 0.1}]})
    assert evaluate_criteria(metrics, crit)["status"] == "not_determined"


def test_consensus_channel_vote():
    e1 = doc("E1", [("Electrode-pops-artifact", 1, 2, ("C1", "C2"))])
    e2 = doc("E2", [("Electrode-pops-artifact", 1, 2, ("C2",))])
    e3 = doc("E3", [("Electrode-pops-artifact", 1, 2, ("C2", "C3"))])
    (ann,) = build_consensus([e1, e2, e3]).document.annotations
    assert ann.channels == ("C2",)


def test_consensus_requires_comparable_experts():
    with pytest.raises(AnnotationError):
        build_consensus([doc("E1", [])])
    with pytest.raises(AnnotationError):
        build_consensus([doc("E1", []), doc("E2", [], n=2000)])


# ----------------------------------------------------------- reference sets
def test_reference_set_provenance_and_integrity(tmp_path):
    rs = ReferenceSet.create(tmp_path, "pilot", name="Pilot", method="single_expert", experts=["E1"])
    e1 = doc("E1", [("Eye-blink-artifact", 1, 1.4, ("C1",))])
    src = tmp_path / "e1_annotations.json"
    write_annotations_json(src, e1)
    import_expert_reference(rs, src, use="practice")
    rs2 = ReferenceSet.load(rs.directory)
    assert rs2.practice_recordings == ["rec.vhdr"]
    ref = rs2.reference_document("rec.vhdr")
    assert ref.annotator_id == "REFERENCE" and ref.context["provenance"]["method"] == "single_expert"
    assert ref.context["provenance"]["sources"][0]["sha256"]
    with pytest.raises(ReferenceSetError):
        rs2.add_reference(e1, use="assessment", method="adjudicated", experts=["E1", "E2"])  # no adjudicator
    with pytest.raises(ReferenceSetError):
        rs2.add_reference(e1, use="assessment", method="consensus", experts=["E1"])
    # Tampering with a reference file is detected.
    path = rs2.reference_path("rec.vhdr")
    path.write_text(path.read_text().replace('"Eye-blink-artifact"', '"Eye-blink-artifact" '))
    with pytest.raises(ReferenceSetError):
        rs2.reference_document("rec.vhdr")
    with pytest.raises(ReferenceSetError):
        ReferenceSet.create(tmp_path, "pilot")


def test_practice_feedback_lists_misses_extras_and_label_differences():
    ref = doc("REFERENCE", [("Eye-blink-artifact", 1, 1.4, ()), ("EMG-artifact", 3, 4, ()), ("Electrode-pops-artifact", 6, 6.3, ("C1",))])
    mine = doc("CAM", [("Eye-blink-artifact", 1.05, 1.4, ()), ("Chewing-artifact", 3, 4, ()), ("Sweat-artifact", 8, 9, ())])
    fb = practice_feedback(mine, ref)
    assert fb["overall"]["event_recall"] == pytest.approx(1 / 3)
    # Each disagreement is listed once: the EMG artifact marked as chewing is a label difference,
    # not also a missed and an extra event.
    assert {m["label"] for m in fb["missed"]} == {"Electrode-pops-artifact"}
    assert {e["label"] for e in fb["extra"]} == {"Sweat-artifact"}
    (diff,) = fb["label_differences"]
    assert (diff["reference_label"], diff["your_label"]) == ("EMG-artifact", "Chewing-artifact")
    assert fb["overall"]["label_accuracy"] == pytest.approx(0.5)
    assert fb["overall"]["false_positives_per_min"] == pytest.approx(1 / (10 / 60))  # only the sweat event


def test_criteria_validation():
    with pytest.raises(ValueError):
        CompetencyCriteria.from_dict({"criteria": [{"metric": "accuracy", "threshold": 0.9}]})
    with pytest.raises(ValueError):
        CompetencyCriteria.from_dict({"criteria": [{"metric": "label_accuracy", "threshold": 0.9, "scope": "each_category"}]})
    assert CompetencyCriteria.from_dict(None).criteria == []


# ------------------------------------------------ full assessment workflow
@pytest.fixture
def training_dataset(dataset):
    """Reference set built from the synthetic ground truth: sub-001 practice, both for assessment."""
    root, truths = dataset
    settings, study = load_settings(root)
    rs = ReferenceSet.create(reference_sets_dir(root, study), "pilot", name="Pilot set", method="single_expert",
                             experts=["EXPERT1"])
    ids = sorted(truths)
    for rid in ids:
        truth = truths[rid]
        expert = AnnotationDocument(truth.recording, "EXPERT1", list(truth.annotations), CAT, session_id="x")
        rs.add_reference(expert, use="assessment", method="single_expert", experts=["EXPERT1"])
    rs.recordings[ids[0]]["use"] = "practice"
    rs.save()
    rs = load_reference_set_by_id(root, study, "pilot")
    # A second, assessment-only copy of the first recording is not possible (one use per recording),
    # so the assessment uses the second recording only.
    return root, truths, rs, settings


def _annotate(root, rs, settings, rid, annotator, mode, anns):
    rec = {r.recording_id: r for r in discover_recordings(root)}[rid]
    lr = load_recording(rec, settings, settings.filters, CAT)
    s = AnnotationSession(layout=OutputLayout(root / "Annotated_Events"), settings=settings, filters=settings.filters,
                          catalogue=CAT, loaded=lr, annotator_id=annotator, mode=mode,
                          context={"reference_set_id": rs.set_id})
    s.start()
    s.start_timer()
    for a in anns:
        s.store.add(a.label, a.onset_sample, a.duration_samples, a.channels)
    res = s.finish()
    lr.close()
    return res


def test_competency_report_workflow(training_dataset):
    root, truths, rs, settings = training_dataset
    layout = OutputLayout(root / "Annotated_Events")
    assess = rs.assessment_recordings
    assert len(assess) == 1
    rid = assess[0]
    rep = competency_report(layout, rs, "CAM")
    assert rep["status"] == "incomplete" and rep["missing_recordings"] == [rid]
    # Cameron annotates the assessment recording: everything except one blink, plus one extra annotation.
    truth = truths[rid].annotations
    blinks = [a for a in truth if a.label == "Eye-blink-artifact"]
    mine = [a for a in truth if a is not blinks[0]]
    mine.append(ArtifactAnnotation("x", "Sweat-artifact", 100, 200, ()))
    _annotate(root, rs, settings, rid, "CAM", "assessment", mine)
    # Assessment outputs are kept apart from research annotations.
    assert (layout.root / "training" / "pilot" / "assessment" / "annotator-CAM").exists()
    assert not (layout.root / "annotator-CAM").exists()
    rep = competency_report(layout, rs, "CAM")
    assert rep["status"] == "not_determined"  # no criteria set yet
    o = rep["metrics"]["overall"]
    assert o["event_recall"] == pytest.approx((len(truth) - 1) / len(truth))
    assert o["label_accuracy"] == pytest.approx(1.0)
    assert {m["label"] for m in rep["metrics"]["missed"]} == {"Eye-blink-artifact"}
    rs.set_criteria({"criteria": [{"metric": "event_f1", "threshold": 0.8},
                                  {"metric": "event_recall", "threshold": 0.95}], "min_reference_events": 3})
    rep = competency_report(layout, rs, "CAM")
    assert rep["status"] == "not_met"
    assert [c["passed"] for c in rep["checks"]] == [True, False]
    rs.set_criteria({"criteria": [{"metric": "event_f1", "threshold": 0.8},
                                  {"metric": "event_recall", "threshold": 0.8, "scope": "each_category"}],
                     "min_reference_events": 3})
    rep1 = competency_report(layout, rs, "CAM")
    rep2 = competency_report(layout, rs, "CAM")
    assert rep1["results_sha256"] == rep2["results_sha256"]  # reproducible
    saved_path = layout.root / "training" / "pilot" / "reports" / "annotator-CAM_competency_report.json"
    saved = json.loads(saved_path.read_text())
    assert saved["results_sha256"] == rep1["results_sha256"]
    assert verify_competency_report(saved_path)
    assert "Eye-blink-artifact" in {c["where"] for c in rep1["checks"]}
    # Rewriting reference_set.json without changing the assessment (assigning annotators) keeps the digest.
    rs.assigned_annotators = ["CAM"]
    rs.save()
    assert competency_report(layout, rs, "CAM")["results_sha256"] == rep1["results_sha256"]
    saved["metrics"]["overall"]["event_f1"] = 1.0
    saved_path.write_text(json.dumps(saved))
    assert not verify_competency_report(saved_path)


# --------------------------------------------------------------------- quiz
def test_quiz_session(tmp_path, training_dataset):
    root, truths, rs, settings = training_dataset
    rid = rs.assessment_recordings[0]
    items = [QuizItem("q1", rid, 3.0, 3.4, "Eye-blink-artifact"),
             QuizItem("q2", rid, 14.0, 14.5, "Electrode-pops-artifact", ["Electrode-movement-artifact"]),
             QuizItem("q3", rid, 24.0, 26.0, "Movement-artifact")]
    for it in items:
        rs.add_quiz_item(it, CAT.label_names)
    with pytest.raises(ReferenceSetError):
        rs.add_quiz_item(QuizItem("bad", rid, 1, 2, "Not-a-label"), CAT.label_names)
    assert [i.item_id for i in item_order(rs.quiz_items, "CAM", "pilot")] == [i.item_id for i in item_order(rs.quiz_items, "CAM", "pilot")]
    q = QuizSession(rs, "CAM", "assessment")
    answers = {"q1": "Eye-blink-artifact", "q2": "Electrode-movement-artifact", "q3": "EMG-artifact"}
    while not q.finished:
        q.item_shown()
        q.answer(answers[q.current_item().item_id])
    s = q.score()
    assert (s["n_correct"], s["n_items"]) == (2, 3)
    assert s["confusion"]["Movement-artifact"] == {"EMG-artifact": 1}
    path = q.save(OutputLayout(root / "Annotated_Events"))
    data = json.loads(path.read_text())
    assert data["score"]["n_correct"] == 2 and len(data["answers"]) == 3
    rs.quiz["include_none_option"] = True
    assert QuizSession(rs, "CAM", "practice").options(CAT.label_names)[-1] == NONE_OPTION


# -------------------------------------------------------------------- admin
def test_admin_study_configuration(dataset):
    root, _ = dataset
    rec = admin.hash_passphrase("secret-phrase")
    assert admin.verify_passphrase("secret-phrase", rec) and not admin.verify_passphrase("wrong", rec)
    with pytest.raises(ValueError):
        admin.hash_passphrase("abc")
    admin.set_annotators(root, [("a01", "Annotator one"), ("CAM", "Cameron")], allow_unlisted=False)
    with pytest.raises(Exception):
        admin.set_annotators(root, [("A 01", "")], allow_unlisted=False)
    from electroclean.config.settings import FilterSettings

    admin.fix_filters(root, FilterSettings(notch_hz=50.0))
    settings, study = load_settings(root)
    assert settings.filters.locked and settings.filters.notch_hz == 50.0
    assert [a.annotator_id for a in study.annotators] == ["A01", "CAM"] and not study.allow_unlisted_annotators
    from tests.conftest import SUB1, SUB2

    assign = admin.make_balanced_allocation(root, [SUB1, SUB2], ["A01", "CAM"], 2, seed=5)
    settings, study = load_settings(root)
    assert settings.selection_strategy == "manual"
    assert set(study.manual_assignments["CAM"]) == {SUB1, SUB2} == set(assign["A01"])


def test_admin_cli_end_to_end(training_dataset, capsys):
    from electroclean.training.cli import main

    root, truths, rs, settings = training_dataset
    assert main(["init-study", str(root), "--study-id", "pilot-2026", "--annotators", "CAM:Cameron"]) == 0
    assert main(["set-criteria", str(root), "pilot", "--criterion", "event_f1:0.7"]) == 0
    assert main(["report", str(root), "pilot", "cam"]) == 0
    out = capsys.readouterr().out
    assert "Incomplete" in out
    e = AnnotationDocument(truths[rs.assessment_recordings[0]].recording, "E2",
                           list(truths[rs.assessment_recordings[0]].annotations), CAT, session_id="e")
    f1 = root / "e1_annotations.json"
    f2 = root / "e2_annotations.json"
    write_annotations_json(f1, AnnotationDocument(e.recording, "E1", e.annotations[:-1], CAT, session_id="e"))
    write_annotations_json(f2, e)
    assert main(["create-reference-set", str(root), "cons", "--method", "consensus", "--experts", "E1", "E2"]) == 0
    assert main(["build-consensus", str(root), "cons", str(f1), str(f2), "--use", "assessment",
                 "--disagreements", str(root / "dis.tsv")]) == 0
    assert (root / "dis.tsv").read_text().startswith("kind\tlabel")
    assert main(["show", str(root)]) == 0
    assert "secret" not in capsys.readouterr().out


def test_quiz_clean_segment_needs_none_option(tmp_path):
    rs = ReferenceSet.create(tmp_path, "q")
    item = QuizItem("clean", "rec.vhdr", 1.0, 2.0, NONE_OPTION)
    with pytest.raises(ReferenceSetError):
        rs.add_quiz_item(item, CAT.label_names)
    rs.quiz["include_none_option"] = True
    rs.add_quiz_item(item, CAT.label_names)
    quiz = QuizSession(rs, "CAM", "practice")
    assert NONE_OPTION in quiz.options(CAT.label_names)
    assert quiz.answer(NONE_OPTION) is True
