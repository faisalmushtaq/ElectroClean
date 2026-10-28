"""The Firestore store, the administrator's Firebase commands and the Cloud Functions, on the emulators.

These tests need the Firebase Emulator Suite and are skipped without it. Run them with
``scripts/test_firebase_emulators.sh``, which starts the Auth, Firestore and Functions emulators
(the Python functions of electroclean/web/firebase/functions) and runs this file inside
``firebase emulators:exec``. With only ``FIRESTORE_EMULATOR_HOST`` set, the store and service tests
run and the sign-in and callable tests are skipped.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

import pytest

if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
    pytest.skip("needs the Firestore emulator (scripts/test_firebase_emulators.sh)", allow_module_level=True)
pytest.importorskip("google.cloud.firestore")

import httpx  # noqa: E402

from electroclean.web.cli import main as cli  # noqa: E402
from electroclean.web.errors import ApiError  # noqa: E402
from electroclean.web.firebase import firestore_client  # noqa: E402
from electroclean.web.service import StudyService  # noqa: E402
from electroclean.web.store import User, item_key  # noqa: E402
from electroclean.web.store_firestore import FirestoreStore  # noqa: E402
from tests.web_helpers import (  # noqa: E402
    GUIDED1,
    GUIDED2,
    PRACTICE1,
    SUB1,
    SUB3,
    ann,
    as_wire,
    make_template,
    match_body,
    reference_annotations,
    submission,
)

PROJECT = os.environ.get("GCLOUD_PROJECT") or "demo-electroclean"
AUTH = os.environ.get("FIREBASE_AUTH_EMULATOR_HOST")
FUNCTIONS = os.environ.get("ELECTROCLEAN_FUNCTIONS_URL")
PASSWORD = "electroclean-test"
REPO = Path(__file__).resolve().parents[1]
BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
EMG = ann("c" * 32, "EMG-artifact", 3000, 250, [])
A01, A02, T01, ADMIN = User("A01", "Annotator one"), User("A02"), User("T01", "Trainee"), User("ADMIN", "", "admin")


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("fs-demo"))


@pytest.fixture(scope="module")
def recordings(template: Path) -> Path:
    return template / "recordings"


def run_cli(*args: str) -> None:
    code = cli([*args, "--firebase-project", PROJECT])
    assert code == 0, args


def new_study(template: Path, with_users: bool = True) -> str:
    """A study set up with the administrator's commands, as docs/web/firebase.md describes."""
    sid = f"t{uuid.uuid4().hex[:10]}"
    run_cli("init-study", "--study", sid, "--name", "Firestore test")
    run_cli("register", str(template / "recordings" / "study"), "--study", sid)
    run_cli("register", str(template / "training-source"), "--study", sid)
    if with_users:
        store = FirestoreStore(firestore_client(PROJECT), sid)
        for u in (A01, A02, T01, ADMIN):
            if AUTH:
                email = f"{u.annotator_id.lower()}-{sid}@example.org"
                extra = ["--admin"] if u.is_admin else []
                run_cli("add-user", u.annotator_id, "--study", sid, "--email", email, "--password", PASSWORD,
                        "--name", u.display_name, *extra)
            else:
                store.put_user(u.annotator_id, display_name=u.display_name, role=u.role)
        run_cli("assign", "A01", "--all", "--study", sid)
        run_cli("assign", "A02", "--all", "--study", sid)
        run_cli("assign", "T01", "--programme", "example", "--study", sid)
    return sid


@pytest.fixture
def study(template: Path) -> str:
    return new_study(template)


@pytest.fixture
def service(study: str) -> StudyService:
    return StudyService(FirestoreStore(firestore_client(PROJECT), study))


def ok(service: StudyService, op: str, user: User, body: dict[str, Any] | None = None) -> dict[str, Any]:
    return service.call(op, user, body or {})


def err(service: StudyService, op: str, user: User, body: dict[str, Any]) -> ApiError:
    with pytest.raises(ApiError) as e:
        service.call(op, user, body)
    return e.value


