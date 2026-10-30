"""Tracking: the datasets x people summary, the recordings x people grid, what would be notified and the datasets/
folder of the results (electrotag/web/tracking.py; docs/web/api.md, "Datasets, collections, groups and hand-outs")."""

from __future__ import annotations

import base64
import copy
import csv
import io
import json
import time
import zipfile
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.web import datasets as datasets_mod  # noqa: E402
from electrotag.web import tracking as tracking_mod  # noqa: E402
from electrotag.web.app import create_app  # noqa: E402
from electrotag.web.store import User  # noqa: E402
from tests.web_helpers import SUB1, SUB2, SUB3, Api, admin_audit, ann, copy_demo, make_template, submission  # noqa: E402

PASSWORD = "long enough"
BLINK = ann("a1", "Eye-blink-artifact", 100, 50)
EMPTY_CELL = {"given": 0, "opened": 0, "in_progress": 0, "saved": 0, "revised": 0, "set_aside": 0, "locked": 0,
              "first_assigned_at": None, "last_saved_at": None, "due_at": None, "overdue": 0}


def rq(n: int) -> str:
    return f"{n:032x}"


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-tracking"))


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


@pytest.fixture
def app(template: Path, tmp_path: Path):
    a = create_app(copy_demo(template, tmp_path), demo=True, demo_zip=template / "recordings.zip")
    yield a
    a.state.store.close()


@pytest.fixture
def client(app: Any) -> TestClient:
    return TestClient(app)


@pytest.fixture
def admin(client: TestClient) -> Api:
    api = Api(client, "ADMIN")
    for aid in ("A03", "A04", "A05"):
        api.admin_ok("user_add", {"annotator_id": aid, "display_name": f"Annotator {aid[-1]}", "password": PASSWORD})
    return api


def person(client: TestClient, aid: str) -> Api:
    return Api(client, aid, PASSWORD if aid in ("A03", "A04", "A05") else "electrotag")


def on(monkeypatch: pytest.MonkeyPatch, day: str) -> None:
    monkeypatch.setattr(datasets_mod, "now_local_iso", lambda: f"{day}T09:00:00.000+00:00")


def grid(admin: Api, kind: str, tid: str, **body: Any) -> dict[str, Any]:
    return admin.admin_ok("tracking_recordings_get", {"kind": kind, "id": tid, **body})


def cells(admin: Api, kind: str, tid: str, **body: Any) -> dict[str, dict[str, Any]]:
    return {r["recording_id"]: r["cells"] for r in grid(admin, kind, tid, **body)["rows"]}


def summary(admin: Api, kind: str | None = None, **body: Any) -> dict[str, dict[str, Any]]:
    out = admin.admin_ok("tracking_datasets_get", {**({"kind": kind} if kind else {}), **body})
    return {f"{r['kind']}:{r['id']}": r for r in out["rows"]}


def open_recording(api: Api, rid: str) -> None:
    vid = api.ok("post", "/visits", {"mode": "standard"})["visit_id"]
    api.ok("post", f"/visits/{vid}/events", {"events": [{"type": "recording_opened", "t": 4.0, "recording": rid,
                                                         "mode": "standard", "window_no": 1}]})


def set_aside(api: Api, rid: str, n: int) -> None:
    api.ok("post", "/problems", {"problem_id": rq(900 + n), "recording_id": rid, "mode": "standard",
                                 "context_id": "", "reason": "too_noisy", "note": "", "outcome": "unusable",
                                 "where": "home"})


def copies(app: Any, n: int, *, dataset_id: str | None = None) -> list[str]:
    """``n`` more study recordings (copies of SUB3's manifest under their own IDs and fingerprints)."""
    store = app.state.store
    base = store.manifest("study", SUB3)
    out = []
    for i in range(n):
        m = copy.deepcopy(base)
        m["recording_id"] = f"sub-1{i:03d}/eeg/sub-1{i:03d}_task-rest_eeg.edf"
        m["file_name"] = f"sub-1{i:03d}_task-rest_eeg.edf"
        m["fingerprint"]["eeg"]["sha256"] = f"{i + 1:064x}"
        if dataset_id:
            m["registration"] = {**m.get("registration", {}), "dataset_id": dataset_id}
        store.add_manifest(m)
        out.append(m["recording_id"])
    return out


