// Recordings: the study's register. A list to filter by scope and status, a page per recording
// (notes, retire, remove), and adding recordings from this computer: the browser reads the files
// chosen (js/data/register.js builds each recording's manifest, as electroclean-web register does
// with MNE-Python), shows what it found and what failed, and sends only the manifests. The EEG
// never leaves this computer.

import { h, clear } from '../ui/dom.js';
import { CAN_CHOOSE_FOLDER, acceptFiles } from '../util.js';
import {
  bytesText, chunkManifests, durationText, manifestSummary, mergeRegisterResults, plural, progressText, scopeText, whenText,
} from './model.js';
import {
  actionButton, card, checkbox, chip, confirmInline, dataTable, field, infoTable, messageArea, progressLine, recordingName, sectionHead, select,
  textArea, textInput,
} from './ui.js';

/** The module that reads recordings for the register (js/data/register.js); tests may replace it. */
export async function loadRegisterModule() {
  return import('../data/register.js');
}

export class RecordingsSection {
  constructor(area) {
    this.area = area;
    this.recordings = [];
    this.sets = [];
    this.job = null; // 'reading' | 'registering' while one runs: they cannot be started twice
    this.found = null; // {manifests, failures} from the builder, waiting to be registered
    this.msg = messageArea();
    this.detail = h('div.admin-detail', { hidden: true });
    this._buildList();
    this._buildAdd();
    this.el = h('section.admin-section', { 'data-section': 'recordings' },
      sectionHead('Recordings', 'The recordings of the study and of its reference sets. Each is known by its description (its manifest): the EEG stays on the computers where the files are.'),
      this.msg,
      this.addCard, this.listCard, this.detail);
  }

  async show(params) {
    this.msg.clear();
    if (params.scope) this.filters.scope.value = params.scope;
    await this.reload();
  }

  async reload() {
    this.listNote.textContent = 'Loading…';
    try {
      const [r, s] = await Promise.all([this.area.read('recordings_list'), this.area.read('sets_list').catch(() => ({ sets: [] }))]);
      this.recordings = r.recordings || [];
      this.sets = s.sets || [];
      this.listNote.textContent = '';
    } catch (exc) {
      this.listNote.textContent = '';
      this.msg.problem(exc);
      return;
    }
    this._fillScopes();
    this._filter();
    if (this.detailKey) this._renderDetail();
  }

  _scopes() {
    return [['study', 'The study'], ...this.sets.map((s) => [`set:${s.set_id}`, `Reference set: ${s.name || s.set_id}`])];
  }

  _fillScopes() {
    for (const [sel, first] of [[this.filters.scope, [['', 'Everywhere']]], [this.addScope, []]]) {
      const keep = sel.value;
      clear(sel);
      for (const [v, t] of [...first, ...this._scopes()]) sel.append(h('option', { value: v }, t));
      if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    }
  }

  // ------------------------------------------------------------------ list
  _buildList() {
    const scope = select([['', 'Everywhere'], ['study', 'The study']]);
    scope.setAttribute('aria-label', 'Where');
    const status = select([['', 'In use and retired'], ['active', 'In use'], ['retired', 'Retired']]);
    status.setAttribute('aria-label', 'Status');
    const search = textInput({ type: 'search', placeholder: 'Search by name or ID' });
    search.setAttribute('aria-label', 'Search the recordings');
    this.filters = { scope, status, search };
    for (const f of [scope, status, search]) f.addEventListener('input', () => this._filter());
    this.listNote = h('p.caption', { role: 'status' });
    this.table = dataTable([
      { title: 'Recording', render: (r) => recordingName(r.recording_id, r.file_name) },
      { title: 'Where', render: (r) => scopeText(r.scope, this.sets) },
      { title: 'Length', num: true, render: (r) => durationText(r.duration_s) },
      { title: 'Channels', num: true, render: (r) => String(r.n_channels ?? '') },
      { title: 'Done', num: true, render: (r) => `${r.done ?? 0} of ${r.assigned ?? 0}` },
      { title: 'Status', render: (r) => h('span.chips-inline', {}, r.retired ? chip('Retired', 'warning') : chip('In use', 'done'),
        (r.warnings || []).length ? chip(plural(r.warnings.length, 'warning'), 'warning') : null) },
      { title: '', cls: 'actions', render: (r) => h('button.btn.small', { type: 'button', onclick: () => this.openDetail(r) }, 'Manage') },
    ], [], { empty: 'No recordings match. Add some from this computer.', rowKey: (r) => `${r.scope}|${r.recording_id}`, caption: 'Recordings' });
    this.listCard = card('Registered recordings', h('div.row.filters', {}, scope, status, search), this.listNote, this.table);
  }

