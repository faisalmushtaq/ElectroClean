// Records: the study's audit log (every change made in the admin area or with the
// electrotag-web commands, newest first, in pages, filtered by person and operation) and the
// visits (each time someone used the application, with the number of interaction events logged).

import { h, clear } from '../ui/dom.js';
import { AUDIT_OPS, MODES, filterAudit, opText, rolesOf, whenText } from './model.js';
import { actionButton, card, dataTable, messageArea, sectionHead, select } from './ui.js';

const PAGE = 50;

export class RecordsSection {
  constructor(area) {
    this.area = area;
    this.entries = [];
    this.next = null;
    this.admins = new Set();
    this.msg = messageArea();
    this.by = select([['', 'Everyone']]);
    this.by.setAttribute('aria-label', 'Changed by');
    this.op = select([['', 'Every kind of change'], ...Object.entries(AUDIT_OPS)]);
    this.op.setAttribute('aria-label', 'Kind of change');
    for (const f of [this.by, this.op]) f.addEventListener('input', () => this._filter());
    this.auditNote = h('p.caption', { role: 'status' });
    this.audit = dataTable([
      { title: 'When', render: (e) => whenText(e.at) },
      { title: 'Who', render: (e) => e.by },
      { title: 'Change', render: (e) => h('span', {}, h('span.caption.block', {}, opText(e.op)), e.summary || '') },
      { title: 'Details', render: (e) => (e.details && Object.keys(e.details).length
        ? h('details.audit-details', {}, h('summary', {}, 'Show'), h('pre', {}, JSON.stringify(e.details, null, 2))) : '–') },
    ], [], { empty: 'No changes match.', pageSize: PAGE, caption: 'Audit log' });
    this.more = actionButton('Show older entries', { working: 'Loading…', msg: this.msg, onClick: () => this._loadAudit(false) });
    this.visitWho = select([['', 'Everyone']]);
    this.visitWho.setAttribute('aria-label', 'Visits of');
    this.visitWho.addEventListener('input', () => this._loadVisits());
    this.visitNote = h('p.caption', { role: 'status' });
    this.visits = dataTable([
      { title: 'Started', render: (v) => whenText(v.started_at) },
      { title: 'Annotator', render: (v) => h('b', {}, v.annotator_id) },
      { title: 'Mode', render: (v) => h('span', {}, (MODES[v.mode] || v.mode || '–') + (v.context_id ? ` (${v.context_id})` : ''),
        this.admins.has(v.annotator_id) ? h('span.caption.block', {}, 'An administrator: time in the admin area is not logged') : null) },
      { title: 'Closed', render: (v) => whenText(v.closed_at, { never: 'still open, or the page was closed' }) },
      { title: 'Events', num: true, render: (v) => String(v.n_events ?? 0) },
    ], [], { empty: 'No visits recorded.', pageSize: 25, caption: 'Visits' });
    this.el = h('section.admin-section', { 'data-section': 'records' },
      sectionHead('Records', 'Every change made to the study, and each visit of the annotators.'),
      this.msg,
      card('Audit log',
        h('p.caption', {}, 'Changes made here and with the electrotag-web commands, newest first. The filters apply to the entries shown; show older entries to search further back.'),
        h('div.row.filters', {}, this.by, this.op), this.auditNote, this.audit, h('div.btn-row', {}, this.more)),
      card('Visits',
        h('p.caption', {}, 'Each time someone signed in and used ElectroTag. When the study records interactions, each visit has its own log in interaction_logs.'),
        h('div.row.filters', {}, this.visitWho), this.visitNote, this.visits));
  }

  async show() {
    this.msg.clear();
    try {
      const u = await this.area.read('users_list');
      this.admins = new Set((u.users || []).filter((x) => rolesOf(x).includes('admin')).map((x) => x.annotator_id));
      const keep = this.visitWho.value;
      clear(this.visitWho);
      this.visitWho.append(h('option', { value: '' }, 'Everyone'), ...(u.users || []).map((x) => h('option', { value: x.annotator_id }, x.annotator_id)));
      this.visitWho.value = keep;
    } catch { /* the lists still work */ }
    await Promise.all([this._loadAudit(true), this._loadVisits()]);
  }

  async _loadAudit(fresh) {
    this.auditNote.textContent = 'Loading…';
    try {
      const body = { limit: PAGE };
      if (!fresh && this.next) body.before = this.next;
      const r = await this.area.backend.admin('audit', body);
      this.entries = fresh ? (r.entries || []) : [...this.entries, ...(r.entries || [])];
      this.next = r.next || null;
    } catch (exc) {
      this.auditNote.textContent = '';
      this.msg.problem(exc);
      return;
    }
    const who = new Set(this.entries.map((e) => e.by));
    const keep = this.by.value;
    clear(this.by);
    this.by.append(h('option', { value: '' }, 'Everyone'), ...[...who].sort().map((x) => h('option', { value: x }, x)));
    this.by.value = who.has(keep) ? keep : '';
    this.more.hidden = !this.next;
    this._filter(!fresh);
  }

  _filter(keepPage = false) {
    const rows = filterAudit(this.entries, { by: this.by.value, op: this.op.value });
    this.auditNote.textContent = `${rows.length} of ${this.entries.length} entries shown${this.next ? ' (older entries not loaded yet)' : ''}.`;
    this.audit.update(rows, { keepPage });
  }

  async _loadVisits() {
    this.visitNote.textContent = 'Loading…';
    try {
      const body = { limit: 100 };
      if (this.visitWho.value) body.annotator_id = this.visitWho.value;
      const r = await this.area.backend.admin('visits', body);
      this.visits.update(r.visits || []);
      this.visitNote.textContent = (r.visits || []).length >= 100 ? 'The latest 100 visits.' : '';
    } catch (exc) {
      this.visitNote.textContent = '';
      this.msg.problem(exc);
    }
  }
}
