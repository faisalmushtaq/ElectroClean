"""Workflow of the desktop application.

``AppController`` takes the request from the start window and runs the loop

    recover interrupted saves → find recordings → pick the next one →
    viewing options → load (in the background) → annotate → Save and Finish →
    continue or quit

handling failures at every step without crashing and without ever marking a
recording complete unless its outputs were written and verified.
"""

from __future__ import annotations

import os
import traceback
import uuid
from pathlib import Path
from typing import Any

from qtpy.QtCore import QObject, Qt, QTimer
from qtpy.QtWidgets import QApplication, QMessageBox, QProgressDialog, QWidget

from electroclean.app.annotations.labels import default_catalogue
from electroclean.app.common import friendly_time
from electroclean.app.eeg.loading import LoadedRecording, RecordingLoadError
from electroclean.app.gui.dialogs import UserPrompts
from electroclean.app.gui.filter_dialog import FilterDialog
from electroclean.app.gui.start_window import StartRequest, StartWindow
from electroclean.app.gui.workers import LoadWorker
from electroclean.app.io.discovery import RecordingFiles, discover_recordings
from electroclean.app.io.locking import LockError
from electroclean.app.io.naming import OutputLayout
from electroclean.app.session.failures import FailureLog, SessionLog
from electroclean.app.session.register import CompletionRegister, RegisterError
from electroclean.app.session.selection import select_next
from electroclean.app.session.session import AnnotationSession, SessionError, recording_lock_owner
from electroclean.app.session.transaction import recover_interrupted_exports
from electroclean.config.settings import FilterSettings, Settings, SettingsError, StudyConfig, load_settings

FAILED_TO_LOAD = "Failed to load file. Would you like to continue with another recording or quit?"


class LoadingDialog(QProgressDialog):
    """Progress shown while a recording opens. It cannot be cancelled or closed by the user,
    because the background loader cannot be interrupted safely."""

    def __init__(self, text: str, parent: QWidget | None) -> None:
        super().__init__(text, "", 0, 0, parent)
        self._may_close = False
        self.setWindowTitle("ElectroClean")
        self.setCancelButton(None)
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowCloseButtonHint)
        self.setWindowModality(Qt.ApplicationModal)
        self.setMinimumDuration(0)
        self.setAutoClose(False)
        self.setAutoReset(False)

    def reject(self) -> None:  # Esc
        pass

    def closeEvent(self, event) -> None:  # noqa: ANN001, N802 - Qt API
        if self._may_close:
            super().closeEvent(event)
        else:
            event.ignore()

    def finish(self) -> None:
        self._may_close = True
        self.close()


