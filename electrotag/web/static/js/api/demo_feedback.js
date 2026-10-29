// Problem reports and reviews of saved work in the demonstration, as electrotag/web/feedback.py
// does them on a study server (docs/web/api.md, "Problem reports" and "Reviews"). The backend
// (demo.js) and its admin area (demo_admin.js) call this module; its state lives in the
// demonstration's own state: state.problems (by problem ID), state.unusable (by assignment key)
// and state.reviews (newest last). Records are never deleted, and a report or review sent twice
// with the same ID is kept once.

import { ApiError } from './http.js';
import { nowLocalIso } from '../util.js';

export const REASONS = Object.freeze({
  file_wont_open: 'The file will not open',
  wrong_recording: 'This is the wrong recording',
  bad_channels: 'Channels are flat, missing or disconnected',
  too_noisy: 'Too noisy or too short to annotate',
  other: 'Something else',
});
export const OUTCOMES = Object.freeze({ noted: 'Told the study team and carried on', unusable: 'Cannot be annotated' });
export const REVIEW_STATUSES = Object.freeze(['agree', 'caveat', 'comment']);
export const MAX_NOTE = 300;
export const MAX_OVERALL_NOTE = 1000;
const REQUEST_ID = /^[0-9a-f]{32}$/;
const bad = (message, code = 'bad_request', status = 400) => new ApiError(status, code, message);

function note(value, what = 'note', limit = MAX_NOTE) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > limit) throw bad(`${what} must be text of at most ${limit} characters`);
  return value.trim();
}

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;

/** "2 caveats, 1 comment" (as count_text in feedback.py). */
export function countText(counts = {}) {
  const parts = [['caveat', 'caveat'], ['comment', 'comment'], ['agree', 'agreement']]
    .filter(([k]) => Number(counts[k]) > 0).map(([k, one]) => plural(Number(counts[k]), one));
  return parts.join(', ') || 'no marks';
}

export function reviewCounts(items) {
  const out = { agree: 0, caveat: 0, comment: 0, missed: 0 };
  for (const it of items) {
    out[it.status] = (out[it.status] || 0) + 1;
    if (it.annotation_id === null || it.annotation_id === undefined) out.missed += 1;
  }
  return out;
}

export class DemoFeedback {
  constructor(backend) {
    this.b = backend;
  }

  get state() {
    const st = this.b.state;
    if (!st.problems || typeof st.problems !== 'object') st.problems = {};
    if (!st.unusable || typeof st.unusable !== 'object') st.unusable = {};
    if (!Array.isArray(st.reviews)) st.reviews = [];
    return st;
  }

  get _settings() { return this.b._admin.s.settings.annotation; }

  // ================================================================ problems
  /** True when the assignment (its key) is set aside as one that cannot be annotated. */
  isUnusable(key) {
    const m = this.state.unusable[key];
    return Boolean(m && m.active);
  }

  /** The study recordings someone set aside, with how many people did. */
  unusableRecordings() {
    const out = {};
    for (const m of Object.values(this.state.unusable)) if (m.active && m.mode === 'standard') out[m.recording_id] = (out[m.recording_id] || 0) + 1;
    return out;
  }

  problemOut(rec, { mine = false } = {}) {
    const keys = ['problem_id', 'recording_id', 'file_name', 'mode', 'context_id', 'reason', 'note', 'outcome', 'where', 'reported_at', 'state',
      'resolution', 'resolution_note', 'resolved_at', 'returned_at'];
    const out = Object.fromEntries(keys.map((k) => [k, rec[k] ?? null]));
    out.reason_text = REASONS[rec.reason] || rec.reason;
    if (!mine) {
      for (const k of ['annotator_id', 'display_name', 'item_status', 'resolved_by', 'reassigned_to']) out[k] = rec[k] ?? null;
      out.unusable_now = this.isUnusable(this.b._key(rec.annotator_id, rec.recording_id, rec.mode, rec.context_id));
    }
    return out;
  }

