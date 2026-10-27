# Interaction logs and activity analysis

ElectroClean can keep a detailed, time-stamped record of how each annotator
uses it: every click, key press and shortcut, what was on screen, every change
to the annotations, the dialogs they saw and answered, and the periods when they
were idle or working in another program. The logs are research data. They make
it possible to describe the annotation process itself, for example how long
recordings take, whether annotators get faster over the course of a study, how
much of each recording they looked at, how often they undo, and how training
changes this.

This document describes what is recorded, the file format, and the tables and
report that `electroclean-activity` (or the *Activity and learning curves…*
button of the administrator tools) makes from the logs.

## Switching logging on and off

Logging is on by default. The study configuration controls it:

```json
{"settings": {"logging": {"interactions": true, "pointer_hz": 5, "idle_after_s": 30}}}
```

`interactions` switches the logs on or off for the study. `pointer_hz` is how
many times a second the position of the mouse pointer over the EEG is recorded
while it moves (0 records no pointer positions; clicks and keys are always
recorded). `idle_after_s` is how many seconds without any input count as idle
(see *Active time* below).

When logging is on, the start window tells annotators: "This study records how
you use ElectroClean (times, clicks, keys and what is on screen) for research."
Annotators must be told about the logs and agree to them under the study's
ethics approval; the administrator guide has a paragraph on this.

## What is never recorded

Characters typed into text fields are never recorded: for a search box or a
name field the log only says that the field was edited (and, for number boxes
such as the exact start and end of an annotation, the number chosen). Nothing at
all is recorded from password fields, including the administrator passphrase.
The annotator's display name is not in the logs; the annotator ID identifies
them within the study. The computer's name is not recorded either.

## Where the logs are

One log is written per visit, from pressing **Begin** on the start window until
the annotator goes back to the start window or quits:

```
<results folder>/interaction_logs/annotator-<ID>/<YYYYMMDDTHHMMSS>_<mode>.jsonl
```

for example `Annotated_Events/interaction_logs/annotator-A01/20261027T140311_standard.jsonl`.
The analyses of annotations (agreement, competency) never read these files.

## File format

