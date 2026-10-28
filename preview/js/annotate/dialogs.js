// The dialogs of the annotation view: the type picker (/ or a double-click), the channel chooser,
// and the editor for an annotation's start and end.

import { h, clear } from '../ui/dom.js';
import { showDialog } from '../ui/dialog.js';
import { Catalogue } from '../catalogue.js';
import { legibleOnWhite } from '../util.js';

/**
 * The searchable list of every artifact type. Resolves with the chosen label, or null.
 * `at` ({x, y}, client coordinates) places it next to the pointer.
 */
export function pickType({ title, catalogue, current = null, quick = [], at = null }) {
  const search = h('input.field', { type: 'search', placeholder: 'Type part of a name or code, for example blink or 103', 'aria-label': 'Search the artifact types', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div.picker-list', { role: 'listbox', 'aria-label': 'Artifact types' });
  const hint = h('p.caption', {}, 'Enter chooses the highlighted type. Group terms, in italics, are for artifacts whose exact type is unclear.');
  let items = [];
  let active = 0;
  let close = null;
  const keyOf = new Map(quick.map((n, i) => [n, i + 1]));
  const render = () => {
    clear(list);
    const text = search.value.trim();
    items = [];
    const add = (l, inQuick) => {
      const key = keyOf.get(l.label);
      const el = h(`div.picker-item${l.is_group ? '.group' : ''}${l.label === current ? '.current' : ''}`, {
        role: 'option', 'data-label': l.label, title: l.description || l.label,
        onmousedown: (e) => { e.preventDefault(); close && close(l.label); },
        onmousemove: () => { const i = items.indexOf(el); if (i !== active) { active = i; mark(); } },
      },
      h('span.swatch', { style: { background: l.colour } }),
      h('span.picker-name', {}, l.label),
      h('span.picker-code', {}, `${l.short_code} · ${l.value}`),
      inQuick && key ? h('kbd', {}, String(key)) : null);
      items.push(el);
      list.appendChild(el);
    };
    if (!text && quick.length) {
      list.appendChild(h('div.picker-section', {}, 'Keys 1 to 9'));
      quick.forEach((n) => catalogue.has(n) && add(catalogue.get(n), true));
    }
    for (const s of catalogue.sections()) {
      const ls = s.labels.filter((l) => !text || Catalogue.matches(l, text));
      if (!ls.length) continue;
      list.appendChild(h('div.picker-section', {}, s.section));
      ls.forEach((l) => add(l, false));
    }
    if (!items.length) list.appendChild(h('p.picker-empty', {}, 'No type matches. Try another word, or a number such as 103.'));
    active = Math.max(0, items.findIndex((el) => el.dataset.label === current && !text));
    if (text) active = 0;
    mark();
  };
  const mark = () => {
    items.forEach((el, i) => el.classList.toggle('active', i === active));
    const el = items[active];
    if (el) el.scrollIntoView({ block: 'nearest' });
  };
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); const el = items[active]; if (el && close) close(el.dataset.label); }
  });
  const body = h('div.picker', {}, search, list, hint);
  render();
  return showDialog({
    title, body, buttons: [{ label: 'Cancel', value: null }], cancelValue: null, className: 'picker-dialog',
    onOpen: ({ box, close: c }) => {
      close = c;
      if (at) {
        box.classList.add('anchored');
        const r = box.getBoundingClientRect();
        box.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8))}px`;
        box.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8))}px`;
      }
      search.focus();
    },
  });
}

/**
 * Choose channels. Resolves with {wholeMontage, channels} or null when cancelled.
 * channels: [{name, type}] in display order.
 */
