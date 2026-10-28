# Handover notes

These notes are for whoever takes ElectroClean on next, and for the AI assistant they work with.
They say where the project stands on 28 October 2026, what is still open, and how to carry on
without having to rediscover anything. The same file sits at the top of the repository on each
working branch. Instructions written for AI coding assistants are in
[CLAUDE.md](CLAUDE.md); read both before changing anything.

## What ElectroClean is

ElectroClean is research software for the manual annotation of artifacts in continuous EEG,
written for a PhD project on EEG artifact identification and automated EEG cleaning. Annotators
mark artifact intervals with the 29 HED-SCORE artifact terms, on the whole montage or on chosen
channels; the results are saved as validated, BIDS-compatible files; an agreement analysis
compares annotators by category, time and channel; a training programme takes new annotators from
guided practice to a competency assessment; and an interaction log records how each annotator
works, as research data in its own right. The [README](README.md) is the best short introduction,
and the [design decisions](docs/design_decisions.md) record why things are as they are.

There are two ways to use it. The **desktop application** (Python, PySide6 and MNE-Python's Qt
browser) is released. The **browser version** reads the recordings on the annotator's own
computer, so the EEG is never uploaded, and keeps the study's records on Firebase or on a small
ElectroClean server. It is finished and tested on its own branch and waits for a decision on
merging (see below).

## Where things stand

**The desktop application.** Version 1.1.0 was released on 27 October 2026, with stand-alone
applications for Windows, macOS (Apple silicon) and Linux on the
[Releases page](https://github.com/faisalmushtaq/ElectroClean/releases). Since then `main` has
gained a visual redesign, much quicker tagging by keyboard and mouse, improvements prompted by a
test with 128-channel recordings, the guided training programme and the interaction logs. All of
this is described in the *Unreleased* section of [CHANGELOG.md](CHANGELOG.md), passes the test-suite
on Windows, macOS and Linux, and has not yet been released as 1.2.0.

**The browser version** is on the branch `claude/electroclean-web`, which holds everything on `main`
plus the browser version's own commits, so it merges without conflicts. Its preview is live at
<https://faisalmushtaq.github.io/ElectroClean/preview/> as a demonstration that needs no server: sign
in as A01 to annotate or T01 for the training programme, with the password `demo`. The home page
offers the example recordings as EDF files to open "from your computer", which is what annotators do
with real recordings. Every part has been tested end to end: the browser modules, the application
in Chromium against the demonstration, against the real ElectroClean server and against Firebase on
Google's local emulators, including opening files from disk, saving, drafts restored in another
browser, guided training, practice scoring and the administrator's export.

There are no open pull requests or issues on GitHub.

## Branches

| Branch | What it holds | What to do with it |
| --- | --- | --- |
| `main` | The desktop application, as released plus the unreleased work above | Work from here for anything desktop-only. Pushes run the tests on all three systems and build the applications. |
| `claude/electroclean-web` | `main` plus the browser version, its server, the Firebase functions and their tests | Work from here for the browser version until it is merged. Pushes run the browser tests, and republish the preview when the application's files change. |
| `claude/eager-bardeen-33qhkb` | The branch the previous AI sessions worked on; identical to `main` | Nothing; it can be deleted. |
| `gh-pages` | The published web pages, written by `.github/workflows/pages.yml` | Never edit it by hand. GitHub Pages serves it (Settings, Pages: deploy from branch `gh-pages`, folder `/ (root)`). |

**Merging the browser version.** When the project lead is happy with the preview, merge
`claude/electroclean-web` into `main` (a fast-forward is possible while `main` has not moved, or
open a pull request to see the diff). That publishes the browser application at the site's root,
<https://faisalmushtaq.github.io/ElectroClean/>, adds the web and Firebase packages to
`requirements-dev.txt` (so the three-system test runs install them) and adds two workflows. Before
merging, run *Build applications* by hand on the branch (Actions tab, Run workflow, branch
`claude/electroclean-web`): that runs the tests and builds on Windows, macOS and Linux, which pushes
to the branch do not. A first rehearsal on 28 October found that the stand-alone applications'
self-test tried to import the browser version's server, which needs packages the desktop
application does not include; the build now leaves `electroclean.web` out, and a test guards it.
Nothing about the browser version has been merged into `main` so far, at the project lead's
request.

## Setting up

ElectroClean needs Python 3.12 or 3.13 (64-bit). From a clone of the repository:

```bash
python -m venv .venv
source .venv/bin/activate              # Windows: .venv\Scripts\activate
python -m pip install -r requirements-dev.txt
python -m pip install --no-deps -e .
python -m pytest                       # the whole suite, a few minutes
electroclean                           # the desktop application
```

On a Linux machine without a display, the GUI tests need `QT_QPA_PLATFORM=offscreen` (the tests set
it) and Qt's system libraries (`libegl1 libgl1 libxkbcommon0 libfontconfig1 libdbus-1-3`; the full
list is `LINUX_QT_PACKAGES` in `.github/workflows/build-apps.yml`).

