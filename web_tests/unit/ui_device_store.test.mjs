// Recordings kept on this device (js/data/device_store.js): the keys that keep people's copies
// apart, the choice of storage, what "Remove finished recordings" removes, full devices, and the
// descriptions that a page reads once (WebKit refuses reads while a page is being left). The
// storage itself (the Origin Private File System and IndexedDB) is tried in Chromium and WebKit
// (web_tests/e2e/l_device.e2e.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { safeSegment, ownerKey, recordingKey, isQuotaError, chooseBackend, finishedState, finishedToRemove, summarise, makeMeta,
  DeviceStore, DeviceStoreError } = await import('../../electrotag/web/static/js/data/device_store.js');

const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);

test('keys keep studies, backends and annotators apart, and are safe as folder names', () => {
  const a = ownerKey({ backend: 'firebase', studyId: 'pilot', annotatorId: 'A01' });
  assert.equal(a, 'firebase%3Apilot/A01');
  assert.notEqual(a, ownerKey({ backend: 'firebase', studyId: 'pilot', annotatorId: 'A02' }));
  assert.notEqual(a, ownerKey({ backend: 'server', studyId: 'pilot', annotatorId: 'A01' }));
  assert.notEqual(a, ownerKey({ backend: 'firebase', studyId: 'main', annotatorId: 'A01' }));
  // two study servers whose studies have the same ID, opened from the same page
  const one = ownerKey({ backend: 'server', server: 'https://eeg.one.example', studyId: 'pilot', annotatorId: 'A01' });
  assert.notEqual(one, ownerKey({ backend: 'server', server: 'https://eeg.two.example', studyId: 'pilot', annotatorId: 'A01' }));
  assert.equal(one.split('/').length, 2);
  // every part is one folder: no slashes, never "." or ".."
  for (const s of ['..', '.', 'a/b', 'a\\b', '', 'x*y', 'jo.bloggs@uni.ac.uk']) {
    const seg = safeSegment(s);
    assert.ok(seg.length > 0 && !/[/\\*]/.test(seg) && seg !== '.' && seg !== '..', `${s} -> ${seg}`);
  }
  assert.equal(ownerKey({ backend: 'server', studyId: 'a/b', annotatorId: '../x' }).split('/').length, 2);
  assert.equal(recordingKey(a, SHA), `${a}/${SHA}`);
  assert.throws(() => recordingKey(a, 'not-a-fingerprint'), DeviceStoreError);
  assert.throws(() => recordingKey(a, SHA.toUpperCase()), DeviceStoreError);
});

test('a full device is recognised in the forms browsers report it', () => {
  assert.ok(isQuotaError(new DOMException('full', 'QuotaExceededError')));
  assert.ok(isQuotaError({ name: 'Error', code: 22 }));
  assert.ok(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }));
  assert.ok(isQuotaError({ name: 'UnknownError', message: 'Quota exceeded' }));
  assert.ok(isQuotaError({ name: 'UnknownError', message: 'The disk is full' }));
  assert.ok(!isQuotaError(new DOMException('gone', 'NotFoundError')));
  assert.ok(!isQuotaError(null));
});

test('the Origin Private File System is used where the page can write to it, IndexedDB otherwise', () => {
  const opfs = { navigator: { storage: { getDirectory() {} } }, FileSystemFileHandle: class { createWritable() {} }, indexedDB: {} };
  assert.equal(chooseBackend(opfs), 'opfs');
  // Safari before 26 has the file system, but writes to it only from workers
  const olderSafari = { navigator: { storage: { getDirectory() {} } }, FileSystemFileHandle: class { getFile() {} }, indexedDB: {} };
  assert.equal(chooseBackend(olderSafari), 'idb');
  assert.equal(chooseBackend({ navigator: {}, indexedDB: {} }), 'idb');
  assert.equal(chooseBackend({ navigator: {} }), null);
  const blocked = { navigator: {}, get indexedDB() { throw new Error('SecurityError'); } };
  assert.equal(chooseBackend(blocked), null);
  assert.equal(new DeviceStore({ owner: 'x/y', kind: null }).available, false);
});

