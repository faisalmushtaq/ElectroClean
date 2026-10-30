// The adjudication queue of the expert area (docs/web/admin.md, "Adjudication"), in the manner of a
// screening tool's conflict list: every recording (or part of one, or set of corrections) that two or
// more people annotated, with its status, its conflicts and how many are decided. A search finds a
// recording, a person or a note; tabs show what is ready, in progress, finished and still waiting, and
// the queue opens on one's own adjudications in progress when there are any. The summary counts what
// can be adjudicated honestly (parts and corrections beside the recordings they belong to), says which
// rows are one's own work, and totals the conflicts left. Start opens the recording from this computer
// and starts the adjudication (its versions are fixed then); Continue goes back to one's own where it
// was left; a finished one opens to read (and, for its adjudicator, to reopen) and can be made a
// training reference. Nobody adjudicates what they annotated themselves.

import { h, clear } from '../ui/dom.js';
import { showDialog } from '../ui/dialog.js';
import { logger } from '../log/logger.js';
import { card, chip, dataTable, field, loading, messageArea, recordingName, sectionHead, select, shareBar, tabBar, textInput } from '../admin/ui.js';
import { whenText } from '../admin/model.js';
import {
  QUEUE_TABS, STATUS_TEXT, blockedText, canBecomeReference, defaultTab, peopleText, queueAction, queueOrder, queueSummary, searchUnits, tabRows,
  unitWhat,
} from './model.js';
import { startAdjudication } from './adjudicate.js';

const STATUS_KIND = { ready: 'warning', adjudicating: 'active', adjudicated: 'done', collecting: '', agreed: '' };
const USE_TEXT = [['practice', 'Practice: trainees annotate it and get feedback'], ['assessment', 'Assessment: it scores the blind assessment'],
  ['guided', 'Guided: trainees mark it alongside the reference']];

