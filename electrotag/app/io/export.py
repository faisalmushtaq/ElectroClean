"""Building the contents of ElectroTag's output files.

Functions here only produce bytes; writing them safely is the job of
:mod:`electrotag.app.session.transaction`.

Events TSV layout
-----------------
The exported ``*_events.tsv`` contains every original event row, unchanged,
followed (in onset order) by one row per artifact annotation. Columns are the
original columns in their original order, then any of ``onset``,
``duration``, ``trial_type``, ``value``, ``sample`` and ``channels`` that the
original lacked, then seven ElectroTag columns:

``event_source``
    ``original:events_tsv``, ``original:brainvision_vmrk``,
    ``original:edf_annotations``, ``original:bdf_annotations`` or
    ``electrotag_artifact``. This always distinguishes original events from
    artifact annotations, even if an original event uses a code from 100-115.
``annotation_id``
    The stable identifier of the artifact annotation (``n/a`` for originals).
``annotator_id``
    Who made the annotation (``n/a`` for originals).
``original_row``
    1-based row number in the original events file (``n/a`` for artifacts),
    so the original table can be rebuilt exactly.
``confidence``
    How sure the annotator was of the artifact: ``definite``, ``probable`` or
    ``possible``; ``n/a`` when no confidence was given, and on original rows.
``annotation_note``
    The annotator's short note on the artifact (``n/a`` when there is none,
    and on original rows).

``artifact_code`` (the first of the seven) holds the artifact's fixed code.
Files written before version 1.1.0 have no ``confidence`` or
``annotation_note`` column; their artifacts are read as having no confidence
given and no note.

``channels`` is a JSON array of channel names for artifact rows. ``[]``
(an empty selection) means the whole recording montage. Original rows keep
their own ``channels`` value if the original file had that column; otherwise
they get ``n/a``.
"""

from __future__ import annotations

import copy
import json
from typing import Any

from electrotag.app.annotations.labels import LabelCatalogue
from electrotag.app.annotations.model import (
    MAX_NOTE_CHARS,
    AnnotationDocument,
    AnnotationError,
    ArtifactAnnotation,
    RecordingInfo,
)
from electrotag.app.annotations.timing import TIME_CONVENTIONS
from electrotag.app.eeg.events import (
    SOURCE_EVENTS_TSV,
    SOURCE_NONE,
    OriginalEvents,
    format_seconds,
    parse_float,
    parse_int_code,
)
from electrotag.app.io.tsv import parse_tsv_text, tsv_bytes

REQUIRED_COLUMNS = ["onset", "duration", "trial_type", "value", "sample", "channels"]
# Artifact codes have their own column, so they can never be confused with the dataset's
# own marker values (which stay in ``value``, untouched).
ELECTROTAG_COLUMNS = ["artifact_code", "event_source", "annotation_id", "annotator_id", "original_row", "confidence",
                      "annotation_note"]
#: Columns that files written by earlier versions may lack (a missing column means unknown).
OPTIONAL_COLUMNS = ("artifact_code", "confidence", "annotation_note")
ARTIFACT_SOURCE = "electrotag_artifact"
NA = "n/a"


class ExportError(RuntimeError):
    """Raised when outputs cannot be generated or fail validation."""


def encode_channels(channels: tuple[str, ...] | list[str]) -> str:
    return json.dumps(list(channels), ensure_ascii=False, separators=(",", ":"))


def decode_channels(text: str) -> tuple[str, ...]:
    value = json.loads(text)
    if not isinstance(value, list) or not all(isinstance(c, str) for c in value):
        raise ValueError(f"channels must be a JSON array of strings, got {text!r}")
    return tuple(value)


def original_source_tag(original: OriginalEvents) -> str:
    return f"original:{original.source}"


