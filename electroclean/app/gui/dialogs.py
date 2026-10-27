"""Dialogs and user prompts.

All yes/no questions and messages go through a :class:`UserPrompts` object so
that tests can replace it with :class:`ScriptedPrompts`, which answers
automatically instead of opening modal dialogs.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from qtpy.QtCore import Qt, Signal
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


class SearchField(QLineEdit):
    """A search box whose ↑ and ↓ keys move through the list below it.

    The keys are handled here rather than by an event filter on the dialog: a dialog that
    filters its own child's events can be called while it is being destroyed, which crashes
    PySide."""

    arrowPressed = Signal(int)  # +1 for ↓, -1 for ↑

    def keyPressEvent(self, event: Any) -> None:  # noqa: N802 (Qt naming)
        if event.key() in (Qt.Key_Down, Qt.Key_Up):
            self.arrowPressed.emit(1 if event.key() == Qt.Key_Down else -1)
            event.accept()
            return
        super().keyPressEvent(event)


class ChannelDialog(QDialog):
    """Choosing channels, built for 20 to 260 of them.

    Typing finds channels by name: names or the beginnings of names, separated by commas or
    spaces; a name in quotes finds that channel only and ``*`` stands for any characters. Group
    buttons tick or clear whole groups at once (10-20 regions, laterality and midline, name
    prefixes such as BioSemi's A to D banks, and channel types). Many channels are laid out in
    columns, and *Show selected only* lists just the ticked ones.
    """

    MANY = 16  # with more channels than this, the list is laid out in columns

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
        from qtpy.QtCore import QSize
        from qtpy.QtWidgets import QListView

        super().__init__(parent)
        self.setWindowTitle(title)
        names = list(ch_names)
        many = len(names) > self.MANY
        if many:
            self.resize(640, 620)
        else:
            self.resize(380, 580)
        self._allow_whole = bool(allow_whole_montage)
        types = {ch: str((ch_types or {}).get(ch, "") or "") for ch in names}
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 14)
        layout.setSpacing(10)
        self.whole = QCheckBox("Whole montage (all channels)")
        self.whole.setVisible(self._allow_whole)
        self.whole.setChecked(whole_montage and self._allow_whole)
        layout.addWidget(self.whole)

        self.filter = SearchField()
        self.filter.setPlaceholderText("Find channels, e.g. Fp1, F, *z")
        self.filter.setClearButtonEnabled(True)
        self.filter.arrowPressed.connect(self._enter_list)  # Down arrow moves into the list
        layout.addWidget(self.filter)
        self.filter_help = style.label(
            'Type names or their beginnings, separated by commas (b1 finds B1 and B10 to B19). Put a name in '
            'quotes for that channel only ("b1"), or use * for any characters (*z finds Fz, Cz and Pz).',
            "caption", wrap=True,
        )
        layout.addWidget(self.filter_help)

        # Group buttons: a click ticks every channel of the group, or clears them if all are ticked.
        self._groups: list[tuple[QPushButton, list[str]]] = []
        for row_label, groups in self._channel_groups(names, types):
            row = QHBoxLayout()
            row.setSpacing(4)
            row.addWidget(style.label(row_label, "caption"))
            for name, members in groups:
                btn = QPushButton(f"{name} ({len(members)})")
                btn.setToolTip(f"Tick these {len(members)} channels, or clear them if all are ticked: "
                               + ", ".join(members))
                btn.setAutoDefault(False)
                btn.clicked.connect(lambda _=False, m=members: self._toggle_group(m))
                row.addWidget(btn)
                self._groups.append((btn, members))
            row.addStretch(1)
            layout.addLayout(row)

        # The type is shown only for channels whose type differs from most of the montage and is not
        # already in the name (EXG1 · EOG; HEOG and ECG need no suffix).
        common = max(set(types.values()), key=list(types.values()).count) if types else ""
        self.list = QListWidget()
        self.list.setUniformItemSizes(True)
        fm = self.list.fontMetrics()
        chosen = set(selected)
        widest = 0
        for ch in names:
            kind = types.get(ch, "")
            plain = not kind or kind == common or kind.upper() in ch.upper()
            text = ch if plain else f"{ch}  · {kind.upper()}"
            widest = max(widest, fm.horizontalAdvance(text))
            item = QListWidgetItem(text)
            item.setData(Qt.UserRole, ch)
            item.setToolTip(f"{ch} ({kind})" if kind else ch)
            item.setFlags(item.flags() | Qt.ItemIsUserCheckable)
            item.setCheckState(Qt.Checked if ch in chosen else Qt.Unchecked)
            self.list.addItem(item)
        if many:
            # Columns, filled row by row and scrolled vertically; arrow keys move in all four directions.
            self.list.setViewMode(QListView.ListMode)
            self.list.setFlow(QListView.LeftToRight)
            self.list.setWrapping(True)
            self.list.setResizeMode(QListView.Adjust)
            self.list.setMovement(QListView.Static)
            cell = QSize(widest + 56, fm.height() + 10)  # check box and margins
            self.list.setGridSize(cell)
            # With uniform sizes every item takes the first one's size, which cut longer names
            # short ("H…" for HEOG); each item gets the whole cell instead.
            for i in range(self.list.count()):
                self.list.item(i).setSizeHint(cell)
        layout.addWidget(self.list, 1)

        row = QHBoxLayout()
        self.select_btn = QPushButton("Select all")
        self.clear_btn = QPushButton("Clear all")
        for btn in (self.select_btn, self.clear_btn):
            style.set_kind(btn, "quiet")
            btn.setAutoDefault(False)
        row.addWidget(self.select_btn)
        row.addWidget(self.clear_btn)
        self.selected_only = QCheckBox("Show selected only")
        row.addWidget(self.selected_only)
        row.addStretch(1)
        self.count = style.label("", "caption")
        row.addWidget(self.count)
        layout.addLayout(row)
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        style.set_kind(buttons.button(QDialogButtonBox.Ok), "primary")
        layout.addWidget(buttons)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        self.select_btn.clicked.connect(lambda: self._set_all(True))
        self.clear_btn.clicked.connect(lambda: self._set_all(False))
        self.filter.textChanged.connect(self._apply_filter)
        self.selected_only.toggled.connect(lambda _on: self._apply_filter(self.filter.text()))
        self.list.itemChanged.connect(self._update)
        self.whole.toggled.connect(self._update)
        self.filter.setFocus()
        self._update()

    # ------------------------------------------------------------ matching
    @staticmethod
    def _terms(text: str) -> list[str]:
        import re

        return [t for t in re.split(r"[,;\s]+", text.strip()) if t]

    @staticmethod
    def name_matches(name: str, terms: Sequence[str]) -> bool:
        """Whether a channel name matches any search term (see the class description)."""
        import fnmatch

        low = name.lower()
        for term in terms:
            t = term.lower()
            if len(t) >= 2 and t[0] == t[-1] and t[0] in "\"'":
                if low == t[1:-1]:
                    return True
            elif "*" in t or "?" in t:
                if fnmatch.fnmatchcase(low, t):
                    return True
            elif low.startswith(t.strip("\"'")):
                return True
        return False

    # -------------------------------------------------------------- groups
    @staticmethod
    def _channel_groups(names: list[str], types: dict[str, str]) -> list[tuple[str, list[tuple[str, list[str]]]]]:
        """Rows of group buttons: (row caption, [(group name, channels)])."""
        import re

        rows: list[tuple[str, list[tuple[str, list[str]]]]] = []
        eeg = [ch for ch in names if types.get(ch, "eeg") in ("eeg", "")]
        regions: dict[str, list[str]] = {}
        sides: dict[str, list[str]] = {}
        region_of = {"FP": "Frontal", "AF": "Frontal", "F": "Frontal", "FC": "Central", "C": "Central",
                     "CP": "Central", "FT": "Temporal", "T": "Temporal", "TP": "Temporal", "P": "Parietal",
                     "PO": "Occipital", "O": "Occipital", "I": "Occipital"}
        for ch in eeg:
            # 10-20 names, also as EDF writes them ("EEG Fp1-REF").
            core = re.sub(r"^(EEG)[\s_-]*", "", ch, flags=re.I)
            core = re.sub(r"[\s_-](REF|LE|AR|AVG|CZ|M1|M2|A1|A2)$", "", core, flags=re.I)
            m = re.fullmatch(r"(FP|AF|FC|FT|CP|TP|PO|F|C|T|P|O|I)(\d+|Z)", core.upper())
            if not m:
                continue
            regions.setdefault(region_of[m.group(1)], []).append(ch)
            pos = m.group(2)
            side = "Midline" if pos == "Z" else ("Left" if int(pos) % 2 else "Right")
            sides.setdefault(side, []).append(ch)
        if eeg and sum(len(v) for v in regions.values()) >= 0.6 * len(eeg):
            order = ["Frontal", "Central", "Temporal", "Parietal", "Occipital"]
            rows.append(("Regions", [(r, regions[r]) for r in order if regions.get(r)]))
            rows.append(("Sides", [(s, sides[s]) for s in ("Left", "Midline", "Right") if sides.get(s)]))
        else:
            # Name prefixes shared by several numbered channels, e.g. BioSemi's A1-A32 ... D1-D32.
            prefixes: dict[str, list[str]] = {}
            for ch in names:
                m = re.fullmatch(r"([A-Za-z]+)(\d+)", ch)
                if m:
                    prefixes.setdefault(m.group(1), []).append(ch)
            banks = [(p, chs) for p, chs in prefixes.items() if len(chs) >= 2]
            if len(banks) >= 2:
                rows.append(("Groups", banks))
        kinds: dict[str, list[str]] = {}
        for ch in names:
            kinds.setdefault(types.get(ch, "") or "other", []).append(ch)
        if len(kinds) >= 2:
            rows.append(("Types", [(k.upper(), chs) for k, chs in kinds.items()]))
        return rows

    def _toggle_group(self, members: Sequence[str]) -> None:
        wanted = set(members)
        items = [self.list.item(i) for i in range(self.list.count())]
        items = [it for it in items if it.data(Qt.UserRole) in wanted]
        tick = not all(it.checkState() == Qt.Checked for it in items)
        self.list.blockSignals(True)
        for it in items:
            it.setCheckState(Qt.Checked if tick else Qt.Unchecked)
        self.list.blockSignals(False)
        self._apply_filter(self.filter.text())

    # ------------------------------------------------------------ the list
    def _set_all(self, on: bool) -> None:
        """Tick or clear every channel shown (all of them when nothing is typed)."""
        self.list.blockSignals(True)
        for i in range(self.list.count()):
            item = self.list.item(i)
            if not item.isHidden():
                item.setCheckState(Qt.Checked if on else Qt.Unchecked)
        self.list.blockSignals(False)
        self._update()

    def _apply_filter(self, text: str) -> None:
        terms = self._terms(text)
        only = self.selected_only.isChecked()
        first = None
        for i in range(self.list.count()):
            item = self.list.item(i)
            hide = bool(terms) and not self.name_matches(item.data(Qt.UserRole), terms)
            hide = hide or (only and item.checkState() != Qt.Checked)
            item.setHidden(hide)
            if not hide and first is None:
                first = item
        if first is not None and terms:
            self.list.setCurrentItem(first)  # Down arrow, then Space, ticks the best match
        self._update()

    def _update(self, *args: Any) -> None:
        whole = self._allow_whole and self.whole.isChecked()
        for w in (self.list, self.filter, self.selected_only, self.select_btn, self.clear_btn):
            w.setEnabled(not whole)
        for btn, _members in self._groups:
            btn.setEnabled(not whole)
        n = len(self._checked())
        total = self.list.count()
        shown = sum(1 for i in range(total) if not self.list.item(i).isHidden())
        narrowed = shown < total
        self.select_btn.setText(f"Select {shown} shown" if narrowed else "Select all")
        self.clear_btn.setText("Clear shown" if narrowed else "Clear all")
        if whole:
            self.count.setText("Applies to all channels")
        elif narrowed:
            self.count.setText(f"{n} of {total} selected · {shown} shown")
        else:
            self.count.setText(f"{n} of {total} selected")

    def _enter_list(self, step: int) -> None:
        if step < 0:
            return
        self.list.setFocus()
        if self.list.currentItem() is None or self.list.currentItem().isHidden():
            for i in range(self.list.count()):
                if not self.list.item(i).isHidden():
                    self.list.setCurrentRow(i)
                    break

    def _checked(self) -> list[str]:
        return [
            self.list.item(i).data(Qt.UserRole)
            for i in range(self.list.count())
            if self.list.item(i).checkState() == Qt.Checked
        ]

    def result_channels(self) -> list[str]:
        # Whole montage is an empty list. (Checked through the stored flag: once the dialog has
        # closed, none of its widgets is visible any more.)
        if self._allow_whole and self.whole.isChecked():
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
        self.search = SearchField()
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
        self.search.arrowPressed.connect(self._move)
        self.search.returnPressed.connect(self._choose_current)
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

    def _choose_current(self) -> None:
        """Enter in the search box chooses the highlighted type."""
        item = self.list.currentItem()
        if item is not None and not item.isHidden() and item.data(Qt.UserRole):
            self._choose_item(item)

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
