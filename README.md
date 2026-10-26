# ElectroClean

ElectroClean is a desktop application for the manual annotation of artifacts
in continuous EEG recordings, together with tools for measuring how
consistently different annotators work and for training and assessing new
annotators. It was written for a PhD project on EEG artifact identification
and on the development and evaluation of automated EEG cleaning.

It has three parts that share one annotation file format:

| Component | What it does | How to start it |
|---|---|---|
| **A. Annotation** | View continuous BrainVision EEG with MNE-Python's browser, mark artifact intervals with one of 16 HED-SCORE categories on the whole montage or on chosen channels, and save validated, BIDS-compatible outputs. | `electroclean` or a launcher in `launchers/` |
| **B. Inter-rater agreement** | Compare annotators by category, time and channel: time-resolved and event-based agreement, with an HTML report and tables. | `electroclean-agreement`, or *Tools → Inter-rater agreement analysis* |
| **C. Training and assessment** | Practice with feedback against expert references, blinded competency assessment with administrator-defined criteria, and an optional short-segment quiz. | Training modes in the start window; `electroclean-admin` and *Tools → Administrator tools* |

Everything runs locally without an internet connection, and the original EEG
files and metadata are never modified.

![The annotation window](docs/images/annotation_window.png)

## Installation

ElectroClean needs **Python 3.12 or 3.13** (64-bit) and runs on Windows,
macOS and Linux. It was developed and tested on Linux with Python 3.13; the
Windows and macOS launchers follow standard conventions but should be checked
on those systems before a study starts (see `docs/testing_guide.md`).

### The simple way (no Python knowledge needed)

