"""The admin area's operations (POST /admin/{op}) on the ElectroTag server, end to end over HTTP."""

from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.web.admin import OPERATIONS, READ_ONLY  # noqa: E402
from electrotag.web.app import create_app  # noqa: E402
from electrotag.web.study import WebStudy  # noqa: E402
from tests.web_helpers import (  # noqa: E402
    GUIDED1,
    H,
    PRACTICE1,
    SUB1,
    SUB2,
    SUB3,
    Api,
    admin_audit,
    skip_to_guided,
    ann,
    as_wire,
    build_manifests,
    copy_demo,
    make_template,
    match_body,
    reference_annotations,
    submission,
)

BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
EMG = ann("c" * 32, "EMG-artifact", 3000, 250, [])
BLINK2 = ann("e" * 32, "Eye-blink-artifact", 510, 95, ["Fp1", "Fp2"])


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("admin-demo"))


@pytest.fixture
def study(template: Path, tmp_path: Path) -> Path:
    return copy_demo(template, tmp_path)


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


@pytest.fixture
def app(study: Path):
    a = create_app(study, demo=True)
    yield a
    a.state.store.close()


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app)


@pytest.fixture
def admin(client: TestClient) -> Api:
    return Api(client, "ADMIN")


# ---------------------------------------------------------------- who may do what
def test_only_administrators_use_the_admin_area(client: TestClient, admin: Api) -> None:
    a01 = Api(client, "A01")
    for op in OPERATIONS:
        r = a01.admin(op, {})
        assert r.status_code == 403 and r.json()["error"] == "forbidden", op
    assert admin.admin_error("no_such_operation", {}, 404, "not_found")
    r = client.post("/api/v1/admin/overview", json={}, headers=H)
    assert r.status_code == 401
    r = client.post("/api/v1/admin/overview", json={}, headers={"Authorization": f"Bearer {admin.token}"})
    assert r.status_code == 403 and r.json()["error"] == "missing_header"
    r = client.post("/api/v1/admin/overview", content="[1, 2]", headers={**admin.headers,
                                                                          "Content-Type": "application/json"})
    assert r.status_code == 400
    assert set(READ_ONLY) < set(OPERATIONS)


def test_overview_counts_and_recent_changes(client: TestClient, admin: Api, recordings: Path) -> None:
    Api(client, "A01").ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    o = admin.admin_ok("overview")
    assert o["study"] == {"study_id": "demo", "name": "ElectroTag demonstration"}
    c = o["counts"]
    assert (c["recordings"], c["annotators"], c["experts"], c["admins"]) == (3, 4, 1, 1)  # E01 annotates too
    assert c["done"] == 1 and c["assignments"] == c["done"] + c["in_progress"] + c["todo"]
    assert o["last_saved"][0]["annotator_id"] == "A01" and o["last_saved"][0]["recording_id"] == SUB1
    assert o["recent"] == []
    admin.admin_ok("settings_update", {"name": "Pilot"})
    assert admin.admin_ok("overview")["recent"][0]["op"] == "settings_update"


# ------------------------------------------------------------------------ settings
def test_settings_are_read_changed_and_checked(client: TestClient, admin: Api) -> None:
    s = admin.admin_ok("settings_get")
    assert set(s["settings"]) == {"filters", "display", "channels", "selection", "logging", "annotation", "loading",
                                  "discovery", "gamification", "review", "training", "replay", "questionnaire"}
    assert s["settings"]["annotation"]["allow_revisions"] is True
    assert s["settings"]["gamification"] == {"enabled": True, "leaderboard": True, "leaderboard_viewed_only": False}
    assert s["settings"]["filters"]["notch_hz"] == 50.0 and s["logging_notice"]
    assert s["settings"]["discovery"]["suffixes"] == ["_eeg.vhdr", "_eeg.edf", "_eeg.bdf"]
    out = admin.admin_ok("settings_update", {
        "name": "Pilot study", "logging_notice": "We record clicks and keys for the pilot.",
        "settings": {"filters": {"notch_hz": 60.0, "locked": True},
                     "annotation": {"quick_labels": ["EMG-artifact", "Eye-blink-artifact"],
                                    "break_reminder_minutes": 45, "idle_pause_minutes": 0, "coverage_check": "off"}}})
    assert out["name"] == "Pilot study" and out["settings"]["filters"]["notch_hz"] == 60.0
    assert out["logging_notice_is_default"] is False
    me = Api(client, "A01").ok("get", "/me")
    assert me["study"]["name"] == "Pilot study" and me["study"]["filters"]["locked"] is True
    assert me["study"]["annotation"]["quick_labels"] == ["EMG-artifact", "Eye-blink-artifact"]
    comfort = {k: me["study"]["annotation"][k]
               for k in ("break_reminder_minutes", "idle_pause_minutes", "coverage_check")}
    assert comfort == {"break_reminder_minutes": 45.0, "idle_pause_minutes": 0.0, "coverage_check": "off"}
    assert me["study"]["logging_notice"] == "We record clicks and keys for the pilot."
    assert client.get("/api/v1/health").json()["study"] == "Pilot study"
    # the study file is what the desktop's tools read
    for bad, words in (({"selection": {"strategy": "whenever"}}, "selection.strategy"),
                       ({"logging": {"idle_after_s": 1}}, "idle_after_s"),
                       ({"annotation": {"quick_labels": ["EMG-artifact"] * 2}}, "twice"),
                       ({"annotation": {"idle_pause_minutes": 90}}, "idle_pause_minutes must be between 0"),
                       ({"annotation": {"coverage_check": "always"}}, "coverage_check"),
                       ({"filters": {"highpass_hz": "high"}}, ""),
                       ({"output": {"directory_name": "x"}}, "cannot be changed"),
                       ({"filters": {"colour": "red"}}, "no setting filters.colour"),
                       ({"filters": 5}, "object"),
                       ({"annotation": {"allow_revisions": "yes"}}, "annotation.allow_revisions must be true or false"),
                       ({"gamification": {"enabled": 1}}, "gamification.enabled must be true or false"),
                       ({"gamification": {"badges": True}}, "no setting gamification.badges")):
        r = admin.admin_error("settings_update", {"settings": bad}, 400, "invalid_settings")
        assert words in r["message"], (bad, r)
    assert admin.admin_ok("settings_get")["settings"]["filters"]["notch_hz"] == 60.0  # unchanged by the refusals
    admin.admin_error("settings_update", {}, 400, "bad_request")
    entry = admin_audit(admin)[0]
    assert entry["op"] == "settings_update" and entry["by"] == "ADMIN"
    # The summary in words, with the value before and after (the details keep the setting's own name).
    assert "notch hz (filters) from 50 to 60" in entry["summary"]
    assert entry["details"]["changes"]["filters.notch_hz"] == 60.0
    admin.admin_ok("settings_update", {"logging_notice": ""})  # back to ElectroTag's own notice
    assert admin.admin_ok("settings_get")["logging_notice_is_default"] is True
    # the admin area sends display.scalings as a whole: a type left out goes back to the default
    scal = dict(s["settings"]["display"]["scalings"], eeg=0.0001)
    admin.admin_ok("settings_update", {"settings": {"display": {"scalings": scal}}})
    del scal["misc"]
    out = admin.admin_ok("settings_update", {"settings": {"display": {"scalings": scal}}})
    assert out["settings"]["display"]["scalings"]["eeg"] == 0.0001
    assert out["settings"]["display"]["scalings"]["misc"] == s["settings"]["display"]["scalings"]["misc"]
    assert Api(client, "A01").ok("get", "/me")["study"]["display"]["scalings"]["eeg"] == 0.0001


