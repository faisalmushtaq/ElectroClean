"""The library of contradictory annotations (docs/web/api.md, "Adjudication and the library").

The library is derived, never stored: each call recomputes the conflicts of every unit that has some
(:mod:`electrotag.web.adjudication`), from the frozen inputs of its adjudication when it has one and
from the current versions while it waits, and attaches the decisions stored. An entry is one
conflict: where it is, its kinds, the types involved (with the confused pair, such as an eye blink
against an eye movement), each person's mark, and its status: ``awaiting`` (nobody adjudicates the
unit yet), ``open`` (adjudication started, this conflict not decided) or ``decided``.

A decided entry can be promoted to a quiz item or an artifact snippet of a reference set
(:func:`library_promote`; an undecided one is refused with 409 ``undecided``): the item keeps
``source: {"library_entry", "task_id", "conflict_id", "promote_id", "promoted_by", "promoted_at"}``,
and the same entry promoted to the same set again, or the same ``promote_id`` sent twice, gives the
item already made. Each entry lists where it was promoted (``promoted``), found from those sources.
Nothing else is stored.
"""

from __future__ import annotations

import copy
import re
from typing import TYPE_CHECKING, Any

from electrotag.app.common import now_local_iso
from electrotag.web import audit
from electrotag.web.errors import ApiError
from electrotag.web.expert import expert_op
from electrotag.web.store import User

if TYPE_CHECKING:
    from electrotag.web.service import StudyService

ENTRY_STATUSES = ("awaiting", "open", "decided")
PROMOTE_TO = ("quiz_item", "snippet")
PROMOTE_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_LIMIT = 500
MAX_EXPLANATION = 2000
#: The columns of library/library.tsv (docs/file_formats.md).
LIBRARY_COLUMNS = ("entry_id", "unit_id", "unit_kind", "recording_id", "status", "kinds", "labels", "pair",
                   "onset_s", "offset_s", "letters", "people", "missing", "choice", "kept_annotator_ids", "kept_labels",
                   "reason_code", "reason", "adjudicator_id", "decided_at", "promoted")


def _bad(message: str, code: str = "bad_request") -> ApiError:
    return ApiError(400, code, message)


def entries(service: StudyService, user: User) -> list[dict[str, Any]]:
    """Every library entry, in the order of the recordings and of time within each."""
    from electrotag.web.adjudication import _records, compare, conflict_out, units

    records = _records(service)
    promoted = _promoted(service)
    out: list[dict[str, Any]] = []
    for u in units(service):
        rec = records.get(u.unit_id)
        if rec is None and not u.complete:
            continue
        try:
            cmp = compare(service, u, rec)
        except ApiError:
            continue
        decisions = dict((rec or {}).get("decisions") or {})
        sfreq = float(cmp.manifest["timing"]["sfreq"])
        window = (rec or {}).get("window")
        if window is None and u.window is not None:
            window = {"start_sample": u.window[0], "end_sample": u.window[1],
                      "start_s": round(u.window[0] / sfreq, 6), "end_s": round(u.window[1] / sfreq, 6)}
        for c in cmp.conflicts:
            co = conflict_out(service, c, decisions.get(c.cluster_id), cmp)
            d = co["decision"]
            out.append({
                "entry_id": f"{u.unit_id}:{c.cluster_id}", "task_id": u.unit_id, "unit_id": u.unit_id,
                "unit_kind": u.kind, "conflict_id": c.cluster_id, "recording_id": u.recording_id,
                "file_name": cmp.manifest.get("file_name", ""), "window": window, "kinds": co["kinds"],
                "labels": co["labels"], "pair": co["pair"], "onset_s": co["onset_s"], "offset_s": co["offset_s"],
                "onset_sample": co["onset_sample"], "offset_sample": co["offset_sample"], "marks": co["marks"],
                "missing": co["missing"], "missing_ids": co["missing_ids"],
                "annotators": sorted(cmp.letters), "letters": dict(cmp.letters),
                "status": "awaiting" if rec is None else ("decided" if d is not None else "open"),
                "decision": d, "adjudicator_id": (rec or {}).get("adjudicator_id"),
                "finished": bool(rec) and rec.get("state") == "finished",
                "promoted": promoted.get(f"{u.unit_id}:{c.cluster_id}", []),
            })
    return out


