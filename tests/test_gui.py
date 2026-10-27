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


def desktop_size(ws) -> None:
    """Give the window the size it has on a desktop.

    The offscreen test "screen" is only 800 x 600, so the window would otherwise be fitted to it and
    the EEG plot left a few hundred pixels wide. How wide exactly depends on the fonts of the machine,
    and at that width a drag that starts 0.2 s from an annotation edge grabs the edge instead, so the
    tests behaved differently on different computers.
    """
    ws.browser.resize(1600, 950)
    ws.browser.resizeDocks([ws.annotation_dock], [470], Qt.Horizontal)
    ws.browser.resizeDocks([ws.annotation_dock, ws.info_dock], [540, 340], Qt.Vertical)
    wait(80)


def open_workspace(layout, settings, catalogue, loaded, prompts=None, **kw):
    session = make_session(layout, settings, catalogue, loaded, **kw)
    session.start()
    ws = AnnotationWorkspace(session, settings, prompts=prompts or ScriptedPrompts())
    ws.show()
    QTest.qWaitForWindowExposed(ws.browser)
    desktop_size(ws)
    wait(80)
    return session, ws


def drag(ws, t0, t1, y=5.0):
    ws.browser._fake_click((t0, y), add_points=[(t1, y)], xform="data", kind="drag")
    wait()


def test_only_permitted_labels_and_mne_tools_disabled(qapp, layout, settings, catalogue, loaded):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    try:
        combo_labels = [ws.label_combo.itemData(i) for i in range(ws.label_combo.count())]
        # Every catalogue term, in catalogue order, under non-selectable family headings.
        assert [x for x in combo_labels if x is not None] == list(catalogue.label_names)
        headings = [i for i, x in enumerate(combo_labels) if x is None]
        assert len(headings) == 4
        assert all(not ws.label_combo.model().item(i).isEnabled() for i in headings)
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
    # 3. Same label again, overlapping on the same channels: merged automatically (one undo step).
    drag(ws, 3.6, 4.4)
    wait()
    emgs = [a for a in store.annotations() if a.label == "EMG-artifact"]
    assert len(emgs) == 1 and emgs[0].annotation_id == emg.annotation_id
    assert emgs[0].offset(loaded.timing) == pytest.approx(4.4, abs=0.05)  # drag precision is one pixel
    assert len(ctrl.regions) == 2 == len(ws.browser.mne.regions)
    ws.undo_action.trigger()  # undoes the drag, including the merge
    wait()
    (back,) = [a for a in store.annotations() if a.label == "EMG-artifact"]
    assert back.offset(loaded.timing) == pytest.approx(4.0, abs=0.05)
    ws.redo_action.trigger()
    wait()
    (again,) = [a for a in store.annotations() if a.label == "EMG-artifact"]
    assert again.offset(loaded.timing) == pytest.approx(4.4, abs=0.05)
    # A separate (non-overlapping) EMG on the same channels stays separate.
    drag(ws, 6.0, 6.5)
    wait()
    assert sum(a.label == "EMG-artifact" for a in store.annotations()) == 2
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
    meta = json.loads(finished[0].commit.paths["session_json"].read_text(encoding="utf-8"))
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
    prompts.answers["Close without saving"] = "Discard and close"
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
    assert fs.notch_enabled and fs.notch_hz == 50.0 and fs.method == "fir"
    dlg.hp_off.setChecked(True)
    dlg.n60.setChecked(True)
    fs = dlg.settings()
    assert not fs.highpass_enabled and fs.notch_hz == 60.0 and fs.method == "fir"
    locked = FilterDialog(None, FilterSettings(locked=True, notch_hz=60.0))
    assert not locked.hp_on.isEnabled() and not locked.n50.isEnabled()
    assert locked.settings().locked and locked.settings().notch_hz == 60.0


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
    assert any("could not be opened" in t and "failed_load.txt" in t for t in informed)
    reg = CompletionRegister(ctrl.layout)
    assert reg.completed("A01") == {SUB2}  # the failed file is never marked complete
    line = ctrl.layout.failed_load_txt.read_text(encoding="utf-8").strip().split("\t")
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


