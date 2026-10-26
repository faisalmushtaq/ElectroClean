"""Consensus references from several experts, and disagreement lists for adjudication.

Consensus rule (per artifact category, applied sample by sample):

* **Time.** A sample is in the consensus when at least ``min_agreement``
  experts marked that category there (overlapping annotations by one expert
  count once). Consecutive consensus samples form one consensus interval.
  Fragments shorter than ``min_duration_s`` are dropped and fragments separated
  by gaps shorter than ``merge_gap_s`` are joined (both 0 by default, i.e.
  the rule is applied exactly).
* **Channels.** For each consensus interval, every expert who marked the
  category during it contributes the channels of those annotations (a
  whole-montage annotation contributes every channel). The interval is
  whole-montage when at least ``min_agreement`` of those experts used whole
  montage; otherwise it covers the channels chosen by at least
  ``min_agreement`` experts. If no channel reaches that level the interval is
  kept as whole-montage and listed as a channel disagreement.

The default ``min_agreement`` is a strict majority of the experts.
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


def _partial_intervals(lists: list[list[Interval]], n: int) -> list[tuple[int, int, int]]:
    """Segments covered by some but not all lists: (start, stop, count)."""
    deltas: dict[int, int] = {}
    for ints in lists:
        for a, b in ints:
            deltas[a] = deltas.get(a, 0) + 1
            deltas[b] = deltas.get(b, 0) - 1
    out = []
    level = 0
    pts = sorted(deltas)
    for x0, x1 in zip(pts[:-1], pts[1:]):
        level += deltas[x0]
        if 0 < level < n and x1 > x0:
            if out and out[-1][1] == x0 and out[-1][2] == level:
                out[-1] = (out[-1][0], x1, level)
            else:
                out.append((x0, x1, level))
    return out


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
        if d.catalogue.sha256 != experts[0].catalogue.sha256:
            raise AnnotationError("Expert files use different label catalogues")
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
    for label in experts[0].catalogue.label_names:
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
            for d in experts:
                overlapping = [x for x in d.annotations if x.label == label and x.onset_sample < b and a < x.end_sample]
                if not overlapping:
                    continue
                contributing.append(d.annotator_id)
                if any(x.is_global for x in overlapping):
                    whole += 1
                    chans = set(ch_names)
                else:
                    chans = {c for x in overlapping for c in x.channels}
                for c in chans:
                    channel_votes[c] = channel_votes.get(c, 0) + 1
            if whole >= k:
                channels: tuple[str, ...] = ()
            else:
                channels = tuple(c for c in ch_names if channel_votes.get(c, 0) >= k)
                if not channels:
                    disagreements.append({
                        "kind": "channels", "label": label, "onset_s": a / timing.sfreq, "offset_s": b / timing.sfreq,
                        "experts_marking": ", ".join(contributing), "experts_not_marking": "",
                        "note": "no channel was chosen by enough experts; consensus set to whole montage",
                    })
            anns.append(ArtifactAnnotation(new_annotation_id(), label, a, b - a, channels, stamp, stamp))
        for a, b, level in _partial_intervals(per_expert, n):
            marking = [d.annotator_id for d, ints in zip(experts, per_expert) if any(x0 < b and a < x1 for x0, x1 in ints)]
            disagreements.append({
                "kind": "time", "label": label, "onset_s": a / timing.sfreq, "offset_s": b / timing.sfreq,
                "experts_marking": ", ".join(marking),
                "experts_not_marking": ", ".join(i for i in ids if i not in marking),
                "note": f"{level} of {n} experts; {'in' if level >= k else 'not in'} consensus",
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
        catalogue=experts[0].catalogue,
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
