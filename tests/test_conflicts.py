"""Conflicts between annotators' versions (electrotag/reliability/conflicts.py): pure, no web code."""

from __future__ import annotations

import pytest

from electrotag.app.annotations.labels import default_catalogue
from electrotag.app.annotations.model import AnnotationDocument, ArtifactAnnotation, RecordingInfo
from electrotag.app.annotations.timing import RecordingTiming
from itertools import chain, combinations

from electrotag.reliability.conflicts import (
    OUTCOMES, ConflictError, ConflictRules, adjudicated_annotations, agreed_mark, apply_decision, conflict_id,
    find_clusters, kept_marks, label_pair, outcome_for,
)

SF = 100.0
CH = ("Fp1", "Fp2", "O1", "O2")
BLINK, MOVE, EMG = "Eye-blink-artifact", "Eye-movement-artifact", "EMG-artifact"
INFO = RecordingInfo("sub-01/eeg/rec.edf", RecordingTiming(SF, 6000), CH)
CAT = default_catalogue()


def a(aid: str, label: str, start_s: float, stop_s: float, channels: tuple[str, ...] = ()) -> ArtifactAnnotation:
    return ArtifactAnnotation(aid, label, round(start_s * SF), round((stop_s - start_s) * SF), channels)


def doc(who: str, *anns: ArtifactAnnotation) -> AnnotationDocument:
    return AnnotationDocument(INFO, who, list(anns), CAT)


def clusters(docs: dict[str, AnnotationDocument], **kw: object) -> list:
    return find_clusters(docs, ch_names=CH, sfreq=SF, unit_id="t-1", **kw)


def test_agreed_marks_are_not_conflicts() -> None:
    cs = clusters({"A": doc("A01", a("a1", BLINK, 1.0, 1.4)), "B": doc("A02", a("b1", BLINK, 1.05, 1.42))})
    assert len(cs) == 1 and cs[0].kinds == () and not cs[0].is_conflict and cs[0].missing == []
    m = agreed_mark(cs[0], CH)
    assert (m.label, m.onset_sample, m.end_sample, m.channels) == (BLINK, 103, 141, ())  # medians, half up


def test_each_kind_of_conflict() -> None:
    A = doc("A01", a("a1", BLINK, 1.0, 1.4), a("a2", BLINK, 3.0, 3.5), a("a3", EMG, 10.0, 12.0),
            a("a4", BLINK, 20.0, 21.0, ("Fp1",)), a("a5", BLINK, 30.0, 30.4))
    B = doc("A02", a("b1", MOVE, 1.0, 1.4), a("b3", EMG, 10.8, 12.0), a("b4", BLINK, 20.0, 21.0, ("O1", "O2")),
            a("b9", BLINK, 40.0, 40.3))
    cs = clusters({"A": A, "B": B})
    kinds = {tuple(sorted(m.annotation_id for m in c.marks)): c.kinds for c in cs}
    assert kinds == {("a1", "b1"): ("type",), ("a2",): ("presence",), ("a3", "b3"): ("timing",),
                     ("a4", "b4"): ("channels",), ("a5",): ("presence",), ("b9",): ("presence",)}
    one = next(c for c in cs if [m.annotation_id for m in c.marks] == ["a2"])
    assert one.missing == ["B"] and one.letters == ("A", "B")
    assert label_pair(next(c for c in cs if c.kinds == ("type",))) == (BLINK, MOVE)
    assert label_pair(one) is None
    # in time order
    assert [c.start for c in cs] == sorted(c.start for c in cs)


def test_a_whole_montage_mark_covers_every_channel() -> None:
    cs = clusters({"A": doc("A01", a("a1", EMG, 5, 7)), "B": doc("A02", a("b1", EMG, 5, 7, CH))})
    assert cs[0].kinds == ()
    cs = clusters({"A": doc("A01", a("a1", EMG, 5, 7)), "B": doc("A02", a("b1", EMG, 5, 7, ("O1",)))})
    assert cs[0].kinds == ("channels",)


def test_the_matching_rules_decide_what_is_one_place() -> None:
    A, B = doc("A01", a("a1", BLINK, 1.0, 2.0)), doc("A02", a("b1", BLINK, 1.8, 2.8))  # IoU 0.2/1.8 = 0.11
    assert [c.kinds for c in clusters({"A": A, "B": B})] == [("presence",), ("presence",)]
    loose = ConflictRules(iou_threshold=0.0)
    assert [c.kinds for c in clusters({"A": A, "B": B}, rules=loose)] == [("timing",)]
    tol = ConflictRules(match_criterion="tolerance", onset_tolerance_s=1.0, offset_tolerance_s=1.0)
    assert [c.kinds for c in clusters({"A": A, "B": B}, rules=tol)] == [()]


