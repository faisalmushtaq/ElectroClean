"""Screening-style adjudication of disagreements (docs/web/api.md, "Adjudication and the library").

As in the dual screening of a systematic review (Covidence, Rayyan), two or more people annotate the
same recording independently; once they have all saved, ElectroTag compares their versions with the
agreement analysis's matching rules (:mod:`electrotag.reliability.conflicts`) and lists every
conflict. An expert who did not annotate it then decides each conflict, one at a time, and finishes
with an adjudicated version: a new derived version, saved with the journalled save into
``derived/adjudications/annotator-ADJUDICATED/``, that can become a training reference. The
originals never change.

**What can be adjudicated (units).** A unit is one of:

* ``task``: a task of the study (records of kind ``tasks``: a recording or a window of one, given to k
  annotators). :func:`task_units` is the thin adapter to the task records; nothing else here reads them.
* ``recording``: a study recording that two or more people were given (or saved) without a task, the
  screening-tool case of a study that simply assigned each recording to two people.
* ``corrections``: two or more experts' corrections of the same saved attempt (decision 4): their
  disagreements are conflicts like any others, and the adjudicated result is the corrected version.

Units are found afresh on every call (:func:`units`); what is stored is one adjudication record per unit
(kind ``adjudications``, ``record_id`` the unit's ID, ``annotator_id`` the adjudicator), which freezes the
inputs (each version's attempt and the SHA-256 of its ``_annotations.json``) and the matching rules when
the adjudication starts, and keeps a decision per conflict. Conflicts are always recomputed from the
frozen inputs, so the queue, the library and the decisions never get out of step.

**Not blinded** (the project lead's decision of 29 October): the adjudicator sees who made each mark.
Nobody adjudicates a unit they annotated (409 ``own_task``). Records keep ``"blinded": false``, leaving
room for blinded adjudication in a future crowd study.

Every operation that saves (start, decide, finish, reference) is idempotent and appends to the audit log;
reasons are counted there by their length only.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any

from electrotag.app.common import now_local_iso
from electrotag.web import audit
from electrotag.web.errors import ApiError
from electrotag.web.expert import expert_op, feedback_part
from electrotag.web.manifest import SCOPE_STUDY
from electrotag.web.store import User, attempt_of, item_key, latest_entry

if TYPE_CHECKING:
    from electrotag.app.annotations.model import AnnotationDocument
    from electrotag.reliability.conflicts import Cluster, ConflictRules
    from electrotag.web.service import StudyService

#: The annotator ID of every adjudicated version (a reserved ID, never an account).
ADJUDICATED = "ADJUDICATED"
UNIT_KINDS = ("task", "recording", "corrections")
#: Derived statuses of a unit (never stored).
STATUSES = ("collecting", "ready", "agreed", "adjudicating", "adjudicated")
#: Why the adjudicator decided as they did (one may be chosen with each decision).
REASON_CODES = ("clear_artifact", "not_artifact", "type_evidence", "boundary_evidence", "channels_evidence",
                "both_valid", "other")
REASON_WORDS = {"clear_artifact": "a clear artifact", "not_artifact": "not an artifact",
                "type_evidence": "the type shows in the EEG", "boundary_evidence": "the start and end show in the EEG",
                "channels_evidence": "the channels show in the EEG", "both_valid": "both are valid",
                "other": "another reason"}
MAX_REASON = 200
#: The most units looked at in one call (the library recomputes their conflicts from the files).
MAX_UNITS = 500
#: The longest time an adjudication is recorded as having taken (as for annotation, a week).
MAX_ELAPSED_S = 7 * 24 * 3600.0
UNIT_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
CONFLICT_RE = re.compile(r"^c-[0-9a-f]{16}$")


def _bad(message: str, code: str = "bad_request") -> ApiError:
    return ApiError(400, code, message)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def unit_id_for(kind: str, *parts: str) -> str:
    """The ID of a unit without a task: ``r-`` (a recording) or ``k-`` (corrections of one attempt) and 12
    hexadecimal characters of its recording (and the corrected person and attempt)."""
    prefix = {"recording": "r-", "corrections": "k-"}[kind]
    return prefix + hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:12]


# ------------------------------------------------------------------ units
@dataclass
class Input:
    """One version compared: someone's latest saved attempt, or an expert's correction of an attempt."""

    person: str  # who made the version (the annotator, or the corrector)
    source: str  # "original" | "correction"
    annotator_id: str  # whose work it is (the person, or the person corrected)
    attempt: int  # the attempt saved (or corrected)
    session_id: str = ""
    output_basename: str = ""
    number: int = 0  # a correction's number (its attempt in the derived tree)
    correction_id: str = ""

    def frozen(self, letter: str, sha256: str) -> dict[str, Any]:
        out = {"letter": letter, "source": self.source, "annotator_id": self.annotator_id, "attempt": self.attempt,
               "session_id": self.session_id, "output_basename": self.output_basename,
               "annotations_sha256": sha256}
        if self.source == "correction":
            out.update(number=self.number, correction_id=self.correction_id)
        return out

    @classmethod
    def from_frozen(cls, person: str, d: dict[str, Any]) -> Input:
        return cls(person, str(d.get("source") or "original"), str(d.get("annotator_id") or person),
                   int(d.get("attempt") or 1), str(d.get("session_id") or ""), str(d.get("output_basename") or ""),
                   int(d.get("number") or 0), str(d.get("correction_id") or ""))


@dataclass
class Unit:
    """Something to adjudicate (see the module docstring): who is expected, and who has saved."""

    unit_id: str
    kind: str
    recording_id: str
    expected: list[str]  # the people whose versions are compared, saved or not
    inputs: dict[str, Input]  # person -> their version, for those who have saved
    window: tuple[int, int] | None = None
    letters: dict[str, str] = field(default_factory=dict)  # person -> letter
    corrected: dict[str, Any] | None = None  # corrections: {"annotator_id", "attempt"}
    notes: str = ""

    @property
    def complete(self) -> bool:
        return len(self.inputs) >= 2 and all(p in self.inputs for p in self.expected)

    def involves(self, aid: str) -> bool:
        return aid in self.expected or (self.corrected is not None and self.corrected.get("annotator_id") == aid)


def _letters(people: list[str], given: dict[str, Any] | None = None) -> dict[str, str]:
    from electrotag.reliability.conflicts import LETTERS

    given = {str(k): str(v) for k, v in (given or {}).items()}
    if people and all(p in given for p in people) and len({given[p] for p in people}) == len(people) \
            and all(given[p] in LETTERS for p in people):
        return {p: given[p] for p in people}
    return {p: LETTERS[i] for i, p in enumerate(sorted(people)[:len(LETTERS)])}


def _latest_saved(entries: list[dict[str, Any]], aid: str, rid: str) -> dict[str, Any] | None:
    mine = [e for e in entries if e.get("annotator_id") == aid and e.get("recording_id") == rid
            and e.get("mode", "standard") == "standard" and e.get("status") == "completed"]
    return latest_entry(mine) if mine else None


def _original(aid: str, entry: dict[str, Any]) -> Input:
    return Input(aid, "original", aid, attempt_of(entry), str(entry.get("session_id") or ""),
                 str(entry.get("output_basename") or ""))


def task_units(service: StudyService, entries: list[dict[str, Any]]) -> list[Unit]:
    """The study's tasks as units (the adapter to the task records of docs/web/api.md, "Tasks"): each task's
    annotators, window and letters; known-answer (gold) tasks never come to adjudication."""
    out = []
    for t in service.store.records("tasks"):
        tid, rid = t.get("task_id"), t.get("recording_id")
        if not isinstance(tid, str) or not UNIT_RE.match(tid) or not isinstance(rid, str) or t.get("gold"):
            continue
        people = [str(a) for a in t.get("annotators") or []]
        w = t.get("window") if isinstance(t.get("window"), dict) else None
        window = (int(w["start_sample"]), int(w["end_sample"])) if w and "start_sample" in w and "end_sample" in w \
            else None
        inputs = {}
        for aid in people:
            e = _latest_saved(entries, aid, rid)
            if e is not None:
                inputs[aid] = _original(aid, e)
        out.append(Unit(tid, "task", rid, people, inputs, window, _letters(people, t.get("letters")),
                        notes=str(t.get("notes") or "")))
    return out


def recording_units(service: StudyService, entries: list[dict[str, Any]], skip: set[str]) -> list[Unit]:
    """Study recordings that two or more people were given or saved, without a task: everyone given it (except
    those who reported it cannot be annotated) and everyone who saved it."""
    people: dict[str, set[str]] = {}
    for a in service.store.assignments():
        if a.mode == "standard" and not a.context_id and a.recording_id not in skip:
            people.setdefault(a.recording_id, set()).add(a.annotator_id)
    for e in entries:
        if e.get("mode", "standard") == "standard" and e.get("status") == "completed" \
                and e.get("recording_id") not in skip:
            people.setdefault(str(e.get("recording_id")), set()).add(str(e.get("annotator_id")))
    out = []
    unusable: dict[str, set[str]] = {}
    for rid, who in sorted(people.items()):
        if len(who) < 2:
            continue
        inputs = {}
        for aid in sorted(who):
            e = _latest_saved(entries, aid, rid)
            if e is not None:
                inputs[aid] = _original(aid, e)
        if aid_unusable := [aid for aid in who if aid not in inputs]:
            for aid in aid_unusable:
                keys = unusable.setdefault(aid, set(service.feedback.unusable_keys(aid)))
                if item_key(rid, "standard", "") in keys:
                    who = who - {aid}
        if len(who) < 2:
            continue
        expected = sorted(who)
        out.append(Unit(unit_id_for("recording", rid), "recording", rid, expected, inputs, None, _letters(expected)))
    return out


def correction_units(service: StudyService) -> list[Unit]:
    """Two or more experts' corrections of the same saved attempt (each corrector's latest): decision 4."""
    groups: dict[tuple[str, str, int], dict[str, dict[str, Any]]] = {}
    for c in service.store.records("corrections"):
        if c.get("state") != "saved" or not c.get("corrector_id"):
            continue
        frm = c.get("corrected_from") if isinstance(c.get("corrected_from"), dict) else {}
        key = (str(c.get("annotator_id") or ""), str(c.get("recording_id") or ""),
               int(frm.get("attempt") or c.get("attempt") or 1))
        by = groups.setdefault(key, {})
        who = str(c["corrector_id"])
        if who not in by or int(c.get("number") or 0) > int(by[who].get("number") or 0):
            by[who] = c
    out = []
    for (aid, rid, attempt), by in sorted(groups.items()):
        if len(by) < 2:
            continue
        inputs = {who: Input(who, "correction", aid, attempt, str(c.get("session_id") or ""),
                             str(c.get("output_basename") or ""), int(c.get("number") or 1),
                             str(c.get("correction_id") or "")) for who, c in by.items()}
        people = sorted(by)
        out.append(Unit(unit_id_for("corrections", aid, rid, str(attempt)), "corrections", rid, people, inputs, None,
                        _letters(people), corrected={"annotator_id": aid, "attempt": attempt}))
    return out


def units(service: StudyService) -> list[Unit]:
    """Everything the study could adjudicate now (tasks, recordings without a task, corrections)."""
    entries = [e for e in service.store.completion_entries() if e.get("status") == "completed"]
    tasks = task_units(service, entries)
    tasked = {u.recording_id for u in tasks}
    return (tasks + recording_units(service, entries, tasked) + correction_units(service))[:MAX_UNITS]


# ------------------------------------------------------------------ the versions and their conflicts
@dataclass
class Compared:
    """A unit's versions as compared: letter -> document, the person behind each letter, and the clusters."""

    unit: Unit
    letters: dict[str, str]  # person -> letter
    docs: dict[str, AnnotationDocument]  # letter -> document
    shas: dict[str, str]  # person -> SHA-256 of the _annotations.json compared
    rules: ConflictRules
    clusters: list[Cluster]
    manifest: dict[str, Any]

    @property
    def conflicts(self) -> list[Cluster]:
        return [c for c in self.clusters if c.is_conflict]

    @property
    def person_of(self) -> dict[str, str]:
        return {x: p for p, x in self.letters.items()}


