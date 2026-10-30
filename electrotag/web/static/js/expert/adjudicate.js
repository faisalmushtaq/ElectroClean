// The adjudication pass (docs/web/admin.md, "Adjudication"): one conflict at a time on the EEG, as a
// screening tool shows one record at a time. The workspace is read only; every version compared is
// drawn on the EEG with its letter before the type ("A: Eye-blink-artifact"), and the lanes above the
// EEG (lanes.js) put each annotator's marks side by side, named. The side panel lists the conflicts
// in time order with their kinds and a tick once decided, and holds the decision bar:
//
//   1 to 6 (or A to D)  keep that version        K  keep both (all)      X  neither
//   E  edit a mark (type, start and end, channels; or drag across the EEG)
//   R  the reason       Enter  save the decision and go to the next undecided conflict
//   S  skip             N and P  next and previous conflict      T  the lanes     F  finish
//
// Each decision is sent on its own (adjudication_decide) and never repeated by itself; the bar waits
// while the study answers, and a late answer still lands on its own conflict. The decisions are kept
// by the study, so the adjudicator can stop and continue later from the queue. Finish adjudication
// saves the adjudicated version once every conflict is decided. In view mode (a finished
// adjudication, or an entry of the library) the same view shows the decisions without the bar.
//
// The interaction log records adjudication_opened, adjudication_decision (the reason's length only,
// never its text), adjudication_lanes and adjudication_finished.

import { h, clear } from '../ui/dom.js';
import { ask, inform } from '../ui/dialog.js';
import { logger, keyName } from '../log/logger.js';
import { checkStudyCopy } from '../views/purposes.js';
import { COLOURS } from '../ui/theme.js';
import { icon } from '../views/common.js';
import { Lanes } from './lanes.js';
import {
  KIND_TEXT, MAX_REASON, REASON_TEXT, choicesFor, conflictOfMark, decidedShare, decisionBody, decisionProblem, decisionText,
  keyAction, nextLaneMode, nextUndecided, overlayAnnotations, progressText, reasonNeeded, spanText,
} from './model.js';

/** Colours of the letters' tags on the EEG and in the panel: the style sheet's own, each legible on white. */
const LETTER_COLOURS = [COLOURS.accent, COLOURS.flag_type, COLOURS.group_green, COLOURS.destructive, COLOURS.warning_text, COLOURS.text];

export class AdjudicationPass {
  /**
   * @param {object} ws a read-only workspace of kind 'reviewing'
   * @param {{target: object, app: object, mode?: 'decide'|'view', focus?: string|null, back?: Function}} o
   *   target: the answer of adjudication_start or adjudication_get
   */
  constructor(ws, { target, app, mode = 'decide', focus = null, back = null }) {
    this.ws = ws;
    this.app = app;
    this.backend = app.backend;
    this.t = target;
    this.mode = target.adjudication && target.adjudication.state === 'finished' ? 'view' : mode;
    this.back = back;
    this.unitId = target.unit.unit_id;
    this.sf = ws.sf;
    this.versions = target.versions || [];
    this.letters = this.versions.map((v) => v.letter);
    this.people = Object.fromEntries(this.versions.map((v) => [v.letter, v.annotator_id]));
    this.conflicts = [...(target.conflicts || [])];
    this.rule = target.reason_required || 'always';
    this.row = -1;
    this.pending = null; // {choice, reasonCode, reason, marks} of the current conflict, until it is saved
    this.sending = null; // the conflict ID whose decision is on its way
    this.laneMode = null;
    this.openedAt = performance.now();
    this.shownAt = performance.now();
    ws.review = this;
    ws.el.classList.add('reviewing', 'adjudicating');
    const chip = ws.el.querySelector('.ws-name .chip');
    if (chip) chip.textContent = this.mode === 'view' ? 'Adjudicated' : 'Adjudication';
    this._colours();
    this._build();
    const select = ws.select.bind(ws);
    ws.select = (ids, opts) => { select(ids, opts); this._fromSelection(); };
    const onView = ws.viewer.onView;
    ws.viewer.onView = (v, cause) => { if (onView) onView(v, cause); this.lanes.draw(); };
    (ws._onDestroy || (ws._onDestroy = [])).push(() => this.lanes.destroy());
    logger.event('adjudication_opened', { unit_id: this.unitId, n_conflicts: this.conflicts.length, decided: this._decided(), mode: this.mode,
      letters: this.letters.length });
    const first = focus ? this.conflicts.findIndex((c) => c.conflict_id === focus) : -1;
    const start = first >= 0 ? first : this.mode === 'view' ? 0 : nextUndecided(this.conflicts, -1);
    requestAnimationFrame(() => { if (!ws._destroyed) this.go(start >= 0 ? start : 0); });
  }

