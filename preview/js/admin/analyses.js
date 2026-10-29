// Analyses, computed by the study with ElectroTag's own code: the agreement between annotators
// (the settings of electrotag.reliability.config.AnalysisConfig), the activity analysis and
// learning curves from the interaction logs, and competency reports. Each report is shown in a
// sandboxed frame and offered for download with its tables. An analysis cannot be started again
// while it runs.

import { h, clear } from '../ui/dom.js';
import { MATCH_CRITERIA, analysisProblems, defaultAnalysisConfig, fileParts, parseList, parseNumber, parseNumbers } from './model.js';
import {
  card, checkbox, checkList, downloadText, elapsedTimer, field, messageArea, numberInput, progressLine, reportFrame, sectionHead, select,
  textInput,
} from './ui.js';

const SESSION_MODES = [['standard', 'Research annotation'], ['practice', 'Practice'], ['assessment', 'Assessment']];

/** The downloads of a report: its HTML and each table. */
function downloads(base, html, tables, extra = []) {
  const buttons = [];
  if (html) buttons.push(h('button.btn', { type: 'button', onclick: () => downloadText(`${base}_report.html`, html, 'text/html;charset=utf-8') }, 'Download the report (HTML)'));
  for (const [name, text] of Object.entries(tables || {})) {
    buttons.push(h('button.btn.small', { type: 'button', onclick: () => downloadText(name, text, 'text/tab-separated-values;charset=utf-8') }, name));
  }
  return h('div.btn-row.downloads', {}, ...buttons, ...extra);
}

function summaryTable(summary) {
  const rows = Object.entries(summary || {}).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v) || Array.isArray(v));
  if (!rows.length) return null;
  const text = (v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : v === null ? '–' : String(v));
  return h('table.info.admin-info', {}, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, k.replace(/_/g, ' ')), h('td', {}, text(v))))));
}

export class AnalysesSection {
  constructor(area) {
    this.area = area;
    this.running = new Set(); // 'agreement' | 'activity' | 'competency'
    this.users = [];
    this.recordings = [];
    this.sets = [];
    this.msg = messageArea();
    this.agreementHost = h('div.admin-stack');
    this.activityHost = h('div.admin-stack');
    this.competencyHost = h('div.admin-stack');
    // Results stay when the forms are made again (when the lists of people or recordings changed).
    this.results = { agreement: h('div.admin-stack'), activity: h('div.admin-stack'), competency: h('div.admin-stack') };
    this.el = h('section.admin-section', { 'data-section': 'analyses' },
      sectionHead('Analyses', 'The study computes these from the saved annotations and the interaction logs, with the same code as the command-line tools. Large studies take a while.'),
      this.msg, this.agreementHost, this.activityHost, this.competencyHost);
  }

  async show() {
    this.msg.clear();
    if (this.running.size) return; // keep the forms and the running analysis as they are
    try {
      const [u, r, s] = await Promise.all([this.area.read('users_list'), this.area.read('recordings_list', { scope: 'study' }),
        this.area.read('sets_list').catch(() => ({ sets: [] }))]);
      this.users = u.users || [];
      this.recordings = r.recordings || [];
      this.sets = s.sets || [];
    } catch (exc) {
      this.msg.problem(exc);
      return;
    }
    const lists = JSON.stringify([this.users.map((u) => u.annotator_id), this.recordings.map((r) => r.recording_id), this.sets.map((x) => x.set_id)]);
    if (lists !== this.lists) {
      this.lists = lists;
      for (const host of [this.agreementHost, this.activityHost, this.competencyHost]) clear(host);
      this._agreementForm();
      this._activityForm();
      this._competencyForm();
    }
  }

  /** Run one analysis: the button cannot be pressed again until the answer arrives. */
  async _run(kind, button, progress, msg, fn) {
    if (this.running.has(kind)) return;
    this.running.add(kind);
    button.disabled = true;
    msg.clear();
    const stop = elapsedTimer(progress, 'Working…');
    try {
      await fn();
    } catch (exc) {
      msg.problem(exc);
    } finally {
      stop();
      progress.hide();
      button.disabled = false;
      this.running.delete(kind);
    }
  }

