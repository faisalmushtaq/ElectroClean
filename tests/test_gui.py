"""GUI behaviour, run offscreen with the real MNE Qt browser.

Mouse input is simulated with the browser's own test helper (``_fake_click``),
the same mechanism MNE uses in its test-suite. Dialogs are answered by
``ScriptedPrompts``. Interactive aspects that need a person (visual layout,
feel of dragging on a real screen, macOS/Windows rendering) are listed in
docs/testing_guide.md.
"""

from __future__ import annotations

import json

import pytest

pytest.importorskip("PySide6")

import pyqtgraph as pg  # noqa: E402
from qtpy.QtCore import QItemSelectionModel, Qt  # noqa: E402
from qtpy.QtTest import QTest  # noqa: E402
from qtpy.QtWidgets import QApplication  # noqa: E402

from electroclean.app.gui.annotation_window import AnnotationWorkspace  # noqa: E402
from electroclean.app.gui.app_controller import FAILED_TO_LOAD, AppController  # noqa: E402
from electroclean.app.gui.dialogs import ScriptedPrompts  # noqa: E402
from electroclean.app.gui.filter_dialog import FilterDialog  # noqa: E402
from electroclean.app.gui.start_window import StartRequest  # noqa: E402
from electroclean.app.session.register import CompletionRegister  # noqa: E402
from electroclean.app.session.failures import SessionLog  # noqa: E402
from electroclean.config.settings import FilterSettings  # noqa: E402
from tests.conftest import SUB1, SUB2, make_session  # noqa: E402

pytestmark = pytest.mark.gui


@pytest.fixture(scope="module")
def qapp():
    app = pg.mkQApp("ElectroClean-tests")
    yield app


def wait(ms: int = 30) -> None:
    QTest.qWait(ms)
    QApplication.processEvents()


def open_workspace(layout, settings, catalogue, loaded, prompts=None, **kw):
    session = make_session(layout, settings, catalogue, loaded, **kw)
    session.start()
    ws = AnnotationWorkspace(session, settings, prompts=prompts or ScriptedPrompts())
    ws.show()
    QTest.qWaitForWindowExposed(ws.browser)
    wait(80)
    return session, ws


def drag(ws, t0, t1, y=5.0):
    ws.browser._fake_click((t0, y), add_points=[(t1, y)], xform="data", kind="drag")
    wait()


def test_only_permitted_labels_and_mne_tools_disabled(qapp, layout, settings, catalogue, loaded):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    try:
        combo_labels = [ws.label_combo.itemData(i) for i in range(ws.label_combo.count())]
        assert combo_labels == list(catalogue.label_names)
        assert ws.label_combo.isEditable() is False
        p = ws.browser.mne
        assert "a" not in p.keyboard_shortcuts  # MNE's free-text annotation tool is unreachable
        assert all(a.text() != "Toggle annotations mode" for a in p.toolbar.actions())
        assert p.fig_annotation is None or not p.fig_annotation.isVisible()
        assert p.annotation_mode is False
    finally:
        ws._closing_ok = True
        ws.browser.close()


