# Administrator guide: configuring a study

This guide is for the lead researcher who configures a study: how the
recordings are registered and shown, which recording each annotator is given
next, how annotators are trained and assessed, and what is recorded about their
work. It explains what each setting and each choice means and what follows from
it. The steps themselves are in three other guides. The
[admin area](web/admin.md) is where a lead researcher runs a study in the
browser: accounts, recordings, assignments, settings, reference sets, progress
and results. [Running a study on Firebase](web/firebase.md) sets up a real
study from the beginning, and [the ElectroTag server](web/server.md) covers
the demonstration and a study on a computer of your own.

The same settings and rules apply wherever a choice is made. The admin area
changes the study it is signed in to. The command `electrotag-web` does the
same from a terminal, for example when a study is created
(`electrotag-web init-study --settings settings.json`) and when the
recordings of a dataset folder are registered (`electrotag-web register`).
The command `electrotag-admin` works on a folder: a dataset folder whose
reference sets you prepare before registering them, or the study folder of an
ElectroTag server, which keeps the study's settings in
`electrotag_study.json` just as a dataset folder does. Each command explains
its options, for example `electrotag-admin set-criteria --help`.

## The settings

Every setting has a default, in `electrotag/config/default_settings.json`,
and a study gives only the ones it changes, as the `settings` block of a study
file (the format is in [file_formats.md](file_formats.md)):

```json
{"settings": {"filters": {"locked": true},
              "channels": {"types": {"EXG1": "eog", "EXG2": "eog"}},
              "selection": {"strategy": "seeded", "seed": 7}}}
```

The admin area's settings change the blocks `filters`, `display`, `channels`,
`selection`, `logging`, `annotation` and `loading`, and the study keeps them
with its records: in Firestore for a study on Firebase, and in the study
folder's `electrotag_study.json` on an ElectroTag server. The settings that
decide what a recording consists of (the channels to hide, the channel types,
the BIDS options under `loading` and, for a dataset folder, the file endings
under `discovery`) are applied when the recording is registered, because the
registration records which channels are shown and what type each one is. Set
them before registering the recordings.

## Recordings and their channels

ElectroTag reads BrainVision (`*_eeg.vhdr` with its `.eeg` and `.vmrk`
files), EDF and EDF+ (`*_eeg.edf`) and BDF (`*_eeg.bdf`) recordings. A
recording is read when it is registered, on the computer that holds it (with
MNE-Python by `electrotag-web register`, or by the browser in the admin area,
which builds the same registration), and again when an annotator opens their
own copy, by the browser itself, which reproduces MNE's reading
([architecture](web/architecture.md)). The registration stores the
recording's fingerprint (the SHA-256 checksum of its data file), timing,
channels and original events, and never the EEG. The browser compares the file
an annotator opens with that registration before the recording opens.
`discovery.suffixes` chooses the file endings a dataset folder is searched for,
for example `["_eeg.edf"]` to register only EDF recordings.

Some recordings are refused, with the reason, at registration and in the
browser alike. The size of an EDF or BDF file is compared with its header, so a
file that holds fewer or more data records than its header announces (for
example an interrupted copy) is refused, as is an EDF+D file, whose data
records are not contiguous in time. A BrainVision data file must hold a whole
number of samples and agree with its header, and its companion files must be
present. A recording that cannot be registered is named with the reason, and
the others are registered; register again once the files have been put right.

The original events come from the BIDS `events.tsv` when there is one.
Otherwise the annotations stored in an EDF+ or BDF+ file are used, or the
BrainVision markers, and when the file has none of these, the triggers on its
trigger channels: every change of the channel to a non-zero code is an event,
and for BDF files only the lower 16 bits of BioSemi's Status channel count,
because the upper bits carry system flags such as CMS and battery. Stretches the
file marks as `BAD_ACQ_SKIP` (MNE writes this, for example, for the padding of
the last data record when it exports EDF) are hatched in the viewer and
filtered separately.

Trigger channels (MNE's type `stim`: BioSemi's `Status` channel, any channel
named `Trigger` or `Status`, and channels that the `channels.tsv` file types as
`TRIG`) hold event codes rather than signal. They are never shown, cannot be
annotated and are not part of the whole montage, so they do not count in the
channel analyses; they are listed with the hidden channels in every
annotation and session file.

