"""One annotator working on one recording.

:class:`AnnotationSession` is GUI-independent. The desktop application creates
one per recording, but it can equally be driven from a script or a test. It

* holds a lock so that the same annotator cannot open the same recording twice
  at the same time (for example on two computers sharing a network drive);
* measures annotation time with a monotonic clock, from the moment the viewer
  becomes usable until Save and Finish;
* builds, validates and safely commits all output files, and only then marks
  the recording complete for this annotator.
"""

from __future__ import annotations

import hashlib
import json
import platform
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from electroclean import APP_NAME, __version__
from electroclean.app.annotations.labels import LabelCatalogue
from electroclean.app.annotations.model import AnnotationDocument, ArtifactAnnotation
from electroclean.app.annotations.store import AnnotationStore
from electroclean.app.annotations.timing import TIME_CONVENTIONS
from electroclean.app.common import new_session_id, normalise_annotator_id, now_local_iso, validate_mode
from electroclean.app.eeg.loading import LoadedRecording, changed_since
from electroclean.app.io.atomic import json_bytes
from electroclean.app.io.canonical import annotations_json_bytes
from electroclean.app.io.export import build_events_sidecar, events_tsv_bytes
from electroclean.app.io.locking import FileLock
from electroclean.app.io.naming import OutputLayout, next_free_attempt, output_basename, output_filenames
from electroclean.app.session.failures import SessionLog
from electroclean.app.session.register import CompletionRegister
from electroclean.app.session.transaction import CommitResult, ExportCommitError, FaultHook, commit_outputs
from electroclean.app.validation.exports import ValidationError, make_bundle_validator, validate_annotation_document
from electroclean.config.settings import FilterSettings, Settings

SCHEMA_SESSION = "electroclean.session"
SESSION_SCHEMA_VERSION = "1.0.0"


class SessionError(RuntimeError):
    pass


def library_versions() -> dict[str, str]:
    versions = {"python": sys.version.split()[0], APP_NAME.lower(): __version__}
    for mod in ("mne", "mne_qt_browser", "numpy", "scipy", "pandas", "PySide6", "pyqtgraph", "matplotlib"):
        try:
            module = __import__(mod)
            versions[mod] = str(getattr(module, "__version__", "unknown"))
        except Exception:
            continue
    return versions


def recording_lock_path(layout: OutputLayout, recording_id: str, annotator_id: str, mode: str, context: str) -> Path:
    digest = hashlib.sha1(f"{recording_id}|{mode}|{context}".encode()).hexdigest()[:16]
    return layout.locks / f"recording-{digest}-{annotator_id}.lock"


@dataclass
class FinishResult:
    commit: CommitResult
    elapsed_s: float
    n_annotations: int
    output_basename: str
    session_json: dict[str, Any] = field(default_factory=dict)


