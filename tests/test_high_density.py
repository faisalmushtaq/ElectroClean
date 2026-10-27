"""Fixes from a test with 128-channel recordings: legible labels, the channel chooser, the
channel count in the list of annotations, and closing a finished window."""

from __future__ import annotations

import pytest

pytest.importorskip("PySide6")

import pyqtgraph as pg  # noqa: E402
from qtpy.QtCore import Qt  # noqa: E402
from qtpy.QtGui import QColor  # noqa: E402
from qtpy.QtTest import QTest  # noqa: E402
from qtpy.QtWidgets import QApplication  # noqa: E402

from electroclean.app.gui.dialogs import ChannelDialog  # noqa: E402
from tests.test_gui import open_workspace  # noqa: E402

pytestmark = pytest.mark.gui

BIOSEMI = [f"{bank}{i}" for bank in "ABCD" for i in range(1, 33)]
TEN20 = ["Fp1", "Fp2", "F7", "F3", "Fz", "F4", "F8", "T7", "C3", "Cz", "C4", "T8", "P7", "P3", "Pz", "P4", "P8",
         "O1", "O2", "HEOG", "VEOG", "ECG"]
TEN20_TYPES = {**{c: "eeg" for c in TEN20}, "HEOG": "eog", "VEOG": "eog", "ECG": "ecg"}


@pytest.fixture(scope="module")
def qapp():
    return pg.mkQApp("ElectroClean-tests")


def wait(ms: int = 60) -> None:
    QTest.qWait(ms)
    QApplication.processEvents()


def _contrast_with_white(c: QColor) -> float:
    def lin(v: float) -> float:
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4

    return 1.05 / (0.2126 * lin(c.redF()) + 0.7152 * lin(c.greenF()) + 0.0722 * lin(c.blueF()) + 0.05)


def shown(dlg: ChannelDialog) -> list[str]:
    return [dlg.list.item(i).data(Qt.UserRole) for i in range(dlg.list.count()) if not dlg.list.item(i).isHidden()]


def dialog(names=BIOSEMI, selected=(), types=None, allow_whole=False, whole=False) -> ChannelDialog:
    types = types if types is not None else {c: "eeg" for c in names}
    return ChannelDialog(None, names, list(selected), title="Channels", allow_whole_montage=allow_whole,
                         whole_montage=whole, ch_types=types)


# ------------------------------------------------------------------ labels
def test_region_labels_are_legible_tags_above_the_traces(qapp, layout, settings, catalogue, loaded):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    try:
        st = session.store
        light = st.add_interval("Line-noise-artifact", 1.0, 2.0, ["Fp1", "Fp2"])  # yellow
        dark = st.add_interval("Eye-blink-artifact", 3.0, 3.4)
        wait(150)
        for ann in (light, dark):
            item = ws.controller.regions[ann.annotation_id].label_item
            assert item.zValue() >= 6  # above the traces and scale bars
            assert item.fill.style() != Qt.NoBrush and item.fill.color().alpha() > 150
            assert _contrast_with_white(QColor(item.color)) >= 4.5, ann.label
        # The outline keeps the artifact's own colour, also for the darkened yellow text.
        outline = ws.controller.regions[light.annotation_id].label_item.border.color()
        assert outline.name().lower() == catalogue.colour_for("Line-noise-artifact").lower()
    finally:
        ws._closing_ok = True
        ws.browser.close()
        wait()


def test_scale_bar_values_have_a_background(qapp, layout, settings, catalogue, loaded):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    try:
        texts = list(ws.browser.mne.scalebar_texts.values())
        assert texts and all(t.fill.style() != Qt.NoBrush for t in texts)
    finally:
        ws._closing_ok = True
        ws.browser.close()
        wait()


