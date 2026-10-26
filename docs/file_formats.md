# File formats

All text files are UTF-8 with `\n` line endings. JSON files are written with
two-space indentation and never contain `NaN` (missing numbers are `null`).
Every output file is written to a temporary file, flushed to disk and moved
into place in one step, so a file is either complete or absent.

## Time and channel conventions (all files)

* **`onset`** is in seconds from the first sample stored in the recording's
  data file. This is the BIDS `events.tsv` convention and equals MNE's
  `raw.times`. For BrainVision files MNE always reads the first sample as
  sample 0.
* **`sample`** is a 0-based index into the data file:
  `sample = onset × sampling frequency`.
* An annotation covers the half-open sample range
  `[onset_sample, onset_sample + duration_samples)`. Boundaries drawn with the
  mouse are snapped to the nearest sample, so onset and sample are always
  consistent and convert back exactly. The test-suite checks this for
  sampling rates from 100 Hz to 5 kHz and sample indices up to 10⁹.
* In `mne.Annotations` attached to a `Raw` object, MNE stores
  `onset + first_samp / sfreq` relative to the measurement date;
  `electroclean.app.annotations.mne_bridge` converts both ways.
* **Channels.** A list of channel names exactly as stored in the recording.
  An **empty list means the whole recording montage** (every channel in the
  recording) over the annotated interval. Selecting every channel explicitly
  is stored as the full list, so the annotator's choice is kept.

## Output folder

```text
Annotated_Events/
    completion_register.tsv
    failed_load.txt
    failure_log.jsonl
    session_log.jsonl
    annotator-A01/
        completed_datasets.txt
        sub-001/eeg/                      (mirrors the recording's folder)
            sub-001_task-rest_eeg_annotator-A01_events.tsv
            sub-001_task-rest_eeg_annotator-A01_events.json
            sub-001_task-rest_eeg_annotator-A01_annotations.json
            sub-001_task-rest_eeg_annotator-A01_time_viewed.txt
            sub-001_task-rest_eeg_annotator-A01_session.json
    training/<reference set>/practice/annotator-A01/...
    training/<reference set>/assessment/annotator-A01/...
    training/<reference set>/reports/annotator-A01_competency_report.{json,html}
    training/<reference set>/quiz/annotator-A01_quiz_<mode>_<session>.json
    .electroclean/
        locks/          lock files of open sessions and of the register
        staging/        saves in progress (normally empty)
        interrupted/    files from saves that were interrupted and rolled back
```

The base name is the recording's file name without `.vhdr` followed by
`_annotator-<ID>`. Files are never overwritten: if an administrator allows an
annotator to annotate a recording again, the new files get `_attempt-02`
(and so on) before the suffix.

## `…_events.tsv`

One row per original event, unchanged, and one row per artifact annotation,
in order of onset. Columns, in this order:

1. every column of the original `events.tsv`, in its original order (if the
   recording has no `events.tsv`, the BrainVision markers read by MNE are
   used, with columns `onset`, `duration`, `trial_type`, `value`, `sample`,
   `channels`);
2. any of `onset`, `duration`, `trial_type`, `value`, `sample`, `channels`
   that the original lacked;
3. `event_source`, `annotation_id`, `annotator_id`, `original_row`.

| Column | Original event rows | Artifact rows |
|---|---|---|
| `onset` | original text | seconds, shortest exact decimal (`2.996`) |
| `duration` | original text | seconds |
| `trial_type` | original text | HED-SCORE label, e.g. `Eye-blink-artifact` |
| `value` | original text | fixed code 100-115 |
| `sample` | original text; computed from `onset` if the original had no `sample` column | `onset_sample` |
| `channels` | original text, or `n/a` | JSON array, e.g. `["Fp1","Fp2"]`; `[]` = whole montage |
| `event_source` | `original:events_tsv` or `original:brainvision_vmrk` | `electroclean_artifact` |
| `annotation_id` | `n/a` | stable 32-character identifier |
| `annotator_id` | `n/a` | annotator ID |
| `original_row` | 1-based row number in the original file | `n/a` |

The original table can be rebuilt exactly by keeping the rows whose
`event_source` starts with `original:`, sorting them by `original_row` and
keeping the original columns. The annotations can be rebuilt exactly from the
artifact rows (see `electroclean.app.io.export.annotations_from_events_tsv`).

**Event codes 100-115 in original events.** If any original event uses one
of the artifact codes, or uses an artifact label as its `trial_type`, the
recording cannot be opened until the administrator chooses a policy
(`events.collision_policy`). With `preserve_and_flag`, original codes stay
unchanged, `event_source` tells the rows apart, and the sidecar marks the
code as ambiguous. Nothing is ever renumbered.

