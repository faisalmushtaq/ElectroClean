"""Choosing which recording an annotator works on next.

Three strategies are supported (``selection.strategy`` in the settings):

``random``
    A random eligible recording each time (the original behaviour).
``seeded``
    A reproducible order per annotator: all recordings are shuffled with a
    random generator seeded by the study seed and the annotator ID, and the
    first eligible recording in that order is offered. Re-running the study
    with the same seed gives every annotator the same sequence.
``manual``
    The study configuration lists the recordings assigned to each annotator
    (in order); only those recordings are offered.

:func:`balanced_allocation` helps an administrator create manual assignments
with a controlled overlap, for example "every recording annotated by exactly
two of the five annotators".
"""

from __future__ import annotations

import hashlib
import random
from collections.abc import Iterable
from dataclasses import dataclass, field

from electroclean.app.io.discovery import RecordingFiles


@dataclass
class SelectionResult:
    recording: RecordingFiles | None
    n_total: int
    n_completed: int
    n_failed: int
    n_assigned: int
    n_eligible: int
    message: str = ""
    excluded_reasons: dict[str, str] = field(default_factory=dict)


def _seed_for(seed: int, annotator_id: str) -> int:
    digest = hashlib.sha256(f"{seed}:{annotator_id}".encode()).hexdigest()
    return int(digest[:16], 16)


def seeded_order(recording_ids: Iterable[str], seed: int, annotator_id: str) -> list[str]:
    ids = sorted(set(recording_ids))
    rng = random.Random(_seed_for(seed, annotator_id))
    rng.shuffle(ids)
    return ids


def select_next(
    recordings: list[RecordingFiles],
    *,
    annotator_id: str,
    completed: set[str],
    failed: Iterable[str],
    strategy: str,
    seed: int | None = None,
    manual_assignments: dict[str, tuple[str, ...]] | None = None,
    session_excluded: Iterable[str] = (),
    restrict_to: Iterable[str] | None = None,
    rng: random.Random | None = None,
) -> SelectionResult:
    """Pick the next recording, or explain why none is available."""
    by_id = {r.recording_id: r for r in recordings}
    failed_set = set(failed)
    excluded = set(session_excluded)
    reasons: dict[str, str] = {}
    pool = sorted(by_id)
    if restrict_to is not None:
        allowed = set(restrict_to)
        pool = [r for r in pool if r in allowed]
    if strategy == "manual":
        assigned = list((manual_assignments or {}).get(annotator_id, ()))
        unknown = [a for a in assigned if a not in by_id]
        for a in unknown:
            reasons[a] = "assigned but not found in the dataset"
        pool = [a for a in assigned if a in by_id and a in set(pool)]
    n_assigned = len(pool)
    eligible = []
    for rid in pool:
        if rid in completed:
            reasons[rid] = "already completed by this annotator"
        elif rid in failed_set:
            reasons[rid] = "failed to load previously and has not been fixed"
        elif rid in excluded:
            reasons[rid] = "skipped earlier in this session"
        else:
            eligible.append(rid)
    n_completed = sum(1 for rid in pool if rid in completed)
    n_failed = sum(1 for rid in pool if rid in failed_set and rid not in completed)
    result = SelectionResult(
        recording=None,
        n_total=len(by_id),
        n_completed=n_completed,
        n_failed=n_failed,
        n_assigned=n_assigned,
        n_eligible=len(eligible),
        excluded_reasons=reasons,
    )
    if not eligible:
        if strategy == "manual" and n_assigned == 0:
            result.message = f"No recordings are assigned to annotator {annotator_id} in the study configuration."
        elif n_completed == n_assigned and n_assigned > 0:
            result.message = "All eligible recordings have been completed. Thank you!"
        elif n_assigned == 0:
            result.message = (
                "No recordings were found in this folder or its sub-folders. ElectroClean looks for files "
                "whose names end in _eeg.vhdr (BrainVision), _eeg.edf (EDF) or _eeg.bdf (BDF)."
            )
        else:
            n_skipped = sum(1 for r in reasons.values() if r == "skipped earlier in this session")
            parts = []
            if n_completed:
                parts.append(f"{n_completed} completed by you")
            if n_failed:
                parts.append(
                    f"{n_failed} could not be opened (they are listed in failed_load.txt in the results folder; "
                    "please tell the study administrator)"
                )
            if n_skipped:
                parts.append(f"{n_skipped} skipped earlier in this session (they are offered again next time)")
            result.message = "No other recordings are available now: " + "; ".join(parts) + "."
        return result
    if strategy == "random":
        chooser = rng or random.SystemRandom()
        rid = chooser.choice(eligible)
    elif strategy == "seeded":
        order = seeded_order(by_id, seed if seed is not None else 0, annotator_id)
        eligible_set = set(eligible)
        rid = next(r for r in order if r in eligible_set)
    elif strategy == "manual":
        rid = eligible[0]
    else:
        raise ValueError(f"Unknown selection strategy {strategy!r}")
    result.recording = by_id[rid]
    return result


def balanced_allocation(
    recording_ids: Iterable[str],
    annotators: list[str],
    raters_per_recording: int,
    seed: int,
) -> dict[str, list[str]]:
    """Assign each recording to ``raters_per_recording`` annotators.

    Workload is balanced (annotators differ by at most one recording) and
    pairs of annotators share recordings as evenly as the numbers allow. The
    result is deterministic for a given seed and can be written into the
    study configuration as manual assignments.
    """
    ids = sorted(set(recording_ids))
    if not 1 <= raters_per_recording <= len(annotators):
        raise ValueError("raters_per_recording must be between 1 and the number of annotators")
    rng = random.Random(seed)
    rng.shuffle(ids)
    load = {a: 0 for a in annotators}
    pair_count: dict[tuple[str, str], int] = {}
    out: dict[str, list[str]] = {a: [] for a in annotators}
    for rid in ids:
        chosen: list[str] = []
        for _ in range(raters_per_recording):
            candidates = [a for a in annotators if a not in chosen]
            rng.shuffle(candidates)
            candidates.sort(
                key=lambda a: (
                    load[a],
                    sum(pair_count.get(tuple(sorted((a, c))), 0) for c in chosen),
                )
            )
            pick = candidates[0]
            for c in chosen:
                key = tuple(sorted((pick, c)))
                pair_count[key] = pair_count.get(key, 0) + 1
            chosen.append(pick)
            load[pick] += 1
        for a in chosen:
            out[a].append(rid)
    for a in out:
        rng.shuffle(out[a])
    return out
