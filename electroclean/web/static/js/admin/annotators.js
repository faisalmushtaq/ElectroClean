// Annotators: the study's accounts, in three tabs. Accounts lists everyone with their status,
// work and invitation, and acts on several people at once (assign recordings, switch accounts
// off or on, new invitation links); Invitations shows where each person's private link stands
// (copy it, email it, make a new one, withdraw it); Add several makes accounts from pasted lines,
// each with an invitation. A page per person changes their name, role and notes, switches the
// account off or on, resets the password, removes it, chooses their training programme and lists
// their work recording by recording.
//
// An invitation link is shown only when it is made: the study keeps only a fingerprint of its
// token, so a link that was not copied cannot be shown again, and a new one is made instead.

import { h, clear } from '../ui/dom.js';
import { icon } from '../views/common.js';
import {
  INVITE_STATES, MODES, ROLES, STATUS, checkAnnotatorId, checkEmail, csvText, dateText, invitationText, inviteLink, inviteMessage, mailtoHref,
  minutesText, parseBulkPeople, plural, whenText,
} from './model.js';
import {
  actionButton, card, chip, confirmInline, copyButton, copyText, dataTable, eachInTurn, oneAtATime, field, infoTable, loading, messageArea, progressLine,
  recordingName, resultsTable, secretBox, sectionHead, select, tabBar, textArea, textInput,
} from './ui.js';

const DAYS = [['7', '7 days'], ['14', '14 days'], ['30', '30 days'], ['90', '90 days']];
const STATE_KIND = { invited: 'active', accepted: 'done', expired: 'warning', revoked: '' };

export class AnnotatorsSection {
  constructor(area) {
    this.area = area;
    this.users = [];
    this.sets = [];
    this.detailId = null;
    this.links = new Map(); // invitation links made on this page: annotator ID -> {link, expires_at}
    this.msg = messageArea();
    this.listView = h('div.admin-stack');
    this.detailView = h('div.admin-stack', { hidden: true });
    this.panels = { accounts: this._accountsPanel(), invitations: this._invitationsPanel(), several: this._severalPanel() };
    this.tabs = tabBar([{ key: 'accounts', title: 'Accounts' }, { key: 'invitations', title: 'Invitations' }, { key: 'several', title: 'Add several' }],
      (key) => this._tab(key));
    this.listView.append(this.tabs, ...Object.values(this.panels));
    this._tab('accounts');
    this.tabs.select('accounts');
    this.el = h('section.admin-section', { 'data-section': 'annotators' },
      sectionHead('Annotators', 'Everyone who signs in to the study: annotators, trainees and administrators.'),
      this.msg, this.listView, this.detailView);
  }

  _tab(key) {
    this.tab = key;
    for (const [k, p] of Object.entries(this.panels)) p.hidden = k !== key;
  }

  async show(params) {
    this.msg.clear();
    if (params.tab) this.tabs.select(params.tab);
    await this.reload();
    if (params.annotator) this.openDetail(params.annotator);
    else if (this.detailId) this.openDetail(this.detailId);
  }

  async reload(note = null) {
    // An earlier, slower answer must not replace a newer one (a list read before a change).
    const turn = (this._turn = (this._turn || 0) + 1);
    this.tableNote.textContent = 'Loading…';
    try {
      const [u, s] = await Promise.all([this.area.read('users_list'), this.area.read('sets_list').catch(() => ({ sets: [] }))]);
      if (turn !== this._turn) return;
      this.users = u.users || [];
      this.sets = s.sets || [];
      this.tableNote.textContent = '';
    } catch (exc) {
      this.tableNote.textContent = '';
      this.msg.problem(exc);
      return;
    }
    this._filter();
    this.invites.update(this.users, { keepPage: true });
    if (this.detailId && !this.detailView.hidden) this._renderDetail(note);
  }

  get study() {
    const me = this.area.app.me;
    return (me && me.study && me.study.name) || '';
  }

