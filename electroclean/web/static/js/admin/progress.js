// Progress: how far the study has got and how long the work takes (the operation `stats`). The
// study's totals with a projected finish, recordings completed each day for the study or one
// person, and tables of people and recordings to sort, filter and download. Times are those
// measured in the annotators' browsers: the time a recording was open and not paused.

import { h, clear } from '../ui/dom.js';
import { dailyChart } from './chart.js';
import { ROLES, csvText, minutesText, numberText, percent, projectionText, scopeText, whenText } from './model.js';
import {
  card, chip, dataTable, downloadText, messageArea, recordingName, sectionHead, select, shareBar, tabBar, textInput,
} from './ui.js';

const TIME_NOTE = 'Times are the time each recording was open in the annotator\'s browser and not paused, so breaks are left out.';

export class ProgressSection {
  constructor(area) {
    this.area = area;
    this.data = null;
    this.sets = [];
    this.msg = messageArea();
    this.work = select([['study', 'The study\'s own annotation'], ['all', 'All work, training too']], 'study');
    this.work.id = 'progress-work';
    this.work.addEventListener('change', () => this.show({}));
    this.asOf = h('p.caption', { role: 'status' });
    this.panels = { study: this._studyPanel(), people: this._peoplePanel(), recordings: this._recordingsPanel() };
    this.tabs = tabBar([{ key: 'study', title: 'The study' }, { key: 'people', title: 'Annotators' }, { key: 'recordings', title: 'Recordings' }],
      (key) => { for (const [k, p] of Object.entries(this.panels)) p.hidden = k !== key; this.tab = key; }, 'study');
    this.el = h('section.admin-section', { 'data-section': 'progress' },
      sectionHead('Progress', `How far the study has got, who has done what and how long the work takes. ${TIME_NOTE}`),
      h('div.row.filters.progress-filters', {}, h('label.form-label.inline', { for: 'progress-work' }, 'Count'), this.work, this.asOf),
      this.msg, this.tabs, ...Object.values(this.panels));
    this.panels.people.hidden = true;
    this.panels.recordings.hidden = true;
  }

  async show(params = {}) {
    this.msg.clear();
    this.asOf.textContent = 'Loading…';
    if (params.tab) this.tabs.select(params.tab);
    const turn = (this._turn = (this._turn || 0) + 1);
    try {
      const [s, sets] = await Promise.all([this.area.read('stats', { work: this.work.value }), this.area.read('sets_list').catch(() => ({ sets: [] }))]);
      if (turn !== this._turn) return;
      this.data = s;
      this.sets = sets.sets || [];
    } catch (exc) {
      this.asOf.textContent = '';
      this.msg.problem(exc);
      return;
    }
    this.asOf.textContent = this.data.generated_at ? `As of ${whenText(this.data.generated_at)}.` : '';
    this._fillStudy();
    this._fillPeople();
    this._fillRecordings();
  }

  // ------------------------------------------------------------------- study
  _studyPanel() {
    this.tiles = h('div.stat-tiles.progress-tiles');
    this.person = select([['', 'The whole study']]);
    this.person.setAttribute('aria-label', 'Whose completions');
    this.person.addEventListener('change', () => this._drawChart());
    this.chart = dailyChart([], [], 'Recordings completed');
    this.chartTitle = h('h2', {}, 'Recordings completed each day');
    return h('div.admin-stack', { role: 'tabpanel', 'data-panel': 'study' }, this.tiles,
      card(null, h('div.card-head', {}, this.chartTitle, this.person),
        h('p.caption', {}, 'The last 30 days, counted on the day each recording was saved. Move the pointer over the chart, or focus it and use the arrow keys, to read each day.'),
        this.chart));
  }

