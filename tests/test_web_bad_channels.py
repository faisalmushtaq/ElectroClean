"""The study's server and the channels marked bad, the uncertain type and the setting for joining marks.

Bad channels go with a draft and with Save and Finish, are written to the annotations file and a
``_channels.tsv``, come back with a revision and a correction, and are counted in the experts' Saved work,
with the marks that need review; ``annotation.merge_overlapping`` reaches the browser through GET /me.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.web.app import create_app  # noqa: E402
from tests.web_helpers import SUB1, SUB2, Api, ann, copy_demo, make_template, match_body, submission  # noqa: E402

BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
UNSURE = ann("d" * 32, "Data-artifact", 3000, 250, [])


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-bad-channels"))


@pytest.fixture
def study(template: Path, tmp_path: Path) -> Path:
    return copy_demo(template, tmp_path)


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


@pytest.fixture
def client(study: Path, template: Path):
    a = create_app(study, demo=True, demo_zip=template / "recordings.zip")
    yield TestClient(a)
    a.state.store.close()


def test_saved_with_a_channels_tsv_counted_for_the_experts_and_back_with_a_revision(client: TestClient,
                                                                                     recordings: Path,
                                                                                     study: Path) -> None:
    api = Api(client, "A01")
    names = api.ok("post", "/match", match_body(recordings, SUB1))["manifest"]["ch_names"]
    body = {**submission(recordings, SUB1, [BLINK, UNSURE]), "bad_channels": [names[3], names[1]]}
    saved = api.ok("post", "/submissions", body)
    assert any(f.endswith("_channels.tsv") for f in saved["files"]) and len(saved["files"]) == 6
    folder = study / "Annotated_Events" / "annotator-A01" / "sub-001" / "eeg"
    doc = json.loads(next(folder.glob("*_annotations.json")).read_text(encoding="utf-8"))
    assert doc["bad_channels"] == [names[1], names[3]]  # in recording order
    rows = [r.split("\t") for r in next(folder.glob("*_channels.tsv")).read_text(encoding="utf-8").splitlines()]
    assert [r[3] for r in rows[1:]].count("bad") == 2
    session = json.loads(next(folder.glob("*_session.json")).read_text(encoding="utf-8"))
    assert session["bad_channels"]["marked_by_annotator"] == [names[1], names[3]]
    # the experts' Saved work counts them, and the marks that need review
    e01 = Api(client, "E01")
    r = e01.post("/expert/work_list", {})
    assert r.status_code == 200, r.text
    row = next(i for i in r.json()["items"] if i["annotator_id"] == "A01" and i["recording_id"] == SUB1)
    assert (row["n_needs_review"], row["n_bad_channels"]) == (1, 2)
    # a revision opens with them
    m = api.ok("post", "/match", {**match_body(recordings, SUB1), "revise": True})
    assert m["revision"]["bad_channels"] == [names[1], names[3]]


def test_refused_when_not_channels_of_the_recording(client: TestClient, recordings: Path) -> None:
    api = Api(client, "A01")
    for bad, words in ((["Nope"], "not shown"), ("Fp1", "list of channel names"), (["Fp1", "Fp1"], "more than once")):
        r = api.post("/submissions", {**submission(recordings, SUB1, [BLINK]), "bad_channels": bad})
        assert r.status_code == 422 and words in r.json()["message"], r.text


def test_a_save_without_bad_channels_has_the_five_files(client: TestClient, recordings: Path) -> None:
    saved = Api(client, "A01").ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    assert len(saved["files"]) == 5 and not any(f.endswith("_channels.tsv") for f in saved["files"])


def test_drafts_keep_them_and_the_setting_reaches_the_browser(client: TestClient, recordings: Path) -> None:
    api = Api(client, "A01")
    draft = {"annotations": [BLINK], "bad_channels": ["Fp2"], "elapsed_s": 12.0}
    api.ok("put", f"/drafts/{SUB2}?mode=standard", draft)
    m = api.ok("post", "/match", match_body(recordings, SUB2))
    assert m["draft"]["bad_channels"] == ["Fp2"]
    assert api.put(f"/drafts/{SUB2}?mode=standard", {**draft, "bad_channels": "Fp2"}).status_code == 422
    me = api.ok("get", "/me")
    assert me["study"]["annotation"]["merge_overlapping"] is True
    admin = Api(client, "ADMIN")
    admin.admin_ok("settings_update", {"settings": {"annotation": {"merge_overlapping": False}}})
    assert Api(client, "A02").ok("get", "/me")["study"]["annotation"]["merge_overlapping"] is False
