# Using ElectroClean in the browser

This guide is for annotators. ElectroClean runs in your web browser: you open an EEG recording, mark
the artifacts you see with their type, and press Save and Finish. The recording stays on your own
computer and is read by the web page itself, so the EEG is never uploaded; only your annotations,
and a record of how you used the tools if your study asks for one, go to the study.

## Opening ElectroClean

Your study team sends you a link. Opening it shows the sign-in page of your study, with the study's
name under the heading. If the page says "Demonstration" instead, you are in the demonstration,
which needs no account and keeps everything in your browser (see the last section). If you were
given a study address rather than a link, choose "Taking part in a study? Enter its address" on the
sign-in page, type the address and choose Connect; the browser remembers it next time.

ElectroClean needs a screen the size of a tablet or larger: a computer with a mouse or trackpad and
a keyboard, or a tablet such as an iPad, held upright or on its side (the section "On an iPad"
below describes the touch controls). See "On a phone" below for what a phone shows.

## Signing in

Depending on how your study is run, you sign in with your annotator ID or with your email address,
and the password your study team gave you. Studies that use email addresses offer "Forgot
password?", which sends you a link to choose a new password. You stay signed in until you sign out
or close the browser tab. If your sign-in ends while you are working (after a long break, for
example), the page asks you to sign in again; your unsaved annotations are kept in the browser and
are offered to you when you open the recording again.

When a study records how its annotators use ElectroClean, a short notice says so after you sign in.
The record contains clicks, key presses and what is on the screen, never anything you type.

## Your recordings

The first page has one black button, Open next recording, for the recording to do next. When you
have a recording you started and did not finish, the card is headed In progress and the button
reads Continue where you left off instead, with how much of that recording you have viewed, your annotations so far, the time worked
and when the draft was last kept. Annotators in a training programme go straight to their training
path instead (see below).

Under it, Your progress shows how many of your recordings are done, with a thin bar, the time you
have worked in all and the median time per recording, and what you have done today. After your first
two recordings it also estimates the time left at your own pace so far: the time you took per minute
of recording, applied to the recordings still to do, less the time already spent on unfinished ones.
Recordings differ, so treat it as a guide. All these times leave out the time you were paused. The
time worked today is counted in the browser you work in, so it covers that browser only.

Below that is the list of the recordings assigned to you. It is made for a study in which each
annotator has a couple of hundred recordings. Its tabs
show what is still to do (To do holds every recording you have not finished, started or not, and
In progress only those you have started), what is done, all of them, and your History, each with
the number of recordings it holds. A search field finds recordings by their file name, and Sort
orders the list by the recordings you worked on most recently (unfinished work first), by file
name, or by length. The list shows 25 recordings at a time, with Previous and Next below it. The
tab and the order you chose are remembered in this browser.

## History and revisions

The History tab lists every recording you have saved, the most recent first, with when it was
saved, its version, the number of annotations in it and the time you worked on it (for example "5 min",
as the progress card counts it). When you spot a
problem in a recording you have already finished, choose Open to revise beside it (or in the Done
tab), then open the same file from your computer as you did the first time. Opening a finished
recording with Open a recording from your computer offers Open to revise as well. The recording opens with
the annotations you saved most recently, and a blue banner under its name says that you are
revising it: "Revising version 1. Submitting saves your changes as version 2; version 1 stays as it
was saved."

Change what needs changing, then choose Submit the revision on the banner. Your changes are saved
as a new version beside the earlier one, which is kept exactly as it was, and the time you spend
revising is measured as usual. A revision may fix one place only, so Submit the revision does not
first list the parts of the recording not yet viewed. Analyses of the study use your latest version. Leave without
changes on the banner closes the recording and keeps every saved version as it is. A revision you
close part-way (Close, then Close and revise later) is kept as a draft, and the history says that a
revision is under way; Continue the revision picks it up again. You can revise a recording more
than once: each revision builds on the latest version.

Your study may switch revisions off, for example when the study's design needs each recording to be
annotated once without second thoughts. Saved recordings are then final, and Open to revise does
not appear. Recordings of the training programme keep the programme's own rules.

## Progress and milestones

