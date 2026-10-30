"""Bad channels and uncertain marks in the agreement analysis.

Each annotator may mark channels bad for the whole recording. Their agreement is reported in tables of its
own, apart from the agreement on artifacts: ``bad_channels_by_channel`` lists every channel someone marked
bad, with how many of the annotators of the recording did, and ``bad_channels_pairwise`` compares each pair
of annotators of a recording over its channels (each channel one unit, bad or not), with the statistics of the
time-resolved tables (Cohen's kappa and the rest, :func:`electrotag.reliability.statistics.pair_statistics`).
The artifact tables are left as they are: a mark on a channel the annotator also called bad is still a mark,
and leaving such channels out would change what the other annotators are compared with.

Marks of the uncertain type (``Data-artifact``, shown to annotators as "Uncertain / needs review") are counted
apart in ``uncertain_by_annotator``: how many each annotator made, their time and their share of that
annotator's marks. They also keep their own category in the artifact tables, as every type does.
"""

from __future__ import annotations

from itertools import combinations
from typing import Any

from electrotag.app.annotations.labels import UNCERTAIN_LABEL
from electrotag.reliability.config import AnalysisConfig
from electrotag.reliability.data import AgreementDataset
from electrotag.reliability.intervals import total_length, union
from electrotag.reliability.statistics import PairTable, pair_statistics

BY_CHANNEL_COLUMNS = ["recording", "channel", "n_annotators", "n_marked_bad", "proportion_marked_bad", "marked_by"]
PAIRWISE_COLUMNS = ["recording", "rater_1", "rater_2", "n_channels", "both", "only_1", "only_2", "neither",
                    "proportion_agreement", "positive_agreement", "cohen_kappa", "note"]
UNCERTAIN_COLUMNS = ["recording", "annotator", "n_annotations", "n_uncertain", "share_uncertain",
                     "uncertain_duration_s", "proportion_of_recording"]


def bad_channel_measure(ds: AgreementDataset, cfg: AnalysisConfig) -> dict[str, list[dict[str, Any]]]:
    by_channel, pairwise = [], []
    for rid, g in sorted(ds.groups.items()):
        marked = {aid: set(doc.bad_channels) for aid, doc in g.docs.items()}
        people = sorted(marked)
        for ch in g.ch_names:
            who = [a for a in people if ch in marked[a]]
            if who:
                by_channel.append({"recording": rid, "channel": ch, "n_annotators": len(people),
                                   "n_marked_bad": len(who), "proportion_marked_bad": len(who) / len(people),
                                   "marked_by": ", ".join(who)})
        for r1, r2 in combinations(people, 2):
            b1, b2 = marked[r1], marked[r2]
            a = sum(1 for c in g.ch_names if c in b1 and c in b2)
            only1 = sum(1 for c in g.ch_names if c in b1 and c not in b2)
            only2 = sum(1 for c in g.ch_names if c in b2 and c not in b1)
            st = pair_statistics(PairTable(a, only1, only2, len(g.ch_names) - a - only1 - only2))
            pairwise.append({"recording": rid, "rater_1": r1, "rater_2": r2, "n_channels": len(g.ch_names),
                             "both": a, "only_1": only1, "only_2": only2, "neither": st.neither,
                             "proportion_agreement": st.proportion_agreement,
                             "positive_agreement": st.positive_agreement, "cohen_kappa": st.cohen_kappa,
                             "note": st.note})
    return {"by_channel": by_channel, "pairwise": pairwise}


def uncertain_measure(ds: AgreementDataset, cfg: AnalysisConfig) -> dict[str, list[dict[str, Any]]]:
    rows = []
    for rid, g in sorted(ds.groups.items()):
        for aid, doc in sorted(g.docs.items()):
            mine = [a for a in doc.annotations if a.label == UNCERTAIN_LABEL]
            rows.append({"recording": rid, "annotator": aid, "n_annotations": len(doc.annotations),
                         "n_uncertain": len(mine),
                         "share_uncertain": len(mine) / len(doc.annotations) if doc.annotations else float("nan"),
                         "uncertain_duration_s": sum(a.duration(g.timing) for a in mine),
                         "proportion_of_recording": total_length(union((a.onset_sample, a.end_sample) for a in mine))
                         / g.timing.n_samples})
    return {"by_annotator": rows}
