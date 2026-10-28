# ElectroClean in the browser: architecture

ElectroClean keeps every EEG recording on the annotator's own computer.
The annotator receives the recordings locally (for example on an encrypted
drive) and opens them in a web page; the page reads the file directly from
their disk, so the EEG is never uploaded. A light server holds the study's
records and receives the results.

## Where it runs

The browser application is a set of static files (no build step), published
on **GitHub Pages**: the released version at the site's root and previews of
work in progress under `preview/`. Pages only serves files, so it runs the
application in one of two ways:

* **Demonstration**, with no server at all: built-in example recordings, demo
  accounts and the training rules run in the browser, and results stay in the
  browser. This is the default when no study server is configured.
* **Study on Firebase** (the chosen way to run real studies): sign-in with
  Firebase Authentication, the study's records in Firestore (in Google's London
  region, europe-west2), and the private work done by Python Cloud Functions
  that reuse ElectroClean's own code: matching a file against the register,
  validating and storing results, checking guided training attempts and scoring
  practice recordings, so the experts' answers never reach the browser. The
  Firebase project's public web configuration is given in `config.json` beside
  the application (`{"firebase": {...}, "study": "<study id>"}`); a link may
  pick another study of the same project with `?study=<id>`. A command exports
  the results from Firestore into ElectroClean's usual folders for the
  agreement and activity analyses.
* **Study on an ElectroClean server** (`electroclean-web`, Python): the same
  operations over HTTP, used for local testing and the demonstration server,
  and available to a study that prefers its own server (for example a
  university machine). Its address comes from `?server=https://…`,
  `config.json` (`{"server": "…"}`) or the sign-in screen.

Both study back ends perform the same operations with the same JSON (docs/web/api.md):
over HTTP for the server, and as Firebase callable functions named `ec_<operation>`
for Firebase. In the browser, `js/api/http.js` and `js/api/firebase.js` implement the
same Backend interface, so the rest of the application does not know which is in use.
On the server side one Python service layer implements the operations against a
storage interface with two implementations: files and SQLite (the server) and
Firestore (Firebase).

The server can also serve the application itself (same origin), which is how
it runs locally and how a study can avoid GitHub Pages altogether. Because the
application on github.io and a server elsewhere are different sites, browsers
would treat a session cookie as a third-party cookie and many block those, so
the server signs requests with a bearer token (`Authorization: Bearer …`,
returned by sign-in) and allows the application's origin through CORS.

## Who does what

