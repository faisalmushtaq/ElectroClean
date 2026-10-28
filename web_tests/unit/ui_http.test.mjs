// The study server backend (js/api/http.js) follows docs/web/api.md: the bearer token, the
// X-ElectroClean header, sessionStorage only, and the errors.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), keys: () => [...m.keys()] };
};
globalThis.sessionStorage = store();
globalThis.localStorage = store();

const { HttpBackend, normaliseServer, idPath, checkHealth } = await import('../../electroclean/web/static/js/api/http.js');

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
  assert.equal(calls[0].headers['X-ElectroClean'], '1');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].credentials, 'omit');
  assert.deepEqual(JSON.parse(globalThis.sessionStorage.getItem('electroclean.token')), { server: 'https://s.org', token: 'T' });
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
  globalThis.sessionStorage.setItem('electroclean.token', JSON.stringify({ server: 'https://s.org', token: 'T' }));
  const b = new HttpBackend('https://s.org', { onUnauthorized: () => { expired += 1; } });
  await assert.rejects(() => b.submit({}), (e) => e.status === 409 && e.code === 'already_done' && e.message === 'Saved already.');
  await assert.rejects(() => b.assignments(), (e) => e.status === 401);
  assert.equal(expired, 1);
  assert.equal(b.signedIn, false);
  assert.equal(globalThis.sessionStorage.getItem('electroclean.token'), null);
});

test('the health check needs an ElectroClean answer', async () => {
  reply = () => ({ status: 200, body: { ok: true, study: 'S' } });
  assert.equal((await checkHealth('https://s.org')).study, 'S');
  assert.equal(calls[0].url, 'https://s.org/api/v1/health');
  assert.equal(calls[0].headers.Authorization, undefined);
  reply = () => ({ status: 200, body: { hello: 'world' } });
  await assert.rejects(() => checkHealth('https://s.org'), (e) => e.code === 'not_electroclean');
});

test('events can be sent while the page closes (keepalive)', async () => {
  reply = () => ({ status: 200, body: {} });
  const b = new HttpBackend('https://s.org');
  await b.sendEvents('v/1', [{ t: 1, type: 'key' }], { keepalive: true });
  assert.equal(calls[0].url, 'https://s.org/api/v1/visits/v%2F1/events');
  assert.equal(calls[0].keepalive, true);
  assert.deepEqual(JSON.parse(calls[0].body), { events: [{ t: 1, type: 'key' }] });
});
