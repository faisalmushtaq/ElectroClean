"""Manifests: what the server knows about a recording without ever having its EEG.

A study administrator *registers* each recording where the files are (their own computer, or
the server for the demonstration). Registration opens the recording with ElectroClean's normal
loader, so every check of the desktop application runs, and keeps everything the browser needs
to show the recording and everything ElectroClean's export code needs to write the results:
fingerprints, timing, the montage (channels shown, hidden and their types), the original
events, stretches without data, the display scales and the checks' findings.

:class:`ManifestRecording` stands in for :class:`electroclean.app.eeg.loading.LoadedRecording`
when results are written, so the web server saves exactly the same files as the desktop
application. Only :func:`build_manifest` (registration) needs MNE-Python.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

from electroclean import __version__
from electroclean.app.annotations.model import RecordingInfo
from electroclean.app.annotations.timing import RecordingTiming
from electroclean.app.common import now_local_iso
from electroclean.app.io.atomic import atomic_write_json

if TYPE_CHECKING:
    from electroclean.app.eeg.events import OriginalEvents

SCHEMA = "electroclean.web_manifest"
SCHEMA_VERSION = "1.0.0"
BUNDLE_SCHEMA = "electroclean.web_manifest_bundle"
SCOPE_STUDY = "study"
#: The file whose checksum identifies a recording (the EDF/BDF file, or the BrainVision .eeg file).
FINGERPRINT_ROLE = "eeg"
#: Where the source files of a manifest appear to be when results are written (the server has none).
VIRTUAL_ROOT = Path("/electroclean-dataset")


class ManifestError(ValueError):
    pass


def set_scope(set_id: str) -> str:
    """The scope of the recordings of a self-contained training reference set."""
    return f"set:{set_id}"


def manifest_key(scope: str, recording_id: str) -> str:
    """A file-name-safe key for a manifest (recording IDs contain slashes)."""
    return hashlib.sha1(f"{scope}|{recording_id}".encode()).hexdigest()[:20]


# --------------------------------------------------------------- original events
def events_to_dict(ev: OriginalEvents, root: Path | None = None) -> dict[str, Any]:
    d = dataclasses.asdict(ev)
    path = ev.path
    if path is not None and root is not None:
        try:
            d["path"] = Path(path).resolve().relative_to(Path(root).resolve()).as_posix()
        except ValueError:
            d["path"] = Path(path).name
    else:
        d["path"] = Path(path).name if path is not None else None
    return d


def events_from_dict(d: dict[str, Any]) -> OriginalEvents:
    from electroclean.app.eeg.events import OriginalEvents

    fields = {f.name for f in dataclasses.fields(OriginalEvents)}
    data = {k: v for k, v in dict(d).items() if k in fields}
    path = data.get("path")
    data["path"] = (VIRTUAL_ROOT / path) if path else None
    data["rows"] = [list(r) for r in data.get("rows", [])]
    data["columns"] = list(data.get("columns", []))
    return OriginalEvents(**data)


def display_events(ev: OriginalEvents, n_samples: int, sfreq: float) -> list[dict[str, Any]]:
    """The original events as the browser draws them: sample, duration and a label (like the desktop)."""
    from electroclean.app.eeg.events import SOURCE_BDF, SOURCE_EDF, parse_float

    out = []
    tts, vals = ev.trial_types, ev.values
    durations = ev.column("duration")
    from_file = ev.source in (SOURCE_EDF, SOURCE_BDF)
    for i, s in enumerate(ev.sample):
        if s is None or s < 0 or s >= n_samples:
            continue
        if from_file and tts[i].lower().startswith("bad_acq_skip"):
            continue  # a stretch without data, shown hatched (see the manifest's gaps)
        label = tts[i] if tts[i] not in ("", "n/a") else f"value {vals[i]}"
        dur = parse_float(durations[i]) if i < len(durations) else None
        out.append({"onset_sample": int(s), "duration_samples": int(round((dur or 0.0) * sfreq)), "label": label})
    out.sort(key=lambda e: e["onset_sample"])
    return out


# ------------------------------------------------------------------ registration
def build_manifest(loaded: Any, *, scope: str = SCOPE_STUDY) -> dict[str, Any]:
    """The manifest of a recording opened with ``load_recording`` (the files must be at hand)."""
    files = loaded.files
    info = loaded.info
    root = files.root

    def rel(p: Path | None) -> str | None:
        if p is None:
            return None
        try:
            return Path(p).resolve().relative_to(Path(root).resolve()).as_posix()
        except ValueError:
            return Path(p).name

    view = loaded.view_raw
    types: dict[str, str] = {}
    bads: list[str] = []
    if view is not None:
        types = dict(zip(view.ch_names, view.get_channel_types(), strict=True))
        bads = [c for c in view.info.get("bads", []) if c in info.ch_names]
    eeg_fp = (loaded.fingerprint or {}).get(FINGERPRINT_ROLE) or {}
    if not eeg_fp.get("sha256"):
        raise ManifestError(f"{info.recording_id}: the data file's checksum was not computed")
    amp = loaded.amplitude_report
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "created_at": now_local_iso(),
        "electroclean_version": __version__,
        "scope": scope,
        "recording_id": info.recording_id,
        "relative_path": info.relative_path or info.recording_id,
        "format": files.format,
        "format_name": files.format_name,
        "file_name": files.path.name,
        "files": {
            "stem": files.stem,
            "path": rel(files.path),
            "vhdr": rel(files.vhdr),
            "eeg": rel(files.eeg),
            "vmrk": rel(files.vmrk),
            "channels_tsv": rel(files.channels_tsv),
            "events_tsv": rel(files.events_tsv),
            "events_json_chain": [rel(p) for p in files.sidecars.events_json_chain],
            "eeg_json_chain": [rel(p) for p in files.sidecars.eeg_json_chain],
        },
        "timing": info.timing.to_dict(),
        "ch_names": list(info.ch_names),
        "hidden_channels": list(info.hidden_channels),
        "trigger_channels": list(loaded.trigger_channels),
        "channel_types": {c: types.get(c, "eeg") for c in info.ch_names},
        "bad_channels": bads,
        "fingerprint": _plain(loaded.fingerprint),
        "original_events": events_to_dict(loaded.original_events, root),
        "events_sidecar": _plain(loaded.events_sidecar),
        "event_report": _plain(loaded.event_report.to_dict()),
        "channel_report": _plain(loaded.channel_report.to_dict()),
        "amplitude": {
            "report": _plain(amp.to_dict()),
            "suggested_scalings": dict(amp.suggested_scalings),
            "warnings": list(amp.warnings),
        },
        "acquisition_gaps": [[int(a), int(b)] for a, b in loaded.acquisition_gaps],
        "discontinuity_samples": [int(s) for s in loaded.discontinuity_samples],
        "warnings": list(loaded.warnings),
        "notes": list(loaded.notes),
    }


def _plain(obj: Any) -> Any:
    """JSON-safe copy (paths become text, numpy numbers become Python numbers)."""
    return json.loads(json.dumps(obj, default=_default))


def _default(o: Any) -> Any:
    if isinstance(o, Path):
        return o.as_posix()
    try:
        return o.item()
    except AttributeError:
        return str(o)


def register_recording(files: Any, settings: Any, catalogue: Any, *, scope: str = SCOPE_STUDY,
                       check_filters: bool = True) -> dict[str, Any]:
    """Open one recording with the desktop loader and return its manifest (needs MNE-Python)."""
    from dataclasses import replace

    from electroclean.app.eeg.loading import load_recording

    reg_settings = replace(settings, hash_source_files=True)  # the fingerprint is how the browser's file is matched
    filters = settings.filters if check_filters else replace(settings.filters, highpass_enabled=False,
                                                                notch_enabled=False)
    loaded = load_recording(files, reg_settings, filters, catalogue)
    try:
        return build_manifest(loaded, scope=scope)
    finally:
        loaded.close()


# ------------------------------------------------------- the browser's view of it
def public_manifest(m: dict[str, Any], study_scalings: dict[str, float] | None = None) -> dict[str, Any]:
    """The Manifest of docs/web/api.md: what the browser needs to show the recording."""
    timing = m["timing"]
    ev = events_from_dict(m["original_events"])
    fp = (m.get("fingerprint") or {}).get(FINGERPRINT_ROLE) or {}
    amp = m.get("amplitude") or {}
    scalings = {**(study_scalings or {}), **dict(amp.get("suggested_scalings") or {})}
    return {
        "recording_id": m["recording_id"],
        "file_name": m["file_name"],
        "format": m["format"],
        "sfreq": float(timing["sfreq"]),
        "n_samples": int(timing["n_samples"]),
        "duration_s": float(timing["n_samples"]) / float(timing["sfreq"]),
        "ch_names": list(m["ch_names"]),
        "hidden_channels": list(m.get("hidden_channels", [])),
        "channel_types": dict(m.get("channel_types", {})),
        "bad_channels": list(m.get("bad_channels", [])),
        "original_events": display_events(ev, int(timing["n_samples"]), float(timing["sfreq"])),
        "gaps": [list(g) for g in m.get("acquisition_gaps", [])],
        "display": {"scalings": scalings, "warnings": list(m.get("warnings", [])) + list(m.get("notes", []))},
        "fingerprint": {"algorithm": "sha256", "role": FINGERPRINT_ROLE, "hex": fp.get("sha256", ""),
                        "size_bytes": int(fp.get("size", 0) or 0)},
    }


def fingerprint_of(m: dict[str, Any]) -> tuple[str, int]:
    fp = (m.get("fingerprint") or {}).get(FINGERPRINT_ROLE) or {}
    return str(fp.get("sha256", "")).lower(), int(fp.get("size", 0) or 0)


def manifest_info(m: dict[str, Any]) -> RecordingInfo:
    """The recording's identity, timing and montage (all that checking an annotation needs)."""
    fp = dict(m.get("fingerprint") or {})
    return RecordingInfo(
        recording_id=m["recording_id"],
        timing=RecordingTiming.from_dict(m["timing"]),
        ch_names=tuple(m["ch_names"]),
        relative_path=m.get("relative_path", m["recording_id"]),
        fingerprint=fp,
        hidden_channels=tuple(m.get("hidden_channels", [])),
    )


