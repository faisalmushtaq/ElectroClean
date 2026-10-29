// The EEG viewer: traces drawn on canvas with min/max decimation per pixel column, channel names,
// a time axis, scale bars, the original events, gaps and filter edge zones (hatched), the
// annotations with their tags above the traces, and the overview strip of the whole recording.
//
// Three stacked canvases: the background (grid, zones, annotation fills), the traces, and the
// foreground (tags, outlines, marks, scale bars). Each is redrawn only when what it shows changes.
// Pointer input on the EEG (mouse, finger or pencil) is passed, with the time, channel and annotation
// under the pointer, to `onPointer`; navigation (wheel, overview, two-finger moves and pinches, and
// the row of buttons shown on touch screens) is handled here. On a touch screen a long press is
// passed as 'longpress' and a double tap as 'dblclick'; a second finger cancels what the first began
// ('cancel'). The overview also shows which parts of the recording have not been on screen yet
// (setCoverage), and the annotator's display comfort (setComfort) sets the thickness of the traces
// and the size of the channel names.

import { h } from '../ui/dom.js';
import { clamp, hexToRgb, legibleOnWhite, rgba } from '../util.js';
import { COLOURS, FONT } from '../ui/theme.js';
import { CHANNEL_COUNTS, DURATIONS, decimateColumns, layoutTags, meanOf, niceStep, stepOption, tickLabel, voltsText } from './geometry.js';
import { LONG_PRESS_MS, TAP_SLOP_PX, edgePx, isDoubleTap, pinchView, twoFingers } from './touch.js';
import { complement, mergeIntervals } from './coverage.js';
import { namePx, traceWidths } from '../ui/comfort.js';
import { icon } from '../views/common.js';

const GUTTER = 92;
const TAG_ROW_H = 20;
const TAG_ROWS = 2;
const TAG_BAND = TAG_ROWS * TAG_ROW_H + 6;
const AXIS_H = 24;
const RIGHT = 10;
const OVERVIEW_H = 34;
const EDGE_PX = 6;
const CLIP = 0.75; // traces are clipped at 1.5 half-rows (MNE's clipping=1.5)

const end = (a) => a.onset_sample + a.duration_samples;

