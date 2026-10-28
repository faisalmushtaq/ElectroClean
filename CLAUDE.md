# Working on ElectroClean

This file is for AI coding assistants working in this repository (Claude Code reads it
automatically; [AGENTS.md](AGENTS.md) points other assistants here). Read
[HANDOVER.md](HANDOVER.md) first: it says where the project stands, which branch holds what, and
what is still open. The [developer guide](docs/developer_guide.md) describes the architecture.

## The project in two sentences

ElectroClean is research software for annotating artifacts in continuous EEG, measuring agreement
between annotators, and training and assessing them, with an interaction log of how they work. The
desktop application (Python, PySide6, MNE-Python's Qt browser) lives on `main`; the browser version
(static ES modules, a FastAPI server and Firebase Cloud Functions sharing one Python service layer)
lives on `claude/electroclean-web` until the project lead agrees to merge it.

## Commands

```bash
python -m pip install -r requirements-dev.txt && python -m pip install --no-deps -e .   # Python 3.12 or 3.13
python -m pytest                          # everything; GUI tests run off screen
python -m pytest -m "not gui"             # without Qt
python -m pytest tests/test_tagging.py -q # one file
ruff check --select E,F,W,B electroclean tests scripts   # the useful lint subset
```

On the browser branch, also:

```bash
node --test web_tests/unit/*.test.mjs                     # browser modules (Node.js 22; give a glob, not a folder)
ELECTROCLEAN_PYTHON=python node web_tests/run_e2e.mjs     # the application in Chromium (Playwright), incl. the real server
bash scripts/test_firebase_emulators.sh                   # functions and Firestore store on the emulators (Java 21)
bash scripts/test_web_firebase.sh                         # the application on Firebase emulators
electroclean-web demo                                     # the whole browser system on http://localhost:8000/
```

`run_e2e.mjs` and the unit tests find Python through `ELECTROCLEAN_PYTHON`, then the repository's
`.venv`, then `python3`. The emulators use the project ID `demo-electroclean`, which never reaches a
real Firebase project.

## Rules that protect the research data

Source EEG files are read-only: no code path may open one for writing. A recording is marked
complete only after its five output files are written, read back and verified (the journalled save
in `electroclean/app/session/`). The annotation store is the single source of truth; interfaces
display it and send every action to it. Never commit participant data or real recordings: tests
use the synthetic recordings of `electroclean/synthetic.py` and `scripts/make_web_fixtures.py`
(written to `web_tests/fixtures/`, which is ignored). The interaction logs never record typed text
or passwords; keep it that way.

## Conventions

Every change comes with tests, and the documentation that describes the changed behaviour (README,
the guides in `docs/`, `docs/web/` on the browser branch) is updated in the same commit, with a
paragraph in the *Unreleased* section of `CHANGELOG.md` for anything a user would notice. Python
uses type hints and `from __future__ import annotations`. Qt is imported only by the windows
(`electroclean/app/gui/`, `reliability/gui.py`, `training/gui.py`, `training/guided_gui.py`) and by
the entry points `app/main.py` and `app/selftest.py`; everything else must work without it, so that
annotations can be processed in plain Python and the browser version's server can reuse the code. Errors that can reach a person are written for annotators, in
plain words.

Desktop windows take their look from `electroclean/app/gui/style.py` (call `style.apply_theme()`,
mark the one forward action with `style.set_kind(button, "primary")`, give labels a role rather
than a colour); `tests/test_style.py` checks contrast.

The browser application has no build step: plain ES modules under `electroclean/web/static`, with
every path relative so that it works under `/preview/` on GitHub Pages (workers are created with
`new URL("./worker.js", import.meta.url)`). External scripts come only from fixed, versioned URLs
(the Firebase SDK from gstatic.com, loaded only for Firebase studies).

The contract between browser and server is [docs/web/api.md](docs/web/api.md). A change to a
request or response must be made in `electroclean/web/service.py` (or `coach.py`, `visits.py`),
the route in `electroclean/web/app.py`, the Firebase table in `api.md`, and in `js/api/http.js`,
`js/api/firebase.js` and the in-browser demonstration `js/api/demo.js`; then run the end-to-end
tests against the real server and the emulators, which are what catch mismatches. Firebase
functions can answer slowly after a quiet period, so browser code must stay correct when an answer
arrives late or a person presses a key again while waiting.

## Writing style for text in the repository

Interface text and documentation are in UK English (colour, licence, organise, programme), with
the HED spelling *artifact* kept in label names. Documentation is written in prose paragraphs in
the voice of the existing guides, rather than as lists of bullet points; tables and code blocks are
fine where the content is genuinely tabular or a command. Avoid em dashes, and state points
positively rather than through "it is not X, it is Y" contrasts. Before citing any paper,
standard or web page, check it against the original source online, and add it to
`docs/references.md` only once checked.

## Platform quirks that have caused failures before

The GUI tests create real Qt windows with `QT_QPA_PLATFORM=offscreen` on Windows, macOS and Linux.
Windows' off-screen fonts are about twice as wide, so layouts must adapt by rule and tests should
check the rule (for example "full labels exactly when they fit") rather than pixel positions. macOS
ignores `QMessageBox` titles, so dialogs carry an `ec_title` property that the interaction log
reads. Event filters installed on a widget's own children crashed PySide at exit; use signals or
small hooks instead, and note that `tests/conftest.py` deletes parentless top-level windows at the
end of the session. On Linux without a display, Qt needs the libraries listed as
`LINUX_QT_PACKAGES` in `.github/workflows/build-apps.yml`.

## Branches, CI and releases

Work for the desktop application branches from `main`; work for the browser version branches from
`claude/electroclean-web`. Do not merge the browser version into `main`, push to `main`, or publish a
release unless the person you are working for asks for it. Pushes to `main` run the tests on all
three systems and build the applications (*Build applications*); other branches run the tests on
Linux only, and a run started by hand on any branch runs everything. The browser branch also runs
*Browser version tests* and publishes its preview to `gh-pages` under `preview/` (never edit
`gh-pages` by hand). Releases are made from `main` as described in
[docs/building_apps.md](docs/building_apps.md): set `__version__`, give the version its own section
in `CHANGELOG.md`, then run *Build applications* by hand with *Publish a release* ticked or push a
`v` tag. Some cloud environments refuse tag pushes; the run by hand needs no tag.
