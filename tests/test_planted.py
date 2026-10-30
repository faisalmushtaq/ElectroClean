"""Correct the marks: deliberate mistakes planted in a copy of a reference, and the scoring of the corrections
(electrotag/training/planted.py)."""

from __future__ import annotations

import pytest

from electrotag.app.annotations.labels import default_catalogue
from electrotag.app.annotations.model import AnnotationDocument, ArtifactAnnotation, RecordingInfo
from electrotag.app.annotations.timing import RecordingTiming
from electrotag.training.guided import Tolerance, overlaps
from electrotag.training.planted import (
    DEFAULT_COUNTS,
    check_counts,
    confusable,
    errors_from,
    from_wire,
    plant_errors,
    reference_sha256,
    score_corrections,
    wire,
)

CAT = default_catalogue()
SF = 100.0
CH = ("Fp1", "Fp2", "C3", "C4", "O1", "O2")
BLINK, EMG, POP, MOVE = "Eye-blink-artifact", "EMG-artifact", "Electrode-pops-artifact", "Movement-artifact"


def a(i: str, label: str, t0: float, t1: float, ch: tuple[str, ...] = ()) -> ArtifactAnnotation:
    return ArtifactAnnotation(i, label, int(round(t0 * SF)), int(round((t1 - t0) * SF)), ch)


def doc(anns: list[ArtifactAnnotation], n_s: float = 60.0) -> AnnotationDocument:
    return AnnotationDocument(RecordingInfo("rec.edf", RecordingTiming(SF, int(n_s * SF)), CH), "REFERENCE", anns, CAT)


REF = doc([a("r1", BLINK, 2.0, 2.4, ("Fp1", "Fp2")), a("r2", EMG, 6.0, 8.0), a("r3", BLINK, 12.0, 12.4, ("Fp1", "Fp2")),
           a("r4", POP, 20.0, 20.3, ("C3",)), a("r5", EMG, 30.0, 31.5), a("r6", MOVE, 40.0, 42.0),
           a("r7", BLINK, 50.0, 50.4, ("Fp1", "Fp2")), a("r8", EMG, 55.0, 56.0)])
TOL = Tolerance()


def by_kind(p) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for e in p.errors:
        out.setdefault(e["kind"], []).append(e)
    return out


def test_the_same_seed_plants_the_same_mistakes() -> None:
    one, two = plant_errors(REF, seed=7), plant_errors(REF, seed=7)
    assert [wire(x) for x in one.annotations] == [wire(x) for x in two.annotations] and one.errors == two.errors
    other = plant_errors(REF, seed=8)
    assert [wire(x) for x in other.annotations] != [wire(x) for x in one.annotations]
    assert one.made == DEFAULT_COUNTS and not one.capped and one.seed == 7
    # every mark of the copy has a new identifier: nothing tells which were changed
    assert not {x.annotation_id for x in one.annotations} & {x.annotation_id for x in REF.annotations}
    assert all(len(x.annotation_id) == 32 for x in one.annotations)
    assert len(one.annotations) == len(REF.annotations) - 1 + 1  # one left out, one added
    # the reference itself is unchanged
    assert [x.annotation_id for x in REF.annotations][:2] == ["r1", "r2"]


