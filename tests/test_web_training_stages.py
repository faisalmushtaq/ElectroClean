"""The five-stage training path on the server (electrotag/web/training_path.py, docs/web/api.md "Training
stages"): skipping, finishing and resuming stages, the competency gate of real study work, what the study team
does after an assessment, the snippets and the study team's own snippets. The stages' rules themselves are in
tests/test_training_stages.py."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.web.app import create_app  # noqa: E402
from tests.web_helpers import (  # noqa: E402
    GUIDED1,
    GUIDED2,
    PRACTICE1,
    SUB1,
    SUB2,
    Api,
    admin_audit,
    as_wire,
    copy_demo,
    make_template,
    match_body,
    reference_annotations,
    skip_to_guided,
    submission,
)

GATE_TEXT = "Your study recordings open once you pass the competency assessment"


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-stages"))


@pytest.fixture
def study(template: Path, tmp_path: Path) -> Path:
    return copy_demo(template, tmp_path)


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


def _client(study: Path):
    app = create_app(study, demo=True)
    return app, TestClient(app)


@pytest.fixture
def client(study: Path):
    app, c = _client(study)
    yield c
    app.state.store.close()


@pytest.fixture
def gated(study: Path):
    """The demonstration with an assessment in the example set (its practice recording, judged by event F1 of at
    least 0.8) and a study recording given to the trainee T01."""
    from electrotag.training.reference import ReferenceSet
    from electrotag.web.store_files import FilesStore

    store = FilesStore(study)
    rs = ReferenceSet.load(store.reference_set("example").directory)
    rs.set_use(PRACTICE1, "assessment")
    rs.set_criteria({"criteria": [{"metric": "event_f1", "threshold": 0.8, "scope": "overall"}],
                     "min_reference_events": 1})
    rs.save()
    store.assign("T01", [SUB1, SUB2])
    ref = reference_annotations(store, "example", PRACTICE1)
    store.close()
    app, c = _client(study)
    yield c, ref
    app.state.store.close()


def stage(tr: dict, key: str) -> dict:
    return next(s for s in tr["stages"] if s["key"] == key)


def finish_guided(api: Api, study: Path, recordings: Path, rid: str) -> None:
    from electrotag.web.store_files import FilesStore

    store = FilesStore(study)
    steps = reference_annotations(store, "example", rid)
    store.close()
    mine = [as_wire(t, f"{i + 1:032x}") for i, t in enumerate(steps)]
    for i in range(1, len(steps) + 1):
        api.ok("post", f"/training/guided/{rid}/check", {"step": i, "annotations": mine})
        api.ok("post", f"/training/guided/{rid}/continue", {"step": i})
    api.ok("post", "/submissions", submission(recordings, rid, mine, "guided", "example"))


def err(r, status: int, code: str) -> dict:
    assert (r.status_code, r.json().get("error")) == (status, code), r.text
    return r.json()


# ------------------------------------------------------------------ stage actions
def test_skip_done_and_resume_are_idempotent_and_kept_with_the_progress(client: TestClient, study: Path) -> None:
    t01 = Api(client, "T01")
    tr = t01.ok("get", "/training")
    assert [s["key"] for s in tr["stages"]] == ["tour", "snippets", "guided", "practice", "assessment"]
    assert tr["next"]["stage"] == "tour" and tr["next"]["recording_id"] is None
    assert stage(tr, "tour")["can_skip"] and not stage(tr, "snippets")["can_skip"]
    assert tr["gate"] == {"open": True, "reason": "", "message": ""}  # the example set has no assessment
    once = t01.ok("post", "/training/stage", {"stage": "tour", "action": "done"})
    twice = t01.ok("post", "/training/stage", {"stage": "tour", "action": "done"})
    assert once == twice and stage(once, "tour")["status"] == "completed" and once["next"]["stage"] == "snippets"
    err(t01.post("/training/stage", {"stage": "tour", "action": "skip"}), 409, "finished")
    err(t01.post("/training/stage", {"stage": "guided", "action": "skip"}), 409, "locked")
    err(t01.post("/training/stage", {"stage": "guided", "action": "done"}), 409, "not_done_here")
    a = t01.ok("post", "/training/stage", {"stage": "snippets", "action": "skip"})
    b = t01.ok("post", "/training/stage", {"stage": "snippets", "action": "skip"})
    assert a == b and stage(a, "snippets")["status"] == "skipped" and stage(a, "snippets")["can_resume"]
    assert stage(a, "guided")["status"] == "available" and a["next"]["recording_id"] == GUIDED1
    r = t01.ok("post", "/training/stage", {"stage": "snippets", "action": "resume"})
    assert stage(r, "snippets")["status"] == "available" and stage(r, "guided")["status"] == "locked"
    assert t01.ok("post", "/training/stage", {"stage": "snippets", "action": "resume"}) == r
    prog = json.loads((study / "Annotated_Events" / "training_progress" / "example" / "annotator-T01.json").read_text())
    assert [(e["event"], e["stage"]) for e in prog["events"]] == [
        ("stage_completed", "tour"), ("stage_skipped", "snippets"), ("stage_resumed", "snippets")]
    assert prog["events"][1]["policy"] == ["tour", "snippets", "guided", "practice"]
    err(t01.post("/training/stage", {"stage": "assessment", "action": "skip"}), 409, "cannot_skip")


def test_the_study_decides_what_may_be_skipped(client: TestClient) -> None:
    admin = Api(client, "ADMIN")
    admin.admin_ok("settings_update", {"settings": {"training": {"skippable": ["snippets"], "tour": True}}})
    t01 = Api(client, "T01")
    tr = t01.ok("get", "/training")
    assert not stage(tr, "tour")["can_skip"]
    body = err(t01.post("/training/stage", {"stage": "tour", "action": "skip"}), 409, "cannot_skip")
    assert "asks every trainee to do Find your way around" in body["message"]
    admin.admin_ok("settings_update", {"settings": {"training": {"tour": False, "snippets_quiz_required": True}}})
    tr = t01.ok("get", "/training")
    assert stage(tr, "tour")["status"] == "not_used" and tr["next"]["stage"] == "snippets"
    # the example set has a quiz in this test only when one is added: without one, nothing waits for it
    assert stage(t01.ok("post", "/training/stage", {"stage": "snippets", "action": "done"}), "snippets")["status"] \
        == "completed"


def test_the_snippets_stage_waits_for_its_recognition_check_when_the_study_asks(client: TestClient) -> None:
    admin = Api(client, "ADMIN")
    admin.admin_ok("settings_update", {"settings": {"training": {"snippets_quiz_required": True}}})
    admin.admin_ok("quiz_item_add", {"set_id": "example", "item_id": "q1", "recording_id": GUIDED1, "start_s": 3.9,
                                     "end_s": 4.5, "correct_label": "Eye-blink-artifact"})
    t01 = Api(client, "T01")
    t01.ok("post", "/training/stage", {"stage": "tour", "action": "skip"})
    sn = t01.ok("get", "/training/snippets")
    assert sn["quiz"] == {"n_items": 1, "finished": False, "required": True}
    err(t01.post("/training/stage", {"stage": "snippets", "action": "done"}), 409, "quiz_required")
    t01.ok("post", "/quiz/example", {"action": "answer", "item_id": "q1", "label": "Eye-blink-artifact"})
    t01.ok("post", "/quiz/example", {"action": "finish"})
    assert t01.ok("get", "/training/snippets")["quiz"]["finished"] is True
    tr = t01.ok("post", "/training/stage", {"stage": "snippets", "action": "done"})
    assert stage(tr, "snippets")["status"] == "completed"


# ---------------------------------------------------------------------- snippets
def test_snippets_come_with_their_manifests_and_never_from_practice_or_assessment(client: TestClient) -> None:
    t01 = Api(client, "T01")
    sn = t01.ok("get", "/training/snippets")
    assert sn["set_id"] == "example" and sn["snippets"]
    assert {s["recording_id"] for s in sn["snippets"]} == {GUIDED1, GUIDED2} == set(sn["recordings"])
    assert PRACTICE1 not in sn["recordings"]
    first = sn["snippets"][0]
    assert set(first) == {"snippet_id", "recording_id", "start_s", "end_s", "label", "explanation", "context_s",
                          "channels", "source"}
    assert first["source"]["kind"] == "guided" and first["explanation"]
    m = sn["recordings"][GUIDED1]
    assert m["fingerprint"]["hex"] and "ch_names" in m
    err(Api(client, "A01").get("/training/snippets"), 404, "no_programme")


def test_the_study_team_adds_and_removes_snippets(client: TestClient) -> None:
    admin = Api(client, "ADMIN")
    lst = admin.admin_ok("snippets_list", {"set_id": "example"})
    assert lst["snippets"] == [] and lst["guided"] and {r["recording_id"] for r in lst["recordings"]} == {GUIDED1,
                                                                                                         GUIDED2}
    body = {"set_id": "example", "recording_id": GUIDED2, "start_s": 14.0, "end_s": 17.0, "label": "Chewing-artifact",
            "explanation": "Rhythmic bursts on T7 and T8", "channels": ["T7", "T8"], "snippet_id": "chew"}
    one = admin.admin_ok("snippet_add", body)
    assert admin.admin_ok("snippet_add", body) == one  # sent twice: kept once
    assert one["snippet"]["source"] == {"kind": "added", "by": "ADMIN"}
    assert [s["snippet_id"] for s in admin.admin_ok("snippets_list", {"set_id": "example"})["snippets"]] == ["chew"]
    assert Api(client, "T01").ok("get", "/training/snippets")["snippets"][0]["snippet_id"] == "chew"
    admin.admin_error("snippet_add", {**body, "recording_id": PRACTICE1}, 422, "reveals_answers")
    admin.admin_error("snippet_add", {**body, "end_s": 13.0}, 400, "bad_request")
    admin.admin_error("snippet_add", {**body, "label": "Banana"}, 400, "bad_request")
    admin.admin_error("snippet_add", {**body, "channels": ["Nope"]}, 400, "bad_request")
    admin.admin_error("snippet_remove", {"set_id": "example", "snippet_id": "g-x"}, 409, "guided_snippet")
    # an expert supplies training material too, through the expert channel
    e01 = Api(client, "E01")
    r = e01.post("/expert/snippet_add", {**body, "snippet_id": None, "label": "EMG-artifact"})
    assert r.status_code == 200 and r.json()["snippet"]["snippet_id"] == "s01"
    assert e01.post("/expert/snippet_remove", {"set_id": "example", "snippet_id": "s01"}).json() == {}
    assert e01.post("/expert/snippet_remove", {"set_id": "example", "snippet_id": "s01"}).json() == {}  # gone already
    err(Api(client, "A01").post("/expert/snippets_list", {"set_id": "example"}), 403, "forbidden")
    ops = [e["op"] for e in admin_audit(admin)]
    assert ops[:3] == ["snippet_remove", "snippet_add", "snippet_add"] and ops.count("snippet_add") == 3


# ---------------------------------------------------------------------- the gate
def test_study_work_waits_for_the_assessment(gated, recordings: Path, study: Path) -> None:
    client, ref = gated
    t01 = Api(client, "T01")
    me = t01.ok("get", "/me")
    assert me["training_gate"]["open"] is False and me["training_gate"]["reason"] == "training_required"
    assert me["training_gate"]["message"].startswith(GATE_TEXT)
    items = {i["recording_id"]: i for i in t01.ok("get", "/assignments")["items"]}
    assert items[SUB1]["status"] == "locked" and items[SUB1]["locked"] == "training_required"
    a = t01.ok("get", "/assignments")
    assert a["next"] is None  # the tour comes first, and a locked recording is never next
    body = err(t01.post("/match", match_body(recordings, SUB1)), 403, "training_required")
    assert body["message"].startswith(GATE_TEXT) and "training path" in body["message"]
    err(t01.put(f"/drafts/{SUB1}", {"annotations": [], "elapsed_s": 1}), 403, "training_required")
    err(t01.post("/submissions", submission(recordings, SUB1, [])), 403, "training_required")
    err(t01.post("/problems", {"problem_id": "a" * 32, "recording_id": SUB1, "mode": "standard", "context_id": "",
                               "reason": "too_noisy", "outcome": "unusable", "where": "home"}),
        403, "training_required")
    # the trainee skips what may be skipped and takes the assessment, perfectly
    for s in ("tour", "snippets", "guided"):
        t01.ok("post", "/training/stage", {"stage": s, "action": "skip"})
    tr = t01.ok("get", "/training")
    assert stage(tr, "assessment")["status"] == "available" and tr["gate"]["open"] is False
    perfect = [as_wire(x, f"{i + 1:032x}") for i, x in enumerate(ref)]
    r = t01.ok("post", "/submissions", submission(recordings, PRACTICE1, perfect, "assessment", "example"))
    assert r["assessment"]["status"] == "met"
    me = t01.ok("get", "/me")
    assert me["training_gate"] == {"open": True, "reason": "", "message": ""}
    items = {i["recording_id"]: i for i in t01.ok("get", "/assignments")["items"]}
    assert items[SUB1]["status"] == "todo" and items[SUB1]["locked"] is None
    assert t01.ok("post", "/match", match_body(recordings, SUB1))["status"] == "matched"
    # the competency report names the stages skipped
    report = json.loads((study / "Annotated_Events" / "training" / "example" / "reports"
                         / "annotator-T01_competency_report.json").read_text())
    assert report["stages_skipped"] == ["tour", "snippets", "guided"]
    html = (study / "Annotated_Events" / "training" / "example" / "reports"
            / "annotator-T01_competency_report.html").read_text()
    assert "Stages skipped: Find your way around, Meet the artifacts, Learn with the experts." in html


def test_experts_admins_and_a_study_without_a_gate_never_wait(gated, recordings: Path) -> None:
    client, _ref = gated
    admin = Api(client, "ADMIN")
    admin.admin_ok("programme_set", {"annotator_id": "E01", "set_id": "example"})
    admin.admin_ok("assign", {"annotator_ids": ["E01"], "recording_ids": [SUB1]})
    e01 = Api(client, "E01")
    assert e01.ok("get", "/me")["training_gate"]["open"] is True
    assert {i["status"] for i in e01.ok("get", "/assignments")["items"] if i["mode"] == "standard"} == {"todo"}
    t01 = Api(client, "T01")
    assert t01.ok("get", "/me")["training_gate"]["open"] is False
    admin.admin_ok("settings_update", {"settings": {"training": {"gate": "off"}}})
    assert t01.ok("get", "/me")["training_gate"]["open"] is True
    assert t01.ok("post", "/match", match_body(recordings, SUB1))["status"] == "matched"
    # "completed": the assessment finished is enough, whatever its result
    admin.admin_ok("settings_update", {"settings": {"training": {"gate": "completed"}}})
    gate = t01.ok("get", "/me")["training_gate"]
    assert gate["open"] is False and "finished the competency assessment" in gate["message"]


def test_after_an_assessment_not_met_the_study_team_reopens_the_training(gated, recordings: Path) -> None:
    client, ref = gated
    admin = Api(client, "ADMIN")
    t01 = Api(client, "T01")
    admin.admin_error("training_reopen", {"annotator_id": "T01"}, 409, "not_finished")
    for s in ("tour", "snippets", "guided"):
        t01.ok("post", "/training/stage", {"stage": s, "action": "skip"})
    r = t01.ok("post", "/submissions", submission(recordings, PRACTICE1, [as_wire(ref[0], "1" * 32)], "assessment",
                                                  "example"))
    assert r["assessment"]["status"] == "not_met"
    gate = t01.ok("get", "/me")["training_gate"]
    assert gate["open"] is False and "did not meet the competency criteria yet" in gate["message"]
    g = admin.admin_ok("training_gate_get", {"annotator_id": "T01"})
    assert g["can_reopen"] and g["can_assign_set"] and g["skipped"] == ["tour", "snippets", "guided"]
    assert [e["event"] for e in g["events"]] == ["stage_skipped"] * 3
    admin.admin_error("training_reopen", {"annotator_id": "T01", "from": "assessment"}, 400, "bad_request")
    g = admin.admin_ok("training_reopen", {"annotator_id": "T01", "from": "guided"})
    assert g["can_reopen"] is False and g["events"][-1]["event"] == "training_reopened"
    assert admin_audit(admin)[0]["op"] == "training_reopen"
    tr = t01.ok("get", "/training")
    assert stage(tr, "guided")["status"] == "available"  # the skip before the reopening no longer counts
    assessment = stage(tr, "assessment")
    assert assessment["status"] == "locked" and "reopened your training" in assessment["detail"]
    assert t01.ok("get", "/me")["programme"]["complete"] is False
    # skip the guided stage again and retake the assessment, this time well: only the new save counts
    t01.ok("post", "/training/stage", {"stage": "guided", "action": "skip"})
    items = {(i["recording_id"], i["mode"]): i for i in t01.ok("get", "/assignments")["items"]}
    assert items[(PRACTICE1, "assessment")]["repeat"] is True and items[(PRACTICE1, "assessment")]["status"] == "todo"
    perfect = [as_wire(x, f"{i + 1:032x}") for i, x in enumerate(ref)]
    r = t01.ok("post", "/submissions", submission(recordings, PRACTICE1, perfect, "assessment", "example"))
    assert r["attempt"] == 2 and r["assessment"]["status"] == "met"
    assert t01.ok("get", "/me")["training_gate"]["open"] is True
    admin.admin_error("training_reopen", {"annotator_id": "T01"}, 409, "already_met")


def test_after_an_assessment_not_met_the_study_team_gives_a_new_assessment_set(gated, recordings: Path) -> None:
    client, ref = gated
    admin = Api(client, "ADMIN")
    t01 = Api(client, "T01")
    for s in ("tour", "snippets", "guided"):
        t01.ok("post", "/training/stage", {"stage": s, "action": "skip"})
    t01.ok("post", "/submissions", submission(recordings, PRACTICE1, [as_wire(ref[0], "1" * 32)], "assessment",
                                              "example"))
    # a second set, made from the study's own copy of a recording that A01 annotated
    a01 = Api(client, "A01")
    a01.ok("post", "/submissions", submission(recordings, SUB2, [as_wire(ref[0], "a" * 32)]))
    admin.admin_ok("set_create", {"set_id": "retake", "name": "Retake"})
    admin.admin_error("training_assessment_set", {"annotator_id": "T01", "set_id": "retake"}, 422, "no_assessment")
    admin.admin_ok("set_add_reference", {"set_id": "retake", "recording_id": SUB2, "use": "assessment",
                                         "recording_scope": "study",
                                         "source": {"kind": "annotator", "annotator_id": "A01"}})
    assert {s["set_id"] for s in admin.admin_ok("training_gate_get", {"annotator_id": "T01"})["assessment_sets"]} == {
        "retake"}
    admin.admin_error("training_assessment_set", {"annotator_id": "T01", "set_id": "example"}, 409, "same_set")
    g = admin.admin_ok("training_assessment_set", {"annotator_id": "T01", "set_id": "retake"})
    assert g["programme"]["set_id"] == "retake" and g["events"][-1]["event"] == "assessment_set_assigned"
    assert admin_audit(admin)[0]["op"] == "training_assessment_set"
    tr = t01.ok("get", "/training")
    assert [s["status"] for s in tr["stages"]] == ["completed"] * 4 + ["available"]
    assert stage(tr, "guided")["detail"] == "Done in Example training set (simulated)."
    assert tr["next"]["stage"] == "assessment" and t01.ok("get", "/me")["training_gate"]["open"] is False


def test_a_trainees_guided_recordings_open_only_once_the_first_stages_are_done(client: TestClient,
                                                                               recordings: Path) -> None:
    t01 = Api(client, "T01")
    assert t01.ok("post", "/match", match_body(recordings, GUIDED1))["status"] == "not_assigned"
    skip_to_guided(t01)
    assert t01.ok("post", "/match", match_body(recordings, GUIDED1))["mode"] == "guided"
