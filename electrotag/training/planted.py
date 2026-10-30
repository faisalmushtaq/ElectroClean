"""Correct the marks: a copy of the experts' reference with deliberate mistakes, for trainees to put right.

Part of the training path's "Learn with the experts" stage (docs/web/using.md): the trainee opens a
guided recording with a version of the experts' marks in which some are wrong or missing, corrects
them, and is told how many of the planted mistakes they fixed and whether they made new ones.

:func:`plant_errors` makes the flawed copy from a reference document, deterministically from a seed,
so that every trainee meets the same exercise and their results can be compared. Four kinds of
mistake are planted, each on a different reference mark and never overlapping another mark:

========== ===========================================================================================
missing    a reference mark left out (one at least 0.3 s from its neighbours, so that it is clearly absent)
type       a mark given a confusable type: another type of the same group in the catalogue (an eye
           blink called a vertical eye movement), or of the same section when the group has no other
boundary   the start or the end moved by two to three times the guided tolerance, without reaching a
           neighbour or leaving the recording
extra      a mark where the experts marked nothing, at least 1 s from every reference mark, of a type the
           reference uses, as long as its marks of that type usually are and on the channels of one of them
========== ===========================================================================================

Small references take fewer mistakes than asked (at most half of the reference's marks are changed,
and an extra mark needs room), and the result says so (``capped``). Every mark of the flawed copy has
a new identifier, derived from the seed, so that nothing in the copy tells a trainee which marks were
changed. :func:`errors_from` finds the mistakes in an expert's own deliberately flawed annotations
instead, and :func:`score_corrections` scores a trainee's corrected version: each planted mistake
fixed or not, and the new mistakes (a correct mark broken, or a mark added where the experts marked
nothing). The browser's ``js/training/planted_scoring.js`` scores the same way (the sandbox and an
expert trying the exercise), kept equal by ``web_tests/planted_parity.py``.

Everything here is plain Python on annotation documents: no web code, no files.
"""

from __future__ import annotations

import hashlib
import random
import statistics
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field, replace
from typing import Any

from electrotag.app.annotations.labels import LabelCatalogue
from electrotag.app.annotations.model import AnnotationDocument, ArtifactAnnotation
from electrotag.training.guided import Tolerance, channel_jaccard, iou, overlaps

#: The kinds of planted mistake, in the order they are planted and listed.
KINDS = ("missing", "type", "boundary", "extra")
#: The kinds :func:`errors_from` can also find in an expert's own flawed annotations.
FOUND_KINDS = (*KINDS, "channels")
DEFAULT_COUNTS = {"missing": 1, "type": 1, "boundary": 1, "extra": 1}
MAX_PER_KIND = 20
#: A mark left out is at least this far from its neighbours; an extra mark at least EXTRA_GAP_S from any mark.
MISSING_GAP_S = 0.3
EXTRA_GAP_S = 1.0
#: A moved boundary moves by this many times the guided tolerance of the mark (between the two, at random).
SHIFT_RANGE = (2.0, 3.0)
#: A mark is never shortened below this.
MIN_DURATION_S = 0.1
#: At most this share of the reference's marks are changed (missing, type and boundary together).
MAX_SHARE_CHANGED = 0.5


@dataclass
class PlantedVersion:
    """The flawed copy: its annotations, the mistakes planted (each naming the reference mark it concerns and the
    mark of the copy that carries it), the seed, how many of each kind were asked for and made."""

    annotations: list[ArtifactAnnotation]
    errors: list[dict[str, Any]]
    seed: int
    requested: dict[str, int]
    made: dict[str, int]
    capped: bool = False
    notes: list[str] = field(default_factory=list)


