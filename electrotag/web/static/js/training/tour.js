// The platform tour, the first stage of the training path ("Find your way around"): a short, hands-on
// tour of the annotation view on a practice recording made in the browser (js/eeg/synthetic.js), so
// no file is needed and nothing is saved. Each step names the keys and controls to use, as the guided
// coach does (training/rules.js), and is done for real: it is ticked when the tour sees it happen in
// the annotation view (a mark of the right type on the outlined artifact, the channels chosen, an
// undo, a rating, Save and Finish). "Skip this step" goes on without it. When the last step is done
// the tour tells the study (POST /training/stage {tour, done}, never sent twice by itself) and the
// training path comes back. The steps' rules are pure functions (tourSteps, stepDone), tested in Node
// (web_tests/unit/ui_tour.test.mjs).

import { h, clear, richText } from '../ui/dom.js';
import { ask } from '../ui/dialog.js';
import { logger } from '../log/logger.js';
import { chooseTypeText, scopeText, touchWords } from './rules.js';
import { touchFirst } from '../util.js';
import { makeSyntheticRecording } from '../eeg/synthetic.js';
import { loadParts } from '../lazy.js';

/** The tour's practice recording: thirty seconds of simulated EEG with a blink and a burst of muscle activity. */
export const TOUR_SPEC = Object.freeze({
  id: 'tour', stem: 'sub-tour_task-practice', sfreq: 250, durationS: 30, seed: 5,
  artifacts: [
    ['Eye-blink-artifact', 3.0, 0.4, ['Fp1', 'Fp2', 'VEOG']],
    ['EMG-artifact', 6.5, 1.5, ['T7', 'T8']],
    ['Eye-blink-artifact', 14.0, 0.4, ['Fp1', 'Fp2', 'VEOG']],
  ],
});

/** The artifacts the tour points at, in samples (the blink at 3 s and the muscle burst at 6.5 s). */
export function tourTargets(sfreq = TOUR_SPEC.sfreq) {
  const t = (i) => {
    const [label, onset, dur, channels] = TOUR_SPEC.artifacts[i];
    return { label, onset_sample: Math.round(onset * sfreq), duration_samples: Math.round(dur * sfreq), channels: [...channels] };
  };
  return { blink: t(0), muscle: t(1) };
}

/** The share of the target's time an annotation covers, of their union (0 when they do not overlap). */
export function overlapShare(a, target) {
  const a0 = a.onset_sample;
  const a1 = a.onset_sample + a.duration_samples;
  const t0 = target.onset_sample;
  const t1 = target.onset_sample + target.duration_samples;
  const inter = Math.max(0, Math.min(a1, t1) - Math.max(a0, t0));
  return inter / (Math.max(a1, t1) - Math.min(a0, t0));
}

const covers = (a, target) => a.label === target.label && overlapShare(a, target) >= 0.3;

/**
 * The steps: {key, title, body, ghost?: target, done(obs)}. `obs` is what the tour has seen:
 * {annotations, startS, maxStartS, undone, saved}. `quickKeys` maps a type to its number key.
 */
export function tourSteps({ quickKeys = {}, sfreq = TOUR_SPEC.sfreq } = {}) {
  const { blink, muscle } = tourTargets(sfreq);
  return [
    { key: 'move', title: 'Move through the recording',
      body: 'Each row is one channel, named at the left of the EEG, and time runs from left to right.\n' +
        '1. Press the **right arrow** key to see the next stretch of the recording (or drag the bar under the EEG).\n' +
        '2. Press the **left arrow** key to come back to the start.',
      done: (o) => o.maxStartS > 0.5 && o.startS < 0.5 },
    { key: 'mark', title: `Mark this ${blink.label}`, ghost: blink,
      body: 'The blink is outlined with a dashed line. To mark it:\n' +
        `1. ${chooseTypeText(blink.label, quickKeys)}\n` +
        `2. ${scopeText([])}\n` +
        '3. Drag across the EEG from the start of the outline to its end.',
      done: (o) => o.annotations.some((a) => covers(a, blink)) },
    { key: 'channels', title: `Mark the ${muscle.label} on its channels`, ghost: muscle,
      body: 'Muscle activity shows on a few channels only, so it is marked on those:\n' +
        `1. ${chooseTypeText(muscle.label, quickKeys)}\n` +
        `2. ${scopeText(muscle.channels)}\n` +
        '3. Drag across the EEG from the start of the outline to its end.',
      done: (o) => o.annotations.some((a) => covers(a, muscle) && muscle.channels.every((c) => (a.channels || []).includes(c))) },
    { key: 'undo', title: 'Take back a change',
      body: 'Press **Ctrl+Z** (**⌘Z** on a Mac), or click **Undo** at the top, to take back your last change. ' +
        '**Ctrl+Y** (or **Redo**) brings it back.',
      done: (o) => o.undone },
    { key: 'confidence', title: 'Say how sure you are',
      body: `1. Click your ${blink.label} on the EEG to select it.\n` +
        '2. Press **D**, then a number from **1** (a guess) to **5** (certain).',
      done: (o) => o.annotations.some((a) => a.confidence !== null && a.confidence !== undefined) },
    { key: 'save', title: 'Save and finish',
      body: 'When a recording is done, press **Save and Finish** at the top right. In a study it checks your work, ' +
        'saves it and marks the recording complete. Here it ends the tour, and nothing you marked is kept.',
      done: (o) => o.saved },
  ];
}

