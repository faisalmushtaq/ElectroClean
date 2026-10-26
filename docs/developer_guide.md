# Developer guide

## Principles

* **The annotation store is the single source of truth.** The GUI displays the
  store and sends every user action to it. Validation, undo/redo and history
  are therefore identical whether annotations are made interactively, in a
  test or in a script.
* **Everything except the GUI works without Qt.** `electroclean.app` minus
  `app/gui`, `electroclean.reliability` and most of `electroclean.training`
  import no Qt, so annotations and outputs can be processed in plain Python.
* **Source data are read-only.** No code path opens a source file for writing.
  Filters act on a separate display copy. The test-suite hashes the whole
  dataset before and after complete sessions.
* **Nothing is marked complete until it is verified.** Saving is a journalled
  transaction (see below).
* **Reuse MNE.** Loading, filtering, event extraction, the EEG browser and the
  annotation container (`mne.Annotations` with `ch_names` and `extras`) come
  from MNE-Python; ElectroClean adds what MNE does not provide.

## Package layout

```text
electroclean/
    __init__.py            version
    __main__.py            python -m electroclean
    synthetic.py           synthetic BrainVision/BIDS recordings with ground truth
    config/
        artifact_labels.json            the 16 labels and codes (version-controlled)
        hed_score_2.2.0_validation.json snapshot of the label check against HED SCORE
        default_settings.json           defaults; overridden by electroclean_study.json
        settings.py                     Settings, FilterSettings, StudyConfig
    app/
        common.py          identifiers, timestamps, modes
        main.py            desktop entry point and crash handler
        annotations/       labels.py, timing.py, model.py, store.py, mne_bridge.py
        eeg/               loading.py, filtering.py, events.py, channels.py
        io/                discovery.py, bids.py, tsv.py, atomic.py, locking.py,
                           canonical.py, export.py, naming.py
        validation/        exports.py (read-back verification of outputs)
        session/           session.py, transaction.py, register.py, failures.py, selection.py
        gui/               browser.py (MNE integration), annotation_window.py,
                           start_window.py, filter_dialog.py, dialogs.py,
                           app_controller.py, workers.py, help_text.py
    reliability/           config.py, data.py, intervals.py, statistics.py,
                           timeresolved.py, matching.py, analysis.py, report.py, cli.py, gui.py
    training/              reference.py, consensus.py, assessment.py, quiz.py,
                           admin.py, cli.py, gui.py
```

## Data flow of one session

1. `io.discovery.discover_recordings` walks the dataset, parses each
   `.vhdr` header for `DataFile` and `MarkerFile`, and resolves BIDS sidecars
   with the inheritance principle (`io.bids`).
2. `session.selection.select_next` chooses a recording, excluding those the
   annotator completed (`session.register`) and unresolved failures
   (`session.failures`).
3. `eeg.loading.load_recording` (run in a `QThread` by the GUI) fingerprints the
   files, checks the data-file size, reads the recording with
   `mne.io.read_raw_brainvision` while capturing its warnings, loads original
   events (`eeg.events`), checks event codes, checks channels (`eeg.channels`)
   and prepares the display copy: in memory, or as a temporary memory-mapped
   file above `preload_memory_limit_mb`, filtered with MNE by
   `eeg.filtering.apply_view_filters`, which records MNE's own filter
   description.
4. `session.session.AnnotationSession` holds a lock file, the
   `annotations.store.AnnotationStore` and the monotonic timer.
5. `gui.annotation_window.AnnotationWorkspace` creates the MNE browser and an
   `gui.browser.AnnotationController`, and adds the toolbar and panels.
6. On Save and Finish, `AnnotationSession.finish` builds the document and the
   five files (`io.export`, `io.canonical`), and
   `session.transaction.commit_outputs` stages, validates
   (`validation.exports`), commits and registers them.

## The save transaction

`commit_outputs` writes a journal (`transaction.json`) in
`.electroclean/staging/<session>/` and moves through the states `staging`,
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
place and the journal at `files_committed`. At start-up,
`recover_interrupted_exports` rolls such journals forward (all files present
and verified) or back (moving partial files to `.electroclean/interrupted/`).
The tests simulate a crash at every stage with a `BaseException` hook.

## Locks

`io.locking.FileLock` creates a lock file with `O_CREAT | O_EXCL` (which
fails if it exists) recording the process, host, time and a random token. A
lock is stale when its process no longer exists on the same host, or when it
has not been refreshed for longer than its limit (`recording_lock_stale_hours`,
2 h by default, for recording locks; 5 min for the register; 10 min for a save
in progress). Ages are measured with the clock of the folder holding the lock
(the modification time of a probe file written next to it), so computers
whose clocks disagree do not misjudge each other's locks. An open annotation
window refreshes its recording lock every minute; if the lock is lost anyway
(for instance after a long sleep), Save and Finish takes it again or, if
another session holds it, refuses to save.