The setting `channels.types` gives channels a type by name, with the same
wildcards as `channels.hide`; the first matching pattern applies, and it takes
precedence over the file and over `channels.tsv`. The type decides the scale
and the filters of a channel in the display, and the type `stim` makes a
channel a trigger channel. BioSemi's external channels `EXG1` to `EXG8`, for
example, are read as EEG; if they carry EOG, ECG or nothing at all, the study's
settings can say so:

```json
{"settings": {"channels": {"types": {"EXG1": "eog", "EXG2": "eog", "EXG5": "ecg", "EXG6": "ecg", "EXG*": "misc"}}}}
```

The types allowed are `eeg`, `eog`, `ecg`, `emg`, `misc`, `stim`, `resp`,
`bio`, `gsr` and `temperature`. EOG and ECG channels stay part of the montage
and of the agreement analysis.

Some headsets, Emotiv's among them, export housekeeping signals as extra
"EEG" channels: timestamps, sample counters, contact and signal quality, battery
level and marker channels. Shown next to the EEG they would crowd the display,
and in the channel analyses a whole-montage annotation would count them as
annotated channels. The setting `channels.hide` lists names (with `*` and `?`
as wildcards, case-sensitive) of channels that are not shown and cannot be
annotated. By default it lists the housekeeping channels of Emotiv EDF exports
(`TIME_STAMP_s`, `COUNTER`, `INTERPOLATED`, `RAW_CQ`, `BATTERY`,
`MarkerValueInt`, `CQ_*`, `EQ_*` and so on); a study can replace the list, for
example with `"channels": {"hide": []}` to show every channel. Hidden channels
are listed in every annotation and session file, and the annotations' "whole
montage" means the channels that were shown. Keep the setting the same for all
annotators of a study: files made with different lists are compared on the
channels they share, with a warning.

The `loading` block decides how the BIDS sidecars are used:
`apply_channel_types_from_bids` takes channel types from `channels.tsv`, and
`show_bids_bad_channels` marks the channels it lists as bad. Registration always
records the checksums of the recording's files, whatever `hash_source_files`
says, because the fingerprint is how an annotator's copy is recognised.
`preload_memory_limit_mb` (2048 MB by default) concerns registration with
MNE-Python: a display copy larger than this is kept in a temporary
memory-mapped file rather than in memory.

## The viewing filters

The defaults are a 1 Hz high-pass and a 50 Hz notch filter, both zero-phase FIR
filters with MNE's default design; annotators may switch the notch to 60 Hz
for recordings made with 60 Hz mains. For a reliability study all annotators
should see the same filtered signal, so the filters can be fixed with
`"filters": {"locked": true}` together with the values wanted
(`highpass_enabled`, `highpass_hz`, `notch_enabled`, `notch_hz`,
`notch_harmonics`). In a folder, `electrotag-admin fix-filters` and
`unlock-filters` write the same settings:

```bash
electrotag-admin fix-filters /data/MyStudy                     # 1 Hz high-pass, 50 Hz notch, FIR
electrotag-admin fix-filters /data/MyStudy --notch 60          # for 60 Hz mains
electrotag-admin fix-filters /data/MyStudy --no-highpass --notch off
electrotag-admin unlock-filters /data/MyStudy
```

Annotators then see the filters in the viewing options but cannot change
them, and every session file records that they were fixed, together with the
filter design (FIR, zero phase, MNE's default Hamming-windowed `firwin`
design) and the exact lengths and transition bands. A 1 Hz FIR high-pass at
MNE's defaults is 3.3 s long and the FIR notch is 6.6 s long, so up to about
5 s at each recording edge and around each discontinuity can be affected;
these zones are hatched in the viewer. The browser designs and applies the
filters as MNE does, and its filtered samples agree with MNE's to within the
rounding of single-precision numbers.

## The display