  /** The latest report of one of the annotator's assignments (GET /assignments `problem`), or null. */
  problemOf(aid, a) {
    const mine = Object.values(this.state.problems)
      .filter((p) => p.annotator_id === aid && p.recording_id === a.rid && p.mode === a.mode && (p.context_id || '') === (a.context_id || ''))
      .sort((x, y) => String(x.reported_at).localeCompare(String(y.reported_at)));
    return mine.length ? this.problemOut(mine[mine.length - 1], { mine: true }) : null;
  }

  /** POST /problems. */
  report(body = {}) {
    const aid = this.b._aid();
    const pid = body.problem_id;
    if (typeof pid !== 'string' || !REQUEST_ID.test(pid)) throw bad('problem_id must be 32 hexadecimal characters (made by the browser for this request)');
    if (!(body.reason in REASONS)) throw bad(`reason must be one of ${Object.keys(REASONS).join(', ')}`);
    const outcome = body.outcome || 'noted';
    if (!(outcome in OUTCOMES)) throw bad(`outcome must be one of ${Object.keys(OUTCOMES).join(', ')}`);
    const where = body.where || 'home';
    if (!['home', 'annotate'].includes(where)) throw bad('where must be home or annotate');
    const text = note(body.note);
    const kept = this.state.problems[pid];
    if (kept) {
      if (kept.annotator_id !== aid) throw bad('This report could not be kept. Please try again.', 'conflict', 409);
      return { problem: this.problemOut(kept, { mine: true }), already: true };
    }
    const mode = body.mode || 'standard';
    const ctx = mode === 'standard' ? '' : body.context_id || '';
    const a = this.b._assignmentsFor(aid).find((x) => x.rid === body.recording_id && x.mode === mode && (x.context_id || '') === ctx);
    if (!a) throw new ApiError(403, 'not_assigned', `${body.recording_id} is not one of your recordings at the moment`);
    const status = this.b._status(aid, a);
    if (outcome === 'unusable') {
      if (mode !== 'standard') throw bad('A training recording cannot be set aside. Tell the study team about the problem instead, and carry on.', 'not_for_training', 409);
      if (status === 'done') throw bad(`You have saved ${a.rid} already. Tell the study team about the problem instead.`, 'already_done', 409);
    }
    const info = this.b._recordingInfo(a.rid);
    const user = this.b._account();
    const rec = {
      schema: 'electrotag.problem_report', schema_version: 1, problem_id: pid, annotator_id: aid, display_name: (user && user.display_name) || '',
      recording_id: a.rid, file_name: info ? info.file_name : a.rid.split('/').pop(), mode, context_id: ctx, reason: body.reason, note: text,
      outcome, where, item_status: status, reported_at: nowLocalIso(), state: 'open', resolution: null, resolution_note: '', resolved_at: null,
      resolved_by: null, reassigned_to: null, returned_at: null,
    };
    this.state.problems[pid] = rec;
    if (outcome === 'unusable') {
      this.state.unusable[this.b._key(aid, a.rid, mode, ctx)] = { annotator_id: aid, recording_id: a.rid, mode, context_id: ctx, problem_id: pid, active: true, changed_at: nowLocalIso() };
    }
    this.b._admin._audit('problem_report', `${aid} reported a problem with ${a.rid}: ${REASONS[body.reason].toLowerCase()}${outcome === 'unusable' ? ' (cannot be annotated)' : ''}`,
      { problem_id: pid, recording_id: a.rid, mode, context_id: ctx, reason: body.reason, outcome, where, note_length: text.length });
    this.b._save();
    return { problem: this.problemOut(rec, { mine: true }), already: false };
  }

  _problem(body) {
    const rec = this.state.problems[String(body.problem_id || '')];
    if (!rec) throw new ApiError(404, 'unknown_problem', 'That report is not known to the study.');
    return rec;
  }

