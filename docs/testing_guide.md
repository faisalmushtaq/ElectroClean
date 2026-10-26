# Testing guide

## Running the tests

```bash
python -m pip install -r requirements-dev.txt
python -m pip install --no-deps -e .
python -m pytest                 # everything (179 tests, about 35 s)
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
recordings (21 channels including HEOG and VEOG, 250 Hz) with:

* background activity, alpha rhythm and mains interference;
* artifacts at known positions: eye blinks, horizontal and slow eye
  movements, EMG bursts, chewing, electrode pops, movement and ECG, some
  overlapping, some repeated, some whole-montage and some channel-specific;
* experimental markers in the `.vmrk` file and the matching `events.tsv`,
  `events.json`, `channels.tsv` and `eeg.json`;
* optionally a recording whose events use code 101 (an artifact code), a
  recording with a discontinuity ("New Segment" marker) and two recordings
  with the same file name in different folders.

The ground truth is saved in the canonical format under
`derivatives/ground_truth/`. `simulate_rater` derives plausible annotators
from it. Create a dataset with
`python examples/make_synthetic_dataset.py my_data --with-problems`.

## Coverage of the required tests

| # | Requirement | Tests |
|---|---|---|
| 1 | Discovery of BrainVision recordings | `test_discovery.py::test_recursive_discovery_and_exclusions`, `test_identical_file_names_get_distinct_ids` |
| 2 | Pairing with metadata files | `test_discovery.py::test_companions_and_sidecars_paired`, `test_bids_inheritance_and_specificity`, `test_sidecars_not_cross_matched_between_runs` |
| 3 | Loading EEG data | `test_loading.py::test_load_recording_basic`, `test_no_filters_keeps_lazy_loading`, `test_memory_mapped_display_copy_for_large_recordings` |
| 4 | Filtering without altering source data | `test_loading.py::test_filtering_does_not_alter_source`, `test_iir_filters_recorded`, `test_discontinuity_segments_filtered_separately`; `test_integration.py` hashes the dataset before and after |
| 5 | Creating and editing annotations | `test_store.py::test_create_edit_resize_delete`, `test_undo_redo`; `test_gui.py::test_draw_edit_and_save`, `test_resize_by_dragging_edge_and_move_with_shift` |
| 6 | One, several or all channels | `test_store.py::test_channel_scopes`; `test_gui.py::test_draw_edit_and_save` |
| 7 | Overlapping categories | `test_store.py::test_overlapping_different_categories_are_independent`; `test_gui.py::test_draw_edit_and_save` (drawn over an existing annotation) |
| 8 | Sample and time conversion | `test_timing.py::test_sample_time_round_trip` (11 sampling rates, indices up to 10⁹), `test_mne_round_trip_respects_first_samp` |
| 9 | Preservation of original events | `test_export.py::test_events_tsv_columns_and_original_rows_preserved` (byte-level), `test_vmrk_events_used_without_events_tsv` |
| 10 | Conflicting event codes | `test_export.py::test_code_collision_and_mapping_checks`, `test_collision_rows_distinguished_in_export`; `test_loading.py::test_event_code_collision_requires_policy` |
| 11 | Export of the 16 labels | `test_labels.py::test_catalogue_matches_specification_exactly`, `test_labels_exist_in_hed_score_2_2_0_snapshot`; `test_export.py::test_all_sixteen_labels_export_with_fixed_codes` |
| 12 | Round-trip export and import | `test_export.py::test_round_trip_tsv_and_json`, `test_written_canonical_file_reads_back`; `test_timing.py::test_mne_round_trip_respects_first_samp` |
| 13 | Repeated annotations of one category | `test_store.py::test_repeated_same_label_not_merged_unless_requested` |
| 14 | Missing or corrupted files | `test_loading.py::test_missing_companion_files_fail`, `test_truncated_data_file_fails`, `test_truncated_on_sample_boundary_detected_by_markers`, `test_corrupted_header_fails`, `test_malformed_events_tsv_fails`; `test_gui.py::test_failed_load_message_and_continue` |
| 15 | Output write failure | `test_session.py::test_write_failure_never_marks_complete` (6 stages), `test_register_failure_is_recovered_on_next_start`, `test_crash_recovery`; `test_integrity.py` (failed roll-backs retried, failures after the register update, relocated results folder, unreadable journals) |
| 16 | Per-annotator completion | `test_session.py::test_completion_is_per_annotator`; `test_gui.py::test_full_application_loop` |
| 17 | Duplicate processing and overwriting | `test_session.py::test_completed_recording_not_reopened_or_overwritten`, `test_simultaneous_sessions_blocked_by_lock`, `test_stale_lock_from_dead_process_is_broken`; `test_integrity.py` (recovery during another session's save, stale-lock race, clock skew, heartbeat, leftover outputs) |
| 18 | Inter-rater agreement on known examples | `test_reliability.py` (hand-computed 2×2 tables, kappa, Fleiss' kappa and alpha; comparison with reference implementations on random data; matching examples) |
| 19 | Absent annotations and clean intervals | `test_reliability.py::test_clean_recording_and_absent_annotations`, `test_time_resolved_two_raters`; `test_export.py::test_empty_annotation_set_exports_cleanly`; `test_gui.py::test_save_with_no_annotations_needs_confirmation` |
| 20 | Whole-montage and channel-specific | `test_reliability.py::test_whole_montage_versus_channel_specific`; `test_export.py::test_whole_montage_and_channel_encodings` |

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

## Checks that need a person

Automated tests cannot judge how the application feels or looks on each
system. Before a study, someone should check the following on each type of
computer that annotators will use:

1. The launcher starts ElectroClean on a fresh account (Windows: no console
   window stays open; macOS: the first-run confirmation appears and then the
   app opens).
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
