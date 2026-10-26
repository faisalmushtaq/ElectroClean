# User guide for annotators

This guide takes you through an annotation session from start to finish. You
do not need to use Python: start ElectroClean with the launcher your study
administrator gave you (or the `electroclean` command).

## 1. Starting a session

![Start window](images/start_window.png)

**Annotator ID.** Type the identifier your study uses for you, for example
`A01`. It may contain only letters and digits, and it is written in capitals
in every file name (so `a01` and `A01` are the same person). If the study has
a list of annotators, pick yourself from the drop-down list. The display name
is optional and is only stored inside the session files.

**Dataset folder.** Choose the folder that holds the recordings. ElectroClean
looks through it and all its sub-folders for BrainVision recordings whose
header file ends in `_eeg.vhdr`. The window then shows how many recordings it
found and how many you have already completed. The *Results folder* is where
your work is saved (normally `Annotated_Events` inside the dataset folder).
If the line *Study settings* names a study, your administrator has configured
this dataset, for example by fixing the viewing filters or assigning
recordings to you.

**What would you like to do?** Choose *Standard annotation* for research
annotation, or one of the training modes (section 7). Leave *Let me choose the
recording* unticked unless your administrator asks you to choose; normally a
recording you have not yet completed is picked for you.

Press **Begin new session**.

## 2. Viewing options

![Viewing options](images/viewing_options.png)

Before each recording opens you choose the filters used for display. By
default a 1 Hz high-pass filter and a 60 Hz notch filter are applied. Choose
50 Hz if your recordings were made where the mains supply is 50 Hz (as in the
UK). These filters change only what you see: the recording file is never
changed. If your administrator has fixed the filters, the options are shown
but cannot be changed. Tick *Use these settings for the rest of this session*
to skip this window for the next recordings.

Filters with zero phase do not move artifacts in time, but they smear very
sharp events slightly forwards and backwards and distort the first and last
few seconds of the recording and the signal around any break in the
recording. These zones are hatched in grey in the viewer. When you mark an
artifact near them, mark where the underlying event starts and ends.

## 3. The annotation window

![Annotation window](images/annotation_window.png)

The large panel is MNE-Python's EEG browser. Channel names are on the left,
time in seconds along the bottom, and the black overview bar at the bottom
shows where you are in the whole recording (click it to jump). Teal vertical
lines are the **original experimental events** recorded during the session;
they are shown for reference and cannot be changed.

Moving around:

| Key or action | Effect |
|---|---|
| ← / → | Scroll back or forward by a quarter page (with Shift: a full page) |
| ↑ / ↓ | Scroll through channels |
| Home / End (Mac: fn+← / fn+→) | Show less or more time |
| Page Up / Page Down (Mac: fn+↑ / fn+↓) | Show fewer or more channels |
| − / + | Decrease or increase amplitude |
| Click on the EEG | Place a time cursor showing the exact time |
| x | Crosshair showing time and amplitude |
| Scroll bars and overview bar | Move through time and channels |

The toolbar under MNE's toolbar holds ElectroClean's controls. The
*Artifact* menu shows the **active artifact type** by name, and the coloured
box next to it shows its colour with its short code (for example `CHEW`), so
you never rely on colour alone. The menu does not take the keyboard, so the
arrow and page keys always move through the EEG. On a small screen, items that
do not fit at the end of the toolbar (such as *Help*) move into its » menu. The panel on the right lists
every annotation you have made; below it, the *Recording* tab shows details of
the recording, the filters and any warnings, and the *Help* tab repeats these
instructions. The status bar at the bottom always shows the recording, your
ID, the mode, the filters and the number of annotations.

## 4. Marking artifacts

1. Choose the **artifact type** in the toolbar. Only the 16 HED-SCORE
   categories are available, from Chewing-artifact (100) to
   Salt-bridge-artifact (115); hover over an entry to see its definition.
2. Choose what it affects:
   * **Whole montage** marks the interval on every channel.
   * **Selected channels** marks only the channels you choose. Click channel
     names or traces to select or deselect them (they turn magenta), or use
     **Choose channels…**. Clicking a channel in ElectroClean never marks it as
     bad.
