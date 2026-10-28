# The admin area

This guide is for the lead researchers who run a study of ElectroClean in the browser. The admin
area is the part of the browser application where you add the study's recordings and accounts,
decide who annotates what, set up the training programme and its reference sets, run the agreement
and activity analyses, follow everyone's progress and keep the study's records. Only administrators
see it.

Everything in the admin area keeps to the rule of the whole application: the EEG stays on the
computers where the files are. When you add recordings, your browser reads them on your own
computer and sends the study only a description of each one (its manifest: the fingerprint of the
data file, the timing, the channels and the original events). Annotators receive the files in
another way, for example on an encrypted drive, and open them in their own browsers.

## Getting in

Accounts with the role of administrator see the admin area. Sign in as usual: an administrator goes
straight to the admin area, and the header offers My recordings to annotate (an administrator can
annotate too) and Admin to come back. The study's administrator accounts are made when the study is
set up (docs/web/firebase.md and docs/web/server.md), and from then on you can make more in the
admin area itself.

The admin area has ten sections, listed on the left (at the top on a narrow screen) in four groups:
Study (Overview, Progress, Results, Analyses and Records), People (Annotators, Assignments and
Training), Data (Recordings) and Settings (Study settings). Each group folds away under its heading
and opens again with the same heading; your browser remembers which groups you folded, for each
administrator, and the section you are in stays in the menu even when its group is folded. Each
section has an address of its own, such as `#admin-recordings`, so the browser's Back and Forward
buttons move between them and a bookmark opens the section again. Find, in the header, goes straight
to a person or a recording: type part of an ID, a name, an email address or a file name, then choose
from the list with the pointer or with the arrow keys and Enter. Crowded sections have tabs of their
own, such as Accounts, Invitations and Add several in Annotators. Annotating needs a computer or a tablet;
the admin area also works on a phone, for a quick look at progress or to switch an account off. On
an iPad, recordings are added by choosing their files (their names become their IDs), since the
iPad cannot choose a whole dataset folder with its paths; that needs a computer. Work in progress carries on while you look at another section: a folder of recordings
being read, or an analysis being computed, is still there when you come back.

When a study records how its annotators use ElectroClean, what you do in the admin area is left out
of that record; the interaction log notes only that the admin area was opened and left.

## Trying it in the demonstration

The demonstration that needs no server (the page published on GitHub Pages, or opened without a
study) has a demo administrator: sign in as ADMIN with the password demo. Everything you change is
kept in your browser, and the annotators of the demonstration see it: an annotator you add can sign
in with the temporary password shown, recordings you assign appear in their list, and the settings
you choose apply when they next open a recording. Invitation links work too, in the same browser:
open one in another tab to see the welcome a new annotator sees. Reset the demonstration, on the
home page, forgets it all.

The demonstration cannot run what needs ElectroClean's Python code: the agreement and activity
analyses, competency reports, consensus and adjudicated references, the example set's files and the
results as one zip file. It says so when you try, and suggests the local demonstration server
(`electroclean-web demo`, where ADMIN has the password electroclean), which runs every part of the
admin area on your own computer.

## Overview

The overview shows the study at a glance: how many recordings are registered, how many annotators
and administrators there are, and how much of the assigned work is done, in progress or still to
do. Below are the latest changes from the study's records and the latest work that annotators
saved. The buttons take you to the most common jobs: adding recordings, adding an annotator,
assigning recordings and following progress.

## Progress

Progress shows how far the study has got and how long the work takes, in three tabs. The study tab
gives the recordings done of those assigned, with their share; the annotator-hours spent; the
median minutes a recording takes; the recordings completed in the last 7 and 30 days; the pace of
the last 14 days; and a projected finish date at that pace. Until at least three recordings have
been completed in those 14 days the projection says there is not enough work yet. Below the figures,
a chart shows the recordings completed on each of the last 30 days, for the whole study or for one
person; move the pointer over it, or focus it and use the arrow keys, to read each day, and open
The numbers, day by day for the same figures as a table.

