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
import { feedbackCaption, moreButton, returnedLine } from './home_feedback.js';
import { inform } from '../ui/dialog.js';

export const PAGE_SIZE = 25;
const PREFS_KEY = 'electrotag.home.list';
const STATUS = { todo: ['To do', ''], in_progress: ['In progress', 'active'], done: ['Done', 'done'], unusable: ['Cannot be annotated', ''],
  locked: ['Locked', ''] }; // locked: real study work waits for the competency assessment (GET /me training_gate)
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

/**
 * The experts' corrections of the annotator's work (GET /me/feedback, when the study shows them), asked for
 * once for each list of assignments; `redraw` draws the list again when they arrive. [] until then.
 */
export function correctionsOf(app, redraw = null) {
  const r = app.me && app.me.study && app.me.study.review;
  const corrections = !(r && r.show_corrections_to_annotators === false);
  if ((!corrections && r && r.show_outcomes_to_annotators === false) || !app.backend || !app.backend.myFeedback) return [];
  const kept = app.corrections;
  if (!kept || kept.for !== app.assignments) {
    const mine = { for: app.assignments, items: kept ? kept.items : [], outcomes: kept ? kept.outcomes : [] };
    app.corrections = mine;
    app.backend.myFeedback().then((fb) => {
      if (app.corrections !== mine) return;
      mine.items = (corrections && fb && fb.corrections && fb.corrections.shown && fb.corrections.items) || [];
      mine.outcomes = (fb && fb.adjudications && fb.adjudications.shown && fb.adjudications.items) || []; // decisions on disagreements
      if (redraw && (mine.items.length || mine.outcomes.length)) redraw();
    }, () => { /* the list works without them */ });
  }
  return app.corrections.items;
}

/** "Adjudicated: 9 of 17 places as you had them" for a recording whose disagreements were decided, or ''. */
export function adjudicatedText(outcomes, recordingId) {
  const conflicts = (outcomes || []).filter((o) => o.recording_id === recordingId).flatMap((o) => o.conflicts || []);
  if (!conflicts.length) return '';
  const stood = conflicts.filter((c) => ['yours_kept', 'all_kept'].includes(c.decision && c.decision.outcome)).length;
  return `Adjudicated: ${stood} of ${conflicts.length} disagreement${conflicts.length === 1 ? '' : 's'} decided as you had ${conflicts.length === 1 ? 'it' : 'them'}`;
}

/** The history's line about the adjudication of a recording: it opens the decisions, on the home page. */
function adjudicatedCaption(app, it) {
  const text = (it.mode || 'standard') === 'standard' ? adjudicatedText(app.corrections && app.corrections.outcomes, it.recording_id) : '';
  if (!text) return null;
  return h('button.link.caption.block.adjudicated-line', { type: 'button', 'data-adjudicated': it.recording_id, 'data-log': 'adjudicated-line',
    title: 'See the decisions', onclick: () => {
      const d = document.querySelector(`.outcomes-card details[data-recording="${CSS.escape(it.recording_id)}"]`);
      if (!d) return;
      d.open = true;
      d.scrollIntoView({ block: 'start' });
      d.querySelector('summary')?.focus({ preventScroll: true });
    } }, text);
}

/** The corrections of one recording of the list, newest first. */
export function correctionsFor(app, it) {
  return (app.corrections && app.corrections.items || []).filter((c) => c.recording_id === it.recording_id && (it.mode || 'standard') === 'standard');
}

