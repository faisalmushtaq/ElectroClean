"""Verification of exported files before a recording is marked complete.

Each check re-reads the bytes that were written and compares them with the
in-memory annotations, so a successful validation proves that the files on disk
can reproduce every onset, duration, label and channel selection exactly, and
that the original event rows are unchanged.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from electroclean.app.annotations.model import AnnotationDocument
from electroclean.app.eeg.events import SOURCE_NONE, OriginalEvents, parse_float
from electroclean.app.io.canonical import document_from_dict
from electroclean.app.io.export import (
    ELECTROCLEAN_COLUMNS,
    REQUIRED_COLUMNS,
    annotations_from_events_tsv,
    original_rows_from_events_tsv,
)
from electroclean.app.io.tsv import parse_tsv_text


class ValidationError(ValueError):
    """Raised when an exported file does not match what was annotated."""


def _key(a: Any) -> tuple:
    return (a.annotation_id, a.label, a.onset_sample, a.duration_samples, tuple(a.channels))


def validate_annotation_document(doc: AnnotationDocument, min_samples: int = 1) -> None:
    try:
        doc.validate(min_samples)
    except ValueError as exc:
        raise ValidationError(f"Annotation records are invalid: {exc}") from exc


def validate_events_tsv(data: bytes, original: OriginalEvents, doc: AnnotationDocument) -> None:
    text = data.decode("utf-8")
    columns, rows = parse_tsv_text(text, "events.tsv")
    for col in REQUIRED_COLUMNS + ELECTROCLEAN_COLUMNS:
        if col not in columns:
            raise ValidationError(f"events.tsv is missing column {col!r}")
    if original.source != SOURCE_NONE and columns[: len(original.columns)] != original.columns:
        raise ValidationError("events.tsv does not start with the original columns in their original order")
    # Original rows must be reproduced exactly.
    cols, orig_rows = original_rows_from_events_tsv(text)
    n_orig = len(original.columns) if original.source != SOURCE_NONE else 0
    rebuilt = [r[:n_orig] for r in orig_rows]
    expected = [list(r) for r in original.rows] if original.source != SOURCE_NONE else []
    if rebuilt != expected:
        raise ValidationError("Original event rows in events.tsv differ from the source events")
    # Artifact rows must reproduce the annotations exactly.
    recovered = annotations_from_events_tsv(text, doc.recording, doc.catalogue)
    if sorted(map(_key, recovered)) != sorted(map(_key, doc.annotations)):
        raise ValidationError("Artifact rows in events.tsv do not reproduce the annotations")
    idx = {c: i for i, c in enumerate(columns)}
    for n, row in enumerate(rows, start=2):
        artifact = row[idx["event_source"]] == "electroclean_artifact"
        if parse_float(row[idx["onset"]]) is None and artifact:
            raise ValidationError(f"events.tsv line {n} has a non-numeric onset")
        if artifact and row[idx["value"]] != "n/a":
            raise ValidationError(f"events.tsv line {n}: artifact rows must leave value as n/a")
        if not artifact and row[idx["artifact_code"]] != "n/a":
            raise ValidationError(f"events.tsv line {n}: original rows must not have an artifact_code")
    if len(rows) != len(original.rows) + len(doc.annotations):
        raise ValidationError("events.tsv has an unexpected number of rows")


def validate_annotations_json(data: bytes, doc: AnnotationDocument) -> None:
    try:
        parsed = document_from_dict(json.loads(data.decode("utf-8")))
    except Exception as exc:
        raise ValidationError(f"annotations.json cannot be read back: {exc}") from exc
    if sorted(map(_key, parsed.annotations)) != sorted(map(_key, doc.annotations)):
        raise ValidationError("annotations.json does not reproduce the annotations")
    if parsed.recording.recording_id != doc.recording.recording_id:
        raise ValidationError("annotations.json refers to a different recording")
    if parsed.annotator_id != doc.annotator_id:
        raise ValidationError("annotations.json refers to a different annotator")
    if parsed.recording.timing != doc.recording.timing:
        raise ValidationError("annotations.json timing metadata differs")
    if parsed.recording.ch_names != doc.recording.ch_names:
        raise ValidationError("annotations.json channel list differs")


def validate_time_file(data: bytes, elapsed_s: float) -> None:
    text = data.decode("utf-8").strip()
    try:
        value = float(text)
    except ValueError as exc:
        raise ValidationError(f"time_viewed.txt does not contain a single number: {text!r}") from exc
    if "\n" in text or abs(value - elapsed_s) > 0.001:
        raise ValidationError("time_viewed.txt does not match the measured time")


def validate_json_object(data: bytes, name: str, required: tuple[str, ...] = ()) -> dict[str, Any]:
    try:
        obj = json.loads(data.decode("utf-8"))
    except ValueError as exc:
        raise ValidationError(f"{name} is not valid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise ValidationError(f"{name} does not contain a JSON object")
    missing = [k for k in required if k not in obj]
    if missing:
        raise ValidationError(f"{name} lacks required keys {missing}")
    return obj


def make_bundle_validator(
    original: OriginalEvents, doc: AnnotationDocument, elapsed_s: float
) -> Callable[[dict[str, bytes]], None]:
    """Return a function that validates a dict of output-key -> file bytes."""

    def validate(files: dict[str, bytes]) -> None:
        validate_events_tsv(files["events_tsv"], original, doc)
        validate_annotations_json(files["annotations_json"], doc)
        validate_time_file(files["time_viewed"], elapsed_s)
        validate_json_object(files["events_json"], "events.json", ("trial_type", "channels", "event_source"))
        validate_json_object(
            files["session_json"], "session.json", ("schema", "session_id", "recording", "annotator", "timing")
        )

    return validate