# ------------------------------------------------- standing in for LoadedRecording
@dataclass
class _Sidecars:
    events_json_chain: list[Path] = field(default_factory=list)
    eeg_json_chain: list[Path] = field(default_factory=list)


@dataclass
class ManifestFiles:
    """The parts of :class:`electroclean.app.io.discovery.RecordingFiles` that saving uses."""

    recording_id: str
    format: str
    format_name: str
    stem: str
    path: Path
    eeg: Path | None
    vmrk: Path | None
    channels_tsv: Path | None
    events_tsv: Path | None
    sidecars: _Sidecars
    root: Path = VIRTUAL_ROOT

    @property
    def vhdr(self) -> Path | None:
        return self.path if self.format == "brainvision" else None


class _Report:
    """An object with ``to_dict()`` returning what registration recorded."""

    def __init__(self, data: dict[str, Any] | None) -> None:
        self._data = dict(data or {})

    def to_dict(self) -> dict[str, Any]:
        return json.loads(json.dumps(self._data))


class _AmplitudeReport(_Report):
    def __init__(self, data: dict[str, Any]) -> None:
        super().__init__(data.get("report"))
        self.suggested_scalings = dict(data.get("suggested_scalings") or {})
        self.warnings = list(data.get("warnings") or [])


class ManifestRecording:
    """A registered recording, standing in for ``LoadedRecording`` when the server writes results.

    ``display_filters`` describes the filters the browser applied for display (they are recorded in
    the session file where the desktop records its own filter design)."""

    def __init__(self, m: dict[str, Any], display_filters: dict[str, Any] | None = None) -> None:
        if m.get("schema") != SCHEMA:
            raise ManifestError("Not an ElectroClean web manifest")
        self.manifest = m
        f = m["files"]

        def p(value: str | None) -> Path | None:
            return (VIRTUAL_ROOT / PurePosixPath(value)) if value else None

        self.files = ManifestFiles(
            recording_id=m["recording_id"], format=m["format"], format_name=m.get("format_name", m["format"]),
            stem=f["stem"], path=p(f["path"]) or VIRTUAL_ROOT / m["file_name"], eeg=p(f.get("eeg")),
            vmrk=p(f.get("vmrk")), channels_tsv=p(f.get("channels_tsv")), events_tsv=p(f.get("events_tsv")),
            sidecars=_Sidecars([q for q in map(p, f.get("events_json_chain", [])) if q is not None],
                               [q for q in map(p, f.get("eeg_json_chain", [])) if q is not None]),
        )
        self.info = manifest_info(m)
        self.fingerprint = dict(self.info.fingerprint)
        self.original_events = events_from_dict(m["original_events"])
        self.event_report = _Report(m.get("event_report"))
        self.channel_report = _Report(m.get("channel_report"))
        self.filter_report = _Report({
            "applied_in": "the ElectroClean web application, in the annotator's browser (display only)",
            "settings": dict(display_filters or {}),
            "note": "Zero-phase filters applied in the browser for display only; the recording file is never "
                    "changed and the EEG never left the annotator's computer.",
        })
        self.amplitude_report = _AmplitudeReport(m.get("amplitude") or {})
        self.events_sidecar = dict(m.get("events_sidecar") or {})
        self.acquisition_gaps = [tuple(g) for g in m.get("acquisition_gaps", [])]
        self.discontinuity_samples = list(m.get("discontinuity_samples", []))
        self.trigger_channels = list(m.get("trigger_channels", []))
        self.hidden_channels = list(m.get("hidden_channels", []))
        self.warnings = list(m.get("warnings", []))
        self.notes = list(m.get("notes", []))
        self.view_raw = None

    @property
    def display_scalings(self) -> dict[str, float]:
        return dict(self.amplitude_report.suggested_scalings)

    @property
    def timing(self) -> RecordingTiming:
        return self.info.timing

    def close(self) -> None:
        return None


