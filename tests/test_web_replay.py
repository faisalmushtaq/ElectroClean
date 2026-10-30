"""Replays of sessions from the interaction log (electrotag/web/replay.py, docs/web/api.md "Corrections and replay").

The segments of a person's sessions on a recording come from the visit index, each with the attempt
it saved (by the session's ID, or in order for older logs); a segment's events are paged, with the
pointer optionally left out; experts replay anyone, and trainees watch only experts who agreed to it,
as the study's settings allow."""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.web.app import create_app  # noqa: E402
from tests.web_helpers import (  # noqa: E402
    GUIDED1, PRACTICE1, SUB1, SUB2, Api, ann, copy_demo, make_template, submission)

BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
EMG = ann("c" * 32, "EMG-artifact", 3000, 250, [])
S1, S2 = "1" * 32, "2" * 32


def summary(a: dict, sf: float = 256.0) -> dict:
    return {"id": a["annotation_id"], "label": a["label"], "onset_s": a["onset_sample"] / sf,
            "offset_s": (a["onset_sample"] + a["duration_samples"]) / sf, "channels": a["channels"],
            "confidence": None, "note_length": 0}


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-replay"))


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


def session(api: Api, rid: str, window: int, session_id: str, *, snapshot: list | None = None,
            created: list | None = None, finish: bool = True, pointers: int = 3, mode: str = "standard",
            context_id: str = "") -> str:
    """A visit in which ``rid`` is opened in window ``window``, marks are made and the recording finished."""
    v = api.ok("post", "/visits", {"client": {"user_agent": "pytest"}, "mode": mode,
                                   "context_id": context_id})["visit_id"]
    ctx = {"recording": rid, "window_no": window}
    ev = [{"t": 1.0, "type": "recording_opened", **ctx, "session_id": session_id, "mode": mode,
           "annotations_restored": len(snapshot or [])}]
    if snapshot is not None:
        ev.append({"t": 1.0, "type": "annotations_snapshot", **ctx, "part": 1, "n_parts": 1,
                   "annotations": [summary(a) for a in snapshot]})
    ev.append({"t": 1.1, "type": "viewer_ready", **ctx})
    ev += [{"t": 2.0 + i / 10, "type": "pointer", **ctx, "eeg_t": 1.0 + i, "eeg_channel": "Fp1"}
           for i in range(pointers)]
    ev.append({"t": 3.0, "type": "view", **ctx, "t_start": 0.0, "duration": 10, "ch_start": 0, "n_channels": 22,
               "scale_factor": 1})
    for i, a in enumerate(created or []):
        ev.append({"t": 4.0 + i, "type": "annotation_created", **ctx, "annotations": [summary(a)],
                   "n_total": i + 1, "via": "unknown"})
    ev.append({"t": 9.0, "type": "key", "key": "B"})  # outside the window (the home page)
    if finish:
        ev.append({"t": 10.0, "type": "recording_finished", **ctx, "session_id": session_id, "attempt": 1})
    api.ok("post", f"/visits/{v}/events", {"events": ev})
    api.ok("post", f"/visits/{v}/close", {"reason": "signed_out"})
    return v


def save(api: Api, recordings: Path, rid: str, annotations: list, session_id: str | None, revises: int | None = None,
         mode: str = "standard", context_id: str = ""):
    body = submission(recordings, rid, annotations, mode, context_id)
    if session_id:
        body["session"]["session_id"] = session_id
    if revises:
        body["revises"] = revises
    return api.ok("post", "/submissions", body)


