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

A test with two openly available 128-channel recordings led to further
changes. Annotation labels sit on small tags above the traces, the channel
chooser finds channels by name, ticks whole regions or banks with one click
and lays many channels out in columns, the list of annotations shows how many
channels each covers, and the time-resolved agreement analysis is about six
times faster on recordings with many channels, with identical results.

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
