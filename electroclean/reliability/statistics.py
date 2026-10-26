"""Agreement statistics for binary (present/absent) judgements.

All functions accept *weighted* counts, so the same formulas serve
time-weighted analyses (counts in seconds or channel-seconds) and bin-based
analyses (counts of bins). Undefined values are returned as ``nan`` together
with a reason, never as an error.

References (verified; see docs/references.md):
Cohen (1960) for kappa; Fleiss (1971) for multi-rater kappa; Hayes and
Krippendorff (2007) for alpha; Feinstein and Cicchetti (1990) and Cicchetti
and Feinstein (1990) for positive and negative agreement; Byrt, Bishop and
Carlin (1993) for the prevalence and bias indices and PABAK.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import asdict, dataclass

NAN = float("nan")


@dataclass(frozen=True)
class PairTable:
    """2x2 table: a = both present, b = only rater 1, c = only rater 2, d = neither."""

    a: float
    b: float
    c: float
    d: float

    @property
    def n(self) -> float:
        return self.a + self.b + self.c + self.d

    def __add__(self, other: PairTable) -> PairTable:
        return PairTable(self.a + other.a, self.b + other.b, self.c + other.c, self.d + other.d)


@dataclass(frozen=True)
class PairStats:
    n: float
    both: float
    only_1: float
    only_2: float
    neither: float
    prevalence_1: float
    prevalence_2: float
    proportion_agreement: float
    positive_agreement: float
    negative_agreement: float
    cohen_kappa: float
    prevalence_index: float
    bias_index: float
    pabak: float
    note: str

    def as_dict(self) -> dict[str, float | str]:
        return asdict(self)


def _div(num: float, den: float) -> float:
    return num / den if den > 0 else NAN


def pair_statistics(t: PairTable) -> PairStats:
    """Proportion, positive and negative agreement, Cohen's kappa, PI, BI and PABAK."""
    n = t.n
    notes = []
    po = _div(t.a + t.d, n)
    pa = _div(2 * t.a, 2 * t.a + t.b + t.c)
    na = _div(2 * t.d, 2 * t.d + t.b + t.c)
    if 2 * t.a + t.b + t.c == 0:
        notes.append("no positive judgements by either rater: positive agreement undefined")
    p1 = _div(t.a + t.b, n)
    p2 = _div(t.a + t.c, n)
    if n > 0:
        pe = p1 * p2 + (1 - p1) * (1 - p2)
        if pe >= 1 - 1e-15:
            kappa = NAN
            notes.append("chance agreement is 1 (a rater used only one value): kappa undefined")
        else:
            kappa = (po - pe) / (1 - pe)
    else:
        kappa = NAN
        notes.append("no units")
    return PairStats(
        n=n,
        both=t.a,
        only_1=t.b,
        only_2=t.c,
        neither=t.d,
        prevalence_1=p1,
        prevalence_2=p2,
        proportion_agreement=po,
        positive_agreement=pa,
        negative_agreement=na,
        cohen_kappa=kappa,
        prevalence_index=_div(t.a - t.d, n),
        bias_index=_div(t.b - t.c, n),
        pabak=2 * po - 1 if not math.isnan(po) else NAN,
        note="; ".join(notes),
    )


# Multi-rater statistics from a histogram of units: (m raters, k said present) -> weight.
Histogram = Mapping[tuple[int, int], float]


def fleiss_kappa(hist: Histogram) -> tuple[float, str]:
    """Fleiss' kappa for binary ratings.

    Requires every unit to be rated by the same number of raters ``m >= 2``.
    """
    ms = {m for (m, _k), w in hist.items() if w > 0}
    if not ms:
        return NAN, "no units"
    if len(ms) != 1:
        return NAN, f"units have different numbers of raters {sorted(ms)}: Fleiss' kappa needs a constant number"
    m = ms.pop()
    if m < 2:
        return NAN, "fewer than two raters"
    total = sum(w for w in hist.values())
    p1 = sum(k * w for (_m, k), w in hist.items()) / (total * m)
    p0 = 1 - p1
    pbar = sum(((k * (k - 1) + (m - k) * (m - k - 1)) / (m * (m - 1))) * w for (_m, k), w in hist.items()) / total
    pe = p0**2 + p1**2
    if pe >= 1 - 1e-15:
        return NAN, "all ratings in one category: kappa undefined"
    return (pbar - pe) / (1 - pe), ""


def krippendorff_alpha_binary(hist: Histogram) -> tuple[float, str]:
    """Krippendorff's alpha (nominal metric) for binary ratings.

    Units may have different numbers of raters (missing data allowed); units
    with fewer than two ratings are not pairable and are ignored.
    """
    o00 = o11 = o01 = 0.0
    for (m, k), w in hist.items():
        if m < 2 or w <= 0:
            continue
        o11 += w * k * (k - 1) / (m - 1)
        o00 += w * (m - k) * (m - k - 1) / (m - 1)
        o01 += w * k * (m - k) / (m - 1)
    n0 = o00 + o01
    n1 = o11 + o01
    n = n0 + n1
    if n <= 1:
        return NAN, "fewer than two pairable values"
    if n0 == 0 or n1 == 0:
        return NAN, "all ratings in one category: alpha undefined"
    d_o = 2 * o01
    alpha = 1 - (n - 1) * d_o / (2 * n0 * n1)
    return alpha, ""


def histogram_from_counts(m: int, positives: list[int] | tuple[int, ...], weights: list[float] | None = None) -> dict[tuple[int, int], float]:
    hist: dict[tuple[int, int], float] = {}
    for i, k in enumerate(positives):
        w = 1.0 if weights is None else weights[i]
        hist[(m, int(k))] = hist.get((m, int(k)), 0.0) + w
    return hist
