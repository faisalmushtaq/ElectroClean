"""Regression tests for the usability walk-through (annotator's journey).

Each test names the problem it guards against. Windows are given realistic
laptop sizes, because the offscreen test screen is only 800 x 600.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

pytest.importorskip("PySide6")

import pyqtgraph as pg  # noqa: E402
from qtpy.QtCore import QPoint  # noqa: E402
from qtpy.QtTest import QTest  # noqa: E402
from qtpy.QtWidgets import QApplication  # noqa: E402

from electroclean.app.common import IdentifierError, friendly_duration, friendly_time, normalise_annotator_id  # noqa: E402
from electroclean.app.gui.app_controller import AppController  # noqa: E402
from electroclean.app.gui.dialogs import ScriptedPrompts  # noqa: E402
from electroclean.app.gui.start_window import StartRequest  # noqa: E402
from electroclean.app.session.selection import select_next  # noqa: E402
from tests.conftest import SUB1, make_session  # noqa: E402
from tests.test_gui import open_workspace  # noqa: E402

pytestmark = pytest.mark.gui


@pytest.fixture(scope="module")
def qapp():
    return pg.mkQApp("ElectroClean-tests")


def wait(ms: int = 60) -> None:
    QTest.qWait(ms)
    QApplication.processEvents()


def close(ws) -> None:
    ws._closing_ok = True
    ws.browser.close()
    wait()


@pytest.mark.parametrize("width, height", [(1325, 729), (1241, 684)])  # the app's fit to 1366x768 and 1280x720
def test_save_and_finish_is_visible_on_laptop_screens(qapp, layout, settings, catalogue, loaded, width, height):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    try:
        ws.browser.resize(width, height)
        wait(150)
        for widget in (ws.save_btn, ws.label_combo, ws.choose_channels_btn):
            assert widget.isVisible()
            right = widget.mapTo(ws.browser, QPoint(0, 0)).x() + widget.width()
            assert right <= ws.browser.width()
    finally:
        close(ws)


def test_eog_and_ecg_are_on_screen_without_scrolling(qapp, layout, settings, catalogue, loaded):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    try:
        shown = {t.ch_name for t in ws.browser.mne.traces}
        assert {"HEOG", "VEOG", "ECG"} <= shown and len(shown) == len(loaded.info.ch_names)
    finally:
        close(ws)


def test_region_labels_do_not_overlap(qapp, layout, settings, catalogue, loaded):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    try:
        ws.browser.resize(1241, 684)
        wait(150)
        st = session.store
        st.add_interval("Eye-blink-artifact", 2.96, 3.44, ["Fp1", "Fp2", "VEOG"])
        st.add_interval("EMG-artifact", 3.2, 4.8, ["F7", "F8", "T7", "T8"])
        st.add_interval("Movement-artifact", 7.0, 8.0)
        st.add_interval("Eye-artifact", 7.2, 7.6)
        wait(150)
        boxes = [r.label_item.sceneBoundingRect() for r in ws.controller.regions.values()]
        for i, a in enumerate(boxes):
            for b in boxes[i + 1:]:
                assert not a.intersects(b)
    finally:
        close(ws)


def test_relabel_uses_the_grouped_list(qapp, layout, settings, catalogue, loaded):
    prompts = ScriptedPrompts({"Change label": "Eye-artifact"})
    session, ws = open_workspace(layout, settings, catalogue, loaded, prompts)
    try:
        ann = session.store.add_interval("Eye-blink-artifact", 2.0, 2.4)
        ws.controller.select(ann.annotation_id)
        wait()
        ws.relabel_selected()
        assert session.store.get(ann.annotation_id).label == "Eye-artifact"
        assert any(k == "label" for k, _t, _x in prompts.log)
        headings = [ws.label_combo.itemText(i) for i in range(ws.label_combo.count()) if ws.label_combo.itemData(i) is None]
        assert len(headings) == 4
        view = ws.label_combo.view()
        assert view.minimumWidth() >= view.sizeHintForColumn(0)  # no entry is cut off
    finally:
        close(ws)


def test_view_state_carries_over_and_is_recorded(qapp, dataset):
    root, _ = dataset
    ctrl = AppController(prompts=ScriptedPrompts(), synchronous_loading=True)
    assert ctrl.begin(StartRequest(annotator_id="A01", display_name="", dataset_root=root, output_root=None,
                                   mode="standard"))
    ws = ctrl.workspace
    ws.browser.scale_all(step=0.5)  # what the "-" key does twice or so
    ws.controller.create_annotation(10.0, 11.0)
    assert ws.save_and_finish()
    wait()
    meta = json.loads(next(ctrl.layout.root.rglob("*_session.json")).read_text(encoding="utf-8"))
    assert meta["display"]["scale_factor"] == pytest.approx(0.5)
    assert ctrl.workspace is not None  # the next recording, opened by "Continue"
    assert ctrl.workspace.browser.mne.scale_factor == pytest.approx(0.5)
    close(ctrl.workspace)


def test_after_saving_the_annotator_can_go_back_to_the_start_window(qapp, dataset):
    root, _ = dataset
    prompts = ScriptedPrompts({"Continue?": "Back to the start window"})
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    ctrl.begin(StartRequest(annotator_id="A01", display_name="", dataset_root=root, output_root=None, mode="standard"))
    ctrl.workspace.controller.create_annotation(10.0, 11.0)
    assert ctrl.workspace.save_and_finish()
    wait()
    assert ctrl.workspace is None and ctrl.start_window.isVisible()


def test_start_window_does_not_fill_in_the_previous_annotator(qapp, dataset, tmp_path):
    from electroclean.app.gui.start_window import StartWindow, app_settings

    root, _ = dataset
    s = app_settings()
    saved = {k: s.value(k) for k in ("dataset", "annotator", "display_name")}
    try:
        s.setValue("dataset", str(root))
        s.setValue("annotator", "B02")
        s.setValue("display_name", "Bea")
        sw = StartWindow()
        assert sw.annotator.currentText() == "" and sw.display_name.text() == ""
        assert "B02 (used last on this computer)" in [sw.annotator.itemText(i) for i in range(sw.annotator.count())]
        sw.annotator.setEditText("A01")
        assert "completed by A01" in sw.progress_label.text()  # follows the ID typed
        empty = tmp_path / "empty"
        empty.mkdir()
        sw.dataset.setText(str(empty))
        sw.refresh()
        assert "No recordings found" in sw.progress_label.text() and not sw.begin_btn.isEnabled()
        sw.dataset.setText(str(tmp_path / "missing"))
        sw.refresh()
        assert "Folder not found" in sw.progress_label.text() and not sw.begin_btn.isEnabled()
    finally:
        for k, v in saved.items():
            if v is None:
                s.remove(k)
            else:
                s.setValue(k, v)


def test_failed_load_names_the_recording_and_reason(qapp, dataset):
    import shutil

    root, _ = dataset
    shutil.rmtree(root / "sub-002")  # only the broken recording is left, so it is the one offered
    eeg = root / "sub-001" / "eeg" / "sub-001_task-rest_eeg.eeg"
    eeg.write_bytes(eeg.read_bytes()[:1001])
    prompts = ScriptedPrompts({"Continue?": "Quit"})
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    ctrl.begin(StartRequest(annotator_id="A01", display_name="", dataset_root=root, output_root=None, mode="standard"))
    if ctrl.workspace is not None:
        close(ctrl.workspace)
    failed = [t for k, title, t in prompts.log if title == "Failed to load file"]
    assert failed and SUB1 in failed[0] and "Reason:" in failed[0] and "failed_load.txt" in failed[0]


def test_close_message_with_no_annotations(qapp, layout, settings, catalogue, loaded):
    prompts = ScriptedPrompts({"Close without saving": "Keep annotating"})
    session, ws = open_workspace(layout, settings, catalogue, loaded, prompts)
    try:
        ws._confirm_close()
        text = next(t for k, title, t in prompts.log if title == "Close without saving?")
        assert "0 annotation" not in text and "the time spent so far is kept" in text
    finally:
        close(ws)


def test_plain_messages_and_times():
    with pytest.raises(IdentifierError, match="Please enter your annotator ID"):
        normalise_annotator_id("  ")
    with pytest.raises(IdentifierError) as info:
        normalise_annotator_id("A-01")
    assert "Got:" not in str(info.value) and "letters and digits" in str(info.value)
    now = datetime.now(timezone.utc)
    assert friendly_time(now.isoformat()).startswith("today at ")
    assert friendly_time((now - timedelta(days=1)).isoformat()).startswith("yesterday at ")
    assert friendly_time("not a time") == "not a time"
    assert friendly_duration(20) == "less than a minute"
    assert friendly_duration(3900) == "1 hour 5 minutes"


def test_no_more_recordings_message_says_why(dataset, recordings):
    rid = SUB1
    res = select_next(list(recordings.values()), annotator_id="A01", completed={rid}, failed={"sub-002/eeg/sub-002_task-rest_eeg.vhdr"},
                      strategy="random")
    assert res.recording is None
    assert "1 completed by you" in res.message and "failed_load.txt" in res.message and "the rest" not in res.message
    empty = select_next([], annotator_id="A01", completed=set(), failed=set(), strategy="random")
    assert "_eeg.edf" in empty.message


def test_empty_reference_set_is_explained(qapp, dataset):
    from electroclean.config.settings import load_settings
    from electroclean.training.reference import ReferenceSet, reference_sets_dir

    root, _ = dataset
    _, study = load_settings(root)
    ReferenceSet.create(reference_sets_dir(root, study), "empty", name="Empty set", method="single_expert",
                        experts=["E1"])
    prompts = ScriptedPrompts()
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    ctrl.begin(StartRequest(annotator_id="CAM", display_name="", dataset_root=root, output_root=None,
                            mode="practice", reference_set_id="empty"))
    assert ctrl.workspace is None
    text = next(t for k, title, t in prompts.log if title == "No recordings in this reference set")
    assert "Empty set" in text and "no practice recordings" in text


def test_quiz_is_offered_for_practice_too(qapp, dataset):
    from electroclean.app.annotations.labels import default_catalogue
    from electroclean.config.settings import load_settings
    from electroclean.training.reference import QuizItem, ReferenceSet, reference_sets_dir

    root, _ = dataset
    _, study = load_settings(root)
    rs = ReferenceSet.create(reference_sets_dir(root, study), "pilot", name="Pilot", method="single_expert",
                             experts=["E1"])
    rs.add_quiz_item(QuizItem("q1", SUB1, 3.0, 3.4, "Eye-blink-artifact"), default_catalogue().label_names)
    ctrl = AppController(prompts=ScriptedPrompts(), synchronous_loading=True)
    sw = ctrl.start_window
    sw.dataset.setText(str(root))
    sw.refresh()
    sw.annotator.setEditText("CAM")
    sw.mode_practice.setChecked(True)
    assert sw.assess_quiz.isEnabled()
    sw.assess_quiz.setChecked(True)
    req = sw.build_request()
    assert req.mode == "practice" and req.assessment_kind == "quiz"
    assert ctrl.begin(req) and ctrl.quiz_window is not None
    ctrl.quiz_window.close()
    wait()


def test_start_window_errors_use_the_applications_prompts(qapp):
    prompts = ScriptedPrompts()
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    ctrl.start_window._begin()  # no annotator ID, no folder
    assert any(k == "error" and title == "Cannot start" for k, title, _t in prompts.log)


def test_session_metadata_has_display_block(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    s.start()
    s.start_timer()
    s.display_state = {"scale_factor": 2.0, "duration_s": 20.0, "n_channels": 22}
    res = s.finish()
    meta = json.loads(res.commit.paths["session_json"].read_text(encoding="utf-8"))
    assert meta["display"]["scale_factor"] == 2.0 and meta["display"]["scalings"]["eeg"] == pytest.approx(5e-05)


def test_end_of_practice_names_the_set_and_the_next_step(qapp, dataset):
    from electroclean.app.annotations.labels import default_catalogue
    from electroclean.app.annotations.model import AnnotationDocument
    from electroclean.config.settings import load_settings
    from electroclean.training.reference import ReferenceSet, reference_sets_dir

    root, truths = dataset
    _, study = load_settings(root)
    rs = ReferenceSet.create(reference_sets_dir(root, study), "pilot", name="Pilot set", method="single_expert",
                             experts=["E1"])
    rs.add_reference(AnnotationDocument(truths[SUB1].recording, "E1", list(truths[SUB1].annotations),
                                        default_catalogue(), session_id="e"),
                     use="practice", method="single_expert", experts=["E1"])
    prompts = ScriptedPrompts({"Practice feedback": "Continue", "Continue?": "Continue with another recording"})
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    ctrl.begin(StartRequest(annotator_id="CAM", display_name="", dataset_root=root, output_root=None,
                            mode="practice", reference_set_id="pilot"))
    ctrl.workspace.controller.create_annotation(3.0, 3.4)
    assert ctrl.workspace.save_and_finish()
    wait()
    text = next(t for k, title, t in prompts.log if title == "Practice complete")
    assert "Pilot set" in text and "Competency assessment" in text
    assert ctrl.start_window.isVisible()
