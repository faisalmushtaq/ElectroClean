// Tasks: share recordings out among annotators, each recording (or each part of one) to k people who
// annotate it independently, with known-answer recordings mixed in for quality control. Choose the
// people, the recordings, k and the part of each recording, see the share-out before anything is
// made (each person's share, what is left out and why), then make it once. Below, every task with
// where each of its people stands and its status, and each annotator's accuracy on the known answers
// (docs/web/admin.md, "Tasks"; the operations are in docs/web/api.md, "Tasks, windows and known answers").

import { h, clear } from '../ui/dom.js';
import { newId } from '../util.js';
import { plural, setLabel } from './model.js';
import {
  actionButton, card, checkbox, checkList, chip, confirmInline, dataTable, field, messageArea, numberInput, recordingName, sectionHead, select, textInput,
} from './ui.js';
import {
  K_MAX, K_MIN, PARTS, PERSON, SKIPPED, STATUS, changeChoices, filterTasks, partText, percent, personNote, poolEntry, previewSummary, requestBody,
  savedText, skippedPart, statusKind, statusText,
} from './tasks_model.js';

export class TasksSection {
  constructor(area) {
    this.area = area;
    this.users = [];
    this.recordings = [];
    this.sets = [];
    this.tasks = [];
    this.kDefault = 2;
    this.msg = messageArea();
    this.formHost = h('div.admin-stack');
    this.qualityHost = h('div');
    this._buildTable();
    this.el = h('section.admin-section', { 'data-section': 'tasks' },
      sectionHead('Tasks', 'Share recordings out so that each one, or each part of one, is annotated independently by several people. ' +
        'Their disagreements then go to the experts for adjudication, and known-answer recordings measure each person\'s accuracy.'),
      this.msg,
      card('Share out recordings', this.formHost), this.tableCard, card('Accuracy on known answers', this.qualityHost));
  }

  async show() {
    this.msg.clear();
    await this.reload();
  }

  async reload() {
    clear(this.formHost);
    this.formHost.append(h('p.caption', {}, 'Loading…'));
    try {
      const [u, r, s, st] = await Promise.all([this.area.read('users_list'), this.area.read('recordings_list', { scope: 'study' }),
        this.area.read('sets_list').catch(() => ({ sets: [] })), this.area.read('settings_get').catch(() => null)]);
      this.users = u.users || [];
      this.recordings = (r.recordings || []).filter((x) => x.scope === 'study');
      this.sets = s.sets || [];
      const k = st && st.settings && st.settings.review ? Number(st.settings.review.k_default) : 2;
      this.kDefault = Number.isInteger(k) && k >= K_MIN && k <= K_MAX ? k : 2;
    } catch (exc) {
      clear(this.formHost);
      this.msg.problem(exc);
      return;
    }
    this._buildForm();
    await this._loadTasks();
  }

  async _loadTasks() {
    this.tableMsg.clear();
    try {
      const t = await this.area.read('tasks_list');
      this.tasks = t.tasks || [];
    } catch (exc) {
      this.tasks = [];
      this.tableMsg.problem(exc);
    }
    this._fillFilters();
    this._filter();
    await this._loadQuality();
  }

