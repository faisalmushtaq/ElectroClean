"""The annotation window: MNE's browser plus ElectroClean's controls.

The MNE browser is a ``QMainWindow``; ElectroClean adds to it

* two toolbars: next to MNE's icons, draw on/off, delete, undo, redo, Save
  and Finish and help; below them, the artifact type, active-type indicator,
  whole-montage / selected-channels switch and channel chooser;
* an *Annotations* panel listing every annotation with buttons to jump to,
  retime, relabel, change channels, merge and delete;
* *Recording* and *Help* panels; and
* a status bar showing the recording, annotator, mode, filters and progress.
"""

from __future__ import annotations

import html
from typing import Any

from qtpy.QtCore import QObject, Qt, QTimer, Signal
from qtpy.QtGui import QAction, QCursor, QKeySequence
from qtpy.QtWidgets import (
    QAbstractItemView,
    QButtonGroup,
    QCheckBox,
    QComboBox,
    QDockWidget,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QPushButton,
    QSizePolicy,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QTextBrowser,
    QToolBar,
    QVBoxLayout,
    QWidget,
)

from electroclean.app.annotations.model import AnnotationError
from electroclean.app.gui import style
from electroclean.app.gui.browser import AnnotationController, check_browser_version, create_browser
from electroclean.app.gui.dialogs import UserPrompts, colour_icon, fill_label_combo, readable_text_colour
from electroclean.app.gui.help_text import HELP_HTML, KEY_HINT, UNDO_HINT
from electroclean.app.session.session import AnnotationSession, SessionError
from electroclean.app.session.transaction import ExportCommitError
from electroclean.app.validation.exports import ValidationError
from electroclean.config.settings import Settings


def _hed_descriptions() -> dict[str, str]:
    """HED SCORE descriptions of the labels (shown as tooltips)."""
    from electroclean.app.annotations.labels import default_catalogue

    return {item.label: item.description for item in default_catalogue().labels}


