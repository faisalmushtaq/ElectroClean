"""The game elements of an annotator's home page (docs/web/api.md, "Achievements").

``GET /me/achievements`` (``et_achievements`` on Firebase) gives an annotator the facts that their
counters, milestones and personal goal are drawn from, the whole team's progress through the
recordings it was given, and an anonymised leaderboard; ``POST /me/achievements`` sets the personal
goal and whether the annotator appears on the leaderboard. The browser turns the facts into
milestones (``js/games/milestones.js``), so the rules live in one place and are tested there.

What is rewarded is progress through the assigned recordings and thoroughness (recordings viewed
in full), never speed and never the number of annotations: rewarding counts would push annotators
to mark more artifacts than they see, and the annotations are the research data
(docs/design_decisions.md, "Game elements"). The number of annotations is reported only for
interest, and nothing is ranked by it.

The leaderboard shows pseudonyms (an adjective and an animal) made from a keyed hash of each
annotator ID with a secret of the study that the store keeps and never sends, so no annotator's ID
reaches anyone else; it ranks by recordings completed (or only those viewed in full), shows the top
ten and the caller's own place, leaves out anyone who chose to be hidden, and appears only when at
least three people are on it, so that nobody can tell who the others are by elimination. The team's
progress is left out when exactly one other person has recordings, since an annotator's own figures
taken from the team's would then be that person's.
"""

from __future__ import annotations

import hashlib
import hmac
import math
import time
from typing import TYPE_CHECKING, Any

from electrotag.web.errors import ApiError
from electrotag.web.store import User, attempt_of, item_key, latest_entry

if TYPE_CHECKING:
    from electrotag.web.service import StudyService

#: Kind, ordinary words in UK English; an adjective and an animal make a pseudonym ("Steady Heron").
ADJECTIVES = (
    "Amber", "Bold", "Bright", "Brisk", "Calm", "Careful", "Cheerful", "Clever", "Cosy", "Curious", "Dapper",
    "Eager", "Gentle", "Golden", "Hardy", "Honest", "Jolly", "Keen", "Kind", "Lively", "Loyal", "Mellow",
    "Merry", "Modest", "Nimble", "Patient", "Plucky", "Polite", "Quiet", "Radiant", "Sensible", "Serene",
    "Silver", "Sincere", "Snug", "Spry", "Steady", "Sunny", "Thoughtful", "Tidy", "Trusty", "Valiant", "Warm",
    "Watchful", "Wise", "Witty", "Cordial", "Hopeful",
)
ANIMALS = (
    "Badger", "Beaver", "Blackbird", "Curlew", "Dormouse", "Dove", "Egret", "Falcon", "Finch", "Fox", "Gannet",
    "Goldfinch", "Hare", "Hedgehog", "Heron", "Kestrel", "Kingfisher", "Kite", "Lapwing", "Lark", "Lynx",
    "Magpie", "Marten", "Mole", "Moorhen", "Newt", "Nightingale", "Osprey", "Otter", "Owl", "Puffin", "Rabbit",
    "Raven", "Robin", "Seal", "Skylark", "Sparrow", "Squirrel", "Stoat", "Swallow", "Swan", "Tern", "Thrush",
    "Vole", "Wagtail", "Wren", "Plover", "Starling",
)
#: The share of a recording seen on screen from which it counts as viewed in full.
VIEWED_IN_FULL = 0.99
#: The leaderboard appears only when at least this many people are on it.
MIN_PEOPLE = 3
TOP = 10
MAX_GOAL = 200
SECRET = "leaderboard_pseudonyms"


def pseudonym(secret: str, annotator_id: str, salt: int = 0) -> str:
    """The pseudonym of an annotator: an HMAC-SHA256 of the ID keyed with the study's secret picks the words."""
    digest = hmac.new(bytes.fromhex(secret), f"{annotator_id.upper()}:{salt}".encode(), hashlib.sha256).digest()
    n = int.from_bytes(digest[:8], "big")
    return f"{ADJECTIVES[n % len(ADJECTIVES)]} {ANIMALS[(n // len(ADJECTIVES)) % len(ANIMALS)]}"


def pseudonyms(secret: str, annotator_ids: list[str]) -> dict[str, str]:
    """A different pseudonym for each annotator. The IDs come in the order the accounts were made, so that a
    pseudonym taken already sends only the newer account on to another (and earlier names never change)."""
    taken: set[str] = set()
    out: dict[str, str] = {}
    for aid in annotator_ids:
        salt = 0
        name = pseudonym(secret, aid, salt)
        while name in taken and salt < 1000:
            salt += 1
            name = pseudonym(secret, aid, salt)
        taken.add(name)
        out[aid] = name
    return out


