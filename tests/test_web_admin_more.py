"""The admin area's private invitation links and its progress figures (``user_invite``, ``stats``), on the
ElectroTag server over HTTP, with the unauthenticated ``POST /invite/check`` and ``/invite/accept``."""

from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import time
from datetime import date, timedelta
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.web.app import create_app  # noqa: E402
from tests.web_helpers import SUB1, SUB2, H, Api, admin_audit, ann, copy_demo, make_template, submission  # noqa: E402

BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
EMG = ann("c" * 32, "EMG-artifact", 3000, 250, [])
MOVE = ann("d" * 32, "Movement-artifact", 6000, 300, [])


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("admin-more"))


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


def check(client: TestClient, token: str):
    return client.post("/api/v1/invite/check", json={"token": token}, headers=H)


def accept(client: TestClient, token: str, password: str):
    return client.post("/api/v1/invite/accept", json={"token": token, "password": password}, headers=H)


def state_of(admin: Api, aid: str) -> dict:
    return {u["annotator_id"]: u for u in admin.admin_ok("users_list")["users"]}[aid]["invitation"]


def db_rows(study: Path) -> list[dict]:
    con = sqlite3.connect(str(study / "server.sqlite"))
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute("SELECT * FROM invitations")]
    finally:
        con.close()


# ---------------------------------------------------------------------- invitations
def test_an_invitation_is_a_private_link_used_once(client: TestClient, admin: Api, study: Path) -> None:
    out = admin.admin_ok("user_add", {"annotator_id": "a07", "display_name": "Annotator seven", "invite": True})
    token = out["invite_token"]
    assert out["temporary_password"] is None and out["invite_link"] is None and len(token) >= 40
    assert date.fromisoformat(out["expires_at"][:10]) == date.today() + timedelta(days=14)
    assert out["user"]["invitation"]["state"] == "invited"
    # Only a hash of the token is kept.
    rows = db_rows(study)
    assert [r["annotator_id"] for r in rows] == ["A07"]
    assert rows[0]["token_hash"] == hashlib.sha256(token.encode()).hexdigest()
    assert token not in json.dumps(rows) and token.encode() not in (study / "server.sqlite").read_bytes()
    # The welcome card asks whose link it is, without signing in (but with the header).
    r = check(client, token)
    assert r.status_code == 200, r.text
    assert r.json() == {"annotator_id": "A07", "display_name": "Annotator seven",
                        "study_name": "ElectroTag demonstration", "expires_at": out["expires_at"]}
    assert client.post("/api/v1/invite/check", json={"token": token}).status_code == 403
    # Nobody knows the account's first password.
    assert client.post("/api/v1/login", json={"annotator_id": "A07", "password": token}, headers=H).status_code == 401
    r = accept(client, token, "short")
    assert (r.status_code, r.json()["error"]) == (400, "bad_password")
    r = accept(client, token, "my own password")
    assert r.status_code == 200, r.text
    session = r.json()
    assert (session["annotator_id"], session["role"]) == ("A07", "annotator")
    assert session["display_name"] == "Annotator seven"
    me = client.get("/api/v1/me", headers={**H, "Authorization": f"Bearer {session['token']}"})
    assert me.status_code == 200 and me.json()["annotator_id"] == "A07"
    # Used once: the link now says so, and the password works for signing in.
    for r in (accept(client, token, "another password"), check(client, token)):
        assert (r.status_code, r.json()["error"]) == (409, "invite_used")
        assert "used already" in r.json()["message"]
    Api(client, "A07", "my own password")
    assert state_of(admin, "A07")["state"] == "accepted"
    # Unknown links, in plain words.
    r = check(client, "x" * 43)
    assert (r.status_code, r.json()["error"]) == (404, "invite_unknown")
    assert "Ask the study team for a new one" in r.json()["message"]
    assert check(client, "").status_code == 404 and accept(client, "", "a long password").status_code == 404
    admin.admin_error("user_add", {"annotator_id": "A08", "invite": True, "password": "a-chosen-password"}, 400,
                      "bad_request")


