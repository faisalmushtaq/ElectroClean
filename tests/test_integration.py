"""End-to-end workflow without the GUI: discovery → selection → loading →
annotation → validated export → completion register → agreement analysis.
"""

from __future__ import annotations

import hashlib
import json

from electroclean.app.annotations.labels import default_catalogue
from electroclean.app.eeg.loading import load_recording
from electroclean.app.io.canonical import read_annotations_json
from electroclean.app.io.discovery import discover_recordings
from electroclean.app.io.export import annotations_from_events_tsv
from electroclean.app.io.naming import OutputLayout
from electroclean.app.session.failures import FailureLog
from electroclean.app.session.register import CompletionRegister
from electroclean.app.session.selection import select_next
from electroclean.app.session.session import AnnotationSession
from electroclean.config.settings import load_settings
from electroclean.reliability import AnalysisConfig, run_analysis, write_outputs
from electroclean.synthetic import simulate_rater


def _tree_hash(root):
    return {
        p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file() and "Annotated_Events" not in p.parts
    }


def test_complete_workflow(dataset, tmp_path):
    root, truths = dataset
    before = _tree_hash(root)
    settings, _ = load_settings(root)
    cat = default_catalogue()
    layout = OutputLayout(root / "Annotated_Events")
    register = CompletionRegister(layout)
    recordings = discover_recordings(root)
    for annotator, seed in (("A01", 1), ("A02", 2)):
        while True:
            sel = select_next(
                recordings, annotator_id=annotator, completed=register.completed(annotator),
                failed=FailureLog(layout).unresolved(recordings, {}), strategy="seeded", seed=42,
            )
            if sel.recording is None:
                assert "All eligible recordings have been completed" in sel.message
                break
            lr = load_recording(sel.recording, settings, settings.filters, cat)
            session = AnnotationSession(layout=layout, settings=settings, filters=settings.filters, catalogue=cat,
                                        loaded=lr, annotator_id=annotator)
            session.start()
            session.start_timer()
            simulated = simulate_rater(truths[sel.recording.recording_id], annotator, seed=seed)
            for a in simulated.annotations:
                session.store.add(a.label, a.onset_sample, a.duration_samples, a.channels)
            result = session.finish()
            lr.close()
            # Every output exists, and both the TSV and the JSON reproduce the annotations.
            paths = result.commit.paths
            assert all(p.exists() for p in paths.values())
            doc = read_annotations_json(paths["annotations_json"])
            key = lambda a: (a.label, a.onset_sample, a.duration_samples, a.channels)  # noqa: E731
            assert sorted(map(key, doc.annotations)) == sorted(map(key, simulated.annotations))
            from_tsv = annotations_from_events_tsv(paths["events_tsv"].read_bytes(), doc.recording, cat)
            assert sorted(map(key, from_tsv)) == sorted(map(key, simulated.annotations))
            meta = json.loads(paths["session_json"].read_text())
            assert meta["recording"]["source_fingerprint"]["eeg"]["sha256"]
    assert register.completed("A01") == register.completed("A02") == set(truths)
    # Source data untouched.
    assert _tree_hash(root) == before
    # Agreement between the two annotators from their canonical files.
    result = run_analysis([layout.root], AnalysisConfig(resolutions_s=(0.05,)))
    assert result.dataset.annotators == ["A01", "A02"]
    assert len(result.dataset.groups) == 2
    out = write_outputs(result, tmp_path / "agreement")
    assert out["report"].exists()
    tr = result.table("timeresolved_pairwise")
    pooled = tr[(tr.recording == "ALL (pooled)") & (tr.category == "ANY-artifact") & (tr.representation == "exact")
                & (tr.channel_mode == "time_only")]
    assert 0.3 < float(pooled.cohen_kappa.iloc[0]) <= 1.0
