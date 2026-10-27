"""Training and assessment usability: what annotators and administrators see (review findings)."""

from __future__ import annotations

import json

import pytest

pytest.importorskip("PySide6")

import pyqtgraph as pg  # noqa: E402
from qtpy.QtCore import Qt  # noqa: E402
from qtpy.QtTest import QTest  # noqa: E402
from qtpy.QtWidgets import QApplication, QLabel  # noqa: E402

from electroclean.app.annotations.labels import default_catalogue  # noqa: E402
from electroclean.app.annotations.model import AnnotationDocument  # noqa: E402
from electroclean.app.gui.app_controller import AppController  # noqa: E402
from electroclean.app.gui.dialogs import ScriptedPrompts  # noqa: E402
from electroclean.app.gui.start_window import StartRequest  # noqa: E402
from electroclean.app.io.canonical import write_annotations_json  # noqa: E402
from electroclean.app.io.naming import OutputLayout  # noqa: E402
from electroclean.app.session.register import CompletionRegister  # noqa: E402
from electroclean.config.settings import load_settings  # noqa: E402
from electroclean.training import admin  # noqa: E402
from electroclean.training.assessment import (  # noqa: E402
    METRICS,
    competency_html,
    competency_report,
    competency_summary_html,
    matching_in_words,
    verify_competency_report,
)
from electroclean.training.gui import AdminDialog, QuizWindow, practice_complete_text  # noqa: E402
from electroclean.training.quiz import QuizSession  # noqa: E402
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


def _doc(truth, annotator="E1", anns=None):
    return AnnotationDocument(truth.recording, annotator, list(truth.annotations if anns is None else anns), CAT,
                              session_id="e")


@pytest.fixture
def ref_set(dataset):
    root, truths = dataset
    _, study = load_settings(root)
    rs = ReferenceSet.create(reference_sets_dir(root, study), "pilot", name="Pilot", method="single_expert",
                             experts=["E1", "E2"])
    rs.add_reference(_doc(truths[SUB1]), use="practice", method="single_expert", experts=["E1"])
    rs.add_reference(_doc(truths[SUB2]), use="assessment", method="consensus", experts=["E1", "E2", "E3"],
                     details={"consensus_rule": {"min_agreement": 2, "experts": ["E1", "E2", "E3"]}})
    rs.set_criteria({"criteria": [{"metric": "event_f1", "threshold": 0.5}]})
    rs.add_quiz_item(QuizItem("q1", SUB2, 3.0, 3.4, "Eye-blink-artifact", ["Eye-artifact"], "Frontal"), CAT.label_names)
    return root, truths, rs


def _assess(root, truths, prompts, drop=0):
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    assert ctrl.begin(StartRequest("CAM", "", root, None, "assessment", reference_set_id="pilot"))
    ws = ctrl.workspace
    for a in truths[SUB2].annotations[drop:]:
        ws.session.store.add(a.label, a.onset_sample, a.duration_samples, a.channels)
    return ctrl, ws


# ------------------------------------------------------------ item 3: blinding
def test_reference_set_report_setting_defaults_off_and_reads_the_old_key(ref_set):
    _, _, rs = ref_set
    assert rs.show_full_report_to_annotator is False
    data = json.loads(rs.path.read_text(encoding="utf-8"))
    data.pop("show_full_report_to_annotator")
    data["quiz"]["show_report_to_annotator"] = True  # a set written before version 1.1
    rs.path.write_text(json.dumps(data), encoding="utf-8")
    old = ReferenceSet.load(rs.directory)
    assert old.show_full_report_to_annotator is True
    old.show_full_report_to_annotator = False
    old.save()
    assert ReferenceSet.load(rs.directory).show_full_report_to_annotator is False  # the new key wins