test('finished recordings are those whose every assignment is done', () => {
  const kept = [
    { sha256: SHA, recordingId: 'sub-01', size: 100 },
    { sha256: SHA2, recordingId: 'sub-02', size: 50 },
    { sha256: 'c'.repeat(64), recordingId: 'sub-03', size: 7 },
    { sha256: 'd'.repeat(64), recordingId: 'gone', size: 1 },
  ];
  const items = [
    { recording_id: 'sub-01', mode: 'standard', status: 'done' },
    { recording_id: 'sub-02', mode: 'practice', status: 'done' },
    { recording_id: 'sub-02', mode: 'assessment', status: 'todo' },
    { recording_id: 'sub-03', mode: 'standard', status: 'in_progress' },
  ];
  assert.deepEqual(finishedState(kept, items), ['done', 'open', 'open', 'other']);
  const r = finishedToRemove(kept, items);
  assert.deepEqual(r.remove.map((k) => k.recordingId), ['sub-01']);
  assert.equal(r.bytes, 100);
  assert.deepEqual(finishedToRemove(kept, []).remove, []);
  assert.deepEqual(summarise(kept), { count: 4, bytes: 158 });
  assert.deepEqual(summarise([]), { count: 0, bytes: 0 });
});

test('a copy is described by its files\' names and sizes, never by where it came from', () => {
  const files = [{ name: 'r.vhdr', size: 10 }, { name: 'r.vmrk', size: 20 }, { name: 'r.eeg', size: 3000 }];
  const m = makeMeta({ sha256: SHA, recordingId: 'sub-01/r', fileName: 'r.vhdr', files, now: new Date('2026-10-28T12:00:00Z') });
  assert.deepEqual(m, { version: 1, sha256: SHA, recordingId: 'sub-01/r', fileName: 'r.vhdr', files, size: 3030, keptAt: '2026-10-28T12:00:00.000Z' });
  assert.ok(!JSON.stringify(m).includes('http'));
});

test('a copy marked in use (in any tab) is kept by Remove; the mark ends with its recording', async () => {
  const { inUseLockName } = await import('../../electrotag/web/static/js/data/device_store.js');
  // A stand-in for the Web Locks API, shared by "tabs" as the browser's is.
  const held = new Map();
  const locks = {
    async request(name, opts, cb) {
      const h = held.get(name) || { shared: 0, exclusive: false };
      held.set(name, h);
      if (opts.ifAvailable && (h.exclusive || h.shared)) return cb(null);
      if (opts.mode === 'shared') h.shared += 1; else h.exclusive = true;
      try { return await cb({ name, mode: opts.mode }); } finally { if (opts.mode === 'shared') h.shared -= 1; else h.exclusive = false; }
    },
  };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true });
  try {
    const removed = [];
    const store = new DeviceStore({ owner: 'o', kind: null });
    store._backend = { remove: async (_o, sha) => { removed.push(sha); } };
    const release = await DeviceStore.holdInUse(SHA);
    assert.equal(held.get(inUseLockName(SHA)).shared, 1);
    const r = await store.removeMany([{ sha256: SHA, size: 10 }, { sha256: SHA2, size: 5 }]);
    assert.deepEqual(r, { count: 1, bytes: 5, inUse: 1 });
    assert.deepEqual(removed, [SHA2]);
    release();
    await new Promise((res) => setTimeout(res, 0));
    assert.equal(await store.remove(SHA), true);
    assert.deepEqual(removed, [SHA2, SHA]);
  } finally {
    if (had) Object.defineProperty(globalThis, 'navigator', had); else delete globalThis.navigator;
  }
});

test('a description is read once per page, and again only when its file has been rewritten', async () => {
  const { DescriptionCache } = await import('../../electrotag/web/static/js/data/device_store.js');
  const cache = new DescriptionCache();
  const key = `o/${SHA}`;
  const meta = makeMeta({ sha256: SHA, recordingId: 'sub-01', fileName: 'r.edf', files: [{ name: 'r.edf', size: 10 }], now: new Date('2026-10-29T09:00:00Z') });
  const file = { size: 180, lastModified: 1000 };
  assert.equal(cache.get(key, file), null, 'nothing is known before the first read');
  cache.set(key, file, meta);
  assert.deepEqual(cache.get(key, { size: 180, lastModified: 1000 }), meta, 'the same file needs no read');
  // a copy each time, so that a caller cannot change what is known
  const got = cache.get(key, file);
  got.files.push({ name: 'x', size: 1 });
  assert.deepEqual(cache.get(key, file), meta);
  meta.recordingId = 'changed by the caller';
  assert.equal(cache.get(key, file).recordingId, 'sub-01');
  // rewritten (here or in another tab): changed time or size, so it is read again
  assert.equal(cache.get(key, { size: 180, lastModified: 2000 }), null);
  assert.equal(cache.get(key, { size: 181, lastModified: 1000 }), null);
  assert.equal(cache.get(`o/${SHA2}`, file), null, 'each copy has its own description');
  cache.set(`o/${SHA2}`, file, null);
  assert.equal(cache.get(`o/${SHA2}`, file), null, 'a description that is not one is never kept');
  cache.drop(key);
  assert.equal(cache.get(key, file), null, 'a removed copy is forgotten');
});
