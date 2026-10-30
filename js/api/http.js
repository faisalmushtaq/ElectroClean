// The Backend that talks to a study server (docs/web/api.md, version 1).
//
// The server usually runs on another site than the application (GitHub Pages), so requests carry
// a bearer token rather than a cookie: POST /login returns it, it is kept in memory and in
// sessionStorage (never localStorage, so it ends with the browser tab), and every request except
// GET /health sends `Authorization: Bearer …` and `X-ElectroTag: 1`.

import { session } from '../util.js';

const TOKEN_KEY = 'electrotag.token';
/** The names of the admin area's operations: lower-case letters and underscores (overview, user_add, ...). */
export const ADMIN_OP = /^[a-z][a-z_]{0,40}$/;
/** The names of the expert area's operations, made the same way (work_list, correction_save, ...). */
export const EXPERT_OP = ADMIN_OP;

/** An expert operation that only reads (its name ends in _get or _list), which may be asked again after a failure;
 *  every other one saves and is never repeated (electrotag/web/expert.py, is_read). */
export function isExpertRead(op) {
  return /_(list|get)$/.test(String(op));
}

export class ApiError extends Error {
  constructor(status, code, message, body = null) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code || '';
    this.body = body;
  }
}

/** "https://study.example.org/" → "https://study.example.org"; '' stays '' (same site). */
export function normaliseServer(address) {
  let a = String(address || '').trim();
  if (!a) return '';
  if (!/^https?:\/\//i.test(a)) a = (/^(localhost|127\.|\[::1\])/i.test(a) ? 'http://' : 'https://') + a;
  return a.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

/** A recording identifier inside a path: each part encoded, the slashes kept (the server's route
 *  takes the rest of the path, see the contract notes in the report). */
export function idPath(recordingId) {
  return String(recordingId).split('/').map(encodeURIComponent).join('/');
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return null; }
}

/** GET {server}/api/v1/health with a time limit. Resolves with the health JSON or throws. */
export async function checkHealth(server, { timeoutMs = 6000 } = {}) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${server}/api/v1/health`, { method: 'GET', cache: 'no-store', signal: ctl ? ctl.signal : undefined, credentials: 'omit' });
    const body = await readJson(res);
    if (!res.ok || !body || typeof body !== 'object' || body.ok !== true) {
      throw new ApiError(res.status, 'not_electrotag', 'This address answers, but not as an ElectroTag study server.');
    }
    return body;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class HttpBackend {
  /**
   * @param {string} server the server's address ('' when it also serves this page)
   * @param {{onUnauthorized?: () => void, health?: object}} opts
   */
  constructor(server, { onUnauthorized = null, health = null } = {}) {
    this.kind = 'server';
    this.signInWith = 'id';
    this.eventFlushMs = 4000;
    this.writesVisitStart = true; // the visit_started event is written when the visit opens
    this.server = normaliseServer(server);
    this.base = `${this.server}/api/v1`;
    this.health = health;
    this.onUnauthorized = onUnauthorized;
    const saved = session.get(TOKEN_KEY, null);
    this.token = saved && saved.server === this.server ? saved.token : null;
  }

  get isDemo() { return false; }

  get signedIn() { return Boolean(this.token); }

  _setToken(token) {
    this.token = token;
    if (token) session.set(TOKEN_KEY, { server: this.server, token });
    else session.remove(TOKEN_KEY);
  }

  async _request(method, path, body = undefined, { keepalive = false, auth = true } = {}) {
    const headers = { 'X-ElectroTag': '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    let res;
    try {
      res = await fetch(this.base + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit', cache: 'no-store', keepalive,
      });
    } catch (exc) {
      throw new ApiError(0, 'network', 'The study server could not be reached. Check your internet connection and try again.');
    }
    const data = await readJson(res);
    if (res.status === 401 && auth) {
      this._setToken(null);
      if (this.onUnauthorized && path !== '/login') this.onUnauthorized();
    }
    if (!res.ok) {
      const code = data && data.error;
      const message = (data && data.message) || `The study server answered with an error (HTTP ${res.status}).`;
      throw new ApiError(res.status, code, message, data);
    }
    if (data === null) throw new ApiError(res.status, 'bad_json', 'The study server sent an answer that could not be read.');
    return data;
  }

  // ---------------------------------------------------------------- signing in
  async getHealth() {
    this.health = await checkHealth(this.server);
    return this.health;
  }

  async login(annotatorId, password) {
    const data = await this._request('POST', '/login', { annotator_id: annotatorId, password }, { auth: false });
    this._setToken(data.token);
    return data;
  }

  /** A study server takes private invitation links (?invite=<token>, docs/web/api.md). */
  get acceptsInvites() { return true; }

  /** Whose invitation a link's token is: {annotator_id, display_name, study_name, expires_at} (no sign-in). */
  inviteCheck(token) { return this._request('POST', '/invite/check', { token }, { auth: false }); }

  /** Choose the password with an invitation; the answer is a sign-in, as POST /login gives. */
  async inviteAccept(token, password) {
    const data = await this._request('POST', '/invite/accept', { token, password }, { auth: false });
    this._setToken(data.token);
    return data;
  }

  async logout() {
    try { if (this.token) await this._request('POST', '/logout', {}); } catch { /* signed out anyway */ }
    this._setToken(null);
    return {};
  }

  me() { return this._request('GET', '/me'); }

  /** The annotator's counters, the facts of their milestones, their goal, the team's progress and the
   *  anonymised leaderboard (docs/web/api.md, "Achievements"). */
  achievements() { return this._request('GET', '/me/achievements'); }

  /** Sets the personal goal ({goal_per_week}) or whether to appear on the leaderboard ({leaderboard_hidden}). */
  setAchievements(body) { return this._request('POST', '/me/achievements', body || {}); }

  /** GET /me/questionnaire: the sign-up questionnaire's questions, the annotator's answers and contact details. */
  questionnaire() { return this._request('GET', '/me/questionnaire'); }

  /** POST /me/questionnaire {answers, other, contacts}: saves them (never repeated by itself after a failure). */
  saveQuestionnaire(body) { return this._request('POST', '/me/questionnaire', body || {}); }

  // ------------------------------------------- problem reports and reviews
  /** POST /problems: a problem with a recording; `problem_id` makes a second sending of the same report harmless. */
  reportProblem(body) { return this._request('POST', '/problems', body); }

  /** GET /me/reviews: the reviews of the annotator's saved work ({shown, reviews}). */
  myReviews() { return this._request('GET', '/me/reviews'); }

  /** One's own saved files of a recording (the latest version, or `version`), as the study keeps them. */
  myResults(recordingId, mode = 'standard', contextId = '', version = null) {
    const q = `?mode=${encodeURIComponent(mode || 'standard')}&context=${encodeURIComponent(contextId || '')}${version ? `&version=${encodeURIComponent(version)}` : ''}`;
    return this._request('GET', `/me/results/${idPath(recordingId)}${q}`);
  }

  /** GET /me/feedback: the corrections of the annotator's saved work and the outcomes of its conflicts. */
  myFeedback() { return this._request('GET', '/me/feedback'); }

  // ------------------------------------------------------ assignments, opening
  assignments() { return this._request('GET', '/assignments'); }

  match(body) { return this._request('POST', '/match', body); }

  putDraft(recordingId, mode, contextId, draft, { keepalive = false } = {}) {
    const q = `?mode=${encodeURIComponent(mode)}&context=${encodeURIComponent(contextId || '')}`;
    return this._request('PUT', `/drafts/${idPath(recordingId)}${q}`, draft, { keepalive });
  }

  /** `sessionId`: the session discarding its work and closing; the study then refuses its drafts that arrive late. */
  deleteDraft(recordingId, mode, contextId, { sessionId = '' } = {}) {
    const q = `?mode=${encodeURIComponent(mode)}&context=${encodeURIComponent(contextId || '')}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ''}`;
    return this._request('DELETE', `/drafts/${idPath(recordingId)}${q}`);
  }

  submit(body) { return this._request('POST', '/submissions', body); }

  // ------------------------------------------------------------------ training
  training() { return this._request('GET', '/training'); }

  guided(recordingId) { return this._request('GET', `/training/guided/${idPath(recordingId)}`); }

  guidedCheck(recordingId, body) { return this._request('POST', `/training/guided/${idPath(recordingId)}/check`, body); }

  guidedContinue(recordingId, body) { return this._request('POST', `/training/guided/${idPath(recordingId)}/continue`, body); }

  guidedShowMe(recordingId, body) { return this._request('POST', `/training/guided/${idPath(recordingId)}/show-me`, body); }

  /** POST /training/stage {stage, action}: skip, finish or resume a stage of the training path (saves). */
  trainingStage(body) { return this._request('POST', '/training/stage', body || {}); }

  /** GET /training/snippets: the artifact snippets of the trainee's set. */
  trainingSnippets() { return this._request('GET', '/training/snippets'); }

  // -------------------------------------------------------------------- quiz
  /** The short-segment quiz of a reference set: body {action: "get" | "answer" | "finish", ...}. */
  quiz(setId, body) { return this._request('POST', `/quiz/${encodeURIComponent(setId)}`, body); }

  // ------------------------------------------------------------- interaction log
  openVisit(body) { return this._request('POST', '/visits', body); }

  /** Events are sent with fetch(keepalive) when the page is hidden: sendBeacon cannot carry the
   *  Authorization header that the server needs. */
  sendEvents(visitId, events, { keepalive = false } = {}) {
    return this._request('POST', `/visits/${encodeURIComponent(visitId)}/events`, { events }, { keepalive });
  }

  closeVisit(visitId, reason, { keepalive = false } = {}) {
    return this._request('POST', `/visits/${encodeURIComponent(visitId)}/close`, { reason }, { keepalive });
  }

  // ------------------------------------------------------------- administration
  /** One operation of the admin area: POST /admin/{op} with a JSON body (docs/web/api.md, "Administration"). */
  admin(op, body = {}) {
    if (!ADMIN_OP.test(String(op))) return Promise.reject(new ApiError(400, 'bad_request', 'That is not an operation of the admin area.'));
    return this._request('POST', `/admin/${op}`, body || {});
  }

  /** One operation of the expert area: POST /expert/{op} with a JSON body (docs/web/api.md, "Experts"). */
  expert(op, body = {}) {
    if (!EXPERT_OP.test(String(op))) return Promise.reject(new ApiError(400, 'bad_request', 'That is not an operation of the expert area.'));
    return this._request('POST', `/expert/${op}`, body || {});
  }

  // ----------------------------------------------------------------- downloads
  /** The demo server offers its example recordings as one zip file. */
  get canDownloadRecordings() { return Boolean(this.health && this.health.demo); }

  async downloadRecordings() {
    const headers = { 'X-ElectroTag': '1' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.server}/demo/recordings.zip`, { headers, credentials: 'omit' });
    if (!res.ok) throw new ApiError(res.status, 'download_failed', 'The example recordings could not be downloaded.');
    return [{ name: 'electrotag_demo_recordings.zip', blob: await res.blob() }];
  }
}
