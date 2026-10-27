"""Inter-rater agreement validated against hand-computed examples (test 18, 19, 20)."""

from __future__ import annotations

import json
import math
from itertools import combinations

import numpy as np
import pytest

from electroclean.app.annotations.labels import LabelCatalogue, default_catalogue
from electroclean.app.annotations.model import AnnotationDocument, AnnotationError, ArtifactAnnotation, RecordingInfo
from electroclean.app.annotations.timing import RecordingTiming
from electroclean.reliability.analysis import run_analysis, write_outputs
from electroclean.reliability.config import ANY_ARTIFACT, AnalysisConfig
from electroclean.reliability.data import build_dataset
from electroclean.reliability.intervals import binarise, coverage_per_bin, intersection_length, union
from electroclean.reliability.matching import events_for, match_events
from electroclean.config.settings import CONFIG_DIR
from electroclean.reliability.statistics import (
    PairTable,
    fleiss_kappa,
    histogram_from_counts,
    krippendorff_alpha_binary,
    pair_statistics,
)

CAT = default_catalogue()
CH = ("C1", "C2", "C3", "C4")
SF = 100.0


def doc(annotator, anns, rid="rec.vhdr", n=1000, mode="standard", created="2026-01-01", ch=CH):
    rec = RecordingInfo(rid, RecordingTiming(SF, n), ch)
    items = [
        ArtifactAnnotation(f"{annotator}-{i}", lab, int(round(a * SF)), int(round((b - a) * SF)), tuple(c))
        for i, (lab, a, b, c) in enumerate(anns)
    ]
    return AnnotationDocument(rec, annotator, items, CAT, mode=mode, created_at=created, session_id=annotator)


def analyse(docs, **cfg):
    config = AnalysisConfig(**{"resolutions_s": (1.0,), **cfg})
    ds = build_dataset([(d.annotator_id, d) for d in docs], config)
    return run_analysis(ds, config)


def row(df, **kw):
    sel = df
    for k, v in kw.items():
        sel = sel[sel[k] == v]
    assert len(sel) == 1, f"expected one row for {kw}, got {len(sel)}"
    return sel.iloc[0]


# ------------------------------------------------------------------- basics
def test_interval_helpers():
    assert union([(5, 8), (0, 2), (1, 3), (8, 9)]) == [(0, 3), (5, 9)]
    assert intersection_length([(0, 10), (20, 30)], [(5, 25)]) == 10
    cov = coverage_per_bin([(10, 20)], sfreq=100.0, bin_s=0.3, duration_s=1.0)
    np.testing.assert_allclose(cov[:2], [1 / 3, 0.0])
    assert list(binarise(cov, 0.5)[:2]) == [False, False]
    assert list(binarise(cov, 0.0)[:2]) == [True, False]
    assert len(cov) == 4  # last bin [0.9, 1.0) is shorter


def test_pair_statistics_hand_computed():
    s = pair_statistics(PairTable(1, 1, 1, 7))
    assert s.proportion_agreement == pytest.approx(0.8)
    assert s.cohen_kappa == pytest.approx(0.375)  # (0.8 - 0.68) / 0.32
    assert s.positive_agreement == pytest.approx(0.5)  # 2*1 / (2 + 1 + 1)
    assert s.negative_agreement == pytest.approx(0.875)  # 2*7 / (14 + 2)
    assert s.prevalence_index == pytest.approx(-0.6)
    assert s.bias_index == pytest.approx(0.0)
    assert s.pabak == pytest.approx(0.6)


def test_clean_recording_and_absent_annotations():
    s = pair_statistics(PairTable(0, 0, 0, 10))
    assert s.proportion_agreement == 1.0
    assert s.negative_agreement == 1.0
    assert math.isnan(s.positive_agreement) and math.isnan(s.cohen_kappa)
    assert "undefined" in s.note


def test_fleiss_and_alpha_hand_computed():
    # Units weighted by duration: k positives of m=3 raters.
    hist = {(3, 2): 1.0, (3, 3): 1.0, (3, 1): 1.0, (3, 0): 7.0}
    k, _ = fleiss_kappa(hist)
    assert k == pytest.approx(7 / 12)
    a, _ = krippendorff_alpha_binary({key: w * 100 for key, w in hist.items()})
    assert a == pytest.approx(1 - 2999 * 400 / (2 * 2400 * 600))


