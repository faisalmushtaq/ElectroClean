# Working on ElectroTag

This file is for AI coding assistants working in this repository (Claude Code reads it
automatically; [AGENTS.md](AGENTS.md) points other assistants here). Read
[HANDOVER.md](HANDOVER.md) first: it says where the project stands, which branch holds what, and
what is still open. [docs/web/architecture.md](docs/web/architecture.md) describes how the system
fits together and [docs/developer_guide.md](docs/developer_guide.md) the Python core.

## The project in two sentences

ElectroTag is research software for annotating artifacts in continuous EEG, measuring agreement
between annotators, and training and assessing them, with an interaction log of how they work. It
runs in the web browser: the application (`electrotag/web/static`, plain ES modules) reads each
recording on the person's own computer, and a study's records live on Firebase or on the
ElectroTag server, both running one Python service layer (`electrotag/web/service.py`) on top of
the Python core (annotations, loading, saving, training, agreement and activity analyses).

The desktop application was retired on 28 October 2026; version 1.1.0 on the Releases page was its
last release. Do not bring back Qt or a desktop window.

## Commands

```bash
pip install -r requirements-dev.txt && pip install --no-deps -e .   # in an active virtual environment, Python 3.12 or 3.13
python -m pytest                                          # the Python suite
python -m pytest tests/test_web_server.py -q              # one file
ruff check --select E,F,W,B electrotag tests scripts    # the useful lint subset
node --test web_tests/unit/*.test.mjs                     # browser modules (Node.js 22; give a glob, not a folder)
ELECTROTAG_PYTHON=python node web_tests/run_e2e.mjs     # the application in Chromium (Playwright), incl. the real server
ELECTROTAG_PYTHON=python node web_tests/run_e2e.mjs --browser webkit   # the same in WebKit (Safari, iPads)
bash scripts/test_firebase_emulators.sh                   # functions and Firestore store on the emulators (Java 21)
bash scripts/test_web_firebase.sh                         # the application on the Firebase emulators
electrotag web demo                                     # the whole system on http://localhost:8000/
```

`run_e2e.mjs` and the unit tests find Python through `ELECTROTAG_PYTHON`, then the repository's
`.venv`, then `python3`. The emulators use the project ID `demo-electrotag`, which never reaches a
real Firebase project. `requirements.txt` holds everything the server and the commands need;
`requirements-dev.txt` adds the test tools and the Cloud Functions' SDK; the functions themselves
install `electrotag/web/firebase/functions/requirements.txt`.

## Rules that protect the research data

EEG recordings never leave the computer they are on: the browser reads them, and only manifests
(fingerprints, timing, channels, events), annotations and interaction logs go to the study. Source
files are read-only: no code path may write to one. A recording is marked complete only after its
five output files are written, read back and verified (the journalled save in
`electrotag/app/session/`). The annotation store is the single source of truth; interfaces display
it and send every action to it. Never commit participant data or real recordings: tests use the
synthetic recordings of `electrotag/synthetic.py` and `scripts/make_web_fixtures.py` (written to
`web_tests/fixtures/`, which is ignored). The interaction logs never record typed text or passwords.
Every change an administrator makes is written to the study's audit log; keep it that way for new
operations.

## Conventions

Every change comes with tests, and the documentation that describes the changed behaviour (README,
the guides in `docs/` and `docs/web/`) is updated in the same commit, with a paragraph in the
*Unreleased* section of `CHANGELOG.md` for anything a user would notice. Python uses type hints and
`from __future__ import annotations`. Errors that can reach a person are written for annotators and
researchers, in plain words.

The application's look is one design system, described at the top of `app.css` and in
`docs/design_decisions.md` ("Visual design of the browser application"): warm off-white pages,
hairlines, square panels and pill-shaped buttons, black for the step forward and one ink-blue
accent, flat (no shadows), one typeface (Newsreader, served from `static/fonts`) with tabular
figures, sizes from the `--t-*` scale of whole pixels, drawn icons from `icon()` in
`js/views/common.js` rather than arrow or tick characters, and nothing set in capitals. Use its
tokens rather than new colours or sizes, and run `web_tests/unit/ui_design.test.mjs`, which checks
contrast and these rules.

