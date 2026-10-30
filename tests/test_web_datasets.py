"""Datasets, collections, groups and hand-outs (electrotag/web/datasets.py; docs/web/api.md, "Datasets, collections,
groups and hand-outs")."""

from __future__ import annotations

from electrotag.web import admin as admin_mod
from electrotag.web.store import RECORD_KINDS, Assignment


# ------------------------------------------------------------------ the interfaces
def test_the_operations_and_record_kinds_are_declared() -> None:
    for op in admin_mod.DATASET_READS + admin_mod.TRACKING_READS:
        assert op in admin_mod.READ_ONLY and op.endswith(("_get", "_list")), op
    for op in admin_mod.DATASET_WRITES:
        assert op in admin_mod.OPERATIONS and op not in admin_mod.READ_ONLY, op
        assert not op.endswith(("_get", "_list")), "a write is never retried, so it never looks like a read"
    for op in admin_mod.DATASET_READS + admin_mod.DATASET_WRITES + admin_mod.TRACKING_READS:
        assert callable(getattr(admin_mod.Admin, f"op_{op}")), op
    assert len(set(admin_mod.OPERATIONS)) == len(admin_mod.OPERATIONS), "each operation is declared once"
    assert {"datasets", "collections", "groups", "handouts", "notices"} <= set(RECORD_KINDS)


def test_an_assignment_keeps_its_positional_form() -> None:
    a = Assignment("A01", "sub-001/eeg/x.edf", "standard", "", 3, "t-000000000001")
    assert (a.task_id, a.handout_id, a.assigned_at) == ("t-000000000001", "", "")
    assert Assignment("A01", "r", handout_id="h-0123456789").handout_id == "h-0123456789"


# ================================================================== on the study server
import copy  # noqa: E402
import json  # noqa: E402
import sqlite3  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any  # noqa: E402

import pytest  # noqa: E402

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.web import datasets as datasets_mod  # noqa: E402
from electrotag.web.app import create_app  # noqa: E402
from tests.web_helpers import SUB1, SUB2, SUB3, Api, admin_audit, ann, copy_demo, make_template, match_body, submission  # noqa: E402,E501

PASSWORD = "long enough"
SECRET_WORDS = ("Zanzibar-dataset-name", "Quokka-description", "Narwhal-notes", "Pangolin-collection",
                "Axolotl-coll-description", "Okapi-team-note")


BLINK = ann("a1", "Eye-blink-artifact", 100, 50)


def rq(n: int) -> str:
    return f"{n:032x}"


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-datasets"))


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


def copies(app: Any, n: int, *, dataset_id: str | None = None, start: int = 0) -> list[str]:
    """``n`` more study recordings (copies of SUB3's manifest with their own IDs and fingerprints)."""
    store = app.state.store
    base = store.manifest("study", SUB3)
    out = []
    for i in range(start, start + n):
        m = copy.deepcopy(base)
        m["recording_id"] = f"sub-1{i:02d}/eeg/sub-1{i:02d}_task-rest_eeg.edf"
        m["file_name"] = f"sub-1{i:02d}_task-rest_eeg.edf"
        m["fingerprint"]["eeg"]["sha256"] = f"{i + 1:064x}"
        if dataset_id:
            m["registration"] = {**m.get("registration", {}), "dataset_id": dataset_id}
        store.add_manifest(m)
        out.append(m["recording_id"])
    return out


def wire(app: Any, rid: str, n: int) -> dict[str, Any]:
    """A manifest as the browser sends it: SUB3's, under the ID ``rid`` with its own fingerprint."""
    m = copy.deepcopy(app.state.store.manifest("study", SUB3))
    m.pop("registration", None)
    m["recording_id"] = m["relative_path"] = rid
    m["file_name"] = rid.rsplit("/", 1)[-1]
    m["files"]["path"] = rid
    m["files"]["stem"] = m["file_name"].rsplit(".", 1)[0]
    m["fingerprint"]["eeg"]["sha256"] = f"{n + 500:064x}"
    return m


def make_dataset(admin: Api, n: int, **body: Any) -> dict[str, Any]:
    return admin.admin_ok("dataset_create", {"request_id": rq(n), "name": f"Dataset {n}", **body})["dataset"]


def ops_in_audit(admin: Api) -> list[str]:
    return [e["op"] for e in admin_audit(admin, 200)]


def standard(api: Api) -> dict[str, dict[str, Any]]:
    return {i["recording_id"]: i for i in api.ok("get", "/assignments")["items"] if i["mode"] == "standard"}


