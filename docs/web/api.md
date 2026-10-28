# ElectroClean web API (version 1)

The contract between the browser application and the server. All paths start
with `/api/v1`. Requests and responses are JSON (UTF-8). Times on the wire are
in **samples** of the recording where an annotation is concerned, and in
seconds elsewhere. Errors are `{"error": "<code>", "message": "<text for the
annotator>"}` with an HTTP status of 400, 401, 403, 404, 409 or 422 (and 413
for a request that is too large, 415 for one that is not JSON, 429 when there
are too many requests and 500 when the server failed; the message never holds
technical detail). Some errors add fields, named below.

Authentication is a bearer token: `POST /login` returns `"token"`, and every
other request except `GET /health` sends `Authorization: Bearer <token>`. The
browser keeps the token in memory and in `sessionStorage` (never in
`localStorage`), so it ends with the browser tab. Tokens expire after 12 hours
without use and on `POST /logout`. Every request except `GET /health` also
carries the header `X-ElectroClean: 1`.

The application is usually served from GitHub Pages
(`https://<owner>.github.io/<repo>/…`) while the server runs elsewhere, so the
server answers CORS requests from the origins listed in its setting
`ELECTROCLEAN_ALLOWED_ORIGINS` (comma-separated; the demo and local servers
also allow the origin they serve the application from), allowing the
`Authorization`, `Content-Type` and `X-ElectroClean` headers and no cookies.
When the server also serves the application itself (same origin), the same
token scheme is used, and the server answers `GET /config.json` (outside
`/api/v1`) with `{"server": "<its own address>", "study": "<study id>"}`, so the
application it serves uses it whatever `config.json` was published with the
application. Preflight requests asking `Access-Control-Request-Private-Network`
(the application on GitHub Pages calling a server on the same computer) are
allowed for the allowed origins.

## Shared shapes

```jsonc
Annotation = {
  "annotation_id": "8f2c…",          // 1 to 64 letters, digits, "_" or "-" (the browser makes a hex ID)
  "label": "Eye-blink-artifact",      // a label of the catalogue
  "onset_sample": 768,                // integer, from the first sample of the recording
  "duration_samples": 102,            // integer >= annotation.min_duration_samples
  "channels": ["Fp1", "Fp2"],         // [] means the whole montage
  "created_at": "2026-10-28T10:15:02.120+00:00",
  "modified_at": "2026-10-28T10:15:09.004+00:00"
}

Manifest = {                          // what the browser needs to show a registered recording
  "recording_id": "sub-001/eeg/sub-001_task-rest_eeg.edf",
  "file_name": "sub-001_task-rest_eeg.edf",   // the file the annotator should open
  "format": "edf",
  "sfreq": 256.0, "n_samples": 15360, "duration_s": 60.0,
  "ch_names": ["Fp1", "Fp2", "…"],            // the montage, in display order (hidden channels left out)
  "hidden_channels": ["COUNTER", "Status"],    // in the file but not shown or annotated
  "channel_types": {"Fp1": "eeg", "HEOG": "eog", "ECG": "ecg"},
  "bad_channels": ["T7"],                      // from channels.tsv; shown greyed
  "original_events": [{"onset_sample": 512, "duration_samples": 0, "label": "stimulus/1"}],
  "gaps": [[14000, 15360]],                    // no recorded data: hatched, nothing to annotate
  "display": {"scalings": {"eeg": 5e-05, "eog": 0.00015, "ecg": 0.0005}, "warnings": ["…"]},
  "fingerprint": {"algorithm": "sha256", "role": "eeg", "hex": "…", "size_bytes": 123456}
}

Draft = {"annotations": [Annotation], "view": {"start_s": 12.0, "duration_s": 10.0, "first_channel": 0,
         "n_channels": 32, "scale_factor": 1.0}, "elapsed_s": 312.4, "saved_at": "…"}
```

## Signing in

`GET /health` → `{"ok": true, "version": "1.1.0", "study": "<name>", "demo": false}` (no authentication; CORS open to any origin, so the application can check an address before signing in).