  /** The private link of an invitation answer: Firebase's own link, or this page's address with the token. */
  _linkOf(r) {
    if (r.invite_link) return r.invite_link;
    if (!r.invite_token) return null;
    const b = this.area.backend;
    return inviteLink(r.invite_token, { pageHref: location.href, server: b.server || '',
      forcedDemo: Boolean(this.area.app.where && this.area.app.where.source === 'forced-demo') });
  }

  _remember(aid, r) {
    const link = this._linkOf(r);
    if (link) this.links.set(aid, { link, expires_at: r.expires_at || null });
    return link;
  }

  // -------------------------------------------------------------- accounts
  _accountsPanel() {
    const search = textInput({ placeholder: 'Search by ID, name or email', type: 'search' });
    search.setAttribute('aria-label', 'Search the accounts');
    const role = select([['', 'Every role'], ['annotator', 'Annotators'], ['admin', 'Administrators']]);
    role.setAttribute('aria-label', 'Role');
    const status = select([['', 'Active and switched off'], ['active', 'Active'], ['disabled', 'Switched off']]);
    status.setAttribute('aria-label', 'Status');
    this.filters = { search, role, status };
    for (const f of [search, role, status]) f.addEventListener('input', () => this._filter());
    this.tableNote = h('p.caption', { role: 'status' });
    this.bulkBar = h('div.bulk-bar', { hidden: true, role: 'region', 'aria-label': 'Act on the people chosen' });
    this.bulkResult = h('div.admin-stack.bulk-result');
    this.accountsMail = h('div.admin-stack');
    this.table = dataTable([
      { title: 'Account', sort: (u) => u.annotator_id, render: (u) => h('span', {}, h('b', {}, u.annotator_id), u.display_name ? ` · ${u.display_name}` : '',
        u.email ? h('span.caption.block', {}, u.email) : null) },
      { title: 'Role', sort: (u) => `${u.role} ${u.status}`, render: (u) => h('span.chips-inline', {}, u.role === 'admin' ? chip('Administrator', 'active') : chip('Annotator'),
        u.status === 'disabled' ? chip('Switched off', 'warning') : null, u.programme ? h('span.caption.block', {}, `Programme: ${u.programme}`) : null) },
      { title: 'Invitation', sort: (u) => (u.invitation && u.invitation.state) || 'none', render: (u) => this._stateChip(u) },
      { title: 'Done', num: true, sort: (u) => u.done ?? 0, render: (u) => `${u.done ?? 0} of ${u.assigned ?? 0}` },
      { title: 'Last seen', sort: (u) => u.last_seen, render: (u) => whenText(u.last_seen) },
      { title: '', cls: 'actions', render: (u) => h('button.btn.small', { type: 'button', 'data-manage': u.annotator_id, onclick: () => this.openDetail(u.annotator_id) }, 'Manage') },
    ], [], { empty: 'No accounts match.', rowKey: (u) => u.annotator_id, caption: 'Accounts', sortable: true, selectable: true, onSelect: (keys) => this._bulkBar(keys) });
    return h('div.admin-grid.wide-first', { role: 'tabpanel', 'data-panel': 'accounts' },
      card('Accounts', h('div.row.filters', {}, search, role, status), this.tableNote, this.bulkBar, this.table, this.bulkResult, this.accountsMail),
      this._addCard());
  }

  _stateChip(u) {
    const inv = u.invitation || { state: 'none' };
    if (inv.state === 'none') return h('span.caption', {}, INVITE_STATES.none);
    return h('span', {}, chip(INVITE_STATES[inv.state] || inv.state, STATE_KIND[inv.state] || ''), h('span.caption.block', {}, invitationText(inv)));
  }

  _filter() {
    const q = this.filters.search.value.trim().toLowerCase();
    const role = this.filters.role.value;
    const status = this.filters.status.value;
    this.table.update(this.users.filter((u) => (!role || u.role === role) && (!status || u.status === status) &&
      (!q || `${u.annotator_id} ${u.display_name || ''} ${u.email || ''}`.toLowerCase().includes(q))), { keepPage: true });
  }

