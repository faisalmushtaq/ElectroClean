"""Dialog for running the agreement analysis from the desktop application.

The analysis runs in a background thread, so the window stays responsive and
can be cancelled; tests run it synchronously. Inputs are checked before
anything starts, and earlier results are never replaced without asking.
"""

from __future__ import annotations

import html
from datetime import datetime
from pathlib import Path
from typing import Any

from qtpy.QtCore import Qt, QThread, QUrl, Signal
from qtpy.QtGui import QDesktopServices
from qtpy.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QComboBox,
    QDialog,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QSpinBox,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from electroclean.app.gui import style
from electroclean.reliability.config import AnalysisConfig

GUIDE_URL = "https://github.com/faisalmushtaq/ElectroClean/blob/main/docs/reliability_guide.md"
CRITERIA = (
    ("Overlap (IoU)", "iou"),
    ("Onset and offset tolerance", "tolerance"),
    ("Overlap and tolerance", "iou_and_tolerance"),
)
ERROR_COLOUR = style.colour("destructive")


def parse_numbers(text: str, what: str, example: str) -> tuple[float, ...]:
    """Numbers separated by spaces or commas, with a plain-language error."""
    parts = text.replace(",", " ").split()
    if not parts:
        raise ValueError(f"{what}: give at least one number, for example {example}.")
    out = []
    for part in parts:
        try:
            out.append(float(part))
        except ValueError:
            raise ValueError(f"{what}: '{part}' is not a number. Give numbers separated by spaces, for example "
                             f"{example}.") from None
    return tuple(out)


def count_annotation_files(folder: Path, limit: int = 100000) -> int:
    n = 0
    for p in folder.rglob("*_annotations.json"):
        if not any(part.startswith(".") for part in p.relative_to(folder).parts):
            n += 1
            if n >= limit:
                break
    return n


def suggest_results_dir(input_dir: Path | None, now: datetime | None = None) -> Path | None:
    """A new, dated folder: in the dataset's derivatives when the annotations belong to a BIDS dataset.

    ``Annotated_Events`` normally sits in the dataset folder; BIDS keeps derived
    results under ``derivatives``. Otherwise the folder is put next to the
    annotation folder.
    """
    if input_dir is None:
        return None
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    parent = input_dir.parent
    if (parent / "dataset_description.json").is_file():
        return parent / "derivatives" / "electroclean_agreement" / stamp
    return parent / "electroclean_agreement" / stamp


class AnalysisWorker(QThread):
    """Runs the analysis and writes its outputs in a background thread."""

    progress = Signal(str)
    succeeded = Signal(object)  # (AnalysisResult, paths)
    failed = Signal(object)  # exception

    def __init__(self, inputs: list[Path], out: Path, config: AnalysisConfig) -> None:
        super().__init__()
        self.inputs = inputs
        self.out = out
        self.config = config
        self.cancel_requested = False
        self.result: Any = None
        self.error: BaseException | None = None

    def run(self) -> None:  # noqa: D102 - QThread entry point
        from electroclean.reliability.analysis import run_analysis, write_outputs

        def cancelled() -> bool:
            return self.cancel_requested

        try:
            result = run_analysis(self.inputs, self.config, strict=True, progress=self.progress.emit, cancel=cancelled)
            paths = write_outputs(result, self.out, progress=self.progress.emit, cancel=cancelled)
        except Exception as exc:  # reported in the dialog, never re-raised in the thread
            self.error = exc
            self.failed.emit(exc)
            return
        self.result = (result, paths)
        self.succeeded.emit(self.result)


