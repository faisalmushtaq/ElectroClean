// Correct the marks (docs/web/using.md, "Learn with the experts"): the annotation view opens with a
// copy of the experts' marks in which some are deliberately wrong or missing, and a panel that says so.
//
// For a trainee, this is a guided recording whose guidance is "correct": the guided coach hands over to
// CorrectPanel (GUIDANCE_PANELS in coach.js), the trainee corrects the marks freely and saves with Save
// and Finish, and the study scores the corrections (electrotag/web/correct_marks.py); afterSaved shows
// how many planted mistakes were fixed and what is still wrong. For an expert trying an exercise
// (js/expert/planted.js, purpose "planted"), nothing is saved: Check my corrections scores them in the
// browser (planted_scoring.js, the same rules as the study's), and the experts' marks can be shown as
// dashed outlines.
//
// Log events: planted_opened {mode, n_planted, restored}, planted_checked {fixed, n_errors, new_mistakes},
// planted_reference_layer {shown}, planted_item_jumped {kind, fixed}, planted_restarted, planted_result_shown
// {fixed, n_errors, new_mistakes}.

import { h, clear } from '../ui/dom.js';
import { showDialog } from '../ui/dialog.js';
import { logger } from '../log/logger.js';
import { icon } from '../views/common.js';
import { DEMO_NOTICE } from '../api/notice.js';
import { GUIDANCE_PANELS } from './coach.js';
import { scoreCorrections } from './planted_scoring.js';

const KIND_WORDS = { missing: 'Left out', type: 'Wrong type', boundary: 'Start or end moved', extra: 'Not an artifact', channels: 'Channels',
  broken: 'A right mark changed', added: 'Marked where there is none' };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The list of what was fixed and what was not, each going to its moment of the EEG when pressed. */
export function resultList(score, onJump = null) {
  const row = (it, fixed) => {
    const li = h(`li.planted-item${fixed ? '.fixed' : '.not-fixed'}`, { 'data-kind': it.kind },
      icon(fixed ? 'check' : 'close'),
      h('span.planted-text', {}, h('b', {}, `${KIND_WORDS[it.kind] || it.kind}${fixed ? ': fixed' : ''}`), ' ', it.detail || ''));
    if (onJump) {
      li.append(h('button.btn.quiet.small', { type: 'button', 'data-log': 'planted-jump', onclick: () => onJump(it, fixed) }, 'Show'));
    }
    return li;
  };
  return h('div.planted-result', {},
    h('ul.planted-items', { 'aria-label': 'The planted mistakes' }, (score.items || []).map((it) => row(it, it.fixed))),
    (score.new || []).length ? h('p.caption', {}, 'New mistakes') : null,
    (score.new || []).length ? h('ul.planted-items', { 'aria-label': 'New mistakes' }, score.new.map((it) => row(it, false))) : null);
}

export class CorrectPanel {
  /**
   * @param ws the annotation view
   * @param o {mode: 'trainee' | 'try', view: {start_annotations, instruction, n_planted}, backend, recordingId,
   *   target (try: planted_get's answer, with the reference and the mistakes)}
   */
  constructor(ws, { mode = 'trainee', view, backend, recordingId, target = null }) {
    this.ws = ws;
    this.mode = mode;
    this.view = view || {};
    this.backend = backend;
    this.rid = recordingId;
    this.target = target;
    this.summary = null;
    this.complete = true;
    this.layerOn = false;
    this._build();
  }

  _build() {
    const n = Number(this.view.n_planted) || 0;
    this.feedback = h('div.coach-feedback', { role: 'status', 'aria-live': 'polite', hidden: true });
    this.resultHost = h('div.planted-host');
    this.checkBtn = this.mode === 'try'
      ? h('button.btn.primary', { type: 'button', 'data-log': 'planted-check', onclick: () => this.check() }, 'Check my corrections') : null;
    this.layerBtn = this.mode === 'try'
      ? h('button.btn.small', { type: 'button', 'data-log': 'planted-layer', 'aria-pressed': 'false', onclick: () => this.toggleReference() }, "Show the experts' marks") : null;
    this.restartBtn = this.mode === 'try'
      ? h('button.btn.quiet.small', { type: 'button', 'data-log': 'planted-restart', onclick: () => this.restart() }, 'Start again') : null;
    for (const b of [this.checkBtn, this.layerBtn, this.restartBtn].filter(Boolean)) b.addEventListener('mousedown', (e) => e.preventDefault());
    this.el = h('section.coach.card.planted-panel', { 'aria-label': 'Correct the marks' },
      h('div.coach-scroll', {},
        h('p.caption.coach-header', {}, this.mode === 'try' ? 'Trying the exercise: nothing is saved' : 'Learn with the experts'),
        h('h2.coach-title', {}, 'Correct the marks'),
        this.feedback,
        h('p.coach-body', {}, this.mode === 'try'
          ? String(this.view.instruction || '').replace('Then press Save and Finish to see how you did.', 'Then press Check my corrections to see how a trainee would do.')
          : this.view.instruction || ''),
        n ? h('p.caption', {}, `The experts' marks are shown with ${plural(n, 'deliberate mistake')}.`) : null,
        this.resultHost,
        this.backend && this.backend.isDemo ? h('p.caption.demo-note', {}, DEMO_NOTICE) : null),
      this.mode === 'try' ? h('div.coach-buttons', {}, this.restartBtn, this.layerBtn, this.checkBtn) : null);
  }

