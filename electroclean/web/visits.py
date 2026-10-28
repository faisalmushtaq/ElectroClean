"""Interaction logs of browser visits, in the desktop application's format.

A visit's log starts with the same header as a desktop visit (docs/activity_logs.md) plus
``"client": "web"`` and what the browser said about itself; then come the events the browser sends
in batches, numbered in the order received (``seq``), and a closing ``log_closed`` event. The
files store writes them as ``interaction_logs/annotator-<ID>/<time>_<mode>.jsonl`` at once; the
Firestore store keeps them as documents until ``electroclean-web export`` writes the same files.
Either way ``electroclean-activity`` reads them like desktop logs.

Only what the browser sends is recorded, apart from ``visit_started`` and ``log_closed``. Fields
that could hold a password or a sign-in token are dropped, whatever the browser sends.
"""

from __future__ import annotations

import hashlib
import json
import math
import platform
import re
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from electroclean import __version__
from electroclean.app.common import now_local_iso
from electroclean.app.session.interaction_log import SCHEMA, SCHEMA_VERSION
from electroclean.web.errors import ApiError
from electroclean.web.store import MODES, User

if TYPE_CHECKING:
    from electroclean.web.service import StudyService

VISIT_RE = re.compile(r"^[0-9a-f]{32}$")
TYPE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
MAX_EVENTS = 2000
MAX_EVENT_BYTES = 16 * 1024
DROPPED = {"password", "token", "id_token", "authorization", "seq"}


def _clean(value: Any, depth: int = 0) -> Any:
    if depth > 6:
        return None
    if isinstance(value, float):
        return round(value, 6) if math.isfinite(value) else None
    if isinstance(value, (str, int, bool)) or value is None:
        return value[:2000] if isinstance(value, str) else value
    if isinstance(value, dict):
        return {str(k)[:64]: _clean(v, depth + 1) for k, v in list(value.items())[:200]
                if str(k).lower() not in DROPPED}
    if isinstance(value, list):
        return [_clean(v, depth + 1) for v in value[:1000]]
    return str(value)[:200]


class Visits:
    def __init__(self, service: StudyService) -> None:
        self.service = service

    @property
    def store(self) -> Any:
        return self.service.store

    def open(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``POST /visits``: start a visit's log; returns its ID and the study's logging settings."""
        logging = self.service.logging_info()
        if not logging["interactions"]:
            return {"visit_id": None, "logging": logging}
        s = self.service.settings
        programme = bool(body.get("programme"))
        set_id = self.store.programme(user.annotator_id) if programme else None
        mode = body.get("mode") if body.get("mode") in MODES else ("guided" if programme and set_id else "standard")
        context_id = set_id or (str(body.get("context_id") or "") if mode != "standard" else "")
        client = _clean(body.get("client")) if isinstance(body.get("client"), dict) else {}
        screen = client.get("screen") if isinstance(client.get("screen"), dict) else {}
        visit_id = uuid.uuid4().hex
        started = datetime.now()
        header = {
            "type": "header", "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "started_at": now_local_iso(),
            "visit_id": visit_id,
            "annotator_id": user.annotator_id,
            "mode": mode,
            "context_id": context_id if mode != "standard" else "",
            "reference_set": context_id,
            "assessment_kind": "",
            "programme": bool(programme and set_id),
            "dataset_root": "",
            "output_root": "",
            "study_id": self.store.study_id,
            "versions": {"electroclean": __version__, "python": platform.python_version(),
                         "server": self.store.kind, "browser": str(client.get("user_agent", ""))[:300]},
            "os": str(client.get("platform") or client.get("user_agent") or "")[:300],
            "screens": [{"width": screen.get("width"), "height": screen.get("height"),
                         "device_pixel_ratio": screen.get("pixel_ratio")}] if screen else [],
            "settings_sha256": hashlib.sha256(json.dumps(s.raw, sort_keys=True, default=str).encode()).hexdigest(),
            "filters": s.filters.to_dict(),
            "logging": {"pointer_hz": s.logging_pointer_hz, "idle_after_s": s.logging_idle_after_s},
            "client": "web",
            "browser": client,
        }
        self.store.visit_open(visit_id, user.annotator_id, mode, header["context_id"], header, started)
        self.store.visit_append(visit_id, [{"t": 0.0, "wall": header["started_at"], "type": "visit_started",
                                            "mode": mode, "choose_recording": True, "reference_set": context_id,
                                            "assessment_kind": "", "client": "web"}])
        return {"visit_id": visit_id, "logging": logging}

    def _visit(self, user: User, body: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        visit_id = body.get("visit_id")
        if not isinstance(visit_id, str) or not VISIT_RE.match(visit_id):
            raise ApiError(400, "bad_request", "visit_id is missing or not valid")
        v = self.store.visit(visit_id)
        if v is None or v["annotator_id"] != user.annotator_id:
            raise ApiError(404, "unknown_visit", "This visit's log was not found")
        return visit_id, v

    def events(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``POST /visits/{visit_id}/events``: append a batch in order (the server numbers them)."""
        visit_id, v = self._visit(user, body)
        if v["closed"]:
            raise ApiError(409, "visit_closed", "This visit's log is already closed")
        events = body.get("events")
        if not isinstance(events, list) or len(events) > MAX_EVENTS:
            raise ApiError(400, "bad_request", f"events must be a list of at most {MAX_EVENTS} events")
        clean = []
        skipped = 0
        for e in events:
            if not isinstance(e, dict) or not isinstance(e.get("type"), str) or not TYPE_RE.match(e["type"]):
                skipped += 1
                continue
            t = e.get("t")
            if isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0:
                skipped += 1
                continue
            rest = _clean({k: x for k, x in e.items() if k not in ("t", "wall", "type")})
            wall = e.get("wall") if isinstance(e.get("wall"), str) and len(e["wall"]) <= 40 else now_local_iso()
            ev = {"t": round(float(t), 4), "wall": wall, "type": e["type"], **rest}
            if len(json.dumps(ev)) > MAX_EVENT_BYTES:
                skipped += 1
                continue
            clean.append(ev)
        n = self.store.visit_append(visit_id, clean)
        return {"received": n, "skipped": skipped}

    def close(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``POST /visits/{visit_id}/close``: the closing line (closing twice does nothing)."""
        visit_id, v = self._visit(user, body)
        if v["closed"]:
            return {}
        try:
            opened = datetime.fromisoformat(v["opened_at"])
            since = (datetime.now(opened.tzinfo) - opened).total_seconds()
        except (TypeError, ValueError):
            since = 0.0
        t = max(float(v.get("last_t", 0.0)), since)
        reason = str(body.get("reason") or "closed")[:200]
        self.store.visit_close(visit_id, {"t": round(t, 4), "wall": now_local_iso(), "type": "log_closed",
                                          "reason": reason})
        return {}
