// The admin area: where lead researchers run the study (docs/web/admin.md). A header, the menu of
// sections in four groups (Study, People, Data, Settings) and the section shown. Each group folds
// away with its heading, remembered in this browser for each administrator. Each section is
// addressed by a plain hash (#admin, #admin-recordings, ...), so the browser's Back and Forward
// move between them and the page works where only such a hash survives. Sections are made once
// and kept, so work in progress (adding recordings, an analysis) carries on while another section
// is shown. Find, in the header, jumps to a person or a recording.
//
// Every operation goes through backend.admin(op, body) (docs/web/api.md, "Administration").
// Answers to reads are shared between the parts of a section until the next change or the next
// visit to a section, so a slow study is asked once.

import { h, clear } from '../ui/dom.js';
import { appHeader, icon } from '../views/common.js';
import { local } from '../util.js';
import { GROUPS, SECTIONS, findMatches, foldedGroups, groupOf, routeForSection, sectionsOf } from './model.js';
import { OverviewSection } from './overview.js';
import { ProgressSection } from './progress.js';
import { AnnotatorsSection } from './annotators.js';
import { RecordingsSection } from './recordings.js';
import { AssignmentsSection } from './assignments.js';
import { TrainingSection } from './training.js';
import { AnalysesSection } from './analyses.js';
import { ResultsSection } from './results.js';
import { RecordsSection } from './records.js';
import { SettingsSection } from './settings.js';

const KINDS = {
  overview: OverviewSection, progress: ProgressSection, annotators: AnnotatorsSection, recordings: RecordingsSection,
  assignments: AssignmentsSection, training: TrainingSection, analyses: AnalysesSection, results: ResultsSection,
  records: RecordsSection, settings: SettingsSection,
};

const CSS_HREF = new URL('../../admin.css', import.meta.url).href;
const FOLD_KEY = 'electroclean.admin.menu';

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

/** Which groups an administrator folded away, kept in this browser only (a convenience). */
function readFolds(aid) {
  try {
    const all = local.get(FOLD_KEY, {});
    return foldedGroups(all && typeof all === 'object' ? all[aid] : null);
  } catch { return {}; }
}

function writeFolds(aid, folds) {
  try {
    const all = local.get(FOLD_KEY, {}) || {};
    local.set(FOLD_KEY, { ...(typeof all === 'object' ? all : {}), [aid]: folds });
  } catch { /* not kept: the menu opens unfolded next time */ }
}

export class AdminArea {
  constructor(app) {
    this.app = app;
    this.backend = app.backend;
    this.annotatorId = app.me.annotator_id;
    this.sections = new Map();
    this.current = null;
    this._reads = new Map();
    this.folds = readFolds(this.annotatorId);
    this.nav = this._buildNav();
    this.main = h('main.admin-main', { id: 'admin-main' });
    this.find = this._buildFind();
    const demo = this.backend.isDemo
      ? h('aside.note.admin-demo-note', { 'aria-label': 'Demonstration' }, 'Demonstration: everything here is kept in this browser. The analyses, consensus references and the results zip need a study server or Firebase.')
      : null;
    this.el = h('div.view.admin', { 'data-view': 'admin' }, appHeader(app, { admin: true, tools: this.find }),
      h('div.admin-layout', {}, this.nav, h('div.admin-body', {}, demo, this.main)));
  }

  ready() { return loadStyles(); }

  get isFirebase() { return this.backend.kind === 'firebase'; }

  get isDemo() { return Boolean(this.backend.isDemo); }

  /** The label catalogue as the study gave it (with each label's parent term, where known). */
  get labels() { return (this.app.me && this.app.me.catalogue && this.app.me.catalogue.labels) || []; }

  get catalogue() { return this.app.catalogue; }

  // ------------------------------------------------------------------- menu
  _buildNav() {
    const nav = h('nav.admin-nav', { 'aria-label': 'Sections of the admin area' });
    this.groupEls = new Map();
    for (const g of GROUPS) {
      const listId = `admin-menu-${g.key}`;
      const toggle = h('button.admin-group-toggle', { type: 'button', 'aria-controls': listId, 'data-group': g.key,
        onclick: () => this.fold(g.key, !this.folds[g.key]) }, icon('chevron-down'), h('span', {}, g.title));
      const list = h('ul', { id: listId }, sectionsOf(g.key).map((s) => h('li', {},
        h('a.admin-nav-link', { href: `#${s.route}`, 'data-section': s.key, 'data-n': String(SECTIONS.indexOf(s) + 1).padStart(2, '0') }, s.title))));
      const el = h('div.admin-group', { 'data-group': g.key }, toggle, list);
      this.groupEls.set(g.key, { el, toggle, list });
      nav.append(el);
    }
    this._applyFolds();
    return nav;
  }