def test_three_annotators_chain_into_one_cluster_and_splits_are_found() -> None:
    A = doc("A01", a("a1", BLINK, 1.0, 1.4))
    B = doc("A02", a("b1", BLINK, 1.0, 1.4))
    C = doc("A03", a("c1", MOVE, 1.02, 1.4))
    cs = clusters({"A": A, "B": B, "C": C})
    assert len(cs) == 1 and cs[0].kinds == ("type",) and cs[0].labels == [BLINK, MOVE]
    assert agreed_mark(cs[0], CH).label == BLINK  # the most frequent type
    # A's two marks, each matched to someone else's: one cluster, with A split in two
    A2 = doc("A01", a("a1", EMG, 10.0, 11.0), a("a2", EMG, 11.0, 12.0))
    B2 = doc("A02", a("b1", EMG, 10.0, 11.1))
    C2 = doc("A03", a("c1", EMG, 10.9, 12.0))
    cs = clusters({"A": A2, "B": B2, "C": C2})
    by = {tuple(sorted(m.annotation_id for m in c.marks)): c.kinds for c in cs}
    assert by == {("a1", "b1"): ("presence",), ("a2", "c1"): ("presence",)}
    # a chain through B and C joins A's two marks: one cluster, with A split in two
    C4 = doc("A03", a("c1", EMG, 10.5, 12.0))
    cs = clusters({"A": A2, "B": doc("A02", a("b1", EMG, 10.0, 11.0)), "C": C4})
    assert len(cs) == 1 and cs[0].missing == [] and "split" in cs[0].kinds and "timing" in cs[0].kinds
    assert len(cs[0].marks_of("A")) == 2


def test_marks_are_clipped_to_the_window() -> None:
    A = doc("A01", a("a1", BLINK, 1.0, 1.4), a("a2", EMG, 9.5, 10.5), a("a3", BLINK, 20.0, 20.5))
    B = doc("A02", a("b2", EMG, 10.0, 10.5))
    cs = clusters({"A": A, "B": B}, window=(1000, 2000))
    assert len(cs) == 1
    ms = cs[0].marks
    assert [(m.annotation_id, m.start, m.stop) for m in ms] == [("a2", 1000, 1050), ("b2", 1000, 1050)]
    assert cs[0].kinds == ()


def test_conflict_ids_are_stable_and_depend_on_the_marks() -> None:
    A = doc("A01", a("a1", BLINK, 1.0, 1.4), a("a2", EMG, 5, 6))
    B = doc("A02", a("b1", MOVE, 1.0, 1.4))
    first = [c.cluster_id for c in clusters({"A": A, "B": B})]
    again = [c.cluster_id for c in clusters({"A": doc("A01", *reversed(A.annotations)), "B": B})]
    assert first == again and all(i.startswith("c-") and len(i) == 18 for i in first)
    assert first != [c.cluster_id for c in find_clusters({"A": A, "B": B}, ch_names=CH, sfreq=SF, unit_id="t-2")]
    c = clusters({"A": A, "B": B})[0]
    assert conflict_id("t-1", c.marks) == c.cluster_id
    # two corrections of one person's work: the correctors are named, so the same annotation ID does not clash
    X, Y = doc("A01", a("x", BLINK, 1, 1.4)), doc("A01", a("x", MOVE, 1, 1.4))
    cs = find_clusters({"A": X, "B": Y}, ch_names=CH, sfreq=SF, unit_id="k-1", who={"A": "E01", "B": "E02"})
    assert cs[0].kinds == ("type",) and {m.annotator_id for m in cs[0].marks} == {"E01", "E02"}