# ------------------------------------------------------------------ every status
def test_every_status_comes_from_the_study_records(app: Any, client: TestClient, admin: Api,
                                                   recordings: Path) -> None:
    admin.admin_ok("dataset_create", {"request_id": rq(1), "dataset_id": "ds", "name": "DS"})
    admin.admin_ok("recordings_move", {"recording_ids": [SUB1, SUB2, SUB3], "dataset_id": "ds"})
    h = admin.admin_ok("handout_create", {"request_id": rq(2), "target": {"kind": "dataset", "id": "ds"},
                                          "people": ["A03", "A04"], "mode": "all"})["handout"]
    admin.admin_ok("assign", {"annotator_ids": ["T01"], "recording_ids": [SUB1]})
    from electrotag.training.reference import ReferenceSet
    from tests.web_helpers import PRACTICE1

    rs = ReferenceSet.load(app.state.store.reference_set("example").directory)  # an assessment for T01 to pass
    rs.set_use(PRACTICE1, "assessment")
    rs.save()
    assert not app.state.service.training_path.gate(User("T01"))["open"], "T01 has the assessment to pass first"
    a03, a04 = person(client, "A03"), person(client, "A04")
    a03.ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    a03.ok("post", "/submissions", {**submission(recordings, SUB1, [ann("a1", "Eye-blink-artifact", 100, 60)]),
                                    "revises": 1})
    a03.ok("post", "/submissions", submission(recordings, SUB2, [BLINK]))
    a03.ok("put", f"/drafts/{SUB3}", {"annotations": [], "view": {}, "elapsed_s": 3.0})
    open_recording(a04, SUB1)
    set_aside(a04, SUB2, 1)
    got = cells(admin, "dataset", "ds")
    status = {(aid, rid): c["status"] for rid, row in got.items() for aid, c in row.items()}
    assert status[("A03", SUB1)] == "revised" and status[("A03", SUB2)] == "saved"
    assert status[("A03", SUB3)] == "in_progress"
    assert status[("A04", SUB1)] == "opened" and status[("A04", SUB2)] == "set_aside"
    assert status[("A04", SUB3)] == "given" and status[("T01", SUB1)] == "locked"
    assert status[("A05", SUB1)] == "not_given" and status[("A01", SUB1)] == "given"
    revised = got[SUB1]["A03"]
    assert revised["version"] == 2 and revised["first_saved_at"] <= revised["saved_at"]
    assert revised["handout_id"] == h["handout_id"] and revised["assigned_by"] == "ADMIN"
    assert revised["assigned_at"] and revised["task_id"] is None and not revised["overdue"]
    assert got[SUB1]["A04"]["opened_at"] and got[SUB2]["A04"]["set_aside_at"]
    assert (got[SUB1]["A01"]["handout_id"], got[SUB1]["A01"]["assigned_by"]) == (None, None), "a plain assignment"
    assert got[SUB1]["A05"] == {**got[SUB1]["A05"], "assigned_at": None, "handout_id": None, "opened_at": None}
    row = summary(admin, "dataset")["dataset:ds"]
    assert row["cells"]["A03"] == {**row["cells"]["A03"], "given": 3, "saved": 2, "revised": 1, "in_progress": 1,
                                   "set_aside": 0, "locked": 0}
    assert row["cells"]["A04"] == {**row["cells"]["A04"], "given": 3, "opened": 1, "set_aside": 1, "saved": 0}
    assert row["cells"]["T01"]["locked"] == 1 and row["cells"]["A05"] == EMPTY_CELL
    assert row["cells"]["A03"]["last_saved_at"] == max(got[SUB1]["A03"]["saved_at"], got[SUB2]["A03"]["saved_at"])
    assert (row["n_recordings"], row["n_rated"], row["ratings"]) == (3, 0, {"0": 1, "1": 2, "2": 0, "3+": 0})
    assert row["n_set_aside"] == 1 and row["complete"] is False and row["state"] == "active"
    out = admin.admin_ok("tracking_datasets_get", {})
    people = {p["annotator_id"]: p for p in out["people"]}
    assert people["A03"] == {"annotator_id": "A03", "display_name": "Annotator 3", "roles": ["annotator"],
                             "status": "active"}
    assert "ADMIN" not in people, "only annotators, and people who hold or saved study work"
    assert out["today"] and out["generated_at"] and out["cached"] is False
    assert {r["kind"] for r in out["rows"]} == {"dataset", "handout"}
    rows = {r["recording_id"]: r for r in grid(admin, "dataset", "ds")["rows"]}
    assert (rows[SUB1]["n_given"], rows[SUB1]["n_rated"], rows[SUB2]["n_set_aside"]) == (5, 1, 1)
    assert not any(e["op"].startswith(("tracking", "notify")) for e in admin_audit(admin, 100)), "reads are not audited"


