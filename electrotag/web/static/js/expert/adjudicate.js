// The adjudication pass (docs/web/admin.md, "Adjudication"): one conflict at a time on the EEG, as a
// screening tool shows one record at a time. The workspace is read only; every version compared is
// drawn on the EEG with its letter before the type ("A: Eye-blink-artifact"), and the lanes above the
// EEG (lanes.js) put each annotator's marks side by side, named. The side panel keeps the current
// conflict (what each person marked, with confidence and note, and for corrections each expert's
// reason) and the decision bar in view at its top, and lists every conflict below, in time order, in a
// list of its own that scrolls; the panel's Annotations, Recording and Help tabs fold away while
// adjudicating and open when one is pressed.
//
//   1 to 6 (or A to D)  keep that version      K  keep all (both)      X  none (neither)
//   M  choose marks one by one, from different people if need be
//   E  your own marks instead (up to 5: type, start and end, channels; or drag across the EEG)
//   Shift+1 to Shift+7  the reason (the chips show their number)      R  write the reason
//   Enter  save the decision and go to the next undecided conflict    S  skip
//   N and P  next and previous conflict     T  the lanes     L  the corrected original     ?  every key
//   F  finish
//
// A choice not yet saved stays with its conflict when the adjudicator moves on, and is asked about
// before leaving. Each decision is sent on its own (adjudication_decide) and never repeated by itself;
// the bar waits while the study answers, and a late answer still lands on its own conflict. The
// decisions are kept by the study, so the adjudicator can stop and continue later from the queue.
// Finish adjudication saves the adjudicated version once every conflict is decided. In view mode (a
// finished adjudication, or an entry of the library) the same view shows the decisions without the
// bar; a finished adjudication can be reopened there by its adjudicator (or an administrator), which
// the study audits and keeps apart: finishing again saves a newer version, the earlier one is kept.
//
// The interaction log records adjudication_opened, adjudication_choice, adjudication_decision (the
// reason's length only, never its text), adjudication_lanes, adjudication_reopened and
// adjudication_finished.

import { h, clear } from '../ui/dom.js';
import { ask, inform, showDialog } from '../ui/dialog.js';
import { logger, keyName } from '../log/logger.js';
import { checkStudyCopy } from '../views/purposes.js';
import { COLOURS } from '../ui/theme.js';
import { icon } from '../views/common.js';
import { channelList, touchFirst } from '../util.js';
import { Lanes } from './lanes.js';
import { REASONS as CORRECTION_REASONS } from './diff.js';
import { isHelpKey, showKeySheet } from './key_sheet.js';
import {
  KIND_TEXT, MAX_EDITED, MAX_REASON, REASON_KEYS, REASON_TEXT, choicesFor, conflictOfMark, decidedShare, decisionBody, decisionProblem,
  decisionText, hintText, keyAction, keySheet, nextLaneMode, nextUndecided, overlayAnnotations, progressText, reasonNeeded, spanText, whoText,
} from './model.js';

/**
 * Colours of the letters' tags on the EEG, in the lanes and in the panel: the style sheet's own, each legible
 * on white and far apart from the next (ink blue, magenta, green, brown, violet, ink).
 */
export const LETTER_COLOURS = Object.freeze([COLOURS.accent, COLOURS.selection_channel, COLOURS.group_green, COLOURS.warning_text,
  COLOURS.flag_type, COLOURS.text]);