# ------------------------------------------------------------ store + service
def test_annotators_work_and_results_are_kept(service: StudyService, recordings: Path) -> None:
    me = ok(service, "me", A01)
    assert me["annotator_id"] == "A01" and me["study"]["name"] == "Firestore test" and me["programme"] is None
    a = ok(service, "assignments", A01)
    assert [i["recording_id"] for i in a["items"]] == sorted(i["recording_id"] for i in a["items"])
    assert a["next"] and len(a["items"]) == 3
    m = ok(service, "match", A01, match_body(recordings, SUB3))
    assert m["status"] == "matched" and m["manifest"]["format"] == "edf"
    assert ok(service, "match", A01, match_body(recordings, GUIDED1))["status"] == "not_assigned"
    ok(service, "put_draft", A01, {"recording_id": SUB1, "mode": "standard",
                                   "draft": {"annotations": [BLINK], "elapsed_s": 4.0}})
    assert ok(service, "match", A01, match_body(recordings, SUB1))["draft"]["annotations"] == [BLINK]
    r = ok(service, "submit", A01, submission(recordings, SUB1, [BLINK, EMG]))
    assert r["saved"] and r["attempt"] == 1 and len(r["files"]) == 5
    assert ok(service, "match", A01, match_body(recordings, SUB1))["status"] == "done"
    assert err(service, "submit", A01, submission(recordings, SUB1, [BLINK])).code == "already_done"
    assert err(service, "submit", A01, submission(recordings, SUB3, [ann("d" * 32, "Nope", 1, 1)])).code == \
        "invalid_annotation"
    v = ok(service, "visit_open", A01, {"client": {"user_agent": "pytest"}})
    batch = [{"t": float(i), "type": "pointer", "x": i} for i in range(1, 2001)]
    assert ok(service, "visit_events", A01, {"visit_id": v["visit_id"], "events": batch})["received"] == 2000
    ok(service, "visit_close", A01, {"visit_id": v["visit_id"], "reason": "signed_out"})
    p = ok(service, "admin_progress", ADMIN)
    rows = {r["annotator_id"]: r for r in p["annotators"]}
    assert next(i for i in rows["A01"]["items"] if i["recording_id"] == SUB1)["status"] == "done"
    assert err(service, "admin_progress", A01, {}).code == "forbidden"


def finish_guided(service: StudyService, recordings: Path, rid: str) -> dict[str, Any]:
    steps = reference_annotations(service.store, "example", rid)
    mine = [as_wire(t, f"{i + 1:032x}") for i, t in enumerate(steps)]
    g = ok(service, "guided_get", T01, {"recording_id": rid})
    assert g["n_steps"] == len(steps)
    for i in range(1, len(steps) + 1):
        c = ok(service, "guided_check", T01, {"recording_id": rid, "step": i, "annotations": mine})
        assert c["can_continue"], c
        ok(service, "guided_continue", T01, {"recording_id": rid, "step": i})
    return ok(service, "submit", T01, submission(recordings, rid, mine, "guided", "example"))


def test_training_programme_on_firestore(service: StudyService, recordings: Path) -> None:
    tr = ok(service, "training", T01)
    assert [s["status"] for s in tr["stages"]] == ["available", "locked", "not_used"]
    steps = reference_annotations(service.store, "example", GUIDED1)
    early = as_wire(steps[0], "f" * 32)
    early["onset_sample"] -= 200
    early["duration_samples"] += 200
    c = ok(service, "guided_check", T01, {"recording_id": GUIDED1, "step": 1, "annotations": [early]})
    assert "start" in c["problems"]
    sm = ok(service, "guided_show_me", T01, {"recording_id": GUIDED1, "step": 1, "annotations": [early]})
    assert sm["replace"] == [early["annotation_id"]] and sm["annotation"]["label"] == steps[0].label
    r = finish_guided(service, recordings, GUIDED1)
    assert r["guided"]["summary"]["stars"] < r["guided"]["summary"]["max_stars"]  # Show me was used
    finish_guided(service, recordings, GUIDED2)
    tr = ok(service, "training", T01)
    assert tr["stages"][1]["status"] == "available" and tr["next"]["recording_id"] == PRACTICE1
    ref = reference_annotations(service.store, "example", PRACTICE1)
    r = ok(service, "submit", T01, submission(recordings, PRACTICE1, [as_wire(a, f"{i + 1:032x}")
                                                                     for i, a in enumerate(ref)],
                                              "practice", "example"))
    assert r["feedback"]["passed"] is True and len(r["feedback"]["reference"]) == len(ref)
    tr = ok(service, "training", T01)
    assert tr["stages"][1]["status"] == "completed" and tr["complete"]


