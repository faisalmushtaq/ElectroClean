# The admin area

This guide is for the lead researchers who run a study of ElectroTag in the browser. The admin
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
annotate too) and Admin to come back. A person can hold several roles: annotator, expert and
administrator. Experts open the expert area from the Expert work card on their home page or the
Expert work button in the header (see "The expert area" below); an administrator may use it too. The study's administrator accounts are made when the study is
set up (docs/web/firebase.md and docs/web/server.md), and from then on you can make more in the
admin area itself.

The admin area has eleven sections, listed on the left (at the top on a narrow screen) in four groups:
Study (Overview, Progress, Results, Analyses and Records), People (Annotators, Assignments and
Training), Data (Recordings and Problems) and Settings (Study settings). Help, beside each section's
heading, opens that section of this guide in a new tab, and the analyses' settings link to the
parts of the [reliability guide](../reliability_guide.md) that explain them; the guides are read on
GitHub, wherever the application is served from. The first press of Tab offers Skip to the section,
which goes past the header and the menu to the section's heading. Each group folds away under its heading
and opens again with the same heading; your browser remembers which groups you folded, for each
administrator, and the section you are in stays in the menu even when its group is folded. Each
section has an address of its own, such as `#admin-recordings`, so the browser's Back and Forward
buttons move between them and a bookmark opens the section again. Find, in the header, goes straight
to a person or a recording: type part of an ID, a name, an email address or a file name, then choose
from the list with the pointer or with the arrow keys and Enter (on an iPad held upright, Find has
a line of its own under the header). Crowded sections have tabs of their
own, such as Accounts, Invitations and Add several in Annotators. Annotating needs a computer or a tablet;
the admin area also works on a phone, for a quick look at progress or to switch an account off. On
an iPad, recordings are added by choosing their files (their names become their IDs), since the
iPad cannot choose a whole dataset folder with its paths; that needs a computer. Work in progress carries on while you look at another section: a folder of recordings
being read, or an analysis being computed, is still there when you come back.

When a study records how its annotators use ElectroTag, what you do in the admin area is left out
of that record; the interaction log notes only that the admin area was opened and left.

## Trying it in the demonstration

The demonstration that needs no server (the page published on GitHub Pages, or opened without a
study) has a demo administrator: sign in as ADMIN with the password demo. Everything you change is
kept in your browser, and the annotators of the demonstration see it: an annotator you add can sign
in with the temporary password shown, recordings you assign appear in their list, and the settings
you choose apply when they next open a recording. Invitation links work too, in the same browser:
open one in another tab to see the welcome a new annotator sees. Reset the demonstration, on the
home page, forgets it all.

The demonstration also has a demo expert who annotates too, E01 (password demo), whose home page
has the Expert work card.

The demonstration has one reference set, its Demonstration training set, which runs as T01's
training programme: you can change its pass mark, its guided matching, how much help each guided
recording gives and the experts' notes, and T01 sees the change. Reference sets of your own and
their quizzes need a study server or Firebase, and so does what needs ElectroTag's Python code: the
agreement and activity analyses, competency reports, consensus and adjudicated references, the
example set's files, the results as one zip file, and tasks (sharing recordings out, below). The demonstration says so when you try, and
suggests the local demonstration server
(`electrotag-web demo`, where ADMIN has the password electrotag), which runs every part of the
admin area on your own computer.

## Overview

The overview shows the study at a glance: how many recordings are registered, how many annotators
and administrators there are, and how much of the assigned work is done, in progress or still to
do. Below are the latest changes from the study's records and the latest work that annotators
saved. The buttons take you to the most common jobs: adding recordings, adding an annotator,
assigning recordings and following progress. Two further figures count the open problem reports (with the
recordings that cannot be annotated) and the saved recordings that have been reviewed. Each figure
opens the section behind it: Open problems opens Problems, Reviewed the list of reviews in Results,
and so on.

## Progress

Progress shows how far the study has got and how long the work takes, in three tabs. The study tab
gives the recordings done of those assigned, with their share; the annotator-hours spent; the
median minutes a recording takes; the recordings completed in the last 7 and 30 days; the pace of
the last 14 days; and a projected finish date at that pace. In a study younger than 14 days the pace
is that of the days since the first recording was completed, so that a team in its first week is
not shown as slower than it is; the projection waits until three days have passed since then (After
three days of work), because a single day says too little about the pace, and until at least three
recordings have been completed in those days it says there is not enough work yet. Below the figures,
a chart shows the recordings completed on each of the last 30 days, for the whole study or for one
person; move the pointer over it, or focus it and use the arrow keys, to read each day, and open
The numbers, day by day for the same figures as a table. Two more figures count the recordings that annotators
set aside as ones that cannot be annotated, which are kept apart from done and taken from the work
remaining, and the saved recordings that have been reviewed.

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

