"""Demonstration of the complete ElectroClean workflow on synthetic EEG.

    python examples/demo_end_to_end.py [work_folder] [--save-examples]

1. Creates a small BIDS dataset of synthetic BrainVision recordings with known
   artifacts (ground truth kept under derivatives/ground_truth).
2. Three annotators (A01, A02, A03) annotate every recording. Their annotations
   are simulated from the ground truth with different amounts of boundary
   jitter, misses, false alarms and label confusions, and are saved through
   the session code with which the study server and the Firebase functions
   save the browser's work, so every output file is produced, validated and
   registered exactly as in real use.
3. Runs the inter-rater agreement analysis and writes its report.
4. Builds a training reference set from the ground truth, sets competency
   criteria, lets annotator CAM complete the assessment and produces the
   competency report.

With ``--save-examples`` a selection of the outputs is copied to
``examples/example_output/`` (this is how the committed examples were made).
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))


def annotate(root: Path, layout, settings, catalogue, rid: str, annotator: str, annotations, *, mode="standard",
             context=None, display_name: str = "") -> object:
    from electroclean.app.eeg.loading import load_recording
    from electroclean.app.io.discovery import discover_recordings
    from electroclean.app.session.session import AnnotationSession

    files = {r.recording_id: r for r in discover_recordings(root)}[rid]
    lr = load_recording(files, settings, settings.filters, catalogue)
    s = AnnotationSession(layout=layout, settings=settings, filters=settings.filters, catalogue=catalogue, loaded=lr,
                          annotator_id=annotator, display_name=display_name, mode=mode, context=context or {})
    s.start()
    s.start_timer()
    for a in annotations:
        s.store.add(a.label, a.onset_sample, a.duration_samples, a.channels)
    result = s.finish()
    lr.close()
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("work", nargs="?", type=Path, default=REPO / "demo_run")
    ap.add_argument("--save-examples", action="store_true")
    args = ap.parse_args(argv)

    import mne

    mne.set_log_level("error")
    from electroclean.app.annotations.labels import default_catalogue
    from electroclean.app.annotations.model import AnnotationDocument
    from electroclean.app.io.naming import OutputLayout
    from electroclean.app.session.register import CompletionRegister
    from electroclean.config.settings import load_settings
    from electroclean.reliability import AnalysisConfig, run_analysis, write_outputs
    from electroclean.synthetic import make_synthetic_dataset, simulate_rater
    from electroclean.training.assessment import competency_report
    from electroclean.training.reference import ReferenceSet, reference_sets_dir

    work: Path = args.work
    if work.exists():
        shutil.rmtree(work)
    root = work / "SyntheticStudy"
    print(f"1. Creating synthetic dataset in {root}")
    truths = make_synthetic_dataset(root, n_subjects=3, duration_s=60.0, seed=2026)
    for rid, t in truths.items():
        print(f"   {rid}: {len(t.annotations)} ground-truth artifacts")

    settings, study = load_settings(root)
    catalogue = default_catalogue()
    layout = OutputLayout(root / settings.output_directory_name)
    confusion = {"Eye-blink-artifact": "Vertical-eye-movement-artifact", "Chewing-artifact": "EMG-artifact",
                 "Slow-eye-movement-artifact": "Horizontal-eye-movement-artifact"}
    raters = {"A01": dict(boundary_jitter_s=0.04, miss_probability=0.05, false_alarms=0, confusion_probability=0.0),
              "A02": dict(boundary_jitter_s=0.08, miss_probability=0.10, false_alarms=1, confusion_probability=0.15),
              "A03": dict(boundary_jitter_s=0.15, miss_probability=0.20, false_alarms=2, confusion_probability=0.30)}
    print("2. Three annotators annotate every recording (simulated input, real sessions and exports)")
    for i, rid in enumerate(sorted(truths)):
        for j, (aid, params) in enumerate(raters.items()):
            sim = simulate_rater(truths[rid], aid, seed=100 * i + j, confusion=confusion, **params)
            res = annotate(root, layout, settings, catalogue, rid, aid, sim.annotations, display_name=f"Demo {aid}")
            print(f"   {aid} saved {res.n_annotations:2d} annotations for {rid} -> {res.output_basename}")
    reg = CompletionRegister(layout)
    for aid in raters:
        print(f"   register: {aid} completed {len(reg.completed(aid))} recording(s)")

    print("3. Inter-rater agreement analysis")
    result = run_analysis([layout.root], AnalysisConfig())
    paths = write_outputs(result, work / "agreement")
    tr = result.table("timeresolved_pairwise")
    pooled = tr[(tr.recording == "ALL (pooled)") & (tr.category == "ANY-artifact") & (tr.representation == "exact")
                & (tr.channel_mode == "time_only")]
    for _, r in pooled.iterrows():
        print(f"   {r.rater_1}-{r.rater_2}: kappa {r.cohen_kappa:.3f}, positive agreement {r.positive_agreement:.3f}, "
              f"negative agreement {r.negative_agreement:.3f}")
    ev = result.table("events_summary")
    micro = ev[(ev.category == "ALL categories (micro-average)") & (ev.channel_mode == "time_only") & (ev.threshold == 0.2)]
    for _, r in micro.iterrows():
        print(f"   {r.reference}-{r.compared}: event F1 {r.f1:.3f} (IoU >= 0.2)")
    print(f"   report: {paths['report']}")

    print("4. Training and competency assessment for annotator CAM")
    rs = ReferenceSet.create(reference_sets_dir(root, study), "demo-set", name="Demonstration reference set",
                             method="single_expert", experts=["TRUTH"], notes="Synthetic ground truth used as the reference")
    ids = sorted(truths)
    for k, rid in enumerate(ids):
        expert = AnnotationDocument(truths[rid].recording, "TRUTH", list(truths[rid].annotations), catalogue, session_id="truth")
        rs.add_reference(expert, use="practice" if k == 0 else "assessment", method="single_expert", experts=["TRUTH"])
    rs.set_criteria({"criteria": [{"metric": "event_f1", "threshold": 0.8},
                                  {"metric": "event_recall", "threshold": 0.7, "scope": "each_category"},
                                  {"metric": "label_accuracy", "threshold": 0.85}],
                     "min_reference_events": 3})
    for k, rid in enumerate(rs.assessment_recordings):
        sim = simulate_rater(truths[rid], "CAM", seed=900 + k, boundary_jitter_s=0.06, miss_probability=0.08,
                             false_alarms=1, confusion=confusion, confusion_probability=0.1)
        annotate(root, layout, settings, catalogue, rid, "CAM", sim.annotations, mode="assessment",
                 context={"reference_set_id": rs.set_id}, display_name="Cameron")
    rep = competency_report(layout, rs, "CAM")
    print(f"   {rep['status_text']}")
    for ch in rep.get("checks", []):
        print(f"   - {ch['criterion']} [{ch['where']}]: {ch['value']:.3f} -> {'pass' if ch['passed'] else 'FAIL'}")
    print(f"   report: {rep['paths']['html']}")

    if args.save_examples:
        ex = REPO / "examples" / "example_output"
        if ex.exists():
            shutil.rmtree(ex)
        (ex / "Annotated_Events").mkdir(parents=True)
        src = layout.root
        for name in ("completion_register.tsv", "session_log.jsonl"):
            shutil.copy2(src / name, ex / "Annotated_Events" / name)
        shutil.copytree(src / "annotator-A01", ex / "Annotated_Events" / "annotator-A01")
        shutil.copytree(work / "agreement", ex / "agreement")
        rep_dir = src / "training" / "demo-set" / "reports"
        shutil.copytree(rep_dir, ex / "competency_report")
        print(f"Example outputs copied to {ex}")
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
