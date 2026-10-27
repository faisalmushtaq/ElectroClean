"""The visual design: contrast, icons, one primary action per window, and settings that take effect."""

from __future__ import annotations

import re

import pytest

pytest.importorskip("PySide6")

import pyqtgraph as pg  # noqa: E402
from qtpy.QtTest import QTest  # noqa: E402
from qtpy.QtWidgets import QApplication, QPushButton  # noqa: E402

from electroclean.app.gui import style  # noqa: E402
from electroclean.app.gui.start_window import StartWindow  # noqa: E402
from tests.test_gui import open_workspace  # noqa: E402

pytestmark = pytest.mark.gui


@pytest.fixture(scope="module")
def qapp():
    return pg.mkQApp("ElectroClean-tests")


def _luminance(hex_colour: str) -> float:
    def channel(v: int) -> float:
        c = v / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast(a: str, b: str) -> float:
    la, lb = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


@pytest.mark.parametrize("text, background", [
    ("text", "surface"), ("text", "window"),
    ("text_secondary", "surface"), ("text_secondary", "window"),
    ("text_tertiary", "surface"),
    ("accent", "surface"), ("accent", "window"),  # quiet buttons and links
    ("destructive", "surface"), ("destructive", "window"),
    ("warning_text", "warning_bg"),
    ("selection_channel", "surface"),
])
def test_text_colours_meet_wcag_aa(text, background):
    c = style.COLOURS
    assert contrast(c[text], c[background]) >= 4.5, (text, background)


def test_white_text_on_the_accent_meets_wcag_aa():
    assert contrast("#FFFFFF", style.COLOURS["accent"]) >= 4.5
    assert contrast("#FFFFFF", style.COLOURS["accent_hover"]) >= 4.5


def test_every_icon_in_the_style_sheet_exists():
    sheet = style._qss(10.0)
    paths = re.findall(r'url\("([^"]+)"\)', sheet)
    assert paths, "the style sheet should use the theme's icons"
    from pathlib import Path

    for p in paths:
        assert Path(p).is_file(), p
        hi = Path(p).with_name(Path(p).stem + "@2x.png")
        assert hi.is_file(), hi  # sharp on high-resolution screens


def test_apply_theme_is_idempotent(qapp):
    style.apply_theme()
    sheet = QApplication.instance().styleSheet()
    style.apply_theme()
    assert QApplication.instance().styleSheet() == sheet
    assert QApplication.instance().property("electroclean_theme")


def _primary_buttons(widget) -> list[QPushButton]:
    return [b for b in widget.findChildren(QPushButton) if b.property("kind") == "primary" and b.isVisibleTo(widget)]


def test_start_window_has_one_primary_action(qapp):
    sw = StartWindow()
    sw.show()
    QTest.qWaitForWindowExposed(sw)
    try:
        assert _primary_buttons(sw) == [sw.begin_btn]
        # Options for practice and assessment appear only when they apply.
        assert not sw.training_box.isVisible()
        sw.mode_practice.setChecked(True)
        assert sw.training_box.isVisible()
    finally:
        sw.close()


def test_annotation_window_has_one_primary_action_and_a_segmented_scope(qapp, layout, settings, catalogue, loaded):
    session, ws = open_workspace(layout, settings, catalogue, loaded)
    try:
        assert _primary_buttons(ws.browser) == [ws.save_btn]
        assert ws.save_btn.styleSheet() == ""  # colours come from the theme, not from the widget
        # Exactly one of the two scope segments is on, and clicking the other switches the scope.
        assert ws.scope_whole.isChecked() and not ws.scope_channels.isChecked()
        ws.scope_channels.click()
        QTest.qWait(30)
        assert ws.controller.scope == "channels"
        assert ws.scope_channels.isChecked() and not ws.scope_whole.isChecked()
        assert ws.channels_summary.property("state") == "warning"  # nothing selected yet
        ws.scope_whole.click()
        QTest.qWait(30)
        assert ws.controller.scope == "whole"
    finally:
        ws._closing_ok = True
        ws.browser.close()
        QTest.qWait(30)


def test_overview_mode_setting_is_honoured(qapp, layout, settings, catalogue, loaded):
    # mne-qt-browser reads the mode from its own saved settings; the study's choice must win.
    from dataclasses import replace

    from qtpy.QtCore import QSettings

    QSettings("mne-tools", "mne-qt-browser").setValue("overview_mode", "channels")
    s = replace(settings, display=replace(settings.display, overview_mode="empty"))
    session, ws = open_workspace(layout, s, catalogue, loaded)
    try:
        assert ws.browser.mne.overview_mode == "empty"
    finally:
        ws._closing_ok = True
        ws.browser.close()
        QTest.qWait(30)
