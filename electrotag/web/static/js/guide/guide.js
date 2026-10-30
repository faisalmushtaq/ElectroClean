// The artifact reference guide (docs/web/using.md, "The artifact reference guide"): one page with
// every artifact type of the catalogue, in the catalogue's order and families, each with its HED-SCORE
// name and short name, its code and key, the catalogue's description, what it looks like (where on the
// scalp, its frequency, its shape and typical duration), how to tell it from its look-alikes, and a
// small live example drawn with the snippets' EEG viewer from the sandbox's simulation
// (js/eeg/synthetic.js), so that it works offline and without a study. It is searchable and
// printable, and it opens as its own page (#guide, also without signing in, for a second tab), beside
// the EEG as the annotation view's Guide tab, from the Help tab, from the type picker's "About this
// type" and from the training path. What it says of each type is in guide/artifacts.js.

import { h, clear } from '../ui/dom.js';
import { appHeader } from '../views/common.js';
import { EegViewer } from '../viewer/viewer.js';
import { makeSyntheticRecording } from '../eeg/synthetic.js';
import { Catalogue, displayCode } from '../catalogue.js';
import { CATALOGUE, DEFAULT_QUICK_LABELS, DEFAULT_SCALINGS } from '../api/demo_catalogue.js';
import { local } from '../util.js';
import { logger } from '../log/logger.js';
import { GUIDE, GUIDE_FOCUS as FOCUS, GUIDE_KEYS as KEYS, exampleSpec, guideMatches, noteForGuideTab } from './artifacts.js';

/** A link that opens the guide in a new tab, noting the study's keys (and a type to show first) as it is followed. */
export function guideTabLink(app, text, { focus = null, className = '' } = {}) {
  return h(`a${className}`, { href: './#guide', target: '_blank', rel: 'noopener', 'data-log': 'guide-new-tab',
    onclick: () => { noteForGuideTab(guideKeys(app), focus); logger.event('guide_opened', { where: 'tab', label: focus }); } }, text);
}

/** The catalogue to describe: the study's when signed in, else ElectroTag's own (the same 29 types). */
function catalogueOf(app) { return (app && app.catalogue) || new Catalogue(CATALOGUE); }

/** The types on keys 1 to 9: the annotation view's, the study's, or those noted in this browser by the last study, or the defaults. */
export function guideKeys(app) {
  const cat = catalogueOf(app);
  if (app && app.ws && Array.isArray(app.ws.quick)) return app.ws.quick;
  const study = app && app.me && app.me.study && app.me.study.annotation;
  if (study) return cat.quickLabels(study.quick_labels);
  const kept = local.get(KEYS, null);
  return cat.quickLabels(Array.isArray(kept) ? kept : DEFAULT_QUICK_LABELS);
}

/** Open the guide as its own page in a new tab, at a type if given (its keys go with it, through this browser). */
export function openGuideTab(app, label = null) {
  noteForGuideTab(guideKeys(app), label);
  logger.event('guide_opened', { where: 'tab', label: label || null });
  try { window.open('./#guide', '_blank', 'noopener'); } catch { /* pop-ups not allowed here */ }
}

/** "Key 1", or how a type off the number keys is chosen. */
export function keyText(label, keys) {
  const i = keys.indexOf(label);
  return i >= 0 ? `Key ${i + 1}` : 'Find a type (/)';
}

/** Draw a type's live example in `host`: 10 s of simulated EEG with the artifact outlined. Returns the viewer. */
export function drawExample(host, l, catalogue, { channels: only = null } = {}) {
  const spec = exampleSpec(l.label, l.value);
  if (!spec) return null;
  const rec = makeSyntheticRecording(spec);
  const all = rec.channels.map((c, i) => ({ name: c.name, index: i, type: c.type, bad: false }));
  const channels = only ? all.filter((c) => only.includes(c.name)) : all;
  const viewer = new EegViewer(host, { recording: rec, channels, scalings: { ...DEFAULT_SCALINGS }, events: [], gaps: [], catalogue, filters: null,
    view: { duration_s: 10, n_channels: channels.length } });
  viewer.setEdgeZonesVisible(false);
  viewer.setView({ startS: 0, durationS: 10, nChannels: channels.length, firstChannel: 0 }, 'guide');
  const a = rec.spec.artifacts[0];
  viewer.setGhost({ label: l.label, onset_sample: Math.round(a.onsetS * rec.sfreq), duration_samples: Math.round(a.durationS * rec.sfreq), channels: [...a.channels] });
  return viewer;
}

