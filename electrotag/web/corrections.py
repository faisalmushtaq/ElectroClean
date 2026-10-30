"""Experts' corrections of saved work (docs/web/api.md, "Corrections and replay").

An expert opens someone's saved attempt of a study recording, changes and adds to its annotations
and gives a reason for each change; ``correction_save`` keeps the result as a **derived version**:
the journalled save (the five files, written, read back and verified) into
``Annotated_Events/derived/corrections/`` with its own completion register (``Store.save_derived``),
with the provenance in ``context.derived``. The original files never change, and a correction is
never anyone's attempt, completion or time.

**The difference.** :func:`diff_annotations` compares the original and the corrected annotations by
``annotation_id`` (the corrected version keeps the IDs of the marks it changes): each change is
``added``, ``removed`` or ``changed`` with the fields that changed. The browser's
``js/expert/diff.js`` is the same function; ``web_tests/unit/correction_diff_cases.json`` holds the
cases both are tested with. The server works the difference out itself and never trusts the
browser's list; the browser sends a reason (and an optional note) for each change, which the study's
``review.reason_required`` asks for: ``always`` every change, ``edited_or_none`` the changed and
removed marks, ``never`` none.

**Kept once.** The browser makes the correction's ID (32 hexadecimal characters) on the first press
of Submit and sends the same ID again after an answer that came too late. A ``pending`` record is
written first, then the derived register is checked for that ID (it is the saved version's
``session_id``) before anything is saved, and the record is marked ``saved`` last, so that a request
sent twice, or one that stopped half-way, saves one version.

**Two corrections of the same work.** When a second expert corrects the same saved attempt, both
corrections are kept and each says how many there are (``n_corrections_of_version``); comparing
them, as independent annotations whose disagreements are adjudicated, belongs to the adjudication
(:func:`corrections_of` is what it reads). An expert who corrects the same attempt again replaces
their own earlier correction for that purpose (the latest of each expert counts).

**Feedback.** When the study shows corrections to its annotators
(``review.show_corrections_to_annotators``), ``GET /me/feedback`` lists the corrections of the
caller's work with each change and its reason, and the open operation ``my_correction_get`` gives the
annotations to show one beside the original.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import secrets
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from electrotag.app.common import now_local_iso
from electrotag.web import audit
from electrotag.web.errors import ApiError
from electrotag.web.expert import expert_op, feedback_part
from electrotag.web.manifest import SCOPE_STUDY
from electrotag.web.store import User, attempt_of, latest_entry

if TYPE_CHECKING:
    from electrotag.web.service import StudyService

#: Why a mark was changed, in the words of the correction view's chips.
REASONS = {
    "missed": "Missed artifact",
    "not_artifact": "Not an artifact",
    "wrong_type": "Wrong type",
    "boundaries": "Start or end",
    "channels": "Channels",
    "split_merge": "Should be split or merged",
    "other": "Other",
}
#: What can differ between an original mark and its corrected version.
FIELDS = ("label", "onset", "end", "channels", "confidence", "note")
CHANGES = ("added", "removed", "changed")
REASON_RULES = ("always", "edited_or_none", "never")
MAX_NOTE = 300
MAX_OVERALL_NOTE = 1000
ID_RE = re.compile(r"^[0-9a-f]{32}$")
#: A pending correction older than this (seconds) is taken over by the next request with its ID.
PENDING_STALE_S = 300.0
ANN_KEYS = ("annotation_id", "label", "onset_sample", "duration_samples", "channels", "confidence", "note")


def _bad(message: str, code: str = "bad_request", status: int = 400) -> ApiError:
    return ApiError(status, code, message)


# ------------------------------------------------------------------ the difference
def mark(a: dict[str, Any]) -> dict[str, Any]:
    """An annotation as the difference compares it (the browser's Annotation, without its times)."""
    conf = a.get("confidence")
    return {"annotation_id": str(a.get("annotation_id") or ""), "label": str(a.get("label") or ""),
            "onset_sample": int(a.get("onset_sample") or 0), "duration_samples": int(a.get("duration_samples") or 0),
            "channels": [str(c) for c in (a.get("channels") or [])],
            "confidence": conf if isinstance(conf, int) and not isinstance(conf, bool) else None,
            "note": str(a.get("note") or "")}


def changed_fields(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    """The fields of FIELDS in which two versions of one mark differ (channels as a set)."""
    out = []
    if before["label"] != after["label"]:
        out.append("label")
    if before["onset_sample"] != after["onset_sample"]:
        out.append("onset")
    if before["onset_sample"] + before["duration_samples"] != after["onset_sample"] + after["duration_samples"]:
        out.append("end")
    if set(before["channels"]) != set(after["channels"]):
        out.append("channels")
    if before["confidence"] != after["confidence"]:
        out.append("confidence")
    if before["note"] != after["note"]:
        out.append("note")
    return out


def diff_annotations(original: list[dict[str, Any]], current: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """What changed from ``original`` to ``current``, matched by ``annotation_id``: one entry per mark added,
    removed or changed (``{"annotation_id", "change", "fields", "before", "after"}``), in the order of the
    recording (the start of the mark as it is now, or as it was for a removed one), then by ID."""
    before = {m["annotation_id"]: m for m in (mark(a) for a in original)}
    after = {m["annotation_id"]: m for m in (mark(a) for a in current)}
    out: list[dict[str, Any]] = []
    for aid, b in before.items():
        if aid not in after:
            out.append({"annotation_id": aid, "change": "removed", "fields": [], "before": b, "after": None})
    for aid, a in after.items():
        if aid not in before:
            out.append({"annotation_id": aid, "change": "added", "fields": [], "before": None, "after": a})
            continue
        fields = changed_fields(before[aid], a)
        if fields:
            out.append({"annotation_id": aid, "change": "changed", "fields": fields, "before": before[aid], "after": a})

    def where(c: dict[str, Any]) -> tuple[int, int, str]:
        m = c["after"] or c["before"]
        return (m["onset_sample"], m["onset_sample"] + m["duration_samples"], c["annotation_id"])

    return sorted(out, key=where)


def needs_reason(change: str, rule: str) -> bool:
    """Whether a change of this kind needs a reason under the study's ``review.reason_required``."""
    if rule == "never":
        return False
    if rule == "edited_or_none":
        return change in ("changed", "removed")
    return True


def change_counts(changes: list[dict[str, Any]]) -> dict[str, int]:
    out = {k: 0 for k in CHANGES}
    for c in changes:
        out[c["change"]] = out.get(c["change"], 0) + 1
    return out


def counts_text(counts: dict[str, int]) -> str:
    """``2 added, 1 removed, 1 changed`` (nothing for none), or ``no changes``."""
    parts = [f"{int(counts.get(k) or 0)} {k}" for k in CHANGES if int(counts.get(k) or 0)]
    return ", ".join(parts) or "no changes"


# ------------------------------------------------------------------ reading saved work
def _latest_entry(service: StudyService, aid: str, rid: str) -> dict[str, Any] | None:
    mine = [e for e in service.store.completion_entries(aid) if e.get("recording_id") == rid
            and e.get("mode", "standard") == "standard" and e.get("status") == "completed"]
    return latest_entry(mine) if mine else None


def _entries(service: StudyService, aid: str, rid: str) -> list[dict[str, Any]]:
    return sorted((e for e in service.store.completion_entries(aid) if e.get("recording_id") == rid
                   and e.get("mode", "standard") == "standard" and e.get("status") == "completed"), key=attempt_of)


def _document(files: dict[str, bytes]) -> tuple[dict[str, Any] | None, bytes | None]:
    raw = next((b for n, b in sorted(files.items()) if n.endswith("_annotations.json")), None)
    if raw is None:
        return None, None
    try:
        return json.loads(raw), raw
    except ValueError:
        return None, raw


def wire_annotations(doc: dict[str, Any] | None) -> list[dict[str, Any]]:
    """A saved document's annotations as the browser's Annotations."""
    keys = ("annotation_id", "label", "onset_sample", "duration_samples", "channels", "created_at", "modified_at",
            "confidence", "note")
    defaults: dict[str, Any] = {"channels": [], "confidence": None, "note": ""}
    return [{k: a.get(k, defaults.get(k, "")) for k in keys}
            for a in (doc or {}).get("annotations", []) if isinstance(a, dict)]


def saved_attempt(service: StudyService, aid: str, rid: str, attempt: int | None) -> tuple[dict[str, Any],
                                                                                           list[dict[str, Any]], bytes]:
    """The register row, annotations and ``_annotations.json`` of one saved attempt (the latest by default)."""
    entries = _entries(service, aid, rid)
    entry = next((e for e in entries if attempt_of(e) == attempt), None) if attempt is not None else (
        latest_entry(entries) if entries else None)
    if entry is None:
        raise ApiError(404, "no_saved_annotations", f"{aid} has not saved {rid}"
                       + (f" as version {attempt}" if attempt is not None and entries else "")
                       + ", so there is nothing to correct.")
    doc, raw = _document(service.store.saved_files(aid, rid, "standard", "", attempt_of(entry)))
    if raw is None:
        raise ApiError(404, "no_saved_annotations", f"The saved files of {aid}'s {rid} cannot be read.")
    return entry, wire_annotations(doc), raw


def _whole(value: Any, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise _bad(f"{what} must be a whole number")
    return value


def _target(service: StudyService, body: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    from electrotag.web.admin import _aid, _rid

    aid = _aid(body.get("annotator_id"))
    rid = _rid(body.get("recording_id"))
    if (body.get("mode") or "standard") != "standard":
        raise ApiError(409, "not_for_training", "Corrections are for the study's own recordings; training "
                       "recordings have their own feedback.")
    m = service.store.manifest(SCOPE_STUDY, rid)
    if m is None:
        raise ApiError(404, "unknown_recording", f"{rid} is not a registered recording of this study")
    return aid, rid, m


def _display_name(service: StudyService, aid: str) -> str:
    rec = service.store.user_record(aid) or {}
    return str(rec.get("display_name") or "")


# ------------------------------------------------------------------ the records
def _saved(service: StudyService, aid: str | None = None) -> list[dict[str, Any]]:
    return [r for r in service.store.records("corrections", aid) if r.get("state") == "saved"]


def corrections_of(service: StudyService, annotator_id: str, recording_id: str, attempt: int | None = None, *,
                   latest_per_corrector: bool = True) -> list[dict[str, Any]]:
    """The saved corrections of one person's saved work on a study recording (of ``attempt``, or of every
    attempt), oldest first, as full records. With ``latest_per_corrector`` (the default) an expert who corrected
    the same attempt more than once counts with their latest correction only. Two or more corrections of one
    attempt by different experts are what the adjudication compares (docs/web/api.md, "Corrections and
    replay")."""
    rows = [r for r in _saved(service, annotator_id) if r.get("recording_id") == recording_id
            and (attempt is None or int((r.get("corrected_from") or {}).get("attempt") or 0) == int(attempt))]
    rows.sort(key=lambda r: (str(r.get("corrected_at") or ""), int(r.get("number") or 0)))
    if not latest_per_corrector:
        return rows
    latest: dict[tuple[int, str], dict[str, Any]] = {}
    for r in rows:
        latest[(int((r.get("corrected_from") or {}).get("attempt") or 0), str(r.get("corrector_id")))] = r
    return [r for r in rows if latest.get((int((r.get("corrected_from") or {}).get("attempt") or 0),
                                           str(r.get("corrector_id")))) is r]


def correction_out(service: StudyService, rec: dict[str, Any], *, for_annotator: bool = False) -> dict[str, Any]:
    """A correction record as the answers give it (``n_corrections_of_version``: how many experts' corrections the
    same saved attempt has, this one included)."""
    keys = ("correction_id", "state", "annotator_id", "recording_id", "file_name", "mode", "context_id",
            "corrected_from", "corrector_id", "corrector_name", "corrected_at", "elapsed_s", "number",
            "output_basename", "session_id", "changes", "counts", "overall_note")
    out = {k: rec.get(k) for k in keys}
    out["summary"] = counts_text(rec.get("counts") or {})
    frm = rec.get("corrected_from") or {}
    same = corrections_of(service, str(rec.get("annotator_id")), str(rec.get("recording_id")),
                          int(frm.get("attempt") or 0))
    out["n_corrections_of_version"] = len(same)
    out["attempt"] = int(frm.get("attempt") or 0)
    if for_annotator:
        for k in ("output_basename", "session_id", "state", "elapsed_s"):
            out.pop(k, None)
        out["corrected_from"] = {"attempt": int(frm.get("attempt") or 0)}
        out["n_corrections_of_version"] = len(same)
    return out


def _changes_text(changes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{**c, "reason_text": REASONS.get(str(c.get("reason") or ""), "")} for c in changes]


# ------------------------------------------------------------------ the operations
@expert_op("work_list")
def work_list(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """The saved study attempts experts may open (the latest of each person and recording), newest first."""
    from electrotag.web.admin import _aid

    aid = _aid(body.get("annotator_id")) if body.get("annotator_id") not in (None, "") else None
    rid = body.get("recording_id") or None
    if rid is not None and not isinstance(rid, str):
        raise _bad("recording_id must be a recording ID")
    corrected = body.get("corrected")
    if corrected is not None and not isinstance(corrected, bool):
        raise _bad("corrected must be true or false")
    limit = body.get("limit", 200)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 1000:
        raise _bad("limit must be a whole number from 1 to 1000")
    entries = [e for e in service.store.completion_entries(aid) if e.get("mode", "standard") == "standard"
               and e.get("status") == "completed" and (rid is None or e.get("recording_id") == rid)]
    by: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for e in entries:
        by.setdefault((str(e.get("annotator_id")), str(e.get("recording_id"))), []).append(e)
    names = {u["annotator_id"]: u.get("display_name", "") for u in service.store.user_records()}
    counts: dict[tuple[str, str, int], int] = {}
    for r in _saved(service, aid):
        key = (str(r.get("annotator_id")), str(r.get("recording_id")),
               int((r.get("corrected_from") or {}).get("attempt") or 0))
        counts[key] = counts.get(key, 0) + 1
    tasks = {(a.annotator_id, a.recording_id): a.task_id for a in service.store.assignments(aid)
             if a.mode == "standard" and a.task_id}
    items = []
    for (a, r), rows in by.items():
        last = latest_entry(rows)
        n = counts.get((a, r, attempt_of(last)), 0)
        if corrected is not None and (n > 0) != corrected:
            continue
        m = service.store.manifest(SCOPE_STUDY, r)
        if m is None:
            continue
        items.append({"annotator_id": a, "display_name": names.get(a, ""), "recording_id": r,
                      "file_name": m.get("file_name", ""), "attempt": attempt_of(last),
                      "saved_at": last.get("completed_at") or None, "n_annotations": _int(last.get("n_annotations")),
                      "corrections": n, "task_id": tasks.get((a, r)) or None, "own": a == user.annotator_id})
    items.sort(key=lambda i: (str(i["saved_at"] or ""), i["annotator_id"], i["recording_id"]), reverse=True)
    return {"items": items[:limit], "total": len(items),
            "corrections_on": bool(service.settings.review.corrections)}


def _int(value: Any) -> int | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return int(out) if math.isfinite(out) else None


@expert_op("saved_attempt_get")
def saved_attempt_get(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """What the correction view needs: one saved attempt (the latest by default) with its manifest, the earlier
    reviews and corrections of it, and the attempts there are."""
    aid, rid, m = _target(service, body)
    attempt = body.get("attempt")
    if attempt is not None:
        attempt = _whole(attempt, "attempt")
    entry, annotations, _raw = saved_attempt(service, aid, rid, attempt)
    entries = _entries(service, aid, rid)
    n = attempt_of(entry)
    review = service.settings.review
    return {"annotator_id": aid, "display_name": _display_name(service, aid), "recording_id": rid,
            "file_name": m.get("file_name", ""), "mode": "standard", "context_id": "", "attempt": n,
            "latest": attempt_of(latest_entry(entries)), "attempts": [attempt_of(e) for e in entries],
            "saved_at": entry.get("completed_at") or None, "manifest": service.public_manifest(m),
            "annotations": annotations,
            "reviews": [service.feedback.review_out(r) for r in service.feedback._reviews(aid, rid)
                        if int(r.get("attempt") or 0) == n],
            "corrections": [correction_out(service, r) for r in corrections_of(service, aid, rid, n,
                                                                                latest_per_corrector=False)],
            "own": aid == user.annotator_id, "corrections_on": bool(review.corrections),
            "reason_required": review.reason_required, "reasons": dict(REASONS)}


def _reasons(raw: Any) -> dict[str, dict[str, str]]:
    if raw is None:
        return {}
    if not isinstance(raw, list) or len(raw) > 20000:
        raise _bad("changes must be a list of {annotation_id, reason, note}")
    out: dict[str, dict[str, str]] = {}
    for i, c in enumerate(raw, start=1):
        if not isinstance(c, dict) or not isinstance(c.get("annotation_id"), str):
            raise _bad(f"Change {i} must name its annotation_id")
        reason = c.get("reason")
        if reason in (None, ""):
            reason = ""
        elif reason not in REASONS:
            raise _bad(f"Change {i}: the reason must be one of {', '.join(REASONS)}")
        note = c.get("note")
        if note is None:
            note = ""
        if not isinstance(note, str) or len(note) > MAX_NOTE:
            raise _bad(f"Change {i}: the note must be text of at most {MAX_NOTE} characters")
        out[c["annotation_id"]] = {"reason": reason, "note": note.strip()}
    return out


def _fresh(when: Any) -> bool:
    try:
        then = datetime.fromisoformat(str(when))
    except ValueError:
        return False
    return datetime.now(then.tzinfo) - then < timedelta(seconds=PENDING_STALE_S)


@expert_op("correction_save")
def correction_save(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """Save a correction of someone's saved attempt as a derived version (see the module docstring)."""
    from electrotag.web.manifest import ManifestRecording, fingerprint_of
    from electrotag.web.saving import WebSession
    from electrotag.web.service import MAX_ELAPSED_S, SHA_RE, _number, _stamp, annotation_dict, parse_annotations

    store = service.store
    cid = body.get("correction_id")
    if not isinstance(cid, str) or not ID_RE.match(cid):
        raise _bad("correction_id must be 32 hexadecimal characters (made by the browser for this correction)")
    kept = next((r for r in store.records("corrections") if r.get("correction_id") == cid), None)
    if kept is not None and kept.get("state") == "saved":  # the same correction sent again: kept once
        if kept.get("corrector_id") != user.annotator_id:
            raise ApiError(409, "conflict", "This correction could not be kept. Please try again.")
        return {"correction": correction_out(service, kept), "already": True, "files": list(kept.get("files") or [])}
    review = service.settings.review
    if not review.corrections:
        raise ApiError(409, "corrections_off", "This study does not take corrections of saved work. The study team "
                       "can switch them on in the study settings.")
    aid, rid, m = _target(service, body)
    if aid == user.annotator_id:
        raise ApiError(409, "own_work", "This is your own saved work. To change it, revise it from your history on "
                       "the home page; corrections are for other people's work.")
    attempt = _whole(body.get("attempt"), "attempt (the version corrected)")
    latest = _latest_entry(service, aid, rid)
    if latest is None:
        raise ApiError(404, "no_saved_annotations", f"{aid} has not saved {rid}, so there is nothing to correct.")
    if attempt != attempt_of(latest):
        raise ApiError(409, "not_latest", f"{aid} has saved {rid} again since you opened it (version "
                       f"{attempt_of(latest)}). Open it again to correct the latest version; your changes to version "
                       f"{attempt} were not saved.")
    entry, original, raw = saved_attempt(service, aid, rid, attempt)
    sha = str(body.get("sha256") or "").lower()
    if not SHA_RE.match(sha):
        raise _bad("sha256 (the checksum of the file the correction was made on) is missing")
    info = body.get("session") if isinstance(body.get("session"), dict) else {}
    elapsed = min(_number(info.get("elapsed_s", 0.0), "session.elapsed_s", minimum=0.0), MAX_ELAPSED_S)
    loaded = ManifestRecording(m)
    reg_sha, _size = fingerprint_of(m)
    if sha == reg_sha:
        loaded.notes.append("Corrected in the browser; the data file's SHA-256 matched the registered recording.")
    else:
        loaded.warnings.append(f"The file the correction was made on (SHA-256 {sha}) is not byte for byte the "
                               f"registered recording (SHA-256 {reg_sha}); its name, sampling rate, length and "
                               "channels matched and the expert confirmed it is the same recording.")
    parsed = parse_annotations(body.get("annotations"), loaded.info, store.catalogue,
                               service.settings.min_duration_samples)
    current = [annotation_dict(a) for a in parsed]
    changes = diff_annotations(original, current)
    if not changes:
        raise ApiError(422, "no_changes", "Nothing has changed from the saved version, so there is no correction to "
                       "save. Change, add or remove a mark first.")
    given = _reasons(body.get("changes"))
    missing = [c["annotation_id"] for c in changes
               if needs_reason(c["change"], review.reason_required)
               and not given.get(c["annotation_id"], {}).get("reason")]
    if missing:
        raise ApiError(422, "reason_missing", f"Give a reason for each change: {len(missing)} "
                       f"{'change has' if len(missing) == 1 else 'changes have'} none yet.", annotation_ids=missing)
    for c in changes:
        g = given.get(c["annotation_id"], {})
        c["reason"] = g.get("reason", "")
        c["note"] = g.get("note", "")
    overall = body.get("overall_note") or ""
    if not isinstance(overall, str) or len(overall) > MAX_OVERALL_NOTE:
        raise _bad(f"overall_note must be text of at most {MAX_OVERALL_NOTE} characters")
    overall = overall.strip()
    counts = change_counts(changes)
    earlier = corrections_of(service, aid, rid, attempt)
    corrected_from = {"annotator_id": aid, "attempt": attempt, "session_id": entry.get("session_id", ""),
                      "output_basename": entry.get("output_basename", ""),
                      "annotations_sha256": hashlib.sha256(raw).hexdigest()}
    claim = secrets.token_hex(8)
    now = now_local_iso()
    took = {"claim": False, "saved": None}

    def take(old: dict[str, Any] | None) -> dict[str, Any] | None:
        if old is not None and old.get("state") == "saved":
            took["saved"] = old
            return None
        if old is not None and old.get("corrector_id") != user.annotator_id:
            return None
        if old is not None and _fresh(old.get("claimed_at")):
            return None  # another request with this ID is saving it now
        took["claim"] = True
        return {"schema": "electrotag.correction", "schema_version": 1, "correction_id": cid, "state": "pending",
                "annotator_id": aid, "recording_id": rid, "file_name": m.get("file_name", ""), "mode": "standard",
                "context_id": "", "corrector_id": user.annotator_id, "corrector_name": user.display_name,
                "corrected_from": corrected_from, "claim": claim, "claimed_at": now, "started_at": now}

    store.update_record("corrections", cid, aid, take)
    if took["saved"] is not None:
        return {"correction": correction_out(service, took["saved"]), "already": True,
                "files": list(took["saved"].get("files") or [])}
    if not took["claim"]:
        raise ApiError(409, "busy", "This correction is being saved by another request; wait a moment, then press "
                       "Submit again.")
    derived = {"kind": "correction", "correction_id": cid, "corrected_from": corrected_from,
               "corrector_id": user.annotator_id, "corrector_name": user.display_name, "changes": changes,
               "overall_note": overall}
    done = next((e for e in store.derived_entries("corrections", aid) if e.get("session_id") == cid
                 and e.get("status") == "completed"), None)
    files: list[str] = []
    if done is None:
        def make_session(layout: Any) -> WebSession:
            s = WebSession(layout=layout, settings=service.settings, filters=service.settings.filters,
                           catalogue=store.catalogue, loaded=loaded, annotator_id=aid,
                           display_name=f"{aid} corrected by {user.annotator_id}", mode="standard",
                           context={"derived": derived}, initial_annotations=parsed, allow_repeat=True,
                           autosave_enabled=False, client={}, server=store.kind, session_id=cid)
            return s

        saved = store.save_derived("corrections", make_session, elapsed_s=elapsed,
                                   started_at=_stamp(info.get("started_at")))
        number, files = saved.attempt, sorted(saved.files)
        done = next((e for e in store.derived_entries("corrections", aid) if e.get("session_id") == cid), None) or {}
    else:
        number = attempt_of(done)
    record = {"schema": "electrotag.correction", "schema_version": 1, "correction_id": cid, "state": "saved",
              "annotator_id": aid, "recording_id": rid, "file_name": m.get("file_name", ""), "mode": "standard",
              "context_id": "", "corrected_from": corrected_from, "corrector_id": user.annotator_id,
              "corrector_name": user.display_name, "corrected_at": now_local_iso(), "elapsed_s": round(elapsed, 3),
              "number": number, "output_basename": done.get("output_basename", ""), "session_id": cid,
              "changes": changes, "counts": counts, "overall_note": overall, "files": files,
              "earlier_corrections": [r["correction_id"] for r in earlier]}
    kept = store.update_record("corrections", cid, aid, lambda old: record) or record
    others = sorted({str(r.get("corrector_id")) for r in earlier} - {user.annotator_id})
    audit.record(store, user.annotator_id, "correction_save",
                 f"Corrected {aid}'s {rid} (version {attempt}): {counts_text(counts)}"
                 + (f"; it was corrected by {', '.join(others)} as well, so the corrections go to adjudication"
                    if others else ""),
                 {"correction_id": cid, "annotator_id": aid, "recording_id": rid, "attempt": attempt,
                  "number": number, "counts": counts, "n_changes": len(changes),
                  "reasons": {k: sum(1 for c in changes if c["reason"] == k) for k in REASONS},
                  "overall_note_length": len(overall), "other_correctors": others})
    return {"correction": correction_out(service, kept), "already": False, "files": files}


@expert_op("corrections_list")
def corrections_list(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """The saved corrections, newest first, of one person's work, one recording or by one corrector."""
    from electrotag.web.admin import _aid

    aid = _aid(body.get("annotator_id")) if body.get("annotator_id") not in (None, "") else None
    by = _aid(body.get("corrector_id"), "corrector_id") if body.get("corrector_id") not in (None, "") else None
    rid = body.get("recording_id") or None
    rows = [r for r in _saved(service, aid) if (rid is None or r.get("recording_id") == rid)
            and (by is None or r.get("corrector_id") == by)]
    rows.sort(key=lambda r: str(r.get("corrected_at") or ""), reverse=True)
    return {"corrections": [correction_out(service, r) for r in rows]}


def _one(service: StudyService, cid: Any) -> dict[str, Any]:
    if not isinstance(cid, str) or not ID_RE.match(cid):
        raise _bad("correction_id must be 32 hexadecimal characters")
    rec = next((r for r in _saved(service) if r.get("correction_id") == cid), None)
    if rec is None:
        raise ApiError(404, "not_found", "This correction was not found in the study.")
    return rec


def _with_versions(service: StudyService, rec: dict[str, Any], *, for_annotator: bool) -> dict[str, Any]:
    aid, rid = str(rec["annotator_id"]), str(rec["recording_id"])
    doc, _raw = _document(service.store.derived_files("corrections", aid, rid, int(rec.get("number") or 0)))
    attempt = int((rec.get("corrected_from") or {}).get("attempt") or 0)
    odoc, _ = _document(service.store.saved_files(aid, rid, "standard", "", attempt))
    m = service.store.manifest(SCOPE_STUDY, rid)
    out = correction_out(service, rec, for_annotator=for_annotator)
    out["changes"] = _changes_text(list(rec.get("changes") or []))
    out.update({"annotations": wire_annotations(doc), "original": wire_annotations(odoc),
                "manifest": service.public_manifest(m) if m is not None else None})
    return out


@expert_op("correction_get")
def correction_get(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """One correction with the corrected annotations, the original ones and the recording's manifest."""
    return _with_versions(service, _one(service, body.get("correction_id")), for_annotator=False)


@expert_op("my_correction_get", open_to_all=True)
def my_correction_get(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """An annotator's view of a correction of their own work (when the study shows corrections to annotators)."""
    if not service.settings.review.show_corrections_to_annotators:
        raise ApiError(403, "forbidden", "This study does not show corrections to its annotators.")
    rec = _one(service, body.get("correction_id"))
    if rec.get("annotator_id") != user.annotator_id:
        raise ApiError(404, "not_found", "This correction was not found in the study.")
    return _with_versions(service, rec, for_annotator=True)


@feedback_part("corrections")
def mine(service: StudyService, user: User) -> list[dict[str, Any]]:
    """``GET /me/feedback``'s corrections: of the caller's saved work, newest first, with the changes and reasons."""
    latest: dict[str, int] = {}
    for e in service.store.completion_entries(user.annotator_id):
        if e.get("mode", "standard") == "standard" and e.get("status") == "completed":
            rid = str(e.get("recording_id"))
            latest[rid] = max(latest.get(rid, 0), attempt_of(e))
    rows = sorted(_saved(service, user.annotator_id), key=lambda r: str(r.get("corrected_at") or ""), reverse=True)
    out = []
    for r in rows:
        item = correction_out(service, r, for_annotator=True)
        item["changes"] = _changes_text(list(r.get("changes") or []))
        item["of_latest"] = item["attempt"] == latest.get(str(r.get("recording_id")), 0)
        out.append(item)
    return out


# ------------------------------------------------------------------ the results zip
CORRECTION_COLUMNS = ("correction_id", "corrected_at", "corrector_id", "annotator_id", "recording_id", "attempt",
                      "number", "change", "annotation_id", "fields", "before_label", "before_onset_sample",
                      "before_duration_samples", "before_channels", "after_label", "after_onset_sample",
                      "after_duration_samples", "after_channels", "reason", "note")


def correction_files(store: Any) -> dict[str, bytes]:
    """Every saved correction as files of the results folder: ``corrections/corrections.tsv``, a row per change
    (and one for an overall note), and ``corrections/corrections.json`` with the records (docs/file_formats.md).
    The corrected versions themselves are in ``derived/corrections/``."""
    from electrotag.web.feedback import _tsv

    recs = sorted((r for r in store.records("corrections") if r.get("state") == "saved"),
                  key=lambda r: (str(r.get("corrected_at") or ""), str(r.get("correction_id"))))
    if not recs:
        return {}
    rows = []
    for r in recs:
        head = {"correction_id": r.get("correction_id"), "corrected_at": r.get("corrected_at"),
                "corrector_id": r.get("corrector_id"), "annotator_id": r.get("annotator_id"),
                "recording_id": r.get("recording_id"), "attempt": (r.get("corrected_from") or {}).get("attempt"),
                "number": r.get("number")}
        for c in r.get("changes") or []:
            b, a = c.get("before") or {}, c.get("after") or {}
            rows.append({**head, "change": c.get("change"), "annotation_id": c.get("annotation_id"),
                         "fields": list(c.get("fields") or []), "before_label": b.get("label"),
                         "before_onset_sample": b.get("onset_sample"),
                         "before_duration_samples": b.get("duration_samples"),
                         "before_channels": list(b.get("channels") or []) if b else None, "after_label": a.get("label"),
                         "after_onset_sample": a.get("onset_sample"),
                         "after_duration_samples": a.get("duration_samples"),
                         "after_channels": list(a.get("channels") or []) if a else None, "reason": c.get("reason"),
                         "note": c.get("note")})
        if r.get("overall_note"):
            rows.append({**head, "change": "overall", "note": r.get("overall_note")})
    records = [{k: v for k, v in r.items() if k not in ("claim", "claimed_at")} for r in recs]
    return {"corrections/corrections.tsv": _tsv(CORRECTION_COLUMNS, rows),
            "corrections/corrections.json": json.dumps({"schema": "electrotag.corrections", "schema_version": 1,
                                                        "corrections": records}, indent=1,
                                                       ensure_ascii=False).encode("utf-8")}


__all__ = ["CHANGES", "FIELDS", "REASONS", "REASON_RULES", "change_counts", "changed_fields", "correction_files",
           "correction_out", "corrections_of", "counts_text", "diff_annotations", "mark", "needs_reason"]
