# Design decisions

This document records how the specification was interpreted: what MNE-Python
already provides, what had to be added, the ambiguities and data-integrity
risks that were found, how each was handled, and the decisions that need the
research team. ElectroClean began as a desktop application and has run in the
browser since 28 October 2026 (see "Web-only" below); the sections written for
the desktop application are kept as the record of how the rules came about,
and the rules themselves apply unchanged in the browser.

## What MNE-Python provides and what ElectroClean adds

The table describes the Python core, which registers recordings and writes
the results. The browser application reads, filters and shows the annotator's
copy itself, reproducing MNE's results ([web/architecture.md](web/architecture.md)).

| Need | Provided by MNE | Added by ElectroClean |
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
include `first_samp / sfreq`. ElectroClean stores onsets relative to the
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
there), ElectroClean times the events from `onset`, keeps the column
unchanged and says so in the session file and `events.json`. Events that lie
beyond the end of the recording are kept and reported.

**Repeated and inconsistent codes.** Repeated codes are normal and are only
counted. A code used for different event types, and an event type used with
different codes, are reported as inconsistencies for review.

**Filtering and boundaries.** Zero-phase filters are non-causal: a sharp
artifact appears to begin slightly before it does, and edges and
discontinuities produce transients of up to half the filter length. With
MNE's defaults the 1 Hz FIR high-pass is 3.3 s long and the FIR notch 6.6 s,
so the first and last 5 s or so of a recording can be distorted. ElectroClean
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
marks the padding `BAD_ACQ_SKIP`. ElectroClean hatches such stretches, leaves
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

**HED-SCORE labels.** At the research team's request ElectroClean offers all
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

ElectroClean was run over the group's low-density dataset (772 Emotiv
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
distinctive look and supplied a design brief, a "technical minimalist" system: a paper
background (#F7F7F5) with a mosaic of rectangular panels drawn in hairlines,
forest green (#1A3C2B) as the primary colour with coral, mint and gold as
accents, Space Grotesk for headings and a monospaced face for labels, 1-pixel
lines at 20 % of #3A3A38 for every divider, no shadows, corners of 0 or 2
pixels, bento grids separated by 1-pixel gaps, status badges with a square dot,
L-shaped corner markers on framed forms, and an abstract wireframe figure with
a dashed orbit beside the main text.

The brief was written for a marketing page, and ElectroClean is a working tool,
so it was adapted. Headings are smaller in the application (34 pixels for a
page title) and keep the brief's tight setting; only the sign-in page uses
display type (up to 92 pixels). The mosaic sits behind the pages around the
EEG and stops where the EEG begins, so that nothing competes with the traces,
and the EEG itself is drawn on white. Coral, mint and gold are too light for
text on paper, so they appear only as fills and accent bars with dark text
beside them, and the colours of the 29 artifact types are unchanged, because
they belong to the label catalogue and were chosen to stay distinguishable.
The brief's General Sans is under a licence that forbids sharing its font
files, so text is set in Instrument Sans, a similar
neo-grotesque under the SIL Open Font License, like Space Grotesk and JetBrains
Mono; all three are served with the application. The abstract figure became
the 10-20 electrode montage, with Cz as the central node and three nodes on a
slowly turning orbit that stands still when a person asks for reduced motion.
Monospaced capitals are used for short labels (field labels, column headings,
badges, tabs, the admin area's numbered sections) and kept out of sentences
and of narrow columns, where they would be cut. The brief's testimonial cards
and image treatment have no counterpart in the application.

The rules are checked by `web_tests/unit/ui_design.test.mjs`: the canvas colours
match the style sheet, every text colour meets WCAG 2.1 AA on its background,
there are no shadows, and every font is served with its licence.

## Web-only (28 October 2026)

The project lead decided that ElectroClean runs in the web browser only. The
browser version had been finished and tested end to end (the browser modules,
the application in Chromium against the demonstration, the ElectroClean
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
Cloud Functions in the same region for the private work. The ElectroClean
server, which runs the same service layer over a study folder, serves the
local demonstration and the tests, and remains available to a study that
prefers a computer of its own. The Python core stays (annotations, loading
with MNE-Python, export, the journalled save, training, reliability, activity
and the synthetic data), because the server and the functions save results
with it and the commands `electroclean-agreement`, `electroclean-admin` and
`electroclean-activity` work on exported results. Nothing in the package
imports a desktop toolkit any more, and the requirements no longer include Qt.
The open decision on code signing of the stand-alone applications no longer
applies.

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
5. **Copyright holder** for the licence notice (currently "The ElectroClean
   authors"), which may need to be agreed with the University.
6. **Contact-quality channels.** Emotiv's `CQ_*` channels are hidden with the
   other housekeeping channels. They could instead be shown (not annotated) as
   a guide to poor electrode contact; this needs a decision on whether they
   would help or bias annotators.
