// Overview: the study in numbers, the hand-outs open and the people with overdue work, the latest changes
// from the audit log and the latest saved work.

import { h, clear } from '../ui/dom.js';
import { MODES, routeForSection, whenText } from './model.js';
import { auditSummary, opText } from './audit_words.js';
import { card, chip, dataTable, loading, messageArea, recordingName, sectionHead } from './ui.js';

export class OverviewSection {
  constructor(area) {
    this.area = area;
    this.msg = messageArea();
    this.tiles = h('div.stat-tiles');
    this.due = h('div.overview-due');
    this.recent = dataTable([
      { title: 'When', render: (e) => whenText(e.at) },
      { title: 'Who', render: (e) => e.by },
      { title: 'What', render: (e) => h('span', {}, h('span.caption.block', {}, opText(e.op)), auditSummary(e, this.recentEntries || [])) },
    ], [], { empty: 'Nothing has been changed yet.', pageSize: 10 });
    this.saved = dataTable([
      { title: 'When', render: (r) => whenText(r.at) },
      { title: 'Annotator', render: (r) => r.annotator_id },
      { title: 'Recording', render: (r) => recordingName(r.recording_id) },
      { title: 'Mode', render: (r) => (MODES[r.mode] || r.mode) + (r.context_id ? ` (${r.context_id})` : '') },
    ], [], { empty: 'Nobody has saved any work yet.', pageSize: 10 });
    const go = (key, text) => h('button.btn', { type: 'button', onclick: () => area.go(key) }, text);
    this.el = h('section.admin-section', { 'data-section': 'overview' },
      sectionHead('Overview', 'The study at a glance. Choose a section to change something.'),
      this.msg, this.tiles, this.due,
      h('div.btn-row.quick-links', {}, go('recordings', 'Add recordings'), go('annotators', 'Add an annotator'),
        go('assignments', 'Assign recordings'), go('handouts', 'Hand out recordings'), go('progress', 'See progress')),
      h('div.admin-grid', {},
        card('Recent changes', this.recent, h('div.btn-row', {}, h('button.btn.quiet', { type: 'button', onclick: () => area.go('records') }, 'All records…'))),
        card('Recently saved work', this.saved)));
  }

  async show() {
    this.msg.clear();
    clear(this.tiles);
    this.tiles.append(loading());
    let o;
    try {
      o = await this.area.read('overview');
    } catch (exc) {
      clear(this.tiles);
      this.msg.problem(exc);
      return;
    }
    const c = o.counts || {};
    // Each figure links to the section behind it (Open problems to Problems, and so on).
    const tile = (n, label, note = '', to = null) => h(to ? 'a.stat-tile' : 'div.stat-tile', { href: to ? `#${routeForSection(to)}` : null, 'data-to': to },
      h('span.stat-value', {}, String(n ?? 0)), h('span.stat-label', {}, label), note ? h('span.caption', {}, note) : null);
    clear(this.tiles);
    this.tiles.append(
      tile(c.recordings, 'Recordings', 'registered for the study', 'recordings'),
      tile(c.annotators, 'Annotators', `${c.experts ? `${c.experts} expert${c.experts === 1 ? '' : 's'} ` : ''}and ${c.admins ?? 0} administrator${c.admins === 1 ? '' : 's'}`, 'annotators'),
      tile(c.assignments, 'Assigned', 'of every kind, training included (Progress counts each kind apart)', 'assignments'),
      tile(c.done, 'Done', c.assignments ? `${Math.round((100 * (c.done || 0)) / c.assignments)}% of the assigned` : '', 'progress'),
      tile(c.in_progress, 'In progress', '', 'progress'),
      tile(c.todo, 'To do', '', 'progress'),
      tile(c.problems_open, 'Open problems', c.unusable ? `${c.unusable} cannot be annotated` : 'reported by annotators', 'problems'),
      tile(c.reviewed, 'Reviewed', 'saved recordings with a review', 'results'));
    clear(this.due);
    if (c.overdue || c.handouts_open) {
      const late = c.overdue ? `${c.overdue} ${c.overdue === 1 ? 'person has' : 'people have'} overdue work` : 'Nobody has overdue work';
      this.due.append(h(c.overdue ? 'div.banner.overview-late' : 'p.caption.overview-late', { role: 'status' },
        h('span', {}, c.overdue ? chip('Overdue', 'warning') : null, ` ${late}, across ${c.handouts_open} open hand-out${c.handouts_open === 1 ? '' : 's'}. `),
        h('a', { href: `#${routeForSection('handouts')}`, 'data-to': 'handouts' }, 'See the hand-outs')));
    }
    this.recentEntries = o.recent || [];
    this.recent.update(this.recentEntries);
    this.saved.update(o.last_saved || []);
  }
}