The `display` settings choose how the EEG first appears: `scalings` (the
amplitude per channel type, in volts; the scale bar shows twice the value),
`duration_s` (seconds shown, 10 by default) and `n_channels` (channels shown
at once, 32 by default, so that a 10-20 montage with its EOG and ECG channels
fits without scrolling). `channel_colours` sets how the browser colours the
channels at first (`off`, `region`, `side` or `type`; `off` by default), which
each annotator can change in the Recording tab. Annotators can still change the amplitude, and the
scale, seconds and channels on screen at Save and Finish are written to each
session file (`display` in session.json), so you can see at what scale each
recording was annotated. For a reliability study it helps to choose a starting
scale that suits the data. The default (50 µV, `5e-05`) suits clinical EEG;
low-density consumer headsets such as Emotiv's record larger signals, and
`1e-4` (a 200 µV scale bar) keeps neighbouring channels apart:

```json
{"settings": {"display": {"scalings": {"eeg": 1e-4}}}}
```

ElectroTag measures the amplitude of a recording's EEG, EOG, EMG and ECG
channels in a few short stretches spread through the recording (the median
over channels of the 99.5th percentile of each channel's deviation from its
median). An amplitude outside what the body produces (below 0.25 µV, or above
2.5 mV for EEG, 5 mV for EOG and EMG and 20 mV for ECG) almost always means
that the file states the wrong unit, for example microvolts stored as volts.
The traces would then be invisible, because the viewer hides samples beyond
1.5 times the scale. In that case the recording's details say so, and the
display scale of that type is set for that recording to a round value just
above the amplitude, so that the traces can be seen. The scale bar still shows
the amplitude as the file states it. The scale chosen and the measured
amplitudes are written to the session file. Check such a recording with
whoever exported it before it is annotated.

### The types on the number keys

Annotators choose the nine most common artifact types with the keys 1 to 9 and
the numbered buttons. The defaults are Eye-blink, Horizontal eye movement, EMG,
Movement, Electrode pops, Chewing, ECG, Line noise and Data-artifact (the group
term for an artifact whose type is unclear). A study can choose others, in key
order, with up to nine names from the label catalogue:

```json
{"settings": {"annotation": {"quick_labels": ["Eye-blink-artifact", "Slow-eye-movement-artifact", "EMG-artifact"]}}}
```

Names that are not in the label catalogue are left out, and the other types
stay available from the menu and the searchable list (the / key).
`annotation.min_duration_samples` (1 by default) is the shortest annotation
that is accepted.

### Long sessions in the browser

Three settings of the browser version make long sessions easier for annotators.
`annotation.break_reminder_minutes` (50 by default, from 0 to 240) is how many
minutes of work since the last break pass before a gentle reminder offers a
break; a pause of five minutes or more counts as a break. `annotation.idle_pause_minutes`
(3 by default, from 0 to 60) is how many minutes without any input pass before
the working-time clock pauses itself. A value of 0 turns either off.
`annotation.coverage_check` is `"warn"` (the default), with which Save and
Finish first lists the stretches of at least a second that have never been on
the screen, or `"off"`.

```json
{"settings": {"annotation": {"break_reminder_minutes": 45, "idle_pause_minutes": 5, "coverage_check": "warn"}}}
```

`annotation.confidence` is `"optional"` (the default), with which annotators
rate their confidence in a mark on a 5-point scale (1, not at all confident, to
5, completely confident) when they wish, or `"every_mark"`, with which they are
asked for a rating after each new mark and Save and Finish lists the marks left
unrated. No mark starts with a rating in either. Annotators can always rate a
mark and add a short note; the setting is recorded in every saved result
([design decisions](design_decisions.md), "Confidence and notes").

The time worked on a recording, saved in the session file (`timing.elapsed_seconds`),
the `_time_viewed.txt` file and the completion register (`elapsed_s`), leaves out
every pause in the browser: those the annotator chose, those
after the minutes without input, and the time the page was out of sight for
more than ten seconds. The interaction log records each pause and its length
([activity logs](activity_logs.md)).

## Which recording comes next

