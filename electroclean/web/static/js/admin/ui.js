// Pieces shared by the admin area's sections: messages, buttons that show they are working,
// fields, tables with pages, in-page confirmations, copying, downloads and the report frame.
// They use the application's own classes (app.css) and a few of their own (admin.css).

import { h, clear } from '../ui/dom.js';
import { downloadFiles, icon } from '../views/common.js';
import { base64ToBytes, fileParts, problemText, sortRows } from './model.js';

let uid = 0;
export const nextId = (prefix = 'adm') => `${prefix}-${++uid}`;

// ------------------------------------------------------------------ messages
/** A place for the answer to an action: show(kind, text) with kind error, success, note or banner. */
export function messageArea() {
  const el = h('div.admin-msg', { 'aria-live': 'polite' });
  el.show = (kind, text, ...extra) => {
    clear(el);
    if (!text && !extra.length) return el;
    const cls = kind === 'error' ? 'banner.error-banner' : kind;
    el.append(h(`div.${cls}`, { role: kind === 'error' ? 'alert' : 'status' }, h('p', {}, text), ...extra));
    return el;
  };
  el.problem = (exc) => {
    if (exc && exc.code === 'needs_server') return el.show('note', exc.message);
    return el.show('error', problemText(exc));
  };
  el.clear = () => clear(el);
  return el;
}

/**
 * Run fn while the button says what is happening and cannot be pressed again (a second press
 * while a slow answer is on its way would repeat the action). Resolves with fn's result.
 */
export async function busy(button, label, fn) {
  if (button.dataset.busy === '1') return undefined;
  const text = button.textContent;
  button.dataset.busy = '1';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (label) button.textContent = label;
  try {
    return await fn();
  } finally {
    button.dataset.busy = '';
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (label) button.textContent = text;
  }
}

/** A button whose action runs through busy() and reports failures in `msg`. */
export function actionButton(label, { kind = '', working = '', msg = null, onClick, log = null, title = null } = {}) {
  const b = h(`button.btn${kind ? `.${kind.split(' ').join('.')}` : ''}`, { type: 'button', 'data-log': log, title });
  b.textContent = label;
  b.addEventListener('click', () => busy(b, working, async () => {
    try { await onClick(b); } catch (exc) { if (msg) msg.problem(exc); else throw exc; }
  }));
  return b;
}

// -------------------------------------------------------------------- layout
export function sectionHead(title, intro = '') {
  return h('div.admin-head', {}, h('h1', { tabindex: '-1' }, title), intro ? h('p.subtitle', {}, intro) : null);
}

export function card(title, ...children) {
  return h('section.card.admin-card', {}, title ? h('h2', {}, title) : null, ...children);
}

export function chip(text, kind = '') {
  return h(`span.chip${kind ? `.${kind}` : ''}`, {}, text);
}

export function loading(text = 'Loading…') {
  return h('p.caption.admin-loading', { role: 'status' }, text);
}

// -------------------------------------------------------------------- fields
/** A labelled field: the label, the control and a caption under it. */
export function field(label, control, { hint = '', wide = false } = {}) {
  if (!control.id) control.id = nextId('f');
  return h(`div.admin-field${wide ? '.wide' : ''}`, {},
    h('label.form-label', { for: control.id }, label), control, hint ? h('p.caption', {}, hint) : null);
}

export function textInput({ value = '', placeholder = '', type = 'text', name = '', autocomplete = 'off', maxlength = null } = {}) {
  return h('input.field', { type, value: value ?? '', placeholder, name: name || null, autocomplete, spellcheck: 'false', maxlength });
}

export function numberInput({ value = '', min = null, max = null, step = 'any' } = {}) {
  return h('input.field.num', { type: 'number', value: value ?? '', min, max, step, inputmode: 'decimal' });
}

export function textArea({ value = '', rows = 3, placeholder = '' } = {}) {
  const t = h('textarea.field.area', { rows, placeholder });
  t.value = value ?? '';
  return t;
}

/** A <select> from [[value, text], ...] or {value: text}. */
export function select(options, value = '') {
  const s = h('select.field');
  const list = Array.isArray(options) ? options : Object.entries(options);
  for (const o of list) {
    if (o && o.group) {
      const g = h('optgroup', { label: o.group });
      for (const [v, t] of o.options) g.append(h('option', { value: v }, t));
      s.append(g);
    } else s.append(h('option', { value: o[0] }, o[1]));
  }
  // An unknown value would leave the field blank: keep the first choice then.
  if (value !== null && value !== undefined && [...s.options].some((x) => x.value === String(value))) s.value = String(value);
  return s;
}

