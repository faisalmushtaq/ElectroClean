"""Loading a recording for annotation.

:func:`load_recording` checks the companion files, reads the recording with
``mne.io.read_raw_brainvision``, ``mne.io.read_raw_edf`` or
``mne.io.read_raw_bdf``, validates it against its BIDS metadata, collects the
original events, and prepares a separate viewing copy to which the chosen
display filters are applied. Channels that the settings hide (for example a
headset's timestamp and contact-quality channels) and trigger channels (for
example the Status channel of BioSemi files, which is read for the original
events instead) are left out of the viewing copy. Source files are only ever
opened for reading.
"""

from __future__ import annotations

import fnmatch
import gc
import tempfile
import warnings
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from electroclean.app.annotations.labels import LabelCatalogue
from electroclean.app.annotations.model import RecordingInfo
from electroclean.app.annotations.timing import RecordingTiming
from electroclean.app.eeg.amplitude import AmplitudeReport, check_amplitudes
from electroclean.app.eeg.channels import ChannelReport, apply_channel_metadata, check_channels
from electroclean.app.eeg.events import (
    SOURCE_NONE,
    EventCodeReport,
    OriginalEvents,
    check_event_codes,
    compare_with_markers,
    events_from_raw_annotations,
    events_from_stim_channels,
    events_from_tsv,
)
from electroclean.app.eeg.filtering import FilterReport, apply_view_filters
from electroclean.app.io.atomic import sha256_file
from electroclean.app.io.bids import load_json_chain
from electroclean.app.io.discovery import RecordingFiles
from electroclean.app.io.edf import EdfHeader
from electroclean.app.io.tsv import TSVError
from electroclean.config.settings import FilterSettings, Settings

ProgressCallback = Callable[[str], None]

BYTES_PER_SAMPLE = {"INT_16": 2, "INT_32": 4, "IEEE_FLOAT_32": 4, "UINT_16": 2}

# MNE warnings that mean the recording cannot be annotated faithfully.
FATAL_WARNING_PATTERNS = (
    "outside data range",  # markers beyond the end of the data: truncated .eeg file
    "not found; no annotations",  # marker file missing: original events would be lost
)
# MNE's EDF warning when the header and file size disagree; ElectroClean checks this itself first.
EDF_SIZE_WARNING = "Number of records from the header does not match the file size"
# Annotations that mark stretches without recorded data (MNE writes BAD_ACQ_SKIP into EDF+
# files it exports, for example for the padding of the last data record).
ACQUISITION_GAP_PREFIX = "bad_acq_skip"


class RecordingLoadError(RuntimeError):
    """A recording cannot be opened for annotation.

    ``kind`` is a short machine-readable reason used in the failure log.
    """

    def __init__(self, message: str, *, kind: str = "load_error", details: str = "") -> None:
        super().__init__(message)
        self.kind = kind
        self.details = details


@dataclass
class LoadedRecording:
    files: RecordingFiles
    info: RecordingInfo
    view_raw: Any
    original_events: OriginalEvents
    event_report: EventCodeReport
    channel_report: ChannelReport
    filter_report: FilterReport
    fingerprint: dict[str, Any]
    events_sidecar: dict[str, Any] = field(default_factory=dict)
    eeg_sidecar: dict[str, Any] = field(default_factory=dict)
    discontinuity_samples: list[int] = field(default_factory=list)
    acquisition_gaps: list[tuple[int, int]] = field(default_factory=list)
    hidden_channels: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    cache_path: Path | None = None
    trigger_channels: list[str] = field(default_factory=list)  # hidden; read for the original events
    amplitude_report: AmplitudeReport = field(default_factory=AmplitudeReport)

    @property
    def display_scalings(self) -> dict[str, float]:
        """Display scales chosen for this recording because its amplitude is implausible (see amplitude.py).

        They take precedence over the study's ``display.scalings`` for this recording only."""
        return dict(self.amplitude_report.suggested_scalings)

    @property
    def timing(self) -> RecordingTiming:
        return self.info.timing

    def close(self) -> None:
        """Release the viewing copy and delete any temporary memory-mapped cache."""
        self.view_raw = None
        gc.collect()
        if self.cache_path is not None:
            try:
                self.cache_path.unlink()
            except OSError:
                pass
            try:
                self.cache_path.parent.rmdir()
            except OSError:
                pass
            self.cache_path = None