# ------------------------------------------------------------------ datasets
def test_the_default_dataset_holds_every_recording_until_others_are_made(app: Any, admin: Api) -> None:
    listed = admin.admin_ok("datasets_list")
    assert listed["default_id"] == "study-recordings"
    (d,) = listed["datasets"]
    assert (d["dataset_id"], d["name"], d["default"], d["state"]) == ("study-recordings", "Study recordings", True,
                                                                       "active")
    assert d["summary"]["n_recordings"] == 3 and d["summary"]["formats"] == {"brainvision": 2, "edf": 1}
    assert d["ratings_target"] == 2 and d["ratings"] == {"0": 3, "1": 0, "2": 0, "3+": 0} and not d["fully_rated"]
    got = admin.admin_ok("dataset_get", {"dataset_id": "study-recordings"})
    assert [r["recording_id"] for r in got["recordings"]] == sorted([SUB1, SUB2, SUB3])
    assert {r["n_given"] for r in got["recordings"]} == {2}, "A01 and A02 hold every recording of the demonstration"
    rec = admin.admin_ok("recordings_list", {"scope": "study"})["recordings"]
    assert {r["dataset_id"] for r in rec} == {"study-recordings"}
    assert app.state.store.records("datasets") == [], "the built-in dataset has no record until it is edited"
    admin.admin_ok("dataset_update", {"dataset_id": "study-recordings", "licence": "CC0"})
    assert [r["dataset_id"] for r in app.state.store.records("datasets")] == ["study-recordings"]
    admin.admin_error("dataset_update", {"dataset_id": "study-recordings", "state": "archived"}, 409, "default_dataset")
    admin.admin_error("dataset_remove", {"dataset_id": "study-recordings"}, 409, "default_dataset")


def test_a_dataset_is_made_once_per_request_and_checked(admin: Api) -> None:
    body = {"request_id": rq(1), "dataset_id": "youth-ld", "name": "Youth low-density 2026", "licence": "CC0",
            "origin": "https://openneuro.org/datasets/ds003420", "ratings_target": 3}
    first = admin.admin_ok("dataset_create", body)
    again = admin.admin_ok("dataset_create", body)
    assert (first["already"], again["already"]) == (False, True)
    assert again["dataset"]["dataset_id"] == "youth-ld" and again["dataset"]["ratings_target"] == 3
    admin.admin_error("dataset_create", {**body, "request_id": rq(2)}, 409, "dataset_exists")
    admin.admin_error("dataset_create", {**body, "request_id": rq(3), "dataset_id": "study-recordings"}, 409,
                      "dataset_exists")
    for bad in ({"dataset_id": "has.dot"}, {"path_prefix": "../up"}, {"ratings_target": 0},
                {"ratings_target": 21}, {"name": ""}, {"request_id": "nope"}):
        admin.admin_error("dataset_create", {**body, "request_id": rq(4), "dataset_id": "x1", **bad}, 400,
                          "bad_request")
    made = admin.admin_ok("dataset_create", {"request_id": rq(5), "name": "OpenNeuro ds003420!"})["dataset"]
    assert made["dataset_id"] == "openneuro-ds003420" and made["ratings_target"] == 2
    upd = admin.admin_ok("dataset_update", {"dataset_id": "youth-ld", "notes": "From the 2026 sessions",
                                            "state": "archived"})
    assert upd["changed"] == ["notes", "state"] and upd["dataset"]["state"] == "archived"
    assert admin.admin_ok("dataset_update", {"dataset_id": "youth-ld", "notes": "From the 2026 sessions"})[
        "changed"] == []
    assert [d["dataset_id"] for d in admin.admin_ok("datasets_list", {"state": "archived"})["datasets"]] == \
        ["youth-ld"]


def test_registering_into_a_dataset_refuses_another_datasets_id_and_applies_its_prefix(app: Any, admin: Api) -> None:
    make_dataset(admin, 1, dataset_id="ds-a")
    make_dataset(admin, 2, dataset_id="ds-b", path_prefix="ds-b/")
    rid = "sub-201/eeg/sub-201_task-rest_eeg.edf"
    first = admin.admin_ok("recordings_register", {"manifests": [wire(app, rid, 1)], "dataset_id": "ds-a"})
    assert first["added"] == [rid]
    assert app.state.store.manifest("study", rid)["registration"]["dataset_id"] == "ds-a"
    # the same ID from the default dataset, even replacing: refused, and the recording of ds-a is left as it was
    for replace in (False, True):
        r = admin.admin_ok("recordings_register", {"manifests": [wire(app, rid, 2)], "replace": replace})
        assert r["added"] == [] and r["replaced"] == []
        assert "dataset ds-a" in r["skipped"][0]["reason"]
    assert app.state.store.manifest("study", rid)["fingerprint"]["eeg"]["sha256"] == f"{501:064x}"
    # a prefix keeps them apart: the prefixed ID, with every path inside the dataset prefixed
    r = admin.admin_ok("recordings_register", {"manifests": [wire(app, rid, 3)], "dataset_id": "ds-b"})
    assert r["added"] == [f"ds-b/{rid}"]
    m = app.state.store.manifest("study", f"ds-b/{rid}")
    assert m["files"]["path"] == m["relative_path"] == f"ds-b/{rid}" and m["file_name"] == "sub-201_task-rest_eeg.edf"
    assert m["registration"]["dataset_id"] == "ds-b"
    admin.admin_error("dataset_update", {"dataset_id": "ds-b", "path_prefix": "other"}, 409, "has_recordings")
    admin.admin_error("recordings_register", {"manifests": [wire(app, rid, 4)], "dataset_id": "nope"}, 404,
                      "unknown_dataset")
    admin.admin_ok("dataset_update", {"dataset_id": "ds-a", "state": "archived"})
    admin.admin_error("recordings_register", {"manifests": [wire(app, rid, 5)], "dataset_id": "ds-a"}, 409,
                      "archived")
    listed = admin.admin_ok("recordings_list", {"dataset_id": "ds-b"})["recordings"]
    assert [r["recording_id"] for r in listed] == [f"ds-b/{rid}"]
    entry = next(e for e in admin_audit(admin) if e["op"] == "recordings_register")
    assert entry["details"]["dataset_id"] == "ds-b"