def test_annotators_see_only_a_summary_at_the_end_of_the_assessment(qapp, ref_set):
    root, truths, rs = ref_set
    prompts = ScriptedPrompts()
    ctrl, ws = _assess(root, truths, prompts, drop=2)  # two reference artifacts missed
    assert "assessment recording 1 of 1" in ws.browser.windowTitle()
    assert ws.save_and_finish()
    wait()
    (summary,) = [t for k, title, t in prompts.log if title == "Assessment complete"]
    assert "competency criteria" in summary and "Criteria" in summary
    for secret in ("not found", "Missed", "onset", "Start (s)", "Channels"):
        assert secret not in summary
    full = ctrl.layout.root / "training" / "pilot" / "reports" / "annotator-CAM_competency_report.html"
    assert "Reference artifacts not found (2)" in full.read_text(encoding="utf-8")  # the administrator's report


def test_full_report_offered_only_when_the_set_allows_it(qapp, ref_set, monkeypatch):
    root, truths, rs = ref_set
    rs.show_full_report_to_annotator = True
    rs.save()
    prompts = ScriptedPrompts()
    seen = []
    monkeypatch.setattr(prompts, "show_html", lambda parent, title, html, buttons: seen.append((title, buttons)) or "Close")
    ctrl, ws = _assess(root, truths, prompts)
    assert ws.save_and_finish()
    wait()
    assert ("Assessment complete", ["Open the full report", "Close"]) in seen


# ---------------------------------------------------- items 4 and 12: the report
def test_report_gives_each_assessment_references_provenance_and_stays_reproducible(ref_set):
    root, truths, rs = ref_set
    layout = OutputLayout(root / "Annotated_Events")
    write_annotations_json(layout.annotator_dir("CAM", "assessment", "pilot") / "x_annotations.json",
                           AnnotationDocument(truths[SUB2].recording, "CAM", list(truths[SUB2].annotations), CAT,
                                              session_id="s", mode="assessment"))
    rep = competency_report(layout, rs, "CAM")
    prov = rep["reference_provenance"][SUB2]
    assert prov["method"] == "consensus" and prov["experts"] == ["E1", "E2", "E3"] and prov["min_agreement"] == 2
    assert "declared" in rep["reference_set"]["provenance_note"]
    again = competency_report(layout, rs, "CAM")
    assert again["results_sha256"] == rep["results_sha256"]
    assert verify_competency_report(rep["paths"]["json"])
    import html as html_module

    page = html_module.unescape(competency_html(rep))
    assert "consensus of several experts: E1, E2, E3 (2 needed to agree)" in page
    assert "Declared when the reference set was created: one expert's annotations: E1, E2" in page
    assert "Glossary" in page and METRICS["time_kappa"]["description"] in page
    assert "match_criterion" not in page and "reference_events" not in page  # no raw names
    assert "at least 20% (intersection over union)" in page
    assert "Kappa over time" in page and "<td class='cat'>Eye-blink-artifact</td>" in page


def test_summary_and_matching_texts():
    rep = {"reference_set": {"set_id": "s", "name": "Set"}, "status": "not_met",
           "status_text": "Does not yet meet the competency criteria.",
           "checks": [{"criterion": "F1 ≥ 0.8 (overall)", "where": "overall", "value": 0.5, "passed": False}]}
    html = competency_summary_html(rep)
    assert "talk to your study administrator" in html and "not met" in html
    assert matching_in_words({"match_criterion": "tolerance", "onset_tolerance_s": 0.5, "offset_tolerance_s": 1,
                              "allow_many_to_one": True}).startswith(
        "An annotation matched a reference artifact when they had starts within 0.5 s and ends within 1 s")


# ------------------------------------------------- items 5, 6, 9, 10, 13: admin
def _admin(root, prompts=None):
    ctrl = AppController(prompts=prompts or ScriptedPrompts(), synchronous_loading=True)
    return ctrl, AdminDialog(ctrl, root, ctrl.prompts)


def test_reference_set_choice_sits_above_the_tabs_and_buttons_need_a_set(qapp, dataset):
    root, _ = dataset
    _, dlg = _admin(root)
    assert not dlg.tabs.isAncestorOf(dlg.set_combo)  # one choice for every tab
    assert dlg.current_set() is None
    for w in (dlg.save_criteria_btn, dlg.change_use_btn, dlg.remove_btn, dlg.opt_full_report, dlg.q_none):
        assert not w.isEnabled()
    dlg.generate_report()
    dlg.close()


