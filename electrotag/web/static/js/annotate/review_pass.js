// Reviews of saved work (docs/web/admin.md, "Reviewing saved work"; docs/web/using.md, "Reviews of
// your work"), in the annotation view's read-only modes:
//
// * ReviewPass: an administrator's review of someone's saved recording. The side panel lists the
//   annotations of the version saved, each with Agree, Caveat and Comment and an optional note; a
//   stretch without an annotation is dragged across the EEG and gets a comment ("missed artifact?");
//   an overall note; Save the review (review_save) keeps it once, however often it is pressed.
//   Keys: N and P move, A agrees, C adds a caveat, M a comment, Delete clears the mark, Enter goes
//   to the note.
// * FeedbackPanel: what the annotator sees of the reviews of their work, beside their annotations
//   (read only, or while they revise): a calm marker in the accent blue under each reviewed item,
//   never red, and the notes in the side panel.
//
// The reviewed annotations are drawn as they were saved; nothing here changes them.

import { h, clear } from '../ui/dom.js';
import { ask, inform } from '../ui/dialog.js';
import { logger, keyName } from '../log/logger.js';
import { COLOURS } from '../ui/theme.js';
import { newId } from '../util.js';
import { endSample } from './store.js';

export const STATUS_TEXT = Object.freeze({ agree: 'Agree', caveat: 'Caveat', comment: 'Comment' });
export const STATUS_KEYS = Object.freeze({ a: 'agree', c: 'caveat', m: 'comment' });
export const MAX_NOTE = 300;
export const MAX_OVERALL = 1000;
export const MISSED_NOTE = 'missed artifact?';

const span = (on, dur, sf) => `${(on / sf).toFixed(2)}–${((on + dur) / sf).toFixed(2)} s`;

/** What the annotator recorded with an annotation: their confidence (1 to 5) and note, in words, or ''. */
export function annotatorSays(a) {
  const parts = [];
  if (Number.isInteger(a.confidence) && a.confidence >= 1 && a.confidence <= 5) parts.push(`confidence ${a.confidence} of 5`);
  if (a.note) parts.push(`“${String(a.note).trim()}”`);
  return parts.join(' · ');
}

/** The status line's fixed part while reviewing: whose work it is, and who reviews it. */
export function reviewStatusText(target, me) {
  const who = `${target.annotator_id}${target.display_name ? ` (${target.display_name})` : ''}`;
  return `Reviewing the work of ${who}, version ${target.attempt}   |   Reviewer: ${me ? me.annotator_id : ''}`;
}

/** The body of review_save from the marks: items in the order of the annotations, then the stretches. */
export function reviewBody({ reviewId, target, marks, ranges, overall }) {
  const items = [];
  for (const a of target.annotations) {
    const m = marks.get(a.annotation_id);
    if (m && m.status) items.push({ annotation_id: a.annotation_id, status: m.status, note: (m.note || '').slice(0, MAX_NOTE).trim() });
  }
  for (const r of ranges) items.push({ annotation_id: null, onset_sample: r.onset_sample, duration_samples: r.duration_samples, status: 'comment', note: (r.note || '').slice(0, MAX_NOTE).trim() || MISSED_NOTE });
  return { review_id: reviewId, annotator_id: target.annotator_id, recording_id: target.recording_id, mode: 'standard', attempt: target.attempt,
    items, overall_note: (overall || '').slice(0, MAX_OVERALL).trim() };
}

export class ReviewPass {
  /**
   * @param {import('./workspace.js').Workspace} ws a read-only workspace of kind 'reviewing'
   * @param {{target: object, backend: object, onSaved?: Function}} o target: the answer of saved_attempt_get
   */
  constructor(ws, { target, backend, onSaved = null }) {
    this.ws = ws;
    this.target = target;
    this.backend = backend;
    this.onSaved = onSaved;
    this.sf = ws.sf;
    this.anns = [...target.annotations].sort((a, b) => a.onset_sample - b.onset_sample || endSample(a) - endSample(b));
    this.marks = new Map(); // annotation_id -> {status, note}
    this.ranges = []; // {onset_sample, duration_samples, note}
    this.row = -1;
    this.saved = null;
    this.reviewId = null; // made when Save is first pressed, kept until the study has the review
    this.rangeColour = COLOURS.accent;
    ws.review = this;
    ws.el.classList.add('reviewing');
    this._build();
    // A click on an annotation in the EEG makes it the current one in the list.
    const select = ws.select.bind(ws);
    ws.select = (ids, opts) => { select(ids, opts); this._fromSelection(); };
    this._refresh();
  }

