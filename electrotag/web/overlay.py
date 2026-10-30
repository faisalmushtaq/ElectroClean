"""Everyone's marks on one recording, for the overlay view (docs/web/api.md, "The overlay of everyone's marks").

The overlay puts several people's saved marks on the same file: up to eight of them in lanes of their own,
and everyone else as a **crowd**, shaded by the share of people who marked each moment. ``overlay_get``
gives the browser what both need in one compact answer: every person's latest saved version of the
recording, each mark as five whole numbers (type, onset and duration in samples, channel set, confidence),
the types and channel sets once in tables of their own (a set as runs of channel indexes, "0-3,7"), and
the crowd's counts per time bin (computed here, over everyone, so that a page of people never changes
them). Saved versions never change, so each one is read once and kept in memory for the next request.
With hundreds of people the answer comes in pages of :data:`MAX_PAGE` people (``offset``,
``next_offset``); the annotation IDs come only for the people shown in lanes (``detail``), since the
crowd needs none.

**Derived versions.** ``include`` adds the corrected versions of the people's latest work
(``corrected``: one per expert who corrected it) and the latest adjudicated version of the recording
(``adjudicated``). They are offered as lanes and never counted in the crowd, which holds people's own
work only.

**Who may see it.** Experts and administrators see everyone's marks with their IDs and names. Anyone else
(a trainee) sees a crowd only, with nobody named, and only while the study's
``replay.trainees_see_crowd`` is on (it is off by default), on a **teaching recording**
(:func:`electrotag.web.replay.teaching_recording`, the rule for watching an expert's session): a
recording that can never be study work, nor give a practice or assessment's answers away, so that what
people annotate for the study stays their own judgement. ``overlay_teaching_list`` lists those recordings.

**Facets.** Other parts of the study (groups of people, experience bands from a questionnaire) describe
people for the overlay's filters with :func:`register_facet`: ``fn(service, annotator_ids) -> {id: value}``,
where a value is a text or a list of texts. Each facet comes in the answer with its values, and the view
offers a filter for each; without any, the view has none. Trainees are given no facets.
"""

from __future__ import annotations

import math
import threading
from collections import OrderedDict
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from electrotag.web.errors import ApiError
from electrotag.web.expert import expert_op
from electrotag.web.manifest import set_scope
from electrotag.web.store import MODES, User, attempt_of, latest_entry, parse_roles

if TYPE_CHECKING:
    from electrotag.web.service import StudyService

#: Most people shown in lanes of their own, with their annotation IDs (``detail``).
MAX_LANES = 8
#: People per page of the answer.
MAX_PAGE = 500
#: Most bins of the crowd's counts: the bin is a whole number of seconds, at least one.
MAX_BINS = 1000
#: Saved versions kept in memory, read once each (they never change).
CACHE_SIZE = 5000
INCLUDE = ("corrected", "adjudicated")
#: Whose versions the ``adjudicated`` lane shows (electrotag/web/store.py RESERVED_IDS).
ADJUDICATED = "ADJUDICATED"

NOT_SHOWN = ("This study does not show trainees other people's marks at the moment. The study team can switch it on "
             "in the study settings.")
NOT_FOR_TEACHING = ("Other people's marks are shown to trainees only on the training recordings for learning with the "
                    "experts, so that what you annotate for the study stays your own judgement. This recording is not "
                    "one of them.")

#: A facet: ``(service, annotator_ids) -> {annotator_id: value or [values]}``.
FacetFn = Callable[["StudyService", list[str]], dict[str, Any]]
#: key -> (title, function), filled by :func:`register_facet`.
FACETS: dict[str, tuple[str, FacetFn]] = {}


def register_facet(key: str, title: str) -> Callable[[FacetFn], FacetFn]:
    """Describe people for the overlay's filters under ``key`` (for example ``group``, "Group")."""

    def register(fn: FacetFn) -> FacetFn:
        FACETS[key] = (title, fn)
        return fn

    return register


