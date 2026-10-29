// Recordings kept on this device: copies of the EEG files of recordings an annotator opened (from a
// link, or from the computer when they asked for it), so that they open again without downloading.
// The copies live in this browser's storage for the site: the Origin Private File System where the
// browser can write files there from the page (FileSystemFileHandle.createWritable), and IndexedDB,
// holding the files as Blobs, everywhere else. Each copy is filed under the study, the annotator and
// the recording's fingerprint (the SHA-256 checked against the study's manifest), so that people
// sharing a computer never see each other's copies. Only the files and their names are kept, never
// the link they came from (a link is a secret). Removing a copy never touches annotations, drafts or
// results, which live with the study.
//
// The functions before the DeviceStore class are pure and tested in Node; the class needs a browser.

/** The folder of the Origin Private File System, and the IndexedDB database, that hold the copies. */
export const ROOT_NAME = 'electroclean-recordings';
const DB_NAME = 'electroclean-device';
const DB_STORE = 'recordings';
const META = 'meta.json';

/** A storage problem; kind 'full' when the device has no room, 'broken' for a damaged copy. */
export class DeviceStoreError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

/** A name that is safe as one folder of the file system: no slashes, never "." or "..". */
export function safeSegment(text) {
  const s = encodeURIComponent(String(text ?? '')).replace(/\./g, '%2E').replace(/\*/g, '%2A');
  return s || '_';
}

/**
 * Whose copies these are: the study (with the kind of backend, so that the demonstration and a
 * real study never mix) and the annotator.
 */
export function ownerKey({ backend = '', studyId = '', annotatorId = '' } = {}) {
  return `${safeSegment(`${backend}:${studyId}`)}/${safeSegment(annotatorId)}`;
}

/** The key of one kept recording: its owner and its fingerprint. */
export function recordingKey(owner, sha256) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256))) throw new DeviceStoreError('A kept recording needs its SHA-256 fingerprint', 'bad_key');
  return `${owner}/${sha256}`;
}

/** Whether an error means that the device (or the browser's share of it) is full. */
export function isQuotaError(e) {
  if (!e) return false;
  if (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014 || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  // Safari sometimes reports a full disk as an UnknownError, or an abort of the transaction
  return /quota|disk is full|not enough (space|storage)|exceeded/i.test(String(e.message || ''));
}

/** Which kind of storage this browser offers: 'opfs', 'idb' or null. */
export function chooseBackend(env = globalThis) {
  try {
    const storage = env.navigator && env.navigator.storage;
    const fh = env.FileSystemFileHandle;
    if (storage && typeof storage.getDirectory === 'function' && fh && fh.prototype && typeof fh.prototype.createWritable === 'function') return 'opfs';
  } catch { /* fall through */ }
  try { if (env.indexedDB) return 'idb'; } catch { /* blocked */ }
  return null;
}

/**
 * Whether the annotator has finished each kept recording, from the assignments of the home page:
 * 'done' when every assignment of the recording is done, 'open' when one is not, 'other' when the
 * recording is not among the annotator's assignments (any more).
 */
export function finishedState(kept, assignmentItems) {
  const by = new Map();
  for (const it of assignmentItems || []) {
    const list = by.get(it.recording_id) || [];
    list.push(it.status);
    by.set(it.recording_id, list);
  }
  return kept.map((k) => {
    const st = by.get(k.recordingId);
    if (!st || !st.length) return 'other';
    return st.every((s) => s === 'done') ? 'done' : 'open';
  });
}

/** The kept recordings that "Remove finished recordings" removes, and the space it frees. */
export function finishedToRemove(kept, assignmentItems) {
  const state = finishedState(kept, assignmentItems);
  const remove = kept.filter((_, i) => state[i] === 'done');
  return { remove, bytes: remove.reduce((a, k) => a + (k.size || 0), 0) };
}

/** Count and size of the kept recordings. */
export function summarise(kept) {
  return { count: kept.length, bytes: kept.reduce((a, k) => a + (k.size || 0), 0) };
}

/** The description written with a copy (no link, no path; the files' own names and sizes). */
export function makeMeta({ sha256, recordingId, fileName, files, now = new Date() }) {
  const list = Array.from(files).map((f) => ({ name: String(f.name), size: Number(f.size) || 0 }));
  return { version: 1, sha256, recordingId: String(recordingId || ''), fileName: String(fileName || (list[0] && list[0].name) || ''),
    files: list, size: list.reduce((a, f) => a + f.size, 0), keptAt: now.toISOString() };
}

// ---------------------------------------------------------------------------------- storage
/** The Origin Private File System: ROOT_NAME/<owner>/<sha256>/{files, meta.json}. */
class OpfsBackend {
  constructor() { this.kind = 'opfs'; }

  async _dir(path, create) {
    let d = await navigator.storage.getDirectory();
    for (const part of [ROOT_NAME, ...path.split('/')]) d = await d.getDirectoryHandle(part, { create });
    return d;
  }

  async list(owner) {
    let dir;
    try { dir = await this._dir(owner, false); } catch { return []; }
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'directory') continue;
      try {
        const meta = JSON.parse(await (await (await handle.getFileHandle(META)).getFile()).text());
        if (meta && meta.sha256 === name) out.push(meta);
      } catch {
        // a copy whose description was never written (the device filled up, or the page closed)
        try { await dir.removeEntry(name, { recursive: true }); } catch { /* leave it */ }
      }
    }
    return out;
  }

  async put(owner, meta, files) {
    const dir = await this._dir(`${owner}/${meta.sha256}`, true);
    try {
      for (const f of files) await writeFile(dir, f.name, f);
      await writeFile(dir, META, new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    } catch (e) {
      await this.remove(owner, meta.sha256).catch(() => {});
      throw e;
    }
  }

  async get(owner, sha256) {
    let dir;
    try { dir = await this._dir(`${owner}/${sha256}`, false); } catch { return null; }
    const meta = JSON.parse(await (await (await dir.getFileHandle(META)).getFile()).text());
    const files = [];
    for (const f of meta.files) files.push(await (await dir.getFileHandle(f.name)).getFile());
    return { meta, files };
  }

  async remove(owner, sha256) {
    let dir;
    try { dir = await this._dir(owner, false); } catch { return; }
    try { await dir.removeEntry(sha256, { recursive: true }); } catch (e) { if (e && e.name !== 'NotFoundError') throw e; }
  }
}