def test_criteria_ranges_and_wording(qapp, ref_set):
    root, _, _ = ref_set
    _, dlg = _admin(root)
    assert dlg.save_criteria_btn.text() == "Save criteria for Pilot" and dlg.save_criteria_btn.isEnabled()
    _, f1_spin, f1_scope = dlg.crit_rows["event_f1"]
    assert (f1_spin.minimum(), f1_spin.maximum()) == (0.0, 1.0)
    assert dlg.crit_rows["time_kappa"][1].minimum() == -1.0
    assert dlg.crit_rows["false_positives_per_min"][1].maximum() == 1000.0
    assert f1_scope.itemText(1) == "in every assessed category"
    assert dlg.crit_rows["event_f1"][0].toolTip() == METRICS["event_f1"]["description"]
    dlg.close()


def test_every_add_flow_asks_practice_or_assessment(qapp, ref_set, tmp_path):
    root, truths, rs = ref_set
    expert = tmp_path / "E9_annotations.json"
    write_annotations_json(expert, _doc(truths[SUB1], "E9"))
    rs.remove_recording(SUB1)
    _, dlg = _admin(root)  # the scripted answer to "Practice or assessment?" is Cancel by default
    dlg.add_expert([expert])
    assert SUB1 not in ReferenceSet.load(rs.directory).recordings
    _, dlg = _admin(root, ScriptedPrompts({"Practice or assessment?": "Assessment"}))
    dlg.add_expert([expert])
    assert ReferenceSet.load(rs.directory).recordings[SUB1]["use"] == "assessment"


def test_change_use_warns_when_annotators_have_seen_the_reference(qapp, ref_set):
    root, _, rs = ref_set
    reg = CompletionRegister(OutputLayout(root / "Annotated_Events"))
    reg.add({"recording_id": SUB1, "annotator_id": "CAM", "mode": "practice", "context": "pilot",
             "status": "completed", "session_id": "s1"})
    prompts = ScriptedPrompts({"Change use": True})
    _, dlg = _admin(root, prompts)
    assert dlg.practised_by(rs, SUB1) == ["CAM"]
    dlg.change_use(SUB1)
    (text,) = [t for k, title, t in prompts.log if title == "Change use"]
    assert "CAM already annotated this recording in practice" in text
    assert ReferenceSet.load(rs.directory).recordings[SUB1]["use"] == "assessment"


def test_set_options_and_quiz_items_from_the_dialog(qapp, ref_set):
    root, _, rs = ref_set
    _, dlg = _admin(root)
    dlg.opt_full_report.setChecked(True)
    dlg.opt_review.setChecked(False)
    dlg.assigned.setText("cam, a03")
    dlg.save_assigned()
    dlg.q_none.setChecked(True)
    loaded = ReferenceSet.load(rs.directory)
    assert loaded.show_full_report_to_annotator and not loaded.practice_review
    assert loaded.assigned_annotators == ["CAM", "A03"] and loaded.quiz["include_none_option"] is True
    dlg.q_id.setText("q2")
    dlg.q_rec.setCurrentText(SUB1)
    dlg.q_start.setValue(9.4)
    dlg.q_end.setValue(9.9)
    dlg.q_label.setCurrentIndex(dlg.q_label.findData("Eye-blink-artifact"))
    dlg.q_also.setText("Vertical-eye-movement-artifact")
    dlg.add_quiz_item()
    item = next(it for it in ReferenceSet.load(rs.directory).quiz_items if it.item_id == "q2")
    assert item.accepted_labels == ["Eye-artifact", "Vertical-eye-movement-artifact"]
    dlg.quiz_table.selectRow([dlg.quiz_table.item(r, 0).text() for r in range(dlg.quiz_table.rowCount())].index("q2"))
    prompts = dlg.prompts
    prompts.answers["Remove quiz item"] = True
    dlg.remove_quiz_item()
    assert [it.item_id for it in ReferenceSet.load(rs.directory).quiz_items] == ["q1"]
    dlg.close()