def _alpha_reference(matrix):
    """Textbook nominal Krippendorff's alpha from a raters x units matrix (np.nan = missing)."""
    values = sorted({v for v in matrix.flatten() if not np.isnan(v)})
    idx = {v: i for i, v in enumerate(values)}
    o = np.zeros((len(values), len(values)))
    for u in range(matrix.shape[1]):
        col = [v for v in matrix[:, u] if not np.isnan(v)]
        m = len(col)
        if m < 2:
            continue
        for i, j in ((i, j) for i in range(m) for j in range(m) if i != j):
            o[idx[col[i]], idx[col[j]]] += 1 / (m - 1)
    nc = o.sum(axis=1)
    n = nc.sum()
    do = sum(o[c, k] for c in range(len(values)) for k in range(len(values)) if c != k)
    de = sum(nc[c] * nc[k] for c in range(len(values)) for k in range(len(values)) if c != k) / (n - 1)
    return 1 - do / de


def _fleiss_reference(counts, m):
    n_units = len(counts)
    table = np.array([[m - k, k] for k in counts], dtype=float)
    p = table.sum(axis=0) / (n_units * m)
    pi = ((table * (table - 1)).sum(axis=1)) / (m * (m - 1))
    pbar, pe = pi.mean(), (p**2).sum()
    return (pbar - pe) / (1 - pe)


@pytest.mark.parametrize("seed", range(5))
def test_multirater_statistics_match_reference_implementations(seed):
    rng = np.random.default_rng(seed)
    m, n_units = 4, 60
    ratings = (rng.random((m, n_units)) < 0.3).astype(float)
    counts = ratings.sum(axis=0).astype(int)
    hist = histogram_from_counts(m, counts.tolist())
    assert fleiss_kappa(hist)[0] == pytest.approx(_fleiss_reference(counts, m))
    assert krippendorff_alpha_binary(hist)[0] == pytest.approx(_alpha_reference(ratings))
    # With missing ratings (variable raters per unit) alpha still matches.
    ratings[0, :10] = np.nan
    ratings[1, 5:8] = np.nan
    hist2: dict = {}
    for u in range(n_units):
        col = ratings[:, u][~np.isnan(ratings[:, u])]
        key = (len(col), int(col.sum()))
        hist2[key] = hist2.get(key, 0) + 1
    assert krippendorff_alpha_binary(hist2)[0] == pytest.approx(_alpha_reference(ratings))
    assert math.isnan(fleiss_kappa(hist2)[0])  # unequal raters per unit


# ------------------------------------------------------------ time-resolved
def test_time_resolved_two_raters():
    res = analyse([doc("A", [("EMG-artifact", 1, 3, ())]), doc("B", [("EMG-artifact", 2, 4, ())])])
    df = res.table("timeresolved_pairwise")
    r = row(df, recording="ALL (pooled)", category="EMG-artifact", channel_mode="time_only", representation="exact")
    assert (r.both, r.only_1, r.only_2, r.neither) == pytest.approx((1.0, 1.0, 1.0, 7.0))
    assert r.cohen_kappa == pytest.approx(0.375)
    b = row(df, recording="ALL (pooled)", category="EMG-artifact", channel_mode="time_only", representation="bins_1s")
    assert (b.both, b.only_1, b.only_2, b.neither) == (1.0, 1.0, 1.0, 7.0)
    # A category nobody used: agreement on absence only.
    c = row(df, recording="ALL (pooled)", category="Chewing-artifact", channel_mode="time_only", representation="exact")
    assert c.neither == pytest.approx(10.0) and math.isnan(c.cohen_kappa) and math.isnan(c.positive_agreement)


