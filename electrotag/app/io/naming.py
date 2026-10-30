"""Output folder layout and file names.

Layout below the output root (``Annotated_Events`` by default)::

    Annotated_Events/
        completion_register.tsv          authoritative per-annotator register
        failed_load.txt                  simple failure list (original format)
        failure_log.jsonl                structured failure log
        session_log.jsonl                every session start/finish/abandon
        annotator-A01/
            completed_datasets.txt       recording IDs completed by A01
            sub-001/eeg/
                sub-001_task-rest_eeg_annotator-A01_events.tsv
                sub-001_task-rest_eeg_annotator-A01_events.json
                sub-001_task-rest_eeg_annotator-A01_annotations.json
                sub-001_task-rest_eeg_annotator-A01_time_viewed.txt
                sub-001_task-rest_eeg_annotator-A01_session.json
                sub-001_task-rest_eeg_annotator-A01_channels.tsv   (only with channels marked bad)
        training/<reference_set_id>/<practice|assessment>/annotator-A01/...
        .electrotag/                   locks and export staging (internal)

The recording's own sub-folders are mirrored, so recordings with identical
file names in different folders never collide. A second annotation of the same
recording by the same annotator (only possible when an administrator allows
it) gets an ``_attempt-02`` entity rather than overwriting the first.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath

from electrotag.app.common import safe_component, validate_mode

OUTPUT_SUFFIXES: dict[str, str] = {
    "events_tsv": "_events.tsv",
    "events_json": "_events.json",
    "annotations_json": "_annotations.json",
    "time_viewed": "_time_viewed.txt",
    "session_json": "_session.json",
    # written only when the annotator marked channels bad for the whole recording (docs/file_formats.md)
    "channels_tsv": "_channels.tsv",
}
#: The output files every save writes; the others are written when they have something to say.
ALWAYS_WRITTEN = ("events_tsv", "events_json", "annotations_json", "time_viewed", "session_json")

INTERNAL_DIR = ".electrotag"


@dataclass(frozen=True)
class OutputLayout:
    root: Path

    @property
    def internal(self) -> Path:
        return self.root / INTERNAL_DIR

    @property
    def locks(self) -> Path:
        return self.internal / "locks"

    @property
    def staging(self) -> Path:
        return self.internal / "staging"

    @property
    def autosave(self) -> Path:
        return self.internal / "autosave"

    @property
    def quarantine(self) -> Path:
        return self.internal / "interrupted"

    @property
    def register(self) -> Path:
        return self.root / "completion_register.tsv"

    @property
    def failed_load_txt(self) -> Path:
        return self.root / "failed_load.txt"

    @property
    def interaction_logs(self) -> Path:
        """The interaction logs of every visit (see electrotag/app/session/interaction_log.py)."""
        return self.root / "interaction_logs"

    def visit_log_path(self, annotator_id: str, mode: str, started: datetime) -> Path:
        """``interaction_logs/annotator-<ID>/<YYYYMMDDTHHMMSS>_<mode>.jsonl``, unique within its folder."""
        folder = self.interaction_logs / f"annotator-{safe_component(annotator_id)}"
        stem = f"{started.strftime('%Y%m%dT%H%M%S')}_{safe_component(mode)}"
        path = folder / f"{stem}.jsonl"
        n = 2
        while path.exists():
            path = folder / f"{stem}-{n}.jsonl"
            n += 1
        return path

    @property
    def failure_log(self) -> Path:
        return self.root / "failure_log.jsonl"

    @property
    def session_log(self) -> Path:
        return self.root / "session_log.jsonl"

    def annotator_dir(self, annotator_id: str, mode: str = "standard", context_id: str = "") -> Path:
        validate_mode(mode)
        if mode == "standard":
            return self.root / f"annotator-{annotator_id}"
        if not context_id:
            raise ValueError("Training outputs need a reference set identifier")
        return self.root / "training" / safe_component(context_id) / mode / f"annotator-{annotator_id}"

    def completed_list(self, annotator_id: str) -> Path:
        return self.annotator_dir(annotator_id) / "completed_datasets.txt"

    def recording_dir(
        self, annotator_id: str, recording_id: str, mode: str = "standard", context_id: str = ""
    ) -> Path:
        rel_parent = PurePosixPath(recording_id).parent
        base = self.annotator_dir(annotator_id, mode, context_id)
        for part in rel_parent.parts:
            if part in ("..", "/"):
                raise ValueError(f"Unsafe recording identifier {recording_id!r}")
            base = base / part
        return base


def output_basename(recording_stem: str, annotator_id: str, attempt: int = 1) -> str:
    """E.g. ``sub-001_task-rest_eeg_annotator-A01`` or ``..._annotator-A01_attempt-02``."""
    if attempt < 1:
        raise ValueError("attempt must be >= 1")
    base = f"{recording_stem}_annotator-{annotator_id}"
    return base if attempt == 1 else f"{base}_attempt-{attempt:02d}"


def output_filenames(basename: str) -> dict[str, str]:
    return {key: basename + suffix for key, suffix in OUTPUT_SUFFIXES.items()}


def next_free_attempt(directory: Path, recording_stem: str, annotator_id: str) -> int:
    """Smallest attempt number whose output files do not exist yet."""
    attempt = 1
    while True:
        names = output_filenames(output_basename(recording_stem, annotator_id, attempt))
        if not any((directory / n).exists() for n in names.values()):
            return attempt
        attempt += 1
