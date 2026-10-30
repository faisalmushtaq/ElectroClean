// Groups: the study team's groups of people ("Leeds RAs", "Experts"), to hand datasets and collections
// out to together. A list, a page for each group with its members and the history of who joined and left
// when, and adding people, which says first what the hand-outs that follow the group would give them
// (docs/web/admin.md, "Groups"; the operations are in docs/web/api.md, "Datasets, collections, groups
// and hand-outs").

import { h, clear } from '../ui/dom.js';
import { icon } from '../views/common.js';
import { newId } from '../util.js';
import { plural, whenText } from './model.js';
import { actionButton, card, checkList, chip, confirmInline, dataTable, field, messageArea, put, sectionHead, textArea, textInput } from './ui.js';
import { followText, personEntry } from './handouts_model.js';
import { personText, peopleById } from './datasets_model.js';

/** In place of `host`'s contents: a question with three answers; resolves with the value of the one chosen (null for Cancel or Escape). */
export function chooseInline(host, { text, choices }) {
  return new Promise((resolve) => {
    const kept = [...host.childNodes];
    let answered = false;
    const done = (v) => {
      if (answered) return;
      answered = true;
      host.removeEventListener('keydown', onKey);
      clear(host);
      host.append(...kept);
      host.classList.remove('confirming');
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
    const cancel = h('button.btn', { type: 'button', onclick: () => done(null) }, 'Cancel');
    clear(host);
    host.classList.add('confirming');
    host.append(h('div.confirm-strip', { role: 'alertdialog', 'aria-label': text }, h('p', {}, text),
      h('div.btn-row', {}, cancel, ...choices.map(([v, label, kind]) => h(`button.btn${kind ? `.${kind}` : ''}`, { type: 'button', 'data-choice': v, onclick: () => done(v) }, label)))));
    host.addEventListener('keydown', onKey);
    cancel.focus();
  });
}

export class GroupsSection {
  constructor(area) {
    this.area = area;
    this.groups = [];
    this.users = [];
    this.groupId = null;
    this.msg = messageArea();
    this.host = h('div.admin-stack');
    this.el = h('section.admin-section', { 'data-section': 'groups' },
      sectionHead('Groups', 'Groups of people, such as Leeds RAs or Experts, to hand datasets and collections out to together. '
        + 'A hand-out can follow its groups, so that someone who joins later is given what the group has.'),
      this.msg, this.host);
  }

  async show(params = {}) {
    this.msg.clear();
    if (params.group !== undefined) this.groupId = params.group;
    await this.reload();
  }

  async reload(note = null) {
    clear(this.host);
    this.host.append(h('p.caption.admin-loading', { role: 'status' }, 'Loading…'));
    try {
      const [g, u] = await Promise.all([this.area.read('groups_list'), this.area.read('users_list')]);
      this.groups = g.groups || [];
      this.users = u.users || [];
      this.people = peopleById([], this.users);
    } catch (exc) {
      clear(this.host);
      this.msg.problem(exc);
      return;
    }
    clear(this.host);
    if (this.groupId && this.groups.some((g) => g.group_id === this.groupId)) await this._page(this.groupId, note);
    else { this.groupId = null; this._list(note); }
  }

  _entries(selected = []) {
    const keep = new Set(selected);
    return this.users.filter((u) => u.status !== 'disabled' || keep.has(u.annotator_id)).map((u) => personEntry(u, this.people));
  }

  _list(note) {
    const msg = messageArea();
    const formHost = h('div');
    const add = h('button.btn.primary', { type: 'button', 'data-log': 'group-new', onclick: () => { add.hidden = true; this._newForm(formHost, () => { add.hidden = false; }); } }, icon('plus'), 'New group');
    const table = dataTable([
      { title: 'Group', sort: (g) => g.name, render: (g) => h('span', {},
        h('button.link', { type: 'button', 'data-group': g.group_id, onclick: () => { this.groupId = g.group_id; this.reload(); } }, g.name || g.group_id),
        g.description ? h('span.caption.block', {}, g.description.slice(0, 120)) : null) },
      { title: 'Members', num: true, sort: (g) => (g.members || []).length, render: (g) => String((g.members || []).length) },
      { title: 'Who', render: (g) => ((g.members || []).length ? (g.members || []).slice(0, 8).join(', ') + ((g.members || []).length > 8 ? ', …' : '') : h('span.caption', {}, 'nobody yet')) },
      { title: 'State', sort: (g) => g.state, render: (g) => (g.state === 'archived' ? chip('Archived', 'warning') : chip('In use', 'active')) },
    ], this.groups, { empty: 'No groups yet. Make one to hand recordings out to several people together.', caption: 'Groups', sortable: true, pageSize: 50 });
    put(this.host, card('Groups', h('div.btn-row', {}, add), formHost, msg, table));
    if (note) msg.show(...note);
  }

  _newForm(host, done) {
    clear(host);
    const msg = messageArea();
    const name = textInput({ placeholder: 'For example Leeds RAs', maxlength: 120 });
    const description = textArea({ rows: 2, placeholder: 'For the study team' });
    const members = checkList(this._entries(), { legend: 'Members', name: 'group-members', empty: 'Add accounts on the Annotators page first.' });
    let requestId = null;
    const make = actionButton('Make the group', { kind: 'primary', working: 'Making it…', msg, log: 'group-create', onClick: async () => {
      if (!name.value.trim()) throw new Error('Give the group a name.');
      requestId = requestId || newId();
      const r = await this.area.write('group_create', { request_id: requestId, name: name.value.trim(), description: description.value.trim(), members: members.values() });
      requestId = null;
      this.groupId = r.group.group_id;
      await this.reload(['success', `${r.already ? 'Already made' : 'Made'}: the group ${r.group.name}, with ${plural((r.group.members || []).length, 'member')}.`]);
    } });
    const cancel = h('button.btn', { type: 'button', onclick: () => { clear(host); done(); } }, 'Cancel');
    host.append(h('div.ds-form', { 'data-form': 'group-new' }, h('h3', {}, 'New group'),
      h('div.form-grid', {}, field('Name', name), field('Description (optional)', description)), members,
      h('div.btn-row', {}, make, cancel), msg));
    name.focus();
  }

  async _page(gid, note) {
    const g = this.groups.find((x) => x.group_id === gid);
    let handouts = [];
    try { handouts = (await this.area.read('handouts_list', { state: 'open' })).handouts || []; } catch { /* the words about hand-outs are left out */ }
    const msg = messageArea();
    const back = h('button.btn.quiet', { type: 'button', 'data-log': 'group-back', onclick: () => { this.groupId = null; this.reload(); } }, icon('arrow-left'), 'All groups');
    const follow = handouts.filter((o) => o.mode !== 'k' && o.follow_groups && (o.groups || []).includes(gid));
    const using = handouts.filter((o) => (o.groups || []).includes(gid));
    // members
    const members = checkList(this._entries(g.members), { legend: 'Members', name: 'group-members', selected: g.members || [], empty: 'Add accounts on the Annotators page first.' });
    const saveHost = h('div.btn-row');
    const mMsg = messageArea();
    const saveMembers = h('button.btn.primary', { type: 'button', 'data-log': 'group-members-save', onclick: async () => {
      const now = new Set(members.values());
      const before = new Set(g.members || []);
      const add = [...now].filter((a) => !before.has(a));
      const remove = [...before].filter((a) => !now.has(a));
      if (!add.length && !remove.length) { mMsg.show('note', 'Nothing has changed.'); return; }
      let giveExisting = true;
      const f = followText(handouts, gid, add);
      if (f.text) {
        const choice = await chooseInline(saveHost, { text: f.text, choices: [['only', 'Add only'], ['give', 'Add and give', 'primary']] });
        if (!choice) return;
        giveExisting = choice === 'give';
      }
      saveMembers.disabled = true;
      try {
        const r = await this.area.write('group_update', { group_id: gid, ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}), ...(add.length ? { give_existing: giveExisting } : {}) });
        const given = (r.given || []).reduce((x, y) => x + (y.added || 0), 0);
        await this.reload(['success', [add.length ? `Added ${add.join(', ')}` : '', remove.length ? `took out ${remove.join(', ')}` : '',
          given ? `and gave ${plural(given, 'recording')} through the hand-outs that follow the group` : ''].filter(Boolean).join('; ') + '.']);
      } catch (exc) { mMsg.problem(exc); } finally { saveMembers.disabled = false; }
    } }, 'Save the members');
    saveHost.append(saveMembers);
    // details
    const dMsg = messageArea();
    const name = textInput({ value: g.name || '', maxlength: 120 });
    const description = textArea({ rows: 2, value: g.description || '' });
    const save = actionButton('Save the details', { working: 'Saving…', msg: dMsg, log: 'group-save', onClick: async () => {
      if (!name.value.trim()) throw new Error('Give the group a name.');
      const body = { group_id: gid };
      if (name.value.trim() !== g.name) body.name = name.value.trim();
      if (description.value.trim() !== (g.description || '')) body.description = description.value.trim();
      if (Object.keys(body).length === 1) { dMsg.show('note', 'Nothing has changed.'); return; }
      await this.area.write('group_update', body);
      await this.reload(['success', 'The details are saved.']);
    } });
    const archive = actionButton(g.state === 'archived' ? 'Bring back into use' : 'Archive', { working: 'Saving…', msg: dMsg, log: 'group-archive', onClick: async () => {
      await this.area.write('group_update', { group_id: gid, state: g.state === 'archived' ? 'active' : 'archived' });
      await this.reload(['success', g.state === 'archived' ? 'In use again.' : 'Archived: it can be given nothing new; what it was given stays with its members.']);
    } });
    const removeHost = h('span.inline-confirm');
    removeHost.append(h('button.btn.destructive', { type: 'button', 'data-log': 'group-remove', onclick: async () => {
      if (using.length) { dMsg.show('note', `${plural(using.length, 'open hand-out')} ${using.length === 1 ? 'names' : 'name'} this group. Withdraw ${using.length === 1 ? 'it' : 'them'} first, or archive the group instead.`); return; }
      if (!(await confirmInline(removeHost, { text: `Remove the group ${g.name}? Its members keep what they were given, and its history stays in the study's records.`, yes: 'Remove it' }))) return;
      try {
        await this.area.write('group_remove', { group_id: gid });
        this.groupId = null;
        await this.reload(['success', `The group ${g.name} is removed.`]);
      } catch (exc) { dMsg.problem(exc); }
    } }, 'Remove…'));
    const history = dataTable([
      { title: 'Person', sort: (r) => r.annotator_id, render: (r) => personText(r.annotator_id, this.people) },
      { title: 'Added', sort: (r) => r.added_at, render: (r) => `${whenText(r.added_at)}${r.added_by ? ` by ${r.added_by}` : ''}` },
      { title: 'Left', sort: (r) => r.removed_at || '', render: (r) => (r.removed_at ? `${whenText(r.removed_at)}${r.removed_by ? ` (${r.removed_by})` : ''}` : h('span.caption', {}, 'still a member')) },
    ], [...(g.history || [])].reverse(), { empty: 'Nobody has joined yet.', caption: 'Who joined and left, and when', sortable: true, pageSize: 25 });
    const head = card(null, h('div.card-head', {}, h('h2', { 'data-group-title': gid }, g.name || gid), g.state === 'archived' ? chip('Archived', 'warning') : chip(plural((g.members || []).length, 'member'), 'active')),
      g.description ? h('p', {}, g.description) : null,
      h('p.caption', {}, follow.length ? `${plural(follow.length, 'open hand-out')} ${follow.length === 1 ? 'follows' : 'follow'} this group: ${follow.map((o) => o.name || o.title).join(', ')}. People added are offered what ${follow.length === 1 ? 'it gives' : 'they give'}.`
        : using.length ? `${plural(using.length, 'open hand-out')} ${using.length === 1 ? 'names' : 'name'} this group; none follows it, so people added later are given nothing by ${using.length === 1 ? 'it' : 'them'}.` : 'No open hand-out names this group yet.'),
      h('div.btn-row', {}, h('button.btn', { type: 'button', 'data-log': 'group-handout', disabled: g.state === 'archived', onclick: () => this.area.go('handouts', { group: gid }) }, 'Hand out to this group…')),
      msg);
    put(this.host, h('div.btn-row', {}, back), head,
      card('Members', h('p.caption', {}, 'Tick the people in the group. A person taken out keeps what they were given.'), members, saveHost, mMsg),
      card('History', history),
      card('Details', h('div.form-grid', {}, field('Name', name), field('Description', description)), h('div.btn-row', {}, save, archive, removeHost), dMsg));
    if (note) msg.show(...note);
    const h2 = head.querySelector('h2');
    if (h2) { h2.tabIndex = -1; h2.focus({ preventScroll: true }); }
  }
}
