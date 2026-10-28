"""Checking a manifest that a browser built (``recordings_register``) before it is stored.

The administrator's browser reads each recording on their own computer and builds its manifest
(``js/data/register.js``) in the internal shape of :func:`electroclean.web.manifest.build_manifest`.
That manifest is untrusted input: it decides what annotators are shown and what the result files
say about the recording. :func:`check_manifest` therefore checks its shape, sizes and consistency
field by field and returns a clean copy holding only the fields ElectroClean knows, or raises
:class:`ManifestProblem` with a reason written for the administrator.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import PurePosixPath
from typing import Any

from electroclean.config.settings import CHANNEL_TYPES
from electroclean.web.manifest import FINGERPRINT_ROLE, SCHEMA, SCHEMA_VERSION

#: Limits of what one call may register.
MAX_MANIFEST_BYTES = 2_000_000
MAX_MANIFESTS = 500
MAX_CHANNELS = 4096
MAX_EVENTS = 200_000
MAX_TEXTS = 500
MAX_TEXT = 4000
MAX_PATH = 512
MAX_SFREQ = 1_000_000.0
MAX_SAMPLES = 2**42
FORMATS = {"brainvision": "BrainVision", "edf": "EDF", "bdf": "BDF"}
#: Where original events come from (electroclean.app.eeg.events: SOURCE_*).
EVENT_SOURCES = ("events_tsv", "brainvision_vmrk", "edf_annotations", "bdf_annotations", "stim_channel", "none")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
#: Fingerprint roles (RecordingFiles.source_files): the data file, its companions and the BIDS sidecars.
ROLE_RE = re.compile(r"^(vhdr|eeg|vmrk|channels_tsv|events_tsv|events_json|eeg_json)(_inherited_[0-9]{1,2})?$")
UNSAFE = re.compile(r"[\x00-\x1f\\:*?\"<>|]")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class ManifestProblem(ValueError):
    """The manifest cannot be registered; the message says why."""


def _fail(rid: str, text: str) -> ManifestProblem:
    return ManifestProblem(f"{rid}: {text}" if rid else text)


def safe_relative_path(value: Any, what: str) -> str:
    """A path below the dataset folder: forward slashes, no '..', nothing absolute, no control characters."""
    if not isinstance(value, str) or not value or len(value) > MAX_PATH:
        raise ManifestProblem(f"{what} must be a path of 1 to {MAX_PATH} characters")
    p = PurePosixPath(value)
    if (value.startswith("/") or p.is_absolute() or UNSAFE.search(value) or ".." in p.parts or "." in value.split("/")
            or any(part != part.strip() or not part for part in value.split("/"))):
        raise ManifestProblem(f"{what} must be a plain relative path inside the dataset (got {value!r})")
    return value


def _text(value: Any, what: str, *, empty: bool = True, limit: int = MAX_TEXT) -> str:
    if not isinstance(value, str) or (not empty and not value) or len(value) > limit:
        raise ManifestProblem(f"{what} must be text of at most {limit} characters")
    return value


def _texts(value: Any, what: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_TEXTS:
        raise ManifestProblem(f"{what} must be a list of at most {MAX_TEXTS} texts")
    return [_text(v, what) for v in value]


def _int(value: Any, what: str, *, minimum: int = 0, maximum: int = MAX_SAMPLES) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) \
            or int(value) != value or not minimum <= value <= maximum:
        raise ManifestProblem(f"{what} must be a whole number from {minimum} to {maximum}")
    return int(value)


def _json_object(value: Any, what: str, *, limit: int = 400_000) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ManifestProblem(f"{what} must be an object")
    try:
        text = json.dumps(value, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ManifestProblem(f"{what} is not plain JSON") from exc
    if len(text) > limit:
        raise ManifestProblem(f"{what} is too large")
    return json.loads(text)


def _channel_list(value: Any, what: str) -> list[str]:
    if not isinstance(value, list) or len(value) > MAX_CHANNELS:
        raise ManifestProblem(f"{what} must be a list of at most {MAX_CHANNELS} channel names")
    out = []
    for c in value:
        if not isinstance(c, str) or not c.strip() or len(c) > 200 or CONTROL.search(c):
            raise ManifestProblem(f"{what}: {c!r} is not a channel name")
        out.append(c)
    if len(set(out)) != len(out):
        dup = sorted({c for c in out if out.count(c) > 1})
        raise ManifestProblem(f"{what} names a channel more than once: {', '.join(dup[:5])}")
    return out


def _fingerprint(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or len(value) > 40:
        raise ManifestProblem("fingerprint must be an object with the checksum of each source file")
    out: dict[str, Any] = {}
    for role, fp in value.items():
        if not isinstance(role, str) or not ROLE_RE.match(role):
            raise ManifestProblem(f"fingerprint names an unknown file role {role!r}")
        if not isinstance(fp, dict):
            raise ManifestProblem(f"fingerprint.{role} must be an object")
        sha = fp.get("sha256")
        if not isinstance(sha, str) or not HEX64.match(sha.lower()):
            raise ManifestProblem(f"fingerprint.{role}.sha256 must be the 64-character hexadecimal SHA-256")
        entry: dict[str, Any] = {"sha256": sha.lower(),
                                 "size": _int(fp.get("size"), f"fingerprint.{role}.size",
                                              minimum=1 if role == FINGERPRINT_ROLE else 0, maximum=2**50)}
        if fp.get("path") is not None:
            entry["path"] = safe_relative_path(fp["path"], f"fingerprint.{role}.path")
        if fp.get("mtime_ns") is not None:
            entry["mtime_ns"] = _int(fp["mtime_ns"], f"fingerprint.{role}.mtime_ns", maximum=2**63)
        out[role] = entry
    if FINGERPRINT_ROLE not in out:
        raise ManifestProblem("fingerprint.eeg (the checksum of the data file) is missing")
    return out


def _files(value: Any, fmt: str, rid: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ManifestProblem("files must be an object naming the recording's files")
    out: dict[str, Any] = {"stem": _text(value.get("stem"), "files.stem", empty=False, limit=300)}
    if "/" in out["stem"] or UNSAFE.search(out["stem"]):
        raise ManifestProblem("files.stem must be a file name without folders")
    out["path"] = safe_relative_path(value.get("path", rid), "files.path")
    for key in ("vhdr", "eeg", "vmrk", "channels_tsv", "events_tsv"):
        v = value.get(key)
        out[key] = None if v is None else safe_relative_path(v, f"files.{key}")
    for key in ("events_json_chain", "eeg_json_chain"):
        chain = value.get(key) or []
        if not isinstance(chain, list) or len(chain) > 20:
            raise ManifestProblem(f"files.{key} must be a list of at most 20 paths")
        out[key] = [safe_relative_path(v, f"files.{key}") for v in chain]
    if fmt == "brainvision" and not out["eeg"]:
        raise ManifestProblem("files.eeg (the BrainVision data file) is missing")
    return out


def _events(value: Any, n_samples: int) -> dict[str, Any]:
    from electroclean.web.manifest import events_from_dict

    if not isinstance(value, dict):
        raise ManifestProblem("original_events must be an object (use source 'none' when there are none)")
    source = value.get("source", "none")
    if source not in EVENT_SOURCES:
        raise ManifestProblem(f"original_events.source must be one of {', '.join(EVENT_SOURCES)}")
    columns = value.get("columns") or []
    rows = value.get("rows") or []
    if not isinstance(columns, list) or not all(isinstance(c, str) and len(c) <= 200 for c in columns) \
            or len(columns) > 100 or len(set(columns)) != len(columns):
        raise ManifestProblem("original_events.columns must be a list of distinct column names")
    if not isinstance(rows, list) or len(rows) > MAX_EVENTS:
        raise ManifestProblem(f"original_events.rows must be a list of at most {MAX_EVENTS} rows")
    for i, r in enumerate(rows, start=1):
        if not isinstance(r, list) or len(r) != len(columns) or not all(isinstance(x, str) and len(x) <= 2000
                                                                          for x in r):
            raise ManifestProblem(f"original_events row {i} must have one text value per column")
    n = len(rows)
    onsets = value.get("onset_s") if value.get("onset_s") is not None else []
    samples = value.get("sample") if value.get("sample") is not None else []
    if not isinstance(onsets, list) or len(onsets) not in (0, n):
        raise ManifestProblem("original_events.onset_s must give one onset (or null) per row")
    if not isinstance(samples, list) or len(samples) not in (0, n):
        raise ManifestProblem("original_events.sample must give one sample (or null) per row")
    for x in onsets:
        if x is not None and (isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x)):
            raise ManifestProblem("original_events.onset_s must hold numbers of seconds or null")
    for x in samples:
        if x is None:
            continue
        # An events.tsv row may lie outside the recording: the loader keeps it with a warning, so that
        # the exported events file still holds every original row (it is not shown on the EEG).
        _int(x, "original_events.sample", minimum=-MAX_SAMPLES, maximum=MAX_SAMPLES)
    path = value.get("path")
    out = {
        "source": source,
        "path": None if path is None else safe_relative_path(path, "original_events.path"),
        "columns": list(columns), "rows": [list(r) for r in rows],
        "onset_s": [None if x is None else float(x) for x in onsets],
        "sample": [None if x is None else int(x) for x in samples],
        "sample_computed": bool(value.get("sample_computed", False)),
        "sample_column_ignored": bool(value.get("sample_column_ignored", False)),
        "problems": _texts(value.get("problems"), "original_events.problems"),
        "comparison": _json_object(value.get("comparison"), "original_events.comparison"),
        "stim_channels": _channel_list(value.get("stim_channels") or [], "original_events.stim_channels"),
    }
    try:
        events_from_dict(out)
    except (TypeError, ValueError, KeyError) as exc:
        raise ManifestProblem(f"original_events cannot be read: {exc}") from exc
    return out


def check_manifest(m: Any, *, scope: str, suffixes: tuple[str, ...]) -> dict[str, Any]:
    """A clean, checked copy of a browser's manifest for ``scope`` (see the module docstring)."""
    if not isinstance(m, dict):
        raise ManifestProblem("A manifest must be an object")
    try:
        size = len(json.dumps(m, allow_nan=False))
    except (TypeError, ValueError) as exc:
        raise ManifestProblem("The manifest is not plain JSON (numbers must be finite)") from exc
    if size > MAX_MANIFEST_BYTES:
        raise ManifestProblem(f"The manifest is larger than {MAX_MANIFEST_BYTES // 1_000_000} MB")
    raw_rid = m.get("recording_id")
    rid = raw_rid if isinstance(raw_rid, str) else ""
    try:
        if m.get("schema") != SCHEMA:
            raise ManifestProblem(f"schema must be {SCHEMA!r}")
        if str(m.get("schema_version", "")).split(".")[0] != SCHEMA_VERSION.split(".")[0]:
            raise ManifestProblem(f"schema_version {m.get('schema_version')!r} is not supported "
                                  f"(this server reads {SCHEMA_VERSION.split('.')[0]}.x)")
        rid = safe_relative_path(raw_rid, "recording_id")
        if not rid.lower().endswith(tuple(s.lower() for s in suffixes)):
            raise ManifestProblem("recording_id must end with one of the study's recording suffixes: "
                                  + ", ".join(suffixes))
        if m.get("scope", scope) != scope:
            raise ManifestProblem(f"the manifest was built for {m.get('scope')!r}, not {scope!r}")
        fmt = m.get("format")
        if fmt not in FORMATS:
            raise ManifestProblem(f"format must be one of {', '.join(FORMATS)}")
        expected_ext = {"brainvision": ".vhdr", "edf": ".edf", "bdf": ".bdf"}[fmt]
        if not rid.lower().endswith(expected_ext):
            raise ManifestProblem(f"a {FORMATS[fmt]} recording's ID must end with {expected_ext}")
        file_name = m.get("file_name", PurePosixPath(rid).name)
        if file_name != PurePosixPath(rid).name:
            raise ManifestProblem("file_name must be the last part of recording_id")
        t = m.get("timing")
        if not isinstance(t, dict):
            raise ManifestProblem("timing must be an object")
        sfreq = t.get("sfreq")
        if isinstance(sfreq, bool) or not isinstance(sfreq, (int, float)) or not math.isfinite(sfreq) \
                or not 0 < sfreq <= MAX_SFREQ:
            raise ManifestProblem(f"timing.sfreq must be a sampling rate above 0 and at most {MAX_SFREQ:g} Hz")
        n_samples = _int(t.get("n_samples"), "timing.n_samples", minimum=1)
        first = _int(t.get("first_samp", 0), "timing.first_samp")
        meas = t.get("meas_date")
        if meas is not None:
            _text(meas, "timing.meas_date", limit=64)
        timing = {"sfreq": float(sfreq), "n_samples": n_samples, "first_samp": first, "meas_date": meas,
                  "duration_s": n_samples / float(sfreq)}
        dur = t.get("duration_s")
        if dur is not None and (isinstance(dur, bool) or not isinstance(dur, (int, float))
                                or abs(float(dur) - timing["duration_s"]) > max(1e-6, 1.0 / float(sfreq))):
            raise ManifestProblem("timing.duration_s does not agree with n_samples / sfreq")
        ch_names = _channel_list(m.get("ch_names"), "ch_names")
        if not ch_names:
            raise ManifestProblem("ch_names must name at least one channel to show")
        hidden = _channel_list(m.get("hidden_channels") or [], "hidden_channels")
        both = set(hidden) & set(ch_names)
        if both:
            raise ManifestProblem(f"a channel cannot be both shown and hidden: {', '.join(sorted(both)[:5])}")
        triggers = _channel_list(m.get("trigger_channels") or [], "trigger_channels")
        if not set(triggers) <= set(hidden):
            raise ManifestProblem("trigger_channels must be among hidden_channels (trigger channels are never shown)")
        types = m.get("channel_types")
        if not isinstance(types, dict) or set(types) != set(ch_names):
            raise ManifestProblem("channel_types must give the type of every channel shown, and only of those")
        bad_types = sorted({str(v) for v in types.values() if v not in CHANNEL_TYPES})
        if bad_types:
            raise ManifestProblem(f"channel_types: {', '.join(bad_types)} is not a channel type "
                                  f"({', '.join(CHANNEL_TYPES)})")
        bads = _channel_list(m.get("bad_channels") or [], "bad_channels")
        if not set(bads) <= set(ch_names):
            raise ManifestProblem("bad_channels must be among the channels shown")
        gaps = m.get("acquisition_gaps") or []
        if not isinstance(gaps, list) or len(gaps) > 10_000:
            raise ManifestProblem("acquisition_gaps must be a list of [start, end] sample pairs")
        clean_gaps = []
        last_end = 0
        for g in gaps:
            if not isinstance(g, (list, tuple)) or len(g) != 2:
                raise ManifestProblem("acquisition_gaps must be a list of [start, end] sample pairs")
            a, b = _int(g[0], "acquisition_gaps start"), _int(g[1], "acquisition_gaps end")
            if not a < b <= n_samples or a < last_end:
                raise ManifestProblem(f"the stretch without data [{a}, {b}] is not inside the recording, in order")
            clean_gaps.append([a, b])
            last_end = b
        disc = m.get("discontinuity_samples") or []
        if not isinstance(disc, list) or len(disc) > 10_000:
            raise ManifestProblem("discontinuity_samples must be a list of samples")
        clean_disc = [_int(s, "discontinuity_samples", minimum=1, maximum=n_samples - 1) for s in disc]
        amp = m.get("amplitude") or {}
        if not isinstance(amp, dict):
            raise ManifestProblem("amplitude must be an object")
        scal = amp.get("suggested_scalings") or {}
        if not isinstance(scal, dict) or any(k not in CHANNEL_TYPES for k in scal) or any(
                isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0
                for v in scal.values()):
            raise ManifestProblem("amplitude.suggested_scalings must give a positive scale (V) per channel type")
        out = {
            "schema": SCHEMA,
            "schema_version": _text(m.get("schema_version"), "schema_version", limit=20),
            "created_at": _text(m.get("created_at", ""), "created_at", limit=64),
            "electroclean_version": _text(m.get("electroclean_version", ""), "electroclean_version", limit=64),
            "scope": scope,
            "recording_id": rid,
            "relative_path": safe_relative_path(m.get("relative_path") or rid, "relative_path"),
            "format": fmt,
            "format_name": _text(m.get("format_name") or FORMATS[fmt], "format_name", limit=64),
            "file_name": file_name,
            "files": _files(m.get("files"), fmt, rid),
            "timing": timing,
            "ch_names": ch_names,
            "hidden_channels": hidden,
            "trigger_channels": triggers,
            "channel_types": {c: str(types[c]) for c in ch_names},
            "bad_channels": [c for c in ch_names if c in set(bads)],
            "fingerprint": _fingerprint(m.get("fingerprint")),
            "original_events": _events(m.get("original_events") or {"source": "none"}, n_samples),
            "events_sidecar": _json_object(m.get("events_sidecar"), "events_sidecar"),
            "event_report": _json_object(m.get("event_report"), "event_report"),
            "channel_report": _json_object(m.get("channel_report"), "channel_report"),
            "amplitude": {"report": _json_object(amp.get("report"), "amplitude.report"),
                          "suggested_scalings": {k: float(v) for k, v in scal.items()},
                          "warnings": _texts(amp.get("warnings"), "amplitude.warnings")},
            "acquisition_gaps": clean_gaps,
            "discontinuity_samples": sorted(set(clean_disc)),
            "warnings": _texts(m.get("warnings"), "warnings"),
            "notes": _texts(m.get("notes"), "notes"),
        }
        if out["files"]["path"] != rid:
            raise ManifestProblem("files.path must be the recording's own file (recording_id)")
        _usable(out)
        return out
    except ManifestProblem as exc:
        raise _fail(rid, str(exc)) from None


def _usable(m: dict[str, Any]) -> None:
    """The manifest works where it is used: shown to annotators and written into result files."""
    from electroclean.app.annotations.model import AnnotationError
    from electroclean.web.manifest import ManifestError, ManifestRecording, public_manifest

    try:
        ManifestRecording(m)
        public_manifest(m)
    except (ManifestError, AnnotationError, KeyError, TypeError, ValueError) as exc:
        raise ManifestProblem(f"the manifest cannot be used: {exc}") from exc
