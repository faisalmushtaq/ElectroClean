"""Training workflows through the real application controller (offscreen)."""

from __future__ import annotations

import pytest

pytest.importorskip("PySide6")

import pyqtgraph as pg  # noqa: E402
from qtpy.QtTest import QTest  # noqa: E402
from qtpy.QtWidgets import QApplication  # noqa: E402

from electroclean.app.annotations.labels import default_catalogue  # noqa: E402
from electroclean.app.annotations.model import AnnotationDocument  # noqa: E402
from electroclean.app.gui.app_controller import AppController  # noqa: E402
from electroclean.app.gui.dialogs import ScriptedPrompts  # noqa: E402
from electroclean.app.gui.start_window import StartRequest  # noqa: E402
from electroclean.app.session.register import CompletionRegister  # noqa: E402
from electroclean.config.settings import load_settings  # noqa: E402
from electroclean.training import admin  # noqa: E402
from electroclean.training.reference import QuizItem, ReferenceSet, reference_sets_dir  # noqa: E402
from tests.conftest import SUB1, SUB2  # noqa: E402

pytestmark = pytest.mark.gui
CAT = default_catalogue()


@pytest.fixture(scope="module")
def qapp():
    return pg.mkQApp("ElectroClean-tests")


def wait(ms=40):
    QTest.qWait(ms)
    QApplication.processEvents()


@pytest.fixture
def ref_set(dataset):
    root, truths = dataset
    _, study = load_settings(root)
    rs = ReferenceSet.create(reference_sets_dir(root, study), "pilot", name="Pilot", method="single_expert", experts=["E1"])
    rs.add_reference(AnnotationDocument(truths[SUB1].recording, "E1", list(truths[SUB1].annotations), CAT, session_id="e"),
                     use="practice", method="single_expert", experts=["E1"])
    rs.add_reference(AnnotationDocument(truths[SUB2].recording, "E1", list(truths[SUB2].annotations), CAT, session_id="e"),
                     use="assessment", method="single_expert", experts=["E1"])
    rs.set_criteria({"criteria": [{"metric": "event_f1", "threshold": 0.5}]})
    rs.add_quiz_item(QuizItem("q1", SUB2, 3.0, 3.4, "Eye-blink-artifact", explanation="Frontal, symmetrical"), CAT.label_names)
    rs.add_quiz_item(QuizItem("q2", SUB2, 14.0, 14.5, "Electrode-pops-artifact"), CAT.label_names)
    return root, truths, rs


def test_start_window_lists_reference_sets(qapp, ref_set):
    root, _, _ = ref_set
    ctrl = AppController(prompts=ScriptedPrompts(), synchronous_loading=True)
    sw = ctrl.start_window
    sw.dataset.setText(str(root))
    sw.refresh()
    sw.mode_practice.setChecked(True)
    sw.annotator.setEditText("CAM")
    req = sw.build_request()
    assert req.mode == "practice" and req.reference_set_id == "pilot"


def test_practice_mode_feedback_and_review(qapp, ref_set):
    root, truths, rs = ref_set
    prompts = ScriptedPrompts({"Practice feedback": "Review in the viewer", "Continue?": False})
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    assert ctrl.begin(StartRequest("CAM", "Cameron", root, None, "practice", reference_set_id="pilot"))
    ws = ctrl.workspace
    assert ws.session.recording_id == SUB1 and ws.session.mode == "practice"
    for a in truths[SUB1].annotations[:4]:
        ws.session.store.add(a.label, a.onset_sample, a.duration_samples, a.channels)
    assert ws.save_and_finish()
    wait()
    htmls = [t for k, title, t in prompts.log if k == "html" and title == "Practice feedback"]
    assert htmls and "You found <b>4 of" in htmls[0]
    review = ctrl.review_workspace
    assert review is not None and review.read_only
    prefixes = set(review.controller.display_prefix.values())
    assert prefixes == {"YOU: ", "REF: "}
    assert not review.save_action.isVisible()
    review.browser.close()
    wait()
    assert CompletionRegister(ctrl.layout).is_completed(SUB1, "CAM", "practice", "pilot")
    assert not CompletionRegister(ctrl.layout).is_completed(SUB1, "CAM")  # not a research annotation


def test_assessment_is_blinded_and_ends_with_report(qapp, ref_set):
    root, truths, rs = ref_set
    prompts = ScriptedPrompts()
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    assert ctrl.begin(StartRequest("CAM", "Cameron", root, None, "assessment", reference_set_id="pilot"))
    ws = ctrl.workspace
    assert ws.session.recording_id == SUB2  # only assessment recordings are offered
    for a in truths[SUB2].annotations:
        ws.session.store.add(a.label, a.onset_sample, a.duration_samples, a.channels)
    assert ws.save_and_finish()
    wait()
    kinds = [(k, title) for k, title, _ in prompts.log]
    assert ("html", "Practice feedback") not in kinds  # no feedback during assessment
    done = [t for k, title, t in prompts.log if title == "Assessment complete"]
    assert done and "Meets the competency criteria" in done[0]
    assert (ctrl.layout.root / "training" / "pilot" / "reports" / "annotator-CAM_competency_report.html").exists()


