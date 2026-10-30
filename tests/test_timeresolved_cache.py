"""The time-resolved analysis computes each distinct set of intervals once (high-density recordings).

The optimised :func:`recording_tables` must give exactly the results of the
channel-by-channel computation it replaced, which is kept here as the
reference.
"""

from __future__ import annotations

from itertools import combinations

import numpy as np
import pytest

import electrotag.reliability.timeresolved as tr
from electrotag.app.annotations.labels import default_catalogue
from electrotag.app.annotations.model import AnnotationDocument, ArtifactAnnotation, RecordingInfo
from electrotag.app.annotations.timing import RecordingTiming
from electrotag.reliability.config import AnalysisConfig
from electrotag.reliability.data import build_dataset
from electrotag.reliability.intervals import binarise, coverage_per_bin, intersection_length, total_length
from electrotag.reliability.statistics import PairTable

CAT = default_catalogue()
SF = 256.0
N = int(SF * 60)
CHANNELS = tuple(f"E{i}" for i in range(1, 65))
LABELS = ("Eye-blink-artifact", "EMG-artifact", "Electrode-pops-artifact", "Eye-movement-artifact",
          "Horizontal-eye-movement-artifact", "Line-noise-artifact")


def reference_recording_tables(group, category, mode, representation, config, labels=None):
    """The original channel-by-channel computation."""
    raters = group.annotators
    m = len(raters)
    timing = group.timing
    pair_tables: dict = {}
    hist: dict = {}
    pairs = list(combinations(raters, 2))
    units = [None] if mode == "time_only" else list(group.ch_names)
    for unit in units:
        ints = {r: tr.category_intervals(group.docs[r], category, unit, config.categories, labels) for r in raters}
        if representation == "exact":
            n = timing.n_samples
            scale = 1.0 / timing.sfreq
            lengths = {r: total_length(v) for r, v in ints.items()}
            for a, b in pairs:
                both = intersection_length(ints[a], ints[b])
                t = PairTable(both * scale, (lengths[a] - both) * scale, (lengths[b] - both) * scale,
                              (n - lengths[a] - lengths[b] + both) * scale)
                pair_tables[(a, b)] = pair_tables.get((a, b), PairTable(0, 0, 0, 0)) + t
            for k, samples in tr.coverage_count_histogram(list(ints.values()), n).items():
                hist[(m, k)] = hist.get((m, k), 0.0) + float(samples)
        else:
            res = tr.resolution_of(representation)
            vec = {r: binarise(coverage_per_bin(v, timing.sfreq, res, timing.duration_s), config.min_bin_coverage)
                   for r, v in ints.items()}
            for a, b in pairs:
                va, vb = vec[a], vec[b]
                t = PairTable(float(np.sum(va & vb)), float(np.sum(va & ~vb)), float(np.sum(~va & vb)),
                              float(np.sum(~va & ~vb)))
                pair_tables[(a, b)] = pair_tables.get((a, b), PairTable(0, 0, 0, 0)) + t
            if raters:
                counts = np.sum(np.vstack([vec[r] for r in raters]), axis=0)
                for k, w in enumerate(np.bincount(counts, minlength=m + 1)):
                    if w:
                        hist[(m, k)] = hist.get((m, k), 0.0) + float(w)
    return pair_tables, hist, 1.0


def _random_doc(annotator: str, rng: np.random.Generator, rid: str, n_annotations: int) -> AnnotationDocument:
    """A mixture of whole-montage and channel-specific annotations, some overlapping, at odd sample times."""
    items = []
    for i in range(n_annotations):
        label = LABELS[int(rng.integers(len(LABELS)))]
        onset = int(rng.integers(0, N - 10))
        duration = int(rng.integers(1, min(N - onset, int(SF * 4))))
        kind = rng.random()
        if kind < 0.3:
            channels: tuple[str, ...] = ()
        else:
            size = int(rng.choice([1, 2, 5, 17, 40]))
            channels = tuple(sorted(rng.choice(CHANNELS, size=size, replace=False), key=CHANNELS.index))
        items.append(ArtifactAnnotation(f"{annotator}-{i}", label, onset, duration, channels))
    rec = RecordingInfo(rid, RecordingTiming(SF, N), CHANNELS)
    return AnnotationDocument(rec, annotator, items, CAT, mode="standard", created_at="2026-01-01", session_id=annotator)


def _dataset(seed: int, config: AnalysisConfig):
    rng = np.random.default_rng(seed)
    docs = []
    for rid in ("sub-01_eeg.vhdr", "sub-02_eeg.vhdr"):
        for annotator, n in (("A01", 25), ("A02", 18), ("A03", 0)):  # A03 marked nothing
            docs.append((annotator, _random_doc(annotator, rng, rid, n)))
    return build_dataset(docs, config)


