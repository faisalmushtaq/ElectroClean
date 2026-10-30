"""Correct the marks in the study: exercises made from a guided recording's reference, through the expert and admin
channels, and the trainee's side (electrotag/web/correct_marks.py)."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastapi")

from electrotag.training.planted import plant_errors  # noqa: E402
from electrotag.web.errors import ApiError  # noqa: E402
from electrotag.web.service import StudyService  # noqa: E402
from electrotag.web.store import User  # noqa: E402
from electrotag.web.store_files import FilesStore  # noqa: E402
from tests.web_helpers import GUIDED1, PRACTICE1, copy_demo, make_template, reference_annotations  # noqa: E402

E01 = User("E01", "Expert one", roles=("annotator", "expert"))
A01 = User("A01", "Annotator one")
ADMIN = User("ADMIN", "Study administrator", role="admin")


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-correct-marks"))


@pytest.fixture
def service(template: Path, tmp_path: Path):
    svc = StudyService(FilesStore(copy_demo(template, tmp_path)))
    yield svc
    svc.store.close()


def document(rs: Any, annotations: list[Any]) -> dict[str, Any]:
    """The guided recording's reference document with other annotations, as an annotation file holds it."""
    from electrotag.app.io.canonical import document_to_dict

    return document_to_dict(replace(rs.reference_document(GUIDED1), annotations=list(annotations)))


def ex(service: StudyService, user: User, op: str, **body: Any) -> dict[str, Any]:
    return service.call("expert", user, {"op": op, **body})


def err(service: StudyService, user: User, op: str, **body: Any) -> ApiError:
    with pytest.raises(ApiError) as e:
        ex(service, user, op, **body)
    return e.value


def test_an_expert_makes_an_exercise_from_a_seed(service: StudyService) -> None:
    listed = ex(service, E01, "planted_list")["sets"]
    rows = next(s for s in listed if s["set_id"] == "example")["recordings"]
    assert GUIDED1 in [r["recording_id"] for r in rows] and all(r["planted"] is None for r in rows)
    made = ex(service, E01, "set_planted_make", set_id="example", recording_id=GUIDED1, seed=42)
    p = made["planted"]
    assert p["seed"] == 42 and p["method"] == "auto" and p["made_by"] == "E01" and not p["stale"]
    assert [e["kind"] for e in p["errors"]] == ["missing", "type", "boundary", "extra"] and p["n_errors"] == 4
    assert all("onset_s" in e and e["detail"] for e in p["errors"])
    # the same seed gives the same exercise as the planting code itself
    rs = service.reference_set("example")
    again = plant_errors(rs.reference_document(GUIDED1), seed=42, catalogue=service.store.catalogue)
    assert p["annotations"] == [{"annotation_id": a.annotation_id, "label": a.label, "onset_sample": a.onset_sample,
                                 "duration_samples": a.duration_samples, "channels": list(a.channels)}
                                for a in again.annotations]
    got = ex(service, E01, "planted_get", set_id="example", recording_id=GUIDED1)
    assert got["planted"] == p and len(got["reference"]) == len(rs.reference_document(GUIDED1).annotations)
    assert got["manifest"]["recording_id"] == GUIDED1 and got["tolerance"]["seconds"] == 0.2
    # kept with the set, listed, and audited
    assert ex(service, E01, "planted_list")["sets"][0]["recordings"][0]["planted"]["n_errors"] == 4
    entry = service.store.audit_entries()[-1] if hasattr(service.store, "audit_entries") else None
    if entry is not None:
        assert entry["op"] == "set_planted_make" and entry["by"] == "E01"
    # a new seed replaces it; without a seed the study chooses one
    other = ex(service, E01, "set_planted_make", set_id="example", recording_id=GUIDED1)["planted"]
    assert isinstance(other["seed"], int) and other["seed"] != 42 or other["annotations"] != p["annotations"]
    capped = ex(service, E01, "set_planted_make", set_id="example", recording_id=GUIDED1, seed=1,
                counts={"missing": 20, "type": 0, "boundary": 0, "extra": 0})["planted"]
    assert capped["capped"] and capped["notes"]


def test_what_is_refused(service: StudyService) -> None:
    assert err(service, A01, "planted_list").code == "forbidden"
    assert err(service, E01, "set_planted_make", set_id="example", recording_id=PRACTICE1).code == "not_guided"
    assert err(service, E01, "set_planted_make", set_id="example", recording_id="nope.edf").code == "not_in_set"
    assert err(service, E01, "set_planted_make", set_id="nothing", recording_id=GUIDED1).code == "no_reference_set"
    for bad in ({"seed": -1}, {"seed": "1"}, {"seed": 10 ** 6}, {"counts": {"missing": 99}}, {"counts": {"x": 1}}):
        assert err(service, E01, "set_planted_make", set_id="example", recording_id=GUIDED1, **bad).status == 400
    assert err(service, E01, "set_planted_remove", set_id="example", recording_id=GUIDED1).code == "no_exercise"
    assert err(service, E01, "set_planted_from", set_id="example", recording_id=GUIDED1,
               source={"kind": "consensus"}).status == 400