# ------------------------------------------------------------------------ accounts
def test_accounts_on_the_server(client: TestClient, admin: Api, recordings: Path, study: Path) -> None:
    out = admin.admin_ok("user_add", {"annotator_id": "a03", "display_name": "Annotator three",
                                      "email": "a03@example.org", "role": "annotator"})
    assert out["invite_link"] is None and len(out["temporary_password"]) >= 12
    u = out["user"]
    assert (u["annotator_id"], u["status"], u["email"], u["role"], u["assigned"]) == (
        "A03", "active", "a03@example.org", "annotator", 0)
    a03 = Api(client, "A03", out["temporary_password"])
    assert a03.ok("get", "/me")["display_name"] == "Annotator three"
    admin.admin_error("user_add", {"annotator_id": "A03"}, 409, "user_exists")
    admin.admin_error("user_add", {"annotator_id": "../x"}, 400, "bad_request")
    admin.admin_error("user_add", {"annotator_id": "B01", "role": "boss"}, 400, "bad_request")
    admin.admin_error("user_add", {"annotator_id": "B01", "email": "not-an-address"}, 400, "bad_request")
    admin.admin_error("user_add", {"annotator_id": "B01", "password": "short"}, 400, "bad_request")
    chosen = admin.admin_ok("user_add", {"annotator_id": "B01", "password": "a-chosen-password"})
    assert chosen["temporary_password"] is None
    Api(client, "B01", "a-chosen-password")
    users = {u["annotator_id"]: u for u in admin.admin_ok("users_list")["users"]}
    assert set(users) == {"ADMIN", "A01", "A02", "T01", "E01", "A03", "B01"}
    assert users["A01"]["assigned"] == 3 and users["T01"]["programme"] == "example"
    # changes
    u = admin.admin_ok("user_update", {"annotator_id": "A03", "display_name": "Ann Three", "notes": "Part-time",
                                       "role": "admin"})["user"]
    assert (u["display_name"], u["notes"], u["role"]) == ("Ann Three", "Part-time", "admin")
    assert a03.ok("get", "/me")["role"] == "admin"  # at once, on the server
    admin.admin_ok("user_update", {"annotator_id": "A03", "role": "annotator"})
    assert admin.admin_ok("user_update", {"annotator_id": "A03", "status": "disabled"})["changed"] is True
    # Switching off an account that is off already changes nothing, says so, and is not audited.
    n_audit = len(admin_audit(admin))
    assert admin.admin_ok("user_update", {"annotator_id": "A03", "status": "disabled"})["changed"] is False
    assert len(admin_audit(admin)) == n_audit
    r = a03.get("/me")
    assert r.status_code == 401  # the session ends at once
    r = client.post("/api/v1/login", json={"annotator_id": "A03", "password": out["temporary_password"]}, headers=H)
    assert r.status_code == 401
    assert {u["annotator_id"]: u for u in admin.admin_ok("users_list")["users"]}["A03"]["status"] == "disabled"
    admin.admin_ok("user_update", {"annotator_id": "A03", "status": "active"})
    Api(client, "A03", out["temporary_password"])
    reset = admin.admin_ok("user_reset_password", {"annotator_id": "A03"})
    assert reset["invite_link"] is None and reset["temporary_password"] != out["temporary_password"]
    r = client.post("/api/v1/login", json={"annotator_id": "A03", "password": out["temporary_password"]}, headers=H)
    assert r.status_code == 401
    Api(client, "A03", reset["temporary_password"])
    admin.admin_error("user_update", {"annotator_id": "Z99"}, 404, "unknown_user")
    admin.admin_error("user_update", {"annotator_id": "A03", "status": "asleep"}, 400, "bad_request")
    # an administrator cannot demote, disable or remove themselves
    admin.admin_error("user_update", {"annotator_id": "ADMIN", "role": "annotator"}, 409, "self")
    admin.admin_error("user_update", {"annotator_id": "ADMIN", "status": "disabled"}, 409, "self")
    admin.admin_error("user_remove", {"annotator_id": "ADMIN"}, 409, "self")
    admin.admin_ok("user_update", {"annotator_id": "ADMIN", "notes": "the lead"})  # other changes are fine
    # removing an account keeps its results
    a02 = Api(client, "A02")
    a02.ok("post", "/submissions", submission(recordings, SUB1, [BLINK2]))
    a02.ok("put", f"/drafts/{SUB2}", {"annotations": [BLINK], "view": {}, "elapsed_s": 3.0})
    admin.admin_ok("user_remove", {"annotator_id": "A02"})
    assert "A02" not in {u["annotator_id"] for u in admin.admin_ok("users_list")["users"]}
    assert a02.get("/me").status_code == 401
    assert not admin.admin_ok("assignments_list", {})["items"] or all(
        i["annotator_id"] != "A02" for i in admin.admin_ok("assignments_list", {})["items"])
    assert (study / "Annotated_Events" / "annotator-A02" / "sub-001").is_dir()
    assert not (study / "drafts" / "annotator-A02").exists()
    admin.admin_error("user_remove", {"annotator_id": "A02"}, 404, "unknown_user")
    # re-added later, the ID starts afresh but the earlier results are still there
    admin.admin_ok("user_add", {"annotator_id": "A02"})
    log = admin_audit(admin)
    ops = [e["op"] for e in log]
    assert ops[:3] == ["user_add", "user_remove", "user_update"]
    assert {"user_add", "user_update", "user_reset_password", "user_remove"} <= set(ops)
    assert all(e["by"] == "ADMIN" for e in log)
    text = json.dumps(log)
    assert out["temporary_password"] not in text and reset["temporary_password"] not in text
    assert "a-chosen-password" not in text
    assert any(e["summary"] == "Added A03 (Annotator three) as an annotator" for e in log)


