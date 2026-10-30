// The expert area: where experts correct and add to saved work, replay sessions, adjudicate
// disagreements and supply training material (docs/web/admin.md, "The expert area"). A header, the
// menu of its sections (js/expert/sections.js) and the section shown; administrators may use it too.
// It is loaded the first time it is needed (js/lazy.js) and shares the admin area's layout (admin.css),
// with a few styles of its own (expert.css).
//
// Every operation goes through backend.expert(op, body) (docs/web/api.md, "Experts"). Reads are shared
// between the parts of a section until the next change; an operation that saves is never repeated by
// itself, and its button cannot be pressed again while the study answers. Unlike the admin area, the
// expert area is logged like annotation work.

import { h, clear } from '../ui/dom.js';
import { appHeader } from '../views/common.js';
import { actionButton, card, checkbox, loading, messageArea, sectionHead } from '../admin/ui.js';
import { EXPERT_SECTIONS, routeForExpertSection } from './sections.js';

const STYLES = [['data-admin-css', '../../admin.css'], ['data-expert-css', '../../expert.css']];

/** The admin area's layout and the expert area's own styles, each loaded once. */
function loadStyles() {
  if (typeof document === 'undefined') return Promise.resolve();
  return Promise.all(STYLES.map(([attr, rel]) => {
    if (document.querySelector(`link[${attr}]`)) return Promise.resolve();
    return new Promise((resolve) => {
      const link = h('link', { rel: 'stylesheet', href: new URL(rel, import.meta.url).href, [attr]: '' });
      link.addEventListener('load', () => resolve());
      link.addEventListener('error', () => resolve());
      setTimeout(resolve, 3000);
      document.head.append(link);
    });
  }));
}

/** The overview: what the expert area is for, and the expert's own consent to teaching with their sessions. */
export class ExpertOverview {
  constructor(area) {
    this.area = area;
    this.msg = messageArea();
    this.consentHost = h('div.admin-stack');
    this.el = h('section.admin-section', { 'data-section': 'overview' },
      sectionHead('Expert work', 'Correct and add to saved work, replay how sessions went, adjudicate disagreements and supply training material. '
        + 'The parts the study offers are in the menu. The originals are never changed: a correction is a new version, credited to you.'),
      this.msg, this.consentHost);
  }

  async show() {
    this.msg.clear();
    clear(this.consentHost);
    this.consentHost.append(loading());
    let got;
    try {
      got = await this.area.read('replay_consent_get');
    } catch (exc) {
      clear(this.consentHost);
      this.msg.problem(exc);
      return;
    }
    clear(this.consentHost);
    this.consentHost.append(this._consentCard(got));
  }

  _consentCard(got) {
    const msg = messageArea();
    const teaching = checkbox('Let trainees watch replays of my sessions, to learn from how I work', Boolean(got.consent && got.consent.teaching));
    teaching.input.dataset.log = 'replay-consent';
    const save = actionButton('Save my choice', {
      kind: 'primary', working: 'Saving…', msg, log: 'replay-consent-save',
      onClick: async () => {
        const r = await this.area.write('replay_consent_set', { teaching: teaching.input.checked });
        msg.show('success', !r.changed ? 'Nothing has changed.'
          : r.consent.teaching ? 'Saved: trainees may watch replays of your sessions.' : 'Saved: trainees no longer watch replays of your sessions.');
      },
    });
    const off = got.replays && got.replays.trainees_watch_experts === false
      ? h('p.note', {}, 'The study does not show experts\' sessions to trainees at the moment; your choice is kept for when it does.') : null;
    return card('Your sessions for teaching',
      h('p.caption', {}, 'The study team can replay any annotator\'s session, step by step, from the record of how they worked. '
        + 'Trainees may watch yours only if you agree here. You can change your mind at any time, and the study\'s audit log keeps each change.'),
      teaching, off, h('div.btn-row', {}, save), msg);
  }
}

export class ExpertArea {
  constructor(app, { sections = EXPERT_SECTIONS } = {}) {
    this.app = app;
    this.backend = app.backend;
    this.annotatorId = app.me.annotator_id;
    this.list = sections;
    this.sections = new Map();
    this.current = null;
    this._reads = new Map();
    this.nav = h('nav.admin-nav.expert-nav', { 'aria-label': 'Sections of the expert area' },
      h('ul', {}, sections.map((s) => h('li', {}, h('a.admin-nav-link', { href: `#${s.route}`, 'data-section': s.key }, s.title)))));
    this.main = h('main.admin-main', { id: 'expert-main' });
    this.el = h('div.view.admin.expert-area', { 'data-view': 'expert' }, appHeader(app, { title: 'Expert work', expert: true }),
      h('div.admin-layout', {}, this.nav, h('div.admin-body', {}, this.main)));
  }

  ready() { return loadStyles(); }

  get isFirebase() { return this.backend.kind === 'firebase'; }

  get isDemo() { return Boolean(this.backend.isDemo); }

  async _sectionClass(key) {
    if (key === 'overview') return ExpertOverview;
    const s = this.list.find((x) => x.key === key);
    return s && s.load ? s.load() : ExpertOverview;
  }

  /** Show a section (its key) with optional parameters. */
  async show(key, params = null) {
    const k = this.list.some((s) => s.key === key) ? key : 'overview';
    this._reads.clear();
    let section = this.sections.get(k);
    if (!section) {
      const Kind = await this._sectionClass(k);
      section = new Kind(this);
      this.sections.set(k, section);
    }
    for (const a of this.nav.querySelectorAll('a')) {
      if (a.dataset.section === k) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    const changed = this.current !== k;
    if (changed || !this.main.contains(section.el)) {
      clear(this.main);
      this.main.append(section.el);
    }
    this.current = k;
    if (changed && typeof window !== 'undefined') window.scrollTo(0, 0);
    await section.show(params || {});
  }

  /** Move to another section (through the application, so the address changes too). */
  go(key, params = null) {
    this.app.showExpert(routeForExpertSection(key, this.list), params);
  }

  /** An operation that only reads; answers are shared until something changes. */
  read(op, body = {}) {
    const key = `${op} ${JSON.stringify(body)}`;
    if (!this._reads.has(key)) {
      const p = this.backend.expert(op, body);
      this._reads.set(key, p);
      p.catch(() => this._reads.delete(key));
    }
    return this._reads.get(key);
  }

  /** An operation that saves; never repeated automatically. */
  async write(op, body = {}) {
    try {
      return await this.backend.expert(op, body);
    } finally {
      this._reads.clear();
    }
  }

  /** For the browser tests. */
  debugState() {
    return { section: this.current, sections: [...this.sections.keys()] };
  }
}
