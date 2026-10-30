// The Backend for a study on Firebase (docs/web/api.md, "The same operations on Firebase").
//
// Signing in uses Firebase Authentication (email and password) in the browser; every other
// operation is a callable Cloud Function named et_<operation> in the study's region, taking
// {study, ...the HTTP request body...} and returning the same JSON as the server. Errors arrive
// as HttpsError (a code, details.error and the message for the annotator) and become the same
// ApiError the rest of the application already handles.
//
// The Firebase SDK is loaded (as ES modules from gstatic.com) only when this backend is used, so
// the demonstration and server modes never load it.

import { ADMIN_OP, ApiError, EXPERT_OP, isExpertRead } from './http.js';

export { isExpertRead };

/** The admin operations that only read (docs/web/api.md, "Administration"), which may be retried. */
const ADMIN_READS = new Set(['overview', 'progress', 'stats', 'audit', 'visits', 'sets_list', 'quiz_items', 'set_guided_notes']);

export function isAdminRead(op) {
  return ADMIN_READS.has(op) || /_(list|get)$/.test(String(op));
}

/** The roles the claims give in a study: the list written now, or the older single role (role_in in Python). */
export function claimedRoles(claims, study) {
  const r = claims && claims.roles && typeof claims.roles === 'object' ? claims.roles[study] : undefined;
  const list = Array.isArray(r) ? r : typeof r === 'string' ? [r] : [(claims && claims.role) || 'annotator'];
  const order = ['admin', 'expert', 'annotator', 'participant'];
  const out = order.filter((x) => list.includes(x));
  return out.length ? out : ['annotator'];
}

export const FIREBASE_VERSION = '12.19.0';
export const SDK_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
export const DEFAULT_REGION = 'europe-west2';

export async function loadFirebaseSdk(base = SDK_BASE) {
  const [app, auth, functions] = await Promise.all([
    import(`${base}firebase-app.js`), import(`${base}firebase-auth.js`), import(`${base}firebase-functions.js`),
  ]);
  return { app, auth, functions };
}

// HttpsError codes (with or without the "functions/" prefix) and the HTTP status they stand for.
const STATUS = {
  'invalid-argument': 400, 'failed-precondition': 409, 'out-of-range': 400, unauthenticated: 401,
  'permission-denied': 403, 'not-found': 404, 'already-exists': 409, aborted: 409, 'resource-exhausted': 429,
  cancelled: 0, unavailable: 0, 'deadline-exceeded': 0, internal: 500, unknown: 500, 'data-loss': 500, unimplemented: 501,
};

