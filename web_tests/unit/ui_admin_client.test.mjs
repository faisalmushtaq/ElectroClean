// The admin area's client method, admin(op, body), on the study server (POST /admin/{op}) and on
// Firebase (the callable et_admin with {op, ...body}), as docs/web/api.md "Administration" says:
// the same headers and errors as every other request, and a second attempt only for reads.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
globalThis.sessionStorage = store();
globalThis.localStorage = store();

const { HttpBackend } = await import('../../electrotag/web/static/js/api/http.js');
const { FirebaseBackend, isAdminRead } = await import('../../electrotag/web/static/js/api/firebase.js');

let calls = [];
let reply = null;
beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, ...init, headers: init.headers || {} });
    const { status, body } = reply(url, init);
    return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
  };
});

test('server: an operation is POST /api/v1/admin/{op} with the token, the header and a JSON body', async () => {
  reply = () => ({ status: 200, body: { users: [] } });
  globalThis.sessionStorage.setItem('electrotag.token', JSON.stringify({ server: 'https://s.org', token: 'T' }));
  const b = new HttpBackend('https://s.org');
  assert.deepEqual(await b.admin('users_list'), { users: [] });
  await b.admin('user_add', { annotator_id: 'A03', role: 'annotator' });
  assert.equal(calls[0].url, 'https://s.org/api/v1/admin/users_list');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), {});
  assert.equal(calls[1].url, 'https://s.org/api/v1/admin/user_add');
  assert.deepEqual(JSON.parse(calls[1].body), { annotator_id: 'A03', role: 'annotator' });
  for (const c of calls) {
    assert.equal(c.headers.Authorization, 'Bearer T');
    assert.equal(c.headers['X-ElectroTag'], '1');
    assert.equal(c.headers['Content-Type'], 'application/json');
    assert.equal(c.credentials, 'omit');
  }
});

test('server: errors carry the study\'s code and message; an unknown name is refused before asking', async () => {
  reply = (url) => (url.endsWith('/user_update') ? { status: 409, body: { error: 'self', message: 'You cannot switch off your own account.' } }
    : { status: 403, body: { error: 'forbidden', message: 'Only study administrators can do this.' } });
  const b = new HttpBackend('https://s.org');
  await assert.rejects(() => b.admin('user_update', { annotator_id: 'ADMIN', status: 'disabled' }),
    (e) => e.status === 409 && e.code === 'self' && /your own account/.test(e.message));
  await assert.rejects(() => b.admin('overview'), (e) => e.status === 403 && e.code === 'forbidden');
  const n = calls.length;
  await assert.rejects(() => b.admin('../login'), (e) => e.status === 400);
  await assert.rejects(() => b.admin('Overview'), (e) => e.status === 400);
  assert.equal(calls.length, n);
});

class FakeHttpsError extends Error {
  constructor(code, message, details) { super(message); this.code = `functions/${code}`; this.details = details; }
}

function fakeSdk(handler) {
  const fcalls = [];
  const sdk = {
    app: { initializeApp: (config, name) => ({ config, name }) },
    auth: { getAuth: () => ({ currentUser: null, authStateReady: async () => {} }) },
    functions: {
      getFunctions: (app, region) => ({ region }),
      httpsCallable: (fns, name) => async (data) => { fcalls.push({ name, region: fns.region, data }); return { data: await handler(name, data) }; },
    },
  };
  return { sdk, fcalls };
}

test('Firebase: every operation is et_admin with the study, the op and the body', async () => {
  const { sdk, fcalls } = fakeSdk((name, d) => ({ echo: d.op }));
  const b = await FirebaseBackend.create({ config: {}, study: 'pilot', sdk });
  assert.deepEqual(await b.admin('assign', { annotator_ids: ['A01'], all: true, mode: 'standard', context_id: '' }), { echo: 'assign' });
  assert.deepEqual(fcalls[0], { name: 'et_admin', region: 'europe-west2',
    data: { study: 'pilot', annotator_ids: ['A01'], all: true, mode: 'standard', context_id: '', op: 'assign' } });
  // The body cannot change which operation is called.
  await b.admin('overview', { op: 'user_remove' });
  assert.equal(fcalls[1].data.op, 'overview');
});

test('Firebase: a read is asked once more after a failure; a change never is', async () => {
  const tries = {};
  const { sdk, fcalls } = fakeSdk((name, d) => {
    tries[d.op] = (tries[d.op] || 0) + 1;
    if (tries[d.op] === 1) throw new FakeHttpsError('unavailable', 'unavailable', {});
    return { ok: d.op };
  });
  const b = await FirebaseBackend.create({ config: {}, study: 's', sdk });
  b.retryDelayMs = 1;
  assert.deepEqual(await b.admin('users_list'), { ok: 'users_list' });
  assert.deepEqual(await b.admin('audit', { limit: 50 }), { ok: 'audit' });
  await assert.rejects(() => b.admin('recordings_register', { scope: 'study', manifests: [] }), (e) => e.code === 'network');
  await assert.rejects(() => b.admin('agreement', {}), (e) => e.code === 'network');
  assert.deepEqual(tries, { users_list: 2, audit: 2, recordings_register: 1, agreement: 1 });
  assert.equal(fcalls.length, 6);
});

test('Firebase: the operations that only read', () => {
  for (const op of ['overview', 'settings_get', 'users_list', 'assignments_list', 'recordings_list', 'sets_list', 'quiz_items',
    'set_guided_notes', 'progress', 'audit', 'visits']) assert.equal(isAdminRead(op), true, op);
  for (const op of ['settings_update', 'user_add', 'user_update', 'user_reset_password', 'user_remove', 'assign', 'unassign',
    'programme_set', 'recordings_register', 'recording_update', 'recording_remove', 'set_create', 'set_update', 'set_delete',
    'set_add_reference', 'set_recording_update', 'set_remove_recording', 'set_guided_note', 'set_example_create', 'quiz_item_add',
    'quiz_item_remove', 'agreement', 'activity', 'competency', 'results_zip']) assert.equal(isAdminRead(op), false, op);
});

test('Firebase: errors keep the code from details and the message for the administrator', async () => {
  const { sdk } = fakeSdk(() => { throw new FakeHttpsError('already-exists', 'There is already an account A03.', { error: 'user_exists' }); });
  const b = await FirebaseBackend.create({ config: {}, study: 's', sdk });
  await assert.rejects(() => b.admin('user_add', { annotator_id: 'A03', email: 'a@b.org' }),
    (e) => e.status === 409 && e.code === 'user_exists' && e.message === 'There is already an account A03.');
});
