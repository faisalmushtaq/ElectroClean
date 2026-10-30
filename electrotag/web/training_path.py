"""The five-stage training path on the server (docs/web/api.md, "Training stages").

* ``POST /training/stage``: a trainee skips a stage the study's policy lets them skip, takes a
  skipped stage up again, or reports the tour or the snippets finished. Each is kept as an event of
  the trainee's progress (:func:`electrotag.training.programme.stage_marks`), so it is part of the
  study's record; the browser also logs it in the interaction log.
* ``GET /training/snippets``: the artifact snippets of the trainee's set, with the manifests the
  browser checks the trainee's own copies against, and the state of the set's recognition check.
* The **competency gate**: real study work waits until the trainee's competency assessment is
  passed ("met"; the study can choose "completed" or "off"). Experts and administrators are never
  gated, nor is anyone outside a training programme or in one without an assessment. While it is
  closed, study recordings are listed as ``locked`` and opening, drafting, saving or setting one
  aside is refused with 403 ``training_required``.
* After an assessment that did not meet the criteria the study team either **reopens the
  training** (the trainee practises again and retakes the assessment; only what is saved from then
  on counts) or **assigns a new assessment set** (the learning stages count as done). Both are
  admin operations, audited.
* The snippets the study team adds to a set (``snippets_list``, ``snippet_add`` and
  ``snippet_remove``), for administrators and experts.

The stages themselves are worked out by :mod:`electrotag.training.programme`; the coach
(:mod:`electrotag.web.coach`) shows them.
"""

from __future__ import annotations

import math
import re
from typing import TYPE_CHECKING, Any

from electrotag.app.common import now_local_iso
from electrotag.training.programme import (
    DONE_IN_BROWSER,
    LEARNING_STAGES,
    STAGE_TITLES,
    STAGES,
    stage_marks,
)
from electrotag.training.reference import (
    NO_SNIPPETS_FROM,
    SNIPPET_MAX_CONTEXT_S,
    SNIPPET_MAX_S,
    ReferenceSet,
    ReferenceSetError,
    Snippet,
    guided_snippets,
    set_snippets,
)
from electrotag.web import audit
from electrotag.web.errors import ApiError
from electrotag.web.manifest import SCOPE_STUDY, fingerprint_of, set_scope
from electrotag.web.store import User

if TYPE_CHECKING:
    from electrotag.web.service import StudyService, WorkItem

ACTIONS = ("skip", "done", "resume")
#: The stages from which the study team may reopen a trainee's training.
REOPEN_FROM = ("guided", "practice")
SNIPPET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
MAX_EXPLANATION = 1000

#: What a trainee is told while real study work waits for the assessment, by the study's gate and the result.
GATE_TEXT = {
    "met": "Your study recordings open once you pass the competency assessment at the end of your training path.",
    "completed": "Your study recordings open once you have finished the competency assessment at the end of your "
                 "training path.",
    "not_met": "Your assessment did not meet the competency criteria yet, so your study recordings stay locked. "
               "Your study team can reopen your training for more practice or give you a new assessment.",
    "not_determined": "Your assessment is finished and your study team is looking at the result. Your study "
                      "recordings open once they confirm that you passed.",
}
#: ``result`` of a closed gate: "" while the assessment is still to do, "not_met" or "not_determined" once it is
#: finished and the study team has to act (the browser says "Assessment not met: waiting for your study team").
OPEN_GATE: dict[str, Any] = {"open": True, "reason": "", "message": "", "result": ""}


def _bad(message: str, code: str = "bad_request") -> ApiError:
    return ApiError(400, code, message)


def article(word: str) -> str:
    """"an" before a vowel, "a" otherwise: "an assessment recording", "a practice recording"."""
    return "an" if word[:1].lower() in "aeiou" else "a"


