"""Run sequences of edits through the study's own annotation store, for the browser's unit tests.

    python web_tests/store_parity.py < cases.json

Each case is {"sfreq", "n_samples", "ch_names", "auto_merge", "ops": [...]}, each op one of
{"op": "add", "id", "label", "onset", "duration", "channels"}, {"op": "move", "id", "onset", "duration"},
{"op": "bad", "channel", "bad"}, {"op": "merge", "ids"}, {"op": "delete", "id"}, {"op": "undo"} and
{"op": "redo"}. The answer gives, for each case and after each op, the annotations (identifiers made by the
store itself, as by an explicit merge, read "*"), the channels marked bad and how many marks the op joined,
so that web_tests/unit/ui_store_parity.test.mjs can check that js/annotate/store.js does exactly the same as
electrotag/app/annotations/store.py.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from electrotag.app.annotations.labels import default_catalogue  # noqa: E402
from electrotag.app.annotations.model import AnnotationError, RecordingInfo  # noqa: E402
from electrotag.app.annotations.store import AnnotationStore  # noqa: E402
from electrotag.app.annotations.timing import RecordingTiming  # noqa: E402


def state(store: AnnotationStore, given: set[str], merged: int, error: str | None) -> dict:
    return {"annotations": [[a.annotation_id if a.annotation_id in given else "*", a.label, a.onset_sample,
                             a.duration_samples, list(a.channels)] for a in store.annotations()],
            "bad": list(store.bad_channels), "merged": merged, "error": error}


def main() -> int:
    out = []
    cat = default_catalogue()
    for case in json.load(sys.stdin):
        rec = RecordingInfo("rec.edf", RecordingTiming(float(case["sfreq"]), int(case["n_samples"])),
                            tuple(case["ch_names"]))
        s = AnnotationStore(rec, cat, auto_merge=bool(case["auto_merge"]))
        given: set[str] = set()
        steps = []
        for op in case["ops"]:
            error = None
            s.last_auto_merged = 0
            try:
                kind = op["op"]
                if kind == "add":
                    given.add(op["id"])
                    s.add(op["label"], op["onset"], op["duration"], op.get("channels", []), annotation_id=op["id"])
                elif kind == "move":
                    if op["id"] in s:
                        s.update(op["id"], onset_sample=op["onset"], duration_samples=op["duration"],
                                 description="move/resize")
                elif kind == "bad":
                    s.set_channel_bad(op["channel"], op["bad"])
                elif kind == "merge":
                    s.merge([i for i in op["ids"] if i in s])
                elif kind == "delete":
                    if op["id"] in s:
                        s.delete(op["id"])
                elif kind == "undo":
                    s.undo()
                elif kind == "redo":
                    s.redo()
            except AnnotationError as exc:
                error = type(exc).__name__
            steps.append(state(s, given, s.last_auto_merged, error))
        out.append(steps)
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
