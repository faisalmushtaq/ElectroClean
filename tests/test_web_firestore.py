"""The Firestore store, the administrator's Firebase commands and the Cloud Functions, on the emulators.

These tests need the Firebase Emulator Suite and are skipped without it. Run them with
``scripts/test_firebase_emulators.sh``, which starts the Auth, Firestore and Functions emulators
(the Python functions of electrotag/web/firebase/functions) and runs this file inside
``firebase emulators:exec``. With only ``FIRESTORE_EMULATOR_HOST`` set, the store and service tests
run and the sign-in and callable tests are skipped.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import pytest

if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
    pytest.skip("needs the Firestore emulator (scripts/test_firebase_emulators.sh)", allow_module_level=True)
pytest.importorskip("google.cloud.firestore")

import httpx  # noqa: E402

from electrotag.web.cli import main as cli  # noqa: E402
from electrotag.web.errors import ApiError  # noqa: E402
from electrotag.web.firebase import firestore_client  # noqa: E402
from electrotag.web.service import StudyService  # noqa: E402
from electrotag.web.store import User, item_key  # noqa: E402
from electrotag.web.store_firestore import FirestoreStore  # noqa: E402
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

PROJECT = os.environ.get("GCLOUD_PROJECT") or "demo-electrotag"
AUTH = os.environ.get("FIREBASE_AUTH_EMULATOR_HOST")
FUNCTIONS = os.environ.get("ELECTROTAG_FUNCTIONS_URL")
PASSWORD = "electrotag-test"
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


def test_revisions_and_achievements_on_firestore(service: StudyService, recordings: Path, tmp_path: Path) -> None:
    ok(service, "submit", A01, submission(recordings, SUB1, [BLINK]))
    first = service.store.saved_files("A01", SUB1, "standard", "")
    m = ok(service, "match", A01, {**match_body(recordings, SUB1), "revise": True})
    assert m["status"] == "matched" and m["revision"]["version"] == 2 and len(m["revision"]["annotations"]) == 1
    ok(service, "put_draft", A01, {"recording_id": SUB1, "mode": "standard",
                                   "draft": {"annotations": [BLINK, EMG], "elapsed_s": 4.0}})
    item = next(i for i in ok(service, "assignments", A01)["items"] if i["recording_id"] == SUB1)
    assert item["status"] == "done" and item["revising"] is True and item["saved"]["version"] == 1
    assert err(service, "submit", A01, submission(recordings, SUB1, [EMG])).code == "already_done"
    r = ok(service, "submit", A01, {**submission(recordings, SUB1, [BLINK, EMG]), "revises": 1,
                                    "session": {**submission(recordings, SUB1, [])["session"], "viewed_fraction": 1.0}})
    assert r["attempt"] == 2 and r["revision"] == {"version": 2, "revises": 1}
    assert err(service, "submit", A01, {**submission(recordings, SUB1, [EMG]), "revises": 1}).code == "already_revised"
    entries = [e for e in service.store.completion_entries("A01") if e["recording_id"] == SUB1]
    assert sorted(e["output_basename"] for e in entries) == ["sub-001_task-rest_eeg_annotator-A01",
                                                             "sub-001_task-rest_eeg_annotator-A01_attempt-02"]
    latest = service.store.saved_files("A01", SUB1, "standard", "")
    assert all("_attempt-02" in n for n in latest) and not set(latest) & set(first)
    root = service.store.results_tree(tmp_path / "tree")  # both attempts are kept and exported
    assert len(list(root.rglob("sub-001_task-rest_eeg_annotator-A01*_annotations.json"))) == 2
    # achievements: the counters, the goal and a leaderboard too small to show
    ok(service, "submit", A02, submission(recordings, SUB1, [EMG]))
    out = ok(service, "achievements", A01, {"goal_per_week": 4, "leaderboard_hidden": False})
    assert out["counters"]["done"] == 1 and out["counters"]["annotations"] == 2 and out["goal"]["per_week"] == 4
    assert out["viewed_in_full"] == 1
    assert out["team"] == {"done": None, "assigned": None, "people": 2}  # it would give A02's figures away
    lb = out["leaderboard"]
    assert lb["people"] == 2 and lb["rows"] == [] and " " in lb["you"]["name"]
    again = StudyService(FirestoreStore(firestore_client(PROJECT), service.store.study_id))
    assert ok(again, "achievements", A01)["leaderboard"]["you"]["name"] == lb["you"]["name"]
    assert "A02" not in json.dumps(out)
    assert ok(service, "achievements", A02)["leaderboard"]["you"]["name"] != lb["you"]["name"]


def test_problem_reports_and_reviews_on_firestore(service: StudyService, recordings: Path, tmp_path: Path) -> None:
    import base64
    import io
    import zipfile

    report = {"problem_id": "1" * 32, "recording_id": SUB1, "mode": "standard", "reason": "bad_channels",
              "note": "Flat from 20 s", "outcome": "unusable", "where": "annotate"}
    assert ok(service, "problem_report", A01, report)["already"] is False
    assert ok(service, "problem_report", A01, report)["already"] is True  # sent twice: kept once
    item = next(i for i in ok(service, "assignments", A01)["items"] if i["recording_id"] == SUB1)
    assert item["status"] == "unusable" and item["problem"]["outcome"] == "unusable"
    assert ok(service, "match", A01, match_body(recordings, SUB1))["status"] == "unusable"
    assert err(service, "submit", A01, submission(recordings, SUB1, [BLINK])).code == "unusable"
    listed = ok(service, "admin", ADMIN, {"op": "problems_list"})
    assert listed["counts"] == {"open": 1, "resolved": 0, "unusable": 1} and listed["problems"][0]["unusable_now"]
    assert ok(service, "admin", ADMIN, {"op": "stats"})["totals"]["unusable"] == 1
    ok(service, "admin", ADMIN, {"op": "problem_return", "problem_id": "1" * 32, "note": "Replaced"})
    assert next(i for i in ok(service, "assignments", A01)["items"] if i["recording_id"] == SUB1)["status"] == "todo"
    # a review of saved work, kept apart from its files
    ok(service, "submit", A02, submission(recordings, SUB1, [BLINK, EMG]))
    files = service.store.saved_files("A02", SUB1, "standard", "")
    got = ok(service, "admin", ADMIN, {"op": "saved_attempt_get", "annotator_id": "A02", "recording_id": SUB1})
    assert got["attempt"] == 1 and len(got["annotations"]) == 2
    body = {"op": "review_save", "review_id": "2" * 32, "annotator_id": "A02", "recording_id": SUB1, "attempt": 1,
            "items": [{"annotation_id": BLINK["annotation_id"], "status": "caveat", "note": "Early"},
                      {"onset_sample": 6000, "duration_samples": 256, "status": "comment"}]}
    assert ok(service, "admin", ADMIN, body)["already"] is False
    assert ok(service, "admin", ADMIN, body)["already"] is True
    assert ok(service, "my_reviews", A02)["reviews"][0]["summary"] == "1 caveat, 1 comment"
    assert ok(service, "my_reviews", A01)["reviews"] == []
    assert service.store.saved_files("A02", SUB1, "standard", "") == files
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(ok(service, "admin", ADMIN, {"op": "results_zip"})["base64"])))
    names = z.namelist()
    assert "Annotated_Events/problem_reports/problem_reports.tsv" in names
    assert sum(1 for n in names if n.startswith("Annotated_Events/reviews/annotator-A02/")) == 2
    assert len(names) == len(set(names))


@pytest.mark.parametrize("one_after_the_other", [False, True])
def test_two_revisions_past_the_version_check_save_one_attempt_on_firestore(
        service: StudyService, recordings: Path, monkeypatch: pytest.MonkeyPatch, one_after_the_other: bool) -> None:
    from tests.web_helpers import race_revisions

    ok(service, "submit", A01, submission(recordings, SUB1, [BLINK]))
    first = service.store.saved_files("A01", SUB1, "standard", "")
    bodies = [{**submission(recordings, SUB1, anns), "revises": 1} for anns in ([BLINK, EMG], [EMG])]
    answers = race_revisions(service, A01, bodies, monkeypatch, one_after_the_other=one_after_the_other)
    saved = [a for a in answers if isinstance(a, dict)]
    refused = [a for a in answers if isinstance(a, ApiError)]
    assert len(saved) == 1 and saved[0]["attempt"] == 2 and len(refused) == 1, answers
    # The attempt's document is created only if it does not exist yet, and a save that starts after
    # another finished finds the attempt number taken.
    assert refused[0].status == 409 and refused[0].code in ("already_done", "already_revised")
    entries = [e for e in service.store.completion_entries("A01") if e["recording_id"] == SUB1]
    assert sorted(e["output_basename"] for e in entries) == ["sub-001_task-rest_eeg_annotator-A01",
                                                             "sub-001_task-rest_eeg_annotator-A01_attempt-02"]
    root_files = service.store.submission_files("A01")
    assert len(root_files) == 2 and service.store.saved_files("A01", SUB1, "standard", "") != first


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
    """Exported results are the files the ElectroTag server writes for the same work."""
    from electrotag.activity.logs import find_logs, read_visit_log
    from electrotag.app.io.naming import OutputLayout
    from electrotag.app.session.register import CompletionRegister
    from electrotag.reliability.cli import main as agreement
    from electrotag.web.store_files import FilesStore
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
    # the same work on the ElectroTag server
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


def test_a_late_draft_of_a_closed_session_is_refused_and_the_record_leaves_with_the_account(
        service: StudyService, study: str) -> None:
    body = {"recording_id": SUB1, "draft": {"annotations": [], "elapsed_s": 9.0, "session_id": "s-closed"}}
    ok(service, "put_draft", A01, body)
    ok(service, "delete_draft", A01, {"recording_id": SUB1, "session_id": "s-closed"})
    assert err(service, "put_draft", A01, body).code == "draft_discarded"
    key = item_key(SUB1, "standard", "")
    assert service.store.draft("A01", key) is None and key not in service.store.draft_keys("A01")
    ok(service, "put_draft", A01, {**body, "draft": {**body["draft"], "session_id": "s-next"}})
    assert service.store.draft("A01", key) is not None
    closed = service.store.doc.collection("draft_closed").document(f"A01_{key}")
    assert closed.get().to_dict()["sessions"] == ["s-closed"]
    firebase_service(study).store.remove_account("A01")  # the account leaves the study (with Authentication)
    assert not closed.get().exists


def test_large_drafts_are_split_over_documents(service: StudyService) -> None:
    import random

    rng = random.Random(1)
    anns = [ann(f"{i:032x}", "EMG-artifact", rng.randrange(0, 14000), 10, ["Fp1"]) for i in range(20000)]
    for a in anns:
        a["note"] = os.urandom(16).hex()  # make it hard to compress
    ok(service, "put_draft", A01, {"recording_id": SUB1, "draft": {"annotations": anns, "elapsed_s": 1.0}})
    back = service.store.draft("A01", item_key(SUB1, "standard", ""))
    assert len(back["draft"]["annotations"]) == 20000


def test_pieces_of_interrupted_writes_are_cleaned_up(service: StudyService, tmp_path: Path) -> None:
    import base64

    store = service.store
    key = item_key(SUB1, "standard", "")
    noise = base64.b64encode(os.urandom(2_000_000)).decode("ascii")  # does not compress: split over documents
    store.put_draft("A01", key, {"recording_id": SUB1, "saved_at": "now", "draft": {"annotations": [],
                                                                                  "noise": noise}})
    store.put_draft("A01", key, {"recording_id": SUB1, "saved_at": "later", "draft": {"annotations": [],
                                                                                    "noise": noise}})
    ref = store.doc.collection("drafts").document(f"A01_{key}")
    current = ref.get().to_dict()["chunk_prefix"]
    assert current and ref.get().to_dict()["chunks"] >= 2
    # the first version's chunks are young, so they wait for the clean-up: make them old
    for c in ref.collection("chunks").stream():
        if not c.id.startswith(current):
            c.reference.update({"written_at": 1.0})
    # what an instance stopped mid-write leaves: chunks of a document never written, and of an older version
    lost = store.doc.collection("submissions").document("A01_lost_01")
    lost.collection("chunks").document("0123456789ab-0000").set({"data": b"x", "prefix": "0123456789ab",
                                                                 "written_at": 1.0})
    ref.collection("chunks").document("ba9876543210-0000").set({"data": b"y", "prefix": "ba9876543210",
                                                                "written_at": 1.0})
    ref.collection("chunks").document("cccccccccccc-0000").set({"data": b"z", "prefix": "cccccccccccc",
                                                                "written_at": time.time()})  # a write in progress
    done = store.recover_interrupted()
    assert sorted(d["document"] for d in done) == sorted([f"drafts/A01_{key}", "submissions/A01_lost_01"])
    left = sorted(c.id for c in ref.collection("chunks").stream())
    assert "ba9876543210-0000" not in left and "cccccccccccc-0000" in left
    assert all(c.startswith((current, "cccccccccccc")) for c in left)
    assert not list(lost.collection("chunks").stream())
    back = store.draft("A01", key)  # the draft itself is intact
    assert back["saved_at"] == "later" and back["draft"]["noise"] == noise
    assert store.recover_interrupted() == []
    # the export cleans up too
    assert cli(["export", "--firebase-project", PROJECT, "--study", store.study_id, "--to", str(tmp_path / "x")]) == 0


def test_a_guided_check_on_firestore_does_not_import_pandas(study: str) -> None:
    main_py = REPO / "electrotag" / "web" / "firebase" / "functions" / "main.py"
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
call("et_guided_get", {{"recording_id": {GUIDED1!r}}})
r = call("et_guided_check", {{"recording_id": {GUIDED1!r}, "step": 1, "annotations": []}})
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


# ------------------------------------------------------------- the admin area
def admin_ok(service: StudyService, op: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    return service.call("admin", ADMIN, {"op": op, **(body or {})})


def admin_err(service: StudyService, op: str, body: dict[str, Any]) -> ApiError:
    with pytest.raises(ApiError) as e:
        service.call("admin", ADMIN, {"op": op, **body})
    return e.value


def test_the_admin_area_on_firestore(service: StudyService, recordings: Path, tmp_path: Path) -> None:
    from electrotag.synthetic import write_edf_recording
    from tests.web_helpers import build_manifests

    assert admin_err(service, "no_such_op", {}).code == "not_found"
    with pytest.raises(ApiError) as e:
        service.call("admin", A01, {"op": "overview"})
    assert e.value.code == "forbidden"
    o = admin_ok(service, "overview")
    assert o["counts"]["recordings"] == 3 and o["counts"]["admins"] == 1
    # settings, read afresh by the next call
    admin_ok(service, "settings_update", {"name": "Renamed", "settings": {"filters": {"notch_hz": 60.0}},
                                          "logging_notice": "Clicks and keys are recorded."})
    s = admin_ok(service, "settings_get")
    assert s["name"] == "Renamed" and s["settings"]["filters"]["notch_hz"] == 60.0
    assert admin_err(service, "settings_update", {"settings": {"selection": {"strategy": "x"}}}).code == \
        "invalid_settings"
    fresh = StudyService(FirestoreStore(firestore_client(PROJECT), service.store.study_id))
    assert ok(fresh, "me", A01)["study"]["logging_notice"] == "Clicks and keys are recorded."
    # recordings from the browser
    folder = tmp_path / "data"
    write_edf_recording(folder / "sub-201" / "eeg", "sub-201_task-rest", duration_s=10.0, seed=21)
    manifests = build_manifests(folder)
    r = admin_ok(service, "recordings_register", {"scope": "study", "manifests": manifests})
    rid = manifests[0]["recording_id"]
    assert r["added"] == [rid]
    rec = next(x for x in admin_ok(service, "recordings_list", {"scope": "study"})["recordings"]
               if x["recording_id"] == rid)
    assert rec["registered_via"] == "browser" and rec["registered_by"] == "ADMIN"
    admin_ok(service, "recording_update", {"scope": "study", "recording_id": rid, "retired": True, "notes": "x"})
    assert admin_ok(service, "assign", {"annotator_ids": ["A02"], "all": True})["retired"] == 1
    admin_ok(service, "recording_remove", {"scope": "study", "recording_id": rid})
    # work to analyse and to build references from
    ok(service, "submit", A01, submission(recordings, SUB1, [BLINK, EMG]))
    ok(service, "submit", A02, submission(recordings, SUB1, [ann("e" * 32, "Eye-blink-artifact", 510, 95,
                                                                 ["Fp1", "Fp2"])]))
    assert admin_err(service, "unassign", {"annotator_id": "A01", "recording_id": SUB1}).code == "done"
    admin_ok(service, "unassign", {"annotator_id": "A01", "recording_id": SUB3})
    assert SUB3 not in [i["recording_id"] for i in ok(service, "assignments", A01)["items"]]
    admin_ok(service, "set_create", {"set_id": "pilot", "name": "Pilot"})
    r = admin_ok(service, "set_add_reference", {"set_id": "pilot", "recording_id": SUB1, "use": "practice",
                                                "source": {"kind": "consensus", "annotator_ids": ["A01", "A02"]}})
    assert r["set"]["recordings"][0]["provenance"]["method"] == "consensus" and r["disagreements"]
    assert service.store.manifest("set:pilot", SUB1) is not None
    admin_ok(service, "set_update", {"set_id": "pilot", "criteria": {"criteria": [
        {"metric": "event_f1", "threshold": 0.5}]}, "quiz": {"feedback": "end"}})
    admin_ok(service, "quiz_item_add", {"set_id": "pilot", "recording_id": SUB1, "start_s": 1.0, "end_s": 2.0,
                                        "correct_label": "Eye-blink-artifact"})
    # the quiz
    g = service.call("quiz", A01, {"set_id": "pilot", "action": "get"})
    assert g["feedback"] == "end" and list(g["recordings"]) == [SUB1]
    service.call("quiz", A01, {"set_id": "pilot", "action": "answer", "item_id": "q01", "label": "EMG-artifact"})
    assert service.call("quiz", A01, {"set_id": "pilot", "action": "finish"})["score"]["n_correct"] == 0
    assert ok(service, "me", A01)["quizzes"] == [{"set_id": "pilot", "name": "Pilot", "n_items": 1,
                                                 "n_answered": 1, "finished": True, "feedback": "end"}]
    # analyses
    ag = admin_ok(service, "agreement", {})
    assert ag["summary"]["n_comparable_recordings"] == 1 and "events_summary.tsv" in ag["tables"]
    v = ok(service, "visit_open", A01, {})
    ok(service, "visit_events", A01, {"visit_id": v["visit_id"], "events": [{"t": 1.0, "type": "key"}]})
    ok(service, "visit_close", A01, {"visit_id": v["visit_id"]})
    assert "A01" in admin_ok(service, "activity", {})["tables"]["visits.tsv"]
    vs = admin_ok(service, "visits", {"annotator_id": "A01"})["visits"]
    assert vs[0]["visit_id"] == v["visit_id"] and vs[0]["n_events"] == 3
    assert admin_ok(service, "visits", {})["visits"][0]["visit_id"] == v["visit_id"]
    z = admin_ok(service, "results_zip", {})
    import base64
    import io
    import zipfile

    names = zipfile.ZipFile(io.BytesIO(base64.b64decode(z["base64"]))).namelist()
    assert any("/training/pilot/quiz/annotator-A01_quiz_assessment_" in n for n in names)
    # the audit log, newest first, in pages
    first = admin_ok(service, "audit", {"limit": 3})
    assert first["entries"][0]["op"] == "quiz_item_add" and first["next"]
    second = admin_ok(service, "audit", {"limit": 3, "before": first["next"]})
    assert second["entries"][0]["at"] <= first["entries"][-1]["at"]
    assert admin_err(service, "audit", {"before": "nonsense"}).code == "bad_request"
    # deleting a set others use is refused; an unused one goes, with its recordings
    assert admin_err(service, "set_delete", {"set_id": "pilot"}).code == "in_use"  # A01 finished its quiz
    admin_ok(service, "set_create", {"set_id": "spare"})
    admin_ok(service, "set_delete", {"set_id": "spare"})
    assert "spare" not in {x["set_id"] for x in admin_ok(service, "sets_list")["sets"]}


def test_the_example_set_without_mne_on_firestore(template: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """As in the functions, which do not include MNE-Python: the kept registrations are used."""
    import electrotag.web.example as example

    sid = f"t{uuid.uuid4().hex[:10]}"
    run_cli("init-study", "--study", sid)
    store = FirestoreStore(firestore_client(PROJECT), sid)
    store.put_user("ADMIN", role="admin")
    real = example.build_example
    monkeypatch.setattr(example, "build_example", lambda s, c, **_k: real(s, c, use_mne=False))
    svc = StudyService(store)
    r = admin_ok(svc, "set_example_create")
    assert r["recordings_zip"]["size_bytes"] > 1_000_000 and len(r["set"]["recordings"]) == 3
    assert all(x["registered"] for x in r["set"]["recordings"])
    assert admin_err(svc, "set_example_create", {}).code == "set_exists"
    store.put_user("T01")
    admin_ok(svc, "programme_set", {"annotator_id": "T01", "set_id": "example"})
    assert ok(svc, "guided_get", T01, {"recording_id": GUIDED1})["n_steps"] == 6


def firebase_service(study: str) -> StudyService:
    from electrotag.web.firebase import firebase_app

    return StudyService(FirestoreStore(firestore_client(PROJECT), study, auth_app=firebase_app(PROJECT)))


def oob_code(link: str) -> str:
    from urllib.parse import parse_qs, urlparse

    return parse_qs(urlparse(link).query)["oobCode"][0]


def choose_password(link: str, password: str) -> None:
    r = httpx.post(f"http://{AUTH}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=fake-key",
                   json={"oobCode": oob_code(link), "newPassword": password})
    assert r.status_code == 200, r.text


@pytest.mark.skipif(not AUTH, reason="needs the Auth emulator")
def test_accounts_with_firebase_authentication(study: str) -> None:
    from firebase_admin import auth

    from electrotag.web.firebase import firebase_app

    svc = firebase_service(study)
    app = firebase_app(PROJECT)
    email = f"a05-{study}@example.org"
    out = admin_ok(svc, "user_add", {"annotator_id": "A05", "display_name": "Five", "email": email})
    assert out["temporary_password"] is None and "oobCode" in out["invite_link"]
    assert out["user"]["email"] == email and out["user"]["status"] == "active"
    user = auth.get_user_by_email(email, app=app)
    assert user.custom_claims["annotator_id"] == "A05" and user.custom_claims["roles"] == {study: ["annotator"]}
    choose_password(out["invite_link"], "a-chosen-password")
    sign_in(email, "a-chosen-password")
    assert admin_err(svc, "user_add", {"annotator_id": "A05", "email": "other@example.org"}).code == "user_exists"
    assert admin_err(svc, "user_add", {"annotator_id": "A06"}).code == "email_required"
    assert admin_err(svc, "user_add", {"annotator_id": "A06", "email": email}).code == "email_in_use"
    with_password = admin_ok(svc, "user_add", {"annotator_id": "A06", "email": f"a06-{study}@example.org",
                                               "password": "another-password"})
    assert with_password["invite_link"] is None
    sign_in(f"a06-{study}@example.org", "another-password")
    # role, status, password link
    admin_ok(svc, "user_update", {"annotator_id": "A05", "role": "admin"})
    assert auth.get_user(user.uid, app=app).custom_claims["roles"] == {study: ["admin"]}
    admin_ok(svc, "user_update", {"annotator_id": "A05", "status": "disabled"})
    assert auth.get_user(user.uid, app=app).disabled is True
    assert svc.store.user("A05") is None  # the functions refuse the account at once
    r = httpx.post(f"http://{AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key",
                   json={"email": email, "password": "a-chosen-password", "returnSecureToken": True})
    assert r.status_code == 400 and "USER_DISABLED" in r.text
    admin_ok(svc, "user_update", {"annotator_id": "A05", "status": "active"})
    sign_in(email, "a-chosen-password")
    link = admin_ok(svc, "user_reset_password", {"annotator_id": "A05"})["invite_link"]
    choose_password(link, "a-newer-password")
    sign_in(email, "a-newer-password")
    assert admin_err(svc, "user_update", {"annotator_id": "ADMIN", "status": "disabled"}).code == "self"
    # leaving the study: the Firebase user goes too when it takes part in no other study
    admin_ok(svc, "user_remove", {"annotator_id": "A05"})
    with pytest.raises(auth.UserNotFoundError):
        auth.get_user(user.uid, app=app)
    assert "A05" not in {u["annotator_id"] for u in admin_ok(svc, "users_list")["users"]}
    log = admin_ok(svc, "audit", {"limit": 20})["entries"]
    assert {"user_add", "user_update", "user_reset_password", "user_remove"} <= {e["op"] for e in log}
    assert "oobCode" not in json.dumps(log) and "another-password" not in json.dumps(log)


def test_invitations_and_stats_on_firebase(study: str) -> None:
    svc = firebase_service(study)
    email = f"a08-{study}@example.org"
    out = admin_ok(svc, "user_add", {"annotator_id": "A08", "email": email, "invite": True})
    assert out["temporary_password"] is None and "oobCode" in out["invite_link"] and out["invite_token"] is None
    states = {u["annotator_id"]: u["invitation"] for u in admin_ok(svc, "users_list")["users"]}
    assert states["A08"]["state"] == "invited" and states["A08"]["expires_at"] is None
    again = admin_ok(svc, "user_invite", {"annotator_id": "A08"})
    assert "oobCode" in again["invite_link"] and again["invitation"]["state"] == "invited"
    choose_password(again["invite_link"], "an-invited-password")
    sign_in(email, "an-invited-password")
    # A Firebase link cannot be withdrawn; an account without an email address gets none.
    assert admin_err(svc, "user_invite_revoke", {"annotator_id": "A08"}).code == "cannot_revoke"
    admin_ok(svc, "user_update", {"annotator_id": "A08", "status": "disabled"})
    assert admin_err(svc, "user_invite", {"annotator_id": "A08"}).code == "disabled"
    log = admin_ok(svc, "audit", {"limit": 10})["entries"]
    assert "user_invite" in {e["op"] for e in log} and "oobCode" not in json.dumps(log)
    stats = admin_ok(svc, "stats")
    assert len(stats["days"]) == 30 and {"assigned", "done", "projection"} <= set(stats["totals"])
    assert "A08" in {p["annotator_id"] for p in stats["annotators"]}


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
    status, body = callable_("et_me", {"study": study}, token)
    assert status == 200 and body["result"]["annotator_id"] == "A01"
    assert body["result"]["display_name"] == "Annotator one"
    status, body = callable_("et_me", {"study": study}, None)
    assert body["error"]["status"] == "UNAUTHENTICATED" and body["error"]["details"]["error"] == "not_signed_in"
    status, body = callable_("et_me", {"study": "someone-elses"}, token)
    assert body["error"]["status"] == "PERMISSION_DENIED"
    _, body = callable_("et_match", {"study": study, **match_body(recordings, SUB1)}, token)
    assert body["result"]["status"] == "matched"
    _, body = callable_("et_submit", {"study": study, **submission(recordings, SUB1, [BLINK])}, token)
    assert body["result"]["saved"] is True
    _, body = callable_("et_submit", {"study": study, **submission(recordings, SUB1, [BLINK])}, token)
    assert body["error"]["status"] == "ALREADY_EXISTS" and body["error"]["details"]["error"] == "already_done"
    _, body = callable_("et_visit_open", {"study": study, "client": {"user_agent": "pytest"}}, token)
    vid = body["result"]["visit_id"]
    _, body = callable_("et_visit_events", {"study": study, "visit_id": vid, "events": [{"t": 1, "type": "key"}]},
                        token)
    assert body["result"]["received"] == 1
    _, body = callable_("et_admin_progress", {"study": study}, token)
    assert body["error"]["details"]["error"] == "forbidden"
    report = {"study": study, "problem_id": "3" * 32, "recording_id": SUB3, "mode": "standard",
              "reason": "too_noisy", "outcome": "noted"}
    _, body = callable_("et_problem_report", report, token)
    assert body["result"]["already"] is False, body
    _, body = callable_("et_problem_report", report, token)
    assert body["result"]["already"] is True
    _, body = callable_("et_my_reviews", {"study": study}, token)
    assert body["result"] == {"shown": True, "reviews": []}
    admin = sign_in(f"admin-{study}@example.org")
    _, body = callable_("et_admin_progress", {"study": study}, admin)
    assert {a["annotator_id"] for a in body["result"]["annotators"]} == {"A01", "A02", "T01", "ADMIN"}
    trainee = sign_in(f"t01-{study}@example.org")
    _, body = callable_("et_training", {"study": study}, trainee)
    assert body["result"]["next"]["recording_id"] == GUIDED1
    _, body = callable_("et_guided_get", {"study": study, "recording_id": GUIDED1}, trainee)
    assert body["result"]["current"]["step"] == 1
    _, body = callable_("et_guided_check", {"study": study, "recording_id": GUIDED1, "step": 1, "annotations": []},
                        trainee)
    assert body["result"]["problems"] == ["missing"]


@pytest.mark.skipif(not (AUTH and FUNCTIONS), reason="needs the Auth and Functions emulators")
def test_admin_and_quiz_callables(study: str) -> None:
    admin = sign_in(f"admin-{study}@example.org")
    annotator = sign_in(f"a01-{study}@example.org")
    _, body = callable_("et_admin", {"study": study, "op": "overview"}, annotator)
    assert body["error"]["status"] == "PERMISSION_DENIED" and body["error"]["details"]["error"] == "forbidden"
    status, body = callable_("et_admin", {"study": study, "op": "overview"}, admin)
    assert status == 200 and body["result"]["counts"]["recordings"] == 3
    _, body = callable_("et_admin", {"study": study, "op": "no_such_op"}, admin)
    assert body["error"]["status"] == "NOT_FOUND" and body["error"]["details"]["error"] == "not_found"
    # an account made through the functions, in the Auth emulator
    email = f"a07-{study}@example.org"
    _, body = callable_("et_admin", {"study": study, "op": "user_add", "annotator_id": "A07", "email": email}, admin)
    assert "oobCode" in body["result"]["invite_link"], body
    choose_password(body["result"]["invite_link"], "a-seventh-password")
    a07 = sign_in(email, "a-seventh-password")
    _, body = callable_("et_me", {"study": study}, a07)
    assert body["result"]["annotator_id"] == "A07" and body["result"]["quizzes"] == []
    # the quiz
    _, body = callable_("et_admin", {"study": study, "op": "quiz_item_add", "set_id": "example",
                                     "recording_id": GUIDED1, "start_s": 4.0, "end_s": 4.4,
                                     "correct_label": "Eye-blink-artifact"}, admin)
    item = body["result"]["item"]["item_id"]
    _, body = callable_("et_quiz", {"study": study, "set_id": "example", "action": "get"}, a07)
    assert [i["item_id"] for i in body["result"]["items"]] == [item]
    _, body = callable_("et_quiz", {"study": study, "set_id": "example", "action": "answer", "item_id": item,
                                    "label": "Eye-blink-artifact"}, a07)
    assert body["result"]["correct"] is True
    _, body = callable_("et_quiz", {"study": study, "set_id": "example", "action": "finish"}, a07)
    assert body["result"]["score"]["n_correct"] == 1
    # disabled in the admin area: refused at once, even with a token still valid
    _, body = callable_("et_admin", {"study": study, "op": "user_update", "annotator_id": "A07",
                                     "status": "disabled"}, admin)
    assert body["result"]["user"]["status"] == "disabled"
    _, body = callable_("et_me", {"study": study}, a07)
    assert body["error"]["details"]["error"] == "not_in_study"


@pytest.mark.skipif(not (AUTH and FUNCTIONS), reason="needs the Auth and Functions emulators")
def test_the_analyses_and_the_example_set_in_the_functions(study: str, recordings: Path) -> None:
    """In the functions' own environment: vendored code, matplotlib, no Qt and no MNE-Python."""
    import base64
    import io
    import zipfile

    service = StudyService(FirestoreStore(firestore_client(PROJECT), study))
    ok(service, "submit", A01, submission(recordings, SUB1, [BLINK, EMG]))
    ok(service, "submit", A02, submission(recordings, SUB1, [ann("e" * 32, "Eye-blink-artifact", 510, 95,
                                                                 ["Fp1", "Fp2"])]))
    v = ok(service, "visit_open", A01, {})
    ok(service, "visit_events", A01, {"visit_id": v["visit_id"], "events": [{"t": 1.0, "type": "key"}]})
    admin = sign_in(f"admin-{study}@example.org")
    status, body = callable_("et_admin", {"study": study, "op": "agreement"}, admin)
    assert status == 200, body
    assert "<img" in body["result"]["report_html"] and "events_summary.tsv" in body["result"]["tables"]
    _, body = callable_("et_admin", {"study": study, "op": "activity"}, admin)
    assert "A01" in body["result"]["tables"]["visits.tsv"]
    _, body = callable_("et_admin", {"study": study, "op": "results_zip"}, admin)
    names = zipfile.ZipFile(io.BytesIO(base64.b64decode(body["result"]["base64"]))).namelist()
    assert "Annotated_Events/completion_register.tsv" in names
    # the example set, made without MNE-Python from the kept registrations
    sid = f"t{uuid.uuid4().hex[:10]}"
    run_cli("init-study", "--study", sid)
    run_cli("add-user", "ADMIN", "--study", sid, "--email", f"admin-{sid}@example.org", "--password", PASSWORD,
            "--admin")
    admin2 = sign_in(f"admin-{sid}@example.org")
    status, body = callable_("et_admin", {"study": sid, "op": "set_example_create"}, admin2)
    assert status == 200, body
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(body["result"]["recordings_zip"]["base64"])))
    assert f"electrotag-example-set/{GUIDED1}" in z.namelist()
    _, body = callable_("et_admin", {"study": sid, "op": "audit", "limit": 1}, admin2)
    entry = body["result"]["entries"][0]
    assert entry["op"] == "set_example_create" and entry["details"]["registered_with"] == "template"


