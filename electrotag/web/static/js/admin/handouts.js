// Hand-outs: give a dataset or a collection to people and groups, either all of it to everyone or each
// recording to k people (through the Tasks section's own share-out, whose preview this page shows), with
// an optional due date and the title annotators see. Below, every hand-out with its progress and overdue
// people, a page for each (change the due date or the title, give recordings added since, add people,
// withdraw), and what would be notified: ElectroTag sends no email yet, so the page lists what a notice
// would say for the team to copy (docs/web/admin.md, "Hand-outs"; the operations are in docs/web/api.md,
// "Datasets, collections, groups and hand-outs").

import { h, clear } from '../ui/dom.js';
import { newId } from '../util.js';
import { plural, whenText } from './model.js';
import {
  actionButton, card, checkbox, checkList, chip, confirmInline, copyButton, dataTable, field, infoTable, messageArea, put, radios, recordingName,
  sectionHead, select, shareBar, textArea, textInput,
} from './ui.js';
import { K_MAX, K_MIN, personNote } from './tasks_model.js';
import { showTasksPreview } from './tasks.js';
import { inUse, personText, peopleById } from './datasets_model.js';
import {
  defaultTitle, dueState, personEntry, filterHandouts, handoutBody, handoutPreview, handoutProgress, modeText, noticeKind, overdueText, parseTarget, recipientsText,
  skippedReason, targetValue,
} from './handouts_model.js';

const KIND_WORD = { dataset: 'Dataset', collection: 'Collection' };