Many studies also show Goals and milestones beside your progress (your study can switch them off).
It shows the whole team's progress through the recordings it was given and the number of
annotations you have made, for interest only. You can set yourself a goal for the week (a number of
recordings, counted from Monday), and a bar shows how far you are. Each milestone's badge says what
it stands for when you point at it or use a screen reader: a number for recordings saved, a number
over a small calendar for days in a row, a filled disc for recordings viewed in full, and a pie for
the team's share of the study; reached badges have a solid blue ring, the others a dashed grey one.

Milestones mark your progress through the study: your first recording, then 10, 25, 50, 100, 150,
200 and 300 recordings; saving recordings on 3, 5 and 10 days in a row; recordings viewed from start
to end (99 % or more of a recording on the screen, as the Recording tab measures it); and the team reaching a quarter, half,
three quarters and all of its recordings. When Save and Finish reaches a milestone, the message
after saving says so, and a short note with the milestone's badge appears above your milestones; it never stands between you and the next recording. Milestones reward finishing
recordings and looking through them in full. They never reward speed or the number of annotations:
mark what you see, as many or as few artifacts as there are. The number of annotations is shown for
interest only, and a revision does not count as a new recording.

The leaderboard ranks the people in your study by the recordings they have completed (or, in some
studies, by the recordings they viewed in full) and shows the top ten and your own place. Everyone
appears under a pseudonym made for the study, an adjective and an animal such as "Steady Heron", so
nobody sees anyone's annotator ID or name; yours is named above the table and highlighted in it. It
appears once at least three people are on it. Clear Show me on the leaderboard to leave it; you can
come back at any time.

## Opening a recording

ElectroClean asks you to choose the recording on your computer. Choose the file (an EDF or BDF
file), drop it onto the page, or choose the folder that holds it. For a BrainVision recording
choose its three files together (the .vhdr, .vmrk and .eeg), or their folder.

The page then reads the file and works out its fingerprint, a checksum of its contents, which takes
a few seconds for a large file and shows its progress. The fingerprint is what is sent to the study
to recognise the recording; the EEG itself is not. The study's answer appears in plain words. When
the file is the study's copy of one of your recordings, the recording opens. When the file has the
right name, sampling rate, length and channels but its contents differ from the study's copy (it
may have been converted or re-saved), ElectroClean explains the difference and lets you choose
between opening it anyway and choosing the study's copy; ask your study team if you are not sure.
A file that is not part of the study can still be looked at in try-out mode, which is clearly
labelled and saves nothing. A recording of the study that is not yours at the moment, or one you
have already finished, is not opened, and the page says which of the two it is.

If you worked on the recording before without finishing it, ElectroClean offers to restore your
unfinished work, with the number of annotations and the time spent. Choose Restore and continue, or
Start afresh to begin again. A restored draft opens exactly where you left off: the same moment of
the recording, the same channels, amount of time and trace size, and the parts you had already
viewed. A short line at the top of the Annotations tab welcomes you back
with where you were, the annotations kept and the time worked so far.

## Opening a recording from a link

Your study team may keep the recordings in Dropbox or OneDrive and send you a link to each one
instead of the file. Paste the link into Open from a link, under the place where you drop files,
and press Open the link. For a BrainVision recording paste the links of its three files, one per
line. The page fetches the file straight from Dropbox or OneDrive into this browser, showing how
much of it has arrived, and then reads it, checks its fingerprint and opens it exactly as if you
had chosen it on your computer. The file never passes through the study, and the study never sees
the link: the link is not stored, not sent anywhere but to the service that holds the file, and
not written to the interaction log.

To share a file from Dropbox, choose Share on the file itself (not on its folder), make sure the
link is for anyone who has it, and choose Copy link. In OneDrive, choose Share, then Anyone with the
link can view, and copy the link. Links to other web addresses work too when the server that holds
the file allows web pages to read it. Treat a share link as you would the file: anyone who has it
can download the recording until its owner switches the link off, so send it only to the person
who annotates the recording and switch it off when the study no longer needs it.