def _promoted(service: StudyService) -> dict[str, list[dict[str, str]]]:
    """Where each entry was promoted: entry ID -> [{"set_id", "to", "id"}], from the sources of the reference sets'
    quiz items and snippets."""
    out: dict[str, list[dict[str, str]]] = {}
    for rs in service.store.reference_sets():
        for it in rs.quiz_items:
            eid = (it.source or {}).get("library_entry")
            if eid:
                out.setdefault(str(eid), []).append({"set_id": rs.set_id, "to": "quiz_item", "id": it.item_id})
        for sn in rs.snippets:
            eid = (sn.get("source") or {}).get("library_entry")
            if eid:
                out.setdefault(str(eid), []).append({"set_id": rs.set_id, "to": "snippet",
                                                     "id": str(sn.get("snippet_id"))})
    return out


def kept_people(e: dict[str, Any]) -> list[str]:
    """Whose marks a decided entry kept (one person's, everyone's, the marks picked; none for ``none`` and for the
    adjudicator's own marks)."""
    d = e.get("decision") or {}
    choice = d.get("choice")
    marks = e.get("marks") or []
    if choice == "all":
        return sorted({m["annotator_id"] for m in marks})
    if choice == "pick":
        picked = {(p.get("letter"), p.get("annotation_id")) for p in d.get("picks") or []}
        return sorted({m["annotator_id"] for m in marks if (m["letter"], m["annotation_id"]) in picked})
    return sorted({m["annotator_id"] for m in marks if m["letter"] == choice})


def _kept_labels(e: dict[str, Any]) -> list[str]:
    d = e.get("decision")
    return sorted({a["label"] for a in (d or {}).get("result") or []})


def _choice_of(e: dict[str, Any]) -> str | None:
    """The decision in words the filters use: ``one`` (one person's marks), ``all``, ``none``, ``edited``."""
    d = e.get("decision")
    if not d:
        return None
    c = d.get("choice")
    return c if c in ("all", "none", "pick", "edited") else "one"


def _pair_key(pair: Any) -> str:
    return " | ".join(pair) if pair else ""


def _matches(e: dict[str, Any], f: dict[str, Any]) -> bool:
    if f.get("label") and f["label"] not in e["labels"] and f["label"] not in _kept_labels(e):
        return False
    if f.get("pair") and _pair_key(e.get("pair")) != _pair_key(sorted(f["pair"])):
        return False
    if f.get("annotator_id") and f["annotator_id"] not in e["annotators"]:
        return False
    if f.get("status") and e["status"] != f["status"]:
        return False
    if f.get("choice"):
        want = f["choice"]
        got = _choice_of(e)
        raw = (e.get("decision") or {}).get("choice")
        if not (got == want or (raw is not None and raw == want)):
            return False
    if f.get("kind") and f["kind"] not in e["kinds"]:
        return False
    if f.get("recording_id") and e["recording_id"] != f["recording_id"]:
        return False
    if f.get("q"):
        q = f["q"].lower()
        d = e.get("decision") or {}
        text = " ".join([e["file_name"], e["recording_id"], *e["labels"], str(d.get("reason") or ""),
                         str(d.get("reason_code") or "").replace("_", " ")]).lower()
        if q not in text:
            return False
    return True


