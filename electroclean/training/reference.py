"""Reference annotation sets for training and competency assessment.

A reference set lives in its own folder (by default
``<dataset>/derivatives/electroclean_reference_sets/<set_id>/``)::

    reference_set.json            metadata, provenance, recordings, criteria, quiz
    references/<...>_annotations.json   one canonical reference file per recording
    sources/                      copies of the expert files the references came from

Reference annotations use the same canonical format as every other
ElectroClean annotation file, with annotator ID ``REFERENCE`` and the
provenance stored in the file's session context, so Components B and C can
read them without special cases.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from electroclean import __version__
from electroclean.app.annotations.model import AnnotationDocument, AnnotationError
from electroclean.app.common import now_local_iso, safe_component
from electroclean.app.io.atomic import atomic_write_json, sha256_file
from electroclean.app.io.canonical import read_annotations_json, write_annotations_json
from electroclean.config.settings import StudyConfig

SCHEMA = "electroclean.reference_set"
SCHEMA_VERSION = "1.0.0"
REFERENCE_ANNOTATOR = "REFERENCE"
METHODS = ("single_expert", "consensus", "adjudicated")
#: How each method is described to people.
METHOD_NAMES = {
    "single_expert": "one expert's annotations",
    "consensus": "consensus of several experts",
    "adjudicated": "adjudicated consensus",
}
USES = ("practice", "assessment")
DEFAULT_DIRNAME = Path("derivatives") / "electroclean_reference_sets"


class ReferenceSetError(ValueError):
    pass


def reference_sets_dir(dataset_root: Path, study: StudyConfig | None) -> Path:
    custom = (study.training.get("reference_sets_dir") if study is not None else None) or None
    if custom:
        p = Path(custom)
        return p if p.is_absolute() else Path(dataset_root) / p
    return Path(dataset_root) / DEFAULT_DIRNAME


@dataclass
class QuizItem:
    item_id: str
    recording_id: str
    start_s: float
    end_s: float
    correct_label: str
    accepted_labels: list[str] = field(default_factory=list)
    explanation: str = ""
    context_s: float = 2.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "item_id": self.item_id,
            "recording_id": self.recording_id,
            "start_s": self.start_s,
            "end_s": self.end_s,
            "correct_label": self.correct_label,
            "accepted_labels": self.accepted_labels,
            "explanation": self.explanation,
            "context_s": self.context_s,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> QuizItem:
        return cls(
            item_id=str(d["item_id"]),
            recording_id=str(d["recording_id"]),
            start_s=float(d["start_s"]),
            end_s=float(d["end_s"]),
            correct_label=str(d["correct_label"]),
            accepted_labels=[str(x) for x in d.get("accepted_labels", [])],
            explanation=str(d.get("explanation", "")),
            context_s=float(d.get("context_s", 2.0)),
        )

    def is_correct(self, answer: str) -> bool:
        return answer == self.correct_label or answer in self.accepted_labels


#: Quiz answer for a segment without an artifact (offered when ``include_none_option`` is set).
NONE_OPTION = "No artifact / none of these"


@dataclass
class ReferenceSet:
    directory: Path
    set_id: str
    name: str = ""
    description: str = ""
    created_at: str = ""
    created_by: str = ""
    provenance: dict[str, Any] = field(default_factory=dict)
    recordings: dict[str, dict[str, Any]] = field(default_factory=dict)
    assigned_annotators: list[str] = field(default_factory=list)
    criteria: dict[str, Any] = field(default_factory=dict)
    analysis: dict[str, Any] = field(default_factory=dict)
    quiz: dict[str, Any] = field(default_factory=dict)
    practice_review: bool = True
    # Whether an annotator sees the full competency report (with the missed and extra artifacts, their
    # times and channels) at the end of the assessment. Off by default: assessment recordings are
    # shared between annotators, so the full report would show the next one where the artifacts are.
    show_full_report_to_annotator: bool = False

    # ------------------------------------------------------------ properties
    @property
    def path(self) -> Path:
        return self.directory / "reference_set.json"

    @property
    def practice_recordings(self) -> list[str]:
        return [r for r, e in self.recordings.items() if e.get("use") == "practice"]

    @property
    def assessment_recordings(self) -> list[str]:
        return [r for r, e in self.recordings.items() if e.get("use") == "assessment"]

    @property
    def quiz_items(self) -> list[QuizItem]:
        return [QuizItem.from_dict(d) for d in self.quiz.get("items", [])]

    def reference_path(self, recording_id: str) -> Path:
        try:
            return self.directory / self.recordings[recording_id]["reference_file"]
        except KeyError as exc:
            raise ReferenceSetError(f"{recording_id} is not part of reference set {self.set_id}") from exc

    def reference_document(self, recording_id: str) -> AnnotationDocument:
        entry = self.recordings.get(recording_id)
        if entry is None:
            raise ReferenceSetError(f"{recording_id} is not part of reference set {self.set_id}")
        path = self.reference_path(recording_id)
        expected = entry.get("sha256")
        if expected and sha256_file(path) != expected:
            raise ReferenceSetError(
                f"The reference file for {recording_id} has changed since it was added to the set "
                "(checksum mismatch). Re-import it through the administrator tools."
            )
        return read_annotations_json(path)

    # ----------------------------------------------------------- persistence
    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "set_id": self.set_id,
            "name": self.name,
            "description": self.description,
            "created_at": self.created_at,
            "created_by": self.created_by,
            "electroclean_version": __version__,
            "provenance": self.provenance,
            "recordings": self.recordings,
            "assigned_annotators": self.assigned_annotators,
            "criteria": self.criteria,
            "analysis": self.analysis,
            "quiz": self.quiz,
            "practice_review": self.practice_review,
            "show_full_report_to_annotator": self.show_full_report_to_annotator,
        }

    def save(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        atomic_write_json(self.path, self.to_dict())

    @classmethod
    def load(cls, directory: Path | str) -> ReferenceSet:
        directory = Path(directory)
        path = directory / "reference_set.json"
        try:
            d = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ReferenceSetError(f"Cannot read {path}: {exc}") from exc
        if d.get("schema") != SCHEMA:
            raise ReferenceSetError(f"{path} is not an ElectroClean reference set")
        return cls(
            directory=directory,
            set_id=str(d["set_id"]),
            name=str(d.get("name", "")),
            description=str(d.get("description", "")),
            created_at=str(d.get("created_at", "")),
            created_by=str(d.get("created_by", "")),
            provenance=dict(d.get("provenance", {})),
            recordings=dict(d.get("recordings", {})),
            assigned_annotators=list(d.get("assigned_annotators", [])),
            criteria=dict(d.get("criteria", {})),
            analysis=dict(d.get("analysis", {})),
            quiz=dict(d.get("quiz", {})),
            practice_review=bool(d.get("practice_review", True)),
            # Sets written before version 1.1 could only set this as quiz.show_report_to_annotator.
            show_full_report_to_annotator=bool(
                d.get("show_full_report_to_annotator", dict(d.get("quiz", {})).get("show_report_to_annotator", False))
            ),
        )

    @classmethod
    def create(cls, base_dir: Path, set_id: str, *, name: str = "", description: str = "", created_by: str = "",
               method: str = "single_expert", experts: list[str] | None = None, notes: str = "") -> ReferenceSet:
        sid = safe_component(set_id)
        if sid != set_id:
            raise ReferenceSetError("Reference set IDs may only contain letters, digits, '.', '_' and '-'")
        if method not in METHODS:
            raise ReferenceSetError(f"Method must be one of {METHODS}")
        directory = Path(base_dir) / sid
        if (directory / "reference_set.json").exists():
            raise ReferenceSetError(f"Reference set {sid} already exists")
        rs = cls(
            directory=directory,
            set_id=sid,
            name=name,
            description=description,
            created_at=now_local_iso(),
            created_by=created_by,
            provenance={"method": method, "experts": list(experts or []), "notes": notes},
        )
        rs.save()
        return rs

    # -------------------------------------------------------------- editing
    def add_reference(
        self,
        doc: AnnotationDocument,
        *,
        use: str,
        method: str,
        experts: list[str],
        source_files: list[Path] | None = None,
        adjudicator: str = "",
        details: dict[str, Any] | None = None,
    ) -> Path:
        """Store ``doc`` as the reference for its recording."""
        if use not in USES:
            raise ReferenceSetError(f"use must be one of {USES}")
        if method not in METHODS:
            raise ReferenceSetError(f"method must be one of {METHODS}")
        if method == "adjudicated" and not adjudicator:
            raise ReferenceSetError("An adjudicated reference must name the adjudicator")
        if method == "consensus" and len(experts) < 2:
            raise ReferenceSetError("A consensus reference needs at least two experts")
        doc.validate()
        rid = doc.recording.recording_id
        sources = []
        src_dir = self.directory / "sources"
        for f in source_files or []:
            f = Path(f)
            dest = src_dir / safe_component(rid.replace("/", "__")) / f.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            if f.resolve() != dest.resolve():
                shutil.copy2(f, dest)
            sources.append({"file": dest.relative_to(self.directory).as_posix(), "sha256": sha256_file(dest)})
        provenance = {
            "method": method,
            "experts": experts,
            "adjudicator": adjudicator,
            "sources": sources,
            "added_at": now_local_iso(),
            **(details or {}),
        }
        ref = AnnotationDocument(
            recording=doc.recording,
            annotator_id=REFERENCE_ANNOTATOR,
            annotator_display_name=f"Reference ({method})",
            annotations=list(doc.annotations),
            catalogue=doc.catalogue,
            session_id=f"reference-{self.set_id}",
            mode="reference",
            created_at=now_local_iso(),
            app_version=__version__,
            context={"reference_set_id": self.set_id, "provenance": provenance},
        )
        base = rid.replace("/", "__")
        # BrainVision names keep their earlier form; others keep their extension (x_eeg.edf -> x_eeg_edf)
        # so that two formats of one recording can never share a reference file.
        base = base.removesuffix(".vhdr") if base.endswith(".vhdr") else base.replace(".", "_")
        name = safe_component(base) + "_reference_annotations.json"
        path = self.directory / "references" / name
        write_annotations_json(path, ref, overwrite=True)
        self.recordings[rid] = {
            "use": use,
            "reference_file": path.relative_to(self.directory).as_posix(),
            "sha256": sha256_file(path),
            "n_annotations": len(ref.annotations),
            "provenance": provenance,
        }
        self.save()
        return path

    def remove_recording(self, recording_id: str) -> None:
        self.recordings.pop(recording_id, None)
        self.save()

    def set_use(self, recording_id: str, use: str) -> None:
        """Change whether a reference recording is used for practice or for assessment."""
        if use not in USES:
            raise ReferenceSetError(f"use must be one of {USES}")
        if recording_id not in self.recordings:
            raise ReferenceSetError(f"{recording_id} is not part of reference set {self.set_id}")
        self.recordings[recording_id]["use"] = use
        self.save()

    def remove_quiz_item(self, item_id: str) -> None:
        items = [d for d in self.quiz.get("items", []) if d["item_id"] != item_id]
        if len(items) == len(self.quiz.get("items", [])):
            raise ReferenceSetError(f"Quiz item {item_id!r} is not in reference set {self.set_id}")
        self.quiz["items"] = items
        self.save()

    def set_criteria(self, criteria: dict[str, Any]) -> None:
        from electroclean.training.assessment import CompetencyCriteria

        CompetencyCriteria.from_dict(criteria)  # validates
        self.criteria = criteria
        self.save()

    def add_quiz_item(self, item: QuizItem, catalogue_labels: tuple[str, ...]) -> None:
        if item.correct_label == NONE_OPTION:
            if not self.quiz.get("include_none_option", False):
                raise ReferenceSetError(
                    f"{NONE_OPTION!r} can be the answer only when the quiz offers that option (include_none_option)"
                )
        elif item.correct_label not in catalogue_labels:
            raise ReferenceSetError(f"{item.correct_label!r} is not a permitted label")
        if item.end_s <= item.start_s:
            raise ReferenceSetError("Quiz segment end must be after its start")
        items = [d for d in self.quiz.get("items", []) if d["item_id"] != item.item_id]
        items.append(item.to_dict())
        self.quiz["items"] = items
        self.save()


def find_reference_sets(directory: Path) -> list[ReferenceSet]:
    if not Path(directory).is_dir():
        return []
    out = []
    for sub in sorted(Path(directory).iterdir()):
        if (sub / "reference_set.json").is_file():
            try:
                out.append(ReferenceSet.load(sub))
            except ReferenceSetError:
                continue
    return out


def load_reference_set_by_id(dataset_root: Path, study: StudyConfig | None, set_id: str) -> ReferenceSet:
    for rs in find_reference_sets(reference_sets_dir(dataset_root, study)):
        if rs.set_id == set_id:
            return rs
    raise ReferenceSetError(f"Reference set {set_id!r} was not found")


def import_expert_reference(
    rs: ReferenceSet, expert_file: Path, *, use: str, expert_id: str | None = None
) -> Path:
    """Use one expert's annotation file as the reference (method ``single_expert``)."""
    doc = read_annotations_json(expert_file)
    expert = expert_id or doc.annotator_id
    # A file without annotations is a valid reference: the expert judged the recording clean.
    return rs.add_reference(doc, use=use, method="single_expert", experts=[expert], source_files=[expert_file])


def import_adjudicated_reference(
    rs: ReferenceSet, adjudicated_file: Path, *, use: str, experts: list[str], adjudicator: str | None = None,
    expert_files: list[Path] | None = None, disagreements_file: Path | None = None,
) -> Path:
    """Use an adjudicator's final annotations, recording which experts' work was adjudicated."""
    doc = read_annotations_json(adjudicated_file)
    if len(experts) < 2:
        raise AnnotationError("Adjudication resolves disagreements between at least two experts")
    files = [adjudicated_file, *(expert_files or [])]
    if disagreements_file is not None:
        files.append(disagreements_file)
    return rs.add_reference(
        doc, use=use, method="adjudicated", experts=experts, adjudicator=adjudicator or doc.annotator_id,
        source_files=files,
    )
