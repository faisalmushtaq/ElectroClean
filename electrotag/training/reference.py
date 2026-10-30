"""Reference annotation sets for training and competency assessment.

A reference set lives in its own folder (by default
``<dataset>/derivatives/electrotag_reference_sets/<set_id>/``)::

    reference_set.json            metadata, provenance, recordings, criteria, quiz
    references/<...>_annotations.json   one canonical reference file per recording
    sources/                      copies of the expert files the references came from
    recordings/                   (self-contained sets only) the recordings themselves

A *self-contained* set (``recordings_dir`` set, normally ``"recordings"``) keeps
its recordings inside its own folder, laid out like a small BIDS dataset, so
training recordings are never offered for study annotation and the set can be
copied from one study to another. Other sets refer to recordings of the study
dataset.

Each recording is used for one of three purposes: ``guided`` (learning with the
experts, matched step by step with feedback), ``practice`` (on one's own, annotated
independently and then scored) or ``assessment`` (blinded). A set also offers
*snippets*, short examples of each artifact type for the training path's "Meet the
artifacts" stage: its own (``snippets``, chosen by the study team) and one for each
reference annotation of its guided recordings (:func:`set_snippets`). Practice and
assessment recordings never give snippets, which would give their answers away.

Reference annotations use the same canonical format as every other
ElectroTag annotation file, with annotator ID ``REFERENCE`` and the
provenance stored in the file's session context, so Components B and C can
read them without special cases.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from electrotag import __version__
from electrotag.app.annotations.model import AnnotationDocument, AnnotationError
from electrotag.app.common import now_local_iso, safe_component
from electrotag.app.io.atomic import atomic_write_json, sha256_file
from electrotag.app.io.canonical import read_annotations_json, write_annotations_json
from electrotag.config.settings import StudyConfig

SCHEMA = "electrotag.reference_set"
SCHEMA_VERSION = "1.0.0"
REFERENCE_ANNOTATOR = "REFERENCE"
METHODS = ("single_expert", "consensus", "adjudicated")
#: How each method is described to people.
METHOD_NAMES = {
    "single_expert": "one expert's annotations",
    "consensus": "consensus of several experts",
    "adjudicated": "adjudicated consensus",
}
USES = ("guided", "practice", "assessment")
#: How each use is described to people.
USE_NAMES = {
    "guided": "guided (learn with the experts)",
    "practice": "practice (on your own, with feedback)",
    "assessment": "assessment (blinded)",
}
#: How much help each guided recording gives (see electrotag/training/guided.py).
GUIDANCE_LEVELS = ("show", "find", "find_unnamed")
DEFAULT_DIRNAME = Path("derivatives") / "electrotag_reference_sets"
#: The longest snippet, in seconds, and the most context shown on each side of it.
SNIPPET_MAX_S = 60.0
SNIPPET_MAX_CONTEXT_S = 10.0
#: The uses of a recording that a snippet may never come from (their references are the answers).
NO_SNIPPETS_FROM = ("practice", "assessment")


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
    # Where the item came from, when it was made from something else: an entry of the library of
    # adjudicated conflicts ({"library_entry", "task_id", "conflict_id", "promote_id", ...}); {} otherwise.
    source: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        out = {
            "item_id": self.item_id,
            "recording_id": self.recording_id,
            "start_s": self.start_s,
            "end_s": self.end_s,
            "correct_label": self.correct_label,
            "accepted_labels": self.accepted_labels,
            "explanation": self.explanation,
            "context_s": self.context_s,
        }
        if self.source:
            out["source"] = dict(self.source)
        return out

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
            source=dict(d.get("source") or {}),
        )

    def is_correct(self, answer: str) -> bool:
        return answer == self.correct_label or answer in self.accepted_labels


#: Quiz answer for a segment without an artifact (offered when ``include_none_option`` is set).
NONE_OPTION = "No artifact / none of these"


@dataclass
class Snippet:
    """A short example of an artifact type for the training path's "Meet the artifacts" stage (docs/web/api.md,
    "Training stages"): a stretch of a recording of the set, with its type and the experts' explanation, shown
    with ``context_s`` of EEG on each side. ``channels`` are the channels the artifact is on (none: the whole
    montage); ``source`` says where it came from (``{"kind": "guided", "annotation_id"}`` for one made from a
    guided reference, ``{"kind": "added", "by"}`` for one the study team added, or a library entry)."""

    snippet_id: str
    recording_id: str
    start_s: float
    end_s: float
    label: str
    explanation: str = ""
    context_s: float = 2.0
    channels: list[str] = field(default_factory=list)
    source: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"snippet_id": self.snippet_id, "recording_id": self.recording_id, "start_s": self.start_s,
                "end_s": self.end_s, "label": self.label, "explanation": self.explanation,
                "context_s": self.context_s, "channels": list(self.channels), "source": dict(self.source)}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Snippet:
        return cls(snippet_id=str(d["snippet_id"]), recording_id=str(d["recording_id"]),
                   start_s=float(d["start_s"]), end_s=float(d["end_s"]), label=str(d["label"]),
                   explanation=str(d.get("explanation", "")), context_s=float(d.get("context_s", 2.0)),
                   channels=[str(c) for c in d.get("channels", [])], source=dict(d.get("source") or {}))


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
    # Self-contained sets keep their recordings in this folder (relative to the set's folder).
    recordings_dir: str = ""
    # Stage 1 settings: {"tolerance": {...}, "notes": {annotation_id: text}} (see training/guided.py).
    guided: dict[str, Any] = field(default_factory=dict)
    # Stage 2 pass rule, e.g. {"event_f1": 0.8, "label_accuracy": 0.8} (see training/programme.py).
    practice_pass: dict[str, Any] = field(default_factory=dict)
    # The snippets the study team added (Snippet.to_dict); those of the guided references are made as needed.
    snippets: list[dict[str, Any]] = field(default_factory=list)

    # ------------------------------------------------------------ properties
    @property
    def path(self) -> Path:
        return self.directory / "reference_set.json"

    @property
    def practice_recordings(self) -> list[str]:
        return [r for r, e in self.recordings.items() if e.get("use") == "practice"]

    @property
    def guided_recordings(self) -> list[str]:
        """Stage 1 recordings, in the order they were added (the order trainees meet them)."""
        return [r for r, e in self.recordings.items() if e.get("use") == "guided"]

    @property
    def self_contained(self) -> bool:
        return bool(self.recordings_dir)

    def recordings_root(self) -> Path | None:
        """The folder that holds a self-contained set's recordings (None for dataset-based sets)."""
        return self.directory / self.recordings_dir if self.recordings_dir else None

    def guidance_for(self, recording_id: str) -> str:
        """How much help a guided recording gives: its own setting, or by its place in the order
        (the first shows each artifact, the second names it, later ones only say an artifact follows)."""
        chosen = str(self.recordings.get(recording_id, {}).get("guidance", ""))
        if chosen in GUIDANCE_LEVELS:
            return chosen
        order = self.guided_recordings
        index = order.index(recording_id) if recording_id in order else 0
        return GUIDANCE_LEVELS[min(index, len(GUIDANCE_LEVELS) - 1)]

    def guided_note(self, annotation_id: str) -> str:
        return str(dict(self.guided.get("notes", {})).get(annotation_id, ""))

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
            "electrotag_version": __version__,
            "provenance": self.provenance,
            "recordings": self.recordings,
            "assigned_annotators": self.assigned_annotators,
            "criteria": self.criteria,
            "analysis": self.analysis,
            "quiz": self.quiz,
            "practice_review": self.practice_review,
            "show_full_report_to_annotator": self.show_full_report_to_annotator,
            "recordings_dir": self.recordings_dir,
            "guided": self.guided,
            "practice_pass": self.practice_pass,
            "snippets": self.snippets,
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
            raise ReferenceSetError(f"{path} is not an ElectroTag reference set")
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
            recordings_dir=str(d.get("recordings_dir", "") or ""),
            guided=dict(d.get("guided", {}) or {}),
            practice_pass=dict(d.get("practice_pass", {}) or {}),
            snippets=[dict(x) for x in (d.get("snippets") or []) if isinstance(x, dict)],
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
        """Change whether a reference recording is used for guided learning, practice or assessment."""
        if use not in USES:
            raise ReferenceSetError(f"use must be one of {USES}")
        if recording_id not in self.recordings:
            raise ReferenceSetError(f"{recording_id} is not part of reference set {self.set_id}")
        self.recordings[recording_id]["use"] = use
        self.save()

    def set_guidance(self, recording_id: str, guidance: str) -> None:
        """How much help a guided recording gives: show, find or find_unnamed ("" = by its place)."""
        if guidance and guidance not in GUIDANCE_LEVELS:
            raise ReferenceSetError(f"guidance must be one of {GUIDANCE_LEVELS}")
        if recording_id not in self.recordings:
            raise ReferenceSetError(f"{recording_id} is not part of reference set {self.set_id}")
        if guidance:
            self.recordings[recording_id]["guidance"] = guidance
        else:
            self.recordings[recording_id].pop("guidance", None)
        self.save()

    def set_guided_note(self, annotation_id: str, text: str) -> None:
        """The experts' explanation of one reference annotation, shown in Stage 1 ("" removes it)."""
        ids = set()
        for rid in self.recordings:
            try:
                ids.update(a.annotation_id for a in self.reference_document(rid).annotations)
            except (ReferenceSetError, OSError, ValueError):
                continue
        if annotation_id not in ids:
            raise ReferenceSetError(f"No reference annotation {annotation_id!r} in reference set {self.set_id}")
        notes = dict(self.guided.get("notes", {}))
        if text.strip():
            notes[annotation_id] = text.strip()
        else:
            notes.pop(annotation_id, None)
        self.guided["notes"] = notes
        self.save()

    def set_guided_tolerance(self, tolerance: dict[str, Any]) -> None:
        from electrotag.training.guided import Tolerance

        self.guided["tolerance"] = Tolerance.from_dict(tolerance).to_dict()  # validates
        self.save()

    def set_practice_pass(self, rule: dict[str, Any]) -> None:
        from electrotag.training.programme import PassRule

        self.practice_pass = PassRule.from_dict(rule).to_dict()  # validates
        self.save()

    # ------------------------------------------------ self-contained recordings
    def add_recording_files(self, recording_file: Path, *, recording_id: str | None = None) -> str:
        """Copy a recording, with its companion files and BIDS sidecars, into this set's own folder.

        Returns the recording's ID inside the set (its path below the set's recordings folder). The
        set becomes self-contained if it was not already. ``recording_id`` defaults to
        ``<sub>/eeg/<file name>`` (the subject taken from a BIDS file name, or ``sub-<stem>``).
        """
        from electrotag.app.io.discovery import DEFAULT_SUFFIXES, discover_recordings

        src = Path(recording_file)
        if not src.is_file():
            raise ReferenceSetError(f"Recording not found: {src}")
        if not src.name.lower().endswith(tuple(DEFAULT_SUFFIXES)):
            raise ReferenceSetError(
                f"{src.name}: a recording's file name must end in {', '.join(DEFAULT_SUFFIXES)} (BIDS naming)"
            )
        if recording_id is None:
            sub = src.name.split("_")[0] if src.name.startswith("sub-") else "sub-" + safe_component(src.stem)
            recording_id = f"{sub}/eeg/{src.name}"
        parts = Path(recording_id).parts
        if Path(recording_id).is_absolute() or ".." in parts:
            raise ReferenceSetError(f"Unsafe recording ID {recording_id!r}")
        if not self.recordings_dir:
            self.recordings_dir = "recordings"
        root = self.directory / self.recordings_dir
        dest_dir = root / Path(recording_id).parent
        dest_dir.mkdir(parents=True, exist_ok=True)
        # Companion files (.vmrk, .eeg) and BIDS sidecars share the part of the name before "_eeg".
        stem = src.name[: src.name.lower().rfind("_eeg")]
        for f in sorted(src.parent.iterdir()):
            if f.is_file() and (f == src or f.name.startswith(stem + "_")):
                target = dest_dir / f.name
                if f.resolve() != target.resolve():
                    shutil.copy2(f, target)
        found = {r.recording_id for r in discover_recordings(root, suffixes=DEFAULT_SUFFIXES)}
        if recording_id not in found:
            raise ReferenceSetError(f"{src.name} was copied but could not be found again as {recording_id}")
        self.save()
        return recording_id

    def remove_quiz_item(self, item_id: str) -> None:
        items = [d for d in self.quiz.get("items", []) if d["item_id"] != item_id]
        if len(items) == len(self.quiz.get("items", [])):
            raise ReferenceSetError(f"Quiz item {item_id!r} is not in reference set {self.set_id}")
        self.quiz["items"] = items
        self.save()

    def set_criteria(self, criteria: dict[str, Any]) -> None:
        from electrotag.training.assessment import CompetencyCriteria

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

    # ------------------------------------------------------------- snippets
    @property
    def own_snippets(self) -> list[Snippet]:
        return [Snippet.from_dict(d) for d in self.snippets]

    def next_snippet_id(self) -> str:
        taken = {str(d.get("snippet_id")) for d in self.snippets}
        n = 1
        while f"s{n:02d}" in taken:
            n += 1
        return f"s{n:02d}"

    def add_snippet(self, snippet: Snippet | dict[str, Any], catalogue_labels: tuple[str, ...] | None = None) -> None:
        """Keep a snippet (in place of one with its ID): a :class:`Snippet` or its dict (``to_dict``, as the library's
        "promote to snippet" makes one). It must be between 0 and :data:`SNIPPET_MAX_S` long, never from a practice
        or assessment recording of this set, and of a permitted type when ``catalogue_labels`` are given."""
        if isinstance(snippet, dict):
            if not str(snippet.get("snippet_id") or ""):
                raise ReferenceSetError("A snippet needs a snippet_id")
            try:
                snippet = Snippet.from_dict(snippet)
            except (KeyError, TypeError, ValueError) as exc:
                raise ReferenceSetError(f"A snippet needs {exc}") from exc
        if catalogue_labels is not None and snippet.label not in catalogue_labels:
            raise ReferenceSetError(f"{snippet.label!r} is not a permitted label")
        if not 0 <= snippet.start_s < snippet.end_s:
            raise ReferenceSetError("A snippet's end must be after its start, which is at 0 s or later")
        if snippet.end_s - snippet.start_s > SNIPPET_MAX_S:
            raise ReferenceSetError(f"A snippet is at most {SNIPPET_MAX_S:g} s long")
        if not 0 <= snippet.context_s <= SNIPPET_MAX_CONTEXT_S:
            raise ReferenceSetError(f"The context of a snippet is between 0 and {SNIPPET_MAX_CONTEXT_S:g} s")
        use = self.recordings.get(snippet.recording_id, {}).get("use")
        if use in NO_SNIPPETS_FROM:
            raise ReferenceSetError(f"{snippet.recording_id} is a {use} recording of this set: a snippet of it "
                                    "would show trainees the answers")
        kept = [d for d in self.snippets if d.get("snippet_id") != snippet.snippet_id]
        kept.append(snippet.to_dict())
        self.snippets = kept
        self.save()

    def remove_snippet(self, snippet_id: str) -> None:
        kept = [d for d in self.snippets if d.get("snippet_id") != snippet_id]
        if len(kept) == len(self.snippets):
            raise ReferenceSetError(f"Snippet {snippet_id!r} is not in reference set {self.set_id}")
        self.snippets = kept
        self.save()