  _bulkBar(keys) {
    clear(this.bulkBar);
    this.bulkBar.hidden = !keys.length;
    if (!keys.length) return;
    const self = this.area.annotatorId;
    const others = keys.filter((k) => k !== self);
    const msg = messageArea();
    const progress = progressLine();
    const run = (label, op, body, done, log) => actionButton(label, { kind: 'small', working: 'Working…', msg, log, onClick: async () => {
      clear(this.bulkResult);
      const ids = others;
      if (!ids.length) throw new Error('Choose someone other than yourself: your own account is changed by another administrator.');
      await oneAtATime(this, async () => {
        const results = await eachInTurn(ids, (aid) => this.area.write(op, { annotator_id: aid, ...body }), { progress, words: (i, n, aid) => `${label}: ${aid} (${i} of ${n})…` });
        this._showResults(results, done, op === 'user_invite');
        this.table.clearSelection();
        await this.reload();
      });
    } });
    const days = select(DAYS, '14');
    days.setAttribute('aria-label', 'The new links last');
    this.bulkBar.append(
      h('p', {}, h('b', {}, `${plural(keys.length, 'person', 'people')} chosen`), keys.includes(self) ? h('span.caption', {}, ' (your own account is left out of switching off and on and of new links)') : null),
      h('div.btn-row', {},
        h('button.btn.small', { type: 'button', 'data-log': 'bulk-assign', onclick: () => this.area.go('assignments', { annotators: keys }) }, 'Assign recordings…'),
        run('Switch off', 'user_update', { status: 'disabled' }, () => 'Switched off: they can no longer sign in; their work is kept.', 'bulk-switch-off'),
        run('Switch on', 'user_update', { status: 'active' }, () => 'Switched on: they can sign in again.', 'bulk-switch-on'),
        h('span.bulk-sep', { 'aria-hidden': 'true' }),
        run('New invitation links', 'user_invite', this.area.isFirebase ? {} : { get expires_days() { return Number(days.value); } }, () => 'A new link, below.', 'bulk-invite'),
        this.area.isFirebase ? null : days,
        h('button.btn.small.quiet', { type: 'button', onclick: () => this.table.clearSelection() }, 'Clear the choice')),
      progress, msg);
  }

  /** What happened to each person; with the private links of new invitations, to copy or download. */
  _showResults(results, done, links = false) {
    clear(this.bulkResult);
    const made = [];
    if (links) {
      for (const r of results) {
        if (!r.ok) continue;
        const aid = r.item;
        const link = this._remember(aid, r.value);
        const u = this.users.find((x) => x.annotator_id === aid) || { annotator_id: aid };
        if (link) made.push({ annotator_id: aid, display_name: u.display_name || '', email: u.email || '', link, expires_at: r.value.expires_at || '' });
      }
    }
    this.bulkResult.append(h('h3', {}, `Done for ${results.filter((r) => r.ok).length} of ${plural(results.length, 'person', 'people')}`),
      resultsTable(results, { name: (aid) => aid, done }), made.length ? this._linksTable(made) : null);
  }

  /** The private links of new invitations, with Copy all and a CSV download (shown only now). */
  _linksTable(made) {
    const all = made.map((m) => `${m.annotator_id}\t${m.link}`).join('\n');
    const csv = () => {
      const blob = csvText(['annotator_id', 'display_name', 'email', 'link', 'expires_at'], made);
      const a = h('a', { href: URL.createObjectURL(new Blob([blob], { type: 'text/csv;charset=utf-8' })), download: 'invitation_links.csv', hidden: true });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    };
    return h('div.success.links-made', { role: 'status' },
      h('p', {}, h('b', {}, `${plural(made.length, 'private link')}`), ' Each lets one person choose their password and sign in. They are shown only now: copy them or download them before you leave this page, and send each to its person in a separate message.'),
      dataTable([
        { title: 'Person', render: (m) => h('span', {}, h('b', {}, m.annotator_id), m.display_name ? ` · ${m.display_name}` : '', m.email ? h('span.caption.block', {}, m.email) : null) },
        { title: 'Private link', render: (m) => h('output.secret-value.link-value', {}, m.link) },
        { title: 'Until', cls: 'when', render: (m) => (m.expires_at ? dateText(m.expires_at) : '–') },
        { title: '', cls: 'actions', render: (m) => h('span.chips-inline', {}, copyButton(m.link, { label: 'Copy' }), m.email ? this._mailButton(m.annotator_id) : null) },
      ], made, { pageSize: 100, rowKey: (m) => m.annotator_id, caption: 'Private invitation links' }),
      h('div.btn-row', {}, copyButton(all, { label: 'Copy all' }), h('button.btn.small', { type: 'button', 'data-log': 'links-csv', onclick: csv }, 'Download the links (CSV)')));
  }

