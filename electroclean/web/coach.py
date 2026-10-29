"""The training programme on the server: stages, the guided coach, practice scores, the assessment.

The rules are those of the desktop application (electroclean/training/): the same stages and pass
rule (:mod:`~electroclean.training.programme`), the same matching, feedback and stars
(:mod:`~electroclean.training.guided`), the same practice feedback and review flags
(:mod:`~electroclean.training.assessment`, :mod:`~electroclean.training.review`) and the same
competency report. The experts' annotations stay here: the browser receives the feedback, the
dashed outline of a step whose guidance is ``show``, the annotation that Show me places and,
after a practice recording is saved, that recording's reference.
"""

from __future__ import annotations

import hashlib
import html
import math
import time
import uuid
from typing import TYPE_CHECKING, Any

from electroclean.app.annotations.model import ArtifactAnnotation
from electroclean.app.common import now_local_iso
from electroclean.training.guided import (
    STARS_FIRST,
    Step,
    Tolerance,
    article,
    build_steps,
    check_step,
    extras,
    list_words,
    overlaps,
    stars_for,
)
from electroclean.training.programme import PassRule, Progress, StageState, next_step, programme_state
from electroclean.training.reference import ReferenceSet, ReferenceSetError
from electroclean.training.review import flag_text, review_flags
from electroclean.web.errors import ApiError
from electroclean.web.manifest import manifest_info
from electroclean.web.store import User

if TYPE_CHECKING:
    from electroclean.web.service import StudyService, WorkItem

FIND_WINDOW_S = 10.0  # as the desktop coach: a "find" step shows at least 10 s
UNDO_HINT = "Ctrl+Z (⌘Z on a Mac) to undo"


def _signature(anns: list[ArtifactAnnotation]) -> str:
    text = repr(sorted((a.annotation_id, a.label, a.onset_sample, a.duration_samples, a.channels) for a in anns))
    return hashlib.sha1(text.encode()).hexdigest()


def minutes_text(seconds: float) -> str:
    seconds = float(seconds or 0.0)
    if seconds < 60:
        return f"{seconds:.0f} s"
    return f"{seconds / 60:.1f} min"