def test_export_writes_the_files_store_layout(service: StudyService, recordings: Path, template: Path,
                                             tmp_path: Path) -> None:
    """Exported results are the files the ElectroClean server writes for the same work."""
    from electroclean.activity.logs import find_logs, read_visit_log
    from electroclean.app.io.naming import OutputLayout
    from electroclean.app.session.register import CompletionRegister
    from electroclean.reliability.cli import main as agreement
    from electroclean.web.store_files import FilesStore
    from tests.test_web_server import without_session
    from tests.web_helpers import copy_demo

    ok(service, "submit", A01, submission(recordings, SUB1, [BLINK, EMG]))
    ok(service, "submit", A01, submission(recordings, SUB3, [BLINK]))
    ok(service, "submit", A02, submission(recordings, SUB1, [ann("e" * 32, "Eye-blink-artifact", 510, 95,
                                                                 ["Fp1", "Fp2"])]))
    finish_guided(service, recordings, GUIDED1)
    v = ok(service, "visit_open", A01, {})
    ok(service, "visit_events", A01, {"visit_id": v["visit_id"], "events": [{"t": 1.0, "type": "key", "key": "1"}]})
    ok(service, "visit_close", A01, {"visit_id": v["visit_id"]})
    out = tmp_path / "export"
    assert cli(["export", "--firebase-project", PROJECT, "--study", service.store.study_id, "--to", str(out)]) == 0
    assert cli(["export", "--firebase-project", PROJECT, "--study", service.store.study_id, "--to", str(out)]) == 0
    layout = OutputLayout(out / "Annotated_Events")
    entries = CompletionRegister(layout).entries()
    assert len(entries) == 4  # exported twice, registered once
    # the same work on the ElectroClean server
    files = FilesStore(copy_demo(template, tmp_path / "server"))
    fsvc = StudyService(files)
    fsvc.call("submit", A01, submission(recordings, SUB1, [BLINK, EMG]))
    for rel in ("annotator-A01/sub-001/eeg/sub-001_task-rest_eeg_annotator-A01",):
        server = files.layout.root / rel
        exported = layout.root / rel
        assert Path(f"{exported}_events.tsv").read_bytes() == Path(f"{server}_events.tsv").read_bytes()
        for suffix in ("_events.json", "_annotations.json"):
            assert without_session(json.loads(Path(f"{exported}{suffix}").read_text())) == without_session(
                json.loads(Path(f"{server}{suffix}").read_text()))
    files.close()
    assert (layout.root / "training_progress" / "example" / "annotator-T01.json").is_file()
    logs = [read_visit_log(p) for p in find_logs([layout.root])]
    assert logs and all(log.header["client"] == "web" for log in logs)
    assert any(log.closed and [e["type"] for e in log.events] == ["visit_started", "key", "log_closed"]
               for log in logs)
    assert agreement([str(layout.root), "--out", str(tmp_path / "agreement"), "--no-html"]) == 0


def test_large_drafts_are_split_over_documents(service: StudyService) -> None:
    import random

    rng = random.Random(1)
    anns = [ann(f"{i:032x}", "EMG-artifact", rng.randrange(0, 14000), 10, ["Fp1"]) for i in range(20000)]
    for a in anns:
        a["note"] = os.urandom(16).hex()  # make it hard to compress
    ok(service, "put_draft", A01, {"recording_id": SUB1, "draft": {"annotations": anns, "elapsed_s": 1.0}})
    back = service.store.draft("A01", item_key(SUB1, "standard", ""))
    assert len(back["draft"]["annotations"]) == 20000


def test_a_guided_check_on_firestore_does_not_import_pandas(study: str) -> None:
    main_py = REPO / "electroclean" / "web" / "firebase" / "functions" / "main.py"
    code = f"""
import importlib.util, inspect, json, os, sys
sys.path.insert(0, {str(REPO)!r})
os.environ["GCLOUD_PROJECT"] = {PROJECT!r}
spec = importlib.util.spec_from_file_location("m", {str(main_py)!r})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
from firebase_functions import https_fn
claims = {{"annotator_id": "T01", "roles": {{{study!r}: "annotator"}}, "studies": [{study!r}]}}
def call(name, data):
    req = https_fn.CallableRequest(data={{"study": {study!r}, **data}}, raw_request=None,
                                   auth=https_fn.AuthData(uid="u", token=claims))
    return inspect.unwrap(getattr(m, name))(req)
call("ec_guided_get", {{"recording_id": {GUIDED1!r}}})
r = call("ec_guided_check", {{"recording_id": {GUIDED1!r}, "step": 1, "annotations": []}})
print(json.dumps({{"problems": r["problems"], "loaded": [x for x in ("pandas", "scipy", "mne") if x in sys.modules]}}))
"""
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120, env=os.environ)
    assert out.returncode == 0, out.stderr
    result = json.loads(out.stdout.strip().splitlines()[-1])
    assert result == {"problems": ["missing"], "loaded": []}


