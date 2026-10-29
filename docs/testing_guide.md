# Testing guide

## Running the tests

```bash
python -m pip install -r requirements-dev.txt
python -m pip install --no-deps -e .
python -m pytest                                  # the Python tests (about 290, a few minutes)
python -m pytest tests/test_store.py -q           # one file
```

The Python tests cover the annotation core, the agreement, training and
activity analyses, the commands, the ElectroTag server (through FastAPI's
test client) and the Firebase functions. They need no display and no network;
the Firestore tests are skipped unless the Firestore emulator is running (see
below).

The browser application has tests of its own, described in
[web/architecture.md](web/architecture.md) ("Tests"):

```bash
node --test web_tests/unit/*.test.mjs                     # the browser modules (Node.js 22)
ELECTROTAG_PYTHON=python node web_tests/run_e2e.mjs     # the application in Chromium (Playwright)
ELECTROTAG_PYTHON=python node web_tests/run_e2e.mjs --browser webkit   # the same in WebKit, Safari's engine
bash scripts/test_firebase_emulators.sh                   # the functions and the Firestore store (Java 21)
bash scripts/test_web_firebase.sh                         # the application with a study on Firebase's emulators
```

The unit tests compare the browser's readers, filters, amplitude check and
fingerprints with MNE-Python and `hashlib` on recordings that
`scripts/make_web_fixtures.py` writes into `web_tests/fixtures/` (not
committed). `run_e2e.mjs` drives the application in Chromium against the
demonstration, a stand-in server and the real `electrotag-web demo`, with
recordings opened from disk and the results checked in the study folder; it
needs Playwright with Chromium (`npm install --no-save playwright@1.63.0` and
`npx playwright install chromium`). With `--browser webkit` the same tests run in
WebKit, the engine of Safari on iPads and Macs (`npx playwright install --with-deps
webkit`); `k_ipad.e2e.mjs` checks the application as an iPad: touch on the EEG
(in Chromium, which can put several fingers on the screen at once), the layouts
upright and on its side, a phone's notice and the file pickers. `t_annotation_list.e2e.mjs` checks
that the Annotations list shows every label in full at the common screen sizes, and `g_layout.e2e.mjs`
that the annotation view keeps its type buttons whole, its instructions whole and every part clear
of the others at the common laptop sizes and with the browser's zoom at 150% and 200%.
`ui_type_colours.test.mjs` keeps the colours of the nine numbered types apart under simulated
red-green colour blindness. `o_landmarks.e2e.mjs` keeps
the structure that screen readers navigate by: one main landmark on every page, all text inside a
landmark or a dialog, and a heading for every table column. The two Firebase scripts run the functions
and the application on Google's Firebase Emulator Suite, with a project ID that
starts with `demo-` and so never reaches a real Firebase project.

## Synthetic data

`electrotag/synthetic.py` writes small BIDS datasets of BrainVision
recordings (22 channels: 19 EEG, HEOG, VEOG and ECG, 250 Hz, 50 Hz mains) with:

* background activity, alpha rhythm and mains interference;
* artifacts at known positions: eye blinks, horizontal and slow eye
  movements, EMG bursts, chewing, electrode pops, movement and ECG, some
  overlapping, some repeated, some whole-montage and some channel-specific;
* experimental markers in the `.vmrk` file and the matching `events.tsv`,
  `events.json`, `channels.tsv` and `eeg.json`;
* optionally a recording whose events use code 101 (an artifact code), a
  recording with a discontinuity ("New Segment" marker) and two recordings
  with the same file name in different folders.

`write_edf` and `write_edf_recording` write EDF, EDF+ and BDF files
(following the EDF and EDF+ specifications; Kemp et al., 1992; Kemp and
Olivan, 2003) without any extra package, imitating a headset export:
housekeeping channels next to the EEG, a `channels.tsv` that types every
channel as EEG, EDF+ event annotations, an `events.tsv` whose `sample` column
holds timestamps, and the padded last data record marked `BAD_ACQ_SKIP`.

The ground truth is saved in the canonical format under
`derivatives/ground_truth/`. `simulate_rater` derives plausible annotators
from it. Create a dataset with
`python examples/make_synthetic_dataset.py my_data --with-problems`. The
demonstration's recordings and the example training set are made with the same
code.

## Coverage of the required tests