Breaking a stale lock is serialised by a short-lived `<lock>.breaking` file.
Under it the breaker re-reads the lock and removes it only if it is still the
one it judged stale (same token), so two sessions never both hold a lock.
Releasing a lock removes the file only if it still carries the holder's token.
This works on local disks and on network drives that honour exclusive creation
(SMB and NFSv4 do).

Every save holds `staging/<session_id>.lock`, and start-up recovery skips
saves whose lock is held, so starting a second window (or a second computer)
never interferes with a save in progress. Files are moved into the results
folder with a move that refuses to replace an existing file
(`atomic.move_no_clobber`). The journal stores the final folder relative to
the results folder, so recovery works when the folder is reached by another
path. When a session starts, output files for the same recording and
annotator that are not registered as complete are handled first: a complete,
consistent set is registered (its register row was lost), anything else is
moved to `.electroclean/interrupted/` with a warning.

## Integration with MNE's Qt browser

ElectroClean was written against **mne-qt-browser 0.7.5** and MNE 1.13.2.
`gui.browser` contains every use of the browser's internals and warns at run
time if a different mne-qt-browser version is installed.

The standard browser lets users type new annotation labels, merges
overlapping annotations with the same label whenever one is drawn or moved,
refuses overlaps between channel-specific annotations of the same label,
locates annotations by their onset (ambiguous when two start together), marks
channels bad when they are clicked, and has no undo or Save control.
ElectroClean therefore keeps MNE's annotation mode switched off and supplies:

* `ElectroCleanBrowser(MNEQtBrowser)`: a close guard and Escape to deselect.
  It is substituted for `MNEQtBrowser` while `raw.plot()` constructs the
  browser (MNE's `figure_class` option only works for the matplotlib backend).
* `ElectroCleanViewBox(RawViewBox)` and `ElectroCleanDataTrace(DataTrace)`:
  dragging creates an ElectroClean annotation; clicking a channel selects it.
  The browser looks these classes up by name in its own module, so the
  subclasses are installed there. They behave exactly like the originals for
  browsers that do not belong to ElectroClean.
* `ArtifactRegion(AnnotRegion)`: one region per annotation, identified by
  `annotation_id`. Its `_region_changed` reports edits to the controller
  instead of merging; a plain drag over it passes through to create an
  overlapping annotation; Shift+drag moves it; edge drags resize it.
* `AnnotationController`: synchronises regions with the store on the next
  event-loop turn after every change (never inside a mouse handler), keeps
  `raw.annotations` of the display copy in step for the overview bar, manages
  label rows, channel highlighting and filter edge zones.

Original events are passed to `raw.plot(events=…)`, which draws them as
event lines that cannot be edited.

**Upgrading MNE or mne-qt-browser.** Run the GUI tests (`pytest -m gui`) and
read the browser's changelog for changes to `AnnotRegion`, `RawViewBox`,
`DataTrace`, `_add_region`/`_remove_region`, `keyboard_shortcuts`,
`overview_bar.update_annotations` and `closeEvent`. Then update
`TESTED_MNE_QT_BROWSER` and `requirements.txt`.

## Extension points

* **Labels.** Edit `config/artifact_labels.json`, increase
  `catalogue_version`, re-run `scripts/validate_hed_labels.py` and update
  `tests/test_labels.py`. Files made with different catalogues cannot be
  compared, by design.
* **Agreement measures.** `reliability.analysis.register_measure(name, func)`;
  see the reliability guide.
* **Competency metrics.** Add an entry to `training.assessment.METRICS` and
  compute it in `compare_with_reference`.
* **Selection strategies.** `session.selection.select_next`.
* **Data formats.** Loading is isolated in `eeg.loading`; supporting another
  MNE reader means providing a different discovery suffix, header check and
  reader there. The rest of the application works on `RecordingInfo` and the
  display `Raw`.
* **Autosave and session recovery** (not implemented, as allowed by the
  specification): the store's snapshots could be written periodically to
  `.electroclean/` and offered back by `AppController.begin`.

## Conventions

Type hints throughout; `from __future__ import annotations`; errors that can
reach a user are raised with messages written for annotators. Times in files
are local time with UTC offset (ISO 8601). User-facing text uses UK English,
while label strings keep the HED spelling *artifact*.

## Packaging

`pyproject.toml` defines the package and three commands (`electroclean`,
`electroclean-agreement`, `electroclean-admin`). `requirements.txt` pins every
dependency; `requirements-dev.txt` adds pytest and pybv. The launchers in
`launchers/` create `.venv` on first use. A frozen single-file application
(for example with PyInstaller) has not been built; see the design decisions.