def _files_of(service: StudyService, rid: str, inp: Input) -> dict[str, bytes]:
    if inp.source == "correction":
        return service.store.derived_files("corrections", inp.annotator_id, rid, inp.number or None)
    return service.store.saved_files(inp.annotator_id, rid, "standard", "", inp.attempt)


def _document(service: StudyService, rid: str, inp: Input, want_sha: str | None = None
              ) -> tuple[AnnotationDocument, str, tuple[str, bytes]]:
    from electrotag.app.annotations.model import AnnotationError
    from electrotag.app.io.canonical import document_from_dict

    files = _files_of(service, rid, inp)
    name = next((n for n in sorted(files) if n.endswith("_annotations.json")), None)
    what = f"{inp.person}'s correction" if inp.source == "correction" else f"{inp.person}'s version {inp.attempt}"
    if name is None:
        raise ApiError(409, "inputs_changed", f"{what} of {rid} can no longer be found, so it cannot be compared. "
                       "Tell the study administrator.")
    sha = _sha(files[name])
    if want_sha and sha != want_sha:
        raise ApiError(409, "inputs_changed", f"{what} of {rid} is no longer the file the adjudication started from. "
                       "Tell the study administrator.")
    try:
        return document_from_dict(json.loads(files[name])), sha, (name, files[name])
    except (AnnotationError, ValueError, KeyError) as exc:
        raise ApiError(500, "unreadable", f"{what} of {rid} cannot be read") from exc


