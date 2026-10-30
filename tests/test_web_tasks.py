"""Tasks, windows and known answers (electrotag/web/tasks.py, docs/web/api.md "Tasks, windows and known answers").

An administrator shares recordings, or stretches of them, out among k annotators with a preview first; the
share-out is balanced and the same for the same request; a window is enforced when drafts and saves arrive;
known-answer (gold) tasks are scored after a save and kept out of the adjudication queue; statuses are
derived from the saved work; and nothing an annotator saved is ever lost when a task changes."""

from __future__ import annotations

import base64
import copy
import io
import zipfile
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.web import tasks as tasks_mod  # noqa: E402
from electrotag.web.app import create_app  # noqa: E402
from tests.web_helpers import SUB1, SUB2, SUB3, Api, admin_audit, ann, copy_demo, make_template, match_body, submission  # noqa: E402,E501

PASSWORD = "long enough"
POOL = ["A01", "A02", "A03", "A04", "A05", "A06"]


def rid_hex(n: int) -> str:
    return f"{n:032x}"


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-tasks"))


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
    api = Api(client, "ADMIN")
    for aid in ("A03", "A04", "A05", "A06"):
        api.admin_ok("user_add", {"annotator_id": aid, "display_name": f"Annotator {aid[-1]}", "password": PASSWORD})
    return api


def person(client: TestClient, aid: str) -> Api:
    return Api(client, aid, PASSWORD if aid in ("A03", "A04", "A05", "A06") else "electrotag")


def item(api: Api, rid: str) -> dict[str, Any]:
    items = api.ok("get", "/assignments")["items"]
    return next(i for i in items if i["recording_id"] == rid and i["mode"] == "standard")


def create(admin: Api, n: int, **body: Any) -> dict[str, Any]:
    return admin.admin_ok("tasks_create", {"request_id": rid_hex(n), **body})


def add_copies(app: Any, n: int) -> list[str]:
    """``n`` more study recordings (copies of SUB3's description with their own IDs and fingerprints): enough to
    share out without making EEG files (nothing here opens them)."""
    store = app.state.store
    base = store.manifest("study", SUB3)
    out = []
    for i in range(n):
        m = copy.deepcopy(base)
        m["recording_id"] = f"sub-1{i:02d}/eeg/sub-1{i:02d}_task-rest_eeg.edf"
        m["file_name"] = f"sub-1{i:02d}_task-rest_eeg.edf"
        m["fingerprint"]["eeg"]["sha256"] = f"{i + 1:064x}"
        store.add_manifest(m)
        out.append(m["recording_id"])
    return out


# ------------------------------------------------------------------ pure pieces
def test_windows_letters_and_clock() -> None:
    w = tasks_mod.windows_of
    assert w(7680, 128.0, None) == [None]
    assert w(7680, 128.0, {"kind": "one", "start_s": 10.0, "end_s": 30.0}) == [(1280, 3840)]
    assert w(7680, 128.0, {"kind": "many", "length_s": 20.0, "overlap_s": 0.0}) == [(0, 2560), (2560, 5120),
                                                                                    (5120, 7680)]
    # a remainder shorter than half a window joins the window before; a longer one is a window of its own
    assert w(7680, 128.0, {"kind": "many", "length_s": 25.0, "overlap_s": 0.0}) == [(0, 3200), (3200, 7680)]
    assert w(7680, 128.0, {"kind": "many", "length_s": 35.0, "overlap_s": 0.0}) == [(0, 4480), (4480, 7680)]
    assert w(7680, 128.0, {"kind": "many", "length_s": 20.0, "overlap_s": 5.0})[:2] == [(0, 2560), (1920, 4480)]
    assert w(7680, 128.0, {"kind": "many", "length_s": 90.0, "overlap_s": 0.0}) == [None]
    letters = tasks_mod.letters_for("s" * 64, "t-000000000001", ["A01", "A02", "A03"])
    assert sorted(letters.values()) == ["A", "B", "C"]
    assert letters == tasks_mod.letters_for("s" * 64, "t-000000000001", ["A03", "A01", "A02"]), "stable"
    orders = {tuple(sorted(tasks_mod.letters_for("s" * 64, f"t-{i:012x}", ["A01", "A02", "A03"]),
                           key=lambda a, i=i: tasks_mod.letters_for("s" * 64, f"t-{i:012x}", ["A01", "A02", "A03"])[a]))
              for i in range(30)}
    assert len(orders) > 2, "the letters are shuffled from task to task, not given in the order of the IDs"
    assert tasks_mod.next_letter({"A01": "A", "A03": "C"}) == "B"
    assert (tasks_mod.clock(5), tasks_mod.clock(90), tasks_mod.clock(3725), tasks_mod.clock(12.5)) == \
        ("0:05", "1:30", "1:02:05", "0:12.5")