def test_every_choice() -> None:
    A = doc("A01", a("a1", BLINK, 1.0, 1.4, ("Fp1",)))
    B = doc("A02", a("b1", MOVE, 1.1, 1.6, ("Fp2",)), a("b2", MOVE, 1.6, 1.7, ("Fp1",)))
    C = doc("A03", a("c1", BLINK, 1.05, 1.5))
    cs = clusters({"A": A, "B": B, "C": C}, rules=ConflictRules(iou_threshold=0.0))
    c = next(x for x in cs if x.is_conflict and len(x.marks) >= 3)
    keep_a = apply_decision(c, {"choice": "A"}, CH)
    assert [(k.label, k.onset_sample, k.end_sample, k.channels) for k in keep_a] == [(BLINK, 100, 140, ("Fp1",))]
    assert keep_a[0].annotation_id == f"{c.cluster_id}-A1"
    both = apply_decision(c, {"choice": "all"}, CH)
    by_label = {k.label: k for k in both}
    assert by_label[BLINK].channels == () and (by_label[BLINK].onset_sample, by_label[BLINK].end_sample) == (100, 150)
    assert apply_decision(c, {"choice": "none"}, CH) == []
    own = [a("mine", BLINK, 1.0, 1.5, ("Fp1", "Fp2")).with_changes(confidence=4, note="theirs")]
    edited = apply_decision(c, {"choice": "edited", "marks": own}, CH)
    assert edited[0].annotation_id == f"{c.cluster_id}-e1" and edited[0].confidence is None and edited[0].note == ""
    with pytest.raises(ConflictError):
        apply_decision(c, {"choice": "edited", "marks": []}, CH)
    with pytest.raises(ConflictError):
        apply_decision(c, {"choice": "Z"}, CH)
    # a letter with no mark in the conflict keeps nothing
    missing = next(x for x in clusters({"A": A, "B": doc("A02")}) if x.missing)
    assert apply_decision(missing, {"choice": "B"}, CH) == []


def test_the_adjudicated_version_is_the_agreed_marks_and_the_decisions() -> None:
    A = doc("A01", a("a1", BLINK, 1.0, 1.4), a("a2", EMG, 10, 12), a("a3", BLINK, 20, 20.4))
    B = doc("A02", a("b1", BLINK, 1.0, 1.4), a("b2", EMG, 10, 12, ("O1",)))
    cs = clusters({"A": A, "B": B})
    conflicts = [c for c in cs if c.is_conflict]
    with pytest.raises(ConflictError):
        adjudicated_annotations(cs, {}, CH)
    decided = {conflicts[0].cluster_id: {"choice": "B"}, conflicts[1].cluster_id: {"choice": "none"}}
    out = adjudicated_annotations(cs, decided, CH)
    assert [(x.label, x.onset_sample, x.channels) for x in out] == [(BLINK, 100, ()), (EMG, 1000, ("O1",))]
    assert len({x.annotation_id for x in out}) == len(out)


def test_marks_from_different_people_can_be_kept_together() -> None:
    # as in the review: A has an eye movement; B an EMG and a blink; C a blink: B's two marks chain into one cluster
    A = doc("A01", a("a1", MOVE, 1.0, 1.4, ("Fp1",)))
    B = doc("A02", a("b1", EMG, 1.0, 1.4), a("b2", BLINK, 1.4, 1.6, ("Fp1", "Fp2")))
    C = doc("A03", a("c1", BLINK, 1.3, 1.6))
    c = next(x for x in clusters({"A": A, "B": B, "C": C}, rules=ConflictRules(iou_threshold=0.0)) if x.is_conflict)
    assert {m.annotation_id for m in c.marks} == {"a1", "b1", "b2", "c1"} and "split" in c.kinds
    kept = apply_decision(c, {"choice": "pick", "picks": [{"letter": "B", "annotation_id": "b2"},
                                                          {"letter": "A", "annotation_id": "a1"}]}, CH)
    assert [(k.label, k.onset_sample, k.channels) for k in kept] == [(MOVE, 100, ("Fp1",)),
                                                                     (BLINK, 140, ("Fp1", "Fp2"))]
    assert len({k.annotation_id for k in kept}) == 2
    for bad in ([], [{"letter": "A", "annotation_id": "zz"}], [{"letter": "A", "annotation_id": "a1"}] * 2, "a1"):
        with pytest.raises(ConflictError):
            apply_decision(c, {"choice": "pick", "picks": bad}, CH)
    assert kept_marks(c, {"choice": "pick", "picks": [{"letter": "B", "annotation_id": "b2"}]}) == {("B", "b2")}
    # for each person, from what was kept: B had two marks and one is kept
    pick = {"choice": "pick", "picks": [{"letter": "B", "annotation_id": "b2"}]}
    assert (outcome_for(c, pick, "A"), outcome_for(c, pick, "B")) == ("other_kept", "part_kept")
    both = {"choice": "pick", "picks": [{"letter": "B", "annotation_id": "b2"}, {"letter": "A", "annotation_id": "a1"}]}
    assert (outcome_for(c, both, "A"), outcome_for(c, both, "B")) == ("all_kept", "part_kept")
    assert outcome_for(c, {"choice": "pick", "picks": [{"letter": "A", "annotation_id": "a1"}]}, "A") == "yours_kept"


def _expected(choice: str, me: str, marked: set[str], picked: set[str]) -> str:
    """What the annotator behind ``me`` should be told, worked out by hand from who marked the place (one mark each)."""
    if choice == "edited":
        return "edited"
    kept = ({choice} & marked if len(choice) == 1 else marked if choice == "all"
            else picked if choice == "pick" else set())
    if me not in marked:
        return "other_kept" if kept else "yours_kept"
    if me in kept:
        return "all_kept" if kept - {me} else "yours_kept"
    return "other_kept" if kept else "none_kept"


