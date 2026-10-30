"""Tasks: recordings, or stretches of them, shared out among k annotators (docs/web/api.md, "Tasks, windows and
known answers").

A **task** is one record (kind ``tasks`` of :meth:`~electrotag.web.store.Store.update_record`, with
``annotator_id`` ""): a recording of the study, or a time window of one, the k annotators who annotate it
independently, an optional known-answer (gold) reference, and a stable letter for each annotator. It is
linked to the ordinary assignments it makes through :attr:`~electrotag.web.store.Assignment.task_id`, so
an annotator meets a task as one more recording in their list; an assignment made without a task behaves
exactly as before. The shape of the record (:data:`TASK_SCHEMA`)::

    {"schema": "electrotag.task", "schema_version": 1, "task_id": "t-<12 hex>",
     "recording_id", "file_name", "scope": "study",
     "window": null | {"start_sample", "end_sample"},          # half-open, whole samples
     "k": 2, "annotators": ["A01", "A02"], "letters": {"A01": "A", "A02": "B"},
     "gold": null | {"set_id"}, "blinded": false,
     "state": "open" | "closed" | "removed", "adopted": ["A01"],   # whose assignment was there before
     "created_at", "created_by", "request_id", "batch": "", "notes": "", "changes": [...]}

**Statuses** are derived, never stored (:meth:`Tasks.status`): ``collecting`` (fewer than k saved),
``saved`` (all saved, the conflicts not counted: no counter registered), ``ready`` (all saved, with
conflicts), ``agreed`` (all saved, none), ``adjudicating``, ``adjudicated`` and ``gold``. The adjudication
part of the expert work registers the function that counts a task's conflicts with
:func:`register_conflict_counter`.

**Sharing out** is deterministic (:func:`choose_group`): each task goes to k members of the chosen pool with
the fewest open tasks, so that each person's share is even; among people as free as each other, to those
whose pairs have shared the fewest tasks, so that every pair of annotators shares about as many recordings
(pairwise agreement needs that); the last ties are broken by an order fixed by the recording, the window and
the annotator (a SHA-256). People who already hold the recording without a task come first (their
assignment is linked to the task). The preview gives the pairs' spread (:func:`pair_spread`) and warns about
chosen people whose study work is locked by the training gate, or who have no annotator role. Nobody holds
two tasks of one recording, because an assignment is one per person, recording, mode and context.
``tasks_preview_get`` gives the share-out without making anything; ``tasks_create`` makes it, once per
``request_id``.

**Windows** are enforced by the service: ``submit`` and ``put_draft`` refuse an annotation outside the
window (422 ``outside_window``), and the browser hatches the rest of the recording and keeps the view and
the marks inside it.

**Gold** tasks go to every member of the pool, and nothing in what an annotator receives marks them. After a
save, :meth:`Tasks.after_save` scores the annotations against the reference set's reference
(:func:`electrotag.training.assessment.practice_feedback`) and keeps a ``gold`` record
(``{aid}_{task_id}``); ``quality_list`` gives each annotator's accuracy on them. Gold tasks never enter the
adjudication queue.

Importing this module is light (no numpy or pandas): the scoring imports what it needs.
"""

from __future__ import annotations

import hashlib
import hmac
import itertools
import math
import re
import string
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from electrotag.app.common import now_local_iso
from electrotag.web import audit
from electrotag.web.errors import ApiError
from electrotag.web.manifest import SCOPE_STUDY, fingerprint_of, set_scope
from electrotag.web.store import User, attempt_of, item_key, latest_entry

if TYPE_CHECKING:
    from electrotag.web.service import StudyService, WorkItem

TASK_SCHEMA = "electrotag.task"
GOLD_SCHEMA = "electrotag.gold_score"
#: How many annotators a task may have (a gold task goes to the whole pool, up to MAX_POOL).
K_MIN, K_MAX = 2, 6
MAX_POOL = 1000
#: The most tasks one request makes, and the shortest window.
MAX_TASKS = 5000
MIN_WINDOW_S = 2.0
STATUSES = ("collecting", "saved", "ready", "agreed", "adjudicating", "adjudicated", "gold")
STATES = ("open", "closed")
TASK_ID_RE = re.compile(r"^t-[0-9a-f]{12}$")
REQUEST_RE = re.compile(r"^[0-9a-f]{32}$")
LETTERS = string.ascii_uppercase
#: Why a recording (or a window of it) got no task, in the answer's ``skipped``.
SKIP_REASONS = {
    "retired": "the recording is retired",
    "has_task": "the recording already has an open task",
    "too_few_annotators": "too few of the chosen annotators are free for it",
    "window_outside": "the window lies beyond the end of the recording",
    "window_too_short": "the part of the recording in the window is too short",
    "no_gold_reference": "the known-answer set has no reference for it",
    "gold_mismatch": "the known-answer set's copy of the recording is a different file",
    "fewer_than_two": "fewer than two of the chosen annotators have it",
    "too_many_annotators": f"more than {K_MAX} people have it",
}

#: Counts the conflicts of a task whose annotators have all saved (None when they cannot be counted):
#: registered by the adjudication part (docs/web/api.md, "Adjudication and the library").
ConflictCounter = Callable[["StudyService", dict[str, Any]], "int | None"]
_counter: list[ConflictCounter] = []


def register_conflict_counter(fn: ConflictCounter) -> ConflictCounter:
    """Let the derived statuses tell ``ready`` (conflicts) from ``agreed`` (none) with ``fn``."""
    _counter[:] = [fn]
    return fn


def conflict_counter() -> ConflictCounter | None:
    """The registered counter, loading the expert work's modules once so that it can register itself."""
    if not _counter:
        try:
            from electrotag.web.expert import load_operations

            load_operations()
        except ImportError:  # pragma: no cover - the expert work is part of the package
            return None
    return _counter[0] if _counter else None


# ------------------------------------------------------------------ small pieces
def _bad(message: str, code: str = "bad_request") -> ApiError:
    return ApiError(400, code, message)


def clock(seconds: float) -> str:
    """A time in the recording as people read it: 0:05, 1:30, 1:02:05, with tenths when they matter (0:12.5);
    the same as the browser's (js/viewer/bounds.js clockText)."""
    tenths = math.floor(max(0.0, float(seconds)) * 10 + 0.5)
    whole, tenth = divmod(tenths, 10)
    hh, rest = divmod(int(whole), 3600)
    mm, ss = divmod(rest, 60)
    sec = f"{ss:02d}" if not tenth else f"{ss:02d}.{tenth}"
    return f"{hh}:{mm:02d}:{sec}" if hh else f"{mm}:{sec}"


def window_out(window: dict[str, Any] | None, sfreq: float) -> dict[str, Any] | None:
    """A task's window as answered: the samples and the seconds."""
    if not window:
        return None
    a, b = int(window["start_sample"]), int(window["end_sample"])
    return {"start_sample": a, "end_sample": b, "start_s": a / sfreq, "end_s": b / sfreq}


def window_text(window: dict[str, Any], sfreq: float) -> str:
    """``1:00 to 2:00`` for a window in samples."""
    return f"{clock(int(window['start_sample']) / sfreq)} to {clock(int(window['end_sample']) / sfreq)}"


