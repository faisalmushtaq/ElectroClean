// Analyses, computed by the study with ElectroTag's own code: the agreement between annotators
// (the settings of electrotag.reliability.config.AnalysisConfig), the activity analysis and
// learning curves from the interaction logs, and competency reports. Each report is shown in a
// sandboxed frame and offered for download with its tables. An analysis cannot be started again
// while it runs.

import { h, clear } from '../ui/dom.js';
import {
  MATCH_CRITERIA, agreementSettingsFile, agreementSummaryRows, analysisProblems, defaultAnalysisConfig, fileParts, parseList, parseNumber, parseNumbers, setLabel,
} from './model.js';
import {
  card, checkbox, checkList, dataTable, docsLink, downloadText, elapsedTimer, field, infoTable, messageArea, numberInput, progressLine, reportFrame, sectionHead, select,
  textInput,
} from './ui.js';
import { UNIT_CHOICES, VERSION_CHOICES, VERSION_WORDS, compareKeyResults, comparisonTsv, numberText, versionHint, versionSummaryRows } from './versions_model.js';

/** A link to a part of the reliability guide (docs/reliability_guide.md), for the settings of the analysis. */
const guide = (anchor, text = 'In the reliability guide') => docsLink(text, 'reliability_guide.md', anchor);
/** A field's hint with a link to the part of the reliability guide that explains it. */
const hintWith = (text, anchor) => [text, ' ', guide(anchor)];

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

/** The analysis in a few plain figures; the key results are in the report below. */
function summaryTable(summary) {
  const rows = [...versionSummaryRows(summary), ...agreementSummaryRows(summary)];
  return rows.length ? infoTable(rows) : null;
}

