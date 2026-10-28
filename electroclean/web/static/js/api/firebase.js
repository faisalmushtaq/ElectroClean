// The Backend for a study on Firebase (docs/web/api.md, "The same operations on Firebase").
//
// Signing in uses Firebase Authentication (email and password) in the browser; every other
// operation is a callable Cloud Function named ec_<operation> in the study's region, taking
// {study, ...the HTTP request body...} and returning the same JSON as the server. Errors arrive
// as HttpsError (a code, details.error and the message for the annotator) and become the same
// ApiError the rest of the application already handles.
//
// The Firebase SDK is loaded (as ES modules from gstatic.com) only when this backend is used, so
// the demonstration and server modes never load it.

import { ApiError } from './http.js';

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
    this.writesVisitStart = true; // the visit_started event is written when the visit opens
    this.sdk = sdk;
    this.app = sdk.app.initializeApp(config, 'electroclean');
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
    try { claims = (await user.getIdTokenResult()).claims || {}; } catch { /* read from ec_me below */ }
    return {
      annotator_id: claims.annotator_id || '', display_name: user.displayName || '', role: claims.role || 'annotator',
      email: user.email || String(email).trim(),
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

  async _call(name, body = {}) {
    const fn = this.sdk.functions.httpsCallable(this.functions, name);
    try {
      const res = await fn({ study: this.study, ...body });
      return res && res.data !== undefined ? res.data : {};
    } catch (exc) {
      const err = toApiError(exc);
      if (err.status === 401 && this.onUnauthorized) this.onUnauthorized();
      throw err;
    }
  }

  me() { return this._call('ec_me'); }

  assignments() { return this._call('ec_assignments'); }

  match(body) { return this._call('ec_match', body); }

  putDraft(recordingId, mode, contextId, draft) {
    return this._call('ec_put_draft', { recording_id: recordingId, mode, context_id: contextId || '', draft });
  }

  deleteDraft(recordingId, mode, contextId) {
    return this._call('ec_delete_draft', { recording_id: recordingId, mode, context_id: contextId || '' });
  }

  submit(body) { return this._call('ec_submit', body); }

  training() { return this._call('ec_training'); }

  guided(recordingId) { return this._call('ec_guided_get', { recording_id: recordingId }); }

  guidedCheck(recordingId, body) { return this._call('ec_guided_check', { recording_id: recordingId, ...body }); }

  guidedContinue(recordingId, body) { return this._call('ec_guided_continue', { recording_id: recordingId, ...body }); }

  guidedShowMe(recordingId, body) { return this._call('ec_guided_show_me', { recording_id: recordingId, ...body }); }

  openVisit(body) { return this._call('ec_visit_open', body); }

  /** A callable function cannot use fetch(keepalive): the call on page hide is best effort. */
  sendEvents(visitId, events) { return this._call('ec_visit_events', { visit_id: visitId, events }); }

  closeVisit(visitId, reason) { return this._call('ec_visit_close', { visit_id: visitId, reason }); }

  adminProgress() { return this._call('ec_admin_progress'); }

  get canDownloadRecordings() { return false; }
}