async function writeFile(dir, name, blob) {
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  try {
    await w.write(blob);
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* already closed */ }
    throw e;
  }
}

/** IndexedDB: one record per copy, {key, owner, meta, files: [{name, blob}]}, written at once. */
class IdbBackend {
  constructor() { this.kind = 'idb'; this._db = null; }

  _open() {
    if (this._db) return this._db;
    this._db = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(DB_STORE, { keyPath: 'key' });
        store.createIndex('owner', 'owner');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new DeviceStoreError('The storage of this site is in use by another tab', 'blocked'));
    });
    this._db.catch(() => { this._db = null; });
    return this._db;
  }

  async _tx(mode, fn) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      let out;
      tx.oncomplete = () => resolve(out);
      tx.onabort = () => reject(tx.error || new DeviceStoreError('The storage of this site refused the change', 'aborted'));
      tx.onerror = () => { /* onabort follows */ };
      const store = tx.objectStore(DB_STORE);
      const req = fn(store);
      if (req) req.onsuccess = () => { out = req.result; };
    });
  }

  async list(owner) {
    const rows = await this._tx('readonly', (s) => s.index('owner').getAll(owner));
    return (rows || []).map((r) => r.meta);
  }

  async put(owner, meta, files) {
    const record = { key: recordingKey(owner, meta.sha256), owner, meta, files: files.map((f) => ({ name: f.name, blob: f })) };
    await this._tx('readwrite', (s) => s.put(record));
  }

  async get(owner, sha256) {
    const r = await this._tx('readonly', (s) => s.get(recordingKey(owner, sha256)));
    if (!r) return null;
    return { meta: r.meta, files: r.files.map((f) => (f.blob instanceof File && f.blob.name === f.name ? f.blob : new File([f.blob], f.name))) };
  }

  async remove(owner, sha256) {
    await this._tx('readwrite', (s) => s.delete(recordingKey(owner, sha256)));
  }
}

/** The copies of one annotator in one study. */
export class DeviceStore {
  /** @param {{owner: string, kind?: 'opfs'|'idb'|null}} options */
  constructor({ owner, kind = chooseBackend() }) {
    this.owner = owner;
    this.kind = kind;
    this._backend = kind === 'opfs' ? new OpfsBackend() : kind === 'idb' ? new IdbBackend() : null;
  }

