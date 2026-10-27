# Testing guide

## Running the tests

```bash
python -m pip install -r requirements-dev.txt
python -m pip install --no-deps -e .
python -m pytest                 # everything (about 215 tests, under a minute)
python -m pytest -m "not gui"    # without Qt
python -m pytest -m gui          # only the GUI tests
```

The GUI tests create real windows with the real MNE browser. They set
`QT_QPA_PLATFORM=offscreen`, so they run without a display (on a headless
Linux machine the Qt system libraries `libEGL`, `libGL`, `libxkbcommon` and
`libfontconfig` must be installed). Mouse input is simulated with the
browser's own testing helper, the same mechanism MNE uses in its test-suite,
and dialogs are answered by `ScriptedPrompts`.

## Synthetic data

`electroclean/synthetic.py` writes small BIDS datasets of BrainVision
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
`python examples/make_synthetic_dataset.py my_data --with-problems`.

## Coverage of the required tests

| # | Requirement | Tests |
|---|---|---|
| 1 | Discovery of recordings | `test_discovery.py::test_recursive_discovery_and_exclusions`, `test_identical_file_names_get_distinct_ids`; `test_edf.py::test_discovery_finds_every_supported_format` |
| 2 | Pairing with metadata files | `test_discovery.py::test_companions_and_sidecars_paired`, `test_bids_inheritance_and_specificity`, `test_sidecars_not_cross_matched_between_runs` |
| 3 | Loading EEG data | `test_loading.py::test_load_recording_basic`, `test_no_filters_keeps_lazy_loading`, `test_memory_mapped_display_copy_for_large_recordings`; `test_edf.py` (EDF, EDF+, BDF, hidden channels, gaps, `test_unfiltered_display_matches_the_file`) |
| 4 | Filtering without altering source data | `test_loading.py::test_filtering_does_not_alter_source`, `test_iir_filters_recorded`, `test_discontinuity_segments_filtered_separately`; `test_integration.py` hashes the dataset before and after |
| 5 | Creating and editing annotations | `test_store.py::test_create_edit_resize_delete`, `test_undo_redo`; `test_gui.py::test_draw_edit_and_save`, `test_resize_by_dragging_edge_and_move_with_shift` |
| 6 | One, several or all channels | `test_store.py::test_channel_scopes`; `test_gui.py::test_draw_edit_and_save` |
| 7 | Overlapping categories | `test_store.py::test_overlapping_different_categories_are_independent`; `test_gui.py::test_draw_edit_and_save` (drawn over an existing annotation) |
| 8 | Sample and time conversion | `test_timing.py::test_sample_time_round_trip` (11 sampling rates, indices up to 10⁹), `test_mne_round_trip_respects_first_samp` |
| 9 | Preservation of original events | `test_export.py::test_events_tsv_columns_and_original_rows_preserved` (byte-level), `test_vmrk_events_used_without_events_tsv` |
| 10 | Conflicting event codes | `test_export.py::test_original_codes_that_equal_artifact_codes_cannot_be_confused`, `test_original_code_report_never_blocks`, `test_exports_from_version_1_can_still_be_read`; `test_loading.py::test_original_codes_like_artifact_codes_load_without_a_policy` |
| 11 | Export of the labels (all 29 HED-SCORE terms) | `test_labels.py::test_catalogue_contains_every_hed_score_artifact_term_with_fixed_codes`, `test_hierarchy_follows_the_schema`, `test_labels_exist_in_hed_score_2_2_0_snapshot`, `test_catalogue_versions_are_compatible_when_codes_agree`; `test_export.py::test_all_labels_export_with_fixed_codes` |
| 12 | Round-trip export and import | `test_export.py::test_round_trip_tsv_and_json`, `test_written_canonical_file_reads_back`; `test_timing.py::test_mne_round_trip_respects_first_samp` |
| 13 | Repeated annotations of one category | `test_store.py::test_repeated_same_label_annotations` (separate unless they overlap on the same channels, then merged in one undo step), `test_automatic_merging_can_be_switched_off`; `test_gui.py::test_draw_edit_and_save` |
| 14 | Missing or corrupted files | `test_edf.py::test_broken_edf_files_are_refused` (truncated, too long, header only, not EDF, EDF+D), `test_unknown_record_count_is_accepted_with_a_warning`; `test_loading.py::test_missing_companion_files_fail`, `test_truncated_data_file_fails`, `test_truncated_on_sample_boundary_detected_by_markers`, `test_corrupted_header_fails`, `test_malformed_events_tsv_fails`; `test_gui.py::test_failed_load_message_and_continue` |
| 15 | Output write failure | `test_session.py::test_write_failure_never_marks_complete` (6 stages), `test_register_failure_is_recovered_on_next_start`, `test_crash_recovery`; `test_integrity.py` (failed roll-backs retried, failures after the register update, relocated results folder, unreadable journals) |
| 16 | Per-annotator completion | `test_session.py::test_completion_is_per_annotator`; `test_gui.py::test_full_application_loop` |
| 17 | Duplicate processing and overwriting | `test_session.py::test_completed_recording_not_reopened_or_overwritten`, `test_simultaneous_sessions_blocked_by_lock`, `test_stale_lock_from_dead_process_is_broken`; `test_integrity.py` (recovery during another session's save, stale-lock race, clock skew, heartbeat, leftover outputs) |
| 18 | Inter-rater agreement on known examples | `test_reliability.py` (hand-computed 2×2 tables, kappa, Fleiss' kappa and alpha; comparison with reference implementations on random data; matching examples) |
| 19 | Absent annotations and clean intervals | `test_reliability.py::test_clean_recording_and_absent_annotations`, `test_time_resolved_two_raters`; `test_export.py::test_empty_annotation_set_exports_cleanly`; `test_gui.py::test_save_with_no_annotations_needs_confirmation` |
| 20 | Whole-montage and channel-specific | `test_reliability.py::test_whole_montage_versus_channel_specific`, `test_eog_and_ecg_channels_are_included_in_channel_analyses`; `test_export.py::test_whole_montage_and_channel_encodings` |

End-to-end workflows: `test_integration.py::test_complete_workflow` (headless:
discovery, selection, loading, annotation, validated export, register,
agreement analysis), `test_gui.py::test_full_application_loop` (the desktop
application from start request to "all recordings completed"),
`test_training_gui.py` (practice with feedback and review, blinded assessment
ending in the competency report, quiz, administrator tools, assignment).

Three independent reviews (data integrity, statistics and the GUI) were run
against the code with reproduction scripts; every confirmed problem has a
regression test, in `test_integrity.py`, in the "edge cases (review)" section
of `test_reliability.py`, in `test_training.py`, and at the end of
`test_gui.py` and `test_training_gui.py` (for example: the application keeps
running while a recording opens, Ctrl shortcuts never reach MNE's single-key
shortcuts, Draw/edit off blocks every edit, a skipped assessment recording is
not reported as complete).

EDF recordings are opened in the real application in
`test_gui.py::test_edf_recording_in_the_application` (a dataset mixing
BrainVision and EDF, housekeeping channels hidden, a channel-specific
annotation saved), and the saved files are checked in
`test_edf.py::test_session_saves_and_validates_edf_outputs`.

Autosave is tested in `test_autosave.py` (when it writes, restoring with the
time carried over, discarding, recordings that changed) and through the whole
application in `test_gui.py::test_finish_later_and_continue_in_a_new_session`
and `test_declined_autosave_is_set_aside_when_starting_afresh`. Group roll-ups
are tested in `test_reliability.py::test_group_rollups_show_agreement_on_the_artifact_family`.

## Windows, macOS and Linux

The GitHub Actions workflow `.github/workflows/build-apps.yml` runs the whole
test-suite on Linux for every push. When started by hand, for pull requests
into main and for version tags, it runs the test-suite on Windows, macOS and
Linux, then builds the stand-alone application on each system and runs its
self-test
(`ElectroClean --self-test`), which loads a synthetic recording with filters,
opens the real annotation window off screen, saves an annotation through Save
and Finish, runs an agreement analysis and reads an EDF+ recording. The same self-test can be run on
any computer that will be used in a study.

## Checks that need a person

Automated tests cannot judge how the application feels or looks on each
system. Before a study, someone should check the following on each type of
computer that annotators will use:

1. The stand-alone application (or the launcher) starts ElectroClean on a
   fresh account (Windows: no console window stays open; macOS: the first-run
   confirmation appears and then the app opens).
2. Dragging on the EEG with a mouse and with a trackpad creates annotations
   where expected; edge dragging and Shift+drag behave as described; the
   right-click menu appears under the pointer.
3. Keyboard navigation works, including the Mac shortcuts with fn, and Ctrl/Cmd
   shortcuts for undo, redo and delete do not trigger MNE's own single-key
   shortcuts.
4. The window is usable on a 13-inch laptop (1366 × 768 or 1440 × 900) and on
   a large monitor; panels can be resized and the text is readable on
   high-DPI screens.
5. Colours are distinguishable on the screens used, and labels remain
   readable when several annotations overlap.
6. A long recording from the study scrolls smoothly.
7. With the results folder on the study's network drive, two annotators can
   work at the same time, and opening the same recording as the same annotator
   on two computers is refused.
8. Pulling the network cable during Save and Finish leaves the recording
   incomplete, and the next start reports the interrupted save.

## Performance (measured on the development machine)

A 60-minute, 64-channel recording at 500 Hz (0.46 GB data file): loading,
checksum and filtering took 14 s in memory and 19 s with the memory-mapped
display copy (the loading runs in the background with progress messages);
the viewer opened in 0.3 s; adding and displaying 300 annotations took 2.6 s in
total; undo took 0.06 s and Save and Finish 0.3 s.
