"""Conversion between ElectroTag annotations and ``mne.Annotations``.

MNE's ``Annotations`` object is the native representation used by downstream
MNE pipelines. ``ch_names`` carries the channel selection
(an empty tuple meaning all channels, exactly as in MNE) and ``extras`` carries
the stable ElectroTag annotation identifier and numerical code.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from electrotag.app.annotations.labels import LabelCatalogue
from electrotag.app.annotations.model import AnnotationError, ArtifactAnnotation, RecordingInfo


def to_mne_annotations(
    annotations: Iterable[ArtifactAnnotation],
    recording: RecordingInfo,
    catalogue: LabelCatalogue,
    *,
    for_raw: Any | None = None,
):
    """Build ``mne.Annotations``.

    If ``for_raw`` is given, the result uses that raw object's ``orig_time``
    convention so that it can be passed straight to ``raw.set_annotations``.
    Otherwise ``orig_time`` is ``None`` and onsets are relative to the first
    sample, which MNE interprets the same way when the annotations are
    attached to a ``Raw`` object.
    """
    import mne

    anns = list(annotations)
    timing = recording.timing
    onsets = [a.onset(timing) for a in anns]
    orig_time = None
    if for_raw is not None and for_raw.info["meas_date"] is not None:
        orig_time = for_raw.info["meas_date"]
        onsets = [timing.to_mne_onset(o) for o in onsets]
    return mne.Annotations(
        onset=onsets,
        duration=[a.duration(timing) for a in anns],
        description=[a.label for a in anns],
        orig_time=orig_time,
        ch_names=[tuple(a.channels) for a in anns],
        extras=[
            {"electrotag_id": a.annotation_id, "value": catalogue.value_for(a.label)} for a in anns
        ],
    )


def from_mne_annotations(
    mne_annotations: Any,
    recording: RecordingInfo,
    catalogue: LabelCatalogue,
    *,
    attached_to_raw: bool = True,
) -> list[ArtifactAnnotation]:
    """Convert ``mne.Annotations`` (e.g. ``raw.annotations``) back.

    Only descriptions that are permitted artifact labels are accepted; any
    other description raises :class:`AnnotationError` so that arbitrary labels
    can never enter an export.
    """
    from electrotag.app.common import new_annotation_id

    timing = recording.timing
    out = []
    extras = getattr(mne_annotations, "extras", None) or [{}] * len(mne_annotations)
    for i, ann in enumerate(mne_annotations):
        label = str(ann["description"])
        if not catalogue.is_permitted(label):
            raise AnnotationError(f"MNE annotation {i} has a non-permitted label {label!r}")
        onset = float(ann["onset"])
        if attached_to_raw:
            onset = timing.from_mne_onset(onset)
        start, dur = timing.time_to_sample(onset), timing.duration_to_samples(float(ann["duration"]))
        ex = extras[i] if i < len(extras) and extras[i] else {}
        out.append(
            ArtifactAnnotation(
                annotation_id=str(ex.get("electrotag_id") or new_annotation_id()),
                label=label,
                onset_sample=start,
                duration_samples=dur,
                channels=tuple(ann.get("ch_names", ()) or ()),
            )
        )
    return out
