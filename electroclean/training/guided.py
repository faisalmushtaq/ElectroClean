"""Stage 1 of the training programme: learn with the experts, one annotation at a time.

The experts' annotations of a recording become *steps*, in the order they occur. For each step
the trainee marks the artifact with the normal tools; every change is checked at once against the
expert's annotation, with specific feedback, and the trainee moves on only when it matches.

What counts as a match (:class:`Tolerance`, set per reference set in ``guided.tolerance``):

* the same artifact type (or an alternative the reference set accepts for it);
* a start and an end each within ``max(seconds, fraction × the expert's duration)`` of the
  expert's (0.2 s or 20 %, whichever is larger, by default);
* the same scope (whole montage, or particular channels);
* for channel-specific annotations, enough of the same channels (Jaccard index of at least 0.75
  by default: the channels both chose divided by the channels either chose).

This module has no Qt code; the coach panel is in :mod:`electroclean.training.guided_gui`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from electroclean.app.annotations.model import AnnotationDocument, ArtifactAnnotation

#: Stars for a step: first attempt, within three attempts, otherwise (or with Show me).
STARS_FIRST, STARS_FEW, STARS_SHOWN = 3, 2, 1
FEW_ATTEMPTS = 3


@dataclass(frozen=True)
class Tolerance:
    """How close a trainee's annotation must be to the expert's to count as the same."""

    seconds: float = 0.2  # start and end each within this many seconds ...
    fraction: float = 0.2  # ... or this fraction of the expert's duration, whichever is larger
    channel_jaccard: float = 0.75  # channel-specific annotations: shared channels / channels either chose
    accepted_labels: dict[str, list[str]] = field(default_factory=dict)  # expert label -> also accepted

    def window_s(self, duration_s: float) -> float:
        return max(self.seconds, self.fraction * max(duration_s, 0.0))

    def accepts(self, expert_label: str, label: str) -> bool:
        return label == expert_label or label in self.accepted_labels.get(expert_label, [])

    def to_dict(self) -> dict[str, Any]:
        return {"seconds": self.seconds, "fraction": self.fraction, "channel_jaccard": self.channel_jaccard,
                "accepted_labels": {k: list(v) for k, v in self.accepted_labels.items()}}

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> Tolerance:
        d = dict(d or {})
        tol = cls(
            seconds=float(d.get("seconds", cls.seconds)),
            fraction=float(d.get("fraction", cls.fraction)),
            channel_jaccard=float(d.get("channel_jaccard", cls.channel_jaccard)),
            accepted_labels={str(k): [str(x) for x in v] for k, v in dict(d.get("accepted_labels", {})).items()},
        )
        if tol.seconds < 0 or tol.fraction < 0:
            raise ValueError("guided.tolerance: seconds and fraction must not be negative")
        if not 0.0 < tol.channel_jaccard <= 1.0:
            raise ValueError("guided.tolerance: channel_jaccard must be above 0 and at most 1")
        return tol


@dataclass(frozen=True)
class Step:
    index: int  # 0-based
    target: ArtifactAnnotation  # the expert's annotation
    note: str = ""  # the experts' explanation, if any


def build_steps(reference: AnnotationDocument, notes: dict[str, str] | None = None) -> list[Step]:
    """The expert annotations of a recording as steps, in order of onset (then end)."""
    notes = notes or {}
    ordered = sorted(reference.annotations, key=lambda a: (a.onset_sample, a.end_sample, a.label))
    return [Step(i, a, str(notes.get(a.annotation_id, ""))) for i, a in enumerate(ordered)]


def overlaps(a: ArtifactAnnotation, b: ArtifactAnnotation) -> bool:
    return a.onset_sample < b.end_sample and b.onset_sample < a.end_sample


def iou(a: ArtifactAnnotation, b: ArtifactAnnotation) -> float:
    inter = min(a.end_sample, b.end_sample) - max(a.onset_sample, b.onset_sample)
    union = max(a.end_sample, b.end_sample) - min(a.onset_sample, b.onset_sample)
    return max(inter, 0) / union if union > 0 else 0.0


def channel_jaccard(a: ArtifactAnnotation, b: ArtifactAnnotation) -> float:
    x, y = set(a.channels), set(b.channels)
    return len(x & y) / len(x | y) if (x | y) else 1.0


def article(word: str) -> str:
    """'an' before a vowel (an Eye-blink-artifact, an EMG-artifact), otherwise 'a'."""
    return "an" if word[:1].upper() in "AEIOU" else "a"


def list_words(items: list[str]) -> str:
    """'Fp1', 'Fp1 and Fp2', 'Fp1, Fp2 and VEOG'."""
    items = list(items)
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


@dataclass
class Check:
    """The result of checking the trainee's work against one step."""

    matched: bool
    candidate_id: str | None  # the trainee's annotation judged to be the attempt at this step
    problems: list[str]  # codes: missing, type, start, end, scope, channels
    messages: list[str]  # plain-language feedback, one item per problem (or the success message)
    deltas: dict[str, Any] = field(default_factory=dict)

    def to_log(self) -> dict[str, Any]:
        return {"matched": self.matched, "candidate": self.candidate_id, "problems": list(self.problems),
                "deltas": dict(self.deltas)}


def _key_hint(label: str, quick_keys: dict[str, int] | None) -> str:
    key = (quick_keys or {}).get(label)
    return f" (press {key})" if key else " (press / and type its name)"


