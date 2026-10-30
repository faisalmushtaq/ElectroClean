// Datasets: where the study's recordings come from and how far each set has been rated. Three tabs.
// Datasets lists the source datasets (the built-in "Study recordings" first) with a page for each: its
// details, licence and target of ratings, the summary derived from its recordings, the recordings
// themselves (moved to another dataset or added to a collection, several at once) and its hand-outs.
// Collections are hand-picked, ordered lists drawn from any datasets, made by ticking recordings or from
// filters. Tracking shows who has what: datasets, collections or hand-outs by people, then one target's
// recordings by people, each cell with its dates, downloadable as a table (docs/web/admin.md,
// "Datasets"; the operations are in docs/web/api.md, "Datasets, collections, groups and hand-outs").

import { h, clear } from '../ui/dom.js';
import { icon } from '../views/common.js';
import { newId } from '../util.js';
import { csvText, durationText, formatName, plural, whenText } from './model.js';
import {
  actionButton, card, checkbox, checkList, chip, confirmInline, dataTable, field, infoTable, messageArea, numberInput, put, recordingName,
  sectionHead, select, shareBar, tabBar, textArea, textInput, downloadText,
} from './ui.js';
import {
  CELL_STATUS, DATASET_FIELDS, DEFAULT_DATASET_ID, MAX_COLLECTION, RATINGS_MAX, RATINGS_MIN, RATINGS_TARGET, STATUS_ORDER, TRACKING_COLUMNS, TRACK_KINDS,
  builtFrom, builtFromText, cellTitle, cellWord, channelsText, datasetBody, figuresText, filterForCollection, filterSummary, formatsText, hoursText,
  inUse, moved, peopleById, peopleShown, personText, ratedShare, ratingsTarget, ratingsText, recordingRatings, recordingsQuery, summaryCell,
  summaryRows, trackingCsvRows, trackingFileName,
} from './datasets_model.js';
import { handoutProgress, modeText, dueState } from './handouts_model.js';

const TABS = [{ key: 'datasets', title: 'Datasets' }, { key: 'collections', title: 'Collections' }, { key: 'tracking', title: 'Tracking' }];
const DEFAULT_WORDS = 'Recordings registered before datasets existed, and those added without choosing one.';

/** A select of the targets of ratings, 1 to 20 people. */
function targetSelect(value) {
  return select(Array.from({ length: RATINGS_MAX - RATINGS_MIN + 1 }, (_, i) => [String(RATINGS_MIN + i), plural(RATINGS_MIN + i, 'person', 'people')]), String(value || RATINGS_TARGET));
}

/** The state of a dataset or collection as chips: Fully rated, Archived, Built-in. */
function stateChips(rec) {
  return h('span.chips-inline', {},
    rec.state === 'archived' ? chip('Archived', 'warning') : null,
    rec.fully_rated ? chip('Fully rated', 'done') : null,
    rec.default ? chip('Built-in') : null,
    rec.state !== 'archived' && !rec.fully_rated && !rec.default ? chip('In use', 'active') : null);
}

/** The share of recordings that met the target, as a bar with words under it. */
function ratedCell(rec) {
  return h('span.ds-rated', {}, shareBar(ratedShare(rec)), h('span.caption.block', {}, ratingsText(rec)));
}

export class DatasetsSection {
  constructor(area) {
    this.area = area;
    this.tab = 'datasets';
    this.datasets = [];
    this.collections = [];
    this.users = [];
    this.view = { dataset: null, collection: null };
    this.msg = messageArea();
    this.panes = { datasets: h('div.admin-stack.ds-pane', { role: 'tabpanel' }), collections: h('div.admin-stack.ds-pane', { role: 'tabpanel', hidden: true }),
      tracking: h('div.admin-stack.ds-pane', { role: 'tabpanel', hidden: true }) };
    this.tabs = tabBar(TABS, (key) => { this._shown = this._tab(key); });
    this.tabs.setAttribute('aria-label', 'Datasets, collections and tracking');
    this.el = h('section.admin-section', { 'data-section': 'datasets' },
      sectionHead('Datasets', 'Where the study\'s recordings come from, the collections drawn from them, and who has rated which recordings. '
        + 'Annotators never see the names, descriptions or notes kept here: a hand-out reaches them only by its title.'),
      this.msg, this.tabs, this.panes.datasets, this.panes.collections, this.panes.tracking);
    this._buildTracking();
  }

  async show(params = {}) {
    this.msg.clear();
    if (params.dataset !== undefined) { this.view.dataset = params.dataset; this.tab = 'datasets'; }
    if (params.collection !== undefined) { this.view.collection = params.collection; this.tab = 'collections'; }
    if (params.tab && TABS.some((t) => t.key === params.tab)) this.tab = params.tab;
    if (params.track) { this.tab = 'tracking'; this.trackTarget = params.track; }
    if (params.newCollection) { this.tab = 'collections'; this.view.collection = null; this._pending = { ids: params.newCollection }; }
    this.tabs.select(this.tab);
    await this._shown;
  }

  /** Show a tab and wait until it is drawn. */
  _open(key) {
    this.tabs.select(key);
    return this._shown;
  }

  async _tab(key) {
    if (this.tab !== key) this.msg.clear();
    this.tab = key;
    for (const [k, pane] of Object.entries(this.panes)) pane.hidden = k !== key;
    try {
      await this._loadLists();
    } catch (exc) {
      this.msg.problem(exc);
      return;
    }
    if (key === 'datasets') await (this.view.dataset ? this._datasetPage(this.view.dataset) : this._datasetList());
    else if (key === 'collections') await (this.view.collection ? this._collectionPage(this.view.collection) : this._collectionList());
    else await this._loadTracking();
  }

  async _loadLists() {
    const [d, c, u] = await Promise.all([this.area.read('datasets_list'), this.area.read('collections_list'),
      this.area.read('users_list').catch(() => ({ users: [] }))]);
    this.datasets = d.datasets || [];
    this.defaultId = d.default_id || DEFAULT_DATASET_ID;
    this.collections = c.collections || [];
    this.users = u.users || [];
  }

  _datasetName(id) {
    const d = this.datasets.find((x) => x.dataset_id === (id || this.defaultId));
    return d ? d.name || d.dataset_id : id || 'Study recordings';
  }

