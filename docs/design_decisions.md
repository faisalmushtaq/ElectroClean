# Design decisions

This document records how the specification was interpreted: what MNE-Python
already provides, what had to be added, the ambiguities and data-integrity
risks that were found, how each was handled, and the decisions that need the
research team. ElectroTag began as a desktop application and has run in the
browser since 28 October 2026 (see "Web-only" below); the sections written for
the desktop application are kept as the record of how the rules came about,
and the rules themselves apply unchanged in the browser.

## What MNE-Python provides and what ElectroTag adds

The table describes the Python core, which registers recordings and writes
the results. The browser application reads, filters and shows the annotator's
copy itself, reproducing MNE's results ([web/architecture.md](web/architecture.md)).

| Need | Provided by MNE | Added by ElectroTag |
|---|---|---|
| Reading BrainVision | `mne.io.read_raw_brainvision` (resolves `.eeg` and `.vmrk` from the header) | Pre-checks of companion files and data-file size; treating MNE's "markers outside data range" and "marker file not found" warnings as failures |
| Reading EDF, EDF+ and BDF | `mne.io.read_raw_edf`, `read_raw_bdf` (EDF+ annotations become `raw.annotations`) | A check of the header against the file size, because MNE silently infers the number of data records from the size when they disagree; refusing EDF+D; hidden headset channels; `BAD_ACQ_SKIP` stretches treated as gaps |
| BIDS sidecars | (MNE-BIDS is not used, to keep dependencies minimal) | Entity parsing and the inheritance principle for `channels.tsv`, `events.tsv`, `events.json`, `eeg.json` |
| Display filters | `Raw.filter`, `Raw.notch_filter`, `skip_by_annotation` | Applying them to a display copy only (in memory or memory-mapped), recording MNE's filter design, marking edge zones |
| Continuous EEG viewer | mne-qt-browser, in the desktop application up to version 1.1.0: scrolling, zoom, scaling, channel paging, overview bar, time cursor, events | Annotation interaction (below), toolbar, panels, Save and Finish; since 28 October 2026 the browser application's own viewer |
| Annotation container | `mne.Annotations` with `ch_names` (channel-specific) and `extras` | Conversion both ways (`mne_bridge`), sample-exact model, undoable store |
| Experimental events | `events_from_annotations` (BrainVision marker codes) | Preservation of `events.tsv` rows as text, a separate `artifact_code` column, consistency checks |
| Export, completion, reliability, training | not provided | Everything in `io`, `session`, `validation`, `reliability`, `training` |

## Limitations of the standard MNE browser (desktop application)

The desktop application, up to version 1.1.0, showed recordings in
mne-qt-browser. Reading mne-qt-browser 0.7.5 showed that its annotation mode
cannot be used unchanged:

1. A free-text box lets users add any annotation label.
2. Drawing or moving an annotation merges it with every overlapping
   annotation of the same label (`_merge_annotations`), which would silently
   change annotators' boundaries.
3. A channel-specific annotation cannot overlap another annotation of the same
   label.
4. Annotations are located by their onset value, which is ambiguous when two
   annotations start at the same instant.
5. Clicking a channel name or trace marks the channel bad.
6. Escape closes the window; there is no Save and Finish, no undo and no close
   confirmation.

The desktop application therefore left MNE's annotation mode off and added its
own interaction through subclasses of the browser's classes. A plain drag
always draws (also over existing annotations, so that overlaps are easy to
make); edges resize; Shift+drag moves. Channel clicks select channels for
annotation. The browser application's viewer keeps these rules: a fixed list
of labels, merging only as described below, overlaps allowed, annotations
identified by their own identifier, undo and redo, and Save and Finish.

## Ambiguities and data-integrity issues

**Time origin.** BIDS onsets are relative to the first stored sample; MNE's
annotations attached to a recording are relative to the measurement date and
include `first_samp / sfreq`. ElectroTag stores onsets relative to the
first sample (as BIDS) and converts at the MNE boundary. BrainVision recordings
always have `first_samp = 0` in MNE, but the conversion is tested with other
values.

**Precision.** Annotation boundaries are snapped to whole samples. The change
is at most half a sample (2 ms at 250 Hz), well below what can be seen on
screen, and it makes `onset` and `sample` exactly consistent: times are
written with the shortest decimal that converts back to the same number, and
round trips are tested for sample indices up to 10⁹.

**"Empty channel selection means global".** An empty list means the whole
recording montage (every channel in the recording). Selecting every channel
explicitly is stored as the full list, so the two choices remain
distinguishable. Original event rows without channel information get `n/a`.

**Silent failures in MNE.** If the `.vmrk` file is missing, MNE loads the
recording without any markers; if the `.eeg` file is truncated, MNE loads a
shorter recording and drops markers beyond the end with a warning. Both would
silently lose original events, so both are treated as load failures. The
data-file size is also checked against the channel count and sample format.

