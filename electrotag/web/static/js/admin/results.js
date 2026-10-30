// Results: everyone's progress (GET /admin/progress, the operation `progress`), and every result
// of the study as one zip file (results_zip), or the command that exports them when they are too
// large to send through the page.

import { h, clear } from '../ui/dom.js';
import { MODES, STATUS, bytesText, csvText, programmeText, progressCounts, whenText } from './model.js';
import { actionButton, card, checkbox, chip, dataTable, downloadBase64, downloadText, messageArea, recordingName, sectionHead } from './ui.js';
import { allReviewsCard, reviewButton, reviewCount } from './reviews.js';

export class ResultsSection {
  constructor(area) {
    this.area = area;
    this.rows = [];
    this.msg = messageArea();
    this.note = h('p.caption', { role: 'status' });
    this.table = dataTable([
      { title: 'Annotator', render: (r) => h('span', {}, h('b', {}, r.annotator_id), r.display_name ? h('span.caption.block', {}, r.display_name) : null) },
      { title: 'Done', num: true, render: (r) => `${r.c.done} of ${r.c.assigned}` },
      { title: 'In progress', num: true, render: (r) => String(r.c.in_progress) },
      { title: 'To do', num: true, render: (r) => String(r.c.todo) },
      { title: 'Cannot be annotated', num: true, render: (r) => String(r.c.unusable || 0) },
      { title: 'Training', render: (r) => (r.programme ? h('span', {}, h('span.caption.block', {}, r.programme.name || r.programme.set_id || ''), programmeText(r.programme)) : '–') },
      { title: 'Last seen', render: (r) => whenText(r.last_seen) },
      { title: '', cls: 'actions', render: (r) => h('button.btn.small', { type: 'button', onclick: () => this._showWork(r) }, 'Work') },
    ], [], { empty: 'Nobody is in the study yet.', pageSize: 25, caption: 'Each person\'s work' });
    this.work = h('div.admin-stack');
    const csv = h('button.btn', { type: 'button', 'data-log': 'results-csv', onclick: () => this._downloadTable() }, 'Download the table (CSV)');
    this.reviews = allReviewsCard();
    this.zipMsg = messageArea();
    const zip = actionButton('Download all results (zip)', { kind: 'primary', working: 'Preparing the zip…', msg: this.zipMsg, log: 'results-zip', onClick: () => this._zip() });
    // Names and contact details go into the zip only when asked for, as contacts.csv (docs/web/admin.md, "Results").
    this.contacts = checkbox('Include names and contact details (contacts.csv)', false);
    this.contacts.input.dataset.log = 'results-contacts';
    const contactsWarning = h('p.banner.contacts-warning', { hidden: true }, 'contacts.csv identifies people: keep it apart from the research data and share it only with the study team. The download is noted in the audit log.');
    this.contacts.input.addEventListener('change', () => { contactsWarning.hidden = !this.contacts.input.checked; });
    this.el = h('section.admin-section', { 'data-section': 'results' },
      sectionHead('Results', 'Who has done what, and every saved result of the study.'),
      this.msg,
      card('Each person\'s work', h('p.caption', {}, 'Each person\'s recordings and training, with Work to see them one by one and review what was saved. Progress has the figures, times and the pace.'),
        this.note, this.table, h('div.btn-row', {}, csv)), this.work, this.reviews,
      card('All results',
          h('p', {}, 'The annotations (in ElectroTag\'s usual folders: _annotations.json, _events.tsv, _session.json for each recording and annotator), the interaction logs, the training progress and the reports, and the answers to the sign-up questionnaire by annotator ID, as one zip file.'),
          this.contacts, contactsWarning,
          h('div.btn-row', {}, zip), this.zipMsg));
  }

  async show() {
    this.msg.clear();
    this.note.textContent = 'Loading…';
    try {
      const p = await this.area.read('progress');
      this.rows = (p.annotators || []).map((a) => ({ ...a, c: progressCounts(a.items) }));
      this.note.textContent = p.generated_at ? `As of ${whenText(p.generated_at)}.` : '';
      this.area.read('reviews_list', {}).then((r) => this.reviews.update(r.reviews || [])).catch(() => this.reviews.update([]));
    } catch (exc) {
      this.note.textContent = '';
      this.msg.problem(exc);
      return;
    }
    this.table.update(this.rows);
  }