def test_prefix_manifest_prefixes_every_path_inside_the_dataset() -> None:
    from electrotag.web.manifest import prefix_manifest

    m = {"recording_id": "sub-1/eeg/a.vhdr", "relative_path": "sub-1/eeg/a.vhdr",
         "files": {"stem": "a", "path": "sub-1/eeg/a.vhdr", "eeg": "sub-1/eeg/a.eeg", "vmrk": None,
                   "eeg_json_chain": ["task-rest_eeg.json"]},
         "fingerprint": {"eeg": {"sha256": "0" * 64, "size": 3, "path": "sub-1/eeg/a.eeg"}},
         "original_events": {"source": "tsv", "path": "sub-1/eeg/a_events.tsv"}}
    out = prefix_manifest(m, "/p/")
    assert out["recording_id"] == out["relative_path"] == out["files"]["path"] == "p/sub-1/eeg/a.vhdr"
    assert (out["files"]["stem"], out["files"]["vmrk"], out["files"]["eeg_json_chain"]) == \
        ("a", None, ["p/task-rest_eeg.json"])
    assert out["fingerprint"]["eeg"]["path"] == "p/sub-1/eeg/a.eeg"
    assert out["original_events"]["path"] == "p/sub-1/eeg/a_events.tsv"
    assert m["recording_id"] == "sub-1/eeg/a.vhdr", "the original is left as it was"
    assert prefix_manifest(m, "") is m


def test_moving_and_removing_datasets(app: Any, admin: Api) -> None:
    make_dataset(admin, 1, dataset_id="pilot")
    moved = admin.admin_ok("recordings_move", {"recording_ids": [SUB1, SUB2], "dataset_id": "pilot"})
    assert moved == {"moved": [SUB1, SUB2], "already": []}
    assert admin.admin_ok("recordings_move", {"recording_ids": [SUB1], "dataset_id": "pilot"})["already"] == [SUB1]
    got = admin.admin_ok("dataset_get", {"dataset_id": "pilot"})
    assert got["dataset"]["summary"]["n_recordings"] == 2 and len(got["recordings"]) == 2
    admin.admin_error("recordings_move", {"recording_ids": ["nope.edf"], "dataset_id": "pilot"}, 404,
                      "unknown_recording")
    admin.admin_error("recordings_move", {"recording_ids": [SUB1], "dataset_id": "nope"}, 404, "unknown_dataset")
    admin.admin_error("dataset_remove", {"dataset_id": "pilot"}, 409, "not_empty")
    admin.admin_ok("recordings_move", {"recording_ids": [SUB1, SUB2], "dataset_id": "study-recordings"})
    assert "dataset_id" not in app.state.store.manifest("study", SUB1)["registration"]
    admin.admin_ok("handout_create", {"request_id": rq(9), "target": {"kind": "dataset", "id": "pilot"},
                                      "people": ["A03"], "mode": "all"})
    admin.admin_error("dataset_remove", {"dataset_id": "pilot"}, 409, "in_use")
    hid = admin.admin_ok("handouts_list")["handouts"][0]["handout_id"]
    admin.admin_ok("handout_withdraw", {"handout_id": hid})
    admin.admin_ok("dataset_remove", {"dataset_id": "pilot"})
    assert [d["dataset_id"] for d in admin.admin_ok("datasets_list")["datasets"]] == ["study-recordings"]
    admin.admin_error("dataset_get", {"dataset_id": "pilot"}, 404, "unknown_dataset")