@pytest.mark.skipif(not AUTH, reason="needs the Auth emulator")
def test_security_rules_keep_clients_out(study: str) -> None:
    """Browsers can read and write nothing in Firestore: only the functions (Admin SDK) can."""
    token = sign_in(f"a01-{study}@example.org")
    base = f"http://{os.environ['FIRESTORE_EMULATOR_HOST']}/v1/projects/{PROJECT}/databases/(default)/documents"
    paths = [f"studies/{study}", f"studies/{study}/users/A01", f"studies/{study}/manifests",
             f"studies/{study}/submissions", f"studies/{study}/reference_sets/example", f"studies/{study}/problems",
             f"studies/{study}/reviews", f"studies/{study}/unusable", f"studies/{study}/derived",
             f"studies/{study}/tasks", f"studies/{study}/corrections", f"studies/{study}/adjudications",
             f"studies/{study}/gold", f"studies/{study}/users"]
    for auth in ({"Authorization": f"Bearer {token}"}, {}):
        for p in paths:
            r = httpx.get(f"{base}/{p}", headers=auth)
            assert r.status_code == 403, (p, r.status_code, r.text[:200])
        w = httpx.post(f"{base}/studies/{study}/users?documentId=EVIL", headers=auth,
                       json={"fields": {"role": {"stringValue": "admin"}}})
        assert w.status_code == 403
        w = httpx.patch(f"{base}/studies/{study}/users/A01?updateMask.fieldPaths=roles", headers=auth,
                        json={"fields": {"roles": {"arrayValue": {"values": [{"stringValue": "admin"}]}}}})
        assert w.status_code == 403  # nobody gives themselves a role from the browser
        d = httpx.delete(f"{base}/studies/{study}/users/A01", headers=auth)
        assert d.status_code == 403


