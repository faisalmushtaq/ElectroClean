# Handover notes

These notes are for whoever takes ElectroTag on next, and for the AI assistant they work with.
They say where the project stands on 29 October 2026, what is still open, and how to carry on
without having to rediscover anything. Instructions written for AI coding assistants are in
[CLAUDE.md](CLAUDE.md); read both before changing anything.

The project was called ElectroClean until 29 October 2026, when it was renamed ElectroTag before
any study had started; the repository, the package, the commands and every name in the files
changed together, and the 1.1.0 release and the history before it keep the old name.

## What ElectroTag is

ElectroTag is research software for the manual annotation of artifacts in continuous EEG,
written for a PhD project on EEG artifact identification and automated EEG cleaning. Annotators
mark artifact intervals with the 29 HED-SCORE artifact terms, on the whole montage or on chosen
channels; the results are saved as validated, BIDS-compatible files; an agreement analysis
compares annotators by category, time and channel; a training programme takes new annotators from
guided practice to a competency assessment; and an interaction log records how each annotator
works, as research data in its own right. The [README](README.md) is the best short introduction,
and the [design decisions](docs/design_decisions.md) record why things are as they are.

ElectroTag runs in the web browser. Annotators open a link, sign in and open the recordings they
were given from their own computer: the page reads each file there, so the EEG never leaves that
computer, and the study holds only each recording's manifest (the SHA-256 fingerprint of its data
file, its timing, channels and events), the annotations and the interaction logs. Lead researchers
run the study from the admin area of the same application. A study's records live on **Firebase**
(the chosen way to run real studies) or on **ElectroTag's own server** (`electrotag-web serve`,
used for the local demonstration and for a study that prefers its own computer).

## Where things stand

On 28 October 2026 the project lead decided to retire the desktop application and to make the
browser version complete, with an admin area for the lead researchers. That work was finished and
tested on the branch `claude/electroclean-web` and merged into `main` the same day, with the project
lead's agreement, so `main` now holds the browser application and GitHub Pages publishes it at
<https://faisalmushtaq.github.io/ElectroTag/>.

The browser version now does everything the desktop application did. Annotators annotate with the
same keys, toolbar and dialogs (including a channel chooser that works on 128-channel montages),
save with Save and Finish, keep a draft that follows them to another browser, follow the training
programme from guided learning to the competency assessment, and take the short-segment quiz,
which they can stop and resume or end early with the score of the segments answered. The admin area
covers what the desktop's administrator tools and `electrotag-admin` covered, and more: accounts
(with invitation links on Firebase), recordings added from the administrator's own computer (the
browser builds the same manifests as the command line), assignments, reference sets with their
four sources of reference (someone's saved annotations, a file, a consensus of several experts with
its disagreements listed, an adjudicated consensus), competency criteria, the quiz, the agreement
and activity analyses and competency reports, progress, every result as one zip file, the study's
settings, and an audit log of every change an administrator makes.

