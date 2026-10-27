"""The training programme on screen: the training path, the Stage 1 coach and the Stage 2 review flags.

* :class:`TrainingPathWindow` shows the three stages as cards (locked, ready, in progress,
  completed), with stars, scores and times, and one Continue button for the next step.
* :class:`GuidedCoach` turns the annotation window into Stage 1: a coach panel gives one expert
  annotation at a time, checks every change at once (:mod:`electroclean.training.guided`) and lets
  the trainee continue only when it matches.
* :func:`add_review_flags` marks, in the Stage 2 review, the artifacts missed, the extra ones and
  those given another type, with a list to step through them.

Every step is recorded through the visit's interaction log (``ctrl.log`` / ``ws.log``).
"""

from __future__ import annotations

import html
import time
from typing import TYPE_CHECKING, Any

from qtpy.QtCore import QObject, Qt, QTimer
from qtpy.QtGui import QAction, QBrush, QColor, QKeySequence
from qtpy.QtWidgets import (
    QDockWidget,
    QGraphicsRectItem,
    QHBoxLayout,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from electroclean.app.gui import style
from electroclean.app.gui.help_text import UNDO_HINT
from electroclean.training.guided import (
    STARS_FIRST,
    Check,
    Step,
    Tolerance,
    article,
    build_steps,
    check_step,
    describe_target,
    extras,
    list_words,
    overlaps,
    stars_for,
)
from electroclean.training.programme import (
    STAGE_TITLES,
    NextStep,
    PassRule,
    StageState,
    load_progress,
    next_step,
    programme_state,
)

if TYPE_CHECKING:  # pragma: no cover
    from electroclean.app.gui.app_controller import AppController

FIND_WINDOW_S = 10.0


def star_text(stars: int, max_stars: int) -> str:
    """Stars as glyphs (★★☆) for a few, or one star and the numbers for many."""
    if max_stars <= 9:
        return "★" * stars + "☆" * max(max_stars - stars, 0)
    return "★"


def minutes_text(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    if seconds < 60:
        return f"{seconds} s"
    return f"{seconds // 60} min {seconds % 60:02d} s"


# ======================================================================= Stage 1
class GuidedCoach(QObject):
    """Stage 1 in an annotation window: one expert annotation at a time, checked as the trainee works."""

    def __init__(self, ctrl: Any, ws: Any, rs: Any, recording_id: str) -> None:
        super().__init__(ws.browser)
        self.ctrl = ctrl
        self.ws = ws
        self.rs = rs
        self.recording_id = recording_id
        self.log = ws.log
        self.store = ws.session.store
        self.sfreq = float(ws.loaded.timing.sfreq)
        self.catalogue = ws.session.catalogue
        reference = rs.reference_document(recording_id)
        self.steps: list[Step] = build_steps(reference, dict(rs.guided.get("notes", {})))
        self.tol = Tolerance.from_dict(rs.guided.get("tolerance"))
        self.guidance = rs.guidance_for(recording_id)
        order = rs.guided_recordings
        self.position = (order.index(recording_id) + 1 if recording_id in order else 1, max(len(order), 1))
        self.quick_keys = {name: i for i, name in enumerate(getattr(ws, "quick_labels", []), start=1)}
        self.index = 0
        self.matched: dict[int, str] = {}
        self.failed: dict[int, int] = {}
        self.shown: set[int] = set()
        self.stars: dict[int, int] = {}
        self.seconds: dict[int, float] = {}
        self._step_t0 = time.monotonic()
        self._signature: tuple[Any, ...] | None = None
        self.last_check: Check | None = None
        self.current_extras: list[Any] = []
        self.complete = False
        self.summary: dict[str, Any] = {}
        self._ghost: list[Any] = []
        self._pending = False
        self._matched_now = False
        self._build_panel()
        ws.save_gate = self.can_save
        ws.controller.annotationsChanged.connect(self._schedule_check)
        self._start_step(0)
        self._fast_forward()

    def _fast_forward(self) -> None:
        """Work restored from an autosave: steps that already match are passed straight away."""
        if not self.store.annotations():
            return
        while not self.complete:
            result = self.check(count_attempt=False)
            if result is None or not result.matched or self.current_extras:
                break
            self.next_step()

    # ------------------------------------------------------------------ panel
    def _build_panel(self) -> None:
        ws, b = self.ws, self.ws.browser
        dock = QDockWidget("Learn with the experts", b)
        dock.setObjectName("electroclean_coach")
        dock.setFeatures(QDockWidget.DockWidgetMovable | QDockWidget.DockWidgetFloatable)
        outer = QWidget()
        ov = QVBoxLayout(outer)
        ov.setContentsMargins(0, 0, 0, 0)
        ov.setSpacing(0)
        w = QWidget()  # the text scrolls when the panel is short; the buttons stay in view
        v = QVBoxLayout(w)
        v.setContentsMargins(12, 10, 12, 8)
        v.setSpacing(8)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setWidget(w)
        ov.addWidget(scroll, 1)
        self._scroll = scroll
        self.header = style.label("", "caption")
        v.addWidget(self.header)
        self.progress = QProgressBar()
        self.progress.setTextVisible(False)
        self.progress.setMaximumHeight(8)
        v.addWidget(self.progress)
        self.title = style.label("", "heading", wrap=True)
        v.addWidget(self.title)
        # Feedback comes straight after the instruction, so it is in view on small screens too.
        self.feedback = style.label("", "note", wrap=True, rich=True)
        v.addWidget(self.feedback)
        self.body = style.label("", "subtitle", wrap=True, rich=True)
        v.addWidget(self.body)
        self.description = style.label("", "caption", wrap=True)
        v.addWidget(self.description)
        self.note = style.label("", "note", wrap=True)
        v.addWidget(self.note)
        self.stars_label = style.label("", "caption")
        v.addWidget(self.stars_label)
        v.addStretch(1)
        row = QHBoxLayout()
        row.setContentsMargins(12, 6, 12, 12)
        self.show_me_btn = QPushButton("Show me")
        style.set_kind(self.show_me_btn, "quiet")
        self.show_me_btn.setToolTip("Place the experts' annotation for you (this step then earns one star)")
        self.show_me_btn.clicked.connect(self.show_me)
        self.continue_btn = QPushButton("Continue")
        style.set_kind(self.continue_btn, "primary")
        self.continue_btn.setToolTip("Go on to the next artifact (Enter or Space)")
        self.continue_btn.clicked.connect(self.next_step)
        for btn in (self.show_me_btn, self.continue_btn):
            btn.setFocusPolicy(Qt.NoFocus)  # Space and Enter belong to the window's own keys
        row.addWidget(self.show_me_btn)
        row.addStretch(1)
        row.addWidget(self.continue_btn)
        ov.addLayout(row)
        dock.setWidget(outer)
        b.addDockWidget(Qt.RightDockWidgetArea, dock)
        b.splitDockWidget(dock, ws.annotation_dock, Qt.Vertical)  # the coach above the annotations
        b.tabifyDockWidget(ws.annotation_dock, ws.info_dock)
        ws.annotation_dock.raise_()
        self.dock = dock
        ws.coach_dock = dock
        self.continue_action = QAction("Continue", b)
        self.continue_action.setShortcuts([QKeySequence(Qt.Key_Return), QKeySequence(Qt.Key_Enter),
                                           QKeySequence(Qt.Key_Space)])
        self.continue_action.setShortcutContext(Qt.WindowShortcut)
        self.continue_action.triggered.connect(self.next_step)
        b.addAction(self.continue_action)
        # Save and Finish waits until every artifact matches, so Continue is the one action to take.
        self._save_tip = ws.save_btn.toolTip()
        self._sync_save_button()
        QTimer.singleShot(0, self._size_docks)

    def _sync_save_button(self) -> None:
        btn = self.ws.save_btn
        btn.setEnabled(self.complete)
        btn.setToolTip(self._save_tip if self.complete else
                       "Available when every one of the experts' annotations has been matched")

    def _size_docks(self) -> None:
        try:
            h = max(self.ws.browser.height(), 600)
            self.ws.browser.resizeDocks([self.dock, self.ws.annotation_dock], [int(h * 0.58), int(h * 0.42)],
                                        Qt.Vertical)
        except RuntimeError:  # window already closed
            pass

    # ------------------------------------------------------------------ steps
    @property
    def current(self) -> Step | None:
        return self.steps[self.index] if self.index < len(self.steps) else None

    def _type_name(self, label: str) -> str:
        return f"{label} ({self.catalogue.get(label).value})"

    def _start_step(self, index: int) -> None:
        self.index = index
        self._clear_ghost()
        self._step_t0 = time.monotonic()
        self._signature = None
        self._matched_now = False
        n = len(self.steps)
        rec, recs = self.position
        self.progress.setRange(0, max(n, 1))
        self.progress.setValue(len(self.matched))
        if index >= n:
            self._finish_recording()
            return
        step = self.steps[index]
        t = step.target
        self.header.setText(f"Recording {rec} of {recs}  ·  Step {index + 1} of {n}")
        key = self.quick_keys.get(t.label)
        key_text = f"press <b>{key}</b>" if key else "press <b>/</b> and type its name"
        where = ("the whole montage (Whole montage, or C)" if t.is_global
                 else f"{html.escape(list_words(list(t.channels)))} (Selected channels, then click the channel names)")
        if self.guidance == "show":
            self.title.setText(f"Mark this {t.label}")
            self.body.setText(
                f"The experts' annotation is outlined with a dashed line. Choose its type ({key_text}), choose "
                f"{where}, and drag across it from start to end (or press <b>M</b> at the start and at the end)."
            )
            self._draw_ghost(t)
            self._show_interval(t.onset_sample / self.sfreq, t.end_sample / self.sfreq, t.channels)
        elif self.guidance == "find":
            self.title.setText(f"Find the {t.label} on this screen")
            self.body.setText(
                f"There is {article(t.label)} {html.escape(t.label)} somewhere on this screen. Choose its type "
                f"({key_text}), decide which channels it affects, and mark it."
            )
            self._show_find_window(index)
        else:
            self.title.setText("Find the next artifact")
            self.body.setText(
                "Scroll on from here. Mark the next artifact you see, choose its type and channels, and the "
                "feedback tells you how close you are to the experts."
            )
            self._show_from_previous(index)
        named = self.guidance in ("show", "find")
        self.description.setText(self.catalogue.get(t.label).description if named else "")
        self.description.setVisible(named and bool(self.description.text()))
        self.note.setText(step.note if named else "")
        self.note.setVisible(named and bool(step.note))
        self._set_feedback("", "note")
        self.continue_btn.setText("Continue")
        self.continue_btn.setVisible(True)
        self.show_me_btn.setVisible(True)
        self._update_stars()
        self.log.event("guided_step_started", recording=self.recording_id, step=index + 1, steps=n,
                       guidance=self.guidance, target_label=t.label, target_onset_s=t.onset_sample / self.sfreq,
                       target_offset_s=t.end_sample / self.sfreq, target_channels=list(t.channels),
                       target_id=t.annotation_id)
        self.check(count_attempt=False)  # the trainee may already have marked it (working ahead)

    def _schedule_check(self) -> None:
        if not self._pending:
            self._pending = True
            QTimer.singleShot(0, self._run_scheduled_check)

    def _run_scheduled_check(self) -> None:
        self._pending = False
        try:
            self.check()
        except RuntimeError:  # the window has gone
            pass

    def check(self, count_attempt: bool = True) -> Check | None:
        """Check the trainee's annotations against the current step (called after every change)."""
        anns = self.store.annotations()
        signature = tuple((a.annotation_id, a.label, a.onset_sample, a.duration_samples, a.channels) for a in anns)
        changed = signature != self._signature
        self._signature = signature
        if self.complete or self.current is None:
            self._check_extras_when_complete(anns)
            return None
        step = self.current
        result = check_step(step, anns, self.sfreq, self.tol, taken=set(self.matched.values()),
                            quick_keys=self.quick_keys)
        self.last_check = result
        self.current_extras = extras(self.steps, anns, self.matched, result, self.index)
        if changed and count_attempt and result.candidate_id is not None and not result.matched:
            self.failed[self.index] = self.failed.get(self.index, 0) + 1
        if changed and count_attempt:
            self.log.event("guided_check", recording=self.recording_id, step=self.index + 1,
                           extras=[a.annotation_id for a in self.current_extras],
                           failed_attempts=self.failed.get(self.index, 0), **result.to_log())
        self._show_result(result)
        return result

    def _show_result(self, result: Check) -> None:
        ok = result.matched and not self.current_extras
        self.continue_btn.setEnabled(ok)
        self.continue_action.setEnabled(ok)
        if self.current_extras:
            extra = self.current_extras[0]
            a, b = extra.onset_sample / self.sfreq, extra.end_sample / self.sfreq
            on_target = any(overlaps(extra, s.target) for s in self.steps)
            if on_target:
                text = (f"You have marked this artifact twice ({html.escape(extra.label)}, {a:.2f}–{b:.2f} s): "
                        f"delete the extra one (select it and press Delete) or press {UNDO_HINT}.")
            else:
                text = (f"Nothing is marked at {a:.2f}–{b:.2f} s in the experts' annotations: delete this "
                        f"{html.escape(extra.label)} (it is selected; press Delete) or press {UNDO_HINT}.")
                self.ws.controller.select(extra.annotation_id)
            self._set_feedback(text, "banner")
            return
        if result.matched:
            if self.index in self.shown:
                self._set_feedback(
                    "This is how the experts marked it. Look at where it starts and ends and which channels it "
                    "covers, then press <b>Continue</b> (Enter).", "success")
            else:
                done = result.messages[0].rstrip(".")
                self._set_feedback(f"✓ {html.escape(done)}. Press <b>Continue</b> (Enter) for the next one.",
                                   "success")
            if not self._matched_now:
                self._matched_now = True
                self._flash(self.current.target if self.current else None)
            if self.guidance == "find_unnamed":
                step = self.current
                if step is not None:
                    self.title.setText(f"Found: {step.target.label}")
                    self.description.setText(self.catalogue.get(step.target.label).description)
                    self.description.setVisible(bool(self.description.text()))
                    self.note.setText(step.note)
                    self.note.setVisible(bool(step.note))
            return
        self._matched_now = False
        if result.problems == ["missing"]:
            self._set_feedback("", "note")
            return
        items = "".join(f"<li>{html.escape(m)}</li>" for m in result.messages)
        self._set_feedback(f"<b>Not quite yet:</b><ul style='margin:4px 0 0 -18px'>{items}</ul>", "banner")

    def _set_feedback(self, text: str, role: str) -> None:
        self.feedback.setText(text)
        style.set_role(self.feedback, role)
        self.feedback.setVisible(bool(text))
        if text:
            self._scroll.ensureWidgetVisible(self.feedback, 0, 8)

    def _update_stars(self) -> None:
        earned = sum(self.stars.values())
        possible = STARS_FIRST * len(self.stars)
        total = STARS_FIRST * len(self.steps)
        if not self.stars:
            self.stars_label.setText(f"Up to {STARS_FIRST} stars for each artifact you match yourself.")
        else:
            self.stars_label.setText(f"{star_text(earned, possible)}  {earned} of {possible} stars so far "
                                     f"({total} possible)")

    # -------------------------------------------------------------- actions
    def show_me(self) -> None:
        """Place the experts' annotation for the current step (it earns one star)."""
        step = self.current
        if step is None or not self.ws.controller.editable:
            return
        t = step.target
        taken = set(self.matched.values())
        # Remove the trainee's attempt and second attempts of the same type, then place the expert's.
        remove = [a.annotation_id for a in self.store.annotations()
                  if a.annotation_id not in taken and overlaps(a, t)
                  and (a.annotation_id == (self.last_check.candidate_id if self.last_check else None)
                       or a.label == t.label)]
        if remove:
            self.store.delete_many(remove)
        self.store.add(t.label, t.onset_sample, t.duration_samples, t.channels)
        self.shown.add(self.index)
        self._clear_ghost()
        self._draw_ghost(t)
        self._show_interval(t.onset_sample / self.sfreq, t.end_sample / self.sfreq, t.channels)
        self.log.event("guided_show_me", recording=self.recording_id, step=self.index + 1, replaced=remove,
                       target=describe_target(t, self.sfreq))
        self.check(count_attempt=False)

    def next_step(self) -> None:
        """Continue: allowed only when the current step matches and nothing extra is marked."""
        if self.complete:
            return
        result = self.check(count_attempt=False)
        if result is None or not result.matched or self.current_extras:
            return
        i = self.index
        self.matched[i] = result.candidate_id or ""
        self.stars[i] = stars_for(self.failed.get(i, 0), i in self.shown)
        self.seconds[i] = time.monotonic() - self._step_t0
        self.log.event("guided_step_completed", recording=self.recording_id, step=i + 1,
                       failed_attempts=self.failed.get(i, 0), shown=i in self.shown, stars=self.stars[i],
                       seconds=round(self.seconds[i], 3), annotation_id=self.matched[i])
        self._start_step(i + 1)

    # ------------------------------------------------------------ finishing
    def _finish_recording(self) -> None:
        self.complete = True
        n = len(self.steps)
        earned = sum(self.stars.values())
        self.summary = {
            "steps": n, "stars": earned, "max_stars": STARS_FIRST * n,
            "failed_attempts": sum(self.failed.values()), "shown": len(self.shown),
            "seconds": round(sum(self.seconds.values()), 3), "guidance": self.guidance,
        }
        self.ws.session.context["guided"] = dict(self.summary)  # saved in the session file
        self.ctrl.guided_summary = dict(self.summary, recording_id=self.recording_id)
        rec, recs = self.position
        self.header.setText(f"Recording {rec} of {recs}  ·  complete")
        self.progress.setValue(self.progress.maximum())
        self.title.setText("Recording complete")
        if n:
            self.body.setText(
                f"You matched all {n} of the experts' annotations in {minutes_text(self.summary['seconds'])}"
                + (f", {len(self.shown)} with Show me" if self.shown else "") + ".<br>"
                "Press <b>Save and Finish</b> to save your work and return to your training path."
            )
            self.stars_label.setText(f"{star_text(earned, STARS_FIRST * n)}  {earned} of {STARS_FIRST * n} stars")
        else:
            self.body.setText("The experts found no artifacts in this recording. Look through it, then press "
                              "<b>Save and Finish</b>.")
            self.stars_label.setText("")
        self.description.setVisible(False)
        self.note.setVisible(False)
        self.continue_btn.setVisible(False)
        self.show_me_btn.setVisible(False)
        self.continue_action.setEnabled(False)
        self._clear_ghost()
        self._sync_save_button()
        self.log.event("guided_recording_completed", recording=self.recording_id, **self.summary)
        self._check_extras_when_complete(self.store.annotations())

    def _check_extras_when_complete(self, anns: list[Any]) -> None:
        extra = extras(self.steps, anns, self.matched)
        if extra:
            a = extra[0]
            self._set_feedback(
                f"One more thing: nothing is marked at {a.onset_sample / self.sfreq:.2f}–"
                f"{a.end_sample / self.sfreq:.2f} s in the experts' annotations. Delete it before you save.",
                "banner")
        elif self.complete:
            self._set_feedback("✓ Everything matches the experts.", "success")

    def can_save(self) -> bool:
        """Save and Finish waits until every step matches and nothing extra is marked."""
        prompts, parent = self.ws.prompts, self.ws.browser
        if not self.complete:
            prompts.inform(parent, "Not finished yet",
                           f"Match each of the experts' annotations first: you are at step {self.index + 1} of "
                           f"{len(self.steps)}.")
            return False
        anns = self.store.annotations()
        for i, step in enumerate(self.steps):  # nothing changed since it was matched?
            others = set(self.matched.values()) - {self.matched.get(i, "")}
            result = check_step(step, anns, self.sfreq, self.tol, taken=others, quick_keys=self.quick_keys)
            if not result.matched:
                prompts.inform(parent, "A step no longer matches",
                               f"Step {i + 1} ({step.target.label}) no longer matches the experts' annotation:\n\n"
                               + "\n".join(result.messages) + "\n\nIt is shown again so you can put it right.")
                self.complete = False
                self._sync_save_button()
                for j in [k for k in self.matched if k >= i]:
                    self.matched.pop(j, None)
                self.continue_btn.setVisible(True)
                self.show_me_btn.setVisible(True)
                self._start_step(i)
                return False
            self.matched[i] = result.candidate_id or self.matched.get(i, "")
        extra = extras(self.steps, anns, self.matched)
        if extra:
            prompts.inform(parent, "Extra annotation",
                           "Some of your annotations are not in the experts' annotations. Delete them before you save.")
            return False
        return True

    # ------------------------------------------------------------ the view
    def _show_interval(self, t0: float, t1: float, channels: tuple[str, ...] = ()) -> None:
        p = self.ws.browser.mne
        window = float(p.duration)
        start = t0 if (t1 - t0) > window else t0 - (window - (t1 - t0)) / 2
        start = min(max(0.0, start), max(0.0, float(p.xmax) - window))
        p.plt.setXRange(start, start + window, padding=0)
        self._show_channels(channels)

    def _show_channels(self, channels: tuple[str, ...]) -> None:
        if not channels:
            return
        p = self.ws.browser.mne
        ordered = list(p.ch_names[p.ch_order])
        idx = [ordered.index(c) for c in channels if c in ordered]
        visible = range(int(p.ch_start), int(p.ch_start) + int(p.n_channels))
        if idx and not all(i in visible for i in idx):
            n = int(p.n_channels)
            top = min(max(0, min(idx) - 1), max(0, len(ordered) - n))
            p.plt.setYRange(top, top + n + 1, padding=0)

    def _show_find_window(self, index: int) -> None:
        """A 10 s screen that contains the artifact, not always in the same place on it."""
        t = self.steps[index].target
        p = self.ws.browser.mne
        window = max(float(p.duration), FIND_WINDOW_S)
        t0, t1 = t.onset_sample / self.sfreq, t.end_sample / self.sfreq
        if t1 - t0 >= window - 1.0:
            start = t0 - 0.5
        else:
            share = 0.15 + 0.7 * ((index * 0.618) % 1.0)  # where on the screen the artifact starts
            start = t0 - share * (window - (t1 - t0))
        start = min(max(0.0, start), max(0.0, float(p.xmax) - window))
        p.plt.setXRange(start, start + window, padding=0)

    def _show_from_previous(self, index: int) -> None:
        p = self.ws.browser.mne
        window = float(p.duration)
        start = 0.0 if index == 0 else self.steps[index - 1].target.end_sample / self.sfreq - 1.0
        start = min(max(0.0, start), max(0.0, float(p.xmax) - window))
        if index == 0 or start > float(p.t_start) + window or start < float(p.t_start) - window:
            p.plt.setXRange(start, start + window, padding=0)

    def _draw_ghost(self, target: Any) -> None:
        """A dashed outline of the experts' interval (and of its channels, for channel-specific ones)."""
        import pyqtgraph as pg

        p = self.ws.browser.mne
        colour = QColor(self.catalogue.colour_for(target.label))
        fill = QColor(colour)
        fill.setAlpha(28)
        pen = pg.mkPen(colour, width=2, style=Qt.DashLine)
        t0, t1 = target.onset_sample / self.sfreq, target.end_sample / self.sfreq
        region = pg.LinearRegionItem(values=(t0, t1), movable=False, brush=QBrush(fill), pen=pen)
        region.setAcceptedMouseButtons(Qt.NoButton)  # drawing over it must still work
        for line in region.lines:
            line.setAcceptedMouseButtons(Qt.NoButton)
        region.setZValue(0.5)
        p.plt.addItem(region, ignoreBounds=True)
        self._ghost.append(region)
        if target.channels:
            ordered = list(p.ch_names[p.ch_order])
            box_pen = pg.mkPen(colour, width=2, style=Qt.DashLine)
            box_fill = QColor(colour)
            box_fill.setAlpha(45)
            for ch in target.channels:
                if ch not in ordered:
                    continue
                y = ordered.index(ch) + 0.5
                rect = QGraphicsRectItem(t0, y, t1 - t0, 1.0)
                rect.setPen(box_pen)
                rect.setBrush(QBrush(box_fill))
                rect.setAcceptedMouseButtons(Qt.NoButton)
                rect.setZValue(0.6)
                p.plt.addItem(rect, ignoreBounds=True)
                self._ghost.append(rect)

    def _clear_ghost(self) -> None:
        p = self.ws.browser.mne
        for item in self._ghost:
            try:
                p.plt.removeItem(item)
            except (RuntimeError, ValueError, AttributeError):
                pass
        self._ghost = []

    def _flash(self, target: Any) -> None:
        """A short green glow over a matched artifact."""
        if target is None:
            return
        import pyqtgraph as pg

        p = self.ws.browser.mne
        green = QColor(style.colour("success"))
        green.setAlpha(70)
        item = pg.LinearRegionItem(values=(target.onset_sample / self.sfreq, target.end_sample / self.sfreq),
                                   movable=False, brush=QBrush(green), pen=pg.mkPen(None))
        item.setAcceptedMouseButtons(Qt.NoButton)
        item.setZValue(0.7)
        p.plt.addItem(item, ignoreBounds=True)

        def remove() -> None:
            try:
                p.plt.removeItem(item)
            except (RuntimeError, ValueError, AttributeError):
                pass

        QTimer.singleShot(900, remove)


def attach_guided_coach(ctrl: Any, ws: Any) -> GuidedCoach | None:
    rs = getattr(ctrl, "reference_set", None)
    if rs is None:
        return None
    coach = GuidedCoach(ctrl, ws, rs, ws.session.recording_id)
    ws.coach = coach
    return coach


# ======================================================================= Stage 2
FLAG_MISSED, FLAG_EXTRA, FLAG_TYPE = "MISSED", "EXTRA", "TYPE"


def review_flags(fb: dict[str, Any], mine: list[Any], reference: list[Any], sfreq: float) -> list[dict[str, Any]]:
    """The disagreements of a practice recording, each tied to an annotation in the review window.

    Region IDs are those of :func:`electroclean.training.gui.review_store` (``you-…`` and ``ref-…``)."""
    def near(a: Any, onset_s: float, offset_s: float) -> bool:
        tol = 1.5 / sfreq
        return abs(a.onset_sample / sfreq - onset_s) <= tol and abs(a.end_sample / sfreq - offset_s) <= tol

    flags: list[dict[str, Any]] = []
    for m in fb.get("missed", []):
        hit = next((a for a in reference if a.label == m["label"] and near(a, m["onset_s"], m["offset_s"])), None)
        if hit is not None:
            flags.append({"kind": FLAG_MISSED, "region": f"ref-{hit.annotation_id}", "label": hit.label,
                          "onset_s": m["onset_s"], "offset_s": m["offset_s"]})
    for e in fb.get("extra", []):
        hit = next((a for a in mine if a.label == e["label"] and near(a, e["onset_s"], e["offset_s"])), None)
        if hit is not None:
            flags.append({"kind": FLAG_EXTRA, "region": f"you-{hit.annotation_id}", "label": hit.label,
                          "onset_s": e["onset_s"], "offset_s": e["offset_s"]})
    for d in fb.get("label_differences", []):
        t0, t1 = d["onset_s"], d["offset_s"]
        cands = [a for a in mine if a.label == d["your_label"]
                 and a.onset_sample / sfreq < t1 and t0 < a.end_sample / sfreq]
        if cands:
            hit = cands[0]
            flags.append({"kind": FLAG_TYPE, "region": f"you-{hit.annotation_id}", "label": hit.label,
                          "should_be": d["reference_label"], "onset_s": hit.onset_sample / sfreq,
                          "offset_s": hit.end_sample / sfreq})
    flags.sort(key=lambda f: f["onset_s"])
    return flags


def _flag_text(f: dict[str, Any]) -> str:
    span = f"{f['onset_s']:.2f}–{f['offset_s']:.2f} s"
    if f["kind"] == FLAG_MISSED:
        return f"Missed: {f['label']}, {span}"
    if f["kind"] == FLAG_EXTRA:
        return f"Extra: your {f['label']}, {span} (not in the experts' annotations)"
    return f"Type: you chose {f['label']}; the experts chose {f['should_be']}, {span}"


def _flag_prefix(f: dict[str, Any]) -> str:
    if f["kind"] == FLAG_MISSED:
        return "MISSED · REF: "
    if f["kind"] == FLAG_EXTRA:
        return "EXTRA · YOU: "
    should = f["should_be"].replace("-artifact", "")
    return f"TYPE: should be {should} · YOU: "


FLAG_COLOURS = {FLAG_MISSED: "destructive", FLAG_EXTRA: "warning_text", FLAG_TYPE: "flag_type"}


def _colour_flags(ws: Any, flags: list[dict[str, Any]]) -> None:
    for f in flags:
        region = ws.controller.regions.get(f["region"])
        if region is None:
            continue
        region.text_color = QColor(style.colour(FLAG_COLOURS[f["kind"]]))
        try:
            region._style_label()
            region.label_item.update()
        except (AttributeError, RuntimeError):
            pass


def add_review_flags(ctrl: Any, ws: Any, flags: list[dict[str, Any]]) -> None:
    """Label the disagreements on the EEG and list them; clicking an item (or N / P) goes to it."""
    from electroclean.training.gui import style_reference_regions

    prefix = dict(ws.controller.display_prefix)
    for f in flags:
        prefix[f["region"]] = _flag_prefix(f)
    ws.controller.set_display_prefix(prefix)
    style_reference_regions(ws)
    _colour_flags(ws, flags)
    ws.controller.annotationsChanged.connect(lambda: _colour_flags(ws, flags))
    panel = ws.annotation_dock.widget().layout()
    box = QWidget()
    v = QVBoxLayout(box)
    v.setContentsMargins(0, 0, 0, 4)
    v.setSpacing(4)
    if flags:
        v.addWidget(style.label(f"What to look at ({len(flags)})", "heading"))
        v.addWidget(style.label("Click an item, or press N and P, to go to it.", "caption"))
        lst = QListWidget()
        lst.setMaximumHeight(150)
        for f in flags:
            item = QListWidgetItem(_flag_text(f))
            item.setData(Qt.UserRole, f["region"])
            item.setForeground(QBrush(QColor(style.colour(FLAG_COLOURS[f["kind"]]))))
            lst.addItem(item)
        v.addWidget(lst)
        ws.review_flag_list = lst

        def go(row: int) -> None:
            if not 0 <= row < len(flags):
                return
            f = flags[row]
            if f["region"] in ws.session.store:
                ws.controller.jump_to(f["region"])
            lst.blockSignals(True)
            lst.setCurrentRow(row)
            lst.blockSignals(False)
            ws.log.event("review_item_jumped", recording=ws.session.recording_id, flag=f["kind"],
                         label=f["label"], onset_s=f["onset_s"], offset_s=f["offset_s"], item=row + 1)

        lst.currentRowChanged.connect(go)

        def step(delta: int) -> None:
            row = lst.currentRow()
            go(min(max(0, (row + delta) if row >= 0 else (0 if delta > 0 else len(flags) - 1)), len(flags) - 1))

        for action, delta in ((getattr(ws, "next_action", None), 1), (getattr(ws, "prev_action", None), -1)):
            if action is None:
                continue
            try:
                action.triggered.disconnect()
            except (RuntimeError, TypeError):
                pass
            action.triggered.connect(lambda _=False, d=delta: step(d))
        ws.review_step = step
    else:
        v.addWidget(style.label("✓ Nothing missed, nothing extra and every type matches the experts.", "success",
                                wrap=True))
    panel.insertWidget(1, box)  # under the legend
    ws.review_flags = flags


# ===================================================================== the path
class TrainingPathWindow(QMainWindow):
    """The training programme as a path of three stages, with one Continue button."""

    def __init__(self, ctrl: Any) -> None:
        super().__init__()
        style.apply_theme()
        self.ctrl = ctrl
        self.setWindowTitle("ElectroClean – training programme")
        central = QWidget()
        self.setCentralWidget(central)
        v = QVBoxLayout(central)
        v.setContentsMargins(28, 22, 28, 20)
        v.setSpacing(14)
        self.title = style.label("Training programme", "title")
        v.addWidget(self.title)
        self.subtitle = style.label("", "subtitle", wrap=True)
        v.addWidget(self.subtitle)
        self.message = style.label("", "success", wrap=True)
        self.message.setVisible(False)
        v.addWidget(self.message)
        row = QHBoxLayout()
        row.setSpacing(14)
        self.cards: dict[str, dict[str, Any]] = {}
        for n, key in enumerate(("guided", "practice", "assessment"), start=1):
            frame, lay = style.card(margins=16, spacing=8)
            head = QHBoxLayout()
            head.setSpacing(10)
            badge = style.label(str(n), "badge")
            head.addWidget(badge)
            title = style.label(STAGE_TITLES[key], "heading", wrap=True)
            head.addWidget(title, 1)
            lay.addLayout(head)
            chip = style.label("", "chip")
            chip_row = QHBoxLayout()
            chip_row.addWidget(chip)
            chip_row.addStretch(1)
            lay.addLayout(chip_row)
            desc = style.label("", "caption", wrap=True)
            lay.addWidget(desc)
            progress = style.label("", "subtitle", wrap=True)
            lay.addWidget(progress)
            stars = style.label("", "subtitle", wrap=True)
            lay.addWidget(stars)
            detail = style.label("", "caption", wrap=True)
            lay.addWidget(detail)
            lay.addStretch(1)
            frame.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)  # three equal columns
            row.addWidget(frame, 1)
            self.cards[key] = {"n": n, "frame": frame, "badge": badge, "title": title, "chip": chip, "desc": desc,
                               "progress": progress, "stars": stars, "detail": detail}
        v.addLayout(row, 1)
        self.next_label = style.label("", "subtitle", wrap=True)
        v.addWidget(self.next_label)
        buttons = QHBoxLayout()
        self.back_btn = QPushButton("Back to the start window")
        self.back_btn.clicked.connect(lambda: leave_programme(self.ctrl))
        self.continue_btn = QPushButton("Continue")
        style.set_kind(self.continue_btn, "primary")
        self.continue_btn.setDefault(True)
        self.continue_btn.setMinimumWidth(200)
        self.continue_btn.clicked.connect(lambda: continue_programme(self.ctrl))
        buttons.addWidget(self.back_btn)
        buttons.addStretch(1)
        buttons.addWidget(self.continue_btn)
        v.addLayout(buttons)
        self.states: list[StageState] = []
        self.next: NextStep = NextStep(None)
        self._closing_ok = False
        self.resize(980, 500)

    def refresh(self, message: str = "") -> list[StageState]:
        ctrl = self.ctrl
        rs, layout, aid = ctrl.reference_set, ctrl.layout, ctrl.request.annotator_id
        prog = load_progress(layout, rs, aid)
        before = {s.key: s.status for s in self.states}
        self.states = programme_state(layout, rs, aid, prog)
        self.next = next_step(layout, rs, aid, self.states, prog)
        self.subtitle.setText(f"{rs.name or rs.set_id}  ·  annotator {aid}")
        self.message.setText(message)
        self.message.setVisible(bool(message))
        for s in self.states:
            self._show_stage(s, current=(s.key == self.next.stage))
            if before and before.get(s.key) != s.status and s.status == "completed":
                ctrl.log.event("stage_completed", **s.to_log())
                prog.note("stage_completed", stage=s.key)
        self.next_label.setText(self.next.text)
        self.continue_btn.setText(self.next.label or "Continue")
        self.continue_btn.setEnabled(self.next.stage is not None)
        self.continue_btn.setVisible(self.next.stage is not None)
        if self.next.stage is None:
            style.set_kind(self.back_btn, "primary")
        return self.states

    def _show_stage(self, s: StageState, current: bool) -> None:
        c = self.cards[s.key]
        chips = {"locked": ("Locked", ""), "available": ("Ready", "active"), "in_progress": ("In progress", "active"),
                 "completed": ("Completed", "done"), "not_used": ("Not part of this set", "")}
        text, state = chips[s.status]
        c["chip"].setText(text)
        style.set_state(c["chip"], state)
        c["badge"].setText("✓" if s.status == "completed" else str(c["n"]))
        style.set_state(c["badge"], {"completed": "done", "locked": "locked", "not_used": "locked"}.get(s.status, ""))
        frame_state = "current" if current else ("locked" if s.status in ("locked", "not_used") else "")
        if c["frame"].property("state") != frame_state:
            c["frame"].setProperty("state", frame_state)
            style._repolish(c["frame"])
        c["desc"].setText(s.description)
        unit = "recording" if s.total == 1 else "recordings"
        c["progress"].setText(f"{s.done} of {s.total} {unit} done" if s.total else "")
        if s.key == "guided" and s.max_stars:
            c["stars"].setText(f"{star_text(s.stars, s.max_stars)}  {s.stars} of {s.max_stars} stars")
        else:
            c["stars"].setText("")
        detail = s.detail
        if s.seconds >= 1:
            detail = (detail + "  " if detail else "") + f"Time so far: {minutes_text(s.seconds)}."
        if s.status == "locked":
            detail = "Unlocks when you complete the stage before."
        c["detail"].setText(detail)
        c["stars"].setVisible(bool(c["stars"].text()))
        c["detail"].setVisible(bool(detail))

    def closeEvent(self, event: Any) -> None:  # noqa: N802 - Qt API
        super().closeEvent(event)
        if event.isAccepted() and not self._closing_ok:
            QTimer.singleShot(0, lambda: leave_programme(self.ctrl))


# ================================================================ the programme flow
def programme_active(ctrl: Any) -> bool:
    return bool(getattr(ctrl, "programme_active", False)) and ctrl.reference_set is not None


def open_training_path(ctrl: AppController, message: str = "") -> TrainingPathWindow:
    """Show the training path (instead of the start window) while the programme is running."""
    win = getattr(ctrl, "training_path", None)
    if win is None:
        win = TrainingPathWindow(ctrl)
        ctrl.training_path = win
    ctrl.start_window.hide()
    states = win.refresh(message)
    win._closing_ok = False
    win.show()
    win.raise_()
    win.activateWindow()
    ctrl.log.event("training_path_opened", reference_set=ctrl.reference_set.set_id,
                   stages=[s.to_log() for s in states], next_stage=win.next.stage, next_recording=win.next.recording_id,
                   message=message)
    return win


def continue_programme(ctrl: AppController) -> None:
    win = getattr(ctrl, "training_path", None)
    if win is None:
        return
    step = win.next
    if step.stage is None:
        return
    ctrl.log.event("stage_started", stage=step.stage, recording=step.recording_id, repeat=step.repeat)
    load_progress(ctrl.layout, ctrl.reference_set, ctrl.request.annotator_id).note(
        "stage_started", stage=step.stage, recording=step.recording_id, repeat=step.repeat)
    win._closing_ok = True
    win.hide()
    ctrl.request.mode = step.stage
    if step.stage == "assessment" or step.recording_id is None:
        ctrl.next_recording()
    else:
        ctrl.open_recording(step.recording_id, repeat=step.repeat)


def leave_programme(ctrl: AppController) -> None:
    """Back to the start window (the programme can be continued later from where it was left)."""
    ctrl.programme_active = False
    win = getattr(ctrl, "training_path", None)
    if win is not None:
        win._closing_ok = True
        win.hide()
    ctrl.log.event("training_path_left")
    ctrl._back_to_start()


def after_guided_recording(ctrl: AppController, result: Any) -> str:
    """Record a saved Stage 1 recording in the trainee's progress; returns the message for the path."""
    summary = dict(getattr(ctrl, "guided_summary", {}) or {})
    rid = summary.pop("recording_id", None) or (ctrl.session.recording_id if ctrl.session else "")
    if rid and ctrl.reference_set is not None:
        load_progress(ctrl.layout, ctrl.reference_set, ctrl.request.annotator_id).record_guided(rid, summary)
    ctrl.guided_summary = {}
    if summary.get("steps"):
        return (f"Recording saved: {summary['stars']} of {summary['max_stars']} stars "
                f"({minutes_text(summary.get('seconds', 0))}).")
    return "Recording saved."


def practice_verdict_html(rs: Any, verdict: dict[str, Any], in_programme: bool) -> str:
    """The pass or not-yet line under the practice feedback."""
    rule = PassRule.from_dict(rs.practice_pass)
    unlock = " The assessment is unlocked." if (in_programme and rs.assessment_recordings) else ""
    if verdict["passed"]:
        return (f"<p style='color:{style.colour('success')}'><b>Passed:</b> you reached the pass mark "
                f"({html.escape(rule.describe())}).{unlock}</p>")
    return (f"<p style='color:{style.colour('warning_text')}'><b>Not yet:</b> you need {html.escape(rule.describe())}. "
            "Review what you missed in the viewer, then try the next practice recording or this one again.</p>")
