// Correct the marks (docs/web/using.md, "Learn with the experts"): the annotation view opens with a
// copy of the experts' marks in which some are deliberately wrong or missing, and a panel that says so.
//
// For a trainee, this is a guided recording whose guidance is "correct": the guided coach hands over to
// CorrectPanel (GUIDANCE_PANELS in coach.js), the trainee corrects the marks freely and saves with Save
// and Finish, and the study scores the corrections (electrotag/web/correct_marks.py); afterSaved opens a
// review of the saved marks on the EEG (CorrectionsReview), as practice has one: how many planted mistakes
// were fixed, and each mistake, fixed or not, which N and P (or a press on it) go to. The training path's
// card says the result afterwards. For an expert trying an exercise
// (js/expert/planted.js, purpose "planted"), nothing is saved: Check my corrections scores them in the
// browser (planted_scoring.js, the same rules as the study's), and the experts' marks can be shown as
// dashed outlines.
//
// Log events: planted_opened {mode, n_planted, restored}, planted_checked {fixed, n_errors, new_mistakes},
// planted_reference_layer {shown}, planted_item_jumped {kind, fixed}, planted_restarted, planted_result_shown
// {fixed, n_errors, new_mistakes}, planted_review_item {kind, fixed, item}.

import { h, clear } from '../ui/dom.js';
import { showDialog } from '../ui/dialog.js';
import { loadParts } from '../lazy.js';
import { logger } from '../log/logger.js';
import { icon } from '../views/common.js';
import { DEMO_NOTICE } from '../api/notice.js';
import { GUIDANCE_PANELS } from './coach.js';
import { scoreCorrections } from './planted_scoring.js';

const KIND_WORDS = { missing: 'Left out', type: 'Wrong type', boundary: 'Start or end moved', extra: 'Not an artifact', channels: 'Channels',
  broken: 'A right mark changed', added: 'Marked where there is none' };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** A planted mistake's heading: "Left out: fixed", "Left out: not fixed"; a new mistake's: "Marked where there is none". */
export function itemHeading(it, fixed, planted = true) {
  const what = KIND_WORDS[it.kind] || it.kind;
  return planted ? `${what}: ${fixed ? 'fixed' : 'not fixed'}` : what;
}

/** The planted mistakes, then any new ones, in the order of the list: [{it, fixed, planted}]. */
export function resultRows(score) {
  return [...(score.items || []).map((it) => ({ it, fixed: Boolean(it.fixed), planted: true })),
    ...(score.new || []).map((it) => ({ it, fixed: false, planted: false }))];
}

/** The list of what was fixed and what was not, each going to its moment of the EEG when pressed. */
export function resultList(score, onJump = null) {
  const row = ({ it, fixed, planted }, i) => {
    const li = h(`li.planted-item${fixed ? '.fixed' : '.not-fixed'}`, { 'data-kind': it.kind, 'data-row': String(i) },
      icon(fixed ? 'check' : 'close'),
      h('span.planted-text', {}, h('b', {}, itemHeading(it, fixed, planted)), ' ', it.detail || ''));
    if (onJump) {
      li.append(h('button.btn.quiet.small', { type: 'button', 'data-log': 'planted-jump', onclick: () => onJump(it, fixed, i) }, 'Show'));
    }
    return li;
  };
  const rows = resultRows(score);
  const nPlanted = (score.items || []).length;
  return h('div.planted-result', {},
    h('ul.planted-items', { 'aria-label': 'The planted mistakes' }, rows.slice(0, nPlanted).map((r, i) => row(r, i))),
    rows.length > nPlanted ? h('p.caption', {}, 'New mistakes') : null,
    rows.length > nPlanted ? h('ul.planted-items', { 'aria-label': 'New mistakes' }, rows.slice(nPlanted).map((r, i) => row(r, nPlanted + i))) : null);
}