# ------------------------------------------------------ roles, derived versions, visits (H1)
E01 = User("E01", "Expert one", roles=("annotator", "expert"))


def test_roles_are_kept_as_a_set_and_older_accounts_still_read(study: str) -> None:
    service = firebase_service(study)  # with Firebase Authentication when the emulator runs (the claims follow)
    store = service.store
    store.put_user("E01", display_name="Expert one", roles=["expert", "annotator"])
    assert store.user("E01").roles == ("expert", "annotator") and store.user("E01").role == "expert"
    rec = store.user_record("E01")
    assert rec["roles"] == ["expert", "annotator"] and rec["role"] == "expert"
    # an account written before roles became a set: its one role is its set, and the first change adds the list
    store.doc.collection("users").document("A02").update({"roles": firestore_delete()})
    assert store.user("A02").roles == ("annotator",) and store.user_record("A02")["roles"] == ["annotator"]
    store.update_account("A02", roles=("annotator", "expert"))
    d = store.doc.collection("users").document("A02").get().to_dict()
    assert d["roles"] == ["expert", "annotator"] and d["role"] == "expert"
    assert ok(service, "me", User("A02", roles=("annotator", "expert")))["roles"] == ["expert", "annotator"]
    out = admin_ok(service, "user_update", {"annotator_id": "A02", "roles": ["annotator"]})
    assert out["user"]["roles"] == ["annotator"]
    assert admin_err(service, "user_update", {"annotator_id": "ADMIN", "roles": ["expert"]}).code == "self"
    assert admin_err(service, "user_add", {"annotator_id": "P1", "roles": ["participant"],
                                           "email": "p1@example.org"}).code == "role_not_offered"
    assert ok(service, "expert", E01, {"op": "replay_consent_get"})["consent"]["teaching"] is False
    assert err(service, "expert", A01, {"op": "replay_consent_get"}).code == "forbidden"
    assert ok(service, "expert", E01, {"op": "replay_consent_set", "teaching": True})["changed"] is True
    assert admin_ok(service, "audit", {"limit": 1})["entries"][0]["op"] == "replay_consent_set"


