"""Which versions of the annotations an agreement analysis uses (``AnalysisConfig.versions``).

A study keeps every annotator's saved attempts as they were made (the **originals**), and, beside
them in ``Annotated_Events/derived/``, two kinds of **derived version** with their provenance in
``context.derived`` (docs/file_formats.md): an expert's correction of someone's saved attempt, and
an adjudicated version, the outcome of an expert deciding every conflict between two or more
versions. The analyses choose among them:

``original`` (the default)
    The originals only; derived versions are left out, so the results are those of a study
    without corrections or adjudication.
``corrected``
    Each annotator's latest attempt of a recording is replaced by its correction where an expert
    corrected that attempt. When two or more experts corrected the same attempt, their corrections
    were compared and adjudicated like independent annotations (the project lead's decision of
    29 October), and the finished adjudication of those corrections stands for the corrected
    version. Until it is finished, the recording is reported as *correction pending adjudication*
    and left out, with a warning that names it. A correction of an earlier attempt than the latest
    is not used, and a warning names it too.
``adjudicated``
    Every annotator is compared with the adjudicated version of each finished adjudication (its
    reference annotator is ``ADJUDICATED``), using the versions the adjudication compared. A
    recording without a finished adjudication is left out.

An adjudication of a task's part of a recording (a window), and with ``unit = "task"`` every task
with a window, is analysed on that part only: the documents are cropped to the window
(:func:`crop_to_window`) and the part becomes a group of its own, ``<recording>#<task>``, so that
the clean rest of the recording does not inflate the agreement.

Besides choosing, this module measures what the corrections and the adjudication changed
(:func:`correction_effect`, :func:`adjudication_effect`): the changes by reason and the agreement
of each corrected file with its original, and for each adjudication the conflicts by kind and by
pair of types, the decisions by choice, the agreement before and after adjudication and how many of
each annotator's marks the adjudicated version kept. The decisions and the tasks come from the
study's records (``adjudications/<unit>.json`` and ``tasks/tasks.json`` of the results folder, or
the study itself in the admin area); everything else comes from the annotation files alone.
"""

from __future__ import annotations

import json
import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from electrotag.app.annotations.model import AnnotationDocument, AnnotationError, ArtifactAnnotation
from electrotag.app.annotations.timing import RecordingTiming
from electrotag.reliability.config import ADJUDICATED, ANY_ARTIFACT

if TYPE_CHECKING:
    from electrotag.reliability.config import AnalysisConfig

Item = tuple[str, AnnotationDocument]  # (source, document)
Key = tuple[str, str]  # (recording or group, annotator)

#: The columns of versions.tsv, corrections_effect.tsv, adjudication.tsv, adjudication_pairs.tsv and
#: adjudication_survival.tsv (docs/reliability_guide.md, "Versions of the annotations").
VERSIONS_COLUMNS = ["recording", "annotator", "version", "attempt", "source", "corrected_by", "correction_id",
                    "unit_id", "note"]
CORRECTION_COLUMNS = ["recording", "annotator", "attempt", "corrected_by", "via", "n_original", "n_corrected",
                      "added", "removed", "changed", "relabelled", "reasons", "f1_with_original", "n_matched"]
ADJUDICATION_COLUMNS = ["unit_id", "unit_kind", "recording", "group", "window_start_s", "window_end_s",
                        "adjudicator", "annotators", "n_conflicts", "presence", "type", "timing", "channels", "split",
                        "kept_one", "kept_all", "kept_none", "edited", "n_decided", "mean_decision_s",
                        "f1_before", "f1_after", "n_adjudicated"]
PAIR_COLUMNS = ["label_1", "label_2", "n_conflicts", "n_units", "kept_label_1", "kept_label_2", "kept_both",
                "kept_neither_or_edited"]
SURVIVAL_COLUMNS = ["annotator", "unit_id", "recording", "n_marks", "n_kept", "share_kept", "n_conflict_marks",
                    "n_decided_for"]

REASON_WORDS = {"missed": "missed artifact", "not_artifact": "not an artifact", "wrong_type": "wrong type",
                "boundaries": "start or end", "channels": "channels", "split_merge": "split or merge",
                "other": "other"}


# ------------------------------------------------------------------ provenance
def derived_of(doc: AnnotationDocument) -> dict[str, Any] | None:
    """A document's ``context.derived`` (its provenance as a derived version), or None for an original."""
    d = (doc.context or {}).get("derived") if isinstance(doc.context, dict) else None
    return d if isinstance(d, dict) and d else None


