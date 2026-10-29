"""Stage 2 of the training programme: the disagreements of a practice recording with the experts.

Used by the browser version's server and Firebase functions (electrotag/web/coach.py), which
return these flags to the browser's review (electrotag/web/static/js/training/review.js).
"""

from __future__ import annotations

from typing import Any

FLAG_MISSED, FLAG_EXTRA, FLAG_TYPE = "MISSED", "EXTRA", "TYPE"


def review_flags(fb: dict[str, Any], mine: list[Any], reference: list[Any], sfreq: float) -> list[dict[str, Any]]:
    """The disagreements of a practice recording, each tied to an annotation in the review window.

    Region IDs name the trainee's annotations ``you-<annotation_id>`` and the reference's
    ``ref-<annotation_id>``, as the review shows them side by side."""
    def near(a: Any, onset_s: float, offset_s: float) -> bool:
        tol = 1.5 / sfreq
        return abs(a.onset_sample / sfreq - onset_s) <= tol and abs(a.end_sample / sfreq - offset_s) <= tol

    flags: list[dict[str, Any]] = []
    for m in fb.get("missed", []):
        hit = next((a for a in reference if a.label == m["label"] and near(a, m["onset_s"], m["offset_s"])), None)
        if hit is not None:
            flags.append({"kind": FLAG_MISSED, "region": f"ref-{hit.annotation_id}", "label": hit.label,
                          "onset_s": m["onset_s"], "offset_s": m["offset_s"]})
    for e in fb.get("extra", []):
        hit = next((a for a in mine if a.label == e["label"] and near(a, e["onset_s"], e["offset_s"])), None)
        if hit is not None:
            flags.append({"kind": FLAG_EXTRA, "region": f"you-{hit.annotation_id}", "label": hit.label,
                          "onset_s": e["onset_s"], "offset_s": e["offset_s"]})
    for d in fb.get("label_differences", []):
        t0, t1 = d["onset_s"], d["offset_s"]
        cands = [a for a in mine if a.label == d["your_label"]
                 and a.onset_sample / sfreq < t1 and t0 < a.end_sample / sfreq]
        if cands:
            hit = cands[0]
            flags.append({"kind": FLAG_TYPE, "region": f"you-{hit.annotation_id}", "label": hit.label,
                          "should_be": d["reference_label"], "onset_s": hit.onset_sample / sfreq,
                          "offset_s": hit.end_sample / sfreq})
    flags.sort(key=lambda f: f["onset_s"])
    return flags


def flag_text(f: dict[str, Any]) -> str:
    span = f"{f['onset_s']:.2f}–{f['offset_s']:.2f} s"
    if f["kind"] == FLAG_MISSED:
        return f"Missed: {f['label']}, {span}"
    if f["kind"] == FLAG_EXTRA:
        return f"Extra: your {f['label']}, {span} (not in the experts' annotations)"
    return f"Type: you chose {f['label']}; the experts chose {f['should_be']}, {span}"


def flag_prefix(f: dict[str, Any]) -> str:
    if f["kind"] == FLAG_MISSED:
        return "MISSED · REF: "
    if f["kind"] == FLAG_EXTRA:
        return "EXTRA · YOU: "
    should = f["should_be"].replace("-artifact", "")
    return f"TYPE: should be {should} · YOU: "