# ------------------------------------------------------------------ collections
def test_collections_keep_their_order_and_lose_a_removed_recording(app: Any, admin: Api) -> None:
    extra = copies(app, 3)
    body = {"request_id": rq(1), "name": "Pilot: hard recordings", "recording_ids": [extra[2], SUB1, SUB1, "nope"]}
    made = admin.admin_ok("collection_create", body)
    c = made["collection"]
    assert c["recording_ids"] == [extra[2], SUB1] and c["collection_id"].startswith("c-")
    assert made["skipped"] == [{"recording_id": SUB1, "reason": "twice"}, {"recording_id": "nope",
                                                                           "reason": "not_registered"}]
    assert admin.admin_ok("collection_create", body)["already"] is True
    cid = c["collection_id"]
    upd = admin.admin_ok("collection_update", {"collection_id": cid, "add": [extra[0], SUB1], "remove": [extra[2]]})
    assert upd["collection"]["recording_ids"] == [SUB1, extra[0]] and upd["changed"] == ["recordings"]
    upd = admin.admin_ok("collection_update", {"collection_id": cid, "order": [extra[0], SUB1], "ratings_target": 1})
    assert upd["collection"]["recording_ids"] == [extra[0], SUB1] and upd["collection"]["ratings_target"] == 1
    assert upd["collection"]["changes"][-1]["reordered"] is True
    admin.admin_error("collection_update", {"collection_id": cid, "order": [SUB1]}, 400, "bad_request")
    admin.admin_error("collection_update", {"collection_id": cid, "add": ["nope"]}, 404, "unknown_recording")
    admin.admin_error("collection_create", {"request_id": rq(2), "name": "big", "recording_ids": ["r"] * 2001}, 413,
                      "too_large")
    admin.admin_ok("recording_remove", {"recording_id": extra[0]})
    got = admin.admin_ok("collection_get", {"collection_id": cid})
    assert got["collection"]["recording_ids"] == [SUB1] and [r["recording_id"] for r in got["recordings"]] == [SUB1]
    entry = next(e for e in admin_audit(admin) if e["op"] == "recording_remove")
    assert entry["details"]["collections"] == [cid]
    assert [x["collection_id"] for x in admin.admin_ok("collections_list")["collections"]] == [cid]
    assert "recording_ids" not in admin.admin_ok("collections_list")["collections"][0]
    admin.admin_ok("collection_remove", {"collection_id": cid})
    admin.admin_error("collection_get", {"collection_id": cid}, 404, "unknown_collection")


# ------------------------------------------------------------------ groups
def test_groups_keep_the_history_of_who_joined_and_left(client: TestClient, admin: Api) -> None:
    g = admin.admin_ok("group_create", {"request_id": rq(1), "name": "Leeds RAs", "members": ["A03", "A04"]})["group"]
    gid = g["group_id"]
    assert g["members"] == ["A03", "A04"] and len(g["history"]) == 2
    admin.admin_error("group_create", {"request_id": rq(2), "name": "x", "members": ["Z99"]}, 404, "unknown_user")
    upd = admin.admin_ok("group_update", {"group_id": gid, "add": ["A05", "A03"], "remove": ["A04"]})
    assert upd["group"]["members"] == ["A03", "A05"] and upd["changed"] == ["added", "removed"]
    assert admin.admin_ok("group_update", {"group_id": gid, "add": ["A03"]})["changed"] == []
    upd = admin.admin_ok("group_update", {"group_id": gid, "add": ["A04"]})
    rows = [r for r in upd["group"]["history"] if r["annotator_id"] == "A04"]
    assert len(rows) == 2 and rows[0]["removed_at"] and rows[1]["removed_at"] is None, "joining again: a new row"
    admin.admin_ok("user_remove", {"annotator_id": "A05"})
    g = admin.admin_ok("groups_list")["groups"][0]
    assert g["members"] == ["A03", "A04"]
    assert next(r for r in g["history"] if r["annotator_id"] == "A05")["removed_by"] == "account removed"
    admin.admin_ok("group_remove", {"group_id": gid})
    assert admin.admin_ok("groups_list")["groups"] == []


