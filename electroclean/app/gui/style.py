"""ElectroClean's visual design: one set of colours, type and spacing for every window.

The design follows principles that well-designed desktop software shares
(Apple's Human Interface Guidelines have long named clarity and deference
among them):

* **The EEG is the content.** Controls are quiet (light surfaces, thin
  borders, secondary text in grey) so the traces and annotations stand out.
* **One primary action per window**, in the accent colour (Begin, Save and
  Finish, Open recording, OK). It is marked explicitly (``kind="primary"``),
  never inferred from Qt's default button, which in a dialog can be any
  button. Everything else is a plain or quiet button; destructive actions
  are red.
* **A clear hierarchy of text**: a title, section headings, body text and
  grey captions, all in the system font at the system size.
* **Grouping by space and cards**, not by boxes within boxes, on an 8-pixel
  grid.
* **Progressive disclosure**: options appear when they apply.
* **Accessible contrast**: every text colour meets WCAG 2.1 AA (4.5:1) on its
  background; colour is never the only signal.

Widgets opt into roles with a dynamic property, for example
``button.setProperty("kind", "primary")`` or ``label.setProperty("role",
"caption")``; the helpers below set them. :func:`apply_theme` installs the
palette and the style sheet once per application.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from qtpy.QtCore import Qt
from qtpy.QtGui import QColor, QFont, QPalette
from qtpy.QtWidgets import QApplication, QFrame, QLabel, QPushButton, QVBoxLayout, QWidget

# Colours. Text colours meet WCAG AA on both "surface" and "window".
COLOURS = {
    "window": "#F5F5F7",  # window background
    "surface": "#FFFFFF",  # cards, fields, tables
    "surface_alt": "#FAFAFB",
    "hover": "#EDEDF0",
    "pressed": "#E2E2E7",
    "border": "#C7C7CC",  # field and button outlines
    "separator": "#E3E3E8",  # card outlines, table lines
    "text": "#1D1D1F",
    "text_secondary": "#6E6E73",
    "text_tertiary": "#76767B",  # placeholders
    "text_disabled": "#A1A1A6",
    "accent": "#0066CC",
    "accent_hover": "#0057AE",
    "accent_pressed": "#004C99",
    "accent_soft": "#E8F1FC",  # selected rows, checked toggles
    "destructive": "#B3261E",
    "warning_bg": "#FFF6E0",
    "warning_border": "#F0D48A",
    "warning_text": "#6B4A00",
    "success": "#1B7A3A",
    "success_bg": "#EAF6EE",  # matched steps, passed results
    "success_border": "#A8D5B5",
    "flag_type": "#6A1B9A",  # review: an artifact found with another type
    "selection_channel": "#C2185B",  # selected channels in the EEG (magenta)
}

SPACING = {"xs": 4, "s": 8, "m": 12, "l": 16, "xl": 24}
ICONS = Path(__file__).resolve().parent / "icons"  # drawn by scripts/make_theme_icons.py
RADIUS = {"control": 6, "card": 10}


def _icon(name: str) -> str:
    """A style-sheet url() for one of the theme's icons (forward slashes and quotes work on every system)."""
    return f'url("{(ICONS / name).as_posix()}")'