def test_draw_edit_and_save(qapp, layout, settings, catalogue, loaded):
    prompts = ScriptedPrompts()
    session, ws = open_workspace(layout, settings, catalogue, loaded, prompts)
    store = session.store
    ctrl = ws.controller
    # 1. Whole-montage eye blink.
    ws.label_combo.setCurrentIndex(ws.label_combo.findData("Eye-blink-artifact"))
    drag(ws, 3.0, 3.4)
    assert len(store) == 1 and store.annotations()[0].is_global
    # 2. Channel-specific EMG drawn over the blink (overlap).
    ws.scope_channels.setChecked(True)
    for name in ("T7", "F7"):
        trace = next(t for t in ws.browser.mne.traces if t.ch_name == name)
        trace.toggle_bad()  # what a click on the trace or its name does
    assert ctrl.selected_channels == ["F7", "T7"]
    assert ws.browser.mne.info["bads"] == []  # clicking never marks channels bad
    ws.label_combo.setCurrentIndex(ws.label_combo.findData("EMG-artifact"))
    drag(ws, 3.2, 4.0)
    emg = next(a for a in store.annotations() if a.label == "EMG-artifact")
    assert emg.channels == ("F7", "T7")
    # 3. Same label again, overlapping: kept separate.
    drag(ws, 3.6, 4.4)
    assert sum(a.label == "EMG-artifact" for a in store.annotations()) == 2
    assert len(ctrl.regions) == 3 == len(ws.browser.mne.regions)
    # 4. Table: select both EMG rows and merge them explicitly.
    ws.table.clearSelection()
    sm = ws.table.selectionModel()
    for r in range(ws.table.rowCount()):
        if ws.table.item(r, 0).text() == "EMG-artifact":
            sm.select(ws.table.model().index(r, 0), QItemSelectionModel.Select | QItemSelectionModel.Rows)
    wait()
    assert ws.btn_merge.isEnabled()
    ws.merge_selected()
    wait()
    assert sum(a.label == "EMG-artifact" for a in store.annotations()) == 1
    # 5. Undo / redo through the toolbar actions.
    ws.undo_action.trigger()
    wait()
    assert sum(a.label == "EMG-artifact" for a in store.annotations()) == 2
    ws.redo_action.trigger()
    wait()
    assert sum(a.label == "EMG-artifact" for a in store.annotations()) == 1
    # 6. Delete via selection + Delete action, then undo.
    blink = next(a for a in store.annotations() if a.label == "Eye-blink-artifact")
    ctrl.select(blink.annotation_id)
    ws.delete_action.trigger()
    wait()
    assert blink.annotation_id not in store
    ws.undo_action.trigger()
    wait()
    assert blink.annotation_id in store
    # 7. Shift+click on a channel inside the blink makes it channel-specific.
    ctrl.toggle_annotation_channel(blink.annotation_id, "Fp1")
    wait()
    assert store.get(blink.annotation_id).channels == ("Fp1",)
    # 8. Regions displayed match the store exactly; overview bar annotations too.
    assert set(ctrl.regions) == {a.annotation_id for a in store.annotations()}
    assert len(ws.browser.mne.inst.annotations) == len(store)
    # 9. Save and Finish.
    finished = []
    ws.finished.connect(finished.append)
    assert ws.save_and_finish() is True
    wait()
    assert finished and finished[0].n_annotations == 2
    assert CompletionRegister(layout).is_completed(SUB1, "A01")
    assert any(k == "ask" and "Save and Finish" in t for k, t, _ in prompts.log)
    meta = json.loads(finished[0].commit.paths["session_json"].read_text())
    assert meta["annotations"]["n_channel_specific"] == 2


def test_resize_by_dragging_edge_and_move_with_shift(qapp, layout, settings, catalogue, loaded):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    try:
        drag(ws, 5.0, 6.0)
        ann = session.store.annotations()[0]
        region = ws.controller.regions[ann.annotation_id]
        # Resize programmatically through the region (as an edge drag would).
        region.setRegion((5.0, 6.5))
        region.sigRegionChangeFinished.emit(region)
        wait()
        assert session.store.get(ann.annotation_id).duration_samples == 375
        # Shift+drag in the middle moves the region.
        ws.browser._fake_click((5.5, 5.0), add_points=[(6.5, 5.0)], xform="data", kind="drag",
                               modifier=Qt.ShiftModifier)
        wait()
        moved = session.store.get(ann.annotation_id)
        assert moved.onset_sample > ann.onset_sample and len(session.store) == 1
    finally:
        ws._closing_ok = True
        ws.browser.close()


def test_close_without_saving(qapp, layout, settings, catalogue, loaded):
    prompts = ScriptedPrompts({"Close without saving": False})
    session, ws = open_workspace(layout, settings, catalogue, loaded, prompts)
    drag(ws, 1.0, 2.0)
    ws.browser.close()
    wait()
    assert ws.browser.isVisible()  # refused: still open
    prompts.answers["Close without saving"] = True
    closed = []
    ws.closedWithoutSaving.connect(lambda: closed.append(True))
    ws.browser.close()
    wait(50)
    assert closed
    assert not CompletionRegister(layout).is_completed(SUB1, "A01")
    assert SessionLog(layout).entries()[-1]["event"] == "session_incomplete"


def test_save_with_no_annotations_needs_confirmation(qapp, layout, settings, catalogue, loaded):
    prompts = ScriptedPrompts({"not marked any artifacts": False})
    session, ws = open_workspace(layout, settings, catalogue, loaded, prompts)
    assert ws.save_and_finish() is False
    prompts.answers["not marked any artifacts"] = True
    assert ws.save_and_finish() is True
    assert CompletionRegister(layout).is_completed(SUB1, "A01")