def test_segments_with_their_attempts_and_the_saved_version(client: TestClient, recordings: Path) -> None:
    a01 = Api(client, "A01")
    v1 = session(a01, SUB1, 1, S1, created=[BLINK, EMG])
    save(a01, recordings, SUB1, [BLINK, EMG], S1)
    v2 = session(a01, SUB2, 2, "3" * 32, finish=False)  # another recording: not listed for SUB1
    # a revision logged before the browser sent its session's ID: no snapshot, matched in order
    v3 = session(a01, SUB1, 3, S2, created=[])
    save(a01, recordings, SUB1, [BLINK], None, revises=1)
    e01 = Api(client, "E01")
    idx = expert_ok(e01, "replay_index_get", {"annotator_id": "A01", "recording_id": SUB1})
    assert idx["logging"] is True and idx["file_name"] == "sub-001_task-rest_eeg.vhdr"
    assert idx["manifest"]["recording_id"] == SUB1
    segs = idx["segments"]
    assert [(s["visit_id"], s["window_no"], s["outcome"], s["attempt"], s["has_snapshot"]) for s in segs] == [
        (v1, 1, "finished", 1, False), (v3, 3, "finished", 2, False)]
    assert segs[0]["session_id"] == S1 and segs[0]["n_events"] >= 8 and segs[0]["started_at"]
    assert idx["saved"]["attempt"] == 2 and [a["label"] for a in idx["saved"]["annotations"]] == ["Eye-blink-artifact"]
    first = expert_ok(e01, "replay_index_get", {"annotator_id": "A01", "recording_id": SUB1, "attempt": 1})
    assert len(first["saved"]["annotations"]) == 2
    assert expert_ok(e01, "replay_index_get", {"annotator_id": "A01", "recording_id": SUB2})["segments"][0][
        "outcome"] == "not_finished"
    assert v2


def test_a_snapshot_is_noted_and_events_are_paged(client: TestClient, recordings: Path) -> None:
    a01 = Api(client, "A01")
    v = session(a01, SUB1, 7, S1, snapshot=[BLINK], created=[EMG], pointers=30)
    e01 = Api(client, "E01")
    seg = expert_ok(e01, "replay_index_get", {"annotator_id": "A01", "recording_id": SUB1})["segments"][0]
    assert seg["has_snapshot"] is True and seg["attempt"] is None and seg["outcome"] == "finished"
    seen, nxt, pages = [], 0, 0
    while nxt is not None:
        page = expert_ok(e01, "replay_events_get", {"visit_id": v, "window_no": 7, "from_seq": nxt, "limit": 10})
        assert page["header"]["started_at"] and len(page["events"]) <= 10
        seen += page["events"]
        nxt = page["next_seq"]
        pages += 1
    types = [e["type"] for e in seen]
    assert pages >= 4 and types[0] == "recording_opened" and types[-1] == "recording_finished"
    assert "key" not in types and "visit_started" not in types, "only the window's events, from its opening to its end"
    assert [e["seq"] for e in seen] == sorted(e["seq"] for e in seen)
    calm = expert_ok(e01, "replay_events_get", {"visit_id": v, "window_no": 7, "pointer": False, "limit": 10000})
    assert "pointer" not in [e["type"] for e in calm["events"]] and calm["next_seq"] is None
    assert len(calm["events"]) == len(seen) - 30
    whole = expert_ok(e01, "replay_events_get", {"visit_id": v})
    assert whole["events"][0]["type"] == "visit_started" and whole["events"][-1]["type"] == "log_closed"
    expert_error(e01, "replay_events_get", {"visit_id": v, "window_no": 99}, 404, "unknown_segment")
    expert_error(e01, "replay_events_get", {"visit_id": "f" * 32}, 404, "unknown_visit")
    expert_error(e01, "replay_events_get", {"visit_id": v, "limit": -1}, 400, "bad_request")


def test_when_the_study_does_not_log(client: TestClient, admin: Api, recordings: Path) -> None:
    admin.admin_ok("settings_update", {"settings": {"logging": {"interactions": False}}})
    a01 = Api(client, "A01")
    assert a01.ok("post", "/visits", {"client": {}})["visit_id"] is None
    save(a01, recordings, SUB1, [BLINK], None)
    idx = expert_ok(Api(client, "E01"), "replay_index_get", {"annotator_id": "A01", "recording_id": SUB1})
    assert idx["logging"] is False and idx["segments"] == [] and idx["saved"]["attempt"] == 1


