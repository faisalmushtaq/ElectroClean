"""``electroclean-web`` with a study folder: setting up a study, registering, accounts, assignments."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from electroclean.web.cli import main as cli
from electroclean.web.store_files import FilesStore
from tests.web_helpers import GUIDED1, SUB1, SUB3, make_template


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("cli-demo"))


def test_a_study_folder_from_scratch(template: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str],
                                     monkeypatch: pytest.MonkeyPatch) -> None:
    study = tmp_path / "pilot"
    assert cli(["init-study", "--study-dir", str(study), "--study", "pilot", "--name", "Pilot study"]) == 0
    assert json.loads((study / "electroclean_study.json").read_text())["name"] == "Pilot study"
    assert cli(["init-study", "--study-dir", str(study), "--study", "pilot"]) == 2  # exists already
    assert cli(["register", str(template / "recordings" / "study"), "--study-dir", str(study)]) == 0
    assert cli(["register", str(template / "training-source"), "--study-dir", str(study)]) == 0
    store = FilesStore(study)
    ms = store.manifests()
    assert {m["recording_id"] for m in ms if m["scope"] == "study"} == {
        SUB1, "sub-002/eeg/sub-002_task-rest_eeg.vhdr", SUB3}
    assert {m["recording_id"] for m in ms if m["scope"] == "set:example"} >= {GUIDED1}
    # the training set is kept with its experts' annotations but without its recordings
    rs = store.reference_set("example")
    assert rs.recordings_dir and not (rs.directory / rs.recordings_dir).exists()
    assert rs.reference_document(GUIDED1).annotations
    assert not list(study.rglob("*.eeg")) and not list(study.rglob("*.edf")) and not list(study.rglob("*.vhdr"))
    store.close()
    monkeypatch.setenv("ELECTROCLEAN_PASSWORD", "a-long-password")
    assert cli(["add-user", "a01", "--study-dir", str(study), "--name", "Ann"]) == 0
    assert cli(["add-user", "A01", "--study-dir", str(study)]) == 2  # exists: --replace to change it
    assert cli(["add-user", "B01", "--study-dir", str(study), "--password", "short"]) == 2
    assert cli(["assign", "A01", "--recordings", SUB1, "--study-dir", str(study)]) == 0
    assert cli(["assign", "A01", "--recordings", "nope.vhdr", "--study-dir", str(study)]) == 2
    assert cli(["assign", "A01", "--all", "--study-dir", str(study)]) == 0
    assert cli(["assign", "Z99", "--all", "--study-dir", str(study)]) == 2  # no account
    assert cli(["assign", "A01", "--programme", "example", "--study-dir", str(study)]) == 0
    assert cli(["assign", "A01", "--programme", "missing", "--study-dir", str(study)]) == 2
    capsys.readouterr()
    assert cli(["list", "--study-dir", str(study)]) == 0
    out = capsys.readouterr().out
    assert "A01" in out and "3 assigned" in out and "programme example" in out and GUIDED1 in out
    store = FilesStore(study)
    assert [a.recording_id for a in store.assignments("A01")][0] == SUB1
    assert store.db.authenticate("A01", "a-long-password") is not None
    store.close()


def test_registration_bundles(template: Path, tmp_path: Path) -> None:
    bundle = tmp_path / "registrations.json"
    assert cli(["export-manifests", str(template / "training-source"), "--out", str(bundle)]) == 0
    data = json.loads(bundle.read_text())
    assert data["reference_sets"] and data["manifests"]
    assert all(m["scope"] == "set:example" for m in data["manifests"])
    study = tmp_path / "s"
    assert cli(["init", "--study-dir", str(study), "--study", "s"]) == 0
    assert cli(["import-manifests", str(bundle), "--study-dir", str(study)]) == 0
    store = FilesStore(study)
    assert store.reference_set("example").guided_recordings
    assert len(store.manifests()) == len(data["manifests"])
    store.close()


def test_mistakes_are_reported_without_a_traceback(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli(["list"]) == 2
    assert "Say which study" in capsys.readouterr().err
    assert cli(["list", "--study-dir", str(tmp_path / "nothing")]) == 2
    assert "not a study folder" in capsys.readouterr().err
    assert cli(["export", "--study-dir", str(tmp_path), "--to", str(tmp_path / "out")]) == 2
    assert cli([]) == 2


def test_the_demo_is_made_once(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli(["demo", "--dir", str(tmp_path / "d"), "--no-serve"]) == 0
    assert (tmp_path / "d" / "recordings.zip").is_file()
    capsys.readouterr()
    assert cli(["demo", "--dir", str(tmp_path / "d"), "--no-serve"]) == 0
    assert "Using the demonstration" in capsys.readouterr().out
