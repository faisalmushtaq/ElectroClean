"""Where a study's records are kept: the storage interface of the web service.

:class:`~electroclean.web.service.StudyService` performs every operation of docs/web/api.md
against a :class:`Store`. There are two implementations:

* :class:`~electroclean.web.store_files.FilesStore`: a study folder with an SQLite file, used by the
  ElectroClean server (``electroclean-web serve`` and ``demo``). Results are written straight into
  ElectroClean's usual folders.
* :class:`~electroclean.web.store_firestore.FirestoreStore`: Firestore, used by the Firebase
  functions. Results are kept as documents and exported into the same folders with
  ``electroclean-web export``.

Both run the desktop application's own code to produce the result files, so the files are the same
whichever store is used.
"""

from __future__ import annotations

import copy
import hashlib
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from electroclean.config.settings import Settings, deep_merge, load_default_settings_dict

if TYPE_CHECKING:
    from electroclean.app.annotations.labels import LabelCatalogue
    from electroclean.app.session.session import AnnotationSession, FinishResult
    from electroclean.training.programme import Progress
    from electroclean.training.reference import ReferenceSet

MODES = ("standard", "guided", "practice", "assessment")
ROLES = ("annotator", "admin")


@dataclass(frozen=True)
class User:
    annotator_id: str
    display_name: str = ""
    role: str = "annotator"

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


@dataclass(frozen=True)
class Assignment:
    annotator_id: str
    recording_id: str
    mode: str = "standard"
    context_id: str = ""
    position: int = 0


@dataclass
class SavedResult:
    """What saving a submission produced (see :meth:`Store.save_results`)."""

    session: AnnotationSession
    result: FinishResult | None  # None when the files were written but the register update is pending
    files: dict[str, bytes]  # file name -> contents, as written
    attempt: int


def item_key(recording_id: str, mode: str, context_id: str) -> str:
    """A short, path-safe key for one recording in one mode and context."""
    return hashlib.sha1(f"{recording_id}|{mode}|{context_id}".encode()).hexdigest()[:20]


def settings_from_overrides(overrides: dict[str, Any] | None) -> Settings:
    """The desktop's settings: the defaults with a study's overrides (as in electroclean_study.json)."""
    return Settings.from_dict(deep_merge(load_default_settings_dict(), copy.deepcopy(overrides or {})))


class StoreError(RuntimeError):
    """The store cannot be used (for example a study that does not exist)."""