The Annotators section has three tabs. Accounts lists every account of the study with its roles,
whether it is active, where its invitation stands, how much of its work is done and when the person
last signed in. Search by ID, name or email, or show only one role or status, and sort by any
column.

To add someone, use Add an account below the list: give their annotator ID (up to 32 letters, digits,
hyphens or underscores, as the study's records name them; it cannot be changed later), their name if
you like, their email address and their roles: Annotator, Expert and Administrator, as many as
apply (an expert who also annotates has both). On a study
on Firebase people sign in with their email address, so it is needed, and the study answers with an
invitation link that lets the person choose their own password. On a study server the person signs
in with their annotator ID, and First sign-in chooses how they get in: a temporary password that
the study makes, a private invitation link, or a password of at least eight characters that you
choose; the line under First sign-in says what the choice does. An administrator is always given a
password, so the invitation link is not offered for one. The link or the password is shown once, with
a Copy button: pass it on in a separate message from the study's address, or in person. Each one made
stays listed under the form, the newest first, until you leave the page, so adding the next person
(or a mistake in the next form) never hides it. Assign recordings to the new person straight away
from the same place.

### Inviting people

A private invitation link lets one person choose their own password and sign in. When they open
it, a welcome card names the study and their annotator ID and asks for the new password twice;
then they are signed in and see their recordings. When the study cannot be reached as the link
opens, the card says that the invitation could not be checked and offers Try again, keeping the link
for the browser tab. A link that has been used says so and leads to the sign-in; one that has
expired or been replaced says so and asks the person to contact the study team who invited them for
a new link, for example by replying to the email that brought it. Opened on a phone, the welcome
card says first that annotating needs a tablet or a computer, before the link is used. The link
works once. It stops working when it
has been used, when it expires (after 14 days unless you choose 7, 30 or 90), when you make a newer
link for the same person, when you withdraw it, when you reset the person's password or make them an
administrator, and when the account is switched off or removed. Administrators are given a password
rather than a link, because a link travels by email and must not open the admin area. On
a study server the study keeps only a fingerprint of each link (a SHA-256 hash of its random token),
so a link is shown only when it is made; if one was not copied, make a new one, and the old one
stops working. The study's records note every link made and withdrawn, never the link itself.

The Invitations tab shows where each person's link stands: not invited, invited on a date with the
date it expires, accepted, expired or withdrawn. Someone who was never invited but has signed in
shows Signs in with a password, and Make a link asks first for them, since a link lets them choose a
new password (the present one keeps working until they do). For a link made on this page, Copy link copies it
and Email the link opens a short, friendly message that you can edit, with the link, the person's
ID and the date the link expires, which asks them to open it on the tablet or computer they will
annotate on; Open in my email then starts a new message in your own email
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
of actions appears under the list, staying at the foot of the window while the list is in view:
Assign recordings… takes them to Assignments with the people chosen, Switch off (which asks first,
since it signs people out at once) and Switch on change their accounts, saying for anyone already
in that state that nothing changed, and New invitation links makes a fresh link
for each, lasting as long as the list beside it says, shown in a table to copy or download as above. The actions run one person at a time with
a line that shows how far they have got, and a table then says what happened to each, with the
reason for anything not done. Your own account is left out of switching off and on and of new
links. One action runs at a time: another pressed meanwhile says that the first is still running. The
action carries on while you look at other sections, and its table is there when you come back;
closing or reloading the page while it runs asks you first, since the people not reached yet would
be left as they were.

Manage opens a person's page. There you change their name, their roles and the notes the study team
keeps about them, reset their password (which shows a new invitation link or temporary password and
stops the old one working), switch the account off and on again, and remove it from the study. A
switched-off account cannot sign in, and its work stays. Removing an account takes away its
assignments and its training programme; its saved results and interaction logs stay with the study.
You cannot take away your own administrator role, switch off your own account or remove it: another
administrator does that. A person keeps at least one role, and the participant role of a later crowd
study cannot be given yet.

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
files…. Your browser then reads each recording with the same rules as `electrotag-web register`
on the command line: it finds the recordings among the files (EDF, BDF and BrainVision, the latter
with its .vhdr, .vmrk and .eeg files), works out the fingerprint of each data file, reads the
channels and their types, the original events and the stretches without data, and uses the BIDS
files beside each recording (channels.tsv for channel types and bad channels, events.tsv and its
JSON for the events). The study's settings for hidden channels and channel types apply. A
progress bar shows how far it has got; large recordings take a little while, because every byte of
the data file goes into its fingerprint.

The folder you choose is the dataset folder, and each recording's ID is its path inside it, for
example `sub-001/eeg/sub-001_task-rest_eeg.vhdr`, just as `electrotag-web register` names
recordings. Choose the same folder for every batch, so that the same recording always has the same
ID.

A file that is byte for byte the same as another (the same fingerprint) under another ID, whether a
recording registered already or another file in the same batch, is marked same file as, with the
other recording's ID. Each copy would be assigned and annotated as a recording of its own, which
inflates the counts and the agreement, so copies are skipped unless you tick Add the copies too; the
study checks this as well, whichever way the recordings are sent.

When the files have been read, a table shows what was found: each recording's ID, format, number of
channels and length, with anything the checks noticed (an unusual amplitude, for example), and the
files that could not be read with the reason. Choose where the recordings go, the study or one of
the reference sets, then Add; its button counts the recordings that will be added, leaving out those
registered already (unless Replace is ticked) and copies. Assign them…, afterwards, opens
Assignments with the new recordings chosen. Only the descriptions are sent, in small groups. The answer lists the
recordings added, replaced and skipped, with the reason for each skipped one. A recording that is
registered already is skipped unless you tick Replace; even then, a recording that someone has
saved results for is replaced only by the very same file (the same fingerprint), so results always
match the file that was annotated. Recordings in a reference set are offered only for training,
never for the study's own annotation.

If you close the page before Add, nothing is registered. If the connection fails part of the way
through, the page says how many recordings were added; choose Add again for the rest, and those
added already are skipped. The `electrotag-web register` command remains for registering from the
command line.

### Notes, retiring and removing

Retire a recording to stop offering it for new assignments; work already assigned stays, and Bring
back into use undoes it. Remove deletes the recording's registration, its description in the study,
after you confirm it on the page; the question says how many people it is assigned to, since those
assignments go with it (work in progress is kept by the study and comes back if the recording is
added and assigned again), and suggests retiring it to keep them. The EEG file itself never reached
the study and stays where it is. A recording that someone has saved, or that a reference set uses, cannot be removed, because
research results are never deleted; retire it instead.

Tick recordings in the list (the box in the heading ticks every recording the filters show) to act
on several at once: Assign to… takes the study's recordings chosen to Assignments, Retire and Bring
back into use change them all, and Remove… removes their registrations after you confirm. Each runs
one recording at a time with a line that shows how far it has got, and a table then says what
happened to each. As for people, the bar of actions stays at the foot of the window while the list is in view, one action runs at a time and closing the page meanwhile asks first. Removing keeps every recording with saved results or a place in a reference set,
says which were kept and why, and offers to retire them instead.

## Assignments

Assign recordings chooses one or more annotators (All ticks the active annotators; switched-off
accounts and administrators are ticked one by one), one or more recordings (or every recording of the
study, leaving out retired ones), and the mode: Annotation for the study's own work, or a training
mode (guided, practice or assessment) with the reference set the recordings come from. The answer
says how many assignments were new and how many existed already. Annotators see their recordings in
the order the study's selection setting gives (Study settings).

Every assignment lists all of them with the annotator, the recording, the mode, the status and the
last activity, filtered by person, mode, status or recording. Unassign takes an unfinished
recording away from someone after you confirm it; when they have started it, the question says that
their unsaved work stays with the study and comes back if the recording is assigned to them again.
Finished work stays with their results. A recording that its annotator set aside as one that cannot
be annotated has See the report instead, since it is settled through the problem report (Problems):
returned to their list, or given to someone else. Trainees'
recordings come from their training programme, which you change on their page in Annotators.

## Tasks

Tasks share recordings out so that several people annotate each one independently, as in the
dual screening of a systematic review: each recording, or each part of one, goes to k annotators
(2 to 6), who meet it as one more recording in their own list. Once all of them have saved it, the
differences between their versions are the task's conflicts, which experts adjudicate. Known-answer
recordings can be mixed in to measure each person's accuracy. The section is under People.

**Sharing out.** Choose the annotators to share among (All ticks the active annotators; switched-off
accounts and administrators who do not annotate are ticked one by one), the recordings (every
recording of the study, or those you tick), how many annotators each recording goes to (Study
settings, Corrections and adjudication, sets the starting number), and the part of each recording: the
whole recording, one stretch of each (from and to, in seconds), or consecutive parts of a length you
choose, which may overlap. A share-out can have a name, such as Pilot round, to find its tasks by
later. Preview the share-out works out what would be made without making anything: a sentence such
as "200 tasks, each to 2 people: 400 new assignments. Everyone gets 40.", each person's open tasks
now, their new ones and their total after it, the tasks themselves, and what is left out and why.
Make the tasks is ready once the preview is shown, and any change to the choices asks for the
preview again. The tasks are made once, however often the button is pressed or the answer is late.

Each task goes to the people with the fewest open tasks, so the work is shared evenly, and ties are
settled by a fixed order, so the same choices give the same share-out. Someone who already has the
whole recording comes first for a task of the whole recording, and their assignment joins the task;
they are left out of a task for a part of it, which would shut them out of the rest. Nobody holds two
parts of one recording, so a recording cut into many parts needs at least k people for each part. A
recording that already has an open task is left out. Tick Turn recordings already given to two or
more of these people into tasks to make tasks of assignments as they are, for example those of a
study that began before tasks existed: each such recording becomes a task of the people who have it.

**Parts of a recording.** An annotator given a part sees it named at the top (Your part: 0:20 to
0:40), with the rest of the recording hatched; the view stays within the part and a second either
side, a mark outside it is refused with a plain message, and what counts as viewed is the part
alone. The study refuses a draft or a save with a mark outside the part as well.

**Known answers.** Choose a reference set under Known answers to make known-answer tasks: each
recording of the selection that has a reference in that set goes to every annotator chosen, and
nothing in the annotator's list or view tells it apart from other work. Use a set kept for this,
with references the study trusts and no trainees enrolled in it, since its recordings would
otherwise be familiar. After each save the annotations are compared with the reference, as practice
feedback compares them, and Accuracy on known answers lists each person's number of known answers
saved, their mean score (F1, the balance of artifacts found and marks that match) and how often they
chose the right type. Once a person has saved as many known answers as the study's settings ask
(Corrections and adjudication), a weight appears for combining their marks with other people's. Known-answer
tasks are never adjudicated.

**Every task** lists the tasks with their recording, part, people (each with their letter and where
they stand), how many have saved, and the status: Collecting while some have still to save; All
saved once everyone has (Conflicts to resolve or Agreed once the conflicts are counted); Being
adjudicated and Adjudicated as the experts work through it; Known answer for a known-answer task.
Filter by status or person, or search the recordings and the share-out names. Change people takes
someone out, puts someone in, or replaces one by the other; someone who has saved stays. Close takes
the recording from the lists of those who have not saved it and keeps every saved result; Reopen gives
it back. Remove takes away a task that nobody has saved yet, with its assignments (someone who had
the recording before the task keeps it). Every change goes into the audit log, and the results zip
holds every task and the known-answer scores (docs/file_formats.md). The demonstration shows the
section and says that sharing out needs a study server or Firebase.

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

**An annotation file.** An ElectroTag `_annotations.json`, for example one an expert saved in
another ElectroTag study. It must be for the same recording (the same sampling rate and length).

**A consensus of several annotators.** Two or more experts annotate the recording and the study
combines their saved annotations, sample by sample and type by type: where enough of them marked an
artifact of a type, the consensus has it. Needed to agree is that number (empty means more than half
of them); Merge gaps joins stretches of the same type separated by less than that many seconds;
Shortest artifact leaves out shorter pieces. Afterwards the page lists every stretch where the
experts disagreed, with who marked it and what the consensus kept, for adjudication; differences
shorter than 0.1 s, where the experts' boundaries differ a little, are listed apart under their own
heading, so that the stretches worth adjudicating come first. Download the table (TSV) saves every
row.

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
it. Leave every measure unticked to report results without a pass or fail decision. ElectroTag
suggests no thresholds: they depend on pilot data and on how well the experts agree with each other.

### Quiz

The quiz shows short segments of the set's recordings and asks which artifact type is the main one.
Each item names its recording, the start and end of the segment, how much EEG to show around it,
the correct answer and any other answers to accept (where the study's catalogue gives the type's
group term, such as Eye-artifact for an eye blink, one tick accepts that too), and an explanation
shown after each answer when the quiz gives feedback. Annotators allowed to use the set are offered
its quiz.

### The example training set

Create the example training set makes ElectroTag's simulated set (two recordings to learn with the
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
settings, with ElectroTag's defaults: the time bins for the binned comparisons, the share of a bin
an annotation must cover, how events are matched (by overlap, by the closeness of their start and
end, or both) with the overlap thresholds and the main threshold, the tolerances, whether one event
may match several, the channel overlap needed when channels are compared, which channels to leave
out, and when a category has too few annotations for the figures. The defaults are starting points:
choose the settings for your study before you look at its results, report them, and keep The
settings used (JSON) with the report. Each setting links to the part of the reliability guide that
explains it.

Above the report, a few lines give the recordings analysed, those with two or more annotators to
compare, the annotators and the recordings left out because they were set aside; the key results
are in the report. Besides the tables of the command (the reliability guide lists them), the report
offers `annotation_notes.tsv`, every annotation that carries a note with its annotator, place,
confidence and note, which is always sent, and the confidence tables (`confidence_by_annotator.tsv`,
`confidence_sensitivity.tsv` and `confidence_calibration.tsv`) that the reliability guide's
"Confidence of the annotations" explains. On a large study the tables of every matched and unmatched
event (`events_matched.tsv` and `events_unmatched.tsv`) can be too large to send through the page;
the warning then says so. The settings used (JSON) is the file that `electrotag-agreement --config`
reads, with the recordings left out named in it, so the command shown under the downloads,
`electrotag-agreement Annotated_Events --config agreement_settings.json`, run on the results zip
with the file beside its `Annotated_Events` folder, repeats the analysis with the same recordings
and gives the same numbers, those large tables included.

The **activity analysis and learning curves** summarise the interaction logs: time spent, clicks
and keys, confidence ratings and notes on the annotations saved (counts only, never the text of a
note), problems reported, the feedback on reviewed work that annotators read, and how annotators got
faster with practice, for everyone or for the annotators ticked.

A **competency report** compares a trainee's assessment recordings with a reference set's
references and criteria, once every assessment recording is saved, and shows whether the criteria
are met; download it as HTML, and its data as JSON. The trainee list offers first the people whose
training programme is the set chosen. When the report cannot be made yet, the message says what is
missing and where to look.

## Results

Each person's work lists each person with their work done, in progress and to do (and any that
cannot be annotated), their training programme's stages and when they were last seen; Work shows
their recordings one by one, and Download the table (CSV) saves the list. Reviews lists every review
of saved work, newest first, filtered by annotator, reviewer or mark; open one to read its marks and
notes. Download all results (zip) gives every result of the study in one file: the annotations in
ElectroTag's usual folders (an `_annotations.json`, `_events.tsv`, `_events.json` and
`_session.json` for each recording and annotator), the interaction logs, the training progress, the
reports, the problem reports and the reviews, under `Annotated_Events/`; the study's settings
(`study/electrotag_study.json`), its audit log (`study/audit_log.jsonl`, one change a line, oldest
first) and its recordings' manifests (`study/manifests.json`); and a `README.txt` that says what is
where and how to analyse it. When the results are too large to send through the page, the
page gives the command to use instead: on a study server the results are already in the study
folder's `Annotated_Events`, and on Firebase `electrotag-web export` writes them into the same
folders (docs/web/firebase.md).