3. **Drag** across the EEG from the start to the end of the artifact. The new
   annotation appears as a shaded band labelled with its type; channel-specific
   annotations are shaded more strongly on their channels and carry `[ch]` in
   their label.

You can drag over an existing annotation to add an overlapping one, for
example muscle activity during an eye blink. Overlapping annotations are
always kept separate, even when they have the same type.

Boundaries are snapped to the nearest sample, so what you save is exactly
what the data allow.

## 5. Checking and changing annotations

![Choosing channels](images/channel_dialog.png)

Click an annotation (or its row in the *Annotations* list) to select it. Then:

| To | Do this |
|---|---|
| Resize | Drag its left or right edge |
| Move | Hold Shift and drag the middle |
| Add or remove one channel | Hold Shift and click that channel inside the annotation |
| Change type, edit channels, make whole-montage, delete | Right-click it |
| Delete | Press Delete (or Backspace); with several rows selected in the list, all of them are deleted |
| Set exact start and end times | Select it in the list and press **Edit times…** |
| Merge annotations of the same type | Select them in the list (Ctrl/Cmd-click) and press **Merge** |
| Undo or redo | Ctrl+Z, and Ctrl+Y or Ctrl+Shift+Z (Cmd on a Mac) |

Selecting a row in the list jumps to that annotation. Turn **Draw/edit** off
if you want to inspect the recording without any risk of changing your
annotations: while it is off, nothing can be drawn, moved, relabelled, edited
or deleted, by mouse, keyboard or the panel.

## 6. Saving

When you have reviewed the whole recording, press **Save and Finish**. You
will see a summary of your annotations and be asked to confirm. If you marked
nothing, ElectroClean asks you to confirm that the recording has no artifacts;
that is a valid result.

ElectroClean then writes your results, reads them back to check them, and
only then records the recording as completed by you. If anything goes wrong
(for example the network drive disconnects), you will see a message saying
the recording has **not** been marked complete; your annotations stay open and
you can try again. Afterwards you are asked whether to continue with another
recording or quit.

If you close the window without saving, ElectroClean asks for confirmation.
Your annotations for that recording are then discarded and it stays
incomplete, so it may be offered again later.

**Time.** ElectroClean measures how long you spend on each recording, from
the moment the viewer is ready until you press Save and Finish. The clock is
shown in the *Recording* tab.

**If a recording cannot be opened**, you will see *Failed to load file. Would
you like to continue with another recording or quit?* with the reason under
*Show Details*. The problem is logged for the administrator and that
recording is not offered again until it has been fixed.

## 7. Training and assessment

Your administrator may ask you to practise on reference recordings and then
complete an assessment.

**Training (practise with feedback).** Choose *Training* and the reference set
on the start window. Annotate as usual. After Save and Finish you see how your
annotations compare with the reference: how many reference artifacts you
found, which you missed, which of yours are not in the reference, and where
you chose a different type.

![Practice feedback](images/practice_feedback.png)

Press **Review in the viewer** to see your annotations (`YOU:`) and the
reference (`REF:`) together. The review window is read-only.

![Review against the reference](images/practice_review.png)

**Competency assessment.** Choose *Competency assessment*. You annotate the
assessment recordings without feedback. When all of them are complete,
ElectroClean produces your competency report and tells you where it was
saved.

**Short segments quiz.** Some reference sets include a quiz: you see short
EEG segments, one at a time, and choose the main artifact type in the shaded
part. In the assessment version you see your score at the end. If you close
the quiz window before the end, ElectroClean asks for confirmation and saves
the answers given so far, marked as incomplete.

![Quiz](images/quiz_window.png)

## 8. Questions annotators often ask

*Can two people annotate the same recording?* Yes. Completion is recorded
separately for each annotator, so a recording you have finished stays
available to others.

*I opened the same recording on two computers.* ElectroClean refuses to open a
recording that you already have open elsewhere, to protect your work.

*Where is my work?* In the results folder, under `annotator-<your ID>`, in
sub-folders that mirror the dataset (see the README for the five files).
Training and assessment work is kept separately under `training`.
