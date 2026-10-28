# File formats

All text files are UTF-8 with `\n` line endings. JSON files are written with
two-space indentation and never contain `NaN` (missing numbers are `null`).
Every output file is written to a temporary file, flushed to disk and moved
into place in one step, so a file is either complete or absent.

## Time and channel conventions (all files)

* **`onset`** is in seconds from the first sample stored in the recording's
  data file. This is the BIDS `events.tsv` convention and equals MNE's
  `raw.times`. For BrainVision, EDF and BDF files MNE reads the first sample
  as sample 0.
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
  An **empty list means the whole recording montage** (every channel that was
  shown, which is every channel in the recording except those the
  `channels.hide` setting hid and trigger channels such as BioSemi's Status)
  over the annotated interval. Selecting every channel explicitly
  is stored as the full list, so the annotator's choice is kept.

## Output folder

The results of a study are kept in this layout: in the study folder of an
ElectroClean server as each recording is saved, and for a study on Firebase in
the folder that `electroclean-web export` writes. Results folders of the
desktop application (version 1.1.0 and earlier) have the same layout.

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
    training_progress/<reference set>/annotator-A01.json   stars, scores and times in the programme
    interaction_logs/annotator-A01/<YYYYMMDDTHHMMSS>_<mode>.jsonl   one log per visit
    activity_reports/<date and time>/   tables and report made from the logs
    .electroclean/
        locks/          lock files of sessions and of the register
        staging/        saves in progress (normally empty)
        autosave/       unfinished work saved by the core's autosave (see below)
        interrupted/    files from saves that were interrupted and rolled back, and
                        autosaves that were not restored
```

The base name is the recording's file name without its extension (`.vhdr`,
`.edf` or `.bdf`) followed by
`_annotator-<ID>`. Files are never overwritten: if an administrator allows an
annotator to annotate a recording again, the new files get `_attempt-02`
(and so on) before the suffix.

## `…_events.tsv`

One row per original event, unchanged, and one row per artifact annotation,
in order of onset. Columns, in this order:

1. every column of the original `events.tsv`, in its original order (if the
   recording has no `events.tsv`, the BrainVision markers or the EDF+/BDF+
   annotations read by MNE are used, with columns `onset`, `duration`,
   `trial_type`, `value`, `sample`, `channels`; if it has neither, the
   triggers of its trigger channels are used, with columns `onset`,
   `duration` (`n/a`), `trial_type` (`n/a`), `value` (the trigger code),
   `sample` and `stim_channel`);
2. any of `onset`, `duration`, `trial_type`, `value`, `sample`, `channels`
   that the original lacked;
3. `artifact_code`, `event_source`, `annotation_id`, `annotator_id`,
   `original_row`.

| Column | Original event rows | Artifact rows |
|---|---|---|
| `onset` | original text | seconds, shortest exact decimal (`2.996`) |
| `duration` | original text | seconds |
| `trial_type` | original text | HED-SCORE label, e.g. `Eye-blink-artifact` |
| `value` | original text | `n/a` |
| `artifact_code` | `n/a` | fixed artifact code (100-121 for specific types, 130-136 for group terms) |
| `sample` | original text; computed from `onset` if the original had no `sample` column | `onset_sample` (also when the dataset uses `sample` for something else, such as a stimulus-software timestamp; `events.json` then says so) |
| `channels` | original text, or `n/a` | JSON array, e.g. `["Fp1","Fp2"]`; `[]` = whole montage |
| `event_source` | `original:events_tsv`, `original:brainvision_vmrk`, `original:edf_annotations`, `original:bdf_annotations` or `original:stim_channel` | `electroclean_artifact` |
| `annotation_id` | `n/a` | stable 32-character identifier |
| `annotator_id` | `n/a` | annotator ID |
| `original_row` | 1-based row number in the original file | `n/a` |

The original table can be rebuilt exactly by keeping the rows whose
`event_source` starts with `original:`, sorting them by `original_row` and
keeping the original columns. The annotations can be rebuilt exactly from the
artifact rows (see `electroclean.app.io.export.annotations_from_events_tsv`).

**Why artifact codes have their own column.** The `value` column belongs to
the dataset: it holds the marker codes of the recording system, which can be
any numbers, including 100 to 136. ElectroClean therefore never writes into
`value`; artifact rows leave it as `n/a` and carry their code in
`artifact_code`. An original event coded 101 and an ECG artifact (code 101)
can never be confused, codes stay the same in every dataset, and no setting is
needed. Original codes that happen to equal artifact codes, and original
events that already use HED-SCORE artifact names as `trial_type`, are noted in
the session file. Files written by ElectroClean 1.0 kept artifact codes in
`value`; `annotations_from_events_tsv` still reads them.

## `…_events.json`

The original `events.json` (with BIDS inheritance applied), plus:

* descriptions of `channels`, `artifact_code` (with a `Levels` entry for every
  code), `event_source`, `annotation_id`, `annotator_id` and `original_row`;
  the original description of `value` is kept unchanged; a column that
  ElectroClean adds because the original events lack it (often `value` or
  `sample`) is described by ElectroClean, even when the dataset's
  `events.json` describes a column of that name;
* `trial_type.Levels` and `trial_type.HED` entries for the 29 artifact terms,
  using HED tags such as `sc:Eye-blink-artifact` (declare
  `"HEDVersion": ["8.5.0", "sc:score_2.2.0"]` in `dataset_description.json` to
  validate them);
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
              "created_at": "2026-10-26T15:47:49.375+00:00", "app_version": "1.1.0", "context": {}},
  "time_conventions": {"onset_origin": "first_sample", "...": "..."},
  "channel_convention": {"empty_list_means": "The annotation applies to the whole recording montage ...", "...": "..."},
  "label_catalogue": {"catalogue_id": "electroclean-hed-score-artifacts", "catalogue_version": "2.0.0",
                      "sha256": "...", "hed_library": "score", "hed_library_version": "2.2.0",
                      "labels": [{"value": 103, "label": "Eye-blink-artifact", "kind": "specific",
                                  "parent": "Eye-artifact"}, "..."]},
  "n_annotations": 11,
  "annotations": [
    {"annotation_id": "f70bc89fe0bd420192ad932194bdad6d", "label": "Eye-blink-artifact", "value": 103,
     "onset": 2.996, "duration": 0.428, "onset_sample": 749, "duration_samples": 107, "end_sample": 856,
     "channels": ["Fp1", "Fp2", "VEOG"], "scope": "channels",
     "created_at": "...", "modified_at": "..."}
  ]
}
```

`ch_names` are the channels that were shown and could be annotated. When the
`channels.hide` setting hid channels of the recording, or the recording has
trigger channels, they are listed in `recording.hidden_channels` (the key is
absent otherwise). `fingerprint` has
the roles `vhdr`, `eeg` and `vmrk` for BrainVision and `eeg` alone for EDF and
BDF, followed by the BIDS sidecars.

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
| `recording` | Recording ID, `format` (`BrainVision`, `EDF` or `BDF`), `file` and the BrainVision file names (`vhdr`, `eeg`, `vmrk`, null for EDF and BDF), BIDS sidecars used, timing, channel names, `hidden_channels`, `trigger_channels` (the hidden channels that are trigger channels), `acquisition_gaps_samples` (stretches marked `BAD_ACQ_SKIP`, as [start, stop) samples), source fingerprints |
| `timing` | `session_opened`, `start_timestamp` (viewer ready), `finish_timestamp` (Save and Finish), `elapsed_seconds` (all the time spent on the recording, including earlier unfinished sessions; for work saved from the browser, the time the page measured while the recording was open), clock used, `elapsed_in_earlier_sessions_seconds` and `resumed_from_autosave` (the earlier sessions continued from an autosave) |
| `application` | ElectroClean version, platform, versions of Python, MNE, NumPy, SciPy, pandas and matplotlib; for work saved from the browser also `client` (`web`), the study's back end (`server`), the annotator's browser (`browser`: its user agent and screen) and a `note` saying that the recording never left the annotator's computer. Files written by the desktop application (version 1.1.0 and earlier) also list the versions of its display libraries. |
| `display` | `scalings` used (the study's, or for a type with an implausible amplitude the scale chosen for this recording), `amplitude_check` (the measured amplitude per channel type and any scale set automatically), and the amplitude factor, seconds and channels on screen at Save and Finish |
| `filters` | Selected settings, whether fixed by the administrator, and `design`. For work saved from the browser, `design` names the filters the browser applied for display (`applied_in`, `settings`); in files written by MNE-based loading (the desktop application, and scripts), it holds the exact MNE calls and parameters, filter lengths, MNE's own description of each filter, edge-transient duration, discontinuities filtered separately, channels filtered, the number of blocks of channels they were filtered in, and how the display data were stored |
| `annotations` | Counts in total, by label, whole-montage and channel-specific |
| `label_catalogue` | As in the annotations file |
| `original_events` | Source, the trigger channels read (when the events come from them), count, whether `sample` was computed, comparison of `events.tsv` with the marker file, the code check (original codes equal to artifact codes, artifact names used as `trial_type`, codes with several meanings) |
| `channel_check` | Comparison of the recording's channels with `channels.tsv` |
| `warnings`, `notes` | Everything shown with the recording's details (for work saved from the browser, the registration's findings and the browser's own) |
| `outputs` | Base name and file names |

## `completion_register.tsv`

| Column | Meaning |
|---|---|
| `recording_id` | Path of the recording file (`.vhdr`, `.edf` or `.bdf`) relative to the dataset folder |
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
  `inconsistent_recording`, `unsupported_format`, `no_channels`,
  `malformed_bids_metadata`, `filter_error`, `permission`, `memory`,
  `unexpected_error`), the size and modification time
  of every file of the recording, and the settings that caused the failure.
  Lines with `"event": "resolved"` lift a failure. Failures of the last four
  kinds may belong to one computer, so they only hold the recording back from
  the annotator who met them.
* `session_log.jsonl`: `session_started`, `session_completed`,
  `session_incomplete` (closed without saving), `export_failed`,
  `session_saved_register_pending`, `export_recovery`, `completion_recovered`
  and `leftover_outputs_moved` events. `session_incomplete` records whether
  the work was kept for later (`kept_for_later`).
* `interaction_logs/annotator-<ID>/<YYYYMMDDTHHMMSS>_<mode>.jsonl`: one log per
  visit of everything the annotator did (JSON Lines: a header, then one event
  per line). The format, every event kind and the tables made from the logs
  are described in [interaction logs](activity_logs.md).

## `electroclean_study.json` (a study's settings)

A study folder of the ElectroClean server keeps the study's settings in this
file, and so can a dataset folder, where `electroclean-admin` reads and writes
it. A study on Firebase keeps the same `settings` block in Firestore, given
with `electroclean-web init-study --settings` or changed in the admin area.

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
    "output": {"directory": "/shared/drive/Annotated_Events"},
    "discovery": {"suffixes": ["_eeg.vhdr", "_eeg.edf", "_eeg.bdf"]},
    "channels": {"hide": ["TIME_STAMP_*", "COUNTER", "CQ_*", "EQ_*"], "types": {"EXG*": "misc"}}
  },
  "training": {"reference_sets_dir": "derivatives/electroclean_reference_sets"},
  "admin_passphrase": {"algorithm": "pbkdf2_sha256", "iterations": 200000, "salt": "…", "hash": "…"}
}
```

`settings` may override any key of `electroclean/config/default_settings.json`;
the [administrator guide](administrator_guide.md) explains each one.
`electroclean-admin` validates the file before saving it. `annotators`,
`allow_unlisted_annotators`, `allocation.assignments` and `admin_passphrase`
were read by the desktop application only: in the browser, accounts and their
assignments take their place.

## `electroclean/config/artifact_labels.json`

The version-controlled list of the 29 permitted artifact terms (catalogue
2.0.0): every artifact term of HED SCORE 2.2.0. Each entry has its fixed code,
label, short code, display colour, `kind` (`specific` or `group`), `parent`
(the group term above it), `section` (the heading it is listed under) and the
schema's description. Codes are never changed or reused: 100-115 are the 16
types of catalogue 1.0.0, 116-121 the further specific types and 130-136 the
group terms. The order of the list is the order annotators see, with each
group term after its members.

The catalogue digest recorded in every output covers its identifier, version
and the (code, label) pairs only, so changing a colour does not make files
incompatible. Two catalogue versions are compatible when every label they
share has the same code; files made with compatible versions (for example
1.0.0 and 2.0.0) are analysed together with the larger catalogue.

## Autosave files (`.electroclean/autosave/<annotator>-<key>.json`)

Unfinished work, written by the core's `AnnotationSession` when its autosave is
on (the desktop application used it; the browser keeps drafts instead, in the
browser and with the study), every few seconds while a recording is open (only
when something changed, and at least once a minute while the timer runs):
`schema` (`electroclean.autosave`), `saved_at`, `session_id`, `elapsed_s` (all
time spent on the recording so far), `filters`, `previous_sessions`, the
`source_fingerprint` of the recording and the `document` in the canonical
annotations format. An autosave is never an output and never marks anything
complete. It is removed after Save and Finish or when the annotator discards
the work; one that no longer fits the recording, or that the annotator chose
not to restore, is moved to `.electroclean/interrupted/autosave/`.

## Reference set folder

```text
<reference_sets_dir>/<set_id>/
    reference_set.json
    references/<recording>_reference_annotations.json
    sources/<recording>/...    copies of the expert files used (with SHA-256 in reference_set.json)
```

`reference_set.json` holds `set_id`, `name`, `description`, `provenance`
(method `single_expert`, `consensus` or `adjudicated`, experts, notes), the
`recordings` (use `guided`, `practice` or `assessment`, reference file, its SHA-256,
per-recording provenance including the consensus rule), `criteria`
(competency criteria), optional `analysis` overrides, `quiz` items,
`practice_review`, the training programme's `guided` settings (tolerance and
the experts' notes), `practice_pass`, `recordings_dir` for a self-contained set,
`assigned_annotators`, and `show_full_report_to_annotator` (false by default; it
let the desktop application offer annotators the full report, while the browser
application shows them their result and the criteria only, and the full report
with the missed and extra artifacts is for the administrator; the older key
`quiz.show_report_to_annotator` is still read). A reference file whose checksum
no longer matches is refused.

## Competency report (`…_competency_report.json`)

Annotator, reference set and its declared provenance (with a `provenance_note`
saying that it was declared when the set was created), `reference_provenance`
(how each assessment reference was actually made: method, experts,
adjudicator, agreement rule, date added), required and missing recordings,
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