def test_a_new_link_withdrawing_and_switching_off_end_the_old_one(client: TestClient, admin: Api, study: Path) -> None:
    first = admin.admin_ok("user_invite", {"annotator_id": "A02"})["invite_token"]
    second = admin.admin_ok("user_invite", {"annotator_id": "A02", "expires_days": 3})
    assert date.fromisoformat(second["expires_at"][:10]) == date.today() + timedelta(days=3)
    assert check(client, first).status_code == 404  # replaced
    assert check(client, second["invite_token"]).status_code == 200
    # The account's own password keeps working until the link is used.
    Api(client, "A02")
    assert admin.admin_ok("user_invite_revoke", {"annotator_id": "A02"})["invitation"]["state"] == "revoked"
    assert check(client, second["invite_token"]).status_code == 404
    admin.admin_error("user_invite_revoke", {"annotator_id": "A02"}, 409, "no_invitation")
    # Switching the account off ends its link; a switched-off account is not invited.
    third = admin.admin_ok("user_invite", {"annotator_id": "A02"})["invite_token"]
    admin.admin_ok("user_update", {"annotator_id": "A02", "status": "disabled"})
    assert accept(client, third, "a long password").status_code == 404
    assert state_of(admin, "A02")["state"] == "revoked"
    admin.admin_error("user_invite", {"annotator_id": "A02"}, 409, "disabled")
    admin.admin_ok("user_update", {"annotator_id": "A02", "status": "active"})
    # Removing the account ends it too.
    fourth = admin.admin_ok("user_invite", {"annotator_id": "A02"})["invite_token"]
    admin.admin_ok("user_remove", {"annotator_id": "A02"})
    assert check(client, fourth).status_code == 404 and not db_rows(study)
    admin.admin_error("user_invite", {"annotator_id": "Z99"}, 404, "unknown_user")
    for days in (0, 91, "seven"):
        admin.admin_error("user_invite", {"annotator_id": "A01", "expires_days": days}, 400, "bad_request")


def test_administrators_are_never_invited(client: TestClient, admin: Api, study: Path) -> None:
    # Neither a new administrator nor an existing one gets a link.
    admin.admin_error("user_add", {"annotator_id": "B01", "role": "admin", "invite": True}, 409, "admin_account")
    assert "B01" not in {u["annotator_id"] for u in admin.admin_ok("users_list")["users"]}
    admin.admin_error("user_invite", {"annotator_id": "ADMIN"}, 409, "admin_account")
    # An annotator's open link stops working when the account is made an administrator, even if the
    # role was changed behind the admin area's back.
    token = admin.admin_ok("user_invite", {"annotator_id": "A01"})["invite_token"]
    admin.admin_ok("user_update", {"annotator_id": "A01", "role": "admin"})
    assert state_of(admin, "A01")["state"] == "revoked"
    assert accept(client, token, "a long password").status_code == 404
    admin.admin_ok("user_update", {"annotator_id": "A01", "role": "annotator"})
    token = admin.admin_ok("user_invite", {"annotator_id": "A01"})["invite_token"]
    con = sqlite3.connect(str(study / "server.sqlite"))
    with con:
        con.execute("UPDATE users SET role='admin' WHERE annotator_id='A01'")
    con.close()
    for r in (check(client, token), accept(client, token, "a long password")):
        assert (r.status_code, r.json()["error"]) == (404, "invite_unknown")


def test_a_new_password_ends_an_open_invitation(client: TestClient, admin: Api) -> None:
    token = admin.admin_ok("user_invite", {"annotator_id": "A02"})["invite_token"]
    temporary = admin.admin_ok("user_reset_password", {"annotator_id": "A02"})["temporary_password"]
    assert state_of(admin, "A02")["state"] == "revoked"
    assert accept(client, token, "a long password").status_code == 404
    Api(client, "A02", temporary)  # the temporary password given to the person keeps working


def test_two_accepts_at_once_set_one_password(client: TestClient, admin: Api) -> None:
    from concurrent.futures import ThreadPoolExecutor

    token = admin.admin_ok("user_invite", {"annotator_id": "A01"})["invite_token"]
    with ThreadPoolExecutor(4) as pool:
        answers = list(pool.map(lambda i: accept(client, token, f"password number {i}"), range(4)))
    ok = [i for i, r in enumerate(answers) if r.status_code == 200]
    assert len(ok) == 1 and all(r.json()["error"] == "invite_used" for r in answers if r.status_code != 200)
    Api(client, "A01", f"password number {ok[0]}")