  // ===================================================================== datasets
  async _datasetList(note = null) {
    const pane = this.panes.datasets;
    clear(pane);
    const msg = messageArea();
    const formHost = h('div');
    const add = h('button.btn.primary', { type: 'button', 'data-log': 'dataset-new', onclick: () => { add.hidden = true; this._newDatasetForm(formHost, () => { add.hidden = false; }); } }, icon('plus'), 'New dataset');
    const table = dataTable([
      { title: 'Dataset', sort: (d) => (d.default ? '' : d.name || d.dataset_id), render: (d) => h('span', {},
        h('button.link.ds-open', { type: 'button', 'data-dataset': d.dataset_id, onclick: () => this.openDataset(d.dataset_id) }, d.name || d.dataset_id),
        h('span.caption.block', {}, d.licence ? `${d.dataset_id} · ${d.licence}` : d.dataset_id)) },
      { title: 'Recordings', num: true, sort: (d) => (d.summary || {}).n_recordings || 0, render: (d) => String((d.summary || {}).n_recordings || 0) },
      { title: 'Formats', render: (d) => formatsText((d.summary || {}).formats) },
      { title: 'Channels', num: true, sort: (d) => ((d.summary || {}).n_channels || {}).max ?? null, render: (d) => channelsText((d.summary || {}).n_channels) },
      { title: 'Length', num: true, sort: (d) => (d.summary || {}).duration_s || 0, render: (d) => hoursText((d.summary || {}).duration_s) },
      { title: 'Rated', sort: (d) => ratedShare(d), render: ratedCell },
      { title: 'Hand-outs', num: true, key: 'n_handouts' },
      { title: 'State', sort: (d) => d.state, render: stateChips },
    ], this.datasets, { empty: 'No datasets yet.', caption: 'Datasets', sortable: true, pageSize: 50, rowKey: (d) => d.dataset_id });
    put(pane, card('Source datasets',
      h('p.caption', {}, 'A recording belongs to one dataset. Choose the dataset when adding recordings; recordings added without one, and those added before datasets existed, are in Study recordings.'),
      h('div.btn-row', {}, add), formHost, msg, table));
    if (note) msg.show(...note);
  }

  openDataset(id) {
    this.view.dataset = id;
    this.tabs.select('datasets');
  }

  _newDatasetForm(host, done) {
    clear(host);
    const msg = messageArea();
    const controls = {};
    for (const [key, , , rows] of DATASET_FIELDS) controls[key] = rows ? textArea({ rows }) : textInput({ maxlength: key === 'name' ? 120 : null });
    controls.dataset_id = textInput({ placeholder: 'Made from the name when left empty', maxlength: 64 });
    controls.path_prefix = textInput({ placeholder: 'For example ds003420' });
    controls.ratings_target = targetSelect(RATINGS_TARGET);
    let requestId = null; // kept until the study has the dataset, so that a press after a late answer makes no second one
    const make = actionButton('Make the dataset', { kind: 'primary', working: 'Making it…', msg, log: 'dataset-create', onClick: async () => {
      const values = Object.fromEntries(Object.entries(controls).map(([k, c]) => [k, c.value]));
      const body = datasetBody(values, { creating: true });
      requestId = requestId || newId();
      const r = await this.area.write('dataset_create', { ...body, request_id: requestId });
      requestId = null;
      this.view.dataset = r.dataset.dataset_id;
      await this._open('datasets');
      this.msg.show('success', `${r.already ? 'Already made' : 'Made'}: the dataset ${r.dataset.name}. Add its recordings on the Recordings page, choosing it as their dataset.`);
    } });
    const cancel = h('button.btn', { type: 'button', onclick: () => { clear(host); done(); } }, 'Cancel');
    const one = (key) => { const [, label, hint] = DATASET_FIELDS.find((f) => f[0] === key); return field(label, controls[key], { hint }); };
    const area = (key) => { const [, label, hint] = DATASET_FIELDS.find((f) => f[0] === key); return field(label, controls[key], { hint, wide: true }); };
    host.append(h('div.ds-form', { 'data-form': 'dataset-new' }, h('h3', {}, 'New dataset'),
      h('div.form-grid.ds-fields', {}, one('name'),
        field('ID (optional)', controls.dataset_id, { hint: 'Letters, digits, hyphens and underscores; it cannot be changed later.' }),
        field('Target of ratings', controls.ratings_target, { hint: 'How many different people should save each recording before it counts as rated.' }),
        one('origin'), one('licence'), one('contact'),
        field('Path prefix (optional)', controls.path_prefix, { hint: 'Put in front of each recording ID registered into it, so that two datasets that both have sub-001 keep apart. Fixed once it has recordings.' }),
        area('description'), area('citation'), area('notes')),
      h('div.btn-row', {}, make, cancel), msg));
    controls.name.focus();
  }

  async _datasetPage(id, note = null) {
    const pane = this.panes.datasets;
    clear(pane);
    const back = h('button.btn.quiet', { type: 'button', 'data-log': 'dataset-back', onclick: () => { this.view.dataset = null; this._datasetList(); } }, icon('arrow-left'), 'All datasets');
    pane.append(h('div.btn-row', {}, back), h('p.caption.admin-loading', { role: 'status' }, 'Loading…'));
    let got;
    let handouts = [];
    try {
      [got, handouts] = await Promise.all([this.area.read('dataset_get', { dataset_id: id }),
        this.area.read('handouts_list', { target: { kind: 'dataset', id } }).then((x) => x.handouts || []).catch(() => [])]);
    } catch (exc) {
      clear(pane);
      pane.append(h('div.btn-row', {}, back));
      this.msg.problem(exc);
      return;
    }
    clear(pane);
    const d = got.dataset;
    const rows = got.recordings || [];
    const msg = messageArea();
    const head = card(null,
      h('div.card-head', {}, h('h2', { 'data-dataset-title': d.dataset_id }, d.name || d.dataset_id), stateChips(d)),
      h('p.ds-description', {}, d.description || (d.default ? DEFAULT_WORDS : h('span.caption', {}, 'No description yet.'))),
      infoTable([['ID', d.dataset_id], d.origin ? ['Origin', d.origin] : null, d.licence ? ['Licence', d.licence] : null,
        d.path_prefix ? ['Path prefix', h('code', {}, `${d.path_prefix}/`)] : null, ...summaryRows(d)]),
      h('div.btn-row', {},
        h('button.btn.primary', { type: 'button', 'data-log': 'dataset-handout', disabled: d.state === 'archived' || !inUse(d),
          title: inUse(d) ? null : 'It has no recordings in use to hand out.', onclick: () => this.area.go('handouts', { target: { kind: 'dataset', id: d.dataset_id } }) }, 'Hand out this dataset…'),
        h('button.btn', { type: 'button', 'data-log': 'dataset-add-recordings', disabled: d.state === 'archived',
          onclick: () => this.area.go('recordings', { dataset: d.dataset_id }) }, 'Add recordings to it…'),
        h('button.btn', { type: 'button', 'data-log': 'dataset-track', onclick: () => { this.trackTarget = { kind: 'dataset', id: d.dataset_id }; this.tabs.select('tracking'); } }, 'Who has rated what')),
      msg);
    pane.append(h('div.btn-row', {}, back), head, this._recordingsCard(d, rows), this._handoutsCard(handouts), this._detailsCard(d));
    if (note) msg.show(...note);
    const h2 = head.querySelector('h2');
    if (h2) { h2.tabIndex = -1; h2.focus({ preventScroll: true }); }
  }