The Annotators tab has a row for each person: what is assigned to them, done, in progress and still
to do, with the share done as a thin bar; their total time and the median time of a recording; the
median number of annotations they saved in a recording; when they were last active; and how many
recordings they completed in the last 7 days. The Recordings tab has a row for each recording: how
many of the people given it have saved it, the median time it took them, and the median, fewest and
most annotations they saved. A wide spread between the fewest and the most is worth a look, since
it can show a recording that is hard to annotate or a label that people read differently. Every
table sorts by any of its columns (press a column's heading, and again for the other direction),
filters by search and by role, and downloads as a CSV file. Choosing a person opens their page in
Annotators, with their work recording by recording.

The times are those measured in each annotator's browser: the time a recording was open and not
paused, so breaks are left out. Total time and annotator-hours include work in progress (the time
kept with each draft); the medians use saved recordings only. Count chooses the study's own
annotation, which is the default, or all work with the training programme included.

## Annotators

The Annotators section has three tabs. Accounts lists every account of the study with its role,
whether it is active, where its invitation stands, how much of its work is done and when the person
last signed in. Search by ID, name or email, or show only one role or status, and sort by any
column.

To add someone, give their annotator ID (letters and digits, as the study's records name them; it
cannot be changed later), their name if you like, their email address and their role. On a study
on Firebase people sign in with their email address, so it is needed, and the study answers with an
invitation link that lets the person choose their own password. On a study server the person signs
in with their annotator ID, and First sign-in chooses how they get in: a temporary password that
the study makes, a private invitation link, or a password of at least eight characters that you
choose. The link or the password is shown once, with a Copy button: pass it on in a separate message
from the study's address, or in person. Assign recordings to the new person straight away from the
same place.

### Inviting people

A private invitation link lets one person choose their own password and sign in. When they open
it, a welcome card names the study and their annotator ID and asks for the new password twice;
then they are signed in and see their recordings. The link works once. It stops working when it
has been used, when it expires (after 14 days unless you choose 7, 30 or 90), when you make a newer
link for the same person, when you withdraw it, and when the account is switched off or removed. On
a study server the study keeps only a fingerprint of each link (a SHA-256 hash of its random token),
so a link is shown only when it is made; if one was not copied, make a new one, and the old one
stops working. The study's records note every link made and withdrawn, never the link itself.

The Invitations tab shows where each person's link stands: not invited, invited on a date with the
date it expires, accepted, expired or withdrawn. For a link made on this page, Copy link copies it
and Email the link opens a short, friendly message that you can edit, with the link, the person's
ID and the date the link expires; Open in my email then starts a new message in your own email
program, ready to send, and nothing is sent from the study itself. New link makes another link and
Withdraw stops the open one at once. The page builds each link from its own address, so a link made
on the study server's own page opens that page; when the application is served from another site,
the link also names the study server. On Firebase the link comes from Firebase Authentication,
which decides how long it lasts; it cannot be withdrawn, but switching the account off stops the
person signing in.

### Adding several people

Add several makes many accounts at once. Paste one line for each person with their annotator ID,
their name and their email address, separated by commas (a spreadsheet's columns pasted with tabs
work too, and a first line of column names is skipped), then choose Check the list. Every line is
checked before anything is made: IDs that are malformed, taken already or given twice, and email
addresses that are malformed or given twice, are listed by line, and nothing is created until they
are corrected. When the list is right, Create makes each account as an annotator with a private
invitation link, showing how far it has got and what happened to each person. The links then
appear in a table, with Copy all and a download as a CSV file of the IDs, names, email addresses,
links and their expiry dates. Keep the file safe, since each link signs a person in, and send each
link to its person in a separate message.

### Several people at once

Tick people in the Accounts list (the box in the heading ticks everyone the filters show) and a bar
of actions appears above the list: Assign recordings… takes them to Assignments with the people
chosen, Switch off and Switch on change their accounts, and New invitation links makes a fresh link
for each, shown in a table to copy or download as above. The actions run one person at a time with
a line that shows how far they have got, and a table then says what happened to each, with the
reason for anything not done. Your own account is left out of switching off and on and of new
links.

Manage opens a person's page. There you change their name, their role and the notes the study team
keeps about them, reset their password (which shows a new invitation link or temporary password and
stops the old one working), switch the account off and on again, and remove it from the study. A
switched-off account cannot sign in, and its work stays. Removing an account takes away its
assignments and its training programme; its saved results and interaction logs stay with the study.
You cannot change your own role, switch off your own account or remove it: another administrator
does that.

The person's page also chooses their training programme (a trainee works through the chosen
reference set's guided recordings, then its practice recordings, then its assessment) and lists
their work: each recording given to them, with its status, the time it took, the annotations saved,
when it was saved and how many times. The time is the time the recording was open in their browser
and not paused. From the same page you can make a private invitation link for the person.

## Recordings

The Recordings section lists the registered recordings: those of the study and those of each
reference set. Filter the list by where the recordings are, by whether they are in use or retired,
or by name. Manage shows a recording's details (its format, length, channels, file size and
fingerprint, who added it, when and how, and what was found when it was added) with the notes the
study team keeps about it.

