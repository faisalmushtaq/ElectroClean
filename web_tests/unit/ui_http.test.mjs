// The study server backend (js/api/http.js) follows docs/web/api.md: the bearer token, the
// X-ElectroTag header, sessionStorage only, and the errors.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), keys: () => [...m.keys()] };
};
globalThis.sessionStorage = store();
globalThis.localStorage = store();

const { HttpBackend, normaliseServer, idPath, checkHealth } = await import('../../electrotag/web/static/js/api/http.js');

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

test('addresses and recording identifiers', () => {
  assert.equal(normaliseServer('study.example.org/'), 'https://study.example.org');
  assert.equal(normaliseServer('localhost:8000'), 'http://localhost:8000');
  assert.equal(normaliseServer('https://x.org/api/v1'), 'https://x.org');
  assert.equal(idPath('sub-01/eeg/sub 01.edf'), 'sub-01/eeg/sub%2001.edf');
});

test('signing in keeps the token for the tab and sends it with the header', async () => {
  reply = (url) => (url.endsWith('/login') ? { status: 200, body: { token: 'T', annotator_id: 'A01' } } : { status: 200, body: { ok: true } });
  const b = new HttpBackend('https://s.org');
  await b.login('A01', 'pw');
  assert.equal(calls[0].url, 'https://s.org/api/v1/login');
  assert.equal(calls[0].headers['X-ElectroTag'], '1');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].credentials, 'omit');
  assert.deepEqual(JSON.parse(globalThis.sessionStorage.getItem('electrotag.token')), { server: 'https://s.org', token: 'T' });
  assert.equal(globalThis.localStorage.keys().length, 0);
  await b.putDraft('sub-01/eeg/x.edf', 'guided', 'set 1', { annotations: [] });
  const put = calls[1];
  assert.equal(put.method, 'PUT');
  assert.equal(put.url, 'https://s.org/api/v1/drafts/sub-01/eeg/x.edf?mode=guided&context=set%201');
  assert.equal(put.headers.Authorization, 'Bearer T');
  assert.equal(put.headers['Content-Type'], 'application/json');
  // A new backend for the same server in the same tab is still signed in; another server is not.
  assert.equal(new HttpBackend('https://s.org/').signedIn, true);
  assert.equal(new HttpBackend('https://other.org').signedIn, false);
});

test('errors carry the server message; 401 signs out', async () => {
  let expired = 0;
  reply = (url) => (url.endsWith('/submissions') ? { status: 409, body: { error: 'already_done', message: 'Saved already.' } }
    : { status: 401, body: { error: 'not_signed_in', message: 'Please sign in again.' } });
  globalThis.sessionStorage.setItem('electrotag.token', JSON.stringify({ server: 'https://s.org', token: 'T' }));
  const b = new HttpBackend('https://s.org', { onUnauthorized: () => { expired += 1; } });
  await assert.rejects(() => b.submit({}), (e) => e.status === 409 && e.code === 'already_done' && e.message === 'Saved already.');
  await assert.rejects(() => b.assignments(), (e) => e.status === 401);
  assert.equal(expired, 1);
  assert.equal(b.signedIn, false);
  assert.equal(globalThis.sessionStorage.getItem('electrotag.token'), null);
});

test('the health check needs an ElectroTag answer', async () => {
  reply = () => ({ status: 200, body: { ok: true, study: 'S' } });
  assert.equal((await checkHealth('https://s.org')).study, 'S');
  assert.equal(calls[0].url, 'https://s.org/api/v1/health');
  assert.equal(calls[0].headers.Authorization, undefined);
  reply = () => ({ status: 200, body: { hello: 'world' } });
  await assert.rejects(() => checkHealth('https://s.org'), (e) => e.code === 'not_electrotag');
});

test('events can be sent while the page closes (keepalive)', async () => {
  reply = () => ({ status: 200, body: {} });
  const b = new HttpBackend('https://s.org');
  await b.sendEvents('v/1', [{ t: 1, type: 'key' }], { keepalive: true });
  assert.equal(calls[0].url, 'https://s.org/api/v1/visits/v%2F1/events');
  assert.equal(calls[0].keepalive, true);
  assert.deepEqual(JSON.parse(calls[0].body), { events: [{ t: 1, type: 'key' }] });
});