Each annotator works on the recordings assigned to them, in the admin area or
with `electrotag-web assign`. The page of their recordings offers one of them
as the next to do. A recording they have started and not finished always comes
first; otherwise the setting `selection.strategy` decides. With `random` (the
default) it is a random choice among their open recordings, which stays the
same until they finish another one. With `seeded` and a `selection.seed`, each
annotator gets a reproducible order, derived from the seed and their annotator
ID. With `manual` it is the first open recording in the order they were
assigned. Annotators can still open any of their recordings from the list.

To plan a controlled overlap, `electrotag-admin allocate` computes a
balanced allocation for the recordings of a folder: every recording is given
to exactly the number of annotators asked for, balancing the workload and the
number of recordings each pair of annotators shares. It writes the allocation
into the folder's study file, where `electrotag-admin show` lists it; assign
those recordings to each annotator in the admin area or with
`electrotag-web assign`.

```bash
electrotag-admin allocate /data/MyStudy --annotators A01 A02 A03 CAM \
    --raters-per-recording 2 --seed 7
```

Completion is recorded per annotator: a recording completed by A01 remains
available to A02. A recording an annotator has completed is not offered to
them again, and saved files are never overwritten. When an annotator is allowed
to annotate a recording again (a practice recording that did not pass, for
example), the new files are saved as a second attempt (`_attempt-02`).

## Original event codes and artifact codes

Artifact codes (100 to 121 for the specific types, 130 to 136 for the group
terms) are written to their own `artifact_code` column. The `value` column
keeps only the dataset's own marker codes, so a recording whose events already
use, say, code 101 needs no special treatment: the original 101 stays in
`value` and an ECG artifact gets 101 in `artifact_code`. There is nothing to
configure. Original codes are never renumbered. Repeated codes (many trials
sharing one code) are normal and are only counted; a code used for different
event types, or one type appearing with different codes, is reported in each
session file for you to review, as are original events that already use
HED-SCORE artifact names. Older study files that still set
`events.collision_policy` are accepted; the setting is no longer used.

## Saving, and unfinished work

Save and Finish sends the annotations to the study, where ElectroTag's own
code validates them, writes the five result files, reads them back, checks them
and only then marks the recording complete for that annotator (the journalled
save described in the [developer guide](developer_guide.md)). If saving is
interrupted, the files that were not verified are set aside and the recording
stays incomplete, so the annotator can save it again. While an annotator works,
the browser keeps a draft of their unfinished annotations and time, in the
browser and with the study, and offers it back when they open the recording
again, on the same computer or another. Drafts are never results: the agreement
analysis and the completion register only ever see recordings finished with
Save and Finish.

## Training and competency assessment

### Reference sets

A reference set is a group of recordings with expert reference annotations,
each marked for **guided** learning (Stage 1 of the training programme, below),
**practice** or **assessment**. The references must be prepared independently
of the people being assessed, so that, for example, Cameron can be trained and
assessed without having produced any of the reference material himself. The
method used is stored as provenance with each reference. Each reference is
given its use by an explicit choice, without a default, because a reference
imported for practice by mistake would give annotators feedback on an
assessment recording; when trainees have already done a recording that is
then given another use, ElectroTag names them and warns that the assessment
would not be blinded for them.

A reference set keeps its training recordings apart from the study's: a study
recording used in a set is copied into the set's own scope, so training
recordings are never offered for study annotation. Trainees are given the
training recordings' files in the same way as other recordings, and the
experts' annotations stay with the study: the browser never receives them, so
guided checks, practice scores and competency reports are computed by the
study's server or functions.

There are three ways to establish a reference.

1. **One designated expert.** The expert annotates the recording in standard
   mode, as an annotator of the study, and their saved annotations become the
   reference. An `_annotations.json` file made elsewhere (for example with the
   desktop application or in another study) can be used in the same way.
2. **Consensus of several experts.** A sample is in the consensus for a
   category when at least the chosen number of experts (`min_agreement`, a
   strict majority by default) marked it. For each consensus interval the
   channels are those chosen by at least as many of the contributing experts,
   and the interval is whole-montage when enough experts used whole montage.
   A merge gap joins consensus intervals separated by at most that many
   seconds, and a minimum duration then drops shorter intervals (both 0 by
   default). The disagreement list has one row for each stretch of time that
   the same subset of experts (some but not all) marked, saying whether it
   ended up in the consensus, and one row for each consensus interval where the
   experts chose different channels, giving every expert's selection and the
   consensus result.