def test_saved_recording_is_not_offered_again_while_register_is_pending(qapp, dataset, monkeypatch):
    from electroclean.app.session.register import RegisterError

    root, _ = dataset
    ctrl = AppController(prompts=ScriptedPrompts(), synchronous_loading=True)
    assert ctrl.begin(StartRequest(annotator_id="A01", display_name="", dataset_root=root, output_root=None,
                                   mode="standard"))
    first = ctrl.workspace.session.recording_id

    def busy(self, entry):
        raise RegisterError("completion_register.tsv is open in another program")

    monkeypatch.setattr(CompletionRegister, "add", busy)
    ctrl.workspace.controller.create_annotation(1, 2)
    assert ctrl.workspace.save_and_finish()  # saved; registration finishes at the next start
    wait(50)
    assert ctrl.workspace is not None and ctrl.workspace.session.recording_id != first
    ctrl.workspace._closing_ok = True
    ctrl.workspace.session.abandon()
    ctrl.workspace.browser.close()


def test_unexpected_save_error_keeps_the_annotations_open(qapp, layout, settings, catalogue, loaded, monkeypatch):
    prompts = ScriptedPrompts()
    session, ws = open_workspace(layout, settings, catalogue, loaded, prompts)
    ws.controller.create_annotation(1, 2)

    def boom(*a, **k):
        raise KeyError("unexpected")

    monkeypatch.setattr(session, "finish", boom)
    assert ws.save_and_finish() is False
    assert ws.save_btn.isEnabled()
    assert any("Unexpected error" in t for _k, _title, t in prompts.log)
    monkeypatch.undo()
    assert ws.save_and_finish() is True


# ------------------------------------------------------------- review fixes
def test_main_keeps_running_between_windows(qapp, monkeypatch):
    """The start window is hidden while a recording opens; the application must not quit then."""
    from electroclean.app import main as main_mod

    monkeypatch.setattr(type(qapp), "exec", lambda self: 0)
    try:
        assert main_mod.main([]) == 0
        assert not qapp.quitOnLastWindowClosed()
    finally:
        qapp.setQuitOnLastWindowClosed(True)
        for w in qapp.topLevelWidgets():
            if type(w).__name__ == "StartWindow":
                w.hide()


def test_loading_dialog_cannot_be_dismissed(qapp):
    from electroclean.app.gui.app_controller import LoadingDialog

    dlg = LoadingDialog("Opening…", None)
    dlg.show()
    wait()
    QTest.keyClick(dlg, Qt.Key_Escape)
    dlg.close()
    wait()
    assert dlg.isVisible()
    dlg.finish()
    wait()
    assert not dlg.isVisible()


def test_ctrl_keys_never_reach_mne_shortcuts(qapp, layout, settings, catalogue, loaded):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    p = ws.browser.mne
    before = (p.scalebars_visible, ws.browser.statusBar().isVisible())
    for key in (Qt.Key_Z, Qt.Key_S, Qt.Key_X, Qt.Key_B):
        QTest.keyClick(ws.browser, key, Qt.ControlModifier)
        wait()
    assert (p.scalebars_visible, ws.browser.statusBar().isVisible()) == before
    assert ws.undo_action.isEnabled()  # consumes Ctrl+Z even with nothing to undo
    ws._closing_ok = True
    session.abandon()
    ws.browser.close()


def test_view_only_blocks_every_edit(qapp, layout, settings, catalogue, loaded):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    aid = ws.controller.create_annotation(5.0, 6.0)
    original = session.store.get(aid)
    ws.draw_action.setChecked(False)
    c = ws.controller
    c.select(aid)
    c.toggle_annotation_channel(aid, loaded.info.ch_names[0])
    c.relabel(aid, "Sweat-artifact")
    c.delete_selected()
    c.show_context_menu(aid, ws.browser.mapToGlobal(ws.browser.rect().center()))
    assert c.create_annotation(8.0, 9.0) is None
    assert len(session.store) == 1 and session.store.get(aid) == original
    ws._update_actions()
    assert not ws.btn_delete.isEnabled() and not ws.btn_label.isEnabled() and not ws.delete_action.isEnabled()
    ws.draw_action.setChecked(True)
    c.relabel(aid, "Sweat-artifact")
    assert session.store.get(aid).label == "Sweat-artifact"
    ws._closing_ok = True
    session.abandon()
    ws.browser.close()


