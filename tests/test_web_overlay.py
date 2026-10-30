"""Everyone's marks on one recording (electrotag/web/overlay.py, docs/web/api.md "The overlay of everyone's marks").

``overlay_get`` gives each person's latest saved version compactly (five whole numbers a mark, with tables of
the types and channel sets), the annotation IDs of the people in lanes only, the corrected and adjudicated
versions when asked, and the crowd's counts per time bin; it pages hundreds of people and stays small with
300 people of 50 marks on 256 channels. Experts and administrators see everyone, named; a trainee sees an
unnamed crowd only, on a teaching recording, while the study's setting allows it; everyone else is refused."""

from __future__ import annotations

import json
import random
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.web import overlay  # noqa: E402
from electrotag.web.app import create_app  # noqa: E402
from tests.web_helpers import GUIDED1, SUB1, Api, ann, copy_demo, derived_maker, make_template, submission  # noqa: E402

CASES = json.loads((Path(__file__).resolve().parents[1] / "web_tests" / "unit" / "overlay_crowd_cases.json")
                   .read_text(encoding="utf-8"))
BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
EMG = ann("c" * 32, "EMG-artifact", 3000, 250, [])
MOVE = ann("d" * 32, "Eye-movement-artifact", 520, 90, ["Fp2", "Fp1"])


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-overlay"))


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


@pytest.fixture
def client(template: Path, tmp_path: Path):
    app = create_app(copy_demo(template, tmp_path), demo=True)
    with TestClient(app) as c:
        yield c
    app.state.store.close()


@pytest.fixture
def admin(client: TestClient) -> Api:
    return Api(client, "ADMIN")


def expert(api: Api, op: str, body: dict | None = None):
    return api.post(f"/expert/{op}", body or {})


def expert_ok(api: Api, op: str, body: dict | None = None) -> dict:
    r = expert(api, op, body)
    assert r.status_code == 200, f"{op}: {r.status_code} {r.text}"
    return r.json()


def expert_error(api: Api, op: str, body: dict, status: int, code: str) -> dict:
    r = expert(api, op, body)
    assert (r.status_code, r.json().get("error")) == (status, code), f"{op}: {r.status_code} {r.text}"
    return r.json()


def three_people(client: TestClient, admin: Api, recordings: Path) -> None:
    """A01, A02 and A03 save SUB1: A01 twice (the latest counts), A03 with nothing marked."""
    admin.admin_ok("user_add", {"annotator_id": "A03", "display_name": "Third", "password": "long enough"})
    admin.admin_ok("settings_update", {"settings": {"training": {"gate": "off"}}})
    admin.admin_ok("assign", {"annotator_ids": ["A01", "A02", "A03"], "recording_ids": [SUB1]})
    a01 = Api(client, "A01")
    a01.ok("post", "/submissions", submission(recordings, SUB1, [EMG]))
    a01.ok("post", "/submissions", {**submission(recordings, SUB1, [BLINK, EMG]), "revises": 1})
    Api(client, "A02").ok("post", "/submissions", submission(recordings, SUB1, [MOVE]))
    Api(client, "A03", "long enough").ok("post", "/submissions", submission(recordings, SUB1, []))


def channel_set(text: str) -> list[int]:
    out: list[int] = []
    for part in filter(None, text.split(",")):
        a, _, b = part.partition("-")
        out += range(int(a), int(b or a) + 1)
    return out


def decoded(answer: dict, person: dict) -> list[tuple]:
    """A person's marks back as (label, onset, duration, channel names, confidence)."""
    m = person["marks"]
    out, onset = [], 0
    for i in range(0, len(m), 5):
        onset += m[i + 1]
        out.append((answer["labels"][m[i]], onset, m[i + 2], [answer["channels"][c] for c in channel_set(
            answer["sets"][m[i + 3]])], m[i + 4]))
    return out


