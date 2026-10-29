"""``electrotag-web demo``: a complete study on this computer, to try the whole system.

It makes simulated recordings (BrainVision and EDF+), the example training set, a study folder
with the recordings registered, and four accounts, then serves the browser application and the API:

==========  =============  ==============================================
ID          password       what they have
==========  =============  ==============================================
ADMIN       electrotag   administrator: the admin area
A01         electrotag   annotator: every study recording
A02         electrotag   annotator: every study recording
T01         electrotag   trainee: the example training programme
==========  =============  ==============================================

The recordings to open in the browser are in ``<dir>/recordings`` (``study/`` for A01 and A02,
``training/`` for T01) and can be downloaded from the server as ``/demo/recordings.zip``. The study
folder is ``<dir>/study``; results appear in ``<dir>/study/Annotated_Events``. The example set with
its experts' annotations is in ``<dir>/training-source`` (the server keeps its own copy in the study
folder). Nothing here is real data.
"""

from __future__ import annotations

import shutil
import zipfile
from pathlib import Path
from typing import Any

from electrotag.web.study import WebStudy

DEMO_STUDY = "demo"
DEMO_PASSWORD = "electrotag"
DEMO_USERS = (("ADMIN", "Study administrator", "admin"), ("A01", "Annotator one", "annotator"),
              ("A02", "Annotator two", "annotator"), ("T01", "Trainee one", "annotator"))


def build_demo(directory: Path | str, *, fresh: bool = False, say: Any = print, quiz: bool = True) -> Path:
    """Create the demonstration in ``directory`` (once; again with ``fresh``) and return the study folder.

    The example set gets a three-segment quiz unless ``quiz`` is false (the tests add their own items)."""
    import mne

    from electrotag.synthetic import make_synthetic_dataset, write_edf_recording
    from electrotag.training.examples import EXAMPLE_SET_ID, create_example_training_set
    from electrotag.web.registration import register_dataset
    from electrotag.web.store_files import FilesStore

    mne.set_log_level("error")
    directory = Path(directory).resolve()
    study_dir = directory / "study"
    if (study_dir / "electrotag_study.json").is_file() and (directory / "recordings.zip").is_file() and not fresh:
        say(f"Using the demonstration in {directory} (add --fresh to make it again).")
        return study_dir
    for sub in ("study", "recordings", "training-source", "recordings.zip"):
        p = directory / sub
        if p.is_dir():
            shutil.rmtree(p)
        elif p.exists():
            p.unlink()
    say(f"Making the demonstration in {directory} ...")
    recordings = directory / "recordings"  # what an annotator is given: the files to open in the browser
    dataset = recordings / "study"
    make_synthetic_dataset(dataset, n_subjects=2, duration_s=60.0, seed=7)
    write_edf_recording(dataset / "sub-003" / "eeg", "sub-003_task-rest", sfreq=128.0, duration_s=60.0, seed=8)
    shutil.rmtree(dataset / "derivatives", ignore_errors=True)  # the simulation's answers stay out of it
    training_source = directory / "training-source"  # the example set with its references (server side)
    example_set = create_example_training_set(training_source)
    if quiz:
        _add_demo_quiz(example_set)
    WebStudy.init(study_dir, study_id=DEMO_STUDY, name="ElectroTag demonstration",
                  settings={"selection": {"strategy": "manual"}})
    store = FilesStore(study_dir, demo=True)
    try:
        say("Registering the recordings (each is read with ElectroTag's loader, as for annotation):")
        reg = register_dataset(dataset, store, say=say)
        register_dataset(training_source, store, say=say)
        study_recordings = sorted(m["recording_id"] for m in reg.manifests)
        for aid, name, role in DEMO_USERS:
            store.db.add_user(aid, DEMO_PASSWORD, display_name=name, role=role, replace=True)
        for aid in ("A01", "A02"):
            store.assign(aid, study_recordings)
        store.enrol("T01", EXAMPLE_SET_ID)
        rs = store.reference_set(EXAMPLE_SET_ID)
    finally:
        store.close()
    src = training_source / "derivatives" / "electrotag_reference_sets" / EXAMPLE_SET_ID / rs.recordings_dir
    shutil.copytree(src, recordings / "training", dirs_exist_ok=True)
    with zipfile.ZipFile(directory / "recordings.zip", "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(recordings.rglob("*")):
            if p.is_file():
                zf.write(p, f"electrotag-demo-recordings/{p.relative_to(recordings).as_posix()}")
    say(f"The demonstration is ready: {len(study_recordings)} study recordings, the example training set, "
        f"and the accounts {', '.join(u[0] for u in DEMO_USERS)} (password {DEMO_PASSWORD}).")
    return study_dir


def _add_demo_quiz(rs: Any) -> None:
    """A short quiz on the example set's practice recording: one segment for each of its first
    artifact types, so that the demonstration offers the quiz (the answers are the simulation's)."""
    from electrotag.app.annotations.labels import default_catalogue
    from electrotag.training.reference import QuizItem

    labels = tuple(lbl.label for lbl in default_catalogue().labels)
    rid = rs.practice_recordings[0]
    doc = rs.reference_document(rid)
    sfreq = doc.recording.timing.sfreq
    seen: set[str] = set()
    for ann in sorted(doc.annotations, key=lambda a: a.onset_sample):
        if ann.label in seen or len(seen) == 3:
            continue
        seen.add(ann.label)
        start = ann.onset_sample / sfreq
        rs.add_quiz_item(QuizItem(item_id=f"q{len(seen):02d}", recording_id=rid, start_s=round(start, 3),
                                  end_s=round(start + ann.duration_samples / sfreq, 3), correct_label=ann.label,
                                  explanation="The answer is the simulation's: this artifact was simulated here."),
                         labels)


def serve_demo(directory: Path | str, *, host: str = "127.0.0.1", port: int = 8000, fresh: bool = False,
               allowed_origins: list[str] | None = None) -> None:
    import uvicorn

    from electrotag.web.app import allowed_origins_from_env, create_app

    study_dir = build_demo(directory, fresh=fresh)
    origins = allowed_origins if allowed_origins is not None else allowed_origins_from_env()
    zip_path = Path(directory).resolve() / "recordings.zip"
    app = create_app(study_dir, demo=True, allowed_origins=origins, demo_zip=zip_path)
    shown = "localhost" if host in ("127.0.0.1", "0.0.0.0") else host
    print(f"\nOpen http://{shown}:{port}/ and sign in as A01, A02, T01 or ADMIN with the password {DEMO_PASSWORD}.")
    print(f"The recordings to open are in {Path(directory).resolve() / 'recordings'} "
          f"(also at http://{shown}:{port}/demo/recordings.zip). Press Ctrl+C to stop.\n")
    uvicorn.run(app, host=host, port=port, log_level="warning")
