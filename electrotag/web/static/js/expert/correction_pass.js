// An expert's correction of someone's saved work (docs/web/admin.md, "Correcting saved work"; the
// operations in docs/web/api.md, "Corrections and replay"). The recording opens in the annotation
// view, editable, with the saved attempt's annotations (keeping their IDs) and the original drawn as
// a dashed layer beside them, so that a removed or moved mark stays visible (L shows or hides it).
// The Changes panel lists the difference from the original as it is now (js/expert/diff.js), each
// change with reason chips and a short note; a change without a reason the study asks for is
// outlined. J and K go to the next and previous change, R to its reasons.
//
// Submit the correction makes the correction's ID at the first press and keeps it until the study
// has the correction, and sends correction_save once (it is never repeated by itself; pressed again
// after an answer that came too late, the same ID is sent and the study keeps one correction). The
// work in progress is kept only in this browser (CorrectionSession), never as the annotator's or the
// expert's draft with the study. The log has the reasons and the lengths of the notes, never their text.

import { h, clear } from '../ui/dom.js';
import { ask, choose, inform } from '../ui/dialog.js';
import { logger, keyName } from '../log/logger.js';
import { local, newId, nowLocalIso, plural, debounce } from '../util.js';
import { AnnotationSession } from '../annotate/session.js';
import { Workspace } from '../annotate/workspace.js';
import { MAX_NOTE, MAX_OVERALL, REASONS, changeCounts, changeText, countsText, diffAnnotations, needsReason, suggestedReason } from './diff.js';

/** The study's rule for reasons (review.reason_required), in words for the panel. */
export const RULE_TEXT = Object.freeze({
  always: 'The study asks for a reason for every change.',
  edited_or_none: 'The study asks for a reason for each changed or removed mark.',
  never: 'Reasons are optional in this study.',
});

/** Where a correction in progress is kept in this browser: by the expert, the person and the version corrected. */
export function correctionKey(backend, me, target) {
  return `electrotag.correction|${(backend && backend.kind) || ''}|${me || ''}|${target.annotator_id}|${target.recording_id}|v${target.attempt}`;
}

/**
 * The annotation session of a correction: editable and timed like any other, but its draft is kept in
 * this browser only (by correctionKey), never sent to the study as anyone's draft.
 */
export class CorrectionSession extends AnnotationSession {
  constructor(o) {
    super(o);
    this.target = o.target;
    this.extra = { correction_id: null, reasons: {}, overall_note: '' };
  }

  get localKey() { return correctionKey(this.backend, this.me && this.me.annotator_id, this.target); }

  draftPayload() { return { ...super.draftPayload(), ...this.extra, reasons: { ...this.extra.reasons } }; }

  /** The work on this correction kept in this browser, or null. */
  keptDraft() {
    const d = local.get(this.localKey, null);
    return d && Array.isArray(d.annotations) ? d : null;
  }

  async saveRemote() { return false; }

  async discardDrafts({ close = false } = {}) {
    if (close) this.close();
    this.forgetLocal();
  }

  get discarded() { return null; }
}

/** The body of correction_save from the panel's state (exported for the tests). */
export function correctionBody({ correctionId, target, annotations, changes, reasons, overall, session, sha256 }) {
  return {
    correction_id: correctionId, annotator_id: target.annotator_id, recording_id: target.recording_id, mode: 'standard', attempt: target.attempt,
    annotations, sha256, session,
    changes: changes.map((c) => ({ annotation_id: c.annotation_id, reason: (reasons[c.annotation_id] || {}).reason || '',
      note: String((reasons[c.annotation_id] || {}).note || '').slice(0, MAX_NOTE).trim() })),
    overall_note: String(overall || '').slice(0, MAX_OVERALL).trim(),
  };
}

/** The changes still without a reason the study's rule asks for. */
export function missingReasons(changes, reasons, rule) {
  return changes.filter((c) => needsReason(c.change, rule) && !(reasons[c.annotation_id] || {}).reason).map((c) => c.annotation_id);
}