# --------------------------------------------------------- channel chooser
def test_search_matches_names_only_with_prefixes_quotes_and_wildcards(qapp):
    dlg = dialog()
    dlg.filter.setText("b1")
    assert shown(dlg) == ["B1"] + [f"B{i}" for i in range(10, 20)]
    dlg.filter.setText('"b1"')
    assert shown(dlg) == ["B1"]
    dlg.filter.setText("a1, d32")
    assert shown(dlg) == ["A1"] + [f"A{i}" for i in range(10, 20)] + ["D32"]
    dlg.filter.setText("*2")
    assert all(name.endswith("2") for name in shown(dlg)) and "C32" in shown(dlg)
    # The type is not part of what is searched: "eeg" used to match every channel.
    dlg.filter.setText("eeg")
    assert shown(dlg) == []
    dlg.filter.setText("")
    assert len(shown(dlg)) == 128


def test_type_is_shown_only_where_it_differs_and_is_not_in_the_name(qapp):
    dlg = dialog(BIOSEMI)
    assert all(dlg.list.item(i).text() == BIOSEMI[i] for i in range(128))
    types = {**{c: "eeg" for c in BIOSEMI}, "D31": "eog", "D32": "ecg"}
    dlg = dialog(BIOSEMI, types=types)
    texts = {dlg.list.item(i).data(Qt.UserRole): dlg.list.item(i).text() for i in range(dlg.list.count())}
    assert texts["A1"] == "A1" and "EOG" in texts["D31"] and "ECG" in texts["D32"]
    dlg = dialog(TEN20, types=TEN20_TYPES)
    texts = {dlg.list.item(i).data(Qt.UserRole): dlg.list.item(i).text() for i in range(dlg.list.count())}
    assert texts["HEOG"] == "HEOG" and texts["ECG"] == "ECG"


def test_many_channels_are_laid_out_in_columns(qapp):
    assert dialog(BIOSEMI).list.isWrapping()
    assert dialog(TEN20, types=TEN20_TYPES).list.isWrapping()
    assert not dialog(TEN20[:10]).list.isWrapping()
    dlg = dialog(BIOSEMI)
    dlg.show()
    wait(80)
    try:
        assert dlg.width() >= 600
        # Several columns: the second channel sits to the right of the first, not below it.
        r0 = dlg.list.visualItemRect(dlg.list.item(0))
        r1 = dlg.list.visualItemRect(dlg.list.item(1))
        assert r1.left() > r0.left() and r1.top() == r0.top()
    finally:
        dlg.close()


def test_selected_only_and_select_shown(qapp):
    dlg = dialog(selected=["A3", "C7"])
    dlg.selected_only.setChecked(True)
    assert shown(dlg) == ["A3", "C7"]
    assert "2 of 128 selected" in dlg.count.text()
    dlg.selected_only.setChecked(False)
    dlg.filter.setText('"b2", "b3"')
    assert dlg.select_btn.text() == "Select 2 shown"
    dlg.select_btn.click()
    assert dlg.result_channels() == ["A3", "B2", "B3", "C7"]
    dlg.clear_btn.click()
    assert dlg.result_channels() == ["A3", "C7"]


def test_group_buttons_for_banks_regions_sides_and_types(qapp):
    dlg = dialog(BIOSEMI)
    names = {b.text(): members for b, members in dlg._groups}
    assert set(names) == {"A (32)", "B (32)", "C (32)", "D (32)"}
    button = next(b for b, _m in dlg._groups if b.text() == "C (32)")
    button.click()
    assert dlg.result_channels() == [f"C{i}" for i in range(1, 33)]
    button.click()  # all ticked: a second click clears them
    assert dlg.result_channels() == []

    dlg = dialog(TEN20, types=TEN20_TYPES)
    names = {b.text().split(" (")[0]: members for b, members in dlg._groups}
    assert names["Frontal"] == ["Fp1", "Fp2", "F7", "F3", "Fz", "F4", "F8"]
    assert names["Midline"] == ["Fz", "Cz", "Pz"]
    assert names["Left"] == ["Fp1", "F7", "F3", "T7", "C3", "P7", "P3", "O1"]
    assert names["EOG"] == ["HEOG", "VEOG"] and names["ECG"] == ["ECG"]
    # EDF-style names are recognised too.
    edf = [f"EEG {c}-REF" for c in TEN20[:19]]
    dlg = dialog(edf)
    assert any(b.text().startswith("Frontal") for b, _m in dlg._groups)


