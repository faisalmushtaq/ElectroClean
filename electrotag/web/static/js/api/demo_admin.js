// The admin area's operations in the sandbox (docs/web/api.md, "Administration"), carried out on
// the sandbox's own state in this browser, as electrotag/web/admin.py does them on a server: the
// study's settings, the accounts and their passwords and invitation links, assignments and the
// training programme, the register of recordings (the three built-in examples and any added from
// this computer as manifests), the training set's pass mark, matching, guidance and notes, problem
// reports and reviews (demo_feedback.js), progress, the audit log and the visits.
//
// What a visitor cannot use in a sandbox, or what needs ElectroTag's Python code (reference sets of
// one's own and their quizzes, the agreement and activity analyses, competency reports, the example
// set's files and the results zip), is answered with an error that says so, and how to try it with
// `electrotag-web demo`.

import { CATALOGUE, DEFAULT_ANNOTATION, DEFAULT_SETTINGS } from './demo_catalogue.js';
import { ApiError } from './http.js';
import { sha256Hex } from '../eeg/sha256.js';
import { newId, nowLocalIso } from '../util.js';
import { loadPart } from '../lazy.js';
import {
  checkAnnotatorId, checkEmail, criteriaFromRows, criteriaRows, deepCopy, mergeSettings,
  METRICS, parseRoles, plural, primaryRole, rolesOf, rolesText, settingChangeText, settingsProblems,
} from '../admin/model.js';

export const ADMIN_ID = 'ADMIN';
export const DEMO_LOGGING_NOTICE = 'This demonstration records how you use ElectroTag (times, clicks, keys and what is on ' +
  'screen) and keeps the record in this browser only, where the demonstration\'s experts can replay a session from it. ' +
  'It never records what you type, such as notes or passwords. ' +
  "In a real study the record goes to the study team, as the study's information sheet explains.";
const MANIFEST_SCHEMA = 'electrotag.web_manifest';
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const LABEL_NAMES = CATALOGUE.labels.map((l) => l.label);
const BUILT_IN_AT = '2026-10-28T09:00:00.000+00:00';

/** The answer to an operation the demonstration cannot run in the browser. */
export function needsServer(what) {
  return new ApiError(501, 'needs_server', `The demonstration cannot ${what} in the browser: that needs a study server or ` +
    'Firebase. To try it on this computer, install ElectroTag and run electrotag-web demo, then open ' +
    'http://localhost:8000/ and sign in as ADMIN with the password electrotag.');
}

const SERVER_ONLY = {
  agreement: 'run the agreement analysis',
  activity: 'run the activity analysis',
  competency: 'write competency reports',
  results_zip: 'put every result into one zip file',
  set_example_create: 'create the example training set (it already has one: the Demonstration training set)',
  set_create: 'create reference sets of your own (it has one: the Demonstration training set)',
  set_delete: 'delete reference sets',
  set_add_reference: 'add references to a reference set',
  set_remove_recording: 'take recordings out of a reference set',
  quiz_item_add: 'add segments to a quiz',
  quiz_item_remove: 'remove segments from a quiz',
  // Tasks (electrotag/web/tasks.py): the share-out, the windows, the letters and the known-answer scores are the
  // server's own code, and the sandbox's recordings are given to A01 whole.
  tasks_preview_get: 'work out a share-out of recordings among annotators (tasks)',
  tasks_create: 'share recordings out among annotators as tasks',
  tasks_list: 'list the tasks that share recordings out',
  task_update: 'change a task',
  task_remove: 'remove a task',
  quality_list: "measure annotators' accuracy on known answers",
  // Correct the marks (electrotag/web/correct_marks.py): exercises are made with the study's Python code; the
  // sandbox's ready-made one is in the expert area (demo_planted.js).
  set_planted_get: 'look at correct-the-marks exercises here (the expert area has the sandbox\'s ready-made one)',
  set_planted_make: 'make correct-the-marks exercises (the expert area has the sandbox\'s ready-made one to try)',
  set_planted_from: 'make correct-the-marks exercises (the expert area has the sandbox\'s ready-made one to try)',
  set_planted_remove: 'remove correct-the-marks exercises',
};

const bad = (message, code = 'bad_request', status = 400) => new ApiError(status, code, message);
// datasets, collections, groups, hand-outs, tracking (demo_library.js, loaded when used), and what they change
const LIBRARY_OP = /^(datasets?|collections?|groups?|handouts?|tracking)_|^(recordings_move|notify_preview_get)$/;
const LIBRARY_HOOK = /^(overview|recordings_(list|register)|recording_remove|user_remove)$/;
// How long an invitation link lasts unless the administrator chooses otherwise, and the longest allowed.
const INVITE_DAYS = 14;
const INVITE_MAX_DAYS = 90;
const DAY_MS = 86400000;
// stats: the days of the daily completions, the days whose pace projects the finish, and the
// fewest completions in them for a projection (electrotag/web/admin.py).
const STATS_DAYS = 30;
const PACE_DAYS = 14;
const PACE_MIN = 3;
/** The fewest days since the first completion before the pace projects a finish (admin.py PACE_MIN_DAYS). */
const PACE_MIN_DAYS = 3;
/** What a person is told when an invitation link cannot be used (electrotag/web/service.py, INVITE_PROBLEMS). */
const INVITE_PROBLEMS = {
  unknown: [404, 'This invitation link is not known to the study. It may have been replaced by a newer link or withdrawn. To get a new link, contact the study team who invited you, for example by replying to the email that brought you this one.'],
  used: [409, 'This invitation link has been used already. Sign in with your annotator ID and the password you chose, or ask the study team for a new link.'],
  expired: [409, 'This invitation link has expired. To get a new link, contact the study team who invited you, for example by replying to the email that brought you this one.'],
};
/** Why an administrator's account is not given an invitation link (electrotag/web/admin.py, ADMIN_NOT_INVITED). */
const ADMIN_NOT_INVITED = 'Invitation links are for annotators: a link sent by email must not open the admin area. Give an administrator a password instead (a temporary one, or one you choose).';
const inviteProblem = (reason) => new ApiError(INVITE_PROBLEMS[reason][0], `invite_${reason}`, INVITE_PROBLEMS[reason][1]);
/** The roles that can be given, those kept for later, and the IDs that are never accounts (electrotag/web/store.py). */
const GIVEN_ROLES = ['annotator', 'expert', 'admin'];
const RESERVED_ROLES = ['participant'];
const RESERVED_IDS = ['ADJUDICATED', 'REFERENCE'];

/**
 * The roles a request asks for, as admin.py roles_from: `roles` (a list), `role` (one, the older form) or both when
 * they agree; null when neither is given and none is required.
 */
