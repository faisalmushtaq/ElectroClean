"""Roles as a set per person, the expert channel and the new study settings (docs/web/api.md, "Roles").

A person may be an annotator, an expert and an administrator at once; "participant" is kept for a
later crowd study and refused. Older SQLite files and Firebase claims (one role) still read; the
expert channel (``POST /expert/{op}``) is for experts and administrators; the review, training and
replay blocks of the study settings are checked like every other block.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.config.settings import MATCH_CRITERIA, SettingsError, load_default_settings_dict  # noqa: E402
from electrotag.config.settings import Settings, deep_merge  # noqa: E402
from electrotag.web.accounts import Accounts  # noqa: E402
from electrotag.web.app import create_app  # noqa: E402
from electrotag.web.expert import EXPERT_OPS, expert_op, is_read, load_operations  # noqa: E402
from electrotag.web.firebase import claims_for, claims_without, role_in  # noqa: E402
from electrotag.web.store import User, parse_roles, primary_role, roles_text  # noqa: E402
from tests.web_helpers import H, Api, admin_audit, copy_demo, make_template  # noqa: E402


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("roles-demo"))


@pytest.fixture
def client(template: Path, tmp_path: Path):
    app = create_app(copy_demo(template, tmp_path), demo=True)
    with TestClient(app) as c:
        yield c
    app.state.store.close()


@pytest.fixture
def admin(client: TestClient) -> Api:
    return Api(client, "ADMIN")


# ------------------------------------------------------------------ the role set
def test_roles_are_read_in_order_and_the_first_is_the_primary_role() -> None:
    assert parse_roles("expert,annotator") == ("expert", "annotator")
    assert parse_roles(["annotator", "admin", "nonsense", "expert"]) == ("admin", "expert", "annotator")
    assert parse_roles(None) == ("annotator",) and parse_roles("") == ("annotator",)
    assert parse_roles("participant") == ("participant",)  # read and kept, though not offered
    assert primary_role(("annotator", "expert")) == "expert" and primary_role(()) == "annotator"
    assert roles_text(("annotator", "expert")) == "an annotator and expert"
    assert roles_text(("admin",)) == "an administrator" and roles_text(("annotator",)) == "an annotator"
    # A User made the old way, with one role, and one made with roles
    old = User("A01", "", "admin")
    assert old.roles == ("admin",) and old.is_admin and old.is_expert  # an administrator may do what an expert does
    e = User("E01", "Expert", roles=("annotator", "expert"))
    assert e.role == "expert" and e.is_expert and not e.is_admin and e.has_role("annotator")
    assert User("A02") == User("A02", "", "annotator", ("annotator",))
    assert not User("A02").is_expert


def test_an_older_database_gets_its_roles_tasks_and_visit_index(tmp_path: Path) -> None:
    db = tmp_path / "server.sqlite"
    con = sqlite3.connect(str(db))
    con.executescript("""
        CREATE TABLE users (annotator_id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL DEFAULT 'annotator', password_hash TEXT NOT NULL, created_at TEXT NOT NULL,
            last_seen TEXT NOT NULL DEFAULT '', disabled INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE assignments (annotator_id TEXT NOT NULL, recording_id TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'standard', context_id TEXT NOT NULL DEFAULT '',
            position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
            PRIMARY KEY (annotator_id, recording_id, mode, context_id));
        CREATE TABLE visits (visit_id TEXT PRIMARY KEY, annotator_id TEXT NOT NULL, path TEXT NOT NULL,
            mode TEXT NOT NULL, context_id TEXT NOT NULL DEFAULT '', opened_at TEXT NOT NULL, opened_mono REAL NOT NULL,
            last_t REAL NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0, closed_at TEXT NOT NULL DEFAULT '');
        INSERT INTO users VALUES ('ADMIN', 'Lead', 'admin', 'x', '2026-10-01', '', 0);
        INSERT INTO users VALUES ('A01', '', 'annotator', 'x', '2026-10-01', '', 0);
        INSERT INTO assignments VALUES ('A01', 'r1', 'standard', '', 1, '2026-10-01');
        INSERT INTO visits VALUES ('v1', 'A01', '/nowhere', 'standard', '', '2026-10-01', 0, 0, 0, '');
    """)
    con.close()
    acc = Accounts(db)
    assert acc.user("ADMIN").roles == ("admin",) and acc.user("A01").roles == ("annotator",)
    assert {u["annotator_id"]: u["roles"] for u in acc.users()} == {"A01": ["annotator"], "ADMIN": ["admin"]}
    assert acc.assignments("A01")[0].task_id == ""
    assert acc.visit_index_rows("v1") is None  # opened before the index: its log is read through instead
    acc.update_user("A01", roles=["annotator", "expert"])
    assert acc.user("A01").roles == ("expert", "annotator") and acc.user("A01").role == "expert"
    acc.close()
    con = sqlite3.connect(str(db))
    assert con.execute("SELECT role, roles FROM users WHERE annotator_id='A01'").fetchone() == ("expert",
                                                                                                "expert,annotator")
    con.close()
    acc = Accounts(db)  # opening again changes nothing (the migration is idempotent)
    assert acc.user("A01").roles == ("expert", "annotator")
    assert acc.assign("A01", ["r1", "r2"], task_id="t-1") == 1  # r2 added; r1, made before its task, linked to it
    assert {a.recording_id: a.task_id for a in acc.assignments("A01")} == {"r1": "t-1", "r2": "t-1"}
    acc.close()


def test_claims_in_the_older_string_form_and_the_list_form() -> None:
    old = {"annotator_id": "A01", "role": "admin", "roles": {"demo": "admin"}, "studies": ["demo"]}
    assert role_in(old, "demo") == ("admin",) and role_in(old, "other") is None
    assert role_in({"annotator_id": "A01", "role": "annotator"}, "demo") == ("annotator",)  # no studies named
    assert role_in({}, "demo") is None
    new = claims_for(old, "A01", "pilot", ["annotator", "expert"])
    assert new["roles"] == {"demo": "admin", "pilot": ["expert", "annotator"]} and new["role"] == "expert"
    assert new["studies"] == ["demo", "pilot"]
    assert role_in(new, "pilot") == ("expert", "annotator") and role_in(new, "demo") == ("admin",)
    assert claims_for(None, "A02", "demo", "annotator")["roles"] == {"demo": ["annotator"]}
    left = claims_without(new, "demo")
    assert left["roles"] == {"pilot": ["expert", "annotator"]} and left["role"] == "expert"
    assert claims_without(left, "pilot") == {}
    with pytest.raises(ValueError):
        claims_for(new, "B01", "demo", "annotator")  # a person keeps one ID in every study of a project


# --------------------------------------------------------------- accounts' roles
def test_signing_in_and_me_answer_the_roles(client: TestClient) -> None:
    r = client.post("/api/v1/login", json={"annotator_id": "E01", "password": "electrotag"}, headers=H)
    assert r.status_code == 200 and r.json()["roles"] == ["expert", "annotator"] and r.json()["role"] == "expert"
    me = Api(client, "E01").ok("get", "/me")
    assert me["roles"] == ["expert", "annotator"] and me["role"] == "expert"
    assert me["study"]["review"] == {"show_corrections_to_annotators": True, "show_outcomes_to_annotators": True}
    assert me["study"]["training"] == {"skippable": ["tour", "snippets", "guided", "practice"], "gate": "met"}
    assert Api(client, "A01").ok("get", "/me")["roles"] == ["annotator"]


def test_accounts_are_given_roles_and_the_reserved_ones_are_refused(client: TestClient, admin: Api) -> None:
    made = admin.admin_ok("user_add", {"annotator_id": "E02", "roles": ["expert", "annotator"],
                                       "password": "a long password"})["user"]
    assert made["roles"] == ["expert", "annotator"] and made["role"] == "expert"
    assert admin_audit(admin, 1)[0]["summary"] == "Added E02 as an annotator and expert"
    assert admin.admin_ok("user_add", {"annotator_id": "A05", "password": "a long password"})["user"]["roles"] == [
        "annotator"]
    admin.admin_error("user_add", {"annotator_id": "P01", "roles": ["participant"]}, 400, "role_not_offered")
    admin.admin_error("user_add", {"annotator_id": "P01", "role": "participant"}, 400, "role_not_offered")
    admin.admin_error("user_add", {"annotator_id": "P01", "roles": ["wizard"]}, 400, "bad_request")
    admin.admin_error("user_add", {"annotator_id": "P01", "roles": []}, 400, "bad_request")
    admin.admin_error("user_add", {"annotator_id": "P01", "role": "annotator", "roles": ["annotator", "admin"]}, 400,
                      "bad_request")  # role is the primary role of roles, here admin
    admin.admin_ok("user_add", {"annotator_id": "P02", "role": "admin", "roles": ["annotator", "admin"],
                                "password": "a long password"})
    for reserved in ("ADJUDICATED", "reference"):
        admin.admin_error("user_add", {"annotator_id": reserved}, 400, "reserved_id")
    admin.admin_error("user_add", {"annotator_id": "E03", "roles": ["annotator", "admin"], "invite": True}, 409,
                      "admin_account")
    # Changing roles: the set replaces the old one, and the expert's work stays where it was.
    u = admin.admin_ok("user_update", {"annotator_id": "A01", "roles": ["annotator", "expert"]})
    assert u["changed"] and u["user"]["roles"] == ["expert", "annotator"]
    assert admin_audit(admin, 1)[0]["summary"] == "A01: made them an annotator and expert"
    assert admin.admin_ok("user_update", {"annotator_id": "A01", "roles": ["expert", "annotator"]})["changed"] is False
    assert Api(client, "A01").ok("get", "/me")["roles"] == ["expert", "annotator"]
    # The older single role still works, and makes it the only one.
    assert admin.admin_ok("user_update", {"annotator_id": "A01", "role": "annotator"})["user"]["roles"] == ["annotator"]
    admin.admin_error("user_update", {"annotator_id": "A01", "roles": ["participant"]}, 400, "role_not_offered")


def test_an_administrator_cannot_take_away_their_own_administrator_role(admin: Api) -> None:
    admin.admin_error("user_update", {"annotator_id": "ADMIN", "roles": ["annotator", "expert"]}, 409, "self")
    admin.admin_error("user_update", {"annotator_id": "ADMIN", "role": "annotator"}, 409, "self")
    # adding a role to oneself, keeping administrator, is allowed
    u = admin.admin_ok("user_update", {"annotator_id": "ADMIN", "roles": ["admin", "expert"]})["user"]
    assert u["roles"] == ["admin", "expert"]


def test_the_overview_counts_each_role(admin: Api) -> None:
    c = admin.admin_ok("overview")["counts"]
    assert (c["annotators"], c["experts"], c["admins"]) == (4, 1, 1)


# --------------------------------------------------------------- the expert channel
def test_the_expert_channel_is_for_experts_and_administrators(client: TestClient, admin: Api) -> None:
    a01 = Api(client, "A01")
    r = a01.post("/expert/replay_consent_get", {})
    assert (r.status_code, r.json()["error"]) == (403, "forbidden")
    e01 = Api(client, "E01")
    got = e01.ok("post", "/expert/replay_consent_get", {})
    assert got["consent"] == {"teaching": False, "changed_at": None}
    assert got["replays"] == {"enabled": True, "trainees_watch_experts": True}
    assert admin.ok("post", "/expert/replay_consent_get", {})["consent"]["teaching"] is False
    r = e01.post("/expert/nothing_here", {})
    assert (r.status_code, r.json()["error"]) == (404, "not_found")
    r = e01.post("/expert/replay_consent_set", {"teaching": "yes"})
    assert (r.status_code, r.json()["error"]) == (400, "bad_request")


def test_replay_consent_is_the_experts_own_and_audited(client: TestClient, admin: Api) -> None:
    e01 = Api(client, "E01")
    on = e01.ok("post", "/expert/replay_consent_set", {"teaching": True})
    assert on["changed"] is True and on["consent"]["teaching"] is True and on["consent"]["changed_at"]
    entry = admin_audit(admin, 1)[0]
    assert (entry["op"], entry["by"]) == ("replay_consent_set", "E01")
    assert entry["summary"] == "E01 agreed to trainees watching replays of their sessions"
    again = e01.ok("post", "/expert/replay_consent_set", {"teaching": True})  # the same press twice: one change
    assert again["changed"] is False and len([e for e in admin_audit(admin) if e["op"] == "replay_consent_set"]) == 1
    assert e01.ok("post", "/expert/replay_consent_get", {})["consent"]["teaching"] is True
    off = e01.ok("post", "/expert/replay_consent_set", {"teaching": False})
    assert off["changed"] is True and admin_audit(admin, 1)[0]["summary"].endswith("no longer agrees to trainees "
                                                                                   "watching replays of their sessions")
    # each person's own: the administrator's consent is untouched
    assert admin.ok("post", "/expert/replay_consent_get", {})["consent"]["teaching"] is False


def test_operations_that_read_and_the_registry() -> None:
    ops = load_operations()
    assert {"replay_consent_get", "replay_consent_set"} <= set(ops)
    assert is_read("replay_consent_get") and is_read("library_list") and not is_read("replay_consent_set")
    assert not is_read("correction_save") and not is_read("list_things_and_save")
    with pytest.raises(ValueError):
        expert_op("replay_consent_get")(lambda s, u, b: {})  # a name is registered once
    with pytest.raises(ValueError):
        expert_op("Bad-Name")
    assert EXPERT_OPS["replay_consent_get"] is ops["replay_consent_get"]


def test_feedback_training_stages_and_snippets(client: TestClient, admin: Api) -> None:
    a01 = Api(client, "A01")
    fb = a01.ok("get", "/me/feedback")
    assert fb == {"corrections": {"shown": True, "items": []}, "adjudications": {"shown": True, "items": []}}
    admin.admin_ok("settings_update", {"settings": {"review": {"show_corrections_to_annotators": False}}})
    assert a01.ok("get", "/me/feedback")["corrections"] == {"shown": False, "items": []}
    t01 = Api(client, "T01")
    r = t01.post("/training/stage", {"stage": "assessment", "action": "skip"})
    assert (r.status_code, r.json()["error"]) == (409, "cannot_skip")
    r = t01.post("/training/stage", {"stage": "lunch", "action": "skip"})
    assert (r.status_code, r.json()["error"]) == (400, "bad_request")
    r = t01.post("/training/stage", {"stage": "tour", "action": "done"})
    assert (r.status_code, r.json()["error"]) == (501, "not_offered")  # the five-stage path comes later
    r = a01.post("/training/stage", {"stage": "tour", "action": "skip"})
    assert (r.status_code, r.json()["error"]) == (404, "no_programme")
    assert t01.ok("get", "/training/snippets") == {"set_id": "example", "snippets": [], "recordings": {}, "quiz": None}


# ------------------------------------------------------------------ the settings
def _settings(**blocks: dict) -> Settings:
    return Settings.from_dict(deep_merge(load_default_settings_dict(), blocks))


def test_the_review_training_and_replay_settings_are_checked() -> None:
    s = _settings()
    assert s.review.k_default == 2 and s.review.reason_required == "always"
    assert s.review.matching["iou_threshold"] == 0.2
    assert s.training.skippable == ("tour", "snippets", "guided", "practice") and s.training.gate == "met"
    assert s.replay.enabled and s.replay.trainees_watch_experts
    assert _settings(training={"skippable": ["practice", "tour"]}).training.skippable == ("tour", "practice")
    for bad in ({"review": {"k_default": 1}}, {"review": {"k_default": 7}}, {"review": {"k_default": 2.5}},
                {"review": {"reason_required": "sometimes"}}, {"review": {"corrections": "yes"}},
                {"review": {"matching": {"match_criterion": "nearby"}}}, {"review": {"matching": {"iou_threshold": 1}}},
                {"review": {"matching": {"overlap": 0.3}}}, {"review": {"matching": {"channel_jaccard": -0.1}}},
                {"review": {"gold_min_items": 0}}, {"training": {"skippable": ["assessment"]}},
                {"training": {"skippable": ["tour", "dancing"]}}, {"training": {"skippable": "tour"}},
                {"training": {"gate": "maybe"}}, {"training": {"tour": 1}}, {"replay": {"enabled": "no"}},
                {"review": ["corrections"]}):
        with pytest.raises(SettingsError):
            _settings(**bad)


def test_the_matching_criteria_are_those_of_the_agreement_analysis() -> None:
    from electrotag.reliability.config import MATCH_CRITERIA as ANALYSIS

    assert MATCH_CRITERIA == ANALYSIS


def test_the_admin_area_reads_and_changes_the_new_blocks(admin: Api) -> None:
    s = admin.admin_ok("settings_get")["settings"]
    assert s["review"]["matching"]["match_criterion"] == "iou" and s["training"]["gate"] == "met"
    assert s["replay"] == {"enabled": True, "trainees_watch_experts": True}
    after = admin.admin_ok("settings_update", {"settings": {"training": {"skippable": ["tour"], "gate": "completed"},
                                                            "review": {"matching": {"iou_threshold": 0.3}}}})
    assert after["settings"]["training"] == {**s["training"], "skippable": ["tour"], "gate": "completed"}
    assert after["settings"]["review"]["matching"]["iou_threshold"] == 0.3
    assert admin.ok("get", "/me")["study"]["training"] == {"skippable": ["tour"], "gate": "completed"}
    e = admin.admin_error("settings_update", {"settings": {"training": {"skippable": ["assessment"]}}}, 400,
                          "invalid_settings")
    assert "assessment" in e["message"]
    admin.admin_error("settings_update", {"settings": {"review": {"blinding": True}}}, 400, "invalid_settings")
    admin.admin_error("settings_update", {"settings": {"replay": {"enabled": "off"}}}, 400, "invalid_settings")