**Original events.** When a BIDS `events.tsv` exists its rows are
authoritative and are copied as text, never re-formatted. Otherwise the
BrainVision markers are used, with MNE's codes (for example 1 for
`Stimulus/S  1`, 1001 for `Response/R  1`), or the annotations of an EDF+ or
BDF+ file. Differences between `events.tsv` and the marker file are reported,
not corrected. Many EDF files have no event annotations at all; their
`events.tsv` is then the only record and nothing is compared. BIDS defines
`sample` as the onset in samples; when a dataset uses the column for
something else (one dataset tested stores stimulus-software timestamps
there), ElectroTag times the events from `onset`, keeps the column
unchanged and says so in the session file and `events.json`. Events that lie
beyond the end of the recording are kept and reported.

**Repeated and inconsistent codes.** Repeated codes are normal and are only
counted. A code used for different event types, and an event type used with
different codes, are reported as inconsistencies for review.

**Filtering and boundaries.** Zero-phase filters are non-causal: a sharp
artifact appears to begin slightly before it does, and edges and
discontinuities produce transients of up to half the filter length. With
MNE's defaults the 1 Hz FIR high-pass is 3.3 s long and the FIR notch 6.6 s,
so the first and last 5 s or so of a recording can be distorted. ElectroTag
filters the segments between BrainVision "New Segment" markers separately,
hatches the affected zones in the viewer and records the exact design in
every session file. The browser's filters reproduce MNE's designs and edge
behaviour, so annotators see the same filtered signal as before. The research team chose FIR filters (MNE's defaults) and a
50 Hz notch by default, with 60 Hz available to annotators.

**Completion and concurrency.** Completion is per annotator, mode and
reference set. Register updates are locked and atomic, and when two saves of
the same recording by the same annotator meet at its lock, the second is asked
to try again. A recording
is only marked complete after its five files are verified, and interrupted
saves are rolled forward or back.

**Failed recordings.** In the desktop application, "excluded until their
problems have been resolved" was implemented by remembering the size and
modification time of the recording's files and the settings involved: a
failure stopped applying when the files or the setting changed, or when an
administrator marked it resolved. In a browser study a recording that cannot
be read is refused when it is registered, so it is never offered.

**Incomplete sessions and drafts.** Unfinished work is saved automatically
while a recording is open (the desktop application's autosave; in the browser,
a draft kept in the browser and with the study) and offered back when the
recording is opened again, with the time already spent carried over. Drafts
never count as results.

**Time measurement.** The monotonic clock starts when the viewer is on screen
and stops at Save and Finish; in the browser the page measures it and sends it
with the annotations. If saving fails the clock continues. Time when the
annotator is away from the computer is included.

**Identifiers.** Annotator IDs are letters and digits only (so they are safe
in file names and as a BIDS-style entity) and are upper-cased, so `a01` and
`A01` cannot create two sets of files on Windows or macOS. A recording's ID
is the path of its `.vhdr`, `.edf` or `.bdf` file relative to the dataset folder, which keeps
recordings with the same file name in different folders apart.

**Channel metadata.** The channel names in the recording are authoritative.
`channels.tsv` is used to check them, to give EOG and ECG channels a suitable
scale, and to grey out channels marked bad; none of this changes any file.

**Headset housekeeping channels.** Consumer headsets such as Emotiv's export
timestamps, counters, contact-quality and battery values as extra channels,
and the BIDS conversion of the dataset tested typed all 60 channels as EEG
although 14 are electrodes. Typing them from `channels.tsv` is therefore not
enough. A setting, `channels.hide`, names channels by pattern; they are left
out of the display copy (so they are never read or filtered), cannot be
annotated, and are recorded as `hidden_channels`. The whole montage is the
set of channels shown, so channel-level agreement is computed over the
electrodes. The default list holds the Emotiv names, which do not occur as
electrode names in the 10-20 or 10-10 systems.

**Stretches without data.** MNE's EDF export pads the last data record and
marks the padding `BAD_ACQ_SKIP`. ElectroTag hatches such stretches, leaves
them unfiltered and filters the data on either side separately, so that the
padding does not create a filter transient. The annotation is kept with the
original events but not drawn as an event line.

**Overlapping annotations of one type by one annotator.** At the research
team's request these are merged automatically while annotating, when they
overlap in time on the same channels (as one undoable step), so one artifact
is one event. Annotations that only touch, or that cover different channels,
stay separate. For time-resolved agreement, any remaining overlaps of one
label (for example in files made before merging was introduced) are combined;
for event matching they remain separate events.

**HED-SCORE labels.** At the research team's request ElectroTag offers all
29 artifact terms of HED SCORE 2.2.0, including the seven group terms, with
the original 16 codes unchanged (see
[hed_score_validation.md](hed_score_validation.md)). Group terms have roll-up
rows in the agreement analysis.

**Event codes.** The specification placed artifact codes in `value`, which
clashes with datasets whose own markers use 100 to 115 and needed an
administrator decision for each such dataset. At the research team's request
artifact codes now have their own `artifact_code` column, and `value` keeps
only the dataset's markers, so a clash cannot occur.

**Blinding.** In the desktop application, reference annotations were files on
disk that annotators who looked for them could find; they could be kept in a
separate location (`training.reference_sets_dir`). In the browser the experts'
annotations stay with the study and never reach an annotator's browser: the
study's server or functions check guided steps, score practice and make the
competency reports.

## Decisions taken by the research team (27 October 2026)

Notch filter 50 Hz by default with 60 Hz selectable; FIR filters; artifact
codes in their own column; EOG and ECG channels included in channel analyses
when present; overlapping annotations of one type on the same channels merged
automatically; every HED-SCORE artifact term available, group terms included;
stand-alone applications for Windows, macOS and Linux; free for research and
other non-commercial use (PolyForm Noncommercial License 1.0.0); autosave.

## Changes after a test on the group's own data (27 October 2026)

ElectroTag was run over the group's low-density dataset (772 Emotiv
recordings in EDF+ with BIDS sidecars). Every recording now loads; this needed
EDF, EDF+ and BDF support, the `channels.hide` setting for the headset's
housekeeping channels, the handling of `BAD_ACQ_SKIP` padding and of a
`sample` column that holds timestamps, all described above.