  _detailsCard(d) {
    const msg = messageArea();
    const controls = {};
    for (const [key, , , rows] of DATASET_FIELDS) {
      controls[key] = rows ? textArea({ rows, value: d[key] || '' }) : textInput({ value: d[key] || '' });
    }
    const fixed = Boolean((d.summary || {}).n_recordings);
    controls.path_prefix = textInput({ value: d.path_prefix || '' });
    controls.path_prefix.disabled = fixed;
    controls.ratings_target = targetSelect(d.ratings_target);
    const save = actionButton('Save the details', { kind: 'primary', working: 'Saving…', msg, log: 'dataset-save', onClick: async () => {
      const values = Object.fromEntries(Object.entries(controls).map(([k, c]) => [k, c.value]));
      if (fixed) delete values.path_prefix;
      const body = datasetBody(values);
      const changes = Object.fromEntries(Object.entries(body).filter(([k, v]) => (k === 'ratings_target' ? Number(d[k]) !== v : (d[k] || '') !== v)));
      if (!Object.keys(changes).length) { msg.show('note', 'Nothing has changed.'); return; }
      const r = await this.area.write('dataset_update', { dataset_id: d.dataset_id, ...changes });
      await this._loadLists();
      await this._datasetPage(d.dataset_id, ['success', r.changed && r.changed.length ? 'The details are saved.' : 'Nothing has changed.']);
    } });
    const archive = d.default ? null : actionButton(d.state === 'archived' ? 'Bring back into use' : 'Archive', { working: 'Saving…', msg, log: 'dataset-archive', onClick: async () => {
      const to = d.state === 'archived' ? 'active' : 'archived';
      await this.area.write('dataset_update', { dataset_id: d.dataset_id, state: to });
      await this._loadLists();
      await this._datasetPage(d.dataset_id, ['success', to === 'archived' ? 'Archived: it takes no new recordings and cannot be handed out again; what it gave stays.' : 'In use again.']);
    } });
    const removeHost = h('span.inline-confirm');
    if (!d.default) {
      removeHost.append(h('button.btn.destructive', { type: 'button', 'data-log': 'dataset-remove', onclick: async () => {
        const n = (d.summary || {}).n_recordings || 0;
        if (n) { msg.show('note', `The dataset still holds ${plural(n, 'recording')}. Move them to another dataset first (tick them below), or archive the dataset instead.`); return; }
        if (!(await confirmInline(removeHost, { text: `Remove the dataset ${d.name}? Its details are kept in the study's records, and it leaves every list here.`, yes: 'Remove it' }))) return;
        try {
          await this.area.write('dataset_remove', { dataset_id: d.dataset_id });
          this.view.dataset = null;
          await this._loadLists();
          await this._datasetList(['success', `The dataset ${d.name} is removed.`]);
        } catch (exc) { msg.problem(exc); }
      } }, 'Remove…'));
    }
    const one = (key) => { const [, label, hint] = DATASET_FIELDS.find((f) => f[0] === key); return field(label, controls[key], { hint }); };
    const area = (key) => { const [, label, hint] = DATASET_FIELDS.find((f) => f[0] === key); return field(label, controls[key], { hint, wide: true }); };
    return card('Details',
      h('div.form-grid.ds-fields', {}, one('name'),
        field('Target of ratings', controls.ratings_target, { hint: 'How many different people should save each recording. It counts every save, whoever gave the recording.' }),
        one('origin'), one('licence'), one('contact'),
        field('Path prefix', controls.path_prefix, { hint: fixed ? 'Fixed: the dataset has recordings registered under it.' : 'Put in front of each recording ID registered into it. Fixed once it has recordings.' }),
        area('description'), area('citation'), area('notes')),
      h('div.btn-row', {}, save, archive, removeHost), msg);
  }

  _recordingsCard(d, rows) {
    const msg = messageArea();
    const bar = h('div.bulk-bar', { hidden: true, role: 'region', 'aria-label': 'Act on the recordings chosen' });
    const table = dataTable([
      { title: 'Recording', sort: (r) => r.file_name || r.recording_id, render: (r) => recordingName(r.recording_id, r.file_name) },
      { title: 'Format', sort: (r) => r.format, render: (r) => formatName(r.format) },
      { title: 'Length', num: true, key: 'duration_s', render: (r) => durationText(r.duration_s) },
      { title: 'Channels', num: true, key: 'n_channels' },
      { title: 'Given to', num: true, key: 'n_given', render: (r) => String(r.n_given || 0) },
      { title: 'Rated', num: true, sort: (r) => r.n_rated || 0, render: (r) => { const x = recordingRatings(r, d.ratings_target); return h('span', {}, x.text, x.met ? h('span.chips-inline', {}, chip('Met', 'done')) : null); } },
      { title: 'Status', sort: (r) => (r.retired ? 1 : 0), render: (r) => (r.retired ? chip('Retired', 'warning') : chip('In use', 'done')) },
    ], rows, { empty: d.default ? 'No recordings here.' : 'No recordings in this dataset yet. Add them on the Recordings page, choosing this dataset.', caption: `Recordings of ${d.name}`,
      sortable: true, selectable: true, pageSize: 25, rowKey: (r) => r.recording_id, onSelect: (keys) => this._recordingsBar(bar, msg, d, keys, table) });
    return card(`Recordings (${rows.length})`, h('p.caption', {}, 'Rated counts the different people who have saved each recording, against the target of ratings. Tick recordings to move them to another dataset or to add them to a collection.'), table, bar, msg);
  }