| # | Requirement | Tests |
|---|---|---|
| 1 | Discovery of recordings | `test_discovery.py::test_recursive_discovery_and_exclusions`, `test_identical_file_names_get_distinct_ids`; `test_edf.py::test_discovery_finds_every_supported_format` |
| 2 | Pairing with metadata files | `test_discovery.py::test_companions_and_sidecars_paired`, `test_bids_inheritance_and_specificity`, `test_sidecars_not_cross_matched_between_runs` |
| 3 | Loading EEG data | `test_loading.py::test_load_recording_basic`, `test_no_filters_keeps_lazy_loading`, `test_memory_mapped_display_copy_for_large_recordings`; `test_edf.py` (EDF, EDF+, BDF, hidden channels, gaps, `test_unfiltered_display_matches_the_file`); in the browser, `web_tests/unit/data_readers.test.mjs` (headers, channels, markers and samples as MNE reads them) |
| 4 | Filtering without altering source data | `test_loading.py::test_filtering_does_not_alter_source`, `test_iir_filters_recorded`, `test_discontinuity_segments_filtered_separately`; `test_integration.py` hashes the dataset before and after; in the browser, `web_tests/unit/data_filtering.test.mjs` and `data_dsp.test.mjs` (MNE's designs and filtered samples) |
| 5 | Creating and editing annotations | `test_store.py::test_create_edit_resize_delete`, `test_undo_redo`; `web_tests/unit/ui_store.test.mjs`; `web_tests/e2e/b_annotate.e2e.mjs` (keys, dragging, M marks, edits, undo and Save and Finish in Chromium) |
| 6 | One, several or all channels | `test_store.py::test_channel_scopes`; `web_tests/unit/ui_store.test.mjs`; `web_tests/e2e/b_annotate.e2e.mjs` |
| 7 | Overlapping categories | `test_store.py::test_overlapping_different_categories_are_independent`; `web_tests/unit/ui_store.test.mjs` |
| 8 | Sample and time conversion | `test_timing.py::test_sample_time_round_trip` (11 sampling rates, indices up to 10⁹), `test_mne_round_trip_respects_first_samp`; `web_tests/unit/ui_store.test.mjs` (times snap to samples) |
| 9 | Preservation of original events | `test_export.py::test_events_tsv_columns_and_original_rows_preserved` (byte-level), `test_vmrk_events_used_without_events_tsv` |
| 10 | Conflicting event codes | `test_export.py::test_original_codes_that_equal_artifact_codes_cannot_be_confused`, `test_original_code_report_never_blocks`, `test_exports_from_version_1_can_still_be_read`; `test_loading.py::test_original_codes_like_artifact_codes_load_without_a_policy` |
| 11 | Export of the labels (all 29 HED-SCORE terms) | `test_labels.py::test_catalogue_contains_every_hed_score_artifact_term_with_fixed_codes`, `test_hierarchy_follows_the_schema`, `test_labels_exist_in_hed_score_2_2_0_snapshot`, `test_catalogue_versions_are_compatible_when_codes_agree`; `test_export.py::test_all_labels_export_with_fixed_codes` |
| 12 | Round-trip export and import | `test_export.py::test_round_trip_tsv_and_json`, `test_written_canonical_file_reads_back`; `test_timing.py::test_mne_round_trip_respects_first_samp` |
| 13 | Repeated annotations of one category | `test_store.py::test_repeated_same_label_annotations` (separate unless they overlap on the same channels, then merged in one undo step), `test_automatic_merging_can_be_switched_off`; `web_tests/unit/ui_store.test.mjs` |
| 14 | Missing or corrupted files | `test_edf.py::test_broken_edf_files_are_refused` (truncated, too long, header only, not EDF, EDF+D), `test_unknown_record_count_is_accepted_with_a_warning`; `test_loading.py::test_missing_companion_files_fail`, `test_truncated_data_file_fails`, `test_truncated_on_sample_boundary_detected_by_markers`, `test_corrupted_header_fails`, `test_malformed_events_tsv_fails`; in the browser, `web_tests/unit/data_readers.test.mjs` (refused as MNE-based loading refuses them, with the same wording) and `web_tests/e2e/d_local_file.e2e.mjs` (a changed copy and a file outside the study) |
| 15 | Output write failure | `test_session.py::test_write_failure_never_marks_complete` (6 stages), `test_register_failure_is_recovered_on_next_start`, `test_crash_recovery`; `test_integrity.py` (failed roll-backs retried, failures after the register update, relocated results folder, unreadable journals) |
| 16 | Per-annotator completion | `test_session.py::test_completion_is_per_annotator` |
| 17 | Duplicate processing and overwriting | `test_session.py::test_completed_recording_not_reopened_or_overwritten`, `test_simultaneous_sessions_blocked_by_lock`, `test_stale_lock_from_dead_process_is_broken`; `test_integrity.py` (recovery during another session's save, stale-lock race, clock skew, heartbeat, leftover outputs) |
| 18 | Inter-rater agreement on known examples | `test_reliability.py` (hand-computed 2×2 tables, kappa, Fleiss' kappa and alpha; comparison with reference implementations on random data; matching examples) |
| 19 | Absent annotations and clean intervals | `test_reliability.py::test_clean_recording_and_absent_annotations`, `test_time_resolved_two_raters`; `test_export.py::test_empty_annotation_set_exports_cleanly` |
| 20 | Whole-montage and channel-specific | `test_reliability.py::test_whole_montage_versus_channel_specific`, `test_eog_and_ecg_channels_are_included_in_channel_analyses`; `test_export.py::test_whole_montage_and_channel_encodings` |

End-to-end workflows: `test_integration.py::test_complete_workflow` (discovery,
selection, loading, annotation, validated export, register, agreement
analysis, without an interface); `test_web_server.py` (signing in, matching a
file, drafts, saving the same files as the core writes, guided training,
practice feedback, the competency result and administration, over HTTP);
`web_tests/e2e/h_study_server.e2e.mjs` (the application in Chromium against
the real `electrotag-web demo`: a recording opened from disk and saved into
the study folder, a draft restored in another browser, and the training
programme checked and scored by the server); and `scripts/test_web_firebase.sh`
(the same with a study on Firebase's emulators, including the administrator's
export).

Three independent reviews (data integrity, statistics and the interface) were
run against the code with reproduction scripts; every confirmed problem in the
core has a regression test, in `test_integrity.py`, in the "edge cases
(review)" section of `test_reliability.py` and in `test_training.py`. The
problems found in a usability walk-through of the analyses and commands are
tested in `test_reliability_usability.py`, `test_training_usability.py` and
`test_cli_usability.py`, and `test_commands.py` checks the commands and that no
module imports a desktop toolkit. Autosave in the core is tested in
`test_autosave.py`, and group roll-ups in
`test_reliability.py::test_group_rollups_show_agreement_on_the_artifact_family`.

## Windows, macOS and Linux

The *Tests* workflow (`.github/workflows/tests.yml`) runs the Python tests on
Linux for every push (with Python 3.13 and 3.12), and on Windows, macOS and
Linux for pushes to main, for pull requests into main and when started by hand,
because the commands run on researchers' own computers. The *Browser version
tests* workflow (`.github/workflows/web-tests.yml`) runs the browser modules,
the application in Chromium and the Firebase emulators on Linux.

## Checks that need a person

Automated tests cannot judge how the application feels or looks on each
computer. The application is tested in Chromium (Chrome and Edge) and in WebKit
(Safari's engine), including emulated iPads; before a study, someone should
check the following in each browser and on each type of computer or tablet that
annotators will use (Firefox, Safari and a real iPad in particular):

1. The study's link opens the sign-in page, and signing in, the notice about
   the interaction log and the list of recordings appear as described in
   [using ElectroTag](web/using.md).
2. Opening a recording from the computer works with the file picker, with a
   folder and by dropping the files on the page, for EDF, BDF and BrainVision
   (all three files), and a large recording shows the progress of its
   fingerprint and opens in reasonable time.
3. Dragging on the EEG with a mouse and with a trackpad creates annotations
   where expected; edge dragging and Shift+drag behave as described; the
   right-click menu appears under the pointer.
4. The keys work, including the Mac shortcuts with fn and ⌘ for undo, redo and
   delete, and the browser's own shortcuts do not get in the way.
5. The window is usable on a 13-inch laptop (1366 × 768 or 1440 × 900) and on
   a large monitor, and the text is readable on high-DPI screens.
6. On an iPad, upright and on its side: one finger and the Pencil mark
   artifacts, two fingers move and pinch, a long press opens the menu and a
   double tap the list of types, the buttons under the EEG respond, and the
   Files picker offers EDF, BDF and the three BrainVision files.
7. Colours are distinguishable on the screens used, and labels remain
   readable when several annotations overlap.
8. A long recording from the study scrolls smoothly; the first 10-second
   screen of a 128-channel recording with filters took about 0.3 s to appear on
   the test machine, and the following screens, prepared in advance, much less.
8. Closing the tab without Save and Finish keeps a draft, which is offered
   again when the recording is opened in another browser; switching off the
   network during Save and Finish leaves the recording incomplete, and saving
   again works once the network is back.

## Performance (measured on the development machine)

The browser's times for reading, fingerprinting and filtering a 128-channel
recording of 30 minutes at 1024 Hz are in
[web/architecture.md](web/architecture.md) ("Memory and speed"). For
registration, which reads each recording with MNE-Python: a 60-minute,
64-channel recording at 500 Hz (0.46 GB data file) took 14 s to load,
fingerprint and filter in memory, and 19 s with the memory-mapped display copy.
