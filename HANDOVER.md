# Handover notes

These notes are for whoever takes ElectroClean on next, and for the AI assistant they work with.
They say where the project stands on 28 October 2026, what is still open, and how to carry on
without having to rediscover anything. Instructions written for AI coding assistants are in
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

ElectroClean runs in the web browser. Annotators open a link, sign in and open the recordings they
were given from their own computer: the page reads each file there, so the EEG never leaves that
computer, and the study holds only each recording's manifest (the SHA-256 fingerprint of its data
file, its timing, channels and events), the annotations and the interaction logs. Lead researchers
run the study from the admin area of the same application. A study's records live on **Firebase**
(the chosen way to run real studies) or on **ElectroClean's own server** (`electroclean-web serve`,
used for the local demonstration and for a study that prefers its own computer).

## Where things stand

On 28 October 2026 the project lead decided to retire the desktop application and to make the
browser version complete, with an admin area for the lead researchers. That work is finished and
tested on the branch `claude/electroclean-web`, and waits for the project lead's agreement to merge
it into `main`.

The browser version now does everything the desktop application did. Annotators annotate with the
same keys, toolbar and dialogs (including a channel chooser that works on 128-channel montages),
save with Save and Finish, keep a draft that follows them to another browser, follow the training
programme from guided learning to the competency assessment, and take the short-segment quiz,
which they can stop and resume or end early with the score of the segments answered. The admin area
covers what the desktop's administrator tools and `electroclean-admin` covered, and more: accounts
(with invitation links on Firebase), recordings added from the administrator's own computer (the
browser builds the same manifests as the command line), assignments, reference sets with their
four sources of reference (someone's saved annotations, a file, a consensus of several experts with
its disagreements listed, an adjudicated consensus), competency criteria, the quiz, the agreement
and activity analyses and competency reports, progress, every result as one zip file, the study's
settings, and an audit log of every change an administrator makes.

