# Reliability analysis guide

This guide explains how ElectroTag compares annotations from several
annotators (Component B), which assumptions each measure makes and how to read
the results. The same code compares annotators with a reference in the
training component.

## The question being asked

Two annotators reviewing the same continuous recording can disagree in three
ways: about **category** (one calls it an eye blink, the other a vertical eye
movement), about **time** (both mark the blink but place its start and end
differently, or only one marks it) and about **channels** (both mark an
electrode pop, on different channels). ElectroTag measures all three, and
reports each separately, because a single number cannot show which kind of
disagreement occurred.

## Running an analysis

```bash
electrotag-agreement Annotated_Events --out agreement_results \
    --resolutions 0.01 0.05 0.1 --min-bin-coverage 0.5 \
    --criterion iou --iou-thresholds 0 0.2 0.5 --primary-iou 0.2
```

`electrotag-agreement --help` describes every option with its unit and
default. Without `--out` the results go to a new folder
`agreement_<date>-<time>` in the current folder, and a folder that already
holds the results of an earlier analysis is only reused with `--overwrite`, so
earlier results are never replaced by accident. Category and annotator names
are checked against the data: a mistyped name (`--categories EMG` instead of
`EMG-artifact`) stops the analysis with a suggestion rather than producing an
empty category. The exit status is 0 when the analysis ran, 2 for a mistake in
the command and 3 when it ran but no recording was annotated by two of the
annotators being compared.

The admin area of the browser application ([web/admin.md](web/admin.md)) runs
the same analysis on the study's saved results, for the annotators, recordings
and settings chosen there, and offers the report and the tables to download.
For a study on Firebase, `electrotag-web export` writes the results into an
`Annotated_Events` folder for the command. From Python:

```python
from electrotag.reliability import AnalysisConfig, run_analysis, write_outputs
result = run_analysis(["Annotated_Events"], AnalysisConfig(resolutions_s=(0.01, 0.05, 0.1)))
write_outputs(result, "agreement_results")
```

`run_analysis(..., strict=True)` applies the same name checks as the command
line; `progress` and `cancel` callbacks report each step and stop the
analysis.

Input folders are searched for `*_annotations.json` files. By default only
standard-mode annotations are used (training files are excluded). Files are
grouped by recording; only recordings annotated by at least two annotators
contribute to comparisons. When no recording has two annotators to compare,
or only some have, the report and the command line say so first, and the
agreement tables are written with their header row and no data rows. Every
setting, the input files and their SHA-256 checksums are written to
`analysis_settings.json`, so an analysis can be repeated exactly.

**Checks before comparing.** All files must use the same label catalogue or
compatible versions of it (see *Label catalogue versions* below); files whose
catalogue gives a label or code a different meaning are refused. Files whose
sampling frequency or number of samples
differ from the other annotators' for the same recording are excluded with a
warning, because they cannot refer to the same data. The expected timing is
that of the `reference_annotator`, if one is set, and otherwise the timing
shared by most of the files; when two timings are equally common the
recording is excluded. A differing data
checksum is reported. If an annotator has several files for one recording,
the most recent is used (or the analysis stops, with
`duplicate_policy="error"`).

## 1. Time-resolved agreement

For each recording, category and pair of annotators, the recording is divided
into the time marked by both annotators (*a*), by only the first (*b*), by
only the second (*c*) and by neither (*d*). Overlapping annotations of the same
category by one annotator are combined first: the question here is whether an
annotator considered that time affected by that type of artifact.

Two representations are computed:

* **Exact.** Interval arithmetic on samples gives *a*, *b*, *c* and *d* in
  seconds without any approximation.
* **Binned.** The recording is cut into bins of a chosen width (10, 50 and
  100 ms by default). A bin is positive for an annotator when that annotator's
  intervals cover at least `min_bin_coverage` of it (0.5 by default; 0 means
  any overlap). Comparing results across widths shows how much agreement
  depends on the precision of boundaries. Resolution is an analysis setting
  and does not change the stored annotations.