  _recordingsBar(bar, msg, d, keys, table) {
    clear(bar);
    bar.hidden = !keys.length;
    if (!keys.length) return;
    const others = this.datasets.filter((x) => x.dataset_id !== d.dataset_id && x.state !== 'archived');
    const to = select([['', 'Choose a dataset'], ...others.map((x) => [x.dataset_id, x.name || x.dataset_id])]);
    to.setAttribute('aria-label', 'Move to the dataset');
    const move = actionButton('Move', { kind: 'small', working: 'Moving…', msg, log: 'recordings-move', onClick: async () => {
      if (!to.value) throw new Error('Choose the dataset to move them to.');
      const ids = table.selected();
      const r = await this.area.write('recordings_move', { recording_ids: ids, dataset_id: to.value });
      await this._loadLists();
      await this._datasetPage(d.dataset_id, ['success', `Moved ${plural((r.moved || []).length, 'recording')} to ${this._datasetName(to.value)}.${(r.already || []).length ? ` ${r.already.length} were there already.` : ''}`]);
    } });
    const active = this.collections.filter((c) => c.state !== 'archived');
    const into = select([['', 'Choose a collection'], ['new', 'A new collection…'], ...active.map((c) => [c.collection_id, c.name || c.collection_id])]);
    into.setAttribute('aria-label', 'Add to the collection');
    const addTo = actionButton('Add', { kind: 'small', working: 'Adding…', msg, log: 'collection-add', onClick: async () => {
      const ids = table.selected();
      if (!into.value) throw new Error('Choose the collection to add them to.');
      if (into.value === 'new') { this.view.collection = null; this.area.go('datasets', { newCollection: ids }); return; }
      const c = this.collections.find((x) => x.collection_id === into.value);
      const r = await this.area.write('collection_update', { collection_id: into.value, add: ids });
      table.clearSelection();
      await this._loadLists();
      msg.show('success', `Added to ${c ? c.name : into.value}: ${plural(ids.length, 'recording')} chosen${r.changed && r.changed.length ? '' : ', all there already'}.`);
    } });
    bar.append(h('p', {}, h('b', {}, `${plural(keys.length, 'recording')} chosen`)),
      h('div.btn-row', {}, h('span.bulk-group', {}, h('span.form-label.inline', {}, 'Move to'), to, move),
        h('span.bulk-group', {}, h('span.form-label.inline', {}, 'Add to'), into, addTo),
        h('button.btn.small.quiet', { type: 'button', onclick: () => table.clearSelection() }, 'Clear the choice')));
  }

  _handoutsCard(handouts) {
    return card('Hand-outs', dataTable([
      { title: 'Hand-out', render: (o) => h('span', {}, h('button.link', { type: 'button', onclick: () => this.area.go('handouts', { handout: o.handout_id }) }, o.name || o.title),
        h('span.caption.block', {}, `Annotators see: ${o.title}`)) },
      { title: 'How', render: (o) => modeText(o) },
      { title: 'People', num: true, render: (o) => String((o.counts || {}).people || 0) },
      { title: 'Due', render: (o) => { const s = dueState(o.due_at, ''); return h('span', {}, s.text, (o.counts || {}).overdue_people ? h('span.chips-inline', {}, chip('Overdue', 'warning')) : null); } },
      { title: 'Progress', render: (o) => { const p = handoutProgress(o); return h('span', {}, shareBar(p.share), h('span.caption.block', {}, p.text)); } },
      { title: 'State', render: (o) => (o.state === 'withdrawn' ? chip('Withdrawn') : o.complete ? chip('Complete', 'done') : chip('Open', 'active')) },
    ], handouts, { empty: 'Not handed out yet.', caption: 'Hand-outs of this dataset', pageSize: 10 }));
  }

  // ================================================================== collections
  async _collectionList(note = null) {
    const pane = this.panes.collections;
    clear(pane);
    const msg = messageArea();
    const builderHost = h('div');
    const build = h('button.btn.primary', { type: 'button', 'data-log': 'collection-build', onclick: () => { build.hidden = true; this._builder(builderHost, [], () => { build.hidden = false; }); } }, icon('plus'), 'Build from filters');
    const table = dataTable([
      { title: 'Collection', sort: (c) => c.name, render: (c) => h('span', {},
        h('button.link.ds-open', { type: 'button', 'data-collection': c.collection_id, onclick: () => this.openCollection(c.collection_id) }, c.name || c.collection_id),
        c.description ? h('span.caption.block', {}, c.description.slice(0, 120)) : null) },
      { title: 'Recordings', num: true, key: 'n_recordings' },
      { title: 'From', render: (c) => Object.entries(c.datasets || {}).map(([id, n]) => `${this._datasetName(id)} (${n})`).join(', ') || '–' },
      { title: 'Rated', sort: (c) => ratedShare(c), render: ratedCell },
      { title: 'State', sort: (c) => c.state, render: stateChips },
    ], this.collections, { empty: 'No collections yet. Build one from filters, or tick recordings on a dataset\'s page and add them to a new collection.', caption: 'Collections', sortable: true, pageSize: 50 });
    put(pane, card('Collections',
      h('p.caption', {}, 'A collection is a hand-picked, ordered list of recordings from any datasets, for example the pilot\'s hardest twenty. To pick by hand, tick recordings on a dataset\'s page and choose Add to a new collection.'),
      h('div.btn-row', {}, build), builderHost, msg, table));
    if (this._pending) {
      const { ids } = this._pending;
      this._pending = null;
      build.hidden = true;
      await this._builder(builderHost, ids, () => { build.hidden = false; });
    }
    if (note) msg.show(...note);
  }

  openCollection(id) {
    this.view.collection = id;
    this.tabs.select('collections');
  }