  get changed() { return !this.saved && (this.marks.size > 0 || this.ranges.length > 0 || Boolean(this.overall && this.overall.value.trim())); }

  _build() {
    const t = this.target;
    const when = t.saved_at ? new Date(t.saved_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    this.progress = h('p.caption.review-progress', { 'aria-live': 'polite' });
    this.list = h('ol.review-list', { 'aria-label': 'Annotations to review' });
    this.rows = this.anns.map((a, i) => this._row(a, i));
    this.list.append(...this.rows.map((r) => r.li));
    if (!this.anns.length) this.list.append(h('li.caption', {}, 'This version has no annotations. Mark any stretch that holds an artifact, or write an overall note.'));
    this.rangeList = h('ol.review-ranges', { 'aria-label': 'Stretches without an annotation' });
    this.overall = h('textarea.field.review-overall', { rows: 3, maxlength: String(MAX_OVERALL), 'aria-label': 'Overall note (optional)', 'data-log': 'review-overall' });
    this.overall.addEventListener('input', () => this._refresh());
    this.saveMsg = h('p.caption.review-save-msg', { role: 'status' });
    this.saveBtn = h('button.btn.primary', { type: 'button', 'data-log': 'review-save', title: 'Keep this review (it never changes the annotations)', onclick: () => this.save() }, 'Save the review');
    this.ws.actionsEl.append(this.saveBtn);
    const earlier = (t.reviews || []).length;
    this.el = h('section.review.card.review-pass', { 'aria-label': 'Review' },
      h('h2', {}, `Review of ${t.annotator_id}${t.display_name ? ` (${t.display_name})` : ''}`),
      h('p.caption', {}, `Version ${t.attempt}${when ? `, saved ${when}` : ''}. Your review is kept as a record of its own and never changes these annotations.${earlier ? ` Reviewed ${earlier} time${earlier === 1 ? '' : 's'} before.` : ''}`),
      this.progress, this.list,
      h('h3', {}, 'Stretches without an annotation'),
      h('p.caption', {}, 'Drag across the EEG to mark a stretch with an artifact that was not annotated.'),
      this.rangeList,
      h('label.review-overall-label', {}, h('span', {}, 'Overall note (optional)'), this.overall),
      h('p.caption.review-keys', {}, 'N and P move between annotations. A agrees, C adds a caveat, M a comment; Delete clears the mark; Enter goes to the note.'),
      this.saveMsg);
    this.ws.reviewHost.append(this.el);
    this.ws.hintEl.textContent = 'N / P  next, previous  ·  A agree  ·  C caveat  ·  M comment  ·  drag: a stretch without an annotation';
    // The status line names the annotator whose work is reviewed (the reviewer is signed in).
    this.ws._fixedText = reviewStatusText(t, this.ws.s.me);
    if (this.ws._refreshFixed) this.ws._refreshFixed();
  }

  _row(a, i) {
    const l = this.ws.cat.get(a.label);
    const buttons = Object.entries(STATUS_TEXT).map(([status, text]) => {
      const b = h('button.seg', { type: 'button', 'aria-pressed': 'false', 'data-status': status, title: `${text} (${Object.keys(STATUS_KEYS).find((k) => STATUS_KEYS[k] === status).toUpperCase()})` }, text);
      b.addEventListener('click', () => { this.go(i, { quiet: true }); this.mark(i, status, 'button'); });
      return b;
    });
    const note = h('input.field.review-note', { type: 'text', maxlength: String(MAX_NOTE), placeholder: 'Note (optional)', 'aria-label': `Note on ${a.label} at ${span(a.onset_sample, a.duration_samples, this.sf)}`, hidden: true });
    note.addEventListener('input', () => {
      const m = this.marks.get(a.annotation_id);
      if (m) m.note = note.value;
    });
    note.addEventListener('focus', () => this.go(i, { quiet: true }));
    const head = h('button.review-item-head', { type: 'button', onclick: () => this.go(i) },
      h('span.swatch', { style: { background: l.colour } }), h('span.review-label', {}, a.label), h('span.caption', {}, span(a.onset_sample, a.duration_samples, this.sf)));
    // The annotator's own doubt: their confidence in the mark and their note, as they saved them.
    const says = annotatorSays(a);
    const theirs = says ? h('p.caption.review-theirs', {}, `${this.target.annotator_id}: ${says}`) : null;
    const li = h('li.review-row', { 'data-id': a.annotation_id }, head, theirs, h('div.segmented.review-marks', { role: 'group', 'aria-label': `Mark ${a.label}` }, buttons), note);
    return { li, buttons, note, a };
  }

  /** Make annotation i the current one (and show it). */
  go(i, { quiet = false } = {}) {
    if (i < 0 || i >= this.anns.length) return;
    this.row = i;
    const a = this.anns[i];
    this.rows.forEach((r, k) => r.li.classList.toggle('current', k === i));
    this.rows[i].li.scrollIntoView({ block: 'nearest' });
    if (!quiet || !this.ws.selection.includes(a.annotation_id)) this.ws.jumpTo(a.annotation_id);
    this._markers();
  }

  step(delta) {
    if (!this.anns.length) { this.ws.say('This version has no annotations'); return; }
    const next = this.row >= 0 ? this.row + delta : delta > 0 ? 0 : this.anns.length - 1;
    if (next < 0 || next >= this.anns.length) { this.ws.say(delta > 0 ? 'That was the last annotation' : 'That was the first annotation'); return; }
    this.go(next);
    const a = this.anns[next];
    this.ws.say(`${next + 1} of ${this.anns.length}: ${a.label} ${span(a.onset_sample, a.duration_samples, this.sf)}. A agree, C caveat, M comment.`);
  }

  _fromSelection() {
    const id = this.ws.selection.length === 1 ? this.ws.selection[0] : null;
    const i = id ? this.anns.findIndex((a) => a.annotation_id === id) : -1;
    if (i >= 0 && i !== this.row) {
      this.row = i;
      this.rows.forEach((r, k) => r.li.classList.toggle('current', k === i));
      this.rows[i].li.scrollIntoView({ block: 'nearest' });
      this._markers();
    }
  }

  /** Mark annotation i (status null clears it). */
  mark(i, status, via = 'key') {
    if (this.saving || i < 0 || i >= this.anns.length) return;
    const a = this.anns[i];
    const was = this.marks.get(a.annotation_id);
    if (status === null || (was && was.status === status && via === 'button')) this.marks.delete(a.annotation_id);
    else this.marks.set(a.annotation_id, { status, note: was ? was.note : '' });
    const now = this.marks.get(a.annotation_id);
    logger.event('review_marked', { recording_id: this.target.recording_id, annotation_id: a.annotation_id, label: a.label, status: now ? now.status : null, via });
    this._refresh();
  }

  /** A stretch without an annotation (dragged across the EEG): a comment, "missed artifact?" unless a note is written. */
  onRange(t0, t1) {
    if (this.saving) return;
    const on = Math.max(0, Math.round(t0 * this.sf));
    const off = Math.min(this.ws.s.recording.nSamples, Math.round(t1 * this.sf));
    if (off - on < 1) return;
    this.ranges.push({ onset_sample: on, duration_samples: off - on, note: '' });
    this.ranges.sort((x, y) => x.onset_sample - y.onset_sample);
    logger.event('review_range_marked', { recording_id: this.target.recording_id, onset_s: on / this.sf, offset_s: off / this.sf });
    this.ws.say(`Stretch ${span(on, off - on, this.sf)} marked: "${MISSED_NOTE}". Change the note in the side panel if you like.`);
    this._refresh();
    const input = this.rangeList.querySelector(`[data-onset="${on}"] input`);
    if (input) input.focus({ preventScroll: true });
  }

  onKey(e, k) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const lk = String(k).toLowerCase();
    const run = (action, fn) => { e.preventDefault(); logger.shortcut(keyName(e), action); fn(); return true; };
    if (STATUS_KEYS[lk]) {
      return run(STATUS_TEXT[STATUS_KEYS[lk]], () => {
        if (this.row < 0) { this.ws.say('Choose an annotation first: N and P move between them.'); return; }
        this.mark(this.row, STATUS_KEYS[lk]);
      });
    }
    if (k === 'Delete' || k === 'Backspace') return run('Clear the mark', () => this.row >= 0 && this.mark(this.row, null));
    if (k === 'Enter' && this.row >= 0 && this.marks.has(this.anns[this.row].annotation_id)) {
      return run('Note', () => this.rows[this.row].note.focus());
    }
    return false;
  }