class Coach:
    def __init__(self, service: StudyService) -> None:
        self.service = service

    # ------------------------------------------------------------ helpers
    @property
    def store(self) -> Any:
        return self.service.store

    @staticmethod
    def _api(status: int, code: str, message: str, **extra: Any) -> ApiError:
        return ApiError(status, code, message, **extra)

    def _set(self, set_id: str) -> ReferenceSet | None:
        try:
            return self.store.reference_set(set_id)
        except ReferenceSetError:
            return None

    def _quick_keys(self) -> dict[str, int]:
        return {name: i for i, name in enumerate(self.service.settings.quick_labels, start=1)}

    def _states(self, rs: ReferenceSet, aid: str, prog: Progress | None = None) -> tuple[list[StageState], Progress]:
        prog = prog if prog is not None else self.store.progress(rs, aid)
        states = programme_state(None, rs, aid, prog, completed=self.store.completed,
                                 report_text=lambda: self.store.report_text(rs.set_id, aid))
        return states, prog

    def _next_step(self, rs: ReferenceSet, aid: str, states: list[StageState], prog: Progress) -> Any:
        return next_step(None, rs, aid, states, prog, completed=self.store.completed)

    # ---------------------------------------------------------- programme
    def programme_recordings(self, user: User, set_id: str) -> list[tuple[str, str, bool]]:
        """(recording, mode, repeat) for every recording of the unlocked stages of the trainee's programme."""
        rs = self._set(set_id)
        if rs is None:
            return []
        states_list, prog = self._states(rs, user.annotator_id)
        states = {s.key: s for s in states_list}
        nxt = self._next_step(rs, user.annotator_id, states_list, prog)
        out: list[tuple[str, str, bool]] = []
        for key, recordings in (("guided", rs.guided_recordings), ("practice", rs.practice_recordings),
                                ("assessment", rs.assessment_recordings)):
            if states[key].unlocked:
                for rid in recordings:
                    out.append((rid, key, bool(nxt.repeat and nxt.stage == key and nxt.recording_id == rid)))
        return out

    def next_item(self, user: User, set_id: str, items: list[WorkItem]) -> WorkItem | None:
        rs = self._set(set_id)
        if rs is None:
            return None
        states, prog = self._states(rs, user.annotator_id)
        nxt = self._next_step(rs, user.annotator_id, states, prog)
        if nxt.stage is None:
            return None
        mine = [i for i in items if i.source == "programme" and i.mode == nxt.stage and i.context_id == set_id]
        if nxt.recording_id is not None:
            return next((i for i in mine if i.recording_id == nxt.recording_id), None)
        open_items = [i for i in mine if i.status != "done"]
        started = [i for i in open_items if i.status == "in_progress"]
        if started:
            return started[0]
        order = rs.assessment_recordings if nxt.stage == "assessment" else rs.practice_recordings
        return next((i for r in order for i in open_items if i.recording_id == r), None)

    def require_unlocked(self, user: User, item: WorkItem) -> None:
        """Programme recordings of a stage that is still locked are refused (they are not listed either)."""
        if item.source != "programme":
            return
        rs = self._set(item.context_id)
        if rs is None:
            raise self._api(404, "no_reference_set", f"The training set {item.context_id} was not found")
        states = {s.key: s for s in self._states(rs, user.annotator_id)[0]}
        if item.mode in states and not states[item.mode].unlocked:
            raise self._api(403, "locked", f"{states[item.mode].title} is not unlocked yet")

    def programme_view(self, user: User) -> dict[str, Any]:
        set_id = self.store.programme(user.annotator_id)
        if not set_id:
            raise self._api(404, "no_programme", "You are not taking part in a training programme")
        rs = self._set(set_id)
        if rs is None:
            raise self._api(404, "no_reference_set", f"The training set {set_id} was not found on the server")
        states, prog = self._states(rs, user.annotator_id)
        nxt = self._next_step(rs, user.annotator_id, states, prog)
        best = prog.best_practice()
        stages = []
        for s in states:
            stages.append({
                "key": s.key, "title": s.title, "description": s.description, "status": s.status,
                "done": s.done, "total": s.total, "stars": s.stars, "max_stars": s.max_stars,
                "best_score": (round(float(best.get("event_f1", 0.0)), 4) if (s.key == "practice" and best) else None),
                "time_s": round(float(s.seconds), 1), "detail": s.detail,
            })
        next_view = None
        if nxt.stage is not None:
            item = self.next_item(user, set_id, self.service.work_items(user))
            next_view = {"stage": nxt.stage, "recording_id": item.recording_id if item else None,
                         "label": nxt.label, "text": nxt.text, "mode": nxt.stage, "context_id": set_id,
                         "file_name": item.manifest["file_name"] if item else None, "repeat": nxt.repeat}
        return {"set_id": rs.set_id, "name": rs.name or rs.set_id, "description": rs.description,
                "stages": stages, "next": next_view, "complete": nxt.stage is None, "message": nxt.text}

    # -------------------------------------------------------------- guided
    def _guided(self, user: User, recording_id: str) -> tuple[ReferenceSet, WorkItem]:
        items = [i for i in self.service.work_items(user) if i.mode == "guided" and i.recording_id == recording_id]
        if not items:
            raise self._api(404, "not_assigned", f"{recording_id} is not one of your recordings for learning with "
                            "the experts")
        item = items[0]
        if item.status == "done":
            raise self._api(409, "already_done", f"You have already completed {recording_id}")
        rs = self._set(item.context_id)
        if rs is None:
            raise self._api(404, "no_reference_set", f"The training set {item.context_id} was not found")
        self.require_unlocked(user, item)
        return rs, item

    def _steps(self, rs: ReferenceSet, recording_id: str) -> list[Step]:
        try:
            ref = rs.reference_document(recording_id)
        except ReferenceSetError as exc:
            raise self._api(500, "reference_unavailable", "The experts' annotations for this recording cannot be "
                            "read; please tell the study administrator.") from exc
        return build_steps(ref, dict(rs.guided.get("notes", {})))

    def _state(self, user: User, rs: ReferenceSet, rid: str) -> dict[str, Any]:
        st = self.store.guided_state(user.annotator_id, rs.set_id, rid)
        if st is None:
            st = {"index": 0, "matched": {}, "failed": {}, "shown": [], "stars": {}, "seconds": {},
                  "step_started": time.time(), "signature": None, "last": None, "complete": False,
                  "summary": None, "started_at": now_local_iso()}
        return st

    def _save(self, user: User, rs: ReferenceSet, rid: str, st: dict[str, Any]) -> None:
        self.store.save_guided_state(user.annotator_id, rs.set_id, rid, st)

    @staticmethod
    def _matched(st: dict[str, Any]) -> dict[int, str]:
        return {int(k): v for k, v in st["matched"].items()}

    def _view_for(self, guidance: str, steps: list[Step], i: int, sfreq: float,
                  n_samples: int) -> dict[str, Any] | None:
        t = steps[i].target
        total = n_samples / sfreq
        display = float(self.service.settings.display.duration_s)
        t0, t1 = t.onset_sample / sfreq, t.end_sample / sfreq
        if guidance == "show":
            window = display
            start = t0 if (t1 - t0) > window else t0 - (window - (t1 - t0)) / 2
        elif guidance == "find":
            window = max(display, FIND_WINDOW_S)
            if t1 - t0 >= window - 1.0:
                start = t0 - 0.5
            else:
                share = 0.15 + 0.7 * ((i * 0.618) % 1.0)  # where on the screen the artifact starts
                start = t0 - share * (window - (t1 - t0))
        else:
            return None
        start = min(max(0.0, start), max(0.0, total - window))
        return {"start_s": round(start, 4), "duration_s": window}

    def _step_view(self, rs: ReferenceSet, rid: str, steps: list[Step], i: int, m: dict[str, Any]) -> dict[str, Any]:
        guidance = rs.guidance_for(rid)
        t = steps[i].target
        cat = self.store.catalogue
        key = self._quick_keys().get(t.label)
        key_text = f"press {key}" if key else "press / and type its name"
        where = ("the whole montage (Whole montage, or C)" if t.is_global
                 else f"{list_words(list(t.channels))} (Selected channels, then click the channel names)")
        if guidance == "show":
            instruction = f"Mark this {t.label}"
            text = (f"The experts' annotation is outlined with a dashed line. Choose its type ({key_text}), choose "
                    f"{where}, and drag across it from start to end (or press M at the start and at the end).")
        elif guidance == "find":
            instruction = f"Find the {t.label} on this screen"
            text = (f"There is {article(t.label)} {t.label} somewhere on this screen. Choose its type ({key_text}), "
                    "decide which channels it affects, and mark it.")
        else:
            instruction = "Find the next artifact"
            text = ("Scroll on from here. Mark the next artifact you see, choose its type and channels, and the "
                    "feedback tells you how close you are to the experts.")
        named = guidance in ("show", "find")
        timing = m["timing"]
        sfreq, n_samples = float(timing["sfreq"]), int(timing["n_samples"])
        return {
            "step": i + 1, "n_steps": len(steps), "guidance": guidance, "instruction": instruction, "text": text,
            "label": t.label if named else None,
            "description": cat.get(t.label).description if named else "",
            "note": (steps[i].note or None) if named else None,
            "ghost": ({"onset_sample": t.onset_sample, "duration_samples": t.duration_samples,
                       "channels": list(t.channels)} if guidance == "show" else None),
            "view": self._view_for(guidance, steps, i, sfreq, n_samples),
        }

    def _summary(self, st: dict[str, Any], n: int, guidance: str) -> dict[str, Any]:
        stars = sum(int(v) for v in st["stars"].values())
        shown = set(int(x) for x in st["shown"])
        failed = {int(k): int(v) for k, v in st["failed"].items()}
        return {"steps": n, "stars": stars, "max_stars": STARS_FIRST * n,
                "failed_attempts": sum(failed.values()), "shown": len(shown),
                "seconds": round(sum(float(v) for v in st["seconds"].values()), 3), "guidance": guidance}

    @staticmethod
    def _public_summary(summary: dict[str, Any]) -> dict[str, Any]:
        n = int(summary.get("steps", 0))
        attempts = int(summary.get("failed_attempts", 0)) + n - int(summary.get("shown", 0))
        return {"steps": n, "stars": summary.get("stars", 0), "max_stars": summary.get("max_stars", 0),
                "attempts": attempts, "failed_attempts": summary.get("failed_attempts", 0),
                "shown": summary.get("shown", 0), "time_s": summary.get("seconds", 0.0)}

    def _parse(self, item: WorkItem, anns: Any) -> list[ArtifactAnnotation]:
        from electroclean.web.service import parse_annotations

        return parse_annotations(anns, manifest_info(item.manifest), self.store.catalogue,
                                 self.service.settings.min_duration_samples)

    def _expect_step(self, st: dict[str, Any], body: dict[str, Any], n: int) -> int:
        step = body.get("step")
        if isinstance(step, bool) or not isinstance(step, int):
            raise self._api(400, "bad_request", "step must be the number of the current step")
        if st["complete"] or st["index"] >= n:
            raise self._api(409, "complete", "Every step of this recording is already matched; save it now.")
        if step != st["index"] + 1:
            raise self._api(409, "wrong_step", f"You are at step {st['index'] + 1} of {n}, not step {step}.",
                            current_step=st["index"] + 1)
        return st["index"]

    def guided_view(self, user: User, rid: str) -> dict[str, Any]:
        rs, item = self._guided(user, rid)
        steps = self._steps(rs, rid)
        st = self._state(user, rs, rid)
        tol = Tolerance.from_dict(rs.guided.get("tolerance"))
        if not steps and not st["complete"]:
            st["complete"] = True
            st["summary"] = self._summary(st, 0, rs.guidance_for(rid))
        if self.store.guided_state(user.annotator_id, rs.set_id, rid) is None:
            self._save(user, rs, rid, st)
        matched = self._matched(st)
        completed = [{"step": i + 1, "stars": int(st["stars"].get(str(i), 0)), "annotation_id": matched[i]}
                     for i in sorted(matched)]
        current = None if st["complete"] else self._step_view(rs, rid, steps, st["index"], item.manifest)
        return {"recording_id": rid, "context_id": rs.set_id, "n_steps": len(steps), "guidance": rs.guidance_for(rid),
                "tolerance": {"seconds": tol.seconds, "fraction": tol.fraction, "channel_jaccard": tol.channel_jaccard},
                "completed": completed, "current": current, "complete": bool(st["complete"]),
                "summary": self._public_summary(st["summary"]) if st["complete"] and st["summary"] else None,
                "empty_message": ("The experts found no artifacts in this recording. Look through it, then save it."
                                  if not steps else None)}

    def _extra_messages(self, ext: list[ArtifactAnnotation], steps: list[Step], sfreq: float) -> list[str]:
        out = []
        for extra in ext[:1]:
            a, b = extra.onset_sample / sfreq, extra.end_sample / sfreq
            if any(overlaps(extra, s.target) for s in steps):
                out.append(f"You have marked this artifact twice ({extra.label}, {a:.2f}–{b:.2f} s): delete the extra "
                           f"one (select it and press Delete) or press {UNDO_HINT}.")
            else:
                out.append(f"Nothing is marked at {a:.2f}–{b:.2f} s in the experts' annotations: delete this "
                           f"{extra.label} (select it and press Delete) or press {UNDO_HINT}.")
        return out

    def guided_check(self, user: User, rid: str, body: dict[str, Any]) -> dict[str, Any]:
        rs, item = self._guided(user, rid)
        steps = self._steps(rs, rid)
        st = self._state(user, rs, rid)
        anns = self._parse(item, body.get("annotations"))
        sfreq = float(item.manifest["timing"]["sfreq"])
        matched = self._matched(st)
        if st["complete"] or st["index"] >= len(steps):
            ext = extras(steps, anns, matched)
            msgs = self._extra_messages(ext, steps, sfreq) or ["Everything matches the experts."]
            return {"matched": True, "candidate_id": None, "problems": ["extra"] if ext else [], "messages": msgs,
                    "extras": [a.annotation_id for a in ext], "can_continue": False, "stars": None, "complete": True}
        i = self._expect_step(st, body, len(steps))
        tol = Tolerance.from_dict(rs.guided.get("tolerance"))
        step = steps[i]
        result = check_step(step, anns, sfreq, tol, taken=set(matched.values()), quick_keys=self._quick_keys())
        ext = extras(steps, anns, matched, result, i)
        sig = _signature(anns)
        if sig != st["signature"] and result.candidate_id is not None and not result.matched:
            st["failed"][str(i)] = int(st["failed"].get(str(i), 0)) + 1
        st["signature"] = sig
        can = bool(result.matched and not ext)
        shown = i in {int(x) for x in st["shown"]}
        st["last"] = {"step": i + 1, "can_continue": can, "candidate_id": result.candidate_id}
        self._save(user, rs, rid, st)
        problems = [p for p in result.problems if p != "missing"] + (["extra"] if ext else [])
        if result.problems == ["missing"]:
            problems = ["missing"] + (["extra"] if ext else [])
        if ext:
            messages = self._extra_messages(ext, steps, sfreq)
        elif result.matched and shown:
            messages = ["This is how the experts marked it. Look at where it starts and ends and which channels it "
                        "covers, then press Continue."]
        elif result.matched:
            messages = [result.messages[0].rstrip(".") + ". Press Continue (Enter) for the next one."]
        else:
            messages = list(result.messages)
        out: dict[str, Any] = {
            "matched": bool(result.matched), "candidate_id": result.candidate_id, "problems": problems,
            "messages": messages, "extras": [a.annotation_id for a in ext], "can_continue": can,
            "stars": stars_for(int(st["failed"].get(str(i), 0)), shown) if can else None,
            "failed_attempts": int(st["failed"].get(str(i), 0)), "deltas": dict(result.deltas),
        }
        if result.matched and rs.guidance_for(rid) == "find_unnamed":
            t = step.target
            out["found"] = {"label": t.label, "description": self.store.catalogue.get(t.label).description,
                            "note": step.note or None}
        return out

    def guided_continue(self, user: User, rid: str, body: dict[str, Any]) -> dict[str, Any]:
        rs, item = self._guided(user, rid)
        steps = self._steps(rs, rid)
        st = self._state(user, rs, rid)
        i = self._expect_step(st, body, len(steps))
        last = st.get("last") or {}
        if last.get("step") != i + 1 or not last.get("can_continue"):
            raise self._api(409, "not_matched", "Match the experts' annotation (and remove anything extra) first.")
        shown = i in {int(x) for x in st["shown"]}
        failed = int(st["failed"].get(str(i), 0))
        st["matched"][str(i)] = last.get("candidate_id") or ""
        st["stars"][str(i)] = stars_for(failed, shown)
        # the time paused during the step (the browser's pause) does not count
        paused = body.get("paused_s", 0.0)
        if isinstance(paused, bool) or not isinstance(paused, (int, float)) or not math.isfinite(paused) or paused < 0:
            paused = 0.0
        wall = max(0.0, time.time() - float(st["step_started"]))
        st["seconds"][str(i)] = round(max(0.0, wall - float(paused)), 3)
        previous = {"step": i + 1, "stars": st["stars"][str(i)], "attempts": failed + (0 if shown else 1),
                    "failed_attempts": failed, "used_show_me": shown, "seconds": st["seconds"][str(i)]}
        st["index"] = i + 1
        st["step_started"] = time.time()
        st["last"] = None
        if st["index"] >= len(steps):
            st["complete"] = True
            st["summary"] = self._summary(st, len(steps), rs.guidance_for(rid))
            self._save(user, rs, rid, st)
            s = self._public_summary(st["summary"])
            return {"complete": True, "summary": s, "previous": previous,
                    "message": (f"You matched all {s['steps']} of the experts' annotations in "
                                f"{minutes_text(s['time_s'])}" + (f", {s['shown']} with Show me" if s["shown"] else "")
                                + ". Press Save and Finish to save your work.")}
        self._save(user, rs, rid, st)
        return {**self._step_view(rs, rid, steps, st["index"], item.manifest), "previous": previous}

    def guided_show_me(self, user: User, rid: str, body: dict[str, Any]) -> dict[str, Any]:
        rs, item = self._guided(user, rid)
        steps = self._steps(rs, rid)
        st = self._state(user, rs, rid)
        i = self._expect_step(st, body, len(steps))
        t = steps[i].target
        remove: list[str] = []
        if body.get("annotations") is not None:
            anns = self._parse(item, body.get("annotations"))
            taken = set(self._matched(st).values())
            candidate = (st.get("last") or {}).get("candidate_id")
            remove = [a.annotation_id for a in anns if a.annotation_id not in taken and overlaps(a, t)
                      and (a.annotation_id == candidate or a.label == t.label)]
        if i not in st["shown"]:
            st["shown"].append(i)
        st["last"] = None
        self._save(user, rs, rid, st)
        now = now_local_iso()
        timing = item.manifest["timing"]
        view = self._view_for("show", steps, i, float(timing["sfreq"]), int(timing["n_samples"]))
        return {"ghost": {"onset_sample": t.onset_sample, "duration_samples": t.duration_samples,
                          "channels": list(t.channels)},
                "annotation": {"annotation_id": uuid.uuid4().hex, "label": t.label, "onset_sample": t.onset_sample,
                               "duration_samples": t.duration_samples, "channels": list(t.channels),
                               "created_at": now, "modified_at": now},
                "replace": remove, "view": view, "stars": stars_for(0, True)}

    def verify_for_saving(self, user: User, rs: ReferenceSet, rid: str, anns: list[ArtifactAnnotation],
                          sfreq: float) -> dict[str, Any]:
        """Save and Finish of a guided recording: every step must still match and nothing extra be marked."""
        steps = self._steps(rs, rid)
        st = self._state(user, rs, rid)
        tol = Tolerance.from_dict(rs.guided.get("tolerance"))
        if not steps:
            st["complete"], st["summary"] = True, self._summary(st, 0, rs.guidance_for(rid))
        if not st["complete"]:
            raise self._api(422, "guided_incomplete", f"Match each of the experts' annotations first: you are at step "
                            f"{st['index'] + 1} of {len(steps)}.")
        matched = self._matched(st)
        for i, step in enumerate(steps):
            others = set(matched.values()) - {matched.get(i, "")}
            result = check_step(step, anns, sfreq, tol, taken=others, quick_keys=self._quick_keys())
            if not result.matched:
                for j in [k for k in matched if k >= i]:
                    for key in ("matched", "stars", "seconds"):
                        st[key].pop(str(j), None)
                st.update(index=i, complete=False, summary=None, last=None, signature=None, step_started=time.time())
                self._save(user, rs, rid, st)
                raise self._api(422, "guided_incomplete",
                                f"Step {i + 1} ({step.target.label}) no longer matches the experts' annotation: "
                                + " ".join(result.messages) + " It is shown again so you can put it right.",
                                step=i + 1)
            matched[i] = result.candidate_id or matched.get(i, "")
        if extras(steps, anns, matched):
            raise self._api(422, "guided_incomplete", "Some of your annotations are not in the experts' annotations. "
                            "Delete them before you save.")
        return dict(st["summary"] or self._summary(st, len(steps), rs.guidance_for(rid)))

    def record_guided(self, user: User, rs: ReferenceSet, rid: str, summary: dict[str, Any]) -> dict[str, Any]:
        try:
            self.store.progress(rs, user.annotator_id).record_guided(rid, summary)
        except OSError:
            pass
        self.store.clear_guided_state(user.annotator_id, rs.set_id, rid)
        s = self._public_summary(summary)
        message = (f"Recording saved: {s['stars']} of {s['max_stars']} stars ({minutes_text(s['time_s'])})."
                   if s["steps"] else "Recording saved.")
        return {"summary": s, "message": message}

    # ------------------------------------------------------------ practice
    def practice_result(self, user: User, rs: ReferenceSet, rid: str, mine: Any, elapsed_s: float,
                        sfreq: float) -> dict[str, Any]:
        from electroclean.training.assessment import feedback_html, practice_feedback
        from electroclean.web.service import annotation_dict, clean_json

        ref = rs.reference_document(rid)
        fb = practice_feedback(mine, ref, rs)
        rule = PassRule.from_dict(rs.practice_pass)
        verdict = rule.evaluate(fb)
        try:
            self.store.progress(rs, user.annotator_id).record_practice(rid, verdict, seconds=elapsed_s)
        except OSError:
            pass
        in_programme = self.store.programme(user.annotator_id) == rs.set_id
        unlock = " The assessment is unlocked." if (in_programme and rs.assessment_recordings) else ""
        if verdict["passed"]:
            verdict_html = (f"<p class='ec-pass'><b>Passed:</b> you reached the pass mark "
                            f"({html.escape(rule.describe())}).{unlock}</p>")
        else:
            verdict_html = (f"<p class='ec-not-yet'><b>Not yet:</b> you need {html.escape(rule.describe())}. Review "
                            "what you missed, then try the next practice recording or this one again.</p>")
        flags = []
        reference: list[dict[str, Any]] = []
        if rs.practice_review:
            mine_by_id = {a.annotation_id: a for a in mine.annotations}
            ref_by_id = {a.annotation_id: a for a in ref.annotations}
            for f in review_flags(fb, list(mine.annotations), list(ref.annotations), sfreq):
                source, _, aid = f["region"].partition("-")
                a = (ref_by_id if source == "ref" else mine_by_id).get(aid)
                if a is None:
                    continue
                flags.append({
                    "kind": f["kind"], "label": f.get("should_be", a.label),
                    "your_label": None if source == "ref" else a.label,
                    "onset_sample": a.onset_sample, "duration_samples": a.duration_samples,
                    "channels": list(a.channels), "annotation_id": a.annotation_id,
                    "source": "reference" if source == "ref" else "yours",
                    "onset_s": f["onset_s"], "offset_s": f["offset_s"], "text": flag_text(f),
                })
            reference = [annotation_dict(a) for a in ref.annotations]
        return clean_json({
            "passed": bool(verdict["passed"]), "pass_rule": rule.describe(), "rule": rule.to_dict(),
            "score": {"event_f1": verdict["event_f1"], "label_accuracy": verdict["label_accuracy"]},
            "metrics": dict(fb.get("overall", {})), "per_category": list(fb.get("per_category", [])),
            "summary_html": feedback_html(fb) + verdict_html, "review": bool(rs.practice_review),
            "flags": flags, "reference": reference,
        })

    # ---------------------------------------------------------- assessment
    def assessment_result(self, user: User, rs: ReferenceSet) -> dict[str, Any]:
        from electroclean.training.assessment import competency_summary_html

        total = rs.assessment_recordings
        done = self.store.completed(user.annotator_id, "assessment", rs.set_id) & set(total)
        if len(done) < len(total):
            return {"complete": False, "done": len(done), "total": len(total),
                    "message": "Your annotations for this assessment recording were saved."}
        rep = self.store.competency(rs, user.annotator_id)
        return {"complete": True, "done": len(done), "total": len(total), "status": rep.get("status"),
                "status_text": rep.get("status_text", ""),
                "summary_html": (f"<p>You have completed all assessment recordings in <b>"
                                 f"{html.escape(rs.name or rs.set_id)}</b>.</p>" + competency_summary_html(rep)),
                "message": "You have completed all assessment recordings."}
