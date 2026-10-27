"""Dialogs and user prompts.

All yes/no questions and messages go through a :class:`UserPrompts` object so
that tests can replace it with :class:`ScriptedPrompts`, which answers
automatically instead of opening modal dialogs.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from qtpy.QtCore import Qt
from qtpy.QtGui import QColor, QIcon, QPixmap
from qtpy.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QDoubleSpinBox,
    QFormLayout,
    QHBoxLayout,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from electroclean.app.gui import style


def colour_icon(colour: str, size: int = 14) -> QIcon:
    pix = QPixmap(size, size)
    pix.fill(QColor(colour))
    return QIcon(pix)


def label_text(lab: Any) -> str:
    """How an artifact type is shown in every list: name, code, and a note for group terms."""
    text = f"{lab.label}  ({lab.value})"
    return text + "  – exact type unclear" if lab.is_group else text


def fill_label_combo(combo: Any, catalogue: Any) -> None:
    """Fill a combo box with the artifact types under their (unselectable) family headings.

    Group terms are in italics; each entry's tooltip is its HED SCORE description. The pop-up
    list is made wide enough for the longest entry.
    """
    combo.clear()
    combo.setMaxVisibleItems(36)
    section = None
    for lab in catalogue.labels:
        if lab.section and lab.section != section:
            section = lab.section
            combo.addItem(f"— {section} —")
            head = combo.model().item(combo.count() - 1)
            head.setEnabled(False)
            head.setSelectable(False)
        combo.addItem(colour_icon(lab.colour), label_text(lab), lab.label)
        idx = combo.count() - 1
        combo.setItemData(idx, lab.description or lab.label, Qt.ToolTipRole)
        if lab.is_group:
            font = combo.font()
            font.setItalic(True)
            combo.setItemData(idx, font, Qt.FontRole)
    view = combo.view()
    view.setMinimumWidth(view.sizeHintForColumn(0) + 40)


def add_label_menu(menu: Any, catalogue: Any, current: str | None, on_choose: Any) -> None:
    """Add the artifact types to a QMenu, under section headings, as in the toolbar."""
    section = None
    for lab in catalogue.labels:
        if lab.section and lab.section != section:
            section = lab.section
            menu.addSection(section)
        act = menu.addAction(colour_icon(lab.colour), label_text(lab))
        act.setToolTip(lab.description or lab.label)
        if lab.is_group:
            font = act.font()
            font.setItalic(True)
            act.setFont(font)
        act.setEnabled(lab.label != current)
        act.triggered.connect(lambda _=False, name=lab.label: on_choose(name))


def readable_text_colour(colour: str) -> str:
    c = QColor(colour)
    luminance = 0.299 * c.red() + 0.587 * c.green() + 0.114 * c.blue()
    return "#000000" if luminance > 150 else "#FFFFFF"


class UserPrompts:
    """Real modal dialogs."""

    def ask(
        self,
        parent: QWidget | None,
        title: str,
        text: str,
        *,
        details: str = "",
        informative: str = "",
        yes: str = "Yes",
        no: str = "No",
        icon: QMessageBox.Icon = QMessageBox.Question,
        default_yes: bool = True,
    ) -> bool:
        box = QMessageBox(parent)
        box.setIcon(icon)
        box.setWindowTitle(title)
        box.setText(text)
        if informative:
            box.setInformativeText(informative)
        if details:
            box.setDetailedText(details)
        yes_btn = box.addButton(yes, QMessageBox.AcceptRole)
        no_btn = box.addButton(no, QMessageBox.RejectRole)
        box.setDefaultButton(yes_btn if default_yes else no_btn)
        style.set_kind(yes_btn if default_yes else no_btn, "primary")
        box.exec()
        return box.clickedButton() is yes_btn

    def choose(self, parent: QWidget | None, title: str, text: str, options: Sequence[str], *,
               default: int = 0, icon: QMessageBox.Icon = QMessageBox.Question) -> str:
        """Ask with several buttons; returns the chosen option (the last one if the box is closed)."""
        box = QMessageBox(parent)
        box.setIcon(icon)
        box.setWindowTitle(title)
        box.setText(text)
        buttons = [box.addButton(o, QMessageBox.ActionRole) for o in options]
        box.setDefaultButton(buttons[default])
        style.set_kind(buttons[default], "primary")
        box.setEscapeButton(buttons[-1])
        box.exec()
        clicked = box.clickedButton()
        return options[buttons.index(clicked)] if clicked in buttons else options[-1]

    def inform(self, parent: QWidget | None, title: str, text: str, *, details: str = "") -> None:
        box = QMessageBox(QMessageBox.Information, title, text, QMessageBox.Ok, parent)
        if details:
            box.setDetailedText(details)
        box.exec()

    def error(self, parent: QWidget | None, title: str, text: str, *, details: str = "") -> None:
        box = QMessageBox(QMessageBox.Critical, title, text, QMessageBox.Ok, parent)
        if details:
            box.setDetailedText(details)
        box.exec()

    def choose_channels(
        self,
        parent: QWidget | None,
        ch_names: Sequence[str],
        selected: Sequence[str],
        *,
        title: str,
        allow_whole_montage: bool,
        whole_montage: bool = False,
        ch_types: dict[str, str] | None = None,
    ) -> list[str] | None:
        dlg = ChannelDialog(parent, ch_names, selected, title=title, allow_whole_montage=allow_whole_montage,
                            whole_montage=whole_montage, ch_types=ch_types)
        if dlg.exec() == QDialog.Accepted:
            return dlg.result_channels()
        return None

    def edit_times(self, parent: QWidget | None, start: float, end: float, sfreq: float, duration: float) -> tuple[float, float] | None:
        dlg = TimesDialog(parent, start, end, sfreq, duration)
        if dlg.exec() == QDialog.Accepted:
            return dlg.values()
        return None

    def choose_item(self, parent: QWidget | None, title: str, text: str, items: Sequence[str], current: int = 0) -> str | None:
        from qtpy.QtWidgets import QInputDialog

        item, ok = QInputDialog.getItem(parent, title, text, list(items), current, False)
        return item if ok else None

    def choose_label(self, parent: QWidget | None, title: str, catalogue: Any, current: str | None, *,
                     quick: Sequence[str] = (), at: Any = None) -> str | None:
        """Pick an artifact type with the searchable type picker; None if cancelled.

        ``quick`` are the types on keys 1 to 9 (shown with their key); ``at`` is a global point
        where the picker opens as a pop-up (for example under the mouse), otherwise it is a dialog."""
        picker = TypePicker(parent, catalogue, current, title=title, quick=quick, popup=at is not None)
        if at is not None:
            picker.place_at(at)
        if picker.exec() != QDialog.Accepted:
            return None
        return picker.chosen

    def choose_from_list(self, parent: QWidget | None, title: str, items: Sequence[str]) -> str | None:
        """A list to pick one item from (double-click or OK); None if cancelled."""
        from qtpy.QtWidgets import QDialogButtonBox, QListWidget

        dlg = QDialog(parent)
        dlg.setWindowTitle(title)
        layout = QVBoxLayout(dlg)
        lst = QListWidget()
        lst.addItems(list(items))
        lst.setCurrentRow(0)
        layout.addWidget(lst)
        bb = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        bb.accepted.connect(dlg.accept)
        bb.rejected.connect(dlg.reject)
        lst.itemDoubleClicked.connect(lambda _i: dlg.accept())
        layout.addWidget(bb)
        dlg.resize(520, 420)
        if dlg.exec() != QDialog.Accepted or lst.currentItem() is None:
            return None
        return lst.currentItem().text()

    def show_html(self, parent: QWidget | None, title: str, html: str, buttons: Sequence[str]) -> str:
        """Show rich text with one or more buttons; return the clicked button's text."""
        from qtpy.QtWidgets import QTextBrowser

        dlg = QDialog(parent)
        dlg.setWindowTitle(title)
        dlg.resize(760, 620)
        layout = QVBoxLayout(dlg)
        view = QTextBrowser()
        view.setHtml(html)
        layout.addWidget(view)
        row = QHBoxLayout()
        row.addStretch(1)
        clicked = {"text": buttons[-1] if buttons else ""}
        for text in buttons:
            btn = QPushButton(text)
            btn.clicked.connect(lambda _=False, t=text: (clicked.__setitem__("text", t), dlg.accept()))
            row.addWidget(btn)
        layout.addLayout(row)
        dlg.exec()
        return clicked["text"]

    def ask_text(self, parent: QWidget | None, title: str, label: str, *, password: bool = False) -> str | None:
        from qtpy.QtWidgets import QInputDialog

        mode = QLineEdit.Password if password else QLineEdit.Normal
        text, ok = QInputDialog.getText(parent, title, label, mode)
        return text if ok else None


