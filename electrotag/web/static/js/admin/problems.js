// Problems: the problems annotators reported with recordings (docs/web/admin.md, "Problems"). A
// table with filters (open or resolved, reason, person, recording) and a CSV download, and for each
// report: resolve it with a note, return the recording to the annotator's to-do list (which undoes
// "cannot be annotated"), or give it to someone else. Reports are never deleted.

import { h, clear } from '../ui/dom.js';
import { MODES, whenText } from './model.js';
import { actionButton, card, chip, dataTable, downloadText, field, messageArea, recordingName, sectionHead, select, textInput } from './ui.js';

export const REASON_TEXT = Object.freeze({
  file_wont_open: 'The file will not open',
  wrong_recording: 'This is the wrong recording',
  bad_channels: 'Channels are flat, missing or disconnected',
  too_noisy: 'Too noisy or too short to annotate',
  other: 'Something else',
});
const RESOLUTION_TEXT = Object.freeze({ resolved: 'Resolved', returned: 'Returned to the annotator', reassigned: 'Given to someone else' });
export const CSV_COLUMNS = ['problem_id', 'reported_at', 'annotator_id', 'recording_id', 'file_name', 'mode', 'reason', 'note', 'outcome', 'where',
  'item_status', 'state', 'resolution', 'resolution_note', 'resolved_at', 'resolved_by', 'reassigned_to', 'unusable_now'];

