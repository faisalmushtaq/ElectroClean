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
  "programme": null | {"set_id": "example", "name": "…"},           // when the annotator is in a training programme
  "quizzes": [{"set_id": "example", "name": "…", "n_items": 4, "finished": false, "feedback": "immediate"}]
}
```

`quizzes` lists the short-segment quizzes the annotator may take (see "The
short-segment quiz" below); `logging_notice` is the study's own notice when the
administrator has written one.

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
  "session": {"started_at": "…", "elapsed_s": 912.3, "visit_id": "…", "session_id": "<32 hex>",
              "filters": {"highpass_hz": 1.0, "notch_hz": 50.0, "notch_harmonics": false, "method": "fir"},
              "view": Draft.view,
              "client": {"user_agent": "…", "screen": {"width": 1920, "height": 1080, "pixel_ratio": 2}}},
  "sha256": "<hex of the file that was annotated>"
}
```

`session.filters` gives the display filters used (`highpass_hz` or `notch_hz`
null when that filter was off); when the study fixes the filters, the study's
are recorded. `session.session_id` (optional, 32 hexadecimal characters, 400
`bad_request` otherwise) is the browser's ID of the annotation session, the one
its interaction log events carry: the saved `_session.json`, the
`_annotations.json`, the completion register and the session log then use it as
the session's ID, so the logs and the results link up as they do for the
desktop application. Without it, or when a saved result of the annotator
already has that ID, the server makes one.

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

Lead researchers (accounts with the role `admin`) run the study from the
**admin area** of the browser application. Every administrative operation is
`POST /admin/{op}` with a JSON body (403 `forbidden` for anyone else, 404
`not_found` for an `op` the server does not offer, as an older server answers;
the admin area then says the operation is not offered yet) and, on Firebase,
the one callable function `ec_admin` with `{"study", "op", ...the body}`; in the
service layer it is `StudyService.admin(op, user, body)`
(`electroclean/web/admin.py`), so the ElectroClean server and Firebase behave
the same. Every operation that changes something appends an entry to the
study's **audit log** (below), as do the `electroclean-web` commands that
change the study (`"by": "command"`). `GET /admin/progress` and
`GET /admin/results.zip` remain as before. Each administrative call reads the
study afresh, so a change made through one Firebase instance is seen by the
next call whichever instance answers it.

The EEG never reaches the study: an administrator adds recordings by choosing
them on their own computer, the browser reads them and builds each
recording's manifest (`js/data/register.js`), and only the manifests are sent
(`recordings_register`). The `electroclean-web register` command remains for
registering from the command line.

### Shapes

```jsonc
AuditEntry = {"at": "2026-10-28T10:15:02.120+00:00", "by": "ADMIN", "op": "user_add",
              "summary": "Added A03 (Annotator three) as an annotator", "details": {...}}
UserRecord = {"annotator_id": "A03", "display_name": "Annotator three", "email": "a03@example.org" | null,
              "role": "annotator" | "admin", "status": "active" | "disabled", "created_at": "…",
              "last_seen": "…" | null, "notes": "", "assigned": 12, "done": 4, "programme": "<set_id>" | null}
RecordingRecord = {"scope": "study" | "set:<set_id>", "recording_id": "sub-001/eeg/sub-001_task-rest_eeg.vhdr",
              "file_name", "format", "sfreq", "n_samples", "duration_s", "n_channels", "size_bytes",
              "sha256", "registered_at", "registered_by", "registered_via": "browser" | "command",
              "notes": "", "retired": false, "assigned": 3, "done": 1, "warnings": ["…"]}
SetRecord = {"set_id", "name", "description", "created_at", "created_by",
              "practice_review": true, "allowed_annotators": [] /* empty: everyone */,
              "practice_pass": {"event_f1": 0.8, "label_accuracy": 0.8},
              "guided_tolerance": {"seconds": 0.2, "fraction": 0.2, "channel_jaccard": 0.75, "accepted_labels": {}},
              "criteria": CompetencyCriteria /* electroclean.training.assessment, to_dict() */,
              "recordings": [{"recording_id", "use": "guided" | "practice" | "assessment",
                              "guidance": "auto" | "show" | "find" | "find_unnamed",
                              "effective_guidance": "show" | null /* guided recordings only */,
                              "provenance": {...}, "n_reference_events": 7, "registered": true}],
              "quiz_items": 0, "quiz": {"include_none_option": false, "feedback": "immediate" | "end"},
              "self_contained": true, "scope": "set:<set_id>" | "study",
              "provenance": {"method", "experts", "notes"} /* as declared when the set was created */,
              "show_full_report_to_annotator": false}
```