def test_who_may_watch(client: TestClient, admin: Api, recordings: Path) -> None:
    a01, e01, t01 = Api(client, "A01"), Api(client, "E01"), Api(client, "T01")
    va = session(a01, SUB1, 1, S1)
    admin.admin_ok("assign", {"annotator_ids": ["E01"], "recording_ids": [SUB1]})
    ve = session(e01, SUB1, 1, S2, created=[BLINK])
    save(e01, recordings, SUB1, [BLINK], S2)
    assert expert_ok(e01, "replay_events_get", {"visit_id": ve, "window_no": 1})["events"]
    # experts and administrators replay anyone
    assert expert_ok(admin, "replay_index_get", {"annotator_id": "A01", "recording_id": SUB1})["segments"]
    expert_ok(e01, "replay_events_get", {"visit_id": va, "window_no": 1})
    # an annotator replays nobody, not even an expert who has not agreed
    expert_error(t01, "replay_index_get", {"annotator_id": "A01", "recording_id": SUB1}, 403, "forbidden")
    expert_error(t01, "replay_events_get", {"visit_id": va, "window_no": 1}, 403, "forbidden")
    expert_error(t01, "replay_index_get", {"annotator_id": "E01", "recording_id": SUB1}, 403, "forbidden")
    assert expert_ok(t01, "teaching_list") == {"shown": True, "sessions": []}
    # once the expert agrees, trainees may watch the expert's sessions, and only those
    expert_ok(e01, "replay_consent_set", {"teaching": True})
    teaching_sessions(client, admin, recordings, e01)
    listed = expert_ok(t01, "teaching_list")["sessions"]
    assert [(s["annotator_id"], s["recording_id"], s["mode"], s["context_id"], s["attempt"]) for s in listed] == [
        ("E01", GUIDED1, "practice", "example", 1)], "the guided training recording only: never a study recording"
    seg = expert_ok(t01, "replay_index_get", {"annotator_id": "E01", "recording_id": GUIDED1, "mode": "practice",
                                              "context_id": "example"})
    assert [s["attempt"] for s in seg["segments"]] == [1] and seg["saved"]["attempt"] == 1
    assert [a["label"] for a in seg["saved"]["annotations"]] == ["Eye-blink-artifact"]
    vt = seg["segments"][0]["visit_id"]
    assert expert_ok(t01, "replay_events_get", {"visit_id": vt, "window_no": 1})["events"]
    expert_error(t01, "replay_events_get", {"visit_id": vt}, 403, "forbidden")  # one segment at a time
    expert_error(t01, "replay_events_get", {"visit_id": va, "window_no": 1}, 403, "forbidden")
    # the study's settings: trainees no longer, then nobody
    admin.admin_ok("settings_update", {"settings": {"replay": {"trainees_watch_experts": False}}})
    expert_error(t01, "replay_index_get", {"annotator_id": "E01", "recording_id": GUIDED1, "mode": "practice",
                                           "context_id": "example"}, 403, "forbidden")
    assert expert_ok(t01, "teaching_list") == {"shown": False, "sessions": []}
    assert expert_ok(e01, "replay_index_get", {"annotator_id": "A01", "recording_id": SUB1})["segments"]
    admin.admin_ok("settings_update", {"settings": {"replay": {"enabled": False}}})
    expert_error(e01, "replay_index_get", {"annotator_id": "A01", "recording_id": SUB1}, 409, "replays_off")
    # the operations that are open to everyone still check what they are given
    expert_error(t01, "replay_index_get", {"annotator_id": "A01"}, 400, "bad_request")
    expert_error(t01, "replay_consent_get", {}, 403, "forbidden")


def teaching_sessions(client: TestClient, admin: Api, recordings: Path, e01: Api) -> None:
    """E01 annotates the example set's guided recording and its practice recording, in practice mode."""
    admin.admin_ok("assign", {"annotator_ids": ["E01"], "recording_ids": [GUIDED1, PRACTICE1], "mode": "practice",
                              "context_id": "example"})
    session(e01, GUIDED1, 1, "4" * 32, created=[BLINK], mode="practice", context_id="example")
    save(e01, recordings, GUIDED1, [BLINK], "4" * 32, mode="practice", context_id="example")
    session(e01, PRACTICE1, 1, "5" * 32, created=[EMG], mode="practice", context_id="example")
    save(e01, recordings, PRACTICE1, [EMG], "5" * 32, mode="practice", context_id="example")