def firestore_delete() -> Any:
    from google.cloud import firestore

    return firestore.DELETE_FIELD


def test_derived_versions_on_firestore(service: StudyService, recordings: Path, tmp_path: Path) -> None:
    from electrotag.app.io.naming import OutputLayout
    from electrotag.app.session.register import CompletionRegister
    from electrotag.reliability.config import AnalysisConfig
    from electrotag.reliability.data import load_dataset
    from tests.web_helpers import derived_maker

    store = service.store
    ok(service, "submit", A01, submission(recordings, SUB1, [BLINK]))
    ok(service, "submit", A01, {**submission(recordings, SUB1, [BLINK, EMG]), "revises": 1})
    one = store.save_derived("corrections", derived_maker(store, "A01", SUB1, [EMG]), elapsed_s=2, started_at="")
    two = store.save_derived("corrections", derived_maker(store, "A01", SUB1, [BLINK], by="E02"), elapsed_s=2,
                             started_at="")
    assert (one.attempt, two.attempt) == (1, 2) and len(one.files) == 5
    assert [e["recording_id"] for e in store.derived_entries("corrections", "A01")] == [SUB1, SUB1]
    assert store.derived_entries("adjudications") == []
    assert len([e for e in store.completion_entries("A01") if e["recording_id"] == SUB1]) == 2  # unchanged
    labels = lambda files: [a["label"] for a in json.loads(next(b for n, b in files.items()  # noqa: E731
                                                                if n.endswith("_annotations.json")))["annotations"]]
    assert labels(store.derived_files("corrections", "A01", SUB1)) == ["Eye-blink-artifact"]
    assert labels(store.derived_files("corrections", "A01", SUB1, attempt=1)) == ["EMG-artifact"]
    assert store.derived_files("corrections", "A01", SUB1, attempt=5) == {}
    assert len(labels(store.saved_files("A01", SUB1, "standard", "", attempt=2))) == 2
    assert labels(store.saved_files("A01", SUB1, "standard", "", attempt=1)) == ["Eye-blink-artifact"]
    # the analyses' tree and the export put them in derived/corrections, with a register of their own
    root = store.results_tree(tmp_path / "tree")
    tree = OutputLayout(root / "derived" / "corrections")
    assert len(CompletionRegister(tree).entries()) == 2
    assert {a for a in load_dataset([root], AnalysisConfig()).groups[SUB1].docs} == {"A01"}
    out = tmp_path / "export"
    assert cli(["export", "--firebase-project", PROJECT, "--study", store.study_id, "--to", str(out)]) == 0
    exported = OutputLayout(out / "Annotated_Events" / "derived" / "corrections")
    assert len(CompletionRegister(exported).entries()) == 2
    assert len(list((exported.root / "annotator-A01" / "sub-001" / "eeg").glob("*_annotations.json"))) == 2
    assert cli(["export", "--firebase-project", PROJECT, "--study", store.study_id, "--to", str(out)]) == 0
    assert len(CompletionRegister(exported).entries()) == 2  # exported twice, registered once