export class CorrectionPass {
  /**
   * @param {Workspace} ws an editable workspace of kind 'correcting' (its session a CorrectionSession)
   * @param {{target: object, backend: object, onSaved?: Function}} o target: the answer of saved_attempt_get
   */
  constructor(ws, { target, backend, onSaved = null }) {
    this.ws = ws;
    this.s = ws.s;
    this.target = target;
    this.backend = backend;
    this.onSaved = onSaved;
    this.sf = ws.sf;
    this.rule = target.reason_required || 'always';
    this.original = (target.annotations || []).filter((a) => ws.cat.has(a.label));
    this.changes = [];
    this.current = -1;
    this.saved = null;
    this.saving = false;
    this.layerOn = true;
    this.flagged = new Set(); // changes outlined after a Submit without their reasons
    ws.pass = this;
    ws.keyHook = (e) => this.onKey(e);
    ws.el.classList.add('correcting');
    ws.viewer.setLayers([{ id: 'original', annotations: this.original, style: 'dashed', prefix: 'Original: ' }]);
    this._build();
    this._listener = debounce(() => this.refresh(), 60);
    ws.store.addListener(this._listener);
    ws.onDestroy(() => ws.store.removeListener(this._listener));
    this.refresh();
  }

  get reasons() { return this.s.extra.reasons; }

  get changed() { return !this.saved && this.changes.length > 0; }