def _kind(doc: AnnotationDocument) -> str:
    d = derived_of(doc) or {}
    return str(d.get("kind") or "")


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _instant(stamp: Any) -> float:
    try:
        t = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return float("-inf")
    return t.timestamp() if t.tzinfo else t.replace(tzinfo=None).timestamp()


# ------------------------------------------------------------------ cropping
def crop_to_window(doc: AnnotationDocument, start: int, end: int, group_id: str) -> AnnotationDocument:
    """The part ``[start, end)`` (whole samples) of a document as a document of its own: annotations outside it
    left out, those across its edges clipped, every onset shifted so that the part starts at sample 0, the
    recording's length the part's, and its recording ID ``group_id``."""
    timing = doc.recording.timing
    start, end = max(0, int(start)), min(int(end), int(timing.n_samples))
    if end <= start:
        raise AnnotationError(f"The window {start}–{end} lies outside {doc.recording.recording_id}")
    anns = []
    for a in doc.annotations:
        a0, a1 = max(a.onset_sample, start), min(a.end_sample, end)
        if a1 <= a0:
            continue
        anns.append(replace(a, onset_sample=a0 - start, duration_samples=a1 - a0))
    cropped = RecordingTiming(sfreq=timing.sfreq, n_samples=end - start, first_samp=timing.first_samp + start,
                              meas_date=timing.meas_date)
    rec = replace(doc.recording, recording_id=group_id, timing=cropped)
    return replace(doc, recording=rec, annotations=anns)


def window_of(value: Any) -> tuple[int, int] | None:
    if isinstance(value, Mapping) and "start_sample" in value and "end_sample" in value:
        return _int(value["start_sample"]), _int(value["end_sample"])
    return None


