// Datasets, collections, groups and hand-outs in the sandbox (docs/web/api.md, "Datasets, collections, groups
// and hand-outs"), carried out on the sandbox's own state in this browser as electrotag/web/datasets.py does them
// on a server, with the tracking reads of electrotag/web/tracking.py and the list of what would be notified. It is
// loaded on demand (js/lazy.js part demoLibrary) by demo_admin.js, for these operations, and by demo.js for
// GET /assignments once the sandbox has a hand-out, so that the sign-in page stays within its budget.
//
// The records live in the admin state's `library` ({datasets, collections, groups, handouts}, by ID); a study
// recording's dataset is its record's `dataset_id` (none means the built-in dataset) and an assignment's hand-out
// its `handout_id`. Nothing is ever deleted: a dataset, collection or group that is removed is marked so. A hand-out
// shared out k per recording uses Tasks, which need the study's Python code, so it is answered with needs_server.

import { ApiError } from './http.js';
import { needsServer } from './demo_admin.js';
import { indexRows } from './demo_corrections.js';
import { sha256Hex } from '../eeg/sha256.js';
import { nowLocalIso } from '../util.js';
import { deepCopy, rolesOf } from '../admin/model.js';

export const DEFAULT_DATASET_ID = 'study-recordings';
export const DEFAULT_DATASET_NAME = 'Study recordings';
const DEFAULT_DATASET_DESCRIPTION = 'Recordings registered before datasets existed, and those added without choosing one.';
const CHOSEN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REQUEST_RE = /^[0-9a-f]{32}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const AID_RE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
const HANDOUT_RE = /^h-[0-9a-f]{10}$/;
const STATES = ['active', 'archived'];
const DATASET_TEXT = { name: 120, description: 5000, origin: 500, licence: 200, citation: 2000, contact: 200, notes: 5000 };
export const RATINGS_TARGET = 2;
const [RATINGS_MIN, RATINGS_MAX] = [1, 20];
const MAX_COLLECTION = 2000;
const [MAX_GROUP_MEMBERS, MAX_GROUP_HISTORY] = [200, 1000];
const CHANGES_KEPT = 100;
const MAX_LINKED = 5000;
const TARGET_KINDS = ['dataset', 'collection'];
const KINDS = ['datasets', 'collections', 'groups', 'handouts'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const K_SERVER = 'share recordings out k per recording (that uses tasks)';

const bad = (message, code = 'bad_request') => new ApiError(400, code, message);
const notFound = (code, message) => new ApiError(404, code, message);
const conflict = (code, message) => new ApiError(409, code, message);
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const has = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const given = (body, k) => has(body, k) && body[k] !== null && body[k] !== undefined;
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedText = (list) => [...list].sort(byText);
const hex = (n, ...parts) => sha256Hex(new TextEncoder().encode(parts.join(':'))).slice(0, n);
const sameTarget = (t, kind, id) => Boolean(t) && t.kind === kind && t.id === id;

/** The study's local date, YYYY-MM-DD (a hand-out is overdue from the day after its due date). */
export function today() { return nowLocalIso().slice(0, 10); }

/** "20 November" (a due date as the titles say it). */
export function dayWords(day) {
  const [, m, d] = String(day).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** What annotators see of a hand-out unless the study team says otherwise (datasets.py default_title). */
export function defaultTitle(kind, name, dueAt) {
  if (kind === 'dataset') return name;
  return dueAt ? `Recordings due ${dayWords(dueAt)}` : 'Recordings to annotate';
}

// ------------------------------------------------------------------ checking input (admin.py _text, _bool, _aid)
function text(body, key, { required = false, limit = 200 } = {}) {
  const v = has(body, key) ? body[key] : null;
  if (v === null || v === undefined) {
    if (required) throw bad(`${key} is missing`);
    return '';
  }
  if (typeof v !== 'string' || v.length > limit) throw bad(`${key} must be text of at most ${limit} characters`);
  const t = v.trim();
  if (required && !t) throw bad(`${key} is missing`);
  return t;
}

function flag(body, key) {
  const v = has(body, key) ? body[key] : null;
  if (v === null || v === undefined) return null;
  if (typeof v !== 'boolean') throw bad(`${key} must be true or false`);
  return v;
}

function aidOf(value, what = 'annotator_id') {
  if (typeof value !== 'string') throw bad(`${what} is missing`);
  const aid = value.trim().toUpperCase();
  if (!AID_RE.test(aid)) throw bad(`${what}: An ID must be 1 to 32 letters, digits, hyphens or underscores, starting with a letter or digit (for example A01)`);
  return aid;
}

function ids(value, what) {
  if (!Array.isArray(value) || value.length > 1000) throw bad(`${what} must be a list of at least 0 ID(s)`);
  const out = value.map((v) => aidOf(v, what));
  if (new Set(out).size !== out.length) throw bad(`${what} names someone twice`);
  return out;
}

function requestId(body) {
  const rid = body.request_id;
  if (typeof rid !== 'string' || !REQUEST_RE.test(rid)) throw bad('request_id must be 32 hexadecimal characters, made by the browser for this request');
  return rid;
}

function ratingsTarget(body, fallback = RATINGS_TARGET) {
  const v = has(body, 'ratings_target') ? body.ratings_target : fallback;
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < RATINGS_MIN || v > RATINGS_MAX) {
    throw bad(`ratings_target (the people who should rate each recording) must be a whole number from ${RATINGS_MIN} to ${RATINGS_MAX}`);
  }
  return v;
}

function stateOf(body) {
  const s = body.state;
  if (s !== null && s !== undefined && !STATES.includes(s)) throw bad("state must be 'active' or 'archived'");
  return s ?? null;
}

function dueOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const ok = typeof value === 'string' && DAY_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!ok) throw bad('due_at must be a date, YYYY-MM-DD, or null');
  return value;
}