def check_counts(counts: Mapping[str, Any] | None) -> dict[str, int]:
    """How many mistakes of each kind to plant (``DEFAULT_COUNTS`` for the kinds not given)."""
    out = dict(DEFAULT_COUNTS)
    for k, v in dict(counts or {}).items():
        if k not in KINDS:
            raise ValueError(f"counts: {k!r} is not a kind of mistake ({', '.join(KINDS)})")
        if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= MAX_PER_KIND:
            raise ValueError(f"counts: the number of {k} mistakes is a whole number from 0 to {MAX_PER_KIND}")
        out[k] = v
    if not any(out.values()):
        raise ValueError("counts: plant at least one mistake")
    return out


def planted_id(seed: int, what: str) -> str:
    """A new mark's identifier: 32 hexadecimal characters from the seed and what the mark is (the same every time)."""
    return hashlib.sha256(f"electrotag-planted|{seed}|{what}".encode()).hexdigest()[:32]


def confusable(label: str, catalogue: LabelCatalogue, used: Iterable[str] = ()) -> list[str]:
    """Types a trainee could mistake ``label`` for: the other specific types of its group, else of its section,
    in catalogue order (those the reference uses first)."""
    try:
        item = catalogue.get(label)
    except Exception:  # noqa: BLE001 - a label the catalogue does not know has no siblings
        return []
    specific = [x for x in catalogue.labels if not x.is_group and x.label != label]
    same_parent = [x.label for x in specific if item.parent and x.parent == item.parent]
    pool = same_parent or [x.label for x in specific if x.section and x.section == item.section]
    used = set(used)
    return sorted(pool, key=lambda lab: (lab not in used, pool.index(lab)))


def _gap_ok(a: int, b: int, others: list[ArtifactAnnotation], gap: int) -> bool:
    """[a, b) keeps at least ``gap`` samples from every mark of ``others``."""
    return all(b + gap <= o.onset_sample or o.end_sample + gap <= a for o in others)


def _words_time(a: int, b: int, sfreq: float) -> str:
    return f"{a / sfreq:.2f}–{b / sfreq:.2f} s"


