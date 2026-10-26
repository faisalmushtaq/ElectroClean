# Administrator guide

This guide is for the researcher who sets up a study: which annotators take
part, which recordings each annotates, how the viewer is configured, and how
annotators are trained and assessed. Every task can be done in the
application (*Tools → Administrator tools* on the start window) or with the
`electroclean-admin` command; `electroclean-admin <command> --help` lists each
command's options.

## The study configuration

A study is configured by an optional file `electroclean_study.json` in the
dataset folder (format in [file_formats.md](file_formats.md)). Without it,
ElectroClean uses its defaults and any annotator can work on any recording.

```bash
electroclean-admin init-study /data/MyStudy --study-id pilot-2026 \
    --annotators A01:"First annotator" A02 CAM:Cameron --listed-only
electroclean-admin set-passphrase /data/MyStudy
electroclean-admin show /data/MyStudy
```

The **administrator passphrase** keeps annotators out of the administrator
tools by accident. It is stored as a salted PBKDF2 hash. It is not a security
boundary: anyone who can read the dataset folder can read its files.

![Administrator tools: reference sets](images/admin_reference_sets.png)

## Fixing the viewing filters

For a reliability study all annotators should see the same filtered signal.

```bash
electroclean-admin fix-filters /data/MyStudy --notch 50          # 1 Hz high-pass, 50 Hz notch, FIR
electroclean-admin fix-filters /data/MyStudy --no-highpass --notch off
electroclean-admin unlock-filters /data/MyStudy
```