  _decided() { return this.conflicts.filter((c) => c.decision).length; }

  /** Each letter's tags on the EEG in its own colour, with its letter before the type. */
  _colours() {
    const prefix = {};
    const colours = {};
    for (const [i, v] of this.versions.entries()) {
      for (const a of v.annotations || []) {
        const id = `${v.letter}-${a.annotation_id}`;
        prefix[id] = `${v.letter}: `;
        colours[id] = LETTER_COLOURS[i % LETTER_COLOURS.length];
      }
    }
    this.ws.prefix = prefix;
    this.ws.labelColours = colours;
    this.ws.viewer.setPrefix(prefix);
    this.ws.viewer.setLabelColours(colours);
  }

  // ------------------------------------------------------------------ building
  _build() {
    const t = this.t;
    const u = t.unit;
    const who = this.versions.map((v, i) => h('span.adj-who', { 'data-letter': v.letter },
      h('b', { style: { color: LETTER_COLOURS[i % LETTER_COLOURS.length] } }, v.letter), ` ${v.annotator_id}${v.display_name ? ` (${v.display_name})` : ''}`,
      v.source === 'correction' ? h('span.caption', {}, ` correction of version ${v.attempt}`) : null));
    this.progressText = h('p.caption.adj-progress', { 'aria-live': 'polite' });
    this.progressBar = h('span.progress-bar');
    this.list = h('ol.adj-list', { 'aria-label': 'Conflicts, in the order of the recording' });
    this.items = this.conflicts.map((c, i) => this._item(c, i));
    this.list.append(...this.items);
    this.detail = h('div.adj-detail', { 'aria-live': 'polite' });
    this.msg = h('p.caption.adj-msg', { role: 'status' });
    this.decide = this.mode === 'decide' ? this._decisionBar() : null;
    this.el = h('section.review.card.adjudication-pass', { 'aria-label': 'Adjudication' },
      h('h2', {}, this.mode === 'view' ? 'Adjudicated conflicts' : 'Adjudication'),
      h('p.caption.adj-whose', {}, who.flatMap((w, i) => (i ? [' · ', w] : [w]))),
      u.window ? h('p.caption', {}, `Only the window from ${u.window.start_s} s to ${u.window.end_s} s is compared.`) : null,
      h('div.adj-progress-row', {}, this.progressText, h('span.progress', { 'aria-hidden': 'true' }, this.progressBar)),
      this.detail, this.decide, this.msg,
      h('h3', {}, 'Every conflict'), this.list,
      this.mode === 'decide' ? h('p.caption.adj-keys', {}, '1 to 6 (or A to D) keep a version · K both · X neither · E edit · R reason · Enter save and next · S skip · N and P move · T lanes') : null);
    this.ws.reviewHost.append(this.el);
    this.lanes = new Lanes(this.ws.viewer, { versions: this.versions, catalogue: this.ws.cat, onPick: (id) => this._pick(id) });
    this.ws.eegHost.prepend(this.lanes.el);
    this.ws.hintEl.textContent = this.mode === 'decide'
      ? '1 / 2 keep A or B  ·  K both  ·  X neither  ·  E edit  ·  R reason  ·  Enter save and next  ·  N / P move  ·  T lanes'
      : 'N / P  next, previous conflict  ·  T lanes';
    if (this.mode === 'decide') {
      this.finishBtn = h('button.btn.primary', { type: 'button', 'data-log': 'adjudication-finish', hidden: true, onclick: () => this.finish() }, 'Finish adjudication');
      this.ws.actionsEl.append(this.finishBtn);
    }
    this._refresh();
  }

