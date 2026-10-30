// The dialogs of the annotation view: the type picker (/ or a double-click), the channel chooser,
// the editor for an annotation's start and end (and its note), and the note editor.

import { h, clear } from '../ui/dom.js';
import { showDialog } from '../ui/dialog.js';
import { Catalogue, displayCode } from '../catalogue.js';
import { legibleOnWhite, local } from '../util.js';
import { logger } from '../log/logger.js';
import { channelMap } from './channel_map.js';
import { standardPosition } from '../viewer/head_map.js';
import { MAX_NOTE_CHARS, cleanNote, noteProblem } from './confidence.js';
import { parseTimeText } from './goto.js';

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

/** The sites of the 10-10 system, row by row (with 9 and 10 on the ring below, and the inion row). */
const TEN_TEN = Object.freeze({
  Fp: 'z 1 2', AF: 'z 3 4 7 8 9 10', F: 'z 1 2 3 4 5 6 7 8 9 10', FC: 'z 1 2 3 4 5 6', FT: '7 8 9 10', C: 'z 1 2 3 4 5 6',
  T: '7 8 9 10', CP: 'z 1 2 3 4 5 6', TP: '7 8 9 10', P: 'z 1 2 3 4 5 6 7 8 9 10', PO: 'z 3 4 7 8 9 10', O: 'z 1 2', I: 'z 1 2',
});

/** The 10-10 sites with their map positions, regions and sides. */
let tenTenSites = null;
function sites() {
  if (!tenTenSites) {
    tenTenSites = [];
    for (const [row, numbers] of Object.entries(TEN_TEN)) {
      for (const n of numbers.split(' ')) {
        const name = `${row}${n}`;
        const at = standardPosition(name);
        const pos = tenTwentyPosition(name);
        if (at && pos) tenTenSites.push({ ...at, ...pos });
      }
    }
  }
  return tenTenSites;
}

/**
 * The region and side of channels whose names say nothing about where they are (BioSemi's A1 to
 * H32, EGI's E1 to E256) but whose positions came with the recording (an electrodes.tsv, as map
 * positions {x, y} of js/viewer/head_map.js): those of the nearest 10-10 site. Returns a Map name ->
 * {region, side}.
 */
export function regionsFromPositions(positions) {
  const out = new Map();
  if (!positions) return out;
  const all = sites();
  for (const [name, p] of positions) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    let best = null;
    let d = Infinity;
    for (const q of all) {
      const e = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (e < d) { d = e; best = q; }
    }
    if (best) out.set(name, { region: best.region, side: best.side });
  }
  return out;
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
 * bank of more than BANK_BLOCK channels offered in blocks (E1–E32, E33–E64 ...), and Regions and
 * Sides as well when the recording's own positions (`positions`, a Map name -> {x, y} from its
 * electrodes.tsv) place 60% or more of them (regionsFromPositions). A montage with more than one
 * type of channel also has Types. channels: [{name, type}] in display order.
 */
