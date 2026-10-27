"""Integration with MNE's Qt raw-data browser (mne-qt-browser).

ElectroClean reuses MNE's browser for everything to do with displaying EEG:
trace rendering, time and channel scrolling, zooming, amplitude scaling, the
overview bar, scale bars, the time cursor and the display of experimental
event markers. Annotation editing, however, is handled by ElectroClean
itself, because the standard browser

* lets users type arbitrary new annotation descriptions;
* automatically merges overlapping annotations that share a description,
  whereas the specification requires them to stay separate unless the
  annotator explicitly merges them;
* refuses to let a channel-specific annotation overlap another annotation of
  the same description;
* identifies annotations by their onset time, which is ambiguous when two
  annotations start at the same instant;
* marks channels as "bad" when their name or trace is clicked;
* has no Save and Finish control and no undo/redo.

All use of mne-qt-browser internals is concentrated in this module. The
browser classes are subclassed (never modified in place); the subclasses
behave exactly like the originals unless they belong to an ElectroClean
browser. The integration was written against mne-qt-browser 0.7.5 (see
``TESTED_MNE_QT_BROWSER``) and is covered by the GUI tests.
"""

from __future__ import annotations

import contextlib
import os
import warnings
import weakref
from collections.abc import Callable, Iterator
from typing import TYPE_CHECKING, Any

os.environ.setdefault("QT_API", "pyside6")

import mne  # noqa: E402
import mne_qt_browser  # noqa: E402
import mne_qt_browser._pg_figure as _pgf  # noqa: E402
import numpy as np  # noqa: E402
import pyqtgraph as pg  # noqa: E402
from mne_qt_browser._graphic_items import AnnotRegion, DataTrace  # noqa: E402
from mne_qt_browser._widgets import RawViewBox  # noqa: E402
from qtpy.QtCore import QObject, Qt, QTimer, Signal  # noqa: E402
from qtpy.QtGui import QBrush, QColor, QFontMetrics  # noqa: E402
from qtpy.QtWidgets import QMenu  # noqa: E402

from electroclean.app.annotations.mne_bridge import to_mne_annotations  # noqa: E402
from electroclean.app.annotations.model import AnnotationError  # noqa: E402
from electroclean.app.gui.dialogs import add_label_menu  # noqa: E402
from electroclean.app.gui.help_text import UNDO_HINT

if TYPE_CHECKING:  # pragma: no cover
    from electroclean.app.annotations.store import AnnotationStore, StoreChange

TESTED_MNE_QT_BROWSER = "0.7.5"
HIGHLIGHT_COLOUR = "#D81B60"  # selected channels (magenta, distinct from label colours)
EVENT_COLOUR = "#00838F"  # original experimental markers
# Trace colours by channel type. MNE draws ECG in magenta, which could be mistaken for the
# selected-channel highlight, so ECG is dark brown here; everything else stays black.
TRACE_COLOURS = {"eeg": "k", "eog": "k", "ecg": "#5D4037", "emg": "k", "misc": "k", "stim": "k", "resp": "k",
                 "bio": "k", "gsr": "k", "temperature": "k"}


@contextlib.contextmanager
def _annotation_mode(mne_params: Any) -> Iterator[None]:
    """Temporarily set MNE's annotation flag so inherited drag code runs."""
    old = mne_params.annotation_mode
    mne_params.annotation_mode = True
    try:
        yield
    finally:
        mne_params.annotation_mode = old


def _controller_of(main: Any) -> AnnotationController | None:
    return getattr(main, "_ec_controller", None) if main is not None else None


