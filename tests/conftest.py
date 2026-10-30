"""Shared pytest fixtures: synthetic datasets, settings and loaded recordings."""

from __future__ import annotations

from pathlib import Path

import mne
import pytest

from electrotag.app.annotations.labels import default_catalogue
from electrotag.app.eeg.loading import load_recording
from electrotag.app.io.discovery import discover_recordings
from electrotag.app.io.naming import OutputLayout
from electrotag.app.session.session import AnnotationSession
from electrotag.config.settings import load_settings
from electrotag.synthetic import make_synthetic_dataset

mne.set_log_level("error")

SUB1 = "sub-001/eeg/sub-001_task-rest_eeg.vhdr"
SUB2 = "sub-002/eeg/sub-002_task-rest_eeg.vhdr"


@pytest.fixture(autouse=True)
def _questionnaire_answered(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    """The sign-up questionnaire's gate (electrotag/web/questionnaire.py) is tested where a test is marked
    ``questionnaire`` (tests/test_web_questionnaire.py); the other tests, written about other things, act as people who
    have answered it. The Firebase functions run in their own processes, where everyone is asked as in a study."""
    if request.node.get_closest_marker("questionnaire") is None:
        monkeypatch.setattr("electrotag.web.questionnaire.Questionnaire.answered", lambda self, user: True)


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