For the browser version, on its branch, the same Python environment serves (its `requirements-dev.txt`
already includes `requirements-web.txt`), and the browser tests also need Node.js 22 and Playwright
with Chromium (`npm install --no-save playwright@1.63.0` and `npx playwright install chromium`). The
Firebase tests need Java 21 for Google's emulators; `npx` fetches the Firebase tools itself.

## Running it

| To | Run |
| --- | --- |
| Start the desktop application | `electroclean` (or a launcher in `launchers/`) |
| Try it on simulated recordings | `python examples/launch_demo_gui.py` |
| Run the whole workflow without the GUI | `python examples/demo_end_to_end.py` |
| Compare annotators | `electroclean-agreement path/to/Annotated_Events` |
| Set up reference sets, criteria, the training programme | `electroclean-admin --help`, or *Tools, Administrator tools* in the application |
| Turn interaction logs into tables and learning curves | `electroclean-activity path/to/Annotated_Events` |
| Run the browser version with a real server on this computer (browser branch) | `electroclean-web demo`, then open <http://localhost:8000/> and sign in as A01, A02, T01 or ADMIN with the password `electroclean`; the files to open are in `electroclean-demo/recordings` and the results appear in `electroclean-demo/study/Annotated_Events` |
| See who has done what in a browser study (browser branch) | `electroclean-web progress --study-dir …` or `--firebase-project … --study …` |

## Tests and continuous integration

| Suite | Command | Where it runs on GitHub |
| --- | --- | --- |
| Python (desktop, agreement, training, activity; on the browser branch also the server, the Firebase store and the functions) | `python -m pytest` (about 370 tests on `main`, about 410 on the browser branch) | *Build applications*: all three systems for `main`, pull requests into `main`, tags and runs started by hand; Linux only for other branches |
| Browser modules | `node --test web_tests/unit/*.test.mjs` (about 120 tests; the data tests write their recordings with `scripts/make_web_fixtures.py`) | *Browser version tests* |
| The browser application in Chromium | `node web_tests/run_e2e.mjs` (17 tests; three of them start the real `electroclean-web demo`, when the Python named by `ELECTROCLEAN_PYTHON`, or the repository's `.venv`, has the server's packages) | *Browser version tests* |
| Firebase on the emulators | `bash scripts/test_firebase_emulators.sh` (the functions and the Firestore store) and `bash scripts/test_web_firebase.sh` (the application signing in, annotating, training and exporting) | *Browser version tests* |

The stand-alone applications are built by *Build applications* on every push to `main` and each
runs its own `--self-test`. The [testing guide](docs/testing_guide.md) lists the checks that need a
person on each type of computer before a study starts.

## Releasing the desktop applications

[docs/building_apps.md](docs/building_apps.md) has the details. In short: set `__version__` in
`electroclean/__init__.py` (the next one is `1.2.0`), turn the *Unreleased* heading of
`CHANGELOG.md` into `## 1.2.0` (that section becomes the release notes, and the workflow refuses a
version without one), push to `main`, wait for the tests to pass, then either run *Build
applications* by hand on `main` with *Publish a release* ticked, or push a tag `v1.2.0`. The release
job builds and self-tests all three applications and attaches them, with their checksums, to the
release. If the browser version is merged first, its paragraph is already in the *Unreleased*
section.

## The browser version in brief

