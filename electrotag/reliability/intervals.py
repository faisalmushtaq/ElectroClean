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


def coverage_per_bin(intervals: list[Interval], sfreq: float, bin_s: float, duration_s: float) -> np.ndarray:
    """Fraction of each time bin covered by ``intervals`` (disjoint, sorted, samples).

    Bins are ``[k * bin_s, (k + 1) * bin_s)`` from the first sample; the last
    bin may be shorter than ``bin_s`` and its fraction is relative to its own
    length. Coverage is computed exactly from the cumulative covered time,
    which is piecewise linear in time.
    """
    n_bins = int(np.ceil(duration_s / bin_s - 1e-9))
    edges = np.minimum(np.arange(n_bins + 1) * bin_s, duration_s)
    widths = np.diff(edges)
    if not intervals:
        return np.zeros(n_bins)
    xs = [0.0]
    ys = [0.0]
    covered = 0.0
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


def binarise(coverage: np.ndarray, min_coverage: float) -> np.ndarray:
    """A bin is positive if its covered fraction reaches ``min_coverage``.

    ``min_coverage == 0`` means "any overlap" (strictly positive coverage).
    """
    if min_coverage <= 0:
        return coverage > 1e-12
    return coverage >= min_coverage - 1e-12
