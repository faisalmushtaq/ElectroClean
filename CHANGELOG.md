# Changes

Each section below describes the changes in one version of ElectroTag;
*Unreleased* collects what has changed since the last release.

## Unreleased

Annotators can report a problem with a recording instead of saving it as having
no artifacts: from the More button beside it in their list (which works for a
file that will not even open) or in the annotation view's header, they choose
what is wrong (the file will not open, the wrong recording, flat, missing or
disconnected channels, too noisy or too short to annotate, or something else),
add a note of up to 300 characters if they wish, and either carry on or set the
recording aside as one that cannot be annotated. A recording set aside has the
new status `unusable`: finished for the annotator's progress, kept apart from
done in the study's figures, and left out of the agreement analyses, whose
report says so with the counts. Administrators find the reports in a new
Problems section under Data, with filters and a CSV download, and resolve them
with a note, return the recording to the annotator's to-do list (the annotator
sees a short line saying so) or give it to someone else. Overview and Progress
count open problems and recordings that cannot be annotated. Reports are kept
with the results (`problem_reports/` in the results zip and the export) and in
the audit log, and the interaction log records their reason and outcome, never
the note.

Administrators can review saved work. Review, beside a saved recording in a
person's Work or in Results, opens it in a read-only review mode of the
annotation view, once the file chosen on the reviewer's computer matches the
study's fingerprint; each annotation gets Agree, Caveat or Comment with an
optional note (keys N, P, A, C and M, or taps on an iPad), a stretch without an
annotation is marked by dragging across the EEG ("missed artifact?"), and the
review is saved once as its own record, never changing the annotation files.
Annotators see "Reviewed: 2 caveats, 1 comment" in their list and history, read
the feedback beside their annotations in the accent blue, and keep it in view
while they revise. Two settings, `annotation.allow_reviews` and
`annotation.show_reviews_to_annotators` (for blind reviews), are in Study
settings. Each review goes into the results zip as a TSV and a JSON file, and
the agreement analyses do not use reviews.

ElectroClean is now called ElectroTag, a name that says what it does: people
tag the artifacts in EEG recordings. Everything carries the new name: the
Python package (`electrotag`), the commands (`electrotag-web`,
`electrotag-agreement`, `electrotag-admin`, `electrotag-activity`), the study
settings file (`electrotag_study.json`), the names written in result files, the
Firebase functions (`et_`), the environment variables (`ELECTROTAG_…`) and the
application itself, published at <https://faisalmushtaq.github.io/ElectroTag/>.
Version 1.1.0 and the versions before it were released as ElectroClean.
The branch that publishes the preview keeps its name, `claude/electroclean-web`;
the rename had also changed it in the workflows, so the preview under
`preview/` stopped updating until this was put right.

ElectroTag has its own mark: a short stretch of EEG marked as an artifact, the
shaded band with its two edges that the application draws for each
annotation, in a rounded frame. It replaces the earlier circle with a trace
through it in the header and on the sign-in page, and it is now also the
browser tab's icon and the icon an iPad shows when ElectroTag is added to its
home screen, which the application did not have before.

Annotators can say how sure they are of each mark, and add a short note to
it. Each annotation can have a confidence of definite, probable or possible:
D gives the selected annotation (or the one just made) the next level, Set
confidence… in its menu (a long press on an iPad) picks one, and the
Confidence button below the Annotations list steps to the next with one tap.
Probable and possible marks are filled more lightly on the EEG and named in
their tag; the list shows a short word for them and a small tick for
definite. Add a note…, in the menu, below the list or in Edit times…, keeps a
note of up to 200 characters, shown by a small note sign with the text as its
tooltip. The study chooses in its settings (`annotation.confidence`) whether
confidence is optional, the default, where a new mark has none and looks as
before, or asked for every mark, where every new mark starts as definite. Both
are saved with the annotations and kept in drafts, revisions, undo and redo;
overlapping marks that merge keep the lower confidence and both notes.
`events.tsv` has two new columns, `confidence` and `annotation_note` (`n/a`
when not given), described in `events.json`; the session and annotations
files record the study's setting, and files written before are still read. The
agreement analysis reports each annotator's distribution of confidence and,
when any was given, agreement again without the marks given probable or
possible (definite-confidence agreement), in the report and in
`confidence_by_annotator.tsv` and `confidence_sensitivity.tsv`; notes are
listed with each matched and unmatched event and used in no statistic. The
interaction log records `confidence_set` and `note_set`, with a note's length
only, never its text.

