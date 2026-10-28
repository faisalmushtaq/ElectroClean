"""Save and Finish for a recording annotated in the browser, with the desktop application's code.

:class:`WebSession` is the desktop's :class:`~electroclean.app.session.session.AnnotationSession`
with two differences: there are no source files to watch (the browser's checksum of the file it
showed is compared with the registered one instead), and the session file's ``application`` block
describes the server and the browser. Everything else, the validation, the five output files, the
checks of what was written and the completion register, is the desktop's own code.
"""

from __future__ import annotations

import platform
from typing import Any

from electroclean import APP_NAME, __version__
from electroclean.app.io.export import ExportError
from electroclean.app.io.locking import LockError
from electroclean.app.session.session import AnnotationSession, FinishResult, SessionError, library_versions
from electroclean.app.session.transaction import ExportCommitError
from electroclean.app.validation.exports import ValidationError
from electroclean.web.errors import ApiError


class WebSession(AnnotationSession):
    """The desktop's annotation session for a recording annotated in a browser (see the module docstring)."""

    def __init__(self, *, client: dict[str, Any] | None = None, server: str = "", session_id: str | None = None,
                 **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.client = dict(client or {})
        self.server = server
        if session_id:  # the browser's own session ID, so its interaction log and these results link up
            self.session_id = session_id
            self.lock.info["session_id"] = session_id

    def source_changes(self) -> list[str]:
        return []

    def application_info(self) -> dict[str, Any]:
        return {
            "name": APP_NAME,
            "version": __version__,
            "platform": platform.platform(),
            "libraries": library_versions(),
            "client": "web",
            "server": self.server,
            "browser": self.client,
            "note": "Annotated in the ElectroClean web application: the recording was read and shown in the "
                    "annotator's browser and never left their computer; these files were written by the study's "
                    "server with ElectroClean's own code.",
        }


def run_session(session: AnnotationSession, *, elapsed_s: float, started_at: str) -> FinishResult | None:
    """Start the session and Save and Finish it at once (the annotating happened in the browser).

    Returns None when the files were written and checked but the completion register could not be
    updated (the desktop's ``finished_register_pending``); raises :class:`ApiError` otherwise."""
    rid = session.recording_id
    try:
        session.start()
    except LockError as exc:
        raise ApiError(409, "busy", f"{rid} is being saved by another request; try again in a moment.") from exc
    except SessionError as exc:
        raise ApiError(409, "already_done", str(exc)) from exc
    if started_at:
        session.started_at = started_at
    session.timer_started_at = session.started_at
    session._accumulated = float(elapsed_s)  # measured in the browser while the recording was open
    try:
        return session.finish()
    except ExportCommitError as exc:
        if exc.committed:
            return None
        session.abandon(reason=f"saving failed: {exc}")
        raise ApiError(500, "save_failed", "The annotations could not be saved; please try again or tell the "
                       "study administrator.") from exc
    except (SessionError, ValidationError, ExportError, ValueError) as exc:
        session.abandon(reason=f"saving failed: {exc}")
        raise ApiError(422, "invalid_annotation", str(exc)) from exc
    except (OSError, RuntimeError) as exc:
        session.abandon(reason=f"saving failed: {exc}")
        raise ApiError(500, "save_failed", "The annotations could not be saved; please try again or tell the "
                       "study administrator.") from exc