`POST /login` `{"annotator_id": "A01", "password": "…"}` →
`{"token": "…", "expires_in_s": 43200, "annotator_id": "A01", "display_name": "…", "role": "annotator" | "admin"}`
(401 `bad_credentials` otherwise; after 10 unsuccessful attempts for one ID, or
50 from one address, in 15 minutes, 429 `too_many_attempts`). IDs are not
case-sensitive. `POST /logout` → `{}`. A request with a missing or expired
token gets 401 `not_signed_in`; one without the header, 403 `missing_header`.

`GET /me` →

```jsonc
{
  "annotator_id": "A01", "display_name": "", "role": "annotator",
  "study": {
    "study_id": "…", "name": "…",
    "filters": {"highpass_enabled": true, "highpass_hz": 1.0, "notch_enabled": true, "notch_hz": 50.0,
                "notch_harmonics": false, "locked": false},
    "display": {"duration_s": 10.0, "n_channels": 32, "scalings": {"eeg": 5e-05, "…": 0.0}},
    "annotation": {"min_duration_samples": 1, "quick_labels": ["Eye-blink-artifact", "…"]},
    "logging": {"interactions": true, "pointer_hz": 5, "idle_after_s": 30},
    "logging_notice": "This study records how you use ElectroClean …"   // "" when logging is off
  },
  "catalogue": {"labels": [{"label": "Eye-blink-artifact", "value": 103, "short_code": "BLINK",
                             "colour": "#0067A5", "section": "Eye", "is_group": false,
                             "parent": "Eye-artifact" | null, "description": "…"}]},
  "programme": null | {"set_id": "example", "name": "…"}            // when the annotator is in a training programme
}
```

## Assignments and opening a recording

`GET /assignments` →
`{"items": [{"recording_id", "file_name", "format", "mode": "standard" | "guided" | "practice" | "assessment",
"context_id": "" | "<reference set>", "status": "todo" | "in_progress" | "done", "duration_s",
"n_channels", "size_bytes", "repeat": false}], "next": "<recording_id>" | null,
"next_item": {"recording_id", "mode", "context_id"} | null}`. `next` is the
recording to do next: unfinished work first, then the training programme's
next step, then the study's selection strategy (`manual`: the assignment order;
`seeded`: ElectroClean's seeded order; `random`: a random choice that stays the
same until something more is completed). `next_item` says in which mode and
context. A trainee's list holds the recordings of the programme's unlocked
stages. `repeat` is true for a practice recording the programme lets the
trainee annotate again (its `status` is then `todo`).

`POST /match` `{"file_name", "size_bytes", "format", "sha256": "<hex>", "sfreq", "n_samples", "ch_names": [...]}` →

```jsonc
{
  "status": "matched" | "matched_metadata" | "unknown" | "not_assigned" | "done",
  "message": "…",                       // for the annotator; always present
  "recording_id": "…" | null, "mode": "standard", "context_id": "",
  "manifest": Manifest | null,          // present for matched and matched_metadata
  "draft": Draft | null,                // unfinished work to continue, if any
  "differences": ["…"],                 // matched_metadata: how the file differs from the study's copy
  "repeat": false                       // a practice recording being annotated again
}
```

`matched`: the SHA-256 and size match a registered recording assigned to this
annotator. `matched_metadata`: no fingerprint match, but name, sampling rate,
number of samples and channels match one recording; the browser shows the
differences and asks whether to continue. `unknown`: not a recording of the
study. `not_assigned`: a study recording, but not for this annotator now.
`done`: already completed by this annotator (in this mode and context).
`sha256` and `size_bytes` are required (400 `bad_request` otherwise); the other
fields are needed only for `matched_metadata`.

`PUT /drafts/{recording_id}?mode=&context=` `Draft` → `{"saved_at": "…"}`.
The browser sends a draft at most every 30 s while there are changes and when
the page is hidden. `DELETE` the same path discards it. Drafts of more than
8 MB are refused (413 `too_large`).