def test_delete_key_removes_every_selected_row(qapp, layout, settings, catalogue, loaded):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    for t in (2.0, 4.0, 6.0):
        ws.controller.create_annotation(t, t + 0.5)
    ws.table.selectAll()
    wait()
    ws.delete_action.trigger()
    assert len(session.store) == 0
    assert session.store.undo() and len(session.store) == 3  # one undo step
    ids = [a.annotation_id for a in session.store.annotations()]
    ws.controller.relabel_many(ids, "Sweat-artifact")
    assert {a.label for a in session.store.annotations()} == {"Sweat-artifact"}
    session.store.undo()
    assert {a.label for a in session.store.annotations()} != {"Sweat-artifact"}  # relabelling was one step
    ws._closing_ok = True
    session.abandon()
    ws.browser.close()


def test_label_choice_does_not_take_keyboard_focus(qapp, layout, settings, catalogue, loaded):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    assert ws.label_combo.focusPolicy() == Qt.NoFocus
    QTest.mouseClick(ws.label_combo, Qt.LeftButton)
    wait()
    assert not ws.label_combo.hasFocus()
    ws._closing_ok = True
    session.abandon()
    ws.browser.close()


def test_closing_survives_a_session_log_failure(qapp, layout, settings, catalogue, loaded, monkeypatch):
    prompts = ScriptedPrompts({"Close without saving": "Discard and close"})
    session, ws = open_workspace(layout, settings, catalogue, loaded, prompts)
    closed = []
    ws.closedWithoutSaving.connect(lambda: closed.append(True))

    def broken(*a, **k):
        raise OSError("network drive disconnected")

    monkeypatch.setattr(session, "abandon", broken)
    ws.browser.close()
    wait(60)
    assert closed and not session.lock.path.exists()
    assert any("could not be written" in t for _k, _title, t in prompts.log)


def test_many_failed_loads_in_a_row(qapp, dataset, monkeypatch):
    """Each failure continues with the next recording in a loop, not by recursion."""
    import dataclasses
    import sys

    from electroclean.app.eeg.loading import RecordingLoadError
    from electroclean.app.gui import app_controller, workers

    root, _ = dataset
    real = app_controller.discover_recordings(root)
    fakes = [dataclasses.replace(real[0], recording_id=f"fake-{i:03d}/x_eeg.vhdr") for i in range(150)]
    monkeypatch.setattr(app_controller, "discover_recordings", lambda *a, **k: fakes)

    def always_fail(self):
        self.error = RecordingLoadError("broken", kind="corrupted_data")

    monkeypatch.setattr(workers.LoadWorker, "run", always_fail)
    ctrl = AppController(prompts=ScriptedPrompts(), synchronous_loading=True)
    limit = sys.getrecursionlimit()
    sys.setrecursionlimit(400)  # 150 nested failures would need far more than this
    try:
        ctrl.begin(StartRequest(annotator_id="A01", display_name="", dataset_root=root, output_root=None,
                                mode="standard"))
    finally:
        sys.setrecursionlimit(limit)
    assert sum(1 for h in ctrl.history if h["event"] == "load_failed") == 150