export function rolesFrom(body, { required }) {
  const { role, roles } = body;
  const given = (v) => v !== undefined && v !== null;
  if (!given(role) && !given(roles)) return required ? ['annotator'] : null;
  let asked = [];
  if (given(roles)) {
    if (!Array.isArray(roles) || !roles.length || !roles.every((r) => typeof r === 'string')) {
      throw bad('roles must be a list of at least one role (annotator, expert, admin)');
    }
    asked = [...roles];
  }
  if (given(role)) {
    if (typeof role !== 'string') throw bad('role must be one of annotator, expert, admin');
    if (!asked.length) asked = [role];
  }
  for (const r of [...asked, ...(typeof role === 'string' ? [role] : [])]) {
    if (RESERVED_ROLES.includes(r)) throw bad(`The role '${r}' is kept for a later kind of study and cannot be given yet.`, 'role_not_offered');
    if (!GIVEN_ROLES.includes(r)) throw bad('role must be one of annotator, expert, admin');
  }
  const kept = parseRoles(asked);
  if (given(roles) && given(role) && role !== primaryRole(kept)) {
    throw bad(`role (${role}) and roles (${kept.join(', ')}) say different things: role is the first of the roles, in the order admin, expert, annotator; give roles alone`);
  }
  return kept;
}

/** A random invitation token (32 bytes, URL-safe base64), as the study server makes them. */
export function inviteToken() {
  const bytes = new Uint8Array(32);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const tokenHash = (token) => sha256Hex(new TextEncoder().encode(String(token)));

/** The local date (YYYY-MM-DD) at the start of a time stamp, as the study server reads it. */
const dayOf = (stamp) => (/^\d{4}-\d{2}-\d{2}/.test(String(stamp || '')) ? String(stamp).slice(0, 10) : null);

function medianOf(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function secondsOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const v = Number(value);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/** The local date `n` days after a YYYY-MM-DD date. */
function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return nowLocalIso(d).slice(0, 10);
}
const notFound = (message, code = 'not_found') => new ApiError(404, code, message);
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
  return sha256Hex(new TextEncoder().encode(`electrotag-demo:${salt}:${password}`));
}