def _qss(base_pt: float) -> str:
    c = COLOURS
    title_pt = round(base_pt * 1.75, 1)
    heading_pt = round(base_pt * 1.1, 1)
    caption_pt = round(base_pt * 0.92, 1)
    return f"""
/* ---------- text roles ---------- */
QLabel[role="title"] {{ font-size: {title_pt}pt; font-weight: 600; color: {c['text']}; }}
QLabel[role="subtitle"] {{ color: {c['text_secondary']}; }}
QLabel[role="heading"] {{ font-size: {heading_pt}pt; font-weight: 600; color: {c['text']}; }}
QLabel[role="caption"] {{ font-size: {caption_pt}pt; color: {c['text_secondary']}; }}
QLabel[role="error"] {{ color: {c['destructive']}; }}
QLabel[state="warning"] {{ color: {c['destructive']}; font-weight: 600; }}
QLabel[state="selected"] {{ color: {c['selection_channel']}; font-weight: 600; }}
QLabel[role="banner"] {{
    background: {c['warning_bg']}; border: 1px solid {c['warning_border']}; border-radius: 8px;
    padding: 8px 12px; color: {c['warning_text']};
}}
QLabel[role="note"] {{
    background: {c['surface_alt']}; border: 1px solid {c['separator']}; border-radius: 8px;
    padding: 8px 12px; color: {c['text']};
}}
QLabel[role="success"] {{
    background: {c['success_bg']}; border: 1px solid {c['success_border']}; border-radius: 8px;
    padding: 8px 12px; color: {c['success']};
}}

/* ---------- cards and groups ---------- */
QFrame[role="card"] {{
    background: {c['surface']}; border: 1px solid {c['separator']}; border-radius: {RADIUS['card']}px;
}}
QFrame[role="card"] QLabel {{ background: transparent; }}
QFrame[role="card"][state="current"] {{ border: 2px solid {c['accent']}; }}
QFrame[role="card"][state="locked"] {{ background: {c['surface_alt']}; }}
/* chips: a short status in a pill (the card prefix makes them win over the transparent card labels) */
QLabel[role="chip"], QFrame[role="card"] QLabel[role="chip"] {{
    background: {c['hover']}; color: {c['text_secondary']}; border-radius: 9px; padding: 2px 9px; font-weight: 600;
}}
QLabel[role="chip"][state="active"], QFrame[role="card"] QLabel[role="chip"][state="active"] {{
    background: {c['accent_soft']}; color: {c['accent']};
}}
QLabel[role="chip"][state="done"], QFrame[role="card"] QLabel[role="chip"][state="done"] {{
    background: {c['success_bg']}; color: {c['success']};
}}
QLabel[role="badge"], QFrame[role="card"] QLabel[role="badge"] {{
    background: {c['accent']}; color: #FFFFFF; border-radius: 13px; font-weight: 700;
    min-width: 26px; max-width: 26px; min-height: 26px; max-height: 26px; qproperty-alignment: AlignCenter;
}}
QLabel[role="badge"][state="done"], QFrame[role="card"] QLabel[role="badge"][state="done"] {{ background: {c['success']}; }}
QLabel[role="badge"][state="locked"], QFrame[role="card"] QLabel[role="badge"][state="locked"] {{
    background: {c['text_disabled']};
}}
QGroupBox {{
    background: {c['surface']}; border: 1px solid {c['separator']}; border-radius: {RADIUS['card']}px;
    margin-top: 1.4em; padding: 10px 12px 12px 12px; font-weight: 600;
}}
QGroupBox::title {{
    subcontrol-origin: margin; subcontrol-position: top left; left: 4px; padding: 0 4px;
    color: {c['text']};
}}
QGroupBox QWidget {{ font-weight: normal; }}

/* ---------- buttons ---------- */
QPushButton {{
    background: {c['surface']}; color: {c['text']}; border: 1px solid {c['border']};
    border-radius: {RADIUS['control']}px; padding: 5px 14px; min-height: 18px;
}}
QPushButton:hover {{ background: {c['hover']}; }}
QPushButton:pressed {{ background: {c['pressed']}; }}
QPushButton:disabled {{ color: {c['text_disabled']}; border-color: {c['separator']}; background: {c['surface_alt']}; }}
QPushButton:focus {{ border: 1px solid {c['accent']}; }}
QPushButton[kind="primary"] {{
    background: {c['accent']}; color: #FFFFFF; border: 1px solid {c['accent']}; font-weight: 600;
}}
QPushButton[kind="primary"]:hover {{ background: {c['accent_hover']}; border-color: {c['accent_hover']}; }}
QPushButton[kind="primary"]:pressed {{ background: {c['accent_pressed']}; }}
QPushButton[kind="primary"]:disabled {{
    background: {c['separator']}; border-color: {c['separator']}; color: {c['text_disabled']};
}}
QPushButton[kind="destructive"] {{ color: {c['destructive']}; }}
QPushButton[kind="quiet"] {{ background: transparent; border: 1px solid transparent; color: {c['accent']}; padding: 5px 8px; }}
QPushButton[kind="quiet"]:hover {{ background: {c['hover']}; }}
QPushButton[kind="quiet"]:disabled {{ color: {c['text_disabled']}; background: transparent; }}

/* chips: the numbered artifact-type buttons (their checked colour is the type's own) */
QPushButton[chip="true"] {{ padding: 3px 9px 3px 7px; border-radius: 11px; font-weight: 600; }}
QPushButton[chip="true"]:hover {{ border-color: {c['text_secondary']}; }}

/* segmented control: checkable buttons side by side */
QPushButton[segment] {{ border-radius: 0; padding: 4px 12px; margin: 0; }}
QPushButton[segment="first"] {{ border-top-left-radius: {RADIUS['control']}px; border-bottom-left-radius: {RADIUS['control']}px; }}
QPushButton[segment="middle"] {{ border-left: none; }}
QPushButton[segment="last"] {{ border-top-right-radius: {RADIUS['control']}px; border-bottom-right-radius: {RADIUS['control']}px; border-left: none; }}
QPushButton[segment]:checked {{ background: {c['accent']}; color: #FFFFFF; border-color: {c['accent']}; font-weight: 600; }}
QPushButton[segment]:checked:disabled {{ background: {c['hover']}; color: {c['text_secondary']}; border-color: {c['border']}; }}

/* ---------- fields ---------- */
QLineEdit, QComboBox, QSpinBox, QDoubleSpinBox, QPlainTextEdit, QTextEdit {{
    background: {c['surface']}; color: {c['text']}; border: 1px solid {c['border']};
    border-radius: {RADIUS['control']}px; padding: 4px 8px;
    selection-background-color: {c['accent_soft']}; selection-color: {c['text']};
}}
QLineEdit:focus, QComboBox:focus, QSpinBox:focus, QDoubleSpinBox:focus, QPlainTextEdit:focus, QTextEdit:focus {{
    border: 1px solid {c['accent']};
}}
QLineEdit:disabled, QComboBox:disabled, QSpinBox:disabled, QDoubleSpinBox:disabled {{
    color: {c['text_disabled']}; background: {c['surface_alt']}; border-color: {c['separator']};
}}
QComboBox {{ padding-right: 22px; }}
QComboBox::drop-down {{ border: none; width: 22px; subcontrol-origin: padding; subcontrol-position: center right; }}
QComboBox::down-arrow {{ image: {_icon("chevron-down.png")}; width: 10px; height: 10px; }}
QComboBox::down-arrow:disabled {{ image: {_icon("chevron-down-disabled.png")}; }}
QSpinBox, QDoubleSpinBox {{ padding-right: 22px; }}
QSpinBox::up-button, QDoubleSpinBox::up-button, QSpinBox::down-button, QDoubleSpinBox::down-button {{
    subcontrol-origin: border; width: 20px; border: none; border-left: 1px solid {c['separator']}; background: transparent;
}}
QSpinBox::up-button, QDoubleSpinBox::up-button {{ subcontrol-position: top right; border-top-right-radius: {RADIUS['control']}px; }}
QSpinBox::down-button, QDoubleSpinBox::down-button {{ subcontrol-position: bottom right; border-bottom-right-radius: {RADIUS['control']}px; }}
QSpinBox::up-button:hover, QDoubleSpinBox::up-button:hover, QSpinBox::down-button:hover, QDoubleSpinBox::down-button:hover {{
    background: {c['hover']};
}}
QSpinBox::up-arrow, QDoubleSpinBox::up-arrow {{ image: {_icon("chevron-up.png")}; width: 8px; height: 8px; }}
QSpinBox::down-arrow, QDoubleSpinBox::down-arrow {{ image: {_icon("chevron-down.png")}; width: 8px; height: 8px; }}
QSpinBox::up-arrow:disabled, QDoubleSpinBox::up-arrow:disabled {{ image: {_icon("chevron-up-disabled.png")}; }}
QSpinBox::down-arrow:disabled, QDoubleSpinBox::down-arrow:disabled {{ image: {_icon("chevron-down-disabled.png")}; }}
QComboBox QAbstractItemView {{
    background: {c['surface']}; border: 1px solid {c['separator']}; border-radius: 8px; padding: 4px;
    selection-background-color: {c['accent']}; selection-color: #FFFFFF; outline: none;
}}

/* ---------- lists and tables ---------- */
QTableView, QTableWidget, QListView, QListWidget, QTreeView {{
    background: {c['surface']}; color: {c['text']}; border: 1px solid {c['separator']}; border-radius: 8px;
    gridline-color: {c['separator']}; selection-background-color: {c['accent_soft']}; selection-color: {c['text']};
    alternate-background-color: {c['surface_alt']}; outline: none;
}}
QTableView::item, QTableWidget::item {{ padding: 4px 6px; }}
QHeaderView::section {{
    background: {c['surface']}; color: {c['text_secondary']}; border: none;
    border-bottom: 1px solid {c['separator']}; padding: 5px 6px; font-weight: 600;
}}
QTableCornerButton::section {{ background: {c['surface']}; border: none; }}

/* ---------- tabs ---------- */
QTabWidget::pane {{ border: 1px solid {c['separator']}; border-radius: 8px; background: {c['surface']}; top: -1px; }}
QTabBar::tab {{
    background: transparent; color: {c['text_secondary']}; border: none; padding: 6px 14px;
    border-bottom: 2px solid transparent;
}}
QTabBar::tab:selected {{ color: {c['text']}; border-bottom: 2px solid {c['accent']}; font-weight: 600; }}
QTabBar::tab:hover:!selected {{ color: {c['text']}; }}

/* ---------- toolbars, docks, status bar ---------- */
QToolBar {{ background: {c['window']}; border: none; spacing: 4px; padding: 3px 6px; }}
QToolBar::separator {{ background: {c['separator']}; width: 1px; margin: 4px 6px; }}
QToolBar QToolButton {{ border: 1px solid transparent; border-radius: {RADIUS['control']}px; padding: 4px 8px; color: {c['text']}; }}
QToolBar QToolButton:hover {{ background: {c['hover']}; }}
QToolBar QToolButton:pressed {{ background: {c['pressed']}; }}
QToolBar QToolButton:checked {{ background: {c['accent_soft']}; color: {c['accent']}; border-color: {c['accent_soft']}; font-weight: 600; }}
QToolBar QToolButton:disabled {{ color: {c['text_disabled']}; }}
QDockWidget {{ titlebar-close-icon: none; font-weight: 600; }}
QDockWidget::title {{ background: {c['window']}; padding: 6px 8px; text-align: left; }}
QStatusBar {{ background: {c['window']}; color: {c['text_secondary']}; border-top: 1px solid {c['separator']}; }}
QStatusBar QLabel {{ color: {c['text_secondary']}; }}
QMenuBar {{ background: {c['window']}; }}
QMenu {{ background: {c['surface']}; border: 1px solid {c['separator']}; padding: 4px; }}
QMenu::item {{ padding: 5px 22px 5px 22px; border-radius: 4px; }}
QMenu::item:selected {{ background: {c['accent']}; color: #FFFFFF; }}
QMenu::item:disabled {{ color: {c['text_disabled']}; }}
QMenu::separator {{ height: 1px; background: {c['separator']}; margin: 4px 8px; }}
QToolTip {{ background: #2C2C2E; color: #FFFFFF; border: none; padding: 6px 8px; }}
QProgressBar {{ border: 1px solid {c['separator']}; border-radius: 4px; background: {c['surface']}; text-align: center; }}
QProgressBar::chunk {{ background: {c['accent']}; border-radius: 3px; }}
"""


