"""A check that the signal amplitude is plausible, so that the traces can always be seen.

Some exports store the samples in the wrong unit (for example microvolts
written as volts). MNE then reads amplitudes a million times too large or too
small, and the viewer hides every sample that lies beyond 1.5 times its scale,
so the traces vanish without explanation. :func:`check_amplitudes` measures a
robust amplitude for each physiological channel type of the display copy from
a few short windows spread through the recording; when it is far outside what
the body produces, it explains the problem and proposes a display scale that
shows the traces.

The amplitude of a channel is the 99.5th percentile of the absolute deviation
from the median in the sampled windows (about half the peak-to-peak range of
the bulk of the signal, the measure MNE's own automatic scaling uses); the
amplitude of a type is the median over its channels that are not flat. Only
the display is affected: the recording and the annotations are not.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

# Plausible amplitude (half the peak-to-peak range, in volts) for each type. Below the lower
# bound even the amplifier's own noise would be larger (a few tenths of a microvolt); above the
# upper bound the median channel would carry more than 5 mV peak to peak (10 mV for EOG and EMG,
# 40 mV for ECG) through most of the recording, which only happens when the unit is wrong. Real
# artifacts are larger, but they are brief and do not move the 99.5th percentile of most channels.
PLAUSIBLE_AMPLITUDE_V = {
    "eeg": (0.25e-6, 2.5e-3),
    "eog": (0.25e-6, 5e-3),
    "emg": (0.25e-6, 5e-3),
    "ecg": (1e-6, 2e-2),
}
TYPE_NAMES = {"eeg": "EEG", "eog": "EOG", "emg": "EMG", "ecg": "ECG"}
N_WINDOWS = 10
WINDOW_S = 2.0


@dataclass
class AmplitudeReport:
    amplitudes_v: dict[str, float] = field(default_factory=dict)  # per channel type
    suggested_scalings: dict[str, float] = field(default_factory=dict)  # only for implausible types
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "measure": "median over channels of the 99.5th percentile of |x - median| in sampled windows (V)",
            "amplitudes_v": self.amplitudes_v,
            "display_scalings_set_automatically": self.suggested_scalings,
        }


def format_volts(value: float) -> str:
    """'14 V', '230 µV', '0.03 µV' and so on."""
    for unit, factor in (("kV", 1e3), ("V", 1.0), ("mV", 1e-3), ("µV", 1e-6), ("nV", 1e-9)):
        if abs(value) >= factor or unit == "nV":
            return f"{value / factor:.3g} {unit}"
    return f"{value:.3g} V"  # pragma: no cover


def nice_scale(value: float) -> float:
    """The smallest 1, 2 or 5 times a power of ten that is at least ``value``."""
    if value <= 0 or not math.isfinite(value):
        raise ValueError(value)
    exponent = math.floor(math.log10(value))
    for step in (1.0, 2.0, 5.0, 10.0):
        candidate = step * 10.0 ** exponent
        if candidate >= value * (1 - 1e-12):
            return float(f"{candidate:.6g}")
    return float(f"{10.0 ** (exponent + 1):.6g}")  # pragma: no cover


def _windows(n_times: int, sfreq: float, avoid: list[tuple[int, int]], edge: int) -> list[tuple[int, int]]:
    length = max(1, min(int(WINDOW_S * sfreq), n_times))
    lo, hi = min(edge, max(0, n_times - length)), max(0, n_times - length - edge)
    if hi < lo:
        lo, hi = 0, max(0, n_times - length)
    starts = sorted({int(round(x)) for x in np.linspace(lo, hi, N_WINDOWS)})
    out = []
    for s in starts:
        e = s + length
        if any(a < e and s < b for a, b in avoid):
            continue  # stretches without recorded data hold padding, not signal
        out.append((s, e))
    return out or [(0, length)]


def check_amplitudes(
    raw: Any,
    *,
    gaps: list[tuple[int, int]] | None = None,
    edge_samples: int = 0,
) -> AmplitudeReport:
    """Measure the display copy's amplitude per channel type and flag implausible ones.

    ``gaps`` are sample ranges without recorded data and ``edge_samples`` the filter edge
    zone at each end of the recording; both are left out of the sampled windows.
    """
    report = AmplitudeReport()
    types = raw.get_channel_types()
    sfreq = float(raw.info["sfreq"])
    windows = _windows(int(raw.n_times), sfreq, list(gaps or []), int(edge_samples))
    for ch_type, (low, high) in PLAUSIBLE_AMPLITUDE_V.items():
        picks = [i for i, t in enumerate(types) if t == ch_type]
        if not picks:
            continue
        data = np.concatenate([raw.get_data(picks=picks, start=s, stop=e) for s, e in windows], axis=1)
        data = data - np.median(data, axis=1, keepdims=True)
        per_channel = np.percentile(np.abs(data), 99.5, axis=1)
        per_channel = per_channel[np.isfinite(per_channel) & (per_channel > 0)]
        if per_channel.size == 0:
            continue  # every channel of the type is flat; nothing to say about units
        amplitude = float(np.median(per_channel))
        report.amplitudes_v[ch_type] = amplitude
        if low <= amplitude <= high:
            continue
        scale = nice_scale(amplitude)
        report.suggested_scalings[ch_type] = scale
        name = TYPE_NAMES[ch_type]
        if amplitude > high:
            why = (
                f"far larger than any {name} signal (normally microvolts to a few millivolts). The file's unit "
                "is probably wrong, for example microvolts stored as volts"
            )
        else:
            why = (
                f"far smaller than any {name} signal, even the amplifier's noise. The file's unit is probably "
                "wrong, for example volts stored as microvolts"
            )
        report.warnings.append(
            f"The {name} channels' amplitude is about {format_volts(amplitude)}, {why}. The display scale has "
            f"been set to {format_volts(scale)} so that the traces can be seen; the scale bar shows the "
            "amplitude as the file states it. Please check the recording with whoever exported it."
        )
    return report
