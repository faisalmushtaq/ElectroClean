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
from electrotag.web.store import StoreError, User, item_key  # noqa: E402
from electrotag.web.store_firestore import FirestoreStore  # noqa: E402
from tests.web_helpers import (  # noqa: E402
    GUIDED1,
    GUIDED2,
    PRACTICE1,
    SUB1,
    SUB2,
    SUB3,
    ann,
    as_wire,
    make_template,
    match_body,
    reference_annotations,
    skip_to_guided_in,
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
    # each version downloads as the annotator's own files, exactly as kept (GET /me/results)
    mine = ok(service, "my_results", A01, {"recording_id": SUB1})
    assert mine["version"] == 2 and {f["name"]: f["text"].encode() for f in mine["files"]} == latest
    v1 = ok(service, "my_results", A01, {"recording_id": SUB1, "version": 1})
    assert {f["name"]: f["text"].encode() for f in v1["files"]} == first
    assert err(service, "my_results", A02, {"recording_id": SUB1}).code == "not_saved"
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
    assert [s["status"] for s in tr["stages"]] == ["available", "locked", "locked", "locked", "not_used"]
    skip_to_guided_in(service, T01)
    tr = ok(service, "training", T01)
    assert [s["status"] for s in tr["stages"]] == ["skipped", "skipped", "available", "locked", "not_used"]
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
    assert tr["stages"][3]["status"] == "available" and tr["next"]["recording_id"] == PRACTICE1
    ref = reference_annotations(service.store, "example", PRACTICE1)
    r = ok(service, "submit", T01, submission(recordings, PRACTICE1, [as_wire(a, f"{i + 1:032x}")
                                                                     for i, a in enumerate(ref)],
                                              "practice", "example"))
    assert r["feedback"]["passed"] is True and len(r["feedback"]["reference"]) == len(ref)
    tr = ok(service, "training", T01)
    assert tr["stages"][3]["status"] == "completed" and tr["complete"]


def test_training_stages_and_the_gate_on_firestore(service: StudyService, recordings: Path) -> None:
    """The five-stage path on Firestore: skips kept with the progress, the gate on study work, the competency report
    naming the skipped stages, reopening after a result not met, and the snippets."""
    admin_ok(service, "set_recording_update", {"set_id": "example", "recording_id": PRACTICE1, "use": "assessment"})
    admin_ok(service, "set_update", {"set_id": "example", "criteria": {
        "criteria": [{"metric": "event_f1", "threshold": 0.8, "scope": "overall"}], "min_reference_events": 1}})
    admin_ok(service, "assign", {"annotator_ids": ["T01"], "recording_ids": [SUB1]})
    me = ok(service, "me", T01)
    assert me["training_gate"]["open"] is False and me["training_gate"]["reason"] == "training_required"
    items = {i["recording_id"]: i for i in ok(service, "assignments", T01)["items"]}
    assert items[SUB1]["status"] == "locked"
    assert err(service, "match", T01, match_body(recordings, SUB1)).code == "training_required"
    assert err(service, "submit", T01, submission(recordings, SUB1, [BLINK])).code == "training_required"
    # skips, sent twice, are kept once in the progress document
    for stage in ("tour", "tour", "snippets", "guided"):
        tr = ok(service, "training_stage", T01, {"stage": stage, "action": "skip"})
    assert [s["status"] for s in tr["stages"]] == ["skipped", "skipped", "skipped", "not_used", "available"]
    rs = service.store.reference_set("example")
    assert [e["stage"] for e in service.store.progress(rs, "T01").events] == ["tour", "snippets", "guided"]
    assert len(ok(service, "training_snippets", T01)["snippets"]) > 0
    # not met: the study team reopens the training, and a good retake opens study work
    ref = reference_annotations(service.store, "example", PRACTICE1)
    r = ok(service, "submit", T01, submission(recordings, PRACTICE1, [as_wire(ref[0], "1" * 32)], "assessment",
                                              "example"))
    assert r["assessment"]["status"] == "not_met"
    stored = [json.loads(blob["json"]) for set_id, aid, blob in service.store.reports()
              if (set_id, aid) == ("example", "T01")]
    assert stored and stored[0]["stages_skipped"] == ["tour", "snippets", "guided"]
    assert "Stages skipped: Find your way around, Meet the artifacts, Learn with the experts." in [
        blob["html"] for set_id, aid, blob in service.store.reports() if aid == "T01"][0]
    g = admin_ok(service, "training_reopen", {"annotator_id": "T01", "from": "guided"})
    assert g["events"][-1]["event"] == "training_reopened"
    # the round that ended is kept with its report; the reopened stage is done again, never skipped
    assert [(r["round"], r["status"]) for r in g["rounds"]] == [(1, "not_met")] and g["rounds"][0]["html"]
    assert err(service, "training_stage", T01, {"stage": "guided", "action": "skip"}).code == "reopened"
    for rid in (GUIDED1, GUIDED2):
        finish_guided(service, recordings, rid)
    perfect = [as_wire(a, f"{i + 1:032x}") for i, a in enumerate(ref)]
    r = ok(service, "submit", T01, submission(recordings, PRACTICE1, perfect, "assessment", "example"))
    assert r["attempt"] == 2 and r["assessment"]["status"] == "met"
    assert ok(service, "me", T01)["training_gate"]["open"] is True
    assert ok(service, "match", T01, match_body(recordings, SUB1))["status"] == "matched"


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
    skip_to_guided_in(service, T01)
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
call("et_training_stage", {{"stage": "tour", "action": "skip"}})
call("et_training_stage", {{"stage": "snippets", "action": "skip"}})
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
    # guided: a quiz item of a practice or assessment recording would give its answers away, and is refused
    r = admin_ok(service, "set_add_reference", {"set_id": "pilot", "recording_id": SUB1, "use": "guided",
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
    skip_to_guided_in(svc, T01)
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


def test_tasks_windows_and_known_answers_on_firestore(service: StudyService, recordings: Path) -> None:
    """docs/web/api.md, "Tasks, windows and known answers": the same as tests/test_web_tasks.py on Firestore."""
    import base64
    import io
    import zipfile

    for aid in ("A05", "A06"):
        service.store.put_user(aid, display_name=f"Annotator {aid}")
    a05, a06 = User("A05"), User("A06")
    p = admin_ok(service, "tasks_preview_get", {"recording_ids": [SUB1], "annotator_ids": ["A01", "A05"], "k": 2})
    assert p["tasks"][0]["holders"] == ["A01"] and p["assigned"] == 1
    whole = admin_ok(service, "tasks_create", {"request_id": "1" * 32, "recording_ids": [SUB1],
                                               "annotator_ids": ["A01", "A05"], "k": 2})["tasks"][0]
    again = admin_ok(service, "tasks_create", {"request_id": "1" * 32, "recording_ids": [SUB1],
                                               "annotator_ids": ["A01", "A05"], "k": 2})
    assert again["already"] is True and [t["task_id"] for t in again["tasks"]] == [whole["task_id"]]
    part = admin_ok(service, "tasks_create", {"request_id": "2" * 32, "recording_ids": [SUB3],
                                              "annotator_ids": ["A05", "A06"], "k": 2,
                                              "window": {"start_s": 20, "end_s": 40}})["tasks"][0]
    items = {i["recording_id"]: i for i in ok(service, "assignments", a05)["items"]}
    assert items[SUB1]["task"] == {"task_id": whole["task_id"], "window": None}
    assert items[SUB3]["task"]["window"] == {"start_sample": 2560, "end_sample": 5120, "start_s": 20.0, "end_s": 40.0}
    assert ok(service, "match", a05, match_body(recordings, SUB3))["task"] == items[SUB3]["task"]
    assert next(i for i in ok(service, "assignments", A01)["items"] if i["recording_id"] == SUB1)["task"]["task_id"] \
        == whole["task_id"], "A01 had SUB1 already: the assignment joins the task"
    outside = ann("c" * 32, "EMG-artifact", 100, 50)
    inside = ann("d" * 32, "EMG-artifact", 3000, 250)
    e = err(service, "put_draft", a05, {"recording_id": SUB3, "mode": "standard", "draft": {"annotations": [outside]}})
    assert e.code == "outside_window" and e.extra["annotation_ids"] == ["c" * 32]
    assert err(service, "submit", a05, submission(recordings, SUB3, [inside, outside])).code == "outside_window"
    ok(service, "submit", a05, submission(recordings, SUB3, [inside]))
    listed = {t["task_id"]: t for t in admin_ok(service, "tasks_list")["tasks"]}
    assert listed[part["task_id"]]["status"] == "collecting" and listed[part["task_id"]]["counts"]["saved"] == 1
    assert sorted(listed[part["task_id"]]["letters"].values()) == ["A", "B"]
    # changing and removing: saved work stays
    assert admin_err(service, "task_update", {"task_id": part["task_id"], "remove_annotator": "A05",
                                              "add_annotator": "A02"}).code == "has_results"
    assert admin_err(service, "task_remove", {"task_id": part["task_id"]}).code == "has_results"
    admin_ok(service, "task_remove", {"task_id": whole["task_id"]})
    a01 = next(i for i in ok(service, "assignments", A01)["items"] if i["recording_id"] == SUB1)
    assert a01["task"] is None, "A01 keeps SUB1, as before the task"
    assert all(i["recording_id"] != SUB1 for i in ok(service, "assignments", a05)["items"])
    # known answers, scored after the save
    ok(service, "submit", A02, submission(recordings, SUB2, [BLINK, EMG]))
    admin_ok(service, "set_create", {"set_id": "known", "name": "Known answers"})
    admin_ok(service, "set_add_reference", {"set_id": "known", "recording_id": SUB2, "use": "practice",
                                            "source": {"kind": "annotator", "annotator_id": "A02"}})
    gold = admin_ok(service, "tasks_create", {"request_id": "3" * 32, "recording_ids": [SUB2],
                                              "annotator_ids": ["A06"], "gold": {"set_id": "known"}})["tasks"][0]
    assert gold["status"] == "gold"
    ok(service, "submit", a06, submission(recordings, SUB2, [BLINK, EMG]))
    q = {r["annotator_id"]: r for r in admin_ok(service, "quality_list")["annotators"]}
    assert q["A06"]["n_gold"] == 1 and q["A06"]["mean_event_f1"] == 1.0
    z = admin_ok(service, "results_zip")
    names = zipfile.ZipFile(io.BytesIO(base64.b64decode(z["base64"]))).namelist()
    assert {"Annotated_Events/tasks/tasks.tsv", "Annotated_Events/tasks/gold_scores.tsv"} <= set(names)


@pytest.mark.skipif(not (AUTH and FUNCTIONS), reason="needs the Auth and Functions emulators")
def test_tasks_through_the_functions(study: str) -> None:
    admin = sign_in(f"admin-{study}@example.org")
    _, body = callable_("et_admin", {"study": study, "op": "tasks_preview_get", "all": True,
                                     "annotator_ids": ["A01", "A02"], "adopt": True}, admin)
    assert body["result"]["created"] == 3, body
    _, body = callable_("et_admin", {"study": study, "op": "tasks_create", "request_id": "4" * 32,
                                     "recording_ids": [SUB3], "annotator_ids": ["A01", "A02"], "adopt": True}, admin)
    tid = body["result"]["tasks"][0]["task_id"]
    a01 = sign_in(f"a01-{study}@example.org")
    _, body = callable_("et_assignments", {"study": study}, a01)
    linked = {i["recording_id"]: i["task"] for i in body["result"]["items"]}
    assert linked[SUB3] == {"task_id": tid, "window": None} and linked[SUB1] is None
    _, body = callable_("et_admin", {"study": study, "op": "tasks_list"}, a01)
    assert body["error"]["details"]["error"] == "forbidden"


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
    assert body["result"]["next"]["stage"] == "tour"
    # the training path's stages through their function: the tour skipped, the snippets finished
    _, body = callable_("et_training_stage", {"study": study, "stage": "tour", "action": "skip"}, trainee)
    assert body["result"]["stages"][0]["status"] == "skipped"
    _, body = callable_("et_training_stage", {"study": study, "stage": "assessment", "action": "skip"}, trainee)
    assert body["error"]["status"] == "ALREADY_EXISTS" and body["error"]["details"]["error"] == "cannot_skip"
    _, body = callable_("et_training_snippets", {"study": study}, trainee)
    assert body["result"]["snippets"] and body["result"]["recordings"]
    _, body = callable_("et_training_stage", {"study": study, "stage": "snippets", "action": "done"}, trainee)
    assert body["result"]["next"]["recording_id"] == GUIDED1
    _, body = callable_("et_me", {"study": study}, trainee)
    assert body["result"]["training_gate"]["open"] is True  # the example set has no assessment
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


# ------------------------------------------------------ corrections and replays (H2)
def _correction(recordings: Path, cid: str, annotations: list[dict[str, Any]], reasons: dict[str, str],
                attempt: int = 1) -> dict[str, Any]:
    sub = submission(recordings, SUB1, annotations)
    return {"correction_id": cid, "annotator_id": "A01", "recording_id": SUB1, "attempt": attempt,
            "annotations": annotations, "sha256": sub["sha256"], "session": sub["session"],
            "changes": [{"annotation_id": k, "reason": r} for k, r in reasons.items()]}


def test_corrections_and_replays_on_firestore(service: StudyService, recordings: Path, tmp_path: Path) -> None:
    from electrotag.app.io.naming import OutputLayout
    from electrotag.app.session.register import CompletionRegister

    store = service.store
    store.put_user("E01", display_name="Expert one", roles=["expert", "annotator"])
    sid = "5" * 32
    v = ok(service, "visit_open", A01, {"client": {}})["visit_id"]
    ctx = {"recording": SUB1, "window_no": 1}
    ok(service, "visit_events", A01, {"visit_id": v, "events": [
        {"t": 1.0, "type": "recording_opened", **ctx, "session_id": sid, "mode": "standard"},
        {"t": 2.0, "type": "annotation_created", **ctx, "annotations": [
            {"id": BLINK["annotation_id"], "label": BLINK["label"], "onset_s": 500 / 256, "offset_s": 600 / 256,
             "channels": BLINK["channels"]}]},
        {"t": 3.0, "type": "recording_finished", **ctx, "session_id": sid}]})
    sub = submission(recordings, SUB1, [BLINK, EMG])
    sub["session"]["session_id"] = sid
    ok(service, "submit", A01, sub)
    before = store.saved_files("A01", SUB1, "standard", "")
    body = _correction(recordings, "6" * 32, [{**BLINK, "label": "Eye-artifact"}],
                       {BLINK["annotation_id"]: "wrong_type", EMG["annotation_id"]: "not_artifact"})
    assert err(service, "expert", E01, {"op": "correction_save", **body, "changes": []}).code == "reason_missing"
    out = ok(service, "expert", E01, {"op": "correction_save", **body})
    assert out["already"] is False and out["correction"]["counts"] == {"added": 0, "removed": 1, "changed": 1}
    assert ok(service, "expert", E01, {"op": "correction_save", **body})["already"] is True
    assert [e["session_id"] for e in store.derived_entries("corrections", "A01")] == ["6" * 32]
    assert store.saved_files("A01", SUB1, "standard", "") == before, "the original never changes"
    got = ok(service, "expert", E01, {"op": "correction_get", "correction_id": "6" * 32})
    assert [a["label"] for a in got["annotations"]] == ["Eye-artifact"] and len(got["original"]) == 2
    fb = ok(service, "my_feedback", A01)["corrections"]["items"]
    assert [c["corrector_id"] for c in fb] == ["E01"] and fb[0]["changes"][0]["reason_text"] == "Wrong type"
    assert ok(service, "expert", A01, {"op": "my_correction_get", "correction_id": "6" * 32})["corrector_id"] == "E01"
    # the replay: the segment from the Firestore visit index, with the attempt by the session's ID
    idx = ok(service, "expert", E01, {"op": "replay_index_get", "annotator_id": "A01", "recording_id": SUB1})
    assert [(s["visit_id"], s["attempt"], s["outcome"]) for s in idx["segments"]] == [(v, 1, "finished")]
    page = ok(service, "expert", E01, {"op": "replay_events_get", "visit_id": v, "window_no": 1})
    assert [e["type"] for e in page["events"]] == ["recording_opened", "annotation_created", "recording_finished"]
    assert err(service, "expert", A01, {"op": "replay_index_get", "annotator_id": "A01",
                                        "recording_id": SUB1}).code == "forbidden"
    # an expert's session on a study recording is never shown to an annotator, even with the expert's consent
    ok(service, "expert", E01, {"op": "replay_consent_set", "teaching": True})
    assert ok(service, "expert", A01, {"op": "teaching_list"})["sessions"] == []
    assert err(service, "expert", A01, {"op": "replay_events_get", "visit_id": v}).code == "forbidden"
    # a second expert's correction of the same version: A01 is told the experts disagree, and shown neither
    store.put_user("E02", display_name="Expert two", roles=["expert"])
    e02 = User("E02", "Expert two", roles=("expert",))
    ok(service, "expert", e02, {"op": "correction_save", **_correction(
        recordings, "7" * 32, [BLINK], {EMG["annotation_id"]: "not_artifact"})})
    fb = ok(service, "my_feedback", A01)["corrections"]["items"]
    assert [(c["standing"], c["changes"]) for c in fb] == [("pending", [])]
    assert err(service, "expert", A01, {"op": "my_correction_get",
                                        "correction_id": "6" * 32}).code == "pending_adjudication"
    # the export writes the correction's tree
    root = store.results_tree(tmp_path / "tree")
    assert len(CompletionRegister(OutputLayout(root / "derived" / "corrections")).entries()) == 2


@pytest.mark.skipif(not (AUTH and FUNCTIONS), reason="needs the Auth and Functions emulators")
def test_a_correction_through_et_expert(study: str, recordings: Path) -> None:
    svc = firebase_service(study)
    email = f"e01-{study}@example.org"
    admin_ok(svc, "user_add", {"annotator_id": "E01", "email": email, "roles": ["annotator", "expert"],
                               "password": "an-expert-password"})
    a01 = sign_in(f"a01-{study}@example.org")
    _, body = callable_("et_submit", {"study": study, **submission(recordings, SUB1, [BLINK, EMG])}, a01)
    assert body["result"]["saved"] is True, body
    expert = sign_in(email, "an-expert-password")
    _, body = callable_("et_expert", {"study": study, "op": "work_list"}, expert)
    assert [(i["annotator_id"], i["attempt"]) for i in body["result"]["items"]] == [("A01", 1)], body
    req = {"study": study, "op": "correction_save",
           **_correction(recordings, "7" * 32, [BLINK], {EMG["annotation_id"]: "not_artifact"})}
    _, body = callable_("et_expert", req, expert)
    assert body["result"]["correction"]["counts"]["removed"] == 1 and body["result"]["already"] is False, body
    _, body = callable_("et_expert", req, expert)
    assert body["result"]["already"] is True
    _, body = callable_("et_expert", {**req, "correction_id": "8" * 32, "changes": []}, expert)
    assert body["error"]["details"]["error"] == "reason_missing"
    assert body["error"]["details"]["annotation_ids"] == [EMG["annotation_id"]]
    _, body = callable_("et_my_feedback", {"study": study}, a01)
    assert body["result"]["corrections"]["items"][0]["correction_id"] == "7" * 32
    _, body = callable_("et_expert", {"study": study, "op": "my_correction_get", "correction_id": "7" * 32}, a01)
    assert len(body["result"]["original"]) == 2
    _, body = callable_("et_expert", {"study": study, "op": "correction_get", "correction_id": "7" * 32}, a01)
    assert body["error"]["details"]["error"] == "forbidden"


def test_everyones_marks_on_firestore(service: StudyService, recordings: Path) -> None:
    """overlay_get reads everyone's latest saved version from Firestore, with the correction offered as a lane."""
    store = service.store
    store.put_user("E01", display_name="Expert one", roles=["expert", "annotator"])
    ok(service, "submit", A01, submission(recordings, SUB1, [EMG]))
    ok(service, "submit", A01, {**submission(recordings, SUB1, [BLINK, EMG]), "revises": 1})
    ok(service, "expert", E01, {"op": "correction_save", **_correction(
        recordings, "9" * 32, [BLINK], {EMG["annotation_id"]: "not_artifact"}), "attempt": 2})
    got = ok(service, "expert", E01, {"op": "overlay_get", "recording_id": SUB1, "include": ["corrected"],
                                      "detail": ["A01"]})
    assert [(p["annotator_id"], p["attempt"], p["n_marks"]) for p in got["people"]] == [("A01", 2, 2)]
    assert got["people"][0]["ids"] == [BLINK["annotation_id"], EMG["annotation_id"]]
    assert [(d["annotator_id"], d["n_marks"]) for d in got["derived"]] == [("A01~E01", 1)]
    assert got["crowd"]["n_people"] == 1 and got["labels"] == ["Eye-blink-artifact", "EMG-artifact"]
    assert err(service, "expert", A01, {"op": "overlay_get", "recording_id": SUB1}).code == "forbidden"


@pytest.mark.skipif(not (AUTH and FUNCTIONS), reason="needs the Auth and Functions emulators")
def test_everyones_marks_through_et_expert(study: str, recordings: Path) -> None:
    svc = firebase_service(study)
    email = f"e01-{study}@example.org"
    admin_ok(svc, "user_add", {"annotator_id": "E01", "email": email, "roles": ["annotator", "expert"],
                               "password": "an-expert-password"})
    a01 = sign_in(f"a01-{study}@example.org")
    _, body = callable_("et_submit", {"study": study, **submission(recordings, SUB1, [BLINK, EMG])}, a01)
    assert body["result"]["saved"] is True, body
    _, body = callable_("et_expert", {"study": study, "op": "overlay_get", "recording_id": SUB1}, a01)
    assert body["error"]["details"]["error"] == "forbidden"
    expert = sign_in(email, "an-expert-password")
    _, body = callable_("et_expert", {"study": study, "op": "overlay_get", "recording_id": SUB1}, expert)
    got = body["result"]
    assert [(p["annotator_id"], p["n_marks"]) for p in got["people"]] == [("A01", 2)], body
    assert got["sets"] == ["", "0-1"] and got["crowd"]["n_people"] == 1


# ------------------------------------------------------ adjudication and the library (H4)
DISAGREE = ([ann("a" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"]), ann("b" * 32, "EMG-artifact", 3000, 250),
             ann("c" * 32, "Eye-blink-artifact", 5000, 100)],
            [ann("d" * 32, "Eye-movement-artifact", 500, 100, ["Fp1", "Fp2"]), ann("e" * 32, "EMG-artifact", 3000, 250),
             ann("f" * 32, "Eye-blink-artifact", 8000, 75)])


def test_large_records_of_the_expert_work_are_kept_compressed(service: StudyService) -> None:
    """An adjudication of a 256-channel recording whose decisions hold edited marks on most channels passes a
    megabyte as JSON, more than one Firestore document holds: it is kept compressed, and read back whole."""
    from electrotag.web.store_firestore import BLOB_LIMIT

    store = service.store
    channels = [f"E{i}" for i in range(1, 257)]
    marks = [{"label": "EMG-artifact", "onset_sample": 1000 * k, "duration_samples": 500, "channels": channels[:-1]}
             for k in range(5)]
    decisions = {f"c-{k:016x}": {"choice": "edited", "marks": marks} for k in range(300)}
    record = {"unit_id": "r-big", "decisions": decisions}
    assert len(json.dumps(record)) > 2 * BLOB_LIMIT
    store.update_record("adjudications", "r-big", "E01", lambda old: record)
    assert store.records("adjudications", "E01") == [record]
    snap = store.doc.collection("adjudications").document("r-big").get().to_dict()
    assert snap["record_json"] is None and len(snap["record_blob"]) < BLOB_LIMIT
    # a change reads the compressed record, and a small record is kept as plain JSON again
    got = store.update_record("adjudications", "r-big", "E01", lambda old: {"unit_id": old["unit_id"], "decisions": {}})
    assert got == {"unit_id": "r-big", "decisions": {}}
    assert json.loads(store.doc.collection("adjudications").document("r-big").get().to_dict()["record_json"]) == got
    # what would not fit even compressed is refused, and the record stays as it was
    noise = {"unit_id": "r-big", "blob": os.urandom(1_200_000).hex()}
    with pytest.raises(StoreError, match="too large"):
        store.update_record("adjudications", "r-big", "E01", lambda old: noise)
    assert store.records("adjudications", "E01") == [got]


def test_adjudication_and_the_library_on_firestore(service: StudyService, recordings: Path, tmp_path: Path) -> None:
    from electrotag.web.adjudication import ADJUDICATED, unit_id_for

    store = service.store
    ok(service, "submit", A01, submission(recordings, SUB1, DISAGREE[0]))
    ok(service, "submit", A02, submission(recordings, SUB1, DISAGREE[1]))
    uid = unit_id_for("recording", SUB1)
    row = next(u for u in ok(service, "expert", E01, {"op": "adjudication_list"})["units"] if u["unit_id"] == uid)
    assert (row["status"], row["conflicts"], row["agreed"]) == ("ready", 3, 1)
    assert [a["annotator_id"] for a in row["annotators"]] == ["A01", "A02"]  # not blinded
    got = ok(service, "expert", E01, {"op": "adjudication_start", "unit_id": uid})
    assert got["adjudication"]["state"] == "in_progress" and got["adjudication"]["blinded"] is False
    # the record is kept by the adjudicator, under the unit's ID
    assert [r["unit_id"] for r in store.records("adjudications", "E01")] == [uid]
    assert err(service, "expert", User("E02", roles=("expert",)), {"op": "adjudication_start", "unit_id": uid}).code \
        == "taken"
    for c, choice in zip(got["conflicts"], ("B", "none", "all"), strict=True):
        ok(service, "expert", E01, {"op": "adjudication_decide", "unit_id": uid, "conflict_id": c["conflict_id"],
                                    "choice": choice, "reason": "seen in the EEG"})
    fin = ok(service, "expert", E01, {"op": "adjudication_finish", "unit_id": uid})
    assert fin["version"]["attempt"] == 1 and fin["version"]["n_annotations"] == 3
    assert [e["recording_id"] for e in store.derived_entries("adjudications", ADJUDICATED)] == [SUB1]
    assert ok(service, "expert", E01, {"op": "adjudication_finish", "unit_id": uid})["already"] is True
    outcomes = ok(service, "my_feedback", A01)["adjudications"]["items"][0]["conflicts"]
    # from what was kept: at the third place A01 had no mark and A02's was kept
    assert [c["decision"]["outcome"] for c in outcomes] == ["other_kept", "none_kept", "other_kept"]
    # reopened and finished again: a second adjudicated version beside the first, the history kept
    again = ok(service, "expert", E01, {"op": "adjudication_reopen", "unit_id": uid, "reason": "a second look"})
    assert again["adjudication"]["state"] == "in_progress" and len(again["adjudication"]["history"]) == 1
    assert ok(service, "my_feedback", A01)["adjudications"]["items"][0]["reopened"] is True
    fin2 = ok(service, "expert", E01, {"op": "adjudication_finish", "unit_id": uid})
    assert fin2["version"]["attempt"] == 2 and len(store.derived_entries("adjudications", ADJUDICATED)) == 2
    lib = ok(service, "expert", E01, {"op": "library_list", "pair": ["Eye-blink-artifact", "Eye-movement-artifact"]})
    assert lib["total"] == 1 and lib["facets"]["status"] == {"decided": 3}
    out = ok(service, "expert", E01, {"op": "library_promote", "promote_id": "9" * 32, "to": "snippet",
                                      "set_id": "example", "entry_id": lib["entries"][0]["entry_id"]})
    assert out["snippet"]["label"] == "Eye-movement-artifact" and out["snippet"]["source"]["task_id"] == uid
    assert store.reference_set("example").snippets[0]["source"]["promote_id"] == "9" * 32
    # the export writes the adjudicated version, the decisions and the library into the results folder
    dest = tmp_path / "export"
    assert cli(["export", "--firebase-project", PROJECT, "--study", store.study_id, "--to", str(dest)]) == 0
    root = dest / "Annotated_Events"
    # both adjudicated versions (the one finished before the reopening is kept)
    assert len(list((root / "derived" / "adjudications" / "annotator-ADJUDICATED").rglob("*_annotations.json"))) == 2
    assert (root / "adjudications" / f"{uid}.json").is_file()
    assert len((root / "adjudications" / "decisions.tsv").read_text("utf-8").splitlines()) == 4
    assert len((root / "library" / "library.tsv").read_text("utf-8").splitlines()) == 4


@pytest.mark.skipif(not (AUTH and FUNCTIONS), reason="needs the Auth and Functions emulators")
def test_adjudication_through_the_expert_function(study: str, recordings: Path) -> None:
    from electrotag.web.adjudication import unit_id_for

    svc = firebase_service(study)
    email = f"e01-{study}@example.org"
    admin_ok(svc, "user_add", {"annotator_id": "E01", "email": email, "roles": ["annotator", "expert"],
                               "password": "an-expert-password"})
    ok(svc, "submit", A01, submission(recordings, SUB1, DISAGREE[0]))
    ok(svc, "submit", A02, submission(recordings, SUB1, DISAGREE[1]))
    uid = unit_id_for("recording", SUB1)
    token = sign_in(email, "an-expert-password")
    status, body = callable_("et_expert", {"study": study, "op": "adjudication_list"}, token)
    assert status == 200, body
    assert next(u for u in body["result"]["units"] if u["unit_id"] == uid)["status"] == "ready"
    _, body = callable_("et_expert", {"study": study, "op": "adjudication_start", "unit_id": uid}, token)
    conflicts = body["result"]["conflicts"]
    assert len(conflicts) == 3 and {m["annotator_id"] for m in conflicts[0]["marks"]} == {"A01", "A02"}
    _, body = callable_("et_expert", {"study": study, "op": "adjudication_finish", "unit_id": uid}, token)
    assert body["error"]["details"]["error"] == "undecided" and body["error"]["details"]["n"] == 3
    for c in conflicts:
        _, body = callable_("et_expert", {"study": study, "op": "adjudication_decide", "unit_id": uid,
                                          "conflict_id": c["conflict_id"], "choice": "A",
                                          "reason_code": "clear_artifact"}, token)
        assert "result" in body, body
    _, body = callable_("et_expert", {"study": study, "op": "adjudication_finish", "unit_id": uid}, token)
    assert body["result"]["adjudication"]["state"] == "finished", body
    _, body = callable_("et_expert", {"study": study, "op": "library_list", "status": "decided"}, token)
    assert body["result"]["total"] == 3
    annotator = sign_in(f"a01-{study}@example.org")
    _, body = callable_("et_expert", {"study": study, "op": "adjudication_list"}, annotator)
    assert body["error"]["details"]["error"] == "forbidden"
    _, body = callable_("et_my_feedback", {"study": study}, annotator)
    assert [c["decision"]["outcome"] for c in body["result"]["adjudications"]["items"][0]["conflicts"]] == [
        "yours_kept", "yours_kept", "yours_kept"]


# ------------------------------------------------------ derived versions in the analyses (H6)
def test_agreement_of_the_derived_versions_over_firestore(service: StudyService, recordings: Path) -> None:
    """The agreement reads a Firestore study through results_tree, which writes the derived versions beside the
    originals: the corrected and the adjudicated versions are found there, also when annotators are chosen."""
    from electrotag.web.adjudication import unit_id_for

    store = service.store
    store.put_user("E02", display_name="Expert two", roles=["expert"])
    ok(service, "submit", A01, submission(recordings, SUB1, DISAGREE[0]))
    ok(service, "submit", A02, submission(recordings, SUB1, DISAGREE[1]))
    body = {"config": {"resolutions_s": [1.0]}, "annotator_ids": ["A01", "A02"]}
    original = ok(service, "admin", ADMIN, {"op": "agreement", **body})
    assert original["summary"]["versions"]["used"] == "original" and "versions.tsv" not in original["tables"]
    # E02 corrects A01's work: the blink was the eye movement A02 saw
    fixed = [{**DISAGREE[0][0], "label": DISAGREE[1][0]["label"]}, *DISAGREE[0][1:]]
    ok(service, "expert", User("E02", roles=("expert",)), {"op": "correction_save", **_correction(
        recordings, "7" * 32, fixed, {DISAGREE[0][0]["annotation_id"]: "wrong_type"})})
    corrected = ok(service, "admin", ADMIN, {"op": "agreement", "versions": "corrected", **body})
    v = corrected["summary"]["versions"]
    assert (v["used"], v["replaced"], v["by"]) == ("corrected", 1, {"E02": 1})
    effect = corrected["tables"]["corrections_effect.tsv"].splitlines()
    assert len(effect) == 2 and "\tE02\tcorrection\t" in effect[1]
    # E01 adjudicates the two annotators' versions; the reference is ADJUDICATED, kept although annotators are chosen
    uid = unit_id_for("recording", SUB1)
    got = ok(service, "expert", E01, {"op": "adjudication_start", "unit_id": uid})
    for c in got["conflicts"]:
        ok(service, "expert", E01, {"op": "adjudication_decide", "unit_id": uid, "conflict_id": c["conflict_id"],
                                    "choice": "A", "reason_code": "clear_artifact"})
    ok(service, "expert", E01, {"op": "adjudication_finish", "unit_id": uid})
    adj = ok(service, "admin", ADMIN, {"op": "agreement", "versions": "adjudicated", **body})
    assert adj["summary"]["config"]["reference_annotator"] == "ADJUDICATED"
    assert {r["pair"] for r in adj["summary"]["key_results"]} >= {"ADJUDICATED – A01", "ADJUDICATED – A02"}
    rows = adj["tables"]["adjudication.tsv"].splitlines()
    row = dict(zip(rows[0].split("\t"), rows[1].split("\t"), strict=True))
    assert row["unit_id"] == uid and row["adjudicator"] == "E01" and row["kept_one"] == str(len(got["conflicts"]))