def task_id_for(request_id: str, recording_id: str, start_sample: int | None) -> str:
    """The task's ID: the same for the same request, recording and window (a request sent twice makes no more)."""
    digest = hashlib.sha256(f"{request_id}|{recording_id}|{start_sample}".encode()).hexdigest()
    return f"t-{digest[:12]}"


def tie_break(recording_id: str, start_sample: int | None, annotator_id: str) -> str:
    """The fixed order among annotators with as many open tasks: the same answer for the same choice."""
    return hashlib.sha256(f"{recording_id}|{start_sample}|{annotator_id}".encode()).hexdigest()


Pair = tuple[str, str]
#: Above this many groups to weigh, a task's people are chosen one by one (a large pool: k=2 from 55 people
#: equally free, k=3 from 22 are still weighed whole).
GROUP_BUDGET = 1500


def pair_of(a: str, b: str) -> Pair:
    return (a, b) if a < b else (b, a)


def choose_group(recording_id: str, start_sample: int | None, free: list[str], k: int, load: dict[str, int],
                 pairs: dict[Pair, int], first: set[str] | frozenset[str] = frozenset()) -> list[str]:
    """The k people of one task, from ``free``: people in ``first`` (who hold the recording already) before
    the rest, then those with the fewest open tasks, so that each person's share stays even; among people
    as free as each other, the group whose pairs have shared the fewest tasks so far (``pairs``), so that
    every pair of annotators shares about as many recordings, which pairwise agreement needs. Looking one
    step ahead, a group that leaves the others a pair that has shared few tasks is preferred, and the last
    ties are broken by :func:`tie_break`. The same choice gives the same answer."""
    tie = {a: tie_break(recording_id, start_sample, a) for a in free}
    rank = {a: (a not in first, load.get(a, 0)) for a in free}
    order = sorted(free, key=lambda a: (rank[a], tie[a]))
    level = rank[order[k - 1]]
    must = [a for a in order if rank[a] < level]
    cand = [a for a in order if rank[a] == level]
    need = k - len(must)

    def shared(a: str, b: str) -> int:
        return pairs.get(pair_of(a, b), 0)

    if math.comb(len(cand), need) <= GROUP_BUDGET:
        # the pairs of the candidates, fewest shared first: the first one outside a group is what it leaves
        cand_pairs = sorted((shared(a, b), a, b) for a, b in itertools.combinations(cand, 2))
        best: tuple[Any, list[str]] | None = None
        for combo in itertools.combinations(cand, need):
            group = must + list(combo)
            counts = [shared(a, b) for a, b in itertools.combinations(group, 2)]
            ahead = next((n for n, a, b in cand_pairs if a not in combo and b not in combo), 0)
            key = (sum(counts), ahead, max(counts, default=0), sorted(tie[a] for a in group))
            if best is None or key < best[0]:
                best = (key, group)
        assert best is not None
        return best[1]
    group = list(must)
    left = list(cand)
    for _ in range(need):  # a large pool: one by one, each the person who has shared least with those chosen
        best_n, pick = -1, left[0]
        for a in left:  # in the order of tie_break, so the first one who has shared nothing will do
            n = sum(shared(a, b) for b in group)
            if best_n < 0 or n < best_n:
                best_n, pick = n, a
                if n == 0:
                    break
        group.append(pick)
        left.remove(pick)
    return group


def pair_spread(pool: list[str], tasks: list[list[str]]) -> dict[str, Any] | None:
    """How many of ``tasks`` each pair of the pool shares: ``{"n_pairs", "least", "most", "counts": {shared:
    pairs}}`` (pairs that share none counted too), or None with fewer than two people."""
    if len(pool) < 2:
        return None
    members = set(pool)
    shared: dict[Pair, int] = {}
    for people in tasks:
        inside = sorted(a for a in set(people) if a in members)
        for a, b in itertools.combinations(inside, 2):
            shared[(a, b)] = shared.get((a, b), 0) + 1
    n_pairs = math.comb(len(members), 2)
    counts: dict[int, int] = {}
    for n in shared.values():
        counts[n] = counts.get(n, 0) + 1
    if n_pairs > len(shared):
        counts[0] = n_pairs - len(shared)
    return {"n_pairs": n_pairs, "least": min(counts), "most": max(counts),
            "counts": {str(n): counts[n] for n in sorted(counts)}}


def letters_for(secret: str, task_id: str, annotators: list[str]) -> dict[str, str]:
    """A letter for each annotator (A, B, ...), in an order fixed by the study's secret and the task: stable,
    and unrelated to the order the people were chosen in."""
    key = secret.encode()
    order = sorted(annotators, key=lambda aid: hmac.new(key, f"{task_id}|{aid}".encode(), "sha256").hexdigest())
    return {aid: LETTERS[i] for i, aid in enumerate(order)}


def next_letter(letters: dict[str, str]) -> str:
    """The first letter not given yet in a task (a person taken out keeps theirs, so letters stay stable)."""
    used = set(letters.values())
    for c in LETTERS:
        if c not in used:
            return c
    return f"X{len(used) + 1}"


def windows_of(n_samples: int, sfreq: float, spec: dict[str, Any] | None) -> list[tuple[int, int] | None]:
    """The windows of one recording: [None] for the whole recording; [(start, end)] for one window given in
    seconds; or consecutive windows of a length with an overlap, the last ending at the end of the recording
    (a remainder shorter than half a window joins the window before)."""
    if not spec:
        return [None]
    if spec.get("kind") == "one":
        a = int(round(spec["start_s"] * sfreq))
        b = min(int(round(spec["end_s"] * sfreq)), n_samples)
        return [(a, b)]
    length = int(round(spec["length_s"] * sfreq))
    step = max(1, length - int(round(spec["overlap_s"] * sfreq)))
    if length >= n_samples:
        return [None]
    out: list[tuple[int, int] | None] = []
    start = 0
    while start + length < n_samples:
        out.append((start, start + length))
        start += step
    # what remains: a window of its own, or (shorter than half a window) the end of the window before
    if out and n_samples - out[-1][1] < length / 2:
        out[-1] = (out[-1][0], n_samples)
    else:
        out.append((start, n_samples))
    return out


def window_spec(body: dict[str, Any]) -> dict[str, Any] | None:
    """The request's ``window`` ({start_s, end_s}) or ``windows`` ({length_s, overlap_s}), checked."""
    one, many = body.get("window"), body.get("windows")
    if one is not None and many is not None:
        raise _bad("Give either window (one stretch) or windows (consecutive parts), not both")

    def num(d: dict[str, Any], key: str, minimum: float, maximum: float = 7 * 24 * 3600.0) -> float:
        v = d.get(key)
        if (isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
                or not minimum <= v <= maximum):
            raise _bad(f"{key} must be a number of seconds from {minimum:g}")
        return float(v)

    if one is not None:
        if not isinstance(one, dict):
            raise _bad("window must be {start_s, end_s}")
        a, b = num(one, "start_s", 0.0), num(one, "end_s", 0.0)
        if b - a < MIN_WINDOW_S:
            raise _bad(f"A window must last at least {MIN_WINDOW_S:g} seconds (end_s after start_s)")
        return {"kind": "one", "start_s": a, "end_s": b}
    if many is not None:
        if not isinstance(many, dict):
            raise _bad("windows must be {length_s, overlap_s}")
        length = num(many, "length_s", MIN_WINDOW_S)
        overlap = num(many, "overlap_s", 0.0) if many.get("overlap_s") is not None else 0.0
        if overlap >= length / 2:
            raise _bad("overlap_s must be less than half of length_s")
        return {"kind": "many", "length_s": length, "overlap_s": overlap}
    return None