def test_time_resolved_three_raters_multirater():
    docs = [
        doc("A", [("EMG-artifact", 0, 2, ())]),
        doc("B", [("EMG-artifact", 0, 2, ())]),
        doc("C", [("EMG-artifact", 1, 3, ())]),
    ]
    res = analyse(docs)
    mr = res.table("timeresolved_multirater")
    r = row(mr, recording="ALL (pooled)", category="EMG-artifact", channel_mode="time_only", representation="exact")
    assert r.fleiss_kappa == pytest.approx(7 / 12)
    assert r.n_units == pytest.approx(1000)
    assert r.raters_per_unit == "3"


def test_repeated_same_label_annotations_are_unioned_for_time_agreement():
    a = doc("A", [("EMG-artifact", 1, 2, ()), ("EMG-artifact", 1.5, 3, ())])
    b = doc("B", [("EMG-artifact", 1, 3, ())])
    df = analyse([a, b]).table("timeresolved_pairwise")
    r = row(df, recording="ALL (pooled)", category="EMG-artifact", channel_mode="time_only", representation="exact")
    assert r.cohen_kappa == pytest.approx(1.0)


def test_whole_montage_versus_channel_specific():
    a = doc("A", [("EMG-artifact", 0, 1, ())])  # whole montage
    b = doc("B", [("EMG-artifact", 0, 1, ("C1",))])
    res = analyse([a, b])
    df = res.table("timeresolved_pairwise")
    t = row(df, recording="ALL (pooled)", category="EMG-artifact", channel_mode="time_only", representation="exact")
    assert t.cohen_kappa == pytest.approx(1.0)
    c = row(df, recording="ALL (pooled)", category="EMG-artifact", channel_mode="time_and_channel", representation="exact")
    assert (c.both, c.only_1, c.only_2, c.neither) == pytest.approx((1.0, 3.0, 0.0, 36.0))
    assert c.unit == "channel-seconds"
    ev = res.table("events_summary")
    e = row(ev, category="EMG-artifact", channel_mode="time_and_channel", threshold=0.2)
    assert e.f1 == 1.0 and e.mean_channel_jaccard == pytest.approx(0.25)
    strict = analyse([a, b], min_channel_jaccard=0.5).table("events_summary")
    assert row(strict, category="EMG-artifact", channel_mode="time_and_channel", threshold=0.2).f1 == 0.0


def test_pooled_equals_sum_of_recordings():
    docs = [
        doc("A", [("EMG-artifact", 1, 3, ())], rid="r1"), doc("B", [("EMG-artifact", 2, 4, ())], rid="r1"),
        doc("A", [("EMG-artifact", 5, 6, ())], rid="r2"), doc("B", [], rid="r2"),
    ]
    df = analyse(docs).table("timeresolved_pairwise")
    sel = df[(df.category == "EMG-artifact") & (df.channel_mode == "time_only") & (df.representation == "exact")]
    per = sel[sel.recording != "ALL (pooled)"]
    pooled = sel[sel.recording == "ALL (pooled)"].iloc[0]
    for col in ("both", "only_1", "only_2", "neither"):
        assert per[col].sum() == pytest.approx(pooled[col])
    assert pooled.only_1 == pytest.approx(2.0)


def test_any_artifact_and_confusion():
    a = doc("A", [("EMG-artifact", 0, 1, ())])
    b = doc("B", [("Chewing-artifact", 0, 1, ())])
    res = analyse([a, b])
    df = res.table("timeresolved_pairwise")
    anyr = row(df, recording="ALL (pooled)", category=ANY_ARTIFACT, channel_mode="time_only", representation="exact")
    assert anyr.cohen_kappa == pytest.approx(1.0)  # both found an artifact there ...
    emg = row(df, recording="ALL (pooled)", category="EMG-artifact", channel_mode="time_only", representation="exact")
    assert emg.positive_agreement == 0.0  # ... but disagreed on its type
    conf = res.table("confusion_time_weighted")
    assert row(conf, label_rater_1="EMG-artifact", label_rater_2="Chewing-artifact").seconds == pytest.approx(1.0)
    assert row(conf, label_rater_1="none", label_rater_2="none").seconds == pytest.approx(9.0)