  _addCard() {
    const fb = this.area.isFirebase;
    const id = textInput({ placeholder: 'for example A03' });
    id.setAttribute('autocapitalize', 'characters');
    const name = textInput({ placeholder: 'optional' });
    const email = textInput({ type: 'email', placeholder: fb ? 'needed to sign in' : 'optional' });
    const role = select(ROLES, 'annotator');
    const how = select([['temporary', 'A temporary password to pass on'], ['invite', 'A private invitation link'], ['chosen', 'A password I choose']], 'temporary');
    const password = textInput({ type: 'password', placeholder: 'at least 8 characters', autocomplete: 'new-password' });
    const passwordField = field('Password', password);
    passwordField.hidden = true;
    how.addEventListener('change', () => { passwordField.hidden = how.value !== 'chosen'; });
    const msg = messageArea();
    const result = h('div.admin-result');
    const submit = actionButton('Add the account', {
      kind: 'primary', working: 'Adding…', msg, log: 'user-add',
      onClick: async () => {
        msg.clear();
        clear(result);
        const body = { annotator_id: checkAnnotatorId(id.value), display_name: name.value.trim(), email: checkEmail(email.value, { required: fb }), role: role.value };
        if (!fb && how.value === 'chosen') {
          if (password.value.length < 8) throw new Error('A password has at least 8 characters, or choose a temporary password or an invitation link.');
          body.password = password.value;
        }
        if (!fb && how.value === 'invite') body.invite = true;
        const r = await this.area.write('user_add', body);
        const who = r.user ? r.user.annotator_id : body.annotator_id;
        this._remember(who, r);
        result.append(this._secret(who, r, body.email) || h('p.success', { role: 'status' }, `${who} can now sign in with the password you chose.`),
          h('div.btn-row', {}, h('button.btn.small', { type: 'button', onclick: () => this.area.go('assignments', { annotator: who }) }, `Assign recordings to ${who}…`)));
        for (const f of [id, name, email, password]) f.value = '';
        await this.reload();
      },
    });
    const form = h('form.admin-form', { onsubmit: (e) => { e.preventDefault(); submit.click(); } },
      field('Annotator ID', id, { hint: 'Letters and digits, as in the study\'s records. It cannot be changed later.' }),
      field('Name', name),
      field('Email address', email, { hint: fb ? 'They sign in with it, and the invitation link lets them choose a password.' : 'Needed to email them their invitation link.' }),
      field('Role', role, { hint: 'Administrators see this admin area; they can annotate too.' }),
      fb ? null : field('First sign-in', how, { hint: 'An invitation link lets the person choose their own password.' }),
      fb ? null : passwordField,
      h('div.btn-row', {}, submit), msg, result);
    return card('Add an account', form);
  }

  /** The invitation link or temporary password of an answer, shown once. */
  _secret(who, r, email = null) {
    const link = this._linkOf(r);
    if (link) {
      return h('div', {}, secretBox({ title: `Invitation link for ${who}`, value: link,
        note: `Send this link to the person: it lets them choose their own password${r.expires_at ? ` until ${dateText(r.expires_at)}` : ''}. It is shown only now.` }),
      email ? h('div.btn-row', {}, this._mailButton(who, email)) : null);
    }
    if (r.temporary_password) {
      return secretBox({ title: `Temporary password for ${who}`, value: r.temporary_password,
        note: 'Give it to the person separately from the study address (in person, or in another message). It is shown only now.' });
    }
    return null;
  }