## Reviewing saved work

A lead annotator can spot-check a saved recording, annotation by annotation, and the annotator sees
the feedback. Choose Review beside a saved study recording in a person's Work (Annotators, then
the person) or in Results (Work beside the person). Open the recording from this computer, as
annotators do: the EEG never reaches the study, so the browser checks the file's fingerprint
against the study's copy and refuses another recording. The recording opens in the annotation view
in a read-only review mode, with the annotations of the latest saved version drawn as they were
saved; the status line names the annotator whose work it is and the version, and you as the
reviewer.

The side panel lists those annotations, each with what the annotator recorded with it (their
confidence from 1 to 5 and their note, where they gave them), and Agree, Caveat and Comment with an
optional note of up to 300 characters. N and P move from one annotation to the next, A agrees, C adds a caveat, M
a comment, Delete clears the mark and Enter goes to the note; on an iPad the marks are buttons to
tap. To point out an artifact that was not annotated, drag across the EEG over the stretch: it is
listed under Stretches without an annotation with the comment "missed artifact?", which you can
change. An overall note may go with the review. Save the review keeps it, once however often the
button is pressed; Back leaves without saving, after asking when something is marked.

A review is a record of its own, with the reviewer, the time, the version reviewed and each item
(an annotation's ID, or a stretch's start and length, with its mark and note). It never changes the
annotation files, and a recording can have several reviews, by different people or over time. The
person's page lists their reviews, each of which opens to show its marks and notes, Results lists
every review of the study with filters, Progress counts the reviewed recordings, every review is in the
audit log, and the results zip holds a TSV and a JSON file for each. The agreement analyses do not
use reviews. Two settings in Study settings govern them (see below).

