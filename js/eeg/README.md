# The EEG library of the browser application

This folder holds everything the browser needs to read an EEG recording, filter it for display,
fingerprint it and describe it for a study, as plain ES modules with no build step and no
dependencies. The modules give the same values, warnings and wording as ElectroTag's Python core,
which reads recordings with MNE-Python, so that a recording opened in a browser and the same
recording registered with `electrotag-web register` agree field by field. The rest of the
application uses the library; the library never uses the application.

## The rule of the folder

A module here imports only its neighbours in this folder. It never imports the views, the
annotation workspace, the back ends or anything else under `js/` (`js/views`, `js/api`,
`js/annotate`, `js/admin`, `js/training`, `js/ui`, `js/log`, `js/data` and the rest), whether by a
static `import`, a dynamic `import()` or a worker's `new URL(...)`. Whatever the library needs from
the application is passed in by the caller: `register.js`, for instance, takes the label catalogue
as `options.catalogue`, and the admin area gives it ElectroTag's own. This keeps the folder ready to
become a package of its own, and `web_tests/unit/eeg_imports.test.mjs` checks the rule on every
run. Workers are created with `new URL("./worker.js", import.meta.url)`, so every path stays
relative and the application works under `/preview/` on GitHub Pages.

## Reading recordings

`recording.js` is the entry point: `openRecording(files)` returns the `Recording` object of
`docs/web/architecture.md` ("The Recording interface") and decides where the reading happens, in a
Web Worker (`worker.js`) when the browser allows one and on the page otherwise. `engine.js` does the
work in either place: it opens the files, scans them once for annotations and triggers while the
fingerprint is computed, keeps decoded blocks and filtered pieces in caches of bounded size and
answers requests for windows of samples. `files.js` finds which of the picked files belong together
(an EDF or BDF file, or the header, marker and data files of a BrainVision recording).

`edf.js` reads EDF, EDF+ and BDF files and gives the values of MNE-Python's `read_raw_edf` and
`read_raw_bdf` with `infer_types=False`, with the trigger codes of `mne.find_events` on a Status or
stimulus channel and the header checks of `electrotag/app/io/edf.py`. `brainvision.js` reads
BrainVision files as `read_raw_brainvision` does: values, channel names, markers and the
measurement date. `channels.js` infers channel types from names and knows the housekeeping channels
of common headsets. `electrodes.js` reads a BIDS `electrodes.tsv` with its `coordsystem.json` for
the channel map. `events.js` gives a recording's original events as `electrotag/app/eeg/events.py`
records them, from `events.tsv`, the EDF+ annotations, the BrainVision markers (with the codes of
`mne.events_from_annotations`) or the trigger channels. `util.js` holds the small helpers the readers
share, among them `RecordingError`, whose `kind` matches the Python loader's `RecordingLoadError`.

## Signal processing

`filters.js` designs and applies the display filters exactly as the Python core asks MNE-Python to:
a high-pass filter (`mne.io.Raw.filter`) followed by a notch filter (`mne.io.Raw.notch_filter`),
both FIR and zero phase, designed as `mne.filter.create_filter` and `scipy.signal.firwin` design
them, with a Hamming window, the "auto" length and "reflect_limited" padding, each continuous
segment filtered on its own. `fft.js` is the radix-2 Fourier transform behind the filters' FFT
convolution. `pool.js` and `filterworker.js` share the filtering of a window among several
processor cores. `amplitude.js` is the plausibility check of `electrotag/app/eeg/amplitude.py`,
which spots traces stored in the wrong unit. `mnewarn.js` works out from the headers the warnings
MNE-Python gives while it reads a recording (with `read_raw_edf`, `read_raw_bdf`,
`read_raw_brainvision` and `Raw.set_annotations`) and holds the annotations the way MNE does.

## Fingerprints and registration

`sha256.js` computes the SHA-256 of a data file in pieces, giving the same hex digest as Python's
`hashlib.sha256`, which is a recording's fingerprint; `hashworker.js` computes it in a helper worker
while the reading worker scans the file. `register.js` builds, for the admin area, the same internal
manifest that `electrotag.web.manifest.build_manifest` builds from MNE-Python's reading of the
files: timing, channels, BIDS sidecars, original events, gaps, the amplitude check, fingerprints,
warnings and notes. `bids.js` ports `electrotag/app/io/bids.py` and `tsv.py` (BIDS names, the
sidecars a recording inherits, the exact reading of TSV and JSON). `pyfmt.js` and `pyjson.js`
imitate Python's ways of writing numbers and text (`repr` of floats and strings, format
specifications) and of reading JSON and UTF-8 with Python's own error messages, so that a manifest
holds exactly the strings the Python code writes.

## Synthetic recordings

`synthetic.js` makes the demonstration's recordings, with artifacts at known places, computed from
a seed on demand; `syntheticEdfBytes` writes the same recording as an EDF file, from which the
demonstration's fingerprints are computed. Its guided-training ground truth matches
`electrotag/synthetic.py` and `electrotag/training/guided.py`.

## How the parity is checked

The unit tests in `web_tests/unit/` run the modules in Node.js against what Python and MNE-Python
give for the same files, which `scripts/make_web_fixtures.py` writes into `web_tests/fixtures/` (the
tests run it themselves when the files are missing or out of date). `data_readers.test.mjs`
compares the readers with MNE's reading (samples, channels, markers, gaps, triggers and the
refusals); `data_dsp.test.mjs` the FFT and the filter designs with a direct transform and
`create_filter`; `data_filtering.test.mjs` the filtered windows with
`electrotag.app.eeg.filtering.apply_view_filters`; `data_amplitude.test.mjs` the amplitude check;
`data_sha256.test.mjs` the fingerprints with the FIPS 180-4 examples and `node:crypto`;
`data_recording.test.mjs` the `Recording` interface; and `data_perf.test.mjs` the times on a large
recording (`--perf`). `data_register.test.mjs` compares the manifests field by field with those
`web_tests/register_parity.py` builds with the Python core (`scripts/make_channel_matrix.py` adds 32
recordings of 1 to 257 channels in every format and edge case to the readers' and registration's
recordings, and `ELECTROTAG_REAL_EEG` adds a folder of real ones), and `data_register_py.test.mjs` checks
`pyfmt.js` and `pyjson.js` against Python itself on a corpus of values. `ui_synthetic.test.mjs`
reads the synthetic EDF back with the readers, and `ui_rules.test.mjs` with
`web_tests/guided_parity.py` checks the synthetic ground truth against Python. In the browsers,
`web_tests/e2e/j_register.e2e.mjs` registers datasets in the reading worker and
`d_local_file.e2e.mjs` opens recordings from disk. A change to a module here and to its Python
counterpart is made together, and these tests are what show they still agree.
