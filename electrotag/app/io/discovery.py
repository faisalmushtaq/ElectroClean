"""Recursive discovery of EEG recordings and their companion files.

ElectroTag opens BrainVision recordings (``.vhdr`` header with ``.eeg`` data
and ``.vmrk`` marker files) and EDF, EDF+ and BDF recordings (a single
file). By default every ``*_eeg.vhdr``, ``*_eeg.edf`` and ``*_eeg.bdf`` file
below the dataset folder is a recording.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from electrotag.app.io.bids import SidecarResolution, parse_bids_name, resolve_sidecars
from electrotag.app.io.edf import EdfHeader, EdfHeaderError, read_edf_header

#: Recording formats ElectroTag can open, by file extension (lower case).
FORMATS = {".vhdr": "brainvision", ".edf": "edf", ".bdf": "bdf"}
FORMAT_NAMES = {"brainvision": "BrainVision", "edf": "EDF", "bdf": "BDF"}
DEFAULT_SUFFIXES = ("_eeg.vhdr", "_eeg.edf", "_eeg.bdf")


def recording_format(path: Path | str) -> str | None:
    """``brainvision``, ``edf`` or ``bdf`` from a file name, or None if not supported."""
    return FORMATS.get(Path(path).suffix.lower())


_KEY_RE = re.compile(r"^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$")
_CHANNEL_RE = re.compile(r"^ch(\d+)\s*=\s*(.*?)\s*$", re.IGNORECASE)


@dataclass(frozen=True)
class VhdrHeader:
    data_file: str | None
    marker_file: str | None
    n_channels: int | None
    binary_format: str | None
    data_points: int | None
    data_orientation: str | None
    codepage: str | None
    #: The names of [Channel Infos], in channel order ("" for a channel without an entry).
    channel_names: tuple[str, ...] = ()

    def duplicate_names(self) -> list[tuple[str, list[int]]]:
        """Names given to more than one channel, with the channels' numbers (from 1)."""
        seen: dict[str, list[int]] = {}
        for i, name in enumerate(self.channel_names):
            if name:
                seen.setdefault(name, []).append(i + 1)
        return [(name, idx) for name, idx in seen.items() if len(idx) > 1]


@dataclass
class RecordingFiles:
    """All files belonging to one recording.

    ``path`` is the file that identifies the recording: the ``.vhdr`` header
    of a BrainVision recording or the ``.edf``/``.bdf`` file itself.
    ``recording_id`` is its POSIX-style path relative to the dataset root. It
    is unique within a dataset and stable across computers, so two recordings
    with the same file name in different folders are never confused. For EDF
    and BDF, ``eeg`` is the same file as ``path`` and ``vmrk`` is None.
    """

    recording_id: str
    root: Path
    path: Path
    eeg: Path | None
    vmrk: Path | None
    header: VhdrHeader | EdfHeader | None
    sidecars: SidecarResolution
    problems: list[str] = field(default_factory=list)
    format: str = "brainvision"

    @property
    def vhdr(self) -> Path | None:
        """The BrainVision header file (None for EDF and BDF recordings)."""
        return self.path if self.format == "brainvision" else None

    @property
    def format_name(self) -> str:
        return FORMAT_NAMES.get(self.format, self.format)

    @property
    def stem(self) -> str:
        """The file name without its extension, e.g. ``sub-01_task-rest_eeg``."""
        return self.path.name[: -len(self.path.suffix)] if self.path.suffix else self.path.name

    @property
    def relative_dir(self) -> str:
        parent = PurePosixPath(self.recording_id).parent
        return "" if str(parent) == "." else str(parent)

    @property
    def entities(self) -> dict[str, str]:
        return dict(parse_bids_name(self.path.name).entities)

    @property
    def channels_tsv(self) -> Path | None:
        return self.sidecars.channels_tsv

    @property
    def events_tsv(self) -> Path | None:
        return self.sidecars.events_tsv

    @property
    def events_json(self) -> Path | None:
        return self.sidecars.events_json

    @property
    def eeg_json(self) -> Path | None:
        return self.sidecars.eeg_json

    def source_files(self) -> dict[str, Path]:
        """Every existing input file, keyed by role (used for fingerprints).

        Roles are ``vhdr``, ``eeg`` and ``vmrk`` for BrainVision and ``eeg``
        alone for EDF and BDF, followed by the BIDS sidecars.
        """
        out: dict[str, Path] = {"vhdr": self.path} if self.format == "brainvision" else {}
        if self.eeg is not None and self.eeg.exists():
            out["eeg"] = self.eeg
        if self.vmrk is not None and self.vmrk.exists():
            out["vmrk"] = self.vmrk
        for key, path in (
            ("channels_tsv", self.channels_tsv),
            ("events_tsv", self.events_tsv),
            ("events_json", self.events_json),
            ("eeg_json", self.eeg_json),
        ):
            if path is not None:
                out[key] = path
        # Inherited (less specific) JSON sidecars also contribute metadata.
        for key, chain in (("events_json", self.sidecars.events_json_chain), ("eeg_json", self.sidecars.eeg_json_chain)):
            for level, path in enumerate(chain[:-1], start=1):
                out[f"{key}_inherited_{level}"] = path
        return out


