"""Small shared helpers: identifiers, timestamps and name validation."""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

ANNOTATOR_ID_PATTERN = re.compile(r"^[A-Za-z0-9]{1,32}$")
SAFE_COMPONENT_PATTERN = re.compile(r"[^A-Za-z0-9._-]+")

MODES = ("standard", "practice", "assessment")


class IdentifierError(ValueError):
    """Raised when an identifier cannot be used safely in file names."""


def now_local_iso() -> str:
    """Current wall-clock time with its UTC offset, e.g. 2026-10-26T14:02:11.250+00:00."""
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def friendly_time(iso: str | None, now: datetime | None = None) -> str:
    """An ISO time stamp as people say it, in local time: "today at 18:18", "yesterday at 09:05",
    "on 21 October 2026 at 14:00". Unreadable values are returned unchanged."""
    if not iso:
        return "an unknown time"
    try:
        when = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return str(iso)
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    when = when.astimezone()
    today = (now or datetime.now(timezone.utc)).astimezone().date()
    clock = when.strftime("%H:%M")
    days = (today - when.date()).days
    if days == 0:
        return f"today at {clock}"
    if days == 1:
        return f"yesterday at {clock}"
    return f"on {when.day} {when.strftime('%B %Y')} at {clock}"


def friendly_duration(seconds: float) -> str:
    """"less than a minute", "1 minute", "12 minutes", "1 hour 5 minutes"."""
    minutes = int(round(max(0.0, float(seconds)) / 60.0))
    if minutes < 1:
        return "less than a minute"
    hours, mins = divmod(minutes, 60)
    parts = []
    if hours:
        parts.append(f"{hours} hour{'s' if hours != 1 else ''}")
    if mins or not hours:
        parts.append(f"{mins} minute{'s' if mins != 1 else ''}")
    return " ".join(parts)


def compact_utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def new_annotation_id() -> str:
    return uuid.uuid4().hex


def new_session_id() -> str:
    """Sortable, unique session identifier such as 20261026T140211Z-1a2b3c4d."""
    return f"{compact_utc_stamp()}-{uuid.uuid4().hex[:8]}"


def normalise_annotator_id(value: str) -> str:
    """Validate an annotator identifier and return its canonical (upper-case) form.

    Identifiers appear in file names as a BIDS-style entity
    (``annotator-A01``), so they are restricted to 1-32 ASCII letters and
    digits. They are upper-cased so that ``a01`` and ``A01`` cannot produce
    two different sets of files on case-insensitive file systems (Windows,
    macOS).
    """
    candidate = (value or "").strip()
    if not candidate:
        raise IdentifierError("Please enter your annotator ID, for example A01.")
    if not ANNOTATOR_ID_PATTERN.match(candidate):
        raise IdentifierError(
            f"\"{candidate}\" cannot be used as an annotator ID. Use only letters and digits (no spaces, "
            "hyphens or underscores), at most 32 of them, for example A01."
        )
    return candidate.upper()


def safe_component(value: str) -> str:
    """Make an arbitrary string safe as a single path component."""
    cleaned = SAFE_COMPONENT_PATTERN.sub("-", value).strip("-.")
    if not cleaned:
        raise IdentifierError(f"Cannot build a safe file name from {value!r}")
    return cleaned


def validate_mode(mode: str) -> str:
    if mode not in MODES:
        raise ValueError(f"Mode must be one of {MODES}, got {mode!r}")
    return mode