def test_an_invitation_expires(client: TestClient, admin: Api, study: Path) -> None:
    token = admin.admin_ok("user_invite", {"annotator_id": "A01", "expires_days": 1})["invite_token"]
    assert check(client, token).status_code == 200
    con = sqlite3.connect(str(study / "server.sqlite"))
    with con:  # a day and a minute later
        con.execute("UPDATE invitations SET expires_epoch=?", (time.time() - 60,))
    con.close()
    for r in (check(client, token), accept(client, token, "a long password")):
        assert (r.status_code, r.json()["error"]) == (409, "invite_expired")
        assert "expired" in r.json()["message"]
    assert state_of(admin, "A01")["state"] == "expired"


def test_invitations_are_audited_without_their_tokens(client: TestClient, admin: Api) -> None:
    added = admin.admin_ok("user_add", {"annotator_id": "A09", "invite": True, "expires_days": 7})
    again = admin.admin_ok("user_invite", {"annotator_id": "A09"})
    admin.admin_ok("user_invite_revoke", {"annotator_id": "A09"})
    log = admin_audit(admin)
    assert [e["op"] for e in log[:3]] == ["user_invite_revoke", "user_invite", "user_add"]
    assert log[2]["summary"].startswith("Added A09 as an annotator with an invitation link (until ")
    assert log[0]["summary"] == "Withdrew the invitation link of A09"
    text = json.dumps(log)
    assert added["invite_token"] not in text and again["invite_token"] not in text
    assert "invite_token" not in text


def test_the_access_log_never_holds_an_invitation_token(app, caplog: pytest.LogCaptureFixture) -> None:
    import logging

    token = "Q" * 43
    access = logging.getLogger("uvicorn.access")
    with caplog.at_level(logging.INFO, logger="uvicorn.access"):
        # as uvicorn writes a request for the page that a link opens
        access.info('%s - "%s %s HTTP/%s" %d', "10.0.0.5:4242", "GET", f"/?server=x&invite={token}#a", "1.1", 200)
        access.info('%s - "%s %s HTTP/%s" %d', "10.0.0.5:4242", "GET", f"/?invite={token}", "1.1", 200)
        access.info("GET /index.html?invite=" + token)  # a message without arguments
    assert len(caplog.records) == 3 and token not in caplog.text
    assert "/?server=x&invite=(hidden)#a" in caplog.text
    from electrotag.web.app import HideInvitations, hide_invitations_in_access_log

    hide_invitations_in_access_log()  # as a second app would: still one filter
    assert sum(isinstance(f, HideInvitations) for f in access.filters) == 1


def test_failed_invitation_attempts_are_limited(client: TestClient) -> None:
    for _ in range(50):
        check(client, "y" * 43)
    r = check(client, "y" * 43)
    assert (r.status_code, r.json()["error"]) == (429, "too_many_attempts")