class TrainingPath:
    def __init__(self, service: StudyService) -> None:
        self.service = service

    @property
    def store(self) -> Any:
        return self.service.store

    @property
    def coach(self) -> Any:
        return self.service.coach

    def _programme(self, aid: str) -> ReferenceSet:
        set_id = self.store.programme(aid)
        if not set_id:
            raise ApiError(404, "no_programme", "You are not taking part in a training programme")
        try:
            return self.store.reference_set(set_id)
        except ReferenceSetError as exc:
            raise ApiError(404, "no_reference_set", f"The training set {set_id} was not found on the server") from exc

    def _scope(self, rs: ReferenceSet) -> str:
        return set_scope(rs.set_id) if rs.self_contained else SCOPE_STUDY

    # ============================================================== blinding
    def _other_sets(self, rs: ReferenceSet) -> list[ReferenceSet]:
        """Every other reference set of the study."""
        try:
            return [o for o in self.store.reference_sets() if o.set_id != rs.set_id]
        except (OSError, ReferenceSetError):
            return []

    def _fingerprint(self, scope: str, rid: str) -> tuple[str, int] | None:
        m = self.store.manifest(scope, rid)
        return fingerprint_of(m) if m is not None else None

    def answer_uses(self, rs: ReferenceSet, rid: str, others: list[ReferenceSet] | None = None,
                    scope: str | None = None) -> list[tuple[ReferenceSet, str]]:
        """The sets in which ``rid`` is a practice or assessment recording, whose references are the answers trainees
        are scored against: ``rs`` itself, and every other set that holds the same recording (the same contents, by
        its fingerprint; a self-contained set holds its own copy of a study recording). ``scope`` is where ``rid``'s
        manifest is when it is not yet in ``rs``'s (a library entry's study recording)."""
        out = []
        use = rs.recordings.get(rid, {}).get("use")
        if use in NO_SNIPPETS_FROM:
            out.append((rs, str(use)))
        candidates = [o for o in (self._other_sets(rs) if others is None else others)
                      if o.recordings.get(rid, {}).get("use") in NO_SNIPPETS_FROM]
        if not candidates:
            return out
        mine = self._fingerprint(scope or self._scope(rs), rid) or self._fingerprint(SCOPE_STUDY, rid)
        for other in candidates:
            theirs = self._fingerprint(self._scope(other), rid)
            if mine is None or theirs is None or theirs == mine:  # when in doubt, the answers stay hidden
                out.append((other, str(other.recordings[rid].get("use"))))
        return out

    def answer_sets(self, rid: str, scope: str = SCOPE_STUDY) -> list[tuple[str, str]]:
        """``[(set_id, use)]`` for every set that holds the recording at ``scope`` (the same file, by its
        fingerprint) as a practice or assessment recording: anything showing trainees someone's marks of it (a
        replay, a snippet, a quiz item) would give answers away. For callers without a set of their own, such as
        the replays shown to trainees."""
        mine = self._fingerprint(scope, rid)
        out = []
        try:
            sets = list(self.store.reference_sets())
        except (OSError, ReferenceSetError):
            sets = []
        for other in sets:
            use = other.recordings.get(rid, {}).get("use")
            if use not in NO_SNIPPETS_FROM:
                continue
            theirs = self._fingerprint(self._scope(other), rid)
            if mine is None or theirs is None or theirs == mine:
                out.append((other.set_id, str(use)))
        return out

    def reveals_answers(self, rs: ReferenceSet, rid: str, what: str = "a snippet",
                        others: list[ReferenceSet] | None = None, scope: str | None = None) -> str:
        """Why showing ``rid`` to trainees (as ``what``) would give answers away, in plain words, or "" when it would
        not. Used by every way the study team adds training material: snippets, quiz items and library promotes."""
        uses = self.answer_uses(rs, rid, others, scope)
        if not uses:
            return ""
        other, use = uses[0]
        whose = "this set" if other.set_id == rs.set_id else f"the training set {other.name or other.set_id}"
        return (f"{rid} is {article(use)} {use} recording of {whose}: {what} of it would show trainees the answers "
                "they are scored against. Choose a guided recording, or another recording that no set uses for "
                "practice or assessment.")

    def refuse_if_revealing(self, rs: ReferenceSet, rid: str, what: str = "a snippet",
                            scope: str | None = None) -> None:
        """422 ``reveals_answers`` for training material taken from a practice or assessment recording."""
        why = self.reveals_answers(rs, rid, what, scope=scope)
        if why:
            raise ApiError(422, "reveals_answers", why)

    def withheld_quiz_items(self, rs: ReferenceSet) -> list[dict[str, str]]:
        """The set's quiz items whose recording is now a practice or assessment recording (of this set or, for a
        study recording, of another): ``[{item_id, recording_id, message}]``. While there are any, the quiz is left
        out of the recognition check and offered to experts and administrators only."""
        if not rs.quiz_items:
            return []
        out = []
        others = self._other_sets(rs)
        for it in rs.quiz_items:
            why = self.reveals_answers(rs, it.recording_id, "a quiz item", others)
            if why:
                out.append({"item_id": it.item_id, "recording_id": it.recording_id, "message": why})
        return out

    def quiz_offered(self, rs: ReferenceSet) -> bool:
        """Whether the set's quiz can be the recognition check: it has items, and none gives answers away."""
        return bool(rs.quiz_items) and not self.withheld_quiz_items(rs)

    # ================================================================ the gate
    def gate(self, user: User) -> dict[str, Any]:
        """``training_gate`` of ``GET /me``: whether real study work is open to this person, and if not why, in
        plain words (``{"open", "reason": "" | "training_required", "message", "result": "" | "not_met" |
        "not_determined"}``; ``result`` says that the assessment is finished and the study team has to act)."""
        policy = self.service.settings.training.gate
        if policy == "off" or user.is_expert:  # experts and administrators are never gated
            return dict(OPEN_GATE)
        set_id = self.store.programme(user.annotator_id)
        if not set_id:
            return dict(OPEN_GATE)
        try:
            rs = self.store.reference_set(set_id)
        except ReferenceSetError:
            return dict(OPEN_GATE)  # a missing set is the study team's to put right; nobody waits for it
        if not rs.assessment_recordings:
            return dict(OPEN_GATE)
        states = {s.key: s for s in self.coach._states(rs, user.annotator_id)[0]}
        a = states["assessment"]
        result = ""
        if a.status == "completed":
            if policy == "completed":
                return dict(OPEN_GATE)
            status = self.store.report_status(rs.set_id, user.annotator_id)
            if status == "met":
                return dict(OPEN_GATE)
            result = "not_met" if status == "not_met" else "not_determined"
            text = GATE_TEXT[result]
        else:
            text = GATE_TEXT["completed" if policy == "completed" else "met"]
        return {"open": False, "reason": "training_required", "message": text, "result": result}

    @staticmethod
    def gated(item: WorkItem) -> bool:
        """Whether the gate applies to a work item: the study's own recordings (training recordings never wait)."""
        return item.mode == "standard" and item.source == "assignment"

    @staticmethod
    def refusal(gate: dict[str, Any]) -> ApiError:
        return ApiError(403, "training_required", f"{gate.get('message') or GATE_TEXT['met']} Your training path "
                        "shows what to do next.")

    def require_open(self, user: User, item: WorkItem) -> None:
        """403 ``training_required`` for a study recording while the gate is closed."""
        if not self.gated(item):
            return
        g = self.gate(user)
        if not g["open"]:
            raise self.refusal(g)

    # ========================================================= stage actions
    def stage_action(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``POST /training/stage {stage, action}``. Asking for what is already so changes nothing and answers the
        training path as it is (the request may reach the study twice)."""
        stage, action = body.get("stage"), body.get("action")
        if stage not in STAGES or action not in ACTIONS:
            raise _bad("stage must be one of tour, snippets, guided, practice or assessment, and action one of skip, "
                       "done or resume")
        if stage == "assessment" and action == "skip":
            raise ApiError(409, "cannot_skip", "The competency assessment cannot be skipped: it is passed before "
                           "real study work begins.")
        rs = self._programme(user.annotator_id)
        policy = self.coach.policy()
        states, prog = self.coach._states(rs, user.annotator_id)
        st = next(s for s in states if s.key == stage)
        title = STAGE_TITLES[stage]
        if action == "skip":
            if st.status == "skipped":
                return self.coach.programme_view(user)
            if not policy.may_skip(stage):
                raise ApiError(409, "cannot_skip", f"This study asks every trainee to do {title}, so it cannot be "
                               "skipped.")
            if stage_marks(prog.events).reopened_stage(stage) and st.status in ("available", "in_progress"):
                raise ApiError(409, "reopened", f"Your study team reopened your training so that you do {title} "
                               "again before the assessment, so it cannot be skipped this time.")
            if st.status == "locked":
                raise ApiError(409, "locked", f"{title} is not open yet: finish or skip the stage before it first.")
            if st.status in ("completed", "not_used"):
                what = "done already" if st.status == "completed" else "not part of your training"
                raise ApiError(409, "finished", f"{title} is {what}, so there is nothing to skip.")
            prog.note("stage_skipped", stage=stage, policy=list(policy.skippable))
        elif action == "resume":
            if st.status != "skipped":
                return self.coach.programme_view(user)
            prog.note("stage_resumed", stage=stage)
        else:
            if stage not in DONE_IN_BROWSER:
                raise ApiError(409, "not_done_here", f"{title} is finished by saving its recordings.")
            if st.status == "completed":
                return self.coach.programme_view(user)
            if st.status == "locked":
                raise ApiError(409, "locked", f"{title} is not open yet: finish or skip the stage before it first.")
            if st.status == "not_used":
                raise ApiError(409, "finished", f"{title} is not part of your training.")
            if stage == "snippets" and policy.snippets_quiz_required:
                quiz = self._quiz(user, rs)
                if quiz is not None and not quiz["finished"]:
                    raise ApiError(409, "quiz_required", "Finish the recognition check first: this study counts "
                                   f"{title} as done once its check is finished.")
            prog.note("stage_completed", stage=stage)
        return self.coach.programme_view(user)

    def skipped_stages(self, rs: ReferenceSet, aid: str) -> list[str]:
        """The learning stages the trainee has skipped (and not taken up again), in this set or in the set they took
        before a new assessment set, for the competency report."""
        return stage_marks(self.store.progress(rs, aid).events).skipped

    @staticmethod
    def rounds(events: list[dict[str, Any]], *, reports: bool = False) -> list[dict[str, Any]]:
        """The earlier rounds of the assessment (before a reopening or a new assessment set), oldest first:
        ``{round, set_id, set_name, status, status_text, at}``, with the competency report itself (``report``)
        when ``reports``."""
        keys = ("round", "set_id", "set_name", "status", "status_text", "at") + (("report",) if reports else ())
        return [{k: r.get(k) for k in keys} for r in stage_marks(events).rounds]

    def _round(self, aid: str, rs: ReferenceSet) -> dict[str, Any]:
        """The round of the assessment that has just ended, with its competency report as it stands now (the report
        of the next round replaces the stored one, so this copy is kept with the progress)."""
        try:
            report = dict(self.store.competency(rs, aid))
        except Exception:  # noqa: BLE001 - the round is kept without its report rather than not at all
            report = {}
        report.pop("paths", None)
        from electrotag.web.service import clean_json

        return {"set_id": rs.set_id, "set_name": rs.name or rs.set_id, "status": str(report.get("status") or ""),
                "status_text": str(report.get("status_text") or ""), "at": now_local_iso(),
                "report": clean_json(report)}

    # ================================================================ snippets
    def _quiz(self, user: User, rs: ReferenceSet) -> dict[str, Any] | None:
        from electrotag.web.quiz import allowed

        if not rs.quiz_items or not allowed(rs, user.annotator_id) or not self.quiz_offered(rs):
            return None  # a quiz on a practice or assessment recording would give its answers away
        state = self.store.quiz_state(user.annotator_id, rs.set_id) or {}
        finished = bool(state.get("finished"))
        score = state.get("score") if finished and isinstance(state.get("score"), dict) else {}
        n_correct = score.get("n_correct")
        return {"n_items": len(rs.quiz_items), "finished": finished,
                "required": bool(self.coach.policy().snippets_quiz_required),
                "n_correct": int(n_correct) if finished and isinstance(n_correct, (int, float)) else None}

    def snippets_view(self, user: User) -> dict[str, Any]:
        """``GET /training/snippets``: every snippet of the trainee's set whose recording is registered and is no
        set's practice or assessment recording, the public manifests of those recordings, and the set's recognition
        check (its quiz) when there is one that gives no answers away."""
        rs = self._programme(user.annotator_id)
        scope = self._scope(rs)
        recordings: dict[str, Any] = {}
        out = []
        others = self._other_sets(rs)
        for sn in set_snippets(rs):
            if self.answer_uses(rs, sn.recording_id, others):
                continue  # the recording is now another set's practice or assessment recording
            if sn.recording_id not in recordings:
                m = self.store.manifest(scope, sn.recording_id)
                if m is None:
                    continue
                recordings[sn.recording_id] = self.service.public_manifest(m)
            out.append(sn.to_dict())
        return {"set_id": rs.set_id, "snippets": out, "recordings": recordings, "quiz": self._quiz(user, rs)}

    # The study team's own snippets (admin and expert operations).
    def _set(self, body: dict[str, Any]) -> ReferenceSet:
        set_id = body.get("set_id")
        if not isinstance(set_id, str) or not set_id:
            raise _bad("set_id is missing")
        return self.service.reference_set(set_id)

    def snippets_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``{set_id}`` → ``{"snippets": [the study team's], "guided": [those made from the guided references],
        "recordings": [{recording_id, file_name, use, duration_s, ch_names}]}``: the recordings a snippet may come
        from (the set's, less its practice and assessment recordings)."""
        rs = self._set(body)
        scope = self._scope(rs)
        try:
            derived = [s.to_dict() for s in guided_snippets(rs)]
        except (ReferenceSetError, OSError, ValueError):
            derived = []
        recs = []
        others = self._other_sets(rs)
        for rid, entry in rs.recordings.items():
            use = str(entry.get("use", ""))
            m = self.store.manifest(scope, rid)
            if use in NO_SNIPPETS_FROM or m is None or self.answer_uses(rs, rid, others):
                continue
            t = m["timing"]
            recs.append({"recording_id": rid, "file_name": m["file_name"], "use": use,
                         "duration_s": float(t["n_samples"]) / float(t["sfreq"]), "ch_names": list(m["ch_names"])})
        return {"set_id": rs.set_id, "snippets": [s.to_dict() for s in rs.own_snippets], "guided": derived,
                "recordings": recs}

    def snippet_add(self, user: User, body: dict[str, Any], *, op: str = "snippet_add") -> dict[str, Any]:
        """``{set_id, recording_id, start_s, end_s, label, explanation?, context_s?, channels?, snippet_id?,
        source?}`` → ``{"snippet"}``. The same ``snippet_id`` again replaces it (so a request sent twice keeps
        one). Audited."""
        rs0 = self._set(body)
        rid = body.get("recording_id")
        if not isinstance(rid, str) or not rid:
            raise _bad("recording_id is missing")
        self.refuse_if_revealing(rs0, rid)
        m = self.store.manifest(self._scope(rs0), rid)
        if m is None:
            raise ApiError(404, "unknown_recording", f"{rid} is not a recording of the reference set {rs0.set_id}")
        duration = float(m["timing"]["n_samples"]) / float(m["timing"]["sfreq"])

        def number(key: str, lo: float, hi: float, default: float | None = None) -> float:
            v = body.get(key, default)
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
                raise _bad(f"{key} must be a number of seconds from {lo:g} to {hi:g}")
            return float(v)

        start, end = number("start_s", 0.0, duration), number("end_s", 0.0, duration)
        if end <= start:
            raise _bad("end_s must be after start_s")
        if end - start > SNIPPET_MAX_S:
            raise _bad(f"A snippet is at most {SNIPPET_MAX_S:g} s long")
        context = number("context_s", 0.0, SNIPPET_MAX_CONTEXT_S, 2.0)
        label = body.get("label")
        if not isinstance(label, str) or not self.store.catalogue.is_permitted(label):
            raise _bad("label must be one of the study's artifact types")
        explanation = body.get("explanation") or ""
        if not isinstance(explanation, str) or len(explanation) > MAX_EXPLANATION:
            raise _bad(f"explanation must be text of at most {MAX_EXPLANATION} characters")
        channels = body.get("channels") or []
        if (not isinstance(channels, list) or not all(isinstance(c, str) for c in channels)
                or not set(channels) <= set(m["ch_names"]) or len(set(channels)) != len(channels)):
            raise _bad("channels must be a list of the recording's channel names, each once (none: the whole montage)")
        sid = body.get("snippet_id")
        if sid is not None and (not isinstance(sid, str) or not SNIPPET_ID_RE.match(sid) or sid.startswith("g-")):
            raise _bad("snippet_id is 1 to 64 letters, digits, dots, hyphens or underscores (not starting with g-)")
        source = body.get("source") if isinstance(body.get("source"), dict) else {"kind": "added"}
        source = {**{k: v for k, v in source.items() if isinstance(v, (str, int, float, bool))},
                  "by": user.annotator_id}
        cat_labels = tuple(lab.label for lab in self.store.catalogue.labels)
        with self.service.administration._editing(rs0.set_id) as rs:
            snippet = Snippet(snippet_id=sid or rs.next_snippet_id(), recording_id=rid, start_s=start, end_s=end,
                              label=label, explanation=explanation.strip(), context_s=context,
                              channels=list(channels), source=source)
            try:
                rs.add_snippet(snippet, cat_labels)
            except ReferenceSetError as exc:
                raise _bad(str(exc)) from exc
        audit.record(self.store, user.annotator_id, op, f"Added the snippet {snippet.snippet_id} ({label}, "
                     f"{start:.2f}–{end:.2f} s of {rid}) to {rs0.set_id}",
                     {"set_id": rs0.set_id, "snippet_id": snippet.snippet_id, "recording_id": rid, "label": label,
                      "start_s": start, "end_s": end, "explanation_length": len(explanation.strip())})
        return {"snippet": snippet.to_dict()}

    def snippet_remove(self, user: User, body: dict[str, Any], *, op: str = "snippet_remove") -> dict[str, Any]:
        """``{set_id, snippet_id}`` → ``{}``. Removing one that is gone already changes nothing. Audited."""
        rs0 = self._set(body)
        sid = body.get("snippet_id")
        if not isinstance(sid, str) or not sid:
            raise _bad("snippet_id is missing")
        if sid.startswith("g-"):
            raise ApiError(409, "guided_snippet", "This snippet is made from a reference annotation of a guided "
                           "recording, so it stays while that recording is guided.")
        if not any(s.get("snippet_id") == sid for s in rs0.snippets):
            return {}
        with self.service.administration._editing(rs0.set_id) as rs:
            rs.remove_snippet(sid)
        audit.record(self.store, user.annotator_id, op, f"Removed the snippet {sid} from {rs0.set_id}",
                     {"set_id": rs0.set_id, "snippet_id": sid})
        return {}

    # ========================================= what the study team does after an assessment
    def _trainee(self, body: dict[str, Any]) -> tuple[str, ReferenceSet]:
        from electrotag.web.admin import _aid

        aid = _aid(body.get("annotator_id"))
        if self.store.user_record(aid) is None:
            raise ApiError(404, "unknown_user", f"{aid} has no account in this study")
        set_id = self.store.programme(aid)
        if not set_id:
            raise ApiError(404, "no_programme", f"{aid} is not taking part in a training programme")
        return aid, self.service.reference_set(set_id)

    def _person(self, aid: str) -> User:
        rec = self.store.user_record(aid) or {}
        from electrotag.web.store import parse_roles

        return User(aid, rec.get("display_name", ""), roles=parse_roles(rec.get("roles") or rec.get("role")))

    def _after(self, aid: str, rs: ReferenceSet) -> tuple[str, str]:
        """(the assessment's state, its result): what the study team may do now."""
        a = next(s for s in self.coach._states(rs, aid)[0] if s.key == "assessment")
        return a.status, (self.store.report_status(rs.set_id, aid) if a.status == "completed" else "")

    def admin_gate_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``training_gate_get {annotator_id}`` → the trainee's training path (as ``GET /training``), the gate, the
        stage events (skips and the rest, with times; after a new assessment set, the earlier set's skips first,
        with ``set_name``), the earlier rounds of the assessment with their competency reports (``rounds``, each
        with ``html``), and which of the two actions after an assessment are open (``reopen``, ``new_set``), with
        the sets a new assessment could come from."""
        from electrotag.web.admin import _aid

        aid = _aid(body.get("annotator_id"))
        if self.store.user_record(aid) is None:
            raise ApiError(404, "unknown_user", f"{aid} has no account in this study")
        person = self._person(aid)
        set_id = self.store.programme(aid)
        out: dict[str, Any] = {"annotator_id": aid, "training_gate": self.gate(person), "programme": None,
                               "events": [], "skipped": [], "rounds": [], "can_reopen": False,
                               "can_assign_set": False, "assessment_sets": []}
        if not set_id:
            return out
        try:
            rs = self.store.reference_set(set_id)
        except ReferenceSetError:
            return out
        prog = self.store.progress(rs, aid)
        out["programme"] = self.coach.programme_view(person)
        keys = ("event", "stage", "at", "by", "from", "from_set", "set_name")
        events: list[dict[str, Any]] = []
        for e in prog.events:
            if not isinstance(e, dict):
                continue
            if e.get("event") == "assessment_set_assigned":  # the skips of the earlier set come first, named
                events.extend({"event": "stage_skipped", "stage": x.get("stage"), "at": x.get("at"),
                               "set_name": x.get("set_name") or e.get("from_set_name") or e.get("from_set")}
                              for x in e.get("skips") or [] if isinstance(x, dict))
            events.append({k: e.get(k) for k in keys if k in e})
        out["events"] = events
        out["skipped"] = stage_marks(prog.events).skipped
        from electrotag.training.assessment import competency_html

        out["rounds"] = []
        for r in self.rounds(prog.events, reports=True):
            report = r.pop("report", None) or {}
            try:
                r["html"] = competency_html(report) if report.get("status") else ""
            except (KeyError, TypeError, ValueError):
                r["html"] = ""
            out["rounds"].append(r)
        status, result = self._after(aid, rs)
        open_ = status == "completed" and result != "met"
        out["can_reopen"] = open_
        out["can_assign_set"] = open_
        from electrotag.web.quiz import allowed

        out["assessment_sets"] = [{"set_id": s.set_id, "name": s.name or s.set_id,
                                   "n_assessment": len(s.assessment_recordings)}
                                  for s in self.store.reference_sets()
                                  if s.assessment_recordings and s.set_id != set_id and allowed(s, aid)]
        return out

    def _require_after(self, aid: str, rs: ReferenceSet) -> None:
        status, result = self._after(aid, rs)
        if status != "completed":
            raise ApiError(409, "not_finished", f"{aid} has not finished the competency assessment of {rs.set_id} "
                           "yet; this is for after an assessment that did not meet the criteria.")
        if result == "met":
            raise ApiError(409, "already_met", f"{aid} has passed the competency assessment of {rs.set_id}; their "
                           "study recordings are open.")

    def admin_reopen(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``training_reopen {annotator_id, from?: "practice" | "guided"}``: after an assessment that did not meet
        the criteria, the trainee goes back to ``from`` (practice by default), works through the stages from there
        again and retakes the assessment. Only what they save from now on counts; everything saved before is kept, and
        the round that ended is kept with its competency report. The reopened stages cannot be skipped until they
        are done again. Audited."""
        aid, rs = self._trainee(body)
        first = body.get("from") or "practice"
        if first not in REOPEN_FROM:
            raise _bad("from must be practice or guided: the stage the trainee starts again from")
        self._require_after(aid, rs)
        counts = self.coach.saves(aid)
        modes = STAGES[STAGES.index(first):]
        baseline = {m: counts(aid, m, rs.set_id) for m in modes if m in ("guided", "practice", "assessment")}
        round_ = self._round(aid, rs)
        prog = self.store.progress(rs, aid)
        prog.note("training_reopened", **{"from": first, "by": user.annotator_id, "baseline": baseline,
                                          "practice_seen": {r: len(v) for r, v in prog.practice.items()},
                                          "round": round_})
        audit.record(self.store, user.annotator_id, "training_reopen",
                     f"Reopened the training of {aid} in {rs.set_id} from {STAGE_TITLES[first]}: they practise again "
                     "and retake the assessment", {"annotator_id": aid, "set_id": rs.set_id, "from": first})
        return self.admin_gate_get(user, {"annotator_id": aid})

    def admin_assessment_set(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``training_assessment_set {annotator_id, set_id}``: after an assessment that did not meet the criteria,
        the trainee takes the assessment of another set. Each learning stage is carried over as it was in the earlier
        set: done there, or skipped there ("Skipped in Pilot training set"), so that no skip is lost or counted as
        done; the earlier set's skips and rounds of the assessment come too, for the new competency report and the
        study team. Audited."""
        aid, old = self._trainee(body)
        new = self._set(body)
        if new.set_id == old.set_id:
            raise ApiError(409, "same_set", f"{aid} already takes {old.set_id}; to let them try its assessment again, "
                           "reopen their training instead.")
        if not new.assessment_recordings:
            raise ApiError(422, "no_assessment", f"{new.set_id} has no assessment recordings to take.")
        self.service.administration._allowed(new, aid)
        self._require_after(aid, old)
        old_states, old_prog = self.coach._states(old, aid)
        old_marks = stage_marks(old_prog.events)
        name = old.name or old.set_id
        # each learning stage as it was in the earlier set, with the set it was done or skipped in: a skip stays a skip
        stages = {}
        for st in old_states:
            if st.key not in LEARNING_STAGES:
                continue
            status = st.status if st.status in ("completed", "skipped", "not_used") else "completed"
            before = dict(dict((old_marks.carried or {}).get("stages") or {}).get(st.key) or {})
            origin = (old.set_id, name) if not st.carried else (
                str(before.get("set_id") or (old_marks.carried or {}).get("from_set") or ""), st.carried_from or name)
            stages[st.key] = {"status": status, "set_id": origin[0], "set_name": origin[1]}
        skips = [{**x, "set_id": x.get("set_id") or old.set_id, "set_name": x.get("set_name") or name}
                 for x in old_marks.skip_history]
        earlier = [{k: v for k, v in r.items() if k != "round"} for r in old_marks.rounds]
        round_ = self._round(aid, old)
        self.store.enrol(aid, new.set_id)
        self.store.progress(new, aid).note("assessment_set_assigned", from_set=old.set_id, from_set_name=name,
                                           by=user.annotator_id, stages=stages, skips=skips, earlier_rounds=earlier,
                                           round=round_)
        audit.record(self.store, user.annotator_id, "training_assessment_set",
                     f"{aid} takes the assessment of {new.set_id} after {old.set_id}",
                     {"annotator_id": aid, "set_id": new.set_id, "from_set": old.set_id})
        return self.admin_gate_get(user, {"annotator_id": aid})


__all__ = ["GATE_TEXT", "LEARNING_STAGES", "TrainingPath"]


# ------------------------------------------------- the expert channel (experts supply training material)
from electrotag.web.expert import expert_op  # noqa: E402 - registered once the class above exists


@expert_op("snippets_list")
def _expert_snippets_list(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    return service.training_path.snippets_list(user, body)


@expert_op("snippet_add")
def _expert_snippet_add(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    return service.training_path.snippet_add(user, body)


@expert_op("snippet_remove")
def _expert_snippet_remove(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    return service.training_path.snippet_remove(user, body)