  _build() {
    const t = this.target;
    const who = `${t.annotator_id}${t.display_name ? ` (${t.display_name})` : ''}`;
    const when = t.saved_at ? new Date(t.saved_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    const others = (t.corrections || []).filter((c) => c.corrector_id !== (this.s.me && this.s.me.annotator_id));
    this.progress = h('p.caption.correction-progress', { 'aria-live': 'polite' });
    this.list = h('ol.review-list.correction-list', { 'aria-label': 'Changes from the saved version' });
    this.overall = h('textarea.field.review-overall', { rows: 2, maxlength: String(MAX_OVERALL), 'aria-label': 'A note on the whole correction (optional)', 'data-log': 'correction-overall' });
    this.overall.value = this.s.extra.overall_note || '';
    this.overall.addEventListener('input', () => { this.s.extra.overall_note = this.overall.value; this.s.saveLocal(); });
    this.layerBtn = h('button.btn.small', { type: 'button', 'data-log': 'correction-layer', 'aria-pressed': 'true', onclick: () => this.toggleLayer('button') }, 'Hide the original');
    this.submitBtn = h('button.btn.primary', { type: 'button', 'data-log': 'correction-submit', title: 'Save the correction as a new version, credited to you (the original stays as it was)',
      onclick: () => this.submit() }, 'Submit the correction');
    this.ws.actionsEl.append(this.submitBtn);
    this.el = h('section.review.card.correction-pass', { 'aria-label': 'Correction' },
      h('h2', {}, `Correction of ${who}`),
      h('p.caption', {}, `Version ${t.attempt}${when ? `, saved ${when}` : ''}. Change, add or remove marks as you would annotate. Your correction is saved as a new version credited to you; ${t.annotator_id}'s version stays as it was.`),
      others.length ? h('p.note.correction-others', {}, `${others.map((c) => c.corrector_id).filter((v, i, a) => a.indexOf(v) === i).join(', ')} corrected this version already. When two experts correct the same version, their corrections are compared and their disagreements adjudicated.`) : null,
      h('div.correction-head', {}, this.progress, this.layerBtn),
      this.list,
      h('label.review-overall-label', {}, h('span', {}, 'A note on the whole correction (optional)'), this.overall),
      h('p.caption.review-keys', {}, `J and K go to the next and previous change, R to its reasons, L shows or hides the original. ${RULE_TEXT[this.rule] || ''}`));
    this.ws.reviewHost.append(this.el);
    this.ws.hintEl.textContent = 'J / K  next, previous change  ·  R  reasons  ·  L  the original  ·  drag: mark as usual';
  }

  /** The list of changes, worked out again from the annotations as they are now. */
  refresh() {
    if (this.ws._destroyed) return;
    const current = this.ws.store.toJSON();
    this.changes = diffAnnotations(this.original, current);
    const ids = new Set(this.changes.map((c) => c.annotation_id));
    for (const id of Object.keys(this.reasons)) if (!ids.has(id)) delete this.reasons[id]; // a change taken back
    for (const id of [...this.flagged]) if (!ids.has(id)) this.flagged.delete(id);
    if (this.current >= this.changes.length) this.current = this.changes.length - 1;
    this._draw();
  }

  _draw() {
    clear(this.list);
    if (!this.changes.length) this.list.append(h('li.caption.correction-empty', {}, 'No changes yet. The dashed outlines show the saved version.'));
    this.rows = this.changes.map((c, i) => this._row(c, i));
    this.list.append(...this.rows);
    const missing = missingReasons(this.changes, this.reasons, this.rule);
    const counts = changeCounts(this.changes);
    this.progress.textContent = this.changes.length
      ? `${plural(this.changes.length, 'change')} (${countsText(counts)})${missing.length ? `, ${missing.length} without a reason` : ', each with its reason'}`
      : 'No changes yet';
    this.submitBtn.disabled = this.saving || !this.changes.length;
  }

  _row(c, i) {
    const r = this.reasons[c.annotation_id] || {};
    const m = c.after || c.before;
    const l = this.ws.cat.get(m.label);
    const missing = needsReason(c.change, this.rule) && !r.reason;
    const chips = Object.entries(REASONS).map(([key, text]) => h('button.seg', { type: 'button', 'aria-pressed': String(r.reason === key), 'data-reason': key,
      'data-log': 'correction-reason', onclick: () => { this.go(i, { quiet: true }); this.setReason(i, r.reason === key ? '' : key, 'button'); } }, text));
    const note = h('input.field.review-note', { type: 'text', maxlength: String(MAX_NOTE), placeholder: 'Note (optional)', value: r.note || '',
      'aria-label': `Note on: ${changeText(c, this.sf)}` });
    note.addEventListener('input', () => {
      const kept = this.reasons[c.annotation_id] || (this.reasons[c.annotation_id] = { reason: '', note: '' });
      kept.note = note.value;
      this.s.saveLocal();
    });
    note.addEventListener('change', () => logger.event('correction_reason_set', { annotation_id: c.annotation_id, change: c.change,
      reason: (this.reasons[c.annotation_id] || {}).reason || null, note_length: note.value.trim().length }));
    note.addEventListener('focus', () => this.go(i, { quiet: true }));
    const head = h('button.review-item-head', { type: 'button', 'data-log': 'correction-change', onclick: () => this.go(i) },
      h('span.swatch', { style: { background: l ? l.colour : '#999999' } }), h('span.chip.correction-kind', { 'data-change': c.change }, c.change),
      h('span.correction-text', {}, changeText(c, this.sf)));
    return h('li.review-row.correction-row', { 'data-id': c.annotation_id, 'data-change': c.change,
      class: [i === this.current ? 'current' : '', missing && this.flagged.has(c.annotation_id) ? 'needs-reason' : ''].filter(Boolean).join(' ') || null },
    head, h('div.segmented.review-marks.reason-chips', { role: 'group', 'aria-label': `Reason for: ${changeText(c, this.sf)}` }, chips), note);
  }

  /** Give change i a reason ('' clears it). */
  setReason(i, reason, via = 'key') {
    const c = this.changes[i];
    if (!c || this.saving) return;
    const kept = this.reasons[c.annotation_id] || (this.reasons[c.annotation_id] = { reason: '', note: '' });
    kept.reason = reason;
    if (reason) this.flagged.delete(c.annotation_id);
    logger.event('correction_reason_set', { annotation_id: c.annotation_id, change: c.change, reason: reason || null,
      note_length: String(kept.note || '').trim().length, via });
    this.s.saveLocal();
    this._draw();
    const row = this.rows[i];
    if (row) {
      const btn = row.querySelector(`[data-reason="${reason}"]`) || row.querySelector('.seg');
      if (via !== 'button' && btn) btn.focus({ preventScroll: true });
    }
  }

  /** Make change i the current one, and show it on the EEG. */
  go(i, { quiet = false } = {}) {
    if (i < 0 || i >= this.changes.length) return;
    this.current = i;
    this.rows.forEach((row, k) => row.classList.toggle('current', k === i));
    this.rows[i].scrollIntoView({ block: 'nearest' });
    const c = this.changes[i];
    if (quiet) return;
    if (c.after && this.ws.store.has(c.annotation_id)) this.ws.jumpTo(c.annotation_id);
    else this.ws.viewer.showInterval(c.before.onset_sample, c.before.duration_samples, []);
    this.ws.say(`${i + 1} of ${this.changes.length}: ${changeText(c, this.sf)}. R gives its reason.`);
  }

  step(delta) {
    if (!this.changes.length) { this.ws.say('No changes yet'); return; }
    const next = this.current >= 0 ? this.current + delta : delta > 0 ? 0 : this.changes.length - 1;
    if (next < 0 || next >= this.changes.length) { this.ws.say(delta > 0 ? 'That was the last change' : 'That was the first change'); return; }
    this.go(next);
  }

  toggleLayer(via = 'key') {
    this.layerOn = this.ws.viewer.toggleLayer('original');
    this.layerBtn.textContent = this.layerOn ? 'Hide the original' : 'Show the original';
    this.layerBtn.setAttribute('aria-pressed', String(this.layerOn));
    logger.event('state', { original_layer: this.layerOn, via });
    this.ws.say(this.layerOn ? 'The original version is shown as dashed outlines (L hides it).' : 'The original version is hidden (L shows it again).');
  }

  /** J, K, R and L; true when the key was taken. */
  onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = String(e.key).toLowerCase();
    const take = (action, fn) => { e.preventDefault(); logger.shortcut(keyName(e), action); fn(); return true; };
    if (k === 'j') return take('Next change', () => this.step(1));
    if (k === 'k') return take('Previous change', () => this.step(-1));
    if (k === 'l') return take('Show or hide the original', () => this.toggleLayer('key'));
    if (k === 'r') {
      return take('Reason', () => {
        if (this.current < 0) this.step(1);
        const row = this.rows[this.current];
        if (!row) return;
        const r = (this.reasons[this.changes[this.current].annotation_id] || {}).reason;
        (row.querySelector(`[data-reason="${r}"]`) || row.querySelector('.seg')).focus();
      });
    }
    return false;
  }