The desktop application has been removed from the branch, with its stand-alone applications, the
launchers, the self-test and Qt. The Python core stays: it loads recordings with MNE-Python, writes
and verifies the result files, and runs the agreement, training and activity analyses, and the
server and the Firebase functions call it. The commands `electrotag-agreement`,
`electrotag-admin` and `electrotag-activity` work as before on saved results, and
`electrotag-web` runs the server, registers recordings and exports a Firebase study. Version 1.1.0
on the [Releases page](https://github.com/faisalmushtaq/ElectroTag/releases) was the last desktop
release; the results folders it wrote are read unchanged.

On the night of 28 to 29 October 2026 the application gained what a long study needs from day to
day. Administrators have a menu grouped under Study, People, Data and Settings with Find in the
header; private invitation links (single use, kept by the study only as a hash); Add several, which
makes many accounts from pasted lines; a Progress section with study totals, a projected finish date,
a chart of completions over the last 30 days and sortable tables of people and recordings; and
actions on many recordings or accounts at once. Annotators can pause and resume (B), with breaks,
idle time and time out of sight left out of the time worked; they get a gentle break reminder, a
record of the parts of each recording they have viewed with Next part not yet viewed (U), a check
before Save and Finish, a draft that reopens where they left it, and display comfort settings. Their
home page shows their progress with an estimate of the time left, a list with tabs, search and pages
that stays usable with hundreds of recordings, their history, and revisions: a finished recording can
be opened again and submitted as a new attempt, the earlier files staying as they were and the
analyses using the latest. Game elements (milestones, a weekly goal, the team's progress and a
leaderboard under pseudonyms) follow work done and never the number of annotations, so that they do
not bias the data, and the study can switch them off. Recordings can be opened from a Dropbox or
OneDrive link straight into the browser, with a two-step download as the fallback, and kept in the
browser's own storage with a panel that shows the space used and removes finished recordings in one
click. Channels can be coloured by region, side or type with a palette checked for colour-blind
readers that keeps grey for bad channels. On a phone the application says plainly that annotating
needs a tablet or a computer and offers to email the link. The [CHANGELOG](CHANGELOG.md) has the
details, and [docs/design_decisions.md](docs/design_decisions.md) the reasons.

**Trying it.** The application at <https://faisalmushtaq.github.io/ElectroTag/>, opened without a
study, is a demonstration that needs no server and keeps everything in the browser: sign in as A01 to annotate,
T01 for the training programme, E01 for the expert area or ADMIN for the admin area, with the password `demo`. The home page
offers the example recordings as EDF files to open "from your computer", which is what annotators
do with real recordings. The demonstration cannot run what needs Python (the analyses, consensus
references, the results zip file); for those, run the whole system on one computer with
`electrotag-web demo` and open <http://localhost:8000/>, signing in as A01, A02, T01, E01 or ADMIN with
the password `electrotag` ([docs/web/server.md](docs/web/server.md) says where the recordings to
open and the results are).

There are no open pull requests or issues on GitHub.

## Branches

| Branch | What it holds | What to do with it |
| --- | --- | --- |
| `main` | The browser application, its admin area, the server, the Firebase functions and the Python core | Work on a branch from here. Pushes run *Tests* on Windows, macOS and Linux and *Browser version tests*, and publish the application at the site's root. |
| `claude/electroclean-web` | The branch the browser version was built on; merged into `main` and identical to it | Keep it for previews or delete it: pushes to it publish the application under `preview/` without touching the site's root, a way to show work in progress before it reaches `main` (bring it up to date with `main` first). |
| `claude/eager-bardeen-33qhkb` | The branch earlier AI sessions worked on; identical to `main` | Nothing; it can be deleted. |
| `gh-pages` | The published web pages, written by `.github/workflows/pages.yml` | Never edit it by hand. GitHub Pages serves it (Settings, Pages: deploy from branch `gh-pages`, folder `/ (root)`). |

Before merging a branch into `main`, run *Tests* by hand on it (Actions tab, Run workflow): a run
started by hand tests the Python code on Windows, macOS and Linux, which pushes to other branches
do not. The desktop application's last state is in `main`'s history (before the merge of 28 October
2026) and in the 1.1.0 release, should anyone need it.

## Setting up

ElectroTag needs Python 3.12 or 3.13 (64-bit). From a clone of the repository:

```bash
python3 -m venv .venv                  # Windows: py -m venv .venv
source .venv/bin/activate              # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
pip install -e .
python -m pytest                       # the Python suite, a few minutes
electrotag web demo                    # the whole system on http://localhost:8000/
```

The package is installed from the repository and is not on PyPI; the README's "Installing the
Python package" also shows how to install it straight from GitHub. `electrotag` lists the four
tools (`electrotag web`, `agreement`, `admin` and `activity`), which keep their older names
`electrotag-web` and so on as well.

`requirements.txt` holds what the server and the commands need, and `requirements-dev.txt` adds the
test tools and the Cloud Functions' SDK. The browser tests also need Node.js 22 and Playwright with
Chromium (`npm install --no-save playwright@1.63.0` and `npx playwright install chromium`). The
Firebase tests need Java 21 for Google's emulators; `npx` fetches the Firebase tools itself.

## Running it

| To | Run |
| --- | --- |
| Try everything on this computer | `electrotag-web demo`, then <http://localhost:8000/> (accounts above) |
| Run a study on your own server | `electrotag-web serve --study-dir …` ([docs/web/server.md](docs/web/server.md)) |
| Register recordings from the command line | `electrotag-web register …` (the admin area does the same in the browser) |
| See who has done what | the admin area's Results section, or `electrotag-web progress --study-dir …` or `--firebase-project … --study …` |
| Write a Firebase study's results into ElectroTag's folders | `electrotag-web export …` |
| Compare annotators | the admin area's Analyses section, or `electrotag-agreement path/to/Annotated_Events` |
| Turn interaction logs into tables and learning curves | the admin area, or `electrotag-activity path/to/Annotated_Events` |
| Work with reference sets in a folder | `electrotag-admin --help` |
| Run the whole workflow in plain Python | `python examples/demo_end_to_end.py` |

## Tests and continuous integration

| Suite | Command | Where it runs on GitHub |
| --- | --- | --- |
| Python (core, agreement, training, activity, the server, the admin and quiz operations, registration, the Firebase store and the functions) | `python -m pytest` (about 370 tests) | *Tests*: Linux on every push; Windows, macOS and Linux for `main`, pull requests into `main` and runs started by hand |
| Browser modules | `node --test web_tests/unit/*.test.mjs` (about 200 tests; the data tests write their recordings with `scripts/make_web_fixtures.py`, and a parity test checks that the browser's manifests match Python's) | *Browser version tests* |
| The browser application in Chromium | `ELECTROTAG_PYTHON=python node web_tests/run_e2e.mjs` (48 tests, against the demonstration and against the real `electrotag-web demo`) | *Browser version tests* |
| Firebase on the emulators | `bash scripts/test_firebase_emulators.sh` (the functions and the Firestore store) and `bash scripts/test_web_firebase.sh` (the application signing in, annotating, training, exporting and running the admin area) | *Browser version tests* |

The [testing guide](docs/testing_guide.md) lists the checks that need a person before a study
starts. *GitHub Pages* publishes the application (from `main` at the site's root, from
`claude/electroclean-web` under `preview/`), and *Firebase deploy*, run by hand, deploys the
functions and rules to a real project once it exists (see below).

## Setting up a real study on Firebase

Nobody has created the study's Firebase project yet. [docs/web/firebase.md](docs/web/firebase.md)
takes you through it step by step, in about an afternoon the first time: create the project, choose
the pay-as-you-go Blaze plan with a budget alert, create Firestore in europe-west2 (London), turn on
email and password sign-in, register the web application, deploy the rules and functions, create
the study and your own administrator account, and then do the rest in the admin area: add the
recordings from your computer, invite the annotators, assign the recordings, set up the reference
sets and choose the settings. Publish `config.json` so the application finds the project, send the
annotators the link and their recordings (on an encrypted drive, for example), and use
`electrotag-web export` or the admin area's zip file for the analyses. The *Firebase deploy*
workflow can deploy updates once the secret `FIREBASE_SERVICE_ACCOUNT` and the variable
`FIREBASE_PROJECT` are set in the repository; neither is set yet.

## What is open

**1. The real training material.** The training programme currently uses a placeholder: three
simulated recordings whose "expert" annotations are the simulation's ground truth. The project lead
is obtaining two or three properly annotated recordings. In a browser study the simplest route is
for the experts to annotate them in the study and for the admin area to turn their saved
annotations into references, or a consensus of them (the Training section of
[docs/web/admin.md](docs/web/admin.md)); the [administrator guide](docs/administrator_guide.md)
("Real expert files") describes the same with `electrotag-admin` in a folder. Once the real set
works, remove the example set. Its guided notes tell trainees what each simulated artifact looks like
and why it is marked on those channels; real sets need the experts' own explanations, written in the
admin area's Guided notes. The words trainees read about their practice score and the training path
are built twice, in `electrotag/training/programme.py` for the study and in
`js/training/scoring.js` for the demonstration, and `web_tests/practice_parity.py` keeps them the
same, as `js/training/stages.js` and `web_tests/unit/api_contract_parity.test.mjs` keep the five
stages' rules and words. Study recordings now wait for a passed assessment (the study's training
policy can change that), so a real study needs a set with assessment recordings and competency
criteria before its trainees can annotate; without criteria every result is "not determined" and the
recordings stay locked until the study team reopens the training, gives a new assessment set or
switches the gate off.