# --------------------------------------------------------------------- assignments
def test_assignments_and_programmes(client: TestClient, admin: Api, recordings: Path) -> None:
    a01 = Api(client, "A01")
    a01.ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    items = admin.admin_ok("assignments_list", {"annotator_id": "A01"})["items"]
    assert [(i["recording_id"], i["status"]) for i in items] == [(SUB1, "done"), (SUB2, "todo"), (SUB3, "todo")]
    assert items[0]["attempts"] == 1 and items[0]["last_activity"]
    everyone = admin.admin_ok("assignments_list")["items"]
    assert {i["annotator_id"] for i in everyone} == {"A01", "A02"}  # T01's path begins with the tour
    skip_to_guided(Api(client, "T01"))  # its guided recordings are T01's once the first two stages are skipped
    everyone = admin.admin_ok("assignments_list")["items"]
    assert {i["annotator_id"] for i in everyone} == {"A01", "A02", "T01"}
    admin.admin_ok("user_add", {"annotator_id": "A03"})
    r = admin.admin_ok("assign", {"annotator_ids": ["A03"], "recording_ids": [SUB1, SUB2], "mode": "standard"})
    assert r == {"added": 2, "already": 0, "retired": 0}
    assert admin.admin_ok("assign", {"annotator_ids": ["A03", "A01"], "recording_ids": [SUB1]}) == {
        "added": 0, "already": 2, "retired": 0}
    admin.admin_error("assign", {"annotator_ids": ["A03"], "recording_ids": ["nope.vhdr"]}, 404, "unknown_recording")
    admin.admin_error("assign", {"annotator_ids": ["Z99"], "all": True}, 404, "unknown_user")
    admin.admin_error("assign", {"annotator_ids": [], "all": True}, 400, "bad_request")
    admin.admin_error("assign", {"annotator_ids": ["A03"]}, 400, "bad_request")
    admin.admin_error("assign", {"annotator_ids": ["A03"], "all": True, "mode": "practice"}, 400, "bad_request")
    admin.admin_error("assign", {"annotator_ids": ["A03"], "recording_ids": [SUB1], "mode": "practice",
                                 "context_id": "example"}, 404, "unknown_recording")  # not in the set's scope
    # a retired recording is offered for no new assignments
    admin.admin_ok("recording_update", {"scope": "study", "recording_id": SUB3, "retired": True})
    assert admin.admin_ok("assign", {"annotator_ids": ["A03"], "all": True}) == {"added": 0, "already": 2,
                                                                                  "retired": 1}
    a03_items = admin.admin_ok("assignments_list", {"annotator_id": "A03"})["items"]
    assert [i["recording_id"] for i in a03_items] == [SUB1, SUB2]
    # training assignments of a set's own recordings
    r = admin.admin_ok("assign", {"annotator_ids": ["A03"], "recording_ids": [PRACTICE1], "mode": "practice",
                                  "context_id": "example"})
    assert r["added"] == 1
    # unassigning
    admin.admin_ok("unassign", {"annotator_id": "A03", "recording_id": SUB2, "mode": "standard"})
    admin.admin_error("unassign", {"annotator_id": "A03", "recording_id": SUB2}, 404, "not_assigned")
    admin.admin_error("unassign", {"annotator_id": "A01", "recording_id": SUB1}, 409, "done")
    # programmes
    admin.admin_ok("programme_set", {"annotator_id": "A03", "set_id": "example"})
    a03 = Api(client, "A03", admin.admin_ok("user_reset_password", {"annotator_id": "A03"})["temporary_password"])
    assert a03.ok("get", "/training")["set_id"] == "example"
    assert a03.ok("get", "/me")["programme"]["set_id"] == "example"
    admin.admin_ok("programme_set", {"annotator_id": "A03", "set_id": None})
    assert a03.get("/training").json()["error"] == "no_programme"
    admin.admin_error("programme_set", {"annotator_id": "A03", "set_id": "missing"}, 404, "no_reference_set")
    log = admin_audit(admin)
    assert {"assign", "unassign", "programme_set"} <= {e["op"] for e in log}
    assert any(e["op"] == "assign" and "A03" in e["summary"] for e in log)