  /** The form that makes a collection: from filters over the datasets' recordings, or of the recordings `picked`. */
  async _builder(host, picked, done) {
    clear(host);
    host.append(h('p.caption.admin-loading', { role: 'status' }, 'Loading the recordings…'));
    const msg = messageArea();
    let rows = [];
    try {
      const all = await Promise.all(this.datasets.map((d) => this.area.read('dataset_get', { dataset_id: d.dataset_id })));
      rows = all.flatMap((x) => x.recordings || []);
    } catch (exc) {
      clear(host);
      msg.problem(exc);
      host.append(msg);
      done();
      return;
    }
    clear(host);
    const name = textInput({ placeholder: 'For example Pilot: 20 hard recordings', maxlength: 120 });
    const description = textArea({ rows: 2, placeholder: 'For the study team; annotators never see it' });
    const target = targetSelect(RATINGS_TARGET);
    const byHand = picked && picked.length;
    const count = h('p.ds-matches', { role: 'status', 'aria-live': 'polite' });
    const preview = dataTable([
      { title: 'Recording', render: (r) => recordingName(r.recording_id, r.file_name) },
      { title: 'Dataset', render: (r) => this._datasetName(r.dataset_id) },
      { title: 'Length', num: true, render: (r) => durationText(r.duration_s) },
      { title: 'Rated by', num: true, render: (r) => plural(r.n_rated || 0, 'person', 'people') },
    ], [], { empty: 'Nothing matches these filters.', caption: 'The recordings it would hold', pageSize: 10 });
    let chosen = [];
    let filters = null;
    let requestId = null;
    let formBox = null;
    let values = () => ({});
    if (byHand) {
      const want = new Set(picked);
      chosen = rows.filter((r) => want.has(r.recording_id));
      chosen.sort((a, b) => picked.indexOf(a.recording_id) - picked.indexOf(b.recording_id));
    } else {
      const formats = [...new Set(rows.map((r) => r.format).filter(Boolean))].sort();
      const sets = checkList(this.datasets.filter((d) => (d.summary || {}).n_recordings).map((d) => ({ value: d.dataset_id, text: d.name || d.dataset_id, extra: plural((d.summary || {}).n_recordings, 'recording') })),
        { legend: 'From the datasets', name: 'collection-datasets', empty: 'No dataset has recordings yet.', selected: this.datasets.map((d) => d.dataset_id) });
      const query = textInput({ type: 'search', placeholder: 'Part of the file name or ID' });
      const format = select([['', 'Any format'], ...formats.map((f) => [f, formatName(f)])]);
      const minM = numberInput({ min: 0, step: 'any' });
      const maxM = numberInput({ min: 0, step: 'any' });
      const ratedMax = numberInput({ min: 0, step: 1 });
      const sampleN = numberInput({ min: 1, step: 1 });
      const seed = numberInput({ value: String(Math.floor(Math.random() * 100000)), min: 0, step: 1 });
      values = () => ({ datasetIds: sets.values(), query: query.value, format: format.value,
        minS: minM.value === '' ? '' : Number(minM.value) * 60, maxS: maxM.value === '' ? '' : Number(maxM.value) * 60,
        nRatedMax: ratedMax.value, sampleN: sampleN.value, seed: seed.value });
      formBox = h('div.ds-filters', {},
        sets, h('div.form-grid', {},
          field('File name', query), field('Format', format),
          field('At least (minutes)', minM), field('At most (minutes)', maxM),
          field('Rated by at most', ratedMax, { hint: 'People who have saved it so far; 0 for recordings nobody has rated.' }),
          field('A random sample of', sampleN, { hint: 'Leave empty for every match.' }),
          field('Seed of the sample', seed, { hint: 'The same seed and filters draw the same recordings again.' })));
      for (const el of [sets, query, format, minM, maxM, ratedMax, sampleN, seed]) { el.addEventListener('input', () => refresh()); el.addEventListener('change', () => refresh()); }
    }
    const refresh = () => {
      if (!byHand) {
        const f = values();
        chosen = filterForCollection(rows, f);
        filters = builtFrom(f);
      }
      count.textContent = byHand ? `${plural(chosen.length, 'recording')} chosen` : `Matches ${chosen.length.toLocaleString('en-GB')}`;
      if (chosen.length > MAX_COLLECTION) count.textContent += `: a collection holds at most ${MAX_COLLECTION.toLocaleString('en-GB')}, so narrow the filters or take a sample.`;
      make.disabled = !chosen.length || chosen.length > MAX_COLLECTION;
      preview.update(chosen);
    };
    const make = actionButton('Make a collection of these', { kind: 'primary', working: 'Making it…', msg, log: 'collection-create', onClick: async () => {
      if (!name.value.trim()) throw new Error('Give the collection a name.');
      requestId = requestId || newId();
      const body = { request_id: requestId, name: name.value.trim(), description: description.value.trim(), recording_ids: chosen.map((r) => r.recording_id),
        ratings_target: ratingsTarget(target.value), ...(byHand ? {} : { built_from: filters }) };
      const r = await this.area.write('collection_create', body);
      requestId = null;
      this.view.collection = r.collection.collection_id;
      await this._open('collections');
      this.msg.show('success', `${r.already ? 'Already made' : 'Made'}: the collection ${r.collection.name}, with ${plural(r.collection.n_recordings, 'recording')}.${(r.skipped || []).length ? ` ${plural(r.skipped.length, 'recording')} left out.` : ''}`);
    } });
    const cancel = h('button.btn', { type: 'button', onclick: () => { clear(host); done(); } }, 'Cancel');
    host.append(h('div.ds-form', { 'data-form': 'collection-new' },
      h('h3', {}, byHand ? 'A new collection of the recordings chosen' : 'Build a collection from filters'),
      byHand ? null : h('p.caption', {}, 'Retired recordings are left out. The filters are kept with the collection, and its list of recordings is what counts.'),
      formBox, count, preview,
      h('div.form-grid', {}, field('Name', name), field('Target of ratings', target, { hint: 'How many different people should save each recording.' }),
        field('Description (optional)', description, { wide: true })),
      h('div.btn-row', {}, make, cancel), msg));
    refresh();
    name.focus();
  }