**2. Versions and releases.** `__version__` is still `1.1.0`, and the *Unreleased* section of
[CHANGELOG.md](CHANGELOG.md) describes everything since. With the desktop applications gone there is
no release workflow: a browser release is a push to `main`, which publishes the application, and a
deploy of the functions with *Firebase deploy*. Decide how versions are numbered from now on (the
natural next one is 2.0.0, since the desktop application is gone), then set `__version__`, give the
version its own section in the changelog and, if wanted, publish a GitHub release by hand from that
section. [docs/developer_guide.md](docs/developer_guide.md) describes packaging and CI.

**3. Decisions for the research team**, listed under "Decisions still open" in
[docs/design_decisions.md](docs/design_decisions.md): the agreement settings to pre-register, the
competency criteria, scheduling repeat annotations for test-retest reliability, whether idle time
counts, the copyright holder named in the licence notice, and whether Emotiv's contact-quality
channels should be shown.

**4. Data protection for real studies.** The interaction logs are participant data about the
annotators, a Firebase study keeps the study's records with Google in London, and the audit log
names the administrators. The "Data protection in brief" sections of
[docs/web/firebase.md](docs/web/firebase.md) and [docs/web/server.md](docs/web/server.md) describe
exactly what is stored; check the arrangements with the university's research data and ethics
processes before the first real study.

