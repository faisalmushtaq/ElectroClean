"""Registering recordings and training sets: run where the real files are.

Registration opens every recording with the desktop application's loader (MNE-Python, all the
usual checks) and stores its *manifest* (see :mod:`electroclean.web.manifest`) in the study, whichever
store holds it. Reference sets found in the dataset are stored too, without their recordings; the
recordings of a self-contained set are registered in the set's own scope. Neither the EEG nor any
recording file is ever stored by the server.

Where the computer with the files cannot reach the study (for example a server without Internet
access), :func:`write_bundle` writes the manifests and reference sets to one file and
:func:`import_bundle` stores them in the study.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from electroclean import __version__
from electroclean.app.common import now_local_iso
from electroclean.app.io.atomic import atomic_write_json
from electroclean.web.manifest import BUNDLE_SCHEMA, SCHEMA_VERSION, SCOPE_STUDY, register_recording, set_scope
from electroclean.web.store import Store

Say = Callable[[str], None]


@dataclass
class Registration:
    manifests: list[dict[str, Any]] = field(default_factory=list)
    reference_sets: list[tuple[dict[str, Any], dict[str, bytes]]] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)  # (recording, reason)


def reference_set_payload(folder: Path) -> tuple[dict[str, Any], dict[str, bytes]]:
    """A reference set's ``reference_set.json`` and its other files, leaving out its recordings."""
    from electroclean.training.reference import ReferenceSet

    rs = ReferenceSet.load(folder)
    files: dict[str, bytes] = {}
    for p in sorted(Path(folder).rglob("*")):
        rel = p.relative_to(folder)
        if not p.is_file() or rel.as_posix() == "reference_set.json" or any(x.startswith(".") for x in rel.parts):
            continue
        if rs.recordings_dir and rel.parts[0] == rs.recordings_dir:
            continue
        files[rel.as_posix()] = p.read_bytes()
    return json.loads(rs.path.read_text(encoding="utf-8")), files


def collect(dataset_root: Path | str, settings: Any, catalogue: Any, *, check_filters: bool = True,
            include_sets: bool = True, say: Say = print) -> Registration:
    """Manifests of every recording in the dataset (and its reference sets), without storing them."""
    from electroclean.app.io.discovery import discover_recordings
    from electroclean.config.settings import load_settings
    from electroclean.training.reference import find_reference_sets, reference_sets_dir

    root = Path(dataset_root).resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Dataset folder not found: {root}")
    try:
        _ds_settings, ds_study = load_settings(root)
    except (ValueError, OSError):
        ds_study = None
    sets_dir = reference_sets_dir(root, ds_study)
    out_dir = root / settings.output_directory_name
    reg = Registration()
    found = discover_recordings(root, suffixes=settings.discovery_suffixes,
                                exclude_dir_names=tuple(settings.discovery_exclude_dir_names),
                                exclude_paths=(out_dir, sets_dir), follow_symlinks=settings.discovery_follow_symlinks)

    def add(files: Any, scope: str) -> None:
        try:
            m = register_recording(files, settings, catalogue, scope=scope, check_filters=check_filters)
        except Exception as exc:  # noqa: BLE001 - a recording that cannot be opened is reported, not fatal
            reg.failed.append((files.recording_id, str(exc)))
            say(f"  could not register {files.recording_id}: {exc}")
            return
        reg.manifests.append(m)
        say(f"  registered {files.recording_id}" + ("" if scope == SCOPE_STUDY else f" ({scope})"))

    for files in found:
        add(files, SCOPE_STUDY)
    if include_sets:
        for rs in find_reference_sets(sets_dir):
            reg.reference_sets.append(reference_set_payload(rs.directory))
            say(f"  reference set {rs.set_id}: {len(rs.recordings)} recording(s)")
            rec_root = rs.recordings_root()
            if rec_root is not None and rec_root.is_dir():
                wanted = set(rs.recordings)
                for files in discover_recordings(rec_root, suffixes=settings.discovery_suffixes,
                                                 follow_symlinks=settings.discovery_follow_symlinks):
                    if files.recording_id in wanted:
                        add(files, set_scope(rs.set_id))
    return reg


def store_registration(store: Store, reg: Registration) -> None:
    for definition, files in reg.reference_sets:
        store.add_reference_set(definition, files)
    for m in reg.manifests:
        store.add_manifest(m)


def register_dataset(dataset_root: Path | str, store: Store, *, check_filters: bool = True, include_sets: bool = True,
                     say: Say = print) -> Registration:
    """Register every recording (and reference set) of a dataset in the study held by ``store``."""
    reg = collect(dataset_root, store.settings, store.catalogue, check_filters=check_filters,
                  include_sets=include_sets, say=say)
    store_registration(store, reg)
    return reg


def write_bundle(path: Path | str, reg: Registration, *, source: str = "") -> None:
    atomic_write_json(Path(path), {
        "schema": BUNDLE_SCHEMA, "schema_version": SCHEMA_VERSION, "created_at": now_local_iso(),
        "electroclean_version": __version__, "source": source, "manifests": reg.manifests,
        "reference_sets": [{"definition": d, "files": {k: base64.b64encode(v).decode("ascii") for k, v in f.items()}}
                           for d, f in reg.reference_sets],
        "failed": [{"recording_id": r, "reason": why} for r, why in reg.failed],
    })


def read_bundle(path: Path | str) -> Registration:
    try:
        d = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"Cannot read {path}: {exc}") from exc
    if d.get("schema") != BUNDLE_SCHEMA:
        raise ValueError(f"{path} is not a bundle of ElectroClean registrations (made by "
                         "'electroclean-web export-manifests')")
    return Registration(
        manifests=list(d.get("manifests", [])),
        reference_sets=[(s["definition"], {k: base64.b64decode(v) for k, v in s.get("files", {}).items()})
                        for s in d.get("reference_sets", [])],
        failed=[(f["recording_id"], f["reason"]) for f in d.get("failed", [])],
    )


def import_bundle(path: Path | str, store: Store) -> Registration:
    reg = read_bundle(path)
    store_registration(store, reg)
    return reg