## Problems

Annotators can report a problem with a recording instead of saving it as having no artifacts: the
file will not open, it is the wrong recording, channels are flat, missing or disconnected, or it is
too noisy or too short to annotate, with an optional note. They either carry on, or mark the
recording as one that cannot be annotated. Such a recording has the status Cannot be annotated
(`unusable`): it counts as finished for the annotator's progress, is kept apart from Done in
Overview, Progress and Results, and is left out of the agreement analyses, whose report says how
many recordings were left out and why.

Problems, under Data, lists the reports, the open ones first, with filters for open or resolved,
the reason, the person and the recording, and Download the table (CSV). Deal with it… beside an
open report resolves it with a note (for example "replaced the file"), returns the recording to the
annotator's to-do list, which undoes Cannot be annotated and shows the annotator a short line with
your note on their home page, or gives it to someone else, who is assigned the recording. The list of
people to give it to marks those who have it already, who cannot be chosen; the study refuses it too,
and the report stays open, since nothing would change. A report given to someone shows Given to and
their ID. Overview and
Progress count the open reports and the recordings that cannot be annotated. Reports are kept with
the results (the results zip holds them in `problem_reports/`), are in the audit log and are never
deleted.

## Records

The audit log records every change made to the study, in the admin area and with the
`electrotag-web` commands: when, by whom, what was done, and the details. It shows the newest
first; Show older entries goes further back, and the filters show one person's changes or one kind
of change among the entries shown, problem reports and reviews included. A change of the study
settings is written in words with the value before and after, for example "allow reviews
(annotation) from on to off", and a change that changes nothing (switching off an account that is
off already) is not recorded.

