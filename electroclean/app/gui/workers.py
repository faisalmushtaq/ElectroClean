"""Background loading so the interface stays responsive."""

from __future__ import annotations

import traceback
from pathlib import Path
from typing import Any

from qtpy.QtCore import QThread, Signal

from electroclean.app.annotations.labels import LabelCatalogue
from electroclean.app.eeg.loading import load_recording
from electroclean.app.io.discovery import RecordingFiles
from electroclean.config.settings import FilterSettings, Settings


class LoadWorker(QThread):
    """Runs :func:`load_recording` in a background thread."""

    progress = Signal(str)
    succeeded = Signal(object)  # LoadedRecording
    failed = Signal(object, str)  # exception, traceback text

    def __init__(
        self,
        files: RecordingFiles,
        settings: Settings,
        filters: FilterSettings,
        catalogue: LabelCatalogue,
        cache_dir: Path | None = None,
    ) -> None:
        super().__init__()
        self.files = files
        self.settings = settings
        self.filters = filters
        self.catalogue = catalogue
        self.cache_dir = cache_dir
        self.result: Any = None
        self.error: BaseException | None = None

    def run(self) -> None:  # noqa: D102 - QThread entry point
        try:
            self.result = load_recording(
                self.files,
                self.settings,
                self.filters,
                self.catalogue,
                progress=self.progress.emit,
                cache_dir=self.cache_dir,
            )
        except Exception as exc:  # reported to the user, never re-raised in the thread
            self.error = exc
            self.failed.emit(exc, traceback.format_exc())
            return
        self.succeeded.emit(self.result)