/** "Compared with the original versions": the key results of both analyses side by side. */
function comparisonCard(original, answer, versions) {
  if (original.failed) {
    return card('Compared with the original versions', h('p.caption', {}, `The originals could not be analysed for the comparison: ${original.failed.message || original.failed}`));
  }
  const rows = compareKeyResults(original.summary, answer.summary);
  const table = dataTable([
    { title: 'Annotator pair', key: 'pair', cls: 'nowrap' },
    { title: 'Measure', key: 'measure' },
    { title: 'Originals', num: true, render: (r) => numberText(r.original) },
    { title: versions === 'adjudicated' ? 'Against the adjudicated' : 'Corrected', num: true, render: (r) => numberText(r.version) },
    { title: 'Difference', num: true, render: (r) => numberText(r.difference, { signed: true }) },
  ], rows, { empty: 'Neither analysis has key results to compare.', pageSize: 60, caption: 'Key results compared' });
  return card('Compared with the original versions',
    h('p.caption', {}, versions === 'adjudicated'
      ? 'The originals compare the annotators with each other; this analysis compares each with the adjudicated versions, so their pairs differ and the mean over pairs is the row to compare. The difference is this analysis minus the originals.'
      : `The same analysis of the originals and of the versions ${String(VERSION_WORDS[versions] || versions).toLowerCase()}: the difference is the corrected versions minus the originals.`),
    table,
    h('div.btn-row.downloads', {}, h('button.btn.small', { type: 'button', 'data-log': 'agreement-compare-download',
      onclick: () => downloadText(`agreement_${versions}_compared.tsv`, comparisonTsv(rows, versions), 'text/tab-separated-values;charset=utf-8') }, 'The comparison (TSV)')));
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
    reference.setAttribute('data-field', 'reference');
    const versions = select(VERSION_CHOICES, 'original');
    versions.setAttribute('data-field', 'versions');
    const unit = select(UNIT_CHOICES, 'recording');
    unit.setAttribute('data-field', 'unit');
    const compare = checkbox('Compare with the original versions', true, { hint: 'Runs the analysis of the originals too and shows the key results side by side.' });
    const vHint = h('span', {}, versionHint('original'));
    const syncVersions = () => {
      const v = versions.value;
      vHint.textContent = versionHint(v);
      compare.hidden = v === 'original';
      // The adjudicated versions are the reference: everyone is compared with them.
      reference.disabled = v === 'adjudicated';
      if (v === 'adjudicated') reference.value = '';
      refField.hidden = v === 'adjudicated';
    };
    versions.addEventListener('change', syncVersions);
    const refField = field('Reference annotator', reference, { hint: 'When chosen, everyone is compared with this person only, for example an expert.' });
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
    syncVersions();
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
      if (versions.value !== 'original') body.versions = versions.value;
      if (unit.value !== 'recording') body.unit = unit.value;
      // With the comparison, the originals first (the same choices otherwise), then the version chosen.
      const original = body.versions && compare.input.checked
        ? await this.area.backend.admin('agreement', { ...body, versions: 'original' }).catch((exc) => ({ failed: exc })) : null;
      const r = await this.area.backend.admin('agreement', body);
      // The settings in the form electrotag-agreement --config reads, with the recordings left out.
      const file = agreementSettingsFile(r, body);
      const settingsJson = JSON.stringify(file, null, 2);
      result.append(card('Agreement report',
        (r.warnings || []).length ? h('div.banner', {}, h('p', {}, h('b', {}, 'Warnings')), h('ul', {}, r.warnings.map((w) => h('li', {}, w)))) : null,
        summaryTable(r.summary),
        downloads('agreement', r.report_html, r.tables, [h('button.btn.small', { type: 'button', 'data-log': 'agreement-settings', onclick: () => downloadText('agreement_settings.json', settingsJson, 'application/json') }, 'The settings used (JSON)')]),
        h('p.caption', {}, 'To repeat this analysis on the results zip (Results), save The settings used (JSON) beside its Annotated_Events folder and run:'),
        h('pre.command.agreement-command', {}, file.command),
        r.report_html ? reportFrame(r.report_html, 'Agreement report') : h('p.caption', {}, 'The study sent no report.')));
      if (original) result.prepend(comparisonCard(original, r, body.versions));
    }));
    this.agreementHost.append(card('Agreement between annotators',
      h('p.caption', {}, 'Compares annotators by category, time and channel. The defaults are starting points: choose and report the settings for each study. ',
        guide('choosing-settings', 'The reliability guide'), ' explains each measure and how to choose the settings.'),
      h('div.admin-grid', {}, annotators, recordings),
      h('fieldset.admin-fieldset', {}, h('legend', {}, 'Sessions'), h('div.row.wrap', {}, modes.map((m) => m.box))),
      h('div.form-grid', {},
        field('Versions', versions, { hint: [vHint, ' ', guide('versions-of-the-annotations')] }),
        field('Compare', unit, { hint: hintWith("A task's part of a recording (its window) can be compared on its own, so that the rest of the recording does not count.", 'versions-of-the-annotations') })),
      compare,
      refField,
      h('details.admin-details', {}, h('summary', {}, 'Categories'), categories),
      h('details.admin-details', {}, h('summary', {}, 'Settings of the analysis'),
        h('fieldset.admin-fieldset', {}, h('legend', {}, 'Compare'), h('div.row.wrap', {}, time, channel)),
        h('div.form-grid', {},
          field('Time bins (s)', resolutions, { hint: hintWith('Bin widths for the binned comparisons; the exact comparison is always made.', '1-time-resolved-agreement') }),
          field('Bin coverage needed', coverage, { hint: hintWith('Share of a bin an annotation must cover; 0 means any overlap.', '1-time-resolved-agreement') }),
          field('Event matching', criterion, { hint: hintWith('By overlap, by the closeness of start and end, or both.', '2-event-based-agreement') }),
          field('Overlap thresholds (IoU)', thresholds, { hint: hintWith('Intersection over union; each is reported, and 0 means any overlap.', '2-event-based-agreement') }),
          field('Main threshold (IoU)', primary, { hint: hintWith('For the boundary differences and the figures.', '2-event-based-agreement') }),
          field('Onset tolerance (s)', onTol), field('Offset tolerance (s)', offTol),
          field('Channel overlap needed', jaccard, { hint: hintWith('Time-and-channel matching; 0 means one shared channel.', '3-channels') }),
          field('Fewest annotations for figures', minEvents),
          field('Recordings drawn as timelines', timelines),
          field('Someone saved a recording twice', duplicates),
          field('Channels to leave out', exclude)),
        many, h('p.caption', {}, 'Without many-to-one, each event is matched with at most one of the other annotator\'s. ', guide('2-event-based-agreement')),
        anyArtifact, rollups, h('p.caption', {}, 'ANY-artifact and the group roll-ups: ', guide('1-time-resolved-agreement'))),
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
    const set = select(this.sets.map((s) => [s.set_id, setLabel(s)]));
    // The trainees of the set chosen (those whose training programme it is) first, then everyone else.
    const who = select([]);
    const fillWho = () => {
      const keep = who.value;
      const people = this.users.filter((u) => u.role !== 'admin');
      const theirs = people.filter((u) => u.programme === set.value);
      const others = people.filter((u) => u.programme !== set.value);
      const option = (u) => h('option', { value: u.annotator_id }, `${u.annotator_id}${u.display_name ? ` · ${u.display_name}` : ''}`);
      clear(who);
      if (theirs.length) who.append(h('optgroup', { label: 'Trainees of this set' }, theirs.map(option)));
      if (others.length) who.append(h('optgroup', { label: theirs.length ? 'Other people' : 'People' }, others.map(option)));
      if ([...who.options].some((o) => o.value === keep)) who.value = keep;
    };
    set.addEventListener('change', fillWho);
    fillWho();
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