Some links cannot be read by a web page. Google Drive never allows it, OneDrive for work or
school (SharePoint) usually does not, and a link that is not shared with everyone, has expired or
points to a folder fails too. ElectroClean then says what went wrong in plain words and offers
the next step in the same place: Download the file opens the link in a new tab, where your browser
downloads the file, and then Choose the downloaded file opens the usual file chooser so that you
can pick it from your Downloads folder (on an iPad, Downloads in the Files app). ElectroClean
cannot reach your Downloads folder, so delete the downloaded file there yourself when you have
finished with it: in the Files app on an iPad, press and hold the file and choose Delete; on a
Mac, drag it from Downloads in the Finder to the Bin; in Windows, select it in File Explorer and
press Delete.

## Recordings kept on this device

A recording opened from a link is kept on the device, in this browser's own storage for
ElectroClean, so that it opens again without downloading: the next time you open that recording,
ElectroClean finds the copy, checks its fingerprint as it does for any file, and opens it straight
away. Untick Keep a copy on this device under the link field if you would rather download it each
time. Files you choose on your computer are already on it and are not copied, unless you tick Also
keep files I choose here on this device (useful on an iPad, where the Files app may not keep a
downloaded file to hand). Each copy is filed under your study and your sign-in, so people who share a
computer never see each other's copies, and only the files themselves are kept: never the link they
came from, because a link works as a password for the file. In a private window, and in browsers
that keep nothing for a site, the tick boxes are replaced by a sentence saying that this browser
cannot keep recordings, and recordings open from the link or the computer each time.

The home page says how many recordings are kept and how much space they take, with Manage, and the
page that opens recordings has a button, Recordings on this device…; both show the kept recordings with their
sizes and whether you have finished them, the space this site uses and how much more the browser
allows, and the ways to free space: Remove next to each recording, Remove finished recordings, which
says how much it frees before it does so, and Remove all. Tick Remove a recording from this device
when I finish it to have each copy removed once Save and Finish has saved your work. Removing a copy
never touches your annotations, drafts or results, which the study keeps. When the device is full,
the recording still opens, from memory, and ElectroClean offers to remove the recordings you have
finished. When the first recording is kept, ElectroClean asks the browser to keep the site's storage
even when space runs low (some browsers ask you, others decide for themselves); without that, a
browser short of space may clear the copies, and they are then downloaded again from the link.

When you sign out with recordings kept, ElectroClean asks whether to keep them or remove them.
Keeping them is the default, for your own device; on a computer that others use, remove them. The
copies also go when you clear this site's data in the browser's settings. Files you downloaded
yourself, with Download the file or in any other way, are in your Downloads folder, which
ElectroClean cannot reach: delete those in the Files app, the Finder or File Explorer as described
above.

## The annotation view

The EEG fills most of the window, one channel per row with its name on the left, the time along the
bottom and a scale bar for each type of channel on the right. Above the traces is a band for the
labels of your annotations. Dashed teal lines are the original events of the experiment, which
cannot be changed. Hatched grey stretches mark where the display filters may distort the signal (at
the start and end of the recording and around interruptions) and where the recording has no data.
Below the EEG, the overview bar shows the whole recording with your annotations and the part on
screen; click it to go anywhere.

Two rows of controls sit above the EEG. The first has Draw/edit, Delete, Undo, Redo, the time your
draft was last kept (for example "Draft saved 14:02"), Pause, Help and Save and Finish. The second chooses what you mark next: the numbered type buttons and the menu of all
types after "Draw as", then Whole montage or Selected channels. On the right, the Annotations tab
lists everything you have marked, the Recording tab shows the time you have worked, how much of the
recording you have viewed, the viewing options, your comfort choices and details of the recording,
and the Help tab lists every key. The line at the bottom reminds you of the main keys, shows what
each action did, and on the right says how much of the recording you have viewed and how many
annotations you have made.

## Marking an artifact

First choose the type: press a number key from 1 to 9, click one of the numbered buttons, or choose
from the menu next to them. Press / to search all 29 types by part of their name or by their code
(for example "blink" or "103") and press Enter. Then choose whether the artifact affects the whole
montage or only some channels, with the switch in the second row or the key C. For selected
channels, click their names (or their traces); they turn magenta. Channels… opens a list to choose
from instead.