The annotation view has four new ways of looking at the EEG, after those of
EEGNet. In Channels… and Edit channels…, Map shows the electrodes on a
drawing of the head, placed from the recording's own BIDS electrodes.tsv when
it is opened with the recording, otherwise from the standard 10-20, 10-10 and
10-05 positions, or on rings in order for montages such as BioSemi's and EGI's,
said plainly; a click or tap chooses an electrode, a box dragged with the mouse
or the Pencil chooses several, Select all, None and Invert act on them all, the
arrow keys and Space work too, and the electrodes are large enough for a finger
on an iPad. The line at the bottom shows the channel, time and value in µV under
the pointer (V, or Value under the pointer in the Recording tab; on with a
mouse, off on an iPad). Overlay (O, in the toolbar and on an iPad under the
EEG) draws the channels on screen on one axis in thin, light lines, so that a
blink or a movement stands out; the names become a legend, I shows one channel
alone and the arrow keys move between channels, and new marks apply to the
whole montage. Go to time (G) takes seconds, m:ss or h:mm:ss and puts that time
in the middle of the screen, and Show all (Shift+End) shows the whole recording
as an overview and goes back. The interaction log records each of these, with
the time gone to as a number and never the text typed.

The browser version holds up better when the study answers late or fails
once, and when people press things twice. While Save and Finish waits for its
answer, no draft is sent and Pause, Close and Leave without changes wait, so a
late answer can neither leave a stray draft beside the saved result nor save a
revision that was left; a revision whose first answer was lost is reported as
most likely saved instead of being refused as unsaved. A download from a link,
or a slow answer about a file, for an open view the person has left no longer
opens that recording by itself (and so no longer closes the recording they
went on to), and leaving the view stops the download. The pause after minutes
without input starts when those minutes ran out, so a computer that slept with
a recording on screen does not count the night as work, and that pause no
longer takes the focus from a dialog left open. A double click on a button
that opens a question no longer closes the question at once. Changes of the
weekly goal and the leaderboard go one at a time and a late answer never brings
back an older goal. In the admin area, Progress keeps the newest answer when
two cross, Find reads its lists once however fast the person types, actions on
several recordings or people run one at a time and ask before the page is
closed mid-run, and an invitation link that could not be checked offers Try
again. A recording kept on the device is not removed while a recording opened
from it is open in any tab, since its files are read as it is viewed.

The study server no longer takes a negative time worked in a draft, and records
a time of more than a week for one recording (which the pausing clock cannot
reach) as a week, with a warning in the saved session, so that one faulty or
forged figure cannot distort the totals of the Progress section and the home
page; the save itself always goes ahead. The team's progress on the home page
is left out while an annotator shares the study with just one other person,
whose figures it would otherwise give away.

Annotators can open a recording from a Dropbox or OneDrive link (or any web
address that lets web pages read its file): Open from a link, on the page
that opens recordings, takes one link per file, turns share links into the
addresses their files are downloaded from, fetches the file straight from the
service with its progress, and opens it as if it had been chosen on the
computer, with the same fingerprint check. The study never receives the file
or the link, and the link is neither stored nor logged. When a service does
not let web pages read the file (Google Drive, most work and school OneDrive
links, links that are not public), the page says why in plain words and
offers the next step: download the file in a new tab, then choose it.

Recordings can be kept on the device, in the browser's own storage for the
site (the Origin Private File System, or IndexedDB where the page cannot write
files there), so that they open again without downloading. A recording opened
from a link is kept unless the annotator unticks it, files chosen on the
computer only when they ask, and each copy is filed under the study, the
annotator and the recording's fingerprint, which is checked again whenever the
copy is opened; the link is never kept. Recordings on this device, reached
from a line on the home page and from the page that opens recordings, lists
the copies with their sizes and whether they are finished, shows the space
used and available, and removes one, the finished ones or all of them; a
setting removes each recording when it is finished, after Save and Finish has
saved it. A full device leaves the recording open from memory and offers to
remove finished recordings, signing out offers to remove the copies, and the
interaction log records what was kept and removed by size and count only.

Channels can be coloured by group: Colour channels by, in the Recording tab,
colours each channel's trace and name by its region (frontal, central,
temporal, parietal, occipital), its side (left, midline, right) or its type
(EEG, EOG, ECG, EMG, other), with a legend, using the grouping of the channel
chooser. The four colours are dark enough for 1-pixel traces on white, stay
apart for people with red-green colour blindness, and avoid red, orange, pink,
teal and grey, so that bad channels keep their grey and no colour reads as a
warning. The choice is remembered for each annotator in their browser, and a
study can set the starting choice with the new setting
`display.channel_colours`.