def _bad(message: str) -> ApiError:
    return ApiError(400, "bad_request", message)


# ------------------------------------------------------------------ the crowd's counts
def bin_seconds(duration_s: float) -> int:
    """The crowd's bin: one second, or as many whole seconds as keep the bins to :data:`MAX_BINS`."""
    return max(1, math.ceil(max(0.0, float(duration_s)) / MAX_BINS))


def crowd_counts(people: list[list[tuple[int, int, bool]]], n_samples: int, sfreq: float) -> dict[str, Any]:
    """How many people marked each bin of the recording: ``marking`` (any mark) and ``whole`` (a mark on the whole
    montage). ``people`` holds each person's marks as ``(onset_sample, duration_samples, whole_montage)``. The
    browser counts the same way (js/expert/crowd.js binCounts), checked on the same cases."""
    bin_s = bin_seconds(n_samples / sfreq if sfreq > 0 else 0.0)
    width = bin_s * sfreq
    n_bins = max(1, math.ceil(n_samples / width)) if width > 0 else 1
    marking = [0] * n_bins
    whole = [0] * n_bins
    for marks in people:
        seen_any: set[int] = set()
        seen_whole: set[int] = set()
        for onset, dur, is_whole in marks:
            a = min(n_bins - 1, max(0, math.floor(onset / width)))
            b = min(n_bins - 1, max(a, math.floor((onset + max(1, dur) - 1) / width)))
            span = range(a, b + 1)
            seen_any.update(span)
            if is_whole:
                seen_whole.update(span)
        for i in seen_any:
            marking[i] += 1
        for i in seen_whole:
            whole[i] += 1
    return {"bin_s": bin_s, "n_bins": n_bins, "n_people": len(people), "marking": marking, "whole": whole}


# ------------------------------------------------------------------ reading saved versions
_lock = threading.Lock()


def _cache(service: StudyService) -> OrderedDict[tuple[Any, ...], list[tuple[Any, ...]]]:
    c = service.__dict__.get("_overlay_cache")
    if c is None:
        c = service.__dict__.setdefault("_overlay_cache", OrderedDict())
    return c


def _marks_of(raw: list[dict[str, Any]]) -> list[tuple[Any, ...]]:
    """A saved document's annotations as ``(id, label, onset, duration, channels, confidence)``, in order."""
    out = []
    for a in raw:
        try:
            onset, dur = int(a["onset_sample"]), int(a["duration_samples"])
        except (KeyError, TypeError, ValueError):
            continue
        conf = a.get("confidence")
        out.append((str(a.get("annotation_id") or ""), str(a.get("label") or ""), onset, dur,
                    tuple(str(c) for c in (a.get("channels") or [])),
                    int(conf) if isinstance(conf, int) and not isinstance(conf, bool) else 0))
    out.sort(key=lambda m: (m[2], m[3], m[1], m[0]))
    return out


def _read(service: StudyService, key: tuple[Any, ...], files: Callable[[], dict[str, bytes]]) -> list[tuple[Any, ...]]:
    from electrotag.web.corrections import _document, wire_annotations

    cache = _cache(service)
    with _lock:
        got = cache.get(key)
        if got is not None:
            cache.move_to_end(key)
            return got
    doc, _raw = _document(files())
    marks = _marks_of(wire_annotations(doc))
    with _lock:
        cache[key] = marks
        while len(cache) > CACHE_SIZE:
            cache.popitem(last=False)
    return marks


def _saved_people(service: StudyService, rid: str, mode: str, ctx: str) -> list[dict[str, Any]]:
    """Each person's latest saved version of the recording (in this mode and context), with its marks."""
    store = service.store
    by: dict[str, list[dict[str, Any]]] = {}
    for e in store.completion_entries(None):
        if (e.get("recording_id") == rid and e.get("mode", "standard") == mode and e.get("status") == "completed"
                and (mode == "standard" or e.get("context", "") == ctx)):
            by.setdefault(str(e.get("annotator_id")), []).append(e)
    out = []
    for aid, rows in by.items():
        last = latest_entry(rows)
        n = attempt_of(last)
        key = ("saved", aid, rid, mode, ctx, n, str(last.get("completed_at") or ""),
               str(last.get("output_basename") or ""))
        marks = _read(service, key, lambda a=aid, k=n: store.saved_files(a, rid, mode, ctx, k))
        out.append({"annotator_id": aid, "attempt": n, "saved_at": last.get("completed_at") or None, "marks": marks})
    return out