def test_filter_dialog_defaults_and_lock(qapp):
    dlg = FilterDialog(None, FilterSettings())
    fs = dlg.settings()
    assert fs.highpass_enabled and fs.highpass_hz == 1.0
    assert fs.notch_enabled and fs.notch_hz == 60.0 and fs.method == "fir"
    dlg.hp_off.setChecked(True)
    dlg.n50.setChecked(True)
    fs = dlg.settings()
    assert not fs.highpass_enabled and fs.notch_hz == 50.0
    locked = FilterDialog(None, FilterSettings(locked=True, notch_hz=50.0))
    assert not locked.hp_on.isEnabled() and not locked.n60.isEnabled()
    assert locked.settings().locked and locked.settings().notch_hz == 50.0


def test_start_window_validates_identifier(qapp, dataset):
    root, _ = dataset
    ctrl = AppController(prompts=ScriptedPrompts(), synchronous_loading=True)
    sw = ctrl.start_window
    sw.dataset.setText(str(root))
    sw.refresh()
    sw.annotator.setEditText("A 01")
    with pytest.raises(Exception):
        sw.build_request()
    sw.annotator.setEditText("a01")
    req = sw.build_request()
    assert req.annotator_id == "A01" and req.mode == "standard"
    assert "2 recording(s) found" in sw.progress_label.text()


def test_full_application_loop(qapp, dataset):
    root, _ = dataset
    prompts = ScriptedPrompts()
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    req = StartRequest(annotator_id="A01", display_name="", dataset_root=root, output_root=None, mode="standard")
    assert ctrl.begin(req)
    seen = []
    for _ in range(2):
        ws = ctrl.workspace
        assert ws is not None
        seen.append(ws.session.recording_id)
        wait(50)
        ws.controller.create_annotation(10.0, 11.0)
        assert ws.save_and_finish()
        wait(50)
    assert sorted(seen) == [SUB1, SUB2]
    assert ctrl.workspace is None
    assert any("All eligible recordings have been completed" in t for k, _title, t in prompts.log)
    reg = CompletionRegister(ctrl.layout)
    assert reg.completed("A01") == {SUB1, SUB2}
    # A second annotator still gets both recordings.
    ctrl2 = AppController(prompts=ScriptedPrompts({"Continue?": False}), synchronous_loading=True)
    ctrl2.begin(StartRequest(annotator_id="B02", display_name="", dataset_root=root, output_root=None, mode="standard"))
    assert ctrl2.workspace is not None
    ctrl2.workspace._closing_ok = True
    ctrl2.workspace.session.abandon()
    ctrl2.workspace.browser.close()


def test_failed_load_message_and_continue(qapp, dataset):
    root, _ = dataset
    eeg = root / "sub-001" / "eeg" / "sub-001_task-rest_eeg.eeg"
    eeg.write_bytes(eeg.read_bytes()[:1001])  # corrupt one recording
    prompts = ScriptedPrompts()  # answers "continue" to everything
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    ctrl.begin(StartRequest(annotator_id="A01", display_name="", dataset_root=root, output_root=None, mode="standard"))
    # Whatever the random order, the healthy recording opens and the corrupted one fails.
    assert ctrl.workspace is not None and ctrl.workspace.session.recording_id == SUB2
    ctrl.workspace.controller.create_annotation(1, 2)
    assert ctrl.workspace.save_and_finish()
    wait(50)
    asked = [t for k, _title, t in prompts.log if k == "ask"]
    assert sum(FAILED_TO_LOAD in t for t in asked) == 1
    informed = [t for k, _title, t in prompts.log if k == "inform"]
    assert any("could not be loaded" in t for t in informed)
    reg = CompletionRegister(ctrl.layout)
    assert reg.completed("A01") == {SUB2}  # the failed file is never marked complete
    line = ctrl.layout.failed_load_txt.read_text().strip().split("\t")
    assert line[1] == SUB1


def test_screenshot_for_documentation(qapp, layout, settings, catalogue, loaded, tmp_path):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    try:
        ws.label_combo.setCurrentIndex(ws.label_combo.findData("Eye-blink-artifact"))
        drag(ws, 2.9, 3.5)
        img = ws.browser.grab()
        out = tmp_path / "shot.png"
        assert img.save(str(out)) and out.stat().st_size > 10000
    finally:
        ws._closing_ok = True
        ws.browser.close()