def test_visit_index_paging_and_the_gate_status_on_firestore(service: StudyService) -> None:
    store = service.store
    v = ok(service, "visit_open", A01, {"client": {}})["visit_id"]
    ok(service, "visit_events", A01, {"visit_id": v, "events": [
        {"t": 1.0, "type": "recording_opened", "recording": SUB1, "window_no": 1, "session_id": "a" * 32,
         "mode": "standard"}] + [{"t": 1.0 + i, "type": "key", "window_no": 1} for i in range(10)]})
    ok(service, "visit_events", A01, {"visit_id": v, "events": [
        {"t": 20.0, "type": "recording_finished", "recording": SUB1, "window_no": 1}]
        + [{"t": 21.0 + i, "type": "key"} for i in range(10)]})
    ok(service, "visit_close", A01, {"visit_id": v, "reason": "signed_out"})
    rows = store.visit_index(v)
    assert [(r["recording_id"], r["first_seq"], r["last_seq"], r["outcome"]) for r in rows] == [
        (SUB1, 2, 13, "finished")]
    seen, nxt = [], 0
    while nxt is not None:
        page = store.visit_log(v, from_seq=nxt, limit=7)  # pages that cross the batches
        assert page["header"]["visit_id"] == v and len(page["events"]) <= 7
        seen += [e["seq"] for e in page["events"]]
        nxt = page["next_seq"]
    assert seen == list(range(1, 25))
    store.doc.collection("visits").document(v).update({"recordings": firestore_delete()})  # an older visit
    assert [r["recording_id"] for r in store.visit_index(v)] == [SUB1]
    assert store.visit_index("f" * 32) == []
    # the competency status the gate reads, and assignments with a task
    assert store.report_status("example", "T01") == ""
    store.doc.collection("reports").document("example_T01").set({"status": "not_met", "status_text": "Not met"})
    assert store.report_status("example", "T01") == "not_met"
    assert store.assign("A02", [SUB1], task_id="t-000000000001") == 0  # assigned already: linked to the task
    assert [a.task_id for a in store.assignments("A02") if a.recording_id == SUB1] == ["t-000000000001"]