def plant_errors(ref: AnnotationDocument, *, seed: int, counts: Mapping[str, Any] | None = None,
                 catalogue: LabelCatalogue | None = None, tolerance: Tolerance | None = None) -> PlantedVersion:
    """A copy of ``ref``'s annotations with mistakes planted (see the module's description)."""
    want = check_counts(counts)
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError("seed must be a whole number")
    catalogue = catalogue or ref.catalogue
    tol = tolerance or Tolerance()
    timing = ref.recording.timing
    sf = float(timing.sfreq)
    n_samples = int(timing.n_samples)
    rng = random.Random(seed)
    refs = ref.sorted_annotations()
    used_labels = {a.label for a in refs}
    budget = max(1, int(len(refs) * MAX_SHARE_CHANGED)) if refs else 0
    made = {k: 0 for k in KINDS}
    notes: list[str] = []
    errors: list[dict[str, Any]] = []
    # Each reference mark is changed at most once; the copy is built from these.
    removed: set[str] = set()
    changed: dict[str, ArtifactAnnotation] = {}
    order = list(refs)
    rng.shuffle(order)
    min_gap = int(round(MISSING_GAP_S * sf))

    def neighbours(a: ArtifactAnnotation) -> list[ArtifactAnnotation]:
        return [changed.get(o.annotation_id, o) for o in refs if o.annotation_id != a.annotation_id
                and o.annotation_id not in removed]

    def free() -> list[ArtifactAnnotation]:
        return [x for x in order if x.annotation_id not in removed and x.annotation_id not in changed]

    # missing: a mark clearly apart from its neighbours
    for a in free():
        if made["missing"] >= want["missing"] or sum(made.values()) >= budget:
            break
        if not _gap_ok(a.onset_sample, a.end_sample, neighbours(a), min_gap):
            continue
        removed.add(a.annotation_id)
        made["missing"] += 1
        errors.append({"kind": "missing", "reference_id": a.annotation_id, "planted_id": None, "label": a.label,
                       "onset_sample": a.onset_sample, "end_sample": a.end_sample,
                       "detail": f"The {a.label} at {_words_time(a.onset_sample, a.end_sample, sf)} was left out."})
    # type: a confusable type
    for a in free():
        if made["type"] >= want["type"] or sum(made.values()) >= budget:
            break
        options = confusable(a.label, catalogue, used_labels)
        if not options:
            continue
        new = options[rng.randrange(len(options))] if len(options) > 1 else options[0]
        changed[a.annotation_id] = replace(a, label=new)
        made["type"] += 1
        errors.append({"kind": "type", "reference_id": a.annotation_id, "label": a.label, "planted_label": new,
                       "onset_sample": a.onset_sample, "end_sample": a.end_sample,
                       "detail": f"The {a.label} at {_words_time(a.onset_sample, a.end_sample, sf)} was "
                                 f"marked as {new}."})
    # boundary: the start or the end moved, without reaching a neighbour or leaving the recording
    for a in free():
        if made["boundary"] >= want["boundary"] or sum(made.values()) >= budget:
            break
        window = tol.window_s(a.duration_samples / sf)
        shift = int(round(rng.uniform(*SHIFT_RANGE) * window * sf))
        if shift <= 0:
            continue
        options = [("start", -1), ("start", 1), ("end", -1), ("end", 1)]
        rng.shuffle(options)
        others = neighbours(a)
        for edge, way in options:
            start, stop = a.onset_sample, a.end_sample
            if edge == "start":
                start += way * shift
            else:
                stop += way * shift
            if start < 0 or stop > n_samples or stop - start < max(1, int(round(MIN_DURATION_S * sf))):
                continue
            if not _gap_ok(start, stop, others, 1):
                continue
            changed[a.annotation_id] = replace(a, onset_sample=start, duration_samples=stop - start)
            made["boundary"] += 1
            moved = (start - a.onset_sample) if edge == "start" else (stop - a.end_sample)
            errors.append({"kind": "boundary", "reference_id": a.annotation_id, "label": a.label, "edge": edge,
                           "shift_s": round(moved / sf, 4), "onset_sample": a.onset_sample,
                           "end_sample": a.end_sample, "planted_onset_sample": start, "planted_end_sample": stop,
                           "detail": f"The {edge} of the {a.label} at "
                                     f"{_words_time(a.onset_sample, a.end_sample, sf)} was moved "
                                     f"{abs(moved) / sf:.2f} s {'earlier' if moved < 0 else 'later'}."})
            break
    # extra: a mark where the experts marked nothing
    extras: list[ArtifactAnnotation] = []
    if want["extra"] and refs:
        gap = int(round(EXTRA_GAP_S * sf))
        labels = sorted(used_labels)
        tries = 0
        while len(extras) < want["extra"] and tries < 200:
            tries += 1
            label = labels[rng.randrange(len(labels))]
            like = [a for a in refs if a.label == label]
            # as long as the reference's marks of that type usually are
            dur = max(1, int(round(statistics.median(a.duration_samples for a in like))))
            if n_samples - dur <= 0:
                continue
            start = rng.randrange(0, n_samples - dur)
            stop = start + dur
            if not _gap_ok(start, stop, list(refs) + list(changed.values()) + extras, gap):
                continue
            chans = like[rng.randrange(len(like))].channels if like else ()
            new = ArtifactAnnotation(planted_id(seed, f"extra{len(extras)}"), label, start, dur, tuple(chans))
            extras.append(new)
            errors.append({"kind": "extra", "reference_id": None, "planted_id": new.annotation_id, "label": label,
                           "onset_sample": start, "end_sample": stop,
                           "detail": f"{_article(label).capitalize()} {label} was added at "
                                     f"{_words_time(start, stop, sf)}, where the experts marked nothing."})
        made["extra"] = len(extras)
    # the copy: every kept mark under a new identifier
    out: list[ArtifactAnnotation] = []
    ids: dict[str, str] = {}
    for a in refs:
        if a.annotation_id in removed:
            continue
        b = changed.get(a.annotation_id, a)
        ids[a.annotation_id] = planted_id(seed, a.annotation_id)
        out.append(replace(b, annotation_id=ids[a.annotation_id], confidence=None, note=""))
    out.extend(extras)
    out.sort(key=lambda a: (a.onset_sample, a.duration_samples, a.label, a.annotation_id))
    for e in errors:
        if e["kind"] in ("type", "boundary"):
            e["planted_id"] = ids[e["reference_id"]]
    capped = any(made[k] < want[k] for k in KINDS)
    if capped:
        short = [f"{made[k]} of {want[k]} {k}" for k in KINDS if made[k] < want[k]]
        notes.append("This reference has too few marks, or too little room between them, for every mistake asked "
                     f"for: planted {', '.join(short)}.")
    errors.sort(key=lambda e: (KINDS.index(e["kind"]), e["onset_sample"]))
    return PlantedVersion(out, errors, seed, want, made, capped, notes)


