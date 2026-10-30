// The channel chooser's map (Map, beside List, in chooseChannels of dialogs.js): the electrodes on a
// drawing of the head, each a small labelled circle. A click or a tap chooses an electrode or takes it
// back; dragging a box with the mouse or the Pencil chooses the electrodes in it (or takes them back
// when all of them were chosen); a finger's drag moves a map larger than its frame; the arrow keys go
// from electrode to electrode and Space or Enter chooses. Where the electrodes go is worked out in
// js/viewer/head_map.js. Every change is logged as a channel_map event, with counts rather than names.

import { h, clear } from '../ui/dom.js';
import { logger } from '../log/logger.js';
import { extentOf, mapScale, mapScales, minSpacing, nearestInDirection, pointsInBox, targetSize } from '../viewer/head_map.js';
import { icon } from '../views/common.js';

const SOURCE_TEXT = {
  file: (name) => `Positions from ${name || 'the recording\'s electrodes.tsv'}.`,
  standard: () => 'Standard positions of the 10-20, 10-10 and 10-05 names.',
  order: () => 'Positions not known: arranged in order, from the centre outwards.',
};
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/**
 * @param {object} o layout ({source, points} of mapLayout), fileName (of an electrodes.tsv), channels
 *   [{name, type, bad}], picked (a Set of names, changed in place), colours (Map name -> colour),
 *   isShown (name -> bool, the chooser's search), beforeChange () before a choice is made (the chooser
 *   switches from Whole montage to Only these channels), onChange () after a change
 * @returns {{el: HTMLElement, refresh: Function, setDimmed: Function, focus: Function}}
 */