def fingerprint_sources(files: RecordingFiles, compute_hash: bool = True) -> dict[str, Any]:
    """Size, modification time and (optionally) SHA-256 of every input file."""
    out: dict[str, Any] = {}
    for role, path in files.source_files().items():
        st = path.stat()
        try:
            rel = path.resolve().relative_to(files.root.resolve()).as_posix()
        except ValueError:
            rel = str(path)
        entry: dict[str, Any] = {"path": rel, "size": st.st_size, "mtime_ns": st.st_mtime_ns}
        if compute_hash:
            entry["sha256"] = sha256_file(path)
        out[role] = entry
    return out


def changed_since(files: RecordingFiles, fingerprint: dict[str, Any]) -> list[str]:
    """Roles of input files whose size or modification time changed (cheap check)."""
    changed = []
    current = files.source_files()
    for role, entry in fingerprint.items():
        path = current.get(role)
        if path is None or not path.exists():
            changed.append(role)
            continue
        st = path.stat()
        if st.st_size != entry.get("size") or st.st_mtime_ns != entry.get("mtime_ns"):
            changed.append(role)
    return changed


def _read_raw(files: RecordingFiles, preload: bool | str) -> tuple[Any, list[str]]:
    import mne

    from mne.utils import catch_logging

    path = files.path
    # MNE only emits its warnings (e.g. "markers outside data range") when its
    # log level is WARNING or lower; they are captured here, not printed.
    with warnings.catch_warnings(record=True) as caught, catch_logging():
        warnings.simplefilter("always")
        try:
            if files.format == "edf":
                raw = mne.io.read_raw_edf(path, preload=preload, infer_types=False, verbose="warning")
            elif files.format == "bdf":
                raw = mne.io.read_raw_bdf(path, preload=preload, infer_types=False, verbose="warning")
            else:
                raw = mne.io.read_raw_brainvision(path, preload=preload, verbose="warning")
        except FileNotFoundError as exc:
            raise RecordingLoadError(
                f"A file needed by {path.name} is missing: {exc}", kind="missing_companion"
            ) from exc
        except Exception as exc:  # MNE raises many types for corrupt headers
            raise RecordingLoadError(
                f"{path.name} could not be read as a {files.format_name} recording: {exc}",
                kind="corrupt_recording",
                details=repr(exc),
            ) from exc
    messages = [str(w.message) for w in caught]
    if files.format in ("edf", "bdf"):
        # Already reported, in plain words, by _check_edf.
        messages = [m for m in messages if EDF_SIZE_WARNING not in m]
    fatal = [m for m in messages if any(p in m for p in FATAL_WARNING_PATTERNS)]
    if fatal:
        hint = ""
        if any("outside data range" in m for m in fatal):
            hint = (
                " Some markers lie beyond the end of the EEG data, so the data file is probably truncated "
                "(for example an interrupted copy)."
            )
        raise RecordingLoadError(
            "The recording appears to be incomplete or inconsistent." + hint + " Details: " + "; ".join(fatal),
            kind="inconsistent_recording",
        )
    return raw, messages


def _check_edf(files: RecordingFiles) -> list[str]:
    """Check an EDF/BDF file against its header; return warnings, raise on fatal problems."""
    header = files.header
    if not isinstance(header, EdfHeader):
        return []
    if header.is_discontinuous:
        raise RecordingLoadError(
            f"{files.path.name} is an {header.file_type} file (discontinuous: its data records are not "
            "contiguous in time). MNE-Python reads such files as if they were continuous, so annotation times "
            "would not match the recording. Convert it to a continuous file first.",
            kind="unsupported_format",
        )
    try:
        size = files.path.stat().st_size
    except OSError as exc:
        raise RecordingLoadError(f"Cannot read {files.path.name}: {exc}", kind="permission") from exc
    fatal, notes = header.size_problems(size)
    if fatal:
        raise RecordingLoadError(
            f"{files.path.name}: " + "; ".join(fatal) + ".", kind="corrupt_recording"
        )
    return [f"{files.format_name}: {n}" for n in notes]