# ------------------------------------------------------------------ hand-outs, everyone gets all of it
def test_an_all_hand_out_gives_links_skips_retired_and_is_made_once(app: Any, client: TestClient,
                                                                     admin: Api) -> None:
    from electrotag.training.reference import ReferenceSet
    from tests.web_helpers import PRACTICE1

    rs = ReferenceSet.load(app.state.store.reference_set("example").directory)
    rs.set_use(PRACTICE1, "assessment")  # so the trainee T01's study work waits for the assessment
    rs.save()
    extra = copies(app, 3, dataset_id="ds")
    make_dataset(admin, 1, dataset_id="ds")
    admin.admin_ok("recording_update", {"recording_id": extra[2], "retired": True})
    admin.admin_ok("assign", {"annotator_ids": ["A03"], "recording_ids": [extra[0]]})  # before the hand-out
    body = {"target": {"kind": "dataset", "id": "ds"}, "people": ["A03", "A04", "T01"], "mode": "all",
            "due_at": "2026-11-20"}
    preview = admin.admin_ok("handouts_preview_get", body)
    assert preview["recordings"] == 2 and preview["skipped"] == [{"recording_id": extra[2], "reason": "retired"}]
    assert {r["annotator_id"]: (r["new"], r["already"]) for r in preview["recipients"]} == \
        {"A03": (1, 1), "A04": (2, 0), "T01": (2, 0)}
    assert any("T01" in w and "trainee" in w for w in preview["warnings"]), preview["warnings"]
    assert app.state.store.records("handouts") == [], "a preview keeps nothing"
    made = admin.admin_ok("handout_create", {**body, "request_id": rq(7)})
    assert (made["added"], made["already_had"], made["already"]) == (5, 1, False)
    h = made["handout"]
    assert h["title"] == "Dataset 1" and h["name"] == "Dataset 1" and h["mode"] == "all"
    assert h["counts"]["given"] == 6 and h["counts"]["people"] == 3 and h["new_recordings"] == 0
    again = admin.admin_ok("handout_create", {**body, "request_id": rq(7)})
    assert again["already"] is True and len(app.state.store.records("handouts")) == 1
    by = {(a.annotator_id, a.recording_id): a for a in app.state.store.assignments() if a.recording_id in extra}
    assert {k for k in by} == {(p, r) for p in ("A03", "A04", "T01") for r in extra[:2]}
    assert {a.handout_id for a in by.values()} == {h["handout_id"]}, "made or linked: each carries the hand-out"
    assert all(a.assigned_at for a in by.values()), "the files store says when each was made"
    items = standard(person(client, "A04"))
    assert items[extra[0]]["handout"] == {"handout_id": h["handout_id"], "title": "Dataset 1",
                                          "due_at": "2026-11-20", "overdue": False}
    assert {i["handout"] is None for i in standard(person(client, "A01")).values()} == {True}
    entry = next(e for e in admin_audit(admin) if e["op"] == "handout_create")
    assert entry["details"]["added"] == 5 and entry["details"]["mode"] == "all"


def test_withdrawing_takes_back_only_what_nobody_started(app: Any, client: TestClient, admin: Api,
                                                         recordings: Path) -> None:
    admin.admin_ok("dataset_create", {"request_id": rq(1), "dataset_id": "ds", "name": "DS"})
    admin.admin_ok("recordings_move", {"recording_ids": [SUB1, SUB2, SUB3], "dataset_id": "ds"})
    made = admin.admin_ok("handout_create", {"request_id": rq(2), "target": {"kind": "dataset", "id": "ds"},
                                             "people": ["A01", "A03"], "mode": "all"})
    hid = made["handout"]["handout_id"]
    assert made["added"] == 3 and made["already_had"] == 3, "A01 held them all already: linked"
    a03 = person(client, "A03")
    a03.ok("post", "/submissions", submission(recordings, SUB1, [ann("a1", "Eye-blink-artifact", 100, 50)]))
    a03.ok("put", f"/drafts/{SUB2}", {"annotations": [], "view": {}, "elapsed_s": 3.0})
    out = admin.admin_ok("handout_withdraw", {"handout_id": hid})
    assert (out["removed"], out["kept"]) == (1, 5) and out["handout"]["state"] == "withdrawn"
    left = {(a.annotator_id, a.recording_id) for a in app.state.store.assignments() if a.mode == "standard"}
    assert ("A03", SUB3) not in left and {("A03", SUB1), ("A03", SUB2)} <= left
    assert {("A01", r) for r in (SUB1, SUB2, SUB3)} <= left, "A01's earlier assignments keep their place"
    assert not any(a.handout_id for a in app.state.store.assignments())
    admin.admin_error("handout_withdraw", {"handout_id": hid}, 409, "already_withdrawn")
    admin.admin_error("handout_update", {"handout_id": hid, "due_at": None}, 409, "withdrawn")


