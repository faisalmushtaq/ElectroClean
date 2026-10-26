"""Recursive discovery of BrainVision recordings and their companion files."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from electroclean.app.io.bids import SidecarResolution, parse_bids_name, resolve_sidecars

_KEY_RE = re.compile(r"^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$")


@dataclass(frozen=True)
class VhdrHeader:
    data_file: str | None
    marker_file: str | None
    n_channels: int | None
    binary_format: str | None
    data_points: int | None
    data_orientation: str | None
    codepage: str | None


@dataclass
class RecordingFiles:
    """All files belonging to one recording.

    ``recording_id`` is the POSIX-style path of the ``.vhdr`` file relative to
    the dataset root. It is unique within a dataset and stable across
    computers, so two recordings with the same file name in different folders
    are never confused.
    """

    recording_id: str
    root: Path
    vhdr: Path
    eeg: Path | None
    vmrk: Path | None
    header: VhdrHeader | None
    sidecars: SidecarResolution
    problems: list[str] = field(default_factory=list)

    @property
    def stem(self) -> str:
        return self.vhdr.name[: -len(".vhdr")] if self.vhdr.name.endswith(".vhdr") else self.vhdr.stem

    @property
    def relative_dir(self) -> str:
        parent = PurePosixPath(self.recording_id).parent
        return "" if str(parent) == "." else str(parent)

    @property
    def entities(self) -> dict[str, str]:
        return dict(parse_bids_name(self.vhdr.name).entities)

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
        """Every existing input file, keyed by role (used for fingerprints)."""
        out: dict[str, Path] = {"vhdr": self.vhdr}
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
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(";"):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped[1:-1].strip().lower()
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
    )


def describe_recording(vhdr: Path, root: Path) -> RecordingFiles:
    """Build a :class:`RecordingFiles` entry and list any problems found."""
    # The ID is the path as found below the dataset folder, not the target of a symbolic
    # link (which may lie elsewhere, e.g. in a git-annex object store).
    try:
        rel = vhdr.relative_to(root).as_posix()
    except ValueError:
        rel = Path(os.path.relpath(os.path.abspath(vhdr), os.path.abspath(root))).as_posix()
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
        vhdr=vhdr,
        eeg=eeg,
        vmrk=vmrk,
        header=header,
        sidecars=sidecars,
        problems=problems,
    )


def discover_recordings(
    root: Path | str,
    *,
    suffix: str = "_eeg.vhdr",
    exclude_dir_names: tuple[str, ...] | list[str] = ("derivatives", "Annotated_Events", ".git"),
    exclude_paths: tuple[Path | str, ...] | list[Path | str] = (),
    follow_symlinks: bool = False,
) -> list[RecordingFiles]:
    """Recursively find ``*<suffix>`` files below ``root``, sorted by recording ID.

    Hidden folders, folders named in ``exclude_dir_names`` and the folders in
    ``exclude_paths`` (for example the results folder) are skipped so that
    ElectroClean's own outputs and derived data are never treated as source
    recordings.
    """
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
            if name.endswith(suffix) and not name.startswith("."):
                found.append(describe_recording(Path(dirpath) / name, root_path))
    found.sort(key=lambda r: r.recording_id)
    return found
