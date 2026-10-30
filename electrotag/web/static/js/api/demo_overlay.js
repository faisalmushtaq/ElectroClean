// Everyone's marks on one recording in the sandbox (docs/web/api.md, "The overlay of everyone's marks"), as
// electrotag/web/overlay.py does it on a server: the same operations, answers and errors, over the saved work
// the sandbox keeps in this browser (state.submissions) and its corrections (state.corrections). The sandbox has
// no adjudicated versions (adjudication needs a study server), and its training recordings are its study
// recordings too, so a trainee is never shown a crowd here (no recording is a teaching recording).

import { ApiError } from './http.js';
import { rolesOf } from '../admin/model.js';
import { binCounts } from '../expert/crowd.js';

const MAX_LANES = 8;
const MAX_PAGE = 500;
const MODES = ['standard', 'guided', 'practice', 'assessment'];
const INCLUDE = ['corrected', 'adjudicated'];
const NOT_SHOWN = 'This study does not show trainees other people\'s marks at the moment. The study team can switch it on in the study settings.';
const NOT_FOR_TEACHING = 'Other people\'s marks are shown to trainees only on the training recordings for learning with the experts, so that what you '
  + 'annotate for the study stays your own judgement. This recording is not one of them.';

const bad = (message, code = 'bad_request', status = 400) => new ApiError(status, code, message);
const whole = (body, key, dflt, lo, hi) => {
  const v = body[key] === undefined ? dflt : body[key];
  if (!Number.isInteger(v) || v < lo || v > hi) throw bad(`${key} must be a whole number from ${lo} to ${hi}`);
  return v;
};

/** Channel indexes as runs: [0, 1, 2, 3, 7] -> "0-3,7" (overlay.py ranges_text). */
export function rangesText(indexes) {
  const parts = [];
  let run = [];
  const close = () => { if (run.length) parts.push(run.length > 1 ? `${run[0]}-${run[run.length - 1]}` : String(run[0])); };
  for (const i of [...new Set(indexes)].sort((a, b) => a - b)) {
    if (run.length && i === run[run.length - 1] + 1) { run.push(i); continue; }
    close();
    run = [i];
  }
  close();
  return parts.join(',');
}