/** A recording ID shown so that it wraps at its folders: the file name, then the folder in grey. */
export function recordingName(rid, fileName = null) {
  const { name, folder } = fileParts(rid);
  return h('span.rec-name', { title: rid }, h('span.file', {}, fileName || name), folder ? h('span.caption.block.folder', {}, folder) : null);
}

export function checkbox(label, checked = false, { hint = '' } = {}) {
  const input = h('input', { type: 'checkbox' });
  input.checked = Boolean(checked);
  const el = h('label.check', {}, input, h('span', {}, label));
  if (hint) el.title = hint;
  el.input = input;
  return el;
}

/**
 * A list of checkboxes with "All" and "None" buttons: items are {value, text, hint}. values()
 * gives the ticked values; a filter field appears when the list is long.
 */
export function checkList(items, { selected = [], legend = '', empty = 'Nothing to choose from yet.', name = '' } = {}) {
  const chosen = new Set(selected);
  const boxes = [];
  const list = h('div.check-list', { role: 'group', 'aria-label': legend || name || null });
  for (const it of items) {
    const input = h('input', { type: 'checkbox', value: it.value, 'data-name': name || null });
    input.checked = chosen.has(it.value);
    const row = h('label.check-item', { title: it.hint || null }, input,
      h('span.check-text', {}, h('span', {}, it.text), it.extra ? h('span.caption.block', {}, it.extra) : null));
    boxes.push({ input, row, text: `${it.value} ${it.text} ${it.extra || ''}`.toLowerCase() });
    list.append(row);
  }
  const filter = items.length > 12 ? h('input.field.small', { type: 'search', placeholder: 'Filter the list', 'aria-label': `Filter ${legend || 'the list'}` }) : null;
  if (filter) {
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      for (const b of boxes) b.row.hidden = Boolean(q) && !b.text.includes(q);
    });
  }
  const setAll = (on) => { for (const b of boxes) if (!b.row.hidden) b.input.checked = on; el.dispatchEvent(new Event('change')); };
  const count = h('span.caption');
  const update = () => { count.textContent = `${boxes.filter((b) => b.input.checked).length} of ${boxes.length} chosen`; };
  list.addEventListener('change', update);
  update();
  const el = h('fieldset.admin-checks', {},
    legend ? h('legend', {}, legend) : null,
    items.length ? h('div.row.check-tools', {}, filter,
      h('button.btn.small', { type: 'button', onclick: () => { setAll(true); update(); } }, 'All'),
      h('button.btn.small', { type: 'button', onclick: () => { setAll(false); update(); } }, 'None'), count) : null,
    items.length ? list : h('p.caption', {}, empty));
  el.values = () => boxes.filter((b) => b.input.checked).map((b) => b.input.value);
  el.set = (values) => { const v = new Set(values); for (const b of boxes) b.input.checked = v.has(b.input.value); update(); };
  el.total = boxes.length;
  return el;
}

/** Radio buttons from [[value, text, hint], ...]; value() gives the chosen one or ''. */
export function radios(name, options, value = '') {
  const el = h('div.radio-col', { role: 'radiogroup' });
  for (const [v, text, hint] of options) {
    const input = h('input', { type: 'radio', name, value: v });
    input.checked = v === value;
    el.append(h('label.check', {}, input, h('span', {}, text, hint ? h('span.caption.block', {}, hint) : null)));
  }
  el.value = () => { const c = el.querySelector('input:checked'); return c ? c.value : ''; };
  el.set = (v) => { for (const i of el.querySelectorAll('input')) i.checked = i.value === v; };
  return el;
}

// ----------------------------------------------------------------- tables
/**
 * A table of rows with pages of `pageSize`: columns are {key, title, num, render(row) -> Node|string,
 * sort(row) -> value}. Rebuild it with update(rows).
 *
 * With `sortable`, a column with a key or a sort function is sorted by pressing its heading (again
 * for the other direction). With `selectable` (and `rowKey`), each row has a checkbox and the
 * heading one that ticks every row shown by the filters, on every page; selected() gives the keys
 * ticked and onSelect(keys) hears every change.
 */