def _article(word: str) -> str:
    return "an" if word[:1].lower() in "aeiou" else "a"


# ------------------------------------------------------------------ matching a mark with the experts'
def _problems(target: ArtifactAnnotation, cand: ArtifactAnnotation, sf: float, tol: Tolerance) -> list[str]:
    """What keeps ``cand`` from being the experts' ``target`` (as the guided coach checks a step): type, start, end,
    scope (whole montage or channels) or channels."""
    out = []
    if not tol.accepts(target.label, cand.label):
        out.append("type")
    window = tol.window_s(target.duration_samples / sf)
    if abs(cand.onset_sample - target.onset_sample) / sf > window + 1e-9:
        out.append("start")
    if abs(cand.end_sample - target.end_sample) / sf > window + 1e-9:
        out.append("end")
    if target.is_global != cand.is_global:
        out.append("scope")
    elif not target.is_global and channel_jaccard(cand, target) < tol.channel_jaccard - 1e-12:
        out.append("channels")
    return out


def assign(refs: list[ArtifactAnnotation], mine: list[ArtifactAnnotation], sf: float, tol: Tolerance
           ) -> dict[str, tuple[ArtifactAnnotation, list[str]]]:
    """For each reference mark (in time order) the overlapping mark of ``mine`` that stands for it: one not taken by
    an earlier reference mark, of an accepted type first, then overlapping most (then the earliest, then by
    identifier); with what keeps it from matching. Reference marks with no candidate are absent."""
    taken: set[str] = set()
    out: dict[str, tuple[ArtifactAnnotation, list[str]]] = {}
    for r in sorted(refs, key=lambda a: (a.onset_sample, a.end_sample, a.annotation_id)):
        cands = [m for m in mine if m.annotation_id not in taken and overlaps(m, r)]
        if not cands:
            continue
        best = sorted(cands, key=lambda m: (not tol.accepts(r.label, m.label), -iou(m, r), m.onset_sample,
                                            m.annotation_id))[0]
        taken.add(best.annotation_id)
        out[r.annotation_id] = (best, _problems(r, best, sf, tol))
    return out


