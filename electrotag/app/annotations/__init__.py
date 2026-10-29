"""Annotation model, label catalogue, timing conventions and editing store."""

from __future__ import annotations

from electrotag.app.annotations.labels import (
    ArtifactLabel,
    LabelCatalogue,
    LabelError,
    default_catalogue,
)
from electrotag.app.annotations.model import (
    AnnotationDocument,
    AnnotationError,
    ArtifactAnnotation,
    RecordingInfo,
    validate_annotation,
)
from electrotag.app.annotations.store import AnnotationStore, StoreChange
from electrotag.app.annotations.timing import RecordingTiming, TimingError

__all__ = [
    "AnnotationDocument",
    "AnnotationError",
    "AnnotationStore",
    "ArtifactAnnotation",
    "ArtifactLabel",
    "LabelCatalogue",
    "LabelError",
    "RecordingInfo",
    "RecordingTiming",
    "StoreChange",
    "TimingError",
    "default_catalogue",
    "validate_annotation",
]