# ------------------------------------------------------------------ the study's records
@dataclass
class StudyRecords:
    """What the annotation files do not say: the adjudications' decisions (by unit ID) and the tasks (by task ID)."""

    adjudications: dict[str, dict[str, Any]] = field(default_factory=dict)
    tasks: dict[str, dict[str, Any]] = field(default_factory=dict)
    found: bool = False  # True when records were given or found (with none, the decisions are not reported)

    @classmethod
    def of(cls, adjudications: Iterable[dict[str, Any]] = (), tasks: Iterable[dict[str, Any]] = ()) -> StudyRecords:
        adj = {str(r.get("unit_id") or r.get("task_id")): dict(r) for r in adjudications
               if isinstance(r, dict) and (r.get("unit_id") or r.get("task_id"))}
        tk = {str(t["task_id"]): dict(t) for t in tasks if isinstance(t, dict) and t.get("task_id")}
        return cls(adj, tk, True)

    def known_answer_recordings(self) -> set[str]:
        """The recordings whose every task (not removed) is a known-answer task: these are never adjudicated."""
        kinds: dict[str, set[bool]] = {}
        for t in self.tasks.values():
            if t.get("state") == "removed" or not t.get("recording_id"):
                continue
            kinds.setdefault(str(t["recording_id"]), set()).add(bool(t.get("gold")))
        return {rid for rid, k in kinds.items() if k == {True}}

    @classmethod
    def read(cls, folders: Iterable[Path | str]) -> StudyRecords:
        """The records a results folder holds (``adjudications/<unit>.json``, ``tasks/tasks.json``), as
        ``electrotag-web export`` and the admin area's results zip write them."""
        adj: list[dict[str, Any]] = []
        tasks: list[dict[str, Any]] = []
        found = False
        for folder in folders:
            p = Path(folder)
            if not p.is_dir():
                continue
            for f in sorted((p / "adjudications").glob("*.json")):
                try:
                    rec = json.loads(f.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if isinstance(rec, dict) and rec.get("schema") == "electrotag.adjudication":
                    adj.append(rec)
                    found = True
            tf = p / "tasks" / "tasks.json"
            if tf.is_file():
                try:
                    data = json.loads(tf.read_text(encoding="utf-8"))
                    tasks.extend(t for t in data.get("tasks", []) if isinstance(t, dict))
                    found = True
                except (OSError, ValueError, AttributeError):
                    pass
        out = cls.of(adj, tasks)
        out.found = found
        return out


# ------------------------------------------------------------------ the selection
@dataclass
class CorrectedPair:
    """An original and the version that replaced it in a ``corrected`` analysis."""

    key: Key
    original: Item
    corrected: Item
    correctors: list[str]
    via: str  # "correction" (one expert) or "adjudication" (several experts' corrections, adjudicated)
    unit_id: str = ""


@dataclass
class AdjudicatedUnit:
    """A finished adjudication as a ``adjudicated`` analysis uses it: the adjudicated version and the versions it
    compared (each by the person who made it), on the whole recording or on the unit's window."""

    unit_id: str
    unit_kind: str
    recording_id: str
    group_id: str
    adjudicated: Item
    inputs: dict[str, Item]  # person -> their version, as compared (cropped to the window when there is one)
    window: tuple[int, int] | None
    derived: dict[str, Any]


@dataclass
class Selection:
    """What :func:`select_versions` chose."""

    versions: str
    chosen: dict[Key, Item]
    warnings: list[str] = field(default_factory=list)
    rows: list[dict[str, Any]] = field(default_factory=list)
    corrected: list[CorrectedPair] = field(default_factory=list)
    units: list[AdjudicatedUnit] = field(default_factory=list)
    left_out: list[str] = field(default_factory=list)  # recordings (or groups) left out, with the reason in rows
    records: StudyRecords = field(default_factory=StudyRecords)

    def summary(self) -> dict[str, Any]:
        """``summary.versions`` of the admin area's answer: the version used, how many files it replaced, by whom."""
        by: dict[str, int] = {}
        for p in self.corrected:
            for who in p.correctors:
                by[who] = by.get(who, 0) + 1
        for u in self.units:
            who = str(u.derived.get("adjudicator_id") or "")
            if who:
                by[who] = by.get(who, 0) + 1
        return {"used": self.versions, "replaced": len(self.corrected) if self.versions == "corrected"
                else len(self.units), "by": dict(sorted(by.items())), "left_out": list(self.left_out),
                "pending": [r["recording"] for r in self.rows if r.get("version") == "pending"]}


def _row(key: Key, item: Item, version: str, **extra: Any) -> dict[str, Any]:
    from electrotag.reliability.data import _attempt

    source, doc = item
    return {"recording": key[0], "annotator": key[1], "version": version, "attempt": _attempt(source, doc),
            "source": source, "corrected_by": "", "correction_id": "", "unit_id": "", "note": "", **extra}


def _derived_order(item: Item) -> tuple[int, float, str]:
    from electrotag.reliability.data import _attempt

    return (_attempt(item[0], item[1]), _instant(item[1].created_at), item[0])


def select_versions(originals: Mapping[Key, list[Item]], chosen: Mapping[Key, Item], derived: Iterable[Item],
                    config: AnalysisConfig, *, records: StudyRecords | None = None) -> Selection:
    """The documents an analysis of ``config.versions`` compares.

    ``originals`` holds every original attempt of each (recording, annotator), oldest first; ``chosen`` the one the
    duplicate policy chose (the latest); ``derived`` the corrections and adjudicated versions found."""
    records = records or StudyRecords()
    versions = config.versions
    if versions == "original":
        sel = Selection(versions, dict(chosen), records=records)
    elif versions == "corrected":
        sel = _corrected(originals, chosen, list(derived), records)
    else:
        sel = _adjudicated(originals, list(derived), config, records)
    if config.unit == "task" and versions != "adjudicated":
        _by_task(sel, records)
    if versions == "original":
        sel.rows = [_row(k, v, "original") for k, v in sorted(sel.chosen.items())]
    return sel


def _corrected(originals: Mapping[Key, list[Item]], chosen: Mapping[Key, Item], derived: list[Item],
               records: StudyRecords) -> Selection:
    from electrotag.reliability.data import _attempt

    sel = Selection("corrected", {}, records=records)
    corrections: dict[Key, list[Item]] = {}
    adjudicated: dict[tuple[str, str, int], list[Item]] = {}
    for item in derived:
        doc = item[1]
        d = derived_of(doc) or {}
        rid = doc.recording.recording_id
        if d.get("kind") == "correction":
            frm = d.get("corrected_from") if isinstance(d.get("corrected_from"), dict) else {}
            aid = str(frm.get("annotator_id") or doc.annotator_id)
            corrections.setdefault((rid, aid), []).append(item)
        elif d.get("kind") == "adjudication" and d.get("unit_kind") == "corrections" \
                and isinstance(d.get("corrected"), dict):
            c = d["corrected"]
            adjudicated.setdefault((rid, str(c.get("annotator_id")), _int(c.get("attempt"), 1)), []).append(item)
    pending_recordings: dict[str, str] = {}
    for key, item in sorted(chosen.items()):
        rid, aid = key
        latest = _attempt(*item)
        mine = sorted(corrections.get(key, []), key=_derived_order)
        of_latest: dict[str, Item] = {}  # corrector -> their latest correction of the latest attempt
        stale: list[tuple[str, int]] = []
        for c in mine:
            d = derived_of(c[1]) or {}
            frm = d.get("corrected_from") if isinstance(d.get("corrected_from"), dict) else {}
            attempt = _int(frm.get("attempt"), 1)
            who = str(d.get("corrector_id") or "")
            if attempt == latest:
                of_latest[who] = c
            else:
                stale.append((who, attempt))
        for who, attempt in sorted(set(stale)):
            sel.warnings.append(f"{who or 'An expert'}'s correction of {aid}'s {rid} corrects version {attempt}, and "
                                f"{aid} has saved a later version ({latest}) since, so the correction is not used")
        if not of_latest:
            sel.chosen[key] = item
            sel.rows.append(_row(key, item, "original"))
            continue
        if len(of_latest) == 1:
            who, c = next(iter(of_latest.items()))
            d = derived_of(c[1]) or {}
            sel.chosen[key] = c
            sel.corrected.append(CorrectedPair(key, item, c, [who], "correction"))
            sel.rows.append(_row(key, c, "corrected", attempt=latest, corrected_by=who,
                                 correction_id=str(d.get("correction_id") or c[1].session_id)))
            continue
        # Two or more experts corrected the same version: the adjudication of their corrections stands for it.
        done = sorted(adjudicated.get((rid, aid, latest), []), key=_derived_order)
        correctors = sorted(of_latest)
        if not done:
            pending_recordings[rid] = (f"{rid}: correction pending adjudication ({aid}'s version {latest} was "
                                       f"corrected by {', '.join(correctors)}, and the adjudication of their "
                                       "corrections is not finished), so the recording is left out")
            sel.rows.append(_row(key, item, "pending", attempt=latest, corrected_by=", ".join(correctors),
                                 note="correction pending adjudication"))
            continue
        a = done[-1]
        d = derived_of(a[1]) or {}
        uid = str(d.get("task_id") or d.get("unit_id") or "")
        used = {str((v or {}).get("correction_id") or "") for v in (d.get("inputs") or {}).values()
                if isinstance(v, dict)}
        later = [who for who, c in of_latest.items()
                 if str((derived_of(c[1]) or {}).get("correction_id") or c[1].session_id) not in used]
        if later and used != {""}:
            sel.warnings.append(f"{', '.join(sorted(later))} corrected {aid}'s {rid} again after the adjudication of "
                                f"the corrections ({uid}) was finished; the adjudicated version is used")
        version = replace(a[1], annotator_id=aid)
        sel.chosen[key] = (a[0], version)
        sel.corrected.append(CorrectedPair(key, item, (a[0], version), correctors, "adjudication", uid))
        sel.rows.append(_row(key, a, "corrected", attempt=latest, corrected_by=", ".join(correctors), unit_id=uid,
                             note=f"the adjudication of the corrections, by {d.get('adjudicator_id') or 'an expert'}"))
    for rid, text in sorted(pending_recordings.items()):
        # the whole recording waits: the others' versions are left out with it
        sel.warnings.append(text)
        sel.rows = [r for r in sel.rows if r["recording"] != rid or r["version"] == "pending"]
        for k in sorted(k for k in sel.chosen if k[0] == rid):
            sel.rows.append(_row(k, sel.chosen.pop(k), "left_out", note="correction pending adjudication"))
        sel.corrected = [p for p in sel.corrected if p.key[0] != rid]
        sel.left_out.append(rid)
    sel.rows.sort(key=lambda r: (r["recording"], r["annotator"]))
    return sel


def _input_item(originals: Mapping[Key, list[Item]], rid: str, aid: str, attempt: int) -> Item | None:
    from electrotag.reliability.data import _attempt

    items = originals.get((rid, aid)) or []
    return next((it for it in reversed(items) if _attempt(*it) == attempt), None)


def _adjudicated(originals: Mapping[Key, list[Item]], derived: list[Item], config: AnalysisConfig,
                 records: StudyRecords) -> Selection:
    sel = Selection("adjudicated", {}, records=records)
    by_unit: dict[str, list[Item]] = {}
    for item in derived:
        d = derived_of(item[1]) or {}
        if d.get("kind") != "adjudication" or d.get("unit_kind") == "corrections":
            continue
        by_unit.setdefault(str(d.get("task_id") or d.get("unit_id") or item[1].session_id), []).append(item)
    per_recording: dict[str, int] = {}
    for items in by_unit.values():
        rid = items[0][1].recording.recording_id
        per_recording[rid] = per_recording.get(rid, 0) + 1
    covered: set[str] = set()
    for uid, items in sorted(by_unit.items()):
        a = sorted(items, key=_derived_order)[-1]
        d = derived_of(a[1]) or {}
        rid = a[1].recording.recording_id
        window = window_of(d.get("window"))
        group = rid if window is None and per_recording[rid] == 1 else f"{rid}#{uid}"
        inputs: dict[str, Item] = {}
        for person, inp in sorted((d.get("inputs") or {}).items()):
            if not isinstance(inp, dict) or (inp.get("source") or "original") != "original":
                continue
            aid = str(inp.get("annotator_id") or person)
            if config.annotators is not None and aid not in config.annotators:
                continue
            attempt = _int(inp.get("attempt"), 1)
            it = _input_item(originals, rid, aid, attempt)
            if it is None:
                sel.warnings.append(f"{aid}'s version {attempt} of {rid}, which the adjudication {uid} compared, is "
                                    "not among the files analysed, so it is left out of that comparison")
                continue
            inputs[aid] = it
        if window is not None:
            a = (a[0], crop_to_window(a[1], window[0], window[1], group))
            inputs = {p: (s, crop_to_window(doc, window[0], window[1], group)) for p, (s, doc) in inputs.items()}
        elif group != rid:
            a = (a[0], replace(a[1], recording=replace(a[1].recording, recording_id=group)))
            inputs = {p: (s, replace(doc, recording=replace(doc.recording, recording_id=group)))
                      for p, (s, doc) in inputs.items()}
        a = (a[0], replace(a[1], annotator_id=ADJUDICATED))
        unit = AdjudicatedUnit(uid, str(d.get("unit_kind") or "recording"), rid, group, a, inputs, window, d)
        sel.units.append(unit)
        covered.add(rid)
        sel.chosen[(group, ADJUDICATED)] = a
        sel.rows.append(_row((group, ADJUDICATED), a, "adjudicated", unit_id=uid,
                             note=f"adjudicated by {d.get('adjudicator_id') or 'an expert'}"))
        for aid, it in inputs.items():
            sel.chosen[(group, aid)] = it
            sel.rows.append(_row((group, aid), it, "original", unit_id=uid, note="a version the adjudication compared"))
    left = sorted({rid for rid, _aid in originals} - covered)
    if left:
        # Known-answer recordings are scored against their references and never adjudicated: they are left out
        # as well, without a warning that would ask for an adjudication.
        known = records.known_answer_recordings() if records is not None else set()
        unfinished = [rid for rid in left if rid not in known]
        if unfinished:
            names = ", ".join(unfinished[:10]) + (f" and {len(unfinished) - 10} more" if len(unfinished) > 10 else "")
            many = len(unfinished) != 1
            sel.warnings.append(f"{len(unfinished)} recording{'s have' if many else ' has'} no finished adjudication "
                                f"and {'are' if many else 'is'} left out of this analysis of the adjudicated "
                                f"versions: {names}")
        sel.left_out.extend(left)
    if not sel.units:
        sel.warnings.append("No adjudication is finished yet, so there is no adjudicated version to compare with")
    return sel


def _by_task(sel: Selection, records: StudyRecords) -> None:
    """``unit = "task"``: each task with a window becomes a group of its own, its annotators' documents cropped to
    the window."""
    if not records.tasks:
        sel.warnings.append("The analysis by task needs the study's tasks (tasks/tasks.json of the results folder); "
                            "none were found, so the recordings are analysed whole")
        return
    for tid, t in sorted(records.tasks.items()):
        if t.get("gold") or t.get("state") == "removed":
            continue
        window = window_of(t.get("window"))
        if window is None:
            continue
        rid = str(t.get("recording_id") or "")
        group = f"{rid}#{tid}"
        for aid in t.get("annotators") or []:
            key = (rid, str(aid))
            if key not in sel.chosen:
                continue
            source, doc = sel.chosen.pop(key)
            sel.chosen[(group, str(aid))] = (source, crop_to_window(doc, window[0], window[1], group))
            for r in sel.rows:
                if r["recording"] == rid and r["annotator"] == aid:
                    r["recording"] = group
            for p in sel.corrected:
                if p.key == key:
                    p.key = (group, str(aid))


# ------------------------------------------------------------------ what corrections changed
def _events(doc: AnnotationDocument, ch_names: tuple[str, ...], window: tuple[int, int] | None = None) -> list[Any]:
    from electrotag.reliability.matching import events_for

    evs = events_for(doc, ANY_ARTIFACT, ch_names)
    if window is not None:
        evs = [e for e in evs if e.stop > window[0] and e.start < window[1]]
    return evs


def _f1(a: list[Any], b: list[Any], sfreq: float, *, criterion: str, threshold: float, onset_tol: float,
        offset_tol: float) -> tuple[float, int]:
    """Event F1 of two lists of events matched type by type (one-to-one), as the report's micro-average over the
    categories computes it, and the number of matched pairs."""
    from electrotag.reliability.matching import match_events

    if not a and not b:
        return float("nan"), 0
    n = 0
    for label in sorted({e.label for e in a} & {e.label for e in b}):
        ea, eb = [e for e in a if e.label == label], [e for e in b if e.label == label]
        out = match_events(ea, eb, sfreq=sfreq, criterion=criterion, iou_threshold=threshold,
                           onset_tolerance_s=onset_tol, offset_tolerance_s=offset_tol, require_channels=False,
                           min_channel_jaccard=0.0, many_to_one=False)
        n += len(out.pairs)
    return 2 * n / (len(a) + len(b)), n


def _diff(before: list[ArtifactAnnotation], after: list[ArtifactAnnotation]) -> dict[str, int]:
    old = {a.annotation_id: a for a in before}
    new = {a.annotation_id: a for a in after}
    changed = relabelled = 0
    for k in set(old) & set(new):
        a, b = old[k], new[k]
        if (a.label, a.onset_sample, a.duration_samples, tuple(a.channels), a.confidence, a.note) != \
                (b.label, b.onset_sample, b.duration_samples, tuple(b.channels), b.confidence, b.note):
            changed += 1
            relabelled += a.label != b.label
    return {"added": len(set(new) - set(old)), "removed": len(set(old) - set(new)), "changed": changed,
            "relabelled": relabelled}


def correction_effect(pairs: Iterable[CorrectedPair], config: AnalysisConfig) -> list[dict[str, Any]]:
    """corrections_effect.tsv: for each corrected file, the changes (by reason, when one expert gave them) and the
    event F1 between the original and the corrected version (type by type, time only, at the main threshold)."""
    from electrotag.reliability.data import _attempt

    rows = []
    for p in pairs:
        (src, orig), (_s, corr) = p.original, p.corrected
        ch = tuple(orig.recording.ch_names)
        d = derived_of(corr) or {}
        reasons: dict[str, int] = {}
        for c in d.get("changes") or []:
            if isinstance(c, dict) and c.get("reason"):
                reasons[str(c["reason"])] = reasons.get(str(c["reason"]), 0) + 1
        diff = _diff(orig.annotations, corr.annotations)
        f1, n = _f1(_events(orig, ch), _events(corr, ch), orig.recording.timing.sfreq,
                       criterion=config.match_criterion, threshold=config.primary_iou_threshold,
                       onset_tol=config.onset_tolerance_s, offset_tol=config.offset_tolerance_s)
        rows.append({"recording": p.key[0], "annotator": p.key[1], "attempt": _attempt(src, orig),
                     "corrected_by": ", ".join(p.correctors), "via": p.via, "n_original": len(orig.annotations),
                     "n_corrected": len(corr.annotations), **diff,
                     "reasons": json.dumps(dict(sorted(reasons.items())), ensure_ascii=False), "f1_with_original": f1,
                     "n_matched": n})
    return rows


# ------------------------------------------------------------------ what the adjudication changed
def _decided_for(choice: Any, letters: dict[str, str]) -> list[str]:
    """The people whose marks a decision kept (a letter, or all of them)."""
    person = {x: p for p, x in letters.items()}
    if choice in person:
        return [person[choice]]
    if choice == "all":
        return sorted(person.values())
    return []


def adjudication_effect(units: Iterable[AdjudicatedUnit], config: AnalysisConfig,
                        records: StudyRecords | None = None) -> dict[str, list[dict[str, Any]]]:
    """adjudication.tsv (per adjudication), adjudication_pairs.tsv (type conflicts by pair of types) and
    adjudication_survival.tsv (per annotator and adjudication: how many of their marks the adjudicated version kept).

    The conflicts are found again from the versions compared, with the adjudication's own frozen rules, as the
    expert area finds them; the decisions and their times come from the study's records when given."""
    from electrotag.reliability.conflicts import ConflictRules, find_clusters, label_pair

    records = records or StudyRecords()
    rows: list[dict[str, Any]] = []
    pairs: dict[tuple[str, str], dict[str, Any]] = {}
    survival: list[dict[str, Any]] = []
    for u in units:
        d = u.derived
        rules = ConflictRules.from_dict(d.get("rules") if isinstance(d.get("rules"), dict) else None)
        inputs = d.get("inputs") or {}
        letters = {p: str((v or {}).get("letter") or "") for p, v in inputs.items() if isinstance(v, dict)}
        docs = {letters[p]: doc for p, (_s, doc) in u.inputs.items() if letters.get(p)}
        adj_doc = u.adjudicated[1]
        sfreq = adj_doc.recording.timing.sfreq
        ch = tuple(adj_doc.recording.ch_names)
        # the documents are cropped already: the window is the whole of them
        clusters = find_clusters(docs, ch_names=ch, sfreq=sfreq, unit_id=u.unit_id, rules=rules,
                                 who={x: p for p, x in letters.items()}) if len(docs) >= 2 else []
        conflicts = [c for c in clusters if c.is_conflict]
        rec = records.adjudications.get(u.unit_id) or {}
        decisions = rec.get("decisions") if isinstance(rec.get("decisions"), dict) else {}
        by_choice = {"one": 0, "all": 0, "none": 0, "edited": 0}
        times: list[float] = []
        previous = rec.get("started_at")
        for dec in sorted((x for x in decisions.values() if isinstance(x, dict)),
                          key=lambda x: str(x.get("decided_at") or "~")):
            ch_ = dec.get("choice")
            by_choice["one" if ch_ in letters.values() else str(ch_) if ch_ in by_choice else "edited"] += 1
            if dec.get("decided_at") and previous:
                gap = _instant(dec["decided_at"]) - _instant(previous)
                if math.isfinite(gap) and gap >= 0:
                    times.append(gap)
                previous = dec["decided_at"]
        # agreement before (between the versions compared) and after (each with the adjudicated version)
        evs = {p: _events(doc, ch) for p, (_s, doc) in u.inputs.items()}
        adj_evs = _events(adj_doc, ch)
        kw = {"criterion": config.match_criterion, "threshold": config.primary_iou_threshold,
              "onset_tol": config.onset_tolerance_s, "offset_tol": config.offset_tolerance_s}
        people = sorted(evs)
        before = [_f1(evs[a], evs[b], sfreq, **kw)[0] for i, a in enumerate(people) for b in people[i + 1:]]
        after = [_f1(adj_evs, evs[a], sfreq, **kw)[0] for a in people]
        kinds = {k: sum(1 for c in conflicts if k in c.kinds) for k in ("presence", "type", "timing", "channels",
                                                                      "split")}
        w = u.window
        rows.append({"unit_id": u.unit_id, "unit_kind": u.unit_kind, "recording": u.recording_id, "group": u.group_id,
                     "window_start_s": w[0] / sfreq if w else None, "window_end_s": w[1] / sfreq if w else None,
                     "adjudicator": d.get("adjudicator_id") or rec.get("adjudicator_id") or "",
                     "annotators": ", ".join(people), "n_conflicts": len(conflicts), **kinds,
                     "kept_one": by_choice["one"] if decisions else None,
                     "kept_all": by_choice["all"] if decisions else None,
                     "kept_none": by_choice["none"] if decisions else None,
                     "edited": by_choice["edited"] if decisions else None,
                     "n_decided": len(decisions) if records.found else None,
                     "mean_decision_s": sum(times) / len(times) if times else None,
                     "f1_before": _mean(before), "f1_after": _mean(after), "n_adjudicated": len(adj_doc.annotations)})
        for c in conflicts:
            lp = label_pair(c) if "type" in c.kinds else None
            if lp is None:
                continue
            acc = pairs.setdefault(lp, {"label_1": lp[0], "label_2": lp[1], "n_conflicts": 0, "units": set(),
                                        "kept_label_1": 0, "kept_label_2": 0, "kept_both": 0,
                                        "kept_neither_or_edited": 0})
            acc["n_conflicts"] += 1
            acc["units"].add(u.unit_id)
            dec = decisions.get(c.cluster_id) if decisions else None
            if isinstance(dec, dict):
                kept = {m.label for m in c.marks if m.annotator_id in _decided_for(dec.get("choice"), letters)}
                if kept == {lp[0]}:
                    acc["kept_label_1"] += 1
                elif kept == {lp[1]}:
                    acc["kept_label_2"] += 1
                elif kept >= {lp[0], lp[1]}:
                    acc["kept_both"] += 1
                else:
                    acc["kept_neither_or_edited"] += 1
        for p in people:
            _f, n_kept = _f1(evs[p], adj_evs, sfreq, **kw)
            in_conflict = [m for c in conflicts for m in c.marks if m.annotator_id == p]
            decided_for = sum(1 for c in conflicts if isinstance(decisions.get(c.cluster_id), dict)
                              and p in _decided_for(decisions[c.cluster_id].get("choice"), letters)) \
                if decisions else None
            survival.append({"annotator": p, "unit_id": u.unit_id, "recording": u.group_id, "n_marks": len(evs[p]),
                             "n_kept": n_kept, "share_kept": n_kept / len(evs[p]) if evs[p] else float("nan"),
                             "n_conflict_marks": len(in_conflict), "n_decided_for": decided_for})
    pair_rows = sorted(({**{k: v for k, v in acc.items() if k != "units"}, "n_units": len(acc["units"])}
                        for acc in pairs.values()), key=lambda r: (-r["n_conflicts"], r["label_1"], r["label_2"]))
    if not records.found:
        for r in pair_rows:
            for k in ("kept_label_1", "kept_label_2", "kept_both", "kept_neither_or_edited"):
                r[k] = None
    return {"adjudication": rows, "adjudication_pairs": pair_rows, "adjudication_survival": survival}


def survival_by_annotator(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """adjudication_survival.tsv summed over the adjudications, one row per annotator (for the report)."""
    acc: dict[str, dict[str, Any]] = {}
    for r in rows:
        a = acc.setdefault(r["annotator"], {"annotator": r["annotator"], "adjudications": 0, "n_marks": 0,
                                            "n_kept": 0})
        a["adjudications"] += 1
        a["n_marks"] += int(r["n_marks"])
        a["n_kept"] += int(r["n_kept"])
    return [{**a, "share_kept": a["n_kept"] / a["n_marks"] if a["n_marks"] else float("nan")}
            for _k, a in sorted(acc.items())]


def _mean(values: list[float]) -> float:
    v = [x for x in values if isinstance(x, float) and math.isfinite(x)]
    return sum(v) / len(v) if v else float("nan")


def version_tables(selection: Selection | None, config: AnalysisConfig) -> dict[str, list[dict[str, Any]]]:
    """The tables of the versions analysed: versions.tsv always (except for an analysis of the originals with
    nothing derived to choose from), corrections_effect.tsv for ``corrected``, and the adjudication tables for
    ``adjudicated``."""
    if selection is None:
        return {}
    out: dict[str, list[dict[str, Any]]] = {}
    if selection.versions != "original" or config.unit == "task":
        out["versions"] = selection.rows
    if selection.versions == "corrected":
        out["corrections_effect"] = correction_effect(selection.corrected, config)
    if selection.versions == "adjudicated":
        out.update(adjudication_effect(selection.units, config, selection.records))
    return out


TABLE_COLUMNS = {"versions": VERSIONS_COLUMNS, "corrections_effect": CORRECTION_COLUMNS,
                 "adjudication": ADJUDICATION_COLUMNS, "adjudication_pairs": PAIR_COLUMNS,
                 "adjudication_survival": SURVIVAL_COLUMNS}

__all__ = ["ADJUDICATED", "AdjudicatedUnit", "CorrectedPair", "Selection", "StudyRecords", "TABLE_COLUMNS",
           "adjudication_effect", "correction_effect", "crop_to_window", "derived_of", "select_versions",
           "survival_by_annotator", "version_tables", "window_of"]
