// The admin area's operations in the demonstration (docs/web/api.md, "Administration"), carried
// out on the demonstration's own state in this browser: the study's settings, the accounts and
// their passwords, assignments and training programmes, the register of recordings (the three
// built-in examples and any added from this computer as manifests), reference sets made from
// someone's saved annotations or an annotation file, the audit log and the visits.
//
// What needs ElectroClean's Python code (the agreement and activity analyses, competency reports,
// consensus and adjudicated references, the example set's files and the results zip) is answered
// with an error that says so, and how to try it with `electroclean-web demo`.

import { CATALOGUE, DEFAULT_ANNOTATION, DEFAULT_DISPLAY, DEFAULT_FILTERS, DEFAULT_HIDE, DEFAULT_LOGGING, DEFAULT_QUICK_LABELS, DEFAULT_SCALINGS } from './demo_catalogue.js';
import { ApiError } from './http.js';
import { sha256Hex } from '../data/sha256.js';
import { newId, nowLocalIso } from '../util.js';
import {
  checkAnnotatorId, checkEmail, checkSetId, criteriaFromRows, criteriaRows, deepCopy, describeProvenance, mergeSettings,
  METRICS, plural, settingsProblems,
} from '../admin/model.js';

export const ADMIN_ID = 'ADMIN';
export const DEMO_LOGGING_NOTICE = 'This demonstration records how you use ElectroClean (clicks, keys and what is on the ' +
  'screen, never what you type) and keeps the record in this browser only. In a real study the record ' +
  "goes to the study team, as the study's information sheet explains.";
const MANIFEST_SCHEMA = 'electroclean.web_manifest';
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const LABEL_NAMES = CATALOGUE.labels.map((l) => l.label);
const BUILT_IN_AT = '2026-10-28T09:00:00.000+00:00';

/** The answer to an operation the demonstration cannot run in the browser. */
export function needsServer(what) {
  return new ApiError(501, 'needs_server', `The demonstration cannot ${what} in the browser: that needs a study server or ` +
    'Firebase. To try it on this computer, install ElectroClean and run electroclean-web demo, then open ' +
    'http://localhost:8000/ and sign in as ADMIN with the password electroclean.');
}

const SERVER_ONLY = {
  agreement: 'run the agreement analysis',
  activity: 'run the activity analysis',
  competency: 'write competency reports',
  results_zip: 'put every result into one zip file (Download the demonstration\'s results gives them as one JSON file)',
  set_example_create: 'create the example training set (it already has one: the Demonstration training set)',
};

const bad = (message, code = 'bad_request', status = 400) => new ApiError(status, code, message);
const notFound = (message) => new ApiError(404, 'not_found', message);
const conflict = (code, message) => new ApiError(409, code, message);

/** A password nobody has to type twice: three groups of four letters and digits that are hard to confuse. */
export function makePassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(12);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

function passwordHash(password, salt) {
  return sha256Hex(new TextEncoder().encode(`electroclean-demo:${salt}:${password}`));
}

/** The settings blocks that a study may change, with the demonstration's values. */
export function defaultSettings() {
  const { method, iir_order, ...filters } = DEFAULT_FILTERS; // eslint-disable-line no-unused-vars
  return {
    filters: { ...filters },
    display: { ...DEFAULT_DISPLAY, scalings: { ...DEFAULT_SCALINGS } },
    channels: { hide: [...DEFAULT_HIDE], types: {} },
    selection: { strategy: 'manual', seed: null },
    logging: { ...DEFAULT_LOGGING },
    annotation: { min_duration_samples: 1, ...DEFAULT_ANNOTATION, quick_labels: [...DEFAULT_QUICK_LABELS] },
    loading: { apply_channel_types_from_bids: true, show_bids_bad_channels: true },
  };
}

// ------------------------------------------------------------- manifests
function displayEvents(ev, nSamples, sfreq) {
  if (!ev || !Array.isArray(ev.rows)) return [];
  const cols = ev.columns || [];
  const col = (name) => { const i = cols.indexOf(name); return ev.rows.map((r) => (i >= 0 ? String(r[i]) : 'n/a')); };
  const types = col('trial_type');
  const values = col('value');
  const durations = col('duration');
  const fromFile = ev.source === 'edf_annotations' || ev.source === 'bdf_annotations';
  const out = [];
  (ev.sample || []).forEach((s, i) => {
    if (s === null || s === undefined || s < 0 || s >= nSamples) return;
    if (fromFile && /^bad_acq_skip/i.test(types[i] || '')) return;
    const label = types[i] && types[i] !== 'n/a' ? types[i] : `value ${values[i]}`;
    const dur = Number(durations[i]);
    out.push({ onset_sample: Math.trunc(s), duration_samples: Number.isFinite(dur) ? Math.round(dur * sfreq) : 0, label });
  });
  return out.sort((a, b) => a.onset_sample - b.onset_sample);
}

/** The Manifest of docs/web/api.md from an internal one (electroclean/web/manifest.py, public_manifest). */
export function publicManifest(m, studyScalings = {}) {
  const t = m.timing || {};
  const sfreq = Number(t.sfreq);
  const n = Number(t.n_samples);
  const fp = (m.fingerprint || {}).eeg || {};
  const amp = m.amplitude || {};
  return {
    recording_id: m.recording_id, file_name: m.file_name, format: m.format,
    sfreq, n_samples: n, duration_s: n / sfreq,
    ch_names: [...m.ch_names], hidden_channels: [...(m.hidden_channels || [])],
    channel_types: { ...(m.channel_types || {}) }, bad_channels: [...(m.bad_channels || [])],
    original_events: displayEvents(m.original_events, n, sfreq),
    gaps: (m.acquisition_gaps || []).map((g) => [...g]),
    display: { scalings: { ...studyScalings, ...(amp.suggested_scalings || {}) }, warnings: [...(m.warnings || []), ...(m.notes || [])] },
    fingerprint: { algorithm: 'sha256', role: 'eeg', hex: String(fp.sha256 || ''), size_bytes: Number(fp.size || 0) },
  };
}

