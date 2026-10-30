"""Correct the marks with the study's own code, for the browser's unit tests.

    python web_tests/planted_parity.py < cases.json

Each case is {"op": "plant" | "score", "sfreq", "n_samples", "ch_names", "reference": [Annotation],
"tolerance"?}, with "seed" and "counts"? to plant, or "errors", "mine" and "planted"? to score. The
answer gives, per case, electrotag.training.planted's planted copy ({"annotations", "errors",
"made", "capped"}) or its score_corrections, so that web_tests/unit/ui_planted.test.mjs can check
js/training/planted_scoring.js and the sandbox's ready-made exercise (js/api/demo_planted.js).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from electrotag.app.annotations.labels import default_catalogue  # noqa: E402
from electrotag.app.annotations.model import AnnotationDocument, RecordingInfo  # noqa: E402
from electrotag.app.annotations.timing import RecordingTiming  # noqa: E402
from electrotag.training.guided import Tolerance  # noqa: E402
from electrotag.training.planted import from_wire, plant_errors, score_corrections, wire  # noqa: E402


def main() -> int:
    out = []
    for case in json.load(sys.stdin):
        ref = [from_wire(a) for a in case["reference"]]
        tol = Tolerance.from_dict(case.get("tolerance"))
        if case["op"] == "plant":
            doc = AnnotationDocument(RecordingInfo("rec.edf", RecordingTiming(float(case["sfreq"]),
                                                                              int(case["n_samples"])),
                                                   tuple(case["ch_names"])), "REFERENCE", ref, default_catalogue())
            p = plant_errors(doc, seed=int(case["seed"]), counts=case.get("counts"), tolerance=tol)
            out.append({"annotations": [wire(a) for a in p.annotations], "errors": p.errors, "made": p.made,
                        "capped": p.capped})
        else:
            out.append(score_corrections(case["errors"], [from_wire(a) for a in case["mine"]], ref,
                                         float(case["sfreq"]), tol,
                                         planted=[from_wire(a) for a in case.get("planted") or []]))
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
