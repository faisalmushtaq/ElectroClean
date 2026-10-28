// The Backend that talks to a study server (docs/web/api.md, version 1).
//
// The server usually runs on another site than the application (GitHub Pages), so requests carry
// a bearer token rather than a cookie: POST /login returns it, it is kept in memory and in
// sessionStorage (never localStorage, so it ends with the browser tab), and every request except
// GET /health sends `Authorization: Bearer …` and `X-ElectroClean: 1`.

import { session } from '../util.js';

const TOKEN_KEY = 'electroclean.token';

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
      throw new ApiError(res.status, 'not_electroclean', 'This address answers, but not as an ElectroClean study server.');
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
    const headers = { 'X-ElectroClean': '1' };
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

  async logout() {
    try { if (this.token) await this._request('POST', '/logout', {}); } catch { /* signed out anyway */ }
    this._setToken(null);
    return {};
  }

  me() { return this._request('GET', '/me'); }

  // ------------------------------------------------------ assignments, opening
  assignments() { return this._request('GET', '/assignments'); }

  match(body) { return this._request('POST', '/match', body); }

  putDraft(recordingId, mode, contextId, draft, { keepalive = false } = {}) {
    const q = `?mode=${encodeURIComponent(mode)}&context=${encodeURIComponent(contextId || '')}`;
    return this._request('PUT', `/drafts/${idPath(recordingId)}${q}`, draft, { keepalive });
  }

  deleteDraft(recordingId, mode, contextId) {
    const q = `?mode=${encodeURIComponent(mode)}&context=${encodeURIComponent(contextId || '')}`;
    return this._request('DELETE', `/drafts/${idPath(recordingId)}${q}`);
  }

  submit(body) { return this._request('POST', '/submissions', body); }

  // ------------------------------------------------------------------ training
  training() { return this._request('GET', '/training'); }

  guided(recordingId) { return this._request('GET', `/training/guided/${idPath(recordingId)}`); }

  guidedCheck(recordingId, body) { return this._request('POST', `/training/guided/${idPath(recordingId)}/check`, body); }

  guidedContinue(recordingId, body) { return this._request('POST', `/training/guided/${idPath(recordingId)}/continue`, body); }

  guidedShowMe(recordingId, body) { return this._request('POST', `/training/guided/${idPath(recordingId)}/show-me`, body); }

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

  // ----------------------------------------------------------------- downloads
  /** The demo server offers its example recordings as one zip file. */
  get canDownloadRecordings() { return Boolean(this.health && this.health.demo); }

  async downloadRecordings() {
    const headers = { 'X-ElectroClean': '1' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.server}/demo/recordings.zip`, { headers, credentials: 'omit' });
    if (!res.ok) throw new ApiError(res.status, 'download_failed', 'The example recordings could not be downloaded.');
    return [{ name: 'electroclean_demo_recordings.zip', blob: await res.blob() }];
  }
}
