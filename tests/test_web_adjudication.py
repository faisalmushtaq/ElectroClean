"""Screening-style adjudication and the library of conflicts (electrotag/web/adjudication.py, library.py).

Two annotators save the same recording with disagreements; an expert who did not annotate it starts its
adjudication (the inputs are frozen), decides each conflict and finishes, which saves the adjudicated
version in the derived tree; the annotators see the outcome; the library lists, filters and promotes."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from electrotag.web.adjudication import ADJUDICATED, unit_id_for  # noqa: E402
from electrotag.web.errors import ApiError  # noqa: E402
from electrotag.web.service import StudyService  # noqa: E402
from electrotag.web.store import User  # noqa: E402
from electrotag.web.store_files import FilesStore  # noqa: E402
from tests.web_helpers import SUB1, SUB2, Api, ann, copy_demo, make_template, submission  # noqa: E402

A01, A02 = User("A01", "Annotator one"), User("A02", "Annotator two")
E01 = User("E01", "Expert one", roles=("annotator", "expert"))
E02 = User("E02", "Expert two", roles=("expert",))
ADMIN = User("ADMIN", "Study administrator", role="admin")
BLINK, MOVE, EMG = "Eye-blink-artifact", "Eye-movement-artifact", "EMG-artifact"
# 250 Hz: A01 and A02 agree on the EMG, differ on the type at 2 s, and each marks one blink the other did not
MINE = [ann("a" * 32, BLINK, 500, 100, ["Fp1", "Fp2"]), ann("b" * 32, EMG, 3000, 250), ann("c" * 32, BLINK, 5000, 100)]
THEIRS = [ann("d" * 32, MOVE, 500, 100, ["Fp1", "Fp2"]), ann("e" * 32, EMG, 3000, 250), ann("f" * 32, BLINK, 8000, 75)]
U1 = unit_id_for("recording", SUB1)


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-adjudication"))


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


@pytest.fixture
def study(template: Path, tmp_path: Path) -> Path:
    return copy_demo(template, tmp_path)


@pytest.fixture
def service(study: Path):
    svc = StudyService(FilesStore(study))
    yield svc
    svc.store.close()


def ex(service: StudyService, user: User, op: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    return service.call("expert", user, {"op": op, **(body or {})})


def ex_err(service: StudyService, user: User, op: str, body: dict[str, Any] | None = None) -> ApiError:
    with pytest.raises(ApiError) as e:
        ex(service, user, op, body)
    return e.value


def two_saved(service: StudyService, recordings: Path, rid: str = SUB1) -> None:
    service.call("submit", A01, submission(recordings, rid, MINE))
    service.call("submit", A02, submission(recordings, rid, THEIRS))


def unit_row(service: StudyService, uid: str = U1, user: User = E01) -> dict[str, Any]:
    return next(u for u in ex(service, user, "adjudication_list")["units"] if u["unit_id"] == uid)


def decide_all(service: StudyService, got: dict[str, Any], choice: str = "A") -> None:
    for c in got["conflicts"]:
        ex(service, E01, "adjudication_decide", {"unit_id": got["unit"]["unit_id"], "conflict_id": c["conflict_id"],
                                                 "choice": choice, "reason_code": "clear_artifact"})


def test_the_queue_lists_recordings_given_to_two_people(service: StudyService, recordings: Path) -> None:
    assert unit_row(service)["status"] == "collecting"
    service.call("submit", A01, submission(recordings, SUB1, MINE))
    row = unit_row(service)
    assert (row["status"], row["saved"], row["k"], row["conflicts"]) == ("collecting", 1, 2, None)
    service.call("submit", A02, submission(recordings, SUB1, THEIRS))
    got = ex(service, E01, "adjudication_list")
    row = next(u for u in got["units"] if u["unit_id"] == U1)
    assert (row["status"], row["conflicts"], row["agreed"], row["decided"]) == ("ready", 3, 1, 0)
    assert row["kind"] == "recording" and row["task_id"] is None and row["window"] is None
    # not blinded: each version is named
    assert [(a["letter"], a["annotator_id"], a["display_name"]) for a in row["annotators"]] == [
        ("A", "A01", "Annotator one"), ("B", "A02", "Annotator two")]
    assert got["counts"]["ready"] == 1 and got["counts"]["collecting"] >= 1
    assert [u["unit_id"] for u in ex(service, E01, "adjudication_list", {"status": "ready"})["units"]] == [U1]
    # only experts and administrators; administrators may adjudicate too
    assert ex_err(service, A01, "adjudication_list").code == "forbidden"
    assert unit_row(service, user=ADMIN)["status"] == "ready"
    # someone who annotated it sees it as their own and cannot open it
    a02x = User("A02", "Annotator two", roles=("annotator", "expert"))
    assert unit_row(service, user=a02x)["own"] is True
    assert ex_err(service, a02x, "adjudication_get", {"unit_id": U1}).code == "own_task"
    assert ex_err(service, a02x, "adjudication_start", {"unit_id": U1}).code == "own_task"


def test_conflicts_are_listed_with_who_made_each_mark(service: StudyService, recordings: Path) -> None:
    two_saved(service, recordings)
    got = ex(service, E01, "adjudication_get", {"unit_id": U1})
    assert got["blinded"] is False and got["adjudication"] is None and got["progress"] == {"conflicts": 3, "decided": 0}
    kinds = [(c["kinds"], round(c["onset_s"], 2), [m["annotator_id"] for m in c["marks"]], c["missing_ids"])
             for c in got["conflicts"]]
    assert kinds == [(["type"], 2.0, ["A01", "A02"], []), (["presence"], 20.0, ["A01"], ["A02"]),
                     (["presence"], 32.0, ["A02"], ["A01"])]
    assert got["conflicts"][0]["pair"] == [BLINK, MOVE] and got["conflicts"][0]["labels"] == [BLINK, MOVE]
    assert [a["mark"]["label"] for a in got["agreed"]] == [EMG]
    assert [(v["letter"], v["annotator_id"], len(v["annotations"])) for v in got["versions"]] == [
        ("A", "A01", 3), ("B", "A02", 3)]
    assert got["manifest"]["recording_id"] == SUB1 and got["reason_required"] == "always"
    assert ex_err(service, E01, "adjudication_get", {"unit_id": unit_id_for("recording", SUB2)}).code == "not_ready"
    assert ex_err(service, E01, "adjudication_get", {"unit_id": "r-000000000000"}).code == "not_found"
    assert ex_err(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": "c-" + "0" * 16,
                                                         "choice": "A"}).code == "not_started"


def test_start_freezes_the_inputs_and_the_rules(service: StudyService, recordings: Path, study: Path) -> None:
    two_saved(service, recordings)
    started = ex(service, E01, "adjudication_start", {"unit_id": U1})
    assert started["already"] is False
    rec = started["adjudication"]
    assert rec["state"] == "in_progress" and rec["adjudicator_id"] == "E01" and rec["blinded"] is False
    assert set(rec["inputs"]) == {"A01", "A02"} and rec["inputs"]["A01"]["attempt"] == 1
    assert len(rec["inputs"]["A01"]["annotations_sha256"]) == 64
    assert rec["rules"]["iou_threshold"] == 0.2 and rec["counts"] == {"conflicts": 3, "decided": 0, "agreed": 1}
    ids = [c["conflict_id"] for c in started["conflicts"]]
    # A01 revises the recording, and the study changes its matching rules: the adjudication keeps what it started with
    service.call("submit", A01, {**submission(recordings, SUB1, [MINE[1]]), "revises": 1})
    service.call("admin", ADMIN, {"op": "settings_update",
                                  "settings": {"review": {"matching": {"iou_threshold": 0.0}}}})
    again = ex(service, E01, "adjudication_get", {"unit_id": U1})
    assert [c["conflict_id"] for c in again["conflicts"]] == ids and again["versions"][0]["attempt"] == 1
    assert len(again["versions"][0]["annotations"]) == 3
    # starting again is the same adjudication; another expert finds it taken
    assert ex(service, E01, "adjudication_start", {"unit_id": U1})["already"] is True
    e = ex_err(service, E02, "adjudication_start", {"unit_id": U1})
    assert e.code == "taken" and e.extra["adjudicator_id"] == "E01" and "E01" in e.message
    assert ex_err(service, E02, "adjudication_decide", {"unit_id": U1, "conflict_id": ids[0],
                                                         "choice": "A"}).code == "not_yours"
    assert unit_row(service, user=E02)["status"] == "adjudicating" and unit_row(service)["yours"] is True
    entries = service.store.audit_page(None, 20)[0]
    start = next(x for x in entries if x["op"] == "adjudication_start")
    assert start["by"] == "E01" and start["details"]["n_conflicts"] == 3


def test_decisions_are_checked_and_kept_once(service: StudyService, recordings: Path) -> None:
    two_saved(service, recordings)
    got = ex(service, E01, "adjudication_start", {"unit_id": U1})
    c0, c1, c2 = (c["conflict_id"] for c in got["conflicts"])
    body = {"unit_id": U1, "conflict_id": c0}
    assert ex_err(service, E01, "adjudication_decide", {**body, "choice": "Z"}).code == "invalid_choice"
    assert ex_err(service, E01, "adjudication_decide", {**body, "choice": "A"}).code == "reason_missing"
    assert ex_err(service, E01, "adjudication_decide", {**body, "choice": "A", "reason_code": "other"}).code \
        == "reason_missing"
    assert ex_err(service, E01, "adjudication_decide", {**body, "choice": "A", "reason_code": "because"}).code \
        == "bad_request"
    assert ex_err(service, E01, "adjudication_decide", {**body, "choice": "A", "reason": "x" * 201}).code \
        == "bad_request"
    assert ex_err(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": "c-" + "1" * 16,
                                                         "choice": "A", "reason": "x"}).code == "unknown_conflict"
    out = ex(service, E01, "adjudication_decide", {**body, "choice": "B", "reason": "the eyes move sideways"})
    assert out["progress"] == {"conflicts": 3, "decided": 1} and out["already"] is False
    d = out["conflict"]["decision"]
    assert (d["choice"], d["reason"], d["decided_by"]) == ("B", "the eyes move sideways", "E01")
    assert [r["label"] for r in d["result"]] == [MOVE]
    assert ex(service, E01, "adjudication_decide", {**body, "choice": "B", "reason": "the eyes move sideways"})[
        "already"] is True
    # changed while the adjudication is open
    assert ex(service, E01, "adjudication_decide", {**body, "choice": "all", "reason_code": "both_valid"})[
        "conflict"]["decision"]["choice"] == "all"
    # an edited mark: checked as an annotation, given its own ID
    bad = ex_err(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": c1, "choice": "edited",
                                                        "reason": "x", "marks": [ann("z", "Banana", 5000, 100)]})
    assert bad.code == "invalid_annotation"
    assert ex_err(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": c1, "choice": "edited",
                                                         "reason": "x", "marks": []}).code == "invalid_annotation"
    out = ex(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": c1, "choice": "edited",
                                                   "reason_code": "boundary_evidence",
                                                   "marks": [ann("anything", BLINK, 4990, 130, ["Fp1"])]})
    assert out["conflict"]["decision"]["result"][0]["onset_sample"] == 4990
    # the study's rule: only when keeping neither or editing
    service.call("admin", ADMIN, {"op": "settings_update",
                                  "settings": {"review": {"reason_required": "edited_or_none"}}})
    ex(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": c2, "choice": "B"})
    assert ex_err(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": c2, "choice": "none"}).code \
        == "reason_missing"
    audit = [x for x in service.store.audit_page(None, 50)[0] if x["op"] == "adjudication_decide"]
    assert audit and all("reason" not in x["details"] for x in audit)
    # whose version was kept, so that the log reads on its own
    first = next(x for x in audit if x["details"]["choice"] == "B")
    assert first["details"]["kept"] == {"person": "A02", "annotator_id": "A02", "source": "original", "letter": "B"}
    assert first["summary"].endswith(": kept A02's version (B)")
    both = next(x for x in audit if x["details"]["choice"] == "all")
    assert both["details"]["kept"] is None and [v["person"] for v in both["details"]["kept_versions"]] == ["A01", "A02"]
    assert both["summary"].endswith("kept every version: A01's version (A) and A02's version (B)")
    assert {x["details"]["reason_length"] for x in audit} >= {len("the eyes move sideways"), 0}


def test_finish_saves_the_adjudicated_version_once(service: StudyService, recordings: Path, study: Path) -> None:
    two_saved(service, recordings)
    got = ex(service, E01, "adjudication_start", {"unit_id": U1})
    c0, c1, c2 = (c["conflict_id"] for c in got["conflicts"])
    ex(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": c0, "choice": "B", "reason": "sideways"})
    e = ex_err(service, E01, "adjudication_finish", {"unit_id": U1})
    assert e.code == "undecided" and e.extra["n"] == 2
    ex(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": c1, "choice": "A",
                                             "reason_code": "clear_artifact"})
    ex(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": c2, "choice": "none",
                                             "reason_code": "not_artifact"})
    out = ex(service, E01, "adjudication_finish", {"unit_id": U1})
    assert out["already"] is False and out["version"]["attempt"] == 1 and out["version"]["n_annotations"] == 3
    assert len(out["version"]["files"]) == 5 and out["adjudication"]["state"] == "finished"
    folder = study / "Annotated_Events" / "derived" / "adjudications" / "annotator-ADJUDICATED" / "sub-001" / "eeg"
    names = sorted(p.name for p in folder.iterdir())
    assert len(names) == 5 and all("_annotator-ADJUDICATED" in n for n in names)
    doc = json.loads((folder / next(n for n in names if n.endswith("_annotations.json"))).read_text("utf-8"))
    assert [(a["label"], a["onset_sample"]) for a in doc["annotations"]] == [(MOVE, 500), (EMG, 3000), (BLINK, 5000)]
    assert doc["annotator"]["display_name"] == "Adjudicated (E01)"
    derived = doc["session"]["context"]["derived"]
    assert derived["kind"] == "adjudication" and derived["task_id"] == U1 and derived["n_conflicts"] == 3
    assert set(derived["inputs"]) == {"A01", "A02"} and derived["blinded"] is False
    # never anyone's attempt or completion
    assert all(e["annotator_id"] != ADJUDICATED for e in service.store.completion_entries())
    assert [e["recording_id"] for e in service.store.derived_entries("adjudications", ADJUDICATED)] == [SUB1]
    # again: nothing is saved twice; decisions are kept as they are
    assert ex(service, E01, "adjudication_finish", {"unit_id": U1})["already"] is True
    assert len(service.store.derived_entries("adjudications")) == 1
    assert ex_err(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": c0, "choice": "A",
                                                         "reason": "x"}).code == "finished"
    assert unit_row(service)["status"] == "adjudicated"
    fin = next(x for x in service.store.audit_page(None, 50)[0] if x["op"] == "adjudication_finish")
    assert fin["details"]["by_choice"] == {"one": 2, "none": 1}


def test_a_finish_interrupted_after_saving_does_not_save_twice(service: StudyService, recordings: Path,
                                                              monkeypatch: pytest.MonkeyPatch) -> None:
    two_saved(service, recordings)
    decide_all(service, ex(service, E01, "adjudication_start", {"unit_id": U1}))
    real = service.store.update_record
    calls = {"n": 0}

    def flaky(kind: str, rid: str, aid: str, change: Any) -> Any:
        def wrapped(old: Any) -> Any:
            new = change(old)
            if new is not None and new.get("state") == "finished" and calls["n"] == 0:
                calls["n"] += 1
                raise RuntimeError("the study could not be reached")
            return new
        return real(kind, rid, aid, wrapped)

    monkeypatch.setattr(service.store, "update_record", flaky)
    with pytest.raises(RuntimeError):
        ex(service, E01, "adjudication_finish", {"unit_id": U1})
    assert len(service.store.derived_entries("adjudications")) == 1
    out = ex(service, E01, "adjudication_finish", {"unit_id": U1})
    assert out["adjudication"]["state"] == "finished" and len(service.store.derived_entries("adjudications")) == 1


def test_annotators_see_the_outcome_of_their_conflicts(service: StudyService, recordings: Path) -> None:
    two_saved(service, recordings)
    got = ex(service, E01, "adjudication_start", {"unit_id": U1})
    assert service.call("my_feedback", A01, {})["adjudications"] == {"shown": True, "items": []}  # not finished
    c0, c1, c2 = (c["conflict_id"] for c in got["conflicts"])
    for cid, choice in ((c0, "B"), (c1, "A"), (c2, "all")):
        ex(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": cid, "choice": choice,
                                                 "reason": "seen in the EEG"})
    ex(service, E01, "adjudication_finish", {"unit_id": U1})
    fb = service.call("my_feedback", A01, {})["adjudications"]
    assert fb["shown"] is True and len(fb["items"]) == 1
    item = fb["items"][0]
    assert item["recording_id"] == SUB1 and len(item["conflicts"]) == 3
    outcomes = [(c["decision"]["outcome"], len(c["yours"]), len(c["others"])) for c in item["conflicts"]]
    # from what was kept: at 32 s A01 had no mark and A02's was kept, so a colleague's mark was kept
    assert outcomes == [("other_kept", 1, 1), ("yours_kept", 1, 0), ("other_kept", 0, 1)]
    assert item["k"] == 2 and item["reopened"] is False
    assert item["conflicts"][0]["decision"]["reason"] == "seen in the EEG"
    assert "A02" not in json.dumps(item) and "E01" not in json.dumps(item)  # nobody else is named
    other = service.call("my_feedback", A02, {})["adjudications"]["items"][0]["conflicts"]
    # A02's own mark at 32 s, kept by "all" with nobody else's: what they did stood
    assert [c["decision"]["outcome"] for c in other] == ["yours_kept", "other_kept", "yours_kept"]
    service.call("admin", ADMIN, {"op": "settings_update",
                                  "settings": {"review": {"show_outcomes_to_annotators": False}}})
    assert service.call("my_feedback", A01, {})["adjudications"] == {"shown": False, "items": []}


def test_a_task_with_a_window_is_a_unit_and_cannot_become_a_reference(service: StudyService,
                                                                      recordings: Path) -> None:
    # a task record as the tasks part keeps it (docs/web/api.md, "Tasks"): the window of SUB2 from 0 to 30 s
    task = {"schema": "electrotag.task", "schema_version": 1, "task_id": "t-0123456789ab", "recording_id": SUB2,
            "scope": "study", "window": {"start_sample": 0, "end_sample": 7500}, "k": 2,
            "annotators": ["A02", "A01"], "gold": None, "letters": {"A01": "B", "A02": "A"}, "status": "open"}
    service.store.update_record("tasks", task["task_id"], "", lambda old: task)
    gold = {**task, "task_id": "t-ffffffffffff", "gold": {"set_id": "gold"}}
    service.store.update_record("tasks", gold["task_id"], "", lambda old: gold)
    two_saved(service, recordings, SUB2)
    rows = {u["unit_id"]: u for u in ex(service, E01, "adjudication_list")["units"]}
    assert unit_id_for("recording", SUB2) not in rows and "t-ffffffffffff" not in rows
    row = rows["t-0123456789ab"]
    assert row["kind"] == "task" and row["task_id"] == "t-0123456789ab" and row["window"]["end_s"] == 30.0
    assert [(a["letter"], a["annotator_id"]) for a in row["annotators"]] == [("A", "A02"), ("B", "A01")]
    # the blink of A01 at 20 s is inside, A02's at 32 s outside: two conflicts
    got = ex(service, E01, "adjudication_start", {"unit_id": "t-0123456789ab"})
    assert [c["kinds"] for c in got["conflicts"]] == [["type"], ["presence"]]
    cid = got["conflicts"][1]["conflict_id"]
    outside = ex_err(service, E01, "adjudication_decide", {"unit_id": "t-0123456789ab", "conflict_id": cid,
                                                            "choice": "edited", "reason": "x",
                                                            "marks": [ann("q", BLINK, 7450, 100)]})
    assert outside.code == "outside_window"
    decide_all(service, got)
    ex(service, E01, "adjudication_finish", {"unit_id": "t-0123456789ab"})
    set_id = service.call("admin", ADMIN, {"op": "set_create", "set_id": "adjudicated"})["set"]["set_id"]
    e = ex_err(service, E01, "adjudication_reference", {"unit_id": "t-0123456789ab", "set_id": set_id,
                                                         "use": "practice"})
    assert e.code == "window_task"


def test_an_adjudication_becomes_a_training_reference(service: StudyService, recordings: Path) -> None:
    two_saved(service, recordings)
    set_id = service.call("admin", ADMIN, {"op": "set_create", "set_id": "adjudicated"})["set"]["set_id"]
    assert ex_err(service, E01, "adjudication_reference", {"unit_id": U1, "set_id": set_id,
                                                           "use": "practice"}).code == "not_finished"
    decide_all(service, ex(service, E01, "adjudication_start", {"unit_id": U1}))
    ex(service, E01, "adjudication_finish", {"unit_id": U1})
    out = ex(service, E01, "adjudication_reference", {"unit_id": U1, "set_id": set_id, "use": "practice"})
    rec = next(r for r in out["set"]["recordings"] if r["recording_id"] == SUB1)
    assert rec["provenance"]["method"] == "adjudicated" and rec["provenance"]["adjudicator"] == "E01"
    assert rec["provenance"]["experts"] == ["A01", "A02"] and rec["n_reference_events"] == 3
    rs = service.store.reference_set(set_id)
    assert [a.label for a in rs.reference_document(SUB1).sorted_annotations()] == [BLINK, EMG, BLINK]
    # the admin operation takes the same Source
    service.call("admin", ADMIN, {"op": "set_add_reference", "set_id": set_id, "recording_id": SUB1, "use": "guided",
                                  "recording_scope": "study", "source": {"kind": "adjudication", "task_id": U1}})


def test_two_corrections_of_the_same_work_are_adjudicated(service: StudyService, recordings: Path) -> None:
    service.call("submit", A01, submission(recordings, SUB1, MINE))
    sub = submission(recordings, SUB1, MINE)

    def correct(by: User, n: int, annotations: list[dict[str, Any]], reasons: dict[str, str]) -> None:
        ex(service, by, "correction_save", {"correction_id": f"{n:032x}", "annotator_id": "A01", "recording_id": SUB1,
                                            "attempt": 1, "annotations": annotations, "sha256": sub["sha256"],
                                            "session": sub["session"],
                                            "changes": [{"annotation_id": k, "reason": r} for k, r in reasons.items()]})

    # E01 says the first mark is an eye movement; E02 says the third is not an artifact
    correct(E01, 1, [{**MINE[0], "label": MOVE}, MINE[1], MINE[2]], {MINE[0]["annotation_id"]: "wrong_type"})
    correct(E02, 2, [MINE[0], MINE[1]], {MINE[2]["annotation_id"]: "not_artifact"})
    uid = unit_id_for("corrections", "A01", SUB1, "1")
    E03 = User("E03", "Expert three", roles=("expert",))
    row = unit_row(service, uid, E03)
    assert row["kind"] == "corrections" and row["corrected"] == {"annotator_id": "A01", "attempt": 1}
    assert [a["annotator_id"] for a in row["annotators"]] == ["E01", "E02"] and row["conflicts"] == 2
    for who in (E01, E02, User("A01", roles=("annotator", "expert"))):
        assert ex_err(service, who, "adjudication_start", {"unit_id": uid}).code == "own_task"
    got = ex(service, E03, "adjudication_start", {"unit_id": uid})
    assert [c["kinds"] for c in got["conflicts"]] == [["type"], ["presence"]]
    # the adjudicator sees why each expert changed the work, and the original they corrected
    e01 = next(v for v in got["versions"] if v["annotator_id"] == "E01")
    assert [(c["annotation_id"], c["change"], c["reason"], c["reason_text"]) for c in e01["changes"]] == [
        (MINE[0]["annotation_id"], "changed", "wrong_type", "Wrong type")]
    assert got["original"]["annotator_id"] == "A01" and len(got["original"]["annotations"]) == 3
    assert {m["annotator_id"] for m in got["conflicts"][0]["marks"]} == {"E01", "E02"}
    assert got["adjudication"]["inputs"]["E02"]["source"] == "correction"
    for c, choice in zip(got["conflicts"], ("A", "B"), strict=True):
        ex(service, E03, "adjudication_decide", {"unit_id": uid, "conflict_id": c["conflict_id"], "choice": choice,
                                                 "reason_code": "clear_artifact"})
    said = next(x for x in service.store.audit_page(None, 50)[0] if x["op"] == "adjudication_decide")
    assert said["details"]["kept"]["source"] == "correction" and said["summary"].endswith("'s work (B)")
    assert "E02's correction of A01's work (B)" in said["summary"]
    fin = ex(service, E03, "adjudication_finish", {"unit_id": uid})
    assert fin["version"]["n_annotations"] == 2  # the eye movement and the EMG
    # reopened, the corrected version settled before still stands for A01 until it is finished again
    ex(service, E03, "adjudication_reopen", {"unit_id": uid})
    item = service.call("my_feedback", A01, {})["corrections"]["items"][0]
    assert item["standing"] == "adjudicated" and item["adjudication"]["version"] == 1
    ex(service, E03, "adjudication_finish", {"unit_id": uid})
    # a third correction by E01 of the same version replaces E01's earlier one (each corrector's latest)
    correct(E01, 3, [MINE[1]], {MINE[0]["annotation_id"]: "not_artifact", MINE[2]["annotation_id"]: "not_artifact"})
    assert [a["annotator_id"] for a in unit_row(service, uid, E03)["annotators"]] == ["E01", "E02"]


def test_the_library_filters_and_counts(service: StudyService, recordings: Path) -> None:
    two_saved(service, recordings)
    two_saved(service, recordings, SUB2)
    got = ex(service, E01, "adjudication_start", {"unit_id": U1})
    c0 = got["conflicts"][0]["conflict_id"]
    ex(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": c0, "choice": "B",
                                             "reason": "the eyes move sideways"})
    lib = ex(service, E01, "library_list")
    assert lib["total"] == 6 and len(lib["entries"]) == 6
    assert lib["facets"]["status"] == {"awaiting": 3, "open": 2, "decided": 1}
    assert lib["facets"]["pairs"] == {f"{BLINK} | {MOVE}": 2}
    assert lib["facets"]["kinds"] == {"presence": 4, "type": 2} and lib["facets"]["choices"] == {"one": 1}
    e0 = next(e for e in lib["entries"] if e["conflict_id"] == c0)
    assert e0["entry_id"] == f"{U1}:{c0}" and e0["status"] == "decided" and e0["decision"]["choice"] == "B"
    assert e0["adjudicator_id"] == "E01" and e0["annotators"] == ["A01", "A02"] and not e0["finished"]
    assert e0["promoted"] == []
    assert {m["annotator_id"] for m in e0["marks"]} == {"A01", "A02"}

    def n(**f: Any) -> int:
        return ex(service, E01, "library_list", f)["total"]

    assert n(pair=[MOVE, BLINK]) == 2 and n(pair=f"{BLINK}|{MOVE}") == 2
    assert n(label=MOVE) == 2 and n(label=EMG) == 0
    assert n(status="decided") == 1 and n(status="awaiting") == 3 and n(status="open") == 2
    assert n(choice="one") == 1 and n(choice="B") == 1 and n(choice="none") == 0
    assert n(kind="presence") == 4 and n(recording_id=SUB2) == 3 and n(annotator_id="A02") == 6
    assert n(annotator_id="T01") == 0 and n(q="SIDEWAYS") == 1
    page = ex(service, E01, "library_list", {"offset": 4, "limit": 10})
    assert page["total"] == 6 and len(page["entries"]) == 2
    with pytest.raises(ApiError):
        ex(service, E01, "library_list", {"status": "lost"})
    with pytest.raises(ApiError):
        ex(service, E01, "library_list", {"kind": "colour"})


def test_entries_are_promoted_with_their_provenance_once(service: StudyService, recordings: Path) -> None:
    two_saved(service, recordings)
    got = ex(service, E01, "adjudication_start", {"unit_id": U1})
    c0, c1 = got["conflicts"][0]["conflict_id"], got["conflicts"][1]["conflict_id"]
    ex(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": c0, "choice": "B",
                                             "reason": "the eyes move sideways"})
    set_id = service.call("admin", ADMIN, {"op": "set_create", "set_id": "library"})["set"]["set_id"]
    body = {"promote_id": "1" * 32, "entry_id": f"{U1}:{c0}", "to": "quiz_item", "set_id": set_id}
    out = ex(service, E01, "library_promote", body)
    item = out["item"]
    assert out["already"] is False and item["item_id"] == "q01" and item["correct_label"] == MOVE
    assert (item["start_s"], item["end_s"], item["recording_id"]) == (2.0, 2.4, SUB1)
    assert item["source"]["library_entry"] == f"{U1}:{c0}" and item["source"]["promote_id"] == "1" * 32
    assert item["source"]["task_id"] == U1 and item["source"]["conflict_id"] == c0
    assert "sideways" in item["explanation"]
    assert ex(service, E01, "library_promote", body)["already"] is True
    assert ex(service, E01, "library_promote", {**body, "promote_id": "2" * 32})["item"]["item_id"] == "q01"
    rs = service.store.reference_set(set_id)
    assert len(rs.quiz_items) == 1 and rs.quiz_items[0].source["promote_id"] == "1" * 32
    assert service.store.manifest(f"set:{set_id}", SUB1) is not None  # copied into the set, as for a reference
    lib = {e["entry_id"]: e for e in ex(service, E01, "library_list")["entries"]}
    assert lib[f"{U1}:{c0}"]["promoted"] == [{"set_id": set_id, "to": "quiz_item", "id": "q01"}]
    # a snippet; an undecided conflict is refused, whatever it would become
    snip = ex(service, E01, "library_promote", {"promote_id": "3" * 32, "entry_id": f"{U1}:{c0}", "to": "snippet",
                                                "set_id": set_id, "explanation": "Sideways eye movement"})
    assert snip["snippet"]["snippet_id"] == "s01" and snip["snippet"]["label"] == MOVE
    assert service.store.reference_set(set_id).snippets[0]["source"]["promote_id"] == "3" * 32
    for to in ("quiz_item", "snippet"):
        e = ex_err(service, E01, "library_promote", {"promote_id": "4" * 32, "entry_id": f"{U1}:{c1}", "to": to,
                                                     "set_id": set_id, "label": BLINK})
        assert e.code == "undecided" and e.status == 409
    ex(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": c1, "choice": "A", "reason": "a blink"})
    labelled = ex(service, E01, "library_promote", {"promote_id": "4" * 32, "entry_id": f"{U1}:{c1}", "to": "quiz_item",
                                                    "set_id": set_id, "label": BLINK, "start_s": 19.5, "end_s": 21})
    assert (labelled["item"]["item_id"], labelled["item"]["start_s"]) == ("q02", 19.5)
    assert ex_err(service, E01, "library_promote", {**body, "promote_id": "nope"}).code == "bad_request"
    assert ex_err(service, E01, "library_promote", {**body, "promote_id": "5" * 32, "entry_id": "x:y"}).code \
        == "unknown_entry"
    promoted = [x for x in service.store.audit_page(None, 50)[0] if x["op"] == "library_promote"]
    assert len(promoted) == 3 and "explanation" not in promoted[0]["details"]


def test_the_results_hold_the_decisions_and_the_library(service: StudyService, recordings: Path) -> None:
    from electrotag.web.export import results_zip_file

    two_saved(service, recordings)
    decide_all(service, ex(service, E01, "adjudication_start", {"unit_id": U1}))
    ex(service, E01, "adjudication_finish", {"unit_id": U1})
    path = results_zip_file(service.store)
    try:
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            decisions = zf.read("Annotated_Events/adjudications/decisions.tsv").decode("utf-8").splitlines()
            library = zf.read("Annotated_Events/library/library.tsv").decode("utf-8").splitlines()
    finally:
        path.unlink()
    assert f"Annotated_Events/adjudications/{U1}.json" in names
    assert any("derived/adjudications/annotator-ADJUDICATED" in n for n in names)
    assert decisions[0].split("\t")[:3] == ["unit_id", "unit_kind", "recording_id"] and len(decisions) == 4
    assert all(row.split("\t")[12] == "A" for row in decisions[1:])
    assert library[0].startswith("entry_id\tunit_id") and len(library) == 4
    head = library[0].split("\t")
    row = dict(zip(head, library[1].split("\t"), strict=True))
    # the letters change from unit to unit: the export says who each one is, and whose marks were kept
    assert (row["letters"], row["choice"], row["kept_annotator_ids"]) == ("A=A01,B=A02", "A", "A01")


def test_the_routes_of_the_server(template: Path, study: Path, recordings: Path) -> None:
    from fastapi.testclient import TestClient

    from electrotag.web.app import create_app

    app = create_app(study, demo=True, demo_zip=template / "recordings.zip")
    try:
        client = TestClient(app)
        a01, a02, e01 = Api(client, "A01"), Api(client, "A02"), Api(client, "E01")
        a01.ok("post", "/submissions", submission(recordings, SUB1, MINE))
        a02.ok("post", "/submissions", submission(recordings, SUB1, THEIRS))
        rows = e01.ok("post", "/expert/adjudication_list", {})["units"]
        assert next(r for r in rows if r["unit_id"] == U1)["status"] == "ready"
        r = a01.post("/expert/adjudication_list", {})
        assert r.status_code == 403 and r.json()["error"] == "forbidden"
        got = e01.ok("post", "/expert/adjudication_start", {"unit_id": U1})
        r = e01.post("/expert/adjudication_finish", {"unit_id": U1})
        assert r.status_code == 409 and r.json() == {**r.json(), "error": "undecided", "n": 3}
        for c in got["conflicts"]:
            e01.ok("post", "/expert/adjudication_decide", {"unit_id": U1, "conflict_id": c["conflict_id"],
                                                           "choice": "all", "reason_code": "both_valid"})
        # both types are kept at 2 s
        assert e01.ok("post", "/expert/adjudication_finish", {"unit_id": U1})["version"]["n_annotations"] == 5
        assert a01.ok("get", "/me/feedback")["adjudications"]["items"][0]["recording_id"] == SUB1
    finally:
        app.state.store.close()


def test_tasks_made_by_the_tasks_part_are_units_with_their_conflicts_counted(service: StudyService,
                                                                              recordings: Path) -> None:
    from electrotag.web import adjudication

    service.call("admin", ADMIN, {"op": "tasks_create", "request_id": "7" * 32, "recording_ids": [SUB2], "k": 2,
                                  "annotator_ids": ["A01", "A02"], "adopt": True})
    task = next(t for t in service.tasks.all() if t["recording_id"] == SUB2)
    tid = task["task_id"]
    two_saved(service, recordings, SUB2)
    rows = {u["unit_id"]: u for u in ex(service, E01, "adjudication_list")["units"]}
    assert unit_id_for("recording", SUB2) not in rows and rows[tid]["kind"] == "task" and rows[tid]["conflicts"] == 3
    # the tasks part tells ready from agreed with the counter registered here, and lists what this part keeps
    listed = ex(service, E01, "tasks_list")
    out = next(t for t in listed["tasks"] if t["task_id"] == tid)
    assert out["status"] == "ready" and out["conflicts"] == 3 and listed["counts"]["ready"] >= 1
    assert ex(service, E01, "tasks_list", {"status": "agreed"})["tasks"] == []
    adjudication._COUNTS.clear()
    calls = {"n": 0}
    real = adjudication.compare

    def counted(*a: Any, **k: Any) -> Any:
        calls["n"] += 1
        return real(*a, **k)

    adjudication.compare = counted
    try:
        ex(service, E01, "tasks_list")
        ex(service, E01, "tasks_list")
        assert calls["n"] == 1  # counted once for the same versions
    finally:
        adjudication.compare = real
    got = ex(service, E01, "adjudication_start", {"unit_id": tid})
    decide_all(service, got)
    out = next(t for t in ex(service, E01, "tasks_list")["tasks"] if t["task_id"] == tid)
    assert out["status"] == "adjudicating" and out["adjudication"]["decided"] == 3
    ex(service, E01, "adjudication_finish", {"unit_id": tid})
    out = service.call("admin", ADMIN, {"op": "tasks_list"})["tasks"]
    assert next(t for t in out if t["task_id"] == tid)["status"] == "adjudicated"


def test_marks_of_different_people_are_kept_for_one_conflict(service: StudyService, recordings: Path) -> None:
    from electrotag.web.library import library_rows

    two_saved(service, recordings)
    got = ex(service, E01, "adjudication_start", {"unit_id": U1})
    c0 = got["conflicts"][0]
    picks = [{"letter": m["letter"], "annotation_id": m["annotation_id"]} for m in c0["marks"]]
    body = {"unit_id": U1, "conflict_id": c0["conflict_id"], "choice": "pick", "reason_code": "both_valid"}
    out = ex(service, E01, "adjudication_decide", {**body, "picks": picks})
    d = out["conflict"]["decision"]
    assert d["choice"] == "pick" and sorted(r["label"] for r in d["result"]) == [BLINK, MOVE]
    assert ex(service, E01, "adjudication_decide", {**body, "picks": picks[::-1]})["already"] is True
    for bad in ([], [{"letter": "A", "annotation_id": "nope"}], [picks[0], picks[0]], None):
        assert ex_err(service, E01, "adjudication_decide", {**body, "picks": bad}).code == "invalid_choice"
    # up to five marks of the adjudicator's own
    c1 = got["conflicts"][1]["conflict_id"]
    own = [ann(str(i), BLINK, 4900 + 40 * i, 30) for i in range(5)]
    out = ex(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": c1, "choice": "edited",
                                                   "reason": "five blinks", "marks": own})
    assert len(out["conflict"]["decision"]["result"]) == 5
    assert ex_err(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": c1, "choice": "edited",
                                                         "reason": "six", "marks": own + own[:1]}).code \
        == "invalid_annotation"
    entry = next(e for e in ex(service, E01, "library_list", {"choice": "pick"})["entries"])
    assert library_rows([entry])[0]["kept_annotator_ids"] == ["A01", "A02"]


def test_a_finished_adjudication_is_reopened_and_the_latest_finished_version_counts(
        service: StudyService, recordings: Path, study: Path) -> None:
    def agreement() -> dict[str, Any]:
        out = service.call("admin", ADMIN, {"op": "agreement", "config": {"resolutions_s": [1.0]},
                                            "versions": "adjudicated", "annotator_ids": ["A01", "A02"]})
        table = out["tables"]["adjudication.tsv"].splitlines()
        return dict(zip(table[0].split("\t"), table[1].split("\t"), strict=True))

    two_saved(service, recordings)
    assert ex_err(service, E01, "adjudication_reopen", {"unit_id": U1}).code == "not_started"
    got = ex(service, E01, "adjudication_start", {"unit_id": U1})
    decide_all(service, got)
    ex(service, E01, "adjudication_finish", {"unit_id": U1})
    assert agreement()["n_adjudicated"] == "3"
    # only the adjudicator (or an administrator) reopens it, never someone whose work it compares
    assert ex_err(service, E02, "adjudication_reopen", {"unit_id": U1}).code == "not_yours"
    a02x = User("A02", "Annotator two", roles=("annotator", "expert"))
    assert ex_err(service, a02x, "adjudication_reopen", {"unit_id": U1}).code == "own_task"
    out = ex(service, E01, "adjudication_reopen", {"unit_id": U1, "reason": "a second look at 32 s"})
    rec = out["adjudication"]
    assert out["already"] is False and rec["state"] == "in_progress" and rec["version"] is None
    assert len(rec["history"]) == 1 and rec["history"][0]["version"]["attempt"] == 1
    assert rec["history"][0]["reason"] == "a second look at 32 s" and len(rec["decisions"]) == 3
    assert ex(service, E01, "adjudication_reopen", {"unit_id": U1})["already"] is True
    assert unit_row(service)["status"] == "adjudicating"
    audit = next(x for x in service.store.audit_page(None, 50)[0] if x["op"] == "adjudication_reopen")
    assert audit["details"]["reason_length"] == len("a second look at 32 s") and "reason" not in audit["details"]
    # until it is finished again, the version finished before is the one that counts
    fb = service.call("my_feedback", A01, {})["adjudications"]["items"][0]
    assert fb["reopened"] is True and len(fb["conflicts"]) == 3
    assert agreement()["n_adjudicated"] == "3"
    set_id = service.call("admin", ADMIN, {"op": "set_create", "set_id": "reopened"})["set"]["set_id"]
    ref = ex(service, E01, "adjudication_reference", {"unit_id": U1, "set_id": set_id, "use": "practice"})
    assert next(r for r in ref["set"]["recordings"] if r["recording_id"] == SUB1)["n_reference_events"] == 3
    # a changed decision, and finished again: a newer version, the earlier one kept
    c2 = got["conflicts"][2]["conflict_id"]
    ex(service, E01, "adjudication_decide", {"unit_id": U1, "conflict_id": c2, "choice": "all", "reason": "both"})
    fin = ex(service, E01, "adjudication_finish", {"unit_id": U1})
    assert fin["version"]["attempt"] == 2 and fin["adjudication"]["state"] == "finished"
    entries = service.store.derived_entries("adjudications", ADJUDICATED)
    assert len(entries) == 2
    assert service.store.derived_files("adjudications", ADJUDICATED, SUB1, 1)  # never deleted
    row = agreement()
    assert (row["n_adjudicated"], row["kept_all"], row["kept_one"]) == ("4", "1", "2")
    fb = service.call("my_feedback", A01, {})["adjudications"]["items"][0]
    assert fb["reopened"] is False and fb["conflicts"][2]["decision"]["outcome"] == "other_kept"
    # an administrator may reopen it, and continues it themselves
    out = ex(service, ADMIN, "adjudication_reopen", {"unit_id": U1})
    assert out["adjudication"]["adjudicator_id"] == "ADMIN" and len(out["adjudication"]["history"]) == 2