Annotators then see the settings in the viewing-options window but cannot
change them, and every session file records that they were fixed. The filter
design (FIR, zero phase, MNE's default Hamming-windowed `firwin` design) and
the exact lengths and transition bands chosen by MNE are written to each
session file. A 1 Hz FIR high-pass at MNE's defaults is 3.3 s long and the
FIR notch is 6.6 s long, so up to about 5 s at each recording edge and around
each discontinuity can be affected; these zones are hatched in the viewer.

## Which recordings each annotator sees

`electroclean-admin allocation /data/MyStudy random` (the default) offers a
random recording the annotator has not completed. `seeded --seed 7` gives each
annotator a reproducible order (derived from the seed and the annotator ID).
For a controlled overlap, create manual assignments:

```bash
electroclean-admin allocate /data/MyStudy --annotators A01 A02 A03 CAM \
    --raters-per-recording 2 --seed 7
```

This assigns every recording to exactly two of the four annotators, balancing
workload and the number of recordings each pair shares, and switches the study
to manual allocation. The assignments are stored in the study file, where they
can also be edited by hand.

Completion is recorded per annotator: a recording completed by A01 remains
available to A02. A recording an annotator has completed is never offered to
them again and their files are never overwritten.

## Original event codes 100 to 115

The artifact codes are fixed at 100 to 115. If a recording's original events
use one of these codes, or use an artifact label as their type, ElectroClean
refuses to open that recording and logs the reason, because the exported
events file would otherwise contain two meanings for one code. After checking
the data, choose a policy:

```bash
electroclean-admin collision-policy /data/MyStudy preserve_and_flag
```

With `preserve_and_flag` the original codes are kept unchanged, the
`event_source` column distinguishes original rows from artifact rows, and the
events sidecar describes the code as ambiguous. Original codes are never
renumbered. Repeated codes (many trials sharing one code) are normal and are
only counted; a code used for different event types, or one type appearing
with different codes, is reported in each session file for you to review.

## Load failures

Recordings that cannot be opened (missing or renamed companion files, a
truncated data file, a malformed `events.tsv`, an event-code clash, and so on)
are listed in `Annotated_Events/failed_load.txt` and `failure_log.jsonl`. They
are not offered again until the files change, the setting that caused the
failure changes, or you mark the failure resolved:

```bash
electroclean-admin resolve-failure /data/MyStudy sub-007/eeg/sub-007_task-rest_eeg.vhdr --note "re-copied from source"
```

The *Progress and reports* tab of the administrator tools lists unresolved
failures.

## Interrupted saves

If ElectroClean stops while saving (power cut, network drive disconnected),
the next start finds the interrupted save. If every file had been written and
verified, the save is completed; otherwise the partial files are moved to
`Annotated_Events/.electroclean/interrupted/` and the recording stays
incomplete. Either way, a message tells the annotator what happened.

## Training and competency assessment

### Reference sets

A reference set is a group of recordings with expert reference annotations,
each marked for **practice** or **assessment**. The references must be
prepared independently of the people being assessed, so that, for example,
Cameron can be trained and assessed without having produced any of the
reference material himself. The method used is stored as provenance with each
reference.

```bash
electroclean-admin create-reference-set /data/MyStudy pilot --name "Pilot set" \
    --method consensus --experts E1 E2 E3
```

There are three ways to establish a reference:

1. **One designated expert.** The expert annotates the recording in
   ElectroClean in standard mode, then you import the expert's
   `_annotations.json` file:
   `electroclean-admin add-reference /data/MyStudy pilot path/to/E1_annotations.json --use practice`.
2. **Consensus of several experts.**
   `electroclean-admin build-consensus /data/MyStudy pilot E1.json E2.json E3.json --use assessment --disagreements dis.tsv`.
   A sample is in the consensus for a category when at least
   `--min-agreement` experts marked it (a strict majority by default). For each
   consensus interval the channels are those chosen by at least as many of the
   contributing experts, and the interval is whole-montage when enough experts
   used whole montage. Every place where the experts disagree is written to the
   disagreement list.
3. **Adjudication.** Give the disagreement list to an adjudicator, who
   annotates the recording (in standard mode, in a separate results folder) to
   produce the final version, and import it:
   `electroclean-admin add-adjudicated /data/MyStudy pilot final.json --use assessment --experts E1 E2 E3 --adjudicator E4 --expert-files E1.json E2.json E3.json --disagreements dis.tsv`.

Imported files are copied into the reference set with their checksums, and a
reference file that has been edited afterwards is refused. Keep reference sets
somewhere annotators do not browse (set `training.reference_sets_dir` in the
study file); by default they are in `derivatives/electroclean_reference_sets`.

To restrict a reference set to particular annotators:
`electroclean-admin assign /data/MyStudy pilot CAM A03`.

### Competency criteria

ElectroClean does not impose a universal threshold: no criteria are set until
you set them, and reports then say "not determined". Choose criteria from
pilot data, expert agreement and the intended use of the labels.

![Competency criteria](images/admin_criteria.png)

| Metric | Meaning |
|---|---|
| `event_f1` | F1 of matched events (time only) |
| `event_recall` | Proportion of reference artifacts found |
| `event_precision` | Proportion of the annotator's artifacts that match the reference |
| `time_kappa` | Cohen's kappa over time (exact) |
| `time_positive_agreement` | Positive agreement over time |
| `channel_positive_agreement` | Positive agreement over time and channels |
| `mean_iou` | Mean temporal overlap of matched artifacts |
| `mean_channel_jaccard` | Mean channel overlap of matched artifacts |
| `label_accuracy` | Proportion of detected artifacts given the reference's label |
| `false_positives_per_min` | Extra artifacts per minute (lower is better) |

Each criterion applies **overall** or **in every assessed category**. A
category is judged only when the reference contains at least
`min_reference_events` events of it (3 by default); others are reported but
not judged.

```bash
electroclean-admin set-criteria /data/MyStudy pilot \
    --criterion event_f1:0.8 --criterion event_recall:0.7:each_category \
    --criterion label_accuracy:0.85 --min-reference-events 3
```

Matching for competency uses the defaults of the reliability analysis (IoU of
at least 0.2, one-to-one); a reference set can override them in the
`analysis` entry of its `reference_set.json`.

### What annotators experience

In **practice** mode annotators see feedback after each recording and can
review their annotations next to the reference. In **assessment** mode they
see nothing until all assessment recordings are complete; ElectroClean then
writes the competency report to
`Annotated_Events/training/<set>/reports/` and shows its result. Practice and
assessment annotations are stored under `Annotated_Events/training/` and are
never mixed with research annotations.

### Competency reports

```bash
electroclean-admin progress /data/MyStudy pilot --annotators CAM A03
electroclean-admin report /data/MyStudy pilot CAM
```

The report lists each criterion with its value and result, the overall and
per-category measures, the missed, extra and relabelled artifacts, the
reference provenance and the checksum of every input file. Its
`results_sha256` is identical whenever the report is regenerated from the
same files, which makes the assessment reproducible.

### The short-segment quiz

The quiz complements the continuous assessment: annotators see short segments
and choose the principal artifact type, in the spirit of the multiple-choice
EEG examination of Nascimento et al. (2023), which included an artifact
domain. It tests recognition only, not boundaries or channels.

```bash
electroclean-admin add-quiz-item /data/MyStudy pilot --item-id q01 \
    --recording sub-002/eeg/sub-002_task-rest_eeg.vhdr --start 9.2 --end 10.8 \
    --label EMG-artifact --explanation "High-frequency activity over temporal channels"
```

The order is shuffled reproducibly for each annotator. Results are saved in
`Annotated_Events/training/<set>/quiz/`.

## Before a study starts

1. Run the test suite on the computers that will be used (see the testing
   guide), including the manual checks listed there.
2. Fix the viewing filters and choose the allocation.
3. Check that every recording opens (any failures appear in the log).
4. Agree the analysis settings for the agreement analysis and write them in a
   JSON file (`electroclean-agreement --config settings.json …`).