3. **Adjudication.** An adjudicator is given the disagreement list and
   annotates the recording to produce the final version, which becomes the
   reference; the experts whose disagreements were adjudicated are recorded
   with it.

The admin area makes references in all three ways from the annotations saved
in the study. In a folder, `electrotag-admin` does the same from files
(`create-reference-set`, then `add-reference`, `build-consensus` with
`--min-agreement`, `--merge-gap`, `--min-duration` and `--disagreements`,
`export-disagreements` and `add-adjudicated`), and `electrotag-web register`
then stores the folder's reference sets with the study, with their experts'
annotations and without their recordings:

```bash
electrotag-admin create-reference-set /data/MyStudy pilot --name "Pilot set" \
    --method consensus --experts E1 E2 E3
electrotag-admin build-consensus /data/MyStudy pilot E1.json E2.json E3.json \
    --use assessment --disagreements dis.tsv
```

Files imported into a reference set are copied into it with their checksums,
and a reference file that has been edited afterwards is refused. In a folder,
reference sets are kept in `derivatives/electrotag_reference_sets` unless
`training.reference_sets_dir` names another place.

A reference set can be restricted to particular annotators (none means
anyone): in the admin area, or with `electrotag-admin assign /data/MyStudy
pilot CAM A03`. `practice_review` (on by default) offers a side-by-side review
against the reference after each practice recording.

### Competency criteria

ElectroTag does not impose a universal threshold: no criteria are set until
you set them, and reports then say "not determined". Choose criteria from
pilot data, expert agreement and the intended use of the labels. Thresholds can
only take values the measure can have (0 to 1 for proportions, -1 to 1 for
kappa).

| Metric | Meaning |
|---|---|
| `event_f1` | F1 of matched events (time only) |
| `event_recall` | Proportion of reference artifacts found |
| `event_precision` | Proportion of the annotator's artifacts that match the reference |
| `time_kappa` | Cohen's kappa over time (exact) |
| `time_positive_agreement` | Positive agreement over time |
| `channel_positive_agreement` | Positive agreement over time and channels |
| `mean_iou` | Mean temporal overlap of matched artifacts |
| `mean_channel_jaccard` | Mean channel overlap of matched artifacts |
| `label_accuracy` | Proportion of detected artifacts given the reference's label |
| `false_positives_per_min` | Annotations matching no reference artifact of any category, per minute (lower is better); an artifact found with a different label counts towards `label_accuracy` instead |

Each criterion applies **overall** or **in every assessed category**. A
category is judged only when the reference contains at least
`min_reference_events` events of it (3 by default); others are reported but
not judged. The result is "not determined" when a criterion cannot be
evaluated: for example a per-category criterion when no category has enough
reference events, or `mean_iou` when no artifact was matched at all. Pairing
`mean_iou`, `event_precision` or `label_accuracy` with `event_recall` or
`event_f1` therefore avoids undetermined results for annotators who find
very little. It is also "not determined" when an assessment recording could
not be compared with its reference (for instance because the annotator's file
refers to a different version of the recording); the report lists the
reasons.

```bash
electrotag-admin set-criteria /data/MyStudy pilot \
    --criterion event_f1:0.8 --criterion event_recall:0.7:each_category \
    --criterion label_accuracy:0.85 --min-reference-events 3
```

Matching for competency uses the defaults of the reliability analysis (IoU of
at least 0.2, one-to-one); a reference set can override them in the
`analysis` entry of its `reference_set.json`. The ANY-artifact rows and both
channel modes are always computed for assessments, because the competency
measures are based on them.

### The training programme

An annotator enrolled in a reference set's training programme (in the admin
area, or with `electrotag-web assign T01 --programme SET`) goes straight to
their training path when they sign in. They work through three stages of the
set, each unlocked by the one before: **learn with the experts** (the set's
guided recordings), **on your own** (its practice recordings, with a pass
mark) and the **competency assessment** (its assessment recordings). A stage
the set has no recordings for is skipped. The training path shows the stages,
what the annotator has done, their stars, best practice score and time, and
the next step; the [guide for annotators](web/using.md) describes what they
see.