# ------------------------------------------------------------------ matching
def _events(intervals, annotator="X"):
    d = doc(annotator, [("EMG-artifact", a, b, ()) for a, b in intervals])
    return events_for(d, "EMG-artifact", CH)


def _match(ref, test, **kw):
    params = dict(sfreq=SF, criterion="iou", iou_threshold=0.0, onset_tolerance_s=0.5, offset_tolerance_s=0.5,
                  require_channels=False, min_channel_jaccard=0.0, many_to_one=False)
    params.update(kw)
    return match_events(ref, test, **params)


def test_one_to_one_matching_prefers_best_overlap():
    ref = _events([(1, 3)], "R")
    test = _events([(2, 4), (2.5, 3.5)], "T")  # IoU 1/3 and 0.2
    out = _match(ref, test)
    assert out.pairs == [(0, 0)] and out.unmatched_test == [1]
    many = _match(ref, test, many_to_one=True)
    assert many.matched_ref == 1 and many.matched_test == 2
    assert _match(ref, test, iou_threshold=0.5).pairs == []


def test_matching_maximises_number_of_matches_first():
    ref = _events([(0, 10), (8, 9)], "R")
    test = _events([(0, 9), (9.5, 10.5)], "T")
    out = _match(ref, test)
    # Greedy-by-IoU would match only (0,10)-(0,9); the optimum matches both.
    assert out.matched_ref == 2 and out.matched_test == 2


def test_tolerance_criterion():
    ref = _events([(1, 2)], "R")
    test = _events([(1.3, 2.4)], "T")
    assert _match(ref, test, criterion="tolerance").pairs == [(0, 0)]
    assert _match(ref, test, criterion="tolerance", onset_tolerance_s=0.2).pairs == []
    near = _events([(2.1, 3.0)], "T")  # no overlap, but close
    assert _match(ref, near, criterion="tolerance", onset_tolerance_s=1.2, offset_tolerance_s=1.2).pairs == [(0, 0)]
    assert _match(ref, near, criterion="iou_and_tolerance", onset_tolerance_s=1.2, offset_tolerance_s=1.2).pairs == []


def test_matching_is_deterministic():
    rng = np.random.default_rng(3)
    ints = sorted((float(a), float(a + d)) for a, d in zip(rng.uniform(0, 8, 12), rng.uniform(0.1, 1.0, 12)))
    ref = _events(ints[::2], "R")
    test = _events(ints[1::2], "T")
    assert _match(ref, test).pairs == _match(ref, test).pairs


def test_event_summary_and_timing_statistics():
    a = doc("A", [("Eye-blink-artifact", 1, 1.4, ()), ("Eye-blink-artifact", 5, 5.4, ())])
    b = doc("B", [("Eye-blink-artifact", 1.1, 1.4, ()), ("Eye-blink-artifact", 5.2, 5.6, ()), ("Eye-blink-artifact", 8, 8.3, ())])
    res = analyse([a, b])
    ev = res.table("events_summary")
    r = row(ev, category="Eye-blink-artifact", channel_mode="time_only", threshold=0.2)
    assert (r.n_reference, r.n_compared, r.matched_reference, r.missed, r.extra) == (2, 3, 2, 0, 1)
    assert r.recall == 1.0 and r.precision == pytest.approx(2 / 3) and r.f1 == pytest.approx(0.8)
    assert r.onset_diff_mean_s == pytest.approx(0.15)  # (0.1 + 0.2) / 2
    assert r.offset_diff_mean_s == pytest.approx(0.1)  # (0.0 + 0.2) / 2
    matched = res.table("events_matched")
    assert len(matched[(matched.category == "Eye-blink-artifact") & (matched.threshold == 0.2) & (matched.channel_mode == "time_only")]) == 2
    un = res.table("events_unmatched")
    extra = un[(un.category == "Eye-blink-artifact") & (un.threshold == 0.2) & (un.channel_mode == "time_only")]
    assert list(extra.kind) == ["extra (false positive)"] and extra.iloc[0].onset_s == pytest.approx(8.0)
    micro = row(ev, category="ALL categories (micro-average)", channel_mode="time_only", threshold=0.2)
    assert micro.f1 == pytest.approx(0.8)


