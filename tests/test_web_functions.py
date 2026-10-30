"""The Firebase callables (electrotag/web/firebase/functions/main.py) with fake requests.

The functions are run here without Firebase: the service behind them is given a study folder
(the files store), so these tests check who may call what, the error codes and the JSON, and that a
guided check does not import pandas, SciPy or MNE-Python. The same functions against the Firestore
emulator are in test_web_firestore.py.
"""

from __future__ import annotations

import importlib.util
import inspect
import json
import subprocess
import sys
from pathlib import Path

import pytest

https_fn = pytest.importorskip("firebase_functions.https_fn")

from electrotag.web.service import StudyService  # noqa: E402
from electrotag.web.store_files import FilesStore  # noqa: E402
from tests.web_helpers import GUIDED1, SUB1, ann, copy_demo, make_template, match_body, submission  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
MAIN = REPO / "electrotag" / "web" / "firebase" / "functions" / "main.py"
OPERATIONS = {"et_me": "me", "et_assignments": "assignments", "et_match": "match", "et_put_draft": "put_draft",
              "et_delete_draft": "delete_draft", "et_submit": "submit", "et_training": "training",
              "et_guided_get": "guided_get", "et_guided_check": "guided_check",
              "et_guided_continue": "guided_continue", "et_guided_show_me": "guided_show_me",
              "et_visit_open": "visit_open", "et_visit_events": "visit_events", "et_visit_close": "visit_close",
              "et_admin_progress": "admin_progress", "et_admin": "admin", "et_quiz": "quiz",
              "et_achievements": "achievements", "et_problem_report": "problem_report",
              "et_my_reviews": "my_reviews", "et_expert": "expert", "et_my_feedback": "my_feedback",
              "et_training_stage": "training_stage", "et_training_snippets": "training_snippets",
              "et_my_results": "my_results"}


def load_main():
    spec = importlib.util.spec_from_file_location("electrotag_functions_main", MAIN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("fn-demo"))


@pytest.fixture
def main(template: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    mod = load_main()
    store = FilesStore(copy_demo(template, tmp_path))
    service = StudyService(store)
    monkeypatch.setattr(mod, "service_for", lambda study: service)
    yield mod
    store.close()


def call(main, name: str, data: dict, claims: dict | None) -> object:
    fn = inspect.unwrap(getattr(main, name))
    auth = https_fn.AuthData(uid="uid-1", token=claims) if claims is not None else None
    return fn(https_fn.CallableRequest(data=data, raw_request=None, auth=auth))


A01 = {"annotator_id": "A01", "role": "annotator", "roles": {"demo": "annotator"}, "studies": ["demo"]}


def test_every_operation_is_a_callable_in_london(main) -> None:
    for name, op in OPERATIONS.items():
        fn = getattr(main, name)
        endpoint = fn.__firebase_endpoint__
        assert endpoint.callableTrigger is not None, name
        assert endpoint.region == ["europe-west2"] or endpoint.region is None, name
        assert op in StudyService.OPERATIONS
    assert set(StudyService.OPERATIONS) == set(OPERATIONS.values())


def test_callers_must_be_signed_in_members_of_the_study(main) -> None:
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "et_me", {"study": "demo"}, None)
    assert e.value.code.value == "unauthenticated" and e.value.details["error"] == "not_signed_in"
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "et_me", {"study": "other"}, A01)
    assert e.value.code.value == "permission-denied" and e.value.details["error"] == "not_in_study"
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "et_me", {"study": "demo"}, {**A01, "annotator_id": "Z99"})  # no account in the study
    assert e.value.details["error"] == "not_in_study"
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "et_me", {"study": "../x"}, A01)
    assert e.value.code.value == "invalid-argument"
    me = call(main, "et_me", {"study": "demo"}, A01)
    assert me["annotator_id"] == "A01" and me["study"]["study_id"] == "demo"