## `…_events.json`

The original `events.json` (with BIDS inheritance applied), plus:

* descriptions of `channels`, `event_source`, `annotation_id`, `annotator_id`
  and `original_row`;
* `trial_type.Levels` and `trial_type.HED` entries for the 16 labels, using
  HED tags such as `sc:Eye-blink-artifact` (declare
  `"HEDVersion": ["8.5.0", "sc:score_2.2.0"]` in `dataset_description.json` to
  validate them);
* `value.Levels` entries for codes 100-115 (or an "ambiguous code" note when
  an original event uses the same code);
* `ElectroCleanMetadata`: recording, annotator, session, time conventions,
  the label catalogue and the result of the event-code check.

## `…_annotations.json` (canonical format)

```json
{
  "schema": "electroclean.annotations",
  "schema_version": "1.0.0",
  "recording": {
    "recording_id": "sub-001/eeg/sub-001_task-rest_eeg.vhdr",
    "relative_path": "sub-001/eeg/sub-001_task-rest_eeg.vhdr",
    "sfreq": 250.0, "n_samples": 15000, "first_samp": 0,
    "meas_date": "2024-01-01T12:00:00+00:00", "duration_s": 60.0,
    "ch_names": ["Fp1", "Fp2", "..."],
    "fingerprint": {"eeg": {"path": "...", "size": 1260000, "mtime_ns": 0, "sha256": "..."}, "...": {}}
  },
  "annotator": {"annotator_id": "A01", "display_name": "Demo A01"},
  "session": {"session_id": "20261026T154749Z-e6797cfe", "mode": "standard",
              "created_at": "2026-10-26T15:47:49.375+00:00", "app_version": "1.0.0", "context": {}},
  "time_conventions": {"onset_origin": "first_sample", "...": "..."},
  "channel_convention": {"empty_list_means": "The annotation applies to the whole recording montage ...", "...": "..."},
  "label_catalogue": {"catalogue_id": "electroclean-hed-score-artifacts", "catalogue_version": "1.0.0",
                      "sha256": "...", "hed_library": "score", "hed_library_version": "2.2.0",
                      "labels": [{"value": 100, "label": "Chewing-artifact"}, "..."]},
  "n_annotations": 11,
  "annotations": [
    {"annotation_id": "f70bc89fe0bd420192ad932194bdad6d", "label": "Eye-blink-artifact", "value": 103,
     "onset": 2.996, "duration": 0.428, "onset_sample": 749, "duration_samples": 107, "end_sample": 856,
     "channels": ["Fp1", "Fp2", "VEOG"], "scope": "channels",
     "created_at": "...", "modified_at": "..."}
  ]
}
```

When the file is read, the sample fields are authoritative; the seconds must
agree with them to within half a sample, the `value` must match the label,
`n_annotations` must match and the catalogue digest must match its label
list, otherwise the file is rejected. `fingerprint` records the size,
modification time and SHA-256 of every source file at the time of
annotation. Reference annotations use the same format with annotator
`REFERENCE`, mode `reference` and the provenance in `session.context`.

## `…_time_viewed.txt`

A single number: seconds spent annotating, to the nearest millisecond, e.g.
`512.348`.

## `…_session.json`

| Key | Contents |
|---|---|
| `session_id`, `mode`, `context` | Session identity, mode and (for training) reference set |
| `annotator` | ID and display name |
| `recording` | Recording ID, file names, BIDS sidecars used, timing, channel names, source fingerprints |
| `timing` | `session_opened`, `start_timestamp` (viewer ready), `finish_timestamp` (Save and Finish), `elapsed_seconds`, clock used |
| `application` | ElectroClean version, platform, versions of Python, MNE, mne-qt-browser, NumPy, SciPy, pandas, PySide6, pyqtgraph, matplotlib |
| `filters` | Selected settings, whether fixed by the administrator, and `design`: the exact MNE calls and parameters, filter lengths, MNE's own description of each filter, edge-transient duration, discontinuities filtered separately, channels filtered and how the display data were stored |
| `annotations` | Counts in total, by label, whole-montage and channel-specific |
| `label_catalogue` | As in the annotations file |
| `original_events` | Source, count, whether `sample` was computed, comparison of `events.tsv` with the marker file, event-code check |
| `channel_check` | Comparison of the recording's channels with `channels.tsv` |
| `warnings`, `notes` | Everything shown in the viewer's *Recording* panel |
| `outputs` | Base name and file names |

## `completion_register.tsv`

