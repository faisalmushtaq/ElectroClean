"""Adding and changing annotations by keyboard and mouse: number keys, the type buttons and
picker, M / [ / ] marks, N / P, C, Esc, and the rule that keys act on the selection if there is one."""

from __future__ import annotations

from dataclasses import replace

import pytest

pytest.importorskip("PySide6")

import pyqtgraph as pg  # noqa: E402
from qtpy.QtCore import QItemSelectionModel, Qt  # noqa: E402
from qtpy.QtTest import QTest  # noqa: E402
from qtpy.QtWidgets import QApplication  # noqa: E402

from electroclean.app.gui.dialogs import ScriptedPrompts, TypePicker  # noqa: E402
from electroclean.config.settings import DEFAULT_QUICK_LABELS, Settings, SettingsError, load_default_settings_dict  # noqa: E402
from tests.test_gui import drag, open_workspace  # noqa: E402

pytestmark = pytest.mark.gui


@pytest.fixture(scope="module")
def qapp():
    return pg.mkQApp("ElectroClean-tests")


def wait(ms: int = 30) -> None:
    QTest.qWait(ms)
    QApplication.processEvents()


def key(ws, k, modifier=Qt.NoModifier) -> None:
    QTest.keyClick(ws.browser, k, modifier)
    wait()


def close(session, ws) -> None:
    ws._closing_ok = True
    session.abandon()
    ws.browser.close()
    wait()


def checked_chips(ws) -> list[str]:
    return [name for name, b in zip(ws.quick_labels, ws.quick_buttons) if b.isChecked()]


@pytest.fixture
def workspace(qapp, layout, settings, catalogue, loaded):
    session, ws = open_workspace(layout, settings, catalogue, loaded, prompts=ScriptedPrompts())
    yield session, ws
    close(session, ws)


# --------------------------------------------------------------- choosing a type
def test_number_keys_choose_the_type_of_the_next_annotation(workspace):
    session, ws = workspace
    assert ws.quick_labels == list(DEFAULT_QUICK_LABELS)
    assert [b.text().split()[0] for b in ws.quick_buttons] == [str(i) for i in range(1, 10)]
    key(ws, Qt.Key_3)
    assert ws.controller.current_label == "EMG-artifact"
    assert checked_chips(ws) == ["EMG-artifact"]
    assert ws.label_combo.currentData() == "EMG-artifact"
    assert ws.type_caption.text().strip() == "Draw as"
    key(ws, Qt.Key_1, Qt.KeypadModifier)  # the number pad works too
    assert ws.controller.current_label == "Eye-blink-artifact"
    drag(ws, 4.0, 5.0)
    assert [a.label for a in session.store.annotations()] == ["Eye-blink-artifact"]


def test_clicking_a_type_button_chooses_it(workspace):
    session, ws = workspace
    ws.quick_buttons[4].click()
    wait()
    assert ws.controller.current_label == "Electrode-pops-artifact"
    assert checked_chips(ws) == ["Electrode-pops-artifact"]


def test_a_new_annotation_is_not_selected_so_the_next_key_chooses_the_next_type(workspace):
    session, ws = workspace
    key(ws, Qt.Key_1)
    drag(ws, 4.0, 5.0)
    aid = session.store.annotations()[0].annotation_id
    assert ws.controller.selected_id is None
    key(ws, Qt.Key_3)  # the type of the NEXT annotation; the blink just drawn stays a blink
    assert session.store.get(aid).label == "Eye-blink-artifact"
    assert ws.controller.current_label == "EMG-artifact"


