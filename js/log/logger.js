// The interaction log: the same kinds of events as the desktop application (docs/activity_logs.md),
// with `t` in seconds from the start of the visit on a monotonic clock, sent to the study in
// batches. Typed text and passwords are never recorded: key presses in text fields are skipped
// and only the values of number fields are kept.

import { isTyping } from '../ui/dom.js';
import { nowLocalIso } from '../util.js';

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'OS']);
const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'];
const VIA_WINDOW_MS = 3000;
const round3 = (v) => Math.round(v * 1000) / 1000;

function modifiers(e) {
  const out = [];
  if (e.shiftKey) out.push('Shift');
  if (e.ctrlKey) out.push('Ctrl');
  if (e.altKey) out.push('Alt');
  if (e.metaKey) out.push('Meta');
  return out;
}

export function keyName(e) {
  if (e.key === ' ') return 'Space';
  if (e.key && e.key.length === 1) return e.key.toUpperCase();
  return e.key || e.code || '';
}

/** What was clicked: the nearest control, as the desktop log describes widgets. */
export function describeTarget(target) {
  if (!(target instanceof Element)) return { widget: '' };
  const el = target.closest('button, a, input, select, textarea, [role="menuitem"], [role="tab"], [role="option"], tr[data-id], li[data-log], canvas, [data-log]') || target;
  const tag = el.tagName.toLowerCase();
  const out = { widget: el.dataset.widget || (el.getAttribute('role') ? `${tag}:${el.getAttribute('role')}` : tag) };
  const name = el.dataset.log || el.id || el.getAttribute('aria-label') || el.getAttribute('name') || '';
  if (name) out.name = name;
  if (['button', 'a'].includes(tag) || ['menuitem', 'tab', 'option'].includes(el.getAttribute('role'))) {
    const text = (el.dataset.logText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (text) out.text = text;
  }
  if (tag === 'tr' && el.dataset.id) {
    out.row = [...el.parentElement.children].indexOf(el);
    out.item = (el.dataset.logText || el.cells[0]?.textContent || '').trim().slice(0, 80);
  }
  if (tag === 'input') out.input_type = (el.getAttribute('type') || 'text').toLowerCase();
  return out;
}

export class InteractionLogger {
  constructor() {
    this.enabled = false;
    this.backend = null;
    this.visitId = null;
    this.t0 = performance.now();
    this.queue = [];
    this.context = {};
    this.topWindow = '';
    this.pointerHz = 5;
    this.idleAfterS = 30;
    this.eegAt = null; // (clientX, clientY) -> {area, eeg_t, eeg_channel} | null, set by the viewer
    this._lastVia = null;
    this._lastInput = performance.now();
    this._idle = false;
    this._press = null;
    this._pointer = null;
    this._wheel = null;
    this._timers = [];
    this._installed = false;
    this.sent = 0;
  }

  now() { return round3((performance.now() - this.t0) / 1000); }

  /** Start logging a visit (after POST /visits). */
  begin({ backend, visitId, logging }) {
    this.backend = backend;
    this.visitId = visitId;
    this.enabled = Boolean(logging && logging.interactions !== false && visitId);
    this.pointerHz = Number(logging && logging.pointer_hz) || 5;
    this.idleAfterS = Number(logging && logging.idle_after_s) || 30;
    this.t0 = performance.now();
    this._lastInput = performance.now();
    this._install();
    this._timers.forEach(clearInterval);
    this._timers = [
      setInterval(() => this.flush(), backend.eventFlushMs || 4000),
      setInterval(() => this._checkIdle(), 1000),
    ];
  }

  async end(reason) {
    if (!this.visitId) return;
    this.event('log_closed', { reason });
    const id = this.visitId;
    await this.flush();
    this.enabled = false;
    this._timers.forEach(clearInterval);
    this._timers = [];
    this.visitId = null;
    try { await this.backend.closeVisit(id, reason); } catch { /* the server closes it later */ }
  }

  setContext(ctx) { this.context = ctx ? { ...ctx } : {}; }

  event(type, fields = {}) {
    if (!this.enabled) return;
    this.queue.push({ t: this.now(), wall: nowLocalIso(), ...this.context, ...fields, type });
    if (this.queue.length >= 200) this.flush();
  }

  /** The input that caused a change (kept for three seconds), as the desktop's `via`. */
  noteInput(via) { this._lastVia = { via, at: performance.now() }; }

  via() {
    return this._lastVia && performance.now() - this._lastVia.at <= VIA_WINDOW_MS ? this._lastVia.via : 'unknown';
  }

  shortcut(key, action) {
    this.noteInput(`shortcut:${action}`);
    this.event('shortcut', { key, action });
  }

  status(text) { this.event('status_message', { text }); }

  /** Send the waiting events, in order (one batch after another). */
  flush({ final = false } = {}) {
    this._chain = (this._chain || Promise.resolve()).then(() => this._send(final));
    return this._chain;
  }

  async _send(final) {
    while (this.visitId && this.backend && this.queue.length) {
      // fetch(keepalive), used while the page closes, carries at most 64 kB: smaller batches then.
      const batch = this.queue.splice(0, final ? 100 : 500);
      try {
        await this.backend.sendEvents(this.visitId, batch, { keepalive: final });
        this.sent += batch.length;
      } catch {
        if (!final) this.queue.unshift(...batch.slice(-(5000 - this.queue.length)));
        return;
      }
    }
  }

  // ------------------------------------------------------------ listeners
  _input() {
    const now = performance.now();
    if (this._idle) {
      this._idle = false;
      this.event('idle_end', { idle_s: round3((now - this._lastInput) / 1000) });
    }
    this._lastInput = now;
  }

  _checkIdle() {
    if (!this.enabled || this._idle) return;
    if (document.visibilityState === 'hidden') return;
    if (performance.now() - this._lastInput > this.idleAfterS * 1000) {
      this._idle = true;
      this.event('idle_start', { last_input_t: round3((this._lastInput - this.t0) / 1000), after_s: this.idleAfterS });
    }
  }

  _where(e) {
    const out = {};
    const eeg = this.eegAt ? this.eegAt(e.clientX, e.clientY) : null;
    if (eeg) Object.assign(out, eeg);
    return out;
  }

  _install() {
    if (this._installed || typeof document === 'undefined') return;
    this._installed = true;
    const opts = { capture: true, passive: true };
    document.addEventListener('pointerdown', (e) => {
      this._input();
      if (!this.enabled) return;
      const d = describeTarget(e.target);
      const where = this._where(e);
      this._press = { x: e.clientX, y: e.clientY, eeg: Boolean(where.area) };
      if (d.widget === 'button' || d.widget === 'a') this.noteInput(`button:${d.text || d.name || ''}`);
      else if (d.widget.endsWith(':menuitem')) this.noteInput(`menu:${d.text || ''}`);
      else if (d.widget === 'tr') this.noteInput(`list:${d.name || 'annotations'}`);
      this.event('mouse_press', {
        button: BUTTONS[e.button] || String(e.button), pointer: e.pointerType || 'mouse', modifiers: modifiers(e), ...d, top_window: this.topWindow,
        x: Math.round(e.clientX), y: Math.round(e.clientY), ...where,
      });
    }, opts);
    document.addEventListener('pointerup', (e) => {
      if (!this.enabled) return;
      const where = this._where(e);
      const extra = {};
      if (this._press && this._press.eeg) extra.drag_px = Math.round(Math.hypot(e.clientX - this._press.x, e.clientY - this._press.y));
      this._press = null;
      this.event('mouse_release', {
        button: BUTTONS[e.button] || String(e.button), pointer: e.pointerType || 'mouse', modifiers: modifiers(e), ...describeTarget(e.target),
        top_window: this.topWindow, x: Math.round(e.clientX), y: Math.round(e.clientY), ...where, ...extra,
      });
    }, opts);
    document.addEventListener('dblclick', (e) => {
      if (!this.enabled) return;
      this.event('double_click', {
        button: 'left', modifiers: modifiers(e), ...describeTarget(e.target), top_window: this.topWindow,
        x: Math.round(e.clientX), y: Math.round(e.clientY), ...this._where(e),
      });
    }, opts);
    document.addEventListener('wheel', (e) => {
      this._input();
      if (!this.enabled) return;
      // Trackpads send many small events: they are summed over a tenth of a second.
      const now = performance.now();
      if (this._wheel && now - this._wheel.at < 100) {
        this._wheel.dx += e.deltaX; this._wheel.dy += e.deltaY;
        return;
      }
      this._flushWheel();
      this._wheel = { at: now, dx: e.deltaX, dy: e.deltaY, where: this._where(e), mods: modifiers(e) };
      setTimeout(() => this._flushWheel(), 120);
    }, opts);
    document.addEventListener('pointermove', (e) => {
      this._input();
      if (!this.enabled || !this.eegAt) return;
      const where = this.eegAt(e.clientX, e.clientY);
      const now = performance.now();
      const p = this._pointer;
      if (!where) { this._pointer = null; return; }
      if (!p) { this._pointer = { at: now, x: e.clientX, y: e.clientY, dist: 0 }; return; }
      p.dist += Math.hypot(e.clientX - p.x, e.clientY - p.y);
      p.x = e.clientX; p.y = e.clientY;
      if (now - p.at >= 1000 / this.pointerHz) {
        this.event('pointer', { ...where, dist_px: Math.round(p.dist) });
        p.at = now; p.dist = 0;
      }
    }, opts);
    document.addEventListener('keydown', (e) => {
      this._input();
      if (!this.enabled || MODIFIER_KEYS.has(e.key) || isTyping(e.target)) return;
      const name = keyName(e);
      if (!this._lastVia || performance.now() - this._lastVia.at > 50) this.noteInput(`key:${name}`);
      this.event('key', { key: name, modifiers: modifiers(e), widget: describeTarget(e.target).widget, auto_repeat: e.repeat });
    }, { capture: true });
    document.addEventListener('change', (e) => {
      const el = e.target;
      if (!this.enabled || !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return;
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (type === 'password') return;
      const dialog = el.closest('[role="dialog"]');
      const fields = { widget: type, name: el.name || el.id || '', placeholder: el.getAttribute('placeholder') || '',
        title: dialog ? dialog.getAttribute('aria-label') || '' : this.topWindow };
      if (type === 'number' || type === 'checkbox' || type === 'radio' || type === 'select') {
        fields.value = type === 'checkbox' ? el.checked : el.value;
      }
      this.event('field_edited', fields);
    }, true);
    document.addEventListener('visibilitychange', () => {
      const hidden = document.visibilityState === 'hidden';
      this.event('app_state', { state: hidden ? 'hidden' : 'active' });
      if (hidden) this.flush({ final: true });
    });
    window.addEventListener('focus', () => this.event('window_activated', { top_window: this.topWindow, title: document.title }));
    window.addEventListener('blur', () => this.event('window_deactivated', { top_window: this.topWindow, title: document.title }));
    window.addEventListener('pagehide', () => {
      if (!this.visitId) return;
      this.event('log_closed', { reason: 'page_closed' });
      this.flush({ final: true });
      try { this.backend.closeVisit(this.visitId, 'page_closed', { keepalive: true }); } catch { /* best effort */ }
    });
  }

  _flushWheel() {
    const w = this._wheel;
    if (!w) return;
    this._wheel = null;
    this.event('wheel', { dx: Math.round(w.dx), dy: Math.round(w.dy), modifiers: w.mods, ...w.where });
  }
}

export const logger = new InteractionLogger();
