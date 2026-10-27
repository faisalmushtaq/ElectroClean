"""Shared pytest fixtures: synthetic datasets, settings and loaded recordings."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_API", "pyside6")
os.environ.setdefault("MNE_BROWSER_BACKEND", "qt")

import mne  # noqa: E402

mne.set_log_level("error")

from electroclean.app.annotations.labels import default_catalogue  # noqa: E402
from electroclean.app.eeg.loading import load_recording  # noqa: E402
from electroclean.app.io.discovery import discover_recordings  # noqa: E402
from electroclean.app.io.naming import OutputLayout  # noqa: E402
from electroclean.app.session.session import AnnotationSession  # noqa: E402
from electroclean.config.settings import load_settings  # noqa: E402
from electroclean.synthetic import make_synthetic_dataset  # noqa: E402

SUB1 = "sub-001/eeg/sub-001_task-rest_eeg.vhdr"
SUB2 = "sub-002/eeg/sub-002_task-rest_eeg.vhdr"


@pytest.fixture(scope="session", autouse=True)
def _delete_windows_before_exit():
    """Delete windows without a parent at the end of the run.

    PySide can crash while Python shuts down if parentless windows that were shown (dialogs
    created in tests with no parent) are still alive then. In the application every dialog has a
    parent window, so this only concerns the tests.
    """
    yield
    try:
        from qtpy.QtCore import QCoreApplication, QEvent
        from qtpy.QtWidgets import QApplication
    except Exception:  # noqa: BLE001 - no Qt, nothing to clean up
        return
    app = QApplication.instance()
    if app is None:
        return
    for widget in QApplication.topLevelWidgets():
        if widget.parent() is None:
            widget.deleteLater()
    QCoreApplication.sendPostedEvents(None, QEvent.DeferredDelete)
    app.processEvents()


@pytest.fixture
def dataset(tmp_path: Path):
    """A fresh two-subject synthetic dataset (60 s, 250 Hz) per test."""
    root = tmp_path / "dataset"
    truths = make_synthetic_dataset(root, n_subjects=2, duration_s=60.0, seed=1)
    return root, truths


@pytest.fixture
def rich_dataset(tmp_path: Path):
    """Dataset with a code collision, a discontinuity and duplicate file names."""
    root = tmp_path / "rich"
    truths = make_synthetic_dataset(
        root,
        n_subjects=2,
        duration_s=40.0,
        seed=2,
        with_collision_recording=True,
        with_duplicate_names=True,
        with_discontinuity=True,
    )
    return root, truths


@pytest.fixture
def catalogue():
    return default_catalogue()


@pytest.fixture
def recordings(dataset):
    root, _ = dataset
    return {r.recording_id: r for r in discover_recordings(root)}


@pytest.fixture
def settings(dataset):
    root, _ = dataset
    s, _ = load_settings(root)
    return s


@pytest.fixture
def loaded(recordings, settings, catalogue):
    lr = load_recording(recordings[SUB1], settings, settings.filters, catalogue)
    yield lr
    lr.close()


@pytest.fixture
def layout(dataset):
    root, _ = dataset
    return OutputLayout(root / "Annotated_Events")


def make_session(layout, settings, catalogue, loaded, annotator="A01", **kw) -> AnnotationSession:
    session = AnnotationSession(
        layout=layout,
        settings=settings,
        filters=settings.filters,
        catalogue=catalogue,
        loaded=loaded,
        annotator_id=annotator,
        **kw,
    )
    return session