def test_with_an_annotation_selected_keys_change_it(workspace):
    session, ws = workspace
    key(ws, Qt.Key_1)
    drag(ws, 4.0, 5.0)
    aid = session.store.annotations()[0].annotation_id
    ws.controller.select(aid)
    wait()
    assert ws.type_caption.text().strip() == "Change to"
    assert checked_chips(ws) == ["Eye-blink-artifact"]
    key(ws, Qt.Key_2)
    assert session.store.get(aid).label == "Horizontal-eye-movement-artifact"
    assert checked_chips(ws) == ["Horizontal-eye-movement-artifact"]
    assert ws.controller.current_label == "Eye-blink-artifact"  # the next type is unchanged
    key(ws, Qt.Key_Z, Qt.ControlModifier)  # undo
    assert session.store.get(aid).label == "Eye-blink-artifact"
    key(ws, Qt.Key_Escape)  # ends the selection
    assert ws.controller.selected_id is None
    assert ws.type_caption.text().strip() == "Draw as"


def test_selection_ends_with_a_click_on_empty_eeg_and_with_a_new_drag(workspace):
    session, ws = workspace
    drag(ws, 4.0, 5.0)
    aid = session.store.annotations()[0].annotation_id
    ws.controller.select(aid)
    ws.browser._fake_click((8.0, 5.5), xform="data", kind="press")  # between two traces
    wait()
    assert ws.controller.selected_id is None
    ws.controller.select(aid)
    drag(ws, 6.0, 7.0)  # away from the time cursor that the click placed at 8 s
    assert ws.controller.selected_id is None
    assert len(session.store) == 2


def test_keys_change_every_annotation_selected_in_the_list(workspace):
    session, ws = workspace
    for t in (2.0, 6.0, 10.0):
        ws.controller.create_annotation(t, t + 1.0)
    wait()
    sm = ws.table.selectionModel()
    for row in (0, 2):
        sm.select(ws.table.model().index(row, 0), QItemSelectionModel.Select | QItemSelectionModel.Rows)
    wait()
    key(ws, Qt.Key_4)
    labels = [a.label for a in session.store.annotations()]
    assert labels.count("Movement-artifact") == 2


def test_slash_finds_any_type(workspace):
    session, ws = workspace
    ws.prompts.answers["Type of the next annotation"] = "Nystagmus-artifact"
    key(ws, Qt.Key_Slash)
    assert ws.controller.current_label == "Nystagmus-artifact"
    assert checked_chips(ws) == []  # not one of the quick types; the menu shows it
    assert ws.label_combo.currentData() == "Nystagmus-artifact"
    asked = [entry for entry in ws.prompts.log if entry[0] == "label"]
    assert asked and asked[-1][1] == "Type of the next annotation"


def test_double_click_changes_the_type_of_that_annotation(workspace):
    session, ws = workspace
    aid = ws.controller.create_annotation(4.0, 5.0)
    ws.prompts.answers["Change Eye-blink-artifact to"] = "Chewing-artifact"
    ws.controller.requestTypeChange(aid, None)  # what a double-click on the annotation calls
    wait()
    assert session.store.get(aid).label == "Chewing-artifact"
    assert ws.controller.selected_id == aid


# ------------------------------------------------------------- marking by keys
def test_m_marks_the_start_and_then_the_end_even_across_screens(workspace):
    session, ws = workspace
    key(ws, Qt.Key_3)
    ws.mark_key("toggle", t=2.5)
    assert ws.controller.mark_start == pytest.approx(2.5)
    p = ws.browser.mne
    p.plt.setXRange(20.0, 30.0, padding=0)  # scroll on to where the artifact ends
    wait()
    ws.mark_key("toggle", t=24.0)
    anns = session.store.annotations()
    assert len(anns) == 1
    timing = session.loaded.timing
    assert anns[0].label == "EMG-artifact"
    assert anns[0].onset(timing) == pytest.approx(2.5, abs=1 / timing.sfreq)
    assert anns[0].offset(timing) == pytest.approx(24.0, abs=1 / timing.sfreq)
    assert ws.controller.mark_start is None


def test_brackets_mark_start_and_end_in_either_order(workspace):
    session, ws = workspace
    ws.mark_key("start", t=12.0)
    ws.mark_key("end", t=10.0)
    timing = session.loaded.timing
    (ann,) = session.store.annotations()
    assert (ann.onset(timing), ann.offset(timing)) == (pytest.approx(10.0, abs=0.01), pytest.approx(12.0, abs=0.01))