Visits lists each time someone signed in and used ElectroTag, newest first, with the mode, when
the visit ended and how many interaction events it logged. When the study records interactions,
each visit has its own log among the results (`interaction_logs`). An administrator's visit is
marked as such: what they do in the admin area is never logged, only the annotating they do.

## Study settings

The study settings apply to every annotator, from the next time they open a recording or sign in.

**The study's name** is shown on the sign-in page and in the header. **Display filters** choose the
high-pass filter and the notch filter at the mains frequency (50 Hz in the UK and Europe, 60 Hz in
North America), with or without its harmonics. They change only what is shown, never the
recordings. Tick Fix these filters for every annotator for a reliability study, so that everyone
sees the same traces. **The display** chooses how many seconds and channels fill the screen at
first, the starting choice of channel colours (none, by region of the head, by side or by channel
type, in a palette checked for colour-blind readers; `display.channel_colours`), and the starting
amplitude of each channel type in microvolts (the scale bar shows twice the value); annotators can
still change the colours and the amplitude for themselves, and a recording whose amplitudes are
implausible is shown at a scale of its own, with a warning.

**Channels** lists the channels to hide (headset housekeeping channels, for example; `*` stands for
any characters), the channel types to give by name pattern (EXG1 to EXG8 as EOG, for example), and
whether the channel types and bad channels of the recordings' `channels.tsv` files are used. These
settings shape the manifests of recordings added afterwards; add a recording again with Replace for
a change to apply to it.