class Store(ABC):
    """Everything the web service reads and writes. Methods raise :class:`StoreError` on failure."""

    demo: bool = False
    #: The store's name in messages and in ``GET /health`` (``files`` or ``firestore``).
    kind: str = ""

    # ------------------------------------------------------------- the study
    @property
    @abstractmethod
    def study_id(self) -> str: ...

    @property
    @abstractmethod
    def name(self) -> str: ...

    @property
    @abstractmethod
    def settings(self) -> Settings: ...

    @property
    def catalogue(self) -> LabelCatalogue:
        from electroclean.app.annotations.labels import default_catalogue

        cat = getattr(self, "_catalogue", None)
        if cat is None:
            cat = default_catalogue()
            self._catalogue = cat
        return cat

    # -------------------------------------------------------------- manifests
    @abstractmethod
    def manifest(self, scope: str, recording_id: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def manifests(self) -> list[dict[str, Any]]: ...

    @abstractmethod
    def manifests_by_fingerprint(self, sha256: str, size: int) -> list[dict[str, Any]]: ...

    @abstractmethod
    def add_manifest(self, m: dict[str, Any]) -> None: ...

    # --------------------------------------------------------- reference sets
    @abstractmethod
    def reference_sets(self) -> list[ReferenceSet]: ...

    def reference_set(self, set_id: str) -> ReferenceSet:
        from electroclean.training.reference import ReferenceSetError

        for rs in self.reference_sets():
            if rs.set_id == set_id:
                return rs
        raise ReferenceSetError(f"Reference set {set_id!r} was not found in this study")

    @abstractmethod
    def add_reference_set(self, definition: dict[str, Any], files: dict[str, bytes]) -> None:
        """Store a reference set: its ``reference_set.json`` and its other files (paths relative to its folder),
        never its recordings."""

    # -------------------------------------------------- people and their work
    @abstractmethod
    def user(self, annotator_id: str) -> User | None: ...

    @abstractmethod
    def users(self) -> list[dict[str, Any]]: ...

    @abstractmethod
    def assignments(self, annotator_id: str | None = None) -> list[Assignment]: ...

    @abstractmethod
    def assign(self, annotator_id: str, recording_ids: list[str], *, mode: str = "standard",
               context_id: str = "") -> int: ...

    @abstractmethod
    def programme(self, annotator_id: str) -> str | None: ...

    @abstractmethod
    def enrol(self, annotator_id: str, set_id: str | None) -> None: ...

    # ------------------------------------------------------------------ drafts
    @abstractmethod
    def draft(self, annotator_id: str, key: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def draft_keys(self, annotator_id: str) -> set[str]: ...

    @abstractmethod
    def put_draft(self, annotator_id: str, key: str, record: dict[str, Any]) -> None: ...

    @abstractmethod
    def delete_draft(self, annotator_id: str, key: str) -> None: ...

    # ---------------------------------------------------------- guided state
    @abstractmethod
    def guided_state(self, annotator_id: str, set_id: str, recording_id: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def save_guided_state(self, annotator_id: str, set_id: str, recording_id: str, state: dict[str, Any]) -> None: ...

    @abstractmethod
    def clear_guided_state(self, annotator_id: str, set_id: str, recording_id: str) -> None: ...

    # ----------------------------------------------------------------- results
    @abstractmethod
    def completion_entries(self, annotator_id: str | None = None) -> list[dict[str, str]]:
        """Rows of the completion register (``completion_register.tsv`` columns)."""

    def completed(self, annotator_id: str, mode: str, context_id: str) -> set[str]:
        return {e["recording_id"] for e in self.completion_entries(annotator_id)
                if e.get("mode", "standard") == mode and e.get("context", "") == context_id
                and e.get("status") == "completed"}

    @abstractmethod
    def save_results(self, make_session: Callable[[Any], AnnotationSession], *, elapsed_s: float,
                     started_at: str) -> SavedResult:
        """Run Save and Finish of the session ``make_session(layout)`` makes, keeping the files it writes."""

    @abstractmethod
    def progress(self, rs: ReferenceSet, annotator_id: str) -> Progress:
        """The trainee's stars, scores and times (``Progress.save`` keeps changes)."""

    @abstractmethod
    def competency(self, rs: ReferenceSet, annotator_id: str) -> dict[str, Any]:
        """Produce and keep the competency report (as ``competency_report``) and return it."""

    @abstractmethod
    def report_text(self, set_id: str, annotator_id: str) -> str:
        """The one-sentence result of the trainee's competency report, if there is one."""

    # ----------------------------------------------------------------- visits
    @abstractmethod
    def visit_open(self, visit_id: str, annotator_id: str, mode: str, context_id: str, header: dict[str, Any],
                   started: Any) -> None:
        """Start a visit's interaction log with its header line (``started``: local datetime, for the name)."""

    @abstractmethod
    def visit(self, visit_id: str) -> dict[str, Any] | None:
        """``{"annotator_id", "closed", "last_t", "opened_at", "seq"}`` or None."""

    @abstractmethod
    def visit_append(self, visit_id: str, events: list[dict[str, Any]]) -> int:
        """Append events (without ``seq``): numbers them in order and returns how many were written."""

    @abstractmethod
    def visit_close(self, visit_id: str, event: dict[str, Any]) -> None:
        """Append the closing event (without ``seq``) and mark the visit closed."""


__all__ = ["MODES", "ROLES", "Assignment", "SavedResult", "Store", "StoreError", "User", "item_key",
           "settings_from_overrides"]