def build_events_table(
    original: OriginalEvents, doc: AnnotationDocument
) -> tuple[list[str], list[list[str]]]:
    """Merge original event rows and artifact annotations into one table."""
    base_cols = list(original.columns) if original.source != SOURCE_NONE else []
    clash = [c for c in ELECTROTAG_COLUMNS if c in base_cols]
    if clash:
        raise ExportError(
            f"The original events file already has column(s) {clash}, which ElectroTag needs for "
            "its own information. Please rename them in a copy of the dataset."
        )
    columns = list(base_cols)
    for col in REQUIRED_COLUMNS:
        if col not in columns:
            columns.append(col)
    columns += ELECTROTAG_COLUMNS
    index = {c: i for i, c in enumerate(columns)}
    timing = doc.recording.timing

    keyed: list[tuple[tuple[float, int, int], list[str]]] = []
    tag = original_source_tag(original)
    for i, row in enumerate(original.rows):
        out = [NA] * len(columns)
        for c, v in zip(base_cols, row):
            out[index[c]] = v
        if "sample" not in base_cols:
            s = original.sample[i] if i < len(original.sample) else None
            out[index["sample"]] = NA if s is None else str(s)
        out[index["event_source"]] = tag
        out[index["original_row"]] = str(i + 1)
        onset = original.onset_s[i] if i < len(original.onset_s) else None
        keyed.append(((onset if onset is not None else float("inf"), 0, i), out))

    for j, ann in enumerate(doc.sorted_annotations()):
        out = [NA] * len(columns)
        out[index["onset"]] = format_seconds(ann.onset(timing))
        out[index["duration"]] = format_seconds(ann.duration(timing))
        out[index["trial_type"]] = ann.label
        out[index["artifact_code"]] = str(doc.catalogue.value_for(ann.label))
        out[index["sample"]] = str(ann.onset_sample)
        out[index["channels"]] = encode_channels(ann.channels)
        out[index["event_source"]] = ARTIFACT_SOURCE
        out[index["annotation_id"]] = ann.annotation_id
        out[index["annotator_id"]] = doc.annotator_id
        out[index["confidence"]] = ann.confidence or NA
        out[index["annotation_note"]] = ann.note or NA
        keyed.append(((ann.onset(timing), 1, j), out))

    keyed.sort(key=lambda kv: kv[0])
    return columns, [row for _, row in keyed]


def events_tsv_bytes(original: OriginalEvents, doc: AnnotationDocument) -> bytes:
    columns, rows = build_events_table(original, doc)
    return tsv_bytes(columns, rows)


def annotations_from_events_tsv(
    data: bytes | str, recording: RecordingInfo, catalogue: LabelCatalogue
) -> list[ArtifactAnnotation]:
    """Rebuild artifact annotations from an exported events TSV alone."""
    text = data.decode("utf-8") if isinstance(data, bytes) else data
    columns, rows = parse_tsv_text(text, "exported events.tsv")
    # Files written before version 2 kept artifact codes in ``value``.
    code_column = "artifact_code" if "artifact_code" in columns else "value"
    missing = [c for c in REQUIRED_COLUMNS + ELECTROTAG_COLUMNS if c not in columns and c not in OPTIONAL_COLUMNS]
    if missing:
        raise AnnotationError(f"Exported events file lacks columns {missing}")
    idx = {c: i for i, c in enumerate(columns)}
    timing = recording.timing
    out = []
    for n, row in enumerate(rows, start=2):
        if row[idx["event_source"]] != ARTIFACT_SOURCE:
            continue
        label = row[idx["trial_type"]]
        code = parse_int_code(row[idx[code_column]])
        if not catalogue.is_permitted(label) or code != catalogue.value_for(label):
            raise AnnotationError(
                f"Line {n}: label {label!r} and {code_column} {row[idx[code_column]]!r} do not match the catalogue"
            )
        onset = parse_float(row[idx["onset"]])
        duration = parse_float(row[idx["duration"]])
        sample = parse_int_code(row[idx["sample"]])
        if onset is None or duration is None or sample is None:
            raise AnnotationError(f"Line {n}: onset, duration or sample is not numeric")
        if timing.time_to_sample(onset) != sample:
            raise AnnotationError(f"Line {n}: onset {onset} s does not correspond to sample {sample}")
        out.append(
            ArtifactAnnotation(
                annotation_id=row[idx["annotation_id"]],
                label=label,
                onset_sample=sample,
                duration_samples=timing.duration_to_samples(duration),
                channels=decode_channels(row[idx["channels"]]),
                confidence=_optional_cell(row, idx, "confidence"),
                note=_optional_cell(row, idx, "annotation_note"),
            )
        )
    return out