Tables are computed per recording and pooled over recordings by adding the
2×2 tables (so long recordings weigh more than short ones).

From each table ElectroTag reports:

| Measure | Formula | Notes |
|---|---|---|
| Proportion agreement | (a + d) / N | Dominated by clean EEG; never use alone |
| Positive agreement | 2a / (2a + b + c) | Agreement about where artifacts are; undefined if neither annotator marked anything |
| Negative agreement | 2d / (2d + b + c) | Agreement about where the EEG is clean |
| Cohen's kappa | (p_o − p_e) / (1 − p_e) | Chance-corrected; undefined when an annotator used only one value |
| Prevalence of each annotator | (a + b) / N, (a + c) / N | How much time each annotator marked |
| Prevalence index | (a − d) / N | Large in magnitude when the category is rare |
| Bias index | (b − c) / N | Systematic difference in how much the annotators mark |
| PABAK | 2 p_o − 1 | Prevalence- and bias-adjusted kappa; reported for comparison only |

Cohen's kappa follows Cohen (1960). Reporting positive and negative agreement
alongside kappa follows Cicchetti and Feinstein (1990), who proposed them as
separate indexes of agreement on positive and negative decisions to resolve
the paradoxes described by Feinstein and Cicchetti (1990). The prevalence and
bias indices and PABAK follow Byrt, Bishop and Carlin (1993).

**Several annotators.** Fleiss' kappa (Fleiss, 1971) and Krippendorff's alpha
with the nominal metric (Hayes and Krippendorff, 2007) are computed from all
annotators of each recording. Fleiss' kappa requires every unit to be rated
by the same number of annotators and is reported as undefined otherwise;
alpha handles recordings with different numbers of annotators. For the exact
representation the units are samples; for binned representations they are
bins. Alpha's small-sample correction depends on the number of units, so it
is always computed on counts of units, never on durations.

**The "ANY-artifact" row** treats any artifact label as present. It measures
agreement on *whether* something is an artifact, regardless of its type.
Comparing it with the per-category rows separates detection disagreements
from classification disagreements. When the analysis is limited to some
categories (`categories`), ANY-artifact pools only those categories.

**Group terms and roll-ups.** Annotators can choose a HED-SCORE group term
(such as Eye-artifact) when the exact type is unclear. Every label, specific
or group, has its own row, which counts only annotations with exactly that
label. In addition, each group term has a **roll-up** row, named for example
"Eye-artifact + subtypes", which counts annotations with the group term or any
type below it. If one annotator marks a blink as Eye-blink-artifact and the
other as Eye-artifact, they disagree in the Eye-blink-artifact row but agree in
the Eye-artifact roll-up, which is the honest summary: they agree that it is
an eye artifact, not on how specific to be. The roll-up of Data-artifact, the
top of the hierarchy, would repeat ANY-artifact and is not reported. The
micro-averaged event measures use the exact-label rows only, so every
annotation is counted once. Set `include_group_rollups` to false to leave the
roll-ups out.

**Label catalogue versions.** Files made with different versions of
ElectroTag's label catalogue are analysed together when the versions are
compatible (every label they share has the same code, which ElectroTag
guarantees by never reusing codes), using the larger catalogue; the report
notes the versions.

When a `reference_annotator` is set, pairwise statistics, including the mean
pairwise kappa in `timeresolved_multirater.tsv`, use only the pairs that
include the reference, while Fleiss' kappa and Krippendorff's alpha still use
every annotator of the recording.

### Why there is no single overall agreement figure

