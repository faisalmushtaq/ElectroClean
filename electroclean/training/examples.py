"""An example training set made of simulated recordings, as a placeholder for real expert files.

``create_example_training_set`` writes three simulated recordings into a new self-contained
reference set (two for Stage 1, learning with the experts, and one for Stage 2, on your own) and
uses each recording's ground truth, which is known exactly because the artifacts were simulated,
as the "expert" reference. Names, descriptions and notes say plainly that these are placeholders;
the notes describe only what was simulated. Replace the recordings with real expert-annotated
files when they are available (``import_expert_recording`` in electroclean/training/reference.py,
or Administrator tools, Reference sets, Add recording with expert annotations).
"""

from __future__ import annotations

from pathlib import Path

from electroclean.app.annotations.labels import default_catalogue
from electroclean.synthetic import SyntheticArtifact, default_artifact_plan, truth_document, write_recording
from electroclean.training.guided import example_note
from electroclean.training.reference import ReferenceSet, ReferenceSetError, reference_sets_dir

EXAMPLE_SET_ID = "example"
EXAMPLE_EXPERT = "EXAMPLE"
BLINK = ("Fp1", "Fp2", "VEOG")
SIDE = ("F7", "F8", "HEOG")

# Stage 1, recording 1 (shown): six well separated artifacts of common types.
PLAN_1 = [
    SyntheticArtifact("Eye-blink-artifact", 4.0, 0.40, BLINK),
    SyntheticArtifact("Eye-blink-artifact", 12.5, 0.38, BLINK),
    SyntheticArtifact("Horizontal-eye-movement-artifact", 20.0, 1.20, SIDE),
    SyntheticArtifact("Electrode-pops-artifact", 30.0, 0.50, ("C3",)),
    SyntheticArtifact("Movement-artifact", 40.0, 2.00, ()),
    SyntheticArtifact("EMG-artifact", 50.0, 1.50, ("T7", "T8", "F7", "F8")),
]
# Stage 1, recording 2 (named, to be found): seven artifacts, some new types.
PLAN_2 = [
    SyntheticArtifact("Eye-blink-artifact", 5.5, 0.40, BLINK),
    SyntheticArtifact("Chewing-artifact", 14.0, 3.00, ("T7", "T8")),
    SyntheticArtifact("Electrode-pops-artifact", 24.5, 0.40, ("O2",)),
    SyntheticArtifact("Slow-eye-movement-artifact", 33.0, 4.00, SIDE),
    SyntheticArtifact("Eye-blink-artifact", 44.2, 0.36, BLINK),
    SyntheticArtifact("ECG-artifact", 52.0, 5.00, ("T7", "P7", "O1")),
    SyntheticArtifact("Movement-artifact", 64.0, 2.00, ()),
]
EXAMPLES = [
    # (subject, duration in s, seed, use, plan)
    ("sub-example01", 60.0, 701, "guided", PLAN_1),
    ("sub-example02", 75.0, 702, "guided", PLAN_2),
    ("sub-example03", 90.0, 703, "practice", None),  # the default plan: varied, with an overlap
]


def create_example_training_set(dataset_root: Path | str, study: object = None, *, set_id: str = EXAMPLE_SET_ID,
                                sfreq: float = 250.0) -> ReferenceSet:
    """Create the example set (self-contained) in the study's reference-set folder and return it."""
    import numpy as np

    base = reference_sets_dir(Path(dataset_root), study)  # type: ignore[arg-type]
    if (base / set_id / "reference_set.json").exists():
        raise ReferenceSetError(f"Reference set {set_id} already exists; remove its folder to create it again")
    rs = ReferenceSet.create(
        base, set_id,
        name="Example training set (placeholder)",
        description=("Simulated recordings standing in for real expert-annotated files: two to learn with the "
                     "experts and one to practise on. Replace them with your experts' recordings."),
        created_by="ElectroClean (example)", method="single_expert", experts=[EXAMPLE_EXPERT],
        notes="Placeholder: the reference is the simulation's ground truth, not an expert's judgement.",
    )
    rs.recordings_dir = "recordings"
    cat = default_catalogue()
    notes: dict[str, str] = {}
    staging = rs.directory / "recordings"
    for sub, duration, seed, use, plan in EXAMPLES:
        folder = staging / sub / "eeg"
        stem = f"{sub}_task-example"
        if plan is None:
            plan = default_artifact_plan(duration, np.random.default_rng(seed))
        vhdr, plan, timing = write_recording(folder, stem, sfreq=sfreq, duration_s=duration, seed=seed, plan=plan)
        rid = vhdr.relative_to(staging).as_posix()
        truth = truth_document(rid, plan, timing, cat, annotator_id=EXAMPLE_EXPERT)
        rs.add_reference(truth, use=use, method="single_expert", experts=[EXAMPLE_EXPERT],
                         details={"placeholder": True, "source": "simulated recording; ground truth used as reference"})
        stored = rs.reference_document(rid)
        by_time = {(a.onset_sample, a.label): a for a in stored.annotations}
        for art in plan:
            key = (timing.time_to_sample(art.start_s), art.label)
            if key in by_time:
                notes[by_time[key].annotation_id] = example_note(art.label, art.duration_s, art.channels)
    rs.guided = {**rs.guided, "notes": notes}
    rs.save()
    return rs