**5. Loose ends in the browser version.** These are known, and none of them blocks a pilot. It is
tested in Chromium (Chrome and Edge) and in WebKit (Safari's engine), with emulated iPads upright
and on their side, so Firefox and a real iPad (with fingers and the Pencil) need a run-through. On the test machine, the first 10-second screen of a 128-channel
recording with filters took about 0.3 s to appear and the following screen, prepared in advance,
about 0.02 s; check this on the computers annotators will use. A reference set's
`show_full_report_to_annotator` setting has no effect in the browser, where competency reports are
for administrators and trainees see their result; decide whether trainees should ever see the full
report, and either offer it or retire the setting. `electrotag-admin` still offers a few options
that only mattered to the desktop application (`set-passphrase` and `resolve-failure`); the
administrator guide says so, and they can be removed. The README has no
picture of the browser application yet. Three small differences from the desktop application's
display are documented in [docs/web/architecture.md](docs/web/architecture.md). After the usability review of 29 October, the
annotation view's layout and the EEG drawing were reworked for small, zoomed and dense cases (see
the CHANGELOG); two things were left. The marks on the overview bar are still told apart by colour
alone (the nine types of the numbered buttons now stay apart under red-green colour blindness, the
other twenty need not), and Show all on a long recording still reads every sample of the channels on
screen; a low-resolution overview of the whole recording built in the background after it opens
would make Show all immediate.