def test_escape_cancels_a_started_mark(workspace):
    session, ws = workspace
    ws.mark_key("toggle", t=3.0)
    assert ws.controller._mark_line is not None
    key(ws, Qt.Key_Escape)
    assert ws.controller.mark_start is None and ws.controller._mark_line is None
    ws.mark_key("end", t=5.0)
    assert len(session.store) == 0  # an end without a start creates nothing


def test_m_without_the_pointer_on_the_eeg_explains_what_to_do(workspace):
    session, ws = workspace
    ws.pointer_time = lambda: None  # the pointer is somewhere else
    key(ws, Qt.Key_M)
    assert ws.controller.mark_start is None
    assert "Point at the EEG" in ws.browser.statusBar().currentMessage()


def test_m_follows_the_scope_and_channels(workspace):
    session, ws = workspace
    ws.controller.set_selected_channels(["Fp1", "Fp2"])
    key(ws, Qt.Key_C)
    assert ws.controller.scope == "channels" and ws.scope_channels.isChecked()
    ws.mark_key("toggle", t=6.0)
    ws.mark_key("toggle", t=7.0)
    (ann,) = session.store.annotations()
    assert ann.channels == ("Fp1", "Fp2")
    key(ws, Qt.Key_C)
    assert ws.controller.scope == "whole"


# ----------------------------------------------------------------- navigating
def test_n_and_p_step_through_annotations_in_time(workspace):
    session, ws = workspace
    ids = [ws.controller.create_annotation(t, t + 0.5) for t in (40.0, 3.0, 20.0)]
    ws.browser.mne.plt.setXRange(0.0, 10.0, padding=0)
    wait()
    key(ws, Qt.Key_N)
    assert ws.controller.selected_id == ids[1]  # 3 s, the first one from the screen's start
    key(ws, Qt.Key_N)
    assert ws.controller.selected_id == ids[2]  # 20 s
    p = ws.browser.mne
    assert p.t_start <= 20.0 <= p.t_start + p.duration  # brought into view
    key(ws, Qt.Key_N)
    assert ws.controller.selected_id == ids[0]
    key(ws, Qt.Key_N)
    assert ws.controller.selected_id == ids[0]  # the last one stays selected
    assert "last annotation" in ws.browser.statusBar().currentMessage()
    key(ws, Qt.Key_P)
    assert ws.controller.selected_id == ids[2]
    key(ws, Qt.Key_Delete)
    assert ids[2] not in session.store


# ------------------------------------------------------------- read-only views
def test_review_windows_keep_navigation_but_not_editing(qapp, layout, settings, catalogue, loaded):
    from electroclean.app.gui.annotation_window import AnnotationWorkspace

    session, ws0 = open_workspace(layout, settings, catalogue, loaded)
    ws0.controller.create_annotation(4.0, 5.0)
    ws0._closing_ok = True
    ws0.browser.close()
    wait()
    ws = AnnotationWorkspace(session, settings, prompts=ScriptedPrompts(), read_only=True)
    ws.show()
    wait(80)
    try:
        assert not any(b.isEnabled() for b in ws.quick_buttons)
        assert not any(a.isEnabled() for a in ws.type_actions)
        assert not ws.mark_action.isEnabled()
        assert ws.next_action.isEnabled()
    finally:
        close(session, ws)