def _rules(service: StudyService, frozen: dict[str, Any] | None = None) -> ConflictRules:
    from electrotag.reliability.conflicts import ConflictRules

    return ConflictRules.from_dict(frozen if frozen is not None else service.settings.review.matching)


def compare(service: StudyService, unit: Unit, record: dict[str, Any] | None = None) -> Compared:
    """The unit's versions and clusters: the frozen inputs of its adjudication when it has one, otherwise each
    person's current version."""
    from electrotag.reliability.conflicts import find_clusters

    m = service.store.manifest(SCOPE_STUDY, unit.recording_id)
    if m is None:
        raise ApiError(404, "unknown_recording", f"{unit.recording_id} is no longer one of the study's recordings")
    if record is not None:
        frozen = dict(record.get("inputs") or {})
        inputs = {p: Input.from_frozen(p, d) for p, d in frozen.items()}
        letters = {p: str(d.get("letter")) for p, d in frozen.items()}
        rules = _rules(service, record.get("rules") or {})
        want = {p: str(d.get("annotations_sha256") or "") for p, d in frozen.items()}
        w = record.get("window")
        window = (int(w["start_sample"]), int(w["end_sample"])) if isinstance(w, dict) else None
    else:
        inputs, letters, rules, want, window = dict(unit.inputs), dict(unit.letters), _rules(service), {}, unit.window
        letters = {p: x for p, x in letters.items() if p in inputs}
    docs, shas = {}, {}
    for p, inp in sorted(inputs.items()):
        doc, sha, _ = _document(service, unit.recording_id, inp, want.get(p))
        docs[letters[p]] = doc
        shas[p] = sha
    timing = m["timing"]
    clusters = find_clusters(docs, ch_names=tuple(m["ch_names"]), sfreq=float(timing["sfreq"]), unit_id=unit.unit_id,
                             window=window, rules=rules, who={x: p for p, x in letters.items()})
    return Compared(unit, letters, docs, shas, rules, clusters, m)


def _record(service: StudyService, unit_id: str) -> dict[str, Any] | None:
    """The adjudication record of a unit, or None (read without changing it)."""
    return service.store.update_record("adjudications", unit_id, "", lambda old: None)


def _records(service: StudyService) -> dict[str, dict[str, Any]]:
    return {str(r.get("unit_id") or r.get("task_id")): r for r in service.store.records("adjudications")}


def status_of(unit: Unit, record: dict[str, Any] | None, n_conflicts: int | None) -> str:
    if record is not None:
        return "adjudicated" if record.get("state") == "finished" else "adjudicating"
    if not unit.complete:
        return "collecting"
    return "ready" if n_conflicts else "agreed"


# ------------------------------------------------------------------ answers
def _name(service: StudyService, aid: str) -> str:
    rec = service.store.user_record(aid) or {}
    return str(rec.get("display_name") or "")


def _window_out(window: tuple[int, int] | None, sfreq: float) -> dict[str, Any] | None:
    if window is None:
        return None
    return {"start_sample": window[0], "end_sample": window[1], "start_s": round(window[0] / sfreq, 6),
            "end_s": round(window[1] / sfreq, 6)}


def unit_out(service: StudyService, user: User, unit: Unit, record: dict[str, Any] | None,
             n_conflicts: int | None, n_agreed: int | None = None) -> dict[str, Any]:
    m = service.store.manifest(SCOPE_STUDY, unit.recording_id) or {}
    sfreq = float((m.get("timing") or {}).get("sfreq") or 1.0)
    letters = dict(record.get("letters") or {}) if record else unit.letters
    people = sorted(letters, key=lambda p: letters[p]) if record else sorted(unit.expected,
                                                                            key=lambda p: letters.get(p, "Z"))
    counts = dict(record.get("counts") or {}) if record else {}
    window = unit.window
    if record and isinstance(record.get("window"), dict):
        window = (int(record["window"]["start_sample"]), int(record["window"]["end_sample"]))
    return {
        "unit_id": unit.unit_id, "task_id": unit.unit_id if unit.kind == "task" else None, "kind": unit.kind,
        "recording_id": unit.recording_id, "file_name": m.get("file_name", unit.recording_id.split("/")[-1]),
        "window": _window_out(window, sfreq), "k": len(unit.expected),
        "saved": len(record.get("inputs") or {}) if record else len(unit.inputs),
        "annotators": [{"letter": letters.get(p), "annotator_id": p, "display_name": _name(service, p),
                        "saved": bool(record) or p in unit.inputs} for p in people],
        "corrected": unit.corrected,
        "status": status_of(unit, record, n_conflicts),
        "conflicts": counts.get("conflicts", n_conflicts), "agreed": counts.get("agreed", n_agreed),
        "decided": len(record.get("decisions") or {}) if record else 0,
        "adjudicator_id": record.get("adjudicator_id") if record else None,
        "adjudicator_name": record.get("adjudicator_name") if record else None,
        "started_at": record.get("started_at") if record else None,
        "finished_at": record.get("finished_at") if record else None,
        "yours": bool(record) and record.get("adjudicator_id") == user.annotator_id,
        "own": unit.involves(user.annotator_id),
        "notes": unit.notes,
    }