### Adding recordings from this computer

Choose the dataset folder with Choose a folder…, or the files of some recordings with Choose
files…. Your browser then reads each recording with the same rules as `electroclean-web register`
on the command line: it finds the recordings among the files (EDF, BDF and BrainVision, the latter
with its .vhdr, .vmrk and .eeg files), works out the fingerprint of each data file, reads the
channels and their types, the original events and the stretches without data, and uses the BIDS
files beside each recording (channels.tsv for channel types and bad channels, events.tsv and its
JSON for the events). The study's settings for hidden channels and channel types apply. A
progress bar shows how far it has got; large recordings take a little while, because every byte of
the data file goes into its fingerprint.

The folder you choose is the dataset folder, and each recording's ID is its path inside it, for
example `sub-001/eeg/sub-001_task-rest_eeg.vhdr`, just as `electroclean-web register` names
recordings. Choose the same folder for every batch, so that the same recording always has the same
ID.

When the files have been read, a table shows what was found: each recording's ID, format, number of
channels and length, with anything the checks noticed (an unusual amplitude, for example), and the
files that could not be read with the reason. Choose where the recordings go, the study or one of
the reference sets, then Add. Only the descriptions are sent, in small groups. The answer lists the
recordings added, replaced and skipped, with the reason for each skipped one. A recording that is
registered already is skipped unless you tick Replace; even then, a recording that someone has
saved results for is replaced only by the very same file (the same fingerprint), so results always
match the file that was annotated. Recordings in a reference set are offered only for training,
never for the study's own annotation.

If you close the page before Add, nothing is registered. If the connection fails part of the way
through, the page says how many recordings were added; choose Add again for the rest, and those
added already are skipped. The `electroclean-web register` command remains for registering from the
command line.

### Notes, retiring and removing

Retire a recording to stop offering it for new assignments; work already assigned stays, and Bring
back into use undoes it. Remove deletes the recording's registration, its description in the study,
after you confirm it on the page; the EEG file itself never reached the study and stays where it
is. A recording that someone has saved, or that a reference set uses, cannot be removed, because
research results are never deleted; retire it instead.

Tick recordings in the list (the box in the heading ticks every recording the filters show) to act
on several at once: Assign to… takes the study's recordings chosen to Assignments, Retire and Bring
back into use change them all, and Remove… removes their registrations after you confirm. Each runs
one recording at a time with a line that shows how far it has got, and a table then says what
happened to each. Removing keeps every recording with saved results or a place in a reference set,
says which were kept and why, and offers to retire them instead.

## Assignments

Assign recordings chooses one or more annotators, one or more recordings (or every recording of the
study, leaving out retired ones), and the mode: Annotation for the study's own work, or a training
mode (guided, practice or assessment) with the reference set the recordings come from. The answer
says how many assignments were new and how many existed already. Annotators see their recordings in
the order the study's selection setting gives (Study settings).

Every assignment lists all of them with the annotator, the recording, the mode, the status and the
last activity, filtered by person, mode, status or recording. Unassign takes an unfinished
recording away from someone after you confirm it; finished work stays with their results. Trainees'
recordings come from their training programme, which you change on their page in Annotators.

## Training

Reference sets hold the recordings and the experts' annotations behind the training programme, the
competency assessment and the short-segment quiz. The experts' annotations stay with the study:
trainees see a reference only where the programme shows it to them (the guided steps, and the review
after a practice recording when the set allows it).

Choose a set on the left, or create one with New reference set (an identifier such as `pilot`, which
cannot be changed, a name and a description). Its page has four tabs.

### Recordings and references