def test_finish_later_and_continue_in_a_new_session(qapp, dataset):
    root, _ = dataset
    prompts = ScriptedPrompts({"Close without saving": "Close and finish later", "Continue?": False})
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    assert ctrl.begin(StartRequest(annotator_id="A01", display_name="", dataset_root=root, output_root=None,
                                   mode="standard"))
    first = ctrl.workspace.session.recording_id
    ctrl.workspace.controller.create_annotation(2.0, 3.0)
    ctrl.workspace.browser.close()
    wait(60)
    # Next time ElectroClean offers to continue that recording, with the annotation restored.
    prompts2 = ScriptedPrompts({"Continue unfinished work": True})
    ctrl2 = AppController(prompts=prompts2, synchronous_loading=True)
    assert ctrl2.begin(StartRequest(annotator_id="A01", display_name="", dataset_root=root, output_root=None,
                                    mode="standard"))
    ws = ctrl2.workspace
    assert ws.session.recording_id == first and len(ws.session.store) == 1
    assert any(t == "Continue unfinished work?" for _k, t, _x in prompts2.log)
    assert ws.save_and_finish()
    wait(50)
    assert not ws.session.autosave_path.exists()
    assert CompletionRegister(ctrl2.layout).is_completed(first, "A01")
    if ctrl2.workspace is not None:
        ctrl2.workspace._closing_ok = True
        ctrl2.workspace.session.abandon()
        ctrl2.workspace.browser.close()


def test_declined_autosave_is_set_aside_when_starting_afresh(qapp, dataset):
    root, _ = dataset
    prompts = ScriptedPrompts({"Close without saving": "Close and finish later", "Continue?": False})
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    ctrl.begin(StartRequest(annotator_id="A01", display_name="", dataset_root=root, output_root=None,
                            mode="standard", choose_recording=True))
    rid = ctrl.workspace.session.recording_id
    ctrl.workspace.controller.create_annotation(2.0, 3.0)
    ctrl.workspace.browser.close()
    wait(60)
    prompts2 = ScriptedPrompts({"Continue unfinished work": False, "Restore unfinished work": False})
    ctrl2 = AppController(prompts=prompts2, synchronous_loading=True)
    ctrl2.begin(StartRequest(annotator_id="A01", display_name="", dataset_root=root, output_root=None,
                             mode="standard", choose_recording=True))
    ws = ctrl2.workspace
    assert ws.session.recording_id == rid  # the same recording is chosen from the list again
    assert len(ws.session.store) == 0  # started afresh
    assert list((ctrl2.layout.quarantine / "autosave").glob("*not-restored*.json"))
    ws._closing_ok = True
    ws.session.abandon()
    ws.browser.close()


def test_edf_recording_in_the_application(qapp, dataset):
    """A dataset mixing BrainVision and EDF: the EDF opens with its housekeeping channels hidden."""
    from electroclean.synthetic import ALL_CHANNELS, write_edf_recording

    root, _ = dataset
    write_edf_recording(root / "sub-050" / "eeg", "sub-050_task-rest", seed=9)
    edf_id = "sub-050/eeg/sub-050_task-rest_eeg.edf"
    prompts = ScriptedPrompts()
    ctrl = AppController(prompts=prompts, synchronous_loading=True)
    assert ctrl.begin(StartRequest(annotator_id="A01", display_name="", dataset_root=root, output_root=None,
                                   mode="standard"))
    seen = []
    for _ in range(3):
        ws = ctrl.workspace
        assert ws is not None
        rid = ws.session.recording_id
        seen.append(rid)
        wait(50)
        if rid == edf_id:
            p = ws.browser.mne
            assert list(p.ch_names) == list(ALL_CHANNELS)  # COUNTER, CQ_* and so on are not shown
            assert len(ws.controller._gap_items) == 1  # the padded last record is hatched
            assert "hidden by the channels.hide setting" in ws._info_html()
            ws.scope_channels.setChecked(True)
            next(t for t in p.traces if t.ch_name == "O1").toggle_bad()
        ws.controller.create_annotation(10.0, 11.0)
        assert ws.save_and_finish()
        wait(50)
    assert sorted(seen) == sorted([SUB1, SUB2, edf_id])
    reg = CompletionRegister(ctrl.layout)
    assert edf_id in reg.completed("A01")
    out = ctrl.layout.root / "annotator-A01" / "sub-050" / "eeg" / "sub-050_task-rest_eeg_annotator-A01_annotations.json"
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["annotations"][0]["channels"] == ["O1"]
