"""Errors answered to the browser: ``{"error": code, "message": text}`` with an HTTP status.

Over HTTP (app.py) the status is the response's status. On Firebase (functions/main.py) the error
becomes an ``HttpsError`` whose code is chosen from the status (:data:`FIREBASE_CODES`) and whose
``details`` carry the same ``error`` code, so the browser handles both alike.
"""

from __future__ import annotations

from typing import Any

#: HTTP status -> Firebase callable error code (``FunctionsErrorCode`` values).
FIREBASE_CODES = {
    400: "invalid-argument",
    401: "unauthenticated",
    403: "permission-denied",
    404: "not-found",
    409: "already-exists",
    413: "invalid-argument",
    422: "failed-precondition",
    429: "resource-exhausted",
    500: "internal",
    503: "unavailable",
}


class ApiError(Exception):
    """An error for the annotator (or administrator), with a stable code the browser can act on."""

    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra

    def body(self) -> dict[str, Any]:
        return {"error": self.code, "message": self.message, **self.extra}

    @property
    def firebase_code(self) -> str:
        return FIREBASE_CODES.get(self.status, "unknown")