# ---------------------------------------------------------------------- recordings
def test_recordings_registered_from_the_browser(client: TestClient, admin: Api, tmp_path: Path) -> None:
    from electrotag.synthetic import write_edf_recording

    folder = tmp_path / "new-data"
    write_edf_recording(folder / "sub-101" / "eeg", "sub-101_task-rest", sfreq=128.0, duration_s=20.0, seed=11)
    write_edf_recording(folder / "sub-102" / "eeg", "sub-102_task-rest", sfreq=128.0, duration_s=20.0, seed=12,
                        bdf=True)
    manifests = build_manifests(folder)
    rid_edf = "sub-101/eeg/sub-101_task-rest_eeg.edf"
    rid_bdf = "sub-102/eeg/sub-102_task-rest_eeg.bdf"
    r = admin.admin_ok("recordings_register", {"scope": "study", "manifests": manifests})
    assert sorted(r["added"]) == [rid_edf, rid_bdf] and r["replaced"] == [] and r["skipped"] == []
    recs = {x["recording_id"]: x for x in admin.admin_ok("recordings_list", {"scope": "study"})["recordings"]}
    rec = recs[rid_edf]
    assert (rec["registered_via"], rec["registered_by"], rec["format"], rec["retired"]) == (
        "browser", "ADMIN", "edf", False)
    assert rec["sha256"] == hashlib.sha256((folder / rid_edf).read_bytes()).hexdigest()
    assert rec["size_bytes"] == (folder / rid_edf).stat().st_size and rec["n_channels"] > 0
    assert recs[SUB1]["registered_via"] == "command" and recs[SUB1]["assigned"] == 2
    # an annotator given the new recording finds it by its fingerprint and can save it
    admin.admin_ok("assign", {"annotator_ids": ["A01"], "recording_ids": [rid_edf]})
    a01 = Api(client, "A01")
    data = (folder / rid_edf).read_bytes()
    m = a01.ok("post", "/match", {"file_name": Path(rid_edf).name, "size_bytes": len(data),
                                  "sha256": hashlib.sha256(data).hexdigest()})
    assert m["status"] == "matched" and m["recording_id"] == rid_edf
    assert "COUNTER" in m["manifest"]["hidden_channels"]
    body = {"recording_id": rid_edf, "annotations": [ann("1" * 32, "EMG-artifact", 100, 50)],
            "session": {"elapsed_s": 3.0}, "sha256": hashlib.sha256(data).hexdigest()}
    assert a01.ok("post", "/submissions", body)["saved"]
    # registering again: refused unless replaced, and never with another file once results exist
    r = admin.admin_ok("recordings_register", {"scope": "study", "manifests": manifests[:1]})
    assert r["skipped"][0]["reason"].startswith("Already registered")
    r = admin.admin_ok("recordings_register", {"scope": "study", "manifests": manifests, "replace": True})
    assert sorted(r["replaced"]) == [rid_edf, rid_bdf]
    changed = copy.deepcopy(next(x for x in manifests if x["recording_id"] == rid_edf))
    changed["fingerprint"]["eeg"]["sha256"] = "0" * 64
    r = admin.admin_ok("recordings_register", {"scope": "study", "manifests": [changed], "replace": True})
    assert r["replaced"] == [] and "saved" in r["skipped"][0]["reason"]
    # into a reference set's own recordings
    admin.admin_ok("set_create", {"set_id": "pilot", "name": "Pilot set"})
    set_manifests = build_manifests(folder, scope="set:pilot")
    r = admin.admin_ok("recordings_register", {"scope": "set:pilot", "manifests": set_manifests})
    assert len(r["added"]) == 2
    assert {x["scope"] for x in admin.admin_ok("recordings_list", {"scope": "set:pilot"})["recordings"]} == {
        "set:pilot"}
    r = admin.admin_ok("recordings_register", {"scope": "study", "manifests": set_manifests})
    assert all("built for" in s["reason"] for s in r["skipped"])
    admin.admin_error("recordings_register", {"scope": "set:missing", "manifests": manifests}, 404,
                      "no_reference_set")
    admin.admin_error("recordings_register", {"scope": "elsewhere", "manifests": manifests}, 400, "bad_request")
    admin.admin_error("recordings_register", {"scope": "study", "manifests": []}, 400, "bad_request")
    admin.admin_error("recordings_register", {"scope": "study", "manifests": [manifests[0]] * 501}, 413, "too_large")
    entry = next(e for e in admin_audit(admin) if e["op"] == "recordings_register")
    assert entry["details"]["scope"] == "set:pilot"


def test_a_copy_of_a_registered_file_is_skipped_unless_confirmed(admin: Api, tmp_path: Path) -> None:
    import shutil

    from electrotag.synthetic import write_edf_recording

    folder = tmp_path / "copies"
    write_edf_recording(folder / "sub-301" / "eeg", "sub-301_task-rest", sfreq=128.0, duration_s=20.0, seed=31)
    first = build_manifests(folder)
    assert admin.admin_ok("recordings_register", {"scope": "study", "manifests": first})["added"]
    # The same bytes under two more IDs: one already registered, the other twice in this request.
    for sub in ("sub-302", "sub-303"):
        (folder / sub / "eeg").mkdir(parents=True)
        shutil.copy(folder / "sub-301/eeg/sub-301_task-rest_eeg.edf", folder / sub / "eeg" / f"{sub}_task-rest_eeg.edf")
    copies = [m for m in build_manifests(folder) if not m["recording_id"].startswith("sub-301")]
    r = admin.admin_ok("recordings_register", {"scope": "study", "manifests": copies})
    assert r["added"] == [] and {s["duplicate_of"] for s in r["skipped"]} == {"sub-301/eeg/sub-301_task-rest_eeg.edf"}
    assert all("same file" in s["reason"] for s in r["skipped"])
    # Confirmed: both are added (each will be annotated as a recording of its own).
    r = admin.admin_ok("recordings_register", {"scope": "study", "manifests": copies, "allow_duplicates": True})
    assert len(r["added"]) == 2 and r["skipped"] == []