/** A saved version's annotations as (id, label, onset, duration, channels, confidence), in order (overlay.py _marks_of). */
function marksOf(annotations) {
  return (annotations || []).map((a) => ({ id: String(a.annotation_id || ''), label: String(a.label || ''), onset: a.onset_sample, dur: a.duration_samples,
    channels: [...(a.channels || [])], conf: Number.isInteger(a.confidence) ? a.confidence : 0 }))
    .sort((x, y) => x.onset - y.onset || x.dur - y.dur || (x.label < y.label ? -1 : x.label > y.label ? 1 : 0) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

class Tables {
  constructor(chNames) {
    this.at = new Map(chNames.map((n, i) => [n, i]));
    this.labels = [];
    this.sets = [''];
  }

  flat(marks) {
    const out = [];
    let prev = 0;
    for (const m of marks) {
      let l = this.labels.indexOf(m.label);
      if (l < 0) { l = this.labels.length; this.labels.push(m.label); }
      const key = rangesText(m.channels.filter((c) => this.at.has(c)).map((c) => this.at.get(c)));
      let s = this.sets.indexOf(key);
      if (s < 0) { s = this.sets.length; this.sets.push(key); }
      out.push(l, m.onset - prev, m.dur, s, m.conf);
      prev = m.onset;
    }
    return out;
  }
}

class Overlay {
  constructor(x) {
    this.x = x;
    this.b = x.b;
  }

  get replay() { return { trainees_see_crowd: false, ...((this.b._admin.s.settings || {}).replay || {}) }; }

  me() {
    const aid = this.b._aid();
    const u = this.b._admin.user(aid);
    const roles = u ? rolesOf(u) : [];
    return { aid, expert: Boolean(u && (roles.includes('expert') || roles.includes('admin'))) };
  }

  /** The sandbox's version of replay.py teaching_recording (demo_corrections.js): never true here. */
  teaching(rid, mode, ctx) {
    const c = this.x.corrections;
    return c && typeof c.teachingRecording === 'function' ? c.teachingRecording(rid, mode, ctx) : false;
  }

  target(body) {
    const rid = body.recording_id;
    if (typeof rid !== 'string' || !rid || rid.length > 512) throw bad('recording_id is missing');
    const mode = body.mode || 'standard';
    if (!MODES.includes(mode)) throw bad(`mode must be one of ${MODES.join(', ')}`);
    const ctx = mode !== 'standard' ? String(body.context_id || '') : '';
    if (mode !== 'standard' && !ctx) throw bad('context_id is missing: a training recording is shown with its training set');
    const me = this.me();
    const anonymous = !me.expert;
    if (anonymous) {
      if (this.replay.trainees_see_crowd !== true) throw bad(NOT_SHOWN, 'forbidden', 403);
      if (!this.teaching(rid, mode, ctx)) throw bad(NOT_FOR_TEACHING, 'forbidden', 403);
    }
    const info = this.b._recordingInfo(rid);
    if (!info) throw bad(`${rid} is not a registered recording of this study`, 'unknown_recording', 404);
    return { rid, mode, ctx, info, anonymous, me };
  }

  saved(rid, mode, ctx) {
    const latest = new Map();
    for (const s of this.b.state.submissions) {
      if (s.recording_id !== rid || s.mode !== mode || (mode !== 'standard' && s.context_id !== ctx)) continue;
      if (!latest.has(s.annotator_id) || latest.get(s.annotator_id).attempt < s.attempt) latest.set(s.annotator_id, s);
    }
    return [...latest.values()].map((s) => ({ annotator_id: s.annotator_id, attempt: s.attempt, saved_at: s.saved_at || null, marks: marksOf(s.annotations) }));
  }

  /** corrections.py corrections_of: the saved corrections of one attempt, the latest of each expert. */
  correctionsOf(aid, rid, attempt) {
    const rows = (this.b.state.corrections || []).filter((r) => r.state === 'saved' && r.annotator_id === aid && r.recording_id === rid
      && r.corrected_from && r.corrected_from.attempt === attempt)
      .sort((p, q) => String(p.corrected_at).localeCompare(String(q.corrected_at)) || p.number - q.number);
    const latest = new Map();
    for (const r of rows) latest.set(r.corrector_id, r);
    return rows.filter((r) => latest.get(r.corrector_id) === r);
  }

  async overlay_get(body) {
    const { rid, mode, ctx, info, anonymous, me } = this.target(body);
    let include = new Set();
    let detail = new Set();
    if (!anonymous) {
      const raw = typeof body.include === 'string' ? [body.include] : (body.include || []);
      if (!Array.isArray(raw) || raw.some((v) => !INCLUDE.includes(v))) throw bad('include may hold corrected and adjudicated');
      include = new Set(raw);
      const d = body.detail || [];
      if (!Array.isArray(d) || d.length > MAX_LANES) throw bad(`detail is the list of at most ${MAX_LANES} people shown in lanes`);
      detail = new Set(d.map((v) => {
        if (typeof v !== 'string' || !v.trim()) throw bad('detail is missing');
        return v === 'ADJUDICATED' || v.includes('~') ? v : v.trim().toUpperCase();
      }));
    }
    const offset = whole(body, 'offset', 0, 0, 10 ** 6);
    const limit = whole(body, 'limit', MAX_PAGE, 1, MAX_PAGE);
    const chNames = [...info.ch_names];
    const saved = this.saved(rid, mode, ctx);
    if (anonymous) saved.sort((p, q) => String(p.saved_at || '').localeCompare(String(q.saved_at || '')) || p.annotator_id.localeCompare(q.annotator_id));
    else saved.sort((p, q) => (p.annotator_id < q.annotator_id ? -1 : p.annotator_id > q.annotator_id ? 1 : 0));
    const tables = new Tables(chNames);
    const people = saved.slice(offset, offset + limit).map((p, i) => {
      const u = this.b._admin.user(p.annotator_id);
      const out = { annotator_id: anonymous ? `Person ${offset + i + 1}` : p.annotator_id, display_name: anonymous ? '' : (u && u.display_name) || '',
        roles: anonymous || !u ? [] : rolesOf(u), you: p.annotator_id === me.aid, source: 'saved', of: null, by: null, attempt: p.attempt,
        saved_at: p.saved_at, n_marks: p.marks.length, facets: {}, marks: tables.flat(p.marks) };
      if (detail.has(p.annotator_id)) out.ids = p.marks.map((m) => m.id);
      return out;
    });
    const derived = [];
    if (include.has('corrected') && offset === 0) {
      for (const p of saved) {
        for (const rec of this.correctionsOf(p.annotator_id, rid, p.attempt)) {
          const marks = marksOf(rec.annotations);
          const key = `${p.annotator_id}~${rec.corrector_id}`;
          const out = { annotator_id: key, display_name: `${p.annotator_id} corrected by ${rec.corrector_id}`, source: 'corrected', of: p.annotator_id,
            by: rec.corrector_id, attempt: rec.number, saved_at: rec.corrected_at || null, roles: [], you: false, n_marks: marks.length, facets: {},
            marks: tables.flat(marks) };
          if (detail.has(key)) out.ids = marks.map((m) => m.id);
          derived.push(out);
        }
      }
    }
    const crowd = offset === 0 ? binCounts(saved.map((p) => p.marks.map((m) => [m.onset, m.dur, !m.channels.length])), info.n_samples, info.sfreq) : null;
    const next = offset + limit < saved.length ? offset + limit : null;
    return { recording_id: rid, file_name: info.file_name, mode, context_id: ctx, manifest: await this.b._publicManifest(rid), sfreq: Number(info.sfreq),
      n_samples: Number(info.n_samples), channels: chNames, anonymous, labels: tables.labels, sets: tables.sets, people, derived, facets: [], crowd,
      total: saved.length, offset, next_offset: next };
  }

  async overlay_teaching_list() {
    const shown = this.replay.trainees_see_crowd === true;
    const me = this.me();
    const by = new Map();
    if (shown) {
      for (const s of this.b.state.submissions) {
        if (s.mode === 'standard') continue;
        const k = `${s.recording_id}|${s.mode}|${s.context_id || ''}`;
        if (!by.has(k)) by.set(k, { rid: s.recording_id, mode: s.mode, ctx: s.context_id || '', who: new Set() });
        by.get(k).who.add(s.annotator_id);
      }
    }
    const out = [];
    for (const g of by.values()) {
      if (!this.teaching(g.rid, g.mode, g.ctx)) continue;
      const info = this.b._recordingInfo(g.rid);
      if (!info) continue;
      out.push({ recording_id: g.rid, file_name: info.file_name, mode: g.mode, context_id: g.ctx, n_people: g.who.size, yours: g.who.has(me.aid) });
    }
    out.sort((p, q) => p.file_name.localeCompare(q.file_name) || p.mode.localeCompare(q.mode) || p.context_id.localeCompare(q.context_id));
    return { shown, recordings: out };
  }
}

const part = (x) => x.overlay || (x.overlay = new Overlay(x));

/** The operations of this part (demo_expert.js PARTS): {op: (expert, body) => answer}. */
export const OVERLAY_OPS = {
  overlay_get: (x, body) => part(x).overlay_get(body),
  overlay_teaching_list: (x) => part(x).overlay_teaching_list(),
};
/** Both may be asked by anyone signed in; each checks the rest itself (overlay.py, open_to_all). */
export const OVERLAY_OPEN_OPS = Object.freeze(['overlay_get', 'overlay_teaching_list']);