  async _collectionPage(id, note = null) {
    const pane = this.panes.collections;
    clear(pane);
    const back = h('button.btn.quiet', { type: 'button', 'data-log': 'collection-back', onclick: () => { this.view.collection = null; this._collectionList(); } }, icon('arrow-left'), 'All collections');
    pane.append(h('div.btn-row', {}, back), h('p.caption.admin-loading', { role: 'status' }, 'Loading…'));
    let got;
    let handouts = [];
    try {
      [got, handouts] = await Promise.all([this.area.read('collection_get', { collection_id: id }),
        this.area.read('handouts_list', { target: { kind: 'collection', id } }).then((x) => x.handouts || []).catch(() => [])]);
    } catch (exc) {
      clear(pane);
      pane.append(h('div.btn-row', {}, back));
      this.msg.problem(exc);
      return;
    }
    clear(pane);
    const c = got.collection;
    const byId = Object.fromEntries((got.recordings || []).map((r) => [r.recording_id, r]));
    const ids = c.recording_ids || [];
    const msg = messageArea();
    const head = card(null,
      h('div.card-head', {}, h('h2', { 'data-collection-title': c.collection_id }, c.name || c.collection_id), stateChips(c)),
      c.description ? h('p.ds-description', {}, c.description) : null,
      infoTable([['ID', c.collection_id], ['Recordings', `${c.n_recordings}${c.n_retired ? ` (${c.n_retired} retired)` : ''}${c.n_missing ? `, ${c.n_missing} no longer registered` : ''}`],
        ['From', Object.entries(c.datasets || {}).map(([d, n]) => `${this._datasetName(d)} (${n})`).join(', ') || '–'],
        ['Made', `${whenText(c.created_at)}${c.created_by ? ` by ${c.created_by}` : ''}`], ['How', builtFromText(c.built_from, (x) => this._datasetName(x))],
        ['Ratings', ratingsText(c)]]),
      h('div.btn-row', {},
        h('button.btn.primary', { type: 'button', 'data-log': 'collection-handout', disabled: c.state === 'archived' || !inUse(c),
          onclick: () => this.area.go('handouts', { target: { kind: 'collection', id: c.collection_id } }) }, 'Hand out this collection…'),
        h('button.btn', { type: 'button', onclick: () => { this.trackTarget = { kind: 'collection', id: c.collection_id }; this.tabs.select('tracking'); } }, 'Who has rated what')),
      msg);
    // details
    const dMsg = messageArea();
    const cName = textInput({ value: c.name || '', maxlength: 120 });
    const cDesc = textArea({ rows: 2, value: c.description || '' });
    const cTarget = targetSelect(c.ratings_target);
    const save = actionButton('Save the details', { kind: 'primary', working: 'Saving…', msg: dMsg, log: 'collection-save', onClick: async () => {
      if (!cName.value.trim()) throw new Error('Give the collection a name.');
      const body = { collection_id: c.collection_id };
      if (cName.value.trim() !== c.name) body.name = cName.value.trim();
      if (cDesc.value.trim() !== (c.description || '')) body.description = cDesc.value.trim();
      if (ratingsTarget(cTarget.value) !== Number(c.ratings_target)) body.ratings_target = Number(cTarget.value);
      if (Object.keys(body).length === 1) { dMsg.show('note', 'Nothing has changed.'); return; }
      await this.area.write('collection_update', body);
      await this._loadLists();
      await this._collectionPage(c.collection_id, ['success', 'The details are saved.']);
    } });
    const archive = actionButton(c.state === 'archived' ? 'Bring back into use' : 'Archive', { working: 'Saving…', msg: dMsg, log: 'collection-archive', onClick: async () => {
      await this.area.write('collection_update', { collection_id: c.collection_id, state: c.state === 'archived' ? 'active' : 'archived' });
      await this._loadLists();
      await this._collectionPage(c.collection_id, ['success', c.state === 'archived' ? 'In use again.' : 'Archived: it cannot be handed out again; what it gave stays.']);
    } });
    const removeHost = h('span.inline-confirm');
    removeHost.append(h('button.btn.destructive', { type: 'button', 'data-log': 'collection-remove', onclick: async () => {
      if (!(await confirmInline(removeHost, { text: `Remove the collection ${c.name}? The recordings stay in their datasets, and what was handed out stays with the people given it.`, yes: 'Remove it' }))) return;
      try {
        await this.area.write('collection_remove', { collection_id: c.collection_id });
        this.view.collection = null;
        await this._loadLists();
        await this._collectionList(['success', `The collection ${c.name} is removed.`]);
      } catch (exc) { dMsg.problem(exc); }
    } }, 'Remove…'));
    const details = card('Details', h('div.form-grid', {}, field('Name', cName), field('Target of ratings', cTarget), field('Description', cDesc, { wide: true })),
      h('div.btn-row', {}, save, archive, removeHost), dMsg);
    // the ordered recordings
    const rMsg = messageArea();
    const change = async (body, words) => {
      try {
        await this.area.write('collection_update', { collection_id: c.collection_id, ...body });
        await this._loadLists();
        await this._collectionPage(c.collection_id);
        const again = this.panes.collections.querySelector('[data-collection-recordings] .admin-msg');
        if (again && words) again.show('success', words);
      } catch (exc) { rMsg.problem(exc); }
    };
    const rows = ids.map((rid, i) => ({ ...(byId[rid] || { recording_id: rid, missing: true }), i }));
    const table = dataTable([
      { title: '#', num: true, render: (r) => String(r.i + 1) },
      { title: 'Recording', render: (r) => recordingName(r.recording_id, r.file_name) },
      { title: 'Dataset', render: (r) => (r.missing ? '–' : this._datasetName(r.dataset_id)) },
      { title: 'Rated', num: true, render: (r) => { const x = recordingRatings(r, c.ratings_target); return h('span', {}, x.text, x.met ? h('span.chips-inline', {}, chip('Met', 'done')) : null); } },
      { title: 'Status', render: (r) => (r.missing ? chip('No longer registered', 'warning') : r.retired ? chip('Retired', 'warning') : chip('In use', 'done')) },
      { title: '', cls: 'actions', render: (r) => h('span.ds-order', {},
        h('button.btn.icon.small', { type: 'button', title: 'Move up', 'aria-label': `Move ${r.recording_id} up`, disabled: r.i === 0, 'data-log': 'collection-up',
          onclick: () => change({ order: moved(ids, r.i, -1) }, '') }, icon('arrow-up')),
        h('button.btn.icon.small', { type: 'button', title: 'Move down', 'aria-label': `Move ${r.recording_id} down`, disabled: r.i === ids.length - 1, 'data-log': 'collection-down',
          onclick: () => change({ order: moved(ids, r.i, 1) }, '') }, icon('arrow-down')),
        h('button.btn.icon.small', { type: 'button', title: 'Take out of the collection', 'aria-label': `Take ${r.recording_id} out`, 'data-log': 'collection-take-out',
          onclick: () => change({ remove: [r.recording_id] }, `${r.file_name || r.recording_id} is out of the collection; it stays in its dataset.`) }, icon('close'))) },
    ], rows, { empty: 'The collection is empty. Tick recordings on a dataset\'s page and add them to it.', caption: `Recordings of ${c.name}`, pageSize: 50 });
    const recs = card(`Recordings, in order (${ids.length})`, h('p.caption', {}, 'The order is the order of the list. Retired recordings stay in the collection and are given to nobody new.'), table, rMsg);
    recs.setAttribute('data-collection-recordings', '');
    pane.append(h('div.btn-row', {}, back), head, recs, this._handoutsCard(handouts), details);
    if (note) msg.show(...note);
  }