# ------------------------------------------------------------------ hand-outs, k per recording
def test_a_k_hand_out_is_a_tasks_share_out(app: Any, admin: Api) -> None:
    extra = copies(app, 6)
    c = admin.admin_ok("collection_create", {"request_id": rq(1), "name": "Pangolin", "recording_ids": extra})[
        "collection"]
    pool = ["A03", "A04", "A05"]
    body = {"target": {"kind": "collection", "id": c["collection_id"]}, "people": pool, "mode": "k", "k": 2}
    preview = admin.admin_ok("handouts_preview_get", body)
    tasks_preview = admin.admin_ok("tasks_preview_get", {"annotator_ids": pool, "recording_ids": extra, "k": 2,
                                                         "batch": "Pangolin", "notes": ""})
    assert preview["tasks_preview"] == tasks_preview, "the share-out and its preview are Tasks' own"
    assert sum(r["new"] for r in preview["recipients"]) == 12
    made = admin.admin_ok("handout_create", {**body, "request_id": rq(2)})
    h = made["handout"]
    assert h["title"] == "Recordings to annotate", "a collection's name never reaches annotators"
    assert h["n_tasks"] == 6 and made["tasks"]["created"] == 6 and h["counts"]["given"] == 12
    tasks = admin.admin_ok("tasks_list")["tasks"]
    assert len(tasks) == 6
    records = app.state.store.records("tasks")
    assert {t.get("handout_id") for t in records} == {h["handout_id"]}
    assert {a.handout_id for a in app.state.store.assignments() if a.recording_id in extra} == {h["handout_id"]}
    again = admin.admin_ok("handouts_preview_get", {**body, "people": ["A01", "A02"]})
    assert {s["reason"] for s in again["skipped"]} == {"has_task"}
    assert any("open task already" in w for w in again["warnings"])
    admin.admin_error("handouts_preview_get", {**body, "k": 7}, 400, "bad_request")
    admin.admin_error("handouts_preview_get", {**body, "people": ["A03"], "k": 2}, 400, "k_too_large")
    out = admin.admin_ok("handout_withdraw", {"handout_id": h["handout_id"]})
    assert out["removed"] == 6 and admin.admin_ok("tasks_list")["tasks"] == []


# ------------------------------------------------------------------ following groups
def test_people_who_join_a_group_get_what_it_follows(app: Any, admin: Api) -> None:
    extra = copies(app, 2, dataset_id="ds")
    make_dataset(admin, 1, dataset_id="ds")
    gid = admin.admin_ok("group_create", {"request_id": rq(2), "name": "RAs", "members": ["A03"]})["group"]["group_id"]
    h = admin.admin_ok("handout_create", {"request_id": rq(3), "target": {"kind": "dataset", "id": "ds"},
                                          "groups": [gid], "mode": "all", "follow_groups": True})["handout"]
    assert [r["via"] for r in h["recipients"]] == [f"group:{gid}"]
    upd = admin.admin_ok("group_update", {"group_id": gid, "add": ["A04"]})
    assert upd["given"] == [{"handout_id": h["handout_id"], "annotator_id": "A04", "added": 2}]
    held = {a.recording_id for a in app.state.store.assignments("A04")}
    assert set(extra) <= held
    upd = admin.admin_ok("group_update", {"group_id": gid, "add": ["A05"], "give_existing": False})
    assert upd["given"] == [] and not {a.recording_id for a in app.state.store.assignments("A05")}
    got = admin.admin_ok("handouts_list")["handouts"][0]
    assert [r["annotator_id"] for r in got["recipients"]] == ["A03", "A04"]
    assert got["counts"]["given"] == 4
    entry = next(e for e in admin_audit(admin) if e["op"] == "group_update" and e["details"]["given"])
    assert entry["details"]["given"][0]["annotator_id"] == "A04"
    admin.admin_error("group_remove", {"group_id": gid}, 409, "in_use")
    # new recordings wait until the team gives them
    more = copies(app, 1, dataset_id="ds", start=10)
    assert admin.admin_ok("handouts_list")["handouts"][0]["new_recordings"] == 1
    out = admin.admin_ok("handout_update", {"handout_id": h["handout_id"], "give_new_recordings": True})
    assert out["added"] == 2 and out["handout"]["new_recordings"] == 0
    assert more[0] in {a.recording_id for a in app.state.store.assignments("A03")}


# ------------------------------------------------------------------ due dates
def test_due_dates_and_overdue_work(app: Any, client: TestClient, admin: Api, recordings: Path,
                                    monkeypatch: pytest.MonkeyPatch) -> None:
    c = admin.admin_ok("collection_create", {"request_id": rq(1), "name": "Due", "recording_ids": [SUB1, SUB2]})[
        "collection"]
    h = admin.admin_ok("handout_create", {"request_id": rq(2), "target": {"kind": "collection",
                                                                          "id": c["collection_id"]},
                                          "people": ["A03", "A04"], "mode": "all", "due_at": "2026-11-20"})["handout"]
    assert h["title"] == "Recordings due 20 November"
    for rid in (SUB1, SUB2):
        person(client, "A04").ok("post", "/submissions", submission(recordings, rid, [BLINK]))

    def on(day: str) -> None:
        monkeypatch.setattr(datasets_mod, "now_local_iso", lambda: f"{day}T09:00:00.000+00:00")

    on("2026-11-20")
    assert admin.admin_ok("handouts_list", {"overdue": True})["handouts"] == [], "due today is not yet overdue"
    on("2026-11-21")
    listed = admin.admin_ok("handouts_list", {"overdue": True})
    assert listed["today"] == "2026-11-21" and len(listed["handouts"]) == 1
    per = {p["annotator_id"]: p for p in listed["handouts"][0]["per_person"]}
    assert per["A03"]["overdue"] and per["A03"]["remaining"] == 2 and not per["A04"]["overdue"]
    assert admin.admin_ok("handouts_list", {"annotator_id": "A04", "overdue": True})["handouts"] == []
    counts = admin.admin_ok("overview")["counts"]
    assert (counts["overdue"], counts["handouts_open"]) == (1, 1)
    a03 = person(client, "A03").ok("get", "/assignments")
    assert a03["due"] == [{"handout_id": h["handout_id"], "title": "Recordings due 20 November",
                           "due_at": "2026-11-20", "total": 2, "remaining": 2, "overdue": True}]
    assert {i["handout"]["overdue"] for i in a03["items"] if i["handout"]} == {True}
    a04 = person(client, "A04").ok("get", "/assignments")
    assert a04["due"][0]["remaining"] == 0 and not a04["due"][0]["overdue"]
    assert {i["handout"]["overdue"] for i in a04["items"] if i["handout"]} == {False}, "done work is never overdue"
    admin.admin_ok("handout_update", {"handout_id": h["handout_id"], "due_at": "2026-12-01"})
    assert admin.admin_ok("overview")["counts"]["overdue"] == 0
    admin.admin_ok("handout_update", {"handout_id": h["handout_id"], "due_at": None})
    assert person(client, "A03").ok("get", "/assignments")["due"] == []
    admin.admin_error("handout_update", {"handout_id": h["handout_id"], "due_at": "20 Nov"}, 400, "bad_request")