# ------------------------------------------------------------- sharing out
def test_200_recordings_among_10_annotators_balanced_and_the_same_every_time(app: Any, client: TestClient,
                                                                             admin: Api) -> None:
    for i in range(7, 11):
        admin.admin_ok("user_add", {"annotator_id": f"A{i:02d}", "password": PASSWORD})
    rids = add_copies(app, 200)
    pool = [f"A{i:02d}" for i in range(1, 11)]
    body = {"recording_ids": rids, "annotator_ids": pool, "k": 2}
    preview = admin.admin_ok("tasks_preview_get", body)
    assert preview["created"] == 200 and preview["assigned"] == 400 and preview["skipped"] == []
    per = {p["annotator_id"]: p["new"] for p in preview["per_annotator"]}
    assert per == {aid: 40 for aid in pool}, "each person gets the same share"
    assert all(len(set(t["annotators"])) == 2 for t in preview["tasks"])
    pairs = {tuple(t["annotators"]) for t in preview["tasks"]}
    assert len(pairs) == 45, "every pair of the ten people shares recordings"
    assert preview["pairs"] == {"n_pairs": 45, "least": 4, "most": 5, "counts": {"4": 25, "5": 20}}, \
        "each pair shares 4 or 5 recordings (200 tasks over 45 pairs), for pairwise agreement"
    assert all(p["annotates"] and not p["study_locked"] for p in preview["per_annotator"])
    assert preview["warnings"] == []
    assert admin.admin_ok("tasks_preview_get", body) == preview, "the same request gives the same share-out"
    assert admin.admin_ok("tasks_list")["tasks"] == [], "a preview makes nothing"
    made = create(admin, 1, **body)
    assert (made["created"], made["assigned"], made["already"]) == (200, 400, False)
    assert [t["annotators"] for t in made["tasks"]] == [t["annotators"] for t in preview["tasks"]]
    assert all(t["status"] == "collecting" and t["k"] == 2 and t["window"] is None for t in made["tasks"])
    # sent again (a late answer): nothing more is made
    again = create(admin, 1, **body)
    assert again["already"] is True and again["created"] == 200
    assert len(admin.admin_ok("tasks_list")["tasks"]) == 200
    a05 = person(client, "A05")
    mine = [i for i in a05.ok("get", "/assignments")["items"] if i["task"]]
    assert len(mine) == 40 and all(i["task"]["window"] is None for i in mine)
    entries = [e for e in admin_audit(admin) if e["op"] == "tasks_create"]
    assert len(entries) == 1 and "200 tasks of 2 annotators" in entries[0]["summary"]
    # those recordings have open tasks now: asked again, every one is skipped
    third = admin.admin_ok("tasks_preview_get", body)
    assert third["created"] == 0 and {s["reason"] for s in third["skipped"]} == {"has_task"}