# ---------------------------------------------------------------- the picker
def test_type_picker_search(qapp, catalogue):
    picker = TypePicker(None, catalogue, "EMG-artifact", quick=DEFAULT_QUICK_LABELS)
    assert picker.list.currentItem().data(Qt.UserRole) == "EMG-artifact"
    picker.search.setText("blink")
    assert picker.visible_labels() == ["Eye-blink-artifact"]
    picker.search.setText("103")
    assert picker.visible_labels() == ["Eye-blink-artifact"]
    picker.search.setText("eye mov")
    assert set(picker.visible_labels()) == {
        "Horizontal-eye-movement-artifact", "Vertical-eye-movement-artifact", "Slow-eye-movement-artifact",
        "Eye-movement-artifact",
    }
    picker.search.setText("pops")
    QTest.keyClick(picker.search, Qt.Key_Return)
    assert picker.chosen == "Electrode-pops-artifact"
    # Family headings without a match are hidden, and ↓ moves to the next match.
    picker2 = TypePicker(None, catalogue, None)
    picker2.search.setText("artifact")
    first = picker2.list.currentItem().data(Qt.UserRole)
    QTest.keyClick(picker2.search, Qt.Key_Down)
    assert picker2.list.currentItem().data(Qt.UserRole) != first
    picker2.search.setText("zzzz")
    assert picker2.visible_labels() == []
    assert all(item.isHidden() for item, _lab in picker2._entries)


def test_quick_keys_are_shown_in_the_picker(qapp, catalogue):
    picker = TypePicker(None, catalogue, None, quick=DEFAULT_QUICK_LABELS)
    texts = {item.data(Qt.UserRole): item.text() for item, lab in picker._entries if lab is not None}
    assert texts["Eye-blink-artifact"].endswith("key 1")
    assert "key" not in texts["Nystagmus-artifact"]


# ------------------------------------------------------------------ settings
def test_quick_labels_setting(qapp, layout, settings, catalogue, loaded):
    data = load_default_settings_dict()
    data["annotation"]["quick_labels"] = ["EMG-artifact", "Not-a-type", "Eye-blink-artifact"]
    custom = Settings.from_dict(data)
    session, ws = open_workspace(layout, replace(settings, quick_labels=custom.quick_labels), catalogue, loaded)
    try:
        assert ws.quick_labels == ["EMG-artifact", "Eye-blink-artifact"]  # unknown names are left out
        assert len(ws.type_actions) == 2
    finally:
        close(session, ws)
    data["annotation"]["quick_labels"] = list(DEFAULT_QUICK_LABELS) + ["Nystagmus-artifact"]
    with pytest.raises(SettingsError, match="at most 9"):
        Settings.from_dict(data)
    data["annotation"]["quick_labels"] = ["EMG-artifact", "EMG-artifact"]
    with pytest.raises(SettingsError, match="twice"):
        Settings.from_dict(data)


def _full_labels_fit(ws) -> bool:
    """Whether the type row fits the window with full labels (measured, then put back)."""
    for b in ws.quick_buttons:
        b.setText(b.property("full_text"))
    ws._chips.layout().invalidate()
    ws.toolbar.layout().invalidate()
    needed = ws.toolbar.sizeHint().width()
    ws._fit_toolbar()
    return needed <= ws.browser.width() - 24


def test_type_buttons_fit_laptop_screens(workspace):
    from qtpy.QtWidgets import QToolButton

    session, ws = workspace
    ext = ws.toolbar.findChild(QToolButton, "qt_toolbar_ext_button")
    for width, height in ((1920, 1080), (1600, 950), (1325, 729), (1241, 684), (1920, 1080)):
        ws.browser.resize(width, height)
        wait(150)
        full = ws.quick_buttons[0].text().split() == ["1", "BLINK"]
        # Full labels exactly when they fit (how wide they are depends on the system's fonts).
        assert full == _full_labels_fit(ws), (width, ws.toolbar.sizeHint().width())
        if not full:
            assert ws.quick_buttons[0].text().split() == ["1"]
        if ws.toolbar.sizeHint().width() <= width:  # see test_save_and_finish_is_visible_on_laptop_screens
            assert not (ext and ext.isVisible())
            assert ws.choose_channels_btn.isVisible()


def test_the_keys_are_shown_at_the_bottom_of_the_window(workspace):
    session, ws = workspace
    text = ws.hint_label.text()
    for part in ("1–9", "M", "/", "N / P"):
        assert part in text
