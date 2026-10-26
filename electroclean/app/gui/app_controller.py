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
from qtpy.QtWidgets import QApplication, QListWidget, QListWidgetItem, QMessageBox, QProgressDialog, QWidget

from electroclean.app.annotations.labels import default_catalogue
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
from electroclean.app.session.session import AnnotationSession, SessionError
from electroclean.app.session.transaction import recover_interrupted_exports
from electroclean.config.settings import FilterSettings, Settings, SettingsError, StudyConfig, load_settings

FAILED_TO_LOAD = "Failed to load file. Would you like to continue with another recording or quit?"


class AppController(QObject):
    def __init__(self, *, prompts: UserPrompts | None = None, synchronous_loading: bool = False) -> None:
        super().__init__()
        self.prompts = prompts or UserPrompts()
        self.synchronous_loading = synchronous_loading  # used by tests
        self.catalogue = default_catalogue()
        self.start_window = StartWindow()
        self.start_window.beginRequested.connect(self.begin)
        self.start_window.adminRequested.connect(self.open_admin)
        self.start_window.agreementRequested.connect(self.open_agreement)
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
                suffix=s.discovery_suffix,
                exclude_dir_names=tuple(s.discovery_exclude_dir_names) + (out.name,),
                follow_symlinks=s.discovery_follow_symlinks,
            )
        except OSError as exc:
            self.prompts.error(self.parent_widget, "Cannot read the dataset folder", str(exc))
            return False
        self.session_excluded = set()
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
            if request.mode == "assessment" and request.assessment_kind == "quiz":
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
        assert self.request is not None and self.settings is not None and self.layout is not None
        req, s = self.request, self.settings
        register = CompletionRegister(self.layout, s.register_lock_timeout_s)
        try:
            completed = register.completed(req.annotator_id, req.mode, self._context_id())
        except RegisterError as exc:
            self.prompts.error(self.parent_widget, "Completion register problem", str(exc))
            self._back_to_start()
            return
        failures = FailureLog(self.layout).unresolved(self.recordings, {"collision_policy": s.collision_policy})
        restrict = self._restrict_to()
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
                    self._assessment_complete_report()
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
        from qtpy.QtWidgets import QDialog, QDialogButtonBox, QVBoxLayout

        candidates = [
            r for r in self.recordings
            if r.recording_id not in completed and r.recording_id not in failed and r.recording_id not in self.session_excluded
            and (restrict is None or r.recording_id in restrict)
        ]
        if not candidates:
            self.prompts.inform(self.parent_widget, "No more recordings", "All eligible recordings have been completed.")
            return None
        dlg = QDialog(self.parent_widget)
        dlg.setWindowTitle("Choose a recording")
        layout = QVBoxLayout(dlg)
        lst = QListWidget()
        for r in candidates:
            item = QListWidgetItem(r.recording_id)
            item.setData(Qt.UserRole, r.recording_id)
            lst.addItem(item)
        lst.setCurrentRow(0)
        layout.addWidget(lst)
        bb = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        bb.accepted.connect(dlg.accept)
        bb.rejected.connect(dlg.reject)
        lst.itemDoubleClicked.connect(lambda _i: dlg.accept())
        layout.addWidget(bb)
        dlg.resize(520, 420)
        if dlg.exec() != QDialog.Accepted or lst.currentItem() is None:
            return None
        rid = lst.currentItem().data(Qt.UserRole)
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
        self.progress = QProgressDialog(f"Opening {files.recording_id}…", "", 0, 0)
        self.progress.setWindowTitle("ElectroClean")
        self.progress.setCancelButton(None)
        self.progress.setWindowModality(Qt.ApplicationModal)
        self.progress.setMinimumDuration(0)
        self.progress.show()
        worker.progress.connect(lambda msg: self.progress and self.progress.setLabelText(f"{files.recording_id}\n{msg}…"))
        worker.succeeded.connect(self._on_loaded, Qt.QueuedConnection)
        worker.failed.connect(lambda exc, tb: self._on_load_failed(files, exc, tb), Qt.QueuedConnection)
        worker.start()

    def _close_progress(self) -> None:
        if self.progress is not None:
            self.progress.close()
            self.progress = None

    def _on_load_failed(self, files: RecordingFiles, exc: BaseException, tb: str) -> None:
        self._close_progress()
        assert self.layout is not None and self.request is not None and self.settings is not None
        kind = getattr(exc, "kind", "unexpected_error")
        message = str(exc)
        conditions = {"collision_policy": self.settings.collision_policy} if kind == "event_code_collision" else {}
        try:
            FailureLog(self.layout).record(
                files, files.recording_id, kind, message, annotator_id=self.request.annotator_id,
                details=tb if not isinstance(exc, RecordingLoadError) else "", conditions=conditions,
            )
        except OSError:
            pass
        self.session_excluded.add(files.recording_id)
        self.history.append({"event": "load_failed", "recording_id": files.recording_id, "kind": kind})
        go_on = self.prompts.ask(
            self.parent_widget,
            "Failed to load file",
            FAILED_TO_LOAD,
            details=f"Recording: {files.recording_id}\n\n{message}",
            yes="Continue with another recording",
            no="Quit",
            icon=QMessageBox.Warning,
        )
        if go_on:
            self.next_recording()
        else:
            self.quit()

    def _on_loaded(self, loaded: LoadedRecording) -> None:
        self._close_progress()
        assert self.request is not None and self.settings is not None and self.layout is not None
        req = self.request
        context: dict[str, Any] = {}
        if self.reference_set is not None:
            context = {"reference_set_id": self.reference_set.set_id, "reference_set_name": self.reference_set.name}
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
            )
            session.start()
        except (LockError, SessionError) as exc:
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
            )
        except Exception as exc:
            session.abandon(reason=f"viewer could not be opened: {exc}")
            loaded.close()
            self._on_load_failed(loaded.files, exc, traceback.format_exc())
            return
        self.workspace = ws
        ws.finished.connect(self._on_finished)
        ws.closedWithoutSaving.connect(self._on_closed)
        self.history.append({"event": "opened", "recording_id": loaded.info.recording_id, "session_id": session.session_id})
        ws.show()

    # ------------------------------------------------------------ finishing
    def _on_finished(self, result: Any) -> None:
        assert self.request is not None
        session, loaded = self.session, self.loaded
        self.workspace = None
        self.history.append(
            {"event": "finished", "recording_id": session.recording_id if session else None,
             "n_annotations": getattr(result, "n_annotations", None)}
        )
        if self.request.mode == "practice" and session is not None and loaded is not None:
            self._practice_feedback(session, loaded)
            return
        if loaded is not None:
            loaded.close()
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
        if self.loaded is not None:
            self.loaded.close()
        self.workspace = None
        self.history.append({"event": "closed_without_saving"})
        if self.session is not None:
            self.session_excluded.add(self.session.recording_id)
        self._continue_or_quit("The recording was closed without saving and remains incomplete.")

    def _continue_or_quit(self, text: str) -> None:
        go_on = self.prompts.ask(
            self.parent_widget,
            "Continue?",
            f"{text}\n\nWould you like to continue with another recording or quit?",
            yes="Continue with another recording",
            no="Quit",
        )
        if go_on:
            self.next_recording()
        else:
            self.quit()

    def quit(self) -> None:
        self.history.append({"event": "quit"})
        self.start_window.close()
        app = QApplication.instance()
        if app is not None and not self.synchronous_loading:
            QTimer.singleShot(0, app.quit)

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
