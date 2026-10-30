# Developer guide

ElectroTag has two halves. The **browser application**
(`electrotag/web/static`, plain ES modules with no build step) reads
recordings on the annotator's computer, shows them and provides the annotation
and training tools. The **Python package** holds everything else: a core that
reads recordings with MNE-Python, models and validates annotations and writes
and verifies the result files; the agreement, training and activity analyses;
and the study's back ends, the ElectroTag server (FastAPI) and the Firebase
Cloud Functions, which share one service layer. This guide describes the
Python core. The browser application, the service layer and how they fit
together are described in [web/architecture.md](web/architecture.md), and the
contract between browser and server in [web/api.md](web/api.md).

## Principles

* **The annotation store is the single source of truth.** An interface displays
  the store and sends every user action to it. The browser's store
  (`js/annotate/store.js`) is a port of the Python `AnnotationStore` with the
  same rules, and the session save rebuilds the annotations in the Python store
  before they are validated and written. Validation, undo/redo and history are
  therefore identical whether annotations are made interactively, in a test or
  in a script.
* **The core needs no interface.** Nothing in the package imports a desktop
  toolkit, so annotations and outputs can be processed in plain Python, and the
  server and the functions save annotators' work with the same code that
  scripts use. `tests/test_commands.py` imports every module and checks this.
* **Source data are read-only.** No code path opens a source file for writing.
  Filters act on a separate display copy. The test-suite hashes the whole
  dataset before and after complete sessions.
* **Recordings stay where they are.** A recording is registered where its
  files are and the study keeps only its manifest (fingerprints, timing,
  channels, events); the browser reads the annotator's own copy. Nothing in the
  study's records or in a request holds EEG.
* **Nothing is marked complete until it is verified.** Saving is a journalled
  transaction (see below).
* **Reuse MNE.** Loading, filtering, event extraction and the annotation
  container (`mne.Annotations` with `ch_names` and `extras`) come from
  MNE-Python; the browser's readers and filters reproduce MNE's results, and
  their tests compare them with MNE's.

## Package layout

```text
electrotag/
    __init__.py            version
    cli.py                 the electrotag command: lists the tools and passes the rest of the line to one
    __main__.py            python -m electrotag, the same as the electrotag command
    synthetic.py           synthetic BrainVision, EDF and BDF recordings with ground truth
    hints.py               "did you mean" suggestions for mistyped names
    report_style.py        the look shared by the HTML reports: colours, fonts, base style sheet
    config/
        artifact_labels.json            the 29 HED-SCORE artifact terms, codes and hierarchy
        hed_score_2.2.0_validation.json snapshot of the label check against HED SCORE
        default_settings.json           defaults; overridden by a study's settings
        settings.py                     Settings, FilterSettings, StudyConfig
    app/                   the annotation core
        common.py          identifiers, timestamps, modes
        annotations/       labels.py, timing.py, model.py, store.py, mne_bridge.py
        eeg/               loading.py, filtering.py, events.py, channels.py, amplitude.py
        io/                discovery.py, bids.py, edf.py, tsv.py, atomic.py, locking.py,
                           canonical.py, export.py, naming.py
        validation/        exports.py (read-back verification of outputs)
        session/           session.py, transaction.py, register.py, failures.py, selection.py,
                           autosave.py, interaction_log.py (the per-visit JSON Lines format)
    reliability/           config.py, data.py, intervals.py, statistics.py,
                           timeresolved.py, matching.py, confidence.py (each annotator's ratings, agreement
                           without low-confidence marks, and calibration), analysis.py, report.py, cli.py
    training/              reference.py, consensus.py, assessment.py, quiz.py, admin.py, cli.py,
                           programme.py (the three stages and their unlocking), guided.py (the
                           checks of guided steps), review.py (the disagreements flagged in a
                           practice review), examples.py (the placeholder example set)
    activity/              logs.py, summary.py, report.py, cli.py (electrotag activity)
    web/                   the browser version (web/architecture.md): service.py (the operations,
                           shared by the server and the Firebase functions), coach.py, visits.py,
                           manifest.py and registration.py, saving.py, store_files.py and
                           store_firestore.py, app.py (FastAPI), cli.py (electrotag web),
                           firebase/functions/main.py, static/ (the application)
```

## Data flow of one recording