def errors_from(flawed: AnnotationDocument, ref: AnnotationDocument, tolerance: Tolerance | None = None
                ) -> list[dict[str, Any]]:
    """The mistakes in an expert's deliberately flawed annotations of the reference's recording, found by comparing
    them with the reference: a reference mark nobody stands for is ``missing``; one stood for by a mark of another
    type ``type``, by one whose start or end is outside the tolerance ``boundary``, by one on other channels
    ``channels``; and a mark that stands for no reference mark is ``extra``."""
    tol = tolerance or Tolerance()
    sf = float(ref.recording.timing.sfreq)
    refs = ref.sorted_annotations()
    mine = flawed.sorted_annotations()
    matched = assign(refs, mine, sf, tol)
    used = {m.annotation_id for m, _p in matched.values()}
    errors: list[dict[str, Any]] = []
    for r in refs:
        when = _words_time(r.onset_sample, r.end_sample, sf)
        base = {"reference_id": r.annotation_id, "label": r.label, "onset_sample": r.onset_sample,
                "end_sample": r.end_sample}
        if r.annotation_id not in matched:
            errors.append({**base, "kind": "missing", "planted_id": None, "detail": f"The {r.label} at {when} is "
                           "not marked."})
            continue
        m, problems = matched[r.annotation_id]
        base["planted_id"] = m.annotation_id
        if "type" in problems:
            errors.append({**base, "kind": "type", "planted_label": m.label,
                           "detail": f"The {r.label} at {when} is marked as {m.label}."})
        elif "start" in problems or "end" in problems:
            edge = "start" if "start" in problems else "end"
            moved = (m.onset_sample - r.onset_sample) if edge == "start" else (m.end_sample - r.end_sample)
            errors.append({**base, "kind": "boundary", "edge": edge, "shift_s": round(moved / sf, 4),
                           "planted_onset_sample": m.onset_sample, "planted_end_sample": m.end_sample,
                           "detail": f"The {edge} of the {r.label} at {when} is {abs(moved) / sf:.2f} s "
                                     f"{'early' if moved < 0 else 'late'}."})
        elif "scope" in problems or "channels" in problems:
            errors.append({**base, "kind": "channels", "detail": f"The {r.label} at {when} is marked on other "
                           "channels than the experts'."})
    for m in mine:
        if m.annotation_id in used:
            continue
        errors.append({"kind": "extra", "reference_id": None, "planted_id": m.annotation_id, "label": m.label,
                       "onset_sample": m.onset_sample, "end_sample": m.end_sample,
                       "detail": f"{_article(m.label).capitalize()} {m.label} is marked at "
                                 f"{_words_time(m.onset_sample, m.end_sample, sf)}, where the experts marked "
                                 "nothing."})
    errors.sort(key=lambda e: (FOUND_KINDS.index(e["kind"]), e["onset_sample"]))
    return errors