/** Why a path_prefix cannot be used ('' when it can): a plain relative folder, without '.' or '..'. */
export function prefixProblem(prefix) {
  if (typeof prefix !== 'string') return 'path_prefix must be text';
  const t = prefix.trim().replace(/^\/+|\/+$/g, '');
  if (!t) return '';
  const parts = t.split('/');
  if (t.length > 120 || /[\\:*?"<>|\0]/.test(t) || parts.some((p) => !p || p === '.' || p === '..')) {
    return "path_prefix must be a plain relative folder of at most 120 characters, without '.' or '..'";
  }
  return '';
}

/** A copy of a manifest with prefix/ in front of its recording ID and its paths (manifest.py prefix_manifest). */
export function prefixManifest(m, prefix) {
  const p = String(prefix || '').replace(/^\/+|\/+$/g, '');
  if (!p || !m || typeof m !== 'object') return m;
  const out = deepCopy(m);
  const put = (v) => (typeof v === 'string' && v ? `${p}/${v}` : v);
  for (const k of ['recording_id', 'relative_path']) if (has(out, k)) out[k] = put(out[k]);
  if (out.files && typeof out.files === 'object') {
    for (const [k, v] of Object.entries(out.files)) if (k !== 'stem') out.files[k] = Array.isArray(v) ? v.map(put) : put(v);
  }
  if (out.fingerprint && typeof out.fingerprint === 'object') {
    for (const fp of Object.values(out.fingerprint)) if (fp && typeof fp === 'object' && has(fp, 'path')) fp.path = put(fp.path);
  }
  if (out.original_events && out.original_events.path) out.original_events.path = put(out.original_events.path);
  return out;
}

/** Recordings by the number of people who saved them. */
export function ratingsHistogram(rids, rated) {
  const out = { 0: 0, 1: 0, 2: 0, '3+': 0 };
  for (const r of rids) {
    const n = rated[r] || 0;
    out[n >= 3 ? '3+' : String(n)] += 1;
  }
  return out;
}

const changesWith = (record, entry) => [...(record.changes || []), entry].slice(-CHANGES_KEPT);

function summaryOf(heads) {
  const formats = {};
  for (const h of heads) formats[h.format] = (formats[h.format] || 0) + 1;
  const chans = heads.map((h) => h.n_channels);
  const regs = sortedText(heads.map((h) => h.registered_at).filter(Boolean));
  return {
    n_recordings: heads.length, n_retired: heads.filter((h) => h.retired).length, formats,
    sfreq: [...new Set(heads.map((h) => Number(h.sfreq)))].sort((a, b) => a - b),
    n_channels: { min: chans.length ? Math.min(...chans) : null, max: chans.length ? Math.max(...chans) : null },
    duration_s: heads.reduce((n, h) => n + (h.sfreq ? h.n_samples / h.sfreq : 0), 0),
    size_bytes: heads.reduce((n, h) => n + (Number(h.size_bytes) || 0), 0),
    first_registered_at: regs.length ? regs[0] : null, last_registered_at: regs.length ? regs[regs.length - 1] : null,
  };
}

// ------------------------------------------------------------------ what has happened to each (person, recording)
/** Saved, set aside, in progress and opened, read once per request (datasets.py Progress). */
class Progress {
  constructor(lib) {
    const b = lib.b;
    this.b = b;
    this.saved = new Map(); // "AID|rid" -> versions
    for (const s of b.state.submissions) {
      if (s.mode !== 'standard') continue;
      const k = `${String(s.annotator_id).toUpperCase()}|${s.recording_id}`;
      this.saved.set(k, (this.saved.get(k) || 0) + 1);
    }
    this._opened = null;
  }

  key(aid, rid) { return this.b._key(aid, rid, 'standard', ''); }

  isSaved(aid, rid) { return this.saved.has(`${aid}|${rid}`); }

  isSetAside(aid, rid) { return this.b.feedback.isUnusable(this.key(aid, rid)); }

  inProgress(aid, rid) { return Boolean(this.b.state.drafts[this.key(aid, rid)]); }

  /** The first and last time the person opened the recording to annotate it (the visit index), or null. */
  openings() {
    if (!this._opened) {
      this._opened = new Map();
      for (const v of this.b.visits.values()) {
        const start = new Date(v.header.started_at).getTime();
        for (const r of indexRows(v.events, v.header.context_id)) {
          if (r.mode !== 'standard') continue;
          const k = `${v.header.annotator_id}|${r.recording_id}`;
          const at = nowLocalIso(new Date(start + Math.round((Number(r.opened_t) || 0) * 1000)));
          const o = this._opened.get(k);
          this._opened.set(k, o ? { first: o.first < at ? o.first : at, last: o.last > at ? o.last : at } : { first: at, last: at });
        }
      }
    }
    return this._opened;
  }

  opened(aid, rid) { return this.openings().has(`${aid}|${rid}`); }

  finished(aid, rid) { return this.isSaved(aid, rid) || this.isSetAside(aid, rid); }
}

/** How many different people have saved each study recording (study mode, a revision counted once). */
function ratingsOf(b) {
  const people = {};
  for (const s of b.state.submissions) {
    if (s.mode !== 'standard') continue;
    (people[s.recording_id] || (people[s.recording_id] = new Set())).add(String(s.annotator_id).toUpperCase());
  }
  return Object.fromEntries(Object.entries(people).map(([r, p]) => [r, p.size]));
}

// ------------------------------------------------------------------ the operations
export class DemoLibrary {
  /** @param admin the DemoAdmin whose state, accounts and audit log this works on */
  constructor(admin) {
    this.a = admin;
    this.b = admin.b;
  }

  get lib() {
    const s = this.a.s;
    if (!s.library || typeof s.library !== 'object') s.library = {};
    for (const k of KINDS) if (!s.library[k] || typeof s.library[k] !== 'object') s.library[k] = {};
    return s.library;
  }

  get user() { return this.b.annotatorId; }

  async run(op, body) {
    const fn = this[`op_${op}`] || this[`hook_${op}`];
    if (typeof fn !== 'function') throw notFound('not_found', `This server does not offer the administrative operation '${op}'`);
    return fn.call(this, body && typeof body === 'object' ? body : {});
  }

  _audit(op, summary, details) { this.a._audit(op, summary, details); }

  _records(kind, { removed = false } = {}) {
    return Object.keys(this.lib[kind]).sort(byText).map((k) => this.lib[kind][k]).filter((r) => removed || r.state !== 'removed');
  }

  _byRequest(kind, rid) { return Object.values(this.lib[kind]).find((r) => r.request_id === rid) || null; }

  // ------------------------------------------------------------- datasets
  /** The study's recordings as light rows (store.manifest_heads), sorted by ID; dataset_id is never ''. */
  heads() {
    return this.a.s.recordings.filter((r) => r.scope === 'study').map((r) => ({
      recording_id: r.recording_id, file_name: r.file_name, format: r.format, dataset_id: r.dataset_id || DEFAULT_DATASET_ID,
      retired: Boolean(r.retired), registered_at: r.registered_at, sfreq: Number(r.sfreq), n_samples: Number(r.n_samples),
      n_channels: Number(r.n_channels), size_bytes: Number(r.size_bytes) || 0,
    })).sort((x, y) => byText(x.recording_id, y.recording_id));
  }

  _headsById() { return new Map(this.heads().map((h) => [h.recording_id, h])); }

  static virtualDefault() {
    return { schema: 'electrotag.dataset', schema_version: 1, dataset_id: DEFAULT_DATASET_ID, name: DEFAULT_DATASET_NAME,
      description: DEFAULT_DATASET_DESCRIPTION, origin: '', licence: '', citation: '', contact: '', notes: '', path_prefix: '',
      ratings_target: RATINGS_TARGET, default: true, state: 'active', created_at: '', created_by: '', updated_at: '', changes: [] };
  }

  datasetRecord(did) {
    let rec = CHOSEN_ID_RE.test(did || '') ? this.lib.datasets[did] || null : null;
    if (rec && rec.state === 'removed') return null;
    if (!rec && did === DEFAULT_DATASET_ID) rec = DemoLibrary.virtualDefault();
    return rec;
  }

  allDatasets() {
    const recs = Object.fromEntries(this._records('datasets').filter((r) => r.dataset_id).map((r) => [r.dataset_id, r]));
    if (!recs[DEFAULT_DATASET_ID]) recs[DEFAULT_DATASET_ID] = DemoLibrary.virtualDefault();
    return Object.values(recs).sort((x, y) => (Boolean(x.default) === Boolean(y.default) ? byText(String(x.name || '').toLowerCase(), String(y.name || '').toLowerCase()) : x.default ? -1 : 1));
  }

  needDataset(did, { active = false } = {}) {
    if (typeof did !== 'string' || !did) throw bad('dataset_id is missing');
    const rec = this.datasetRecord(did);
    if (!rec) throw notFound('unknown_dataset', `This study has no dataset '${did}'`);
    if (active && rec.state === 'archived') throw conflict('archived', `The dataset ${rec.name} is archived: make it active again first`);
    return rec;
  }

  _datasetOut(rec, heads, rated) {
    const did = rec.dataset_id;
    const mine = heads.filter((h) => h.dataset_id === did);
    const live = mine.filter((h) => !h.retired).map((h) => h.recording_id);
    const target = Number(rec.ratings_target) || RATINGS_TARGET;
    const nRated = live.filter((r) => (rated[r] || 0) >= target).length;
    const out = { dataset_id: did };
    for (const k of [...Object.keys(DATASET_TEXT), 'path_prefix', 'created_at', 'created_by', 'updated_at']) out[k] = rec[k] ?? '';
    return { ...out, ratings_target: target, default: did === DEFAULT_DATASET_ID, state: rec.state || 'active', summary: summaryOf(mine),
      n_handouts: this._records('handouts').filter((h) => sameTarget(h.target, 'dataset', did) && h.state === 'open').length,
      ratings: ratingsHistogram(mine.map((h) => h.recording_id), rated), n_rated: nRated, fully_rated: live.length > 0 && nRated === live.length };
  }

  _rows(heads, rated) {
    const givenTo = {};
    for (const a of this.a.s.assignments) if (a.mode === 'standard') (givenTo[a.recording_id] || (givenTo[a.recording_id] = new Set())).add(a.annotator_id);
    return heads.map((h) => ({ recording_id: h.recording_id, file_name: h.file_name, format: h.format, duration_s: h.sfreq ? h.n_samples / h.sfreq : 0,
      n_channels: h.n_channels, dataset_id: h.dataset_id, retired: h.retired, registered_at: h.registered_at,
      n_given: (givenTo[h.recording_id] || new Set()).size, n_rated: rated[h.recording_id] || 0 }));
  }

  _outOne(rec) { return this._datasetOut(rec, this.heads(), ratingsOf(this.b)); }

  op_datasets_list(body) {
    const state = stateOf(body);
    const heads = this.heads();
    const rated = ratingsOf(this.b);
    return { datasets: this.allDatasets().filter((r) => state === null || (r.state || 'active') === state).map((r) => this._datasetOut(r, heads, rated)),
      default_id: DEFAULT_DATASET_ID };
  }

  op_dataset_get(body) {
    const rec = this.needDataset(body.dataset_id);
    const heads = this.heads();
    const rated = ratingsOf(this.b);
    return { dataset: this._datasetOut(rec, heads, rated), recordings: this._rows(heads.filter((h) => h.dataset_id === rec.dataset_id), rated) };
  }

  _datasetFields(body, creating) {
    const out = {};
    for (const [k, limit] of Object.entries(DATASET_TEXT)) {
      if (creating || given(body, k)) out[k] = text(body, k, { required: creating && k === 'name', limit });
    }
    if (creating || given(body, 'path_prefix')) {
      const problem = prefixProblem(body.path_prefix || '');
      if (problem) throw bad(problem);
      out.path_prefix = String(body.path_prefix || '').trim().replace(/^\/+|\/+$/g, '');
    }
    const target = ratingsTarget(body, creating ? RATINGS_TARGET : null);
    if (target !== null) out.ratings_target = target;
    if (has(out, 'name') && !out.name) throw bad('name is missing');
    return out;
  }

  op_dataset_create(body) {
    const rq = requestId(body);
    const done = this._byRequest('datasets', rq);
    if (done) return { dataset: this._outOne(done), already: true };
    const fields = this._datasetFields(body, true);
    let did = has(body, 'dataset_id') ? body.dataset_id : null;
    if (did === null || did === undefined) {
      const base = fields.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'dataset';
      did = !this.datasetRecord(base) && !this.lib.datasets[base] ? base : `${base}-${hex(6, rq)}`;
    }
    if (typeof did !== 'string' || !CHOSEN_ID_RE.test(did)) throw bad("dataset_id must be 1 to 64 letters, digits, '-' or '_', starting with a letter or digit");
    if (did === DEFAULT_DATASET_ID || this.lib.datasets[did]) throw conflict('dataset_exists', `This study has a dataset with the ID ${did} already; choose another ID`);
    const now = nowLocalIso();
    const record = { schema: 'electrotag.dataset', schema_version: 1, dataset_id: did, ...fields, default: false, state: 'active', created_at: now,
      created_by: this.user, request_id: rq, updated_at: now, changes: [] };
    this.lib.datasets[did] = record;
    this._audit('dataset_create', `Made the dataset ${fields.name} (${did})`, { dataset_id: did, name: fields.name, path_prefix: fields.path_prefix, ratings_target: fields.ratings_target });
    return { dataset: this._outOne(record), already: false };
  }

  op_dataset_update(body) {
    const rec = this.needDataset(body.dataset_id);
    const did = rec.dataset_id;
    const fields = this._datasetFields(body, false);
    const state = stateOf(body);
    if (state !== null) {
      if (did === DEFAULT_DATASET_ID && state !== 'active') throw conflict('default_dataset', "The study's built-in dataset stays active: recordings registered without a dataset go into it");
      fields.state = state;
    }
    const changed = sortedText(Object.keys(fields).filter((k) => (has(rec, k) ? rec[k] : k === 'state' ? 'active' : '') !== fields[k]));
    if (changed.includes('path_prefix') && did === DEFAULT_DATASET_ID) throw conflict('default_dataset', 'The built-in dataset has no prefix: make a new dataset with one');
    if (changed.includes('path_prefix') && this.heads().some((h) => h.dataset_id === did)) {
      throw conflict('has_recordings', 'Recordings are registered in this dataset under its prefix, so the prefix stays as it is');
    }
    if (!changed.length) return { dataset: this._outOne(rec), changed: [] };
    const now = nowLocalIso();
    const base = this.lib.datasets[did] || { ...DemoLibrary.virtualDefault(), created_at: now, created_by: this.user };
    const kept = { ...base, ...Object.fromEntries(changed.map((k) => [k, fields[k]])), updated_at: now,
      changes: changesWith(base, { at: now, by: this.user, fields: changed }) };
    this.lib.datasets[did] = kept;
    this._audit('dataset_update', `Changed the dataset ${kept.name ?? did}: ${changed.join(', ')}`, { dataset_id: did, fields: changed, state: fields.state ?? null });
    return { dataset: this._outOne(kept), changed };
  }

  op_dataset_remove(body) {
    const rec = this.needDataset(body.dataset_id);
    const did = rec.dataset_id;
    if (did === DEFAULT_DATASET_ID) throw conflict('default_dataset', "The study's built-in dataset cannot be removed");
    const n = this.heads().filter((h) => h.dataset_id === did).length;
    if (n) throw conflict('not_empty', `The dataset ${rec.name} holds ${count(n, 'recording')}: move them to another dataset first, or archive the dataset`);
    if (this._records('handouts').some((h) => h.state === 'open' && sameTarget(h.target, 'dataset', did))) {
      throw conflict('in_use', `The dataset ${rec.name} has an open hand-out: withdraw it first`);
    }
    const now = nowLocalIso();
    this.lib.datasets[did] = { ...(this.lib.datasets[did] || rec), state: 'removed', updated_at: now, removed_at: now, removed_by: this.user };
    this._audit('dataset_remove', `Removed the dataset ${rec.name} (${did})`, { dataset_id: did });
    return {};
  }

  op_recordings_move(body) {
    const rids = body.recording_ids;
    if (!Array.isArray(rids) || !rids.length || rids.length > 5000 || !rids.every((r) => typeof r === 'string')) throw bad("recording_ids must be a list of the study's recording IDs");
    const rec = this.needDataset(body.dataset_id, { active: true });
    const did = rec.dataset_id;
    const wanted = [...new Set(rids)];
    const unknown = wanted.filter((r) => !this.a.record('study', r));
    if (unknown.length) throw notFound('unknown_recording', `Not registered in the study: ${unknown.slice(0, 10).join(', ')}`);
    const moved = [];
    const already = [];
    const froms = new Set();
    for (const r of wanted) {
      const record = this.a.record('study', r);
      const here = record.dataset_id || DEFAULT_DATASET_ID;
      if (here === did) { already.push(r); continue; }
      if (did === DEFAULT_DATASET_ID) delete record.dataset_id; else record.dataset_id = did;
      moved.push(r);
      froms.add(here);
    }
    if (moved.length) this._audit('recordings_move', `Moved ${count(moved.length, 'recording')} to the dataset ${rec.name}`, { dataset_id: did, recording_ids: moved, from_datasets: sortedText(froms) });
    return { moved, already };
  }

  // ------------------------------------------------- what datasets change of demo_admin.js's own operations
  // demo_admin.js sends these here once the sandbox has any of the library, or when a dataset is named.

  /** overview: counts gain the people with an overdue hand-out and the open hand-outs. */
  async hook_overview(body) {
    const out = await this.a.op_overview(body);
    Object.assign(out.counts, this.overviewCounts());
    return out;
  }

  /** recordings_list with "dataset_id": one dataset's recordings. */
  async hook_recordings_list(body) {
    const { dataset_id: did, ...rest } = body;
    const want = did === null || did === undefined ? null : this.needDataset(did).dataset_id;
    const out = await this.a.op_recordings_list(rest);
    if (want !== null) out.recordings = out.recordings.filter((r) => r.scope === 'study' && r.dataset_id === want);
    return out;
  }

  /**
   * recordings_register into a dataset: its path_prefix is put in front of the IDs first, and an ID that
   * belongs to another dataset's recording is skipped, even when replacing (admin.py, datasets.py collision).
   */
  async hook_recordings_register(body) {
    const scope = this.a._scopeOk(body.scope || 'study');
    if (!Array.isArray(body.manifests) || !body.manifests.length) throw bad('There are no recordings to add.');
    const named = ![undefined, null, ''].includes(body.dataset_id);
    if (named && scope !== 'study') throw bad("Only the study's own recordings (scope 'study') go into datasets");
    const [did, prefix] = scope === 'study' ? this.registrationTarget(body.dataset_id) : [DEFAULT_DATASET_ID, ''];
    const kept = [];
    const skipped = [];
    for (const raw of body.manifests) {
      const m = prefix ? prefixManifest(raw, prefix) : raw;
      const why = scope === 'study' && m && typeof m.recording_id === 'string' ? DemoLibrary.collision(this.a.record('study', m.recording_id), did) : '';
      if (why) skipped.push({ recording_id: m.recording_id, reason: why }); else kept.push(m);
    }
    const out = kept.length ? await this.a.op_recordings_register({ ...body, manifests: kept }) : { added: [], replaced: [], skipped: [] };
    if (scope === 'study' && did !== DEFAULT_DATASET_ID) for (const rid of out.added) this.a.record('study', rid).dataset_id = did;
    return { ...out, skipped: [...skipped, ...out.skipped] };
  }

  /** recording_remove: the recording also leaves every collection. */
  async hook_recording_remove(body) {
    const out = await this.a.op_recording_remove(body);
    if ((body.scope || 'study') === 'study') this.removeFromCollections(body.recording_id);
    return out;
  }

  /** user_remove: the person's membership of groups ends. */
  async hook_user_remove(body) {
    const out = await this.a.op_user_remove(body);
    this.accountRemoved(String(body.annotator_id || '').trim().toUpperCase());
    return out;
  }

  // ------------------------------------------------- registration and removal
  /** The dataset a registration goes into: [dataset_id, path_prefix] (404 unknown_dataset, 409 archived). */
  registrationTarget(did) {
    if (did === null || did === undefined || did === '') return [DEFAULT_DATASET_ID, ''];
    const rec = this.needDataset(did, { active: true });
    return [rec.dataset_id, String(rec.path_prefix || '')];
  }

  /** Why a recording cannot be registered into dataset `did` under its ID ('' when it can). */
  static collision(old, did) {
    if (!old) return '';
    const here = old.dataset_id || DEFAULT_DATASET_ID;
    if (here === did) return '';
    return `Registered already in the dataset ${here} under this ID, so it is left as it is (even when replacing). `
      + 'Register it into a new dataset with a path prefix, which keeps the two apart.';
  }

  /** Take a removed recording out of every collection; the collections' IDs. */
  removeFromCollections(rid) {
    const out = [];
    const now = nowLocalIso();
    for (const c of this._records('collections')) {
      if (!(c.recording_ids || []).includes(rid)) continue;
      this.lib.collections[c.collection_id] = { ...c, recording_ids: c.recording_ids.filter((r) => r !== rid), updated_at: now,
        changes: changesWith(c, { at: now, by: this.user, added: 0, removed: 1, reordered: false, why: 'recording_removed' }) };
      out.push(c.collection_id);
    }
    return out;
  }

  /** Close the open group rows of a person whose account was removed; the groups' IDs. */
  accountRemoved(aid) {
    const out = [];
    const now = nowLocalIso();
    for (const g of this._records('groups')) {
      if (!DemoLibrary.members(g).includes(aid)) continue;
      g.history = g.history.map((r) => (r.annotator_id === aid && !r.removed_at ? { ...r, removed_at: now, removed_by: 'account removed' } : r));
      g.updated_at = now;
      out.push(g.group_id);
    }
    return out;
  }

  // ------------------------------------------------------------- collections
  needCollection(cid) {
    if (typeof cid !== 'string' || !cid) throw bad('collection_id is missing');
    const rec = CHOSEN_ID_RE.test(cid) ? this.lib.collections[cid] || null : null;
    if (!rec || rec.state === 'removed') throw notFound('unknown_collection', `This study has no collection '${cid}'`);
    return rec;
  }

  _collectionOut(rec, heads, rated, { withIds = false } = {}) {
    const rids = [...(rec.recording_ids || [])];
    const present = rids.filter((r) => heads.has(r)).map((r) => heads.get(r));
    const live = present.filter((h) => !h.retired).map((h) => h.recording_id);
    const target = Number(rec.ratings_target) || RATINGS_TARGET;
    const datasets = {};
    for (const h of present) datasets[h.dataset_id] = (datasets[h.dataset_id] || 0) + 1;
    const nRated = live.filter((r) => (rated[r] || 0) >= target).length;
    const out = { collection_id: rec.collection_id, name: rec.name || '', description: rec.description || '', ratings_target: target,
      n_recordings: rids.length, n_missing: rids.length - present.length, n_retired: present.length - live.length, datasets,
      built_from: rec.built_from ?? null, state: rec.state || 'active', created_at: rec.created_at || '', created_by: rec.created_by || '',
      updated_at: rec.updated_at || '', changes: deepCopy(rec.changes || []), ratings: ratingsHistogram(rids, rated), n_rated: nRated,
      fully_rated: live.length > 0 && nRated === live.length };
    if (withIds) out.recording_ids = rids;
    return out;
  }

  op_collections_list() {
    const heads = this._headsById();
    const rated = ratingsOf(this.b);
    const recs = this._records('collections').sort((x, y) => byText(String(x.name || '').toLowerCase(), String(y.name || '').toLowerCase()));
    return { collections: recs.map((r) => this._collectionOut(r, heads, rated)) };
  }

  op_collection_get(body) {
    const rec = this.needCollection(body.collection_id);
    const heads = this._headsById();
    const rated = ratingsOf(this.b);
    return { collection: this._collectionOut(rec, heads, rated, { withIds: true }),
      recordings: this._rows((rec.recording_ids || []).filter((r) => heads.has(r)).map((r) => heads.get(r)), rated) };
  }

  static ridList(value, what) {
    if (!Array.isArray(value) || !value.every((r) => typeof r === 'string' && r.length > 0 && r.length <= 512)) throw bad(`${what} must be a list of recording IDs`);
    if (value.length > MAX_COLLECTION) throw new ApiError(413, 'too_large', `A collection holds at most ${MAX_COLLECTION.toLocaleString('en-GB')} recordings`);
    return [...value];
  }

  static builtFrom(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 4000) {
      throw bad('built_from must be an object describing the filters (at most 4,000 characters)');
    }
    return deepCopy(value);
  }

  op_collection_create(body) {
    const rq = requestId(body);
    const done = this._byRequest('collections', rq);
    const heads = this._headsById();
    const rated = ratingsOf(this.b);
    if (done) return { collection: this._collectionOut(done, heads, rated, { withIds: true }), skipped: [], already: true };
    const name = text(body, 'name', { required: true, limit: 120 });
    const description = text(body, 'description', { limit: 5000 });
    const target = ratingsTarget(body);
    const wanted = DemoLibrary.ridList(body.recording_ids, 'recording_ids');
    let cid = has(body, 'collection_id') ? body.collection_id : null;
    if (cid === null || cid === undefined) cid = `c-${hex(10, rq)}`;
    if (typeof cid !== 'string' || !CHOSEN_ID_RE.test(cid)) throw bad("collection_id must be 1 to 64 letters, digits, '-' or '_'");
    if (this.lib.collections[cid]) throw conflict('collection_exists', `This study has a collection with the ID ${cid} already`);
    const kept = [];
    const skipped = [];
    const seen = new Set();
    for (const r of wanted) {
      if (seen.has(r)) skipped.push({ recording_id: r, reason: 'twice' });
      else if (!heads.has(r)) skipped.push({ recording_id: r, reason: 'not_registered' });
      else kept.push(r);
      seen.add(r);
    }
    const now = nowLocalIso();
    const record = { schema: 'electrotag.collection', schema_version: 1, collection_id: cid, name, description, ratings_target: target,
      recording_ids: kept, built_from: DemoLibrary.builtFrom(body.built_from), state: 'active', created_at: now, created_by: this.user,
      request_id: rq, updated_at: now, changes: [] };
    this.lib.collections[cid] = record;
    this._audit('collection_create', `Made the collection ${name} of ${count(kept.length, 'recording')}`, { collection_id: cid, n_recordings: kept.length,
      skipped: skipped.map((s) => s.recording_id) });
    return { collection: this._collectionOut(record, heads, rated, { withIds: true }), skipped, already: false };
  }

  op_collection_update(body) {
    const rec = this.needCollection(body.collection_id);
    const heads = this._headsById();
    const fresh = {};
    for (const [k, limit] of [['name', 120], ['description', 5000]]) if (given(body, k)) fresh[k] = text(body, k, { required: k === 'name', limit });
    const target = ratingsTarget(body, null);
    if (target !== null) fresh.ratings_target = target;
    const state = stateOf(body);
    if (state !== null) fresh.state = state;
    let list = [...(rec.recording_ids || [])];
    let added = 0;
    let removed = 0;
    let reordered = false;
    if (given(body, 'remove')) {
      const drop = new Set(DemoLibrary.ridList(body.remove, 'remove'));
      removed = list.filter((r) => drop.has(r)).length;
      list = list.filter((r) => !drop.has(r));
    }
    if (given(body, 'add')) {
      const add = DemoLibrary.ridList(body.add, 'add');
      const unknown = add.filter((r) => !heads.has(r));
      if (unknown.length) throw notFound('unknown_recording', `Not registered in the study: ${unknown.slice(0, 10).join(', ')}`);
      for (const r of add) if (!list.includes(r)) { list.push(r); added += 1; }
    }
    if (given(body, 'order')) {
      const order = DemoLibrary.ridList(body.order, 'order');
      if (sortedText(order).join('\n') !== sortedText(list).join('\n') || new Set(order).size !== order.length) {
        throw bad("order must hold the collection's recordings, each once, in their new order");
      }
      reordered = order.join('\n') !== list.join('\n');
      list = order;
    }
    if (list.length > MAX_COLLECTION) throw new ApiError(413, 'too_large', `A collection holds at most ${MAX_COLLECTION.toLocaleString('en-GB')} recordings`);
    const changed = sortedText(Object.keys(fresh).filter((k) => rec[k] !== fresh[k]));
    if (added || removed || reordered) changed.push('recordings');
    const rated = ratingsOf(this.b);
    if (!changed.length) return { collection: this._collectionOut(rec, heads, rated, { withIds: true }), changed: [] };
    const now = nowLocalIso();
    const kept = { ...rec, ...fresh, recording_ids: list, updated_at: now,
      changes: changesWith(rec, { at: now, by: this.user, added, removed, reordered, fields: changed.filter((c) => c !== 'recordings') }) };
    this.lib.collections[rec.collection_id] = kept;
    this._audit('collection_update', `Changed the collection ${kept.name}: ${changed.join(', ')}`, { collection_id: rec.collection_id, fields: changed, added, removed, reordered });
    return { collection: this._collectionOut(kept, heads, rated, { withIds: true }), changed };
  }

  op_collection_remove(body) {
    const rec = this.needCollection(body.collection_id);
    const cid = rec.collection_id;
    if (this._records('handouts').some((h) => h.state === 'open' && sameTarget(h.target, 'collection', cid))) {
      throw conflict('in_use', `The collection ${rec.name} has an open hand-out: withdraw it first`);
    }
    const now = nowLocalIso();
    this.lib.collections[cid] = { ...rec, state: 'removed', updated_at: now, removed_at: now, removed_by: this.user };
    this._audit('collection_remove', `Removed the collection ${rec.name}`, { collection_id: cid });
    return {};
  }

  // ------------------------------------------------------------- groups
  static members(g) { return [...new Set((g.history || []).filter((r) => !r.removed_at).map((r) => r.annotator_id))]; }

  needGroup(gid) {
    if (typeof gid !== 'string' || !gid) throw bad('group_id is missing');
    const rec = CHOSEN_ID_RE.test(gid) ? this.lib.groups[gid] || null : null;
    if (!rec || rec.state === 'removed') throw notFound('unknown_group', `This study has no group '${gid}'`);
    return rec;
  }

  static groupOut(rec) {
    return { group_id: rec.group_id, name: rec.name || '', description: rec.description || '', state: rec.state || 'active',
      members: DemoLibrary.members(rec), history: deepCopy(rec.history || []), created_at: rec.created_at || '', created_by: rec.created_by || '' };
  }

  _people(value, what) {
    const out = ids(value, what);
    for (const aid of out) if (!this.a.user(aid)) throw notFound('unknown_user', `${aid} has no account in this study`);
    return out;
  }

  op_groups_list() {
    return { groups: this._records('groups').sort((x, y) => byText(String(x.name || '').toLowerCase(), String(y.name || '').toLowerCase())).map(DemoLibrary.groupOut) };
  }

  op_group_create(body) {
    const rq = requestId(body);
    const done = this._byRequest('groups', rq);
    if (done) return { group: DemoLibrary.groupOut(done), already: true };
    const name = text(body, 'name', { required: true, limit: 120 });
    const description = text(body, 'description', { limit: 2000 });
    const members = this._people(has(body, 'members') ? body.members : [], 'members');
    if (members.length > MAX_GROUP_MEMBERS) throw new ApiError(413, 'too_large', `A group holds at most ${MAX_GROUP_MEMBERS} people`);
    let gid = has(body, 'group_id') ? body.group_id : null;
    if (gid === null || gid === undefined) gid = `g-${hex(10, rq)}`;
    if (typeof gid !== 'string' || !CHOSEN_ID_RE.test(gid)) throw bad("group_id must be 1 to 64 letters, digits, '-' or '_'");
    if (this.lib.groups[gid]) throw conflict('group_exists', `This study has a group with the ID ${gid} already`);
    const now = nowLocalIso();
    const record = { schema: 'electrotag.group', schema_version: 1, group_id: gid, name, description, state: 'active',
      history: members.map((a) => ({ annotator_id: a, added_at: now, added_by: this.user, removed_at: null, removed_by: null })),
      created_at: now, created_by: this.user, request_id: rq, updated_at: now };
    this.lib.groups[gid] = record;
    this._audit('group_create', `Made the group ${name}${members.length ? ` of ${members.slice(0, 10).join(', ')}` : ''}`, { group_id: gid, members });
    return { group: DemoLibrary.groupOut(record), already: false };
  }

  op_group_update(body) {
    const rec = this.needGroup(body.group_id);
    const gid = rec.group_id;
    const fresh = {};
    for (const [k, limit] of [['name', 120], ['description', 2000]]) if (given(body, k)) fresh[k] = text(body, k, { required: k === 'name', limit });
    const state = stateOf(body);
    if (state !== null) fresh.state = state;
    const give = flag(body, 'give_existing') ?? true;
    const current = DemoLibrary.members(rec);
    const add = this._people(has(body, 'add') ? body.add : [], 'add').filter((a) => !current.includes(a));
    const drop = this._people(has(body, 'remove') ? body.remove : [], 'remove').filter((a) => current.includes(a));
    if (current.length + add.length - drop.length > MAX_GROUP_MEMBERS) throw new ApiError(413, 'too_large', `A group holds at most ${MAX_GROUP_MEMBERS} people`);
    if ((rec.history || []).length + add.length > MAX_GROUP_HISTORY) throw new ApiError(413, 'too_large', `A group keeps at most ${MAX_GROUP_HISTORY} rows of history; make a new group`);
    const changed = sortedText(Object.keys(fresh).filter((k) => (has(rec, k) ? rec[k] : k === 'state' ? 'active' : '') !== fresh[k]));
    if (add.length) changed.push('added');
    if (drop.length) changed.push('removed');
    if (!changed.length) return { group: DemoLibrary.groupOut(rec), changed: [], given: [] };
    const now = nowLocalIso();
    const history = (rec.history || []).map((r) => (drop.includes(r.annotator_id) && !r.removed_at ? { ...r, removed_at: now, removed_by: this.user } : { ...r }));
    for (const a of add) history.push({ annotator_id: a, added_at: now, added_by: this.user, removed_at: null, removed_by: null });
    const kept = { ...rec, ...fresh, history, updated_at: now };
    this.lib.groups[gid] = kept;
    const out = add.length && give && (kept.state || 'active') === 'active' ? this._follow(gid, add) : [];
    const nGiven = out.reduce((n, g) => n + g.added, 0);
    this._audit('group_update', `Changed the group ${kept.name}${add.length ? `: added ${add.slice(0, 10).join(', ')}` : ''}`
      + `${drop.length ? `; took out ${drop.slice(0, 10).join(', ')}` : ''}`
      + `${out.length ? `; gave ${count(nGiven, 'recording')} of ${count(new Set(out.map((g) => g.handout_id)).size, 'hand-out')}` : ''}`,
    { group_id: gid, fields: changed, added: add, removed: drop, given: out.map((g) => ({ handout_id: g.handout_id, annotator_id: g.annotator_id, added: g.added })) });
    return { group: DemoLibrary.groupOut(kept), changed, given: out };
  }

  op_group_remove(body) {
    const rec = this.needGroup(body.group_id);
    const gid = rec.group_id;
    if (this._records('handouts').some((h) => h.state === 'open' && (h.groups || []).includes(gid))) {
      throw conflict('in_use', `An open hand-out names the group ${rec.name}: withdraw it first`);
    }
    const now = nowLocalIso();
    this.lib.groups[gid] = { ...rec, state: 'removed', updated_at: now, removed_at: now, removed_by: this.user };
    this._audit('group_remove', `Removed the group ${rec.name}`, { group_id: gid });
    return {};
  }

  // ------------------------------------------------------------- hand-outs
  needHandout(hid) {
    if (typeof hid !== 'string' || !HANDOUT_RE.test(hid)) throw notFound('unknown_handout', 'This study has no such hand-out');
    const rec = this.lib.handouts[hid];
    if (!rec) throw notFound('unknown_handout', `This study has no hand-out ${hid}`);
    return rec;
  }

  /** {kind, id, name, rids: every recording of it, in order}. */
  targetOf(target, { active = true } = {}) {
    if (!target || typeof target !== 'object' || !TARGET_KINDS.includes(target.kind)) throw bad('target must be {"kind": "dataset" or "collection", "id"}');
    if (target.kind === 'dataset') {
      const rec = this.needDataset(target.id, { active });
      return { kind: 'dataset', id: rec.dataset_id, name: rec.name || '', rids: this.heads().filter((h) => h.dataset_id === rec.dataset_id).map((h) => h.recording_id) };
    }
    const rec = this.needCollection(target.id);
    if (active && rec.state === 'archived') throw conflict('archived', `The collection ${rec.name} is archived: make it active again first`);
    return { kind: 'collection', id: rec.collection_id, name: rec.name || '', rids: [...(rec.recording_ids || [])] };
  }

  _targetOrEmpty(record) {
    try { return this.targetOf(record.target, { active: false }); } catch (exc) {
      if (exc instanceof ApiError) return { ...record.target, name: '', rids: [] };
      throw exc;
    }
  }

  /** The recordings of a target that can be handed out now, and the others with the reason. */
  _live(rids) {
    const heads = this._headsById();
    const live = [];
    const skipped = [];
    for (const r of rids) {
      if (!heads.has(r)) skipped.push({ recording_id: r, reason: 'not_registered' });
      else if (heads.get(r).retired) skipped.push({ recording_id: r, reason: 'retired' });
      else live.push(r);
    }
    return [live, skipped];
  }

  _recipients(people, groups) {
    const out = new Map();
    for (const aid of people) {
      const u = this.a.user(aid);
      if (u && (u.status || 'active') !== 'active') throw conflict('disabled', `${aid}'s account is switched off; switch it on, or leave ${aid} out`);
      out.set(aid, 'person');
    }
    const off = [];
    for (const gid of groups) {
      const g = this.needGroup(gid);
      if (g.state === 'archived') throw conflict('archived', `The group ${g.name} is archived`);
      for (const aid of DemoLibrary.members(g)) {
        const u = this.a.user(aid);
        if (!u) continue;
        if ((u.status || 'active') !== 'active') { off.push(aid); continue; }
        if (!out.has(aid)) out.set(aid, `group:${gid}`);
      }
    }
    const offs = sortedText(new Set(off));
    const warnings = offs.length ? [`${offs.slice(0, 10).join(', ')} ${offs.length === 1 ? 'is' : 'are'} in a chosen group but switched off, so left out.`] : [];
    return [[...out.entries()], warnings];
  }

  /** A checked HandoutRequest (datasets.py _request). */
  _request(body) {
    const target = this.targetOf(body.target);
    const people = this._people(has(body, 'people') ? body.people : [], 'people');
    const groups = has(body, 'groups') ? body.groups : [];
    if (!Array.isArray(groups) || !groups.every((g) => typeof g === 'string') || new Set(groups).size !== groups.length) throw bad('groups must be a list of group IDs, each once');
    const mode = has(body, 'mode') ? body.mode : 'all';
    if (!['all', 'k'].includes(mode)) throw bad("mode must be 'all' (everyone gets all of it) or 'k' (each recording to k people)");
    const due = dueOf(body.due_at);
    const [recipients, warnings] = this._recipients(people, groups);
    if (!recipients.length) throw bad('Choose the people or groups to give it to');
    if (mode === 'k') throw needsServer(K_SERVER);
    const follow = flag(body, 'follow_groups') || false;
    const name = text(body, 'name', { limit: 120 }) || target.name;
    const title = text(body, 'title', { limit: 120 }) || defaultTitle(target.kind, target.name, due);
    return { target, people, groups: [...groups], mode, k: null, due_at: due, recipients, warnings, follow_groups: follow, name, title,
      note: text(body, 'note', { limit: 2000 }) };
  }

  /** aid -> rid -> the assignment (study mode). */
  _held() {
    const out = {};
    for (const a of this.a.s.assignments) if (a.mode === 'standard') (out[a.annotator_id] || (out[a.annotator_id] = {}))[a.recording_id] = a;
    return out;
  }

  /** Give one person the recordings of an "all" hand-out (store.assign_many): [how many were added, the IDs linked]. */
  _giveAll(hid, aid, rids, held) {
    const mine = held[aid] || {};
    const linked = rids.filter((r) => mine[r] && !mine[r].handout_id);
    let added = 0;
    const now = nowLocalIso();
    for (const r of rids) {
      const a = mine[r];
      if (a) { if (!a.handout_id) a.handout_id = hid; continue; }
      const fresh = { annotator_id: aid, recording_id: r, mode: 'standard', context_id: '', at: now, handout_id: hid };
      this.a.s.assignments.push(fresh);
      mine[r] = fresh;
      added += 1;
    }
    held[aid] = mine;
    return [added, linked];
  }

  static noteLinked(record, aid, linked) {
    if (!linked.length || record.linked_overflow) return;
    const mine = record.linked || (record.linked = {});
    mine[aid] = sortedText(new Set([...(mine[aid] || []), ...linked]));
    if (Object.values(mine).reduce((n, v) => n + v.length, 0) > MAX_LINKED) { record.linked = {}; record.linked_overflow = true; }
  }

  _standing(aid) {
    const u = this.a.user(aid);
    return { annotates: Boolean(u && rolesOf(u).includes('annotator')), study_locked: !this.b._gate().open };
  }

  static tasksWarnings(per) {
    const names = (list) => list.slice(0, 10).join(', ') + (list.length > 10 ? ` and ${list.length - 10} more` : '');
    const out = [];
    const locked = per.filter((r) => r.study_locked && r.new).map((r) => r.annotator_id);
    if (locked.length) {
      out.push(`${names(locked)} ${locked.length === 1 ? 'is a trainee' : 'are trainees'} whose study work is locked until the competency assessment is passed, `
        + 'so their tasks wait in Collecting until then.');
    }
    const others = per.filter((r) => !r.annotates && r.new).map((r) => r.annotator_id);
    if (others.length) {
      out.push(`${names(others)} ${others.length === 1 ? 'has' : 'have'} no annotator role. Nobody adjudicates a task they annotated, so an expert given tasks here cannot adjudicate them.`);
    }
    return out;
  }

  op_handouts_preview_get(body) {
    const req = this._request(body);
    const [live, skipped] = this._live(req.target.rids);
    const held = this._held();
    const recipients = req.recipients.map(([a, via]) => {
      const mine = held[a] || {};
      const n = live.filter((r) => mine[r]).length;
      return { annotator_id: a, via, new: live.length - n, already: n, ...this._standing(a) };
    });
    return { recipients, recordings: live.length, skipped, tasks_preview: null, warnings: [...req.warnings, ...DemoLibrary.tasksWarnings(recipients)] };
  }

  op_handout_create(body) {
    const rq = requestId(body);
    const hid = `h-${hex(10, rq)}`;
    const done = this.lib.handouts[hid];
    if (done && done.request_id === rq) return this._again(done);
    const req = this._request(body);
    const [live, skipped] = this._live(req.target.rids);
    const now = nowLocalIso();
    const record = { schema: 'electrotag.handout', schema_version: 1, handout_id: hid, name: req.name, title: req.title,
      target: { kind: req.target.kind, id: req.target.id }, mode: req.mode, k: req.k, people: req.people, groups: req.groups,
      follow_groups: req.follow_groups, due_at: req.due_at, note: req.note, state: 'open', handed_out_at: now, handed_out_by: this.user,
      request_id: rq, task_request_id: null,
      recipients: req.recipients.map(([a, via]) => ({ annotator_id: a, via, given_at: now, given_by: this.user, added: 0, already: 0 })),
      changes: [], linked: {}, linked_overflow: false };
    const held = this._held();
    let added = 0;
    let already = 0;
    for (const row of record.recipients) {
      const [n, linked] = this._giveAll(hid, row.annotator_id, live, held);
      row.added = n;
      row.already = live.length - n;
      DemoLibrary.noteLinked(record, row.annotator_id, linked);
      added += n;
      already += live.length - n;
    }
    this.lib.handouts[hid] = record;
    const people = req.recipients.map(([a]) => a);
    this._audit('handout_create', `Handed out ${req.target.kind} ${req.target.name} (to everyone) to ${people.slice(0, 6).join(', ')}${people.length > 6 ? ' …' : ''}: `
      + `${count(added, 'new assignment')}`, { handout_id: hid, target: record.target, mode: req.mode, k: req.k, annotator_ids: people, groups: req.groups,
      due_at: req.due_at, added, already, skipped: skipped.map((s) => s.recording_id), note_chars: req.note.length });
    return { handout: this.handoutOut(record), added, already_had: already, skipped, tasks: null, already: false };
  }

  _again(record) {
    if (record.state === 'open') {
      const [live] = this._live(this.targetOf(record.target, { active: false }).rids);
      const held = this._held();
      for (const row of record.recipients || []) this._giveAll(record.handout_id, row.annotator_id, live, held);
    }
    return { handout: this.handoutOut(record), added: 0, already_had: 0, skipped: [], tasks: null, already: true };
  }

  /** The (person, recording) pairs an "all" hand-out covers, by person: its recipients' assignments of the target. */
  covered(record, held = this._held(), targetRids = null) {
    const hid = record.handout_id;
    const rids = new Set(targetRids || this._targetOrEmpty(record).rids);
    const out = {};
    for (const row of record.recipients || []) {
      const mine = held[row.annotator_id] || {};
      out[row.annotator_id] = sortedText(new Set(Object.keys(mine).filter((r) => rids.has(r) || mine[r].handout_id === hid)));
    }
    return out;
  }

  newRecordings(record, cov, targetRids = null) {
    const [live] = this._live(targetRids || this._targetOrEmpty(record).rids);
    const people = (record.recipients || []).map((r) => r.annotator_id);
    const have = Object.fromEntries(people.map((a) => [a, new Set(cov[a] || [])]));
    return live.filter((r) => people.some((a) => !have[a].has(r)));
  }

  /** HandoutOut (docs/web/api.md). */
  handoutOut(record, p = new Progress(this), held = this._held()) {
    const target = this._targetOrEmpty(record);
    const cov = this.covered(record, held, target.rids);
    const due = record.due_at || null;
    const late = Boolean(due) && record.state === 'open' && today() > due;
    const counts = { people: (record.recipients || []).length, recordings: new Set(Object.values(cov).flat()).size, given: 0, opened: 0,
      in_progress: 0, saved: 0, set_aside: 0, overdue_people: 0 };
    const per = [];
    for (const row of record.recipients || []) {
      const aid = row.annotator_id;
      const mine = cov[aid] || [];
      const saved = mine.filter((r) => p.isSaved(aid, r)).length;
      const aside = mine.filter((r) => !p.isSaved(aid, r) && p.isSetAside(aid, r)).length;
      const remaining = mine.length - saved - aside;
      counts.given += mine.length;
      counts.saved += saved;
      counts.set_aside += aside;
      counts.in_progress += mine.filter((r) => !p.finished(aid, r) && p.inProgress(aid, r)).length;
      counts.opened += mine.filter((r) => p.opened(aid, r)).length;
      const overdue = late && remaining > 0;
      counts.overdue_people += overdue ? 1 : 0;
      per.push({ annotator_id: aid, given: mine.length, saved, set_aside: aside, remaining, overdue });
    }
    return { handout_id: record.handout_id, name: record.name || '', title: record.title || '',
      target: { kind: target.kind, id: target.id, name: target.name || '' }, mode: record.mode || 'all', k: record.k ?? null,
      people: [...(record.people || [])], groups: [...(record.groups || [])], follow_groups: Boolean(record.follow_groups), due_at: due,
      note: record.note || '', state: record.state || 'open', handed_out_at: record.handed_out_at || '', handed_out_by: record.handed_out_by || '',
      recipients: deepCopy(record.recipients || []), n_tasks: null,
      new_recordings: record.state === 'open' ? this.newRecordings(record, cov, target.rids).length : 0, counts, per_person: per,
      complete: counts.given > 0 && per.every((x) => x.remaining === 0) };
  }

  op_handouts_list(body) {
    const state = body.state ?? null;
    if (state !== null && !['open', 'withdrawn'].includes(state)) throw bad("state must be 'open' or 'withdrawn'");
    const target = body.target ?? null;
    if (target !== null && (typeof target !== 'object' || !TARGET_KINDS.includes(target.kind))) throw bad('target must be {"kind": "dataset" or "collection", "id"}');
    const aid = given(body, 'annotator_id') ? aidOf(body.annotator_id) : null;
    const overdue = flag(body, 'overdue');
    const p = new Progress(this);
    const held = this._held();
    const out = [];
    const recs = Object.values(this.lib.handouts).sort((x, y) => byText(String(y.handed_out_at || ''), String(x.handed_out_at || '')));
    for (const r of recs) {
      if (state !== null && r.state !== state) continue;
      if (target !== null && !sameTarget(r.target, target.kind, target.id)) continue;
      if (aid !== null && !(r.recipients || []).some((x) => x.annotator_id === aid)) continue;
      const o = this.handoutOut(r, p, held);
      if (overdue !== null && o.per_person.some((x) => x.overdue && (aid === null || x.annotator_id === aid)) !== overdue) continue;
      out.push(o);
    }
    return { handouts: out, today: today() };
  }

  op_handout_update(body) {
    const rec = this.needHandout(body.handout_id);
    const hid = rec.handout_id;
    if (rec.state !== 'open') throw conflict('withdrawn', 'This hand-out was withdrawn, so it cannot change');
    const fresh = {};
    if (has(body, 'due_at')) fresh.due_at = dueOf(body.due_at);
    for (const [k, limit] of [['name', 120], ['title', 120], ['note', 2000]]) if (given(body, k)) fresh[k] = text(body, k, { required: k !== 'note', limit });
    const follow = flag(body, 'follow_groups');
    if (follow !== null) fresh.follow_groups = follow;
    const addPeople = this._people(has(body, 'add_people') ? body.add_people : [], 'add_people');
    const giveNew = flag(body, 'give_new_recordings') || false;
    const changed = sortedText(Object.keys(fresh).filter((k) => rec[k] !== fresh[k]));
    const now = nowLocalIso();
    const record = { ...deepCopy(rec), ...fresh };
    const have = new Set(record.recipients.map((r) => r.annotator_id));
    let added = 0;
    const entries = changed.map((k) => ({ at: now, by: this.user, what: k }));
    const [live] = this._live(this.targetOf(rec.target, { active: false }).rids);
    const held = this._held();
    const joiners = addPeople.filter((a) => !have.has(a));
    if (joiners.length) this._recipients(joiners, []);
    for (const aid of joiners) {
      const [n, linked] = this._giveAll(hid, aid, live, held);
      record.recipients.push({ annotator_id: aid, via: 'person', given_at: now, given_by: this.user, added: n, already: live.length - n });
      record.people = [...(record.people || []), aid];
      DemoLibrary.noteLinked(record, aid, linked);
      added += n;
    }
    if (joiners.length) entries.push({ at: now, by: this.user, what: 'add_people', people: joiners });
    let fresher = [];
    if (giveNew) {
      fresher = this.newRecordings(record, this.covered(record, this._held()));
      if (fresher.length) {
        const again = this._held();
        for (const row of record.recipients) {
          const [n, linked] = this._giveAll(hid, row.annotator_id, fresher, again);
          row.added = Number(row.added || 0) + n;
          DemoLibrary.noteLinked(record, row.annotator_id, linked);
          added += n;
        }
        entries.push({ at: now, by: this.user, what: 'new_recordings', n: fresher.length });
      }
    }
    if (!entries.length) return { handout: this.handoutOut(rec), added: 0 };
    record.changes = [...(rec.changes || []), ...entries].slice(-CHANGES_KEPT);
    this.lib.handouts[hid] = record;
    const said = [...changed, ...(joiners.length ? [`gave it to ${joiners.slice(0, 10).join(', ')}`] : []), ...(fresher.length ? [`gave ${count(fresher.length, 'new recording')}`] : [])];
    this._audit('handout_update', `Changed the hand-out ${record.name}: ${said.join(', ')}`, { handout_id: hid, fields: changed, due_at: record.due_at ?? null,
      added_people: joiners, new_recordings: fresher.length, added, note_chars: has(fresh, 'note') ? fresh.note.length : null });
    return { handout: this.handoutOut(record), added };
  }

  op_handout_withdraw(body) {
    const rec = this.needHandout(body.handout_id);
    const hid = rec.handout_id;
    if (rec.state !== 'open') throw conflict('already_withdrawn', 'This hand-out was withdrawn already');
    const p = new Progress(this);
    let removed = 0;
    let kept = 0;
    const linked = Object.fromEntries(Object.entries(rec.linked || {}).map(([a, rs]) => [a, new Set(rs)]));
    const stay = [];
    for (const a of this.a.s.assignments) {
      if (a.mode !== 'standard' || a.handout_id !== hid) { stay.push(a); continue; }
      const aid = a.annotator_id;
      const rid = a.recording_id;
      const started = p.isSaved(aid, rid) || p.isSetAside(aid, rid) || p.inProgress(aid, rid);
      if (rec.linked_overflow || (linked[aid] && linked[aid].has(rid)) || started) { kept += 1; stay.push(a); continue; }
      removed += 1;
    }
    this.a.s.assignments = stay.map((a) => (a.handout_id === hid ? { ...a, handout_id: '' } : a));
    const now = nowLocalIso();
    const record = { ...rec, state: 'withdrawn', changes: [...(rec.changes || []), { at: now, by: this.user, what: 'withdraw', removed, kept }].slice(-CHANGES_KEPT) };
    this.lib.handouts[hid] = record;
    this._audit('handout_withdraw', `Withdrew the hand-out ${rec.name}: took back ${count(removed, 'unstarted assignment')}, kept ${kept}`, { handout_id: hid, removed, kept });
    return { handout: this.handoutOut(record, p), removed, kept };
  }

  /** Give people who joined a group what its open "all" hand-outs that follow it hold. */
  _follow(gid, joiners) {
    const out = [];
    const now = nowLocalIso();
    const held = this._held();
    for (const h of this._records('handouts')) {
      if (h.state !== 'open' || h.mode !== 'all' || !h.follow_groups || !(h.groups || []).includes(gid)) continue;
      const have = new Set((h.recipients || []).map((r) => r.annotator_id));
      const newcomers = joiners.filter((a) => !have.has(a));
      if (!newcomers.length) continue;
      const [live] = this._live(this.targetOf(h.target, { active: false }).rids);
      for (const aid of newcomers) {
        const u = this.a.user(aid);
        if (!u || (u.status || 'active') !== 'active') continue;
        const [n, linked] = this._giveAll(h.handout_id, aid, live, held);
        h.recipients.push({ annotator_id: aid, via: `group:${gid}`, given_at: now, given_by: this.user, added: n, already: live.length - n });
        DemoLibrary.noteLinked(h, aid, linked);
        out.push({ handout_id: h.handout_id, annotator_id: aid, added: n });
      }
      h.changes = [...(h.changes || []), { at: now, by: this.user, what: 'group_join', group_id: gid,
        people: out.filter((o) => o.handout_id === h.handout_id).map((o) => o.annotator_id) }].slice(-CHANGES_KEPT);
    }
    return out;
  }

  // ------------------------------------------------------------- tracking (tracking.py)
  op_tracking_datasets_get(body) {
    const kind = body.kind ?? null;
    if (kind !== null && ![...TRACK_KINDS, 'all'].includes(kind)) throw bad("kind must be 'dataset', 'collection', 'handout' or 'all'");
    const idx = new TrackingIndex(this, refreshOf(body));
    const kinds = kind === null || kind === 'all' ? TRACK_KINDS : [kind];
    return { generated_at: idx.generatedAt, cached: false, today: idx.today, people: deepCopy(idx.people), rows: idx.targets(kinds).map((t) => idx.summaryRow(t)) };
  }

  op_tracking_recordings_get(body) {
    const { kind, id } = body;
    if (!TRACK_KINDS.includes(kind)) throw bad("kind must be 'dataset', 'collection' or 'handout'");
    if (typeof id !== 'string' || !id) throw bad('id is missing');
    const status = body.status ?? null;
    if (status !== null && !STATUSES.includes(status)) throw bad(`status must be one of ${STATUSES.join(', ')}`);
    const overdue = flag(body, 'overdue');
    const rated = flag(body, 'rated');
    const query = body.query ?? null;
    if (query !== null && (typeof query !== 'string' || query.length > 200)) throw bad('query must be text of at most 200 characters');
    const offset = has(body, 'offset') ? body.offset : 0;
    const limit = has(body, 'limit') ? body.limit : LIMIT_MAX;
    if (!Number.isInteger(offset) || offset < 0) throw bad('offset must be a whole number, 0 or more');
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) throw bad(`limit must be a whole number from 1 to ${LIMIT_MAX.toLocaleString('en-GB')}`);
    const idx = new TrackingIndex(this, refreshOf(body));
    const t = idx.target(kind, id);
    if (!t) {
      throw { dataset: notFound('unknown_dataset', `This study has no dataset '${id}'`), collection: notFound('unknown_collection', `This study has no collection '${id}'`),
        handout: notFound('unknown_handout', `This study has no hand-out '${id}'`) }[kind];
    }
    let people = idx.people;
    if (t.pairs) people = people.filter((p) => t.pairs.has(p.annotator_id));
    if (given(body, 'annotator_id')) {
      const aid = aidOf(body.annotator_id);
      people = idx.people.filter((p) => p.annotator_id === aid);
      if (!people.length) throw notFound('unknown_user', `${aid} has no study work and is no annotator of this study`);
    }
    const needle = String(query || '').trim().toLowerCase();
    const n = t.ratings_target;
    const rows = [];
    for (const rid of t.rids) {
      const h = idx.heads.get(rid);
      if (needle && !rid.toLowerCase().includes(needle) && !String(h.file_name || '').toLowerCase().includes(needle)) continue;
      if (rated !== null && ((idx.rated[rid] || 0) >= n) !== rated) continue;
      const cells = {};
      for (const p of people) {
        const aid = p.annotator_id;
        cells[aid] = !t.pairs || (t.pairs.get(aid) || new Set()).has(rid) ? idx.cell(aid, rid) : null;
      }
      const shown = Object.values(cells).filter((c) => c !== null);
      if (status !== null && !shown.some((c) => c.status === status)) continue;
      if (overdue !== null && shown.some((c) => c.overdue) !== overdue) continue;
      rows.push([rid, h, cells]);
    }
    const page = rows.slice(offset, offset + limit);
    return { generated_at: idx.generatedAt, cached: false, today: idx.today, target: { kind, id, name: t.name }, ratings_target: n,
      people: deepCopy(people), total: rows.length, offset, next: offset + limit < rows.length ? offset + limit : null,
      rows: page.map(([rid, h, cells]) => ({ recording_id: rid, file_name: h.file_name || '', dataset_id: h.dataset_id, retired: Boolean(h.retired),
        n_given: idx.nGiven[rid] || 0, n_rated: idx.rated[rid] || 0, ratings_target: n, rated: (idx.rated[rid] || 0) >= n,
        n_set_aside: idx.people.filter((p) => idx.setAside.has(`${p.annotator_id}|${rid}`)).length, cells: deepCopy(cells) })) };
  }

  /** What would be notified (nothing is sent): datasets newly fully rated, people with overdue work, a weekly summary. */
  op_notify_preview_get(body) {
    const kind = has(body, 'kind') && body.kind !== undefined ? body.kind : 'all';
    if (!NOTICE_KINDS.includes(kind)) throw bad("kind must be 'weekly', 'complete', 'overdue' or 'all'");
    const idx = new TrackingIndex(this, refreshOf(body));
    return { generated_at: idx.generatedAt, cached: false, today: idx.today, notices: idx.notices(kind), sent: false };
  }

  // ------------------------------------------------------------- the annotator's side
  /**
   * For GET /assignments: each study item's open hand-out ({handout_id, title, due_at, overdue}, the one due
   * earliest) by item key, and the due list. Only titles and dates: never a dataset's or collection's name,
   * description or notes, nor the team's note (decision 1 of the project lead).
   */
  annotatorView(aid, items) {
    const mine = Object.values(this.lib.handouts).filter((h) => h.state === 'open' && (h.recipients || []).some((r) => r.annotator_id === aid));
    if (!mine.length) return [{}, []];
    const study = new Map(items.filter((i) => i.mode === 'standard' && i.source === 'assignment').map((i) => [i.rid, i]));
    const handoutOf = Object.fromEntries(this.a.s.assignments.filter((a) => a.annotator_id === aid && a.mode === 'standard').map((a) => [a.recording_id, a.handout_id || '']));
    const day = today();
    const perItem = {};
    const due = [];
    const order = (h) => [h.due_at || '9999-12-31', h.handed_out_at || ''];
    mine.sort((x, y) => byText(order(x)[0], order(y)[0]) || byText(order(x)[1], order(y)[1]));
    for (const h of mine) {
      const inTarget = this._memberTest(h.target);
      const rids = [...study.keys()].filter((r) => handoutOf[r] === h.handout_id || inTarget(r));
      if (!rids.length) continue;
      const open = (r) => !['done', 'unusable'].includes(study.get(r).status);
      const remaining = rids.filter(open).length;
      const late = Boolean(h.due_at) && day > h.due_at && remaining > 0;
      for (const r of rids) {
        const key = study.get(r).key;
        if (!perItem[key]) perItem[key] = { handout_id: h.handout_id, title: h.title || '', due_at: h.due_at || null, overdue: late && open(r) };
      }
      if (h.due_at) due.push({ handout_id: h.handout_id, title: h.title || '', due_at: h.due_at, total: rids.length, remaining, overdue: late });
    }
    return [perItem, due];
  }

  _memberTest(target) {
    if (target && target.kind === 'dataset') return (rid) => ((this.a.record('study', rid) || {}).dataset_id || DEFAULT_DATASET_ID) === target.id;
    const rec = this.lib.collections[String((target && target.id) || '')] || {};
    const set = new Set(rec.recording_ids || []);
    return (rid) => set.has(rid);
  }

  /** GET /assignments decorated: `handout` on each item and the `due` list (demo.js). */
  decorate(aid, items, answer) {
    const [perItem, due] = this.annotatorView(aid, items);
    answer.items.forEach((d, n) => { d.handout = perItem[items[n].key] || null; });
    answer.due = due;
    return answer;
  }

  /** overview: the people with an overdue hand-out and the open hand-outs. */
  overviewCounts() {
    const open = Object.values(this.lib.handouts).filter((h) => h.state === 'open');
    if (!open.length) return { overdue: 0, handouts_open: 0 };
    const late = new Set();
    const dated = open.filter((h) => h.due_at && today() > h.due_at);
    if (dated.length) {
      const p = new Progress(this);
      const held = this._held();
      for (const h of dated) for (const x of this.handoutOut(h, p, held).per_person) if (x.overdue) late.add(x.annotator_id);
    }
    return { overdue: late.size, handouts_open: open.length };
  }
}