  _refresh() {
    let marked = 0;
    this.rows.forEach((r) => {
      const m = this.marks.get(r.a.annotation_id);
      if (m) marked += 1;
      for (const b of r.buttons) b.setAttribute('aria-pressed', String(Boolean(m && m.status === b.dataset.status)));
      r.note.hidden = !m;
      if (m && r.note.value !== m.note) r.note.value = m.note || '';
      r.li.dataset.status = m ? m.status : '';
    });
    clear(this.rangeList);
    if (!this.ranges.length) this.rangeList.append(h('li.caption', {}, 'None marked.'));
    this.ranges.forEach((r, i) => {
      const input = h('input.field.review-note', { type: 'text', maxlength: String(MAX_NOTE), value: r.note, placeholder: MISSED_NOTE, 'aria-label': `Note on the stretch ${span(r.onset_sample, r.duration_samples, this.sf)}` });
      input.addEventListener('input', () => { r.note = input.value; });
      const remove = h('button.btn.small.quiet', { type: 'button', onclick: () => { this.ranges.splice(i, 1); this._refresh(); } }, 'Remove');
      const go = h('button.review-item-head', { type: 'button', onclick: () => this.ws.viewer.showInterval(r.onset_sample, r.duration_samples, []) },
        h('span.review-label', {}, 'Stretch'), h('span.caption', {}, span(r.onset_sample, r.duration_samples, this.sf)));
      this.rangeList.append(h('li.review-row', { 'data-onset': String(r.onset_sample) }, go, h('div.review-range-edit', {}, input, remove)));
    });
    const n = this.anns.length;
    this.progress.textContent = `${marked} of ${n} annotation${n === 1 ? '' : 's'} marked${this.ranges.length ? `, ${this.ranges.length} stretch${this.ranges.length === 1 ? '' : 'es'} without an annotation` : ''}`;
    this._markers();
  }

