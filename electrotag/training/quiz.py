"""Short-segment quiz: identify the principal artifact type in brief EEG excerpts.

This complements, and does not replace, the continuous-annotation assessment:
it tests recognition of artifact types only, not boundaries or channels. Items
are defined by the administrator in the reference set (recording, start, end,
correct label and optionally other acceptable labels). The order is shuffled
reproducibly for each annotator.
"""

from __future__ import annotations

import hashlib
import random
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from electrotag import __version__
from electrotag.app.common import new_session_id, now_local_iso
from electrotag.app.io.atomic import atomic_write_json
from electrotag.app.io.naming import OutputLayout
from electrotag.training.reference import NONE_OPTION, QuizItem, ReferenceSet

__all__ = ["NONE_OPTION", "QuizSession", "item_order"]


def item_order(items: list[QuizItem], annotator_id: str, set_id: str) -> list[QuizItem]:
    seed = int(hashlib.sha256(f"{set_id}:{annotator_id}".encode()).hexdigest()[:16], 16)
    order = sorted(items, key=lambda it: it.item_id)
    random.Random(seed).shuffle(order)
    return order


@dataclass
class QuizSession:
    reference_set: ReferenceSet
    annotator_id: str
    mode: str  # "assessment" (no feedback until the end) or "practice" (feedback after each item)
    items: list[QuizItem] = field(default_factory=list)
    answers: dict[str, dict[str, Any]] = field(default_factory=dict)
    session_id: str = field(default_factory=new_session_id)
    started_at: str = field(default_factory=now_local_iso)
    include_none_option: bool = False
    _shown_at: float | None = None

    def __post_init__(self) -> None:
        if not self.items:
            self.items = item_order(self.reference_set.quiz_items, self.annotator_id, self.reference_set.set_id)
        self.include_none_option = bool(self.reference_set.quiz.get("include_none_option", False))

    @property
    def feedback_immediately(self) -> bool:
        return self.mode == "practice"

    def options(self, labels: tuple[str, ...]) -> list[str]:
        return list(labels) + ([NONE_OPTION] if self.include_none_option else [])

    def current_index(self) -> int:
        return len(self.answers)

    def current_item(self) -> QuizItem | None:
        i = self.current_index()
        return self.items[i] if i < len(self.items) else None

    def item_shown(self) -> None:
        self._shown_at = time.monotonic()

    def answer(self, label: str) -> bool:
        item = self.current_item()
        if item is None:
            raise IndexError("The quiz is already finished")
        rt = time.monotonic() - self._shown_at if self._shown_at is not None else None
        correct = item.is_correct(label)
        self.answers[item.item_id] = {
            "item_id": item.item_id,
            "answer": label,
            "correct_label": item.correct_label,
            "correct": correct,
            "response_time_s": None if rt is None else round(rt, 3),
            "answered_at": now_local_iso(),
        }
        self._shown_at = None
        return correct

    @property
    def finished(self) -> bool:
        return len(self.answers) == len(self.items)

    def score(self) -> dict[str, Any]:
        n = len(self.answers)
        correct = sum(a["correct"] for a in self.answers.values())
        by_cat: dict[str, dict[str, int]] = {}
        confusion: dict[str, dict[str, int]] = {}
        for a in self.answers.values():
            c = by_cat.setdefault(a["correct_label"], {"items": 0, "correct": 0})
            c["items"] += 1
            c["correct"] += int(a["correct"])
            row = confusion.setdefault(a["correct_label"], {})
            row[a["answer"]] = row.get(a["answer"], 0) + 1
        return {
            "n_items": len(self.items),
            "n_answered": n,
            "n_correct": correct,
            "proportion_correct": correct / n if n else float("nan"),
            "by_category": by_cat,
            "confusion": confusion,
        }

    def save(self, layout: OutputLayout) -> Path:
        out = (
            layout.root / "training" / self.reference_set.set_id / "quiz"
            / f"annotator-{self.annotator_id}_quiz_{self.mode}_{self.session_id}.json"
        )
        s = self.score()
        atomic_write_json(
            out,
            {
                "schema": "electrotag.quiz_result",
                "schema_version": "1.0.0",
                "annotator_id": self.annotator_id,
                "reference_set_id": self.reference_set.set_id,
                "mode": self.mode,
                "session_id": self.session_id,
                "completed": self.finished,
                "started_at": self.started_at,
                "finished_at": now_local_iso(),
                "electrotag_version": __version__,
                "items": [it.to_dict() for it in self.items],
                "answers": [self.answers[it.item_id] for it in self.items if it.item_id in self.answers],
                "score": {k: (None if isinstance(v, float) and v != v else v) for k, v in s.items()},
                "note": "Short-segment recognition quiz; complements the continuous annotation assessment.",
            },
            overwrite=False,
        )
        return out