  async submit() {
    if (this.saving || this.saved) return;
    this.refresh();
    if (!this.changes.length) { this.ws.say('Nothing has changed from the saved version yet.'); return; }
    const missing = missingReasons(this.changes, this.reasons, this.rule);
    if (missing.length) {
      for (const id of missing) this.flagged.add(id);
      this._draw();
      const i = this.changes.findIndex((c) => c.annotation_id === missing[0]);
      this.go(i);
      this.ws.say(`Give a reason for each change first: ${plural(missing.length, 'change has', 'changes have')} none yet.`);
      return;
    }
    const counts = changeCounts(this.changes);
    const t = this.target;
    if (!(await ask('Submit the correction?', `${plural(this.changes.length, 'change')}: ${countsText(counts)}.\n\nIt is saved as a new version of ${t.annotator_id}'s work, credited to you. Their version ${t.attempt} stays as it was.`,
      { yes: 'Submit the correction', no: 'Keep correcting' }))) return;
    if (!this.s.extra.correction_id) {
      this.s.extra.correction_id = newId(); // kept until the study has the correction, also in this browser
      this.s.saveLocal();
    }
    this.saving = true;
    this.submitBtn.disabled = true;
    this.submitBtn.textContent = 'Saving…';
    let out;
    try {
      out = await this.backend.expert('correction_save', correctionBody({
        correctionId: this.s.extra.correction_id, target: t, annotations: this.ws.store.toJSON(), changes: this.changes, reasons: this.reasons,
        overall: this.overall.value, session: { ...this.s.sessionInfo(this.ws.app.visitId), session_id: this.s.sessionId }, sha256: this.s.sha256,
      }));
    } catch (exc) {
      this.saving = false;
      this.submitBtn.textContent = 'Submit the correction';
      this.submitBtn.disabled = false;
      await this._refused(exc);
      return;
    }
    this.saved = out.correction;
    this.s.finished = true;
    this.s.forgetLocal();
    logger.event('correction_submitted', { ...counts, elapsed_s: Math.round(this.s.elapsedS * 1000) / 1000, already: Boolean(out.already),
      correction_id: out.correction.correction_id, n_corrections_of_version: out.correction.n_corrections_of_version });
    const more = out.correction.n_corrections_of_version > 1
      ? `\n\nThis version now has ${out.correction.n_corrections_of_version} experts' corrections. They are compared, and their disagreements go to adjudication.` : '';
    await inform('Correction saved', `Your correction of ${t.annotator_id}'s ${t.file_name} is saved as a new version: ${countsText(counts)}.${more}`);
    if (this.onSaved) await this.onSaved(out);
  }