  _item(c, i) {
    const kinds = (c.kinds || []).map((k) => h('span.chip.adj-kind', { 'data-kind': k }, KIND_TEXT[k] || k));
    const li = h('li.adj-item', { 'data-conflict': c.conflict_id, tabindex: '0', 'data-log': 'adjudication-item',
      onclick: () => this.go(i), onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.go(i); } } },
    h('span.adj-tick', {}, icon('check')), h('span.adj-n.num', {}, String(i + 1)),
    h('span.adj-item-body', {}, h('span.adj-time', {}, spanText(c.onset_s, c.offset_s)), h('span.adj-kinds', {}, kinds),
      h('span.caption.adj-said', {})));
    return li;
  }

  _decisionBar() {
    this.choiceBtns = choicesFor(this.letters).map((c) => {
      const keys = c.keys.map((k) => k.toUpperCase()).join(' or ');
      const b = h('button.chip-btn.adj-choice', { type: 'button', 'aria-pressed': 'false', 'data-choice': c.choice, title: `${c.label} (${keys})`,
        onclick: () => this.choose(c.choice, 'button') }, c.choice.length === 1 ? `${c.label}: ${this.people[c.choice]}` : c.label,
      h('span.chip-key', {}, c.keys[0].toUpperCase()));
      return b;
    });
    this.reasonBtns = Object.entries(REASON_TEXT).map(([code, text]) => h('button.seg', { type: 'button', 'aria-pressed': 'false', 'data-reason': code,
      onclick: () => this.setReasonCode(code) }, text));
    this.reasonInput = h('input.field.adj-reason', { type: 'text', maxlength: String(MAX_REASON), placeholder: 'Reason in a few words (R)', 'aria-label': 'Reason for this decision',
      'data-log': 'adjudication-reason' });
    this.reasonInput.addEventListener('input', () => { if (this.pending) this.pending.reason = this.reasonInput.value; this._refreshBar(); });
    this.reasonInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.save(); }
      if (e.key === 'Escape') { e.preventDefault(); this.reasonInput.blur(); this.ws.viewer.over.focus({ preventScroll: true }); }
    });
    this.editHost = h('div.adj-edit', { hidden: true });
    this.saveBtn = h('button.btn.primary.small', { type: 'button', 'data-log': 'adjudication-save', onclick: () => this.save() }, 'Save and next');
    this.skipBtn = h('button.btn.small', { type: 'button', 'data-log': 'adjudication-skip', onclick: () => this.skip() }, 'Skip');
    this.reasonNote = h('p.caption.adj-reason-note', {});
    return h('div.adj-bar', {},
      h('div.adj-choices', { role: 'group', 'aria-label': 'What to keep' }, this.choiceBtns),
      this.editHost,
      h('div.adj-reasons', { role: 'group', 'aria-label': 'Reason' }, this.reasonBtns),
      this.reasonInput, this.reasonNote,
      h('div.btn-row', {}, this.saveBtn, this.skipBtn));
  }

  // ------------------------------------------------------------------ moving
  go(i) {
    if (i < 0 || i >= this.conflicts.length) return;
    if (this.row !== i) this.shownAt = performance.now();
    this.row = i;
    const c = this.conflicts[i];
    const d = c.decision;
    this.pending = d ? { choice: d.choice, reasonCode: d.reason_code || null, reason: d.reason || '', marks: d.choice === 'edited' ? (d.marks || []) : [] }
      : { choice: null, reasonCode: null, reason: '', marks: [] };
    this._stopEditing();
    if (this.pending.choice === 'edited') this._startEditing(this.pending.marks[0]);
    this.items.forEach((li, k) => li.classList.toggle('current', k === i));
    this.items[i].scrollIntoView({ block: 'nearest' });
    const chans = [...new Set((c.marks || []).flatMap((m) => m.channels || []))];
    this.ws.viewer.showInterval(c.onset_sample, Math.max(1, c.offset_sample - c.onset_sample), chans);
    this._refresh();
  }

  step(delta) {
    if (!this.conflicts.length) { this.ws.say('There are no conflicts to adjudicate.'); return; }
    const next = this.row >= 0 ? this.row + delta : 0;
    if (next < 0 || next >= this.conflicts.length) { this.ws.say(delta > 0 ? 'That was the last conflict' : 'That was the first conflict'); return; }
    this.go(next);
    this.ws.say(`${progressText(this.conflicts, next)}.`);
  }

  skip() {
    const next = nextUndecided(this.conflicts, this.row);
    logger.event('adjudication_skipped', { conflict_id: this.conflicts[this.row]?.conflict_id || null });
    if (next < 0 || next === this.row) { this.step(1); return; }
    this.go(next);
  }

  _pick(overlayId) {
    const i = conflictOfMark(this.conflicts, overlayId);
    if (i >= 0) this.go(i);
    else this.ws.say('Everyone agrees on that mark: it is kept as it is.');
  }

  _fromSelection() {
    const id = this.ws.selection.length === 1 ? this.ws.selection[0] : null;
    if (!id) return;
    const i = conflictOfMark(this.conflicts, id);
    if (i >= 0 && i !== this.row) this.go(i);
  }

  // ------------------------------------------------------------------ deciding
  choose(choice, via = 'key') {
    if (this.mode !== 'decide' || this.row < 0) return;
    if (!this.pending) return;
    this.pending.choice = choice;
    if (choice === 'edited') this._startEditing();
    else { this._stopEditing(); this.pending.marks = []; }
    logger.event('adjudication_choice', { conflict_id: this.conflicts[this.row].conflict_id, choice, via });
    this._refresh();
  }

  setReasonCode(code) {
    if (!this.pending) return;
    this.pending.reasonCode = this.pending.reasonCode === code ? null : code;
    this._refreshBar();
    if (code === 'other' && this.pending.reasonCode) this.reasonInput.focus();
  }

  _startEditing(mark = null) {
    const c = this.conflicts[this.row];
    const first = mark || (c.marks || [])[0] || { label: (c.labels || [])[0] || this.ws.cat.labelNames[0], onset_sample: c.onset_sample, duration_samples: c.offset_sample - c.onset_sample, channels: [] };
    const label = h('select.field.adj-edit-label', { 'aria-label': 'Type of the edited mark' },
      this.ws.cat.labelNames.map((n) => h('option', { value: n }, n)));
    label.value = first.label;
    const num = (v, what) => h('input.field.num.adj-edit-time', { type: 'number', step: '0.01', min: '0', value: (v / this.sf).toFixed(2), 'aria-label': what });
    const start = num(first.onset_sample, 'Start of the edited mark, in seconds');
    const end = num(first.onset_sample + first.duration_samples, 'End of the edited mark, in seconds');
    const options = [['', 'Whole montage'], ...this.versions.filter((v) => (c.marks || []).some((m) => m.letter === v.letter && m.channels.length))
      .map((v) => [v.letter, `Channels of ${v.letter}`])];
    const chans = h('select.field.adj-edit-chans', { 'aria-label': 'Channels of the edited mark' }, options.map(([v, t]) => h('option', { value: v }, t)));
    const fromLetter = (c.marks || []).find((m) => m.channels.length && JSON.stringify(m.channels) === JSON.stringify(first.channels || []));
    chans.value = fromLetter ? fromLetter.letter : '';
    const sync = () => {
      const s = Math.round(Number(start.value) * this.sf);
      const e = Math.round(Number(end.value) * this.sf);
      const m = (c.marks || []).find((x) => x.letter === chans.value);
      this.pending.marks = Number.isFinite(s) && Number.isFinite(e) && e > s
        ? [{ label: label.value, onset_sample: s, duration_samples: e - s, channels: m ? [...m.channels] : [] }] : [];
      this._refreshBar();
    };
    for (const f of [label, start, end, chans]) {
      f.addEventListener('change', sync);
      f.addEventListener('input', sync);
      f.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); sync(); this.save(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.choose(null, 'escape'); this.ws.viewer.over.focus({ preventScroll: true }); }
      });
    }
    clear(this.editHost);
    this.editHost.append(h('div.adj-edit-row', {}, label), h('div.adj-edit-row', {}, h('label.caption', {}, 'From ', start), h('label.caption', {}, ' to ', end, ' s'), chans),
      h('p.caption', {}, 'Or drag across the EEG to set the start and end. Enter saves the decision; Esc goes back.'));
    this.editHost.hidden = false;
    this.editFields = { label, start, end, chans, sync };
    this.onRange = (t0, t1) => { start.value = t0.toFixed(2); end.value = t1.toFixed(2); sync(); this.ws.say(`The edited mark now runs from ${t0.toFixed(2)} to ${t1.toFixed(2)} s.`); };
    sync();
    if (!mark) label.focus();
  }

  _stopEditing() {
    this.onRange = null;
    this.editFields = null;
    if (this.editHost) { clear(this.editHost); this.editHost.hidden = true; }
  }

  /** Send the current conflict's decision (once; the bar waits for the answer), then go to the next undecided one. */
  async save() {
    if (this.mode !== 'decide' || this.row < 0 || !this.pending) return false;
    if (this.sending) { this.msg.textContent = 'Wait a moment: the decision before is still being saved.'; return false; }
    const c = this.conflicts[this.row];
    const p = this.pending;
    const problem = decisionProblem({ choice: p.choice, reasonCode: p.reasonCode, reason: p.reason, marks: p.marks, rule: this.rule });
    if (problem) {
      this.msg.textContent = problem;
      if (p.choice && /reason/i.test(problem)) this.reasonInput.focus();
      return false;
    }
    const body = decisionBody({ unitId: this.unitId, conflictId: c.conflict_id, choice: p.choice, reasonCode: p.reasonCode, reason: p.reason, marks: p.marks });
    const seconds = Math.round((performance.now() - this.shownAt) / 100) / 10;
    this.sending = c.conflict_id;
    this.msg.textContent = 'Saving the decision…';
    this._refreshBar();
    try {
      const r = await this.backend.expert('adjudication_decide', body);
      const k = this.conflicts.findIndex((x) => x.conflict_id === r.conflict.conflict_id);
      if (k >= 0) this.conflicts[k] = r.conflict;
      logger.event('adjudication_decision', { conflict_id: c.conflict_id, kinds: c.kinds, choice: p.choice, reason_code: p.reasonCode || null,
        reason_length: (p.reason || '').trim().length, seconds, already: Boolean(r.already) });
      if (this.ws._destroyed) return true;
      this.msg.textContent = '';
      // After Enter in the reason or the edited mark, the keys belong to the pass again.
      if (this.el.contains(document.activeElement)) this.ws.viewer.over.focus({ preventScroll: true });
      const stayed = this.row === k;
      const next = nextUndecided(this.conflicts, k);
      if (stayed && next >= 0) this.go(next);
      else this._refresh();
      if (next < 0) this.ws.say('Every conflict is decided. Finish adjudication (F) saves the adjudicated version.', 15000);
      return true;
    } catch (exc) {
      if (!this.ws._destroyed) this.msg.textContent = `The decision was not saved: ${exc.message}${exc.status === 0 || exc.status >= 500 ? ' Press Enter to send it again.' : ''}`;
      return false;
    } finally {
      this.sending = null;
      if (!this.ws._destroyed) this._refreshBar();
    }
  }

  async finish() {
    if (this.mode !== 'decide' || this.finishing) return;
    const left = this.conflicts.length - this._decided();
    if (left) { this.msg.textContent = `${left} conflict${left === 1 ? ' is' : 's are'} not decided yet.`; return; }
    if (this.sending) { this.msg.textContent = 'Wait a moment: the last decision is still being saved.'; return; }
    const go = await ask('Finish the adjudication?', 'This saves the adjudicated version: the marks everyone agreed on and your decision on each conflict. The versions compared stay as they were. Your decisions cannot be changed afterwards.',
      { yes: 'Finish adjudication', no: 'Keep reviewing', defaultYes: true });
    if (!go || this.ws._destroyed) return;
    this.finishing = true;
    this.finishBtn.disabled = true;
    this.finishBtn.textContent = 'Finishing…';
    try {
      const r = await this.backend.expert('adjudication_finish', { unit_id: this.unitId });
      const by = {};
      for (const c of this.conflicts) { const k = c.decision.choice.length === 1 ? 'one' : c.decision.choice; by[k] = (by[k] || 0) + 1; }
      logger.event('adjudication_finished', { unit_id: this.unitId, n_conflicts: this.conflicts.length, by_choice: by, already: Boolean(r.already) });
      this.finished = true;
      await inform('Adjudication finished', `The adjudicated version of ${this.t.file_name} is saved (version ${r.version.attempt}, ${r.version.n_annotations} annotation${r.version.n_annotations === 1 ? '' : 's'}). The annotators can now see the outcome of their conflicts, if the study shows it to them.`);
      this.leave('finished');
    } catch (exc) {
      this.finishBtn.disabled = false;
      this.finishBtn.textContent = 'Finish adjudication';
      if (!this.ws._destroyed) this.msg.textContent = `The adjudication was not finished: ${exc.message}`;
    } finally {
      this.finishing = false;
    }
  }

  // ------------------------------------------------------------------ keys
  onKey(e, k) {
    if (e.altKey) return false;
    const a = keyAction(k, this.letters, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
    if (!a) return false;
    if (this.mode !== 'decide' && !['step', 'lanes'].includes(a.action)) return false;
    const run = (action, fn) => { e.preventDefault(); logger.shortcut(keyName(e), action); fn(); return true; };
    switch (a.action) {
      case 'choose': return run(`Choose ${a.choice}`, () => this.choose(a.choice));
      case 'save': return run('Save the decision', () => this.save());
      case 'reason': return run('Reason', () => this.reasonInput.focus());
      case 'skip': return run('Skip', () => this.skip());
      case 'step': return run(a.delta > 0 ? 'Next conflict' : 'Previous conflict', () => this.step(a.delta));
      case 'lanes': return run('Lanes', () => this.cycleLanes(a.delta));
      case 'finish': return run('Finish adjudication', () => this.finish());
      default: return false;
    }
  }

  /** T: every lane, then each version alone (on the EEG too). */
  cycleLanes(delta = 1) {
    this.laneMode = nextLaneMode(this.letters, this.laneMode, delta);
    this.lanes.setMode(this.laneMode);
    this.ws.store.reset(overlayAnnotations(this.versions, this.laneMode).filter((a) => this.ws.cat.has(a.label)));
    this.ws.viewer.setAnnotations(this.ws.store.annotations());
    logger.event('adjudication_lanes', { mode: this.laneMode || 'all' });
    this.ws.say(this.laneMode ? `Only ${this.laneMode} (${this.people[this.laneMode]}) is shown. T shows the next.` : 'Every version is shown.');
  }

  // ------------------------------------------------------------------ drawing
  _refresh() {
    const n = this.conflicts.length;
    this.progressText.textContent = progressText(this.conflicts, this.row);
    this.progressBar.style.width = `${Math.round(decidedShare(this.conflicts) * 100)}%`;
    this.conflicts.forEach((c, i) => {
      const li = this.items[i];
      li.dataset.decided = c.decision ? 'yes' : '';
      li.querySelector('.adj-said').textContent = c.decision ? decisionText(c.decision, this.people) : '';
    });
    this._detail();
    this._refreshBar();
    this._markers();
    this.lanes.setConflicts(this.conflicts, this.row);
    if (this.finishBtn) this.finishBtn.hidden = !(n && this._decided() === n);
  }

  _detail() {
    clear(this.detail);
    const c = this.conflicts[this.row];
    if (!c) { this.detail.append(h('p.caption', {}, this.conflicts.length ? '' : 'There are no conflicts: everyone agrees.')); return; }
    const rows = this.versions.map((v, i) => {
      const marks = (c.marks || []).filter((m) => m.letter === v.letter);
      const what = marks.length ? marks.map((m) => {
        const extra = [m.channels.length ? m.channels.join(', ') : 'whole montage'];
        if (Number.isInteger(m.confidence)) extra.push(`confidence ${m.confidence} of 5`);
        return h('span.adj-mark', {}, h('span.swatch', { style: { background: this.ws.cat.get(m.label)?.colour || null } }), ` ${m.label}, ${spanText(m.onset_s, m.offset_s)} (${extra.join(', ')})`,
          m.note ? h('span.caption', {}, ` “${m.note}”`) : null);
      }) : [h('span.caption', {}, 'no mark here')];
      return h('li', { 'data-letter': v.letter }, h('b', { style: { color: LETTER_COLOURS[i % LETTER_COLOURS.length] } }, `${v.letter} `), `${v.annotator_id}: `, ...what);
    });
    const d = c.decision;
    this.detail.append(...[
      h('div.adj-detail-head', {}, h('b', {}, `Conflict ${this.row + 1}`), h('span.caption', {}, ` ${spanText(c.onset_s, c.offset_s)}`),
        ...(c.kinds || []).map((k) => h('span.chip.adj-kind', { 'data-kind': k }, KIND_TEXT[k] || k))),
      h('ul.adj-versions', {}, rows),
      d ? h('p.adj-decided', {}, h('b', {}, `${decisionText(d, this.people)}. `), d.reason_code ? `${REASON_TEXT[d.reason_code]}${d.reason ? ': ' : '.'}` : '', d.reason || '',
        this.mode === 'decide' ? h('span.caption', {}, ' You can change it until you finish.') : null) : null].filter(Boolean));
  }

  _refreshBar() {
    if (!this.decide) return;
    const p = this.pending || {};
    const waiting = Boolean(this.sending);
    for (const b of this.choiceBtns) { b.setAttribute('aria-pressed', String(p.choice === b.dataset.choice)); b.disabled = waiting; }
    for (const b of this.reasonBtns) { b.setAttribute('aria-pressed', String(p.reasonCode === b.dataset.reason)); b.disabled = waiting; }
    if (this.reasonInput.value !== (p.reason || '') && document.activeElement !== this.reasonInput) this.reasonInput.value = p.reason || '';
    this.reasonInput.disabled = waiting;
    this.saveBtn.disabled = waiting || !p.choice;
    this.skipBtn.disabled = waiting;
    this.reasonNote.textContent = p.choice ? (reasonNeeded(this.rule, p.choice) ? 'This study asks for a reason with each such decision.' : 'A reason is optional here.') : 'Choose what to keep: a version, both, neither, or your own mark.';
  }

  _markers() {
    const c = this.conflicts[this.row];
    const list = this.conflicts.map((x, i) => ({ onset_sample: x.onset_sample, duration_samples: Math.max(1, x.offset_sample - x.onset_sample), current: i === this.row,
      outline: i === this.row }));
    if (c && this.pending && this.pending.choice === 'edited' && this.pending.marks[0]) {
      const m = this.pending.marks[0];
      list.push({ onset_sample: m.onset_sample, duration_samples: m.duration_samples, outline: true });
    }
    this.ws.viewer.setMarkers(list);
  }

  // ------------------------------------------------------------------ leaving
  leave(reason = 'closed') {
    if (this.left) return;
    this.left = true;
    logger.event('adjudication_closed', { unit_id: this.unitId, decided: this._decided(), n_conflicts: this.conflicts.length, reason });
    const app = this.app;
    this.ws.destroy();
    if (app.ws === this.ws) app.ws = null;
    if (this.back) this.back();
    else app.showExpert('expert-queue');
  }

  /** The workspace's Back: the decisions are kept by the study already, so the adjudicator just leaves. */
  async beforeClose() {
    if (this.sending) { this.ws.say('Wait a moment: the last decision is still being saved.'); return false; }
    this.leave('back');
    return false; // left here, back to the expert area (the workspace's own close would go to the admin area)
  }
}

