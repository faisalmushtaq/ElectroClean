"""Interval arithmetic on half-open sample intervals ``[start, stop)``."""

from __future__ import annotations

from collections.abc import Iterable

import numpy as np

Interval = tuple[int, int]


def union(intervals: Iterable[Interval]) -> list[Interval]:
    """Merge overlapping or touching intervals; returns sorted disjoint intervals."""
    items = sorted((int(a), int(b)) for a, b in intervals if b > a)
    out: list[Interval] = []
    for a, b in items:
        if out and a <= out[-1][1]:
            if b > out[-1][1]:
                out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return out


def total_length(intervals: Iterable[Interval]) -> int:
    return sum(b - a for a, b in intervals)


def intersection_length(x: list[Interval], y: list[Interval]) -> int:
    """Length of the intersection of two *disjoint, sorted* interval lists."""
    i = j = 0
    total = 0
    while i < len(x) and j < len(y):
        a = max(x[i][0], y[j][0])
        b = min(x[i][1], y[j][1])
        if b > a:
            total += b - a
        if x[i][1] < y[j][1]:
            i += 1
        else:
            j += 1
    return total


def iou(a: Interval, b: Interval) -> float:
    inter = max(0, min(a[1], b[1]) - max(a[0], b[0]))
    uni = (a[1] - a[0]) + (b[1] - b[0]) - inter
    return inter / uni if uni > 0 else 0.0


def _near_coverage(intervals: list[Interval], sfreq: float, bin_s: float,
                   duration_s: float) -> tuple[int, np.ndarray, np.ndarray]:
    """The number of bins, and the covered fraction of the bins near ``intervals``: (n_bins, bins, fractions).

    Only the bins an interval reaches can be covered: elsewhere the cumulative covered time is flat, so its
    difference is exactly zero. A channel of a 256-channel recording has a few short marks in an hour of
    10 ms bins, so evaluating the bins near the marks, with the same arithmetic as for every bin (the
    result is the same to the last bit), saves almost all of the work.
    """
    n_bins = int(np.ceil(duration_s / bin_s - 1e-9))
    if not intervals:
        return n_bins, np.zeros(0, dtype=np.int64), np.zeros(0)
    arr = np.asarray(intervals, dtype=float)
    ta, tb = arr[:, 0] / sfreq, arr[:, 1] / sfreq
    ends = np.cumsum(tb - ta)  # the covered time at each interval's end, summed in order
    starts = np.concatenate([[0.0], ends[:-1]])
    xa = np.concatenate([[0.0], np.column_stack([ta, tb]).ravel(), [max(duration_s, float(tb[-1]))]])
    ya = np.concatenate([[0.0], np.column_stack([starts, ends]).ravel(), [float(ends[-1])]])
    stop = np.minimum(n_bins, (tb // bin_s).astype(np.int64) + 2)
    # the intervals are sorted and disjoint, so each range of bins starts after the one before ends
    first = np.maximum(np.maximum(0, (ta // bin_s).astype(np.int64) - 1),
                       np.concatenate([[0], np.maximum.accumulate(stop)[:-1]]))
    lengths = np.maximum(0, stop - first)
    if 2 * int(lengths.sum()) > n_bins:
        bins = np.arange(n_bins)
    else:  # the bins from first to stop of each interval, in one increasing array
        offsets = np.repeat(first - np.concatenate([[0], np.cumsum(lengths)[:-1]]), lengths)
        bins = np.arange(int(lengths.sum())) + offsets
    lo = np.minimum(bins * bin_s, duration_s)
    hi = np.minimum((bins + 1) * bin_s, duration_s)
    widths = hi - lo
    with np.errstate(invalid="ignore", divide="ignore"):
        part = np.where(widths > 0, (np.interp(hi, xa, ya) - np.interp(lo, xa, ya)) / widths, 0.0)
    return n_bins, bins, np.clip(part, 0.0, 1.0)


def coverage_per_bin(intervals: list[Interval], sfreq: float, bin_s: float, duration_s: float) -> np.ndarray:
    """Fraction of each time bin covered by ``intervals`` (disjoint, sorted, samples).

    Bins are ``[k * bin_s, (k + 1) * bin_s)`` from the first sample; the last
    bin may be shorter than ``bin_s`` and its fraction is relative to its own
    length. Coverage is computed exactly from the cumulative covered time,
    which is piecewise linear in time.
    """
    n_bins, bins, part = _near_coverage(intervals, sfreq, bin_s, duration_s)
    frac = np.zeros(n_bins)
    frac[bins] = part
    return frac


def positive_bins(intervals: list[Interval], sfreq: float, bin_s: float, duration_s: float,
                  min_coverage: float) -> tuple[int, np.ndarray]:
    """The number of bins and the sorted indices of those :func:`binarise` marks positive, without a
    vector of every bin (an hour in 10 ms bins is 360,000 of them, for each channel)."""
    if 0 < min_coverage <= 1e-12:  # an empty bin would count as positive: take every bin
        cov = coverage_per_bin(intervals, sfreq, bin_s, duration_s)
        return len(cov), np.flatnonzero(binarise(cov, min_coverage))
    n_bins, bins, part = _near_coverage(intervals, sfreq, bin_s, duration_s)
    return n_bins, bins[binarise(part, min_coverage)]


def binarise(coverage: np.ndarray, min_coverage: float) -> np.ndarray:
    """A bin is positive if its covered fraction reaches ``min_coverage``.

    ``min_coverage == 0`` means "any overlap" (strictly positive coverage).
    """
    if min_coverage <= 0:
        return coverage > 1e-12
    return coverage >= min_coverage - 1e-12