def test_reference_annotator_orientation():
    docs = [doc("A", [("EMG-artifact", 1, 2, ())]), doc("REF", [("EMG-artifact", 1, 2, ()), ("EMG-artifact", 4, 5, ())])]
    ev = analyse(docs, reference_annotator="REF").table("events_summary")
    r = row(ev, category="EMG-artifact", channel_mode="time_only", threshold=0.2)
    assert (r.reference, r.compared, r.recall, r.precision) == ("REF", "A", 0.5, 1.0)


# ------------------------------------------------------------------ loading
def test_dataset_rules():
    a1 = doc("A", [("EMG-artifact", 1, 2, ())], created="2026-01-01")
    a2 = doc("A", [("EMG-artifact", 1, 3, ())], created="2026-02-01")
    b = doc("B", [("EMG-artifact", 1, 3, ())])
    p = doc("C", [("EMG-artifact", 1, 3, ())], mode="practice")
    cfg = AnalysisConfig(resolutions_s=(1.0,))
    ds = build_dataset([("a1", a1), ("a2", a2), ("b", b), ("p", p)], cfg)
    assert ds.groups["rec.vhdr"].annotators == ["A", "B"]  # practice excluded, latest of A kept
    assert ds.groups["rec.vhdr"].docs["A"] is a2 and ds.warnings
    with pytest.raises(AnnotationError):
        build_dataset([("a1", a1), ("a2", a2)], AnalysisConfig(duplicate_policy="error"))
    other = doc("D", [], n=2000)
    # One file against one: no way to tell which timing is right, so the recording is excluded.
    ds = build_dataset([("b", b), ("d", other)], cfg)
    assert "rec.vhdr" not in ds.groups and any("excluded" in w for w in ds.warnings)
    # The majority timing wins, whatever the annotator IDs (here the odd one out sorts first).
    odd = doc("A", [], n=999)
    c = doc("C", [("EMG-artifact", 1, 3, ())])
    ds = build_dataset([("a", odd), ("b", b), ("c", c)], cfg)
    assert ds.groups["rec.vhdr"].annotators == ["B", "C"] and any("a: timing" in w for w in ds.warnings)
    # A designated reference annotator sets the expected timing.
    ref_cfg = AnalysisConfig(resolutions_s=(1.0,), reference_annotator="A")
    ds = build_dataset([("a", odd), ("b", b), ("c", c)], ref_cfg)
    assert ds.groups["rec.vhdr"].annotators == ["A"]


def test_synthetic_raters_end_to_end(tmp_path):
    from electroclean.synthetic import make_synthetic_dataset, simulate_rater

    truths = make_synthetic_dataset(tmp_path / "ds", n_subjects=2, duration_s=40.0, seed=4)
    docs = []
    for rid, truth in truths.items():
        docs.append(("truth-copy", AnnotationDocument(truth.recording, "T1", list(truth.annotations), CAT, session_id="t")))
        docs.append(("truth-copy2", AnnotationDocument(truth.recording, "T2", list(truth.annotations), CAT, session_id="t")))
        docs.append(("sim", simulate_rater(truth, "S1", seed=1)))
    cfg = AnalysisConfig()
    res = run_analysis(build_dataset(docs, cfg), cfg)
    ev = res.table("events_summary")
    same = ev[(ev.reference == "T1") & (ev.compared == "T2") & (ev.category == "ALL categories (micro-average)")]
    assert (same.f1 == 1.0).all()
    tr = res.table("timeresolved_pairwise")
    same_tr = tr[(tr.rater_1 == "T1") & (tr.rater_2 == "T2") & (tr.recording == "ALL (pooled)") & (tr.category == ANY_ARTIFACT)]
    assert np.allclose(same_tr.cohen_kappa, 1.0)
    sim = tr[(tr.rater_1 == "S1") & (tr.rater_2 == "T1") & (tr.recording == "ALL (pooled)") & (tr.category == ANY_ARTIFACT)
             & (tr.representation == "exact") & (tr.channel_mode == "time_only")]
    assert 0.3 < float(sim.cohen_kappa.iloc[0]) < 1.0
    paths = write_outputs(res, tmp_path / "out")
    html = paths["report"].read_text()
    assert "Agreement by artifact category" in html and "<img" in html
    assert (tmp_path / "out" / "events_matched.tsv").exists()