  // ===================================================================== tracking
  _buildTracking() {
    const kind = select(TRACK_KINDS, 'dataset');
    kind.setAttribute('aria-label', 'Rows');
    const person = select([['', 'Everyone']]);
    person.setAttribute('aria-label', 'Person');
    const complete = select([['', 'Complete or not'], ['no', 'Not complete'], ['yes', 'Complete']]);
    complete.setAttribute('aria-label', 'Complete');
    const overdue = checkbox('Overdue only');
    this.trackFilters = { kind, person, complete, overdue };
    kind.addEventListener('change', () => this._loadTracking());
    for (const el of [person, complete, overdue.input]) el.addEventListener('change', () => this._drawSummary());
    this.trackMsg = messageArea();
    this.figures = h('span.caption.ds-figures', { role: 'status' });
    const refresh = actionButton('Refresh', { kind: 'small', working: 'Refreshing…', msg: this.trackMsg, log: 'tracking-refresh', onClick: () => this._loadTracking({ refresh: true }) });
    this.summaryHost = h('div.ds-summary');
    this.detailHost = h('div.ds-track-detail');
    this.trackCard = card('Who has what',
      h('p.caption', {}, 'Each cell counts what one person has saved of what they were given. Hover a cell for its dates; choose a name to see its recordings one by one.'),
      h('div.row.filters', {}, kind, person, complete, overdue), h('div.row.ds-figures-row', {}, this.figures, refresh), this.trackMsg, this.summaryHost);
    this.panes.tracking.append(this.trackCard, this.detailHost);
  }

  async _loadTracking({ refresh = false } = {}) {
    const kind = this.trackFilters.kind.value || 'dataset';
    if (this.trackTarget && this.trackTarget.kind !== kind && TRACK_KINDS.some(([k]) => k === this.trackTarget.kind)) {
      this.trackFilters.kind.value = this.trackTarget.kind;
      return this._loadTracking({ refresh });
    }
    this.trackMsg.clear();
    clear(this.summaryHost);
    this.summaryHost.append(h('p.caption.admin-loading', { role: 'status' }, 'Working out the figures…'));
    const turn = (this._trackTurn = (this._trackTurn || 0) + 1);
    let a;
    try {
      const body = { kind, ...(refresh ? { refresh: true } : {}) };
      a = refresh ? await this.area.backend.admin('tracking_datasets_get', body) : await this.area.read('tracking_datasets_get', body);
    } catch (exc) {
      if (turn !== this._trackTurn) return;
      clear(this.summaryHost);
      this.trackMsg.problem(exc);
      return;
    }
    if (turn !== this._trackTurn) return;
    this.summary = a;
    this.people = peopleById(a.people, this.users);
    this.figures.textContent = figuresText(a);
    const p = this.trackFilters.person;
    const keep = p.value;
    clear(p);
    p.append(h('option', { value: '' }, 'Everyone'), ...(a.people || []).map((x) => h('option', { value: x.annotator_id }, personText(x.annotator_id, this.people))));
    p.value = (a.people || []).some((x) => x.annotator_id === keep) ? keep : '';
    this._drawSummary();
    if (this.trackTarget) {
      const t = this.trackTarget;
      this.trackTarget = null;
      await this._recordingGrid(t);
    }
  }

  _drawSummary() {
    if (!this.summary) return;
    const f = this.trackFilters;
    const rows = filterSummary(this.summary.rows, { person: f.person.value, overdue: f.overdue.input.checked, complete: f.complete.value });
    const people = peopleShown(this.summary.people, rows, f.person.value);
    const kindWord = (TRACK_KINDS.find(([k]) => k === f.kind.value) || ['', 'Datasets'])[1];
    const cols = [
      { title: kindWord.replace(/s$/, ''), sort: (r) => r.name, render: (r) => h('span', {},
        h('button.link.ds-open', { type: 'button', 'data-track': `${r.kind}:${r.id}`, onclick: () => this._recordingGrid({ kind: r.kind, id: r.id }) }, r.name || r.id),
        h('span.caption.block', {}, plural(inUse(r), 'recording'))) },
      { title: 'Rated', sort: (r) => ratedShare(r), render: (r) => h('span.ds-rated', {}, shareBar(ratedShare(r)), h('span.caption.block', {}, ratingsText(r))) },
      ...people.map((p) => ({
        title: personText(p.annotator_id, this.people), num: true, cls: 'ds-cell',
        sort: (r) => { const c = summaryCell((r.cells || {})[p.annotator_id]); return c.given ? c.saved / c.given : null; },
        render: (r) => {
          const c = summaryCell((r.cells || {})[p.annotator_id]);
          return h('span.ds-count', { title: c.title, 'data-person': p.annotator_id }, c.text, c.overdue ? h('span.chips-inline', {}, chip('Overdue', 'warning')) : c.done && c.given ? h('span.chips-inline', {}, chip('Done', 'done')) : null);
        },
      })),
    ];
    clear(this.summaryHost);
    this.summaryHost.append(dataTable(cols, rows, { empty: (this.summary.rows || []).length ? 'Nothing matches the filters.' : `No ${kindWord.toLowerCase()} yet.`,
      caption: `${kindWord} by people`, sortable: true, pageSize: 50 }));
  }

