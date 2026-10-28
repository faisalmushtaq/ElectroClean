// The coach of guided training ("Learn with the experts"): one of the experts' annotations at a
// time, checked after every change. The checking is done by the study (server or demonstration),
// which keeps the experts' answers; the coach shows the instruction, the feedback and the stars,
// as the desktop coach (electroclean/training/guided_gui.py) does.

import { h, clear, richText } from '../ui/dom.js';
import { inform } from '../ui/dialog.js';
import { logger } from '../log/logger.js';
import { overlaps, starText, stepBody, STARS_FIRST } from './rules.js';
import { DEMO_NOTICE } from '../api/notice.js';

export function minutesText(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

export class GuidedCoach {
  /**
   * @param {import('../annotate/workspace.js').Workspace} ws
   * @param {{backend: object, recordingId: string, position: [number, number]}} o
   */
  constructor(ws, { backend, recordingId, position = [1, 1] }) {
    this.ws = ws;
    this.backend = backend;
    this.rid = recordingId;
    this.position = position;
    this.quickKeys = Object.fromEntries(ws.quick.map((n, i) => [n, i + 1]));
    this.step = null;
    this.nSteps = 0;
    this.guidance = 'show';
    this.complete = false;
    this.summary = null;
    this.matchedIds = new Set();
    this.stars = [];
    this.shownNow = false;
    this.last = null;
    this.busy = false;
    this.pending = false;
    this.flashed = false;
    this.stepT0 = performance.now();
    this._timer = null;
    this._build();
  }

  _build() {
    this.header = h('p.caption.coach-header');
    this.progress = h('div.progress', { role: 'progressbar', 'aria-label': 'Steps matched' }, this.bar = h('div.progress-bar'));
    this.title = h('h2.coach-title');
    this.feedback = h('div.coach-feedback', { role: 'status', 'aria-live': 'polite', hidden: true });
    this.body = h('p.coach-body');
    this.description = h('p.caption.coach-description');
    this.note = h('p.note.coach-note');
    this.starsEl = h('p.caption.coach-stars');
    this.showMeBtn = h('button.btn.quiet', { type: 'button', title: "Place the experts' annotation for you (this step then earns one star)", onclick: () => this.showMe() }, 'Show me');
    this.continueBtn = h('button.btn.primary', { type: 'button', title: 'Go on to the next artifact (Enter or Space)', disabled: true, onclick: () => this.continue() }, 'Continue');
    // Like the desktop's NoFocus buttons: Space and Enter stay the window's own keys.
    for (const b of [this.showMeBtn, this.continueBtn]) { b.tabIndex = -1; b.addEventListener('mousedown', (e) => e.preventDefault()); }
    this.el = h('section.coach.card', { 'aria-label': 'Learn with the experts' },
      h('div.coach-scroll', {}, this.header, this.progress, this.title, this.feedback, this.body, this.description, this.note, this.starsEl,
        this.backend.isDemo ? h('p.caption.demo-note', {}, DEMO_NOTICE) : null),
      h('div.coach-buttons', {}, this.showMeBtn, this.continueBtn));
  }

  async start() {
    this.ws.coachHost.appendChild(this.el);
    await this.refresh();
  }

  async refresh() {
    let g;
    try {
      g = await this.backend.guided(this.rid);
    } catch (exc) {
      this._feedback(`The coach could not reach the study: ${exc.message}`, 'banner');
      return;
    }
    this.nSteps = g.n_steps;
    this.guidance = g.guidance;
    this.stars = (g.completed || []).map((c) => c.stars || 0);
    this.matchedIds = new Set((g.completed || []).map((c) => c.annotation_id).filter(Boolean));
    if (g.current) {
      this.complete = false;
      this._startStep(g.current);
    } else {
      this.complete = true;
      this.summary = g.summary || null;
      this._finish();
    }
  }

  destroy() { clearTimeout(this._timer); this.el.remove(); }

  // ------------------------------------------------------------------ steps
  _startStep(step) {
    this.step = step;
    this.last = null;
    this.shownNow = false;
    this.flashed = false;
    this.stepT0 = performance.now();
    const [rec, recs] = this.position;
    this.header.textContent = `Recording ${rec} of ${recs}  ·  Step ${step.step} of ${this.nSteps}`;
    this._progress(this.stars.length);
    this.title.textContent = step.instruction;
    clear(this.body).appendChild(richText(stepBody(this.guidance, step.label, step.ghost ? step.ghost.channels : [], this.quickKeys)));
    const named = this.guidance !== 'find_unnamed';
    this.description.textContent = named ? step.description || '' : '';
    this.description.hidden = !this.description.textContent;
    this.note.textContent = named ? step.note || '' : '';
    this.note.hidden = !this.note.textContent;
    this._feedback('', '');
    this.continueBtn.textContent = 'Continue';
    this.continueBtn.hidden = false;
    this.showMeBtn.hidden = false;
    this.continueBtn.disabled = true;
    this._stars();
    const v = this.ws.viewer;
    v.setGhost(step.ghost ? { ...step.ghost, label: step.label } : null);
    if (step.view) v.setView({ startS: step.view.start_s, durationS: step.view.duration_s }, 'coach');
    if (step.ghost) v.showInterval(step.ghost.onset_sample, step.ghost.duration_samples, step.ghost.channels);
    logger.event('guided_step_started', {
      recording: this.rid, step: step.step, steps: this.nSteps, guidance: this.guidance, target_label: step.label,
      ...(step.ghost ? { target_onset_s: step.ghost.onset_sample / this.ws.sf, target_offset_s: (step.ghost.onset_sample + step.ghost.duration_samples) / this.ws.sf,
        target_channels: step.ghost.channels } : {}),
    });
    this.ws._refreshState();
    this.check({ initial: true }); // the trainee may already have marked it (working ahead)
  }

  _progress(done) {
    const pc = this.nSteps ? Math.round((done / this.nSteps) * 100) : 100;
    this.bar.style.width = `${pc}%`;
    this.progress.setAttribute('aria-valuenow', String(done));
    this.progress.setAttribute('aria-valuemax', String(this.nSteps));
  }

  scheduleCheck() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.check(), 120);
  }

  async check({ initial = false } = {}) {
    if (this.busy) { this.pending = true; return; }
    if (!this.step && !this.complete) return;
    this.busy = true;
    const annotations = this.ws.store.toJSON();
    let r;
    try {
      r = await this.backend.guidedCheck(this.rid, { step: this.complete ? this.nSteps : this.step.step, annotations });
    } catch (exc) {
      this.busy = false;
      if (exc.status === 409) { await this.refresh(); return; }
      this._feedback(`The coach could not check your work: ${exc.message}`, 'banner');
      return;
    }
    this.busy = false;
    if (this.pending) { this.pending = false; this.check(); return; }
    this.last = r;
    if (!initial) {
      logger.event('guided_check', { recording: this.rid, step: this.step ? this.step.step : this.nSteps, matched: r.matched, candidate: r.candidate_id,
        problems: r.problems, messages: r.messages, extras: r.extras, deltas: r.deltas || {} });
    }
    if (this.complete) { this._showCompleteCheck(r); return; }
    this._showResult(r);
  }

  _showResult(r) {
    const ok = Boolean(r.can_continue);
    this.continueBtn.disabled = !ok;
    if (r.problems.includes('extra')) {
      const text = r.messages[0] || '';
      this._feedback(text, 'banner');
      if (/^Nothing is marked/.test(text) && r.extras && r.extras[0]) this.ws.select([r.extras[0]], { via: 'coach' });
      return;
    }
    if (r.matched) {
      if (this.shownNow) {
        this._feedback("This is how the experts marked it. Look at where it starts and ends and which channels it covers, then press **Continue** (Enter).", 'success');
      } else {
        const done = (r.messages[0] || 'Right type and timing.').replace(/\.$/, '');
        this._feedback(`✓ ${done}. Press **Continue** (Enter) for the next one.`, 'success');
      }
      if (!this.flashed) {
        this.flashed = true;
        const a = r.candidate_id && this.ws.store.has(r.candidate_id) ? this.ws.store.get(r.candidate_id) : null;
        if (a) this.ws.viewer.flashInterval(a.onset_sample, a.duration_samples);
        if (this.guidance === 'find_unnamed' && a) {
          this.title.textContent = `Found: ${a.label}`;
          this.description.textContent = this.ws.cat.get(a.label).description || '';
          this.description.hidden = !this.description.textContent;
        }
      }
      return;
    }
    this.flashed = false;
    if (r.problems.length === 1 && r.problems[0] === 'missing') { this._feedback('', ''); return; }
    const box = h('div', {}, h('b', {}, 'Not quite yet:'), h('ul', {}, r.messages.map((m) => h('li', {}, m))));
    this._feedback(box, 'banner');
  }

  _feedback(content, role) {
    clear(this.feedback);
    if (!content) { this.feedback.hidden = true; return; }
    this.feedback.hidden = false;
    this.feedback.className = `coach-feedback ${role}`;
    this.feedback.appendChild(typeof content === 'string' ? richText(content) : content);
  }

  _stars() {
    const earned = this.stars.reduce((a, b) => a + b, 0);
    const possible = STARS_FIRST * this.stars.length;
    const total = STARS_FIRST * this.nSteps;
    this.starsEl.textContent = this.stars.length
      ? `${starText(earned, possible)}  ${earned} of ${possible} stars so far (${total} possible)`
      : `Up to ${STARS_FIRST} stars for each artifact you match yourself.`;
  }

  canContinue() { return !this.complete && !this.busy && Boolean(this.last && this.last.can_continue); }

  async continue() {
    if (!this.canContinue()) return;
    const step = this.step;
    const stars = this.last.stars || 0;
    const candidate = this.last.candidate_id;
    let next;
    this.continueBtn.disabled = true;
    try {
      next = await this.backend.guidedContinue(this.rid, { step: step.step });
    } catch (exc) {
      if (exc.status === 409) { await this.refresh(); return; }
      this._feedback(`The coach could not go on: ${exc.message}`, 'banner');
      this.continueBtn.disabled = false;
      return;
    }
    if (candidate) this.matchedIds.add(candidate);
    this.stars.push(stars);
    logger.event('guided_step_completed', { recording: this.rid, step: step.step, stars, used_show_me: this.shownNow,
      seconds: Math.round(performance.now() - this.stepT0) / 1000, annotation_id: candidate, label: step.label, guidance: this.guidance });
    this.ws.select(null, { via: 'coach' });
    if (next.complete) {
      this.complete = true;
      this.summary = next.summary;
      this._finish();
      this.check();
    } else {
      this._startStep(next);
    }
  }

  async showMe() {
    if (this.complete || !this.step || !this.ws.editable) return;
    let r;
    try {
      r = await this.backend.guidedShowMe(this.rid, { step: this.step.step });
    } catch (exc) {
      if (exc.status === 409) { await this.refresh(); return; }
      this._feedback(`The coach could not show the answer: ${exc.message}`, 'banner');
      return;
    }
    const t = r.annotation;
    const cand = this.last ? this.last.candidate_id : null;
    const store = this.ws.store;
    // Remove the trainee's attempt and second attempts of the same type, then place the experts'.
    const remove = store.annotations().filter((a) => !this.matchedIds.has(a.annotation_id) && overlaps(a, t) &&
      (a.annotation_id === cand || a.label === t.label)).map((a) => a.annotation_id);
    if (remove.length) store.deleteMany(remove);
    store.add(t.label, t.onset_sample, t.duration_samples, t.channels);
    this.shownNow = true;
    this.ws.viewer.setGhost({ ...r.ghost, label: t.label });
    this.ws.viewer.showInterval(t.onset_sample, t.duration_samples, t.channels);
    logger.event('guided_show_me', { recording: this.rid, step: this.step.step, replaced: remove,
      target: `${t.label}, ${(t.onset_sample / this.ws.sf).toFixed(2)}–${((t.onset_sample + t.duration_samples) / this.ws.sf).toFixed(2)} s` });
    this.check();
  }

  _finish() {
    const n = this.nSteps;
    const s = this.summary || { steps: n, stars: this.stars.reduce((a, b) => a + b, 0), max_stars: STARS_FIRST * n, time_s: 0, shown: 0 };
    const [rec, recs] = this.position;
    this.header.textContent = `Recording ${rec} of ${recs}  ·  complete`;
    this._progress(n);
    this.title.textContent = 'Recording complete';
    clear(this.body);
    if (n) {
      const shown = s.shown ? `, ${s.shown} with Show me` : '';
      this.body.appendChild(richText(`You matched all ${n} of the experts' annotations in ${minutesText(s.time_s || 0)}${shown}. ` +
        'Press **Save and Finish** to save your work and return to your training path.'));
      this.starsEl.textContent = `${starText(s.stars, s.max_stars)}  ${s.stars} of ${s.max_stars} stars`;
    } else {
      this.body.appendChild(richText('The experts found no artifacts in this recording. Look through it, then press **Save and Finish**.'));
      this.starsEl.textContent = '';
    }
    this.description.hidden = true;
    this.note.hidden = true;
    this.continueBtn.hidden = true;
    this.showMeBtn.hidden = true;
    this.ws.viewer.setGhost(null);
    logger.event('guided_recording_completed', { recording: this.rid, ...s });
    this.ws._refreshState();
  }

  _showCompleteCheck(r) {
    if (r.problems.includes('extra')) this._feedback(r.messages[0], 'banner');
    else this._feedback('✓ Everything matches the experts.', 'success');
  }

  syncSaveButton(btn) {
    btn.disabled = !this.complete;
    btn.title = this.complete ? 'Validate and save your annotations, then mark this recording complete'
      : "Available when every one of the experts' annotations has been matched";
  }

  canSave() {
    if (!this.complete) {
      inform('Not finished yet', `Match each of the experts' annotations first: you are at step ${this.step ? this.step.step : 1} of ${this.nSteps}.`);
      return false;
    }
    if (this.last && this.last.problems && this.last.problems.includes('extra')) {
      inform('Extra annotation', "Some of your annotations are not in the experts' annotations. Delete them before you save.");
      return false;
    }
    return true;
  }

  onView() {}
}