  _filter() {
    const { scope, status, search } = this.filters;
    const q = search.value.trim().toLowerCase();
    this.table.update(this.recordings.filter((r) => (!scope.value || r.scope === scope.value) &&
      (!status.value || (status.value === 'retired') === Boolean(r.retired)) &&
      (!q || `${r.recording_id} ${r.file_name || ''}`.toLowerCase().includes(q))), { keepPage: true });
  }

  // ---------------------------------------------------------------- detail
  openDetail(r) {
    this.detailKey = `${r.scope}|${r.recording_id}`;
    this._renderDetail();
    const h2 = this.detail.querySelector('h2');
    if (h2) { h2.tabIndex = -1; h2.focus({ preventScroll: false }); }
  }

  _renderDetail(note = null) {
    clear(this.detail);
    const r = this.recordings.find((x) => `${x.scope}|${x.recording_id}` === this.detailKey);
    if (!r) { this.detail.hidden = true; this.detailKey = null; return; }
    this.detail.hidden = false;
    const msg = messageArea();
    const notes = textArea({ value: r.notes || '', rows: 3, placeholder: 'For the study team, for example where the file came from' });
    const body = { scope: r.scope, recording_id: r.recording_id };
    const save = actionButton('Save notes', { kind: 'primary', working: 'Saving…', msg, onClick: async () => {
      await this.area.write('recording_update', { ...body, notes: notes.value });
      await this.reload();
      this._renderDetail(['success', 'Notes saved.']);
    } });
    const retire = actionButton(r.retired ? 'Bring back into use' : 'Retire', { working: 'Saving…', msg, onClick: async () => {
      await this.area.write('recording_update', { ...body, retired: !r.retired });
      await this.reload();
      this._renderDetail(['success', r.retired ? 'The recording can be assigned again.' : 'Retired: it is offered for no new assignments. Work already assigned stays.']);
    } });
    const removeHost = h('div.btn-row');
    removeHost.append(h('button.btn.destructive', { type: 'button', onclick: async () => {
      if (!(await confirmInline(removeHost, { text: `Remove ${r.recording_id} from ${scopeText(r.scope, this.sets).toLowerCase()}? Its description is deleted; the file on your computer is not touched.`, yes: 'Remove it' }))) return;
      try {
        await this.area.write('recording_remove', body);
        this.detailKey = null;
        this.detail.hidden = true;
        this.msg.show('success', `${r.recording_id} has been removed.`);
        await this.reload();
      } catch (exc) { msg.problem(exc); }
    } }, 'Remove'));
    const close = h('button.btn.quiet', { type: 'button', onclick: () => { this.detailKey = null; this.detail.hidden = true; } }, 'Close');
    this.detail.append(card(null,
      h('div.card-head', {}, h('h2', {}, r.file_name || r.recording_id), close),
      msg,
      infoTable([
        ['Recording ID', r.recording_id], ['Where', scopeText(r.scope, this.sets)], ['Format', String(r.format || '').toUpperCase()],
        ['Length', `${durationText(r.duration_s)} at ${r.sfreq} Hz (${Number(r.n_samples || 0).toLocaleString('en-GB')} samples)`],
        ['Channels', String(r.n_channels ?? '')], ['File size', bytesText(r.size_bytes)],
        ['Fingerprint', h('code.fingerprint', {}, r.sha256 || '–')],
        ['Added', `${whenText(r.registered_at)} by ${r.registered_by || '–'}${r.registered_via === 'browser' ? ', from a browser' : r.registered_via === 'command' ? ', with the command' : ''}`],
        ['Work', `${r.done ?? 0} of ${r.assigned ?? 0} done`],
      ]),
      (r.warnings || []).length ? h('div.banner', {}, h('p', {}, h('b', {}, 'Found when it was added')), h('ul', {}, r.warnings.map((w) => h('li', {}, w)))) : null,
      field('Notes', notes), h('div.btn-row', {}, save, retire),
      h('h3', {}, 'Remove'),
      h('p.caption', {}, 'A recording that someone has saved, or that a reference set uses, stays; retire it instead.'),
      removeHost));
    if (note) msg.show(...note);
  }