| Column | Meaning |
|---|---|
| `recording_id` | Path of the `.vhdr` file relative to the dataset folder |
| `annotator_id` | Annotator |
| `mode` | `standard`, `practice` or `assessment` |
| `context` | Reference set ID for training modes, empty otherwise |
| `status` | `completed` |
| `session_id`, `completed_at`, `elapsed_s`, `n_annotations` | Session details |
| `output_dir`, `output_basename` | Where the five files are |
| `app_version` | ElectroClean version |

Rows are only added after the outputs are verified. Updates hold a lock and
replace the file atomically. `annotator-<ID>/completed_datasets.txt` lists the
recording IDs completed in standard mode by that annotator, one per line
(the format proposed originally, kept per annotator).

## Logs

* `failed_load.txt`: one line per failure: time stamp, recording ID and message,
  separated by tabs.
* `failure_log.jsonl`: one JSON object per line with the same information,
  the failure kind (`missing_companion`, `corrupt_recording`,
  `inconsistent_recording`, `malformed_bids_metadata`, `event_code_collision`,
  `filter_error`, `permission`), the size and modification time of every
  file of the recording, and the settings that caused the failure. Lines with
  `"event": "resolved"` lift a failure.
* `session_log.jsonl`: `session_started`, `session_completed`,
  `session_incomplete` (closed without saving), `export_failed`,
  `session_saved_register_pending` and `export_recovery` events.

## `electroclean_study.json` (optional, in the dataset folder)

```json
{
  "study_id": "pilot-2026",
  "annotators": [{"annotator_id": "A01", "display_name": "First annotator"},
                 {"annotator_id": "CAM", "display_name": "Cameron"}],
  "allow_unlisted_annotators": false,
  "allocation": {"strategy": "manual", "seed": 7,
                 "assignments": {"A01": ["sub-001/eeg/sub-001_task-rest_eeg.vhdr"]}},
  "settings": {
    "filters": {"highpass_enabled": true, "highpass_hz": 1.0, "notch_enabled": true, "notch_hz": 50.0,
                "method": "fir", "locked": true},
    "events": {"collision_policy": "preserve_and_flag"},
    "output": {"directory": "/shared/drive/Annotated_Events"}
  },
  "training": {"reference_sets_dir": "derivatives/electroclean_reference_sets"},
  "admin_passphrase": {"algorithm": "pbkdf2_sha256", "iterations": 200000, "salt": "…", "hash": "…"}
}
```

`settings` may override any key of `electroclean/config/default_settings.json`.
The administrator tools edit this file and validate it before saving.

## `electroclean/config/artifact_labels.json`

The version-controlled list of the 16 permitted labels with their fixed
codes, short codes and display colours. The catalogue digest recorded in every
output covers its identifier, version and the (code, label) pairs only, so
changing a colour does not make files incompatible, while changing a code or
label does.

## Reference set folder

```text
<reference_sets_dir>/<set_id>/
    reference_set.json
    references/<recording>_reference_annotations.json
    sources/<recording>/...    copies of the expert files used (with SHA-256 in reference_set.json)
```

`reference_set.json` holds `set_id`, `name`, `description`, `provenance`
(method `single_expert`, `consensus` or `adjudicated`, experts, notes), the
`recordings` (use `practice` or `assessment`, reference file, its SHA-256,
per-recording provenance including the consensus rule), `criteria`
(competency criteria), optional `analysis` overrides, `quiz` items and
`practice_review`. A reference file whose checksum no longer matches is
refused.

## Competency report (`…_competency_report.json`)

Annotator, reference set and provenance, required and missing recordings,
criteria, `status` (`met`, `not_met`, `not_determined`, `incomplete`), the
individual `checks`, all `metrics` (overall, per category, missed, extra and
relabelled artifacts), the SHA-256 of every input file, the software version
and `results_sha256`, a digest of the results that is identical whenever the
report is regenerated from the same inputs.

## Agreement analysis outputs

| File | Contents |
|---|---|
| `agreement_report.html` | Readable report with figures |
| `analysis_settings.json` | Every setting, the label catalogue, input files with SHA-256, warnings |
| `descriptives_recordings.tsv` | Recordings, durations, annotators |
| `descriptives_annotations_by_annotator.tsv` | Counts and durations per recording, annotator and category |
| `timeresolved_pairwise.tsv` | 2×2 tables and pairwise statistics per recording (and pooled), category, channel mode and representation |
| `timeresolved_multirater.tsv` | Fleiss' kappa, Krippendorff's alpha and mean pairwise kappa |
| `events_summary.tsv` | Event matching: counts, precision, recall, F1, IoU, channel overlap, boundary differences |
| `events_matched.tsv` | Every matched pair of events |
| `events_unmatched.tsv` | Every missed and extra event |
| `confusion_time_weighted.tsv` | Time where one annotator used one label and the other another |
