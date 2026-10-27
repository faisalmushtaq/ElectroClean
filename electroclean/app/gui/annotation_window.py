"""The annotation window: MNE's browser plus ElectroClean's controls.

The MNE browser is a ``QMainWindow``; ElectroClean adds to it

* an *Artifact annotation* toolbar (artifact type, active-type indicator,
  whole-montage / selected-channels switch, channel chooser, draw on/off,
  delete, undo, redo, help and Save and Finish);
* an *Annotations* panel listing every annotation with buttons to jump to,
  retime, relabel, change channels, merge and delete;
* *Recording* and *Help* panels; and
* a status bar showing the recording, annotator, mode, filters and progress.
"""

from __future__ import annotations

import html
from typing import Any

from qtpy.QtCore import QObject, Qt, QTimer, Signal
from qtpy.QtGui import QAction, QFont, QKeySequence
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
    QRadioButton,
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
from electroclean.app.gui.browser import AnnotationController, check_browser_version, create_browser
from electroclean.app.gui.dialogs import UserPrompts, colour_icon, readable_text_colour
from electroclean.app.gui.help_text import HELP_HTML, UNDO_HINT
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
    ) -> None:
        super().__init__()
        self.session = session
        self.settings = settings
        self.prompts = prompts or UserPrompts()
        self.read_only = read_only
        self.loaded = session.loaded
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
            duration_s=settings.display.duration_s,
            n_channels=settings.display.n_channels,
            scalings=settings.display.scalings,
            theme=settings.display.theme,
            overview_mode=settings.display.overview_mode,
        )
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
        b.addToolBarBreak(Qt.TopToolBarArea)
        tb = QToolBar("Artifact annotation", b)
        tb.setObjectName("electroclean_toolbar")
        tb.setMovable(False)
        b.addToolBar(Qt.TopToolBarArea, tb)
        self.toolbar = tb
        cat = self.session.catalogue

        tb.addWidget(QLabel(" Artifact: "))
        self.label_combo = QComboBox()
        self.label_combo.setMaxVisibleItems(36)
        section = None
        for lab in cat.labels:
            if lab.section and lab.section != section:
                # A heading for each family (not selectable).
                section = lab.section
                self.label_combo.addItem(f"— {section} —")
                head = self.label_combo.model().item(self.label_combo.count() - 1)
                head.setEnabled(False)
                head.setSelectable(False)
            text = f"{lab.label}  ({lab.value})"
            if lab.is_group:
                text += "  – exact type unclear"
            self.label_combo.addItem(colour_icon(lab.colour), text, lab.label)
            idx = self.label_combo.count() - 1
            self.label_combo.setItemData(idx, self._hed.get(lab.label, lab.label), Qt.ToolTipRole)
            if lab.is_group:
                font = self.label_combo.font()
                font.setItalic(True)
                self.label_combo.setItemData(idx, font, Qt.FontRole)
        self.label_combo.setToolTip(
            f"Only the {len(cat.labels)} HED-SCORE artifact terms can be used. Group terms (in italics) are for "
            "artifacts whose exact type is unclear."
        )
        # Without keyboard focus the arrow, page and letter keys keep moving through the EEG
        # instead of silently changing the artifact type.
        self.label_combo.setFocusPolicy(Qt.NoFocus)
        self.label_combo.currentIndexChanged.connect(
            lambda i: self.label_combo.itemData(i) and self.controller.set_current_label(self.label_combo.itemData(i))
        )
        tb.addWidget(self.label_combo)
        self.active_label = QLabel()  # colour and short code of the active type (the menu shows its name)
        tb.addWidget(self.active_label)
        tb.addSeparator()

        tb.addWidget(QLabel(" Applies to: "))
        self.scope_whole = QRadioButton("Whole montage")
        self.scope_channels = QRadioButton("Selected channels")
        group = QButtonGroup(tb)
        group.addButton(self.scope_whole)
        group.addButton(self.scope_channels)
        self.scope_whole.setChecked(True)
        self.scope_whole.toggled.connect(lambda on: on and self.controller.set_scope("whole"))
        self.scope_channels.toggled.connect(lambda on: on and self.controller.set_scope("channels"))
        for w in (self.scope_whole, self.scope_channels):
            w.setFocusPolicy(Qt.NoFocus)
        tb.addWidget(self.scope_whole)
        tb.addWidget(self.scope_channels)
        self.choose_channels_btn = QPushButton("Choose channels…")
        self.choose_channels_btn.clicked.connect(self.choose_channels)
        tb.addWidget(self.choose_channels_btn)
        self.channels_summary = QLabel()
        self.channels_summary.setMaximumWidth(170)
        tb.addWidget(self.channels_summary)
        tb.addSeparator()

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
        spacer = QWidget()
        spacer.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        tb.addWidget(spacer)
        self.save_btn = QPushButton("  Save and Finish  ")
        self.save_btn.setStyleSheet(
            "QPushButton { background: #2E7D32; color: white; font-weight: bold; padding: 4px 10px; border-radius: 4px; }"
            "QPushButton:disabled { background: #9E9E9E; }"
        )
        self.save_btn.setToolTip("Validate and save your annotations, then mark this recording complete")
        self.save_btn.clicked.connect(self.save_and_finish)
        self.save_action = tb.addWidget(self.save_btn)
        # Help comes last: on a narrow screen the toolbar's overflow menu takes it before Save.
        self.help_action = QAction("Help", b)
        self.help_action.triggered.connect(self.show_help)
        tb.addAction(self.help_action)
        if self.read_only:
            for w in (self.label_combo, self.scope_whole, self.scope_channels, self.choose_channels_btn, self.save_btn):
                w.setEnabled(False)
            for a in (self.draw_action, self.delete_action, self.undo_action, self.redo_action):
                a.setEnabled(False)
            # Widgets in a toolbar are shown and hidden through their toolbar action.
            self.save_action.setVisible(False)

    def _build_annotation_panel(self) -> None:
        dock = QDockWidget("Annotations", self.browser)
        dock.setObjectName("electroclean_annotations")
        dock.setFeatures(QDockWidget.DockWidgetMovable | QDockWidget.DockWidgetFloatable)
        w = QWidget()
        layout = QVBoxLayout(w)
        layout.setContentsMargins(4, 4, 4, 4)
        self.count_label = QLabel()
        layout.addWidget(self.count_label)
        self.table = QTableWidget(0, 6)
        self.table.setHorizontalHeaderLabels(["Label", "Code", "Start (s)", "End (s)", "Duration (s)", "Channels"])
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.ResizeToContents)
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
        self.clock_label = QLabel()
        f = QFont()
        f.setBold(True)
        self.clock_label.setFont(f)
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
        sb.addPermanentWidget(self.status_fixed)
        self.status_progress = QLabel()
        sb.addPermanentWidget(self.status_progress)

    def _info_html(self) -> str:
        lr = self.loaded
        s = self.session
        t = lr.timing
        fr = lr.filter_report
        rows = [
            ("Recording", lr.info.recording_id),
            ("Annotator", s.annotator_id + (f" – {s.display_name}" if s.display_name else "")),
            ("Mode", s.mode + (f" ({s.context_id})" if s.context_id else "")),
            ("Sampling rate", f"{t.sfreq:g} Hz"),
            ("Duration", f"{t.duration_s:.1f} s ({format_hms(t.duration_s)})"),
            ("Format", lr.files.format_name),
            ("Channels", str(len(lr.info.ch_names))
             + (f" shown ({len(lr.info.hidden_channels)} hidden by the channels.hide setting)" if lr.info.hidden_channels else "")),
            ("Viewing filters", s.filters.describe() + (" (fixed by administrator)" if s.filters.locked else "")),
            ("Filter edge zones", f"±{fr.transient_half_width_s:.2f} s at edges and discontinuities"),
            ("Original events", f"{len(lr.original_events)} from {lr.original_events.source.replace('_', ' ')}"),
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
            "<p style='color:#555'>Filters change only what you see. The recording files are never "
            "modified. Zero-phase filters can make sharp transients appear to start slightly earlier; "
            "mark the artifact where the underlying event begins.</p>"
        )
        return "".join(out)

    # -------------------------------------------------------------- updates
    def _refresh_state(self) -> None:
        c = self.controller
        lab = self.session.catalogue.get(c.current_label)
        fg = readable_text_colour(lab.colour)
        self.active_label.setText(f" {lab.short_code} ")
        self.active_label.setToolTip(f"The next drag creates: {lab.label} (code {lab.value})")
        self.active_label.setStyleSheet(
            f"QLabel {{ background: {lab.colour}; color: {fg}; font-weight: bold; border-radius: 3px; padding: 2px; }}"
        )
        idx = self.label_combo.findData(c.current_label)
        if idx >= 0 and idx != self.label_combo.currentIndex():
            self.label_combo.blockSignals(True)
            self.label_combo.setCurrentIndex(idx)
            self.label_combo.blockSignals(False)
        chans = c.selected_channels
        if c.scope == "whole":
            self.channels_summary.setText(" all channels ")
            self.channels_summary.setToolTip("Annotations apply to the whole montage")
            self.channels_summary.setStyleSheet("")
        elif not chans:
            self.channels_summary.setText(" none selected ")
            self.channels_summary.setToolTip("Click channel names, or use Choose channels…")
            self.channels_summary.setStyleSheet("QLabel { color: #B71C1C; font-weight: bold; }")
        else:
            shown = ", ".join(chans[:3]) + (f" (+{len(chans) - 3})" if len(chans) > 3 else "")
            self.channels_summary.setText(f" {shown} ")
            self.channels_summary.setToolTip(", ".join(chans))
            self.channels_summary.setStyleSheet("QLabel { color: #D81B60; font-weight: bold; }")
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
            label_item.setToolTip(self._hed.get(a.label, a.label))
            chans = "All (whole montage)" if a.is_global else ", ".join(a.channels)
            values = [
                label_item,
                QTableWidgetItem(str(lab.value)),
                QTableWidgetItem(f"{a.onset(timing):.3f}"),
                QTableWidgetItem(f"{a.offset(timing):.3f}"),
                QTableWidgetItem(f"{a.duration(timing):.3f}"),
                QTableWidgetItem(chans),
            ]
            values[5].setToolTip(chans)
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
        self._update_actions()

    def _on_controller_selection(self, aid: str | None) -> None:
        if aid is not None and aid in self._selected_ids():
            self._update_actions()  # keep a multi-row selection made in the list
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
        labels = list(self.session.catalogue.label_names)
        current = labels.index(self.session.store.get(ids[0]).label)
        label = self.prompts.choose_item(self.browser, "Change label", "New artifact type:", labels, current)
        if label is None:
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
            f"{later}: your {n} annotation(s) and the time spent are kept, and ElectroClean offers to "
            "continue the next time you open this recording.\n"
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
        """Programmatic close (asks for confirmation unless already saved)."""
        self.browser.close()