def check_step(
    step: Step,
    annotations: list[ArtifactAnnotation],
    sfreq: float,
    tol: Tolerance,
    *,
    taken: set[str] | frozenset[str] = frozenset(),
    quick_keys: dict[str, int] | None = None,
) -> Check:
    """Check the trainee's annotations against one step.

    The attempt is the trainee's annotation that overlaps the expert's (and is not already the
    match of an earlier step): one of an accepted type first, then the one that overlaps most.
    """
    target = step.target
    candidates = [a for a in annotations if a.annotation_id not in taken and overlaps(a, target)]
    if not candidates:
        return Check(False, None, ["missing"], ["Not marked yet."])
    cand = max(candidates, key=lambda a: (tol.accepts(target.label, a.label), iou(a, target)))
    problems: list[str] = []
    messages: list[str] = []
    deltas: dict[str, Any] = {}
    if not tol.accepts(target.label, cand.label):
        problems.append("type")
        messages.append(
            f"Type: the experts marked this as {article(target.label)} {target.label}"
            f"{_key_hint(target.label, quick_keys)}; yours is {article(cand.label)} {cand.label}."
        )
    window = tol.window_s(target.duration_samples / sfreq)
    d_start = (cand.onset_sample - target.onset_sample) / sfreq
    d_end = (cand.end_sample - target.end_sample) / sfreq
    deltas.update(start_s=round(d_start, 4), end_s=round(d_end, 4), allowed_s=round(window, 4),
                  iou=round(iou(cand, target), 4))
    if abs(d_start) > window:
        problems.append("start")
        when = "early" if d_start < 0 else "late"
        messages.append(f"Almost: the start is {abs(d_start):.2f} s too {when}. Drag the left edge to move it.")
    if abs(d_end) > window:
        problems.append("end")
        when = "early" if d_end < 0 else "late"
        messages.append(f"Almost: the end is {abs(d_end):.2f} s too {when}. Drag the right edge to move it.")
    if target.is_global and not cand.is_global:
        problems.append("scope")
        messages.append(
            "Channels: the experts marked this on the whole montage. Right-click it and choose "
            "Apply to whole montage, or switch to Whole montage (C) and mark it again."
        )
    elif not target.is_global and cand.is_global:
        problems.append("scope")
        messages.append(
            f"Channels: the experts marked this on {list_words(list(target.channels))} only. Right-click it and "
            "choose Edit channels…, or choose those channels (Selected channels, C) and mark it again."
        )
    elif not target.is_global:
        jac = channel_jaccard(cand, target)
        deltas["channel_jaccard"] = round(jac, 4)
        if jac < tol.channel_jaccard:
            problems.append("channels")
            missing = [c for c in target.channels if c not in cand.channels]
            extra = [c for c in cand.channels if c not in target.channels]
            parts = []
            if missing:
                parts.append(f"{list_words(missing)} {'is' if len(missing) == 1 else 'are'} missing")
            if extra:
                parts.append(f"{list_words(extra)} {'is' if len(extra) == 1 else 'are'} not part of it")
            messages.append(
                f"Channels: the experts marked this on {list_words(list(target.channels))}; "
                + "; ".join(parts) + ". Shift+click a channel inside the annotation to add or remove it."
            )
    if problems:
        return Check(False, cand.annotation_id, problems, messages, deltas)
    what = "Right type and timing" if target.is_global else "Right type, timing and channels"
    return Check(True, cand.annotation_id, [], [what + "."], deltas)


def extras(steps: list[Step], annotations: list[ArtifactAnnotation], matched: dict[int, str],
           current: Check | None = None, current_index: int | None = None) -> list[ArtifactAnnotation]:
    """Annotations the trainee should remove: those that overlap no expert annotation at all, and
    second attempts at a step already matched or being worked on."""
    keep = set(matched.values())
    if current is not None and current.candidate_id:
        keep.add(current.candidate_id)
    out = []
    for a in annotations:
        if a.annotation_id in keep:
            continue
        hits = [s for s in steps if overlaps(a, s.target)]
        if not hits:
            out.append(a)
            continue
        # An annotation over a later step is the trainee working ahead, which is fine; one that only
        # overlaps steps already matched (or the current one, whose attempt is another annotation)
        # is a second attempt.
        if not [s for s in hits if s.index not in matched and s.index != current_index]:
            out.append(a)
    return out


def stars_for(failed_attempts: int, shown: bool) -> int:
    if shown:
        return STARS_SHOWN
    if failed_attempts == 0:
        return STARS_FIRST
    if failed_attempts < FEW_ATTEMPTS:
        return STARS_FEW
    return STARS_SHOWN


def describe_target(target: ArtifactAnnotation, sfreq: float) -> str:
    """'Eye-blink-artifact, 3.00–3.40 s, on Fp1, Fp2 and VEOG' (for the log and the summary)."""
    where = "whole montage" if target.is_global else "on " + list_words(list(target.channels))
    return (f"{target.label}, {target.onset_sample / sfreq:.2f}–{target.end_sample / sfreq:.2f} s, {where}")


def example_note(label: str, duration_s: float, channels: tuple[str, ...]) -> str:
    """A placeholder note that is true by construction for a simulated artifact."""
    kind = " ".join(w if w.isupper() else w.lower() for w in label.replace("-artifact", "").split("-"))  # EMG stays EMG
    where = "every channel" if not channels else list_words(list(channels))
    return (f"Placeholder note (simulated data): this is a simulated {kind} artifact on {where}, lasting "
            f"{duration_s:.2f} s. Replace it with your experts' explanation.")