The application is static files (`electroclean/web/static`, plain ES modules, no build step) served
by GitHub Pages. The browser reads EDF, EDF+, BDF and BrainVision files itself, computes the
SHA-256 fingerprint of the data file, filters for display in a Web Worker, and offers the desktop's
annotation tools, keys, training programme and interaction logging. A study's records live either
on **Firebase** (the chosen way to run real studies: Authentication for accounts, Firestore in
Google's London region, Python Cloud Functions in europe-west2 that match files to the register,
validate and save results with ElectroClean's own code, check guided steps and score practice, so
the experts' answers never reach a browser) or on **ElectroClean's own server** (`electroclean-web
serve`, FastAPI, used for the local demonstration and for studies that prefer their own machine).
Both run the same Python service layer (`electroclean/web/service.py`) over two storage back ends,
and both write results into the same `Annotated_Events` layout as the desktop application, so the
agreement and activity analyses work unchanged.

The documents to read are [docs/web/architecture.md](docs/web/architecture.md) (how it fits
together, the Recording and Backend interfaces in the browser), [docs/web/api.md](docs/web/api.md)
(the contract between browser and server, and the Firebase functions), [docs/web/firebase.md](docs/web/firebase.md)
(setting up a real study, step by step), [docs/web/server.md](docs/web/server.md) (the
demonstration and the own-server option) and [docs/web/using.md](docs/web/using.md) (for
annotators).

**Starting a real study on Firebase** has not been done yet; nobody has created the Firebase
project. The guide takes an afternoon the first time: create the project, choose the pay-as-you-go
Blaze plan with a budget alert, create Firestore in europe-west2, turn on email and password
sign-in, register the web app, deploy the rules and functions, then create the study, register the
recordings, add accounts and assignments, publish `config.json` and send annotators the link.
`electroclean-web export` writes the results into ElectroClean's usual folders. The *Firebase
deploy* workflow can deploy updates once the secret `FIREBASE_SERVICE_ACCOUNT` and the variable
`FIREBASE_PROJECT` are set in the repository; neither is set yet.

## What is open

**1. The real training material.** The training programme currently uses a placeholder: three
simulated recordings whose "expert" annotations are the simulation's ground truth. The project lead
is obtaining two or three properly annotated recordings. The [administrator guide](docs/administrator_guide.md)
("Real expert files") describes how to build a reference set from them: each expert annotates in
the desktop application in standard mode, and `electroclean-admin import-recording` copies each
recording and the expert's `_annotations.json` into a self-contained set, with its use (guided,
practice or assessment). For a browser study, `electroclean-web register` on the dataset then stores
the set's expert annotations with the study (the recordings themselves are given to trainees like
any other recording). Once the real set works, remove the example set.

**2. Merging the browser version**, as described under *Branches*.

**3. Releasing 1.2.0**, as described above.

**4. Decisions for the research team**, listed under "Decisions still open" in
[docs/design_decisions.md](docs/design_decisions.md): the agreement settings to pre-register, the
competency criteria, scheduling repeat annotations for test-retest reliability, whether idle time
counts, the copyright holder named in the licence notice, code signing of the applications (and
whether an Intel Mac build is needed), and whether Emotiv's contact-quality channels should be
shown.

**5. Data protection for real studies.** The interaction logs are participant data about the
annotators, and a Firebase study keeps the study's records with Google in London. The
"Data protection in brief" sections of [docs/web/firebase.md](docs/web/firebase.md) and
[docs/web/server.md](docs/web/server.md) describe exactly what is stored; check the arrangements
with the university's research data and ethics processes before the first real study.

**6. The browser version's loose ends.** These are known, and none of them blocks a pilot. It has
been tested in Chromium (Chrome and Edge) only, so Firefox and Safari need a run-through. On the test
machine, the first 10-second screen of a 128-channel recording with filters took about 0.3 s to
appear, and the following screen, prepared in advance, about 0.02 s; check this on the computers
annotators will use. There is no administrator screen in the browser, so `electroclean-web progress`
and `export` cover that from the command line. Three small differences from the desktop
application are documented in [docs/web/architecture.md](docs/web/architecture.md): an EDF channel
stored at a lower sampling rate than the others is interpolated linearly for display, where MNE
resamples it, so the two agree to a few per cent and the recording warns; a BDF+ file whose only
annotation is the `BAD_ACQ_SKIP` padding shows its trigger events in the browser and none on the
desktop; and the browser's amplitude check uses a 1 Hz high-pass unless it is given the session's
filters.

