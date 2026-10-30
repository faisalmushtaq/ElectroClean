// Everyone's marks on one recording (docs/web/admin.md, "Everyone's marks on one recording";
// docs/web/using.md, "How everyone marked a training recording"): the saved marks of many people over
// the same EEG, in a view-only annotation view of kind 'overlay'. Up to eight people have lanes of
// their own above the EEG, each with a colour that stays distinct for colour-blind readers, a pattern
// as a second cue and their ID on every mark, and their marks outlined on the EEG in the same colour
// and line pattern. Everyone else is the crowd: a band under each channel, and a lane for the
// whole-montage marks, shaded by the share of the crowd that marked each moment. Hovering a band says
// the share, the types chosen and who; a click lists everyone there, and Show in a lane promotes one
// of them. The side panel holds the legend, the filters (type, role, saved date, and the study's own
// facets such as groups or experience bands, when it has them), the people in the crowd, the
// disagreements (N and P) and Download the summary (TSV).
//
// A trainee may see a crowd only, with nobody named, on the training recordings for learning with the
// experts, when the study allows it (overlay_get checks this on the server); then there are no lanes.
//
// The marks come from overlay_get (js/expert/crowd.js decodes them and does the counting); the view is
// logged as overlay_opened, overlay_lane (a person added or removed), overlay_filter,
// overlay_disagreement and overlay_closed, with counts and IDs only.

import { h, clear } from '../ui/dom.js';
import { showDialog, inform } from '../ui/dialog.js';
import { logger, keyName } from '../log/logger.js';
import { COLOURS } from '../ui/theme.js';
import { rgba, touchFirst } from '../util.js';
import { downloadText, select } from '../admin/ui.js';
import { isHelpKey, showKeySheet } from './key_sheet.js';
import { Lanes } from './lanes.js';
import { UNCERTAIN_LABEL, UNCERTAIN_TEXT, needsReview } from '../catalogue.js';
import {
  CrowdBands, LANE_COLOURS, LANE_DASHES, LANE_PATTERNS, MAX_LANES, NO_FILTERS, PATTERN_WORDS, asAnnotation, crowdOf, decode, disagreements,
  laneInk, markPasses, patternCss, personName, shortName, stepDisagreement, summaryTsv, typeCounts, whoAt,
} from './crowd.js';

const MAX_LISTED = 40;
const MAX_PAGES = 20;
const ROLE_WORDS = { annotator: 'Annotators', expert: 'Experts', admin: 'Administrators' };

/** The overlay's keys, for its key sheet (?). */
export const OVERLAY_KEYS = Object.freeze([
  { title: 'Moving', rows: [['N / P', 'the next or previous disagreement, as in the other expert views'], ['Left arrow / Right arrow', 'through the recording'], ['?', 'this list of keys']] },
  { title: 'The crowd', rows: [['Pointer on a band', 'the share of the crowd, the types and who'], ['Click on a band', 'everyone who marked that moment, to show one in a lane']] },
]);

/** Back where the overlay was opened from: a section of the expert area, or of the admin area (a route admin-…). */
export function goBack(app, back) {
  if (String(back.route).startsWith('admin')) return app.showAdmin(back.route, back.params || null);
  return app.showExpert(back.route, back.params || null);
}

/** Every page of overlay_get (reads, which may be asked again after a failure). */
export async function loadOverlay(backend, body) {
  const first = await backend.expert('overlay_get', body);
  const pages = [];
  let next = first.next_offset;
  for (let i = 0; i < MAX_PAGES && next !== null && next !== undefined; i++) {
    const page = await backend.expert('overlay_get', { ...body, offset: next });
    pages.push(page);
    next = page.next_offset;
  }
  return { ...first, pages };
}

/**
 * Open the overlay of everyone's marks on a recording: the marks are read, then the EEG file is opened from
 * this computer (purpose overlay). `focus` are the people to put in lanes first; `back` is where it returns
 * ({route, params}), or null for a trainee (home).
 */
export async function startOverlay(app, { recording_id: rid, mode = 'standard', context_id: ctx = '', focus = [], include = [], at = null }, back = null) {
  const body = { recording_id: rid, ...(mode && mode !== 'standard' ? { mode, context_id: ctx } : {}), ...(include.length ? { include } : {}),
    ...(focus.length ? { detail: focus.slice(0, MAX_LANES) } : {}) };
  let target;
  const t0 = performance.now();
  void loadStyles();
  try {
    target = await loadOverlay(app.backend, body);
  } catch (exc) {
    if (exc.status !== 401) await inform('Everyone\'s marks cannot be shown', exc.message);
    return null;
  }
  target = { ...target, focus, include, body, at, loadMs: performance.now() - t0 };
  const m = target.manifest || {};
  const n = target.total;
  return app.openFromComputer({ recording_id: rid, file_name: target.file_name, format: m.format }, { purpose: { kind: 'overlay', route: back ? 'expert-overlay' : 'open', target, back,
    onBack: back ? () => goBack(app, back) : null,
    title: `Everyone's marks on ${target.file_name}`,
    note: `${n ? `${n} ${n === 1 ? 'person has' : 'people have'} saved this recording${target.anonymous ? '; nobody is named' : ''}.` : 'Nobody has saved this recording yet.'} `
      + 'Open the recording from this computer: its fingerprint is checked against the study\'s copy, then everyone\'s marks are shown over the EEG.' } });
}

