"""Consensus references from several experts, and disagreement lists for adjudication.

Consensus rule (per artifact category, applied sample by sample):

* **Time.** A sample is in the consensus when at least ``min_agreement``
  experts marked that category there (overlapping annotations by one expert
  count once). Consecutive consensus samples form one consensus interval.
  Gaps of at most ``merge_gap_s`` between consensus intervals are then joined,
  and intervals shorter than ``min_duration_s`` dropped (both 0 by default,
  i.e. the rule is applied exactly).
* **Channels.** For each consensus interval, every expert who marked the
  category during it contributes the channels of those annotations (a
  whole-montage annotation contributes every channel). The interval is
  whole-montage when at least ``min_agreement`` of those experts used whole
  montage; otherwise it covers the channels chosen by at least
  ``min_agreement`` experts. If no channel reaches that level the interval is
  kept as whole-montage and listed as a channel disagreement.

The default ``min_agreement`` is a strict majority of the experts.

The disagreement list has one row for every stretch of time during which the
same subset of experts (some but not all) marked a category, noting whether
that stretch ended up in the consensus after the duration and gap rules, and
one row for every consensus interval where the contributing experts chose
different channels.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from electroclean import __version__
from electroclean.app.annotations.model import AnnotationDocument, AnnotationError, ArtifactAnnotation
from electroclean.app.common import new_annotation_id, now_local_iso
from electroclean.reliability.intervals import Interval, union
from electroclean.reliability.timeresolved import category_intervals


@dataclass
class ConsensusResult:
    document: AnnotationDocument
    disagreements: list[dict[str, Any]]
    rule: dict[str, Any]


def _threshold_intervals(lists: list[list[Interval]], k: int, n_samples: int) -> list[Interval]:
    deltas: dict[int, int] = {}
    for ints in lists:
        for a, b in ints:
            deltas[a] = deltas.get(a, 0) + 1
            deltas[b] = deltas.get(b, 0) - 1
    out: list[Interval] = []
    level = 0
    start = None
    for x in sorted(deltas):
        level += deltas[x]
        if level >= k and start is None:
            start = x
        elif level < k and start is not None:
            out.append((start, x))
            start = None
    if start is not None:
        out.append((start, n_samples))
    return out


def _partial_intervals(lists: list[list[Interval]], n: int) -> list[tuple[int, int, tuple[int, ...]]]:
    """Segments covered by some but not all lists: ``(start, stop, indices of the covering lists)``.

    Adjacent segments are joined only when exactly the same lists cover them.
    """
    points = sorted({x for ints in lists for iv in ints for x in iv})
    out: list[tuple[int, int, tuple[int, ...]]] = []
    for x0, x1 in zip(points[:-1], points[1:]):
        members = tuple(i for i, ints in enumerate(lists) if any(a <= x0 and x1 <= b for a, b in ints))
        if 0 < len(members) < n:
            if out and out[-1][1] == x0 and out[-1][2] == members:
                out[-1] = (out[-1][0], x1, members)
            else:
                out.append((x0, x1, members))
    return out


def _covered(a: int, b: int, intervals: list[Interval]) -> int:
    return sum(max(0, min(b, y) - max(a, x)) for x, y in intervals)


def build_consensus(
    experts: list[AnnotationDocument],
    *,
    min_agreement: int | None = None,
    min_duration_s: float = 0.0,
    merge_gap_s: float = 0.0,
) -> ConsensusResult:
    if len(experts) < 2:
        raise AnnotationError("A consensus needs at least two experts")
    rec = experts[0].recording
    ids = [d.annotator_id for d in experts]
    if len(set(ids)) != len(ids):
        raise AnnotationError("Each expert may contribute only one annotation file per recording")
    for d in experts[1:]:
        if d.recording.recording_id != rec.recording_id or d.recording.timing != rec.timing:
            raise AnnotationError("All expert files must refer to the same recording with the same timing")
        if d.catalogue.sha256 != experts[0].catalogue.sha256 and not d.catalogue.compatible_with(experts[0].catalogue):
            raise AnnotationError("Expert files use label catalogues that give labels or codes different meanings")
    n = len(experts)
    k = min_agreement if min_agreement is not None else math.floor(n / 2) + 1
    if not 1 <= k <= n:
        raise AnnotationError(f"min_agreement must be between 1 and {n}")
    timing = rec.timing
    ch_names = rec.ch_names
    min_len = timing.duration_to_samples(min_duration_s)
    gap = timing.duration_to_samples(merge_gap_s)
    stamp = now_local_iso()
    anns: list[ArtifactAnnotation] = []
    disagreements: list[dict[str, Any]] = []
    catalogue = max((d.catalogue for d in experts), key=lambda c: len(c.labels))
    for label in catalogue.label_names:
        per_expert = [category_intervals(d, label) for d in experts]
        if not any(per_expert):
            continue
        cons = _threshold_intervals(per_expert, k, timing.n_samples)
        if gap > 0:
            cons = union((a, b + gap) for a, b in cons)
            cons = [(a, min(b - gap, timing.n_samples)) for a, b in cons]
        cons = [(a, b) for a, b in cons if b - a >= max(1, min_len)]
        for a, b in cons:
            contributing = []
            whole = 0
            channel_votes: dict[str, int] = {}
            selections: list[str] = []
            chosen: set[frozenset[str] | None] = set()  # None = whole montage
            for d in experts:
                overlapping = [x for x in d.annotations if x.label == label and x.onset_sample < b and a < x.end_sample]
                if not overlapping:
                    continue
                contributing.append(d.annotator_id)
                if any(x.is_global for x in overlapping):
                    whole += 1
                    chans = set(ch_names)
                    selections.append(f"{d.annotator_id}: whole montage")
                    chosen.add(None)
                else:
                    chans = {c for x in overlapping for c in x.channels}
                    selections.append(f"{d.annotator_id}: {','.join(c for c in ch_names if c in chans)}")
                    chosen.add(frozenset(chans))
                for c in chans:
                    channel_votes[c] = channel_votes.get(c, 0) + 1
            if whole >= k:
                channels: tuple[str, ...] = ()
            else:
                channels = tuple(c for c in ch_names if channel_votes.get(c, 0) >= k)
            if len(chosen) > 1:
                outcome = (
                    "whole montage" if whole >= k else
                    ",".join(channels) if channels else "whole montage (no channel was chosen by enough experts)"
                )
                disagreements.append({
                    "kind": "channels", "label": label, "onset_s": a / timing.sfreq, "offset_s": b / timing.sfreq,
                    "experts_marking": ", ".join(contributing),
                    "experts_not_marking": ", ".join(i for i in ids if i not in contributing),
                    "note": f"channel selections differ ({'; '.join(selections)}); consensus: {outcome}",
                })
            anns.append(ArtifactAnnotation(new_annotation_id(), label, a, b - a, channels, stamp, stamp))
        for a, b, members in _partial_intervals(per_expert, n):
            marking = [ids[i] for i in members]
            inside = _covered(a, b, cons)
            status = "in consensus" if inside == b - a else "not in consensus" if inside == 0 else "partly in consensus"
            note = f"{len(members)} of {n} experts; {status}"
            if (len(members) >= k) != (status == "in consensus"):
                note += " (after the minimum-duration and gap rules)"
            disagreements.append({
                "kind": "time", "label": label, "onset_s": a / timing.sfreq, "offset_s": b / timing.sfreq,
                "experts_marking": ", ".join(marking),
                "experts_not_marking": ", ".join(i for i in ids if i not in marking),
                "note": note,
            })
    rule = {
        "method": "consensus",
        "experts": ids,
        "min_agreement": k,
        "n_experts": n,
        "min_duration_s": min_duration_s,
        "merge_gap_s": merge_gap_s,
        "description": "sample-wise vote per category; channels by the same vote among contributing experts",
    }
    doc = AnnotationDocument(
        recording=rec,
        annotator_id="REFERENCE",
        annotator_display_name="Consensus",
        annotations=anns,
        catalogue=catalogue,
        session_id="consensus",
        mode="reference",
        created_at=stamp,
        app_version=__version__,
        context={"consensus_rule": rule},
    )
    doc.validate()
    disagreements.sort(key=lambda d: (d["onset_s"], d["label"], d["kind"]))
    return ConsensusResult(doc, disagreements, rule)


def disagreements_tsv(rows: list[dict[str, Any]]) -> bytes:
    from electroclean.app.io.tsv import tsv_bytes

    cols = ["kind", "label", "onset_s", "offset_s", "experts_marking", "experts_not_marking", "note"]
    return tsv_bytes(cols, [[f"{r[c]:.4f}" if isinstance(r[c], float) else str(r[c]) for c in cols] for r in rows])
