"""Original experimental events: loading, display and code-conflict checks.

Original events come from the recording's BIDS ``events.tsv`` when one exists
(its rows are kept exactly as strings) and otherwise from the BrainVision
marker file as read by MNE. They are never edited. In the viewer they are drawn
as vertical event lines, which cannot be moved or deleted, while artifact
annotations are drawn as shaded intervals.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from electroclean.app.annotations.labels import LabelCatalogue
from electroclean.app.annotations.timing import RecordingTiming
from electroclean.app.io.tsv import TSVError, read_tsv

SOURCE_EVENTS_TSV = "events_tsv"
SOURCE_VMRK = "brainvision_vmrk"
SOURCE_NONE = "none"


def format_seconds(value: float) -> str:
    """Shortest string that round-trips to the same float (e.g. '12.004', '3.0')."""
    if not math.isfinite(value):
        raise ValueError(f"Cannot format non-finite time {value}")
    return repr(float(value))


def parse_float(text: str) -> float | None:
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def parse_int_code(text: str) -> int | None:
    """Parse an event code such as '101' or '101.0'; return None if not an integer."""
    if text is None:
        return None
    s = str(text).strip()
    try:
        return int(s)
    except ValueError:
        pass
    f = parse_float(s)
    if f is not None and float(f).is_integer():
        return int(f)
    return None


@dataclass
class OriginalEvents:
    """Original event rows, kept as strings, plus parsed timing for display."""

    source: str
    path: Path | None
    columns: list[str]
    rows: list[list[str]]
    onset_s: list[float | None] = field(default_factory=list)
    sample: list[int | None] = field(default_factory=list)
    sample_computed: bool = False
    problems: list[str] = field(default_factory=list)
    comparison: dict[str, Any] = field(default_factory=dict)

    def __len__(self) -> int:
        return len(self.rows)

    def column(self, name: str) -> list[str]:
        if name not in self.columns:
            return ["n/a"] * len(self.rows)
        i = self.columns.index(name)
        return [row[i] for row in self.rows]

    @property
    def trial_types(self) -> list[str]:
        return self.column("trial_type")

    @property
    def values(self) -> list[str]:
        return self.column("value")

    def display_events(self, timing: RecordingTiming) -> tuple[np.ndarray, dict[str, int]]:
        """Events array and event_id mapping for ``raw.plot`` (display only).

        Display codes are assigned per distinct label so that each line is
        labelled with its ``trial_type`` text; they are not the original
        ``value`` codes and are never written to any file.
        """
        labels = []
        samples = []
        tts = self.trial_types
        vals = self.values
        for i, s in enumerate(self.sample):
            if s is None or s < 0 or s >= timing.n_samples:
                continue
            label = tts[i] if tts[i] not in ("", "n/a") else f"value {vals[i]}"
            labels.append(label)
            samples.append(s)
        codes: dict[str, int] = {}
        for label in labels:
            codes.setdefault(label, len(codes) + 1)
        if not samples:
            return np.zeros((0, 3), dtype=int), {}
        ev = np.array(
            [[s + timing.first_samp, 0, codes[lab]] for s, lab in zip(samples, labels)], dtype=int
        )
        order = np.argsort(ev[:, 0], kind="stable")
        return ev[order], codes


def _parse_rows(ev: OriginalEvents, timing: RecordingTiming) -> None:
    onset_col = ev.column("onset")
    has_sample = "sample" in ev.columns
    sample_col = ev.column("sample")
    for i in range(len(ev.rows)):
        onset = parse_float(onset_col[i])
        ev.onset_s.append(onset)
        sample: int | None = None
        if has_sample:
            sample = parse_int_code(sample_col[i])
            if sample is None and sample_col[i] not in ("n/a", ""):
                ev.problems.append(f"Row {i + 1}: sample value {sample_col[i]!r} is not an integer")
        if sample is None and onset is not None:
            sample = timing.time_to_sample(onset)
        if onset is None:
            ev.problems.append(f"Row {i + 1}: onset {onset_col[i]!r} is not a number")
        elif has_sample and sample is not None:
            implied = timing.time_to_sample(onset)
            if abs(implied - sample) > 1:
                ev.problems.append(
                    f"Row {i + 1}: onset {onset_col[i]} s implies sample {implied} but the sample "
                    f"column says {sample}"
                )
        ev.sample.append(sample)
    ev.sample_computed = not has_sample


def events_from_tsv(path: Path, timing: RecordingTiming) -> OriginalEvents:
    try:
        columns, rows = read_tsv(path)
    except TSVError as exc:
        raise TSVError(f"The BIDS events file {path.name} is malformed: {exc}") from exc
    ev = OriginalEvents(source=SOURCE_EVENTS_TSV, path=path, columns=columns, rows=rows)
    if "onset" not in columns or "duration" not in columns:
        ev.problems.append(f"{path.name} lacks the required BIDS columns 'onset' and 'duration'")
    _parse_rows(ev, timing)
    return ev


def events_from_raw_annotations(raw: Any, timing: RecordingTiming, vmrk: Path | None) -> OriginalEvents:
    """Build event rows from the BrainVision markers that MNE read into ``raw``.

    ``trial_type`` is MNE's marker description (e.g. ``Stimulus/S  1``) and
    ``value`` is the integer MNE's BrainVision parser assigns to it (for
    example 1 for ``Stimulus/S  1`` and 1001 for ``Response/R  1``).
    """
    import mne

    columns = ["onset", "duration", "trial_type", "value", "sample", "channels"]
    rows: list[list[str]] = []
    ann = raw.annotations
    if len(ann):
        _, event_id = mne.events_from_annotations(raw, regexp=None, verbose="error")
    else:
        event_id = {}
    for a in ann:
        onset_rel = timing.from_mne_onset(float(a["onset"]))
        sample = timing.time_to_sample(onset_rel)
        desc = str(a["description"])
        ch = a.get("ch_names", ()) or ()
        rows.append(
            [
                format_seconds(sample / timing.sfreq),
                format_seconds(float(a["duration"])),
                desc,
                str(event_id.get(desc, "n/a")),
                str(sample),
                json.dumps(list(ch), ensure_ascii=False) if ch else "n/a",
            ]
        )
    ev = OriginalEvents(source=SOURCE_VMRK if len(rows) else SOURCE_NONE, path=vmrk, columns=columns, rows=rows)
    _parse_rows(ev, timing)
    return ev


def compare_with_markers(tsv_events: OriginalEvents, raw: Any, timing: RecordingTiming) -> dict[str, Any]:
    """Compare events.tsv samples with BrainVision marker samples (warnings only)."""
    marker_samples = sorted(
        timing.time_to_sample(timing.from_mne_onset(float(a["onset"])))
        for a in raw.annotations
        if not str(a["description"]).lower().startswith("new segment")
    )
    tsv_samples = sorted(s for s in tsv_events.sample if s is not None)
    remaining = list(marker_samples)
    unmatched = 0
    for s in tsv_samples:
        hit = next((m for m in remaining if abs(m - s) <= 1), None)
        if hit is None:
            unmatched += 1
        else:
            remaining.remove(hit)
    return {
        "n_events_tsv": len(tsv_events),
        "n_vmrk_markers": len(marker_samples),
        "events_tsv_rows_without_marker": unmatched,
        "markers_without_events_tsv_row": len(remaining),
        "consistent": unmatched == 0 and not remaining,
    }


@dataclass
class EventCodeReport:
    """What the original events look like, for the record and for the research team.

    Artifact codes are written to their own ``artifact_code`` column, so original
    event codes can never clash with them and nothing here blocks annotation.
    """

    codes_also_used_for_artifacts: list[int] = field(default_factory=list)
    artifact_label_rows: list[dict[str, Any]] = field(default_factory=list)
    value_meaning_conflicts: dict[str, list[str]] = field(default_factory=dict)
    label_value_conflicts: dict[str, list[str]] = field(default_factory=dict)
    repeated_values: dict[str, int] = field(default_factory=dict)

    def summary_lines(self) -> list[str]:
        lines = []
        if self.artifact_label_rows:
            labels = sorted({r["trial_type"] for r in self.artifact_label_rows})
            lines.append(
                f"{len(self.artifact_label_rows)} original event(s) already use HED-SCORE artifact names as "
                f"trial_type ({', '.join(labels)}); they are kept as original events."
            )
        for value, meanings in self.value_meaning_conflicts.items():
            lines.append(f"Original code {value} is used for different events: {meanings}.")
        for label, values in self.label_value_conflicts.items():
            lines.append(f"Original event type {label!r} appears with different codes: {values}.")
        return lines

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifact_codes_column": "artifact_code",
            "codes_also_used_for_artifacts": self.codes_also_used_for_artifacts,
            "note": (
                "Original values are kept unchanged in the value column; artifact codes are in the separate "
                "artifact_code column, so the two can never be confused."
            ),
            "artifact_label_rows": self.artifact_label_rows,
            "value_meaning_conflicts": self.value_meaning_conflicts,
            "label_value_conflicts": self.label_value_conflicts,
            "repeated_values": self.repeated_values,
            "summary": self.summary_lines(),
        }


def check_event_codes(events: OriginalEvents, catalogue: LabelCatalogue) -> EventCodeReport:
    """Describe the original event codes; flag inconsistent code meanings.

    Repeated codes are normal (many trials share a code) and are only counted.
    A code used for more than one ``trial_type``, or a ``trial_type`` that
    appears with more than one code, is reported as an inconsistency for the
    research team to review. Original codes that coincide with artifact codes
    are only noted: artifact codes live in their own column. Nothing is
    renumbered.
    """
    report = EventCodeReport()
    artifact_codes = set(catalogue.values)
    shared: set[int] = set()
    by_value: dict[str, set[str]] = {}
    by_label: dict[str, set[str]] = {}
    counts: dict[str, int] = {}
    for i, (tt, val) in enumerate(zip(events.trial_types, events.values)):
        code = parse_int_code(val)
        key = str(code) if code is not None else val
        if val not in ("", "n/a"):
            counts[key] = counts.get(key, 0) + 1
            by_value.setdefault(key, set()).add(tt)
        if tt not in ("", "n/a"):
            by_label.setdefault(tt, set()).add(key)
        if code is not None and code in artifact_codes:
            shared.add(code)
        if catalogue.is_permitted(tt):
            report.artifact_label_rows.append({"row": i + 1, "value": val, "trial_type": tt})
    report.codes_also_used_for_artifacts = sorted(shared)
    report.value_meaning_conflicts = {
        k: sorted(v) for k, v in sorted(by_value.items()) if len({x for x in v if x not in ("", "n/a")}) > 1
    }
    report.label_value_conflicts = {
        k: sorted(v) for k, v in sorted(by_label.items()) if len({x for x in v if x not in ("", "n/a")}) > 1
    }
    report.repeated_values = {k: c for k, c in sorted(counts.items()) if c > 1}
    return report