class ScriptedPrompts(UserPrompts):
    """Answers prompts from a script; records everything that was asked (tests)."""

    def __init__(self, answers: dict[str, Any] | None = None, default: bool = True) -> None:
        self.answers = dict(answers or {})
        self.default = default
        self.log: list[tuple[str, str, str]] = []

    def _answer(self, kind: str, title: str, text: str, fallback: Any) -> Any:
        self.log.append((kind, title, text))
        for key, value in self.answers.items():
            if key in title or key in text:
                return value
        return fallback

    def ask(self, parent, title, text, **kw) -> bool:  # type: ignore[override]
        if kw.get("informative"):
            text = f"{text}\n\n{kw['informative']}"
        return bool(self._answer("ask", title, text, self.default))

    def choose(self, parent, title, text, options, **kw):  # type: ignore[override]
        """An answer may be an option's text; True means the first option and False the last."""
        answer = self._answer("choose", title, text, kw.get("default", 0))
        if answer is True:
            return options[0]
        if answer is False:
            return options[-1]
        if isinstance(answer, int):
            return options[answer]
        return answer if answer in options else options[0]

    def inform(self, parent, title, text, **kw) -> None:  # type: ignore[override]
        self._answer("inform", title, text, None)

    def error(self, parent, title, text, **kw) -> None:  # type: ignore[override]
        self._answer("error", title, text, None)

    def choose_channels(self, parent, ch_names, selected, **kw):  # type: ignore[override]
        return self._answer("channels", kw.get("title", ""), "", list(selected))

    def edit_times(self, parent, start, end, sfreq, duration):  # type: ignore[override]
        return self._answer("times", "Edit times", "", (start, end))

    def choose_item(self, parent, title, text, items, current=0):  # type: ignore[override]
        return self._answer("item", title, text, items[current] if items else None)

    def choose_label(self, parent, title, catalogue, current, **kw):  # type: ignore[override]
        return self._answer("label", title, "", current)

    def choose_from_list(self, parent, title, items):  # type: ignore[override]
        return self._answer("list", title, "", items[0] if items else None)

    def show_html(self, parent, title, html, buttons):  # type: ignore[override]
        return self._answer("html", title, html, buttons[-1] if buttons else "")

    def ask_text(self, parent, title, label, *, password=False):  # type: ignore[override]
        return self._answer("text", title, label, "")


