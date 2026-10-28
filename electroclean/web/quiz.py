"""The short-segment quiz for annotators (``POST /quiz/{set_id}``, ``ec_quiz``).

The rules are the desktop's (:mod:`electroclean.training.quiz`): the items of a reference set in
each annotator's own order (:func:`~electroclean.training.quiz.item_order`), every label of the
catalogue as an answer, plus "No artifact / none of these" when the set offers it, an answer
judged with :meth:`~electroclean.training.reference.QuizItem.is_correct`, and the score of
:meth:`~electroclean.training.quiz.QuizSession.score`. When the annotator finishes, the result is
saved as the desktop saves it (``training/<set>/quiz/annotator-<ID>_quiz_<mode>_<session>.json`` in
the results folder), so the export and the results zip include it.

A set's ``quiz.feedback`` says when the annotator learns whether an answer was right:
``immediate`` (the desktop's practice quiz) or ``end`` (its assessment quiz). The correct answers
never reach the browser before then. Where the annotator is (their answers so far) is kept by the
server, so the quiz survives a reload or another computer; each answer is kept in one step, so an
answer sent twice (a key pressed again while waiting) is kept once.
"""

from __future__ import annotations

import math
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from electroclean.app.common import new_session_id, now_local_iso
from electroclean.training.quiz import QuizSession, item_order
from electroclean.training.reference import NONE_OPTION, QuizItem, ReferenceSet, ReferenceSetError
from electroclean.web.errors import ApiError
from electroclean.web.manifest import SCOPE_STUDY, set_scope
from electroclean.web.store import ResultExists, User

if TYPE_CHECKING:
    from electroclean.web.service import StudyService

FEEDBACK = ("immediate", "end")
ACTIONS = ("get", "answer", "finish")


def feedback_of(rs: ReferenceSet) -> str:
    f = rs.quiz.get("feedback")
    return f if f in FEEDBACK else "immediate"


def quiz_mode(rs: ReferenceSet) -> str:
    """The desktop's name for the kind of quiz: practice (feedback at once) or assessment (at the end)."""
    return "practice" if feedback_of(rs) == "immediate" else "assessment"


def allowed(rs: ReferenceSet, annotator_id: str) -> bool:
    """A set's quiz is for the annotators allowed to use the set (everyone when it names nobody)."""
    names = [a.upper() for a in rs.assigned_annotators]
    return not names or annotator_id.upper() in names


def _score(qs: QuizSession) -> dict[str, Any]:
    s = qs.score()
    return {k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in s.items()}