# ------------------------------------------------------------------ ratings across hand-outs
def test_n_rated_counts_people_across_hand_outs(app: Any, client: TestClient, admin: Api, recordings: Path) -> None:
    c1 = admin.admin_ok("collection_create", {"request_id": rq(1), "name": "One", "recording_ids": [SUB1, SUB2],
                                              "ratings_target": 2})["collection"]["collection_id"]
    c2 = admin.admin_ok("collection_create", {"request_id": rq(2), "name": "Two", "recording_ids": [SUB2, SUB1],
                                              "ratings_target": 3})["collection"]["collection_id"]
    h1 = admin.admin_ok("handout_create", {"request_id": rq(3), "target": {"kind": "collection", "id": c1},
                                           "people": ["A03"], "mode": "all"})["handout"]["handout_id"]
    h2 = admin.admin_ok("handout_create", {"request_id": rq(4), "target": {"kind": "collection", "id": c2},
                                           "people": ["A04"], "mode": "all"})["handout"]["handout_id"]
    for aid in ("A03", "A04"):
        person(client, aid).ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    rows = summary(admin)
    assert rows[f"collection:{c1}"]["n_rated"] == 1 and rows[f"collection:{c2}"]["n_rated"] == 0
    assert rows[f"collection:{c1}"]["ratings"] == {"0": 1, "1": 0, "2": 1, "3+": 0}
    one = rows[f"handout:{h1}"]
    assert one["cells"]["A03"]["given"] == 2 and one["cells"]["A04"] == EMPTY_CELL, "a hand-out's own pairs"
    assert (one["n_recordings"], one["ratings_target"], one["title"], one["complete"]) == (
        2, 2, "Recordings to annotate", False)
    assert rows[f"handout:{h2}"]["target"] == {"kind": "collection", "id": c2, "name": "Two"}
    g = grid(admin, "collection", c2)
    assert [r["recording_id"] for r in g["rows"]] == [SUB2, SUB1], "in the collection's order"
    assert g["ratings_target"] == 3 and {r["recording_id"]: r["n_rated"] for r in g["rows"]} == {SUB1: 2, SUB2: 0}
    h = grid(admin, "handout", h2)
    assert [p["annotator_id"] for p in h["people"]] == ["A04"], "a hand-out's grid shows its recipients"
    # a k share-out: a cell the hand-out does not cover is null
    admin.admin_ok("handout_withdraw", {"handout_id": h1})
    admin.admin_ok("handout_withdraw", {"handout_id": h2})
    c3 = admin.admin_ok("collection_create", {"request_id": rq(5), "name": "Three",
                                              "recording_ids": [SUB1, SUB2, SUB3]})["collection"]["collection_id"]
    k = admin.admin_ok("handout_create", {"request_id": rq(6), "target": {"kind": "collection", "id": c3},
                                          "people": ["A03", "A04", "A05"], "mode": "k", "k": 2})["handout"]
    got = cells(admin, "handout", k["handout_id"])
    assert sum(1 for row in got.values() for c in row.values() if c is None) == 3, "each person has two of three"
    covered = [c for row in got.values() for c in row.values() if c is not None]
    assert len(covered) == 6 and all(c["task_id"] and c["handout_id"] == k["handout_id"] for c in covered)
    assert all(c["assigned_by"] == "ADMIN" for c in covered)
    row = summary(admin, "handout")[f"handout:{k['handout_id']}"]
    assert {a: c["given"] for a, c in row["cells"].items() if c["given"]} == {"A03": 2, "A04": 2, "A05": 2}
    assert (row["mode"], row["k"]) == ("k", 2)