  get available() { return Boolean(this._backend); }

  /**
   * Whether this browser really lets the page keep files here: private windows, and some embedded
   * browsers, offer the interfaces but refuse to store anything. Tried once with a few bytes.
   * @returns {Promise<boolean>}
   */
  usable() {
    if (!this._usable) this._usable = this._probe();
    return this._usable;
  }

  async _probe() {
    const sha = '0'.repeat(64);
    const meta = makeMeta({ sha256: sha, recordingId: '', fileName: 'probe', files: [{ name: 'probe', size: 1 }] });
    for (let i = 0; i < 2 && this._backend; i++) {
      try {
        await this._backend.put(this.owner, meta, [new File([new Uint8Array(1)], 'probe')]);
        await this._backend.remove(this.owner, sha);
        return true;
      } catch (e) {
        if (isQuotaError(e)) return true; // it works, and is full: keeping says so when it is tried
        if (this.kind === 'opfs' && !this._fellBack) this._fallBack(); else break;
      }
    }
    this._backend = null;
    this.kind = null;
    return false;
  }

  /** The descriptions of the kept recordings, newest first. */
  async list() {
    if (!this._backend) return [];
    try {
      const out = await this._backend.list(this.owner);
      return out.sort((a, b) => String(b.keptAt).localeCompare(String(a.keptAt)));
    } catch (e) {
      if (this.kind === 'opfs' && !this._fellBack) return this._fallBack().list();
      throw e;
    }
  }

  /** The kept copy of a recording of the study, by its ID (null when there is none). */
  async findByRecording(recordingId) {
    return (await this.list()).find((m) => m.recordingId === recordingId) || null;
  }

  /**
   * Keep the files of a recording.
   * @throws {DeviceStoreError} kind 'full' when there is no room (nothing is left behind)
   */
  async keep({ sha256, recordingId, fileName, files }) {
    if (!this._backend) throw new DeviceStoreError('This browser cannot keep recordings', 'unavailable');
    const meta = makeMeta({ sha256, recordingId, fileName, files });
    recordingKey(this.owner, sha256);
    try {
      await this._backend.put(this.owner, meta, Array.from(files));
    } catch (e) {
      if (isQuotaError(e)) throw new DeviceStoreError('There is no room left on this device to keep the recording', 'full');
      // Private windows of some browsers refuse the file system: IndexedDB may still work.
      if (this.kind === 'opfs' && !this._fellBack) return this._fallBack().keep({ sha256, recordingId, fileName, files });
      throw e;
    }
    return meta;
  }

  /** The kept files of a recording, or null; a damaged copy is removed and reported as 'broken'. */
  async open(sha256) {
    if (!this._backend) return null;
    let got;
    try {
      got = await this._backend.get(this.owner, sha256);
    } catch {
      await this.remove(sha256).catch(() => {});
      throw new DeviceStoreError('The copy kept on this device could not be read', 'broken');
    }
    if (!got) return null;
    const sizes = got.meta.files.map((f) => f.size);
    if (got.files.length !== sizes.length || got.files.some((f, i) => f.size !== sizes[i])) {
      await this.remove(sha256).catch(() => {});
      throw new DeviceStoreError('The copy kept on this device is incomplete', 'broken');
    }
    return got;
  }

  async remove(sha256) {
    if (this._backend) await this._backend.remove(this.owner, sha256);
  }

  /** Remove several copies; resolves with their number and size. */
  async removeMany(metas) {
    let bytes = 0;
    for (const m of metas) { await this.remove(m.sha256); bytes += m.size || 0; }
    return { count: metas.length, bytes };
  }

  async removeAll() {
    return this.removeMany(await this.list());
  }

  _fallBack() {
    this._fellBack = true;
    this.kind = 'idb';
    this._backend = typeof indexedDB !== 'undefined' ? new IdbBackend() : null;
    return this;
  }

  /** Space used and available for this site ({usage, quota} in bytes), or null. */
  static async estimate() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    } catch { return null; }
  }

  /** Ask the browser not to clear this site's storage when space runs low (true when granted). */
  static async persist() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return false;
      if (navigator.storage.persisted && (await navigator.storage.persisted())) return true;
      return await navigator.storage.persist();
    } catch { return false; }
  }
}