const blank = () => ({ choice: null, reasonCode: null, reason: '', marks: [], picks: [] });
const fromDecision = (d) => ({ choice: d.choice, reasonCode: d.reason_code || null, reason: d.reason || '',
  marks: d.choice === 'edited' ? (d.marks || []).map((m) => ({ ...m })) : [], picks: d.choice === 'pick' ? (d.picks || []).map((p) => ({ ...p })) : [] });
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
    this.back = back;
    this.sf = ws.sf;
    this.laneMode = null;
    this.pendingBy = new Map(); // conflict ID -> a choice not saved yet (kept when moving on)
    this.openedAt = performance.now();
    this.shownAt = performance.now();
    ws.review = this;
    ws.el.classList.add('reviewing', 'adjudicating');
    this._target(target, mode);
    this._colours();
    this._build();
    this._sidePanel();
    const select = ws.select.bind(ws);
    ws.select = (ids, opts) => { select(ids, opts); this._fromSelection(); };
    const onView = ws.viewer.onView;
    ws.viewer.onView = (v, cause) => { if (onView) onView(v, cause); if (this.lanes) this.lanes.draw(); };
    ws.keyHook = (e) => this._hookKey(e);
    ws.showHelp = () => this.showKeys();
    (ws._onDestroy || (ws._onDestroy = [])).push(() => { if (this.lanes) this.lanes.destroy(); });
    logger.event('adjudication_opened', { unit_id: this.unitId, n_conflicts: this.conflicts.length, decided: this._decided(), mode: this.mode,
      letters: this.letters.length });
    const first = focus ? this.conflicts.findIndex((c) => c.conflict_id === focus) : -1;
    const start = first >= 0 ? first : this.mode === 'view' ? 0 : nextUndecided(this.conflicts, -1);
    requestAnimationFrame(() => { if (!ws._destroyed) this.go(start >= 0 ? start : 0); });
  }

  _target(target, mode) {
    this.t = target;
    this.adj = target.adjudication || null;
    this.mode = this.adj && this.adj.state === 'finished' ? 'view' : mode;
    this.unitId = target.unit.unit_id;
    this.versions = target.versions || [];
    this.letters = this.versions.map((v) => v.letter);
    this.people = Object.fromEntries(this.versions.map((v) => [v.letter, v.annotator_id]));
    this.conflicts = [...(target.conflicts || [])];
    this.rule = target.reason_required || 'always';
    this.row = -1;
    this.pending = null;
    this.sending = null;
  }

  _decided() { return this.conflicts.filter((c) => c.decision).length; }

  /** The montage's channel names in order, for writing channels as runs (channelList). */
  _montage() { return this.ws.s.channels.map((c) => c.name); }

  _colourOf(letter) { return LETTER_COLOURS[Math.max(0, this.letters.indexOf(letter)) % LETTER_COLOURS.length]; }

  /** Each letter's tags on the EEG in its own colour, with its letter before the type; the corrected original dashed. */
  _colours() {
    const prefix = {};
    const colours = {};
    for (const v of this.versions) {
      for (const a of v.annotations || []) {
        const id = `${v.letter}-${a.annotation_id}`;
        prefix[id] = `${v.letter}: `;
        colours[id] = this._colourOf(v.letter);
      }
    }
    this.ws.prefix = prefix;
    this.ws.labelColours = colours;
    this.ws.viewer.setPrefix(prefix);
    this.ws.viewer.setLabelColours(colours);
    const o = this.t.original;
    if (o && this.ws.viewer.setLayers) {
      this.ws.viewer.setLayers([{ id: 'original', annotations: o.annotations || [], style: 'dashed', prefix: `Original (${o.annotator_id}): `, visible: true }]);
    }
  }

  /** May this person reopen the finished adjudication (its adjudicator, or an administrator who did not annotate it)? */
  _canReopen() {
    if (!this.adj || this.adj.state !== 'finished' || this.t.unit.own) return false;
    const me = this.app.me || {};
    return this.adj.adjudicator_id === me.annotator_id || Boolean(this.app.isAdmin);
  }

  _title() {
    if (this.mode === 'decide') return 'Adjudication';
    if (!this.adj) return 'Conflicts, not adjudicated yet';
    return this.adj.state === 'finished' ? 'Adjudicated conflicts' : 'Adjudication in progress';
  }

  // ------------------------------------------------------------------ building
  _build() {
    const t = this.t;
    const u = t.unit;
    const chip = this.ws.el.querySelector('.ws-name .chip');
    if (chip) chip.textContent = this.mode === 'view' ? 'Adjudicated' : 'Adjudication';
    const who = this.versions.map((v) => h('span.adj-who', { 'data-letter': v.letter },
      h('b', { style: { color: this._colourOf(v.letter) } }, v.letter), ` ${v.annotator_id}${v.display_name ? ` (${v.display_name})` : ''}`,
      v.source === 'correction' ? h('span.caption', {}, `, correcting version ${v.attempt}`) : null));
    const history = (this.adj && this.adj.history) || [];
    const last = history[history.length - 1];
    this.progressText = h('p.caption.adj-progress', { 'aria-live': 'polite' });
    this.progressBar = h('span.progress-bar');
    this.list = h('ol.adj-list', { 'aria-label': 'Every conflict, in the order of the recording' });
    this.items = this.conflicts.map((c, i) => this._item(c, i));
    this.list.append(...this.items);
    this.detail = h('div.adj-detail', { 'aria-live': 'polite' });
    this.msg = h('p.caption.adj-msg', { role: 'status' });
    this.decide = this.mode === 'decide' ? this._decisionBar() : null;
    this.top = h('div.adj-top', {},
      h('div.adj-head', {}, h('h2', {}, this._title()), h('p.caption.adj-whose', {}, who.flatMap((w, i) => (i ? [' · ', w] : [w])))),
      u.window ? h('p.caption.adj-window', {}, `Only the part from ${u.window.start_s} s to ${u.window.end_s} s is compared.`) : null,
      t.original ? h('p.caption.adj-window', {}, `Dashed: ${t.original.annotator_id}'s version ${t.original.attempt}, which they corrected (L hides it).`) : null,
      this.mode === 'decide' && last ? h('p.caption.adj-reopened', {}, `Reopened: adjudicated version ${last.version ? last.version.attempt : ''} stays the one that counts until you finish again.`) : null,
      h('div.adj-progress-row', {}, this.progressText, h('span.progress', { 'aria-hidden': 'true' }, this.progressBar)),
      this.detail, this.decide, this.msg);
    this.listWrap = h('div.adj-list-wrap', { tabindex: '-1' }, this.list);
    this.el = h('section.review.card.adjudication-pass', { 'aria-label': 'Adjudication' }, this.top, this.listWrap);
    this.ws.reviewHost.append(this.el);
    const o = t.original ? { annotator_id: t.original.annotator_id, annotations: t.original.annotations || [] } : null;
    this.lanes = new Lanes(this.ws.viewer, { versions: this.versions, catalogue: this.ws.cat, colours: Object.fromEntries(this.letters.map((x) => [x, this._colourOf(x)])),
      original: o, onPick: (id) => this._pick(id) });
    this.ws.eegHost.prepend(this.lanes.el);
    this.ws.hintEl.textContent = touchFirst()
      ? (this.mode === 'decide' ? 'Tap what to keep and a reason, then Save and next. Tap a conflict in the list to go to it.' : 'Tap a conflict in the list to go to it.')
      : hintText(this.letters, this.mode);
    if (this.finishBtn) this.finishBtn.remove();
    if (this.reopenBtn) this.reopenBtn.remove();
    this.finishBtn = null;
    this.reopenBtn = null;
    if (this.mode === 'decide') {
      this.finishBtn = h('button.btn.primary', { type: 'button', 'data-log': 'adjudication-finish', hidden: true, onclick: () => this.finish() }, 'Finish adjudication');
      this.ws.actionsEl.append(this.finishBtn);
    } else if (this._canReopen()) {
      this.reopenBtn = h('button.btn', { type: 'button', 'data-log': 'adjudication-reopen', onclick: () => this.reopen() }, 'Change decisions…');
      this.ws.actionsEl.append(this.reopenBtn);
    }
    this._refresh();
  }

  /** While adjudicating, the panel's tabs fold away to their bar (the conflict needs the room) and open when pressed. */
  _sidePanel() {
    const tabs = this.ws.side && this.ws.side.querySelector('.side-tabs');
    if (!tabs) return;
    this.sideTabs = tabs;
    tabs.classList.add('folded');
    tabs.querySelector('.tabs')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      const open = !tabs.classList.contains('folded');
      const same = b.getAttribute('aria-selected') === 'true';
      tabs.classList.toggle('folded', open && same && this._lastTab === b.dataset.tab);
      this._lastTab = b.dataset.tab;
    });
  }

  /** ?: the keys of this view, in the expert views' key sheet (key_sheet.js). */
  showKeys() {
    logger.event('adjudication_keys_shown', {});
    return showKeySheet(this.mode === 'decide' ? 'Keys of the adjudication' : 'Keys of this view', keySheet(this.letters, this.mode),
      { view: 'adjudication', foot: 'The keys work while the EEG or the panel has the focus; in the reason field, Enter saves and Esc goes back to the EEG.' });
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
        onclick: () => this.choose(c.choice, 'button'), onkeydown: (e) => this._enterSaves(e) },
      c.choice.length === 1 ? h('span', {}, h('b', { style: { color: this._colourOf(c.choice) } }, c.choice), ` ${this.people[c.choice]}`) : c.label,
      h('span.chip-key', {}, c.keys[0].toUpperCase()));
      return b;
    });
    const codes = Object.keys(REASON_TEXT);
    this.reasonBtns = codes.map((code, i) => h('button.seg.adj-reason-chip', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-reason': code,
      tabindex: i ? '-1' : '0', title: `${REASON_TEXT[code]} (Shift+${REASON_KEYS[code]})`,
      onclick: () => this.setReasonCode(code, 'button'), onkeydown: (e) => this._reasonKey(e, i) },
    h('span.key-hint', { 'aria-hidden': 'true' }, REASON_KEYS[code]), REASON_TEXT[code]));
    this.reasonInput = h('input.field.adj-reason', { type: 'text', maxlength: String(MAX_REASON), placeholder: 'Or write the reason in a few words (R)', 'aria-label': 'Reason for this decision',
      'data-log': 'adjudication-reason' });
    this.reasonInput.addEventListener('input', () => { if (this.pending) this.pending.reason = this.reasonInput.value; this._remember(); this._refreshBar(); });
    this.reasonInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.save(); }
      if (e.key === 'Escape') { e.preventDefault(); this._focusEeg(); }
    });
    this.pickHost = h('div.adj-pick', { hidden: true, role: 'group', 'aria-label': 'The marks to keep' });
    this.editHost = h('div.adj-edit', { hidden: true });
    this.saveBtn = h('button.btn.primary.small', { type: 'button', 'data-log': 'adjudication-save', onclick: () => this.save() }, 'Save and next');
    this.skipBtn = h('button.btn.small', { type: 'button', 'data-log': 'adjudication-skip', onclick: () => this.skip() }, 'Skip');
    this.reasonNote = h('span.caption.adj-reason-note', {});
    return h('div.adj-bar', {},
      h('div.adj-choices', { role: 'group', 'aria-label': 'What to keep' }, this.choiceBtns),
      this.pickHost, this.editHost,
      h('div.adj-reasons.reason-chips', { role: 'radiogroup', 'aria-label': 'Reason (Shift and its number)' }, h('span.caption.adj-reasons-label', { 'aria-hidden': 'true' }, 'Reason (Shift + number)'), this.reasonBtns),
      this.reasonInput,
      h('div.btn-row.adj-save-row', {}, this.saveBtn, this.skipBtn, this.reasonNote));
  }

  /** Enter on a choice or a reason chip saves the decision (rather than pressing the chip again). */
  _enterSaves(e) {
    if (e.key !== 'Enter') return false;
    e.preventDefault();
    e.stopPropagation();
    this.save();
    return true;
  }

  /** The reason chips are one radio group: the arrows or a chip's number choose, Enter saves (as in the correction view). */
  _reasonKey(e, i) {
    if (this._enterSaves(e)) return;
    const digit = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && /^[1-7]$/.test(e.key) ? Number(e.key) : 0;
    if (digit) {
      e.preventDefault();
      e.stopPropagation();
      this.setReasonCode(this.reasonBtns[digit - 1].dataset.reason, 'digit', { only: true });
      this.reasonBtns[digit - 1].focus();
      return;
    }
    const n = this.reasonBtns.length;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    e.stopPropagation();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + step + n) % n;
    this.setReasonCode(this.reasonBtns[j].dataset.reason, 'arrows', { only: true });
    this.reasonBtns[j].focus();
  }

  _focusEeg() { this.ws.viewer.over.focus({ preventScroll: true }); }

  /** Run fn, and if the focus was in the panel and the panel's re-drawing took it away, give it to the EEG (keys keep working). */
  _keepFocus(fn) {
    const had = this.el && this.el.contains(document.activeElement);
    const out = fn();
    if (had && (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected)) this._focusEeg();
    return out;
  }

  // ------------------------------------------------------------------ moving
  go(i) {
    if (i < 0 || i >= this.conflicts.length) return;
    this._keepFocus(() => {
      if (this.row !== i) this.shownAt = performance.now();
      this.row = i;
      const c = this.conflicts[i];
      this.pending = this.pendingBy.get(c.conflict_id) || (c.decision ? fromDecision(c.decision) : blank());
      if (this.msg) this.msg.textContent = '';
      this._stopEditing();
      this._stopPicking();
      if (this.pending.choice === 'edited') this._startEditing(false);
      if (this.pending.choice === 'pick') this._startPicking();
      this.items.forEach((li, k) => li.classList.toggle('current', k === i));
      this._scrollList(this.items[i]);
      const chans = [...new Set((c.marks || []).flatMap((m) => m.channels || []))];
      this.ws.viewer.showInterval(c.onset_sample, Math.max(1, c.offset_sample - c.onset_sample), chans);
      this._refresh();
    });
  }

  /** Bring a row of the list into view within the list only: the conflict and the bar above it never move. */
  _scrollList(li) {
    const box = this.listWrap;
    if (!li || !box) return;
    const top = li.offsetTop - box.offsetTop;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (top + li.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + li.offsetHeight - box.clientHeight;
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
    const c = this.conflicts[this.row];
    if (this.mode === 'decide' && c && this.pending && this.pending.choice === 'pick') {
      const letter = overlayId.split('-')[0];
      const id = overlayId.slice(letter.length + 1);
      if ((c.marks || []).some((m) => m.letter === letter && m.annotation_id === id)) { this.togglePick(letter, id); return; }
    }
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
  /** Keep the current choice with its conflict until it is saved (so that moving away and back keeps it). */
  _remember() {
    const c = this.conflicts[this.row];
    if (!c || !this.pending) return;
    const saved = c.decision ? fromDecision(c.decision) : blank();
    if (sameJson(saved, this.pending) || !this.pending.choice) this.pendingBy.delete(c.conflict_id);
    else this.pendingBy.set(c.conflict_id, this.pending);
  }

  choose(choice, via = 'key') {
    if (this.mode !== 'decide' || this.row < 0 || !this.pending) return;
    this._keepFocus(() => {
      this.pending.choice = choice;
      this.msg.textContent = '';
      if (choice === 'edited') { this._stopPicking(); this._startEditing(via !== 'restore'); } else { this._stopEditing(); this.pending.marks = []; }
      if (choice === 'pick') this._startPicking(); else { this._stopPicking(); this.pending.picks = []; }
      this._remember();
      logger.event('adjudication_choice', { conflict_id: this.conflicts[this.row].conflict_id, choice, via });
      this._refresh();
    });
  }

  setReasonCode(code, via = 'button', { only = false } = {}) {
    if (!this.pending || this.mode !== 'decide') return;
    this.pending.reasonCode = !only && this.pending.reasonCode === code ? null : code;
    this.msg.textContent = '';
    this._remember();
    this._refreshBar();
    this._refreshItems();
    if (via === 'key') this.ws.say(this.pending.reasonCode ? `Reason: ${REASON_TEXT[code]}. Enter saves.` : 'No reason chosen.');
    if (code === 'other' && this.pending.reasonCode && !this.pending.reason.trim()) this.reasonInput.focus();
  }

  // ---- choose marks one by one
  _startPicking() {
    const c = this.conflicts[this.row];
    clear(this.pickHost);
    this.pickBoxes = (c.marks || []).map((m) => {
      const box = h('input', { type: 'checkbox', 'data-pick': `${m.letter}-${m.annotation_id}` });
      box.checked = (this.pending.picks || []).some((p) => p.letter === m.letter && p.annotation_id === m.annotation_id);
      box.addEventListener('change', () => this.togglePick(m.letter, m.annotation_id, box.checked));
      box.addEventListener('keydown', (e) => this._enterSaves(e));
      return h('label.adj-pick-row', {}, box, h('b', { style: { color: this._colourOf(m.letter) } }, ` ${m.letter} `),
        `${m.annotator_id}: ${m.label}, ${spanText(m.onset_s, m.offset_s)}`);
    });
    this.pickHost.append(h('p.caption', {}, 'Tick the marks to keep, from anyone (or click them in the lanes).'), ...this.pickBoxes);
    this.pickHost.hidden = false;
  }

  _stopPicking() {
    this.pickBoxes = null;
    if (this.pickHost) { clear(this.pickHost); this.pickHost.hidden = true; }
  }

  togglePick(letter, annotationId, on = null) {
    if (!this.pending) return;
    const picks = this.pending.picks || [];
    const has = picks.some((p) => p.letter === letter && p.annotation_id === annotationId);
    const want = on === null ? !has : on;
    this.pending.picks = want && !has ? [...picks, { letter, annotation_id: annotationId }] : !want ? picks.filter((p) => !(p.letter === letter && p.annotation_id === annotationId)) : picks;
    for (const b of this.pickBoxes || []) b.checked = this.pending.picks.some((p) => `${p.letter}-${p.annotation_id}` === b.dataset.pick);
    this._remember();
    this._refresh();
  }

  // ---- marks of one's own (up to MAX_EDITED)
  _startEditing(focus = true) {
    const c = this.conflicts[this.row];
    if (!this.pending.marks || !this.pending.marks.length) {
      const first = (c.marks || [])[0];
      this.pending.marks = [first ? { label: first.label, onset_sample: first.onset_sample, duration_samples: first.duration_samples, channels: [...(first.channels || [])] }
        : { label: (c.labels || [])[0] || this.ws.cat.labelNames[0], onset_sample: c.onset_sample, duration_samples: c.offset_sample - c.onset_sample, channels: [] }];
    }
    this.editRow = 0;
    this._editForm();
    this.onRange = (t0, t1) => {
      const m = this.pending.marks[this.editRow] || this.pending.marks[0];
      if (!m) return;
      m.onset_sample = Math.round(t0 * this.sf);
      m.duration_samples = Math.max(1, Math.round(t1 * this.sf) - m.onset_sample);
      this._editForm();
      this._remember();
      this._refresh();
      this.ws.say(`Mark ${this.editRow + 1} now runs from ${t0.toFixed(2)} to ${t1.toFixed(2)} s.`);
    };
    if (focus) this.editHost.querySelector('select')?.focus();
  }

  /** The form of one's own marks: a row per mark (type, start and end, channels), Add and Remove. */
  _editForm() {
    const c = this.conflicts[this.row];
    clear(this.editHost);
    const chanOptions = [['', 'Whole montage'], ...this.versions.filter((v) => (c.marks || []).some((m) => m.letter === v.letter && m.channels.length))
      .map((v) => [v.letter, `Channels of ${v.letter}`])];
    const rows = this.pending.marks.map((m, i) => {
      const label = h('select.field.adj-edit-label', { 'aria-label': `Type of mark ${i + 1}` }, this.ws.cat.labelNames.map((n) => h('option', { value: n }, n)));
      label.value = m.label;
      const num = (v, what) => h('input.field.num.adj-edit-time', { type: 'number', step: '0.01', min: '0', value: (v / this.sf).toFixed(2), 'aria-label': what });
      const start = num(m.onset_sample, `Start of mark ${i + 1}, in seconds`);
      const end = num(m.onset_sample + m.duration_samples, `End of mark ${i + 1}, in seconds`);
      const chans = h('select.field.adj-edit-chans', { 'aria-label': `Channels of mark ${i + 1}` }, chanOptions.map(([v, t]) => h('option', { value: v }, t)));
      const fromLetter = (c.marks || []).find((x) => x.channels.length && sameJson([...x.channels], [...(m.channels || [])]));
      chans.value = fromLetter ? fromLetter.letter : '';
      const sync = () => {
        const s = Math.round(Number(start.value) * this.sf);
        const e = Math.round(Number(end.value) * this.sf);
        const src = (c.marks || []).find((x) => x.letter === chans.value);
        m.label = label.value;
        if (Number.isFinite(s) && Number.isFinite(e) && e > s) { m.onset_sample = s; m.duration_samples = e - s; }
        m.channels = src ? [...src.channels] : [];
        this._remember();
        this._refreshBar();
        this._markers();
      };
      const remove = this.pending.marks.length > 1 ? h('button.btn.quiet.small', { type: 'button', 'data-log': 'adjudication-edit-remove', 'aria-label': `Remove mark ${i + 1}`,
        onclick: () => { this.pending.marks.splice(i, 1); this.editRow = Math.min(this.editRow, this.pending.marks.length - 1); this._keepFocus(() => this._editForm()); this._remember(); this._refresh(); } }, 'Remove') : null;
      for (const f of [label, start, end, chans]) {
        f.addEventListener('change', sync);
        f.addEventListener('input', sync);
        f.addEventListener('focus', () => { this.editRow = i; });
        f.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); sync(); this.save(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.choose(null, 'escape'); this._focusEeg(); }
        });
      }
      return h('div.adj-edit-mark', { 'data-row': String(i) }, h('div.adj-edit-row', {}, h('span.adj-n.num', {}, String(i + 1)), label, remove),
        h('div.adj-edit-row', {}, h('label.caption', {}, 'From ', start), h('label.caption', {}, ' to ', end, ' s'), chans));
    });
    const add = this.pending.marks.length < MAX_EDITED ? h('button.btn.quiet.small', { type: 'button', 'data-log': 'adjudication-edit-add', onclick: () => {
      const last = this.pending.marks[this.pending.marks.length - 1];
      this.pending.marks.push({ ...last, channels: [...(last.channels || [])] });
      this.editRow = this.pending.marks.length - 1;
      this._editForm();
      this._remember();
      this._refresh();
      this.editHost.querySelectorAll('select.adj-edit-label')[this.editRow]?.focus();
    } }, 'Add another mark') : null;
    this.editHost.append(...rows, h('div.btn-row.tight', {}, add),
      h('p.caption', {}, `Up to ${MAX_EDITED} marks. Drag across the EEG to set the times of the mark you are on. Enter saves the decision; Esc goes back.`));
    this.editHost.hidden = false;
  }

  _stopEditing() {
    this.onRange = null;
    if (this.editHost) { clear(this.editHost); this.editHost.hidden = true; }
  }

  /** Send the current conflict's decision (once; the bar waits for the answer), then go to the next undecided one. */
  async save() {
    if (this.mode !== 'decide' || this.row < 0 || !this.pending) return false;
    if (this.sending) { this.msg.textContent = 'Wait a moment: the decision before is still being saved.'; return false; }
    const c = this.conflicts[this.row];
    const p = this.pending;
    const problem = decisionProblem({ choice: p.choice, reasonCode: p.reasonCode, reason: p.reason, marks: p.marks, picks: p.picks, rule: this.rule });
    if (problem) {
      this.msg.textContent = problem;
      if (p.choice && /write it/i.test(problem)) this.reasonInput.focus();
      else if (p.choice && /reason/i.test(problem) && !this.el.contains(document.activeElement)) this.reasonBtns[0].focus();
      return false;
    }
    const body = decisionBody({ unitId: this.unitId, conflictId: c.conflict_id, choice: p.choice, reasonCode: p.reasonCode, reason: p.reason, marks: p.marks, picks: p.picks });
    const seconds = Math.round((performance.now() - this.shownAt) / 100) / 10;
    const hadFocus = this.el.contains(document.activeElement);
    this.sending = c.conflict_id;
    this.msg.textContent = 'Saving the decision…';
    this._refreshBar();
    try {
      const r = await this.backend.expert('adjudication_decide', body);
      const k = this.conflicts.findIndex((x) => x.conflict_id === r.conflict.conflict_id);
      if (k >= 0) this.conflicts[k] = r.conflict;
      this.pendingBy.delete(c.conflict_id);
      logger.event('adjudication_decision', { conflict_id: c.conflict_id, kinds: c.kinds, choice: p.choice, reason_code: p.reasonCode || null,
        reason_length: (p.reason || '').trim().length, n_marks: p.choice === 'edited' ? p.marks.length : p.choice === 'pick' ? p.picks.length : null,
        seconds, already: Boolean(r.already) });
      if (this.ws._destroyed) return true;
      this.msg.textContent = '';
      // After Enter in the reason, a chip or a mark of one's own, the keys belong to the pass again.
      if (hadFocus || this.el.contains(document.activeElement)) this._focusEeg();
      const stayed = this.row === k;
      const next = nextUndecided(this.conflicts, k);
      if (stayed && next >= 0) this.go(next);
      else if (stayed) { this.pending = fromDecision(r.conflict.decision); this._refresh(); } else this._refresh();
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
    const unsaved = this.pendingBy.size;
    const go = await ask('Finish the adjudication?', `This saves the adjudicated version: the marks everyone agreed on and your decision on each conflict. The versions compared stay as they were.${unsaved ? ` ${unsaved} choice${unsaved === 1 ? ' you made was' : 's you made were'} not saved and ${unsaved === 1 ? 'is' : 'are'} left out: the saved decision${unsaved === 1 ? '' : 's'} count.` : ''} If you need to change a decision later, you can reopen the adjudication: the study keeps this version and saves a newer one.`,
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
      this.pendingBy.clear();
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

  /** Reopen a finished adjudication to change its decisions (audited; the version saved stays until it is finished again). */
  async reopen() {
    if (!this._canReopen() || this.reopening) return;
    const v = this.adj.version || {};
    const reason = h('input.field', { type: 'text', maxlength: String(MAX_REASON), 'aria-label': 'Why it is reopened', placeholder: 'Why, in a few words (optional)' });
    const go = await showDialog({ title: 'Reopen this adjudication?', logText: 'reopen an adjudication', className: 'reopen-dialog',
      body: h('div', {}, h('p.dialog-text', {}, `You can then change any decision and finish again. Adjudicated version ${v.attempt || ''} is kept, never deleted, and stays the one that counts (for the annotators' outcomes, training references and the analyses) until you finish again; the newer version then supersedes it. The study records that it was reopened.`),
        reason),
      buttons: [{ label: 'Keep it as it is', value: false }, { label: 'Reopen', value: true, kind: 'primary' }], cancelValue: false });
    if (!go || this.ws._destroyed) return;
    this.reopening = true;
    this.reopenBtn.disabled = true;
    try {
      const r = await this.backend.expert('adjudication_reopen', { unit_id: this.unitId, reason: reason.value.trim() });
      logger.event('adjudication_reopened', { unit_id: this.unitId, already: Boolean(r.already), reason_length: reason.value.trim().length });
      if (this.ws._destroyed) return;
      this._rebuild({ ...r, mode: 'decide' }, 'decide');
      this.ws.say('Reopened: change what you need, then finish again (F).', 10000);
    } catch (exc) {
      if (!this.ws._destroyed) { this.msg.textContent = `The adjudication was not reopened: ${exc.message}`; this.reopenBtn.disabled = false; }
    } finally {
      this.reopening = false;
    }
  }

  /** Build the panel again for a new answer (after reopening), keeping the conflict shown. */
  _rebuild(target, mode) {
    const id = this.conflicts[this.row]?.conflict_id;
    this.lanes.destroy();
    this.lanes.el.remove();
    this.el.remove();
    this.pendingBy.clear();
    this._target(target, mode);
    this._colours();
    this._build();
    const i = this.conflicts.findIndex((c) => c.conflict_id === id);
    this.go(i >= 0 ? i : 0);
  }

  // ------------------------------------------------------------------ keys
  /** The keys that come before the workspace's own: ? for this view's keys, Shift and a digit for a reason. */
  _hookKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (isHelpKey(e)) { e.preventDefault(); logger.shortcut(keyName(e), 'Keys'); void this.showKeys(); return true; }
    if ((e.key === 'l' || e.key === 'L') && this.t.original && this.ws.viewer.toggleLayer) {
      e.preventDefault();
      const on = this.ws.viewer.toggleLayer('original');
      logger.shortcut(keyName(e), 'Original layer');
      this.ws.say(on ? 'The corrected original is shown, dashed.' : 'The corrected original is hidden (L shows it).');
      return true;
    }
    if (e.shiftKey && this.mode === 'decide') {
      const a = keyAction(e.key, this.letters, { shift: true, code: e.code });
      if (a && a.action === 'reason_code') { e.preventDefault(); logger.shortcut(keyName(e), `Reason ${a.code}`); this.setReasonCode(a.code, 'key', { only: true }); return true; }
    }
    return false;
  }

  onKey(e, k) {
    if (e.altKey) return false;
    const a = keyAction(k, this.letters, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, code: e.code });
    if (!a) return false;
    if (this.mode !== 'decide' && !['step', 'lanes'].includes(a.action)) return false;
    const run = (action, fn) => { e.preventDefault(); logger.shortcut(keyName(e), action); fn(); return true; };
    switch (a.action) {
      case 'choose': return run(`Choose ${a.choice}`, () => this.choose(a.choice));
      case 'reason_code': return run(`Reason ${a.code}`, () => this.setReasonCode(a.code, 'key', { only: true }));
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
  _refreshItems() {
    this.conflicts.forEach((c, i) => {
      const li = this.items[i];
      const unsaved = this.pendingBy.has(c.conflict_id);
      li.dataset.decided = c.decision ? 'yes' : '';
      li.dataset.unsaved = unsaved ? 'yes' : '';
      li.querySelector('.adj-said').textContent = unsaved ? `Chosen, not saved: ${decisionText(this.pendingBy.get(c.conflict_id), this.people)}`
        : c.decision ? decisionText(c.decision, this.people) : '';
    });
  }

  _refresh() {
    const n = this.conflicts.length;
    this.progressText.textContent = progressText(this.conflicts, this.row);
    this.progressBar.style.width = `${Math.round(decidedShare(this.conflicts) * 100)}%`;
    this._refreshItems();
    this._detail();
    this._refreshBar();
    this._markers();
    this.lanes.setConflicts(this.conflicts, this.row, this.pending && this.pending.choice === 'pick' ? this.pending.picks : null);
    if (this.finishBtn) this.finishBtn.hidden = !(n && this._decided() === n);
  }

  /** For two or more corrections: what each expert changed at this conflict, and why. */
  _changesAt(v, c) {
    if (v.source !== 'correction' || !(v.changes || []).length) return [];
    const ids = new Set((c.marks || []).map((m) => m.annotation_id));
    const overlaps = (x) => x && x.onset_sample < c.offset_sample && x.onset_sample + x.duration_samples > c.onset_sample;
    return v.changes.filter((ch) => ids.has(ch.annotation_id) || overlaps(ch.before) || overlaps(ch.after));
  }

  _detail() {
    clear(this.detail);
    const c = this.conflicts[this.row];
    if (!c) { this.detail.append(h('p.caption', {}, this.conflicts.length ? '' : 'There are no conflicts: everyone agrees.')); return; }
    const rows = this.versions.map((v) => {
      const marks = (c.marks || []).filter((m) => m.letter === v.letter);
      const what = marks.length ? marks.map((m) => {
        const extra = [m.channels.length ? channelList(m.channels, this._montage()) : 'whole montage'];
        if (Number.isInteger(m.confidence)) extra.push(`confidence ${m.confidence} of 5`);
        return h('span.adj-mark', {}, h('span.swatch', { style: { background: this.ws.cat.get(m.label)?.colour || null } }), ` ${m.label}, ${spanText(m.onset_s, m.offset_s)} (${extra.join(', ')})`,
          m.note ? h('span.caption', {}, ` “${m.note}”`) : null);
      }) : [h('span.caption', {}, 'no mark here')];
      const why = this._changesAt(v, c).map((ch) => h('span.adj-change.caption', {}, `${ch.change === 'added' ? 'Added' : ch.change === 'removed' ? 'Removed' : 'Changed'}: `
        + `${ch.reason_text || CORRECTION_REASONS[ch.reason] || ch.reason || 'no reason given'}${ch.note ? `, “${ch.note}”` : ''}`));
      return h('li', { 'data-letter': v.letter }, h('b', { style: { color: this._colourOf(v.letter) } }, `${v.letter} `), `${v.annotator_id}: `, ...what, ...why);
    });
    const d = c.decision;
    this.detail.append(...[
      h('div.adj-detail-head', {}, h('b', {}, `Conflict ${this.row + 1}`), h('span.caption', {}, ` ${spanText(c.onset_s, c.offset_s)}`),
        ...(c.kinds || []).map((k) => h('span.chip.adj-kind', { 'data-kind': k }, KIND_TEXT[k] || k))),
      h('ul.adj-versions', {}, rows),
      d ? h('p.adj-decided', {}, h('b', {}, `${decisionText(d, this.people)}. `), d.reason_code ? `${REASON_TEXT[d.reason_code]}${d.reason ? ': ' : '.'}` : '', d.reason || '',
) : null].filter(Boolean));
  }

  _refreshBar() {
    if (!this.decide) return;
    const p = this.pending || {};
    const waiting = Boolean(this.sending);
    for (const b of this.choiceBtns) { b.setAttribute('aria-pressed', String(p.choice === b.dataset.choice)); b.disabled = waiting; }
    const chosen = this.reasonBtns.findIndex((b) => b.dataset.reason === p.reasonCode);
    this.reasonBtns.forEach((b, i) => {
      b.setAttribute('aria-checked', String(i === chosen));
      b.tabIndex = i === (chosen >= 0 ? chosen : 0) ? 0 : -1;
      b.disabled = waiting;
    });
    if (this.reasonInput.value !== (p.reason || '') && document.activeElement !== this.reasonInput) this.reasonInput.value = p.reason || '';
    this.reasonInput.disabled = waiting;
    this.saveBtn.disabled = waiting || !p.choice;
    this.skipBtn.disabled = waiting;
    this.reasonNote.textContent = p.choice ? (reasonNeeded(this.rule, p.choice) ? 'Reason needed' : 'Reason optional') : '';
  }

  _markers() {
    const c = this.conflicts[this.row];
    const list = this.conflicts.map((x, i) => ({ onset_sample: x.onset_sample, duration_samples: Math.max(1, x.offset_sample - x.onset_sample), current: i === this.row,
      outline: i === this.row }));
    if (c && this.pending && this.pending.choice === 'edited') {
      for (const m of this.pending.marks || []) list.push({ onset_sample: m.onset_sample, duration_samples: m.duration_samples, outline: true });
    }
    this.ws.viewer.setMarkers(list);
  }

  // ------------------------------------------------------------------ leaving
  leave(reason = 'closed') {
    if (this.left) return;
    this.left = true;
    logger.event('adjudication_closed', { unit_id: this.unitId, decided: this._decided(), n_conflicts: this.conflicts.length, reason, unsaved: this.pendingBy.size });
    const app = this.app;
    this.ws.destroy();
    if (app.ws === this.ws) app.ws = null;
    if (this.back) this.back();
    else app.showExpert('expert-queue');
  }

  /** The workspace's Back: the decisions are kept by the study already; a choice not saved is asked about first. */
  async beforeClose() {
    if (this.sending) { this.ws.say('Wait a moment: the last decision is still being saved.'); return false; }
    const n = this.mode === 'decide' ? this.pendingBy.size : 0;
    if (n && !(await ask('Leave without saving?', `${n} choice${n === 1 ? ' you made has' : 's you made have'} not been saved (Enter saves a decision). The decisions already saved are kept.`,
      { yes: 'Leave', no: 'Stay', defaultYes: false }))) return false;
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
      const back = view.purpose && view.purpose.onBack;
      view.showProblem(exc.message, [back ? h('button.btn', { type: 'button', 'data-log': 'open-back', onclick: () => back() }, 'Back to the adjudication queue') : view.backButton()]);
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
  const who = whoText(got.versions);
  const started = Boolean(got.adjudication);
  const note = mode === 'view'
    ? `The versions of ${who}, with the decisions. Open the recording from this computer: its fingerprint is checked against the study's copy.`
    : `${got.progress.conflicts} conflict${got.progress.conflicts === 1 ? '' : 's'} between ${who}${started ? `, ${got.progress.decided} decided so far` : ''}. Open the recording from this computer: its fingerprint is checked against the study's copy${started ? '' : ', then the adjudication starts and the versions are fixed as they are now'}.`;
  return app.openFromComputer({ recording_id: got.unit.recording_id, file_name: got.file_name, format: m.format },
    { purpose: { kind, route: 'expert-adjudicate', target: { ...got, mode, focus }, onBack: goBack,
      title: `${mode === 'view' ? 'Open' : started ? 'Continue adjudicating' : 'Adjudicate'} ${got.file_name}`, note } });
}