# ------------------------------------------------------------------ paging and filters
def test_the_recording_grid_pages_and_filters(app: Any, client: TestClient, admin: Api, recordings: Path,
                                              monkeypatch: pytest.MonkeyPatch) -> None:
    extra = copies(app, 25, dataset_id="big")
    admin.admin_ok("dataset_create", {"request_id": rq(1), "dataset_id": "big", "name": "Big"})
    admin.admin_ok("recordings_move", {"recording_ids": [SUB1, SUB2], "dataset_id": "big"})
    admin.admin_ok("handout_create", {"request_id": rq(2), "target": {"kind": "dataset", "id": "big"},
                                      "people": ["A03"], "mode": "all", "due_at": "2026-11-20"})
    person(client, "A03").ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    first = grid(admin, "dataset", "big", limit=10)
    assert (first["total"], first["offset"], first["next"], len(first["rows"])) == (27, 0, 10, 10)
    last = grid(admin, "dataset", "big", offset=20, limit=10)
    assert (last["next"], len(last["rows"])) == (None, 7)
    every = [r["recording_id"] for r in grid(admin, "dataset", "big")["rows"]]
    assert every == sorted([SUB1, SUB2, *extra]) and first["target"] == {"kind": "dataset", "id": "big", "name": "Big"}
    assert [r["recording_id"] for r in grid(admin, "dataset", "big", status="saved")["rows"]] == [SUB1]
    assert grid(admin, "dataset", "big", status="given")["total"] == 27, "A01 holds SUB1 and SUB2 too"
    only = grid(admin, "dataset", "big", annotator_id="a03", query="SUB-1000")
    assert [p["annotator_id"] for p in only["people"]] == ["A03"] and only["total"] == 1
    assert list(only["rows"][0]["cells"]) == ["A03"]
    assert grid(admin, "dataset", "big", rated=True)["total"] == 0
    assert grid(admin, "dataset", "big", overdue=True)["total"] == 0
    on(monkeypatch, "2026-11-21")
    late = grid(admin, "dataset", "big", overdue=True)
    assert late["total"] == 26 and late["rows"][0]["cells"]["A03"]["due_at"] == "2026-11-20"
    assert grid(admin, "dataset", "big", overdue=False)["total"] == 1, "the saved one is never overdue"
    assert summary(admin, "dataset")["dataset:big"]["cells"]["A03"]["overdue"] == 26
    for body, code in (({"limit": 0}, "bad_request"), ({"limit": 1001}, "bad_request"),
                       ({"offset": -1}, "bad_request"), ({"status": "done"}, "bad_request"),
                       ({"overdue": "yes"}, "bad_request")):
        admin.admin_error("tracking_recordings_get", {"kind": "dataset", "id": "big", **body}, 400, code)
    admin.admin_error("tracking_recordings_get", {"kind": "dataset", "id": "nope"}, 404, "unknown_dataset")
    admin.admin_error("tracking_recordings_get", {"kind": "collection", "id": "nope"}, 404, "unknown_collection")
    admin.admin_error("tracking_recordings_get", {"kind": "handout", "id": "h-0000000000"}, 404, "unknown_handout")
    admin.admin_error("tracking_recordings_get", {"kind": "group", "id": "x"}, 400, "bad_request")
    admin.admin_error("tracking_recordings_get", {"kind": "dataset", "id": "big", "annotator_id": "ADMIN"}, 404,
                      "unknown_user")
    admin.admin_error("tracking_datasets_get", {"kind": "group"}, 400, "bad_request")
    assert set(summary(admin, "collection")) == set()