  _markers() {
    const cur = this.row >= 0 ? this.anns[this.row].annotation_id : null;
    const list = [];
    for (const a of this.anns) if (this.marks.has(a.annotation_id) || a.annotation_id === cur) list.push({ onset_sample: a.onset_sample, duration_samples: a.duration_samples, current: a.annotation_id === cur });
    for (const r of this.ranges) list.push({ onset_sample: r.onset_sample, duration_samples: r.duration_samples, outline: true });
    this.ws.viewer.setMarkers(list);
    const prefix = {};
    for (const [id, m] of this.marks) prefix[id] = `${STATUS_TEXT[m.status]} · `;
    this.ws.viewer.setPrefix(prefix); // on the EEG's tags only: the list keeps the labels whole
  }

  /** Save the review once: a press while it is being sent does nothing; a failure can be sent again with the same ID. */
  async save() {
    if (this.saving || this.saved) return false;
    const body = reviewBody({ reviewId: this.reviewId || (this.reviewId = newId()), target: this.target, marks: this.marks, ranges: this.ranges, overall: this.overall.value });
    if (!body.items.length && !body.overall_note) {
      this.saveMsg.textContent = 'Mark at least one annotation, or write an overall note, before saving the review.';
      return false;
    }
    this.saving = true;
    this.saveBtn.disabled = true;
    this.saveMsg.textContent = 'Saving the review…';
    try {
      const r = await this.backend.admin('review_save', body);
      this.saved = r.review;
      this.saveMsg.textContent = `Saved: ${r.review.summary}.`;
      this.saveBtn.textContent = 'Review saved';
      if (this.onSaved) await this.onSaved(r.review);
      return true;
    } catch (exc) {
      this.saveBtn.disabled = false;
      this.saveMsg.textContent = `The review was not saved: ${exc.message}${exc.status === 0 || exc.status >= 500 ? ' Press Save the review to try again; a review the study already has is kept once.' : ''}`;
      return false;
    } finally {
      this.saving = false;
    }
  }

  /** Close: a review with marks not yet saved is kept only if the reviewer saves it. */
  async beforeClose() {
    if (this.saving) { this.ws.say('Wait for the review to be saved.'); return false; }
    if (!this.changed) return true;
    return ask('Leave without saving the review?', 'Your marks and notes on this recording are not kept unless you save the review.',
      { yes: 'Leave without saving', no: 'Keep reviewing', defaultYes: false, destructive: true });
  }
}

// ------------------------------------------------------------- the annotator's side
/** The review items (newest review first) as the annotator's feedback rows. */
export function feedbackRows(reviews, sf) {
  const out = [];
  for (const r of reviews) {
    for (const it of r.items || []) {
      out.push({ review: r, item: it, onset_s: it.onset_sample / sf, text: it.annotation_id ? `${it.label || 'Annotation'}, ${span(it.onset_sample, it.duration_samples, sf)}` : `No annotation, ${span(it.onset_sample, it.duration_samples, sf)}` });
    }
  }
  return out.sort((a, b) => a.onset_s - b.onset_s);
}

export class FeedbackPanel {
  /**
   * @param {object} ws the workspace (kind 'feedback', read only; or a revision being annotated)
   * @param {{reviews: object[], onRevise?: Function|null, stepper?: boolean}} o
   */
  constructor(ws, { reviews, onRevise = null, stepper = false }) {
    this.ws = ws;
    this.reviews = reviews;
    this.rows = feedbackRows(reviews, ws.sf);
    this.row = -1;
    if (stepper) ws.review = this; // N and P step through the feedback in the read-only view
    this._build(onRevise);
    this._markers();
    logger.event('feedback_shown', { recording_id: ws.s.recordingId, reviews: reviews.length, items: this.rows.length, kind: ws.kind });
  }