/** Why an internal manifest cannot be registered, or null (the shape, sizes and consistency). */
export function manifestProblem(m) {
  if (!m || typeof m !== 'object') return 'it is not a recording description';
  if (m.schema !== MANIFEST_SCHEMA) return 'it is not an ElectroClean recording description (manifest)';
  if (String(m.schema_version || '').split('.')[0] !== '1') return `its version ${m.schema_version} is not supported`;
  if (typeof m.recording_id !== 'string' || !m.recording_id || m.recording_id.length > 512) return 'it has no recording ID';
  if (/(^|\/)\.\.(\/|$)|^\//.test(m.recording_id)) return 'its recording ID is not a path inside the dataset';
  const t = m.timing || {};
  if (!(Number(t.sfreq) > 0) || !(Number.isInteger(Number(t.n_samples)) && Number(t.n_samples) > 0)) return 'its sampling rate or length is missing';
  if (!Array.isArray(m.ch_names) || !m.ch_names.length || m.ch_names.some((c) => typeof c !== 'string' || !c)) return 'it lists no channels';
  if (new Set(m.ch_names).size !== m.ch_names.length) return 'a channel is listed twice';
  const fp = (m.fingerprint || {}).eeg || {};
  if (!/^[0-9a-f]{64}$/i.test(String(fp.sha256 || ''))) return "its data file's fingerprint (SHA-256) is missing";
  if (!(Number(fp.size) > 0)) return "its data file's size is missing";
  if (JSON.stringify(m).length > MAX_MANIFEST_BYTES) return 'it is too large';
  return null;
}

// ------------------------------------------------------------------ state
/** The admin state of a new demonstration: the built-in accounts, recordings and training set. */
export function initialAdminState({ recordings, trainingSet }) {
  const user = (annotator_id, display_name, role, programme = null) => ({
    annotator_id, display_name, email: null, role, status: 'active', created_at: BUILT_IN_AT, last_seen: null, notes: '',
    programme, builtin: true,
  });
  const record = (scope, r) => ({
    scope, recording_id: r.recording_id, file_name: r.file_name, format: 'edf', sfreq: r.sfreq, n_samples: r.n_samples,
    duration_s: r.n_samples / r.sfreq, n_channels: r.n_channels, size_bytes: r.size_bytes, sha256: null,
    registered_at: BUILT_IN_AT, registered_by: 'demonstration', registered_via: 'command', notes: '', retired: false,
    warnings: [], builtin: true,
  });
  const setRecords = [
    ...trainingSet.guided.map((g) => ({ recording_id: g.rid, use: 'guided', guidance: g.guidance })),
    ...trainingSet.practice.map((rid) => ({ recording_id: rid, use: 'practice', guidance: 'auto' })),
  ];
  return {
    version: 1,
    name: 'Demonstration',
    settings: defaultSettings(),
    logging_notice: DEMO_LOGGING_NOTICE,
    users: [
      user('A01', 'Demo annotator', 'annotator'),
      user('T01', 'Demo trainee', 'annotator', trainingSet.set_id),
      user(ADMIN_ID, 'Demo administrator', 'admin'),
    ],
    passwords: {},
    assignments: recordings.map((r) => ({ annotator_id: 'A01', recording_id: r.recording_id, mode: 'standard', context_id: '', at: BUILT_IN_AT })),
    recordings: [
      ...recordings.map((r) => record('study', r)),
      ...setRecords.map((s) => record(`set:${trainingSet.set_id}`, recordings.find((r) => r.recording_id === s.recording_id))),
    ],
    sets: [{
      set_id: trainingSet.set_id, name: trainingSet.name, builtin: true,
      description: 'Three simulated recordings with known artifacts: two to learn with the experts and one to practise on.',
      created_at: BUILT_IN_AT, created_by: 'demonstration', practice_review: true, allowed_annotators: [],
      practice_pass: { ...trainingSet.pass }, guided_tolerance: { seconds: 0.2, fraction: 0.2, channel_jaccard: 0.75 },
      criteria: { criteria: [], min_reference_events: 3, categories: null },
      recordings: setRecords.map((s) => ({
        ...s, provenance: { method: 'simulation', experts: [], notes: "The simulation's own artifacts stand in for the experts' annotations." },
        reference: null, builtin: true,
      })),
      quiz_items: [], guided_notes: {},
    }],
    visits: [],
    audit: [{ at: BUILT_IN_AT, by: 'command', op: 'init', summary: 'Demonstration created with three example recordings and the accounts A01, T01 and ADMIN', details: {} }],
  };
}

// --------------------------------------------------------------- the operations
export class DemoAdmin {
  /** @param backend the DemoBackend whose state, statuses and built-in recordings this works on */
  constructor(backend) {
    this.b = backend;
  }

  get s() {
    if (!this.b.state.admin || this.b.state.admin.version !== 1) this.b.state.admin = initialAdminState(this.b._builtIn());
    return this.b.state.admin;
  }

  // ------------------------------------------------------ used by the backend
  user(aid) {
    const id = String(aid || '').trim().toUpperCase();
    return this.s.users.find((u) => u.annotator_id === id) || null;
  }

  passwordOk(aid, password) {
    const u = this.user(aid);
    if (!u) return false;
    const stored = this.s.passwords[u.annotator_id];
    if (!stored) return u.builtin === true && password === 'demo';
    return passwordHash(String(password), stored.salt) === stored.hash;
  }

  touch(aid) {
    const u = this.user(aid);
    if (u) { u.last_seen = nowLocalIso(); this.b._save(); }
  }

  programmeOf(aid) {
    const u = this.user(aid);
    return u ? u.programme || null : null;
  }

  standardAssignments(aid) {
    return this.s.assignments.filter((a) => a.annotator_id === aid)
      .map((a) => ({ rid: a.recording_id, mode: a.mode, context_id: a.context_id || '' }));
  }

  record(scope, rid) {
    return this.s.recordings.find((r) => r.scope === scope && r.recording_id === rid) || null;
  }

  /** A recording added from this computer (scope study), with its internal manifest. */
  registered(rid) {
    const r = this.record('study', rid);
    return r && r.manifest ? r : null;
  }

  registeredRecordings() {
    return this.s.recordings.filter((r) => r.scope === 'study' && r.manifest);
  }

  publicManifestOf(rec) {
    return publicManifest(rec.manifest, this.s.settings.display.scalings);
  }

  /** The study block of GET /me. */
  studyBlock() {
    const st = this.s.settings;
    const logging = { ...st.logging };
    return {
      study_id: 'demo', name: this.s.name,
      filters: { ...st.filters },
      display: { duration_s: st.display.duration_s, n_channels: st.display.n_channels, scalings: { ...st.display.scalings } },
      // a demonstration saved before the comfort settings existed takes their defaults
      annotation: { min_duration_samples: st.annotation.min_duration_samples, quick_labels: [...st.annotation.quick_labels],
        ...Object.fromEntries(Object.entries(DEFAULT_ANNOTATION).map(([k, d]) => [k, st.annotation[k] ?? d])) },
      logging,
      logging_notice: logging.interactions ? this.s.logging_notice : '',
    };
  }

  guidedNote(setId, annotationId) {
    const set = this._setOrNull(setId);
    return set && set.guided_notes ? set.guided_notes[annotationId] ?? null : null;
  }

  visitOpened(v) {
    this.s.visits.push(v);
    if (this.s.visits.length > 500) this.s.visits.splice(0, this.s.visits.length - 500);
    this.b._save();
  }

  visitClosed(visitId, nEvents) {
    const v = this.s.visits.find((x) => x.visit_id === visitId);
    if (v) { v.closed_at = nowLocalIso(); v.n_events = nEvents; this.b._save(); }
  }

  // ----------------------------------------------------------------- helpers
  _actor() {
    const aid = this.b._aid();
    const u = this.user(aid);
    if (!u || u.role !== 'admin' || u.status !== 'active') throw new ApiError(403, 'forbidden', 'Only study administrators can use the admin area.');
    return aid;
  }

  _audit(op, summary, details = {}) {
    this.s.audit.push({ at: nowLocalIso(), by: this.b.annotatorId || 'unknown', op, summary, details });
    if (this.s.audit.length > 2000) this.s.audit.splice(0, this.s.audit.length - 2000);
  }

  _userOr404(aid) {
    const u = this.user(aid);
    if (!u) throw notFound(`There is no account ${String(aid || '').toUpperCase() || '(none given)'} in this study.`);
    return u;
  }

  _setOrNull(id) { return this.s.sets.find((x) => x.set_id === id) || null; }

  _setOr404(id) {
    const s = this._setOrNull(id);
    if (!s) throw notFound(`There is no reference set ${id || '(none given)'}.`);
    return s;
  }

  _scopeOk(scope) {
    if (scope === 'study') return 'study';
    const m = /^set:(.+)$/.exec(String(scope || ''));
    if (!m) throw bad('Choose where the recordings go: the study or one of the reference sets.');
    this._setOr404(m[1]);
    return scope;
  }

  /** Every work item of every account (or one), with its status, as the backend sees them. */
  _items(onlyAid = null) {
    const out = [];
    for (const u of this.s.users) {
      if (onlyAid && u.annotator_id !== onlyAid) continue;
      for (const a of this.b._assignmentsFor(u.annotator_id)) {
        const key = this.b._key(u.annotator_id, a.rid, a.mode, a.context_id);
        const subs = this.b.state.submissions.filter((s) => s.key === key);
        const draft = this.b.state.drafts[key];
        const last = [...subs.map((s) => s.saved_at), draft ? draft.saved_at : ''].filter(Boolean).sort().pop() || null;
        out.push({ annotator_id: u.annotator_id, recording_id: a.rid, mode: a.mode, context_id: a.context_id || '',
          status: this.b._status(u.annotator_id, a), attempts: subs.length, last_activity: last });
      }
    }
    return out;
  }

  _userRecord(u, items) {
    const mine = items.filter((i) => i.annotator_id === u.annotator_id);
    const { builtin, ...rest } = u; // eslint-disable-line no-unused-vars
    return { ...rest, assigned: mine.length, done: mine.filter((i) => i.status === 'done').length, programme: u.programme || null };
  }

  async _recordingRecord(r, items) {
    if (r.builtin && !r.sha256) {
      try { r.sha256 = (await this.b.exampleRecording(r.recording_id).fingerprint()).hex; } catch { /* left empty */ }
    }
    const ctx = r.scope === 'study' ? null : r.scope.slice(4);
    const mine = items.filter((i) => i.recording_id === r.recording_id && (ctx === null ? i.mode === 'standard' : i.context_id === ctx));
    const { manifest, ...rest } = r; // eslint-disable-line no-unused-vars
    return { ...rest, assigned: mine.length, done: mine.filter((i) => i.status === 'done').length };
  }

  _setRecord(set) {
    const guided = set.recordings.filter((r) => r.use === 'guided').map((r) => r.recording_id);
    const levels = ['show', 'find', 'find_unnamed'];
    const { reference, builtin, guided_notes, quiz_items, recordings, ...rest } = set; // eslint-disable-line no-unused-vars
    return {
      ...deepCopy(rest),
      recordings: recordings.map((r) => ({
        recording_id: r.recording_id, use: r.use, guidance: r.guidance || 'auto',
        effective_guidance: r.use !== 'guided' ? null : levels.includes(r.guidance) ? r.guidance
          : levels[Math.min(Math.max(0, guided.indexOf(r.recording_id)), levels.length - 1)],
        provenance: deepCopy(r.provenance || {}), n_reference_events: this._reference(set, r).length,
        registered: Boolean(this.record(`set:${set.set_id}`, r.recording_id)),
      })),
      quiz_items: (quiz_items || []).length,
    };
  }

  /** The reference annotations of a set's recording (the simulation's for the built-in examples). */
  _reference(set, entry) {
    if (entry.reference) return entry.reference;
    if (entry.builtin) return this.b._truthOf(entry.recording_id);
    return [];
  }

  /** Annotations as a reference: the fields that matter, checked against the recording. */
  _checkedAnnotations(list, info, what) {
    const chans = new Set(info.ch_names);
    return (list || []).map((a, i) => {
      const where = `${what}, annotation ${i + 1}`;
      if (!LABEL_NAMES.includes(a.label)) throw new ApiError(422, 'invalid_annotation', `${where}: ${a.label} is not one of the artifact types.`);
      const onset = Number.isInteger(a.onset_sample) ? a.onset_sample : Math.round(Number(a.onset) * info.sfreq);
      const dur = Number.isInteger(a.duration_samples) ? a.duration_samples : Math.round(Number(a.duration) * info.sfreq);
      if (!(onset >= 0 && dur >= 1 && onset + dur <= info.n_samples)) throw new ApiError(422, 'invalid_annotation', `${where} lies outside the recording.`);
      const channels = Array.isArray(a.channels) ? a.channels.map(String) : [];
      if (channels.some((c) => !chans.has(c))) throw new ApiError(422, 'invalid_annotation', `${where} names a channel the recording does not have.`);
      return { annotation_id: /^[A-Za-z0-9_-]{1,64}$/.test(a.annotation_id || '') ? a.annotation_id : newId(), label: a.label,
        onset_sample: onset, duration_samples: dur, channels, created_at: a.created_at || nowLocalIso(), modified_at: a.modified_at || nowLocalIso() };
    }).sort((x, y) => x.onset_sample - y.onset_sample);
  }

  // ------------------------------------------------------------------ dispatch
  async run(op, body = {}) {
    this._actor();
    const b = body && typeof body === 'object' ? body : {};
    if (SERVER_ONLY[op]) throw needsServer(SERVER_ONLY[op]);
    const fn = this[`op_${op}`];
    if (typeof fn !== 'function') throw notFound(`Unknown operation ${op}`);
    const out = await fn.call(this, b);
    this.b._save();
    return deepCopy(out);
  }

  // ------------------------------------------------------------------ overview
  op_overview() {
    const items = this._items();
    const subs = this.b.state.submissions;
    return {
      study: { study_id: 'demo', name: this.s.name },
      counts: {
        recordings: this.s.recordings.filter((r) => r.scope === 'study').length,
        annotators: this.s.users.filter((u) => u.role === 'annotator').length,
        admins: this.s.users.filter((u) => u.role === 'admin').length,
        assignments: items.length,
        done: items.filter((i) => i.status === 'done').length,
        in_progress: items.filter((i) => i.status === 'in_progress').length,
        todo: items.filter((i) => i.status === 'todo').length,
      },
      recent: [...this.s.audit].reverse().slice(0, 10),
      last_saved: [...subs].reverse().slice(0, 10).map((s) => ({ annotator_id: s.annotator_id, recording_id: s.recording_id, mode: s.mode,
        context_id: s.context_id || '', at: s.saved_at })),
    };
  }

  // ------------------------------------------------------------------ settings
  op_settings_get() {
    return { name: this.s.name, settings: deepCopy(this.s.settings), logging_notice: this.s.logging_notice };
  }

  op_settings_update(body) {
    const changed = [];
    if (body.settings !== undefined) {
      if (!body.settings || typeof body.settings !== 'object') throw bad('The settings must be given by block (filters, display, ...).', 'invalid_settings');
      const known = Object.keys(this.s.settings);
      const unknown = Object.keys(body.settings).filter((k) => !known.includes(k));
      if (unknown.length) throw bad(`${unknown.join(', ')} cannot be changed here.`, 'invalid_settings');
      const next = mergeSettings(this.s.settings, body.settings);
      const problems = settingsProblems(next, LABEL_NAMES);
      if (problems.length) throw bad(problems[0], 'invalid_settings');
      this.s.settings = next;
      changed.push(...Object.keys(body.settings));
    }
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw bad('The study needs a name.', 'invalid_settings');
      if (name.length > 120) throw bad('The study name has at most 120 characters.', 'invalid_settings');
      this.s.name = name;
      changed.push('name');
    }
    if (body.logging_notice !== undefined) {
      this.s.logging_notice = String(body.logging_notice).slice(0, 4000);
      changed.push('logging notice');
    }
    if (changed.length) this._audit('settings_update', `Changed the study settings (${changed.join(', ')})`, { changed });
    return this.op_settings_get();
  }

  // ------------------------------------------------------------------ accounts
  op_users_list() {
    const items = this._items();
    return { users: this.s.users.map((u) => this._userRecord(u, items)) };
  }

  op_user_add(body) {
    let id;
    let email;
    try { id = checkAnnotatorId(body.annotator_id); email = checkEmail(body.email); } catch (exc) { throw bad(exc.message); }
    if (this.user(id)) throw conflict('user_exists', `There is already an account ${id}.`);
    const role = body.role || 'annotator';
    if (!['annotator', 'admin'].includes(role)) throw bad('The role is annotator or admin.');
    let temporary = null;
    let password = body.password ? String(body.password) : '';
    if (password && password.length < 8) throw bad('A password has at least 8 characters.');
    if (!password) { temporary = makePassword(); password = temporary; }
    const salt = newId().slice(0, 16);
    this.s.passwords[id] = { salt, hash: passwordHash(password, salt) };
    const u = { annotator_id: id, display_name: String(body.display_name || '').trim(), email, role, status: 'active',
      created_at: nowLocalIso(), last_seen: null, notes: '', programme: null };
    this.s.users.push(u);
    this._audit('user_add', `Added ${id}${u.display_name ? ` (${u.display_name})` : ''}${role === 'admin' ? ' as an administrator' : ''}`, { annotator_id: id, role });
    return { user: this._userRecord(u, this._items(id)), invite_link: null, temporary_password: temporary };
  }

  op_user_update(body) {
    const u = this._userOr404(body.annotator_id);
    const self = u.annotator_id === this.b.annotatorId;
    const changes = [];
    if (body.role !== undefined && body.role !== u.role) {
      if (!['annotator', 'admin'].includes(body.role)) throw bad('The role is annotator or admin.');
      if (self) throw conflict('self', 'You cannot take away your own administrator role; ask another administrator.');
      u.role = body.role;
      changes.push(`role ${body.role}`);
    }
    if (body.status !== undefined && body.status !== u.status) {
      if (!['active', 'disabled'].includes(body.status)) throw bad('An account is active or disabled.');
      if (self) throw conflict('self', 'You cannot switch off your own account.');
      u.status = body.status;
      changes.push(body.status === 'disabled' ? 'switched off' : 'switched on');
    }
    if (body.display_name !== undefined) { u.display_name = String(body.display_name).trim(); changes.push('name'); }
    if (body.notes !== undefined) { u.notes = String(body.notes).slice(0, 4000); changes.push('notes'); }
    if (changes.length) this._audit('user_update', `Changed ${u.annotator_id} (${changes.join(', ')})`, { annotator_id: u.annotator_id, changes });
    return { user: this._userRecord(u, this._items(u.annotator_id)) };
  }

  op_user_reset_password(body) {
    const u = this._userOr404(body.annotator_id);
    const temporary = makePassword();
    const salt = newId().slice(0, 16);
    this.s.passwords[u.annotator_id] = { salt, hash: passwordHash(temporary, salt) };
    this._audit('user_reset_password', `Reset the password of ${u.annotator_id}`, { annotator_id: u.annotator_id });
    return { invite_link: null, temporary_password: temporary };
  }

  op_user_remove(body) {
    const u = this._userOr404(body.annotator_id);
    if (u.annotator_id === this.b.annotatorId) throw conflict('self', 'You cannot remove your own account.');
    this.s.users = this.s.users.filter((x) => x !== u);
    this.s.assignments = this.s.assignments.filter((a) => a.annotator_id !== u.annotator_id);
    delete this.s.passwords[u.annotator_id];
    for (const set of this.s.sets) set.allowed_annotators = set.allowed_annotators.filter((x) => x !== u.annotator_id);
    this._audit('user_remove', `Removed ${u.annotator_id} from the study (their results and logs stay)`, { annotator_id: u.annotator_id });
    return {};
  }

  // ---------------------------------------------------------------- assignments
  op_assignments_list(body) {
    const aid = body.annotator_id ? this._userOr404(body.annotator_id).annotator_id : null;
    return { items: this._items(aid) };
  }

  op_assign(body) {
    const ids = [...new Set((body.annotator_ids || []).map((x) => String(x).toUpperCase()))];
    if (!ids.length) throw bad('Choose at least one annotator.');
    ids.forEach((x) => this._userOr404(x));
    const mode = body.mode || 'standard';
    if (mode !== 'standard') {
      throw bad('In the demonstration, recordings are assigned for annotation; training recordings come with the training programme (choose it on the annotator\'s page).', 'demo_limit', 422);
    }
    const active = this.s.recordings.filter((r) => r.scope === 'study' && !r.retired).map((r) => r.recording_id);
    let rids;
    if (body.all) rids = active;
    else {
      rids = [...new Set(body.recording_ids || [])];
      if (!rids.length) throw bad('Choose at least one recording, or all of them.');
      for (const rid of rids) if (!this.record('study', rid)) throw notFound(`There is no recording ${rid} in the study.`);
      rids = rids.filter((rid) => active.includes(rid));
    }
    let added = 0;
    let already = 0;
    for (const aid of ids) {
      for (const rid of rids) {
        if (this.s.assignments.some((a) => a.annotator_id === aid && a.recording_id === rid && a.mode === mode && a.context_id === '')) already += 1;
        else { this.s.assignments.push({ annotator_id: aid, recording_id: rid, mode, context_id: '', at: nowLocalIso() }); added += 1; }
      }
    }
    if (added) this._audit('assign', `Assigned ${plural(rids.length, 'recording')} to ${ids.join(', ')} (${added} new)`, { annotator_ids: ids, recording_ids: rids, mode });
    return { added, already };
  }

  op_unassign(body) {
    const u = this._userOr404(body.annotator_id);
    const mode = body.mode || 'standard';
    const ctx = body.context_id || '';
    const i = this.s.assignments.findIndex((a) => a.annotator_id === u.annotator_id && a.recording_id === body.recording_id && a.mode === mode && (a.context_id || '') === ctx);
    if (i < 0) {
      if (u.programme && ctx === u.programme) throw conflict('programme', `This recording is part of ${u.annotator_id}'s training programme; change the programme instead.`);
      throw notFound(`${body.recording_id} is not assigned to ${u.annotator_id}.`);
    }
    if (this.b._status(u.annotator_id, { rid: body.recording_id, mode, context_id: ctx }) === 'done') {
      throw conflict('done', `${u.annotator_id} has already finished ${body.recording_id}, so it stays with their results.`);
    }
    this.s.assignments.splice(i, 1);
    this._audit('unassign', `Took ${body.recording_id} away from ${u.annotator_id}`, { annotator_id: u.annotator_id, recording_id: body.recording_id, mode, context_id: ctx });
    return {};
  }

  op_programme_set(body) {
    const u = this._userOr404(body.annotator_id);
    const sid = body.set_id || null;
    if (sid) {
      this._setOr404(sid);
      if (sid !== this.b._trainingSetId()) {
        throw bad('In the demonstration, only the Demonstration training set runs as a training programme; a study server or Firebase runs a programme from any reference set.', 'demo_limit', 422);
      }
    }
    u.programme = sid;
    this._audit('programme_set', sid ? `Put ${u.annotator_id} in the training programme of ${sid}` : `Took ${u.annotator_id} out of the training programme`, { annotator_id: u.annotator_id, set_id: sid });
    return {};
  }

  // ---------------------------------------------------------------- recordings
  async op_recordings_list(body) {
    const items = this._items();
    const list = this.s.recordings.filter((r) => !body.scope || r.scope === body.scope);
    const out = [];
    for (const r of list) out.push(await this._recordingRecord(r, items));
    return { recordings: out };
  }

  op_recordings_register(body) {
    const scope = this._scopeOk(body.scope || 'study');
    if (!Array.isArray(body.manifests) || !body.manifests.length) throw bad('There are no recordings to add.');
    const out = { added: [], replaced: [], skipped: [] };
    const who = this.b.annotatorId;
    for (const m of body.manifests) {
      const rid = m && typeof m.recording_id === 'string' ? m.recording_id : '(no ID)';
      const problem = manifestProblem(m);
      if (problem) { out.skipped.push({ recording_id: rid, reason: `It cannot be added: ${problem}.` }); continue; }
      const fp = m.fingerprint.eeg;
      const old = this.record(scope, rid);
      if (old && old.builtin) { out.skipped.push({ recording_id: rid, reason: 'It is one of the demonstration\'s built-in examples.' }); continue; }
      if (old && !body.replace) { out.skipped.push({ recording_id: rid, reason: 'It is registered already (choose Replace to update its description).' }); continue; }
      const hasResults = this.b.state.submissions.some((s) => s.recording_id === rid);
      if (old && hasResults && String(old.sha256).toLowerCase() !== String(fp.sha256).toLowerCase()) {
        out.skipped.push({ recording_id: rid, reason: 'Someone has saved results for it, and this file is a different one (its fingerprint differs).' });
        continue;
      }
      const t = m.timing;
      const record = {
        scope, recording_id: rid, file_name: m.file_name || rid.split('/').pop(), format: m.format || '', sfreq: Number(t.sfreq),
        n_samples: Number(t.n_samples), duration_s: Number(t.n_samples) / Number(t.sfreq), n_channels: m.ch_names.length,
        size_bytes: Number(fp.size), sha256: String(fp.sha256).toLowerCase(), registered_at: nowLocalIso(), registered_by: who,
        registered_via: 'browser', notes: old ? old.notes : '', retired: old ? old.retired : false,
        warnings: [...(m.warnings || [])].map(String), manifest: { ...deepCopy(m), scope },
      };
      if (old) { Object.assign(old, record); out.replaced.push(rid); } else { this.s.recordings.push(record); out.added.push(rid); }
    }
    if (out.added.length || out.replaced.length) {
      this._audit('recordings_register', `Added ${plural(out.added.length, 'recording')}${out.replaced.length ? ` and replaced ${out.replaced.length}` : ''} (${scope === 'study' ? 'the study' : scope})`,
        { scope, added: out.added, replaced: out.replaced, skipped: out.skipped.length });
    }
    return out;
  }

  async op_recording_update(body) {
    const r = this.record(body.scope || 'study', body.recording_id);
    if (!r) throw notFound(`There is no recording ${body.recording_id} there.`);
    const changes = [];
    if (body.notes !== undefined) { r.notes = String(body.notes).slice(0, 4000); changes.push('notes'); }
    if (body.retired !== undefined) { r.retired = Boolean(body.retired); changes.push(r.retired ? 'retired' : 'back in use'); }
    if (changes.length) this._audit('recording_update', `Changed ${r.recording_id} (${changes.join(', ')})`, { scope: r.scope, recording_id: r.recording_id, changes });
    return { recording: await this._recordingRecord(r, this._items()) };
  }

  op_recording_remove(body) {
    const scope = body.scope || 'study';
    const r = this.record(scope, body.recording_id);
    if (!r) throw notFound(`There is no recording ${body.recording_id} there.`);
    if (r.builtin) throw conflict('has_results', 'The built-in example recordings stay in the demonstration. Retire it instead, so it is offered for no new assignments.');
    const ctx = scope === 'study' ? null : scope.slice(4);
    const saved = this.b.state.submissions.some((s) => s.recording_id === r.recording_id && (ctx === null ? s.mode === 'standard' : s.context_id === ctx));
    const usedBy = this.s.sets.filter((s) => (ctx === null ? false : s.set_id === ctx) && s.recordings.some((x) => x.recording_id === r.recording_id));
    if (saved || usedBy.length) {
      throw conflict('has_results', saved ? 'Someone has saved annotations of this recording, so it stays. Retire it instead.' : 'A reference set uses this recording. Remove it from the set first, or retire it.');
    }
    this.s.recordings = this.s.recordings.filter((x) => x !== r);
    if (scope === 'study') this.s.assignments = this.s.assignments.filter((a) => a.recording_id !== r.recording_id);
    this._audit('recording_remove', `Removed ${r.recording_id} (${scope === 'study' ? 'the study' : scope})`, { scope, recording_id: r.recording_id });
    return {};
  }

  // ----------------------------------------------------------- reference sets
  op_sets_list() {
    return { sets: this.s.sets.map((s) => this._setRecord(s)) };
  }

  op_set_create(body) {
    let id;
    try { id = checkSetId(body.set_id); } catch (exc) { throw bad(exc.message); }
    if (this._setOrNull(id)) throw conflict('set_exists', `There is already a reference set ${id}.`);
    const set = {
      set_id: id, name: String(body.name || '').trim() || id, description: String(body.description || '').trim(),
      created_at: nowLocalIso(), created_by: this.b.annotatorId, practice_review: true, allowed_annotators: [],
      practice_pass: { event_f1: 0.8, label_accuracy: 0.8 }, guided_tolerance: { seconds: 0.2, fraction: 0.2, channel_jaccard: 0.75 },
      criteria: { criteria: [], min_reference_events: 3, categories: null }, recordings: [], quiz_items: [], guided_notes: {},
    };
    this.s.sets.push(set);
    this._audit('set_create', `Created the reference set ${id}${set.name !== id ? ` (${set.name})` : ''}`, { set_id: id });
    return { set: this._setRecord(set) };
  }

  op_set_update(body) {
    const set = this._setOr404(body.set_id);
    const changes = [];
    const fraction = (v, what) => { const x = Number(v); if (!(x >= 0 && x <= 1)) throw bad(`${what} is between 0 and 100%.`); return x; };
    if (body.name !== undefined) { set.name = String(body.name).trim() || set.set_id; changes.push('name'); }
    if (body.description !== undefined) { set.description = String(body.description); changes.push('description'); }
    if (body.practice_review !== undefined) { set.practice_review = Boolean(body.practice_review); changes.push('practice review'); }
    if (body.allowed_annotators !== undefined) {
      if (!Array.isArray(body.allowed_annotators)) throw bad('The annotators allowed to use the set are a list of IDs.');
      set.allowed_annotators = [...new Set(body.allowed_annotators.map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
      changes.push('who may use it');
    }
    if (body.practice_pass !== undefined) {
      const p = body.practice_pass || {};
      set.practice_pass = { event_f1: fraction(p.event_f1, 'The share of artifacts found'), label_accuracy: fraction(p.label_accuracy, 'The share given the right type') };
      changes.push('pass mark');
    }
    if (body.guided_tolerance !== undefined) {
      const t = body.guided_tolerance || {};
      const seconds = Number(t.seconds);
      if (!(seconds >= 0 && seconds <= 5)) throw bad('The start and end of a guided step match within 0 to 5 seconds.');
      const cj = fraction(t.channel_jaccard, 'The channels that must be the same');
      if (cj <= 0) throw bad('At least some of the channels must be the same (more than 0%).');
      set.guided_tolerance = { seconds, fraction: fraction(t.fraction, 'The share of its length'), channel_jaccard: cj };
      changes.push('guided matching');
    }
    if (body.criteria !== undefined) {
      const c = body.criteria || {};
      for (const x of c.criteria || []) if (!METRICS[x.metric]) throw bad(`${x.metric} is not a competency measure.`);
      try {
        set.criteria = criteriaFromRows(criteriaRows(c), c.min_reference_events ?? 3, c.categories);
      } catch (exc) { throw bad(exc.message); }
      changes.push('competency criteria');
    }
    if (changes.length) this._audit('set_update', `Changed the reference set ${set.set_id} (${changes.join(', ')})`, { set_id: set.set_id, changes });
    return { set: this._setRecord(set) };
  }

  op_set_delete(body) {
    const set = this._setOr404(body.set_id);
    const enrolled = this.s.users.filter((u) => u.programme === set.set_id).map((u) => u.annotator_id);
    const used = this.b.state.submissions.some((s) => s.context_id === set.set_id);
    if (enrolled.length || used) {
      throw conflict('in_use', enrolled.length ? `${enrolled.join(', ')} ${enrolled.length === 1 ? 'is' : 'are'} in this set's training programme. Take them out of it first.`
        : 'Trainees have saved work in this set, so it stays.');
    }
    this.s.sets = this.s.sets.filter((x) => x !== set);
    this.s.recordings = this.s.recordings.filter((r) => r.scope !== `set:${set.set_id}`);
    this._audit('set_delete', `Deleted the reference set ${set.set_id}`, { set_id: set.set_id });
    return {};
  }

  op_set_add_reference(body) {
    const set = this._setOr404(body.set_id);
    const use = body.use;
    if (!['guided', 'practice', 'assessment'].includes(use)) throw bad('Choose how the recording is used: guided, practice or assessment.');
    const fromScope = body.recording_scope || 'study';
    const source = body.source || {};
    if (source.kind === 'consensus') throw needsServer('build a consensus of several annotators');
    if (source.kind === 'adjudicated') throw needsServer('add an adjudicated reference');
    const rec = this.record(fromScope, body.recording_id);
    if (!rec) throw notFound(`There is no recording ${body.recording_id} to use.`);
    const info = this.b._recordingInfo(rec.recording_id, rec);
    if (!info) throw notFound(`There is no recording ${body.recording_id} to use.`);
    let reference;
    let provenance;
    if (source.kind === 'annotator') {
      const aid = String(source.annotator_id || '').toUpperCase();
      const mode = source.mode || 'standard';
      const ctx = source.context_id || '';
      const subs = this.b.state.submissions.filter((s) => s.annotator_id === aid && s.recording_id === rec.recording_id && s.mode === mode && (s.context_id || '') === ctx);
      if (!subs.length) throw notFound(`${aid || 'That person'} has not saved annotations of ${rec.recording_id}${mode !== 'standard' ? ` in ${mode}` : ''}.`);
      reference = this._checkedAnnotations(subs[subs.length - 1].annotations, info, `${aid}'s annotations`);
      provenance = { method: 'single_expert', experts: [aid], source: { kind: 'annotator', annotator_id: aid, mode, context_id: ctx, attempt: subs[subs.length - 1].attempt } };
    } else if (source.kind === 'document') {
      const doc = source.document;
      if (!doc || !Array.isArray(doc.annotations)) throw bad('The annotation file has no annotations to use.');
      const r = doc.recording || {};
      if (r.n_samples !== undefined && Number(r.n_samples) !== info.n_samples) {
        throw new ApiError(422, 'wrong_recording', `The annotation file is for a recording of ${r.n_samples} samples; ${rec.recording_id} has ${info.n_samples}.`);
      }
      if (r.sfreq !== undefined && Number(r.sfreq) !== info.sfreq) {
        throw new ApiError(422, 'wrong_recording', `The annotation file is for a recording at ${r.sfreq} Hz; ${rec.recording_id} is at ${info.sfreq} Hz.`);
      }
      reference = this._checkedAnnotations(doc.annotations, info, 'The annotation file');
      const annotator = (doc.annotator && doc.annotator.annotator_id) || null;
      provenance = { method: 'single_expert', experts: annotator ? [annotator] : [], source: { kind: 'document', annotator_id: annotator, recording_id: r.recording_id || null } };
    } else {
      throw bad('Choose where the reference comes from.');
    }
    provenance = { ...provenance, notes: String((body.provenance && body.provenance.notes) || ''), created_at: nowLocalIso(), created_by: this.b.annotatorId };
    if (!this.record(`set:${set.set_id}`, rec.recording_id)) {
      this.s.recordings.push({ ...deepCopy(rec), scope: `set:${set.set_id}`, registered_at: nowLocalIso(), registered_by: this.b.annotatorId,
        registered_via: 'browser', notes: '', retired: false, ...(rec.manifest ? { manifest: { ...deepCopy(rec.manifest), scope: `set:${set.set_id}` } } : {}) });
    }
    const entry = { recording_id: rec.recording_id, use, guidance: 'auto', provenance, reference };
    const at = set.recordings.findIndex((x) => x.recording_id === rec.recording_id);
    if (at >= 0) set.recordings[at] = entry; else set.recordings.push(entry);
    this._audit('set_add_reference', `Added ${rec.recording_id} to ${set.set_id} for ${use} (${describeProvenance(provenance)}, ${plural(reference.length, 'annotation')})`,
      { set_id: set.set_id, recording_id: rec.recording_id, use, source: source.kind });
    return { set: this._setRecord(set), disagreements: null };
  }

  op_set_recording_update(body) {
    const set = this._setOr404(body.set_id);
    const r = set.recordings.find((x) => x.recording_id === body.recording_id);
    if (!r) throw notFound(`${body.recording_id} is not in ${set.set_id}.`);
    const warnings = [];
    const changes = [];
    if (body.use !== undefined && body.use !== r.use) {
      if (!['guided', 'practice', 'assessment'].includes(body.use)) throw bad('The use is guided, practice or assessment.');
      if (body.use === 'assessment') {
        const seen = [...new Set(this.b.state.submissions.filter((s) => s.recording_id === r.recording_id && s.context_id === set.set_id && ['guided', 'practice'].includes(s.mode))
          .map((s) => s.annotator_id))];
        if (seen.length) warnings.push(`${seen.join(', ')} already annotated this recording in training and may have seen its reference, so the assessment is not blinded for them.`);
      }
      changes.push(`use ${body.use}`);
      r.use = body.use;
    }
    if (body.guidance !== undefined) {
      if (!['auto', 'show', 'find', 'find_unnamed'].includes(body.guidance)) throw bad('Choose how much help the guided recording gives.');
      r.guidance = body.guidance;
      changes.push(`guidance ${body.guidance}`);
    }
    if (changes.length) this._audit('set_recording_update', `Changed ${r.recording_id} in ${set.set_id} (${changes.join(', ')})`, { set_id: set.set_id, recording_id: r.recording_id, changes });
    return { set: this._setRecord(set), warnings };
  }

  op_set_remove_recording(body) {
    const set = this._setOr404(body.set_id);
    const r = set.recordings.find((x) => x.recording_id === body.recording_id);
    if (!r) throw notFound(`${body.recording_id} is not in ${set.set_id}.`);
    if (r.builtin) throw conflict('in_use', 'The Demonstration training set keeps its three recordings. Create a set of your own to try removing one.');
    set.recordings = set.recordings.filter((x) => x !== r);
    this._audit('set_remove_recording', `Removed ${r.recording_id} from ${set.set_id}`, { set_id: set.set_id, recording_id: r.recording_id });
    return { set: this._setRecord(set) };
  }

  op_set_guided_notes(body) {
    const set = this._setOr404(body.set_id);
    const r = set.recordings.find((x) => x.recording_id === body.recording_id);
    if (!r) throw notFound(`${body.recording_id} is not in ${set.set_id}.`);
    const info = this.b._recordingInfo(r.recording_id, this.record(`set:${set.set_id}`, r.recording_id));
    const sf = info ? info.sfreq : 1;
    return {
      notes: this._reference(set, r).map((a) => ({
        annotation_id: a.annotation_id, label: a.label, onset_s: a.onset_sample / sf, offset_s: (a.onset_sample + a.duration_samples) / sf,
        note: (set.guided_notes || {})[a.annotation_id] ?? (r.builtin ? this.b._exampleNoteOf(r.recording_id, a) : ''),
      })),
    };
  }

  op_set_guided_note(body) {
    const set = this._setOr404(body.set_id);
    const known = set.recordings.some((r) => this._reference(set, r).some((a) => a.annotation_id === body.annotation_id));
    if (!known) throw notFound('That annotation is not in the reference set.');
    set.guided_notes = { ...(set.guided_notes || {}), [body.annotation_id]: String(body.text || '').slice(0, 4000) };
    this._audit('set_guided_note', `Changed a guided note in ${set.set_id}`, { set_id: set.set_id, annotation_id: body.annotation_id });
    return {};
  }

  // ------------------------------------------------------------------- quiz
  op_quiz_items(body) {
    return { items: deepCopy(this._setOr404(body.set_id).quiz_items || []) };
  }

  op_quiz_item_add(body) {
    const set = this._setOr404(body.set_id);
    const rec = this.record(`set:${set.set_id}`, body.recording_id) || this.record('study', body.recording_id);
    if (!rec) throw notFound(`There is no recording ${body.recording_id}.`);
    const start = Number(body.start_s);
    const end = Number(body.end_s);
    if (!(start >= 0 && end > start && end <= rec.duration_s)) throw bad(`The segment must lie within the recording (0 to ${rec.duration_s.toFixed(1)} s) and end after it starts.`);
    if (!LABEL_NAMES.includes(body.correct_label)) throw bad('Choose the correct artifact type.');
    const accepted = [...new Set((body.accepted_labels || []).map(String))].filter((l) => l !== body.correct_label);
    for (const l of accepted) if (!LABEL_NAMES.includes(l)) throw bad(`${l} is not one of the artifact types.`);
    const items = set.quiz_items || [];
    let id = String(body.item_id || '').trim();
    for (let n = items.length + 1; !id || items.some((x) => x.item_id === id); n++) id = `q${String(n).padStart(2, '0')}`;
    const context = body.context_s === undefined || body.context_s === null ? 2.0 : Number(body.context_s);
    if (!(context >= 0 && context <= 60)) throw bad('The context shown around the segment is between 0 and 60 seconds.');
    const item = { item_id: id, recording_id: rec.recording_id, start_s: start, end_s: end, correct_label: body.correct_label,
      accepted_labels: accepted, explanation: String(body.explanation || ''), context_s: context };
    set.quiz_items = [...items, item];
    this._audit('quiz_item_add', `Added the quiz item ${id} to ${set.set_id}`, { set_id: set.set_id, item_id: id });
    return { item };
  }

  op_quiz_item_remove(body) {
    const set = this._setOr404(body.set_id);
    if (!(set.quiz_items || []).some((x) => x.item_id === body.item_id)) throw notFound(`There is no quiz item ${body.item_id}.`);
    set.quiz_items = set.quiz_items.filter((x) => x.item_id !== body.item_id);
    this._audit('quiz_item_remove', `Removed the quiz item ${body.item_id} from ${set.set_id}`, { set_id: set.set_id, item_id: body.item_id });
    return {};
  }

  // --------------------------------------------------------------- progress
  op_progress() {
    const items = this._items();
    return {
      study: this.s.name, generated_at: nowLocalIso(),
      annotators: this.s.users.map((u) => ({
        annotator_id: u.annotator_id, display_name: u.display_name, role: u.role, last_seen: u.last_seen || null,
        items: items.filter((i) => i.annotator_id === u.annotator_id).map(({ annotator_id, ...rest }) => rest), // eslint-disable-line no-unused-vars
        programme: u.programme === this.b._trainingSetId() ? this.b._trainingView(u.annotator_id) : null,
      })),
    };
  }

  // ---------------------------------------------------------------- records
  op_audit(body) {
    const limit = Math.max(1, Math.min(500, Number(body.limit) || 50));
    const all = this.s.audit;
    const end = body.before !== undefined && body.before !== null && body.before !== '' ? Math.max(0, Math.min(all.length, Number(body.before) || 0)) : all.length;
    const start = Math.max(0, end - limit);
    return { entries: all.slice(start, end).reverse(), next: start > 0 ? String(start) : null };
  }

  op_visits(body) {
    const limit = Math.max(1, Math.min(1000, Number(body.limit) || 100));
    const aid = body.annotator_id ? String(body.annotator_id).toUpperCase() : null;
    const live = this.b.visits;
    return {
      visits: [...this.s.visits].reverse().filter((v) => !aid || v.annotator_id === aid).slice(0, limit)
        .map((v) => ({ ...v, n_events: live.has(v.visit_id) ? live.get(v.visit_id).events.length : v.n_events })),
    };
  }
}