  _fillStudy() {
    const t = this.data.totals || {};
    // A figure, or a few words where there is none yet (the projected finish).
    const tile = (value, label, note = '') => h('div.stat-tile', {}, h(`span.stat-value${/^[\d.,–-]+$/.test(String(value)) ? '' : '.words'}`, {}, value), h('span.stat-label', {}, label), note ? h('span.caption', {}, note) : null);
    clear(this.tiles);
    this.tiles.append(
      tile(`${t.done ?? 0}`, `Done of ${t.assigned ?? 0} assigned`, t.assigned ? `${percent(t.share_done)} of the work, ${t.remaining ?? 0} to go` : 'Nothing is assigned yet'),
      tile(numberText(t.annotator_hours, 1), 'Annotator-hours', 'With recordings open, unfinished work included'),
      tile(t.median_minutes === null || t.median_minutes === undefined ? '–' : numberText(t.median_minutes, 1), 'Median minutes per recording', 'Of every recording saved'),
      tile(`${t.done_7d ?? 0}`, 'Done in the last 7 days', `${t.done_30d ?? 0} in the last 30 days`),
      tile(numberText(t.pace_per_day, 1), 'Recordings a day', `The pace of the last ${t.pace_days || 14} days`),
      tile(projectionText(t.projection), 'Projected finish', t.projection && t.projection.status === 'projected' ? `At the pace of the last ${t.pace_days || 14} days` : ''));
    const keep = this.person.value;
    clear(this.person);
    this.person.append(h('option', { value: '' }, 'The whole study'));
    for (const p of this.data.annotators || []) if (p.assigned || p.time_s) this.person.append(h('option', { value: p.annotator_id }, `${p.annotator_id}${p.display_name ? ` · ${p.display_name}` : ''}`));
    if ([...this.person.options].some((o) => o.value === keep)) this.person.value = keep;
    this._drawChart();
  }

  _drawChart() {
    const days = this.data ? this.data.days || [] : [];
    const aid = this.person.value;
    const p = aid ? (this.data.annotators || []).find((x) => x.annotator_id === aid) : null;
    this.chartTitle.textContent = p ? `Recordings completed by ${p.annotator_id} each day` : 'Recordings completed each day';
    this.chart.update(days, p ? p.daily : (this.data ? this.data.daily : []) || [], p ? `Recordings completed by ${p.annotator_id}` : 'Recordings completed by the study');
  }

  // ------------------------------------------------------------------ people
  _peoplePanel() {
    const search = textInput({ type: 'search', placeholder: 'Search by ID or name' });
    search.setAttribute('aria-label', 'Search the annotators');
    const role = select([['', 'Every role'], ['annotator', 'Annotators'], ['admin', 'Administrators']]);
    role.setAttribute('aria-label', 'Role');
    const status = select([['active', 'Active accounts'], ['', 'Active and switched off'], ['disabled', 'Switched off']], 'active');
    status.setAttribute('aria-label', 'Status');
    this.peopleFilters = { search, role, status };
    for (const f of [search, role, status]) f.addEventListener('input', () => this._fillPeople());
    this.people = dataTable([
      { title: 'Annotator', sort: (p) => p.annotator_id, render: (p) => h('span', {},
        h('button.link.person-link', { type: 'button', 'data-person': p.annotator_id, onclick: () => this.area.go('annotators', { annotator: p.annotator_id }) }, p.annotator_id),
        p.display_name ? h('span.caption.block', {}, p.display_name) : null,
        p.role === 'admin' ? h('span.caption.block', {}, ROLES.admin) : null, p.status === 'disabled' ? chip('Switched off', 'warning') : null) },
      { title: 'Assigned', num: true, key: 'assigned' },
      { title: 'Done', num: true, key: 'done' },
      { title: 'In progress', num: true, key: 'in_progress' },
      { title: 'To do', num: true, key: 'todo' },
      { title: 'Share done', sort: (p) => p.share_done, render: (p) => shareBar(p.share_done) },
      { title: 'Total time', num: true, sort: (p) => (p.time_s || 0) + (p.in_progress_s || 0), render: (p) => minutesText((p.time_s || 0) + (p.in_progress_s || 0)) },
      { title: 'Median time', num: true, sort: (p) => p.median_s, render: (p) => minutesText(p.median_s) },
      { title: 'Median annotations', num: true, sort: (p) => p.median_annotations, render: (p) => numberText(p.median_annotations) },
      { title: 'Last 7 days', num: true, key: 'done_7d' },
      { title: 'Last active', sort: (p) => p.last_active, render: (p) => whenText(p.last_active) },
    ], [], { empty: 'Nobody matches.', sortable: true, rowKey: (p) => p.annotator_id, caption: 'Progress of each annotator', pageSize: 50 });
    const csv = h('button.btn', { type: 'button', 'data-log': 'progress-people-csv', onclick: () => this._peopleCsv() }, 'Download the table (CSV)');
    return h('div.admin-stack', { role: 'tabpanel', 'data-panel': 'people' },
      card('Annotators', h('p.caption', {}, `Choose a person to see their work recording by recording. ${TIME_NOTE} Total time includes work in progress.`),
        h('div.row.filters', {}, search, role, status), this.people, h('div.btn-row', {}, csv)));
  }