/**
 * The review after Save and Finish of an exercise: the saved marks on the EEG, read only, and beside them how
 * many planted mistakes were fixed and each mistake, fixed or not; N and P (or Show) go to each in turn.
 */
export class CorrectionsReview {
  constructor(ws, planted) {
    this.ws = ws;
    this.planted = planted;
    this.rows = resultRows(planted);
    this.row = -1;
    ws.review = this;
    const fixedAll = planted.fixed === planted.n_errors && !planted.new_mistakes;
    this.list = resultList(planted, (it, fixed, i) => this.go(i));
    this.el = h('section.review.card.corrections-review', { 'aria-label': 'Your corrections' },
      h('h2', {}, 'Your corrections'),
      h(`p.verdict.${fixedAll ? 'passed' : 'not-yet'}`, {}, planted.message || ''),
      this.rows.length ? h('p.caption', {}, 'Press an item, or N and P, to go to it on the EEG. Your saved marks are shown.') : null,
      this.list);
    ws.reviewHost.appendChild(this.el);
    logger.event('planted_result_shown', { fixed: planted.fixed, n_errors: planted.n_errors, new_mistakes: planted.new_mistakes });
  }

  go(i) {
    if (i < 0 || i >= this.rows.length) return;
    const { it, fixed } = this.rows[i];
    this.row = i;
    for (const li of this.list.querySelectorAll('li[data-row]')) li.classList.toggle('current', li.dataset.row === String(i));
    const li = this.list.querySelector(`li[data-row="${i}"]`);
    if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
    const sf = this.ws.sf;
    const a = Math.round(Number(it.onset_s) * sf);
    const b = Math.round(Number(it.offset_s) * sf);
    this.ws.viewer.showInterval(a, Math.max(1, b - a), []);
    logger.event('planted_review_item', { kind: it.kind, fixed, item: i + 1 });
  }

  step(delta) {
    const next = this.row >= 0 ? this.row + delta : delta > 0 ? 0 : this.rows.length - 1;
    this.go(Math.min(Math.max(0, next), this.rows.length - 1));
  }
}

/** Open the review of a saved exercise (the trainee's session, still holding its recording). */
export async function openCorrectionsReview(app, session, planted) {
  const [{ AnnotationSession }, { Workspace }] = await loadParts('session', 'workspace');
  const rs = new AnnotationSession({
    backend: app.backend, recording: session.recording, manifest: session.manifest, recordingId: session.recordingId,
    mode: 'review', contextId: session.contextId, me: app.me, catalogue: app.catalogue, readOnly: true,
  });
  rs.store.reset(session.store.toJSON().filter((a) => app.catalogue.has(a.label)));
  rs.view = session.view;
  const ws = new Workspace(app, rs, { kind: 'review' });
  const chip = ws.el.querySelector('.ws-header .chip');
  if (chip) chip.textContent = 'Corrections review'; // the review of practice says "Practice review"
  app.ws = ws;
  app._render(ws.el, 'review');
  ws.mount(app.content);
  const review = new CorrectionsReview(ws, planted);
  ws.logOpened({ recording_id: session.recordingId, segment: 'corrections_review' });
  return review;
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

  /** After Save and Finish (app.afterSave): the review of the corrections on the EEG, then the training path. */
  async afterSaved(app, result) {
    const g = (result && result.guided) || {};
    const p = (g.feedback && g.feedback.planted) || null;
    app.pathMessage = g.message || 'Recording saved.';
    if (p) {
      try {
        await openCorrectionsReview(app, this.ws.s, p);
        return;
      } catch {
        // the review's parts could not be loaded: the result in a dialog instead
        await showDialog({ title: 'Your corrections', logText: p.message, className: 'planted-dialog',
          body: h('div', {}, h('p.dialog-text', {}, p.message), resultList(p)),
          buttons: [{ label: 'Back to my training path', value: true, kind: 'primary' }], cancelValue: true });
      }
    }
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