  // ------------------------------------------------------------- share out
  _buildForm() {
    clear(this.formHost);
    const entries = this.users.map(poolEntry);
    const people = checkList(entries,
      { legend: 'Annotators to share among', name: 'task-people', empty: 'Add accounts on the Annotators page first.' });
    if (entries.some((e) => e.notInAll)) {
      people.append(h('p.caption', {}, 'All leaves out switched-off accounts, accounts without the annotator role and trainees whose study work is '
        + 'locked until they pass the competency assessment. Tick any of them by hand if you mean to; the preview then warns.'));
    }
    const all = checkbox('Every recording of the study (retired ones are left out)', true);
    const recs = checkList(this.recordings.map((r) => ({ value: r.recording_id, text: r.file_name || r.recording_id.split('/').pop(),
      extra: [r.retired ? 'retired' : '', r.assigned ? `given to ${plural(r.assigned, 'person', 'people')}` : ''].filter(Boolean).join(' · ') })),
    { legend: 'Recordings', name: 'task-recordings', empty: 'Add recordings on the Recordings page first.' });
    recs.hidden = true;
    const k = select(Array.from({ length: K_MAX - K_MIN + 1 }, (_, i) => [String(K_MIN + i), String(K_MIN + i)]), String(this.kDefault));
    const kField = field('Annotators per recording', k, { hint: 'Each recording, or each part, goes to this many people.' });
    const part = select(PARTS, 'whole');
    const partField = field('Part of each recording', part, { hint: 'A part is annotated on its own: the rest of the recording is hatched for the annotator.' });
    const startS = numberInput({ value: '0', min: 0 });
    const endS = numberInput({ value: '60', min: 0 });
    const lengthS = numberInput({ value: '60', min: 2 });
    const overlapS = numberInput({ value: '0', min: 0 });
    const one = h('div.row.wrap.tasks-times', { hidden: true }, field('From (seconds)', startS), field('To (seconds)', endS));
    const many = h('div.row.wrap.tasks-times', { hidden: true }, field('Length of each part (seconds)', lengthS),
      field('Overlap (seconds)', overlapS, { hint: 'Parts may overlap by less than half their length.' }));
    const gold = select([['', 'None: ordinary tasks'], ...this.sets.map((s) => [s.set_id, setLabel(s)])], '');
    const goldField = field('Known answers', gold, { hint: 'A reference set whose references are the answers. Known-answer recordings go to every annotator chosen, and nothing tells them apart.' });
    const adopt = checkbox('Turn recordings already given to two or more of these people into tasks, as they are');
    const batch = textInput({ placeholder: 'For example: Pilot round', maxlength: 80 });
    const batchField = field('Name for this share-out (optional)', batch);
    const previewHost = h('div.tasks-preview', { 'aria-live': 'polite' });
    const msg = messageArea();
    let previewed = null; // the body the preview shown was made for
    const values = () => ({ pool: people.values(), all: all.input.checked, recordingIds: recs.values(), k: k.value, part: part.value,
      startS: startS.value, endS: endS.value, lengthS: lengthS.value, overlapS: overlapS.value, gold: gold.value, adopt: adopt.input.checked,
      batch: batch.value });
    const stale = () => {
      if (!previewed) return;
      previewed = null;
      clear(previewHost);
      previewHost.append(h('p.caption', {}, 'The choices changed: preview the share-out again before making it.'));
      create.disabled = true;
    };
    const refresh = () => {
      recs.hidden = all.input.checked;
      one.hidden = adopt.input.checked || part.value !== 'one';
      many.hidden = adopt.input.checked || part.value !== 'many';
      kField.hidden = adopt.input.checked || Boolean(gold.value);
      partField.hidden = adopt.input.checked;
      goldField.hidden = adopt.input.checked;
      stale();
    };
    for (const el of [people, recs, all, k, part, startS, endS, lengthS, overlapS, gold, adopt, batch]) {
      el.addEventListener('change', refresh);
      el.addEventListener('input', stale);
    }
    const preview = actionButton('Preview the share-out', {
      working: 'Working it out…', msg, log: 'tasks-preview',
      onClick: async () => {
        msg.clear();
        const body = requestBody(values());
        const p = await this.area.read('tasks_preview_get', body);
        previewed = body;
        this._showPreview(previewHost, p);
        create.disabled = !p.created;
        create.textContent = p.created ? `Make ${plural(p.created, 'task')}` : 'Make the tasks';
      },
    });
    const create = actionButton('Make the tasks', {
      kind: 'primary', working: 'Making the tasks…', msg, log: 'tasks-create',
      onClick: async () => {
        if (!previewed) throw new Error('Preview the share-out first.');
        const body = { ...previewed, request_id: this._requestId || (this._requestId = newId()) };
        const r = await this.area.write('tasks_create', body);
        this._requestId = null; // the study has it: the next share-out is a new request
        previewed = null;
        clear(previewHost);
        // once the button is free again (busy() gives it back as it was): nothing to make until the next preview
        setTimeout(() => { create.disabled = true; create.textContent = 'Make the tasks'; }, 0);
        await this._loadTasks();
        msg.show('success', `${r.already ? 'Already made' : 'Made'}: ${plural(r.created, 'task')}, ${plural(r.assigned, 'new assignment')}. ` +
          'Each annotator finds their recordings in their own list; the tasks are listed below.');
      },
    });
    create.disabled = true;
    refresh();
    this.formHost.append(h('div.admin-grid', {}, people, h('div', {}, all, recs)),
      h('div.row.wrap.tasks-options', {}, kField, partField, goldField, batchField),
      one, many, adopt, h('div.btn-row', {}, preview, create), msg, previewHost);
  }