class AppController(QObject):
    def __init__(self, *, prompts: UserPrompts | None = None, synchronous_loading: bool = False) -> None:
        super().__init__()
        self.prompts = prompts or UserPrompts()
        self.synchronous_loading = synchronous_loading  # used by tests
        self.catalogue = default_catalogue()
        self.start_window = StartWindow()
        self.start_window.prompts = self.prompts  # its error messages use the same (possibly scripted) prompts
        self.start_window.beginRequested.connect(self.begin)
        self.start_window.adminRequested.connect(self.open_admin)
        self.start_window.agreementRequested.connect(self.open_agreement)
        self.start_window.closedByUser.connect(self._on_start_window_closed)
        self.request: StartRequest | None = None
        self.settings: Settings | None = None
        self.study: StudyConfig | None = None
        self.layout: OutputLayout | None = None
        self.recordings: list[RecordingFiles] = []
        self.session_excluded: set[str] = set()
        self.filters: FilterSettings | None = None
        self.remember_filters = False
        self.reference_set: Any = None
        self.workspace: Any = None
        self.session: AnnotationSession | None = None
        self.loaded: LoadedRecording | None = None
        self.worker: LoadWorker | None = None
        self.progress: QProgressDialog | None = None
        self.review_workspace: Any = None
        self.quiz_window: Any = None
        self.admin_dialog: Any = None
        self._resume_choice: Any = None  # autosave the annotator chose to continue
        self._declined_resume: set[str] = set()
        self.history: list[dict[str, Any]] = []  # what happened (used by tests and the demo)

    # ------------------------------------------------------------- helpers
    @property
    def parent_widget(self) -> QWidget:
        return self.start_window

    def _context_id(self) -> str:
        return self.request.reference_set_id if self.request and self.request.mode != "standard" else ""

    def _back_to_start(self) -> None:
        self.start_window.refresh()
        self.start_window.show()
        self.start_window.raise_()

    # --------------------------------------------------------------- begin
    def begin(self, request: StartRequest) -> bool:
        """Start a sequence of annotation sessions. Returns False if it could not start."""
        self.request = request
        self._view_state: dict[str, float] = {}  # amplitude scale etc., carried from one recording to the next
        overrides: dict[str, Any] = {}
        if request.output_root is not None:
            overrides["output"] = {"directory": str(request.output_root)}
        try:
            self.settings, self.study = load_settings(request.dataset_root, overrides)
        except (SettingsError, OSError) as exc:
            self.prompts.error(self.parent_widget, "Study configuration problem", str(exc))
            return False
        s = self.settings
        out = Path(s.output_directory) if s.output_directory else request.dataset_root / s.output_directory_name
        if not out.is_absolute():
            out = request.dataset_root / out
        self.layout = OutputLayout(out)
        problem = self._check_writable(out)
        if problem:
            self.prompts.error(
                self.parent_widget,
                "Cannot write results",
                f"ElectroClean cannot save results in {out}.\n\n{problem}\n\n"
                "Choose another results folder, or ask for write permission.",
            )
            return False
        register = CompletionRegister(self.layout, s.register_lock_timeout_s)
        try:
            actions = recover_interrupted_exports(self.layout, register, SessionLog(self.layout))
        except Exception as exc:
            actions = []
            self.prompts.error(self.parent_widget, "Recovery problem", f"Interrupted saves could not be checked: {exc}")
        relevant = [a for a in actions if a.action in ("rolled_forward", "rolled_back")]
        if relevant:
            self.prompts.inform(
                self.parent_widget,
                "Interrupted saves found",
                "ElectroClean found saves that were interrupted last time:\n\n" + "\n\n".join(a.message for a in relevant),
            )
        try:
            self.recordings = discover_recordings(
                request.dataset_root,
                suffixes=s.discovery_suffixes,
                exclude_dir_names=tuple(s.discovery_exclude_dir_names),
                exclude_paths=(out,),
                follow_symlinks=s.discovery_follow_symlinks,
            )
        except (OSError, ValueError) as exc:
            self.prompts.error(self.parent_widget, "Cannot read the dataset folder", str(exc))
            return False
        self.session_excluded = set()
        self._declined_resume = set()
        self._resume_choice = None
        self.filters = None
        self.remember_filters = False
        self.reference_set = None
        if request.mode != "standard":
            try:
                from electroclean.training.reference import load_reference_set_by_id

                self.reference_set = load_reference_set_by_id(request.dataset_root, self.study, request.reference_set_id)
            except Exception as exc:
                self.prompts.error(self.parent_widget, "Reference set unavailable", str(exc))
                return False
            assigned = [a.upper() for a in self.reference_set.assigned_annotators]
            if assigned and request.annotator_id not in assigned:
                self.prompts.error(
                    self.parent_widget,
                    "Not assigned",
                    f"Annotator {request.annotator_id} is not assigned to reference set "
                    f"{self.reference_set.set_id}. Please check with the study administrator.",
                )
                self.reference_set = None
                return False
            if request.mode in ("assessment", "practice") and request.assessment_kind == "quiz":
                return self.start_quiz()
        self.start_window.hide()
        self.next_recording()
        return True

    @staticmethod
    def _check_writable(out: Path) -> str:
        try:
            out.mkdir(parents=True, exist_ok=True)
            probe = out / f".write-test-{uuid.uuid4().hex[:8]}"
            probe.write_bytes(b"ok")
            probe.unlink()
        except OSError as exc:
            return str(exc)
        return ""

    # ---------------------------------------------------------- selection
    def _restrict_to(self) -> list[str] | None:
        if self.reference_set is None or self.request is None:
            return None
        if self.request.mode == "practice":
            return list(self.reference_set.practice_recordings)
        return list(self.reference_set.assessment_recordings)

    def next_recording(self) -> None:
        """Offer the next recording.

        Re-entrant calls (a failed load that continues with another recording)
        are turned into a loop, so many failures in a row cannot exhaust the stack.
        """
        if getattr(self, "_in_next", False):
            self._next_again = True
            return
        self._in_next = True
        try:
            while True:
                self._next_again = False
                self._next_recording_once()
                if not self._next_again:
                    break
        finally:
            self._in_next = False

    def _resumable(
        self, completed: set[str], failed: set[str], restrict: list[str] | None
    ) -> tuple[Any, RecordingFiles] | None:
        """The most recent unfinished (autosaved) recording this annotator could continue now."""
        assert self.request is not None and self.layout is not None
        from electroclean.app.session.autosave import autosaves_for, delete_autosave

        by_id = {r.recording_id: r for r in self.recordings}
        for record in autosaves_for(self.layout, self.request.annotator_id, self.request.mode, self._context_id()):
            rid = record.recording_id
            if rid in completed:
                delete_autosave(record.path)  # saved after all (e.g. finished on another computer)
                continue
            if (rid in by_id and rid not in failed and rid not in self.session_excluded
                    and rid not in self._declined_resume and (restrict is None or rid in restrict)):
                return record, by_id[rid]
        return None

    def _assessment_all_done(self) -> bool:
        assert self.request is not None and self.layout is not None and self.settings is not None
        required = set(self._restrict_to() or ())
        try:
            done = CompletionRegister(self.layout, self.settings.register_lock_timeout_s).completed(
                self.request.annotator_id, "assessment", self._context_id()
            )
        except RegisterError:
            return False
        return bool(required) and required <= done

    def _next_recording_once(self) -> None:
        assert self.request is not None and self.settings is not None and self.layout is not None
        req, s = self.request, self.settings
        register = CompletionRegister(self.layout, s.register_lock_timeout_s)
        try:
            completed = register.completed(req.annotator_id, req.mode, self._context_id())
        except RegisterError as exc:
            self.prompts.error(self.parent_widget, "Completion register problem", str(exc))
            self._back_to_start()
            return
        failures = FailureLog(self.layout).unresolved(
            self.recordings, {}, annotator_id=req.annotator_id
        )
        restrict = self._restrict_to()
        if req.mode != "standard" and self.reference_set is not None and not restrict:
            kind = "practice" if req.mode == "practice" else "assessment"
            self.prompts.inform(
                self.parent_widget, "No recordings in this reference set",
                f"The reference set \"{self.reference_set.name or self.reference_set.set_id}\" has no {kind} recordings "
                f"yet. Ask the study administrator to add some (Tools, then Administrator tools, then Reference sets).",
            )
            self._back_to_start()
            return
        resumable = self._resumable(completed, set(failures), restrict)
        if resumable is not None:
            record, files = resumable
            if self.prompts.ask(
                self.parent_widget,
                "Continue unfinished work?",
                f"You have unfinished work: {record.describe()}.\n\nContinue with it now?",
                yes="Continue it", no="Not now",
            ):
                self._resume_choice = record
                if not self._choose_filters(files):
                    self._back_to_start()
                    return
                self._load(files)
                return
            self._declined_resume.add(record.recording_id)
        if req.choose_recording:
            files = self._choose_manually(completed, set(failures), restrict)
            if files is None:
                self._back_to_start()
                return
        else:
            result = select_next(
                self.recordings,
                annotator_id=req.annotator_id,
                completed=completed,
                failed=failures,
                strategy=s.selection_strategy if req.mode == "standard" else "manual",
                seed=s.selection_seed,
                manual_assignments=(
                    self.study.manual_assignments if (self.study and req.mode == "standard") else {req.annotator_id: tuple(restrict or ())}
                ),
                session_excluded=self.session_excluded,
                restrict_to=restrict,
            )
            if result.recording is None:
                self.history.append({"event": "no_recording", "message": result.message})
                if req.mode == "assessment" and self.reference_set is not None:
                    if self._assessment_all_done():
                        self._assessment_complete_report()
                    else:
                        left = sorted(set(self._restrict_to() or ()) - completed)
                        if not left:
                            self.prompts.inform(self.parent_widget, "No more recordings", result.message)
                            self._back_to_start()
                            return
                        self.prompts.inform(
                            self.parent_widget, "Assessment not finished",
                            f"{len(left)} assessment recording(s) are still to be completed:\n\n"
                            + "\n".join(left)
                            + "\n\nThey were skipped or could not be opened in this session. Start the assessment "
                            "again to complete them; the competency report is produced once all are done.",
                        )
                else:
                    self.prompts.inform(self.parent_widget, "No more recordings", result.message)
                self._back_to_start()
                return
            files = result.recording
        if not self._choose_filters(files):
            self._back_to_start()
            return
        self._load(files)

    def _choose_manually(self, completed: set[str], failed: set[str], restrict: list[str] | None) -> RecordingFiles | None:
        candidates = [
            r for r in self.recordings
            if r.recording_id not in completed and r.recording_id not in failed and r.recording_id not in self.session_excluded
            and (restrict is None or r.recording_id in restrict)
        ]
        if not candidates:
            self.prompts.inform(self.parent_widget, "No more recordings", "All eligible recordings have been completed.")
            return None
        rid = self.prompts.choose_from_list(
            self.parent_widget, "Choose a recording", [r.recording_id for r in candidates]
        )
        if rid is None:
            return None
        return next(r for r in candidates if r.recording_id == rid)

    def _choose_filters(self, files: RecordingFiles) -> bool:
        assert self.settings is not None
        base = self.settings.filters
        if self.filters is not None and (self.remember_filters or base.locked):
            return True
        current = self.filters or base
        if self.synchronous_loading:  # tests: accept defaults without a dialog
            self.filters = current
            return True
        dlg = FilterDialog(self.parent_widget, current, files.recording_id)
        if dlg.exec() != FilterDialog.Accepted:
            return False
        self.filters = dlg.settings()
        self.remember_filters = dlg.remember.isChecked()
        return True

    # ------------------------------------------------------------- loading
    def _load(self, files: RecordingFiles) -> None:
        assert self.settings is not None and self.filters is not None
        assert self.layout is not None and self.request is not None
        # A recording open in another session is skipped before spending time on loading it.
        owner = recording_lock_owner(
            self.layout, files.recording_id, self.request.annotator_id, self.request.mode, self._context_id(),
            self.settings.recording_lock_stale_hours * 3600,
        )
        if owner is not None:
            self.session_excluded.add(files.recording_id)
            self.history.append({"event": "session_blocked", "recording_id": files.recording_id})
            go_on = self.prompts.ask(
                self.parent_widget,
                "Recording unavailable",
                f"{files.recording_id} is open in another session on computer {owner.get('host', '?')} "
                f"(opened {friendly_time(owner.get('created_utc'))}). It cannot be opened twice at the same time."
                "\n\nContinue with another recording?",
                yes="Continue",
                no="Stop",
            )
            if go_on:
                self.next_recording()
            else:
                self._back_to_start()
            return
        self.history.append({"event": "loading", "recording_id": files.recording_id})
        cache = os.environ.get("ELECTROCLEAN_CACHE")  # optional folder for large memory-mapped copies
        worker = LoadWorker(files, self.settings, self.filters, self.catalogue, Path(cache) if cache else None)
        self.worker = worker
        if self.synchronous_loading:
            worker.run()
            if worker.error is not None:
                self._on_load_failed(files, worker.error, "")
            else:
                self._on_loaded(worker.result)
            return
        self.progress = LoadingDialog(f"Opening {files.recording_id}…", self.start_window)
        self.progress.show()
        worker.progress.connect(lambda msg: self.progress and self.progress.setLabelText(f"{files.recording_id}\n{msg}…"))
        worker.succeeded.connect(self._on_loaded, Qt.QueuedConnection)
        worker.failed.connect(lambda exc, tb: self._on_load_failed(files, exc, tb), Qt.QueuedConnection)
        worker.start()

    def _close_progress(self) -> None:
        if self.progress is not None:
            self.progress.finish()
            self.progress.deleteLater()
            self.progress = None

    def _on_load_failed(self, files: RecordingFiles, exc: BaseException, tb: str) -> None:
        self._close_progress()
        assert self.layout is not None and self.request is not None and self.settings is not None
        kind = "memory" if isinstance(exc, MemoryError) else getattr(exc, "kind", "unexpected_error")
        message = str(exc)
        conditions: dict[str, Any] = {}
        try:
            FailureLog(self.layout).record(
                files, files.recording_id, kind, message, annotator_id=self.request.annotator_id,
                details=tb if not isinstance(exc, RecordingLoadError) else "", conditions=conditions,
            )
        except OSError:
            pass
        self.session_excluded.add(files.recording_id)
        self.history.append({"event": "load_failed", "recording_id": files.recording_id, "kind": kind})
        reason = message.strip().split("\n")[0]
        if len(reason) > 300:
            reason = reason[:297].rstrip() + "..."
        go_on = self.prompts.ask(
            self.parent_widget,
            "Failed to load file",
            FAILED_TO_LOAD,
            informative=(
                f"Recording: {files.recording_id}\nReason: {reason}\n\nThis has been recorded in failed_load.txt "
                "in the results folder for the study administrator, and the recording will not be offered again "
                "until the problem is fixed."
            ),
            details=f"Recording: {files.recording_id}\n\n{message}",
            yes="Continue with another recording",
            no="Quit",
            icon=QMessageBox.Warning,
        )
        if go_on:
            self.next_recording()
        else:
            self.quit()

    def _resume_for(self, loaded: LoadedRecording) -> Any:
        """The autosave to restore onto ``loaded``, after checking it still fits (or None)."""
        assert self.request is not None and self.layout is not None
        from electroclean.app.session.autosave import find_autosave, set_aside

        chosen, self._resume_choice = self._resume_choice, None
        rid = loaded.info.recording_id
        record = chosen if chosen is not None and chosen.recording_id == rid else find_autosave(
            self.layout, rid, self.request.annotator_id, self.request.mode, self._context_id()
        )
        if record is None:
            return None
        problems = record.problems_with(loaded)
        if problems:
            where = set_aside(self.layout, record.path, "recording-changed")
            self.prompts.inform(
                self.parent_widget, "Unfinished work not restored",
                f"Your unfinished work on {rid} could not be restored because {', and '.join(problems)}. "
                f"It was kept in {where} for the study administrator.",
            )
            return None
        if record is not chosen and not self.prompts.ask(
            self.parent_widget, "Restore unfinished work?",
            f"{record.describe()}.\n\nRestore it and continue?",
            yes="Restore and continue", no="Start afresh",
        ):
            set_aside(self.layout, record.path, "not-restored")
            return None
        self.history.append({"event": "resumed", "recording_id": rid, "n_annotations": record.n_annotations})
        return record

    def _on_loaded(self, loaded: LoadedRecording) -> None:
        self._close_progress()
        assert self.request is not None and self.settings is not None and self.layout is not None
        req = self.request
        context: dict[str, Any] = {}
        if self.reference_set is not None:
            context = {"reference_set_id": self.reference_set.set_id, "reference_set_name": self.reference_set.name}
        resume = self._resume_for(loaded)
        try:
            session = AnnotationSession(
                layout=self.layout,
                settings=self.settings,
                filters=self.filters or self.settings.filters,
                catalogue=self.catalogue,
                loaded=loaded,
                annotator_id=req.annotator_id,
                display_name=req.display_name,
                mode=req.mode,
                context=context,
                resume=resume,
            )
            session.start()
        except (LockError, SessionError, RegisterError, OSError) as exc:
            loaded.close()
            self.session_excluded.add(loaded.info.recording_id)
            self.history.append({"event": "session_blocked", "recording_id": loaded.info.recording_id})
            go_on = self.prompts.ask(
                self.parent_widget,
                "Recording unavailable",
                f"{loaded.info.recording_id} cannot be opened at the moment:\n\n{exc}\n\n"
                "Continue with another recording?",
                yes="Continue",
                no="Stop",
            )
            if go_on:
                self.next_recording()
            else:
                self._back_to_start()
            return
        self.session = session
        self.loaded = loaded
        from electroclean.app.gui.annotation_window import AnnotationWorkspace

        try:
            ws = AnnotationWorkspace(
                session,
                self.settings,
                prompts=self.prompts,
                title_suffix={"practice": "practice", "assessment": "assessment"}.get(req.mode, ""),
                view_state=getattr(self, "_view_state", None),
            )
        except Exception as exc:
            session.abandon(reason=f"viewer could not be opened: {exc}", keep_autosave=True)
            loaded.close()
            self._on_load_failed(loaded.files, exc, traceback.format_exc())
            return
        self.workspace = ws
        ws.finished.connect(self._on_finished)
        ws.closedWithoutSaving.connect(self._on_closed)
        self.history.append({"event": "opened", "recording_id": loaded.info.recording_id, "session_id": session.session_id})
        ws.show()

    # ------------------------------------------------------------ finishing
    def _remember_view(self) -> None:
        ws = self.workspace
        if ws is not None:
            state = ws.view_state()
            if state:
                self._view_state = state

    def _on_finished(self, result: Any) -> None:
        assert self.request is not None
        session, loaded = self.session, self.loaded
        self._remember_view()
        self.workspace = None
        if session is not None:
            # Saved (even if its register update is still pending): never offer it again in this session.
            self.session_excluded.add(session.recording_id)
        self.history.append(
            {"event": "finished", "recording_id": session.recording_id if session else None,
             "n_annotations": getattr(result, "n_annotations", None)}
        )
        if self.request.mode == "practice" and session is not None and loaded is not None:
            self._practice_feedback(session, loaded)
            return
        if loaded is not None:
            loaded.close()
        if self.request.mode == "assessment" and self.reference_set is not None and self._assessment_all_done():
            # The last assessment recording: produce the report now, whatever the annotator does next.
            self._assessment_complete_report()
            self._back_to_start()
            return
        if self.request.mode == "assessment":
            text = "Your annotations for this assessment recording were saved."
        elif result is not None:
            text = (
                f"Saved {result.n_annotations} annotation(s) for {session.recording_id if session else ''} "
                f"({result.elapsed_s / 60:.1f} min)."
            )
        else:
            text = "Your annotations were saved."
        self._continue_or_quit(text)

    def _on_closed(self) -> None:
        self._remember_view()
        if self.loaded is not None:
            self.loaded.close()
        self.workspace = None
        self.history.append({"event": "closed_without_saving"})
        if self.session is not None:
            self.session_excluded.add(self.session.recording_id)
        self._continue_or_quit("The recording was closed without saving and remains incomplete.")

    def _continue_or_quit(self, text: str) -> None:
        go_on, back, leave = "Continue with another recording", "Back to the start window", "Quit"
        choice = self.prompts.choose(
            self.parent_widget,
            "Continue?",
            f"{text}\n\nWhat would you like to do next? (The start window is where you can change the mode, "
            "the dataset or the annotator.)",
            [go_on, back, leave],
        )
        if choice == go_on:
            self.next_recording()
        elif choice == back:
            self._back_to_start()
        else:
            self.quit()

    def quit(self) -> None:
        self.history.append({"event": "quit"})
        self.start_window.hide()
        app = QApplication.instance()
        if app is not None and not self.synchronous_loading:
            QTimer.singleShot(0, app.quit)

    def _on_start_window_closed(self) -> None:
        self.quit()

    def start_watchdog(self, interval_ms: int = 2000) -> None:
        """Bring back the start window if, after an unexpected error, no window is left.

        The application does not quit when its last window closes (windows are
        replaced one by another, with gaps); this makes sure it never keeps
        running invisibly either.
        """
        self._idle_ticks = 0

        def check() -> None:
            app = QApplication.instance()
            visible = [w for w in app.topLevelWidgets() if w.isVisible()] if app is not None else [True]
            busy = self.worker is not None and self.worker.isRunning()
            self._idle_ticks = 0 if (visible or busy) else self._idle_ticks + 1
            if self._idle_ticks >= 2:
                self._idle_ticks = 0
                self.history.append({"event": "watchdog_restored_start_window"})
                self._back_to_start()

        self._watchdog = QTimer(self)
        self._watchdog.timeout.connect(check)
        self._watchdog.start(interval_ms)

    # -------------------------------------------------------------- training
    def _practice_feedback(self, session: AnnotationSession, loaded: LoadedRecording) -> None:
        from electroclean.training.gui import show_practice_feedback

        show_practice_feedback(self, session, loaded)

    def after_practice_feedback(self, loaded: LoadedRecording) -> None:
        loaded.close()
        self._continue_or_quit("Practice recording finished.")

    def _assessment_complete_report(self) -> None:
        from electroclean.training.gui import show_assessment_completion

        show_assessment_completion(self)

    def start_quiz(self) -> bool:
        from electroclean.training.gui import start_quiz

        return start_quiz(self)

    # ----------------------------------------------------------------- tools
    def open_admin(self, dataset_root: Path | None) -> None:
        from electroclean.training.gui import open_admin_tools

        open_admin_tools(self, dataset_root)

    def open_agreement(self, output_root: Path | None) -> None:
        from electroclean.reliability.gui import open_agreement_dialog

        open_agreement_dialog(self.start_window, output_root, self.prompts)