**The browser** reads EDF, EDF+, BDF and BrainVision files, computes the
fingerprint of the data file (SHA-256, the same checksum that ElectroClean's
Python code records for a recording's `eeg` source file), filters for display,
draws the EEG, and provides the annotation and training tools (number keys and
type buttons, the type picker, M / [ / ] marks, N / P, C, Draw as / Change to,
undo and redo, merging of overlapping annotations of one type, the training
coach, the practice review and the short-segment quiz). It keeps a draft of
unsaved work in the browser and on the server, and sends interaction events to
the server. For administrators it holds the admin area (docs/web/admin.md),
which registers recordings from the files on the administrator's own computer
and sends the study only their manifests.

**The server** (Python, `electroclean/web/`) holds:

* the study: settings, the label catalogue, accounts and assignments;
* the register of recordings: for each one a *manifest* made by the study
  administrator from the real files (fingerprints, timing, channels shown and
  hidden, channel types, original events, gaps, display scalings), so the
  server never needs the EEG itself;
* the results, written with ElectroClean's own code in its results layout
  (`Annotated_Events/...`, `interaction_logs/...`), which the agreement
  analysis and the activity analysis read as they are;
* the training reference annotations, which never leave the server: it checks
  each guided attempt and scores each practice recording and only returns the
  feedback.

## Folder layout

```
electroclean/web/                 the server (FastAPI), the service layer it shares with the Firebase
                                  functions, and the administrator's command, electroclean-web
electroclean/web/firebase/        the Cloud Functions (functions/main.py) and the administrator's access
electroclean/web/static/          the browser application (plain ES modules, no build step)
    index.html, app.css           the page and the application's design system (tokens, components)
    fonts/                        Space Grotesk, Instrument Sans and JetBrains Mono (woff2, with
                                  their licences; made by scripts/make_web_fonts.py)
    admin.css                     the admin area's own layout, loaded when it is first opened
    js/main.js, js/app.js         start-up; the backend, signing in and the moves between views
    js/catalogue.js, js/util.js   the label catalogue; small helpers
    js/views/                     sign in, the annotator's recordings, opening a recording
    js/api/                       the Backend interface: http.js (a study server), firebase.js (a
                                  study on Firebase), demo.js and demo_admin.js (the demonstration,
                                  in the browser), choose.js (which of them), demo_catalogue.js,
                                  notice.js
    js/data/                      reading recordings: recording.js, worker.js, engine.js, files.js,
                                  edf.js, brainvision.js, channels.js, filters.js, fft.js, pool.js,
                                  filterworker.js, sha256.js, hashworker.js, amplitude.js, util.js,
                                  synthetic.js; registering them: register.js, bids.js, events.js,
                                  mnewarn.js, pyfmt.js, pyjson.js
    js/viewer/                    drawing the EEG, axes, overview, navigation
    js/annotate/                  the annotation view (workspace.js), the annotation store, the
                                  dialogs, the help and the session with its drafts
    js/training/                  the training path, the coach, the practice review, the
                                  demonstration's guided rules and practice scoring, and the
                                  short-segment quiz (quiz.js)
    js/admin/                     the admin area (area.js) and its sections: overview, recordings,
                                  annotators, assignments, training, analyses, results, records and
                                  settings; model.js holds its rules without the page, ui.js its pieces
    js/ui/                        dialogs, menus, building elements, the colours for the canvas
    js/log/                       the interaction logger
electroclean/app/                 the Python core: annotations, reading recordings with MNE-Python
                                  (eeg/), files and the export (io/), the journalled save (session/)
electroclean/config/              the default settings and the artifact label catalogue
electroclean/training/            reference sets, guided training, practice scoring, the quiz and
                                  competency reports (electroclean-admin)
electroclean/reliability/         the agreement analysis (electroclean-agreement)
electroclean/activity/            the activity analysis of the interaction logs (electroclean-activity)
web_tests/unit/                   node --test unit tests of the browser modules
web_tests/e2e/                    Playwright end-to-end tests
docs/web/api.md                   the HTTP API (the contract between browser and server)
```

## The Recording interface (browser)

`js/data/recording.js` exports `openRecording(files: File[]) -> Promise<Recording>`
(one file for EDF and BDF; the .vhdr, .vmrk and .eeg for BrainVision, picked
together or as a folder). `js/data/synthetic.js` exports
`makeSyntheticRecording(spec) -> Recording` with the same interface, for the
demonstration and for tests.

```js
Recording = {
  format: "edf" | "bdf" | "brainvision" | "synthetic",
  fileName: string,            // the data file's name (the .edf/.bdf, or the .vhdr for BrainVision)
  stem: string,                // name without _eeg and extension, e.g. "sub-001_task-rest"
  sizeBytes: number,           // size of the data file (the file that is fingerprinted)
  sfreq: number, nSamples: number, durationS: number,
  measDate: string | null,     // ISO 8601, if the file has one
  channels: [{ name, type /* "eeg" | "eog" | "ecg" | "emg" | "misc" | "stim" */, unit /* "V" */ }],
  markers: [{ onsetSample, durationSamples, description }],   // EDF+ annotations, .vmrk markers, BDF Status
  gaps: [[startSample, endSample]],                           // stretches marked as having no data
  warnings: [string],
  async fingerprint(onProgress?: (fraction) => void) -> { algorithm: "sha256", role: "eeg", hex, sizeBytes },
  async readWindow({ startSample, nSamples, channels /* indices */, filters /* see below */ })
      -> { startSample, nSamples, data: Float32Array[] /* volts, one per requested channel */,
           edgeZones: [[startSample, endSample]] },
  close(): void,
}
filters = { highpassHz: number | null, notchHz: number | null, notchHarmonics: boolean }
```

Filters are zero-phase and applied for display only. Long files are read in
pieces as the annotator scrolls (with enough padding for the filters), in a
Web Worker where available, so the page stays responsive and a 1 GB recording
never has to fit in memory at once.

The recordings that `openRecording` returns have a few more members, all
optional, so `synthetic.js` and any code written against the interface above
need not know about them:

```js
openRecording(files, options?)  // options: { onProgress({stage, fraction}), fileName, fingerprint,
                                //   filters, worker, blockCacheBytes, filterCacheBytes,
                                //   amplitude /* false: no amplitude check on opening */,
                                //   requireShown /* false: open even when every channel is hidden */ }
Recording += {
  dataFileName: string,          // the file that is fingerprinted (the .eeg for BrainVision)
  channels: [{ ..., origUnit, hidden }],  // the file's unit; hidden: suggested as not shown
  suggestedHidden: [string],     // trigger channels and device housekeeping channels
  markers: [{ ..., channels?, value?, channel? }],  // channels of an EDF+ annotation; code and
                                                    // channel of a marker read from a trigger channel
  markerSource: "annotations" | "triggers" | "none",
  triggers: [{ sample, code, channel }],          // every trigger code of the trigger channels
  discontinuities: [sample],     // BrainVision "New Segment" markers after the start
  notes: [string],               // information for the annotator, such as the hidden channels
  amplitudes: { eeg, eog, ecg, emg },             // volts, as electroclean/app/eeg/amplitude.py measures
  suggestedScalings: { eeg?, ... },               // display scales for implausible amplitudes
  readerKind: "worker" | "page",
  edgeZones(filters) -> [[startSample, endSample]],  // the hatched zones of the whole recording
  setChannelTypes(types),        // { name: type } or [type, ...], e.g. the manifest's channel_types
  // for registration (register.js):
  annotations: [{ onset, duration, description, channels }   // EDF+/BDF+ annotations as read (seconds)
               | { onsetSample, durationSamples, description }],  // or BrainVision markers (samples)
  mneTypes: [string],            // each channel's type as MNE-Python reads the file ("eeg", "stim", ...)
  async checkAmplitude({ filters, types, hidden }) -> { amplitudesV, suggestedScalings, warnings },
  async findTriggerEvents(channels, { mask }) -> [{ sample, code, channel }],  // as mne.find_events
}
readWindow({ ..., prefetch? })   // prefetch: false stops the next window being filtered ahead
  -> { ..., elapsedMs }
```

A channel's `unit` is "V" for voltage channels, "" for trigger channels and
the file's own unit for the few non-voltage channels BrainVision files can
hold (a temperature in °C, for example). `findRecordings(files)` lists the
recordings among picked files (for a folder holding several), and errors are
`RecordingError`s whose `kind` is the one ElectroClean's Python loader gives
(`RecordingLoadError` in `electroclean/app/eeg/loading.py`: `corrupt_recording`,
`unsupported_format`, `missing_companion`, `inconsistent_recording` and so on).

## Reading recordings in the browser

The modules in `js/data/` read EDF, EDF+, BDF and BrainVision recordings
without any library or build step. Each is a plain ES module that imports only
its neighbours in the folder, so the same files run from GitHub Pages, from the
study server and inside a claude.ai Artifact. `recording.js` holds
`openRecording` and the `Recording` object and decides where the reading
happens; `worker.js` is the reading worker and `engine.js` does the work
(opening, the scan of the file, the caches and the windows); `files.js` finds
which picked files belong together; `edf.js` and `brainvision.js` read the two
families of formats; `channels.js` knows channel types and device housekeeping
channels; `filters.js` and `fft.js` are the display filters, `pool.js` and
`filterworker.js` share them among several processor cores; `sha256.js` and
`hashworker.js` compute fingerprints; `amplitude.js` is the plausibility check
of the amplitude; `util.js` holds small helpers.

### What is read, and how it compares with MNE-Python

The readers give the values MNE-Python gives ElectroClean's Python loader
(`electroclean/app/eeg/loading.py`: `read_raw_edf` and `read_raw_bdf` with
`infer_types=False`, and `read_raw_brainvision`), in volts and computed in the
same order of operations, so a sample differs from MNE's double-precision value
only by its rounding to single precision (at most 6 parts in 100 million). For
EDF and BDF that is the stored integer times the physical range over the
digital range, plus the offset, times the unit factor, with MNE's rules for
units (µV written with the micro sign, the Greek mu, the Japanese code page or
as uV; mV; anything else taken as volts), for empty ranges and for the trigger
channels named Status or Trigger, which keep MNE's 17 lowest bits. For
BrainVision it is the stored value times the resolution times the unit factor,
with MNE's defaults for missing units and resolutions; channels with a
non-voltage unit, and channels placed at the origin of the header's
coordinates, are of type misc as in MNE. The header and marker files are
decoded with their `Codepage` (UTF-8 when it is absent, ANSI as Windows-1252),
falling back to Latin-1 as MNE does. BINARY data are read in both orientations
and in all three of MNE's sample formats (INT_16, INT_32, IEEE_FLOAT_32);
BrainVision files with ASCII data are refused with an explanation. A recording
is checked before it opens exactly as the Python loader checks it, with the
same wording: EDF+D and BDF+D files are refused, the size of an EDF or BDF file
is compared with its header (truncated copies and files longer than their
header are refused; a header without the number of records gives a warning), a
BrainVision data file must hold a whole number of samples and agree with
`DataPoints`, the header's companion files must have been picked, and markers
beyond the end of the data mean an incomplete copy.

Only one thing is read differently. A channel stored with fewer samples per
data record than the others (rare, but allowed by EDF) is interpolated
linearly to the recording's rate, while MNE resamples it with an FFT over the
part it reads; on such a channel the browser and MNE-Python agree to a few
per cent, and the recording says so in a warning.

EDF+ annotations are parsed as MNE parses them (including the time-keeping
offset of the first record and annotations that name a channel), and .vmrk
markers likewise (the first New Segment marker is left out, descriptions are
`Type/Description`, positions count from one). Annotations starting with
BAD_ACQ_SKIP become `gaps`, and New Segment markers after the start become
`discontinuities`, which the filters treat as ElectroClean's Python filtering
(`electroclean/app/eeg/filtering.py`) does. When a file has no event
annotations, the codes of its trigger channels become the markers, found as the
Python loader finds them (`electroclean/app/eeg/events.py`: `mne.find_events`
with `consecutive=True` and `shortest_event=1`, the lower 16 bits of a BDF
Status channel, the channel padded with zero after its end). The Python loader
reads trigger codes only when a file has no annotations at all, so for a BDF+
file whose only annotation is the BAD_ACQ_SKIP padding of its last record the
browser shows the trigger codes where the loader finds none.

Channel types come from the names: trigger channels, EOG, ECG (or EKG) and EMG
by the usual abbreviations, EEG otherwise. Trigger channels and channels
matching the default `channels.hide` patterns of ElectroClean's settings
(`electroclean/config/default_settings.json`: the Emotiv timestamp, counter,
contact-quality and battery channels) are marked `hidden` as a suggestion; when
the server has matched the recording, its manifest says what is shown, and
`setChannelTypes` applies its `channel_types`. Trigger channels are never
filtered.

### Fingerprints

`fingerprint()` is the SHA-256 of the data file, the same hex digest as the
`hashlib` checksum that ElectroClean's Python code records for a recording's
`eeg` source file (`fingerprint_sources` in `electroclean/app/eeg/loading.py`).
Files up to an eighth of the device's memory (at most 1 GB) are read into
memory and hashed with the browser's own `crypto.subtle`; larger files, and
browsers without it, stream through an incremental SHA-256 written for speed
(the 64 rounds unrolled, the message schedule in local variables). Files that
have to be scanned anyway (EDF+ annotations, trigger channels) are hashed
during the scan when the browser's own SHA-256 cannot take them; inside the
reading worker the fingerprint is instead computed by a helper worker while the
file is scanned.

### Display filters

`filters.js` designs the filters that ElectroClean's Python filtering
(`apply_view_filters` in `electroclean/app/eeg/filtering.py`) asks MNE for
(high-pass with `l_trans_bandwidth="auto"`, notch with widths of f/200 Hz and
1 Hz transitions, harmonics below Nyquist minus 1 Hz; FIR, zero phase, `firwin`
with a Hamming window, `filter_length="auto"`), porting
`mne.filter.create_filter`, `_firwin_design` and `scipy.signal.firwin`. Over
106 designs (sampling rates from 100 to 2048 Hz, high-pass frequencies from 0.1
to 10 Hz, 50 and 60 Hz notches with and without harmonics) the lengths equal
MNE's and the coefficients agree to 2 parts in 10^14. The filters are applied
as that code applies them: high-pass then notch, each continuous segment on its
own (segments end at gaps and discontinuities), MNE's `reflect_limited` padding
at the ends of each segment, gaps and trigger channels left unfiltered. The
convolutions use an FFT in double precision; far from the ends of a segment the
two filters are applied in one pass with their combined kernel, which is
mathematically the same as MNE's two passes, and near an end the two passes are
made one after the other with MNE's padding, so the edge transients are MNE's
too. Against the Python filtering of the test recordings (windows at the start
and end, around gaps, across a discontinuity, in segments shorter than the
filter) and of three real recordings, the filtered samples agree to 6 parts in
100 million of the largest value in the window, which is the single-precision
rounding of the result. `edgeZones` gives the zones the viewer hatches, as the
Python filter report gives them: half the filter lengths at both ends of the
recording and around every discontinuity and gap edge.

The amplitude check is a port of ElectroClean's (`check_amplitudes` in
`electroclean/app/eeg/amplitude.py`): the same ten windows of two seconds, the
same measure (the median over a type's channels of the 99.5th percentile of the
distance from the median), the same bounds, display scales and warnings. It
measures the display copy, so it depends on the filters: `openRecording` uses
`options.filters` when given (the Python loader uses the filters of the
settings it is given) and a high-pass at 1 Hz otherwise. With the same filters
the amplitudes agree with the Python check's to 1 part in 100,000.