1. **Registration**, on the computer that holds the dataset
   (`electrotag web register`, or the admin area, whose browser code builds
   the same manifest). `io.discovery.discover_recordings` walks the dataset,
   parses each BrainVision `.vhdr` header for `DataFile` and `MarkerFile` or
   each EDF/BDF header (`io.edf`), and resolves BIDS sidecars with the
   inheritance principle (`io.bids`). `eeg.loading.load_recording` fingerprints
   the files, checks the data-file size (BrainVision) or the header against the
   file size (EDF/BDF), reads the recording with
   `mne.io.read_raw_brainvision`, `read_raw_edf` or `read_raw_bdf` while
   capturing their warnings, loads the original events (`eeg.events`), checks
   event codes and channels (`eeg.channels`), leaves out the channels matching
   `channels.hide`, prepares the filtered display copy and measures the
   amplitudes (`eeg.amplitude`). `web.manifest.build_manifest` keeps what the
   browser and the session save need, and the study stores it.
2. **Annotating**, in the browser. The annotator opens their copy, the browser
   computes its fingerprint, and the study matches it against the register
   (`POST /match`). The browser reads, filters and shows the recording itself,
   and keeps drafts of unfinished work in the browser and with the study.
3. **Save and Finish.** The browser sends the annotations
   (`POST /submissions`). `web.service.StudyService.submit` checks them against
   the manifest, and `web.saving.WebSession`, a subclass of
   `session.session.AnnotationSession` in which `web.manifest.ManifestRecording`
   stands in for the loaded recording, builds the document and the five files
   (`io.export`, `io.canonical`); `session.transaction.commit_outputs` stages,
   validates (`validation.exports`), commits and registers them. The
   ElectroTag server writes into the study folder; the Firebase functions
   write into a scratch folder and keep the files in Firestore, from which
   `electrotag web export` writes the same folders.

Scripts can drive the same core directly: `examples/demo_end_to_end.py` loads
recordings with `load_recording`, adds annotations to an `AnnotationSession`
and finishes it, which writes exactly the files a study writes.

## Annotation store

`annotations.store.AnnotationStore` holds the annotations, the undo and redo
history and the listeners. Every change goes through `_commit`, which also
performs the automatic merging chosen by the research team: after an add,
update or merge, any annotation of the same label and identical channel scope
that overlaps the changed one in time is absorbed into one annotation (the
oldest identifier, by insertion order, survives), in the same undo step.
`last_auto_merged` and `last_survivors` tell the caller what happened. A review
store (your annotations next to the reference) is created with
`auto_merge=False`.

## The save transaction

`commit_outputs` writes a journal (`transaction.json`) in
`.electrotag/staging/<session>/` and moves through the states `staging`,
`validated`, `committing`, `files_committed` and `complete`:

1. write each file atomically into the staging folder;
2. read the staged files back and validate them: the events TSV must reproduce
   the original rows exactly and the annotations exactly, the canonical JSON
   must reproduce the annotations and recording metadata, the time file must
   match the measured time;
3. move each file into the output folder (same file system, so each move is
   atomic) and verify its checksum;
4. add the register entry (under a lock, atomic replace);
5. remove the staging folder.

An error before step 3 removes the staging folder. An error during step 3
moves any committed files out again. An error at step 4 leaves the files in
place and the journal at `files_committed`. `recover_interrupted_exports` rolls
such journals forward (all files present and verified) or back (moving partial
files to `.electrotag/interrupted/`), and when a session starts, output files
for the same recording and annotator that are not registered as complete are
handled first: a complete, consistent set is registered (its register row was
lost), anything else is moved to `.electrotag/interrupted/` with a warning.
The tests simulate a crash at every stage with a `BaseException` hook.

## Locks

`io.locking.FileLock` creates a lock file with `O_CREAT | O_EXCL` (which
fails if it exists) recording the process, host, time and a random token. A
lock is stale when its process no longer exists on the same host, or when it
has not been refreshed for longer than its limit (`recording_lock_stale_hours`,
2 h by default, for recording locks; 5 min for the register; 10 min for a save
in progress). Ages are measured with the clock of the folder holding the lock
(the modification time of a probe file written next to it), so computers
whose clocks disagree do not misjudge each other's locks.

Breaking a stale lock is serialised by a short-lived `<lock>.breaking` file.
Under it the breaker re-reads the lock and removes it only if it is still the
one it judged stale (same token), so two sessions never both hold a lock.
Releasing a lock removes the file only if it still carries the holder's token.
This works on local disks and on network drives that honour exclusive creation
(SMB and NFSv4 do).

Every save holds `staging/<session_id>.lock`, and recovery skips saves whose
lock is held, so a second request never interferes with a save in progress.
Files are moved into the results folder with a move that refuses to replace an
existing file (`atomic.move_no_clobber`). The journal stores the final folder
relative to the results folder, so recovery works when the folder is reached
by another path. On the ElectroTag server two requests to save the same
recording for the same annotator meet at the recording lock, and the second is
told to try again.

## Extension points

