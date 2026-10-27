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
from electroclean.app.gui.dialogs import UserPrompts
from electroclean.config.settings import SELECTION_STRATEGIES, FilterSettings, load_settings
from electroclean.training import admin
from electroclean.training.assessment import METRICS, CompetencyCriteria, competency_report, feedback_html, practice_feedback
from electroclean.training.quiz import QuizSession
from electroclean.training.reference import (
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
    return AnnotationStore(loaded.info, catalogue, initial=items), prefix


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
    ctrl.prompts.inform(
        ctrl.parent_widget,
        "Assessment complete",
        f"You have completed all assessment recordings in {rs.name or rs.set_id}.\n\n{rep['status_text']}\n\n"
        f"The competency report was saved to:\n{where}",
    )
    if where and rs.quiz.get("show_report_to_annotator", True) and not ctrl.synchronous_loading:
        QDesktopServices.openUrl(QUrl.fromLocalFile(where))


# --------------------------------------------------------------------- quiz
class QuizWindow(QMainWindow):
    """Shows one short EEG segment at a time and asks for the principal artifact type."""

    def __init__(self, ctrl: AppController, quiz: QuizSession) -> None:
        super().__init__()
        self.ctrl = ctrl
        self.quiz = quiz
        self.catalogue = ctrl.catalogue
        self.setWindowTitle(f"ElectroClean quiz – {quiz.reference_set.name or quiz.reference_set.set_id} – {quiz.annotator_id}")
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
        for i, opt in enumerate(quiz.options(self.catalogue.label_names)):
            rb = QRadioButton(opt)
            self.group.addButton(rb, i)
            il.addWidget(rb)
        scroll = QScrollArea()
        scroll.setWidget(inner)
        scroll.setWidgetResizable(True)
        side.addWidget(scroll, 1)
        self.feedback = QLabel()
        self.feedback.setWordWrap(True)
        side.addWidget(self.feedback)
        self.submit = QPushButton("Submit answer")
        self.submit.clicked.connect(self._submit)
        side.addWidget(self.submit)
        sw = QWidget()
        sw.setLayout(side)
        sw.setFixedWidth(330)
        layout.addWidget(sw)
        self.resize(1400, 820)
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
            n_channels=len(seg.ch_names), scalings=self.ctrl.settings.display.scalings,
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
            self.feedback.setText(f"<span style='color:#B71C1C'>This segment could not be shown: {html.escape(str(exc))}</span>")
            return
        self.browser.setParent(self.view_host)
        self.browser.setWindowFlags(Qt.Widget)
        self.view_layout.addWidget(self.browser)
        self.browser.show()
        self.quiz.item_shown()

    def answer(self, label: str) -> bool:
        """Record an answer for the current item (also used by tests)."""
        correct = self.quiz.answer(label)
        item = self.quiz.items[self.quiz.current_index() - 1]
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
        self.answer(btn.text())
        if self.quiz.feedback_immediately:
            self._awaiting_next = True
            self.submit.setText("Next segment")
        else:
            self.show_item()

    def _finish(self) -> None:
        self._done = True
        path = self.quiz.save(self.ctrl.layout)
        s = self.quiz.score()
        self._release()
        self.ctrl.history.append({"event": "quiz_finished", "score": s, "path": str(path)})
        self.ctrl.prompts.inform(
            self, "Quiz complete",
            f"You answered {s['n_correct']} of {s['n_items']} segments correctly "
            f"({100 * s['proportion_correct']:.0f}%).\n\nResults saved to {path}",
        )
        self.close()
        self.ctrl._back_to_start()


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
        if pw is None or not admin.verify_passphrase(pw, record):
            prompts.error(ctrl.parent_widget, "Administrator", "Incorrect passphrase.")
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
        self.setWindowTitle(f"Administrator tools – {dataset_root}")
        self.resize(980, 720)
        layout = QVBoxLayout(self)
        if not admin.read_study_dict(dataset_root).get("admin_passphrase"):
            warn = QLabel("No administrator passphrase is set. Set one on the Study tab so annotators do not open "
                          "these tools by accident.")
            warn.setStyleSheet("QLabel { background:#FFF3CD; padding:6px; }")
            warn.setWordWrap(True)
            layout.addWidget(warn)
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
        return [r.recording_id for r in discover_recordings(self.root, suffix=s.discovery_suffix,
                                                            exclude_dir_names=s.discovery_exclude_dir_names)]

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
        self.strategy.addItems(SELECTION_STRATEGIES)
        self.strategy.setCurrentText(settings.selection_strategy)
        self.seed = QSpinBox()
        self.seed.setRange(0, 2**31 - 1)
        self.seed.setValue(settings.selection_seed or 0)
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
            alloc["strategy"] = self.strategy.currentText()
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
        pw = self.prompts.ask_text(self, "Administrator passphrase", "New passphrase (at least 6 characters):", password=True)
        if not pw:
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
        self.strategy.setCurrentText("manual")
        self.prompts.inform(self, "Allocation saved", f"Each recording is assigned to {k} annotators.\n\n{summary}")

    # ------------------------------------------------------- reference sets
    def _build_reference_tab(self) -> None:
        w = QWidget()
        v = QVBoxLayout(w)
        row = QHBoxLayout()
        self.set_combo = QComboBox()
        self.set_combo.currentIndexChanged.connect(self._show_set)
        new = QPushButton("New reference set…")
        new.clicked.connect(self.new_set)
        row.addWidget(QLabel("Reference set:"))
        row.addWidget(self.set_combo, 1)
        row.addWidget(new)
        v.addLayout(row)
        self.set_info = QLabel()
        self.set_info.setWordWrap(True)
        v.addWidget(self.set_info)
        self.rec_table = QTableWidget(0, 5)
        self.rec_table.setHorizontalHeaderLabels(["Recording", "Use", "Method", "Experts", "Annotations"])
        self.rec_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        self.rec_table.horizontalHeader().setStretchLastSection(True)
        self.rec_table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.rec_table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        v.addWidget(self.rec_table)
        row2 = QHBoxLayout()
        for text, slot in (("Add expert reference…", self.add_expert), ("Build consensus…", self.add_consensus),
                           ("Add adjudicated reference…", self.add_adjudicated), ("Remove selected", self.remove_rec)):
            b = QPushButton(text)
            b.clicked.connect(slot)
            row2.addWidget(b)
        v.addLayout(row2)
        self.use_combo = QComboBox()
        self.use_combo.addItems(["practice", "assessment"])
        row3 = QHBoxLayout()
        row3.addWidget(QLabel("New references are used for:"))
        row3.addWidget(self.use_combo)
        row3.addStretch(1)
        v.addLayout(row3)
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
        idx = self.set_combo.findData(current) if current else 0
        self.set_combo.setCurrentIndex(max(idx, 0))
        self.set_combo.blockSignals(False)
        self._show_set()

    def current_set(self) -> ReferenceSet | None:
        sid = self.set_combo.currentData()
        return next((rs for rs in self._sets() if rs.set_id == sid), None)

    def _show_set(self, *args: Any) -> None:
        rs = self.current_set()
        self.rec_table.setRowCount(0)
        if rs is None:
            self.set_info.setText("No reference sets yet. Create one with 'New reference set…'.")
            return
        prov = rs.provenance
        self.set_info.setText(
            f"<b>{html.escape(rs.name or rs.set_id)}</b>: {html.escape(rs.description)}<br>"
            f"Method: {prov.get('method')} · experts: {', '.join(prov.get('experts', [])) or '–'} · "
            f"{len(rs.practice_recordings)} practice, {len(rs.assessment_recordings)} assessment recording(s), "
            f"{len(rs.quiz_items)} quiz item(s) · folder {html.escape(str(rs.directory))}"
        )
        for rid, e in sorted(rs.recordings.items()):
            r = self.rec_table.rowCount()
            self.rec_table.insertRow(r)
            p = e.get("provenance", {})
            for c, val in enumerate([rid, e.get("use", ""), p.get("method", ""), ", ".join(p.get("experts", [])),
                                     str(e.get("n_annotations", ""))]):
                self.rec_table.setItem(r, c, QTableWidgetItem(val))
        self._load_criteria(rs)
        self._load_quiz(rs)

    def new_set(self) -> None:
        sid = self.prompts.ask_text(self, "New reference set", "Identifier (letters, digits, - or _):")
        if not sid:
            return
        name = self.prompts.ask_text(self, "New reference set", "Descriptive name:") or ""
        method = self.prompts.choose_item(self, "New reference set", "How were the references established?",
                                          ["single_expert", "consensus", "adjudicated"], 0)
        if not method:
            return
        experts = self.prompts.ask_text(self, "New reference set", "Expert IDs (comma-separated):") or ""
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

    def add_expert(self, files: list[Path] | None = None) -> None:
        rs = self.current_set()
        if rs is None:
            return
        files = files or self._pick_files("Expert annotation file", False)
        if not files:
            return
        try:
            import_expert_reference(rs, files[0], use=self.use_combo.currentText())
        except Exception as exc:
            self._error(exc)
            return
        self._show_set()

    def add_consensus(self, files: list[Path] | None = None, min_agreement: int | None = None) -> None:
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
        try:
            res = build_consensus([read_annotations_json(f) for f in files], min_agreement=min_agreement)
            path = rs.add_reference(res.document, use=self.use_combo.currentText(), method="consensus",
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

    def add_adjudicated(self) -> None:
        rs = self.current_set()
        if rs is None:
            return
        files = self._pick_files("Adjudicator's final annotation file", False)
        if not files:
            return
        experts = self.prompts.ask_text(self, "Adjudicated reference", "Experts whose disagreements were adjudicated (comma-separated IDs):")
        if not experts:
            return
        try:
            import_adjudicated_reference(rs, files[0], use=self.use_combo.currentText(),
                                         experts=[e.strip().upper() for e in experts.split(",") if e.strip()])
        except Exception as exc:
            self._error(exc)
            return
        self._show_set()

    def remove_rec(self) -> None:
        rs = self.current_set()
        rows = sorted({i.row() for i in self.rec_table.selectedIndexes()})
        if rs is None or not rows:
            return
        rid = self.rec_table.item(rows[0], 0).text()
        if self.prompts.ask(self, "Remove reference", f"Remove {rid} from {rs.set_id}?", default_yes=False):
            rs.remove_recording(rid)
            self._show_set()

    # ------------------------------------------------------------- criteria
    def _build_criteria_tab(self) -> None:
        w = QWidget()
        v = QVBoxLayout(w)
        v.addWidget(QLabel(
            "Competency criteria are set by the research team for each reference set. Leave all unticked to report "
            "results without a pass/fail decision."
        ))
        self.crit_rows: dict[str, tuple[QCheckBox, QDoubleSpinBox, QComboBox]] = {}
        grid = QFormLayout()
        for key, meta in METRICS.items():
            cb = QCheckBox(meta["label"])
            sp = QDoubleSpinBox()
            sp.setRange(0, 1000)
            sp.setDecimals(3)
            sp.setSingleStep(0.05)
            sp.setValue(0.7 if meta["better"] == "higher" else 1.0)
            scope = QComboBox()
            scope.addItem("overall", "overall")
            if key not in ("label_accuracy", "false_positives_per_min"):
                scope.addItem("in every category", "each_category")
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
        row.addWidget(QLabel("Judge a category only if the reference has at least"))
        row.addWidget(self.min_ref)
        row.addWidget(QLabel("events in it"))
        row.addStretch(1)
        v.addLayout(row)
        save = QPushButton("Save criteria for this reference set")
        save.clicked.connect(self.save_criteria)
        v.addWidget(save)
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
            return
        try:
            rs.set_criteria(self.criteria_dict())
        except Exception as exc:
            self._error(exc)
            return
        self.prompts.inform(self, "Saved", f"Criteria saved for {rs.set_id}.")

    # ----------------------------------------------------------------- quiz
    def _build_quiz_tab(self) -> None:
        w = QWidget()
        v = QVBoxLayout(w)
        self.quiz_table = QTableWidget(0, 5)
        self.quiz_table.setHorizontalHeaderLabels(["Item", "Recording", "Start (s)", "End (s)", "Correct label"])
        self.quiz_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        self.quiz_table.horizontalHeader().setStretchLastSection(True)
        v.addWidget(self.quiz_table)
        form = QFormLayout()
        self.q_id = QLineEdit()
        self.q_rec = QComboBox()
        self.q_start = QDoubleSpinBox()
        self.q_end = QDoubleSpinBox()
        for sp in (self.q_start, self.q_end):
            sp.setRange(0, 1e6)
            sp.setDecimals(3)
        self.q_label = QComboBox()
        self.q_label.addItems(list(self.ctrl.catalogue.label_names))
        self.q_expl = QLineEdit()
        form.addRow("Item ID", self.q_id)
        form.addRow("Recording", self.q_rec)
        form.addRow("Start", self.q_start)
        form.addRow("End", self.q_end)
        form.addRow("Correct label", self.q_label)
        form.addRow("Explanation (shown in practice)", self.q_expl)
        v.addLayout(form)
        add = QPushButton("Add quiz item")
        add.clicked.connect(self.add_quiz_item)
        v.addWidget(add)
        self.tabs.addTab(w, "Quiz")

    def _load_quiz(self, rs: ReferenceSet) -> None:
        self.quiz_table.setRowCount(0)
        for it in rs.quiz_items:
            r = self.quiz_table.rowCount()
            self.quiz_table.insertRow(r)
            for c, val in enumerate([it.item_id, it.recording_id, f"{it.start_s:.3f}", f"{it.end_s:.3f}", it.correct_label]):
                self.quiz_table.setItem(r, c, QTableWidgetItem(val))
        if self.q_rec.count() == 0:
            try:
                self.q_rec.addItems(self._recordings())
            except OSError:
                pass

    def add_quiz_item(self) -> None:
        rs = self.current_set()
        if rs is None:
            return
        try:
            item = QuizItem(self.q_id.text().strip() or f"q{len(rs.quiz_items) + 1:02d}", self.q_rec.currentText(),
                            self.q_start.value(), self.q_end.value(), self.q_label.currentText(), [], self.q_expl.text())
            rs.add_quiz_item(item, self.ctrl.catalogue.label_names)
        except Exception as exc:
            self._error(exc)
            return
        self._load_quiz(rs)
        self.ctrl.start_window.refresh()

    # ------------------------------------------------------------- progress
    def _build_progress_tab(self) -> None:
        w = QWidget()
        v = QVBoxLayout(w)
        row = QHBoxLayout()
        self.p_annotator = QLineEdit()
        self.p_annotator.setPlaceholderText("Annotator ID")
        rep = QPushButton("Generate competency report")
        rep.clicked.connect(self.generate_report)
        prog = QPushButton("Show progress of listed annotators")
        prog.clicked.connect(self.show_progress)
        fails = QPushButton("Show unresolved load failures")
        fails.clicked.connect(self.show_failures)
        row.addWidget(self.p_annotator)
        row.addWidget(rep)
        row.addWidget(prog)
        row.addWidget(fails)
        v.addLayout(row)
        self.p_text = QTextBrowser()
        v.addWidget(self.p_text)
        self.tabs.addTab(w, "Progress and reports")

    def generate_report(self) -> None:
        rs = self.current_set()
        aid = self.p_annotator.text().strip().upper()
        if rs is None or not aid:
            return
        try:
            rep = competency_report(self._layout(), rs, aid)
        except Exception as exc:
            self._error(exc)
            return
        self.p_text.setHtml(f"<p><b>{html.escape(aid)}</b>: {html.escape(rep['status_text'])}</p>"
                            f"<p>{html.escape(rep.get('paths', {}).get('html', ''))}</p>")
        if "paths" in rep and not self.ctrl.synchronous_loading:
            QDesktopServices.openUrl(QUrl.fromLocalFile(rep["paths"]["html"]))

    def show_progress(self) -> None:
        rs = self.current_set()
        if rs is None:
            return
        ids = [line.partition(",")[0].strip() for line in self.annotators.toPlainText().splitlines() if line.strip()]
        rows = admin.assessment_progress(self._layout(), rs, ids)
        self.p_text.setHtml("<table border='1' cellpadding='4' cellspacing='0'><tr><th>Annotator</th><th>Practice</th>"
                            "<th>Assessment</th></tr>" + "".join(
                                f"<tr><td>{r['annotator_id']}</td><td>{r['practice_completed']}/{r['practice_total']}</td>"
                                f"<td>{r['assessment_completed']}/{r['assessment_total']}</td></tr>" for r in rows) + "</table>")

    def show_failures(self) -> None:
        from electroclean.app.io.discovery import discover_recordings
        from electroclean.app.session.failures import FailureLog

        s, _ = self._settings()
        recs = discover_recordings(self.root, suffix=s.discovery_suffix, exclude_dir_names=s.discovery_exclude_dir_names)
        un = FailureLog(self._layout()).unresolved(recs, {})
        if not un:
            self.p_text.setHtml("<p>No unresolved load failures.</p>")
            return
        self.p_text.setHtml("<ul>" + "".join(
            f"<li><b>{html.escape(r)}</b> ({html.escape(e['kind'])}, {html.escape(e['timestamp'])}): {html.escape(e['message'])}</li>"
            for r, e in un.items()) + "</ul><p>Fix the files, change the setting, or use "
            "<code>electroclean-admin resolve-failure</code> to make a recording available again.</p>")
