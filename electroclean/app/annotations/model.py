"""Annotation data model shared by all three ElectroClean components.

An :class:`AnnotationDocument` is the in-memory form of the canonical
``*_annotations.json`` file. It is deliberately independent of Qt and of MNE so
that it can be created, edited and analysed from scripts.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from electroclean.app.annotations.labels import LabelCatalogue, LabelError
from electroclean.app.annotations.timing import RecordingTiming, TimingError

SCHEMA_ANNOTATIONS = "electroclean.annotations"
SCHEMA_VERSION = "1.0.0"

CHANNEL_CONVENTION = {
    "encoding": "List of channel names exactly as they appear in the recording.",
    "empty_list_means": (
        "The annotation applies to the whole recording montage, i.e. every channel in "
        "recording.ch_names, over the annotated time interval."
    ),
    "non_empty_list_means": "The annotation applies only to the listed channels.",
    "order": "Channels are stored in the recording's channel order without duplicates.",
    "hidden_channels": (
        "recording.ch_names lists the channels that were shown and could be annotated. Channels in the file "
        "that the study settings hide (for example a headset's timestamp or contact-quality channels) are "
        "listed in recording.hidden_channels, when there are any, and are never part of the whole montage."
    ),
}


class AnnotationError(ValueError):
    """Raised when an annotation record is invalid."""


@dataclass(frozen=True)
class RecordingInfo:
    """Identity and timing of the recording an annotation set refers to.

    ``ch_names`` are the channels that could be annotated (the montage);
    ``hidden_channels`` are channels in the file that the settings hid.
    """

    recording_id: str
    timing: RecordingTiming
    ch_names: tuple[str, ...]
    relative_path: str = ""
    fingerprint: dict[str, Any] = field(default_factory=dict)
    hidden_channels: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.recording_id:
            raise AnnotationError("recording_id must not be empty")
        if len(set(self.ch_names)) != len(self.ch_names):
            raise AnnotationError("Recording channel names must be unique")
        if set(self.hidden_channels) & set(self.ch_names):
            raise AnnotationError("A channel cannot be both shown and hidden")

    def to_dict(self) -> dict[str, Any]:
        out = {
            "recording_id": self.recording_id,
            "relative_path": self.relative_path or self.recording_id,
            **self.timing.to_dict(),
            "ch_names": list(self.ch_names),
            "fingerprint": dict(self.fingerprint),
        }
        if self.hidden_channels:
            out["hidden_channels"] = list(self.hidden_channels)
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RecordingInfo:
        return cls(
            recording_id=str(data["recording_id"]),
            timing=RecordingTiming.from_dict(data),
            ch_names=tuple(str(c) for c in data.get("ch_names", [])),
            relative_path=str(data.get("relative_path", "")),
            fingerprint=dict(data.get("fingerprint") or {}),
            hidden_channels=tuple(str(c) for c in data.get("hidden_channels", []) or []),
        )


@dataclass(frozen=True)
class ArtifactAnnotation:
    """A single artifact interval.

    Boundaries are integer sample indices (see :mod:`timing` for the
    conventions). ``channels`` is empty for a whole-montage annotation.
    """

    annotation_id: str
    label: str
    onset_sample: int
    duration_samples: int
    channels: tuple[str, ...] = ()
    created_at: str = ""
    modified_at: str = ""

    @property
    def end_sample(self) -> int:
        return self.onset_sample + self.duration_samples

    @property
    def is_global(self) -> bool:
        return len(self.channels) == 0

    @property
    def scope(self) -> str:
        return "whole_montage" if self.is_global else "channels"

    def onset(self, timing: RecordingTiming) -> float:
        return timing.sample_to_time(self.onset_sample)

    def duration(self, timing: RecordingTiming) -> float:
        return timing.samples_to_duration(self.duration_samples)

    def offset(self, timing: RecordingTiming) -> float:
        return timing.sample_to_time(self.end_sample)

    def with_changes(self, **changes: Any) -> ArtifactAnnotation:
        return replace(self, **changes)

    def effective_channels(self, ch_names: tuple[str, ...]) -> tuple[str, ...]:
        """Channels covered, with whole-montage annotations expanded."""
        return tuple(ch_names) if self.is_global else self.channels

    def to_dict(self, timing: RecordingTiming, catalogue: LabelCatalogue) -> dict[str, Any]:
        return {
            "annotation_id": self.annotation_id,
            "label": self.label,
            "value": catalogue.value_for(self.label),
            "onset": self.onset(timing),
            "duration": self.duration(timing),
            "onset_sample": self.onset_sample,
            "duration_samples": self.duration_samples,
            "end_sample": self.end_sample,
            "channels": list(self.channels),
            "scope": self.scope,
            "created_at": self.created_at,
            "modified_at": self.modified_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any], timing: RecordingTiming) -> ArtifactAnnotation:
        """Rebuild an annotation, cross-checking the seconds and sample fields."""
        try:
            if "onset_sample" in data and "duration_samples" in data:
                onset_sample = int(data["onset_sample"])
                duration_samples = int(data["duration_samples"])
                if "onset" in data:
                    expected = timing.sample_to_time(onset_sample)
                    if abs(float(data["onset"]) - expected) > 0.5 / timing.sfreq:
                        raise AnnotationError(
                            f"Annotation {data.get('annotation_id')}: onset {data['onset']} s does not "
                            f"match onset_sample {onset_sample} at {timing.sfreq} Hz"
                        )
                if "duration" in data:
                    expected = timing.samples_to_duration(duration_samples)
                    if abs(float(data["duration"]) - expected) > 0.5 / timing.sfreq:
                        raise AnnotationError(
                            f"Annotation {data.get('annotation_id')}: duration {data['duration']} s does "
                            f"not match duration_samples {duration_samples}"
                        )
            else:
                onset_sample = timing.time_to_sample(float(data["onset"]))
                duration_samples = timing.duration_to_samples(float(data["duration"]))
            return cls(
                annotation_id=str(data["annotation_id"]),
                label=str(data["label"]),
                onset_sample=onset_sample,
                duration_samples=duration_samples,
                channels=tuple(str(c) for c in data.get("channels", [])),
                created_at=str(data.get("created_at", "")),
                modified_at=str(data.get("modified_at", "")),
            )
        except KeyError as exc:
            raise AnnotationError(f"Annotation record is missing field {exc}") from exc


def validate_annotation(
    ann: ArtifactAnnotation,
    recording: RecordingInfo,
    catalogue: LabelCatalogue,
    min_samples: int = 1,
) -> None:
    """Raise :class:`AnnotationError` if an annotation is not valid for a recording."""
    if not ann.annotation_id:
        raise AnnotationError("Annotation has no identifier")
    try:
        catalogue.get(ann.label)
    except LabelError as exc:
        raise AnnotationError(str(exc)) from exc
    try:
        recording.timing.validate_range(ann.onset_sample, ann.duration_samples, min_samples)
    except TimingError as exc:
        raise AnnotationError(f"{ann.label} at sample {ann.onset_sample}: {exc}") from exc
    if len(set(ann.channels)) != len(ann.channels):
        raise AnnotationError(f"Annotation {ann.annotation_id} lists a channel more than once")
    unknown = [c for c in ann.channels if c not in recording.ch_names]
    if unknown:
        raise AnnotationError(
            f"Annotation {ann.annotation_id} refers to channels not in the recording: {unknown}"
        )


def normalise_channels(channels: Any, ch_names: tuple[str, ...]) -> tuple[str, ...]:
    """Return ``channels`` in recording order without duplicates.

    Selecting every channel explicitly is stored as an explicit list, not as
    the empty (whole-montage) list, so that the annotator's choice is kept.
    """
    chosen = {str(c) for c in (channels or ())}
    unknown = sorted(chosen.difference(ch_names))
    if unknown:
        raise AnnotationError(f"Unknown channel(s): {', '.join(unknown)}")
    return tuple(c for c in ch_names if c in chosen)


@dataclass
class AnnotationDocument:
    """A complete set of annotations by one annotator for one recording."""

    recording: RecordingInfo
    annotator_id: str
    annotations: list[ArtifactAnnotation]
    catalogue: LabelCatalogue
    annotator_display_name: str = ""
    session_id: str = ""
    mode: str = "standard"
    created_at: str = ""
    app_version: str = ""
    context: dict[str, Any] = field(default_factory=dict)

    def sorted_annotations(self) -> list[ArtifactAnnotation]:
        return sorted(
            self.annotations,
            key=lambda a: (a.onset_sample, a.duration_samples, a.label, a.annotation_id),
        )

    def validate(self, min_samples: int = 1) -> None:
        ids = [a.annotation_id for a in self.annotations]
        if len(set(ids)) != len(ids):
            raise AnnotationError("Annotation identifiers must be unique within a document")
        for ann in self.annotations:
            validate_annotation(ann, self.recording, self.catalogue, min_samples)

    def counts_by_label(self) -> dict[str, int]:
        counts = {label: 0 for label in self.catalogue.label_names}
        for ann in self.annotations:
            counts[ann.label] = counts.get(ann.label, 0) + 1
        return counts