# --------------------------------------------------------------------------- stats
def test_stats_of_a_small_study(client: TestClient, admin: Api, recordings: Path) -> None:
    before = admin.admin_ok("stats")
    t = before["totals"]
    assert (t["assigned"], t["done"], t["remaining"], t["annotator_hours"]) == (6, 0, 6, 0)
    assert t["median_minutes"] is None and t["projection"] == {"status": "not_enough", "date": None}
    assert len(before["days"]) == 30 and before["days"][-1] == date.today().isoformat()
    a01, a02 = Api(client, "A01"), Api(client, "A02")
    a01.ok("post", "/submissions", submission(recordings, SUB1, [BLINK, EMG], elapsed=120.0))
    a01.ok("post", "/submissions", submission(recordings, SUB2, [BLINK], elapsed=60.0))
    a02.ok("post", "/submissions", submission(recordings, SUB1, [BLINK, EMG, MOVE], elapsed=300.0))
    a02.ok("put", f"/drafts/{SUB2}", {"annotations": [BLINK], "view": {}, "elapsed_s": 30.0})
    s = admin.admin_ok("stats")
    t = s["totals"]
    assert (t["assigned"], t["done"], t["in_progress"], t["todo"], t["remaining"]) == (6, 3, 1, 2, 3)
    assert t["share_done"] == 0.5 and t["done_7d"] == 3 and t["done_30d"] == 3
    assert t["annotator_hours"] == pytest.approx((120 + 60 + 300 + 30) / 3600)
    assert t["median_minutes"] == pytest.approx(2.0)
    finish = date.today() + timedelta(days=math.ceil(3 / (3 / 14)))
    assert t["projection"] == {"status": "projected", "date": finish.isoformat()}
    assert s["daily"][-1] == 3 and sum(s["daily"]) == 3
    people = {p["annotator_id"]: p for p in s["annotators"]}
    p = people["A01"]
    assert (p["assigned"], p["done"], p["in_progress"], p["todo"]) == (3, 2, 0, 1)
    assert (p["time_s"], p["median_s"], p["median_annotations"], p["done_7d"]) == (180.0, 90.0, 1.5, 2)
    assert p["daily"][-1] == 2 and p["last_active"]
    q = people["A02"]
    assert (q["in_progress"], q["in_progress_s"], q["time_s"]) == (1, 30.0, 300.0)
    assert people["ADMIN"]["assigned"] == 0 and people["ADMIN"]["share_done"] is None
    recs = {r["recording_id"]: r for r in s["recordings"]}
    r = recs[SUB1]
    assert (r["assigned"], r["done"], r["median_s"]) == (2, 2, 210.0)
    assert (r["median_annotations"], r["min_annotations"], r["max_annotations"]) == (2.5, 2, 3)
    assert recs[SUB2]["in_progress"] == 1 and recs[SUB2]["done"] == 1
    # Each person's work, recording by recording, for their page.
    items = {i["recording_id"]: i for i in admin.admin_ok("assignments_list", {"annotator_id": "A01"})["items"]}
    assert (items[SUB1]["elapsed_s"], items[SUB1]["n_annotations"]) == (120.0, 2)
    assert items[SUB1]["saved_at"][:10] == date.today().isoformat()
    todo = [i for i in items.values() if i["status"] == "todo"][0]
    assert todo["elapsed_s"] is None and todo["saved_at"] is None
    a02_items = {i["recording_id"]: i for i in admin.admin_ok("assignments_list", {"annotator_id": "A02"})["items"]}
    assert a02_items[SUB2]["status"] == "in_progress" and a02_items[SUB2]["elapsed_s"] == 30.0
    # A revision is another attempt of the same recording: still one recording done, on the day of the
    # first save, with the annotations of the latest attempt and the time of both attempts.
    a01.ok("post", "/submissions", {**submission(recordings, SUB1, [BLINK], elapsed=30.0), "revises": 1})
    s = admin.admin_ok("stats")
    t = s["totals"]
    assert (t["done"], t["done_7d"], sum(s["daily"])) == (3, 3, 3)
    assert t["annotator_hours"] == pytest.approx((150 + 60 + 300 + 30) / 3600)
    p = {x["annotator_id"]: x for x in s["annotators"]}["A01"]
    assert (p["done"], p["done_7d"], p["time_s"], p["median_s"], p["median_annotations"]) == (2, 2, 210.0, 105.0, 1.0)
    r = {x["recording_id"]: x for x in s["recordings"]}[SUB1]
    assert (r["saved"], r["min_annotations"], r["max_annotations"]) == (2, 1, 3)
    items = {i["recording_id"]: i for i in admin.admin_ok("assignments_list", {"annotator_id": "A01"})["items"]}
    assert (items[SUB1]["attempts"], items[SUB1]["elapsed_s"], items[SUB1]["n_annotations"]) == (2, 150.0, 1)
    # A switched-off account leaves the study's totals; its saved work still counts in the hours.
    admin.admin_ok("user_update", {"annotator_id": "A02", "status": "disabled"})
    t = admin.admin_ok("stats")["totals"]
    assert (t["assigned"], t["done"]) == (3, 2)
    assert t["annotator_hours"] == pytest.approx((150 + 60 + 300) / 3600)
    # Training too, when asked.
    assert admin.admin_ok("stats", {"work": "all"})["work"] == "all"
    admin.admin_error("stats", {"work": "some"}, 400, "bad_request")
    assert Api(client, "A01").admin("stats").status_code == 403