# ---------------------------------------------------------------- subclasses
class ElectroCleanBrowser(_pgf.MNEQtBrowser):
    """MNE's browser with a close guard and channel-click redirection."""

    def __init__(self, **kwargs: Any) -> None:
        self._ec_controller: AnnotationController | None = None
        self._ec_close_guard: Callable[[], bool] | None = None
        self._ec_help: Callable[[], None] | None = None
        super().__init__(**kwargs)

    def _toggle_help_fig(self) -> None:
        # MNE's help describes its own shortcuts (marking bad channels, Esc closes the
        # window), which do not apply here: show ElectroClean's help instead.
        if self._ec_help is not None:
            self._ec_help()
        else:  # pragma: no cover
            super()._toggle_help_fig()

    def _create_ch_context_fig(self, idx: Any) -> None:
        # Right-clicking a channel name shows its sensor position, which fails for
        # recordings without positions; say so instead of failing silently.
        try:
            super()._create_ch_context_fig(idx)
        except Exception as exc:  # noqa: BLE001
            with contextlib.suppress(Exception):
                self.statusBar().showMessage(f"No sensor position to show for this channel ({exc})", 8000)

    def closeEvent(self, event: Any) -> None:  # noqa: N802 (Qt naming)
        guard = self._ec_close_guard
        if guard is not None and not guard():
            event.ignore()
            return
        if self._ec_controller is not None:
            self._ec_controller.detach()
        with warnings.catch_warnings():
            # MNE disconnects every toolbar action on close; PySide warns about those never connected.
            warnings.filterwarnings("ignore", message=".*Failed to disconnect.*")
            super().closeEvent(event)

    def keyPressEvent(self, event: Any) -> None:  # noqa: N802
        # MNE's single-key shortcuts ignore Ctrl, so Ctrl+Z with nothing to undo would toggle
        # "zen mode", Ctrl+S the scale bars, and so on. None of MNE's shortcuts uses Ctrl,
        # Cmd or Alt, so such key presses are not passed on (ElectroClean's own shortcuts
        # are handled by their actions before they get here).
        if event.modifiers() & (Qt.ControlModifier | Qt.MetaModifier | Qt.AltModifier):
            event.accept()
            return
        super().keyPressEvent(event)

    def _check_close(self) -> None:
        # MNE maps Escape to closing the window; ElectroClean uses it to clear the selection.
        if self._ec_controller is not None:
            self._ec_controller.select(None)
        else:  # pragma: no cover
            super()._check_close()


class ElectroCleanViewBox(RawViewBox):
    """Plot area: dragging creates an ElectroClean annotation."""

    def mouseDragEvent(self, event: Any, axis: Any = None) -> None:  # noqa: N802
        ctrl = _controller_of(self.weakmain())
        if ctrl is None:
            return super().mouseDragEvent(event, axis)
        event.accept()
        if event.button() != Qt.LeftButton or not ctrl.drawing_enabled:
            return
        x = ctrl.clamp_time(self.mapSceneToView(event.scenePos()).x())
        if event.isStart():
            x0 = ctrl.clamp_time(self.mapSceneToView(event.buttonDownScenePos()).x())
            ctrl.begin_drag(x0, x)
        elif event.isFinish():
            ctrl.finish_drag(x)
        else:
            ctrl.update_drag(x)


class ElectroCleanDataTrace(DataTrace):
    """EEG trace: clicking selects channels instead of marking them bad."""

    def toggle_bad(self, x: Any = None) -> None:
        main = self.weakmain()
        if getattr(main, "_ec_readonly", False):
            return None  # read-only views (quiz segments) ignore clicks
        ctrl = _controller_of(main)
        if ctrl is None:
            return super().toggle_bad(x)
        ctrl.on_channel_clicked(self.ch_name)
        return None


# The browser looks these classes up by name in its own module when it builds
# the view and whenever it (re)creates traces. Substituting subclasses there is
# safe because they defer to the original behaviour for non-ElectroClean browsers.
_pgf.RawViewBox = ElectroCleanViewBox
_pgf.DataTrace = ElectroCleanDataTrace