export function chooseChannels({ title, channels, chosen = [], allowWholeMontage = false, wholeMontage = false }) {
  const picked = new Set(chosen);
  const filter = h('input.field', { type: 'search', placeholder: 'Filter by name', 'aria-label': 'Filter the channels', autocomplete: 'off' });
  const grid = h('div.channel-grid');
  const count = h('p.caption');
  const wholeRadio = h('input', { type: 'radio', name: 'scope', id: 'scope-whole', checked: wholeMontage });
  const someRadio = h('input', { type: 'radio', name: 'scope', id: 'scope-some', checked: !wholeMontage });
  const boxes = new Map();
  const update = () => {
    const disabled = allowWholeMontage && wholeRadio.checked;
    grid.classList.toggle('disabled', disabled);
    for (const b of boxes.values()) b.disabled = disabled;
    count.textContent = disabled ? 'The annotation applies to every channel.' : `${picked.size} of ${channels.length} channels chosen`;
  };
  for (const c of channels) {
    const box = h('input', { type: 'checkbox', checked: picked.has(c.name), 'data-name': c.name,
      onchange: () => { if (box.checked) picked.add(c.name); else picked.delete(c.name); update(); } });
    boxes.set(c.name, box);
    grid.appendChild(h('label.channel-chip', { title: `${c.name} (${c.type})` }, box, h('span', {}, c.name)));
  }
  filter.addEventListener('input', () => {
    const t = filter.value.trim().toLowerCase();
    for (const [name, box] of boxes) box.parentElement.hidden = Boolean(t) && !name.toLowerCase().includes(t);
  });
  const all = h('button.btn.quiet', { type: 'button', onclick: () => { for (const [n, b] of boxes) if (!b.parentElement.hidden) { b.checked = true; picked.add(n); } update(); } }, 'Select all shown');
  const none = h('button.btn.quiet', { type: 'button', onclick: () => { for (const [n, b] of boxes) if (!b.parentElement.hidden) { b.checked = false; picked.delete(n); } update(); } }, 'Clear');
  wholeRadio.addEventListener('change', update);
  someRadio.addEventListener('change', update);
  const body = h('div.channel-chooser', {},
    allowWholeMontage ? h('div.radio-row', {},
      h('label', {}, wholeRadio, ' Whole montage'), h('label', {}, someRadio, ' Only these channels:')) : null,
    h('div.row', {}, filter, all, none), grid, count);
  update();
  return showDialog({
    title, body, wide: true,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', kind: 'primary' }],
    cancelValue: null,
  }).then((v) => {
    if (v !== 'ok') return null;
    if (allowWholeMontage && wholeRadio.checked) return { wholeMontage: true, channels: [] };
    return { wholeMontage: false, channels: channels.map((c) => c.name).filter((n) => picked.has(n)) };
  });
}

/** Edit the start and end (seconds). Resolves with [start, end] or null. */
export function editTimes({ start, end, sfreq, duration }) {
  const digits = Math.max(3, Math.ceil(Math.log10(sfreq)));
  const step = (1 / sfreq).toFixed(digits);
  const a = h('input.field', { type: 'number', step, min: '0', max: String(duration), value: start.toFixed(digits), id: 'times-start', name: 'start' });
  const b = h('input.field', { type: 'number', step, min: '0', max: String(duration), value: end.toFixed(digits), id: 'times-end', name: 'end' });
  const msg = h('p.caption');
  let ok = null;
  const check = () => {
    const s = Number(a.value);
    const e = Number(b.value);
    let problem = '';
    if (!Number.isFinite(s) || !Number.isFinite(e)) problem = 'Enter both times in seconds.';
    else if (s < 0 || e > duration + 1e-9) problem = `The times must lie between 0 and ${duration.toFixed(3)} s.`;
    else if (e <= s) problem = 'The end must come after the start.';
    msg.textContent = problem || `Duration ${(e - s).toFixed(3)} s. Times are rounded to the nearest sample (${sfreq} per second).`;
    msg.classList.toggle('error', Boolean(problem));
    if (ok) ok.disabled = Boolean(problem);
  };
  a.addEventListener('input', check);
  b.addEventListener('input', check);
  const body = h('div.form', {},
    h('label.form-row', { for: 'times-start' }, h('span', {}, 'Start (s)'), a),
    h('label.form-row', { for: 'times-end' }, h('span', {}, 'End (s)'), b), msg);
  return showDialog({
    title: 'Edit times', body,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', kind: 'primary' }], cancelValue: null,
    onOpen: ({ box, close }) => {
      ok = box.querySelector('button[data-value="ok"]');
      check();
      for (const f of [a, b]) f.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ok.disabled) { e.preventDefault(); close('ok'); } });
      a.focus();
      a.select();
    },
  }).then((v) => (v === 'ok' ? [Number(a.value), Number(b.value)] : null));
}

/** A small swatch-and-name element for a type. */
export function typeBadge(catalogue, label) {
  const l = catalogue.get(label);
  return h('span.type-badge', {}, h('span.swatch', { style: { background: l.colour } }),
    h('span', { style: { color: legibleOnWhite(l.colour) } }, l.label));
}