class AnnotationSession:
    """Annotation of one recording by one annotator."""

    def __init__(
        self,
        *,
        layout: OutputLayout,
        settings: Settings,
        filters: FilterSettings,
        catalogue: LabelCatalogue,
        loaded: LoadedRecording,
        annotator_id: str,
        display_name: str = "",
        mode: str = "standard",
        context: dict[str, Any] | None = None,
        initial_annotations: list[ArtifactAnnotation] | None = None,
        allow_repeat: bool = False,
    ) -> None:
        self.layout = layout
        self.settings = settings
        self.filters = filters
        self.catalogue = catalogue
        self.loaded = loaded
        self.annotator_id = normalise_annotator_id(annotator_id)
        self.display_name = display_name.strip()
        self.mode = validate_mode(mode)
        self.context = dict(context or {})
        self.context_id = str(self.context.get("reference_set_id", ""))
        if self.mode != "standard" and not self.context_id:
            raise SessionError("Practice and assessment sessions need a reference set")
        self.allow_repeat = allow_repeat
        self.session_id = new_session_id()
        self.register = CompletionRegister(layout, settings.register_lock_timeout_s)
        self.session_log = SessionLog(layout)
        self.store = AnnotationStore(
            loaded.info,
            catalogue,
            min_duration_samples=settings.min_duration_samples,
            initial=initial_annotations or (),
        )
        self.lock = FileLock(
            recording_lock_path(layout, loaded.info.recording_id, self.annotator_id, self.mode, self.context_id),
            {
                "annotator_id": self.annotator_id,
                "recording_id": loaded.info.recording_id,
                "session_id": self.session_id,
            },
            stale_after_s=settings.recording_lock_stale_hours * 3600,
        )
        self.started_at: str | None = None
        self.timer_started_at: str | None = None
        self.finished_at: str | None = None
        self._t0: float | None = None
        self._accumulated = 0.0
        self.state = "created"
        self.events: list[dict[str, Any]] = []

    # ------------------------------------------------------------- lifecycle
    @property
    def recording_id(self) -> str:
        return self.loaded.info.recording_id

    def start(self) -> None:
        """Acquire the recording lock and log the start of the session."""
        if self.register.is_completed(self.recording_id, self.annotator_id, self.mode, self.context_id) and not self.allow_repeat:
            raise SessionError(
                f"{self.recording_id} has already been completed by {self.annotator_id}. "
                "It will not be annotated again unless an administrator allows a repeat."
            )
        self.lock.acquire(timeout_s=0)
        self.started_at = now_local_iso()
        self.state = "open"
        self.session_log.write(
            "session_started",
            session_id=self.session_id,
            recording_id=self.recording_id,
            annotator_id=self.annotator_id,
            mode=self.mode,
            context=self.context_id,
        )

    def start_timer(self) -> None:
        """Call when the EEG viewer becomes available for use."""
        if self._t0 is None:
            self._t0 = time.monotonic()
            if self.timer_started_at is None:
                self.timer_started_at = now_local_iso()

    def stop_timer(self) -> float:
        if self._t0 is not None:
            self._accumulated += time.monotonic() - self._t0
            self._t0 = None
        return self._accumulated

    def resume_timer(self) -> None:
        self.start_timer()

    @property
    def elapsed_s(self) -> float:
        running = (time.monotonic() - self._t0) if self._t0 is not None else 0.0
        return self._accumulated + running

    def abandon(self, reason: str = "viewer closed without Save and Finish") -> None:
        """End the session without saving (the recording stays incomplete)."""
        if self.state in ("finished", "abandoned"):
            return
        elapsed = self.stop_timer()
        self.state = "abandoned"
        self.session_log.write(
            "session_incomplete",
            session_id=self.session_id,
            recording_id=self.recording_id,
            annotator_id=self.annotator_id,
            mode=self.mode,
            reason=reason,
            elapsed_s=round(elapsed, 3),
            n_annotations_discarded=len(self.store),
        )
        self.lock.release()

    # --------------------------------------------------------------- outputs
    def build_document(self) -> AnnotationDocument:
        return AnnotationDocument(
            recording=self.loaded.info,
            annotator_id=self.annotator_id,
            annotator_display_name=self.display_name,
            annotations=list(self.store.annotations()),
            catalogue=self.catalogue,
            session_id=self.session_id,
            mode=self.mode,
            created_at=self.finished_at or now_local_iso(),
            app_version=__version__,
            context=self.context,
        )

    def build_session_metadata(self, doc: AnnotationDocument, elapsed: float, basename: str, names: dict[str, str]) -> dict[str, Any]:
        lr = self.loaded
        counts = doc.counts_by_label()
        return {
            "schema": SCHEMA_SESSION,
            "schema_version": SESSION_SCHEMA_VERSION,
            "session_id": self.session_id,
            "mode": self.mode,
            "context": self.context,
            "annotator": {"annotator_id": self.annotator_id, "display_name": self.display_name},
            "recording": {
                "recording_id": lr.info.recording_id,
                "vhdr": lr.files.vhdr.name,
                "eeg": lr.files.eeg.name if lr.files.eeg else None,
                "vmrk": lr.files.vmrk.name if lr.files.vmrk else None,
                "bids_sidecars": {
                    "channels_tsv": _rel(lr.files.channels_tsv, lr.files.root),
                    "events_tsv": _rel(lr.files.events_tsv, lr.files.root),
                    "events_json": [_rel(p, lr.files.root) for p in lr.files.sidecars.events_json_chain],
                    "eeg_json": [_rel(p, lr.files.root) for p in lr.files.sidecars.eeg_json_chain],
                },
                **lr.info.timing.to_dict(),
                "n_channels": len(lr.info.ch_names),
                "ch_names": list(lr.info.ch_names),
                "source_fingerprint": lr.fingerprint,
            },
            "timing": {
                "session_opened": self.started_at,
                "start_timestamp": self.timer_started_at,
                "finish_timestamp": self.finished_at,
                "elapsed_seconds": elapsed,
                "clock": "time.monotonic (started when the viewer became usable, stopped at Save and Finish)",
            },
            "application": {
                "name": APP_NAME,
                "version": __version__,
                "platform": platform.platform(),
                "libraries": library_versions(),
            },
            "filters": {
                "selected": self.filters.to_dict(),
                "summary": self.filters.describe(),
                "fixed_by_administrator": self.filters.locked,
                "design": lr.filter_report.to_dict(),
            },
            "annotations": {
                "n_annotations": len(doc.annotations),
                "n_whole_montage": sum(1 for a in doc.annotations if a.is_global),
                "n_channel_specific": sum(1 for a in doc.annotations if not a.is_global),
                "by_label": {k: v for k, v in counts.items() if v},
                "time_conventions": TIME_CONVENTIONS,
            },
            "label_catalogue": self.catalogue.to_metadata(),
            "original_events": {
                "source": lr.original_events.source,
                "n_events": len(lr.original_events),
                "sample_column_computed": lr.original_events.sample_computed,
                "comparison_with_markers": lr.original_events.comparison,
                "code_check": lr.event_report.to_dict(),
            },
            "channel_check": lr.channel_report.to_dict(),
            "warnings": list(lr.warnings),
            "notes": list(lr.notes),
            "outputs": {"basename": basename, "files": names},
        }

    def finish(self, *, fault: FaultHook | None = None) -> FinishResult:
        """Save and Finish: validate, write, verify, then mark complete.

        On failure the session stays open (and the timer keeps running), so
        the annotator can try again or keep working; the recording is not
        marked complete.
        """
        if self.state != "open":
            raise SessionError(f"Session is not open (state: {self.state})")
        elapsed = round(self.stop_timer(), 3)
        self.finished_at = now_local_iso()
        try:
            changed = changed_since(self.loaded.files, self.loaded.fingerprint)
            if changed:
                raise SessionError(
                    "The source recording files changed while you were annotating ("
                    + ", ".join(changed)
                    + "). Outputs were not written; please tell the study administrator."
                )
            doc = self.build_document()
            validate_annotation_document(doc, self.settings.min_duration_samples)
            final_dir = self.layout.recording_dir(self.annotator_id, self.recording_id, self.mode, self.context_id)
            attempt = next_free_attempt(final_dir, self.loaded.files.stem, self.annotator_id)
            if attempt > 1 and not self.allow_repeat:
                raise SessionError(
                    f"Output files for {self.recording_id} by {self.annotator_id} already exist in {final_dir}. "
                    "They will not be overwritten."
                )
            basename = output_basename(self.loaded.files.stem, self.annotator_id, attempt)
            names = output_filenames(basename)
            sidecar, _notes = build_events_sidecar(
                self.loaded.events_sidecar, self.loaded.original_events, doc, self.loaded.event_report.to_dict()
            )
            session_meta = self.build_session_metadata(doc, elapsed, basename, names)
            files = {
                "events_tsv": (names["events_tsv"], events_tsv_bytes(self.loaded.original_events, doc)),
                "events_json": (names["events_json"], json_bytes(sidecar)),
                "annotations_json": (names["annotations_json"], annotations_json_bytes(doc)),
                "time_viewed": (names["time_viewed"], f"{elapsed:.3f}\n".encode("utf-8")),
                "session_json": (names["session_json"], json_bytes(session_meta)),
            }
            validator = make_bundle_validator(self.loaded.original_events, doc, elapsed)
            entry = {
                "recording_id": self.recording_id,
                "annotator_id": self.annotator_id,
                "mode": self.mode,
                "context": self.context_id,
                "status": "completed",
                "session_id": self.session_id,
                "completed_at": self.finished_at,
                "elapsed_s": f"{elapsed:.3f}",
                "n_annotations": str(len(doc.annotations)),
                "output_dir": final_dir.relative_to(self.layout.root).as_posix(),
                "output_basename": basename,
                "app_version": __version__,
            }
            result = commit_outputs(
                self.layout, self.session_id, final_dir, files, validator, self.register, entry, fault=fault
            )
        except ExportCommitError as exc:
            if exc.committed:
                self._close("finished_register_pending", elapsed)
            else:
                self.resume_timer()
                self.session_log.write(
                    "export_failed", session_id=self.session_id, recording_id=self.recording_id, error=str(exc)
                )
            raise
        except (SessionError, ValidationError, OSError, ValueError) as exc:
            self.resume_timer()
            self.session_log.write(
                "export_failed", session_id=self.session_id, recording_id=self.recording_id, error=str(exc)
            )
            raise
        self._close("finished", elapsed)
        return FinishResult(
            commit=result,
            elapsed_s=elapsed,
            n_annotations=len(doc.annotations),
            output_basename=basename,
            session_json=json.loads(json_bytes(session_meta)),
        )

    def _close(self, state: str, elapsed: float) -> None:
        self.state = "finished"
        self.session_log.write(
            "session_completed" if state == "finished" else "session_saved_register_pending",
            session_id=self.session_id,
            recording_id=self.recording_id,
            annotator_id=self.annotator_id,
            mode=self.mode,
            elapsed_s=elapsed,
            n_annotations=len(self.store),
        )
        self.lock.release()


def _rel(path: Path | None, root: Path) -> str | None:
    if path is None:
        return None
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return str(path)