export function dataTable(columns, rows = [], {
  empty = 'Nothing here yet.', pageSize = 25, rowKey = null, caption = '', sortable = false, selectable = false, onSelect = null, sort: firstSort = null,
} = {}) {
  const wrap = h('div.admin-table');
  let page = 0;
  let data = rows;
  let sort = firstSort; // {index, dir}
  const chosen = new Set();
  const valueOf = (c) => c.sort || (c.key ? (r) => r[c.key] : null);
  const ordered = () => {
    const c = sort ? columns[sort.index] : null;
    const f = c ? valueOf(c) : null;
    return f ? sortRows(data, f, sort.dir) : data;
  };
  const keys = () => data.map((r) => rowKey(r));
  const changed = () => { if (onSelect) onSelect(wrap.selected()); };
  const heading = (c, i) => {
    const can = sortable && c.title && valueOf(c);
    const on = Boolean(sort && sort.index === i);
    const th = h(`th${c.num ? '.num' : ''}`, { scope: 'col', 'aria-sort': can ? (on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') : null });
    if (!can) { th.append(c.title || h('span.sr-only', {}, 'Actions')); return th; }
    th.append(h(`button.th-sort${on ? '.on' : ''}`, { type: 'button', 'data-col': String(i), title: `Sort by ${c.title.toLowerCase()}`,
      onclick: () => {
        sort = { index: i, dir: on && sort.dir === 'asc' ? 'desc' : 'asc' };
        page = 0;
        render();
        const b = wrap.querySelector(`button.th-sort[data-col="${i}"]`);
        if (b) b.focus();
      } }, c.title, icon(on && sort.dir === 'desc' ? 'chevron-down' : 'chevron-up')));
    return th;
  };
  const render = () => {
    clear(wrap);
    if (!data.length) { wrap.append(h('p.caption.empty', {}, empty)); return; }
    const pages = Math.max(1, Math.ceil(data.length / pageSize));
    page = Math.min(page, pages - 1);
    const shown = ordered().slice(page * pageSize, (page + 1) * pageSize);
    let all = null;
    if (selectable) {
      all = h('input', { type: 'checkbox', 'data-select-all': '', 'aria-label': `Select all ${data.length} shown` });
      const n = keys().filter((k) => chosen.has(k)).length;
      all.checked = n > 0 && n === data.length;
      all.indeterminate = n > 0 && n < data.length;
      all.addEventListener('change', () => {
        for (const k of keys()) { if (all.checked) chosen.add(k); else chosen.delete(k); }
        render();
        changed();
        const again = wrap.querySelector('input[data-select-all]');
        if (again) again.focus();
      });
    }
    const rowBox = (r) => {
      const k = rowKey(r);
      const box = h('input', { type: 'checkbox', 'data-select': k, 'aria-label': `Select ${k.split('|').pop()}` });
      box.checked = chosen.has(k);
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(k); else chosen.delete(k);
        const n = keys().filter((x) => chosen.has(x)).length;
        all.checked = n > 0 && n === data.length;
        all.indeterminate = n > 0 && n < data.length;
        box.closest('tr').classList.toggle('chosen', box.checked);
        changed();
      });
      return h('td.pick', { 'data-title': '' }, box);
    };
    const table = h('table.list.admin-list', {},
      caption ? h('caption.sr-only', {}, caption) : null,
      h('thead', {}, h('tr', {}, selectable ? h('th.pick', { scope: 'col' }, all) : null, columns.map(heading))),
      h('tbody', {}, shown.map((r) => h(`tr${selectable && chosen.has(rowKey(r)) ? '.chosen' : ''}`, { 'data-key': rowKey ? rowKey(r) : null },
        selectable ? rowBox(r) : null,
        columns.map((c) => h(`td${c.num ? '.num' : ''}${c.cls ? `.${c.cls}` : ''}`, { 'data-title': c.title }, c.render ? c.render(r) : String(r[c.key] ?? '')))))));
    wrap.append(h('div.table-scroll', {}, table));
    if (pages > 1) {
      const prev = h('button.btn.small', { type: 'button', disabled: page === 0, onclick: () => { page -= 1; render(); } }, icon('arrow-left'), 'Previous');
      const next = h('button.btn.small', { type: 'button', disabled: page >= pages - 1, onclick: () => { page += 1; render(); } }, 'Next', icon('arrow-right'));
      wrap.append(h('div.row.pager', {}, prev, h('span.caption', {}, `Page ${page + 1} of ${pages} · ${data.length} in all`), next));
    }
  };
  wrap.update = (next, { keepPage = false } = {}) => {
    data = next || [];
    if (!keepPage) page = 0;
    if (selectable) {
      const present = new Set(keys());
      for (const k of [...chosen]) if (!present.has(k)) chosen.delete(k);
    }
    render();
    if (selectable) changed();
  };
  /** The keys of the rows ticked, in the order shown. */
  wrap.selected = () => (selectable ? ordered().map((r) => rowKey(r)).filter((k) => chosen.has(k)) : []);
  wrap.selectedRows = () => (selectable ? ordered().filter((r) => chosen.has(rowKey(r))) : []);
  wrap.clearSelection = () => { chosen.clear(); render(); changed(); };
  /** The rows in the order shown (for downloads). */
  wrap.rows = () => ordered();
  render();
  return wrap;
}

/** A thin bar for a share (0 to 1) with the percentage beside it. */
export function shareBar(fraction) {
  if (fraction === null || fraction === undefined || !Number.isFinite(Number(fraction))) return h('span.caption', {}, '–');
  const pct = Math.round(Math.max(0, Math.min(1, Number(fraction))) * 100);
  return h('span.share', {}, h('span.share-text.num', {}, `${pct}%`),
    h('span.share-bar', { 'aria-hidden': 'true' }, h('span.share-fill', { style: { width: `${pct}%` } })));
}

// ------------------------------------------------------------ actions on many
/**
 * Run fn(item) for each item in turn (never at once, so that a slow study is not flooded and each
 * answer is known), showing how far it has got in `progress`. Resolves with one result per item:
 * {item, ok, value} or {item, ok: false, error}. When the study cannot be reached or the sign-in
 * has ended, the rest are left untried ({item, ok: false, skipped: true}).
 */
export async function eachInTurn(items, fn, { progress = null, words = (i, n) => `${i} of ${n}…` } = {}) {
  const results = [];
  let stop = false;
  for (let i = 0; i < items.length; i++) {
    if (stop) { results.push({ item: items[i], ok: false, skipped: true }); continue; }
    if (progress) progress.set(i / items.length, words(i + 1, items.length, items[i]));
    try {
      results.push({ item: items[i], ok: true, value: await fn(items[i]) });
    } catch (exc) {
      results.push({ item: items[i], ok: false, error: exc });
      if (exc && (exc.status === 0 || exc.status === 401)) stop = true;
    }
  }
  if (progress) progress.hide();
  return results;
}

/** A table of what happened to each item: its name, Done or Not done, and the reason. */
export function resultsTable(results, { name, done = () => 'Done', caption = 'What happened to each', title = 'Item' }) {
  const rows = results.map((r, i) => ({ ...r, i }));
  return dataTable([
    { title, render: (r) => name(r.item) },
    { title: 'Result', render: (r) => (r.ok ? chip('Done', 'done') : r.skipped ? chip('Not tried') : chip(r.kept ? 'Kept' : 'Not done', 'warning')) },
    { title: 'Details', render: (r) => (r.ok ? done(r) : r.skipped ? 'Not tried, because the study could not be reached.' : problemText(r.error)) },
  ], rows, { pageSize: 50, caption, rowKey: (r) => String(r.i) });
}

/** A small key/value table. */
export function infoTable(pairs) {
  return h('table.info.admin-info', {}, h('tbody', {}, pairs.filter(Boolean).map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, v)))));
}

