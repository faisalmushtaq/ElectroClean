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
report that `electroclean-activity` and the admin area ([web/admin.md](web/admin.md))
make from the logs. The logs are recorded by the browser application, which
sends them to the study in batches; the desktop application (version 1.1.0 and
earlier) wrote logs in the same format, and the analysis reads both.

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

When logging is on, annotators are told after they sign in: "This study
records how you use ElectroClean (times, clicks, keys and what is on screen) for
research. Ask your study administrator if you have questions." Annotators must
be told about the logs and agree to them under the study's ethics approval; the
administrator guide has a paragraph on this.

## What is never recorded

Characters typed into text fields are never recorded: key presses in a text
field are left out, and for a search box or a name field the log only says that
the field was edited (and, for number boxes such as the exact start and end of
an annotation, the number chosen). Nothing at all is recorded from password
fields. The annotator's display name is not in the logs; the annotator ID
identifies them within the study. The computer's name is not recorded either.

## Where the logs are

One log is kept per visit, from signing in until signing out or closing the
page (in the desktop application, from pressing **Begin** on the start window
until going back to it or quitting). The ElectroClean server writes each
visit's log into the study's results as the events arrive; a study on Firebase
keeps the events in Firestore, and `electroclean-web export` writes the same
files:

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
(`standard`, `guided`, `practice` or `assessment`), `context_id` and
`reference_set` (for training), `programme` (true for the training programme),
`assessment_kind`, `study_id`, `versions` (ElectroClean, Python, the study's
back end and the browser's user agent), `os`, `screens` (the screen's width,
height and device pixel ratio), `settings_sha256` (a checksum of the study
settings in force), `filters` (the default viewing filters), `logging` (the
pointer rate and idle threshold), `client` (`"web"`) and `browser` (what the
page reported about itself: the back end, user agent, screen and window size).
`dataset_root` and `output_root` are empty for visits in the browser. Logs of
the desktop application have the same header with the desktop's own
`versions`, `os` and `screens`.

**Every other line** is an event with these fields, followed by the event's own:

| Field | Meaning |
|---|---|
| `seq` | Event number within the visit (1, 2, ...). |
| `t` | Seconds since the visit started, on a monotonic clock (unaffected by changes to the computer's clock). |
| `wall` | Local date and time with its UTC offset. |
| `type` | The kind of event (below). |
| `recording` | The recording open for annotation, while one is open. |
| `window_no` | Number of the recording opened within the visit (1, 2, ...), while one is open. |

### Event kinds

**The visit.** `visit_started` (mode, whether the annotator chose the
recording, reference set, and `client`: `web` in the browser); `log_closed`
(`reason`: `sign_out` or `page_closed` in the browser; `back_to_start`, `quit`,
`exit`, `new_visit` or `quiz_not_started` in logs of the desktop application);
`error` (an unexpected error, with its details); `log_problem` (something the
logger itself could not record).

**Recordings.** `recording_loading` (`recording_id`); `recording_opened`
(`session_id`, which in logs of the desktop application is also in the
recording's `_session.json`, `mode`,
`duration_s`, `sfreq`, `n_samples`, `n_channels_shown`, `n_channels_hidden`,
`format`, `filters` and `filter_settings`, `original_events`, `resumed`,
`annotations_restored`, `window_px`); `viewer_ready` (the viewer is on screen and
the clock starts); `autosave` (`n_annotations`, when a draft is sent to the study); `recording_finished`
(`session_id`, `n_annotations`, `counts_by_label`, `elapsed_s` as measured by the
session clock); `closed_without_saving` (`n_annotations`); `load_failed`
(`recording_id`, `kind`, `reason`); `recording_unavailable` (`recording_id`,
`reason`).

**Mouse and keys.** `mouse_press`, `mouse_release` and `double_click` (`button`,
`modifiers`, the `widget` (in the browser the kind of control, such as
`button`, `input`, `select`, `canvas` or a menu item; in the desktop
application the widget class), its `name` and `text` where it has them, the
`top_window` (in the browser the page: `signin`, `home`, `annotate`, `training`
and so on), the position `x` and `y` in that window, and for lists and tables
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
`butterfly`. `status_message` (`text` shown in the status line).
`window_activated` and `window_deactivated` (`top_window`, `title`; in the
browser, when the page gains or loses the focus).
`app_state` (`state`: `active`, `inactive`, `hidden` or `suspended`).
`idle_start` (`last_input_t`, `after_s`) and `idle_end` (`idle_s`).

**Dialogs.** `dialog_shown` (`dialog` class, `title`; for messages also the
`text`, `informative` text and the `buttons` offered) and `dialog_closed`
(`accepted`, the `button` clicked, the `chosen` type in the type picker, the
`channels` chosen in the channel chooser).

**The annotation view's state.** `state` (only what changed:
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

**Training.** The training programme records its own events in the same log,
with names starting `guided_`, `practice_`, `assessment_`, `training_` or
`stage_`. On the training path: `training_path_opened` (the state of each
stage and the next step), `stage_started`, `stage_completed` and
`training_path_left`. In a guided recording, with the `recording` and
`window_no`: `guided_step_started` (the experts' annotation for the step:
`target_label`, `target_onset_s`, `target_offset_s`, `target_channels`, and the
`guidance` level), `guided_check` after every change (`matched`, `problems`
such as `type`, `start`, `end`, `scope` or `channels`, the differences in
seconds and the messages shown), `guided_show_me`, `guided_step_completed`
(`attempts`, `failed_attempts`, `stars`, `seconds`, `used_show_me`) and
`guided_recording_completed` (steps, stars, attempts and time for the
recording). After a practice recording: `practice_scored` (`event_f1`,
`label_accuracy`, `passed`, and the numbers missed, extra and of another type),
and in its review `practice_review_opened`, `review_item_jumped` (each item of
*What to look at* opened) and `practice_review_closed`. The visit's header has
`programme` true for the training programme; the mode of each recording is in
its `recording_opened` event. Kinds the analysis does not know are kept in the
events table.

## Making the tables and the report

The admin area shows the report and offers the tables for the study's logs.
From a terminal, on the results of a study on the ElectroClean server or on
the folder written by `electroclean-web export`:

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
| `visit_id` | Identifier of the visit (one log file: in the browser, from signing in until signing out or closing the page). |
| `annotator_id` | The annotator's ID. |
| `mode` | standard, practice, assessment (or a training mode). |
| `context_id` | Reference set of a training visit (empty for standard annotation). |
| `file` | The log file. |
| `started_at` | Local date and time the visit started, with its UTC offset. |
| `ended` | How the visit ended: sign_out or page_closed in the browser (back_to_start, quit, exit or new_visit in logs of the desktop application), or 'not closed' when the log stopped unexpectedly. |
| `wall_s` | Seconds from the start of the visit to its last event. |
| `active_s` | Active seconds in the visit (see 'Active time'). |
| `recordings_opened` | Recordings opened for annotation. |
| `recordings_finished` | Recordings saved with Save and Finish. |
| `recordings_closed_without_saving` | Recordings closed without saving. |
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
visits (continued from a draft) has two rows, the second with `resumed`
true. A practice recording reviewed against the reference has a second row
with `segment` set to `review` (the time and clicks spent in the review). Quiz
answers form a row with `recording` set to `quiz`, and training events that
happened outside a recording a row with `segment` set to `training`.
In the training programme, `mode` is each recording's own mode (`guided`,
`practice` or `assessment`), so `order_in_mode` counts guided, practice and
assessment recordings separately.

| Column | Meaning |
|---|---|
| `annotator_id` | The annotator's ID. |
| `visit_id` | The visit (see visits.tsv). |
| `mode` | standard, guided, practice or assessment: the recording's own mode (in the training programme one visit has recordings of several modes). |
| `context_id` | Reference set of training work (empty for standard annotation). |
| `recording` | Recording ID (path relative to the dataset); 'quiz' for the short-segment quiz. |
| `segment` | recording (a recording opened for annotation), review (a practice recording reviewed against the reference), quiz, or training (training events outside a recording). |
| `window_no` | Number of the recording opened within the visit (1, 2, ...). |
| `order` | Position among all of this annotator's rows, in the order they were started (1 = first). |
| `order_in_mode` | The same, counting only rows of the same mode. |
| `started_at` | Local date and time the recording opened, with its UTC offset. |
| `outcome` | finished (Save and Finish), closed_without_saving, or not_finished (the log ended first). |
| `resumed` | True if unfinished work from an earlier visit was restored. |
| `recording_duration_s` | Length of the recording in seconds. |
| `n_channels_shown` | Channels shown in the viewer. |
| `wall_s` | Seconds from opening the recording to finishing or closing it. |
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
| `final_annotations` | Annotations when the recording was saved (or when it was closed). |
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
| `status_messages` | Messages shown in the status line. |
| `guided_steps` | Guided training: steps completed. |
| `guided_attempts` | Guided training: attempts at the steps. |
| `guided_show_me` | Guided training: times the expert's answer was shown. |
| `guided_stars_mean` | Guided training: mean stars per completed step. |
| `guided_seconds_per_step` | Guided training: mean seconds per completed step. |
| `practice_score` | Practice: the score against the reference (event F1 when given). |
| `practice_passed` | Practice: True if the recording reached the reference set's pass mark (empty otherwise). |
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
the annotations themselves, match the annotator, the recording and the mode
with the recording's `_session.json`; in logs of the desktop application,
`session_id` in `recording_opened` (in `events.tsv`) also matches `session_id`
in the `_session.json`.

The events table has one row per event (with `--events`); its `data` column
holds the event's own fields as JSON, which `json.loads` in Python and
`jsonlite::fromJSON` in R read.