function hatch(ctx, x0, y0, w, hgt, colour, spacing = 8) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, hgt);
  ctx.clip();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = x0 - hgt; x < x0 + w + hgt; x += spacing) {
    ctx.moveTo(x, y0 + hgt);
    ctx.lineTo(x + hgt, y0);
  }
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx, x, y, w, hgt, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hgt, r);
  ctx.arcTo(x + w, y + hgt, x, y + hgt, r);
  ctx.arcTo(x, y + hgt, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class EegViewer {
  /**
   * @param {HTMLElement} host
   * @param {object} o recording, channels [{name, index, type, bad}], scalings, events, gaps, catalogue, filters, view
   */
  constructor(host, o) {
    this.recording = o.recording;
    this.sfreq = o.recording.sfreq;
    this.nSamples = o.recording.nSamples;
    this.durationTotal = this.nSamples / this.sfreq;
    this.channels = o.channels;
    this.scalings = o.scalings || {};
    this.events = o.events || [];
    this.gaps = o.gaps || [];
    this.catalogue = o.catalogue;
    this.filters = o.filters || { highpassHz: null, notchHz: null, notchHarmonics: false };
    this.showEdgeZones = true;
    const v = o.view || {};
    this.view = {
      startS: 0, durationS: Math.min(v.duration_s || 10, this.durationTotal),
      firstChannel: 0, nChannels: Math.min(v.n_channels || 32, this.channels.length), scaleFactor: 1,
    };
    this.annotations = [];
    this.selected = new Set();
    this.ghost = null;
    this.flash = null;
    this.markStart = null;
    this.dragPreview = null;
    this.selectedChannels = new Set();
    this.channelsActive = false;
    this.prefix = {};
    this.labelColours = {};
    this.cursorT = null;
    this.hover = null;
    this.edgeZones = [];
    this.onPointer = null;
    this.onView = null;
    this.onWheelNav = null;
    this.onNextUnviewed = null;
    this.coverage = null; // merged [start_s, end_s] on screen so far, or null when not shown
    this.comfort = { trace: 'normal', names: 'normal' };
    this.stats = { traceMs: 0, readMs: 0, renders: 0 };
    this._cache = null;
    this._token = 0;
    this._loading = false;
    this._dirty = { under: true, traces: true, over: true, overview: true };
    this._raf = 0;
    this._tags = [];
    this._cols = new Map();
    this._build(host);
  }

  // -------------------------------------------------------------- building
  _build(host) {
    this.under = h('canvas.layer');
    this.traces = h('canvas.layer');
    this.over = h('canvas.layer.top', { tabindex: '-1', 'aria-label': 'EEG', 'data-log': 'eeg' });
    this.plot = h('div.viewer-plot', {}, this.under, this.traces, this.over);
    this.overviewCanvas = h('canvas.viewer-overview', { 'data-log': 'overview', 'aria-label': 'Overview of the whole recording' });
    this.touchbar = this._touchbar();
    this.el = h('div.viewer', {}, this.plot, this.touchbar, this.overviewCanvas);
    host.appendChild(this.el);
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.plot);
    this._ro.observe(this.overviewCanvas);
    const pass = (type) => (e) => this._pointer(type, e);
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave', 'dblclick', 'contextmenu']) {
      this.over.addEventListener(t, pass(t));
    }
    this._touches = new Map(); // fingers on the EEG: pointerId -> { x, y } (client coordinates)
    this._pinch = null;
    this._afterPinch = false; // a finger left over from two: ignored until it lifts
    this._press = null; // a press that may become a long press or a tap
    this._lastTap = null;
    this._pointerType = 'mouse';
    // After a double tap or a long press, the browser's click for the lifted finger would land on the
    // list or menu that just opened under it; the touch's end is cancelled so that no click follows.
    this._swallowTouchEnd = false;
    this.over.addEventListener('touchend', (e) => {
      if (this._swallowTouchEnd && e.cancelable) e.preventDefault();
      if (!e.touches.length) this._swallowTouchEnd = false;
    }, { passive: false });
    this.over.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    let dragging = false;
    const ov = (e) => {
      const r = this.overviewCanvas.getBoundingClientRect();
      const t = ((e.clientX - r.left) / Math.max(1, r.width)) * this.durationTotal;
      this.setView({ startS: t - this.view.durationS / 2 }, 'overview');
    };
    this.overviewCanvas.addEventListener('pointerdown', (e) => { dragging = true; this.overviewCanvas.setPointerCapture(e.pointerId); ov(e); });
    this.overviewCanvas.addEventListener('pointermove', (e) => { if (dragging) ov(e); });
    this.overviewCanvas.addEventListener('pointerup', () => { dragging = false; });
    this.overviewCanvas.addEventListener('pointercancel', () => { dragging = false; });
    this._resize();
  }

  /** The buttons shown under the EEG on a touch screen, for what the keyboard does elsewhere. */
  _touchbar() {
    const btn = (name, label, log, fn) => h('button.btn.icon.small', { type: 'button', 'aria-label': label, title: label,
      'data-log': `touch-${log}`, 'data-log-text': label, onclick: fn }, icon(name));
    const group = (caption, ...buttons) => h('div.touch-group', { role: 'group', 'aria-label': caption }, h('span.touch-caption', {}, caption), ...buttons);
    const v = () => this.view;
    return h('div.viewer-touchbar', { role: 'toolbar', 'aria-label': 'Move through the EEG' },
      group('Time',
        btn('arrow-left', 'Back a screen', 'page-back', () => this.scrollPages(-1, 'button')),
        btn('chevron-left', 'Back a little', 'back', () => this.scrollBy(-0.25 * v().durationS, 'button')),
        btn('chevron-right', 'Forward a little', 'forward', () => this.scrollBy(0.25 * v().durationS, 'button')),
        btn('arrow-right', 'Forward a screen', 'page-forward', () => this.scrollPages(1, 'button'))),
      group('Time shown',
        btn('minus', 'Show less time', 'less-time', () => this.stepDuration(-1, 'button')),
        btn('plus', 'Show more time', 'more-time', () => this.stepDuration(1, 'button'))),
      group('Channels',
        btn('chevron-up', 'Earlier channels', 'channels-up', () => this.scrollChannels(-v().nChannels, 'button')),
        btn('chevron-down', 'Later channels', 'channels-down', () => this.scrollChannels(v().nChannels, 'button')),
        btn('minus', 'Show fewer channels', 'fewer-channels', () => this.stepChannels(-1, 'button')),
        btn('plus', 'Show more channels', 'more-channels', () => this.stepChannels(1, 'button'))),
      group('Size',
        btn('minus', 'Smaller traces', 'smaller', () => this.scaleBy(1 / 1.25, 'button')),
        btn('plus', 'Larger traces', 'larger', () => this.scaleBy(1.25, 'button'))),
      this.nextUnviewedGroup = group('Not yet viewed',
        btn('skip-forward', 'Next part not yet viewed', 'next-unviewed', () => this.onNextUnviewed && this.onNextUnviewed('button'))));
  }

  destroy() {
    this._ro.disconnect();
    cancelAnimationFrame(this._raf);
    this._token += 1;
    this.el.remove();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    const r = this.plot.getBoundingClientRect();
    this.W = Math.max(200, Math.floor(r.width));
    this.H = Math.max(160, Math.floor(r.height));
    for (const c of [this.under, this.traces, this.over]) {
      c.width = Math.round(this.W * dpr);
      c.height = Math.round(this.H * dpr);
      c.style.width = `${this.W}px`;
      c.style.height = `${this.H}px`;
    }
    const ro = this.overviewCanvas.getBoundingClientRect();
    this.OW = Math.max(100, Math.floor(ro.width));
    this.overviewCanvas.width = Math.round(this.OW * dpr);
    this.overviewCanvas.height = Math.round(OVERVIEW_H * dpr);
    this.invalidate();
  }

  // -------------------------------------------------------------- geometry
  get x0() { return GUTTER; }
  get x1() { return this.W - RIGHT; }
  get y0() { return TAG_BAND; }
  get y1() { return this.H - AXIS_H; }
  get plotW() { return this.x1 - this.x0; }
  get plotH() { return this.y1 - this.y0; }
  get rowH() { return this.plotH / Math.max(1, this.view.nChannels); }

  tToX(t) { return this.x0 + ((t - this.view.startS) / this.view.durationS) * this.plotW; }
  xToT(x) { return this.view.startS + ((x - this.x0) / this.plotW) * this.view.durationS; }
  sampleToX(s) { return this.tToX(s / this.sfreq); }
  rowCentre(i) { return this.y0 + (i - this.view.firstChannel + 0.5) * this.rowH; }

  /** Channels on screen: [{row, ch}] */
  visibleRows() {
    const out = [];
    const last = Math.min(this.channels.length, this.view.firstChannel + this.view.nChannels);
    for (let i = this.view.firstChannel; i < last; i++) out.push({ row: i, ch: this.channels[i] });
    return out;
  }

  // ------------------------------------------------------------------ state
  setView(changes, cause = 'code') {
    const v = { ...this.view, ...changes };
    v.durationS = clamp(v.durationS, Math.min(0.5, this.durationTotal), this.durationTotal);
    v.startS = clamp(v.startS, 0, Math.max(0, this.durationTotal - v.durationS));
    v.nChannels = clamp(Math.round(v.nChannels), 1, this.channels.length);
    v.firstChannel = clamp(Math.round(v.firstChannel), 0, Math.max(0, this.channels.length - v.nChannels));
    v.scaleFactor = clamp(v.scaleFactor, 1 / 64, 64);
    const same = Object.keys(v).every((k) => v[k] === this.view[k]);
    if (same) return false;
    this.view = v;
    this.invalidate();
    if (this.onView) this.onView({ ...v }, cause);
    return true;
  }

  scrollBy(seconds, cause) { return this.setView({ startS: this.view.startS + seconds }, cause); }
  scrollPages(n, cause) { return this.scrollBy(n * this.view.durationS, cause); }
  scrollChannels(n, cause) { return this.setView({ firstChannel: this.view.firstChannel + n }, cause); }
  stepDuration(dir, cause) { return this.setView({ durationS: stepOption(DURATIONS, this.view.durationS, dir, Math.max(this.durationTotal, 1)) }, cause); }
  stepChannels(dir, cause) { return this.setView({ nChannels: stepOption(CHANNEL_COUNTS, this.view.nChannels, dir, this.channels.length) }, cause); }
  scaleBy(f, cause) { return this.setView({ scaleFactor: this.view.scaleFactor * f }, cause); }

  /** Bring an interval (and its channels) into view, centred when it fits. */
  showInterval(onsetSample, durationSamples, channels = []) {
    const t0 = onsetSample / this.sfreq;
    const t1 = (onsetSample + durationSamples) / this.sfreq;
    const w = this.view.durationS;
    const visible = t0 >= this.view.startS && t1 <= this.view.startS + w;
    const changes = {};
    if (!visible) changes.startS = (t1 - t0) > w ? t0 - 0.05 * w : t0 - (w - (t1 - t0)) / 2;
    if (channels && channels.length) {
      const idx = channels.map((c) => this.channels.findIndex((x) => x.name === c)).filter((i) => i >= 0);
      const first = this.view.firstChannel;
      const last = first + this.view.nChannels;
      if (idx.length && !idx.every((i) => i >= first && i < last)) changes.firstChannel = Math.min(...idx) - 1;
    }
    return this.setView(changes, 'jump');
  }

  setAnnotations(list) { this.annotations = list; this.invalidate(['under', 'over', 'overview']); }
  setSelection(ids) { this.selected = new Set(ids || []); this.invalidate(['under', 'over']); }
  setGhost(g) { this.ghost = g; this.invalidate(['under', 'over']); }
  setMarkStart(t, colour) { this.markStart = t === null ? null : { t, colour }; this.invalidate(['over']); }
  setDragPreview(p) { this.dragPreview = p; this.invalidate(['over']); }
  setCursor(t) { this.cursorT = t; this.invalidate(['over']); }
  setPrefix(map) { this.prefix = map || {}; this.invalidate(['over']); }
  setLabelColours(map) { this.labelColours = map || {}; this.invalidate(['over']); }
  setEdgeZonesVisible(on) { this.showEdgeZones = Boolean(on); this.invalidate(['under']); }
  /** The parts on screen so far (merged [start_s, end_s]); null hides the coverage. Only the overview changes. */
  setCoverage(list) { this.coverage = list ? list.map((p) => [...p]) : null; this.invalidate(['overview']); }
  /** Display comfort: { trace: 'thin'|'normal'|'thick', names: 'normal'|'large' }. */
  setComfort(c) {
    const next = { trace: c.trace || 'normal', names: c.names || 'normal' };
    const layers = [];
    if (next.trace !== this.comfort.trace) layers.push('traces');
    if (next.names !== this.comfort.names) layers.push('under');
    this.comfort = next;
    if (layers.length) this.invalidate(layers);
  }

  setSelectedChannels(names, active) {
    this.selectedChannels = new Set(names || []);
    this.channelsActive = Boolean(active);
    this.invalidate(['under', 'traces']);
  }

  setFilters(f) {
    this.filters = { ...f };
    this._cache = null;
    this._pendingRead = null;
    this.invalidate();
  }

  flashInterval(onsetSample, durationSamples) {
    this.flash = { onsetSample, durationSamples, until: performance.now() + 900 };
    this.invalidate(['under']);
    setTimeout(() => { this.flash = null; this.invalidate(['under']); }, 950);
  }

  invalidate(layers = ['under', 'traces', 'over', 'overview']) {
    for (const l of layers) this._dirty[l] = true;
    if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  // ------------------------------------------------------------------- data
  _neededRange() {
    const sf = this.sfreq;
    const s0 = Math.max(0, Math.floor(this.view.startS * sf) - 1);
    const s1 = Math.min(this.nSamples, Math.ceil((this.view.startS + this.view.durationS) * sf) + 2);
    return [s0, s1];
  }

  _filtersKey() {
    const f = this.filters;
    return `${f.highpassHz || 0}|${f.notchHz || 0}|${f.notchHarmonics ? 1 : 0}`;
  }

  _covers() {
    const c = this._cache;
    if (!c || c.filtersKey !== this._filtersKey()) return false;
    const [s0, s1] = this._neededRange();
    if (s0 < c.startSample || s1 > c.startSample + c.nSamples) return false;
    return this.visibleRows().every(({ ch }) => c.rows.has(ch.index));
  }

  async _load() {
    if (this._covers()) return;
    // A read already on its way that will cover the view: wait for it rather than start another
    // (scrolling steadily would otherwise keep cancelling the reads of a slow file).
    const p = this._pendingRead;
    if (p && p.filtersKey === this._filtersKey()) {
      const [n0, n1] = this._neededRange();
      if (n0 >= p.s0 && n1 <= p.s1 && this.visibleRows().every(({ ch }) => p.channels.has(ch.index))) return;
    }
    const token = ++this._token;
    const sf = this.sfreq;
    const margin = Math.max(this.view.durationS * 0.5, 2);
    const s0 = Math.max(0, Math.floor((this.view.startS - margin) * sf));
    const s1 = Math.min(this.nSamples, Math.ceil((this.view.startS + this.view.durationS + margin) * sf));
    const extra = Math.ceil(this.view.nChannels / 2);
    const first = Math.max(0, this.view.firstChannel - extra);
    const last = Math.min(this.channels.length, this.view.firstChannel + this.view.nChannels + extra);
    const want = this.channels.slice(first, last).map((c) => c.index);
    const t = performance.now();
    this._pendingRead = { s0, s1, channels: new Set(want), filtersKey: this._filtersKey() };
    this._loading = true;
    try {
      const res = await this.recording.readWindow({ startSample: s0, nSamples: s1 - s0, channels: want, filters: { ...this.filters } });
      if (token !== this._token) return;
      this._pendingRead = null;
      this.loadError = null;
      this.stats.readMs = performance.now() - t;
      const rows = new Map(want.map((ci, k) => [ci, res.data[k]]));
      this._cache = { id: (this._cacheId = (this._cacheId || 0) + 1), startSample: res.startSample, nSamples: res.nSamples, rows, filtersKey: this._filtersKey() };
      this.edgeZones = res.edgeZones || [];
      this._loading = false;
      this.invalidate(['under', 'traces']);
    } catch (exc) {
      if (token === this._token) {
        this._pendingRead = null;
        this._loading = false;
        this.loadError = exc;
        this.invalidate(['traces']);
      }
    }
  }

  // -------------------------------------------------------------- rendering
  _render() {
    const d = this._dirty;
    this._dirty = { under: false, traces: false, over: false, overview: false };
    if (d.traces && !this._covers()) this._load();
    const ms = {};
    const timed = (name, fn) => { const t0 = performance.now(); fn(); ms[name] = Math.round((performance.now() - t0) * 10) / 10; };
    if (d.under) timed('under', () => this._renderUnder());
    if (d.traces) timed('traces', () => this._renderTraces());
    if (d.over) timed('over', () => this._renderOver());
    if (d.overview) timed('overview', () => this._renderOverview());
    this.stats.layers = ms;
    this.stats.renders += 1;
  }

  _ctx(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    return ctx;
  }

  _visibleAnnotations() {
    const s0 = this.view.startS * this.sfreq;
    const s1 = (this.view.startS + this.view.durationS) * this.sfreq;
    return this.annotations.filter((a) => a.onset_sample < s1 && end(a) > s0);
  }

  /** Vertical extent (y0, y1) of the rows of `channels` on screen; [] means the whole plot. */
  _rowSpans(channels) {
    if (!channels || !channels.length) return [[this.y0, this.y1]];
    const spans = [];
    const set = new Set(channels);
    for (const { row, ch } of this.visibleRows()) {
      if (!set.has(ch.name)) continue;
      const yc = this.rowCentre(row);
      const top = yc - this.rowH / 2;
      const last = spans[spans.length - 1];
      if (last && Math.abs(last[1] - top) < 0.5) last[1] = top + this.rowH;
      else spans.push([top, top + this.rowH]);
    }
    return spans;
  }

  _renderUnder() {
    const ctx = this._ctx(this.under);
    const { x0, x1, y0, y1 } = this;
    ctx.fillStyle = COLOURS.surface;
    ctx.fillRect(0, 0, this.W, this.H);
    // the selected channels' rows (Selected channels scope)
    if (this.channelsActive && this.selectedChannels.size) {
      ctx.fillStyle = rgba(COLOURS.selection_channel, 0.06);
      for (const { row, ch } of this.visibleRows()) {
        if (this.selectedChannels.has(ch.name)) ctx.fillRect(x0, this.rowCentre(row) - this.rowH / 2, x1 - x0, this.rowH);
      }
    }
    // grid
    const step = niceStep(this.view.durationS, this.plotW);
    ctx.strokeStyle = COLOURS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = Math.ceil(this.view.startS / step) * step; t <= this.view.startS + this.view.durationS + 1e-9; t += step) {
      const x = Math.round(this.tToX(t)) + 0.5;
      ctx.moveTo(x, y0); ctx.lineTo(x, y1);
    }
    ctx.stroke();
    // gaps (no recorded data) and filter edge zones
    const zone = (a, b, colour, label, strength) => {
      const xa = clamp(this.sampleToX(a), x0, x1);
      const xb = clamp(this.sampleToX(b), x0, x1);
      if (xb - xa < 0.5) return;
      ctx.fillStyle = rgba(colour, 0.08 * strength);
      ctx.fillRect(xa, y0, xb - xa, y1 - y0);
      hatch(ctx, xa, y0, xb - xa, y1 - y0, rgba(colour, 0.5 * strength), strength < 1 ? 10 : 8);
      if (label && xb - xa > 60) {
        ctx.font = `600 12px ${FONT}`;
        ctx.fillStyle = COLOURS.text_secondary;
        ctx.textAlign = 'center';
        ctx.fillText(label, (xa + xb) / 2, y0 + 16);
      }
    };
    for (const [a, b] of this.gaps) zone(a, b, '#6E6E73', 'No recorded data', 1);
    if (this.showEdgeZones) for (const [a, b] of this.edgeZones) zone(a, b, COLOURS.hatch, '', 0.55);
    // annotations
    for (const a of this._visibleAnnotations()) {
      const colour = this.catalogue.colourFor(a.label);
      const sel = this.selected.has(a.annotation_id);
      const xa = clamp(this.sampleToX(a.onset_sample), x0, x1);
      const xb = clamp(this.sampleToX(end(a)), x0, x1);
      ctx.fillStyle = rgba(colour, sel ? 0.30 : a.channels.length ? 0.24 : 0.16);
      for (const [ya, yb] of this._rowSpans(a.channels)) ctx.fillRect(xa, ya, Math.max(1, xb - xa), yb - ya);
    }
    // the experts' annotation (guided training) and the flash of a match
    if (this.ghost) {
      const g = this.ghost;
      const colour = this.catalogue.colourFor(g.label);
      const xa = clamp(this.sampleToX(g.onset_sample), x0, x1);
      const xb = clamp(this.sampleToX(end(g)), x0, x1);
      ctx.fillStyle = rgba(colour, 0.11);
      ctx.fillRect(xa, y0, xb - xa, y1 - y0);
      if (g.channels.length) {
        ctx.fillStyle = rgba(colour, 0.18);
        for (const [ya, yb] of this._rowSpans(g.channels)) ctx.fillRect(xa, ya, xb - xa, yb - ya);
      }
    }
    if (this.flash) {
      const f = this.flash;
      const xa = clamp(this.sampleToX(f.onsetSample), x0, x1);
      const xb = clamp(this.sampleToX(f.onsetSample + f.durationSamples), x0, x1);
      ctx.fillStyle = rgba(COLOURS.success, 0.27);
      ctx.fillRect(xa, y0, xb - xa, y1 - y0);
    }
    // original events
    ctx.strokeStyle = rgba(COLOURS.event, 0.75);
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (const e of this.events) {
      const x = this.sampleToX(e.onset_sample);
      if (x < x0 || x > x1) continue;
      ctx.moveTo(Math.round(x) + 0.5, y0); ctx.lineTo(Math.round(x) + 0.5, y1);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // channel names
    ctx.font = `12px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const fontPx = namePx(this.comfort.names, this.rowH);
    const everyNth = this.rowH < fontPx - 1 ? Math.ceil((fontPx - 1) / this.rowH) : 1;
    for (const { row, ch } of this.visibleRows()) {
      if ((row - this.view.firstChannel) % everyNth) continue;
      const selected = this.channelsActive && this.selectedChannels.has(ch.name);
      const hover = this.hover && this.hover.area === 'channel_names' && this.hover.row === row;
      ctx.font = `${selected ? '600 ' : ''}${fontPx}px ${FONT}`;
      ctx.fillStyle = selected ? COLOURS.selection_channel : ch.bad ? COLOURS.text_disabled : hover ? COLOURS.accent : COLOURS.text;
      ctx.fillText(ch.bad ? `${ch.name} (bad)` : ch.name, x0 - 8, this.rowCentre(row));
    }
    ctx.textBaseline = 'alphabetic';
    // the time axis
    ctx.fillStyle = COLOURS.surface;
    ctx.fillRect(0, y1, this.W, AXIS_H);
    ctx.strokeStyle = COLOURS.separator;
    ctx.beginPath(); ctx.moveTo(x0, y1 + 0.5); ctx.lineTo(x1, y1 + 0.5); ctx.stroke();
    ctx.fillStyle = COLOURS.text_secondary;
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = 'center';
    for (let t = Math.ceil(this.view.startS / step) * step; t <= this.view.startS + this.view.durationS + 1e-9; t += step) {
      const x = this.tToX(t);
      ctx.fillRect(Math.round(x), y1, 1, 4);
      ctx.fillText(tickLabel(t, step), x, y1 + 16);
    }
    ctx.textAlign = 'left';
    ctx.fillText('time (s)', 8, y1 + 16);
    // event labels, at the bottom of the plot
    ctx.font = `10px ${FONT}`;
    ctx.fillStyle = COLOURS.event;
    let lastRight = -Infinity;
    for (const e of this.events) {
      const x = this.sampleToX(e.onset_sample);
      if (x < x0 || x > x1) continue;
      const w = ctx.measureText(e.label).width;
      if (x + 3 < lastRight + 4) continue;
      ctx.fillStyle = rgba(COLOURS.surface, 0.85);
      ctx.fillRect(x + 2, y1 - 14, w + 4, 12);
      ctx.fillStyle = COLOURS.event;
      ctx.fillText(e.label, x + 4, y1 - 4);
      lastRight = x + 6 + w;
    }
  }

  _renderTraces() {
    const t = performance.now();
    const ctx = this._ctx(this.traces);
    const c = this._cache;
    const { x0, x1, y0, y1 } = this;
    this._cols = new Map();
    if (!c || c.filtersKey !== this._filtersKey()) {
      ctx.fillStyle = COLOURS.text_secondary;
      ctx.font = `13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(this.loadError ? `The EEG could not be read: ${this.loadError.message}` : 'Reading the EEG…', (x0 + x1) / 2, (y0 + y1) / 2);
      return;
    }
    const sf = this.sfreq;
    const dpr = this.dpr;
    const cols = Math.max(1, Math.round(this.plotW)); // one column per CSS pixel
    const sStart = this.view.startS * sf;
    const span = this.view.durationS * sf;
    const dense = span / cols > 1.5;
    const rowH = this.rowH;
    const half = rowH / 2;
    const lim = rowH * CLIP;
    // Dense views (several samples per pixel column) are drawn straight into the pixels: for each
    // column a vertical stroke from the minimum to the maximum, joined to the previous column.
    // Sparse views are drawn as lines through every sample.
    let buf = null;
    let W = 0;
    if (dense) {
      W = this.traces.width;
      const H = this.traces.height;
      if (!this._img || this._img.width !== W || this._img.height !== H) this._img = new ImageData(W, H);
      buf = new Uint32Array(this._img.data.buffer);
      buf.fill(0);
    }
    const top = Math.ceil(y0 * dpr);
    const bottom = Math.floor(y1 * dpr) - 1;
    const widths = traceWidths(this.comfort.trace, dpr, rowH < 6);
    const thick = widths.device;
    const wide = Math.max(1, thick - Math.max(1, Math.round(dpr)) + 1); // device pixels a column spans at least
    const colX = new Int32Array(cols + 1);
    for (let col = 0; col <= cols; col++) colX[col] = Math.round((x0 + col) * dpr);
    const groups = new Map();
    let decimate = 0;
    const grid = span / cols; // samples per column
    const g0 = Math.round(sStart / grid);
    const decimated = new Map();
    for (const { row, ch } of this.visibleRows()) {
      const data = c.rows.get(ch.index);
      if (!data) continue;
      const scaling = this.scalings[ch.type] || this.scalings.misc || 1e-3;
      const k = (half / scaling) * this.view.scaleFactor;
      const yc = this.rowCentre(row);
      const colour = this.channelsActive && this.selectedChannels.has(ch.name) ? COLOURS.selection_channel
        : ch.bad ? COLOURS.trace_bad : ch.type === 'ecg' ? COLOURS.trace_ecg : COLOURS.trace;
      if (!dense) {
        const a = Math.floor(sStart) - c.startSample;
        const offset = meanOf(data, a, a + Math.ceil(span));
        const yOf = (v) => { const y = (v - offset) * k; return yc - (y > lim ? lim : y < -lim ? -lim : y); };
        let path = groups.get(colour);
        if (!path) { path = new Path2D(); groups.set(colour, path); }
        const sA = Math.max(c.startSample, Math.floor(sStart) - 1);
        const sB = Math.min(c.startSample + c.nSamples, Math.ceil(sStart + span) + 2);
        let first = true;
        for (let s = sA; s < sB; s++) {
          const x = x0 + ((s - sStart) / span) * this.plotW;
          const y = yOf(data[s - c.startSample]);
          if (first) { path.moveTo(x, y); first = false; } else path.lineTo(x, y);
        }
        this._cols.set(row, null);
        continue;
      }
      const td = performance.now();
      const prev = this._decimated && this._decimated.dataId === c.id ? this._decimated.rows.get(ch.index) : null;
      const d = decimateColumns(data, c.startSample, grid, g0, cols, prev);
      decimated.set(ch.index, d);
      let total = 0;
      let count = 0;
      for (let col = 0; col < cols; col++) { total += d.sum[col]; count += d.cnt[col]; }
      const offset = count ? total / count : 0;
      decimate += performance.now() - td;
      const { min, max } = d;
      const yOf = (v) => { const y = (v - offset) * k; return yc - (y > lim ? lim : y < -lim ? -lim : y); };
      this._cols.set(row, { min, max, offset, k, yc, lim });
      const [r, g, b] = hexToRgb(colour);
      const px = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
      let prevLo = -1;
      let prevHi = -1;
      for (let col = 0; col < cols; col++) {
        const lo0 = min[col];
        if (lo0 !== lo0) { prevLo = -1; continue; } // NaN: no data
        let lo = Math.round(yOf(max[col]) * dpr);
        let hi = Math.round(yOf(lo0) * dpr) + thick - 1;
        const ownLo = lo;
        const ownHi = hi;
        if (prevLo >= 0) {
          if (lo > prevHi) lo = prevHi;
          if (hi < prevLo) hi = prevLo;
        }
        prevLo = ownLo;
        prevHi = ownHi;
        if (lo < top) lo = top;
        if (hi > bottom) hi = bottom;
        const xa = colX[col];
        const xb = Math.max(colX[col + 1], xa + wide);
        for (let y = lo; y <= hi; y++) {
          const base = y * W;
          for (let x = xa; x < xb; x++) buf[base + x] = px;
        }
      }
    }
    if (dense) this._decimated = { dataId: c.id, rows: decimated };
    this.stats.decimateMs = decimate;
    if (dense) {
      const tp = performance.now();
      ctx.putImageData(this._img, 0, 0);
      this.stats.putMs = performance.now() - tp;
    } else {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0 - 1, x1 - x0, y1 - y0 + 2);
      ctx.clip();
      ctx.lineWidth = widths.css;
      ctx.lineJoin = 'round';
      for (const [colour, path] of groups) {
        ctx.strokeStyle = colour;
        ctx.stroke(path);
      }
      ctx.restore();
    }
    this.stats.traceMs = performance.now() - t;
  }

  _renderOver() {
    const ctx = this._ctx(this.over);
    const { x0, x1, y0, y1 } = this;
    // annotation edges and outlines
    const anns = this._visibleAnnotations();
    for (const a of anns) {
      const colour = this.catalogue.colourFor(a.label);
      const sel = this.selected.has(a.annotation_id);
      const xa = this.sampleToX(a.onset_sample);
      const xb = this.sampleToX(end(a));
      ctx.strokeStyle = colour;
      ctx.lineWidth = sel ? 2.5 : 1.25;
      ctx.beginPath();
      for (const [ya, yb] of this._rowSpans(a.channels)) {
        if (xa >= x0 && xa <= x1) { ctx.moveTo(xa, ya); ctx.lineTo(xa, yb); }
        if (xb >= x0 && xb <= x1) { ctx.moveTo(xb, ya); ctx.lineTo(xb, yb); }
        if (sel) {
          const ca = clamp(xa, x0, x1); const cb = clamp(xb, x0, x1);
          ctx.moveTo(ca, ya + 1); ctx.lineTo(cb, ya + 1);
          ctx.moveTo(ca, yb - 1); ctx.lineTo(cb, yb - 1);
        }
      }
      ctx.stroke();
      if (sel) {
        ctx.fillStyle = colour;
        const ym = (y0 + y1) / 2;
        for (const x of [xa, xb]) if (x >= x0 && x <= x1) { roundRect(ctx, x - 3, ym - 12, 6, 24, 3); ctx.fill(); }
      }
    }
    // ghost outline
    if (this.ghost) {
      const g = this.ghost;
      const colour = this.catalogue.colourFor(g.label);
      const xa = this.sampleToX(g.onset_sample);
      const xb = this.sampleToX(end(g));
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(xa, y0 + 1, xb - xa, y1 - y0 - 2);
      if (g.channels.length) for (const [ya, yb] of this._rowSpans(g.channels)) ctx.strokeRect(xa, ya, xb - xa, yb - ya);
      ctx.setLineDash([]);
    }
    // tags above the traces
    ctx.font = `12px ${FONT}`;
    const tags = anns.map((a) => {
      const text = `${this.prefix[a.annotation_id] || ''}${a.label}${a.channels.length ? ' [ch]' : ''}`;
      const w = ctx.measureText(text).width + 12;
      const xa = clamp(this.sampleToX(a.onset_sample), x0, x1);
      const xb = clamp(this.sampleToX(end(a)), x0, x1);
      let x = (xa + xb) / 2;
      if (x1 - x0 > w) x = clamp(x, x0 + w / 2, x1 - w / 2);
      return { a, text, w, x };
    });
    const rows = layoutTags(tags, TAG_ROWS);
    this._tags = [];
    tags.forEach((tg, i) => {
      const y = 3 + rows[i] * TAG_ROW_H;
      const colour = this.labelColours[tg.a.annotation_id] || this.catalogue.colourFor(tg.a.label);
      const sel = this.selected.has(tg.a.annotation_id);
      roundRect(ctx, tg.x - tg.w / 2, y, tg.w, TAG_ROW_H - 3, 4);
      ctx.fillStyle = sel ? rgba(colour, 0.14) : 'rgba(255, 255, 255, 0.9)';
      ctx.fill();
      ctx.strokeStyle = sel ? colour : rgba(colour, 0.65);
      ctx.lineWidth = sel ? 2 : 1;
      ctx.stroke();
      ctx.fillStyle = legibleOnWhite(colour);
      ctx.textAlign = 'center';
      ctx.fillText(tg.text, tg.x, y + 13);
      this._tags.push({ id: tg.a.annotation_id, x: tg.x - tg.w / 2, y, w: tg.w, h: TAG_ROW_H - 3 });
    });
    // the drag in progress
    if (this.dragPreview) {
      const p = this.dragPreview;
      const xa = clamp(this.tToX(Math.min(p.t0, p.t1)), x0, x1);
      const xb = clamp(this.tToX(Math.max(p.t0, p.t1)), x0, x1);
      ctx.fillStyle = rgba(p.colour, 0.24);
      for (const [ya, yb] of this._rowSpans(p.channels)) ctx.fillRect(xa, ya, xb - xa, yb - ya);
      ctx.strokeStyle = p.colour;
      ctx.lineWidth = 1;
      ctx.strokeRect(xa + 0.5, y0 + 0.5, xb - xa, y1 - y0 - 1);
    }
    // a started keyboard mark
    if (this.markStart) {
      const x = this.tToX(this.markStart.t);
      if (x >= x0 && x <= x1) {
        ctx.strokeStyle = this.markStart.colour;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = `600 11px ${FONT}`;
        ctx.fillStyle = legibleOnWhite(this.markStart.colour);
        ctx.textAlign = 'left';
        ctx.fillText('start', x + 4, y0 + 12);
      }
    }
    // the time cursor
    if (this.cursorT !== null) {
      const x = this.tToX(this.cursorT);
      if (x >= x0 && x <= x1) {
        ctx.strokeStyle = COLOURS.text_secondary;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y0); ctx.lineTo(Math.round(x) + 0.5, y1); ctx.stroke();
        const label = `${this.cursorT.toFixed(3)} s`;
        ctx.font = `11px ${FONT}`;
        const w = ctx.measureText(label).width + 8;
        ctx.fillStyle = COLOURS.text;
        roundRect(ctx, clamp(x - w / 2, x0, x1 - w), y1 + 4, w, 16, 3);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.fillText(label, clamp(x, x0 + w / 2, x1 - w / 2), y1 + 16);
      }
    }
    // scale bars, one per channel type on screen
    const seen = new Set();
    ctx.font = `11px ${FONT}`;
    for (const { row, ch } of this.visibleRows()) {
      if (seen.has(ch.type)) continue;
      seen.add(ch.type);
      const scaling = this.scalings[ch.type] || this.scalings.misc || 1e-3;
      const yc = this.rowCentre(row);
      const hgt = this.rowH;
      const x = x1 - 12;
      ctx.strokeStyle = COLOURS.accent;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, yc - hgt / 2 + 1); ctx.lineTo(x, yc + hgt / 2 - 1); ctx.stroke();
      const text = voltsText((2 * scaling) / this.view.scaleFactor);
      const w = ctx.measureText(text).width + 8;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fillRect(x - w - 4, yc - 8, w, 16);
      ctx.fillStyle = COLOURS.accent;
      ctx.textAlign = 'right';
      ctx.fillText(text, x - 8, yc + 4);
    }
    // where the pointer is: the time under the axis title, the channel's name in the accent colour
    if (this.hover && this.hover.area === 'eeg') {
      ctx.fillStyle = COLOURS.surface;
      ctx.fillRect(0, y1 + 2, x0 - 6, AXIS_H - 2);
      ctx.font = `600 11px ${FONT}`;
      ctx.fillStyle = COLOURS.accent;
      ctx.textAlign = 'left';
      ctx.fillText(`${this.hover.t.toFixed(3)} s`, 8, y1 + 16);
      if (this.hover.row !== null) {
        const yc = this.rowCentre(this.hover.row);
        ctx.fillRect(x0 - 4, yc - 5, 2, 10);
      }
    }
    // the edges of the plot
    ctx.strokeStyle = COLOURS.separator;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
  }

  _renderOverview() {
    const canvas = this.overviewCanvas;
    const ctx = canvas.getContext('2d');
    const W = this.OW;
    const H = OVERVIEW_H;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = COLOURS.surface_alt;
    ctx.fillRect(0, 0, W, H);
    // What has not been on screen yet: white, with a thin amber line along the top.
    if (this.coverage) {
      const gaps = this.gaps.map(([a, b]) => [a / this.sfreq, b / this.sfreq]);
      const ts = (t) => (t / this.durationTotal) * W;
      for (const [a, b] of complement(mergeIntervals([...this.coverage, ...gaps]), this.durationTotal)) {
        const xa = Math.floor(ts(a));
        const w = Math.max(1, Math.ceil(ts(b)) - xa);
        ctx.fillStyle = COLOURS.surface;
        ctx.fillRect(xa, 0, w, H);
        ctx.fillStyle = COLOURS.warning_border;
        ctx.fillRect(xa, 0, w, 3);
      }
    }
    const tx = (s) => (s / this.nSamples) * W;
    for (const [a, b] of this.gaps) hatch(ctx, tx(a), 0, Math.max(1, tx(b) - tx(a)), H, COLOURS.hatch, 6);
    ctx.fillStyle = COLOURS.event;
    for (const e of this.events) ctx.fillRect(Math.round(tx(e.onset_sample)), H - 6, 1, 6);
    for (const a of this.annotations) {
      ctx.fillStyle = this.catalogue.colourFor(a.label);
      const xa = tx(a.onset_sample);
      const w = Math.max(2, tx(end(a)) - xa);
      if (a.channels.length) ctx.fillRect(xa, 16, w, 8); else ctx.fillRect(xa, 8, w, 16);
    }
    const xa = (this.view.startS / this.durationTotal) * W;
    const w = Math.max(3, (this.view.durationS / this.durationTotal) * W);
    ctx.fillStyle = rgba(COLOURS.accent, 0.14);
    ctx.fillRect(xa, 1, w, H - 2);
    ctx.strokeStyle = COLOURS.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(xa + 1, 1, w - 2, H - 2);
    ctx.strokeStyle = COLOURS.separator;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }

  // ------------------------------------------------------------- hit-testing
  /** What is under a point (client coordinates): time, channel, annotation, edge, tag. */
  hit(clientX, clientY, { edge = EDGE_PX, trace = 5 } = {}) {
    const r = this.over.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    if (x < 0 || y < 0 || x > this.W || y > this.H) return null;
    const t = clamp(this.xToT(x), 0, this.durationTotal);
    const info = { x, y, t, sample: Math.floor(t * this.sfreq + 0.5), row: null, channel: null, area: 'axes', annotation: null, edge: null, tag: null };
    for (const tg of this._tags) {
      if (x >= tg.x && x <= tg.x + tg.w && y >= tg.y && y <= tg.y + tg.h) { info.area = 'tags'; info.tag = tg.id; info.annotation = tg.id; return info; }
    }
    if (y >= this.y0 && y <= this.y1) {
      const row = Math.floor((y - this.y0) / this.rowH) + this.view.firstChannel;
      if (row >= this.view.firstChannel && row < Math.min(this.channels.length, this.view.firstChannel + this.view.nChannels)) {
        info.row = row;
        info.channel = this.channels[row].name;
      }
      if (x < this.x0) info.area = 'channel_names';
      else if (x <= this.x1) info.area = 'eeg';
    }
    if (info.area !== 'eeg') return info;
    // annotations under the pointer: the selected one first, then the shortest
    const at = this._visibleAnnotations().filter((a) => {
      const xa = this.sampleToX(a.onset_sample) - edge;
      const xb = this.sampleToX(end(a)) + edge;
      if (x < xa || x > xb) return false;
      return !a.channels.length || (info.channel && a.channels.includes(info.channel));
    }).sort((p, q) => (this.selected.has(q.annotation_id) - this.selected.has(p.annotation_id)) || p.duration_samples - q.duration_samples);
    for (const a of at) {
      const xa = this.sampleToX(a.onset_sample);
      const xb = this.sampleToX(end(a));
      if (Math.abs(x - xa) <= edge && xa >= this.x0 - 1) { info.annotation = a.annotation_id; info.edge = 'start'; return info; }
      if (Math.abs(x - xb) <= edge && xb <= this.x1 + 1) { info.annotation = a.annotation_id; info.edge = 'end'; return info; }
    }
    const inside = at.find((a) => x >= this.sampleToX(a.onset_sample) && x <= this.sampleToX(end(a)));
    if (inside) info.annotation = inside.annotation_id;
    info.nearTrace = this._nearTrace(info.row, x, y, trace);
    return info;
  }

  /** True when (x, y) is within a few pixels of the trace drawn in that row. */
  _nearTrace(row, x, y, slack = 5) {
    if (row === null) return false;
    const c = this._cols.get(row);
    if (!c) return Math.abs(y - this.rowCentre(row)) < Math.max(6, this.rowH / 3);
    const col = Math.floor(x - this.x0);
    let lo = Infinity; let hi = -Infinity;
    for (let k = Math.max(0, col - 3); k <= Math.min(c.min.length - 1, col + 3); k++) {
      if (Number.isNaN(c.min[k])) continue;
      const ya = c.yc - clamp((c.min[k] - c.offset) * c.k, -c.lim, c.lim);
      const yb = c.yc - clamp((c.max[k] - c.offset) * c.k, -c.lim, c.lim); // CSS pixels
      lo = Math.min(lo, ya, yb); hi = Math.max(hi, ya, yb);
    }
    return y >= lo - slack && y <= hi + slack;
  }

  /** For the interaction log: the area, time and channel under a point, or null off the EEG. */
  logInfo(clientX, clientY) {
    const r = this.over.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) {
      const o = this.overviewCanvas.getBoundingClientRect();
      if (clientX >= o.left && clientX <= o.right && clientY >= o.top && clientY <= o.bottom) {
        return { area: 'overview', overview_t: Math.round(((clientX - o.left) / o.width) * this.durationTotal * 1000) / 1000 };
      }
      return null;
    }
    const i = this.hit(clientX, clientY);
    if (!i) return null;
    return { area: i.area === 'tags' ? 'eeg' : i.area, eeg_t: Math.round(i.t * 1000) / 1000, eeg_channel: i.channel };
  }

  _pointer(type, e) {
    if (type === 'dblclick' || type === 'contextmenu') {
      // A finger's double tap and long press are recognised below; the browser's own versions of
      // them (which some touch browsers send as well) would act twice.
      if (this._pointerType !== 'mouse') { if (type === 'contextmenu') e.preventDefault(); return; }
    } else {
      this._pointerType = e.pointerType || 'mouse';
    }
    if (e.pointerType === 'touch' && this._fingers(type, e)) return;
    const coarse = e.pointerType === 'touch' || e.pointerType === 'pen';
    const info = type === 'pointerleave' ? null
      : this.hit(e.clientX, e.clientY, { edge: edgePx(e.pointerType, EDGE_PX), trace: coarse ? 12 : 5 });
    const prev = this.hover;
    this.hover = info;
    if (type === 'pointermove' || type === 'pointerleave') {
      const namesChanged = (prev && prev.area === 'channel_names') !== (info && info.area === 'channel_names') ||
        (info && prev && info.row !== prev.row);
      if (namesChanged) this.invalidate(['under', 'over']); else this.invalidate(['over']);
    }
    if (type === 'pointercancel') { this._endPress(); if (this.onPointer) this.onPointer('cancel', null, e); return; }
    if (this.onPointer) this.onPointer(type, info, e);
    if (coarse) this._pressOrTap(type, e, info);
  }

  /** Two fingers move the view (and cancel what one finger began); returns true when it took the event. */
  _fingers(type, e) {
    const r = this.over.getBoundingClientRect();
    const local = () => [...this._touches.values()].map((p) => ({ x: p.x - r.left, y: p.y - r.top }));
    if (type === 'pointerdown') {
      this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._touches.size === 2) {
        const [a, b] = local();
        const f = twoFingers(a, b);
        this._pinch = { ...f, view: { ...this.view }, tAtC: this.xToT(f.cx) };
        this._endPress();
        this._lastTap = null;
        if (this.onPointer) this.onPointer('cancel', null, e);
        try { this.over.setPointerCapture(e.pointerId); } catch { /* the finger has gone */ }
        return true;
      }
      return this._touches.size > 2 || this._afterPinch;
    }
    if (type === 'pointermove') {
      if (this._touches.has(e.pointerId)) this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pinch && this._touches.size >= 2) {
        const [a, b] = local();
        this.setView(pinchView(this._pinch, twoFingers(a, b), { x0: this.x0, plotW: this.plotW, rowH: this.rowH, durationTotal: this.durationTotal }), 'touch');
        return true;
      }
      return this._afterPinch;
    }
    if (type === 'pointerup' || type === 'pointercancel') {
      this._touches.delete(e.pointerId);
      if (this._pinch) {
        this._pinch = null;
        this._afterPinch = this._touches.size > 0;
        return true;
      }
      if (this._afterPinch) { this._afterPinch = this._touches.size > 0; return true; }
      return false;
    }
    return type === 'pointerleave' && (this._pinch !== null || this._afterPinch);
  }

  /** A finger or pencil held still is a long press; two quick taps in one place are a double tap. */
  _pressOrTap(type, e, info) {
    if (type === 'pointerdown') {
      this._endPress();
      const p = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, fired: false, pointerType: e.pointerType };
      p.timer = setTimeout(() => {
        if (this._press !== p || p.moved) return;
        p.fired = true;
        this._lastTap = null;
        this._swallowTouchEnd = true;
        if (this.onPointer) {
          const at = this.hit(p.x, p.y, { edge: edgePx(p.pointerType, EDGE_PX), trace: 12 });
          this.onPointer('longpress', at, { clientX: p.x, clientY: p.y, pointerType: p.pointerType, preventDefault() {} });
        }
      }, LONG_PRESS_MS);
      this._press = p;
    } else if (type === 'pointermove' && this._press && Math.hypot(e.clientX - this._press.x, e.clientY - this._press.y) > TAP_SLOP_PX) {
      this._press.moved = true;
      clearTimeout(this._press.timer);
    } else if (type === 'pointerup') {
      const p = this._press;
      this._endPress();
      if (!p || p.moved || p.fired) return;
      const tap = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (isDoubleTap(this._lastTap, tap)) {
        this._lastTap = null;
        this._swallowTouchEnd = true;
        if (this.onPointer) this.onPointer('dblclick', info, e);
      } else {
        this._lastTap = tap;
      }
    }
  }

  _endPress() {
    if (this._press) clearTimeout(this._press.timer);
    this._press = null;
  }

  _wheel(e) {
    e.preventDefault();
    const dx = e.deltaX;
    const dy = e.deltaY;
    const unit = e.deltaMode === 1 ? 30 : e.deltaMode === 2 ? this.plotW : 1;
    if (e.shiftKey && Math.abs(dy) > Math.abs(dx)) {
      // Shift+wheel: through the channels
      this._wheelRows = (this._wheelRows || 0) + (dy * unit) / 40;
      const n = Math.trunc(this._wheelRows);
      if (n) { this._wheelRows -= n; this.scrollChannels(n, 'wheel'); }
      return;
    }
    const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    this.scrollBy(((d * unit) / this.plotW) * this.view.durationS, 'wheel');
  }
}