  _resolve(rec, resolution, text, extra = {}) {
    if (rec.state === 'resolved') throw bad('This report has been resolved already.', 'already_resolved', 409);
    Object.assign(rec, { state: 'resolved', resolution, resolution_note: text, resolved_at: nowLocalIso(), resolved_by: this.b.annotatorId, ...extra });
  }

  op_problems_list(body) {
    if (![undefined, null, 'open', 'resolved'].includes(body.state)) throw bad("state must be 'open' or 'resolved'");
    if (body.reason !== undefined && body.reason !== null && !(body.reason in REASONS)) throw bad(`reason must be one of ${Object.keys(REASONS).join(', ')}`);
    let rows = Object.values(this.state.problems).map((r) => this.problemOut(r));
    const counts = { open: rows.filter((r) => r.state === 'open').length, resolved: rows.filter((r) => r.state === 'resolved').length,
      unusable: Object.values(this.state.unusable).filter((m) => m.active).length };
    if (body.state) rows = rows.filter((r) => r.state === body.state);
    if (body.annotator_id) rows = rows.filter((r) => r.annotator_id === String(body.annotator_id).trim().toUpperCase());
    if (body.recording_id) rows = rows.filter((r) => r.recording_id === body.recording_id);
    if (body.reason) rows = rows.filter((r) => r.reason === body.reason);
    rows.sort((x, y) => String(y.reported_at).localeCompare(String(x.reported_at)));
    return { problems: rows, counts, reasons: { ...REASONS } };
  }

  op_problem_resolve(body) {
    const rec = this._problem(body);
    const text = note(body.note);
    this._resolve(rec, 'resolved', text);
    this.b._admin._audit('problem_resolve', `Resolved ${rec.annotator_id}'s report on ${rec.recording_id}`, { problem_id: rec.problem_id, note: text });
    return { problem: this.problemOut(rec) };
  }

  op_problem_return(body) {
    const rec = this._problem(body);
    const text = note(body.note);
    const key = this.b._key(rec.annotator_id, rec.recording_id, rec.mode, rec.context_id);
    if (!this.isUnusable(key)) {
      throw bad(`${rec.recording_id} is not set aside for ${rec.annotator_id}: it is on their list already. Resolve the report instead.`, 'not_unusable', 409);
    }
    this._resolve(rec, 'returned', text, { returned_at: nowLocalIso() });
    this.state.unusable[key] = { ...this.state.unusable[key], active: false, changed_at: nowLocalIso() };
    this.b._admin._audit('problem_return', `Returned ${rec.recording_id} to ${rec.annotator_id}'s to-do list`, { problem_id: rec.problem_id, note: text });
    return { problem: this.problemOut(rec) };
  }

  op_problem_reassign(body) {
    const rec = this._problem(body);
    const text = note(body.note);
    const to = String(body.annotator_id || '').trim().toUpperCase();
    if (!to) throw bad('annotator_id is missing');
    if (to === rec.annotator_id) throw bad('Choose someone other than the person who reported the problem, or return it to them.');
    if (!this.b._admin.user(to)) throw new ApiError(404, 'unknown_user', `${to} has no account in this study`);
    if (rec.mode !== 'standard') throw bad('Training recordings are given through the training programme.', 'not_for_training', 409);
    const before = this.b._admin.standardAssignments(to).length;
    this.b._admin.op_assign({ annotator_ids: [to], recording_ids: [rec.recording_id] });
    const added = this.b._admin.standardAssignments(to).length - before;
    this._resolve(rec, 'reassigned', text, { reassigned_to: to });
    this.b._admin._audit('problem_reassign', `Gave ${rec.recording_id} to ${to} after ${rec.annotator_id}'s report`, { problem_id: rec.problem_id, to, added, note: text });
    return { problem: this.problemOut(rec), added };
  }