// ------------------------------------------------------ confirmation in the page
/**
 * Replace `host`'s contents with a question and two buttons until it is answered: the safe
 * choice first and focused, the action after it. Resolves true when the action was chosen.
 */
export function confirmInline(host, { text, yes, no = 'Cancel', destructive = true }) {
  return new Promise((resolve) => {
    const kept = [...host.childNodes];
    let answered = false;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } };
    const done = (value) => {
      if (answered) return;
      answered = true;
      host.removeEventListener('keydown', onKey);
      clear(host);
      host.append(...kept);
      host.classList.remove('confirming');
      resolve(value);
    };
    const noBtn = h('button.btn', { type: 'button', onclick: () => done(false) }, no);
    const yesBtn = h(`button.btn${destructive ? '.destructive' : '.primary'}`, { type: 'button', onclick: () => done(true) }, yes);
    clear(host);
    host.classList.add('confirming');
    host.append(h('div.confirm-strip', { role: 'alertdialog', 'aria-label': text },
      h('p', {}, text), h('div.btn-row', {}, noBtn, yesBtn)));
    host.addEventListener('keydown', onKey);
    noBtn.focus();
  });
}

// ---------------------------------------------------------------- copying
export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall back below */ }
  try {
    const t = h('textarea', { style: { position: 'fixed', left: '-1000px', top: '0' } });
    t.value = text;
    document.body.append(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  } catch { return false; }
}