test('achievements: GET and POST /me/achievements', async () => {
  reply = () => ({ status: 200, body: { enabled: true } });
  const b = new HttpBackend('https://s.org');
  assert.equal((await b.achievements()).enabled, true);
  await b.setAchievements({ leaderboard_hidden: true });
  assert.deepEqual([calls[0].method, calls[0].url], ['GET', 'https://s.org/api/v1/me/achievements']);
  assert.deepEqual([calls[1].method, calls[1].url, JSON.parse(calls[1].body)], ['POST', 'https://s.org/api/v1/me/achievements', { leaderboard_hidden: true }]);
});

test('the expert channel, feedback and the training stages have their routes', async () => {
  reply = () => ({ status: 200, body: { ok: 1 } });
  const b = new HttpBackend('https://s.org');
  await b.expert('replay_consent_set', { teaching: true });
  await b.myFeedback();
  await b.trainingStage({ stage: 'tour', action: 'skip' });
  await b.trainingSnippets();
  const seen = calls.map((c) => [c.method, c.url.replace('https://s.org/api/v1', ''), c.body ? JSON.parse(c.body) : null]);
  assert.deepEqual(seen, [
    ['POST', '/expert/replay_consent_set', { teaching: true }],
    ['GET', '/me/feedback', null],
    ['POST', '/training/stage', { stage: 'tour', action: 'skip' }],
    ['GET', '/training/snippets', null],
  ]);
  assert.ok(calls.every((c) => c.headers['X-ElectroTag'] === '1'));
  await assert.rejects(() => b.expert('../admin/overview', {}), (e) => e.status === 400 && e.code === 'bad_request');
  assert.equal(calls.length, 4); // a name that is not an operation is never sent
  reply = () => ({ status: 403, body: { error: 'forbidden', message: 'Only the study\'s experts and administrators can use the expert area' } });
  await assert.rejects(() => b.expert('work_list', {}), (e) => e.status === 403 && e.code === 'forbidden');
});

test('an invitation link is checked and accepted without a sign-in, then signs the person in', async () => {
  reply = (url) => (url.endsWith('/invite/check') ? { status: 200, body: { annotator_id: 'A11', study_name: 'S' } }
    : url.endsWith('/invite/accept') ? { status: 200, body: { token: 'NEW', annotator_id: 'A11' } }
      : { status: 200, body: {} });
  const b = new HttpBackend('https://s.org');
  assert.equal(b.acceptsInvites, true);
  assert.equal((await b.inviteCheck('t'.repeat(43))).annotator_id, 'A11');
  assert.equal(calls[0].url, 'https://s.org/api/v1/invite/check');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].body), { token: 't'.repeat(43) });
  await b.inviteAccept('t'.repeat(43), 'a long password');
  assert.equal(calls[1].url, 'https://s.org/api/v1/invite/accept');
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(globalThis.sessionStorage.getItem('electrotag.token')), { server: 'https://s.org', token: 'NEW' });
  reply = () => ({ status: 409, body: { error: 'invite_used', message: 'This invitation link has been used already.' } });
  await assert.rejects(() => b.inviteCheck('t'.repeat(43)), (e) => e.code === 'invite_used' && /used already/.test(e.message));
});

test('the sign-in page names what could not be reached, and never an undefined address', async () => {
  const { unreachableText } = await import('../../electrotag/web/static/js/api/choose.js');
  assert.match(unreachableText({ kind: 'server', address: 'https://study.example.org' }), /^The study server at https:\/\/study\.example\.org does not answer\. /);
  assert.match(unreachableText({ kind: 'server', address: 'https://x.org' }, { code: 'not_electrotag' }), /does not answer as an ElectroTag study server/);
  assert.match(unreachableText({ kind: 'firebase' }, new Error('offline')), /^The study could not be loaded \(offline\)/);
  for (const where of [{ kind: 'demo', source: 'none' }, null, { kind: 'server' }]) {
    const text = unreachableText(where, new Error('boom'));
    assert.match(text, /^The demonstration could not be started/);
    assert.doesNotMatch(text, /undefined/);
  }
});
