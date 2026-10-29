"""Score practice recordings with the desktop application's code, for the browser's unit tests.

    python web_tests/practice_parity.py < cases.json

Each case is {"sfreq", "n_samples", "ch_names", "reference": [Annotation], "mine": [Annotation]};
the answer gives, per case, the event F1, the label accuracy, the pass decision (the pass rule of
the case's "rule", or the default), the missed, extra and relabelled artifacts, the counts the score
is made of, and the words the trainee reads (the pass mark, the score's sentence, the review's
verdict for "n_practice" practice recordings and the training path's line), so
web_tests/unit/ui_scoring.test.mjs can check js/training/scoring.js against
electrotag.training.assessment.practice_feedback and electrotag.training.programme.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from electrotag.app.annotations.labels import default_catalogue  # noqa: E402
from electrotag.app.annotations.model import AnnotationDocument, ArtifactAnnotation, RecordingInfo  # noqa: E402
from electrotag.app.annotations.timing import RecordingTiming  # noqa: E402
from electrotag.training.assessment import practice_feedback  # noqa: E402
from electrotag.training.programme import (  # noqa: E402
    PassRule,
    practice_detail,
    practice_verdict,
    score_sentence,
)
from electrotag.training.reference import REFERENCE_ANNOTATOR  # noqa: E402


def doc(case: dict, key: str, annotator: str, mode: str) -> AnnotationDocument:
    rec = RecordingInfo(recording_id="sub-01/eeg/sub-01_task-x_eeg.edf",
                        timing=RecordingTiming(sfreq=float(case["sfreq"]), n_samples=int(case["n_samples"])),
                        ch_names=tuple(case["ch_names"]))
    anns = [ArtifactAnnotation(annotation_id=a["annotation_id"], label=a["label"], onset_sample=int(a["onset_sample"]),
                               duration_samples=int(a["duration_samples"]), channels=tuple(a.get("channels", [])))
            for a in case[key]]
    return AnnotationDocument(recording=rec, annotator_id=annotator, annotations=anns, catalogue=default_catalogue(), mode=mode)


def num(v: float) -> float | None:
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), 6)


def main() -> int:
    out = []
    for case in json.load(sys.stdin):
        fb = practice_feedback(doc(case, "mine", "T01", "practice"), doc(case, "reference", REFERENCE_ANNOTATOR, "reference"))
        rule = PassRule.from_dict(case.get("rule"))
        verdict = rule.evaluate(fb)
        counts = {k: verdict[k] for k in ("reference_events", "your_events", "found", "extra", "other_type")}
        out.append({
            "event_f1": num(fb["overall"]["event_f1"]),
            "label_accuracy": num(fb["overall"]["label_accuracy"]),
            "passed": verdict["passed"],
            "missed": sorted([m["label"], round(m["onset_s"], 3)] for m in fb["missed"]),
            "extra": sorted([e["label"], round(e["onset_s"], 3)] for e in fb["extra"]),
            "type": sorted([d["reference_label"], d["your_label"], round(d["onset_s"], 3)] for d in fb["label_differences"]),
            "counts": counts,
            "words": {
                "rule": rule.describe(),
                "sentence": score_sentence(counts),
                "verdict": practice_verdict(verdict["passed"], rule, int(case.get("n_practice", 1)),
                                            case.get("unlocked", "")),
                "detail": practice_detail(verdict, rule, verdict["passed"]),
            },
        })
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
