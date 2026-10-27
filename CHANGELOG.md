# Changes

Each section below becomes the notes of the GitHub release with the same
version. The release workflow refuses a version tag that has no section here.

## Unreleased

ElectroClean has a new look, built on principles that well-designed desktop
software shares: the EEG is the content, so the controls around it are quiet,
with light surfaces, white cards, grey secondary text and one accent colour.
Each window has one blue button for the step that moves you forward (Begin,
Open recording, Save and Finish), and options appear when they apply. The
start window is grouped into three cards (who is annotating, the recordings,
and what you would like to do), the whole montage or selected channels choice
is a two-part switch, and the overview bar under the EEG is plain so that the
annotations in it stand out. Every text colour meets the WCAG 2.1 AA contrast
ratio, and the application looks the same on Windows, macOS and Linux.

Marking artifacts is quicker by keyboard and by mouse. The nine most common
types are on the keys 1 to 9 and on numbered, colour-coded buttons in the
toolbar, and the / key finds any of the 29 types by part of its name or its
code. With the pointer on the EEG, M marks the start of an artifact and M
again its end, with scrolling in between, so long artifacts are as easy as
short ones. You can choose the type first or draw first: the toolbar reads
*Draw as* for the next annotation and *Change to* while annotations are
selected, and a click, the N and P keys or a double-click selects them. A
right-click lists the common types first. The keys are shown at the bottom
of the window and in Help.

A training programme takes new annotators from first steps to the competency
assessment, one stage at a time, on a training path that shows their stars,
scores and time. In *Learn with the experts* they mark each of the experts'
annotations in turn and cannot move on until theirs matches: the same type,
start and end within 0.2 s (or a fifth of the artifact's length), and the same
channels. The help fades from one recording to the next (the experts'
annotation outlined, then the type named, then only "find the next
artifact"), feedback says exactly what differs, and *Show me* demonstrates the
answer. In *On your own* they annotate a recording by themselves and see their
score, with what they missed, marked extra or typed differently flagged on the
EEG; 80 % unlocks the assessment. An example training set of three simulated
recordings stands in until real expert-annotated recordings are imported,
and training recordings live with their reference set, so they are never
offered for study annotation.

ElectroClean can record how annotators work, as research data: every click
and key, what was on screen, every change to the annotations, the dialogs, idle
periods and the training steps, time-stamped in one log per visit (text typed
into fields and passwords are never recorded, and the start window says when
recording is on). *Activity and learning curves* in the administrator tools,
or `electroclean-activity`, turns the logs into tables for R or Python and a
report showing, for example, whether annotators got faster from one recording
to the next.

A test with two openly available 128-channel recordings led to further
changes. Annotation labels sit on small tags above the traces, the channel
chooser finds channels by name, ticks whole regions or banks with one click
and lays many channels out in columns, the list of annotations shows how many
channels each covers, and the time-resolved agreement analysis is about six
times faster on recordings with many channels, with identical results.
Trigger channels such as BioSemi's Status channel now provide the original
events when a recording has no other record of them, and are no longer shown
or counted as part of the montage; a study can set channel types by name
pattern (`channels.types`). A recording whose amplitude is far outside what
the body produces, which almost always means the file states the wrong unit,
is shown at a scale that makes its traces visible, with a warning, instead of
appearing blank. The display filters work on blocks of channels and report
their progress, so a 30-minute, 128-channel recording at 1024 Hz needs about
half the memory it did (2.2 GB instead of 4 GB) and opens in about 40
seconds.

## 1.1.0

The first public release, with stand-alone applications for Windows (64-bit),
macOS (Apple silicon, macOS 14 or later) and Linux (64-bit, Ubuntu 22.04 or
later). Download the zip file for your system below, unzip it and start
ElectroClean; nothing else needs to be installed. The applications are not
signed with a developer certificate, so Windows and macOS ask for confirmation
the first time (see docs/building_apps.md). `SHA256SUMS.txt` holds a checksum
of each zip file.

ElectroClean now opens EDF, EDF+ and BDF recordings as well as BrainVision.
Each EDF or BDF file is checked against its header before it is opened, so a
truncated copy is refused, and EDF+ annotations are used as the original events
when a recording has no events.tsv. Channels that only carry information about
the headset, such as the timestamp, contact-quality and battery channels of
Emotiv exports, are hidden (the list is the `channels.hide` setting), and
stretches that a file marks as having no data are hatched in the viewer. This
was tested on 772 Emotiv recordings from the group's own data.

Every artifact term of HED SCORE 2.2.0 is available (29 terms, the seven group
terms included), and the agreement analysis adds roll-up rows for the group
terms. Artifact codes are written to their own `artifact_code` column, so they
can never be confused with a dataset's own marker codes in `value`; files from
version 1.0, which kept artifact codes in `value`, can still be read.
Overlapping annotations of one type on the same channels are merged
automatically, work is saved automatically while annotating and can be
continued later, EOG and ECG channels are filtered and included in the channel
analyses, and the notch filter is 50 Hz by default with 60 Hz available.

A usability walk-through of the whole application, from the point of view of
annotators and of the study administrator, led to many changes. In the annotation window, Save and
Finish stays visible on laptop screens, every channel of a 10-20 montage with
its EOG and ECG fits without scrolling, labels no longer overlap, the amplitude
scale carries over from one recording to the next, and messages name the
recording and the reason when something goes wrong. In training, the full
competency report (which shows where the reference artifacts are) is now for
the administrator, and annotators see their result; references are imported as
practice or assessment by an explicit choice; the reviews draw the reference
distinctly; and the quiz can be used for practice too. The agreement analysis
runs in the background, checks its inputs and names, never overwrites earlier
results silently, and its report opens with the key results for each pair of
annotators. The command-line tools refuse mistyped folders and names, and the
launchers repair an interrupted installation.

ElectroClean is free for research, teaching and other non-commercial use under
the PolyForm Noncommercial License 1.0.0.