export function channelGroups(channels, positions = null) {
  const rows = [];
  const kindOf = (c) => String(c.type || '');
  const eeg = channels.filter((c) => ['eeg', ''].includes(kindOf(c)));
  const byPlace = (placeOf) => {
    const regions = new Map();
    const sides = new Map();
    for (const c of eeg) {
      const pos = placeOf(c.name);
      if (!pos) continue;
      push(regions, pos.region, c.name);
      push(sides, pos.side, c.name);
    }
    const placed = [...regions.values()].reduce((n, v) => n + v.length, 0);
    if (!eeg.length || placed < 0.6 * eeg.length) return false;
    rows.push({ caption: 'Regions', groups: REGIONS.filter((r) => regions.has(r)).map((r) => ({ name: r, channels: regions.get(r) })) });
    rows.push({ caption: 'Sides', groups: SIDES.filter((s) => sides.has(s)).map((s) => ({ name: s, channels: sides.get(s) })) });
    return true;
  };
  if (!byPlace(tenTwentyPosition)) {
    // Positions from the recording's electrodes.tsv place a cap named by numbers (beside its banks).
    if (positions && positions.size) {
      const placed = regionsFromPositions(positions);
      byPlace((name) => placed.get(name));
    }
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
 * channels: [{name, type}] in display order. `map` ({layout, fileName, colours, storageKey}, from the
 * annotation view) adds the head map (channel_map.js) beside the list, with the person's last choice
 * of the two kept under storageKey.
 */
export function chooseChannels({ title, channels, chosen = [], allowWholeMontage = false, wholeMontage = false, map = null, bad = null }) {
  // `bad` ({marked: names}): the channels the annotator marked bad for the whole recording, shown struck
  // through, with buttons that mark the chosen channels bad or good again (the answer is then
  // {action: 'bad' | 'good', channels}). The study's own bad channels (channels[].bad) cannot be changed.
  const marked = new Set(bad ? bad.marked || [] : []);
  channels = channels.map((c) => (marked.has(c.name) ? { ...c, bad: true, markedBad: true } : c));
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
  // With Whole montage chosen the channels stay usable, only dimmed: choosing one (in the list or on the
  // map, or with a group button) switches to "Only these channels" by itself.
  const update = () => {
    const whole = isWhole();
    grid.classList.toggle('disabled', whole);
    for (const { btn, members } of groupButtons) btn.setAttribute('aria-pressed', String(!whole && members.every((n) => picked.has(n))));
    if (mapPart) mapPart.setDimmed(whole);
    const narrowed = shown < channels.length;
    all.textContent = narrowed ? `Select ${shown} shown` : 'Select all';
    none.textContent = narrowed ? 'Clear shown' : 'Clear all';
    count.textContent = whole ? 'The annotation applies to every channel. Choose a channel to apply it to only some.'
      : `${picked.size} of ${channels.length} channels chosen` + (narrowed ? ` · ${shown} shown` : '');
    if (badRow) {
      const chosenNow = names.filter((n) => picked.has(n));
      markBad.disabled = whole || !chosenNow.some((n) => !marked.has(n) && !studyBad.has(n));
      markGood.disabled = whole || !chosenNow.some((n) => marked.has(n));
    }
  };
  const toSome = () => { if (isWhole()) someRadio.checked = true; };
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
      onchange: () => { toSome(); if (box.checked) picked.add(c.name); else picked.delete(c.name); update(); } });
    boxes.set(c.name, box);
    grid.appendChild(h(`label.channel-chip${c.markedBad ? '.marked-bad' : c.bad ? '.study-bad' : ''}`, {
      title: `${c.name} (${c.type})${c.markedBad ? ' · you marked it bad for the whole recording' : c.bad ? ' · bad in the study\'s channel list' : ''}` },
    box, h('span.channel-name', {}, c.name),
      suffixes.has(c.name) ? h('span.chip-type', {}, `· ${suffixes.get(c.name)}`) : null));
  }
  const setShown = (on) => {
    if (on) toSome();
    for (const [n, b] of shownBoxes()) { b.checked = on; if (on) picked.add(n); else picked.delete(n); }
    update();
  };
  filter.addEventListener('input', apply);
  const all = h('button.btn.quiet', { type: 'button', 'data-log': 'channels-select-shown', onclick: () => setShown(true) }, 'Select all');
  const none = h('button.btn.quiet', { type: 'button', 'data-log': 'channels-clear-shown', onclick: () => setShown(false) }, 'Clear all');
  wholeRadio.addEventListener('change', update);
  someRadio.addEventListener('change', update);
  let groupsBlock = null;
  if (many) {
    const placed = map && map.layout && map.layout.source === 'file' ? new Map(map.layout.points.filter((p) => !p.extra).map((p) => [p.name, p])) : null;
    const rows = channelGroups(channels, placed);
    if (rows.length) {
      groupsBlock = h('div.channel-groups', { role: 'group', 'aria-label': 'Tick whole groups of channels' }, rows.map((row) => [
        h('span.caption.channel-groups-caption', {}, row.caption),
        h('div.channel-groups-row', {}, row.groups.map((g) => {
          const btn = h('button.btn.small.toggle', { type: 'button', 'data-log': `channel-group-${g.name}`, 'aria-pressed': 'false',
            title: `Tick these ${g.channels.length} channels, or clear them if all are ticked: ${g.channels.join(', ')}`,
            onclick: () => {
              toSome();
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
  const { mapPart, viewRow, showView } = channelViews({ map, channels, picked, grid, listOnly: [all, none, help],
    isShown: (n) => !boxes.get(n).parentElement.hidden, beforeChange: toSome,
    onChange: () => { for (const [n, b] of boxes) b.checked = picked.has(n); apply(); } });
  const studyBad = new Set(channels.filter((c) => c.bad && !c.markedBad).map((c) => c.name));
  let closeWith = null;
  const markBad = h('button.btn.small', { type: 'button', 'data-log': 'channels-mark-bad',
    title: 'Mark the chosen channels as bad for the whole recording: they are hatched on the EEG and saved with your work', onclick: () => closeWith && closeWith('bad') }, 'Mark chosen as bad');
  const markGood = h('button.btn.small', { type: 'button', 'data-log': 'channels-mark-good',
    title: 'Take the bad mark off the chosen channels', onclick: () => closeWith && closeWith('good') }, 'Mark chosen as good');
  const badRow = bad ? h('div.channel-bad-row', {},
    h('p.caption', {}, marked.size ? `Marked bad for the whole recording: ${names.filter((n) => marked.has(n)).join(', ')}.`
      : 'A channel that is unusable throughout can be marked bad for the whole recording.'
      + (studyBad.size ? ` The study's own bad channels (${[...studyBad].slice(0, 6).join(', ')}${studyBad.size > 6 ? ', …' : ''}) are marked already.` : '')),
    h('div.btn-row', {}, markBad, markGood)) : null;
  const body = h(`div.channel-chooser${many ? '.many' : ''}`, {},
    allowWholeMontage ? h('div.radio-row', {},
      h('label', {}, wholeRadio, ' Whole montage'), h('label', {}, someRadio, ' Only these channels:')) : null,
    viewRow, h('div.row', {}, filter, all, none), help, groupsBlock, grid, mapPart ? mapPart.el : null, foot, badRow);
  update();
  return showDialog({
    title, body, wide: true,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', kind: 'primary' }],
    cancelValue: null,
    // In a large montage, typing finds channels straight away.
    onOpen: ({ close }) => { closeWith = close; showView(); if (many) filter.focus({ preventScroll: true }); },
  }).then((v) => {
    if (v === 'bad' || v === 'good') return { action: v, channels: names.filter((n) => picked.has(n)) };
    if (v !== 'ok') return null;
    if (isWhole()) return { wholeMontage: true, channels: [] };
    return { wholeMontage: false, channels: names.filter((n) => picked.has(n)) };
  });
}

/**
 * The List and Map views of the channel chooser: the switch between them, and the map. Returns
 * {mapPart, viewRow, showView}; without `map` there is only the list.
 */
function channelViews({ map, channels, picked, grid, listOnly, isShown, beforeChange, onChange }) {
  if (!map || !map.layout || !map.layout.points.length) return { mapPart: null, viewRow: null, showView: () => {} };
  const mapPart = channelMap({ layout: map.layout, fileName: map.fileName, channels, picked, colours: map.colours, isShown, beforeChange, onChange });
  let view = local.get(map.storageKey, 'list') === 'map' ? 'map' : 'list';
  const seg = (kind, label) => {
    const b = h('button.seg', { type: 'button', 'data-view': kind, 'data-log': `channel-view-${kind}`,
      onclick: () => { if (view === kind) return; view = kind; local.set(map.storageKey, kind); logger.event('channel_chooser_view', { view: kind }); showView(); } }, label);
    return b;
  };
  const listBtn = seg('list', 'List');
  const mapBtn = seg('map', 'Map');
  const viewRow = h('div.channel-view-row', {}, h('span.caption', {}, 'Show the channels as'),
    h('div.segmented', { role: 'group', 'aria-label': 'Show the channels as' }, listBtn, mapBtn));
  const showView = () => {
    const onMap = view === 'map';
    listBtn.setAttribute('aria-pressed', String(!onMap));
    mapBtn.setAttribute('aria-pressed', String(onMap));
    grid.hidden = onMap;
    for (const b of listOnly) if (b) b.hidden = onMap; // the map has its own buttons, and its note says how to choose
    mapPart.el.hidden = !onMap;
    if (onMap) { mapPart.place(); mapPart.refresh(); }
  };
  return { mapPart, viewRow, showView };
}

/**
 * A one-line field for an annotation's note, with the characters left. Its text is never logged (the
 * interaction log skips text fields), and the dialogs close with 'ok', never with the note itself.
 */
function noteField(note, id) {
  const input = h('input.field', { type: 'text', id, name: 'note', maxlength: String(MAX_NOTE_CHARS), value: note || '',
    autocomplete: 'off', spellcheck: 'true', placeholder: 'For example: could be an eye movement' });
  const count = h('p.caption.note-count');
  const update = () => {
    const problem = noteProblem(input.value);
    count.textContent = problem || `${cleanNote(input.value).length} of ${MAX_NOTE_CHARS} characters. Only the study's researchers see notes.`;
    count.classList.toggle('error', Boolean(problem));
    return !problem;
  };
  input.addEventListener('input', update);
  update();
  return { input, count, update };
}

/** The note of one annotation: resolves with the new note ('' to remove it), or null when cancelled. */
export function editNote({ title, note = '' }) {
  const f = noteField(note, 'note-text');
  const body = h('div.form', {}, h('label.form-row', { for: 'note-text' }, h('span', {}, 'Note'), f.input), f.count);
  const buttons = [{ label: 'Cancel', value: null }];
  if (note) buttons.push({ label: 'Remove note', value: 'remove' });
  buttons.push({ label: 'Keep note', value: 'ok', kind: 'primary' });
  return showDialog({
    title, body, buttons, cancelValue: null, className: 'note-dialog',
    onOpen: ({ box, close }) => {
      const ok = box.querySelector('button[data-value="ok"]');
      const sync = () => { ok.disabled = !f.update(); };
      f.input.addEventListener('input', sync);
      sync();
      f.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ok.disabled) { e.preventDefault(); close('ok'); } });
      f.input.focus();
    },
  }).then((v) => (v === 'ok' ? cleanNote(f.input.value) : v === 'remove' ? '' : null));
}

/**
 * The start and end of an annotation, and its note when `note` is given (a string): resolves with
 * [start, end] in seconds (or [start, end, note]), or null when cancelled. The times are typed as
 * Go to time takes them: seconds (12.5), m:ss (1:05.25) or h:mm:ss (1:02:05).
 */
export function editTimes({ start, end, sfreq, duration, note = null }) {
  const digits = Math.max(3, Math.ceil(Math.log10(sfreq)));
  const field = (id, name, value) => h('input.field', { type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false',
    value: value.toFixed(digits), id, name, 'aria-describedby': 'times-msg' });
  const a = field('times-start', 'start', start);
  const b = field('times-end', 'end', end);
  const msg = h('p.caption', { id: 'times-msg' });
  const nf = typeof note === 'string' ? noteField(note, 'times-note') : null;
  let ok = null;
  const read = (input) => parseTimeText(input.value);
  const check = () => {
    const ra = read(a);
    const rb = read(b);
    const s = ra.t;
    const e = rb.t;
    let problem = '';
    if (!a.value.trim() || !b.value.trim()) problem = 'Enter both times.';
    else if (ra.error || rb.error) problem = `${ra.error ? 'Start' : 'End'}: ${(ra.error || rb.error)}`;
    else if (s < 0 || e > duration + 1e-9) problem = `The times must lie between 0 and ${duration.toFixed(3)} s.`;
    else if (e <= s) problem = 'The end must come after the start.';
    msg.textContent = problem || `Duration ${(e - s).toFixed(3)} s. Type seconds (12.5), m:ss (1:05.25) or h:mm:ss; times are rounded to the nearest sample (${sfreq} per second).`;
    msg.classList.toggle('error', Boolean(problem));
    if (ok) ok.disabled = Boolean(problem) || (nf ? !nf.update() : false);
  };
  a.addEventListener('input', check);
  b.addEventListener('input', check);
  if (nf) nf.input.addEventListener('input', check);
  const body = h('div.form', {},
    h('label.form-row', { for: 'times-start' }, h('span', {}, 'Start'), a),
    h('label.form-row', { for: 'times-end' }, h('span', {}, 'End'), b), msg,
    nf ? h('label.form-row', { for: 'times-note' }, h('span', {}, 'Note (optional)'), nf.input) : null, nf ? nf.count : null);
  return showDialog({
    title: 'Edit times', body,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', kind: 'primary' }], cancelValue: null,
    onOpen: ({ box, close }) => {
      ok = box.querySelector('button[data-value="ok"]');
      check();
      for (const f of [a, b, ...(nf ? [nf.input] : [])]) f.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ok.disabled) { e.preventDefault(); close('ok'); } });
      a.focus();
      a.select();
    },
  }).then((v) => (v !== 'ok' ? null : nf ? [read(a).t, read(b).t, cleanNote(nf.input.value)] : [read(a).t, read(b).t]));
}

/** A small swatch-and-name element for a type. */
export function typeBadge(catalogue, label) {
  const l = catalogue.get(label);
  return h('span.type-badge', {}, h('span.swatch', { style: { background: l.colour } }),
    h('span', { style: { color: legibleOnWhite(l.colour) } }, l.label));
}