def _derived_people(service: StudyService, rid: str, saved: list[dict[str, Any]], include: set[str],
                    names: dict[str, str]) -> list[dict[str, Any]]:
    from electrotag.web.corrections import corrections_of

    store = service.store
    out: list[dict[str, Any]] = []
    if "corrected" in include:
        for p in saved:
            for rec in corrections_of(service, p["annotator_id"], rid, p["attempt"]):
                n = int(rec.get("number") or 0)
                key = ("corrections", p["annotator_id"], rid, n, str(rec.get("correction_id") or ""))
                marks = _read(service, key,
                              lambda a=p["annotator_id"], k=n: store.derived_files("corrections", a, rid, k))
                by = str(rec.get("corrector_id") or "")
                out.append({"annotator_id": f"{p['annotator_id']}~{by}", "display_name":
                            f"{p['annotator_id']} corrected by {by}", "source": "corrected", "of": p["annotator_id"],
                            "by": by, "attempt": n, "saved_at": rec.get("corrected_at") or None, "marks": marks})
    if "adjudicated" in include:
        rows = [e for e in store.derived_entries("adjudications", ADJUDICATED)
                if e.get("recording_id") == rid and e.get("status") == "completed"]
        if rows:
            last = max(rows, key=lambda e: (str(e.get("completed_at") or ""), attempt_of(e)))
            n = attempt_of(last)
            key = ("adjudications", rid, n, str(last.get("completed_at") or ""))
            marks = _read(service, key, lambda k=n: store.derived_files("adjudications", ADJUDICATED, rid, k))
            out.append({"annotator_id": ADJUDICATED, "display_name": "The adjudicated version", "source": "adjudicated",
                        "of": None, "by": None, "attempt": n, "saved_at": last.get("completed_at") or None,
                        "marks": marks})
    return out


# ------------------------------------------------------------------ the answer
def ranges_text(indexes: list[int]) -> str:
    """Channel indexes as runs: [0, 1, 2, 3, 7, 9, 10] -> "0-3,7,9-10" (a whole-montage mark: "")."""
    parts: list[str] = []
    run: list[int] = []
    for i in sorted(set(indexes)):
        if run and i == run[-1] + 1:
            run.append(i)
            continue
        if run:
            parts.append(f"{run[0]}-{run[-1]}" if len(run) > 1 else str(run[0]))
        run = [i]
    if run:
        parts.append(f"{run[0]}-{run[-1]}" if len(run) > 1 else str(run[0]))
    return ",".join(parts)


class _Tables:
    """The answer's tables of types and channel sets (each given once, referred to by its index)."""

    def __init__(self, ch_names: list[str]) -> None:
        self.at = {n: i for i, n in enumerate(ch_names)}
        self.labels: list[str] = []
        self._labels: dict[str, int] = {}
        self.sets: list[str] = [""]
        self._sets: dict[str, int] = {"": 0}

    def label(self, name: str) -> int:
        if name not in self._labels:
            self._labels[name] = len(self.labels)
            self.labels.append(name)
        return self._labels[name]

    def channel_set(self, channels: tuple[str, ...]) -> int:
        key = ranges_text([self.at[c] for c in channels if c in self.at])
        if key not in self._sets:
            self._sets[key] = len(self.sets)
            self.sets.append(key)
        return self._sets[key]

    def flat(self, marks: list[tuple[Any, ...]]) -> list[int]:
        """Five whole numbers a mark: type, samples since the previous mark's onset (the first: since the start),
        duration in samples, channel set and confidence (0: none given)."""
        out: list[int] = []
        prev = 0
        for _id, label, onset, dur, channels, conf in marks:
            out += [self.label(label), onset - prev, dur, self.channel_set(channels), conf]
            prev = onset
        return out


