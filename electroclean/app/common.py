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
    if not ANNOTATOR_ID_PATTERN.match(candidate):
        raise IdentifierError(
            "Annotator ID must be 1-32 letters or digits only (no spaces, hyphens or "
            f"underscores), for example A01. Got: {value!r}"
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