def test_trainees_never_watch_an_expert_on_study_work(client: TestClient, admin: Api, recordings: Path) -> None:
    """Independence of annotations: a trainee or annotator never watches, nor reads the events of, an expert's
    session on a recording they hold or may be given as study work, nor on a practice or assessment recording."""
    from electrotag.web.manifest import SCOPE_STUDY, set_scope

    e01, a02, t01 = Api(client, "E01"), Api(client, "A02"), Api(client, "T01")
    admin.admin_ok("assign", {"annotator_ids": ["E01"], "recording_ids": [SUB2]})
    ve = session(e01, SUB2, 1, S2, created=[BLINK])
    save(e01, recordings, SUB2, [BLINK], S2)
    expert_ok(e01, "replay_consent_set", {"teaching": True})
    teaching_sessions(client, admin, recordings, e01)
    for who in (a02, t01):  # A02 holds SUB2 as study work; T01 may be given it once trained
        assert [s["recording_id"] for s in expert_ok(who, "teaching_list")["sessions"]] == [GUIDED1]
        r = expert_error(who, "replay_index_get", {"annotator_id": "E01", "recording_id": SUB2}, 403, "forbidden")
        assert "your own judgement" in r["message"]
        expert_error(who, "replay_events_get", {"visit_id": ve, "window_no": 1}, 403, "forbidden")
        expert_error(who, "replay_events_get", {"visit_id": ve}, 403, "forbidden")
        # the practice recording would give the practice's answers away
        expert_error(who, "replay_index_get", {"annotator_id": "E01", "recording_id": PRACTICE1, "mode": "practice",
                                               "context_id": "example"}, 403, "forbidden")
    # the same file registered in the study under another name: never shown for teaching
    store = client.app.state.store
    m = dict(store.manifest(set_scope("example"), GUIDED1))
    store.add_manifest({**m, "scope": SCOPE_STUDY, "recording_id": "sub-copy/eeg/sub-copy_task-example_eeg.vhdr"})
    assert expert_ok(t01, "teaching_list")["sessions"] == []
    expert_error(t01, "replay_index_get", {"annotator_id": "E01", "recording_id": GUIDED1, "mode": "practice",
                                           "context_id": "example"}, 403, "forbidden")
    # experts and administrators still replay every session
    assert expert_ok(admin, "replay_index_get", {"annotator_id": "E01", "recording_id": SUB2})["segments"]
    assert expert_ok(admin, "replay_events_get", {"visit_id": ve})["events"]


def test_a_teaching_recording_that_another_set_scores_trainees_on(client: TestClient, admin: Api, recordings: Path,
                                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    """A guided recording whose file another set uses for practice or assessment is never shown for teaching: a
    replay of it would give that set's answers away."""
    e01, t01 = Api(client, "E01"), Api(client, "T01")
    expert_ok(e01, "replay_consent_set", {"teaching": True})
    teaching_sessions(client, admin, recordings, e01)
    assert [s["recording_id"] for s in expert_ok(t01, "teaching_list")["sessions"]] == [GUIDED1]
    service = client.app.state.service
    asked = []

    def answer_sets(rid: str, scope: str = "study") -> list[tuple[str, str]]:
        asked.append((rid, scope))
        return [("other-set", "assessment")] if rid == GUIDED1 else []

    monkeypatch.setattr(service.training_path, "answer_sets", answer_sets)
    assert expert_ok(t01, "teaching_list")["sessions"] == []
    expert_error(t01, "replay_index_get", {"annotator_id": "E01", "recording_id": GUIDED1, "mode": "practice",
                                           "context_id": "example"}, 403, "forbidden")
    assert any(r == GUIDED1 for r, _s in asked)

