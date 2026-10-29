"""ElectroTag's Cloud Functions (Python, 2nd generation, region europe-west2).

Each function is a *callable* taking ``{"study": "<study id>", ...}`` plus the request of
docs/web/api.md and returning the same JSON as the ElectroTag server. The caller must be signed in
with Firebase Authentication; their annotator ID and role are custom claims set by the
administrator's command (``electrotag-web add-user``). Errors are ``HttpsError`` with the API's
error code in ``details["error"]``.

The work is done by :class:`electrotag.web.service.StudyService` with the Firestore store, the same
code as the ElectroTag server. Only ``firebase_functions`` is imported when an instance starts;
ElectroTag is imported on the first call, and the heavy libraries (pandas, SciPy, matplotlib) only
by practice scoring, competency reports and the admin area's analyses, so guided checks answer
quickly. ``et_admin`` (every operation of the admin area, by ``op``) is for administrators only: the
service refuses anyone whose claims and account in the study do not both make them one.

Deploy with ``npx firebase-tools deploy --only functions,firestore`` (docs/web/firebase.md); the
predeploy step copies the ElectroTag code these functions need into this folder.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from typing import Any

import firebase_admin
from firebase_functions import https_fn, options

if not firebase_admin._apps:  # the callables check sign-in tokens with the default app
    firebase_admin.initialize_app()

REGION = "europe-west2"
options.set_global_options(region=REGION, memory=options.MemoryOption.MB_512, timeout_sec=120, max_instances=20)

STUDY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_services: dict[str, Any] = {}
_lock = threading.Lock()
log = logging.getLogger("electrotag.functions")


def _project() -> str:
    for name in ("GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"):
        if os.environ.get(name):
            return os.environ[name]
    import json

    cfg = json.loads(os.environ.get("FIREBASE_CONFIG") or "{}")
    return str(cfg.get("projectId", ""))


def service_for(study: str) -> Any:
    """The service of one study (kept for the life of this instance)."""
    with _lock:
        svc = _services.get(study)
        if svc is None:
            from electrotag.web.firebase import firestore_client
            from electrotag.web.service import StudyService
            from electrotag.web.store_firestore import FirestoreStore

            svc = StudyService(FirestoreStore(firestore_client(_project()), study, auth_app=firebase_admin.get_app()))
            _services[study] = svc
        return svc


def _fail(code: str, error: str, message: str) -> https_fn.HttpsError:
    return https_fn.HttpsError(https_fn.FunctionsErrorCode(code), message, {"error": error, "message": message})


def handle(operation: str, req: https_fn.CallableRequest) -> Any:
    """Answer one call: check who is calling, then run the operation."""
    from electrotag.web.errors import ApiError
    from electrotag.web.firebase import role_in
    from electrotag.web.store import StoreError, User

    data = req.data if isinstance(req.data, dict) else {}
    study = data.get("study")
    if not isinstance(study, str) or not STUDY_RE.match(study):
        raise _fail("invalid-argument", "bad_request", "The request must name the study (\"study\")")
    if req.auth is None:
        raise _fail("unauthenticated", "not_signed_in", "Please sign in (again): your session has ended.")
    claims = dict(req.auth.token or {})
    aid = str(claims.get("annotator_id") or "")
    role = role_in(claims, study)
    if not aid or role is None:
        raise _fail("permission-denied", "not_in_study", "Your account does not take part in this study. Ask your "
                    "study administrator.")
    try:
        svc = service_for(study)
        member = svc.store.user(aid)
        if member is None:
            raise _fail("permission-denied", "not_in_study", "Your account does not take part in this study. Ask "
                        "your study administrator.")
        # An administrator only when both the claims and the study say so.
        user = User(aid, member.display_name, "admin" if role == "admin" and member.role == "admin" else "annotator")
        body = {k: v for k, v in data.items() if k != "study"}
        return svc.call(operation, user, body)
    except ApiError as exc:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode(exc.firebase_code), exc.message, exc.body()) from exc
    except StoreError as exc:
        raise _fail("not-found", "no_study", str(exc)) from exc
    except https_fn.HttpsError:
        raise
    except Exception as exc:  # noqa: BLE001 - never send a stack trace to the browser
        log.exception("Unexpected error in %s for study %s", operation, study)
        raise _fail("internal", "internal", "Something went wrong on the server. Please try again; if it happens "
                    "again, tell the study administrator.") from exc


@https_fn.on_call()
def et_me(req: https_fn.CallableRequest) -> Any:
    return handle("me", req)


@https_fn.on_call()
def et_assignments(req: https_fn.CallableRequest) -> Any:
    return handle("assignments", req)


@https_fn.on_call()
def et_match(req: https_fn.CallableRequest) -> Any:
    return handle("match", req)


@https_fn.on_call()
def et_put_draft(req: https_fn.CallableRequest) -> Any:
    return handle("put_draft", req)


@https_fn.on_call()
def et_delete_draft(req: https_fn.CallableRequest) -> Any:
    return handle("delete_draft", req)


@https_fn.on_call(memory=options.MemoryOption.GB_1, timeout_sec=300)
def et_submit(req: https_fn.CallableRequest) -> Any:
    return handle("submit", req)


@https_fn.on_call()
def et_training(req: https_fn.CallableRequest) -> Any:
    return handle("training", req)


@https_fn.on_call()
def et_guided_get(req: https_fn.CallableRequest) -> Any:
    return handle("guided_get", req)


@https_fn.on_call(min_instances=0)
def et_guided_check(req: https_fn.CallableRequest) -> Any:
    return handle("guided_check", req)


@https_fn.on_call()
def et_guided_continue(req: https_fn.CallableRequest) -> Any:
    return handle("guided_continue", req)


@https_fn.on_call()
def et_guided_show_me(req: https_fn.CallableRequest) -> Any:
    return handle("guided_show_me", req)


@https_fn.on_call()
def et_visit_open(req: https_fn.CallableRequest) -> Any:
    return handle("visit_open", req)


@https_fn.on_call()
def et_visit_events(req: https_fn.CallableRequest) -> Any:
    return handle("visit_events", req)


@https_fn.on_call()
def et_visit_close(req: https_fn.CallableRequest) -> Any:
    return handle("visit_close", req)


@https_fn.on_call()
def et_admin_progress(req: https_fn.CallableRequest) -> Any:
    return handle("admin_progress", req)


# The admin area: every operation by "op" (administrators only). The analyses (agreement, activity,
# competency reports, the results zip) and registering many recordings need more memory and time.
@https_fn.on_call(memory=options.MemoryOption.GB_2, timeout_sec=540, max_instances=5)
def et_admin(req: https_fn.CallableRequest) -> Any:
    return handle("admin", req)


@https_fn.on_call()
def et_quiz(req: https_fn.CallableRequest) -> Any:
    return handle("quiz", req)


# The annotator's counters, milestones' facts, personal goal, team progress and anonymised
# leaderboard; with goal_per_week or leaderboard_hidden it also changes them.
@https_fn.on_call()
def et_achievements(req: https_fn.CallableRequest) -> Any:
    return handle("achievements", req)


# A problem an annotator reports with a recording (saved once, whatever the number of presses), and
# the reviews of their saved work (docs/web/api.md, "Problem reports" and "Reviews").
@https_fn.on_call()
def et_problem_report(req: https_fn.CallableRequest) -> Any:
    return handle("problem_report", req)


@https_fn.on_call()
def et_my_reviews(req: https_fn.CallableRequest) -> Any:
    return handle("my_reviews", req)
