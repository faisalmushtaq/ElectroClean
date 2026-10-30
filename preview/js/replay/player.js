// The replay player (docs/web/admin.md, "Replaying a session"; docs/web/using.md, "Watching an
// expert at work"): an annotator's session played back from the interaction log on the EEG, in a
// view-only annotation view of kind 'replay'. The view follows the annotator's scrolling, a small
// ink-blue ring shows their pointer, the annotations build up as they made them (in the Annotations
// tab too), and a caption says what they did. Under the EEG are Play and Pause (Space), the speed
// (- and =), a step to the previous or next event (, and .) or change of the annotations (< and >, or N
// and P as in the other expert views),
// Home for the start, and a scrubber with a tick for each change and the pauses greyed; Skip pauses
// (I) shortens every stillness to three seconds, and Follow the annotator (F) is left by moving
// through the EEG oneself. At the end the player says whether the replay matches the saved version,
// on the line under the EEG and near the top of the side panel, so that it is in view on a small
// screen. "What happened last" folds a key pressed several times in a row into one line ("× 3"), and ?
// lists the player's keys (js/expert/key_sheet.js); on a touch screen the keys are not mentioned.
//
// The events come page by page from replay_events_get (js/replay/model.js rebuilds the state). The
// replay itself is logged in the watcher's own log as replay_opened, replay_control and replay_closed.

import { h, clear } from '../ui/dom.js';
import { logger, keyName } from '../log/logger.js';
import { icon } from '../views/common.js';
import { touchFirst } from '../util.js';
import { isHelpKey, showKeySheet } from '../expert/key_sheet.js';
import { AnnotationSession } from '../annotate/session.js';
import { Workspace } from '../annotate/workspace.js';
import { SPEEDS, buildTimeline, captionOf, clock, clockTenths, compareWithSaved, compressIdle, mapTime, nextChange, nextEvent, prevChange, prevEvent, stateAt } from './model.js';

const PAGE = 4000;
const MAX_PAGES = 50;
const RECENT = 6;

/** The segments a replay of version `attempt` plays: every one up to the one that saved it (all of them without one). */
export function segmentsFor(segments, attempt) {
  const list = segments || [];
  const i = attempt ? list.findIndex((s) => s.attempt === attempt) : -1;
  return i >= 0 ? list.slice(0, i + 1) : list;
}

/** The player's keys, for its key sheet (?). */
export const REPLAY_KEYS = Object.freeze([
  { title: 'Playing', rows: [['Space', 'play or pause'], ['- / =', 'slower or faster (half to sixteen times)'], ['Home', 'back to the start'],
    ['I', 'skip pauses: every stillness shortened to three seconds'], ['F', 'follow the annotator\'s view, or look around yourself']] },
  { title: 'Stepping', rows: [[', / .', 'the previous or next event'], ['N / P', 'the next or previous change of the annotations, as in the other expert views'],
    ['< / >', 'the previous or next change of the annotations'],
    ['Left arrow / Right arrow', 'on the bar under the EEG: five seconds back or on'], ['?', 'this list of keys']] },
]);

/**
 * "What happened last": the latest `n` lines, newest first, a line said several times in a row folded into one
 * with its count ([{text, t, change, times}]), from the time line's items up to index `idx`.
 */
export function recentLines(items, idx, captionOf, n = 6) {
  const out = [];
  for (let i = idx; i >= 0; i--) {
    const text = captionOf(items[i].e);
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.text === text) { last.times += 1; continue; }
    if (out.length >= n) break;
    out.push({ text, t: items[i].t, change: items[i].change, times: 1 });
  }
  return out;
}

