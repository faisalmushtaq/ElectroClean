"""The admin area's agreement analysis of the derived versions (docs/web/api.md, "Derived versions in the analyses").

Two annotators save a recording, experts correct one of them (once, then twice, which needs adjudication) and
an expert adjudicates the recording; the admin operation ``agreement`` then compares the originals, the
corrected versions and the adjudicated versions, with the decisions taken from the study's records."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastapi")

from electrotag.web.adjudication import unit_id_for  # noqa: E402
from electrotag.web.errors import ApiError  # noqa: E402
from electrotag.web.service import StudyService  # noqa: E402
from electrotag.web.store import User  # noqa: E402
from electrotag.web.store_files import FilesStore  # noqa: E402
from tests.web_helpers import SUB1, ann, copy_demo, make_template, submission  # noqa: E402

A01, A02 = User("A01", "Annotator one"), User("A02", "Annotator two")
E01 = User("E01", "Expert one", roles=("annotator", "expert"))
E02 = User("E02", "Expert two", roles=("expert",))
E03 = User("E03", "Expert three", roles=("expert",))
ADMIN = User("ADMIN", "Study administrator", role="admin")
BLINK, MOVE, EMG = "Eye-blink-artifact", "Eye-movement-artifact", "EMG-artifact"
MINE = [ann("a" * 32, BLINK, 500, 100, ["Fp1", "Fp2"]), ann("b" * 32, EMG, 3000, 250), ann("c" * 32, BLINK, 5000, 100)]
THEIRS = [ann("d" * 32, MOVE, 500, 100, ["Fp1", "Fp2"]), ann("e" * 32, EMG, 3000, 250)]


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-versions"))


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


@pytest.fixture
def service(template: Path, tmp_path: Path):
    svc = StudyService(FilesStore(copy_demo(template, tmp_path)))
    yield svc
    svc.store.close()


def ex(service: StudyService, user: User, op: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    return service.call("expert", user, {"op": op, **(body or {})})


def agreement(service: StudyService, **body: Any) -> dict[str, Any]:
    return service.call("admin", ADMIN, {"op": "agreement", "config": {"resolutions_s": [1.0]}, **body})


def correct(service: StudyService, recordings: Path, by: User, n: int, annotations: list, reasons: dict) -> None:
    sub = submission(recordings, SUB1, MINE)
    ex(service, by, "correction_save", {"correction_id": f"{n:032x}", "annotator_id": "A01", "recording_id": SUB1,
                                        "attempt": 1, "annotations": annotations, "sha256": sub["sha256"],
                                        "session": sub["session"],
                                        "changes": [{"annotation_id": k, "reason": r} for k, r in reasons.items()]})


def adjudicate(service: StudyService, by: User, uid: str, choices: str) -> None:
    got = ex(service, by, "adjudication_start", {"unit_id": uid})
    for c, choice in zip(got["conflicts"], choices, strict=True):
        ex(service, by, "adjudication_decide", {"unit_id": uid, "conflict_id": c["conflict_id"], "choice": choice,
                                                "reason_code": "clear_artifact"})
    ex(service, by, "adjudication_finish", {"unit_id": uid})


def f1_of(answer: dict[str, Any], pair: str) -> float:
    return next(r["event_f1"] for r in answer["summary"]["key_results"] if r["pair"] == pair)


def test_the_agreement_compares_the_version_asked_for(service: StudyService, recordings: Path) -> None:
    service.call("submit", A01, submission(recordings, SUB1, MINE))
    service.call("submit", A02, submission(recordings, SUB1, THEIRS))
    original = agreement(service)
    assert original["summary"]["versions"]["used"] == "original" and original["summary"]["unit"] == "recording"
    assert "versions.tsv" not in original["tables"]
    assert f1_of(original, "A01 – A02") == pytest.approx(2 / 5)
    # E01 corrects A01's work: the eye movement, and the third blink is not an artifact
    correct(service, recordings, E01, 1, [{**MINE[0], "label": MOVE}, MINE[1]],
            {MINE[0]["annotation_id"]: "wrong_type", MINE[2]["annotation_id"]: "not_artifact"})
    assert agreement(service)["tables"] == original["tables"]  # the originals are unchanged by a correction
    corrected = agreement(service, versions="corrected")
    v = corrected["summary"]["versions"]
    assert (v["used"], v["replaced"], v["by"]) == ("corrected", 1, {"E01": 1})
    assert f1_of(corrected, "A01 – A02") == pytest.approx(1.0)
    assert "corrections_effect.tsv" in corrected["tables"] and "versions.tsv" in corrected["tables"]
    assert "Versions analysed." in corrected["report_html"]
    assert corrected["settings_file"]["config"]["versions"] == "corrected"
    # E02 corrects the same version too: until the corrections are adjudicated, the recording waits
    correct(service, recordings, E02, 2, MINE[:2], {MINE[2]["annotation_id"]: "not_artifact"})
    with pytest.raises(ApiError) as e:
        agreement(service, versions="corrected")
    assert e.value.code == "not_enough"
    adjudicate(service, E03, unit_id_for("corrections", "A01", SUB1, "1"), "A")
    again = agreement(service, versions="corrected")
    assert again["summary"]["versions"]["by"] == {"E01": 1, "E02": 1}
    assert f1_of(again, "A01 – A02") == pytest.approx(1.0)
    # the adjudicated versions: E03 adjudicates the two annotators' work and everyone is compared with it
    with pytest.raises(ApiError) as e:
        agreement(service, versions="adjudicated")
    assert e.value.code == "not_enough" and "No adjudication is finished" in e.value.message
    adjudicate(service, E03, unit_id_for("recording", SUB1), "BA")
    adj = agreement(service, versions="adjudicated", annotator_ids=["A01", "A02"])
    assert adj["summary"]["config"]["reference_annotator"] == "ADJUDICATED"
    assert sorted(r["pair"] for r in adj["summary"]["key_results"]) == ["ADJUDICATED – A01", "ADJUDICATED – A02",
                                                                         "Mean over pairs"]
    table = adj["tables"]["adjudication.tsv"].splitlines()
    head, row = table[0].split("\t"), dict(zip(table[0].split("\t"), table[1].split("\t"), strict=True))
    assert "f1_before" in head and row["n_conflicts"] == "2" and row["kept_one"] == "2" and row["adjudicator"] == "E03"
    assert "adjudication_pairs.tsv" in adj["tables"] and "adjudication_survival.tsv" in adj["tables"]
    assert "Before and after adjudication." in adj["report_html"]
    # contradictory settings are refused in plain words
    for bad in ({"versions": "newest"}, {"versions": "adjudicated", "config": {"resolutions_s": [1.0],
                                                                                "reference_annotator": "A01"}},
                {"versions": "corrected", "config": {"versions": "original"}}, {"unit": "window"}):
        with pytest.raises(ApiError) as e:
            agreement(service, **bad)
        assert e.value.code == "invalid_config"


def test_the_analysis_by_task_compares_each_part_on_its_own(service: StudyService, recordings: Path) -> None:
    people = [User(aid, f"Annotator {aid}") for aid in ("A03", "A04")]
    for u in people:
        service.call("admin", ADMIN, {"op": "user_add", "annotator_id": u.annotator_id, "password": "pass-word-1234"})
    made = service.call("admin", ADMIN, {"op": "tasks_create", "request_id": "1" * 32, "recording_ids": [SUB1],
                                         "k": 2, "annotator_ids": ["A03", "A04"],
                                         "window": {"start_s": 0.0, "end_s": 30.0}})
    tid = made["tasks"][0]["task_id"]
    service.call("submit", people[0], submission(recordings, SUB1, MINE[:2]))
    service.call("submit", people[1], submission(recordings, SUB1, THEIRS))
    by_task = agreement(service, unit="task", annotator_ids=["A03", "A04"])
    assert by_task["summary"]["unit"] == "task"
    rows = by_task["tables"]["versions.tsv"].splitlines()[1:]
    assert rows and all(r.startswith(f"{SUB1}#{tid}\t") for r in rows)
    whole = agreement(service, annotator_ids=["A03", "A04"])
    assert by_task["tables"]["timeresolved_pairwise.tsv"] != whole["tables"]["timeresolved_pairwise.tsv"]


# ------------------------------------------------------------------ weighted consensus (a crowd study's aggregation)
def test_a_consensus_reference_can_weight_people_by_their_gold_accuracy(service: StudyService, recordings: Path,
                                                                        monkeypatch: pytest.MonkeyPatch) -> None:
    a03 = User("A03", "Annotator three")
    service.call("admin", ADMIN, {"op": "user_add", "annotator_id": "A03", "password": "pass-word-1234"})
    service.call("admin", ADMIN, {"op": "assign", "annotator_ids": ["A03"], "recording_ids": [SUB1]})
    service.call("submit", A01, submission(recordings, SUB1, MINE))
    service.call("submit", A02, submission(recordings, SUB1, THEIRS))
    service.call("submit", a03, submission(recordings, SUB1, [MINE[1]]))
    service.call("admin", ADMIN, {"op": "set_create", "set_id": "crowd", "name": "Crowd"})

    def reference(weights: Any) -> dict[str, Any]:
        source = {"kind": "consensus", "annotator_ids": ["A01", "A02", "A03"],
                  **({"weights": weights} if weights is not None else {})}
        return service.call("admin", ADMIN, {"op": "set_add_reference", "set_id": "crowd", "recording_id": SUB1,
                                             "use": "practice", "recording_scope": "study", "source": source})

    def labels() -> list[str]:
        rs = service.reference_set("crowd")
        return [a.label for a in rs.reference_document(SUB1).sorted_annotations()]

    plain = reference(None)["set"]["recordings"][0]["provenance"]
    assert "weights" not in plain["consensus_rule"] and labels() == [EMG]  # a majority agrees on the EMG only
    heavy = reference({"A01": 3, "A02": 1, "A03": 1})["set"]["recordings"][0]["provenance"]
    assert heavy["consensus_rule"]["weights"] == {"A01": 3.0, "A02": 1.0, "A03": 1.0}
    assert labels() == [BLINK, EMG, BLINK]  # A01 carries more than half the weight wherever they marked
    # from the known-answer accuracy (quality_list): refused while someone has too few results
    rows = [{"annotator_id": "A01", "weight": 0.9}, {"annotator_id": "A02", "weight": None},
            {"annotator_id": "A03", "weight": 0.2}]
    monkeypatch.setattr(service.tasks, "op_quality", lambda user, body: {"annotators": rows})
    with pytest.raises(ApiError) as e:
        reference("gold")
    assert (e.value.status, e.value.code) == (422, "no_weight") and "A02" in e.value.message
    rows[1]["weight"] = 0.3
    gold = reference("gold")["set"]["recordings"][0]["provenance"]
    assert gold["consensus_rule"]["weights"] == {"A01": 0.9, "A02": 0.3, "A03": 0.2}
    assert labels() == [BLINK, EMG, BLINK]
    for bad in ({"A01": 1}, {"A01": -1, "A02": 1, "A03": 1}, {"A01": 0, "A02": 0, "A03": 0}, "accuracy"):
        with pytest.raises(ApiError) as e:
            reference(bad)
        assert e.value.status == 400