### Memory and speed

The reading runs in a module Web Worker (`new Worker(new URL("./worker.js",
import.meta.url), {type: "module"})`); when the browser refuses one, or it does
not answer within four seconds, the same engine runs on the page and pauses
every 25 ms of work so the page can draw. Inside the worker, up to four helper
workers share the filtering of a window's channels (two channels per complex
FFT), and if they cannot be started the worker filters alone. Stored bytes are
kept in blocks of about 32,768 samples per channel (at most 16 MB each) in a
cache of 256 MB, and filtered pieces in a cache of 192 MB; both forget the
least recently used first, so a 1 GB recording is never in memory at once. A
filtered piece is longer than the window (22,630 samples at 1024 Hz with
ElectroClean's default filters, the length that fills a power-of-two FFT),
extends in the direction the annotator scrolls, and the next window is filtered
in the background while the annotator looks at the current one; the background
work waits whenever the annotator asks for a window, unless that window needs
it.

On a 128-channel recording of 30 minutes at 1024 Hz with a Status channel (a
713 MB BDF file), measured in Chromium and in Node.js 22 on the shared
four-core virtual machine of the development environment, where OpenSSL's
SHA-256 runs at about 400 MB/s and the browser's own at 140 to 270 MB/s (a
current laptop is two to three times faster):