1. Install Python 3.12 or newer from [python.org](https://www.python.org/downloads/).
   On Windows, tick *Add python.exe to PATH*.
2. Download or copy this folder to the computer.
3. Double-click the launcher for your system in the `launchers` folder:
   `ElectroClean.bat` (Windows), `ElectroClean.command` (macOS; the first time,
   right-click it and choose *Open*) or run `launchers/electroclean.sh` (Linux).

The first start creates a private environment in the `.venv` folder and
installs the exact library versions listed in `requirements.txt`. This needs
an internet connection once; afterwards ElectroClean works offline.

**Offline installation.** On a computer with internet access and the same
operating system and Python version, run
`python -m pip download -r requirements.txt -d wheels` inside this folder and
copy the folder, including `wheels`, to the offline computer. The launchers
install from `wheels` automatically when it is present.

### For developers

```bash
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
python -m pip install -r requirements-dev.txt
python -m pip install --no-deps -e .
python -m pytest                     # 178 tests, about 35 s
electroclean                         # start the application
```

`requirements.txt` pins every package to the versions used for testing
(MNE 1.13.2, mne-qt-browser 0.7.5, PySide6 6.12.0, NumPy 2.5.4, SciPy 1.18.1,
pandas 3.1.0). `pyproject.toml` gives the compatible ranges.

## Try it with synthetic data

```bash
python examples/launch_demo_gui.py          # opens the app on a new synthetic dataset
python examples/demo_end_to_end.py          # runs the whole workflow without the GUI
```

The second command creates three synthetic recordings with known artifacts,
has three simulated annotators annotate them through the same session code the
application uses, runs the agreement analysis, and takes an annotator through a
competency assessment. Its outputs are kept in `examples/example_output/`.

## Annotating, in brief

On the start window enter your annotator ID (letters and digits, for example
`A01`), choose the folder with the recordings and press **Begin new session**.
ElectroClean finds every `*_eeg.vhdr` file in that folder and its sub-folders,
picks a recording you have not completed yet, asks which viewing filters to
use (1 Hz high-pass and 60 Hz notch by default; they change only the display),
and opens it. Choose the artifact type in the toolbar, choose *Whole montage*
or *Selected channels*, and drag across the EEG to mark an interval. When you
have reviewed the whole recording, press **Save and Finish**. The
[user guide](docs/user_guide.md) explains every step with screenshots.

## What is saved

Results go to an `Annotated_Events` folder in the dataset folder (this can be
changed). For each recording and annotator ElectroClean writes five files
whose names start with the recording's name and the annotator, for example
`sub-001_task-rest_eeg_annotator-A01`:

| File | Contents |
|---|---|
| `…_events.tsv` | The recording's original events, unchanged, plus one row per artifact with `onset`, `duration`, `trial_type` (HED-SCORE label), `value` (code 100-115), `sample`, `channels` (JSON list; `[]` means the whole montage) and columns identifying the source, annotation and annotator. |
| `…_events.json` | BIDS sidecar describing every column, the artifact codes and their HED tags. |
| `…_annotations.json` | The canonical, lossless record of the annotations, used by the agreement and training tools. |
| `…_time_viewed.txt` | One number: seconds spent annotating, measured with a monotonic clock. |
| `…_session.json` | Session metadata: times, software versions, filter design, checks and warnings. |

A recording is marked complete for that annotator, in
`completion_register.tsv` and in the annotator's `completed_datasets.txt`, only
after all five files have been written, read back and verified. Another
annotator can still annotate the same recording. Load failures are recorded in
`failed_load.txt` and `failure_log.jsonl`. The formats are specified in
[docs/file_formats.md](docs/file_formats.md); a real example is in
[`examples/example_output`](examples/example_output/Annotated_Events/annotator-A01/sub-001/eeg).

Example artifact rows from an exported events file:

```text
onset   duration  trial_type               value  sample  channels               event_source           annotation_id  annotator_id  original_row
2.996   0.428     Eye-blink-artifact       103    749     ["Fp1","Fp2","VEOG"]   electroclean_artifact  f70bc89f…      A01           n/a
9.172   1.576     EMG-artifact             102    2293    ["F7","T7"]            electroclean_artifact  305eb9c7…      A01           n/a
13.972  0.544     Electrode-pops-artifact  114    3493    ["C3"]                 electroclean_artifact  0a03e40a…      A01           n/a
```

## Agreement analysis

```bash
electroclean-agreement path/to/Annotated_Events --out agreement_results
```

This produces `agreement_report.html` and tab-separated tables. Agreement is
reported by artifact category, by annotator pair and over time at several
resolutions, for time alone and for time and channel together, and with
event matching (precision, recall, F1, boundary differences). The
[reliability guide](docs/reliability_guide.md) explains each measure and its
assumptions.

## Training and assessment

An administrator prepares a *reference set* of expert-annotated recordings
(from one expert, a consensus of several, or an adjudicated consensus), marks
each as practice or assessment, and can set competency criteria. Annotators
choose *Training* or *Competency assessment* on the start window. Practice
gives immediate feedback and a side-by-side review against the reference;
assessment is blinded and ends with a reproducible competency report. See the
[administrator guide](docs/administrator_guide.md).

## Documentation

| Document | For |
|---|---|
| [User guide](docs/user_guide.md) | Annotators |
| [Administrator guide](docs/administrator_guide.md) | Study set-up, allocation, reference sets, competency criteria |
| [Reliability analysis guide](docs/reliability_guide.md) | Agreement measures and their interpretation |
| [File formats](docs/file_formats.md) | Every output and configuration file |
| [Developer guide](docs/developer_guide.md) | Architecture, MNE integration, extension points |
| [Testing guide](docs/testing_guide.md) | Running the tests, synthetic data, manual checks |
| [Design decisions](docs/design_decisions.md) | How the specification was interpreted, and questions for the research team |
| [HED-SCORE validation](docs/hed_score_validation.md) | Check of the 16 labels against HED SCORE 2.2.0 |
| [References](docs/references.md) | Literature cited in the documentation |

## Repository layout

```text
electroclean/
    app/            Component A: annotations, eeg, io, session, validation (no Qt) and gui (PySide6)
    reliability/    Component B
    training/       Component C
    config/         label catalogue, default settings, HED-SCORE validation snapshot
    synthetic.py    synthetic BrainVision/BIDS data with known artifacts
tests/              pytest suite (unit, integration and offscreen GUI tests)
examples/           demo scripts and example outputs
docs/               documentation and screenshots
launchers/          double-click launchers
scripts/            maintenance scripts (label validation, screenshots)
```

## Acknowledgements

ElectroClean is built on [MNE-Python](https://mne.tools) and its Qt browser
(Gramfort et al., 2013), uses the HED-SCORE artifact vocabulary (Hermes et
al., 2025) and follows the EEG-BIDS conventions (Pernet et al., 2019). Full
references are in [docs/references.md](docs/references.md).