# ------------------------------------------------------------------ ratings target
def test_a_recording_is_rated_when_enough_people_saved_it(app: Any, client: TestClient, admin: Api,
                                                          recordings: Path) -> None:
    make_dataset(admin, 1, dataset_id="ds", ratings_target=2)
    admin.admin_ok("recordings_move", {"recording_ids": [SUB1, SUB2], "dataset_id": "ds"})
    a01, a02 = person(client, "A01"), person(client, "A02")
    a01.ok("post", "/submissions", submission(recordings, SUB1, [ann("a1", "Eye-blink-artifact", 100, 50)]))
    a01.ok("post", "/submissions", {**submission(recordings, SUB1, [ann("a1", "Eye-blink-artifact", 100, 60)]),
                                    "revises": 1})  # a revision counts once
    d = admin.admin_ok("dataset_get", {"dataset_id": "ds"})
    assert d["dataset"]["ratings"] == {"0": 1, "1": 1, "2": 0, "3+": 0} and d["dataset"]["n_rated"] == 0
    a02.ok("post", "/submissions", submission(recordings, SUB1, [ann("a1", "Eye-blink-artifact", 100, 50)]))
    d = admin.admin_ok("dataset_get", {"dataset_id": "ds"})["dataset"]
    assert d["n_rated"] == 1 and not d["fully_rated"]
    admin.admin_ok("recording_update", {"recording_id": SUB2, "retired": True})
    assert admin.admin_ok("dataset_get", {"dataset_id": "ds"})["dataset"]["fully_rated"], \
        "every recording still in use met its target"
    admin.admin_ok("dataset_update", {"dataset_id": "ds", "ratings_target": 3})
    assert not admin.admin_ok("dataset_get", {"dataset_id": "ds"})["dataset"]["fully_rated"]


# ------------------------------------------------------------------ what annotators see
def test_annotators_never_receive_dataset_or_collection_details(app: Any, client: TestClient, admin: Api,
                                                                recordings: Path) -> None:
    admin.admin_ok("dataset_create", {"request_id": rq(1), "dataset_id": "secret", "name": SECRET_WORDS[0],
                                      "description": SECRET_WORDS[1], "notes": SECRET_WORDS[2],
                                      "citation": "Cite-Kakapo", "contact": "Contact-Tuatara"})
    admin.admin_ok("recordings_move", {"recording_ids": [SUB1], "dataset_id": "secret"})
    c = admin.admin_ok("collection_create", {"request_id": rq(2), "name": SECRET_WORDS[3],
                                             "description": SECRET_WORDS[4], "recording_ids": [SUB2]})["collection"]
    for n, target in ((3, {"kind": "dataset", "id": "secret"}), (4, {"kind": "collection", "id": c["collection_id"]})):
        admin.admin_ok("handout_create", {"request_id": rq(n), "target": target, "people": ["A01"], "mode": "all",
                                          "note": SECRET_WORDS[5], "due_at": "2026-11-20",
                                          **({"title": "Morning batch"} if n == 3 else {})})
    a01 = person(client, "A01")
    seen = [a01.ok("get", "/me"), a01.ok("get", "/assignments"),
            a01.ok("post", "/match", match_body(recordings, SUB1)),
            a01.ok("post", "/match", match_body(recordings, SUB2)),
            a01.ok("get", "/me/achievements")]
    text = json.dumps(seen)
    for word in (*SECRET_WORDS, "Cite-Kakapo", "Contact-Tuatara", "secret\""):
        assert word not in text, word
    titles = {d["title"] for d in seen[1]["due"]}
    assert titles == {"Morning batch", "Recordings due 20 November"}