/** Whether a step is done by what was seen. */
export function stepDone(step, obs) {
  try { return Boolean(step.done(obs)); } catch { return false; }
}

/**
 * The tour's panel beside the EEG: the coach's place in the annotation view (ws.coach), so that the
 * view tells it about every change (scheduleCheck), every move (onView) and Save and Finish.
 */
export class TourCoach {
  constructor(ws, { app, onFinished }) {
    this.ws = ws;
    this.app = app;
    this.onFinished = onFinished;
    this.quickKeys = Object.fromEntries(ws.quick.map((n, i) => [n, i + 1]));
    this.steps = tourSteps({ quickKeys: this.quickKeys, sfreq: ws.sf });
    this.index = 0;
    this.obs = { annotations: [], startS: 0, maxStartS: 0, undone: false, saved: false };
    this.sending = false;
    this.finished = false;
    this.t0 = performance.now();
    this._listener = (change) => { if (change && change.action === 'undo') this.obs.undone = true; this.scheduleCheck(); };
    ws.store.addListener(this._listener);
    this._build();
  }

  _build() {
    this.header = h('p.caption.coach-header');
    this.progress = h('div.progress', { role: 'progressbar', 'aria-label': 'Steps of the tour done' }, this.bar = h('div.progress-bar'));
    this.title = h('h2.coach-title');
    this.body = h('p.coach-body');
    this.feedback = h('div.coach-feedback', { role: 'status', 'aria-live': 'polite', hidden: true });
    this.skipBtn = h('button.btn.quiet', { type: 'button', 'data-log': 'tour-skip-step', title: 'Go on to the next step without doing this one', onclick: () => this.next('next') }, 'Skip this step');
    this.nextBtn = h('button.btn.primary', { type: 'button', 'data-log': 'tour-next', title: 'Go on to the next step (Enter)', 'aria-keyshortcuts': 'Enter', disabled: true, onclick: () => this.next('action') }, 'Next step');
    for (const b of [this.skipBtn, this.nextBtn]) { b.tabIndex = -1; b.addEventListener('mousedown', (e) => e.preventDefault()); }
    this.el = h('section.coach.card.tour', { 'aria-label': 'Find your way around' },
      h('div.coach-scroll', {}, this.header, this.progress, this.title, this.feedback, this.body),
      h('div.coach-buttons', {}, this.skipBtn, this.nextBtn));
  }

  get step() { return this.steps[this.index] || null; }

  start() {
    this.ws.coachHost.appendChild(this.el);
    logger.event('tour_started', { n_steps: this.steps.length });
    this._show();
  }

  _show() {
    const step = this.step;
    const n = this.steps.length;
    this.header.textContent = `Tour  ·  Step ${this.index + 1} of ${n}`;
    this.bar.style.width = `${Math.round((this.index / n) * 100)}%`;
    this.progress.setAttribute('aria-valuenow', String(this.index));
    this.progress.setAttribute('aria-valuemax', String(n));
    this.title.textContent = step.title;
    clear(this.body).appendChild(richText(touchFirst() ? touchWords(step.body) : step.body));
    this._feedback('', '');
    this.nextBtn.disabled = true;
    this.nextBtn.textContent = this.index === n - 1 ? 'Finish the tour' : 'Next step';
    this.skipBtn.hidden = step.key === 'save';
    const v = this.ws.viewer;
    v.setGhost(step.ghost ? { ...step.ghost } : null);
    if (step.ghost) v.showInterval(step.ghost.onset_sample, step.ghost.duration_samples, step.ghost.channels);
    if (step.key === 'undo') this.obs.undone = false; // only an undo made at this step counts
    this.check();
  }

