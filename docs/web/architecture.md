# ElectroClean in the browser: architecture

The browser version keeps every EEG recording on the annotator's own computer.
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
fingerprint of the data file (SHA-256, the same checksum the desktop
application records for its `eeg` source file), filters for display, draws
the EEG, and provides all the annotation and training tools of the desktop
application (number keys and type buttons, the type picker, M / [ / ] marks,
N / P, C, Draw as / Change to, undo and redo, merging of overlapping
annotations of one type, the training coach). It keeps a draft of unsaved work
in the browser and on the server, and sends interaction events to the server.

**The server** (Python, `electroclean/web/`) holds:

* the study: settings, the label catalogue, accounts and assignments;
* the register of recordings: for each one a *manifest* made by the study
  administrator from the real files (fingerprints, timing, channels shown and
  hidden, channel types, original events, gaps, display scalings), so the
  server never needs the EEG itself;
* the results, written with ElectroClean's own code into the same folder
  layout as the desktop application (`Annotated_Events/...`,
  `interaction_logs/...`), so the agreement analysis and the activity
  analysis work unchanged;
* the training reference annotations, which never leave the server: it checks
  each guided attempt and scores each practice recording and only returns the
  feedback.

## Folder layout

```
electroclean/web/                 the server (FastAPI) and its CLI, electroclean-web
electroclean/web/static/          the browser application (plain ES modules, no build step)
    index.html, app.css
    js/main.js                    start-up and the views (sign in, assignments, open, annotate, training)
    js/api/                       the Backend interface: http.js (the real server), demo.js (in the browser)
    js/data/                      reading recordings: recording.js, edf.js, brainvision.js, sha256.js,
                                  fft.js, filters.js, worker.js, synthetic.js
    js/viewer/                    drawing the EEG, axes, overview, navigation
    js/annotate/                  the annotation store, tools, toolbar, panels, picker, keys
    js/training/                  the coach and practice review
    js/log/                       the interaction logger
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

## The Backend interface (browser)

`js/api/http.js` talks to the server (docs/web/api.md). `js/api/demo.js`
implements the same methods entirely in the browser, for the demonstration
without a server: built-in example recordings, demo accounts, results kept in
the browser and downloadable, and the same training rules. Every method
returns a Promise of the JSON described in docs/web/api.md.

## Interaction logs

The browser records the same kinds of events as the desktop application
(docs/activity_logs.md: `mouse_press`, `key`, `shortcut`, `view`,
`annotation_created`, `pointer`, `idle_start`, the training events ...) with
`t` measured from the start of the visit, and sends them in batches. The
server writes them as the same JSON Lines files, so `electroclean-activity`
summarises browser and desktop visits alike. Typed text and passwords are
never recorded.