/** Open the overlay for a file checked against the study's copy (js/views/purposes.js, purpose overlay). */
export async function openOverlay(app, { recording, fp, view, target }) {
  const parts = await app._openingParts(['session', 'workspace'], () => openOverlay(app, { recording, fp, view, target }));
  await loadStyles();
  if (!parts || !app._stillOpen(view)) return null;
  const [{ AnnotationSession }, { Workspace }] = parts;
  let session;
  try {
    session = new AnnotationSession({ backend: app.backend, recording, manifest: target.manifest, recordingId: target.recording_id, mode: target.mode || 'standard',
      contextId: target.context_id || '', me: app.me, catalogue: app.catalogue, sha256: fp.hex, readOnly: true });
  } catch (exc) {
    view.showProblem(exc.message, [view.chooseAgainButton()]);
    return null;
  }
  if (app.ws) app.ws.destroy();
  const back = view.purpose.back || null;
  const leave = async (ws) => {
    if (!(back && back.route)) { await app.leaveRecording(ws, 'overlay closed'); return; }
    ws.destroy();
    if (app.ws === ws) app.ws = null;
    await goBack(app, back);
  };
  const ws = new Workspace(app, session, { kind: 'overlay', onLeave: leave });
  app.ws = ws;
  app._render(ws.el, back && back.route ? 'expert-overlay' : 'annotate');
  ws.mount(app.content);
  return new OverlayView(ws, { target, app });
}

/**
 * The expert area's styles, which hold the overlay's rules (loaded once, as js/expert/area.js does), wherever it is
 * opened from: asked for before the file is chosen, and waited for before the view is drawn, so that the lanes do not
 * change size under the EEG once it is laid out.
 */
let stylesLoaded = null;
function loadStyles() {
  if (typeof document === 'undefined') return Promise.resolve();
  if (stylesLoaded) return stylesLoaded;
  const there = document.querySelector('link[data-expert-css]');
  if (there && (there.sheet || !there.dataset.loading)) { stylesLoaded = Promise.resolve(); return stylesLoaded; }
  const link = there || h('link', { rel: 'stylesheet', href: new URL('../../expert.css', import.meta.url).href, 'data-expert-css': '', 'data-loading': '' });
  stylesLoaded = new Promise((resolve) => {
    const done = () => { delete link.dataset.loading; resolve(); };
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    setTimeout(done, 5000); // drawn with whatever has arrived
  });
  if (!there) document.head.append(link);
  return stylesLoaded;
}

/** A lane's swatch: its colour and pattern, as in the lanes. */
function swatch(i) {
  const css = patternCss(LANE_PATTERNS[i], LANE_COLOURS[i]);
  return h('span.ov-swatch', { 'aria-hidden': 'true', style: css });
}

export class OverlayView {
  /**
   * @param {object} ws a view-only workspace of kind 'overlay'
   * @param {{target: object, app: object}} o target: overlay_get's answer with its later pages (startOverlay)
   */
  constructor(ws, { target, app }) {
    this.ws = ws;
    this.app = app;
    this.target = target;
    this.data = decode(target, target.pages || []);
    this.sf = this.data.sfreq;
    this.f = { ...NO_FILTERS, facets: {} };
    this.byKey = new Map(this.data.people.map((p) => [p.key, p]));
    this.chIndex = new Map(this.data.channels.map((c, i) => [c, i]));
    const saved = this.data.people.filter((p) => p.source === 'saved');
    const focus = (target.focus || []).filter((k) => this.byKey.has(k));
    this.laneKeys = this.data.anonymous ? [] : (focus.length ? focus : saved.length <= MAX_LANES ? saved.map((p) => p.key) : []).slice(0, MAX_LANES);
    this.search = '';
    this.current = -1;
    this.openedAt = performance.now();
    ws.pass = this;
    ws.keyHook = (e) => this.onKey(e);
    ws.el.classList.add('overlaying');
    this._foldTabs();
    const onView = ws.viewer.onView;
    ws.viewer.onView = (v, cause) => { if (onView) onView(v, cause); this._hideTip(); this._drawStrips(); };
    this._build();
    this._recount();
    if (Number.isFinite(target.at)) ws.viewer.setView({ startS: target.at - ws.viewer.view.durationS / 3 }, 'overlay');
    ws.onDestroy(() => this.destroy());
    logger.event('overlay_opened', { recording_id: this.data.recording_id, people: saved.length, lanes: this.laneKeys.length,
      anonymous: this.data.anonymous, load_ms: Math.round(target.loadMs || 0) });
  }