@pytest.mark.parametrize("k", [2, 3])
def test_every_outcome_for_every_person_follows_from_what_was_kept(k: int) -> None:
    letters = "ABC"[:k]
    labels = (BLINK, MOVE, EMG)
    seen = set()
    for n in range(1, k + 1):
        for marked in map(set, combinations(letters, n)):
            docs = {x: doc(f"A0{i + 1}", *([a(f"{x.lower()}1", labels[i], 1.0, 1.4)] if x in marked else []))
                    for i, x in enumerate(letters)}
            c = next(x for x in clusters(docs) if x.is_conflict)
            assert {m.letter for m in c.marks} == marked
            picks = [set(p) for p in chain.from_iterable(combinations(sorted(marked), r) for r in range(1, n + 1))]
            decisions = [(x, {"choice": x}, set()) for x in [*letters, "all", "none"]]
            decisions.append(("edited", {"choice": "edited", "marks": [a("e", BLINK, 1.0, 1.4)]}, set()))
            decisions += [("pick", {"choice": "pick",
                                    "picks": [{"letter": x, "annotation_id": f"{x.lower()}1"} for x in p]}, p)
                          for p in picks]
            for name, d, picked in decisions:
                for me in letters:
                    got = outcome_for(c, d, me)
                    assert got in OUTCOMES
                    assert got == _expected(name, me, marked, picked), (k, marked, d, me)
                    seen.add(got)
    assert seen == set(OUTCOMES) - {"part_kept"}  # part_kept needs two marks of one person (the test above)


def test_the_cases_of_the_usability_review() -> None:
    # k=3, only B marked the place; keeping A (who had no mark) agrees with C, who had none either
    docs = {"A": doc("A08"), "B": doc("A03", a("b1", BLINK, 1.0, 1.4)), "C": doc("A09")}
    c = next(x for x in clusters(docs) if x.is_conflict)
    assert [outcome_for(c, {"choice": "A"}, x) for x in "ABC"] == ["yours_kept", "none_kept", "yours_kept"]
    # A and C marked it; keeping B (no mark) drops both, and with all kept, B is told a colleague's mark was kept
    docs = {"A": doc("A08", a("a1", BLINK, 1.0, 1.4)), "B": doc("A03"), "C": doc("A09", a("c1", MOVE, 1.0, 1.4))}
    c = next(x for x in clusters(docs) if x.is_conflict)
    assert [outcome_for(c, {"choice": "B"}, x) for x in "ABC"] == ["none_kept", "yours_kept", "none_kept"]
    assert [outcome_for(c, {"choice": "all"}, x) for x in "ABC"] == ["all_kept", "other_kept", "all_kept"]


def test_on_256_channels_marks_agree_on_channels_when_their_jaccard_index_reaches_the_rule() -> None:
    """review.matching.channel_jaccard (0.5 by default) decides: 120 of the other's 180 channels (0.67) and the
    whole montage against 180 of 256 (0.70) agree; 80 of 180 (0.44), 100 of 256 against the whole montage (0.39)
    and disjoint sets are channel conflicts. docs/reliability_guide.md ("3. Channels") says so."""
    ch = tuple(f"E{i}" for i in range(1, 257))
    info = RecordingInfo("sub-01/eeg/hd.edf", RecordingTiming(SF, 6000), ch)

    def kinds(mine: tuple[str, ...], theirs: tuple[str, ...], jaccard: float = 0.5) -> tuple[str, ...]:
        docs = {"A": AnnotationDocument(info, "A01", [a("a1", EMG, 5, 7, mine)], CAT),
                "B": AnnotationDocument(info, "A02", [a("b1", EMG, 5, 7, theirs)], CAT)}
        (c,) = find_clusters(docs, ch_names=ch, sfreq=SF, unit_id="t-256",
                             rules=ConflictRules(channel_jaccard=jaccard))
        return c.kinds

    assert kinds(ch[:120], ch[:180]) == ()
    assert kinds((), ch[:180]) == ()
    assert kinds(ch[:80], ch[:180]) == ("channels",)
    assert kinds((), ch[:100]) == ("channels",)
    assert kinds(ch[:128], ch[128:]) == ("channels",)
    # a study that wants the same channels to the last one says so with a higher threshold
    assert kinds(ch[:120], ch[:180], jaccard=0.9) == ("channels",)
    assert kinds(ch[:180], ch[:180], jaccard=1.0) == ()