  // ------------------------------------------------------------ invitations
  _invitationsPanel() {
    this.inviteMsg = messageArea();
    this.inviteDays = select(DAYS, '14');
    this.inviteDays.id = 'invite-days';
    this.mailHost = h('div.admin-stack');
    this.invites = dataTable([
      { title: 'Person', sort: (u) => u.annotator_id, render: (u) => h('span', {}, h('b', {}, u.annotator_id), u.display_name ? ` · ${u.display_name}` : '',
        u.email ? h('span.caption.block', {}, u.email) : h('span.caption.block', {}, 'no email address'), u.status === 'disabled' ? chip('Switched off', 'warning') : null) },
      { title: 'Invitation', sort: (u) => (u.invitation && u.invitation.state) || 'none', render: (u) => this._stateChip(u) },
      { title: '', cls: 'actions', render: (u) => this._inviteActions(u) },
    ], [], { empty: 'There are no accounts yet.', rowKey: (u) => u.annotator_id, caption: 'Invitations', sortable: true, pageSize: 50 });
    const fb = this.area.isFirebase;
    return h('div.admin-stack', { role: 'tabpanel', 'data-panel': 'invitations' },
      card('Invitations',
        h('p', {}, 'A private link lets one person choose their own password and sign in. It works once, and it stops working when a newer link is made, when it is withdrawn and when the account is switched off.'),
        h('p.caption', {}, fb ? 'On Firebase the link comes from Firebase Authentication, which decides how long it lasts; it cannot be withdrawn, but switching the account off stops the person signing in.'
          : 'The study keeps only a fingerprint of each link, so a link is shown only when it is made: if one was not copied, make a new one (the old one stops working).'),
        fb ? null : h('div.row.inline-form.invite-days', {}, h('label.form-label.inline', { for: 'invite-days' }, 'New links last'), this.inviteDays),
        this.inviteMsg, this.invites, this.mailHost));
  }

  _inviteActions(u) {
    const inv = u.invitation || { state: 'none' };
    const known = this.links.get(u.annotator_id);
    const fb = this.area.isFirebase;
    const out = h('span.chips-inline.invite-actions');
    if (known && inv.state === 'invited') {
      out.append(copyButton(known.link, { label: 'Copy link' }));
      if (u.email) out.append(this._mailButton(u.annotator_id));
    }
    if (u.status !== 'disabled' && inv.state !== 'accepted' && u.annotator_id !== this.area.annotatorId) {
      const host = h('span.inline-confirm');
      const make = h('button.btn.small', { type: 'button', 'data-invite': u.annotator_id, onclick: async () => {
        if (inv.state === 'invited' && !fb && !(await confirmInline(host, { text: `Make a new link for ${u.annotator_id}? The link sent before stops working.`, yes: 'Make a new link', no: 'Keep it', destructive: false }))) return;
        await this._invite(u.annotator_id);
      } }, inv.state === 'none' ? 'Make a link' : 'New link');
      host.append(make);
      out.append(host);
    }
    if (inv.state === 'invited' && !fb) {
      const host = h('span.inline-confirm');
      host.append(h('button.btn.small.destructive', { type: 'button', 'data-revoke': u.annotator_id, onclick: async () => {
        if (!(await confirmInline(host, { text: `Withdraw ${u.annotator_id}'s invitation link? It stops working at once.`, yes: 'Withdraw it', no: 'Keep it' }))) return;
        try {
          await this.area.write('user_invite_revoke', { annotator_id: u.annotator_id });
          this.links.delete(u.annotator_id);
          await this.reload();
          this.inviteMsg.show('success', `${u.annotator_id}'s invitation link has been withdrawn.`);
        } catch (exc) { this.inviteMsg.problem(exc); }
      } }, 'Withdraw'));
      out.append(host);
    }
    return out;
  }

  async _invite(aid) {
    this.inviteMsg.clear();
    try {
      const r = await this.area.write('user_invite', { annotator_id: aid, ...(this.area.isFirebase ? {} : { expires_days: Number(this.inviteDays.value) }) });
      this._remember(aid, r);
      await this.reload();
      const known = this.links.get(aid);
      this.inviteMsg.show('success', `A new private link for ${aid}${known && known.expires_at ? `, until ${dateText(known.expires_at)}` : ''}. Copy it or email it now: it is shown only on this page.`);
    } catch (exc) { this.inviteMsg.problem(exc); }
  }