def _optional_cell(row: list[str], idx: dict[str, int], column: str) -> str:
    """A cell of a column that older files lack: "" when the column is missing or the cell is n/a."""
    value = row[idx[column]] if column in idx else NA
    return "" if value == NA else value


def original_rows_from_events_tsv(data: bytes | str) -> tuple[list[str], list[list[str]]]:
    """Rebuild the original event table (columns and rows) from an export."""
    text = data.decode("utf-8") if isinstance(data, bytes) else data
    columns, rows = parse_tsv_text(text, "exported events.tsv")
    idx = {c: i for i, c in enumerate(columns)}
    originals = [r for r in rows if r[idx["event_source"]].startswith("original:")]
    originals.sort(key=lambda r: int(r[idx["original_row"]]))
    return columns, originals


def build_events_sidecar(
    original_sidecar: dict[str, Any],
    original: OriginalEvents,
    doc: AnnotationDocument,
    event_report: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """BIDS events.json describing the merged table; returns (sidecar, notes).

    The original description of every original column, including ``value``, is
    kept as it was. Artifact rows are described by ``trial_type`` (with HED
    tags) and by ``artifact_code``.
    """
    cat = doc.catalogue
    out = copy.deepcopy(original_sidecar) if isinstance(original_sidecar, dict) else {}
    notes: list[str] = []
    # Columns that ElectroTag adds because the original events lack them get ElectroTag's own
    # description, even when the dataset's events.json (often shared by many recordings) describes
    # a column of that name.
    base_cols = list(original.columns) if original.source != SOURCE_NONE else []
    for col in REQUIRED_COLUMNS:
        if col not in base_cols and col in out:
            del out[col]
            notes.append(
                f"The original events.json describes a {col!r} column that the original events do not have; "
                "ElectroTag's description is used for the column it adds"
            )

    tt = out.setdefault("trial_type", {})
    if not isinstance(tt, dict):
        notes.append("Original trial_type description is not an object; artifact levels not added")
    else:
        tt.setdefault("Description", "Event type. Artifact rows use HED-SCORE artifact terms.")
        levels = tt.setdefault("Levels", {})
        if isinstance(levels, dict):
            for item in cat.labels:
                desc = item.description or item.label
                if item.label in levels and levels[item.label] != desc:
                    notes.append(f"Original Levels already define {item.label!r}; kept the original text")
                else:
                    levels[item.label] = desc
        hed_map = tt.get("HED")
        if hed_map is None:
            tt["HED"] = {item.label: cat.hed_tag(item.label) for item in cat.labels}
        elif isinstance(hed_map, dict):
            for item in cat.labels:
                hed_map.setdefault(item.label, cat.hed_tag(item.label))
        else:
            notes.append("Original trial_type HED annotation is not a mapping; HED tags for artifacts not added")

    if "value" in base_cols:
        val = out.setdefault("value", {})
        if isinstance(val, dict):
            val.setdefault("Description", "Marker value of the original events (n/a on artifact rows).")
    else:
        out["value"] = {
            "Description": "Added by ElectroTag for BIDS compatibility; n/a on every row (the original events "
            "have no value column, and artifact codes are in artifact_code)."
        }
    out["artifact_code"] = {
        "LongName": "Artifact code",
        "Description": (
            f"Fixed ElectroTag code of the artifact type on rows with event_source '{ARTIFACT_SOURCE}' "
            "(n/a on original rows). Codes never change between datasets or versions: "
            f"{min(cat.values)}-{max(cat.values)}, with group terms from 130."
        ),
        "Levels": {str(item.value): item.label for item in sorted(cat.labels, key=lambda x: x.value)},
    }
    sample_desc = "Onset as a 0-based sample index relative to the first sample in the data file."
    if "sample" not in base_cols:
        sample_desc += (
            " For original rows ElectroTag computed it from onset (the original events have no sample column)."
        )
    sample = out.setdefault("sample", {"Description": sample_desc})
    if original.sample_column_ignored and isinstance(sample, dict):
        # The dataset uses "sample" for something else; say what the artifact rows hold.
        sample["Description"] = (
            f"{sample.get('Description', '')} On rows with event_source '{ARTIFACT_SOURCE}': {sample_desc[0].lower()}"
            f"{sample_desc[1:]}"
        ).strip()
    out["channels"] = {
        "LongName": "Affected channels",
        "Description": (
            "For rows with event_source 'electrotag_artifact': a JSON array of channel names. An empty "
            "array [] means the artifact affects the whole recording montage (all channels). "
            + (
                "For original rows the value comes from the original events file."
                if "channels" in original.columns
                else "Original rows have n/a (no channel information in the original events)."
            )
        ),
    }
    out["event_source"] = {
        "Description": "Origin of the row.",
        "Levels": {
            "original:events_tsv": "Unchanged row from the recording's original BIDS events.tsv.",
            "original:brainvision_vmrk": "Marker from the BrainVision .vmrk file (read with MNE-Python).",
            "original:edf_annotations": "Annotation from the EDF+ file itself (read with MNE-Python).",
            "original:bdf_annotations": "Annotation from the BDF+ file itself (read with MNE-Python).",
            "original:stim_channel": (
                "Trigger read from the recording's trigger channel with mne.find_events (every change to a "
                "non-zero code; for BDF files the lower 16 bits of the Status channel)."
            ),
            ARTIFACT_SOURCE: "Artifact annotation created with ElectroTag.",
        },
    }
    if "stim_channel" in base_cols:
        out.setdefault("stim_channel", {
            "Description": "Trigger channel the original event was read from (n/a on artifact rows)."
        })
    out["annotation_id"] = {"Description": "Stable identifier of the ElectroTag artifact annotation (n/a for original rows)."}
    out["annotator_id"] = {"Description": "Identifier of the annotator who created the artifact annotation (n/a for original rows)."}
    out["original_row"] = {"Description": "1-based row number in the original events file (n/a for artifact rows)."}
    confidence_mode = doc.confidence_mode or "optional"
    out["confidence"] = {
        "LongName": "Confidence of the artifact annotation",
        "Description": (
            f"How sure the annotator was of the artifact, on rows with event_source '{ARTIFACT_SOURCE}' (n/a on "
            "original rows). n/a on an artifact row means that no confidence was given. "
            + (
                "In this study every new annotation started as 'definite' and the annotator changed it when unsure "
                "(annotation.confidence 'every_mark'), so a confidence was given for every annotation made."
                if confidence_mode == "every_mark"
                else "In this study a confidence was optional (annotation.confidence 'optional'): annotators gave one "
                "only when they wished, so the annotations with a confidence are a self-selected subset and n/a "
                "means not given, not definite."
            )
        ),
        "Levels": {
            "definite": "The annotator was sure this is an artifact of this type.",
            "probable": "The annotator thought it is probably an artifact of this type.",
            "possible": "The annotator thought it is possibly an artifact of this type.",
        },
    }
    out["annotation_note"] = {
        "LongName": "Annotator's note",
        "Description": (
            f"The annotator's optional short note on the artifact (at most {MAX_NOTE_CHARS} characters), on rows "
            f"with event_source '{ARTIFACT_SOURCE}'; n/a when there is no note, and on original rows."
        ),
    }
    out["ElectroTagMetadata"] = {
        "GeneratedBy": "ElectroTag " + (doc.app_version or ""),
        "recording_id": doc.recording.recording_id,
        "annotator_id": doc.annotator_id,
        "session_id": doc.session_id,
        "original_events_source": original.source,
        "original_sample_column_computed": original.sample_computed if original.source == SOURCE_EVENTS_TSV else None,
        "time_conventions": TIME_CONVENTIONS,
        "label_catalogue": cat.to_metadata(),
        "event_code_check": event_report or {},
        "confidence_setting": confidence_mode,
        "notes": notes,
    }
    return out, notes