def test_recording_notes_retirement_and_removal(client: TestClient, admin: Api, recordings: Path) -> None:
    rec = admin.admin_ok("recording_update", {"scope": "study", "recording_id": SUB2, "notes": "Noisy at the end",
                                              "retired": True})["recording"]
    assert rec["notes"] == "Noisy at the end" and rec["retired"] is True
    rec = admin.admin_ok("recording_update", {"scope": "study", "recording_id": SUB2, "retired": False})["recording"]
    assert rec["notes"] == "Noisy at the end" and rec["retired"] is False
    admin.admin_error("recording_update", {"scope": "study", "recording_id": "nope.vhdr"}, 404, "unknown_recording")
    Api(client, "A01").ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    admin.admin_error("recording_remove", {"scope": "study", "recording_id": SUB1}, 409, "has_results")
    admin.admin_error("recording_remove", {"scope": "set:example", "recording_id": GUIDED1}, 409, "has_results")
    admin.admin_ok("recording_remove", {"scope": "study", "recording_id": SUB3})
    assert SUB3 not in {r["recording_id"] for r in admin.admin_ok("recordings_list")["recordings"]}
    assert SUB3 not in [i["recording_id"] for i in Api(client, "A02").ok("get", "/assignments")["items"]]
    assert {"recording_update", "recording_remove"} <= {e["op"] for e in admin_audit(admin)}