def test_the_same_json_as_the_server(main, template: Path) -> None:
    recordings = template / "recordings"
    a = call(main, "et_assignments", {"study": "demo"}, A01)
    assert a["next"] == SUB1
    m = call(main, "et_match", {"study": "demo", **match_body(recordings, SUB1)}, A01)
    assert m["status"] == "matched" and m["manifest"]["recording_id"] == SUB1
    blink = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
    d = call(main, "et_put_draft", {"study": "demo", "recording_id": SUB1, "mode": "standard",
                                    "draft": {"annotations": [blink], "elapsed_s": 2.0}}, A01)
    assert d["saved_at"]
    r = call(main, "et_submit", {"study": "demo", **submission(recordings, SUB1, [blink])}, A01)
    assert r["saved"] and r["attempt"] == 1
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "et_submit", {"study": "demo", **submission(recordings, SUB1, [blink])}, A01)
    assert e.value.code.value == "already-exists" and e.value.details["error"] == "already_done"
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "et_submit", {"study": "demo", **submission(recordings, "sub-002/eeg/sub-002_task-rest_eeg.vhdr",
                                                              [ann("c" * 32, "Nope", 1, 1)])}, A01)
    assert e.value.code.value == "failed-precondition" and e.value.details["error"] == "invalid_annotation"
    v = call(main, "et_visit_open", {"study": "demo", "client": {"user_agent": "test"}}, A01)
    assert call(main, "et_visit_events", {"study": "demo", "visit_id": v["visit_id"],
                                          "events": [{"t": 1.0, "type": "key"}]}, A01)["received"] == 1
    assert call(main, "et_visit_close", {"study": "demo", "visit_id": v["visit_id"], "reason": "x"}, A01) == {}


def test_administrators_need_the_claim_and_the_account(main) -> None:
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "et_admin_progress", {"study": "demo"}, A01)
    assert e.value.code.value == "permission-denied" and e.value.details["error"] == "forbidden"
    admin_claims = {"annotator_id": "ADMIN", "roles": {"demo": "admin"}, "studies": ["demo"], "role": "admin"}
    p = call(main, "et_admin_progress", {"study": "demo"}, admin_claims)
    assert {a["annotator_id"] for a in p["annotators"]} == {"ADMIN", "A01", "A02", "T01", "E01"}
    # a claim alone is not enough: A01's account in the study is an annotator's
    with pytest.raises(https_fn.HttpsError):
        call(main, "et_admin_progress", {"study": "demo"}, {**A01, "roles": {"demo": "admin"}, "role": "admin"})


ADMIN = {"annotator_id": "ADMIN", "roles": {"demo": "admin"}, "studies": ["demo"], "role": "admin"}


def test_the_admin_area_and_the_quiz_as_callables(main) -> None:
    endpoint = main.et_admin.__firebase_endpoint__
    assert endpoint.availableMemoryMb == 2048 and endpoint.timeoutSeconds == 540
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "et_admin", {"study": "demo", "op": "overview"}, A01)
    assert e.value.code.value == "permission-denied" and e.value.details["error"] == "forbidden"
    with pytest.raises(https_fn.HttpsError) as e:  # the claim alone is not enough
        call(main, "et_admin", {"study": "demo", "op": "overview"}, {**A01, "roles": {"demo": "admin"}})
    assert e.value.details["error"] == "forbidden"
    o = call(main, "et_admin", {"study": "demo", "op": "overview"}, ADMIN)
    assert o["counts"]["recordings"] == 3
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "et_admin", {"study": "demo", "op": "nothing"}, ADMIN)
    assert e.value.code.value == "not-found" and e.value.details["error"] == "not_found"
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "et_admin", {"study": "demo", "op": "user_update", "annotator_id": "ADMIN", "role": "annotator"},
             ADMIN)
    assert e.value.code.value == "already-exists" and e.value.details["error"] == "self"
    item = call(main, "et_admin", {"study": "demo", "op": "quiz_item_add", "set_id": "example",
                                   "recording_id": GUIDED1, "start_s": 4.0, "end_s": 4.4,
                                   "correct_label": "Eye-blink-artifact"}, ADMIN)["item"]
    g = call(main, "et_quiz", {"study": "demo", "set_id": "example", "action": "get"}, A01)
    assert [i["item_id"] for i in g["items"]] == [item["item_id"]] and GUIDED1 in g["recordings"]
    r = call(main, "et_quiz", {"study": "demo", "set_id": "example", "action": "answer", "item_id": item["item_id"],
                               "label": "Eye-blink-artifact"}, A01)
    assert r["correct"] is True
    assert call(main, "et_quiz", {"study": "demo", "set_id": "example", "action": "finish"}, A01)["score"][
        "n_correct"] == 1
    assert call(main, "et_me", {"study": "demo"}, A01)["quizzes"][0]["finished"] is True
    entries = call(main, "et_admin", {"study": "demo", "op": "audit", "limit": 5}, ADMIN)["entries"]
    assert entries[0]["op"] == "quiz_item_add" and entries[0]["by"] == "ADMIN"


