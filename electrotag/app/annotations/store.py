"""Editable, undoable collection of artifact annotations for one recording.

The store is the single source of truth while a recording is being annotated.
An interface only displays what the store contains and routes every user action
(create, move, resize, relabel, change channels, delete, merge, undo, redo)
through the methods below, so that validation and history are identical
whether annotations are edited interactively or from a script. The browser
application's store (``electrotag/web/static/js/annotate/store.js``) is a port
of this one with the same rules, and the session save rebuilds its annotations
here before they are validated and written.

**Automatic merging** (the research team's choice). When an annotation is
created or changed so that it overlaps in time another annotation of the same
type with the same channel scope (both whole montage, or exactly the same
channels), the two become one annotation spanning both. The older annotation
keeps its identifier. The merge is part of the same undo step as the change
that caused it. Annotations of the same type that only touch, or that cover
different channels, stay separate.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass

from electrotag.app.annotations.labels import LabelCatalogue
from electrotag.app.annotations.model import (
    AnnotationError,
    ArtifactAnnotation,
    RecordingInfo,
    normalise_channels,
    validate_annotation,
)
from electrotag.app.annotations.timing import TimingError
from electrotag.app.common import new_annotation_id, now_local_iso

Snapshot = tuple[ArtifactAnnotation, ...]


@dataclass(frozen=True)
class StoreChange:
    """Notification sent to listeners after every change."""

    action: str  # "add", "update", "delete", "merge", "undo", "redo", "reset"
    description: str
    annotation_ids: tuple[str, ...]


class AnnotationStore:
    """Holds the annotations being edited and their undo/redo history."""

    def __init__(
        self,
        recording: RecordingInfo,
        catalogue: LabelCatalogue,
        *,
        min_duration_samples: int = 1,
        max_history: int = 2000,
        initial: Iterable[ArtifactAnnotation] = (),
        auto_merge: bool = True,
    ) -> None:
        self.recording = recording
        self.catalogue = catalogue
        self.min_duration_samples = int(min_duration_samples)
        self.auto_merge = bool(auto_merge)
        #: How many annotations the last change absorbed by automatic merging.
        self.last_auto_merged = 0
        #: Surviving identifier for each annotation identifier passed to the last change.
        self.last_survivors: dict[str, str] = {}
        self.max_history = int(max_history)
        self._items: dict[str, ArtifactAnnotation] = {}
        self._undo: list[tuple[str, Snapshot]] = []
        self._redo: list[tuple[str, Snapshot]] = []
        self._listeners: list[Callable[[StoreChange], None]] = []
        self.revision = 0
        for ann in initial:
            validate_annotation(ann, recording, catalogue, self.min_duration_samples)
            if ann.annotation_id in self._items:
                raise AnnotationError(f"Duplicate annotation id {ann.annotation_id}")
            self._items[ann.annotation_id] = ann

    # ----------------------------------------------------------------- access
    def __len__(self) -> int:
        return len(self._items)

    def __iter__(self) -> Iterator[ArtifactAnnotation]:
        return iter(self.annotations())

    def __contains__(self, annotation_id: object) -> bool:
        return annotation_id in self._items

    def get(self, annotation_id: str) -> ArtifactAnnotation:
        try:
            return self._items[annotation_id]
        except KeyError as exc:
            raise AnnotationError(f"No annotation with id {annotation_id}") from exc

    def annotations(self) -> list[ArtifactAnnotation]:
        """All annotations ordered by onset, then duration, label and id."""
        return sorted(
            self._items.values(),
            key=lambda a: (a.onset_sample, a.duration_samples, a.label, a.annotation_id),
        )

    def snapshot(self) -> Snapshot:
        return tuple(self.annotations())

    @property
    def timing(self):  # noqa: ANN201 - convenience alias
        return self.recording.timing

    # -------------------------------------------------------------- listeners
    def add_listener(self, callback: Callable[[StoreChange], None]) -> None:
        self._listeners.append(callback)

    def remove_listener(self, callback: Callable[[StoreChange], None]) -> None:
        if callback in self._listeners:
            self._listeners.remove(callback)

    def _notify(self, change: StoreChange) -> None:
        self.revision += 1
        for cb in list(self._listeners):
            cb(change)

    # ---------------------------------------------------------------- history
    @property
    def can_undo(self) -> bool:
        return bool(self._undo)

    @property
    def can_redo(self) -> bool:
        return bool(self._redo)

    @property
    def undo_description(self) -> str:
        return self._undo[-1][0] if self._undo else ""

    @property
    def redo_description(self) -> str:
        return self._redo[-1][0] if self._redo else ""

    @staticmethod
    def _mergeable(a: ArtifactAnnotation, b: ArtifactAnnotation) -> bool:
        return (
            a.label == b.label
            and a.channels == b.channels
            and a.onset_sample < b.end_sample
            and b.onset_sample < a.end_sample
        )

    def _absorb(self, items: dict[str, ArtifactAnnotation], annotation_id: str) -> tuple[str, int]:
        """Merge everything overlapping ``items[annotation_id]`` (same type and channels) into one.

        Returns the surviving identifier and the number of annotations absorbed.
        """
        current = items[annotation_id]
        absorbed = 0
        while True:
            partners = [a for k, a in items.items() if k != current.annotation_id and self._mergeable(current, a)]
            if not partners:
                return current.annotation_id, absorbed
            group = [current, *partners]
            order = {k: i for i, k in enumerate(items)}  # insertion order: the oldest comes first
            survivor = min(group, key=lambda a: order[a.annotation_id])
            start = min(a.onset_sample for a in group)
            stop = max(a.end_sample for a in group)
            current = self._check(
                survivor.with_changes(onset_sample=start, duration_samples=stop - start, modified_at=now_local_iso())
            )
            gone = {a.annotation_id for a in group} - {survivor.annotation_id}
            kept = {k: (current if k == survivor.annotation_id else v) for k, v in items.items() if k not in gone}
            items.clear()
            items.update(kept)
            absorbed += len(partners)

    def _commit(
        self,
        action: str,
        description: str,
        new_items: dict[str, ArtifactAnnotation],
        ids: tuple[str, ...],
    ) -> None:
        self.last_auto_merged = 0
        self.last_survivors = {i: i for i in ids}
        if self.auto_merge and action in ("add", "update", "merge"):
            new_items = dict(new_items)
            for aid in ids:
                live = self.last_survivors[aid]
                if live not in new_items:
                    continue
                survivor, n = self._absorb(new_items, live)
                self.last_auto_merged += n
                for k, v in self.last_survivors.items():
                    if v not in new_items:  # absorbed just now
                        self.last_survivors[k] = survivor
            if self.last_auto_merged:
                description += f" (merged with {self.last_auto_merged} overlapping annotation(s) of the same type)"
                ids = tuple(dict.fromkeys(self.last_survivors.values()))
        self._undo.append((description, self.snapshot()))
        if len(self._undo) > self.max_history:
            del self._undo[0]
        self._redo.clear()
        self._items = new_items
        self._notify(StoreChange(action, description, ids))

    def undo(self) -> str | None:
        if not self._undo:
            return None
        description, previous = self._undo.pop()
        self._redo.append((description, self.snapshot()))
        self._items = {a.annotation_id: a for a in previous}
        self._notify(StoreChange("undo", f"Undo {description}", ()))
        return description

    def redo(self) -> str | None:
        if not self._redo:
            return None
        description, following = self._redo.pop()
        self._undo.append((description, self.snapshot()))
        self._items = {a.annotation_id: a for a in following}
        self._notify(StoreChange("redo", f"Redo {description}", ()))
        return description

    # ------------------------------------------------------------ validation
    def _check(self, ann: ArtifactAnnotation) -> ArtifactAnnotation:
        validate_annotation(ann, self.recording, self.catalogue, self.min_duration_samples)
        return ann

    def _channels(self, channels: Iterable[str] | None) -> tuple[str, ...]:
        return normalise_channels(channels, self.recording.ch_names)

    # ---------------------------------------------------------------- editing
    def add(
        self,
        label: str,
        onset_sample: int,
        duration_samples: int,
        channels: Iterable[str] | None = (),
        *,
        annotation_id: str | None = None,
    ) -> ArtifactAnnotation:
        stamp = now_local_iso()
        ann = self._check(
            ArtifactAnnotation(
                annotation_id=annotation_id or new_annotation_id(),
                label=label,
                onset_sample=int(onset_sample),
                duration_samples=int(duration_samples),
                channels=self._channels(channels),
                created_at=stamp,
                modified_at=stamp,
            )
        )
        if ann.annotation_id in self._items:
            raise AnnotationError(f"Duplicate annotation id {ann.annotation_id}")
        items = dict(self._items)
        items[ann.annotation_id] = ann
        self._commit("add", f"add {label}", items, (ann.annotation_id,))
        return self._items[self.last_survivors[ann.annotation_id]]

    def add_interval(
        self,
        label: str,
        t_start: float,
        t_stop: float,
        channels: Iterable[str] | None = (),
    ) -> ArtifactAnnotation:
        """Add an annotation from a time interval in seconds (snapped to samples)."""
        try:
            onset, duration = self.timing.snap_interval(t_start, t_stop, self.min_duration_samples)
        except TimingError as exc:
            raise AnnotationError(str(exc)) from exc
        return self.add(label, onset, duration, channels)

    def update(
        self,
        annotation_id: str,
        *,
        label: str | None = None,
        onset_sample: int | None = None,
        duration_samples: int | None = None,
        channels: Iterable[str] | None = None,
        description: str | None = None,
    ) -> ArtifactAnnotation:
        current = self.get(annotation_id)
        changes: dict[str, object] = {}
        if label is not None and label != current.label:
            changes["label"] = label
        if onset_sample is not None and int(onset_sample) != current.onset_sample:
            changes["onset_sample"] = int(onset_sample)
        if duration_samples is not None and int(duration_samples) != current.duration_samples:
            changes["duration_samples"] = int(duration_samples)
        if channels is not None:
            new_channels = self._channels(channels)
            if new_channels != current.channels:
                changes["channels"] = new_channels
        if not changes:
            return current
        updated = self._check(current.with_changes(modified_at=now_local_iso(), **changes))
        items = dict(self._items)
        items[annotation_id] = updated
        what = description or "edit " + ", ".join(sorted(changes))
        self._commit("update", what, items, (annotation_id,))
        return self._items[self.last_survivors[annotation_id]]

    def set_interval(self, annotation_id: str, t_start: float, t_stop: float) -> ArtifactAnnotation:
        try:
            onset, duration = self.timing.snap_interval(t_start, t_stop, self.min_duration_samples)
        except TimingError as exc:
            raise AnnotationError(str(exc)) from exc
        return self.update(
            annotation_id, onset_sample=onset, duration_samples=duration, description="move/resize"
        )

    def set_label(self, annotation_id: str, label: str) -> ArtifactAnnotation:
        return self.update(annotation_id, label=label, description=f"relabel as {label}")

    def set_label_many(self, annotation_ids: Iterable[str], label: str) -> None:
        """Relabel several annotations as one undoable step."""
        ids = tuple(dict.fromkeys(annotation_ids))
        items = dict(self._items)
        changed = []
        stamp = now_local_iso()
        for aid in ids:
            current = self.get(aid)
            if current.label != label:
                items[aid] = self._check(current.with_changes(label=label, modified_at=stamp))
                changed.append(aid)
        if changed:
            what = f"relabel as {label}" if len(changed) == 1 else f"relabel {len(changed)} annotations as {label}"
            self._commit("update", what, items, tuple(changed))

    def set_channels(self, annotation_id: str, channels: Iterable[str]) -> ArtifactAnnotation:
        return self.update(annotation_id, channels=list(channels), description="change channels")

    def toggle_channel(self, annotation_id: str, ch_name: str) -> ArtifactAnnotation:
        current = self.get(annotation_id)
        if ch_name not in self.recording.ch_names:
            raise AnnotationError(f"Unknown channel {ch_name}")
        chans = set(current.channels)
        if ch_name in chans:
            chans.remove(ch_name)
        else:
            chans.add(ch_name)
        return self.update(annotation_id, channels=chans, description=f"toggle channel {ch_name}")

    def delete(self, annotation_id: str) -> None:
        self.delete_many([annotation_id])

    def delete_many(self, annotation_ids: Iterable[str]) -> None:
        ids = tuple(dict.fromkeys(annotation_ids))
        if not ids:
            return
        for aid in ids:
            self.get(aid)
        items = {k: v for k, v in self._items.items() if k not in ids}
        what = "delete annotation" if len(ids) == 1 else f"delete {len(ids)} annotations"
        self._commit("delete", what, items, ids)

    def merge(self, annotation_ids: Iterable[str]) -> ArtifactAnnotation:
        """Explicitly merge annotations that share a label into one interval.

        Only called when the annotator asks for it. The merged interval spans
        from the earliest onset to the latest end of the selection. If any of
        the merged annotations covered the whole montage, the result does too;
        otherwise its channels are the union of the selected channels.
        """
        ids = tuple(dict.fromkeys(annotation_ids))
        if len(ids) < 2:
            raise AnnotationError("Select at least two annotations to merge")
        anns = [self.get(a) for a in ids]
        labels = {a.label for a in anns}
        if len(labels) != 1:
            raise AnnotationError("Only annotations with the same label can be merged")
        start = min(a.onset_sample for a in anns)
        stop = max(a.end_sample for a in anns)
        if any(a.is_global for a in anns):
            channels: tuple[str, ...] = ()
        else:
            channels = self._channels({c for a in anns for c in a.channels})
        stamp = now_local_iso()
        merged = self._check(
            ArtifactAnnotation(
                annotation_id=new_annotation_id(),
                label=anns[0].label,
                onset_sample=start,
                duration_samples=stop - start,
                channels=channels,
                created_at=stamp,
                modified_at=stamp,
            )
        )
        items = {k: v for k, v in self._items.items() if k not in ids}
        items[merged.annotation_id] = merged
        self._commit("merge", f"merge {len(ids)} {merged.label} annotations", items, (merged.annotation_id,))
        return self._items[self.last_survivors[merged.annotation_id]]

    def overlapping(self, annotation_id: str) -> list[ArtifactAnnotation]:
        """Other annotations whose intervals overlap the given one."""
        ref = self.get(annotation_id)
        return [
            a
            for a in self.annotations()
            if a.annotation_id != annotation_id
            and a.onset_sample < ref.end_sample
            and ref.onset_sample < a.end_sample
        ]