The desktop application has been removed from the branch, with its stand-alone applications, the
launchers, the self-test and Qt. The Python core stays: it loads recordings with MNE-Python, writes
and verifies the result files, and runs the agreement, training and activity analyses, and the
server and the Firebase functions call it. The commands `electroclean-agreement`,
`electroclean-admin` and `electroclean-activity` work as before on saved results, and
`electroclean-web` runs the server, registers recordings and exports a Firebase study. Version 1.1.0
on the [Releases page](https://github.com/faisalmushtaq/ElectroClean/releases) was the last desktop
release; the results folders it wrote are read unchanged.

**Trying it.** The preview is live at <https://faisalmushtaq.github.io/ElectroClean/preview/> as a
demonstration that needs no server and keeps everything in the browser: sign in as A01 to annotate,
T01 for the training programme or ADMIN for the admin area, with the password `demo`. The home page
offers the example recordings as EDF files to open "from your computer", which is what annotators
do with real recordings. The demonstration cannot run what needs Python (the analyses, consensus
references, the results zip file); for those, run the whole system on one computer with
`electroclean-web demo` and open <http://localhost:8000/>, signing in as A01, A02, T01 or ADMIN with
the password `electroclean` ([docs/web/server.md](docs/web/server.md) says where the recordings to
open and the results are).

There are no open pull requests or issues on GitHub.

## Branches

| Branch | What it holds | What to do with it |
| --- | --- | --- |
| `main` | The desktop application (1.1.0 plus unreleased work) and these notes as they stood before the browser-only decision | Leave it until the browser version is merged into it. |
| `claude/electroclean-web` | `main` plus the browser version, its admin area, the server and the Firebase functions, with the desktop application removed | Work from here until it is merged. Pushes run *Tests* and *Browser version tests*, and republish the preview when the application's files change. |
| `claude/eager-bardeen-33qhkb` | The branch earlier AI sessions worked on; identical to `main` | Nothing; it can be deleted. |
| `gh-pages` | The published web pages, written by `.github/workflows/pages.yml` | Never edit it by hand. GitHub Pages serves it (Settings, Pages: deploy from branch `gh-pages`, folder `/ (root)`). |

**Merging the browser version.** `claude/electroclean-web` contains every commit of `main`, so it
can be merged as a fast-forward while `main` has not moved (or through a pull request, to see the
whole change). Before merging, run *Tests* and *Browser version tests* by hand on the branch
(Actions tab, Run workflow): a run started by hand runs the Python suite on Windows, macOS and
Linux, which pushes to the branch do not. Merging publishes the application at the site's root,
<https://faisalmushtaq.github.io/ElectroClean/>, which today sends visitors on to the preview, and removes the
*Build applications* workflow from `main`. Nothing has been merged so far, at the project lead's
request.

## Setting up

ElectroClean needs Python 3.12 or 3.13 (64-bit). From a clone of the repository, on the browser
branch:

```bash
python -m venv .venv
source .venv/bin/activate              # Windows: .venv\Scripts\activate
python -m pip install -r requirements-dev.txt
python -m pip install --no-deps -e .
python -m pytest                       # the Python suite, a few minutes
electroclean-web demo                  # the whole system on http://localhost:8000/
```

`requirements.txt` holds what the server and the commands need, and `requirements-dev.txt` adds the
test tools and the Cloud Functions' SDK. The browser tests also need Node.js 22 and Playwright with
Chromium (`npm install --no-save playwright@1.63.0` and `npx playwright install chromium`). The
Firebase tests need Java 21 for Google's emulators; `npx` fetches the Firebase tools itself.

## Running it

| To | Run |
| --- | --- |
| Try everything on this computer | `electroclean-web demo`, then <http://localhost:8000/> (accounts above) |
| Run a study on your own server | `electroclean-web serve --study-dir …` ([docs/web/server.md](docs/web/server.md)) |
| Register recordings from the command line | `electroclean-web register …` (the admin area does the same in the browser) |
| See who has done what | the admin area's Results section, or `electroclean-web progress --study-dir …` or `--firebase-project … --study …` |
| Write a Firebase study's results into ElectroClean's folders | `electroclean-web export …` |
| Compare annotators | the admin area's Analyses section, or `electroclean-agreement path/to/Annotated_Events` |
| Turn interaction logs into tables and learning curves | the admin area, or `electroclean-activity path/to/Annotated_Events` |
| Work with reference sets in a folder | `electroclean-admin --help` |
| Run the whole workflow in plain Python | `python examples/demo_end_to_end.py` |

## Tests and continuous integration

| Suite | Command | Where it runs on GitHub |
| --- | --- | --- |
| Python (core, agreement, training, activity, the server, the admin and quiz operations, registration, the Firebase store and the functions) | `python -m pytest` (about 370 tests) | *Tests*: Linux on every push; Windows, macOS and Linux for `main`, pull requests into `main` and runs started by hand |
| Browser modules | `node --test web_tests/unit/*.test.mjs` (about 200 tests; the data tests write their recordings with `scripts/make_web_fixtures.py`, and a parity test checks that the browser's manifests match Python's) | *Browser version tests* |
| The browser application in Chromium | `ELECTROCLEAN_PYTHON=python node web_tests/run_e2e.mjs` (48 tests, against the demonstration and against the real `electroclean-web demo`) | *Browser version tests* |
| Firebase on the emulators | `bash scripts/test_firebase_emulators.sh` (the functions and the Firestore store) and `bash scripts/test_web_firebase.sh` (the application signing in, annotating, training, exporting and running the admin area) | *Browser version tests* |

The [testing guide](docs/testing_guide.md) lists the checks that need a person before a study
starts. *GitHub Pages* publishes the application (from `main` at the site's root, from the browser
branch under `preview/`), and *Firebase deploy*, run by hand, deploys the functions and rules to a
real project once it exists (see below).

## Setting up a real study on Firebase

Nobody has created the study's Firebase project yet. [docs/web/firebase.md](docs/web/firebase.md)
takes you through it step by step, in about an afternoon the first time: create the project, choose
the pay-as-you-go Blaze plan with a budget alert, create Firestore in europe-west2 (London), turn on
email and password sign-in, register the web application, deploy the rules and functions, create
the study and your own administrator account, and then do the rest in the admin area: add the
recordings from your computer, invite the annotators, assign the recordings, set up the reference
sets and choose the settings. Publish `config.json` so the application finds the project, send the
annotators the link and their recordings (on an encrypted drive, for example), and use
`electroclean-web export` or the admin area's zip file for the analyses. The *Firebase deploy*
workflow can deploy updates once the secret `FIREBASE_SERVICE_ACCOUNT` and the variable
`FIREBASE_PROJECT` are set in the repository; neither is set yet.

## What is open

**1. The real training material.** The training programme currently uses a placeholder: three
simulated recordings whose "expert" annotations are the simulation's ground truth. The project lead
is obtaining two or three properly annotated recordings. In a browser study the simplest route is
for the experts to annotate them in the study and for the admin area to turn their saved
annotations into references, or a consensus of them (the Training section of
[docs/web/admin.md](docs/web/admin.md)); the [administrator guide](docs/administrator_guide.md)
("Real expert files") describes the same with `electroclean-admin` in a folder. Once the real set
works, remove the example set.

**2. Merging the browser version** into `main`, as described under *Branches*, when the project
lead agrees.

**3. Versions and releases.** `__version__` is still `1.1.0`, and the *Unreleased* section of
[CHANGELOG.md](CHANGELOG.md) describes everything since. With the desktop applications gone there is
no release workflow: a browser release is a merge into `main`, which publishes the application, and
a deploy of the functions with *Firebase deploy*. Decide how versions are numbered from now on (the
natural next one is 2.0.0, since the desktop application is gone), then set `__version__`, give the
version its own section in the changelog and, if wanted, publish a GitHub release by hand from that
section. [docs/developer_guide.md](docs/developer_guide.md) describes packaging and CI.

**4. Decisions for the research team**, listed under "Decisions still open" in
[docs/design_decisions.md](docs/design_decisions.md): the agreement settings to pre-register, the
competency criteria, scheduling repeat annotations for test-retest reliability, whether idle time
counts, the copyright holder named in the licence notice, and whether Emotiv's contact-quality
channels should be shown.

**5. Data protection for real studies.** The interaction logs are participant data about the
annotators, a Firebase study keeps the study's records with Google in London, and the audit log
names the administrators. The "Data protection in brief" sections of
[docs/web/firebase.md](docs/web/firebase.md) and [docs/web/server.md](docs/web/server.md) describe
exactly what is stored; check the arrangements with the university's research data and ethics
processes before the first real study.

**6. Loose ends in the browser version.** These are known, and none of them blocks a pilot. It has
been tested in Chromium (Chrome and Edge) only, so Firefox and Safari need a run-through, the
admin area on a tablet included. On the test machine, the first 10-second screen of a 128-channel
recording with filters took about 0.3 s to appear and the following screen, prepared in advance,
about 0.02 s; check this on the computers annotators will use. A reference set's
`show_full_report_to_annotator` setting has no effect in the browser, where competency reports are
for administrators and trainees see their result; decide whether trainees should ever see the full
report, and either offer it or retire the setting. `electroclean-admin` still offers a few options
that only mattered to the desktop application (`set-passphrase` and `resolve-failure`); the
administrator guide says so, and they can be removed. The README has no
picture of the browser application yet. Three small differences from the desktop application's
display are documented in [docs/web/architecture.md](docs/web/architecture.md).

**7. Housekeeping.** The project's `ruff` settings give only the line length, so a recent `ruff`
applies many style rules the code was never written to; `ruff check --select E,F,W,B` is the useful
subset. A shared linting configuration and a lint step in CI would help.

## Things worth knowing before changing code

**The annotation store is the single source of truth**: the interface displays it and sends every
action to it. **Source EEG files are never written to**, and a recording is marked complete only
after its five output files have been written, read back and verified (the journalled save in
`electroclean/app/session/`). **Every change an administrator makes is written to the audit log**,
whichever way it is made. Keep all three properties whatever else changes.

**The browser, the server and the Firebase functions share one contract**,
[docs/web/api.md](docs/web/api.md), with the annotators' operations, the administrator's operations
(`POST /api/v1/admin/{op}`, or the callable `ec_admin`) and the quiz. A change to a request or
response touches the service layer (`electroclean/web/service.py` and the modules it calls, such as
`admin.py`, `quiz.py`, `coach.py` and `visits.py`), the HTTP route in `electroclean/web/app.py`, the
Firebase function in `electroclean/web/firebase/functions/main.py`, the browser's `js/api/http.js`,
`js/api/firebase.js` and the in-browser demonstration (`js/api/demo.js` and `demo_admin.js`), and
the contract itself. The end-to-end tests against the real server and the emulators are what catch
a mismatch.

**Registration happens in two places.** The browser's `js/data/register.js` must build the same
manifest as Python's `electroclean.web.manifest.build_manifest` for the same files and settings, and
the server checks every manifest it receives (`electroclean/web/manifest_check.py`) before storing
it. The parity tests compare the two field by field; change both together.

**Slow answers are normal on Firebase.** Functions can take a few seconds to start after a quiet
period, and an instance can occasionally stop mid-request, so the browser must stay correct when an
answer arrives late or not at all. The guided coach takes one action at a time for this reason, the
admin area's buttons cannot be pressed twice while waiting, and calls that only read are asked a
second time after a failure, while calls that save, score, register or count an attempt never are
(`js/api/firebase.js`). Test with the emulators, which behave more like Firebase than the local
server does.

**The browser application has no build step**: plain ES modules with relative paths, so that the
same files work at the site's root and under `/preview/`, and plain `#name` routes (the admin area's
sections are `#admin-…`). External scripts come only from fixed, versioned URLs.

