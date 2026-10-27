"""Viewing options shown before a recording is opened."""

from __future__ import annotations

from qtpy.QtWidgets import (
    QButtonGroup,
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QRadioButton,
    QVBoxLayout,
    QWidget,
)

from electroclean.config.settings import FilterSettings


class FilterDialog(QDialog):
    """Choose the high-pass and notch filters used for display.

    If the study administrator has fixed the filters (``filters.locked`` in the
    study configuration), the controls are shown but cannot be changed.
    """

    def __init__(self, parent: QWidget | None, current: FilterSettings, recording_label: str = "") -> None:
        super().__init__(parent)
        self.setWindowTitle("Viewing options")
        self.locked = current.locked
        layout = QVBoxLayout(self)
        intro = QLabel(
            ("<b>Next recording:</b> " + recording_label + "<br>" if recording_label else "")
            + "These filters change only what you see. The recording files are never modified."
        )
        intro.setWordWrap(True)
        layout.addWidget(intro)
        if self.locked:
            banner = QLabel("These settings are fixed by the study administrator.")
            banner.setStyleSheet("QLabel { background: #FFF3CD; padding: 6px; border-radius: 3px; }")
            layout.addWidget(banner)

        hp = QGroupBox("High-pass filter")
        hpl = QVBoxLayout(hp)
        self.hp_on = QRadioButton(f"Apply {current.highpass_hz:g} Hz high-pass filter (recommended)")
        self.hp_off = QRadioButton("No high-pass filter")
        g1 = QButtonGroup(self)
        g1.addButton(self.hp_on)
        g1.addButton(self.hp_off)
        (self.hp_on if current.highpass_enabled else self.hp_off).setChecked(True)
        hpl.addWidget(self.hp_on)
        hpl.addWidget(self.hp_off)
        layout.addWidget(hp)
        self._hp_hz = current.highpass_hz

        notch = QGroupBox("Notch (mains interference) filter")
        nl = QVBoxLayout(notch)
        self.notch_on = QCheckBox("Apply notch filter")
        self.notch_on.setChecked(current.notch_enabled)
        nl.addWidget(self.notch_on)
        row = QHBoxLayout()
        row.addWidget(QLabel("Frequency:"))
        self.n50 = QRadioButton("50 Hz (UK, Europe)")
        self.n60 = QRadioButton("60 Hz (North America)")
        g2 = QButtonGroup(self)
        g2.addButton(self.n50)
        g2.addButton(self.n60)
        (self.n60 if float(current.notch_hz) == 60.0 else self.n50).setChecked(True)
        row.addWidget(self.n50)
        row.addWidget(self.n60)
        row.addStretch(1)
        nl.addLayout(row)
        self.harmonics = QCheckBox("Also remove harmonics (100, 150 Hz … or 120, 180 Hz …)")
        self.harmonics.setChecked(current.notch_harmonics)
        nl.addWidget(self.harmonics)
        layout.addWidget(notch)

        # The study uses FIR filters (MNE's zero-phase defaults). The design is shown but not chosen
        # here; an administrator could still set IIR in the study file for a special purpose.
        self._method = current.method
        self._iir_order = current.iir_order
        design = "FIR, zero-phase (MNE defaults)" if current.method == "fir" else f"IIR Butterworth, order {current.iir_order}, zero-phase (set by the administrator)"
        layout.addWidget(QLabel(f"Filter design: {design}"))

        note = QLabel(
            "<small>Zero-phase filters do not shift artifacts in time, but they spread very sharp "
            "events slightly in both directions and can distort the first and last few seconds and "
            "the signal around recording discontinuities. These zones are hatched in the viewer.</small>"
        )
        note.setWordWrap(True)
        layout.addWidget(note)
        self.remember = QCheckBox("Use these settings for the rest of this session")
        self.remember.setChecked(True)
        layout.addWidget(self.remember)
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.button(QDialogButtonBox.Ok).setText("Open recording")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self.notch_on.toggled.connect(self._update)
        if self.locked:
            for w in (self.hp_on, self.hp_off, self.notch_on, self.n50, self.n60, self.harmonics):
                w.setEnabled(False)
        self._update()

    def _update(self) -> None:
        on = self.notch_on.isChecked() and not self.locked
        for w in (self.n50, self.n60, self.harmonics):
            w.setEnabled(on)

    def settings(self) -> FilterSettings:
        fs = FilterSettings(
            highpass_enabled=self.hp_on.isChecked(),
            highpass_hz=self._hp_hz,
            notch_enabled=self.notch_on.isChecked(),
            notch_hz=50.0 if self.n50.isChecked() else 60.0,
            notch_harmonics=self.harmonics.isChecked(),
            method=self._method,
            iir_order=self._iir_order,
            locked=self.locked,
        )
        fs.validate()
        return fs