The first tab lists the set's recordings, what each is used for (guided learning, practice or
assessment), where its reference came from and how many annotations it holds. To add a recording,
choose it (it must be registered first, in the study or in this set), choose how it is used, with
no default, because a recording used by mistake for assessment after practice would no longer be
blinded, and choose where its reference comes from. There are four sources.

**Someone's saved annotations.** An expert annotates the recording in the study, in Annotation
mode, and saves it; their saved annotations become the reference. This is the simplest way to make
a reference in a browser study: give the experts accounts, assign them the recording, and add the
reference once they have saved.

**An annotation file.** An ElectroClean `_annotations.json`, for example one an expert saved in
another ElectroClean study. It must be for the same recording (the same sampling rate and length).

**A consensus of several annotators.** Two or more experts annotate the recording and the study
combines their saved annotations, sample by sample and type by type: where enough of them marked an
artifact of a type, the consensus has it. Needed to agree is that number (empty means more than half
of them); Merge gaps joins stretches of the same type separated by less than that many seconds;
Shortest artifact leaves out shorter pieces. Afterwards the page lists every stretch where the
experts disagreed, with who marked it and what the consensus kept, for adjudication; Download the
table (TSV) saves the list.

**An adjudicated consensus.** After reviewing the disagreements, an adjudicator annotates the
recording in the study; their saved annotations become the reference, recorded with the experts
whose disagreements they resolved.

A study recording added to a set is copied into the set, and the copy is offered only for training.
Write a note about the reference (who the experts are, how they worked); it is kept with the record
of where the reference came from.

Manage changes what a recording is used for and, for a guided recording, how much help it gives:
by its place in the set (the first guided recording shows each artifact, the second names it,
later ones only say an artifact follows), or one of these levels chosen for it. When a recording
that trainees have already annotated in training becomes an assessment recording, the page warns
that the assessment is no longer blinded for them. Edit the guided notes writes the note shown with
each of the experts' annotations while a trainee is guided through the recording. Remove from the
set takes the recording and its reference out of the set.

### Settings

The set's name and description; whether trainees are offered a review of each practice recording
against the reference; who may use the set (nobody ticked means everyone); the pass mark for
practice, as the share of the experts' artifacts found and the share of those given the right type;
and when a guided step matches, as how close the start and end must be (in seconds or as a share of
the artifact's length) and how many of the channels must be the same. A set that trainees are
enrolled in, or have saved work in, cannot be deleted.

### Competency criteria

The criteria decide whether a trainee's assessment meets the standard. Each measure (event F1,
sensitivity, precision, kappa and positive agreement over time, positive agreement over time and
channels, the mean overlap of matched events in time and in channels, the share given the same
label, and extra events per minute) can be ticked with a threshold, overall or in every assessed
category. A category is assessed only when the reference has at least the given number of events of
it. Leave every measure unticked to report results without a pass or fail decision. ElectroClean
suggests no thresholds: they depend on pilot data and on how well the experts agree with each other.

### Quiz

The quiz shows short segments of the set's recordings and asks which artifact type is the main one.
Each item names its recording, the start and end of the segment, how much EEG to show around it,
the correct answer and any other answers to accept (where the study's catalogue gives the type's
group term, such as Eye-artifact for an eye blink, one tick accepts that too), and an explanation
shown after each answer when the quiz gives feedback. Annotators allowed to use the set are offered
its quiz.

### The example training set

Create the example training set makes ElectroClean's simulated set (two recordings to learn with the
experts and one to practise on) and offers its recordings as a zip file to give to trainees. It is a
placeholder until your experts' recordings are ready; replace it then.

## Analyses

The study computes the analyses from the saved annotations and the interaction logs, with the same
code as the command-line tools, and sends back a report and its tables. Each report appears in a
frame on the page, separated from the rest of the application, and Download the report (HTML) and
the buttons named after its tables save them. An analysis can take a while on a large study; the
page shows that it is working, and its button cannot be pressed again until the answer arrives.