ElectroTag now runs in the web browser only, and the desktop application
has been removed. Annotators open the browser application from a link, sign
in, and open the recordings they were given from their own computer; the page
reads them there, so the EEG is never uploaded, and the study holds only each
recording's fingerprint (its SHA-256 checksum), timing, channels and events.
The browser application does everything the desktop application did, reads
EDF, EDF+, BDF and BrainVision files, and gains an admin area in which lead
researchers add recordings, accounts and assignments, change the study's
settings, prepare reference sets and follow progress and results. Real studies
run on Firebase (sign-in, Firestore in Google's London region and Cloud
Functions that save results with ElectroTag's own code, check training and
score practice, so the experts' answers stay with the study); the ElectroTag
server, `electrotag-web`, runs the local demonstration and suits a study that
prefers its own computer. The commands `electrotag-agreement`,
`electrotag-admin` and `electrotag-activity` work as before on the saved
results, which keep the same folders and files, and `python -m electrotag`
lists them. The `electrotag` command, the stand-alone applications, the
launchers and the self-test are gone, and installing ElectroTag no longer
installs Qt. Version 1.1.0 remains on the Releases page as the last desktop
release, and the results folders it wrote are read by the analyses unchanged.

The admin area has sections for the overview, annotators, recordings,
assignments, training, analyses, results, records and the study's settings.
Lead researchers invite annotators (by an invitation link on Firebase, or with
a temporary password on the ElectroTag server), switch accounts off and on,
and keep notes about people and recordings. Recordings are added from the
administrator's own computer: the browser reads the chosen folder or files,
builds each recording's manifest with the same rules as `electrotag-web
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

ElectroTag works on an iPad, upright or on its side, with fingers or an
Apple Pencil. One finger marks, selects and resizes as the mouse does; two
fingers move through time and the channels, and a pinch shows more or less
time; a long press opens an annotation's menu and a double tap the list of
types. A row of buttons under the EEG does what the keys do on a computer, the
side panel moves below the EEG when the iPad is upright, and buttons are large
enough for a finger. The file picker offers every file, since iPadOS greys out
extensions it does not know such as .edf, and ElectroTag checks what it is
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

ElectroTag can record how annotators work, as research data: every click
and key, what was on screen, every change to the annotations, the dialogs, idle
periods and the training steps, time-stamped in one log per visit (text typed
into fields and passwords are never recorded, and annotators are told when
recording is on). The admin area, or `electrotag-activity`, turns the logs
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

Long annotation sessions are more comfortable. Pause, at the top of the
annotation view, or the key B, stops the clock that measures the time worked
on a recording and covers the EEG with a calm panel until the annotator
resumes; ElectroTag also pauses by itself after a few minutes without input
and when the page is out of sight for more than ten seconds, and says on
return how long the annotator was away. The time worked that is saved with
each recording (`elapsed_s`) and kept in drafts now leaves out every pause,
and the time a guided training step took leaves out the time paused during
it. After a long stretch of work a gentle note offers a break or a reminder
in 15 minutes. ElectroTag keeps track of the parts of each recording that
have been on the screen: the overview bar shows the parts not yet viewed,
the Recording tab and the status line say how much has been viewed, Next part
not yet viewed (the key U, and a button under the EEG on an iPad) goes to the
next of them, and Save and Finish first lists those of at least a second.
What has been viewed is kept with the draft, which reopens exactly where the
annotator left off with a short welcome back, and the header says when the
draft was last kept. A Comfort panel in the Recording tab offers thin, normal
or thick traces, larger channel names and larger text in the side panel,
kept per annotator in the browser. The interaction log records pauses,
resumes, break reminders, the check before saving and the proportion of the
recording viewed (docs/activity_logs.md).

The annotator's home page shows their own progress: recordings done of those
assigned with a thin bar, the time worked in all and the median per recording,
what they have done today, and, after two recordings, an estimate of the time
left at their own pace. An unfinished recording comes first as Continue where
you left off, with how much of it has been viewed and its annotations so far.
`GET /assignments` gives the time worked and the number of annotations of
finished recordings, from the completion register, and a summary of each
draft. Study administrators set the minutes before a break reminder
(`annotation.break_reminder_minutes`, 50), the minutes without input before
the clock pauses itself (`annotation.idle_pause_minutes`, 3) and whether Save
and Finish lists the parts not yet viewed (`annotation.coverage_check`,
`"warn"` or `"off"`) in the admin area's Study settings.

The admin area gives administrators more control of a running study. Its
sections are grouped in a menu under Study, People, Data and Settings, each
group folding away (remembered in the browser for each administrator), with
Find in the header to go straight to a person or a recording and tabs inside
the crowded sections. Annotators can be invited with a private link: on a study
server the link carries a random token that the study keeps only as a SHA-256
hash, works once, expires after 14 days unless the administrator chooses
otherwise, and stops working when a newer link is made, when it is withdrawn,
when the account is given a new password or made an administrator, and when it
is switched off (administrators are given a password, never a link); the person opening it sees a welcome card
with the study and their ID, chooses a password twice and lands on their
recordings (new calls `POST /invite/check` and `POST /invite/accept`, and the
operations `user_invite`, `user_invite_revoke` and `user_add` with `invite`).
On Firebase the link is Firebase Authentication's own. Each person's invitation
shows whether they were invited, accepted or let the link expire, with Copy
link, Email the link (an editable message opened in the administrator's own
email program) and Withdraw, and Add several makes many accounts from pasted
lines of ID, name and email address, checking every line before anything is
made and giving a table of private links to copy or download. A new Progress
section (operation `stats`) shows the recordings done of those assigned,
annotator-hours, the median minutes per recording, completions in the last 7
and 30 days, a projected finish date at the pace of the last 14 days, and a
chart of the completions of each of the last 30 days for the study or one
person, with tables of annotators and recordings that sort, filter and download
as CSV; a person's page lists their work recording by recording with its time,
annotations, date saved and attempts. Times are those the browser measured with
the recording open and not paused. Recordings and accounts can be chosen in
their lists and acted on together (assign, retire, bring back, remove; switch
off or on, new invitation links), with a table of what happened to each;
removing keeps every recording with results and offers to retire it instead.

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

Beside the annotator's own progress, the home page can show game elements: the
annotations made (for interest only), a weekly goal they set themselves, the
whole team's progress, milestones (the first recording and then 10 to 300, days in a row,
recordings viewed in full, from the coverage of what was on the screen, and
the team's share of the study) and an
anonymised leaderboard under pseudonyms made for the study, which each person
may leave. Milestones reward progress and thoroughness, never speed or the
number of annotations, and a milestone reached by Save and Finish is
celebrated briefly without getting in the way. The new `GET` and `POST
/me/achievements` (`et_achievements` on Firebase) give the facts, and the
study settings gain `gamification.enabled`, `gamification.leaderboard` and
`gamification.leaderboard_viewed_only`, with a reminder to report game
elements in a study's methods. The log records `milestone_reached`, `goal_set`
and `leaderboard_visibility`.

On a phone, the sign-in page now says that annotating needs a tablet or a
computer and that administrators can sign in to check progress; an annotator
who signs in on a phone is offered Email me this link and Sign out.

The pages are easier to move around with a screen reader. The annotation view
is the page's main landmark, the admin area's note about the demonstration is
a landmark of its own, every column of buttons in a table has a heading that
screen readers read (Actions), the list of artifact types can take the
keyboard's focus, and the list of reference sets no longer gives its buttons
the role of list items. An automated audit (axe-core) of every page of the
demonstration found nothing after these changes, and a new end-to-end test
(`o_landmarks.e2e.mjs`) keeps the structure it checked.

A design pass over the new views makes them calmer and more consistent. The
parts of a recording not yet viewed are marked on the overview bar by a thin
grey line instead of an amber one, which read as a warning. Switches that are
on, such as Draw/edit and Whole montage, are tinted in the ink-blue accent
instead of black, and the pressed Pause button (Resume) is grey, so that each
view has one black button for its forward action. Big figures stay on one
line: the home page gives the time left as "3 h 15 min" (with "roughly" in the
words under it) and the admin area's Progress gives the projected finish as "3
Nov", with "around then" in its note. On a short screen the paused panel is
more compact and scrolls from its top instead of cutting off its title. The admin
area's Overview says that its count of assignments includes every kind of
work, training too, since Progress counts each kind apart.

Wording is more consistent. Buttons say what they do from their first word:
Choose the downloaded file (after Download the file, when a link cannot be
read) and Go to the first part (in the check before Save and Finish), and
Recordings on this device closes with a plain Close button. Percentages are
written one way throughout ("74%"), as the admin area, the quiz and the
training path already wrote them. The History tab gives the time worked on
each recording in minutes ("5 min") as the progress card does, and the
Recording tab gives it as the paused panel does ("3 min 05 s" rather than
"00:03:05"). The home page's card for an unfinished recording is headed In
progress, so that Continue where you left off is said once, on its button.

Layouts are tidier. In the admin area, the length of new invitation links
stands beside New invitation links with the word "lasting", Add several sets
it on one line as Invitations does, the tables of what happened name their
first column Person or Recording, Find suggests what to type when nothing
matches, and on an iPad held upright Find has a line of its own instead of a
cut-off box. Tables set headings of one and two lines on the same rule, the
leaderboard's own highlighted row has room at both ends, and the annotation
list keeps Start and End whole ("23.000") in the narrower side panel of a
1280-pixel window or an iPad. On a touch screen, text buttons such as Back and
Download my results, the Manage link and the Whole montage and Selected
channels switch are at least 40 pixels tall.

When the demonstration itself cannot be started, the sign-in page says so and
suggests reloading, instead of reporting that "the study server at undefined"
does not answer.

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