## Visual design (27 October 2026)

This section describes the desktop application's windows, whose colours and
principles the browser application took until it was given its own design
(the next section). The windows follow
principles that well-designed desktop software shares; Apple's Human Interface
Guidelines have long named clarity and deference among them. The EEG is the content, so the controls around it are quiet: light grey
surfaces, white cards with thin outlines, grey secondary text and one accent
colour, blue. Each window has one primary action in that blue (Begin, Open
recording, Save and Finish, Submit answer, Run analysis); other buttons are
plain, links and minor actions are blue text, and destructive actions are red.
Text has four levels (title, heading, body and caption) in the system font.
Options appear when they apply, such as the reference set and activity on the
start window, which appear only for practice and assessment. The choice
between the whole montage and selected channels is a two-part switch, so the
current choice is visible at a glance. Every text colour meets the WCAG 2.1 AA
contrast ratio of 4.5:1 against its background, and colour is never the only
signal (selected channels are also named in the toolbar).

The same Fusion style and light palette were used on Windows, macOS and Linux,
so the application looked the same everywhere. The overview bar under the EEG is plain by default
(the `display.overview_mode` setting, `empty`), so the annotations in it stand
out; mne-qt-browser kept its own saved mode and ignored the setting until this
change.


## Visual design of the browser application (28 October 2026)

When the desktop application was retired, the project lead asked for a more
distinctive look, and the design was worked out in two steps. A first brief
set a technical, minimal system: hairlines, square panels, flat colour,
monospaced labels and an abstract wireframe figure beside the main text. A
second brief kept that structure and moved its voice towards an editorial
register: warm off-white pages, a serif for headings and text, generous space,
pill-shaped buttons and one accent colour. On review, the accent became ink
blue and every label written in spaced capitals went back to ordinary case.
A final review asked for crisper type and controls and for one consistent
finish on every page, which the rules below provide.