def test_pairs_are_all_combinations():
    docs = [doc(x, [("EMG-artifact", 1, 2, ())]) for x in ("A", "B", "C")]
    df = analyse(docs).table("timeresolved_pairwise")
    pooled = df[(df.recording == "ALL (pooled)") & (df.category == "EMG-artifact") & (df.representation == "exact") & (df.channel_mode == "time_only")]
    assert sorted(zip(pooled.rater_1, pooled.rater_2)) == sorted(combinations("ABC", 2))


# ------------------------------------------------------- edge cases (review)
def test_report_when_no_compared_recording_has_annotations(tmp_path):
    # Kappa is undefined everywhere; the report must still be written.
    blink = "Eye-blink-artifact"
    res = analyse([doc("A", [], rid="r1"), doc("B", [], rid="r1"), doc("C", [(blink, 1, 2, ())], rid="r2")])
    paths = write_outputs(res, tmp_path)
    assert "report" in paths and paths["report"].exists()


def test_events_on_excluded_channels_leave_channel_matching():
    blink = "Eye-blink-artifact"
    anns = [(blink, 1.0, 1.5, ("C4",)), (blink, 3.0, 3.5, ("C1",))]
    res = analyse([doc("A", anns), doc("B", anns)], channel_exclude=("C4",))
    ev = res.table("events_summary")
    for mode in ("time_only", "time_and_channel"):
        r = row(ev, category=blink, channel_mode=mode, threshold=0.2)
        assert r.f1 == 1.0
    assert row(ev, category=blink, channel_mode="time_and_channel", threshold=0.2).n_reference == 1
    assert row(ev, category=blink, channel_mode="time_only", threshold=0.2).n_reference == 2


def test_any_artifact_prefers_same_label_and_respects_categories():
    blink, emg = "Eye-blink-artifact", "EMG-artifact"
    # The compared annotator marked EMG and blink over the reference blink: the blink is the match.
    ref = doc("A", [(blink, 1, 1.3, ())])
    other = doc("B", [(emg, 1, 1.3, ()), (blink, 1, 1.3, ())])
    m = analyse([ref, other], reference_annotator="A").table("events_matched")
    (r,) = m[(m.category == ANY_ARTIFACT) & (m.channel_mode == "time_only") & (m.threshold == 0.2)].itertuples()
    assert r.compared_label == blink
    # With the analysis limited to EMG, ANY-artifact pools EMG only.
    a = doc("A", [(blink, 1, 2, ()), (emg, 4, 5, ())])
    b = doc("B", [(emg, 4, 5, ())])
    res = analyse([a, b], categories=(emg,))
    tr = res.table("timeresolved_pairwise")
    pa = row(tr, recording="ALL (pooled)", category=ANY_ARTIFACT, channel_mode="time_only", representation="exact")
    assert pa.positive_agreement == 1.0
    ev = res.table("events_summary")
    assert row(ev, category=ANY_ARTIFACT, channel_mode="time_only", threshold=0.2).f1 == 1.0


def test_mean_pairwise_kappa_uses_reference_pairs_everywhere():
    emg = "EMG-artifact"
    docs = [doc("R", [(emg, 1, 3, ())]), doc("A", [(emg, 1, 3, ())]), doc("B", [(emg, 5, 7, ())])]
    mr = analyse(docs, reference_annotator="R").table("timeresolved_multirater")
    sel = mr[(mr.category == emg) & (mr.channel_mode == "time_only") & (mr.representation == "exact")]
    per_rec, pooled = row(sel, recording="rec.vhdr"), row(sel, recording="ALL (pooled)")
    assert per_rec.mean_pairwise_kappa == pytest.approx(pooled.mean_pairwise_kappa)