/** The settings blocks that a study may change, with the sandbox's values (its recordings are chosen in order). */
export function defaultSettings() {
  return { ...deepCopy(DEFAULT_SETTINGS), selection: { strategy: 'manual', seed: null } };
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

/** The Manifest of docs/web/api.md from an internal one (electrotag/web/manifest.py, public_manifest). */
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
  if (m.schema !== MANIFEST_SCHEMA) return 'it is not an ElectroTag recording description (manifest)';
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
/** How the built-in training set's references were made (as electrotag/training/examples.py records them). */
export const EXAMPLE_PROVENANCE = Object.freeze({ method: 'single_expert', experts: ['EXAMPLE'], adjudicator: '', sources: [], placeholder: true,
  source: 'simulated recording; ground truth used as reference' });

/** The sandbox's built-in expert, who also annotates (added to a sandbox made before experts existed). */
export function builtInExpert() {
  return { annotator_id: 'E01', display_name: 'Demo expert', email: null, role: 'expert', roles: ['expert', 'annotator'], status: 'active',
    created_at: BUILT_IN_AT, last_seen: null, notes: '', programme: null, builtin: true };
}

/** The version of the sandbox's admin state: 2 since accounts hold a set of roles and the expert E01 exists. */
export const ADMIN_STATE_VERSION = 2;

/** A sandbox kept by an earlier version brought up to date: roles as sets, E01, and the newer settings blocks. */
export function upgradeAdminState(s) {
  if (!s || typeof s !== 'object') return s;
  for (const u of s.users || []) {
    if (!Array.isArray(u.roles) || !u.roles.length) u.roles = rolesOf(u);
    u.role = primaryRole(u.roles);
  }
  if ((s.version || 1) < 2 && !(s.users || []).some((u) => u.annotator_id === 'E01')) (s.users || (s.users = [])).push(builtInExpert());
  const defaults = defaultSettings();
  s.settings = s.settings || {};
  for (const [block, values] of Object.entries(defaults)) {
    if (!s.settings[block] || typeof s.settings[block] !== 'object') s.settings[block] = deepCopy(values);
  }
  s.version = ADMIN_STATE_VERSION;
  return s;
}

export function initialAdminState({ recordings, trainingSet }) {
  const user = (annotator_id, display_name, role, programme = null) => ({
    annotator_id, display_name, email: null, role, roles: [role], status: 'active', created_at: BUILT_IN_AT, last_seen: null, notes: '',
    programme, builtin: true,
  });
  const record = (scope, r) => ({
    scope, recording_id: r.recording_id, file_name: r.file_name, format: 'edf', sfreq: r.sfreq, n_samples: r.n_samples,
    duration_s: r.n_samples / r.sfreq, n_channels: r.n_channels, size_bytes: r.size_bytes, sha256: null,
    registered_at: BUILT_IN_AT, registered_by: 'command', registered_via: 'command', notes: '', retired: false,
    warnings: [], builtin: true,
  });
  const setRecords = [
    ...trainingSet.guided.map((g) => ({ recording_id: g.rid, use: 'guided', guidance: g.guidance })),
    ...trainingSet.practice.map((rid) => ({ recording_id: rid, use: 'practice', guidance: 'auto' })),
  ];
  return {
    version: ADMIN_STATE_VERSION,
    name: 'Demonstration',
    settings: defaultSettings(),
    logging_notice: DEMO_LOGGING_NOTICE,
    users: [
      user('A01', 'Demo annotator', 'annotator'),
      user('T01', 'Demo trainee', 'annotator', trainingSet.set_id),
      builtInExpert(),
      user(ADMIN_ID, 'Demo administrator', 'admin'),
    ],
    passwords: {},
    assignments: recordings.map((r) => ({ annotator_id: 'A01', recording_id: r.recording_id, mode: 'standard', context_id: '', at: BUILT_IN_AT })),
    recordings: [
      ...recordings.map((r) => record('study', r)),
      ...setRecords.map((s) => record(`set:${trainingSet.set_id}`, recordings.find((r) => r.recording_id === s.recording_id))),
    ],
    sets: [{
      set_id: trainingSet.set_id, name: trainingSet.name,
      description: 'Three simulated recordings with known artifacts: two to learn with the experts and one to practise on.',
      created_at: BUILT_IN_AT, created_by: 'demonstration', practice_review: true, allowed_annotators: [],
      practice_pass: { ...trainingSet.pass }, guided_tolerance: { seconds: 0.2, fraction: 0.2, channel_jaccard: 0.75, accepted_labels: {} },
      criteria: { criteria: [], min_reference_events: 3, categories: null },
      // as electrotag/training/examples.py describes the simulation's artifacts standing in for the experts'
      recordings: setRecords.map((s) => ({ ...s, provenance: { ...EXAMPLE_PROVENANCE, added_at: BUILT_IN_AT } })),
      provenance: { method: 'single_expert', experts: ['EXAMPLE'], notes: '' },
      quiz: { include_none_option: true, feedback: 'immediate' }, show_full_report_to_annotator: false,
      guided_notes: {},
    }],
    visits: [],
    audit: [],
  };
}

// --------------------------------------------------------------- the operations
export class DemoAdmin {
  /** @param backend the DemoBackend whose state, statuses and built-in recordings this works on */
  constructor(backend) {
    this.b = backend;
  }

  get s() {
    if (!this.b.state.admin) this.b.state.admin = initialAdminState(this.b._builtIn());
    else if (this.b.state.admin.version !== ADMIN_STATE_VERSION) upgradeAdminState(this.b.state.admin);
    return this.b.state.admin;
  }

  /** The active accounts, in the order of their IDs (as the server lists them). */
  get _people() { return this._accounts.filter((u) => u.status === 'active'); }

  /** Every account, switched off ones too, in the order of their IDs. */
  get _accounts() { return [...this.s.users].sort((x, y) => (x.annotator_id < y.annotator_id ? -1 : x.annotator_id > y.annotator_id ? 1 : 0)); }

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
      filters: Object.fromEntries(['highpass_enabled', 'highpass_hz', 'notch_enabled', 'notch_hz', 'notch_harmonics', 'locked'].map((k) => [k, st.filters[k]])),
      display: { duration_s: st.display.duration_s, n_channels: st.display.n_channels, scalings: { ...st.display.scalings },
        channel_colours: st.display.channel_colours },
      annotation: Object.fromEntries(['min_duration_samples', 'quick_labels', ...Object.keys(DEFAULT_ANNOTATION), 'allow_revisions', 'allow_reviews',
        'show_reviews_to_annotators'].map((k) => [k, deepCopy(st.annotation[k])])),
      gamification: { enabled: st.gamification.enabled !== false,
        leaderboard: st.gamification.enabled !== false && st.gamification.leaderboard !== false },
      review: { show_corrections_to_annotators: (st.review || {}).show_corrections_to_annotators !== false,
        show_outcomes_to_annotators: (st.review || {}).show_outcomes_to_annotators !== false },
      training: { skippable: [...((st.training || {}).skippable || [])], gate: (st.training || {}).gate || 'met' },
      replay: { enabled: (st.replay || {}).enabled !== false, trainees_watch_experts: (st.replay || {}).trainees_watch_experts !== false,
        trainees_see_crowd: (st.replay || {}).trainees_see_crowd === true },
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
    if (!u || !rolesOf(u).includes('admin') || u.status !== 'active') throw new ApiError(403, 'forbidden', 'Only study administrators can use the admin area');
    return aid;
  }

  _audit(op, summary, details = {}) {
    this.s.audit.push({ at: nowLocalIso(), by: this.b.annotatorId || 'unknown', op, summary, details });
    if (this.s.audit.length > 2000) this.s.audit.splice(0, this.s.audit.length - 2000);
  }

  _userOr404(aid) {
    const u = this.user(aid);
    if (!u) throw new ApiError(404, 'unknown_user', `${String(aid || '').toUpperCase() || '(none given)'} has no account in this study`);
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

  /** Every work item of every account (or one), with its status, as the backend sees them (admin.py _items_of). */
  _items(onlyAid = null) {
    const out = [];
    for (const u of this._accounts) {
      if (onlyAid && u.annotator_id !== onlyAid) continue;
      for (const i of this.b._workItems(u.annotator_id)) {
        const subs = this.b._attempts(i.key);
        const draft = i.status === 'in_progress' ? this.b.state.drafts[i.key] : null;
        const last = [...subs.map((x) => x.saved_at), draft ? draft.saved_at : ''].filter(Boolean).sort().pop() || null;
        // the latest attempt by its number; the time of every saved attempt together (a revision adds its own)
        const latest = subs.length ? subs[subs.length - 1] : null;
        const times = subs.map((x) => secondsOf((x.session || {}).elapsed_s)).filter((t) => t !== null);
        const elapsed = latest ? (times.length ? times.reduce((x, y) => x + y, 0) : null) : draft ? secondsOf(draft.elapsed_s) : null;
        out.push({ annotator_id: u.annotator_id, recording_id: i.rid, mode: i.mode, context_id: i.context_id,
          status: i.status, attempts: subs.length, last_activity: last, elapsed_s: elapsed,
          n_annotations: latest ? (latest.annotations || []).length : null, saved_at: latest ? latest.saved_at : null });
      }
    }
    return out;
  }

  _userRecord(u, items) {
    const mine = items.filter((i) => i.annotator_id === u.annotator_id);
    return { annotator_id: u.annotator_id, display_name: u.display_name || '', email: u.email || null, role: primaryRole(rolesOf(u)), roles: rolesOf(u), status: u.status,
      created_at: u.created_at, last_seen: u.last_seen || null, notes: u.notes || '', assigned: mine.length,
      done: mine.filter((i) => i.status === 'done').length, programme: u.programme || null,
      study_locked: false, // the sandbox's training set has no assessment, so nobody's study work waits for one
      invitation: this._invitationOut(u.annotator_id) };
  }

  // ------------------------------------------------------------- invitations
  // Kept as the study server keeps them (electrotag/web/accounts.py): one per account, its token
  // only as a SHA-256 hash with its expiry, ended when used, replaced, withdrawn or switched off.
  get _invites() {
    if (!this.s.invites || typeof this.s.invites !== 'object') this.s.invites = {};
    return this.s.invites;
  }

  _invitationOut(aid) {
    const inv = this._invites[aid];
    if (!inv) return { state: 'none', invited_at: null, expires_at: null, ended_at: null };
    const state = inv.state === 'invited' && inv.expires_ms < Date.now() ? 'expired' : inv.state;
    return { state, invited_at: inv.created_at, expires_at: inv.expires_at, ended_at: inv.ended_at || null };
  }

  _endInvitation(aid, state) {
    const inv = this._invites[aid];
    if (!inv || inv.state !== 'invited') return false;
    Object.assign(inv, { state, hash: '', ended_at: nowLocalIso() });
    return true;
  }

  _inviteDays(body) {
    if (body.expires_days === undefined || body.expires_days === null) return INVITE_DAYS;
    const d = Number(body.expires_days);
    if (!Number.isFinite(d) || d < 1 || d > INVITE_MAX_DAYS) throw bad(`expires_days must be from 1 to ${INVITE_MAX_DAYS}`);
    return d;
  }

  _makeInvitation(aid, days) {
    const u = this._userOr404(aid);
    if (u.status !== 'active') throw conflict('disabled', `${u.annotator_id} is switched off; switch the account on before inviting them`);
    const token = inviteToken();
    const expiresMs = Date.now() + days * DAY_MS;
    const expires = nowLocalIso(new Date(expiresMs));
    this._invites[u.annotator_id] = { hash: tokenHash(token), state: 'invited', created_at: nowLocalIso(), created_by: this.b.annotatorId || '',
      expires_at: expires, expires_ms: expiresMs, ended_at: null };
    return { invite_token: token, invite_link: null, expires_at: expires };
  }

  /** The invitation a token belongs to, with its account, or null (an account switched off has none). */
  _invitationOf(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const hash = tokenHash(token);
    for (const [aid, inv] of Object.entries(this._invites)) {
      // A used invitation keeps the hash of its token, so that the link can say it was used.
      if ((inv.hash && inv.hash === hash) || (inv.state === 'accepted' && inv.used_hash === hash)) {
        const u = this.user(aid);
        // an administrator by their roles or their primary role: either is enough to refuse the link
        return u && u.status === 'active' && !rolesOf(u).includes('admin') && u.role !== 'admin' ? { aid, inv, u } : null;
      }
    }
    return null;
  }

  /** POST /invite/check: whose invitation a link is, for the welcome card. */
  inviteCheck(token) {
    const found = this._invitationOf(token);
    if (!found) throw inviteProblem('unknown');
    const { aid, inv, u } = found;
    if (inv.state === 'accepted') throw inviteProblem('used');
    if (inv.state !== 'invited') throw inviteProblem('unknown');
    if (inv.expires_ms < Date.now()) throw inviteProblem('expired');
    return { annotator_id: aid, display_name: u.display_name || '', study_name: this.s.name, expires_at: inv.expires_at };
  }

  /** POST /invite/accept: the person's own password, set once; the invitation ends. */
  inviteAccept(token, password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw bad('Choose a password of at least 8 characters.', 'bad_password');
    this.inviteCheck(token);
    const { aid, inv, u } = this._invitationOf(token);
    const salt = newId().slice(0, 16);
    this.s.passwords[aid] = { salt, hash: passwordHash(password, salt) };
    Object.assign(inv, { state: 'accepted', used_hash: inv.hash, hash: '', ended_at: nowLocalIso() });
    this.b._save();
    return u;
  }

  async _recordingRecord(r, items) {
    if (r.builtin && !r.sha256) {
      try { r.sha256 = (await this.b.exampleRecording(r.recording_id).fingerprint()).hex; } catch { /* left empty */ }
    }
    const { manifest, builtin, ...rest } = r; // eslint-disable-line no-unused-vars
    if (r.scope === 'study') {
      const mine = items.filter((i) => i.recording_id === r.recording_id && i.mode === 'standard');
      return { ...rest, dataset_id: r.dataset_id || 'study-recordings', assigned: mine.length, done: mine.filter((i) => i.status === 'done').length };
    }
    // a training set's recording: given to everyone in its programme, at whatever stage (admin.py _counts)
    const ctx = r.scope.slice(4);
    const saved = new Set(this.b.state.submissions.filter((x) => x.recording_id === r.recording_id && x.context_id === ctx).map((x) => `${x.annotator_id}|${x.mode}`));
    return { ...rest, dataset_id: null, assigned: this.s.users.filter((u) => u.programme === ctx).length, done: saved.size };
  }

  _setRecord(set) {
    const guided = set.recordings.filter((r) => r.use === 'guided').map((r) => r.recording_id);
    const levels = ['show', 'find', 'find_unnamed'];
    const { guided_notes, recordings, ...rest } = set; // eslint-disable-line no-unused-vars
    return {
      ...deepCopy(rest),
      recordings: recordings.map((r) => ({
        recording_id: r.recording_id, use: r.use, guidance: r.guidance || 'auto',
        effective_guidance: r.use !== 'guided' ? null : levels.includes(r.guidance) ? r.guidance
          : levels[Math.min(Math.max(0, guided.indexOf(r.recording_id)), levels.length - 1)],
        provenance: deepCopy(r.provenance || {}), n_reference_events: this.b._truthOf(r.recording_id).length,
        registered: Boolean(this.record(`set:${set.set_id}`, r.recording_id)),
      })),
      quiz_items: this._quizItems(set).length, self_contained: true, scope: `set:${set.set_id}`,
    };
  }

  /** The quiz of a set: the sandbox's own quiz on its training set. */
  _quizItems(set) { return this.b._quizItemsOf(set.set_id); }

  // ------------------------------------------------------------------ dispatch
  async run(op, body = {}) {
    this._actor();
    const b = body && typeof body === 'object' ? body : {};
    if (SERVER_ONLY[op]) throw needsServer(SERVER_ONLY[op]);
    const fn = this[`op_${op}`];
    const lib = LIBRARY_OP.test(op) || (LIBRARY_HOOK.test(op) && (this.s.library || b.dataset_id != null));
    if (!lib && typeof fn !== 'function') throw notFound(`This server does not offer the administrative operation '${op}'`);
    const out = lib ? await (await this._library()).run(op, b) : await fn.call(this, b);
    this.b._save();
    return deepCopy(out);
  }

  async _library() {
    if (!this.library) this.library = new (await loadPart('demoLibrary')).DemoLibrary(this);
    return this.library;
  }

  // ------------------------------------------------------------------ overview
  op_overview() {
    const active = new Set(this._people.map((u) => u.annotator_id));
    const items = this._items().filter((i) => active.has(i.annotator_id));
    const subs = this.b.state.submissions;
    return {
      study: { study_id: 'demo', name: this.s.name },
      counts: {
        recordings: this.s.recordings.filter((r) => r.scope === 'study').length,
        annotators: this._people.filter((u) => rolesOf(u).includes('annotator')).length,
        experts: this._people.filter((u) => rolesOf(u).includes('expert')).length,
        admins: this._people.filter((u) => rolesOf(u).includes('admin')).length,
        assignments: items.length,
        done: items.filter((i) => i.status === 'done').length,
        in_progress: items.filter((i) => i.status === 'in_progress').length,
        todo: items.filter((i) => i.status === 'todo').length,
        unusable: items.filter((i) => i.status === 'unusable').length,
        ...this.b.feedback.counts(),
        overdue: 0,
        handouts_open: 0,
      },
      recent: [...this.s.audit].reverse().slice(0, 10),
      last_saved: [...subs].reverse().slice(0, 10).map((s) => ({ annotator_id: s.annotator_id, recording_id: s.recording_id, mode: s.mode,
        context_id: s.context_id || '', at: s.saved_at })),
    };
  }

  // ------------------------------------------------------------------ settings
  op_settings_get() {
    return { name: this.s.name, settings: deepCopy(this.s.settings), logging_notice: this.s.logging_notice,
      logging_notice_is_default: this.s.logging_notice === DEMO_LOGGING_NOTICE };
  }

  async op_settings_update(body) {
    const changed = [];
    if (body.settings !== undefined) {
      if (!body.settings || typeof body.settings !== 'object') throw bad('The settings must be given by block (filters, display, ...).', 'invalid_settings');
      const known = Object.keys(this.s.settings);
      const unknown = Object.keys(body.settings).find((k) => !known.includes(k));
      if (unknown) throw bad(`The settings block '${unknown}' cannot be changed here; these can: ${known.join(', ')}`, 'invalid_settings');
      const next = mergeSettings(this.s.settings, body.settings);
      const { expertSettingsProblems } = await loadPart('settingsChecks');
      const problems = [...settingsProblems(next, LABEL_NAMES), ...expertSettingsProblems(next)];
      if (problems.length) throw bad(problems[0], 'invalid_settings');
      for (const [block, values] of Object.entries(body.settings)) {
        for (const [key, value] of Object.entries(values || {})) {
          const old = (this.s.settings[block] || {})[key];
          if (JSON.stringify(old) !== JSON.stringify(value)) changed.push(settingChangeText(`${block}.${key}`, old, value));
        }
      }
      this.s.settings = next;
    }
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw bad('name is missing');
      if (name.length > 200) throw bad('name must be text of at most 200 characters');
      this.s.name = name;
      changed.push('the study\'s name');
    }
    if (body.logging_notice !== undefined) {
      this.s.logging_notice = String(body.logging_notice).slice(0, 4000);
      changed.push('the logging notice');
    }
    if (!changed.length && body.name === undefined && body.logging_notice === undefined && body.settings === undefined) {
      throw bad('Nothing to change: give name, settings or logging_notice');
    }
    this._audit('settings_update', `Changed ${changed.join('; ')}`, { changes: body.settings || {}, name: body.name ?? null });
    return this.op_settings_get();
  }

  // ------------------------------------------------------------------ accounts
  op_users_list() {
    const items = this._items();
    return { users: this._accounts.map((u) => this._userRecord(u, items)) };
  }

  op_user_add(body) {
    let id;
    let email;
    try { id = checkAnnotatorId(body.annotator_id); email = checkEmail(body.email); } catch (exc) { throw bad(exc.message); }
    const roles = rolesFrom(body, { required: true });
    if (RESERVED_IDS.includes(id)) {
      throw bad(`${id} is kept for ElectroTag's own versions (the adjudicated version and training references) and cannot be an account; choose another ID.`, 'reserved_id');
    }
    if (this.user(id)) throw conflict('user_exists', `${id} already has an account in this study.`);
    const role = primaryRole(roles);
    let temporary = null;
    let password = body.password ? String(body.password) : '';
    const invite = body.invite === true;
    if (invite && password) throw bad('Give a password or ask for an invitation link, not both');
    if (invite && roles.includes('admin')) throw conflict('admin_account', ADMIN_NOT_INVITED);
    const days = invite ? this._inviteDays(body) : INVITE_DAYS;
    if (password && (password.length < 8 || password.length > 200)) throw bad('A password must have 8 to 200 characters');
    // With an invitation nobody knows the first password: the person chooses their own.
    if (invite) password = inviteToken();
    else if (!password) { temporary = makePassword(); password = temporary; }
    const salt = newId().slice(0, 16);
    this.s.passwords[id] = { salt, hash: passwordHash(password, salt) };
    const u = { annotator_id: id, display_name: String(body.display_name || '').trim(), email, role, roles, status: 'active',
      created_at: nowLocalIso(), last_seen: null, notes: '', programme: null };
    this.s.users.push(u);
    const inv = invite ? this._makeInvitation(id, days) : null;
    this._audit('user_add', `Added ${id}${u.display_name ? ` (${u.display_name})` : ''} as ${rolesText(roles)}` +
      (inv ? ` with an invitation link (until ${inv.expires_at.slice(0, 10)})` : ''), { annotator_id: id, display_name: u.display_name, role, roles, email, invited: invite, expires_at: inv ? inv.expires_at : null });
    const out = { user: this._userRecord(u, this._items(id)), invite_link: null, temporary_password: temporary };
    if (inv) Object.assign(out, { invite_token: inv.invite_token, expires_at: inv.expires_at });
    return out;
  }

  op_user_invite(body) {
    const u = this._userOr404(body.annotator_id);
    if (rolesOf(u).includes('admin')) throw conflict('admin_account', ADMIN_NOT_INVITED);
    const inv = this._makeInvitation(u.annotator_id, this._inviteDays(body));
    this._audit('user_invite', `Made an invitation link for ${u.annotator_id} (until ${inv.expires_at.slice(0, 10)}); any earlier link stops working`,
      { annotator_id: u.annotator_id, expires_at: inv.expires_at });
    return { ...inv, invitation: this._invitationOut(u.annotator_id) };
  }

  op_user_invite_revoke(body) {
    const u = this._userOr404(body.annotator_id);
    if (!this._endInvitation(u.annotator_id, 'revoked')) throw conflict('no_invitation', `${u.annotator_id} has no invitation link that is still open.`);
    this._audit('user_invite_revoke', `Withdrew the invitation link of ${u.annotator_id}`, { annotator_id: u.annotator_id });
    return { invitation: this._invitationOut(u.annotator_id) };
  }

  op_user_update(body) {
    const u = this._userOr404(body.annotator_id);
    const { status } = body;
    const roles = rolesFrom(body, { required: false });
    if (status !== undefined && status !== null && !['active', 'disabled'].includes(status)) throw bad('status must be one of active, disabled');
    if (u.annotator_id === this.b.annotatorId && ((roles && !roles.includes('admin')) || status === 'disabled')) {
      throw conflict('self', 'You cannot take away your own administrator role or disable your own account; ask another administrator.');
    }
    const before = rolesOf(u);
    const newRoles = roles && roles.join(',') !== before.join(',') ? roles : null;
    const name = body.display_name === undefined || body.display_name === null ? null : String(body.display_name).trim();
    const notes = body.notes === undefined || body.notes === null ? null : String(body.notes).trim().slice(0, 5000);
    const said = [];
    if (newRoles) said.push(`made them ${rolesText(newRoles)}`);
    if (status && status !== u.status) said.push(status === 'disabled' ? 'disabled the account' : 'enabled the account');
    if (name !== null && name !== (u.display_name || '')) said.push(`renamed them '${name}'`);
    if (notes !== null && notes !== (u.notes || '')) said.push('changed the notes');
    // Nothing to change (an account switched off already, say): nothing is written or audited.
    if (!said.length) return { user: this._userRecord(u, this._items(u.annotator_id)), changed: false };
    if (newRoles) { u.roles = newRoles; u.role = primaryRole(newRoles); }
    if (status) u.status = status;
    if (name !== null) u.display_name = name;
    if (notes !== null) u.notes = notes;
    // An invitation is for annotators who may sign in: a link must not open the admin area, nor a switched-off account.
    if (rolesOf(u).includes('admin') || u.status === 'disabled') this._endInvitation(u.annotator_id, 'revoked');
    this._audit('user_update', `${u.annotator_id}: ${said.join(', ')}`, { annotator_id: u.annotator_id, display_name: name,
      role: newRoles ? primaryRole(newRoles) : null, roles: newRoles, status: status ?? null, notes });
    return { user: this._userRecord(u, this._items(u.annotator_id)), changed: true };
  }

  op_user_reset_password(body) {
    const u = this._userOr404(body.annotator_id);
    const temporary = makePassword();
    const salt = newId().slice(0, 16);
    this.s.passwords[u.annotator_id] = { salt, hash: passwordHash(temporary, salt) };
    this._endInvitation(u.annotator_id, 'revoked'); // the link would otherwise replace the new password
    this._audit('user_reset_password', `Gave ${u.annotator_id} a new temporary password`, { annotator_id: u.annotator_id });
    return { invite_link: null, temporary_password: temporary };
  }

  op_user_remove(body) {
    const u = this._userOr404(body.annotator_id);
    if (u.annotator_id === this.b.annotatorId) throw conflict('self', 'You cannot remove your own account; ask another administrator.');
    this.s.users = this.s.users.filter((x) => x !== u);
    this.s.assignments = this.s.assignments.filter((a) => a.annotator_id !== u.annotator_id);
    delete this.s.passwords[u.annotator_id];
    delete this._invites[u.annotator_id];
    for (const set of this.s.sets) set.allowed_annotators = set.allowed_annotators.filter((x) => x !== u.annotator_id);
    this._audit('user_remove', `Removed ${u.annotator_id} from the study (their results and logs stay)`, { annotator_id: u.annotator_id, display_name: u.display_name, role: u.role, roles: rolesOf(u) });
    return {};
  }

  // ---------------------------------------------------------------- assignments
  op_assignments_list(body) {
    const aid = body.annotator_id ? this._userOr404(body.annotator_id).annotator_id : null;
    return { items: this._items(aid) };
  }

  op_assign(body) {
    const ids = Array.isArray(body.annotator_ids) ? body.annotator_ids.map((x) => String(x).trim().toUpperCase()) : [];
    if (!ids.length) throw bad('annotator_ids must be a list of at least 1 ID(s)');
    if (new Set(ids).size !== ids.length) throw bad('annotator_ids names someone twice');
    ids.forEach((x) => this._userOr404(x));
    const mode = body.mode || 'standard';
    if (mode !== 'standard') {
      throw bad('In the demonstration, recordings are assigned for annotation; training recordings come with the training programme (choose it on the annotator\'s page).', 'demo_limit', 422);
    }
    const registered = this.s.recordings.filter((r) => r.scope === 'study');
    let wanted;
    if (body.all === true) wanted = registered.map((r) => r.recording_id).sort();
    else {
      wanted = body.recording_ids;
      if (!Array.isArray(wanted) || !wanted.length || wanted.some((r) => typeof r !== 'string')) throw bad('Give recording_ids (a list) or "all": true');
      const unknown = wanted.filter((rid) => !this.record('study', rid));
      if (unknown.length) throw new ApiError(404, 'unknown_recording', `Not registered here: ${unknown.slice(0, 10).join(', ')}`);
    }
    const retired = wanted.filter((rid) => this.record('study', rid).retired);
    wanted = wanted.filter((rid) => !retired.includes(rid));
    let added = 0;
    for (const aid of ids) {
      for (const rid of wanted) {
        if (this.s.assignments.some((a) => a.annotator_id === aid && a.recording_id === rid && a.mode === mode)) continue;
        this.s.assignments.push({ annotator_id: aid, recording_id: rid, mode, context_id: '', at: nowLocalIso() });
        added += 1;
      }
    }
    const already = wanted.length * ids.length - added;
    this._audit('assign', `Assigned ${plural(wanted.length, 'recording')} to ${ids.join(', ')} (Annotation): ${added} new`,
      { annotator_ids: ids, recording_ids: wanted, mode, context_id: '', added, already, retired });
    return { added, already, retired: retired.length };
  }

  op_unassign(body) {
    const aid = this._userOr404(body.annotator_id).annotator_id;
    const rid = body.recording_id;
    if (typeof rid !== 'string' || !rid) throw bad('recording_id is missing');
    const mode = body.mode || 'standard';
    const ctx = mode === 'standard' ? '' : body.context_id || '';
    const key = this.b._key(aid, rid, mode, ctx);
    if (this.b.state.done[key]) throw conflict('done', `${aid} has already saved ${rid}; a completed recording stays assigned.`);
    if (this.b.feedback.isUnusable(key)) {
      throw conflict('set_aside', `${aid} set ${rid} aside as a recording that cannot be annotated, so it stays with their work. Deal with their report in Problems: return the recording to ${aid}'s list, or give it to someone else.`);
    }
    const i = this.s.assignments.findIndex((a) => a.annotator_id === aid && a.recording_id === rid && a.mode === mode && (a.context_id || '') === ctx);
    if (i < 0) throw notFound(`${rid} is not assigned to ${aid} in that mode`, 'not_assigned');
    this.s.assignments.splice(i, 1);
    this.b.feedback.clearMark(aid, rid, mode, ctx); // set aside, then taken away: afresh if given back
    this._audit('unassign', `Took ${rid} away from ${aid}`, { annotator_id: aid, recording_id: rid, mode, context_id: ctx });
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
    this._audit('programme_set', `${u.annotator_id} ${sid ? `takes the training programme ${sid}` : 'no longer takes a training programme'}`, { annotator_id: u.annotator_id, set_id: sid });
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
    // A byte-identical copy of a registered recording is skipped unless the administrator confirms it (admin.py).
    const prints = new Map();
    for (const m of body.manifests) {
      const rid = m && typeof m.recording_id === 'string' ? m.recording_id : '(no ID)';
      const problem = manifestProblem(m);
      if (problem) { out.skipped.push({ recording_id: rid, reason: `It cannot be added: ${problem}.` }); continue; }
      const fp = m.fingerprint.eeg;
      const old = this.record(scope, rid);
      if (old && old.builtin) { out.skipped.push({ recording_id: rid, reason: 'It is one of the demonstration\'s built-in examples.' }); continue; }
      if (old && !body.replace) { out.skipped.push({ recording_id: rid, reason: 'It is registered already (choose Replace to update its description).' }); continue; }
      const print = `${String(fp.sha256).toLowerCase()}|${Number(fp.size)}`;
      if (body.allow_duplicates !== true) {
        const same = prints.get(print) || (this.s.recordings.find((r) => r.scope === scope && r.recording_id !== rid
          && `${String(r.sha256).toLowerCase()}|${Number(r.size_bytes)}` === print) || {}).recording_id;
        if (same) {
          out.skipped.push({ recording_id: rid, duplicate_of: same, reason: `The same file as ${same} (the same fingerprint), so it would be annotated twice under two IDs. Add it only if that is intended.` });
          continue;
        }
      }
      if (!prints.has(print)) prints.set(print, rid);
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
    const scope = body.scope || 'study';
    const r = this.record(scope, body.recording_id);
    if (!r) throw notFound(`${body.recording_id} is not registered in ${scope}`, 'unknown_recording');
    const notes = body.notes === undefined || body.notes === null ? null : String(body.notes).trim().slice(0, 5000);
    const retired = body.retired === undefined || body.retired === null ? null : Boolean(body.retired);
    const said = [];
    if (notes !== null && notes !== (r.notes || '')) { r.notes = notes; said.push('changed the notes'); }
    if (retired !== null && retired !== Boolean(r.retired)) {
      r.retired = retired;
      said.push(retired ? 'retired it (no new assignments)' : 'offered it for assignments again');
    }
    this._audit('recording_update', `${r.recording_id}: ${said.length ? said.join(', ') : 'no change'}`, { scope, recording_id: r.recording_id, notes, retired });
    return { recording: await this._recordingRecord(r, this._items()) };
  }

  op_recording_remove(body) {
    const scope = body.scope || 'study';
    const r = this.record(scope, body.recording_id);
    if (!r) throw notFound(`${body.recording_id} is not registered in ${scope}`, 'unknown_recording');
    if (r.builtin) throw conflict('has_results', 'The built-in example recordings stay in the demonstration (retire it instead, to offer it for no new assignments).');
    const ctx = scope === 'study' ? null : scope.slice(4);
    const saved = this.b.state.submissions.some((s) => s.recording_id === r.recording_id && (ctx === null ? s.mode === 'standard' : s.context_id === ctx));
    const usedBy = this.s.sets.filter((s) => (ctx === null ? false : s.set_id === ctx) && s.recordings.some((x) => x.recording_id === r.recording_id));
    if (saved || usedBy.length) {
      throw conflict('has_results', saved ? `Annotations of ${r.recording_id} have been saved, so it stays registered (retire it instead, to offer it for no new assignments).`
        : `The reference set ${usedBy[0].set_id} uses ${r.recording_id}; remove it from the set first.`);
    }
    this.s.recordings = this.s.recordings.filter((x) => x !== r);
    if (scope === 'study') this.s.assignments = this.s.assignments.filter((a) => a.recording_id !== r.recording_id);
    this._audit('recording_remove', `Removed ${r.recording_id} from ${scope}`, { scope, recording_id: r.recording_id });
    return {};
  }

  // ----------------------------------------------------------- reference sets
  op_sets_list() {
    return { sets: this.s.sets.map((s) => this._setRecord(s)) };
  }

  op_set_update(body) {
    const set = this._setOr404(body.set_id);
    const changes = [];
    const fraction = (v, what) => { const x = Number(v); if (!(x >= 0 && x <= 1)) throw bad(`${what} is between 0 and 100%.`); return x; };
    if (body.name !== undefined && body.name !== null) { set.name = String(body.name).trim(); changes.push('name'); }
    if (body.description !== undefined && body.description !== null) { set.description = String(body.description).trim(); changes.push('description'); }
    if (body.practice_review !== undefined && body.practice_review !== null) { set.practice_review = Boolean(body.practice_review); changes.push('practice review'); }
    if (body.allowed_annotators !== undefined) {
      if (!Array.isArray(body.allowed_annotators)) throw bad('The annotators allowed to use the set are a list of IDs.');
      set.allowed_annotators = [...new Set(body.allowed_annotators.map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
      changes.push('allowed annotators');
    }
    if (body.practice_pass !== undefined) {
      const p = body.practice_pass || {};
      set.practice_pass = { event_f1: fraction(p.event_f1, 'The share of artifacts found'), label_accuracy: fraction(p.label_accuracy, 'The share given the right type') };
      changes.push('practice pass mark');
    }
    if (body.guided_tolerance !== undefined) {
      const t = body.guided_tolerance || {};
      const seconds = Number(t.seconds);
      if (!(seconds >= 0 && seconds <= 5)) throw bad('The start and end of a guided step match within 0 to 5 seconds.');
      const cj = fraction(t.channel_jaccard, 'The channels that must be the same');
      if (cj <= 0) throw bad('At least some of the channels must be the same (more than 0%).');
      set.guided_tolerance = { seconds, fraction: fraction(t.fraction, 'The share of its length'), channel_jaccard: cj, accepted_labels: {} };
      changes.push('guided tolerance');
    }
    if (body.criteria !== undefined) {
      const c = body.criteria || {};
      for (const x of c.criteria || []) if (!METRICS[x.metric]) throw bad(`${x.metric} is not a competency measure.`);
      try {
        set.criteria = criteriaFromRows(criteriaRows(c), c.min_reference_events ?? 3, c.categories);
      } catch (exc) { throw bad(exc.message); }
      changes.push('competency criteria');
    }
    if (!changes.length) throw bad('Nothing to change');
    this._audit('set_update', `Changed the reference set ${set.set_id}: ${changes.join(', ')}`, { set_id: set.set_id, changes });
    return { set: this._setRecord(set) };
  }

  op_set_recording_update(body) {
    const set = this._setOr404(body.set_id);
    const r = set.recordings.find((x) => x.recording_id === body.recording_id);
    if (!r) throw notFound(`${body.recording_id} is not in the reference set ${set.set_id}`, 'not_in_set');
    const warnings = [];
    const changes = [];
    if (body.use !== undefined && body.use !== r.use) {
      throw bad('In the demonstration, the training set keeps its two recordings to learn with and one to practise on; a study server or Firebase lets you change how a recording is used.', 'demo_limit', 422);
    }
    if (body.guidance === undefined || body.guidance === null) throw bad('Nothing to change: give use or guidance');
    if (body.guidance === 'correct') throw needsServer('give trainees a correct-the-marks exercise (the expert area has one to try)');
    if (!['auto', 'show', 'find', 'find_unnamed'].includes(body.guidance)) throw bad('guidance must be one of auto, show, find, find_unnamed, correct');
    if (r.use !== 'guided') warnings.push('How much help a recording gives matters only for guided recordings.');
    r.guidance = body.guidance;
    changes.push(`guidance ${body.guidance}`);
    this._audit('set_recording_update', `${r.recording_id} in ${set.set_id}: ${changes.join(', ')}`, { set_id: set.set_id, recording_id: r.recording_id, use: null, guidance: body.guidance, warnings });
    return { set: this._setRecord(set), warnings };
  }

  op_set_guided_notes(body) {
    const set = this._setOr404(body.set_id);
    const r = set.recordings.find((x) => x.recording_id === body.recording_id);
    if (!r) throw notFound(`${body.recording_id} is not in the reference set ${set.set_id}`, 'not_in_set');
    const info = this.b._recordingInfo(r.recording_id);
    const sf = info ? info.sfreq : 1;
    return {
      notes: this.b._truthOf(r.recording_id).map((a) => ({
        annotation_id: a.annotation_id, label: a.label, onset_s: a.onset_sample / sf, offset_s: (a.onset_sample + a.duration_samples) / sf,
        note: (set.guided_notes || {})[a.annotation_id] ?? this.b._exampleNoteOf(r.recording_id, a),
      })),
    };
  }

  op_set_guided_note(body) {
    const set = this._setOr404(body.set_id);
    const known = set.recordings.some((r) => this.b._truthOf(r.recording_id).some((a) => a.annotation_id === body.annotation_id));
    if (!known) throw notFound(`No reference annotation '${body.annotation_id}' in reference set ${set.set_id}`, 'unknown_annotation');
    const text = String(body.text || '').trim().slice(0, 2000);
    set.guided_notes = { ...(set.guided_notes || {}), [body.annotation_id]: text };
    this._audit('set_guided_note', `${text ? 'Changed' : 'Removed'} the experts' note on annotation ${body.annotation_id} in ${set.set_id}`,
      { set_id: set.set_id, annotation_id: body.annotation_id, text });
    return {};
  }

  // ------------------------------------------------------------------- quiz
  op_quiz_items(body) {
    // the sandbox's quiz is on its guided recordings, whose use cannot change here: nothing is withheld (admin.py op_quiz_items)
    return { items: deepCopy(this._quizItems(this._setOr404(body.set_id))), withheld: [] };
  }

  // --------------------------------------------------------------- progress
  op_progress() {
    const items = this._items();
    return {
      study: this.s.name, generated_at: nowLocalIso(),
      annotators: this._people.map((u) => ({
        annotator_id: u.annotator_id, display_name: u.display_name, role: u.role, last_seen: u.last_seen || null,
        items: items.filter((i) => i.annotator_id === u.annotator_id).map((i) => ({ recording_id: i.recording_id, mode: i.mode,
          context_id: i.context_id, status: i.status, attempts: i.attempts, last_activity: i.last_activity })),
        programme: u.programme === this.b._trainingSetId() ? this.b._trainingView(u.annotator_id) : null,
      })),
    };
  }

  /** How far the study has got and how long the work takes (docs/web/api.md, `stats`; electrotag/web/admin.py). */
  op_stats(body) {
    const work = body.work || 'study';
    if (!['study', 'all'].includes(work)) throw bad("work must be 'study' (the study's own annotation) or 'all' (training too)");
    const counted = (mode) => work === 'all' || mode === 'standard';
    const scopeOf = (mode, ctx) => (mode === 'standard' || !ctx ? 'study' : `set:${ctx}`);
    const today = nowLocalIso().slice(0, 10);
    const days = Array.from({ length: STATS_DAYS }, (_, i) => addDays(today, i - STATS_DAYS + 1));
    const index = new Map(days.map((d, i) => [d, i]));
    // A recording saved more than once (a revision, a practice recording repeated) is one recording done, on
    // the day of its first save, with the annotations of its latest attempt and the time of all its attempts.
    const groups = new Map();
    for (const s of this.b.state.submissions.filter((x) => counted(x.mode))) {
      if (!groups.has(s.key)) groups.set(s.key, []);
      groups.get(s.key).push(s);
    }
    const subs = [...groups.values()].map((list) => {
      const sorted = [...list].sort((a, b) => a.attempt - b.attempt);
      const times = sorted.map((x) => secondsOf((x.session || {}).elapsed_s)).filter((t) => t !== null);
      const first = sorted[0];
      return { annotator_id: first.annotator_id, recording_id: first.recording_id, mode: first.mode, context_id: first.context_id,
        saved_at: first.saved_at, last_at: sorted[sorted.length - 1].saved_at, elapsed_s: times.length ? times.reduce((a, b) => a + b, 0) : null,
        n_annotations: (sorted[sorted.length - 1].annotations || []).length };
    });
    const daily = (rows) => {
      const out = new Array(STATS_DAYS).fill(0);
      for (const s of rows) { const i = index.get(dayOf(s.saved_at)); if (i !== undefined) out[i] += 1; }
      return out;
    };
    const since = (rows, n) => {
      const first = addDays(today, -(n - 1));
      return rows.filter((s) => { const d = dayOf(s.saved_at); return d && d >= first && d <= today; }).length;
    };
    const elapsedOf = (s) => s.elapsed_s;
    const items = this._items().filter((i) => counted(i.mode));
    const totals = { assigned: 0, done: 0, in_progress: 0, todo: 0, unusable: 0 };
    const recordings = new Map();
    let draftS = 0;
    const people = this._accounts.map((u) => {
      const aid = u.annotator_id;
      const active = u.status === 'active';
      const mine = items.filter((i) => i.annotator_id === aid);
      const saved = subs.filter((s) => s.annotator_id === aid);
      const counts = { done: 0, in_progress: 0, todo: 0, unusable: 0 };
      for (const i of mine) counts[i.status] = (counts[i.status] || 0) + 1;
      let inProgressS = 0;
      const last = [u.last_seen || '', ...this.s.visits.filter((v) => v.annotator_id === aid).map((v) => v.started_at || '')];
      for (const i of mine) {
        if (i.status === 'in_progress') {
          const d = this.b.state.drafts[this.b._key(aid, i.recording_id, i.mode, i.context_id)];
          if (d) { inProgressS += secondsOf(d.elapsed_s) || 0; last.push(d.saved_at || ''); }
        }
        if (active) {
          const scope = scopeOf(i.mode, i.context_id);
          const key = `${scope}|${i.recording_id}`;
          if (!recordings.has(key)) {
            const rec = this.record(scope, i.recording_id);
            recordings.set(key, { scope, recording_id: i.recording_id, file_name: rec ? rec.file_name : i.recording_id.split('/').pop(), assigned: 0, done: 0, in_progress: 0, unusable: 0 });
          }
          const r = recordings.get(key);
          r.assigned += 1;
          if (i.status === 'done' || i.status === 'in_progress' || i.status === 'unusable') r[i.status] += 1;
        }
      }
      if (active) {
        totals.assigned += mine.length;
        for (const k of ['done', 'in_progress', 'todo', 'unusable']) totals[k] += counts[k];
        draftS += inProgressS;
      }
      const times = saved.map(elapsedOf).filter((t) => t !== null);
      last.push(...saved.map((s) => s.last_at || ''));
      return {
        annotator_id: aid, display_name: u.display_name || '', role: u.role, status: u.status, assigned: mine.length, ...counts,
        share_done: mine.length ? counts.done / mine.length : null, time_s: times.reduce((a, b) => a + b, 0), in_progress_s: inProgressS,
        median_s: medianOf(times), median_annotations: medianOf(saved.map((s) => s.n_annotations)),
        last_active: last.filter(Boolean).sort().pop() || null, done_7d: since(saved, 7), daily: daily(saved),
      };
    });
    for (const r of recordings.values()) {
      const rows = subs.filter((s) => s.recording_id === r.recording_id && scopeOf(s.mode, s.context_id) === r.scope);
      const n = rows.map((s) => s.n_annotations);
      Object.assign(r, { median_s: medianOf(rows.map(elapsedOf).filter((t) => t !== null)), median_annotations: medianOf(n),
        min_annotations: n.length ? Math.min(...n) : null, max_annotations: n.length ? Math.max(...n) : null, saved: rows.length });
    }
    const times = subs.map(elapsedOf).filter((t) => t !== null);
    // A recording that cannot be annotated is finished for its annotator, but it is not done.
    const remaining = totals.assigned - totals.done - totals.unusable;
    // The pace of the last 14 days, or of the days since the first completion in a younger study.
    const savedDays = subs.map((s) => dayOf(s.saved_at)).filter((d) => d && d <= today).sort();
    const history = savedDays.length ? Math.round((Date.parse(`${today}T12:00:00`) - Date.parse(`${savedDays[0]}T12:00:00`)) / 86400000) + 1 : 0;
    const paceDays = Math.max(1, Math.min(PACE_DAYS, history));
    const recent = since(subs, paceDays);
    const pace = recent / paceDays;
    let projection = { status: 'not_enough', date: null };
    if (totals.assigned && !remaining) projection = { status: 'complete', date: null };
    else if (remaining && recent >= PACE_MIN && history < PACE_MIN_DAYS) projection = { status: 'not_enough', date: null, reason: 'too_early' };
    else if (remaining && recent >= PACE_MIN) projection = { status: 'projected', date: addDays(today, Math.ceil(remaining / pace)) };
    const m = medianOf(times);
    return {
      generated_at: nowLocalIso(), work, today, days,
      totals: { ...totals, share_done: totals.assigned ? totals.done / totals.assigned : null, remaining,
        annotator_hours: (times.reduce((a, b) => a + b, 0) + draftS) / 3600, median_minutes: m === null ? null : m / 60,
        done_7d: since(subs, 7), done_30d: since(subs, 30), pace_per_day: pace, pace_days: paceDays, projection, ...this.b.feedback.counts() },
      daily: daily(subs),
      annotators: people,
      recordings: [...recordings.values()].sort((a, b) => (a.scope !== 'study') - (b.scope !== 'study') || a.scope.localeCompare(b.scope) || a.recording_id.localeCompare(b.recording_id)),
    };
  }

  // ----------------------------------------------- problem reports and reviews (demo_feedback.js)
  op_problems_list(body) { return this.b.feedback.op_problems_list(body); }

  op_problem_resolve(body) { return this.b.feedback.op_problem_resolve(body); }

  op_problem_return(body) { return this.b.feedback.op_problem_return(body); }

  op_problem_reassign(body) { return this.b.feedback.op_problem_reassign(body); }

  op_saved_attempt_get(body) { return this.b.feedback.op_saved_attempt_get(body); }

  op_review_save(body) { return this.b.feedback.op_review_save(body); }

  op_reviews_list(body) { return this.b.feedback.op_reviews_list(body); }

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