class ArtifactRegion(AnnotRegion):
    """Shaded interval for one ElectroClean annotation (identified by id)."""

    label_row = 0
    annotation_id = ""

    def __init__(self, mne_params: Any, *, annotation_id: str, label: str, values: tuple[float, float],
                 channels: tuple[str, ...], weakmain: Any, controller: AnnotationController) -> None:
        super().__init__(mne_params, label, values, weakmain, ch_names=list(channels) if channels else None)
        self.annotation_id = annotation_id
        self._controller = weakref.ref(controller)
        self.setBounds((0, controller.duration_s))
        self.setToolTip(
            f"{label}\nClick to select · drag an edge to resize · Shift+drag to move\n"
            "Shift+click a channel to add/remove it · right-click for options"
        )
        self.label_item.setText(f"{label}{' [ch]' if channels else ''}")

    def _ctrl(self) -> AnnotationController | None:
        ref = getattr(self, "_controller", None)
        return ref() if ref is not None else None

    def _region_changed(self) -> None:
        # Replaces AnnotRegion._region_changed, which merges same-label regions.
        ctrl = self._ctrl()
        if ctrl is not None:
            ctrl.on_region_edited(self)

    def label_text_size(self) -> tuple[float, float]:
        """Width and height of the label in pixels, measured with its own font."""
        metrics = QFontMetrics(self.label_item.textItem.font())
        box = self.label_item.boundingRect()  # includes the text item's own padding
        width = max(metrics.horizontalAdvance(self.label_item.textItem.toPlainText()) + 12, box.width() + 4)
        return float(width), float(max(metrics.height() + 2, box.height() + 1))

    def update_label_pos(self) -> None:
        # Labels sit at the top of the plot (event labels are at the bottom),
        # staggered in rows so that neighbouring labels do not overlap. Rows are spaced by the
        # height of the text in pixels, converted to the plot's channel units.
        rgn = self.getRegion()
        vb = self.mne.viewbox
        if vb:
            (x0, x1), (y0, y1) = vb.viewRange()
            units_per_px = abs(y1 - y0) / max(1.0, float(vb.height()))
            text_px, line_px = self.label_text_size()
            # Keep the whole label on screen when the interval starts or ends outside the view.
            half = text_px / 2 * (x1 - x0) / max(1.0, float(vb.width()))
            x = sum(rgn) / 2
            if x1 - x0 > 2 * half:
                x = min(max(x, x0 + half), x1 - half)
            self.label_item.setPos(x, min(y0, y1) + (4 + line_px * (0.5 + self.label_row)) * units_per_px)

    def mouseClickEvent(self, event: Any) -> None:  # noqa: N802
        ctrl = self._ctrl()
        if ctrl is None:
            return event.ignore()
        if event.button() == Qt.LeftButton and event.modifiers() & Qt.ShiftModifier:
            scene_pos = self.mapToScene(event.pos())
            for t in self.mne.traces:
                if t.shape().contains(t.mapFromScene(scene_pos)):
                    ctrl.toggle_annotation_channel(self.annotation_id, t.ch_name)
                    break
            event.accept()
        elif event.button() == Qt.LeftButton:
            ctrl.select(self.annotation_id)
            event.accept()
        elif event.button() == Qt.RightButton:
            ctrl.select(self.annotation_id)
            ctrl.show_context_menu(self.annotation_id, event.screenPos())
            event.accept()
        else:
            event.ignore()

    def hoverEvent(self, ev: Any) -> None:  # noqa: N802
        # Only claim the drag (and highlight) when Shift is held, so that a plain
        # drag over an existing annotation draws a new, overlapping annotation.
        if (
            self.movable
            and not ev.isExit()
            and ev.modifiers() & Qt.ShiftModifier
            and ev.acceptDrags(Qt.LeftButton)
        ):
            self.setMouseHover(True)
        else:
            self.setMouseHover(False)

    def mouseDragEvent(self, ev: Any) -> None:  # noqa: N802
        """Shift+drag moves the whole annotation; a plain drag is passed to the
        plot so that a new (possibly overlapping) annotation can be drawn.
        Dragging an edge resizes (handled by the edge lines themselves)."""
        ctrl = self._ctrl()
        if ctrl is None or not ctrl.drawing_enabled:
            ev.ignore()
            return
        if ev.isStart() and not (ev.modifiers() & Qt.ShiftModifier):
            ev.ignore()
            return
        with _annotation_mode(self.mne):
            super().mouseDragEvent(ev)


# ------------------------------------------------------------- browser setup
@contextlib.contextmanager
def _use_browser_class(cls: type) -> Iterator[None]:
    original = _pgf.MNEQtBrowser
    _pgf.MNEQtBrowser = cls
    try:
        yield
    finally:
        _pgf.MNEQtBrowser = original


def create_browser(
    view_raw: Any,
    *,
    events: np.ndarray | None,
    event_id: dict[str, int] | None,
    label_colours: dict[str, str],
    title: str,
    duration_s: float,
    n_channels: int,
    scalings: dict[str, float],
    theme: str = "light",
    overview_mode: str = "channels",
) -> ElectroCleanBrowser:
    """Create (but do not show) an MNE Qt browser for the display copy."""
    mne.viz.set_browser_backend("qt", verbose="error")
    from qtpy.QtWidgets import QApplication

    app = QApplication.instance()
    app_name = app.applicationName() if app else "ElectroClean"
    kwargs: dict[str, Any] = dict(
        duration=float(min(duration_s, view_raw.times[-1] if len(view_raw.times) > 1 else duration_s)),
        n_channels=int(min(n_channels, len(view_raw.ch_names))),
        scalings=dict(scalings),
        title=title,
        show=False,
        block=False,
        show_scrollbars=True,
        show_scalebars=True,
        annotation_colors=dict(label_colours),
        color=dict(TRACE_COLOURS),
        theme=theme,
        overview_mode=overview_mode,
        splash=False,
        verbose="error",
    )
    if events is not None and len(events):
        kwargs.update(events=events, event_id=event_id, event_color=EVENT_COLOUR)
    # The display copy may carry annotations from an earlier window on the same
    # recording; MNE would draw its own (editable) regions for them, so clear them.
    view_raw.set_annotations(None)
    with _use_browser_class(ElectroCleanBrowser):
        browser = view_raw.plot(**kwargs)
    if app is not None:
        # mne-qt-browser renames the application; restore ours (affects QSettings).
        app.setApplicationName(app_name)
        app.setOrganizationName("ElectroClean")
    if not isinstance(browser, ElectroCleanBrowser):  # pragma: no cover - safety net
        raise RuntimeError("The MNE browser could not be created with ElectroClean's extensions")
    return browser