class Quizzes:
    def __init__(self, service: StudyService) -> None:
        self.service = service

    @property
    def store(self) -> Any:
        return self.service.store

    # ------------------------------------------------------------- listing
    def available(self, user: User) -> list[dict[str, Any]]:
        """The quizzes the annotator may take (``quizzes`` in ``GET /me``)."""
        out = []
        for rs in self.store.reference_sets():
            if not rs.quiz_items or not allowed(rs, user.annotator_id):
                continue
            state = self.store.quiz_state(user.annotator_id, rs.set_id) or {}
            out.append({"set_id": rs.set_id, "name": rs.name or rs.set_id, "n_items": len(rs.quiz_items),
                        "finished": bool(state.get("finished")), "feedback": feedback_of(rs)})
        return out

    # ------------------------------------------------------------ the calls
    def run(self, user: User, set_id: Any, body: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(set_id, str) or not set_id:
            raise ApiError(400, "bad_request", "set_id is missing")
        action = body.get("action")
        if action not in ACTIONS:
            raise ApiError(400, "bad_request", f"action must be one of {', '.join(ACTIONS)}")
        rs = self._set(user, set_id)
        items = item_order(rs.quiz_items, user.annotator_id, rs.set_id)
        return getattr(self, f"_{action}")(user, rs, items, body)

    def _set(self, user: User, set_id: str) -> ReferenceSet:
        try:
            rs = self.store.reference_set(set_id)
        except ReferenceSetError as exc:
            raise ApiError(404, "no_reference_set", f"There is no reference set {set_id} in this study") from exc
        if not allowed(rs, user.annotator_id):
            raise ApiError(403, "not_allowed", "This quiz is not one of yours. Ask your study administrator.")
        if not rs.quiz_items:
            raise ApiError(404, "no_quiz", f"{rs.name or rs.set_id} has no quiz")
        return rs

    def _options(self, rs: ReferenceSet) -> list[str]:
        labels = list(self.store.catalogue.label_names)
        return labels + ([NONE_OPTION] if rs.quiz.get("include_none_option", False) else [])

    @staticmethod
    def _new_state() -> dict[str, Any]:
        return {"session_id": new_session_id(), "started_at": now_local_iso(), "answers": {}, "finished": False,
                "finished_at": None, "score": None, "result_file": None}

    def _reveal(self, rs: ReferenceSet, state: dict[str, Any]) -> bool:
        return feedback_of(rs) == "immediate" or bool(state.get("finished"))

    def _get(self, user: User, rs: ReferenceSet, items: list[QuizItem], body: dict[str, Any]) -> dict[str, Any]:
        state = self.store.update_quiz_state(user.annotator_id, rs.set_id,
                                             lambda old: None if old else self._new_state()) or self._new_state()
        scope = set_scope(rs.set_id) if rs.self_contained else SCOPE_STUDY
        options = self._options(rs)
        recordings: dict[str, Any] = {}
        out_items = []
        for it in items:
            if it.recording_id not in recordings:
                m = self.store.manifest(scope, it.recording_id)
                if m is not None:
                    recordings[it.recording_id] = self.service.public_manifest(m)
            m_pub = recordings.get(it.recording_id)
            out_items.append({"item_id": it.item_id, "recording_id": it.recording_id,
                              "file_name": m_pub["file_name"] if m_pub else Path(it.recording_id).name,
                              "start_s": it.start_s, "end_s": it.end_s, "context_s": it.context_s,
                              "options": options})
        reveal = self._reveal(rs, state)
        by_id = {it.item_id: it for it in items}
        answered = {}
        for iid, rec in state["answers"].items():
            entry: dict[str, Any] = {"label": rec["answer"], "correct": bool(rec["correct"]) if reveal else None}
            if reveal and iid in by_id:
                entry.update(correct_label=by_id[iid].correct_label, explanation=by_id[iid].explanation or None)
            answered[iid] = entry
        return {"set_id": rs.set_id, "name": rs.name or rs.set_id, "items": out_items, "answered": answered,
                "feedback": feedback_of(rs), "finished": bool(state.get("finished")),
                "score": state.get("score") if state.get("finished") else None, "n_items": len(items),
                "recordings": recordings}

    def _answer(self, user: User, rs: ReferenceSet, items: list[QuizItem], body: dict[str, Any]) -> dict[str, Any]:
        iid, label = body.get("item_id"), body.get("label")
        item = next((it for it in items if it.item_id == iid), None)
        if item is None:
            raise ApiError(404, "unknown_item", "This quiz has no such segment")
        if not isinstance(label, str) or label not in self._options(rs):
            raise ApiError(400, "bad_label", "The answer must be one of the quiz's artifact types")
        rt = body.get("response_time_s")
        if rt is not None and (isinstance(rt, bool) or not isinstance(rt, (int, float)) or not math.isfinite(rt)
                               or not 0 <= rt <= 86400):
            raise ApiError(400, "bad_request", "response_time_s must be a number of seconds")

        def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
            st = old or self._new_state()
            if st.get("finished"):
                raise ApiError(409, "finished", "You have already finished this quiz")
            prev = st["answers"].get(item.item_id)
            if prev is not None:
                if prev["answer"] == label:
                    return None  # the same answer sent again: kept once
                raise ApiError(409, "already_answered", "You have already answered this segment",
                               label=prev["answer"])
            st["answers"][item.item_id] = {
                "item_id": item.item_id, "answer": label, "correct_label": item.correct_label,
                "correct": item.is_correct(label), "response_time_s": None if rt is None else round(float(rt), 3),
                "answered_at": now_local_iso(), "index": len(st["answers"]) + 1}
            return st

        state = self.store.update_quiz_state(user.annotator_id, rs.set_id, change) or {}
        rec = state.get("answers", {}).get(item.item_id, {})
        now = feedback_of(rs) == "immediate"
        return {"correct": bool(rec.get("correct")) if now else None,
                "correct_label": item.correct_label if now else None,
                "explanation": (item.explanation or None) if now else None,
                "n_answered": len(state.get("answers", {})), "n_items": len(items)}

    def _finish(self, user: User, rs: ReferenceSet, items: list[QuizItem], body: dict[str, Any]) -> dict[str, Any]:
        from electroclean.app.io.naming import OutputLayout

        aid = user.annotator_id
        state = self.store.quiz_state(aid, rs.set_id) or self._new_state()
        if state.get("finished"):
            return {"score": state.get("score")}
        qs = QuizSession(rs, aid, quiz_mode(rs), items=list(items),
                         answers={k: {x: v for x, v in a.items() if x != "index"}
                                  for k, a in sorted(state["answers"].items(), key=lambda kv: kv[1].get("index", 0))},
                         session_id=state["session_id"], started_at=state["started_at"])
        score = _score(qs)
        with tempfile.TemporaryDirectory(prefix="electroclean-quiz-") as tmp:
            layout = OutputLayout(Path(tmp))
            path = qs.save(layout)
            rel = path.relative_to(layout.root).as_posix()
            data = path.read_bytes()
        try:
            self.store.put_result_file(rel, data)
        except ResultExists:
            pass  # finished by another request just now (a key pressed twice): the result is saved once

        def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
            st = old or state
            if st.get("finished"):
                return None
            return {**st, "finished": True, "finished_at": now_local_iso(), "score": score, "result_file": rel}

        kept = self.store.update_quiz_state(aid, rs.set_id, change) or {}
        return {"score": kept.get("score", score)}