/**
 * The purposes `adjudicate` and `library` (js/views/purposes.js): the file read is checked against the study's
 * copy, the adjudication is started when it was not (its inputs are frozen then), and the view opens.
 * target: the answer of adjudication_get, with `mode` ('decide' or 'view') and `focus` (a conflict ID).
 */
export async function openAdjudication(app, { recording, fp, view, target }) {
  const verb = target.mode === 'view' ? 'Open' : 'Adjudicate';
  const t0 = { ...target, file_name: target.file_name || target.unit.file_name, recording_id: target.unit.recording_id };
  if (!(await checkStudyCopy(app, recording, fp, view, t0, { verb, kind: 'adjudication' }))) return;
  let t = target;
  if (target.mode !== 'view' && !target.adjudication) {
    view.step('start', 'Starting the adjudication…');
    try {
      t = { ...(await app.backend.expert('adjudication_start', { unit_id: target.unit.unit_id })), mode: 'decide' };
    } catch (exc) {
      if (!app._stillOpen(view)) return;
      view.step('start', 'The adjudication could not start', 'failed');
      view.showProblem(exc.message, [view.backButton()]);
      return;
    }
    if (!app._stillOpen(view)) return;
    view.step('start', 'Adjudication started: the versions are fixed as they are now', 'done');
  }
  const parts = await app._openingParts(['session', 'workspace'], () => openAdjudication(app, { recording, fp, view, target: t }));
  if (!parts || !app._stillOpen(view)) return;
  const [{ AnnotationSession }, { Workspace }] = parts;
  let session;
  try {
    session = new AnnotationSession({ backend: app.backend, recording, manifest: t.manifest, recordingId: t.unit.recording_id, mode: 'standard', contextId: '',
      me: app.me, catalogue: app.catalogue, sha256: fp.hex, readOnly: true });
    session.store.reset(overlayAnnotations(t.versions).filter((a) => app.catalogue.has(a.label)));
  } catch (exc) {
    view.showProblem(exc.message, [view.chooseAgainButton()]);
    return;
  }
  if (app.ws) app.ws.destroy();
  const ws = new Workspace(app, session, { kind: 'reviewing' });
  app.ws = ws;
  app._render(ws.el, (view.purpose && view.purpose.route) || 'expert-adjudicate');
  ws.mount(app.content);
  ws.logOpened({ recording_id: t.unit.recording_id, segment: 'adjudication', unit_id: t.unit.unit_id });
  const back = view.purpose && view.purpose.onBack ? view.purpose.onBack : null;
  return new AdjudicationPass(ws, { target: t, app, mode: t.mode || 'decide', focus: t.focus || null, back });
}