**The next recording** chooses the order in which annotators are offered their recordings: at
random among those they have not finished, in a reproducible order made from a seed and the
annotator's ID, or in the order they were assigned. Unfinished work always comes first.
**Annotation** chooses the artifact types on the number keys 1 to 9, in the order the toolbar shows
them, and the shortest annotation in samples. Under Long sessions it also sets three comforts for
annotators who work for hours: after how many minutes of work since their last break they are
offered a break (50 by default), after how many minutes without any input the working-time clock
pauses itself (3 by default), and whether Save and Finish first lists the parts of the recording that
have never been on the screen, with Go to the first part and Save anyway (on by default). A value of 0
turns the reminder or the pause off. The time annotators work on each recording is research data,
and it always leaves out the time they were paused, whether they pressed Pause, stopped giving input
or left the page out of sight for more than ten seconds; the annotators' guide describes what they
see.

**Annotation** also chooses how confidence is asked for (`annotation.confidence`). Annotators can
always rate their confidence in a mark on a 5-point scale, from 1 (not at all confident) to 5
(completely confident), and add a short note to it; the annotators' guide describes how. No mark
starts with a rating. With **Optional** (`"optional"`, the default) annotators rate a mark only when
they wish, which costs them nothing; the saved files hold `n/a` for a mark without a rating. With
**Every mark** (`"every_mark"`) annotators are asked for a rating after each new mark, answered with
one key or tap, and Save and Finish lists the marks left unrated, with Rate them and Save anyway; the
question never blocks their work. The setting is recorded in each saved result, and the analyses
report each annotator's ratings, agreement for all marks and again without the marks rated 1 or 2,
and whether marks rated higher are found more often by other annotators (see the
[design decisions](../design_decisions.md), "Confidence and notes").