  _showPreview(host, p) {
    clear(host);
    const s = previewSummary(p);
    host.append(h('p.tasks-summary', { role: 'status' }, s.sentence));
    if (s.pairs) host.append(h('p.caption.tasks-pairs', {}, s.pairs));
    if (s.warnings.length) host.append(h('div.banner.tasks-warnings', { role: 'note' }, s.warnings.map((w) => h('p', {}, w))));
    if (s.people.length) {
      host.append(dataTable([
        { title: 'Annotator', key: 'annotator_id', render: (r) => h('b', {}, r.annotator_id) },
        { title: 'Open tasks now', key: 'open_before', num: true },
        { title: 'New tasks', key: 'new', num: true },
        { title: 'Already theirs', key: 'linked', num: true },
        { title: 'Open tasks after', key: 'total', num: true },
        ...(s.people.some(personNote) ? [{ title: 'Note', render: (r) => personNote(r) || '–' }] : []),
      ], s.people, { caption: 'Each person\'s share', pageSize: 50, sortable: true }));
    }
    if (p.tasks && p.tasks.length) {
      host.append(h('h3.tasks-sub', {}, 'The tasks'), dataTable([
        { title: 'Recording', render: (t) => recordingName(t.recording_id, t.file_name) },
        { title: 'Part', render: (t) => partText(t.window) },
        { title: 'Annotators', render: (t) => t.annotators.join(', ') },
      ], p.tasks, { caption: 'The tasks the share-out makes', pageSize: 10 }));
    }
    if (p.skipped && p.skipped.length) {
      host.append(h('h3.tasks-sub', {}, 'Left out'), dataTable([
        { title: 'Recording', render: (x) => recordingName(x.recording_id) },
        { title: 'Part', render: (x) => skippedPart(x) },
        { title: 'Why', render: (x) => SKIPPED[x.reason] || x.reason },
      ], p.skipped, { caption: 'Recordings and parts left out', pageSize: 10 }));
    }
  }

  // ---------------------------------------------------------------- the list
  _buildTable() {
    const status = select([['', 'Every status'], ...Object.entries(STATUS).map(([k, [text]]) => [k, text])]);
    status.setAttribute('aria-label', 'Status');
    const person = select([['', 'Everyone']]);
    person.setAttribute('aria-label', 'Annotator');
    const search = textInput({ type: 'search', placeholder: 'Search recordings and names of share-outs' });
    search.setAttribute('aria-label', 'Search the tasks');
    this.filters = { status, person, search };
    for (const f of Object.values(this.filters)) f.addEventListener('input', () => this._filter());
    this.table = dataTable([
      { title: 'Recording', sort: (t) => t.file_name || t.recording_id, render: (t) => recordingName(t.recording_id, t.file_name) },
      { title: 'Part', sort: (t) => (t.window ? t.window.start_s : -1), render: (t) => partText(t.window) },
      { title: 'People', render: (t) => this._people(t) },
      { title: 'Saved', sort: (t) => (t.counts || {}).saved || 0, render: (t) => savedText(t) },
      { title: 'Status', sort: (t) => statusText(t.status), render: (t) => h('span', {}, chip(statusText(t.status), statusKind(t.status)),
        t.state === 'closed' ? h('span.caption.block', {}, 'Closed') : null, t.batch ? h('span.caption.block', {}, t.batch) : null) },
      { title: '', cls: 'actions', render: (t) => this._actions(t) },
    ], [], { empty: 'No tasks yet. Share recordings out above.', pageSize: 25, caption: 'Tasks', sortable: true, rowKey: (t) => t.task_id });
    this.summary = h('p.caption', { role: 'status' });
    this.tableMsg = messageArea();
    this.tableCard = card('Every task', this.tableMsg, h('div.row.filters', {}, status, person, search), this.summary, this.table);
  }

  _people(t) {
    return h('ul.task-people', {}, (t.people || []).map((p) => h('li', {},
      h('span.task-letter', { title: `Letter ${p.letter}` }, p.letter || '–'), h('b', {}, p.annotator_id),
      h('span.caption', {}, ` ${PERSON[p.status] || p.status}`))));
  }

  _fillFilters() {
    const p = this.filters.person;
    const keep = p.value;
    clear(p);
    const ids = [...new Set(this.tasks.flatMap((t) => t.annotators || []))].sort();
    p.append(h('option', { value: '' }, 'Everyone'), ...ids.map((a) => h('option', { value: a }, a)));
    p.value = ids.includes(keep) ? keep : '';
  }

  _filter() {
    const { status, person, search } = this.filters;
    const rows = filterTasks(this.tasks, { status: status.value, person: person.value, q: search.value });
    const counts = {};
    for (const t of rows) counts[t.status] = (counts[t.status] || 0) + 1;
    this.summary.textContent = rows.length
      ? `${plural(rows.length, 'task')}: ${Object.entries(counts).map(([k, n]) => `${n} ${statusText(k).toLowerCase()}`).join(', ')}`
      : '';
    this.table.update(rows, { keepPage: true });
  }