# ------------------------------------------------------------------ reference sets
def test_reference_sets_from_saved_annotations(client: TestClient, admin: Api, recordings: Path,
                                               study: Path) -> None:
    from electrotag.web.store_files import FilesStore

    a01, a02 = Api(client, "A01"), Api(client, "A02")
    a01.ok("post", "/submissions", submission(recordings, SUB1, [BLINK, EMG]))
    a02.ok("post", "/submissions", submission(recordings, SUB1, [BLINK2]))
    a02.ok("post", "/submissions", submission(recordings, SUB2, [EMG]))
    admin.admin_ok("user_add", {"annotator_id": "A03"})
    admin.admin_ok("assign", {"annotator_ids": ["A03"], "recording_ids": [SUB1]})
    a03 = Api(client, "A03", admin.admin_ok("user_reset_password", {"annotator_id": "A03"})["temporary_password"])
    a03.ok("post", "/submissions", submission(recordings, SUB1, [ann("f" * 32, "Eye-blink-artifact", 505, 90,
                                                                       ["Fp1", "Fp2"])]))
    s = admin.admin_ok("set_create", {"set_id": "pilot", "name": "Pilot set", "description": "From the pilot"})["set"]
    assert (s["set_id"], s["self_contained"], s["scope"], s["recordings"], s["created_by"]) == (
        "pilot", True, "set:pilot", [], "ADMIN")
    assert s["practice_pass"] == {"event_f1": 0.8, "label_accuracy": 0.8} and s["quiz_items"] == 0
    admin.admin_error("set_create", {"set_id": "pilot"}, 409, "set_exists")
    admin.admin_error("set_create", {"set_id": "../evil"}, 400, "bad_request")
    # one annotator's saved annotations
    r = admin.admin_ok("set_add_reference", {"set_id": "pilot", "recording_id": SUB1, "recording_scope": "study",
                                             "use": "practice", "source": {"kind": "annotator", "annotator_id": "A01"},
                                             "provenance": {"notes": "A01 is the senior rater"}})
    assert r["disagreements"] is None
    rec = r["set"]["recordings"][0]
    assert (rec["recording_id"], rec["use"], rec["n_reference_events"], rec["registered"]) == (SUB1, "practice", 2,
                                                                                                True)
    assert rec["provenance"]["method"] == "single_expert" and rec["provenance"]["experts"] == ["A01"]
    assert rec["provenance"]["notes"] == "A01 is the senior rater" and rec["provenance"]["sources"]
    store = FilesStore(study)
    rs = store.reference_set("pilot")
    assert [a.label for a in rs.reference_document(SUB1).sorted_annotations()] == ["Eye-blink-artifact",
                                                                                   "EMG-artifact"]
    assert store.manifest("set:pilot", SUB1)["scope"] == "set:pilot"  # copied: a training recording now
    assert store.manifest("study", SUB1) is not None  # and still the study's
    store.close()
    # a consensus of three, with its disagreement rows
    r = admin.admin_ok("set_add_reference", {"set_id": "pilot", "recording_id": SUB1, "use": "assessment",
                                             "source": {"kind": "consensus", "annotator_ids": ["A01", "A02", "A03"],
                                                        "min_agreement": 2}})
    rec = next(x for x in r["set"]["recordings"] if x["recording_id"] == SUB1)
    assert rec["provenance"]["method"] == "consensus" and rec["provenance"]["experts"] == ["A01", "A02", "A03"]
    assert rec["provenance"]["consensus_rule"]["min_agreement"] == 2 and rec["n_reference_events"] == 1
    assert isinstance(r["disagreements"], list) and r["disagreements"]
    assert {"kind", "label", "onset_s", "offset_s", "experts_marking"} <= set(r["disagreements"][0])
    # adjudicated: A03 resolved the disagreements of A01 and A02
    r = admin.admin_ok("set_add_reference", {"set_id": "pilot", "recording_id": SUB1, "use": "assessment",
                                             "source": {"kind": "adjudicated", "adjudicator_id": "A03",
                                                        "expert_ids": ["A01", "A02"]}})
    prov = next(x for x in r["set"]["recordings"] if x["recording_id"] == SUB1)["provenance"]
    assert (prov["method"], prov["adjudicator"], prov["experts"]) == ("adjudicated", "A03", ["A01", "A02"])
    assert len(prov["sources"]) == 3  # the adjudicator's file and both experts'
    # an annotation file from elsewhere (the desktop application)
    doc = json.loads(next((study / "Annotated_Events" / "annotator-A02" / "sub-002").rglob(
        "*_annotations.json")).read_text())
    r = admin.admin_ok("set_add_reference", {"set_id": "pilot", "recording_id": SUB2, "use": "guided",
                                             "source": {"kind": "document", "document": doc}})
    rec = next(x for x in r["set"]["recordings"] if x["recording_id"] == SUB2)
    assert rec["use"] == "guided" and rec["effective_guidance"] == "show" and rec["guidance"] == "auto"
    wrong = copy.deepcopy(doc)
    wrong["recording"]["sfreq"] = 512.0
    admin.admin_error("set_add_reference", {"set_id": "pilot", "recording_id": SUB2, "use": "guided",
                                            "source": {"kind": "document", "document": wrong}}, 422,
                      "invalid_document")
    admin.admin_error("set_add_reference", {"set_id": "pilot", "recording_id": SUB2, "use": "guided",
                                            "source": {"kind": "document", "document": {"schema": "x"}}}, 422,
                      "invalid_document")
    outside = copy.deepcopy(doc)
    outside["annotations"][0]["channels"] = ["NotAChannel"]
    admin.admin_error("set_add_reference", {"set_id": "pilot", "recording_id": SUB2, "use": "guided",
                                            "source": {"kind": "document", "document": outside}}, 422,
                      "invalid_document")
    admin.admin_error("set_add_reference", {"set_id": "pilot", "recording_id": SUB3, "use": "practice",
                                            "source": {"kind": "annotator", "annotator_id": "A01"}}, 404,
                      "no_saved_annotations")
    admin.admin_error("set_add_reference", {"set_id": "pilot", "recording_id": SUB1, "use": "practice",
                                            "source": {"kind": "consensus", "annotator_ids": ["A01"]}}, 400,
                      "bad_request")
    admin.admin_error("set_add_reference", {"set_id": "pilot", "recording_id": SUB1, "use": "everything",
                                            "source": {"kind": "annotator", "annotator_id": "A01"}}, 400,
                      "bad_request")
    admin.admin_error("set_add_reference", {"set_id": "pilot", "recording_id": SUB1, "use": "practice",
                                            "source": {"kind": "guess"}}, 400, "bad_request")
    # guided notes
    notes = admin.admin_ok("set_guided_notes", {"set_id": "pilot", "recording_id": SUB2})["notes"]
    assert len(notes) == 1 and notes[0]["label"] == "EMG-artifact" and notes[0]["note"] == ""
    admin.admin_ok("set_guided_note", {"set_id": "pilot", "annotation_id": notes[0]["annotation_id"],
                                       "text": "Muscle activity over the whole montage."})
    notes = admin.admin_ok("set_guided_notes", {"set_id": "pilot", "recording_id": SUB2})["notes"]
    assert notes[0]["note"] == "Muscle activity over the whole montage."
    admin.admin_error("set_guided_note", {"set_id": "pilot", "annotation_id": "nope", "text": "x"}, 404,
                      "unknown_annotation")
    # uses, guidance and their warnings
    r = admin.admin_ok("set_recording_update", {"set_id": "pilot", "recording_id": SUB2, "guidance": "find"})
    assert next(x for x in r["set"]["recordings"] if x["recording_id"] == SUB2)["effective_guidance"] == "find"
    r = admin.admin_ok("set_recording_update", {"set_id": "pilot", "recording_id": SUB2, "use": "practice"})
    assert r["warnings"] == []
    admin.admin_error("set_recording_update", {"set_id": "pilot", "recording_id": SUB3, "use": "practice"}, 404,
                      "not_in_set")
    admin.admin_error("set_recording_update", {"set_id": "pilot", "recording_id": SUB2, "guidance": "lots"}, 400,
                      "bad_request")
    # a trainee in the programme annotates the set's copy of the recording, from the same file
    admin.admin_ok("user_add", {"annotator_id": "T02"})
    admin.admin_ok("set_update", {"set_id": "pilot", "practice_review": False})
    admin.admin_ok("programme_set", {"annotator_id": "T02", "set_id": "pilot"})
    t02 = Api(client, "T02", admin.admin_ok("user_reset_password", {"annotator_id": "T02"})["temporary_password"])
    t02.ok("post", "/training/stage", {"stage": "tour", "action": "skip"})  # the set has no snippets
    m = t02.ok("post", "/match", match_body(recordings, SUB2))
    assert m["status"] == "matched" and m["mode"] == "practice" and m["context_id"] == "pilot"
    r = t02.ok("post", "/submissions", submission(recordings, SUB2, [EMG], "practice", "pilot"))
    assert r["feedback"]["passed"] is True and r["feedback"]["reference"] == []  # no review in this set
    r = admin.admin_ok("set_recording_update", {"set_id": "pilot", "recording_id": SUB2, "use": "assessment"})
    assert r["warnings"] and "T02" in r["warnings"][0] and "blind" in r["warnings"][0]
    # the study's own annotators are not offered the set's recordings
    assert [i["recording_id"] for i in a01.ok("get", "/assignments")["items"]] == [SUB1, SUB2, SUB3]
    # deleting: refused while used
    admin.admin_error("set_delete", {"set_id": "pilot"}, 409, "in_use")
    admin.admin_ok("set_remove_recording", {"set_id": "pilot", "recording_id": SUB1})
    admin.admin_error("set_remove_recording", {"set_id": "pilot", "recording_id": SUB1}, 404, "not_in_set")
    ops = {e["op"] for e in admin_audit(admin)}
    assert {"set_create", "set_add_reference", "set_guided_note", "set_recording_update", "set_update",
            "set_remove_recording"} <= ops


