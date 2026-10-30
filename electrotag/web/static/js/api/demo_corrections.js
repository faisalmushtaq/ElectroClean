// Corrections of saved work and replays of sessions in the sandbox (docs/web/api.md, "Corrections and
// replay"), as electrotag/web/corrections.py and replay.py do them on a server: the same operations,
// answers and errors, with the corrections kept in this browser beside the sandbox's other records
// (state.corrections) and the replays read from the visits it keeps in memory for the page's life
// (backend.visits). The difference between versions is js/expert/diff.js, the server's own function.

import { ApiError } from './http.js';
import { rolesOf } from '../admin/model.js';
import { nowLocalIso } from '../util.js';
import { REASONS, changeCounts, countsText, diffAnnotations, needsReason } from '../expert/diff.js';

const ID_RE = /^[0-9a-f]{32}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const VISIT_RE = /^[0-9a-f]{32}$/;
const MAX_NOTE = 300;
const MAX_OVERALL_NOTE = 1000;
const MAX_ELAPSED_S = 7 * 24 * 3600;
const MAX_PAGE = 10000;
const OUTCOMES = { finished: 'finished', closed_without_saving: 'closed_without_saving', '': 'not_finished' };

const bad = (message, code = 'bad_request', status = 400, body = null) => new ApiError(status, code, message, body ? { error: code, message, ...body } : null);
const copy = (v) => JSON.parse(JSON.stringify(v));
const aidOf = (v, what = 'annotator_id') => {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${what} is missing`);
  return v.trim().toUpperCase();
};
const ridOf = (v) => {
  if (typeof v !== 'string' || !v || v.length > 512) throw bad('recording_id is missing');
  return v;
};
const whole = (v, what) => {
  if (!Number.isInteger(v)) throw bad(`${what} must be a whole number`);
  return v;
};

/** A time an offset from another, as Python's isoformat(timespec="milliseconds") writes it. */
function when(startedAt, offsetS) {
  const d = new Date(startedAt);
  if (Number.isNaN(d.getTime())) return null;
  return nowLocalIso(new Date(d.getTime() + Math.round((Number(offsetS) || 0) * 1000)));
}

/** The visit index of a visit's events (electrotag/web/store.py index_rows). */
export function indexRows(events, contextId = '') {
  const out = [];
  for (const e of [...events].sort((a, b) => (a.seq || 0) - (b.seq || 0))) {
    const seq = Number(e.seq) || 0;
    const t = Number(e.t) || 0;
    if (e.type === 'recording_opened') {
      const mode = String(e.mode || 'standard');
      out.push({ window_no: Number.isInteger(e.window_no) ? e.window_no : null, recording_id: String(e.recording || e.recording_id || ''),
        session_id: String(e.session_id || ''), mode, context_id: mode !== 'standard' ? contextId : '', first_seq: seq, last_seq: null,
        opened_t: t, ended_t: null, outcome: '' });
    } else if (e.type === 'recording_finished' || e.type === 'closed_without_saving') {
      const win = e.window_no;
      const open = out.filter((r) => r.last_seq === null && (win === undefined || win === null || r.window_no === win || r.window_no === null));
      if (open.length) Object.assign(open[open.length - 1], { last_seq: seq, ended_t: t, outcome: e.type === 'recording_finished' ? 'finished' : 'closed_without_saving' });
    } else if (e.type === 'log_closed') {
      for (const r of out) if (r.last_seq === null) Object.assign(r, { last_seq: seq, ended_t: t });
    }
  }
  return out;
}

class Corrections {
  constructor(x) {
    this.x = x;
    this.b = x.b;
  }

  get state() {
    if (!Array.isArray(this.b.state.corrections)) this.b.state.corrections = [];
    return this.b.state.corrections;
  }

  get settings() { return this.b._admin.s.settings; }

  get review() { return { corrections: true, show_corrections_to_annotators: true, reason_required: 'always', ...(this.settings.review || {}) }; }

  get replay() { return { enabled: true, trainees_watch_experts: true, ...(this.settings.replay || {}) }; }

  user() { const u = this.b._account(); return { aid: this.b._aid(), name: (u && u.display_name) || '', expert: Boolean(u && (rolesOf(u).includes('expert') || rolesOf(u).includes('admin'))) }; }

  displayName(aid) { const u = this.b._admin.user(aid); return (u && u.display_name) || ''; }

  /** The saved study attempts of a person and recording, oldest first. */
  entries(aid, rid) { return this.b._attempts(this.b._key(aid, rid, 'standard', '')); }

  async target(body) {
    const aid = aidOf(body.annotator_id);
    const rid = ridOf(body.recording_id);
    if ((body.mode || 'standard') !== 'standard') throw bad('Corrections are for the study\'s own recordings; training recordings have their own feedback.', 'not_for_training', 409);
    const info = this.b._recordingInfo(rid);
    if (!info) throw bad(`${rid} is not a registered recording of this study`, 'unknown_recording', 404);
    return { aid, rid, info };
  }

  savedAttempt(aid, rid, attempt) {
    const list = this.entries(aid, rid);
    const entry = attempt !== null && attempt !== undefined ? list.find((s) => s.attempt === attempt) : list[list.length - 1];
    if (!entry) {
      throw bad(`${aid} has not saved ${rid}${attempt !== null && attempt !== undefined && list.length ? ` as version ${attempt}` : ''}, so there is nothing to correct.`, 'no_saved_annotations', 404);
    }
    return entry;
  }

  wire(list) {
    return (list || []).map((a) => ({ annotation_id: a.annotation_id, label: a.label, onset_sample: a.onset_sample, duration_samples: a.duration_samples,
      channels: [...(a.channels || [])], created_at: a.created_at || '', modified_at: a.modified_at || '', confidence: a.confidence ?? null, note: a.note || '' }))
      .sort((x, y) => x.onset_sample - y.onset_sample || (x.onset_sample + x.duration_samples) - (y.onset_sample + y.duration_samples) || x.label.localeCompare(y.label) || (x.annotation_id < y.annotation_id ? -1 : 1));
  }

  saved(aid = null) { return this.state.filter((r) => r.state === 'saved' && (!aid || r.annotator_id === aid)); }

  /** corrections.py corrections_of. */
  correctionsOf(aid, rid, attempt = null, latestPerCorrector = true) {
    const rows = this.saved(aid).filter((r) => r.recording_id === rid && (attempt === null || r.corrected_from.attempt === attempt))
      .sort((x, y) => String(x.corrected_at).localeCompare(String(y.corrected_at)) || x.number - y.number);
    if (!latestPerCorrector) return rows;
    const latest = new Map();
    for (const r of rows) latest.set(`${r.corrected_from.attempt}|${r.corrector_id}`, r);
    return rows.filter((r) => latest.get(`${r.corrected_from.attempt}|${r.corrector_id}`) === r);
  }

  out(rec, { forAnnotator = false } = {}) {
    const keys = ['correction_id', 'state', 'annotator_id', 'recording_id', 'file_name', 'mode', 'context_id', 'corrected_from', 'corrector_id', 'corrector_name',
      'corrected_at', 'elapsed_s', 'number', 'output_basename', 'session_id', 'changes', 'counts', 'overall_note'];
    const out = Object.fromEntries(keys.map((k) => [k, copy(rec[k] ?? null)]));
    out.summary = countsText(rec.counts || {});
    const same = this.correctionsOf(rec.annotator_id, rec.recording_id, rec.corrected_from.attempt);
    out.n_corrections_of_version = same.length;
    out.attempt = rec.corrected_from.attempt;
    if (forAnnotator) {
      for (const k of ['output_basename', 'session_id', 'state', 'elapsed_s']) delete out[k];
      out.corrected_from = { attempt: rec.corrected_from.attempt };
    }
    return out;
  }

  withText(changes) { return copy(changes || []).map((c) => ({ ...c, reason_text: REASONS[c.reason] || '' })); }

  async withVersions(rec, forAnnotator) {
    const sub = this.savedAttempt(rec.annotator_id, rec.recording_id, rec.corrected_from.attempt);
    const out = this.out(rec, { forAnnotator });
    out.changes = this.withText(rec.changes);
    out.annotations = this.wire(rec.annotations);
    out.original = this.wire(sub.annotations);
    out.manifest = await this.b._publicManifest(rec.recording_id);
    return out;
  }

  one(cid) {
    if (typeof cid !== 'string' || !ID_RE.test(cid)) throw bad('correction_id must be 32 hexadecimal characters');
    const rec = this.saved().find((r) => r.correction_id === cid);
    if (!rec) throw bad('This correction was not found in the study.', 'not_found', 404);
    return rec;
  }

  // ------------------------------------------------------------------ operations
  async work_list(body) {
    const me = this.user();
    const aid = body.annotator_id !== undefined && body.annotator_id !== null && body.annotator_id !== '' ? aidOf(body.annotator_id) : null;
    const rid = body.recording_id || null;
    if (rid !== null && typeof rid !== 'string') throw bad('recording_id must be a recording ID');
    if (body.corrected !== undefined && body.corrected !== null && typeof body.corrected !== 'boolean') throw bad('corrected must be true or false');
    const limit = body.limit === undefined ? 200 : body.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw bad('limit must be a whole number from 1 to 1000');
    const latest = new Map();
    for (const s of this.b.state.submissions) {
      if (s.mode !== 'standard' || (aid && s.annotator_id !== aid) || (rid && s.recording_id !== rid)) continue;
      const k = `${s.annotator_id}|${s.recording_id}`;
      if (!latest.has(k) || latest.get(k).attempt < s.attempt) latest.set(k, s);
    }
    const items = [];
    for (const s of latest.values()) {
      const n = this.saved(s.annotator_id).filter((r) => r.recording_id === s.recording_id && r.corrected_from.attempt === s.attempt).length;
      if (typeof body.corrected === 'boolean' && (n > 0) !== body.corrected) continue;
      const info = this.b._recordingInfo(s.recording_id);
      if (!info) continue;
      items.push({ annotator_id: s.annotator_id, display_name: this.displayName(s.annotator_id), recording_id: s.recording_id, file_name: info.file_name,
        attempt: s.attempt, saved_at: s.saved_at || null, n_annotations: s.annotations.length, corrections: n, task_id: null, own: s.annotator_id === me.aid });
    }
    items.sort((x, y) => String(y.saved_at || '').localeCompare(String(x.saved_at || '')) || y.annotator_id.localeCompare(x.annotator_id) || y.recording_id.localeCompare(x.recording_id));
    return { items: items.slice(0, limit), total: items.length, corrections_on: this.review.corrections !== false };
  }

  async saved_attempt_get(body) {
    const me = this.user();
    const { aid, rid, info } = await this.target(body);
    const attempt = body.attempt === undefined || body.attempt === null ? null : whole(body.attempt, 'attempt');
    const entry = this.savedAttempt(aid, rid, attempt);
    const list = this.entries(aid, rid);
    const fb = this.b.feedback;
    return { annotator_id: aid, display_name: this.displayName(aid), recording_id: rid, file_name: info.file_name, mode: 'standard', context_id: '',
      attempt: entry.attempt, latest: list[list.length - 1].attempt, attempts: list.map((s) => s.attempt), saved_at: entry.saved_at || null,
      manifest: await this.b._publicManifest(rid), annotations: this.wire(entry.annotations),
      reviews: fb._reviews(aid, rid).filter((r) => r.attempt === entry.attempt).map((r) => fb.reviewOut(r)),
      corrections: this.correctionsOf(aid, rid, entry.attempt, false).map((r) => this.out(r)),
      own: aid === me.aid, corrections_on: this.review.corrections !== false, reason_required: this.review.reason_required, reasons: { ...REASONS } };
  }

  async correction_save(body) {
    const me = this.user();
    const cid = body.correction_id;
    if (typeof cid !== 'string' || !ID_RE.test(cid)) throw bad('correction_id must be 32 hexadecimal characters (made by the browser for this correction)');
    const kept = this.state.find((r) => r.correction_id === cid);
    if (kept && kept.state === 'saved') {
      if (kept.corrector_id !== me.aid) throw bad('This correction could not be kept. Please try again.', 'conflict', 409);
      return { correction: this.out(kept), already: true, files: [...(kept.files || [])] };
    }
    const review = this.review;
    if (review.corrections === false) throw bad('This study does not take corrections of saved work. The study team can switch them on in the study settings.', 'corrections_off', 409);
    const { aid, rid, info } = await this.target(body);
    if (aid === me.aid) throw bad('This is your own saved work. To change it, revise it from your history on the home page; corrections are for other people\'s work.', 'own_work', 409);
    const attempt = whole(body.attempt, 'attempt (the version corrected)');
    const list = this.entries(aid, rid);
    if (!list.length) throw bad(`${aid} has not saved ${rid}, so there is nothing to correct.`, 'no_saved_annotations', 404);
    const latest = list[list.length - 1].attempt;
    if (attempt !== latest) {
      throw bad(`${aid} has saved ${rid} again since you opened it (version ${latest}). Open it again to correct the latest version; your changes to version ${attempt} were not saved.`, 'not_latest', 409);
    }
    const entry = this.savedAttempt(aid, rid, attempt);
    if (!SHA_RE.test(String(body.sha256 || '').toLowerCase())) throw bad('sha256 (the checksum of the file the correction was made on) is missing');
    const session = body.session && typeof body.session === 'object' ? body.session : {};
    const elapsed = session.elapsed_s === undefined ? 0 : session.elapsed_s;
    if (typeof elapsed !== 'number' || !Number.isFinite(elapsed)) throw bad('session.elapsed_s must be a number', 'invalid_session', 422);
    if (elapsed < 0) throw bad('session.elapsed_s must be at least 0', 'invalid_session', 422);
    const annotations = this.b._validate(body.annotations, info);
    const changes = diffAnnotations(entry.annotations, annotations);
    if (!changes.length) throw bad('Nothing has changed from the saved version, so there is no correction to save. Change, add or remove a mark first.', 'no_changes', 422);
    const given = {};
    const raw = body.changes === undefined || body.changes === null ? [] : body.changes;
    if (!Array.isArray(raw) || raw.length > 20000) throw bad('changes must be a list of {annotation_id, reason, note}');
    raw.forEach((c, n) => {
      const i = n + 1;
      if (!c || typeof c !== 'object' || typeof c.annotation_id !== 'string') throw bad(`Change ${i} must name its annotation_id`);
      const reason = c.reason === undefined || c.reason === null ? '' : c.reason;
      if (reason !== '' && !Object.hasOwn(REASONS, reason)) throw bad(`Change ${i}: the reason must be one of ${Object.keys(REASONS).join(', ')}`);
      const note = c.note === undefined || c.note === null ? '' : c.note;
      if (typeof note !== 'string' || note.length > MAX_NOTE) throw bad(`Change ${i}: the note must be text of at most ${MAX_NOTE} characters`);
      given[c.annotation_id] = { reason, note: note.trim() };
    });
    const missing = changes.filter((c) => needsReason(c.change, review.reason_required) && !(given[c.annotation_id] || {}).reason).map((c) => c.annotation_id);
    if (missing.length) {
      throw bad(`Give a reason for each change: ${missing.length} ${missing.length === 1 ? 'change has' : 'changes have'} none yet.`, 'reason_missing', 422, { annotation_ids: missing });
    }
    for (const c of changes) Object.assign(c, { reason: (given[c.annotation_id] || {}).reason || '', note: (given[c.annotation_id] || {}).note || '' });
    const overall = body.overall_note === undefined || body.overall_note === null ? '' : body.overall_note;
    if (typeof overall !== 'string' || overall.length > MAX_OVERALL_NOTE) throw bad(`overall_note must be text of at most ${MAX_OVERALL_NOTE} characters`);
    const counts = changeCounts(changes);
    const earlier = this.correctionsOf(aid, rid, attempt);
    const number = this.saved(aid).filter((r) => r.recording_id === rid).length + 1;
    const base = `${info.stem}_annotator-${aid}${number > 1 ? `_attempt-${String(number).padStart(2, '0')}` : ''}`;
    const files = ['annotations.json', 'events.json', 'events.tsv', 'session.json', 'time_viewed.txt'].map((f) => `${base}_${f}`);
    const rec = {
      schema: 'electrotag.correction', schema_version: 1, correction_id: cid, state: 'saved', annotator_id: aid, recording_id: rid, file_name: info.file_name,
      mode: 'standard', context_id: '',
      corrected_from: { annotator_id: aid, attempt, session_id: (entry.session && entry.session.session_id) || '', output_basename: this.b._outputBasename(info, aid, attempt),
        annotations_sha256: '' }, // the server's checksum of the saved _annotations.json, which the sandbox does not write
      corrector_id: me.aid, corrector_name: me.name, corrected_at: nowLocalIso(), elapsed_s: Math.round(Math.min(elapsed, MAX_ELAPSED_S) * 1000) / 1000,
      number, output_basename: base, session_id: cid, changes, counts, overall_note: overall.trim(), files,
      earlier_corrections: earlier.map((r) => r.correction_id), annotations: annotations.map((a) => ({ ...a, channels: [...a.channels] })),
    };
    this.state.push(rec);
    const others = [...new Set(earlier.map((r) => r.corrector_id))].filter((x) => x !== me.aid).sort();
    this.b._admin._audit('correction_save', `Corrected ${aid}'s ${rid} (version ${attempt}): ${countsText(counts)}`
      + (others.length ? `; it was corrected by ${others.join(', ')} as well, so the corrections go to adjudication` : ''),
    { correction_id: cid, annotator_id: aid, recording_id: rid, attempt, number, counts, n_changes: changes.length,
      reasons: Object.fromEntries(Object.keys(REASONS).map((k) => [k, changes.filter((c) => c.reason === k).length])),
      overall_note_length: rec.overall_note.length, other_correctors: others });
    this.b._save();
    return { correction: this.out(rec), already: false, files };
  }

  async corrections_list(body) {
    const aid = body.annotator_id !== undefined && body.annotator_id !== null && body.annotator_id !== '' ? aidOf(body.annotator_id) : null;
    const by = body.corrector_id !== undefined && body.corrector_id !== null && body.corrector_id !== '' ? aidOf(body.corrector_id, 'corrector_id') : null;
    const rid = body.recording_id || null;
    const rows = this.saved(aid).filter((r) => (!rid || r.recording_id === rid) && (!by || r.corrector_id === by))
      .sort((x, y) => String(y.corrected_at).localeCompare(String(x.corrected_at)));
    return { corrections: rows.map((r) => this.out(r)) };
  }

  async correction_get(body) { return this.withVersions(this.one(body.correction_id), false); }

  async my_correction_get(body) {
    const me = this.user();
    if (this.review.show_corrections_to_annotators === false) throw bad('This study does not show corrections to its annotators.', 'forbidden', 403);
    const rec = this.one(body.correction_id);
    if (rec.annotator_id !== me.aid) throw bad('This correction was not found in the study.', 'not_found', 404);
    return this.withVersions(rec, true);
  }

  /** GET /me/feedback's corrections (corrections.py mine). */
  mine() {
    const aid = this.b._aid();
    const latest = new Map();
    for (const s of this.b.state.submissions) if (s.annotator_id === aid && s.mode === 'standard') latest.set(s.recording_id, Math.max(latest.get(s.recording_id) || 0, s.attempt));
    return this.saved(aid).sort((x, y) => String(y.corrected_at).localeCompare(String(x.corrected_at))).map((r) => {
      const item = this.out(r, { forAnnotator: true });
      item.changes = this.withText(r.changes);
      item.of_latest = item.attempt === (latest.get(r.recording_id) || 0);
      return item;
    });
  }

  // ------------------------------------------------------------------ replays
  isExpertAccount(aid) {
    const u = this.b._admin.user(aid);
    return Boolean(u && u.status === 'active' && (rolesOf(u).includes('expert') || rolesOf(u).includes('admin')));
  }

  consents(aid) {
    const rec = ((this.b.state.records || {})[aid] || {}).replay_consent;
    return Boolean(rec && rec.teaching === true);
  }

  mayReplay(aid) {
    const me = this.user();
    const r = this.replay;
    if (me.expert) {
      if (r.enabled === false) throw bad('This study does not replay sessions at the moment. The study team can switch replays on in the study settings.', 'replays_off', 409);
      return;
    }
    if (!(r.enabled !== false && r.trainees_watch_experts !== false)) throw bad('This study does not show experts\' sessions to trainees at the moment.', 'forbidden', 403);
    if (!this.isExpertAccount(aid) || !this.consents(aid)) {
      throw bad('You can watch the sessions of experts who have agreed to it for teaching; this one is not among them.', 'forbidden', 403);
    }
  }

  visitsOf(aid) {
    return [...this.b.visits.entries()].filter(([, v]) => v.header.annotator_id === aid)
      .sort((x, y) => String(x[1].header.started_at).localeCompare(String(y[1].header.started_at)));
  }

  segments(aid, rid, mode = 'standard', ctx = '') {
    const out = [];
    for (const [vid, v] of this.visitsOf(aid)) {
      for (const row of indexRows(v.events, v.header.context_id || '')) {
        if (row.recording_id !== rid || (row.mode || 'standard') !== mode) continue;
        if (mode !== 'standard' && row.context_id !== ctx) continue;
        const last = row.last_seq;
        out.push({ visit_id: vid, window_no: row.window_no, session_id: row.session_id, started_at: when(v.header.started_at, row.opened_t),
          ended_at: row.ended_t !== null ? when(v.header.started_at, row.ended_t) : null, outcome: OUTCOMES[row.outcome] || 'not_finished', attempt: null,
          first_seq: row.first_seq, last_seq: last, n_events: (last !== null ? last : v.events.length) - row.first_seq + 1,
          has_snapshot: v.events.filter((e) => e.seq >= row.first_seq).slice(0, 6).some((e) => e.type === 'annotations_snapshot') });
      }
    }
    const entries = this.b._attempts(this.b._key(aid, rid, mode, ctx));
    const bySession = new Map(entries.filter((s) => s.session && s.session.session_id).map((s) => [String(s.session.session_id), s.attempt]));
    const claimed = new Set();
    for (const s of out) if (s.outcome === 'finished' && bySession.has(s.session_id)) { s.attempt = bySession.get(s.session_id); claimed.add(s.attempt); }
    const free = entries.map((s) => s.attempt).filter((a) => !claimed.has(a));
    for (const s of out) if (s.outcome === 'finished' && s.attempt === null && free.length) s.attempt = free.shift();
    return out;
  }

  async replay_index_get(body) {
    const aid = aidOf(body.annotator_id);
    const rid = ridOf(body.recording_id);
    const mode = body.mode || 'standard';
    if (!['standard', 'guided', 'practice', 'assessment'].includes(mode)) throw bad('mode must be one of standard, guided, practice, assessment');
    const ctx = mode !== 'standard' ? String(body.context_id || '') : '';
    this.mayReplay(aid);
    const info = this.b._recordingInfo(rid);
    if (!info) throw bad(`${rid} is not a registered recording of this study`, 'unknown_recording', 404);
    const segs = this.segments(aid, rid, mode, ctx);
    if (body.attempt !== undefined && body.attempt !== null && !Number.isInteger(body.attempt)) throw bad('attempt must be the version to compare with (a whole number)');
    let saved = null;
    if (mode === 'standard') {
      const list = this.entries(aid, rid);
      const entry = body.attempt !== undefined && body.attempt !== null ? list.find((s) => s.attempt === body.attempt) : list[list.length - 1];
      if (entry) saved = { attempt: entry.attempt, saved_at: entry.saved_at || null, annotations: this.wire(entry.annotations) };
    }
    return { logging: this.settings.logging.interactions !== false, annotator_id: aid, display_name: this.displayName(aid), recording_id: rid, mode, context_id: ctx,
      file_name: info.file_name, manifest: await this.b._publicManifest(rid), segments: segs, saved };
  }

  async replay_events_get(body) {
    const vid = body.visit_id;
    if (typeof vid !== 'string' || !VISIT_RE.test(vid)) throw bad('visit_id is missing or not valid');
    const v = this.b.visits.get(vid);
    if (!v) throw bad('This visit\'s log was not found', 'unknown_visit', 404);
    this.mayReplay(v.header.annotator_id);
    const win = body.window_no;
    if (win !== undefined && win !== null && !Number.isInteger(win)) throw bad('window_no must be a whole number');
    const start = body.from_seq === undefined ? 0 : body.from_seq;
    const limit = body.limit === undefined ? 4000 : body.limit;
    for (const [value, what] of [[start, 'from_seq'], [limit, 'limit']]) if (!Number.isInteger(value) || value < 0) throw bad(`${what} must be a whole number`);
    const pointer = body.pointer === undefined ? true : body.pointer;
    if (typeof pointer !== 'boolean') throw bad('pointer must be true or false');
    let first = 0;
    let last = null;
    const hasWin = win !== undefined && win !== null;
    if (hasWin) {
      const row = indexRows(v.events, v.header.context_id || '').find((r) => r.window_no === win);
      if (!row) throw bad('This part of the visit\'s log was not found', 'unknown_segment', 404);
      first = row.first_seq;
      last = row.last_seq;
    }
    const n = Math.max(1, Math.min(limit, MAX_PAGE));
    const wanted = v.events.filter((e) => e.seq >= Math.max(start, first)).sort((a, b) => a.seq - b.seq);
    let events = wanted.slice(0, n);
    let next = wanted.length > events.length ? wanted[events.length].seq : null;
    if (last !== null) {
      events = events.filter((e) => e.seq <= last);
      if (next !== null && next > last) next = null;
    }
    if (hasWin) events = events.filter((e) => e.window_no === win);
    if (!pointer) events = events.filter((e) => e.type !== 'pointer');
    const lg = this.settings.logging || {};
    return { header: { started_at: v.header.started_at, logging: { pointer_hz: lg.pointer_hz, idle_after_s: lg.idle_after_s }, screens: [] },
      events: copy(events), next_seq: next };
  }

  async teaching_list() {
    const me = this.user();
    const r = this.replay;
    const shown = r.enabled !== false && r.trainees_watch_experts !== false;
    const out = [];
    if (shown) {
      for (const u of this.b._admin.s.users) {
        const aid = u.annotator_id;
        if (aid === me.aid || !this.isExpertAccount(aid) || !this.consents(aid)) continue;
        const finished = new Set();
        for (const [, v] of this.visitsOf(aid)) for (const row of indexRows(v.events, v.header.context_id || '')) if (row.mode === 'standard' && row.outcome === 'finished') finished.add(row.recording_id);
        const latest = new Map();
        for (const s of this.b.state.submissions) {
          if (s.annotator_id !== aid || s.mode !== 'standard' || !finished.has(s.recording_id)) continue;
          if (!latest.has(s.recording_id) || latest.get(s.recording_id).attempt < s.attempt) latest.set(s.recording_id, s);
        }
        for (const s of latest.values()) {
          const info = this.b._recordingInfo(s.recording_id);
          if (!info) continue;
          out.push({ annotator_id: aid, display_name: u.display_name || '', recording_id: s.recording_id, file_name: info.file_name, attempt: s.attempt,
            saved_at: s.saved_at || null, n_annotations: s.annotations.length });
        }
      }
    }
    out.sort((x, y) => x.annotator_id.localeCompare(y.annotator_id) || x.file_name.localeCompare(y.file_name));
    return { shown, sessions: out };
  }
}

const NAMES = ['work_list', 'saved_attempt_get', 'correction_save', 'corrections_list', 'correction_get', 'my_correction_get', 'replay_index_get', 'replay_events_get', 'teaching_list'];
const part = (x) => x.corrections || (x.corrections = new Corrections(x));

/** The operations of this part (demo_expert.js PARTS): {op: (expert, body) => answer}. */
export const CORRECTION_OPS = Object.fromEntries(NAMES.map((n) => [n, (x, body) => part(x)[n](body)]));
/** The operations of this part that people without the expert role may ask for too (each checks the rest). */
export const CORRECTION_OPEN_OPS = Object.freeze(['my_correction_get', 'replay_index_get', 'replay_events_get', 'teaching_list']);
/** GET /me/feedback's part: the corrections of the caller's own work. */
export const CORRECTION_FEEDBACK = { corrections: (x) => part(x).mine() };