  /** The recordings of one dataset, collection or hand-out by people, from the first page on. */
  async _recordingGrid(target) {
    this.gridTarget = target;
    this.gridRows = [];
    clear(this.detailHost);
    const status = select([['', 'Every status'], ...STATUS_ORDER.map((s) => [s, CELL_STATUS[s][0]])]);
    status.setAttribute('aria-label', 'Status');
    const person = select([['', 'Everyone'], ...(this.summary ? this.summary.people : []).map((p) => [p.annotator_id, personText(p.annotator_id, this.people)])]);
    person.setAttribute('aria-label', 'Person');
    const overdue = checkbox('Overdue only');
    const query = textInput({ type: 'search', placeholder: 'Search by file name' });
    query.setAttribute('aria-label', 'Search the recordings');
    const msg = messageArea();
    const note = h('p.caption', { role: 'status' });
    const host = h('div.ds-grid');
    const more = h('div.btn-row');
    const filters = () => ({ status: status.value, person: person.value, overdue: overdue.input.checked, query: query.value });
    const heading = h('h2', {}, 'Loading…');
    const draw = (answer) => {
      const people = person.value ? (answer.people || []).filter((p) => p.annotator_id === person.value) : (answer.people || []);
      clear(host);
      host.append(dataTable([
        { title: 'Recording', sort: (r) => r.file_name || r.recording_id, render: (r) => h('span', {}, recordingName(r.recording_id, r.file_name), r.retired ? h('span.chips-inline', {}, chip('Retired', 'warning')) : null) },
        ...(target.kind === 'dataset' ? [] : [{ title: 'Dataset', sort: (r) => r.dataset_id, render: (r) => this._datasetName(r.dataset_id) }]),
        { title: 'Ratings', num: true, sort: (r) => r.n_rated || 0, render: (r) => { const x = recordingRatings(r); return h('span', {}, x.text, x.met ? h('span.chips-inline', {}, chip('Met', 'done')) : null); } },
        ...people.map((p) => ({ title: personText(p.annotator_id, this.people), cls: 'ds-cell', sort: (r) => STATUS_ORDER.indexOf(((r.cells || {})[p.annotator_id] || {}).status || 'not_given'),
          render: (r) => {
            const c = (r.cells || {})[p.annotator_id] || { status: 'not_given' };
            const w = cellWord(c);
            return h('span.ds-status', { title: cellTitle(c), 'data-person': p.annotator_id, 'data-status': c.status },
              c.status === 'not_given' ? h('span.caption', {}, w.text) : chip(w.text, w.kind), c.overdue ? h('span.chips-inline', {}, chip('Overdue', 'warning')) : null);
          } })),
      ], this.gridRows, { empty: 'No recordings match the filters.', caption: `Recordings of ${answer.target ? answer.target.name : ''} by people`, sortable: true, pageSize: 50 }));
    };
    const load = async ({ offset = 0, refresh = false } = {}) => {
      msg.clear();
      const turn = (this._gridTurn = (this._gridTurn || 0) + 1);
      const body = recordingsQuery(target, { ...filters(), refresh }, offset);
      let a;
      try {
        a = await this.area.backend.admin('tracking_recordings_get', body);
      } catch (exc) {
        if (turn === this._gridTurn) msg.problem(exc);
        return;
      }
      if (turn !== this._gridTurn || this.gridTarget !== target) return;
      this.gridAnswer = a;
      this.gridRows = offset ? [...this.gridRows, ...(a.rows || [])] : (a.rows || []);
      heading.textContent = (a.target && a.target.name) || target.id;
      note.textContent = `${figuresText(a)}. Showing ${this.gridRows.length.toLocaleString('en-GB')} of ${plural(a.total ?? this.gridRows.length, 'recording')}.`;
      draw(a);
      clear(more);
      if (a.next !== null && a.next !== undefined) {
        more.append(actionButton(`Load the next ${Math.min(1000, (a.total || 0) - this.gridRows.length).toLocaleString('en-GB')}`, { working: 'Loading…', msg, log: 'tracking-more', onClick: () => load({ offset: a.next }) }));
      }
    };
    for (const el of [status, person, overdue.input]) el.addEventListener('change', () => load());
    let timer = null;
    query.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(), 300); });
    const download = actionButton('Download as a table (CSV)', { working: 'Gathering every page…', msg, log: 'tracking-csv', onClick: async () => {
      const all = [];
      let offset = 0;
      let a;
      let pages = 0;
      do {
        a = await this.area.backend.admin('tracking_recordings_get', recordingsQuery(target, filters(), offset));
        all.push(...(a.rows || []));
        offset = a.next;
        pages += 1;
      } while (offset !== null && offset !== undefined && pages < 200);
      const rows = trackingCsvRows(target, a.people, all, { person: person.value });
      downloadText(trackingFileName(target), csvText(TRACKING_COLUMNS, rows), 'text/csv;charset=utf-8');
      msg.show('success', `Downloaded ${plural(rows.length, 'row')}: one for each recording and person. The table names people by their IDs only.`);
    } });
    const close = h('button.btn.quiet', { type: 'button', onclick: () => { this.gridTarget = null; clear(this.detailHost); } }, 'Close');
    const kindWord = { dataset: 'Dataset', collection: 'Collection', handout: 'Hand-out' }[target.kind] || '';
    this.detailHost.append(card(null, h('div.card-head', {}, h('div', {}, h('span.caption.block', {}, kindWord), heading), close),
      h('p.caption', {}, 'Each cell is where one person stands with one recording. Ratings counts the different people who saved it, against the target. Hover a cell for its dates.'),
      h('div.row.filters', {}, status, person, overdue, query), note, msg, host, more, h('div.btn-row', {}, download)));
    await load();
    heading.tabIndex = -1;
    heading.focus({ preventScroll: false });
  }

  /** For the browser tests. */
  debugState() {
    return { tab: this.tab, view: { ...this.view }, grid: this.gridTarget || null, rows: (this.gridRows || []).length };
  }
}