def test_set_settings_and_deletion(client: TestClient, admin: Api, study: Path) -> None:
    admin.admin_ok("set_create", {"set_id": "s2", "name": "Second", "method": "consensus",
                                  "experts": ["E1", "E2"], "notes": "planned"})
    s = admin.admin_ok("set_update", {
        "set_id": "s2", "name": "Second set", "description": "Updated", "allowed_annotators": ["a01", "T01"],
        "practice_pass": {"event_f1": 0.7}, "guided_tolerance": {"seconds": 0.3},
        "criteria": {"criteria": [{"metric": "event_f1", "threshold": 0.75}], "min_reference_events": 2},
        "quiz": {"include_none_option": True, "feedback": "end"}, "show_full_report_to_annotator": True})["set"]
    assert (s["name"], s["description"], s["allowed_annotators"]) == ("Second set", "Updated", ["A01", "T01"])
    assert s["practice_pass"] == {"event_f1": 0.7, "label_accuracy": 0.8}
    assert s["guided_tolerance"]["seconds"] == 0.3 and s["guided_tolerance"]["fraction"] == 0.2
    assert s["criteria"]["criteria"] == [{"metric": "event_f1", "threshold": 0.75, "scope": "overall"}]
    assert s["quiz"] == {"include_none_option": True, "feedback": "end"} and s["show_full_report_to_annotator"]
    assert s["provenance"]["method"] == "consensus" and s["provenance"]["experts"] == ["E1", "E2"]
    for bad in ({"practice_pass": {"event_f1": 2}}, {"guided_tolerance": {"channel_jaccard": 0}},
                {"criteria": {"criteria": [{"metric": "telepathy", "threshold": 1}]}},
                {"criteria": {"criteria": [{"threshold": 1}]}}, {"quiz": {"feedback": "sometimes"}},
                {"criteria": {"criteria": [{"metric": "event_f1", "threshold": "high"}]}},
                {"criteria": {"criteria": [], "min_reference_events": None}},
                {"criteria": {"criteria": [{"metric": "label_accuracy", "threshold": 0.5, "scope": "each_category"}]}},
                {"practice_pass": {"event_f1": "most"}}, {"practice_pass": {"speed": 1}},
                {"guided_tolerance": {"accepted_labels": {"Eye-blink-artifact": ["Nope"]}}},
                {"quiz": {"colour": 1}}):
        r = admin.admin_error("set_update", {"set_id": "s2", **bad}, 400, "invalid_set")
        assert "Traceback" not in r["message"] and "argument" not in r["message"], r["message"]
    admin.admin_error("set_update", {"set_id": "s2", "practice_review": "yes"}, 400, "bad_request")
    admin.admin_error("set_update", {"set_id": "s2"}, 400, "bad_request")
    admin.admin_error("set_update", {"set_id": "nope", "name": "x"}, 404, "no_reference_set")
    # allowed annotators: enrolling someone else is refused
    admin.admin_error("programme_set", {"annotator_id": "A02", "set_id": "s2"}, 409, "not_allowed")
    assert {x["set_id"] for x in admin.admin_ok("sets_list")["sets"]} == {"example", "s2"}
    admin.admin_ok("set_delete", {"set_id": "s2"})
    assert {x["set_id"] for x in admin.admin_ok("sets_list")["sets"]} == {"example"}
    assert not (study / "derivatives" / "electrotag_reference_sets" / "s2").exists()
    admin.admin_error("set_delete", {"set_id": "example"}, 409, "in_use")  # T01 takes its programme


def test_the_example_set_from_the_admin_area(tmp_path: Path) -> None:
    root = tmp_path / "fresh"
    WebStudy.init(root, study_id="fresh", name="Fresh study")
    from electrotag.web.store_files import FilesStore

    store = FilesStore(root)
    store.db.add_user("ADMIN", "electrotag", role="admin")
    store.db.add_user("T01", "electrotag")
    store.close()
    app = create_app(root)
    client = TestClient(app)
    admin = Api(client, "ADMIN")
    r = admin.admin_ok("set_example_create")
    assert r["set"]["set_id"] == "example" and len(r["set"]["recordings"]) == 3
    assert all(x["registered"] for x in r["set"]["recordings"])
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(r["recordings_zip"]["base64"])))
    assert r["recordings_zip"]["file_name"].endswith(".zip")
    names = z.namelist()
    assert f"electrotag-example-set/{GUIDED1}" in names and not any("reference" in n for n in names)
    admin.admin_error("set_example_create", {}, 409, "set_exists")
    recs = admin.admin_ok("recordings_list", {"scope": "set:example"})["recordings"]
    assert {x["registered_via"] for x in recs} == {"browser"}
    # a trainee opens a recording from the zip: it is the registered one
    admin.admin_ok("programme_set", {"annotator_id": "T01", "set_id": "example"})
    data_name = f"electrotag-example-set/{GUIDED1}".replace(".vhdr", ".eeg")
    data = z.read(data_name)
    t01 = Api(client, "T01")
    skip_to_guided(t01)
    m = t01.ok("post", "/match", {"file_name": Path(GUIDED1).name, "size_bytes": len(data),
                                  "sha256": hashlib.sha256(data).hexdigest()})
    assert m["status"] == "matched" and m["mode"] == "guided"
    assert t01.ok("get", f"/training/guided/{GUIDED1}")["n_steps"] == 6
    assert admin_audit(admin)[0]["op"] == "programme_set"
    app.state.store.close()