export class QueueSection {
  constructor(area) {
    this.area = area;
    this.msg = messageArea();
    this.tab = null;
    this.units = [];
    this.sets = [];
    this.summary = h('p.subtitle.adj-summary', { role: 'status' });
    this.tabs = tabBar(QUEUE_TABS.map((t) => ({ key: t.key, title: t.title })), (key) => this._select(key), 'ready');
    this.search = textInput({ placeholder: 'Search a recording, a person or a note' });
    this.search.setAttribute('aria-label', 'Search the queue');
    this.search.dataset.log = 'adjudication-search';
    this.search.addEventListener('input', () => { clearTimeout(this._typing); this._typing = setTimeout(() => this._filter(), 200); });
    this.found = h('span.caption', { role: 'status' });
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
        h('span.caption.block', {}, unitWhat(u)), u.notes ? h('span.caption.block', {}, u.notes) : null) },
      { title: 'Annotators', sort: (u) => peopleText(u), render: (u) => h('span', {}, peopleText(u),
        u.saved < u.k ? h('span.caption.block', {}, `${u.saved} of ${u.k} saved`) : null) },
      { title: 'Conflicts', num: true, sort: (u) => u.conflicts ?? -1, render: (u) => (u.conflicts === null || u.conflicts === undefined ? '–' : String(u.conflicts)) },
      { title: 'Decided', sort: (u) => (u.conflicts ? u.decided / u.conflicts : -1), render: (u) => (u.conflicts
        ? h('span', {}, shareBar(u.decided / u.conflicts), h('span.caption.block', {}, `${u.decided} of ${u.conflicts}`)) : h('span.caption', {}, '–')) },
      { title: 'Adjudicator', sort: (u) => u.adjudicator_id || '', render: (u) => (u.adjudicator_id ? h('span', {}, u.adjudicator_id, u.yours ? h('span.caption', {}, ' (you)') : null) : '–') },
      { title: 'Status', sort: (u) => u.status, render: (u) => h('span', {}, chip(STATUS_TEXT[u.status] || u.status, STATUS_KIND[u.status] || ''),
        blockedText(u) ? h('span.caption.block.adj-blocked', {}, blockedText(u)) : null,
        u.finished_at ? h('span.caption.block', {}, whenText(u.finished_at)) : null) },
      { title: '', render: (u) => this._actions(u) },
    ];
  }

  _actions(u) {
    const a = queueAction(u);
    const out = [];
    if (a) {
      out.push(h('button.btn.small', { type: 'button', 'data-log': `adjudication-${a.op}`, 'data-unit': u.unit_id,
        onclick: () => startAdjudication(this.area.app, { unitId: u.unit_id, mode: a.op === 'view' ? 'view' : 'decide', msg: this.msg }) }, a.label));
    }
    if (u.recording_id) {
      out.push(h('button.btn.small.quiet', { type: 'button', 'data-log': 'adjudication-overlay', 'data-unit': u.unit_id,
        title: 'Everyone\'s marks on this recording, with these annotators in lanes',
        onclick: async () => (await import('./overlay.js')).startOverlay(this.area.app, { recording_id: u.recording_id,
          focus: (u.annotators || []).map((a) => a.annotator_id), include: u.status === 'adjudicated' ? ['adjudicated'] : [] },
        { route: 'expert-queue', params: null }) }, 'Everyone\'s marks'));
    }
    if (canBecomeReference(u)) {
      out.push(h('button.btn.small.quiet', { type: 'button', 'data-log': 'adjudication-make-reference', 'data-unit': u.unit_id,
        onclick: () => this.makeReference(u) }, 'Make it a training reference…'));
    }
    return out.length ? h('span.btn-row.tight', {}, out) : null;
  }

  _rows() {
    return queueOrder(searchUnits(tabRows(this.units, this.tab), this.search.value));
  }

  _filter() {
    const rows = this._rows();
    const all = tabRows(this.units, this.tab).length;
    this.found.textContent = this.search.value.trim() ? `${rows.length} of ${all} shown` : '';
    this.table.update(rows);
    if (this.search.value.trim()) logger.event('adjudication_queue_searched', { shown: rows.length, of: all }); // the words typed are never logged
  }

  _select(key) {
    this.tab = key;
    this.table.setEmpty({ ready: 'Nothing is ready for adjudication. A recording is ready once everyone given it has saved it and their versions disagree.',
      progress: 'No adjudication is in progress.', finished: 'No adjudication has been finished yet.',
      waiting: 'Nothing is waiting: every recording given to two or more people has been saved by all of them.', all: 'No recording has been given to two or more people yet.' }[key] || '');
    this._filter();
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
    this.sets = got.sets || [];
    for (const b of this.tabs.querySelectorAll('[data-tab]')) {
      const t = QUEUE_TABS.find((x) => x.key === b.dataset.tab);
      b.textContent = `${t.title} (${tabRows(this.units, t.key).length})`;
    }
    this.summary.textContent = queueSummary(this.units);
    clear(this.body);
    this.body.append(card('', this.summary, h('div.queue-tools', {}, this.search, this.found), this.tabs, this.table,
      h('p.caption', {}, 'The decisions are kept by the study as you make them, so you can stop at any time and continue later. A finished adjudication of a whole recording can be made a training reference here, or in Training; its conflicts appear in the Library.')));
    if (!this.tab) this.tab = defaultTab(this.units);
    this.tabs.select(this.tab);
  }

  /** A finished adjudication as a reference of a set: the set and the use, then adjudication_reference (sent once). */
  async makeReference(u) {
    if (!this.sets.length) { this.msg.show('note', 'There is no reference set yet. An administrator makes reference sets in Training.'); return null; }
    const set = select(this.sets.map((s) => [s.set_id, s.name === s.set_id ? s.set_id : `${s.name} (${s.set_id})`]), this.sets[0].set_id);
    const use = select(USE_TEXT, 'practice');
    const msg = messageArea();
    const body = h('div.admin-stack', {},
      h('p.dialog-text', {}, `The adjudicated version of ${u.file_name} (${peopleText(u)}, adjudicated by ${u.adjudicator_id}) becomes the reference of this recording in the set. The versions it compared are kept with it as its sources.`),
      field('Reference set', set), field('Used for', use), msg);
    let made = null;
    for (;;) {
      const go = await showDialog({ title: 'Make it a training reference', body, logText: 'make an adjudication a training reference', className: 'reference-dialog',
        buttons: [{ label: 'Cancel', value: false }, { label: 'Make it a reference', value: true, kind: 'primary' }], cancelValue: false });
      if (!go) return null;
      try {
        made = await this.area.write('adjudication_reference', { unit_id: u.unit_id, set_id: set.value, use: use.value });
        break;
      } catch (exc) {
        msg.problem(exc);
      }
    }
    logger.event('adjudication_reference_made', { use: use.value });
    this.msg.show('success', `${u.file_name} is now a ${use.value} reference of ${set.value}, made from the adjudicated version.`);
    return made;
  }
}