export function channelMap({ layout, fileName = null, channels, picked, colours = null, isShown = () => true, beforeChange = () => {}, onChange = () => {} }) {
  const points = layout.points;
  const info = new Map(channels.map((c) => [c.name, c]));
  let zoomAt = null; // the step of size (mapScales), chosen when the map is first placed
  let dimmed = false; // Whole montage is chosen: the map stays usable, and a choice switches to Only these channels
  let current = 0; // the electrode that takes the keyboard (roving focus)
  const buttons = points.map((p, i) => {
    const c = info.get(p.name) || {};
    const b = h('button.map-electrode', { type: 'button', 'data-name': p.name, 'aria-pressed': 'false', tabindex: i === 0 ? '0' : '-1',
      'aria-label': `${p.name}${c.bad ? ' (bad)' : ''}`, title: `${p.name}${c.type ? ` (${c.type})` : ''}${c.bad ? ', marked bad' : ''}`,
      class: c.bad ? 'bad' : null, style: colours && colours.get(p.name) && !c.bad ? { '--el-colour': colours.get(p.name) } : {} }, h('span', {}, p.name));
    b.addEventListener('click', () => {
      if (suppressClick) { suppressClick = false; return; }
      beforeChange();
      current = i;
      const on = !picked.has(p.name);
      if (on) picked.add(p.name); else picked.delete(p.name);
      log('toggle', 1, { channel: p.name, chosen: on });
      changed();
    });
    b.addEventListener('keydown', (e) => {
      const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
      if (!dir) return;
      e.preventDefault();
      focusAt(nearestInDirection(points, i, dir));
    });
    b.addEventListener('focus', () => { current = i; roving(); });
    return b;
  });
  const head = h('div.map-head', { 'aria-hidden': 'true' });
  const extraCaption = points.some((p) => p.extra) ? h('span.caption.map-extra-caption', { 'aria-hidden': 'true' }, 'Other channels') : null;
  const box = h('div.map-box', { hidden: true });
  const canvas = h('div.map-canvas', {}, head, extraCaption, ...buttons, box);
  const viewport = h('div.map-viewport', { role: 'group', 'aria-label': 'Electrodes on the head, the nose at the top' }, canvas);
  const zoomOut = h('button.btn.icon.small', { type: 'button', 'aria-label': 'Smaller map', title: 'Smaller map', 'data-log': 'channel-map-smaller', onclick: () => zoom(-1) }, icon('minus'));
  const zoomIn = h('button.btn.icon.small', { type: 'button', 'aria-label': 'Larger map', title: 'Larger map', 'data-log': 'channel-map-larger', onclick: () => zoom(1) }, icon('plus'));
  const act = (label, log, fn) => h('button.btn.small', { type: 'button', 'data-log': `channel-map-${log}`, onclick: fn }, label);
  const all = act('Select all', 'all', () => bulk('all'));
  const none = act('Clear all', 'none', () => bulk('none'));
  const invert = act('Invert', 'invert', () => bulk('invert'));
  const tools = h('div.map-tools', {}, all, none, invert, h('span.map-zoom', { role: 'group', 'aria-label': 'Size of the map' }, zoomOut, zoomIn));
  // A dense cap opens with the whole head in view and the electrodes too close for their names:
  // the note then says how to read them.
  const crowdedNote = h('span.map-crowded-note', { hidden: true }, coarse() ? ' Press + for larger electrodes with their names.'
    : ' Point at an electrode for its name, or press + until every name shows.');
  const note = h('p.caption.map-note', {}, `${SOURCE_TEXT[layout.source](fileName)} `,
    coarse() ? 'Tap an electrode to choose it, drag with the Pencil to choose several, and drag with a finger to move a large map.'
      : 'Click an electrode to choose it, drag a box to choose several, or use the arrow keys and Space.', crowdedNote);
  const el = h('div.channel-map-block', { 'data-source': layout.source }, tools, viewport, note);

  let scale = 1;
  let fitScale = 1;
  let scales = [1];
  let ext = extentOf(points);
  const spacing = minSpacing(points);
  // The map's height is at most half the window; when the dialog would then need scrolling (a short
  // window, or two rows of banks above the map), it is lowered so that the count of channels chosen,
  // under the map, stays in view. Worked out once for each height of the window.
  let fittedFor = null;
  let limitH = null;
  function place() {
    const w = viewport.clientWidth;
    if (!w) return;
    const target = coarse() ? 40 : 28;
    // Neighbours are kept apart by the widest label too (E128 is wider than a circle).
    const room = Math.max(target, Math.min(64, 7 * Math.max(...points.map((p) => p.name.length)) + 12));
    if (fittedFor !== window.innerHeight) { fittedFor = null; limitH = null; }
    const maxH = limitH ?? Math.max(240, Math.min(520, Math.round(window.innerHeight * 0.5)));
    ext = extentOf(points);
    // The first size shows the whole head; + climbs to the size where every name fits, and beyond.
    const s = mapScale(points, { widthPx: w - 8, heightPx: maxH - 8, targetPx: room });
    fitScale = s.fit;
    scales = mapScales(s.fit, s.needed);
    // With a mouse the map opens whole; a finger needs full-sized targets, so on a touch screen it
    // opens at the first size that gives them (the head centred, and a finger's drag moves the map).
    const first = zoomAt === null;
    if (first) zoomAt = coarse() ? Math.max(0, scales.findIndex((sc) => targetSize(spacing, sc, target) >= target)) : 0;
    zoomAt = Math.min(zoomAt, scales.length - 1);
    scale = scales[zoomAt];
    const crowded = scale < s.needed - 1e-6;
    const size = targetSize(spacing, scale, target, crowded ? 3 : 4);
    el.classList.toggle('crowded', crowded);
    crowdedNote.hidden = !crowded;
    const cw = Math.round((ext.maxX - ext.minX) * scale);
    const ch = Math.round((ext.maxY - ext.minY) * scale);
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    viewport.style.height = `${Math.min(maxH, ch + 4)}px`;
    el.style.setProperty('--el-size', `${size}px`);
    points.forEach((p, i) => {
      buttons[i].style.left = `${Math.round((p.x - ext.minX) * scale)}px`;
      buttons[i].style.top = `${Math.round((ext.maxY - p.y) * scale)}px`;
    });
    drawHead();
    if (extraCaption) {
      const extras = points.filter((p) => p.extra);
      const top = Math.max(...extras.map((p) => p.y));
      extraCaption.style.left = `${Math.round((Math.min(...extras.map((p) => p.x)) - ext.minX) * scale - size / 2)}px`;
      extraCaption.style.top = `${Math.round((ext.maxY - top) * scale - size / 2 - 20)}px`;
    }
    zoomOut.disabled = zoomAt === 0;
    zoomIn.disabled = zoomAt === scales.length - 1;
    if (fittedFor === null) {
      fittedFor = window.innerHeight;
      const body = el.closest('.dialog-body');
      const over = body ? body.scrollHeight - body.clientHeight : 0;
      if (over > 1 && viewport.offsetHeight - over < maxH) {
        limitH = Math.max(200, Math.round(viewport.offsetHeight - over));
        if (first) zoomAt = null; // placed again from the start, at the lower height
        place();
        return;
      }
    }
    if (first) {
      viewport.scrollLeft = (cw - viewport.clientWidth) / 2;
      viewport.scrollTop = (ch - viewport.clientHeight) / 2;
    }
  }
  function drawHead() {
    clear(head);
    const r = scale;
    const cx = (0 - ext.minX) * scale;
    const cy = ext.maxY * scale;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(Math.round((ext.maxX - ext.minX) * scale)));
    svg.setAttribute('height', String(Math.round((ext.maxY - ext.minY) * scale)));
    const add = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); svg.appendChild(e); };
    if (layout.source === 'order') {
      add('circle', { cx, cy, r, class: 'map-outline unknown' });
    } else {
      add('circle', { cx, cy, r, class: 'map-outline' });
      add('path', { d: `M ${cx - 0.1 * r} ${cy - 0.995 * r} L ${cx} ${cy - 1.1 * r} L ${cx + 0.1 * r} ${cy - 0.995 * r}`, class: 'map-outline' });
      for (const s of [-1, 1]) add('path', { d: `M ${cx + s * 0.995 * r} ${cy - 0.12 * r} q ${s * 0.08 * r} ${0.02 * r} ${s * 0.08 * r} ${0.12 * r} q 0 ${0.1 * r} ${-s * 0.08 * r} ${0.12 * r}`, class: 'map-outline' });
    }
    head.appendChild(svg);
  }
  function zoom(dir) {
    const next = Math.max(0, Math.min(scales.length - 1, zoomAt + dir));
    if (next === zoomAt) return;
    // keep the middle of what is shown in the middle
    const fx = (viewport.scrollLeft + viewport.clientWidth / 2) / Math.max(1, canvas.offsetWidth);
    const fy = (viewport.scrollTop + viewport.clientHeight / 2) / Math.max(1, canvas.offsetHeight);
    zoomAt = next;
    place();
    viewport.scrollLeft = fx * canvas.offsetWidth - viewport.clientWidth / 2;
    viewport.scrollTop = fy * canvas.offsetHeight - viewport.clientHeight / 2;
    logger.event('channel_map', { action: 'zoom', zoom: Math.round((scale / fitScale) * 100) / 100 });
  }
  function roving() { buttons.forEach((b, i) => { b.tabIndex = i === current ? 0 : -1; }); }
  function focusAt(i) { current = i; roving(); buttons[i].focus(); buttons[i].scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  function log(action, n, extra = {}) {
    logger.event('channel_map', { action, n_changed: n, n_chosen: picked.size, ...extra });
  }
  function changed() { refresh(); onChange(); }
  function targets() { return points.filter((p) => isShown(p.name)).map((p) => p.name); }
  function bulk(kind) {
    if (kind !== 'none') beforeChange();
    const names = targets();
    let n = 0;
    for (const name of names) {
      const want = kind === 'all' ? true : kind === 'none' ? false : !picked.has(name);
      if (want !== picked.has(name)) { n += 1; if (want) picked.add(name); else picked.delete(name); }
    }
    log(kind, n);
    changed();
  }
  function refresh() {
    points.forEach((p, i) => {
      const b = buttons[i];
      b.setAttribute('aria-pressed', String(picked.has(p.name)));
      b.classList.toggle('dim', !isShown(p.name));
    });
    viewport.classList.toggle('disabled', dimmed);
  }

  // Pointers: a box with the mouse or the Pencil, a finger's drag moves the map.
  let drag = null;
  let suppressClick = false;
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, type: e.pointerType || 'mouse', start: local(e), cx: e.clientX, cy: e.clientY, sl: viewport.scrollLeft, st: viewport.scrollTop, moved: false };
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dist = Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy);
    if (!drag.moved && dist < (drag.type === 'touch' ? 8 : 4)) return;
    if (!drag.moved) {
      drag.moved = true;
      try { viewport.setPointerCapture(e.pointerId); } catch { /* the pointer has gone */ }
    }
    if (drag.type === 'touch') {
      viewport.scrollLeft = drag.sl - (e.clientX - drag.cx);
      viewport.scrollTop = drag.st - (e.clientY - drag.cy);
      return;
    }
    const p = local(e);
    const [x0, x1] = [Math.min(drag.start.x, p.x), Math.max(drag.start.x, p.x)];
    const [y0, y1] = [Math.min(drag.start.y, p.y), Math.max(drag.start.y, p.y)];
    Object.assign(box.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
    box.hidden = false;
    drag.end = p;
  });
  const finish = (e, cancelled) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    box.hidden = true;
    if (!d.moved) return;
    suppressClick = true; // the click that ends a drag is not a choice
    setTimeout(() => { suppressClick = false; }, 0);
    if (cancelled || d.type === 'touch' || !d.end) return;
    const toUnits = (q) => ({ x: q.x / scale + ext.minX, y: ext.maxY - q.y / scale });
    const a = toUnits(d.start);
    const b = toUnits(d.end);
    const names = pointsInBox(points, { x0: a.x, y0: a.y, x1: b.x, y1: b.y }).filter(isShown);
    if (!names.length) return;
    // as the group buttons do: choose them all, or take them all back when all were chosen
    const on = !names.every((n) => picked.has(n));
    for (const n of names) { if (on) picked.add(n); else picked.delete(n); }
    if (on) beforeChange();
    log('box', names.length, { chosen: on, pointer: d.type });
    changed();
  };
  viewport.addEventListener('pointerup', (e) => finish(e, false));
  viewport.addEventListener('pointercancel', (e) => finish(e, true));

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => place()) : null;
  if (ro) ro.observe(viewport);
  refresh();
  return {
    el,
    refresh,
    place,
    setDimmed(v) { dimmed = Boolean(v); refresh(); },
    focus() { buttons[current]?.focus({ preventScroll: true }); },
  };
}