  _feedback(text, role) {
    clear(this.feedback);
    this.feedback.hidden = !text;
    if (!text) return;
    this.feedback.className = `coach-feedback ${role}`;
    this.feedback.appendChild(richText(text));
  }

  /** Look again at what the annotation view shows (after every change, move or press). */
  check() {
    if (this.finished || !this.step) return;
    this.obs.annotations = this.ws.store.annotations();
    this.obs.startS = this.ws.viewer.view.startS;
    this.obs.maxStartS = Math.max(this.obs.maxStartS, this.obs.startS);
    const done = stepDone(this.step, this.obs);
    if (done && this.nextBtn.disabled) {
      this.nextBtn.disabled = false;
      this._feedback(this.step.key === 'save' ? 'That is the whole tour.' : 'Done. Press **Next step** (Enter) to go on.', 'success');
    }
  }

  scheduleCheck() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.check(), 60);
  }

  onView() { this.scheduleCheck(); }

  /** Go on: `via` is "action" (the step was done) or "next" (skipped). */
  async next(via) {
    if (this.finished || this.sending) return;
    const step = this.step;
    if (via === 'action' && !stepDone(step, this.obs)) return;
    logger.event('tour_step', { step: step.key, index: this.index + 1, completed_by: via,
      seconds: Math.round(performance.now() - this.t0) / 1000 });
    this.t0 = performance.now();
    if (this.index < this.steps.length - 1) {
      this.index += 1;
      this._show();
      return;
    }
    await this.finish();
  }

  /** Save and Finish of the tour: the last step, or a word about it before then. */
  saveAndFinish() {
    if (this.step && this.step.key === 'save') {
      this.obs.saved = true;
      this.check();
      this.next('action');
      return;
    }
    this._feedback('You press **Save and Finish** at the end of the tour. Do this step first, or skip it.', 'banner');
  }

  /** The tour is done: the study is told (once; Try again after a failure), then the training path comes back. */
  async finish() {
    if (this.sending) return;
    this.sending = true;
    this.nextBtn.disabled = true;
    this._feedback('Telling your study that you have done the tour…', '');
    try {
      await this.app.backend.trainingStage({ stage: 'tour', action: 'done' });
    } catch (exc) {
      this.sending = false;
      if (exc.status === 401) return;
      this.nextBtn.disabled = false;
      this.nextBtn.textContent = 'Try again';
      this._feedback(`Your study could not be told that you finished the tour: ${exc.message} Press Try again.`, 'banner');
      return;
    }
    this.finished = true;
    logger.event('tour_finished', { n_steps: this.steps.length });
    this.onFinished();
  }

  /** Close during the tour: it can be taken again from the training path. */
  async beforeClose() {
    if (this.finished) return true;
    const leave = await ask('Leave the tour?', 'You can take the tour again from your training path, or skip it there.',
      { yes: 'Leave the tour', no: 'Stay', defaultYes: false });
    if (leave) logger.event('tour_left', { step: this.step ? this.step.key : null, index: this.index + 1 });
    return leave;
  }

  // What the annotation view asks of its coach.
  canShowMe() { return false; }
  showMe() {}
  takesContinueKey() { return !this.finished && !this.nextBtn.disabled; }
  continue() { this.next('action'); }
  canSave() { return false; }
  syncSaveButton(btn) { btn.disabled = false; }
  addPaused() {}
  refresh() {}

  destroy() {
    clearTimeout(this._timer);
    this.ws.store.removeListener(this._listener);
    this.el.remove();
  }
}

/** Open the tour: the practice recording in an annotation view of its own, with the tour's panel. */
export async function startTour(app) {
  const [{ AnnotationSession }, { Workspace }] = await loadParts('session', 'workspace');
  const recording = makeSyntheticRecording(TOUR_SPEC);
  const session = new AnnotationSession({
    backend: app.backend, recording, manifest: null, recordingId: recording.fileName, mode: 'tryout', contextId: '',
    me: app.me, catalogue: app.catalogue, sha256: '0'.repeat(64),
  });
  if (app.ws) app.ws.destroy();
  const ws = new Workspace(app, session, { kind: 'tour' });
  app.ws = ws;
  app._render(ws.el, 'annotate');
  ws.mount(app.content);
  const coach = new TourCoach(ws, {
    app,
    onFinished: () => {
      app.pathMessage = 'Tour finished. Your training path goes on with the next stage.';
      app.leaveRecording(ws, 'tour_finished');
    },
  });
  ws.coach = coach;
  coach.start();
  ws._refreshState();
  ws.logOpened({ recording_id: session.recordingId, segment: 'tour' });
  return ws;
}
