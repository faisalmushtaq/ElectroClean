"""Datasets, collections, groups and hand-outs (docs/web/api.md, "Datasets, collections, groups and hand-outs").

A study recording belongs to one *source dataset* (``registration.dataset_id`` in its manifest; none means the
built-in default dataset, :data:`DEFAULT_DATASET_ID`). A *collection* is a hand-picked list of study recordings
from any datasets, a *group* a named set of people, and a *hand-out* gives a dataset or collection to people and
groups: everyone gets all of it, or it is shared out k per recording through :class:`electrotag.web.tasks.Tasks`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from electrotag.web.errors import ApiError

if TYPE_CHECKING:
    from electrotag.web.service import StudyService
    from electrotag.web.store import User

#: The built-in dataset of the recordings registered without one (it has a record only once it is edited).
DEFAULT_DATASET_ID = "study-recordings"
DEFAULT_DATASET_NAME = "Study recordings"


def _not_offered(op: str) -> ApiError:
    return ApiError(501, "not_offered", f"This server does not offer {op} yet.")


class Datasets:
    """The admin operations on datasets, collections, groups and hand-outs (``Admin.op_<name>`` delegates here)."""

    def __init__(self, service: StudyService) -> None:
        self.service = service

    def __getattr__(self, name: str) -> Any:
        if name.startswith("op_"):
            def op(user: User, body: dict[str, Any]) -> dict[str, Any]:
                raise _not_offered(name[3:])

            return op
        raise AttributeError(name)