@pytest.mark.parametrize("k, least, most", [(2, 4, 5), (3, 13, 14)])
def test_the_share_out_evens_out_both_each_persons_share_and_each_pairs(k: int, least: int, most: int) -> None:
    """10 annotators, 200 recordings: everyone gets the same number, and every pair shares as nearly the same
    number as can be (200 * C(k, 2) / 45 on average), the same every time."""
    import itertools

    pool = [f"A{i:02d}" for i in range(1, 11)]

    def share_out() -> list[list[str]]:
        load: dict[str, int] = {}
        pairs: dict[tuple[str, str], int] = {}
        out = []
        for r in range(200):
            group = tasks_mod.choose_group(f"sub-{r:03d}/eeg/x.edf", None, list(pool), k, load, pairs)
            assert len(set(group)) == k
            for a in group:
                load[a] = load.get(a, 0) + 1
            for a, b in itertools.combinations(sorted(group), 2):
                pairs[(a, b)] = pairs.get((a, b), 0) + 1
            # at every step, nobody has more than one task more than anyone else
            assert max(load.get(a, 0) for a in pool) - min(load.get(a, 0) for a in pool) <= 1
            out.append(group)
        return out

    tasks = share_out()
    per = {a: sum(1 for t in tasks if a in t) for a in pool}
    assert set(per.values()) == {200 * k // 10}
    spread = tasks_mod.pair_spread(pool, tasks)
    assert (spread["n_pairs"], spread["least"], spread["most"]) == (45, least, most)
    assert share_out() == tasks, "deterministic"
    # people who hold the recording already come first, whatever their pairs
    group = tasks_mod.choose_group("r", None, pool, k, {}, {("A01", "A02"): 50}, {"A01", "A02"})
    assert {"A01", "A02"} <= set(group)
    assert tasks_mod.pair_spread(["A01"], tasks) is None
    # a pool too large to weigh every group is shared out one by one, still evenly
    big = [f"B{i:03d}" for i in range(300)]
    load: dict[str, int] = {}
    for r in range(100):
        for a in tasks_mod.choose_group(f"r{r}", None, big, 6, load, {}):
            load[a] = load.get(a, 0) + 1
    assert max(load.values()) == 2 and sum(load.values()) == 600


def test_the_preview_warns_about_locked_trainees_and_people_without_the_annotator_role(app: Any, admin: Api) -> None:
    from electrotag.training.reference import ReferenceSet
    from tests.web_helpers import PRACTICE1

    # the example set gets an assessment, so the trainee T01's study work waits for it
    store = app.state.store
    rs = ReferenceSet.load(store.reference_set("example").directory)
    rs.set_use(PRACTICE1, "assessment")
    rs.save()
    admin.admin_ok("user_add", {"annotator_id": "E09", "password": PASSWORD, "roles": ["expert"]})
    users = {u["annotator_id"]: u for u in admin.admin_ok("users_list")["users"]}
    assert users["T01"]["study_locked"] is True and users["A01"]["study_locked"] is False
    assert users["E09"]["study_locked"] is False, "experts are never gated"
    p = admin.admin_ok("tasks_preview_get", {"recording_ids": [SUB1, SUB2, SUB3],
                                             "annotator_ids": ["A03", "T01", "E09"], "k": 3})
    per = {r["annotator_id"]: r for r in p["per_annotator"]}
    assert (per["T01"]["study_locked"], per["T01"]["annotates"]) == (True, True)
    assert (per["E09"]["study_locked"], per["E09"]["annotates"]) == (False, False)
    assert (per["A03"]["study_locked"], per["A03"]["annotates"]) == (False, True)
    assert len(p["warnings"]) == 2
    assert p["warnings"][0].startswith("T01 is a trainee whose study work is locked")
    assert p["warnings"][1].startswith("E09 has no annotator role")
    # two people make one pair
    assert admin.admin_ok("tasks_preview_get", {"recording_ids": [SUB1], "annotator_ids": ["A03", "A04"]})["pairs"] \
        == {"n_pairs": 1, "least": 1, "most": 1, "counts": {"1": 1}}


def test_people_given_a_recording_already_come_first_and_are_linked(admin: Api, client: TestClient) -> None:
    made = create(admin, 2, recording_ids=[SUB1], annotator_ids=POOL, k=3)
    t = made["tasks"][0]
    assert {"A01", "A02"} < set(t["annotators"]) and len(t["annotators"]) == 3
    assert made["assigned"] == 1, "A01 and A02 had SUB1 already: only the third person gets a new assignment"
    assert item(person(client, "A01"), SUB1)["task"] == {"task_id": t["task_id"], "window": None}
    # nobody holds two tasks of one recording
    admin.admin_error("task_update", {"task_id": t["task_id"], "add_annotator": t["annotators"][0]}, 409,
                      "already_in_task")


def test_checks_of_a_request(admin: Api) -> None:
    admin.admin_error("tasks_create", {"recording_ids": [SUB1], "annotator_ids": POOL}, 400, "bad_request")
    admin.admin_error("tasks_preview_get", {"recording_ids": [SUB1], "annotator_ids": ["A01", "A02"], "k": 3}, 400,
                      "k_too_large")
    admin.admin_error("tasks_preview_get", {"recording_ids": [SUB1], "annotator_ids": POOL, "k": 7}, 400, "bad_request")
    admin.admin_error("tasks_preview_get", {"recording_ids": [SUB1], "annotator_ids": ["A01", "Z99"]}, 404,
                      "unknown_user")
    admin.admin_error("tasks_preview_get", {"recording_ids": ["nope"], "annotator_ids": POOL}, 404,
                      "unknown_recording")
    admin.admin_error("tasks_preview_get", {"all": True, "annotator_ids": POOL, "window": {"start_s": 0, "end_s": 1}},
                      400, "bad_request")
    admin.admin_error("tasks_preview_get", {"all": True, "annotator_ids": POOL, "adopt": True,
                                            "windows": {"length_s": 20}}, 400, "bad_request")
    admin.admin_ok("recording_update", {"scope": "study", "recording_id": SUB2, "retired": True})
    p = admin.admin_ok("tasks_preview_get", {"all": True, "annotator_ids": POOL, "k": 2})
    assert {"recording_id": SUB2, "reason": "retired"} in p["skipped"] and p["created"] == 2


def test_windows_go_to_different_people_and_too_few_are_skipped(admin: Api) -> None:
    body = {"recording_ids": [SUB3], "annotator_ids": ["A03", "A04", "A05", "A06"], "k": 2,
            "windows": {"length_s": 20, "overlap_s": 0}}
    p = admin.admin_ok("tasks_preview_get", body)
    assert [t["window"]["start_s"] for t in p["tasks"]] == [0.0, 20.0]
    assert not set(p["tasks"][0]["annotators"]) & set(p["tasks"][1]["annotators"])
    assert p["skipped"] == [{"recording_id": SUB3, "reason": "too_few_annotators", "start_s": 40.0}]
    # someone given the whole recording is left out of a window's task (A01 and A02 hold SUB3)
    p = admin.admin_ok("tasks_preview_get", {**body, "annotator_ids": POOL})
    assert all(not {"A01", "A02"} & set(t["annotators"]) for t in p["tasks"])


def test_adopting_recordings_already_given_to_two_or_more(admin: Api, client: TestClient) -> None:
    p = admin.admin_ok("tasks_preview_get", {"all": True, "annotator_ids": POOL, "adopt": True})
    assert p["created"] == 3 and p["assigned"] == 0
    assert all(t["annotators"] == ["A01", "A02"] and t["holders"] == ["A01", "A02"] for t in p["tasks"])
    made = create(admin, 3, all=True, annotator_ids=POOL, adopt=True)
    assert made["assigned"] == 0 and made["created"] == 3
    linked = [i["task"] for i in person(client, "A02").ok("get", "/assignments")["items"]]
    assert all(x is not None for x in linked)
    one = admin.admin_ok("tasks_preview_get", {"recording_ids": [SUB1], "annotator_ids": ["A01", "A03"], "adopt": True})
    assert one["skipped"] == [{"recording_id": SUB1, "reason": "has_task"}]


# ------------------------------------------------------------------- windows
def test_a_window_is_kept_in_drafts_and_saves(admin: Api, client: TestClient, recordings: Path) -> None:
    made = create(admin, 4, recording_ids=[SUB3], annotator_ids=["A03", "A04"], k=2,
                  window={"start_s": 20, "end_s": 40})
    t = made["tasks"][0]
    assert t["window"] == {"start_sample": 2560, "end_sample": 5120, "start_s": 20.0, "end_s": 40.0}
    a03 = person(client, "A03")
    it = item(a03, SUB3)
    assert it["task"] == {"task_id": t["task_id"], "window": t["window"]}
    m = a03.ok("post", "/match", match_body(recordings, SUB3))
    assert m["status"] == "matched" and m["task"] == it["task"]
    inside = ann("a" * 32, "EMG-artifact", 3000, 200)
    outside = ann("b" * 32, "Eye-blink-artifact", 1000, 100)
    across = ann("c" * 32, "Eye-blink-artifact", 5000, 200)
    r = a03.put(f"/drafts/{SUB3}?mode=standard&context=", {"annotations": [inside, outside], "elapsed_s": 3})
    assert r.status_code == 422 and r.json()["error"] == "outside_window"
    assert r.json()["annotation_ids"] == ["b" * 32]
    assert "0:20 to 0:40" in r.json()["message"]
    a03.ok("put", f"/drafts/{SUB3}?mode=standard&context=", {"annotations": [inside], "elapsed_s": 3})
    r = a03.post("/submissions", submission(recordings, SUB3, [inside, across]))
    assert r.status_code == 422 and r.json()["error"] == "outside_window", r.text
    a03.ok("post", "/submissions", submission(recordings, SUB3, [inside]))
    st = admin.admin_ok("tasks_list", {"recording_id": SUB3})["tasks"][0]
    assert st["status"] == "collecting" and st["counts"]["saved"] == 1
    assert {p["annotator_id"]: p["status"] for p in st["people"]} == {"A03": "done", "A04": "todo"}
    # A01 holds SUB3 without a task: no window for them
    assert item(person(client, "A01"), SUB3)["task"] is None
    tasks = admin.client.app.state.service.tasks
    assert tasks.window_for("A03", SUB3) == {"start_sample": 2560, "end_sample": 5120}
    assert tasks.window_for("A01", SUB3) is None and tasks.window_for("A03", SUB1) is None
    outs = tasks.outs(tasks.for_recording(SUB3))
    assert [o["task_id"] for o in outs] == [t["task_id"]] and outs[0]["counts"]["saved"] == 1
    person(client, "A01").ok("post", "/submissions", submission(recordings, SUB3, [outside]))


def test_statuses_follow_the_work_and_the_adjudication(app: Any, admin: Api, client: TestClient,
                                                       recordings: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    t = create(admin, 5, recording_ids=[SUB2], annotator_ids=["A03", "A04"], k=2)["tasks"][0]
    for aid in ("A03", "A04"):
        person(client, aid).ok("post", "/submissions", submission(recordings, SUB2, [ann("d" * 32, "EMG-artifact",
                                                                                        3000, 250)]))
    monkeypatch.setattr(tasks_mod, "_counter", [])
    monkeypatch.setattr(tasks_mod, "conflict_counter", lambda: None)
    assert admin.admin_ok("tasks_list", {"recording_id": SUB2})["tasks"][0]["status"] == "saved"
    seen: list[str] = []

    def count(service: Any, task: dict[str, Any]) -> int:
        seen.append(task["task_id"])
        assert set(service.tasks.attempts(task)) == {"A03", "A04"}
        return 2

    monkeypatch.setattr(tasks_mod, "conflict_counter", lambda: count)
    out = admin.admin_ok("tasks_list", {"recording_id": SUB2})["tasks"][0]
    assert (out["status"], out["conflicts"]) == ("ready", 2) and seen == [t["task_id"]]
    assert admin.admin_ok("tasks_list", {"status": "ready"})["counts"] == {"ready": 1}
    monkeypatch.setattr(tasks_mod, "conflict_counter", lambda: (lambda s, x: 0))
    assert admin.admin_ok("tasks_list", {"recording_id": SUB2})["tasks"][0]["status"] == "agreed"
    store = app.state.store
    store.update_record("adjudications", t["task_id"], "E01", lambda old: {
        "schema": "electrotag.adjudication", "task_id": t["task_id"], "adjudicator_id": "E01", "state": "in_progress",
        "counts": {"conflicts": 2, "decided": 1}})
    out = admin.admin_ok("tasks_list", {"recording_id": SUB2})["tasks"][0]
    assert out["status"] == "adjudicating" and out["adjudication"] == {"adjudicator_id": "E01", "state": "in_progress",
                                                                       "conflicts": 2, "decided": 1}
    store.update_record("adjudications", t["task_id"], "E01", lambda old: {**old, "state": "finished"})
    assert admin.admin_ok("tasks_list", {"recording_id": SUB2})["tasks"][0]["status"] == "adjudicated"
    attempts = app.state.service.tasks.attempts(app.state.service.tasks.get(t["task_id"]))
    assert {aid: a["attempt"] for aid, a in attempts.items()} == {"A03": 1, "A04": 1}
    admin.admin_error("tasks_list", {"status": "nonsense"}, 400, "bad_request")


# --------------------------------------------------------------- known answers
def test_known_answer_tasks_are_scored_and_kept_out_of_the_queue(app: Any, admin: Api, client: TestClient,
                                                                 recordings: Path) -> None:
    blink = ann("e" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
    emg = ann("f" * 32, "EMG-artifact", 3000, 250)
    person(client, "A02").ok("post", "/submissions", submission(recordings, SUB1, [blink, emg]))
    admin.admin_ok("set_create", {"set_id": "gold", "name": "Known answers"})
    admin.admin_ok("set_add_reference", {"set_id": "gold", "recording_id": SUB1, "use": "practice",
                                         "source": {"kind": "annotator", "annotator_id": "A02"}})
    p = admin.admin_ok("tasks_preview_get", {"all": True, "annotator_ids": ["A03", "A04", "A05"],
                                             "gold": {"set_id": "gold"}})
    assert p["created"] == 1 and p["tasks"][0]["annotators"] == ["A03", "A04", "A05"], "k does not apply"
    assert {s["recording_id"]: s["reason"] for s in p["skipped"]} == {SUB2: "no_gold_reference",
                                                                      SUB3: "no_gold_reference"}
    t = create(admin, 6, all=True, annotator_ids=["A03", "A04", "A05"], gold={"set_id": "gold"})["tasks"][0]
    assert t["status"] == "gold" and t["gold"] == {"set_id": "gold"}
    a03 = person(client, "A03")
    assert item(a03, SUB1)["task"] == {"task_id": t["task_id"], "window": None}, "nothing says it is a known answer"
    out = a03.ok("post", "/submissions", submission(recordings, SUB1, [blink]))
    assert out["feedback"] is None and "gold" not in str(out).lower()
    gold = app.state.store.records("gold", "A03")
    assert len(gold) == 1 and gold[0]["task_id"] == t["task_id"] and gold[0]["attempt"] == 1
    assert 0.6 < gold[0]["event_f1"] < 0.7  # one of the two found, nothing extra
    q = admin.admin_ok("quality_list")
    rows = {r["annotator_id"]: r for r in q["annotators"]}
    assert rows["A03"]["n_gold"] == 1 and rows["A03"]["weight"] is None, "a weight only from gold_min_items on"
    assert rows["A04"]["n_gold"] == 0 and rows["A04"]["mean_event_f1"] is None
    # a save whose scoring was interrupted is scored when the quality is asked for
    a04 = person(client, "A04")
    a04.ok("post", "/submissions", submission(recordings, SUB1, [blink, emg]))
    app.state.store.update_record("gold", f"A04_{t['task_id']}", "A04", lambda old: {"schema": "x", "attempt": 0,
                                                                                     "annotator_id": "A04",
                                                                                     "task_id": t["task_id"]})
    admin.admin_ok("settings_update", {"settings": {"review": {"gold_min_items": 1}}})
    rows = {r["annotator_id"]: r for r in admin.admin_ok("quality_list")["annotators"]}
    assert rows["A04"]["mean_event_f1"] == 1.0 and rows["A04"]["weight"] == 1.0
    assert admin.admin_ok("tasks_list", {"gold": False})["tasks"] == []
    assert all(x["status"] == "gold" for x in admin.admin_ok("tasks_list", {"gold": True})["tasks"])


# -------------------------------------------------------------- changing tasks
def test_replacing_closing_reopening_and_removing(app: Any, admin: Api, client: TestClient, recordings: Path) -> None:
    t = create(admin, 7, recording_ids=[SUB2], annotator_ids=["A03", "A04"], k=2)["tasks"][0]
    letters = dict(t["letters"])
    tid = t["task_id"]
    admin.admin_error("task_update", {"task_id": tid, "remove_annotator": "A04"}, 409, "too_few")
    admin.admin_error("task_update", {"task_id": tid, "add_annotator": "Z99"}, 404, "unknown_user")
    admin.admin_error("task_update", {"task_id": "t-000000000000"}, 404, "unknown_task")
    admin.admin_error("task_update", {"task_id": tid}, 400, "bad_request")
    up = admin.admin_ok("task_update", {"task_id": tid, "remove_annotator": "A04", "add_annotator": "A05"})["task"]
    assert up["annotators"] == ["A03", "A05"] and up["letters"]["A03"] == letters["A03"]
    assert up["letters"]["A05"] not in letters.values(), "a new person gets a letter of their own"
    assert all(i["recording_id"] != SUB2 for i in person(client, "A04").ok("get", "/assignments")["items"])
    assert item(person(client, "A05"), SUB2)["task"]["task_id"] == tid
    other = create(admin, 8, recording_ids=[SUB3], annotator_ids=["A05", "A06"], k=2)["tasks"][0]
    person(client, "A03").ok("post", "/submissions", submission(recordings, SUB2, [ann("a" * 32, "EMG-artifact", 3000,
                                                                                       250)]))
    admin.admin_error("task_update", {"task_id": tid, "remove_annotator": "A03", "add_annotator": "A06"}, 409,
                      "has_results")
    admin.admin_error("task_remove", {"task_id": tid}, 409, "has_results")
    closed = admin.admin_ok("task_update", {"task_id": tid, "state": "closed"})["task"]
    assert closed["state"] == "closed"
    assert {p["annotator_id"]: p["status"] for p in closed["people"]} == {"A03": "done", "A05": "closed"}
    assert all(i["recording_id"] != SUB2 for i in person(client, "A05").ok("get", "/assignments")["items"])
    assert item(person(client, "A03"), SUB2)["status"] == "done", "saved work stays, with its task"
    admin.admin_error("task_update", {"task_id": tid, "add_annotator": "A06"}, 409, "closed")
    reopened = admin.admin_ok("task_update", {"task_id": tid, "state": "open"})["task"]
    assert reopened["state"] == "open" and item(person(client, "A05"), SUB2)["task"]["task_id"] == tid
    # a task nobody saved goes, with its assignments; the one with results stays
    admin.admin_ok("task_remove", {"task_id": other["task_id"]})
    assert all(i["recording_id"] != SUB3 for i in person(client, "A06").ok("get", "/assignments")["items"])
    assert [x["task_id"] for x in admin.admin_ok("tasks_list")["tasks"]] == [tid]
    admin.admin_error("task_remove", {"task_id": other["task_id"]}, 404, "unknown_task")
    ops = [e["op"] for e in admin_audit(admin)]
    assert ops.count("task_update") == 3 and ops.count("task_remove") == 1
    # the record is kept (removed), never deleted
    kept = [r for r in app.state.store.records("tasks") if r["task_id"] == other["task_id"]]
    assert kept and kept[0]["state"] == "removed"


def test_removing_an_adopted_task_gives_the_recording_back_plain(admin: Api, client: TestClient) -> None:
    t = create(admin, 9, recording_ids=[SUB1], annotator_ids=["A01", "A02"], adopt=True)["tasks"][0]
    assert item(person(client, "A01"), SUB1)["task"]["task_id"] == t["task_id"]
    admin.admin_ok("task_remove", {"task_id": t["task_id"]})
    it = item(person(client, "A01"), SUB1)
    assert it["task"] is None and it["status"] == "todo", "A01 had SUB1 before the task, and keeps it"
    # and can be put in a new task of it
    again = create(admin, 10, recording_ids=[SUB1], annotator_ids=["A01", "A03"], k=2)["tasks"][0]
    assert again["annotators"] == ["A01", "A03"]


def test_task_conflict_when_a_person_holds_the_recording_for_another_task(admin: Api) -> None:
    first = create(admin, 11, recording_ids=[SUB3], annotator_ids=["A03", "A04"], k=2,
                   window={"start_s": 0, "end_s": 20})["tasks"][0]
    second = create(admin, 12, recording_ids=[SUB3], annotator_ids=["A03", "A04", "A05", "A06"], k=2,
                    window={"start_s": 20, "end_s": 40})
    assert second["skipped"] == [{"recording_id": SUB3, "reason": "has_task"}], "one open task per recording at once"
    admin.admin_ok("task_update", {"task_id": first["task_id"], "state": "closed"})
    second = create(admin, 13, recording_ids=[SUB3], annotator_ids=["A05", "A06"], k=2,
                    window={"start_s": 20, "end_s": 40})["tasks"][0]
    admin.admin_ok("task_update", {"task_id": first["task_id"], "state": "open"})
    admin.admin_error("task_update", {"task_id": first["task_id"], "remove_annotator": "A04", "add_annotator": "A05"},
                      409, "task_conflict")
    assert second["annotators"] == ["A05", "A06"]


# ------------------------------------------------------------- who and where
def test_only_administrators_and_the_results_hold_the_tasks(admin: Api, client: TestClient,
                                                            recordings: Path) -> None:
    for op in ("tasks_list", "tasks_preview_get", "tasks_create", "task_update", "task_remove", "quality_list"):
        r = person(client, "E01").admin(op, {})
        assert (r.status_code, r.json()["error"]) == (403, "forbidden"), op
    create(admin, 14, recording_ids=[SUB2], annotator_ids=["A03", "A04"], k=2, batch="Pilot")
    z = admin.admin_ok("results_zip")
    names = zipfile.ZipFile(io.BytesIO(base64.b64decode(z["base64"]))).namelist()
    assert any(n.endswith("tasks/tasks.tsv") for n in names) and any(n.endswith("tasks/tasks.json") for n in names)
    text = zipfile.ZipFile(io.BytesIO(base64.b64decode(z["base64"]))).read(
        next(n for n in names if n.endswith("tasks/tasks.tsv"))).decode()
    assert text.splitlines()[0].split("\t") == list(tasks_mod.TASK_COLUMNS) and "Pilot" in text


def test_a_share_out_makes_one_store_call_per_person(app: Any, admin: Api, monkeypatch: pytest.MonkeyPatch) -> None:
    """The assignments of a share-out go to the store in one call per person (one transaction each on Firestore),
    rather than one per person per task; the second request with the same ID makes none."""
    rids = add_copies(app, 30)
    store = app.state.store
    calls: list[tuple[str, int]] = []
    real = store.assign_many

    def counting(aid: str, items: list[tuple[str, str]], *, handout_id: str = "") -> int:
        calls.append((aid, len(items)))
        return real(aid, items, handout_id=handout_id)

    monkeypatch.setattr(store, "assign_many", counting)
    monkeypatch.setattr(store, "assign", lambda *a, **k: pytest.fail("one assignment at a time"))
    out = create(admin, 1, recording_ids=rids, annotator_ids=POOL, k=2)
    assert out["assigned"] == 60
    assert sorted(a for a, _n in calls) == POOL and sum(n for _a, n in calls) == 60
    calls.clear()
    assert create(admin, 1, recording_ids=rids, annotator_ids=POOL, k=2)["already"] is True
    assert len(calls) == len(POOL), "sent again: one call each, adding nothing"
    assert {a.task_id for a in store.assignments() if a.recording_id in rids} == {t["task_id"] for t in
                                                                                  store.records("tasks")}