def outside_window(annotations: list[Any], window: dict[str, Any]) -> list[tuple[int, Any]]:
    """The annotations (ArtifactAnnotation or the browser's dicts) not wholly inside a window, with their place."""
    a, b = int(window["start_sample"]), int(window["end_sample"])
    out = []
    for i, x in enumerate(annotations, start=1):
        onset = x.get("onset_sample") if isinstance(x, dict) else x.onset_sample
        dur = x.get("duration_samples") if isinstance(x, dict) else x.duration_samples
        if isinstance(onset, bool) or isinstance(dur, bool) or not isinstance(onset, (int, float)) \
                or not isinstance(dur, (int, float)):
            continue  # not a time at all: refused by the checks of the annotations themselves
        if onset < a or onset + dur > b:
            out.append((i, x))
    return out


def check_window(annotations: list[Any], window: dict[str, Any] | None, sfreq: float) -> None:
    """422 ``outside_window`` naming the first annotation that lies outside the task's window."""
    if not window:
        return
    bad = outside_window(annotations, window)
    if not bad:
        return
    i, x = bad[0]
    label = x.get("label") if isinstance(x, dict) else x.label
    onset = (x.get("onset_sample") if isinstance(x, dict) else x.onset_sample) / sfreq
    ids = [str(y.get("annotation_id") if isinstance(y, dict) else y.annotation_id) for _j, y in bad]
    more = f" ({len(bad) - 1} more as well)" if len(bad) > 1 else ""
    raise ApiError(422, "outside_window", f"Annotation {i} ({label} at {clock(onset)}) lies outside the part of the "
                   f"recording you were given, {window_text(window, sfreq)}{more}. Only that part is annotated in this "
                   "task: move it inside, or delete it.", annotation_ids=ids)


# ------------------------------------------------------------------- the view
@dataclass
class _Seen:
    """What one call has read once: the register, drafts, set-aside marks and adjudications."""

    entries: list[dict[str, str]] | None = None
    drafts: dict[str, set[str]] = field(default_factory=dict)
    unusable: dict[str, dict[str, str]] = field(default_factory=dict)
    adjudications: dict[str, dict[str, Any]] | None = None
    conflicts: dict[str, int | None] = field(default_factory=dict)


@dataclass
class _Planned:
    recording_id: str
    file_name: str
    window: tuple[int, int] | None
    annotators: list[str]
    holders: list[str]  # of those, the people who held the recording already (their assignment is linked)
    sfreq: float
    gold: dict[str, str] | None = None