**6. Loose ends from the night of 28 to 29 October.** A download from a real OneDrive link has not
been tried (no public link was at hand); Dropbox was checked with real links, through a route that
works but that Dropbox does not document, and Google Drive cannot be read by a web page, so its links
always use the two-step download. Attaching a link to each registered recording, so that Open fetches
it without the annotator pasting anything, is the natural next step: `js/data/fetch_links.js`
already takes a list of files and their links. The study default for channel colours
(`display.channel_colours`) is set in Study settings. `electrotag-activity` does not
yet put the time paused (`paused_s`, in the interaction log) in its tables. A Firebase invitation
shows no expiry date, because Firebase does not give one. Keeping recordings on an iPad uses the
faster storage from iPadOS 26 and the browser's database before it; check both on a real iPad. Two tabs that keep the same
recording at the same moment can both write its files; on one heavily loaded test run the first
tab read the copy back while the second was still writing and called it incomplete (it then
removes the copy and opens the recording from memory, so no work is lost). A per-copy Web Lock
around writing is the natural fix. A first attempt made WebKit refuse some reads in the tests and
was taken out again. The refusal is most probably the one since found in the device test, which is
WebKit's own: it refuses every read of a Blob (a kept file, or one held in memory) that starts once
the page has begun to reload or close, and reports it as an error of the page, which the test
runner counts. Lists of kept copies now read each description once per page (`DescriptionCache` in
`js/data/device_store.js`), and the device test lists them throughout a reload to keep it that way,
so the lock can be tried again, with the device tests in WebKit as the check.

**6b. Loose ends from the EEGNet comparison (29 October).** Confidence, notes, problem reports,
reviews of saved work, the channel map, the value under the pointer, the overlay and Go to time are
in place. Electrode positions from a BIDS `electrodes.tsv` are used when the annotator
opens it with the recording, when it was kept with a copy on the device (`keepOnDevice` in
`js/views/device.js` keeps the `electrodes.tsv` and `coordsystem.json` that belong to the
recording), and for a recording opened from a link: pasted as links of their own after the
recording's (optional, so a failure is passed over), or fetched from beside a recording at a plain
web address under their BIDS names (`fetchNeighbourElectrodes` in `js/data/fetch_links.js`: each
candidate asked once, eight seconds in all, while the recording opens; a name with a `space-`
entity cannot be guessed and is not tried). Dropbox and OneDrive share one file per link, so
nothing beside them can be found. Recordings a study knows only by their manifest still need the
annotator to pick the `electrodes.tsv` with the recording. Letting the manifest name it, or carry
the positions themselves, would change what the study stores: `electrotag/web/manifest.py` and
`js/eeg/register.js` would both build the new field (checked by `web_tests/register_parity.py`),
`manifest_check.py` would have to keep it, and `docs/web/api.md` would describe it; the open
view could then say which file to pick, or the map use the stored positions. That is left for a
decision by the project lead.

**6c. Loose ends from the usability fixes to the pages around the annotation view (29 October).**
An expired or replaced invitation link asks the person to contact "the study team who invited you",
because a study has no setting that names a contact; a `contact` setting shown there (and on the
sign-in page) would need the settings, the admin area's Settings section and `docs/web/api.md`. When
the connection is lost before the file readers load, Try again asks for `eeg/recording.js` under
another address, because Chromium remembers a module that failed to load for the life of the page;
a module that it imports and that also failed still needs a reload of the page, which the message
says. The readers now load just after signing in to a study (not in the demonstration), so this
should be rare. The whole team's figure on the home page counts recordings saved, while the
annotator's own progress also counts those set aside; whether the team's should count them too is
a choice for the research team.