class ChannelDialog(QDialog):
    """Checklist of channels with a filter box."""

    def __init__(
        self,
        parent: QWidget | None,
        ch_names: Sequence[str],
        selected: Sequence[str],
        *,
        title: str,
        allow_whole_montage: bool,
        whole_montage: bool = False,
        ch_types: dict[str, str] | None = None,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(360, 520)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 14)
        layout.setSpacing(10)
        self.whole = QCheckBox("Whole montage (all channels)")
        self.whole.setVisible(allow_whole_montage)
        self.whole.setChecked(whole_montage)
        layout.addWidget(self.whole)
        self.filter = QLineEdit()
        self.filter.setPlaceholderText("Type to filter channels…")
        layout.addWidget(self.filter)
        self.list = QListWidget()
        chosen = set(selected)
        for ch in ch_names:
            text = ch if not ch_types else f"{ch}    ({ch_types.get(ch, '')})"
            item = QListWidgetItem(text)
            item.setData(Qt.UserRole, ch)
            item.setFlags(item.flags() | Qt.ItemIsUserCheckable)
            item.setCheckState(Qt.Checked if ch in chosen else Qt.Unchecked)
            self.list.addItem(item)
        layout.addWidget(self.list)
        row = QHBoxLayout()
        all_btn = QPushButton("Select all")
        none_btn = QPushButton("Clear")
        for btn in (all_btn, none_btn):
            style.set_kind(btn, "quiet")
        row.addWidget(all_btn)
        row.addWidget(none_btn)
        row.addStretch(1)
        self.count = style.label("", "caption")
        row.addWidget(self.count)
        layout.addLayout(row)
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        style.set_kind(buttons.button(QDialogButtonBox.Ok), "primary")
        layout.addWidget(buttons)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        all_btn.clicked.connect(lambda: self._set_all(True))
        none_btn.clicked.connect(lambda: self._set_all(False))
        self.filter.textChanged.connect(self._apply_filter)
        self.list.itemChanged.connect(self._update)
        self.whole.toggled.connect(self._update)
        self._update()

    def _set_all(self, on: bool) -> None:
        for i in range(self.list.count()):
            item = self.list.item(i)
            if not item.isHidden():
                item.setCheckState(Qt.Checked if on else Qt.Unchecked)

    def _apply_filter(self, text: str) -> None:
        t = text.strip().lower()
        for i in range(self.list.count()):
            item = self.list.item(i)
            item.setHidden(bool(t) and t not in item.text().lower())

    def _update(self, *args: Any) -> None:
        whole = self.whole.isVisible() and self.whole.isChecked()
        self.list.setEnabled(not whole)
        self.filter.setEnabled(not whole)
        n = len(self._checked())
        self.count.setText("Applies to all channels" if whole else f"{n} channel(s) selected")

    def _checked(self) -> list[str]:
        return [
            self.list.item(i).data(Qt.UserRole)
            for i in range(self.list.count())
            if self.list.item(i).checkState() == Qt.Checked
        ]

    def result_channels(self) -> list[str]:
        if self.whole.isVisible() and self.whole.isChecked():
            return []
        return self._checked()


