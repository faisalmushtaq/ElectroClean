"""The ElectroTag server: the web service over HTTP (FastAPI), with the files store.

Used to test the browser application locally, for the demonstration (``electrotag-web demo``)
and by a study that prefers its own server to Firebase. It serves the browser application from
``/`` and the API of docs/web/api.md under ``/api/v1``.

Security: sign-in returns a bearer token (kept only as a hash; it expires after 12 hours without use
and on sign-out); every API request except ``GET /health`` must carry ``X-ElectroTag: 1`` (so a
page on another site cannot send requests with a simple form); CORS answers only the origins in
``ELECTROTAG_ALLOWED_ORIGINS``; sign-in attempts and requests are rate limited; request bodies are
limited in size; errors never include a stack trace. The token of an invitation link
(``?invite=…``, when this server also serves the page) is blanked in the access log.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from collections import deque
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

from electrotag import __version__
from electrotag.web import API_PREFIX
from electrotag.web.accounts import TOKEN_IDLE_S
from electrotag.web.errors import ApiError
from electrotag.web.service import StudyService
from electrotag.web.store import User
from electrotag.web.store_files import FilesStore

log = logging.getLogger("electrotag.web")
STATIC_DIR = Path(__file__).resolve().parent / "static"
MAX_BODY = 16 * 1024 * 1024
PAGES_ORIGIN = "https://faisalmushtaq.github.io"
BEACON_PATHS = ("/events", "/close")

PLACEHOLDER = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ElectroTag server</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1d2433}
code{background:#eef1f6;padding:0 .3em;border-radius:3px}</style></head>
<body><h1>ElectroTag server</h1>
<p>The study server for <b>{study}</b> is running (ElectroTag {version}). The browser application is not
included in this copy (<code>electrotag/web/static/</code> is empty), so open it from GitHub Pages and
point it at this server, or install a version of ElectroTag that includes it.</p>
<p>The API is at <code>{prefix}</code>; <a href="{prefix}/health">{prefix}/health</a> answers without
signing in.</p></body></html>
"""


def allowed_origins_from_env(value: str | None = None) -> list[str]:
    raw = os.environ.get("ELECTROTAG_ALLOWED_ORIGINS", "") if value is None else value
    return [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]


_INVITE_IN_ADDRESS = re.compile(r"([?&]invite=)[^&#\s\"]*")


class HideInvitations(logging.Filter):
    """Blanks the token of an invitation link in the access log: the page is opened with
    ``?invite=<token>``, and the log must not hold a way into somebody's account."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and any(isinstance(a, str) and "invite=" in a for a in record.args):
            record.args = tuple(_INVITE_IN_ADDRESS.sub(r"\1(hidden)", a) if isinstance(a, str) else a
                                for a in record.args)
        if isinstance(record.msg, str) and "invite=" in record.msg:
            record.msg = _INVITE_IN_ADDRESS.sub(r"\1(hidden)", record.msg)
        return True


def hide_invitations_in_access_log() -> None:
    """Install :class:`HideInvitations` on the server's access log (once)."""
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, HideInvitations) for f in access.filters):
        access.addFilter(HideInvitations())


class RateLimiter:
    """At most ``limit`` events per ``window_s`` seconds for each key (in memory)."""

    def __init__(self, limit: int, window_s: float) -> None:
        self.limit, self.window_s = limit, window_s
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _q(self, key: str, now: float) -> deque[float]:
        q = self._hits.setdefault(key, deque())
        while q and now - q[0] > self.window_s:
            q.popleft()
        if len(self._hits) > 10000:  # forget idle keys
            for k in [k for k, v in self._hits.items() if not v]:
                del self._hits[k]
        return q

    def blocked(self, key: str) -> bool:
        with self._lock:
            return len(self._q(key, time.monotonic())) >= self.limit

    def hit(self, key: str) -> bool:
        """Record one event; True if the key is now over its limit."""
        with self._lock:
            now = time.monotonic()
            q = self._q(key, now)
            q.append(now)
            return len(q) > self.limit