The list is built for montages of any size. Type in its search field to find channels by name:
names or their beginnings, separated by commas, so that b1 finds B1 and B10 to B19, and a term
that begins no name finds the names that contain it (z finds Fz, Cz and Pz). Put a name in quotes
to find that channel only ("b1"), or use * for any characters (*z). With more than 16 channels, the
channels are laid out in columns, and buttons above them tick a whole group with one click, or
clear it when it is all ticked: the regions (frontal, central, temporal, parietal and occipital)
and sides of a montage named by the 10-20 or 10-10 system, the banks of numbered channels of other
montages (BioSemi's A1 to A32, B1 to B32 and so on, or EGI's E1 to E128 in blocks of 32), and the
types of channel when there are several. Show chosen only lists just the channels ticked.

Then drag across the EEG from the start of the artifact to its end. With the keyboard, point at the
start and press M, then point at the end and press M again. You can scroll in between, which is the
easy way to mark an artifact longer than the screen. The keys [ and ] mark the start and the end
separately, and Esc cancels a started mark. You can also draw first and choose the type afterwards:
click the new annotation and press a number, or double-click it to choose any type.

## Changing annotations

Click an annotation to select it, or pick it in the Annotations list. While annotations are
selected the second row reads "Change to", and a number key, a type button or the menu changes their
type. Esc, a click on empty EEG or a new drag ends the selection, and the row reads "Draw as" again.
N and P select the next and previous annotation and bring it into view.

Drag an edge of an annotation to make it longer or shorter, and hold Shift while dragging its middle
to move it. Shift+click a channel inside an annotation to add that channel to it or take it out.
Right-click an annotation for the common types, Edit channels…, Apply to whole montage and Delete.
Delete or Backspace removes the selected annotation, Ctrl+Z undoes and Ctrl+Y redoes (⌘ instead of
Ctrl on a Mac). When two annotations of the same type on the same channels overlap, they become one
automatically. In the Annotations list you can also edit the start and end times exactly, change the
label of several annotations at once, and merge annotations of one type.

## Moving around the recording

The arrow keys ← and → scroll back and forward through time (with Shift, a whole screen), and ↑
and ↓ scroll through the channels. Home and End show less or more time, Page Up and Page Down show
fewer or more channels, and − and + make the traces smaller or larger. The mouse wheel or a
trackpad scrolls through time, and with Shift through the channels. On a Mac keyboard without
Home, End and Page keys, use fn with the arrow keys.

The Recording tab holds the viewing options: the 1 Hz high-pass filter and the notch filter for
mains interference (50 Hz in the UK and Europe, 60 Hz in North America). They change only what you
see; the file is never changed. Some studies fix these settings, and the tab then says so.

Colour channels by, in the same place, colours each channel's trace and name by its group, which
makes it easier to keep track of where a channel sits in a dense montage. By region, frontal
channels are blue, central green, temporal violet, parietal mauve and occipital blue again (the two
are at opposite ends of the head, and regions that touch never share a colour); by side, channels
on the left (odd numbers) are blue, those on the right (even numbers) green, and the midline (z)
stays black; by type, EOG is blue, ECG green, EMG violet and other channels mauve, and the EEG stays
black. A small legend under the choice says what each colour means and how many channels have it.
The colours only tell groups apart: a bad channel stays grey and is labelled "(bad)", the channels
you select stay pink, and no colour stands for a problem. Regions and sides follow the 10-20 and
10-10 names; a montage named otherwise, such as BioSemi's A1 to D32, stays black by region and side.
ElectroClean remembers your choice in this browser; until you choose, the study's default applies
(none, unless the study team set one).

## Seeing the whole recording

ElectroClean keeps track of the parts of the recording that have been on the screen, so that none
is missed in a long recording. A part counts as viewed once it has stayed on the screen for a moment
while you are working. On the overview bar under the EEG, the parts not yet viewed are white with a
thin grey line above them, and the parts viewed keep the bar's usual warm grey. The Recording tab
and the line at the bottom say how much you have viewed, for example "Viewed 64 %"; stretches where
the recording has no data count as viewed, since there is nothing to see there.

Next part not yet viewed, in the Recording tab, or the key U, takes you to the next part you have
not seen after the screen, coming round from the start when there are none further on, with a
second of what you saw before it. On an iPad it is the last of the buttons under the EEG. What you
have viewed is kept with your draft, so it is still there when you continue later.