When artifacts occupy a small fraction of a recording, two annotators who
mark nothing at all agree on almost all of the time, and two annotators who
mark completely different intervals still agree on most of the recording.
Proportion agreement and negative agreement are therefore close to 1 almost
regardless of how well artifacts are identified. Kappa corrects for chance but
behaves paradoxically when prevalence is low or very unequal between
annotators: it can be low although agreement on the few positive intervals is
good (Feinstein and Cicchetti, 1990). The report therefore leads with positive
agreement, shows kappa with the prevalence and bias indices, and adds the
event-based measures below. Its *Key results* box gives, for each pair of
annotators, positive agreement and kappa for any artifact over time and the
event F1 over all categories, as a starting point for the detailed sections.

**Rare categories.** A category annotated only once or twice gives agreement
values that mean very little (one missed blink can turn positive agreement
from 1 to 0). The report's tables give the number of annotations of each
category, and its figures leave out categories with fewer than
`min_events_per_category` annotations in total (5 by default; `--min-events`
on the command line), listing them below the figure instead.

**Units are not independent.** Neighbouring samples or bins are strongly
correlated, so the usual standard errors of kappa would be far too small. No
confidence intervals are reported for time-resolved statistics. If intervals
are needed, a bootstrap over recordings is the appropriate approach.

## 2. Event-based agreement

Each annotation is also treated as an event. For each pair of annotators
(the first acting as the reference, or a designated reference annotator),
category and recording, every reference event is compared with every event of
the other annotator.

**When can two events match?** With the `iou` criterion, two events are
eligible when their temporal intersection over union (IoU) reaches the
threshold. A threshold of 0 means any overlap, which corresponds to the
"any-overlap" scoring discussed by Ziyabari et al. (2017). Higher thresholds
require closer agreement on boundaries; Warby et al. (2014) used 0.2 in their
evaluation of sleep-spindle detection. With the `tolerance` criterion the
onsets and the offsets must each lie within a tolerance (overlap is not
needed, which suits very short events such as blinks); `iou_and_tolerance`
requires both. In time-and-channel mode the events must also share channels
(see section 3).

**How are events matched?** By default, one-to-one: each event can match at
most one event of the other annotator. Among all possible one-to-one
assignments, ElectroTag chooses the one with the largest number of matches
and, among those, the largest total IoU. This is solved exactly with the
Hungarian algorithm after sorting events by onset, offset and identifier, so
the result is deterministic. A simple greedy rule (best IoU first) can match
fewer events: if one reference event overlaps two events and another
reference event overlaps only one of them, the greedy rule may leave one
unmatched. For the ANY-artifact row, where all categories are pooled, ties
in the number of matches are broken first in favour of pairs with the same
label, so that an annotator who marked two labels over the same interval is
matched on the one the reference used. If `allow_many_to_one` is set, every
eligible pair counts as a match instead.

From the matches:

* **Recall** (sensitivity) is the proportion of reference events matched,
  **precision** the proportion of the other annotator's events matched, and
  **F1** their harmonic mean. For one-to-one matching F1 does not depend on
  which annotator is the reference.
* **Boundary agreement** for matched events: mean, standard deviation and
  median of the onset, offset and duration differences (other minus
  reference), the mean absolute difference and the 95% limits of agreement
  (mean ± 1.96 SD).
* **Mean IoU** and **mean channel Jaccard index** of matched events.

Results are given for every IoU threshold, by category, and as a
micro-average over categories. Every matched pair is listed in
`events_matched.tsv` and every unmatched event in `events_unmatched.tsv`, so
disagreements can be inspected individually and re-analysed.

## 3. Channels

Two modes are always reported:

* **Time only** ignores channel selections: an annotation counts wherever it
  is in time.
* **Time and channel** treats each channel separately and pools the results,
  so units are channel-seconds (or channel-bins). A **whole-montage annotation
  counts for every channel of the recording**, so a whole-montage annotation
  and an annotation on one channel overlap on that one channel only. For
  event matching, two events must share at least one channel (Jaccard index
  above `min_channel_jaccard`, 0 by default); the channel Jaccard index of
  matched events measures how similar the selections were.

