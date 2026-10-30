// A column chart of counts by day, drawn by the page as plain SVG (no library): the Progress
// section's completions of the last 30 days. One series in the accent colour, thin columns with a
// rounded top on a hairline baseline, a few clean ticks, and a readout for the day under the
// pointer or chosen with the arrow keys. The numbers are also given as a table under the chart.

import { h } from '../ui/dom.js';

const SVG = 'http://www.w3.org/2000/svg';
const HEIGHT = 200;
const PAD = { top: 16, right: 8, bottom: 28, left: 32 };

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  return el;
}

/** Clean ticks from 0 to at least `max`: steps of 1, 2 or 5 times a power of ten, at most five. */
export function niceTicks(max) {
  const top = Math.max(1, Math.ceil(Number(max) || 0));
  let step = 1;
  for (const base of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]) {
    step = base;
    if (top / base <= 4) break;
  }
  const out = [];
  for (let v = 0; v <= top + step - 1 && out.length < 6; v += step) out.push(v);
  return out;
}

/** "28 Oct" from 2026-10-28. */
export function shortDay(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function longDay(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** A column with a 4-pixel rounded top and a square foot, as a path. */
function columnPath(x, y, w, hgt) {
  const r = Math.min(4, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

/**
 * The chart: `days` are ISO dates, `counts` the number for each, `what` names the series in words
 * ("recordings completed by the study"). update(days, counts, what) draws it again.
 */
export function dailyChart(days, counts, what) {
  const tip = h('div.chart-tip', { hidden: true, role: 'status', 'aria-live': 'polite' });
  const plot = h('div.chart-plot');
  const table = h('table.list.chart-table');
  const details = h('details.admin-details.chart-numbers', {}, h('summary', {}, 'The numbers, day by day'), h('div.table-scroll', {}, table));
  const el = h('figure.chart', {}, plot, tip, details);
  let state = { days, counts, what };
  let active = -1;
  let geometry = null;

  const show = (i) => {
    const { days: d, counts: c } = state;
    if (!geometry || i < 0 || i >= d.length) { tip.hidden = true; active = -1; mark(); return; }
    active = i;
    tip.textContent = '';
    tip.append(h('b.num', {}, `${c[i]}`), ` ${c[i] === 1 ? 'recording' : 'recordings'}`, h('span.caption.block', {}, longDay(d[i])));
    tip.hidden = false;
    const x = geometry.x(i) + geometry.band / 2;
    // Beside the column, on the side with more room, so that it never hides the column read.
    const left = Math.round(Math.min(Math.max(x > geometry.width / 2 ? x - 144 - 12 : x + 12, 0), Math.max(0, geometry.width - 144)));
    tip.style.left = `${left}px`;
    mark();
  };
  const mark = () => {
    for (const col of plot.querySelectorAll('[data-day]')) col.classList.toggle('on', Number(col.dataset.day) === active);
    const cross = plot.querySelector('.chart-cross');
    if (cross) {
      cross.setAttribute('visibility', active >= 0 ? 'visible' : 'hidden');
      if (active >= 0) {
        const x = Math.round(geometry.x(active) + geometry.band / 2) + 0.5;
        cross.setAttribute('x1', x);
        cross.setAttribute('x2', x);
      }
    }
  };

  const draw = () => {
    const { days: d, counts: c, what: w } = state;
    const width = Math.max(240, Math.round(plot.clientWidth || 600));
    const inner = width - PAD.left - PAD.right;
    const ticks = niceTicks(Math.max(0, ...c));
    const top = ticks[ticks.length - 1] || 1;
    const band = inner / Math.max(1, d.length);
    const colW = Math.max(2, Math.min(24, Math.floor(band - 2)));
    const y = (v) => PAD.top + (HEIGHT - PAD.top - PAD.bottom) * (1 - v / top);
    const x = (i) => PAD.left + i * band;
    geometry = { x, band, width };
    const total = c.reduce((a, b) => a + b, 0);
    const root = svg('svg', { class: 'chart-svg', width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, role: 'img', tabindex: '0', focusable: 'true',
      'aria-label': `${w}: ${total} in the last ${d.length} days. Use the left and right arrow keys to read each day.` });
    for (const t of ticks) {
      const ty = Math.round(y(t)) + 0.5;
      root.append(svg('line', { class: t === 0 ? 'chart-base' : 'chart-grid', x1: PAD.left, x2: width - PAD.right, y1: ty, y2: ty }));
      const label = svg('text', { class: 'chart-tick', x: PAD.left - 8, y: ty + 4, 'text-anchor': 'end' });
      label.textContent = String(t);
      root.append(label);
    }
    // The crosshair is drawn first, behind the columns, so that it never cuts a column in two.
    root.append(svg('line', { class: 'chart-cross', y1: PAD.top, y2: Math.round(y(0)), x1: 0, x2: 0, visibility: 'hidden' }));
    c.forEach((v, i) => {
      const cx = Math.round(x(i) + (band - colW) / 2);
      if (v > 0) {
        const yTop = Math.round(y(v));
        root.append(svg('path', { class: 'chart-col', 'data-day': i, d: columnPath(cx, yTop, colW, Math.round(y(0)) - yTop) }));
      }
    });
    for (const i of [0, Math.floor((d.length - 1) / 2), d.length - 1]) {
      if (i < 0 || !d[i]) continue;
      const anchor = i === 0 ? 'start' : i === d.length - 1 ? 'end' : 'middle';
      const lx = i === 0 ? x(0) : i === d.length - 1 ? x(i) + band : x(i) + band / 2;
      const label = svg('text', { class: 'chart-tick', x: Math.round(lx), y: HEIGHT - 8, 'text-anchor': anchor });
      label.textContent = shortDay(d[i]);
      root.append(label);
    }
    root.addEventListener('pointermove', (e) => {
      const r = root.getBoundingClientRect();
      const i = Math.floor((e.clientX - r.left - PAD.left) / band);
      show(i >= 0 && i < d.length ? i : -1);
    });
    root.addEventListener('pointerleave', () => show(-1));
    root.addEventListener('blur', () => show(-1));
    root.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const n = d.length;
      const i = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : active < 0 ? n - 1 : Math.max(0, Math.min(n - 1, active + (e.key === 'ArrowRight' ? 1 : -1)));
      show(i);
    });
    plot.textContent = '';
    plot.append(root);
    if (active >= 0) show(active);
    table.textContent = '';
    table.append(h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Day'), h('th.num', { scope: 'col' }, 'Completed'))),
      h('tbody', {}, d.map((day, i) => h('tr', {}, h('td', {}, longDay(day)), h('td.num', {}, String(c[i]))))));
  };

  el.update = (nd, nc, nw) => { state = { days: nd, counts: nc, what: nw }; active = -1; tip.hidden = true; draw(); };
  if (typeof ResizeObserver !== 'undefined') {
    let last = 0;
    // drawn in the next frame: drawing changes the plot's height, which inside the observer's own callback makes
    // browsers report a ResizeObserver loop
    new ResizeObserver(() => requestAnimationFrame(() => { const w = Math.round(plot.clientWidth); if (w && w !== last) { last = w; draw(); } })).observe(plot);
  }
  setTimeout(draw, 0);
  return el;
}