# ------------------------------------------------------------------ the audit log
def test_every_write_is_audited(app: Any, admin: Api) -> None:
    copies(app, 2, dataset_id="ds")
    make_dataset(admin, 1, dataset_id="ds")
    admin.admin_ok("dataset_update", {"dataset_id": "ds", "licence": "CC-BY"})
    c = admin.admin_ok("collection_create", {"request_id": rq(2), "name": "C", "recording_ids": [SUB1]})["collection"]
    admin.admin_ok("collection_update", {"collection_id": c["collection_id"], "add": [SUB2]})
    g = admin.admin_ok("group_create", {"request_id": rq(3), "name": "G", "members": ["A03"]})["group"]
    admin.admin_ok("group_update", {"group_id": g["group_id"], "add": ["A04"]})
    h = admin.admin_ok("handout_create", {"request_id": rq(4), "target": {"kind": "dataset", "id": "ds"},
                                          "groups": [g["group_id"]], "mode": "all", "note": SECRET_WORDS[5]})["handout"]
    admin.admin_ok("handout_update", {"handout_id": h["handout_id"], "due_at": "2026-12-01"})
    admin.admin_ok("handout_withdraw", {"handout_id": h["handout_id"]})
    admin.admin_ok("recordings_move", {"recording_ids": [SUB3], "dataset_id": "ds"})
    admin.admin_ok("collection_remove", {"collection_id": c["collection_id"]})
    admin.admin_ok("group_remove", {"group_id": g["group_id"]})
    make_dataset(admin, 5, dataset_id="empty")
    admin.admin_ok("dataset_remove", {"dataset_id": "empty"})
    ops = ops_in_audit(admin)
    for op in datasets_mod_writes():
        assert op in ops, op
    entries = admin_audit(admin, 200)
    assert SECRET_WORDS[5] not in json.dumps(entries), "the team's note is counted, never copied"
    assert next(e for e in entries if e["op"] == "handout_create")["details"]["note_chars"] == len(SECRET_WORDS[5])


def datasets_mod_writes() -> tuple[str, ...]:
    return admin_mod.DATASET_WRITES


# ------------------------------------------------------------------ the files store
def test_an_older_database_gains_the_handout_column(tmp_path: Path) -> None:
    from electrotag.web.accounts import Accounts as AccountsDB

    path = tmp_path / "accounts.sqlite"
    db = sqlite3.connect(path)
    db.executescript("CREATE TABLE assignments (annotator_id TEXT NOT NULL, recording_id TEXT NOT NULL, mode TEXT NOT "
                     "NULL DEFAULT 'standard', context_id TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT "
                     "0, created_at TEXT NOT NULL, task_id TEXT NOT NULL DEFAULT '', PRIMARY KEY (annotator_id, "
                     "recording_id, mode, context_id));"
                     "INSERT INTO assignments VALUES ('A01', 'r1', 'standard', '', 1, '2026-10-01T10:00:00+00:00', '')")
    db.commit()
    db.close()
    accounts = AccountsDB(path)
    try:
        (a,) = accounts.assignments("A01")
        assert (a.handout_id, a.assigned_at) == ("", "2026-10-01T10:00:00+00:00")
        assert accounts.assign_many("A01", [("r1", ""), ("r2", "t-000000000001")], handout_id="h-0000000001") == 1
        got = {x.recording_id: x for x in accounts.assignments("A01")}
        assert got["r1"].handout_id == "h-0000000001", "an assignment made before its hand-out is linked to it"
        assert (got["r2"].task_id, got["r2"].handout_id) == ("t-000000000001", "h-0000000001")
        assert accounts.unlink_handout("h-0000000001") == 2
        assert {x.handout_id for x in accounts.assignments("A01")} == {""}
    finally:
        accounts.close()


def test_the_files_store_lists_openings_and_light_manifests(app: Any, client: TestClient) -> None:
    store = app.state.store
    a01 = person(client, "A01")
    vid = a01.ok("post", "/visits", {"mode": "standard"})["visit_id"]
    a01.ok("post", f"/visits/{vid}/events", {"events": [{"type": "recording_opened", "t": 12.5, "recording": SUB1,
                                                         "mode": "standard", "window_no": 1}]})
    (o,) = [o for o in store.opened_index() if o["recording_id"] == SUB1]
    assert o["annotator_id"] == "A01" and o["mode"] == "standard" and o["opened_at"]
    heads = {h["recording_id"]: h for h in store.manifest_heads("study")}
    assert set(heads) == {SUB1, SUB2, SUB3}
    assert heads[SUB3]["format"] == "edf" and heads[SUB3]["dataset_id"] == "" and heads[SUB3]["n_channels"] > 0
