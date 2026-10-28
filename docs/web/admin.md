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

The admin area has nine sections, listed on the left (at the top on a narrow screen): Overview,
Annotators, Recordings, Assignments, Training, Analyses, Results, Records and Study settings. Each
has an address of its own, such as `#admin-recordings`, so the browser's Back and Forward buttons
move between them and a bookmark opens the section again. Unlike annotating, which needs a computer
screen, the admin area also works on a tablet or phone, for a quick look at progress or to switch an
account off. Work in progress carries on while you look at another section: a folder of recordings
being read, or an analysis being computed, is still there when you come back.

When a study records how its annotators use ElectroClean, what you do in the admin area is left out
of that record; the interaction log notes only that the admin area was opened and left.

## Trying it in the demonstration

The demonstration that needs no server (the page published on GitHub Pages, or opened without a
study) has a demo administrator: sign in as ADMIN with the password demo. Everything you change is
kept in your browser, and the annotators of the demonstration see it: an annotator you add can sign
in with the temporary password shown, recordings you assign appear in their list, and the settings
you choose apply when they next open a recording. Reset the demonstration, on the home page, forgets
it all.

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

## Annotators

The Annotators section lists every account of the study with its role, whether it is active, how
much of its work is done and when the person last signed in. Search by ID, name or email, or show
only one role or status.

To add someone, give their annotator ID (letters and digits, as the study's records name them; it
cannot be changed later), their name if you like, their email address and their role. On a study
on Firebase people sign in with their email address, so it is needed, and the study answers with an
invitation link that lets the person choose their own password. On a study server the person signs
in with their annotator ID; give a password of at least eight characters, or leave it empty and the
study makes a temporary password. The link or the password is shown once, with a Copy button: pass
it on in a separate message from the study's address, or in person. Assign recordings to the new
person straight away from the same place.

Manage opens a person's page. There you change their name, their role and the notes the study team
keeps about them, reset their password (which shows a new invitation link or temporary password and
stops the old one working), switch the account off and on again, and remove it from the study. A
switched-off account cannot sign in, and its work stays. Removing an account takes away its
assignments and its training programme; its saved results and interaction logs stay with the study.
You cannot change your own role, switch off your own account or remove it: another administrator
does that.

The person's page also lists their assignments with the status of each, and chooses their training
programme: a trainee works through the chosen reference set's guided recordings, then its practice
recordings, then its assessment.

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
back into use undoes it. Remove deletes the recording's description from the study after you
confirm it on the page. A recording that someone has saved, or that a reference set uses, cannot be
removed; retire it instead. Removing never touches the file on your computer.

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
