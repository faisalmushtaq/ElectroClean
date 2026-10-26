"""Loading a BrainVision recording for annotation.

:func:`load_recording` checks the companion files, reads the recording with
``mne.io.read_raw_brainvision``, validates it against its BIDS metadata,
collects the original events, and prepares a separate viewing copy to which
the chosen display filters are applied. Source files are only ever opened for
reading.
"""

from __future__ import annotations

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
from electroclean.app.eeg.channels import ChannelReport, apply_channel_metadata, check_channels
from electroclean.app.eeg.events import (
    EventCodeReport,
    OriginalEvents,
    check_event_codes,
    compare_with_markers,
    events_from_raw_annotations,
    events_from_tsv,
)
from electroclean.app.eeg.filtering import FilterReport, apply_view_filters
from electroclean.app.io.atomic import sha256_file
from electroclean.app.io.bids import load_json_chain
from electroclean.app.io.discovery import RecordingFiles
from electroclean.app.io.tsv import TSVError
from electroclean.config.settings import FilterSettings, Settings

ProgressCallback = Callable[[str], None]

BYTES_PER_SAMPLE = {"INT_16": 2, "INT_32": 4, "IEEE_FLOAT_32": 4, "UINT_16": 2}

# MNE warnings that mean the recording cannot be annotated faithfully.
FATAL_WARNING_PATTERNS = (
    "outside data range",  # markers beyond the end of the data: truncated .eeg file
    "not found; no annotations",  # marker file missing: original events would be lost
)


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
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    cache_path: Path | None = None

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


def _read_raw(vhdr: Path, preload: bool | str) -> tuple[Any, list[str]]:
    import mne

    from mne.utils import catch_logging

    # MNE only emits its warnings (e.g. "markers outside data range") when its
    # log level is WARNING or lower; they are captured here, not printed.
    with warnings.catch_warnings(record=True) as caught, catch_logging():
        warnings.simplefilter("always")
        try:
            raw = mne.io.read_raw_brainvision(vhdr, preload=preload, verbose="warning")
        except FileNotFoundError as exc:
            raise RecordingLoadError(
                f"A file needed by {vhdr.name} is missing: {exc}", kind="missing_companion"
            ) from exc
        except Exception as exc:  # MNE raises many types for corrupt headers
            raise RecordingLoadError(
                f"{vhdr.name} could not be read as a BrainVision recording: {exc}",
                kind="corrupt_recording",
                details=repr(exc),
            ) from exc
    messages = [str(w.message) for w in caught]
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


def _check_data_size(files: RecordingFiles, n_ch: int | None) -> None:
    """Check that the binary data file holds a whole number of samples."""
    header = files.header
    if header is None or files.eeg is None or not n_ch:
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
        raise RecordingLoadError("; ".join(files.problems), kind="missing_companion")

    say("Checking source files")
    try:
        fingerprint = fingerprint_sources(files, compute_hash=settings.hash_source_files)
    except OSError as exc:
        raise RecordingLoadError(f"Cannot read the recording files: {exc}", kind="permission") from exc

    say("Reading recording header and markers")
    _check_data_size(files, files.header.n_channels if files.header else None)
    raw, mne_messages = _read_raw(files.vhdr, preload=False)
    _check_data_size(files, len(raw.ch_names))
    timing = RecordingTiming.from_raw(raw)
    warnings_out = [f"MNE: {m}" for m in mne_messages]
    warnings_out.extend(f"BIDS: {w}" for w in files.sidecars.warnings)

    say("Reading original events")
    if files.events_tsv is not None:
        try:
            original = events_from_tsv(files.events_tsv, timing)
        except TSVError as exc:
            raise RecordingLoadError(str(exc), kind="malformed_bids_metadata") from exc
        original.comparison = compare_with_markers(original, raw, timing)
        if not original.comparison["consistent"]:
            warnings_out.append(
                "events.tsv and the BrainVision marker file disagree: "
                f"{original.comparison['events_tsv_rows_without_marker']} events.tsv row(s) have no marker "
                f"and {original.comparison['markers_without_events_tsv_row']} marker(s) have no events.tsv row"
            )
    else:
        original = events_from_raw_annotations(raw, timing, files.vmrk)
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

    event_report = check_event_codes(original, catalogue, settings.collision_policy)
    if event_report.blocked:
        raise RecordingLoadError(
            "Original event codes clash with the artifact codes. "
            + " ".join(event_report.summary_lines())
            + " No mapping policy has been set, so this recording cannot be annotated until the "
            "study administrator sets events.collision_policy (see the user guide).",
            kind="event_code_collision",
        )
    if event_report.has_collisions:
        warnings_out.append(
            "Original event codes overlap artifact codes; both are kept unchanged and distinguished by the "
            "event_source column (policy: preserve_and_flag)."
        )
    warnings_out.extend(
        f"Events: {line}"
        for line in event_report.summary_lines()
        if "different" in line
    )

    say("Checking channels")
    channel_report = check_channels(list(raw.ch_names), files.channels_tsv)
    warnings_out.extend(f"Channels: {p}" for p in channel_report.problems)

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

    say("Preparing the display copy")
    needs_data = filters.highpass_enabled or filters.notch_enabled
    cache_path: Path | None = None
    storage = "read from source file on demand (not filtered)"
    if needs_data:
        n_bytes = len(raw.ch_names) * timing.n_samples * 8
        if n_bytes <= settings.preload_memory_limit_mb * 1024 * 1024:
            view_raw, _ = _read_raw(files.vhdr, preload=True)
            storage = "in memory"
        else:
            base = Path(tempfile.mkdtemp(prefix="electroclean-", dir=cache_dir))
            cache_path = base / "view_data.dat"
            view_raw, _ = _read_raw(files.vhdr, preload=str(cache_path))
            storage = f"temporary memory-mapped file ({n_bytes / 1e9:.2f} GB)"
    else:
        view_raw = raw
    view_raw.set_annotations(None)
    notes_out = list(
        apply_channel_metadata(
            view_raw,
            channel_report,
            apply_types=settings.apply_channel_types_from_bids,
            show_bads=settings.show_bids_bad_channels,
        )
    )
    if needs_data:
        say("Applying display filters")
    try:
        filter_report = apply_view_filters(view_raw, filters, discontinuities)
    except Exception as exc:
        raise RecordingLoadError(f"Filtering failed: {exc}", kind="filter_error") from exc
    filter_report.data_storage = storage
    for skipped in filter_report.skipped:
        warnings_out.append(f"Filters: {skipped}")

    info = RecordingInfo(
        recording_id=files.recording_id,
        timing=timing,
        ch_names=tuple(raw.ch_names),
        relative_path=files.recording_id,
        fingerprint=fingerprint,
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
        warnings=warnings_out,
        notes=notes_out,
        cache_path=cache_path,
    )
