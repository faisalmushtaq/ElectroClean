"""Loading and grouping canonical annotation files for comparison."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from electroclean.app.annotations.labels import LabelCatalogue
from electroclean.app.annotations.model import AnnotationDocument, AnnotationError
from electroclean.app.annotations.timing import RecordingTiming
from electroclean.app.io.atomic import sha256_file
from electroclean.app.io.canonical import read_annotations_json
from electroclean.reliability.config import AnalysisConfig


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
            raise AnnotationError(
                f"{source} uses label catalogue {doc.catalogue.catalogue_id} {doc.catalogue.catalogue_version} "
                f"({doc.catalogue.sha256[:12]}), which differs from the others ({catalogue.sha256[:12]}). "
                "Annotations made with different label sets cannot be compared."
            )
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
            items.sort(key=lambda sd: (sd[1].created_at, sd[0]))
            warnings.append(
                f"{key[1]} annotated {key[0]} {len(items)} times; using the most recent ({items[-1][0]})"
            )
        chosen[key] = items[-1]

    groups: dict[str, RecordingGroup] = {}
    for (rid, aid), (source, doc) in sorted(chosen.items()):
        g = groups.get(rid)
        if g is None:
            groups[rid] = RecordingGroup(rid, doc.recording.timing, tuple(doc.recording.ch_names), {aid: doc})
            continue
        if doc.recording.timing.sfreq != g.timing.sfreq or doc.recording.timing.n_samples != g.timing.n_samples:
            warnings.append(
                f"{source}: timing of {rid} ({doc.recording.timing.sfreq} Hz, {doc.recording.timing.n_samples} samples) "
                f"differs from other annotators' ({g.timing.sfreq} Hz, {g.timing.n_samples}); excluded"
            )
            continue
        ref_doc = next(iter(g.docs.values()))
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


def load_dataset(paths: Iterable[Path | str], config: AnalysisConfig) -> AgreementDataset:
    files = collect_annotation_files(paths)
    docs = []
    records = []
    for f in files:
        try:
            doc = read_annotations_json(f)
        except AnnotationError as exc:
            records.append({"path": str(f), "status": f"skipped: {exc}"})
            continue
        docs.append((str(f), doc))
        records.append(
            {
                "path": str(f),
                "sha256": sha256_file(f),
                "recording_id": doc.recording.recording_id,
                "annotator_id": doc.annotator_id,
                "mode": doc.mode,
                "n_annotations": str(len(doc.annotations)),
                "status": "read",
            }
        )
    ds = build_dataset(docs, config, files=records)
    skipped = [r for r in records if r["status"].startswith("skipped")]
    ds.warnings.extend(f"{r['path']}: {r['status']}" for r in skipped)
    return ds
