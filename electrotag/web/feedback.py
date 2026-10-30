"""Problem reports and reviews of saved work (docs/web/api.md, "Problem reports" and "Reviews").

**Problem reports.** An annotator who cannot judge a recording (a file that will not open, the wrong
recording, flat or missing channels, one too noisy or too short) reports it with ``POST /problems``
(``et_problem_report``) instead of saving it as having no artifacts, which would mix "clean" with
"could not be judged". The report keeps the reason, an optional note of up to 300 characters and
the outcome the annotator chose: ``noted`` (the study team is told and work carries on) or
``unusable`` (the assignment gets the status ``unusable``: finished for the annotator's progress,
kept apart from ``done``, and left out of the agreement analyses). Administrators list the
reports (``problems_list``), resolve them with a note (``problem_resolve``), return the recording
to the annotator's to-do list, which undoes ``unusable`` (``problem_return``), or give it to
someone else (``problem_reassign``).

**Reviews.** A lead annotator (an administrator) reviews someone's saved recording: each annotation
of the latest saved attempt is marked Agree, Caveat or Comment with an optional note, and a stretch
without an annotation can carry a comment ("missed artifact?"). ``review_save`` keeps the review as
a record of its own; the annotation files are never changed, and the agreement analyses do not use
reviews. Annotators read the feedback on their work with ``GET /me/reviews`` (``et_my_reviews``)
unless the study keeps reviews blind (``annotation.show_reviews_to_annotators``).

Records are kept with :meth:`~electrotag.web.store.Store.update_record` and never deleted. Saving
a report or a review is idempotent: the browser gives each one an ID of its own (32 hexadecimal
characters), so the same report pressed twice, or sent again after an answer that came too late,
is kept once.
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
from typing import TYPE_CHECKING, Any

from electrotag.app.common import now_local_iso
from electrotag.web import audit
from electrotag.web.errors import ApiError
from electrotag.web.manifest import SCOPE_STUDY
from electrotag.web.store import MODES, User, attempt_of, item_key, latest_entry

if TYPE_CHECKING:
    from electrotag.web.service import StudyService

#: Why a recording cannot be annotated as it is, in the words of the report's dialog.
REASONS = {
    "file_wont_open": "The file will not open",
    "wrong_recording": "This is the wrong recording",
    "bad_channels": "Channels are flat, missing or disconnected",
    "too_noisy": "Too noisy or too short to annotate",
    "other": "Something else",
}
#: What the annotator chose: tell the study team and carry on, or mark the recording as one that cannot be annotated.
OUTCOMES = {"noted": "Told the study team and carried on", "unusable": "Cannot be annotated"}
#: Where the report was made: the home page's list, or the annotation view.
WHERE = ("home", "annotate")
#: What an administrator did with a report.
RESOLUTIONS = {"resolved": "Resolved", "returned": "Returned to the annotator's to-do list",
               "reassigned": "Given to someone else"}
#: The marks of a review item.
REVIEW_STATUSES = ("agree", "caveat", "comment")
MAX_NOTE = 300
MAX_OVERALL_NOTE = 1000
MAX_REVIEW_ITEMS = 5000
REQUEST_ID_RE = re.compile(r"^[0-9a-f]{32}$")
ANN_ID_RE = re.compile(r"^[0-9A-Za-z_-]{1,64}$")
PROBLEM_COLUMNS = ("problem_id", "reported_at", "annotator_id", "recording_id", "file_name", "mode", "context_id",
                   "reason", "note", "outcome", "where", "item_status", "state", "resolution", "resolution_note",
                   "resolved_at", "resolved_by", "reassigned_to", "unusable_now")
REVIEW_COLUMNS = ("review_id", "reviewed_at", "reviewer_id", "annotator_id", "recording_id", "attempt", "item",
                  "annotation_id", "label", "onset_sample", "duration_samples", "onset_s", "offset_s", "channels",
                  "status", "note")


def _bad(message: str, code: str = "bad_request") -> ApiError:
    return ApiError(400, code, message)


def _request_id(value: Any, what: str) -> str:
    if not isinstance(value, str) or not REQUEST_ID_RE.match(value):
        raise _bad(f"{what} must be 32 hexadecimal characters (made by the browser for this request)")
    return value


def _note(value: Any, what: str = "note", limit: int = MAX_NOTE) -> str:
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > limit:
        raise _bad(f"{what} must be text of at most {limit} characters")
    return value.strip()


def _whole(value: Any, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) \
            or int(value) != value:
        raise _bad(f"{what} must be a whole number of samples")
    return int(value)


def mark_key(rec: dict[str, Any]) -> str:
    """The ID of the mark that sets a reported item aside: the annotator and the item's key."""
    return (f"{rec.get('annotator_id')}_"
            f"{item_key(rec.get('recording_id', ''), rec.get('mode', 'standard'), rec.get('context_id', ''))}")


