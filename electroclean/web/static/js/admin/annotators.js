// Annotators: the study's accounts. A list with each person's status and work; adding someone
// (the temporary password or invitation link is shown once, with a copy button); and a page per
// person to change their name, role and notes, switch the account off or on, reset the password,
// remove it, see their assignments and choose their training programme.

import { h, clear } from '../ui/dom.js';
import { MODES, ROLES, STATUS, checkAnnotatorId, checkEmail, whenText } from './model.js';
import {
  actionButton, card, chip, confirmInline, dataTable, field, infoTable, loading, messageArea, recordingName, secretBox, sectionHead, select,
  textArea, textInput,
} from './ui.js';

export class AnnotatorsSection {
  constructor(area) {
    this.area = area;
    this.users = [];
    this.sets = [];
    this.detailId = null;
    this.msg = messageArea();
    this.listView = h('div.admin-stack');
    this.detailView = h('div.admin-stack', { hidden: true });
    this._buildList();
    this.el = h('section.admin-section', { 'data-section': 'annotators' },
      sectionHead('Annotators', 'Everyone who signs in to the study: annotators, trainees and administrators.'),
      this.msg, this.listView, this.detailView);
  }

  async show(params) {
    this.msg.clear();
    await this.reload();
    if (params.annotator) this.openDetail(params.annotator);
    else if (this.detailId) this.openDetail(this.detailId);
  }

  async reload(note = null) {
    this.table.update([]);
    this.tableNote.textContent = 'Loading…';
    try {
      const [u, s] = await Promise.all([this.area.read('users_list'), this.area.read('sets_list').catch(() => ({ sets: [] }))]);
      this.users = u.users || [];
      this.sets = s.sets || [];
      this.tableNote.textContent = '';
    } catch (exc) {
      this.tableNote.textContent = '';
      this.msg.problem(exc);
      return;
    }
    this._filter();
    if (this.detailId && !this.detailView.hidden) this._renderDetail(note);
  }

  // ------------------------------------------------------------------ list
  _buildList() {
    const search = textInput({ placeholder: 'Search by ID, name or email', type: 'search' });
    search.setAttribute('aria-label', 'Search the accounts');
    const role = select([['', 'Every role'], ['annotator', 'Annotators'], ['admin', 'Administrators']]);
    role.setAttribute('aria-label', 'Role');
    const status = select([['', 'Active and switched off'], ['active', 'Active'], ['disabled', 'Switched off']]);
    status.setAttribute('aria-label', 'Status');
    this.filters = { search, role, status };
    for (const f of [search, role, status]) f.addEventListener('input', () => this._filter());
    this.tableNote = h('p.caption', { role: 'status' });
    this.table = dataTable([
      { title: 'Account', render: (u) => h('span', {}, h('b', {}, u.annotator_id), u.display_name ? ` · ${u.display_name}` : '',
        u.email ? h('span.caption.block', {}, u.email) : null) },
      { title: 'Role', render: (u) => h('span.chips-inline', {}, u.role === 'admin' ? chip('Administrator', 'active') : chip('Annotator'),
        u.status === 'disabled' ? chip('Switched off', 'warning') : null, u.programme ? h('span.caption.block', {}, `Programme: ${u.programme}`) : null) },
      { title: 'Done', num: true, render: (u) => `${u.done ?? 0} of ${u.assigned ?? 0}` },
      { title: 'Last seen', render: (u) => whenText(u.last_seen) },
      { title: '', cls: 'actions', render: (u) => h('button.btn.small', { type: 'button', 'data-manage': u.annotator_id, onclick: () => this.openDetail(u.annotator_id) }, 'Manage') },
    ], [], { empty: 'No accounts match.', rowKey: (u) => u.annotator_id, caption: 'Accounts' });
    this.listView.append(h('div.admin-grid.wide-first', {},
      card('Accounts', h('div.row.filters', {}, search, role, status), this.tableNote, this.table),
      this._addCard()));
  }

  _filter() {
    const q = this.filters.search.value.trim().toLowerCase();
    const role = this.filters.role.value;
    const status = this.filters.status.value;
    this.table.update(this.users.filter((u) => (!role || u.role === role) && (!status || u.status === status) &&
      (!q || `${u.annotator_id} ${u.display_name || ''} ${u.email || ''}`.toLowerCase().includes(q))), { keepPage: true });
  }