# ------------------------------------------------------------------ the cache
def test_the_figures_are_kept_on_firestore_until_a_change_or_refresh(app: Any, client: TestClient, admin: Api,
                                                                     recordings: Path) -> None:
    tracking = app.state.service.tracking
    assert tracking.cache_s == 0, "the files store builds the figures afresh"
    first = admin.admin_ok("tracking_datasets_get", {})
    assert admin.admin_ok("tracking_datasets_get", {})["cached"] is False
    tracking.cache_s = tracking_mod.TRACKING_CACHE_S  # as on Firestore
    first = admin.admin_ok("tracking_datasets_get", {})
    again = admin.admin_ok("tracking_datasets_get", {})
    assert (first["cached"], again["cached"], again["generated_at"]) == (False, True, first["generated_at"])
    person(client, "A01").ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    stale = cells(admin, "dataset", "study-recordings")
    assert stale[SUB1]["A01"]["status"] == "given", "another's save shows after a refresh or a change"
    assert cells(admin, "dataset", "study-recordings", refresh=True)[SUB1]["A01"]["status"] == "saved"
    assert admin.admin_ok("notify_preview_get", {})["cached"] is True
    admin.admin_ok("dataset_create", {"request_id": rq(1), "dataset_id": "new", "name": "New"})
    after = admin.admin_ok("tracking_datasets_get", {"kind": "dataset"})
    assert after["cached"] is False and "new" in {r["id"] for r in after["rows"]}, "forgotten after a change"
    tracking._index.datasets = [d for d in tracking._index.datasets if d["dataset_id"] != "new"]
    assert grid(admin, "dataset", "new")["target"]["id"] == "new", "a target made elsewhere is read afresh"
    admin.admin_error("tracking_datasets_get", {"refresh": "yes"}, 400, "bad_request")


# ------------------------------------------------------------------ what would be notified
def test_what_would_be_notified(app: Any, client: TestClient, admin: Api, recordings: Path,
                                monkeypatch: pytest.MonkeyPatch) -> None:
    d0 = datasets_mod.today()  # the saves happen today
    due = (d0 + timedelta(days=10)).isoformat()
    admin.admin_ok("dataset_create", {"request_id": rq(1), "dataset_id": "ds", "name": "Kakapo dataset",
                                      "ratings_target": 1})
    admin.admin_ok("recordings_move", {"recording_ids": [SUB1, SUB2], "dataset_id": "ds"})
    c = admin.admin_ok("collection_create", {"request_id": rq(2), "name": "Quokka collection",
                                             "recording_ids": [SUB3]})["collection"]["collection_id"]
    h = admin.admin_ok("handout_create", {"request_id": rq(3), "target": {"kind": "collection", "id": c},
                                          "people": ["A03", "A04"], "mode": "all", "due_at": due,
                                          "note": "Okapi team note"})["handout"]
    admin.admin_ok("assign", {"annotator_ids": ["A05"], "recording_ids": [SUB1, SUB2]})
    for rid in (SUB1, SUB2):
        person(client, "A05").ok("post", "/submissions", submission(recordings, rid, [BLINK]))
    person(client, "A04").ok("post", "/submissions", submission(recordings, SUB3, [BLINK]))
    out = admin.admin_ok("notify_preview_get", {})
    assert out["sent"] is False and out["today"] == d0.isoformat()
    by_id = {n["notice_id"]: n for n in out["notices"]}
    done = by_id["dataset-complete-ds"]
    assert done["kind"] == "complete" and done["to"] == ["ADMIN"] and "Kakapo dataset" in done["subject"]
    assert "2 recordings" in done["text"] and "at least 1 person" in done["text"]
    assert not any(n["kind"] == "overdue" for n in out["notices"]), "nothing is overdue before the due date"
    year, week, _ = d0.isocalendar()
    weekly = by_id[f"weekly-{year}-W{week:02d}"]
    assert weekly["to"] == ["ADMIN"] and "Saved in the last 7 days: 3 recordings by 2 people." in weekly["text"]
    assert "- Kakapo dataset: fully rated." in weekly["text"]
    assert "Quokka collection" in weekly["text"] and f"due {tracking_mod.day_long(due)}" in weekly["text"]
    on(monkeypatch, (d0 + timedelta(days=11)).isoformat())
    out = admin.admin_ok("notify_preview_get", {"kind": "overdue"})
    (late,) = out["notices"]
    assert late["notice_id"] == f"overdue-{h['handout_id']}-A03" and late["to"] == ["A03"]
    assert late["subject"] == f"Recordings due {datasets_mod.day_words(due)}: 1 recording still to annotate"
    assert f"due on {tracking_mod.day_long(due)}" in late["text"]
    for secret in ("Quokka", "Kakapo", "Okapi", SUB3, "A04", "sub-003"):
        assert secret not in late["subject"] + late["text"], "a reminder names no recording and nobody else"
    weekly = admin.admin_ok("notify_preview_get", {"kind": "weekly"})["notices"][0]
    assert "Overdue: A03 (Annotator 3)." in weekly["text"]
    assert "Saved in the last 7 days: 0 recordings" in weekly["text"]
    on(monkeypatch, (d0 + timedelta(days=20)).isoformat())
    assert admin.admin_ok("notify_preview_get", {"kind": "complete"})["notices"] == [], "only newly fully rated"
    admin.admin_error("notify_preview_get", {"kind": "email"}, 400, "bad_request")
    assert app.state.store.records("notices") == [], "nothing is kept: nothing is sent"
    assert not any(e["op"].startswith("notify") for e in admin_audit(admin, 100))


