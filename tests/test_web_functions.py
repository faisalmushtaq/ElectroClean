"""The Firebase callables (electroclean/web/firebase/functions/main.py) with fake requests.

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

from electroclean.web.service import StudyService  # noqa: E402
from electroclean.web.store_files import FilesStore  # noqa: E402
from tests.web_helpers import GUIDED1, SUB1, ann, copy_demo, make_template, match_body, submission  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
MAIN = REPO / "electroclean" / "web" / "firebase" / "functions" / "main.py"
OPERATIONS = {"ec_me": "me", "ec_assignments": "assignments", "ec_match": "match", "ec_put_draft": "put_draft",
              "ec_delete_draft": "delete_draft", "ec_submit": "submit", "ec_training": "training",
              "ec_guided_get": "guided_get", "ec_guided_check": "guided_check",
              "ec_guided_continue": "guided_continue", "ec_guided_show_me": "guided_show_me",
              "ec_visit_open": "visit_open", "ec_visit_events": "visit_events", "ec_visit_close": "visit_close",
              "ec_admin_progress": "admin_progress", "ec_admin": "admin", "ec_quiz": "quiz"}


def load_main():
    spec = importlib.util.spec_from_file_location("electroclean_functions_main", MAIN)
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
        call(main, "ec_me", {"study": "demo"}, None)
    assert e.value.code.value == "unauthenticated" and e.value.details["error"] == "not_signed_in"
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "ec_me", {"study": "other"}, A01)
    assert e.value.code.value == "permission-denied" and e.value.details["error"] == "not_in_study"
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "ec_me", {"study": "demo"}, {**A01, "annotator_id": "Z99"})  # no account in the study
    assert e.value.details["error"] == "not_in_study"
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "ec_me", {"study": "../x"}, A01)
    assert e.value.code.value == "invalid-argument"
    me = call(main, "ec_me", {"study": "demo"}, A01)
    assert me["annotator_id"] == "A01" and me["study"]["study_id"] == "demo"


def test_the_same_json_as_the_server(main, template: Path) -> None:
    recordings = template / "recordings"
    a = call(main, "ec_assignments", {"study": "demo"}, A01)
    assert a["next"] == SUB1
    m = call(main, "ec_match", {"study": "demo", **match_body(recordings, SUB1)}, A01)
    assert m["status"] == "matched" and m["manifest"]["recording_id"] == SUB1
    blink = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
    d = call(main, "ec_put_draft", {"study": "demo", "recording_id": SUB1, "mode": "standard",
                                    "draft": {"annotations": [blink], "elapsed_s": 2.0}}, A01)
    assert d["saved_at"]
    r = call(main, "ec_submit", {"study": "demo", **submission(recordings, SUB1, [blink])}, A01)
    assert r["saved"] and r["attempt"] == 1
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "ec_submit", {"study": "demo", **submission(recordings, SUB1, [blink])}, A01)
    assert e.value.code.value == "already-exists" and e.value.details["error"] == "already_done"
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "ec_submit", {"study": "demo", **submission(recordings, "sub-002/eeg/sub-002_task-rest_eeg.vhdr",
                                                              [ann("c" * 32, "Nope", 1, 1)])}, A01)
    assert e.value.code.value == "failed-precondition" and e.value.details["error"] == "invalid_annotation"
    v = call(main, "ec_visit_open", {"study": "demo", "client": {"user_agent": "test"}}, A01)
    assert call(main, "ec_visit_events", {"study": "demo", "visit_id": v["visit_id"],
                                          "events": [{"t": 1.0, "type": "key"}]}, A01)["received"] == 1
    assert call(main, "ec_visit_close", {"study": "demo", "visit_id": v["visit_id"], "reason": "x"}, A01) == {}


def test_administrators_need_the_claim_and_the_account(main) -> None:
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "ec_admin_progress", {"study": "demo"}, A01)
    assert e.value.code.value == "permission-denied" and e.value.details["error"] == "forbidden"
    admin_claims = {"annotator_id": "ADMIN", "roles": {"demo": "admin"}, "studies": ["demo"], "role": "admin"}
    p = call(main, "ec_admin_progress", {"study": "demo"}, admin_claims)
    assert {a["annotator_id"] for a in p["annotators"]} == {"ADMIN", "A01", "A02", "T01"}
    # a claim alone is not enough: A01's account in the study is an annotator's
    with pytest.raises(https_fn.HttpsError):
        call(main, "ec_admin_progress", {"study": "demo"}, {**A01, "roles": {"demo": "admin"}, "role": "admin"})


def test_unexpected_errors_are_hidden(main, monkeypatch: pytest.MonkeyPatch) -> None:
    svc = main.service_for("demo")
    monkeypatch.setattr(svc, "me", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("secret details")))
    with pytest.raises(https_fn.HttpsError) as e:
        call(main, "ec_me", {"study": "demo"}, A01)
    assert e.value.code.value == "internal" and "secret" not in e.value.message


def test_a_guided_check_does_not_import_pandas_scipy_or_mne(template: Path, tmp_path: Path) -> None:
    """Cold starts: the guided coach's answers need neither pandas, SciPy nor MNE-Python."""
    study = copy_demo(template, tmp_path)
    code = f"""
import importlib.util, inspect, json, sys
sys.path.insert(0, {str(REPO)!r})
spec = importlib.util.spec_from_file_location("m", {str(MAIN)!r})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
from firebase_functions import https_fn
from electroclean.web.service import StudyService
from electroclean.web.store_files import FilesStore
svc = StudyService(FilesStore({str(study)!r}))
m.service_for = lambda study: svc
claims = {{"annotator_id": "T01", "roles": {{"demo": "annotator"}}, "studies": ["demo"]}}
def call(name, data):
    req = https_fn.CallableRequest(data={{"study": "demo", **data}}, raw_request=None,
                                   auth=https_fn.AuthData(uid="u", token=claims))
    return inspect.unwrap(getattr(m, name))(req)
call("ec_guided_get", {{"recording_id": {GUIDED1!r}}})
r = call("ec_guided_check", {{"recording_id": {GUIDED1!r}, "step": 1, "annotations": []}})
print(json.dumps({{"problems": r["problems"], "loaded": [x for x in ("pandas", "scipy", "mne") if x in sys.modules]}}))
"""
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    result = json.loads(out.stdout.strip().splitlines()[-1])
    assert result["problems"] == ["missing"]
    assert result["loaded"] == []