  _addCard() {
    const fb = this.area.isFirebase;
    const id = textInput({ placeholder: 'for example A03' });
    id.setAttribute('autocapitalize', 'characters');
    const name = textInput({ placeholder: 'optional' });
    const email = textInput({ type: 'email', placeholder: fb ? 'needed to sign in' : 'optional' });
    const role = select(ROLES, 'annotator');
    const password = textInput({ type: 'password', placeholder: 'leave empty for a temporary one', autocomplete: 'new-password' });
    const msg = messageArea();
    const result = h('div.admin-result');
    const submit = actionButton('Add the account', {
      kind: 'primary', working: 'Adding…', msg, log: 'user-add',
      onClick: async () => {
        msg.clear();
        clear(result);
        const body = { annotator_id: checkAnnotatorId(id.value), display_name: name.value.trim(), email: checkEmail(email.value, { required: fb }), role: role.value };
        if (!fb && password.value) {
          if (password.value.length < 8) throw new Error('A password has at least 8 characters, or leave it empty for a temporary one.');
          body.password = password.value;
        }
        const r = await this.area.write('user_add', body);
        const who = r.user ? r.user.annotator_id : body.annotator_id;
        result.append(this._secret(who, r) || h('p.success', { role: 'status' }, `${who} can now sign in with the password you chose.`),
          h('div.btn-row', {}, h('button.btn.small', { type: 'button', onclick: () => this.area.go('assignments', { annotator: who }) }, `Assign recordings to ${who}…`)));
        for (const f of [id, name, email, password]) f.value = '';
        await this.reload();
      },
    });
    const form = h('form.admin-form', { onsubmit: (e) => { e.preventDefault(); submit.click(); } },
      field('Annotator ID', id, { hint: 'Letters and digits, as in the study\'s records. It cannot be changed later.' }),
      field('Name', name),
      field('Email address', email, { hint: fb ? 'They sign in with it, and the invitation link lets them choose a password.' : '' }),
      field('Role', role, { hint: 'Administrators see this admin area; they can annotate too.' }),
      fb ? null : field('Password', password),
      h('div.btn-row', {}, submit), msg, result);
    return card('Add an account', form);
  }

  /** The invitation link or temporary password of an answer, shown once. */
  _secret(who, r) {
    if (r.invite_link) {
      return secretBox({ title: `Invitation link for ${who}`, value: r.invite_link,
        note: 'Send this link to the person: it lets them choose their own password. It is shown only now.' });
    }
    if (r.temporary_password) {
      return secretBox({ title: `Temporary password for ${who}`, value: r.temporary_password,
        note: 'Give it to the person separately from the study address (in person, or in another message). It is shown only now.' });
    }
    return null;
  }

  // ---------------------------------------------------------------- detail
  openDetail(aid) {
    this.detailId = String(aid).toUpperCase();
    this.listView.hidden = true;
    this.detailView.hidden = false;
    this._renderDetail();
  }

  closeDetail() {
    this.detailId = null;
    this.detailView.hidden = true;
    this.listView.hidden = false;
    const b = this.listView.querySelector('[data-manage]');
    if (b) b.focus({ preventScroll: true });
  }

