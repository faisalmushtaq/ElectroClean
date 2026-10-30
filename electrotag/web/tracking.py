"""Tracking: who has been given, has opened and has saved which study recordings, and when (docs/web/api.md,
"Datasets, collections, groups and hand-outs"). Every figure is derived from the assignments, the completion
register, the drafts, the visit index and the reports of recordings that cannot be annotated; nothing new is stored.

The notices that would be sent (a dataset newly fully rated, people with overdue work, a weekly summary) are
computed here too, for the admin area to list (``notify_preview_get``); nothing is sent.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from electrotag.web.errors import ApiError

if TYPE_CHECKING:
    from electrotag.web.service import StudyService
    from electrotag.web.store import User


class Tracking:
    """The tracking reads of the admin area (``Admin.op_<name>`` delegates here)."""

    def __init__(self, service: StudyService) -> None:
        self.service = service

    def forget(self) -> None:
        """Drop what this instance keeps of the figures (called after every administrative change)."""

    def op_tracking_datasets_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        raise ApiError(501, "not_offered", "This server does not offer tracking_datasets_get yet.")

    def op_tracking_recordings_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        raise ApiError(501, "not_offered", "This server does not offer tracking_recordings_get yet.")

    def op_notify_preview_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        raise ApiError(501, "not_offered", "This server does not offer notify_preview_get yet.")