  /** Fold a group of the menu away (or open it again); remembered for this administrator. */
  fold(group, folded) {
    if (folded) this.folds[group] = true; else delete this.folds[group];
    writeFolds(this.annotatorId, this.folds);
    this._applyFolds();
  }

  _applyFolds() {
    const open = this.current ? groupOf(this.current) : null;
    for (const [key, { el, toggle, list }] of this.groupEls) {
      const folded = Boolean(this.folds[key]);
      toggle.setAttribute('aria-expanded', String(!folded));
      el.classList.toggle('folded', folded);
      // The section shown stays in view even inside a folded group.
      for (const li of list.children) li.hidden = folded && !(key === open && li.querySelector(`[data-section="${this.current}"]`));
    }
  }

  // -------------------------------------------------------------------- find
  _buildFind() {
    const listId = 'admin-find-list';
    const input = h('input.field.admin-find-input', { type: 'search', placeholder: 'Find a person or recording', 'aria-label': 'Find a person or recording',
      autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-autocomplete': 'list' });
    const list = h('ul.admin-find-list', { id: listId, role: 'listbox', hidden: true });
    const wrap = h('div.admin-find', { role: 'search' }, input, list);
    let matches = [];
    let active = -1;
    let data = null;
    const load = async () => {
      if (data) return data;
      const [u, r] = await Promise.all([this.read('users_list').catch(() => ({ users: [] })), this.read('recordings_list').catch(() => ({ recordings: [] }))]);
      data = { users: u.users || [], recordings: r.recordings || [] };
      setTimeout(() => { data = null; }, 60000); // asked again a minute later
      return data;
    };
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
    const mark = (i) => {
      active = i;
      [...list.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
      if (i >= 0 && list.children[i]) input.setAttribute('aria-activedescendant', list.children[i].id);
      else input.removeAttribute('aria-activedescendant');
    };
    const choose = (m) => {
      close();
      input.value = '';
      if (m.kind === 'person') this.go('annotators', { annotator: m.id });
      else this.go('recordings', { recording: m.id, scope: m.scope });
    };
    const fill = async () => {
      const q = input.value;
      const d = await load();
      if (q !== input.value) return;
      matches = findMatches(q, d);
      clear(list);
      if (!q.trim()) { close(); return; }
      if (!matches.length) list.append(h('li.admin-find-none', { role: 'option', 'aria-disabled': 'true', id: 'admin-find-none' }, 'Nothing matches. Try an annotator ID, a name or part of a file name.'));
      matches.forEach((m, i) => list.append(h('li.admin-find-item', { role: 'option', id: `admin-find-${i}`, 'aria-selected': 'false',
        onmousedown: (e) => { e.preventDefault(); choose(m); } },
      h('span.caption', {}, m.kind === 'person' ? 'Person' : 'Recording'), h('span.admin-find-text', {}, m.text), m.extra && m.extra !== m.text ? h('span.caption.block', {}, m.extra) : null)));
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      mark(matches.length ? 0 : -1);
    };
    input.addEventListener('input', () => { fill().catch(() => close()); });
    input.addEventListener('focus', () => { load().catch(() => {}); });
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!matches.length) return;
        e.preventDefault();
        mark((active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (matches[active >= 0 ? active : 0]) choose(matches[active >= 0 ? active : 0]);
      } else if (e.key === 'Escape') {
        close();
      }
    });
    wrap.input = input;
    return wrap;
  }

  // ---------------------------------------------------------------- sections
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
    this._applyFolds();
    if (changed) {
      const heading = section.el.querySelector('h1');
      if (heading && document.activeElement && (this.nav.contains(document.activeElement) || this.find.contains(document.activeElement))) heading.focus({ preventScroll: true });
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
    return { section: this.current, sections: [...this.sections.keys()], folded: Object.keys(this.folds) };
  }
}
