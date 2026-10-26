# Design decisions

This document records how the specification was interpreted: what MNE-Python
already provides, what had to be added, the ambiguities and data-integrity
risks that were found, how each was handled, and the decisions that need the
research team.

## What MNE-Python provides and what ElectroClean adds

| Need | Provided by MNE | Added by ElectroClean |
|---|---|---|
| Reading BrainVision | `mne.io.read_raw_brainvision` (resolves `.eeg` and `.vmrk` from the header) | Pre-checks of companion files and data-file size; treating MNE's "markers outside data range" and "marker file not found" warnings as failures |
| BIDS sidecars | (MNE-BIDS is not used, to keep dependencies minimal) | Entity parsing and the inheritance principle for `channels.tsv`, `events.tsv`, `events.json`, `eeg.json` |
| Display filters | `Raw.filter`, `Raw.notch_filter`, `skip_by_annotation` | Applying them to a display copy only (in memory or memory-mapped), recording MNE's filter design, marking edge zones |
| Continuous EEG viewer | mne-qt-browser: scrolling, zoom, scaling, channel paging, overview bar, time cursor, events | Annotation interaction (below), toolbar, panels, Save and Finish |
| Annotation container | `mne.Annotations` with `ch_names` (channel-specific) and `extras` | Conversion both ways (`mne_bridge`), sample-exact model, undoable store |
| Experimental events | `events_from_annotations` (BrainVision marker codes) | Preservation of `events.tsv` rows as text, collision and consistency checks |
| Export, completion, reliability, training | not provided | Everything in `io`, `session`, `validation`, `reliability`, `training` |

## Limitations of the standard MNE browser

Reading mne-qt-browser 0.7.5 showed that its annotation mode cannot be used
unchanged:

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

ElectroClean therefore leaves MNE's annotation mode off and adds its own
interaction through subclasses of the browser's classes (see the developer
guide). The display, navigation and event lines are MNE's. A plain drag always
draws (also over existing annotations, so that overlaps are easy to make);
edges resize; Shift+drag moves. Channel clicks select channels for annotation.

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
`Stimulus/S  1`, 1001 for `Response/R  1`). Differences between `events.tsv`
and the marker file are reported, not corrected.

**Event codes 100 to 115.** Original codes in this range would share a code
with an artifact label. The specification asks for an explicit policy before
export; ElectroClean applies it before annotation, so no annotation time is
wasted on a recording that cannot be exported. The only available policy
keeps both and distinguishes them by `event_source`; codes are never
renumbered.

**Repeated and inconsistent codes.** Repeated codes are normal and are only
counted. A code used for different event types, and an event type used with
different codes, are reported as inconsistencies for review.

**Filtering and boundaries.** Zero-phase filters are non-causal: a sharp
artifact appears to begin slightly before it does, and edges and
discontinuities produce transients of up to half the filter length. With
MNE's defaults the 1 Hz FIR high-pass is 3.3 s long and the FIR notch 6.6 s,
so the first and last 5 s or so of a recording can be distorted. ElectroClean
filters the segments between BrainVision "New Segment" markers separately,
hatches the affected zones in the viewer, records the exact design in every
session file, and offers an IIR alternative.

**Completion and concurrency.** Completion is per annotator, mode and
reference set. Lock files prevent the same annotator from opening one
recording twice; register updates are locked and atomic. A recording is only
marked complete after its five files are verified, and interrupted saves are
rolled forward or back at the next start.

**Failed recordings.** "Excluded until their problems have been resolved" is
implemented by remembering the size and modification time of the recording's
files and the settings involved: a failure stops applying when the files or
the setting change, or when an administrator marks it resolved.

**Incomplete sessions.** As allowed by the specification, a session closed
without Save and Finish is discarded (after confirmation) and logged as
incomplete. Autosave is left for a later version.

**Time measurement.** The monotonic clock starts when the viewer is on screen
and stops at Save and Finish. If saving fails the clock continues. Time when
the annotator is away from the computer is included.

**Identifiers.** Annotator IDs are letters and digits only (so they are safe
in file names and as a BIDS-style entity) and are upper-cased, so `a01` and
`A01` cannot create two sets of files on Windows or macOS. A recording's ID
is the path of its `.vhdr` file relative to the dataset folder, which keeps
recordings with the same file name in different folders apart.

**Channel metadata.** The channel names in the recording are authoritative.
`channels.tsv` is used to check them, to give EOG and ECG channels a suitable
scale, and to grey out channels marked bad; none of this changes any file.

**Agreement for overlapping annotations by one annotator.** For
time-resolved agreement, overlapping annotations of the same label by one
annotator are combined. For event matching they remain separate events, so
an annotator who splits one artifact into two annotations has one unmatched
event.

**HED-SCORE labels.** All 16 labels match HED SCORE 2.2.0 exactly (see
[hed_score_validation.md](hed_score_validation.md)). The schema contains
further artifact terms that are not in the requested list.

**Blinding.** Reference annotations are files on disk; annotators who look for
them can find them. They can be kept in a separate location
(`training.reference_sets_dir`).

## Decisions for the research team

1. **Notch frequency.** The specification's default is 60 Hz. UK mains is
   50 Hz; the recordings' `eeg.json` `PowerLineFrequency` is checked and a
   mismatch is shown. Should the study default be 50 Hz, and should filters be
   fixed for all annotators?
2. **Filter design.** MNE's FIR defaults (long, sharp) or the IIR option
   (shorter transients, more phase-sensitive in the transition band)?
3. **Event-code policy** for datasets whose original events use 100 to 115.
4. **Agreement settings to pre-register:** bin widths, the bin coverage rule,
   the matching criterion, IoU thresholds or tolerances, one-to-one or
   many-to-one matching, and whether EOG and ECG channels are included in
   channel analyses.
5. **Competency criteria:** which metrics, thresholds and categories, and the
   minimum number of reference events for a category to be judged.
6. **Same-label overlaps by one annotator:** allow (current behaviour), warn,
   or merge before analysis?
7. **Repeat annotation** for intra-rater (test-retest) reliability: the code
   supports repeats with an `_attempt-NN` suffix, but there is no study setting
   to schedule them yet.
8. **Idle time:** should the time measurement exclude periods without any
   interaction?
9. **Categories:** HED SCORE 2.2.0 also has Line-noise-artifact,
   Nystagmus-artifact, Artificial-ventilation-artifact, Dialysis-artifact,
   Rocking-patting-artifact and Sucking-artifact. Are any of these needed
   (line noise, in particular, is hidden by the notch filter)?
10. **Distribution:** the launchers need Python on each computer. A frozen
    application (for example PyInstaller) could remove that requirement but
    would need building and signing on Windows and macOS.
11. **Licence** under which ElectroClean is shared (none has been chosen).
12. **Autosave and recovery** of unfinished sessions in a later version.