/** The study's day ("2026-10-30") from this computer's clock, until the study says its own. */
function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class HandoutsSection {
  constructor(area) {
    this.area = area;
    this.handouts = [];
    this.today = localDay();
    this.handoutId = null;
    this.msg = messageArea();
    this.formHost = h('div.admin-stack');
    this.detailHost = h('div.admin-stack');
    this.noticesHost = h('div.admin-stack');
    this._buildList();
    this.formCard = card('Hand out recordings', this.formHost);
    this.formCard.setAttribute('data-card', 'handout-form');
    this.el = h('section.admin-section', { 'data-section': 'handouts' },
      sectionHead('Hand-outs', 'Give a dataset or a collection to people and groups: all of it to everyone, or each recording to a few people. '
        + 'A due date marks work still open after it as overdue, here and on the annotator\'s home page; annotators see only the hand-out\'s title.'),
      this.msg, this.detailHost, this.formCard, this.listCard, card('What would be notified', this.noticesHost));
  }

  async show(params = {}) {
    this.msg.clear();
    this.params = params;
    if (params.handout) this.handoutId = params.handout;
    else if (params.target || params.group) this.handoutId = null;
    await this.reload();
  }

  async reload(note = null) {
    try {
      const [d, c, g, u, s, l] = await Promise.all([this.area.read('datasets_list'), this.area.read('collections_list'), this.area.read('groups_list'),
        this.area.read('users_list'), this.area.read('settings_get').catch(() => null), this.area.read('handouts_list')]);
      this.datasets = (d.datasets || []).filter((x) => x.state !== 'archived');
      this.collections = (c.collections || []).filter((x) => x.state !== 'archived');
      this.groups = (g.groups || []).filter((x) => x.state !== 'archived');
      this.users = u.users || [];
      this.people = peopleById([], this.users);
      const k = s && s.settings && s.settings.review ? Number(s.settings.review.k_default) : 2;
      this.kDefault = Number.isInteger(k) && k >= K_MIN && k <= K_MAX ? k : 2;
      this.handouts = l.handouts || [];
      if (l.today) this.today = l.today;
    } catch (exc) {
      this.msg.problem(exc);
      return;
    }
    this._filter();
    if (this.handoutId && this.handouts.some((o) => o.handout_id === this.handoutId)) this._detail(this.handoutId, note);
    else {
      clear(this.detailHost);
      this.handoutId = null;
      if (note) this.msg.show(...note);
    }
    this._buildForm(this.params || {});
    this.params = null;
    await this._loadNotices();
  }

  // ------------------------------------------------------------- the form
  _buildForm(params) {
    clear(this.formHost);
    const targets = [];
    if (this.datasets.length) targets.push({ group: 'Datasets', options: this.datasets.filter((d) => inUse(d)).map((d) => [targetValue('dataset', d.dataset_id), `${d.name} (${plural(inUse(d), 'recording')})`]) });
    if (this.collections.length) targets.push({ group: 'Collections', options: this.collections.filter((c) => inUse(c)).map((c) => [targetValue('collection', c.collection_id), `${c.name} (${plural(inUse(c), 'recording')})`]) });
    const what = select([['', 'Choose a dataset or collection'], ...targets.filter((t) => t.options.length)],
      params.target ? targetValue(params.target.kind, params.target.id) : '');
    const people = checkList(this.users.map((u) => personEntry(u, this.people)),
      { legend: 'People', name: 'handout-people', empty: 'Add accounts on the Annotators page first.' });
    const groups = checkList(this.groups.map((g) => ({ value: g.group_id, text: g.name || g.group_id, extra: plural((g.members || []).length, 'member') })),
      { legend: 'Groups', name: 'handout-groups', empty: 'No groups yet: make them on the Groups page.', selected: params.group ? [params.group] : [] });
    const follow = checkbox('Also give it to people who join these groups later', true);
    const mode = radios('handout-mode', [
      ['all', 'Everyone gets all of it', 'Each person is given every recording in use.'],
      ['k', 'Shared out: each recording to a few people', 'Through the Tasks section\'s share-out: each recording goes to k of the people chosen, as independent tasks.'],
    ], 'all');
    const k = select(Array.from({ length: K_MAX - K_MIN + 1 }, (_, i) => [String(K_MIN + i), String(K_MIN + i)]), String(this.kDefault));
    const kField = field('People per recording', k);
    const due = textInput({ type: 'date' });
    due.min = this.today;
    const title = textInput({ maxlength: 120 });
    const name = textInput({ maxlength: 120 });
    const note = textArea({ rows: 2, placeholder: 'For the study team; annotators never see it' });
    const previewHost = h('div.tasks-preview.ho-preview', { 'aria-live': 'polite' });
    const msg = messageArea();
    let previewed = null;
    let requestId = null;
    const targetName = () => {
      const t = parseTarget(what.value);
      if (!t) return '';
      const rec = t.kind === 'dataset' ? this.datasets.find((d) => d.dataset_id === t.id) : this.collections.find((c) => c.collection_id === t.id);
      return rec ? rec.name || t.id : t.id;
    };
    const values = () => ({ target: what.value, people: people.values(), groups: groups.values(), mode: mode.value(), k: k.value,
      dueAt: due.value, title: title.value, name: name.value, note: note.value, followGroups: follow.input.checked });
    const stale = () => {
      const t = parseTarget(what.value);
      title.placeholder = t ? defaultTitle(t.kind, targetName(), due.value) : '';
      name.placeholder = targetName();
      kField.hidden = mode.value() !== 'k';
      follow.hidden = mode.value() === 'k' || !groups.values().length;
      if (!previewed) return;
      previewed = null;
      requestId = null;
      clear(previewHost);
      previewHost.append(h('p.caption', {}, 'The choices changed: preview the hand-out again before handing it out.'));
      give.disabled = true;
      give.textContent = 'Hand out';
    };
    for (const el of [what, people, groups, follow, mode, k, due, title, name, note]) { el.addEventListener('change', stale); el.addEventListener('input', stale); }
    const preview = actionButton('Preview the hand-out', { working: 'Working it out…', msg, log: 'handout-preview', onClick: async () => {
      msg.clear();
      const body = handoutBody(values(), { today: this.today });
      const p = await this.area.read('handouts_preview_get', body);
      previewed = body;
      this._showPreview(previewHost, p, body.mode);
      const n = body.mode === 'k' ? ((p.tasks_preview || {}).created || 0) : (p.recipients || []).reduce((x, r) => x + (r.new || 0) + (r.already || 0), 0);
      give.disabled = !n;
      give.textContent = n ? 'Hand out' : 'Nothing to hand out';
    } });
    const give = actionButton('Hand out', { kind: 'primary', working: 'Handing out…', msg, log: 'handout-create', onClick: async () => {
      if (!previewed) throw new Error('Preview the hand-out first.');
      // The same request ID until the study has it: a press again after a slow answer cannot make a second hand-out.
      requestId = requestId || newId();
      const r = await this.area.write('handout_create', { ...previewed, request_id: requestId });
      requestId = null;
      previewed = null;
      const o = r.handout;
      this.handoutId = o.handout_id;
      const tasks = r.tasks ? `, ${plural(r.tasks.created || 0, 'task')}` : '';
      await this.reload(['success', `${r.already ? 'Handed out already' : 'Handed out'}: ${o.name}, to ${plural((o.counts || {}).people || 0, 'person', 'people')}${tasks}, `
        + `${plural(r.added || 0, 'new assignment')}${r.already_had ? ` (${r.already_had} held already)` : ''}. Annotators see it as "${o.title}".`]);
    } });
    give.disabled = true;
    stale();
    this.formHost.append(
      h('div.ho-steps', {},
        h('div.ho-step', {}, h('h3', {}, '1. What'), field('Dataset or collection', what, { hint: 'Retired recordings are left out.' })),
        h('div.ho-step', {}, h('h3', {}, '2. Who'), h('div.admin-grid', {}, people, h('div', {}, groups, follow))),
        h('div.ho-step', {}, h('h3', {}, '3. How'), mode, kField),
        h('div.ho-step', {}, h('h3', {}, '4. When and what annotators see'),
          h('div.form-grid', {},
            field('Due date (optional)', due, { hint: 'Work still open after this day is marked overdue. It does not change the order of work.' }),
            field('Title annotators see', title, { hint: 'Annotators see this title and nothing else about the dataset or collection. Leave it empty for the one shown.' }),
            field('Name for the study team (optional)', name),
            field('Note for the study team (optional)', note)))),
      h('div.btn-row', {}, preview, give), msg, previewHost);
    if (params.target || params.group) setTimeout(() => this.formCard.scrollIntoView({ block: 'start' }), 0);
  }

  _showPreview(host, p, mode) {
    clear(host);
    const s = handoutPreview(p, mode);
    if (mode === 'k' && p.tasks_preview) {
      showTasksPreview(host, p.tasks_preview);
      const extra = s.warnings.filter((w) => !(p.tasks_preview.warnings || []).includes(w));
      if (extra.length) host.append(h('div.banner.tasks-warnings', { role: 'note' }, extra.map((w) => h('p', {}, w))));
      const left = (p.skipped || []).filter((x) => !(p.tasks_preview.skipped || []).includes(x));
      if (left.length) this._skipped(host, left);
      return;
    }
    host.append(h('p.tasks-summary', { role: 'status' }, s.sentence));
    const who = recipientsText(p.recipients, this.groups);
    if (who) host.append(h('p.caption', {}, `Given to ${who}.`));
    if (s.warnings.length) host.append(h('div.banner.tasks-warnings', { role: 'note' }, s.warnings.map((w) => h('p', {}, w))));
    if (s.people.length) {
      host.append(dataTable([
        { title: 'Person', sort: (r) => r.annotator_id, render: (r) => h('b', {}, personText(r.annotator_id, this.people)) },
        { title: 'Through', render: (r) => (r.via === 'person' ? 'Chosen' : (this.groups.find((g) => `group:${g.group_id}` === r.via) || { name: r.via.slice(6) }).name) },
        { title: 'New', num: true, key: 'new' },
        { title: 'Held already', num: true, key: 'already' },
        ...(s.people.some(personNote) ? [{ title: 'Note', render: (r) => personNote(r) || '–' }] : []),
      ], s.people, { caption: 'What each person is given', sortable: true, pageSize: 50 }));
    }
    if (s.skipped.length) this._skipped(host, s.skipped);
  }

  _skipped(host, rows) {
    host.append(h('h3.tasks-sub', {}, 'Left out'), dataTable([
      { title: 'Recording', render: (x) => recordingName(x.recording_id) },
      { title: 'Why', render: (x) => skippedReason(x) },
    ], rows, { caption: 'Recordings left out', pageSize: 10 }));
  }

  // ------------------------------------------------------------- the list
  _buildList() {
    const state = select([['open', 'Open'], ['withdrawn', 'Withdrawn'], ['', 'Open and withdrawn']], 'open');
    state.setAttribute('aria-label', 'State');
    const overdue = checkbox('Overdue only');
    const search = textInput({ type: 'search', placeholder: 'Search names and titles' });
    search.setAttribute('aria-label', 'Search the hand-outs');
    this.filters = { state, overdue, search };
    for (const el of [state, overdue.input, search]) { el.addEventListener('input', () => this._filter()); el.addEventListener('change', () => this._filter()); }
    this.table = dataTable([
      { title: 'Hand-out', sort: (o) => o.name, render: (o) => h('span', {},
        h('button.link', { type: 'button', 'data-handout': o.handout_id, onclick: () => this.open(o.handout_id) }, o.name || o.title),
        h('span.caption.block', {}, `Annotators see: ${o.title}`)) },
      { title: 'Of', sort: (o) => (o.target || {}).name, render: (o) => h('span', {}, (o.target || {}).name || (o.target || {}).id, h('span.caption.block', {}, KIND_WORD[(o.target || {}).kind] || '')) },
      { title: 'How', sort: (o) => o.mode, render: (o) => modeText(o) },
      { title: 'People', num: true, sort: (o) => (o.counts || {}).people || 0, render: (o) => String((o.counts || {}).people || 0) },
      { title: 'Due', sort: (o) => o.due_at || null, render: (o) => this._due(o) },
      { title: 'Progress', sort: (o) => handoutProgress(o).share, render: (o) => { const p = handoutProgress(o); return h('span', {}, shareBar(p.share), h('span.caption.block', {}, p.text)); } },
      { title: 'State', sort: (o) => o.state, render: (o) => this._state(o) },
    ], [], { empty: 'Nothing handed out yet.', caption: 'Hand-outs', sortable: true, pageSize: 25, rowKey: (o) => o.handout_id });
    this.summary = h('p.caption', { role: 'status' });
    this.listCard = card('Every hand-out', h('div.row.filters', {}, state, overdue, search), this.summary, this.table);
  }

  _due(o) {
    const s = dueState(o.due_at, this.today);
    const late = overdueText(o);
    return h('span', {}, o.due_at ? s.text : h('span.caption', {}, s.text), late ? h('span.chips-inline', {}, chip(late, 'warning')) : null);
  }

  _state(o) {
    if (o.state === 'withdrawn') return chip('Withdrawn');
    return h('span.chips-inline', {}, o.complete ? chip('Complete', 'done') : chip('Open', 'active'),
      o.new_recordings ? chip(`${o.new_recordings} new`, 'warning') : null);
  }

  _filter() {
    const { state, overdue, search } = this.filters;
    const rows = filterHandouts(this.handouts, { state: state.value, overdue: overdue.input.checked, q: search.value });
    const late = rows.filter((o) => (o.counts || {}).overdue_people).length;
    this.summary.textContent = rows.length ? `${plural(rows.length, 'hand-out')}${late ? `, ${late} with overdue work` : ''}` : '';
    this.table.setEmpty(this.handouts.length ? 'No hand-outs match the filters.' : 'Nothing handed out yet. Hand a dataset or collection out above.');
    this.table.update(rows, { keepPage: true });
  }

  open(hid) {
    this.handoutId = hid;
    this._detail(hid);
    const h2 = this.detailHost.querySelector('h2');
    if (h2) { h2.tabIndex = -1; h2.focus({ preventScroll: false }); }
  }

  // ------------------------------------------------------------ one hand-out
  _detail(hid, note = null) {
    clear(this.detailHost);
    const o = this.handouts.find((x) => x.handout_id === hid);
    if (!o) return;
    const msg = messageArea();
    const open = o.state === 'open';
    const after = (words) => async () => { await this.reload(['success', words]); };
    const update = async (body, words) => { await this.area.write('handout_update', { handout_id: hid, ...body }); await after(words)(); };
    const due = textInput({ type: 'date', value: o.due_at || '' });
    const dueSave = actionButton('Change the due date', { kind: 'small', working: 'Saving…', msg, log: 'handout-due', onClick: async () => {
      const v = due.value || null;
      if (v === (o.due_at || null)) { msg.show('note', 'Nothing has changed.'); return; }
      await update({ due_at: v }, v ? `Due on ${dueState(v, '').text}.` : 'It has no due date now.');
    } });
    const title = textInput({ value: o.title || '', maxlength: 120 });
    const titleSave = actionButton('Change the title', { kind: 'small', working: 'Saving…', msg, log: 'handout-title', onClick: async () => {
      if (!title.value.trim()) throw new Error('Give the title annotators see.');
      if (title.value.trim() === o.title) { msg.show('note', 'Nothing has changed.'); return; }
      await update({ title: title.value.trim() }, `Annotators see it as "${title.value.trim()}" now.`);
    } });
    const giveNew = open && o.new_recordings ? actionButton(`Give the ${plural(o.new_recordings, 'new recording')}`, { kind: 'primary', working: 'Giving them…', msg, log: 'handout-give-new',
      onClick: async () => {
        const r = await this.area.write('handout_update', { handout_id: hid, give_new_recordings: true });
        await after(`Gave ${plural(r.added || 0, 'new assignment')}${r.tasks ? ` in ${plural(r.tasks.created || 0, 'task')}` : ''}.`)();
      } }) : null;
    const have = new Set((o.recipients || []).map((r) => r.annotator_id));
    const addable = this.users.filter((u) => u.status !== 'disabled' && !have.has(u.annotator_id));
    const addList = open && o.mode !== 'k' && addable.length
      ? checkList(addable.map((u) => personEntry(u, this.people)), { legend: 'Add people', name: 'handout-add' }) : null;
    const addBtn = addList ? actionButton('Give it to them', { kind: 'small', working: 'Giving…', msg, log: 'handout-add-people', onClick: async () => {
      const ids = addList.values();
      if (!ids.length) throw new Error('Tick the people to add.');
      const r = await this.area.write('handout_update', { handout_id: hid, add_people: ids });
      await after(`Gave it to ${ids.join(', ')}: ${plural(r.added || 0, 'new assignment')}.`)();
    } }) : null;
    const withdrawHost = h('span.inline-confirm');
    if (open) {
      withdrawHost.append(h('button.btn.destructive', { type: 'button', 'data-log': 'handout-withdraw', onclick: async () => {
        if (!(await confirmInline(withdrawHost, { text: `Withdraw ${o.name}? It takes back only what nobody has started; saved work, drafts and recordings set aside stay with the people who have them.`, yes: 'Withdraw it', no: 'Keep it' }))) return;
        try {
          const r = await this.area.write('handout_withdraw', { handout_id: hid });
          await this.reload(['success', `Withdrawn: ${plural(r.removed || 0, 'assignment')} taken back, ${plural(r.kept || 0, 'kept')} because someone had started.`]);
        } catch (exc) { msg.problem(exc); }
      } }, 'Withdraw…'));
    }
    const names = Object.fromEntries((this.groups || []).map((g) => [g.group_id, g.name]));
    const per = dataTable([
      { title: 'Person', sort: (r) => r.annotator_id, render: (r) => h('span', {}, personText(r.annotator_id, this.people),
        h('span.caption.block', {}, ((o.recipients || []).find((x) => x.annotator_id === r.annotator_id) || {}).via === 'person' ? 'chosen' : `through ${names[(((o.recipients || []).find((x) => x.annotator_id === r.annotator_id) || {}).via || '').slice(6)] || 'a group'}`)) },
      { title: 'Given', num: true, key: 'given' },
      { title: 'Saved', num: true, key: 'saved' },
      { title: 'Set aside', num: true, key: 'set_aside' },
      { title: 'Left to do', num: true, key: 'remaining' },
      { title: 'Due', sort: (r) => (r.overdue ? 1 : 0), render: (r) => (r.overdue ? chip('Overdue', 'warning') : r.remaining ? h('span.caption', {}, o.due_at ? 'on time' : '–') : chip('Done', 'done')) },
    ], o.per_person || [], { empty: 'Nobody has it.', caption: 'Each person\'s part', sortable: true, pageSize: 50 });
    const close = h('button.btn.quiet', { type: 'button', onclick: () => { this.handoutId = null; clear(this.detailHost); } }, 'Close');
    const p = handoutProgress(o);
    put(this.detailHost, card(null,
      h('div.card-head', {}, h('div.ho-title', {}, h('h2', { 'data-handout-title': hid }, o.name || o.title), this._state(o)), close),
      infoTable([
        ['Annotators see', h('b', {}, o.title)],
        ['Of', `${KIND_WORD[(o.target || {}).kind] || ''}: ${(o.target || {}).name || (o.target || {}).id}`],
        ['How', `${modeText(o)}${o.n_tasks !== null && o.n_tasks !== undefined ? ` (${plural(o.n_tasks, 'task')})` : ''}`],
        (o.groups || []).length ? ['Groups', `${o.groups.map((g) => names[g] || g).join(', ')}${o.follow_groups ? '; people who join later are given it too' : ''}`] : null,
        ['Due', this._due(o)],
        ['Progress', h('span', {}, shareBar(p.share), h('span.caption.block', {}, p.text))],
        ['Handed out', `${whenText(o.handed_out_at)}${o.handed_out_by ? ` by ${o.handed_out_by}` : ''}`],
        o.note ? ['Note', o.note] : null,
        open && o.new_recordings ? ['Added since', `${plural(o.new_recordings, 'recording')} added to the ${(o.target || {}).kind} since; nobody has been given ${o.new_recordings === 1 ? 'it' : 'them'} yet.`] : null,
      ]),
      h('div.btn-row', {}, giveNew,
        h('button.btn', { type: 'button', 'data-log': 'handout-track', onclick: () => this.area.go('datasets', { track: { kind: 'handout', id: hid } }) }, 'Who has rated what')),
      msg,
      open ? h('div.form-grid.ho-change', {}, h('div.row.inline-form', {}, field('Due date', due), dueSave), h('div.row.inline-form', {}, field('Title annotators see', title), titleSave)) : null,
      addList ? h('div.ho-add', {}, addList, h('div.btn-row', {}, addBtn)) : null,
      h('h3', {}, 'Each person'), per,
      open ? h('div.btn-row', {}, withdrawHost) : null));
    if (note) msg.show(...note);
  }

  // -------------------------------------------------- what would be notified
  async _loadNotices() {
    clear(this.noticesHost);
    const intro = h('p', {}, 'ElectroTag sends no email yet. This is what a notice would say, worked out from the study as it is now: datasets and collections '
      + 'newly fully rated, people with overdue work, and a weekly summary to copy into an email of your own. Nothing here is sent.');
    this.noticesHost.append(intro, h('p.caption.admin-loading', { role: 'status' }, 'Working it out…'));
    let a;
    try {
      a = await this.area.read('notify_preview_get', { kind: 'all' });
    } catch (exc) {
      clear(this.noticesHost);
      const m = messageArea();
      m.problem(exc);
      this.noticesHost.append(intro, m);
      return;
    }
    clear(this.noticesHost);
    const notices = a.notices || [];
    this.noticesHost.append(intro);
    if (!notices.length) { this.noticesHost.append(h('p.caption', {}, 'Nothing would be notified now.')); return; }
    const toText = (n) => (n.to || []).map((x) => personText(typeof x === 'string' ? x : x.annotator_id, this.people)).join(', ');
    for (const n of notices) {
      const text = String(n.text || '');
      this.noticesHost.append(h('article.ho-notice', { 'data-notice': n.notice_id || '' },
        h('div.card-head', {}, h('h3', {}, n.subject || noticeKind(n)), chip(noticeKind(n), n.kind && String(n.kind).startsWith('overdue') ? 'warning' : '')),
        (n.to || []).length ? h('p.caption', {}, `Would go to ${toText(n)}`) : null,
        h('pre.ho-notice-text', {}, text),
        h('div.btn-row', {}, copyButton(n.subject ? `${n.subject}\n\n${text}` : text, { label: 'Copy the text' }))));
    }
  }

  /** For the browser tests. */
  debugState() {
    return { handout: this.handoutId, n: this.handouts.length, today: this.today };
  }
}