  _peopleRows() {
    const { search, role, status } = this.peopleFilters;
    const q = search.value.trim().toLowerCase();
    return ((this.data && this.data.annotators) || []).filter((p) => (!role.value || p.role === role.value) && (!status.value || p.status === status.value)
      && (!q || `${p.annotator_id} ${p.display_name || ''}`.toLowerCase().includes(q)));
  }

  _fillPeople() { this.people.update(this._peopleRows(), { keepPage: true }); }

  _peopleCsv() {
    const cols = ['annotator_id', 'display_name', 'role', 'status', 'assigned', 'done', 'in_progress', 'todo', 'share_done', 'time_min', 'in_progress_min',
      'median_min', 'median_annotations', 'done_last_7_days', 'last_active'];
    const rows = this.people.rows().map((p) => ({ ...p, time_min: (p.time_s || 0) / 60, in_progress_min: (p.in_progress_s || 0) / 60,
      median_min: p.median_s === null ? null : p.median_s / 60, done_last_7_days: p.done_7d }));
    downloadText('progress_annotators.csv', csvText(cols, rows), 'text/csv;charset=utf-8');
  }

  // -------------------------------------------------------------- recordings
  _recordingsPanel() {
    const search = textInput({ type: 'search', placeholder: 'Search by name or ID' });
    search.setAttribute('aria-label', 'Search the recordings');
    this.recSearch = search;
    search.addEventListener('input', () => this._fillRecordings());
    this.recs = dataTable([
      { title: 'Recording', sort: (r) => r.file_name || r.recording_id, render: (r) => h('span', {}, recordingName(r.recording_id, r.file_name), r.scope !== 'study' ? h('span.caption.block', {}, scopeText(r.scope, this.sets)) : null) },
      { title: 'Done', num: true, sort: (r) => (r.assigned ? r.done / r.assigned : null), render: (r) => `${r.done} of ${r.assigned}` },
      { title: 'In progress', num: true, key: 'in_progress' },
      { title: 'Median time', num: true, sort: (r) => r.median_s, render: (r) => minutesText(r.median_s) },
      { title: 'Median annotations', num: true, sort: (r) => r.median_annotations, render: (r) => numberText(r.median_annotations) },
      { title: 'Fewest', num: true, sort: (r) => r.min_annotations, render: (r) => numberText(r.min_annotations) },
      { title: 'Most', num: true, sort: (r) => r.max_annotations, render: (r) => numberText(r.max_annotations) },
      { title: 'Spread', num: true, sort: (r) => (r.max_annotations === null || r.max_annotations === undefined ? null : r.max_annotations - r.min_annotations),
        render: (r) => (r.max_annotations === null || r.max_annotations === undefined ? '–' : String(r.max_annotations - r.min_annotations)) },
    ], [], { empty: 'Nothing is assigned yet.', sortable: true, rowKey: (r) => `${r.scope}|${r.recording_id}`, caption: 'Progress of each recording', pageSize: 50 });
    const csv = h('button.btn', { type: 'button', 'data-log': 'progress-recordings-csv', onclick: () => this._recordingsCsv() }, 'Download the table (CSV)');
    return h('div.admin-stack', { role: 'tabpanel', 'data-panel': 'recordings' },
      card('Recordings', h('p.caption', {}, 'How many of the people given each recording have saved it, and the fewest and most annotations among them: a wide spread can show a recording that is hard to annotate. ' + TIME_NOTE),
        h('div.row.filters', {}, search), this.recs, h('div.btn-row', {}, csv)));
  }

  _fillRecordings() {
    const q = this.recSearch.value.trim().toLowerCase();
    this.recs.update(((this.data && this.data.recordings) || []).filter((r) => !q || `${r.recording_id} ${r.file_name || ''}`.toLowerCase().includes(q)), { keepPage: true });
  }

  _recordingsCsv() {
    const cols = ['scope', 'recording_id', 'file_name', 'assigned', 'done', 'in_progress', 'median_min', 'median_annotations', 'min_annotations', 'max_annotations'];
    const rows = this.recs.rows().map((r) => ({ ...r, median_min: r.median_s === null ? null : r.median_s / 60 }));
    downloadText('progress_recordings.csv', csvText(cols, rows), 'text/csv;charset=utf-8');
  }
}