class TimesDialog(QDialog):
    """Precise editing of an annotation's start and end (snapped to samples)."""

    def __init__(self, parent: QWidget | None, start: float, end: float, sfreq: float, duration: float) -> None:
        super().__init__(parent)
        self.setWindowTitle("Edit annotation times")
        self.sfreq = sfreq
        form = QFormLayout(self)
        decimals = 4 if sfreq <= 10000 else 5
        self.start = QDoubleSpinBox()
        self.end = QDoubleSpinBox()
        for box, value in ((self.start, start), (self.end, end)):
            box.setDecimals(decimals)
            box.setRange(0.0, duration)
            box.setSingleStep(1.0 / sfreq)
            box.setSuffix(" s")
            box.setValue(value)
        form.setContentsMargins(16, 16, 16, 14)
        form.setSpacing(10)
        self.info = style.label("", "caption")
        form.addRow("Start", self.start)
        form.addRow("End", self.end)
        form.addRow("", self.info)
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        style.set_kind(buttons.button(QDialogButtonBox.Ok), "primary")
        form.addRow(buttons)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        self.start.valueChanged.connect(self._update)
        self.end.valueChanged.connect(self._update)
        self._update()

    def _update(self, *args: Any) -> None:
        s = round(self.start.value() * self.sfreq)
        e = round(self.end.value() * self.sfreq)
        self.info.setText(f"Samples {s} to {e} ({max(e - s, 0)} samples, {(e - s) / self.sfreq:.4f} s)")

    def values(self) -> tuple[float, float]:
        return self.start.value(), self.end.value()