**Annotation** also chooses whether annotators may revise recordings they have
finished (on by default; `annotation.allow_revisions`). A revision is saved as a new attempt of the
same assignment beside the earlier files, which stay exactly as they were; the completion register
gains the new attempt, and the analyses and exports use each annotator's latest attempt. Switch
revisions off when the study's design needs each recording to be annotated once and then left.

**Annotation** also chooses whether administrators may review saved recordings
(`annotation.allow_reviews`, on by default) and whether annotators see the reviews of their work
(`annotation.show_reviews_to_annotators`, on by default). Switch the second off for blind reviews,
when the study does not want feedback to change how its annotators work; the reviews are still
kept and exported.

**Game elements** (`gamification.enabled` and `gamification.leaderboard`, both on by default) add,
beside the annotator's own progress on the home page, the number of annotations made (for interest
only), a goal for the week, the team's progress, milestones, and an anonymised
leaderboard on which each annotator appears under a pseudonym and may choose to be hidden. Rank the
leaderboard by recordings viewed in full (`gamification.leaderboard_viewed_only`) to reward
thoroughness over completion. The milestones reward finishing recordings and viewing them in full,
never speed or the number of annotations, so that nothing pushes annotators to mark more than they
see. Game elements may still change how people work, so a study that uses them should say so in
its methods, with the settings it used; switch them off, or the leaderboard alone, when the study
needs annotators who are not nudged at all.

**Corrections and adjudication** (the `review` block) chooses whether experts may correct saved
work, whether annotators see the corrections of their work with the reasons, and whether they see the
decisions on the conflicts in their work (all on by default). It also sets how many annotators each
task goes to (2 by default), when an adjudicator gives a reason for a decision, the rules by which two
marks count as the same (matched by overlap, by start and end within tolerances, or both; the overlap
needed; the tolerances; and the share of channels in common), and how many known-answer items a
person's accuracy needs before it weighs their marks. These choices apply to the expert area's
corrections, tasks and adjudication as the study offers them. Under **Replays** it chooses whether
experts and administrators may replay annotators' sessions step by step from the interaction log,
and whether trainees may watch the sessions of experts who have agreed to it; each expert gives or
withdraws that agreement in the expert area. Replays use the interaction log for teaching and for
checking work, so say so in the study's information for participants and check that the ethics
approval covers it.

**The training path** (the `training` block) chooses the stages a trainee may skip (the tour, the
snippets, learning with the experts and practice; the blind competency assessment never), what real
study work waits for (a passed assessment, by default, a finished one, or nothing; experts and
administrators never wait), whether the path begins with a tour of the platform, and whether the
snippets stage needs its recognition check finished. The study keeps these choices now, and the
five-stage training path follows them once it is in place.

**Interaction log** chooses whether the study records
how annotators use ElectroTag (clicks, keys and what is on the screen, never what they type), how
often the pointer is sampled over the EEG, after how many seconds without input an annotator counts
as idle, and the notice each annotator reads once after signing in; say there what is recorded and
why, as the study's information sheet does.

Save the settings, in the bar that stays at the foot of the window, checks them first and says in
plain words, in that bar, what to correct (for example a type given to two number keys), with the
field concerned marked and focused. The bar says Unsaved changes while there are any; leaving the
section with unsaved changes asks first (Leave without saving, or Stay here), and so does closing or
reloading the page.

## The expert area

Experts, and administrators, open the expert area from the Expert work card on their home page
(My recordings, for an administrator); an expert also finds Expert work in the header. My
recordings in the expert area's header leads back.
Its menu lists the parts of the expert work the study offers, and its Overview says what the area is
for. Expert work is logged like annotation work, while the admin area is not.

**Your sessions for teaching.** The study team can replay any annotator's session, step by step,
from the record of how they worked. Trainees may watch an expert's sessions only when that expert
agrees: tick Let trainees watch replays of my sessions and press Save my choice, and untick it to
withdraw. Each expert decides for their own sessions only; the study's audit log keeps every change,
and a save that changes nothing writes nothing. When the study's settings do not show experts'
sessions to trainees (Study settings, Replays), the choice is kept for when they do.