## Saving

`POST /submissions`

```jsonc
{
  "recording_id": "…", "mode": "standard", "context_id": "",
  "annotations": [Annotation],
  "session": {"started_at": "…", "elapsed_s": 912.3, "visit_id": "…",
              "filters": {"highpass_hz": 1.0, "notch_hz": 50.0, "notch_harmonics": false, "method": "fir"},
              "view": Draft.view,
              "client": {"user_agent": "…", "screen": {"width": 1920, "height": 1080, "pixel_ratio": 2}}},
  "sha256": "<hex of the file that was annotated>"
}
```

`session.filters` gives the display filters used (`highpass_hz` or `notch_hz`
null when that filter was off); when the study fixes the filters, the study's
are recorded.

→ `{"saved": true, "files": ["…_annotations.json", "…_events.tsv", "…"], "attempt": 1,
"feedback": PracticeFeedback | null, "guided": GuidedSaved | null, "assessment": AssessmentSaved | null,
"next": "<recording_id>" | null}`. The server validates every annotation against
the catalogue and the manifest (422 `invalid_annotation` with the reason),
refuses a second completion (409 `already_done`), refuses a training recording
whose stage is still locked (403 `locked`) and writes the outputs with
ElectroClean's export code, then discards the draft. A guided recording is
saved only when every step still matches and nothing extra is marked (422
`guided_incomplete`, with `step` when a step no longer matches; that step is
then the current one again). When the file's checksum differs from the
registered one (`matched_metadata`), the outputs are saved with a warning that
says so. 409 `busy` means the same recording is being saved by another request.

`GuidedSaved = {"summary": {"steps", "stars", "max_stars", "attempts", "failed_attempts", "shown", "time_s"},
"message": "Recording saved: 14 of 18 stars (4.2 min)."}`.

`AssessmentSaved = {"complete": false, "done": 1, "total": 3, "message": "…"}` until every assessment
recording is saved, then `{"complete": true, "done", "total", "status": "met" | "not_met" | "not_determined",
"status_text": "…", "summary_html": "…", "message": "…"}` (the competency result; the
full report stays with the administrator).

`PracticeFeedback` (practice mode only):
`{"passed": true, "pass_rule": "80% for finding the artifacts and for their types", "rule": {"event_f1", "label_accuracy"},
"score": {"event_f1", "label_accuracy"}, "metrics": {"event_f1", "event_recall", "event_precision", "label_accuracy",
"mean_iou", "mean_channel_jaccard", …}, "per_category": [{"category", "reference_events", "your_events", "found",
"event_f1", …}], "summary_html": "…", "review": true,
"flags": [{"kind": "MISSED" | "EXTRA" | "TYPE", "label", "your_label", "onset_sample",
"duration_samples", "channels", "annotation_id", "source": "reference" | "yours", "onset_s", "offset_s",
"text": "Missed: Eye-blink-artifact, 4.00–4.40 s"}], "reference": [Annotation]}`.
For MISSED the flag describes the experts' annotation (`your_label` null); for
EXTRA and TYPE the annotator's own (`label` is the experts' type for TYPE). The
reference is revealed only for practice recordings, after they are saved, and
only when the reference set allows the review (`review`; otherwise `flags` and
`reference` are empty). Numbers that cannot be computed are null.

## Training programme

`GET /training` → `{"set_id", "name", "description", "stages": [{"key": "guided" | "practice" | "assessment",
"title", "description", "status": "locked" | "available" | "in_progress" | "completed" | "not_used", "done", "total",
"stars", "max_stars", "best_score", "time_s", "detail"}], "next": {"stage", "recording_id", "label", "text", "mode",
"context_id", "file_name", "repeat"} | null, "complete": false, "message": "…"}` (404 `no_programme` for an
annotator outside a programme).