  _build(onRevise) {
    const latest = this.reviews[0];
    const when = (r) => (r.reviewed_at ? new Date(r.reviewed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
    this.items = this.rows.map((r, i) => {
      const li = h('li.feedback-row', { 'data-status': r.item.status, tabindex: '0', 'data-log': 'feedback-item',
        onclick: () => this.go(i), onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.go(i); } } },
      h('span.chip.feedback-chip', {}, STATUS_TEXT[r.item.status] || r.item.status),
      h('span.feedback-text', {}, r.text),
      r.item.note ? h('span.feedback-note', {}, r.item.note) : null);
      return li;
    });
    const overall = this.reviews.filter((r) => r.overall_note).map((r) => h('p.feedback-overall', {}, h('b', {}, `${when(r)}: `), r.overall_note));
    this.el = h('section.review.card.feedback-panel', { 'aria-label': 'Feedback on your work' },
      h('h2', {}, 'Feedback on your work'),
      h('p.caption', {}, `Reviewed ${this.reviews.length === 1 ? 'once' : `${this.reviews.length} times`}; the latest on ${when(latest)}, of version ${latest.attempt}: ${latest.summary}.`),
      this.rows.length ? h('ol.feedback-list', { 'aria-label': 'Feedback, in the order of the recording' }, this.items) : null,
      overall,
      h('p.caption', {}, this.ws.kind === 'feedback' ? 'The blue marks under the EEG show what the feedback is about. Press N and P, or choose an item, to go to it.'
        : 'The blue marks under the EEG show what the feedback is about. It is for you to judge what to change.'));
    this.ws.reviewHost.append(this.el);
    if (onRevise && this.ws.actionsEl) {
      this.ws.actionsEl.append(h('button.btn.primary', { type: 'button', 'data-log': 'feedback-revise', onclick: () => onRevise() }, 'Open to revise'));
    }
  }

  go(i) {
    if (i < 0 || i >= this.rows.length) return;
    this.row = i;
    const r = this.rows[i];
    this.items.forEach((li, k) => li.classList.toggle('current', k === i));
    this.items[i].scrollIntoView({ block: 'nearest' });
    const id = r.item.annotation_id;
    if (id && this.ws.store.has(id)) this.ws.jumpTo(id);
    else this.ws.viewer.showInterval(r.item.onset_sample, r.item.duration_samples, []);
    this._markers();
    logger.event('feedback_item_jumped', { recording_id: this.ws.s.recordingId, status: r.item.status, onset_s: r.onset_s, item: i + 1 });
  }

  step(delta) {
    if (!this.rows.length) { this.ws.stepSelection(delta); return; }
    const next = this.row >= 0 ? this.row + delta : delta > 0 ? 0 : this.rows.length - 1;
    this.go(Math.min(Math.max(0, next), this.rows.length - 1));
  }

  _markers() {
    const list = this.rows.map((r, i) => {
      const id = r.item.annotation_id;
      const a = id && this.ws.store.has(id) ? this.ws.store.get(id) : null;
      return { onset_sample: a ? a.onset_sample : r.item.onset_sample, duration_samples: a ? a.duration_samples : r.item.duration_samples,
        outline: !id, current: i === this.row };
    });
    this.ws.viewer.setMarkers(list);
    const prefix = {};
    // the latest review's mark of each annotation (the reviews come newest first)
    for (const rv of [...this.reviews].reverse()) for (const it of rv.items || []) if (it.annotation_id) prefix[it.annotation_id] = `${STATUS_TEXT[it.status]} · `;
    this.ws.viewer.setPrefix(prefix); // on the EEG's tags only: the list keeps the labels whole
  }
}

/** The review notes in the side panel of a revision of a reviewed recording (when the study shows reviews). */
export function attachFeedback(app, ws) {
  const all = (app.reviews && app.reviews.shown && app.reviews.reviews) || [];
  const mine = all.filter((r) => r.recording_id === ws.s.recordingId && ws.s.mode === 'standard');
  if (!mine.length) return null;
  return new FeedbackPanel(ws, { reviews: mine });
}

export async function savedReviewMessage(review) {
  await inform('Review saved', `Your review of ${review.annotator_id}'s ${review.file_name || review.recording_id} is saved: ${review.summary}. It is kept apart from the annotations, which stay as they were saved.`);
}