# ------------------------------------------------------------------- the store
class ManifestStore:
    """Manifests on disk: ``<dir>/<key>.json``, one per registered recording and scope."""

    def __init__(self, directory: Path) -> None:
        self.dir = Path(directory)
        self._cache: dict[str, dict[str, Any]] | None = None
        self._mtime = -1.0

    def _load(self) -> dict[str, dict[str, Any]]:
        try:
            mtime = self.dir.stat().st_mtime
        except OSError:
            return {}
        if self._cache is None or mtime != self._mtime:
            out: dict[str, dict[str, Any]] = {}
            for path in sorted(self.dir.glob("*.json")):
                try:
                    m = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if m.get("schema") == SCHEMA:
                    out[path.stem] = m
            self._cache, self._mtime = out, mtime
        return self._cache

    def all(self) -> list[dict[str, Any]]:
        return list(self._load().values())

    def add(self, m: dict[str, Any]) -> str:
        if m.get("schema") != SCHEMA or "recording_id" not in m or "scope" not in m:
            raise ManifestError("Not an ElectroClean web manifest")
        major = str(m.get("schema_version", "")).split(".")[0]
        if major != SCHEMA_VERSION.split(".")[0]:
            raise ManifestError(f"Manifest version {m.get('schema_version')} is not supported")
        key = manifest_key(m["scope"], m["recording_id"])
        self.dir.mkdir(parents=True, exist_ok=True)
        atomic_write_json(self.dir / f"{key}.json", m)
        self._cache = None
        return key

    def get(self, scope: str, recording_id: str) -> dict[str, Any] | None:
        return self._load().get(manifest_key(scope, recording_id))

    def remove(self, scope: str, recording_id: str) -> None:
        (self.dir / f"{manifest_key(scope, recording_id)}.json").unlink(missing_ok=True)
        self._cache = None

    def in_scope(self, scope: str) -> list[dict[str, Any]]:
        return sorted((m for m in self._load().values() if m["scope"] == scope), key=lambda m: m["recording_id"])

    def by_fingerprint(self, sha256: str, size: int) -> list[dict[str, Any]]:
        sha = (sha256 or "").lower()
        return [m for m in self._load().values() if sha and fingerprint_of(m) == (sha, int(size))]