| Step | Time |
| --- | --- |
| Open: header, scan of the Status channel for its 900 trigger codes, amplitude check | 3.6 to 5.1 s (up to 9 s while the fingerprint is computed alongside) |
| SHA-256, streamed by the JavaScript implementation | 65 to 145 MB/s (5 to 11 s) |
| A 10 s window of all 128 channels, unfiltered | 15 to 190 ms |
| The same, high-pass 1 Hz and notch 50 Hz, nothing cached (worker with helpers) | 290 to 350 ms |
| The same on the page, without workers | 460 to 600 ms |
| The next 10 s, filtered ahead while the previous window was shown | 16 to 30 ms |
| A 10 s window of 32 channels, filtered, nothing cached (worker) | 150 to 200 ms |

The test recordings and three real ones (a 58-channel Emotiv EDF+ file of
17 MB, a 128-channel BrainVision file of 51 MB and a 137-channel BDF file of
771 MB with 1112 trigger codes) give the same channels, markers, gaps,
triggers, samples, filtered samples and fingerprints as ElectroClean's Python
code and MNE-Python.

### Tests

`node --test "web_tests/unit/*.test.mjs"` runs the unit tests (Node.js 22, no
packages to install; the quotes let Node expand the pattern itself). The
`data_*.test.mjs` files compare the readers, the filters, the amplitude check
and the fingerprints with MNE-Python and `hashlib` on recordings written by
`python scripts/make_web_fixtures.py` into `web_tests/fixtures/` (not
committed); the tests run the script themselves when the recordings are
missing or out of date, with the repository's `.venv` (or the interpreter
named by `ELECTROCLEAN_PYTHON`) and its development dependencies (mne, numpy,
scipy, pybv). `python scripts/make_web_fixtures.py --perf` also writes the
713 MB recording above, and `data_perf.test.mjs` then reports the times (set
`ELECTROCLEAN_PERF=1` to have the tests write it).

