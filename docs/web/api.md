# ElectroTag web API (version 1)

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
carries the header `X-ElectroTag: 1`.

The application is usually served from GitHub Pages
(`https://<owner>.github.io/<repo>/…`) while the server runs elsewhere, so the
server answers CORS requests from the origins listed in its setting
`ELECTROTAG_ALLOWED_ORIGINS` (comma-separated; the demo and local servers
also allow the origin they serve the application from), allowing the
`Authorization`, `Content-Type` and `X-ElectroTag` headers and no cookies.
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
  "modified_at": "2026-10-28T10:15:09.004+00:00",
  "confidence": 3,                    // optional: a whole number from 1 to 5, or null / left out (not rated)
  "note": "could be an eye movement"  // optional: one line of at most 200 characters ("" or left out: none)
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
         "n_channels": 32, "scale_factor": 1.0}, "elapsed_s": 312.4,
         "viewed": [[0.0, 64.5], [120.0, 130.0]], "saved_at": "…",
         "revises": 1,                // only in the draft of a revision: the version being revised
         "session_id": "…"}           // sent by the browser, never returned: the session the draft comes from
```

An annotation's `confidence` and `note` are checked wherever annotations are sent: a confidence
other than a whole number from 1 to 5 or none (a string, a fraction, 0 or `true` included), or a note that is not text, spans lines, is just `n/a` or is
longer than 200 characters, is refused with 422 (`invalid_annotation` when saving, `invalid_draft`
for a draft). Answers that return saved annotations (a revision's `annotations`) give both,
`confidence` null and `note` "" when there is none.

A draft's `elapsed_s` is the time worked so far, without the time paused (at least 0, or 422
`invalid_draft`; more than a week is kept as a week). `viewed` lists the
stretches of the recording that have been on the screen, as `[start_s, end_s]` pairs in seconds
(sorted and merged by the browser; at most 5000 pairs, each with `0 <= start_s <= end_s`, or 422
`invalid_draft`). A draft without `viewed` counts as nothing viewed.

## Signing in

`GET /health` → `{"ok": true, "version": "1.1.0", "study": "<name>", "demo": false}` (no authentication; CORS open to any origin, so the application can check an address before signing in).

`POST /login` `{"annotator_id": "A01", "password": "…"}` →
`{"token": "…", "expires_in_s": 43200, "annotator_id": "A01", "display_name": "…", "role": "annotator", "roles": ["annotator"]}`
(`roles` and `role` as in "Roles" below)
(401 `bad_credentials` otherwise; after 10 unsuccessful attempts for one ID, or
50 from one address, in 15 minutes, 429 `too_many_attempts`). IDs are not
case-sensitive. `POST /logout` → `{}`. A request with a missing or expired
token gets 401 `not_signed_in`; one without the header, 403 `missing_header`.

A private invitation link (`user_invite` below) lets a new annotator choose
their own password. The browser makes it from its own address with
`?invite=<token>` (and `?server=<address>` when the page is served from
another site than the study server), takes the token out of the address at
once, and asks two calls that need no sign-in, because the token is the proof:

`POST /invite/check` `{"token": "…"}` →
`{"annotator_id": "A11", "display_name": "…", "study_name": "…", "expires_at": "…"}`, for the welcome card.

`POST /invite/accept` `{"token": "…", "password": "…"}` → the answer of
`POST /login`: the password is set, every earlier sign-in of the account ends,
the invitation is used, and the person is signed in.

A token that was never made, was replaced by a newer link or was withdrawn, or
whose account was given a new password, made an administrator, switched off or
removed, is 404 `invite_unknown`; a used one
409 `invite_used`; an expired one 409 `invite_expired`; each with a message in
plain words that says what to do. A password of fewer than 8 characters is 400
`bad_password`. Unsuccessful attempts count towards the limit of `POST /login`
for the address (429 `too_many_attempts`). On Firebase these two calls do not
exist: an invitation there is Firebase Authentication's own link to choose a
password.

`GET /me` →

```jsonc
{
  "annotator_id": "A01", "display_name": "", "role": "annotator", "roles": ["annotator"],
  "study": {
    "study_id": "…", "name": "…",
    "filters": {"highpass_enabled": true, "highpass_hz": 1.0, "notch_enabled": true, "notch_hz": 50.0,
                "notch_harmonics": false, "locked": false},
    "display": {"duration_s": 10.0, "n_channels": 32, "scalings": {"eeg": 5e-05, "…": 0.0},
                "channel_colours": "off" | "region" | "side" | "type"},     // the study's default
    "annotation": {"min_duration_samples": 1, "quick_labels": ["Eye-blink-artifact", "…"],
                   "break_reminder_minutes": 50, "idle_pause_minutes": 3, "coverage_check": "warn" | "off",
                   "allow_revisions": true, "allow_reviews": true, "show_reviews_to_annotators": true,
                   "confidence": "optional" | "every_mark"},
    "gamification": {"enabled": true, "leaderboard": true},
    "review": {"show_corrections_to_annotators": true, "show_outcomes_to_annotators": true},
    "training": {"skippable": ["tour", "snippets", "guided", "practice"], "gate": "met" | "completed" | "off"},
    "replay": {"enabled": true, "trainees_watch_experts": true},
    "logging": {"interactions": true, "pointer_hz": 5, "idle_after_s": 30},
    "logging_notice": "This study records how you use ElectroTag …"   // "" when logging is off
  },
  "catalogue": {"labels": [{"label": "Eye-blink-artifact", "value": 103, "short_code": "BLINK",
                             "colour": "#0067A5", "section": "Eye", "is_group": false,
                             "parent": "Eye-artifact" | null, "description": "…"}]},
  "programme": null | {"set_id": "example", "name": "…", "complete": false},  // in a training programme; complete when every stage is done
  "training_gate": {"open": true, "reason": "" | "training_required", "message": "…"},  // see "Training stages"
  "quizzes": [{"set_id": "example", "name": "…", "n_items": 4, "n_answered": 0, "finished": false, "feedback": "immediate"}]
}
```

`quizzes` lists the short-segment quizzes the annotator may take (see "The
short-segment quiz" below); `logging_notice` is the study's own notice when the
administrator has written one. The three settings for long sessions in
`annotation` are described in the [administrator guide](../administrator_guide.md): minutes of work before a
break reminder and minutes without input before the clock pauses itself (0 turns
either off), and whether Save and Finish first lists the parts not yet viewed.
`annotation.confidence` says whether annotators rate their confidence in a mark (1 to 5) when they wish
(`"optional"`, the default) or are asked to rate each new mark (`"every_mark"`); no mark starts with a
rating in either.
`annotation.allow_revisions` says whether a finished study recording may be
opened again and revised (see "Revisions" below), `annotation.allow_reviews`
and `annotation.show_reviews_to_annotators` whether administrators may review
saved work and whether the annotator sees those reviews (see "Reviews" below),
and `gamification` whether
the home page shows the game elements and the leaderboard (see
"Achievements"; `leaderboard` is false whenever `enabled` is). `review` says
whether the annotator is shown the corrections of their work and the outcomes
of the conflicts in it (`GET /me/feedback`), `training` which stages of the
training path may be skipped and what real study work waits for, and `replay`
whether sessions are replayed and whether trainees may watch experts' sessions
(the study settings `review`, `training` and `replay` of the
[administrator guide](../administrator_guide.md)). `training_gate`
says whether the person's study recordings are open, and if not why, in a
sentence for the person (see "Training stages" below).

### Roles

Each account holds one or more **roles**: `annotator` (annotates the
recordings given to them), `expert` (opens anyone's saved work to correct it,
replays sessions, adjudicates conflicts and supplies training material, in the
expert area: "Experts" below) and `admin` (runs the study in the admin area,
and may do everything an expert does). One person may hold several, for
example an expert who also annotates. `participant` is kept for a later crowd
study: it is read and kept, and the admin area refuses to give it (400
`role_not_offered`). Roles open privileges only; recordings can be assigned to
anyone whatever their roles.

`roles` lists a person's roles in the order `admin`, `expert`, `annotator`;
`role`, the field of the time when a person had one role, is the first of them
(the **primary role**), so a client that reads only `role` sees an
administrator as `admin` and an expert who annotates as `expert`. The study
keeps both (the SQLite column `users.roles` and the Firestore field `roles`
beside `role`); an account kept before roles became a set has `role` alone,
which is read as its whole set and written as a list at its next change. On
Firebase a privileged role (`expert`, `admin`) counts only when both the
caller's claims and their account in the study grant it ("The same operations
on Firebase"). The IDs `ADJUDICATED` and `REFERENCE` are never accounts (400
`reserved_id`): they name the adjudicated version of a task and a training
reference.

## Assignments and opening a recording

`GET /assignments` →
`{"items": [{"recording_id", "file_name", "format", "mode": "standard" | "guided" | "practice" | "assessment",
"context_id": "" | "<reference set>", "status": "todo" | "in_progress" | "done" | "unusable" | "locked", "duration_s",
"n_channels", "size_bytes", "repeat": false, "locked": null | "training_required", "elapsed_s", "n_annotations",
"completed_at", "draft",
"saved": {"version", "first_saved_at", "total_elapsed_s"} | null, "revising": false,
"problem": ProblemReport (the annotator's view) | null}],
"next": "<recording_id>" | null, "next_item": {"recording_id", "mode", "context_id"} | null}`. `next` is the
recording to do next: unfinished work first, then the training programme's
next step, then the study's selection strategy (`manual`: the assignment order;
`seeded`: ElectroTag's seeded order; `random`: a random choice that stays the
same until something more is completed). `next_item` says in which mode and
context. A trainee's list holds the recordings of the programme's unlocked
stages. `repeat` is true for a practice recording the programme lets the
trainee annotate again (its `status` is then `todo`).

`locked` is the status of a study recording not yet saved while real study
work waits for the competency assessment (`locked` then says why,
`"training_required"`; see "Training stages" below): it is never `next`, and
opening it is refused.

`unusable` is the status of a recording its annotator reported as one that
cannot be annotated (see "Problem reports" below): it is finished for the
annotator, never the next recording, and kept apart from `done`. `problem` is
the item's latest problem report as its annotator sees it (without the
administrator's fields), or null.

For the annotator's progress and history on the home page, a `done` item
carries what the completion register says of its latest attempt (the highest
attempt number, so a revision once there is one): `elapsed_s` (the time worked
on that version, pauses left out), `n_annotations` and `completed_at`; they
are null for other items. `saved` adds what only the history needs, for any
item saved at least once: `version` (1 for the first save, 2 for its first
revision, and so on), `first_saved_at`, when the first version was saved, and
`total_elapsed_s`, the time of every version added up (null where the register
does not have it); it is null for a recording never saved. `revising` is true
for a `done` item with a revision under way (its draft is kept; `status` stays
`done`). An `in_progress` item, and a `done` one being revised, carries
`draft`, a summary of the unfinished work kept with the study:
`{"elapsed_s", "n_annotations", "viewed_s", "saved_at"}`, where `viewed_s` is
the seconds of the recording in the draft's `viewed` (overlaps counted once);
`draft` is null for other items.

`POST /match` `{"file_name", "size_bytes", "format", "sha256": "<hex>", "sfreq", "n_samples", "ch_names": [...], "revise": false, "view_saved": false}` →

```jsonc
{
  "status": "matched" | "matched_metadata" | "unknown" | "not_assigned" | "done" | "unusable",
  "message": "…",                       // for the annotator; always present
  "recording_id": "…" | null, "mode": "standard", "context_id": "",
  "manifest": Manifest | null,          // present for matched and matched_metadata
  "draft": Draft | null,                // unfinished work to continue, if any
  "differences": ["…"],                 // matched_metadata: how the file differs from the study's copy
  "repeat": false,                      // a practice recording being annotated again
  "revision": null | {"version": 2, "revises": 1, "saved_at": "…", "annotations": [Annotation]},
  "saved": null | {"version": 1, "saved_at": "…", "annotations": [Annotation]}   // with view_saved
}
```

`matched`: the SHA-256 and size match a registered recording assigned to this
annotator. `matched_metadata`: no fingerprint match, but name, sampling rate,
number of samples and channels match one recording; the browser shows the
differences and asks whether to continue. `unknown`: not a recording of the
study. `not_assigned`: a study recording, but not for this annotator now.
`done`: already completed by this annotator (in this mode and context).
`unusable`: the annotator set this recording aside as one that cannot be
annotated; its message says so.
`sha256` and `size_bytes` are required (400 `bad_request` otherwise); the other
fields are needed only for `matched_metadata`.

With `"revise": true`, a finished study recording that may be revised opens
again: the answer is `matched` (or `matched_metadata`) with `revision`, which
gives the version a submission will save (`version`), the version being revised
(`revises`, the latest), when that was saved, and its annotations, which the
browser opens with. `draft` is then the revision's own draft, if one was kept
for that version. Without `revise`, a finished recording answers `done`, and
its message says that it can be opened from the history to revise it.

With `"view_saved": true`, a finished study recording opens to read, with the
feedback on it: the answer is `matched` (or `matched_metadata`) with the
manifest and `saved`, the latest saved version's number, when it was saved and
its annotations; nothing starts, and no draft is given or kept.

`PUT /drafts/{recording_id}?mode=&context=` `Draft` → `{"saved_at": "…"}`.
The browser sends a draft at most every 30 s while there are changes and when
the page is hidden, one at a time, and each replaces the one before. `DELETE`
the same path discards it. A browser session that discards its work and closes
adds `&session=` with its `session_id` (`et_delete_draft` takes `session_id`):
the study remembers that session for this recording, and a draft of it that
was sent before the delete but arrives after it is refused with 409
`draft_discarded`, so that the work discarded does not come back. A
`session_id` that is not a string of at most 64 characters is refused (422
`invalid_draft` in a draft, 400 in a delete). Drafts of more than
8 MB are refused (413 `too_large`). The draft of a revision is kept like any
other and carries `revises`; a done recording takes a draft only when it may
be revised (409 `already_done` otherwise). A recording set aside as one that
cannot be annotated takes no draft and no submission (409 `unusable`).

## Saving

`POST /submissions`

```jsonc
{
  "recording_id": "…", "mode": "standard", "context_id": "",
  "annotations": [Annotation],
  "session": {"started_at": "…", "elapsed_s": 912.3, "visit_id": "…", "session_id": "<32 hex>",
              "filters": {"highpass_hz": 1.0, "notch_hz": 50.0, "notch_harmonics": false, "method": "fir"},
              "view": Draft.view,
              "client": {"user_agent": "…", "screen": {"width": 1920, "height": 1080, "pixel_ratio": 2}},
              "viewed_fraction": 0.97},        // optional: the share of the recording that was on screen
  "sha256": "<hex of the file that was annotated>",
  "revises": 1                                 // only for a revision: the version being revised
}
```

`session.elapsed_s` is at least 0 (422 `invalid_session` otherwise); a figure of more than a
week, which the browser's pausing clock cannot reach, is recorded as a week with a warning in the
saved `_session.json`, so that one faulty figure cannot distort the study's totals, and the save
goes ahead. `session.filters` gives the display filters used (`highpass_hz` or `notch_hz`
null when that filter was off); when the study fixes the filters, the study's
are recorded. `session.session_id` (optional, 32 hexadecimal characters, 400
`bad_request` otherwise) is the browser's ID of the annotation session, the one
its interaction log events carry: the saved `_session.json`, the
`_annotations.json`, the completion register and the session log then use it as
the session's ID, so the interaction log and the results of a session carry
the same ID. Without it, or when a saved result of the annotator already has
that ID, the server makes one. `session.viewed_fraction` (0 to 1), when the
browser measures it, is kept with the session's display state and counts
towards the milestones for recordings viewed in full.

→ `{"saved": true, "files": ["…_annotations.json", "…_events.tsv", "…"], "attempt": 1,
"feedback": PracticeFeedback | null, "guided": GuidedSaved | null, "assessment": AssessmentSaved | null,
"next": "<recording_id>" | null, "revision": {"version": 2, "revises": 1} | null}`. The server validates every annotation against
the catalogue and the manifest (422 `invalid_annotation` with the reason),
refuses a second completion that is not a revision (409 `already_done`; see "Revisions" below), refuses a training recording
whose stage is still locked (403 `locked`) and writes the outputs with
ElectroTag's export code, then discards the draft. A guided recording is
saved only when every step still matches and nothing extra is marked (422
`guided_incomplete`, with `step` when a step no longer matches; that step is
then the current one again). When the file's checksum differs from the
registered one (`matched_metadata`), the outputs are saved with a warning that
says so. 409 `busy` means the same recording is being saved by another request.

### Revisions

A finished study recording (mode `standard`) may be saved again when the study
allows it (`annotation.allow_revisions`, on by default): the submission gives
`revises`, the version being revised, which must be the latest (409
`already_revised` otherwise, so that the same revision sent twice, or from two
browsers, is saved once). The server saves it as the next attempt of the same
assignment (`…_attempt-02_annotations.json` and its companions) beside the
earlier files, which stay exactly as they were; the completion register gains
the new attempt, and the saved `_session.json` and `_annotations.json` record
`context.revision` = `{"version", "revises_version", "revises_session_id",
"revises_output_basename"}`. The analyses (agreement, the reference set's
sources and the results exports) use each annotator's latest attempt. A
submission of a finished recording without `revises` is still refused (409
`already_done`), and one with `revises` when the study takes no revisions gets
409 `revisions_off`. Training recordings keep their own rules (a practice
recording may be repeated until it is passed; guided and assessment recordings
are saved once).

## Problem reports

An annotator who cannot judge a recording reports it instead of saving it as
having no artifacts. `POST /problems` (`et_problem_report` on Firebase)

```jsonc
{"problem_id": "<32 hex, made by the browser for this report>", "recording_id": "…", "mode": "standard",
 "context_id": "", "reason": "file_wont_open" | "wrong_recording" | "bad_channels" | "too_noisy" | "other",
 "note": "…",                       // optional, at most 300 characters
 "outcome": "noted" | "unusable",   // carry on, or set the recording aside
 "where": "home" | "annotate"}
```

→ `{"problem": ProblemReport, "already": false}`. The recording must be one of
the annotator's (403 `not_assigned`, 404 `unknown_recording`); 400
`bad_request` names a field that is wrong. `unusable` gives the assignment the
status `unusable`: finished for the annotator, kept apart from `done`, left out
of the agreement analyses; it is only for an unfinished study recording (409
`already_done` for one saved, 409 `not_for_training` for a training recording).
The same `problem_id` sent again (a second press, or a request sent again after
an answer that came too late) is kept once and answers `"already": true`. Every
report is audited (`problem_report`, by the annotator, with the length of the
note and not its text).

```jsonc
ProblemReport = {"problem_id", "recording_id", "file_name", "mode", "context_id", "reason", "reason_text",
                 "note", "outcome", "where", "reported_at", "state": "open" | "resolved",
                 "resolution": null | "resolved" | "returned" | "reassigned", "resolution_note", "resolved_at",
                 "returned_at",
                 // and for administrators:
                 "annotator_id", "display_name", "item_status", "resolved_by", "reassigned_to",
                 "unusable_now": false}
```

## Reviews

An administrator reviews an annotator's latest saved version of a study
recording (`saved_attempt_get` and `review_save` below). A review is a record
of its own and never changes the annotation files; a recording can have several.

```jsonc
Review = {"review_id", "annotator_id", "recording_id", "file_name", "mode": "standard", "context_id": "",
          "attempt": 1,                       // the version reviewed
          "reviewer_id", "reviewer_name", "reviewed_at", "overall_note",
          "items": [{"annotation_id": "…" | null, "label": "…" | null, "onset_sample", "duration_samples",
                     "onset_s", "offset_s", "channels": [], "status": "agree" | "caveat" | "comment", "note"}],
          "counts": {"agree", "caveat", "comment", "missed"},
          "summary": "2 caveats, 1 comment",
          "output_basename", "session_id"}    // these two for administrators only
```

An item is about an annotation of the version reviewed (`annotation_id`, with
the annotation's label, time and channels as saved) or about a stretch without
one (`annotation_id` null, always a comment, "missed artifact?" unless a note
is given). `GET /me/reviews` (`et_my_reviews`) →
`{"shown": true, "reviews": [Review]}`, the reviews of the caller's work, newest
first; when the study keeps reviews from its annotators
(`annotation.show_reviews_to_annotators` false) `{"shown": false, "reviews": []}`.
The agreement analyses do not use reviews.

## Feedback on one's own work

`GET /me/feedback` (`et_my_feedback`) →
`{"corrections": {"shown": true, "items": [..]}, "adjudications": {"shown": true, "items": [..]}}`: what the
study shows the caller about their own saved work, in two parts. `corrections`
lists the experts' corrections of it, with the changes and their reasons, and
is `{"shown": false, "items": []}` when the study keeps them from its
annotators (`review.show_corrections_to_annotators` false); `adjudications`
lists the decisions on the conflicts in it, and follows
`review.show_outcomes_to_annotators` in the same way. Other people are never
named. The items of each part are described with the operations that make
them ("Corrections and replay" and "Adjudication and the library" below); a
study whose experts have made none answers empty lists.

## Achievements

`GET /me/achievements` gives the facts that the home page's game elements are
drawn from (`docs/web/using.md`, "Progress and milestones"); `POST
/me/achievements` with `{"goal_per_week": 10}` (a whole number from 1 to 200, or
null for no goal) or `{"leaderboard_hidden": true}` changes them and answers the
same (400 `bad_request` for other values). When the study has the game elements
off, both answer `{"enabled": false, "leaderboard_enabled": false}`.

```jsonc
{
  "enabled": true, "leaderboard_enabled": true,
  "counters": {"done": 12, "assigned": 300, "worked_s": 9123.4, "annotations": 418},
  "completions": [{"first_saved_at": "…", "viewed_fraction": 1.0 | null}],   // one per study recording saved
  "save_times": ["…"],                  // every save, revisions included (for streaks of days)
  "viewed_in_full": 9 | null,           // null when no saved recording reported what was viewed
  "goal": {"per_week": 10 | null},
  "team": {"done": 640 | null, "assigned": 1200 | null, "people": 6},   // null: see below
  "leaderboard": null | {
    "ranked_by": "completed" | "viewed_in_full",
    "rows": [{"rank": 1, "name": "Steady Heron", "count": 54, "you": false}],   // the top ten
    "you": {"name": "Merry Otter", "hidden": false, "count": 12, "rank": 4 | null},
    "people": 6, "min_people": 3
  }
}
```

Only study recordings (mode `standard`) count. `counters.done` counts
recordings, so a revision adds nothing to it; `worked_s` adds up the time of
every saved version and `annotations` the annotations of each recording's
latest version, shown for interest only. A recording counts as viewed in full
from 99% of it on screen. The milestones themselves are worked out in the
browser from these facts (`js/games/milestones.js`). The leaderboard ranks
people by recordings completed, or by recordings viewed in full when the study
sets `gamification.leaderboard_viewed_only`; ties share a place. It names people
only by pseudonyms, an adjective and an animal chosen by an HMAC-SHA256 of the
annotator ID keyed with a random secret of the study that the server keeps and
never sends; it leaves out anyone who chose to be hidden, and it has no rows
until at least `min_people` are on it, so that nobody can tell who the others
are. For the same reason `team.done` and `team.assigned` are null when exactly
one other person has recordings, since the team's figures less one's own would
then be that person's. No annotator ID is ever part of the answer.

`GuidedSaved = {"summary": {"steps", "stars", "max_stars", "attempts", "failed_attempts", "shown", "time_s"},
"message": "Recording saved: 14 of 18 stars (4.2 min)."}`.

`AssessmentSaved = {"complete": false, "done": 1, "total": 3, "message": "…"}` until every assessment
recording is saved, then `{"complete": true, "done", "total", "status": "met" | "not_met" | "not_determined",
"status_text": "…", "summary_html": "…", "message": "…"}` (the competency result; the
full report stays with the administrator).

`PracticeFeedback` (practice mode only):
`{"passed": true, "pass_rule": "a score of at least 80% and the right type for at least 80% of the artifacts you find",
"rule": {"event_f1", "label_accuracy"}, "score": {"event_f1", "label_accuracy"},
"counts": {"reference_events": 8, "your_events": 10, "found": 7, "extra": 3, "other_type": 0},
"verdict": "Not yet: you need … Look at what you missed below, then …", "summary": "You found 7 of the experts' 8 artifacts and made 3 marks they did not make.",
"metrics": {"event_f1", "event_recall", "event_precision", "label_accuracy",
"mean_iou", "mean_channel_jaccard", …}, "per_category": [{"category", "reference_events", "your_events", "found",
"event_f1", …}], "review": true,
"flags": [{"kind": "MISSED" | "EXTRA" | "TYPE", "label", "your_label", "onset_sample",
"duration_samples", "channels", "annotation_id", "source": "reference" | "yours", "onset_s", "offset_s",
"text": "Missed: Eye-blink-artifact, 4.00–4.40 s"}], "reference": [Annotation]}`.
The score is the event F1 (`score.event_f1`, an artifact counts as found when a mark of the
same type overlaps it); `counts` say what it is made of (`found` counts the experts' artifacts
matched by a mark of any type, `other_type` those of them marked with another type). `verdict` and
`summary` are the review's plain words, which the server builds with
`electrotag.training.programme.practice_verdict` and `score_sentence` and the demonstration with
the same words in `js/training/scoring.js`; the verdict's last part depends on how many practice
recordings the set has. For MISSED the flag describes the experts' annotation (`your_label` null); for
EXTRA and TYPE the annotator's own (`label` is the experts' type for TYPE). The
reference is revealed only for practice recordings, after they are saved, and
only when the reference set allows the review (`review`; otherwise `flags` and
`reference` are empty). Numbers that cannot be computed are null.

## Training programme

`GET /training` → `{"set_id", "name", "description", "stages": [{"key": "tour" | "snippets" | "guided" | "practice" |
"assessment", "title", "description", "status": "locked" | "available" | "in_progress" | "completed" | "skipped" |
"not_used", "done", "total", "stars", "max_stars", "best_score", "time_s", "detail", "result", "can_skip", "can_resume"}],
"next": {"stage", "recording_id", "label", "text", "mode", "context_id", "file_name", "repeat"} | null,
"complete": false, "message": "…", "gate": {"open", "reason", "message"}}` (404 `no_programme` for an
annotator outside a programme). The five stages and how they unlock are in "Training stages" below; `gate` is
`training_gate` of `GET /me`. `detail` is the stage's line of results, shown on the training path:
for practice the best score and the pass mark (`electrotag.training.programme.practice_detail`, the
same words as `practiceDetail` in `js/training/scoring.js`), for a finished assessment its result
and what happens next. `result` is null, or `"passed"` / `"not_passed"` for practice once tried, and
`"met"` / `"not_met"` / `"not_determined"` for a finished assessment (from the competency report;
`not_determined` also while there is none). When every practice recording was tried without a pass,
`next` is the practice recording practised longest ago (`repeat` true). `message` is `next.text`,
or once everything is done what comes next, which depends on the assessment's result.

`GET /training/guided/{recording_id}` → `{"recording_id", "context_id", "n_steps", "guidance": "show" | "find" |
"find_unnamed", "tolerance": {"seconds", "fraction", "channel_jaccard"}, "completed": [{"step", "stars",
"annotation_id"}], "current": Step | null, "complete": false, "summary": … | null, "empty_message": "…" | null}`
where
`Step = {"step": 3, "n_steps": 6, "guidance": "show", "instruction": "Mark this Eye-blink-artifact",
"text": "The experts' annotation is outlined with a dashed line. To mark it:\n1. Press **1** …", "label": "Eye-blink-artifact" | null,
"description": "…", "note": "…" | null, "ghost": {"onset_sample", "duration_samples", "channels"} | null,
"view": {"start_s", "duration_s"} | null}`. `text` says what to do, one line per action (choose the
type, choose the channels, drag), with `**` around the keys and controls to show in bold
(`electrotag.training.guided.step_text`, the same words as the demonstration's `stepBody`). The label is null for `find_unnamed`,
the ghost only present for `show`, the view absent for `find_unnamed`. Where a
trainee is in a guided recording is kept by the server, so it survives a reload
or another computer. A recording without expert annotations has `n_steps` 0 and
is complete at once (`empty_message` says so).

`POST /training/guided/{recording_id}/check` `{"step": 3, "annotations": [Annotation]}` →
`{"matched": false, "candidate_id": "…" | null, "problems": ["missing" | "type" | "start" | "end" | "scope" |
"channels" | "extra"], "messages": ["Start: 0.24 s too early. Drag the left edge …"], "extras": ["<annotation_id>"],
"can_continue": false, "stars": null, "failed_attempts": 1, "deltas": {"start_s", "end_s", "allowed_s", "iou",
"channel_jaccard"}}`. `annotations` are all the trainee's annotations. A check
counts as a failed attempt when the annotations changed since the last check
and the attempt does not match. `stars` are those the step would earn, given
when `can_continue` is true. For `find_unnamed`, a match adds `"found": {"label",
"description", "note"}`. A check of another step than the current one gets 409
`wrong_step` (with `current_step`); after the last step, a check only reports
extras (`"complete": true`). When `can_continue` is true,
`POST …/continue {"step": 3, "paused_s": 12.5}` records the step (stars from failed checks and
Show me, and its time in `seconds`, less `paused_s`, the seconds the trainee was
paused during the step, which is optional and ignored unless a number of at
least 0; a step's time runs from its start to the trainee's last check or Show
me before the recording was closed, and on again from the `GET` that opens it
once more, so the time it was closed is not counted) and returns the next `Step` with `"previous": {"step", "stars",
"attempts", "failed_attempts", "used_show_me", "seconds"}`, or `{"complete": true,
"summary": {"steps", "stars", "max_stars", "attempts", "failed_attempts", "shown", "time_s"}, "previous",
"message"}` (409 `not_matched` if the last check of that step did not allow it).

`POST /training/guided/{recording_id}/show-me` `{"step": 3, "annotations": [Annotation]}` →
`{"ghost": {...}, "annotation": Annotation, "replace": ["<annotation_id>"], "view": {"start_s", "duration_s"},
"stars": 1}` (the experts' annotation to place, with a new ID; `replace` lists
the trainee's attempts at this step to remove first, when `annotations` were
sent; the step then gives at most one star).

### Training stages

The training path has five stages, in this order: `tour` (Find your way
around: a short, hands-on tour of the platform on a practice recording made in
the browser, where nothing is saved), `snippets` (Meet the artifacts: short
examples of each artifact type with the experts' notes, then a recognition
check, which is the set's quiz), `guided` (Learn with the experts), `practice`
(On your own) and `assessment` (the blind competency assessment). A stage
unlocks when every stage before it is finished, which means `completed`,
`skipped` or `not_used`. A stage with nothing to do is `not_used`: the tour when
the study's setting `training.tour` is off, the snippets when the set has none,
and a stage whose recordings the set does not have. A `completed` stage stays
completed whatever is done to the stages before it. `can_skip` is true for a
stage the study lets trainees skip (`training.skippable`) that is open now
(`available` or `in_progress`); `can_resume` for a skipped stage. A skipped
stage's recordings are not listed.

`POST /training/stage` (`et_training_stage`) `{"stage": "tour" | "snippets" | "guided" | "practice" | "assessment",
"action": "skip" | "done" | "resume"}` → the answer of `GET /training`. It saves, so the browser never sends it
again by itself; asking for what is already so changes nothing and answers the
path as it is. `skip` skips an open stage; `resume` takes a skipped stage up
again (the stages after it that were not completed wait for it once more);
`done` finishes the tour or the snippets, which are done in the browser (the
other stages finish by what is saved). Each is kept, with its time, as an event
of the trainee's progress (`stage_skipped`, with the policy of the moment,
`stage_resumed` and `stage_completed`), and the competency report lists the
stages skipped (`stages_skipped`). Errors: 400 `bad_request` for an unknown stage
or action; 404 `no_programme` outside a programme; 409 `cannot_skip` for the
assessment, which is never skipped, and for a stage the study does not let
trainees skip; 409 `locked` for a stage not open yet; 409 `finished` for a stage
completed or not used; 409 `not_done_here` for `done` of a stage that finishes by
what is saved; 409 `quiz_required` for `done` of the snippets while their
recognition check is unfinished and the study counts the stage as done only once
it is finished (`training.snippets_quiz_required`).

`GET /training/snippets` (`et_training_snippets`) → `{"set_id", "snippets": [Snippet], "recordings":
{recording_id: Manifest}, "quiz": {"n_items", "finished", "required"} | null}` where
`Snippet = {"snippet_id", "recording_id", "start_s", "end_s", "label", "explanation", "context_s": 2.0,
"channels": [..], "source": {"kind": "guided", "annotation_id"} | {"kind": "added", "by"} | {...}}`. The snippets
are the study team's own (`snippet_add`, below) and one for each reference
annotation of the set's guided recordings (`snippet_id` `g-<annotation ID>`,
with the experts' note on it as the explanation); practice and assessment
recordings never give snippets, which would give their answers away. Only
snippets whose recording is registered are listed, and `recordings` holds the
public manifests the browser checks the trainee's own copies against.
`channels` are those the artifact is on (empty: the whole montage). `quiz` is
the set's quiz, when it has one that the trainee may take.

**The competency gate.** Real study work waits until the trainee's competency
assessment is passed: the study's `training.gate` is `met` (the competency
report's status, the default), `completed` (every assessment recording saved,
whatever the result) or `off`. Nobody waits who is an expert or an
administrator, who takes no training programme, or whose programme's set has
no assessment recordings. While the gate is closed, `training_gate` is
`{"open": false, "reason": "training_required", "message": "…"}`, the study
recordings not yet saved are `locked` in `GET /assignments`, and `POST /match`
for one of them, a draft (`PUT /drafts/…`), saving (`POST /submissions`), a
revision and setting one aside (`POST /problems` with `outcome` `unusable`) are
refused with 403 `training_required` and the same message. Training recordings
never wait.

**After an assessment that did not meet the criteria** the study team either
reopens the trainee's training or gives them a new assessment set, both in the
admin area and both audited (`training_reopen` and `training_assessment_set`,
below). Reopening sends the trainee back to the guided or the practice stage:
from there each stage counts only what is saved from then on (its recordings
are offered again, with `repeat` true, as new attempts; nothing saved before is
changed), and the assessment is taken once more. A new assessment set enrols
the trainee in that set with its learning stages counted as done (their
`detail` says where), so the next step is its assessment.

These are the administrative operations of the training path (`POST /admin/{op}`,
`et_admin`); the three for snippets are also operations of the expert channel
(`POST /expert/{op}`, `et_expert`), since experts supply training material too:

| op | body | answer |
| --- | --- | --- |
| `snippets_list` | `{"set_id"}` | `{"set_id", "snippets": [Snippet] (the study team's), "guided": [Snippet] (made from the guided references), "recordings": [{"recording_id", "file_name", "use", "duration_s", "ch_names"}]}`, the recordings a snippet may come from (the set's own, less its practice and assessment recordings) |
| `snippet_add` | `{"set_id", "recording_id", "start_s", "end_s", "label", "explanation"?, "context_s"?: 2.0, "channels"?: [..], "snippet_id"?, "source"?}` | `{"snippet"}`. The same `snippet_id` again replaces it, so a request that reaches the study twice keeps one; without one the next free `s01`, `s02`, … is used. At most 60 s long, with up to 10 s of context. 422 `reveals_answers` for a practice or assessment recording of the set; 404 `unknown_recording`; 400 `bad_request` for times outside the recording, a type that is not the study's or a channel it does not have. Audited (`snippet_add`, the explanation counted by its length). |
| `snippet_remove` | `{"set_id", "snippet_id"}` | `{}`; one that is gone already changes nothing. 409 `guided_snippet` for one made from a guided reference. Audited. |
| `training_gate_get` | `{"annotator_id"}` | `{"annotator_id", "training_gate", "programme": GET /training's answer \| null, "events": [{"event", "stage", "at", "by", "from", "from_set"}], "skipped": ["tour", …], "can_reopen", "can_assign_set", "assessment_sets": [{"set_id", "name", "n_assessment"}]}`: the trainee's path as they see it, the gate, what happened to the stages, and whether the two actions after an assessment are open (once it is finished and not met) |
| `training_reopen` | `{"annotator_id", "from"?: "practice" \| "guided"}` | the answer of `training_gate_get`. 409 `not_finished` before the assessment is finished, 409 `already_met` after a pass; 404 `no_programme`. Audited. |
| `training_assessment_set` | `{"annotator_id", "set_id"}` | the answer of `training_gate_get`, in the new set. 409 `same_set`, 409 `not_finished`, 409 `already_met`, 422 `no_assessment` for a set without assessment recordings, 409 `not_allowed` for a set the trainee may not use. Audited. |

## Interaction logs

`POST /visits` `{"client": {...}, "programme": false, "mode": "standard", "context_id": ""}` → `{"visit_id": "…",
"logging": {"interactions": true, "pointer_hz": 5, "idle_after_s": 30}}` (the
server opens the visit's log, `interaction_logs/annotator-<ID>/<time>_<mode>.jsonl`,
with the header of docs/activity_logs.md, which has `"client": "web"` and
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
no `X-ElectroTag` needed). `POST /visits/{visit_id}/close` `{"reason": "…"}` →
`{}` (writes `log_closed`; closing twice does nothing). A closed visit refuses
events (409 `visit_closed`); another annotator's visit is 404 `unknown_visit`.

## Administration

Lead researchers (accounts with the role `admin`) run the study from the
**admin area** of the browser application. Every administrative operation is
`POST /admin/{op}` with a JSON body (403 `forbidden` for anyone else, 404
`not_found` for an `op` the server does not offer, as an older server answers;
the admin area then says the operation is not offered yet) and, on Firebase,
the one callable function `et_admin` with `{"study", "op", ...the body}`; in the
service layer it is `StudyService.admin(op, user, body)`
(`electrotag/web/admin.py`), so the ElectroTag server and Firebase behave
the same. Every operation that changes something appends an entry to the
study's **audit log** (below), as do the `electrotag web` commands that
change the study (`"by": "command"`). `GET /admin/progress` and
`GET /admin/results.zip` remain as before. Each administrative call reads the
study afresh, so a change made through one Firebase instance is seen by the
next call whichever instance answers it.

The EEG never reaches the study: an administrator adds recordings by choosing
them on their own computer, the browser reads them and builds each
recording's manifest (`js/eeg/register.js`), and only the manifests are sent
(`recordings_register`). The `electrotag web register` command remains for
registering from the command line.

### Shapes

```jsonc
AuditEntry = {"at": "2026-10-28T10:15:02.120+00:00", "by": "ADMIN", "op": "user_add",
              "summary": "Added A03 (Annotator three) as an annotator", "details": {...}}
UserRecord = {"annotator_id": "A03", "display_name": "Annotator three", "email": "a03@example.org" | null,
              "role": "annotator" | "expert" | "admin" /* the primary role */,
              "roles": ["annotator"] /* "Roles" above */, "status": "active" | "disabled", "created_at": "…",
              "last_seen": "…" | null, "notes": "", "assigned": 12, "done": 4, "programme": "<set_id>" | null,
              "invitation": {"state": "none" | "invited" | "accepted" | "expired" | "revoked",
                             "invited_at": "…" | null, "expires_at": "…" | null, "ended_at": "…" | null}}
RecordingRecord = {"scope": "study" | "set:<set_id>", "recording_id": "sub-001/eeg/sub-001_task-rest_eeg.vhdr",
              "file_name", "format", "sfreq", "n_samples", "duration_s", "n_channels", "size_bytes",
              "sha256", "registered_at", "registered_by", "registered_via": "browser" | "command",
              "notes": "", "retired": false, "assigned": 3, "done": 1, "warnings": ["…"]}
SetRecord = {"set_id", "name", "description", "created_at", "created_by",
              "practice_review": true, "allowed_annotators": [] /* empty: everyone */,
              "practice_pass": {"event_f1": 0.8, "label_accuracy": 0.8},
              "guided_tolerance": {"seconds": 0.2, "fraction": 0.2, "channel_jaccard": 0.75, "accepted_labels": {}},
              "criteria": CompetencyCriteria /* electrotag.training.assessment, to_dict() */,
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
with `electrotag web`. A set made in the admin area is self-contained: its
recordings are registered in its own scope `set:<set_id>`, so they are never
offered for study annotation. Sets registered from a dataset that refer to the
study's own recordings have `"self_contained": false` and `"scope": "study"`.

### Operations

| op | body | answer |
| --- | --- | --- |
| `overview` | `{}` | `{"study": {"study_id", "name"}, "counts": {"recordings", "annotators", "experts", "admins", "assignments", "done", "in_progress", "todo", "unusable", "problems_open", "reviewed"}, "recent": [AuditEntry], "last_saved": [{"annotator_id", "recording_id", "mode", "context_id", "at"}]}` (ten of each; `recordings` counts the study's own, the others the active accounts and their work, each account under every role it holds; `problems_open` the open problem reports and `reviewed` the annotator's recordings with at least one review) |
| `settings_get` | `{}` | `{"name", "settings": {"filters", "display", "channels", "selection", "logging", "annotation", "loading", "discovery", "gamification", "review", "training", "replay"}, "logging_notice", "logging_notice_is_default"}`: the effective values of the blocks of `electrotag_study.json` that a study may change (`review`, `training` and `replay` are described in the administrator guide) |
| `settings_update` | `{"name"?, "settings"?: {block: {key: value}}, "logging_notice"?}` | as `settings_get`. Each key given replaces that setting; the result is checked with ElectroTag's own settings code and refused with 400 `invalid_settings` and the reason (also for a block or key that cannot be changed). `"logging_notice": ""` goes back to ElectroTag's own notice |
| `users_list` | `{}` | `{"users": [UserRecord]}` (disabled accounts too) |
| `user_add` | `{"annotator_id", "display_name"?, "email"?, "roles"?: ["annotator"], "role"?, "password"?, "invite"?: false, "expires_days"?: 14}` | `{"user": UserRecord, "invite_link": str \| null, "temporary_password": str \| null}`, with `"invite_token", "expires_at"` when `invite` is true. On Firebase `email` is required (400 `email_required`), the Firebase Authentication user is created (or, for a person already in another study of the project, given this study) with the custom claims below, and `invite_link` lets the person choose a password when none is given. On the server a temporary password (three groups of four characters) is made when none is given; with `"invite": true` the account is made with an invitation instead (as `user_invite`), and nobody knows its first password. A password has 8 to 200 characters; a password and `invite` together are 400; `invite` for an administrator is 409 `admin_account`. `roles` lists the account's roles; the older `role` alone gives one; with both, `role` must be the primary role of `roles` (400 otherwise). An unknown role is 400 `bad_request`, `participant` 400 `role_not_offered`, the IDs `ADJUDICATED` and `REFERENCE` 400 `reserved_id`. 409 `user_exists`, 409 `email_in_use` |
| `user_update` | `{"annotator_id", "display_name"?, "roles"?, "role"?, "status"?, "notes"?}` | `{"user": UserRecord, "changed": bool}`; 404 `unknown_user`. `roles` replaces every role (the older `role` alone makes it the only one), checked as for `user_add`. A request that changes nothing (an account switched off already, say) gives `changed: false` and writes no audit entry. Disabling ends the person's sessions at once and stops them signing in; on Firebase the roles are also written into their claims. An administrator cannot take their own administrator role away or disable themselves (409 `self`) |
| `user_reset_password` | `{"annotator_id"}` | `{"invite_link" \| null, "temporary_password" \| null}`: a new password link (Firebase) or a new temporary password (the server, which also ends every session of the account) |
| `user_invite` | `{"annotator_id", "expires_days"?: 14}` | `{"invite_token": str \| null, "invite_link": str \| null, "expires_at": str \| null, "invitation": UserRecord.invitation}`. On the server a new single-use invitation: a random token (32 bytes) kept only as its SHA-256 hash with its expiry (1 to 90 days, 400 otherwise); any earlier invitation of the account stops working. The browser makes the private link from `invite_token`. On Firebase `invite_link` is Firebase Authentication's link to choose a password (the account needs an email address, 409 `no_email`) and its expiry is Firebase's own. 404 `unknown_user`; 409 `disabled` for an account that is switched off; 409 `admin_account` for an administrator (on every backend: an administrator is given a password). A new password (`user_reset_password`), making the account an administrator, switching it off or removing it ends its invitation |
| `user_invite_revoke` | `{"annotator_id"}` | `{"invitation": UserRecord.invitation}`: the open invitation stops working at once; 409 `no_invitation` when there is none; 422 `cannot_revoke` on Firebase, where a link once made cannot be withdrawn (switch the account off instead) |
| `user_remove` | `{"annotator_id"}` | `{}`: the account leaves the study with its assignments, programme, drafts and guided progress; its results and logs stay; not oneself (409 `self`). On Firebase the study is taken out of the person's claims, and a Firebase user who takes part in no other study is deleted |
| `assignments_list` | `{"annotator_id"?}` | `{"items": [{"annotator_id", "recording_id", "mode", "context_id", "status", "attempts", "last_activity", "elapsed_s", "n_annotations", "saved_at"}]}` (what each person is given, the training programme's recordings included). `attempts` counts the saves (a revision is another attempt); `elapsed_s` is the time of every saved attempt together, or of the draft while the work is in progress; `n_annotations` and `saved_at` are those of the latest saved attempt by its number (null before one) |
| `assign` | `{"annotator_ids": [..], "recording_ids": [..] \| "all": true, "mode"?: "standard", "context_id"?}` | `{"added", "already", "retired"}`: retired recordings are skipped and counted in `retired`. 404 `unknown_user`, 404 `unknown_recording` (not registered in the scope of that mode and set), 400 `not_in_set` (a training recording outside the set), 409 `not_allowed` (the set names its allowed annotators and this person is not one) |
| `unassign` | `{"annotator_id", "recording_id", "mode"?, "context_id"?}` | `{}`; 409 `done` for a completed item, 409 `set_aside` for an item its annotator set aside as one that cannot be annotated (dealt with through the problem report: `problem_return` or `problem_reassign`), 404 `not_assigned` |
| `programme_set` | `{"annotator_id", "set_id": str \| null}` | `{}`; 404 `no_reference_set`, 409 `not_allowed` |
| `recordings_list` | `{"scope"?}` | `{"recordings": [RecordingRecord]}` (every scope when none is given) |
| `recordings_register` | `{"scope": "study" \| "set:<id>", "manifests": [Manifest], "replace"?: false, "allow_duplicates"?: false}` | `{"added": [recording_id], "replaced": [..], "skipped": [{"recording_id", "reason", "duplicate_of"?}]}`. A manifest whose data file has the fingerprint (SHA-256 and size) of another recording of the same scope, registered already or earlier in the same request, is skipped with `duplicate_of` naming that recording, unless `allow_duplicates` is true: each copy would otherwise be assigned and annotated as a recording of its own. `Manifest` is the internal manifest of `electrotag/web/manifest.py` (`schema` `electrotag.web_manifest`) as the browser builds it; the server checks it (below), stores it with `registered_via` `browser`, keeps the notes and retirement of a recording registered again, and never replaces a recording that has results unless the fingerprint is the same. At most 500 manifests per call (413 `too_large`); a set scope must be a self-contained set's |
| `recording_update` | `{"scope", "recording_id", "notes"?, "retired"?}` | `{"recording": RecordingRecord}`; a retired recording is offered for no new assignments; 404 `unknown_recording` |
| `recording_remove` | `{"scope", "recording_id"}` | `{}`; 409 `has_results` when anyone saved it or a reference set uses it (as a reference or in a quiz item). Its unfinished assignments go with it |
| `sets_list` | `{}` | `{"sets": [SetRecord]}` |
| `set_create` | `{"set_id", "name"?, "description"?, "method"?: "single_expert", "experts"?: [..], "notes"?}` | `{"set": SetRecord}`; a self-contained set; `method`, `experts` and `notes` are the provenance declared for the set, as `electrotag-admin create-reference-set` records it; 409 `set_exists` |
| `set_update` | `{"set_id", "name"?, "description"?, "practice_review"?, "allowed_annotators"?, "practice_pass"?, "guided_tolerance"?, "criteria"?, "quiz"?: {"include_none_option"?, "feedback"?}, "show_full_report_to_annotator"?}` | `{"set": SetRecord}`. `practice_pass` and `guided_tolerance` change only the keys given; `criteria` is the whole `CompetencyCriteria`. Values ElectroTag refuses give 400 `invalid_set` with the reason |
| `set_delete` | `{"set_id"}` | `{}`; 409 `in_use` when trainees have results in it, are enrolled in it or have finished its quiz. Its recordings (scope `set:<id>`) and assignments go with it |
| `set_add_reference` | `{"set_id", "recording_id", "recording_scope"?: "study" \| "set:<id>", "use", "source": Source, "provenance"?: {"notes"}}` | `{"set": SetRecord, "disagreements": [row] \| null}`; a study recording is copied into the set's scope, so training recordings are never offered for study annotation. The reference must fit the recording (sampling rate, length, channels, labels: 422 `invalid_document`); 404 `no_saved_annotations` when a source's annotations were never saved; 409 `conflict` when the set holds another recording of that name |
| `set_recording_update` | `{"set_id", "recording_id", "use"?, "guidance"?: "auto" \| "show" \| "find" \| "find_unnamed"}` | `{"set": SetRecord, "warnings": [".."]}` (for example when trainees have already done a recording now used for assessment); 404 `not_in_set` |
| `set_remove_recording` | `{"set_id", "recording_id"}` | `{"set": SetRecord}` (the recording stays registered in the set's scope); 404 `not_in_set` |
| `set_guided_notes` | `{"set_id", "recording_id"}` | `{"notes": [{"annotation_id", "label", "onset_s", "offset_s", "note"}]}` (every reference annotation of the recording, with its note or "") |
| `set_guided_note` | `{"set_id", "annotation_id", "text"}` | `{}` ("" removes the note); 404 `unknown_annotation` |
| `set_example_create` | `{}` | `{"set": SetRecord, "recordings_zip": {"file_name", "base64", "size_bytes"}}` (the simulated recordings to give trainees, about 4.6 MB); 409 `set_exists`; 422 `example_unavailable` (see below) |
| `quiz_items` | `{"set_id"}` | `{"items": [QuizItem]}` (`electrotag.training.reference.QuizItem.to_dict()`) |
| `quiz_item_add` | `{"set_id", "recording_id", "start_s", "end_s", "correct_label", "accepted_labels"?, "explanation"?, "context_s"?: 2.0, "item_id"?}` | `{"item": QuizItem}`. The recording must be registered in the set's scope (404 `unknown_recording`); the segment lies within it; the labels are the catalogue's, or "No artifact / none of these" when the set offers it (`quiz.include_none_option`). Without `item_id` the next free `q01`, `q02` … is used; an existing `item_id` is replaced |
| `quiz_item_remove` | `{"set_id", "item_id"}` | `{}`; 404 `unknown_item` |
| `progress` | `{}` | as `GET /admin/progress` |
| `stats` | `{"work"?: "study" \| "all"}` | `Stats` (below): how far the study has got and how long the work takes, from the completion register (`elapsed_s`, `n_annotations`, `completed_at`), the drafts, the assignments, the accounts' `last_seen` and the visits. `work` `study` counts the study's own annotation (mode `standard`), `all` training too; 400 otherwise. A recording saved more than once (a revision, or a practice recording repeated) counts as one recording done, on the day of its first save, with the annotations of its latest attempt and the time of all its attempts together; `saved` per recording is the number of people who saved it |
| `agreement` | `{"annotator_ids"?, "recording_ids"?, "modes"?: ["standard"], "config"?: {..AnalysisConfig fields..}}` | `{"summary": {"n_recordings", "n_comparable_recordings", "annotators", "config", "key_results": [..], "unusable": {"recordings_left_out", "recording_ids", "assignments"}}, "report_html": str, "tables": {"<name>.tsv": str}, "warnings": [..], "settings_file": {"config": {..AnalysisConfig..}, "recording_ids": [..] \| null, "exclude_recording_ids": [..], "command": str}}`, computed on demand with `electrotag.reliability` (the files of `electrotag-agreement`). Annotators and modes are chosen with `annotator_ids` and `modes`, not in `config`; settings it refuses give 400 `invalid_config`; 422 `not_enough` when no recording has two annotators. When the tables would exceed 12 MB, `events_matched.tsv` and `events_unmatched.tsv` are left out with a warning; `annotation_notes.tsv` (every annotation with a note: `recording_id`, `annotator_id`, `mode`, `annotation_id`, `label`, `onset_s`, `duration_s`, `channels`, `confidence`, `note`) is always sent. `settings_file` is the file `electrotag-agreement --config` reads, so that `command` (`electrotag-agreement Annotated_Events --config agreement_settings.json`) repeats the analysis on the results zip with the same recordings and the same numbers. A study recording that any annotator set aside as one that cannot be annotated is left out for every annotator, with a warning and a paragraph at the top of the report that give the counts (`summary.unusable`) |
| `activity` | `{"annotator_ids"?}` | `{"report_html": str, "tables": {"visits.tsv": str, "recordings.tsv": str}}`, with `electrotag.activity`; 422 `no_logs` when there are no interaction logs |
| `competency` | `{"set_id", "annotator_id"}` | `{"report": {..}, "html": str}` (`competency_report`, made again and kept, and `competency_html`); 404 `not_complete` until every assessment recording is saved (also for a set without assessment recordings) |
| `results_zip` | `{}` | `{"file_name", "base64", "size_bytes"}`: the results folder as `GET /admin/results.zip` gives it, quiz results, problem reports and reviews included (docs/file_formats.md), with the study's settings (`study/electrotag_study.json`), its audit log (`study/audit_log.jsonl`, oldest first), its recordings' manifests (`study/manifests.json`) and a `README.txt`; 413 `too_large` (with `size_bytes`) above 25,000,000 bytes (use `electrotag-web export`) |
| `problems_list` | `{"state"?: "open" \| "resolved", "reason"?, "annotator_id"?, "recording_id"?}` | `{"problems": [ProblemReport], "counts": {"open", "resolved", "unusable"}, "reasons": {code: text}}`, newest first; `counts` are of every report, and `unusable` the assignments set aside now |
| `problem_resolve` | `{"problem_id", "note"?}` | `{"problem": ProblemReport}`; 404 `unknown_problem`, 409 `already_resolved` |
| `problem_return` | `{"problem_id", "note"?}` | `{"problem": ProblemReport}`: the recording goes back on the annotator's to-do list (the status `unusable` is undone) and the report is resolved as `returned`; the annotator sees the note. 409 `not_unusable` when the recording is not set aside |
| `problem_reassign` | `{"problem_id", "annotator_id", "note"?}` | `{"problem": ProblemReport, "added": 1}`: the recording is assigned to that person (the study's own annotation) and the report resolved as `reassigned`; 404 `unknown_user`, 409 `retired`, 409 `not_for_training`, 409 `already_assigned` when the person has the recording already (nothing would change, so the report stays open) |
| `saved_attempt_get` | `{"annotator_id", "recording_id"}` | `{"annotator_id", "display_name", "recording_id", "file_name", "mode", "context_id", "attempt", "saved_at", "manifest": Manifest, "annotations": [Annotation], "reviews": [Review], "allow_reviews"}`: what a review needs, the latest saved version, each annotation with the annotator's `confidence` (1 to 5, or null) and `note`; 404 `no_saved_annotations`; 409 `not_for_training` for another mode |
| `review_save` | `{"review_id": "<32 hex>", "annotator_id", "recording_id", "attempt", "items": [{"annotation_id"} or {"onset_sample", "duration_samples"} with "status", "note"?], "overall_note"?}` | `{"review": Review, "already": false}`. `attempt` must be the latest (409 `not_latest`); notes at most 300 characters, the overall note 1000; 422 `unknown_annotation` for an annotation not in that version, 422 `invalid_review` for a stretch outside the recording, 400 `empty_review` with no item and no note, 409 `reviews_off` when the study takes none. The same `review_id` sent again is kept once (`"already": true`) |
| `reviews_list` | `{"annotator_id"?, "recording_id"?}` | `{"reviews": [Review]}`, newest first |
| `audit` | `{"before"?: str, "limit"?: 50}` | `{"entries": [AuditEntry], "next": str \| null}`, newest first; `before` is the `next` of the page before (400 `bad_request` otherwise); `limit` 1 to 500 |
| `visits` | `{"annotator_id"?, "limit"?: 100}` | `{"visits": [{"visit_id", "annotator_id", "mode", "context_id", "started_at", "closed_at", "n_events"}]}`, newest first; `limit` 1 to 1000 |

```jsonc
Stats = {"generated_at": "…", "work": "study", "today": "2026-10-28", "days": ["2026-09-29", …, "2026-10-28"] /* 30 */,
         "totals": {"assigned", "done", "in_progress", "todo", "remaining", "share_done": 0.4 | null,
                    "annotator_hours": 12.5, "median_minutes": 18.2 | null, "done_7d", "done_30d",
                    "pace_per_day": 1.3, "pace_days": 14,
                    "projection": {"status": "projected" | "complete" | "not_enough", "date": "2026-12-01" | null,
                                   "reason"?: "too_early"},
                    "unusable", "problems_open", "reviewed"},
         "daily": [0, 2, …] /* completions on each of the days */,
         "annotators": [{"annotator_id", "display_name", "role", "status", "assigned", "done", "in_progress", "todo", "unusable",
                         "share_done", "time_s", "in_progress_s", "median_s", "median_annotations",
                         "last_active", "done_7d", "daily": [..]}],
         "recordings": [{"scope", "recording_id", "file_name", "assigned", "done", "in_progress", "unusable", "saved",
                         "median_s", "median_annotations", "min_annotations", "max_annotations"}]}
```

The totals and the recordings count the work of active accounts; every
account has its row. Times are the `elapsed_s` the browser measured: the time a
recording was open and not paused. `annotator_hours` adds the time of drafts
still in progress to that of the saved work; `time_s` is a person's saved work
and `in_progress_s` their drafts. A day is the local date at the start of a
time stamp. The pace is that of the last 14 days, or of the days since the first
completion when the study is younger (`pace_days`, 1 to 14). The projection
divides the work remaining by the pace; it is `not_enough` with fewer than 3
completions in those days, and `not_enough` with `reason` `too_early` until
three days have passed since the first completion. A recording
set aside as one that cannot be annotated (`unusable`) is counted apart from
`done` and is not part of `remaining`.

Mistakes in a body (a missing or malformed field) are 400 `bad_request` with a
message that names the field. On Firebase, an operation that needs Firebase
Authentication where it is not available answers 503 `auth_unavailable`.

`Source`, where a reference comes from:

```jsonc
{"kind": "annotator", "annotator_id": "E1", "mode": "standard", "context_id": ""}   // that person's saved annotations of the recording
{"kind": "document", "document": {...}}          // an _annotations.json (from a results folder, or saved by the desktop application, 1.1.0 or earlier)
{"kind": "consensus", "annotator_ids": ["E1", "E2", "E3"], "min_agreement": null, "merge_gap_s": 0.0, "min_duration_s": 0.0}
{"kind": "adjudicated", "adjudicator_id": "E4", "expert_ids": ["E1", "E2", "E3"]}
```

`mode` and `context_id` (standard and "" when left out) say which saved
annotations are meant, for every kind except `document`; the latest saved
attempt is used. Consensus uses `electrotag.training.consensus.build_consensus`
and returns its disagreement rows (`{"kind": "time" | "channels", "label",
"onset_s", "offset_s", "experts_marking", "experts_not_marking", "note"}`;
422 `invalid_consensus` when it cannot be built); it needs at least two
annotators. An adjudicated reference names at least two experts. The reference
is stored with ElectroTag's reference-set code (`ReferenceSet.add_reference`
in `electrotag/training/reference.py`), which records its provenance: the
method, the experts, the adjudicator, copies of the source files (the saved
`_annotations.json` of each person, or the uploaded document) with their
checksums, the time, the consensus rule and the administrator's notes. An
uploaded document must use a label catalogue compatible with the study's
(422 `invalid_document`); its recording ID is replaced by the set's.

**The checks of a manifest.** `recordings_register` stores only manifests that
pass `electrotag/web/manifest_check.py`, and keeps only the fields ElectroTag
knows. A manifest is refused, with a reason in `skipped`, unless: `schema` is
`electrotag.web_manifest` and `schema_version` has major version 1; it is
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
of `electrotag.config.settings.CHANNEL_TYPES` for exactly the channels shown;
`bad_channels` are among them; `acquisition_gaps` are `[start, end]` pairs in
order inside the recording; `discontinuity_samples` lie inside it;
`original_events` has a known `source` (`events_tsv`, `brainvision_vmrk`,
`edf_annotations`, `bdf_annotations`, `stim_channel` or `none`), one text value
per column in each row and every event's sample a whole number (an events.tsv
row outside the recording is kept, as the loader keeps it with a warning);
`amplitude.suggested_scalings` are positive; reports and sidecars are plain
JSON objects of limited size; and the result can be used to show the recording
and to write result files. The server records `registration`
(`{"registered_at", "registered_by", "registered_via", "notes", "retired"}`) in
the stored manifest itself; a browser's `registration` is ignored.

**The example training set.** `set_example_create` makes ElectroTag's example
set (`electrotag/training/examples.py`: three simulated recordings, two for
learning with the experts and one for practice, with the simulation's ground
truth as the reference) and answers with its recordings as a zip. The
recordings and the reference need only numpy and pybv. The manifests are made
with MNE-Python where it is installed (the ElectroTag server, with the
study's settings); the Cloud Functions do not include MNE-Python and use the
manifests kept in `electrotag/config/example_set_manifests.json` (made with
MNE-Python and the default settings by `python -m electrotag.web.example`),
after checking that every file made has exactly the size and SHA-256 they
record. If the files differ, the answer is 422 `example_unavailable`, and
`electrotag web create-example-set` makes the set from a computer with
ElectroTag installed.

### The short-segment quiz (annotators)

A reference set with quiz items offers its quiz to the annotators allowed to
use the set (everyone when `allowed_annotators` is empty); `GET /me` lists them
as `"quizzes": [{"set_id", "name", "n_items", "n_answered", "finished": false, "feedback":
"immediate" | "end"}]` (empty when there are none; `n_answered` counts the answers kept so far). `POST /quiz/{set_id}`
(`et_quiz` with `{"set_id", "action", …}` on Firebase,
`StudyService.quiz(user, set_id, body)`, `electrotag/web/quiz.py`) takes an
`action`:

`{"action": "get"}` →
`{"set_id", "name", "items": [{"item_id", "recording_id", "file_name", "start_s", "end_s", "context_s", "options": [label]}],
"answered": {"<item_id>": {"label", "correct", "correct_label"?, "explanation"?}}, "feedback": "immediate" | "end",
"finished": false, "score": {...} | null, "n_items": 4, "recordings": {"<recording_id>": Manifest}}`.
The items come in the annotator's own order
(`electrotag.training.quiz.item_order`) without their answers; `options` are
the catalogue's labels, with "No artifact / none of these" when the set offers
it. `recordings` holds the manifests of the recordings the items come from, so
that the browser can check the files the annotator opens against their
fingerprints and show them. In `answered`, `correct`, `correct_label` and
`explanation` are given only when the annotator may know them: at once with
`immediate` feedback, after finishing with `end` (`correct` is null before).
`score` is set once the quiz is finished. The first `get` starts the quiz.

`{"action": "answer", "item_id", "label", "response_time_s"?}` →
`{"correct": bool | null, "correct_label": str | null, "explanation": str | null, "n_answered", "n_items"}`
(null until the end when feedback comes at the end). An answer is judged by
`QuizItem.is_correct` (the correct label or one of the item's accepted labels).
The same answer sent again gives the same answer and is kept once; another
label for an answered segment is 409 `already_answered` (with the kept
`label`); after finishing, 409 `finished`. 404 `unknown_item`, 400 `bad_label`.
`response_time_s` is the time the browser measured from showing the segment
to the answer, kept with the answer to the millisecond.

`{"action": "finish"}` → `{"score": {...}}` (as `QuizSession.score()`, with null
for a proportion that cannot be computed). The result is saved with
`QuizSession.save` (`electrotag/training/quiz.py`), as
`training/<set>/quiz/annotator-<ID>_quiz_<mode>_<session>.json` in the results
folder (`mode` `practice` for immediate feedback, `assessment` for feedback at
the end), so the export and the results zip include it; a quiz finished before
every segment is answered (End the quiz now) is saved with `completed` false and
the score of the segments answered. Finishing again gives the same score and
saves nothing more. A set's quiz is for annotators it allows (403
`not_allowed`); a set without items has none (404 `no_quiz`). The browser shows
each segment from the annotator's own copy of the recording, opened from their
computer as for training.

## Experts

Experts (accounts with the role `expert`) and administrators work in the
**expert area** of the browser application. Every operation of it is
`POST /expert/{op}` with a JSON body and, on Firebase, the one callable
function `et_expert` with `{"study", "op", ...the body}` (1 GB of memory and up
to 300 s, for saving corrections and adjudicated versions); in the service
layer it is `StudyService.expert.run(op, user, body)` (`electrotag/web/expert.py`).
Anyone else gets 403 `forbidden` (a few operations are open to everyone and
check the rest themselves: "Corrections and replay" below), and an `op` the
study does not offer 404 `not_found`. An operation whose name ends in `_get` or `_list` only reads, and
the browser may ask it once more after a failure; every other operation saves,
is never repeated by the browser, gives the same state when the same request
reaches the study twice, and writes an entry to the audit log. Expert work in
the browser is logged like annotation work (the admin area's is not).

The expert area's versions of someone's work are **derived versions**: an
expert's correction of a saved attempt and the adjudicated version of a task
are each saved with the journalled save, as five files, into a results tree of
their own (`Annotated_Events/derived/corrections/` and
`Annotated_Events/derived/adjudications/`, each with its own completion
register: docs/file_formats.md), with their provenance in `context.derived`.
The original files never change, and a derived version is never anyone's
attempt, completion or time; the analyses use the originals.

| op | body | answer | saves? |
| --- | --- | --- | --- |
| `replay_consent_get` | `{}` | `{"consent": {"teaching": false, "changed_at": "…" \| null}, "replays": {"enabled": true, "trainees_watch_experts": true}}`: whether the caller agrees to trainees watching replays of the caller's own sessions for teaching, and the study's `replay` settings | read |
| `replay_consent_set` | `{"teaching": bool}` | as `replay_consent_get`, with `"changed": bool`; only the caller's own consent, which they may give and withdraw at any time. A change is audited (`replay_consent_set`); the same value again changes nothing and writes nothing. 400 `bad_request` unless `teaching` is true or false | **save** |

### Corrections and replay

An expert corrects someone's saved study attempt by changing, adding and
removing its marks, with a reason for each change; the correction is a derived
version (above), credited to the expert, and the attempt it corrects never
changes. A replay plays back how a person worked on a recording, from the
interaction log. The operations are in `electrotag/web/corrections.py` and
`electrotag/web/replay.py`.

| op | body | answer | saves? |
| --- | --- | --- | --- |
| `work_list` | `{"annotator_id"?, "recording_id"?, "corrected"?: bool, "limit"?: 200}` (at most 1000) | `{"items": [{"annotator_id", "display_name", "recording_id", "file_name", "attempt", "saved_at", "n_annotations", "corrections", "task_id": null, "own": bool}], "total", "corrections_on": bool}`: the latest saved attempt of each person and study recording, newest first; `corrections` counts the corrections of that attempt, and `own` marks the caller's own work | read |
| `saved_attempt_get` | `{"annotator_id", "recording_id", "attempt"?}` | `{"annotator_id", "display_name", "recording_id", "file_name", "mode", "context_id", "attempt", "latest", "attempts": [1, 2], "saved_at", "manifest", "annotations": [Annotation], "reviews": [Review], "corrections": [Correction], "own", "corrections_on", "reason_required", "reasons": {code: words}}`: one saved attempt (the latest by default) with what the correction view needs. 404 `no_saved_annotations`, `unknown_recording`; 409 `not_for_training` | read |
| `correction_save` | `{"correction_id": "<32 hex>", "annotator_id", "recording_id", "attempt", "annotations": [Annotation], "changes": [{"annotation_id", "reason", "note"?}], "overall_note"?, "session": Submission.session, "sha256"}` | `{"correction": Correction, "already": bool, "files": ["…_annotations.json", …]}`. Errors: 409 `corrections_off`, `own_work`, `not_latest`, `busy`, `conflict`; 422 `no_changes`, `reason_missing` (with `annotation_ids`), `invalid_annotation`, `invalid_session`; 400 `bad_request` (an unknown reason, a note over 300 characters, an overall note over 1000). Audited (`correction_save`) | **save** |
| `corrections_list` | `{"annotator_id"?, "recording_id"?, "corrector_id"?}` | `{"corrections": [Correction]}`, newest first | read |
| `correction_get` | `{"correction_id"}` | Correction with `"annotations"` (the corrected version), `"original"` (the attempt corrected), `"manifest"`, and each change's `reason_text`. 404 `not_found` | read |
| `my_correction_get` | `{"correction_id"}` | as `correction_get`, for the annotator whose work was corrected (anyone may ask; another person's correction is 404 `not_found`, and 403 `forbidden` when the study keeps corrections from its annotators); without `output_basename`, `session_id`, `state` and `elapsed_s` | read |
| `replay_index_get` | `{"annotator_id", "recording_id", "mode"?: "standard", "context_id"?, "attempt"?}` | `{"logging": bool, "annotator_id", "display_name", "recording_id", "mode", "context_id", "file_name", "manifest", "segments": [Segment], "saved": {"attempt", "saved_at", "annotations"} \| null}`: the person's sessions on the recording, oldest first, and the saved version to compare the end of the replay with (the latest, or `attempt`) | read |
| `replay_events_get` | `{"visit_id", "window_no"?, "from_seq"?: 0, "limit"?: 4000 (at most 10000), "pointer"?: true}` | `{"header": {"started_at", "logging", "screens"}, "events": [event with seq], "next_seq": int \| null}`: one page of a segment's events (of the whole visit without `window_no`), in order; `pointer: false` leaves the pointer's positions out. 404 `unknown_visit`, `unknown_segment` | read |
| `teaching_list` | `{}` | `{"shown": bool, "sessions": [{"annotator_id", "display_name", "recording_id", "file_name", "attempt", "saved_at", "n_annotations"}]}`: what a trainee may watch, the saved study recordings of the experts who agree to it with a session in the log; `shown` false (and no sessions) when the study shows trainees no experts' sessions | read |

```jsonc
Correction = {"correction_id", "state": "saved", "annotator_id", "recording_id", "file_name", "mode": "standard", "context_id": "",
  "corrected_from": {"annotator_id", "attempt", "session_id", "output_basename", "annotations_sha256"},
  "corrector_id": "E01", "corrector_name", "corrected_at", "elapsed_s", "number": 1, "output_basename", "session_id",
  "changes": [Change], "counts": {"added", "removed", "changed"}, "overall_note", "summary": "1 added, 1 changed",
  "attempt": 1, "n_corrections_of_version": 1}
Change = {"annotation_id", "change": "added" | "removed" | "changed",
  "fields": ["label", "onset", "end", "channels", "confidence", "note"],    // what changed, for "changed"
  "before": Mark | null, "after": Mark | null,                              // Mark: an Annotation without its times
  "reason": "missed" | "not_artifact" | "wrong_type" | "boundaries" | "channels" | "split_merge" | "other" | "",
  "note": "≤300 characters"}
Segment = {"visit_id", "window_no", "session_id", "started_at", "ended_at", "outcome": "finished" | "closed_without_saving" | "not_finished",
  "attempt": 1 | null, "n_events", "first_seq", "last_seq", "has_snapshot": bool}
```

**The difference and its reasons.** The server works out what changed itself,
from the saved attempt and the annotations sent, matched by `annotation_id`: a
correction keeps the IDs of the marks it changes, a mark with a new ID is
added, and one left out is removed (channels in another order are the same
channels). `changes` gives the reason and an optional note for each change the
server finds; reasons for anything else are ignored. The study's
`review.reason_required` says which changes need one: `always` every change,
`edited_or_none` the changed and removed marks, `never` none (422
`reason_missing` lists the changes still without one). The browser's
`js/expert/diff.js` is the same function, and both are tested with
`web_tests/unit/correction_diff_cases.json`.

**Saved once.** The browser makes `correction_id` at the first press of Submit
and sends it again after an answer that came too late. A request first writes
a `pending` record with that ID, then looks for a version with that ID as its
session's ID in the corrections' register before it saves anything, and marks
the record `saved` last, so that the same correction sent twice, or a request
that stopped half-way, saves one version; a second request while the first
is saving is 409 `busy`, and the same ID from another expert is 409 `conflict`.
Only the latest attempt is corrected (409 `not_latest` when the annotator has
saved again since the expert opened it), and nobody corrects their own work
(409 `own_work`: they revise it). The saved version is the five files in
`Annotated_Events/derived/corrections/` (docs/file_formats.md), whose
`_annotations.json` and `_session.json` carry `context.derived` =
`{"kind": "correction", "correction_id", "corrected_from", "corrector_id", "corrector_name", "changes", "overall_note"}`;
its `annotator_id` is the person whose work it is, its display name "A01
corrected by E01", its session ID the `correction_id`, and its time the
expert's.

**Two corrections of the same work.** Each expert's correction of the same
attempt is kept; `n_corrections_of_version` says how many experts' corrections
that attempt has (an expert who corrects it again counts with their latest),
and the audit log's summary says when the corrections go to adjudication,
where their disagreements are decided. In the service layer
`corrections_of(service, annotator_id, recording_id, attempt=None, *, latest_per_corrector=True)`
gives those records, oldest first.

**Feedback.** `GET /me/feedback`'s `corrections.items` are the corrections of
the caller's saved work, newest first, as Correction without
`output_basename`, `session_id`, `state` and `elapsed_s` and with
`corrected_from` reduced to `{"attempt"}`, each change with its `reason_text`,
and `of_latest` true when the correction is of the caller's latest attempt.

**Replays.** A segment is one recording opened in one window of a visit, from
its `recording_opened` to its `recording_finished` or `closed_without_saving`
(the visit index). Its `attempt` is the saved attempt whose session ID it
carries (the browser sends `session.session_id` with each save), or, for logs
written before that, the n-th finished segment is the n-th attempt. Since the
browser logs `annotations_snapshot` when a session opens with annotations
already present (`has_snapshot`), a replay starts from it; a segment logged
before that starts from where the one before ended.

**Who may watch, and the open operations.** `my_correction_get`,
`replay_index_get`, `replay_events_get` and `teaching_list` may be asked by
anyone signed in to the study (`expert.OPEN_OPS`); each checks the rest itself.
Experts and administrators replay anyone while `replay.enabled` is on (409
`replays_off` otherwise). Anyone else may watch only the sessions of a person
who holds the expert role and agrees to teaching with their sessions
(`replay_consent_set`), and only while `replay.enabled` and
`replay.trainees_watch_experts` are both on; otherwise 403 `forbidden`.

### Tasks, windows and known answers

A **task** shares one study recording, or one window of it, out among k
annotators (2 to 6, `review.k_default` unless the request says otherwise),
who annotate it independently in the ordinary way: a task makes an ordinary
assignment for each of its people, carrying the task's ID
(`electrotag/web/tasks.py`). An assignment made without a task behaves
exactly as before. One person holds at most one task of a recording, since an
assignment is one per person, recording, mode and context, so the windows of
one recording go to different people. A task is kept as a record:

```jsonc
Task = {"schema": "electrotag.task", "schema_version": 1, "task_id": "t-<12 hex>",
  "recording_id", "file_name", "scope": "study",
  "window": null | {"start_sample": 2560, "end_sample": 5120},   // half-open, whole samples
  "k": 2, "annotators": ["A03", "A07"], "letters": {"A03": "B", "A07": "A"},
  "gold": null | {"set_id": "known"}, "blinded": false,
  "state": "open" | "closed" | "removed", "adopted": ["A03"],     // who had the recording before the task
  "created_at", "created_by", "request_id", "batch": "", "notes": "",
  "changes": [{"at", "by", "added"?, "removed"?, "state"?, "notes"?}]}
TaskOut = {"task_id", "recording_id", "file_name",
  "window": null | {"start_sample", "end_sample", "start_s", "end_s"},
  "k", "annotators", "letters", "gold", "blinded", "state": "open" | "closed",
  "created_at", "created_by", "batch", "notes", "status": Status,
  "people": [{"annotator_id", "letter", "attempt": 1 | null, "saved_at": "…" | null,
              "status": "todo" | "in_progress" | "done" | "unusable" | "closed"}],
  "counts": {"annotators", "saved", "in_progress", "unusable"},
  "conflicts": 3 | null,          // once all have saved and the conflicts are counted
  "adjudication": null | {"adjudicator_id", "state": "in_progress" | "finished", "conflicts", "decided"}}
```

Each annotator has a **letter** (A, B, ...) that stays theirs for the task's
life: the order comes from a keyed hash of the study's own secret, the task and
the person, so it says nothing about who was chosen first, and someone put in
later takes the next free letter. `blinded` is false (adjudicators see who made
each mark); it is kept for a later crowd study. **Statuses** are worked out
each time, never stored:

| Status | When |
| --- | --- |
| `collecting` | fewer than k of the task's people have saved it |
| `saved` | all have saved; the conflicts are not counted (no adjudication part registered) |
| `ready` | all have saved, and their versions conflict (`conflicts` > 0) |
| `agreed` | all have saved, without a conflict |
| `adjudicating` | an expert has started adjudicating it |
| `adjudicated` | the adjudication is finished |
| `gold` | a known-answer task (never adjudicated) |

**What an annotator receives.** Each item of `GET /assignments` and the answer
of `POST /match` (for the item it opens) carry `task`: null, or
`{"task_id", "window": {"start_sample", "end_sample", "start_s", "end_s"} | null}`.
Nothing in it says whether a task is a known answer. With a window, `PUT
/drafts` and `POST /submissions` refuse an annotation that is not wholly inside
it with 422 `outside_window`, naming the first in the message and every one in
`annotation_ids`; the browser hatches the rest of the recording, keeps the view
within the window and a second either side, refuses marks outside it, and
counts what has been viewed (`viewed_fraction`, the coverage check before Save
and Finish) within the window only.

**Known answers.** A task whose `gold` names a reference set is a known-answer
task: it goes to every person chosen (k does not apply), and the recording
must have a reference in that set (a set's own copy of the recording must be
the same file). After each save the annotations are compared with the
reference, within the window when there is one, as practice feedback compares
them (`electrotag.training.assessment.practice_feedback`), and the score is
kept as a record of kind `gold`, `{aid}_{task_id}`:
`{"schema": "electrotag.gold_score", "task_id", "annotator_id", "recording_id", "set_id", "window", "attempt",
"event_f1", "label_accuracy", "event_precision", "event_recall", "scored_at", "per_category", "attempts": [..]}`.
The annotator is told nothing of it. A save whose scoring was interrupted is
scored when `quality_list` is next asked for.

The administrative operations (`POST /admin/{op}`, `et_admin` on Firebase):

| op | body | answer |
| --- | --- | --- |
| `tasks_preview_get` | `{"annotator_ids": [pool], "recording_ids": [..] \| "all": true, "k"?: review.k_default, "window"?: {"start_s", "end_s"}, "windows"?: {"length_s", "overlap_s"?: 0}, "gold"?: {"set_id"}, "adopt"?: false}` | `{"tasks": [{"task_id": null, "recording_id", "file_name", "window", "k", "annotators", "holders", "gold"}], "skipped": [{"recording_id", "reason", "start_s"?}], "per_annotator": [{"annotator_id", "open_before", "new", "linked"}], "created", "assigned", "k"}`: what `tasks_create` would make, without making anything (a read: the browser may ask again) |
| `tasks_create` | as `tasks_preview_get`, with `"request_id": "<32 hex>"`, `"batch"?` (a name of up to 80 characters) and `"notes"?` | `{"tasks": [TaskOut], "created", "assigned", "skipped", "per_annotator", "already": false}`. The same `request_id` again makes nothing more (`already: true`, the tasks it made, and any of their assignments still missing). Audited (`tasks_create`) |
| `tasks_list` | `{"status"?, "recording_id"?, "annotator_id"?, "gold"?: bool}` | `{"tasks": [TaskOut], "counts": {status: n}}`, oldest first; removed tasks are not listed |
| `task_update` | `{"task_id", "add_annotator"?, "remove_annotator"?, "state"?: "open" \| "closed", "notes"?}` | `{"task": TaskOut}`. Both people in one request replace one by the other. Audited |
| `task_remove` | `{"task_id"}` | `{}`: the task and its unfinished assignments go (an assignment someone had before the task is given back without it); the record stays, marked removed. Audited |
| `quality_list` | `{}` | `{"annotators": [{"annotator_id", "n_gold", "mean_event_f1", "mean_label_accuracy", "weight": 0.83 \| null}], "min_items"}`: everyone in a known-answer task, with their mean scores over the known answers they saved; `weight` (the mean event F1) once they have saved `review.gold_min_items` of them, null before |

**How recordings are shared out.** `all` takes every study recording that is
not retired (one that is, given by name, is `skipped` as `retired`). A
recording with an open task is skipped (`has_task`). `window` gives every
recording the same stretch; `windows` cuts each into consecutive parts of
`length_s` (at least 2 s) that overlap by `overlap_s` (less than half a
part), and a remainder shorter than half a part joins the part before it. Each
task goes to the k people of the pool with the fewest open tasks they have not
saved yet, counting the tasks made earlier in the same request, with ties
broken by a fixed order (SHA-256 of the recording, the window's start and the
person), so the same request on the same study gives the same share-out and
200 recordings with k = 2 among 10 people give each person 40. People who
already hold the whole recording without a task come first for a task of the
whole recording, and their assignment joins the task (`holders`, `linked`);
they are left out of a window's task, which would shut them out of the rest of
the recording. A recording or window for which fewer than k people are free is
skipped as `too_few_annotators`. With `gold`, every person chosen gets each
task, and a recording without a reference in the set is skipped
(`no_gold_reference`, or `gold_mismatch` when the set's copy is another
file). With `adopt: true`, each recording already given to two to six of the
chosen people (without a task) becomes a task of exactly those people, with
their assignments joined to it (`fewer_than_two` and `too_many_annotators`
otherwise; `window`, `windows` and `gold` cannot be given with it).

**Changing a task.** A person put in gets the recording (409 `task_conflict`
when they hold it for another task, 409 `already_in_task`, 409 `closed` for a
closed task unless the same request reopens it); a person taken out loses
their unfinished assignment, and is refused once they have saved it (409
`has_results`). A task keeps 2 to 6 people (409 `too_few`, 400 `k_too_large`);
a known-answer task at least one. Closing a task takes its recording from the
lists of those who have not saved it and keeps every saved result with the
task; reopening gives it back to them. `task_remove` is refused once anyone has
saved the task (409 `has_results`): close it instead. Other errors: 400
`bad_request` (with the reason), 400 `k_too_large` (k above the people
chosen), 400 `too_many` (more than 5000 tasks at once), 404 `unknown_user`,
404 `unknown_recording`, 404 `unknown_task`, 404 `no_reference_set`, 409
`disabled` (a switched-off account).

The results zip and `electrotag web export` hold the tasks
(`tasks/tasks.tsv` and `tasks/tasks.json`, removed ones included) and the
known-answer scores (`tasks/gold_scores.tsv`; docs/file_formats.md). The
sandbox answers these operations with 501 `needs_server`: sharing out, the
letters and the scoring are the study server's own code.

### Adjudication and the library

Adjudication works as the dual screening of a systematic review does (Covidence, Rayyan). Two or
more people annotate the same recording independently; once they have all saved it, the study
compares their versions with the agreement analysis's matching rules and lists every
**conflict**; an expert who did not annotate it decides each one, and finishing saves the
**adjudicated version**, a derived version of its own. Adjudication is not blinded: the
adjudicator sees who made each mark. Nobody adjudicates what they annotated (409 `own_task`).
The code is `electrotag/reliability/conflicts.py` (finding conflicts, without web code),
`electrotag/web/adjudication.py` and `electrotag/web/library.py`.

What can be adjudicated is a **unit**, found afresh at every call:

| kind | unit ID | what is compared |
| --- | --- | --- |
| `task` | the task's `task_id` | the latest saved attempts of the task's annotators, within its window when it has one (known-answer tasks are never adjudicated) |
| `recording` | `r-` and 12 hexadecimal characters | a study recording given to (or saved by) two or more people without a task: everyone given it, except those who reported that it cannot be annotated, and everyone who saved it |
| `corrections` | `k-` and 12 hexadecimal characters | two or more experts' corrections of the same saved attempt (each corrector's latest), so that their disagreements are settled before the corrected version is used |

Its status is derived: `collecting` (someone has not saved yet), `ready` (all have, and there are
conflicts), `agreed` (all have, and nothing conflicts), `adjudicating` (started) and
`adjudicated` (finished). The versions compared carry letters (A, B, …; a task's own letters when
it has them, otherwise in the order of the people's IDs), which the keys of the adjudication view
use.

Conflicts are found with `matching.events_for` and `matching.match_events` (one-to-one,
preferring the same type) for every pair of versions, with the study's `review.matching` rules;
matched marks are joined across the pairs into **clusters**, and a cluster on which the versions
differ is a conflict of one or more kinds: `presence` (some versions have no mark there), `type`,
`timing` (an onset or an offset further apart than the tolerance), `channels` (the channels
overlap less than `channel_jaccard`; a whole-montage mark covers every channel) and `split` (one
version has two or more marks in it). A conflict's ID, `c-` and 16 hexadecimal characters, comes
from the people and annotation IDs of its marks, so it stays the same for the same versions.

`Conflict` = `{"conflict_id", "kinds": ["type"], "onset_sample", "offset_sample", "onset_s",
"offset_s", "marks": [{"letter", "annotator_id", "display_name", "annotation_id", "label",
"onset_sample", "duration_samples", "onset_s", "offset_s", "channels", "confidence", "note"}],
"missing": ["B"], "missing_ids": ["A02"], "labels": [..], "pair": [a, b] | null, "decision":
null | {"choice", "marks", "reason_code", "reason", "decided_at", "decided_by", "result":
[Annotation]}}`. `pair` names the two types of a type conflict; `result` is what the decision
keeps.

`UnitOut` = `{"unit_id", "task_id" (tasks only, otherwise null), "kind", "recording_id",
"file_name", "window": null | {"start_sample", "end_sample", "start_s", "end_s"}, "k", "saved",
"annotators": [{"letter", "annotator_id", "display_name", "saved"}], "corrected": null |
{"annotator_id", "attempt"}, "status", "conflicts", "agreed", "decided", "adjudicator_id",
"adjudicator_name", "started_at", "finished_at", "yours", "own", "notes"}`; `own` is true when the
caller's work is part of it.

| op | body | answer | saves? |
| --- | --- | --- | --- |
| `adjudication_list` | `{"status"?, "recording_id"?}` | `{"units": [UnitOut], "counts": {status: n}, "total"}`: the queue, those in progress first. A unit whose versions cannot be read is left out | read |
| `adjudication_get` | `{"unit_id"}` (`task_id` is taken too) | `{"unit": UnitOut, "adjudication": Adjudication \| null, "versions": [{"letter", "annotator_id", "display_name", "source": "original" \| "correction", "attempt", "number", "annotations": [Annotation]}], "conflicts": [Conflict], "agreed": [{"cluster_id", "mark": Annotation, "letters"}], "manifest": Manifest, "file_name", "blinded": false, "rules", "progress": {"conflicts", "decided"}, "reason_required", "reason_codes"}`: once started, from the versions frozen then. 409 `not_ready` while someone has not saved, `own_task`; 404 `not_found` | read |
| `adjudication_start` | `{"unit_id"}` | as `adjudication_get`, with `"already"`: freezes the inputs (each version's attempt, session and the SHA-256 of its `_annotations.json`) and the matching rules. Starting one's own again is the same adjudication. 409 `not_ready` (not all saved, or nothing conflicts), `own_task`, `taken` (with `adjudicator_id`). Audited (`adjudication_start`) | **save** |
| `adjudication_decide` | `{"unit_id", "conflict_id", "choice", "marks"?, "reason_code"?, "reason"?}` | `{"conflict": Conflict, "progress", "already"}`. `choice` is a letter (that version's marks as they are), `all` (every version's marks, one mark per type spanning that type's marks, on the channels they cover together), `none`, or `edited` with 1 to 5 `marks` (annotations, given IDs of their own). A reason is needed as `review.reason_required` says: `always`, `edited_or_none`, or `never`; it is a `reason_code` (`clear_artifact`, `not_artifact`, `type_evidence`, `boundary_evidence`, `channels_evidence`, `both_valid`, `other`, which needs words) or a `reason` of at most 200 characters on one line. The same decision again changes nothing; a decision can be changed until the adjudication is finished. 409 `not_started`, `not_yours`, `finished`; 422 `unknown_conflict`, `invalid_choice`, `reason_missing`, `invalid_annotation`, `outside_window`. Audited, with the reason's length only | **save** |
| `adjudication_finish` | `{"unit_id"}` | `{"adjudication": Adjudication, "version": {"attempt", "output_basename", "session_id", "n_annotations", "files"}, "already"}`: saves the adjudicated version (the agreed marks, each at the median onset and offset of its marks on the channels most of them cover, and the decided marks) with the journalled save into `derived/adjudications/annotator-ADJUDICATED/`, display name "Adjudicated (E01)", and `context.derived = {"kind": "adjudication", "task_id", "unit_kind", "adjudicator_id", "inputs", "rules", "window", "corrected", "n_conflicts", "decisions_sha256", "blinded": false}`. Saved once: an answer lost on its way is found again by its session ID. 409 `undecided` (with `n`). Audited | **save** |
| `adjudication_reference` | `{"unit_id", "set_id", "use", "provenance"?}` | the answer of `set_add_reference` with the Source `{"kind": "adjudication", "task_id": "<unit ID>"}`, which the admin operation takes too: method `adjudicated`, the versions' people as the experts, the adjudicator, and the adjudicated file and the versions' files as its sources. 409 `not_finished`; 422 `window_task` for a unit with a window (a reference covers the whole recording) | **save** |
| `tasks_list` | `{"status"?, "recording_id"?}` | `{"tasks": [TaskOut], "counts": {status: n}}` (docs above, "Tasks, windows and known answers"), known-answer tasks left out; the conflicts of a task whose annotators have all saved are counted, and the count is kept for as long as the same versions are compared. The adjudication part registers the counter that tells `ready` from `agreed` (`tasks.register_conflict_counter`) | read |
| `library_list` | `{"label"?, "pair"?: [a, b] \| "a\|b", "annotator_id"?, "status"?: "awaiting" \| "open" \| "decided", "choice"?: "one" \| "all" \| "none" \| "edited" \| letter, "kind"?, "recording_id"?, "q"?, "offset"?: 0, "limit"?: 200 (at most 500)}` | `{"entries": [LibraryEntry], "total", "facets": {"labels", "pairs", "kinds", "choices", "status", "annotators", "recordings"}, "filters", "sets": [{"set_id", "name", "none_option"}]}`: the conflicts of every unit that has some, derived afresh; the facets count every entry. `q` searches the file name, the types and the reasons | read |
| `library_promote` | `{"promote_id": "<32 hex>", "entry_id", "to": "quiz_item" \| "snippet", "set_id", "label"?, "explanation"?, "start_s"?, "end_s"?, "context_s"?: 2.0}` | `{"item": QuizItem}` or `{"snippet": Snippet}`, with `"already"`. The label and times start from the decision (the conflict's when nothing is kept), the explanation from the reason; the item keeps `source: {"library_entry", "task_id", "conflict_id", "promote_id", "promoted_by", "promoted_at", "kinds", "decision"}`. The same `promote_id`, or the same entry promoted to the same set again, gives what was made before. A self-contained set gets a copy of the recording's manifest, as for a reference. 409 `undecided` without a label for a conflict not yet decided; 404 `unknown_entry`. Audited | **save** |

`Adjudication` (records of kind `adjudications`, one per unit, kept under the adjudicator) =
`{"unit_id", "task_id", "unit_kind", "recording_id", "file_name", "window", "corrected",
"adjudicator_id", "adjudicator_name", "state": "in_progress" | "finished", "started_at",
"finished_at", "blinded": false, "inputs": {person: {"letter", "source", "annotator_id",
"attempt", "session_id", "output_basename", "annotations_sha256", "number"?, "correction_id"?}},
"letters", "rules", "decisions": {conflict_id: {"choice", "marks", "reason_code", "reason",
"decided_at", "decided_by"}}, "version", "counts": {"conflicts", "decided", "agreed"}}`.
`blinded` is kept for a future crowd study that hides who made each mark.

`LibraryEntry` = `{"entry_id": "<unit ID>:<conflict ID>", "task_id", "unit_id", "unit_kind",
"conflict_id", "recording_id", "file_name", "window", "kinds", "labels", "pair", "onset_s",
"offset_s", "onset_sample", "offset_sample", "marks", "missing", "missing_ids", "annotators",
"letters", "status", "decision", "adjudicator_id", "finished"}`. Nothing of the library is stored
apart from what is promoted. `Snippet` = `{"snippet_id": "s01", "recording_id", "start_s",
"end_s", "label", "explanation", "context_s", "source"}`, kept in the reference set's
`snippets`.

In `GET /me/feedback`, the `adjudications` part lists, newest first, each finished adjudication
that compared the caller's version: `{"task_id", "unit_kind", "recording_id", "file_name",
"finished_at", "window", "conflicts": [{"conflict_id", "kinds", "onset_s", "offset_s",
"yours": [mark], "others": [{"label", "onset_s", "offset_s", "channels"}], "decision":
{"outcome": "yours_kept" | "other_kept" | "all_kept" | "none_kept" | "edited", "marks":
[Annotation], "reason", "reason_code", "reason_text"}}]}`. Nobody else is named, the adjudicator
included.

The sandbox cannot find conflicts (that needs the study's Python code), so it answers each of
these operations with 501 `needs_server`.

### Derived versions in the analyses

The agreement analysis's choice of versions (`versions`: original, corrected
or adjudicated) is described here when it is offered; until then every
analysis uses the original annotations and leaves derived versions out.

## The same operations on Firebase

On Firebase every operation above is a callable Cloud Function (Python, 2nd
generation, region europe-west2) taking and returning the same JSON:
`et_me`, `et_assignments`, `et_match`, `et_put_draft`, `et_delete_draft`,
`et_submit`, `et_training`, `et_guided_get`, `et_guided_check`,
`et_guided_continue`, `et_guided_show_me`, `et_visit_open`, `et_visit_events`,
`et_visit_close`, `et_quiz`, `et_achievements`, `et_problem_report`, `et_my_reviews`,
`et_my_feedback`, `et_training_stage`, `et_training_snippets`, for experts and
administrators `et_expert` (every operation of the expert area, by `op`) and,
for administrators, `et_admin_progress` and `et_admin` (every operation of the
admin area, by `op`; it has 2 GB of memory and up to 540 s for the analyses and
the results zip). Each takes
`{"study": "<study id>", ...the request body...}` (path parameters such as the
recording ID become fields). Signing in uses Firebase Authentication (email and
password) in the browser; the annotator ID and role are custom claims set when
the account is made (`user_add`, or the administrator's command `add-user`) and whenever its roles change, and
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
| `et_me`, `et_assignments`, `et_training`, `et_admin_progress` | none |
| `et_match` | the body of `POST /match` |
| `et_put_draft` | `{"recording_id", "mode", "context_id", "draft": Draft}` |
| `et_delete_draft` | `{"recording_id", "mode", "context_id", "session_id"?}` |
| `et_submit` | the body of `POST /submissions` |
| `et_guided_get` | `{"recording_id"}` |
| `et_guided_check`, `et_guided_continue`, `et_guided_show_me` | `{"recording_id", ...the body of the request}` |
| `et_visit_open` | the body of `POST /visits` |
| `et_visit_events`, `et_visit_close` | `{"visit_id", ...the body of the request}` |
| `et_admin` | `{"op", ...the body of `POST /admin/{op}`}` |
| (none) | `POST /invite/check` and `POST /invite/accept` have no function: on Firebase `user_invite` answers Firebase Authentication's `invite_link` |
| `et_quiz` | `{"set_id", ...the body of `POST /quiz/{set_id}`}` |
| `et_achievements` | none for `GET /me/achievements`; `{"goal_per_week"}` or `{"leaderboard_hidden"}` for `POST` |
| `et_problem_report` | the body of `POST /problems` (never repeated by the browser; the same `problem_id` is kept once) |
| `et_my_reviews` | none (`GET /me/reviews`) |
| `et_my_feedback` | none (`GET /me/feedback`) |
| `et_training_stage` | the body of `POST /training/stage` (never repeated by the browser) |
| `et_training_snippets` | none (`GET /training/snippets`) |
| `et_expert` | `{"op", ...the body of `POST /expert/{op}`}`; only an `op` ending in `_get` or `_list` is asked again after a failure |

There is no `token` and no beacon on Firebase: the Firebase SDK adds the ID
token; to send the last events when the page is hidden, call `et_visit_events`
with `fetch(…, {keepalive: true})` or simply on the next visit. The admin
area downloads the results with `et_admin` `results_zip` (up to 25 MB); larger
studies export them with `electrotag web export` (docs/web/firebase.md).

The HTTP status of an error becomes the `HttpsError` code: 400 and 413
`invalid-argument`, 401 `unauthenticated`, 403 `permission-denied`, 404
`not-found`, 409 `already-exists`, 422 `failed-precondition`, 429
`resource-exhausted`, 500 `internal`, 501 `unimplemented`. `details` is the error body
(`{"error": "<code>", "message": "…", …}`). A caller whose claims do not name
the study, or who has no account in it, gets `permission-denied` with error
`not_in_study`.

The custom claims are `{"annotator_id": "A01", "role": "annotator", "roles": {"<study>": ["annotator", …]},
"studies": ["<study>"]}`: for each study the person's roles, as a list (claims
written before roles became a set hold one role as a string, which is read as
a list of one), and `role` the primary role. A person keeps one annotator ID in
every study of a project. A privileged role (`expert`, `admin`) counts only
when both the claims and the person's account in the study grant it: the
functions use the account's roles less any privileged role the claims do not
name, so a role taken away in the study counts at once and one just given
counts once the browser's token has been refreshed.

The application learns about the Firebase project from `config.json` beside
it, which `electrotag web config` writes:
`{"firebase": {"apiKey", "authDomain", "projectId", "appId", …}, "study": "<study id>",
"functions_region": "europe-west2"}`.
