# Changes

Each section below describes the changes in one version of ElectroClean;
*Unreleased* collects what has changed since the last release.

## Unreleased

ElectroClean now runs in the web browser only, and the desktop application
has been removed. Annotators open the browser application from a link, sign
in, and open the recordings they were given from their own computer; the page
reads them there, so the EEG is never uploaded, and the study holds only each
recording's fingerprint (its SHA-256 checksum), timing, channels and events.
The browser application does everything the desktop application did, reads
EDF, EDF+, BDF and BrainVision files, and gains an admin area in which lead
researchers add recordings, accounts and assignments, change the study's
settings, prepare reference sets and follow progress and results. Real studies
run on Firebase (sign-in, Firestore in Google's London region and Cloud
Functions that save results with ElectroClean's own code, check training and
score practice, so the experts' answers stay with the study); the ElectroClean
server, `electroclean-web`, runs the local demonstration and suits a study that
prefers its own computer. The commands `electroclean-agreement`,
`electroclean-admin` and `electroclean-activity` work as before on the saved
results, which keep the same folders and files, and `python -m electroclean`
lists them. The `electroclean` command, the stand-alone applications, the
launchers and the self-test are gone, and installing ElectroClean no longer
installs Qt. Version 1.1.0 remains on the Releases page as the last desktop
release, and the results folders it wrote are read by the analyses unchanged.

The admin area has sections for the overview, annotators, recordings,
assignments, training, analyses, results, records and the study's settings.
Lead researchers invite annotators (by an invitation link on Firebase, or with
a temporary password on the ElectroClean server), switch accounts off and on,
and keep notes about people and recordings. Recordings are added from the
administrator's own computer: the browser reads the chosen folder or files,
builds each recording's manifest with the same rules as `electroclean-web
register`, shows what it found and sends only the manifests, and a recording
that someone has saved results for is replaced only by the very same file.
Reference sets take their references from someone's saved annotations, from an
annotation file, from a consensus of several experts (with every stretch where
they disagreed listed for adjudication) or from an adjudicated consensus. The
agreement and activity analyses and the competency reports run on the study
and appear on the page with their tables, and every result can be downloaded
as one zip file. Every change an administrator makes, in the admin area or
with the commands, is written to the study's audit log, shown under Records
with each visit to the study.

Annotators can choose channels from a list built for montages of any size,
with a search field and buttons that tick whole regions or banks of channels at
once. The short-segment quiz runs in the browser and is scored by the study, which
keeps each correct answer until the segment has been answered; it can be
stopped and resumed later, or ended early with the score of the segments
answered.

ElectroClean works on an iPad, upright or on its side, with fingers or an
Apple Pencil. One finger marks, selects and resizes as the mouse does; two
fingers move through time and the channels, and a pinch shows more or less
time; a long press opens an annotation's menu and a double tap the list of
types. A row of buttons under the EEG does what the keys do on a computer, the
side panel moves below the EEG when the iPad is upright, and buttons are large
enough for a finger. The file picker offers every file, since iPadOS greys out
extensions it does not know such as .edf, and ElectroClean checks what it is
given. The annotation menu now also offers Edit times… (with the mouse too). On
a phone the sign-in page and the admin area work, and the rest asks for a
larger screen. The interaction log records whether each press came from a
mouse, a finger or a pencil. The application is now tested in WebKit, Safari's
engine, as well as in Chromium.

The browser application has a design of its own, editorial and precise, so
that the EEG stands out. Pages are a warm off-white with faint column guides,
and the EEG is drawn on white. Everything, the EEG's channel names and time
axis included, is set in one typeface, Newsreader, a serif with optical sizes:
headings in a sturdy cut with tight tracking, figures in tabular digits so that
columns line up, and nothing in capitals. Text sizes come from one scale of
whole pixels, each on a whole-pixel line, and spacing from steps of 4 and 8
pixels, so that letters and lines fall on the screen's pixels and look sharp.
Lines are 1-pixel hairlines and panels are square. Buttons are flat grey pills
without outlines and badges are outlined pills, so that the two never look
alike; black marks the one action that moves you forward (Open next recording,
Save and Finish), and a single ink blue marks links, selection and highlights.
Arrows, ticks, chevrons and the training stars are drawn icons in the colour of
the text around them. The font is served with the application, so annotators'
browsers ask no other site for it. The sign-in page sets the name in large type over an illustration of
many EEG traces with the 10-20 montage, the admin area counts its sections in
brackets and shows the study's figures in a grid, pages come in with a short
fade that stops when a person asks for reduced motion, and every text colour
meets WCAG 2.1 AA.

Marking artifacts is quick by keyboard and by mouse. The nine most common
types are on the keys 1 to 9 and on numbered, colour-coded buttons, and the /
key finds any of the 29 types by part of its name or its code. With the
pointer on the EEG, M marks the start of an artifact and M again its end, with
scrolling in between, so long artifacts are as easy as short ones. You can
choose the type first or draw first: the controls read *Draw as* for the next
annotation and *Change to* while annotations are selected, and a click, the N
and P keys or a double-click selects them. A right-click lists the common
types first. The keys are shown at the bottom of the window and in Help.

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
and training recordings are kept with their reference set, so they are never
offered for study annotation.

ElectroClean can record how annotators work, as research data: every click
and key, what was on screen, every change to the annotations, the dialogs, idle
periods and the training steps, time-stamped in one log per visit (text typed
into fields and passwords are never recorded, and annotators are told when
recording is on). The admin area, or `electroclean-activity`, turns the logs
into tables for R or Python and a report showing, for example, whether
annotators got faster from one recording to the next.

A test with two openly available 128-channel recordings led to further
changes. Annotation labels sit on small tags above the traces, and the
time-resolved agreement analysis is about six times faster on recordings with
many channels, with identical results. Trigger channels such as BioSemi's
Status channel now provide the original events when a recording has no other
record of them, and are no longer shown or counted as part of the montage; a
study can set channel types by name pattern (`channels.types`). A recording
whose amplitude is far outside what the body produces, which almost always
means the file states the wrong unit, is shown at a scale that makes its
traces visible, with a warning, instead of appearing blank. Registering a
long, high-density recording needs about half the memory it did, because the
display filters work on blocks of channels: a 30-minute, 128-channel recording
at 1024 Hz needs about 2.2 GB instead of 4 GB.

The agreement, activity and competency reports take the look of the browser
application: a warm off-white page, serif headings and text, hairline rules,
white square-cornered tables and figures, column headings and labels in a
small grey serif, numbers in tabular figures and one ink-blue accent, with
sizes in whole pixels as in the application. The activity
report shows its key numbers as large figures in a ruled grid and draws a
single annotator's learning curve in ink blue; the agreement report's figures
use ink blue, vermillion and reddish purple for the three measures, still each
with its own marker, and a blue scale for heat maps, boxes and timelines.
Warnings and the competency result are framed blocks with a bar in their
colour. The reports remain single files
that fetch nothing from other sites: they name the design's typeface and use
the computer's own serif where it is not installed, and the admin area hands
them the typeface when it shows them, so that they match the application. Wide
tables in the agreement report scroll sideways on their own in a narrow window,
such as the admin area's frame, so the page itself fits, and the activity
report keeps its light colours when the computer uses a dark appearance, like
the application.

Annotators can return to recordings they have finished and revise them. The
home page's list of recordings has tabs (To do, In progress, Done, All and
History), a search by file name, sorting by recent work, name or length, and
pages of 25 rows, so that a couple of hundred recordings stay quick to find on
a computer or an iPad. The History tab lists what the annotator has saved,
newest first, with the date, version, number of annotations and time taken,
and Open to revise opens a recording again with its latest saved annotations
under a banner that says which version is being revised, with Submit the
revision and Leave without changes. A revision is saved as a new attempt beside
the earlier files, which stay untouched; the completion register gains the
attempt, and the agreement analyses, reference sources and exports use each
annotator's latest attempt, chosen by attempt number. A study can switch
revisions off with `annotation.allow_revisions` in its settings. The
interaction log records `revision_started`, `revision_submitted` and
`revision_left`.

The home page can show annotators their progress: recordings done, time worked
and annotations made, a weekly goal they set themselves, the whole team's
progress, milestones (the first recording and then 10 to 300, days in a row,
recordings viewed in full, and the team's share of the study) and an
anonymised leaderboard under pseudonyms made for the study, which each person
may leave. Milestones reward progress and thoroughness, never speed or the
number of annotations, and a milestone reached by Save and Finish is
celebrated briefly without getting in the way. The new `GET` and `POST
/me/achievements` (`ec_achievements` on Firebase) give the facts, and the
study settings gain `gamification.enabled`, `gamification.leaderboard` and
`gamification.leaderboard_viewed_only`, with a reminder to report game
elements in a study's methods. The log records `milestone_reached`, `goal_set`
and `leaderboard_visibility`.

On a phone, the sign-in page now says that annotating needs a tablet or a
computer and that administrators can sign in to check progress; an annotator
who signs in on a phone is offered Email me this link and Sign out.

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