The browser application has no build step: plain ES modules under `electrotag/web/static`, with
every path relative so that it works under `/preview/` on GitHub Pages (workers are created with
`new URL("./worker.js", import.meta.url)`), and plain `#name` routes only. External scripts come
only from fixed, versioned URLs (the Firebase SDK from gstatic.com, loaded only for Firebase
studies).

The contract between browser and server is [docs/web/api.md](docs/web/api.md): the annotators'
operations, the administrator's operations (`admin(op, body)`: `POST /admin/{op}`, or the callable
`et_admin`) and the quiz (`quiz(setId, body)`). A change to a request or response is made in the
service layer (`electrotag/web/service.py` and the modules it calls), the HTTP route
(`electrotag/web/app.py`), the Firebase function (`electrotag/web/firebase/functions/main.py`),
the browser's `js/api/http.js`, `js/api/firebase.js` and the in-browser demonstration
`js/api/demo.js`, and the contract itself; then run the end-to-end tests against the real server and
the emulators, which are what catch mismatches, and the unit tests, whose
`api_contract_parity.test.mjs` sends the same calls to the demonstration and to the real service
(`web_tests/contract_parity.py`) and compares the answers. Firebase functions can answer slowly after a quiet
period or fail once, so browser code must stay correct when an answer arrives late or a person
presses a key again while waiting; only calls that read may be retried automatically, never calls
that save, score, register or count an attempt.

Registration in the browser (`js/eeg/register.js`) must build the same manifest as the Python
`electrotag.web.manifest.build_manifest` for the same files and settings; the parity tests compare
them field by field, so change both together.

## Writing style for text in the repository

Interface text and documentation are in UK English (colour, licence, organise, programme), with
the HED spelling *artifact* kept in label names. Documentation is written in prose paragraphs in
the voice of the existing guides, rather than as lists of bullet points; tables and code blocks are
fine where the content is genuinely tabular or a command. Avoid em dashes, and state points
positively rather than through "it is not X, it is Y" contrasts. Before citing any paper,
standard or web page, check it against the original source online, and add it to
`docs/references.md` only once checked.

iPads run Safari's engine, WebKit, which reports pointer positions in whole pixels, refuses some
ports and leaves out a lazily loaded frame until it is scrolled to; run the end-to-end tests with
`--browser webkit` after a change to the views. On a touch screen: hover styles go inside
`@media (hover: hover)` (they would stay on a tapped control), fields are 16 pixels under
`(pointer: coarse)` (Safari zooms into smaller ones), file inputs take `accept` from `acceptFiles()`
(iPadOS greys out unknown extensions such as .edf) and folder buttons hide where `CAN_CHOOSE_FOLDER`
is false. Two fingers, long presses and double taps on the EEG are in `js/viewer/touch.js`; after a
long press or a double tap the viewer cancels the touch's end, or the browser's click lands on the
menu that just opened.

## Branches, CI and publishing

`main` holds the application (the browser version was merged into it on 28 October 2026). Work on
a branch from `main`, and do not push to `main`, publish a release or deploy to a real Firebase
project unless the person you are working for asks for it. *Tests* runs the Python suite (Linux on
every push; Windows, macOS and Linux for `main`, pull requests and runs started by hand), *Browser
version tests* runs the browser modules, the application in Chromium and the Firebase emulator
tests, and *GitHub Pages* publishes the application to the `gh-pages` branch: from `main` at the
site's root, and from `claude/electroclean-web`, kept for previews, under `preview/` (never edit
`gh-pages` by hand). *Firebase deploy*, run by hand, deploys the functions and rules once the
repository's `FIREBASE_SERVICE_ACCOUNT` secret and `FIREBASE_PROJECT` variable are set
(docs/web/firebase.md).