def _check_data_size(files: RecordingFiles, n_ch: int | None) -> None:
    """Check that a BrainVision data file holds a whole number of samples."""
    header = files.header
    if files.format != "brainvision" or header is None or files.eeg is None or not n_ch:
        return
    bps = BYTES_PER_SAMPLE.get((header.binary_format or "").upper())
    if bps is None:
        return
    size = files.eeg.stat().st_size
    frame = n_ch * bps
    if size == 0:
        raise RecordingLoadError(f"Data file {files.eeg.name} is empty", kind="corrupt_recording")
    if size % frame != 0:
        raise RecordingLoadError(
            f"Data file {files.eeg.name} has {size} bytes, which is not a whole number of samples "
            f"for {n_ch} channels of {header.binary_format}. The file is probably truncated or corrupted.",
            kind="corrupt_recording",
        )
    if header.data_points is not None and header.data_points != size // frame:
        raise RecordingLoadError(
            f"Header says {header.data_points} samples but {files.eeg.name} contains {size // frame}",
            kind="corrupt_recording",
        )


def _discontinuities(raw: Any, timing: RecordingTiming) -> list[int]:
    out = []
    for a in raw.annotations:
        if str(a["description"]).lower().startswith("new segment"):
            s = timing.time_to_sample(timing.from_mne_onset(float(a["onset"])))
            if s > 0:
                out.append(s)
    return sorted(set(out))


def _acquisition_gaps(raw: Any, timing: RecordingTiming) -> list[tuple[int, int]]:
    """Sample ranges [start, stop) that the file marks as having no recorded data."""
    out = []
    for a in raw.annotations:
        if str(a["description"]).lower().startswith(ACQUISITION_GAP_PREFIX):
            start = timing.time_to_sample(timing.from_mne_onset(float(a["onset"])))
            stop = start + max(1, timing.duration_to_samples(float(a["duration"])))
            start, stop = max(0, start), min(timing.n_samples, stop)
            if stop > start:
                out.append((start, stop))
    return sorted(set(out))


def hidden_channels(ch_names: list[str], patterns: tuple[str, ...] | list[str]) -> list[str]:
    """Channels whose names match one of the ``channels.hide`` patterns (case-sensitive globs)."""
    return [c for c in ch_names if any(fnmatch.fnmatchcase(c, p) for p in patterns)]


def types_from_patterns(ch_names: list[str], patterns: tuple[tuple[str, str], ...]) -> dict[str, str]:
    """Channel types from the ``channels.types`` setting: the first matching pattern wins."""
    out: dict[str, str] = {}
    for ch in ch_names:
        for pattern, ch_type in patterns:
            if fnmatch.fnmatchcase(ch, pattern):
                out[ch] = ch_type
                break
    return out


def resolve_channel_types(raw: Any, report: ChannelReport, settings: Settings) -> dict[str, str]:
    """Each channel's type as it will be shown: the file's, then channels.tsv's, then the channels.types setting."""
    types = dict(zip(raw.ch_names, raw.get_channel_types()))
    if settings.apply_channel_types_from_bids:
        types.update({ch: t for ch, t in report.types.items() if ch in types})
    types.update(types_from_patterns(list(raw.ch_names), settings.channel_type_patterns))
    return types


