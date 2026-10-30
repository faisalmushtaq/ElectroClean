"""The study server, in-process, for the contract parity test (web_tests/unit/api_contract_parity.test.mjs).

    python web_tests/contract_parity.py <folder>

The folder holds the sandbox's own recordings (``recordings/<recording ID>``, the EDF files that
js/eeg/synthetic.js writes and a visitor downloads) and ``sandbox.json``, which describes the
sandbox as js/api/demo.js has it: its accounts, assignments, training set (the simulation's
artifacts as the experts' annotations, how much help each guided recording gives, the pass mark),
quiz and study name. From these this makes a fresh study as ``electrotag-web demo`` does
(electrotag/web/demo.py: WebStudy.init, a files store in demonstration mode, register_dataset, the
accounts), so that the real service and the sandbox's stand-in hold the same recordings, people
and answers. It then prints ``ready`` and answers HTTP requests read from stdin, one JSON object a
line ({"method", "path", "headers", "body"}), with one JSON line each ({"status", "body"}), sent to
the FastAPI application (electrotag/web/app.py) through its TestClient, as tests/test_web_server.py
does. The node test sends the same calls through js/api/http.js to this server and through
js/api/demo.js to the stand-in, and compares the answers.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def build_study(folder: Path) -> Path:
    import mne

    from electrotag import __version__
    from electrotag.app.annotations.labels import default_catalogue
    from electrotag.app.annotations.model import AnnotationDocument, ArtifactAnnotation
    from electrotag.training.reference import QuizItem, ReferenceSet, reference_sets_dir
    from electrotag.web.manifest import manifest_info
    from electrotag.web.registration import register_dataset
    from electrotag.web.store_files import FilesStore
    from electrotag.web.study import WebStudy

    mne.set_log_level("error")
    spec = json.loads((folder / "sandbox.json").read_text(encoding="utf-8"))
    recordings = folder / "recordings"
    study_dir = folder / "study"
    training_source = folder / "training-source"
    for p in (study_dir, training_source):
        shutil.rmtree(p, ignore_errors=True)
    cat = default_catalogue()
    labels = tuple(lbl.label for lbl in cat.labels)
    quiet = lambda *a, **k: None  # noqa: E731
    WebStudy.init(study_dir, study_id=spec["study_id"], name=spec["study_name"],
                  settings={"selection": {"strategy": "manual"}})
    store = FilesStore(study_dir, demo=True)
    try:
        reg = register_dataset(recordings, store, say=quiet)
        by_id = {m["recording_id"]: m for m in reg.manifests}
        ts = spec["training_set"]
        rs = ReferenceSet.create(reference_sets_dir(training_source, None), ts["set_id"], name=ts["name"],
                                 description=ts["description"], created_by="demonstration",
                                 method="single_expert", experts=["EXAMPLE"])
        rs.recordings_dir = "recordings"
        notes: dict[str, str] = {}
        for r in ts["recordings"]:
            rid = r["recording_id"]
            rs.add_recording_files(recordings / rid, recording_id=rid)
            info = manifest_info(by_id[rid])
            anns = [ArtifactAnnotation(annotation_id=a["annotation_id"], label=a["label"],
                                       onset_sample=int(a["onset_sample"]), duration_samples=int(a["duration_samples"]),
                                       channels=tuple(a["channels"]), created_at=a["created_at"],
                                       modified_at=a["modified_at"]) for a in r["truth"]]
            doc = AnnotationDocument(recording=info, annotator_id="EXAMPLE", annotator_display_name="Simulation",
                                     annotations=anns, catalogue=cat, session_id="simulation", mode="standard",
                                     created_at=anns[0].created_at, app_version=__version__, context={})
            # as electrotag/training/examples.py describes the simulation's artifacts standing in for the experts'
            rs.add_reference(doc, use=r["use"], method="single_expert", experts=["EXAMPLE"],
                             details={"placeholder": True,
                                      "source": "simulated recording; ground truth used as reference"})
            if r["use"] == "guided":
                rs.set_guidance(rid, r["guidance"])
            notes.update(r.get("notes") or {})
        rs.guided = {**rs.guided, "notes": notes}
        # the sandbox's ready-made correct-the-marks exercise (js/api/demo_planted.js), kept as the study keeps one
        planted = {}
        for rid, p in (ts.get("planted") or {}).items():
            from electrotag.training.planted import reference_sha256

            planted[rid] = {"annotations": p["annotations"], "errors": p["errors"], "seed": p["seed"],
                            "counts": p["counts"], "requested": p["counts"], "capped": p["capped"], "notes": [],
                            "method": "auto", "made_by": "ElectroTag", "made_at": "2026-10-30T10:00:00.000+00:00",
                            "reference_sha256": reference_sha256(rs.reference_document(rid))}
        if planted:
            rs.guided["planted"] = planted
        rs.set_guided_tolerance(ts["guided_tolerance"])
        rs.set_practice_pass(ts["pass"])
        quiz = spec["quiz"]
        rs.quiz["include_none_option"] = True
        rs.quiz["feedback"] = quiz["feedback"]
        for it in quiz["items"]:
            rs.add_quiz_item(QuizItem(item_id=it["item_id"], recording_id=it["recording_id"], start_s=it["start_s"],
                                      end_s=it["end_s"], correct_label=it["correct_label"],
                                      accepted_labels=tuple(it["accepted_labels"]), explanation=it["explanation"],
                                      context_s=it["context_s"]), labels)
        rs.save()
        register_dataset(training_source, store, say=quiet)
        for u in spec["users"]:
            store.db.add_user(u["annotator_id"], u["password"], display_name=u["display_name"], role=u["role"],
                              roles=u.get("roles"), replace=True)
        for aid, rids in spec["assignments"].items():
            store.assign(aid, rids)
        for aid, set_id in spec["programmes"].items():
            store.enrol(aid, set_id)
        from electrotag.web.questionnaire import prefill_example

        for p in spec.get("questionnaire", []):  # the sandbox's own accounts start with the example answers
            prefill_example(store, p["annotator_id"], p["display_name"])
    finally:
        store.close()
    return study_dir


def serve(study_dir: Path) -> int:
    from fastapi.testclient import TestClient

    from electrotag.web.app import create_app

    app = create_app(study_dir, demo=True)
    client = TestClient(app)
    out = sys.stdout
    out.write("ready\n")
    out.flush()
    for line in sys.stdin:
        if not line.strip():
            continue
        req: dict[str, Any] = json.loads(line)
        body = req.get("body")
        r = client.request(req["method"], req["path"], headers=req.get("headers") or {},
                           content=body.encode("utf-8") if isinstance(body, str) else None)
        out.write(json.dumps({"status": r.status_code, "body": r.text}) + "\n")
        out.flush()
    app.state.store.close()
    return 0


def main() -> int:
    folder = Path(sys.argv[1]).resolve()
    return serve(build_study(folder))


if __name__ == "__main__":
    raise SystemExit(main())