**7. Housekeeping.** The project's `ruff` settings give only the line length, so a recent `ruff`
applies many style rules the code was never written to; `ruff check --select E,F,W,B` is the useful
subset (a few long lines remain). A shared linting configuration and a lint step in CI would help.

## Things worth knowing before changing code

**The annotation store is the single source of truth** in both the desktop and the browser
application; the interface displays it and sends every action to it. **Source EEG files are never
written to**, and a recording is marked complete only after its five output files have been
written, read back and verified (the journalled save in `electroclean/app/session/`). Keep both
properties whatever else changes.

**The browser, the server and the Firebase functions share one contract**, [docs/web/api.md](docs/web/api.md).
A change to a request or response touches `electroclean/web/service.py` (and `coach.py` or
`visits.py`), `electroclean/web/app.py` for the HTTP route, the table of Firebase calls in the same
document, `js/api/http.js`, `js/api/firebase.js` and the in-browser demonstration in
`js/api/demo.js`. The end-to-end tests against the real server and the emulators are what catch a
mismatch; two were found that way.

**Slow answers are normal on Firebase.** Functions can take a few seconds to start after a quiet
period, and an instance can occasionally stop mid-request, so the browser must stay correct when
an answer arrives late or not at all. The guided coach takes one action at a time for this reason,
and calls that only read are asked a second time after a failure, while calls that save, score or
count an attempt never are (`js/api/firebase.js`). Test with the emulators, which behave more like
Firebase than the local server does.

**The desktop GUI tests run real Qt windows off screen** on all three systems, and each system has
its quirks: Windows' off-screen fonts are much wider (toolbars must fit by rule, and tests should
check rules rather than pixel layouts), macOS ignores message-box titles (the interaction log reads
the `ec_title` property instead), and event filters installed on a widget's own children crashed
PySide at exit (signals and small hooks replace them; `tests/conftest.py` deletes parentless
windows at the end of the session).

**Writing.** The interface text and the documentation are in UK English, with the HED spelling
*artifact* kept in label names. The documentation is written as prose, in the voice of the existing
guides. Any literature cited must be checked against the original source before it is added to
[docs/references.md](docs/references.md).

## Documentation map

| Document | For |
| --- | --- |
| [README.md](README.md) | What ElectroClean is, installation, the outputs |
| [docs/user_guide.md](docs/user_guide.md) | Annotators using the desktop application |
| [docs/administrator_guide.md](docs/administrator_guide.md) | Study set-up, reference sets, competency criteria, the training programme |
| [docs/reliability_guide.md](docs/reliability_guide.md) | The agreement measures and how to read them |
| [docs/activity_logs.md](docs/activity_logs.md) | What the interaction logs record, and the activity analysis |
| [docs/file_formats.md](docs/file_formats.md) | Every output and configuration file |
| [docs/developer_guide.md](docs/developer_guide.md) | Architecture, MNE integration, conventions |
| [docs/testing_guide.md](docs/testing_guide.md) | Tests, synthetic data, checks that need a person |
| [docs/building_apps.md](docs/building_apps.md) | Stand-alone applications and releases |
| [docs/design_decisions.md](docs/design_decisions.md) | How the specification was interpreted; open decisions |
| [docs/hed_score_validation.md](docs/hed_score_validation.md) | The 29 artifact terms against HED SCORE 2.2.0 |
| [docs/references.md](docs/references.md) | Literature cited |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release, and what is unreleased |
| `docs/web/` (browser branch) | The browser version, as listed above |

## Access and accounts

The repository is public, under the PolyForm Noncommercial licence. Nothing secret is stored in it:
the demonstration passwords above are for simulated data only, the Firebase web configuration that
`config.json` will hold is public by design, and the Firebase service-account key, when one is made,
belongs in the repository's Actions secrets. Changing GitHub Pages, secrets or branch settings needs
admin rights on the repository, which the repository owner holds.