**6d. The admin area after its usability review (29 October).** Sharing a study's recordings out
among its annotators, each recording to a chosen number of people, is to be built as "tasks"; until
then Assignments gives every recording, or those ticked, to the people ticked. An administrator's own
visits are still logged in the mode Annotation (Records marks them as an administrator's), since the
admin area itself is never logged; give them a mode of their own if the activity analysis should
tell them apart.

**6e. Experts, corrections, replays, adjudication and staged training (30 October).** The project
lead's request of 29 October (experts who view and correct others' work, replays of sessions,
screening-style adjudication with a library of conflicts, and a five-stage training path) is being
built in parts. The foundation is in place: accounts hold a set of roles (annotator, expert,
admin; participant reserved for a later crowd study), the expert channel (`POST /expert/{op}`,
`et_expert`, `electrotag/web/expert.py` with its registry `EXPERT_OPS`), the expert area's shell
(`js/expert/area.js`, sections in `js/expert/sections.js`) and the purposes a recording is opened for
(`js/views/purposes.js`), the study settings `review`, `training` and `replay`, and the storage the
later parts need (derived versions in `Annotated_Events/derived/`, saved attempts by number, the
competency status, each visit's index of recordings and its log in pages, and the task of an
assignment). Corrections and replays, tasks, adjudication and the library, the staged training
path and the analyses of derived versions follow, each adding its own modules and one line to the
registries; `docs/web/api.md` has a section waiting for each. The staged training path is in
place: the tour (`js/training/tour.js`), the snippets (`js/training/snippets.js`, the study team's in
the set's `reference_set.json`), skipping and resuming stages, and the competency gate of study work
(`electrotag/web/training_path.py`). Its hooks for the parts still to come are registries: a guided
recording whose guidance another part handles, such as "correct the marks", registers in
`GUIDANCE_KINDS` (`electrotag/web/coach.py`) and `GUIDANCE_PANELS` (`js/training/coach.js`), and the
replay part's "Watch an expert" adds a line to `WATCH_EXPERT` in `js/training/path.js`. The tour's
practice recording is made in the browser; a tour recording taken from a set is left for later. The
sandbox's training set has no assessment, so the gate is always open there; the end-to-end test of
the gate runs against the real study server. The project lead decided that experts
and administrators may replay any annotator's session and that trainees may watch an expert's
session only with that expert's consent (a flag each expert sets in the expert area, audited). This
uses the interaction logs for a new purpose: the study's ethics approval may need an amendment
before replays are used. ElectroTag's own logging notice now says that the study team can replay a
session and that an expert's sessions may be shown to trainees when the expert agrees; a study that
wrote a notice of its own should add the same.

Corrections and replays are in place (`electrotag/web/corrections.py`, `replay.py`; `js/expert/`
and `js/replay/`): an expert corrects saved work from Saved work in the expert area, with a reason
for each change, as a derived version; the annotator sees the changes in their history; and a
replay plays a session back from the interaction log, which since 30 October holds a snapshot of the
annotations a session opens with (older logs replay from the end of the session before). When two
experts correct the same version both corrections are kept and counted; comparing them in the
adjudication queue, and the "correction pending adjudication" state of the analyses, belong to the
adjudication and analysis parts, which find them with `corrections.corrections_of`. Trainees reach
the experts' sessions they may watch through "Watch an expert at work" (`js/replay/watch.js`), for now
on the home page's training card. A trainee needs the recording's file on their own computer to
watch, as for any replay: a study that wants to teach with replays should give trainees the files of
the recordings the experts' sessions were on.

**7. Housekeeping.** The project's `ruff` settings give only the line length, so a recent `ruff`
applies many style rules the code was never written to; `ruff check --select E,F,W,B` is the useful
subset. A shared linting configuration and a lint step in CI would help. Many code comments still
explain behaviour by comparison with the desktop application ("as the desktop does"); they are
accurate as history, and can be reworded to name the Python code instead as the files are touched.

## Things worth knowing before changing code

**The annotation store is the single source of truth**: the interface displays it and sends every
action to it. **Source EEG files are never written to**, and a recording is marked complete only
after its five output files have been written, read back and verified (the journalled save in
`electrotag/app/session/`). **Every change an administrator makes is written to the audit log**,
whichever way it is made. Keep all three properties whatever else changes.

**In the annotation view, a key means the same thing whatever the timing**, and nothing that loses
work happens on a reflex. The number keys choose a type except straight after D (or in Rate them),
where the bar beside the outlined annotation says that they rate; a request for a rating never ends
by itself. Esc or a click beside a question keeps the work (the restore questions resolve to
restoring), destructive answers ask a second time, and work discarded is set aside in the browser
tab (`discardDrafts` and `bringBackDiscarded` in `js/annotate/session.js`) so that the Annotations
tab can offer it back. The header's buttons are disabled when they cannot act and while paused, and
take no keyboard focus from a mouse click. `web_tests/e2e/u_interaction.e2e.mjs` checks these rules.

**No draft is written for a session once its view has closed or its work was discarded.** Several
things save drafts on their own (a local save 1.2 s after a change, the 30 s autosave, the page
being hidden, the connection returning), and an AnnotationSession outlives its view. So
`Workspace.destroy` calls `session.close()`, which stops every save of it; drafts go to the study one
at a time; a discard and Save and Finish wait for the one on its way; and a Discard and close names
its session in the DELETE, so that the study refuses a late draft of it (409 `draft_discarded`,
remembered beside the drafts in `<key>.closed` or the Firestore collection `draft_closed`). A new
way of saving drafts must go through `saveLocal`/`saveRemote`, which check `mayKeepDraft`.

**The browser, the server and the Firebase functions share one contract**,
[docs/web/api.md](docs/web/api.md), with the annotators' operations, the administrator's operations
(`POST /api/v1/admin/{op}`, or the callable `et_admin`) and the quiz. A change to a request or
response touches the service layer (`electrotag/web/service.py` and the modules it calls, such as
`admin.py`, `quiz.py`, `coach.py` and `visits.py`), the HTTP route in `electrotag/web/app.py`, the
Firebase function in `electrotag/web/firebase/functions/main.py`, the browser's `js/api/http.js`,
`js/api/firebase.js` and the in-browser demonstration (`js/api/demo.js`, `demo_admin.js` and
`demo_feedback.js`), and the contract itself. The end-to-end tests against the real server and the
emulators are what catch a mismatch, and `web_tests/unit/api_contract_parity.test.mjs` sends the
same calls to the real service and to the demonstration's stand-in and compares the answers, so a
change that the stand-in does not follow fails there first (docs/web/architecture.md, "The
sandbox's stand-in for the server").

**Registration happens in two places.** The browser's `js/eeg/register.js` must build the same
manifest as Python's `electrotag.web.manifest.build_manifest` for the same files and settings, and
the server checks every manifest it receives (`electrotag/web/manifest_check.py`) before storing
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

**The EEG library and the parts loaded on demand.** Everything that reads, filters, fingerprints
or registers a recording is in `js/eeg/`, which imports nothing from the rest of the application
(its README.md lists each module, what it reproduces of MNE-Python and the tests of its parity;
`web_tests/unit/eeg_imports.test.mjs` enforces the rule). The sign-in page loads only `app.js`, the
sign-in view and the back end's client; every later view is a part that `js/lazy.js` loads at its
first use, and `app.js` shows Loading… or a message with Try again around it. A new view should be
added to the parts in `lazy.js` and reached through `_withParts` in `app.js`, never imported by
`app.js` directly; `web_tests/e2e/v_loading.e2e.mjs` keeps the sign-in page within a budget of
JavaScript and will fail otherwise. The demonstration's back end (about 315 KB, with
`demo_admin.js` and `admin/model.js`) still loads whole at its sign-in, which is now 457 KB against
a budget of 462 KB in `v_loading.e2e.mjs`; loading its admin half only for the administrator would
bring the demonstration's sign-in page down to about 330 KB.

**Writing.** The interface text and the documentation are in UK English, with the HED spelling
*artifact* kept in label names. The documentation is written as prose, in the voice of the existing
guides. Any literature cited must be checked against the original source before it is added to
[docs/references.md](docs/references.md).

## Documentation map

| Document | For |
| --- | --- |
| [README.md](README.md) | What ElectroTag is, trying it, running a study, the outputs |
| [docs/web/using.md](docs/web/using.md) | Annotators and trainees using the browser application |
| [docs/web/admin.md](docs/web/admin.md) | Lead researchers using the admin area |
| [docs/web/firebase.md](docs/web/firebase.md) | Setting up a real study on Firebase, step by step |
| [docs/web/server.md](docs/web/server.md) | The demonstration and a study on ElectroTag's own server |
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