def format_hms(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


class AnnotationWorkspace(QObject):
    """Owns the browser window for one :class:`AnnotationSession`."""

    finished = Signal(object)  # FinishResult
    closedWithoutSaving = Signal()

    def __init__(
        self,
        session: AnnotationSession,
        settings: Settings,
        *,
        prompts: UserPrompts | None = None,
        read_only: bool = False,
        display_prefix: dict[str, str] | None = None,
        title_suffix: str = "",
        window_title: str | None = None,
        view_state: dict[str, float] | None = None,
    ) -> None:
        """``view_state`` (from :meth:`view_state` of the previous window) carries the amplitude
        scale, the seconds and the number of channels shown over to the next recording."""
        super().__init__()
        self.session = session
        self.settings = settings
        self.prompts = prompts or UserPrompts()
        self.read_only = read_only
        self.loaded = session.loaded
        style.apply_theme()
        self._closing_ok = False
        self._finished = False
        cat = session.catalogue
        ev, eid = self.loaded.original_events.display_events(self.loaded.timing)
        title = window_title or (
            f"ElectroClean – {self.loaded.files.stem} – annotator {session.annotator_id}"
            + (f" – {title_suffix}" if title_suffix else "")
        )
        self.browser = create_browser(
            self.loaded.view_raw,
            events=ev,
            event_id=eid,
            label_colours={lab.label: lab.colour for lab in cat.labels},
            title=title,
            duration_s=float((view_state or {}).get("duration_s") or settings.display.duration_s),
            n_channels=int((view_state or {}).get("n_channels") or settings.display.n_channels),
            scalings={**settings.display.scalings, **self.loaded.display_scalings},  # see eeg/amplitude.py
            theme=settings.display.theme,
            overview_mode=settings.display.overview_mode,
        )
        factor = float((view_state or {}).get("scale_factor") or 1.0)
        if factor > 0 and abs(factor - 1.0) > 1e-9:
            self.browser.scale_all(step=factor)
        zones = self.loaded.filter_report.transient_zones(self.loaded.timing.n_samples)
        sf = self.loaded.timing.sfreq
        gaps = [(a / sf, b / sf) for a, b in self.loaded.acquisition_gaps]
        self.controller = AnnotationController(self.browser, session.store, transient_zones=zones, gap_zones=gaps)
        if display_prefix:
            self.controller.set_display_prefix(display_prefix)
        self.controller.requestChannelEdit = self.edit_channels_of  # type: ignore[method-assign]
        self.browser._ec_close_guard = self._confirm_close
        self._hed = _hed_descriptions()
        self._build_toolbar()
        self._build_annotation_panel()
        self._build_info_panels()
        self._build_status_bar()
        self.controller.statusMessage.connect(self._show_message)
        self.controller.stateChanged.connect(self._refresh_state)
        self.controller.annotationsChanged.connect(self._refresh_table)
        self.controller.selectionChanged.connect(self._on_controller_selection)
        # The clock belongs to the browser window so it stops when the window is destroyed.
        self._lock_warned = False
        self._tick = QTimer(self.browser)
        self._tick.timeout.connect(self._update_clock)
        self._tick.start(1000)
        if read_only:
            self.controller.set_read_only()
        self.controller.sync_now()
        self._refresh_state()
        self._refresh_table()
        warning = check_browser_version()
        if warning:
            self._show_message(warning)

    # ------------------------------------------------------------------ UI
    def _build_toolbar(self) -> None:
        b = self.browser
        # Two rows. The first, next to MNE's own icons, holds the editing actions and Save and
        # Finish, right-aligned; the second holds what to draw (artifact type and channels). A
        # single row needs about 1400 pixels, so on a laptop screen Save and Finish would end up
        # in the toolbar's overflow menu.
        acts = QToolBar("Annotation actions", b)
        acts.setObjectName("electroclean_actions")
        acts.setMovable(False)
        b.addToolBar(Qt.TopToolBarArea, acts)
        self.actions_toolbar = acts
        b.addToolBarBreak(Qt.TopToolBarArea)
        tb = QToolBar("Artifact annotation", b)
        tb.setObjectName("electroclean_toolbar")
        tb.setMovable(False)
        b.addToolBar(Qt.TopToolBarArea, tb)
        self.toolbar = tb
        cat = self.session.catalogue

        # The caption reads "Draw as" while the type applies to the next annotation and "Change to"
        # while annotations are selected: the buttons, the menu and the keys then change those.
        self.type_caption = style.label(" Draw as ", "subtitle")
        tb.addWidget(self.type_caption)
        self.quick_labels = self._quick_labels()
        self.controller.quick_labels = list(self.quick_labels)
        chips = QWidget()
        chip_layout = QHBoxLayout(chips)
        chip_layout.setContentsMargins(0, 0, 4, 0)
        chip_layout.setSpacing(3)
        self.quick_buttons: list[QPushButton] = []
        for key, name in enumerate(self.quick_labels, start=1):
            lab = cat.get(name)
            btn = QPushButton()
            btn.setProperty("full_text", f" {key}  {lab.short_code}")
            btn.setProperty("compact_text", f" {key}")
            btn.setText(btn.property("full_text"))
            btn.setCheckable(True)
            btn.setFocusPolicy(Qt.NoFocus)
            btn.setProperty("chip", True)
            btn.setIcon(colour_icon(lab.colour, 10))
            # The chosen type is filled with its own colour, as its annotations are drawn.
            fg = readable_text_colour(lab.colour)
            btn.setStyleSheet(
                f"QPushButton:checked {{ background: {lab.colour}; color: {fg}; border-color: {lab.colour}; }}"
            )
            btn.setToolTip(
                f"<b>{html.escape(lab.label)}</b> ({lab.value}) · key <b>{key}</b><br>"
                f"{html.escape(self._hed.get(name, ''))}<br><br>"
                "Click (or press the key) to draw this type next; with annotations selected, to change them to it."
            )
            btn.clicked.connect(lambda _=False, n=name: self.apply_type(n))
            chip_layout.addWidget(btn)
            self.quick_buttons.append(btn)
        tb.addWidget(chips)
        self._chips = chips
        self.label_combo = QComboBox()
        fill_label_combo(self.label_combo, cat)  # family headings, colours, group terms in italics
        # The closed menu is as wide as about 32 characters rather than the longest entry, so the row
        # fits on laptop screens; the open list is as wide as it needs to be.
        self.label_combo.setSizeAdjustPolicy(QComboBox.AdjustToMinimumContentsLengthWithIcon)
        self.label_combo.setMinimumContentsLength(14)
        self.label_combo.setToolTip(
            f"All {len(cat.labels)} HED-SCORE artifact types (press / to search them by name or code). Group terms, "
            "in italics, are for artifacts whose exact type is unclear."
        )
        # Without keyboard focus the arrow, page and letter keys keep moving through the EEG
        # instead of silently changing the artifact type.
        self.label_combo.setFocusPolicy(Qt.NoFocus)
        self.label_combo.currentIndexChanged.connect(
            lambda i: self.label_combo.itemData(i) and self.apply_type(self.label_combo.itemData(i))
        )
        tb.addWidget(self.label_combo)
        tb.addSeparator()

        # A segmented control: two linked buttons, exactly one of them on. Its two labels say what
        # it is for, so it needs no caption (which also keeps the row within a laptop screen).
        self.scope_whole = QPushButton("Whole montage")
        self.scope_channels = QPushButton("Selected channels")
        style.segmented(self.scope_whole, self.scope_channels)
        self.scope_whole.setToolTip("The next drag marks every channel")
        self.scope_channels.setToolTip("The next drag marks only the selected channels (click channel names to select them)")
        group = QButtonGroup(tb)
        group.setExclusive(True)
        group.addButton(self.scope_whole)
        group.addButton(self.scope_channels)
        self.scope_whole.setChecked(True)
        self.scope_whole.toggled.connect(lambda on: on and self.controller.set_scope("whole"))
        self.scope_channels.toggled.connect(lambda on: on and self.controller.set_scope("channels"))
        for w in (self.scope_whole, self.scope_channels):
            w.setFocusPolicy(Qt.NoFocus)
        segment = QWidget()
        seg_layout = QHBoxLayout(segment)
        seg_layout.setContentsMargins(0, 0, 0, 0)
        seg_layout.setSpacing(0)
        seg_layout.addWidget(self.scope_whole)
        seg_layout.addWidget(self.scope_channels)
        tb.addWidget(segment)
        self.choose_channels_btn = QPushButton("Channels…")
        style.set_kind(self.choose_channels_btn, "quiet")
        self.choose_channels_btn.setToolTip("Choose the channels from a list")
        self.choose_channels_btn.clicked.connect(self.choose_channels)
        tb.addWidget(self.choose_channels_btn)
        self.channels_summary = style.label("", "subtitle")
        self.channels_summary.setMaximumWidth(170)
        tb.addWidget(self.channels_summary)

        tb = acts
        spacer = QWidget()
        spacer.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        tb.addWidget(spacer)
        self.draw_action = QAction("Draw/edit", b)
        self.draw_action.setCheckable(True)
        self.draw_action.setChecked(True)
        self.draw_action.setToolTip("When off, the recording can be inspected without changing annotations")
        self.draw_action.toggled.connect(self.controller.set_drawing_enabled)
        tb.addAction(self.draw_action)
        self.delete_action = QAction("Delete", b)
        self.delete_action.setShortcuts([QKeySequence(Qt.Key_Delete), QKeySequence(Qt.Key_Backspace)])
        self.delete_action.triggered.connect(self.delete_selection)
        tb.addAction(self.delete_action)
        self.undo_action = QAction("Undo", b)
        self.undo_action.setShortcut(QKeySequence.Undo)
        self.undo_action.triggered.connect(self.controller.undo)
        tb.addAction(self.undo_action)
        self.redo_action = QAction("Redo", b)
        self.redo_action.setShortcuts([QKeySequence("Ctrl+Y"), QKeySequence("Ctrl+Shift+Z")])
        self.redo_action.triggered.connect(self.controller.redo)
        tb.addAction(self.redo_action)
        tb.addSeparator()
        self.save_btn = QPushButton("Save and Finish")
        style.set_kind(self.save_btn, "primary")  # the one primary action of the window
        self.save_btn.setToolTip("Validate and save your annotations, then mark this recording complete")
        self.save_btn.clicked.connect(self.save_and_finish)
        self.save_action = tb.addWidget(self.save_btn)
        self.help_action = QAction("Help", b)
        self.help_action.setToolTip("Keys and mouse actions (?)")
        self.help_action.triggered.connect(self.show_help)
        tb.addAction(self.help_action)
        self.draw_action.setToolTip(self.draw_action.toolTip() + " · Delete removes the selected annotation")
        self.delete_action.setToolTip("Delete the selected annotation (Delete or Backspace)")
        self._build_shortcuts()
        b._ec_resized = self._fit_toolbar  # fits the toolbars to the window's width
        if self.read_only:
            for w in (self.label_combo, self.scope_whole, self.scope_channels, self.choose_channels_btn, self.save_btn,
                      *self.quick_buttons):
                w.setEnabled(False)
            for a in (self.draw_action, self.delete_action, self.undo_action, self.redo_action, *self.type_actions,
                      self.find_type_action, self.mark_action, self.mark_start_action, self.mark_end_action,
                      self.scope_action):
                a.setEnabled(False)
            # Widgets in a toolbar are shown and hidden through their toolbar action.
            self.save_action.setVisible(False)

    def _fit_toolbar(self) -> None:
        """Keep every control on screen whatever the window width and fonts.

        The editing actions and Save and Finish share the first row with MNE's icons; when the two
        do not fit side by side, the actions move to a row of their own, so Save and Finish never
        ends up in an overflow menu. The type buttons show their abbreviations when the row has room,
        otherwise only their keys (they keep their colour, number and tooltip, and the menu shows
        the type's name)."""
        try:
            self._fit_toolbar_now()
        except RuntimeError:  # the window is being destroyed
            pass

    def _fit_toolbar_now(self) -> None:
        b = self.browser
        acts = getattr(self, "actions_toolbar", None)
        mne_bar = getattr(b.mne, "toolbar", None)
        if acts is not None and mne_bar is not None:
            needed = mne_bar.sizeHint().width() + acts.sizeHint().width() + 16
            own_row = b.toolBarBreak(acts)
            if needed > b.width() and not own_row:
                b.insertToolBarBreak(acts)
            elif needed <= b.width() and own_row:
                b.removeToolBarBreak(acts)
        if not getattr(self, "quick_buttons", None):
            return
        for btn in self.quick_buttons:
            btn.setText(btn.property("full_text"))
        # The layouts cache their size hints; recalculate them for the full labels.
        self._chips.layout().invalidate()
        self.toolbar.layout().invalidate()
        if self.toolbar.sizeHint().width() > self.browser.width() - 24:
            for btn in self.quick_buttons:
                btn.setText(btn.property("compact_text"))
            self._chips.layout().invalidate()
            self.toolbar.layout().invalidate()

    def _quick_labels(self) -> list[str]:
        """The types on keys 1 to 9: the study's choice, or the first specific types of the catalogue."""
        cat = self.session.catalogue
        chosen = [n for n in getattr(self.settings, "quick_labels", ()) if cat.is_permitted(n)][:9]
        return chosen or list(cat.specific_labels)[:9]

    def _build_shortcuts(self) -> None:
        """Window-wide keys for annotating. None of them is one of MNE's own browsing keys."""
        b = self.browser

        def shortcut(text: str, keys: list[Any], slot: Any) -> QAction:
            act = QAction(text, b)
            act.setShortcuts([QKeySequence(k) for k in keys])
            act.setShortcutContext(Qt.WindowShortcut)
            act.triggered.connect(slot)
            b.addAction(act)  # not shown anywhere; the window keeps it for its keys
            return act

        self.type_actions = []
        digits = [Qt.Key_1, Qt.Key_2, Qt.Key_3, Qt.Key_4, Qt.Key_5, Qt.Key_6, Qt.Key_7, Qt.Key_8, Qt.Key_9]
        for key, name in enumerate(self.quick_labels, start=1):
            qt_key = digits[key - 1]
            self.type_actions.append(shortcut(
                f"Type {key}: {name}", [qt_key, Qt.KeypadModifier | qt_key], lambda _=False, n=name: self.apply_type(n)
            ))
        self.find_type_action = shortcut("Find a type…", [Qt.Key_Slash, QKeySequence.Find], lambda: self.find_type())
        self.mark_action = shortcut("Mark start, then end", [Qt.Key_M], lambda: self.mark_key("toggle"))
        self.mark_start_action = shortcut("Mark start", [Qt.Key_BracketLeft], lambda: self.mark_key("start"))
        self.mark_end_action = shortcut("Mark end", [Qt.Key_BracketRight], lambda: self.mark_key("end"))
        self.next_action = shortcut("Next annotation", [Qt.Key_N], lambda: self.controller.step_selection(1))
        self.prev_action = shortcut("Previous annotation", [Qt.Key_P], lambda: self.controller.step_selection(-1))
        self.scope_action = shortcut("Whole montage or selected channels", [Qt.Key_C], self.toggle_scope)
        self.controller.requestTypeChange = self.change_type_of  # type: ignore[method-assign]
        self.controller.annotationCreated.connect(self._reveal_in_table)

    # ------------------------------------------------------- choosing types
    def _target_ids(self) -> list[str]:
        """The annotations that the type keys, buttons and menu change: the selected ones, if any."""
        store = self.session.store
        ids = [i for i in self._selected_ids() if i in store]
        if not ids and self.controller.selected_id is not None and self.controller.selected_id in store:
            ids = [self.controller.selected_id]
        return ids

    def apply_type(self, name: str) -> None:
        """Keys 1 to 9, the type buttons, the menu and the picker all come here.

        With annotations selected, they change to this type; otherwise it becomes the type of the
        next annotation."""
        cat = self.session.catalogue
        cat.get(name)
        ids = self._target_ids()
        if ids and not self.read_only:
            if not self.controller._check_editable():
                self._refresh_type_display()
                return
            store = self.session.store
            if all(store.get(i).label == name for i in ids):
                self._show_message(f"Already {name}")
            else:
                self.controller.relabel_many(ids, name)
                what = "the selected annotation" if len(ids) == 1 else f"{len(ids)} annotations"
                self._show_message(
                    f"Changed {what} to {name} ({UNDO_HINT}). Esc or a click on empty EEG ends the selection."
                )
        else:
            self.controller.set_current_label(name)
            self._show_message(f"Next: {name}. Drag across the EEG, or press M at the start and again at the end.")
        self._refresh_type_display()

    def find_type(self) -> None:
        """/ : the searchable list of every type, under the type menu."""
        ids = self._target_ids()
        store = self.session.store
        current = store.get(ids[0]).label if ids else self.controller.current_label
        title = ("Change the selected annotation to" if len(ids) == 1 else f"Change {len(ids)} annotations to") \
            if ids else "Type of the next annotation"
        at = self.label_combo.mapToGlobal(self.label_combo.rect().bottomLeft())
        chosen = self.prompts.choose_label(self.browser, title, self.session.catalogue, current,
                                           quick=self.quick_labels, at=at)
        if chosen:
            self.apply_type(chosen)

    def change_type_of(self, annotation_id: str, screen_pos: Any = None) -> None:
        """Double-click on an annotation: choose its new type in the picker, opened at the pointer."""
        if self.read_only or annotation_id not in self.session.store:
            return
        self.controller.select(annotation_id)
        if not self.controller._check_editable():
            return
        current = self.session.store.get(annotation_id).label
        at = screen_pos.toPoint() if hasattr(screen_pos, "toPoint") else screen_pos
        chosen = self.prompts.choose_label(self.browser, f"Change {current} to", self.session.catalogue, current,
                                           quick=self.quick_labels, at=at or QCursor.pos())
        if chosen and chosen != current:
            self.apply_type(chosen)

    def toggle_scope(self) -> None:
        """C: switch between the whole montage and the selected channels for the next annotation."""
        (self.scope_channels if self.controller.scope == "whole" else self.scope_whole).click()
        self._show_message(
            "Next annotation: whole montage" if self.controller.scope == "whole" else
            "Next annotation: selected channels (click channel names to choose them)"
        )

    # ------------------------------------------------------ keyboard marks
    def pointer_time(self) -> float | None:
        """The time under the mouse pointer, or None when it is not over the EEG."""
        p = self.browser.mne
        view = getattr(p, "view", None)
        vb = getattr(p, "viewbox", None)
        if view is None or vb is None:
            return None
        pos = view.mapFromGlobal(QCursor.pos())
        if not view.rect().contains(pos):
            return None
        scene = view.mapToScene(pos)
        if not vb.sceneBoundingRect().contains(scene):
            return None
        return float(vb.mapSceneToView(scene).x())

    def mark_key(self, kind: str, t: float | None = None) -> None:
        """M (start, then end), [ (start) and ] (end), at the pointer."""
        if t is None:
            t = self.pointer_time()
        if t is None:
            where = "ends" if kind == "end" or (kind == "toggle" and self.controller.mark_start is not None) else "starts"
            key = {"start": "[", "end": "]"}.get(kind, "M")
            self._show_message(f"Point at the EEG where the artifact {where}, then press {key}.")
            return
        if kind == "start":
            self.controller.start_mark(t)
        elif kind == "end":
            self.controller.end_mark(t)
        else:
            self.controller.toggle_mark(t)

    def _reveal_in_table(self, annotation_id: str) -> None:
        """Scroll the list to a new annotation (without selecting it)."""
        for r in range(self.table.rowCount()):
            item = self.table.item(r, 0)
            if item is not None and item.data(Qt.UserRole) == annotation_id:
                self.table.scrollToItem(item)
                break

    def _refresh_type_display(self) -> None:
        """Show the selected annotations' type while there is a selection, otherwise the next type."""
        ids = self._target_ids()
        store = self.session.store
        if ids:
            labels = {store.get(i).label for i in ids}
            shown = next(iter(labels)) if len(labels) == 1 else None
            self.type_caption.setText(" Change to ")
            self.type_caption.setToolTip("Annotations are selected: a type button, key or menu choice changes them")
        else:
            shown = self.controller.current_label
            self.type_caption.setText(" Draw as ")
            self.type_caption.setToolTip("The type of the next annotation")
        for name, btn in zip(self.quick_labels, self.quick_buttons):
            btn.setChecked(name == shown)
        self.label_combo.blockSignals(True)
        self.label_combo.setCurrentIndex(self.label_combo.findData(shown) if shown else -1)
        self.label_combo.blockSignals(False)

    def _build_annotation_panel(self) -> None:
        dock = QDockWidget("Annotations", self.browser)
        dock.setObjectName("electroclean_annotations")
        dock.setFeatures(QDockWidget.DockWidgetMovable | QDockWidget.DockWidgetFloatable)
        w = QWidget()
        layout = QVBoxLayout(w)
        layout.setContentsMargins(4, 4, 4, 4)
        self.count_label = style.label("", "subtitle")
        layout.addWidget(self.count_label)
        # Duration is in each row's tooltip: with it as a column the channel list had no room in the panel.
        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["Label", "Code", "Start (s)", "End (s)", "Channels"])
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.ResizeToContents)
        # Long labels are elided (full name in the tooltip) and the channel list takes the remaining
        # width, rather than the panel needing a horizontal scroll bar.
        header.setSectionResizeMode(0, QHeaderView.Interactive)
        header.resizeSection(0, 200)
        header.setSectionResizeMode(4, QHeaderView.Stretch)
        self.table.setTextElideMode(Qt.ElideRight)
        header.setStretchLastSection(True)
        self.table.setWordWrap(False)
        w.setMinimumWidth(440)
        self.table.itemSelectionChanged.connect(self._on_table_selection)
        self.table.cellDoubleClicked.connect(lambda r, c: self._jump_row(r))
        layout.addWidget(self.table)
        row1 = QHBoxLayout()
        row2 = QHBoxLayout()
        self.btn_goto = QPushButton("Go to")
        self.btn_times = QPushButton("Edit times…")
        self.btn_label = QPushButton("Change label…")
        self.btn_chans = QPushButton("Edit channels…")
        self.btn_merge = QPushButton("Merge")
        self.btn_delete = QPushButton("Delete")
        style.set_kind(self.btn_delete, "destructive")
        self.btn_merge.setToolTip("Merge the selected annotations (same label only) into one interval")
        for btn in (self.btn_goto, self.btn_times, self.btn_label):
            row1.addWidget(btn)
        for btn in (self.btn_chans, self.btn_merge, self.btn_delete):
            row2.addWidget(btn)
        layout.addLayout(row1)
        layout.addLayout(row2)
        self.btn_goto.clicked.connect(lambda: self._selected_ids() and self.controller.jump_to(self._selected_ids()[0]))
        self.btn_times.clicked.connect(self.edit_times_of_selected)
        self.btn_label.clicked.connect(self.relabel_selected)
        self.btn_chans.clicked.connect(lambda: self._selected_ids() and self.edit_channels_of(self._selected_ids()[0]))
        self.btn_merge.clicked.connect(self.merge_selected)
        self.btn_delete.clicked.connect(self.delete_selected_rows)
        if self.read_only:
            for btn in (self.btn_times, self.btn_label, self.btn_chans, self.btn_merge, self.btn_delete):
                btn.setVisible(False)
        dock.setWidget(w)
        self.browser.addDockWidget(Qt.RightDockWidgetArea, dock)
        self.annotation_dock = dock

    def _build_info_panels(self) -> None:
        dock = QDockWidget("Recording and help", self.browser)
        dock.setObjectName("electroclean_info")
        dock.setFeatures(QDockWidget.DockWidgetMovable | QDockWidget.DockWidgetFloatable)
        tabs = QTabWidget()
        info = QWidget()
        il = QVBoxLayout(info)
        il.setContentsMargins(4, 4, 4, 4)
        self.clock_label = style.label("", "heading")
        il.addWidget(self.clock_label)
        self.zones_check = QCheckBox("Show filter edge zones")
        self.zones_check.setChecked(True)
        self.zones_check.toggled.connect(self.controller.set_transient_zones_visible)
        il.addWidget(self.zones_check)
        self.info_text = QTextBrowser()
        self.info_text.setOpenExternalLinks(False)
        self.info_text.setHtml(self._info_html())
        il.addWidget(self.info_text)
        tabs.addTab(info, "Recording")
        help_view = QTextBrowser()
        help_view.setHtml(HELP_HTML)
        tabs.addTab(help_view, "Help")
        self.info_tabs = tabs

        def show_help() -> None:
            dock.show()
            dock.raise_()
            tabs.setCurrentWidget(help_view)

        self.browser._ec_help = show_help
        dock.setWidget(tabs)
        self.browser.addDockWidget(Qt.RightDockWidgetArea, dock)
        self.info_dock = dock

    def _build_status_bar(self) -> None:
        sb = self.browser.statusBar()
        s = self.session
        self.status_fixed = QLabel(
            f"Recording: {s.recording_id}   |   Annotator: {s.annotator_id}"
            + (f" ({html.escape(s.display_name)})" if s.display_name else "")
            + f"   |   Mode: {s.mode}   |   Filters: {s.filters.describe()}"
        )
        # A reminder of the annotating keys, on the left; status messages replace it for a while.
        self.hint_label = style.label("N / P  next, previous annotation" if self.read_only else KEY_HINT, "caption")
        sb.addWidget(self.hint_label)
        sb.addPermanentWidget(self.status_fixed)
        self.status_progress = QLabel()
        sb.addPermanentWidget(self.status_progress)

    def _info_html(self) -> str:
        lr = self.loaded
        s = self.session
        t = lr.timing
        fr = lr.filter_report
        n_hidden_by_setting = len(lr.info.hidden_channels) - len(lr.trigger_channels)
        hidden = "; ".join(
            ([f"{n_hidden_by_setting} hidden by the channels.hide setting"] if n_hidden_by_setting else [])
            + ([f"{len(lr.trigger_channels)} trigger channel(s) not shown"] if lr.trigger_channels else [])
        )
        rows = [
            ("Recording", lr.info.recording_id),
            ("Annotator", s.annotator_id + (f" – {s.display_name}" if s.display_name else "")),
            ("Mode", s.mode + (f" ({s.context_id})" if s.context_id else "")),
            ("Sampling rate", f"{t.sfreq:g} Hz"),
            ("Duration", f"{t.duration_s:.1f} s ({format_hms(t.duration_s)})"),
            ("Format", lr.files.format_name),
            ("Channels", str(len(lr.info.ch_names))
             + (f" shown ({hidden})" if hidden else "")),
            ("Viewing filters", s.filters.describe() + (" (fixed by administrator)" if s.filters.locked else "")),
            ("Filter edge zones", f"±{fr.transient_half_width_s:.2f} s at edges and discontinuities"),
            ("Original events", f"{len(lr.original_events)} from {lr.original_events.describe_source()}"),
        ]
        out = ["<table cellspacing='3'>"]
        for k, v in rows:
            out.append(f"<tr><td><b>{html.escape(k)}</b></td><td>{html.escape(v)}</td></tr>")
        out.append("</table>")
        if lr.warnings:
            out.append("<h4>Checks and warnings</h4><ul>")
            out.extend(f"<li>{html.escape(w)}</li>" for w in lr.warnings)
            out.append("</ul>")
        if lr.notes:
            out.append("<h4>Notes</h4><ul>")
            out.extend(f"<li>{html.escape(n)}</li>" for n in lr.notes)
            out.append("</ul>")
        out.append(
            f"<p style='color:{style.colour('text_secondary')}'>Filters change only what you see. The recording files are never "
            "modified. Zero-phase filters can make sharp transients appear to start slightly earlier; "
            "mark the artifact where the underlying event begins.</p>"
        )
        return "".join(out)

    # -------------------------------------------------------------- updates
    def _refresh_state(self) -> None:
        c = self.controller
        self._refresh_type_display()
        chans = c.selected_channels
        if c.scope == "whole":
            self.channels_summary.setText(" all channels ")
            self.channels_summary.setToolTip("Annotations apply to the whole montage")
            style.set_state(self.channels_summary, "")
        elif not chans:
            self.channels_summary.setText(" none selected ")
            self.channels_summary.setToolTip("Click channel names, or use Channels…")
            style.set_state(self.channels_summary, "warning")
        else:
            shown = ", ".join(chans[:3]) + (f" (+{len(chans) - 3})" if len(chans) > 3 else "")
            self.channels_summary.setText(f" {shown} ")
            self.channels_summary.setToolTip(", ".join(chans))
            style.set_state(self.channels_summary, "selected")
        self.scope_whole.blockSignals(True)
        self.scope_channels.blockSignals(True)
        self.scope_whole.setChecked(c.scope == "whole")
        self.scope_channels.setChecked(c.scope == "channels")
        self.scope_whole.blockSignals(False)
        self.scope_channels.blockSignals(False)
        self.draw_action.blockSignals(True)
        self.draw_action.setChecked(c.drawing_enabled)
        self.draw_action.blockSignals(False)
        self._update_actions()

    def _update_actions(self) -> None:
        store = self.session.store
        editable = self.controller.editable
        # Undo and Redo stay enabled (they report "Nothing to undo"), so that their shortcuts
        # are always consumed here and never reach the EEG browser's own single-key shortcuts.
        self.undo_action.setEnabled(not self.read_only)
        self.redo_action.setEnabled(not self.read_only)
        self.delete_action.setEnabled(editable)
        self.undo_action.setToolTip(f"Undo {store.undo_description}" if store.can_undo else "Nothing to undo")
        self.redo_action.setToolTip(f"Redo {store.redo_description}" if store.can_redo else "Nothing to redo")
        ids = self._selected_ids()
        anns = [store.get(i) for i in ids if i in store]
        has = bool(anns)
        self.btn_goto.setEnabled(has)
        self.btn_times.setEnabled(editable and len(anns) == 1)
        self.btn_label.setEnabled(editable and has)
        self.btn_chans.setEnabled(editable and len(anns) == 1)
        self.btn_delete.setEnabled(editable and has)
        self.btn_merge.setEnabled(editable and len(anns) >= 2 and len({a.label for a in anns}) == 1)

    def _refresh_table(self) -> None:
        store = self.session.store
        timing = self.loaded.timing
        cat = self.session.catalogue
        prefix = getattr(self.controller, "display_prefix", {})
        selected = set(self._selected_ids())
        anns = store.annotations()
        self.table.blockSignals(True)
        self.table.setRowCount(len(anns))
        for r, a in enumerate(anns):
            lab = cat.get(a.label)
            label_item = QTableWidgetItem(colour_icon(lab.colour), prefix.get(a.annotation_id, "") + a.label)
            label_item.setData(Qt.UserRole, a.annotation_id)
            label_item.setToolTip(f"{a.label}\n{self._hed.get(a.label, '')}".strip())
            # The count comes first, so annotations on 40 and on 64 channels can be told apart even
            # when the list is cut short; the tooltip has the full list.
            all_chans = "Whole montage" if a.is_global else ", ".join(a.channels)
            if a.is_global or len(a.channels) == 1:
                chans = all_chans
            else:
                chans = f"{len(a.channels)} ch: {all_chans}"
            values = [
                label_item,
                QTableWidgetItem(str(lab.value)),
                QTableWidgetItem(f"{a.onset(timing):.3f}"),
                QTableWidgetItem(f"{a.offset(timing):.3f}"),
                QTableWidgetItem(chans),
            ]
            for item in values[1:4]:
                item.setToolTip(f"{a.onset(timing):.3f} to {a.offset(timing):.3f} s, duration {a.duration(timing):.3f} s")
            values[4].setToolTip(all_chans)
            for c, item in enumerate(values):
                self.table.setItem(r, c, item)
        self.table.clearSelection()
        for r, a in enumerate(anns):
            if a.annotation_id in selected or a.annotation_id == self.controller.selected_id:
                self.table.selectRow(r)
        self.table.blockSignals(False)
        n = len(anns)
        n_ch = sum(1 for a in anns if not a.is_global)
        self.count_label.setText(f"{n} annotation(s): {n - n_ch} whole montage, {n_ch} channel-specific")
        self.status_progress.setText(f"   |   Annotations: {n}")
        self._update_actions()
        self._refresh_type_display()

    def _update_clock(self) -> None:
        try:
            self.clock_label.setText(f"Time on this recording: {format_hms(self.session.elapsed_s)}")
        except RuntimeError:  # window already destroyed
            return
        if not self.read_only and not self._finished:
            self.session.autosave()
        if not self.read_only and not self._finished and not self.session.heartbeat() and not self._lock_warned:
            self._lock_warned = True
            self._show_message(
                "Warning: this recording's lock was lost (was the computer asleep?). "
                "ElectroClean will try to take it again when you press Save and Finish."
            )

    def _show_message(self, msg: str) -> None:
        self.browser.statusBar().showMessage(msg, 10000)

    # ------------------------------------------------------------ selection
    def _selected_ids(self) -> list[str]:
        rows = sorted({i.row() for i in self.table.selectedIndexes()})
        out = []
        for r in rows:
            item = self.table.item(r, 0)
            if item is not None:
                out.append(item.data(Qt.UserRole))
        return out

    def _on_table_selection(self) -> None:
        ids = self._selected_ids()
        if len(ids) == 1:
            self.controller.jump_to(ids[0])
        elif ids:
            self.controller.select(ids[0])
        else:
            self.controller.select(None)
        self._update_actions()
        self._refresh_type_display()

    def _on_controller_selection(self, aid: str | None) -> None:
        if aid is not None and aid in self._selected_ids():
            self._update_actions()  # keep a multi-row selection made in the list
            self._refresh_type_display()
            return
        self.table.blockSignals(True)
        self.table.clearSelection()
        if aid is not None:
            for r in range(self.table.rowCount()):
                if self.table.item(r, 0).data(Qt.UserRole) == aid:
                    self.table.selectRow(r)
                    self.table.scrollToItem(self.table.item(r, 0))
                    break
        self.table.blockSignals(False)
        self._update_actions()
        self._refresh_type_display()

    def _jump_row(self, row: int) -> None:
        item = self.table.item(row, 0)
        if item is not None:
            self.controller.jump_to(item.data(Qt.UserRole))

    # -------------------------------------------------------------- actions
    def show_help(self) -> None:
        self.info_dock.show()
        self.info_dock.raise_()
        self.info_tabs.setCurrentIndex(1)

    def choose_channels(self) -> None:
        types = dict(zip(self.loaded.view_raw.ch_names, self.loaded.view_raw.get_channel_types()))
        chosen = self.prompts.choose_channels(
            self.browser,
            self.loaded.info.ch_names,
            self.controller.selected_channels,
            title="Channels for new annotations",
            allow_whole_montage=False,
            ch_types=types,
        )
        if chosen is not None:
            self.controller.set_selected_channels(chosen)
            self.controller.set_scope("channels")

    def edit_channels_of(self, annotation_id: str) -> None:
        ann = self.session.store.get(annotation_id)
        types = dict(zip(self.loaded.view_raw.ch_names, self.loaded.view_raw.get_channel_types()))
        chosen = self.prompts.choose_channels(
            self.browser,
            self.loaded.info.ch_names,
            list(ann.channels),
            title=f"Channels affected by this {ann.label}",
            allow_whole_montage=True,
            whole_montage=ann.is_global,
            ch_types=types,
        )
        if chosen is None:
            return
        try:
            self.controller.set_annotation_channels(annotation_id, chosen)
        except AnnotationError as exc:
            self.prompts.error(self.browser, "Channels not changed", str(exc))

    def edit_times_of_selected(self) -> None:
        ids = self._selected_ids()
        if len(ids) != 1 or not self.controller._check_editable():
            return
        ann = self.session.store.get(ids[0])
        t = self.loaded.timing
        values = self.prompts.edit_times(self.browser, ann.onset(t), ann.offset(t), t.sfreq, t.duration_s)
        if values is None:
            return
        try:
            self.session.store.set_interval(ids[0], *values)
        except AnnotationError as exc:
            self.prompts.error(self.browser, "Times not changed", str(exc))

    def relabel_selected(self) -> None:
        ids = self._selected_ids()
        if not ids or not self.controller._check_editable():
            return
        current = self.session.store.get(ids[0]).label
        label = self.prompts.choose_label(self.browser, "Change label", self.session.catalogue, current,
                                          quick=self.quick_labels)
        if label is None or label == current and len(ids) == 1:
            return
        self.controller.relabel_many(ids, label)

    def merge_selected(self) -> None:
        ids = self._selected_ids()
        if not self.controller._check_editable():
            return
        try:
            merged = self.session.store.merge(ids)
        except AnnotationError as exc:
            self.prompts.error(self.browser, "Cannot merge", str(exc))
            return
        self.controller.select(merged.annotation_id)
        self._show_message(f"Merged {len(ids)} annotations into one {merged.label} ({UNDO_HINT})")

    def delete_selected_rows(self) -> None:
        ids = self._selected_ids()
        if ids and self.controller._check_editable():
            self.session.store.delete_many(ids)
            self._show_message(f"Deleted {len(ids)} annotation(s) ({UNDO_HINT})")

    def delete_selection(self) -> None:
        """Delete key: every selected row of the list, or the annotation selected in the EEG."""
        if len(self._selected_ids()) > 1:
            self.delete_selected_rows()
        else:
            self.controller.delete_selected()

    # --------------------------------------------------------- finishing
    def show(self) -> None:
        # Fit the window to the screen (laptops are often 1366 × 768).
        width, height = 1600, 950
        screen = self.browser.screen() if hasattr(self.browser, "screen") else None
        if screen is not None:
            avail = screen.availableGeometry()
            width, height = min(width, int(avail.width() * 0.97)), min(height, int(avail.height() * 0.95))
        self.browser.resize(width, height)
        self.browser.resizeDocks([self.annotation_dock], [470], Qt.Horizontal)
        self.browser.resizeDocks([self.annotation_dock, self.info_dock], [540, 340], Qt.Vertical)
        self.browser.show()
        self.browser.raise_()
        self.browser.activateWindow()
        # The timer starts once the viewer is on screen and usable.
        QTimer.singleShot(0, self._viewer_ready)

    def _viewer_ready(self) -> None:
        self.session.start_timer()
        self._update_clock()
        self.controller.relayout_labels()

    def view_state(self) -> dict[str, float]:
        """What the annotator set with MNE's keys: amplitude scale, seconds and channels shown."""
        p = self.browser.mne
        try:
            return {
                "scale_factor": float(p.scale_factor),
                "duration_s": float(p.duration),
                "n_channels": int(p.n_channels),
            }
        except (AttributeError, TypeError, ValueError):  # pragma: no cover - defensive
            return {}

    def save_and_finish(self) -> bool:
        if self.read_only or self._finished:
            return False
        store = self.session.store
        counts = {k: v for k, v in self.session.build_document().counts_by_label().items() if v}
        if not counts:
            ok = self.prompts.ask(
                self.browser,
                "Save and Finish",
                "You have not marked any artifacts in this recording.\n\n"
                "Save it as reviewed with no artifacts found, and finish?",
                yes="Save with no artifacts",
                no="Keep annotating",
                default_yes=False,
            )
        else:
            summary = "\n".join(f"  {label}: {n}" for label, n in counts.items())
            ok = self.prompts.ask(
                self.browser,
                "Save and Finish",
                f"Save {len(store)} annotation(s) and finish this recording?\n\n{summary}\n\n"
                "You will not be able to change them afterwards.",
                yes="Save and Finish",
                no="Keep annotating",
            )
        if not ok:
            return False
        self.save_btn.setEnabled(False)
        self.session.display_state = self.view_state()
        try:
            result = self.session.finish()
        except ExportCommitError as exc:
            if exc.committed:
                self.prompts.inform(self.browser, "Saved", str(exc))
                self._complete(None)
                return True
            self._save_failed(str(exc))
            return False
        except (SessionError, ValidationError, OSError, ValueError, AnnotationError) as exc:
            self._save_failed(str(exc))
            return False
        except Exception as exc:  # never leave the annotator with a disabled Save button
            self._save_failed(f"Unexpected error ({type(exc).__name__}): {exc}")
            return False
        self._complete(result)
        return True

    def _save_failed(self, message: str) -> None:
        self.save_btn.setEnabled(True)
        self.prompts.error(
            self.browser,
            "Could not save",
            "Your annotations could not be saved, so this recording has NOT been marked complete.\n\n"
            f"{message}\n\nYour annotations are still open: you can try Save and Finish again.",
        )

    def _complete(self, result: Any) -> None:
        self._finished = True
        self._closing_ok = True
        self._tick.stop()
        self.browser.close()
        self.finished.emit(result)

    def _confirm_close(self) -> bool:
        if self._closing_ok:
            return True
        if self.read_only:
            self._tick.stop()
            self._closing_ok = True
            QTimer.singleShot(0, self.closedWithoutSaving.emit)
            return True
        n = len(self.session.store)
        later, discard, stay = "Close and finish later", "Discard and close", "Keep annotating"
        choice = self.prompts.choose(
            self.browser,
            "Close without saving?",
            "This recording has not been saved with Save and Finish, so it is not complete.\n\n"
            f"{later}: "
            + (f"your {n} annotation(s) and the time spent are kept" if n else "the time spent so far is kept")
            + ", and ElectroClean offers to "
            "continue the next time you open this recording.\n\n"
            f"{discard}: your annotations for this recording are deleted.",
            [later, discard, stay],
            default=0,
        )
        if choice == stay:
            return False
        if choice == discard and n and not self.prompts.ask(
            self.browser, "Discard annotations?", f"Delete your {n} annotation(s) for this recording?",
            yes="Delete them", no="Keep annotating", default_yes=False,
        ):
            return False
        self._closing_ok = True
        self._tick.stop()
        try:
            self.session.abandon(
                "closed to finish later" if choice == later else "viewer closed without Save and Finish",
                keep_autosave=choice == later,
            )
        except Exception as exc:  # e.g. the session log is on a disconnected network drive
            try:
                self.session.lock.release()
            except Exception:
                pass
            self.prompts.error(
                self.browser, "Problem while closing",
                f"The recording was closed and stays incomplete, but the session log could not be written: {exc}",
            )
        QTimer.singleShot(0, self.closedWithoutSaving.emit)
        return True

    def close(self) -> None:
        """Programmatic close (asks for confirmation unless already saved).

        Does nothing once the window has closed, for example after Save and Finish: MNE's browser
        deletes itself when it closes, and closing a deleted window would crash the application."""
        try:
            import shiboken6

            alive = shiboken6.isValid(self.browser)
        except ImportError:  # pragma: no cover - PySide6 is the supported binding
            alive = True
        if self._finished or getattr(self.browser, "_closed", False) or not alive:
            return
        self.browser.close()