def _whole_number(body: dict[str, Any], key: str, default: int, lo: int, hi: int) -> int:
    v = body.get(key, default)
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise _bad(f"{key} must be a whole number from {lo} to {hi}")
    return v


def _target(service: StudyService, user: User, body: dict[str, Any]) -> tuple[str, str, str, dict[str, Any], bool]:
    """The recording asked for, checked against who may see it; the last value is True for an anonymous crowd."""
    from electrotag.web.admin import _rid
    from electrotag.web.replay import teaching_recording

    rid = _rid(body.get("recording_id"))
    mode = body.get("mode") or "standard"
    if mode not in MODES:
        raise _bad(f"mode must be one of {', '.join(MODES)}")
    ctx = str(body.get("context_id") or "") if mode != "standard" else ""
    if mode != "standard" and not ctx:
        raise _bad("context_id is missing: a training recording is shown with its training set")
    anonymous = not user.is_expert
    if anonymous:
        if not service.settings.replay.trainees_see_crowd:
            raise ApiError(403, "forbidden", NOT_SHOWN)
        if not teaching_recording(service, rid, mode, ctx):
            raise ApiError(403, "forbidden", NOT_FOR_TEACHING)
    m = service.store.manifest(service.scope_for(mode, ctx), rid)
    if m is None:
        raise ApiError(404, "unknown_recording", f"{rid} is not a registered recording of this study")
    return rid, mode, ctx, m, anonymous


def _include(body: dict[str, Any]) -> set[str]:
    raw = body.get("include") or []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list) or any(x not in INCLUDE for x in raw):
        raise _bad("include may hold corrected and adjudicated")
    return set(raw)


def _detail(body: dict[str, Any]) -> set[str]:
    from electrotag.web.admin import _aid

    raw = body.get("detail") or []
    if not isinstance(raw, list) or len(raw) > MAX_LANES:
        raise _bad(f"detail is the list of at most {MAX_LANES} people shown in lanes")
    return {x if isinstance(x, str) and (x == ADJUDICATED or "~" in x) else _aid(x, "detail") for x in raw}


def _facets(service: StudyService, aids: list[str]) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    described: list[dict[str, Any]] = []
    of: dict[str, dict[str, Any]] = {a: {} for a in aids}
    for key, (title, fn) in sorted(FACETS.items()):
        got = fn(service, list(aids)) or {}
        values: set[str] = set()
        for aid in aids:
            v = got.get(aid)
            if v is None or v == "" or v == []:
                continue
            v = [str(x) for x in v] if isinstance(v, (list, tuple)) else str(v)
            of[aid][key] = v
            values.update(v if isinstance(v, list) else [v])
        described.append({"key": key, "title": title, "values": sorted(values)})
    return described, of