The **agreement analysis** compares annotators by category, time and channel. Choose the
annotators and the recordings (none ticked means all of them), the kinds of session (usually
research annotation), and whether everyone is compared with one reference annotator (an expert, for
example) rather than every pair with each other. Categories chooses the artifact types; ANY-artifact
(any artifact against none) is always included. Settings of the analysis holds the measures' own
settings, with ElectroClean's defaults: the time bins for the binned comparisons, the share of a bin
an annotation must cover, how events are matched (by overlap, by the closeness of their start and
end, or both) with the overlap thresholds and the main threshold, the tolerances, whether one event
may match several, the channel overlap needed when channels are compared, which channels to leave
out, and when a category has too few annotations for the figures. The defaults are starting points:
choose the settings for your study before you look at its results, report them, and keep The
settings used (JSON) with the report. The reliability guide explains each measure.

The **activity analysis and learning curves** summarise the interaction logs: time spent, clicks
and keys, and how annotators got faster with practice, for everyone or for the annotators ticked.

A **competency report** compares a trainee's assessment recordings with a reference set's
references and criteria, once every assessment recording is saved, and shows whether the criteria
are met; download it as HTML, and its data as JSON.

## Results

Progress lists each person with their work done, in progress and to do, their training programme's
stages and when they were last seen; Work shows their recordings one by one, and Download the table
(TSV) saves the list. Download all results (zip) gives every result of the study in one file: the
annotations in ElectroClean's usual folders (an `_annotations.json`, `_events.tsv`,
`_events.json` and `_session.json` for each recording and annotator), the interaction logs, the
training progress and the reports. When the results are too large to send through the page, the
page gives the command to use instead: on a study server the results are already in the study
folder's `Annotated_Events`, and on Firebase `electroclean-web export` writes them into the same
folders (docs/web/firebase.md).

## Records

The audit log records every change made to the study, in the admin area and with the
`electroclean-web` commands: when, by whom, what was done, and the details. It shows the newest
first; Show older entries goes further back, and the filters show one person's changes or one kind
of change among the entries shown.

Visits lists each time someone signed in and used ElectroClean, newest first, with the mode, when
the visit ended and how many interaction events it logged. When the study records interactions,
each visit has its own log among the results (`interaction_logs`).

## Study settings

The study settings apply to every annotator, from the next time they open a recording or sign in.

**The study's name** is shown on the sign-in page and in the header. **Display filters** choose the
high-pass filter and the notch filter at the mains frequency (50 Hz in the UK and Europe, 60 Hz in
North America), with or without its harmonics. They change only what is shown, never the
recordings. Tick Fix these filters for every annotator for a reliability study, so that everyone
sees the same traces. **The display** chooses how many seconds and channels fill the screen at
first, and the starting amplitude of each channel type in microvolts (the scale bar shows twice the
value); annotators can still change the amplitude, and a recording whose amplitudes are implausible
is shown at a scale of its own, with a warning.

**Channels** lists the channels to hide (headset housekeeping channels, for example; `*` stands for
any characters), the channel types to give by name pattern (EXG1 to EXG8 as EOG, for example), and
whether the channel types and bad channels of the recordings' `channels.tsv` files are used. These
settings shape the manifests of recordings added afterwards; add a recording again with Replace for
a change to apply to it.

**The next recording** chooses the order in which annotators are offered their recordings: at
random among those they have not finished, in a reproducible order made from a seed and the
annotator's ID, or in the order they were assigned. Unfinished work always comes first.
**Annotation** chooses the artifact types on the number keys 1 to 9, in the order the toolbar shows
them, and the shortest annotation in samples. **Interaction log** chooses whether the study records
how annotators use ElectroClean (clicks, keys and what is on the screen, never what they type), how
often the pointer is sampled over the EEG, after how many seconds without input an annotator counts
as idle, and the notice each annotator reads once after signing in; say there what is recorded and
why, as the study's information sheet does.

Save the settings checks them first and says in plain words what to correct, for example a type
given to two number keys.

## When something goes wrong

Every problem is reported on the page where it happened, in plain words: the study's own message
when it refused something (an account that exists already, a recording that has results), or an
explanation when the study could not be reached. Nothing is changed twice: a button that sends a
change cannot be pressed again until the answer arrives, and changes are never repeated
automatically. A study on Firebase can take a few seconds to answer after a quiet period; it is
asked a second time when reading a list fails, and for anything else, wait for the answer before
trying again.

If the page says that the study does not offer a part of the admin area yet, its server or its
Firebase functions are older than the application: update them as docs/web/server.md and
docs/web/firebase.md describe. If your sign-in ends while you work, sign in again: the admin area
opens at the section you were in.