  /** "Email the link": a short message to edit, then the person's email program opens with it. */
  _mailButton(aid, email = null) {
    return h('button.btn.small', { type: 'button', 'data-mail': aid, onclick: () => this._mailEditor(aid, email) }, 'Email the link');
  }

  _mailEditor(aid, email = null) {
    const u = this.users.find((x) => x.annotator_id === aid) || { annotator_id: aid, email };
    const known = this.links.get(aid);
    if (!known) return;
    const me = this.area.app.me || {};
    const target = !this.detailView.hidden ? this.detailMail : { invitations: this.mailHost, several: this.severalMail }[this.tab] || this.accountsMail;
    clear(target);
    const subject = textInput({ value: `Your invitation to ${this.study || 'the study'}` });
    const body = textArea({ rows: 12, value: inviteMessage({ annotatorId: aid, name: u.display_name || '', study: this.study, link: known.link, expiresAt: known.expires_at, from: me.display_name || '' }) });
    const to = textInput({ type: 'email', value: u.email || email || '' });
    const open = h('a.btn.primary', { 'data-log': 'mail-open', href: '#' }, 'Open in my email');
    const refresh = () => { open.href = mailtoHref(to.value.trim(), subject.value, body.value); };
    for (const f of [subject, body, to]) f.addEventListener('input', refresh);
    refresh();
    const close = h('button.btn.quiet', { type: 'button', onclick: () => clear(target) }, 'Close');
    target.append(card(null, h('div.card-head', {}, h('h2', {}, `Email ${aid} their link`), close),
      h('p.caption', {}, 'Edit the message if you like; your own email program opens with it, ready to send. Nothing is sent from here.'),
      h('form.mail-form', { onsubmit: (e) => e.preventDefault() }, field('To', to), field('Subject', subject), field('Message', body, { wide: true }),
        h('div.btn-row', {}, open, h('button.btn', { type: 'button', onclick: async (e) => {
          const b = e.currentTarget;
          b.textContent = (await copyText(body.value)) ? 'Copied' : 'Select it and copy';
          setTimeout(() => { b.textContent = 'Copy the message'; }, 2500);
        } }, 'Copy the message')))));
    const h2 = target.querySelector('h2');
    if (h2) { h2.tabIndex = -1; h2.focus({ preventScroll: false }); }
  }