## Pausing and breaks

Annotating a recording takes a long time, and the time you work on each recording is part of the
study's results. Press Pause, at the top, or the key B when you step away: the clock that measures
your time stops, your draft is kept, and a calm panel covers the EEG with the time worked so far and
a large Resume button. Press Resume, or B again, to carry on. While you are paused nothing can be
changed by accident.

ElectroClean also pauses by itself in two cases. After a few minutes without any input (three
unless your study chose otherwise), it pauses and says so; the minutes before that pause still count,
since you may have been reading the EEG. When the page is out of sight for more than ten seconds,
because you switched to another tab or app or the iPad locked, it pauses from the moment the page
was hidden. When you come back, the panel says how long you were away and that the time was not
counted.

After a long stretch of work without a break (50 minutes unless your study chose otherwise), a small
note in the corner of the EEG suggests a break. Take a break pauses straight away; Remind me in 15
minutes puts the note away for another quarter of an hour of work. The note never stops you working,
and any pause of five minutes or more counts as a break. The time since your last break carries over
from one recording to the next.

Pausing works the same way in guided training, where the coach waits behind the panel and the time
paused is left out of the time a step took. The short-segment quiz has no Pause, since it measures
how long you take to answer each segment.

## Comfort for long sessions

The Recording tab has a Comfort panel with choices of your own, kept in the browser you use and
applied to every recording you open there. Traces can be thin, normal or thick; thick traces are
easier to follow on a bright screen or from a little further away. Channel names can be normal or
large, and the text of the side panel normal or larger. These choices change only how the EEG and
the panel look, never what is saved. ElectroClean also follows your computer's or iPad's setting
to reduce motion, and announces its messages to screen readers.

## On an iPad

Everything described here works on an iPad, with your fingers or an Apple Pencil, in Safari or
another browser. One finger or the Pencil works as the mouse does: drag across the EEG to mark an
artifact, tap an annotation to select it, drag its edge to make it longer or shorter, and tap a
channel's name or its trace to choose that channel. Two fingers move the EEG: sideways through
time and up and down through the channels; pinch sideways to show more or less time. Press and
hold an annotation for its menu, the one a right-click opens on a computer, which also offers Edit
times… to move it; double-tap it to choose its type from the list of all types. A second finger
that touches the screen while you are marking cancels the mark, so a move never leaves an
annotation behind by accident.

Under the EEG a row of buttons does what the keys do on a computer: back and forward a screen or a
little, more or less time, earlier and later channels, more or fewer of them, and larger or smaller
traces, and the last of them shows the next part not yet viewed. Pause is at the top, as on a
computer. The numbered type buttons, Whole montage and Selected channels, Delete, Undo and Redo are in
the toolbars as on a computer, and a keyboard attached to the iPad works with every key described
here. Held upright, the iPad shows the EEG across its width with the side panel (and the coach in
training) below it; on its side, the panel is beside the EEG as on a computer.

To open a recording, choose Choose a file…, which opens the iPad's file picker (the Files app, with
iCloud Drive, the iPad itself and any drive plugged in). Tap Select in the picker to choose several
files, such as the three files of a BrainVision recording; the iPad cannot choose a whole folder.
Every file can be chosen, and ElectroClean checks that it is a recording of the study. Files you
download, such as your results in the demonstration, go to the Downloads folder in Files.

## Saving

Press Save and Finish when you have looked through the whole recording. If some parts of at least a
second have not been on the screen, ElectroClean first lists them with their times; Go to the first
part takes you to the first of them, and Save anyway goes on, for example when you reviewed them another
way. Your study may turn this check off. ElectroClean then shows how many annotations of each type you
are saving and asks you to confirm; once saved, the recording is complete. You can still revise it
later from your history when your study allows revisions (see "History and revisions"); each
revision is saved as a new version. If you marked nothing, it asks whether to save the recording as
reviewed with no artifacts found. After saving, it offers the next recording.

Your work is saved as a draft while you annotate, in the browser and with the study, so closing the
page by accident loses nothing; the time at the top of the view says when the draft was last kept.
The saved time worked on the recording leaves out every pause. ‹ Close asks whether to close and finish later, which keeps your
annotations and time, or to discard them.