def load_recording(
    files: RecordingFiles,
    settings: Settings,
    filters: FilterSettings,
    catalogue: LabelCatalogue,
    *,
    progress: ProgressCallback | None = None,
    cache_dir: Path | None = None,
) -> LoadedRecording:
    """Validate and open a recording; return the viewing copy and all checks."""

    def say(msg: str) -> None:
        if progress is not None:
            progress(msg)

    if files.problems:
        # BrainVision problems are missing or misnamed companion files; an EDF/BDF problem is the file itself.
        kind = "missing_companion" if files.format == "brainvision" else "corrupt_recording"
        raise RecordingLoadError("; ".join(files.problems), kind=kind)

    say("Checking source files")
    try:
        fingerprint = fingerprint_sources(files, compute_hash=settings.hash_source_files)
    except OSError as exc:
        raise RecordingLoadError(f"Cannot read the recording files: {exc}", kind="permission") from exc

    say("Reading recording header and markers")
    edf_notes = _check_edf(files)
    if files.format == "brainvision":
        _check_data_size(files, files.header.n_channels if files.header else None)
    raw, mne_messages = _read_raw(files, preload=False)
    _check_data_size(files, len(raw.ch_names))
    timing = RecordingTiming.from_raw(raw)
    warnings_out = list(edf_notes) + [f"MNE: {m}" for m in mne_messages]
    warnings_out.extend(f"BIDS: {w}" for w in files.sidecars.warnings)

    say("Checking channels")
    channel_report = check_channels(list(raw.ch_names), files.channels_tsv)
    warnings_out.extend(f"Channels: {p}" for p in channel_report.problems)
    ch_types = resolve_channel_types(raw, channel_report, settings)
    # Trigger channels hold event codes, not signal: they are read for the original events and
    # are never shown, annotated or counted in the whole montage.
    triggers = [c for c in raw.ch_names if ch_types.get(c) == "stim"]

    say("Reading original events")
    if files.events_tsv is not None:
        try:
            original = events_from_tsv(files.events_tsv, timing)
        except TSVError as exc:
            raise RecordingLoadError(str(exc), kind="malformed_bids_metadata") from exc
        original.comparison = compare_with_markers(original, raw, timing, files.format)
        if not original.comparison["consistent"]:
            where = (
                "the BrainVision marker file" if files.format == "brainvision"
                else f"the {files.format_name}+ annotations"
            )
            warnings_out.append(
                f"events.tsv and {where} disagree: "
                f"{original.comparison['events_tsv_rows_without_marker']} events.tsv row(s) have no marker "
                f"and {original.comparison['markers_without_events_tsv_row']} marker(s) have no events.tsv row"
            )
    else:
        original = events_from_raw_annotations(raw, timing, files.vmrk if files.format == "brainvision" else files.path,
                                               files.format)
        if original.source == SOURCE_NONE and triggers:
            say(f"Reading triggers from the {', '.join(triggers)} channel" + ("s" if len(triggers) > 1 else ""))
            original = events_from_stim_channels(raw, triggers, timing, files.path, files.format)
    from electroclean.app.io.export import ELECTROCLEAN_COLUMNS

    clash = [c for c in ELECTROCLEAN_COLUMNS if c in original.columns]
    if clash:
        raise RecordingLoadError(
            f"The recording's events.tsv already has column(s) {', '.join(clash)}, which ElectroClean uses for its "
            "own information (is it an ElectroClean output file?). Rename them in a copy of the dataset.",
            kind="malformed_bids_metadata",
        )
    out_of_range = [
        i + 1 for i, s in enumerate(original.sample) if s is not None and not (0 <= s < timing.n_samples)
    ]
    if out_of_range:
        warnings_out.append(f"{len(out_of_range)} original event(s) lie outside the recording: rows {out_of_range[:10]}")
    warnings_out.extend(f"Events: {p}" for p in original.problems)

    event_report = check_event_codes(original, catalogue)
    warnings_out.extend(f"Events: {line}" for line in event_report.summary_lines())

    events_sidecar, problems = load_json_chain(files.sidecars.events_json_chain)
    warnings_out.extend(f"BIDS: {p}" for p in problems)
    eeg_sidecar, problems = load_json_chain(files.sidecars.eeg_json_chain)
    warnings_out.extend(f"BIDS: {p}" for p in problems)
    sf_json = eeg_sidecar.get("SamplingFrequency")
    if isinstance(sf_json, (int, float)) and abs(float(sf_json) - timing.sfreq) > 1e-6:
        warnings_out.append(
            f"eeg.json SamplingFrequency ({sf_json} Hz) differs from the recording ({timing.sfreq} Hz)"
        )
    plf = eeg_sidecar.get("PowerLineFrequency")
    if filters.notch_enabled and isinstance(plf, (int, float)) and float(plf) != float(filters.notch_hz):
        warnings_out.append(
            f"eeg.json gives a power-line frequency of {plf} Hz but the notch filter is set to {filters.notch_hz:g} Hz"
        )

    discontinuities = _discontinuities(raw, timing)
    if discontinuities:
        warnings_out.append(
            f"The recording has {len(discontinuities)} discontinuity marker(s) (BrainVision 'New Segment')"
        )
    gaps = _acquisition_gaps(raw, timing)
    if gaps:
        total = sum(b - a for a, b in gaps) / timing.sfreq
        tail = " (at the end of the file, probably padding of the last data record)" if (
            len(gaps) == 1 and gaps[0][1] == timing.n_samples) else ""
        warnings_out.append(
            f"The file marks {len(gaps)} stretch(es) without recorded data (BAD_ACQ_SKIP), {total:.3f} s in total"
            f"{tail}; they are hatched in the viewer and filtered separately"
        )

    hidden_by_setting = hidden_channels(list(raw.ch_names), settings.hidden_channel_patterns)
    hidden_set = set(hidden_by_setting) | set(triggers)
    hidden = [c for c in raw.ch_names if c in hidden_set]
    shown = [c for c in raw.ch_names if c not in hidden_set]
    if not shown:
        raise RecordingLoadError(
            "Every channel of the recording matches the channels.hide setting or is a trigger channel, so nothing "
            "could be shown. Change channels.hide or channels.types in the study configuration.",
            kind="no_channels",
        )

    say("Preparing the display copy")
    needs_data = filters.highpass_enabled or filters.notch_enabled
    cache_path: Path | None = None
    storage = "read from source file on demand (not filtered)"
    if needs_data:
        n_bytes = len(shown) * timing.n_samples * 8
        view_raw, _ = _read_raw(files, preload=False)
        if hidden:
            view_raw.pick(shown)  # hidden channels are never read
        if n_bytes <= settings.preload_memory_limit_mb * 1024 * 1024:
            view_raw.load_data(verbose="error")
            storage = "in memory"
        else:
            base = Path(tempfile.mkdtemp(prefix="electroclean-", dir=cache_dir))
            cache_path = base / "view_data.dat"
            view_raw.load_data(memmap=str(cache_path), verbose="error")
            storage = f"temporary memory-mapped file ({n_bytes / 1e9:.2f} GB)"
    else:
        view_raw = raw
        if hidden:
            view_raw.pick(shown)
    view_raw.set_annotations(None)
    notes_out: list[str] = []
    if hidden_by_setting:
        notes_out.append(
            f"{len(hidden_by_setting)} channel(s) matching channels.hide are not shown and cannot be annotated: "
            + ", ".join(hidden_by_setting)
        )
    if triggers:
        used = "; the original events were read from them" if original.stim_channels else ""
        notes_out.append(
            f"Trigger channel(s) not shown and not part of the montage{used}: " + ", ".join(triggers)
        )
    notes_out.extend(
        apply_channel_metadata(
            view_raw,
            channel_report,
            apply_types=settings.apply_channel_types_from_bids,
            show_bads=settings.show_bids_bad_channels,
        )
    )
    notes_out.extend(_apply_type_patterns(view_raw, settings))
    if needs_data:
        say("Applying display filters")
    try:
        filter_report = apply_view_filters(view_raw, filters, discontinuities, gaps, progress=say)
    except Exception as exc:
        raise RecordingLoadError(f"Filtering failed: {exc}", kind="filter_error") from exc
    filter_report.data_storage = storage
    for skipped in filter_report.skipped:
        warnings_out.append(f"Filters: {skipped}")

    say("Checking the signal amplitude")
    try:
        amplitude_report = check_amplitudes(
            view_raw, gaps=gaps, edge_samples=int(round(filter_report.transient_half_width_s * timing.sfreq))
        )
    except Exception as exc:  # noqa: BLE001 - the check must never stop a recording from opening
        amplitude_report = AmplitudeReport()
        warnings_out.append(f"The signal amplitude could not be checked: {exc}")
    warnings_out.extend(amplitude_report.warnings)

    info = RecordingInfo(
        recording_id=files.recording_id,
        timing=timing,
        ch_names=tuple(shown),
        relative_path=files.recording_id,
        fingerprint=fingerprint,
        hidden_channels=tuple(hidden),
    )
    return LoadedRecording(
        files=files,
        info=info,
        view_raw=view_raw,
        original_events=original,
        event_report=event_report,
        channel_report=channel_report,
        filter_report=filter_report,
        fingerprint=fingerprint,
        events_sidecar=events_sidecar,
        eeg_sidecar=eeg_sidecar,
        discontinuity_samples=discontinuities,
        acquisition_gaps=gaps,
        hidden_channels=hidden,
        warnings=warnings_out,
        notes=notes_out,
        cache_path=cache_path,
        trigger_channels=triggers,
        amplitude_report=amplitude_report,
    )


def _apply_type_patterns(view_raw: Any, settings: Settings) -> list[str]:
    """Apply the channels.types setting to the display copy (after channels.tsv, so the setting wins)."""
    wanted = types_from_patterns(list(view_raw.ch_names), settings.channel_type_patterns)
    current = dict(zip(view_raw.ch_names, view_raw.get_channel_types()))
    mapping = {ch: t for ch, t in wanted.items() if current.get(ch) != t}
    if not mapping:
        return []
    try:
        view_raw.set_channel_types(mapping, on_unit_change="ignore", verbose="error")
    except (ValueError, KeyError) as exc:
        return [f"Could not apply the channels.types setting: {exc}"]
    return [f"Display channel types set from the channels.types setting for {len(mapping)} channel(s)"]
