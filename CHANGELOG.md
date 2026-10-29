# Changes

Each section below describes the changes in one version of ElectroClean;
*Unreleased* collects what has changed since the last release.

## Unreleased

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

Long annotation sessions are more comfortable. Pause, at the top of the
annotation view, or the key B, stops the clock that measures the time worked
on a recording and covers the EEG with a calm panel until the annotator
resumes; ElectroClean also pauses by itself after a few minutes without input
and when the page is out of sight for more than ten seconds, and says on
return how long the annotator was away. The time worked that is saved with
each recording (`elapsed_s`) and kept in drafts now leaves out every pause,
and the time a guided training step took leaves out the time paused during
it. After a long stretch of work a gentle note offers a break or a reminder
in 15 minutes. ElectroClean keeps track of the parts of each recording that
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
otherwise, and stops working when a newer link is made, when it is withdrawn
and when the account is switched off; the person opening it sees a welcome card
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
/me/achievements` (`ec_achievements` on Firebase) give the facts, and the
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
grey line instead of an amber one, which read as a warning. Big figures stay on
one line: the home page gives the time left as "3 h 15 min" (with "roughly"
in the words under it) and the admin area's Progress gives the projected
finish as "3 Nov", with "around then" in its note. Buttons say what they do
from their first word: Choose the downloaded file (after Download the file,
when a link cannot be read) and Go to the first part (in the check before Save
and Finish). Recordings on this device closes with a plain Close button. In the admin
area, the length of new invitation links stands beside New invitation links
with the word "lasting", Add several sets it on one line as Invitations does,
the tables of what happened name their first column Person or Recording, Find
suggests what to type when nothing matches, and on an iPad held upright Find
has a line of its own instead of a cut-off box. On a touch screen, text
buttons such as Back and Download my results, the Manage link and the
Whole montage and Selected channels switch are at least 40 pixels tall, and
the pressed Pause button (Resume) is grey, leaving the black Resume on the
paused panel as the one forward action. The History tab gives the time worked
on each recording in minutes ("5 min"), as the progress card does, the
leaderboard's own highlighted row has room at both ends, and the annotation
list keeps Start and End whole ("23.000") in the narrower side panel of a
1280-pixel window or an iPad. On a short screen the paused panel is
more compact and scrolls from its top instead of cutting off its title. The
home page's card for an unfinished recording is headed In progress, so that
Continue where you left off is said once, on its button, and the admin
area's tables set headings of one and two lines on the same rule. Percentages
are written one way throughout ("74%"), as the admin area, the quiz and the
training path already wrote them, where the new views had "74 %". The
Recording tab gives the time worked as the paused panel does ("3 min 05 s"
rather than "00:03:05"). Switches that are on, such as Draw/edit and Whole
montage, are tinted in the ink-blue accent instead of black, so that the
annotation view has one black button, Save and Finish.

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
