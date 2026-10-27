"""The introductory window: who is annotating, which data, which mode."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from qtpy.QtCore import QSettings, Qt, Signal
from qtpy.QtGui import QAction
from qtpy.QtWidgets import (
    QButtonGroup,
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QPushButton,
    QRadioButton,
    QVBoxLayout,
    QWidget,
)

from electroclean import __version__
from electroclean.app.common import IdentifierError, normalise_annotator_id
from electroclean.app.gui import style
from electroclean.config.settings import SettingsError, StudyConfig, load_settings


#: What annotators are told when the study records how they use ElectroClean (logging.interactions).
LOGGING_NOTICE = ("This study records how you use ElectroClean (times, clicks, keys and what is on screen) for "
                  "research. Ask your study administrator if you have questions.")


@dataclass
class StartRequest:
    annotator_id: str
    display_name: str
    dataset_root: Path
    output_root: Path | None
    mode: str  # standard / practice / assessment
    reference_set_id: str = ""
    assessment_kind: str = "continuous"  # or "quiz"
    choose_recording: bool = False
    # The training programme (guided learning, then practice, then the assessment) rather than one mode.
    programme: bool = False


def app_settings() -> QSettings:
    return QSettings("ElectroClean", "ElectroClean")


class StartWindow(QMainWindow):
    """Collects the annotator identity, dataset folder and mode."""

    beginRequested = Signal(object)  # StartRequest
    adminRequested = Signal(object)  # dataset root (Path) or None
    agreementRequested = Signal(object)  # output root (Path) or None
    closedByUser = Signal()

    def __init__(self) -> None:
        super().__init__()
        style.apply_theme()
        self.setWindowTitle(f"ElectroClean {__version__}")
        self.study: StudyConfig | None = None
        self._output_override: Path | None = None
        self._reference_sets: list[tuple[str, str, bool]] = []  # (id, name, has_quiz)
        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.setSpacing(14)

        layout.addWidget(style.label("ElectroClean", "title"))
        layout.addWidget(style.label("Mark artifacts in continuous EEG recordings.", "subtitle"))
        layout.addSpacing(4)

        # Who is annotating
        who, wl = style.card()
        wl.addWidget(style.label("Who is annotating?", "heading"))
        wf = QFormLayout()
        wf.setLabelAlignment(Qt.AlignLeft | Qt.AlignVCenter)
        wf.setHorizontalSpacing(16)
        wf.setVerticalSpacing(8)
        self.annotator = QComboBox()
        self.annotator.setEditable(True)
        self.annotator.setInsertPolicy(QComboBox.NoInsert)
        self.annotator.lineEdit().setPlaceholderText("type or choose your ID, e.g. A01")
        self.annotator.setToolTip("Letters and digits only. This identifier appears in every output file name.")
        self.display_name = QLineEdit()
        self.display_name.setPlaceholderText("optional, e.g. your initials")
        self.id_hint = style.label("", "error")
        wf.addRow("Annotator ID", self.annotator)
        wf.addRow("", self.id_hint)
        wf.setRowVisible(self.id_hint, False)
        self._identity_form = wf
        wf.addRow("Name", self.display_name)
        wl.addLayout(wf)
        layout.addWidget(who)

        # Which recordings
        data, dl = style.card()
        dl.addWidget(style.label("Recordings", "heading"))
        row = QHBoxLayout()
        row.setSpacing(8)
        self.dataset = QLineEdit()
        self.dataset.setPlaceholderText("Folder with the recordings (*_eeg.vhdr, *_eeg.edf or *_eeg.bdf)")
        browse = QPushButton("Browse…")
        browse.clicked.connect(self._browse_dataset)
        row.addWidget(self.dataset, 1)
        row.addWidget(browse)
        dl.addLayout(row)
        self.progress_label = QLabel("–")
        self.progress_label.setWordWrap(True)
        dl.addWidget(self.progress_label)
        orow = QHBoxLayout()
        orow.setSpacing(6)
        orow.addWidget(style.label("Results are saved in", "caption"))
        self.output_label = style.label("–", "caption")
        self.output_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.output_label.setMinimumWidth(120)
        orow.addWidget(self.output_label, 1)
        out_btn = style.set_kind(QPushButton("Change…"), "quiet")
        out_btn.clicked.connect(self._browse_output)
        orow.addWidget(out_btn)
        dl.addLayout(orow)
        self.study_label = style.label("–", "caption", wrap=True)
        dl.addWidget(self.study_label)
        # Shown when the study records interaction logs (logging.interactions).
        self.logging_note = style.label(LOGGING_NOTICE, "caption", wrap=True)
        self.logging_note.setVisible(False)
        dl.addWidget(self.logging_note)
        layout.addWidget(data)

        # What to do
        mode, ml = style.card(spacing=6)
        ml.addWidget(style.label("What would you like to do?", "heading"))
        self.mode_standard = QRadioButton("Annotate recordings")
        self.mode_practice = QRadioButton("Training programme")
        self.mode_assessment = QRadioButton("Competency assessment")
        explanations = {
            self.mode_standard: "Mark the artifacts in recordings for the study.",
            self.mode_practice: "Learn with the experts step by step, then practise on your own and see your score. "
            "Ends with the competency assessment.",
            self.mode_assessment: "Annotate without feedback; you see your result when every recording is done.",
        }
        g = QButtonGroup(self)
        for rb, text in explanations.items():
            g.addButton(rb)
            ml.addWidget(rb)
            hint = style.label(text, "caption", wrap=True)
            hint.setContentsMargins(26, 0, 0, 4)
            ml.addWidget(hint)
        self.mode_standard.setChecked(True)
        # Shown only for practice and assessment.
        self.training_box = QWidget()
        tf = QFormLayout(self.training_box)
        tf.setContentsMargins(26, 4, 0, 0)
        tf.setLabelAlignment(Qt.AlignLeft | Qt.AlignVCenter)
        tf.setHorizontalSpacing(16)
        self.reference_combo = QComboBox()
        tf.addRow("Reference set", self.reference_combo)
        ak = QHBoxLayout()
        ak.setSpacing(16)
        self.assess_continuous = QRadioButton("Recordings")
        self.assess_quiz = QRadioButton("Short-segment quiz")
        g2 = QButtonGroup(self)
        g2.addButton(self.assess_continuous)
        g2.addButton(self.assess_quiz)
        self.assess_continuous.setChecked(True)
        ak.addWidget(self.assess_continuous)
        ak.addWidget(self.assess_quiz)
        ak.addStretch(1)
        tf.addRow("Activity", ak)
        ml.addWidget(self.training_box)
        self.choose_recording = QCheckBox("Let me choose the recording (otherwise one is picked for me)")
        ml.addSpacing(4)
        ml.addWidget(self.choose_recording)
        layout.addWidget(mode)
        layout.addStretch(1)

        buttons = QHBoxLayout()
        buttons.setSpacing(8)
        self.begin_btn = QPushButton("Begin")
        self.begin_btn.setDefault(True)
        style.set_kind(self.begin_btn, "primary")
        self.begin_btn.setMinimumWidth(120)
        quit_btn = QPushButton("Quit")
        quit_btn.clicked.connect(self.close)
        buttons.addStretch(1)
        buttons.addWidget(quit_btn)
        buttons.addWidget(self.begin_btn)
        layout.addLayout(buttons)

        menu = self.menuBar().addMenu("&Tools")
        act_agree = QAction("Inter-rater agreement analysis…", self)
        act_agree.triggered.connect(lambda: self.agreementRequested.emit(self.output_root()))
        menu.addAction(act_agree)
        act_admin = QAction("Administrator tools…", self)
        act_admin.triggered.connect(lambda: self.adminRequested.emit(self.dataset_root()))
        menu.addAction(act_admin)

        self.begin_btn.clicked.connect(self._begin)
        self.dataset.editingFinished.connect(self.refresh)
        self.annotator.currentTextChanged.connect(self._annotator_changed)
        for rb in (self.mode_standard, self.mode_practice, self.mode_assessment, self.assess_continuous, self.assess_quiz):
            rb.toggled.connect(self._update_mode_widgets)
        self.reference_combo.currentIndexChanged.connect(self._update_mode_widgets)
        self._restore()
        self._update_mode_widgets()
        self.resize(620, 720)

    # ------------------------------------------------------------- settings

    def closeEvent(self, event) -> None:  # noqa: ANN001, N802 - Qt API
        # The application stays open while annotation windows replace this one (it is only
        # hidden then); closing it here is the user's way of leaving ElectroClean.
        super().closeEvent(event)
        if event.isAccepted():
            self.closedByUser.emit()
    def _restore(self) -> None:
        # The folder is restored. The last annotator ID is offered in the list but not filled in,
        # so that on a shared computer nobody saves work under the previous person's ID by mistake.
        s = app_settings()
        self.dataset.setText(str(s.value("dataset", "")))
        self._last_annotator = str(s.value("annotator", ""))
        self._last_display_name = str(s.value("display_name", ""))
        self._offer_last_annotator()
        if self.dataset.text():
            self.refresh()
        blocked = self.annotator.blockSignals(True)
        self.annotator.setEditText("")
        self.annotator.blockSignals(blocked)
        self._update_progress()

    def _offer_last_annotator(self) -> None:
        last = getattr(self, "_last_annotator", "")
        if last and self.annotator.findData(last) < 0:
            blocked = self.annotator.blockSignals(True)
            self.annotator.addItem(f"{last} (used last on this computer)", last)
            self.annotator.blockSignals(blocked)

    def _save(self, req: StartRequest) -> None:
        s = app_settings()
        s.setValue("dataset", str(req.dataset_root))
        s.setValue("annotator", req.annotator_id)
        s.setValue("display_name", req.display_name)

    # ---------------------------------------------------------------- paths
    def dataset_root(self) -> Path | None:
        text = self.dataset.text().strip()
        return Path(text) if text else None

    def output_root(self) -> Path | None:
        root = self.dataset_root()
        if self._output_override is not None:
            return self._output_override
        if root is None:
            return None
        try:
            settings, _ = load_settings(root)
        except (SettingsError, OSError):
            return root / "Annotated_Events"
        if settings.output_directory:
            p = Path(settings.output_directory)
            return p if p.is_absolute() else root / p
        return root / settings.output_directory_name

    def _browse_dataset(self) -> None:
        start = self.dataset.text() or str(Path.home())
        chosen = QFileDialog.getExistingDirectory(self, "Choose the dataset folder", start)
        if chosen:
            self.dataset.setText(chosen)
            self.refresh()

    def _browse_output(self) -> None:
        start = str(self.output_root() or Path.home())
        chosen = QFileDialog.getExistingDirectory(self, "Choose where results are saved", start)
        if chosen:
            self._output_override = Path(chosen)
            self.refresh()

    # ------------------------------------------------------------- refresh
    def refresh(self) -> None:
        """Re-read the study configuration and progress for the chosen folder."""
        from electroclean.app.io.discovery import discover_recordings

        root = self.dataset_root()
        self.study = None
        self.logging_note.setVisible(False)
        self._reference_sets = []
        self._recording_ids = None
        self._out = None
        if root is None or not root.is_dir():
            self.study_label.setText("–")
            self.progress_label.setText(
                "Choose a dataset folder" if root is None
                else f"<span style='color:{style.colour('destructive')}'>Folder not found. Check the path or use Browse…</span>"
            )
            self.output_label.setText("–")
            self._fill_reference_sets()
            self._update_begin()
            return
        try:
            settings, study = load_settings(root)
        except (SettingsError, OSError) as exc:
            self.study_label.setText(f"<span style='color:{style.colour('destructive')}'>Study configuration problem: {exc}</span>")
            self._update_begin()
            return
        self.study = study
        self.logging_note.setVisible(bool(settings.logging_interactions))
        if study is None:
            self.study_label.setText("Default settings (this folder has no study configuration)")
        else:
            locked = " · filters fixed by administrator" if settings.filters.locked else ""
            self.study_label.setText(
                f"Study <b>{study.study_id or '(unnamed)'}</b> · selection: {settings.selection_strategy}{locked}"
            )
            current = self.annotator.currentText()
            self.annotator.blockSignals(True)
            self.annotator.clear()
            for a in study.annotators:
                self.annotator.addItem(a.annotator_id + (f" – {a.display_name}" if a.display_name else ""), a.annotator_id)
            self._offer_last_annotator()
            self.annotator.setEditText(current)
            self.annotator.blockSignals(False)
        out = self.output_root()
        self._out = out
        full = str(out)
        metrics = self.output_label.fontMetrics()
        self.output_label.setText(metrics.elidedText(full, Qt.ElideMiddle, 420))
        self.output_label.setToolTip(full)
        try:
            recs = discover_recordings(
                root,
                suffixes=settings.discovery_suffixes,
                exclude_dir_names=settings.discovery_exclude_dir_names,
                follow_symlinks=settings.discovery_follow_symlinks,
            )
        except OSError as exc:
            self.progress_label.setText(f"Cannot read folder: {exc}")
            self._update_begin()
            return
        self._recording_ids = {r.recording_id for r in recs}
        self._update_progress()
        try:
            from electroclean.training.reference import find_reference_sets, reference_sets_dir

            for rs in find_reference_sets(reference_sets_dir(root, study)):
                self._reference_sets.append((rs.set_id, rs.name, bool(rs.quiz_items)))
        except Exception as exc:  # training is optional
            self.study_label.setText(self.study_label.text() + f"<br><small>Reference sets unavailable: {exc}</small>")
        self._fill_reference_sets()

    def _update_progress(self) -> None:
        """The progress line for the chosen folder and the annotator ID typed (cheap: reads the register)."""
        from electroclean.app.io.naming import OutputLayout
        from electroclean.app.session.register import CompletionRegister

        ids = getattr(self, "_recording_ids", None)
        if ids is None:
            self._update_begin()
            return
        if not ids:
            self.progress_label.setText(
                f"<span style='color:{style.colour('destructive')}'>No recordings found.</span> ElectroClean looks in "
                "this folder and its "
                "sub-folders for files whose names end in _eeg.vhdr, _eeg.edf or _eeg.bdf."
            )
            self.progress_label.setWordWrap(True)
            self._update_begin()
            return
        text = f"{len(ids)} recording(s) found"
        try:
            aid = normalise_annotator_id(self._annotator_text())
            done = CompletionRegister(OutputLayout(self._out)).completed(aid) if self._out else set()
            done &= ids
            text += f" · {len(done)} completed by {aid} · {len(ids) - len(done)} remaining"
        except Exception:
            pass
        self.progress_label.setText(text)
        self._update_begin()

    def _update_begin(self) -> None:
        ids = getattr(self, "_recording_ids", None)
        if hasattr(self, "begin_btn"):
            # Training can run from a reference set that brings its own recordings.
            training = (getattr(self, "mode_practice", None) is not None
                        and (self.mode_practice.isChecked() or self.mode_assessment.isChecked())
                        and bool(getattr(self, "_reference_sets", [])))
            ok = bool(ids) or training
            self.begin_btn.setEnabled(ok)
            self.begin_btn.setToolTip("" if ok else "Choose a folder that contains recordings first")

    def _fill_reference_sets(self) -> None:
        self.reference_combo.blockSignals(True)
        self.reference_combo.clear()
        for set_id, name, _quiz in self._reference_sets:
            self.reference_combo.addItem(f"{name} ({set_id})" if name else set_id, set_id)
        if not self._reference_sets:
            self.reference_combo.addItem("No reference sets available", "")
        self.reference_combo.blockSignals(False)
        self._update_mode_widgets()

    def _annotator_text(self) -> str:
        idx = self.annotator.currentIndex()
        text = self.annotator.currentText().strip()
        data = self.annotator.itemData(idx) if idx >= 0 else None
        if data and self.annotator.itemText(idx) == text:
            return str(data)
        return text.split(" – ")[0].strip()

    def _annotator_changed(self, _text: str) -> None:
        aid_typed = self._annotator_text()
        last = getattr(self, "_last_annotator", "")
        if last and aid_typed.upper() == last.upper() and not self.display_name.text():
            self.display_name.setText(getattr(self, "_last_display_name", ""))
        self._update_progress()
        if self.study is not None:
            aid = self._annotator_text()
            for a in self.study.annotators:
                if a.annotator_id.upper() == aid.upper() and a.display_name and not self.display_name.text():
                    self.display_name.setText(a.display_name)
        try:
            normalise_annotator_id(self._annotator_text())
            hint = ""
        except IdentifierError:
            hint = "Use letters and digits only (e.g. A01)" if self._annotator_text() else ""
        self.id_hint.setText(hint)
        self._identity_form.setRowVisible(self.id_hint, bool(hint))  # no empty gap when all is well

    def _update_mode_widgets(self, *args: object) -> None:
        # Practice and assessment can each be done on continuous recordings or as the short-segment quiz.
        training = self.mode_practice.isChecked() or self.mode_assessment.isChecked()
        self.reference_combo.setEnabled(training and bool(self._reference_sets))
        has_quiz = any(q for sid, _n, q in self._reference_sets if sid == self.reference_combo.currentData())
        self.training_box.setVisible(training)  # options appear when they apply
        self.assess_continuous.setEnabled(training)
        self.assess_quiz.setEnabled(training and has_quiz)
        if not has_quiz or not training:
            self.assess_continuous.setChecked(True)
        self.choose_recording.setEnabled(self.mode_standard.isChecked())
        self.choose_recording.setVisible(self.choose_recording.isEnabled())
        self._update_begin()

    # ---------------------------------------------------------------- begin
    def build_request(self) -> StartRequest:
        aid = normalise_annotator_id(self._annotator_text())
        root = self.dataset_root()
        if root is None or not root.is_dir():
            raise ValueError("Please choose the folder that contains the EEG recordings.")
        if self.study is not None and not self.study.allow_unlisted_annotators:
            allowed = {a.annotator_id.upper() for a in self.study.annotators}
            if aid not in allowed:
                raise ValueError(f"Annotator {aid} is not listed for this study. Please check your ID.")
        mode = "standard"
        if self.mode_practice.isChecked():
            mode = "practice"
        elif self.mode_assessment.isChecked():
            mode = "assessment"
        ref = str(self.reference_combo.currentData() or "")
        if mode != "standard" and not ref:
            raise ValueError("Training and assessment need a reference set. Ask the study administrator to prepare one.")
        return StartRequest(
            annotator_id=aid,
            display_name=self.display_name.text().strip(),
            dataset_root=root,
            output_root=self._output_override,
            mode=mode,
            reference_set_id=ref,
            assessment_kind="quiz" if (mode != "standard" and self.assess_quiz.isChecked()) else "continuous",
            choose_recording=self.choose_recording.isChecked() and mode == "standard",
            programme=mode == "practice" and not self.assess_quiz.isChecked(),
        )

    def _begin(self) -> None:
        from electroclean.app.gui.dialogs import UserPrompts

        try:
            req = self.build_request()
        except (IdentifierError, ValueError) as exc:
            (getattr(self, "prompts", None) or UserPrompts()).error(self, "Cannot start", str(exc))
            return
        self._save(req)
        self.beginRequested.emit(req)
