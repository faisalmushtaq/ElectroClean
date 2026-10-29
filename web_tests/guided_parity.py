"""Check guided training attempts with the desktop application's rules, for the browser's unit tests.

    python web_tests/guided_parity.py < cases.json

The input is {"checks": [...], "steps": [...], "notes": [...]}. Each check is {"target": Annotation,
"annotations": [Annotation], "sfreq": 250, "taken": [...], "quick_keys": {...}} (Annotation as in
docs/web/api.md), answered by {"matched", "candidate_id", "problems", "messages"}; each step is
{"guidance", "label", "channels", "quick_keys"}, answered by the step's text (step_text); each note is
{"label", "duration_s", "channels"}, answered by the example set's note (example_note). So
web_tests/unit/ui_rules.test.mjs can check that js/training/rules.js and js/eeg/synthetic.js give the
same words. A plain list is read as the checks alone (and answered with a list).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from electrotag.app.annotations.model import ArtifactAnnotation  # noqa: E402
from electrotag.training.guided import Step, Tolerance, check_step, example_note, step_text  # noqa: E402


def annotation(d: dict) -> ArtifactAnnotation:
    return ArtifactAnnotation(annotation_id=d["annotation_id"], label=d["label"], onset_sample=int(d["onset_sample"]),
                              duration_samples=int(d["duration_samples"]), channels=tuple(d.get("channels", [])))


def check(case: dict) -> dict:
    step = Step(0, annotation(case["target"]), "")
    r = check_step(step, [annotation(a) for a in case["annotations"]], float(case["sfreq"]), Tolerance(),
                   taken=set(case.get("taken", [])), quick_keys=case.get("quick_keys"))
    return {"matched": r.matched, "candidate_id": r.candidate_id, "problems": list(r.problems),
            "messages": list(r.messages)}


def main() -> int:
    data = json.load(sys.stdin)
    if isinstance(data, list):
        json.dump([check(c) for c in data], sys.stdout)
        return 0
    json.dump({
        "checks": [check(c) for c in data.get("checks", [])],
        "steps": [step_text(c["guidance"], c.get("label"), c.get("channels", []), c.get("quick_keys")) for c in
                  data.get("steps", [])],
        "notes": [example_note(c["label"], float(c["duration_s"]), tuple(c.get("channels", []))) for c in
                  data.get("notes", [])],
    }, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
