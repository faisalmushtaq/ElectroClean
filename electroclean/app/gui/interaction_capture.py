"""Records what the annotator does into the visit's interaction log (research data).

:class:`InteractionRecorder` is created by the application controller when a visit starts (if
the study's ``logging.interactions`` setting is on) and closed when the visit ends. It watches

* every mouse press, release, double-click and wheel turn, every key press and every shortcut,
  through one event filter installed on the application (a long-lived object owned by the
  recorder, removed when the visit ends);
* the open annotation window: the visible part of the recording (after it has settled), the
  annotation store, the controller's state, the selection and the messages in the status bar;
* dialogs being shown and closed, windows and the application becoming active or inactive, and
  idle periods without any input.

What is never recorded: characters typed into text fields (only that a field was edited and, for
number boxes, the value), anything typed into password fields, and the display name.

Every event is described in docs/activity_logs.md.
"""

from __future__ import annotations

import atexit
import contextlib
import math
import time
import weakref
from typing import Any

from qtpy.QtCore import QEvent, QObject, Qt, QTimer
from qtpy.QtGui import QGuiApplication, QKeySequence
from qtpy.QtWidgets import (
    QAbstractButton,
    QAbstractItemView,
    QAbstractSpinBox,
    QApplication,
    QComboBox,
    QDialog,
    QInputDialog,
    QLineEdit,
    QMenu,
    QMessageBox,
    QPlainTextEdit,
    QTextEdit,
    QToolButton,
    QWidget,
)

from electroclean.app.session.interaction_log import InteractionLog

_MOUSE = {
    QEvent.MouseButtonPress: "mouse_press",
    QEvent.MouseButtonRelease: "mouse_release",
    QEvent.MouseButtonDblClick: "double_click",
}
_BUTTONS = {Qt.LeftButton: "left", Qt.RightButton: "right", Qt.MiddleButton: "middle"}
_MODIFIERS = ((Qt.ShiftModifier, "Shift"), (Qt.ControlModifier, "Ctrl"), (Qt.AltModifier, "Alt"),
              (Qt.MetaModifier, "Meta"), (Qt.KeypadModifier, "Keypad"))
#: How long after an input a change to the annotations is attributed to it.
CAUSE_WINDOW_S = 3.0
#: How long the view must stay still before it is logged.
VIEW_SETTLE_MS = 250

_current: weakref.ReferenceType[InteractionRecorder] | None = None


def current_recorder() -> InteractionRecorder | None:
    return _current() if _current is not None else None


def log_exception(text: str) -> None:
    """Called by the application's exception hook: the error goes into the open visit's log too."""
    rec = current_recorder()
    if rec is not None:
        rec.log.event("error", details=text[-4000:])


@atexit.register
def _close_at_exit() -> None:
    rec = current_recorder()
    if rec is not None:
        with contextlib.suppress(Exception):
            rec.close("exit")


_MODIFIER_KEYS = {Qt.Key_Shift, Qt.Key_Control, Qt.Key_Alt, Qt.Key_Meta, Qt.Key_AltGr, Qt.Key_CapsLock}


def _num(value: Any) -> int:
    """A Qt enum (or flag) as a number, whichever binding is in use."""
    try:
        return int(value)
    except TypeError:
        return int(getattr(value, "value", 0))


def _modifiers(mods: Any) -> list[str]:
    return [name for flag, name in _MODIFIERS if mods & flag]


def _is_text_input(w: QObject) -> bool:
    return isinstance(w, (QLineEdit, QTextEdit, QPlainTextEdit))


def _is_secret(w: QObject) -> bool:
    if isinstance(w, QLineEdit) and w.echoMode() != QLineEdit.Normal:
        return True
    parent = w.parent() if isinstance(w, QObject) else None
    while parent is not None:  # a line edit inside a password input dialog
        if isinstance(parent, QInputDialog) and parent.textEchoMode() != QLineEdit.Normal:
            return True
        parent = parent.parent()
    return False