Pages are #FDFCFB with a warmer band (#FAF6F0) for side panels, and faint
column guides mark the two edges of the page's width behind the pages around
the EEG (an inner pair, which crossed headings and text, was taken out after the
usability review of 29 October 2026) and stop where the EEG begins, so that nothing competes with the
traces, which are drawn on white. One typeface, Newsreader, a serif with
optical sizes, sets everything, the canvas included: text at its own optical
size, and headings at a sturdy text cut (optical size 24) at regular weight
with tight tracking, because the display cut's hairline strokes looked fragile
on screen. Figures use the font's tabular digits, so that columns of numbers
line up without a monospaced face. Sizes come from one scale of whole pixels
(12, 14, 16, 20, 28, 40, 56 and 72), each with a line height in whole pixels,
and spacing from steps of 4 and 8 pixels: fractional sizes such as 13.5 pixels
and unitless line heights put letters and lines between the screen's pixels,
which softens them. Nothing is set in capitals: the
artifact types' short codes are shown in ordinary case (Blink, Move) unless
they are acronyms (EMG, ECG, HEM), while the catalogue, the saved files and
the logs keep the codes as they are. Every divider is a 1-pixel
hairline (#E6E3DF); panels and tables are square. Buttons, including the type
buttons of the toolbar, are flat grey pills without outlines, and badges are
outlined pills, so that a status never looks like something to press. Arrows,
ticks, chevrons and stars are icons drawn on a 16-pixel grid and used as masks
in the colour of the text, because a font's arrows differ from face to face and
Newsreader has none. Black (#0D0D0D) marks the one action that moves a person
forward, with an arrow, and what is pressed; a single ink
blue (#2B4392) marks links, selection, focus and the one figure worth
noticing, such as the work done on the admin overview. Messages are tinted
blocks with a 3-pixel bar in their colour. The colours of the 29 artifact types
belong to the label catalogue and are presentation only, so changing one
leaves annotation files compatible. On review
in October 2026, two were changed so that the nine types of the numbered buttons
stay at least 8 apart under simulated red-green colour blindness, measured as the
channel palettes are: Movement-artifact became a mint green (#52C493, from a
yellow green that was 1.5 from EMG's orange) and Chewing-artifact a darker brown
(#5A1505, 4.1 from ECG's red before). `web_tests/unit/ui_type_colours.test.mjs`
keeps the nine apart. Every type button also shows its short name beside its
number, so that colour is never the only way to tell the types apart there.

The sign-in page shows an illustration drawn for ElectroTag: many EEG-like
traces across a dark field, warm at the top and cool below, like a long exposure of a
recording, drawn from a fixed seed, with the 10-20 montage as a small
wireframe whose three outer nodes turn slowly (and stand still when a person
asks for reduced motion). Pages come in with a short fade, which reduced
motion also turns off; nothing moves while it fades, so text is never drawn
between pixels. Newsreader is under the SIL Open Font License, which allows it
to be served with the application.

The mark, renamed with the software on 29 October 2026, shows what ElectroTag
is for: a short stretch of EEG marked as an artifact, drawn exactly as the
application draws an annotation, a shaded band in the accent blue with an edge
on each side, in a rounded frame. An earlier mark (a circle with a trace
through it) could have belonged to any EEG or heart-rate tool. The same drawing
is the browser tab's icon (`icon.svg`, filled with the page colour so that it
stays visible on dark tab bars, with a 32-pixel PNG for browsers that take no
SVG icons) and, without its frame, the icon an iPad shows when the application
is added to its home screen (`icon-180.png`); `scripts/make_web_icons.mjs`
makes the PNG icons from `icon.svg`.

The rules are checked by `web_tests/unit/ui_design.test.mjs`: the canvas colours
match the style sheet, every text colour meets WCAG 2.1 AA on the backgrounds
it is shown on, every size comes from the scale, there are no shadows,
gradients or capitals, no arrow or tick comes from a font, every icon the
scripts use has a drawing, the font is served with its licence, and the header
mark and the icons draw the same annotated trace.

## Web-only (28 October 2026)

The project lead decided that ElectroTag runs in the web browser only. The
browser version had been finished and tested end to end (the browser modules,
the application in Chromium against the demonstration, the ElectroTag
server and Firebase on Google's emulators), and it now does everything the
desktop application did, with an admin area for lead researchers in place of
the desktop's administrator tools. The desktop application (PySide6 windows on
MNE-Python's Qt browser), its stand-alone builds, launchers and self-test were
removed. Version 1.1.0, released on 27 October 2026, is the last desktop
release and remains on the Releases page of the repository; results folders it
wrote are read by the analyses unchanged.

EEG recordings stay on the computers of the researchers and annotators. An
administrator registers each recording where its files are, and the study
keeps only its manifest: the fingerprint (SHA-256) of the data file, timing,
the channels shown and hidden and their types, the original events and the
stretches without data. Annotators open their own copies in the browser, which
reads them locally and checks them against the register before they open.
Only annotations, drafts and the interaction log travel to the study.

Real studies run on Firebase: Firebase Authentication for accounts, Firestore
in Google's London region (europe-west2) for the study's records, and Python
Cloud Functions in the same region for the private work. The ElectroTag
server, which runs the same service layer over a study folder, serves the
local demonstration and the tests, and remains available to a study that
prefers a computer of its own. The Python core stays (annotations, loading
with MNE-Python, export, the journalled save, training, reliability, activity
and the synthetic data), because the server and the functions save results
with it and the commands `electrotag agreement`, `electrotag admin` and
`electrotag activity` work on exported results. Nothing in the package
imports a desktop toolkit any more, and the requirements no longer include Qt.
The open decision on code signing of the stand-alone applications no longer
applies.

## Touch screens and iPads (28 October 2026)

The project lead asked for the browser application to work on iPads as well as on computers. On a
touch screen, one finger (or the Apple Pencil) does what the mouse does, so that marking an
artifact is the same movement everywhere and the Pencil can draw precisely; moving the view
therefore needs two fingers, which also gives the pinch for showing more or less time, centred on
the moment between the fingers. A second finger that arrives while the first is marking cancels the
mark, so that a move never leaves an annotation behind. A long press stands in for the right-click
and a double tap for the double-click; a finger finds an annotation's edge from 16 pixels away (a
pencil from 10, the mouse from 6). What the keyboard does on a computer (scrolling, how much time
and how many channels are shown, the size of the traces) is offered as buttons under the EEG
wherever the screen is touched, and an attached keyboard still works. Moving an annotation, done
with Shift+drag on a computer, is offered on a touch screen through Edit times… in the annotation's
menu.

Upright, an iPad is 744 to 1024 pixels wide, too narrow for the side panel beside the EEG, so up to
1024 pixels the panel and the coach go below the EEG, side by side; there the panel is wide and
short, so when the Annotations tab has 600 pixels of width its buttons stand beside the list rather
than under it, and the list keeps the panel's height. A phone is too small for the
EEG, and the views other than signing in and the admin area ask for a larger screen below 700
pixels of width or 480 of height. On such a screen the sign-in page itself says that annotating
needs a tablet or a computer and that administrators can sign in to check progress, and an
annotator who signs in anyway is offered an email with the page's address and Sign out. Three Safari habits shaped the details: iPadOS greys out files
whose extension it does not know in the file picker, so the application offers every file and
checks it; Safari zooms into a field set below 16 pixels, so fields are 16 pixels on a touch screen;
and a style shown on hover would stay on a tapped control, so hover styles apply only where the
pointer can hover. The end-to-end tests run in WebKit, Safari's engine, as well as in Chromium, and
`k_ipad.e2e.mjs` checks the touch gestures, the layouts and the file pickers.

The side panel is 320 to 400 pixels wide, and the longest artifact labels
(Horizontal-eye-movement-artifact, Artificial-ventilation-artifact) need about 215 pixels at the
panel's text size. A table with columns for the label, the code, the start, the end and the
channels left the label about a third of the panel, so every long label was cut short and a rating or a
note sign shortened it further. Each row of the Annotations list now has two lines: the label with
its colour across the panel's whole width, and below it, in the smaller secondary text, the
channels, the rating, the note sign and the start and end, the times kept to the right in tabular
figures so that they still line up from row to row. Every label then fits on its line at the panel's
narrowest, and a longer text (the larger panel text, or the "Should be …:" of a training
review) wraps at its hyphens and spaces and is still read in full. The code of the type moved into the
row's title with the description. `t_annotation_list.e2e.mjs` checks that nothing in any row is cut
short, for all 29 types with ratings, notes and channels, at 1280 × 720, 1440 × 900, 1920 × 1080 and
on an iPad upright and on its side.

## Recordings from cloud links, and copies kept on the device (28 October 2026)

The project lead asked for recordings to open straight from private Dropbox and OneDrive links, so
that the study need not hold or send the data, and for a way to keep downloaded recordings on the
device and remove them easily when space is short. The browser fetches the file itself from the
service, without cookies, referrer or custom headers, and gives it to the code that opens files
chosen on the computer, so the fingerprint check is the same. Dropbox's share links are rewritten to
`dl.dropboxusercontent.com` with `dl=1`; checked in October 2026 with curl, that host answers a file
request with `Access-Control-Allow-Origin: *`, exposes `Content-Disposition` and `Content-Range`, and
answers 403 and 404 with the same header, so the page can say why a link failed, while
`www.dropbox.com` only redirects without it. Dropbox's staff describe this host on its forum as
working but undocumented, so the page always offers the fallback of downloading the file and
choosing it. OneDrive links go through the shares API as Microsoft documents its encoding; its
answers echo the page's origin in `Access-Control-Allow-Origin`, but no public OneDrive link was at
hand to follow a whole download, and Microsoft documents that work and school accounts need signing
in, so OneDrive is offered with the same fallback. Google Drive does not let other pages read its
files, and its links go straight to the fallback.

Share links are secrets: whoever has one can read the file. They are therefore never stored, not
even as recently used links, never sent to the study and never written to the interaction log; the
log records the service, the number of files and their size. Copies kept on the device hold the
files and their names only, filed under the study, the annotator and the fingerprint, so that a
shared computer does not mix people's copies, and a copy's fingerprint is checked again each time it
opens. The Origin Private File System is used where the page can write to it (Safari only from
version 26, according to MDN's compatibility data), and IndexedDB elsewhere. Links are kept by
default, since downloading again is what the lead wanted to avoid, and files chosen on the computer
only on request, since they are already there. Signing out offers removal with keeping as the
default, which suits an annotator's own device, and the documentation advises removal on shared
computers. A copy is removed for a finished recording only after Save and Finish has saved and
verified the results, and only when none of the annotator's assignments still needs the recording.

## Channels coloured by group (29 October 2026)

The project lead asked for channels to be coloured by group, following other EEG viewers, without
the colours suggesting a bad channel. MNE-Python's browser colours traces by channel type (EEG and
EOG black, ECG magenta) and draws bad channels in light grey, its `make_1020_channel_selections`
groups 10-20 names into left (odd numbers), midline (z) and right (even numbers), and NeuroScope
lets users colour channels by anatomical group; no common clinical convention for hemisphere colours
was found. ElectroTag therefore offers region, side and type, with the grouping the channel
chooser already used, and keeps the meanings the EEG already has: bad channels stay grey with
"(bad)" after their name, selected channels stay pink, the experimental events stay teal, and the
ink-blue accent still marks the channel name under the pointer.

The palette had to be dark (4.5:1 on white, so that a 1-pixel trace stays readable), calm (no red,
orange or amber, which read as warnings, no pink, which marks selection, no teal and no grey) and
separable for people with red-green colour blindness. Measured with the palette checks of the design
work (OKLab distances under the Machado, Oliveira and Fernandes simulation of protanopia and
deuteranopia), only four hues meet all of these at once: blue `#4360E6`, green `#4A7D23`, violet
`#74209C` and mauve `#90609A`, each at least 15 apart with full colour vision and 12.8 apart under
simulation, every pair. A fifth (a brown, a petrol blue or an olive) came too close to the warning
text, the events' teal or the green. Regions that touch on the scalp therefore never share a colour,
and frontal and occipital, at opposite ends of the head, share blue; the montage's order tells them
apart. Sides use blue and green, so that left and right differ in hue for everyone, and the midline
stays black. A montage that is not named by the 10-20 or 10-10 system (fewer than 60% of its EEG
channels, the chooser's rule) is not coloured by region or side, since BioSemi's C1 to C32 are a
bank of electrodes rather than central sites. `web_tests/unit/ui_channel_colours.test.mjs` checks
the contrast, the hues, the distances from the reserved colours and the separations.

## Viewing tools: the head map, the readout, the overlay and Go to time (29 October 2026)

The project lead compared ElectroTag with EEGNet, a LORIS-based EEG platform, and asked for four
of its ways of looking at the EEG, because they help annotators judge artifacts faster and more
accurately: choosing channels on a map of the head, the value under the pointer, all channels on
one axis (EEGNet's Stack, ElectroTag's Overlay), and typing a time to go to.

The map places each electrode, in this order, where the recording's own BIDS electrodes.tsv puts
it, where the standard 10-20, 10-10 and 10-05 positions put it, or, for montages whose names say
nothing about position, on rings in the order of the channels, which the map says plainly
("Positions not known: arranged in order") so that nobody reads a ring as anatomy. The
electrodes.tsv is read where the recording is read, in the annotator's browser: when they pick it
with the recording (a folder, or several files), when it is kept with a copy of the recording on
the device, and when it comes with a recording opened from a link, either as a link of its own or
from beside a recording at a plain web address, where the page asks once, quietly, for the BIDS
names next to the recording and falls back to the standard positions on any failure. An optional
file is never a reason to refuse or delay a recording, so the recording opens while it is asked
for, and the map takes its positions when it arrives. The study's manifest does not carry
positions, so that adding them later needs no change to what the study stores. Its coordinates are turned to
right, front and up according to the coordinate system its coordsystem.json names (the systems
the BIDS specification lists as front-left-up, such as EEGLAB and CTF, are turned round; the others
are right-front-up), centred on the sphere that fits them best, and drawn with the azimuthal
equidistant projection that EEG topographies use. The standard positions are not a table copied
from one software package: they are worked out on an ideal spherical head from the percentage rules
of the 10-20 system as Oostenveld and Praamstra extended them to 5% steps, so that every name of
the 10-05 system, the old names T3 to T6 and the names as EDF files write them have a place, and the
unit tests check the rules (the ring at 10% steps of the half circumference, the rows divided in
equal parts, left and right mirrored). A montage is placed by its names under the channel
chooser's 60% rule, so that BioSemi's C1 to C32 are not taken for central sites. Bad channels are
grey with a dashed edge and can still be chosen, as in the list, since ElectroTag never forbids
marking an artifact on a bad channel.

In the overlay, channel-specific marking is not offered. A channel-specific mark is made by
choosing channels by their rows, and in the overlay there are no rows: every channel is drawn on the
same axis, so a drag cannot say which channels it meant, and a mark made there would look the same
whichever channels it named. New marks in the overlay therefore apply to the whole montage, as the
toolbar and a caption on the EEG say, and the switch to Selected channels waits until the normal
view is back. Existing channel-specific annotations are drawn over the whole height in the overlay,
so that they stay visible, and can still be edited with Edit channels…. The overlay's axis is
shared by every type of channel, each keeping its own scaling, and half its height stands for four
times the type's scaling (200 µV for EEG at the usual 50 µV), so that blinks and movements stay
within it; overlapping lines darken, and the lines grow lighter as more channels are drawn. Go to
time puts the time typed in the middle of the screen with the time cursor on it, so that what comes
before is as visible as what comes after, and Show all is an overview: a view of a whole long
recording shows too little of each second to count as viewed.

## Revisions and game elements (28 October 2026)

Annotators asked to return to recordings they had finished and correct them. A revision is a new
attempt of the same assignment, saved by the same journalled save as any recording: the earlier
attempt's five files stay untouched, the completion register gains a row, and the new files record
which version and session they revise. Analyses use each annotator's latest attempt, chosen by the
attempt number (which only grows) rather than by the time saved, so that clocks in different time
zones cannot reorder them. A revision must name the version it revises, and the server refuses it
when that is no longer the latest, so the same revision sent twice saves once. Nothing is deleted:
a study can always see what was changed and when. A study whose design needs a single pass
switches revisions off (`annotation.allow_revisions`). Training recordings keep their own rules,
because a guided or assessed recording that could be redone would change what its score means.

Annotating a couple of hundred recordings is long and repetitive work, so the home page offers game
elements beside the annotator's own progress: a weekly goal the annotator sets, the team's progress,
milestones and an anonymised leaderboard. They follow common principles of game design (clear goals, visible progress,
feedback at the moment something is achieved, and autonomy over taking part) and one rule of our
own: rewards follow progress through the recordings and thoroughness, never speed and never the
number of annotations. The annotations are the research data; a reward for marking more would push
annotators to mark artifacts they do not see, and a reward for speed would push them to look less
carefully, either of which would bias the data that the study exists to collect. The number of
annotations is therefore shown for interest only, a revision earns nothing, and the leaderboard can
rank by recordings viewed in full instead of recordings finished. The leaderboard uses pseudonyms
made from a keyed hash of the annotator ID with a secret the server keeps, shows nobody until three
people are on it, and lets each person leave it. Celebrations are short, quiet and never modal, and
respect a request for reduced motion. Because even well-meant game elements can change behaviour,
they can be switched off, and a study that uses them should report them in its methods.

## Confidence and notes (29 October 2026)

In an agreement study, doubt is part of what is being measured: two annotators who disagree about a
mark are often both unsure of it. Each annotation can therefore carry a confidence rating and a short
note. The first design used three named levels (definite, probable, possible); the project lead found
them odd, and the rating is now a 5-point Likert scale with the usual unipolar anchors: 1, not at all
confident; 2, slightly confident; 3, moderately confident; 4, very confident; 5, completely
confident. A numbered scale with a word for every point is familiar from questionnaires, reads the
same to every annotator, needs no explanation of what "probable" means for an artifact, and gives an
ordinal measure the analyses can summarise with a median and compare across levels. Five points
leave room to say "fairly sure" without forcing a choice between sure and unsure, and are few enough
to choose between with one key. The ratings are ordinal: the analyses count and compare levels and
never average them as if the steps were equal.

Rating is a short, explicit step: D and then a digit, or a tap on a number below the Annotations
list or in the menu. While ElectroTag waits for the digit the line at the bottom says so and the
number keys rate rather than choose a type; the wait ends after the digit, Esc, another key or a few
seconds, so it never traps the keyboard.

The project lead asked that annotators can always rate a mark, and that the study chooses how much it
asks for (`annotation.confidence`). **Optional**, the default, costs nothing: annotators rate a mark
when they wish, and the rated marks are a self-selected subset, which the analyses say. **Every mark**
asks for a rating after each new mark. No mark ever starts with a rating, in either setting: a
default (for example "completely confident") would be kept by annotators who never change it, and a
default rating cannot be told from a chosen one, which would bias the data towards the default.
Instead the prompt opens by itself after each new mark, answered with one key or tap; carrying on
without answering leaves the mark unrated, so the question never blocks the work, and Save and Finish
lists the unrated marks with Rate them (which steps through them, one key each) and Save anyway, in
the same way as the check of the parts not yet viewed. A rating is therefore always a choice the
annotator made, and an unrated mark is recorded as such.

The analyses use the ratings in three ways. They report each annotator's ratings: how many marks
were rated, the distribution over 1 to 5, and the median, since annotators use a scale differently
and each annotator's ratings are best compared with their own. When any mark was rated, they report
agreement twice, for all marks and again without the marks of low confidence (rated 1 or 2): a
sensitivity analysis in which unrated marks stay in both sets, because in an optional study leaving
them out would leave only the self-selected rated marks. And a calibration table gives, for each
annotator and rating, the share of their marks that at least one other annotator also found; if the
share rises with the rating, the ratings tell which marks others agree with. The main agreement
tables always use every mark.

When two marks of one type overlap and merge, the merged mark keeps the lower rating of the two,
since it is only as sure as its least sure part, and both notes, joined with "; " (each
different note once, shortened to 200 characters if longer). An unrated mark adds no rating, so a
mark rated 5 merged with an unrated one stays at 5. Notes are research content: they are saved with
the annotation, listed with each event in the analyses' matched and unmatched event tables, and used
in no statistic. The interaction log records only that a note was added, changed or removed and its
length, as it never records typed text.

## Problem reports and reviews of saved work (29 October 2026)

An annotator who could not judge a recording (a file that would not open, the wrong recording, flat
or missing channels, one too noisy or too short) used to have two choices: save it as having no
artifacts, or write to the study team. The first mixes "clean" with "could not be judged" and
corrupts the agreement data, so an annotator now reports the problem with a reason and an optional
note, and either carries on or sets the recording aside. A recording set aside has a status of its
own, `unusable`, rather than a kind of done: it counts as finished for the annotator's progress, so
nobody is left with work they cannot do, but the study's totals keep it apart from done and take it
from the work remaining, and the agreement analyses leave it out for every annotator and say how
many recordings they left out. Leaving it out for everyone is the cautious choice: a recording one
person found unreadable may hold the very artifacts that make the others disagree, and the study
team can bring it back by returning it to its annotator's list, which undoes the status. Only an
unfinished study recording can be set aside; training recordings keep their own rules, and a
recording already saved keeps its result. Reports are records of their own, never deleted, and the
interaction log keeps only the reason, the outcome and the length of the note.

A lead annotator can review saved work, annotation by annotation, with Agree, Caveat or Comment and
a note, and can point to a stretch where an artifact may have been missed. A review is a record of
its own, beside the version it is about; it never changes the annotation files, and a recording can
have several reviews by different people or over time, which keeps the saved results exactly as
the annotator made them and keeps the review's own provenance (who, when, which version). The
reviewer opens the EEG from their own computer, checked against the manifest, because the EEG never
reaches the study. The annotator sees the feedback as a calm blue mark beside each annotation, never
red: the feedback is a colleague's view to weigh, and the annotator decides what to change in a
revision. A study can keep reviews from the annotators (`annotation.show_reviews_to_annotators`),
for example to measure agreement before any feedback, or switch reviews off
(`annotation.allow_reviews`). The agreement analyses do not use reviews, which describe how one
person judged another's work rather than an annotation of the recording. A report and a review
each carry an ID the browser makes, so a button pressed twice or a request sent again after a late
answer keeps one record.

## The annotation view on small, zoomed and large screens (29 October 2026)

A usability review on laptops, with the browser's zoom and on iPads found the annotation view
squeezed in ways that cost information. The toolbar used to hide the type buttons' short names when
it ran out of room, which happened on most laptops, leaving a number and a colour; it now wraps onto
a second line, because a wrong type goes straight into the agreement data, and 40 pixels of EEG are
the cheaper loss. The line at the bottom had spent a third of its width on fixed text (the
annotator, the mode and the filters) and cut short the instructions it exists to give; the message
now has two lines and priority, the annotator and the mode moved to the Recording tab and the
header, where they already were, and the line keeps a fixed height so that the EEG never moves when
a message comes.

The view used to fill the window exactly, so a short window (a laptop at 150% zoom) drew the line at
the bottom over the side panel and hid the panel's list. The EEG and the panel now keep a minimum
height and the view scrolls below it, and the panel goes under the EEG only on a tablet held
upright or a narrow window, so that a wide, short window keeps it beside the EEG. A window made
small by zooming in to 200% shows the notice meant for phones; on a computer (a fine pointer) it now
offers to continue in the window, while a phone keeps the notice alone.

Channel names were shrunk to 7 pixels to give every row a name; they now stay at 11 pixels or more
and every second or third row is named, with the selected channels and the row under the pointer
always named, since a name too small to read is no name. The channel map opened at the size where
every electrode's name fits, which on a 128-channel 10-05 cap was a drawing three times wider than
its frame showing seven electrodes; it now opens with the whole head, the names under the pointer,
and + climbs to the full size. Show all reads a long, dense recording in pieces so that the EEG
appears as it is read with the share read so far, instead of a blank plot for many seconds.

## Decisions still open

1. **Agreement settings to pre-register:** bin widths, the bin coverage rule,
   the matching criterion, IoU thresholds or tolerances, and one-to-one or
   many-to-one matching.
2. **Competency criteria:** which metrics, thresholds and categories, and the
   minimum number of reference events for a category to be judged.
3. **Repeat annotation** for intra-rater (test-retest) reliability: the code
   supports repeats with an `_attempt-NN` suffix, but there is no study setting
   to schedule them yet.
4. **Idle time:** should the time measurement exclude periods without any
   interaction?
5. **Copyright holder** for the licence notice (currently "The ElectroTag
   authors"), which may need to be agreed with the University.
6. **Contact-quality channels.** Emotiv's `CQ_*` channels are hidden with the
   other housekeeping channels. They could instead be shown (not annotated) as
   a guide to poor electrode contact; this needs a decision on whether they
   would help or bias annotators.