def mark_out(service: StudyService, mk: Any, sfreq: float) -> dict[str, Any]:
    return {"letter": mk.letter, "annotator_id": mk.annotator_id, "display_name": _name(service, mk.annotator_id),
            "annotation_id": mk.annotation_id, "label": mk.label, "onset_sample": mk.start,
            "duration_samples": mk.stop - mk.start, "onset_s": round(mk.start / sfreq, 6),
            "offset_s": round(mk.stop / sfreq, 6), "channels": list(mk.channels), "confidence": mk.confidence,
            "note": mk.note}


def _ann_out(a: Any, sfreq: float) -> dict[str, Any]:
    from electrotag.web.service import annotation_dict

    return {**annotation_dict(a), "onset_s": round(a.onset_sample / sfreq, 6),
            "offset_s": round(a.end_sample / sfreq, 6)}


def decision_out(c: Cluster, d: dict[str, Any] | None, ch_names: tuple[str, ...],
                 sfreq: float) -> dict[str, Any] | None:
    from electrotag.reliability.conflicts import apply_decision

    if d is None:
        return None
    kept = apply_decision(c, _with_marks(d, ch_names, sfreq), ch_names)
    return {"choice": d.get("choice"), "marks": list(d.get("marks") or []), "reason_code": d.get("reason_code"),
            "reason": d.get("reason") or "", "decided_at": d.get("decided_at"), "decided_by": d.get("decided_by"),
            "result": [_ann_out(a, sfreq) for a in kept]}


def _with_marks(d: dict[str, Any], ch_names: tuple[str, ...], sfreq: float) -> dict[str, Any]:
    """A stored decision with its edited marks as annotations again."""
    from electrotag.app.annotations.model import ArtifactAnnotation

    if d.get("choice") != "edited":
        return d
    marks = [ArtifactAnnotation(annotation_id=str(m["annotation_id"]), label=str(m["label"]),
                                onset_sample=int(m["onset_sample"]), duration_samples=int(m["duration_samples"]),
                                channels=tuple(m.get("channels") or ())) for m in d.get("marks") or []]
    return {**d, "marks": marks}


def conflict_out(service: StudyService, c: Cluster, decision: dict[str, Any] | None, cmp: Compared) -> dict[str, Any]:
    from electrotag.reliability.conflicts import label_pair

    sfreq = float(cmp.manifest["timing"]["sfreq"])
    ch = tuple(cmp.manifest["ch_names"])
    pair = label_pair(c)
    return {"conflict_id": c.cluster_id, "kinds": list(c.kinds), "onset_sample": c.start, "offset_sample": c.stop,
            "onset_s": round(c.start / sfreq, 6), "offset_s": round(c.stop / sfreq, 6),
            "marks": [mark_out(service, mk, sfreq) for mk in c.marks], "missing": list(c.missing),
            "missing_ids": [cmp.person_of.get(x, x) for x in c.missing], "labels": c.labels,
            "pair": list(pair) if pair else None, "decision": decision_out(c, decision, ch, sfreq)}


def record_out(record: dict[str, Any] | None) -> dict[str, Any] | None:
    if record is None:
        return None
    keys = ("unit_id", "task_id", "unit_kind", "recording_id", "file_name", "window", "corrected", "adjudicator_id",
            "adjudicator_name", "state", "started_at", "finished_at", "blinded", "inputs", "letters", "rules",
            "decisions", "version", "counts")
    return {k: record.get(k) for k in keys}


def full_answer(service: StudyService, user: User, unit: Unit, record: dict[str, Any] | None,
                cmp: Compared | None = None) -> dict[str, Any]:
    from electrotag.web.service import annotation_dict

    cmp = cmp or compare(service, unit, record)
    sfreq = float(cmp.manifest["timing"]["sfreq"])
    ch = tuple(cmp.manifest["ch_names"])
    decisions = dict((record or {}).get("decisions") or {})
    from electrotag.reliability.conflicts import agreed_mark

    versions = []
    for p, x in sorted(cmp.letters.items(), key=lambda kv: kv[1]):
        inp = Input.from_frozen(p, (record or {}).get("inputs", {}).get(p, {})) if record else unit.inputs[p]
        versions.append({"letter": x, "annotator_id": p, "display_name": _name(service, p), "source": inp.source,
                         "attempt": inp.attempt, "number": inp.number or None,
                         "annotations": [annotation_dict(a) for a in cmp.docs[x].sorted_annotations()]})
    conflicts = [conflict_out(service, c, decisions.get(c.cluster_id), cmp) for c in cmp.conflicts]
    return {
        "unit": unit_out(service, user, unit, record, len(cmp.conflicts), len(cmp.clusters) - len(cmp.conflicts)),
        "adjudication": record_out(record), "versions": versions, "conflicts": conflicts,
        "agreed": [{"cluster_id": c.cluster_id, "mark": _ann_out(agreed_mark(c, ch), sfreq),
                    "letters": sorted({mk.letter for mk in c.marks})} for c in cmp.clusters if not c.is_conflict],
        "manifest": service.public_manifest(cmp.manifest), "file_name": cmp.manifest.get("file_name", ""),
        "blinded": False, "rules": cmp.rules.to_dict(),
        "progress": {"conflicts": len(conflicts), "decided": sum(1 for c in conflicts if c["decision"] is not None)},
        "reason_required": service.settings.review.reason_required, "reason_codes": list(REASON_CODES),
    }


# ------------------------------------------------------------------ finding a unit
def _unit_id(body: dict[str, Any]) -> str:
    uid = body.get("unit_id", body.get("task_id"))
    if not isinstance(uid, str) or not UNIT_RE.match(uid):
        raise _bad("unit_id (what is adjudicated: a task, a recording or corrections) is missing")
    return uid


def find_unit(service: StudyService, uid: str, record: dict[str, Any] | None = None) -> Unit:
    for u in units(service):
        if u.unit_id == uid:
            return u
    if record is not None:  # started from versions no longer listed (an assignment taken back): kept as it was
        frozen = dict(record.get("inputs") or {})
        w = record.get("window")
        return Unit(uid, str(record.get("unit_kind") or "recording"), str(record.get("recording_id")), sorted(frozen),
                    {p: Input.from_frozen(p, d) for p, d in frozen.items()},
                    (int(w["start_sample"]), int(w["end_sample"])) if isinstance(w, dict) else None,
                    {p: str(d.get("letter")) for p, d in frozen.items()}, record.get("corrected"))
    raise ApiError(404, "not_found", "There is nothing to adjudicate under this name: it may have been removed.")