* **Labels.** Edit `config/artifact_labels.json`, increase
  `catalogue_version`, re-run `scripts/validate_hed_labels.py` and update
  `tests/test_labels.py`. Never change or reuse a code: catalogue versions are
  compatible (and their files comparable) only while every shared label keeps
  its code. `LabelCatalogue.ancestors`/`descendants` give the hierarchy used
  by the group roll-ups. The browser receives the catalogue from the study.
* **Agreement measures.** `reliability.analysis.register_measure(name, func)`;
  see the reliability guide.
* **Competency metrics.** Add an entry to `training.assessment.METRICS` and
  compute it in `compare_with_reference`.
* **Selection strategies.** The order in which a study offers an annotator's
  recordings is chosen in `web.service.StudyService._next` with
  `session.selection.seeded_order`; `session.selection` also holds
  `select_next` and the balanced allocation of `electrotag admin allocate`.
* **Data formats.** Formats are listed in `io.discovery.FORMATS` and read in
  `eeg.loading._read_raw`; supporting another MNE reader means adding its
  extension there and in `config.settings.RECORDING_EXTENSIONS`, a header or
  size check, and a source for its markers in `eeg.events`. The browser needs
  a reader of its own in `js/eeg/` that gives the same values, with tests
  against MNE in `web_tests/unit/` (web/architecture.md).
* **Drafts and autosave.** The browser keeps drafts of unfinished work
  (`js/annotate/session.js`) and the study stores them (`PUT /drafts/{recording_id}`).
  `session.autosave` is the core's own form of the same idea, used when an
  `AnnotationSession` is driven with autosave on: it writes the canonical
  document, the elapsed time and the source fingerprint atomically and accepts
  a `resume` record.

## Conventions

Type hints throughout; `from __future__ import annotations`; errors that can
reach a person are raised with messages written for annotators. Times in files
are local time with UTC offset (ISO 8601). User-facing text uses UK English,
while label strings keep the HED spelling *artifact*. The conventions of the
browser application (relative paths, no build step, behaviour when a Firebase
answer arrives late) are in [CLAUDE.md](../CLAUDE.md) and
[web/architecture.md](web/architecture.md).

## Packaging and continuous integration

`pyproject.toml` defines the package and its command, `electrotag`
(`electrotag/cli.py`), which lists the four tools and runs each of them:
`electrotag web`, `electrotag agreement`, `electrotag admin` and
`electrotag activity` pass the rest of the line to the `main(argv, prog)` of
`electrotag.web.cli`, `electrotag.reliability.cli`, `electrotag.training.cli`
and `electrotag.activity.cli`, so each tool's `--help` shows the name it was
started by. The tools are also console scripts of their own
(`electrotag-web`, `electrotag-agreement`, `electrotag-admin` and
`electrotag-activity`), which the workflows, the `Dockerfile` and older notes
use, and `python -m electrotag` is the same as `electrotag`. A new tool is a
module with such a `main` and an entry in `TOOLS` in `electrotag/cli.py`.
The package is installed from the repository (it is not published on PyPI);
the README gives the commands. Its package data (the configuration files and
the whole browser application under `electrotag/web/static`) is listed in
`[tool.setuptools.package-data]`, so an installation straight from GitHub
(`pip install "electrotag @ git+https://github.com/faisalmushtaq/ElectroTag"`)
serves the application as a copy of the repository does.
`requirements.txt` pins every package the server, the commands and
registration need (MNE-Python and the scientific stack, pybv for the simulated
recordings, FastAPI and uvicorn for the server, firebase-admin and
google-cloud-firestore for the administrator's Firebase commands), and
`requirements-dev.txt` adds pytest and the Cloud Functions' SDK for the
functions' tests. The Cloud Functions are deployed with their own
`electrotag/web/firebase/functions/requirements.txt` and a copy of the
package made by `scripts/vendor_functions.py`. After changing dependencies,
regenerate `THIRD_PARTY_NOTICES.md` with `scripts/third_party_notices.py` in an
environment made from `requirements.txt`.

Four GitHub Actions workflows run the checks and publish the application.
*Tests* (`.github/workflows/tests.yml`) runs the Python tests on Linux for every
push with Python 3.13 and 3.12, the oldest version supported, and on Windows,
macOS and Linux for pushes to main, pull requests into main and runs started
by hand, because the commands run on researchers' own computers. *Browser
version tests* (`web-tests.yml`) runs the browser modules (against Python 3.13
and 3.12, since the browser builds manifests as Python does), the application
in Chromium and WebKit, and the Firebase emulators. *GitHub Pages*
(`pages.yml`) publishes the browser application, and *Firebase deploy*
(`firebase-deploy.yml`) deploys the functions and rules on demand.