## On a phone

A phone has no room for the EEG traces, so annotating needs a tablet or a computer. On a phone the
sign-in page says so, and administrators can still sign in there to check the study's progress in
the admin area, which works on a phone. If you sign in as an annotator on a phone, the page offers
Email me this link, which starts an email to yourself with the address of the page (and of your
study) to open later on a tablet or computer, and Sign out. Your work waits for you on the larger
screen.

## The training programme

Trainees see their training path: three stages, each with its progress, and one button to continue.
In the first stage, Learn with the experts, a coach on the right takes you through the experts'
annotations of a recording one at a time. In the first recording the experts' annotation is outlined
with a dashed line for you to copy; in the next you find each artifact on the screen yourself. The
coach checks your work after every change and says what to put right (the type, the start, the end
or the channels). When your annotation matches, press Continue (or Enter). Show me places the
experts' annotation for you. Each artifact you match yourself earns up to three stars, fewer after
several tries, and one when you used Show me. Save and Finish becomes available once every artifact
matches.

In the second stage, On your own, you annotate a practice recording without help. After you save
it, ElectroClean shows your score, whether you reached the pass mark, and your annotations next to
the experts', with every disagreement labelled on the EEG: MISSED for an artifact you did not mark,
EXTRA for one the experts did not mark, and TYPE for one you gave another type. The list "What to
look at" takes you to each of them, and N and P step through it.

## The short-segment quiz

Some studies also offer a quiz, listed on your first page (and on the training path for trainees)
with its number of segments and when you learn your results: whether each answer is right,
straight away, or your result at the end. A quiz shows short pieces of EEG, each with a stretch
shaded in blue, and the question "Which artifact type is the main one in the shaded segment?". It
tests whether you recognise the types; marking where an artifact starts and ends is assessed
separately, in whole recordings.

The segments come from recordings of the study, so the quiz first asks you to open them from your
computer, as for annotation: choose the files, drop them onto the page, or choose a folder that
holds them (one folder may hold all of them). Each file is checked against the study's copy by its
fingerprint, and a file whose contents differ is refused with an explanation. The page lists the
recordings the quiz needs and which one it needs now.

Each segment is shown with a few seconds of EEG around it, read only, with the study's filters. The
answers are listed by family, as in the annotation view, with group terms such as Eye-artifact
marked "group: exact type unclear"; some quizzes also offer "No artifact / none of these". Choose
one and press Submit answer. Depending on the quiz, you see straight away whether it was right, with
a short explanation, and press Next segment; or you go on to the next segment and see your result at
the end. Every answer is kept with the study as soon as you send it, together with the time you took
to give it, and cannot be changed afterwards: if you answer a segment on two pages or computers, the
first answer is kept and the page says so. ‹ Stop the quiz offers two choices: Stop for now keeps
your answers so that you can carry on another time from where you stopped, and End the quiz now
finishes it with the score of the segments you answered. At the end ElectroClean shows how many
segments you answered correctly, overall and for each artifact type, and opening a finished quiz
again shows the same result.

## The demonstration

Without a study, ElectroClean runs as a demonstration in the browser. Sign in as A01 to annotate or
as T01 to follow the training programme; the password is demo. Three example recordings with
simulated artifacts are built in: use one straight away, or download them as EDF files and open
them from your computer to try that way too. A demonstration quiz of seven segments from the first
two examples, with feedback after each answer, is on the first page for both accounts; Use the
example recordings opens its recordings without any files. Your results stay in your browser;
Download my results saves them as a file, and Reset the demonstration forgets them. Wherever the
demonstration does what a study's server would do (checking guided steps, scoring practice, storing
results), the page says so.

## If something goes wrong

If the page says the study does not answer, check your internet connection and try again; if it
keeps happening, tell your study team. If a file is not recognised although it should be, make sure
you chose the study's copy of the recording and, for BrainVision, all three of its files. If a link
does not open, download the file with the button ElectroClean offers and choose it, or ask your
study team for a link that anyone with it can open. If your
sign-in has ended, sign in again: your unsaved work is still in the browser.