  // ------------------------------------------------------------- agreement
  _agreementForm() {
    const d = defaultAnalysisConfig();
    const annotators = checkList(this.users.map((u) => ({ value: u.annotator_id, text: u.annotator_id, extra: u.display_name || '' })),
      { legend: 'Annotators (none ticked: everyone)', name: 'agreement-annotators' });
    const recordings = checkList(this.recordings.map((r) => ({ value: r.recording_id, text: r.file_name || fileParts(r.recording_id).name, extra: fileParts(r.recording_id).folder })),
      { legend: 'Recordings (none ticked: all)', name: 'agreement-recordings' });
    const modes = SESSION_MODES.map(([v, t]) => ({ v, box: checkbox(t, v === 'standard') }));
    const reference = select([['', 'Nobody: compare every pair'], ...this.users.map((u) => [u.annotator_id, u.annotator_id])]);
    const labels = this.area.labels;
    const categories = checkList(labels.map((l) => ({ value: l.label, text: l.label })), { selected: labels.map((l) => l.label),
      legend: 'Artifact categories (ANY-artifact is always included)', name: 'agreement-categories' });
    const time = checkbox('Time only', true);
    const channel = checkbox('Time and channel', true);
    const resolutions = textInput({ value: d.resolutions_s.join(' ') });
    const coverage = numberInput({ value: d.min_bin_coverage, min: 0, max: 1, step: 0.1 });
    const criterion = select(MATCH_CRITERIA, d.match_criterion);
    const thresholds = textInput({ value: d.iou_thresholds.join(' ') });
    const primary = numberInput({ value: d.primary_iou_threshold, min: 0, max: 0.99, step: 0.05 });
    const onTol = numberInput({ value: d.onset_tolerance_s, min: 0, max: 60, step: 0.05 });
    const offTol = numberInput({ value: d.offset_tolerance_s, min: 0, max: 60, step: 0.05 });
    const many = checkbox('Allow one event to match several (many-to-one)', d.allow_many_to_one);
    const jaccard = numberInput({ value: d.min_channel_jaccard, min: 0, max: 1, step: 0.1 });
    const minEvents = numberInput({ value: d.min_events_per_category, min: 0, step: 1 });
    const anyArtifact = checkbox('Include ANY-artifact (any artifact against none)', d.include_any_artifact);
    const rollups = checkbox('Include group roll-ups (for example Eye-artifact and its subtypes)', d.include_group_rollups);
    const duplicates = select([['latest', 'Use the latest'], ['error', 'Stop with an error']], d.duplicate_policy);
    const exclude = textInput({ placeholder: 'for example ECG HEOG', value: d.channel_exclude.join(' ') });
    const timelines = numberInput({ value: d.timeline_max_recordings, min: 0, step: 1 });
    const syncCriterion = () => {
      const tol = criterion.value !== 'iou';
      onTol.disabled = !tol;
      offTol.disabled = !tol;
      thresholds.disabled = criterion.value === 'tolerance';
    };
    criterion.addEventListener('change', syncCriterion);
    syncCriterion();
    const msg = messageArea();
    const progress = progressLine();
    const result = this.results.agreement;
    const run = h('button.btn.primary', { type: 'button', 'data-log': 'agreement-run' }, 'Run the agreement analysis');
    const config = () => {
      const cfg = {
        ...d,
        resolutions_s: parseNumbers(resolutions.value, 'Time bins', '0.01 0.05 0.1'),
        min_bin_coverage: parseNumber(coverage.value, 'Bin coverage needed', { min: 0, max: 1 }),
        channel_modes: [time.input.checked ? 'time_only' : null, channel.input.checked ? 'time_and_channel' : null].filter(Boolean),
        include_any_artifact: anyArtifact.input.checked,
        include_group_rollups: rollups.input.checked,
        match_criterion: criterion.value,
        iou_thresholds: criterion.value === 'tolerance' ? d.iou_thresholds : parseNumbers(thresholds.value, 'Overlap thresholds', '0 0.2 0.5'),
        primary_iou_threshold: parseNumber(primary.value, 'Main threshold', { min: 0, max: 0.99 }),
        onset_tolerance_s: parseNumber(onTol.value, 'Onset tolerance', { min: 0 }),
        offset_tolerance_s: parseNumber(offTol.value, 'Offset tolerance', { min: 0 }),
        allow_many_to_one: many.input.checked,
        min_channel_jaccard: parseNumber(jaccard.value, 'Channel overlap needed', { min: 0, max: 1 }),
        min_events_per_category: parseNumber(minEvents.value, 'Fewest annotations for figures', { min: 0, integer: true }),
        timeline_max_recordings: parseNumber(timelines.value, 'Recordings drawn as timelines', { min: 0, integer: true }),
        duplicate_policy: duplicates.value,
        channel_exclude: parseList(exclude.value),
        reference_annotator: reference.value || null,
        categories: categories.values().length === categories.total ? null : categories.values(),
      };
      const problems = analysisProblems(cfg);
      if (problems.length) throw new Error(problems[0]);
      return cfg;
    };
    run.addEventListener('click', () => this._run('agreement', run, progress, msg, async () => {
      clear(result);
      const cfg = config();
      const chosenModes = modes.filter((m) => m.box.input.checked).map((m) => m.v);
      if (!chosenModes.length) throw new Error('Choose at least one kind of session to analyse.');
      const body = { modes: chosenModes, config: cfg };
      if (annotators.values().length) body.annotator_ids = annotators.values();
      if (recordings.values().length) body.recording_ids = recordings.values();
      const r = await this.area.backend.admin('agreement', body);
      const settingsJson = JSON.stringify({ ...body, config: cfg }, null, 2);
      result.append(card('Agreement report',
        (r.warnings || []).length ? h('div.banner', {}, h('p', {}, h('b', {}, 'Warnings')), h('ul', {}, r.warnings.map((w) => h('li', {}, w)))) : null,
        summaryTable(r.summary),
        downloads('agreement', r.report_html, r.tables, [h('button.btn.small', { type: 'button', onclick: () => downloadText('agreement_settings.json', settingsJson, 'application/json') }, 'The settings used (JSON)')]),
        r.report_html ? reportFrame(r.report_html, 'Agreement report') : h('p.caption', {}, 'The study sent no report.')));
    }));
    this.agreementHost.append(card('Agreement between annotators',
      h('p.caption', {}, 'Compares annotators by category, time and channel. The defaults are starting points: choose and report the settings for each study (the reliability guide explains each measure).'),
      h('div.admin-grid', {}, annotators, recordings),
      h('fieldset.admin-fieldset', {}, h('legend', {}, 'Sessions'), h('div.row.wrap', {}, modes.map((m) => m.box))),
      field('Reference annotator', reference, { hint: 'When chosen, everyone is compared with this person only, for example an expert.' }),
      h('details.admin-details', {}, h('summary', {}, 'Categories'), categories),
      h('details.admin-details', {}, h('summary', {}, 'Settings of the analysis'),
        h('fieldset.admin-fieldset', {}, h('legend', {}, 'Compare'), h('div.row.wrap', {}, time, channel)),
        h('div.form-grid', {},
          field('Time bins (s)', resolutions, { hint: 'Bin widths for the binned comparisons; the exact comparison is always made.' }),
          field('Bin coverage needed', coverage, { hint: 'Share of a bin an annotation must cover; 0 means any overlap.' }),
          field('Event matching', criterion),
          field('Overlap thresholds (IoU)', thresholds, { hint: 'Each is reported; 0 means any overlap.' }),
          field('Main threshold (IoU)', primary, { hint: 'For the boundary differences and the figures.' }),
          field('Onset tolerance (s)', onTol), field('Offset tolerance (s)', offTol),
          field('Channel overlap needed', jaccard, { hint: 'Time-and-channel matching; 0 means one shared channel.' }),
          field('Fewest annotations for figures', minEvents),
          field('Recordings drawn as timelines', timelines),
          field('Someone saved a recording twice', duplicates),
          field('Channels to leave out', exclude)),
        many, anyArtifact, rollups),
      h('div.btn-row', {}, run), progress, msg), result);
  }