def test_bin_names_are_exact_and_unique():
    from electroclean.reliability.timeresolved import representation_name, resolution_of

    for r in (0.01, 0.1, 1 / 3, 0.1000001, 2.5):
        assert resolution_of(representation_name(r)) == r
    assert representation_name(0.1) == "bins_0.1s"
    assert representation_name(0.1) != representation_name(0.1000001)
    emg = "EMG-artifact"
    res = analyse([doc("A", [(emg, 1, 2, ())]), doc("B", [(emg, 1, 2, ())])], resolutions_s=(1 / 3,))
    tr = res.table("timeresolved_pairwise")
    r = row(tr, recording="ALL (pooled)", category=emg, channel_mode="time_only",
            representation=representation_name(1 / 3))
    assert r.both + r.only_1 + r.only_2 + r.neither == 30  # 10 s in bins of 1/3 s
    with pytest.raises(ValueError):
        AnalysisConfig(resolutions_s=(0.1, 0.1)).validate()
    with pytest.raises(ValueError):
        AnalysisConfig(primary_iou_threshold=1.5).validate()


def test_overlapping_annotations_counted_once_in_descriptives_and_missing_reference_warned():
    emg = "EMG-artifact"
    res = analyse([doc("A", [(emg, 0, 6, ()), (emg, 4, 10, ())]), doc("B", [])])
    d = res.table("descriptives_annotations_by_annotator")
    assert row(d, annotator="A", category=emg).proportion_of_recording == 1.0
    res = analyse([doc("A", []), doc("B", [])], reference_annotator="Z")
    assert any("reference annotator Z" in w for w in res.settings_record["warnings"])


# ----------------------------------------------------------- hierarchy (v2)
def test_group_rollups_show_agreement_on_the_artifact_family():
    blink, eye = "Eye-blink-artifact", "Eye-artifact"
    res = analyse([doc("A", [(blink, 1, 2, ())]), doc("B", [(eye, 1, 2, ())])])
    tr = res.table("timeresolved_pairwise")

    def pa(cat):
        return row(tr, recording="ALL (pooled)", category=cat, channel_mode="time_only",
                   representation="exact").positive_agreement

    assert pa(blink) == 0.0 and pa("Eye-artifact + subtypes") == 1.0 and pa(ANY_ARTIFACT) == 1.0
    ev = res.table("events_summary")
    f1 = {c: row(ev, category=c, channel_mode="time_only", threshold=0.2).f1
          for c in ("Eye-artifact + subtypes", ANY_ARTIFACT, "ALL categories (micro-average)")}
    assert f1 == {"Eye-artifact + subtypes": 1.0, ANY_ARTIFACT: 1.0, "ALL categories (micro-average)": 0.0}
    # Data-artifact's roll-up would repeat ANY-artifact and is not reported.
    assert "Data-artifact + subtypes" not in set(tr.category)


def test_files_from_compatible_catalogue_versions_are_analysed_together():
    data = json.loads((CONFIG_DIR / "artifact_labels.json").read_text(encoding="utf-8"))
    v1 = LabelCatalogue.from_dict(dict(data, catalogue_version="1.0.0",
                                       labels=[e for e in data["labels"] if e["value"] <= 115]))
    old = doc("A", [("EMG-artifact", 1, 2, ())])
    old = AnnotationDocument(old.recording, "A", old.annotations, v1, session_id="A")
    new = doc("B", [("EMG-artifact", 1, 2, ()), ("Nystagmus-artifact", 4, 5, ())])
    res = analyse([old, new])
    assert res.dataset.catalogue.catalogue_version == "2.0.0"
    assert any("compatible" in w for w in res.dataset.warnings)
    tr = res.table("timeresolved_pairwise")
    assert row(tr, recording="ALL (pooled)", category="EMG-artifact", channel_mode="time_only",
               representation="exact").positive_agreement == 1.0
    clash = LabelCatalogue.from_dict(dict(data, catalogue_version="9.0.0",
                                          labels=[dict(e, value=999) if e["value"] == 102 else e for e in data["labels"]]))
    bad = AnnotationDocument(old.recording, "C", [], clash, session_id="C")
    with pytest.raises(AnnotationError):
        build_dataset([("b", new), ("c", bad)], AnalysisConfig(resolutions_s=(1.0,)))