def make_readonly(browser: ElectroCleanBrowser) -> None:
    """Remove every way of editing from a browser (used for quiz segments)."""
    browser._ec_readonly = True
    p = browser.mne
    for action in list(p.toolbar.actions()):
        if action.text() in ("Toggle annotations mode",):
            p.toolbar.removeAction(action)
    for key in ("a", "j", "w", "h", "escape"):
        p.keyboard_shortcuts.pop(key, None)
    if getattr(p, "fig_annotation", None) is not None:
        p.fig_annotation.setVisible(False)


def add_highlight(browser: ElectroCleanBrowser, t0: float, t1: float, colour: tuple[int, int, int, int] = (42, 120, 214, 45)) -> Any:
    item = pg.LinearRegionItem(values=(t0, t1), movable=False, brush=QBrush(QColor(*colour)))
    item.setZValue(-4)
    browser.mne.plt.addItem(item, ignoreBounds=True)
    return item


def check_browser_version() -> str | None:
    """A warning if the installed mne-qt-browser differs from the tested one."""
    v = getattr(mne_qt_browser, "__version__", "unknown")
    if v != TESTED_MNE_QT_BROWSER:
        return (
            f"mne-qt-browser {v} is installed; ElectroClean was tested with {TESTED_MNE_QT_BROWSER}. "
            "Please check annotation editing carefully or install the pinned version."
        )
    return None