## Adjudication

Adjudication settles the disagreements between annotators the way a systematic review settles
those between its two screeners. When two or more people have annotated the same recording, each
on their own, ElectroTag compares their versions with the agreement analysis's matching rules (the
study's settings, under Corrections and adjudication) and lists every **conflict**: a mark
only some of them made, different types, a start or end further apart than the tolerance,
different channels, or a stretch one person marked as two. An expert who annotated neither version
decides each conflict, and finishing saves an **adjudicated version**. Adjudication is not
blinded: you see who made each mark, which is why nobody adjudicates their own work. The versions
compared are never changed.

The **queue** (Adjudication in the expert area's menu, and in the Study group of the admin area's
menu) lists what can be adjudicated: each study recording given to two or more people, each task
once its annotators have saved, and each saved recording that two or more experts have corrected,
so that their corrections are settled before the corrected version is used. Its tabs show what is
Ready (everyone has saved and there are conflicts), In progress, Finished, and Waiting (someone has
not saved yet, or everyone agrees); each row has its annotators, the number of conflicts and how
many are decided, and the adjudicator. **Start** asks for the recording's file on this computer,
checks it against the study's copy, and starts the adjudication: from then on the versions
compared stay as they were when it started, even if someone revises their work, so that the
decisions keep their meaning. **Continue** takes you back to your own adjudication where you left
it, because every decision is kept by the study as you make it.

In the **adjudication view** every version is drawn on the EEG with its letter before the type (A:
Eye-blink-artifact, B: Eye-movement-artifact), each letter in its own colour, and the lanes above
the EEG put each person's marks side by side on the same time axis, named. The side panel shows
the current conflict (its kinds and what each person marked, with their confidence and note), the
decision bar, and every conflict in the order of the recording, with a tick once it is decided.
Decide with the keys or the buttons:

| Key | What it does |
| --- | --- |
| 1 to 6, or A to D | keep that person's version of the conflict |
| K | keep both (with more than two people, keep all): one mark of each type, spanning its marks |
| X | keep neither |
| E | edit: replace the marks with one of your own (its type, start and end, and channels; or drag across the EEG to set the times) |
| R | write the reason |
| Enter | save the decision and go to the next conflict not decided yet |
| S | skip to the next conflict not decided yet |
| N and P | the next and the previous conflict |
| T | the lanes: every version, then each one alone (the EEG follows) |
| F | finish the adjudication |

Give a reason with a decision by choosing one (Clear artifact, Not an artifact, Type shows in the
EEG, Start and end show, Channels show, Both are valid, Other) or writing a few words, as the
study's setting **A reason for each decision** asks: for every decision, only when keeping
neither version or editing a mark, or never. Each decision is sent to the study on its own and kept at once; the bar waits while it is
sent, and you can change a decision until you finish. **Finish adjudication** appears once every
conflict is decided, and saves the adjudicated version: the marks everyone agreed on (each at the
middle of their starts and ends, on the channels most of them cover) and your decisions. It is
saved like any result, with its five files, under `derived/adjudications/` in the results, and
the annotators then see the outcome of their own conflicts when the study shows it to them
(Study settings, Corrections and adjudication). A finished adjudication of a whole
recording can become a training reference (`adjudication_reference`, or Source adjudication when
adding a reference), with the people compared as its experts and you as its adjudicator.

In the sandbox the queue says that adjudication needs a study server: comparing versions needs
ElectroTag's own Python code. Run `electrotag-web demo` to try it on this computer.

## Library

The library holds every conflict between annotators, decided or not: from the adjudications, and
from the recordings that wait for one. It is worked out afresh each time from the adjudications,
so it always shows the decisions as they stand. Filter it by artifact type, by the **confused
pair** (an eye blink against an eye movement, say), by the kind of conflict, by status (Not
started, Open, Decided) and decision, by annotator and by recording, or search the reasons. Each
row says where the conflict is, its kinds, the types involved, who marked what, and the decision
with its reason.

**Open at this moment** opens the recording from this computer at the conflict, read only, with
every version, the lanes and the decision. **Download TSV** and **Download JSON** save the list as
filtered (the results zip holds the whole library as `library/library.tsv`, and every decision in
`adjudications/decisions.tsv`). **Promote…** makes an entry a quiz item or an artifact snippet of a
reference set: the type, times and explanation start from the decision and its reason, and you can
change them. The item keeps a note of the conflict it came from, and promoting the same entry to
the same set again gives the item made before.

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
