# Changes

Each section below describes the changes in one version of ElectroTag;
*Unreleased* collects what has changed since the last release.

## Unreleased

Recordings of every channel count up to 256 (and 257, EGI's nets with their reference) have been
checked in the browser against MNE-Python, through registration, saving, the agreement analysis and
adjudication, on a new synthetic set (`scripts/make_channel_matrix.py`, 31 recordings in every
format, rate, naming scheme and edge case) and on 18 public recordings of 2 to 257 channels. Four
differences were put right. A channel that holds only zeros (an EGI reference or an unused BioSemi
EXG channel) now filters to zeros in the browser, as in MNE-Python, so the amplitude check leaves it
out in both. Digits of other scripts in an `events.tsv` are read as Python reads them. A BrainVision
header that gives one name to several channels, which MNE-Python cannot read, is refused in plain words
at registration and in the browser alike, naming the channels. The browser words the refusal of an
EDF header with a field that is not a number, and of a BrainVision header without channels, as Python
does. On Firebase, a record of the expert work that would not fit in one document as text (an
adjudication of a 256-channel recording with many edited marks, say) is now kept compressed instead of
being refused. The agreement analysis by channel counts only the time bins near each channel's marks,
with exactly the same results, which halves its time on high-density recordings (five real recordings
of up to 256 channels with 200 annotations each: 30 s instead of 68 s). `ELECTROTAG_REAL_EEG` runs the readers, registration and Python checks on a folder of
real recordings; the testing guide says how, and lists the recordings used.

Accounts can now hold several roles: annotator, expert and administrator, as an expert who also
annotates does. The study keeps both the set and the older single role (the first of them), and
studies made before read as they were; on Firebase each person's roles are written into their
sign-in claims, and an expert's or administrator's role counts only when both the claims and the
account in the study grant it. The participant role of a later crowd study is kept but cannot be
given yet, and the IDs ADJUDICATED and REFERENCE cannot be accounts. Experts and administrators reach
a new expert channel (`POST /expert/{op}`, `et_expert` on Firebase), whose first operations let an
expert agree, or no longer agree, to trainees watching replays of their sessions, each change
audited; the corrections, replays, tasks, adjudication and library of later releases are built on it.
Study settings gain three blocks, `review` (corrections and adjudication), `training` (which stages of
the training path may be skipped, never the assessment, and what real study work waits for) and
`replay`, each checked like the others. The study now keeps derived versions of saved work (an
expert's correction, an adjudicated version) with the same journalled save in trees of their own
(`Annotated_Events/derived/`), never anyone's attempt; the results zip and the export include them
and the analyses leave them out. Each visit now keeps an index of
the recordings it opened, and its log can be read in pages. The demonstration has an expert account,
E01, with the password `demo` (`electrotag` on `electrotag-web demo`).

In the admin area, Annotators gives each account its roles with three boxes (Annotator, Expert,
Administrator), shows them in the list and filters by them; an administrator cannot untick their own
administrator role. Study settings has two new cards, Corrections and adjudication (with the rules
for matching two marks and who may watch replays) and The training path. Experts and administrators
reach a new expert area from an Expert work card on the home page or the header's Expert work
button. Its first page explains the area and lets each expert agree, or no longer agree, to trainees
watching replays of their sessions; the corrections, replays, adjudication, library and training
material of the next parts appear in its menu as they are added.

Experts can now correct saved work and replay how it was done. Saved work, in the expert area,
lists the latest saved version of each person's study recordings; Correct opens one from the
expert's computer in the annotation view, with the original drawn as dashed outlines, a panel that
lists every change from it (added, removed, or changed in type, times or channels) with reason chips
and a short note, and Submit the correction, which saves a new version credited to the expert as a
derived version (`derived/corrections/`), never changing the original and saved once however often
it is pressed. Which changes need a reason follows the study's `review.reason_required`. When two
experts correct the same version both corrections are kept and counted, for the adjudication to
compare. Annotators see "Corrected by …" in their list and history and open the corrected version
beside their own, with each change and its reason, when the study shows corrections to them. Replay
plays a person's sessions on a recording back from the interaction log, with play, pause, speed,
steps by event or by change, a scrubber, Skip pauses and Follow the annotator, and says at the end
whether the replay matches the saved version. Experts and administrators may replay anyone; trainees
watch only the sessions of experts who agreed to it, through Watch an expert at work on their
training path (the Learn with the experts stage), and the study checks this for every request. The browser now logs a snapshot of the
annotations a recording opens with (`annotations_snapshot`), sends the session's ID with each save,
and logs work brought back in a tab; the logging notice says that sessions can be replayed. The
results zip and the export hold `corrections/corrections.tsv` and `.json`, and the demonstration does
all of this in the browser.

Corrections and replays after a usability review. Trainees and annotators watch an expert only on
the training recordings for learning with the experts, never on a study recording, which they may hold
or later be given (nor on practice or assessment recordings): the study refuses the list, the replay
and its events otherwise, and gives them one session at a time. When two experts correct the same
version, the annotator sees that the experts disagree and the study is settling it, then the
adjudicated corrected version with the experts' reasons and each decision, and Where the experts
disagreed in their history; never one expert's version alone. The correction view moves to N and P
for the next and previous change (Shift+N and Shift+P select any mark), its reason chips are a radio
group chosen with the arrow keys or their numbers (Shift and a number from anywhere), keep the
keyboard's place when the list is drawn again, offer only the reasons that suit the change (the study
refuses "Not an artifact" for an added mark), and the rows read in plain words. ? shows the keys of
the correction view, the annotator's view of a correction and the replay. The replay's end shows
under the EEG and near the top of its panel, What happened last folds repeated presses, Saved work
shows a correction kept in this browser (Carry on), an administrator in the expert area has Admin
in the header, keyboard hints are left out on touch screens, and the Correct the marks panel no
longer shows a stray "null".

Administrators can now share recordings out as tasks, in a new Tasks section of the admin area
(under People): each recording, or each part of one, goes to 2 to 6 annotators who annotate it
independently, so that their disagreements can be adjudicated. Choose the people, the recordings,
how many people each goes to and the part of each recording (the whole of it, one stretch, or
consecutive parts), then preview the share-out (each person's share, and what is left out and why)
before making it once. The work is shared evenly and the same choices give the same share-out; people
who already have a recording come first for it, and recordings already given to several people can be
turned into tasks as they are. An annotator given part of a recording sees the rest hatched, the view
stays within the part, and a mark outside it is refused, by the study too (422 `outside_window`).
Known-answer recordings from a reference set can be mixed in: everyone chosen gets them, nothing tells
them apart, each save is scored against the reference, and the section lists each person's accuracy on
them. Tasks can be changed (a person replaced), closed, reopened or removed, without any saved result
being lost; the results zip and the export hold them under `tasks/` (docs/file_formats.md). The
demonstration says that tasks need a study server or Firebase.

Disagreements between annotators are now adjudicated the way a systematic review's two screeners
settle theirs. When two or more people have saved the same recording (a recording given to each of
them, a task, or two experts' corrections of the same work), the study lists every conflict, found
with the agreement analysis's matching rules: a mark only some made, different types, starts or ends
far apart, different channels, or a stretch marked as two. In the expert area's Adjudication queue
(also in the admin menu), an expert who annotated none of it opens the recording from their
computer and decides each conflict on the EEG, with each person's marks named and side by side in
lanes above the EEG: keep one version, both, neither, or a mark of their own, with a reason, all by
key (1 and 2, K, X, E, R, Enter, N and P). Decisions are kept as they are made, so the work can be
continued later; finishing saves an adjudicated version beside the originals, which can become a
training reference, and annotators see the outcome of their own conflicts on their home page,
nobody else named, when the study shows it. A new Library lists every conflict, decided or not,
filtered by type, confused pair, kind, status, decision, annotator and recording; each entry opens
at its moment in the EEG, the list downloads as TSV or JSON, and an entry can become a quiz item or
a training snippet that keeps where it came from. The results hold every decision
(`adjudications/decisions.tsv`) and the library (`library/library.tsv`). The sandbox says that this
needs a study server.

Adjudication after a week of use: the outcome each annotator is shown now follows from what was
kept rather than from the letter chosen, so keeping a version without a mark tells everyone who left
the place unmarked that it was decided as they had it, and three or more people are never told
"both"; the card sits near the top of the home page with a line saying in how many places the
expert decided as you had it, and the history says it under each recording. In the adjudication
view the conflict and the decision bar stay at the top of the panel while only the list of conflicts
scrolls (at 1280 by 720 and on an iPad held sideways too), the panel's tabs fold away, the reason
buttons carry their number, as in the correction view, for Shift and a digit and move with the
arrow keys, ? shows the same key sheet as the other expert views, Enter saves from a reason, the focus stays on the view, and a choice not saved stays with its conflict. Marks of
different people can be kept for one conflict (M), the adjudicator may draw up to five marks of
their own, the hint and the key sheet (?) follow the number of versions, and the letters' colours
are told apart more easily. For two experts' corrections, each expert's reason and note are shown
and the version they corrected is drawn dashed. A finished adjudication can be reopened, audited:
its adjudicated version is kept and counts until the newer one is finished. The queue gains a
search, honest counts (parts and corrections beside the recordings, one's own work said apart,
conflicts left), one's own work first, and Make it a training reference…, which Training offers too
as "A finished adjudication" (the older source is now "An adjudicator's own annotations"); the home
page's Expert work card says what waits, and the outcome card also lists a version of yours that
two experts corrected differently, once settled. The library refuses to promote an undecided conflict,
marks what was promoted, and its TSV names the letters and whose marks were kept.

The training path now has five stages: Find your way around, a hands-on tour of the annotation view on
a practice recording made in the browser (each step, from moving through the recording to Save and
Finish, names its keys and is ticked when it is done, and nothing is kept); Meet the artifacts, a
gallery of short examples of each artifact type from the set, with the experts' notes, followed by
the set's quiz as a recognition check; then Learn with the experts, On your own and the Competency
assessment as before. A trainee may skip any stage but the assessment, as the study's training policy
allows (Study settings, Training policy), after a question, and take a skipped stage up again with Do
it after all; every skip is kept with the trainee's progress, logged, and listed in the competency
report. Real study work now waits for a passed assessment by default: a trainee's study recordings
are listed as Locked, with the reason on the home page and the training path, and the study refuses
to open, save or set them aside until the assessment is met (experts and administrators never wait).
After an assessment that did not meet the criteria, the study team reopens the training or gives a
new assessment set from the trainee's page in People, each audited. Training has a Snippets tab for
the study team's own examples, which experts can add too; practice and assessment recordings never
give snippets. On the training path the next step and its button now come first, above the stages.

The agreement analysis can now compare the experts' versions as well as the originals. Versions, in
the admin area's Analyses (`versions` in the operation, `--versions` for `electrotag-agreement`),
chooses the originals as annotated (the default, whose results are exactly as before), the versions
as the experts corrected them (where two experts corrected the same work, the adjudication of their
corrections; until it is finished, that recording is left out and named), or every annotator against
the adjudicated versions as the reference. A task's part of a recording can be compared on its own
(`unit` `task`, `--unit task`), and an adjudicated part always is. Compare with the original
versions shows the key results of both analyses side by side with their difference, and the report
opens with the versions analysed and shows what the corrections changed (by reason, and how far each
corrected file moved from its original) or what the adjudication did (agreement before and after,
conflicts by kind and by pair of types, the decisions, and how much of each annotator's work the
adjudicated version kept), with five new tables. The activity analysis counts expert work in rows of
its own (corrections, adjudication decisions with their time, replays watched), shown in an Expert
work table and left out of the learning curves, and lists the training stages each trainee skipped.
A consensus reference can weight each person, by their accuracy on known-answer tasks or by weights
given, for a later crowd study; without weights it is unchanged. Learn with the experts gains "correct
the marks": a guided recording can open with a copy of the experts' marks with deliberate mistakes
(a mark left out, a confusable type, a moved start or end, a mark where there is none), which the
trainee puts right and saves, then reads which mistakes they fixed and any new ones. Experts and
administrators make the exercise in the expert area's new Correct the marks (from a seed, so every
trainee meets the same one, or from an expert's own flawed annotation file), try it as a trainee
would with a check in the browser, and give it to trainees in Training; the sandbox has one
ready-made exercise to try.

The training path keeps the assessment blind and the record of each trainee whole. A quiz item, like a
snippet, is refused (422 `reveals_answers`) when its recording is a practice or assessment recording
of the set, or of another set that holds the same file, and so is the library's Promote; a quiz that
already holds such an item is left out of the recognition check, offered to experts and
administrators only, and named in Training's Quiz tab until the item is removed; the demonstration's
quiz is now on a guided recording. Giving a trainee a new assessment set carries each learning stage
over as it was, so a stage skipped in the earlier set reads "Skipped in Pilot training set" and is
never counted as done, and the earlier set's skips appear under What happened to the stages and in
the new competency report (`stages_skipped_in`). Each round of the assessment that ends with a
reopening or a new set stays listed, on the trainee's path and on their Training path card in the
admin area with its competency report, and the stages the study team reopens cannot be skipped until
they are done again. A trainee whose assessment did not meet the criteria reads "Assessment not met:
waiting for your study team" on the path, the home page and their locked recordings, which now have
a Locked tab of their own instead of counting as to do; one who passes reads "You passed: your study
recordings are now open" with Open next recording. The tour gives every step in touch words on an
iPad, asks for Redo after Undo so that no mark is lost, and points at artifacts past the filters'
edge zone. Meet the artifacts shows each example at its own time in the recording, without the
hatching, goes from example to example with the arrow keys, keeps its index at full height on short
screens and an iPad held upright, and takes the recognition check with the recordings already open,
coming back to the gallery with its result. Correct the marks ends in a review of the saved marks on
the EEG, with each planted mistake to go to with N and P, and the stage's card keeps the result.
Finished stages can be looked at again, and Watch an expert at work appears only on an open stage
once there is a session to watch.

A changed copy of a recording that is also in a training set (a set made from the study's own
recordings) is now matched by its name and shape, as any other changed copy is; the study's copy and
the set's copy were counted as two recordings, so the file was refused as looking like several.
The sandbox's comparison with the real service found this, and now checks it.

The browser's EEG library has a folder of its own, `js/eeg/`: the readers of
EDF, BDF and BrainVision recordings, the display filters, the fingerprints,
registration and the synthetic recordings moved there from `js/data/`, which
keeps the application's links and copies kept on the device. A guide in the
folder says what each module reproduces of MNE-Python and which tests check
it, and a unit test keeps the folder free of imports from the rest of the
application. Registration now takes the label catalogue from its caller.

The browser application loads each part when it is first needed, keeping its
design without a build step. The sign-in page now loads only itself and the
chosen back end's client: 16 modules and 130 KB of JavaScript for a study
server instead of 61 modules and 807 KB, and 28 modules and 430 KB in the
demonstration instead of 67 modules and 1046 KB, so on a slow 4G connection
the sign-in form is ready after 2.8 seconds instead of 6.4 (4.5 instead of 7.7
in the demonstration). The home page, the annotation view, training, the quiz,
the admin area, the game elements and the EEG readers come with the first view
that uses them; the readers and the annotation view are fetched in idle time
after signing in, so opening a recording does not wait. A page says
"Loading…" while a part is on its way, and a part that cannot be fetched
gives a plain message with Try again. A test keeps the sign-in page within a
budget of JavaScript (docs/web/architecture.md, "Loading on demand").

Work deleted with Discard and close could come back as "Restore unfinished work?" the next time
the recording was opened, when a save of the draft was still waiting or on its way to the study at
the moment it was deleted (a change made just before Close, or an earlier opening closed to finish
later a moment before). A recording's view writes no draft once it has closed, a discard waits for a
draft already on its way and then deletes, and Save and Finish likewise waits for it. The study also
refuses a draft from a browser session that discarded its work and closed, should one still arrive
late (409 `draft_discarded`; the delete names the session, see docs/web/api.md).

The pages around the annotation view were improved after a usability review.
The answer to a chosen file now appears just under the drop zone, scrolled into
view and given the focus, and on a training page it is worded for training
and Back returns to the training path. A study recording chosen on a training
page (or a training recording chosen for study work) opens only after a
question naming both. A connection lost before the page could load its file
readers is reported as such, with Try again, and no longer removes a copy kept
on the device, which is removed only when its files cannot be read as a
recording; the readers now load as soon as someone signs in to a study.
Menus give the focus back to the button that opened them (after Esc, Tab or a
dialog opened from the menu) and use the window's whole height, so the
right-click menu fits a 1280 by 720 screen. The logging notice of a study
server and of the demonstration says that typed text, such as notes and
passwords, is never recorded. An invitation opened on a phone says that
annotating needs a larger screen before the link is used, the invitation email
asks for a tablet or computer, and an expired or replaced link asks the person
to contact the study team who invited them. A study server that answered once
at the page's own address is reported as not answering, rather than replaced
by the demonstration, and the sign-in page no longer shows Connecting beside
that message. The home page's tabs and Open buttons have names for screen
readers, its title names the page, the "Reviewed" line opens the feedback, the
line about today no longer says "no work yet" beside a finished recording, the
next milestone named is one the recordings assigned can reach, the list of
milestones keeps its length at the first save, and the inner pair of column
guides, which crossed headings, is gone. The sign-in page, the home page and
the Help tab link to the annotators' guide.

The admin area was tidied after a hands-on review. The agreement report's
summary gives the recordings analysed, those with annotators to compare, the
annotators and the recordings left out in plain words, where it showed
"[object Object]" and code names. The settings used (JSON) is now the file that
`electrotag-agreement --config` reads, naming the recordings set aside as ones
that cannot be annotated, and the page shows the command
(`electrotag-agreement Annotated_Events --config agreement_settings.json`)
that repeats the analysis on the results zip with the same recordings and the
same numbers; `--config` also reads an earlier `analysis_settings.json`, and
the command gains `--recordings` and `--exclude-recordings`. A small
`annotation_notes.tsv` with the annotators' notes is always sent, even when the
tables of every matched and unmatched event are too large. Progress measures the
pace of a study younger than 14 days over the days since its first completion,
and waits three days before projecting a finish. Registering a file that is byte
for byte a recording registered already, under another ID, is flagged and
skipped unless confirmed, in the page and by the study. Unassign is no longer
offered for a recording set aside as one that cannot be annotated (the study
refuses it too, and the problem report is the place to settle it), and its
question says that work already started is kept. Giving a reported recording to
someone who has it already is refused and leaves the report open; the list of
people marks those who have it, and a resolved report says to whom it was
given. Each section has Help, which opens its part of the administrators' guide
on GitHub, and the analysis settings link to the reliability guide. Saved
reviews can be read: each opens to show its marks and notes, and Results lists
every review of the study with filters. The review mode names the annotator
whose work is reviewed and shows their confidence and note beside each
annotation. The results zip holds the study's settings, its audit log and its
recordings' manifests, with a README that describes it correctly. Study settings
sets the starting channel colours, shows the answer to Save (and Unsaved
changes) in the bar at the foot of the window with the field to correct focused,
and asks before unsaved changes are left behind. Smaller changes: no stray
"null" after a table of results; Remove says what goes with a recording; the bar
of actions on many stays in sight and Switch off asks first; the audit log
names every kind of change, writes settings changes in words with the value
before and after, says Annotation rather than "standard", and records nothing
for a change that changes nothing; passwords and links made one by one stay on
the page; All in Assignments leaves out switched-off accounts and
administrators; the figures of Overview and Progress fill their rows without a
grey block and open the section behind them; the Accounts list has the page's
width; the formats, the reading errors and the count of recordings to add are
clearer, and Assign them… carries the new recordings; reference sets are named
once and the competency report offers the set's trainees first; download
buttons say Download the table (CSV); people who sign in with a password are no
longer shown as not invited; a consensus lists its boundary slivers apart; and
Skip to the section is the first Tab stop.

The annotation view was changed after a hands-on usability check of how annotators work in it.
A draft is never lost to a reflex: Esc or a click beside "Restore unfinished work?" (and "Continue
your revision?") now restores the draft, Start afresh asks a second time ("Delete your unfinished
work?", with Keep them as the safe answer), and Continue where you left off, or Continue in the
list, restores without asking. Work deleted with Start afresh, Discard and close or Leave without
changes is kept in the browser tab until it is closed, and the Annotations tab then offers Bring it
back, which brings back its annotations, time worked and parts viewed as one change that Undo takes
back. The header's Delete, Undo and Redo are greyed out when they have nothing to act on, and
together with Draw/edit wait while the clock is paused (the Pause button then shows a play sign); a
click on them leaves the keyboard with the EEG, so Space or Enter afterwards no longer presses them
again. When drafts stop reaching the study, the top reads "Draft kept in this browser only" on a pale
amber ground and the status line says so once; the draft is tried again a few seconds later and sent
at once when the connection returns, while Save and Finish is never repeated by itself. The channels
of an annotation are changed by selecting it and Shift+clicking a channel anywhere within its time
(also on a row it does not have yet), or, for a channel-specific annotation, by clicking a channel's
name; taking a channel out of a whole-montage annotation leaves the others, the last channel cannot
be taken out, and the channels chosen for new annotations no longer change on the way. In Edit
channels…, choosing a channel in the list or on the map switches from Whole montage to Only these
channels by itself, and both views offer Select all and Clear all. In a study that asks for a rating
on every annotation, the bar now waits beside the new annotation (outlined on the EEG, with its tag
in view) until it is answered with D and a number or a click, while the number keys keep choosing
the type; the request for a rating after D no longer ends by itself either. Draw/edit off reads
"View only" and says so when a drag draws nothing; a plain click on a trace no longer speaks of bad
channels. M, [ and ] mark at the time cursor when the pointer is away from the EEG (G places it, the
, and . keys move it), the EEG has a place in the Tab order, and a mark waiting for its end is shown
at the foot of the EEG with its time to the sample. Moving or resizing an annotation gives its new
times; N with nothing selected starts from the annotation reaching into the screen, and N and P come
round at the ends; Edit times… takes m:ss and h:mm:ss as Go to time does; the coverage check has
Keep annotating and agrees in number; Report a problem chooses no reason in advance; Ctrl+F is left
to the browser's Find; the idle pause says that the minutes before it still count; and messages
count properly ("3 annotations"), say "type" and "the study team", and use the touch words on an
iPad. The help and the guide describe all of this.

Movement-artifact and Chewing-artifact have new colours (#52C493 and #5A1505),
so that the nine types of the numbered buttons stay apart for annotators with
red-green colour blindness; the colours are the same on the type buttons, the
marks, the overview bar and the lists, and annotation files are unaffected.

The annotation view fits more screens. The type buttons always show their
number and short name (1 Blink, 2 HEM and so on), and the toolbar continues on
a second line when the window is too narrow, where the names used to be cut to
bare numbers on most laptops and on an iPad held sideways; screen readers hear
each button's full type. The line at the bottom gives its message two lines, so
that an instruction is read to its end, and keeps how much has been viewed, the
number of annotations and the filters on its right (who is annotating and the
mode are in the Recording tab and the header). With the browser's zoom at 150%
the side panel stays beside the EEG and nothing is drawn over anything else; a
short window scrolls instead. At 200% on a laptop the notice about a larger
screen says how to make room and offers Continue in this window. The
Annotations list keeps room for three or four rows, the break reminder sits at
the foot of the side panel rather than over the EEG, every choice of the
Recording tab is a 40-pixel row on a touch screen with the notch filter's
frequencies set in under it, and text fields show the same focus ring as
buttons.

The EEG is easier to read on dense montages. Channel names are never drawn
smaller than 11 pixels (13 when large): where the rows are shorter, every
second or third channel is named, selected channels are always named and the
row under the pointer is named too. The time axis names its unit, "time (m:ss)"
once the screen reaches ten minutes, keeps tenths of a second on a clock, and no
longer cuts its last label; event labels sit on a white ground over the traces
and keep clear of the scale bars, and the overlay's scale figure moves to the
top of its bar. Show all on a long, dense recording reads it in pieces, draws
each as it arrives with "Reading the EEG… 35%" over the EEG, and keeps a line
saying that the screen is an overview for as long as it lasts; going back does
not wait for the rest. The channel map opens with the whole head in view: on a
128-channel 10-05 cap the electrodes are dots whose names show under the
pointer or the keyboard's focus, and + climbs to the size where every name fits
(on a touch screen it opens at the first size with targets large enough for a
finger, centred on the head).

The guided coach of the training programme now says exactly what to do with the
controls in front of the trainee. Each step lists its actions on lines of their
own: press the type's number (or click the numbered button next to Draw as),
make sure Whole montage or Selected channels is chosen and click the channel
names at the left of the EEG, then drag across the artifact. The feedback says
how to put each problem right with the controls there are: select your
annotation and press the right number for its type, drag the left or right edge
one way or the other for its timing (the lines now start "Start:" and "End:"
rather than "Almost:"), and right-click it for Edit channels… or Apply to whole
montage, or hold Shift and click it on a channel to take that channel off; each
fix changes the annotation already there. The server and the demonstration give
the same words (`step_text` in `electrotag/training/guided.py` and `stepBody` in
`js/training/rules.js`, checked against each other), and on a touch screen the
coach turns them into taps, press and hold and the buttons on screen
(`touchWords` in `js/training/rules.js`). Show me has a key, H; when the coach
holds more than fits, a More below line under it scrolls on; and the Help tab of
a training recording starts with a section on the coach, the stars and the
practice score, with its key table no longer squeezed into half the panel. A
guided step's time, kept as research data, now leaves out the time the recording
was closed: it runs to the trainee's last action before closing and on again
from reopening, on the server and in the demonstration.

The example recordings' eye movements now appear where real ones would: largest
on the horizontal EOG and at F7 and F8 with opposite signs on the two sides,
smaller at Fp1 and Fp2 and fading further back, and the experts' reference marks
them on Fp1, Fp2, F7, F8 and HEOG (the kept registrations of the example set and
the example outputs in `examples/example_output` were made again). The example
set's guided notes now tell trainees what each simulated artifact looks like and
why it is marked on those channels; the hint to replace them with the experts'
explanations is in the admin area's Guided notes, and the server's example set
is called *Example training set (simulated)*.

The practice result now says how the trainee did in plain words, the same from
the study server and in the demonstration: the verdict, the score with what it
is made of ("You found 7 of the experts' 8 artifacts and made 3 marks they did
not make"), what the score measures and then What to look at, with the figures
behind the score (sensitivity, precision and the rest) behind a disclosure. The
practice result's `summary_html` gave way to `counts`, `verdict` and `summary`
(docs/web/api.md). The pass mark reads "a score of at least 80% and the right
type for at least 80% of the artifacts you find", and the practice stage of the
training path gives the best score in the same words, under the chip Not passed
yet until it is passed; practice recordings are counted as tried. The labels of
the review on the EEG are shorter, You, Experts, Missed, Extra and "Should be
…", so that neighbouring ones no longer run into each other. When every practice
recording has been tried without a pass, the one practised longest ago comes
again rather than the one just reviewed, and with a single practice recording the
words say to try that recording again. The training path now shows each stage's
results: a finished assessment shows its result (Criteria met, Criteria not met
yet, or Result to come) with what happens next, and only a met result has the
tick; a stage the programme does not use is marked Not included. Once every
stage is done, signing in opens the home page with Open next recording, the
training path's button is Go to my recordings, the home page counts the study's
recordings apart from the training ones and keeps a line back to the training
path (`GET /me` gives `programme.complete`). The page for opening a training
recording names its stage and says that the study team sends the training
recordings.

The short-segment quiz has a main landmark around its bar and its content, so
that screen readers find it as they find every other page. Enter sends the
chosen answer, the description of the chosen type appears under the list, the
answer sent stays clear among the greyed-out others, and How the quiz works,
above the recordings to open, explains the quiz. A quiz ended early is headed
Quiz ended early and counts the segments answered. The quiz's entry on the home
page and the training path says how far a stopped quiz went, with Continue the
quiz, and a finished quiz has See my result (`GET /me` gives each quiz's
`n_answered`).

The activity analysis (`electrotag-activity` and the admin area) now counts
confidence ratings, notes, problem reports and the feedback on reviewed work.
Each row of `recordings.tsv` gives the ratings given and cleared, the requests
for a rating and how they ended, the checks before Save and Finish in an
every-mark study and the choices made, the notes written and removed, and how
many of the annotations saved had a rating (with the share rated) and a note;
the problems reported from the annotation view and whether one set the
recording aside; and the reviews received, the items of feedback shown and
those the annotator went to. Reading the feedback on reviewed work is now a row
of its own, with `segment` set to `feedback`, and no longer counts as a
recording opened for annotation. `visits.tsv` adds the ratings given, the notes
written, the problems reported (also from the list of recordings) and the
times feedback was shown, and the report has a table of these for each
annotator. The log holds only the length of a note, so the tables count notes
and keep their text out.

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

One command, `electrotag`, now starts every tool of the Python package:
`electrotag web demo`, `electrotag agreement FOLDER`, `electrotag admin ...`
and `electrotag activity FOLDER` pass the rest of the line to the tool, each
explains itself with `--help` under the name it was started by, and
`electrotag` on its own (or `python -m electrotag`) lists the tools and how to
start the demonstration. The tools keep their own names, `electrotag-web` and
so on, which work as before. The guides now use the new form, and the guides
that still named the Firebase functions `ec_` give their names as they are now
(`et_`) and their number, twenty.

The README says plainly that the Python package is installed from the
repository, since it is not on PyPI, and shows the shortest ways to do it: from
a copy of the repository with a virtual environment, `pip install -r
requirements.txt` and `pip install -e .`, with the activation lines for Windows,
macOS and Linux, or straight from GitHub with
`pip install "electrotag @ git+https://github.com/faisalmushtaq/ElectroTag"`.
It also explains why the pinned versions are recommended for a study, and
opens with a Documentation section that sends annotators, the study team,
whoever sets up Firebase or a server, and developers to their own guides.

With Python 3.12, a JSON sidecar with a comma before its closing bracket was
reported in different words from Python 3.13, so a recording registered by
the command line on 3.12 had a manifest that differed from the one the browser
builds, and the browser's tests failed there. Such a sidecar is now reported
in the same words on both versions, and the browser's modules are tested
against Python 3.12 as well as 3.13.

ElectroTag has its own mark: a short stretch of EEG marked as an artifact, the
shaded band with its two edges that the application draws for each
annotation, in a rounded frame. It replaces the earlier circle with a trace
through it in the header and on the sign-in page, and it is now also the
browser tab's icon and the icon an iPad shows when ElectroTag is added to its
home screen, which the application did not have before.

Annotators can rate how confident they are of each mark, and add a short note
to it. The rating is a 5-point scale: 1, not at all confident; 2, slightly; 3,
moderately; 4, very; 5, completely confident. D and then a digit rates the
selected annotation (or the one just made), 0 clears it and Esc cancels; while
ElectroTag waits for the digit the line at the bottom says so and the number
keys do not choose a type. The annotation's menu (a long press on an iPad) has
Confidence, with the five numbers and their meanings and Clear, and five
numbers below the Annotations list rate the selected annotation with one tap.
The tag of a rated mark shows its rating, such as 3/5, marks rated 1 or 2 are
filled more lightly, and a mark without a rating looks as before. Add a note…,
in the menu, below the list or in Edit times…, keeps a note of up to 200
characters, shown by a small note sign with the text as its tooltip. No mark
starts with a rating. The study chooses in its settings
(`annotation.confidence`) whether rating is optional, the default, or asked
for every mark: then the question appears after each new mark, with a small
bar of numbers, and never blocks the work, and Save and Finish lists the marks
left unrated with Rate them and Save anyway. Ratings and notes are kept in
drafts, revisions, undo and redo; overlapping marks that merge keep the lower
rating and both notes. `events.tsv` has two new columns, `confidence` (1 to 5)
and `annotation_note` (`n/a` when not given), described in `events.json`; the
session and annotations files record the study's setting and the count of each
rating, and files written before are still read. The agreement analysis
reports each annotator's ratings and median, agreement again without the marks
rated 1 or 2, and a calibration table of how often marks at each rating were
found by another annotator, in the report and in
`confidence_by_annotator.tsv`, `confidence_sensitivity.tsv` and
`confidence_calibration.tsv`; notes are listed with each matched and unmatched
event and used in no statistic. The interaction log records `confidence_set`,
`confidence_prompt`, `confidence_check` and `note_set`, with a note's length
only, never its text.

The Annotations list in the side panel shows every label in full. Each row
has two lines: the label with its colour across the panel's whole width, and
below it the channels, the rating and note sign, and the start and end in
seconds, on the right. Before, the label had about a third of the panel and
long labels such as Horizontal-eye-movement-artifact were cut short, more so
with a rating or a note. The type's code, which had its own column on wide
screens, is in the row's tooltip with the description. Held upright on an
iPad, the Annotations tab puts its buttons beside the list, so that several
rows stay in view.

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

The channel map uses the recording's own BIDS electrodes.tsv in more cases. A
copy of a recording kept on the device keeps its electrodes.tsv and
coordsystem.json, so that it opens again with the same positions. A recording
opened from a link takes them from links of their own pasted after the
recording's (for Dropbox and OneDrive), and, at a plain web address, from
beside the recording, where ElectroTag asks once for their BIDS names while the
recording opens and uses the standard positions when they are not there or do
not arrive within a few seconds. The interaction log's new `electrode_positions`
event says whether the map used the file or the standard positions, and how
the recording was opened, never the file's name or the link.

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
interaction log records what was kept and removed by size and count only. A
page reads the description of each kept copy once and lists the copies from
what it knows after that, so Safari, which refuses to read files once a page
has started to reload or close, stays free of errors when a person reloads the
home page just as it lists them.

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

The public sandbox now answers as a study server does. A new test sends the
same calls, what a visitor does from signing in to the admin area, to the
study server's own code and to the sandbox's stand-in in the browser, and
compares every answer; the stand-in was brought into line wherever they
differed. In the sandbox, the messages after choosing a file, the refusals of
an annotation that cannot be saved, the coach's feedback ("Press Continue
(Enter) for the next one", "Ctrl+Z (⌘Z on a Mac) to undo") and the admin
area's records now use the server's words; a trainee's list holds only the
recordings of the stages unlocked so far; a practice recording to try again is
offered as such; the quiz carries the training set's name and is offered only
to the annotators the set allows; a guided recording stays where the trainee
left it when its draft is discarded; and the practice review flags a wrong
type on the trainee's own annotation. Reference sets of one's own and their
quizzes need a study server or Firebase, which the sandbox now says, since
only its own training set can run as a programme there. The sandbox keeps its
work under a new name in the browser, so it starts afresh once.

The study team's screens are clearer after a hands-on check of the trainee
path. In Tasks, All leaves out trainees whose study work is locked until they
pass the competency assessment and accounts without the annotator role, the
list marks them, and the preview warns when any of them is chosen; the
share-out now also evens out how many recordings each pair of annotators
shares, which pairwise agreement needs, and the preview says how evenly (with
10 annotators and 200 recordings, each pair shares 4 or 5). After an account
is added, the form goes back to Annotator alone, so an Expert role never
carries over to the next person. A trainee's training path in People is
written for the study team and links to their competency report. The audit
log gives every new kind of change a title and a filter entry, and a decision
on a conflict names whose version it kept. The analysis against the
adjudicated versions no longer warns about known-answer recordings, which are
never adjudicated. In Study settings the stages a trainee may skip sit under
Trainees may skip, and the known-answer setting sits with the other choices
about tasks. Snippet authoring says how long the recording and the snippet
are, and shows the stretch on the EEG from your own copy of the recording. On
a phone, a long status such as "Locked until the assessment is passed" wraps
inside its badge.

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