/** From the queue or the library: read the unit, then open its file from this computer for the purpose. */
export async function startAdjudication(app, { unitId, mode = 'decide', focus = null, back = null, msg = null }) {
  let got;
  try {
    got = await app.backend.expert('adjudication_get', { unit_id: unitId });
  } catch (exc) {
    if (msg) msg.problem(exc); else if (exc.status !== 401) await inform('The adjudication cannot open', exc.message);
    return null;
  }
  const m = got.manifest || {};
  const kind = mode === 'view' && focus ? 'library' : 'adjudicate';
  const goBack = back || (() => app.showExpert(kind === 'library' ? 'expert-library' : 'expert-queue'));
  const who = (got.versions || []).map((v) => `${v.letter} ${v.annotator_id}`).join(', ');
  const started = Boolean(got.adjudication);
  const note = mode === 'view'
    ? `The versions of ${who}, with the decisions. Open the recording from this computer: its fingerprint is checked against the study's copy.`
    : `${got.progress.conflicts} conflict${got.progress.conflicts === 1 ? '' : 's'} between ${who}${started ? `, ${got.progress.decided} decided so far` : ''}. Open the recording from this computer: its fingerprint is checked against the study's copy${started ? '' : ', then the adjudication starts and the versions are fixed as they are now'}.`;
  return app.openFromComputer({ recording_id: got.unit.recording_id, file_name: got.file_name, format: m.format },
    { purpose: { kind, route: 'expert-adjudicate', target: { ...got, mode, focus }, onBack: goBack,
      title: `${mode === 'view' ? 'Open' : started ? 'Continue adjudicating' : 'Adjudicate'} ${got.file_name}`, note } });
}
