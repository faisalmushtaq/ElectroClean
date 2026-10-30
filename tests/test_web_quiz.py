"""The short-segment quiz (POST /quiz/{set_id}) and its items in the admin area, on the ElectroTag server."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.training.quiz import item_order  # noqa: E402
from electrotag.training.reference import NONE_OPTION  # noqa: E402
from electrotag.web.app import create_app  # noqa: E402
from tests.web_helpers import GUIDED1, GUIDED2, PRACTICE1, Api, admin_audit, copy_demo, make_template  # noqa: E402


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("quiz-demo"))


@pytest.fixture
def study(template: Path, tmp_path: Path) -> Path:
    return copy_demo(template, tmp_path)


@pytest.fixture
def client(study: Path):
    app = create_app(study, demo=True)
    yield TestClient(app)
    app.state.store.close()


@pytest.fixture
def admin(client: TestClient) -> Api:
    return Api(client, "ADMIN")


ITEMS = [  # (recording, start, end, label)
    (GUIDED1, 4.0, 4.4, "Eye-blink-artifact"),
    (GUIDED1, 30.0, 30.5, "Electrode-pops-artifact"),
    (GUIDED2, 14.0, 17.0, "Chewing-artifact"),
    (GUIDED2, 1.0, 2.0, NONE_OPTION),
]


def add_items(admin: Api, set_id: str = "example") -> list[dict]:
    admin.admin_ok("set_update", {"set_id": set_id, "quiz": {"include_none_option": True}})
    out = []
    for rid, a, b, label in ITEMS:
        body = {"set_id": set_id, "recording_id": rid, "start_s": a, "end_s": b, "correct_label": label,
                "explanation": f"It is {label}."}
        if label == "Eye-blink-artifact":
            body["accepted_labels"] = ["Eye-artifact"]
        out.append(admin.admin_ok("quiz_item_add", body)["item"])
    return out


def test_quiz_items_in_the_admin_area(admin: Api, client: TestClient) -> None:
    admin.admin_error("quiz_item_add", {"set_id": "example", "recording_id": GUIDED1, "start_s": 1, "end_s": 2,
                                        "correct_label": NONE_OPTION}, 400, "bad_request")  # not offered yet
    items = add_items(admin)
    assert [it["item_id"] for it in items] == ["q01", "q02", "q03", "q04"]
    assert items[0]["accepted_labels"] == ["Eye-artifact"] and items[0]["context_s"] == 2.0
    listed = admin.admin_ok("quiz_items", {"set_id": "example"})["items"]
    assert [it["item_id"] for it in listed] == ["q01", "q02", "q03", "q04"]
    assert next(s for s in admin.admin_ok("sets_list")["sets"] if s["set_id"] == "example")["quiz_items"] == 4
    for bad, status, code in (
            ({"recording_id": "sub-001/eeg/sub-001_task-rest_eeg.vhdr"}, 404, "unknown_recording"),  # a study one
            ({"start_s": 5, "end_s": 4}, 400, "bad_request"),
            ({"end_s": 10_000}, 400, "bad_request"),
            ({"correct_label": "Not-a-label"}, 400, "bad_request"),
            ({"accepted_labels": ["Nope"]}, 400, "bad_request"),
            ({"context_s": 100}, 400, "bad_request"),
            ({"item_id": "../q"}, 400, "bad_request"),
            # the practice recording's reference is what trainees are scored against: never a quiz item
            ({"recording_id": PRACTICE1}, 422, "reveals_answers")):
        body = {"set_id": "example", "recording_id": GUIDED1, "start_s": 1.0, "end_s": 2.0,
                "correct_label": "EMG-artifact", **bad}
        admin.admin_error("quiz_item_add", body, status, code)
    # the none option cannot be taken away while an item needs it
    admin.admin_error("set_update", {"set_id": "example", "quiz": {"include_none_option": False}}, 400, "invalid_set")
    admin.admin_ok("quiz_item_remove", {"set_id": "example", "item_id": "q04"})
    admin.admin_error("quiz_item_remove", {"set_id": "example", "item_id": "q04"}, 404, "unknown_item")
    assert len(admin.admin_ok("quiz_items", {"set_id": "example"})["items"]) == 3
    assert {"quiz_item_add", "quiz_item_remove"} <= {e["op"] for e in admin_audit(admin)}


def test_the_quiz_with_feedback_after_each_answer(admin: Api, client: TestClient, study: Path) -> None:
    from electrotag.web.store_files import FilesStore

    add_items(admin)
    a01 = Api(client, "A01")
    quizzes = a01.ok("get", "/me")["quizzes"]
    assert quizzes == [{"set_id": "example", "name": quizzes[0]["name"], "n_items": 4, "n_answered": 0,
                        "finished": False, "feedback": "immediate"}]
    g = a01.quiz("example", {"action": "get"}).json()
    store = FilesStore(study)
    order = [it.item_id for it in item_order(store.reference_set("example").quiz_items, "A01", "example")]
    store.close()
    assert [it["item_id"] for it in g["items"]] == order  # the annotator's own order
    first = g["items"][0]
    assert first["file_name"].endswith(".vhdr") and NONE_OPTION in first["options"]
    assert "Eye-blink-artifact" in first["options"] and len(first["options"]) == 30
    assert "correct_label" not in json.dumps(g["items"])  # no answers before they are given
    assert set(g["recordings"]) == {GUIDED1, GUIDED2}
    assert g["recordings"][GUIDED1]["fingerprint"]["hex"] and g["answered"] == {} and g["finished"] is False
    assert g["feedback"] == "immediate" and g["score"] is None
    by_id = {it["item_id"]: it for it in admin.admin_ok("quiz_items", {"set_id": "example"})["items"]}
    # answers, with feedback at once
    r = a01.quiz("example", {"action": "answer", "item_id": "q01", "label": "Eye-artifact",
                             "response_time_s": 2.5}).json()
    assert r == {"correct": True, "correct_label": "Eye-blink-artifact", "explanation": "It is Eye-blink-artifact.",
                 "n_answered": 1, "n_items": 4}  # the group term is accepted
    again = a01.quiz("example", {"action": "answer", "item_id": "q01", "label": "Eye-artifact"})
    assert again.status_code == 200 and again.json()["n_answered"] == 1  # sent twice, kept once
    other = a01.quiz("example", {"action": "answer", "item_id": "q01", "label": "EMG-artifact"})
    assert other.status_code == 409 and other.json()["error"] == "already_answered"
    assert other.json()["label"] == "Eye-artifact"
    wrong = a01.quiz("example", {"action": "answer", "item_id": "q02", "label": "EMG-artifact"}).json()
    assert wrong["correct"] is False and wrong["correct_label"] == "Electrode-pops-artifact"
    assert a01.ok("get", "/me")["quizzes"][0]["n_answered"] == 2  # the quiz card says how far it went
    for body, status, code in (({"action": "answer", "item_id": "q99", "label": "EMG-artifact"}, 404, "unknown_item"),
                               ({"action": "answer", "item_id": "q03", "label": "Bad"}, 400, "bad_label"),
                               ({"action": "answer", "item_id": "q03", "label": "EMG-artifact",
                                 "response_time_s": -1}, 400, "bad_request"),
                               ({"action": "dance"}, 400, "bad_request")):
        r = a01.quiz("example", body)
        assert (r.status_code, r.json()["error"]) == (status, code), body
    assert a01.quiz("nope", {"action": "get"}).json()["error"] == "no_reference_set"
    g = a01.quiz("example", {"action": "get"}).json()
    assert g["answered"]["q01"] == {"label": "Eye-artifact", "correct": True, "correct_label": "Eye-blink-artifact",
                                    "explanation": "It is Eye-blink-artifact."}
    assert set(g["answered"]) == {"q01", "q02"}
    a01.quiz("example", {"action": "answer", "item_id": "q03", "label": "Chewing-artifact"})
    a01.quiz("example", {"action": "answer", "item_id": "q04", "label": NONE_OPTION})
    s = a01.quiz("example", {"action": "finish"}).json()["score"]
    assert (s["n_items"], s["n_answered"], s["n_correct"]) == (4, 4, 3) and s["proportion_correct"] == 0.75
    assert s["by_category"]["Electrode-pops-artifact"] == {"items": 1, "correct": 0}
    assert a01.quiz("example", {"action": "finish"}).json()["score"] == s  # finishing twice: one result
    assert a01.quiz("example", {"action": "answer", "item_id": "q01", "label": "Eye-blink-artifact"}).json()[
        "error"] == "finished"
    results = list((study / "Annotated_Events" / "training" / "example" / "quiz").glob("annotator-A01_quiz_*.json"))
    assert len(results) == 1 and "_quiz_practice_" in results[0].name
    saved = json.loads(results[0].read_text())
    assert saved["schema"] == "electrotag.quiz_result" and saved["completed"] is True
    assert [a["item_id"] for a in saved["answers"]] == order
    q01 = next(a for a in saved["answers"] if a["item_id"] == "q01")
    assert q01["response_time_s"] == 2.5 and q01["answer"] == "Eye-artifact" and "index" not in q01
    assert saved["score"]["n_correct"] == 3 and by_id["q01"]["recording_id"] == GUIDED1
    assert a01.ok("get", "/me")["quizzes"][0]["finished"] is True
    g = a01.quiz("example", {"action": "get"}).json()
    assert g["finished"] is True and g["score"] == s
    # the results zip includes it
    import base64
    import io
    import zipfile

    z = admin.admin_ok("results_zip")
    names = zipfile.ZipFile(io.BytesIO(base64.b64decode(z["base64"]))).namelist()
    assert any("/training/example/quiz/annotator-A01_quiz_" in n for n in names)


def test_the_quiz_with_feedback_at_the_end(admin: Api, client: TestClient, study: Path) -> None:
    add_items(admin)
    admin.admin_ok("set_update", {"set_id": "example", "quiz": {"feedback": "end"}})
    a02 = Api(client, "A02")
    g = a02.quiz("example", {"action": "get"}).json()
    assert g["feedback"] == "end"
    r = a02.quiz("example", {"action": "answer", "item_id": "q01", "label": "Eye-blink-artifact"}).json()
    assert r == {"correct": None, "correct_label": None, "explanation": None, "n_answered": 1, "n_items": 4}
    g = a02.quiz("example", {"action": "get"}).json()
    assert g["answered"] == {"q01": {"label": "Eye-blink-artifact", "correct": None}}
    s = a02.quiz("example", {"action": "finish"}).json()["score"]  # stopped early: marked incomplete
    assert (s["n_items"], s["n_answered"], s["n_correct"]) == (4, 1, 1)
    g = a02.quiz("example", {"action": "get"}).json()
    assert g["answered"]["q01"]["correct"] is True and g["answered"]["q01"]["correct_label"] == "Eye-blink-artifact"
    saved = json.loads(next((study / "Annotated_Events" / "training" / "example" / "quiz").glob(
        "annotator-A02_quiz_assessment_*.json")).read_text())
    assert saved["completed"] is False and saved["mode"] == "assessment"


def test_only_allowed_annotators_see_a_quiz(admin: Api, client: TestClient) -> None:
    add_items(admin)
    admin.admin_ok("set_update", {"set_id": "example", "allowed_annotators": ["T01"]})
    a01, t01 = Api(client, "A01"), Api(client, "T01")
    assert a01.ok("get", "/me")["quizzes"] == []
    r = a01.quiz("example", {"action": "get"})
    assert r.status_code == 403 and r.json()["error"] == "not_allowed"
    assert [q["set_id"] for q in t01.ok("get", "/me")["quizzes"]] == ["example"]
    assert t01.quiz("example", {"action": "get"}).status_code == 200
    # a set without items has no quiz
    admin.admin_ok("set_create", {"set_id": "empty"})
    assert a01.quiz("empty", {"action": "get"}).json()["error"] == "no_quiz"


def test_the_demonstration_offers_a_quiz(tmp_path: Path) -> None:
    """`electrotag-web demo` gives the example set three quiz segments, one per artifact type."""
    from electrotag.web.demo import build_demo
    from electrotag.web.store_files import FilesStore

    store = FilesStore(build_demo(tmp_path / "demo", say=lambda _m: None))
    try:
        items = store.reference_set("example").quiz_items
    finally:
        store.close()
    assert [i.item_id for i in items] == ["q01", "q02", "q03"]
    assert len({i.correct_label for i in items}) == 3
    assert all(i.end_s > i.start_s for i in items)