**The example training set.** Until your experts' files are ready, the example
training set (in the admin area, or `electrotag-web create-example-set`, or
`electrotag-admin create-example-set` in a folder) is a set called *Example
training set (placeholder)* with three simulated recordings: two for guided
learning and one for practice. Its reference is the simulation's ground truth,
known exactly because the artifacts were simulated, and each guided step has a
placeholder note that describes only what was simulated. Use it to try the
programme and to show annotators how it works until the experts' material is
ready.

**Real expert files.** Each expert annotates the recordings in standard mode,
and their annotations become references as described above. In a folder,
`electrotag-admin import-recording /data/MyStudy SET recording_eeg.vhdr
E1_annotations.json --use guided` copies the recording, its companion files and
its BIDS sidecars into the set's own folder (`recordings/` inside the set, laid
out like a small BIDS dataset) and uses the expert's file as the reference. To
build a set from two or three real files, create a new reference set, add each
recording with its use, and remove the example set when it is no longer needed.
Consensus and adjudicated references can also be used for guided and practice
recordings.

**How much help guided recordings give.** The first guided recording shows
each artifact (a dashed outline of the experts' interval and channels), the
second names the type and shows a screen that contains it, and later ones only
say that another artifact follows. Each recording's level can be chosen
(`show`, `find` or `find_unnamed`; `auto` chooses by its place), in the admin
area or with `electrotag-admin set-guidance /data/MyStudy SET RECORDING
show|find|find_unnamed`.

**Notes from the experts.** Each guided step can show the experts' explanation
of that artifact, written in the admin area or with
`electrotag-admin set-note /data/MyStudy SET ANNOTATION_ID "Look at the
frontal channels first"`. The notes are stored under `guided.notes` in the
set's `reference_set.json`.

**What counts as a match.** In guided learning an annotation matches the
experts' when it has the same type, its start and end are each within 0.2 s
or 20 % of the experts' duration (whichever is larger), it has the same scope
(whole montage or particular channels) and, for channel-specific annotations,
at least 75 % of the channels are the same (Jaccard index: the channels both
chose divided by the channels either chose). These are set for each reference
set, in the admin area or with `electrotag-admin set-programme
/data/MyStudy SET --tolerance-s 0.25 --tolerance-fraction 0.2
--channel-overlap 0.75`. Alternatives that are also accepted for a type can be
listed in `guided.tolerance.accepted_labels` in `reference_set.json`, for
example `{"Eye-blink-artifact": ["Eye-artifact"]}`.

**The pass mark for practice.** A practice recording passes when the
annotator finds at least 80 % of the experts' artifacts (event F1) and gives
at least 80 % of those found the experts' type, by default; both are set for
each reference set (`electrotag-admin set-programme /data/MyStudy SET
--pass-f1 0.8 --pass-types 0.8` in a folder). One passed practice recording
unlocks the assessment. When every practice recording has been done without
passing, the training path offers one of them again, saved as a second attempt
(`_attempt-02`).

**Progress and records.** Completion comes from the completion register, as
for all work. Stars, scores, times and the order of stages are kept for each
annotator (`training_progress/<set>/annotator-<ID>.json` in the results), and
each guided recording's summary (steps, stars, attempts, steps shown) is also
in its session file, so the progress can be rebuilt if it is lost. Every step
(each check with what differed, each *Show me*, each step's time and stars,
each practice score, and each item opened in a review) is recorded in the
visit's interaction log. The admin area, `electrotag-web progress` and
`electrotag-admin progress` list, for each annotator, the guided recordings
done with their stars, the practice recordings done and whether one passed,
and the assessment recordings done.

### What annotators experience

In **practice** annotators see feedback after each recording and can review
their annotations next to the reference, with each missed, extra or relabelled
artifact listed to step through. In **assessment** they see nothing until all
assessment recordings are complete; ElectroTag then makes the competency
report and shows the annotator a summary: the overall result, the table of
criteria and what to do next. The full report, which shows where the
reference's artifacts are, is for you. Guided, practice and assessment
annotations are stored under `training/` in the results and are never mixed
with the study's annotations.

### Competency reports

The report lists each criterion with its value and result, the overall
measures and the measures by artifact type (with a glossary), the missed,
extra and relabelled artifacts, the matching rule in words, how each
assessment reference was made (method, experts and adjudicator; the method
declared when the set was created is shown separately) and the checksum of
every input file. It is in the admin area, in the exported results
(`training/<set>/reports/`), and can be made again from a results folder:

```bash
electrotag-admin progress /data/MyStudy pilot --annotators CAM A03
electrotag-admin report /data/MyStudy pilot CAM
```

Each competency report carries a `results_sha256` digest of its contents.
`electrotag.training.assessment.verify_competency_report(path)` recomputes
it from the saved JSON file, and regenerating a report from the same files
gives the same digest, which makes the assessment reproducible.

### The short-segment quiz

The quiz complements the continuous assessment: annotators see short segments
and choose the principal artifact type, in the spirit of the multiple-choice
EEG examination of Nascimento et al. (2023), which included an artifact
domain. It tests recognition only, not boundaries or channels. Each item is a
stretch of a recording (with some EEG shown around it), its correct answer,
other answers also accepted (for example the group term Eye-artifact for an
eye blink) and an explanation, shown after each answer when the quiz is used
for practice. Items are added in the admin area, or in a folder with:

```bash
electrotag-admin add-quiz-item /data/MyStudy pilot --item-id q01 \
    --recording sub-002/eeg/sub-002_task-rest_eeg.vhdr --start 9.2 --end 10.8 \
    --label EMG-artifact --explanation "High-frequency activity over temporal channels"
```

The order of the items is shuffled reproducibly for each annotator. When the
quiz is part of an assessment, the answers are revealed only at the end. When
the quiz offers the answer "No artifact / none of these"
(`"include_none_option": true` in the `quiz` entry of `reference_set.json`),
clean segments can be included by giving that text as the item's label.
Results are saved in `training/<set>/quiz/` in the results.

## Interaction logs (research data)

By default ElectroTag keeps a log of every visit: the time of every click,
key press and shortcut, what part of the recording was on screen, every
annotation created, changed or deleted, the dialogs shown and the answers
given, and when the annotator was idle or working in another program. Text
typed into fields is never recorded, nor anything typed into password fields,
nor the display name. After signing in, annotators are told that their use of
ElectroTag is recorded; they must also be told what is recorded and why, and
agree to it, under the study's ethics approval, in the same way as for any
other data collected from participants. A study that does not need the logs
switches them off with `{"settings": {"logging": {"interactions": false}}}`;
`logging.pointer_hz` (5 by default, 0 for none) sets how often the pointer
position over the EEG is recorded, and `logging.idle_after_s` (30 s) how long
without input counts as idle. The admin area shows the tables and report of
time, clicks, keys and learning curves, and `electrotag-activity` makes them
from exported results; every event and column is described in
[interaction logs](activity_logs.md).

## Settings and commands from the desktop application

A study file written for the desktop application (version 1.1.0 and earlier)
can hold three things the browser does not use: the administrator passphrase
(`admin_passphrase`, set with `electrotag-admin set-passphrase`), which kept
annotators out of the desktop's administrator tools, where accounts with the
administrator role now do that; the list of annotators with
`allow_unlisted_annotators`, where accounts now decide who annotates; and
manual assignments in its `allocation` block, where the study's assignments now
decide. `electrotag-admin resolve-failure` marks a load failure in a results
folder of the desktop application as resolved; in a browser study a recording
that cannot be read is reported when it is registered. The settings blocks of
such a file apply unchanged.

## Before a study starts

1. Try the study as an annotator on each type of computer and in each browser
   that annotators will use, with the checks listed in the
   [testing guide](testing_guide.md).
2. Fix the viewing filters, choose how the next recording is chosen, and set
   the channels to hide and their types before registering the recordings.
3. Register the recordings and check that every one was registered; the
   admin area and `electrotag-web list` show what the study holds.
4. Agree the settings of the agreement analysis and write them in a JSON file
   (`electrotag-agreement --config settings.json …`).
