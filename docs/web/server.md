# The ElectroClean server

Real studies of ElectroClean in the browser run on Firebase (docs/web/firebase.md). The ElectroClean
server is the other back end: the same operations (docs/web/api.md) over HTTP, from a study folder on
a computer you control. It is how the whole system is tried on one computer (`electroclean-web
demo`), how the browser application is tested, and it suits a study that prefers its own machine,
for example a university server.

## Install

In the ElectroClean folder:

```
python -m pip install -r requirements.txt
python -m pip install --no-deps -e .
```

This installs the server and the administrator's command, `electroclean-web`, without the desktop
application's windows.

## The demonstration

```
electroclean-web demo
```

makes a demonstration study in `./electroclean-demo` (once; `--fresh` makes it again) and serves the
browser application and the API at `http://localhost:8000/`. It holds three simulated study
recordings (two BrainVision, one EDF+), ElectroClean's example training set and four accounts, all
with the password `electroclean`: ADMIN (the administrator's account, for the admin area), A01 and A02
(annotators with every study recording) and T01 (a trainee in the example training programme). The
files to open in the browser are in `electroclean-demo/recordings` (`study/` for A01 and A02,
`training/` for T01), also downloadable from `http://localhost:8000/demo/recordings.zip`. Results
appear in `electroclean-demo/study/Annotated_Events`, exactly as the desktop application writes
them, so `electroclean-agreement electroclean-demo/study/Annotated_Events` and `electroclean-activity`
work on them straight away.

`--port` and `--host` choose where it listens (`--host 0.0.0.0` for other computers on the network);
`--no-serve` only makes it. The demonstration also accepts the application published on GitHub
Pages: open `https://faisalmushtaq.github.io/ElectroClean/preview/?server=http://localhost:8000`.

## A study on your own server

Three commands set the study up; everything after that is done in the browser.

1. Create the study folder: `electroclean-web init-study --study-dir /srv/pilot --study pilot --name "Pilot study"`
   (with `--settings settings.json` for settings that differ from ElectroClean's defaults, in the form
   of the `settings` block of `electroclean_study.json`).
2. Create your own administrator account: `electroclean-web add-user ADMIN --admin --name "Your name"
   --study-dir /srv/pilot` asks for a password (at least 8 characters).
3. Serve it: `electroclean-web serve --study-dir /srv/pilot --host 0.0.0.0 --port 8000`. Put it behind
   your institution's HTTPS (a reverse proxy such as nginx); browsers must reach it over HTTPS
   unless it is on the same computer.

Then sign in with that account and open the **admin area** (docs/web/admin.md). There you add the
recordings (choose the dataset folder on your computer: the browser reads each recording, runs
ElectroClean's checks and sends only what the study needs to recognise and show it, never the EEG),
make the annotators' accounts (each gets a temporary password to pass on, which they can keep or you
can reset; disabling an account ends its sessions at once), assign recordings and training
programmes, build reference sets from annotators' saved work, uploaded annotation files, consensus or
adjudication, change the study's settings, and run the agreement, activity and competency analyses.
Every change is kept in the study's audit log, with who made it and when.

The commands remain an alternative for each of these, and the audit log records their changes too
(by "command"):

* `electroclean-web register /data/Pilot --study-dir /srv/pilot` registers a dataset's recordings
  where they are, with the desktop application's loader, and its training reference sets with their
  experts' annotations and without their recordings. When the recordings are on another computer,
  run `electroclean-web export-manifests /data/Pilot --out pilot.json` there and
  `electroclean-web import-manifests pilot.json --study-dir /srv/pilot` on the server.
* `electroclean-web add-user A01 --name "Annotator one" --study-dir /srv/pilot` makes an account.
* `electroclean-web assign A01 --all --study-dir /srv/pilot`, or `--recordings ...`, or
  `--programme <set>` for a trainee, assigns the work; `electroclean-web list --study-dir /srv/pilot`
  shows the study.

The server serves the browser application from `/` when the application is included
(`electroclean/web/static/`), so annotators can simply open the server's address. To use the
application on GitHub Pages instead, list its origin in `ELECTROCLEAN_ALLOWED_ORIGINS`
(comma-separated, for example `ELECTROCLEAN_ALLOWED_ORIGINS=https://faisalmushtaq.github.io`) and send
annotators `https://faisalmushtaq.github.io/ElectroClean/?server=https://eeg.example.ac.uk`.

The application on GitHub Pages is published by `.github/workflows/pages.yml` on the `gh-pages`
branch (`main` at the site's root, the browser version's branch under `preview/`); in the
repository's Settings, Pages, choose Deploy from a branch, branch `gh-pages`, folder `/ (root)`.
Served by the ElectroClean server itself, the application always talks to that server: the server
answers `/config.json` with its own address, whatever `config.json` the application was published
with.

`ELECTROCLEAN_STUDY_DIR` and `PORT` can replace `--study-dir` and `--port`. A container image can be
built with the `Dockerfile` (`docker run -e ELECTROCLEAN_DEMO=1 -p 8000:8000 electroclean-web` for
the demonstration; mount the study folder at `/data/study` otherwise).

## The study folder

```
electroclean_study.json          the study's settings (the desktop application's study file)
server.sqlite                    accounts, sign-in tokens, assignments, visits, guided progress,
                                 quiz progress and the audit log
manifests/                       one file per registered recording
drafts/                          unfinished work
derivatives/electroclean_reference_sets/   training sets (their experts' annotations)
Annotated_Events/                the results, as written by the desktop application
    interaction_logs/            one log per visit
    training_progress/           stars, scores and times of each trainee
    training/<set>/quiz/         the short-segment quiz results
```

The admin area shows who has done what and downloads `Annotated_Events` as a zip; so do
`electroclean-web progress --study-dir <folder>` (each annotator's recordings and training stages;
`--json` gives the full report, the same as `GET /api/v1/admin/progress` for an administrator's
token) and `/api/v1/admin/results.zip`. Back up the whole folder.

Results are saved with the desktop application's journalled save, so a recording counts as done only
once its five files are written, read back and verified. When the server opens the study folder it
finishes or undoes any save that a power cut or a crash interrupted, as the desktop application does
when it starts: a save whose files were all written and verified is completed, anything else is
undone and its files kept in `Annotated_Events/.electroclean/interrupted/`. Each of these appears in
the audit log (by "server").

## Security

Passwords are kept as scrypt hashes and sign-in tokens as SHA-256 hashes. A token ends after 12 hours
without use and at sign-out. Every API request must carry the header `X-ElectroClean: 1`; only the
origins in `ELECTROCLEAN_ALLOWED_ORIGINS` (and the server's own) may call the API from a browser;
repeated failed sign-ins are refused for 15 minutes; requests are limited in number and size; and
errors never show technical details. The experts' annotations of the training sets never leave the
server: it checks each guided attempt and scores each practice recording itself, and reveals a
practice recording's reference only after that recording is saved.

## Data protection in brief

The study folder holds no EEG: the recordings stay on the annotators' computers. It holds the
annotators' IDs, names, email addresses (when given), notes and password hashes, their results,
drafts and quiz answers, the interaction logs (times, clicks, keys and what was on screen; never
typed text or passwords) and the audit log of the administrators' changes (which never holds a
password). Keep it on a computer and in backups that your data protection arrangements allow for
research data.