def read_vhdr_header(vhdr: Path) -> VhdrHeader:
    """Read the companion-file references and layout from a BrainVision header."""
    raw = vhdr.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    section = ""
    values: dict[tuple[str, str], str] = {}
    channels: dict[int, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(";"):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped[1:-1].strip().lower()
            if section == "comment":
                break  # MNE-Python reads the header up to [Comment]
            continue
        if section == "channel infos":
            ch = _CHANNEL_RE.match(stripped)
            if ch:
                # the name is the text before the first comma, with \1 standing for a comma
                channels[int(ch.group(1))] = ch.group(2).split(",")[0].replace("\\1", ",")
            continue
        m = _KEY_RE.match(stripped)
        if m:
            values[(section, m.group(1).lower())] = m.group(2)

    def get(key: str) -> str | None:
        return values.get(("common infos", key))

    def as_int(value: str | None) -> int | None:
        try:
            return int(value) if value not in (None, "") else None
        except ValueError:
            return None

    return VhdrHeader(
        data_file=get("datafile"),
        marker_file=get("markerfile"),
        n_channels=as_int(get("numberofchannels")),
        binary_format=values.get(("binary infos", "binaryformat")),
        data_points=as_int(get("datapoints")),
        data_orientation=get("dataorientation"),
        codepage=get("codepage"),
        channel_names=tuple(channels.get(i, "") for i in range(1, max(channels, default=0) + 1)),
    )


def describe_recording(path: Path, root: Path) -> RecordingFiles:
    """Build a :class:`RecordingFiles` entry and list any problems found."""
    # The ID is the path as found below the dataset folder, not the target of a symbolic
    # link (which may lie elsewhere, e.g. in a git-annex object store).
    try:
        rel = path.relative_to(root).as_posix()
    except ValueError:
        rel = Path(os.path.relpath(os.path.abspath(path), os.path.abspath(root))).as_posix()
    fmt = recording_format(path)
    if fmt in ("edf", "bdf"):
        return _describe_edf(path, root, rel, fmt)
    vhdr = path
    problems: list[str] = []
    header = None
    eeg = vmrk = None
    try:
        header = read_vhdr_header(vhdr)
    except OSError as exc:
        problems.append(f"Cannot read header {vhdr.name}: {exc}")
    if header is not None:
        if not header.data_file:
            problems.append(f"Header {vhdr.name} does not name a data file (DataFile=)")
        else:
            eeg = vhdr.parent / header.data_file
            if not eeg.is_file():
                problems.append(
                    f"Data file '{header.data_file}' named in {vhdr.name} was not found"
                )
        if not header.marker_file:
            problems.append(f"Header {vhdr.name} does not name a marker file (MarkerFile=)")
        else:
            vmrk = vhdr.parent / header.marker_file
            if not vmrk.is_file():
                problems.append(
                    f"Marker file '{header.marker_file}' named in {vhdr.name} was not found"
                )
    try:
        sidecars = resolve_sidecars(vhdr, root)
    except OSError as exc:
        sidecars = SidecarResolution(warnings=[f"Could not search for BIDS sidecars: {exc}"])
    return RecordingFiles(
        recording_id=rel,
        root=root,
        path=vhdr,
        eeg=eeg,
        vmrk=vmrk,
        header=header,
        sidecars=sidecars,
        problems=problems,
        format="brainvision",
    )


def _describe_edf(path: Path, root: Path, rel: str, fmt: str) -> RecordingFiles:
    problems: list[str] = []
    header: EdfHeader | None = None
    try:
        header = read_edf_header(path)
    except OSError as exc:
        problems.append(f"Cannot read {path.name}: {exc}")
    except EdfHeaderError as exc:
        problems.append(f"{path.name} is not a readable {FORMAT_NAMES[fmt]} file: {exc}")
    try:
        sidecars = resolve_sidecars(path, root)
    except OSError as exc:
        sidecars = SidecarResolution(warnings=[f"Could not search for BIDS sidecars: {exc}"])
    return RecordingFiles(
        recording_id=rel,
        root=root,
        path=path,
        eeg=path,
        vmrk=None,
        header=header,
        sidecars=sidecars,
        problems=problems,
        format=fmt,
    )


def discover_recordings(
    root: Path | str,
    *,
    suffixes: tuple[str, ...] | list[str] | str = DEFAULT_SUFFIXES,
    exclude_dir_names: tuple[str, ...] | list[str] = ("derivatives", "Annotated_Events", ".git"),
    exclude_paths: tuple[Path | str, ...] | list[Path | str] = (),
    follow_symlinks: bool = False,
) -> list[RecordingFiles]:
    """Recursively find files ending in one of ``suffixes`` below ``root``, sorted by recording ID.

    Suffixes are compared without regard to case (``_eeg.EDF`` is found too).
    Hidden folders, folders named in ``exclude_dir_names`` and the folders in
    ``exclude_paths`` (for example the results folder) are skipped so that
    ElectroTag's own outputs and derived data are never treated as source
    recordings.
    """
    if isinstance(suffixes, str):
        suffixes = (suffixes,)
    endings = tuple(sfx.lower() for sfx in suffixes)
    root_path = Path(root)
    if not root_path.is_dir():
        raise NotADirectoryError(f"Dataset folder not found: {root_path}")
    excluded = set(exclude_dir_names)
    excluded_paths = {os.path.normcase(os.path.abspath(p)) for p in exclude_paths}
    found: list[RecordingFiles] = []
    for dirpath, dirnames, filenames in os.walk(root_path, followlinks=follow_symlinks):
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in excluded and not d.startswith(".")
            and os.path.normcase(os.path.abspath(os.path.join(dirpath, d))) not in excluded_paths
        )
        for name in sorted(filenames):
            if name.lower().endswith(endings) and not name.startswith(".") and recording_format(name):
                found.append(describe_recording(Path(dirpath) / name, root_path))
    found.sort(key=lambda r: r.recording_id)
    return found
