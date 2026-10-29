"""The canonical ``*_annotations.json`` format.

This file is the lossless record of an annotation session and the input to the
reliability and training tools. Its structure is documented in
``docs/file_formats.md``; a JSON Schema-style summary is kept in
:data:`ANNOTATION_FILE_FIELDS`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from electrotag import __version__
from electrotag.app.annotations.labels import LabelCatalogue, default_catalogue
from electrotag.app.annotations.model import (
    CONFIDENCE_CONVENTION,
    CHANNEL_CONVENTION,
    SCHEMA_ANNOTATIONS,
    SCHEMA_VERSION,
    AnnotationDocument,
    AnnotationError,
    ArtifactAnnotation,
    RecordingInfo,
)
from electrotag.app.annotations.timing import TIME_CONVENTIONS
from electrotag.app.io.atomic import atomic_write_bytes, json_bytes

ANNOTATION_FILE_FIELDS = {
    "schema": "Always 'electrotag.annotations'.",
    "schema_version": "Semantic version of this file format.",
    "recording": "recording_id, relative_path, sfreq, n_samples, first_samp, meas_date, duration_s, ch_names, fingerprint.",
    "annotator": "annotator_id (file-name safe) and optional display_name.",
    "session": "session_id, mode (standard/practice/assessment), created_at, app_version, context, and confidence "
    "(the study's annotation.confidence setting: optional or every_mark; absent before version 1.1.0).",
    "time_conventions": "How onset, duration and sample are defined.",
    "channel_convention": "Meaning of the channels list (empty = whole montage).",
    "confidence_convention": "Meaning of each annotation's confidence (definite, probable, possible; null: not given).",
    "label_catalogue": "Catalogue id, version, SHA-256 and the (value, label) pairs used.",
    "annotations": "List of annotation records (see ArtifactAnnotation.to_dict).",
}


def catalogue_from_metadata(meta: dict[str, Any]) -> LabelCatalogue:
    """Rebuild a catalogue from the copy embedded in an annotation file."""
    current = {item.label: item for item in default_catalogue().labels}

    def attr(label: str, name: str, default: Any) -> Any:
        item = current.get(label)
        return getattr(item, name) if item is not None else default

    return LabelCatalogue.from_dict(
        {
            "catalogue_id": meta["catalogue_id"],
            "catalogue_version": meta["catalogue_version"],
            "hed_library": meta.get("hed_library", ""),
            "hed_library_version": meta.get("hed_library_version", ""),
            "hed_standard_version": meta.get("hed_standard_version", ""),
            "labels": [
                {
                    "value": e["value"],
                    "label": e["label"],
                    "colour": attr(e["label"], "colour", "#808080"),
                    "short_code": attr(e["label"], "short_code", ""),
                    # Files from catalogue 1.0.0 have no hierarchy; the current catalogue supplies it.
                    "kind": e.get("kind", attr(e["label"], "kind", "specific")),
                    "parent": e.get("parent", attr(e["label"], "parent", None)),
                    "section": attr(e["label"], "section", ""),
                    "description": attr(e["label"], "description", ""),
                }
                for e in meta["labels"]
            ],
        }
    )


def document_to_dict(doc: AnnotationDocument) -> dict[str, Any]:
    timing = doc.recording.timing
    session: dict[str, Any] = {
        "session_id": doc.session_id,
        "mode": doc.mode,
        "created_at": doc.created_at,
        "app_version": doc.app_version or __version__,
        "context": doc.context,
    }
    if doc.confidence_mode:
        session["confidence"] = doc.confidence_mode
    return {
        "schema": SCHEMA_ANNOTATIONS,
        "schema_version": SCHEMA_VERSION,
        "recording": doc.recording.to_dict(),
        "annotator": {
            "annotator_id": doc.annotator_id,
            "display_name": doc.annotator_display_name,
        },
        "session": session,
        "time_conventions": TIME_CONVENTIONS,
        "channel_convention": CHANNEL_CONVENTION,
        "confidence_convention": CONFIDENCE_CONVENTION,
        "label_catalogue": doc.catalogue.to_metadata(),
        "n_annotations": len(doc.annotations),
        "annotations": [a.to_dict(timing, doc.catalogue) for a in doc.sorted_annotations()],
    }


def document_from_dict(data: dict[str, Any], *, validate: bool = True) -> AnnotationDocument:
    if data.get("schema") != SCHEMA_ANNOTATIONS:
        raise AnnotationError(f"Not an ElectroTag annotation file (schema={data.get('schema')!r})")
    major = str(data.get("schema_version", "0")).split(".")[0]
    if major != SCHEMA_VERSION.split(".")[0]:
        raise AnnotationError(
            f"Unsupported annotation file version {data.get('schema_version')} "
            f"(this ElectroTag reads version {SCHEMA_VERSION.split('.')[0]}.x)"
        )
    recording = RecordingInfo.from_dict(data["recording"])
    catalogue = catalogue_from_metadata(data["label_catalogue"])
    if data["label_catalogue"].get("sha256") not in (None, catalogue.sha256):
        raise AnnotationError("Label catalogue digest in the file does not match its label list")
    anns = []
    for entry in data.get("annotations", []):
        ann = ArtifactAnnotation.from_dict(entry, recording.timing)
        if "value" in entry and int(entry["value"]) != catalogue.value_for(ann.label):
            raise AnnotationError(
                f"Annotation {ann.annotation_id}: value {entry['value']} does not match label {ann.label}"
            )
        anns.append(ann)
    if "n_annotations" in data and int(data["n_annotations"]) != len(anns):
        raise AnnotationError("n_annotations does not match the number of annotation records")
    annot = data.get("annotator", {})
    session = data.get("session", {})
    doc = AnnotationDocument(
        recording=recording,
        annotator_id=str(annot.get("annotator_id", "")),
        annotator_display_name=str(annot.get("display_name", "")),
        annotations=anns,
        catalogue=catalogue,
        session_id=str(session.get("session_id", "")),
        mode=str(session.get("mode", "standard")),
        created_at=str(session.get("created_at", "")),
        app_version=str(session.get("app_version", "")),
        context=dict(session.get("context") or {}),
        confidence_mode=str(session.get("confidence") or ""),
    )
    if validate:
        doc.validate()
    return doc


def annotations_json_bytes(doc: AnnotationDocument) -> bytes:
    return json_bytes(document_to_dict(doc))


def write_annotations_json(path: Path | str, doc: AnnotationDocument, *, overwrite: bool = False) -> str:
    return atomic_write_bytes(path, annotations_json_bytes(doc), overwrite=overwrite)


def read_annotations_json(path: Path | str, *, validate: bool = True) -> AnnotationDocument:
    p = Path(path)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise AnnotationError(f"Cannot read annotation file {p}: {exc}") from exc
    return document_from_dict(data, validate=validate)