class InteractionRecorder(QObject):
    """Feeds one visit's :class:`InteractionLog` from the application's input and the open window."""

    def __init__(self, log: InteractionLog, *, pointer_hz: float = 5.0, idle_after_s: float = 30.0,
                 parent: QObject | None = None) -> None:
        super().__init__(parent)
        global _current
        self.log = log
        self.pointer_interval = 1.0 / pointer_hz if pointer_hz > 0 else None
        self.idle_after_s = float(idle_after_s)
        self._closed = False
        self._last_input = time.monotonic()
        self._idle_since: float | None = None
        self._last_mouse_key: tuple[Any, ...] | None = None
        self._last_key_key: tuple[Any, ...] | None = None
        self._cause: tuple[float, str] = (0.0, "")
        self._press_pos: Any = None
        self._edited: dict[int, tuple[weakref.ReferenceType[QWidget], dict[str, Any]]] = {}
        self._dialogs: dict[int, str] = {}
        # Open annotation window.
        self._ws: Any = None
        self._viewport: QWidget | None = None
        self._overview: QWidget | None = None
        self._window_no = 0
        self._last_view: dict[str, Any] | None = None
        self._last_state: dict[str, Any] = {}
        self._known: dict[str, dict[str, Any]] = {}
        self._last_pointer_t = 0.0
        self._last_pointer_pos: Any = None
        self._pointer_dist = 0.0
        self._last_sample_pos: Any = None
        self._view_timer = QTimer(self)
        self._view_timer.setSingleShot(True)
        self._view_timer.setInterval(VIEW_SETTLE_MS)
        self._view_timer.timeout.connect(self._log_view)
        self._idle_timer = QTimer(self)
        self._idle_timer.setInterval(1000)
        self._idle_timer.timeout.connect(self.check_idle)
        app = QApplication.instance()
        if app is not None:
            app.installEventFilter(self)
            with contextlib.suppress(AttributeError, TypeError):
                app.applicationStateChanged.connect(self._app_state)
        self._idle_timer.start()
        _current = weakref.ref(self)

    # -------------------------------------------------------------- closing
    def close(self, reason: str = "") -> None:
        """Stop recording and close the log (safe to call twice)."""
        global _current
        if self._closed:
            return
        self._closed = True
        app = QApplication.instance()
        if app is not None:
            app.removeEventFilter(self)
            with contextlib.suppress(RuntimeError, TypeError):
                app.applicationStateChanged.disconnect(self._app_state)
        self._idle_timer.stop()
        self._view_timer.stop()
        for key in list(self._edited):  # fields edited but never left
            with contextlib.suppress(Exception):
                self._field_done(key)
        self.detach_workspace()
        if self._idle_since is not None:
            self.log.event("idle_end", idle_s=round(time.monotonic() - self._idle_since, 3))
            self._idle_since = None
        self.log.close(reason=reason)
        if current_recorder() is self:
            _current = None

    # ---------------------------------------------------------- the window
    def attach_workspace(self, ws: Any, *, resumed: bool = False, restored: int = 0) -> None:
        """Follow an annotation window: its view, annotations, state and status messages."""
        self.detach_workspace()
        self._ws = ws
        self._window_no += 1
        session, loaded = ws.session, ws.loaded
        rid = loaded.info.recording_id
        self.log.context.update(recording=rid, window_no=self._window_no)
        p = ws.browser.mne
        self._viewport = p.view.viewport()
        self._overview = getattr(p, "overview_bar", None)
        self._known = {a.annotation_id: self._summary(a) for a in session.store.annotations()}
        t = loaded.timing
        self.log.event(
            "recording_opened", session_id=session.session_id, mode=session.mode,
            duration_s=round(float(t.duration_s), 4), sfreq=float(t.sfreq), n_samples=int(t.n_samples),
            n_channels_shown=len(loaded.info.ch_names), n_channels_hidden=len(loaded.info.hidden_channels),
            format=getattr(loaded.files, "format_name", ""), filters=session.filters.describe(),
            filter_settings=session.filters.to_dict(), original_events=len(loaded.original_events),
            resumed=bool(resumed), annotations_restored=int(restored),
            window_px=[ws.browser.width(), ws.browser.height()],
        )
        ctrl = ws.controller
        ctrl.stateChanged.connect(self._state)
        ctrl.selectionChanged.connect(self._selection)
        session.store.add_listener(self._store_change)
        ws.browser.statusBar().messageChanged.connect(self._status)
        p.plt.sigXRangeChanged.connect(self._view_changed)
        p.plt.sigYRangeChanged.connect(self._view_changed)
        ws.browser.destroyed.connect(lambda *_: self._forget_workspace())
        self._last_state = {}
        self._state()
        self._view_changed()

    def detach_workspace(self) -> None:
        ws, self._ws = self._ws, None
        if ws is None:
            return
        self._view_timer.stop()
        with contextlib.suppress(RuntimeError, TypeError, AttributeError):
            ws.controller.stateChanged.disconnect(self._state)
            ws.controller.selectionChanged.disconnect(self._selection)
        with contextlib.suppress(Exception):
            ws.session.store.remove_listener(self._store_change)
        with contextlib.suppress(RuntimeError, TypeError, AttributeError):
            ws.browser.statusBar().messageChanged.disconnect(self._status)
        with contextlib.suppress(RuntimeError, TypeError, AttributeError):
            ws.browser.mne.plt.sigXRangeChanged.disconnect(self._view_changed)
            ws.browser.mne.plt.sigYRangeChanged.disconnect(self._view_changed)
        self._forget_workspace()

    def _forget_workspace(self) -> None:
        self._ws = None
        self._viewport = None
        self._overview = None
        self._last_view = None
        self.log.context.pop("recording", None)
        self.log.context.pop("window_no", None)

    # ---------------------------------------------------- window listeners
    def _summary(self, ann: Any) -> dict[str, Any]:
        timing = self._ws.session.store.recording.timing if self._ws is not None else None
        out = {"id": ann.annotation_id, "label": ann.label, "channels": list(ann.channels),
               "n_channels": len(ann.channels)}
        if timing is not None:
            out["onset_s"] = round(ann.onset(timing), 4)
            out["offset_s"] = round(ann.offset(timing), 4)
        return out

    def _via(self) -> str:
        t, what = self._cause
        return what if what and time.monotonic() - t <= CAUSE_WINDOW_S else "unknown"

    def _store_change(self, change: Any) -> None:
        if self._ws is None:
            return
        try:
            store = self._ws.session.store
            current = {a.annotation_id: a for a in store.annotations()}
            via = self._via()
            action = change.action
            if action in ("add", "update", "delete") and change.annotation_ids:
                before = {i: self._known.get(i) for i in change.annotation_ids}
                after = {i: self._summary(current[i]) for i in change.annotation_ids if i in current}
                if action == "add":
                    kind = "annotation_created"
                elif action == "delete":
                    kind = "annotation_deleted"
                elif change.description.startswith("relabel"):
                    kind = "annotation_relabelled"
                elif "channel" in change.description:
                    kind = "annotation_channels_changed"
                else:
                    kind = "annotation_edited"
                items = [after.get(i) or before.get(i) for i in change.annotation_ids]
                fields: dict[str, Any] = {"annotations": [x for x in items if x]}
                if kind in ("annotation_relabelled", "annotation_edited", "annotation_channels_changed"):
                    fields["before"] = [x for x in before.values() if x]
                if action == "add" and store.last_auto_merged:
                    fields["auto_merged"] = int(store.last_auto_merged)
                    gone = [v for k, v in self._known.items() if k not in current]
                    fields["merged_away"] = gone
                self.log.event(kind, action=action, description=change.description, via=via, n_total=len(current),
                               **fields)
            else:
                # Undo, redo, merge and reset: report the difference from what was known.
                added = [self._summary(a) for i, a in current.items() if i not in self._known]
                removed = [v for i, v in self._known.items() if i not in current]
                changed = [self._summary(a) for i, a in current.items()
                           if i in self._known and self._summary(a) != self._known[i]]
                kind = {"undo": "undo", "redo": "redo", "merge": "annotations_merged"}.get(action, "annotations_reset")
                self.log.event(kind, action=action, description=change.description, via=via, n_total=len(current),
                               added=added, removed=removed, changed=changed)
            self._known = {i: self._summary(a) for i, a in current.items()}
        except Exception as exc:  # noqa: BLE001 - logging never interrupts annotation
            self.log.event("log_problem", where="store_change", error=str(exc))

    def _state(self, *_args: Any) -> None:
        if self._ws is None:
            return
        c = self._ws.controller
        state = {
            "current_label": c.current_label,
            "scope": c.scope,
            "selected_channels": list(c.selected_channels),
            "drawing_enabled": bool(c.drawing_enabled),
            "mark_start_s": None if c.mark_start is None else round(float(c.mark_start), 4),
        }
        changed = {k: v for k, v in state.items() if self._last_state.get(k, object()) != v}
        if changed:
            self.log.event("state", via=self._via(), **changed)
            self._last_state = state

    def _selection(self, annotation_id: Any) -> None:
        if self._ws is None:
            return
        label = None
        with contextlib.suppress(Exception):
            if annotation_id is not None:
                label = self._ws.session.store.get(annotation_id).label
        self.log.event("selection", annotation_id=annotation_id, label=label, via=self._via())

    def _status(self, text: str) -> None:
        if text:
            self.log.event("status_message", text=text)

    def _view_changed(self, *_args: Any) -> None:
        if self._ws is not None and not self._closed:
            self._view_timer.start()

    def view_snapshot(self) -> dict[str, Any] | None:
        if self._ws is None:
            return None
        p = self._ws.browser.mne
        try:
            ordered = list(p.ch_names[p.ch_order])
            first = int(p.ch_start)
            n = int(p.n_channels)
            last = min(first + n, len(ordered)) - 1
            return {
                "t_start": round(float(p.t_start), 4),
                "duration": round(float(p.duration), 4),
                "ch_start": first,
                "n_channels": n,
                "first_channel": ordered[first] if 0 <= first < len(ordered) else None,
                "last_channel": ordered[last] if 0 <= last < len(ordered) else None,
                "scale_factor": round(float(p.scale_factor), 6),
                "butterfly": bool(getattr(p, "butterfly", False)),
            }
        except Exception:  # noqa: BLE001
            return None

    def _log_view(self) -> None:
        snap = self.view_snapshot()
        if snap is not None and snap != self._last_view:
            self.log.event("view", **snap)
            self._last_view = snap

    # --------------------------------------------------------- application
    def _app_state(self, state: Any) -> None:
        names = {Qt.ApplicationActive: "active", Qt.ApplicationInactive: "inactive",
                 Qt.ApplicationHidden: "hidden", Qt.ApplicationSuspended: "suspended"}
        self.log.event("app_state", state=names.get(state, str(state)))

    def _input(self) -> None:
        now = time.monotonic()
        if self._idle_since is not None:
            self.log.event("idle_end", idle_s=round(now - self._idle_since, 3))
            self._idle_since = None
        self._last_input = now

    def check_idle(self, now: float | None = None) -> None:
        """Log the start of an idle period once ``idle_after_s`` have passed without input."""
        now = time.monotonic() if now is None else now
        if self._idle_since is None and now - self._last_input >= self.idle_after_s:
            self._idle_since = now
            self.log.event("idle_start", last_input_t=round(self.log.elapsed() - (now - self._last_input), 4),
                           after_s=self.idle_after_s)

    # ------------------------------------------------------------ the filter
    def eventFilter(self, obj: QObject, event: QEvent) -> bool:  # noqa: N802 (Qt naming)
        try:
            et = event.type()
            if et == QEvent.MouseMove:
                self._input()
                if obj is self._viewport and self.pointer_interval is not None:
                    self._pointer(event)
            elif et in _MOUSE:
                if isinstance(obj, QWidget):
                    self._mouse(obj, event, _MOUSE[et])
            elif et == QEvent.Wheel:
                if isinstance(obj, QWidget):
                    self._wheel(obj, event)
            elif et == QEvent.KeyPress:
                if isinstance(obj, QWidget):
                    self._key(obj, event)
            elif et == QEvent.Shortcut:
                self._shortcut(obj, event)
            elif et == QEvent.Show:
                if isinstance(obj, QDialog):
                    self._dialog_shown(obj)
            elif et == QEvent.Hide:
                if id(obj) in self._edited:
                    self._field_done(obj)
                if isinstance(obj, QDialog) and id(obj) in self._dialogs:
                    self._dialog_closed(obj)
            elif et == QEvent.FocusOut:
                if id(obj) in self._edited:
                    self._field_done(obj)
            elif et in (QEvent.WindowActivate, QEvent.WindowDeactivate):
                if isinstance(obj, QWidget) and obj.isWindow():
                    kind = "window_activated" if et == QEvent.WindowActivate else "window_deactivated"
                    self.log.event(kind, top_window=type(obj).__name__, title=obj.windowTitle())
        except Exception as exc:  # noqa: BLE001 - never interfere with the application
            with contextlib.suppress(Exception):
                self.log.event("log_problem", where="event_filter", error=str(exc))
        return False

    # ----------------------------------------------------------- describing
    def _widget(self, w: QWidget, pos: Any = None) -> dict[str, Any]:
        d: dict[str, Any] = {"widget": type(w).__name__}
        name = w.objectName()
        if name and not name.startswith("qt_"):
            d["name"] = name
        if isinstance(w, QToolButton) and w.defaultAction() is not None:
            d["text"] = w.defaultAction().text()
        elif isinstance(w, QAbstractButton):
            d["text"] = w.text().strip()
        elif isinstance(w, QComboBox) and not w.isEditable():
            d["text"] = w.currentText()
        elif isinstance(w, QMenu) and pos is not None:
            act = w.actionAt(pos)
            if act is not None:
                d["text"] = act.text()
        parent = w.parentWidget()
        if isinstance(parent, QAbstractItemView) and pos is not None:
            index = parent.indexAt(pos)
            d["widget"] = type(parent).__name__
            if parent.objectName():
                d["name"] = parent.objectName()
            if index.isValid():
                d["row"] = index.row()
                d["column"] = index.column()
                value = index.data()
                if isinstance(value, str) and not _is_secret(parent):
                    d["item"] = value[:200]
        win = w.window()
        if win is not None and win is not w:
            d["top_window"] = type(win).__name__
        if pos is not None and win is not None:
            with contextlib.suppress(Exception):
                wp = w.mapTo(win, pos)
                d["x"], d["y"] = int(wp.x()), int(wp.y())
        return d

    def _eeg_point(self, pos: Any) -> dict[str, Any]:
        """Time and channel under a point of the EEG view (empty when it is outside the traces)."""
        ws = self._ws
        if ws is None:
            return {}
        p = ws.browser.mne
        try:
            scene = p.view.mapToScene(pos)
            vb = p.viewbox
            pt = vb.mapSceneToView(scene)
            rect = vb.sceneBoundingRect()
            out: dict[str, Any] = {}
            inside_y = rect.top() <= scene.y() <= rect.bottom()
            if rect.contains(scene):
                out["eeg_t"] = round(float(pt.x()), 4)
                out["area"] = "eeg"
            elif inside_y and scene.x() < rect.left():
                out["area"] = "channel_names"
            else:
                out["area"] = "axes"
            if inside_y and p.traces:
                y = float(pt.y())
                tr = min(p.traces, key=lambda tr: abs((tr.ypos or 0) - y))
                if tr.ypos is not None and abs(tr.ypos - y) <= 0.5:
                    out["eeg_channel"] = tr.ch_name
            return out
        except Exception:  # noqa: BLE001
            return {}

    def _is_overview(self, w: QWidget) -> bool:
        ov = self._overview
        return ov is not None and (w is ov or (hasattr(ov, "viewport") and w is ov.viewport()))

    def _overview_point(self, pos: Any) -> dict[str, Any]:
        ws = self._ws
        try:
            xmax = float(ws.browser.mne.xmax)
            return {"area": "overview", "overview_t": round(xmax * pos.x() / max(1, self._overview.width()), 3)}
        except Exception:  # noqa: BLE001
            return {}

    # --------------------------------------------------------------- inputs
    def _mouse(self, w: QWidget, ev: Any, kind: str) -> None:
        gp = ev.globalPosition() if hasattr(ev, "globalPosition") else ev.globalPos()
        key = (kind, ev.timestamp(), _num(ev.button()), round(gp.x()), round(gp.y()))
        if key == self._last_mouse_key:  # the same event passed on to a parent widget
            return
        self._last_mouse_key = key
        self._input()
        pos = ev.position().toPoint() if hasattr(ev, "position") else ev.pos()
        fields = self._widget(w, pos)
        fields["button"] = _BUTTONS.get(ev.button(), str(_num(ev.button())))
        mods = _modifiers(ev.modifiers())
        if mods:
            fields["modifiers"] = mods
        if w is self._viewport:
            fields.update(self._eeg_point(pos))
            if kind == "mouse_press":
                self._press_pos = pos  # within the view (simulated events may lack a global position)
                self._cause = (time.monotonic(), "eeg_mouse")
            elif kind == "mouse_release" and self._press_pos is not None:
                moved = math.hypot(pos.x() - self._press_pos.x(), pos.y() - self._press_pos.y())
                fields["drag_px"] = round(moved, 1)
                self._cause = (time.monotonic(), "eeg_drag" if moved > 3 else "eeg_click")
                self._press_pos = None
            elif kind == "double_click":
                self._cause = (time.monotonic(), "eeg_double_click")
        elif self._is_overview(w):
            fields.update(self._overview_point(pos))
        elif kind == "mouse_release" and "text" in fields:
            self._cause = (time.monotonic(), f"{'menu' if isinstance(w, QMenu) else 'button'}:{fields['text']}")
        elif kind == "mouse_press" and "row" in fields:
            self._cause = (time.monotonic(), f"list:{fields.get('name') or fields['widget']}")
        self.log.event(kind, **fields)

    def _wheel(self, w: QWidget, ev: Any) -> None:
        delta = ev.angleDelta()
        key = ("wheel", ev.timestamp(), delta.x(), delta.y())
        if key == self._last_mouse_key:
            return
        self._last_mouse_key = key
        self._input()
        pos = ev.position().toPoint() if hasattr(ev, "position") else ev.pos()
        fields = {"widget": type(w).__name__, "dx": int(delta.x()), "dy": int(delta.y())}
        mods = _modifiers(ev.modifiers())
        if mods:
            fields["modifiers"] = mods
        if w is self._viewport:
            fields.update(self._eeg_point(pos))
            self._view_changed()
        self.log.event("wheel", **fields)

    def _key(self, w: QWidget, ev: Any) -> None:
        if ev.key() in _MODIFIER_KEYS:
            return  # Shift, Ctrl and so on on their own: recorded with the key they modify
        key = ("key", ev.timestamp(), ev.key(), ev.isAutoRepeat())
        if key == self._last_key_key:
            return
        self._last_key_key = key
        self._input()
        if _is_secret(w):
            return  # nothing at all from password fields
        if _is_text_input(w) or isinstance(w, QAbstractSpinBox):
            # Characters typed into text fields are never recorded; only that the field was edited.
            if id(w) not in self._edited:
                info = {"widget": type(w).__name__}
                if w.objectName() and not w.objectName().startswith("qt_"):
                    info["name"] = w.objectName()
                if isinstance(w, QLineEdit) and w.placeholderText():
                    info["placeholder"] = w.placeholderText()
                win = w.window()
                if win is not None:
                    info["top_window"] = type(win).__name__
                    info["title"] = win.windowTitle()
                self._edited[id(w)] = (weakref.ref(w), info)
            return
        name = QKeySequence(ev.key()).toString() or str(ev.key())
        fields: dict[str, Any] = {"key": name, "widget": type(w).__name__}
        mods = _modifiers(ev.modifiers())
        if mods:
            fields["modifiers"] = mods
        if ev.isAutoRepeat():
            fields["auto_repeat"] = True
        self._cause = (time.monotonic(), f"key:{name}")
        self.log.event("key", **fields)
        if self._ws is not None:
            self._view_changed()  # MNE's keys scroll, zoom and scale

    def _shortcut(self, obj: QObject, ev: Any) -> None:
        self._input()
        try:
            seq = ev.key().toString()
        except Exception:  # noqa: BLE001
            seq = ""
        text = obj.text() if hasattr(obj, "text") else type(obj).__name__
        self._cause = (time.monotonic(), f"shortcut:{text}")
        self.log.event("shortcut", key=seq, action=text)

    def _field_done(self, w: QObject | int) -> None:
        ref, info = self._edited.pop(w if isinstance(w, int) else id(w))
        live = ref()
        if live is not None and isinstance(live, QAbstractSpinBox):
            with contextlib.suppress(Exception):
                info["value"] = live.value()
        self.log.event("field_edited", **info)

    def _pointer(self, ev: Any) -> None:
        pos = ev.position().toPoint() if hasattr(ev, "position") else ev.pos()
        if self._last_pointer_pos is not None:
            self._pointer_dist += math.hypot(pos.x() - self._last_pointer_pos.x(), pos.y() - self._last_pointer_pos.y())
        self._last_pointer_pos = pos
        now = time.monotonic()
        if now - self._last_pointer_t < self.pointer_interval:
            return
        if self._last_sample_pos is not None and pos == self._last_sample_pos:
            return
        self._last_pointer_t = now
        self._last_sample_pos = pos
        fields = self._eeg_point(pos)
        fields["dist_px"] = round(self._pointer_dist, 1)
        self._pointer_dist = 0.0
        self.log.event("pointer", **fields)

    # -------------------------------------------------------------- dialogs
    def _dialog_shown(self, dlg: QDialog) -> None:
        if id(dlg) in self._dialogs:
            return
        title = dlg.windowTitle()
        self._dialogs[id(dlg)] = title
        fields: dict[str, Any] = {"dialog": type(dlg).__name__, "title": title}
        if isinstance(dlg, QMessageBox):
            fields["text"] = dlg.text()[:1000]
            if dlg.informativeText():
                fields["informative"] = dlg.informativeText()[:1000]
            fields["buttons"] = [b.text() for b in dlg.buttons()]
        self.log.event("dialog_shown", **fields)

    def _dialog_closed(self, dlg: QDialog) -> None:
        title = self._dialogs.pop(id(dlg), dlg.windowTitle())
        fields: dict[str, Any] = {"dialog": type(dlg).__name__, "title": title}
        with contextlib.suppress(Exception):
            fields["accepted"] = dlg.result() == QDialog.Accepted
        if isinstance(dlg, QMessageBox):
            btn = dlg.clickedButton()
            if btn is not None:
                fields["button"] = btn.text()
                fields["accepted"] = True
        chosen = getattr(dlg, "chosen", None)  # the type picker
        if isinstance(chosen, str):
            fields["chosen"] = chosen
        if hasattr(dlg, "result_channels") and fields.get("accepted"):
            with contextlib.suppress(Exception):
                fields["channels"] = list(dlg.result_channels())
        self._cause = (time.monotonic(), f"dialog:{title}")
        self.log.event("dialog_closed", **fields)