Each log is a [JSON Lines](https://jsonlines.org/) file: one JSON object per
line. Lines are written as they happen, so a log survives a crash up to its last
event; the last line may then be cut short, which the analysis reports and skips.

The **first line** is the header: `type` (`"header"`), `schema`
(`"electroclean.interaction_log"`), `schema_version` (`"1.0.0"`), `started_at`
(local time with its UTC offset), `visit_id`, `annotator_id`, `mode`
(`standard`, `practice` or `assessment`), `context_id` and `reference_set` (for
training), `assessment_kind`, `dataset_root`, `output_root`, `study_id`,
`versions` (ElectroClean, MNE-Python, mne-qt-browser, Qt binding and version,
Python), `os`, `screens` (each screen's name, geometry, available area, device
pixel ratio and dots per inch), `settings_sha256` (a checksum of the study
settings in force), `filters` (the default viewing filters) and `logging` (the
pointer rate and idle threshold).

**Every other line** is an event with these fields, followed by the event's own:

| Field | Meaning |
|---|---|
| `seq` | Event number within the visit (1, 2, ...). |
| `t` | Seconds since the visit started, on a monotonic clock (unaffected by changes to the computer's clock). |
| `wall` | Local date and time with its UTC offset. |
| `type` | The kind of event (below). |
| `recording` | The recording open in the annotation window, while one is open. |
| `window_no` | Number of the annotation window within the visit (1, 2, ...), while one is open. |

### Event kinds

**The visit.** `visit_started` (mode, whether the annotator chose the
recording, reference set); `log_closed` (`reason`: `back_to_start`, `quit`,
`exit`, `new_visit` or `quiz_not_started`); `error` (an unexpected error, with
its details); `log_problem` (something the logger itself could not record).

**Recordings.** `recording_loading` (`recording_id`); `recording_opened`
(`session_id`, which is also in the recording's `_session.json`, `mode`,
`duration_s`, `sfreq`, `n_samples`, `n_channels_shown`, `n_channels_hidden`,
`format`, `filters` and `filter_settings`, `original_events`, `resumed`,
`annotations_restored`, `window_px`); `viewer_ready` (the viewer is on screen and
the clock starts); `autosave` (`n_annotations`); `recording_finished`
(`session_id`, `n_annotations`, `counts_by_label`, `elapsed_s` as measured by the
session clock); `closed_without_saving` (`n_annotations`); `load_failed`
(`recording_id`, `kind`, `reason`); `recording_unavailable` (`recording_id`,
`reason`).

**Mouse and keys.** `mouse_press`, `mouse_release` and `double_click` (`button`,
`modifiers`, the `widget` class, its `name` and `text` where it has them, the
`top_window`, the position `x` and `y` in that window, and for lists and tables
the `row`, `column` and the `item`'s text). On the EEG they also have `area`
(`eeg`, `channel_names` or `axes`), `eeg_t` (the time under the pointer, in
seconds) and `eeg_channel` (the channel under it); a release on the EEG has
`drag_px`, the distance from the press. On the overview bar they have
`overview_t`. `wheel` (`dx`, `dy` and, on the EEG, the time and channel under
the pointer). `key` (`key`, `modifiers`, `widget`, `auto_repeat` for repeats
while a key is held down; keys pressed on their own such as Shift are not
counted). `shortcut` (`key` and the `action` it triggered, for example
`Type 3: EMG-artifact`, `Mark start, then end`, `Next annotation`, `Undo`).
`field_edited` (a text or number field was changed: its `widget`, `name`,
`placeholder`, window `title`, and for number fields the `value`).
`pointer` (sampled while the pointer moves over the EEG: `eeg_t`,
`eeg_channel`, `area` and `dist_px`, the distance travelled since the previous
sample).

**What is on screen.** `view`, logged once scrolling, zooming or scaling has
settled for a quarter of a second: `t_start` and `duration` (the time shown, in
seconds), `ch_start` and `n_channels` (the channels shown), `first_channel` and
`last_channel`, `scale_factor` (the amplitude scale, 1 at the start) and
`butterfly`. `status_message` (`text` shown in the status bar).
`window_activated` and `window_deactivated` (`top_window`, `title`).
`app_state` (`state`: `active`, `inactive`, `hidden` or `suspended`).
`idle_start` (`last_input_t`, `after_s`) and `idle_end` (`idle_s`).

**Dialogs.** `dialog_shown` (`dialog` class, `title`; for messages also the
`text`, `informative` text and the `buttons` offered) and `dialog_closed`
(`accepted`, the `button` clicked, the `chosen` type in the type picker, the
`channels` chosen in the channel chooser).

**The annotation window's state.** `state` (only what changed:
`current_label`, `scope`, `selected_channels`, `drawing_enabled`,
`mark_start_s`) and `selection` (`annotation_id`, `label`). Both carry `via`
(below).

**Annotations.** `annotation_created`, `annotation_deleted`,
`annotation_edited` (start or end), `annotation_channels_changed` and
`annotation_relabelled` carry `annotations` (each with `id`, `label`,
`onset_s`, `offset_s`, `channels`, `n_channels`), `before` (the previous state,
for changes), `description`, `n_total` (annotations afterwards) and `via`; an
annotation that was merged automatically with an overlapping one of the same
type has `auto_merged` and `merged_away`. `undo`, `redo`,
`annotations_merged` and `annotations_reset` carry `added`, `removed` and
`changed`.

`via` says which input caused a change, when one happened in the three seconds
before it: `eeg_drag`, `eeg_click` or `eeg_double_click` (on the EEG),
`shortcut:<action>`, `key:<key>`, `button:<text>`, `menu:<text>`,
`list:<name>`, `dialog:<title>`, or `unknown`.

**Quiz.** `quiz_item_shown` (`item_id`, `index`, `n_items`, `quiz_mode`),
`quiz_answer` (`item_id`, `answer`, `correct`, `response_time_s`) and
`quiz_finished` (`n_items`, `n_correct`, `proportion_correct`).

**Training.** The guided training records its own events in the same log, with
names starting `guided_`, `practice_`, `assessment_` or `training_`; the
analysis summarises `guided_check`, `guided_show_me`, `guided_step_completed`
(`attempts`, `stars`, `seconds`, `used_show_me`) and `practice_scored`
(`event_f1`). Kinds the analysis does not know are kept in the events table.

## Making the tables and the report

From the administrator tools: open *Progress and reports* and press
**Activity and learning curves…** (type an annotator ID first to look at one
annotator). From a terminal:

```
electroclean-activity "path/to/Annotated_Events"
electroclean-activity "path/to/Annotated_Events" --annotator A01 --events --out activity
```

Both write to `activity_reports/<date and time>/` in the results folder unless
`--out` is given: `visits.tsv`, `recordings.tsv`, `events.tsv` (with
`--events`: every event, with its own fields as JSON in a `data` column),
`about_these_tables.txt` (what every column means) and `activity_report.html`.

The report opens with the number of annotators, visits, finished recordings,
active hours and annotations saved. Learning curves follow: active minutes per
finished recording, seconds per annotation, and the training score where there
is one, each against the order in which the annotator did their recordings, one
line per annotator with the median across annotators as a grey band (with more
than eight annotators every line is grey and the median carries the colour).
Holding the pointer over a chart shows the values at that recording. A table
then compares each annotator's first finished recordings with their last ones,
and the last table lists every row.

### Active time

The time between two inputs (mouse, wheel, keys and pointer movement over the
EEG) counts in full up to `idle_after_s` seconds; a longer gap counts only its
first `idle_after_s` seconds. Time while ElectroClean was not the active
application (another program in front) does not count. Opening and closing the
recording count as inputs, so a recording's active time is never longer than its
wall-clock time. `idle_s` is the rest of the wall-clock time.

### visits.tsv

| Column | Meaning |
|---|---|
| `visit_id` | Identifier of the visit (one log file: from Begin until the start window or quitting). |
| `annotator_id` | The annotator's ID. |
| `mode` | standard, practice, assessment (or a training mode). |
| `context_id` | Reference set of a training visit (empty for standard annotation). |
| `file` | The log file. |
| `started_at` | Local date and time the visit started, with its UTC offset. |
| `ended` | How the visit ended: back_to_start, quit, exit, new_visit, or 'not closed' after a crash. |
| `wall_s` | Seconds from the start of the visit to its last event. |
| `active_s` | Active seconds in the visit (see 'Active time'). |
| `recordings_opened` | Recording windows opened. |
| `recordings_finished` | Recordings saved with Save and Finish. |
| `recordings_closed_without_saving` | Recording windows closed without saving. |
| `annotations_saved` | Annotations in the recordings saved during the visit. |
| `clicks` | Mouse button presses anywhere in ElectroClean. |
| `key_presses` | Key presses (not counting held-down repeats or keys typed into text fields). |
| `shortcuts` | Keyboard shortcuts used (for example 1 to 9, M, N, Delete, Ctrl+Z). |
| `events` | Events in the log. |
| `bad_lines` | Lines that could not be read (usually the last line after a crash). |
| `electroclean_version` | ElectroClean version. |
| `os` | Operating system. |
| `screen` | Size of the primary screen in pixels (width x height). |
| `device_pixel_ratio` | Pixel ratio of the primary screen (2 on most high-resolution screens). |

### recordings.tsv

One row per annotator, recording and visit. A recording annotated over two
visits (continued from an autosave) has two rows, the second with `resumed`
true. Quiz answers form a row with `recording` set to `quiz`, and training
events that happened outside an annotation window a row with `segment` set to
`training`.

| Column | Meaning |
|---|---|
| `annotator_id` | The annotator's ID. |
| `visit_id` | The visit (see visits.tsv). |
| `mode` | standard, practice, assessment (or a training mode). |
| `context_id` | Reference set of training work (empty for standard annotation). |
| `recording` | Recording ID (path relative to the dataset); 'quiz' for the short-segment quiz. |
| `segment` | recording (an annotation window), quiz, or training (training events outside a window). |
| `window_no` | Number of the annotation window within the visit (1, 2, ...). |
| `order` | Position among all of this annotator's rows, in the order they were started (1 = first). |
| `order_in_mode` | The same, counting only rows of the same mode. |
| `started_at` | Local date and time the window opened, with its UTC offset. |
| `outcome` | finished (Save and Finish), closed_without_saving, or not_finished (the log ended first). |
| `resumed` | True if unfinished work from an earlier visit was restored. |
| `recording_duration_s` | Length of the recording in seconds. |
| `n_channels_shown` | Channels shown in the viewer. |
| `wall_s` | Seconds from opening the window to finishing or closing it. |
| `active_s` | Active seconds (see 'Active time'). |
| `inactive_s` | Seconds while ElectroClean was not the active application. |
| `idle_s` | Seconds without input beyond the idle threshold (wall_s minus active_s and inactive_s). |
| `idle_periods` | Number of idle periods logged. |
| `clicks` | Mouse button presses. |
| `eeg_clicks` | Mouse button presses on the EEG traces. |
| `double_clicks` | Double-clicks. |
| `wheel_turns` | Mouse wheel or trackpad scroll events. |
| `key_presses` | Key presses (not counting held-down repeats or keys typed into text fields). |
| `key_repeats` | Repeats while a key was held down. |
| `shortcuts` | Keyboard shortcuts used. |
| `shortcuts_by_name` | Each shortcut used and how often (JSON). |
| `keys_by_name` | Each key pressed (outside shortcuts and text fields) and how often (JSON). |
| `annotations_created` | Annotations created (by dragging, keys or otherwise). |
| `created_by_drag` | Annotations created by dragging across the EEG. |
| `created_by_keys` | Annotations created with the M, [ and ] keys. |
| `annotations_deleted` | Annotations deleted. |
| `annotations_edited` | Changes of start, end or channels. |
| `annotations_relabelled` | Changes of artifact type. |
| `annotations_merged` | Merges (by the Merge button or automatically when same-type annotations overlapped). |
| `undos` | Undo steps. |
| `redos` | Redo steps. |
| `final_annotations` | Annotations when the recording was saved (or when the window closed). |
| `time_to_first_annotation_s` | Seconds from the viewer being ready to the first annotation. |
| `seconds_per_annotation` | active_s divided by final_annotations (empty when there are none). |
| `annotations_per_active_minute` | annotations_created per active minute. |
| `share_seen` | Proportion of the recording's time that was on screen at some point (0 to 1). |
| `share_channels_seen` | Proportion of the channels that were on screen at some point (0 to 1). |
| `screens_viewed` | Number of different views (after scrolling, zooming or scaling settled). |
| `mean_dwell_s` | active_s divided by screens_viewed. |
| `scale_changes` | Changes of the amplitude scale. |
| `pointer_samples` | Pointer positions sampled over the EEG. |
| `pointer_distance_px` | Distance the pointer travelled over the EEG, in screen pixels. |
| `dialogs` | Dialogs shown (questions, channel chooser, type picker and so on). |
| `status_messages` | Messages shown in the status bar. |
| `guided_steps` | Guided training: steps completed. |
| `guided_attempts` | Guided training: attempts at the steps. |
| `guided_show_me` | Guided training: times the expert's answer was shown. |
| `guided_stars_mean` | Guided training: mean stars per completed step. |
| `guided_seconds_per_step` | Guided training: mean seconds per completed step. |
| `practice_score` | Practice: the score against the reference (event F1 when given). |
| `quiz_items` | Quiz: items answered. |
| `quiz_correct` | Quiz: correct answers. |
| `quiz_proportion_correct` | Quiz: proportion correct. |
| `quiz_mean_response_s` | Quiz: mean seconds from showing a segment to answering. |
| `score` | practice_score if there is one, otherwise quiz_proportion_correct. |

## Analysing the tables

The tables are plain tab-separated text in UTF-8 and read directly into R or
Python. Empty cells are missing values (for example seconds per annotation in a
recording without annotations).

In Python:

```python
import pandas as pd

rec = pd.read_csv("recordings.tsv", sep="\t")
done = rec[(rec.segment == "recording") & (rec.outcome == "finished")]
# Seconds per annotation over each annotator's recordings, in the order they did them.
curves = done.pivot_table(index="order", columns="annotator_id", values="seconds_per_annotation")
print(curves.round(1))
```

In R:

```r
rec <- read.delim("recordings.tsv")
done <- subset(rec, segment == "recording" & outcome == "finished" & !is.na(seconds_per_annotation))
# A log-linear learning curve per annotator: does the time per annotation fall with practice?
fit <- lm(log(seconds_per_annotation) ~ log(order) * annotator_id, data = done)
summary(fit)
```

With many annotators a mixed model (for example with `lme4`, annotators as a
random effect) describes the typical curve and how much annotators differ.
Order counts each annotator's rows across visits and modes; use
`order_in_mode` to count, say, only standard annotation. To relate the logs to
the annotations themselves, `session_id` in `recording_opened` (in
`events.tsv`) matches `session_id` in each recording's `_session.json`.

The events table has one row per event (with `--events`); its `data` column
holds the event's own fields as JSON, which `json.loads` in Python and
`jsonlite::fromJSON` in R read.
