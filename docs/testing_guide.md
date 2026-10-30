# Testing guide

## Running the tests

In an active virtual environment (the [README](../README.md) shows how to make
one), from the repository's folder:

```bash
pip install -r requirements-dev.txt
pip install -e .
python -m pytest                                  # the Python tests (about 500, a few minutes)
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
fingerprints (the EEG library in `js/eeg/`, whose README says which test checks
which module) with MNE-Python and `hashlib` on recordings that
`scripts/make_web_fixtures.py` writes into `web_tests/fixtures/` (not
committed), and `eeg_imports.test.mjs` keeps that library free of imports from
the rest of the application. `run_e2e.mjs` drives the application in Chromium against the
demonstration, a stand-in server and the real `electrotag web demo`, with
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
`v_loading.e2e.mjs` keeps the sign-in page within a budget of JavaScript and checks that the later
views load at their first use, with Try again when one cannot be fetched.
`ui_type_colours.test.mjs` keeps the colours of the nine numbered types apart under simulated
red-green colour blindness. `o_landmarks.e2e.mjs` keeps
the structure that screen readers navigate by: one main landmark on every page, all text inside a
landmark or a dialog, and a heading for every table column. `api_contract_parity.test.mjs` sends
one scripted series of calls, what a visitor does in the public sandbox, to the real service layer
(served in-process by `web_tests/contract_parity.py`, with a fresh study made from the sandbox's own
recordings, accounts, training set and quiz) and to the sandbox's stand-in for the server
(`js/api/demo.js`), and compares every answer, shapes and values, error codes and the texts a person
reads, apart from a short list of differences that it gives with their reasons. It needs a Python with
FastAPI and MNE-Python, as CI's **Browser version tests** has, and is skipped without one. When it
fails, it names each call and field that differs; change the stand-in to answer as the server does,
or, where the server is wrong, tell the project lead rather than adding the difference to the list.
The two Firebase scripts run the functions
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

`scripts/make_channel_matrix.py` writes a covering set of 32 recordings across channel counts,
formats and edge cases, from one channel to 257: EDF, EDF+, BDF and BrainVision (INT_16 and
IEEE_FLOAT_32, multiplexed and vectorized) at 128, 160, 250, 256, 500, 512, 1000 and 2048 Hz, named
in the 10-20, 10-10 and 10-05 systems, as BioSemi's A1 to H32, as EGI's E1 to E256 with Cz, with VREF
or with neither, as plain numbers, as bipolar pairs, with spaces, in mixed case, in latin-1 and with
long names in other scripts, with EOG, ECG, EMG, respiration, temperature and trigger channels. Its
edge cases are the ones that have broken readers before: signals at different rates in one EDF, an
EDF+ annotation signal, recordings of three and of 64 samples, data records of 0.04 and 2.5 s, an
empty physical range, channels that hold only zeros, a marker on every sample of a held trigger (10,500
of them), duplicate names in EDF and in BrainVision, and
headers that are empty, announce no signals, give a number that is not a number or a size that
disagrees with their signals. The cases are chosen so that each value of each dimension appears at
least once, which keeps the set to about 12 MB, so `make_web_fixtures.py` writes it at test time into
`web_tests/fixtures/matrix/`. There `data_readers.test.mjs`, `data_filtering.test.mjs` and
`data_amplitude.test.mjs` compare the browser's reading with MNE-Python's, `data_register.test.mjs`
compares the browser's manifests and refusals with Python's, and `tests/test_channel_matrix.py`
registers every case with Python and runs a 256-channel study through saving, the agreement analysis
with channel-level matching and adjudication. `python scripts/make_channel_matrix.py --list` lists
the cases, and `--big FILE.bdf --channels 256 --sfreq 2048 --minutes 22` writes one BDF of about
2 GB, one data record at a time, for timing the fingerprint of a large file (delete it afterwards).

## Real recordings

The readers, the registration and the Python pipeline can also be checked on real recordings, which
are never part of the repository. Put each dataset in a folder of its own inside one folder, with the
recordings named as BIDS names them (`…_eeg.edf`, `…_eeg.bdf` or `…_eeg.vhdr` with its `.vmrk` and
`.eeg`, beside any `channels.tsv`, `events.tsv` and `electrodes.tsv`), and point
`ELECTROTAG_REAL_EEG` at that folder:

```bash
export ELECTROTAG_REAL_EEG=/path/to/real-eeg
node --test web_tests/unit/data_readers.test.mjs web_tests/unit/data_register.test.mjs
python -m pytest tests/test_real_eeg.py -s
```

`data_readers.test.mjs` then reads every recording below the folder in the browser's code and with
MNE-Python (`web_tests/register_parity.py --describe`) and compares the names, types, sampling rate,
length, annotations, triggers and values at the edges and at random places, as it does for the test
recordings; a recording MNE-Python cannot read must be refused by the browser too.
`data_register.test.mjs` registers each dataset folder in the browser and with Python and compares the
manifests field by field, and `tests/test_real_eeg.py` registers each one with Python and checks the
manifests against MNE-Python's reading and the study server's checks. The files are only read. On
30 October 2026 the check passed on the recordings below, one file from each dataset
([references](references.md) gives each dataset in full). Two were converted with MNE-Python
from EEGLAB files, which ElectroTag does not read: ds007609 to EDF (with `mne.export.export_raw`) and
the first 1200 s of ds002578 to BrainVision IEEE_FLOAT_32 (with pybv). ds005274's header names a data
file that is not in the dataset, and both readers refuse it in the same words.

| Dataset | Format | Channels | Rate (Hz) | Length | What makes it hard |
| --- | --- | --- | --- | --- | --- |
| BOAS, OpenNeuro ds005555 | EDF | 2 | 256 | 7.2 h | a consumer headband |
| Auditory-motor EEG, ds008161 | BDF | 4 + Status | 16384 | 340 s | the highest rate |
| UV_EEG, ds005274 | BrainVision | 6 | 500 | | a header naming files that do not exist |
| Sleep-EDF Expanded, SC4001E0 | EDF | 7 | 100 and 1 | 22 h | signals at two rates, temperature and an event marker |
| CHB-MIT, chb01_03 | EDF | 23 | 256 | 1 h | bipolar names, one name twice |
| EEG-Asymmetries, ds007172 | BrainVision float32 | 32 | 500 | 312 s | |
| Test-retest resting state, ds004148 | BrainVision float32 | 61 | 500 | 300 s | electrodes.tsv |
| EEG Motor Movement/Imagery, S001R03 | EDF+ | 64 | 160 | 125 s | annotations |
| 39 By BP, ds005289 | BrainVision INT_16 | 64 | 1000 | 301 s | 16-bit integers |
| 26 By Biosemi, ds005284 | BDF | 64 + Status | 1024 | 328 s | the Status channel |
| Continuous speech, ds004408 | BrainVision float32 | 128 | 512 | 196 s | BioSemi names A1 to D32 |
| BMI-HDEEG 4, ds004448 | EDF | 129 | 1000 | 6 s | EGI with Cz, whose physical range is empty |
| Spatial memory, ds004706 | BDF | 136 + Status | 2048 | 5 s | BioSemi 128 with EXG channels |
| Near-threshold detection, ds006171 | BDF | 143 + Status | 1024 | 1004 s | 444 MB; Unicode digits in events.tsv |
| Visual oddball, ds002578 | BrainVision float32 | 256 | 256 | 1200 s | BioSemi 256, 2253 events, a flat channel |
| Trait anxiety, ds007609 | EDF | 256 | 500 | 267 s | EGI HydroCel 256 |
| HD-EEGtask 1, ds003420 | BrainVision float32 | 256 | 1000 | 422 s | EGI E1 to E256 |
| HD-EEGtask 2, ds003421 | BrainVision float32 | 257 | 1000 | 449 s | E1 to E256 and Cz |

Three differences were found and put right. The browser's display filter left rounding residue of
about 10^-18 V in a channel that holds only zeros, because two channels share one Fourier transform,
so the amplitude check counted a dead channel that MNE-Python leaves out (ds002578); the sample
column of ds006171's `events.tsv` holds digits of other scripts, which Python's `int()` reads and the
browser did not; and the browser worded two refusals of a broken header differently from Python.
A BrainVision header that gives one name to several channels is now refused by both, in plain words,
because MNE-Python cannot read it. Registered without its `events.tsv`, ds003420 brought 185,443
BrainVision markers (EGI's DIN markers, one on every sample a trigger is held), a registration of
13 MB that the study refused; a registration now keeps the first 10,000 events and says so
([administrator guide](administrator_guide.md)). ds004408 gets an amplitude warning of about 44 V
(70 V without the display filters) in both readers: its float32 samples are about 4 x 10^10 with a
resolution of 0.1 µV, so the values in the file are about a million times too large (its header was
written by pybv, and its `channels.tsv` gives the unit as V, which suggests volts given where
microvolts were expected). The warning is right; the file is at fault, and MNE-Python reads the same
values.

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
the real `electrotag web demo`: a recording opened from disk and saved into
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
tests* workflow (`.github/workflows/web-tests.yml`) runs the browser modules
(against Python 3.13 and 3.12, because the browser builds a recording's
manifest as Python does and the two versions word some errors differently),
the application in Chromium and WebKit, and the Firebase emulators, on Linux.

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

On 30 October 2026 a BDF of 256 channels and Status at 2048 Hz for 22 minutes (2.08 GB, written with
`make_channel_matrix.py --big`) was read in Node.js with the browser's code: the streamed SHA-256 took
24 s (86 MB/s) with the process at 160 MB, opening it with the fingerprint computed in the same pass
took 29 s at 690 MB, and a filtered 10-second window of all 256 channels took 2.3 s on the page without
helper workers. Python's `hashlib` took 7 s. Registering it with `electrotag web register` took 207 s
and needed 5.6 GB of temporary disk space for the memory-mapped display copy (8 bytes for every sample
of every shown channel), which it removes afterwards; the admin area builds the same manifest in the
browser, which filters only the short windows that the amplitude check reads. Opening the 444 MB BDF of ds006171 in Chromium with its fingerprint took 3.9 s: the reading worker
scanned it in 2.1 s while the helper worker read it into memory (1.4 s) and hashed it with the
browser's own SHA-256 (1.8 s, about 245 MB/s on this machine; reading in 64 MB pieces instead of 8 MB
changed nothing). The streamed JavaScript SHA-256, used for files larger than the browser's own can
take in one piece (1 GB at most), ran at 49 MB/s in Chromium and 86 MB/s in Node.js. Through the whole
application (choosing the file, matching it with the study and drawing the first screen), the first
opening of ds003420 (432 MB) took 13.7 s, with the file read from disk for the first time, and a second
opening 5.4 s. On the real recordings
above, registration in the browser took 0.2 to 12 s per recording and with Python 0.3 to 54 s (the
256-channel BrainVision recording of ds003420, 432 MB). Saving 60 annotations on 256 channels took
0.1 s, and 200 annotations 0.3 s; each adjudication decision on a 256-channel recording took 0.1 s.
The agreement analysis with channel-level matching took 16 s for the 22 recordings of the channel
matrix from two annotators, and 30 s for five real recordings of 136 to 256 channels with 200
annotations each, most of them on a different set of channels (68 s before the time-resolved
comparison learned to count only the bins near each channel's marks).