def visit_header(ctrl: Any, request: Any) -> dict[str, Any]:
    """The first line of a visit's log: who, what, where, with which software and screens.

    The annotator's display name is not included (the ID identifies them within the study)."""
    import hashlib
    import json
    import platform
    import uuid

    import mne
    from qtpy import API_NAME, QT_VERSION

    from electroclean import __version__

    s = ctrl.settings
    rs = ctrl.reference_set
    try:
        import mne_qt_browser

        browser_version = mne_qt_browser.__version__
    except Exception:  # noqa: BLE001
        browser_version = ""
    return {
        "visit_id": uuid.uuid4().hex,
        "annotator_id": request.annotator_id,
        "mode": request.mode,
        "context_id": ctrl._context_id(),
        "reference_set": rs.set_id if rs is not None else "",
        "assessment_kind": getattr(request, "assessment_kind", "") if request.mode != "standard" else "",
        "programme": bool(getattr(request, "programme", False)),  # the training programme (guided training)
        "dataset_root": str(request.dataset_root),
        "output_root": str(ctrl.layout.root),
        "study_id": getattr(ctrl.study, "study_id", "") if ctrl.study is not None else "",
        "versions": {"electroclean": __version__, "mne": mne.__version__, "mne_qt_browser": browser_version,
                     "qt_api": API_NAME, "qt": QT_VERSION, "python": platform.python_version()},
        "os": platform.platform(),
        "screens": screens_info(),
        "settings_sha256": hashlib.sha256(json.dumps(s.raw, sort_keys=True, default=str).encode()).hexdigest(),
        "filters": s.filters.to_dict(),
        "logging": {"pointer_hz": s.logging_pointer_hz, "idle_after_s": s.logging_idle_after_s},
    }


def screens_info() -> list[dict[str, Any]]:
    """Geometry, available area, pixel ratio and dots per inch of every screen (for the log's header)."""
    out = []
    app = QGuiApplication.instance()
    if app is None:
        return out
    for s in QGuiApplication.screens():
        g, a = s.geometry(), s.availableGeometry()
        out.append({"name": s.name(), "geometry": [g.x(), g.y(), g.width(), g.height()],
                    "available": [a.x(), a.y(), a.width(), a.height()],
                    "device_pixel_ratio": float(s.devicePixelRatio()), "dpi": round(float(s.logicalDotsPerInch()), 1)})
    return out