# ------------------------------------------------------------------ the crowd's counts
@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_the_crowd_is_counted_as_the_browser_counts_it(case: dict) -> None:
    people = [[(m[0], m[1], m[2]) for m in p] for p in case["people"]]
    assert overlay.crowd_counts(people, case["n_samples"], case["sfreq"]) == case["counts"]


def test_channel_sets_as_runs() -> None:
    assert overlay.ranges_text([]) == ""
    assert overlay.ranges_text([9, 0, 1, 2, 3, 7, 10]) == "0-3,7,9-10"
    assert channel_set("0-3,7,9-10") == [0, 1, 2, 3, 7, 9, 10]


def test_the_bins_are_whole_seconds_and_at_most_a_thousand() -> None:
    assert overlay.bin_seconds(30) == 1
    assert overlay.bin_seconds(1000) == 1
    assert overlay.bin_seconds(1001) == 2
    assert overlay.bin_seconds(4 * 3600) == 15
    got = overlay.crowd_counts([[(0, 10, True)]], 4 * 3600 * 250, 250.0)
    assert got["n_bins"] <= overlay.MAX_BINS and got["bin_s"] == 15


# ------------------------------------------------------------------ the answer
def test_everyones_latest_marks_compactly_with_the_crowd(client: TestClient, admin: Api, recordings: Path) -> None:
    three_people(client, admin, recordings)
    e01 = Api(client, "E01")
    got = expert_ok(e01, "overlay_get", {"recording_id": SUB1, "detail": ["a01"]})
    assert [p["annotator_id"] for p in got["people"]] == ["A01", "A02", "A03"]
    assert got["total"] == 3 and got["next_offset"] is None and got["anonymous"] is False
    a01, a02, a03 = got["people"]
    assert (a01["attempt"], a01["n_marks"], a01["display_name"], a01["roles"]) == (2, 2, "Annotator one", ["annotator"])
    assert decoded(got, a01) == [("Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"], 0),
                                 ("EMG-artifact", 3000, 250, [], 0)]
    assert decoded(got, a02) == [("Eye-movement-artifact", 520, 90, ["Fp1", "Fp2"], 0)]
    assert a03["marks"] == [] and a03["n_marks"] == 0
    assert got["sets"] == ["", "0-1"], "the channel sets are given once each, as runs of channel indexes"
    assert a01["ids"] == ["b" * 32, "c" * 32] and "ids" not in a02, "the IDs of the people in lanes only"
    assert got["channels"][:2] == ["Fp1", "Fp2"] and got["n_samples"] > 3250
    crowd = got["crowd"]
    assert crowd["n_people"] == 3 and crowd["bin_s"] == 1
    sf = got["sfreq"]
    assert crowd["marking"][int(500 // sf)] == 2 and crowd["whole"][int(3000 // sf)] == 1
    assert crowd["marking"][int(4000 // sf)] == 0 and crowd["whole"][int(500 // sf)] == 0
    assert got["derived"] == [] and got["facets"] == []
    # administrators see the same
    assert expert_ok(admin, "overlay_get", {"recording_id": SUB1})["total"] == 3
    # what is asked is checked
    expert_error(e01, "overlay_get", {}, 400, "bad_request")
    expert_error(e01, "overlay_get", {"recording_id": "nothing/like/this.edf"}, 404, "unknown_recording")
    expert_error(e01, "overlay_get", {"recording_id": SUB1, "include": ["everything"]}, 400, "bad_request")
    expert_error(e01, "overlay_get", {"recording_id": SUB1, "detail": [f"A{i:02d}" for i in range(9)]}, 400,
                 "bad_request")
    expert_error(e01, "overlay_get", {"recording_id": SUB1, "limit": 0}, 400, "bad_request")
    expert_error(e01, "overlay_get", {"recording_id": SUB1, "mode": "guided"}, 400, "bad_request")


def test_pages_of_people_and_the_crowd_over_everyone(client: TestClient, admin: Api, recordings: Path) -> None:
    three_people(client, admin, recordings)
    e01 = Api(client, "E01")
    first = expert_ok(e01, "overlay_get", {"recording_id": SUB1, "limit": 2})
    assert [p["annotator_id"] for p in first["people"]] == ["A01", "A02"] and first["next_offset"] == 2
    assert first["crowd"]["n_people"] == 3, "the crowd counts everyone, whatever the page"
    second = expert_ok(e01, "overlay_get", {"recording_id": SUB1, "limit": 2, "offset": 2})
    assert [p["annotator_id"] for p in second["people"]] == ["A03"] and second["next_offset"] is None
    assert second["crowd"] is None


def test_a_saved_version_is_read_once(client: TestClient, admin: Api, recordings: Path,
                                      monkeypatch: pytest.MonkeyPatch) -> None:
    three_people(client, admin, recordings)
    e01 = Api(client, "E01")
    store = client.app.state.store
    reads = []
    real = store.saved_files
    monkeypatch.setattr(store, "saved_files", lambda *a, **k: reads.append(a) or real(*a, **k))
    one = expert_ok(e01, "overlay_get", {"recording_id": SUB1})
    assert len(reads) == 3
    assert expert_ok(e01, "overlay_get", {"recording_id": SUB1}) == one
    assert len(reads) == 3, "kept in memory: a saved version never changes"
    # a new version is read when it is saved
    Api(client, "A02").ok("post", "/submissions", {**submission(recordings, SUB1, [BLINK]), "revises": 1})
    again = expert_ok(e01, "overlay_get", {"recording_id": SUB1})
    assert len(reads) == 4 and again["people"][1]["attempt"] == 2


def test_the_corrected_and_adjudicated_versions_as_lanes(client: TestClient, admin: Api, recordings: Path) -> None:
    three_people(client, admin, recordings)
    e01 = Api(client, "E01")
    sub = submission(recordings, SUB1, [BLINK], elapsed=40.0)
    expert_ok(e01, "correction_save", {"correction_id": "e" * 32, "annotator_id": "A01", "recording_id": SUB1,
                                       "attempt": 2, "annotations": [BLINK], "sha256": sub["sha256"],
                                       "session": sub["session"], "overall_note": "",
                                       "changes": [{"annotation_id": EMG["annotation_id"], "reason": "not_artifact"}]})
    store = client.app.state.store
    store.save_derived("adjudications", derived_maker(store, "ADJUDICATED", SUB1, [MOVE], kind="adjudications"),
                       elapsed_s=3, started_at="")
    got = expert_ok(e01, "overlay_get", {"recording_id": SUB1, "include": ["corrected", "adjudicated"],
                                         "detail": ["A01~E01"]})
    assert [(d["annotator_id"], d["source"], d["of"], d["by"]) for d in got["derived"]] == [
        ("A01~E01", "corrected", "A01", "E01"), ("ADJUDICATED", "adjudicated", None, None)]
    assert [x[0] for x in decoded(got, got["derived"][0])] == ["Eye-blink-artifact"]
    assert got["derived"][0]["ids"] == ["b" * 32] and "ids" not in got["derived"][1]
    assert [x[0] for x in decoded(got, got["derived"][1])] == ["Eye-movement-artifact"]
    assert got["crowd"]["n_people"] == 3, "the derived versions are never counted in the crowd"
    assert expert_ok(e01, "overlay_get", {"recording_id": SUB1, "include": "adjudicated"})["derived"][0]["source"] \
        == "adjudicated"


def test_facets_describe_people_for_the_filters(client: TestClient, admin: Api, recordings: Path,
                                                monkeypatch: pytest.MonkeyPatch) -> None:
    three_people(client, admin, recordings)
    monkeypatch.setitem(overlay.FACETS, "group", ("Group", lambda service, aids: {"A01": ["Leeds RAs", "Pilot"],
                                                                                  "A02": "Leeds RAs"}))
    got = expert_ok(Api(client, "E01"), "overlay_get", {"recording_id": SUB1})
    assert got["facets"] == [{"key": "group", "title": "Group", "values": ["Leeds RAs", "Pilot"]}]
    assert [p["facets"] for p in got["people"]] == [{"group": ["Leeds RAs", "Pilot"]}, {"group": "Leeds RAs"}, {}]


# ------------------------------------------------------------------ who may see it
def test_annotators_and_trainees_are_refused_everywhere_else(client: TestClient, admin: Api,
                                                              recordings: Path) -> None:
    three_people(client, admin, recordings)
    a01, t01 = Api(client, "A01"), Api(client, "T01")
    for who in (a01, t01):
        r = expert_error(who, "overlay_get", {"recording_id": SUB1}, 403, "forbidden")
        assert "does not show trainees" in r["message"]
        assert expert_ok(who, "overlay_teaching_list") == {"shown": False, "recordings": []}
    admin.admin_ok("settings_update", {"settings": {"replay": {"trainees_see_crowd": True}}})
    for who in (a01, t01):  # a study recording is never a teaching recording
        r = expert_error(who, "overlay_get", {"recording_id": SUB1}, 403, "forbidden")
        assert "your own judgement" in r["message"]
        expert_error(who, "overlay_get", {"recording_id": SUB1, "detail": ["A02"], "include": ["corrected"]}, 403,
                     "forbidden")
    # a practice recording would give the practice's answers away
    expert_error(t01, "overlay_get", {"recording_id": "sub-example03/eeg/sub-example03_task-example_eeg.vhdr",
                                      "mode": "practice", "context_id": "example"}, 403, "forbidden")


def test_a_trainee_sees_an_unnamed_crowd_on_a_teaching_recording(client: TestClient, admin: Api,
                                                                 recordings: Path) -> None:
    body = {"recording_id": GUIDED1, "mode": "practice", "context_id": "example"}
    for aid, marks in (("E01", [BLINK]), ("A01", [BLINK, EMG])):
        admin.admin_ok("assign", {"annotator_ids": [aid], "recording_ids": [GUIDED1], "mode": "practice",
                                  "context_id": "example"})
        Api(client, aid).ok("post", "/submissions", submission(recordings, GUIDED1, marks, "practice", "example"))
    t01 = Api(client, "T01")
    expert_error(t01, "overlay_get", body, 403, "forbidden")  # off by default
    admin.admin_ok("settings_update", {"settings": {"replay": {"trainees_see_crowd": True}}})
    assert expert_ok(t01, "overlay_teaching_list")["recordings"] == [
        {"recording_id": GUIDED1, "file_name": Path(GUIDED1).name, "mode": "practice", "context_id": "example",
         "n_people": 2, "yours": False}]
    got = expert_ok(t01, "overlay_get", {**body, "detail": ["E01"], "include": ["corrected"]})
    assert got["anonymous"] is True and got["total"] == 2
    assert [(p["annotator_id"], p["display_name"], p["roles"]) for p in got["people"]] == [
        ("Person 1", "", []), ("Person 2", "", [])]
    assert all("ids" not in p for p in got["people"]) and got["derived"] == [] and got["facets"] == []
    assert "E01" not in json.dumps(got["people"]) and "A01" not in json.dumps(got["people"])
    assert got["crowd"]["n_people"] == 2
    # experts see the same recording named
    named = expert_ok(Api(client, "E01"), "overlay_get", body)
    assert [p["annotator_id"] for p in named["people"]] == ["A01", "E01"]
    # the setting off again: refused
    admin.admin_ok("settings_update", {"settings": {"replay": {"trainees_see_crowd": False}}})
    expert_error(t01, "overlay_get", body, 403, "forbidden")


def test_the_setting_is_off_by_default_and_in_get_me(client: TestClient, admin: Api) -> None:
    assert client.app.state.service.settings.replay.trainees_see_crowd is False
    me = Api(client, "T01").ok("get", "/me")
    assert me["study"]["replay"]["trainees_see_crowd"] is False
    admin.admin_ok("settings_update", {"settings": {"replay": {"trainees_see_crowd": True}}})
    assert Api(client, "T01").ok("get", "/me")["study"]["replay"]["trainees_see_crowd"] is True
    admin.admin_error("settings_update", {"settings": {"replay": {"trainees_see_crowd": "yes"}}}, 400,
                      "invalid_settings")


# ------------------------------------------------------------------ size and speed
def test_300_people_of_50_marks_on_256_channels_stay_small_and_fast(client: TestClient,
                                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    """The answer for 300 people with 50 marks each on a 256-channel recording of 20 minutes: under 400 kB, the IDs
    of eight people in lanes adding about 30 kB, and answered in well under a second once the versions are read."""
    store = client.app.state.store
    m = dict(store.manifest("study", SUB1))
    names = [f"E{i + 1}" for i in range(256)]
    rid = "sub-256/eeg/sub-256_task-rest_eeg.edf"
    sf = 250.0
    store.add_manifest({**m, "recording_id": rid, "file_name": Path(rid).name, "ch_names": names,
                        "timing": {**m["timing"], "sfreq": sf, "n_samples": int(20 * 60 * sf)}})
    rng = random.Random(7)
    labels = ["Eye-blink-artifact", "EMG-artifact", "Eye-movement-artifact", "Electrode-pops-artifact",
              "Chewing-artifact"]

    def person(i: int) -> dict:
        marks = []
        for k in range(50):
            onset = rng.randrange(0, int(20 * 60 * sf) - 1000)
            kind = rng.random()
            n = rng.choice((1, 2, 4, 8, 32))  # neighbours in the montage's order, or a few scattered
            start = rng.randrange(0, 256 - n)
            chans = () if kind < 0.4 else tuple(names[start:start + n]) if kind < 0.9 else tuple(
                names[j] for j in sorted(rng.sample(range(256), 3)))
            marks.append((f"{i:04d}{k:028x}", rng.choice(labels), onset, rng.randrange(25, 1000), chans,
                          rng.choice((0, 1, 2, 3))))
        marks.sort(key=lambda x: (x[2], x[3], x[1], x[0]))
        return {"annotator_id": f"P{i:03d}", "attempt": 1, "saved_at": "2026-10-30T10:00:00+00:00", "marks": marks}

    crowd = [person(i) for i in range(300)]
    monkeypatch.setattr(overlay, "_saved_people", lambda *a: [dict(p) for p in crowd])
    e01 = Api(client, "E01")
    t0 = time.perf_counter()
    got = expert_ok(e01, "overlay_get", {"recording_id": rid})
    took = time.perf_counter() - t0
    size = len(json.dumps(got, separators=(",", ":")))
    assert got["total"] == 300 and sum(p["n_marks"] for p in got["people"]) == 15000
    assert size < 400_000, f"{size} bytes"
    assert took < 2.0, f"{took:.2f} s"
    # and compressed on the way, for a browser that accepts it
    r = client.post("/api/v1/expert/overlay_get", json={"recording_id": rid},
                    headers={**e01.headers, "Accept-Encoding": "gzip"})
    assert r.headers.get("content-encoding") == "gzip" and r.json()["total"] == 300
    assert int(r.headers["content-length"]) < 160_000, r.headers["content-length"]
    lanes = expert_ok(e01, "overlay_get", {"recording_id": rid, "detail": [f"P{i:03d}" for i in range(8)]})
    assert len(json.dumps(lanes, separators=(",", ":"))) - size < 40_000
    assert got["crowd"]["n_bins"] == 1200 // overlay.bin_seconds(1200) and max(got["crowd"]["marking"]) <= 300
    # what the answer says is what the people saved
    p0 = next(p for p in got["people"] if p["annotator_id"] == "P000")
    assert decoded(got, p0) == [(x[1], x[2], x[3], list(x[4]), x[5]) for x in crowd[0]["marks"]]