def test_progress_lists_annotators_who_used_the_set(qapp, ref_set):
    root, _, rs = ref_set
    (root / "Annotated_Events" / "training" / "pilot" / "practice" / "annotator-CAM").mkdir(parents=True)
    _, dlg = _admin(root)
    dlg.show_progress()
    assert "CAM" in dlg.p_text.toPlainText() and "0 of 1" in dlg.p_text.toPlainText()
    dlg.close()


# ----------------------------------------------------------- item 8: passphrase
def test_passphrase_cancel_is_silent_and_wrong_explains_recovery(qapp, ref_set):
    root, _, _ = ref_set
    admin.set_admin_passphrase(root, "letmein123")
    cancel = ScriptedPrompts()  # ask_text answers "" (cancelled)
    ctrl = AppController(prompts=cancel, synchronous_loading=True)
    ctrl.open_admin(root)
    assert ctrl.admin_dialog is None and not [k for k, _t, _x in cancel.log if k == "error"]
    wrong = ScriptedPrompts({"Administrator passphrase": "nope"})
    ctrl = AppController(prompts=wrong, synchronous_loading=True)
    ctrl.open_admin(root)
    (msg,) = [t for k, _title, t in wrong.log if k == "error"]
    assert "electroclean-admin set-passphrase" in msg


# --------------------------------------------------------------- item 7: review
def test_review_draws_the_reference_differently_and_can_be_finished(qapp, ref_set):
    root, truths, _ = ref_set
    prompts = ScriptedPrompts({"Practice feedback": "Review in the viewer", "Continue?": False})
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    assert ctrl.begin(StartRequest("CAM", "", root, None, "practice", reference_set_id="pilot"))
    ws = ctrl.workspace
    assert "practice recording 1 of 1" in ws.browser.windowTitle()
    a = truths[SUB1].annotations[0]
    ws.session.store.add(a.label, a.onset_sample, a.duration_samples, a.channels)
    assert ws.save_and_finish()
    wait()
    review = ctrl.review_workspace
    refs = [r for aid, r in review.controller.regions.items() if aid.startswith("ref-")]
    mine = [r for aid, r in review.controller.regions.items() if aid.startswith("you-")]
    assert refs and mine
    assert all(r.brush.style() == Qt.BDiagPattern for r in refs)
    assert all(r.brush.style() != Qt.BDiagPattern for r in mine)
    assert "hatched" in review.review_legend.text() and review.annotation_dock.isAncestorOf(review.review_legend)
    assert not review.clock_label.isVisible()
    review.finish_review_btn.click()
    wait()
    assert ctrl.review_workspace is None


# ----------------------------------------------------------------- item 11: quiz
def test_quiz_answers_are_grouped_and_mapped_to_labels(qapp, ref_set):
    root, _, rs = ref_set
    prompts = ScriptedPrompts()
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    assert ctrl.begin(StartRequest("CAM", "", root, None, "assessment", reference_set_id="pilot",
                                   assessment_kind="quiz"))
    win: QuizWindow = ctrl.quiz_window
    headings = [w.text() for w in win.findChildren(QLabel) if w.text().startswith("<b>") and "artifact" not in w.text()]
    assert "<b>Eye</b>" in headings
    buttons = {win._options[win.group.id(b)]: b for b in win.group.buttons()}
    assert buttons["Eye-artifact"].font().italic() and "exact type unclear" in buttons["Eye-artifact"].text()
    buttons["Eye-artifact"].setChecked(True)  # the group term is accepted for this item
    win._submit()
    wait()
    assert next(iter(win.quiz.answers.values()))["correct"] is True
    assert win.windowTitle().startswith("ElectroClean assessment quiz")


def test_practice_complete_text_names_the_set_and_next_steps(ref_set):
    _, _, rs = ref_set
    text = practice_complete_text(rs)
    assert "Pilot" in text and "Competency assessment" in text and "quiz" in text
    assert QuizSession(rs, "CAM", "practice").feedback_immediately
