"""One annotator working on one recording.

:class:`AnnotationSession` needs no interface. The browser version's server and
Firebase functions create one for each recording an annotator saves (through
:class:`~electrotag.web.saving.WebSession`), and it can equally be driven from
a script or a test. It

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
import os
import platform
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from electrotag import APP_NAME, __version__
from electrotag.app.annotations.labels import LabelCatalogue
from electrotag.app.annotations.model import (
    CONFIDENCE_ANCHORS,
    CONFIDENCE_LEVELS,
    AnnotationDocument,
    ArtifactAnnotation,
)
from electrotag.app.annotations.store import AnnotationStore
from electrotag.app.annotations.timing import TIME_CONVENTIONS
from electrotag.app.common import new_session_id, normalise_annotator_id, now_local_iso, validate_mode
from electrotag.app.eeg.loading import LoadedRecording, changed_since
from electrotag.app.io.atomic import json_bytes
from electrotag.app.io.canonical import annotations_json_bytes, read_annotations_json
from electrotag.app.annotations.labels import needs_review
from electrotag.app.io.export import ExportError, build_events_sidecar, channels_tsv_bytes, events_tsv_bytes
from electrotag.app.io.locking import FileLock, LockError
from electrotag.app.io.naming import ALWAYS_WRITTEN, OutputLayout, next_free_attempt, output_basename, output_filenames
from electrotag.app.session.autosave import AutosaveRecord, autosave_path, delete_autosave, write_autosave
from electrotag.app.session.register import RegisterError
from electrotag.app.session.failures import SessionLog
from electrotag.app.session.register import CompletionRegister
from electrotag.app.session.transaction import CommitResult, ExportCommitError, FaultHook, commit_outputs
from electrotag.app.validation.exports import ValidationError, make_bundle_validator, validate_annotation_document
from electrotag.config.settings import FilterSettings, Settings

SCHEMA_SESSION = "electrotag.session"
SESSION_SCHEMA_VERSION = "1.1.0"  # 1.1.0: annotations.confidence and annotations.n_with_note


class SessionError(RuntimeError):
    pass


def library_versions() -> dict[str, str]:
    versions = {"python": sys.version.split()[0], APP_NAME.lower(): __version__}
    for mod in ("mne", "numpy", "scipy", "pandas", "matplotlib"):
        try:
            module = __import__(mod)
            versions[mod] = str(getattr(module, "__version__", "unknown"))
        except Exception:
            continue
    return versions


def recording_lock_path(layout: OutputLayout, recording_id: str, annotator_id: str, mode: str, context: str) -> Path:
    digest = hashlib.sha1(f"{recording_id}|{mode}|{context}".encode()).hexdigest()[:16]
    return layout.locks / f"recording-{digest}-{annotator_id}.lock"


def recording_lock_owner(
    layout: OutputLayout, recording_id: str, annotator_id: str, mode: str, context: str, stale_after_s: float
) -> dict[str, Any] | None:
    """Who holds the recording lock, if it is held and not stale (checked before loading)."""
    path = recording_lock_path(layout, recording_id, annotator_id, mode, context)
    if not path.exists():
        return None
    lock = FileLock(path, stale_after_s=stale_after_s)
    owner = FileLock.read_owner(path)
    return None if lock.is_stale(owner) else (owner or {"annotator_id": annotator_id})


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
        initial_bad_channels: tuple[str, ...] | list[str] = (),
        allow_repeat: bool = False,
        resume: AutosaveRecord | None = None,
        autosave_enabled: bool = True,
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
        self.resumed_from = resume
        # Set by the interface: amplitude scale, seconds and channels shown at Save and Finish.
        self.display_state: dict[str, Any] = {}
        self.previous_sessions: list[dict[str, Any]] = []
        if resume is not None:
            initial_annotations = list(resume.document.annotations)
            initial_bad_channels = tuple(resume.document.bad_channels)
            self.previous_sessions = list(resume.previous_sessions) + [
                {"session_id": resume.session_id, "autosaved_at": resume.saved_at, "elapsed_s": resume.elapsed_s}
            ]
        self.store = AnnotationStore(
            loaded.info,
            catalogue,
            min_duration_samples=settings.min_duration_samples,
            initial=initial_annotations or (),
            auto_merge=settings.merge_overlapping,
            initial_bad_channels=initial_bad_channels,
        )
        self.autosave_enabled = autosave_enabled
        self.autosave_path = autosave_path(
            layout, loaded.info.recording_id, self.annotator_id, self.mode, self.context_id
        )
        self._autosaved_revision: int | None = None
        self._autosaved_elapsed = 0.0
        self._last_autosave = 0.0
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
        # Time already spent in earlier, unfinished sessions of this recording (from the autosave).
        self.elapsed_before_s = float(resume.elapsed_s) if resume is not None else 0.0
        self._accumulated = self.elapsed_before_s
        self._last_heartbeat = 0.0
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
        try:
            if not self.allow_repeat:
                self._handle_leftover_outputs()
            self.session_log.write(
                "session_started",
                session_id=self.session_id,
                recording_id=self.recording_id,
                annotator_id=self.annotator_id,
                mode=self.mode,
                context=self.context_id,
            )
        except BaseException:
            self.lock.release()
            raise
        self.started_at = now_local_iso()
        self._last_heartbeat = time.monotonic()
        self.state = "open"

    def _handle_leftover_outputs(self) -> None:
        """Deal with output files of this recording and annotator that are not registered as complete.

        Normally there are none. A complete, consistent set means an earlier save
        finished but its register update was lost: the save is registered and the
        session refused (the work is already done). Anything else is an incomplete
        set that would block saving; it is moved to ``.electrotag/interrupted/``
        (never deleted) and a warning is shown.
        """
        final_dir = self.layout.recording_dir(self.annotator_id, self.recording_id, self.mode, self.context_id)
        last = next_free_attempt(final_dir, self.loaded.files.stem, self.annotator_id) - 1
        if last < 1:
            return
        for attempt in range(last, 0, -1):
            basename = output_basename(self.loaded.files.stem, self.annotator_id, attempt)
            entry = self._verified_entry(final_dir, basename)
            if entry is not None:
                try:
                    self.register.add(entry)
                except (RegisterError, OSError) as exc:
                    raise SessionError(
                        f"{self.recording_id} was already saved by {self.annotator_id} ({basename}), but the "
                        f"completion register could not be updated: {exc}"
                    ) from exc
                self.session_log.write(
                    "completion_recovered", recording_id=self.recording_id, annotator_id=self.annotator_id,
                    session_id=entry["session_id"], output_basename=basename,
                )
                raise SessionError(
                    f"{self.recording_id} was already saved by {self.annotator_id} on {entry['completed_at']} "
                    f"({basename}). That save had not been recorded as complete; it is now."
                )
        dest = self.layout.quarantine / f"leftover-{self.session_id}"
        moved = []
        for attempt in range(1, last + 1):
            for name in output_filenames(output_basename(self.loaded.files.stem, self.annotator_id, attempt)).values():
                src = final_dir / name
                if src.exists():
                    dest.mkdir(parents=True, exist_ok=True)
                    try:
                        os.replace(src, dest / name)
                    except OSError as exc:
                        raise SessionError(
                            f"Incomplete earlier output files for {self.recording_id} ({src}) are in the way and "
                            f"could not be moved aside: {exc}. Please tell the study administrator."
                        ) from exc
                    moved.append(name)
        message = (
            f"Incomplete output files from an earlier save were found and moved to {dest}: " + ", ".join(moved)
        )
        self.loaded.warnings.append(message)
        self.session_log.write(
            "leftover_outputs_moved", recording_id=self.recording_id, annotator_id=self.annotator_id,
            destination=str(dest), files=moved,
        )

    def _verified_entry(self, final_dir: Path, basename: str) -> dict[str, Any] | None:
        """Register entry for a complete, self-consistent set of outputs, else None."""
        names = output_filenames(basename)
        paths = {k: final_dir / n for k, n in names.items()}
        if not all(paths[k].is_file() for k in ALWAYS_WRITTEN):
            return None
        try:
            doc = read_annotations_json(paths["annotations_json"])
            meta = json.loads(paths["session_json"].read_text(encoding="utf-8"))
            elapsed = float(paths["time_viewed"].read_text(encoding="utf-8").strip())
            if paths["events_tsv"].stat().st_size == 0:
                return None
            json.loads(paths["events_json"].read_text(encoding="utf-8"))
            if doc.bad_channels and not paths["channels_tsv"].is_file():
                return None
        except Exception:
            return None
        if (
            doc.annotator_id != self.annotator_id
            or doc.recording.recording_id != self.recording_id
            or doc.mode != self.mode
            or meta.get("session_id") != doc.session_id
            or (meta.get("outputs") or {}).get("basename") != basename
        ):
            return None
        return {
            "recording_id": self.recording_id,
            "annotator_id": self.annotator_id,
            "mode": self.mode,
            "context": self.context_id,
            "status": "completed",
            "session_id": doc.session_id,
            "completed_at": (meta.get("timing") or {}).get("finish_timestamp") or doc.created_at,
            "elapsed_s": f"{elapsed:.3f}",
            "n_annotations": str(len(doc.annotations)),
            "n_needs_review": str(sum(1 for a in doc.annotations if needs_review(a.label))),
            "n_bad_channels": str(len(doc.bad_channels)),
            "output_dir": final_dir.relative_to(self.layout.root).as_posix(),
            "output_basename": basename,
            "app_version": (meta.get("application") or {}).get("version", ""),
        }

    def autosave(self, *, force: bool = False, min_interval_s: float = 5.0, max_interval_s: float = 60.0) -> bool:
        """Write the unfinished work to the autosave file when it has changed.

        Changes are saved at most every ``min_interval_s`` seconds; while the
        timer runs, the elapsed time is refreshed at least every
        ``max_interval_s`` seconds. Returns True if a file was written.
        """
        if self.state != "open" or not self.autosave_enabled:
            return False
        now = time.monotonic()
        changed = self.store.revision != self._autosaved_revision
        if not force:
            if changed and now - self._last_autosave < min_interval_s:
                return False
            if not changed and (now - self._last_autosave < max_interval_s
                                or abs(self.elapsed_s - self._autosaved_elapsed) < 1.0):
                return False
            if self._autosaved_revision is None and not len(self.store) and self.elapsed_s < 30:
                return False  # nothing worth keeping yet
        revision, elapsed = self.store.revision, self.elapsed_s
        try:
            write_autosave(
                self.autosave_path, self.build_document(), elapsed_s=elapsed, session_id=self.session_id,
                filters=self.filters.to_dict(), source_fingerprint=self.loaded.fingerprint,
                previous_sessions=self.previous_sessions,
            )
        except OSError:
            return False  # the next attempt may succeed; autosave never interrupts the annotator
        self._autosaved_revision, self._autosaved_elapsed, self._last_autosave = revision, elapsed, now
        return True

    def discard_autosave(self) -> None:
        delete_autosave(self.autosave_path)

    def heartbeat(self, interval_s: float = 60.0) -> bool:
        """Refresh the recording lock (call regularly while the session is open).

        Returns False if the lock has been lost, for example because another
        computer judged it stale while this one was asleep.
        """
        if self.state != "open":
            return True
        now = time.monotonic()
        if now - self._last_heartbeat < interval_s:
            return True
        self._last_heartbeat = now
        return self.lock.refresh()

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

    def abandon(self, reason: str = "viewer closed without Save and Finish", *, keep_autosave: bool = False) -> None:
        """End the session without saving (the recording stays incomplete).

        With ``keep_autosave`` the unfinished work is saved for later (and
        offered again next time); otherwise it is discarded.
        """
        if self.state in ("finished", "abandoned"):
            return
        worth_keeping = len(self.store) > 0 or self.resumed_from is not None or self.elapsed_s >= 30
        keep_autosave = keep_autosave and worth_keeping
        if keep_autosave:
            self.autosave(force=True)
        elapsed = self.stop_timer()
        self.state = "abandoned"
        if not keep_autosave:
            self.discard_autosave()
        self.session_log.write(
            "session_incomplete",
            session_id=self.session_id,
            recording_id=self.recording_id,
            annotator_id=self.annotator_id,
            mode=self.mode,
            reason=reason,
            elapsed_s=round(elapsed, 3),
            n_annotations_discarded=0 if keep_autosave else len(self.store),
            kept_for_later=keep_autosave,
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
            confidence_mode=self.settings.confidence,
            bad_channels=tuple(self.store.bad_channels),
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
                "format": lr.files.format_name,
                "file": lr.files.path.name,
                "vhdr": lr.files.vhdr.name if lr.files.vhdr else None,
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
                "hidden_channels": list(lr.info.hidden_channels),
                "trigger_channels": list(lr.trigger_channels),
                "acquisition_gaps_samples": [list(g) for g in lr.acquisition_gaps],
                "source_fingerprint": lr.fingerprint,
            },
            "timing": {
                "session_opened": self.started_at,
                "start_timestamp": self.timer_started_at,
                "finish_timestamp": self.finished_at,
                "elapsed_seconds": elapsed,
                "clock": "time.monotonic (started when the viewer became usable, stopped at Save and Finish)",
                "elapsed_in_earlier_sessions_seconds": self.elapsed_before_s,
                "resumed_from_autosave": self.previous_sessions,
            },
            "application": self.application_info(),
            "display": {
                "scalings": {**self.settings.display.scalings, **lr.display_scalings},
                "amplitude_check": lr.amplitude_report.to_dict(),
                **self.display_state,
                "note": "scale_factor multiplies the amplitude of every trace relative to scalings "
                "(MNE's + and - keys); duration_s and n_channels are what was on screen at Save and Finish",
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
                "confidence": confidence_summary(doc),
                "n_with_note": sum(1 for a in doc.annotations if a.note),
            },
            "bad_channels": {
                "marked_by_annotator": list(doc.bad_channels),
                "n_marked_by_annotator": len(doc.bad_channels),
                "in_study_channels_tsv": [c for c in getattr(lr, "study_bad_channels", ()) if c in lr.info.ch_names],
                "note": "marked_by_annotator: the annotator's judgement for the whole recording (also in the "
                "annotations file and, when not empty, in the _channels.tsv beside it); in_study_channels_tsv: the "
                "dataset's own bad channels, input that the annotator saw greyed out.",
            },
            "label_catalogue": self.catalogue.to_metadata(),
            "original_events": {
                "source": lr.original_events.source,
                "trigger_channels_read": list(lr.original_events.stim_channels),
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

    def application_info(self) -> dict[str, Any]:
        """The ``application`` block of the session file (the web server describes itself differently)."""
        return {
            "name": APP_NAME,
            "version": __version__,
            "platform": platform.platform(),
            "libraries": library_versions(),
        }

    def source_changes(self) -> list[str]:
        """Roles of source files that changed since the recording was opened (none may change while annotating).

        The web server has no source files; it checks the browser's fingerprint instead."""
        return changed_since(self.loaded.files, self.loaded.fingerprint)

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
            if not self.lock.owns():
                # The lock was judged stale (e.g. after a long sleep): take it again if nobody else has.
                try:
                    self.lock.acquire(timeout_s=0)
                except LockError as exc:
                    raise SessionError(
                        f"{self.recording_id} has been opened by another session in the meantime ({exc}). "
                        "Your annotations were not saved; please tell the study administrator."
                    ) from exc
            changed = self.source_changes()
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
            names = {k: v for k, v in output_filenames(basename).items()
                     if k in ALWAYS_WRITTEN or (k == "channels_tsv" and doc.bad_channels)}
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
            if "channels_tsv" in names:
                files["channels_tsv"] = (names["channels_tsv"],
                                         channels_tsv_bytes(doc, getattr(self.loaded, "channel_types", None)))
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
                "n_needs_review": str(sum(1 for a in doc.annotations if needs_review(a.label))),
                "n_bad_channels": str(len(doc.bad_channels)),
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
                self.discard_autosave()
            else:
                self.resume_timer()
                self.session_log.write(
                    "export_failed", session_id=self.session_id, recording_id=self.recording_id, error=str(exc)
                )
            raise
        except (SessionError, ValidationError, ExportError, OSError, ValueError, RuntimeError) as exc:
            self.resume_timer()
            self.session_log.write(
                "export_failed", session_id=self.session_id, recording_id=self.recording_id, error=str(exc)
            )
            raise
        self._close("finished", elapsed)
        self.discard_autosave()
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


def confidence_summary(doc: AnnotationDocument) -> dict[str, Any]:
    """The ``annotations.confidence`` block of the session file: the study's setting and how many marks had
    each rating of the 5-point scale."""
    by_level = {str(lv): sum(1 for a in doc.annotations if a.confidence == lv) for lv in CONFIDENCE_LEVELS}
    return {
        "setting": doc.confidence_mode or "optional",
        "scale": {str(k): v for k, v in CONFIDENCE_ANCHORS.items()},
        "meaning": "optional: annotators rated a mark (1 to 5) only when they wished; every_mark: annotators were "
                   "asked to rate each new mark, which started without a rating.",
        "n_given": sum(by_level.values()),
        "n_not_given": sum(1 for a in doc.annotations if a.confidence is None),
        "by_level": by_level,
    }


def _rel(path: Path | None, root: Path) -> str | None:
    if path is None:
        return None
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return str(path)
