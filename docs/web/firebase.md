# Running a study on Firebase

This guide sets up a real study of ElectroClean in the browser, step by step, for a study
administrator who is not a software developer. At the end, annotators open a link, sign in with an
email address and a password, open the recordings they were given on their own computer and
annotate them; the EEG never leaves their computer. Their results, training progress and
interaction logs are kept in your own Firebase project, in Google's London region, and one command
turns them into ElectroClean's usual folders for the agreement and activity analyses.

The pieces are Firebase Authentication (accounts), Firestore (the study's records), and
ElectroClean's Cloud Functions (the private work: matching a file to the study, checking and saving
annotations, the training coach and practice scores, so the experts' answers never reach a
browser). The application itself is published on GitHub Pages. You run ElectroClean's administrator
command, `electroclean-web`, on your own computer, where the recordings are.

Allow an afternoon for the first set-up. Steps 1 to 8 are done once per Firebase project; steps 9
to 14 once per study. After step 11, when your own administrator account exists, the study is run
from the **admin area** of the browser application (docs/web/admin.md): adding recordings, accounts,
assignments, reference sets, settings, the analyses and the results. The commands below remain an
alternative for each of these.

## What you need

A computer with Python 3.12 or 3.13 and Node.js 20 or later (Node.js provides the `npx` command
that runs Firebase's own tool), a Google account, a payment card for Firebase's pay-as-you-go plan,
and the recordings of the study.

## 1. Install the administrator's tools

Download ElectroClean (the repository, or its source archive) and, in a terminal in its folder:

```
python -m pip install -r requirements-web.txt
python -m pip install --no-deps -e .
electroclean-web --help
```

The last command lists everything `electroclean-web` can do. Every command used below also has its
own help, for example `electroclean-web add-user --help`.

## 2. Create the Firebase project

Open the [Firebase console](https://console.firebase.google.com/), choose **Create a project** and
give it a name. Firebase proposes a project ID (for example `my-eeg-study`); note it down, because
every command needs it. Google Analytics is not needed and can be switched off.

## 3. Choose the pay-as-you-go plan and set a budget alert

Cloud Functions need Firebase's **Blaze** plan. In the console, open the plan shown at the bottom of
the left-hand menu (or **Usage and billing**) and choose Blaze, with a billing account. Blaze keeps
the free allowances of the no-cost plan; a small study usually costs little or nothing, but set a
budget so that you hear about it if not: in the [Google Cloud console](https://console.cloud.google.com/billing),
open **Billing**, then **Budgets and alerts**, and create a budget for the project (for example
£10 a month) with email alerts at 50 %, 90 % and 100 %. A budget sends warnings; it does not stop
the project.

## 4. Create the Firestore database in London

In the Firebase console, open **Build**, then **Firestore Database**, and choose **Create
database**. For the location choose **europe-west2 (London)**; it cannot be changed later. Start in
**production mode**: ElectroClean's rules (step 8) deny every direct access from browsers anyway.

## 5. Turn on sign-in with email and password

Open **Build**, then **Authentication**, choose **Get started**, then **Sign-in method**, and
enable **Email/Password** (the first switch only; the passwordless email link is not used). Then,
under **Settings**, **Authorized domains**, add `faisalmushtaq.github.io`, the address the
application is published at.

## 6. Register the web application

Open **Project settings** (the cog beside Project overview), and under **Your apps** add a **Web**
app (the `</>` button) with any nickname; Firebase Hosting is not needed. Firebase shows a
`firebaseConfig` block with `apiKey`, `authDomain`, `projectId`, `appId` and a few more values.
Copy the block into a text file, for example `firebase-config.txt`; step 12 uses it. These values
identify the project to browsers and are not secret: what protects the study is that every request
goes through ElectroClean's functions, which check who is signed in.

## 7. A key for the administrator's command

`electroclean-web` works on the project with a service account key. In **Project settings**,
**Service accounts**, choose **Generate new private key** and save the file somewhere private
(not in a shared or synchronised folder). It gives full access to the project: keep it like a
password, and delete it from the console if it is ever lost. Then tell the command where it is,
in each terminal you use:

```
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/my-eeg-study-key.json          (macOS, Linux)
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\my-eeg-study-key.json"      (Windows PowerShell)
```

## 8. Deploy the rules and the functions

In the ElectroClean folder, sign in to Firebase's tool with your Google account, name your project,
and prepare the functions' own Python environment (Firebase reads it to find the functions):

```
npx firebase-tools login
cp .firebaserc.template .firebaserc            then replace YOUR-FIREBASE-PROJECT-ID in .firebaserc
python3.13 -m venv electroclean/web/firebase/functions/venv
electroclean/web/firebase/functions/venv/bin/python -m pip install -r electroclean/web/firebase/functions/requirements.txt
npx firebase-tools deploy --only functions,firestore
```

On Windows the environment's Python is `electroclean\web\firebase\functions\venv\Scripts\python`.
Before uploading, the deployment copies the ElectroClean code the functions need into their folder
(`scripts/vendor_functions.py`, which needs only Python itself). The first deployment takes several
minutes, because Google switches on the services the functions use; later ones are quicker. When it
ends, the console's **Functions** page lists seventeen functions whose names start with `ec_`, all in
europe-west2; `ec_admin`, which answers the admin area, has more memory and time than the others
for the analyses. Deploy again after updating ElectroClean (or use the GitHub workflow at the end of
this guide).

## 9. Create the study

One Firebase project can hold several studies. Give each an ID of letters, digits, dots, hyphens
or underscores:

```
electroclean-web init-study --firebase-project my-eeg-study --study pilot --name "Pilot study"
```

Settings that differ from ElectroClean's defaults (fixed display filters, the artifact types on the
number keys, how the next recording is chosen, interaction logging) are changed later in the admin
area. They can also be given as a JSON file with `--settings settings.json`, in the form of the
`settings` block of the desktop application's `electroclean_study.json`; `--update` changes them.

## 10. Create your own administrator account

Each person has an ID within the study (for example A01) and signs in with their email address.
Start with yourself as administrator:

```
electroclean-web add-user ADMIN --email you@example.ac.uk --admin --firebase-project my-eeg-study --study pilot
```

Without `--password` the command prints a link with which you choose your password (it works once;
run the command again for a new one). This is the one account that has to be made with the command:
once you can sign in to the admin area, it makes the others.

## 11. Set the study up in the admin area

Publish `config.json` first (step 12), then open the application, sign in with your administrator
account and choose the admin area (docs/web/admin.md explains each part). There you:

* **add the recordings**: choose the dataset folder on your computer. The browser reads each
  recording there, runs ElectroClean's checks and sends only what the study needs to show the
  recording and recognise the annotator's file (its checksum, timing, channels and events); no EEG
  is uploaded, and the study checks again everything it receives;
* **make the accounts**: give each person an ID, a name and the email address they sign in with.
  The admin area shows a link with which they choose their own password; send it to them. You can
  disable an account (it can no longer sign in, at once), give a new link, change a role, or remove
  someone from the study (their results and logs stay);
* **assign the work**: recordings to annotate, or a training programme;
* **build reference sets** for training and assessment: from an expert's saved annotations, an
  annotation file from the desktop application, a consensus of several experts or an adjudicator's
  final annotations, with their uses, the guided notes, the practice pass mark, the competency
  criteria and a short-segment quiz. *Add the example set* adds ElectroClean's simulated example set
  and gives you its recordings as a zip to pass on to trainees;
* **change the settings**, follow the **progress**, run the **agreement**, **activity** and
  **competency** analyses, download the **results** (up to 25 MB; larger studies use step 14) and
  read the **audit log** of every change, with who made it and when.

Each of these can also be done from the command line, and the audit log records those changes too
(by "command"). Registration from the command line opens every recording with the desktop
application's loader, on the computer that holds the recordings; training reference sets in the
dataset (`derivatives/electroclean_reference_sets/`) are stored too, with their experts'
annotations but without their recordings:

```
electroclean-web register /data/Pilot --firebase-project my-eeg-study --study pilot
electroclean-web create-example-set --firebase-project my-eeg-study --study pilot --recordings-to ./example-set
electroclean-web add-user A01 --email a01@example.ac.uk --name "Annotator one" --firebase-project my-eeg-study --study pilot
electroclean-web assign A01 --all --firebase-project my-eeg-study --study pilot
electroclean-web assign A02 --recordings sub-001/eeg/sub-001_task-rest_eeg.vhdr --firebase-project my-eeg-study --study pilot
electroclean-web assign T01 --programme example --firebase-project my-eeg-study --study pilot
```

`electroclean-web list --firebase-project my-eeg-study --study pilot` shows what the study holds.
When the computer with the recordings cannot reach the Internet, `export-manifests` writes the
registrations to a file and `import-manifests` stores them from another computer. To save typing,
set `ELECTROCLEAN_FIREBASE_PROJECT=my-eeg-study` and `ELECTROCLEAN_STUDY=pilot` in the terminal;
the options can then be left out.

The example set's recordings are simulated by ElectroClean itself. The Cloud Functions do not
include MNE-Python, so for them ElectroClean keeps the registrations of those recordings
(`electroclean/config/example_set_manifests.json`) and checks every file it makes against them
before adding the set; should they ever differ, the admin area says so and
`electroclean-web create-example-set` adds the set instead.

## 12. Tell the application about the project

The application reads a `config.json` beside it. Write it from the configuration you copied in
step 6:

```
electroclean-web config --firebase-project my-eeg-study --study pilot --web-config firebase-config.txt --out electroclean/web/static/config.json
```

Commit `electroclean/web/static/config.json` and push it. The GitHub Pages workflow
(`.github/workflows/pages.yml`) publishes the application with it on the repository's `gh-pages`
branch; the first time, in the repository's **Settings**, **Pages**, choose **Deploy from a
branch**, branch `gh-pages`, folder `/ (root)`. It is published from `main` at `https://faisalmushtaq.github.io/ElectroClean/`, and from the
browser version's branch at `https://faisalmushtaq.github.io/ElectroClean/preview/`. The study in
`config.json` is the default; a link can name another study of the same project with
`?study=<id>`.

## 13. Send the link and the recordings

Send each annotator the link (for example `https://faisalmushtaq.github.io/ElectroClean/?study=pilot`),
their password link from step 11, and their recordings, in the way your data protection
arrangements require (for example on an encrypted drive). In the application they sign in, see their
list, and open each recording from their own disk; ElectroClean checks that the file is the
registered one before they start, and keeps a draft of unfinished work.

Follow progress in the admin area, or with `electroclean-web progress --firebase-project my-eeg-study
--study pilot`, which lists each annotator's recordings (to do, in progress or done, with the time of
their last activity) and their training stages.

## 14. Export the results for the analyses

```
electroclean-web export --firebase-project my-eeg-study --study pilot --to ~/Pilot-results
electroclean-agreement ~/Pilot-results/Annotated_Events
electroclean-activity ~/Pilot-results/Annotated_Events
```

The export writes `Annotated_Events/` exactly as the desktop application does: per annotator and
recording the five result files (written by ElectroClean's own code when each recording was saved),
the completion register, the training progress, the competency reports, the quiz results and
`interaction_logs/`. The admin area's results zip holds the same files. Run it again whenever you like; it adds what is new and never replaces a file
with different contents.

## Deploying updates from GitHub (optional)

After the first deployment from your computer, later ones can run on GitHub. In the
[Google Cloud console](https://console.cloud.google.com/iam-admin/serviceaccounts), for the project,
create a service account for deployments and give it the roles **Cloud Functions Developer**,
**Service Account User**, **Firebase Rules Admin** and **Cloud Datastore Index Admin** (the roles
the [firebase-action](https://github.com/w9jds/firebase-action) documentation lists for these
deployments), then create a JSON key for it. In the GitHub repository, under **Settings**,
**Secrets and variables**, **Actions**, add the key as the secret `FIREBASE_SERVICE_ACCOUNT` and the
project ID as the variable `FIREBASE_PROJECT`. The workflow **Firebase deploy** (Actions tab, Run
workflow) then deploys the functions, the rules or both; without the secret it only explains what
is missing.

## Trying it without a Firebase project

`electroclean-web demo` runs the whole system on your computer with the ElectroClean server instead
of Firebase (docs/web/server.md). `scripts/test_firebase_emulators.sh` runs ElectroClean's tests of
the Firebase side on Google's Firebase Emulator Suite, which needs Java but no Firebase project.
`scripts/test_web_firebase.sh` goes further: on the same emulators it sets up a study with the
commands above, then drives the browser application in Chromium (signing in with an email address,
opening a recording from disk, saving it, guided training, a practice recording and its review) and
exports the results. To try the application by hand on the emulators, give `config.json` an
`"emulators"` entry beside the usual ones:
`"emulators": {"auth": "http://127.0.0.1:9099", "functions": "127.0.0.1:5001"}` (never in a
published `config.json`).

## Data protection in brief

Firestore holds, for each study: the registrations of the recordings (checksums, timing, channel
names, events; no EEG), the training sets' expert annotations, the annotators' IDs, names, email
addresses, roles and the administrators' notes about them, their drafts, their saved results,
training progress and quiz answers, the interaction logs (times, clicks, keys and what was on
screen; never typed text or passwords) and the audit log of the administrators' changes (which
never holds a password or a password link). Firebase Authentication holds each
person's email address and a hash of their password. Everything is in Google's London region, in a
project only you administer; browsers can read or write none of it directly. To end a study, export
the results, then delete its data in the console (Firestore, `studies/<id>`) and its users
(Authentication), or delete the whole project.