`registered_by` is the administrator's ID, or `command` for recordings registered
with `electroclean-web`. A set made in the admin area is self-contained: its
recordings are registered in its own scope `set:<set_id>`, so they are never
offered for study annotation. Sets registered from a dataset that refer to the
study's own recordings have `"self_contained": false` and `"scope": "study"`.

### Operations

| op | body | answer |
| --- | --- | --- |
| `overview` | `{}` | `{"study": {"study_id", "name"}, "counts": {"recordings", "annotators", "admins", "assignments", "done", "in_progress", "todo"}, "recent": [AuditEntry], "last_saved": [{"annotator_id", "recording_id", "mode", "context_id", "at"}]}` (ten of each; `recordings` counts the study's own, the others the active accounts and their work) |
| `settings_get` | `{}` | `{"name", "settings": {"filters", "display", "channels", "selection", "logging", "annotation", "loading", "discovery"}, "logging_notice", "logging_notice_is_default"}`: the effective values of the blocks of `electroclean_study.json` that a study may change |
| `settings_update` | `{"name"?, "settings"?: {block: {key: value}}, "logging_notice"?}` | as `settings_get`. Each key given replaces that setting; the result is checked with ElectroClean's own settings code and refused with 400 `invalid_settings` and the reason (also for a block or key that cannot be changed). `"logging_notice": ""` goes back to ElectroClean's own notice |
| `users_list` | `{}` | `{"users": [UserRecord]}` (disabled accounts too) |
| `user_add` | `{"annotator_id", "display_name"?, "email"?, "role"?: "annotator", "password"?}` | `{"user": UserRecord, "invite_link": str \| null, "temporary_password": str \| null}`. On Firebase `email` is required (400 `email_required`), the Firebase Authentication user is created (or, for a person already in another study of the project, given this study) with the custom claims below, and `invite_link` lets the person choose a password when none is given. On the server a temporary password (three groups of four characters) is made when none is given. A password has 8 to 200 characters. 409 `user_exists`, 409 `email_in_use` |
| `user_update` | `{"annotator_id", "display_name"?, "role"?, "status"?, "notes"?}` | `{"user": UserRecord}`; 404 `unknown_user`. Disabling ends the person's sessions at once and stops them signing in; on Firebase the role is also written into their claims. An administrator cannot demote or disable themselves (409 `self`) |
| `user_reset_password` | `{"annotator_id"}` | `{"invite_link" \| null, "temporary_password" \| null}`: a new password link (Firebase) or a new temporary password (the server, which also ends every session of the account) |
| `user_remove` | `{"annotator_id"}` | `{}`: the account leaves the study with its assignments, programme, drafts and guided progress; its results and logs stay; not oneself (409 `self`). On Firebase the study is taken out of the person's claims, and a Firebase user who takes part in no other study is deleted |
| `assignments_list` | `{"annotator_id"?}` | `{"items": [{"annotator_id", "recording_id", "mode", "context_id", "status", "attempts", "last_activity"}]}` (what each person is given, the training programme's recordings included) |
| `assign` | `{"annotator_ids": [..], "recording_ids": [..] \| "all": true, "mode"?: "standard", "context_id"?}` | `{"added", "already", "retired"}`: retired recordings are skipped and counted in `retired`. 404 `unknown_user`, 404 `unknown_recording` (not registered in the scope of that mode and set), 400 `not_in_set` (a training recording outside the set), 409 `not_allowed` (the set names its allowed annotators and this person is not one) |
| `unassign` | `{"annotator_id", "recording_id", "mode"?, "context_id"?}` | `{}`; 409 `done` for a completed item, 404 `not_assigned` |
| `programme_set` | `{"annotator_id", "set_id": str \| null}` | `{}`; 404 `no_reference_set`, 409 `not_allowed` |
| `recordings_list` | `{"scope"?}` | `{"recordings": [RecordingRecord]}` (every scope when none is given) |
| `recordings_register` | `{"scope": "study" \| "set:<id>", "manifests": [Manifest], "replace"?: false}` | `{"added": [recording_id], "replaced": [..], "skipped": [{"recording_id", "reason"}]}`. `Manifest` is the internal manifest of `electroclean/web/manifest.py` (`schema` `electroclean.web_manifest`) as the browser builds it; the server checks it (below), stores it with `registered_via` `browser`, keeps the notes and retirement of a recording registered again, and never replaces a recording that has results unless the fingerprint is the same. At most 500 manifests per call (413 `too_large`); a set scope must be a self-contained set's |
| `recording_update` | `{"scope", "recording_id", "notes"?, "retired"?}` | `{"recording": RecordingRecord}`; a retired recording is offered for no new assignments; 404 `unknown_recording` |
| `recording_remove` | `{"scope", "recording_id"}` | `{}`; 409 `has_results` when anyone saved it or a reference set uses it (as a reference or in a quiz item). Its unfinished assignments go with it |
| `sets_list` | `{}` | `{"sets": [SetRecord]}` |
| `set_create` | `{"set_id", "name"?, "description"?, "method"?: "single_expert", "experts"?: [..], "notes"?}` | `{"set": SetRecord}`; a self-contained set; `method`, `experts` and `notes` are the provenance declared for the set, as `electroclean-admin create-reference-set` records it; 409 `set_exists` |
| `set_update` | `{"set_id", "name"?, "description"?, "practice_review"?, "allowed_annotators"?, "practice_pass"?, "guided_tolerance"?, "criteria"?, "quiz"?: {"include_none_option"?, "feedback"?}, "show_full_report_to_annotator"?}` | `{"set": SetRecord}`. `practice_pass` and `guided_tolerance` change only the keys given; `criteria` is the whole `CompetencyCriteria`. Values ElectroClean refuses give 400 `invalid_set` with the reason |
| `set_delete` | `{"set_id"}` | `{}`; 409 `in_use` when trainees have results in it, are enrolled in it or have finished its quiz. Its recordings (scope `set:<id>`) and assignments go with it |
| `set_add_reference` | `{"set_id", "recording_id", "recording_scope"?: "study" \| "set:<id>", "use", "source": Source, "provenance"?: {"notes"}}` | `{"set": SetRecord, "disagreements": [row] \| null}`; a study recording is copied into the set's scope, so training recordings are never offered for study annotation. The reference must fit the recording (sampling rate, length, channels, labels: 422 `invalid_document`); 404 `no_saved_annotations` when a source's annotations were never saved; 409 `conflict` when the set holds another recording of that name |
| `set_recording_update` | `{"set_id", "recording_id", "use"?, "guidance"?: "auto" \| "show" \| "find" \| "find_unnamed"}` | `{"set": SetRecord, "warnings": [".."]}` (for example when trainees have already done a recording now used for assessment); 404 `not_in_set` |
| `set_remove_recording` | `{"set_id", "recording_id"}` | `{"set": SetRecord}` (the recording stays registered in the set's scope); 404 `not_in_set` |
| `set_guided_notes` | `{"set_id", "recording_id"}` | `{"notes": [{"annotation_id", "label", "onset_s", "offset_s", "note"}]}` (every reference annotation of the recording, with its note or "") |
| `set_guided_note` | `{"set_id", "annotation_id", "text"}` | `{}` ("" removes the note); 404 `unknown_annotation` |
| `set_example_create` | `{}` | `{"set": SetRecord, "recordings_zip": {"file_name", "base64", "size_bytes"}}` (the simulated recordings to give trainees, about 4.6 MB); 409 `set_exists`; 422 `example_unavailable` (see below) |
| `quiz_items` | `{"set_id"}` | `{"items": [QuizItem]}` (`electroclean.training.reference.QuizItem.to_dict()`) |
| `quiz_item_add` | `{"set_id", "recording_id", "start_s", "end_s", "correct_label", "accepted_labels"?, "explanation"?, "context_s"?: 2.0, "item_id"?}` | `{"item": QuizItem}`. The recording must be registered in the set's scope (404 `unknown_recording`); the segment lies within it; the labels are the catalogue's, or "No artifact / none of these" when the set offers it (`quiz.include_none_option`). Without `item_id` the next free `q01`, `q02` … is used; an existing `item_id` is replaced |
| `quiz_item_remove` | `{"set_id", "item_id"}` | `{}`; 404 `unknown_item` |
| `progress` | `{}` | as `GET /admin/progress` |
| `agreement` | `{"annotator_ids"?, "recording_ids"?, "modes"?: ["standard"], "config"?: {..AnalysisConfig fields..}}` | `{"summary": {"n_recordings", "n_comparable_recordings", "annotators", "config", "key_results": [..]}, "report_html": str, "tables": {"<name>.tsv": str}, "warnings": [..]}`, computed on demand with `electroclean.reliability` (the files of `electroclean-agreement`). Annotators and modes are chosen with `annotator_ids` and `modes`, not in `config`; settings it refuses give 400 `invalid_config`; 422 `not_enough` when no recording has two annotators. When the tables would exceed 12 MB, `events_matched.tsv` and `events_unmatched.tsv` are left out with a warning |
| `activity` | `{"annotator_ids"?}` | `{"report_html": str, "tables": {"visits.tsv": str, "recordings.tsv": str}}`, with `electroclean.activity`; 422 `no_logs` when there are no interaction logs |
| `competency` | `{"set_id", "annotator_id"}` | `{"report": {..}, "html": str}` (`competency_report`, made again and kept, and `competency_html`); 404 `not_complete` until every assessment recording is saved (also for a set without assessment recordings) |
| `results_zip` | `{}` | `{"file_name", "base64", "size_bytes"}`: the results folder as `GET /admin/results.zip` gives it, quiz results included; 413 `too_large` (with `size_bytes`) above 25,000,000 bytes (use `electroclean-web export`) |
| `audit` | `{"before"?: str, "limit"?: 50}` | `{"entries": [AuditEntry], "next": str \| null}`, newest first; `before` is the `next` of the page before (400 `bad_request` otherwise); `limit` 1 to 500 |
| `visits` | `{"annotator_id"?, "limit"?: 100}` | `{"visits": [{"visit_id", "annotator_id", "mode", "context_id", "started_at", "closed_at", "n_events"}]}`, newest first; `limit` 1 to 1000 |

Mistakes in a body (a missing or malformed field) are 400 `bad_request` with a
message that names the field. On Firebase, an operation that needs Firebase
Authentication where it is not available answers 503 `auth_unavailable`.

`Source`, where a reference comes from:

```jsonc
{"kind": "annotator", "annotator_id": "E1", "mode": "standard", "context_id": ""}   // that person's saved annotations of the recording
{"kind": "document", "document": {...}}          // an _annotations.json (for example from the desktop application)
{"kind": "consensus", "annotator_ids": ["E1", "E2", "E3"], "min_agreement": null, "merge_gap_s": 0.0, "min_duration_s": 0.0}
{"kind": "adjudicated", "adjudicator_id": "E4", "expert_ids": ["E1", "E2", "E3"]}
```

`mode` and `context_id` (standard and "" when left out) say which saved
annotations are meant, for every kind except `document`; the latest saved
attempt is used. Consensus uses `electroclean.training.consensus.build_consensus`
and returns its disagreement rows (`{"kind": "time" | "channels", "label",
"onset_s", "offset_s", "experts_marking", "experts_not_marking", "note"}`;
422 `invalid_consensus` when it cannot be built); it needs at least two
annotators. An adjudicated reference names at least two experts. The reference
is stored with the desktop's own code (`ReferenceSet.add_reference`), so its
provenance is recorded as in the desktop's reference sets: the method, the
experts, the adjudicator, copies of the source files (the saved
`_annotations.json` of each person, or the uploaded document) with their
checksums, the time, the consensus rule and the administrator's notes. An
uploaded document must use a label catalogue compatible with the study's
(422 `invalid_document`); its recording ID is replaced by the set's.

**The checks of a manifest.** `recordings_register` stores only manifests that
pass `electroclean/web/manifest_check.py`, and keeps only the fields ElectroClean
knows. A manifest is refused, with a reason in `skipped`, unless: `schema` is
`electroclean.web_manifest` and `schema_version` has major version 1; it is
at most 2 MB of JSON with finite numbers; `recording_id` is a relative path
with forward slashes and no empty, `.` or `..` parts, ending with one of the
study's `discovery.suffixes` and with the extension of its `format`
(`brainvision` .vhdr, `edf` .edf, `bdf` .bdf); `file_name` is its last part,
`files.path` the recording ID itself, and every other path (`files.*`,
`fingerprint.*.path`, `original_events.path`) relative in the same way;
`scope` (when given) is the call's; `fingerprint` names only the roles of
`RecordingFiles.source_files` (`vhdr`, `eeg`, `vmrk`, `channels_tsv`,
`events_tsv`, `events_json`, `eeg_json`, and `events_json_inherited_<n>`,
`eeg_json_inherited_<n>`), each with a 64-character hexadecimal `sha256` and a
`size` in bytes, and `eeg` (the data file: the .edf or .bdf, or the
BrainVision .eeg) is present with a size of at least one byte; `timing.sfreq`
is above 0 and at most 1 MHz, `n_samples` a whole number of at least 1 and
`duration_s`, when given, their quotient; `ch_names` holds at least one
channel and no name twice; `hidden_channels` share no channel with it;
`trigger_channels` are among the hidden channels; `channel_types` gives a type
of `electroclean.config.settings.CHANNEL_TYPES` for exactly the channels shown;
`bad_channels` are among them; `acquisition_gaps` are `[start, end]` pairs in
order inside the recording; `discontinuity_samples` lie inside it;
`original_events` has a known `source` (`events_tsv`, `brainvision_vmrk`,
`edf_annotations`, `bdf_annotations`, `stim_channel` or `none`), one text value
per column in each row and every event's sample from 0 to `n_samples`;
`amplitude.suggested_scalings` are positive; reports and sidecars are plain
JSON objects of limited size; and the result can be used to show the recording
and to write result files. The server records `registration`
(`{"registered_at", "registered_by", "registered_via", "notes", "retired"}`) in
the stored manifest itself; a browser's `registration` is ignored.

**The example training set.** `set_example_create` makes ElectroClean's example
set (`electroclean/training/examples.py`: three simulated recordings, two for
learning with the experts and one for practice, with the simulation's ground
truth as the reference) and answers with its recordings as a zip. The
recordings and the reference need only numpy and pybv. The manifests are made
with MNE-Python where it is installed (the ElectroClean server, with the
study's settings); the Cloud Functions do not include MNE-Python and use the
manifests kept in `electroclean/config/example_set_manifests.json` (made with
MNE-Python and the default settings by `python -m electroclean.web.example`),
after checking that every file made has exactly the size and SHA-256 they
record. If the files differ, the answer is 422 `example_unavailable`, and
`electroclean-web create-example-set` makes the set from a computer with
ElectroClean installed.

### The short-segment quiz (annotators)

A reference set with quiz items offers its quiz to the annotators allowed to
use the set (everyone when `allowed_annotators` is empty); `GET /me` lists them
as `"quizzes": [{"set_id", "name", "n_items", "finished": false, "feedback":
"immediate" | "end"}]` (empty when there are none). `POST /quiz/{set_id}`
(`ec_quiz` with `{"set_id", "action", …}` on Firebase,
`StudyService.quiz(user, set_id, body)`, `electroclean/web/quiz.py`) takes an
`action`:

`{"action": "get"}` →
`{"set_id", "name", "items": [{"item_id", "recording_id", "file_name", "start_s", "end_s", "context_s", "options": [label]}],
"answered": {"<item_id>": {"label", "correct", "correct_label"?, "explanation"?}}, "feedback": "immediate" | "end",
"finished": false, "score": {...} | null, "n_items": 4, "recordings": {"<recording_id>": Manifest}}`.
The items come in the annotator's own order
(`electroclean.training.quiz.item_order`) without their answers; `options` are
the catalogue's labels, with "No artifact / none of these" when the set offers
it. `recordings` holds the manifests of the recordings the items come from, so
that the browser can check the files the annotator opens against their
fingerprints and show them. In `answered`, `correct`, `correct_label` and
`explanation` are given only when the annotator may know them: at once with
`immediate` feedback, after finishing with `end` (`correct` is null before).
`score` is set once the quiz is finished. The first `get` starts the quiz.

`{"action": "answer", "item_id", "label", "response_time_s"?}` →
`{"correct": bool | null, "correct_label": str | null, "explanation": str | null, "n_answered", "n_items"}`
(null until the end when feedback comes at the end). An answer is judged as on
the desktop (the correct label or one of the item's accepted labels). The same
answer sent again gives the same answer and is kept once; another label for an
answered segment is 409 `already_answered` (with the kept `label`); after
finishing, 409 `finished`. 404 `unknown_item`, 400 `bad_label`.
`response_time_s` is the time the browser measured from showing the segment
to the answer, kept as the desktop keeps it.

`{"action": "finish"}` → `{"score": {...}}` (as `QuizSession.score()`, with
null for a proportion that cannot be computed). The result is saved like the
desktop's, as `training/<set>/quiz/annotator-<ID>_quiz_<mode>_<session>.json` in
the results folder (`mode` `practice` for immediate feedback, `assessment` for
feedback at the end, as the desktop's two kinds of quiz), so the export and the
results zip include it; a quiz finished before every segment is answered is
saved as incomplete, as on the desktop when an annotator stops early. Finishing
again gives the same score and saves nothing more. A set's quiz is for annotators
it allows (403 `not_allowed`); a set without items has none (404 `no_quiz`).
The browser shows each segment from the annotator's own copy of the recording,
opened from their computer as for training.

## The same operations on Firebase

On Firebase every operation above is a callable Cloud Function (Python, 2nd
generation, region europe-west2) taking and returning the same JSON:
`ec_me`, `ec_assignments`, `ec_match`, `ec_put_draft`, `ec_delete_draft`,
`ec_submit`, `ec_training`, `ec_guided_get`, `ec_guided_check`,
`ec_guided_continue`, `ec_guided_show_me`, `ec_visit_open`, `ec_visit_events`,
`ec_visit_close`, `ec_quiz` and, for administrators, `ec_admin_progress` and
`ec_admin` (every operation of the admin area, by `op`; it has 2 GB of memory
and up to 540 s for the analyses and the results zip). Each takes
`{"study": "<study id>", ...the request body...}` (path parameters such as the
recording ID become fields). Signing in uses Firebase Authentication (email and
password) in the browser; the annotator ID and role are custom claims set when
the account is made (`user_add`, or the administrator's command `add-user`), and
the functions read them from the caller's ID token. A changed role reaches the
claims of a token only when the browser refreshes it (Firebase does every hour,
or at once with `getIdToken(true)`); taking a role away, disabling and
removing count at once, because the functions also read the account in the
study. Errors are raised as `HttpsError` with the same `error` code in
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
| `ec_admin` | `{"op", ...the body of `POST /admin/{op}`}` |
| `ec_quiz` | `{"set_id", ...the body of `POST /quiz/{set_id}`}` |

There is no `token` and no beacon on Firebase: the Firebase SDK adds the ID
token; to send the last events when the page is hidden, call `ec_visit_events`
with `fetch(…, {keepalive: true})` or simply on the next visit. The admin
area downloads the results with `ec_admin` `results_zip` (up to 25 MB); larger
studies export them with `electroclean-web export` (docs/web/firebase.md).

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