`node web_tests/run_e2e.mjs` runs the application in Chromium with Playwright:
the demonstration, a stand-in server, and the real demonstration server
(`electroclean-web demo`, started by the runner when the Python of
`ELECTROCLEAN_PYTHON` or the repository's `.venv` has the packages of
requirements-web.txt), with recordings opened from disk and the results checked
in the study folder. `scripts/test_web_firebase.sh` does the same for a study on
Firebase, on the Firebase Emulator Suite. The workflow **Browser version tests**
runs all three on GitHub.

## The Backend interface (browser)

`js/api/http.js` talks to the server (docs/web/api.md). `js/api/demo.js`
implements the same methods entirely in the browser, for the demonstration
without a server: built-in example recordings, demo accounts, results kept in
the browser and downloadable, and the same training rules. Every method
returns a Promise of the JSON described in docs/web/api.md.

Two methods carry the administrator's and the quiz's operations, so that every
backend implements them the same way: `admin(op, body)` (`POST /admin/{op}`,
or `ec_admin` with `{op, ...body}` on Firebase) and `quiz(setId, body)`
(`POST /quiz/{set_id}`, or `ec_quiz`). The demonstration implements the admin
operations it can run in the browser (accounts, assignments, recordings,
settings, reference sets from saved annotations or files, the audit log) and
answers the analyses (agreement, activity, competency, consensus) with an
error that says they need a study server or Firebase.