# ------------------------------------------------------------------------ analyses
def test_analyses_on_demand(client: TestClient, admin: Api, recordings: Path, study: Path) -> None:
    from electrotag.training.reference import ReferenceSet

    a01, a02 = Api(client, "A01"), Api(client, "A02")
    a01.ok("post", "/submissions", submission(recordings, SUB1, [BLINK, EMG]))
    admin.admin_error("agreement", {}, 422, "not_enough")  # one annotator so far
    a02.ok("post", "/submissions", submission(recordings, SUB1, [BLINK2]))
    r = admin.admin_ok("agreement", {"config": {"resolutions_s": [0.1], "iou_thresholds": [0.2]}})
    assert r["summary"]["n_comparable_recordings"] == 1 and r["summary"]["annotators"] == ["A01", "A02"]
    assert r["summary"]["config"]["resolutions_s"] == [0.1] and r["summary"]["key_results"]
    assert r["report_html"].lstrip().lower().startswith("<!doctype html") and "events_summary.tsv" in r["tables"]
    assert r["tables"]["events_summary.tsv"].split("\t")[0] == "category"
    only = admin.admin_ok("agreement", {"annotator_ids": ["A01", "A02"], "recording_ids": [SUB1]})
    assert only["summary"]["n_recordings"] == 1
    # what the admin area sends: every setting but annotators, modes and extra_measures
    from electrotag.reliability.config import AnalysisConfig

    sent = {k: v for k, v in AnalysisConfig().to_dict().items() if k not in ("annotators", "modes", "extra_measures")}
    assert sent["categories"] is None
    full = admin.admin_ok("agreement", {"modes": ["standard"], "config": sent})
    assert full["summary"]["config"]["iou_thresholds"] == list(AnalysisConfig().iou_thresholds)
    admin.admin_error("agreement", {"recording_ids": [SUB2]}, 422, "not_enough")
    admin.admin_error("agreement", {"config": {"resolutions_s": [-1]}}, 400, "invalid_config")
    admin.admin_error("agreement", {"config": {"no_such_setting": 1}}, 400, "invalid_config")
    admin.admin_error("agreement", {"config": {"categories": ["Not-a-label"]}}, 400, "invalid_config")
    admin.admin_error("agreement", {"modes": ["dreaming"]}, 400, "bad_request")
    # activity
    admin.admin_error("activity", {}, 422, "no_logs")
    v = a01.ok("post", "/visits", {"client": {"user_agent": "pytest"}})
    a01.ok("post", f"/visits/{v['visit_id']}/events", {"events": [{"t": 1.0, "type": "recording_opened",
                                                                   "recording": SUB1}, {"t": 2.0, "type": "key"}]})
    a01.ok("post", f"/visits/{v['visit_id']}/close", {"reason": "done"})
    act = admin.admin_ok("activity", {})
    assert "<html" in act["report_html"].lower()
    assert set(act["tables"]) == {"visits.tsv", "recordings.tsv", "questionnaire_at_visit.tsv"}
    assert "A01" in act["tables"]["visits.tsv"]
    admin.admin_error("activity", {"annotator_ids": ["A02"]}, 422, "no_logs")
    # visits
    vs = admin.admin_ok("visits", {})["visits"]
    assert vs[0]["visit_id"] == v["visit_id"] and vs[0]["n_events"] == 4 and vs[0]["closed_at"]
    assert admin.admin_ok("visits", {"annotator_id": "A02"})["visits"] == []
    # competency, once every assessment recording is saved
    rs = ReferenceSet.load(study / "derivatives" / "electrotag_reference_sets" / "example")
    rs.set_use(PRACTICE1, "assessment")
    admin.admin_ok("assign", {"annotator_ids": ["A01"], "recording_ids": [PRACTICE1], "mode": "assessment",
                              "context_id": "example"})
    admin.admin_error("competency", {"set_id": "example", "annotator_id": "A01"}, 404, "not_complete")
    from electrotag.web.store_files import FilesStore

    store = FilesStore(study)
    ref = reference_annotations(store, "example", PRACTICE1)
    store.close()
    a01.ok("post", "/submissions", submission(recordings, PRACTICE1, [as_wire(a, f"{i + 1:032x}")
                                                                     for i, a in enumerate(ref)],
                                              "assessment", "example"))
    c = admin.admin_ok("competency", {"set_id": "example", "annotator_id": "A01"})
    assert c["report"]["annotator_id"] == "A01" and c["report"]["status"] in ("met", "not_met", "not_determined")
    assert "<html" in c["html"].lower() and "paths" not in c["report"]
    admin.admin_error("competency", {"set_id": "example"}, 400, "bad_request")
    # the results zip and the progress
    z = admin.admin_ok("results_zip", {})
    names = zipfile.ZipFile(io.BytesIO(base64.b64decode(z["base64"]))).namelist()
    assert z["file_name"] == "demo_results.zip" and z["size_bytes"] > 0
    assert "Annotated_Events/completion_register.tsv" in names
    assert any(n.endswith("_competency_report.html") for n in names)
    p = admin.admin_ok("progress", {})
    assert {a["annotator_id"] for a in p["annotators"]} == {"ADMIN", "A01", "A02", "T01", "E01"}
    assert p.keys() == admin.ok("get", "/admin/progress").keys()


def test_results_zip_has_a_size_limit(admin: Api, monkeypatch: pytest.MonkeyPatch) -> None:
    import electrotag.web.export as export

    monkeypatch.setattr(export, "MAX_RESULTS_ZIP", 10)
    r = admin.admin_error("results_zip", {}, 413, "too_large")
    assert "electrotag-web export" in r["message"] and r["size_bytes"] > 10


# --------------------------------------------------------------------- audit log
def test_the_audit_log_pages_newest_first(admin: Api, study: Path) -> None:
    from electrotag.web.cli import main as cli

    for i in range(5):
        admin.admin_ok("recording_update", {"scope": "study", "recording_id": SUB1, "notes": f"note {i}"})
    first = admin.admin_ok("audit", {"limit": 2})
    assert [e["details"]["notes"] for e in first["entries"]] == ["note 4", "note 3"] and first["next"]
    second = admin.admin_ok("audit", {"limit": 2, "before": first["next"]})
    assert [e["details"]["notes"] for e in second["entries"]] == ["note 2", "note 1"]
    third = admin.admin_ok("audit", {"limit": 2, "before": second["next"]})
    assert [e["details"]["notes"] for e in third["entries"]] == ["note 0"] and third["next"] is None
    admin.admin_error("audit", {"before": "not-a-cursor"}, 400, "bad_request")
    admin.admin_error("audit", {"limit": 0}, 400, "bad_request")
    # the commands write entries too, by "command"
    assert cli(["add-user", "C01", "--study-dir", str(study), "--password", "a-long-password"]) == 0
    assert cli(["assign", "C01", "--all", "--study-dir", str(study)]) == 0
    assert cli(["assign", "C01", "--programme", "example", "--study-dir", str(study)]) == 0
    entries = admin.admin_ok("audit", {"limit": 3})["entries"]
    assert [(e["op"], e["by"]) for e in entries] == [("programme_set", "command"), ("assign", "command"),
                                                    ("user_add", "command")]
    assert "a-long-password" not in json.dumps(entries)