def _number(value: Any) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def viewed_fraction(value: Any) -> float | None:
    """The share of a recording that was on screen, as the browser reports it (0 to 1), or None."""
    if isinstance(value, bool):
        return None
    v = _number(value)
    return round(v, 4) if v is not None and 0.0 <= v <= 1.0 else None


def saved_summary(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """What the history shows of one recording an annotator saved (one or more attempts)."""
    last = latest_entry(entries)
    times = sorted(str(e.get("completed_at") or "") for e in entries if e.get("completed_at"))
    elapsed = [v for v in (_number(e.get("elapsed_s")) for e in entries) if v is not None]
    n = _number(last.get("n_annotations"))
    return {"version": attempt_of(last), "saved_at": last.get("completed_at") or None,
            "first_saved_at": times[0] if times else None, "n_annotations": int(n) if n is not None else None,
            "elapsed_s": _number(last.get("elapsed_s")), "total_elapsed_s": round(sum(elapsed), 3) if elapsed else None}


class Games:
    """The achievements of one study's annotators (see the module docstring)."""

    def __init__(self, service: StudyService) -> None:
        self.service = service
        self._team: tuple[float, dict[str, Any]] | None = None

    @property
    def store(self) -> Any:
        return self.service.store

    @property
    def cache_s(self) -> float:
        # The team's figures read every saved recording; on Firestore they are kept for half a minute.
        return 30.0 if self.store.kind == "firestore" else 0.0

    # ------------------------------------------------------------------ answers
    def achievements(self, user: User, body: dict[str, Any] | None = None) -> dict[str, Any]:
        s = self.service.settings
        if not s.gamification_enabled:
            return {"enabled": False, "leaderboard_enabled": False}
        body = body or {}
        if "goal_per_week" in body or "leaderboard_hidden" in body:
            self._update(user, body)
        aid = user.annotator_id
        record = self.store.annotator_record(aid)
        mine: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for e in self.store.completion_entries(aid):
            if e.get("status") == "completed" and e.get("mode", "standard") == "standard":
                mine.setdefault((e["recording_id"], ""), []).append(e)
        viewed = dict(record.get("viewed") or {})
        completions = []
        worked = 0.0
        annotations = 0
        for (rid, _ctx), entries in mine.items():
            summary = saved_summary(entries)
            worked += summary["total_elapsed_s"] or 0.0
            annotations += summary["n_annotations"] or 0
            completions.append({"first_saved_at": summary["first_saved_at"],
                                "viewed_fraction": viewed_fraction(viewed.get(item_key(rid, "standard", "")))})
        completions.sort(key=lambda c: str(c["first_saved_at"] or ""))
        save_times = sorted(str(e.get("completed_at")) for es in mine.values() for e in es if e.get("completed_at"))
        with_coverage = [c for c in completions if c["viewed_fraction"] is not None]
        assigned = sum(1 for a in self.store.assignments(aid) if a.mode == "standard")
        team = self._team_view()
        return {
            "enabled": True,
            "leaderboard_enabled": bool(s.gamification_leaderboard),
            "counters": {"done": len(mine), "assigned": assigned, "worked_s": round(worked, 3),
                         "annotations": annotations},
            "completions": completions,
            "save_times": save_times,
            "viewed_in_full": (sum(1 for c in with_coverage if c["viewed_fraction"] >= VIEWED_IN_FULL)
                               if with_coverage else None),
            "goal": {"per_week": record.get("goal_per_week")},
            "team": self._team_out(aid, team),
            "leaderboard": self._leaderboard(aid, team, record) if s.gamification_leaderboard else None,
        }

    @staticmethod
    def _team_out(aid: str, team: dict[str, Any]) -> dict[str, Any]:
        """The team's progress, left out when exactly one other person has recordings: the team's figures
        less the caller's own would then be that person's."""
        others = team["people"] - (1 if aid in team["with_work"] else 0)
        if others == 1:
            return {"done": None, "assigned": None, "people": team["people"]}
        return {k: team[k] for k in ("done", "assigned", "people")}

    def _update(self, user: User, body: dict[str, Any]) -> None:
        changes: dict[str, Any] = {}
        if "goal_per_week" in body:
            goal = body["goal_per_week"]
            if goal is not None and (isinstance(goal, bool) or not isinstance(goal, int) or not 1 <= goal <= MAX_GOAL):
                raise ApiError(400, "bad_request", f"goal_per_week must be a whole number from 1 to {MAX_GOAL} "
                               "(or null for no goal)")
            changes["goal_per_week"] = goal
        if "leaderboard_hidden" in body:
            if not isinstance(body["leaderboard_hidden"], bool):
                raise ApiError(400, "bad_request", "leaderboard_hidden must be true or false")
            changes["leaderboard_hidden"] = body["leaderboard_hidden"]
        self.store.update_annotator_record(user.annotator_id, lambda old: {**old, **changes})
        self._team = None

    def record_viewed(self, user: User, recording_id: str, mode: str, context_id: str, value: Any) -> None:
        """Keep how much of a saved recording the annotator viewed (the most of any attempt)."""
        v = viewed_fraction(value)
        if v is None:
            return
        key = item_key(recording_id, mode, context_id)

        def change(old: dict[str, Any]) -> dict[str, Any] | None:
            seen = dict(old.get("viewed") or {})
            if (viewed_fraction(seen.get(key)) or -1.0) >= v:
                return None
            seen[key] = v
            return {**old, "viewed": seen}

        self.store.update_annotator_record(user.annotator_id, change)
        self._team = None

    # -------------------------------------------------------------- the team
    def _team_view(self) -> dict[str, Any]:
        now = time.monotonic()
        if self._team is not None and now - self._team[0] < self.cache_s:
            return self._team[1]
        people = [u for u in self.store.users() if "annotator" in (u.get("roles") or [u.get("role", "annotator")])]
        people.sort(key=lambda u: (str(u.get("created_at") or ""), u["annotator_id"]))
        ids = [u["annotator_id"] for u in people]
        given: dict[str, set[str]] = {aid: set() for aid in ids}
        for a in self.store.assignments():
            if a.mode == "standard" and a.annotator_id in given:
                given[a.annotator_id].add(a.recording_id)
        done: dict[str, set[str]] = {aid: set() for aid in ids}
        for e in self.store.completion_entries():
            aid = e.get("annotator_id", "")
            if aid in done and e.get("status") == "completed" and e.get("mode", "standard") == "standard":
                done[aid].add(e["recording_id"])
        records = self.store.annotator_records()
        full: dict[str, int] = {}
        for aid in ids:
            seen = (records.get(aid) or {}).get("viewed") or {}
            keys = {item_key(rid, "standard", "") for rid in done[aid]}
            full[aid] = sum(1 for k, v in seen.items() if k in keys and (viewed_fraction(v) or 0.0) >= VIEWED_IN_FULL)
        team = {"done": sum(len(done[a] & given[a]) for a in ids), "assigned": sum(len(given[a]) for a in ids),
                "people": sum(1 for a in ids if given[a]), "with_work": {a for a in ids if given[a]}, "ids": ids,
                "completed": {a: len(done[a]) for a in ids},
                "full": full, "hidden": {a for a in ids if (records.get(a) or {}).get("leaderboard_hidden") is True},
                "names": pseudonyms(self.store.study_secret(SECRET), ids)}
        self._team = (now, team)
        return team

    def _leaderboard(self, aid: str, team: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
        by_full = bool(self.service.settings.gamification_leaderboard_viewed_only)
        counts = team["full"] if by_full else team["completed"]
        names = team["names"]
        hidden_me = record.get("leaderboard_hidden") is True
        on = [a for a in team["ids"] if counts.get(a, 0) > 0 and a not in team["hidden"] and a != aid]
        if not hidden_me and counts.get(aid, 0) > 0:
            on.append(aid)
        on.sort(key=lambda a: (-counts[a], names[a]))
        ranks: dict[str, int] = {}
        for i, a in enumerate(on):
            ranks[a] = ranks[on[i - 1]] if i and counts[on[i - 1]] == counts[a] else i + 1
        enough = len(on) >= MIN_PEOPLE
        rows = [{"rank": ranks[a], "name": names[a], "count": counts[a], "you": a == aid} for a in on[:TOP]] \
            if enough else []
        you = {"name": names.get(aid, ""), "hidden": hidden_me, "count": counts.get(aid, 0),
               "rank": ranks.get(aid) if enough else None}
        return {"ranked_by": "viewed_in_full" if by_full else "completed", "rows": rows, "you": you,
                "people": len(on), "min_people": MIN_PEOPLE}