/** Comma-separated values with every cell quoted (notes hold commas and quotes). */
export function csvText(columns, rows) {
  const cell = (v) => `"${(v === null || v === undefined ? '' : String(v)).replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
  return [columns.map(cell).join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

/** The reports a filter keeps ({state, reason, person, recording}: '' for any). */
export function filterProblems(rows, { state = '', reason = '', person = '', recording = '' } = {}) {
  const p = person.trim().toUpperCase();
  const q = recording.trim().toLowerCase();
  return rows.filter((r) => (!state || r.state === state) && (!reason || r.reason === reason) && (!p || r.annotator_id === p)
    && (!q || String(r.recording_id).toLowerCase().includes(q) || String(r.file_name || '').toLowerCase().includes(q)));
}

export class ProblemsSection {
  constructor(area) {
    this.area = area;
    this.all = [];
    this.msg = messageArea();
    this.tiles = h('div.stat-tiles');
    this.state = select([['open', 'Open'], ['resolved', 'Resolved'], ['', 'Open and resolved']], 'open');
    this.reason = select([['', 'Any reason'], ...Object.entries(REASON_TEXT)], '');
    this.person = textInput({ placeholder: 'Annotator ID' });
    this.recording = textInput({ placeholder: 'Part of a file name' });
    for (const el of [this.state, this.reason]) el.addEventListener('change', () => this._draw());
    for (const el of [this.person, this.recording]) el.addEventListener('input', () => this._draw());
    this.detail = h('div.admin-stack');
    this.table = dataTable([
      { title: 'Reported', sort: (r) => r.reported_at, render: (r) => whenText(r.reported_at) },
      { title: 'Annotator', sort: (r) => r.annotator_id, render: (r) => h('span', {}, h('b', {}, r.annotator_id), r.display_name ? h('span.caption.block', {}, r.display_name) : null) },
      { title: 'Recording', sort: (r) => r.recording_id, render: (r) => h('span', {}, recordingName(r.recording_id, r.file_name), r.mode !== 'standard' ? h('span.caption.block', {}, MODES[r.mode] || r.mode) : null) },
      { title: 'Reason', sort: (r) => r.reason, render: (r) => h('span', {}, r.reason_text || REASON_TEXT[r.reason] || r.reason, r.note ? h('span.caption.block.problem-note-text', {}, `“${r.note}”`) : null) },
      { title: 'Outcome', sort: (r) => r.outcome, render: (r) => (r.outcome === 'unusable' ? chip(r.unusable_now ? 'Cannot be annotated' : 'Was set aside') : 'Carried on') },
      { title: 'State', sort: (r) => r.state, render: (r) => (r.state === 'open' ? chip('Open', 'active') : h('span', {}, chip(RESOLUTION_TEXT[r.resolution] || 'Resolved', 'done'), r.resolution_note ? h('span.caption.block', {}, r.resolution_note) : null)) },
      { title: '', cls: 'actions', render: (r) => (r.state === 'open' ? h('button.btn.small', { type: 'button', 'data-log': 'problem-open', onclick: () => this._showDetail(r) }, 'Deal with it…') : null) },
    ], [], { empty: 'No reports match.', pageSize: 25, sortable: true, caption: 'Problem reports', rowKey: (r) => r.problem_id });
    const csv = h('button.btn', { type: 'button', 'data-log': 'problems-csv', onclick: () => this._download() }, 'Download as CSV');
    this.el = h('section.admin-section', { 'data-section': 'problems' },
      sectionHead('Problems', 'Problems annotators reported with recordings: a file that will not open, the wrong recording, flat or missing channels, or one too noisy or too short to annotate.'),
      this.msg, this.tiles, this.detail,
      card('Reports',
        h('div.row.filters.problem-filters', {}, field('State', this.state), field('Reason', this.reason), field('Person', this.person), field('Recording', this.recording)),
        this.table, h('div.btn-row', {}, csv),
        h('p.caption', {}, 'A recording set aside as one that cannot be annotated counts as finished for its annotator and is left out of the agreement analyses. Returning it to the annotator\'s list undoes that. Reports are kept with the results and never deleted.')));
  }

  async show(params = {}) {
    this.msg.clear();
    if (params.annotator) this.person.value = params.annotator;
    try {
      const r = await this.area.read('problems_list');
      this.all = r.problems || [];
      this._tiles(r.counts || {});
    } catch (exc) {
      this.msg.problem(exc);
      return;
    }
    this._draw();
  }

  _tiles(c) {
    clear(this.tiles);
    const tile = (n, label, note) => h('div.stat-tile', {}, h('span.stat-value', {}, String(n ?? 0)), h('span.stat-label', {}, label), note ? h('span.caption', {}, note) : null);
    this.tiles.append(tile(c.open, 'Open reports', 'waiting for the study team'), tile(c.unusable, 'Cannot be annotated', 'recordings set aside now'), tile(c.resolved, 'Resolved'));
  }

  _filters() {
    return { state: this.state.value, reason: this.reason.value, person: this.person.value, recording: this.recording.value };
  }

  _draw() { this.table.update(filterProblems(this.all, this._filters())); }

  _download() {
    const rows = this.table.rows();
    downloadText('problem_reports.csv', csvText(CSV_COLUMNS, rows), 'text/csv;charset=utf-8');
  }

  _showDetail(r) {
    clear(this.detail);
    const msg = messageArea();
    const note = textInput({ placeholder: 'For example: replaced the file', maxlength: 300 });
    const people = select([['', 'Choose a person…']], '');
    this.area.read('users_list').then((u) => {
      for (const x of (u.users || []).filter((p) => p.status === 'active' && p.role === 'annotator' && p.annotator_id !== r.annotator_id)) {
        people.append(h('option', { value: x.annotator_id }, `${x.annotator_id}${x.display_name ? ` (${x.display_name})` : ''}`));
      }
    }).catch(() => {});
    const done = async (text) => {
      clear(this.detail);
      await this.show();
      this.msg.show('success', text);
    };
    const resolve = actionButton('Resolve', { kind: 'primary', working: 'Saving…', msg, log: 'problem-resolve',
      onClick: async () => { await this.area.write('problem_resolve', { problem_id: r.problem_id, note: note.value }); await done(`The report on ${r.file_name} is resolved.`); } });
    const back = r.unusable_now ? actionButton(`Return it to ${r.annotator_id}'s list`, { working: 'Returning…', msg, log: 'problem-return',
      onClick: async () => { await this.area.write('problem_return', { problem_id: r.problem_id, note: note.value }); await done(`${r.file_name} is back on ${r.annotator_id}'s to-do list.`); } }) : null;
    const give = actionButton('Give it to this person', { working: 'Assigning…', msg, log: 'problem-reassign',
      onClick: async () => {
        if (!people.value) { msg.show('note', 'Choose the person to give the recording to.'); return; }
        await this.area.write('problem_reassign', { problem_id: r.problem_id, annotator_id: people.value, note: note.value });
        await done(`${r.file_name} is assigned to ${people.value}, and the report is resolved.`);
      } });
    const close = h('button.btn.quiet', { type: 'button', onclick: () => clear(this.detail) }, 'Close');
    this.detail.append(card(`${r.annotator_id}'s report on ${r.file_name}`,
      h('p', {}, `${r.reason_text || REASON_TEXT[r.reason]}${r.note ? `: “${r.note}”` : '.'} Reported ${whenText(r.reported_at)} from ${r.where === 'annotate' ? 'the annotation view' : 'the home page'}, when the recording was ${String(r.item_status || '').replace('_', ' ') || 'assigned'}.`),
      h('p.caption', {}, r.outcome === 'unusable' ? (r.unusable_now ? `${r.annotator_id} set it aside as one that cannot be annotated.` : 'It was set aside, and is no longer.') : `${r.annotator_id} carried on with it.`),
      field('Note (kept with the report)', note, { hint: 'The annotator sees this note when the recording is returned to their list.' }),
      h('div.btn-row', {}, resolve, back),
      h('h3', {}, 'Give it to someone else'),
      h('div.row.inline-form', {}, people, give),
      msg, h('div.btn-row', {}, close)));
    const head = this.detail.querySelector('h2');
    if (head) { head.tabIndex = -1; head.focus({ preventScroll: false }); }
  }
}
