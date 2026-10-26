"""Validation of recording channels against the BIDS ``channels.tsv`` file.

The channel names stored in the EEG recording are authoritative: annotations
always refer to them. ``channels.tsv`` is used to check consistency, to show
channel types (EOG, ECG, ...) with suitable scaling, and to grey out channels
that the dataset marks as bad. None of this changes any file.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from electroclean.app.io.tsv import TSVError, read_tsv, rows_as_dicts

BIDS_TO_MNE_TYPES = {
    "EEG": "eeg",
    "EOG": "eog",
    "VEOG": "eog",
    "HEOG": "eog",
    "ECG": "ecg",
    "EMG": "emg",
    "MISC": "misc",
    "TRIG": "stim",
    "RESP": "resp",
    "GSR": "gsr",
    "TEMP": "temperature",
    "REF": "eeg",
    "PPG": "bio",
    "AUDIO": "misc",
    "SYSCLOCK": "misc",
}


@dataclass
class ChannelReport:
    path: Path | None
    recording_channels: list[str]
    tsv_channels: list[str] = field(default_factory=list)
    missing_from_tsv: list[str] = field(default_factory=list)
    missing_from_recording: list[str] = field(default_factory=list)
    order_differs: bool = False
    types: dict[str, str] = field(default_factory=dict)
    bads: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)

    @property
    def consistent(self) -> bool:
        return not (self.missing_from_tsv or self.missing_from_recording or self.problems)

    def to_dict(self) -> dict[str, Any]:
        return {
            "channels_tsv": self.path.name if self.path else None,
            "n_recording_channels": len(self.recording_channels),
            "n_tsv_channels": len(self.tsv_channels),
            "missing_from_channels_tsv": self.missing_from_tsv,
            "missing_from_recording": self.missing_from_recording,
            "order_differs": self.order_differs,
            "bids_types": self.types,
            "bids_bad_channels": self.bads,
            "problems": self.problems,
            "consistent": self.consistent,
        }


def check_channels(recording_channels: list[str], channels_tsv: Path | None) -> ChannelReport:
    report = ChannelReport(path=channels_tsv, recording_channels=list(recording_channels))
    if channels_tsv is None:
        return report
    try:
        columns, rows = read_tsv(channels_tsv)
    except TSVError as exc:
        report.problems.append(f"channels.tsv could not be read: {exc}")
        return report
    if "name" not in columns:
        report.problems.append("channels.tsv has no 'name' column")
        return report
    records = rows_as_dicts(columns, rows)
    names = [r["name"] for r in records]
    report.tsv_channels = names
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        report.problems.append(f"channels.tsv lists channels more than once: {dupes}")
    rec_set, tsv_set = set(recording_channels), set(names)
    report.missing_from_tsv = [c for c in recording_channels if c not in tsv_set]
    report.missing_from_recording = [c for c in names if c not in rec_set]
    common_rec = [c for c in recording_channels if c in tsv_set]
    common_tsv = [c for c in names if c in rec_set]
    report.order_differs = common_rec != common_tsv
    for r in records:
        name = r["name"]
        if name not in rec_set:
            continue
        btype = r.get("type", "").strip().upper()
        if btype in BIDS_TO_MNE_TYPES:
            report.types[name] = BIDS_TO_MNE_TYPES[btype]
        if r.get("status", "").strip().lower() == "bad":
            report.bads.append(name)
    if report.missing_from_tsv:
        report.problems.append(
            "Channels in the recording but not in channels.tsv: " + ", ".join(report.missing_from_tsv)
        )
    if report.missing_from_recording:
        report.problems.append(
            "Channels in channels.tsv but not in the recording: " + ", ".join(report.missing_from_recording)
        )
    return report


def apply_channel_metadata(raw: Any, report: ChannelReport, *, apply_types: bool, show_bads: bool) -> list[str]:
    """Apply BIDS channel types and bad-channel flags to the *viewing copy* only."""
    notes = []
    if apply_types and report.types:
        current = dict(zip(raw.ch_names, raw.get_channel_types()))
        mapping = {ch: t for ch, t in report.types.items() if current.get(ch) != t}
        if mapping:
            try:
                raw.set_channel_types(mapping, on_unit_change="ignore", verbose="error")
                notes.append(f"Display channel types set from channels.tsv for {len(mapping)} channel(s)")
            except (ValueError, KeyError) as exc:
                notes.append(f"Could not apply channel types from channels.tsv: {exc}")
    if show_bads and report.bads:
        raw.info["bads"] = [c for c in report.bads if c in raw.ch_names]
        notes.append("Channels marked bad in channels.tsv are shown in grey: " + ", ".join(report.bads))
    return notes