@pytest.mark.parametrize("seed", range(12))
def test_each_kind_follows_its_rule(seed: int) -> None:
    p = plant_errors(REF, seed=seed, counts={"missing": 1, "type": 2, "boundary": 1, "extra": 2})
    kinds = by_kind(p)
    ref = {x.annotation_id: x for x in REF.annotations}
    copy = {x.annotation_id: x for x in p.annotations}
    # at most half of the reference's marks are changed, each at most once
    touched = [e["reference_id"] for e in p.errors if e["reference_id"]]
    assert len(touched) == len(set(touched)) <= len(REF.annotations) // 2
    for e in kinds.get("missing", []):
        gone = ref[e["reference_id"]]
        others = [x for x in REF.annotations if x is not gone]
        assert all(gone.end_sample + 30 <= o.onset_sample or o.end_sample + 30 <= gone.onset_sample for o in others)
        assert not any(overlaps(x, gone) for x in p.annotations)
    for e in kinds.get("type", []):
        new = copy[e["planted_id"]]
        assert new.label == e["planted_label"] != e["label"]
        assert e["planted_label"] in confusable(e["label"], CAT)
        assert (new.onset_sample, new.duration_samples) == (ref[e["reference_id"]].onset_sample,
                                                            ref[e["reference_id"]].duration_samples)
    for e in kinds.get("boundary", []):
        r, new = ref[e["reference_id"]], copy[e["planted_id"]]
        window = TOL.window_s(r.duration_samples / SF)
        moved = abs(new.onset_sample - r.onset_sample) + abs(new.end_sample - r.end_sample)
        assert 2 * window - 0.011 <= moved / SF <= 3 * window + 0.011
        assert (new.onset_sample == r.onset_sample) != (new.end_sample == r.end_sample)
        assert new.duration_samples >= 10 and new.label == r.label
    for e in kinds.get("extra", []):
        new = copy[e["planted_id"]]
        assert all(new.end_sample + 100 <= o.onset_sample or o.end_sample + 100 <= new.onset_sample
                   for o in REF.annotations)
        assert new.label in {x.label for x in REF.annotations}
        like = sorted(x.duration_samples for x in REF.annotations if x.label == new.label)
        assert new.duration_samples == round((like[(len(like) - 1) // 2] + like[len(like) // 2]) / 2)  # their median
        assert new.channels in {x.channels for x in REF.annotations if x.label == new.label}
    # no two marks of the copy overlap (the reference has none)
    marks = sorted(p.annotations, key=lambda x: x.onset_sample)
    assert all(x.end_sample <= y.onset_sample for x, y in zip(marks, marks[1:]))  # noqa: B905
    assert all(0 <= x.onset_sample and x.end_sample <= 6000 for x in marks)


def test_confusable_types_come_from_the_same_group_or_section() -> None:
    eye = confusable(BLINK, CAT)
    assert eye and all(CAT.get(x).section == "Eye" for x in eye)
    move = confusable("Horizontal-eye-movement-artifact", CAT)
    assert move[:3] == ["Vertical-eye-movement-artifact", "Slow-eye-movement-artifact", "Nystagmus-artifact"]
    assert POP not in confusable(BLINK, CAT) and "Salt-bridge-artifact" in confusable(POP, CAT)
    assert confusable(EMG, CAT, used=[MOVE])[0] == MOVE  # those the reference uses first
    assert confusable("Not-a-label", CAT) == []


def test_small_references_are_capped_and_say_so() -> None:
    tiny = doc([a("t1", BLINK, 0.8, 1.2, ("Fp1",)), a("t2", BLINK, 1.3, 1.7, ("Fp1",))], n_s=2.5)
    p = plant_errors(tiny, seed=1)
    assert p.capped and p.notes and "too few marks" in p.notes[0]
    assert sum(p.made[k] for k in ("missing", "type", "boundary")) == 1  # half of two marks
    assert p.made["missing"] == 0  # the two blinks are too close for one to be clearly missing
    assert p.made["extra"] == 0  # no room 1 s from both
    empty = plant_errors(doc([]), seed=1)
    assert empty.annotations == [] and empty.errors == [] and empty.capped


def test_counts_are_checked() -> None:
    assert check_counts(None) == DEFAULT_COUNTS and check_counts({"extra": 3})["extra"] == 3
    for bad in ({"wrong": 1}, {"type": -1}, {"type": 21}, {"type": True}, {k: 0 for k in DEFAULT_COUNTS}):
        with pytest.raises(ValueError):
            check_counts(bad)
    with pytest.raises(ValueError):
        plant_errors(REF, seed="7")  # type: ignore[arg-type]


def test_scoring_the_corrections() -> None:
    p = plant_errors(REF, seed=3)
    planted = list(p.annotations)
    ref = list(REF.annotations)
    # left as it was: nothing fixed, nothing new
    as_is = score_corrections(p.errors, planted, ref, SF, TOL, planted=planted)
    assert (as_is["n_errors"], as_is["fixed"], as_is["not_fixed"], as_is["new_mistakes"]) == (4, 0, 4, 0)
    assert as_is["message"] == "You fixed 0 of 4 planted mistakes."
    # the reference itself: every mistake fixed
    perfect = score_corrections(p.errors, ref, ref, SF, TOL, planted=planted)
    assert (perfect["fixed"], perfect["new_mistakes"]) == (4, 0) and all(i["fixed"] for i in perfect["items"])
    # the reference with one correct mark taken away and one mark added in an empty stretch
    kinds = {e["kind"]: e for e in p.errors}
    touched = {e["reference_id"] for e in p.errors}
    spare = next(x for x in ref if x.annotation_id not in touched)
    extra = kinds["extra"]
    t0 = next(t for t in (35.0, 46.0, 58.5)
              if not (t * SF < extra["end_sample"] and extra["onset_sample"] < (t + 0.7) * SF))
    worse = [x for x in ref if x is not spare] + [a("new", EMG, t0, t0 + 0.7)]
    scored = score_corrections(p.errors, worse, ref, SF, TOL, planted=planted)
    assert scored["fixed"] == 4 and scored["new_mistakes"] == 2
    assert sorted(n["kind"] for n in scored["new"]) == ["added", "broken"]
    broken = next(n for n in scored["new"] if n["kind"] == "broken")
    assert broken["problems"] == ["missing"] and "is now missing" in broken["detail"]
    assert "2 new mistakes" in scored["message"]
    # a type fixed to an accepted other label counts, through the tolerance
    t = kinds["type"]
    tol = Tolerance(accepted_labels={t["label"]: [t["planted_label"]]})
    assert score_corrections([t], planted, ref, SF, tol)["fixed"] == 1
    # a planted extra still there is not fixed; removing it fixes it
    x = kinds["extra"]
    left = from_wire(wire(next(m for m in planted if m.annotation_id == x["planted_id"])))
    assert score_corrections([x], ref + [left], ref, SF, TOL)["fixed"] == 0
    assert score_corrections([x], ref, ref, SF, TOL)["fixed"] == 1


def test_errors_found_in_an_experts_flawed_version() -> None:
    flawed = doc([a("f1", BLINK, 2.0, 2.4, ("Fp1", "Fp2")), a("f2", "Chewing-artifact", 6.0, 8.0),
                  a("f3", BLINK, 12.3, 12.4, ("Fp1", "Fp2")), a("f4", POP, 20.0, 20.3, ("O2",)),
                  a("f5", EMG, 30.0, 31.5), a("f6", MOVE, 40.0, 42.0), a("f7", BLINK, 50.0, 50.4, ("Fp1", "Fp2")),
                  a("f9", BLINK, 45.0, 45.4)])
    errs = errors_from(flawed, REF, TOL)
    assert [(e["kind"], e["reference_id"], e["planted_id"]) for e in errs] == [
        ("missing", "r8", None), ("type", "r2", "f2"), ("boundary", "r3", "f3"), ("extra", None, "f9"),
        ("channels", "r4", "f4")]
    assert errs[2]["edge"] == "start" and errs[2]["shift_s"] == pytest.approx(0.3)
    assert "0.30 s late" in errs[2]["detail"]
    # the expert's version scored against its own mistakes: unchanged, nothing is fixed
    sc = score_corrections(errs, flawed.annotations, REF.annotations, SF, TOL)
    assert (sc["n_errors"], sc["fixed"], sc["new_mistakes"]) == (5, 0, 0)


def test_the_reference_fingerprint_follows_its_marks() -> None:
    assert reference_sha256(REF) == reference_sha256(doc(list(reversed(REF.annotations))))
    assert reference_sha256(REF) != reference_sha256(doc(REF.annotations[1:]))