def test_quiz_window(qapp, ref_set):
    root, _, rs = ref_set
    prompts = ScriptedPrompts()
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    assert ctrl.begin(StartRequest("CAM", "", root, None, "assessment", reference_set_id="pilot", assessment_kind="quiz"))
    win = ctrl.quiz_window
    assert win is not None and win.browser is not None
    wait()
    first = win.quiz.current_item()
    win.answer(first.correct_label)
    win.show_item()
    win.answer("Sweat-artifact")
    win.show_item()
    wait()
    finished = [t for k, title, t in prompts.log if title == "Quiz complete"]
    assert finished and "1 of 2" in finished[0]
    saved = list((ctrl.layout.root / "training" / "pilot" / "quiz").glob("annotator-CAM_quiz_assessment_*.json"))
    assert len(saved) == 1


def test_admin_tools_require_passphrase(qapp, ref_set):
    root, _, _ = ref_set
    admin.set_admin_passphrase(root, "letmein123")
    wrong = ScriptedPrompts({"Administrator passphrase": "nope"})
    ctrl = AppController(prompts=wrong, synchronous_loading=True)
    ctrl.open_admin(root)
    assert ctrl.admin_dialog is None
    right = ScriptedPrompts({"Administrator passphrase": "letmein123"})
    ctrl = AppController(prompts=right, synchronous_loading=True)
    ctrl.open_admin(root)
    dlg = ctrl.admin_dialog
    assert dlg is not None
    assert dlg.current_set().set_id == "pilot"
    assert dlg.rec_table.rowCount() == 2
    # Criteria editing round-trips.
    dlg.crit_rows["event_recall"][0].setChecked(True)
    dlg.crit_rows["event_recall"][1].setValue(0.8)
    dlg.save_criteria()
    rs = ReferenceSet.load(dlg.current_set().directory)
    metrics = {c["metric"] for c in rs.criteria["criteria"]}
    assert metrics == {"event_f1", "event_recall"}
    dlg.close()


def test_reference_set_assignment_is_enforced(qapp, ref_set):
    root, _, rs = ref_set
    rs.assigned_annotators = ["A01"]
    rs.save()
    prompts = ScriptedPrompts()
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    assert not ctrl.begin(StartRequest("CAM", "", root, None, "practice", reference_set_id="pilot"))
    assert any(title == "Not assigned" for _k, title, _t in prompts.log)
    assert ctrl.workspace is None


def test_skipped_assessment_is_not_reported_as_complete(qapp, ref_set):
    root, _, _ = ref_set
    prompts = ScriptedPrompts({"Close without saving": "Discard and close"})
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    assert ctrl.begin(StartRequest("CAM", "", root, None, "assessment", reference_set_id="pilot"))
    ctrl.workspace.browser.close()  # discard, then continue
    wait()
    titles = [title for _k, title, _t in prompts.log]
    assert "Assessment complete" not in titles and "Assessment not finished" in titles
    assert not (ctrl.layout.root / "training" / "pilot" / "reports").exists()


def test_last_assessment_recording_reports_even_when_quitting(qapp, ref_set):
    root, truths, _ = ref_set
    prompts = ScriptedPrompts({"Continue?": False})
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    assert ctrl.begin(StartRequest("CAM", "", root, None, "assessment", reference_set_id="pilot"))
    ws = ctrl.workspace
    for a in truths[SUB2].annotations:
        ws.session.store.add(a.label, a.onset_sample, a.duration_samples, a.channels)
    assert ws.save_and_finish()
    wait()
    assert (ctrl.layout.root / "training" / "pilot" / "reports" / "annotator-CAM_competency_report.json").exists()


def test_review_window_is_released_after_closing(qapp, ref_set):
    root, truths, _ = ref_set
    prompts = ScriptedPrompts({"Practice feedback": "Review in the viewer", "Continue?": False})
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    assert ctrl.begin(StartRequest("CAM", "", root, None, "practice", reference_set_id="pilot"))
    ws = ctrl.workspace
    ws.session.store.add(truths[SUB1].annotations[0].label, 250, 100, ())
    assert ws.save_and_finish()
    wait()
    review = ctrl.review_workspace
    assert review is not None
    rid = review.session.store.annotations()[0].annotation_id
    review.controller.delete(rid)  # read-only: nothing changes
    assert rid in review.session.store
    review.browser.close()
    wait()
    assert ctrl.review_workspace is None


def test_closing_the_quiz_early_saves_incomplete_answers(qapp, ref_set):
    import json

    root, _, _ = ref_set
    prompts = ScriptedPrompts({"Stop the quiz?": True})
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    assert ctrl.begin(StartRequest("CAM", "", root, None, "assessment", reference_set_id="pilot", assessment_kind="quiz"))
    win = ctrl.quiz_window
    win.answer(win.quiz.current_item().correct_label)
    win.close()
    wait()
    (saved,) = (ctrl.layout.root / "training" / "pilot" / "quiz").glob("annotator-CAM_quiz_*.json")
    data = json.loads(saved.read_text(encoding="utf-8"))
    assert data["completed"] is False and len(data["answers"]) == 1
    assert ctrl.quiz_window is None and ctrl.start_window.isVisible()


def test_admin_tools_report_a_malformed_study_file(qapp, ref_set):
    root, _, _ = ref_set
    admin.study_config_path(root).write_text('{"study_id": "x", oops}', encoding="utf-8")
    prompts = ScriptedPrompts()
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    ctrl.open_admin(root)
    assert ctrl.admin_dialog is None
    assert any("cannot be read" in t for k, _title, t in prompts.log if k == "error")
