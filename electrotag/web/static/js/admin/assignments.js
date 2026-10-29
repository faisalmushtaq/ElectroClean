// Assignments: who annotates what. Assign several annotators to several recordings (or all of
// them) in a mode and context, see the status of every assignment, and take one away.

import { h, clear } from '../ui/dom.js';
import { MODES, STATUS, fileParts, plural, setLabel, unassignQuestion, whenText } from './model.js';
import {
  actionButton, card, checkbox, checkList, chip, confirmInline, dataTable, field, messageArea, recordingName, sectionHead, select, textInput,
} from './ui.js';

/**
 * In place of Unassign for a recording its annotator set aside as one that cannot be annotated: that
 * is settled through their problem report (return it to them, or give it to someone else).
 */
export function setAsideButton(area, aid) {
  return h('button.btn.small.quiet', { type: 'button', 'data-log': 'set-aside-problems', title: 'Set aside as one that cannot be annotated: deal with it in Problems',
    onclick: () => area.go('problems', { annotator: aid }) }, 'See the report');
}

export class AssignmentsSection {
  constructor(area) {
    this.area = area;
    this.users = [];
    this.recordings = [];
    this.sets = [];
    this.items = [];
    this.preselect = [];
    this.msg = messageArea();
    this.assignHost = h('div.admin-stack');
    this._buildTable();
    this.el = h('section.admin-section', { 'data-section': 'assignments' },
      sectionHead('Assignments', 'Which recordings each annotator works on, in which mode. Annotators open their next recording from their own list.'),
      this.msg,
      card('Assign recordings', this.assignHost), this.tableCard);
  }

  async show(params) {
    this.msg.clear();
    if (params.annotator) this.preselect = [String(params.annotator).toUpperCase()];
    if (Array.isArray(params.annotators)) this.preselect = params.annotators.map((x) => String(x).toUpperCase());
    // Recordings chosen in the Recordings section, to assign to someone.
    if (Array.isArray(params.recordings)) this.preselectRecordings = [...params.recordings];
    await this.reload();
  }

  async reload() {
    clear(this.assignHost);
    this.assignHost.append(h('p.caption', {}, 'Loading…'));
    try {
      const [u, r, s, a] = await Promise.all([this.area.read('users_list'), this.area.read('recordings_list'),
        this.area.read('sets_list').catch(() => ({ sets: [] })), this.area.read('assignments_list')]);
      this.users = u.users || [];
      this.recordings = r.recordings || [];
      this.sets = s.sets || [];
      this.items = a.items || [];
    } catch (exc) {
      clear(this.assignHost);
      this.msg.problem(exc);
      return;
    }
    this._buildAssign();
    this._fillFilters();
    this._filter();
  }

  // ---------------------------------------------------------------- assign
  _buildAssign() {
    clear(this.assignHost);
    // All ticks the active annotators: switched-off accounts and administrators are ticked one by one.
    const people = checkList(this.users.map((u) => ({ value: u.annotator_id, text: u.annotator_id, notInAll: u.status === 'disabled' || u.role === 'admin',
      extra: [u.display_name, u.status === 'disabled' ? 'switched off' : '', u.role === 'admin' ? 'administrator' : ''].filter(Boolean).join(' · ') })),
    { selected: this.preselect, legend: 'Annotators', name: 'annotators', empty: 'Add accounts on the Annotators page first.' });
    this.preselect = [];
    const mode = select(MODES, 'standard');
    const context = select([['', '–']]);
    const contextField = field('Reference set', context, { hint: 'Training recordings come from a reference set.' });
    const all = checkbox('Every recording (retired ones are left out)');
    const recHost = h('div');
    let recs = null;
    const fillRecordings = () => {
      const scope = mode.value === 'standard' ? 'study' : `set:${context.value}`;
      const list = this.recordings.filter((r) => r.scope === scope);
      clear(recHost);
      recs = checkList(list.map((r) => ({ value: r.recording_id, text: r.file_name || r.recording_id.split('/').pop(),
        extra: [fileParts(r.recording_id).folder, r.retired ? 'retired' : ''].filter(Boolean).join(' · ') })),
      { legend: 'Recordings', name: 'recordings', selected: mode.value === 'standard' ? this.preselectRecordings || [] : [], empty: mode.value === 'standard' ? 'Add recordings on the Recordings page first.' : 'This reference set has no recordings yet.' });
      recHost.append(recs);
      recHost.hidden = all.input.checked;
    };
    const fillContext = () => {
      clear(context);
      if (mode.value === 'standard') context.append(h('option', { value: '' }, '–'));
      else for (const s of this.sets) context.append(h('option', { value: s.set_id }, setLabel(s)));
      contextField.hidden = mode.value === 'standard';
      fillRecordings();
    };
    mode.addEventListener('change', fillContext);
    context.addEventListener('change', fillRecordings);
    all.input.addEventListener('change', () => { recHost.hidden = all.input.checked; });
    fillContext();
    if (this.preselectRecordings && this.preselectRecordings.length) {
      this.preselectRecordings = null;
      requestAnimationFrame(() => recHost.scrollIntoView({ block: 'nearest' }));
    }
    const msg = messageArea();
    const go = actionButton('Assign', {
      kind: 'primary', working: 'Assigning…', msg, log: 'assign',
      onClick: async () => {
        msg.clear();
        const ids = people.values();
        if (!ids.length) throw new Error('Choose at least one annotator.');
        if (mode.value !== 'standard' && !context.value) throw new Error('Choose the reference set the training recordings come from.');
        const body = { annotator_ids: ids, mode: mode.value, context_id: mode.value === 'standard' ? '' : context.value };
        if (all.input.checked) body.all = true;
        else {
          body.recording_ids = recs.values();
          if (!body.recording_ids.length) throw new Error('Choose at least one recording, or tick Every recording.');
        }
        const r = await this.area.write('assign', body);
        await this.reload();
        this.msg.show('success', `Assigned: ${plural(r.added ?? 0, 'new assignment')}${r.already ? `; ${r.already} ${r.already === 1 ? 'was' : 'were'} assigned already` : ''}.`);
      },
    });
    this.assignHost.append(h('div.admin-grid', {}, people, h('div', {},
      h('div.row.wrap', {}, field('Mode', mode, { hint: 'Annotation is the study\'s own work; the training modes use a reference set.' }), contextField),
      all, recHost)), h('div.btn-row', {}, go), msg);
  }