def test_down_arrow_moves_from_the_search_to_the_first_match(qapp):
    dlg = dialog()
    dlg.show()
    wait(50)
    try:
        dlg.filter.setFocus()
        QTest.keyClicks(dlg.filter, "c5")
        QTest.keyClick(dlg.filter, Qt.Key_Down)
        wait(30)
        assert dlg.list.hasFocus()
        assert dlg.list.currentItem().data(Qt.UserRole) == "C5"
    finally:
        dlg.close()


def test_whole_montage_is_kept_after_the_dialog_closes(qapp):
    # The dialog used to ask whether the check box was visible, which it never is once the
    # dialog has closed, so ticking Whole montage was ignored when channels were also ticked.
    dlg = dialog(TEN20, selected=["F7", "F8"], types=TEN20_TYPES, allow_whole=True)
    dlg.show()
    wait(30)
    dlg.whole.setChecked(True)
    assert not dlg.list.isEnabled()
    dlg.accept()
    assert dlg.result_channels() == []
    dlg = dialog(TEN20, selected=["F7", "F8"], types=TEN20_TYPES, allow_whole=True, whole=True)
    assert not dlg.list.isEnabled() and dlg.result_channels() == []
    dlg = dialog(TEN20, selected=["F7", "F8"], types=TEN20_TYPES, allow_whole=False)
    dlg.whole.setChecked(True)  # hidden and not offered: ignored
    assert dlg.result_channels() == ["F7", "F8"]


# --------------------------------------------------------- annotation list
def test_channel_column_starts_with_the_count(qapp, layout, settings, catalogue, loaded):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    try:
        st = session.store
        st.add_interval("EMG-artifact", 1.0, 2.0, ["F7", "F8", "T7"])
        st.add_interval("Electrode-pops-artifact", 3.0, 3.2, ["C3"])
        st.add_interval("Movement-artifact", 4.0, 5.0)
        wait(80)
        cells = {ws.table.item(r, 0).text(): ws.table.item(r, 4) for r in range(ws.table.rowCount())}
        assert cells["EMG-artifact"].text() == "3 ch: F7, F8, T7"
        assert cells["EMG-artifact"].toolTip() == "F7, F8, T7"
        assert cells["Electrode-pops-artifact"].text() == "C3"
        assert cells["Movement-artifact"].text() == "Whole montage"
    finally:
        ws._closing_ok = True
        ws.browser.close()
        wait()


# ---------------------------------------------------------------- closing
def test_close_after_save_and_finish_does_nothing(qapp, layout, settings, catalogue, loaded):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    session.store.add_interval("Eye-blink-artifact", 1.0, 1.4)
    assert ws.save_and_finish() is True
    wait(200)  # MNE's browser deletes itself once it has closed
    import shiboken6

    assert ws.browser._closed and not shiboken6.isValid(ws.browser)
    ws.close()  # used to crash the application
    ws.close()


def test_channel_names_are_not_cut_short_in_columns(qapp):
    from electroclean.app.gui.dialogs import ChannelDialog

    names = [f"E{i}" for i in range(1, 30)] + ["HEOG_LEFT", "VEOG"]
    dlg = ChannelDialog(None, names, [], title="t", allow_whole_montage=False)
    fm = dlg.list.fontMetrics()
    for i in range(dlg.list.count()):
        item = dlg.list.item(i)
        assert item.sizeHint().width() >= fm.horizontalAdvance(item.text()) + 20, item.text()