/** One type's entry. `example(host)` draws its example into the host given (lazily, when it is on the screen). */
function typeCard(l, keys, { compact = false } = {}) {
  const g = GUIDE[l.label] || { where: '', frequency: '', shape: '', duration: '', apart: [], example: null };
  const looks = [['Where', g.where], ['Frequency', g.frequency], ['Shape', g.shape], ['Duration', g.duration]].filter(([, v]) => v);
  const host = g.example ? h('div.guide-eeg', { 'aria-label': `A simulated example of ${l.label}` }) : null;
  const card = h(`article.guide-type${l.is_group ? '.group' : ''}`, { id: `type-${l.value}`, 'data-label': l.label, tabindex: '-1' },
    h('header.guide-type-head', {},
      h('span.swatch', { style: { background: l.colour } }),
      h('h3', {}, l.label),
      h('span.guide-codes', {}, h('span.chip', {}, displayCode(l.short_code)), h('span.caption', {}, `code ${l.value}`),
        h('span.caption.guide-key', {}, keyText(l.label, keys)))),
    l.is_group ? h('p.caption', {}, 'A group term: for an artifact of this family whose exact type is unclear.') : null,
    h('p.guide-hed', {}, h('span.guide-term', {}, 'HED-SCORE: '), l.description || ''),
    looks.length ? h('dl.guide-looks', {}, looks.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])) : null,
    g.apart && g.apart.length ? h('div.guide-apart', {}, h('p.guide-term', {}, 'Telling it apart'),
      h('ul', {}, g.apart.map(([other, how]) => h('li', {}, h('b', {}, other), ` ${how}`)))) : null,
    host ? h('figure.guide-example', {}, host,
      h('figcaption.caption', {}, `Simulated, shown without filters; the outline is where it was placed${compact ? '' : ' (10 s of EEG)'}.`)) : null);
  card._exampleHost = host;
  return card;
}

/**
 * The guide: a search, Print, and the types by family. `panel` draws it for the annotation view's
 * side (one column, examples drawn when shown); `focus` is a label to scroll to first.
 */
export class GuideView {
  constructor(app, { panel = false, focus = null, onBack = null } = {}) {
    this.app = app;
    this.panel = panel;
    this.catalogue = catalogueOf(app);
    this.keys = guideKeys(app);
    this.viewers = [];
    this.search = h('input.field.guide-search', { type: 'search', placeholder: 'Search, for example blink, frontal or 50 Hz', 'aria-label': 'Search the artifact types',
      autocomplete: 'off', spellcheck: 'false', 'data-log': 'guide-search', oninput: () => this._filter() });
    this.count = h('p.caption.guide-count', { 'aria-live': 'polite' });
    this.list = h('div.guide-list');
    this.cards = [];
    for (const s of this.catalogue.sections()) {
      const cards = s.labels.map((l) => typeCard(l, this.keys, { compact: panel }));
      this.cards.push(...cards);
      this.list.append(h('section.guide-family', { 'data-section': s.section }, h('h2', {}, s.section), ...cards));
    }
    const tools = h('div.guide-tools', {}, this.search,
      panel ? guideTabLink(app, 'Open in a new tab', { className: '.btn.small.quiet' })
        : h('button.btn.small', { type: 'button', 'data-log': 'guide-print', onclick: () => this.print() }, 'Print'));
    const intro = h('p.subtitle.guide-intro', {}, 'Every artifact type of the catalogue: its HED-SCORE definition, what it looks like and how to tell it from the types it is confused with, ',
      'with a simulated example of the types the sandbox can draw. Your study\'s own examples are in Meet the artifacts on the training path.');
    if (panel) {
      this.el = h('div.guide.guide-panel', { 'data-view': 'guide' }, tools, this.count, this.list);
    } else {
      const back = onBack ? h('button.btn.quiet.back', { type: 'button', onclick: onBack }, 'Back') : null;
      const home = !app || !app.me ? h('p.caption', {}, h('a', { href: './' }, 'Open ElectroTag')) : null;
      this.el = h('div.view.guide-page', { 'data-view': 'guide' }, appHeader(app || {}),
        h('main.page.guide', {}, back, h('h1', {}, 'Artifact reference guide'), intro, home, tools, this.count, this.list));
    }
    this._observe();
    this._filter();
    if (focus) requestAnimationFrame(() => this.show(focus));
  }

