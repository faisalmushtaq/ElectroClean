"""Problem reports and reviews of saved work (electrotag/web/feedback.py, docs/web/api.md).

An annotator reports a problem with a recording instead of saving it as having no artifacts; the
outcome ``unusable`` sets the assignment aside (finished for the annotator, kept apart from done,
left out of agreement). An administrator reviews a saved recording, annotation by annotation,
without changing its files, and the annotator reads the feedback."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.web.app import create_app  # noqa: E402
from tests.web_helpers import SUB1, SUB2, Api, admin_audit, ann, copy_demo, make_template, submission  # noqa: E402

BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
EMG = ann("c" * 32, "EMG-artifact", 3000, 250, [])
BLINK2 = ann("d" * 32, "Eye-blink-artifact", 510, 90, [])


def pid(n: int) -> str:
    return f"{n:032x}"


def report(rid: str, n: int, *, outcome: str = "noted", reason: str = "bad_channels", note: str = "") -> dict:
    return {"problem_id": pid(n), "recording_id": rid, "mode": "standard", "context_id": "", "reason": reason,
            "note": note, "outcome": outcome, "where": "home"}


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-feedback"))


@pytest.fixture
def study(template: Path, tmp_path: Path) -> Path:
    return copy_demo(template, tmp_path)


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


@pytest.fixture
def app(study: Path, template: Path):
    a = create_app(study, demo=True, demo_zip=template / "recordings.zip")
    yield a
    a.state.store.close()


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app)


@pytest.fixture
def admin(client: TestClient) -> Api:
    return Api(client, "ADMIN")


def item_of(api: Api, rid: str) -> dict:
    return next(i for i in api.ok("get", "/assignments")["items"] if i["recording_id"] == rid)


def checksums(folder: Path) -> dict[str, str]:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.iterdir())}


# ------------------------------------------------------------------ problem reports
def test_a_report_is_noted_once_however_often_it_is_sent(client: TestClient, admin: Api) -> None:
    a01 = Api(client, "A01")
    body = report(SUB1, 1, note="Fp1 and Fp2 are flat from 20 s")
    first = a01.ok("post", "/problems", body)
    assert first["already"] is False and first["problem"]["state"] == "open"
    assert first["problem"]["reason_text"] == "Channels are flat, missing or disconnected"
    again = a01.ok("post", "/problems", body)  # pressed twice, or sent again after a late answer
    assert again["already"] is True and again["problem"]["problem_id"] == pid(1)
    listed = admin.admin_ok("problems_list")
    assert len(listed["problems"]) == 1 and listed["counts"] == {"open": 1, "resolved": 0, "unusable": 0}
    p = listed["problems"][0]
    assert p["annotator_id"] == "A01" and p["note"] == "Fp1 and Fp2 are flat from 20 s" and p["unusable_now"] is False
    # "noted": work carries on as before
    item = item_of(a01, SUB1)
    assert item["status"] == "todo" and item["problem"]["reason"] == "bad_channels"
    assert "annotator_id" not in item["problem"]  # the annotator's own view of their report
    # audited once, with the note's length and never its text
    entries = [e for e in admin_audit(admin) if e["op"] == "problem_report"]
    assert len(entries) == 1 and entries[0]["by"] == "A01"
    assert entries[0]["details"]["note_length"] == len(body["note"]) and "note" not in entries[0]["details"]


def test_reports_are_checked(client: TestClient) -> None:
    a01 = Api(client, "A01")
    for bad, code in ((report(SUB1, 2) | {"problem_id": "short"}, "bad_request"),
                      (report(SUB1, 2) | {"reason": "boring"}, "bad_request"),
                      (report(SUB1, 2) | {"outcome": "deleted"}, "bad_request"),
                      (report(SUB1, 2) | {"note": "x" * 301}, "bad_request")):
        r = a01.post("/problems", bad)
        assert (r.status_code, r.json()["error"]) == (400, code), r.text
    r = Api(client, "T01").post("/problems", report(SUB1, 3))
    assert r.status_code == 403 and r.json()["error"] == "not_assigned"


def test_unusable_sets_the_assignment_aside(client: TestClient, admin: Api, recordings: Path) -> None:
    a01 = Api(client, "A01")
    a01.ok("put", f"/drafts/{SUB1}?mode=standard&context=", {"annotations": [BLINK], "elapsed_s": 30})
    out = a01.ok("post", "/problems", report(SUB1, 4, outcome="unusable", reason="file_wont_open"))
    assert out["problem"]["outcome"] == "unusable"
    items = a01.ok("get", "/assignments")
    item = next(i for i in items["items"] if i["recording_id"] == SUB1)
    assert item["status"] == "unusable" and items["next"] != SUB1
    # it cannot be saved or kept as a draft while it is set aside, and opening it says why
    r = a01.post("/submissions", submission(recordings, SUB1, [BLINK]))
    assert (r.status_code, r.json()["error"]) == (409, "unusable")
    r = a01.put(f"/drafts/{SUB1}?mode=standard&context=", {"annotations": [], "elapsed_s": 1})
    assert (r.status_code, r.json()["error"]) == (409, "unusable")
    from tests.web_helpers import match_body

    m = a01.ok("post", "/match", match_body(recordings, SUB1))
    assert m["status"] == "unusable" and "set aside" in m["message"]
    # counted apart from done
    o = admin.admin_ok("overview")["counts"]
    assert o["unusable"] == 1 and o["problems_open"] == 1 and o["done"] == 0
    st = admin.admin_ok("stats")
    assert st["totals"]["unusable"] == 1 and st["totals"]["done"] == 0
    assert st["totals"]["remaining"] == st["totals"]["assigned"] - 1
    row = next(p for p in st["annotators"] if p["annotator_id"] == "A01")
    assert row["unusable"] == 1 and row["done"] == 0
    rec = next(r for r in st["recordings"] if r["recording_id"] == SUB1)
    assert rec["unusable"] == 1 and rec["done"] == 0
    listed = admin.admin_ok("problems_list", {"state": "open"})["problems"]
    assert listed[0]["unusable_now"] is True and listed[0]["item_status"] == "in_progress"
    # a finished recording cannot be set aside
    a01.ok("post", "/submissions", submission(recordings, SUB2, [EMG]))
    r = a01.post("/problems", report(SUB2, 5, outcome="unusable"))
    assert (r.status_code, r.json()["error"]) == (409, "already_done")
    # ... but its problem can still be told
    assert a01.ok("post", "/problems", report(SUB2, 6))["already"] is False


def test_return_resolve_and_reassign(client: TestClient, admin: Api) -> None:
    a01 = Api(client, "A01")
    a01.ok("post", "/problems", report(SUB1, 7, outcome="unusable", reason="wrong_recording"))
    a01.ok("post", "/problems", report(SUB2, 8, outcome="unusable", reason="too_noisy"))
    # returned to the to-do list: unusable is undone, and the annotator sees the note
    out = admin.admin_ok("problem_return", {"problem_id": pid(7), "note": "Replaced the file"})
    assert out["problem"]["resolution"] == "returned" and out["problem"]["state"] == "resolved"
    item = item_of(a01, SUB1)
    assert item["status"] == "todo" and item["problem"]["resolution"] == "returned"
    assert item["problem"]["resolution_note"] == "Replaced the file" and item["problem"]["returned_at"]
    admin.admin_error("problem_return", {"problem_id": pid(7)}, 409, "not_unusable")
    admin.admin_error("problem_resolve", {"problem_id": pid(7)}, 409, "already_resolved")
    admin.admin_error("problem_resolve", {"problem_id": pid(99)}, 404, "unknown_problem")
    # given to someone else: the recording stays set aside for A01 and is assigned to the other person
    admin.admin_ok("user_add", {"annotator_id": "A03", "password": "longenough"})
    admin.admin_error("problem_reassign", {"problem_id": pid(8), "annotator_id": "A01"}, 400, "bad_request")
    out = admin.admin_ok("problem_reassign", {"problem_id": pid(8), "annotator_id": "A03", "note": "A03 takes it"})
    assert out["problem"]["resolution"] == "reassigned" and out["problem"]["reassigned_to"] == "A03"
    assert out["added"] == 1
    assert item_of(a01, SUB2)["status"] == "unusable"
    assert item_of(Api(client, "A03", "longenough"), SUB2)["status"] == "todo"
    # filters, and every change audited
    assert [p["problem_id"] for p in admin.admin_ok("problems_list", {"reason": "too_noisy"})["problems"]] == [pid(8)]
    assert admin.admin_ok("problems_list", {"state": "open"})["problems"] == []
    assert len(admin.admin_ok("problems_list", {"annotator_id": "a01", "recording_id": SUB1})["problems"]) == 1
    ops = [e["op"] for e in admin_audit(admin)]
    assert "problem_return" in ops and "problem_reassign" in ops
    a01.ok("post", "/problems", report(SUB1, 9))
    out = admin.admin_ok("problem_resolve", {"problem_id": pid(9), "note": "Known"})
    assert out["problem"]["resolution"] == "resolved"


def test_a_recording_set_aside_is_not_unassigned(client: TestClient, admin: Api) -> None:
    a01 = Api(client, "A01")
    a01.ok("post", "/problems", report(SUB1, 12, outcome="unusable"))
    # Unassigning would silently undo the set-aside: the report is the place to deal with it.
    r = admin.admin_error("unassign", {"annotator_id": "A01", "recording_id": SUB1}, 409, "set_aside")
    assert "Problems" in r["message"] and r["message"].endswith(".")
    assert item_of(a01, SUB1)["status"] == "unusable"
    assert admin.admin_ok("problems_list", {"state": "open"})["problems"][0]["unusable_now"] is True
    # Returned to the annotator's list, it is an ordinary assignment again and can be taken away.
    admin.admin_ok("problem_return", {"problem_id": pid(12)})
    admin.admin_ok("unassign", {"annotator_id": "A01", "recording_id": SUB1})
    admin.admin_ok("assign", {"annotator_ids": ["A01"], "recording_ids": [SUB1]})
    assert item_of(a01, SUB1)["status"] == "todo"


def test_giving_a_recording_to_someone_who_has_it_leaves_the_report_open(client: TestClient, admin: Api) -> None:
    Api(client, "A01").ok("post", "/problems", report(SUB1, 13, outcome="unusable"))
    admin.admin_ok("user_add", {"annotator_id": "A03", "password": "longenough"})
    admin.admin_ok("assign", {"annotator_ids": ["A03"], "recording_ids": [SUB1]})
    r = admin.admin_error("problem_reassign", {"problem_id": pid(13), "annotator_id": "A03"}, 409, "already_assigned")
    assert "A03 already has" in r["message"]
    open_ = admin.admin_ok("problems_list", {"state": "open"})["problems"]
    assert [p["problem_id"] for p in open_] == [pid(13)]
    assert "problem_reassign" not in [e["op"] for e in admin_audit(admin)]


def test_training_recordings_are_not_set_aside(client: TestClient) -> None:
    t01 = Api(client, "T01")
    first = next(i for i in t01.ok("get", "/assignments")["items"])
    r = t01.post("/problems", {**report(first["recording_id"], 10, outcome="unusable"), "mode": first["mode"],
                               "context_id": first["context_id"]})
    assert (r.status_code, r.json()["error"]) == (409, "not_for_training")


def test_agreement_leaves_out_unusable_recordings(client: TestClient, admin: Api, recordings: Path) -> None:
    a01, a02 = Api(client, "A01"), Api(client, "A02")
    for api, anns in ((a01, [BLINK, EMG]), (a02, [BLINK2])):
        api.ok("post", "/submissions", submission(recordings, SUB1, anns))
        api.ok("post", "/submissions", submission(recordings, SUB2, anns))
    before = admin.admin_ok("agreement", {})
    assert before["summary"]["n_recordings"] == 2 and before["summary"]["unusable"]["recordings_left_out"] == 0
    admin.admin_ok("user_add", {"annotator_id": "A03", "password": "longenough"})
    admin.admin_ok("assign", {"annotator_ids": ["A03"], "recording_ids": [SUB2]})
    Api(client, "A03", "longenough").ok("post", "/problems", report(SUB2, 11, outcome="unusable"))
    after = admin.admin_ok("agreement", {})
    assert after["summary"]["n_recordings"] == 1
    assert after["summary"]["unusable"] == {"recordings_left_out": 1, "recording_ids": [SUB2], "assignments": 1}
    assert any("left out" in w for w in after["warnings"])
    assert 'data-note="unusable"' in after["report_html"]


def test_the_command_repeats_the_browsers_agreement_analysis(client: TestClient, admin: Api, recordings: Path,
                                                             app, tmp_path: Path) -> None:
    from electrotag.reliability import cli

    noted = {**BLINK, "confidence": 2, "note": "Could be a slow eye movement"}
    a01, a02 = Api(client, "A01"), Api(client, "A02")
    for api, anns in ((a01, [noted, EMG]), (a02, [BLINK2])):
        api.ok("post", "/submissions", submission(recordings, SUB1, anns))
        api.ok("post", "/submissions", submission(recordings, SUB2, anns))
    admin.admin_ok("user_add", {"annotator_id": "A03", "password": "longenough"})
    admin.admin_ok("assign", {"annotator_ids": ["A03"], "recording_ids": [SUB2]})
    Api(client, "A03", "longenough").ok("post", "/problems", report(SUB2, 21, outcome="unusable"))
    r = admin.admin_ok("agreement", {"config": {"resolutions_s": [0.1]}})
    file = r["settings_file"]
    assert file["exclude_recording_ids"] == [SUB2] and file["config"]["resolutions_s"] == [0.1]
    assert file["command"] == "electrotag-agreement Annotated_Events --config agreement_settings.json"
    assert file["command"] in " ".join(r["warnings"])
    # The annotators' notes are always sent, in a small table of their own.
    notes = r["tables"]["annotation_notes.tsv"].splitlines()
    assert notes[0].split("\t") == ["recording_id", "annotator_id", "mode", "annotation_id", "label", "onset_s",
                                    "duration_s", "channels", "confidence", "note"]
    assert len(notes) == 2 and notes[1].endswith("\t2\tCould be a slow eye movement")
    # The settings file is what --config reads: the command analyses the same recordings and gives the same numbers.
    settings = tmp_path / "agreement_settings.json"
    settings.write_text(json.dumps(file), encoding="utf-8")
    root = app.state.store.layout.root
    assert cli.main([str(root), "--config", str(settings), "--out", str(tmp_path / "cli"), "--no-html"]) == 0
    record = json.loads((tmp_path / "cli" / "analysis_settings.json").read_text(encoding="utf-8"))
    assert (record["n_recordings"], record["n_comparable_recordings"]) == (
        r["summary"]["n_recordings"], r["summary"]["n_comparable_recordings"]) == (1, 1)
    assert record["config"]["resolutions_s"] == [0.1] and record["exclude_recording_ids"] == [SUB2]
    # Without the recordings set aside left out, the command would analyse both; the earlier settings repeat it too.
    assert cli.main([str(root), "--out", str(tmp_path / "all"), "--no-html"]) == 0
    assert json.loads((tmp_path / "all" / "analysis_settings.json").read_text(encoding="utf-8"))["n_recordings"] == 2
    again = tmp_path / "cli" / "analysis_settings.json"
    assert cli.main([str(root), "--config", str(again), "--out", str(tmp_path / "again"), "--no-html"]) == 0
    assert json.loads((tmp_path / "again" / "analysis_settings.json").read_text(encoding="utf-8"))["n_recordings"] == 1


def test_a_review_shows_the_annotators_confidence_and_notes(client: TestClient, admin: Api, recordings: Path) -> None:
    noted = {**BLINK, "confidence": 2, "note": "Unsure"}
    Api(client, "A01").ok("post", "/submissions", submission(recordings, SUB1, [noted, EMG]))
    t = admin.admin_ok("saved_attempt_get", {"annotator_id": "A01", "recording_id": SUB1})
    by_id = {a["annotation_id"]: a for a in t["annotations"]}
    assert (by_id[BLINK["annotation_id"]]["confidence"], by_id[BLINK["annotation_id"]]["note"]) == (2, "Unsure")
    assert (by_id[EMG["annotation_id"]]["confidence"], by_id[EMG["annotation_id"]]["note"]) == (None, "")


# ------------------------------------------------------------------------- reviews
def review_body(attempt: int = 1, n: int = 20, **extra) -> dict:
    return {"review_id": pid(n), "annotator_id": "A01", "recording_id": SUB1, "attempt": attempt,
            "items": [{"annotation_id": BLINK["annotation_id"], "status": "caveat", "note": "Starts a little early"},
                      {"annotation_id": EMG["annotation_id"], "status": "agree"},
                      {"annotation_id": None, "onset_sample": 6000, "duration_samples": 512, "status": "comment"}],
            "overall_note": "Careful work.", **extra}


def test_a_review_is_its_own_record(client: TestClient, admin: Api, recordings: Path, study: Path) -> None:
    a01 = Api(client, "A01")
    admin.admin_error("saved_attempt_get", {"annotator_id": "A01", "recording_id": SUB1}, 404, "no_saved_annotations")
    a01.ok("post", "/submissions", submission(recordings, SUB1, [BLINK, EMG]))
    folder = study / "Annotated_Events" / "annotator-A01" / "sub-001" / "eeg"
    before = checksums(folder)
    got = admin.admin_ok("saved_attempt_get", {"annotator_id": "A01", "recording_id": SUB1})
    assert got["attempt"] == 1 and {a["annotation_id"] for a in got["annotations"]} == {BLINK["annotation_id"],
                                                                                         EMG["annotation_id"]}
    assert got["manifest"]["fingerprint"]["hex"] and got["reviews"] == []
    out = admin.admin_ok("review_save", review_body())
    assert out["already"] is False
    rv = out["review"]
    assert rv["counts"] == {"agree": 1, "caveat": 1, "comment": 1, "missed": 1}
    assert rv["summary"] == "1 caveat, 1 comment, 1 agreement" and rv["reviewer_id"] == "ADMIN"
    missed = rv["items"][2]
    assert missed["note"] == "missed artifact?" and missed["annotation_id"] is None and missed["onset_s"] > 0
    assert rv["items"][0]["label"] == "Eye-blink-artifact"  # what was reviewed, kept with the item
    assert admin.admin_ok("review_save", review_body())["already"] is True  # sent twice: kept once
    assert len(admin.admin_ok("reviews_list", {"annotator_id": "A01"})["reviews"]) == 1
    assert checksums(folder) == before  # the annotation files are never changed
    # the annotator sees the feedback
    mine = a01.ok("get", "/me/reviews")
    assert mine["shown"] is True and mine["reviews"][0]["summary"] == "1 caveat, 1 comment, 1 agreement"
    assert "session_id" not in mine["reviews"][0]
    assert Api(client, "A02").ok("get", "/me/reviews")["reviews"] == []
    # another review, later, by the same or another administrator
    admin.admin_ok("review_save", review_body(n=21) | {"items": [], "overall_note": "Looked again."})
    assert len(admin.admin_ok("saved_attempt_get", {"annotator_id": "A01", "recording_id": SUB1})["reviews"]) == 2
    entries = [e for e in admin_audit(admin) if e["op"] == "review_save"]
    assert len(entries) == 2 and "1 caveat" in entries[1]["summary"]
    # Overview and Progress count reviewed recordings
    assert admin.admin_ok("overview")["counts"]["reviewed"] == 1
    assert admin.admin_ok("stats")["totals"]["reviewed"] == 1


def test_reviews_are_checked(client: TestClient, admin: Api, recordings: Path) -> None:
    a01 = Api(client, "A01")
    a01.ok("post", "/submissions", submission(recordings, SUB1, [BLINK, EMG]))
    admin.admin_error("review_save", review_body(items=[], overall_note=""), 400, "empty_review")
    admin.admin_error("review_save", review_body(items=[{"annotation_id": "zz", "status": "agree"}]), 422,
                      "unknown_annotation")
    admin.admin_error("review_save", review_body(items=[{"annotation_id": BLINK["annotation_id"], "status": "maybe"}]),
                      400, "bad_request")
    admin.admin_error("review_save", review_body(items=[{"onset_sample": 0, "duration_samples": 10 ** 9,
                                                         "status": "comment"}]), 422, "invalid_review")
    admin.admin_error("review_save", review_body(items=[{"annotation_id": BLINK["annotation_id"], "status": "agree",
                                                         "note": "x" * 301}]), 400, "bad_request")
    admin.admin_error("review_save", review_body(attempt=2), 409, "not_latest")
    admin.admin_error("review_save", {**review_body(), "recording_id": SUB2}, 404, "no_saved_annotations")
    r = a01.post("/admin/review_save", review_body())
    assert r.status_code == 403
    # switched off, and blind
    admin.admin_ok("settings_update", {"settings": {"annotation": {"allow_reviews": False}}})
    admin.admin_error("review_save", review_body(), 409, "reviews_off")
    admin.admin_ok("settings_update", {"settings": {"annotation": {"allow_reviews": True,
                                                                   "show_reviews_to_annotators": False}}})
    admin.admin_ok("review_save", review_body())
    assert a01.ok("get", "/me/reviews") == {"shown": False, "reviews": []}
    me = a01.ok("get", "/me")["study"]["annotation"]
    assert me["allow_reviews"] is True and me["show_reviews_to_annotators"] is False
    r = admin.admin("settings_update", {"settings": {"annotation": {"show_reviews_to_annotators": "no"}}})
    assert r.status_code == 400 and r.json()["error"] == "invalid_settings"


def test_the_results_zip_holds_reports_and_reviews(client: TestClient, admin: Api, recordings: Path) -> None:
    a01 = Api(client, "A01")
    a01.ok("post", "/submissions", submission(recordings, SUB1, [BLINK, EMG]))
    a01.ok("post", "/problems", report(SUB2, 30, outcome="unusable", note="Flat"))
    admin.admin_ok("review_save", review_body())
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(admin.admin_ok("results_zip")["base64"])))
    names = z.namelist()
    tsv = z.read("Annotated_Events/problem_reports/problem_reports.tsv").decode()
    assert tsv.splitlines()[0].split("\t")[:4] == ["problem_id", "reported_at", "annotator_id", "recording_id"]
    assert "unusable" in tsv and "\tyes" in tsv
    reports = json.loads(z.read("Annotated_Events/problem_reports/problem_reports.json"))
    assert reports["reports"][0]["note"] == "Flat"
    review_files = [n for n in names if n.startswith("Annotated_Events/reviews/annotator-A01/")]
    assert len(review_files) == 2 and any(n.endswith(".tsv") for n in review_files)
    js = json.loads(z.read(next(n for n in review_files if n.endswith(".json"))))
    assert js["schema"] == "electrotag.review" and js["attempt"] == 1 and len(js["items"]) == 3
    rows = z.read(next(n for n in review_files if n.endswith(".tsv"))).decode().splitlines()
    assert len(rows) == 1 + 3 + 1  # header, three items and the overall note
    # The study's own records: its settings, its audit log and its recordings' manifests, and a README.
    assert {"study/electrotag_study.json", "study/audit_log.jsonl", "study/manifests.json", "README.txt"} <= set(names)
    assert json.loads(z.read("study/electrotag_study.json"))["study_id"]
    audit_ops = [json.loads(line)["op"] for line in z.read("study/audit_log.jsonl").decode().splitlines()]
    assert audit_ops[-1] == "review_save"  # oldest first
    assert SUB1 in {m["recording_id"] for m in json.loads(z.read("study/manifests.json"))["manifests"]}
    readme = z.read("README.txt").decode()
    assert "desktop" not in readme
    assert "electrotag-agreement Annotated_Events --config agreement_settings.json" in readme