def error_response(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": code, "message": message, **extra}, status_code=status)


def create_app(study_dir: Path | str, *, demo: bool = False, allowed_origins: list[str] | None = None,
               demo_zip: Path | None = None, static_dir: Path | None = None,
               request_limit_per_minute: int = 1200) -> FastAPI:
    """The server for the study in ``study_dir``."""
    hide_invitations_in_access_log()
    store = FilesStore(study_dir, demo=demo)
    service = StudyService(store)
    origins = set(allowed_origins if allowed_origins is not None else allowed_origins_from_env())
    if demo:
        origins.add(PAGES_ORIGIN)
    static = Path(static_dir) if static_dir is not None else STATIC_DIR
    login_ids = RateLimiter(10, 15 * 60)  # failed sign-ins per annotator ID
    login_ips = RateLimiter(50, 15 * 60)  # failed sign-ins per address
    requests = RateLimiter(request_limit_per_minute, 60)

    app = FastAPI(title="ElectroTag server", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.service = service
    app.state.store = store
    app.state.allowed_origins = origins

    # ------------------------------------------------------------ middleware
    @app.middleware("http")
    async def guard(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        path = request.url.path
        origin = request.headers.get("origin", "").rstrip("/")
        same_origin = origin and origin == f"{request.url.scheme}://{request.url.netloc}"
        api = path.startswith(API_PREFIX + "/") or path == API_PREFIX
        health = path == f"{API_PREFIX}/health"
        cors_path = api or path == "/demo/recordings.zip"
        allowed = bool(origin) and (origin in origins or same_origin)

        def with_cors(resp: Response) -> Response:
            if health:
                resp.headers["Access-Control-Allow-Origin"] = "*"
            elif cors_path and allowed:
                resp.headers["Access-Control-Allow-Origin"] = origin
                resp.headers["Vary"] = "Origin"
                resp.headers["Access-Control-Expose-Headers"] = "Content-Disposition"
            resp.headers["X-Content-Type-Options"] = "nosniff"
            resp.headers["Referrer-Policy"] = "no-referrer"
            resp.headers["X-Frame-Options"] = "DENY"
            resp.headers["Content-Security-Policy"] = "frame-ancestors 'none'"
            if api:
                resp.headers["Cache-Control"] = "no-store"
            return resp

        if request.method == "OPTIONS" and cors_path:
            resp = Response(status_code=204)
            if health or allowed:
                resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
                resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-ElectroTag"
                resp.headers["Access-Control-Max-Age"] = "600"
                if request.headers.get("access-control-request-private-network") == "true":
                    # The application on GitHub Pages calling a server on this computer (Chrome asks first).
                    resp.headers["Access-Control-Allow-Private-Network"] = "true"
            return with_cors(resp)
        if api:
            client = request.client.host if request.client else "unknown"
            if requests.hit(client):
                return with_cors(error_response(429, "rate_limited", "Too many requests; wait a minute and try "
                                                "again."))
            size = request.headers.get("content-length")
            if size is not None and (not size.isdigit() or int(size) > MAX_BODY):
                return with_cors(error_response(413, "too_large", "The request is too large"))
            beacon = (request.method == "POST" and path.endswith(BEACON_PATHS) and "/visits/" in path
                      and request.headers.get("content-type", "").startswith("text/plain"))
            if not health and not beacon and request.headers.get("x-electrotag") != "1":
                return with_cors(error_response(403, "missing_header", "Requests must carry the header "
                                                "X-ElectroTag: 1"))
        try:
            resp = await call_next(request)
        except Exception:  # noqa: BLE001 - never show a stack trace
            log.exception("Unexpected error answering %s %s", request.method, path)
            resp = error_response(500, "internal", "Something went wrong on the server. Please try again; if it "
                                  "happens again, tell the study administrator.")
        return with_cors(resp)

    # -------------------------------------------------------- error answers
    @app.exception_handler(ApiError)
    async def api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(exc.body(), status_code=exc.status)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> Response:
        if request.url.path.startswith(API_PREFIX) or exc.status_code != 404:
            code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "error")
            return error_response(exc.status_code, code, str(exc.detail))
        return HTMLResponse("<!doctype html><title>Not found</title><p>Not found.</p>", status_code=404)

    @app.exception_handler(Exception)
    async def internal_error(request: Request, exc: Exception) -> JSONResponse:
        log.exception("Unexpected error answering %s %s", request.method, request.url.path, exc_info=exc)
        return error_response(500, "internal", "Something went wrong on the server. Please try again; if it happens "
                              "again, tell the study administrator.")

    # ------------------------------------------------------------- helpers
    async def body_of(request: Request, *, allow_text: bool = False) -> dict[str, Any]:
        raw = await request.body()
        if len(raw) > MAX_BODY:
            raise ApiError(413, "too_large", "The request is too large")
        if not raw:
            return {}
        ctype = request.headers.get("content-type", "")
        if not (ctype.startswith("application/json") or (allow_text and ctype.startswith("text/plain"))):
            raise ApiError(415, "bad_content_type", "Send JSON (Content-Type: application/json)")
        try:
            data = json.loads(raw)
        except ValueError as exc:
            raise ApiError(400, "bad_request", "The request is not valid JSON") from exc
        if not isinstance(data, dict):
            raise ApiError(400, "bad_request", "The request must be a JSON object")
        return data

    def bearer(request: Request) -> str:
        auth = request.headers.get("authorization", "")
        return auth[7:].strip() if auth.lower().startswith("bearer ") else ""

    def user_for(token: str) -> User:
        user = store.db.user_for_token(token) if token else None
        if user is None:
            raise ApiError(401, "not_signed_in", "Please sign in (again): your session has ended.")
        return user

    async def run(op: str, user: User, body: dict[str, Any]) -> JSONResponse:
        result = await run_in_threadpool(service.call, op, user, body)
        return JSONResponse(result)

    async def authed(request: Request, op: str, body: dict[str, Any] | None = None) -> JSONResponse:
        user = await run_in_threadpool(user_for, bearer(request))
        return await run(op, user, body or {})

    # -------------------------------------------------------------- routes
    p = API_PREFIX

    @app.get(f"{p}/health")
    async def health() -> JSONResponse:
        return JSONResponse(service.health())

    @app.post(f"{p}/login")
    async def login(request: Request) -> JSONResponse:
        body = await body_of(request)
        aid = str(body.get("annotator_id") or "").strip().upper()[:64]
        password = body.get("password")
        client = request.client.host if request.client else "unknown"
        if login_ids.blocked(aid) or login_ips.blocked(client):
            raise ApiError(429, "too_many_attempts", "Too many unsuccessful sign-ins; wait 15 minutes and try again.")
        if not isinstance(password, str) or not aid:
            raise ApiError(400, "bad_request", "Give your ID and password")
        user = await run_in_threadpool(store.db.authenticate, aid, password)
        if user is None:
            login_ids.hit(aid)
            login_ips.hit(client)
            raise ApiError(401, "bad_credentials", "The ID or password is not right.")
        token = await run_in_threadpool(store.db.issue_token, user)
        return session_answer(user, token)

    def session_answer(user: User, token: str) -> JSONResponse:
        return JSONResponse({"token": token, "expires_in_s": TOKEN_IDLE_S, "annotator_id": user.annotator_id,
                             "display_name": user.display_name, "role": user.role, "roles": list(user.roles)})

    async def invite_guard(request: Request) -> tuple[dict[str, Any], str]:
        """The body of an invitation request, refused while its address has failed too often."""
        body = await body_of(request)
        client = request.client.host if request.client else "unknown"
        if login_ips.blocked(client):
            raise ApiError(429, "too_many_attempts", "Too many unsuccessful attempts; wait 15 minutes and try "
                           "again.")
        return body, client

    @app.post(f"{p}/invite/check")
    async def invite_check(request: Request) -> JSONResponse:
        """Whose invitation a private link is (no sign-in: the link's token is the proof)."""
        body, client = await invite_guard(request)
        try:
            return JSONResponse(await run_in_threadpool(service.invite_check, body))
        except ApiError as exc:
            if exc.code.startswith("invite_"):
                login_ips.hit(client)
            raise

    @app.post(f"{p}/invite/accept")
    async def invite_accept(request: Request) -> JSONResponse:
        """The person chooses their password with the link's token and is signed in."""
        body, client = await invite_guard(request)
        try:
            user = await run_in_threadpool(service.invite_accept, body)
        except ApiError as exc:
            if exc.code.startswith("invite_"):
                login_ips.hit(client)
            raise
        return session_answer(user, await run_in_threadpool(store.db.issue_token, user))

    @app.post(f"{p}/logout")
    async def logout(request: Request) -> JSONResponse:
        token = bearer(request)
        if token:
            await run_in_threadpool(store.db.revoke_token, token)
        return JSONResponse({})

    @app.get(f"{p}/me")
    async def me(request: Request) -> JSONResponse:
        return await authed(request, "me")

    @app.get(f"{p}/me/achievements")
    async def achievements(request: Request) -> JSONResponse:
        return await authed(request, "achievements")

    @app.post(f"{p}/me/achievements")
    async def achievements_update(request: Request) -> JSONResponse:
        return await authed(request, "achievements", await body_of(request))

    @app.get(f"{p}/me/reviews")
    async def my_reviews(request: Request) -> JSONResponse:
        return await authed(request, "my_reviews")

    @app.get(f"{p}/me/feedback")
    async def my_feedback(request: Request) -> JSONResponse:
        return await authed(request, "my_feedback")

    @app.post(f"{p}/problems")
    async def problem_report(request: Request) -> JSONResponse:
        return await authed(request, "problem_report", await body_of(request))

    @app.get(f"{p}/assignments")
    async def assignments(request: Request) -> JSONResponse:
        return await authed(request, "assignments")

    @app.post(f"{p}/match")
    async def match(request: Request) -> JSONResponse:
        return await authed(request, "match", await body_of(request))

    @app.put(p + "/drafts/{recording_id:path}")
    async def put_draft(request: Request, recording_id: str, mode: str = "standard", context: str = "") -> JSONResponse:
        draft = await body_of(request)
        return await authed(request, "put_draft", {"recording_id": recording_id, "mode": mode, "context_id": context,
                                                   "draft": draft})

    @app.delete(p + "/drafts/{recording_id:path}")
    async def delete_draft(request: Request, recording_id: str, mode: str = "standard",
                           context: str = "", session: str = "") -> JSONResponse:
        return await authed(request, "delete_draft", {"recording_id": recording_id, "mode": mode,
                                                      "context_id": context, "session_id": session})

    @app.post(f"{p}/submissions")
    async def submissions(request: Request) -> JSONResponse:
        return await authed(request, "submit", await body_of(request))

    @app.get(f"{p}/training")
    async def training(request: Request) -> JSONResponse:
        return await authed(request, "training")

    @app.post(f"{p}/training/stage")
    async def training_stage(request: Request) -> JSONResponse:
        return await authed(request, "training_stage", await body_of(request))

    @app.get(f"{p}/training/snippets")
    async def training_snippets(request: Request) -> JSONResponse:
        return await authed(request, "training_snippets")

    @app.post(p + "/training/guided/{recording_id:path}/check")
    async def guided_check(request: Request, recording_id: str) -> JSONResponse:
        return await authed(request, "guided_check", {**await body_of(request), "recording_id": recording_id})

    @app.post(p + "/training/guided/{recording_id:path}/continue")
    async def guided_continue(request: Request, recording_id: str) -> JSONResponse:
        return await authed(request, "guided_continue", {**await body_of(request), "recording_id": recording_id})

    @app.post(p + "/training/guided/{recording_id:path}/show-me")
    async def guided_show_me(request: Request, recording_id: str) -> JSONResponse:
        return await authed(request, "guided_show_me", {**await body_of(request), "recording_id": recording_id})

    @app.get(p + "/training/guided/{recording_id:path}")
    async def guided_get(request: Request, recording_id: str) -> JSONResponse:
        return await authed(request, "guided_get", {"recording_id": recording_id})

    @app.post(f"{p}/visits")
    async def visit_open(request: Request) -> JSONResponse:
        return await authed(request, "visit_open", await body_of(request))

    async def beacon(request: Request, op: str, visit_id: str) -> JSONResponse:
        body = await body_of(request, allow_text=True)
        token = bearer(request) or str(body.pop("token", "") or "")
        user = await run_in_threadpool(user_for, token)
        return await run(op, user, {**body, "visit_id": visit_id})

    @app.post(p + "/visits/{visit_id}/events")
    async def visit_events(request: Request, visit_id: str) -> JSONResponse:
        return await beacon(request, "visit_events", visit_id)

    @app.post(p + "/visits/{visit_id}/close")
    async def visit_close(request: Request, visit_id: str) -> JSONResponse:
        return await beacon(request, "visit_close", visit_id)

    @app.get(f"{p}/admin/progress")
    async def admin_progress(request: Request) -> JSONResponse:
        return await authed(request, "admin_progress")

    @app.get(f"{p}/admin/results.zip")
    async def admin_results(request: Request) -> FileResponse:
        user = await run_in_threadpool(user_for, bearer(request))
        if not user.is_admin:
            raise ApiError(403, "forbidden", "Only study administrators can download the results")
        path = await run_in_threadpool(results_zip, store)
        return FileResponse(path, media_type="application/zip", filename=f"{store.study_id}_results.zip",
                            background=BackgroundTask(path.unlink, missing_ok=True))

    @app.post(p + "/admin/{op}")
    async def admin_op(request: Request, op: str) -> JSONResponse:
        """Every operation of the admin area (docs/web/api.md, "Administration")."""
        return await authed(request, "admin", {**await body_of(request), "op": op})

    @app.post(p + "/expert/{op}")
    async def expert_op(request: Request, op: str) -> JSONResponse:
        """Every operation of the expert area (docs/web/api.md, "Experts")."""
        return await authed(request, "expert", {**await body_of(request), "op": op})

    @app.post(p + "/quiz/{set_id:path}")
    async def quiz(request: Request, set_id: str) -> JSONResponse:
        return await authed(request, "quiz", {**await body_of(request), "set_id": set_id})

    @app.api_route(p + "/{rest:path}", methods=["GET", "POST", "PUT", "DELETE"])
    async def api_not_found(rest: str) -> JSONResponse:
        return error_response(404, "not_found", f"There is no {p}/{rest}")

    if demo and demo_zip is not None:
        @app.get("/demo/recordings.zip")
        async def demo_recordings() -> FileResponse:
            return FileResponse(demo_zip, media_type="application/zip", filename="electrotag-demo-recordings.zip")

    # ------------------------------------------------- the browser application
    @app.get("/config.json")
    async def config(request: Request) -> JSONResponse:
        """The application served from here uses this server (whatever config.json it was published with)."""
        return JSONResponse({"server": str(request.base_url).rstrip("/"), "study": store.study_id},
                            headers={"Cache-Control": "no-store"})

    if (static / "index.html").is_file():
        from fastapi.staticfiles import StaticFiles

        app.mount("/", StaticFiles(directory=static, html=True), name="static")
    else:
        @app.get("/")
        async def placeholder() -> HTMLResponse:
            return HTMLResponse(PLACEHOLDER.replace("{study}", store.name).replace("{version}", __version__)
                                .replace("{prefix}", API_PREFIX))

    return app


def results_zip(store: FilesStore) -> Path:
    """A zip of the study's results folder (results, interaction logs, training progress, reports, quizzes)."""
    from electrotag.web.export import results_zip_file

    return results_zip_file(store)