/** A segment in words: "Session 2: 14 October at 10:05, saved as version 1". */
export function segmentText(s, i) {
  const d = s.started_at ? new Date(s.started_at) : null;
  const when = d && !Number.isNaN(d.getTime())
    ? `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} at ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'an earlier visit';
  const end = s.outcome === 'finished' ? (s.attempt ? `saved as version ${s.attempt}` : 'saved') : s.outcome === 'closed_without_saving' ? 'closed without saving' : 'not finished';
  return `Session ${i + 1}: ${when}, ${end}`;
}

/** Fetch every event of a segment, page by page (reads, which may be asked again after a failure). */
export async function segmentEvents(backend, seg, { onPage = null } = {}) {
  const events = [];
  let from = seg.first_seq || 0;
  for (let p = 0; p < MAX_PAGES && from !== null && from !== undefined; p++) {
    const page = await backend.expert('replay_events_get', { visit_id: seg.visit_id, window_no: seg.window_no, from_seq: from, limit: PAGE, pointer: true });
    events.push(...page.events);
    from = page.next_seq;
    if (onPage) onPage(events.length);
  }
  return events;
}

export class ReplayPlayer {
  /**
   * @param {Workspace} ws a view-only workspace of kind 'replay'
   * @param {{index: object, backend: object, back?: object|null}} o index: the answer of replay_index_get; back: where an expert returns
   */
  constructor(ws, { index, backend, back = null }) {
    this.ws = ws;
    this.back = back;
    this.index = index;
    this.backend = backend;
    this.sf = ws.sf;
    this.t = 0;
    this.speed = 1;
    this.playing = false;
    this.skipPauses = true;
    this.follow = true;
    this.full = null;
    this.timeline = null;
    this.ended = false;
    this.watchedS = 0;
    this._lastIdx = -2;
    this._shownKey = '';
    this._raf = 0;
    this.segments = segmentsFor(index.segments, index.saved && index.saved.attempt);
    ws.pass = this;
    ws.keyHook = (e) => this.onKey(e);
    ws.el.classList.add('replaying');
    // The workspace's own listener would log every replayed change as the watcher's: the store only shows them.
    ws.store.removeListener(ws._storeListener);
    const onView = ws.viewer.onView;
    ws.viewer.onView = (v, cause) => {
      if (cause !== 'replay' && cause !== 'restore' && this.follow && this.timeline) this.setFollow(false, 'eeg');
      if (cause !== 'replay') onView(v, cause); else ws._syncViewState();
    };
    this._build();
    ws.onDestroy(() => this.destroy());
  }

  _btn(name, label, log, fn, key) {
    return h('button.btn.icon.small.replay-btn', { type: 'button', 'aria-label': label, title: `${label}${key ? ` (${key})` : ''}`, 'data-log': `replay-${log}`, onclick: fn }, icon(name));
  }

  _build() {
    const ix = this.index;
    this.playBtn = h('button.btn.small.replay-play', { type: 'button', 'data-log': 'replay-play', title: 'Play or pause (Space)', onclick: () => this.toggle('button') },
      icon('play'), h('span.replay-play-label', {}, 'Play'));
    this.timeEl = h('span.replay-time', { 'aria-live': 'off' }, '0:00 / 0:00');
    this.speedBtns = SPEEDS.map((s) => h('button.seg', { type: 'button', 'aria-pressed': String(s === this.speed), 'data-speed': String(s), 'data-log': 'replay-speed',
      onclick: () => this.setSpeed(s, 'button') }, `${s}×`));
    this.fill = h('span.replay-fill');
    this.handle = h('span.replay-handle');
    this.track = h('div.replay-track', {}, this.fill, this.handle);
    this.scrub = h('div.replay-scrub', { role: 'slider', tabindex: '0', 'aria-label': 'Where in the session', 'aria-valuemin': '0', 'data-log': 'replay-scrub' }, this.track);
    this._scrubbing();
    this.skipBox = h('input', { type: 'checkbox', checked: this.skipPauses, 'data-log': 'replay-skip-pauses', onchange: () => this.setSkip(this.skipBox.checked, 'button') });
    this.followBox = h('input', { type: 'checkbox', checked: this.follow, 'data-log': 'replay-follow', onchange: () => this.setFollow(this.followBox.checked, 'button') });
    this.followAgain = h('button.btn.small.quiet.replay-follow-again', { type: 'button', hidden: true, 'data-log': 'replay-follow-again', onclick: () => this.setFollow(true, 'button') }, 'Follow again');
    this.caption = h('p.replay-caption', { 'aria-live': 'polite' }, 'Loading the session…');
    this.bar = h('div.replay-bar', { role: 'toolbar', 'aria-label': 'Replay' },
      h('div.replay-row', {},
        this.playBtn,
        this._btn('to-start', 'To the start', 'start', () => this.seek(0, 'start'), 'Home'),
        this._btn('step-back', 'Previous event', 'prev-event', () => this.stepEvent(-1), ','),
        this._btn('step-forward', 'Next event', 'next-event', () => this.stepEvent(1), '.'),
        this._btn('chevron-left', 'Previous change of the annotations', 'prev-change', () => this.stepChange(-1), '<'),
        this._btn('chevron-right', 'Next change of the annotations', 'next-change', () => this.stepChange(1), '>'),
        this.timeEl,
        h('div.segmented.replay-speeds', { role: 'group', 'aria-label': 'Speed (- and =)' }, this.speedBtns)),
      this.scrub,
      h('div.replay-row', {},
        h('label.replay-toggle', {}, this.skipBox, ' Skip pauses', h('span.key-hint.inline', {}, ' (I)')),
        h('label.replay-toggle', {}, this.followBox, ' Follow the annotator', h('span.key-hint.inline', {}, ' (F)')),
        this.followAgain),
      this.caption);
    this.ws.eegHost.append(this.bar);
    const who = `${ix.annotator_id}${ix.display_name ? ` (${ix.display_name})` : ''}`;
    this.segList = h('ol.replay-segments', { 'aria-label': 'Sessions in the replay' });
    this.recent = h('ol.replay-recent', { 'aria-label': 'What happened last' });
    this.countEl = h('p.caption.replay-count');
    this.endEl = h('p.replay-end', { role: 'status', hidden: true });
    this.el = h('section.review.card.replay-panel', { 'aria-label': 'Replay' },
      h('h2', {}, `Replay of ${who}`),
      h('p.caption', {}, `How ${ix.annotator_id} worked on ${ix.file_name}, from the study's record of the session. Notes and anything typed are never recorded: a note shows only its length.`),
      this.segList, this.countEl, this.endEl, h('h3', {}, 'What happened last'), this.recent,
      this.back && this.back.route ? h('div.btn-row', {}, h('button.btn.small', { type: 'button', 'data-log': 'replay-overlay',
        title: `Everyone's marks on ${ix.file_name}, with ${ix.annotator_id} in a lane`, onclick: () => this.openOverlay() }, 'Everyone\'s marks on this recording')) : null);
    this.ws.reviewHost.append(this.el);
    this.ws.hintEl.textContent = touchFirst() ? 'Tap Play  ·  drag along the bar to go anywhere in the session'
      : 'Space  play or pause  ·  , .  step  ·  < >  changes  ·  - =  speed  ·  ?  keys';
  }

  _scrubbing() {
    const at = (e) => {
      const r = this.track.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
      return f * (this.timeline ? this.timeline.duration : 0);
    };
    let down = false;
    this.scrub.addEventListener('pointerdown', (e) => { if (!this.timeline) return; down = true; this.scrub.setPointerCapture(e.pointerId); this.seek(at(e), 'scrub'); });
    this.scrub.addEventListener('pointermove', (e) => { if (down) this.seek(at(e), null); });
    const up = () => { down = false; };
    this.scrub.addEventListener('pointerup', up);
    this.scrub.addEventListener('pointercancel', up);
    this.scrub.addEventListener('keydown', (e) => {
      if (!this.timeline) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        this.seek(this.t + (e.key === 'ArrowLeft' ? -5 : 5), 'scrub_key');
      }
    });
  }

  /** Fetch the segments' events and build the time line. */
  async load() {
    const ix = this.index;
    clear(this.segList);
    if (!this.segments.length) {
      this.caption.textContent = ix.logging === false
        ? 'This study does not record how sessions went, so there is nothing to replay. The saved version is shown.'
        : 'No session of this recording is in the record of how it was annotated (it may have been saved before the record was kept). The saved version is shown.';
      this._showSaved();
      this._disable(true);
      logger.event('replay_opened', { annotator_id: ix.annotator_id, recording_id: ix.recording_id, n_segments: 0, n_events: 0 });
      return false;
    }
    this.segList.append(...this.segments.map((s, i) => h('li.caption', { 'data-segment': String(i) }, segmentText(s, i))));
    this._disable(true);
    const loaded = [];
    try {
      for (const [i, seg] of this.segments.entries()) {
        const events = await segmentEvents(this.backend, seg, { onPage: (n) => { this.caption.textContent = `Loading session ${i + 1} of ${this.segments.length}: ${n} events…`; } });
        loaded.push({ segment: seg, events });
      }
    } catch (exc) {
      if (exc.status === 401) return false;
      this.caption.textContent = `The record of the session could not be loaded: ${exc.message}. Close the replay and open it again.`;
      return false;
    }
    if (this.ws._destroyed) return false;
    this.full = buildTimeline(loaded, { sfreq: this.sf });
    this.quick = compressIdle(this.full, 3);
    this.timeline = this.skipPauses ? this.quick : this.full;
    this._drawTrack();
    this._disable(false);
    const n = loaded.reduce((a, x) => a + x.events.length, 0);
    logger.event('replay_opened', { annotator_id: ix.annotator_id, recording_id: ix.recording_id, n_segments: loaded.length, n_events: n,
      attempt: ix.saved ? ix.saved.attempt : null });
    const unknown = this.full.segments.some((s) => s.unknownStart);
    this.caption.textContent = unknown ? 'This session started from annotations the record does not hold (it was saved before snapshots were kept). Press Play.'
      : `Ready: ${loaded.length === 1 ? 'one session' : `${loaded.length} sessions`}, ${clock(this.full.duration)} in all. Press Play (Space).`;
    this.seek(0, null);
    return true;
  }

  _disable(on) {
    for (const b of this.bar.querySelectorAll('button, input')) if (!b.classList.contains('replay-follow-again')) b.disabled = on;
  }

  _showSaved() {
    const saved = (this.index.saved && this.index.saved.annotations) || [];
    this._showAnnotations(saved.map((a) => ({ ...a, channels: [...(a.channels || [])] })));
  }

  _drawTrack() {
    const tl = this.timeline;
    for (const el of [...this.track.querySelectorAll('.replay-tick, .replay-idle, .replay-seg')]) el.remove();
    const pc = (t) => `${tl.duration ? (100 * t) / tl.duration : 0}%`;
    for (const [a, b] of tl.idle) {
      if (b - a <= 0) continue;
      this.track.prepend(h('span.replay-idle', { style: { left: pc(a), width: pc(b - a) }, title: 'Paused or away' }));
    }
    for (const s of tl.segments.slice(1)) this.track.prepend(h('span.replay-seg', { style: { left: pc(s.start) }, title: 'A new session' }));
    for (const it of tl.items) {
      if (!it.change || it.e.type === 'annotations_snapshot') continue;
      const list = it.e.annotations || it.e.added || it.e.changed || [];
      const label = list[0] && list[0].label;
      const colour = label && this.ws.cat.has(label) ? this.ws.cat.colourFor(label) : null;
      this.track.insertBefore(h('span.replay-tick', { style: { left: pc(it.t), ...(colour ? { background: colour } : {}) } }), this.fill);
    }
    this.scrub.setAttribute('aria-valuemax', String(Math.round(tl.duration)));
  }

  // --------------------------------------------------------------- playing
  toggle(via = 'key') { if (this.playing) this.pause(via); else this.play(via); }

  play(via = 'key') {
    if (!this.timeline || this.playing) return;
    if (this.t >= this.timeline.duration - 1e-6) this.seek(0, null);
    this.playing = true;
    this.ended = false;
    this.endEl.hidden = true;
    this._setPlayButton();
    logger.event('replay_control', { action: 'play', speed: this.speed, t: Math.round(this.t * 10) / 10, via });
    let last = performance.now();
    const frame = (now) => {
      if (!this.playing) return;
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      this.watchedS += dt;
      this.seek(this.t + dt * this.speed, null);
      if (this.t >= this.timeline.duration - 1e-6) { this.pause('end'); this._end(); return; }
      this._raf = requestAnimationFrame(frame);
    };
    this._raf = requestAnimationFrame(frame);
  }

  pause(via = 'key') {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this._raf);
    this._setPlayButton();
    logger.event('replay_control', { action: 'pause', speed: this.speed, t: Math.round(this.t * 10) / 10, via });
  }

  _setPlayButton() {
    clear(this.playBtn);
    this.playBtn.append(icon(this.playing ? 'pause' : 'play'), h('span.replay-play-label', {}, this.playing ? 'Pause' : 'Play'));
    this.playBtn.setAttribute('aria-pressed', String(this.playing));
  }

  setSpeed(s, via = 'key') {
    this.speed = s;
    for (const b of this.speedBtns) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === s));
    logger.event('replay_control', { action: 'speed', speed: s, via });
    this.ws.say(`Speed ${s}×`);
  }

  stepSpeed(dir) {
    const i = SPEEDS.indexOf(this.speed);
    this.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i + dir))], 'key');
  }

  setSkip(on, via = 'key') {
    if (!this.full) return;
    const from = this.timeline;
    this.skipPauses = Boolean(on);
    this.skipBox.checked = this.skipPauses;
    this.timeline = this.skipPauses ? this.quick : this.full;
    const t = mapTime(from, this.timeline, this.t);
    this._drawTrack();
    logger.event('replay_control', { action: 'skip_pauses', on: this.skipPauses, via });
    this.seek(t, null);
    this.ws.say(this.skipPauses ? 'Skip pauses: every stillness is shortened to three seconds.' : 'Pauses are played as they were.');
  }

  setFollow(on, via = 'key') {
    this.follow = Boolean(on);
    this.followBox.checked = this.follow;
    this.followAgain.hidden = this.follow;
    logger.event('replay_control', { action: 'follow', on: this.follow, via });
    if (this.follow && this.timeline) { this._shownKey = ''; this.seek(this.t, null); }
    if (!this.follow && via === 'eeg') this.ws.say('Free look: you move through the EEG yourself. Follow again goes back to the annotator\'s view (F).');
  }

  stepEvent(dir) {
    if (!this.timeline) return;
    this.pause('step');
    const t = dir > 0 ? nextEvent(this.timeline, this.t) : prevEvent(this.timeline, this.t);
    if (t === null) { this.ws.say(dir > 0 ? 'That was the last event' : 'That was the first event'); return; }
    this.seek(t, dir > 0 ? 'next_event' : 'prev_event');
  }

  stepChange(dir) {
    if (!this.timeline) return;
    this.pause('step');
    const t = dir > 0 ? nextChange(this.timeline, this.t) : prevChange(this.timeline, this.t);
    if (t === null) { this.ws.say(dir > 0 ? 'No later change of the annotations' : 'No earlier change of the annotations'); return; }
    this.seek(t, dir > 0 ? 'next_change' : 'prev_change');
  }

  /** Go to time t on the time line and show the state there (`log`: the control to log, or null). */
  seek(t, log = 'seek') {
    if (!this.timeline) return;
    const tl = this.timeline;
    this.t = Math.min(Math.max(0, t), tl.duration);
    if (this.ended && this.t < tl.duration - 1e-6) { // moved back from the end: the line under the EEG follows again
      this.ended = false;
      this.endEl.hidden = true;
      this._lastIdx = -2;
    }
    if (log) logger.event('replay_control', { action: log, t: Math.round(this.t * 10) / 10 });
    const pc = tl.duration ? (100 * this.t) / tl.duration : 0;
    this.fill.style.width = `${pc}%`;
    this.handle.style.left = `${pc}%`;
    this.timeEl.textContent = tl.duration < 600 ? `${clockTenths(this.t)} / ${clockTenths(tl.duration)}` : `${clock(this.t)} / ${clock(tl.duration)}`;
    this.scrub.setAttribute('aria-valuenow', String(Math.round(this.t)));
    this.scrub.setAttribute('aria-valuetext', `${clock(this.t)} of ${clock(tl.duration)}`);
    const st = stateAt(tl, this.t);
    this._render(st);
    if (log && this.t >= tl.duration - 1e-6) this._end();
  }

  _render(st) {
    const v = this.ws.viewer;
    const list = [...st.annotations.values()].map((a) => ({ ...a, note: a.note_length ? '…' : '' }));
    const key = list.map((a) => `${a.annotation_id}:${a.label}:${a.onset_sample}:${a.duration_samples}:${a.channels.join(',')}:${a.confidence}:${a.note_length}`).join('|');
    if (key !== this._shownKey) { this._shownKey = key; this._showAnnotations(list); }
    v.setSelection(st.selection);
    v.setReplayPointer(st.pointer);
    const label = st.label && this.ws.cat.has(st.label) ? st.label : null;
    v.setMarkStart(st.markStartS === null || st.markStartS === undefined ? null : st.markStartS, label ? this.ws.cat.colourFor(label) : '#63615D');
    if (this.follow && st.view) v.setView({ startS: st.view.startS, durationS: st.view.durationS, firstChannel: st.view.firstChannel, nChannels: st.view.nChannels, scaleFactor: st.view.scaleFactor }, 'replay');
    if (this.follow && Boolean(v.overlay) !== Boolean(st.overlay)) this.ws.setOverlay(Boolean(st.overlay), 'replay');
    const idx = st.event ? this.timeline.items.indexOf(st.event) : -1;
    if (idx !== this._lastIdx) {
      this._lastIdx = idx;
      this._caption(st, idx);
    }
    this.countEl.textContent = `${list.length} annotation${list.length === 1 ? '' : 's'} at this moment${st.segment >= 0 ? `, in session ${st.segment + 1}` : ''}`;
    for (const li of this.segList.children) li.classList.toggle('current', Number(li.dataset.segment) === st.segment);
  }

  _showAnnotations(list) {
    const ws = this.ws;
    try {
      ws.store.reset(list); // only shown: the workspace's listener is off, so nothing is logged for it
    } catch {
      ws.viewer.setAnnotations(list);
      return;
    }
    ws.viewer.setAnnotations(ws.store.annotations());
    ws._prev = new Map(ws.store.annotations().map((a) => [a.annotation_id, a]));
    ws._refreshList();
  }

  _caption(st, idx) {
    const said = recentLines(this.timeline.items, idx, captionOf, RECENT);
    const now = said[0] ? said[0].text : 'The start of the session';
    if (!this.ended) this.caption.textContent = `${st.paused ? 'Paused by the annotator. ' : ''}${st.dialog ? `Dialog open: ${st.dialog.title}. ` : ''}${now}`;
    clear(this.recent);
    const at = this.timeline.duration < 600 ? clockTenths : clock;
    this.recent.append(...said.map((x) => h('li', { class: x.change ? 'change' : null }, h('span.replay-at', {}, at(x.t)), ' ', x.text,
      x.times > 1 ? h('span.replay-times', { title: `${x.times} times in a row` }, ` × ${x.times}`) : null)));
  }

  /** The end of the last session: does the replay end with the saved version? */
  _end() {
    if (this.ended) return;
    this.ended = true;
    const saved = this.index.saved;
    this.endEl.hidden = false;
    if (!saved) {
      this.endEl.textContent = 'The end of the record of this session.';
      this.endEl.className = 'replay-end note';
      this.caption.textContent = this.endEl.textContent;
      return;
    }
    const cmp = compareWithSaved(this.full.finalState, saved.annotations || [], this.sf);
    this.result = cmp;
    this.endEl.className = cmp.same ? 'replay-end success' : 'replay-end note';
    this.endEl.textContent = cmp.same ? `The replay matches the saved version ${saved.attempt}.`
      : `The replay differs from the saved version ${saved.attempt} in ${cmp.differing} mark${cmp.differing === 1 ? '' : 's'}: the record may be missing part of the session.`;
    this.caption.textContent = `The end. ${this.endEl.textContent}`; // under the EEG, in view on a small screen too
    logger.event('replay_control', { action: 'end', same: cmp.same, differing: cmp.differing });
  }

  onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key;
    const take = (action, fn) => { e.preventDefault(); logger.shortcut(keyName(e), action); fn(); return true; };
    if (isHelpKey(e)) return take('Keys', () => { void showKeySheet('Keys of the replay', REPLAY_KEYS, { view: 'replay', foot: null }); });
    if (k === ' ') return take('Play or pause', () => this.toggle('key'));
    if (k === '-' || k === '_') return take('Slower', () => this.stepSpeed(-1));
    if (k === '=' || k === '+') return take('Faster', () => this.stepSpeed(1));
    if (k === ',') return take('Previous event', () => this.stepEvent(-1));
    if (k === '.') return take('Next event', () => this.stepEvent(1));
    if (k === '<' || ((k === 'p' || k === 'P') && !e.shiftKey)) return take('Previous change', () => this.stepChange(-1));
    if (k === '>' || ((k === 'n' || k === 'N') && !e.shiftKey)) return take('Next change', () => this.stepChange(1));
    if (k === 'Home') return take('To the start', () => { this.pause('key'); this.seek(0, 'start'); });
    if (k === 'i' || k === 'I') return take('Skip pauses', () => this.setSkip(!this.skipPauses, 'key'));
    if (k === 'f' || k === 'F') return take('Follow the annotator', () => this.setFollow(!this.follow, 'key'));
    return false;
  }

  /** Leave the replay for everyone's marks on the same recording (js/expert/overlay.js), this person in a lane. */
  async openOverlay() {
    const app = this.ws.app;
    const ix = this.index;
    const { startOverlay } = await import('../expert/overlay.js');
    this.ws.destroy();
    if (app.ws === this.ws) app.ws = null;
    const got = await startOverlay(app, { recording_id: ix.recording_id, mode: ix.mode || 'standard', context_id: ix.context_id || '', focus: [ix.annotator_id] }, this.back);
    if (!got) await app.showExpert(this.back.route, this.back.params || null);
  }

  destroy() {
    this.playing = false;
    cancelAnimationFrame(this._raf);
    logger.event('replay_closed', { annotator_id: this.index.annotator_id, recording_id: this.index.recording_id, watched_s: Math.round(this.watchedS * 10) / 10,
      ended: this.ended, same: this.result ? this.result.same : null });
  }
}

/** Open the replay for a file checked against the study's copy (js/views/purposes.js, purpose replay). */
export async function openReplay(app, { recording, fp, view, target }) {
  let session;
  try {
    session = new AnnotationSession({ backend: app.backend, recording, manifest: target.manifest, recordingId: target.recording_id, mode: target.mode || 'standard',
      contextId: target.context_id || '', me: app.me, catalogue: app.catalogue, sha256: fp.hex, readOnly: true });
  } catch (exc) {
    view.showProblem(exc.message, [view.chooseAgainButton()]);
    return null;
  }
  if (app.ws) app.ws.destroy();
  const back = view.purpose.back || null;
  const leave = async (ws) => {
    if (!(back && back.route)) { await app.leaveRecording(ws, 'replay closed'); return; } // a trainee: home, or the training path
    ws.destroy();
    if (app.ws === ws) app.ws = null;
    await app.showExpert(back.route, back.params || null);
  };
  const ws = new Workspace(app, session, { kind: 'replay', onLeave: leave });
  app.ws = ws;
  app._render(ws.el, back && back.route ? 'expert-replay' : 'annotate');
  ws.mount(app.content);
  const player = new ReplayPlayer(ws, { index: target, backend: app.backend, back });
  await player.load();
  return player;
}
