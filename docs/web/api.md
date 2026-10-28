# ElectroClean web API (version 1)

The contract between the browser application and the server. All paths start
with `/api/v1`. Requests and responses are JSON (UTF-8). Times on the wire are
in **samples** of the recording where an annotation is concerned, and in
seconds elsewhere. Errors are `{"error": "<code>", "message": "<text for the
annotator>"}` with an HTTP status of 400, 401, 403, 404, 409 or 422.

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
token scheme is used.

## Shared shapes

```jsonc
Annotation = {
  "annotation_id": "8f2c…",          // hex string, unique within the recording (made by the browser)
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
(401 `bad_credentials` otherwise). `POST /logout` → `{}`.

`GET /me` →

```jsonc
{
  "annotator_id": "A01", "display_name": "", "role": "annotator",
  "study": {
    "study_id": "…", "name": "…",
    "filters": {"highpass_enabled": true, "highpass_hz": 1.0, "notch_enabled": true, "notch_hz": 50.0,
                "notch_harmonics": false, "locked": false},
    "display": {"duration_s": 10.0, "n_channels": 32},
    "annotation": {"min_duration_samples": 1, "quick_labels": ["Eye-blink-artifact", "…"]},
    "logging": {"interactions": true, "pointer_hz": 5, "idle_after_s": 30},
    "logging_notice": "This study records how you use ElectroClean …"   // shown when logging is on
  },
  "catalogue": {"labels": [{"label": "Eye-blink-artifact", "value": 103, "short_code": "BLINK",
                             "colour": "#0067A5", "section": "Eye", "is_group": false,
                             "description": "…"}]},
  "programme": null | {"set_id": "example", "name": "…"}            // when the annotator is in a training programme
}
```

## Assignments and opening a recording

`GET /assignments` →
`{"items": [{"recording_id", "file_name", "format", "mode": "standard" | "guided" | "practice" | "assessment",
"context_id": "" | "<reference set>", "status": "todo" | "in_progress" | "done", "duration_s",
"n_channels", "size_bytes"}], "next": "<recording_id>" | null}`. `next` is the
recording to do next (chosen by the study's selection strategy).

`POST /match` `{"file_name", "size_bytes", "format", "sha256": "<hex>", "sfreq", "n_samples", "ch_names": [...]}` →

```jsonc
{
  "status": "matched" | "matched_metadata" | "unknown" | "not_assigned" | "done",
  "message": "…",                       // for the annotator; always present
  "recording_id": "…" | null, "mode": "standard", "context_id": "",
  "manifest": Manifest | null,          // present for matched and matched_metadata
  "draft": Draft | null,                // unfinished work to continue, if any
  "differences": ["…"]                  // matched_metadata: how the file differs from the study's copy
}
```

`matched`: the SHA-256 and size match a registered recording assigned to this
annotator. `matched_metadata`: no fingerprint match, but name, sampling rate,
number of samples and channels match one recording; the browser shows the
differences and asks whether to continue. `unknown`: not a recording of the
study. `not_assigned`: a study recording, but not for this annotator now.
`done`: already completed by this annotator (in this mode and context).

`PUT /drafts/{recording_id}?mode=&context=` `Draft` → `{"saved_at": "…"}`.
The browser sends a draft at most every 30 s while there are changes and when
the page is hidden. `DELETE` the same path discards it.

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

→ `{"saved": true, "files": ["…_annotations.json", "…_events.tsv", "…"], "attempt": 1,
"feedback": PracticeFeedback | null, "next": "<recording_id>" | null}`. The
server validates every annotation against the catalogue and the manifest
(422 `invalid_annotation` with the reason), refuses a second completion (409
`already_done`) and writes the outputs with ElectroClean's export code, then
discards the draft.

`PracticeFeedback` (practice mode only):
`{"passed": true, "pass_rule": "…", "metrics": {"event_f1", "event_recall", "event_precision", "label_accuracy", …},
"summary_html": "…", "flags": [{"kind": "MISSED" | "EXTRA" | "TYPE", "label", "your_label", "onset_sample",
"duration_samples", "channels", "annotation_id"}], "reference": [Annotation]}`. The
reference is revealed only for practice recordings, after they are saved.

## Training programme

`GET /training` → `{"set_id", "name", "stages": [{"key": "guided" | "practice" | "assessment",
"title", "status": "locked" | "available" | "in_progress" | "completed" | "not_used", "done", "total",
"stars", "max_stars", "best_score", "time_s"}], "next": {"stage", "recording_id", "label"} | null}`.

`GET /training/guided/{recording_id}` → `{"n_steps", "guidance": "show" | "find" | "find_unnamed",
"tolerance": {"seconds", "fraction", "channel_jaccard"}, "completed": [{"step", "stars", "annotation_id"}],
"current": Step | null}` where
`Step = {"step": 3, "instruction": "Mark this Eye-blink-artifact", "label": "Eye-blink-artifact" | null,
"description": "…", "note": "…" | null, "ghost": {"onset_sample", "duration_samples", "channels"} | null,
"view": {"start_s", "duration_s"} | null}`. The label is null for `find_unnamed`,
the ghost only present for `show`, the view absent for `find_unnamed`.

`POST /training/guided/{recording_id}/check` `{"step": 3, "annotations": [Annotation]}` →
`{"matched": false, "candidate_id": "…" | null, "problems": ["type" | "start" | "end" | "scope" | "channels" | "extra"],
"messages": ["Almost: the start is 0.24 s too early …"], "extras": ["<annotation_id>"], "can_continue": false,
"stars": null}`. When `can_continue` is true, `POST …/continue {"step": 3}` records
the step (stars from failed checks and Show me) and returns the next `Step` or
`{"complete": true, "summary": {"steps", "stars", "max_stars", "attempts", "time_s"}}`.

`POST /training/guided/{recording_id}/show-me` `{"step": 3}` →
`{"ghost": {...}, "annotation": Annotation}` (the experts' annotation to place;
the step then gives at most one star).

## Interaction logs

`POST /visits` `{"client": {...}, "programme": false}` → `{"visit_id": "…",
"logging": {"interactions": true, "pointer_hz": 5, "idle_after_s": 30}}` (the
server opens the visit's log, `interaction_logs/annotator-<ID>/<time>_<mode>.jsonl`,
with the same header as the desktop application plus `"client": "web"`).

`POST /visits/{visit_id}/events` `{"events": [{"t": 12.31, "wall": "…", "type": "mouse_press", ...}]}` → `{}`.
Events are appended in order; the server adds `seq`. The browser sends a batch
every few seconds and with `navigator.sendBeacon` when the page is hidden.
`POST /visits/{visit_id}/close` `{"reason": "…"}` → `{}`.

## Administration

`GET /admin/progress` (role admin) → per annotator and recording: status,
mode, attempts, last activity. `GET /admin/results.zip` → the study's
`Annotated_Events` and `interaction_logs` folders. Recordings, accounts and
assignments are managed with the `electroclean-web` command (see the
administrator guide); registering recordings needs the real files and runs
where they are, producing manifests that are imported into the server.

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
