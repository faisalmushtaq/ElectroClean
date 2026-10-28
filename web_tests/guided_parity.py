"""Check guided training attempts with the desktop application's rules, for the browser's unit tests.

    python web_tests/guided_parity.py < cases.json

Each case is {"target": Annotation, "annotations": [Annotation], "sfreq": 250, "taken": [...],
"quick_keys": {...}} (Annotation as in docs/web/api.md); the answer is one
{"matched", "candidate_id", "problems", "messages"} per case, so web_tests/unit/ui_rules.test.mjs can
check that js/training/rules.js gives the same feedback word for word.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from electroclean.app.annotations.model import ArtifactAnnotation  # noqa: E402
from electroclean.training.guided import Step, Tolerance, check_step  # noqa: E402


def annotation(d: dict) -> ArtifactAnnotation:
    return ArtifactAnnotation(annotation_id=d["annotation_id"], label=d["label"], onset_sample=int(d["onset_sample"]),
                              duration_samples=int(d["duration_samples"]), channels=tuple(d.get("channels", [])))


def main() -> int:
    out = []
    for case in json.load(sys.stdin):
        step = Step(0, annotation(case["target"]), "")
        r = check_step(step, [annotation(a) for a in case["annotations"]], float(case["sfreq"]), Tolerance(),
                       taken=set(case.get("taken", [])), quick_keys=case.get("quick_keys"))
        out.append({"matched": r.matched, "candidate_id": r.candidate_id, "problems": list(r.problems), "messages": list(r.messages)})
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
