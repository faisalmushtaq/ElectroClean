// The admin area: where lead researchers run the study (docs/web/admin.md). A header, the list
// of sections and the section shown. Each section is addressed by a plain hash (#admin,
// #admin-recordings, ...), so the browser's Back and Forward move between them and the page works
// where only such a hash survives. Sections are made once and kept, so work in progress (adding
// recordings, an analysis) carries on while another section is shown.
//
// Every operation goes through backend.admin(op, body) (docs/web/api.md, "Administration").
// Answers to reads are shared between the parts of a section until the next change or the next
// visit to a section, so a slow study is asked once.

import { h, clear } from '../ui/dom.js';
import { appHeader } from '../views/common.js';
import { SECTIONS, routeForSection } from './model.js';
import { OverviewSection } from './overview.js';
import { AnnotatorsSection } from './annotators.js';
import { RecordingsSection } from './recordings.js';
import { AssignmentsSection } from './assignments.js';
import { TrainingSection } from './training.js';
import { AnalysesSection } from './analyses.js';
import { ResultsSection } from './results.js';
import { RecordsSection } from './records.js';
import { SettingsSection } from './settings.js';

const KINDS = {
  overview: OverviewSection, annotators: AnnotatorsSection, recordings: RecordingsSection, assignments: AssignmentsSection,
  training: TrainingSection, analyses: AnalysesSection, results: ResultsSection, records: RecordsSection, settings: SettingsSection,
};

const CSS_HREF = new URL('../../admin.css', import.meta.url).href;

/** The admin area's own styles, loaded once (annotators' pages never need them). */
function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-admin-css]')) return Promise.resolve();
  return new Promise((resolve) => {
    const link = h('link', { rel: 'stylesheet', href: CSS_HREF, 'data-admin-css': '' });
    link.addEventListener('load', () => resolve());
    link.addEventListener('error', () => resolve());
    setTimeout(resolve, 3000);
    document.head.append(link);
  });
}

export class AdminArea {
  constructor(app) {
    this.app = app;
    this.backend = app.backend;
    this.annotatorId = app.me.annotator_id;
    this.sections = new Map();
    this.current = null;
    this._reads = new Map();
    this.nav = h('nav.admin-nav', { 'aria-label': 'Sections of the admin area' },
      h('ul', {}, SECTIONS.map((s) => h('li', {}, h('a.admin-nav-link', { href: `#${s.route}`, 'data-section': s.key }, s.title)))));
    this.main = h('main.admin-main', { id: 'admin-main' });
    const demo = this.backend.isDemo
      ? h('p.note.admin-demo-note', {}, 'Demonstration: everything here is kept in this browser. The analyses, consensus references and the results zip need a study server or Firebase.')
      : null;
    this.el = h('div.view.admin', { 'data-view': 'admin' }, appHeader(app, { admin: true }),
      h('div.admin-layout', {}, this.nav, h('div.admin-body', {}, demo, this.main)));
  }

  ready() { return loadStyles(); }

  get isFirebase() { return this.backend.kind === 'firebase'; }

  get isDemo() { return Boolean(this.backend.isDemo); }

  /** The label catalogue as the study gave it (with each label's parent term, where known). */
  get labels() { return (this.app.me && this.app.me.catalogue && this.app.me.catalogue.labels) || []; }

  get catalogue() { return this.app.catalogue; }

  /** Show a section (its key) with optional parameters, such as the annotator to assign to. */
  async show(key, params = null) {
    const k = KINDS[key] ? key : 'overview';
    this._reads.clear();
    let section = this.sections.get(k);
    if (!section) {
      section = new KINDS[k](this);
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
    if (changed) {
      const heading = section.el.querySelector('h1');
      if (heading && document.activeElement && this.nav.contains(document.activeElement)) heading.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
    await section.show(params || {});
  }

  /** Move to another section (through the application, so the address changes too). */
  go(key, params = null) {
    this.app.showAdmin(routeForSection(key), params);
  }

  /** An operation that only reads; answers are shared until something changes. */
  read(op, body = {}) {
    const key = `${op} ${JSON.stringify(body)}`;
    if (!this._reads.has(key)) {
      const p = this.backend.admin(op, body);
      this._reads.set(key, p);
      p.catch(() => this._reads.delete(key));
    }
    return this._reads.get(key);
  }

  /** An operation that changes the study; never repeated automatically. */
  async write(op, body = {}) {
    try {
      return await this.backend.admin(op, body);
    } finally {
      this._reads.clear();
    }
  }

  /** For the browser tests. */
  debugState() {
    return { section: this.current, sections: [...this.sections.keys()] };
  }
}