class TypePicker(QDialog):
    """Find an artifact type by typing part of its name, its code or its abbreviation.

    The list keeps the family headings of the toolbar menu. Typing filters it, the arrow keys
    move through it, Enter (or a click) chooses and Esc closes. The types on the number keys are
    shown with their key, as a reminder that they can be chosen without opening the picker.
    """

    def __init__(self, parent: QWidget | None, catalogue: Any, current: str | None, *, title: str = "Artifact type",
                 quick: Sequence[str] = (), popup: bool = False) -> None:
        super().__init__(parent)
        self.setWindowTitle(title)
        if popup:
            self.setWindowFlags(Qt.Popup)  # closes when the user clicks elsewhere
        self.catalogue = catalogue
        self.chosen: str | None = None
        keys = {name: i for i, name in enumerate(quick, start=1)}
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(8)
        layout.addWidget(style.label(title, "heading"))
        self.search = QLineEdit()
        self.search.setPlaceholderText("Type a name, code or abbreviation, e.g. blink, 103 or EMG")
        self.search.setClearButtonEnabled(True)
        layout.addWidget(self.search)
        self.list = QListWidget()
        self.list.setUniformItemSizes(True)
        self._entries: list[tuple[QListWidgetItem, Any]] = []  # (item, label or None for a heading)
        section = None
        for lab in catalogue.labels:
            if lab.section and lab.section != section:
                section = lab.section
                head = QListWidgetItem(section)
                head.setFlags(Qt.NoItemFlags)
                font = head.font()
                font.setBold(True)
                head.setFont(font)
                self.list.addItem(head)
                self._entries.append((head, None))
            key = keys.get(lab.label)
            text = label_text(lab) + (f"     key {key}" if key else "")
            item = QListWidgetItem(colour_icon(lab.colour), text)
            item.setData(Qt.UserRole, lab.label)
            item.setToolTip(lab.description or lab.label)
            if lab.is_group:
                font = item.font()
                font.setItalic(True)
                item.setFont(font)
            self.list.addItem(item)
            self._entries.append((item, lab))
        layout.addWidget(self.list, 1)
        layout.addWidget(style.label("Enter chooses · ↑ ↓ move · Esc closes", "caption"))
        self.search.textChanged.connect(self._filter)
        self.search.installEventFilter(self)
        self.list.itemClicked.connect(self._choose_item)
        self.list.itemActivated.connect(self._choose_item)
        self.resize(420, 480)
        self._select_label(current)
        self.search.setFocus()

    # ------------------------------------------------------------ behaviour
    @staticmethod
    def matches(lab: Any, text: str) -> bool:
        """True if every word typed appears in the type's name, code or abbreviation."""
        hay = f"{lab.label} {lab.value} {lab.short_code}".lower().replace("-", " ")
        return all(word in hay for word in text.lower().replace("-", " ").split())

    def visible_labels(self) -> list[str]:
        return [lab.label for item, lab in self._entries if lab is not None and not item.isHidden()]

    def _filter(self, text: str) -> None:
        heading = None
        heading_has_match = False
        for item, lab in self._entries:
            if lab is None:
                if heading is not None:
                    heading.setHidden(not heading_has_match)
                heading, heading_has_match = item, False
                continue
            show = self.matches(lab, text) if text.strip() else True
            item.setHidden(not show)
            heading_has_match = heading_has_match or show
        if heading is not None:
            heading.setHidden(not heading_has_match)
        visible = self.visible_labels()
        current = self.list.currentItem()
        if text.strip() and visible:
            self._select_label(visible[0])  # Enter then chooses the best match
        elif current is not None:
            self.list.scrollToItem(current)

    def _select_label(self, name: str | None) -> None:
        for item, lab in self._entries:
            if lab is not None and lab.label == name and not item.isHidden():
                self.list.setCurrentItem(item)
                self.list.scrollToItem(item)
                return

    def _move(self, step: int) -> None:
        rows = [self.list.row(item) for item, lab in self._entries if lab is not None and not item.isHidden()]
        if not rows:
            return
        cur = self.list.currentRow()
        later = [r for r in rows if (r > cur if step > 0 else r < cur)]
        target = (later[0] if step > 0 else later[-1]) if later else cur
        if target not in rows:
            target = rows[0]
        self.list.setCurrentRow(target)

    def eventFilter(self, obj: Any, event: Any) -> bool:  # noqa: N802
        from qtpy.QtCore import QEvent

        if obj is self.search and event.type() == QEvent.KeyPress:
            key = event.key()
            if key in (Qt.Key_Down, Qt.Key_Up):
                self._move(1 if key == Qt.Key_Down else -1)
                return True
            if key in (Qt.Key_Return, Qt.Key_Enter):
                item = self.list.currentItem()
                if item is not None and not item.isHidden() and item.data(Qt.UserRole):
                    self._choose_item(item)
                return True
        return super().eventFilter(obj, event)

    def _choose_item(self, item: Any) -> None:
        name = item.data(Qt.UserRole) if item is not None else None
        if name:
            self.chosen = name
            self.accept()

    def place_at(self, point: Any) -> None:
        """Open with the top-left corner at a global point, kept on the screen."""
        from qtpy.QtCore import QPoint
        from qtpy.QtGui import QGuiApplication

        pt = point.toPoint() if hasattr(point, "toPoint") else QPoint(point)
        screen = QGuiApplication.screenAt(pt) or QGuiApplication.primaryScreen()
        if screen is not None:
            area = screen.availableGeometry()
            pt.setX(max(area.left(), min(pt.x(), area.right() - self.width())))
            pt.setY(max(area.top(), min(pt.y(), area.bottom() - self.height())))
        self.move(pt)
