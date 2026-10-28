// The Firebase backend, with stand-ins for the Firebase SDK modules (no network, no Firebase).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FirebaseBackend, toApiError, authError } from '../../electroclean/web/static/js/api/firebase.js';

class FakeHttpsError extends Error {
  constructor(code, message, details) { super(message); this.code = `functions/${code}`; this.details = details; }
}

function fakeSdk({ handlers = {}, users = { 'ann@example.org': { password: 'right', claims: { annotator_id: 'A07', role: 'annotator' } } } } = {}) {
  const calls = [];
  const state = { currentUser: null, persistence: null, resets: [] };
  const sdk = {
    app: { initializeApp: (config, name) => ({ config, name }) },
    auth: {
      browserSessionPersistence: 'SESSION',
      getAuth: (app) => ({ app, get currentUser() { return state.currentUser; }, authStateReady: async () => {} }),
      setPersistence: async (auth, p) => { state.persistence = p; },
      signInWithEmailAndPassword: async (auth, email, password) => {
        const u = users[email];
        if (!u || u.password !== password) { const e = new Error('bad'); e.code = 'auth/invalid-credential'; throw e; }
        state.currentUser = { email, displayName: 'Ann', getIdTokenResult: async () => ({ claims: u.claims }) };
        return { user: state.currentUser };
      },
      sendPasswordResetEmail: async (auth, email) => { state.resets.push(email); },
      signOut: async () => { state.currentUser = null; },
    },
    functions: {
      getFunctions: (app, region) => ({ app, region }),
      httpsCallable: (fns, name) => async (data) => {
        calls.push({ name, region: fns.region, data });
        const h = handlers[name];
        if (!h) throw new FakeHttpsError('not-found', 'No such function', { error: 'not_found' });
        return { data: await h(data) };
      },
    },
  };
  return { sdk, calls, state };
}

test('sign-in with email and password; the annotator ID comes from the token claims', async () => {
  const { sdk, state } = fakeSdk();
  const b = await FirebaseBackend.create({ config: { projectId: 'p' }, study: 'pilot', sdk });
  assert.equal(b.signInWith, 'email');
  assert.equal(state.persistence, 'SESSION');
  assert.equal(b.signedIn, false);
  await assert.rejects(() => b.login('ann@example.org', 'wrong'), (e) => e.status === 401 && e.code === 'bad_credentials');
  const who = await b.login(' ann@example.org ', 'right');
  assert.equal(who.annotator_id, 'A07');
  assert.equal(b.signedIn, true);
  await b.resetPassword('ann@example.org');
  assert.deepEqual(state.resets, ['ann@example.org']);
  await b.logout();
  assert.equal(b.signedIn, false);
});

test('operations call ec_<operation> in europe-west2 with the study and the same body', async () => {
  const { sdk, calls } = fakeSdk({ handlers: {
    ec_me: () => ({ annotator_id: 'A07' }),
    ec_match: (d) => ({ status: 'matched', echo: d.sha256 }),
    ec_put_draft: () => ({ saved_at: 'now' }),
    ec_guided_check: (d) => ({ matched: d.step === 3 }),
    ec_visit_events: () => ({}),
  } });
  const b = await FirebaseBackend.create({ config: {}, study: 'pilot', sdk });
  assert.equal((await b.me()).annotator_id, 'A07');
  assert.equal((await b.match({ sha256: 'abc', size_bytes: 3 })).echo, 'abc');
  await b.putDraft('sub-01/eeg/x.edf', 'standard', '', { annotations: [], elapsed_s: 2 });
  assert.equal((await b.guidedCheck('sub-01/eeg/x.edf', { step: 3, annotations: [] })).matched, true);
  await b.sendEvents('v1', [{ t: 1, type: 'key' }]);
  assert.deepEqual(calls.map((c) => c.name), ['ec_me', 'ec_match', 'ec_put_draft', 'ec_guided_check', 'ec_visit_events']);
  assert.ok(calls.every((c) => c.region === 'europe-west2' && c.data.study === 'pilot'));
  assert.deepEqual(calls[2].data, { study: 'pilot', recording_id: 'sub-01/eeg/x.edf', mode: 'standard', context_id: '', draft: { annotations: [], elapsed_s: 2 } });
  assert.equal(calls[3].data.recording_id, 'sub-01/eeg/x.edf');
  assert.deepEqual(calls[4].data, { study: 'pilot', visit_id: 'v1', events: [{ t: 1, type: 'key' }] });
});

test('HttpsError becomes the same errors as the server gives', async () => {
  let signedOut = 0;
  const { sdk } = fakeSdk({ handlers: {
    ec_submit: () => { throw new FakeHttpsError('already-exists', 'This recording has already been saved.', { error: 'already_done' }); },
    ec_assignments: () => { throw new FakeHttpsError('unauthenticated', 'Please sign in again.', { error: 'not_signed_in' }); },
  } });
  const b = await FirebaseBackend.create({ config: {}, study: 's', sdk, onUnauthorized: () => { signedOut += 1; } });
  await assert.rejects(() => b.submit({}), (e) => e.status === 409 && e.code === 'already_done' && /already been saved/.test(e.message));
  await assert.rejects(() => b.assignments(), (e) => e.status === 401);
  assert.equal(signedOut, 1);
  const invalid = toApiError(new FakeHttpsError('invalid-argument', 'Eye-blink-artifact at sample 3: ends after the recording', { error: 'invalid_annotation' }));
  assert.equal(invalid.status, 422);
  const offline = toApiError(new FakeHttpsError('unavailable', 'unavailable'));
  assert.equal(offline.code, 'network');
  assert.equal(authError({ code: 'auth/too-many-requests' }).status, 429);
});