  // ================================================================= reviews
  _latest(aid, rid) {
    const key = this.b._key(aid, rid, 'standard', '');
    const list = this.b.state.submissions.filter((s) => s.key === key).sort((x, y) => x.attempt - y.attempt);
    return list.length ? list[list.length - 1] : null;
  }

  async _target(body) {
    const aid = String(body.annotator_id || '').trim().toUpperCase();
    if (!aid) throw bad('annotator_id is missing');
    const rid = body.recording_id;
    if (typeof rid !== 'string' || !rid) throw bad('recording_id is missing');
    if ((body.mode || 'standard') !== 'standard') throw bad('Reviews are for the study\'s own recordings; training recordings have their own feedback.', 'not_for_training', 409);
    const last = this._latest(aid, rid);
    const info = this.b._recordingInfo(rid);
    if (!last || !info) throw new ApiError(404, 'no_saved_annotations', `${aid} has not saved ${rid}, so there is nothing to review.`);
    return { aid, rid, last, info };
  }

  async _manifestOf(info) {
    if (info.builtin) return { ...this.b._manifest(info.spec), fingerprint: await this.b._fingerprint(info.spec) };
    return this.b._admin.publicManifestOf(info.record);
  }

  reviewOut(rec, { forAnnotator = false } = {}) {
    const keys = ['review_id', 'annotator_id', 'recording_id', 'file_name', 'mode', 'context_id', 'attempt', 'reviewer_id', 'reviewer_name', 'reviewed_at',
      'overall_note', 'items', 'counts'];
    const out = Object.fromEntries(keys.map((k) => [k, rec[k] ?? null]));
    out.summary = countText(rec.counts || {});
    if (!forAnnotator) out.session_id = rec.session_id || '';
    return JSON.parse(JSON.stringify(out));
  }

  _reviews(aid = null, rid = null) {
    return this.state.reviews.filter((r) => (!aid || r.annotator_id === aid) && (!rid || r.recording_id === rid))
      .sort((x, y) => String(y.reviewed_at).localeCompare(String(x.reviewed_at)));
  }

  async op_saved_attempt_get(body) {
    const { aid, rid, last, info } = await this._target(body);
    const u = this.b._admin.user(aid);
    return { annotator_id: aid, display_name: (u && u.display_name) || '', recording_id: rid, file_name: info.file_name, mode: 'standard', context_id: '',
      attempt: last.attempt, saved_at: last.saved_at, manifest: await this._manifestOf(info),
      annotations: (last.annotations || []).map((a) => ({ ...a, channels: [...(a.channels || [])] })),
      reviews: this._reviews(aid, rid).map((r) => this.reviewOut(r)), allow_reviews: this._settings.allow_reviews !== false };
  }

