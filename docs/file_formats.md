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
  `electrotag.app.annotations.mne_bridge` converts both ways.
* **Channels.** A list of channel names exactly as stored in the recording.
  An **empty list means the whole recording montage** (every channel that was
  shown, which is every channel in the recording except those the
  `channels.hide` setting hid and trigger channels such as BioSemi's Status)
  over the annotated interval. Selecting every channel explicitly
  is stored as the full list, so the annotator's choice is kept.

## Output folder

The results of a study are kept in this layout: in the study folder of an
ElectroTag server as each recording is saved, and for a study on Firebase in
the folder that `electrotag web export` writes. Results folders of the
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
    problem_reports/problem_reports.{tsv,json}   problems annotators reported (results zip and export)
    reviews/annotator-A01/<stem>_attempt-01_review-<time>-<id>.{tsv,json}   each review of saved work
    derived/corrections/                experts' corrections of saved work (below)
        completion_register.tsv
        session_log.jsonl
        annotator-A01/sub-001/eeg/sub-001_task-rest_eeg_annotator-A01[_attempt-02]_….{tsv,json,txt}
    derived/adjudications/              adjudicated versions of tasks, laid out the same way
    .electrotag/
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

`derived/` holds the versions made from someone's saved work: an expert's
correction (`derived/corrections/`) and the adjudicated version of a task
(`derived/adjudications/`). Each is a full save of the five files above, made
with the same journalled save, into a tree of its own with its own
`completion_register.tsv`, `session_log.jsonl` and `.electrotag/` folder, so
that it is never anyone's attempt or completion. A correction's files carry
the name of the person whose work it is (`annotator-A01`), and their attempt
number counts the corrections of that person's work on the recording. The
`_annotations.json` and `_session.json` of a derived version say where it
comes from in `session.context.derived` (its kind, who made it, and the saved
attempt it was made from). The originals are never changed, and the analyses
(`electrotag-agreement` and the admin area's) leave derived versions out.

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
   `original_row`, `confidence`, `annotation_note`.

| Column | Original event rows | Artifact rows |
|---|---|---|
| `onset` | original text | seconds, shortest exact decimal (`2.996`) |
| `duration` | original text | seconds |
| `trial_type` | original text | HED-SCORE label, e.g. `Eye-blink-artifact` |
| `value` | original text | `n/a` |
| `artifact_code` | `n/a` | fixed artifact code (100-121 for specific types, 130-136 for group terms) |
| `sample` | original text; computed from `onset` if the original had no `sample` column | `onset_sample` (also when the dataset uses `sample` for something else, such as a stimulus-software timestamp; `events.json` then says so) |
| `channels` | original text, or `n/a` | JSON array, e.g. `["Fp1","Fp2"]`; `[]` = whole montage |
| `event_source` | `original:events_tsv`, `original:brainvision_vmrk`, `original:edf_annotations`, `original:bdf_annotations` or `original:stim_channel` | `electrotag_artifact` |
| `annotation_id` | `n/a` | stable 32-character identifier |
| `annotator_id` | `n/a` | annotator ID |
| `original_row` | 1-based row number in the original file | `n/a` |
| `confidence` | `n/a` | the annotator's confidence on a 5-point scale, an integer from `1` (not at all confident) to `5` (completely confident); `n/a` when not rated |
| `annotation_note` | `n/a` | the annotator's note (one line, at most 200 characters), or `n/a` when there is none |

The original table can be rebuilt exactly by keeping the rows whose
`event_source` starts with `original:`, sorting them by `original_row` and
keeping the original columns. The annotations can be rebuilt exactly from the
artifact rows (see `electrotag.app.io.export.annotations_from_events_tsv`).

**Why artifact codes have their own column.** The `value` column belongs to
the dataset: it holds the marker codes of the recording system, which can be
any numbers, including 100 to 136. ElectroTag therefore never writes into
`value`; artifact rows leave it as `n/a` and carry their code in
`artifact_code`. An original event coded 101 and an ECG artifact (code 101)
can never be confused, codes stay the same in every dataset, and no setting is
needed. Original codes that happen to equal artifact codes, and original
events that already use HED-SCORE artifact names as `trial_type`, are noted in
the session file. Files written by ElectroTag 1.0 kept artifact codes in
`value`; `annotations_from_events_tsv` still reads them.

**Confidence and notes.** `confidence` is an ordinal 5-point Likert rating of
how confident the annotator was that the artifact is right: 1, not at all
confident; 2, slightly; 3, moderately; 4, very; 5, completely confident
(`events.json` gives these anchors as its `Levels`). No annotation starts with
a rating, so `n/a` on an artifact row means that it was not rated. In a study
whose `annotation.confidence` setting is `"optional"` (the default) annotators
rated a mark only when they wished, so the rated rows are a self-selected
subset; in a study set to `"every_mark"` they were asked to rate each new mark,
and `n/a` marks one they left unrated.
`events.json` says which applied, and so do the session and annotations files.
A note is never just the text `n/a`, which these columns keep for "none".
Files written before these columns existed are still read: their artifacts
count as having no confidence and no note.

## `…_events.json`

The original `events.json` (with BIDS inheritance applied), plus:

* descriptions of `channels`, `artifact_code` (with a `Levels` entry for every
  code), `event_source`, `annotation_id`, `annotator_id`, `original_row`,
  `confidence` (an ordinal 5-point scale, with its five anchors as `Levels`,
  and what `n/a` means under the study's setting) and `annotation_note`;
  the original description of `value` is kept unchanged; a column that
  ElectroTag adds because the original events lack it (often `value` or
  `sample`) is described by ElectroTag, even when the dataset's
  `events.json` describes a column of that name;
* `trial_type.Levels` and `trial_type.HED` entries for the 29 artifact terms,
  using HED tags such as `sc:Eye-blink-artifact` (declare
  `"HEDVersion": ["8.5.0", "sc:score_2.2.0"]` in `dataset_description.json` to
  validate them);
* `ElectroTagMetadata`: recording, annotator, session, time conventions,
  the label catalogue, the result of the event-code check and
  `confidence_setting` (`optional` or `every_mark`).

## `…_annotations.json` (canonical format)

```json
{
  "schema": "electrotag.annotations",
  "schema_version": "1.1.0",
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
              "created_at": "2026-10-26T15:47:49.375+00:00", "app_version": "1.1.0", "context": {},
              "confidence": "optional"},
  "time_conventions": {"onset_origin": "first_sample", "...": "..."},
  "channel_convention": {"empty_list_means": "The annotation applies to the whole recording montage ...", "...": "..."},
  "confidence_convention": {"scale": "Ordinal 5-point Likert scale ...", "levels": {"1": "Not at all confident", "...": "..."}, "not_rated": "null: ...", "settings": {"...": "..."}},
  "label_catalogue": {"catalogue_id": "electrotag-hed-score-artifacts", "catalogue_version": "2.0.0",
                      "sha256": "...", "hed_library": "score", "hed_library_version": "2.2.0",
                      "labels": [{"value": 103, "label": "Eye-blink-artifact", "kind": "specific",
                                  "parent": "Eye-artifact"}, "..."]},
  "n_annotations": 11,
  "annotations": [
    {"annotation_id": "f70bc89fe0bd420192ad932194bdad6d", "label": "Eye-blink-artifact", "value": 103,
     "onset": 2.996, "duration": 0.428, "onset_sample": 749, "duration_samples": 107, "end_sample": 856,
     "channels": ["Fp1", "Fp2", "VEOG"], "scope": "channels",
     "created_at": "...", "modified_at": "...", "confidence": 3, "note": "could be an eye movement"}
  ]
}
```

`ch_names` are the channels that were shown and could be annotated. When the
`channels.hide` setting hid channels of the recording, or the recording has
trigger channels, they are listed in `recording.hidden_channels` (the key is
absent otherwise). `fingerprint` has
the roles `vhdr`, `eeg` and `vmrk` for BrainVision and `eeg` alone for EDF and
BDF, followed by the BIDS sidecars.

Each annotation's `confidence` is an integer from 1 to 5 or `null` (not
rated), and its `note` is the annotator's note or `""`;
`session.confidence` is the study's `annotation.confidence` setting when the
annotations were made. Files of schema version 1.0.0 have none of these: their
annotations are read as having no confidence and no note, and the setting as
not recorded.

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
| `application` | ElectroTag version, platform, versions of Python, MNE, NumPy, SciPy, pandas and matplotlib; for work saved from the browser also `client` (`web`), the study's back end (`server`), the annotator's browser (`browser`: its user agent and screen) and a `note` saying that the recording never left the annotator's computer. Files written by the desktop application (version 1.1.0 and earlier) also list the versions of its display libraries. |
| `display` | `scalings` used (the study's, or for a type with an implausible amplitude the scale chosen for this recording), `amplitude_check` (the measured amplitude per channel type and any scale set automatically), and the amplitude factor, seconds and channels on screen at Save and Finish |
| `filters` | Selected settings, whether fixed by the administrator, and `design`. For work saved from the browser, `design` names the filters the browser applied for display (`applied_in`, `settings`); in files written by MNE-based loading (the desktop application, and scripts), it holds the exact MNE calls and parameters, filter lengths, MNE's own description of each filter, edge-transient duration, discontinuities filtered separately, channels filtered, the number of blocks of channels they were filtered in, and how the display data were stored |
| `annotations` | Counts in total, by label, whole-montage and channel-specific; `confidence` (the study's `setting`, `optional` or `every_mark`, what it means, the `scale` with its anchors, `n_given`, `n_not_given` and the counts `by_level`, `"1"` to `"5"`) and `n_with_note` |
| `label_catalogue` | As in the annotations file |
| `original_events` | Source, the trigger channels read (when the events come from them), count, whether `sample` was computed, comparison of `events.tsv` with the marker file, the code check (original codes equal to artifact codes, artifact names used as `trial_type`, codes with several meanings) |
| `channel_check` | Comparison of the recording's channels with `channels.tsv` |
| `warnings`, `notes` | Everything shown with the recording's details (for work saved from the browser, the registration's findings and the browser's own) |
| `outputs` | Base name and file names |

## Problem reports and reviews (results zip and export)

Problem reports and reviews of saved work are kept by the study (in the server's
database, or in Firestore) and written into the results when the admin area makes
the results zip or `electrotag web export` runs, as they stand at that moment.
They never change the annotation files.

`problem_reports/problem_reports.tsv` has a row for each report, the oldest
first, with the columns `problem_id`, `reported_at`, `annotator_id`,
`recording_id`, `file_name`, `mode`, `context_id`, `reason` (`file_wont_open`,
`wrong_recording`, `bad_channels`, `too_noisy` or `other`), `note` (up to 300
characters, `n/a` when none), `outcome` (`noted`: the annotator carried on;
`unusable`: the recording was set aside as one that cannot be annotated),
`where` (`home` or `annotate`), `item_status` (the assignment's status when
the report was made), `state` (`open` or `resolved`), `resolution`
(`resolved`, `returned` to the annotator's to-do list, or `reassigned`),
`resolution_note`, `resolved_at`, `resolved_by`, `reassigned_to` and
`unusable_now` (`yes` when the recording is still set aside for its
annotator). `problem_reports.json` holds the same reports as JSON
(`{"schema": "electrotag.problem_reports", "schema_version": 1, "reports": [...]}`).

Each review has two files below `reviews/annotator-<ID>/`, named after the
recording, the version reviewed, the time of the review and the first characters
of its ID. The JSON file is the review's record
(`"schema": "electrotag.review"`): `review_id`, `annotator_id`, `recording_id`,
`attempt` (the version reviewed), `output_basename` and `session_id` of that
version, `reviewer_id`, `reviewer_name`, `reviewed_at`, `overall_note`,
`counts` (`agree`, `caveat`, `comment` and `missed`, the comments on stretches
without an annotation) and `items`. Each item has `annotation_id` (null for a
stretch without an annotation), `label`, `onset_sample`, `duration_samples`,
`onset_s`, `offset_s`, `channels` (of the annotation as it was saved),
`status` (`agree`, `caveat` or `comment`) and `note`. The TSV file has a row for
each item with the columns `review_id`, `reviewed_at`, `reviewer_id`,
`annotator_id`, `recording_id`, `attempt`, `item` (its number), `annotation_id`,
`label`, `onset_sample`, `duration_samples`, `onset_s`, `offset_s`,
`channels`, `status` and `note`, and a last row with `item` and `status`
`overall` for the overall note. The agreement analyses do not read reviews.

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
| `app_version` | ElectroTag version |

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

## `electrotag_study.json` (a study's settings)

A study folder of the ElectroTag server keeps the study's settings in this
file, and so can a dataset folder, where `electrotag admin` reads and writes
it. A study on Firebase keeps the same `settings` block in Firestore, given
with `electrotag web init-study --settings` or changed in the admin area.

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
  "training": {"reference_sets_dir": "derivatives/electrotag_reference_sets"},
  "admin_passphrase": {"algorithm": "pbkdf2_sha256", "iterations": 200000, "salt": "…", "hash": "…"}
}
```

`settings` may override any key of `electrotag/config/default_settings.json`;
the [administrator guide](administrator_guide.md) explains each one, including
the blocks `review` (corrections and adjudication), `training` (which stages of
the training path may be skipped, and what real study work waits for) and
`replay` (who may watch replays of sessions).
`electrotag admin` validates the file before saving it. `annotators`,
`allow_unlisted_annotators`, `allocation.assignments` and `admin_passphrase`
were read by the desktop application only: in the browser, accounts and their
assignments take their place.

## `electrotag/config/artifact_labels.json`

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

## Autosave files (`.electrotag/autosave/<annotator>-<key>.json`)

Unfinished work, written by the core's `AnnotationSession` when its autosave is
on (the desktop application used it; the browser keeps drafts instead, in the
browser and with the study), every few seconds while a recording is open (only
when something changed, and at least once a minute while the timer runs):
`schema` (`electrotag.autosave`), `saved_at`, `session_id`, `elapsed_s` (all
time spent on the recording so far), `filters`, `previous_sessions`, the
`source_fingerprint` of the recording and the `document` in the canonical
annotations format. An autosave is never an output and never marks anything
complete. It is removed after Save and Finish or when the annotator discards
the work; one that no longer fits the recording, or that the annotator chose
not to restore, is moved to `.electrotag/interrupted/autosave/`.

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
| `analysis_settings.json` | Every setting, the label catalogue, input files with SHA-256, warnings, and the recordings chosen (`recording_ids`) and left out (`exclude_recording_ids`); `--config` reads it to repeat the analysis |
| `descriptives_recordings.tsv` | Recordings, durations, annotators |
| `descriptives_annotations_by_annotator.tsv` | Counts and durations per recording, annotator and category |
| `timeresolved_pairwise.tsv` | 2×2 tables and pairwise statistics per recording (and pooled), category, channel mode and representation |
| `timeresolved_multirater.tsv` | Fleiss' kappa, Krippendorff's alpha and mean pairwise kappa |
| `events_summary.tsv` | Event matching: counts, precision, recall, F1, IoU, channel overlap, boundary differences |
| `events_matched.tsv` | Every matched pair of events, with each one's confidence and note |
| `events_unmatched.tsv` | Every missed and extra event, with its confidence and note |
| `confidence_by_annotator.tsv` | Per annotator: the confidence setting, annotations rated, the count of each rating from 1 to 5, the median rating, and annotations with a note |
| `confidence_sensitivity.tsv` | When any mark was rated: positive agreement, Cohen's kappa (sample by sample, pooled) and event F1 per category, mode and pair, for all marks (`*_all`) and without the marks rated 1 or 2 (`*_without_low_confidence`; unrated marks kept) |
| `confidence_calibration.tsv` | When any mark was rated: per annotator (and all together) and rating, the marks and the share found by another annotator (a mark of the same type matching it, time only, at the main threshold) |
| `confusion_time_weighted.tsv` | Time where one annotator used one label and the other another |