  // ---------------------------------------------------- adding from this computer
  _buildAdd() {
    this.addMsg = messageArea();
    this.addScope = select([['study', 'The study']], 'study');
    this.replace = checkbox('Replace recordings that are registered already (their description is updated)');
    const folderInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, hidden: true, 'data-log': 'register-folder',
      onchange: () => { const f = [...folderInput.files]; folderInput.value = ''; if (f.length) this.read(f); } });
    const filesInput = h('input', { type: 'file', multiple: true, hidden: true, 'data-log': 'register-files',
      accept: acceptFiles('.edf,.bdf,.rec,.vhdr,.vmrk,.eeg,.tsv,.json'),
      onchange: () => { const f = [...filesInput.files]; filesInput.value = ''; if (f.length) this.read(f); } });
    this.folderBtn = h('button.btn.primary', { type: 'button', hidden: !CAN_CHOOSE_FOLDER, onclick: () => folderInput.click() }, 'Choose a folder…');
    this.filesBtn = h(`button.btn${CAN_CHOOSE_FOLDER ? '' : '.primary'}`, { type: 'button', onclick: () => filesInput.click() }, 'Choose files…');
    this.progress = progressLine();
    this.review = h('div.admin-review');
    this.addCard = card('Add recordings from this computer',
      h('p', {}, 'Choose the dataset folder (or the files of some recordings). This browser reads each recording, works out its fingerprint and describes its channels, events and timing; only these descriptions are sent to the study, never the EEG.'),
      h('p.caption', {}, 'The folder you choose is the dataset folder: recording IDs are the paths inside it, for example sub-001/eeg/sub-001_task-rest_eeg.vhdr. BIDS sidecar files (channels.tsv, events.tsv) beside a recording are read too.'),
      CAN_CHOOSE_FOLDER ? null : h('p.note', {}, 'On an iPad, choose the files of the recordings: their names become their IDs. Choosing a whole dataset folder, with its paths, needs a computer.'),
      field('Add them to', this.addScope, { hint: 'Recordings for a reference set are only offered for training, never for study annotation.' }),
      this.replace,
      h('div.btn-row', {}, this.folderBtn, this.filesBtn), folderInput, filesInput,
      this.progress, this.addMsg, this.review);
  }

  _setJob(job) {
    this.job = job;
    for (const b of [this.folderBtn, this.filesBtn]) b.disabled = Boolean(job);
    this.addScope.disabled = job === 'registering';
    if (this.registerBtn) this.registerBtn.disabled = Boolean(job);
  }

  /** Read the chosen files with the recording builder and show what was found. */
  async read(files) {
    if (this.job) return;
    this._setJob('reading');
    this.addMsg.clear();
    clear(this.review);
    this.found = null;
    this.progress.set(null, `Reading ${plural(files.length, 'file')}…`);
    try {
      let mod;
      try {
        mod = await loadRegisterModule();
      } catch {
        throw new Error('This copy of ElectroClean cannot read recordings for the register yet. Update it, or register the recordings with the command electroclean-web register.');
      }
      let settings = {};
      try { settings = (await this.area.read('settings_get')).settings || {}; } catch { /* the builder's defaults */ }
      const scope = this.addScope.value || 'study';
      const out = await mod.buildManifests(files, {
        settings, scope,
        onProgress: (p) => { const { text, fraction } = progressText(p); this.progress.set(fraction, text); },
      });
      this.found = { manifests: out.manifests || [], failures: out.failures || [] };
      this.progress.hide();
      this._showReview();
    } catch (exc) {
      this.progress.hide();
      this.addMsg.problem(exc);
    } finally {
      this._setJob(null);
    }
  }

  _showReview() {
    clear(this.review);
    const { manifests, failures } = this.found;
    const rows = manifests.map((m) => ({ m, s: manifestSummary(m) }));
    const known = new Set(this.recordings.filter((r) => r.scope === (this.addScope.value || 'study')).map((r) => r.recording_id));
    const table = dataTable([
      { title: 'Recording', render: ({ s }) => h('span', {}, recordingName(s.recordingId), known.has(s.recordingId) ? h('span.chip.warning', {}, 'registered already') : null) },
      { title: 'Format', render: ({ s }) => String(s.format).toUpperCase() },
      { title: 'Channels', num: true, render: ({ s }) => `${s.nChannels}${s.nHidden ? ` (+${s.nHidden} hidden)` : ''}` },
      { title: 'Length', num: true, render: ({ s }) => durationText(s.durationS) },
      { title: 'Warnings', render: ({ s }) => (s.warnings.length ? h('ul.warnings', {}, s.warnings.map((w) => h('li', {}, w))) : '–') },
    ], rows, { empty: 'No recordings were found among these files.', pageSize: 20, caption: 'Recordings found' });
    this.registerBtn = h('button.btn.primary', { type: 'button', 'data-log': 'register', disabled: !manifests.length, onclick: () => this.register() },
      manifests.length ? `Add ${plural(manifests.length, 'recording')}` : 'Nothing to add');
    const again = h('button.btn', { type: 'button', onclick: () => { this.found = null; clear(this.review); this.addMsg.clear(); } }, 'Start again');
    this.review.append(
      h('h3', {}, `Found ${plural(manifests.length, 'recording')}`),
      table,
      failures.length ? h('div.banner.failures', { role: 'status' },
        h('p', {}, h('b', {}, `${plural(failures.length, 'file')} could not be read`)),
        h('ul', {}, failures.map((f) => h('li', {}, h('span.file', {}, f.path || f.recording_id || '?'), `: ${f.reason || 'not readable'}`)))) : null,
      h('div.btn-row', {}, this.registerBtn, again));
  }

  /** Send the manifests found, in groups small enough for one request each. */
  async register() {
    if (this.job || !this.found || !this.found.manifests.length) return;
    this._setJob('registering');
    this.addMsg.clear();
    const scope = this.addScope.value || 'study';
    const manifests = this.found.manifests.map((m) => ({ ...m, scope }));
    const groups = chunkManifests(manifests);
    const results = [];
    let sent = 0;
    try {
      for (const group of groups) {
        this.progress.set(sent / manifests.length, `Adding ${sent + 1}–${sent + group.length} of ${manifests.length}…`);
        results.push(await this.area.write('recordings_register', { scope, manifests: group, replace: this.replace.input.checked }));
        sent += group.length;
      }
    } catch (exc) {
      this.progress.hide();
      const done = mergeRegisterResults(results);
      this.addMsg.problem(exc);
      if (sent) this.addMsg.append(h('p.caption', {}, `${plural(done.added.length + done.replaced.length, 'recording')} had been added before this happened. Choose Add again to send the rest: those added already are skipped.`));
      this._setJob(null);
      await this.reload();
      return;
    }
    this.progress.hide();
    const r = mergeRegisterResults(results);
    this.found = null;
    clear(this.review);
    const list = (items) => h('ul.compact', {}, items.slice(0, 50).map((x) => h('li.file', {}, x)), items.length > 50 ? h('li', {}, `and ${items.length - 50} more`) : null);
    this.review.append(h('div.success', { role: 'status' },
      h('p', {}, h('b', {}, `Added ${plural(r.added.length, 'recording')}${r.replaced.length ? `, replaced ${r.replaced.length}` : ''}${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}.`)),
      r.added.length ? list(r.added) : null),
      r.replaced.length ? h('div.note', {}, h('p', {}, h('b', {}, 'Replaced')), list(r.replaced)) : null,
      r.skipped.length ? h('div.banner', {}, h('p', {}, h('b', {}, 'Skipped')),
        h('ul', {}, r.skipped.map((x) => h('li', {}, h('span.file', {}, x.recording_id), `: ${x.reason}`)))) : null,
      r.added.length && scope === 'study' ? h('div.btn-row', {}, h('button.btn', { type: 'button', onclick: () => this.area.go('assignments') }, 'Assign them…')) : null);
    this._setJob(null);
    await this.reload();
  }
}