def test_admin_commands(template: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    sid = new_study(template, with_users=False)
    assert cli(["list", "--firebase-project", PROJECT, "--study", sid]) == 0
    listing = capsys.readouterr().out
    assert SUB1 in listing and "example" in listing
    assert cli(["init-study", "--firebase-project", PROJECT, "--study", sid]) == 2  # exists already
    bundle = tmp_path / "bundle.json"
    assert cli(["export-manifests", str(template / "recordings" / "study"), "--out", str(bundle)]) == 0
    sid2 = f"t{uuid.uuid4().hex[:10]}"
    run_cli("init-study", "--study", sid2)
    run_cli("import-manifests", str(bundle), "--study", sid2)
    assert len(FirestoreStore(firestore_client(PROJECT), sid2).manifests()) == 3
    cfg = tmp_path / "config.json"
    assert cli(["config", "--firebase-project", PROJECT, "--study", sid, "--api-key", "AIza-test",
                "--app-id", "1:2:web:3", "--out", str(cfg)]) == 0
    c = json.loads(cfg.read_text())
    assert c["study"] == sid and c["firebase"]["projectId"] == PROJECT and c["firebase"]["apiKey"] == "AIza-test"
    assert c["firebase"]["authDomain"] == f"{PROJECT}.firebaseapp.com" and c["functions_region"] == "europe-west2"


# ------------------------------------------------- sign-in, callables, rules
def sign_in(email: str, password: str = PASSWORD) -> str:
    r = httpx.post(f"http://{AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key",
                   json={"email": email, "password": password, "returnSecureToken": True})
    assert r.status_code == 200, r.text
    return r.json()["idToken"]


def callable_(name: str, data: dict[str, Any], token: str | None) -> tuple[int, dict[str, Any]]:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = httpx.post(f"{FUNCTIONS}/{name}", json={"data": data}, headers=headers, timeout=120)
    return r.status_code, r.json()


@pytest.mark.skipif(not (AUTH and FUNCTIONS), reason="needs the Auth and Functions emulators")
def test_callables_end_to_end(study: str, recordings: Path) -> None:
    token = sign_in(f"a01-{study}@example.org")
    status, body = callable_("ec_me", {"study": study}, token)
    assert status == 200 and body["result"]["annotator_id"] == "A01"
    assert body["result"]["display_name"] == "Annotator one"
    status, body = callable_("ec_me", {"study": study}, None)
    assert body["error"]["status"] == "UNAUTHENTICATED" and body["error"]["details"]["error"] == "not_signed_in"
    status, body = callable_("ec_me", {"study": "someone-elses"}, token)
    assert body["error"]["status"] == "PERMISSION_DENIED"
    _, body = callable_("ec_match", {"study": study, **match_body(recordings, SUB1)}, token)
    assert body["result"]["status"] == "matched"
    _, body = callable_("ec_submit", {"study": study, **submission(recordings, SUB1, [BLINK])}, token)
    assert body["result"]["saved"] is True
    _, body = callable_("ec_submit", {"study": study, **submission(recordings, SUB1, [BLINK])}, token)
    assert body["error"]["status"] == "ALREADY_EXISTS" and body["error"]["details"]["error"] == "already_done"
    _, body = callable_("ec_visit_open", {"study": study, "client": {"user_agent": "pytest"}}, token)
    vid = body["result"]["visit_id"]
    _, body = callable_("ec_visit_events", {"study": study, "visit_id": vid, "events": [{"t": 1, "type": "key"}]},
                        token)
    assert body["result"]["received"] == 1
    _, body = callable_("ec_admin_progress", {"study": study}, token)
    assert body["error"]["details"]["error"] == "forbidden"
    admin = sign_in(f"admin-{study}@example.org")
    _, body = callable_("ec_admin_progress", {"study": study}, admin)
    assert {a["annotator_id"] for a in body["result"]["annotators"]} == {"A01", "A02", "T01", "ADMIN"}
    trainee = sign_in(f"t01-{study}@example.org")
    _, body = callable_("ec_training", {"study": study}, trainee)
    assert body["result"]["next"]["recording_id"] == GUIDED1
    _, body = callable_("ec_guided_get", {"study": study, "recording_id": GUIDED1}, trainee)
    assert body["result"]["current"]["step"] == 1
    _, body = callable_("ec_guided_check", {"study": study, "recording_id": GUIDED1, "step": 1, "annotations": []},
                        trainee)
    assert body["result"]["problems"] == ["missing"]


@pytest.mark.skipif(not AUTH, reason="needs the Auth emulator")
def test_security_rules_keep_clients_out(study: str) -> None:
    """Browsers can read and write nothing in Firestore: only the functions (Admin SDK) can."""
    token = sign_in(f"a01-{study}@example.org")
    base = f"http://{os.environ['FIRESTORE_EMULATOR_HOST']}/v1/projects/{PROJECT}/databases/(default)/documents"
    paths = [f"studies/{study}", f"studies/{study}/users/A01", f"studies/{study}/manifests",
             f"studies/{study}/submissions", f"studies/{study}/reference_sets/example"]
    for auth in ({"Authorization": f"Bearer {token}"}, {}):
        for p in paths:
            r = httpx.get(f"{base}/{p}", headers=auth)
            assert r.status_code == 403, (p, r.status_code, r.text[:200])
        w = httpx.post(f"{base}/studies/{study}/users?documentId=EVIL", headers=auth,
                       json={"fields": {"role": {"stringValue": "admin"}}})
        assert w.status_code == 403
        d = httpx.delete(f"{base}/studies/{study}/users/A01", headers=auth)
        assert d.status_code == 403
