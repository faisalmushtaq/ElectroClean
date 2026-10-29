"""Loading and grouping canonical annotation files for comparison."""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from electrotag.app.annotations.labels import LabelCatalogue
from electrotag.app.annotations.model import AnnotationDocument, AnnotationError
from electrotag.app.annotations.timing import RecordingTiming
from electrotag.app.io.atomic import sha256_file
from electrotag.app.io.canonical import read_annotations_json
from electrotag.hints import unknown_names
from electrotag.reliability.config import AnalysisConfig


@dataclass
class RecordingGroup:
    """All annotators' documents for one recording."""

    recording_id: str
    timing: RecordingTiming
    ch_names: tuple[str, ...]
    docs: dict[str, AnnotationDocument]
    warnings: list[str] = field(default_factory=list)

    @property
    def annotators(self) -> list[str]:
        return sorted(self.docs)


@dataclass
class AgreementDataset:
    groups: dict[str, RecordingGroup]
    catalogue: LabelCatalogue
    files: list[dict[str, str]]
    warnings: list[str]

    @property
    def annotators(self) -> list[str]:
        return sorted({a for g in self.groups.values() for a in g.docs})


def collect_annotation_files(paths: Iterable[Path | str]) -> list[Path]:
    out: list[Path] = []
    for p in paths:
        p = Path(p)
        if p.is_dir():
            out.extend(
                q for q in sorted(p.rglob("*_annotations.json"))
                if not any(part.startswith(".") for part in q.relative_to(p).parts)
            )
        elif p.is_file():
            out.append(p)
        else:
            raise FileNotFoundError(f"Not found: {p}")
    return sorted(set(out))


def build_dataset(
    documents: Iterable[tuple[str, AnnotationDocument]], config: AnalysisConfig, *, files: list[dict[str, str]] | None = None
) -> AgreementDataset:
    """Group documents by recording and check that they are comparable."""
    warnings: list[str] = []
    catalogue: LabelCatalogue | None = None
    by_key: dict[tuple[str, str], list[tuple[str, AnnotationDocument]]] = {}
    for source, doc in documents:
        if doc.mode not in config.modes:
            continue
        if config.annotators is not None and doc.annotator_id not in config.annotators:
            continue
        if catalogue is None:
            catalogue = doc.catalogue
        elif doc.catalogue.sha256 != catalogue.sha256:
            if not doc.catalogue.compatible_with(catalogue):
                raise AnnotationError(
                    f"{source} uses label catalogue {doc.catalogue.catalogue_id} {doc.catalogue.catalogue_version} "
                    f"({doc.catalogue.sha256[:12]}), which gives labels or codes a different meaning from the "
                    f"others ({catalogue.catalogue_version}, {catalogue.sha256[:12]}). They cannot be compared."
                )
            # Compatible versions (codes are never reused): analyse with the larger catalogue.
            larger = doc.catalogue if len(doc.catalogue.labels) > len(catalogue.labels) else catalogue
            note = (
                f"Files use label catalogue versions {catalogue.catalogue_version} and "
                f"{doc.catalogue.catalogue_version}; they are compatible and analysed with {larger.catalogue_version}"
            )
            if note not in warnings:
                warnings.append(note)
            if not larger.covers(doc.catalogue if larger is catalogue else catalogue):
                # Neither contains the other: combine them.
                larger = _union_catalogue(catalogue, doc.catalogue)
            catalogue = larger
        by_key.setdefault((doc.recording.recording_id, doc.annotator_id), []).append((source, doc))
    if catalogue is None:
        raise AnnotationError("No annotation files matched the analysis settings")

    chosen: dict[tuple[str, str], tuple[str, AnnotationDocument]] = {}
    for key, items in by_key.items():
        if len(items) > 1:
            if config.duplicate_policy == "error":
                raise AnnotationError(
                    f"Annotator {key[1]} has {len(items)} annotation files for {key[0]}: "
                    + ", ".join(s for s, _ in items)
                )
            same_mode = len({d.mode for _s, d in items}) == 1
            items.sort(key=lambda sd: _recency(sd[0], sd[1], by_attempt=same_mode))
            warnings.append(
                f"{key[1]} saved {key[0]} {len(items)} times (revisions or repeats); using the latest ({items[-1][0]})"
            )
        chosen[key] = items[-1]

    per_recording: dict[str, list[tuple[str, str, AnnotationDocument]]] = {}
    for (rid, aid), (source, doc) in sorted(chosen.items()):
        per_recording.setdefault(rid, []).append((aid, source, doc))

    groups: dict[str, RecordingGroup] = {}
    for rid, items in sorted(per_recording.items()):
        baseline = _baseline_timing(items, config.reference_annotator)
        if baseline is None:
            warnings.append(
                f"Annotators' files for {rid} disagree about its timing (sampling rate or number of samples) and no "
                "timing is shared by a majority; the recording is excluded: "
                + ", ".join(f"{aid} {d.recording.timing.sfreq} Hz, {d.recording.timing.n_samples} samples" for aid, _s, d in items)
            )
            continue
        g: RecordingGroup | None = None
        for aid, source, doc in items:
            timing = doc.recording.timing
            if (timing.sfreq, timing.n_samples) != baseline:
                warnings.append(
                    f"{source}: timing of {rid} ({timing.sfreq} Hz, {timing.n_samples} samples) differs from the "
                    f"other annotators' ({baseline[0]} Hz, {baseline[1]} samples); excluded"
                )
                continue
            if g is None:
                g = groups[rid] = RecordingGroup(rid, timing, tuple(doc.recording.ch_names), {aid: doc})
                continue
            ref_doc = g.docs.get(config.reference_annotator or "") or next(iter(g.docs.values()))
            fp_a = (ref_doc.recording.fingerprint.get("eeg") or {}).get("sha256")
            fp_b = (doc.recording.fingerprint.get("eeg") or {}).get("sha256")
            if fp_a and fp_b and fp_a != fp_b:
                g.warnings.append(
                    f"{aid} annotated a different version of {rid} (data checksum differs); kept, but check the data"
                )
            if tuple(doc.recording.ch_names) != g.ch_names:
                common = tuple(c for c in g.ch_names if c in set(doc.recording.ch_names))
                g.warnings.append(f"Channel lists differ for {rid}; channel analyses use the {len(common)} shared channels")
                g.ch_names = common
            g.docs[aid] = doc
    excluded = set(config.channel_exclude)
    for g in groups.values():
        if excluded:
            g.ch_names = tuple(c for c in g.ch_names if c not in excluded)
    return AgreementDataset(groups=groups, catalogue=catalogue, files=files or [], warnings=warnings)