  // ------------------------------------------------------------- add several
  _severalPanel() {
    const fb = this.area.isFirebase;
    const text = textArea({ rows: 8, placeholder: 'A11, Alex Smith, alex.smith@example.org\nA12, Sam Jones, sam.jones@example.org' });
    text.setAttribute('aria-label', 'One person on each line: ID, name, email address');
    text.dataset.log = 'several-text';
    const days = select(DAYS, '14');
    const msg = messageArea();
    const progress = progressLine();
    const preview = h('div.admin-stack');
    const result = h('div.admin-stack');
    this.severalMail = h('div.admin-stack');
    let checked = null;
    const create = h('button.btn.primary', { type: 'button', 'data-log': 'several-create', hidden: true }, 'Create the accounts');
    const check = actionButton('Check the list', { kind: '', working: 'Checking…', msg, log: 'several-check', onClick: async () => {
      msg.clear();
      clear(preview);
      clear(result);
      create.hidden = true;
      const users = (await this.area.read('users_list')).users || [];
      const out = parseBulkPeople(text.value, { existing: users.map((u) => u.annotator_id), emailRequired: fb });
      if (out.problems.length) {
        checked = null;
        msg.show('error', `Correct ${plural(out.problems.length, 'line')} first; nothing has been created.`, h('ul', {}, out.problems.map((p) => h('li', {}, p.text))));
        return;
      }
      checked = { text: text.value, rows: out.rows };
      preview.append(h('p', {}, h('b', {}, `${plural(out.rows.length, 'account')} to create`), ', each with a private invitation link.'),
        dataTable([
          { title: 'Line', num: true, key: 'line' },
          { title: 'ID', key: 'annotator_id' },
          { title: 'Name', render: (r) => r.display_name || '–' },
          { title: 'Email', render: (r) => r.email || '–' },
        ], out.rows, { pageSize: 100, caption: 'Accounts to create', rowKey: (r) => r.annotator_id }));
      create.textContent = `Create ${plural(out.rows.length, 'account')}`;
      create.hidden = false;
    } });
    text.addEventListener('input', () => { if (checked && checked.text !== text.value) { checked = null; create.hidden = true; clear(preview); } });
    create.addEventListener('click', async () => {
      if (!checked || create.dataset.busy === '1') return;
      create.dataset.busy = '1';
      create.disabled = true;
      check.disabled = true;
      const rows = checked.rows;
      try {
        const results = await eachInTurn(rows, (r) => this.area.write('user_add', { annotator_id: r.annotator_id, display_name: r.display_name, email: r.email, role: 'annotator',
          invite: true, ...(fb ? {} : { expires_days: Number(days.value) }) }), { progress, words: (i, n, r) => `Creating ${r.annotator_id} (${i} of ${n})…` });
        clear(preview);
        checked = null;
        create.hidden = true;
        const made = [];
        for (const r of results) {
          if (!r.ok) continue;
          const link = this._remember(r.item.annotator_id, r.value);
          if (link) made.push({ annotator_id: r.item.annotator_id, display_name: r.item.display_name, email: r.item.email || '', link, expires_at: r.value.expires_at || '' });
        }
        clear(result);
        result.append(h('h3', {}, `Created ${results.filter((r) => r.ok).length} of ${plural(results.length, 'account')}`),
          resultsTable(results, { name: (r) => r.annotator_id, done: () => 'Account created with an invitation link' }), made.length ? this._linksTable(made) : null,
          h('div.btn-row', {}, h('button.btn.small', { type: 'button', onclick: () => this.area.go('assignments', { annotators: made.map((m) => m.annotator_id) }) }, 'Assign recordings to them…')));
        if (results.every((r) => r.ok)) text.value = '';
        await this.reload();
      } finally {
        create.dataset.busy = '';
        create.disabled = false;
        check.disabled = false;
      }
    });
    return h('div.admin-stack', { role: 'tabpanel', 'data-panel': 'several' },
      card('Add several people',
        h('p', {}, 'Paste one line for each person: their annotator ID, their name and their email address, separated by commas (a spreadsheet\'s columns pasted with tabs work too). Every line is checked before any account is made; then each person gets an account as an annotator and a private invitation link.'),
        fb ? h('p.caption', {}, 'On Firebase each person signs in with their email address, so every line needs one.') : null,
        field('People', text, { wide: true }),
        fb ? null : field('The links last', days),
        h('div.btn-row', {}, check, create), progress, msg, preview, result, this.severalMail));
  }