  async _showWork(r) {
    try { this.reviews = (await this.area.read('reviews_list', { annotator_id: r.annotator_id })).reviews || []; } catch { this.reviews = []; }
    clear(this.work);
    this.work.append(card(`Work of ${r.annotator_id}`,
      dataTable([
        { title: 'Recording', render: (i) => recordingName(i.recording_id) },
        { title: 'Mode', render: (i) => (MODES[i.mode] || i.mode) + (i.context_id ? ` (${i.context_id})` : '') },
        { title: 'Status', render: (i) => chip(STATUS[i.status] || i.status, i.status === 'done' ? 'done' : i.status === 'in_progress' ? 'active' : '') },
        { title: 'Reviews', num: true, render: (i) => reviewCount(this.reviews, r.annotator_id, i) },
        { title: 'Saved', num: true, render: (i) => String(i.attempts ?? 0) },
        { title: 'Last activity', render: (i) => whenText(i.last_activity, { never: '–' }) },
        { title: '', cls: 'actions', render: (i) => reviewButton(this.area, r.annotator_id, i, { route: 'admin-results', params: null }) },
      ], r.items || [], { empty: 'Nothing is assigned to this person.', pageSize: 20 }),
      h('div.btn-row', {}, h('button.btn.quiet', { type: 'button', onclick: () => clear(this.work) }, 'Close'))));
    this.work.querySelector('h2').tabIndex = -1;
    this.work.querySelector('h2').focus({ preventScroll: false });
  }

  _downloadTable() {
    const rows = this.rows.map((r) => ({ annotator_id: r.annotator_id, display_name: r.display_name || '', role: r.role, assigned: r.c.assigned,
      done: r.c.done, in_progress: r.c.in_progress, todo: r.c.todo, unusable: r.c.unusable, training: r.programme ? programmeText(r.programme) : '', last_seen: r.last_seen || '' }));
    downloadText('results_people.csv', csvText(['annotator_id', 'display_name', 'role', 'assigned', 'done', 'in_progress', 'todo', 'unusable', 'training', 'last_seen'], rows), 'text/csv;charset=utf-8');
  }

  async _zip() {
    this.zipMsg.clear();
    let r;
    try {
      r = await this.area.backend.admin('results_zip', this.contacts.input.checked ? { include_contacts: true } : {});
    } catch (exc) {
      if (exc.code === 'too_large' || exc.status === 413) { this.zipMsg.show('note', 'The results are too large to send through the page.', this._exportHelp()); return; }
      if (exc.code === 'needs_server' && this.area.isDemo) {
        this.zipMsg.show('note', exc.message, h('p', {}, 'The demonstration gives its results as one JSON file instead.'),
          h('div.btn-row', {}, h('button.btn', { type: 'button', onclick: () => this.area.app.downloadResults() }, 'Download the demonstration\'s results (JSON)')));
        return;
      }
      throw exc;
    }
    downloadBase64(r.file_name || 'results.zip', r.base64, 'application/zip');
    this.zipMsg.show('success', `Downloaded ${r.file_name || 'the results'}${r.size_bytes ? ` (${bytesText(r.size_bytes)})` : ''}.`);
  }

  /** How to get the results without the page: the command, with this study's names filled in. */
  _exportHelp() {
    const b = this.area.backend;
    if (b.kind === 'firebase') {
      const project = (b.health && b.health.project) || '<project>';
      const cmd = `electrotag-web export --firebase-project ${project} --study ${b.study || '<study>'} --to results`;
      return h('div', {}, h('p', {}, 'Export them with this command, on a computer with ElectroTag installed and the study\'s key (see the Firebase guide):'), h('pre.command', {}, cmd));
    }
    return h('div', {}, h('p', {}, 'On the study server they are already in the study folder, in Annotated_Events: copy that folder, for example with'),
      h('pre.command', {}, 'zip -r results.zip <study folder>/Annotated_Events'));
  }
}