def _check_not_own(user: User, unit: Unit) -> None:
    if unit.involves(user.annotator_id):
        raise ApiError(409, "own_task", "You annotated this recording (or your work is part of it), so someone else "
                       "adjudicates it.")


# ------------------------------------------------------------------ operations
@expert_op("adjudication_list")
def adjudication_list(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """The queue: every unit with its status, its conflicts and how many are decided."""
    want = body.get("status")
    if want is not None and want not in STATUSES:
        raise _bad(f"status must be one of {', '.join(STATUSES)}")
    rid = body.get("recording_id")
    records = _records(service)
    out, counts = [], dict.fromkeys(STATUSES, 0)
    for u in units(service):
        if rid is not None and u.recording_id != rid:
            continue
        rec = records.get(u.unit_id)
        n = a = None
        if rec is None and u.complete:
            try:
                cmp = compare(service, u)
                n, a = len(cmp.conflicts), len(cmp.clusters) - len(cmp.conflicts)
            except ApiError:
                continue  # a version that cannot be read is left out of the queue (the admin area shows it)
        row = unit_out(service, user, u, rec, n, a)
        counts[row["status"]] += 1
        if want is None or row["status"] == want:
            out.append(row)
    order = {"adjudicating": 0, "ready": 1, "collecting": 2, "agreed": 3, "adjudicated": 4}
    out.sort(key=lambda r: (order[r["status"]], r["recording_id"], r["unit_id"]))
    return {"units": out, "counts": counts, "total": len(out)}


@expert_op("adjudication_get")
def adjudication_get(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """One unit: its versions, conflicts (with any decisions), agreed marks and the recording's manifest."""
    uid = _unit_id(body)
    rec = _record(service, uid)
    unit = find_unit(service, uid, rec)
    _check_not_own(user, unit)
    if rec is None and not unit.complete:
        raise ApiError(409, "not_ready", "Not everyone has saved this recording yet, so there is nothing to compare.")
    return full_answer(service, user, unit, rec)


@expert_op("adjudication_start")
def adjudication_start(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """Start (or continue) adjudicating a unit: its inputs and the matching rules are frozen now."""
    uid = _unit_id(body)
    rec = _record(service, uid)
    unit = find_unit(service, uid, rec)
    _check_not_own(user, unit)
    if rec is not None:
        if rec.get("adjudicator_id") != user.annotator_id:
            raise _taken(rec)
        return {**full_answer(service, user, unit, rec), "already": True}
    if not unit.complete:
        raise ApiError(409, "not_ready", "Not everyone has saved this recording yet. Adjudication starts once they "
                       "all have.")
    cmp = compare(service, unit)
    if not cmp.conflicts:
        raise ApiError(409, "not_ready", "Everyone agrees on this recording: there is nothing to adjudicate.")
    sfreq = float(cmp.manifest["timing"]["sfreq"])
    new = {"schema": "electrotag.adjudication", "schema_version": 1, "unit_id": uid, "task_id": uid,
           "unit_kind": unit.kind, "recording_id": unit.recording_id, "file_name": cmp.manifest.get("file_name", ""),
           "window": _window_out(unit.window, sfreq), "corrected": unit.corrected,
           "adjudicator_id": user.annotator_id, "adjudicator_name": user.display_name, "state": "in_progress",
           "started_at": now_local_iso(), "finished_at": None, "blinded": False,
           "inputs": {p: unit.inputs[p].frozen(x, cmp.shas[p]) for p, x in cmp.letters.items()},
           "letters": dict(cmp.letters), "rules": cmp.rules.to_dict(), "decisions": {}, "version": None,
           "counts": {"conflicts": len(cmp.conflicts), "decided": 0,
                      "agreed": len(cmp.clusters) - len(cmp.conflicts)}}
    made = {"yes": False}

    def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
        made["yes"] = old is None  # set on every try: a transaction may run this more than once
        return new if old is None else None

    kept = service.store.update_record("adjudications", uid, user.annotator_id, change) or new
    if not made["yes"]:
        if kept.get("adjudicator_id") != user.annotator_id:
            raise _taken(kept)
        return {**full_answer(service, user, unit, kept), "already": True}
    people = ", ".join(sorted(cmp.letters))
    audit.record(service.store, user.annotator_id, "adjudication_start",
                 f"Started adjudicating {unit.recording_id} ({people}): {audit.count(len(cmp.conflicts), 'conflict')}",
                 {"unit_id": uid, "unit_kind": unit.kind, "recording_id": unit.recording_id,
                  "inputs": new["inputs"], "rules": new["rules"], "n_conflicts": len(cmp.conflicts)})
    return {**full_answer(service, user, unit, kept, cmp), "already": False}


def _taken(rec: dict[str, Any]) -> ApiError:
    who = rec.get("adjudicator_id")
    name = rec.get("adjudicator_name")
    return ApiError(409, "taken", f"{who}{f' ({name})' if name else ''} "
                    + ("has adjudicated this recording." if rec.get("state") == "finished"
                       else "is adjudicating this recording."), adjudicator_id=who)


def _mine(service: StudyService, user: User, uid: str) -> tuple[dict[str, Any], Unit]:
    rec = _record(service, uid)
    if rec is None:
        raise ApiError(409, "not_started", "This adjudication has not been started. Start it from the queue first.")
    if rec.get("adjudicator_id") != user.annotator_id:
        raise ApiError(409, "not_yours", f"{rec.get('adjudicator_id')} is adjudicating this recording; only they "
                       "decide its conflicts.")
    return rec, find_unit(service, uid, rec)


def _reason(body: dict[str, Any], choice: str, rule: str) -> tuple[str | None, str]:
    code = body.get("reason_code")
    if code is not None and code not in REASON_CODES:
        raise _bad(f"reason_code must be one of {', '.join(REASON_CODES)}")
    text = body.get("reason", "")
    if text is None:
        text = ""
    if not isinstance(text, str):
        raise _bad("reason must be text")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in text):
        raise _bad("The reason must be a single line of text")
    text = text.strip()
    if len(text) > MAX_REASON:
        raise _bad(f"The reason has at most {MAX_REASON} characters (this one has {len(text)})")
    needed = rule == "always" or (rule == "edited_or_none" and choice in ("edited", "none"))
    if needed and not code and not text:
        raise ApiError(422, "reason_missing", "Give a reason for this decision: choose one, or write a few words.")
    if code == "other" and not text:
        raise ApiError(422, "reason_missing", "You chose another reason: write it in a few words.")
    return code, text


def _edited_marks(service: StudyService, raw: Any, cmp: Compared) -> list[dict[str, Any]]:
    from electrotag.reliability.conflicts import MAX_EDITED_MARKS
    from electrotag.web.manifest import manifest_info
    from electrotag.web.service import annotation_dict, parse_annotations

    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_EDITED_MARKS:
        raise ApiError(422, "invalid_annotation", f"An edited decision holds 1 to {MAX_EDITED_MARKS} marks")
    info = manifest_info(cmp.manifest)
    items = [{**a, "annotation_id": f"e{i}"} if isinstance(a, dict) else a for i, a in enumerate(raw, start=1)]
    marks = parse_annotations(items, info, service.store.catalogue, service.settings.min_duration_samples)
    rec_w = cmp.unit.window
    for a in marks:
        if rec_w is not None and (a.onset_sample < rec_w[0] or a.end_sample > rec_w[1]):
            raise ApiError(422, "outside_window", f"The {a.label} mark lies outside the window being adjudicated")
    return [{k: v for k, v in annotation_dict(a).items() if k in ("annotation_id", "label", "onset_sample",
                                                               "duration_samples", "channels")} for a in marks]


@expert_op("adjudication_decide")
def adjudication_decide(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """Decide one conflict: a letter (that person's marks), ``all``, ``none`` or ``edited`` (with ``marks``), with a
    reason as the study's ``review.reason_required`` asks. The same decision again changes nothing."""
    uid = _unit_id(body)
    rec, unit = _mine(service, user, uid)
    if rec.get("state") == "finished":
        raise ApiError(409, "finished", "This adjudication is finished; its decisions are kept as they are.")
    cid = body.get("conflict_id")
    if not isinstance(cid, str) or not CONFLICT_RE.match(cid):
        raise _bad("conflict_id is missing")
    cmp = compare(service, unit, rec)
    cluster = next((c for c in cmp.conflicts if c.cluster_id == cid), None)
    if cluster is None:
        raise ApiError(422, "unknown_conflict", "This conflict is not part of the adjudication.")
    choice = body.get("choice")
    letters = set(cmp.letters.values())
    if not isinstance(choice, str) or not (choice in letters or choice in ("all", "none", "edited")):
        raise ApiError(422, "invalid_choice", f"choice must be one of {', '.join(sorted(letters))}, all, none or "
                       "edited")
    code, text = _reason(body, choice, service.settings.review.reason_required)
    marks = _edited_marks(service, body.get("marks"), cmp) if choice == "edited" else []
    decision = {"choice": choice, "marks": marks, "reason_code": code, "reason": text,
                "decided_at": now_local_iso(), "decided_by": user.annotator_id}
    same = {"yes": False}

    def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
        same["yes"] = False  # set on every try: a transaction may run this more than once
        if old is None or old.get("state") == "finished" or old.get("adjudicator_id") != user.annotator_id:
            return None
        before = dict(old.get("decisions") or {}).get(cid)
        if before is not None and all(before.get(k) == decision[k] for k in ("choice", "marks", "reason_code",
                                                                              "reason")):
            same["yes"] = True
            return None
        decisions = {**dict(old.get("decisions") or {}), cid: decision}
        return {**old, "decisions": decisions, "counts": {**dict(old.get("counts") or {}), "decided": len(decisions)}}

    kept = service.store.update_record("adjudications", uid, user.annotator_id, change) or rec
    if kept.get("state") == "finished":
        raise ApiError(409, "finished", "This adjudication is finished; its decisions are kept as they are.")
    if not same["yes"]:
        audit.record(service.store, user.annotator_id, "adjudication_decide",
                     f"Decided a {'/'.join(cluster.kinds)} conflict of {unit.recording_id}: {choice}",
                     {"unit_id": uid, "conflict_id": cid, "kinds": list(cluster.kinds), "choice": choice,
                      "reason_code": code, "reason_length": len(text), "n_marks": len(marks)})
    decisions = dict(kept.get("decisions") or {})
    return {"conflict": conflict_out(service, cluster, decisions.get(cid), cmp),
            "progress": {"conflicts": len(cmp.conflicts), "decided": sum(1 for c in cmp.conflicts
                                                                         if c.cluster_id in decisions)},
            "already": same["yes"]}


def _elapsed(started: Any) -> float:
    try:
        t0 = datetime.fromisoformat(str(started))
        return max(0.0, min(MAX_ELAPSED_S, (datetime.now(t0.tzinfo) - t0).total_seconds()))
    except (TypeError, ValueError):
        return 0.0


def _version_of(entry: dict[str, Any], n: int) -> dict[str, Any]:
    return {"attempt": attempt_of(entry), "output_basename": entry.get("output_basename", ""),
            "session_id": entry.get("session_id", ""), "n_annotations": n}


@expert_op("adjudication_finish")
def adjudication_finish(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """Save the adjudicated version (agreed marks and decided ones) with the journalled save, once."""
    from electrotag.reliability.conflicts import adjudicated_annotations
    from electrotag.web.manifest import ManifestRecording
    from electrotag.web.saving import WebSession

    uid = _unit_id(body)
    rec, unit = _mine(service, user, uid)
    if rec.get("state") == "finished":
        return {"adjudication": record_out(rec), "version": rec.get("version"), "already": True}
    cmp = compare(service, unit, rec)
    decisions = dict(rec.get("decisions") or {})
    undecided = [c.cluster_id for c in cmp.conflicts if c.cluster_id not in decisions]
    if undecided:
        raise ApiError(409, "undecided", f"{audit.count(len(undecided), 'conflict is', 'conflicts are')} not "
                       "decided yet. Decide every conflict before finishing.", n=len(undecided))
    ch = tuple(cmp.manifest["ch_names"])
    sfreq = float(cmp.manifest["timing"]["sfreq"])
    anns = adjudicated_annotations(cmp.clusters, {k: _with_marks(v, ch, sfreq) for k, v in decisions.items()}, ch)
    decisions_sha = _sha(json.dumps(decisions, sort_keys=True).encode("utf-8"))
    sid = str((rec.get("finishing") or {}).get("session_id") or "")
    done = [e for e in service.store.derived_entries("adjudications", ADJUDICATED)
            if sid and e.get("session_id") == sid and e.get("status") == "completed"]
    if not done:
        if not sid:
            sid = uuid.uuid4().hex

            def mark(old: dict[str, Any] | None) -> dict[str, Any] | None:
                if old is None or old.get("finishing"):
                    return None
                return {**old, "finishing": {"session_id": sid, "at": now_local_iso()}}

            got = service.store.update_record("adjudications", uid, user.annotator_id, mark) or rec
            sid = str((got.get("finishing") or {}).get("session_id") or sid)
        derived = {"kind": "adjudication", "task_id": uid, "unit_kind": unit.kind,
                   "adjudicator_id": user.annotator_id, "adjudicator_name": user.display_name,
                   "inputs": rec.get("inputs"), "rules": rec.get("rules"), "window": rec.get("window"),
                   "corrected": rec.get("corrected"), "n_conflicts": len(cmp.conflicts),
                   "decisions_sha256": decisions_sha, "blinded": False}
        loaded = ManifestRecording(cmp.manifest)
        loaded.notes.append("An adjudicated version: the agreed marks of the versions compared and the adjudicator's "
                            "decision on each conflict; the versions compared are unchanged.")

        def make_session(layout: Any) -> WebSession:
            return WebSession(layout=layout, settings=service.settings, filters=service.settings.filters,
                              catalogue=service.store.catalogue, loaded=loaded, annotator_id=ADJUDICATED,
                              display_name=f"Adjudicated ({user.annotator_id})", mode="standard",
                              context={"derived": derived}, initial_annotations=anns, allow_repeat=True,
                              autosave_enabled=False, client={}, server=service.store.kind, session_id=sid)

        saved = service.store.save_derived("adjudications", make_session, elapsed_s=_elapsed(rec.get("started_at")),
                                           started_at=str(rec.get("started_at") or ""))
        entry = {"output_basename": "", "session_id": sid}
        found = [e for e in service.store.derived_entries("adjudications", ADJUDICATED) if e.get("session_id") == sid]
        entry = found[-1] if found else {**entry, "output_basename": f"attempt-{saved.attempt:02d}"}
        version = {**_version_of(entry, len(anns)), "attempt": saved.attempt, "files": sorted(saved.files)}
    else:
        version = {**_version_of(done[-1], len(anns)), "files": []}
    now = now_local_iso()

    def finish(old: dict[str, Any] | None) -> dict[str, Any] | None:
        if old is None or old.get("state") == "finished":
            return None
        return {**old, "state": "finished", "finished_at": now, "version": version,
                "decisions_sha256": decisions_sha}

    kept = service.store.update_record("adjudications", uid, user.annotator_id, finish) or rec
    by: dict[str, int] = {}
    for d in decisions.values():
        key = "one" if d.get("choice") in cmp.letters.values() else str(d.get("choice"))
        by[key] = by.get(key, 0) + 1
    audit.record(service.store, user.annotator_id, "adjudication_finish",
                 f"Finished adjudicating {unit.recording_id}: {audit.count(len(cmp.conflicts), 'conflict')} decided, "
                 f"adjudicated version {version['attempt']} with {audit.count(len(anns), 'annotation')}",
                 {"unit_id": uid, "recording_id": unit.recording_id, "version": version, "by_choice": by,
                  "decisions_sha256": decisions_sha})
    return {"adjudication": record_out(kept), "version": kept.get("version") or version, "already": False}


@expert_op("adjudication_reference")
def adjudication_reference(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """A finished adjudication as a training reference (the admin operation set_add_reference, Source adjudication)."""
    uid = _unit_id(body)
    rec = _record(service, uid)
    if rec is None or rec.get("state") != "finished":
        raise ApiError(409, "not_finished", "Only a finished adjudication can become a training reference.")
    return service.administration.op_set_add_reference(user, {
        "set_id": body.get("set_id"), "recording_id": rec.get("recording_id"), "use": body.get("use"),
        "recording_scope": SCOPE_STUDY, "source": {"kind": "adjudication", "task_id": uid},
        "provenance": body.get("provenance") or {}})


def reference_source(service: StudyService, source: dict[str, Any], rid: str,
                     keep: Callable[[str, bytes], Any]) -> dict[str, Any]:
    """The Source ``{"kind": "adjudication", "task_id"}`` of ``set_add_reference`` (admin.py): the adjudicated
    version, with the versions compared kept as its source files."""
    from electrotag.app.annotations.model import AnnotationError
    from electrotag.app.io.canonical import document_from_dict

    uid = source.get("task_id", source.get("unit_id"))
    if not isinstance(uid, str) or not UNIT_RE.match(uid):
        raise _bad("source.task_id (the adjudication) is missing")
    rec = _record(service, uid)
    if rec is None or rec.get("state") != "finished" or not rec.get("version"):
        raise ApiError(409, "not_finished", "Only a finished adjudication can become a training reference.")
    if rec.get("recording_id") != rid:
        raise ApiError(422, "invalid_document", f"The adjudication is of {rec.get('recording_id')}, not of {rid}")
    if rec.get("window"):
        raise ApiError(422, "window_task", "This adjudication covers a window of the recording; a training "
                       "reference must cover the whole recording.")
    files = service.store.derived_files("adjudications", ADJUDICATED, rid, int(rec["version"]["attempt"]))
    name = next((n for n in sorted(files) if n.endswith("_annotations.json")), None)
    if name is None:
        raise ApiError(500, "reference_unavailable", "The adjudicated version cannot be found")
    try:
        doc = document_from_dict(json.loads(files[name]))
    except (AnnotationError, ValueError, KeyError) as exc:
        raise ApiError(500, "reference_unavailable", "The adjudicated version cannot be read") from exc
    kept = [keep(name, files[name])]
    for p, d in sorted((rec.get("inputs") or {}).items()):
        _, _, (iname, data) = _document(service, rid, Input.from_frozen(p, d), str(d.get("annotations_sha256") or ""))
        kept.append(keep(f"{p}_{iname}" if d.get("source") == "correction" else iname, data))
    return {"doc": doc, "method": "adjudicated", "experts": sorted(rec.get("inputs") or {}),
            "adjudicator": str(rec.get("adjudicator_id") or ""), "files": kept,
            "details": {"adjudication": {"task_id": uid, "unit_kind": rec.get("unit_kind"),
                                         "decisions_sha256": rec.get("decisions_sha256"),
                                         "n_conflicts": (rec.get("counts") or {}).get("conflicts")}}}


# ------------------------------------------------------------------ what annotators see
OUTCOMES = ("yours_kept", "other_kept", "all_kept", "none_kept", "edited")


@feedback_part("adjudications")
def mine(service: StudyService, user: User) -> list[dict[str, Any]]:
    """The outcome of each conflict in the annotator's own work, once its adjudication is finished: their marks,
    the others' marks (nobody named), the decision and its reason."""
    aid = user.annotator_id
    out = []
    for rec in service.store.records("adjudications"):
        if rec.get("state") != "finished" or aid not in (rec.get("inputs") or {}):
            continue
        uid = str(rec.get("unit_id") or rec.get("task_id"))
        try:
            unit = find_unit(service, uid, rec)
            cmp = compare(service, unit, rec)
        except ApiError:
            continue
        mine_letter = cmp.letters[aid]
        sfreq = float(cmp.manifest["timing"]["sfreq"])
        ch = tuple(cmp.manifest["ch_names"])
        decisions = dict(rec.get("decisions") or {})
        rows = []
        for c in cmp.conflicts:
            d = decisions.get(c.cluster_id) or {}
            choice = d.get("choice")
            outcome = ("yours_kept" if choice == mine_letter else "all_kept" if choice == "all" else
                       "none_kept" if choice == "none" else "edited" if choice == "edited" else "other_kept")
            kept = decision_out(c, d, ch, sfreq) if d else None
            rows.append({
                "conflict_id": c.cluster_id, "kinds": list(c.kinds), "onset_s": round(c.start / sfreq, 6),
                "offset_s": round(c.stop / sfreq, 6),
                "yours": [{k: v for k, v in mark_out(service, mk, sfreq).items()
                           if k not in ("annotator_id", "display_name", "letter")} for mk in c.marks_of(mine_letter)],
                "others": [{"label": mk.label, "onset_s": round(mk.start / sfreq, 6),
                            "offset_s": round(mk.stop / sfreq, 6), "channels": list(mk.channels)}
                           for mk in c.marks if mk.letter != mine_letter],
                "decision": {"outcome": outcome, "marks": (kept or {}).get("result", []),
                             "reason": d.get("reason") or "", "reason_code": d.get("reason_code"),
                             "reason_text": REASON_WORDS.get(str(d.get("reason_code")), "")}})
        out.append({"task_id": uid, "unit_kind": rec.get("unit_kind"), "recording_id": rec.get("recording_id"),
                    "file_name": rec.get("file_name"), "finished_at": rec.get("finished_at"),
                    "window": rec.get("window"), "conflicts": rows})
    out.sort(key=lambda r: str(r.get("finished_at") or ""), reverse=True)
    return out


# ------------------------------------------------------------------ the results folder
DECISION_COLUMNS = ("unit_id", "unit_kind", "recording_id", "adjudicator_id", "state", "conflict_id", "kinds",
                    "onset_s", "offset_s", "labels", "letters", "people", "choice", "kept_people", "reason_code",
                    "reason", "decided_at", "seconds_since_previous")


def adjudication_files(store: Any) -> dict[str, bytes]:
    """The adjudications as files of the results folder: ``adjudications/<unit>.json`` (each record),
    ``adjudications/decisions.tsv`` (one row per conflict) and ``library/library.tsv`` (docs/file_formats.md)."""
    from electrotag.web.feedback import _tsv
    from electrotag.web.library import LIBRARY_COLUMNS, entries, library_rows
    from electrotag.web.service import StudyService

    out: dict[str, bytes] = {}
    records = store.records("adjudications")
    if not records:
        return out
    service = StudyService(store)
    rows = []
    for rec in sorted(records, key=lambda r: str(r.get("started_at") or "")):
        uid = str(rec.get("unit_id") or rec.get("task_id"))
        out[f"adjudications/{uid}.json"] = json.dumps(rec, indent=1, ensure_ascii=False).encode("utf-8")
        try:
            cmp = compare(service, find_unit(service, uid, rec), rec)
        except ApiError:
            continue
        person = cmp.person_of
        decisions = dict(rec.get("decisions") or {})
        sfreq = float(cmp.manifest["timing"]["sfreq"])
        previous = rec.get("started_at")
        for c in sorted(cmp.conflicts, key=lambda c: str((decisions.get(c.cluster_id) or {}).get("decided_at") or "~")):
            d = decisions.get(c.cluster_id) or {}
            choice = d.get("choice")
            kept = [person.get(str(choice), "")] if choice in person else (sorted(person.values()) if choice == "all"
                                                                           else [])
            gap = None
            if d.get("decided_at") and previous:
                try:
                    gap = round((datetime.fromisoformat(str(d["decided_at"]))
                                 - datetime.fromisoformat(str(previous))).total_seconds(), 3)
                except ValueError:
                    gap = None
                previous = d["decided_at"]
            rows.append({"unit_id": uid, "unit_kind": rec.get("unit_kind"), "recording_id": rec.get("recording_id"),
                         "adjudicator_id": rec.get("adjudicator_id"), "state": rec.get("state"),
                         "conflict_id": c.cluster_id, "kinds": list(c.kinds), "onset_s": round(c.start / sfreq, 6),
                         "offset_s": round(c.stop / sfreq, 6), "labels": c.labels,
                         "letters": sorted({mk.letter for mk in c.marks}),
                         "people": sorted({mk.annotator_id for mk in c.marks}), "choice": choice,
                         "kept_people": kept, "reason_code": d.get("reason_code"), "reason": d.get("reason"),
                         "decided_at": d.get("decided_at"), "seconds_since_previous": gap})
    out["adjudications/decisions.tsv"] = _tsv(DECISION_COLUMNS, rows)
    out["library/library.tsv"] = _tsv(LIBRARY_COLUMNS, library_rows(entries(service, User("ADMIN", role="admin"))))
    return out


__all__ = ["ADJUDICATED", "OUTCOMES", "REASON_CODES", "STATUSES", "UNIT_KINDS", "Compared", "Input", "Unit",
           "adjudication_files", "compare", "correction_units", "find_unit", "mine", "recording_units",
           "reference_source", "task_units", "unit_id_for", "units"]