// ------------------------------------------------------------------ tracking (electrotag/web/tracking.py)
const STATUSES = ['set_aside', 'revised', 'saved', 'locked', 'in_progress', 'opened', 'given', 'not_given'];
const TRACK_KINDS = ['dataset', 'collection', 'handout'];
const LIMIT_MAX = 1000;
const RECENT_DAYS = 7;
const NOTICE_KINDS = ['weekly', 'complete', 'overdue', 'all'];
const FINISHED = ['set_aside', 'revised', 'saved'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const many = (n, one, more = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : more}`;
const thousands = (n) => n.toLocaleString('en-GB');
const utc = (day) => new Date(`${day}T00:00:00Z`);
const minusDays = (day, n) => new Date(utc(day).getTime() - n * 86400000).toISOString().slice(0, 10);

function refreshOf(body) {
  const v = has(body, 'refresh') && body.refresh !== undefined && body.refresh !== null ? body.refresh : false;
  if (typeof v !== 'boolean') throw bad('refresh must be true or false');
  return v;
}

/** "Friday 20 November". */
export function dayLong(day) { return `${WEEKDAYS[utc(day).getUTCDay()]} ${dayWords(day)}`; }

/** The ISO year and week of a day. */
function isoWeek(day) {
  const d = utc(day);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return [d.getUTCFullYear(), Math.ceil(((d.getTime() - start) / 86400000 + 1) / 7)];
}

/** Everything the tracking reads of the sandbox, read once per answer (tracking.py TrackingIndex). */
class TrackingIndex {
  constructor(lib) {
    const b = lib.b;
    const a = lib.a;
    this.lib = lib;
    this.generatedAt = nowLocalIso();
    this.today = today();
    this.studyName = a.s.name;
    this.heads = lib._headsById();
    this.given = new Map(); // "aid|rid" -> {task_id, handout_id, assigned_at}
    const held = {};
    this.nGiven = {};
    for (const x of a.s.assignments) {
      if (x.mode !== 'standard' || x.context_id) continue;
      const aid = x.annotator_id.toUpperCase();
      this.given.set(`${aid}|${x.recording_id}`, { task_id: '', handout_id: x.handout_id || '', assigned_at: x.at || '' });
      (held[aid] || (held[aid] = {}))[x.recording_id] = x;
      this.nGiven[x.recording_id] = (this.nGiven[x.recording_id] || 0) + 1;
    }
    this.saved = new Map(); // "aid|rid" -> {first, last, version}
    const weekFrom = minusDays(this.today, RECENT_DAYS - 1);
    let savesWeek = 0;
    const saversWeek = new Set();
    for (const e of b.state.submissions) {
      if (e.mode !== 'standard') continue;
      const aid = String(e.annotator_id).toUpperCase();
      const k = `${aid}|${e.recording_id}`;
      const at = String(e.saved_at || '');
      const v = this.saved.get(k) || { first: at, last: at, version: 0 };
      v.first = v.first < at ? v.first : at;
      v.last = v.last > at ? v.last : at;
      v.version = Math.max(v.version, Number(e.attempt) || 1);
      this.saved.set(k, v);
      if (at.slice(0, 10) >= weekFrom) { savesWeek += 1; saversWeek.add(aid); }
    }
    this.savesWeek = savesWeek;
    this.saversWeek = saversWeek.size;
    this.rated = {};
    this.reached = {};
    for (const [k, v] of this.saved) {
      const rid = k.slice(k.indexOf('|') + 1);
      this.rated[rid] = (this.rated[rid] || 0) + 1;
      (this.reached[rid] || (this.reached[rid] = [])).push(v.first);
    }
    for (const v of Object.values(this.reached)) v.sort(byText);
    this.setAside = new Map();
    for (const m of Object.values(b.state.unusable || {})) {
      if (m.active && m.mode === 'standard' && m.recording_id) this.setAside.set(`${String(m.annotator_id).toUpperCase()}|${m.recording_id}`, String(m.changed_at || '') || this.generatedAt);
    }
    const p = new Progress(lib);
    this.opened = p.openings();
    const accounts = new Map(a.s.users.map((u) => [u.annotator_id.toUpperCase(), u]));
    this.names = Object.fromEntries([...accounts].map(([aid, u]) => [aid, u.display_name || '']));
    this.team = sortedText([...accounts].filter(([, u]) => rolesOf(u).includes('admin') && (u.status || 'active') === 'active').map(([aid]) => aid));
    const aids = new Set([...accounts].filter(([, u]) => rolesOf(u).includes('annotator')).map(([aid]) => aid));
    for (const k of [...this.given.keys(), ...this.saved.keys()]) aids.add(k.slice(0, k.indexOf('|')));
    this.people = sortedText(aids).map((aid) => {
      const u = accounts.get(aid);
      return { annotator_id: aid, display_name: (u && u.display_name) || '', roles: u ? rolesOf(u) : [], status: u ? u.status || 'active' : 'removed' };
    });
    this.drafts = new Set();
    for (const person of this.people) for (const rid of this.heads.keys()) if (b.state.drafts[b._key(person.annotator_id, rid, 'standard', '')]) this.drafts.add(`${person.annotator_id}|${rid}`);
    this.locked = new Set(b._gate().open ? [] : this.people.map((x) => x.annotator_id).filter((x) => held[x]));
    this.datasets = lib.allDatasets();
    this.collections = lib._records('collections').filter((c) => c.collection_id).sort((x, y) => byText(String(x.name || '').toLowerCase(), String(y.name || '').toLowerCase()));
    this.handouts = Object.values(lib.lib.handouts).filter((h) => h.handout_id).sort((x, y) => byText(String(y.handed_out_at || ''), String(x.handed_out_at || '')));
    this.handoutOut = {};
    this.covered = {};
    this.covering = new Map();
    for (const h of this.handouts) {
      this.handoutOut[h.handout_id] = lib.handoutOut(h, p, held);
      this.covered[h.handout_id] = lib.covered(h, held, lib._targetOrEmpty(h).rids);
      if (h.state !== 'open') continue;
      for (const [aid, rids] of Object.entries(this.covered[h.handout_id])) {
        for (const rid of rids) {
          const k = `${aid.toUpperCase()}|${rid}`;
          if (!this.covering.has(k)) this.covering.set(k, []);
          this.covering.get(k).push(h.handout_id);
        }
      }
    }
    const due = (hid) => this.handoutOut[hid].due_at || '9999-12-31';
    for (const list of this.covering.values()) list.sort((x, y) => byText(due(x), due(y)) || byText(this.handoutOut[x].handed_out_at, this.handoutOut[y].handed_out_at));
    this._cells = new Map();
  }

  /** {kind, id, name, rids, ratings_target, pairs: null | Map(aid -> Set(rid)), record}. */
  target(kind, tid) {
    const ratingsOfRec = (rec) => Number(rec.ratings_target) || RATINGS_TARGET;
    if (kind === 'dataset') {
      const rec = this.datasets.find((d) => d.dataset_id === tid);
      if (!rec) return null;
      return { kind, id: tid, name: rec.name || '', rids: [...this.heads.values()].filter((h) => h.dataset_id === tid).map((h) => h.recording_id), pairs: null, record: rec,
        ratings_target: ratingsOfRec(rec) };
    }
    if (kind === 'collection') {
      const rec = this.collections.find((c) => c.collection_id === tid);
      if (!rec) return null;
      return { kind, id: tid, name: rec.name || '', rids: (rec.recording_ids || []).filter((r) => this.heads.has(r)), pairs: null, record: rec, ratings_target: ratingsOfRec(rec) };
    }
    const rec = this.handouts.find((h) => h.handout_id === tid);
    if (!rec) return null;
    const inner = this.target(rec.target.kind, rec.target.id);
    const cov = this.covered[tid] || {};
    const order = inner ? [...inner.rids] : [];
    const union = new Set(Object.values(cov).flat().filter((r) => this.heads.has(r)));
    const rids = [...order.filter((r) => union.has(r)), ...sortedText([...union].filter((r) => !order.includes(r)))];
    return { kind, id: tid, name: rec.name || '', rids, record: rec, pairs: new Map(Object.entries(cov).map(([x, rs]) => [x, new Set(rs)])),
      ratings_target: inner ? inner.ratings_target : RATINGS_TARGET };
  }

  /** The Cell of one person and one study recording (docs/web/api.md). */
  cell(aid, rid) {
    const key = `${aid}|${rid}`;
    if (this._cells.has(key)) return this._cells.get(key);
    const held = this.given.get(key) || null;
    const saved = this.saved.get(key) || null;
    const aside = this.setAside.has(key) ? this.setAside.get(key) : null;
    const opened = this.opened.get(key) || null;
    let status;
    if (aside !== null) status = 'set_aside';
    else if (saved) status = saved.version >= 2 ? 'revised' : 'saved';
    else if (!held) status = 'not_given';
    else if (this.locked.has(aid)) status = 'locked';
    else if (this.drafts.has(key)) status = 'in_progress';
    else if (opened) status = 'opened';
    else status = 'given';
    const hids = this.covering.get(key) || [];
    const hid = (held && held.handout_id) || hids[0] || '';
    let assignedAt = held ? held.assigned_at || null : null;
    let assignedBy = null;
    if (hid) {
      const rec = this.handoutOut[hid];
      const row = ((rec || {}).recipients || []).find((r) => r.annotator_id === aid);
      if (row) {
        assignedAt = assignedAt || row.given_at || null;
        assignedBy = row.given_by || (rec || {}).handed_out_by || null;
      }
    }
    const dues = hids.map((h) => this.handoutOut[h].due_at).filter(Boolean);
    const dueAt = dues.length ? sortedText(dues)[0] : null;
    const overdue = !FINISHED.includes(status) && Boolean(held) && dues.some((d) => this.today > d);
    const out = { status, assigned_at: held ? assignedAt : null, assigned_by: held ? assignedBy : null, handout_id: hid || null,
      task_id: null, opened_at: opened ? opened.last : null, first_saved_at: saved ? saved.first : null, saved_at: saved ? saved.last : null,
      version: saved ? saved.version : null, set_aside_at: aside, due_at: dueAt, overdue };
    this._cells.set(key, out);
    return out;
  }

  summaryRow(t) {
    const members = new Set(t.rids);
    const live = t.rids.filter((r) => !this.heads.get(r).retired);
    const n = t.ratings_target;
    const nRated = live.filter((r) => (this.rated[r] || 0) >= n).length;
    const cells = {};
    for (const person of this.people) {
      const aid = person.annotator_id;
      const c = { given: 0, opened: 0, in_progress: 0, saved: 0, revised: 0, set_aside: 0, locked: 0, first_assigned_at: null, last_saved_at: null, due_at: null, overdue: 0 };
      const mine = t.pairs ? t.pairs.get(aid) || new Set() : null;
      for (const rid of t.rids) {
        if (mine && !mine.has(rid)) continue;
        const x = this.cell(aid, rid);
        if (x.status === 'not_given') continue;
        c.given += 1;
        c.opened += x.opened_at !== null ? 1 : 0;
        c.in_progress += x.status === 'in_progress' ? 1 : 0;
        c.saved += x.saved_at !== null ? 1 : 0;
        c.revised += x.status === 'revised' ? 1 : 0;
        c.set_aside += x.status === 'set_aside' ? 1 : 0;
        c.locked += x.status === 'locked' ? 1 : 0;
        c.overdue += x.overdue ? 1 : 0;
        if (x.assigned_at && (c.first_assigned_at === null || x.assigned_at < c.first_assigned_at)) c.first_assigned_at = x.assigned_at;
        if (x.saved_at && (c.last_saved_at === null || x.saved_at > c.last_saved_at)) c.last_saved_at = x.saved_at;
        if (x.due_at && (c.due_at === null || x.due_at < c.due_at)) c.due_at = x.due_at;
      }
      cells[aid] = c;
    }
    const row = { kind: t.kind, id: t.id, name: t.name, n_recordings: t.rids.length, n_retired: t.rids.length - live.length, ratings_target: n,
      ratings: ratingsHistogram(t.rids, this.rated), n_rated: nRated,
      n_set_aside: [...this.setAside.keys()].filter((k) => members.has(k.slice(k.indexOf('|') + 1))).length,
      state: t.record.state || (t.kind === 'handout' ? 'open' : 'active'), cells };
    if (t.kind === 'handout') {
      const h = this.handoutOut[t.id];
      Object.assign(row, { complete: h.complete, title: h.title, due_at: h.due_at, mode: h.mode, k: h.k,
        target: { kind: h.target.kind, id: h.target.id, name: h.target.name }, overdue_people: h.counts.overdue_people });
    } else row.complete = live.length > 0 && nRated === live.length;
    return row;
  }

  fullyRatedAt(t) {
    const live = t.rids.filter((r) => !this.heads.get(r).retired);
    const n = t.ratings_target;
    if (!live.length || live.some((r) => (this.rated[r] || 0) < n)) return null;
    return sortedText(live.map((r) => this.reached[r][n - 1])).pop();
  }

  targets(kinds) {
    const out = [];
    if (kinds.includes('dataset')) for (const d of this.datasets) { const t = this.target('dataset', d.dataset_id); if (t) out.push(t); }
    if (kinds.includes('collection')) for (const c of this.collections) { const t = this.target('collection', c.collection_id); if (t) out.push(t); }
    if (kinds.includes('handout')) for (const h of this.handouts) { const t = this.target('handout', h.handout_id); if (t) out.push(t); }
    return out;
  }

  // ------------------------------------------------------------- what would be notified (tracking.py notices)
  notices(kind = 'all') {
    const out = [];
    if (kind === 'complete' || kind === 'all') out.push(...this._complete());
    if (kind === 'overdue' || kind === 'all') out.push(...this._overdue());
    if (kind === 'weekly' || kind === 'all') out.push(this._weekly());
    return out;
  }

  _complete() {
    const since = minusDays(this.today, RECENT_DAYS - 1);
    const out = [];
    for (const t of this.targets(['dataset', 'collection'])) {
      const at = this.fullyRatedAt(t);
      if (at === null || at.slice(0, 10) < since) continue;
      const live = t.rids.filter((r) => !this.heads.get(r).retired).length;
      const what = t.kind === 'dataset' ? 'dataset' : 'collection';
      out.push({ notice_id: `${what}-complete-${t.id}`, kind: 'complete', to: [...this.team], subject: `The ${what} ${t.name} is fully rated`,
        text: `The ${what} ${t.name} in the study ${this.studyName} is fully rated: each of its ${many(live, 'recording')} in use has been saved by at least `
          + `${many(t.ratings_target, 'person', 'people')}. The last of them reached its target on ${dayLong(at.slice(0, 10))}.\n` });
    }
    return out;
  }

  _overdue() {
    const out = [];
    for (const h of this.handouts) {
      const o = this.handoutOut[h.handout_id];
      if (o.state !== 'open') continue;
      for (const x of o.per_person) {
        if (!x.overdue) continue;
        const left = many(x.remaining, 'recording');
        out.push({ notice_id: `overdue-${o.handout_id}-${x.annotator_id}`, kind: 'overdue', to: [x.annotator_id], subject: `${o.title}: ${left} still to annotate`,
          text: `This is a reminder from the study ${this.studyName}. ${left} of ${o.title} ${x.remaining === 1 ? 'is' : 'are'} still to annotate; `
            + `they were due on ${dayLong(o.due_at)}. Open ElectroTag to carry on, or tell the study team if something is in the way.\n` });
      }
    }
    return out;
  }

  _weekly() {
    const [year, week] = isoWeek(this.today);
    const lines = [`${this.studyName}: the week to ${dayLong(this.today)}`, '',
      `Saved in the last ${RECENT_DAYS} days: ${many(this.savesWeek, 'recording')} by ${many(this.saversWeek, 'person', 'people')}.`, ''];
    const open = this.handouts.filter((h) => this.handoutOut[h.handout_id].state === 'open');
    lines.push(open.length ? 'Hand-outs' : 'No hand-outs are open.');
    for (const h of open) {
      const o = this.handoutOut[h.handout_id];
      const c = o.counts;
      const due = o.due_at ? `, due ${dayLong(o.due_at)}` : '';
      const late = o.per_person.filter((x) => x.overdue).map((x) => x.annotator_id);
      const who = late.map((x) => (this.names[x] ? `${x} (${this.names[x]})` : x)).join(', ');
      lines.push(`- ${o.name} (${o.target.kind} ${o.target.name}${due}): ${thousands(c.given)} given, ${thousands(c.saved)} saved, ${thousands(c.set_aside)} set aside`
        + `${o.complete ? '. Complete.' : '.'}${late.length ? ` Overdue: ${who}.` : ''}`);
    }
    lines.push('', 'Datasets and collections');
    for (const t of this.targets(['dataset', 'collection'])) {
      const live = t.rids.filter((r) => !this.heads.get(r).retired);
      if (!live.length) continue;
      const n = live.filter((r) => (this.rated[r] || 0) >= t.ratings_target).length;
      const what = t.kind === 'dataset' ? '' : 'collection ';
      const state = n === live.length ? 'fully rated' : `${thousands(n)} of ${many(live.length, 'recording')} rated by ${many(t.ratings_target, 'person', 'people')} or more`;
      lines.push(`- ${what}${t.name}: ${state}.`);
    }
    return { notice_id: `weekly-${year}-W${String(week).padStart(2, '0')}`, kind: 'weekly', to: [...this.team],
      subject: `${this.studyName}: the week to ${dayWords(this.today)}`, text: `${lines.join('\n')}\n` };
  }
}