/** An HttpsError (or a network failure) as an ApiError. */
export function toApiError(exc) {
  const code = String((exc && exc.code) || 'unknown').replace(/^functions\//, '');
  const details = (exc && exc.details) || {};
  const status = STATUS[code] ?? 500;
  let error = typeof details.error === 'string' ? details.error : code;
  if (status === 422 || error === 'invalid_annotation') return new ApiError(422, error, exc.message, details);
  let message = exc && exc.message;
  if (status === 0) {
    error = 'network';
    message = 'The study could not be reached. Check your internet connection and try again.';
  } else if (!message || message === code || /^internal$/i.test(message)) {
    message = 'The study answered with an error. Please try again in a moment.';
  }
  return new ApiError(status, error, message, details);
}

/** A Firebase Authentication error as the message for the sign-in form. */
export function authError(exc) {
  const code = String((exc && exc.code) || '');
  if (/invalid-credential|wrong-password|user-not-found|invalid-login|invalid-email|missing-password/.test(code)) {
    return new ApiError(401, 'bad_credentials', 'The email address or password is not right.');
  }
  if (/user-disabled/.test(code)) return new ApiError(403, 'account_disabled', 'This account has been switched off. Ask the study team.');
  if (/too-many-requests/.test(code)) {
    return new ApiError(429, 'too_many_attempts', 'Too many attempts to sign in. Wait a few minutes, or reset your password.');
  }
  if (/network-request-failed/.test(code)) {
    return new ApiError(0, 'network', 'The study could not be reached. Check your internet connection and try again.');
  }
  return new ApiError(400, code || 'auth_failed', 'Signing in did not work. Check your email address and password and try again.');
}

export class FirebaseBackend {
  /**
   * @param {{config: object, study: string, region?: string, sdk: object, onUnauthorized?: () => void}} opts
   * `sdk` is {app, auth, functions}: the three Firebase modules (or test doubles of them).
   */
  constructor({ config, study, region = DEFAULT_REGION, sdk, onUnauthorized = null, emulators = null }) {
    this.kind = 'firebase';
    this.signInWith = 'email';
    this.study = study || '';
    this.region = region || DEFAULT_REGION;
    this.onUnauthorized = onUnauthorized;
    this.eventFlushMs = 10000; // interaction events are sent about every 10 s
    this.retryDelayMs = 1500; // before asking a read-only function a second time
    this.writesVisitStart = true; // the visit_started event is written when the visit opens
    this.sdk = sdk;
    this.app = sdk.app.initializeApp(config, 'electrotag');
    this.auth = sdk.auth.getAuth(this.app);
    this.functions = sdk.functions.getFunctions(this.app, this.region);
    this.health = { ok: true, study: this.study, demo: false, firebase: true, project: config && config.projectId };
    if (emulators) this._useEmulators(emulators);
    this._persistence = null;
  }

  /** For testing on the Firebase Emulator Suite: {auth: 'http://127.0.0.1:9099', functions: '127.0.0.1:5001'}. */
  _useEmulators({ auth = null, functions = null }) {
    if (auth) this.sdk.auth.connectAuthEmulator(this.auth, auth, { disableWarnings: true });
    if (functions) {
      const m = /^(?:https?:\/\/)?([^:/]+):(\d+)\/?$/.exec(String(functions));
      if (!m) throw new Error(`emulators.functions must be host:port, not ${functions}`);
      this.sdk.functions.connectFunctionsEmulator(this.functions, m[1], Number(m[2]));
    }
    this.health.emulators = true;
  }

  static async create({ config, study, region, sdkBase, sdk = null, onUnauthorized = null, emulators = null }) {
    const modules = sdk || await loadFirebaseSdk(sdkBase || SDK_BASE);
    const backend = new FirebaseBackend({ config, study, region, sdk: modules, onUnauthorized, emulators });
    await backend.ready();
    return backend;
  }

  get isDemo() { return false; }

  /** Invitations on Firebase are Firebase Authentication's own links, not ?invite= links. */
  get acceptsInvites() { return false; }

  get server() { return ''; }

  get signedIn() { return Boolean(this.auth && this.auth.currentUser); }

  /** Waits until Firebase knows whether someone is signed in (after a reload of the tab). */
  async ready() {
    const a = this.sdk.auth;
    // Sign-in lasts as long as the browser tab, like the server's token in sessionStorage.
    if (a.setPersistence && a.browserSessionPersistence) {
      try { await a.setPersistence(this.auth, a.browserSessionPersistence); } catch { /* the default then */ }
    }
    if (typeof this.auth.authStateReady === 'function') {
      try { await this.auth.authStateReady(); } catch { /* treated as signed out */ }
    }
  }

  async getHealth() { return this.health; }

  async login(email, password) {
    let cred;
    try {
      cred = await this.sdk.auth.signInWithEmailAndPassword(this.auth, String(email).trim(), password);
    } catch (exc) {
      throw authError(exc);
    }
    const user = cred.user || this.auth.currentUser;
    let claims = {};
    try { claims = (await user.getIdTokenResult()).claims || {}; } catch { /* read from et_me below */ }
    return {
      annotator_id: claims.annotator_id || '', display_name: user.displayName || '', role: claims.role || 'annotator',
      roles: claimedRoles(claims, this.study), email: user.email || String(email).trim(),
    };
  }

  async resetPassword(email) {
    try {
      await this.sdk.auth.sendPasswordResetEmail(this.auth, String(email).trim());
    } catch (exc) {
      const code = String((exc && exc.code) || '');
      // Firebase does not say whether an account exists; neither does the application.
      if (!/user-not-found/.test(code)) throw authError(exc);
    }
    return {};
  }

  async logout() {
    try { await this.sdk.auth.signOut(this.auth); } catch { /* signed out anyway */ }
    return {};
  }

  /**
   * Calls one function. `retry` is for operations that only read: a function that is starting up
   * or failed once (the network, an instance that stopped mid-request) is asked once more after a
   * short pause. Operations that save, score or count an attempt are never repeated.
   */
  async _call(name, body = {}, { retry = false } = {}) {
    const fn = this.sdk.functions.httpsCallable(this.functions, name);
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fn({ study: this.study, ...body });
        return res && res.data !== undefined ? res.data : {};
      } catch (exc) {
        const err = toApiError(exc);
        if (retry && attempt === 1 && (err.status === 0 || err.status >= 500)) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs));
          continue;
        }
        if (err.status === 401 && this.onUnauthorized) this.onUnauthorized();
        throw err;
      }
    }
  }

  me() { return this._call('et_me', {}, { retry: true }); }

  achievements() { return this._call('et_achievements', {}, { retry: true }); }

  /** Changes the goal or the leaderboard's visibility: not repeated after a failure, like every change. */
  setAchievements(body) { return this._call('et_achievements', body || {}); }

  assignments() { return this._call('et_assignments', {}, { retry: true }); }

  match(body) { return this._call('et_match', body, { retry: true }); }

  putDraft(recordingId, mode, contextId, draft) {
    return this._call('et_put_draft', { recording_id: recordingId, mode, context_id: contextId || '', draft });
  }

  deleteDraft(recordingId, mode, contextId) {
    return this._call('et_delete_draft', { recording_id: recordingId, mode, context_id: contextId || '' });
  }

  submit(body) { return this._call('et_submit', body); }

  /** A problem with a recording: never repeated by itself (the study may have kept it already); its problem_id makes a second press harmless. */
  reportProblem(body) { return this._call('et_problem_report', body); }

  /** The reviews of the annotator's saved work: a read, so asked again once after a failure. */
  myReviews() { return this._call('et_my_reviews', {}, { retry: true }); }

  /** The corrections of the annotator's work and the outcomes of its conflicts: a read. */
  myFeedback() { return this._call('et_my_feedback', {}, { retry: true }); }

  training() { return this._call('et_training', {}, { retry: true }); }

  guided(recordingId) { return this._call('et_guided_get', { recording_id: recordingId }, { retry: true }); }

  guidedCheck(recordingId, body) { return this._call('et_guided_check', { recording_id: recordingId, ...body }); }

  guidedContinue(recordingId, body) { return this._call('et_guided_continue', { recording_id: recordingId, ...body }); }

  guidedShowMe(recordingId, body) { return this._call('et_guided_show_me', { recording_id: recordingId, ...body }); }

  /** Skip, finish or resume a stage of the training path: it saves, so it is never asked a second time. */
  trainingStage(body) { return this._call('et_training_stage', body || {}); }

  trainingSnippets() { return this._call('et_training_snippets', {}, { retry: true }); }

  /** The short-segment quiz: only "get" reads, so only it is asked again; an answer is never repeated. */
  quiz(setId, body) {
    return this._call('et_quiz', { set_id: setId, ...body }, { retry: Boolean(body && body.action === 'get') });
  }

  openVisit(body) { return this._call('et_visit_open', body); }

  /** A callable function cannot use fetch(keepalive): the call on page hide is best effort. */
  sendEvents(visitId, events) { return this._call('et_visit_events', { visit_id: visitId, events }); }

  closeVisit(visitId, reason) { return this._call('et_visit_close', { visit_id: visitId, reason }); }

  adminProgress() { return this._call('et_admin_progress', {}, { retry: true }); }

  /**
   * One operation of the admin area: the callable function et_admin with {op, ...body}. Only the
   * operations that read are asked again after a failure (isAdminRead); one that changes the study
   * is never repeated, because the first attempt may have been carried out.
   */
  admin(op, body = {}) {
    if (!ADMIN_OP.test(String(op))) return Promise.reject(new ApiError(400, 'bad_request', 'That is not an operation of the admin area.'));
    return this._call('et_admin', { ...(body || {}), op }, { retry: isAdminRead(op) });
  }

  /**
   * One operation of the expert area: et_expert with {op, ...body}. Only an operation that reads (its name ends in
   * _get or _list: isExpertRead) is asked again after a failure; one that saves (a correction, a decision) is never
   * repeated, because the first attempt may have been carried out.
   */
  expert(op, body = {}) {
    if (!EXPERT_OP.test(String(op))) return Promise.reject(new ApiError(400, 'bad_request', 'That is not an operation of the expert area.'));
    return this._call('et_expert', { ...(body || {}), op }, { retry: isExpertRead(op) });
  }

  get canDownloadRecordings() { return false; }
}
