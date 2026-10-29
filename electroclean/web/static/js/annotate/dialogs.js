// The dialogs of the annotation view: the type picker (/ or a double-click), the channel chooser,
// and the editor for an annotation's start and end.

import { h, clear } from '../ui/dom.js';
import { showDialog } from '../ui/dialog.js';
import { Catalogue, displayCode } from '../catalogue.js';
import { legibleOnWhite } from '../util.js';

/**
 * The searchable list of every artifact type. Resolves with the chosen label, or null.
 * `at` ({x, y}, client coordinates) places it next to the pointer.
 */
export function pickType({ title, catalogue, current = null, quick = [], at = null }) {
  const search = h('input.field', { type: 'search', placeholder: 'Type part of a name or code, for example blink or 103', 'aria-label': 'Search the artifact types', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div.picker-list', { role: 'listbox', 'aria-label': 'Artifact types', tabindex: '0' });
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
      h('span.picker-code', {}, `${displayCode(l.short_code)} · ${l.value}`),
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

// ------------------------------------------------------------------ the channel chooser
// Built, as the desktop's channel dialog, for 3 to 260 channels. Up to MANY_CHANNELS it is the
// plain list of check boxes; with more, the channels are laid out in columns sized to the longest
// name, and group buttons tick whole regions, sides, banks or types at once.

/** With more channels than this, the chooser lays them out in columns and offers group buttons. */
export const MANY_CHANNELS = 16;
/** A bank of more numbered channels than this (EGI's E1 to E128) is offered in blocks of this size. */
export const BANK_BLOCK = 32;

/** The search terms typed: names or their beginnings, separated by commas, semicolons or spaces. */
export function searchTerms(text) {
  return String(text ?? '').trim().split(/[,;\s]+/).filter(Boolean);
}

function wildcard(term) {
  // * stands for any characters and ? for any one character; everything else is literal.
  const body = term.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 's');
}

/**
 * The channels a search finds, as a Set of names, or null when nothing is typed. Each term finds
 * the names that begin with it (b1 finds B1 and B10 to B19), also after the "EEG " with which EDF
 * files often start them (f finds EEG F3-REF); a term that begins no name finds the names that
 * contain it (z finds Fz, Cz and Pz). A term in quotes finds that name only ("b1"), and * and ?
 * stand for any characters and any one character (*z, E1?). Case is ignored.
 */
export function findChannels(names, text) {
  const terms = searchTerms(text);
  if (!terms.length) return null;
  const lows = names.map((n) => String(n).toLowerCase());
  const cores = lows.map((low) => low.replace(/^eeg[\s_-]+/, ''));
  const begins = (i, part) => lows[i].startsWith(part) || cores[i].startsWith(part);
  const found = new Set();
  for (const term of terms) {
    const t = term.toLowerCase();
    let test;
    if (t.length >= 2 && t[0] === t[t.length - 1] && (t[0] === '"' || t[0] === "'")) {
      const exact = t.slice(1, -1);
      test = (i) => lows[i] === exact;
    } else if (t.includes('*') || t.includes('?')) {
      const re = wildcard(t);
      test = (i) => re.test(lows[i]);
    } else {
      const part = t.replace(/^["']+|["']+$/g, ''); // a quote still being typed
      test = !part || lows.some((_, i) => begins(i, part)) ? (i) => begins(i, part) : (i) => lows[i].includes(part);
    }
    lows.forEach((_, i) => { if (test(i)) found.add(names[i]); });
  }
  return found;
}

const REGION_OF = { FP: 'Frontal', AF: 'Frontal', F: 'Frontal', FC: 'Central', C: 'Central', CP: 'Central', FT: 'Temporal',
  T: 'Temporal', TP: 'Temporal', P: 'Parietal', PO: 'Occipital', O: 'Occipital', I: 'Occipital' };
const REGIONS = ['Frontal', 'Central', 'Temporal', 'Parietal', 'Occipital'];
const SIDES = ['Left', 'Midline', 'Right'];

/**
 * The region and side of a 10-20 or 10-10 channel name, also as EDF files write it ("EEG Fp1-REF"),
 * or null for other names. Odd numbers are on the left, even on the right, z on the midline.
 */
export function tenTwentyPosition(name) {
  let core = String(name).replace(/^EEG[\s_-]*/i, '');
  core = core.replace(/[\s_-](REF|LE|AR|AVG|CZ|M1|M2|A1|A2)$/i, '');
  const m = /^(FP|AF|FC|FT|CP|TP|PO|F|C|T|P|O|I)(\d+|Z)$/.exec(core.toUpperCase());
  if (!m) return null;
  return { region: REGION_OF[m[1]], side: m[2] === 'Z' ? 'Midline' : (Number(m[2]) % 2 ? 'Left' : 'Right') };
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

/** Numbered channels sharing a prefix (A1 to A32, EXG1 to EXG8), larger ones split into blocks. */
function banks(names) {
  const byPrefix = new Map();
  for (const name of names) {
    const m = /^([A-Za-z]+)(\d+)$/.exec(name);
    if (m) push(byPrefix, m[1], { name, n: Number(m[2]) });
  }
  const out = [];
  for (const [prefix, members] of byPrefix) {
    if (members.length < 2) continue;
    if (members.length <= BANK_BLOCK) { out.push({ name: prefix, channels: members.map((c) => c.name) }); continue; }
    const blocks = new Map();
    for (const c of members) push(blocks, Math.floor((c.n - 1) / BANK_BLOCK), c);
    for (const block of [...blocks.keys()].sort((a, b) => a - b)) {
      const chs = blocks.get(block);
      if (chs.length < 2) continue;
      const byNumber = [...chs].sort((a, b) => a.n - b.n);
      out.push({ name: `${byNumber[0].name}–${byNumber[byNumber.length - 1].name}`, channels: chs.map((c) => c.name) });
    }
  }
  return out;
}

/**
 * The rows of group buttons, as the desktop's channel dialog has them: [{caption, groups: [{name,
 * channels}]}]. A montage whose EEG channels are mostly (60% or more) named by the 10-20 or 10-10
 * system has Regions (frontal, central, temporal, parietal, occipital) and Sides; other montages
 * have Banks, the numbered channels sharing a prefix (BioSemi's A1 to A32 ... D1 to D32), with a
 * bank of more than BANK_BLOCK channels offered in blocks (E1–E32, E33–E64 ...). A montage with
 * more than one type of channel also has Types. channels: [{name, type}] in display order.
 */
export function channelGroups(channels) {
  const rows = [];
  const kindOf = (c) => String(c.type || '');
  const eeg = channels.filter((c) => ['eeg', ''].includes(kindOf(c)));
  const regions = new Map();
  const sides = new Map();
  for (const c of eeg) {
    const pos = tenTwentyPosition(c.name);
    if (!pos) continue;
    push(regions, pos.region, c.name);
    push(sides, pos.side, c.name);
  }
  const placed = [...regions.values()].reduce((n, v) => n + v.length, 0);
  if (eeg.length && placed >= 0.6 * eeg.length) {
    rows.push({ caption: 'Regions', groups: REGIONS.filter((r) => regions.has(r)).map((r) => ({ name: r, channels: regions.get(r) })) });
    rows.push({ caption: 'Sides', groups: SIDES.filter((s) => sides.has(s)).map((s) => ({ name: s, channels: sides.get(s) })) });
  } else {
    const found = banks(channels.map((c) => c.name));
    if (found.length >= 2) rows.push({ caption: 'Banks', groups: found });
  }
  const kinds = new Map();
  for (const c of channels) push(kinds, kindOf(c) || 'other', c.name);
  if (kinds.size >= 2) rows.push({ caption: 'Types', groups: [...kinds].map(([k, chs]) => ({ name: k.toUpperCase(), channels: chs })) });
  return rows;
}

/** A group button's click: tick every member, or clear them all when all are ticked. Returns the new state. */
export function toggleGroup(picked, members) {
  const tick = !members.every((n) => picked.has(n));
  for (const n of members) { if (tick) picked.add(n); else picked.delete(n); }
  return tick;
}

/**
 * The type shown after a channel's name in a large montage: only for channels whose type differs
 * from most of the montage's and is not already in the name (EXG1 · MISC; HEOG needs none).
 */
export function typeSuffixes(channels) {
  const counts = new Map();
  for (const c of channels) counts.set(c.type || '', (counts.get(c.type || '') || 0) + 1);
  const common = [...counts].reduce((best, kv) => (kv[1] > best[1] ? kv : best), ['', -1])[0];
  const out = new Map();
  for (const c of channels) {
    const kind = String(c.type || '');
    if (kind && kind !== common && !c.name.toUpperCase().includes(kind.toUpperCase())) out.set(c.name, kind.toUpperCase());
  }
  return out;
}

/**
 * Choose channels. Resolves with {wholeMontage, channels} or null when cancelled.
 * channels: [{name, type}] in display order.
 */
export function chooseChannels({ title, channels, chosen = [], allowWholeMontage = false, wholeMontage = false }) {
  const names = channels.map((c) => c.name);
  const known = new Set(names);
  const picked = new Set(chosen.filter((n) => known.has(n)));
  const many = channels.length > MANY_CHANNELS;
  const filter = h('input.field', { type: 'search', 'aria-label': 'Filter the channels', autocomplete: 'off',
    placeholder: many ? 'Find channels, e.g. Fp1, B1 or *z' : 'Filter by name' });
  const suffixes = many ? typeSuffixes(channels) : new Map();
  const longest = Math.max(4, ...names.map((n) => n.length + (suffixes.has(n) ? suffixes.get(n).length + 3 : 0)));
  const grid = h('div.channel-grid', many ? { style: { '--chip-ch': String(Math.min(longest, 24)) } } : {});
  const count = h('p.caption.channel-count', { 'aria-live': 'polite' });
  const wholeRadio = h('input', { type: 'radio', name: 'scope', id: 'scope-whole', checked: wholeMontage });
  const someRadio = h('input', { type: 'radio', name: 'scope', id: 'scope-some', checked: !wholeMontage });
  const onlyChosen = many ? h('input', { type: 'checkbox', 'data-log': 'channels-chosen-only' }) : null;
  const boxes = new Map();
  const groupButtons = [];
  let shown = channels.length;
  const isWhole = () => allowWholeMontage && wholeRadio.checked;
  const shownBoxes = () => [...boxes].filter(([, b]) => !b.parentElement.hidden);
  const update = () => {
    const disabled = isWhole();
    grid.classList.toggle('disabled', disabled);
    for (const b of boxes.values()) b.disabled = disabled;
    for (const { btn, members } of groupButtons) {
      btn.disabled = disabled;
      btn.setAttribute('aria-pressed', String(members.every((n) => picked.has(n))));
    }
    for (const b of [all, none, ...(onlyChosen ? [onlyChosen] : [])]) b.disabled = disabled;
    const narrowed = shown < channels.length;
    if (many) {
      all.textContent = narrowed ? `Select ${shown} shown` : 'Select all';
      none.textContent = narrowed ? 'Clear shown' : 'Clear all';
    }
    count.textContent = disabled ? 'The annotation applies to every channel.'
      : `${picked.size} of ${channels.length} channels chosen` + (many && narrowed ? ` · ${shown} shown` : '');
  };
  // Which channels are listed: those the search finds and, with "Show chosen only", those ticked.
  const apply = () => {
    const found = findChannels(names, filter.value);
    const only = Boolean(onlyChosen && onlyChosen.checked);
    shown = 0;
    for (const [name, box] of boxes) {
      const hide = (found !== null && !found.has(name)) || (only && !picked.has(name));
      box.parentElement.hidden = hide;
      if (!hide) shown += 1;
    }
    update();
  };
  for (const c of channels) {
    const box = h('input', { type: 'checkbox', checked: picked.has(c.name), 'data-name': c.name,
      onchange: () => { if (box.checked) picked.add(c.name); else picked.delete(c.name); update(); } });
    boxes.set(c.name, box);
    grid.appendChild(h('label.channel-chip', { title: `${c.name} (${c.type})` }, box, h('span', {}, c.name),
      suffixes.has(c.name) ? h('span.chip-type', {}, `· ${suffixes.get(c.name)}`) : null));
  }
  const setShown = (on) => {
    for (const [n, b] of shownBoxes()) { b.checked = on; if (on) picked.add(n); else picked.delete(n); }
    update();
  };
  filter.addEventListener('input', apply);
  const all = h('button.btn.quiet', { type: 'button', 'data-log': 'channels-select-shown', onclick: () => setShown(true) }, 'Select all shown');
  const none = h('button.btn.quiet', { type: 'button', 'data-log': 'channels-clear-shown', onclick: () => setShown(false) }, 'Clear');
  wholeRadio.addEventListener('change', update);
  someRadio.addEventListener('change', update);
  let groupsBlock = null;
  if (many) {
    const rows = channelGroups(channels);
    if (rows.length) {
      groupsBlock = h('div.channel-groups', { role: 'group', 'aria-label': 'Tick whole groups of channels' }, rows.map((row) => [
        h('span.caption.channel-groups-caption', {}, row.caption),
        h('div.channel-groups-row', {}, row.groups.map((g) => {
          const btn = h('button.btn.small.toggle', { type: 'button', 'data-log': `channel-group-${g.name}`, 'aria-pressed': 'false',
            title: `Tick these ${g.channels.length} channels, or clear them if all are ticked: ${g.channels.join(', ')}`,
            onclick: () => {
              toggleGroup(picked, g.channels);
              for (const n of g.channels) boxes.get(n).checked = picked.has(n);
              apply();
            } }, `${g.name} (${g.channels.length})`);
          groupButtons.push({ btn, members: g.channels });
          return btn;
        })),
      ]));
    }
    onlyChosen.addEventListener('change', apply);
  }
  const help = many ? h('p.caption.channel-help', {},
    'Type names or their beginnings, separated by commas: b1 finds B1 and B10 to B19, and z finds the names containing z ' +
    'when none begins with it. Put a name in quotes for that channel only ("b1"), or use * for any characters (*z).') : null;
  const foot = many ? h('div.channel-foot', {}, count, h('label.channel-only', {}, onlyChosen, ' Show chosen only')) : count;
  const body = h(`div.channel-chooser${many ? '.many' : ''}`, {},
    allowWholeMontage ? h('div.radio-row', {},
      h('label', {}, wholeRadio, ' Whole montage'), h('label', {}, someRadio, ' Only these channels:')) : null,
    h('div.row', {}, filter, all, none), help, groupsBlock, grid, foot);
  update();
  return showDialog({
    title, body, wide: true,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', kind: 'primary' }],
    cancelValue: null,
    // In a large montage, typing finds channels straight away.
    onOpen: many ? () => filter.focus({ preventScroll: true }) : null,
  }).then((v) => {
    if (v !== 'ok') return null;
    if (isWhole()) return { wholeMontage: true, channels: [] };
    return { wholeMontage: false, channels: names.filter((n) => picked.has(n)) };
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