def test_a_privileged_role_needs_both_the_claim_and_the_account(main) -> None:
    endpoint = main.et_expert.__firebase_endpoint__
    assert endpoint.availableMemoryMb == 1024 and endpoint.timeoutSeconds == 300
    e01 = {"annotator_id": "E01", "roles": {"demo": ["annotator", "expert"]}, "studies": ["demo"], "role": "expert"}
    got = call(main, "et_expert", {"study": "demo", "op": "replay_consent_get"}, e01)
    assert got["consent"]["teaching"] is False
    me = call(main, "et_me", {"study": "demo"}, e01)
    assert me["roles"] == ["expert", "annotator"] and me["role"] == "expert"
    # claims written before E01 was made an expert (the older single role): an annotator for now
    stale = {"annotator_id": "E01", "roles": {"demo": "annotator"}, "studies": ["demo"], "role": "annotator"}
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "et_expert", {"study": "demo", "op": "replay_consent_get"}, stale)
    assert e.value.code.value == "permission-denied" and e.value.details["error"] == "forbidden"
    assert call(main, "et_me", {"study": "demo"}, stale)["roles"] == ["annotator"]
    # a claim alone is not enough: A01's account in the study is an annotator's
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "et_expert", {"study": "demo", "op": "replay_consent_get"},
             {**A01, "roles": {"demo": ["annotator", "expert", "admin"]}})
    assert e.value.details["error"] == "forbidden"
    # an administrator may use every expert operation
    assert call(main, "et_expert", {"study": "demo", "op": "replay_consent_get"}, ADMIN)["consent"]["teaching"] is False
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "et_expert", {"study": "demo", "op": "nothing"}, ADMIN)
    assert e.value.code.value == "not-found"
    fb = call(main, "et_my_feedback", {"study": "demo"}, A01)
    assert fb["corrections"] == {"shown": True, "items": []}
    t01 = {"annotator_id": "T01", "roles": {"demo": ["annotator"]}, "studies": ["demo"], "role": "annotator"}
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "et_training_stage", {"study": "demo", "stage": "assessment", "action": "skip"}, t01)
    assert e.value.details["error"] == "cannot_skip"
    tr = call(main, "et_training_stage", {"study": "demo", "stage": "tour", "action": "done"}, t01)
    assert tr["stages"][0]["status"] == "completed" and tr["next"]["stage"] == "snippets"
    snippets = call(main, "et_training_snippets", {"study": "demo"}, t01)
    assert snippets["snippets"] and set(snippets["recordings"]) == {s["recording_id"] for s in snippets["snippets"]}


def test_unexpected_errors_are_hidden(main, monkeypatch: pytest.MonkeyPatch) -> None:
    svc = main.service_for("demo")
    monkeypatch.setattr(svc, "me", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("secret details")))
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "et_me", {"study": "demo"}, A01)
    assert e.value.code.value == "internal" and "secret" not in e.value.message


def test_a_guided_check_does_not_import_pandas_scipy_or_mne(template: Path, tmp_path: Path) -> None:
    """Cold starts: the guided coach's answers, and skipping a stage of the training path, need neither pandas,
    SciPy nor MNE-Python."""
    study = copy_demo(template, tmp_path)
    code = f"""
import importlib.util, inspect, json, sys
sys.path.insert(0, {str(REPO)!r})
spec = importlib.util.spec_from_file_location("m", {str(MAIN)!r})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
from firebase_functions import https_fn
from electrotag.web.service import StudyService
from electrotag.web.store_files import FilesStore
svc = StudyService(FilesStore({str(study)!r}))
m.service_for = lambda study: svc
claims = {{"annotator_id": "T01", "roles": {{"demo": "annotator"}}, "studies": ["demo"]}}
def call(name, data):
    req = https_fn.CallableRequest(data={{"study": "demo", **data}}, raw_request=None,
                                   auth=https_fn.AuthData(uid="u", token=claims))
    return inspect.unwrap(getattr(m, name))(req)
call("et_training_stage", {{"stage": "tour", "action": "skip"}})
call("et_training_stage", {{"stage": "snippets", "action": "skip"}})
call("et_guided_get", {{"recording_id": {GUIDED1!r}}})
r = call("et_guided_check", {{"recording_id": {GUIDED1!r}, "step": 1, "annotations": []}})
print(json.dumps({{"problems": r["problems"], "loaded": [x for x in ("pandas", "scipy", "mne") if x in sys.modules]}}))
"""
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    result = json.loads(out.stdout.strip().splitlines()[-1])
    assert result["problems"] == ["missing"]
    assert result["loaded"] == []