class Tasks:
    """The tasks of one study (see the module docstring): ``service.tasks``."""

    def __init__(self, service: StudyService) -> None:
        self.service = service

    @property
    def store(self) -> Any:
        return self.service.store

    # ------------------------------------------------------------ reading tasks
    def all(self, *, removed: bool = False) -> list[dict[str, Any]]:
        """Every task (removed ones only when asked), oldest first, then by recording and window."""
        out = [t for t in self.store.records("tasks") if t.get("schema") == TASK_SCHEMA
               and (removed or t.get("state") != "removed")]
        return sorted(out, key=lambda t: (str(t.get("created_at", "")), str(t.get("recording_id", "")),
                                          int((t.get("window") or {}).get("start_sample", -1)), t.get("task_id", "")))

    def get(self, task_id: Any) -> dict[str, Any] | None:
        """One task by its ID (None for an unknown or removed one)."""
        if not isinstance(task_id, str) or not TASK_ID_RE.match(task_id):
            return None
        found: list[dict[str, Any] | None] = [None]

        def peek(old: dict[str, Any] | None) -> None:
            found[0] = old

        self.store.update_record("tasks", task_id, "", peek)
        t = found[0]
        return t if t and t.get("schema") == TASK_SCHEMA and t.get("state") != "removed" else None

    def for_recording(self, recording_id: str) -> list[dict[str, Any]]:
        """The tasks of one recording (each window its own), open and closed."""
        return [t for t in self.all() if t.get("recording_id") == recording_id]

    def _need(self, task_id: Any, *, code: int = 404) -> dict[str, Any]:
        t = self.get(task_id)
        if t is None:
            raise ApiError(code, "unknown_task", f"There is no task {task_id or '(none given)'} in this study")
        return t

    def _manifest(self, recording_id: str) -> dict[str, Any] | None:
        return self.store.manifest(SCOPE_STUDY, recording_id)

    def sfreq_of(self, task: dict[str, Any]) -> float:
        m = self._manifest(str(task.get("recording_id", "")))
        return float(m["timing"]["sfreq"]) if m else 1.0

    # ---------------------------------------------------------- the people's work
    def _entries(self, seen: _Seen) -> list[dict[str, str]]:
        if seen.entries is None:
            seen.entries = [e for e in self.store.completion_entries() if e.get("status") == "completed"
                            and e.get("mode", "standard") == "standard" and not e.get("context", "")]
        return seen.entries

    def attempts(self, task: dict[str, Any], seen: _Seen | None = None) -> dict[str, dict[str, Any] | None]:
        """Each annotator's latest saved attempt of the task's recording (the completion register's row, with
        ``attempt``), or None when they have not saved it."""
        seen = seen or _Seen()
        rid = task.get("recording_id")
        by: dict[str, list[dict[str, str]]] = {}
        for e in self._entries(seen):
            if e.get("recording_id") == rid:
                by.setdefault(str(e.get("annotator_id", "")), []).append(e)
        out: dict[str, dict[str, Any] | None] = {}
        for aid in task.get("annotators", []):
            rows = by.get(aid)
            if rows:
                latest = latest_entry(rows)
                out[aid] = {**latest, "attempt": attempt_of(latest)}
            else:
                out[aid] = None
        return out

    def _person(self, aid: str, task: dict[str, Any], saved: dict[str, Any] | None, seen: _Seen) -> dict[str, Any]:
        key = item_key(str(task["recording_id"]), "standard", "")
        if aid not in seen.drafts:
            seen.drafts[aid] = self.store.draft_keys(aid)
            seen.unusable[aid] = self.service.feedback.unusable_keys(aid)
        if saved is not None:
            status = "done"
        elif key in seen.unusable[aid]:
            status = "unusable"
        elif key in seen.drafts[aid]:
            status = "in_progress"
        elif task.get("state") == "closed":
            status = "closed"
        else:
            status = "todo"
        return {"annotator_id": aid, "letter": (task.get("letters") or {}).get(aid, ""), "status": status,
                "attempt": saved["attempt"] if saved else None,
                "saved_at": (saved.get("completed_at") or None) if saved else None}

    def _adjudications(self, seen: _Seen) -> dict[str, dict[str, Any]]:
        if seen.adjudications is None:
            seen.adjudications = {str(r.get("task_id")): r for r in self.store.records("adjudications")
                                  if r.get("task_id")}
        return seen.adjudications

    def status(self, task: dict[str, Any], seen: _Seen | None = None, *, count_conflicts: bool = True) -> str:
        """The derived status of a task (STATUSES)."""
        seen = seen or _Seen()
        if task.get("gold"):
            return "gold"
        adj = self._adjudications(seen).get(str(task.get("task_id")))
        if adj is not None:
            return "adjudicated" if adj.get("state") == "finished" else "adjudicating"
        attempts = self.attempts(task, seen)
        if sum(1 for a in attempts.values() if a is not None) < int(task.get("k") or len(attempts)):
            return "collecting"
        n = self.conflicts(task, seen) if count_conflicts else None
        return "saved" if n is None else ("ready" if n > 0 else "agreed")

    def conflicts(self, task: dict[str, Any], seen: _Seen | None = None) -> int | None:
        """How many conflicts the task's saved versions have (None: not counted, or not all saved)."""
        seen = seen or _Seen()
        tid = str(task.get("task_id"))
        if tid not in seen.conflicts:
            fn = conflict_counter()
            try:
                seen.conflicts[tid] = fn(self.service, task) if fn is not None else None
            except ApiError:
                seen.conflicts[tid] = None
        return seen.conflicts[tid]

    def out(self, task: dict[str, Any], seen: _Seen | None = None, *, count_conflicts: bool = True) -> dict[str, Any]:
        """TaskOut: the task as answered to the admin and expert areas (docs/web/api.md)."""
        seen = seen or _Seen()
        attempts = self.attempts(task, seen)
        people = [self._person(aid, task, attempts.get(aid), seen) for aid in task.get("annotators", [])]
        sfreq = self.sfreq_of(task)
        adj = self._adjudications(seen).get(str(task.get("task_id")))
        st = self.status(task, seen, count_conflicts=count_conflicts)
        return {
            "task_id": task["task_id"], "recording_id": task["recording_id"], "file_name": task.get("file_name", ""),
            "window": window_out(task.get("window"), sfreq), "k": int(task.get("k") or len(people)),
            "annotators": list(task.get("annotators", [])),
            # the letters of the people in the task (the record keeps those taken out too, so none is given twice)
            "letters": {a: c for a, c in (task.get("letters") or {}).items() if a in task.get("annotators", [])},
            "gold": dict(task["gold"]) if task.get("gold") else None, "blinded": bool(task.get("blinded", False)),
            "state": task.get("state", "open"), "status": st, "created_at": task.get("created_at", ""),
            "created_by": task.get("created_by", ""), "batch": task.get("batch", ""), "notes": task.get("notes", ""),
            "people": people,
            "counts": {"annotators": len(people), "saved": sum(1 for p in people if p["status"] == "done"),
                       "in_progress": sum(1 for p in people if p["status"] == "in_progress"),
                       "unusable": sum(1 for p in people if p["status"] == "unusable")},
            "conflicts": seen.conflicts.get(str(task["task_id"])) if st in ("ready", "agreed", "saved") else None,
            "adjudication": ({"adjudicator_id": adj.get("adjudicator_id", ""), "state": adj.get("state", ""),
                              "conflicts": (adj.get("counts") or {}).get("conflicts"),
                              "decided": (adj.get("counts") or {}).get("decided")} if adj else None),
        }

    def outs(self, tasks: list[dict[str, Any]], *, count_conflicts: bool = True) -> list[dict[str, Any]]:
        """TaskOut of several tasks, reading the register, drafts and adjudications once for all of them."""
        seen = _Seen()
        return [self.out(t, seen, count_conflicts=count_conflicts) for t in tasks]

    # ------------------------------------------------ what an annotator receives
    def item_task(self, item: WorkItem, tasks: dict[str, dict[str, Any]] | None = None) -> dict[str, Any] | None:
        """``task`` of an assignment item and of ``POST /match``: ``{"task_id", "window"}`` or None. Nothing says
        whether it is a known-answer task."""
        task = self.task_of(item, tasks)
        if task is None:
            return None
        sfreq = float(item.manifest["timing"]["sfreq"])
        return {"task_id": task["task_id"], "window": window_out(task.get("window"), sfreq)}

    def task_of(self, item: WorkItem, tasks: dict[str, dict[str, Any]] | None = None) -> dict[str, Any] | None:
        tid = getattr(item, "task_id", "")
        if not tid or item.mode != "standard":
            return None
        if tasks is not None:
            t = tasks.get(tid)
            return t if t and t.get("state") != "removed" else None
        return self.get(tid)

    def by_id(self) -> dict[str, dict[str, Any]]:
        return {t["task_id"]: t for t in self.all()}

    def window_of(self, item: WorkItem) -> dict[str, Any] | None:
        task = self.task_of(item)
        return task.get("window") if task else None

    def window_for(self, annotator_id: str, recording_id: str) -> dict[str, Any] | None:
        """The window ({start_sample, end_sample}) of the task in which a person holds a study recording, or None
        (no task, or the whole recording): for checking a version of their work made by someone else."""
        for a in self.store.assignments(annotator_id):
            if a.recording_id == recording_id and a.mode == "standard" and a.task_id:
                task = self.get(a.task_id)
                return task.get("window") if task else None
        return None

    def check_item(self, item: WorkItem, annotations: list[Any]) -> None:
        """``submit`` and ``put_draft``: the annotations of a window task lie inside its window."""
        window = self.window_of(item)
        if window:
            check_window(annotations, window, float(item.manifest["timing"]["sfreq"]))

    # ----------------------------------------------------------- known answers
    def after_save(self, user: User, item: WorkItem, saved: Any) -> dict[str, Any] | None:
        """After a save: score a known-answer task's annotations against its reference, kept as a ``gold``
        record (the annotator is told nothing of it)."""
        task = self.task_of(item)
        if not task or not task.get("gold"):
            return None
        return self._score(task, user.annotator_id, saved.session.build_document(), int(saved.attempt))

    def _reference(self, task: dict[str, Any]) -> tuple[Any, Any]:
        rs = self.service.reference_set(str((task.get("gold") or {}).get("set_id", "")))
        return rs, rs.reference_document(str(task["recording_id"]))

    def _score(self, task: dict[str, Any], aid: str, doc: Any, attempt: int) -> dict[str, Any]:
        from dataclasses import replace

        from electrotag.app.annotations.model import ArtifactAnnotation
        from electrotag.training.assessment import practice_feedback
        from electrotag.web.service import clean_json

        rs, ref = self._reference(task)
        window = task.get("window")
        if window:  # the reference within the window, as the annotator saw it
            a, b = int(window["start_sample"]), int(window["end_sample"])
            kept: list[ArtifactAnnotation] = []
            for x in ref.annotations:
                lo, hi = max(a, x.onset_sample), min(b, x.onset_sample + x.duration_samples)
                if hi > lo:
                    kept.append(replace(x, onset_sample=lo, duration_samples=hi - lo))
            ref = replace(ref, annotations=kept)
            doc = replace(doc, annotations=[x for x in doc.annotations
                                            if x.onset_sample >= a and x.onset_sample + x.duration_samples <= b])
        fb = practice_feedback(doc, ref, rs)
        overall = fb.get("overall", {})
        score = clean_json({"attempt": attempt, "event_f1": overall.get("event_f1"),
                            "label_accuracy": overall.get("label_accuracy"),
                            "event_precision": overall.get("event_precision"),
                            "event_recall": overall.get("event_recall"), "scored_at": now_local_iso()})
        per_category = clean_json(fb.get("per_category", []))

        def change(old: dict[str, Any] | None) -> dict[str, Any]:
            history = [h for h in (old or {}).get("attempts", []) if h.get("attempt") != attempt] + [score]
            return {"schema": GOLD_SCHEMA, "schema_version": 1, "task_id": task["task_id"], "annotator_id": aid,
                    "recording_id": task["recording_id"], "set_id": task["gold"]["set_id"],
                    "window": task.get("window"), **score, "per_category": per_category,
                    "attempts": sorted(history, key=lambda h: int(h.get("attempt") or 0))}

        return self.store.update_record("gold", f"{aid}_{task['task_id']}", aid, change) or {}

    def gold_scores(self) -> list[dict[str, Any]]:
        """Every known-answer score kept, scoring any saved attempt that has none yet (a save whose scoring
        was interrupted)."""
        kept = {(r.get("annotator_id"), r.get("task_id")): r for r in self.store.records("gold")}
        seen = _Seen()
        for task in self.all():
            if not task.get("gold"):
                continue
            for aid, latest in self.attempts(task, seen).items():
                if latest is None:
                    continue
                have = kept.get((aid, task["task_id"]))
                if have is not None and int(have.get("attempt") or 0) >= latest["attempt"]:
                    continue
                raw = self.store.saved_document(aid, task["recording_id"], "standard", "", attempt=latest["attempt"])
                if raw is None:
                    continue
                try:
                    kept[(aid, task["task_id"])] = self._score(task, aid, _document(raw), latest["attempt"])
                except (ApiError, ValueError, KeyError) as exc:  # a reference removed since: left unscored
                    import logging

                    logging.getLogger("electrotag.web").warning("Known answer %s of %s not scored: %s",
                                                                task["task_id"], aid, exc)
        return list(kept.values())

    # -------------------------------------------------------- sharing out (plan)
    def _pool(self, body: dict[str, Any]) -> list[str]:
        from electrotag.web.admin import _ids

        pool = _ids(body.get("annotator_ids"), "annotator_ids")
        if len(pool) > MAX_POOL:
            raise _bad(f"Choose at most {MAX_POOL} annotators")
        for aid in pool:
            rec = self.store.user_record(aid)
            if rec is None:
                raise ApiError(404, "unknown_user", f"{aid} has no account in this study")
            if rec.get("status", "active") != "active":
                raise ApiError(409, "disabled", f"{aid}'s account is switched off; switch it on, or leave {aid} out")
        return pool

    def _recordings(self, body: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        registered = {m["recording_id"]: m for m in self.store.manifests() if m["scope"] == SCOPE_STUDY}
        if body.get("all") is True:
            wanted = sorted(registered)
        else:
            wanted = body.get("recording_ids")
            if not isinstance(wanted, list) or not wanted or not all(isinstance(r, str) for r in wanted):
                raise _bad("Give recording_ids (a list) or \"all\": true")
            if len(set(wanted)) != len(wanted):
                raise _bad("recording_ids names a recording twice")
            unknown = [r for r in wanted if r not in registered]
            if unknown:
                raise ApiError(404, "unknown_recording", "Not registered in the study: " + ", ".join(unknown[:10]))
        skipped = [{"recording_id": r, "reason": "retired"} for r in wanted
                   if (registered[r].get("registration") or {}).get("retired")]
        gone = {s["recording_id"] for s in skipped}
        return [registered[r] for r in wanted if r not in gone], skipped

    def _gold(self, body: dict[str, Any]) -> Any:
        g = body.get("gold")
        if g is None:
            return None
        if not isinstance(g, dict) or not isinstance(g.get("set_id"), str) or not g["set_id"]:
            raise _bad("gold must be {\"set_id\": the reference set that holds the known answers}")
        return self.service.reference_set(g["set_id"])

    def _holdings(self) -> dict[str, dict[str, str]]:
        """recording ID -> {annotator: task ID ("" for an assignment without a task)} (the study's own annotation)."""
        out: dict[str, dict[str, str]] = {}
        for a in self.store.assignments():
            if a.mode == "standard":
                out.setdefault(a.recording_id, {})[a.annotator_id.upper()] = a.task_id
        return out

    def _load(self, tasks: list[dict[str, Any]], seen: _Seen) -> dict[str, int]:
        """How many open tasks each person has not saved yet."""
        load: dict[str, int] = {}
        for t in tasks:
            if t.get("state") != "open":
                continue
            for aid, latest in self.attempts(t, seen).items():
                if latest is None:
                    load[aid] = load.get(aid, 0) + 1
        return load

    def plan(self, body: dict[str, Any]) -> dict[str, Any]:
        """The tasks a request would make, without making them (``tasks_preview_get``, and the first step of
        ``tasks_create``)."""
        adopt = body.get("adopt") is True
        if body.get("adopt") not in (None, True, False):
            raise _bad("adopt must be true or false")
        spec = window_spec(body)
        if adopt and spec is not None:
            raise _bad("Existing assignments are adopted as whole recordings: leave out window and windows")
        pool = self._pool(body)
        rs = self._gold(body)
        if rs is not None and adopt:
            raise _bad("A known-answer task goes to everyone chosen: it cannot adopt existing assignments")
        k_default = int(self.service.settings.review.k_default)
        k = body.get("k", k_default)
        if rs is None and not adopt:
            if isinstance(k, bool) or not isinstance(k, int) or not K_MIN <= k <= K_MAX:
                raise _bad(f"k (annotators per recording) must be a whole number from {K_MIN} to {K_MAX}")
            if k > len(pool):
                raise ApiError(400, "k_too_large", f"Each recording is to go to {k} people, but only {len(pool)} "
                               f"{'is' if len(pool) == 1 else 'are'} chosen. Choose at least {k} annotators, or "
                               "lower the number per recording.")
        manifests, skipped = self._recordings(body)
        seen = _Seen()
        existing = self.all()
        open_by_rid = {t["recording_id"] for t in existing if t.get("state") == "open"}
        holdings = self._holdings()
        load = self._load(existing, seen)
        load_before = {aid: load.get(aid, 0) for aid in pool}
        # how many tasks each pair of people shares already: the share-out evens the pairs out as well
        pairs: dict[Pair, int] = {}
        for t in existing:
            if not t.get("gold"):
                for a, b in itertools.combinations(sorted(set(t.get("annotators") or [])), 2):
                    pairs[(a, b)] = pairs.get((a, b), 0) + 1
        planned: list[_Planned] = []
        for m in manifests:
            rid = m["recording_id"]
            if rid in open_by_rid:
                skipped.append({"recording_id": rid, "reason": "has_task"})
                continue
            sfreq, n = float(m["timing"]["sfreq"]), int(m["timing"]["n_samples"])
            held = holdings.get(rid, {})
            # people whose assignment of this recording is already another task's cannot take this one
            relinkable = {aid for aid, tid in held.items() if not tid}
            gold = None
            if rs is not None:
                problem = self._gold_problem(rs, m)
                if problem:
                    skipped.append({"recording_id": rid, "reason": problem})
                    continue
                gold = {"set_id": rs.set_id}
            if adopt:
                have = [aid for aid in pool if aid in relinkable]
                if len(have) < 2:
                    skipped.append({"recording_id": rid, "reason": "fewer_than_two"})
                elif len(have) > K_MAX:
                    skipped.append({"recording_id": rid, "reason": "too_many_annotators"})
                else:
                    planned.append(_Planned(rid, m["file_name"], None, have, have, sfreq))
                    for aid in have:
                        load[aid] = load.get(aid, 0) + 1
                    for a, b in itertools.combinations(sorted(have), 2):
                        pairs[(a, b)] = pairs.get((a, b), 0) + 1
                continue
            taken: set[str] = set()
            for w in windows_of(n, sfreq, spec):
                start = w[0] if w else None
                if w is not None:
                    if w[0] >= n:
                        skipped.append({"recording_id": rid, "reason": "window_outside", "start_s": w[0] / sfreq})
                        continue
                    if (w[1] - w[0]) / sfreq < MIN_WINDOW_S:
                        skipped.append({"recording_id": rid, "reason": "window_too_short", "start_s": w[0] / sfreq})
                        continue
                    if w == (0, n):
                        w = None
                # Someone given the whole recording already is linked to a task of the whole recording, and left
                # out of a window's task (linking them would shut them out of the rest of it).
                free = [aid for aid in pool if aid not in taken
                        and (aid not in held or (w is None and aid in relinkable))]
                if rs is not None:
                    chosen = free
                    if not chosen:
                        skipped.append({"recording_id": rid, "reason": "too_few_annotators",
                                        **({"start_s": start / sfreq} if start is not None else {})})
                        continue
                else:
                    if len(free) < k:
                        skipped.append({"recording_id": rid, "reason": "too_few_annotators",
                                        **({"start_s": start / sfreq} if start is not None else {})})
                        continue
                    chosen = choose_group(rid, start, free, k, load, pairs, relinkable)
                    for a, b in itertools.combinations(sorted(chosen), 2):
                        pairs[(a, b)] = pairs.get((a, b), 0) + 1
                taken.update(chosen)
                for aid in chosen:
                    load[aid] = load.get(aid, 0) + 1
                holders = sorted(a for a in chosen if a in held)
                planned.append(_Planned(rid, m["file_name"], w, sorted(chosen), holders, sfreq, gold))
        if len(planned) > MAX_TASKS:
            raise _bad(f"This would make {len(planned)} tasks; at most {MAX_TASKS} are made at once. Choose fewer "
                       "recordings, or longer windows.", "too_many")
        new_assignments = sum(len(p.annotators) - len(p.holders) for p in planned)
        standing = self._standing(pool)
        per = [{"annotator_id": aid, "open_before": load_before[aid],
                "new": sum(1 for p in planned if aid in p.annotators),
                "linked": sum(1 for p in planned if aid in p.holders), **standing[aid]} for aid in pool]
        return {"planned": planned, "skipped": skipped, "per_annotator": per, "assigned": new_assignments,
                "k": None if (rs is not None or adopt) else k, "gold": rs, "adopt": adopt,
                # after the share-out: the study's earlier tasks (not known answers) and the new ones
                "pairs": None if rs is not None else pair_spread(
                    pool, [list(t.get("annotators") or []) for t in existing if not t.get("gold")]
                    + [p.annotators for p in planned]),
                "warnings": self._warnings(per)}

    def _standing(self, pool: list[str]) -> dict[str, dict[str, bool]]:
        """For each person of a pool: whether they have the annotator role (``annotates``) and whether their
        study work waits for the competency assessment (``study_locked``, the training gate)."""
        from electrotag.web.store import parse_roles

        out: dict[str, dict[str, bool]] = {}
        for aid in pool:
            rec = self.store.user_record(aid) or {}
            person = User(aid, rec.get("display_name", ""), roles=parse_roles(rec.get("roles") or rec.get("role")))
            out[aid] = {"annotates": person.has_role("annotator"),
                        "study_locked": not self.service.training_path.gate(person)["open"]}
        return out

    @staticmethod
    def _warnings(per: list[dict[str, Any]]) -> list[str]:
        """What the study team should know before making the share-out, in plain words."""
        def names(ids: list[str]) -> str:
            return ", ".join(ids[:10]) + (f" and {len(ids) - 10} more" if len(ids) > 10 else "")

        out = []
        locked = [r["annotator_id"] for r in per if r["study_locked"] and r["new"]]
        if locked:
            out.append(f"{names(locked)} {'is a trainee' if len(locked) == 1 else 'are trainees'} whose study work is "
                       "locked until the competency assessment is passed, so their tasks wait in Collecting until "
                       "then.")
        others = [r["annotator_id"] for r in per if not r["annotates"] and r["new"]]
        if others:
            out.append(f"{names(others)} {'has' if len(others) == 1 else 'have'} no annotator role. Nobody adjudicates "
                       "a task they annotated, so an expert given tasks here cannot adjudicate them.")
        return out

    def _gold_problem(self, rs: Any, m: dict[str, Any]) -> str:
        rid = m["recording_id"]
        if rid not in rs.recordings:
            return "no_gold_reference"
        try:
            rs.reference_path(rid)
        except Exception:  # noqa: BLE001 - a recording of the set without its reference file
            return "no_gold_reference"
        copy = self.store.manifest(set_scope(rs.set_id), rid) if rs.self_contained else None
        if copy is not None and fingerprint_of(copy) != fingerprint_of(m):
            return "gold_mismatch"
        return ""

    @staticmethod
    def _planned_out(p: _Planned) -> dict[str, Any]:
        w = {"start_sample": p.window[0], "end_sample": p.window[1]} if p.window else None
        return {"task_id": None, "recording_id": p.recording_id, "file_name": p.file_name,
                "window": window_out(w, p.sfreq), "k": len(p.annotators), "annotators": list(p.annotators),
                "holders": list(p.holders), "gold": dict(p.gold) if p.gold else None}

    # ---------------------------------------------------------- the admin's operations
    def op_preview(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``tasks_preview_get``: what ``tasks_create`` with the same body would make (nothing is kept)."""
        p = self.plan(body)
        return {"tasks": [self._planned_out(x) for x in p["planned"]], "skipped": p["skipped"],
                "per_annotator": p["per_annotator"], "created": len(p["planned"]), "assigned": p["assigned"],
                "k": p["k"], "pairs": p["pairs"], "warnings": p["warnings"]}

    def op_create(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``tasks_create``: make the tasks and their assignments, once per ``request_id``."""
        from electrotag.web.admin import _text

        rid = body.get("request_id")
        if not isinstance(rid, str) or not REQUEST_RE.match(rid):
            raise _bad("request_id must be 32 hexadecimal characters, made by the browser for this request")
        batch = _text(body, "batch", limit=80)
        notes = _text(body, "notes", limit=1000)
        done = [t for t in self.all() if t.get("request_id") == rid]
        if done:  # sent again (a late answer): the same tasks, and any assignment still missing is made
            for t in done:
                self._assign(t)
            seen = _Seen()
            return {"tasks": [self.out(t, seen) for t in done], "created": len(done), "assigned": 0,
                    "skipped": [], "per_annotator": [], "already": True}
        p = self.plan(body)
        secret = self.store.study_secret("tasks")
        now = now_local_iso()
        made: list[dict[str, Any]] = []
        for x in p["planned"]:
            tid = task_id_for(rid, x.recording_id, x.window[0] if x.window else None)
            record = {"schema": TASK_SCHEMA, "schema_version": 1, "task_id": tid, "recording_id": x.recording_id,
                      "file_name": x.file_name, "scope": SCOPE_STUDY,
                      "window": {"start_sample": x.window[0], "end_sample": x.window[1]} if x.window else None,
                      "k": len(x.annotators), "annotators": list(x.annotators),
                      "letters": letters_for(secret, tid, list(x.annotators)), "gold": x.gold, "blinded": False,
                      "state": "open", "adopted": list(x.holders), "created_at": now, "created_by": user.annotator_id,
                      "request_id": rid, "batch": batch, "notes": notes, "changes": []}
            made.append(self.store.update_record("tasks", tid, "", lambda old, r=record: r if old is None else None)
                        or record)
        assigned = sum(self._assign(t) for t in made)
        n_gold = sum(1 for t in made if t.get("gold"))
        what = (f"{audit.count(len(made), 'known-answer task')} from {p['gold'].set_id}" if p["gold"] is not None
                else f"{audit.count(len(made), 'task')}" + ("" if p["k"] is None else f" of {p['k']} annotators"))
        people = [x["annotator_id"] for x in p["per_annotator"]]
        self.service.administration._audit(
            user, "tasks_create", f"Made {what} for {', '.join(people[:6])}{' …' if len(people) > 6 else ''}"
            f"{' (existing assignments adopted)' if p['adopt'] else ''}: {audit.count(assigned, 'new assignment')}",
            request_id=rid, task_ids=[t["task_id"] for t in made], annotator_ids=people, k=p["k"],
            gold=p["gold"].set_id if p["gold"] is not None else None, adopt=p["adopt"], assigned=assigned,
            skipped=p["skipped"], batch=batch, n_gold=n_gold)
        seen = _Seen()
        return {"tasks": [self.out(t, seen, count_conflicts=False) for t in made], "created": len(made),
                "assigned": assigned, "skipped": p["skipped"], "per_annotator": p["per_annotator"], "already": False}

    def _assign(self, task: dict[str, Any]) -> int:
        """The task's assignments (an assignment of the recording without a task is linked to it)."""
        added = 0
        for aid in task.get("annotators", []):
            added += self.store.assign(aid, [task["recording_id"]], mode="standard", context_id="",
                                       task_id=task["task_id"])
        return added

    def op_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``tasks_list``: every task, with its people and derived status, filtered."""
        status, rid, gold = body.get("status"), body.get("recording_id"), body.get("gold")
        aid = body.get("annotator_id")
        if status is not None and status not in STATUSES:
            raise _bad(f"status must be one of {', '.join(STATUSES)}")
        if aid is not None:
            from electrotag.web.admin import _aid

            aid = _aid(aid)
        if gold not in (None, True, False):
            raise _bad("gold must be true or false")
        seen = _Seen()
        out = []
        for t in self.all():
            if rid is not None and t.get("recording_id") != rid:
                continue
            if aid is not None and aid not in t.get("annotators", []):
                continue
            if gold is not None and bool(t.get("gold")) != gold:
                continue
            o = self.out(t, seen)
            if status is None or o["status"] == status:
                out.append(o)
        counts: dict[str, int] = {}
        for o in out:
            counts[o["status"]] = counts.get(o["status"], 0) + 1
        return {"tasks": out, "counts": counts}

    def op_update(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``task_update``: put someone in or take them out (both, to replace a person), close or reopen, notes."""
        from electrotag.web.admin import _aid, _text

        task = self._need(body.get("task_id"))
        add = _aid(body["add_annotator"], "add_annotator") if body.get("add_annotator") is not None else None
        drop = _aid(body["remove_annotator"], "remove_annotator") if body.get("remove_annotator") is not None else None
        state = body.get("state", body.get("status"))
        if state is not None and state not in STATES:
            raise _bad("state must be open or closed")
        notes = _text(body, "notes", limit=1000) if body.get("notes") is not None else None
        if add is None and drop is None and state is None and notes is None:
            raise _bad("Nothing to change: give add_annotator, remove_annotator, state or notes")
        if add is not None and task.get("state") == "closed" and state != "open":
            raise ApiError(409, "closed", "The task is closed: reopen it before putting someone in it")
        people = list(task["annotators"])
        rid = task["recording_id"]
        seen = _Seen()
        attempts = self.attempts(task, seen)
        gold = bool(task.get("gold"))
        if drop is not None:
            if drop not in people:
                raise ApiError(404, "not_in_task", f"{drop} is not one of the task's annotators")
            if attempts.get(drop) is not None:
                raise ApiError(409, "has_results", f"{drop} has saved this recording for the task, so they stay in it. "
                               "Their saved work is kept; close the task if no more is wanted.")
        if add is not None:
            if add in people:
                raise ApiError(409, "already_in_task", f"{add} is one of the task's annotators already")
            rec = self.store.user_record(add)
            if rec is None:
                raise ApiError(404, "unknown_user", f"{add} has no account in this study")
            if rec.get("status", "active") != "active":
                raise ApiError(409, "disabled", f"{add}'s account is switched off")
            held = self._holdings().get(rid, {})
            if add in held and held[add] and held[add] != task["task_id"]:
                raise ApiError(409, "task_conflict", f"{add} already holds {task.get('file_name') or rid} for another "
                               "task, and one person holds one task of a recording. Choose someone else.")
        size = len(people) + (add is not None) - (drop is not None)
        if not gold and size > K_MAX:
            raise ApiError(400, "k_too_large", f"A task has at most {K_MAX} annotators")
        if not gold and size < K_MIN:
            raise ApiError(409, "too_few", f"A task needs at least {K_MIN} annotators: put someone else in when "
                           f"taking {drop} out (both in one change)")
        if gold and size < 1:
            raise ApiError(409, "too_few", "A known-answer task needs at least one annotator")
        now = now_local_iso()
        # the assignments first: a change that fails half way leaves the record as it was, and can be sent again
        if drop is not None:
            self._take_away(task, drop)
        if add is not None and (state or task.get("state")) == "open":
            self.store.assign(add, [rid], mode="standard", context_id="", task_id=task["task_id"])
        if state == "closed" and task.get("state") != "closed":
            for aid in people:
                if aid != drop and attempts.get(aid) is None:
                    self._take_away(task, aid)
        if state == "open" and task.get("state") == "closed":
            for aid in [p for p in people if p != drop] + ([add] if add else []):
                if attempts.get(aid) is None:
                    self.store.assign(aid, [rid], mode="standard", context_id="", task_id=task["task_id"])

        def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
            if old is None:
                return None
            new = dict(old)
            members = [p for p in old.get("annotators", []) if p != drop]
            letters = {a: c for a, c in (old.get("letters") or {}).items()}
            if add is not None and add not in members:
                members.append(add)
                letters[add] = next_letter(letters)
            new["annotators"] = sorted(members)
            new["k"] = len(members)
            new["letters"] = letters
            new["adopted"] = [a for a in old.get("adopted", []) if a in members]
            if state is not None:
                new["state"] = state
            if notes is not None:
                new["notes"] = notes
            entry = {"at": now, "by": user.annotator_id, **({"added": add} if add else {}),
                     **({"removed": drop} if drop else {}), **({"state": state} if state else {}),
                     **({"notes": True} if notes is not None else {})}
            new["changes"] = [*old.get("changes", []), entry][-200:]
            return new

        kept = self.store.update_record("tasks", task["task_id"], "", change) or task
        parts = [f"put {add} in" if add else "", f"took {drop} out" if drop else "",
                 {"closed": "closed it", "open": "reopened it"}.get(state or "", "")
                 if state != task.get("state") else "",
                 "changed its notes" if notes is not None else ""]
        self.service.administration._audit(
            user, "task_update", f"Task {task['task_id']} ({task.get('file_name') or rid}): "
            + ", ".join(p for p in parts if p), task_id=task["task_id"], recording_id=rid, added=add, removed=drop,
            state=state)
        return {"task": self.out(kept, _Seen())}

    def _take_away(self, task: dict[str, Any], aid: str, *, give_back: bool = False) -> None:
        """Take a person's unfinished assignment of the task away. With ``give_back`` (the task is removed), an
        assignment they held before the task (adopted) is given back to them without the task, as it was."""
        rid = task["recording_id"]
        if self.store.unassign_item(aid, rid, "standard", ""):
            self.service.feedback.clear_mark(aid, rid, "standard", "")
            if give_back and aid in task.get("adopted", []):
                self.store.assign(aid, [rid], mode="standard", context_id="")

    def op_remove(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``task_remove``: the task and its unfinished assignments go; refused once anyone saved it (409
        ``has_results``: close it instead), so that no result ever loses its task."""
        task = self._need(body.get("task_id"))
        saved = [aid for aid, a in self.attempts(task).items() if a is not None]
        if saved:
            raise ApiError(409, "has_results", f"{', '.join(saved)} {'has' if len(saved) == 1 else 'have'} saved this "
                           "recording for the task, so the task stays with their results. Close it instead: the "
                           "others' unfinished assignments are taken away and every saved result is kept.")
        for aid in task.get("annotators", []):
            self._take_away(task, aid, give_back=True)
        now = now_local_iso()

        def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
            if old is None:
                return None
            return {**old, "state": "removed", "removed_at": now, "removed_by": user.annotator_id,
                    "changes": [*old.get("changes", []), {"at": now, "by": user.annotator_id, "state": "removed"}]}

        self.store.update_record("tasks", task["task_id"], "", change)
        self.service.administration._audit(
            user, "task_remove", f"Removed task {task['task_id']} ({task.get('file_name') or task['recording_id']})",
            task_id=task["task_id"], recording_id=task["recording_id"], annotator_ids=task.get("annotators", []))
        return {}

    def op_quality(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``quality_list``: each annotator's accuracy on the known-answer tasks they saved."""
        min_items = int(self.service.settings.review.gold_min_items)
        scores = self.gold_scores()
        people: dict[str, list[dict[str, Any]]] = {}
        for task in self.all():
            if task.get("gold"):
                for aid in task.get("annotators", []):
                    people.setdefault(aid, [])
        for s in scores:
            people.setdefault(str(s.get("annotator_id")), []).append(s)

        def mean(values: list[Any]) -> float | None:
            v = [float(x) for x in values if isinstance(x, (int, float)) and not isinstance(x, bool)
                 and math.isfinite(x)]
            return sum(v) / len(v) if v else None

        rows = []
        for aid in sorted(people):
            mine = people[aid]
            f1 = mean([s.get("event_f1") for s in mine])
            rows.append({"annotator_id": aid, "n_gold": len(mine), "mean_event_f1": f1,
                         "mean_label_accuracy": mean([s.get("label_accuracy") for s in mine]),
                         "weight": f1 if (len(mine) >= min_items and f1 is not None) else None})
        return {"annotators": rows, "min_items": min_items}


def _document(raw: bytes) -> Any:
    """A saved ``_annotations.json`` as an AnnotationDocument."""
    import json

    from electrotag.app.io.canonical import document_from_dict

    return document_from_dict(json.loads(raw))


# ------------------------------------------------------------------ results files
TASK_COLUMNS = ("task_id", "recording_id", "file_name", "start_sample", "end_sample", "k", "annotators", "letters",
                "gold_set", "state", "batch", "created_at", "created_by", "notes")
GOLD_COLUMNS = ("annotator_id", "task_id", "recording_id", "set_id", "attempt", "event_f1", "label_accuracy",
                "event_precision", "event_recall", "scored_at")


def task_files(store: Any) -> dict[str, bytes]:
    """The tasks and the known-answer scores as files of the results folder (docs/file_formats.md): one TSV and
    one JSON of every task, removed ones included, and a TSV of the scores."""
    import csv
    import io
    import json

    tasks = sorted((t for t in store.records("tasks") if t.get("schema") == TASK_SCHEMA),
                   key=lambda t: (str(t.get("created_at", "")), str(t.get("task_id", ""))))
    out: dict[str, bytes] = {}
    if not tasks:
        return out

    def tsv(columns: tuple[str, ...], rows: list[dict[str, Any]]) -> bytes:
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=list(columns), delimiter="\t", lineterminator="\n", extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: ("" if r.get(k) is None else str(r.get(k)).replace("\t", " ").replace("\n", " "))
                        for k in columns})
        return buf.getvalue().encode("utf-8")

    rows = [{**t, "start_sample": (t.get("window") or {}).get("start_sample"),
             "end_sample": (t.get("window") or {}).get("end_sample"), "annotators": ",".join(t.get("annotators", [])),
             "letters": ",".join(f"{a}={c}" for a, c in sorted((t.get("letters") or {}).items())),
             "gold_set": (t.get("gold") or {}).get("set_id")} for t in tasks]
    out["tasks/tasks.tsv"] = tsv(TASK_COLUMNS, rows)
    out["tasks/tasks.json"] = json.dumps({"schema": "electrotag.tasks", "schema_version": 1, "tasks": tasks},
                                         indent=1, ensure_ascii=False).encode("utf-8")
    gold = sorted(store.records("gold"), key=lambda r: (str(r.get("annotator_id")), str(r.get("task_id"))))
    if gold:
        out["tasks/gold_scores.tsv"] = tsv(GOLD_COLUMNS, gold)
    return out


__all__ = ["GOLD_SCHEMA", "K_MAX", "K_MIN", "STATUSES", "TASK_SCHEMA", "Tasks", "check_window", "clock",
           "letters_for", "register_conflict_counter", "task_files", "task_id_for", "window_out", "windows_of"]