def _facets(rows: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    f: dict[str, dict[str, int]] = {"labels": {}, "pairs": {}, "kinds": {}, "choices": {}, "status": {},
                                    "annotators": {}, "recordings": {}}

    def add(group: str, key: str | None) -> None:
        if key:
            f[group][key] = f[group].get(key, 0) + 1

    for e in rows:
        for lab in e["labels"]:
            add("labels", lab)
        add("pairs", _pair_key(e.get("pair")))
        for k in e["kinds"]:
            add("kinds", k)
        add("choices", _choice_of(e))
        add("status", e["status"])
        for a in e["annotators"]:
            add("annotators", a)
        add("recordings", e["recording_id"])
    return {k: dict(sorted(v.items(), key=lambda kv: (-kv[1], kv[0]))) for k, v in f.items()}


def _filters(body: dict[str, Any]) -> dict[str, Any]:
    from electrotag.reliability.conflicts import KINDS

    f: dict[str, Any] = {}
    for key in ("label", "annotator_id", "recording_id", "q"):
        v = body.get(key)
        if v is None or v == "":
            continue
        if not isinstance(v, str) or len(v) > 512:
            raise _bad(f"{key} must be text")
        f[key] = v.strip()
    pair = body.get("pair")
    if pair is not None:
        if isinstance(pair, str):
            pair = [p.strip() for p in pair.split("|")]
        if not isinstance(pair, list) or len(pair) != 2 or not all(isinstance(p, str) and p for p in pair):
            raise _bad("pair must be two artifact types")
        f["pair"] = pair
    status = body.get("status")
    if status is not None:
        if status not in ENTRY_STATUSES:
            raise _bad(f"status must be one of {', '.join(ENTRY_STATUSES)}")
        f["status"] = status
    choice = body.get("choice")
    if choice is not None:
        if not isinstance(choice, str) or not re.match(r"^(one|all|none|pick|edited|[A-F])$", choice):
            raise _bad("choice must be one, all, none, pick, edited or a letter")
        f["choice"] = choice
    kind = body.get("kind")
    if kind is not None:
        if kind not in KINDS:
            raise _bad(f"kind must be one of {', '.join(KINDS)}")
        f["kind"] = kind
    return f


def _int(body: dict[str, Any], key: str, default: int, high: int) -> int:
    v = body.get(key, default)
    if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= high:
        raise _bad(f"{key} must be a whole number from 0 to {high}")
    return v


@expert_op("library_list")
def library_list(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """The library, filtered: ``{"entries", "total", "facets"}`` (the facets count every entry)."""
    f = _filters(body)
    offset = _int(body, "offset", 0, 1_000_000)
    limit = _int(body, "limit", 200, MAX_LIMIT)
    rows = entries(service, user)
    kept = [e for e in rows if _matches(e, f)]
    sets = [{"set_id": rs.set_id, "name": rs.name or rs.set_id, "none_option": bool(rs.quiz.get("include_none_option"))}
            for rs in sorted(service.store.reference_sets(), key=lambda r: r.set_id)]
    return {"entries": kept[offset:offset + limit], "total": len(kept), "facets": _facets(rows),
            "filters": dict(f), "sets": sets}


def library_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The entries as rows of library/library.tsv."""
    out = []
    for e in rows:
        d = e.get("decision") or {}
        out.append({"entry_id": e["entry_id"], "unit_id": e["unit_id"], "unit_kind": e["unit_kind"],
                    "recording_id": e["recording_id"], "status": e["status"], "kinds": e["kinds"],
                    "labels": e["labels"], "pair": _pair_key(e.get("pair")), "onset_s": e["onset_s"],
                    "offset_s": e["offset_s"],
                    "letters": [f"{x}={p}" for p, x in sorted((e.get("letters") or {}).items(), key=lambda kv: kv[1])],
                    "people": sorted({m["annotator_id"] for m in e["marks"]}),
                    "missing": e["missing_ids"], "choice": d.get("choice"),
                    "kept_annotator_ids": kept_people(e) if d else None, "kept_labels": _kept_labels(e),
                    "reason_code": d.get("reason_code"), "reason": d.get("reason"),
                    "adjudicator_id": e.get("adjudicator_id"), "decided_at": d.get("decided_at"),
                    "promoted": [f"{p['set_id']}/{p['id']}" for p in e.get("promoted") or []]})
    return out


# ------------------------------------------------------------------ promoting an entry
def _number(body: dict[str, Any], key: str, low: float, high: float, default: float) -> float:
    import math

    v = body.get(key, default)
    if v is None:
        v = default
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not low <= v <= high:
        raise _bad(f"{key} must be a number from {low:g} to {high:g}")
    return float(v)


def _default_explanation(e: dict[str, Any]) -> str:
    from electrotag.web.adjudication import REASON_WORDS

    d = e.get("decision") or {}
    kinds = " and ".join({"presence": "whether there is an artifact", "type": "its type", "timing": "its start and end",
                          "channels": "its channels", "split": "how many marks it is"}[k] for k in e["kinds"])
    said = d.get("reason") or REASON_WORDS.get(str(d.get("reason_code")), "")
    text = f"Annotators disagreed on {kinds}."
    if said:
        text += f" The adjudicator's reason: {said}."
    return text[:MAX_EXPLANATION]


def _existing(rs: Any, to: str, promote_id: str, entry_id: str) -> dict[str, Any] | None:
    items = [it.to_dict() for it in rs.quiz_items] if to == "quiz_item" else list(rs.snippets)
    for it in items:
        src = it.get("source") or {}
        if src.get("promote_id") == promote_id or src.get("library_entry") == entry_id:
            return it
    return None


@expert_op("library_promote")
def library_promote(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """An entry as a quiz item or an artifact snippet of a reference set, with its provenance; idempotent."""
    from electrotag.training.reference import NONE_OPTION, QuizItem, ReferenceSetError
    from electrotag.web.manifest import SCOPE_STUDY, fingerprint_of

    pid = body.get("promote_id")
    if not isinstance(pid, str) or not PROMOTE_RE.match(pid):
        raise _bad("promote_id must be 32 hexadecimal characters")
    to = body.get("to")
    if to not in PROMOTE_TO:
        raise _bad("to must be quiz_item or snippet")
    eid = body.get("entry_id")
    if not isinstance(eid, str) or ":" not in eid:
        raise _bad("entry_id is missing")
    admin = service.administration
    rs0 = admin._set(body.get("set_id"))
    found = _existing(rs0, to, pid, eid)
    if found is not None:
        return {("item" if to == "quiz_item" else "snippet"): found, "already": True}
    entry = next((e for e in entries(service, user) if e["entry_id"] == eid), None)
    if entry is None:
        raise ApiError(404, "unknown_entry", "This entry is no longer in the library.")
    d = entry.get("decision")
    if d is None:
        raise ApiError(409, "undecided", "This conflict has not been decided yet, so it cannot teach anything: "
                       "promote it once it is decided.")
    kept = d.get("result") or []
    label = body.get("label")
    if label is None:
        labels = sorted({a["label"] for a in kept})
        label = labels[0] if len(labels) == 1 else (NONE_OPTION if not kept else None)
        if label is None:
            raise _bad("The decision keeps marks of several types: choose the label of the item")
    cat = service.store.catalogue
    if not isinstance(label, str) or not (cat.is_permitted(label) or (label == NONE_OPTION and to == "quiz_item")):
        raise _bad("label must be one of the catalogue's artifact types")
    m = service.store.manifest(SCOPE_STUDY, entry["recording_id"])
    if m is None:
        raise ApiError(404, "unknown_recording", f"{entry['recording_id']} is no longer one of the study's recordings")
    duration = float(m["timing"]["n_samples"]) / float(m["timing"]["sfreq"])
    if kept:
        t0, t1 = min(a["onset_s"] for a in kept), max(a["offset_s"] for a in kept)
    else:
        t0, t1 = entry["onset_s"], entry["offset_s"]
    start = _number(body, "start_s", 0, duration, t0)
    end = _number(body, "end_s", 0, duration, t1)
    if end <= start:
        raise _bad("end_s must be after start_s")
    context = _number(body, "context_s", 0, 60, 2.0)
    explanation = body.get("explanation")
    if explanation is None:
        explanation = _default_explanation(entry)
    if not isinstance(explanation, str) or len(explanation) > MAX_EXPLANATION:
        raise _bad(f"explanation must be text of at most {MAX_EXPLANATION} characters")
    explanation = explanation.strip()
    source = {"library_entry": eid, "task_id": entry["unit_id"], "conflict_id": entry["conflict_id"],
              "promote_id": pid, "promoted_by": user.annotator_id, "promoted_at": now_local_iso(),
              "kinds": entry["kinds"], "decision": d.get("choice")}
    rid = entry["recording_id"]
    # never from a recording whose answers trainees are scored against (electrotag/web/training_path.py)
    service.training_path.refuse_if_revealing(rs0, rid, "a quiz item" if to == "quiz_item" else "a snippet",
                                              scope=SCOPE_STUDY)
    target = admin._set_scope(rs0)
    if target != SCOPE_STUDY:  # a self-contained set: the recording's manifest is copied in, as set_add_reference does
        existing = service.store.manifest(target, rid)
        if existing is not None and fingerprint_of(existing) != fingerprint_of(m):
            raise ApiError(409, "conflict", f"The set already holds a different recording called {rid}")
        if existing is None:
            copied = copy.deepcopy(m)
            copied["scope"] = target
            copied["registration"] = {**dict(m.get("registration") or {}), "registered_at": now_local_iso(),
                                      "registered_by": user.annotator_id, "copied_from": SCOPE_STUDY, "retired": False}
            service.store.add_manifest(copied)
    with admin._editing(rs0.set_id) as rs:
        again = _existing(rs, to, pid, eid)
        if again is not None:
            return {("item" if to == "quiz_item" else "snippet"): again, "already": True}
        if to == "quiz_item":
            have = {it.item_id for it in rs.quiz_items}
            n = len(have) + 1
            while f"q{n:02d}" in have:
                n += 1
            item = QuizItem(f"q{n:02d}", rid, round(start, 6), round(end, 6), label, [], explanation, context,
                            source=source)
            try:
                rs.add_quiz_item(item, cat.label_names)
            except ReferenceSetError as exc:
                raise _bad(str(exc)) from exc
            made = item.to_dict()
        else:
            have = {str(s.get("snippet_id")) for s in rs.snippets}
            n = len(have) + 1
            while f"s{n:02d}" in have:
                n += 1
            made = {"snippet_id": f"s{n:02d}", "recording_id": rid, "start_s": round(start, 6), "end_s": round(end, 6),
                    "label": label, "explanation": explanation, "context_s": context, "source": source}
            try:
                rs.add_snippet(made)
            except ReferenceSetError as exc:
                raise _bad(str(exc)) from exc
    what = "quiz item" if to == "quiz_item" else "snippet"
    audit.record(service.store, user.annotator_id, "library_promote",
                 f"Made {what} {made.get('item_id') or made.get('snippet_id')} of {rs0.set_id} from a conflict in "
                 f"{rid} ({label}, {start:g} to {end:g} s)",
                 {"set_id": rs0.set_id, "to": to, "entry_id": eid, "promote_id": pid, "recording_id": rid,
                  "label": label, "start_s": start, "end_s": end, "explanation_length": len(explanation)})
    return {("item" if to == "quiz_item" else "snippet"): made, "already": False}


__all__ = ["ENTRY_STATUSES", "LIBRARY_COLUMNS", "PROMOTE_TO", "entries", "kept_people", "library_list",
           "library_promote", "library_rows"]