# ------------------------------------------------------------------ the results zip
def test_the_results_zip_holds_the_datasets_folder(app: Any, client: TestClient, admin: Api,
                                                   recordings: Path) -> None:
    admin.admin_ok("dataset_create", {"request_id": rq(1), "dataset_id": "ds", "name": "DS", "licence": "CC0"})
    admin.admin_ok("recordings_move", {"recording_ids": [SUB1, SUB2], "dataset_id": "ds"})
    gid = admin.admin_ok("group_create", {"request_id": rq(2), "name": "RAs", "members": ["A03", "A04"]})[
        "group"]["group_id"]
    admin.admin_ok("group_update", {"group_id": gid, "remove": ["A04"]})
    c = admin.admin_ok("collection_create", {"request_id": rq(3), "name": "C", "recording_ids": [SUB2, SUB1]})[
        "collection"]["collection_id"]
    h = admin.admin_ok("handout_create", {"request_id": rq(4), "target": {"kind": "dataset", "id": "ds"},
                                          "groups": [gid], "mode": "all", "due_at": "2026-11-20"})["handout"]
    person(client, "A03").ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(admin.admin_ok("results_zip", {})["base64"])))
    base = "Annotated_Events/datasets/"
    names = {n[len(base):] for n in z.namelist() if n.startswith(base)}
    assert names == {"datasets.json", "datasets.tsv", "collections.json", "groups.json", "group_members.tsv",
                     "handouts.json", "handouts.tsv", "tracking.tsv", "recording_ratings.tsv"}

    def tsv(name: str) -> list[dict[str, str]]:
        return list(csv.DictReader(io.StringIO(z.read(base + name).decode()), delimiter="\t"))

    dsets = {d["dataset_id"]: d for d in json.loads(z.read(base + "datasets.json"))["datasets"]}
    assert set(dsets) == {"study-recordings", "ds"} and dsets["ds"]["licence"] == "CC0"
    assert dsets["ds"]["summary"]["n_recordings"] == 2 and "request_id" not in dsets["ds"]
    assert {r["dataset_id"]: r["n_recordings"] for r in tsv("datasets.tsv")} == {"study-recordings": "1", "ds": "2"}
    assert json.loads(z.read(base + "collections.json"))["collections"][0]["recording_ids"] == [SUB2, SUB1]
    members = tsv("group_members.tsv")
    assert [(m["annotator_id"], bool(m["removed_at"])) for m in members] == [("A03", False), ("A04", True)]
    (ho,) = tsv("handouts.tsv")
    assert (ho["handout_id"], ho["mode"], ho["due_at"], ho["recipients"], ho["saved"]) == (
        h["handout_id"], "all", "2026-11-20", "A03", "1")
    held = json.loads(z.read(base + "handouts.json"))["handouts"][0]
    assert held["progress"]["counts"]["saved"] == 1 and "linked" not in held
    track = tsv("tracking.tsv")
    assert list(track[0]) == list(tracking_mod.CELL_COLUMNS)
    mine = [r for r in track if r["target_kind"] == "dataset" and r["target_id"] == "ds" and r["annotator_id"] == "A03"]
    assert {r["recording_id"]: r["status"] for r in mine} == {SUB1: "saved", SUB2: "given"}
    assert {r["status"] for r in track} <= set(tracking_mod.STATUSES) - {"not_given"}
    assert {(r["target_kind"], r["target_id"]) for r in track} >= {("dataset", "ds"), ("handout", h["handout_id"]),
                                                                    ("collection", c)}
    ratings = {r["recording_id"]: r for r in tsv("recording_ratings.tsv")}
    assert (ratings[SUB1]["n_rated"], ratings[SUB1]["dataset_id"], ratings[SUB3]["dataset_id"]) == (
        "1", "ds", "study-recordings")
    text = b"".join(z.read(base + n) for n in names).decode()
    assert "Annotator 3" not in text, "the research files name people by annotator ID only"
    assert "datasets/" in z.read("README.txt").decode()


