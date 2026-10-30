// The adjudication queue of the expert area (docs/web/admin.md, "Adjudication"), in the manner of a
// screening tool's conflict list: every recording (or window of one, or set of corrections) that two
// or more people annotated, with its status, its conflicts and how many are decided. Tabs show what is
// ready, in progress, finished and still waiting; Start opens the recording from this computer and
// starts the adjudication (its versions are fixed then), Continue goes back to one's own where it was
// left. Nobody adjudicates what they annotated themselves.

import { h, clear } from '../ui/dom.js';
import { card, chip, dataTable, loading, messageArea, recordingName, sectionHead, shareBar, tabBar } from '../admin/ui.js';
import { whenText } from '../admin/model.js';
import { QUEUE_TABS, STATUS_TEXT, peopleText, queueAction, queueSummary, tabCounts, tabRows, windowText } from './model.js';
import { startAdjudication } from './adjudicate.js';

const STATUS_KIND = { ready: 'warning', adjudicating: 'active', adjudicated: 'done', collecting: '', agreed: '' };

export class QueueSection {
  constructor(area) {
    this.area = area;
    this.msg = messageArea();
    this.tab = 'ready';
    this.units = [];
    this.summary = h('p.subtitle.adj-summary', { role: 'status' });
    this.tabs = tabBar(QUEUE_TABS.map((t) => ({ key: t.key, title: t.title })), (key) => this._select(key), this.tab);
    this.table = dataTable(this._columns(), [], { empty: 'Nothing is ready for adjudication.', pageSize: 25, sortable: true, caption: 'Adjudication queue',
      rowKey: (u) => u.unit_id });
    this.body = h('div.admin-stack', {}, loading());
    this.el = h('section.admin-section', { 'data-section': 'queue' },
      sectionHead('Adjudication', 'When two or more people have annotated the same recording, their versions are compared with the agreement analysis\'s matching rules, and every '
        + 'disagreement is a conflict to decide: a mark only one of them made, a different type, a start or end far apart, or different channels. '
        + 'Decide each one on the EEG; the result is a new adjudicated version, and the originals stay as they were saved.'),
      this.msg, this.body);
  }

  _columns() {
    return [
      { title: 'Recording', sort: (u) => u.recording_id, render: (u) => h('span', {}, recordingName(u.recording_id, u.file_name),
        h('span.caption.block', {}, u.kind === 'corrections' ? `Corrections of ${u.corrected.annotator_id}'s version ${u.corrected.attempt}` : windowText(u.window))) },
      { title: 'Annotators', sort: (u) => peopleText(u), render: (u) => h('span', {}, peopleText(u),
        u.saved < u.k ? h('span.caption.block', {}, `${u.saved} of ${u.k} saved`) : null) },
      { title: 'Conflicts', num: true, sort: (u) => u.conflicts ?? -1, render: (u) => (u.conflicts === null || u.conflicts === undefined ? '–' : String(u.conflicts)) },
      { title: 'Decided', sort: (u) => (u.conflicts ? u.decided / u.conflicts : -1), render: (u) => (u.conflicts
        ? h('span', {}, shareBar(u.decided / u.conflicts), h('span.caption.block', {}, `${u.decided} of ${u.conflicts}`)) : h('span.caption', {}, '–')) },
      { title: 'Adjudicator', sort: (u) => u.adjudicator_id || '', render: (u) => (u.adjudicator_id ? h('span', {}, u.adjudicator_id, u.yours ? h('span.caption', {}, ' (you)') : null) : '–') },
      { title: 'Status', sort: (u) => u.status, render: (u) => h('span', {}, chip(STATUS_TEXT[u.status] || u.status, STATUS_KIND[u.status] || ''),
        u.own ? h('span.caption.block', {}, 'Your own work') : null,
        u.finished_at ? h('span.caption.block', {}, whenText(u.finished_at)) : null) },
      { title: '', render: (u) => this._action(u) },
    ];
  }

  _action(u) {
    const a = queueAction(u);
    if (!a) return null;
    return h(`button.btn.small${a.op === 'start' ? '.primary' : ''}`, { type: 'button', 'data-log': `adjudication-${a.op}`, 'data-unit': u.unit_id,
      onclick: () => startAdjudication(this.area.app, { unitId: u.unit_id, mode: a.op === 'view' ? 'view' : 'decide', msg: this.msg }) }, a.label);
  }

  _select(key) {
    this.tab = key;
    this.table.setEmpty({ ready: 'Nothing is ready for adjudication. A recording is ready once everyone given it has saved it and their versions disagree.',
      progress: 'No adjudication is in progress.', finished: 'No adjudication has been finished yet.',
      waiting: 'Nothing is waiting: every recording given to two or more people has been saved by all of them.', all: 'No recording has been given to two or more people yet.' }[key] || '');
    this.table.update(tabRows(this.units, key));
  }

  async show() {
    this.msg.clear();
    clear(this.body);
    this.body.append(loading());
    let got;
    try {
      got = await this.area.read('adjudication_list', {});
    } catch (exc) {
      clear(this.body);
      this.msg.problem(exc);
      return;
    }
    this.units = got.units || [];
    const counts = tabCounts(this.units);
    for (const b of this.tabs.querySelectorAll('[data-tab]')) {
      const t = QUEUE_TABS.find((x) => x.key === b.dataset.tab);
      b.textContent = `${t.title} (${counts[t.key]})`;
    }
    this.summary.textContent = queueSummary(this.units);
    clear(this.body);
    this.body.append(card('', this.summary, this.tabs, this.table,
      h('p.caption', {}, 'The decisions are kept by the study as you make them, so you can stop at any time and continue later. Finished adjudications become training references in Training, and their conflicts appear in the Library.')));
    if (!counts.ready && counts.progress) this.tab = 'progress';
    this.tabs.select(this.tab);
  }
}