@pytest.mark.parametrize("min_cov", [0.0, 0.5])
@pytest.mark.parametrize("seed", [1, 2])
def test_cached_tables_equal_the_channel_by_channel_computation(seed, min_cov):
    config = AnalysisConfig(resolutions_s=(0.05, 0.25, 1.0), min_bin_coverage=min_cov)
    config.validate()
    ds = _dataset(seed, config)
    for group in ds.groups.values():
        for mode in config.channel_modes:
            for rep in tr.representations(config):
                for cat in tr.categories_for(ds, config):
                    labels = tr.category_label_set(cat, ds.catalogue, config)
                    got = tr.recording_tables(group, cat, mode, rep, config, labels)
                    want = reference_recording_tables(group, cat, mode, rep, config, labels)
                    assert got[0] == want[0], (cat, mode, rep)
                    # Same values and the same order of keys: later sums run over the dicts in order.
                    assert list(got[1].items()) == list(want[1].items()), (cat, mode, rep)


def test_whole_analysis_is_identical_to_the_channel_by_channel_computation(monkeypatch):
    config = AnalysisConfig(resolutions_s=(0.1, 1.0))
    config.validate()
    ds = _dataset(7, config)
    fast = tr.time_resolved_agreement(ds, config)
    monkeypatch.setattr(tr, "recording_tables", reference_recording_tables)
    slow = tr.time_resolved_agreement(ds, config)
    assert repr(fast) == repr(slow)  # repr compares NaN entries too, digit for digit


def test_bins_are_computed_once_per_distinct_set_of_intervals(monkeypatch):
    config = AnalysisConfig(resolutions_s=(0.1,))
    config.validate()
    ds = _dataset(3, config)
    group = ds.groups[sorted(ds.groups)[0]]
    calls = []
    real = tr.positive_bins
    monkeypatch.setattr(tr, "positive_bins", lambda *a: calls.append(1) or real(*a))
    tr.recording_tables(group, "EMG-artifact", "time_and_channel", "bins_0.1s", config,
                        tr.category_label_set("EMG-artifact", ds.catalogue, config))
    channel_by_channel = len(CHANNELS) * len(group.annotators)
    assert 0 < len(calls) < channel_by_channel / 4


def _dense_coverage(intervals, sfreq, bin_s, duration_s):
    """coverage_per_bin as it was first written, over every bin (the reference for the sparse one)."""
    n_bins = int(np.ceil(duration_s / bin_s - 1e-9))
    edges = np.minimum(np.arange(n_bins + 1) * bin_s, duration_s)
    widths = np.diff(edges)
    if not intervals:
        return np.zeros(n_bins)
    xs, ys, covered = [0.0], [0.0], 0.0
    for a, b in intervals:
        ta, tb = a / sfreq, b / sfreq
        xs.extend([ta, tb])
        ys.extend([covered, covered + (tb - ta)])
        covered += tb - ta
    xs.append(max(duration_s, xs[-1]))
    ys.append(covered)
    cum = np.interp(edges, np.asarray(xs), np.asarray(ys))
    with np.errstate(invalid="ignore", divide="ignore"):
        frac = np.where(widths > 0, np.diff(cum) / widths, 0.0)
    return np.clip(frac, 0.0, 1.0)


def test_coverage_of_the_bins_near_the_marks_is_that_of_every_bin_to_the_last_bit():
    from electrotag.reliability.intervals import positive_bins, union

    rng = np.random.default_rng(256)
    for _ in range(1500):
        sfreq = float(rng.choice([100, 128, 160, 250, 256, 500, 512, 1000, 1024, 2048, 16384]))
        n = int(rng.integers(1, int(sfreq * rng.choice([1, 10, 600, 3600]))))
        marks = []
        for _k in range(int(rng.integers(0, 40))):
            a = int(rng.integers(0, n))
            marks.append((a, min(n, a + int(rng.integers(1, max(2, n // int(rng.choice([2, 10, 1000]))))))))
        marks = list(union(marks))
        res = float(rng.choice([0.007, 0.01, 0.05, 0.1, 0.25, 0.3, 1.0]))
        want = _dense_coverage(marks, sfreq, res, n / sfreq)
        got = coverage_per_bin(marks, sfreq, res, n / sfreq)
        assert got.shape == want.shape and np.array_equal(got, want)
        for min_coverage in (0.0, 1e-13, 0.5, 1.0):
            n_bins, pos = positive_bins(marks, sfreq, res, n / sfreq, min_coverage)
            assert n_bins == len(want)
            assert np.array_equal(pos, np.flatnonzero(binarise(want, min_coverage)))