  // ---------------------------------------------------------------- detail
  openDetail(aid) {
    this.detailId = String(aid).toUpperCase();
    this.listView.hidden = true;
    this.detailView.hidden = false;
    this._renderDetail();
    window.scrollTo(0, 0);
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
    const back = h('button.btn.quiet.back', { type: 'button', onclick: () => this.closeDetail() }, icon('arrow-left'), 'All accounts');
    if (!u) {
      this.detailView.append(back, h('p.note', {}, `There is no account ${this.detailId} in this study (any more).`));
      return;
    }
    const self = u.annotator_id === this.area.annotatorId;
    const fb = this.area.isFirebase;
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
    this.detailMail = h('div.admin-stack');
    const reset = actionButton('Reset the password', {
      working: 'Resetting…', msg, log: 'user-reset',
      onClick: async () => {
        clear(secret);
        const r = await this.area.write('user_reset_password', { annotator_id: u.annotator_id });
        secret.append(this._secret(u.annotator_id, r) || h('p.success', {}, 'The password has been reset.'));
      },
    });
    const invite = actionButton(fb ? 'Make an invitation link' : 'Make a private invitation link', {
      working: 'Making the link…', msg, log: 'user-invite',
      onClick: async () => {
        clear(secret);
        const r = await this.area.write('user_invite', { annotator_id: u.annotator_id });
        this._remember(u.annotator_id, r);
        await this.reload();
        const box = this.detailView.querySelector('.admin-result');
        if (box) box.append(this._secret(u.annotator_id, r, u.email));
      },
    });
    invite.disabled = u.status === 'disabled';
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

    // their work, recording by recording
    const items = dataTable([
      { title: 'Recording', sort: (i) => i.recording_id, render: (i) => recordingName(i.recording_id) },
      { title: 'Mode', sort: (i) => i.mode, render: (i) => (MODES[i.mode] || i.mode) + (i.context_id ? ` (${i.context_id})` : '') },
      { title: 'Status', sort: (i) => ({ done: 0, in_progress: 1, todo: 2 })[i.status], render: (i) => chip(STATUS[i.status] || i.status, i.status === 'done' ? 'done' : i.status === 'in_progress' ? 'active' : '') },
      { title: 'Time taken', num: true, sort: (i) => i.elapsed_s, render: (i) => (i.elapsed_s === null || i.elapsed_s === undefined ? '–' : `${minutesText(i.elapsed_s)}${i.status === 'in_progress' ? ' so far' : ''}`) },
      { title: 'Annotations', num: true, sort: (i) => i.n_annotations, render: (i) => (i.n_annotations === null || i.n_annotations === undefined ? '–' : String(i.n_annotations)) },
      { title: 'Saved', sort: (i) => i.saved_at, render: (i) => whenText(i.saved_at, { never: '–' }) },
      { title: 'Attempts', num: true, sort: (i) => i.attempts ?? 0, render: (i) => String(i.attempts ?? 0) },
      { title: '', cls: 'actions', render: (i) => (i.status === 'done' ? null : this._unassignButton(u.annotator_id, i, msg)) },
    ], [], { empty: 'Nothing is assigned to this person.', pageSize: 15, sortable: true, caption: `Work of ${u.annotator_id}` });
    const itemsNote = loading();
    this.area.read('assignments_list', { annotator_id: u.annotator_id })
      .then((r) => { itemsNote.remove(); items.update(r.items || []); })
      .catch((exc) => { itemsNote.remove(); msg.problem(exc); });

    const inv = u.invitation || { state: 'none' };
    this.detailView.append(back,
      h('div.admin-head', {}, h('h2.person-title', {}, `${u.annotator_id}${u.display_name ? ` · ${u.display_name}` : ''}`),
        h('p.subtitle', {}, u.role === 'admin' ? 'Administrator' : 'Annotator', ' · ', u.status === 'disabled' ? 'switched off' : 'active',
          self ? ' · this is your own account' : '')),
      msg,
      h('div.admin-grid', {},
        card('Details',
          infoTable([['Email', u.email || '–'], ['Added', whenText(u.created_at)], ['Last seen', whenText(u.last_seen)],
            ['Invitation', invitationText(inv)], ['Work', `${u.done ?? 0} of ${u.assigned ?? 0} done`]]),
          h('form.admin-form', { onsubmit: (e) => { e.preventDefault(); save.click(); } },
            field('Name', name), field('Role', role, { hint: self ? 'You cannot change your own role; another administrator can.' : '' }),
            field('Notes', notes), h('div.btn-row', {}, save))),
        card('Account',
          h('p.caption', {}, fb ? 'Resetting makes a new link that lets the person choose a new password.'
            : 'An invitation link lets the person choose their own password, once; resetting makes a new temporary password instead. Either way the old password stops working when the new one is used or given.'),
          h('div.btn-row', {}, invite, reset, toggle), secret, this.detailMail,
          h('h3', {}, 'Training programme'),
          h('p.caption', {}, 'A trainee works through the set\'s guided recordings, then its practice recordings, then its assessment.'),
          h('div.row.inline-form', {}, prog, progSave),
          h('h3', {}, 'Remove'), removeHost)),
      card('Work',
        h('p.caption', {}, 'Each recording given to this person, with the time it was open and not paused in their browser (breaks left out), the annotations saved, when, and how many times.'),
        itemsNote, items,
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

