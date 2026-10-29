// The home page's list of recordings, made for a couple of hundred of them: tabs (To do, which
// holds everything not yet done, In progress, Done, All, and History, what the annotator has
// saved, newest first), a search by file
// name, sorting, and pages of PAGE_SIZE rows, so that only one page is ever in the document. Done
// study recordings can be opened again to revise them when the study allows it
// (docs/web/using.md, "History and revisions").
//
// The choices (tab, sort, search, page) are kept on the application for the visit and the tab and
// sort in this browser, as a convenience; nothing depends on them being there.

import { h, clear } from '../ui/dom.js';
import { formatHms, local } from '../util.js';
import { spanText } from './progress.js';

export const PAGE_SIZE = 25;
const PREFS_KEY = 'electrotag.home.list';
const STATUS = { todo: ['To do', ''], in_progress: ['In progress', 'active'], done: ['Done', 'done'] };
const MODES = { standard: 'Annotation', guided: 'Guided training', practice: 'Practice', assessment: 'Assessment' };
export const TABS = [['todo', 'To do'], ['in_progress', 'In progress'], ['done', 'Done'], ['all', 'All'], ['history', 'History']];
export const SORTS = [['recent', 'Recently worked on'], ['name', 'File name'], ['length', 'Length']];

/**
 * What the history shows of an item (GET /assignments): the latest attempt's `completed_at`,
 * `n_annotations` and `elapsed_s`, and from `saved` its version and the time of every version
 * together; null for an item never saved.
 */
export function savedOf(it) {
  const s = it && it.saved && typeof it.saved === 'object' ? it.saved : null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (!s && it && it.status !== 'done') return null;
  return {
    version: (s && num(s.version)) || 1,
    saved_at: (it && it.completed_at) || null,
    n_annotations: num(it && it.n_annotations),
    elapsed_s: (s ? num(s.total_elapsed_s) : null) ?? num(it && it.elapsed_s),
  };
}

/** True when a done item may be opened again to revise it. */
export function canRevise(app, it) {
  const ann = app.me && app.me.study && app.me.study.annotation;
  return Boolean(ann && ann.allow_revisions) && it.status === 'done' && it.mode === 'standard';
}