@expert_op("overlay_get", open_to_all=True)
def overlay_get(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """Everyone's latest saved marks on one recording, compactly, with the crowd's counts (the module docstring)."""
    rid, mode, ctx, m, anonymous = _target(service, user, body)
    include = set() if anonymous else _include(body)
    detail = set() if anonymous else _detail(body)
    offset = _whole_number(body, "offset", 0, 0, 10 ** 6)
    limit = _whole_number(body, "limit", MAX_PAGE, 1, MAX_PAGE)
    ch_names = [str(c) for c in m.get("ch_names") or []]
    sfreq = float(m["timing"]["sfreq"])
    n_samples = int(m["timing"]["n_samples"])
    saved = _saved_people(service, rid, mode, ctx)
    records = {u["annotator_id"]: u for u in service.store.user_records()}
    names = {a: str(r.get("display_name") or "") for a, r in records.items()}
    if anonymous:  # in the order they were saved, numbered: nobody is named
        saved.sort(key=lambda p: (str(p["saved_at"] or ""), p["annotator_id"]))
    else:
        saved.sort(key=lambda p: p["annotator_id"])
    tables = _Tables(ch_names)
    page = saved[offset:offset + limit]
    described, facet_of = ([], {}) if anonymous else _facets(service, [p["annotator_id"] for p in saved])
    people = []
    for i, p in enumerate(page, start=offset + 1):
        aid = p["annotator_id"]
        rec = records.get(aid) or {}
        out = {"annotator_id": f"Person {i}" if anonymous else aid,
               "display_name": "" if anonymous else names.get(aid, ""),
               "roles": [] if anonymous else list(parse_roles(rec.get("roles") or rec.get("role"))),
               "you": aid == user.annotator_id, "source": "saved", "of": None, "by": None, "attempt": p["attempt"],
               "saved_at": p["saved_at"], "n_marks": len(p["marks"]), "facets": facet_of.get(aid, {}),
               "marks": tables.flat(p["marks"])}
        if aid in detail:
            out["ids"] = [mk[0] for mk in p["marks"]]
        people.append(out)
    derived = []
    if include and offset == 0:
        for d in _derived_people(service, rid, saved, include, names):
            out = {**{k: d[k] for k in ("annotator_id", "display_name", "source", "of", "by", "attempt", "saved_at")},
                   "roles": [], "you": False, "n_marks": len(d["marks"]), "facets": {},
                   "marks": tables.flat(d["marks"])}
            if d["annotator_id"] in detail:
                out["ids"] = [mk[0] for mk in d["marks"]]
            derived.append(out)
    crowd = None
    if offset == 0:
        crowd = crowd_counts([[(mk[2], mk[3], not mk[4]) for mk in p["marks"]] for p in saved], n_samples, sfreq)
    nxt = offset + limit if offset + limit < len(saved) else None
    return {"recording_id": rid, "file_name": m.get("file_name", ""), "mode": mode, "context_id": ctx,
            "manifest": service.public_manifest(m), "sfreq": sfreq, "n_samples": n_samples, "channels": ch_names,
            "anonymous": anonymous, "labels": tables.labels, "sets": tables.sets, "people": people, "derived": derived,
            "facets": described, "crowd": crowd, "total": len(saved), "offset": offset, "next_offset": nxt}


@expert_op("overlay_teaching_list", open_to_all=True)
def overlay_teaching_list(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """The teaching recordings whose crowd a trainee may see, with how many people saved each (nothing while the
    study's ``replay.trainees_see_crowd`` is off)."""
    from electrotag.training.reference import ReferenceSetError
    from electrotag.web.replay import teaching_recording

    shown = bool(service.settings.replay.trainees_see_crowd)
    out: list[dict[str, Any]] = []
    if shown:
        counts: dict[tuple[str, str, str], set[str]] = {}
        for e in service.store.completion_entries(None):
            mode = e.get("mode", "standard")
            if mode != "standard" and e.get("status") == "completed":
                counts.setdefault((str(e.get("recording_id")), mode, str(e.get("context", ""))), set()).add(
                    str(e.get("annotator_id")))
        for (rid, mode, ctx), who in sorted(counts.items()):
            if not teaching_recording(service, rid, mode, ctx):
                continue
            try:
                m = service.store.manifest(set_scope(service.store.reference_set(ctx).set_id), rid)
            except ReferenceSetError:
                m = None
            if m is None:
                continue
            out.append({"recording_id": rid, "file_name": m.get("file_name", ""), "mode": mode, "context_id": ctx,
                        "n_people": len(who), "yours": user.annotator_id in who})
    out.sort(key=lambda r: (r["file_name"], r["mode"], r["context_id"]))
    return {"shown": shown, "recordings": out}


__all__ = ["FACETS", "MAX_LANES", "MAX_PAGE", "bin_seconds", "crowd_counts", "overlay_get", "overlay_teaching_list",
           "ranges_text", "register_facet"]
