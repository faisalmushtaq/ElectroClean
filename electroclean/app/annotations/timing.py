"""Conversion between seconds, samples and MNE's annotation time base.

Conventions used throughout ElectroClean (also written into every output file):

* **Time origin.** ``onset`` values are seconds from the first sample stored in
  the recording's data file. This is the BIDS ``events.tsv`` convention and is
  the same as ``raw.times`` in MNE. For BrainVision, EDF and BDF recordings MNE sets
  ``raw.first_samp`` to 0, so this is also seconds from the start of the file.
* **Samples.** ``sample`` values are 0-based indices into the data file,
  relative to the first stored sample (``onset * sfreq``).
* **Boundaries.** An annotation covers the half-open sample range
  ``[onset_sample, onset_sample + duration_samples)``. Boundaries drawn with the
  mouse are snapped to the nearest sample.
* **MNE.** ``mne.Annotations`` attached to a ``Raw`` object store onsets
  relative to ``orig_time`` (the measurement date), which includes the
  ``first_samp / sfreq`` offset. :func:`to_mne_onset` and
  :func:`from_mne_onset` convert between the two.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


class TimingError(ValueError):
    """Raised for invalid time ranges or inconsistent timing metadata."""


@dataclass(frozen=True)
class RecordingTiming:
    """Sampling information needed to convert between seconds and samples."""

    sfreq: float
    n_samples: int
    first_samp: int = 0
    meas_date: str | None = None

    def __post_init__(self) -> None:
        if not (self.sfreq > 0 and math.isfinite(self.sfreq)):
            raise TimingError(f"Sampling frequency must be positive, got {self.sfreq}")
        if self.n_samples < 1:
            raise TimingError(f"Recording must contain at least one sample, got {self.n_samples}")
        if self.first_samp < 0:
            raise TimingError("first_samp cannot be negative")

    # ------------------------------------------------------------ conversions
    @property
    def duration_s(self) -> float:
        """Total duration covered by the samples (n_samples / sfreq)."""
        return self.n_samples / self.sfreq

    @property
    def first_time(self) -> float:
        """MNE's ``raw.first_time``: first_samp / sfreq."""
        return self.first_samp / self.sfreq

    def sample_to_time(self, sample: int) -> float:
        return int(sample) / self.sfreq

    def time_to_sample(self, seconds: float) -> int:
        """Nearest sample index (halves round up), not clamped."""
        if not math.isfinite(seconds):
            raise TimingError(f"Time must be finite, got {seconds}")
        return int(math.floor(seconds * self.sfreq + 0.5))

    def samples_to_duration(self, n: int) -> float:
        return int(n) / self.sfreq

    def duration_to_samples(self, seconds: float) -> int:
        return self.time_to_sample(seconds)

    def snap_interval(self, t_start: float, t_stop: float, min_samples: int = 1) -> tuple[int, int]:
        """Convert a dragged time interval to ``(onset_sample, duration_samples)``.

        The interval may be given in either order. It is clipped to the
        recording and widened to ``min_samples`` if necessary.
        """
        lo, hi = sorted((float(t_start), float(t_stop)))
        start = min(max(self.time_to_sample(lo), 0), self.n_samples)
        stop = min(max(self.time_to_sample(hi), 0), self.n_samples)
        if stop - start < min_samples:
            stop = min(start + min_samples, self.n_samples)
            start = max(stop - min_samples, 0)
        if stop - start < min_samples:
            raise TimingError("Recording is shorter than the minimum annotation duration")
        return start, stop - start

    def validate_range(self, onset_sample: int, duration_samples: int, min_samples: int = 1) -> None:
        if not isinstance(onset_sample, int) or not isinstance(duration_samples, int):
            raise TimingError("Sample positions must be integers")
        if duration_samples < min_samples:
            raise TimingError(
                f"Annotation must last at least {min_samples} sample(s); got {duration_samples}"
            )
        if onset_sample < 0:
            raise TimingError(f"Annotation starts before the recording (sample {onset_sample})")
        if onset_sample + duration_samples > self.n_samples:
            raise TimingError(
                "Annotation extends beyond the end of the recording "
                f"(ends at sample {onset_sample + duration_samples}, recording has {self.n_samples})"
            )

    # ------------------------------------------------------------- MNE bridge
    def to_mne_onset(self, onset_s: float) -> float:
        """Onset in ``raw.annotations`` units (relative to orig_time)."""
        return onset_s + self.first_time

    def from_mne_onset(self, mne_onset: float) -> float:
        return mne_onset - self.first_time

    # ----------------------------------------------------------- serialising
    def to_dict(self) -> dict[str, Any]:
        return {
            "sfreq": self.sfreq,
            "n_samples": self.n_samples,
            "first_samp": self.first_samp,
            "meas_date": self.meas_date,
            "duration_s": self.duration_s,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RecordingTiming:
        return cls(
            sfreq=float(data["sfreq"]),
            n_samples=int(data["n_samples"]),
            first_samp=int(data.get("first_samp", 0)),
            meas_date=data.get("meas_date"),
        )

    @classmethod
    def from_raw(cls, raw: Any) -> RecordingTiming:
        meas = raw.info.get("meas_date")
        return cls(
            sfreq=float(raw.info["sfreq"]),
            n_samples=int(raw.n_times),
            first_samp=int(raw.first_samp),
            meas_date=None if meas is None else meas.isoformat(),
        )


TIME_CONVENTIONS: dict[str, str] = {
    "onset_origin": "first_sample",
    "onset": "Seconds from the first sample stored in the data file (BIDS events.tsv convention; equal to MNE raw.times).",
    "sample": "0-based sample index relative to the first stored sample: sample = onset * sfreq.",
    "interval": "Half-open: an annotation covers samples [onset_sample, onset_sample + duration_samples).",
    "boundary_snapping": "Boundaries are snapped to the nearest sample when created or edited.",
    "mne_annotations": "In mne.Annotations attached to Raw, onset_mne = onset + first_samp / sfreq (relative to orig_time).",
}