class AgreementDialog(QDialog):
    def __init__(self, parent: QWidget | None, input_dir: Path | None, prompts: Any = None, *,
                 synchronous: bool = False, open_report: bool = True) -> None:
        super().__init__(parent)
        from electroclean.app.annotations.labels import default_catalogue
        from electroclean.app.gui.dialogs import UserPrompts

        self.prompts = prompts or UserPrompts()
        self.synchronous = synchronous
        self.open_report_when_done = open_report and not synchronous
        self.worker: AnalysisWorker | None = None
        self.result_paths: dict[str, Path] = {}
        self.last_result: Any = None
        self._results_edited = False
        self._close_after_worker = False
        style.apply_theme()
        self.setWindowTitle("Inter-rater agreement analysis")
        d = AnalysisConfig()
        tabs = QTabWidget()

        # ------------------------------------------------------------ data
        data = QWidget()
        form = QFormLayout(data)
        self.inputs = QLineEdit(str(input_dir) if input_dir else "")
        self.inputs.setPlaceholderText("the annotators' results, normally Annotated_Events in the dataset folder")
        self.inputs.setToolTip("The folder searched, with its sub-folders, for the annotators' *_annotations.json "
                               "files. This is normally the Annotated_Events folder in the dataset folder.")
        self.inputs.editingFinished.connect(self._inputs_changed)
        form.addRow("Annotation folder", self._with_browse(self.inputs, self._pick_inputs))
        self.inputs_hint = QLabel()
        self.inputs_hint.setWordWrap(True)
        form.addRow("", self.inputs_hint)
        suggested = suggest_results_dir(input_dir)
        self.out = QLineEdit(str(suggested) if suggested else "")
        self.out.setToolTip("Where the tables and the report are written. By default a new folder named after the "
                            "date and time, so that earlier analyses are kept.")
        self.out.textEdited.connect(self._results_text_edited)
        self.out.editingFinished.connect(self._results_changed)
        form.addRow("Results folder", self._with_browse(self.out, self._pick_out))
        self.out_hint = QLabel()
        self.out_hint.setWordWrap(True)
        form.addRow("", self.out_hint)
        self.annotators = QLineEdit()
        self.annotators.setPlaceholderText("blank = everyone; or IDs such as A01 A02")
        self.annotators.setToolTip("Only these annotators are analysed. Leave it blank to include everyone.")
        form.addRow("Annotators", self.annotators)
        self.reference = QLineEdit()
        self.reference.setPlaceholderText("blank = compare every pair; or one ID, e.g. an expert")
        self.reference.setToolTip("When given, every annotator is compared with this annotator only, for example an "
                                  "expert; otherwise every pair of annotators is compared.")
        form.addRow("Reference annotator", self.reference)
        modes = QHBoxLayout()
        self.mode_boxes: dict[str, QCheckBox] = {}
        for mode, text in (("standard", "Research annotation"), ("practice", "Practice"), ("assessment", "Assessment")):
            box = QCheckBox(text)
            box.setChecked(mode in d.modes)
            self.mode_boxes[mode] = box
            modes.addWidget(box)
        modes.addStretch(1)
        mw = QWidget()
        mw.setLayout(modes)
        mw.setToolTip("Which kind of sessions to include; research annotation is the usual choice.")
        form.addRow("Sessions", mw)
        self.category_list = QListWidget()
        self.category_list.setSelectionMode(QAbstractItemView.NoSelection)
        self.category_list.setMaximumHeight(150)
        for lab in default_catalogue().label_names:
            item = QListWidgetItem(lab)
            item.setFlags(item.flags() | Qt.ItemIsUserCheckable)
            item.setCheckState(Qt.Checked)
            self.category_list.addItem(item)
        self.category_list.setToolTip("Artifact categories to analyse. ANY-artifact (any artifact versus none) is "
                                      "always included.")
        cats = QVBoxLayout()
        cats.addWidget(self.category_list)
        cat_buttons = QHBoxLayout()
        for text, state in (("All", Qt.Checked), ("None", Qt.Unchecked)):
            b = QPushButton(text)
            b.clicked.connect(lambda _c=False, s=state: self._set_all_categories(s))
            cat_buttons.addWidget(b)
        cat_buttons.addStretch(1)
        cats.addLayout(cat_buttons)
        cw = QWidget()
        cw.setLayout(cats)
        form.addRow("Categories", cw)
        tabs.addTab(data, "Data")

        # -------------------------------------------------------- settings
        sett = QWidget()
        sform = QFormLayout(sett)
        chm = QHBoxLayout()
        self.mode_time = QCheckBox("Time only")
        self.mode_channel = QCheckBox("Time and channel")
        for box in (self.mode_time, self.mode_channel):
            box.setChecked(True)
            chm.addWidget(box)
        chm.addStretch(1)
        chw = QWidget()
        chw.setLayout(chm)
        chw.setToolTip("Time only compares when artifacts were marked. Time and channel also compares which channels "
                       "were marked, counting each channel separately.")
        sform.addRow("Compare", chw)
        self.resolutions = QLineEdit(" ".join(f"{r:g}" for r in d.resolutions_s))
        self.resolutions.setToolTip("Bin widths in seconds for the binned comparisons, separated by spaces. The exact "
                                    "sample-by-sample comparison is always made as well.")
        sform.addRow("Time bins (s)", self.resolutions)
        self.coverage = QDoubleSpinBox()
        self.coverage.setRange(0, 1)
        self.coverage.setSingleStep(0.1)
        self.coverage.setValue(d.min_bin_coverage)
        self.coverage.setToolTip("Fraction of a bin that an annotation must cover for the bin to count as marked; "
                                 "0 means any overlap.")
        sform.addRow("Bin coverage needed", self.coverage)
        self.criterion = QComboBox()
        for text, value in CRITERIA:
            self.criterion.addItem(text, value)
        self.criterion.setCurrentIndex([v for _t, v in CRITERIA].index(d.match_criterion))
        self.criterion.setToolTip("How two annotators' artifacts are paired: by how much they overlap, by how close "
                                  "their onsets and offsets are, or both.")
        self.criterion.currentIndexChanged.connect(self._criterion_changed)
        sform.addRow("Event matching", self.criterion)
        self.thresholds = QLineEdit(" ".join(f"{t:g}" for t in d.iou_thresholds))
        self.thresholds.setToolTip("Minimum overlap (intersection over union, 0 to 1) for two events to match; each "
                                   "value is reported. 0 means any overlap.")
        sform.addRow("Overlap thresholds (IoU)", self.thresholds)
        self.primary = QDoubleSpinBox()
        self.primary.setRange(0, 0.99)
        self.primary.setSingleStep(0.05)
        self.primary.setValue(d.primary_iou_threshold)
        self.primary.setToolTip("The overlap threshold used for the boundary differences and the figures.")
        sform.addRow("Main threshold (IoU)", self.primary)
        self.tol_on = QDoubleSpinBox()
        self.tol_off = QDoubleSpinBox()
        for w, v in ((self.tol_on, d.onset_tolerance_s), (self.tol_off, d.offset_tolerance_s)):
            w.setRange(0, 60)
            w.setDecimals(3)
            w.setValue(v)
            w.setSuffix(" s")
            w.setToolTip("Largest difference between the two annotators' boundaries for the tolerance criteria.")
        sform.addRow("Onset tolerance", self.tol_on)
        sform.addRow("Offset tolerance", self.tol_off)
        self.many = QCheckBox("Allow one event to match several (many-to-one)")
        self.many.setToolTip("Normally each event matches at most one event of the other annotator.")
        sform.addRow("", self.many)
        self.jaccard = QDoubleSpinBox()
        self.jaccard.setRange(0, 1)
        self.jaccard.setSingleStep(0.1)
        self.jaccard.setValue(d.min_channel_jaccard)
        self.jaccard.setToolTip("Time-and-channel matching: smallest channel overlap (Jaccard index) for a match; "
                                "0 means at least one shared channel.")
        sform.addRow("Channel overlap needed", self.jaccard)
        self.min_events = QSpinBox()
        self.min_events.setRange(0, 1000)
        self.min_events.setValue(d.min_events_per_category)
        self.min_events.setToolTip("Categories with fewer annotations than this (all annotators together) are kept "
                                   "in the tables but left out of the report's figures.")
        sform.addRow("Fewest annotations for figures", self.min_events)
        tabs.addTab(sett, "Settings")
        self._criterion_changed()

        # ---------------------------------------------------------- bottom
        layout = QVBoxLayout(self)
        layout.addWidget(tabs)
        guide = style.label(f"The measures and how to read them: <a href='{GUIDE_URL}'>reliability guide</a>.", "caption")
        guide.setOpenExternalLinks(True)
        layout.addWidget(guide)
        self.status = QLabel()
        self.status.setWordWrap(True)
        self.status.setTextInteractionFlags(Qt.TextBrowserInteraction)
        self.status.linkActivated.connect(lambda url: QDesktopServices.openUrl(QUrl(url)))
        layout.addWidget(self.status)
        self.warnings = QLabel()
        self.warnings.setWordWrap(True)
        self.warnings.setTextInteractionFlags(Qt.TextSelectableByMouse)
        style.set_role(self.warnings, "banner")
        self.warnings.hide()
        layout.addWidget(self.warnings)
        buttons = QHBoxLayout()
        self.run_btn = QPushButton("Run analysis")
        self.run_btn.setDefault(True)
        style.set_kind(self.run_btn, "primary")
        self.run_btn.clicked.connect(self.run)
        self.cancel_btn = QPushButton("Cancel analysis")
        self.cancel_btn.setEnabled(False)
        self.cancel_btn.clicked.connect(self.cancel)
        self.open_btn = QPushButton("Open report")
        self.open_btn.setEnabled(False)
        self.open_btn.clicked.connect(lambda: self._open("report"))
        self.folder_btn = QPushButton("Open results folder")
        self.folder_btn.setEnabled(False)
        self.folder_btn.clicked.connect(lambda: self._open("folder"))
        close = QPushButton("Close")
        close.clicked.connect(self.reject)
        for b in (self.run_btn, self.cancel_btn, self.open_btn, self.folder_btn):
            buttons.addWidget(b)
        buttons.addStretch(1)
        buttons.addWidget(close)
        layout.addLayout(buttons)
        self._inputs_changed()
        self._results_changed()

    # ------------------------------------------------------------ helpers
    @staticmethod
    def _with_browse(edit: QLineEdit, pick: Any) -> QWidget:
        row = QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        b = QPushButton("Browse…")
        b.clicked.connect(pick)
        row.addWidget(edit)
        row.addWidget(b)
        w = QWidget()
        w.setLayout(row)
        return w

    def _pick_inputs(self) -> None:
        start = self.inputs.text() or str(Path.home())
        chosen = QFileDialog.getExistingDirectory(self, "Choose the annotation folder", start)
        if chosen:
            self.inputs.setText(chosen)
            self._inputs_changed()

    def _pick_out(self) -> None:
        start = self.out.text() or str(Path.home())
        chosen = QFileDialog.getExistingDirectory(self, "Choose the results folder", start)
        if chosen:
            self.out.setText(chosen)
            self._results_edited = True
            self._results_changed()

    def _results_text_edited(self, _text: str) -> None:
        self._results_edited = True

    def _set_all_categories(self, state: Any) -> None:
        for i in range(self.category_list.count()):
            self.category_list.item(i).setCheckState(state)

    def _criterion_changed(self, *_args: Any) -> None:
        crit = self.criterion.currentData()
        uses_iou = crit in ("iou", "iou_and_tolerance")
        uses_tol = crit in ("tolerance", "iou_and_tolerance")
        for w in (self.thresholds, self.primary):
            w.setEnabled(uses_iou)
        for w in (self.tol_on, self.tol_off):
            w.setEnabled(uses_tol)

    def input_problem(self) -> str | None:
        text = self.inputs.text().strip()
        if not text or text == ".":
            return ("Choose the annotation folder: the folder with the annotators' results, normally "
                    "Annotated_Events in the dataset folder.")
        p = Path(text).expanduser()
        if not p.is_absolute():
            return f"Give the full path of the annotation folder (use Browse…), not '{text}'."
        if not p.exists():
            return f"Folder not found: {p}"
        if p.is_dir() and count_annotation_files(p, limit=1) == 0:
            return (f"No annotation files (*_annotations.json) were found in {p} or its sub-folders. Choose the "
                    "folder with the annotators' results, normally Annotated_Events.")
        return None

    def results_problem(self) -> str | None:
        text = self.out.text().strip()
        if not text or text == ".":
            return "Choose a results folder."
        p = Path(text).expanduser()
        if not p.is_absolute():
            return f"Give the full path of the results folder (use Browse…), not '{text}'."
        if p.exists() and not p.is_dir():
            return f"{p} is a file; choose a folder for the results."
        return None

    def _inputs_changed(self) -> None:
        problem = self.input_problem()
        if problem is not None:
            self.inputs_hint.setText(f"<span style='color:{ERROR_COLOUR}'>{html.escape(problem)}</span>"
                                     if self.inputs.text().strip() else "")
        else:
            p = Path(self.inputs.text().strip()).expanduser()
            n = count_annotation_files(p) if p.is_dir() else 1
            self.inputs_hint.setText(f"{n} annotation file(s) found.")
            if not self._results_edited:
                suggested = suggest_results_dir(p)
                if suggested is not None:
                    self.out.setText(str(suggested))
                    self._results_changed()

    def _results_changed(self) -> None:
        from electroclean.reliability.analysis import has_earlier_results

        text = self.out.text().strip()
        if text and Path(text).is_absolute() and has_earlier_results(Path(text)):
            self.out_hint.setText("This folder already holds results; you will be asked before they are replaced.")
        elif text:
            self.out_hint.setText("Earlier analyses are kept: each analysis has its own folder by default.")
        else:
            self.out_hint.setText("")

    def config(self) -> AnalysisConfig:
        """The analysis settings from the dialog (ValueError with a plain message when something is wrong)."""
        modes = tuple(m for m, box in self.mode_boxes.items() if box.isChecked())
        if not modes:
            raise ValueError("Sessions: tick at least one kind of session to include.")
        channel_modes = tuple(m for m, box in (("time_only", self.mode_time), ("time_and_channel", self.mode_channel))
                              if box.isChecked())
        if not channel_modes:
            raise ValueError("Compare: tick 'Time only', 'Time and channel' or both.")
        checked = [self.category_list.item(i).text() for i in range(self.category_list.count())
                   if self.category_list.item(i).checkState() == Qt.Checked]
        if not checked:
            raise ValueError("Categories: tick at least one artifact category.")
        categories = None if len(checked) == self.category_list.count() else tuple(checked)
        annotators = tuple(a.upper() for a in self.annotators.text().replace(",", " ").split()) or None
        resolutions = parse_numbers(self.resolutions.text(), "Time bins", "0.01 0.05 0.1")
        if any(r <= 0 for r in resolutions):
            raise ValueError("Time bins: every bin width must be more than 0 seconds.")
        thresholds = parse_numbers(self.thresholds.text(), "Overlap thresholds", "0 0.2 0.5")
        if any(not 0 <= t < 1 for t in thresholds):
            raise ValueError("Overlap thresholds: each must be at least 0 and less than 1.")
        cfg = AnalysisConfig(
            resolutions_s=tuple(dict.fromkeys(resolutions)),
            min_bin_coverage=self.coverage.value(),
            channel_modes=channel_modes,
            match_criterion=self.criterion.currentData(),
            iou_thresholds=thresholds,
            primary_iou_threshold=self.primary.value(),
            onset_tolerance_s=self.tol_on.value(),
            offset_tolerance_s=self.tol_off.value(),
            allow_many_to_one=self.many.isChecked(),
            min_channel_jaccard=self.jaccard.value(),
            categories=categories,
            annotators=annotators,
            modes=modes,
            reference_annotator=self.reference.text().strip().upper() or None,
            min_events_per_category=self.min_events.value(),
        )
        cfg.validate()
        return cfg

    def _error(self, text: str) -> None:
        self.status.setText(f"<span style='color:{ERROR_COLOUR}'>{html.escape(text, quote=False)}</span>")

    # ---------------------------------------------------------------- run
    def run(self) -> None:
        from electroclean.reliability.analysis import has_earlier_results

        if self.worker is not None:
            return
        self.warnings.hide()
        problem = self.input_problem() or self.results_problem()
        if problem is not None:
            self._error(problem)
            return
        try:
            cfg = self.config()
        except ValueError as exc:
            self._error(str(exc))
            return
        out = Path(self.out.text().strip()).expanduser()
        if has_earlier_results(out) and not self.prompts.ask(
            self, "Replace earlier results?",
            f"{out} already holds the results of an earlier analysis. Replace them?",
            yes="Replace", no="Cancel",
        ):
            self.status.setText("Not run: choose another results folder to keep the earlier results.")
            return
        worker = AnalysisWorker([Path(self.inputs.text().strip()).expanduser()], out, cfg)
        self.worker = worker
        self._set_running(True)
        worker.progress.connect(self._on_progress)
        if self.synchronous:
            worker.run()
            if worker.error is not None:
                self._on_failed(worker.error)
            else:
                self._on_succeeded(worker.result)
            return
        worker.succeeded.connect(self._on_succeeded, Qt.QueuedConnection)
        worker.failed.connect(self._on_failed, Qt.QueuedConnection)
        worker.start()

    def cancel(self) -> None:
        if self.worker is not None:
            self.worker.cancel_requested = True
            self.status.setText("Cancelling: the analysis stops after the current step…")

    def _set_running(self, running: bool) -> None:
        self.run_btn.setEnabled(not running)
        self.cancel_btn.setEnabled(running)
        if running:
            self.open_btn.setEnabled(False)
            self.folder_btn.setEnabled(False)
            self.status.setText("Running the analysis…")

    def _on_progress(self, text: str) -> None:
        if self.worker is not None and not self.worker.cancel_requested:
            self.status.setText(f"Running the analysis: {html.escape(text)}…")

    def _finish_worker(self) -> None:
        worker, self.worker = self.worker, None
        if worker is not None and not self.synchronous:
            worker.wait(2000)
        self._set_running(False)
        if self._close_after_worker:
            QDialog.reject(self)

    def _on_failed(self, exc: BaseException) -> None:
        from electroclean.reliability.analysis import AnalysisCancelled

        self._finish_worker()
        if isinstance(exc, AnalysisCancelled):
            self.status.setText(html.escape(str(exc)))
        else:
            self._error(f"The analysis could not be run: {exc}")

    def _on_succeeded(self, payload: Any) -> None:
        self._finish_worker()
        result, paths = payload
        self.last_result = result
        self.result_paths = paths
        out = Path(self.out.text().strip()).expanduser()
        rec = result.settings_record
        report = paths.get("report")
        links = f"<a href='{QUrl.fromLocalFile(str(out)).toString()}'>{html.escape(str(out))}</a>"
        if report is not None:
            links = (f"report <a href='{QUrl.fromLocalFile(str(report)).toString()}'>{html.escape(report.name)}</a> "
                     f"in {links}")
        self.status.setText(
            f"Finished: {len(result.dataset.groups)} recording(s) from {len(result.dataset.annotators)} annotator(s), "
            f"{rec.get('n_comparable_recordings', 0)} with annotators to compare. Results: {links}"
        )
        warnings = rec.get("warnings", [])
        if warnings:
            head = "<b>Nothing to compare.</b> " if not result.has_comparisons else "<b>Please note.</b> "
            items = "".join(f"<li>{html.escape(w)}</li>" for w in warnings[:6])
            more = f"<p>{len(warnings) - 6} more in the report.</p>" if len(warnings) > 6 else ""
            self.warnings.setText(f"{head}<ul style='margin:0'>{items}</ul>{more}")
            self.warnings.show()
        self.open_btn.setEnabled(report is not None)
        self.folder_btn.setEnabled(True)
        if self.open_report_when_done and report is not None:
            self._open("report")

    def _open(self, what: str) -> None:
        if what == "report" and "report" in self.result_paths:
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.result_paths["report"])))
        elif what == "folder" and self.out.text().strip():
            QDesktopServices.openUrl(QUrl.fromLocalFile(self.out.text().strip()))

    def reject(self) -> None:
        if self.worker is not None:
            # Closed while running: stop at the next step, and close once the thread has finished.
            self.worker.cancel_requested = True
            self._close_after_worker = True
            self.hide()
            return
        super().reject()


def open_agreement_dialog(parent: QWidget | None, output_root: Path | None, prompts: Any = None) -> AgreementDialog:
    dlg = AgreementDialog(parent, output_root, prompts)
    dlg.resize(760, 640)
    dlg.show()
    return dlg