  /** Draw each example once it comes near the screen (a page of 16 viewers at once would be slow to open). */
  _observe() {
    const draw = (card) => {
      if (!card._exampleHost || card._drawn) return;
      card._drawn = true;
      const l = this.catalogue.get(card.dataset.label);
      const v = drawExample(card._exampleHost, l, this.catalogue);
      if (v) this.viewers.push(v);
    };
    this._draw = draw;
    if (typeof IntersectionObserver === 'undefined') { this.cards.forEach(draw); return; }
    this._io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) draw(e.target); }), { rootMargin: '300px 0px' });
    this.cards.forEach((c) => c._exampleHost && this._io.observe(c));
  }

  _filter() {
    const text = this.search.value.trim();
    let n = 0;
    for (const card of this.cards) {
      const ok = !text || guideMatches(this.catalogue.get(card.dataset.label), text);
      card.hidden = !ok;
      if (ok) n += 1;
    }
    for (const sec of this.list.querySelectorAll('.guide-family')) sec.hidden = ![...sec.querySelectorAll('.guide-type')].some((c) => !c.hidden);
    this.count.textContent = text ? (n ? `${n} of ${this.cards.length} types match "${text}".` : `No type matches "${text}". Try another word, such as eye, muscle or 50 Hz.`)
      : `${this.cards.length} types in ${this.list.querySelectorAll('.guide-family').length} families.`;
    // once the typing pauses; the words typed are never logged
    clearTimeout(this._logTimer);
    if (text) this._logTimer = setTimeout(() => logger.event('guide_search', { n_chars: text.length, n_matches: n }), 1000);
  }

  /** Scroll to a type and give it the focus (clearing a search that hides it). */
  show(label) {
    const card = this.cards.find((c) => c.dataset.label === label);
    if (!card) return;
    if (card.hidden) { this.search.value = ''; this._filter(); }
    this._draw(card);
    try { card.scrollIntoView({ block: 'start' }); card.focus({ preventScroll: true }); } catch { /* not on the page */ }
    card.classList.add('focused');
  }

  /** Print every type: the examples are drawn first, so that they print too. */
  print() {
    this.cards.forEach((c) => this._draw(c));
    logger.event('guide_printed', {});
    setTimeout(() => { try { window.print(); } catch { /* no printing here */ } }, 400);
  }

  destroy() {
    clearTimeout(this._logTimer);
    if (this._io) this._io.disconnect();
    this.viewers.forEach((v) => v.destroy());
    this.viewers = [];
  }
}

/** The guide as its own page (#guide), signed in or not; a type noted by openGuideTab comes first. */
export function showGuidePage(app) {
  const focus = local.get(FOCUS, null);
  local.remove(FOCUS);
  if (app.guideView) app.guideView.destroy();
  const view = new GuideView(app, { focus: typeof focus === 'string' ? focus : null, onBack: app.me ? () => app.goBack() : null });
  app._render(view.el, 'guide');
  app.guideView = view;
  document.title = 'ElectroTag – artifact reference guide';
  logger.event('guide_opened', { where: 'page', label: focus || null });
  return view;
}

/** The guide in the annotation view's side panel (its Guide tab). */
export function mountGuidePanel(ws, host) {
  clear(host);
  const view = new GuideView(ws.app, { panel: true });
  host.append(view.el);
  return view;
}