function time(it) {
  const s = savedOf(it);
  const t = s && s.saved_at ? new Date(s.saved_at).getTime() : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * The rows of one tab, searched and sorted: `items` from GET /assignments. "Recently worked on"
 * puts recordings in progress (and revisions under way) first, then the most recently saved, then
 * the rest in the order they were assigned. The history is newest first unless sorted otherwise.
 */
export function visibleItems(items, { tab = 'todo', query = '', sort = 'recent' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  let list = items.map((it, i) => ({ it, i }));
  if (tab === 'history') list = list.filter(({ it }) => it.status === 'done' || (it.saved && typeof it.saved === 'object'));
  else if (tab === 'todo') list = list.filter(({ it }) => it.status !== 'done'); // everything still to do, started or not
  else if (tab !== 'all') list = list.filter(({ it }) => it.status === tab);
  if (q) list = list.filter(({ it }) => String(it.file_name || '').toLowerCase().includes(q) || String(it.recording_id || '').toLowerCase().includes(q));
  const busy = ({ it }) => (it.status === 'in_progress' || it.revising ? 0 : 1);
  const cmp = {
    recent: (a, b) => busy(a) - busy(b) || time(b.it) - time(a.it) || a.i - b.i,
    name: (a, b) => String(a.it.file_name).localeCompare(String(b.it.file_name), 'en-GB', { numeric: true }) || a.i - b.i,
    length: (a, b) => (Number(a.it.duration_s) || 0) - (Number(b.it.duration_s) || 0) || a.i - b.i,
  }[sort] || (() => 0);
  return list.sort(cmp).map(({ it }) => it);
}

/** The rows of page `page` (from 0), with the page actually shown and the number of pages. */
export function pageOf(rows, page, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  return { rows: rows.slice(p * size, p * size + size), page: p, pages, from: rows.length ? p * size + 1 : 0, to: Math.min(rows.length, p * size + size) };
}

function savedText(iso) {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'n/a';
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

function listState(app) {
  if (!app.homeList) {
    const kept = local.get(PREFS_KEY, null) || {};
    app.homeList = { tab: TABS.some(([k]) => k === kept.tab) ? kept.tab : null, sort: SORTS.some(([k]) => k === kept.sort) ? kept.sort : 'recent', query: '', page: 0 };
  }
  return app.homeList;
}

/** The "Your recordings" card. */
export function recordingsCard(app) {
  const items = (app.assignments && app.assignments.items) || [];
  const st = listState(app);
  const count = (k) => visibleItems(items, { tab: k }).length;
  if (!st.tab) st.tab = count('todo') ? 'todo' : items.length ? 'history' : 'todo';
  const showMode = items.some((i) => i.mode !== 'standard');

  const body = h('div.rec-body');
  const tabs = h('div.rec-tabs.tabs', { role: 'tablist', 'aria-label': 'Which recordings' });
  const search = h('input.field.rec-search', { type: 'search', placeholder: 'Search by file name', 'aria-label': 'Search by file name', value: st.query, spellcheck: 'false', autocomplete: 'off' });
  const sort = h('select.field.rec-sort', { 'aria-label': 'Sort by' }, SORTS.map(([k, t]) => h('option', { value: k, selected: k === st.sort }, t)));
  const keep = () => local.set(PREFS_KEY, { tab: st.tab, sort: st.sort });

  const drawTabs = () => {
    clear(tabs);
    for (const [k, t] of TABS) {
      tabs.append(h('button.tab', { type: 'button', role: 'tab', 'aria-selected': String(st.tab === k), 'data-tab': k, 'data-log': `recordings-tab-${k}`,
        onclick: () => { st.tab = k; st.page = 0; keep(); drawTabs(); draw(); } }, t, h('span.tab-count', {}, String(count(k)))));
    }
  };

  const action = (it) => {
    if (it.status === 'done') {
      if (!canRevise(app, it)) return null;
      return h('button.btn.small', { type: 'button', 'data-log': 'open-to-revise', onclick: () => app.openAssignment(it, { revise: true }) },
        it.revising ? 'Continue the revision' : 'Open to revise');
    }
    return h('button.btn.small', { type: 'button', onclick: () => app.openAssignment(it) }, it.status === 'in_progress' ? 'Continue' : 'Open');
  };

  const listRow = (it) => {
    const [text, cls] = it.revising ? ['Being revised', 'active'] : STATUS[it.status] || [it.status, ''];
    return h('tr', { 'data-id': it.recording_id, 'data-log-text': it.file_name },
      h('td', {}, h('span.file', { title: it.recording_id }, it.file_name)),
      showMode ? h('td.opt', {}, MODES[it.mode] || it.mode) : null,
      h('td.num', {}, formatHms(it.duration_s)),
      h('td.num.opt', {}, String(it.n_channels)),
      h('td', {}, h(`span.chip${cls ? `.${cls}` : ''}`, {}, text)),
      h('td.actions', {}, action(it)));
  };

  const historyRow = (it) => {
    const s = savedOf(it) || {};
    return h('tr', { 'data-id': it.recording_id, 'data-log-text': it.file_name },
      h('td.name', {}, h('span.file-line', { title: it.recording_id }, it.file_name),
        h('span.caption.when', {}, `Saved ${savedText(s.saved_at)}${it.revising ? ' · revision under way' : ''}`)),
      h('td.num', {}, String(s.version || 1)),
      h('td.num.opt', {}, s.n_annotations === null || s.n_annotations === undefined ? 'n/a' : String(s.n_annotations)),
      h('td.num.opt', {}, s.elapsed_s === null || s.elapsed_s === undefined ? 'n/a' : spanText(s.elapsed_s)),
      h('td.actions', {}, action(it)));
  };

  const pager = (pg, total) => {
    if (pg.pages <= 1) return null;
    const go = (p) => { st.page = p; draw(); body.scrollIntoView({ block: 'nearest' }); };
    return h('div.rec-pager', {},
      h('span.caption', { 'aria-live': 'polite' }, `${pg.from} to ${pg.to} of ${total}`),
      h('div.btn-row', {},
        h('button.btn.small', { type: 'button', 'data-log': 'recordings-previous', disabled: pg.page === 0, onclick: () => go(pg.page - 1) }, 'Previous'),
        h('span.caption', {}, `Page ${pg.page + 1} of ${pg.pages}`),
        h('button.btn.small', { type: 'button', 'data-log': 'recordings-next', disabled: pg.page >= pg.pages - 1, onclick: () => go(pg.page + 1) }, 'Next')));
  };

  const draw = () => {
    clear(body);
    const rows = visibleItems(items, st);
    const pg = pageOf(rows, st.page);
    st.page = pg.page;
    if (!rows.length) {
      const why = st.query ? `No recording's file name contains "${st.query}".`
        : { todo: 'Nothing left to start.', in_progress: 'Nothing in progress.', done: 'Nothing finished yet.', all: 'No recordings yet.',
          history: 'Recordings you save appear here, newest first, so that you can come back to them.' }[st.tab];
      body.append(h('p.caption.rec-empty', {}, why));
      return;
    }
    const history = st.tab === 'history';
    const head = history
      ? h('tr', {}, h('th.name', {}, 'File and when it was saved'), h('th.num.version', {}, 'Version'), h('th.num.opt.count', {}, 'Annotations'),
        h('th.num.opt.time', {}, 'Time worked'), h('th.act', {}))
      : h('tr', {}, h('th', {}, 'File'), showMode ? h('th.opt', {}, 'Mode') : null, h('th.num', {}, 'Length'), h('th.num.opt', {}, 'Channels'), h('th', {}, 'Status'), h('th', {}, h('span.sr-only', {}, 'Actions')));
    body.append(h(`table.list${history ? '.history' : ''}`, { 'data-tab': st.tab }, h('thead', {}, head), h('tbody', {}, pg.rows.map(history ? historyRow : listRow))));
    const pages = pager(pg, rows.length);
    if (pages) body.append(pages);
  };

  let typing = null;
  search.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => { st.query = search.value; st.page = 0; draw(); }, 150);
  });
  sort.addEventListener('change', () => { st.sort = sort.value; st.page = 0; keep(); draw(); });
  drawTabs();
  draw();

  return h('section.card.recordings-card', { 'data-section': 'recordings' },
    h('h2', {}, 'Your recordings'),
    items.length
      ? [tabs, h('div.rec-tools', {}, search, h('label.rec-sort-label', {}, h('span.caption', {}, 'Sort'), sort)), body]
      : h('p.caption', {}, 'Your study team assigns recordings to you.'),
    h('div.btn-row', {}, h('button.btn.quiet', { type: 'button', onclick: () => app.openFromComputer(null) }, 'Open a recording from your computer…')));
}