`GET /training/guided/{recording_id}` → `{"recording_id", "context_id", "n_steps", "guidance": "show" | "find" |
"find_unnamed", "tolerance": {"seconds", "fraction", "channel_jaccard"}, "completed": [{"step", "stars",
"annotation_id"}], "current": Step | null, "complete": false, "summary": … | null, "empty_message": "…" | null}`
where
`Step = {"step": 3, "n_steps": 6, "guidance": "show", "instruction": "Mark this Eye-blink-artifact",
"text": "The experts' annotation is outlined with a dashed line. …", "label": "Eye-blink-artifact" | null,
"description": "…", "note": "…" | null, "ghost": {"onset_sample", "duration_samples", "channels"} | null,
"view": {"start_s", "duration_s"} | null}`. The label is null for `find_unnamed`,
the ghost only present for `show`, the view absent for `find_unnamed`. Where a
trainee is in a guided recording is kept by the server, so it survives a reload
or another computer. A recording without expert annotations has `n_steps` 0 and
is complete at once (`empty_message` says so).

`POST /training/guided/{recording_id}/check` `{"step": 3, "annotations": [Annotation]}` →
`{"matched": false, "candidate_id": "…" | null, "problems": ["missing" | "type" | "start" | "end" | "scope" |
"channels" | "extra"], "messages": ["Almost: the start is 0.24 s too early …"], "extras": ["<annotation_id>"],
"can_continue": false, "stars": null, "failed_attempts": 1, "deltas": {"start_s", "end_s", "allowed_s", "iou",
"channel_jaccard"}}`. `annotations` are all the trainee's annotations. A check
counts as a failed attempt when the annotations changed since the last check
and the attempt does not match. `stars` are those the step would earn, given
when `can_continue` is true. For `find_unnamed`, a match adds `"found": {"label",
"description", "note"}`. A check of another step than the current one gets 409
`wrong_step` (with `current_step`); after the last step, a check only reports
extras (`"complete": true`). When `can_continue` is true,
`POST …/continue {"step": 3}` records the step (stars from failed checks and
Show me) and returns the next `Step` with `"previous": {"step", "stars",
"attempts", "failed_attempts", "used_show_me", "seconds"}`, or `{"complete": true,
"summary": {"steps", "stars", "max_stars", "attempts", "failed_attempts", "shown", "time_s"}, "previous",
"message"}` (409 `not_matched` if the last check of that step did not allow it).

`POST /training/guided/{recording_id}/show-me` `{"step": 3, "annotations": [Annotation]}` →
`{"ghost": {...}, "annotation": Annotation, "replace": ["<annotation_id>"], "view": {"start_s", "duration_s"},
"stars": 1}` (the experts' annotation to place, with a new ID; `replace` lists
the trainee's attempts at this step to remove first, when `annotations` were
sent; the step then gives at most one star).

## Interaction logs

