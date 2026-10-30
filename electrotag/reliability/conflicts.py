"""Conflicts between annotators' versions of one recording, for screening-style adjudication.

Two or more people annotate the same recording (or the same window of it) independently. This module
compares their versions with the agreement analysis's own matching rules
(:func:`~electrotag.reliability.matching.events_for` and
:func:`~electrotag.reliability.matching.match_events`) and groups the marks into **clusters**: marks
of different people that the matching pairs up, joined across all pairs of people (union-find), and
every mark that nobody else's matches on its own. A cluster on which everyone agrees is an *agreed*
mark; any other cluster is a **conflict** of one or more kinds:

========== =====================================================================================
presence   someone has no mark there (marked by one annotator, or by some, only)
type       the marks carry different artifact types
timing     two people's onsets, or offsets, are further apart than the tolerance
channels   two people's channels overlap less than the channel rule asks (a whole-montage mark
           covers every channel)
split      one person has two or more marks in the cluster
========== =====================================================================================

Each cluster has a stable identifier, made from the people and the annotation IDs of its marks
(:func:`conflict_id`), so that decisions stored against it stay attached as long as the inputs are
the same frozen versions. An adjudicator decides each conflict (:func:`apply_decision`): keep one
person's marks, keep all of them, keep none, or replace them with marks of their own. The
adjudicated version is the agreed marks plus the decided ones (:func:`adjudicated_annotations`).

Everything here is plain Python on annotation documents: no web code, no files.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from itertools import combinations
from typing import Any

from electrotag.app.annotations.model import AnnotationDocument, ArtifactAnnotation
from electrotag.reliability.config import ANY_ARTIFACT, MATCH_CRITERIA
from electrotag.reliability.matching import channel_jaccard, events_for, match_events

#: The kinds of conflict, in the order they are listed.
KINDS = ("presence", "type", "timing", "channels", "split")
#: What an adjudicator may decide, besides keeping one person's marks (their letter).
CHOICE_WORDS = ("all", "none", "edited")
#: Letters given to the versions compared, in order (at most six people per adjudication).
LETTERS = ("A", "B", "C", "D", "E", "F")
#: The most marks an adjudicator's own replacement of a conflict may hold.
MAX_EDITED_MARKS = 5


class ConflictError(ValueError):
    """A decision that cannot be applied to its conflict."""


@dataclass(frozen=True)
class ConflictRules:
    """The matching rules a comparison uses (the study's ``review.matching``, frozen with an adjudication)."""

    match_criterion: str = "iou"
    iou_threshold: float = 0.2
    onset_tolerance_s: float = 0.5
    offset_tolerance_s: float = 0.5
    channel_jaccard: float = 0.5
    categories: tuple[str, ...] | None = None

    def __post_init__(self) -> None:
        if self.match_criterion not in MATCH_CRITERIA:
            raise ValueError(f"match_criterion must be one of {', '.join(MATCH_CRITERIA)}")

    @classmethod
    def from_dict(cls, d: Mapping[str, Any] | None) -> ConflictRules:
        d = dict(d or {})
        base = cls()
        cats = d.get("categories")
        return cls(match_criterion=str(d.get("match_criterion", base.match_criterion)),
                   iou_threshold=float(d.get("iou_threshold", base.iou_threshold)),
                   onset_tolerance_s=float(d.get("onset_tolerance_s", base.onset_tolerance_s)),
                   offset_tolerance_s=float(d.get("offset_tolerance_s", base.offset_tolerance_s)),
                   channel_jaccard=float(d.get("channel_jaccard", base.channel_jaccard)),
                   categories=tuple(str(c) for c in cats) if cats else None)

    def to_dict(self) -> dict[str, Any]:
        return {"match_criterion": self.match_criterion, "iou_threshold": self.iou_threshold,
                "onset_tolerance_s": self.onset_tolerance_s, "offset_tolerance_s": self.offset_tolerance_s,
                "channel_jaccard": self.channel_jaccard,
                "categories": list(self.categories) if self.categories else None}


@dataclass(frozen=True)
class Mark:
    """One person's mark, as compared: samples clipped to the window, channels as the recording orders them
    (``channels`` empty for a whole-montage mark; ``covered`` lists the channels it covers either way)."""

    letter: str
    annotator_id: str
    annotation_id: str
    label: str
    start: int
    stop: int
    channels: tuple[str, ...]
    covered: frozenset[str]
    confidence: int | None = None
    note: str = ""

    @property
    def whole_montage(self) -> bool:
        return not self.channels


@dataclass
class Cluster:
    """Marks of different people that the matching pairs up (or one mark nobody else's matches)."""

    cluster_id: str
    marks: list[Mark]
    missing: list[str]  # the letters with no mark in the cluster
    kinds: tuple[str, ...]  # () when everyone agrees
    letters: tuple[str, ...] = field(default_factory=tuple)  # every letter compared

    @property
    def is_conflict(self) -> bool:
        return bool(self.kinds)

    @property
    def start(self) -> int:
        return min(m.start for m in self.marks)

    @property
    def stop(self) -> int:
        return max(m.stop for m in self.marks)

    @property
    def labels(self) -> list[str]:
        """The artifact types in the cluster, each once, most frequent first (then by name)."""
        counts: dict[str, int] = {}
        for m in self.marks:
            counts[m.label] = counts.get(m.label, 0) + 1
        return sorted(counts, key=lambda lab: (-counts[lab], lab))

    def marks_of(self, letter: str) -> list[Mark]:
        return [m for m in self.marks if m.letter == letter]


def conflict_id(unit_id: str, marks: Iterable[Mark]) -> str:
    """``c-`` and 16 hexadecimal characters, from the unit and the people and annotation IDs of the marks: the same
    whenever the same versions are compared."""
    parts = sorted(f"{m.annotator_id}:{m.annotation_id}" for m in marks)
    return "c-" + hashlib.sha1("|".join([unit_id, *parts]).encode("utf-8")).hexdigest()[:16]


def _marks_of(letter: str, who: str, doc: AnnotationDocument, ch_names: tuple[str, ...],
              window: tuple[int, int] | None, rules: ConflictRules) -> list[Mark]:
    by_id = {a.annotation_id: a for a in doc.annotations}
    out = []
    for e in events_for(doc, ANY_ARTIFACT, ch_names, categories=rules.categories):
        start, stop = e.start, e.stop
        if window is not None:
            if stop <= window[0] or start >= window[1]:
                continue
            start, stop = max(start, window[0]), min(stop, window[1])
            if stop <= start:
                continue
        a = by_id[e.annotation_id]
        out.append(Mark(letter, who, e.annotation_id, e.label, start, stop,
                        tuple(c for c in ch_names if c in set(a.channels)) if a.channels else (),
                        e.channels, e.confidence, e.note))
    out.sort(key=lambda m: (m.start, m.stop, m.annotation_id))
    return out


def _as_event(m: Mark) -> Any:
    from electrotag.reliability.matching import Event

    return Event(m.letter, m.annotation_id, m.label, m.start, m.stop, m.covered, m.whole_montage, m.confidence, m.note)


def kinds_of(marks: list[Mark], letters: tuple[str, ...], sfreq: float, rules: ConflictRules) -> tuple[str, ...]:
    """The kinds of conflict among a cluster's marks (() when they agree)."""
    found: set[str] = set()
    present = {m.letter for m in marks}
    if any(x not in present for x in letters):
        found.add("presence")
    if len({m.label for m in marks}) > 1:
        found.add("type")
    if any(len([m for m in marks if m.letter == x]) > 1 for x in present):
        found.add("split")
    for a, b in combinations(marks, 2):
        if a.letter == b.letter:
            continue
        if abs(a.start - b.start) / sfreq > rules.onset_tolerance_s + 1e-9 \
                or abs(a.stop - b.stop) / sfreq > rules.offset_tolerance_s + 1e-9:
            found.add("timing")
        jac = channel_jaccard(a.covered, b.covered)
        if jac < rules.channel_jaccard - 1e-12 or (rules.channel_jaccard <= 0 and jac <= 0):
            found.add("channels")
    return tuple(k for k in KINDS if k in found)


def find_clusters(docs: Mapping[str, AnnotationDocument], *, ch_names: tuple[str, ...], sfreq: float,
                  unit_id: str = "", window: tuple[int, int] | None = None, rules: ConflictRules | None = None,
                  who: Mapping[str, str] | None = None) -> list[Cluster]:
    """Every cluster of the versions ``docs`` (letter -> document), in time order.

    ``who`` names the person behind each letter (default: each document's annotator ID; two corrections of
    one person's work carry the same annotator ID, so their correctors are given here). ``window`` is a
    half-open range of samples: marks outside it are left out and marks across its edges are clipped."""
    rules = rules or ConflictRules()
    letters = tuple(sorted(docs))
    names = {x: (who or {}).get(x) or docs[x].annotator_id for x in letters}
    marks = {x: _marks_of(x, names[x], docs[x], tuple(ch_names), window, rules) for x in letters}
    flat = [m for x in letters for m in marks[x]]
    index = {(m.letter, m.annotation_id): i for i, m in enumerate(flat)}
    parent = list(range(len(flat)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, b in combinations(letters, 2):
        ea, eb = [_as_event(m) for m in marks[a]], [_as_event(m) for m in marks[b]]
        out = match_events(ea, eb, sfreq=sfreq, criterion=rules.match_criterion, iou_threshold=rules.iou_threshold,
                           onset_tolerance_s=rules.onset_tolerance_s, offset_tolerance_s=rules.offset_tolerance_s,
                           require_channels=False, min_channel_jaccard=0.0, many_to_one=False, prefer_same_label=True)
        for i, j in out.pairs:
            ra, rb = find(index[(a, marks[a][i].annotation_id)]), find(index[(b, marks[b][j].annotation_id)])
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)
    groups: dict[int, list[Mark]] = {}
    for i, m in enumerate(flat):
        groups.setdefault(find(i), []).append(m)
    clusters = []
    for members in groups.values():
        members.sort(key=lambda m: (m.letter, m.start, m.stop, m.annotation_id))
        present = {m.letter for m in members}
        clusters.append(Cluster(conflict_id(unit_id, members), members, [x for x in letters if x not in present],
                                kinds_of(members, letters, sfreq, rules), letters))
    clusters.sort(key=lambda c: (c.start, c.stop, c.cluster_id))
    return clusters


# ------------------------------------------------------------------ decisions
def _median_sample(values: list[int]) -> int:
    v = sorted(values)
    n = len(v)
    mid = v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2
    return int(math.floor(mid + 0.5))


def _annotation(aid: str, label: str, start: int, stop: int, channels: tuple[str, ...]) -> ArtifactAnnotation:
    return ArtifactAnnotation(annotation_id=aid, label=label, onset_sample=int(start),
                              duration_samples=max(1, int(stop) - int(start)), channels=tuple(channels))


def agreed_mark(cluster: Cluster, ch_names: tuple[str, ...]) -> ArtifactAnnotation:
    """The one mark of a cluster: the most frequent type, the median onset and offset, and the channels most of the
    marks cover (the whole montage when most marks are whole-montage ones)."""
    ms = cluster.marks
    start, stop = _median_sample([m.start for m in ms]), _median_sample([m.stop for m in ms])
    if stop <= start:
        stop = start + 1
    if sum(1 for m in ms if m.whole_montage) * 2 > len(ms):
        chans: tuple[str, ...] = ()
    else:
        chans = tuple(c for c in ch_names if sum(1 for m in ms if c in m.covered) * 2 > len(ms))
        if not chans:  # no channel has a majority: those of the channel-specific marks together
            chans = tuple(c for c in ch_names if any(c in m.channels for m in ms))
    return _annotation(cluster.cluster_id, cluster.labels[0], start, stop, chans)


def _union_by_label(marks: list[Mark], ch_names: tuple[str, ...], base: str) -> list[ArtifactAnnotation]:
    out = []
    for n, label in enumerate(sorted({m.label for m in marks}), start=1):
        same = [m for m in marks if m.label == label]
        whole = any(m.whole_montage for m in same)
        chans = () if whole else tuple(c for c in ch_names if any(c in m.channels for m in same))
        out.append(_annotation(f"{base}-{n}", label, min(m.start for m in same), max(m.stop for m in same), chans))
    return out


def apply_decision(cluster: Cluster, decision: Mapping[str, Any],
                   ch_names: tuple[str, ...]) -> list[ArtifactAnnotation]:
    """The marks a decision keeps for a conflict.

    ``choice`` is a letter (that person's marks as they are), ``all`` (everyone's, merged by type: one mark per
    type spanning that type's marks, on the channels they cover together), ``none`` (no mark), or ``edited``
    (``marks``: the adjudicator's own, given as annotations)."""
    choice = decision.get("choice")
    base = cluster.cluster_id
    if choice in cluster.letters:
        return [_annotation(f"{base}-{choice}{n}", m.label, m.start, m.stop, m.channels)
                for n, m in enumerate(cluster.marks_of(str(choice)), start=1)]
    if choice == "all":
        return _union_by_label(cluster.marks, tuple(ch_names), base)
    if choice == "none":
        return []
    if choice == "edited":
        marks = list(decision.get("marks") or [])
        if not 1 <= len(marks) <= MAX_EDITED_MARKS:
            raise ConflictError(f"An edited decision holds 1 to {MAX_EDITED_MARKS} marks")
        out = []
        for n, a in enumerate(marks, start=1):
            if not isinstance(a, ArtifactAnnotation):
                raise ConflictError("The edited marks must be annotations")
            out.append(a.with_changes(annotation_id=f"{base}-e{n}", confidence=None, note=""))
        return out
    raise ConflictError(f"Unknown choice {choice!r}")


def adjudicated_annotations(clusters: Iterable[Cluster], decisions: Mapping[str, Mapping[str, Any]],
                            ch_names: tuple[str, ...]) -> list[ArtifactAnnotation]:
    """The adjudicated version: each agreed cluster's mark and each conflict's decided marks, in time order.
    Raises :class:`ConflictError` when a conflict has no decision."""
    out: list[ArtifactAnnotation] = []
    for c in clusters:
        if not c.is_conflict:
            out.append(agreed_mark(c, tuple(ch_names)))
            continue
        d = decisions.get(c.cluster_id)
        if d is None:
            raise ConflictError(f"The conflict {c.cluster_id} has no decision yet")
        out.extend(apply_decision(c, d, tuple(ch_names)))
    out.sort(key=lambda a: (a.onset_sample, a.duration_samples, a.label, a.annotation_id))
    return out


def label_pair(cluster: Cluster) -> tuple[str, str] | None:
    """The two types confused in a type conflict (in alphabetical order), or None (one type, or more than two)."""
    labels = sorted({m.label for m in cluster.marks})
    return (labels[0], labels[1]) if len(labels) == 2 else None


__all__ = ["CHOICE_WORDS", "KINDS", "LETTERS", "MAX_EDITED_MARKS", "Cluster", "ConflictError", "ConflictRules", "Mark",
           "adjudicated_annotations", "agreed_mark", "apply_decision", "conflict_id", "find_clusters", "kinds_of",
           "label_pair"]