  /** The panel's tabs fold away to their bar (the overlay's panel needs the room) and open when pressed, as in the adjudication. */
  _foldTabs() {
    const tabs = this.ws.side && this.ws.side.querySelector('.side-tabs');
    if (!tabs) return;
    tabs.classList.add('folded');
    tabs.querySelector('.tabs')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      const open = !tabs.classList.contains('folded');
      tabs.classList.toggle('folded', open && b.getAttribute('aria-selected') === 'true' && this._lastTab === b.dataset.tab);
      this._lastTab = b.dataset.tab;
    });
  }

  // ---------------------------------------------------------------- who is where
  get lanePeople() { return this.laneKeys.map((k) => this.byKey.get(k)).filter(Boolean); }

  get crowd() { return crowdOf(this.data.people, this.laneKeys, this.f); }

  /** Everyone shown: the lanes and the crowd as filtered. */
  get shown() { return [...this.lanePeople, ...this.crowd]; }

  laneIndex(key) { return this.laneKeys.indexOf(key); }

  promote(key, via = 'list') {
    if (this.data.anonymous || this.laneKeys.includes(key) || !this.byKey.has(key)) return false;
    if (this.laneKeys.length >= MAX_LANES) { this.say(`Eight people at most have lanes of their own: remove someone first.`); return false; }
    this.laneKeys = [...this.laneKeys, key];
    logger.event('overlay_lane', { action: 'add', annotator_id: key, lanes: this.laneKeys.length, via });
    this._rebuildLanes();
    this._recount();
    this.say(`${shortName(this.byKey.get(key))} has a lane of their own now.`);
    return true;
  }

  demote(key) {
    if (!this.laneKeys.includes(key)) return;
    this.laneKeys = this.laneKeys.filter((k) => k !== key);
    logger.event('overlay_lane', { action: 'remove', annotator_id: key, lanes: this.laneKeys.length, via: 'button' });
    this._rebuildLanes();
    this._recount();
  }

  say(text) { this.msg.textContent = text; }

  // ---------------------------------------------------------------- the page
  _build() {
    const d = this.data;
    const ws = this.ws;
    this.tip = h('div.ov-tip', { role: 'status', hidden: true });
    this.crowdCanvas = h('canvas.ov-crowd-canvas', { 'aria-hidden': 'true' });
    this.crowdTrack = h('div.lane-track.ov-crowd-track', {}, this.crowdCanvas);
    this.crowdRow = h('div.lane.ov-crowd-lane', {}, h('span.lane-name', { title: 'The crowd\'s marks on the whole montage: the darker, the more of the crowd marked it' },
      h('b', {}, 'Crowd')), this.crowdTrack);
    this.strip = h('div.ov-strip');
    ws.eegHost.prepend(this.strip);
    ws.eegHost.append(this.tip);
    // the side panel
    this.countEl = h('p.caption.ov-count');
    this.legend = h('ul.ov-legend', { 'aria-label': 'Who is in each lane' });
    this.scale = h('div.ov-scale', {}, h('span.ov-scale-bar', { 'aria-hidden': 'true' },
      [0.1, 0.3, 0.5, 0.7, 0.9].map((x) => h('span', { style: { background: rgba(COLOURS.accent, 0.12 + 0.83 * x) } }))),
    h('span.caption', {}, 'The crowd: a band under each channel, and the Crowd lane above the EEG for marks on the whole montage. The darker, the larger the share of the crowd marking that moment.'));
    this.filters = this._filterControls();
    this.disEl = h('p.ov-dis', { 'aria-live': 'polite' });
    this.prevBtn = h('button.btn.small', { type: 'button', 'data-log': 'overlay-prev', title: 'The previous disagreement (P)', onclick: () => this.step(-1, 'button') }, 'Previous');
    this.nextBtn = h('button.btn.small', { type: 'button', 'data-log': 'overlay-next', title: 'The next disagreement (N)', onclick: () => this.step(1, 'button') }, 'Next');
    this.searchBox = h('input.field.ov-search', { type: 'search', placeholder: 'Find someone', 'aria-label': 'Find someone in the crowd', 'data-log': 'overlay-search',
      oninput: () => { this.search = this.searchBox.value.trim().toLowerCase(); this._drawCrowdList(); } });
    this.crowdList = h('ul.ov-people', { 'aria-label': 'The people in the crowd' });
    this.msg = h('p.ov-msg', { role: 'status' });
    const tsv = h('button.btn.small', { type: 'button', 'data-log': 'overlay-tsv', onclick: () => this.download() }, 'Download the summary (TSV)');
    const derived = this._derivedControls();
    this.el = h('section.review.card.overlay-panel', { 'aria-label': 'Everyone\'s marks' },
      h('h2', {}, 'Everyone\'s marks'),
      h('p.caption', {}, d.anonymous
        ? `How everyone who saved ${d.file_name} marked it, as a crowd: nobody is named. The darker a band under a channel, the more people marked that moment there.`
        : `The saved marks of everyone who annotated ${d.file_name}, the latest version of each. Up to eight people have lanes of their own; everyone else is the crowd, a band under each channel shaded by the share of them marking each moment.`),
      this.countEl,
      d.anonymous ? null : h('h3', {}, 'Lanes'), d.anonymous ? null : this.legend, this.scale,
      this._reviewBlock(),
      h('h3', {}, 'Disagreements'), this.disEl, h('div.btn-row', {}, this.prevBtn, this.nextBtn),
      h('h3', {}, 'Filters'), this.filters, derived,
      d.anonymous ? null : h('h3', {}, 'The crowd'), d.anonymous ? null : this.searchBox, d.anonymous ? null : this.crowdList,
      this.msg, h('div.btn-row', {}, tsv));
    ws.reviewHost.append(this.el);
    this._rebuildLanes();
    ws.hintEl.textContent = touchFirst() ? 'Tap a band for who marked it  ·  Next for the next disagreement'
      : 'N / P  disagreements  ·  pointer on a band: who marked it  ·  ?  keys';
    // the crowd's bands on the EEG, and hovering and clicking them
    ws.viewer.setCrowd({ paint: (ctx, v) => this.paint(ctx, v) });
    const over = ws.viewer.over;
    this._onMove = (e) => this._hover(e.clientX, e.clientY, 'eeg');
    this._onLeave = () => this._hideTip();
    this._onClick = (e) => { const at = this._bandAt(e.clientX, e.clientY, 'eeg'); if (at) { e.stopPropagation(); this.showWho(at); } };
    over.addEventListener('pointermove', this._onMove);
    over.addEventListener('pointerleave', this._onLeave);
    over.addEventListener('click', this._onClick, true);
    this.crowdTrack.addEventListener('pointermove', (e) => this._hover(e.clientX, e.clientY, 'lane'));
    this.crowdTrack.addEventListener('pointerleave', () => this._hideTip());
    this.crowdTrack.addEventListener('click', (e) => { const at = this._bandAt(e.clientX, e.clientY, 'lane'); if (at) this.showWho(at); });
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => requestAnimationFrame(() => this._drawStrips()));
      this._ro.observe(ws.viewer.el);
    }
  }

  /**
   * Marks of the uncertain type (Uncertain / needs review): how many there are and whose, with a button that
   * shows only them (the type filter). Nothing when there are none.
   */
  _reviewBlock() {
    const d = this.data;
    const who = new Map();
    for (const p of d.people) {
      const n = p.marks.filter((m) => needsReview(asAnnotation(d, m))).length;
      if (n) who.set(p, n);
    }
    const total = [...who.values()].reduce((a, b) => a + b, 0);
    if (!total) return null;
    const names = d.anonymous ? `${who.size} ${who.size === 1 ? 'person' : 'people'}` : [...who.keys()].map((p) => shortName(p)).join(', ');
    const show = h('button.btn.small', { type: 'button', 'data-log': 'overlay-needs-review', title: `Show only the marks of type ${UNCERTAIN_LABEL}`,
      onclick: () => { if (this.typeSelect) this.typeSelect.value = UNCERTAIN_LABEL; this.setFilter({ label: UNCERTAIN_LABEL }); } }, 'Show only these');
    return h('div.ov-review', { 'data-log': 'overlay-review' }, h('h3', {}, 'Needs review'),
      h('p.caption', {}, `${total} ${total === 1 ? 'mark is' : 'marks are'} of the uncertain type (${UNCERTAIN_LABEL}): an artifact whose type the annotator could not tell. By ${names}.`),
      h('div.btn-row', {}, show));
  }

  _filterControls() {
    const d = this.data;
    const out = h('div.ov-filters');
    const add = (label, el, key) => {
      el.setAttribute('aria-label', label);
      el.dataset.log = `overlay-filter-${key}`;
      out.append(h('label.ov-filter', {}, h('span.caption', {}, label), el));
      return el;
    };
    const type = add('Type', select([['', 'Every type'], ...d.labels.map((l) => [l, l === UNCERTAIN_LABEL ? `${l} (${UNCERTAIN_TEXT.toLowerCase()})` : l])], ''), 'type');
    type.addEventListener('change', () => this.setFilter({ label: type.value }));
    this.typeSelect = type;
    if (!d.anonymous) {
      const roles = [...new Set(d.people.flatMap((p) => p.roles || []))].filter((r) => ROLE_WORDS[r]).sort();
      if (roles.length > 1) {
        const role = add('Role', select([['', 'Every role'], ...roles.map((r) => [r, ROLE_WORDS[r]])], ''), 'role');
        role.addEventListener('change', () => this.setFilter({ role: role.value }));
      }
      for (const facet of d.facets) {
        if (!facet.values.length) continue;
        const s = add(facet.title, select([['', `Every ${facet.title.toLowerCase()}`], ...facet.values.map((v) => [v, v])], ''), facet.key);
        s.addEventListener('change', () => this.setFilter({ facets: { ...this.f.facets, [facet.key]: s.value } }));
      }
    }
    const from = add('Saved from', h('input.field', { type: 'date' }), 'from');
    const to = add('Saved until', h('input.field', { type: 'date' }), 'to');
    from.addEventListener('change', () => this.setFilter({ from: from.value }));
    to.addEventListener('change', () => this.setFilter({ to: to.value }));
    return out;
  }

  _derivedControls() {
    if (this.data.anonymous) return null;
    const inc = new Set(this.target.include || []);
    const box = (key, label) => {
      const input = h('input', { type: 'checkbox', checked: inc.has(key), 'data-log': `overlay-include-${key}`, onchange: () => this.reload(key, input.checked) });
      return h('label.check', {}, input, h('span', {}, label));
    };
    return h('div.ov-derived', {}, box('corrected', 'Offer the corrected versions'), box('adjudicated', 'Offer the adjudicated version'),
      h('p.caption', {}, 'They join the list below, to be shown in lanes; the crowd holds people\'s own work only.'));
  }

  /** Ask again with the corrected or adjudicated versions offered (or no longer), keeping the lanes. */
  async reload(key, on) {
    const inc = new Set(this.target.include || []);
    if (on) inc.add(key); else inc.delete(key);
    const include = [...inc];
    const focus = this.laneKeys.filter((k) => !k.includes('~') && k !== 'ADJUDICATED');
    let target;
    try {
      target = await loadOverlay(this.app.backend, { ...this.target.body, include, ...(focus.length ? { detail: focus } : {}) });
    } catch (exc) {
      this.say(`The versions could not be loaded: ${exc.message}`);
      return;
    }
    this.target = { ...this.target, ...target, include };
    this.data = decode(target, target.pages || []);
    this.byKey = new Map(this.data.people.map((p) => [p.key, p]));
    this.laneKeys = this.laneKeys.filter((k) => this.byKey.has(k));
    this._rebuildLanes();
    this._recount();
    const n = this.data.people.filter((p) => p.source !== 'saved').length;
    this.say(on ? (n ? `${n} derived version${n === 1 ? '' : 's'} offered below.` : 'This recording has no such version yet.') : 'Done.');
  }

  setFilter(change) {
    this.f = { ...this.f, ...change };
    logger.event('overlay_filter', { filter: Object.keys(change)[0], on: Object.values(change).some((v) => (typeof v === 'object' ? Object.values(v).some(Boolean) : Boolean(v))),
      crowd: this.crowd.length });
    this._recount();
  }

  _rebuildLanes() {
    if (this.lanes) { this.lanes.destroy(); this.lanes.el.remove(); }
    const people = this.lanePeople;
    const versions = people.map((p, i) => ({ letter: String(i + 1), annotator_id: p.key, display_name: p.display_name, person: p,
      annotations: p.marks.filter((m) => markPasses(m, this.f)).map((m) => asAnnotation(this.data, m)) }));
    this.lanes = new Lanes(this.ws.viewer, { versions, catalogue: this.ws.cat, className: 'ov-lanes',
      name: (v) => { const i = Number(v.letter) - 1; return h('span.lane-name', { title: `${personName(v.person)}: ${PATTERN_WORDS[LANE_PATTERNS[i]]}` }, swatch(i), h('b', {}, shortName(v.person))); },
      style: (v) => { const i = Number(v.letter) - 1; return { ...patternCss(LANE_PATTERNS[i], LANE_COLOURS[i]), borderColor: 'rgba(0, 0, 0, 0.55)', color: laneInk(LANE_COLOURS[i]) }; },
      text: (v) => shortName(v.person) });
    this.lanes.el.append(this.crowdRow);
    this.crowdRow.hidden = this.data.anonymous ? false : !this.crowd.length;
    clear(this.strip);
    this.strip.append(this.lanes.el);
    this.ws.viewer.setLayers(versions.map((v, i) => ({ id: `lane-${v.annotator_id}`, annotations: v.annotations, colour: LANE_COLOURS[i], dash: LANE_DASHES[i],
      prefix: `${shortName(v.person)}: ` })));
    this._drawLegend();
  }

  _drawLegend() {
    clear(this.legend);
    const people = this.lanePeople;
    if (!people.length) this.legend.append(h('li.caption', {}, 'Nobody yet: choose Show in a lane beside someone in the crowd, or click a band.'));
    people.forEach((p, i) => {
      this.legend.append(h('li', { 'data-lane': p.key }, swatch(i),
        h('span.ov-who', {}, h('b', {}, shortName(p)), p.source === 'saved' && p.display_name ? h('span.caption', {}, ` ${p.display_name}`) : null,
          h('span.caption.block', {}, `${p.marks.length} mark${p.marks.length === 1 ? '' : 's'}, ${PATTERN_WORDS[LANE_PATTERNS[i]]}${p.source === 'saved' ? `, version ${p.attempt}` : ''}`)),
        h('button.btn.small.quiet', { type: 'button', 'data-log': 'overlay-lane-remove', 'aria-label': `Back to the crowd: ${shortName(p)}`, title: 'Back to the crowd',
          onclick: () => this.demote(p.key) }, 'Remove')));
    });
  }

  _drawCrowdList() {
    if (this.data.anonymous) return;
    clear(this.crowdList);
    const full = this.laneKeys.length >= MAX_LANES;
    const others = this.data.people.filter((p) => !this.laneKeys.includes(p.key));
    const q = this.search;
    const match = others.filter((p) => !q || `${p.annotator_id} ${p.display_name}`.toLowerCase().includes(q));
    for (const p of match.slice(0, MAX_LISTED)) {
      const inCrowd = this.crowdSet.has(p.key);
      this.crowdList.append(h('li', { 'data-person': p.key },
        h('span.ov-who', {}, h('b', {}, shortName(p)), p.source === 'saved' && p.display_name ? h('span.caption', {}, ` ${p.display_name}`) : null,
          h('span.caption.block', {}, `${p.marks.length} mark${p.marks.length === 1 ? '' : 's'}${p.source !== 'saved' ? `, ${p.source === 'adjudicated' ? 'the adjudicated version' : 'a corrected version'}` : inCrowd ? '' : ', left out by the filters'}`)),
        h('button.btn.small', { type: 'button', 'data-log': 'overlay-promote', disabled: full || null, title: full ? 'Eight lanes at most: remove someone first' : `Give ${shortName(p)} a lane of their own`,
          onclick: () => this.promote(p.key, 'list') }, 'Show in a lane')));
    }
    if (match.length > MAX_LISTED) this.crowdList.append(h('li.caption', {}, `and ${match.length - MAX_LISTED} more: type an ID or a name to find someone.`));
    if (!match.length) this.crowdList.append(h('li.caption', {}, q ? 'Nobody matches.' : 'Everyone has a lane.'));
  }

  /** Count again after a change of lanes or filters, and redraw everything. */
  _recount() {
    const t0 = performance.now();
    const crowd = this.crowd;
    this.crowdSet = new Set(crowd.map((p) => p.key));
    this.bands = new CrowdBands(this.data, crowd, this.f);
    this.shownBands = new CrowdBands(this.data, this.shown, this.f);
    this.list = disagreements(this.shownBands.band('any'), this.shown.length, Math.round(0.25 * this.sf));
    if (this.current >= this.list.length) this.current = -1;
    this.countMs = performance.now() - t0;
    const saved = this.data.people.filter((p) => p.source === 'saved').length;
    const filtered = saved - this.laneKeys.filter((k) => this.byKey.get(k)?.source === 'saved').length - crowd.length;
    this.countEl.textContent = this.data.anonymous
      ? `${saved} ${saved === 1 ? 'person' : 'people'} in the crowd${filtered > 0 ? `, ${filtered} left out by the filters` : ''}.`
      : `${saved} ${saved === 1 ? 'person' : 'people'} saved it: ${this.laneKeys.length} in lanes, ${crowd.length} in the crowd${filtered > 0 ? `, ${filtered} left out by the filters` : ''}.`;
    this.crowdRow.hidden = !crowd.length;
    if (this.lanes) {
      const versions = this.lanes.versions;
      for (const v of versions) v.annotations = v.person.marks.filter((m) => markPasses(m, this.f)).map((m) => asAnnotation(this.data, m));
      this.ws.viewer.setLayers(versions.map((v, i) => ({ id: `lane-${v.annotator_id}`, annotations: v.annotations, colour: LANE_COLOURS[i], dash: LANE_DASHES[i],
        prefix: `${shortName(v.person)}: ` })));
    }
    this._drawDisagreement();
    this._drawCrowdList();
    this._hideTip();
    this.ws.viewer.invalidate(['over']);
    this._drawStrips();
  }

  _drawStrips() {
    if (this.lanes) this.lanes.draw();
    this._paintCrowdLane();
  }

  _drawDisagreement() {
    const n = this.list.length;
    this.prevBtn.disabled = !n;
    this.nextBtn.disabled = !n;
    if (!n) { this.disEl.textContent = this.shown.length < 2 ? 'Show two people or more to compare them.' : 'None: wherever someone marked, nearly everyone agrees.'; return; }
    if (this.current < 0) { this.disEl.textContent = `${n} stretch${n === 1 ? '' : 'es'} where people disagree. Next (N) goes to the first.`; return; }
    const dd = this.list[this.current];
    const mid = Math.floor((dd.start + dd.end) / 2);
    const who = whoAt(this.data, this.shown, 'any', mid, this.f);
    const types = typeCounts(who).slice(0, 3).map(([l, k]) => `${l} ${k}`).join(', ');
    this.disEl.textContent = `Disagreement ${this.current + 1} of ${n}: ${(dd.start / this.sf).toFixed(2)}–${(dd.end / this.sf).toFixed(2)} s, `
      + `${who.length} of ${this.shown.length} marked it${types ? ` (${types})` : ''}.`;
  }

  /** Go to the next (1) or previous (-1) disagreement. */
  step(delta, via = 'key') {
    if (!this.list.length) { this.say('There is no disagreement among the people shown.'); return; }
    const v = this.ws.viewer;
    const here = this.current >= 0 ? this.list[this.current].start : (delta > 0 ? -1 : (v.view.startS + v.view.durationS / 2) * this.sf);
    let i = stepDisagreement(this.list, here, delta);
    if (i < 0) { this.say(delta > 0 ? 'That was the last disagreement.' : 'That was the first disagreement.'); return; }
    this.current = i;
    const dd = this.list[i];
    const mid = (dd.start + dd.end) / 2 / this.sf;
    v.setView({ startS: mid - v.view.durationS / 2 }, 'overlay');
    logger.event('overlay_disagreement', { index: i + 1, of: this.list.length, t: Math.round(mid * 100) / 100, via });
    this._drawDisagreement();
    this.say('');
  }

  // ---------------------------------------------------------------- drawing
  /** The crowd's band under each channel on screen (viewer.setCrowd). */
  paint(ctx, v) {
    if (!this.bands || !this.bands.n || v.overlay) return;
    const s0 = v.view.startS * this.sf;
    const s1 = (v.view.startS + v.view.durationS) * this.sf;
    const hgt = this.bandHeight(v);
    ctx.save();
    for (const { row, ch } of v.visibleRows()) {
      const idx = this.chIndex.get(ch.name);
      if (idx === undefined) continue;
      const st = this.bands.band(idx);
      if (!st.at.length) continue;
      const y = v.rowCentre(row) + v.rowH / 2 - hgt;
      this._fillSteps(ctx, v, st, this.bands.n, s0, s1, y, hgt);
    }
    ctx.restore();
  }

  bandHeight(v) { return Math.max(2, Math.min(7, v.rowH * 0.3)); }

  _fillSteps(ctx, v, st, n, s0, s1, y, hgt) {
    let lo = 0;
    let hi = st.at.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (st.at[mid] <= s0) lo = mid; else hi = mid - 1; }
    for (let i = lo; i < st.at.length - 1 && st.at[i] < s1; i++) {
      if (!st.n[i]) continue;
      const xa = Math.max(v.x0, v.sampleToX(st.at[i]));
      const xb = Math.min(v.x1, v.sampleToX(st.at[i + 1]));
      if (xb <= xa) continue;
      ctx.fillStyle = rgba(COLOURS.accent, 0.12 + 0.83 * (st.n[i] / n));
      ctx.fillRect(xa, y, Math.max(1, xb - xa), hgt);
    }
  }

  _paintCrowdLane() {
    const v = this.ws.viewer;
    if (!v || !v.view || this.crowdRow.hidden) return;
    const c = this.crowdCanvas;
    const w = Math.max(0, Math.round(v.plotW));
    const dpr = v.dpr || 1;
    this.crowdTrack.style.marginLeft = `${Math.round(v.x0)}px`;
    this.crowdTrack.style.width = `${w}px`;
    const hgt = 14;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
    c.style.width = `${w}px`;
    c.style.height = `${hgt}px`;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    if (!this.bands || !this.bands.n) return;
    const geo = { x0: 0, x1: w, sampleToX: (s) => v.sampleToX(s) - v.x0 };
    this._fillSteps(ctx, geo, this.bands.band('whole'), this.bands.n, v.view.startS * this.sf, (v.view.startS + v.view.durationS) * this.sf, 0, hgt);
  }

  // ---------------------------------------------------------------- hover and click
  /** The band under a point: {key, channel, sample}, or null. */
  _bandAt(clientX, clientY, where) {
    if (!this.bands || !this.bands.n) return null;
    const v = this.ws.viewer;
    if (where === 'lane') {
      const r = this.crowdTrack.getBoundingClientRect();
      if (clientX < r.left || clientX > r.right) return null;
      const t = v.xToT(clientX - r.left + v.x0);
      return { key: 'whole', channel: null, sample: Math.floor(t * this.sf), clientX, clientY };
    }
    if (v.overlay) return null;
    const info = v.hit(clientX, clientY);
    if (!info || info.area !== 'eeg' || info.row === null) return null;
    const r = v.over.getBoundingClientRect();
    const y = clientY - r.top;
    const bottom = v.rowCentre(info.row) + v.rowH / 2;
    if (y < bottom - this.bandHeight(v) - 3 || y > bottom + 1) return null;
    const idx = this.chIndex.get(info.channel);
    if (idx === undefined) return null;
    return { key: idx, channel: info.channel, sample: info.sample, clientX, clientY };
  }

  _hover(clientX, clientY, where) {
    if (this._hoverRaf) cancelAnimationFrame(this._hoverRaf);
    this._hoverRaf = requestAnimationFrame(() => {
      const at = this._bandAt(clientX, clientY, where);
      if (!at) { this._hideTip(); return; }
      const who = whoAt(this.data, this.crowd, at.key, at.sample, this.f);
      if (!who.length) { this._hideTip(); return; }
      this._showTip(at, who);
    });
  }

  /** The words of the hover: share, types and who. */
  tipText(at, who) {
    const n = this.bands.n;
    const where = at.channel ? `${at.channel}` : 'The whole montage';
    const names = who.map((w) => shortName(w.person));
    const listed = names.length <= 6 ? names.join(', ') : `${names.slice(0, 6).join(', ')} and ${names.length - 6} more`;
    return { head: `${where} at ${(at.sample / this.sf).toFixed(2)} s: ${Math.round((100 * who.length) / n)}% of the crowd (${who.length} of ${n})`,
      types: typeCounts(who).slice(0, 4).map(([l, k]) => `${l} ${k}`).join(' · '), who: this.data.anonymous ? '' : listed };
  }

  _showTip(at, who) {
    const t = this.tipText(at, who);
    clear(this.tip);
    this.tip.append(h('b', {}, t.head), h('span.block', {}, t.types), t.who ? h('span.block.caption', {}, t.who) : null,
      h('span.block.caption', {}, this.data.anonymous ? '' : 'Click for everyone, to show one in a lane.'));
    this.tip.hidden = false;
    const host = this.ws.eegHost.getBoundingClientRect();
    const x = Math.min(at.clientX - host.left + 14, host.width - 300);
    this.tip.style.left = `${Math.max(4, x)}px`;
    this.tip.style.top = `${Math.max(4, at.clientY - host.top + 16)}px`;
    this.tipAt = at;
  }

  _hideTip() { this.tip.hidden = true; this.tipAt = null; }

  /** Everyone who marked a moment of a band, with Show in a lane beside each (a dialog). */
  async showWho(at) {
    const who = whoAt(this.data, this.crowd, at.key, at.sample, this.f);
    if (!who.length) return;
    this._hideTip();
    const t = this.tipText(at, who);
    const full = this.laneKeys.length >= MAX_LANES;
    const chosen = await showDialog({ title: 'Who marked this moment', className: 'ov-who-dialog', wide: true, cancelValue: null, logText: 'overlay who',
      body: h('div', {}, h('p.dialog-text', {}, t.head), h('p.caption', {}, t.types),
        this.data.anonymous ? null : h('ul.ov-people', {}, who.slice(0, 300).map((w) => h('li', {},
          h('span.ov-who', {}, h('b', {}, shortName(w.person)), w.person.display_name ? h('span.caption', {}, ` ${w.person.display_name}`) : null, h('span.caption.block', {}, w.labels.join(', '))),
          h('button.btn.small', { type: 'button', 'data-log': 'overlay-promote-who', 'data-pick': w.person.key, disabled: full || null }, 'Show in a lane')))),
        !this.data.anonymous && who.length > 300 ? h('p.caption', {}, `and ${who.length - 300} more.`) : null,
        full && !this.data.anonymous ? h('p.note', {}, 'Eight people already have lanes: remove someone first.') : null),
      buttons: [{ label: 'Close', value: null }],
      onOpen: ({ box, close }) => { for (const b of box.querySelectorAll('[data-pick]')) b.addEventListener('click', () => close(b.dataset.pick)); } });
    if (chosen) this.promote(chosen, 'band');
  }

  // ---------------------------------------------------------------- keys, export, closing
  onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const take = (action, fn) => { e.preventDefault(); logger.shortcut(keyName(e), action); fn(); return true; };
    if (isHelpKey(e)) return take('Keys', () => { void showKeySheet('Keys of everyone\'s marks', OVERLAY_KEYS, { view: 'overlay' }); });
    if (e.key === 'n' || e.key === 'N') return take('Next disagreement', () => this.step(1));
    if (e.key === 'p' || e.key === 'P') return take('Previous disagreement', () => this.step(-1));
    if (e.key === 'Escape' && !this.tip.hidden) return take('Hide', () => this._hideTip());
    return false;
  }

  /** The view's summary as TSV (crowd.js summaryTsv): the people shown, as filtered. */
  summary() { return summaryTsv(this.data, this.shown, this.laneKeys, this.f); }

  download() {
    const stamp = new Date().toISOString().slice(0, 10);
    const stem = String(this.data.file_name || 'recording').replace(/\.[^.]+$/, '');
    downloadText(`electrotag_overlay_${stem}_${stamp}.tsv`, this.summary(), 'text/tab-separated-values;charset=utf-8');
    logger.event('overlay_downloaded', { people: this.shown.length, lanes: this.laneKeys.length });
  }

  destroy() {
    const over = this.ws.viewer && this.ws.viewer.over;
    if (over) {
      over.removeEventListener('pointermove', this._onMove);
      over.removeEventListener('pointerleave', this._onLeave);
      over.removeEventListener('click', this._onClick, true);
    }
    if (this._ro) this._ro.disconnect();
    if (this.lanes) this.lanes.destroy();
    logger.event('overlay_closed', { recording_id: this.data.recording_id, lanes: this.laneKeys.length, s: Math.round((performance.now() - this.openedAt) / 100) / 10 });
  }
}