/** Who corrected the version and how many changes there are ("Corrected by E01: 3 changes"), as it stands (expert/settled.js), or null. */
export function correctedText(list) {
  if (!list || !list.length) return null;
  const c = list[0];
  const names = (people) => {
    const n = (people || []).map((p) => p.corrector_name || p.corrector_id);
    return n.length <= 1 ? n[0] || '' : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  };
  const n = Object.values(c.counts || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const changes = `${n} change${n === 1 ? '' : 's'}`;
  if (c.standing === 'pending') return `Corrected by ${names(c.correctors)}, who disagree in places: the study is settling it`;
  if (c.standing === 'adjudicated') {
    const a = c.adjudication || {};
    return `Corrected by ${names(c.correctors)}, settled by ${a.adjudicator_name || a.adjudicator_id || 'an expert'}: ${changes}`;
  }
  return `Corrected by ${c.corrector_name || c.corrector_id}: ${changes}${list.length > 1 ? ` (${list.length} corrections)` : ''}`;
}

/** The annotator opens the latest correction of a recording: its file from this computer, then the corrected version beside theirs. */
export async function openCorrection(app, it, c) {
  let target;
  try {
    target = await app.backend.expert('my_correction_get', { correction_id: c.correction_id });
  } catch (exc) {
    if (exc.status !== 401) await inform(exc.code === 'pending_adjudication' ? 'The experts disagree' : 'The correction cannot be shown', exc.message);
    return null;
  }
  const who = target.standing === 'adjudicated' ? `${(target.correctors || []).map((p) => p.corrector_name || p.corrector_id).join(' and ')} corrected your version ${target.attempt}, and their disagreements were settled`
    : `${c.corrector_name || c.corrector_id} corrected your version ${c.attempt}`;
  return app.openFromComputer({ recording_id: it.recording_id, file_name: it.file_name, format: it.format }, { purpose: { kind: 'corrected', route: 'open', target,
    title: `See the correction of ${it.file_name}`,
    note: `${who}. Open the recording from this computer: the corrected version is shown read only, with yours beside it and the reason for each change.` } });
}

function correctedCaption(app, it, { card = false } = {}) {
  const list = correctionsFor(app, it);
  const text = correctedText(list);
  if (!text) return null;
  const c = list[0];
  if (c.standing === 'pending') {
    return h('span.caption.block.corrected-line.pending', { 'data-corrected': it.recording_id, title: 'You will see the corrected version once the study has settled where the experts disagree' }, text);
  }
  const line = h('button.link.caption.block.corrected-line', { type: 'button', 'data-corrected': it.recording_id, 'data-log': 'corrected-line',
    title: 'See the correction', onclick: () => openCorrection(app, it, c) }, text);
  if (c.standing !== 'adjudicated' || !card) return line;
  // the outcome card of the experts' disagreements, readable without the recording's file (expert/settled.js, loaded when needed)
  const host = h('span.settled-host', { 'data-corrected': it.recording_id });
  import('../expert/settled.js').then((m) => { const link = m.settledLink(c); if (link) host.append(link); else host.remove(); }).catch(() => host.remove());
  return [line, host];
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
  else if (tab === 'todo') list = list.filter(({ it }) => it.status !== 'done' && it.status !== 'unusable'); // everything still to do, started or not
  // a recording that cannot be annotated is finished for the annotator: it is listed with the done ones
  else if (tab === 'done') list = list.filter(({ it }) => it.status === 'done' || it.status === 'unusable');
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
      // Read aloud as "To do, 3 recordings" rather than "To do3".
      const n = count(k);
      tabs.append(h('button.tab', { type: 'button', role: 'tab', 'aria-selected': String(st.tab === k), 'data-tab': k, 'data-log': `recordings-tab-${k}`,
        'aria-label': `${t}, ${n} recording${n === 1 ? '' : 's'}`,
        onclick: () => { st.tab = k; st.page = 0; keep(); drawTabs(); draw(); } }, t, h('span.tab-count', { 'aria-hidden': 'true' }, String(n))));
    }
  };

  const action = (it) => {
    if (it.status === 'unusable' || it.status === 'locked') return null;
    if (it.status === 'done') {
      if (!canRevise(app, it)) return null;
      const text = it.revising ? 'Continue the revision' : 'Open to revise';
      return h('button.btn.small', { type: 'button', 'data-log': 'open-to-revise', 'aria-label': `${text}: ${it.file_name}`, onclick: () => app.openAssignment(it, { revise: true }) }, text);
    }
    // Each row's button names its recording for screen readers ("Open sub-001_task-rest_eeg.edf").
    const text = it.status === 'in_progress' ? 'Continue' : 'Open';
    return h('button.btn.small', { type: 'button', 'aria-label': `${text} ${it.file_name}`, onclick: () => app.openAssignment(it) }, text);
  };

  const listRow = (it) => {
    const [text, cls] = it.revising ? ['Being revised', 'active'] : STATUS[it.status] || [it.status, ''];
    return h('tr', { 'data-id': it.recording_id, 'data-log-text': it.file_name },
      h('td', {}, h('span.file', { title: it.recording_id }, it.file_name), feedbackCaption(app, it), correctedCaption(app, it), adjudicatedCaption(app, it),
        it.status === 'locked' ? h('span.caption.locked-why', {}, 'Opens once you pass the competency assessment.') : null),
      showMode ? h('td.opt', {}, MODES[it.mode] || it.mode) : null,
      h('td.num', {}, formatHms(it.duration_s)),
      h('td.num.opt', {}, String(it.n_channels)),
      h('td', {}, h(`span.chip${cls ? `.${cls}` : ''}`, {}, text)),
      h('td.actions', {}, h('span.row-actions', {}, action(it), moreButton(app, it))));
  };

  const historyRow = (it) => {
    const s = savedOf(it) || {};
    return h('tr', { 'data-id': it.recording_id, 'data-log-text': it.file_name },
      h('td.name', {}, h('span.file-line', { title: it.recording_id }, it.file_name),
        h('span.caption.when', {}, `Saved ${savedText(s.saved_at)}${it.revising ? ' · revision under way' : ''}`), feedbackCaption(app, it), correctedCaption(app, it, { card: true }),
        adjudicatedCaption(app, it)),
      h('td.num', {}, String(s.version || 1)),
      h('td.num.opt', {}, s.n_annotations === null || s.n_annotations === undefined ? 'n/a' : String(s.n_annotations)),
      h('td.num.opt', {}, s.elapsed_s === null || s.elapsed_s === undefined ? 'n/a' : spanText(s.elapsed_s)),
      h('td.actions', {}, h('span.row-actions', {}, action(it), moreButton(app, it))));
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
  correctionsOf(app, () => { if (body.isConnected) draw(); });
  draw();

  return h('section.card.recordings-card', { 'data-section': 'recordings' },
    h('h2', {}, 'Your recordings'),
    returnedLine(app),
    items.length
      ? [tabs, h('div.rec-tools', {}, search, h('label.rec-sort-label', {}, h('span.caption', {}, 'Sort'), sort)), body]
      : h('p.caption', {}, 'Your study team assigns recordings to you.'),
    h('div.btn-row', {}, h('button.btn.quiet', { type: 'button', onclick: () => app.openFromComputer(null) }, 'Open a recording from your computer…')));
}