  async op_review_save(body) {
    const id = body.review_id;
    if (typeof id !== 'string' || !REQUEST_ID.test(id)) throw bad('review_id must be 32 hexadecimal characters (made by the browser for this request)');
    const kept = this.state.reviews.find((r) => r.review_id === id);
    if (kept) {
      if (kept.reviewer_id !== this.b.annotatorId) throw bad('This review could not be kept. Please try again.', 'conflict', 409);
      return { review: this.reviewOut(kept), already: true };
    }
    if (this._settings.allow_reviews === false) throw bad('This study does not take reviews of saved work. Switch them on in the study settings first.', 'reviews_off', 409);
    const { aid, rid, last, info } = await this._target(body);
    if (!Number.isInteger(body.attempt)) throw bad('attempt must be the version reviewed (a whole number)');
    if (body.attempt !== last.attempt) {
      throw bad(`${aid} has saved ${rid} again since you opened it (version ${last.attempt}). Open it again to review the latest version.`, 'not_latest', 409);
    }
    if (!Array.isArray(body.items) || body.items.length > 5000) throw bad('items must be a list of at most 5000 review items');
    const byId = new Map((last.annotations || []).map((a) => [a.annotation_id, a]));
    const seen = new Set();
    const items = body.items.map((it, i) => {
      const n = i + 1;
      if (!it || typeof it !== 'object') throw bad(`Review item ${n} is not an object`);
      if (!REVIEW_STATUSES.includes(it.status)) throw bad(`Review item ${n}: status must be one of ${REVIEW_STATUSES.join(', ')}`);
      const text = note(it.note, `Review item ${n}: note`);
      let out;
      if (it.annotation_id !== undefined && it.annotation_id !== null) {
        const a = byId.get(it.annotation_id);
        if (!a) throw bad(`Review item ${n} is about an annotation that is not in the saved version reviewed`, 'unknown_annotation', 422);
        if (seen.has(it.annotation_id)) throw bad(`Review item ${n}: annotation ${it.annotation_id} is reviewed twice`);
        seen.add(it.annotation_id);
        out = { annotation_id: a.annotation_id, label: a.label, onset_sample: a.onset_sample, duration_samples: a.duration_samples, channels: [...(a.channels || [])], status: it.status, note: text };
      } else {
        const on = it.onset_sample;
        const dur = it.duration_samples;
        if (!Number.isInteger(on) || !Number.isInteger(dur)) throw bad(`Review item ${n}: onset_sample and duration_samples must be whole numbers of samples`);
        if (on < 0 || dur < 1 || on + dur > info.n_samples) throw bad(`Review item ${n}: the stretch must lie within the recording`, 'invalid_review', 422);
        if (it.status !== 'comment') throw bad(`Review item ${n}: a stretch without an annotation takes a comment`);
        out = { annotation_id: null, label: null, onset_sample: on, duration_samples: dur, channels: [], status: 'comment', note: text || 'missed artifact?' };
      }
      out.onset_s = Math.round((out.onset_sample / info.sfreq) * 1e6) / 1e6;
      out.offset_s = Math.round(((out.onset_sample + out.duration_samples) / info.sfreq) * 1e6) / 1e6;
      return out;
    });
    const overall = note(body.overall_note, 'overall_note', MAX_OVERALL_NOTE);
    if (!items.length && !overall) throw bad('Mark at least one annotation, or write an overall note, before saving the review.', 'empty_review');
    const counts = reviewCounts(items);
    const me = this.b._account();
    const rec = { schema: 'electrotag.review', schema_version: 1, review_id: id, annotator_id: aid, recording_id: rid, file_name: info.file_name, mode: 'standard',
      context_id: '', attempt: last.attempt, session_id: (last.session && last.session.session_id) || '', reviewer_id: this.b.annotatorId,
      reviewer_name: (me && me.display_name) || '', reviewed_at: nowLocalIso(), overall_note: overall, items, counts };
    this.state.reviews.push(rec);
    this.b._admin._audit('review_save', `Reviewed ${aid}'s ${rid} (version ${last.attempt}): ${countText(counts)}`,
      { review_id: id, annotator_id: aid, recording_id: rid, attempt: last.attempt, counts, n_items: items.length, overall_note_length: overall.length });
    return { review: this.reviewOut(rec), already: false };
  }

  op_reviews_list(body) {
    const aid = body.annotator_id ? String(body.annotator_id).trim().toUpperCase() : null;
    return { reviews: this._reviews(aid, body.recording_id || null).map((r) => this.reviewOut(r)) };
  }

  /** GET /me/reviews. */
  mine() {
    const aid = this.b._aid();
    if (this._settings.show_reviews_to_annotators === false) return { shown: false, reviews: [] };
    return { shown: true, reviews: this._reviews(aid).map((r) => this.reviewOut(r, { forAnnotator: true })) };
  }

  /** Overview's and Progress's counts: open reports and the recordings reviewed. */
  counts() {
    return { problems_open: Object.values(this.state.problems).filter((p) => p.state === 'open').length,
      reviewed: new Set(this.state.reviews.map((r) => `${r.annotator_id}|${r.recording_id}`)).size };
  }
}
