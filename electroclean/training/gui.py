"""Training, quiz and administrator windows (Component C)."""

from __future__ import annotations

import html
from pathlib import Path
from typing import TYPE_CHECKING, Any

from qtpy.QtCore import Qt, QUrl
from qtpy.QtGui import QDesktopServices
from qtpy.QtWidgets import (
    QAbstractItemView,
    QButtonGroup,
    QCheckBox,
    QComboBox,
    QDialog,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QPlainTextEdit,
    QPushButton,
    QRadioButton,
    QScrollArea,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from electroclean.app.annotations.model import ArtifactAnnotation
from electroclean.app.annotations.store import AnnotationStore
from electroclean.app.gui import style
from electroclean.app.gui.dialogs import UserPrompts, colour_icon, fill_label_combo
from electroclean.config.settings import SELECTION_STRATEGIES, FilterSettings, load_settings
from electroclean.training import admin
from electroclean.training.assessment import (
    METRICS,
    CompetencyCriteria,
    competency_report,
    competency_summary_html,
    describe_provenance,
    feedback_html,
    practice_feedback,
)
from electroclean.training.quiz import QuizSession
from electroclean.training.reference import (
    METHOD_NAMES,
    METHODS,
    NONE_OPTION,
    QuizItem,
    ReferenceSet,
    ReferenceSetError,
    find_reference_sets,
    import_adjudicated_reference,
    import_expert_reference,
    reference_sets_dir,
)

if TYPE_CHECKING:  # pragma: no cover
    from electroclean.app.eeg.loading import LoadedRecording
    from electroclean.app.gui.app_controller import AppController
    from electroclean.app.session.session import AnnotationSession


# ----------------------------------------------------------------- practice
class ReviewSession:
    """Minimal stand-in for an AnnotationSession, used by the read-only review window."""

    def __init__(self, loaded: LoadedRecording, store: AnnotationStore, annotator_id: str, filters: FilterSettings,
                 set_id: str) -> None:
        self.loaded = loaded
        self.store = store
        self.catalogue = store.catalogue
        self.annotator_id = annotator_id
        self.display_name = "review against reference"
        self.mode = "practice"
        self.context_id = set_id
        self.filters = filters
        self.recording_id = loaded.info.recording_id
        self.elapsed_s = 0.0

    def start_timer(self) -> None:
        return None

    def abandon(self, reason: str = "") -> None:
        return None


def review_store(loaded: LoadedRecording, mine: list[ArtifactAnnotation], reference: list[ArtifactAnnotation],
                 catalogue: Any) -> tuple[AnnotationStore, dict[str, str]]:
    items: list[ArtifactAnnotation] = []
    prefix: dict[str, str] = {}
    for tag, anns in (("YOU", mine), ("REF", reference)):
        for a in anns:
            aid = f"{tag.lower()}-{a.annotation_id}"
            items.append(a.with_changes(annotation_id=aid))
            prefix[aid] = f"{tag}: "
    return AnnotationStore(loaded.info, catalogue, initial=items, auto_merge=False), prefix  # YOU and REF may overlap


REVIEW_LEGEND = (
    "<b>YOU</b>: your annotations (shaded) &nbsp;·&nbsp; <b>REF</b>: the reference (hatched, dotted edges)"
)


def style_reference_regions(ws: Any) -> None:
    """Draw the reference's intervals hatched with dotted edges, so they stand apart from the annotator's own."""
    import pyqtgraph as pg
    from qtpy.QtGui import QBrush, QColor

    cat = ws.session.catalogue
    for aid, region in ws.controller.regions.items():
        if not aid.startswith("ref-"):
            continue
        colour = QColor(cat.colour_for(region.description))
        hatch = QColor(colour)
        hatch.setAlpha(210)
        brush = QBrush(hatch, Qt.BDiagPattern)
        region.setBrush(brush)
        region.setHoverBrush(brush)
        pen = pg.mkPen(color=colour, width=2, style=Qt.DotLine)
        for line in region.lines:
            line.setPen(pen)
        for item in region.single_channel_annots.values():
            item.setBrush(brush)
        region.update()


def prepare_review_window(ws: Any) -> None:
    """Review against the reference: distinct drawing, a legend and a Finish review button; no clock."""
    style_reference_regions(ws)
    ws.controller.annotationsChanged.connect(lambda: style_reference_regions(ws))  # regions are redrawn on changes
    legend = QLabel(REVIEW_LEGEND)
    legend.setTextFormat(Qt.RichText)
    legend.setWordWrap(True)
    style.set_role(legend, "note")
    panel = ws.annotation_dock.widget().layout()  # above the list of annotations
    panel.insertWidget(0, legend)
    ws.review_legend = legend
    finish = QPushButton("Finish review")
    style.set_kind(finish, "primary")
    finish.setToolTip("Close the review and continue")
    finish.clicked.connect(ws.browser.close)
    bar = getattr(ws, "actions_toolbar", None) or ws.toolbar
    bar.addWidget(finish)
    ws.finish_review_btn = finish
    clock = getattr(ws, "clock_label", None)
    if clock is not None:
        clock.setVisible(False)  # nothing is being timed in a review


def show_practice_feedback(ctrl: AppController, session: AnnotationSession, loaded: LoadedRecording) -> None:
    rs: ReferenceSet = ctrl.reference_set
    rid = loaded.info.recording_id
    try:
        ref = rs.reference_document(rid)
        mine = session.build_document()
        fb = practice_feedback(mine, ref, rs)
        text = feedback_html(fb)
    except Exception as exc:  # feedback is helpful but never blocks saving
        ctrl.prompts.error(ctrl.parent_widget, "Feedback unavailable", f"Feedback could not be prepared: {exc}")
        ctrl.after_practice_feedback(loaded)
        return
    ctrl.history.append({"event": "practice_feedback", "recording_id": rid, "overall": fb["overall"]})
    buttons = ["Review in the viewer", "Continue"] if rs.practice_review else ["Continue"]
    choice = ctrl.prompts.show_html(ctrl.parent_widget, "Practice feedback", text, buttons)
    if choice != "Review in the viewer":
        ctrl.after_practice_feedback(loaded)
        return
    from electroclean.app.gui.annotation_window import AnnotationWorkspace

    try:
        store, prefix = review_store(loaded, list(mine.annotations), list(ref.annotations), session.catalogue)
        rsession = ReviewSession(loaded, store, session.annotator_id, session.filters, rs.set_id)
        ws = AnnotationWorkspace(
            rsession, ctrl.settings, prompts=ctrl.prompts, read_only=True, display_prefix=prefix,  # type: ignore[arg-type]
            window_title=f"ElectroClean – review {loaded.files.stem}: YOU versus REF (reference)",
        )
        prepare_review_window(ws)
    except Exception as exc:
        ctrl.prompts.error(ctrl.parent_widget, "Review unavailable", f"The review could not be opened: {exc}")
        ctrl.after_practice_feedback(loaded)
        return
    ctrl.review_workspace = ws

    def review_closed() -> None:
        ctrl.review_workspace = None  # release the window and the recording's display data
        ctrl.after_practice_feedback(loaded)

    ws.closedWithoutSaving.connect(review_closed)
    ws.show()


def show_assessment_completion(ctrl: AppController) -> None:
    rs: ReferenceSet = ctrl.reference_set
    aid = ctrl.request.annotator_id
    try:
        rep = competency_report(ctrl.layout, rs, aid)
    except Exception as exc:
        ctrl.prompts.error(ctrl.parent_widget, "Report unavailable", f"The competency report could not be produced: {exc}")
        return
    ctrl.history.append({"event": "competency_report", "status": rep["status"]})
    where = rep.get("paths", {}).get("html", "")
    # The annotator sees the result and the criteria only. The full report lists the reference's artifacts
    # with their times and channels, and assessment recordings are shared between annotators, so it is
    # shown only when the administrator allows it for this reference set.
    full = bool(where) and rs.show_full_report_to_annotator
    text = (f"<p>You have completed all assessment recordings in <b>{html.escape(rs.name or rs.set_id)}</b>.</p>"
            + competency_summary_html(rep))
    buttons = ["Open the full report", "Close"] if full else ["Close"]
    choice = ctrl.prompts.show_html(ctrl.parent_widget, "Assessment complete", text, buttons)
    if choice == "Open the full report" and not ctrl.synchronous_loading:
        QDesktopServices.openUrl(QUrl.fromLocalFile(where))


def training_title_suffix(ctrl: AppController, mode: str) -> str:
    """'practice recording 2 of 5' (or assessment) for the annotation window's title; '' outside training."""
    from electroclean.app.session.register import CompletionRegister

    rs = getattr(ctrl, "reference_set", None)
    if mode not in ("practice", "assessment") or rs is None or ctrl.request is None or ctrl.layout is None:
        return {"practice": "practice", "assessment": "assessment"}.get(mode, "")
    total = rs.practice_recordings if mode == "practice" else rs.assessment_recordings
    try:
        done = CompletionRegister(ctrl.layout).completed(ctrl.request.annotator_id, mode, rs.set_id) & set(total)
    except Exception:  # the title is a convenience only
        return mode
    current = min(len(done) + 1, max(len(total), 1))
    return f"{mode} recording {current} of {len(total)}"


def practice_complete_text(rs: ReferenceSet) -> str:
    """The message when every practice recording of a set has been done."""
    quiz = " There is also a short-segments quiz you can practise with." if rs.quiz_items else ""
    return (
        f"You have completed every practice recording in {rs.name or rs.set_id}.{quiz}\n\n"
        "When you feel ready, choose Competency assessment in the start window, or ask your study administrator "
        "whether more practice recordings can be added."
    )


# --------------------------------------------------------------------- quiz
class QuizWindow(QMainWindow):
    """Shows one short EEG segment at a time and asks for the principal artifact type."""

    def __init__(self, ctrl: AppController, quiz: QuizSession) -> None:
        super().__init__()
        self.ctrl = ctrl
        self.quiz = quiz
        self.catalogue = ctrl.catalogue
        style.apply_theme()
        kind = "practice quiz" if quiz.mode == "practice" else "assessment quiz"
        self.setWindowTitle(
            f"ElectroClean {kind} – {quiz.reference_set.name or quiz.reference_set.set_id} – {quiz.annotator_id}"
        )
        self._loaded: dict[str, Any] = {}
        self.browser: Any = None
        central = QWidget()
        self.setCentralWidget(central)
        layout = QHBoxLayout(central)
        self.view_box = QVBoxLayout()
        self.progress = QLabel()
        self.view_box.addWidget(self.progress)
        self.view_host = QWidget()
        self.view_layout = QVBoxLayout(self.view_host)
        self.view_layout.setContentsMargins(0, 0, 0, 0)
        self.view_box.addWidget(self.view_host, 1)
        left = QWidget()
        left.setLayout(self.view_box)
        layout.addWidget(left, 1)
        side = QVBoxLayout()
        question = QLabel("<b>Which artifact type is the main one in the shaded segment?</b>")
        question.setWordWrap(True)
        side.addWidget(question)
        self.group = QButtonGroup(self)
        inner = QWidget()
        il = QVBoxLayout(inner)
        il.setSpacing(1)
        # Grouped as in the annotation window: family headings, colours, group terms marked.
        self._options = quiz.options(self.catalogue.label_names)
        section = None
        for i, opt in enumerate(self._options):
            lab = self.catalogue.get(opt) if self.catalogue.is_permitted(opt) else None
            heading = lab.section if lab is not None else "Other"
            if heading and heading != section:
                section = heading
                head = QLabel(f"<b>{html.escape(heading)}</b>")
                head.setContentsMargins(0, 6, 0, 0)
                il.addWidget(head)
            if lab is None:
                rb = QRadioButton(opt)
            else:
                rb = QRadioButton(lab.label + ("  (group: exact type unclear)" if lab.is_group else ""))
                rb.setIcon(colour_icon(lab.colour))
                rb.setToolTip(lab.description or lab.label)
                if lab.is_group:
                    font = rb.font()
                    font.setItalic(True)
                    rb.setFont(font)
            self.group.addButton(rb, i)
            il.addWidget(rb)
        il.addStretch(1)
        scroll = QScrollArea()
        scroll.setWidget(inner)
        scroll.setWidgetResizable(True)
        side.addWidget(scroll, 1)
        self.feedback = QLabel()
        self.feedback.setWordWrap(True)
        side.addWidget(self.feedback)
        self.submit = QPushButton("Submit answer")
        style.set_kind(self.submit, "primary")
        self.submit.clicked.connect(self._submit)
        side.addWidget(self.submit)
        sw = QWidget()
        sw.setLayout(side)
        sw.setFixedWidth(360)
        layout.addWidget(sw)
        width, height = 1400, 820
        screen = self.screen()
        if screen is not None:  # fit laptop screens (1366 x 768)
            avail = screen.availableGeometry()
            width, height = min(width, int(avail.width() * 0.97)), min(height, int(avail.height() * 0.92))
        self.resize(width, height)
        self._awaiting_next = False
        self._done = False
        self.show_item()

    def closeEvent(self, event) -> None:  # noqa: ANN001, N802 - Qt API
        if self._done:
            super().closeEvent(event)
            return
        stop = self.ctrl.prompts.ask(
            self, "Stop the quiz?",
            f"You have answered {self.quiz.current_index()} of {len(self.quiz.items)} segments.\n\n"
            "If you stop now, your answers so far are saved and marked as incomplete.",
            yes="Stop the quiz", no="Continue the quiz", default_yes=False,
        )
        if not stop:
            event.ignore()
            return
        self._done = True
        try:
            path = self.quiz.save(self.ctrl.layout)
            self.ctrl.history.append({"event": "quiz_stopped", "path": str(path)})
        except OSError as exc:
            self.ctrl.prompts.error(self, "Quiz", f"The answers could not be saved: {exc}")
        self._release()
        super().closeEvent(event)
        self.ctrl._back_to_start()

    def _release(self) -> None:
        if self.browser is not None:
            self.browser.close()
            self.browser.deleteLater()
            self.browser = None
        for lr in self._loaded.values():
            lr.close()
        self._loaded.clear()
        if self.ctrl.quiz_window is self:
            self.ctrl.quiz_window = None

    def _segment_browser(self, item: QuizItem) -> Any:
        from electroclean.app.eeg.loading import load_recording
        from electroclean.app.gui.browser import add_highlight, create_browser, make_readonly

        files = next((r for r in self.ctrl.recordings if r.recording_id == item.recording_id), None)
        if files is None:
            raise ReferenceSetError(f"Quiz recording {item.recording_id} was not found in the dataset")
        if item.recording_id not in self._loaded:
            s = self.ctrl.settings
            self._loaded[item.recording_id] = load_recording(files, s, s.filters, self.catalogue)
        lr = self._loaded[item.recording_id]
        dur = lr.timing.duration_s
        tmin = max(0.0, item.start_s - item.context_s)
        tmax = min(dur, item.end_s + item.context_s)
        # Copy only the segment (Raw.copy() would duplicate the whole recording first).
        sf = lr.view_raw.info["sfreq"]
        start, stop = int(round(tmin * sf)), int(round(tmax * sf))
        import mne

        seg = mne.io.RawArray(lr.view_raw.get_data(start=start, stop=stop), lr.view_raw.info.copy(), verbose="error")
        b = create_browser(
            seg, events=None, event_id=None, label_colours={}, title="quiz segment", duration_s=tmax - tmin,
            n_channels=len(seg.ch_names), scalings={**self.ctrl.settings.display.scalings, **lr.display_scalings},
            theme=self.ctrl.settings.display.theme,
        )
        make_readonly(b)
        add_highlight(b, item.start_s - tmin, item.end_s - tmin)
        return b

    def show_item(self) -> None:
        item = self.quiz.current_item()
        if self.browser is not None:
            self.browser.close()
            self.browser.deleteLater()
            self.browser = None
        if item is None:
            self._finish()
            return
        n = self.quiz.current_index() + 1
        self.progress.setText(f"Segment {n} of {len(self.quiz.items)}")
        self.feedback.setText("")
        self.group.setExclusive(False)
        for b in self.group.buttons():
            b.setChecked(False)
        self.group.setExclusive(True)
        self.submit.setText("Submit answer")
        self._awaiting_next = False
        try:
            self.browser = self._segment_browser(item)
        except Exception as exc:
            self.feedback.setText(f"<span style='color:{style.colour('destructive')}'>This segment could not be shown: {html.escape(str(exc))}</span>")
            return
        self.browser.setParent(self.view_host)
        self.browser.setWindowFlags(Qt.Widget)
        self.view_layout.addWidget(self.browser)
        self.browser.show()
        self.quiz.item_shown()
        _log(self.ctrl).event("quiz_item_shown", item_id=item.item_id, index=n, n_items=len(self.quiz.items),
                              quiz_mode=self.quiz.mode)

    def answer(self, label: str) -> bool:
        """Record an answer for the current item (also used by tests)."""
        correct = self.quiz.answer(label)
        item = self.quiz.items[self.quiz.current_index() - 1]
        record = self.quiz.answers.get(item.item_id, {})
        _log(self.ctrl).event("quiz_answer", item_id=item.item_id, answer=label, correct=bool(correct),
                              response_time_s=record.get("response_time_s"), quiz_mode=self.quiz.mode)
        if self.quiz.feedback_immediately:
            verdict = "Correct." if correct else f"Not quite: the expected answer is {item.correct_label}."
            self.feedback.setText(f"<b>{verdict}</b> {html.escape(item.explanation)}")
        return correct

    def _submit(self) -> None:
        if self._awaiting_next:
            self.show_item()
            return
        btn = self.group.checkedButton()
        if btn is None:
            self.feedback.setText("Please choose an answer.")
            return
        self.answer(self._options[self.group.id(btn)])
        if self.quiz.feedback_immediately:
            self._awaiting_next = True
            self.submit.setText("Next segment")
        else:
            self.show_item()

    def _finish(self) -> None:
        self._done = True
        path = self.quiz.save(self.ctrl.layout)
        s = self.quiz.score()
        _log(self.ctrl).event("quiz_finished", n_items=s.get("n_items"), n_correct=s.get("n_correct"),
                              proportion_correct=s.get("proportion_correct"), quiz_mode=self.quiz.mode)
        self._release()
        self.ctrl.history.append({"event": "quiz_finished", "score": s, "path": str(path)})
        self.ctrl.prompts.inform(
            self, "Quiz complete",
            f"You answered {s['n_correct']} of {s['n_items']} segments correctly "
            f"({100 * s['proportion_correct']:.0f}%).\n\nResults saved to {path}",
        )
        self.close()
        self.ctrl._back_to_start()


def _log(ctrl: Any) -> Any:
    """The visit's interaction log (a no-op log when there is none)."""
    from electroclean.app.session.interaction_log import NULL_LOG

    return getattr(ctrl, "log", None) or NULL_LOG


def start_quiz(ctrl: AppController) -> bool:
    rs: ReferenceSet = ctrl.reference_set
    if not rs.quiz_items:
        ctrl.prompts.inform(ctrl.parent_widget, "No quiz", "This reference set has no quiz items.")
        return False
    quiz = QuizSession(rs, ctrl.request.annotator_id, "practice" if ctrl.request.mode == "practice" else "assessment")
    win = QuizWindow(ctrl, quiz)
    ctrl.quiz_window = win
    ctrl.start_window.hide()
    win.show()
    return True


# -------------------------------------------------------------------- admin
def open_admin_tools(ctrl: AppController, dataset_root: Path | None) -> None:
    prompts = ctrl.prompts
    if dataset_root is None or not Path(dataset_root).is_dir():
        prompts.error(ctrl.parent_widget, "Administrator tools", "Choose the dataset folder in the start window first.")
        return
    try:
        data = admin.read_study_dict(dataset_root)
    except (OSError, ValueError) as exc:
        prompts.error(
            ctrl.parent_widget, "Administrator tools",
            f"The study file in {dataset_root} cannot be read, so the administrator tools cannot open:\n\n{exc}\n\n"
            "Correct it in a text editor (it must be valid JSON), or move it aside to start again.",
        )
        return
    record = data.get("admin_passphrase")
    if record:
        pw = prompts.ask_text(ctrl.parent_widget, "Administrator", "Administrator passphrase:", password=True)
        if not pw:
            return  # cancelled
        if not admin.verify_passphrase(pw, record):
            prompts.error(
                ctrl.parent_widget, "Administrator",
                "Incorrect passphrase.\n\nIf it has been forgotten, someone who can edit the study folder can set a "
                f"new one with the command electroclean-admin set-passphrase \"{dataset_root}\", or remove the "
                "\"admin_passphrase\" entry from electroclean_study.json in a text editor.",
            )
            return
    try:
        dlg = AdminDialog(ctrl, Path(dataset_root), prompts)
    except Exception as exc:
        prompts.error(ctrl.parent_widget, "Administrator tools", f"The study settings cannot be used: {exc}")
        return
    ctrl.admin_dialog = dlg
    dlg.show()


class AdminDialog(QDialog):
    def __init__(self, ctrl: AppController, dataset_root: Path, prompts: UserPrompts) -> None:
        super().__init__(ctrl.parent_widget)
        self.ctrl = ctrl
        self.root = dataset_root
        self.prompts = prompts
        style.apply_theme()
        self.setWindowTitle(f"Administrator tools – {dataset_root}")
        self.resize(1000, 720)
        layout = QVBoxLayout(self)
        self.pass_warning = QLabel("No administrator passphrase is set. Set one on the Study tab so annotators do not "
                                   "open these tools by accident.")
        style.set_role(self.pass_warning, "banner")
        self.pass_warning.setWordWrap(True)
        self.pass_warning.setVisible(not admin.read_study_dict(dataset_root).get("admin_passphrase"))
        layout.addWidget(self.pass_warning)
        self._set_dependent: list[QWidget] = []  # widgets that need a reference set
        self._build_set_selector(layout)
        self.tabs = QTabWidget()
        layout.addWidget(self.tabs)
        self._build_study_tab()
        self._build_reference_tab()
        self._build_criteria_tab()
        self._build_quiz_tab()
        self._build_progress_tab()
        self._refresh_sets()

    # ---------------------------------------------------------------- utils
    def _settings(self) -> tuple[Any, Any]:
        return load_settings(self.root)

    def _layout(self) -> Any:
        from electroclean.training.cli import output_layout

        return output_layout(self.root)

    def _error(self, exc: Exception) -> None:
        self.prompts.error(self, "Administrator tools", str(exc))

    def _recordings(self) -> list[str]:
        from electroclean.app.io.discovery import discover_recordings

        s, _ = self._settings()
        return [r.recording_id for r in discover_recordings(self.root, suffixes=s.discovery_suffixes,
                                                            exclude_dir_names=s.discovery_exclude_dir_names)]

    def _needs_set(self, widget: QWidget) -> QWidget:
        self._set_dependent.append(widget)
        return widget

    def _update_buttons(self, *args: Any) -> None:
        has_set = self.current_set() is not None
        for w in self._set_dependent:
            w.setEnabled(has_set)
        has_row = has_set and bool(self.rec_table.selectionModel().selectedRows())
        self.change_use_btn.setEnabled(has_row)
        self.remove_btn.setEnabled(has_row)
        self.remove_quiz_btn.setEnabled(has_set and bool(self.quiz_table.selectionModel().selectedRows()))

    # ---------------------------------------------------------- set selector
    def _build_set_selector(self, layout: QVBoxLayout) -> None:
        """One reference-set choice for every tab that works on a reference set."""
        box = QGroupBox("Reference set")
        row = QHBoxLayout(box)
        self.set_combo = QComboBox()
        self.set_combo.currentIndexChanged.connect(self._show_set)
        new = QPushButton("New reference set…")
        new.clicked.connect(self.new_set)
        row.addWidget(self.set_combo, 1)
        row.addWidget(new)
        hint = style.label("used by the Reference sets, Competency criteria, Quiz and Progress tabs", "caption")
        row.addWidget(hint)
        layout.addWidget(box)

    # ---------------------------------------------------------------- study
    def _build_study_tab(self) -> None:
        w = QWidget()
        form = QFormLayout(w)
        data = admin.read_study_dict(self.root)
        settings, _ = self._settings()
        self.study_id = QLineEdit(str(data.get("study_id", "")))
        form.addRow("Study ID", self.study_id)
        self.annotators = QPlainTextEdit(
            "\n".join(
                (a["annotator_id"] + (f", {a.get('display_name', '')}" if a.get("display_name") else ""))
                if isinstance(a, dict) else str(a)
                for a in data.get("annotators", [])
            )
        )
        self.annotators.setPlaceholderText("One per line: ID, display name (e.g. A01, Cameron)")
        self.annotators.setFixedHeight(110)
        form.addRow("Annotators", self.annotators)
        self.allow_unlisted = QCheckBox("Allow annotators who are not listed")
        self.allow_unlisted.setChecked(bool(data.get("allow_unlisted_annotators", True)))
        form.addRow("", self.allow_unlisted)
        self.strategy = QComboBox()
        for key, text in (("random", "random order"), ("seeded", "reproducible order (seed)"),
                          ("manual", "assigned recordings only")):
            if key in SELECTION_STRATEGIES:
                self.strategy.addItem(text, key)
        self.strategy.setCurrentIndex(max(0, self.strategy.findData(settings.selection_strategy)))
        self.seed = QSpinBox()
        self.seed.setRange(0, 2**31 - 1)
        self.seed.setValue(settings.selection_seed or 0)
        self.strategy.currentIndexChanged.connect(lambda *_: self.seed.setEnabled(self.strategy.currentData() == "seeded"))
        self.seed.setEnabled(self.strategy.currentData() == "seeded")
        row = QHBoxLayout()
        row.addWidget(self.strategy)
        row.addWidget(QLabel("seed"))
        row.addWidget(self.seed)
        form.addRow("Recording selection", row)
        f = settings.filters
        box = QGroupBox("Viewing filters")
        fl = QFormLayout(box)
        self.fix_filters = QCheckBox("Fix these filters for every annotator (recommended for reliability studies)")
        self.fix_filters.setChecked(f.locked)
        self.f_hp = QCheckBox(f"High-pass {f.highpass_hz:g} Hz")
        self.f_hp.setChecked(f.highpass_enabled)
        self.f_notch = QComboBox()
        self.f_notch.addItems(["50", "60", "off"])
        self.f_notch.setCurrentText("off" if not f.notch_enabled else f"{f.notch_hz:g}")
        self._f_method = f.method  # FIR by study decision; kept as set in the study file
        fl.addRow(self.fix_filters)
        fl.addRow("", self.f_hp)
        fl.addRow("Notch (Hz)", self.f_notch)
        fl.addRow("Design", QLabel("FIR, zero-phase (MNE defaults)" if f.method == "fir" else f.method.upper()))
        form.addRow(box)
        buttons = QHBoxLayout()
        save = QPushButton("Save study settings")
        save.clicked.connect(self.save_study)
        pw = QPushButton("Set administrator passphrase…")
        pw.clicked.connect(self.set_passphrase)
        alloc = QPushButton("Create balanced allocation…")
        alloc.clicked.connect(self.allocate)
        for b in (save, pw, alloc):
            buttons.addWidget(b)
        form.addRow(buttons)
        self.tabs.addTab(w, "Study")

    def save_study(self) -> None:
        try:
            data = admin.read_study_dict(self.root)
            data["study_id"] = self.study_id.text().strip()
            anns = []
            for line in self.annotators.toPlainText().splitlines():
                if line.strip():
                    aid, _, name = line.partition(",")
                    anns.append({"annotator_id": aid.strip().upper(), "display_name": name.strip()})
            data["annotators"] = anns
            data["allow_unlisted_annotators"] = self.allow_unlisted.isChecked()
            alloc = data.get("allocation") or {}
            alloc["strategy"] = self.strategy.currentData()
            alloc["seed"] = self.seed.value()
            data["allocation"] = alloc
            settings = data.setdefault("settings", {})
            if isinstance(settings.get("events"), dict):
                settings["events"].pop("collision_policy", None)  # no longer used: artifacts have their own column
                if not settings["events"]:
                    del settings["events"]
            notch = self.f_notch.currentText()
            settings["filters"] = FilterSettings(
                highpass_enabled=self.f_hp.isChecked(), notch_enabled=notch != "off",
                notch_hz=50.0 if notch == "off" else float(notch), method=self._f_method,
                locked=self.fix_filters.isChecked(),
            ).to_dict()
            path = admin.write_study_dict(self.root, data)
        except Exception as exc:
            self._error(exc)
            return
        self.prompts.inform(self, "Saved", f"Study settings saved to {path}")
        self.ctrl.start_window.refresh()

    def set_passphrase(self) -> None:
        pw = self.prompts.ask_text(self, "Administrator passphrase", "New passphrase (at least 6 characters):",
                                   password=True)
        if not pw:
            return
        if len(pw) < 6:
            self.prompts.error(self, "Administrator passphrase", "The passphrase must have at least 6 characters.")
            return
        again = self.prompts.ask_text(self, "Administrator passphrase", "Repeat the passphrase:", password=True)
        if pw != again:
            self.prompts.error(self, "Administrator passphrase", "The passphrases differ.")
            return
        try:
            admin.set_admin_passphrase(self.root, pw)
        except Exception as exc:
            self._error(exc)
            return
        self.pass_warning.setVisible(False)
        self.prompts.inform(self, "Saved", "Administrator passphrase set.")

    def allocate(self) -> None:
        ids = [line.partition(",")[0].strip().upper() for line in self.annotators.toPlainText().splitlines() if line.strip()]
        if len(ids) < 2:
            self.prompts.error(self, "Allocation", "List at least two annotators first (and save).")
            return
        k = self.prompts.choose_item(self, "Allocation", "Annotators per recording:", [str(i) for i in range(1, len(ids) + 1)],
                                     min(1, len(ids) - 1))
        if not k:
            return
        try:
            assignments = admin.make_balanced_allocation(self.root, self._recordings(), ids, int(k), self.seed.value())
        except Exception as exc:
            self._error(exc)
            return
        summary = "\n".join(f"{a}: {len(r)} recordings" for a, r in assignments.items())
        self.strategy.setCurrentIndex(max(0, self.strategy.findData("manual")))
        self.prompts.inform(self, "Allocation saved", f"Each recording is assigned to {k} annotators.\n\n{summary}")

    # ------------------------------------------------------- reference sets
    def _build_reference_tab(self) -> None:
        w = QWidget()
        v = QVBoxLayout(w)
        self.set_info = QLabel()
        self.set_info.setWordWrap(True)
        v.addWidget(self.set_info)
        opts = QGroupBox("What annotators see")
        ol = QVBoxLayout(opts)
        self.opt_review = self._needs_set(QCheckBox(
            "After each practice recording, offer a side-by-side review of the annotator's work against the reference"))
        self.opt_full_report = self._needs_set(QCheckBox(
            "At the end of the assessment, show the annotator the full competency report (it lists where the "
            "reference's artifacts are, so only for assessment recordings no one else will annotate)"))
        for cb in (self.opt_review, self.opt_full_report):
            cb.toggled.connect(self.save_set_options)
            ol.addWidget(cb)
        arow = QHBoxLayout()
        arow.addWidget(QLabel("Only these annotators may use this set:"))
        self.assigned = self._needs_set(QLineEdit())
        self.assigned.setPlaceholderText("anyone (or IDs separated by commas, e.g. CAM, A03)")
        arow.addWidget(self.assigned, 1)
        save_assigned = self._needs_set(QPushButton("Save"))
        save_assigned.clicked.connect(self.save_assigned)
        arow.addWidget(save_assigned)
        ol.addLayout(arow)
        v.addWidget(opts)
        self.rec_table = QTableWidget(0, 5)
        self.rec_table.setHorizontalHeaderLabels(["Recording", "Used for", "Reference", "Experts", "Annotations"])
        self.rec_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        self.rec_table.horizontalHeader().setStretchLastSection(True)
        self.rec_table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.rec_table.setSelectionMode(QAbstractItemView.SingleSelection)
        self.rec_table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.rec_table.itemSelectionChanged.connect(self._update_buttons)
        v.addWidget(self.rec_table)
        row2 = QHBoxLayout()
        for text, slot, tip in (
            ("Add expert reference…", self.add_expert, "Use one expert's annotation file as the reference"),
            ("Build consensus…", self.add_consensus, "Combine several experts' files for one recording"),
            ("Add adjudicated reference…", self.add_adjudicated, "Use an adjudicator's final annotation file"),
        ):
            b = self._needs_set(QPushButton(text))
            b.setToolTip(tip + ". You will be asked whether it is for practice or for assessment.")
            b.clicked.connect(lambda _=False, slot=slot: slot())
            row2.addWidget(b)
        self.change_use_btn = QPushButton("Change use…")
        self.change_use_btn.setToolTip("Switch the selected recording between practice and assessment")
        self.change_use_btn.clicked.connect(lambda: self.change_use())
        self.remove_btn = QPushButton("Remove selected")
        self.remove_btn.clicked.connect(self.remove_rec)
        row2.addWidget(self.change_use_btn)
        row2.addWidget(self.remove_btn)
        v.addLayout(row2)
        self.tabs.addTab(w, "Reference sets")

    def _sets(self) -> list[ReferenceSet]:
        _, study = self._settings()
        return find_reference_sets(reference_sets_dir(self.root, study))

    def _refresh_sets(self, select: str | None = None) -> None:
        current = select or self.set_combo.currentData()
        self.set_combo.blockSignals(True)
        self.set_combo.clear()
        for rs in self._sets():
            self.set_combo.addItem(f"{rs.set_id} – {rs.name}" if rs.name else rs.set_id, rs.set_id)
        if self.set_combo.count() == 0:
            self.set_combo.addItem("No reference sets yet: create one with New reference set…", None)
        idx = self.set_combo.findData(current) if current else 0
        self.set_combo.setCurrentIndex(max(idx, 0))
        self.set_combo.blockSignals(False)
        self._show_set()

    def current_set(self) -> ReferenceSet | None:
        sid = self.set_combo.currentData()
        if sid is None:
            return None
        return next((rs for rs in self._sets() if rs.set_id == sid), None)

    def _show_set(self, *args: Any) -> None:
        rs = self.current_set()
        self.rec_table.setRowCount(0)
        set_name = (rs.name or rs.set_id) if rs is not None else ""
        self.save_criteria_btn.setText(f"Save criteria for {set_name}" if rs else "Save criteria")
        if rs is None:
            self.set_info.setText("No reference sets yet. Create one with <b>New reference set…</b> above.")
            for cb in (self.opt_review, self.opt_full_report):
                cb.blockSignals(True)
                cb.setChecked(False)
                cb.blockSignals(False)
            self.assigned.setText("")
            self.quiz_table.setRowCount(0)
            self._update_buttons()
            return
        prov = rs.provenance
        muted = style.colour("text_secondary")
        self.set_info.setText(
            f"<b>{html.escape(rs.name or rs.set_id)}</b>{': ' + html.escape(rs.description) if rs.description else ''}<br>"
            f"Declared when created: {html.escape(describe_provenance(prov))} · "
            f"{len(rs.practice_recordings)} practice and {len(rs.assessment_recordings)} assessment recording(s), "
            f"{len(rs.quiz_items)} quiz item(s)<br><span style='color:{muted}'>Folder: {html.escape(str(rs.directory))}</span>"
        )
        self.opt_review.blockSignals(True)
        self.opt_review.setChecked(rs.practice_review)
        self.opt_review.blockSignals(False)
        self.opt_full_report.blockSignals(True)
        self.opt_full_report.setChecked(rs.show_full_report_to_annotator)
        self.opt_full_report.blockSignals(False)
        self.assigned.setText(", ".join(rs.assigned_annotators))
        for rid, e in sorted(rs.recordings.items()):
            r = self.rec_table.rowCount()
            self.rec_table.insertRow(r)
            p = e.get("provenance", {})
            for c, val in enumerate([rid, e.get("use", ""), METHOD_NAMES.get(p.get("method", ""), p.get("method", "")),
                                     ", ".join(p.get("experts", [])), str(e.get("n_annotations", ""))]):
                self.rec_table.setItem(r, c, QTableWidgetItem(val))
        self._load_criteria(rs)
        self._load_quiz(rs)
        self._update_buttons()

    def save_set_options(self, *args: Any) -> None:
        rs = self.current_set()
        if rs is None:
            return
        rs.practice_review = self.opt_review.isChecked()
        rs.show_full_report_to_annotator = self.opt_full_report.isChecked()
        try:
            rs.save()
        except OSError as exc:
            self._error(exc)

    def save_assigned(self) -> None:
        rs = self.current_set()
        if rs is None:
            return
        ids = [x.strip().upper() for x in self.assigned.text().replace(";", ",").split(",") if x.strip()]
        rs.assigned_annotators = ids
        try:
            rs.save()
        except OSError as exc:
            self._error(exc)
            return
        self.prompts.inform(self, "Saved", f"{rs.set_id} can now be used by "
                            + (", ".join(ids) if ids else "any annotator") + ".")

    def new_set(self) -> None:
        sid = self.prompts.ask_text(self, "New reference set", "Identifier (letters, digits, - or _), e.g. pilot:")
        if not sid:
            return
        name = self.prompts.ask_text(self, "New reference set", "Descriptive name, e.g. Pilot training set:") or ""
        names = [METHOD_NAMES[m] for m in METHODS]
        chosen = self.prompts.choose_item(self, "New reference set", "How will most references be established? "
                                          "(Each recording records its own method as it is added.)", names, 0)
        if not chosen:
            return
        method = METHODS[names.index(chosen)]
        experts = self.prompts.ask_text(self, "New reference set", "Expert IDs (comma-separated, e.g. E1, E2):") or ""
        try:
            _, study = self._settings()
            ReferenceSet.create(reference_sets_dir(self.root, study), sid.strip(), name=name.strip(), method=method,
                                experts=[e.strip().upper() for e in experts.split(",") if e.strip()],
                                created_by="administrator")
        except Exception as exc:
            self._error(exc)
            return
        self._refresh_sets(select=sid.strip())
        self.ctrl.start_window.refresh()

    def _pick_files(self, title: str, multi: bool) -> list[Path]:
        start = str(self._layout().root)
        if multi:
            files, _ = QFileDialog.getOpenFileNames(self, title, start, "ElectroClean annotations (*_annotations.json)")
            return [Path(f) for f in files]
        f, _ = QFileDialog.getOpenFileName(self, title, start, "ElectroClean annotations (*_annotations.json)")
        return [Path(f)] if f else []

    def ask_use(self, what: str = "this reference") -> str | None:
        """Practice or assessment, asked every time with no default (a mis-import would break the blinding)."""
        choice = self.prompts.choose(
            self, "Practice or assessment?",
            f"How will {what} be used?\n\n"
            "Practice: annotators see feedback and can review their annotations against the reference.\n\n"
            "Assessment: blinded; annotators see only their overall result at the end.",
            ["Practice", "Assessment", "Cancel"], default=2,
        )
        return {"Practice": "practice", "Assessment": "assessment"}.get(choice)

    def add_expert(self, files: list[Path] | None = None, use: str | None = None) -> None:
        rs = self.current_set()
        if rs is None:
            return
        files = files or self._pick_files("Expert annotation file", False)
        if not files:
            return
        use = use or self.ask_use()
        if use is None:
            return
        try:
            import_expert_reference(rs, files[0], use=use)
        except Exception as exc:
            self._error(exc)
            return
        self._show_set()

    def add_consensus(self, files: list[Path] | None = None, min_agreement: int | None = None,
                      use: str | None = None) -> None:
        from electroclean.app.io.atomic import atomic_write_bytes
        from electroclean.app.io.canonical import read_annotations_json
        from electroclean.training.consensus import build_consensus, disagreements_tsv

        rs = self.current_set()
        if rs is None:
            return
        files = files or self._pick_files("Expert annotation files (choose two or more)", True)
        if len(files) < 2:
            if files:
                self.prompts.error(self, "Consensus", "Choose at least two experts' files for the same recording.")
            return
        use = use or self.ask_use("this consensus reference")
        if use is None:
            return
        try:
            res = build_consensus([read_annotations_json(f) for f in files], min_agreement=min_agreement)
            path = rs.add_reference(res.document, use=use, method="consensus",
                                    experts=res.rule["experts"], source_files=files, details={"consensus_rule": res.rule})
            dis = path.parent.parent / "sources" / (path.stem.replace("_reference_annotations", "") + "_disagreements.tsv")
            atomic_write_bytes(dis, disagreements_tsv(res.disagreements))
        except Exception as exc:
            self._error(exc)
            return
        self._show_set()
        self.prompts.inform(self, "Consensus saved",
                            f"{len(res.document.annotations)} consensus annotations from {len(files)} experts "
                            f"({res.rule['min_agreement']} needed to agree).\n\nDisagreements for adjudication: {dis}")

    def add_adjudicated(self, files: list[Path] | None = None, experts: str | None = None,
                        use: str | None = None) -> None:
        rs = self.current_set()
        if rs is None:
            return
        files = files or self._pick_files("Adjudicator's final annotation file", False)
        if not files:
            return
        experts = experts or self.prompts.ask_text(
            self, "Adjudicated reference", "Experts whose disagreements were adjudicated (comma-separated IDs):")
        if not experts:
            return
        use = use or self.ask_use("this adjudicated reference")
        if use is None:
            return
        try:
            import_adjudicated_reference(rs, files[0], use=use,
                                         experts=[e.strip().upper() for e in experts.split(",") if e.strip()])
        except Exception as exc:
            self._error(exc)
            return
        self._show_set()

    def _selected_recording(self) -> str | None:
        rows = self.rec_table.selectionModel().selectedRows()
        return self.rec_table.item(rows[0].row(), 0).text() if rows else None

    def practised_by(self, rs: ReferenceSet, recording_id: str) -> list[str]:
        """Annotators who have completed ``recording_id`` in practice (and so have seen its reference)."""
        from electroclean.app.session.register import CompletionRegister

        try:
            entries = CompletionRegister(self._layout()).entries()
        except Exception:
            return []
        return sorted({e["annotator_id"] for e in entries if e.get("recording_id") == recording_id
                       and e.get("mode") == "practice" and e.get("context") == rs.set_id})

    def change_use(self, recording_id: str | None = None) -> None:
        rs = self.current_set()
        rid = recording_id or self._selected_recording()
        if rs is None or rid is None or rid not in rs.recordings:
            self.prompts.inform(self, "Change use", "Select a recording in the list first.")
            return
        current = rs.recordings[rid].get("use", "practice")
        new = "assessment" if current == "practice" else "practice"
        warning = ""
        if new == "assessment":
            seen = self.practised_by(rs, rid)
            if seen:
                warning = (f"\n\nWarning: {', '.join(seen)} already annotated this recording in practice and may have "
                           "seen its reference, so the assessment would not be blinded for them.")
        if not self.prompts.ask(self, "Change use", f"Use {rid} for {new} instead of {current}?{warning}",
                                yes=f"Use for {new}", no="Cancel", default_yes=False):
            return
        try:
            rs.set_use(rid, new)
        except Exception as exc:
            self._error(exc)
            return
        self._show_set()
        self.ctrl.start_window.refresh()

    def remove_rec(self) -> None:
        rs = self.current_set()
        rid = self._selected_recording()
        if rs is None or rid is None:
            return
        if self.prompts.ask(self, "Remove reference", f"Remove {rid} from {rs.set_id}?", default_yes=False):
            rs.remove_recording(rid)
            self._show_set()

    # ------------------------------------------------------------- criteria
    def _build_criteria_tab(self) -> None:
        w = QWidget()
        v = QVBoxLayout(w)
        intro = QLabel(
            "Competency criteria are set by the research team for each reference set (chosen above). Leave all "
            "unticked to report results without a pass or fail decision. Hover over a measure for its meaning."
        )
        intro.setWordWrap(True)
        v.addWidget(intro)
        self.crit_rows: dict[str, tuple[QCheckBox, QDoubleSpinBox, QComboBox]] = {}
        grid = QFormLayout()
        for key, meta in METRICS.items():
            cb = QCheckBox(meta["label"])
            cb.setToolTip(meta.get("description", ""))
            sp = QDoubleSpinBox()
            lo, hi = meta.get("range", (0.0, 1000.0))
            sp.setRange(lo, hi)
            sp.setDecimals(3 if hi <= 1 else 2)
            sp.setSingleStep(0.05 if hi <= 1 else 0.5)
            sp.setValue(0.7 if meta["better"] == "higher" else 1.0)
            sp.setToolTip(f"Possible values: {lo:g} to {hi:g}" if hi <= 1 else "Per minute of recording")
            scope = QComboBox()
            scope.addItem("overall", "overall")
            if key not in ("label_accuracy", "false_positives_per_min"):
                scope.addItem("in every assessed category", "each_category")
            row = QHBoxLayout()
            row.addWidget(QLabel("≤" if meta["better"] == "lower" else "≥"))
            row.addWidget(sp)
            row.addWidget(scope)
            grid.addRow(cb, row)
            self.crit_rows[key] = (cb, sp, scope)
        v.addLayout(grid)
        self.min_ref = QSpinBox()
        self.min_ref.setRange(1, 1000)
        self.min_ref.setValue(3)
        row = QHBoxLayout()
        row.addWidget(QLabel("An artifact category is assessed only if the reference has at least"))
        row.addWidget(self.min_ref)
        row.addWidget(QLabel("events of it"))
        row.addStretch(1)
        v.addLayout(row)
        self.save_criteria_btn = self._needs_set(QPushButton("Save criteria"))
        self.save_criteria_btn.clicked.connect(self.save_criteria)
        v.addWidget(self.save_criteria_btn)
        v.addStretch(1)
        self.tabs.addTab(w, "Competency criteria")

    def _load_criteria(self, rs: ReferenceSet) -> None:
        crit = CompetencyCriteria.from_dict(rs.criteria)
        for key, (cb, sp, scope) in self.crit_rows.items():
            cb.setChecked(False)
        for c in crit.criteria:
            cb, sp, scope = self.crit_rows[c.metric]
            cb.setChecked(True)
            sp.setValue(c.threshold)
            scope.setCurrentIndex(max(0, scope.findData(c.scope)))
        self.min_ref.setValue(crit.min_reference_events)

    def criteria_dict(self) -> dict[str, Any]:
        items = [
            {"metric": key, "threshold": sp.value(), "scope": scope.currentData()}
            for key, (cb, sp, scope) in self.crit_rows.items()
            if cb.isChecked()
        ]
        return {"criteria": items, "min_reference_events": self.min_ref.value(), "categories": None}

    def save_criteria(self) -> None:
        rs = self.current_set()
        if rs is None:
            self.prompts.inform(self, "Competency criteria", "Create or choose a reference set first.")
            return
        try:
            rs.set_criteria(self.criteria_dict())
        except Exception as exc:
            self._error(exc)
            return
        self.prompts.inform(self, "Saved", f"Criteria saved for {rs.name or rs.set_id}.")

    # ----------------------------------------------------------------- quiz
    def _build_quiz_tab(self) -> None:
        w = QWidget()
        v = QVBoxLayout(w)
        self.quiz_table = QTableWidget(0, 6)
        self.quiz_table.setHorizontalHeaderLabels(["Item", "Recording", "Start (s)", "End (s)", "Correct answer",
                                                   "Also accepted"])
        self.quiz_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        self.quiz_table.horizontalHeader().setStretchLastSection(True)
        self.quiz_table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.quiz_table.setSelectionMode(QAbstractItemView.SingleSelection)
        self.quiz_table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.quiz_table.itemSelectionChanged.connect(self._update_buttons)
        v.addWidget(self.quiz_table)
        qrow = QHBoxLayout()
        self.remove_quiz_btn = QPushButton("Remove selected item")
        self.remove_quiz_btn.clicked.connect(self.remove_quiz_item)
        self.q_none = self._needs_set(QCheckBox(f"Offer \"{NONE_OPTION}\" as an answer (for clean segments)"))
        self.q_none.toggled.connect(self.save_quiz_options)
        qrow.addWidget(self.remove_quiz_btn)
        qrow.addWidget(self.q_none)
        qrow.addStretch(1)
        v.addLayout(qrow)
        box = QGroupBox("New quiz item")
        form = QFormLayout(box)
        self.q_id = QLineEdit()
        self.q_id.setPlaceholderText("optional, e.g. q01")
        self.q_rec = QComboBox()
        self.q_start = QDoubleSpinBox()
        self.q_end = QDoubleSpinBox()
        for sp in (self.q_start, self.q_end):
            sp.setRange(0, 1e6)
            sp.setDecimals(3)
            sp.setSuffix(" s")
        self.q_context = QDoubleSpinBox()
        self.q_context.setRange(0, 60)
        self.q_context.setValue(2.0)
        self.q_context.setSuffix(" s")
        self.q_context.setToolTip("How much EEG is shown before and after the segment")
        self.q_label = QComboBox()
        fill_label_combo(self.q_label, self.ctrl.catalogue)
        self.q_label.setCurrentIndex(max(0, self.q_label.findData("Eye-blink-artifact")))
        self.q_accept_group = QCheckBox("Also accept the group term (e.g. Eye-artifact for an eye blink)")
        self.q_accept_group.setChecked(True)
        self.q_also = QLineEdit()
        self.q_also.setPlaceholderText("optional: other acceptable answers, separated by commas")
        self.q_expl = QLineEdit()
        self.q_expl.setPlaceholderText("shown after each answer in the practice quiz")
        form.addRow("Item ID", self.q_id)
        form.addRow("Recording", self.q_rec)
        form.addRow("Start", self.q_start)
        form.addRow("End", self.q_end)
        form.addRow("Context shown", self.q_context)
        form.addRow("Correct answer", self.q_label)
        form.addRow("", self.q_accept_group)
        form.addRow("Also accept", self.q_also)
        form.addRow("Explanation", self.q_expl)
        v.addWidget(box)
        add = self._needs_set(QPushButton("Add quiz item"))
        add.clicked.connect(self.add_quiz_item)
        v.addWidget(add)
        self.tabs.addTab(w, "Quiz")

    def _load_quiz(self, rs: ReferenceSet) -> None:
        self.quiz_table.setRowCount(0)
        for it in rs.quiz_items:
            r = self.quiz_table.rowCount()
            self.quiz_table.insertRow(r)
            for c, val in enumerate([it.item_id, it.recording_id, f"{it.start_s:.3f}", f"{it.end_s:.3f}",
                                     it.correct_label, ", ".join(it.accepted_labels)]):
                self.quiz_table.setItem(r, c, QTableWidgetItem(val))
        self.q_none.blockSignals(True)
        self.q_none.setChecked(bool(rs.quiz.get("include_none_option", False)))
        self.q_none.blockSignals(False)
        if self.q_rec.count() == 0:
            try:
                self.q_rec.addItems(self._recordings())
            except OSError:
                pass

    def save_quiz_options(self, *args: Any) -> None:
        rs = self.current_set()
        if rs is None:
            return
        rs.quiz["include_none_option"] = self.q_none.isChecked()
        try:
            rs.save()
        except OSError as exc:
            self._error(exc)

    def quiz_accepted_labels(self, correct: str) -> list[str]:
        """The extra answers accepted for a new quiz item (group terms and those typed in)."""
        cat = self.ctrl.catalogue
        out: list[str] = []
        if self.q_accept_group.isChecked() and cat.is_permitted(correct):
            out.extend(cat.ancestors(correct)[:1])  # the nearest group term only, e.g. Eye-artifact for a blink
        for name in (x.strip() for x in self.q_also.text().split(",")):
            if not name:
                continue
            if not cat.is_permitted(name):
                raise ReferenceSetError(f"{name!r} is not one of the artifact types")
            if name != correct and name not in out:
                out.append(name)
        return out

    def add_quiz_item(self) -> None:
        rs = self.current_set()
        if rs is None:
            self.prompts.inform(self, "Quiz", "Create or choose a reference set first.")
            return
        if not self.q_rec.currentText():
            self.prompts.inform(self, "Quiz", "No recordings were found in the dataset folder.")
            return
        try:
            correct = self.q_label.currentData()
            item = QuizItem(self.q_id.text().strip() or f"q{len(rs.quiz_items) + 1:02d}", self.q_rec.currentText(),
                            self.q_start.value(), self.q_end.value(), correct, self.quiz_accepted_labels(correct),
                            self.q_expl.text(), context_s=self.q_context.value())
            rs.add_quiz_item(item, self.ctrl.catalogue.label_names)
        except Exception as exc:
            self._error(exc)
            return
        self._load_quiz(rs)
        self._update_buttons()
        self.ctrl.start_window.refresh()

    def remove_quiz_item(self) -> None:
        rs = self.current_set()
        rows = self.quiz_table.selectionModel().selectedRows()
        if rs is None or not rows:
            return
        item_id = self.quiz_table.item(rows[0].row(), 0).text()
        if not self.prompts.ask(self, "Remove quiz item", f"Remove quiz item {item_id} from {rs.set_id}?",
                                yes="Remove", no="Cancel", default_yes=False):
            return
        try:
            rs.remove_quiz_item(item_id)
        except Exception as exc:
            self._error(exc)
            return
        self._load_quiz(rs)
        self._update_buttons()
        self.ctrl.start_window.refresh()

    # ------------------------------------------------------------- progress
    def _build_progress_tab(self) -> None:
        w = QWidget()
        v = QVBoxLayout(w)
        row = QHBoxLayout()
        self.p_annotator = QLineEdit()
        self.p_annotator.setPlaceholderText("Annotator ID, e.g. CAM")
        rep = self._needs_set(QPushButton("Generate competency report"))
        rep.clicked.connect(self.generate_report)
        prog = self._needs_set(QPushButton("Show training progress"))
        prog.setToolTip("Practice and assessment recordings completed by the listed annotators and by anyone who "
                        "has used this reference set")
        prog.clicked.connect(self.show_progress)
        fails = QPushButton("Show unresolved load failures")
        fails.clicked.connect(self.show_failures)
        activity = QPushButton("Activity and learning curves…")
        activity.setToolTip("Tables and a report from the interaction logs: time, clicks, keys and how annotators "
                            "got faster (only the annotator typed on the left, if any)")
        activity.clicked.connect(self.show_activity)
        row.addWidget(self.p_annotator)
        row.addWidget(rep)
        row.addWidget(prog)
        row.addWidget(fails)
        row.addWidget(activity)
        v.addLayout(row)
        self.p_text = QTextBrowser()
        v.addWidget(self.p_text)
        self.tabs.addTab(w, "Progress and reports")

    def generate_report(self) -> None:
        rs = self.current_set()
        aid = self.p_annotator.text().strip().upper()
        if rs is None:
            self.prompts.inform(self, "Competency report", "Create or choose a reference set first.")
            return
        if not aid:
            self.prompts.inform(self, "Competency report", "Type the annotator's ID first, for example CAM.")
            return
        try:
            rep = competency_report(self._layout(), rs, aid)
        except Exception as exc:
            self._error(exc)
            return
        self.p_text.setHtml(f"<p><b>{html.escape(aid)}</b> ({html.escape(rs.name or rs.set_id)}): "
                            f"{html.escape(rep['status_text'])}</p>"
                            f"<p>{html.escape(rep.get('paths', {}).get('html', ''))}</p>")
        if "paths" in rep and not self.ctrl.synchronous_loading:
            QDesktopServices.openUrl(QUrl.fromLocalFile(rep["paths"]["html"]))

    def _training_annotators(self, rs: ReferenceSet) -> list[str]:
        """Annotators listed on the Study tab, plus anyone with practice or assessment work in this set."""
        ids = {line.partition(",")[0].strip().upper() for line in self.annotators.toPlainText().splitlines() if line.strip()}
        base = self._layout().root / "training" / rs.set_id
        for mode in ("practice", "assessment"):
            folder = base / mode
            if folder.is_dir():
                ids.update(p.name.removeprefix("annotator-") for p in folder.iterdir()
                           if p.is_dir() and p.name.startswith("annotator-"))
        return sorted(ids)

    def show_progress(self) -> None:
        rs = self.current_set()
        if rs is None:
            self.prompts.inform(self, "Training progress", "Create or choose a reference set first.")
            return
        ids = self._training_annotators(rs)
        if not ids:
            self.p_text.setHtml(f"<p>Nobody has used {html.escape(rs.name or rs.set_id)} yet, and no annotators are "
                                "listed on the Study tab.</p>")
            return
        rows = admin.assessment_progress(self._layout(), rs, ids)
        self.p_text.setHtml(f"<p><b>{html.escape(rs.name or rs.set_id)}</b></p>"
                            "<table border='1' cellpadding='4' cellspacing='0'><tr><th>Annotator</th><th>Practice</th>"
                            "<th>Assessment</th></tr>" + "".join(
                                f"<tr><td>{html.escape(r['annotator_id'])}</td>"
                                f"<td>{r['practice_completed']} of {r['practice_total']}</td>"
                                f"<td>{r['assessment_completed']} of {r['assessment_total']}</td></tr>" for r in rows)
                            + "</table>")

    def show_activity(self) -> None:
        """Write the activity tables and report (electroclean-activity) for this study's results folder."""
        from datetime import datetime

        from electroclean.activity.cli import NoLogsError, summary_text, write_activity

        root = self._layout().root
        aid = self.p_annotator.text().strip().upper()
        out = root / "activity_reports" / datetime.now().strftime("%Y%m%dT%H%M%S")
        try:
            tables, paths = write_activity([root], out, annotators=[aid] if aid else None)
        except NoLogsError as exc:
            self.p_text.setHtml(f"<p>{html.escape(str(exc))}</p>")
            return
        except Exception as exc:
            self._error(exc)
            return
        self.p_text.setHtml("<pre>" + html.escape(summary_text(tables, paths)) + "</pre>")
        if "report" in paths and not self.ctrl.synchronous_loading:
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(paths["report"])))

    def show_failures(self) -> None:
        from electroclean.app.io.discovery import discover_recordings
        from electroclean.app.session.failures import FailureLog

        s, _ = self._settings()
        recs = discover_recordings(self.root, suffixes=s.discovery_suffixes, exclude_dir_names=s.discovery_exclude_dir_names)
        un = FailureLog(self._layout()).unresolved(recs, {})
        if not un:
            self.p_text.setHtml("<p>No unresolved load failures.</p>")
            return
        self.p_text.setHtml("<ul>" + "".join(
            f"<li><b>{html.escape(r)}</b> ({html.escape(e['kind'])}, {html.escape(e['timestamp'])}): {html.escape(e['message'])}</li>"
            for r, e in un.items()) + "</ul><p>Fix the files, change the setting, or use "
            "<code>electroclean-admin resolve-failure</code> to make a recording available again.</p>")