# ---------------------------------------------------------------- controller
class AnnotationController(QObject):
    """Connects the annotation store to the browser display and mouse input."""

    selectionChanged = Signal(object)  # annotation id or None
    stateChanged = Signal()  # label, scope, channel selection or drawing mode changed
    statusMessage = Signal(str)
    annotationsChanged = Signal()

    def __init__(self, browser: ElectroCleanBrowser, store: AnnotationStore, *,
                 transient_zones: list[tuple[float, float]] | None = None,
                 gap_zones: list[tuple[float, float]] | None = None) -> None:
        super().__init__()
        self.browser = browser
        self.store = store
        self.catalogue = store.catalogue
        self.recording = store.recording
        self.duration_s = self.recording.timing.duration_s
        self.current_label = self.catalogue.label_names[0]
        self.scope = "whole"  # or "channels"
        self.selected_channels: list[str] = []
        self.selected_id: str | None = None
        self.drawing_enabled = True
        self.read_only = False  # review windows: nothing can be changed
        self.display_prefix: dict[str, str] = {}  # e.g. "REF: " in review mode
        self.regions: dict[str, ArtifactRegion] = {}
        self._drag_preview: pg.LinearRegionItem | None = None
        self._drag_start: float | None = None
        self._sync_pending = False
        self._base_colours: dict[str, Any] = {}
        self._zone_items: list[pg.LinearRegionItem] = []
        self._gap_items: list[pg.LinearRegionItem] = []
        self._attached = False
        self._attach(transient_zones or [])
        self.set_gap_zones(gap_zones or [])

    # ------------------------------------------------------------ set-up
    def _attach(self, transient_zones: list[tuple[float, float]]) -> None:
        b = self.browser
        p = b.mne
        b._ec_controller = self
        labels = list(self.catalogue.label_names)
        p.new_annotation_labels = labels
        p.annotation_segment_colors = {lab: self.catalogue.colour_for(lab) for lab in labels}
        p.visible_annotations = {lab: True for lab in labels}
        p.current_description = None  # MNE's own annotation tool is never used
        if getattr(p, "fig_annotation", None) is not None:
            p.fig_annotation.setVisible(False)
        # Remove any regions MNE created itself; all regions are ElectroClean's from here on.
        for region in list(getattr(p, "regions", [])):
            if not isinstance(region, ArtifactRegion):
                b._remove_region(region, from_annot=False)
        # Remove the standard annotation-mode button and keyboard shortcuts that do not apply.
        for action in list(p.toolbar.actions()):
            if action.text() in ("Toggle annotations mode",):
                p.toolbar.removeAction(action)
        for key in ("a", "j", "w", "h"):
            p.keyboard_shortcuts.pop(key, None)
        self._base_colours = dict(p.ch_color_ref)
        self.set_transient_zones(transient_zones)
        self.store.add_listener(self._on_store_change)
        p.plt.sigXRangeChanged.connect(self.relayout_labels)
        self._attached = True
        self.sync_now()

    def detach(self) -> None:
        if self._attached:
            self.store.remove_listener(self._on_store_change)
            with contextlib.suppress(TypeError, RuntimeError, AttributeError):
                self.browser.mne.plt.sigXRangeChanged.disconnect(self.relayout_labels)
            self._attached = False

    # -------------------------------------------------------------- helpers
    def clamp_time(self, t: float) -> float:
        return float(min(max(t, 0.0), self.duration_s))

    def _say(self, msg: str) -> None:
        self.statusMessage.emit(msg)

    # ----------------------------------------------------------------- state
    def set_current_label(self, label: str) -> None:
        self.catalogue.get(label)
        self.current_label = label
        self.stateChanged.emit()

    def set_scope(self, scope: str) -> None:
        if scope not in ("whole", "channels"):
            raise ValueError(scope)
        self.scope = scope
        self._update_channel_highlight()
        self.stateChanged.emit()
        if scope == "channels" and not self.selected_channels:
            self._say("Click channel names or traces (or use 'Channels…') to select channels.")

    def set_selected_channels(self, channels: list[str]) -> None:
        order = self.recording.ch_names
        chosen = set(channels)
        self.selected_channels = [c for c in order if c in chosen]
        self._update_channel_highlight()
        self.stateChanged.emit()

    @property
    def editable(self) -> bool:
        return self.drawing_enabled and not self.read_only

    def set_read_only(self) -> None:
        """Make the view permanently read-only (review of a finished recording)."""
        self.read_only = True
        self.set_drawing_enabled(False)

    def _check_editable(self) -> bool:
        if self.editable:
            return True
        self._say(
            "This view is read-only" if self.read_only
            else "Drawing and editing is off: tick Draw/edit to change annotations"
        )
        return False

    def set_drawing_enabled(self, enabled: bool) -> None:
        if self.read_only:
            enabled = False
        self.drawing_enabled = bool(enabled)
        for region in self.regions.values():
            region.setMovable(self.drawing_enabled)
        self.stateChanged.emit()
        self._say("Drawing and editing on" if enabled else "Drawing and editing off (view only)")

    def on_channel_clicked(self, ch_name: str) -> None:
        if self.scope != "channels":
            self._say(
                f"{ch_name}: switch to 'Selected channels' to choose channels by clicking. "
                "Channels are not marked bad in ElectroClean."
            )
            return
        sel = set(self.selected_channels)
        sel.symmetric_difference_update({ch_name})
        self.set_selected_channels(list(sel))
        self._say(f"{len(self.selected_channels)} channel(s) selected for new annotations")

    def _update_channel_highlight(self) -> None:
        p = self.browser.mne
        highlight = set(self.selected_channels) if self.scope == "channels" else set()
        for ch, colour in self._base_colours.items():
            p.ch_color_ref[ch] = HIGHLIGHT_COLOUR if ch in highlight else colour
        for trace in list(getattr(p, "traces", [])):
            trace.update_color()
        with contextlib.suppress(Exception):
            p.channel_axis.repaint()

    # -------------------------------------------------------------- drawing
    def begin_drag(self, x0: float, x1: float) -> None:
        self._drag_start = x0
        colour = QColor(self.catalogue.colour_for(self.current_label))
        colour.setAlpha(60)
        self._drag_preview = pg.LinearRegionItem(values=(x0, x1), movable=False, brush=QBrush(colour))
        self._drag_preview.setZValue(5)
        self.browser.mne.plt.addItem(self._drag_preview, ignoreBounds=True)

    def update_drag(self, x: float) -> None:
        if self._drag_preview is not None and self._drag_start is not None:
            self._drag_preview.setRegion((self._drag_start, x))

    def finish_drag(self, x: float) -> None:
        start = self._drag_start
        if self._drag_preview is not None:
            self.browser.mne.plt.removeItem(self._drag_preview)
        self._drag_preview = None
        self._drag_start = None
        if start is not None:
            self.create_annotation(start, x)

    def create_annotation(self, t0: float, t1: float) -> str | None:
        """Create an annotation with the active label and channel scope."""
        if not self._check_editable():
            return None
        if self.scope == "channels" and not self.selected_channels:
            self._say("No channels selected: click channel names, use 'Channels…', or choose 'Whole montage'.")
            return None
        channels = list(self.selected_channels) if self.scope == "channels" else []
        try:
            ann = self.store.add_interval(self.current_label, t0, t1, channels)
        except AnnotationError as exc:
            self._say(f"Annotation not created: {exc}")
            return None
        self.selected_id = ann.annotation_id
        self.sync_now()
        self.selectionChanged.emit(ann.annotation_id)
        where = "whole montage" if ann.is_global else f"{len(ann.channels)} channel(s)"
        span = f"{ann.onset(self.recording.timing):.3f}–{ann.offset(self.recording.timing):.3f} s"
        if self.store.last_auto_merged:
            self._say(
                f"Merged with {self.store.last_auto_merged} overlapping {ann.label} annotation(s) on the same "
                f"channels: now {span} ({where}). {UNDO_HINT}."
            )
        else:
            self._say(f"Added {ann.label} {span} ({where})")
        return ann.annotation_id

    # --------------------------------------------------------------- editing
    def on_region_edited(self, region: ArtifactRegion) -> None:
        if not self.editable:
            self.schedule_sync(force=True)  # put the region back where the store has it
            return
        t0, t1 = region.getRegion()
        try:
            ann = self.store.set_interval(region.annotation_id, t0, t1)
        except AnnotationError as exc:
            self._say(f"Change not applied: {exc}")
            self.schedule_sync(force=True)
            return
        if self.store.last_auto_merged:
            self.selected_id = ann.annotation_id
            self.selectionChanged.emit(ann.annotation_id)
            self._say(f"Merged with {self.store.last_auto_merged} overlapping {ann.label} annotation(s) ({UNDO_HINT})")

    def toggle_annotation_channel(self, annotation_id: str, ch_name: str) -> None:
        if not self._check_editable():
            return
        try:
            ann = self.store.toggle_channel(annotation_id, ch_name)
        except AnnotationError as exc:
            self._say(str(exc))
            return
        self._say(
            f"{ann.label}: now applies to the whole montage"
            if ann.is_global
            else f"{ann.label}: channels {', '.join(ann.channels)}"
        )

    def select(self, annotation_id: str | None) -> None:
        if annotation_id is not None and annotation_id not in self.store:
            annotation_id = None
        self.selected_id = annotation_id
        for aid, region in self.regions.items():
            sel = aid == annotation_id
            if region.selected != sel:
                region.select(sel)
            region.setZValue(3 if sel else 1)
        self.selectionChanged.emit(annotation_id)

    def delete_selected(self) -> None:
        if not self._check_editable():
            return
        if self.selected_id is None:
            self._say("Select an annotation first (click it or choose it in the list)")
            return
        self.delete(self.selected_id)

    def delete(self, annotation_id: str) -> None:
        if not self._check_editable():
            return
        ann = self.store.get(annotation_id)
        self.store.delete(annotation_id)
        self.selected_id = None
        self.selectionChanged.emit(None)
        self._say(f"Deleted {ann.label} ({UNDO_HINT})")

    def relabel(self, annotation_id: str, label: str) -> None:
        if self._check_editable():
            self.store.set_label(annotation_id, label)

    def relabel_many(self, annotation_ids: list[str], label: str) -> None:
        if self._check_editable():
            self.store.set_label_many(annotation_ids, label)

    def set_annotation_channels(self, annotation_id: str, channels: list[str]) -> None:
        if self._check_editable():
            self.store.set_channels(annotation_id, channels)

    def undo(self) -> None:
        if not self._check_editable():
            return
        what = self.store.undo()
        self._say(f"Undid: {what}" if what else "Nothing to undo")

    def redo(self) -> None:
        if not self._check_editable():
            return
        what = self.store.redo()
        self._say(f"Redid: {what}" if what else "Nothing to redo")

    def show_context_menu(self, annotation_id: str, screen_pos: Any) -> None:
        if not self._check_editable():
            return
        ann = self.store.get(annotation_id)
        menu = QMenu(self.browser)
        menu.setAttribute(Qt.WA_DeleteOnClose)
        menu.addSection(f"{ann.label}")
        relabel = menu.addMenu("Change label to")
        relabel.setToolTipsVisible(True)
        add_label_menu(relabel, self.catalogue, ann.label, lambda lab: self.relabel(annotation_id, lab))
        menu.addAction("Edit channels…", lambda: self.requestChannelEdit(annotation_id))
        if not ann.is_global:
            menu.addAction("Apply to whole montage", lambda: self.set_annotation_channels(annotation_id, []))
        menu.addSeparator()
        menu.addAction("Delete", lambda: self.delete(annotation_id))
        menu.exec(screen_pos.toPoint() if hasattr(screen_pos, "toPoint") else screen_pos)

    # Hook replaced by the workspace (opens the channel dialog).
    def requestChannelEdit(self, annotation_id: str) -> None:  # noqa: N802
        self._say("Channel editing is not available")

    def set_display_prefix(self, prefix: dict[str, str]) -> None:
        """Label prefixes such as 'REF: ' (review mode); redraws existing regions."""
        self.display_prefix = dict(prefix)
        for aid in list(self.regions):
            self._remove_region(self.regions.pop(aid))
        self.sync_now()

    # ------------------------------------------------------------ navigation
    def jump_to(self, annotation_id: str) -> None:
        ann = self.store.get(annotation_id)
        timing = self.recording.timing
        p = self.browser.mne
        window = float(p.duration)
        start, stop = ann.onset(timing), ann.offset(timing)
        if stop - start > window:
            t0 = start
        else:
            t0 = start - (window - (stop - start)) / 2
        t0 = min(max(0.0, t0), max(0.0, p.xmax - window))
        p.plt.setXRange(t0, t0 + window, padding=0)
        if ann.channels:
            ordered = list(p.ch_names[p.ch_order])
            idx = [ordered.index(ch) for ch in ann.channels if ch in ordered]
            visible = range(int(p.ch_start), int(p.ch_start) + int(p.n_channels))
            if idx and not any(i in visible for i in idx):
                n = int(p.n_channels)
                top = min(max(0, min(idx) - 1), max(0, len(ordered) - n))
                p.plt.setYRange(top, top + n + 1, padding=0)
        self.select(annotation_id)

    # --------------------------------------------------------------- syncing
    def _on_store_change(self, change: StoreChange) -> None:
        self.schedule_sync()
        self.annotationsChanged.emit()

    def schedule_sync(self, force: bool = False) -> None:
        """Re-draw on the next event-loop turn (safe inside mouse handlers)."""
        if not self._sync_pending:
            self._sync_pending = True
            QTimer.singleShot(0, self.sync_now)

    def _region_matches(self, region: ArtifactRegion, ann: Any) -> bool:
        timing = self.recording.timing
        t0, t1 = region.getRegion()
        return (
            region.description == ann.label
            and abs(t0 - ann.onset(timing)) < 0.25 / timing.sfreq
            and abs(t1 - ann.offset(timing)) < 0.25 / timing.sfreq
            and tuple(sorted(region.single_channel_annots)) == tuple(sorted(ann.channels))
        )

    def sync_now(self) -> None:
        """Make the displayed regions match the store exactly."""
        self._sync_pending = False
        if not self._attached:
            return
        p = self.browser.mne
        anns = {a.annotation_id: a for a in self.store.annotations()}
        for aid in list(self.regions):
            if aid not in anns or not self._region_matches(self.regions[aid], anns[aid]):
                self._remove_region(self.regions.pop(aid))
        timing = self.recording.timing
        for aid, ann in anns.items():
            if aid not in self.regions:
                region = ArtifactRegion(
                    p,
                    annotation_id=aid,
                    label=ann.label,
                    values=(ann.onset(timing), ann.offset(timing)),
                    channels=ann.channels,
                    weakmain=weakref.ref(self.browser),
                    controller=self,
                )
                region.setMovable(self.drawing_enabled)
                prefix = self.display_prefix.get(aid, "")
                if prefix:
                    region.label_item.setText(f"{prefix}{ann.label}{' [ch]' if ann.channels else ''}")
                p.regions.append(region)
                p.viewbox.sigYRangeChanged.connect(region.update_label_pos)
                self.regions[aid] = region
        self._assign_label_rows(list(anns.values()))
        if self.selected_id not in anns:
            self.selected_id = None
        for aid, region in self.regions.items():
            sel = aid == self.selected_id
            if region.selected != sel:
                region.select(sel)
            region.setZValue(3 if sel else 1)
            region.update_label_pos()
        # Keep MNE's annotations (shown in the overview bar) in step with the store.
        raw = p.inst
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            raw.set_annotations(
                to_mne_annotations(anns.values(), self.recording, self.catalogue, for_raw=raw), verbose="error"
            )
        p.overview_bar.update_annotations()
        self.browser._update_regions_visible()
        self.annotationsChanged.emit()

    def _assign_label_rows(self, anns: list[Any] | None = None) -> None:
        """Stagger labels of nearby annotations so they stay readable.

        Each label is treated as occupying the wider of its interval and its
        on-screen text width, so rows depend on the current zoom level.
        """
        if anns is None:
            anns = self.store.annotations()
        p = self.browser.mne
        timing = self.recording.timing
        try:
            x0, x1 = p.viewbox.viewRange()[0]
            px = max(1.0, float(p.viewbox.width()))
            s_per_px = max(1e-9, (x1 - x0) / px)
        except Exception:  # pragma: no cover - before the view exists
            s_per_px = 0.01
        rows_end: list[float] = []
        for ann in sorted(anns, key=lambda a: (a.onset_sample, a.annotation_id)):
            mid = (ann.onset(timing) + ann.offset(timing)) / 2
            region = self.regions.get(ann.annotation_id)
            text_px = region.label_text_size()[0] if region is not None else (len(ann.label) + 5) * 8.0
            half = max(ann.duration(timing), text_px * s_per_px) / 2
            start, end = mid - half, mid + half
            for row, row_end in enumerate(rows_end):
                if start >= row_end:
                    rows_end[row] = end
                    break
            else:
                row = len(rows_end)
                rows_end.append(end)
            if region is not None:
                region.label_row = row % 8
                region.update_label_pos()

    def relayout_labels(self, *args: Any) -> None:
        if self._attached:
            self._assign_label_rows()
            self._thin_event_labels()

    def _thin_event_labels(self) -> None:
        """Hide event labels that would overlap the previous one (the lines stay; hover shows the text).

        Dense experimental events (for example stimulus and key press 0.4 s apart) would otherwise print
        their labels on top of each other at the bottom of the plot.
        """
        p = self.browser.mne
        lines = list(getattr(p, "event_lines", []) or [])
        if not lines:
            return
        try:
            x0, x1 = p.viewbox.viewRange()[0]
            px_per_s = max(1e-9, float(p.viewbox.width())) / max(1e-9, x1 - x0)
        except Exception:  # pragma: no cover - before the view exists
            return
        last_end = -1e18
        for line in sorted(lines, key=lambda ln: float(ln.value())):
            label = getattr(line, "label", None)
            if label is None:
                continue
            start = float(line.value() - x0) * px_per_s
            width = float(label.boundingRect().width())
            fits = bool(start >= last_end + 4)
            label.setVisible(fits)
            if fits:
                last_end = start + width
            line.setToolTip(label.toPlainText())

    def _remove_region(self, region: ArtifactRegion) -> None:
        p = self.browser.mne
        with contextlib.suppress(TypeError, RuntimeError):
            p.viewbox.sigYRangeChanged.disconnect(region.update_label_pos)
        # MNE's SingleChannelAnnot.remove() only takes the item off the view box and leaves it in
        # PlotItem.items; remove it properly so that rebuilt regions do not accumulate dead items.
        for item in list(region.single_channel_annots.values()):
            if item in p.plt.items:
                p.plt.removeItem(item)
        region.single_channel_annots.clear()
        if region.label_item in p.plt.items:
            p.plt.removeItem(region.label_item)
        if region in p.plt.items:
            p.plt.removeItem(region)
        if region in p.regions:
            p.regions.remove(region)

    # ---------------------------------------------------------- filter zones
    def set_transient_zones(self, zones: list[tuple[float, float]], visible: bool = True) -> None:
        p = self.browser.mne
        for item in self._zone_items:
            p.plt.removeItem(item)
        self._zone_items = []
        for a, b in zones:
            item = pg.LinearRegionItem(values=(a, b), movable=False, brush=QBrush(QColor(120, 120, 120, 40), Qt.BDiagPattern))
            for line in item.lines:
                line.setPen(pg.mkPen(None))
            item.setZValue(-5)
            item.setToolTip("Filter edge zone: the display filters may distort the signal here")
            item.setVisible(visible)
            p.plt.addItem(item, ignoreBounds=True)
            self._zone_items.append(item)

    def set_transient_zones_visible(self, visible: bool) -> None:
        for item in self._zone_items:
            item.setVisible(visible)

    def set_gap_zones(self, zones: list[tuple[float, float]]) -> None:
        """Mark stretches without recorded data (BAD_ACQ_SKIP in the file); always visible."""
        p = self.browser.mne
        for item in self._gap_items:
            p.plt.removeItem(item)
        self._gap_items = []
        for a, b in zones:
            item = pg.LinearRegionItem(values=(a, b), movable=False, brush=QBrush(QColor(90, 90, 90, 70), Qt.DiagCrossPattern))
            for line in item.lines:
                line.setPen(pg.mkPen(None))
            item.setZValue(-4)
            item.setToolTip("No recorded data here: the file marks this stretch as BAD_ACQ_SKIP")
            p.plt.addItem(item, ignoreBounds=True)
            self._gap_items.append(item)
