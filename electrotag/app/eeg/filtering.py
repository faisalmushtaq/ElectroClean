"""Viewing filters.

Filters are applied with MNE to an in-memory (or temporary memory-mapped) copy
of the data that is used only for display. The source files are opened
read-only and are never written. Everything needed to reproduce the displayed
signal is recorded in a :class:`FilterReport`, including the log MNE prints
when it designs each filter.

Zero-phase filters are non-causal: a sharp transient (for example an electrode
pop) is smeared slightly forwards and backwards in time, and every recording
edge or discontinuity produces a transient of up to half the filter length.
The report gives these durations so that the viewer can mark the affected
zones and so that the reliability analysis can take them into account.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from electrotag.config.settings import FilterSettings

FIR_FIXED_PARAMS = {
    "method": "fir",
    "phase": "zero",
    "fir_window": "hamming",
    "fir_design": "firwin",
    "filter_length": "auto",
    "pad": "reflect_limited",
}
HIGHPASS_FIR_PARAMS = {**FIR_FIXED_PARAMS, "l_trans_bandwidth": "auto"}
NOTCH_FIR_PARAMS = {**FIR_FIXED_PARAMS, "notch_widths": None, "trans_bandwidth": 1.0}
SKIP_BY_ANNOTATION = ("edge", "bad_acq_skip")
BOUNDARY_DESCRIPTION = "EDGE boundary"
# Channels are filtered in blocks of about this much data; MNE's working copy is about the same size.
FILTER_BLOCK_BYTES = 128 * 1024 * 1024

_LENGTH_RE = re.compile(r"Filter length:\s*(\d+)\s*samples")


@dataclass
class FilterStep:
    name: str
    mne_call: str
    parameters: dict[str, Any]
    filter_length_samples: int | None = None
    transient_half_width_samples: int = 0
    mne_log: str = ""


@dataclass
class FilterReport:
    settings: dict[str, Any]
    sfreq: float
    steps: list[FilterStep] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    discontinuity_samples: list[int] = field(default_factory=list)
    acquisition_gaps: list[tuple[int, int]] = field(default_factory=list)
    filtered_channels: list[str] = field(default_factory=list)
    data_storage: str = "none"
    library_versions: dict[str, str] = field(default_factory=dict)
    channel_blocks: int = 0

    @property
    def transient_half_width_s(self) -> float:
        """Approximate duration distorted next to edges and discontinuities."""
        return sum(s.transient_half_width_samples for s in self.steps) / self.sfreq

    def transient_zones(self, n_samples: int) -> list[tuple[float, float]]:
        """Time intervals (s) where filter edge effects may distort the display."""
        w = self.transient_half_width_s
        if w <= 0:
            return []
        dur = n_samples / self.sfreq
        zones = [(0.0, min(w, dur)), (max(dur - w, 0.0), dur)]
        for s in self.discontinuity_samples:
            t = s / self.sfreq
            zones.append((max(t - w, 0.0), min(t + w, dur)))
        zones.sort()
        merged: list[tuple[float, float]] = []
        for a, b in zones:
            if merged and a <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], b))
            else:
                merged.append((a, b))
        return merged

    def to_dict(self) -> dict[str, Any]:
        return {
            "settings": self.settings,
            "applied_to": "displayed copy only; source files are not modified",
            "sfreq": self.sfreq,
            "steps": [
                {
                    "name": s.name,
                    "mne_call": s.mne_call,
                    "parameters": s.parameters,
                    "filter_length_samples": s.filter_length_samples,
                    "filter_length_s": None
                    if s.filter_length_samples is None
                    else s.filter_length_samples / self.sfreq,
                    "transient_half_width_s": s.transient_half_width_samples / self.sfreq,
                    "mne_log": s.mne_log,
                }
                for s in self.steps
            ],
            "skipped": self.skipped,
            "segments_filtered_separately_at_samples": self.discontinuity_samples,
            "acquisition_gaps_not_filtered_samples": [list(g) for g in self.acquisition_gaps],
            "edge_transient_half_width_s": self.transient_half_width_s,
            "filtered_channels": self.filtered_channels,
            "filtered_in_channel_blocks": self.channel_blocks,
            "data_storage": self.data_storage,
            "library_versions": self.library_versions,
        }


def notch_frequencies(settings: FilterSettings, sfreq: float) -> list[float]:
    if not settings.notch_enabled:
        return []
    nyq = sfreq / 2.0
    base = float(settings.notch_hz)
    freqs = [base]
    if settings.notch_harmonics:
        k = 2
        while base * k < nyq - 1.0:
            freqs.append(base * k)
            k += 1
    return [f for f in freqs if f < nyq - 1.0]


def filterable_picks(raw: Any) -> list[int]:
    """All channels except stimulus/system channels."""
    types = raw.get_channel_types()
    return [i for i, t in enumerate(types) if t not in ("stim", "syst", "chpi")]


def _iir_ringing(sfreq: float, l_freq: float | None, h_freq: float | None, order: int) -> int:
    import mne

    params = mne.filter.create_filter(
        None,
        sfreq,
        l_freq,
        h_freq,
        method="iir",
        iir_params=dict(order=order, ftype="butter", output="sos"),
        phase="zero",
        verbose="error",
    )
    try:
        return int(mne.filter.estimate_ringing_samples(params["sos"]))
    except Exception:  # pragma: no cover - defensive
        return 0


def channel_blocks(picks: list[int], n_times: int, block_bytes: int | None = None) -> list[list[int]]:
    """Split channel indices into blocks of at most ``block_bytes`` (default :data:`FILTER_BLOCK_BYTES`)
    of float64 data, with at least one channel per block."""
    if block_bytes is None:
        block_bytes = FILTER_BLOCK_BYTES
    per_block = max(1, int(block_bytes // max(1, n_times * 8)))
    return [list(picks[i:i + per_block]) for i in range(0, len(picks), per_block)]


def apply_view_filters(
    raw: Any,
    settings: FilterSettings,
    discontinuity_samples: list[int],
    acquisition_gaps: list[tuple[int, int]] | tuple[tuple[int, int], ...] = (),
    progress: Callable[[str], None] | None = None,
) -> FilterReport:
    """Filter a *preloaded viewing copy* in place and describe what was done.

    Each continuous segment is filtered on its own: segments are separated by
    ``discontinuity_samples`` and by ``acquisition_gaps`` (sample ranges
    without recorded data, which are left unfiltered). Channels are filtered in
    blocks (see :func:`channel_blocks`); ``progress`` is told after each block.
    """
    import mne
    import scipy
    from mne.utils import catch_logging

    sfreq = float(raw.info["sfreq"])
    n_times = int(raw.n_times)
    gaps = sorted({(int(a), int(b)) for a, b in acquisition_gaps if b > a})
    breaks = sorted(set(int(s) for s in discontinuity_samples if s > 0))
    # Gap edges are segment edges too (for the hatched zones), but the BAD_ACQ_SKIP
    # annotation alone makes MNE split there; an extra boundary would create empty segments.
    edges = set(breaks)
    for a, b in gaps:
        edges.update(x for x in (a, b) if 0 < x < n_times)
    report = FilterReport(
        settings=settings.to_dict(),
        sfreq=sfreq,
        discontinuity_samples=sorted(edges),
        acquisition_gaps=gaps,
        library_versions={"mne": mne.__version__, "numpy": np.__version__, "scipy": scipy.__version__},
    )
    if not (settings.highpass_enabled or settings.notch_enabled):
        report.data_storage = "unfiltered"
        return report
    if not raw.preload:
        raise RuntimeError("Viewing filters require preloaded (or memory-mapped) data")
    picks = filterable_picks(raw)
    report.filtered_channels = [raw.ch_names[i] for i in picks]
    if not picks:
        report.skipped.append("No filterable channels")
        return report

    # Mark discontinuities and gaps so that MNE filters each continuous segment separately.
    saved = raw.annotations.copy()
    breaks = [s for s in breaks if not any(a <= s <= b for a, b in gaps)]
    if breaks or gaps:
        onsets = [s / sfreq + raw.first_time for s in breaks]
        onsets += [a / sfreq + raw.first_time for a, _ in gaps]
        durations = [0.0] * len(breaks) + [(b - a) / sfreq for a, b in gaps]
        descriptions = [BOUNDARY_DESCRIPTION] * len(breaks) + ["BAD_ACQ_SKIP"] * len(gaps)
        boundaries = mne.Annotations(onsets, durations, descriptions, orig_time=raw.annotations.orig_time)
        raw.set_annotations(saved + boundaries if len(saved) else boundaries)
    hp = float(settings.highpass_hz)
    hp_params: dict[str, Any] | None = None
    if settings.highpass_enabled:
        if hp >= sfreq / 2:
            report.skipped.append(f"High-pass {hp} Hz skipped: not below Nyquist ({sfreq / 2} Hz)")
        elif settings.method == "fir":
            hp_params = {"l_freq": hp, "h_freq": None, **HIGHPASS_FIR_PARAMS}
        else:
            hp_params = {
                "l_freq": hp,
                "h_freq": None,
                "method": "iir",
                "phase": "zero",
                "iir_params": {"order": int(settings.iir_order), "ftype": "butter", "output": "sos"},
            }
    freqs = notch_frequencies(settings, sfreq)
    if settings.notch_enabled and not freqs:
        report.skipped.append(f"Notch at {settings.notch_hz} Hz skipped: not below Nyquist ({sfreq / 2} Hz)")
    notch_params: dict[str, Any] | None = None
    if freqs:
        if settings.method == "fir":
            notch_params = {"freqs": freqs, **NOTCH_FIR_PARAMS}
        else:
            notch_params = {
                "freqs": freqs,
                "method": "iir",
                "phase": "zero",
                "iir_params": {"order": int(settings.iir_order), "ftype": "butter", "output": "sos"},
            }

    # MNE filters a copy of the channels it is given, so filtering every channel at once needs as
    # much memory again as the recording (4 GB for a 30-minute, 128-channel, 1024 Hz file). Blocks
    # of channels keep that copy small, give the same result (each channel is filtered on its own)
    # and let the progress message move.
    blocks = channel_blocks(picks, n_times)
    report.channel_blocks = len(blocks)
    logs = {"high-pass": "", "notch": ""}
    try:
        done = 0
        for i, block in enumerate(blocks):
            verbose = "info" if i == 0 else "error"  # every block uses the same design: log it once
            if hp_params is not None:
                with catch_logging() as log:
                    raw.filter(picks=block, skip_by_annotation=SKIP_BY_ANNOTATION, n_jobs=None, verbose=verbose,
                               **hp_params)
                if i == 0:
                    logs["high-pass"] = log.getvalue()
            if notch_params is not None:
                with catch_logging() as log:
                    raw.notch_filter(picks=block, skip_by_annotation=SKIP_BY_ANNOTATION, n_jobs=None,
                                     verbose=verbose, **notch_params)
                if i == 0:
                    logs["notch"] = log.getvalue()
            done += len(block)
            if progress is not None:
                progress(f"Applying display filters: {done} of {len(picks)} channels")
    finally:
        raw.set_annotations(saved)
    if hp_params is not None:
        step = FilterStep("high-pass", "mne.io.Raw.filter", _jsonable(hp_params), mne_log=logs["high-pass"])
        _set_lengths(step, logs["high-pass"], settings, sfreq, hp, None)
        report.steps.append(step)
    if notch_params is not None:
        step = FilterStep("notch", "mne.io.Raw.notch_filter", _jsonable(notch_params), mne_log=logs["notch"])
        # MNE's default notch width is freq / 200 with a 1 Hz transition band.
        f0 = freqs[0]
        _set_lengths(step, logs["notch"], settings, sfreq, f0 + f0 / 400 + 0.5, f0 - f0 / 400 - 0.5)
        report.steps.append(step)
    return report


def _set_lengths(
    step: FilterStep, log_text: str, settings: FilterSettings, sfreq: float, l_freq: float | None, h_freq: float | None
) -> None:
    if settings.method == "fir":
        lengths = [int(m) for m in _LENGTH_RE.findall(log_text)]
        if lengths:
            step.filter_length_samples = max(lengths)
            step.transient_half_width_samples = (max(lengths) - 1) // 2
    else:
        step.transient_half_width_samples = _iir_ringing(sfreq, l_freq, h_freq, int(settings.iir_order))


def _jsonable(params: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in params.items():
        if isinstance(v, (list, tuple)):
            out[k] = [float(x) if isinstance(x, (int, float, np.floating)) else x for x in v]
        elif isinstance(v, np.floating):
            out[k] = float(v)
        else:
            out[k] = v
    return out
