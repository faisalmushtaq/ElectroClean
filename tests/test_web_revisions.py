"""Revisions: an annotator reopens a recording they finished, changes it and submits it again.

A revision is a new attempt of the same assignment: the earlier files stay as they were, the
completion register gains a row, and the analyses use the latest attempt."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electroclean.app.io.canonical import read_annotations_json  # noqa: E402
from electroclean.app.io.naming import OutputLayout  # noqa: E402
from electroclean.app.session.register import CompletionRegister  # noqa: E402
from electroclean.config.settings import SettingsError, Settings, deep_merge, load_default_settings_dict  # noqa: E402
from electroclean.reliability.config import AnalysisConfig  # noqa: E402
from electroclean.reliability.data import build_dataset, load_dataset  # noqa: E402
from electroclean.web.app import create_app  # noqa: E402
from electroclean.web.service import StudyService, WorkItem  # noqa: E402
from electroclean.web.store import attempt_of, latest_entry  # noqa: E402
from tests.web_helpers import SUB1, SUB2, Api, ann, copy_demo, make_template, match_body, submission  # noqa: E402

BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
EMG = ann("c" * 32, "EMG-artifact", 3000, 250, [])
STEM = "sub-001_task-rest_eeg_annotator-A01"


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-revisions"))


@pytest.fixture
def study(template: Path, tmp_path: Path) -> Path:
    return copy_demo(template, tmp_path)


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


@pytest.fixture
def app(study: Path, template: Path):
    a = create_app(study, demo=True, demo_zip=template / "recordings.zip")
    yield a
    a.state.store.close()


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app)


def checksums(folder: Path) -> dict[str, str]:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.iterdir())}


def item_of(api: Api, rid: str) -> dict:
    return next(i for i in api.ok("get", "/assignments")["items"] if i["recording_id"] == rid)


def test_a_revision_is_a_new_attempt_and_keeps_the_earlier_files(client: TestClient, recordings: Path,
                                                                  study: Path) -> None:
    api = Api(client, "A01")
    first = api.ok("post", "/submissions", submission(recordings, SUB1, [BLINK], elapsed=100.0))
    assert first["attempt"] == 1 and first["revision"] is None
    folder = study / "Annotated_Events" / "annotator-A01" / "sub-001" / "eeg"
    before = checksums(folder)
    assert len(before) == 5

    # The history: the latest saved attempt of each done recording.
    item = item_of(api, SUB1)
    assert item["status"] == "done" and item["revising"] is False
    assert item["saved"]["version"] == 1 and item["saved"]["n_annotations"] == 1
    assert item["saved"]["elapsed_s"] == 100.0 and item["saved"]["saved_at"]
    assert item_of(api, SUB2)["saved"] is None
    me = api.ok("get", "/me")
    assert me["study"]["annotation"]["allow_revisions"] is True

    # Opening the file again: done, unless the annotator asks to revise it.
    m = api.ok("post", "/match", match_body(recordings, SUB1))
    assert m["status"] == "done" and "Open to revise" in m["message"] and m["revision"] is None
    m = api.ok("post", "/match", {**match_body(recordings, SUB1), "revise": True})
    assert m["status"] == "matched" and m["manifest"]["recording_id"] == SUB1 and m["draft"] is None
    assert m["revision"]["version"] == 2 and m["revision"]["revises"] == 1 and m["revision"]["saved_at"]
    assert [(a["annotation_id"], a["label"], a["onset_sample"], a["duration_samples"], a["channels"])
            for a in m["revision"]["annotations"]] == [(BLINK["annotation_id"], "Eye-blink-artifact", 500, 100,
                                                        ["Fp1", "Fp2"])]

    # A draft of the revision is kept, marks the recording as being revised and is offered again.
    api.ok("put", f"/drafts/{SUB1}", {"annotations": [BLINK, EMG], "view": {}, "elapsed_s": 12.0})
    assert item_of(api, SUB1)["revising"] is True and item_of(api, SUB1)["status"] == "done"
    m = api.ok("post", "/match", {**match_body(recordings, SUB1), "revise": True})
    assert len(m["draft"]["annotations"]) == 2 and m["draft"]["revises"] == 1

    # Saving again needs the version being revised, and only the latest may be revised.
    plain = api.post("/submissions", submission(recordings, SUB1, [BLINK, EMG]))
    assert plain.status_code == 409 and plain.json()["error"] == "already_done"
    stale = api.post("/submissions", {**submission(recordings, SUB1, [BLINK, EMG]), "revises": 2})
    assert stale.status_code == 409 and stale.json()["error"] == "already_revised"
    bad = api.post("/submissions", {**submission(recordings, SUB1, [BLINK, EMG]), "revises": "1"})
    assert bad.status_code == 400

    rev = api.ok("post", "/submissions", {**submission(recordings, SUB1, [BLINK, EMG], elapsed=30.0), "revises": 1})
    assert rev["attempt"] == 2 and rev["revision"] == {"version": 2, "revises": 1}
    assert sorted(rev["files"]) == sorted(f"{STEM}_attempt-02{s}" for s in (
        "_events.tsv", "_events.json", "_annotations.json", "_time_viewed.txt", "_session.json"))

    # The earlier files are untouched and kept.
    after = checksums(folder)
    assert {k: v for k, v in after.items() if k in before} == before and len(after) == 10

    # The register gained the new attempt; the session file records what it revises.
    rows = [e for e in CompletionRegister(OutputLayout(study / "Annotated_Events")).entries()
            if e["annotator_id"] == "A01" and e["recording_id"] == SUB1]
    assert [attempt_of(e) for e in rows] == [1, 2] and latest_entry(rows) is rows[1]
    assert rows[1]["n_annotations"] == "2" and rows[1]["elapsed_s"] == "30.000"
    sess = json.loads((folder / f"{STEM}_attempt-02_session.json").read_text())
    assert sess["context"]["revision"]["revises_version"] == 1
    assert sess["context"]["revision"]["revises_session_id"] == rows[0]["session_id"]
    doc = json.loads((folder / f"{STEM}_attempt-02_annotations.json").read_text())
    assert doc["session"]["context"]["revision"]["version"] == 2

    # Sending the same revision again (a second press, or a second browser) saves nothing more.
    again = api.post("/submissions", {**submission(recordings, SUB1, [EMG]), "revises": 1})
    assert again.status_code == 409 and again.json()["error"] == "already_revised"
    assert len(checksums(folder)) == 10

    item = item_of(api, SUB1)
    assert item["revising"] is False and item["saved"]["version"] == 2 and item["saved"]["n_annotations"] == 2
    assert item["saved"]["total_elapsed_s"] == 130.0
    store = client.app.state.store
    latest = json.loads(store.saved_document("A01", SUB1, "standard", ""))
    assert [a["label"] for a in latest["annotations"]] == ["Eye-blink-artifact", "EMG-artifact"]
    # A second revision builds on the first.
    m = api.ok("post", "/match", {**match_body(recordings, SUB1), "revise": True})
    assert m["revision"]["version"] == 3 and len(m["revision"]["annotations"]) == 2 and m["draft"] is None


def test_analyses_use_the_latest_attempt(client: TestClient, recordings: Path, study: Path, tmp_path: Path) -> None:
    a01, a02 = Api(client, "A01"), Api(client, "A02")
    a01.ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    a02.ok("post", "/submissions", submission(recordings, SUB1, [EMG]))
    a01.ok("post", "/submissions", {**submission(recordings, SUB1, [EMG]), "revises": 1})
    root = study / "Annotated_Events"
    ds = load_dataset([root], AnalysisConfig())
    assert [a.label for a in ds.groups[SUB1].docs["A01"].annotations] == ["EMG-artifact"]
    assert any("using the latest" in w and "attempt-02" in w for w in ds.warnings)

    # The latest by the moment of saving: a time written with another UTC offset is compared as an instant
    # (10:30+01:00 is before 09:45+00:00), and within one mode the attempt number decides.
    folder = root / "annotator-A01" / "sub-001" / "eeg"
    copies = tmp_path / "copies"
    copies.mkdir()
    for name, stamp in ((f"{STEM}_annotations.json", "2026-10-28T10:30:00.000+01:00"),
                        (f"{STEM}_attempt-02_annotations.json", "2026-10-28T09:45:00.000+00:00")):
        data = json.loads((folder / name).read_text())
        data["session"]["created_at"] = stamp
        (copies / name).write_text(json.dumps(data))
    docs = [(p.name, read_annotations_json(p)) for p in sorted(copies.iterdir())]
    chosen = build_dataset(docs, AnalysisConfig()).groups[SUB1].docs["A01"]
    assert [a.label for a in chosen.annotations] == ["EMG-artifact"]
    # without attempt numbers in the names (another mode, for example), the instant decides
    renamed = [(f"x{i}_annotations.json", d) for i, (_n, d) in enumerate(docs)]
    for _n, d in renamed:
        d.context = {}
    chosen = build_dataset(list(reversed(renamed)), AnalysisConfig()).groups[SUB1].docs["A01"]
    assert [a.label for a in chosen.annotations] == ["EMG-artifact"]


def test_reference_sources_use_the_latest_attempt(client: TestClient, recordings: Path) -> None:
    api = Api(client, "A01")
    api.ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    api.ok("post", "/submissions", {**submission(recordings, SUB1, [EMG]), "revises": 1})
    store = client.app.state.store
    files = store.saved_files("A01", SUB1, "standard", "")
    assert sorted(files) == sorted(f"{STEM}_attempt-02{s}" for s in (
        "_events.tsv", "_events.json", "_annotations.json", "_time_viewed.txt", "_session.json"))


def test_revisions_can_be_switched_off(client: TestClient, recordings: Path) -> None:
    admin, api = Api(client, "ADMIN"), Api(client, "A01")
    api.ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    out = admin.admin_ok("settings_update", {"settings": {"annotation": {"allow_revisions": False}}})
    assert out["settings"]["annotation"]["allow_revisions"] is False
    assert api.ok("get", "/me")["study"]["annotation"]["allow_revisions"] is False
    m = api.ok("post", "/match", {**match_body(recordings, SUB1), "revise": True})
    assert m["status"] == "done" and "Open to revise" not in m["message"]
    r = api.put(f"/drafts/{SUB1}", {"annotations": [], "view": {}, "elapsed_s": 1.0})
    assert r.status_code == 409 and r.json()["error"] == "already_done"
    r = api.post("/submissions", {**submission(recordings, SUB1, [EMG]), "revises": 1})
    assert r.status_code == 409 and r.json()["error"] == "revisions_off"


def test_training_recordings_keep_their_own_attempts(client: TestClient) -> None:
    service: StudyService = client.app.state.service if hasattr(client.app.state, "service") else None
    service = service or StudyService(client.app.state.store)
    saved = {"version": 1, "saved_at": "x"}
    for mode in ("guided", "practice", "assessment"):
        item = WorkItem("r", mode, "example", {}, "done", saved=saved)
        assert service.can_revise(item) is False, mode
    assert service.can_revise(WorkItem("r", "standard", "", {}, "done", saved=saved)) is True
    assert service.can_revise(WorkItem("r", "standard", "", {}, "in_progress", saved=saved)) is False


def test_the_settings_are_checked() -> None:
    base = load_default_settings_dict()
    s = Settings.from_dict(base)
    assert s.allow_revisions is True and s.gamification_enabled is True and s.gamification_leaderboard is True
    assert s.gamification_leaderboard_viewed_only is False
    off = Settings.from_dict(deep_merge(base, {"annotation": {"allow_revisions": False},
                                               "gamification": {"enabled": False}}))
    assert off.allow_revisions is False and off.gamification_enabled is False
    for bad in ({"annotation": {"allow_revisions": "no"}}, {"annotation": {"allow_revisions": 0}},
                {"gamification": {"leaderboard": None}}, {"gamification": {"leaderboard_viewed_only": "true"}}):
        with pytest.raises(SettingsError, match="must be true or false"):
            Settings.from_dict(deep_merge(base, bad))
    with pytest.raises(SettingsError, match="gamification must be a block"):
        Settings.from_dict({**base, "gamification": ["enabled"]})
    # a study file written before these settings existed keeps the defaults
    old = {k: v for k, v in base.items() if k != "gamification"}
    old["annotation"] = {k: v for k, v in base["annotation"].items() if k != "allow_revisions"}
    s = Settings.from_dict(old)
    assert s.allow_revisions is True and s.gamification_enabled is True


def test_source_files_are_never_written(client: TestClient, recordings: Path, template: Path,
                                        tmp_path: Path) -> None:
    """Revising reads nothing from and writes nothing to the recordings (they stay in the annotator's hands)."""
    snapshot = tmp_path / "snap"
    shutil.copytree(recordings, snapshot, symlinks=False)
    api = Api(client, "A01")
    api.ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    api.ok("post", "/submissions", {**submission(recordings, SUB1, [EMG]), "revises": 1})
    for p in snapshot.rglob("*"):
        if p.is_file():
            assert p.read_bytes() == (recordings / p.relative_to(snapshot)).read_bytes(), p