def count_text(counts: dict[str, int]) -> str:
    """``2 caveats, 1 comment`` (agreements last, and nothing for none)."""
    parts = []
    for key, one in (("caveat", "caveat"), ("comment", "comment"), ("agree", "agreement")):
        n = int(counts.get(key) or 0)
        if n:
            parts.append(audit.count(n, one))
    return ", ".join(parts) or "no marks"


def review_counts(items: list[dict[str, Any]]) -> dict[str, int]:
    out = {"agree": 0, "caveat": 0, "comment": 0, "missed": 0}
    for it in items:
        out[it["status"]] = out.get(it["status"], 0) + 1
        if it.get("annotation_id") is None:
            out["missed"] += 1
    return out


class Feedback:
    """Problem reports and reviews of one study (see the module docstring)."""

    def __init__(self, service: StudyService) -> None:
        self.service = service

    @property
    def store(self) -> Any:
        return self.service.store

    @property
    def settings(self) -> Any:
        return self.service.settings

    # ================================================================ problems
    def unusable_keys(self, annotator_id: str) -> dict[str, str]:
        """The item keys of the annotator's assignments marked as ones that cannot be annotated (-> problem ID)."""
        return {r["key"]: r.get("problem_id", "") for r in self.store.records("unusable", annotator_id)
                if r.get("active") and isinstance(r.get("key"), str)}

    def unusable_assignments(self) -> list[dict[str, Any]]:
        """Every assignment marked as one that cannot be annotated now (the study's own recordings and training)."""
        return [r for r in self.store.records("unusable") if r.get("active")]

    def unusable_recordings(self) -> dict[str, int]:
        """The study recordings someone marked as ones that cannot be annotated, with how many people did."""
        out: dict[str, int] = {}
        for r in self.unusable_assignments():
            if r.get("mode", "standard") == "standard":
                out[r["recording_id"]] = out.get(r["recording_id"], 0) + 1
        return out

    def _mark(self, aid: str, item_k: str, rec: dict[str, Any] | None, *, active: bool) -> None:
        def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
            if old is None and not active:
                return None
            new = dict(old or {})
            new.update({"annotator_id": aid, "key": item_k, "active": active, "changed_at": now_local_iso()})
            if rec is not None:
                new.update({"recording_id": rec["recording_id"], "mode": rec["mode"], "context_id": rec["context_id"],
                            "problem_id": rec["problem_id"]})
            return new

        self.store.update_record("unusable", f"{aid}_{item_k}", aid, change)

    def clear_mark(self, aid: str, recording_id: str, mode: str, context_id: str) -> None:
        """The assignment is no longer set aside (it was taken away from the annotator)."""
        key = item_key(recording_id, mode, context_id)
        if key in self.unusable_keys(aid):
            self._mark(aid, key, None, active=False)

    def problem_report(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``POST /problems`` (``et_problem_report``): an annotator reports a problem with a recording."""
        pid = _request_id(body.get("problem_id"), "problem_id")
        reason = body.get("reason")
        if reason not in REASONS:
            raise _bad(f"reason must be one of {', '.join(REASONS)}")
        outcome = body.get("outcome") or "noted"
        if outcome not in OUTCOMES:
            raise _bad(f"outcome must be one of {', '.join(OUTCOMES)}")
        where = body.get("where") or "home"
        if where not in WHERE:
            raise _bad(f"where must be one of {', '.join(WHERE)}")
        note = _note(body.get("note"))
        aid = user.annotator_id
        kept = next((r for r in self.store.records("problems", aid) if r.get("problem_id") == pid), None)
        if kept is not None:  # pressed twice, or sent again after a late answer: kept once
            return {"problem": self.problem_out(kept, mine=True), "already": True}
        item = self.service.find_item(user, body.get("recording_id"), body.get("mode"), body.get("context_id"))
        if outcome == "unusable":
            if item.mode != "standard":
                raise ApiError(409, "not_for_training", "A training recording cannot be set aside. Tell the study "
                               "team about the problem instead, and carry on.")
            if item.status == "done":
                raise ApiError(409, "already_done", f"You have saved {item.recording_id} already. Tell the study team "
                               "about the problem instead.")
        rec = {"schema": "electrotag.problem_report", "schema_version": 1, "problem_id": pid, "annotator_id": aid,
               "display_name": user.display_name, "recording_id": item.recording_id,
               "file_name": item.manifest.get("file_name", ""), "mode": item.mode, "context_id": item.context_id,
               "reason": reason, "note": note, "outcome": outcome, "where": where, "item_status": item.status,
               "reported_at": now_local_iso(), "state": "open", "resolution": None, "resolution_note": "",
               "resolved_at": None, "resolved_by": None, "reassigned_to": None, "returned_at": None}
        created = {"yes": False}

        def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
            if old is not None:
                return None
            created["yes"] = True
            return rec

        kept = self.store.update_record("problems", pid, aid, change) or rec
        if kept.get("annotator_id") != aid:
            raise ApiError(409, "conflict", "This report could not be kept. Please try again.")
        if not created["yes"]:
            return {"problem": self.problem_out(kept, mine=True), "already": True}
        if outcome == "unusable":
            self._mark(aid, item.key, rec, active=True)
        audit.record(self.store, aid, "problem_report",
                     f"{aid} reported a problem with {item.recording_id}: {REASONS[reason].lower()}"
                     f"{' (cannot be annotated)' if outcome == 'unusable' else ''}",
                     {"problem_id": pid, "recording_id": item.recording_id, "mode": item.mode,
                      "context_id": item.context_id, "reason": reason, "outcome": outcome, "where": where,
                      "note_length": len(note)})
        return {"problem": self.problem_out(kept, mine=True), "already": False}

    def problem_out(self, rec: dict[str, Any], *, mine: bool = False,
                    unusable: set[str] | None = None) -> dict[str, Any]:
        """A report as the API gives it; ``mine``: what the annotator who made it sees."""
        keys = ("problem_id", "recording_id", "file_name", "mode", "context_id", "reason", "note", "outcome", "where",
                "reported_at", "state", "resolution", "resolution_note", "resolved_at", "returned_at")
        out = {k: rec.get(k) for k in keys}
        out["reason_text"] = REASONS.get(str(rec.get("reason")), str(rec.get("reason")))
        if not mine:
            out.update({k: rec.get(k) for k in ("annotator_id", "display_name", "item_status", "resolved_by",
                                                "reassigned_to")})
            key = mark_key(rec)
            out["unusable_now"] = bool(unusable is not None and key in unusable)
        return out

    def latest_problems(self, annotator_id: str) -> dict[str, dict[str, Any]]:
        """Each item's latest report (by item key), for the annotator's list (GET /assignments ``problem``)."""
        out: dict[str, dict[str, Any]] = {}
        for r in sorted(self.store.records("problems", annotator_id), key=lambda r: str(r.get("reported_at") or "")):
            out[item_key(r.get("recording_id", ""), r.get("mode", "standard"), r.get("context_id", ""))] = r
        return out

    # ------------------------------------------------------- the admin's side
    def _problem(self, body: dict[str, Any]) -> dict[str, Any]:
        pid = body.get("problem_id")
        if not isinstance(pid, str) or not REQUEST_ID_RE.match(pid):
            raise _bad("problem_id is missing")
        rec = next((r for r in self.store.records("problems") if r.get("problem_id") == pid), None)
        if rec is None:
            raise ApiError(404, "unknown_problem", "That report is not known to the study.")
        return rec

    def _active_marks(self) -> set[str]:
        return {f"{r['annotator_id']}_{r['key']}" for r in self.unusable_assignments() if r.get("annotator_id")}

    def problems_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        state = body.get("state")
        if state not in (None, "open", "resolved"):
            raise _bad("state must be 'open' or 'resolved'")
        aid = body.get("annotator_id")
        rid = body.get("recording_id")
        reason = body.get("reason")
        if reason is not None and reason not in REASONS:
            raise _bad(f"reason must be one of {', '.join(REASONS)}")
        marks = self._active_marks()
        rows = [self.problem_out(r, unusable=marks) for r in self.store.records("problems")]
        counts = {"open": sum(1 for r in rows if r["state"] == "open"),
                  "resolved": sum(1 for r in rows if r["state"] == "resolved"), "unusable": len(marks)}
        if state:
            rows = [r for r in rows if r["state"] == state]
        if isinstance(aid, str) and aid.strip():
            rows = [r for r in rows if r["annotator_id"] == aid.strip().upper()]
        if isinstance(rid, str) and rid:
            rows = [r for r in rows if r["recording_id"] == rid]
        if reason:
            rows = [r for r in rows if r["reason"] == reason]
        rows.sort(key=lambda r: str(r.get("reported_at") or ""), reverse=True)
        return {"problems": rows, "counts": counts, "reasons": dict(REASONS)}

    def _resolve(self, user: User, rec: dict[str, Any], resolution: str, note: str,
                 **extra: Any) -> dict[str, Any]:
        def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
            if old is None:
                raise ApiError(404, "unknown_problem", "That report is not known to the study.")
            if old.get("state") == "resolved":
                raise ApiError(409, "already_resolved", "This report has been resolved already.")
            new = dict(old)
            new.update({"state": "resolved", "resolution": resolution, "resolution_note": note,
                        "resolved_at": now_local_iso(), "resolved_by": user.annotator_id, **extra})
            return new

        return self.store.update_record("problems", rec["problem_id"], rec["annotator_id"], change) or rec

    def problem_resolve(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rec = self._problem(body)
        note = _note(body.get("note"))
        kept = self._resolve(user, rec, "resolved", note)
        audit.record(self.store, user.annotator_id, "problem_resolve",
                     f"Resolved {rec['annotator_id']}'s report on {rec['recording_id']}",
                     {"problem_id": rec["problem_id"], "annotator_id": rec["annotator_id"],
                      "recording_id": rec["recording_id"], "note": note})
        return {"problem": self.problem_out(kept, unusable=self._active_marks())}

    def problem_return(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """The recording goes back on the annotator's to-do list: ``unusable`` is undone and the report resolved."""
        rec = self._problem(body)
        note = _note(body.get("note"))
        key = item_key(rec["recording_id"], rec.get("mode", "standard"), rec.get("context_id", ""))
        if f"{rec['annotator_id']}_{key}" not in self._active_marks():
            raise ApiError(409, "not_unusable", f"{rec['recording_id']} is not set aside for {rec['annotator_id']}: it "
                           "is on their list already. Resolve the report instead.")
        kept = self._resolve(user, rec, "returned", note, returned_at=now_local_iso())
        self._mark(rec["annotator_id"], key, None, active=False)
        audit.record(self.store, user.annotator_id, "problem_return",
                     f"Returned {rec['recording_id']} to {rec['annotator_id']}'s to-do list",
                     {"problem_id": rec["problem_id"], "annotator_id": rec["annotator_id"],
                      "recording_id": rec["recording_id"], "note": note})
        return {"problem": self.problem_out(kept, unusable=self._active_marks())}

    def problem_reassign(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """Give the recording to someone else (the study's own annotation), and resolve the report."""
        from electrotag.web.admin import _aid

        rec = self._problem(body)
        note = _note(body.get("note"))
        to = _aid(body.get("annotator_id"))
        if to == rec["annotator_id"]:
            raise _bad("Choose someone other than the person who reported the problem, or return it to them.")
        if self.store.user_record(to) is None:
            raise ApiError(404, "unknown_user", f"{to} has no account in this study")
        if rec.get("mode", "standard") != "standard":
            raise ApiError(409, "not_for_training", "Training recordings are given through the training programme.")
        m = self.store.manifest(SCOPE_STUDY, rec["recording_id"])
        if m is None:
            raise ApiError(404, "unknown_recording", f"{rec['recording_id']} is no longer registered")
        if (m.get("registration") or {}).get("retired"):
            raise ApiError(409, "retired", f"{rec['recording_id']} is retired, so it is offered for no new "
                           "assignments.")
        added = self.store.assign(to, [rec["recording_id"]], mode="standard", context_id="")
        if not added:
            # Nothing was given: the report stays open, so that the recording does not look dealt with.
            raise ApiError(409, "already_assigned", f"{to} already has {rec['recording_id']}, so giving it to them "
                           "changes nothing and the report stays open. Choose someone who does not have it yet.")
        kept = self._resolve(user, rec, "reassigned", note, reassigned_to=to)
        audit.record(self.store, user.annotator_id, "problem_reassign",
                     f"Gave {rec['recording_id']} to {to} after {rec['annotator_id']}'s report",
                     {"problem_id": rec["problem_id"], "annotator_id": rec["annotator_id"],
                      "recording_id": rec["recording_id"], "to": to, "added": added, "note": note})
        return {"problem": self.problem_out(kept, unusable=self._active_marks()), "added": added}

    # ================================================================= reviews
    def _latest(self, aid: str, rid: str) -> dict[str, Any] | None:
        mine = [e for e in self.store.completion_entries(aid) if e.get("recording_id") == rid
                and e.get("mode", "standard") == "standard" and e.get("status") == "completed"]
        return latest_entry(mine) if mine else None

    def _saved_annotations(self, aid: str, rid: str) -> list[dict[str, Any]]:
        raw = self.store.saved_document(aid, rid, "standard", "")
        if raw is None:
            return []
        try:
            doc = json.loads(raw)
        except ValueError:
            return []
        keys = ("annotation_id", "label", "onset_sample", "duration_samples", "channels", "created_at", "modified_at",
                "note")
        # The annotator's confidence and note go with each annotation, so that the reviewer sees their doubt.
        return [{**{k: a.get(k, [] if k == "channels" else "") for k in keys}, "confidence": a.get("confidence")}
                for a in doc.get("annotations", []) if isinstance(a, dict)]

    def _target(self, body: dict[str, Any]) -> tuple[str, str, dict[str, Any], dict[str, Any]]:
        from electrotag.web.admin import _aid, _rid

        aid = _aid(body.get("annotator_id"))
        rid = _rid(body.get("recording_id"))
        mode = body.get("mode") or "standard"
        if mode not in MODES:
            raise _bad(f"mode must be one of {', '.join(MODES)}")
        if mode != "standard":
            raise ApiError(409, "not_for_training", "Reviews are for the study's own recordings; training recordings "
                           "have their own feedback.")
        entry = self._latest(aid, rid)
        m = self.store.manifest(SCOPE_STUDY, rid)
        if entry is None or m is None:
            raise ApiError(404, "no_saved_annotations", f"{aid} has not saved {rid}, so there is nothing to review.")
        return aid, rid, entry, m

    def review_out(self, rec: dict[str, Any], *, for_annotator: bool = False) -> dict[str, Any]:
        keys = ("review_id", "annotator_id", "recording_id", "file_name", "mode", "context_id", "attempt",
                "reviewer_id", "reviewer_name", "reviewed_at", "overall_note", "items", "counts")
        out = {k: rec.get(k) for k in keys}
        out["summary"] = count_text(rec.get("counts") or {})
        if not for_annotator:
            out.update({k: rec.get(k) for k in ("output_basename", "session_id")})
        return out

    def _reviews(self, aid: str | None = None, rid: str | None = None) -> list[dict[str, Any]]:
        rows = self.store.records("reviews", aid)
        if rid is not None:
            rows = [r for r in rows if r.get("recording_id") == rid]
        return sorted(rows, key=lambda r: str(r.get("reviewed_at") or ""), reverse=True)

    def saved_attempt_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """What a review needs: the latest saved attempt's annotations, the manifest and the earlier reviews."""
        aid, rid, entry, m = self._target(body)
        rec = self.store.user_record(aid) or {}
        return {"annotator_id": aid, "display_name": rec.get("display_name", ""), "recording_id": rid,
                "file_name": m.get("file_name", ""), "mode": "standard", "context_id": "",
                "attempt": attempt_of(entry), "saved_at": entry.get("completed_at") or None,
                "manifest": self.service.public_manifest(m), "annotations": self._saved_annotations(aid, rid),
                "reviews": [self.review_out(r) for r in self._reviews(aid, rid)],
                "allow_reviews": bool(self.settings.allow_reviews)}

    def _review_items(self, raw: Any, annotations: list[dict[str, Any]], n_samples: int,
                      sfreq: float) -> list[dict[str, Any]]:
        if not isinstance(raw, list) or len(raw) > MAX_REVIEW_ITEMS:
            raise _bad(f"items must be a list of at most {MAX_REVIEW_ITEMS} review items")
        by_id = {a["annotation_id"]: a for a in annotations}
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for i, it in enumerate(raw, start=1):
            if not isinstance(it, dict):
                raise _bad(f"Review item {i} is not an object")
            status = it.get("status")
            if status not in REVIEW_STATUSES:
                raise _bad(f"Review item {i}: status must be one of {', '.join(REVIEW_STATUSES)}")
            note = _note(it.get("note"), f"Review item {i}: note")
            aid = it.get("annotation_id")
            if aid is not None:
                if not isinstance(aid, str) or not ANN_ID_RE.match(aid):
                    raise _bad(f"Review item {i}: annotation_id is not valid")
                if aid not in by_id:
                    raise ApiError(422, "unknown_annotation", f"Review item {i} is about an annotation that is not in "
                                   "the saved version reviewed")
                if aid in seen:
                    raise _bad(f"Review item {i}: annotation {aid} is reviewed twice")
                seen.add(aid)
                a = by_id[aid]
                onset, dur = a.get("onset_sample"), a.get("duration_samples")
                out.append({"annotation_id": aid, "label": a.get("label", ""), "onset_sample": onset,
                            "duration_samples": dur, "channels": list(a.get("channels") or []), "status": status,
                            "note": note})
                continue
            onset = _whole(it.get("onset_sample"), f"Review item {i}: onset_sample")
            dur = _whole(it.get("duration_samples"), f"Review item {i}: duration_samples")
            if onset < 0 or dur < 1 or onset + dur > n_samples:
                raise ApiError(422, "invalid_review", f"Review item {i}: the stretch must lie within the recording")
            if status != "comment":
                raise _bad(f"Review item {i}: a stretch without an annotation takes a comment")
            out.append({"annotation_id": None, "label": None, "onset_sample": onset, "duration_samples": dur,
                        "channels": [], "status": "comment", "note": note or "missed artifact?"})
        for it in out:
            on, dur = it.get("onset_sample"), it.get("duration_samples")
            if isinstance(on, (int, float)) and isinstance(dur, (int, float)):
                it["onset_s"] = round(it["onset_sample"] / sfreq, 6)
                it["offset_s"] = round((it["onset_sample"] + it["duration_samples"]) / sfreq, 6)
        return out

    def review_save(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        rid_req = _request_id(body.get("review_id"), "review_id")
        kept = next((r for r in self.store.records("reviews") if r.get("review_id") == rid_req), None)
        if kept is not None:  # the same review sent again: kept once
            if kept.get("reviewer_id") != user.annotator_id:
                raise ApiError(409, "conflict", "This review could not be kept. Please try again.")
            return {"review": self.review_out(kept), "already": True}
        if not self.settings.allow_reviews:
            raise ApiError(409, "reviews_off", "This study does not take reviews of saved work. Switch them on in "
                           "the study settings first.")
        aid, rid, entry, m = self._target(body)
        attempt = body.get("attempt")
        if isinstance(attempt, bool) or not isinstance(attempt, int):
            raise _bad("attempt must be the version reviewed (a whole number)")
        if attempt != attempt_of(entry):
            raise ApiError(409, "not_latest", f"{aid} has saved {rid} again since you opened it (version "
                           f"{attempt_of(entry)}). Open it again to review the latest version.")
        timing = m["timing"]
        items = self._review_items(body.get("items"), self._saved_annotations(aid, rid), int(timing["n_samples"]),
                                   float(timing["sfreq"]))
        overall = _note(body.get("overall_note"), "overall_note", MAX_OVERALL_NOTE)
        if not items and not overall:
            raise _bad("Mark at least one annotation, or write an overall note, before saving the review.",
                       "empty_review")
        counts = review_counts(items)
        rec = {"schema": "electrotag.review", "schema_version": 1, "review_id": rid_req, "annotator_id": aid,
               "recording_id": rid, "file_name": m.get("file_name", ""), "mode": "standard", "context_id": "",
               "attempt": attempt, "output_basename": entry.get("output_basename", ""),
               "session_id": entry.get("session_id", ""), "reviewer_id": user.annotator_id,
               "reviewer_name": user.display_name, "reviewed_at": now_local_iso(), "overall_note": overall,
               "items": items, "counts": counts}
        created = {"yes": False}

        def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
            if old is not None:
                return None
            created["yes"] = True
            return rec

        kept = self.store.update_record("reviews", rid_req, aid, change) or rec
        if not created["yes"]:
            return {"review": self.review_out(kept), "already": True}
        audit.record(self.store, user.annotator_id, "review_save",
                     f"Reviewed {aid}'s {rid} (version {attempt}): {count_text(counts)}",
                     {"review_id": rid_req, "annotator_id": aid, "recording_id": rid, "attempt": attempt,
                      "counts": counts, "n_items": len(items), "overall_note_length": len(overall)})
        return {"review": self.review_out(kept), "already": False}

    def reviews_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.web.admin import _aid

        aid = _aid(body.get("annotator_id")) if body.get("annotator_id") is not None else None
        rid = body.get("recording_id")
        if rid is not None and (not isinstance(rid, str) or not rid):
            raise _bad("recording_id must be a recording ID")
        return {"reviews": [self.review_out(r) for r in self._reviews(aid, rid)]}

    def my_reviews(self, user: User, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """``GET /me/reviews`` (``et_my_reviews``): the feedback on the annotator's saved work, newest first."""
        if not self.settings.show_reviews_to_annotators:
            return {"shown": False, "reviews": []}
        return {"shown": True,
                "reviews": [self.review_out(r, for_annotator=True) for r in self._reviews(user.annotator_id)]}

    def reviewed_recordings(self) -> set[tuple[str, str]]:
        """(annotator, recording) pairs with at least one review."""
        return {(r.get("annotator_id", ""), r.get("recording_id", "")) for r in self.store.records("reviews")}


# ------------------------------------------------------------------ the results zip
def _tsv(columns: tuple[str, ...], rows: list[dict[str, Any]]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter="\t", lineterminator="\n")
    w.writerow(columns)
    for r in rows:
        w.writerow(["n/a" if r.get(c) is None or r.get(c) == "" else
                    (",".join(r[c]) if isinstance(r.get(c), list) else str(r[c]).replace("\t", " ").replace("\n", " "))
                    for c in columns])
    return buf.getvalue().encode("utf-8")


def _safe_part(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text).strip("_")[:80] or "recording"


def feedback_files(store: Any) -> dict[str, bytes]:
    """The problem reports and reviews as files of the results folder (paths below it): one TSV and one JSON of
    every report, and a TSV and a JSON per review (docs/file_formats.md)."""
    out: dict[str, bytes] = {}
    problems = sorted(store.records("problems"), key=lambda r: str(r.get("reported_at") or ""))
    marks = {f"{r.get('annotator_id')}_{r.get('key')}" for r in store.records("unusable") if r.get("active")}
    if problems:
        rows = []
        for r in problems:
            key = mark_key(r)
            rows.append({**r, "unusable_now": "yes" if key in marks else "no"})
        out["problem_reports/problem_reports.tsv"] = _tsv(PROBLEM_COLUMNS, rows)
        out["problem_reports/problem_reports.json"] = json.dumps(
            {"schema": "electrotag.problem_reports", "schema_version": 1, "reports": rows},
            indent=1, ensure_ascii=False).encode("utf-8")
    for r in store.records("reviews"):
        stem = _safe_part(str(r.get("recording_id", "")).split("/")[-1].rsplit(".", 1)[0])
        when = re.sub(r"[^0-9]", "", str(r.get("reviewed_at") or ""))[:14] or "0"
        base = (f"reviews/annotator-{r.get('annotator_id')}/{stem}_attempt-{int(r.get('attempt') or 1):02d}_review-"
                f"{when}-{str(r.get('review_id', ''))[:8]}")
        head = {k: r.get(k) for k in ("review_id", "reviewed_at", "reviewer_id", "annotator_id", "recording_id",
                                      "attempt")}
        rows = [{**head, "item": i, **it} for i, it in enumerate(r.get("items") or [], start=1)]
        if r.get("overall_note"):
            rows.append({"review_id": r.get("review_id"), "reviewed_at": r.get("reviewed_at"),
                         "reviewer_id": r.get("reviewer_id"), "annotator_id": r.get("annotator_id"),
                         "recording_id": r.get("recording_id"), "attempt": r.get("attempt"), "item": "overall",
                         "status": "overall", "note": r.get("overall_note")})
        out[f"{base}.tsv"] = _tsv(REVIEW_COLUMNS, rows)
        out[f"{base}.json"] = json.dumps(r, indent=1, ensure_ascii=False).encode("utf-8")
    from electrotag.web.corrections import correction_files

    out.update(correction_files(store))  # experts' corrections: every change with its reason (docs/file_formats.md)
    return out


def unusable_count(store: Any) -> int:
    return sum(1 for r in store.records("unusable") if r.get("active"))


__all__ = ["OUTCOMES", "REASONS", "REVIEW_STATUSES", "Feedback", "count_text", "feedback_files",
           "review_counts", "unusable_count"]