  // ----------------------------------------------------------------- table
  _buildTable() {
    const person = select([['', 'Everyone']]);
    person.setAttribute('aria-label', 'Annotator');
    const status = select([['', 'Every status'], ...Object.entries(STATUS)]);
    status.setAttribute('aria-label', 'Status');
    const mode = select([['', 'Every mode'], ...Object.entries(MODES)]);
    mode.setAttribute('aria-label', 'Mode');
    const search = textInput({ type: 'search', placeholder: 'Search recordings' });
    search.setAttribute('aria-label', 'Search the assignments');
    this.filters = { person, status, mode, search };
    for (const f of Object.values(this.filters)) f.addEventListener('input', () => this._filter());
    this.table = dataTable([
      { title: 'Annotator', render: (i) => h('b', {}, i.annotator_id) },
      { title: 'Recording', render: (i) => recordingName(i.recording_id) },
      { title: 'Mode', render: (i) => (MODES[i.mode] || i.mode) + (i.context_id ? ` (${i.context_id})` : '') },
      { title: 'Status', render: (i) => chip(STATUS[i.status] || i.status, i.status === 'done' ? 'done' : i.status === 'in_progress' ? 'active' : '') },
      { title: 'Last activity', render: (i) => whenText(i.last_activity, { never: '–' }) },
      { title: '', cls: 'actions', render: (i) => (i.status === 'done' ? null : i.status === 'unusable' ? setAsideButton(this.area, i.annotator_id) : this._unassign(i)) },
    ], [], { empty: 'Nothing is assigned yet.', pageSize: 25, caption: 'Assignments' });
    this.summary = h('p.caption', { role: 'status' });
    this.tableCard = card('Every assignment', h('div.row.filters', {}, person, mode, status, search), this.summary, this.table);
  }

  _fillFilters() {
    const p = this.filters.person;
    const keep = p.value;
    clear(p);
    p.append(h('option', { value: '' }, 'Everyone'), ...this.users.map((u) => h('option', { value: u.annotator_id }, u.annotator_id)));
    p.value = [...p.options].some((o) => o.value === keep) ? keep : '';
  }

  _filter() {
    const { person, status, mode, search } = this.filters;
    const q = search.value.trim().toLowerCase();
    const rows = this.items.filter((i) => (!person.value || i.annotator_id === person.value) && (!status.value || i.status === status.value) &&
      (!mode.value || i.mode === mode.value) && (!q || i.recording_id.toLowerCase().includes(q)));
    const done = rows.filter((i) => i.status === 'done').length;
    this.summary.textContent = rows.length ? `${done} of ${rows.length} done` : '';
    this.table.update(rows, { keepPage: true });
  }

  _unassign(item) {
    const host = h('span.inline-confirm');
    host.append(h('button.btn.small', { type: 'button', onclick: async () => {
      if (!(await confirmInline(host, { text: unassignQuestion(item, item.annotator_id), yes: 'Unassign', no: 'Keep' }))) return;
      try {
        await this.area.write('unassign', { annotator_id: item.annotator_id, recording_id: item.recording_id, mode: item.mode, context_id: item.context_id || '' });
        await this.reload();
        this.msg.show('success', `${item.recording_id} is no longer assigned to ${item.annotator_id}.`);
      } catch (exc) { this.msg.problem(exc); }
    } }, 'Unassign'));
    return host;
  }
}
