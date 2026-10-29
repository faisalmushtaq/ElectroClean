"""Minimal BIDS file-name parsing and sidecar resolution.

Only what ElectroTag needs is implemented: splitting a file name into
key-value entities, finding the ``channels.tsv``, ``events.tsv``,
``events.json`` and ``eeg.json`` files that belong to a recording, and applying
the BIDS inheritance principle (sidecars higher in the directory tree apply to
every recording whose entities they match; closer files take precedence).
"""

from __future__ import annotations

import json
import sys
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class BidsName:
    entities: OrderedDict[str, str]
    suffix: str
    extension: str
    raw_prefix: str = ""

    @property
    def prefix(self) -> str:
        """Everything before ``_<suffix>``, e.g. ``sub-001_task-rest``."""
        return "_".join(f"{k}-{v}" for k, v in self.entities.items())


def parse_bids_name(name: str) -> BidsName:
    """Parse ``sub-01_task-rest_eeg.vhdr`` into entities, suffix and extension.

    Non-BIDS names are handled gracefully: parts without a hyphen before the
    last underscore are ignored as entities.
    """
    base = Path(name).name
    dot = base.find(".")
    stem, ext = (base, "") if dot < 0 else (base[:dot], base[dot:])
    parts = stem.split("_")
    suffix = parts[-1] if len(parts) > 1 or "-" not in parts[-1] else ""
    entity_parts = parts[:-1] if suffix else parts
    entities: OrderedDict[str, str] = OrderedDict()
    for part in entity_parts:
        if "-" in part:
            key, _, value = part.partition("-")
            if key and value:
                entities[key] = value
    raw_prefix = "_".join(entity_parts)
    return BidsName(entities=entities, suffix=suffix, extension=ext, raw_prefix=raw_prefix)


@dataclass
class SidecarResolution:
    """Which metadata files apply to a recording."""

    channels_tsv: Path | None = None
    events_tsv: Path | None = None
    events_json_chain: list[Path] = field(default_factory=list)
    eeg_json_chain: list[Path] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def events_json(self) -> Path | None:
        return self.events_json_chain[-1] if self.events_json_chain else None

    @property
    def eeg_json(self) -> Path | None:
        return self.eeg_json_chain[-1] if self.eeg_json_chain else None


def _applies(candidate: BidsName, target: BidsName) -> bool:
    if not candidate.entities:
        # Not a BIDS name: only an exact name match counts, so that
        # "rec1_events.tsv" can never be applied to "rec2_eeg.vhdr".
        return bool(candidate.raw_prefix) and candidate.raw_prefix == target.raw_prefix
    return all(target.entities.get(k) == v for k, v in candidate.entities.items())


def _candidates(directory: Path, suffix: str, extension: str, target: BidsName) -> list[tuple[Path, BidsName]]:
    out = []
    try:
        entries = sorted(directory.iterdir())
    except OSError:
        return out
    for path in entries:
        if not path.is_file() or path.name.startswith("."):
            continue
        parsed = parse_bids_name(path.name)
        if parsed.suffix == suffix and parsed.extension == extension and _applies(parsed, target):
            out.append((path, parsed))
    return out


def resolve_sidecars(recording_path: Path, dataset_root: Path) -> SidecarResolution:
    """Find metadata files for ``recording_path`` (a ``*_eeg.vhdr``, ``*_eeg.edf`` or ``*_eeg.bdf`` file)."""
    target = parse_bids_name(recording_path.name)
    res = SidecarResolution()
    # Directories from the dataset root down to the recording's folder.
    rec_dir = recording_path.parent.resolve()
    root = dataset_root.resolve()
    chain: list[Path] = []
    d = rec_dir
    while True:
        chain.append(d)
        if d == root or d.parent == d:
            break
        d = d.parent
    chain.reverse()  # root first

    def pick_level(directory: Path, suffix: str, ext: str) -> Path | None:
        cands = _candidates(directory, suffix, ext, target)
        if not cands:
            return None
        if len(cands) > 1:
            # Prefer the most specific file; BIDS forbids ambiguity, so warn.
            cands.sort(key=lambda pb: len(pb[1].entities), reverse=True)
            if len(cands[0][1].entities) == len(cands[1][1].entities):
                res.warnings.append(
                    f"Ambiguous {suffix}{ext} files in {directory}: "
                    + ", ".join(p.name for p, _ in cands)
                    + f"; using {cands[0][0].name}"
                )
        return cands[0][0]

    for directory in chain:
        for suffix, ext, attr in (("channels", ".tsv", "channels_tsv"), ("events", ".tsv", "events_tsv")):
            found = pick_level(directory, suffix, ext)
            if found is not None:
                setattr(res, attr, found)  # closest level wins (no merging for TSV)
        found = pick_level(directory, "events", ".json")
        if found is not None:
            res.events_json_chain.append(found)
        found = pick_level(directory, target.suffix or "eeg", ".json")
        if found is not None:
            res.eeg_json_chain.append(found)
    return res


_JSON_WHITESPACE = " \t\n\r"


def loads_json(text: str, **kwargs: Any) -> Any:
    """``json.loads``, with the error messages of Python 3.13 on every supported version.

    A sidecar's error is recorded word for word in a recording's manifest, and the browser builds
    the same manifest with Python 3.13's words (``js/data/pyjson.js``). Python 3.13 reports a comma
    before a closing bracket as "Illegal trailing comma before end of object" (or array) at the
    comma, where Python 3.12 reports a missing property name or value at the bracket; this gives
    3.12 the newer message, so the manifest is the same whichever supported Python builds it.
    """
    try:
        return json.loads(text, **kwargs)
    except json.JSONDecodeError as exc:
        newer = _trailing_comma_error(exc) if sys.version_info < (3, 13) else None
        if newer is None:
            raise
        raise newer from None


def _trailing_comma_error(exc: json.JSONDecodeError) -> json.JSONDecodeError | None:
    """Python 3.13's error for Python 3.12's report of a comma before ``}`` or ``]``, else None."""
    doc, pos = exc.doc, exc.pos
    closing = {"Expecting property name enclosed in double quotes": "}", "Expecting value": "]"}.get(exc.msg)
    if closing is None or doc[pos:pos + 1] != closing:
        return None
    comma = pos - 1
    while comma >= 0 and doc[comma] in _JSON_WHITESPACE:
        comma -= 1
    if comma < 0 or doc[comma] != ",":
        return None
    kind = "object" if closing == "}" else "array"
    return json.JSONDecodeError(f"Illegal trailing comma before end of {kind}", doc, comma)


def load_json_chain(paths: list[Path]) -> tuple[dict[str, Any], list[str]]:
    """Merge JSON sidecars from least to most specific (later keys win)."""
    merged: dict[str, Any] = {}
    problems: list[str] = []
    for p in paths:
        non_finite: list[str] = []

        def constant(name: str, found: list[str] = non_finite) -> None:
            found.append(name)
            return None

        try:
            # utf-8-sig: files saved by Windows Notepad may start with a byte-order mark.
            data = loads_json(p.read_text(encoding="utf-8-sig"), parse_constant=constant)
        except (OSError, ValueError) as exc:
            problems.append(f"Could not read JSON sidecar {p.name}: {exc}")
            continue
        if non_finite:
            problems.append(
                f"JSON sidecar {p.name} contains {', '.join(sorted(set(non_finite)))}, which is not valid JSON; "
                "these values are written as null in ElectroTag's outputs"
            )
        if not isinstance(data, dict):
            problems.append(f"JSON sidecar {p.name} does not contain an object")
            continue
        merged.update(data)
    return merged, problems
