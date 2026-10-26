"""The introductory window: who is annotating, which data, which mode."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from qtpy.QtCore import QSettings, Qt, Signal
from qtpy.QtGui import QAction, QFont
from qtpy.QtWidgets import (
    QButtonGroup,
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
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
from electroclean.config.settings import SettingsError, StudyConfig, load_settings


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


def app_settings() -> QSettings:
    return QSettings("ElectroClean", "ElectroClean")


class StartWindow(QMainWindow):
    """Collects the annotator identity, dataset folder and mode."""

    beginRequested = Signal(object)  # StartRequest
    adminRequested = Signal(object)  # dataset root (Path) or None
    agreementRequested = Signal(object)  # output root (Path) or None

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle(f"ElectroClean {__version__}")
        self.study: StudyConfig | None = None
        self._output_override: Path | None = None
        self._reference_sets: list[tuple[str, str, bool]] = []  # (id, name, has_quiz)
        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)

        title = QLabel("ElectroClean")
        f = QFont()
        f.setPointSize(18)
        f.setBold(True)
        title.setFont(f)
        layout.addWidget(title)
        layout.addWidget(QLabel("Manual annotation of artifacts in continuous EEG recordings"))

        who = QGroupBox("Annotator")
        wf = QFormLayout(who)
        self.annotator = QComboBox()
        self.annotator.setEditable(True)
        self.annotator.setInsertPolicy(QComboBox.NoInsert)
        self.annotator.lineEdit().setPlaceholderText("e.g. A01")
        self.annotator.setToolTip("Letters and digits only. This identifier appears in every output file name.")
        self.display_name = QLineEdit()
        self.display_name.setPlaceholderText("optional, e.g. your initials or name")
        self.id_hint = QLabel()
        self.id_hint.setStyleSheet("QLabel { color: #B71C1C; }")
        wf.addRow("Annotator ID", self.annotator)
        wf.addRow("", self.id_hint)
        wf.addRow("Display name", self.display_name)
        layout.addWidget(who)

        data = QGroupBox("Recordings")
        df = QFormLayout(data)
        row = QHBoxLayout()
        self.dataset = QLineEdit()
        self.dataset.setPlaceholderText("Folder containing the BrainVision (*_eeg.vhdr) recordings")
        browse = QPushButton("Browse…")
        browse.clicked.connect(self._browse_dataset)
        row.addWidget(self.dataset)
        row.addWidget(browse)
        df.addRow("Dataset folder", row)
        orow = QHBoxLayout()
        self.output_label = QLabel("–")
        self.output_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        out_btn = QPushButton("Change…")
        out_btn.clicked.connect(self._browse_output)
        orow.addWidget(self.output_label, 1)
        orow.addWidget(out_btn)
        df.addRow("Results folder", orow)
        self.study_label = QLabel("–")
        self.study_label.setWordWrap(True)
        df.addRow("Study settings", self.study_label)
        self.progress_label = QLabel("–")
        df.addRow("Progress", self.progress_label)
        layout.addWidget(data)

        mode = QGroupBox("What would you like to do?")
        ml = QVBoxLayout(mode)
        self.mode_standard = QRadioButton("Standard annotation")
        self.mode_practice = QRadioButton("Training: practise with feedback")
        self.mode_assessment = QRadioButton("Competency assessment")
        g = QButtonGroup(self)
        for rb in (self.mode_standard, self.mode_practice, self.mode_assessment):
            g.addButton(rb)
            ml.addWidget(rb)
        self.mode_standard.setChecked(True)
        rs = QHBoxLayout()
        rs.addWidget(QLabel("Reference set:"))
        self.reference_combo = QComboBox()
        rs.addWidget(self.reference_combo, 1)
        ml.addLayout(rs)
        ak = QHBoxLayout()
        ak.addWidget(QLabel("Assessment type:"))
        self.assess_continuous = QRadioButton("Annotate continuous recordings")
        self.assess_quiz = QRadioButton("Short segments quiz")
        g2 = QButtonGroup(self)
        g2.addButton(self.assess_continuous)
        g2.addButton(self.assess_quiz)
        self.assess_continuous.setChecked(True)
        ak.addWidget(self.assess_continuous)
        ak.addWidget(self.assess_quiz)
        ak.addStretch(1)
        ml.addLayout(ak)
        self.choose_recording = QCheckBox("Let me choose the recording (otherwise one is picked for me)")
        ml.addWidget(self.choose_recording)
        layout.addWidget(mode)

        buttons = QHBoxLayout()
        self.begin_btn = QPushButton("Begin new session")
        self.begin_btn.setDefault(True)
        self.begin_btn.setStyleSheet("QPushButton { font-weight: bold; padding: 6px 16px; }")
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
        self.resize(640, 640)

    # ------------------------------------------------------------- settings
    def _restore(self) -> None:
        s = app_settings()
        self.dataset.setText(str(s.value("dataset", "")))
        last = str(s.value("annotator", ""))
        if last:
            self.annotator.setEditText(last)
        self.display_name.setText(str(s.value("display_name", "")))
        if self.dataset.text():
            self.refresh()

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
        from electroclean.app.io.naming import OutputLayout
        from electroclean.app.session.register import CompletionRegister

        root = self.dataset_root()
        self.study = None
        self._reference_sets = []
        if root is None or not root.is_dir():
            self.study_label.setText("Choose a dataset folder")
            self.progress_label.setText("–")
            self.output_label.setText("–")
            self._fill_reference_sets()
            return
        try:
            settings, study = load_settings(root)
        except (SettingsError, OSError) as exc:
            self.study_label.setText(f"<span style='color:#B71C1C'>Study configuration problem: {exc}</span>")
            return
        self.study = study
        if study is None:
            self.study_label.setText("Default settings (no electroclean_study.json in this folder)")
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
            self.annotator.setEditText(current)
            self.annotator.blockSignals(False)
        out = self.output_root()
        self.output_label.setText(str(out))
        try:
            recs = discover_recordings(
                root,
                suffix=settings.discovery_suffix,
                exclude_dir_names=settings.discovery_exclude_dir_names,
                follow_symlinks=settings.discovery_follow_symlinks,
            )
        except OSError as exc:
            self.progress_label.setText(f"Cannot read folder: {exc}")
            return
        text = f"{len(recs)} recording(s) found"
        try:
            aid = normalise_annotator_id(self._annotator_text())
            done = CompletionRegister(OutputLayout(out)).completed(aid) if out else set()
            done &= {r.recording_id for r in recs}
            text += f" · {len(done)} completed by {aid} · {len(recs) - len(done)} remaining"
        except Exception:
            pass
        self.progress_label.setText(text)
        try:
            from electroclean.training.reference import find_reference_sets, reference_sets_dir

            for rs in find_reference_sets(reference_sets_dir(root, study)):
                self._reference_sets.append((rs.set_id, rs.name, bool(rs.quiz_items)))
        except Exception as exc:  # training is optional
            self.study_label.setText(self.study_label.text() + f"<br><small>Reference sets unavailable: {exc}</small>")
        self._fill_reference_sets()

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
        if self.study is not None:
            aid = self._annotator_text()
            for a in self.study.annotators:
                if a.annotator_id.upper() == aid.upper() and a.display_name and not self.display_name.text():
                    self.display_name.setText(a.display_name)
        try:
            normalise_annotator_id(self._annotator_text())
            self.id_hint.setText("")
        except IdentifierError:
            self.id_hint.setText("Use letters and digits only (e.g. A01)" if self._annotator_text() else "")

    def _update_mode_widgets(self, *args: object) -> None:
        training = self.mode_practice.isChecked() or self.mode_assessment.isChecked()
        self.reference_combo.setEnabled(training and bool(self._reference_sets))
        has_quiz = any(q for sid, _n, q in self._reference_sets if sid == self.reference_combo.currentData())
        self.assess_continuous.setEnabled(self.mode_assessment.isChecked())
        self.assess_quiz.setEnabled(self.mode_assessment.isChecked() and has_quiz)
        if not has_quiz:
            self.assess_continuous.setChecked(True)
        self.choose_recording.setEnabled(not self.mode_assessment.isChecked())

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
            assessment_kind="quiz" if (mode == "assessment" and self.assess_quiz.isChecked()) else "continuous",
            choose_recording=self.choose_recording.isChecked() and mode != "assessment",
        )

    def _begin(self) -> None:
        from electroclean.app.gui.dialogs import UserPrompts

        try:
            req = self.build_request()
        except (IdentifierError, ValueError) as exc:
            UserPrompts().error(self, "Cannot start", str(exc))
            return
        self._save(req)
        self.beginRequested.emit(req)