**Writing.** The interface text and the documentation are in UK English, with the HED spelling
*artifact* kept in label names. The documentation is written as prose, in the voice of the existing
guides. Any literature cited must be checked against the original source before it is added to
[docs/references.md](docs/references.md).

## Documentation map

| Document | For |
| --- | --- |
| [README.md](README.md) | What ElectroClean is, trying it, running a study, the outputs |
| [docs/web/using.md](docs/web/using.md) | Annotators and trainees using the browser application |
| [docs/web/admin.md](docs/web/admin.md) | Lead researchers using the admin area |
| [docs/web/firebase.md](docs/web/firebase.md) | Setting up a real study on Firebase, step by step |
| [docs/web/server.md](docs/web/server.md) | The demonstration and a study on ElectroClean's own server |
| [docs/web/architecture.md](docs/web/architecture.md) | How the browser application, the server and Firebase fit together |
| [docs/web/api.md](docs/web/api.md) | The contract between browser and server, and the Firebase functions |
| [docs/administrator_guide.md](docs/administrator_guide.md) | Every study setting, reference sets, competency criteria, the training programme |
| [docs/reliability_guide.md](docs/reliability_guide.md) | The agreement measures and how to read them |
| [docs/activity_logs.md](docs/activity_logs.md) | What the interaction logs record, and the activity analysis |
| [docs/file_formats.md](docs/file_formats.md) | Every output and configuration file |
| [docs/developer_guide.md](docs/developer_guide.md) | The Python core, conventions, packaging and CI |
| [docs/testing_guide.md](docs/testing_guide.md) | Tests, synthetic data, checks that need a person |
| [docs/design_decisions.md](docs/design_decisions.md) | How the specification was interpreted; open decisions |
| [docs/hed_score_validation.md](docs/hed_score_validation.md) | The 29 artifact terms against HED SCORE 2.2.0 |
| [docs/references.md](docs/references.md) | Literature cited |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release, and what is unreleased |

## Access and accounts

The repository is public, under the PolyForm Noncommercial licence. Nothing secret is stored in it:
the demonstration passwords above are for simulated data only, the Firebase web configuration that
`config.json` will hold is public by design, and the Firebase service-account key, when one is made,
belongs in the repository's Actions secrets. Changing GitHub Pages, secrets or branch settings needs
admin rights on the repository, which the repository owner holds.