  _renderDetail(note = null) {
    const u = this.users.find((x) => x.annotator_id === this.detailId);
    clear(this.detailView);
    const back = h('button.btn.quiet.back', { type: 'button', onclick: () => this.closeDetail() }, '‹ All accounts');
    if (!u) {
      this.detailView.append(back, h('p.note', {}, `There is no account ${this.detailId} in this study (any more).`));
      return;
    }
    const self = u.annotator_id === this.area.annotatorId;
    const msg = messageArea();
    const name = textInput({ value: u.display_name || '' });
    const role = select(ROLES, u.role);
    role.disabled = self;
    const notes = textArea({ value: u.notes || '', rows: 3, placeholder: 'For the study team only' });
    const save = actionButton('Save changes', {
      kind: 'primary', working: 'Saving…', msg, log: 'user-save',
      onClick: async () => {
        const body = { annotator_id: u.annotator_id, display_name: name.value.trim(), notes: notes.value };
        if (!self && role.value !== u.role) body.role = role.value;
        await this.area.write('user_update', body);
        await this.reload(['success', 'Saved.']);
      },
    });
    const secret = h('div.admin-result');
    const reset = actionButton('Reset the password', {
      working: 'Resetting…', msg, log: 'user-reset',
      onClick: async () => {
        clear(secret);
        const r = await this.area.write('user_reset_password', { annotator_id: u.annotator_id });
        secret.append(this._secret(u.annotator_id, r) || h('p.success', {}, 'The password has been reset.'));
      },
    });
    const toggle = actionButton(u.status === 'disabled' ? 'Switch the account on' : 'Switch the account off', {
      working: 'Saving…', msg, log: 'user-status',
      onClick: async () => {
        await this.area.write('user_update', { annotator_id: u.annotator_id, status: u.status === 'disabled' ? 'active' : 'disabled' });
        await this.reload(['success', u.status === 'disabled' ? `${u.annotator_id} can sign in again.` : `${u.annotator_id} can no longer sign in. Their work is kept.`]);
      },
    });
    toggle.disabled = self;
    const removeHost = h('div.btn-row');
    const remove = h('button.btn.destructive', { type: 'button', disabled: self, 'data-log': 'user-remove', onclick: async () => {
      const yes = await confirmInline(removeHost, { text: `Remove ${u.annotator_id} from the study? Their assignments and programme go; their saved results and logs stay.`, yes: `Remove ${u.annotator_id}` });
      if (!yes) return;
      try {
        await this.area.write('user_remove', { annotator_id: u.annotator_id });
        this.msg.show('success', `${u.annotator_id} has been removed from the study.`);
        this.closeDetail();
        await this.reload();
      } catch (exc) { msg.problem(exc); }
    } }, 'Remove from the study');
    removeHost.append(remove);

    // training programme
    const prog = select([['', 'Not in a training programme'], ...this.sets.map((s) => [s.set_id, `${s.name || s.set_id} (${s.set_id})`])], u.programme || '');
    const progSave = actionButton('Save programme', {
      working: 'Saving…', msg, log: 'programme-set',
      onClick: async () => {
        await this.area.write('programme_set', { annotator_id: u.annotator_id, set_id: prog.value || null });
        await this.reload(['success', prog.value ? `${u.annotator_id} now follows the training programme of ${prog.value}.` : `${u.annotator_id} is no longer in a training programme.`]);
      },
    });

    // assignments
    const items = dataTable([
      { title: 'Recording', render: (i) => recordingName(i.recording_id) },
      { title: 'Mode', render: (i) => (MODES[i.mode] || i.mode) + (i.context_id ? ` (${i.context_id})` : '') },
      { title: 'Status', render: (i) => chip(STATUS[i.status] || i.status, i.status === 'done' ? 'done' : i.status === 'in_progress' ? 'active' : '') },
      { title: 'Saved', num: true, render: (i) => String(i.attempts ?? 0) },
      { title: 'Last activity', render: (i) => whenText(i.last_activity, { never: '–' }) },
      { title: '', cls: 'actions', render: (i) => (i.status === 'done' ? null : this._unassignButton(u.annotator_id, i, msg)) },
    ], [], { empty: 'Nothing is assigned to this person.', pageSize: 15 });
    const itemsNote = loading();
    this.area.read('assignments_list', { annotator_id: u.annotator_id })
      .then((r) => { itemsNote.remove(); items.update(r.items || []); })
      .catch((exc) => { itemsNote.remove(); msg.problem(exc); });

    this.detailView.append(back,
      h('div.admin-head', {}, h('h2.person-title', {}, `${u.annotator_id}${u.display_name ? ` · ${u.display_name}` : ''}`),
        h('p.subtitle', {}, u.role === 'admin' ? 'Administrator' : 'Annotator', ' · ', u.status === 'disabled' ? 'switched off' : 'active',
          self ? ' · this is your own account' : '')),
      msg,
      h('div.admin-grid', {},
        card('Details',
          infoTable([['Email', u.email || '–'], ['Added', whenText(u.created_at)], ['Last seen', whenText(u.last_seen)],
            ['Work', `${u.done ?? 0} of ${u.assigned ?? 0} done`]]),
          h('form.admin-form', { onsubmit: (e) => { e.preventDefault(); save.click(); } },
            field('Name', name), field('Role', role, { hint: self ? 'You cannot change your own role; another administrator can.' : '' }),
            field('Notes', notes), h('div.btn-row', {}, save))),
        card('Account',
          h('p.caption', {}, this.area.isFirebase ? 'Resetting makes a new invitation link that lets the person choose a new password.'
            : 'Resetting makes a new temporary password; the old one stops working.'),
          h('div.btn-row', {}, reset, toggle), secret,
          h('h3', {}, 'Training programme'),
          h('p.caption', {}, 'A trainee works through the set\'s guided recordings, then its practice recordings, then its assessment.'),
          h('div.row.inline-form', {}, prog, progSave),
          h('h3', {}, 'Remove'), removeHost)),
      card('Assignments', itemsNote, items,
        h('div.btn-row', {}, h('button.btn', { type: 'button', onclick: () => this.area.go('assignments', { annotator: u.annotator_id }) }, `Assign recordings to ${u.annotator_id}…`))));
    if (note) msg.show(...note);
    else {
      const heading = this.detailView.querySelector('h2');
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }
  }

  _unassignButton(aid, item, msg) {
    const host = h('span.inline-confirm');
    const b = h('button.btn.small', { type: 'button', onclick: async () => {
      if (!(await confirmInline(host, { text: `Take ${item.recording_id.split('/').pop()} away from ${aid}?`, yes: 'Unassign', no: 'Keep' }))) return;
      try {
        await this.area.write('unassign', { annotator_id: aid, recording_id: item.recording_id, mode: item.mode, context_id: item.context_id || '' });
        await this.reload(['success', `${item.recording_id} is no longer assigned to ${aid}.`]);
      } catch (exc) { msg.problem(exc); }
    } }, 'Unassign');
    host.append(b);
    return host;
  }
}