def guided_snippets(rs: ReferenceSet) -> list[Snippet]:
    """One snippet for each reference annotation of the set's guided recordings, in the order trainees meet the
    recordings and then by time, with the experts' note on it as the explanation. Practice and assessment
    references never give snippets."""
    out: list[Snippet] = []
    for rid in rs.guided_recordings:
        doc = rs.reference_document(rid)
        sfreq = float(doc.recording.timing.sfreq)
        for a in sorted(doc.annotations, key=lambda x: (x.onset_sample, x.annotation_id)):
            out.append(Snippet(snippet_id=f"g-{a.annotation_id}", recording_id=rid, start_s=a.onset_sample / sfreq,
                               end_s=(a.onset_sample + a.duration_samples) / sfreq, label=a.label,
                               explanation=rs.guided_note(a.annotation_id), context_s=2.0, channels=list(a.channels),
                               source={"kind": "guided", "annotation_id": a.annotation_id}))
    return out


def set_snippets(rs: ReferenceSet) -> list[Snippet]:
    """Every snippet of a set: the study team's own first, in the order they were added, then those of the guided
    references (:func:`guided_snippets`). A guided reference that cannot be read gives none."""
    own = [x for x in rs.own_snippets if rs.recordings.get(x.recording_id, {}).get("use") not in NO_SNIPPETS_FROM]
    try:
        derived = guided_snippets(rs)
    except (ReferenceSetError, OSError, ValueError):
        derived = []
    return own + derived


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


def import_expert_recording(
    rs: ReferenceSet, recording_file: Path, expert_file: Path, *, use: str, guidance: str = "",
    expert_id: str | None = None,
) -> str:
    """Copy a recording into a self-contained set and use an expert's annotations of it as its reference.

    The expert's file must describe the same recording (the same timing and channels); its
    recording ID is replaced by the recording's ID inside the set. Returns that ID.
    """
    from dataclasses import replace

    doc = read_annotations_json(expert_file)
    rid = rs.add_recording_files(recording_file)
    doc = replace(doc, recording=replace(doc.recording, recording_id=rid, relative_path=rid))
    expert = expert_id or doc.annotator_id
    rs.add_reference(doc, use=use, method="single_expert", experts=[expert], source_files=[expert_file])
    if guidance:
        rs.set_guidance(rid, guidance)
    return rid


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
