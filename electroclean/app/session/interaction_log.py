"""Interaction logs: a time-stamped record of what an annotator does, kept as research data.

One log file is written per visit (in the browser application, from signing in until signing out
or closing the page), as JSON Lines: the first line is a header describing the visit, and every
other line is one event::

    {"seq": 12, "t": 83.4127, "wall": "2026-10-27T14:03:11.402+00:00", "type": "annotation_created",
     "recording": "sub-001/eeg/sub-001_task-rest_eeg.vhdr", ...}

``t`` is seconds since the visit started on a monotonic clock (unaffected by changes to the
computer's clock), ``wall`` the local time with its UTC offset, ``seq`` the event's number. Lines are
written as they happen, so a log survives a crash up to its last event.

This module defines the format. The browser sends its events to the study
(:mod:`electroclean.web.visits`): the ElectroClean server writes them into these files as they
arrive, and for a study on Firebase ``electroclean-web export`` writes them from Firestore.
:class:`InteractionLog` writes the same files from Python, for scripts and tests. Code that wants to
record something calls ``log.event(kind, **fields)``. Where no log is open, :data:`NULL_LOG` takes
the calls and does nothing, so callers never need to check.
"""

from __future__ import annotations

import json
import math
import threading
import time
from pathlib import Path
from typing import Any, TextIO

from electroclean.app.common import now_local_iso

SCHEMA = "electroclean.interaction_log"
SCHEMA_VERSION = "1.0.0"


def _jsonable(value: Any) -> Any:
    """Values as JSON can hold them (tuples become lists, NaN becomes null, paths become text)."""
    if isinstance(value, float):
        return None if math.isnan(value) or math.isinf(value) else round(value, 6)
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    if isinstance(value, Path):
        return value.as_posix()
    try:  # numpy numbers
        return _jsonable(value.item())
    except AttributeError:
        return str(value)


class InteractionLog:
    """Writes one visit's events to a JSON Lines file (or nowhere, when ``path`` is None)."""

    def __init__(self, path: Path | str | None, header: dict[str, Any] | None = None) -> None:
        self.path = Path(path) if path is not None else None
        self._t0 = time.monotonic()
        self._seq = 0
        self._lock = threading.Lock()
        self._fh: TextIO | None = None
        self.context: dict[str, Any] = {}  # added to every event (for example the open recording)
        if self.path is not None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._fh = open(self.path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115 - kept open
            head = {"type": "header", "schema": SCHEMA, "schema_version": SCHEMA_VERSION,
                    "started_at": now_local_iso(), **(header or {})}
            self._write(head)

    @property
    def enabled(self) -> bool:
        return self._fh is not None

    def elapsed(self) -> float:
        """Seconds since the visit started (the ``t`` of an event logged now)."""
        return time.monotonic() - self._t0

    def event(self, kind: str, /, **fields: Any) -> None:
        """Record one event. Never raises: logging must not interrupt annotation.

        ``kind`` is positional only, so an event may have a field that is itself called ``kind``."""
        if self._fh is None:
            return
        with self._lock:
            self._seq += 1
            line = {"seq": self._seq, "t": round(self.elapsed(), 4), "wall": now_local_iso(), "type": kind,
                    **self.context, **fields}
            self._write(line)

    def _write(self, obj: dict[str, Any]) -> None:
        if self._fh is None:
            return
        try:
            self._fh.write(json.dumps(_jsonable(obj), ensure_ascii=False, separators=(",", ":")) + "\n")
        except (OSError, ValueError):  # disk full or file closed: stop logging, keep annotating
            self._fh = None

    def close(self, **fields: Any) -> None:
        if self._fh is None:
            return
        self.event("log_closed", **fields)
        with self._lock:
            try:
                self._fh.close()
            except OSError:
                pass
            self._fh = None


#: Takes events when no log is open, and does nothing with them.
NULL_LOG = InteractionLog(None)