  // -------------------------------------------------------------- activity
  _activityForm() {
    const annotators = checkList(this.users.map((u) => ({ value: u.annotator_id, text: u.annotator_id, extra: u.display_name || '' })),
      { legend: 'Annotators (none ticked: everyone)', name: 'activity-annotators' });
    const msg = messageArea();
    const progress = progressLine();
    const result = this.results.activity;
    const run = h('button.btn.primary', { type: 'button', 'data-log': 'activity-run' }, 'Run the activity analysis');
    run.addEventListener('click', () => this._run('activity', run, progress, msg, async () => {
      clear(result);
      const body = annotators.values().length ? { annotator_ids: annotators.values() } : {};
      const r = await this.area.backend.admin('activity', body);
      result.append(card('Activity and learning curves', downloads('activity', r.report_html, r.tables),
        r.report_html ? reportFrame(r.report_html, 'Activity report') : h('p.caption', {}, 'The study sent no report.')));
    }));
    this.activityHost.append(card('Activity and learning curves',
      h('p.caption', {}, 'From the interaction logs: time spent, clicks and keys, and how annotators got faster with practice.'),
      annotators, h('div.btn-row', {}, run), progress, msg), result);
  }

  // ------------------------------------------------------------ competency
  _competencyForm() {
    const set = select(this.sets.map((s) => [s.set_id, `${s.name || s.set_id} (${s.set_id})`]));
    const who = select(this.users.map((u) => [u.annotator_id, `${u.annotator_id}${u.display_name ? ` · ${u.display_name}` : ''}`]));
    const msg = messageArea();
    const progress = progressLine();
    const result = this.results.competency;
    const run = h('button.btn.primary', { type: 'button', 'data-log': 'competency-run' }, 'Write the competency report');
    run.disabled = !this.sets.length;
    run.addEventListener('click', () => this._run('competency', run, progress, msg, async () => {
      clear(result);
      if (!set.value || !who.value) throw new Error('Choose the reference set and the trainee.');
      const r = await this.area.backend.admin('competency', { set_id: set.value, annotator_id: who.value });
      const report = r.report || {};
      const base = `competency_${set.value}_${who.value}`;
      result.append(card(`Competency of ${who.value} (${set.value})`,
        report.status_text ? h('p', {}, h('b', {}, report.status_text)) : null,
        downloads(base, r.html, {}, [h('button.btn.small', { type: 'button', onclick: () => downloadText(`${base}.json`, JSON.stringify(report, null, 2), 'application/json') }, 'The report data (JSON)')]),
        r.html ? reportFrame(r.html, 'Competency report') : null));
    }));
    this.competencyHost.append(card('Competency reports',
      h('p.caption', {}, 'A trainee\'s results on a reference set\'s assessment recordings against its competency criteria, once every assessment recording is saved.'),
      this.sets.length ? h('div.row.wrap', {}, field('Reference set', set), field('Trainee', who)) : h('p.caption', {}, 'There are no reference sets yet.'),
      h('div.btn-row', {}, run), progress, msg), result);
  }
}