def test_an_experts_own_flawed_annotations_and_the_admin_channel(service: StudyService, template: Path) -> None:
    rs = service.reference_set("example")
    ref = reference_annotations(service.store, "example", GUIDED1)
    # the expert's version: the first mark relabelled, the last left out
    first = ref[0]
    label = "Eye-movement-artifact" if first.label != "Eye-movement-artifact" else "Eye-blink-artifact"
    doc = document(rs, [replace(first, label=label), *ref[1:-1]])
    out = service.call("admin", ADMIN, {"op": "set_planted_from", "set_id": "example", "recording_id": GUIDED1,
                                        "source": {"kind": "document", "document": doc}})
    p = out["planted"]
    assert p["method"] == "from_annotations" and sorted(e["kind"] for e in p["errors"]) == ["missing", "type"]
    assert len(p["annotations"]) == len(ref) - 1 and out["set"]["set_id"] == "example"
    got = service.call("admin", ADMIN, {"op": "set_planted_get", "set_id": "example", "recording_id": GUIDED1})
    assert got["planted"]["n_errors"] == 2
    # the reference itself holds no mistakes
    same = document(rs, ref)
    with pytest.raises(ApiError) as e:
        service.call("admin", ADMIN, {"op": "set_planted_from", "set_id": "example", "recording_id": GUIDED1,
                                      "source": {"kind": "document", "document": same}})
    assert e.value.code == "no_mistakes"
    service.call("admin", ADMIN, {"op": "set_planted_remove", "set_id": "example", "recording_id": GUIDED1})
    assert service.call("admin", ADMIN, {"op": "set_planted_get", "set_id": "example",
                                         "recording_id": GUIDED1})["planted"] is None


def test_the_trainees_side(service: StudyService) -> None:
    from electrotag.app.annotations.model import AnnotationDocument
    from electrotag.web.correct_marks import trainee_score, trainee_view

    rs = service.reference_set("example")
    with pytest.raises(ApiError) as e:
        trainee_view(service, rs, GUIDED1)
    assert e.value.code == "no_exercise"
    ex(service, E01, "set_planted_make", set_id="example", recording_id=GUIDED1, seed=5)
    rs = service.reference_set("example")
    view = trainee_view(service, rs, GUIDED1)
    assert view["guidance"] == "correct" and view["n_planted"] == 4 and view["n_steps"] == 0
    assert "errors" not in view and view["start_annotations"] == rs.guided["planted"][GUIDED1]["annotations"]
    ref = rs.reference_document(GUIDED1)
    # the trainee puts everything right: the reference itself
    good = trainee_score(service, rs, GUIDED1, replace(ref, annotator_id="T01"))
    assert (good["fixed"], good["n_errors"], good["new_mistakes"]) == (4, 4, 0) and good["event_f1"] == 1.0
    assert good["planted"]["message"] == "You fixed 4 of 4 planted mistakes."
    # or saves the copy as it was
    from electrotag.training.planted import from_wire

    copy = AnnotationDocument(ref.recording, "T01", [from_wire(a) for a in view["start_annotations"]], ref.catalogue)
    bad = trainee_score(service, rs, GUIDED1, copy)
    assert (bad["fixed"], bad["new_mistakes"]) == (0, 0) and bad["event_f1"] < 1
    # a reference replaced since makes the exercise stale, and trainees are not given it
    doc = document(rs, ref.sorted_annotations()[1:])
    service.call("admin", ADMIN, {"op": "set_add_reference", "set_id": "example", "recording_id": GUIDED1,
                                  "use": "guided", "recording_scope": "set:example",
                                  "source": {"kind": "document", "document": doc}})
    rs = service.reference_set("example")
    assert ex(service, E01, "planted_get", set_id="example", recording_id=GUIDED1)["planted"]["stale"] is True
    with pytest.raises(ApiError):
        trainee_view(service, rs, GUIDED1)


def test_a_trainee_corrects_the_marks_on_the_training_path(service: StudyService, template: Path) -> None:
    from tests.web_helpers import as_wire, skip_to_guided_in, submission

    t01 = User("T01", "Trainee")
    recordings = template / "recordings"
    # the study team gives the first guided recording as an exercise: refused until one is made
    with pytest.raises(ApiError) as e:
        service.call("admin", ADMIN, {"op": "set_recording_update", "set_id": "example", "recording_id": GUIDED1,
                                      "guidance": "correct"})
    assert e.value.code == "no_exercise"
    made = ex(service, E01, "set_planted_make", set_id="example", recording_id=GUIDED1, seed=11)["planted"]
    service.call("admin", ADMIN, {"op": "set_recording_update", "set_id": "example", "recording_id": GUIDED1,
                                  "guidance": "correct"})
    rs = service.reference_set("example")
    assert rs.guidance_for(GUIDED1) == "correct" and rs.guidance_for(rs.guided_recordings[1]) == "find"
    skip_to_guided_in(service, t01)
    view = service.call("guided_get", t01, {"recording_id": GUIDED1})
    assert view["guidance"] == "correct" and view["n_steps"] == 0 and view["n_planted"] == made["n_errors"]
    assert view["start_annotations"] == made["annotations"] and "errors" not in view
    # Save and Finish with the experts' marks: every planted mistake fixed, nothing new
    ref = reference_annotations(service.store, "example", GUIDED1)
    out = service.call("submit", t01, submission(recordings, GUIDED1, [as_wire(a) for a in ref], "guided", "example"))
    planted = out["guided"]["feedback"]["planted"]
    assert (planted["fixed"], planted["n_errors"], planted["new_mistakes"]) == (made["n_errors"], made["n_errors"], 0)
    assert out["guided"]["message"].startswith("Recording saved. You fixed")
    prog = service.store.progress(rs, "T01").guided[GUIDED1]
    assert prog["kind"] == "correct" and prog["fixed"] == made["n_errors"] and prog["event_f1"] == 1.0
    stage = next(s for s in service.call("training", t01, {})["stages"] if s["key"] == "guided")
    assert stage["done"] >= 1
    # removing the exercise gives the recording back to the step-by-step coach
    ex(service, E01, "set_planted_remove", set_id="example", recording_id=GUIDED1)
    assert service.reference_set("example").guidance_for(GUIDED1) == "show"