# ------------------------------------------------------------------ at scale
@pytest.mark.slow
def test_a_5000_by_10_grid_is_quick(app: Any, admin: Api) -> None:
    """5,000 recordings in one dataset, 10 people each holding every one and 20,000 saves: the summary and the
    whole grid, built afresh, each within 3 s (the design's targets are 1.5 s and 2 s)."""
    from electrotag.app.io.tsv import tsv_bytes
    from electrotag.app.session.register import REGISTER_COLUMNS

    store = app.state.store
    base = store.manifest("study", SUB3)
    folder = store.study.manifests.dir
    rids = []
    for i in range(5000):
        m = copy.deepcopy(base)
        m["recording_id"] = f"sub-{i:04d}/eeg/sub-{i:04d}_task-rest_eeg.edf"
        m["file_name"] = f"sub-{i:04d}_task-rest_eeg.edf"
        m["fingerprint"]["eeg"]["sha256"] = f"{i + 1:064x}"
        m["registration"] = {**m.get("registration", {}), "dataset_id": "big"}
        (folder / f"big-{i:04d}.json").write_text(json.dumps(m))
        rids.append(m["recording_id"])
    admin.admin_ok("dataset_create", {"request_id": rq(1), "dataset_id": "big", "name": "Big"})
    people = [f"P{i:02d}" for i in range(10)]
    for aid in people:
        store.create_account(aid, display_name=aid, role="annotator", email="", password=PASSWORD)
        store.assign_many(aid, [(r, "") for r in rids])
    rows = [{"recording_id": rids[j % 5000], "annotator_id": people[j // 5000 + (j % 2) * 4], "mode": "standard",
             "context": "", "status": "completed", "session_id": f"s{j}",
             "completed_at": f"2026-10-{1 + j % 28:02d}T10:00:00.000+00:00", "elapsed_s": "60",
             "n_annotations": "1", "output_dir": "x", "output_basename": f"b{j}", "app_version": "t"}
            for j in range(20000)]
    layout = store.layout
    layout.register.write_bytes(tsv_bytes(REGISTER_COLUMNS, [[r[c] for c in REGISTER_COLUMNS]
                                                                        for r in rows]))
    assert len(store.completion_entries()) == 20000
    store.refresh()
    t0 = time.perf_counter()
    out = admin.admin_ok("tracking_datasets_get", {"kind": "dataset"})
    t_summary = time.perf_counter() - t0
    row = next(r for r in out["rows"] if r["id"] == "big")
    assert row["n_recordings"] == 5000 and sum(c["given"] for c in row["cells"].values()) == 50000
    assert sum(c["saved"] for c in row["cells"].values()) == len({(r["annotator_id"], r["recording_id"])
                                                                   for r in rows})
    seen, slowest = 0, 0.0
    page: dict[str, Any] = {"next": 0}
    while page["next"] is not None:  # each page builds the figures afresh, as the files store always does
        t0 = time.perf_counter()
        page = grid(admin, "dataset", "big", offset=page["next"])
        slowest = max(slowest, time.perf_counter() - t0)
        seen += len(page["rows"])
    assert seen == 5000 and len(page["rows"][0]["cells"]) >= 10
    assert t_summary < 3.0, f"the summary took {t_summary:.2f} s"
    assert slowest < 3.0, f"a page of 1,000 recordings took {slowest:.2f} s"