@pytest.mark.skipif(not AUTH, reason="needs the Auth emulator")
def test_role_claims_on_firebase(study: str) -> None:
    from firebase_admin import auth

    from electrotag.web.firebase import firebase_app

    svc = firebase_service(study)
    app = firebase_app(PROJECT)
    email = f"e01-{study}@example.org"
    out = admin_ok(svc, "user_add", {"annotator_id": "E01", "email": email, "roles": ["annotator", "expert"],
                                     "password": "an-expert-password"})
    assert out["user"]["roles"] == ["expert", "annotator"]
    user = auth.get_user_by_email(email, app=app)
    assert user.custom_claims["roles"] == {study: ["expert", "annotator"]} and user.custom_claims["role"] == "expert"
    admin_ok(svc, "user_update", {"annotator_id": "E01", "roles": ["annotator"]})
    assert auth.get_user(user.uid, app=app).custom_claims["roles"] == {study: ["annotator"]}
    if not FUNCTIONS:
        return
    admin_ok(svc, "user_update", {"annotator_id": "E01", "roles": ["annotator", "expert"]})
    token = sign_in(email, "an-expert-password")
    status, body = callable_("et_expert", {"study": study, "op": "replay_consent_get"}, token)
    assert status == 200 and body["result"]["consent"]["teaching"] is False, body
    _, body = callable_("et_me", {"study": study}, token)
    assert body["result"]["roles"] == ["expert", "annotator"]
    # taken away in the study: refused at once, although the token in hand still names the role
    admin_ok(svc, "user_update", {"annotator_id": "E01", "roles": ["annotator"]})
    _, body = callable_("et_expert", {"study": study, "op": "replay_consent_get"}, token)
    assert body["error"]["status"] == "PERMISSION_DENIED" and body["error"]["details"]["error"] == "forbidden"
    _, body = callable_("et_my_feedback", {"study": study}, token)
    assert body["result"]["corrections"] == {"shown": True, "items": []}
    annotator = sign_in(f"a01-{study}@example.org")
    _, body = callable_("et_expert", {"study": study, "op": "replay_consent_get"}, annotator)
    assert body["error"]["details"]["error"] == "forbidden"