Different recordings may have different channel sets: each recording is
analysed with its own channels and the results are pooled. If annotators'
files for the same recording list different channels (which should not
happen), only the shared channels are used and a warning is given.
EOG and ECG channels are part of the montage: by default they are included in
the channel analyses like every other channel, and a whole-montage annotation
covers them. `channel_exclude` removes channels (for example EOG) from channel
analyses if a study decides otherwise.
In time-and-channel mode, a channel-specific annotation none of whose
channels remain in the analysis is left out entirely (it covers no analysed
channel-seconds and takes no part in event matching); it still counts in
time-only mode.

## 4. Category disagreements

`confusion_time_weighted.tsv` gives, for each pair of annotators, the time
during which the first used one label and the second another ("none" means no
label). It shows, for example, how much time one annotator called eye blink
while the other called vertical eye movement.

## 5. Confidence of the annotations

Annotators may rate their confidence in each mark on an ordinal 5-point
Likert scale: 1, not at all confident; 2, slightly; 3, moderately; 4, very;
5, completely confident. `confidence_by_annotator.tsv` gives, for each
annotator, the study's confidence setting, how many marks were rated, how many
had each rating, the median rating, and how many carry a note. The ratings are
ordinal, so they are counted and compared, never averaged; and annotators use a
scale differently, so each annotator's ratings are best read against their own.

When any mark was rated, two more tables are written.
`confidence_sensitivity.tsv` is a sensitivity analysis: positive agreement and
Cohen's kappa (sample by sample, all recordings pooled) and event F1 at the
main threshold, per category, channel mode and pair of annotators, for all
marks (`*_all`) and again without the marks of low confidence, rated 1 or 2
(`*_without_low_confidence`). Unrated marks stay in both sets. When agreement
rises without the low-confidence marks, much of the disagreement lies in marks
the annotators themselves doubted. `confidence_calibration.tsv` gives, for each
annotator and for all annotators together, and for each rating (and for unrated
marks), the number of marks and the share that at least one other annotator of
the same recording also found: a mark of the same type that matches it, time
only, by the study's matching criterion at the main threshold, one to one
within each pair. If the share rises with the rating, the ratings tell which
marks others agree with; a share based on a few marks is unreliable.

How to read these depends on the study's setting, which the report states. With
`every_mark`, annotators were asked to rate each new mark, and no mark started
with a rating, so an unrated mark is one they chose to leave. With `optional`,
ratings were volunteered, so the rated marks are a self-selected subset and the
confidence of an unrated mark is unknown. Every other table uses all marks.
Annotators' notes are listed with each event in `events_matched.tsv` and
`events_unmatched.tsv` and take part in no statistic.

## Choosing settings

ElectroTag's defaults are starting points. The research team should choose
and report the bin widths, the coverage rule, the matching criterion and
thresholds and whether many-to-one matches are allowed, ideally before seeing
the results. Reasonable choices depend on the artifact: a 100 ms tolerance is
large for a 50 ms electrode pop and small for a 4 s slow eye movement, which is
why results are given per category.

## Extending the analysis

Measures are registered in `electrotag.reliability.analysis.MEASURES`. A new
measure is a function receiving the loaded dataset and the configuration and
returning named tables; registering it with `register_measure` adds its
tables to the outputs and to the report. Statistics designed for unitized
continuous data, such as Krippendorff's unitizing alpha (Krippendorff, 1995)
or the gamma method (Mathet, Widlöcher and Métivier, 2015), would fit this
way, because the dataset object gives direct access to every annotator's
intervals and channels.

## References

See [references.md](references.md) for full details and DOIs: Byrt et al.
(1993); Cicchetti and Feinstein (1990); Cohen (1960); Feinstein and Cicchetti
(1990); Fleiss (1971); Hayes and Krippendorff (2007); Krippendorff (1995);
Mathet et al. (2015); Warby et al. (2014); Ziyabari et al. (2017).