  async _refused(exc) {
    if (exc.status === 401) return;
    if (exc.code === 'reason_missing' && Array.isArray(exc.body && exc.body.annotation_ids)) {
      for (const id of exc.body.annotation_ids) this.flagged.add(id);
      this._draw();
    }
    if (['not_latest', 'own_work', 'corrections_off', 'conflict'].includes(exc.code)) {
      await inform('The correction was not saved', exc.message);
      return;
    }
    // No answer, or the study failed once: the correction may have been kept all the same; pressing Submit
    // again sends the same correction, which the study keeps once.
    const lost = exc.status === 0 || exc.status >= 500 || exc.code === 'busy';
    await inform('The correction was not saved', lost
      ? `${exc.message}\n\nYour changes are still open and kept in this browser. Press Submit the correction again: if the study did keep it, it is not saved twice.`
      : `${exc.message}\n\nYour changes are still open.`);
  }

  /** Before leaving: keep the correction in this browser for later, discard it, or carry on. */
  async beforeClose() {
    if (this.saving) { this.ws.say('Saving the correction: wait for the study\'s answer before you leave.'); return false; }
    if (!this.changed) { logger.event('correction_left', { n_changes: 0, kept: false }); return true; }
    const later = 'Keep it in this browser';
    const discard = 'Discard the correction';
    const stay = 'Keep correcting';
    const c = await choose('Leave the correction?', `${later}: your ${plural(this.changes.length, 'change')} and reasons stay in this browser, and come back when you correct this version again.\n\n`
      + `${discard}: your changes are deleted, and ${this.target.annotator_id}'s version stays as it was.`, [later, discard, stay], 0);
    if (c === stay) return false;
    if (c === discard) this.s.forgetLocal(); else this.s.saveLocal();
    logger.event('correction_left', { n_changes: this.changes.length, kept: c !== discard });
    this.s.close();
    return true;
  }
}

/** Open the correction view for a file checked against the study's copy (js/views/purposes.js, purpose correct). */
export async function openCorrection(app, { recording, fp, view, target }) {
  const t = target;
  let session;
  try {
    session = new CorrectionSession({ backend: app.backend, recording, manifest: t.manifest, recordingId: t.recording_id, mode: 'standard', contextId: '',
      me: app.me, catalogue: app.catalogue, sha256: fp.hex, target: t });
    session.store.reset((t.annotations || []).filter((a) => app.catalogue.has(a.label)));
  } catch (exc) {
    view.showProblem(exc.message, [view.chooseAgainButton()]);
    return null;
  }
  const kept = session.keptDraft();
  if (kept && (kept.annotations.length !== (t.annotations || []).length || JSON.stringify(kept.annotations) !== JSON.stringify(session.store.toJSON()) || kept.correction_id)) {
    const go = await ask('Carry on with your correction?', `You started correcting this version ${kept.saved_at ? `on ${new Date(kept.saved_at).toLocaleString('en-GB', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}` : 'earlier'}, in this browser.\n\nCarry on from there, or start again from the saved version?`,
      { yes: 'Carry on', no: 'Start again' });
    if (!app._stillOpen(view)) return null;
    if (go) {
      session.restore(kept);
      session.extra = { correction_id: kept.correction_id || null, reasons: { ...(kept.reasons || {}) }, overall_note: kept.overall_note || '' };
      if (kept.view) session.view = kept.view;
    } else {
      session.forgetLocal();
    }
  }
  if (app.ws) app.ws.destroy();
  const back = view.purpose.back || { key: 'work', params: null };
  const leave = async (ws) => {
    ws.destroy();
    if (app.ws === ws) app.ws = null;
    await app.showExpert(back.route || 'expert-work', back.params || null);
  };
  const ws = new Workspace(app, session, { kind: 'correcting', onLeave: leave });
  app.ws = ws;
  app._render(ws.el, 'expert-correct');
  ws.mount(app.content);
  logger.event('correction_started', { annotator_id: t.annotator_id, recording_id: t.recording_id, attempt: t.attempt, n_annotations: (t.annotations || []).length,
    session_id: session.sessionId, resumed: session.resumed, at: nowLocalIso() });
  ws.logSnapshot('correction');
  const pass = new CorrectionPass(ws, { target: t, backend: app.backend, onSaved: () => leave(ws) });
  return pass;
}