The short-segment quiz (`js/training/quiz.js`, the route `#quiz`) uses
`quiz(setId, body)` only: `get` once, then `answer` for each segment and
`finish`. On Firebase only `get` is asked a second time when a call fails,
since an answer or a finish must never be sent twice. Each answer carries the
`response_time_s` the browser measured. The study keeps an answer sent twice
once; when it refuses an answer with 409 (`already_answered`, with the label it
kept, after a reply that was lost or an answer from another page, or
`finished`), the view reloads with `get`, says which answer was kept, and
carries on, as it also does when an answer's `n_answered` shows answers given
elsewhere. A finished quiz is shown with the `score` that `get` returns. Each
segment is the item's interval with `context_s` around it, within the
recording, shown read only in the usual viewer from the annotator's own copy of
the recording with the item's interval shaded, after the copy has been checked
against the fingerprint in the `recordings` manifests of `get`. The view logs
the quiz events of docs/activity_logs.md (`quiz_item_shown`, `quiz_answer` with
`response_time_s`, `quiz_finished`, each with `quiz_mode` "practice" when the
feedback is immediate and "assessment" when it comes at the end) and also
`quiz_opened`, `quiz_recording_checked`, `quiz_stopped` (Stop for now) and
`quiz_ended_early` (End the quiz now, which then finishes the quiz). When the
feedback comes at the end, `quiz_answer` has `correct` null, as the browser
does not know it, and `quiz_finished` has the counts; a refused answer is
logged as `quiz_answer_refused` with the reason and the answer kept. The
demonstration has a quiz of seven segments from its first two examples, in an
order of its own for each account (a study orders the items with `item_order`
in `electroclean/training/quiz.py`, which uses Python's random generator), and
answers with the study server's fields and errors (`electroclean/web/quiz.py`).

The channel chooser (`chooseChannels` in `js/annotate/dialogs.js`, behind
Channels… and Edit channels…) follows the channel dialog of the desktop
application (version 1.1.0 and earlier). Its rules are exported and tested in
Node (`web_tests/unit/ui_channels.test.mjs`): `findChannels` (names or their
beginnings, also after a leading "EEG " in EDF names, the names containing a
term that begins none, quotes and wildcards), `tenTwentyPosition` and
`channelGroups` (Regions and Sides for montages named by the 10-20 or 10-10
system, Banks of numbered channels for others, in blocks of 32 for a bank
larger than that, and Types), which give the same groups as that dialog gave
for banks of up to 32 channels. Up to 16 channels the chooser is the plain list
it always was.

## Registering recordings in the browser

The admin area adds recordings without uploading them: `js/data/register.js`
builds, in the browser, the same internal manifest that
`electroclean.web.manifest.build_manifest` builds from MNE-Python's reading of
the files, and only the manifests go to the study (`recordings_register`).

```js
findDatasetRecordings(files: File[], { settings })
    -> { recordings: [{ recordingId, format, fileName, files: File[], sizeBytes, root, sidecars }],
         ignored: [{ path, reason }] }
buildManifest(recording, { settings, scope, onProgress, catalogue, worker, version })
    -> Promise<{ manifest, problems: [string] }>
buildManifests(files, { settings, scope, onProgress, catalogue, worker, version, signal })
    -> Promise<{ manifests, failures: [{ path, reason, kind }], ignored, problems: { recordingId: [string] } }>
// onProgress of buildManifest: ({ stage, fraction }); of buildManifests: ({ index, total, recordingId,
// stage, fraction, overall }), with stage "start" and "done" around each recording
```

`files` come from a folder picker (each with its `webkitRelativePath`) or are
chosen one by one. The folder chosen is the dataset root, and recording IDs are
the paths below it, as ElectroClean's discovery makes them
(`electroclean/app/io/discovery.py`): a file is a recording when its name ends
in one of the discovery suffixes (in any case), outside hidden folders, the
folders the settings exclude (`derivatives`, `Annotated_Events` and so on) and
the results folder. Files picked one by one are all in the root, so their IDs
are their names. `ignored` lists the files with a recording's extension that
were left out, with the reason in plain words. Each recording's `files` holds
what it needs (the data file, the usual BrainVision companions and its
sidecars), so that the admin area can show its size; `buildManifest` reads the
companions the header names from all the picked files. `buildManifests`
registers the recordings one after another and reports a recording that cannot
be registered in `failures`, with the Python loader's message, without
stopping; `signal` (an `AbortSignal`) stops it between recordings. `problems`
are each manifest's warnings, the findings the administrator should look at
before assigning the recording.

`settings` is the study's settings, the answer of `settings_get` or its
`settings` blocks, merged over the defaults of `default_settings.json`
(`DEFAULT_SETTINGS`, which a test compares with that file): `channels.hide`,
`channels.types`, `filters`, `loading` (BIDS channel types and bad channels)
and, when given, `discovery`. `catalogue` is the study's label catalogue (from
`GET /me`), used to note original events named like artifacts; the default is
ElectroClean's own. `version` fills `electroclean_version` (the study's version
from `GET /health`, say), which is otherwise `browser`; `created_at` is the
moment of registration on the administrator's clock, in the format of
ElectroClean's Python code (local time with its UTC offset, to the
millisecond).