  _actions(t) {
    const host = h('span.inline-confirm.task-actions');
    const done = async (fn, words) => {
      try {
        await fn();
        await this._loadTasks();
        this.msg.show('success', words);
      } catch (exc) { this.msg.problem(exc); }
    };
    const closeBtn = t.state === 'closed'
      ? h('button.btn.small', { type: 'button', 'data-log': 'task-reopen', onclick: () => done(() => this.area.write('task_update', { task_id: t.task_id, state: 'open' }),
        `The task on ${t.file_name} is open again: its recording is back in the lists of those who have not saved it.`) }, 'Reopen')
      : h('button.btn.small', { type: 'button', 'data-log': 'task-close', onclick: async () => {
        if (!(await confirmInline(host, { text: 'Close this task? Those who have not saved it lose it from their list; saved work stays.', yes: 'Close the task', no: 'Keep it open' }))) return;
        await done(() => this.area.write('task_update', { task_id: t.task_id, state: 'closed' }), `The task on ${t.file_name} is closed. Every saved result is kept.`);
      } }, 'Close');
    const change = h('button.btn.small', { type: 'button', 'data-log': 'task-change', onclick: () => this._changePeople(host, t, done) }, 'Change people');
    const anySaved = (t.counts || {}).saved > 0;
    const remove = anySaved ? null : h('button.btn.small.quiet', { type: 'button', 'data-log': 'task-remove', onclick: async () => {
      if (!(await confirmInline(host, { text: `Remove this task? Its recording leaves ${t.annotators.join(', ')}'s lists.`, yes: 'Remove', no: 'Keep' }))) return;
      await done(() => this.area.write('task_remove', { task_id: t.task_id }), `The task on ${t.file_name} is removed.`);
    } }, 'Remove');
    host.append(...[t.state === 'closed' ? null : change, closeBtn, remove].filter(Boolean));
    return host;
  }

  /** In place of the row's buttons: who to take out and who to put in, then Replace (or one of the two). */
  _changePeople(host, t, done) {
    const kept = [...host.childNodes];
    const { out, in: candidates } = changeChoices(t, this.users);
    const drop = select([['', 'Nobody out'], ...out.map((a) => [a, `Take ${a} out`])]);
    drop.setAttribute('aria-label', 'Take someone out');
    const add = select([['', 'Nobody in'], ...candidates.map((a) => [a, `Put ${a} in`])]);
    add.setAttribute('aria-label', 'Put someone in');
    const back = () => { clear(host); host.append(...kept); };
    const go = h('button.btn.small.primary', { type: 'button', 'data-log': 'task-change-apply', onclick: async () => {
      if (!drop.value && !add.value) { back(); return; }
      const body = { task_id: t.task_id, ...(drop.value ? { remove_annotator: drop.value } : {}), ...(add.value ? { add_annotator: add.value } : {}) };
      await done(() => this.area.write('task_update', body),
        [add.value ? `${add.value} is in the task on ${t.file_name}` : '', drop.value ? `${drop.value} is out of it` : ''].filter(Boolean).join('; ') + '.');
    } }, 'Apply');
    clear(host);
    host.append(h('span.task-change', {}, drop, add, go, h('button.btn.small', { type: 'button', onclick: back }, 'Cancel')));
    drop.focus();
  }

  // ---------------------------------------------------------------- quality
  async _loadQuality() {
    clear(this.qualityHost);
    let q;
    try {
      q = await this.area.read('quality_list');
    } catch (exc) {
      const m = messageArea();
      m.problem(exc);
      this.qualityHost.append(m);
      return;
    }
    const rows = q.annotators || [];
    this.qualityHost.append(h('p.caption', {}, 'How closely each person\'s saved known-answer recordings match their references. ' +
      `Once someone has saved ${plural(q.min_items || 3, 'known answer')}, their weight for combining people's marks appears (Study settings, Corrections and adjudication, sets the number).`),
      dataTable([
        { title: 'Annotator', key: 'annotator_id', render: (r) => h('b', {}, r.annotator_id) },
        { title: 'Known answers saved', key: 'n_gold', num: true },
        { title: 'Score (F1)', key: 'mean_event_f1', num: true, render: (r) => (r.mean_event_f1 === null ? '–' : r.mean_event_f1.toFixed(2)) },
        { title: 'Right type', key: 'mean_label_accuracy', num: true, render: (r) => percent(r.mean_label_accuracy) },
        { title: 'Weight', key: 'weight', num: true, render: (r) => (r.weight === null ? h('span.caption', {}, 'not yet') : r.weight.toFixed(2)) },
      ], rows, { empty: 'No known-answer tasks yet. Choose a reference set under Known answers when sharing recordings out.', caption: 'Accuracy on known answers', sortable: true, pageSize: 50 }));
  }
}