# ------------------------------------------------------------------ scoring a trainee's corrections
def score_corrections(errors: list[dict[str, Any]], mine: list[ArtifactAnnotation], ref: list[ArtifactAnnotation],
                      sfreq: float, tolerance: Tolerance | None = None,
                      planted: list[ArtifactAnnotation] | None = None) -> dict[str, Any]:
    """How the trainee's corrected annotations ``mine`` deal with the planted ``errors``.

    A mistake on a reference mark is fixed when the trainee's mark that stands for it (:func:`assign`) has the
    experts' type, start, end and channels within the tolerance; an extra mark is fixed when no mark of the
    trainee's that stands for no reference mark still overlaps it. New mistakes are the reference marks no mistake
    touched that no longer match (``broken``), and the trainee's marks that stand for no reference mark and overlap
    no planted extra (``added``). ``planted`` (the copy the trainee started from) lets an added mark that was in the
    copy be told from one the trainee made."""
    tol = tolerance or Tolerance()
    sf = float(sfreq)
    refs = sorted(ref, key=lambda a: (a.onset_sample, a.end_sample, a.annotation_id))
    by_id = {r.annotation_id: r for r in refs}
    matched = assign(refs, mine, sf, tol)
    used = {m.annotation_id for m, _p in matched.values()}
    loose = [m for m in mine if m.annotation_id not in used]
    items: list[dict[str, Any]] = []
    fixed = 0
    concerned: set[str] = set()
    extras: list[tuple[int, int]] = []
    for e in errors:
        kind = e.get("kind")
        rid = e.get("reference_id")
        if kind == "extra" or not rid:
            span = (int(e["onset_sample"]), int(e["end_sample"]))
            extras.append(span)
            still = [m for m in loose if m.onset_sample < span[1] and span[0] < m.end_sample]
            ok = not still
            problems = ["still_there"] if still else []
        else:
            concerned.add(str(rid))
            got = matched.get(str(rid))
            problems = ["missing"] if got is None else list(got[1])
            ok = not problems
            if rid not in by_id:  # a reference mark that is no longer in the reference: counts as not fixed
                ok, problems = False, ["unknown"]
        fixed += ok
        items.append({"kind": kind, "fixed": ok, "problems": problems, "label": e.get("label"),
                      "onset_s": round(int(e["onset_sample"]) / sf, 4), "offset_s": round(int(e["end_sample"]) / sf, 4),
                      "detail": e.get("detail", ""), "reference_id": rid, "planted_id": e.get("planted_id")})
    new: list[dict[str, Any]] = []
    for r in refs:
        if r.annotation_id in concerned:
            continue
        got = matched.get(r.annotation_id)
        if got is None or got[1]:
            new.append({"kind": "broken", "label": r.label, "problems": ["missing"] if got is None else list(got[1]),
                        "onset_s": round(r.onset_sample / sf, 4), "offset_s": round(r.end_sample / sf, 4),
                        "detail": f"The {r.label} at {_words_time(r.onset_sample, r.end_sample, sf)} was right, "
                                  + ("and is now missing." if got is None else "and no longer matches the experts'.")})
    planted_ids = {a.annotation_id for a in planted or []}
    for m in loose:
        if any(m.onset_sample < b and a < m.end_sample for a, b in extras):
            continue  # counted with the planted extra it overlaps
        new.append({"kind": "added", "label": m.label, "problems": [], "onset_s": round(m.onset_sample / sf, 4),
                    "offset_s": round(m.end_sample / sf, 4), "from_copy": m.annotation_id in planted_ids,
                    "detail": f"{_article(m.label).capitalize()} {m.label} at "
                              f"{_words_time(m.onset_sample, m.end_sample, sf)} is where the experts marked nothing."})
    n = len(errors)
    return {"n_errors": n, "fixed": fixed, "not_fixed": n - fixed, "new_mistakes": len(new), "items": items,
            "new": new, "message": score_message(fixed, n, len(new))}


def score_message(fixed: int, n: int, new: int) -> str:
    """The sentence the trainee reads: "You fixed 3 of 4 planted mistakes." and the new ones."""
    text = f"You fixed {fixed} of {n} planted mistake{'s' if n != 1 else ''}."
    if new:
        text += f" {new} new mistake{'s' if new != 1 else ''}: look at the list below."
    return text


# ------------------------------------------------------------------ storing it with the reference set
def wire(a: ArtifactAnnotation) -> dict[str, Any]:
    """An annotation as it is stored with the planted version and sent (samples, as the API's Annotation)."""
    return {"annotation_id": a.annotation_id, "label": a.label, "onset_sample": int(a.onset_sample),
            "duration_samples": int(a.duration_samples), "channels": list(a.channels)}


def from_wire(d: Mapping[str, Any]) -> ArtifactAnnotation:
    return ArtifactAnnotation(str(d["annotation_id"]), str(d["label"]), int(d["onset_sample"]),
                              int(d["duration_samples"]), tuple(str(c) for c in d.get("channels") or ()))


def reference_sha256(ref: AnnotationDocument) -> str:
    """A fingerprint of the reference's marks, kept with the planted version to notice a reference replaced since."""
    rows = sorted((a.annotation_id, a.label, a.onset_sample, a.duration_samples, tuple(a.channels))
                  for a in ref.annotations)
    return hashlib.sha256(repr(rows).encode()).hexdigest()


__all__ = ["DEFAULT_COUNTS", "FOUND_KINDS", "KINDS", "PlantedVersion", "assign", "check_counts", "confusable",
           "errors_from", "from_wire", "plant_errors", "planted_id", "reference_sha256", "score_corrections",
           "score_message", "wire"]