Everything else is computed as `register_recording` computes it, with the
Python loader's wording for every message. The companions a BrainVision header
names must be among the picked files. The BIDS sidecars come from the dataset
root down to the recording's folder with the inheritance principle
(`js/data/bids.js`, a port of `electroclean/app/io/bids.py`), TSV files are
read exactly as strings, and JSON sidecars are read as Python reads them
(`js/data/pyjson.js`): NaN and Infinity become null and are reported, and a
file that cannot be read is reported with Python's own error message. The
original events (`js/data/events.js`) come from `events.tsv` when there is one
(compared with the file's markers), otherwise from the EDF+ and BDF+
annotations or the BrainVision markers with the codes MNE gives them, otherwise
from the trigger channels, including channels that only channels.tsv or the
settings call triggers. The annotations are held as MNE holds them once it has
set them on the recording: sorted by onset and duration, clipped to the
recording and timed to the microsecond. The channel types are the file's as MNE
reads it, then channels.tsv's, then the settings' patterns; channels shown,
hidden and marked bad, the notes, the gaps, the discontinuities, the filters
skipped and the amplitude check (on the display copy with the study's filters,
through `Recording.checkAmplitude` with the manifest's types) follow. The
warnings MNE gives while reading, which the Python loader keeps as "MNE: ...",
are worked out from the headers (`js/data/mnewarn.js`): duplicate channel
names, empty ranges, differing or contradictory filter settings, unreadable
patient fields and dates, a record length of 0, unrecognised BrainVision header
lines (twice, as MNE reads the line twice), missing `DataPoints`, channels at
the origin of the coordinates, the amplifier's filter table and the montage,
and annotations clipped at the end. `js/data/pyfmt.js` writes numbers and text
as Python does (`repr` of floats, formats rounded half to even, `repr` of
strings and lists).

The data file's fingerprint is computed in the reading worker while the file is
streamed, and the other files (header, markers, sidecars) are small enough to
hash on the page; the amplitude check and any trigger channel the file does not
mark are read in the worker too, so registering many recordings keeps the page
responsive. A recording is closed, and its worker ended, before the next one
starts. On the development machine, reading on the page without a worker,
registering the ten Emotiv recordings described below took 3 s and the 771 MB
BDF file 12 s.

### How the browser's manifests compare with Python's

`web_tests/unit/data_register.test.mjs` registers the datasets that
`scripts/make_web_fixtures.py` writes into `web_tests/fixtures/datasets/` (BIDS
BrainVision recordings with inherited sidecars, EDF+, EDF and BDF files of many
kinds, a BrainVision header written by hand and a collection of odd and broken
metadata) with default and with a study's own settings, and compares every
field with the manifests that `web_tests/register_parity.py` builds as
`electroclean-web register` does, with ElectroClean's Python loader
(`load_recording` in `electroclean/app/eeg/loading.py`). The amplitudes may
differ by 1 part in 100,000, as elsewhere in the data layer, because the
display copy is filtered in single precision; everything else must be equal.
`web_tests/unit/data_register_py.test.mjs` checks the imitations of Python
against Python on a few hundred values. Ten Emotiv EDF+ recordings of a BIDS
dataset (14 channels shown, 44 or 46 hidden, events in events.tsv, padding
marked BAD_ACQ_SKIP, four with amplitudes stored in the wrong unit), three
128-channel BrainVision recordings with channels.tsv and bad channels, and a
137-channel BioSemi BDF file of 771 MB with 1112 trigger codes gave manifests
equal to Python's in every field, with amplitudes within 3 parts in
100 million.

The same test passes every manifest built from the datasets through the study
server's own checks (`electroclean/web/manifest_check.py`, which
`recordings_register` runs before storing a manifest, called through
`register_parity.py --check`) and requires each to be accepted and kept
unchanged; in a tree without the server's checks the test says so and is
skipped. One of the fixtures has an events.tsv row past the end of its
recording on purpose: the loader keeps it with a warning and the server accepts
it too. The fourteen manifests of the recordings above pass the checks
unchanged.

A few things differ by nature. A browser knows a file's modification time to
the millisecond, so `mtime_ns` is a whole number of milliseconds. Python names
some folders and files in full in its messages (an ambiguous sidecar's folder,
a TSV file that cannot be read); the browser names them from the folder the
administrator chose, which is all it knows of where they are. When a file
repeats several channel names, MNE lists them in an order that changes from
run to run, and the browser lists them sorted. Companion files named with
other capitals than the header gives are found as Windows and macOS find them.

Some cases are rare enough that the browser reads them a little differently,
and none of them appeared in the files above. A study whose filters use the IIR
method has its amplitude check filtered with the FIR filters the browser has,
so the amplitudes can differ slightly from Python's. A channel stored with
fewer samples per data record than the others is interpolated linearly for the
amplitude check (MNE resamples it). Event codes and samples written with
decimal digits other than 0 to 9 are read by Python and not by the browser, and
whole numbers above 2^53 in a JSON sidecar are rounded. Headers that MNE
refuses to read for reasons of its own (a patient field with two equals signs
in one entry, an option repeated in a BrainVision header) are read by the
browser, and warnings that Python's own libraries give while reading are not
reproduced.

## Interaction logs

The browser records the events that docs/activity_logs.md describes
(`mouse_press`, `key`, `shortcut`, `view`, `annotation_created`, `pointer`,
`idle_start`, the training events ...) with `t` measured from the start of the
visit, and sends them in batches. The server writes them as JSON Lines files in
`interaction_logs/`, which `electroclean-activity` and the admin area's
activity analysis summarise. Logs written by the desktop application (version
1.1.0 and earlier) have the same format, so the analysis reads them together
with the browser's. Typed text and passwords are never recorded.