def palette() -> QPalette:
    """A light palette that looks the same on Windows, macOS and Linux."""
    c = COLOURS
    pal = QPalette()
    roles = {
        QPalette.Window: c["window"], QPalette.WindowText: c["text"], QPalette.Base: c["surface"],
        QPalette.AlternateBase: c["surface_alt"], QPalette.Text: c["text"], QPalette.Button: c["surface"],
        QPalette.ButtonText: c["text"], QPalette.Highlight: c["accent"], QPalette.HighlightedText: "#FFFFFF",
        QPalette.ToolTipBase: "#2C2C2E", QPalette.ToolTipText: "#FFFFFF", QPalette.Link: c["accent"],
        QPalette.PlaceholderText: c["text_tertiary"], QPalette.Mid: c["border"], QPalette.Midlight: c["separator"],
    }
    for role, colour in roles.items():
        pal.setColor(QPalette.All, role, QColor(colour))
    for role in (QPalette.WindowText, QPalette.Text, QPalette.ButtonText):
        pal.setColor(QPalette.Disabled, role, QColor(c["text_disabled"]))
    return pal


def apply_theme(app: QApplication | None = None) -> None:
    """Install the ElectroClean look on the application (once; later calls do nothing)."""
    app = app or QApplication.instance()
    if app is None or app.property("electroclean_theme"):
        return
    app.setStyle("Fusion")  # the same, predictable drawing on every system; the palette and sheet do the rest
    app.setPalette(palette())
    base_pt = app.font().pointSizeF()
    if base_pt <= 0:
        base_pt = 10.0
    app.setStyleSheet(_qss(base_pt))
    app.setProperty("electroclean_theme", True)