export function copyButton(text, { label = 'Copy' } = {}) {
  const b = h('button.btn.small', { type: 'button', 'data-copy': '' }, label);
  b.addEventListener('click', async () => {
    const ok = await copyText(text);
    b.textContent = ok ? 'Copied' : 'Select it and copy';
    setTimeout(() => { b.textContent = label; }, 2500);
  });
  return b;
}

/** Something to pass on once (a temporary password or an invitation link), with a copy button. */
export function secretBox({ title, value, note }) {
  const out = h('output.secret-value', {}, value);
  return h('div.success.secret', { role: 'status' },
    h('p', {}, h('b', {}, title)),
    h('div.row.secret-row', {}, out, copyButton(value)),
    note ? h('p.caption', {}, note) : null);
}

// -------------------------------------------------------------- downloads
export function downloadText(name, text, type = 'text/plain;charset=utf-8') {
  downloadFiles([{ name, blob: new Blob([text], { type }) }]);
}

export function downloadBase64(name, b64, type = 'application/octet-stream') {
  downloadFiles([{ name, blob: new Blob([base64ToBytes(b64)], { type }) }]);
}

// ------------------------------------------------------------------ reports
/**
 * The application's typeface as a style rule with the font inside it (a data URL), for reports in
 * a sandboxed frame, which cannot load the font file itself. Read once; '' if it cannot be read.
 */
let reportFontCss = null;
function reportFont() {
  if (!reportFontCss) {
    reportFontCss = fetch(new URL('../../fonts/Newsreader-Variable.woff2', import.meta.url))
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((blob) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      }))
      .then((url) => `<style>@font-face{font-family:"Newsreader";src:url(${url}) format("woff2");font-weight:400 600;font-style:normal}</style>`)
      .catch(() => '');
  }
  return reportFontCss;
}

/** The report's page with the typeface added at the start of its head. */
export function withReportFont(html, css) {
  const page = String(html || '');
  if (!css) return page;
  const head = /<head[^>]*>/i.exec(page);
  return head ? page.slice(0, head.index + head[0].length) + css + page.slice(head.index + head[0].length) : css + page;
}

/**
 * A report written by the study (agreement, activity, competency) in a sandboxed frame: its own
 * scripts may draw its charts, but it has no access to this page, its sign-in or its storage. The
 * report names Newsreader, which the frame receives with the page, so that the report is set in the
 * application's typeface; a downloaded report keeps to the fonts of the computer it is opened on.
 */
export function reportFrame(html, title) {
  const frame = h('iframe.report-frame', { title, sandbox: 'allow-scripts', referrerpolicy: 'no-referrer' });
  // The font is read once; the report waits for it at most briefly, then shows without it.
  const wait = new Promise((resolve) => setTimeout(() => resolve(''), 1500));
  Promise.race([reportFont(), wait]).then((css) => { frame.srcdoc = withReportFont(html, css); });
  return frame;
}

/** In-page tabs: items [{key, title}]; onSelect(key). The arrow keys move between them. */
export function tabBar(items, onSelect, current = null) {
  const bar = h('div.tabs.admin-tabs', { role: 'tablist' });
  const buttons = items.map((it) => h('button.tab', { type: 'button', role: 'tab', 'data-tab': it.key, 'aria-selected': 'false', tabindex: '-1',
    onclick: () => select(it.key, true) }, it.title));
  const select = (key, focus = false) => {
    for (const b of buttons) {
      const on = b.dataset.tab === key;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    onSelect(key);
  };
  bar.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const i = buttons.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    const n = buttons.length;
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
    e.preventDefault();
    select(buttons[j].dataset.tab, true);
  });
  bar.append(...buttons);
  bar.select = select;
  if (current) setTimeout(() => select(current), 0);
  return bar;
}

/** A bar that moves while a long operation runs; set(fraction|null, text). */
export function progressLine() {
  const bar = h('span.progress-bar');
  const text = h('span.caption');
  const el = h('div.admin-progress', { role: 'status', 'aria-live': 'polite', hidden: true }, text, h('span.progress', {}, bar));
  el.set = (fraction, words) => {
    el.hidden = false;
    text.textContent = words || '';
    el.classList.toggle('indeterminate', fraction === null || fraction === undefined);
    bar.style.width = fraction === null || fraction === undefined ? '35%' : `${Math.round(fraction * 100)}%`;
  };
  el.hide = () => { el.hidden = true; };
  return el;
}

/** "Working… 12 s": a timer for operations without progress of their own (the analyses). */
export function elapsedTimer(el, words) {
  const t0 = Date.now();
  const tick = () => el.set(null, `${words} ${Math.round((Date.now() - t0) / 1000)} s`);
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}
