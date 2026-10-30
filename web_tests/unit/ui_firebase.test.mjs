// The Firebase backend, with stand-ins for the Firebase SDK modules (no network, no Firebase).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FirebaseBackend, toApiError, authError, isExpertRead, claimedRoles } from '../../electrotag/web/static/js/api/firebase.js';

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
      connectAuthEmulator: (auth, url) => { state.authEmulator = url; },
    },
    functions: {
      getFunctions: (app, region) => ({ app, region }),
      connectFunctionsEmulator: (fns, host, port) => { state.functionsEmulator = `${host}:${port}`; },
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

test('operations call et_<operation> in europe-west2 with the study and the same body', async () => {
  const { sdk, calls } = fakeSdk({ handlers: {
    et_me: () => ({ annotator_id: 'A07' }),
    et_match: (d) => ({ status: 'matched', echo: d.sha256 }),
    et_put_draft: () => ({ saved_at: 'now' }),
    et_guided_check: (d) => ({ matched: d.step === 3 }),
    et_visit_events: () => ({}),
  } });
  const b = await FirebaseBackend.create({ config: {}, study: 'pilot', sdk });
  assert.equal((await b.me()).annotator_id, 'A07');
  assert.equal((await b.match({ sha256: 'abc', size_bytes: 3 })).echo, 'abc');
  await b.putDraft('sub-01/eeg/x.edf', 'standard', '', { annotations: [], elapsed_s: 2 });
  assert.equal((await b.guidedCheck('sub-01/eeg/x.edf', { step: 3, annotations: [] })).matched, true);
  await b.sendEvents('v1', [{ t: 1, type: 'key' }]);
  assert.deepEqual(calls.map((c) => c.name), ['et_me', 'et_match', 'et_put_draft', 'et_guided_check', 'et_visit_events']);
  assert.ok(calls.every((c) => c.region === 'europe-west2' && c.data.study === 'pilot'));
  assert.deepEqual(calls[2].data, { study: 'pilot', recording_id: 'sub-01/eeg/x.edf', mode: 'standard', context_id: '', draft: { annotations: [], elapsed_s: 2 } });
  assert.equal(calls[3].data.recording_id, 'sub-01/eeg/x.edf');
  assert.deepEqual(calls[4].data, { study: 'pilot', visit_id: 'v1', events: [{ t: 1, type: 'key' }] });
});

test('HttpsError becomes the same errors as the server gives', async () => {
  let signedOut = 0;
  const { sdk } = fakeSdk({ handlers: {
    et_submit: () => { throw new FakeHttpsError('already-exists', 'This recording has already been saved.', { error: 'already_done' }); },
    et_assignments: () => { throw new FakeHttpsError('unauthenticated', 'Please sign in again.', { error: 'not_signed_in' }); },
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

test('config.json can point the backend at the Firebase emulators, for testing', async () => {
  const { sdk, state } = fakeSdk();
  const plain = await FirebaseBackend.create({ config: {}, study: 's', sdk });
  assert.equal(state.authEmulator, undefined);
  assert.equal(plain.health.emulators, undefined);
  const b = await FirebaseBackend.create({ config: {}, study: 's', sdk, emulators: { auth: 'http://127.0.0.1:9099', functions: 'http://127.0.0.1:5001' } });
  assert.equal(state.authEmulator, 'http://127.0.0.1:9099');
  assert.equal(state.functionsEmulator, '127.0.0.1:5001');
  assert.equal(b.health.emulators, true);
  assert.throws(() => new FirebaseBackend({ config: {}, study: 's', sdk, emulators: { functions: 'nowhere' } }), /host:port/);
});

test('a read-only call is asked once more after a failure; a call that saves is not', async () => {
  let matches = 0;
  let submits = 0;
  const { sdk, calls } = fakeSdk({ handlers: {
    et_match: () => { matches += 1; if (matches === 1) throw new FakeHttpsError('internal', 'internal', {}); return { status: 'matched' }; },
    et_submit: () => { submits += 1; throw new FakeHttpsError('unavailable', 'unavailable', {}); },
    et_assignments: () => { throw new FakeHttpsError('permission-denied', 'Not in this study.', { error: 'not_in_study' }); },
  } });
  const b = await FirebaseBackend.create({ config: {}, study: 's', sdk });
  b.retryDelayMs = 1;
  assert.equal((await b.match({ sha256: 'x', size_bytes: 1 })).status, 'matched');
  assert.equal(matches, 2);
  await assert.rejects(() => b.submit({}), (e) => e.status === 0 && e.code === 'network');
  assert.equal(submits, 1);
  await assert.rejects(() => b.assignments(), (e) => e.status === 403);
  assert.equal(calls.filter((c) => c.name === 'et_assignments').length, 1); // a refusal is not repeated
});

test('achievements: read with a retry, changed without one', async () => {
  let reads = 0;
  let writes = 0;
  const { sdk, calls } = fakeSdk({ handlers: {
    et_achievements: (d) => {
      if (d.goal_per_week !== undefined) { writes += 1; throw new FakeHttpsError('unavailable', 'unavailable', {}); }
      reads += 1;
      if (reads === 1) throw new FakeHttpsError('internal', 'internal', {});
      return { enabled: true };
    },
  } });
  const b = await FirebaseBackend.create({ config: {}, study: 's', sdk });
  b.retryDelayMs = 1;
  assert.equal((await b.achievements()).enabled, true);
  assert.equal(reads, 2);
  await assert.rejects(() => b.setAchievements({ goal_per_week: 5 }), (e) => e.code === 'network');
  assert.equal(writes, 1);
  assert.deepEqual(calls.at(-1).data, { study: 's', goal_per_week: 5 });
});

test('expert operations: only those that read are asked again, and the claims give the roles', async () => {
  assert.ok(isExpertRead('work_list') && isExpertRead('saved_attempt_get') && isExpertRead('replay_consent_get'));
  for (const op of ['correction_save', 'adjudication_decide', 'adjudication_start', 'library_promote', 'replay_consent_set', 'list_and_save']) {
    assert.equal(isExpertRead(op), false, op);
  }
  let reads = 0;
  let saves = 0;
  const { sdk, calls } = fakeSdk({ handlers: {
    et_expert: (d) => {
      if (d.op === 'work_list') { reads += 1; if (reads === 1) throw new FakeHttpsError('unavailable', 'unavailable', {}); return { items: [] }; }
      saves += 1;
      throw new FakeHttpsError('internal', 'internal', {});
    },
    et_my_feedback: () => ({ corrections: { shown: true, items: [] } }),
    et_training_stage: () => { throw new FakeHttpsError('unavailable', 'unavailable', {}); },
    et_training_snippets: () => ({ snippets: [] }),
  } });
  const b = await FirebaseBackend.create({ config: {}, study: 's', sdk });
  b.retryDelayMs = 1;
  assert.deepEqual(await b.expert('work_list', { limit: 5 }), { items: [] });
  assert.equal(reads, 2);
  assert.deepEqual(calls[0].data, { study: 's', limit: 5, op: 'work_list' });
  await assert.rejects(() => b.expert('correction_save', { correction_id: 'c'.repeat(32) }), (e) => e.status === 500);
  assert.equal(saves, 1); // a save is never repeated by itself
  await assert.rejects(() => b.trainingStage({ stage: 'tour', action: 'skip' }), (e) => e.code === 'network');
  assert.equal(calls.filter((c) => c.name === 'et_training_stage').length, 1);
  assert.equal((await b.myFeedback()).corrections.shown, true);
  assert.deepEqual((await b.trainingSnippets()).snippets, []);
  await assert.rejects(() => b.expert('Not An Op'), (e) => e.status === 400);
  // roles in the claims: the list written now, or the older single role
  assert.deepEqual(claimedRoles({ roles: { s: ['annotator', 'expert'] }, role: 'expert' }, 's'), ['expert', 'annotator']);
  assert.deepEqual(claimedRoles({ roles: { s: 'admin' }, role: 'admin' }, 's'), ['admin']);
  assert.deepEqual(claimedRoles({ role: 'annotator' }, 's'), ['annotator']);
  const { sdk: sdk2 } = fakeSdk({ users: { 'e@example.org': { password: 'p', claims: { annotator_id: 'E01', role: 'expert', roles: { s: ['expert', 'annotator'] } } } } });
  const e = await FirebaseBackend.create({ config: {}, study: 's', sdk: sdk2 });
  const who = await e.login('e@example.org', 'p');
  assert.deepEqual([who.role, who.roles], ['expert', ['expert', 'annotator']]);
});