  async start() {
    this.ws.coachHost.appendChild(this.el);
    const restored = this.ws.store.size > 0 && this.mode === 'trainee';
    if (!restored) this._fill();
    logger.event('planted_opened', { mode: this.mode, n_planted: Number(this.view.n_planted) || 0, restored });
  }

  /** The copy of the experts' marks, as the exercise starts. */
  _fill() {
    const cat = this.ws.app && this.ws.app.catalogue;
    const anns = (this.view.start_annotations || []).filter((a) => !cat || cat.has(a.label)).map((a) => ({ ...a, channels: [...(a.channels || [])] }));
    this.ws.store.reset(anns);
    this.ws.logSnapshot('correct');
  }

  restart() {
    this._fill();
    clear(this.resultHost);
    this.feedback.hidden = true;
    logger.event('planted_restarted', {});
  }

  /** The expert's try: score the marks now on screen against the exercise's mistakes. */
  check() {
    const t = this.target || {};
    const p = t.planted || {};
    const sf = Number((t.manifest || {}).sfreq) || this.ws.sf;
    const score = scoreCorrections(p.errors || [], [...this.ws.store.annotations()], t.reference || [], sf, t.tolerance || undefined, p.annotations || []);
    this.score = score;
    this._feedback(score.message, score.fixed === score.n_errors && !score.new_mistakes ? 'success' : 'banner');
    clear(this.resultHost);
    this.resultHost.append(resultList(score, (it, fixed) => this.jump(it, fixed)));
    logger.event('planted_checked', { fixed: score.fixed, n_errors: score.n_errors, new_mistakes: score.new_mistakes });
    return score;
  }

  jump(it, fixed) {
    const sf = this.ws.sf;
    const a = Math.round(it.onset_s * sf);
    const b = Math.round(it.offset_s * sf);
    this.ws.viewer.showInterval(a, Math.max(1, b - a), []);
    logger.event('planted_item_jumped', { kind: it.kind, fixed });
  }

  toggleReference() {
    const t = this.target || {};
    if (!this.layerSet) {
      this.ws.viewer.setLayers([{ id: 'reference', annotations: t.reference || [], style: 'dashed', prefix: 'Experts: ', visible: false }]);
      this.layerSet = true;
    }
    this.layerOn = this.ws.viewer.toggleLayer('reference');
    this.layerBtn.setAttribute('aria-pressed', String(this.layerOn));
    this.layerBtn.textContent = this.layerOn ? "Hide the experts' marks" : "Show the experts' marks";
    logger.event('planted_reference_layer', { shown: this.layerOn });
  }

  _feedback(text, kind) {
    this.feedback.hidden = false;
    this.feedback.className = `coach-feedback ${kind}`;
    this.feedback.textContent = text;
  }

  // ------------------------------------------------- what the annotation view asks of its coach
  scheduleCheck() {}
  onView() {}
  canShowMe() { return false; }
  showMe() {}
  takesContinueKey() { return false; }
  continue() {}
  addPaused() {}
  refresh() {}
  canSave() { return this.mode === 'trainee'; }
  syncSaveButton(btn) {
    btn.disabled = false;
    btn.title = 'Save your corrections and see how many of the planted mistakes you fixed';
  }

  /** After Save and Finish (app.afterSave): how the trainee did, then the training path. */
  async afterSaved(app, result) {
    const g = (result && result.guided) || {};
    const p = (g.feedback && g.feedback.planted) || null;
    if (p) {
      logger.event('planted_result_shown', { fixed: p.fixed, n_errors: p.n_errors, new_mistakes: p.new_mistakes });
      await showDialog({ title: 'Your corrections', logText: p.message, className: 'planted-dialog',
        body: h('div', {}, h('p.dialog-text', {}, p.message), resultList(p)),
        buttons: [{ label: 'Back to my training path', value: true, kind: 'primary' }], cancelValue: true });
    }
    app.pathMessage = g.message || 'Recording saved.';
    await app.showTraining();
  }

  destroy() { this.el.remove(); }
}

GUIDANCE_PANELS.correct = (ws, o) => new CorrectPanel(ws, { ...o, mode: 'trainee' });

/**
 * The expert's try of an exercise (purpose "planted", js/views/purposes.js): the file is the study's copy of
 * the guided recording; it opens as a try-out (nothing saved) with the exercise's copy of the marks.
 */
export async function openPlantedTry(app, { recording, fp, view, target }) {
  const parts = await app._openingParts(['session', 'workspace'], () => openPlantedTry(app, { recording, fp, view, target }));
  if (!parts || !app._stillOpen(view)) return null;
  const [{ AnnotationSession }, { Workspace }] = parts;
  const t = target;
  let session;
  try {
    session = new AnnotationSession({ backend: app.backend, recording, manifest: null, recordingId: recording.fileName, mode: 'tryout', contextId: '',
      me: app.me, catalogue: app.catalogue, sha256: fp.hex });
  } catch (exc) {
    view.showProblem(exc.message, [view.chooseAgainButton()]);
    return null;
  }
  if (app.ws) app.ws.destroy();
  const ws = new Workspace(app, session, { kind: 'tryout' });
  app.ws = ws;
  app._render(ws.el, 'expert-planted-try');
  ws.mount(app.content);
  const p = t.planted || {};
  const panel = new CorrectPanel(ws, { mode: 'try', backend: app.backend, recordingId: t.recording_id, target: t,
    view: { start_annotations: p.annotations || [], instruction: t.instruction, n_planted: p.n_errors || 0 } });
  ws.coach = panel;
  await panel.start();
  ws._refreshState();
  ws.logOpened({ recording_id: t.recording_id, segment: 'planted', set_id: t.set_id });
  return ws;
}
