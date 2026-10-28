"""The study's audit log: who changed what, and when.

Every administrative operation that changes the study (``StudyService.admin``) and every
``electroclean-web`` command that does (with ``"by": "command"``) appends one entry::

    {"at": "2026-10-28T10:15:02.120+00:00", "by": "ADMIN", "op": "user_add",
     "summary": "Added A03 (Annotator three) as an annotator", "details": {...}}

The summary is one plain sentence for people; the details hold the values, never a password or a
password link. The files store keeps the log in its SQLite file and the Firestore store in
``studies/{study}/audit``; both list it newest first (``Store.audit_page``).
"""

from __future__ import annotations

from typing import Any

from electroclean.app.common import now_local_iso

#: Keys never written into an entry's details, whatever an operation passes.
SECRET_KEYS = {"password", "temporary_password", "invite_link", "token", "base64", "document"}


def _clean(value: Any, depth: int = 0) -> Any:
    if depth > 5:
        return None
    if isinstance(value, dict):
        return {str(k): _clean(v, depth + 1) for k, v in list(value.items())[:200] if str(k) not in SECRET_KEYS}
    if isinstance(value, (list, tuple)):
        return [_clean(v, depth + 1) for v in list(value)[:500]]
    if isinstance(value, str):
        return value[:2000]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value)[:2000]


def record(store: Any, by: str, op: str, summary: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    """Append an entry to the study's audit log and return it."""
    entry = {"at": now_local_iso(), "by": str(by), "op": str(op), "summary": str(summary)[:500],
             "details": _clean(dict(details or {}))}
    store.audit_append(entry)
    return entry


def count(n: int, one: str, many: str | None = None) -> str:
    """``1 recording``, ``3 recordings``."""
    return f"{n} {one if n == 1 else (many or one + 's')}"


__all__ = ["SECRET_KEYS", "count", "record"]