# ------------------------------------------------------------------ helpers
def set_kind(button: QPushButton, kind: str) -> QPushButton:
    """``primary``, ``destructive`` or ``quiet``; re-polishes so the change shows at once."""
    button.setProperty("kind", kind)
    _repolish(button)
    return button


def label(text: str = "", role: str = "", *, wrap: bool = False, rich: bool = False) -> QLabel:
    """A label with a text role: ``title``, ``subtitle``, ``heading``, ``caption``, ``error``, ``banner`` or ``note``."""
    lab = QLabel(text)
    if role:
        lab.setProperty("role", role)
    lab.setWordWrap(wrap)
    if rich:
        lab.setTextFormat(Qt.RichText)
    return lab


def set_role(widget: QWidget, role: str) -> QWidget:
    widget.setProperty("role", role)
    _repolish(widget)
    return widget


def set_state(widget: QWidget, state: str) -> QWidget:
    """A label's state: ``warning`` (red), ``selected`` (the channel-selection magenta) or ``""``."""
    if widget.property("state") != state:
        widget.setProperty("state", state)
        _repolish(widget)
    return widget


def card(margins: int = 16, spacing: int = 10) -> tuple[QFrame, QVBoxLayout]:
    """A white card with rounded corners; returns the frame and its vertical layout."""
    frame = QFrame()
    frame.setProperty("role", "card")
    frame.setFrameShape(QFrame.NoFrame)
    lay = QVBoxLayout(frame)
    lay.setContentsMargins(margins, margins - 2, margins, margins)
    lay.setSpacing(spacing)
    return frame, lay


def segmented(*buttons: QPushButton) -> list[QPushButton]:
    """Style checkable buttons placed side by side as one segmented control."""
    for i, b in enumerate(buttons):
        b.setCheckable(True)
        b.setProperty("segment", "first" if i == 0 else ("last" if i == len(buttons) - 1 else "middle"))
        _repolish(b)
    return list(buttons)


def heading_font(base: QFont | None = None, scale: float = 1.1) -> QFont:
    font = QFont(base or QApplication.font())
    font.setPointSizeF(font.pointSizeF() * scale)
    font.setWeight(QFont.DemiBold)
    return font


def colour(name: str) -> str:
    return COLOURS[name]


def _repolish(widget: Any) -> None:
    style = widget.style()
    style.unpolish(widget)
    style.polish(widget)
