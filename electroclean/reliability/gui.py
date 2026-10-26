"""Small dialog for running the agreement analysis from the desktop app."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from qtpy.QtCore import QUrl
from qtpy.QtGui import QDesktopServices
from qtpy.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from electroclean.reliability.config import AnalysisConfig


def _floats(text: str) -> tuple[float, ...]:
    return tuple(float(x) for x in text.replace(",", " ").split())


class AgreementDialog(QDialog):
    def __init__(self, parent: QWidget | None, input_dir: Path | None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Inter-rater agreement analysis")
        d = AnalysisConfig()
        form = QFormLayout()
        row = QHBoxLayout()
        self.inputs = QLineEdit(str(input_dir) if input_dir else "")
        b = QPushButton("Browse…")
        b.clicked.connect(lambda: self._pick(self.inputs))
        row.addWidget(self.inputs)
        row.addWidget(b)
        form.addRow("Annotation folder", row)
        row2 = QHBoxLayout()
        self.out = QLineEdit(str(input_dir.parent / "agreement_results") if input_dir else "")
        b2 = QPushButton("Browse…")
        b2.clicked.connect(lambda: self._pick(self.out))
        row2.addWidget(self.out)
        row2.addWidget(b2)
        form.addRow("Results folder", row2)
        self.resolutions = QLineEdit(" ".join(f"{r:g}" for r in d.resolutions_s))
        form.addRow("Time resolutions (s)", self.resolutions)
        self.coverage = QDoubleSpinBox()
        self.coverage.setRange(0, 1)
        self.coverage.setSingleStep(0.1)
        self.coverage.setValue(d.min_bin_coverage)
        form.addRow("Bin coverage needed (0 = any overlap)", self.coverage)
        self.criterion = QComboBox()
        self.criterion.addItems(["iou", "tolerance", "iou_and_tolerance"])
        form.addRow("Event matching criterion", self.criterion)
        self.thresholds = QLineEdit(" ".join(f"{t:g}" for t in d.iou_thresholds))
        form.addRow("IoU thresholds", self.thresholds)
        self.primary = QDoubleSpinBox()
        self.primary.setRange(0, 0.99)
        self.primary.setSingleStep(0.05)
        self.primary.setValue(d.primary_iou_threshold)
        form.addRow("Primary IoU threshold", self.primary)
        self.tol_on = QDoubleSpinBox()
        self.tol_off = QDoubleSpinBox()
        for w, v in ((self.tol_on, d.onset_tolerance_s), (self.tol_off, d.offset_tolerance_s)):
            w.setRange(0, 60)
            w.setDecimals(3)
            w.setValue(v)
            w.setSuffix(" s")
        form.addRow("Onset tolerance", self.tol_on)
        form.addRow("Offset tolerance", self.tol_off)
        self.many = QCheckBox("Allow one event to match several (many-to-one)")
        form.addRow("", self.many)
        self.reference = QLineEdit()
        self.reference.setPlaceholderText("optional: compare everyone with this annotator")
        form.addRow("Reference annotator", self.reference)
        layout = QVBoxLayout(self)
        layout.addLayout(form)
        self.status = QLabel()
        self.status.setWordWrap(True)
        layout.addWidget(self.status)
        bb = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Close)
        bb.button(QDialogButtonBox.Ok).setText("Run analysis")
        bb.accepted.connect(self.run)
        bb.rejected.connect(self.reject)
        layout.addWidget(bb)
        self.result_paths: dict[str, Path] = {}

    def _pick(self, edit: QLineEdit) -> None:
        chosen = QFileDialog.getExistingDirectory(self, "Choose folder", edit.text() or str(Path.home()))
        if chosen:
            edit.setText(chosen)

    def config(self) -> AnalysisConfig:
        cfg = AnalysisConfig(
            resolutions_s=_floats(self.resolutions.text()),
            min_bin_coverage=self.coverage.value(),
            match_criterion=self.criterion.currentText(),
            iou_thresholds=_floats(self.thresholds.text()),
            primary_iou_threshold=self.primary.value(),
            onset_tolerance_s=self.tol_on.value(),
            offset_tolerance_s=self.tol_off.value(),
            allow_many_to_one=self.many.isChecked(),
            reference_annotator=self.reference.text().strip().upper() or None,
        )
        cfg.validate()
        return cfg

    def run(self) -> None:
        from electroclean.reliability.analysis import run_analysis, write_outputs

        try:
            cfg = self.config()
            self.status.setText("Running…")
            self.repaint()
            result = run_analysis([Path(self.inputs.text())], cfg)
            self.result_paths = write_outputs(result, Path(self.out.text()))
        except Exception as exc:
            self.status.setText(f"<span style='color:#B71C1C'>Analysis failed: {exc}</span>")
            return
        self.status.setText(f"Done: {len(result.dataset.groups)} recording(s). Report: {self.result_paths['report']}")
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.result_paths["report"])))


def open_agreement_dialog(parent: QWidget | None, output_root: Path | None, prompts: Any = None) -> AgreementDialog:
    dlg = AgreementDialog(parent, output_root)
    dlg.show()
    return dlg