_ATTEMPT_RE = re.compile(r"_attempt-(\d+)_annotations\.json$")


def _attempt(source: str, doc: AnnotationDocument) -> int:
    """The attempt number of a saved file: from its name (``..._attempt-02_annotations.json``), else from
    the revision it records, else 1."""
    m = _ATTEMPT_RE.search(source)
    if m:
        return int(m.group(1))
    revision = doc.context.get("revision") if isinstance(doc.context, dict) else None
    try:
        return int((revision or {}).get("version", 1))
    except (TypeError, ValueError, AttributeError):
        return 1


def _instant(stamp: str) -> float:
    """A saved time as seconds since 1970, so that times written with different UTC offsets compare as the
    moments they are (their text does not: 10:30+01:00 is earlier than 09:45+00:00)."""
    try:
        t = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return float("-inf")
    return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).timestamp()


def _recency(source: str, doc: AnnotationDocument, *, by_attempt: bool) -> tuple[float, float, str]:
    """Sorts one annotator's files of one recording oldest first. Within one mode the attempt number decides
    (each save takes the next, so a revision always comes after what it revises); then the time saved."""
    attempt, instant = float(_attempt(source, doc)), _instant(doc.created_at)
    return (attempt, instant, source) if by_attempt else (instant, attempt, source)


def _union_catalogue(a: LabelCatalogue, b: LabelCatalogue) -> LabelCatalogue:
    """Labels of two compatible catalogues, in the order of the newer one."""
    newer, older = (a, b) if a.catalogue_version >= b.catalogue_version else (b, a)
    items = list(newer.labels) + [x for x in older.labels if not newer.is_permitted(x.label)]
    return LabelCatalogue(
        catalogue_id=newer.catalogue_id,
        catalogue_version=f"{newer.catalogue_version}+{older.catalogue_version}",
        hed_library=newer.hed_library,
        hed_library_version=newer.hed_library_version,
        hed_standard_version=newer.hed_standard_version,
        hed_namespace_prefix=newer.hed_namespace_prefix,
        labels=tuple(items),
    )


def _baseline_timing(
    items: list[tuple[str, str, AnnotationDocument]], reference: str | None
) -> tuple[float, int] | None:
    """Timing that the annotators' files for one recording should share.

    The designated reference annotator's timing if present, otherwise the
    timing shared by more files than any other; ``None`` when two timings are
    equally common (there is no way to tell which is right).
    """
    timings = {aid: (d.recording.timing.sfreq, d.recording.timing.n_samples) for aid, _s, d in items}
    if reference is not None and reference in timings:
        return timings[reference]
    counts: dict[tuple[float, int], int] = {}
    for t in timings.values():
        counts[t] = counts.get(t, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
        return None
    return ranked[0][0]


def _display_path(f: Path, bases: list[Path]) -> str:
    """Path relative to the input folder it was found in (portable in reports)."""
    for b in bases:
        try:
            return (b.name + "/" + f.resolve().relative_to(b.resolve()).as_posix()) if b.is_dir() else f.name
        except ValueError:
            continue
    return f.name


def load_dataset(paths: Iterable[Path | str], config: AnalysisConfig, *, strict: bool = False) -> AgreementDataset:
    """Read and group the annotation files; with ``strict``, unknown annotators are an error."""
    bases = [Path(p) for p in paths]
    files = collect_annotation_files(bases)
    if not files:
        raise FileNotFoundError(
            "No annotation files (*_annotations.json) were found in " + ", ".join(str(b) for b in bases)
            + ". Choose the folder that holds the annotators' results (normally Annotated_Events)."
        )
    docs = []
    records = []
    for f in files:
        try:
            doc = read_annotations_json(f)
        except AnnotationError as exc:
            records.append({"path": _display_path(f, bases), "status": f"skipped: {exc}"})
            continue
        docs.append((_display_path(f, bases), doc))
        records.append(
            {
                "path": _display_path(f, bases),
                "sha256": sha256_file(f),
                "recording_id": doc.recording.recording_id,
                "annotator_id": doc.annotator_id,
                "mode": doc.mode,
                "n_annotations": str(len(doc.annotations)),
                "status": "read",
            }
        )
    if strict and config.annotators:
        found = sorted({d.annotator_id for _s, d in docs})
        msg = unknown_names("annotator", config.annotators, found)
        if msg:
            raise ValueError(msg)
    ds = build_dataset(docs, config, files=records)
    skipped = [r for r in records if r["status"].startswith("skipped")]
    ds.warnings.extend(f"{r['path']}: {r['status']}" for r in skipped)
    return ds