`POST /visits` `{"client": {...}, "programme": false, "mode": "standard", "context_id": ""}` → `{"visit_id": "…",
"logging": {"interactions": true, "pointer_hz": 5, "idle_after_s": 30}}` (the
server opens the visit's log, `interaction_logs/annotator-<ID>/<time>_<mode>.jsonl`,
with the same header as the desktop application plus `"client": "web"` and
`"browser"`, the client object; `mode` and `context_id` are optional, and with
`"programme": true` the visit is the trainee's programme). When the study does
not record interactions, `visit_id` is null and nothing is logged. The server
writes the `visit_started` event itself (with `t` 0).

`POST /visits/{visit_id}/events` `{"events": [{"t": 12.31, "wall": "…", "type": "mouse_press", ...}]}` →
`{"received": 3, "skipped": 0}`. Events are appended in order; the server adds
`seq`. An event needs a `type` (lower case letters, digits and `_`) and a `t`
(seconds since the visit started); others are skipped. Fields named `password`
or `token` are dropped. At most 2000 events per batch. The browser sends a batch
every few seconds and with `navigator.sendBeacon` when the page is hidden:
sendBeacon cannot set headers, so for these two paths the server also accepts a
`text/plain` body holding the JSON with `"token"` added (no `Authorization` and
no `X-ElectroClean` needed). `POST /visits/{visit_id}/close` `{"reason": "…"}` →
`{}` (writes `log_closed`; closing twice does nothing). A closed visit refuses
events (409 `visit_closed`); another annotator's visit is 404 `unknown_visit`.

## Administration

`GET /admin/progress` (role admin, 403 `forbidden` otherwise) →
`{"study", "generated_at", "annotators": [{"annotator_id", "display_name", "role", "last_seen",
"items": [{"recording_id", "mode", "context_id", "status", "attempts", "last_activity"}],
"programme": <GET /training> | null}]}`. `GET /admin/results.zip` → the study's
results folder (`Annotated_Events`, with `interaction_logs`, `training_progress`
and the competency reports). Recordings, accounts and
assignments are managed with the `electroclean-web` command (see
docs/web/server.md and docs/web/firebase.md); registering recordings needs the
real files and runs where they are, producing manifests that are stored in the
study (or written to a file with `export-manifests` and imported where the study is).

## The same operations on Firebase

On Firebase every operation above is a callable Cloud Function (Python, 2nd
generation, region europe-west2) taking and returning the same JSON:
`ec_me`, `ec_assignments`, `ec_match`, `ec_put_draft`, `ec_delete_draft`,
`ec_submit`, `ec_training`, `ec_guided_get`, `ec_guided_check`,
`ec_guided_continue`, `ec_guided_show_me`, `ec_visit_open`, `ec_visit_events`,
`ec_visit_close` and, for administrators, `ec_admin_progress`. Each takes
`{"study": "<study id>", ...the request body...}` (path parameters such as the
recording ID become fields). Signing in uses Firebase Authentication (email and
password) in the browser; the annotator ID and role are custom claims set by the
administrator's command, and the functions read them from the caller's ID
token. Errors are raised as `HttpsError` with the same `error` code in
`details` and the `message` for the annotator. Clients never read or write
Firestore directly, except as the security rules allow (nothing, by default):
every read and write goes through the functions.

The fields of each call:

| function | data (besides `study`) |
| --- | --- |
| `ec_me`, `ec_assignments`, `ec_training`, `ec_admin_progress` | none |
| `ec_match` | the body of `POST /match` |
| `ec_put_draft` | `{"recording_id", "mode", "context_id", "draft": Draft}` |
| `ec_delete_draft` | `{"recording_id", "mode", "context_id"}` |
| `ec_submit` | the body of `POST /submissions` |
| `ec_guided_get` | `{"recording_id"}` |
| `ec_guided_check`, `ec_guided_continue`, `ec_guided_show_me` | `{"recording_id", ...the body of the request}` |
| `ec_visit_open` | the body of `POST /visits` |
| `ec_visit_events`, `ec_visit_close` | `{"visit_id", ...the body of the request}` |

There is no `token` and no beacon on Firebase: the Firebase SDK adds the ID
token; to send the last events when the page is hidden, call `ec_visit_events`
with `fetch(…, {keepalive: true})` or simply on the next visit. The results are
not downloaded through a function: the administrator exports them with
`electroclean-web export` (docs/web/firebase.md).

The HTTP status of an error becomes the `HttpsError` code: 400 and 413
`invalid-argument`, 401 `unauthenticated`, 403 `permission-denied`, 404
`not-found`, 409 `already-exists`, 422 `failed-precondition`, 429
`resource-exhausted`, 500 `internal`. `details` is the error body
(`{"error": "<code>", "message": "…", …}`). A caller whose claims do not name
the study, or who has no account in it, gets `permission-denied` with error
`not_in_study`.

The custom claims are `{"annotator_id": "A01", "role": "annotator", "roles": {"<study>": "annotator" | "admin"},
"studies": ["<study>"]}`; a person keeps one annotator ID in every study of a
project. A caller counts as an administrator only when both the claims and
their account in the study say so.

The application learns about the Firebase project from `config.json` beside
it, which `electroclean-web config` writes:
`{"firebase": {"apiKey", "authDomain", "projectId", "appId", …}, "study": "<study id>",
"functions_region": "europe-west2"}`.
