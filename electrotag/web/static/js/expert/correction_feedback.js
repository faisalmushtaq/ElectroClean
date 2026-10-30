// What an annotator sees of an expert's correction of their work (docs/web/using.md, "Corrections of
// your work"), when the study shows corrections to its annotators: the corrected version, read only,
// with their own saved version as dashed outlines beside it, and the changes listed with the
// expert's reasons in the side panel. The marks and chips are in the accent blue, never red: a
// correction is something to learn from. N and P step through the changes; Open to revise starts a
// revision of their latest version when the study allows revisions.

import { h } from '../ui/dom.js';
import { logger, keyName } from '../log/logger.js';
import { AnnotationSession } from '../annotate/session.js';
import { Workspace } from '../annotate/workspace.js';
import { changeText, countsText } from './diff.js';

export class CorrectionFeedback {
  /**
   * @param {Workspace} ws a read-only workspace of kind 'corrected'
   * @param {{correction: object, onRevise?: Function|null}} o correction: the answer of my_correction_get
   */
  constructor(ws, { correction, onRevise = null }) {
    this.ws = ws;
    this.c = correction;
    this.changes = correction.changes || [];
    this.row = -1;
    ws.pass = this;
    ws.keyHook = (e) => this.onKey(e);
    ws.viewer.setLayers([{ id: 'original', annotations: correction.original || [], style: 'dashed', prefix: 'Yours: ' }]);
    this._build(onRevise);
    logger.event('correction_feedback_shown', { correction_id: correction.correction_id, recording_id: correction.recording_id,
      attempt: correction.attempt, n_changes: this.changes.length });
  }

  _build(onRevise) {
    const c = this.c;
    const when = c.corrected_at ? new Date(c.corrected_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    this.items = this.changes.map((ch, i) => h('li.feedback-row.correction-feedback-row', { 'data-change': ch.change, tabindex: '0', 'data-log': 'correction-feedback-item',
      onclick: () => this.go(i), onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.go(i); } } },
    h('span.chip.feedback-chip', {}, ch.reason_text || ch.change),
    h('span.feedback-text', {}, changeText(ch, this.ws.sf)),
    ch.note ? h('span.feedback-note', {}, ch.note) : null));
    this.el = h('section.review.card.feedback-panel.correction-feedback', { 'aria-label': 'The correction of your work' },
      h('h2', {}, 'The correction of your work'),
      h('p.caption', {}, `${c.corrector_name || c.corrector_id} corrected your version ${c.attempt}${when ? ` on ${when}` : ''}: ${countsText(c.counts || {})}. `
        + 'The marks on the EEG are the corrected version; the dashed outlines are yours, where they differ.'),
      this.items.length ? h('ol.feedback-list', { 'aria-label': 'The changes, in the order of the recording' }, this.items) : null,
      c.overall_note ? h('p.feedback-overall', {}, h('b', {}, 'Overall: '), c.overall_note) : null,
      c.n_corrections_of_version > 1 ? h('p.caption', {}, `${c.n_corrections_of_version} experts corrected this version; where they disagree, the study adjudicates.`) : null,
      h('p.caption', {}, c.of_latest === false ? 'You have saved this recording again since; this correction is of an earlier version.'
        : 'N and P go to the next and previous change. It is for you to judge what to change in your own work.'));
    this.ws.reviewHost.append(this.el);
    this.ws.hintEl.textContent = 'N / P  next, previous change  ·  the dashed outlines are your version';
    if (onRevise && this.ws.actionsEl) {
      this.ws.actionsEl.append(h('button.btn.primary', { type: 'button', 'data-log': 'correction-feedback-revise', onclick: () => onRevise() }, 'Open to revise'));
    }
  }

  go(i) {
    if (i < 0 || i >= this.changes.length) return;
    this.row = i;
    const ch = this.changes[i];
    this.items.forEach((li, k) => li.classList.toggle('current', k === i));
    this.items[i].scrollIntoView({ block: 'nearest' });
    if (ch.after && this.ws.store.has(ch.annotation_id)) this.ws.jumpTo(ch.annotation_id);
    else this.ws.viewer.showInterval(ch.before.onset_sample, ch.before.duration_samples, []);
    logger.event('correction_feedback_item_jumped', { correction_id: this.c.correction_id, change: ch.change, reason: ch.reason || null, item: i + 1 });
  }

  step(delta) {
    if (!this.changes.length) return;
    const next = this.row >= 0 ? this.row + delta : delta > 0 ? 0 : this.changes.length - 1;
    this.go(Math.min(Math.max(0, next), this.changes.length - 1));
  }

  onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = String(e.key).toLowerCase();
    if (k !== 'n' && k !== 'p') return false;
    e.preventDefault();
    logger.shortcut(keyName(e), k === 'n' ? 'Next change' : 'Previous change');
    this.step(k === 'n' ? 1 : -1);
    return true;
  }
}

/** Open the annotator's view of a correction for a file checked against the study's copy (purpose corrected). */
export async function openCorrected(app, { recording, fp, view, target }) {
  const c = target;
  let session;
  try {
    session = new AnnotationSession({ backend: app.backend, recording, manifest: c.manifest, recordingId: c.recording_id, mode: 'standard', contextId: '',
      me: app.me, catalogue: app.catalogue, sha256: fp.hex, readOnly: true });
    session.store.reset((c.annotations || []).filter((a) => app.catalogue.has(a.label)));
  } catch (exc) {
    view.showProblem(exc.message, [view.chooseAgainButton()]);
    return null;
  }
  if (app.ws) app.ws.destroy();
  const ws = new Workspace(app, session, { kind: 'corrected', onLeave: (w) => app.leaveRecording(w, 'correction feedback closed') });
  app.ws = ws;
  app._render(ws.el, 'annotate');
  ws.mount(app.content);
  const item = ((app.assignments && app.assignments.items) || []).find((i) => i.recording_id === c.recording_id && (i.mode || 'standard') === 'standard');
  const ann = app.me && app.me.study && app.me.study.annotation;
  const revise = item && item.status === 'done' && ann && ann.allow_revisions && typeof app._reviseFromFeedback === 'function'
    ? () => app._reviseFromFeedback(ws, recording, fp.hex) : null;
  return new CorrectionFeedback(ws, { correction: c, onRevise: revise });
}
