// The admin area's checks and conversions (js/admin/model.js): its plain hashes, the competency
// criteria, the study settings and analysis settings, the review of manifests found on this
// computer, and the words shown for the study's errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as m from '../../electrotag/web/static/js/admin/model.js';

test('the sections have plain hashes', () => {
  assert.equal(m.isAdminRoute('admin'), true);
  assert.equal(m.isAdminRoute('admin-recordings'), true);
  assert.equal(m.isAdminRoute('admin-nothing'), false);
  assert.equal(m.isAdminRoute('home'), false);
  assert.equal(m.sectionForRoute('admin'), 'overview');
  assert.equal(m.routeForSection('settings'), 'admin-settings');
  for (const s of m.SECTIONS) assert.match(s.route, /^admin(-[a-z]+)?$/);
});

test('numbers and identifiers are checked in plain words', () => {
  assert.deepEqual(m.parseNumbers('0.01, 0.05 0.1', 'Time bins', '0.01 0.05 0.1'), [0.01, 0.05, 0.1]);
  assert.throws(() => m.parseNumbers('', 'Time bins', '0.01'), /give at least one number/);
  assert.throws(() => m.parseNumbers('0.1 x', 'Time bins', '0.01'), /'x' is not a number/);
  assert.equal(m.parseNumber(' 3 ', 'Seed', { integer: true }), 3);
  assert.equal(m.parseNumber('', 'Agree', { optional: true }), null);
  assert.throws(() => m.parseNumber('1.5', 'Seed', { integer: true }), /whole number/);
  assert.throws(() => m.parseNumber('120', 'Share', { min: 0, max: 100 }), /between 0 and 100/);
  assert.equal(m.checkAnnotatorId(' a03 '), 'A03');
  assert.throws(() => m.checkAnnotatorId('A 03'), /letters, digits/);
  assert.throws(() => m.checkAnnotatorId(''), /Enter an annotator ID/);
  assert.equal(m.checkSetId('pilot-1'), 'pilot-1');
  assert.throws(() => m.checkSetId('../x'), /set identifier/);
  assert.equal(m.checkEmail(''), null);
  assert.throws(() => m.checkEmail('', { required: true }), /email address/);
  assert.throws(() => m.checkEmail('not an address'), /does not look like/);
  assert.deepEqual(m.parseList('ECG, HEOG\nVEOG;'), ['ECG', 'HEOG', 'VEOG']);
});

test('competency criteria go to and from the editor as CompetencyCriteria.to_dict()', () => {
  const saved = { criteria: [{ metric: 'event_f1', threshold: 0.8, scope: 'each_category' }, { metric: 'false_positives_per_min', threshold: 2, scope: 'overall' }],
    min_reference_events: 4, categories: null };
  const rows = m.criteriaRows(saved);
  assert.equal(rows.length, Object.keys(m.METRICS).length);
  assert.deepEqual(rows.find((r) => r.metric === 'event_f1'), { metric: 'event_f1', enabled: true, threshold: 0.8, scope: 'each_category' });
  assert.equal(rows.find((r) => r.metric === 'mean_iou').enabled, false);
  assert.deepEqual(m.criteriaFromRows(rows, 4), saved);
  // Measures that exist only overall stay overall; thresholds stay within the measure's range.
  const accuracy = rows.map((r) => (r.metric === 'label_accuracy' ? { ...r, enabled: true, threshold: 0.9, scope: 'each_category' } : r));
  assert.equal(m.criteriaFromRows(accuracy, 3).criteria.find((c) => c.metric === 'label_accuracy').scope, 'overall');
  assert.throws(() => m.criteriaFromRows(rows.map((r) => (r.metric === 'event_f1' ? { ...r, threshold: 1.5 } : r)), 3), /between 0 and 1/);
  assert.throws(() => m.criteriaFromRows(rows, 0), /at least one event/);
  assert.equal(m.describeCriterion({ metric: 'false_positives_per_min', threshold: 2, scope: 'overall' }),
    'Extra events (matching no reference artifact) per minute ≤ 2 (overall)');
});

test('study settings are checked as electrotag.config.settings checks them', () => {
  const ok = { filters: { highpass_enabled: true, highpass_hz: 1, notch_enabled: true, notch_hz: 50 },
    display: { duration_s: 10, n_channels: 32, scalings: { eeg: 5e-5 } }, channels: { hide: ['COUNTER'], types: { 'EXG*': 'eog' } },
    selection: { strategy: 'seeded', seed: 7 }, logging: { pointer_hz: 5, idle_after_s: 30 },
    annotation: { min_duration_samples: 1, quick_labels: ['Eye-blink-artifact', 'EMG-artifact'] } };
  assert.deepEqual(m.settingsProblems(ok, ['Eye-blink-artifact', 'EMG-artifact']), []);
  const bad = (change) => m.settingsProblems(m.mergeSettings(ok, change), ['Eye-blink-artifact', 'EMG-artifact']);
  assert.match(bad({ filters: { notch_hz: 55 } })[0], /50 or 60 Hz/);
  assert.match(bad({ selection: { seed: null } })[0], /needs a seed/);
  assert.match(bad({ annotation: { quick_labels: ['EMG-artifact', 'EMG-artifact'] } })[0], /two number keys/);
  assert.match(bad({ annotation: { quick_labels: ['Not-a-type'] } })[0], /not one of the artifact types/);
  assert.match(bad({ channels: { types: { X: 'brain' } } })[0], /choose one of eeg/);
  assert.match(bad({ logging: { idle_after_s: 2 } })[0], /between 5 and 3600/);
  assert.match(bad({ annotation: { min_duration_samples: 0 } })[0], /at least one sample/);
  // Merging changes one key at a time and leaves the rest of the block.
  const merged = m.mergeSettings(ok, { filters: { locked: true } });
  assert.equal(merged.filters.locked, true);
  assert.equal(merged.filters.highpass_hz, 1);
  assert.equal(ok.filters.locked, undefined);
  assert.equal(m.toMicrovolts(5e-5), 50);
  assert.equal(m.fromMicrovolts(150), 0.00015);
});

test('the agreement settings start from AnalysisConfig and are checked like it', () => {
  const d = m.defaultAnalysisConfig();
  assert.deepEqual(m.analysisProblems(d), []);
  assert.deepEqual(d.resolutions_s, [0.01, 0.05, 0.1]);
  assert.equal(d.primary_iou_threshold, 0.2);
  assert.match(m.analysisProblems({ ...d, resolutions_s: [0.1, 0.1] })[0], /only once/);
  assert.match(m.analysisProblems({ ...d, iou_thresholds: [1] })[0], /not including/);
  assert.match(m.analysisProblems({ ...d, channel_modes: [] })[0], /time and channel/);
  assert.match(m.analysisProblems({ ...d, onset_tolerance_s: -1 })[0], /negative/);
  assert.match(m.analysisProblems({ ...d, categories: [] })[0], /at least one artifact category/);
});

const manifest = (rid, extra = {}) => ({
  schema: 'electrotag.web_manifest', schema_version: '1.0.0', scope: 'study', recording_id: rid, file_name: rid.split('/').pop(),
  format: 'brainvision', format_name: 'BrainVision', timing: { sfreq: 250, n_samples: 15000 }, ch_names: ['Fp1', 'Fp2', 'Cz'],
  hidden_channels: ['Status'], fingerprint: { eeg: { sha256: 'a'.repeat(64), size: 1234 } }, warnings: ['Odd amplitude'],
  amplitude: { warnings: ['Odd amplitude', 'EOG very large'] }, notes: [], ...extra,
});

test('the review of recordings found on this computer, and sending them in groups', () => {
  const s = m.manifestSummary(manifest('sub-01/eeg/sub-01_task-rest_eeg.vhdr'));
  assert.equal(s.recordingId, 'sub-01/eeg/sub-01_task-rest_eeg.vhdr');
  assert.equal(s.fileName, 'sub-01_task-rest_eeg.vhdr');
  assert.equal(s.format, 'BrainVision');
  assert.equal(s.nChannels, 3);
  assert.equal(s.nHidden, 1);
  assert.equal(s.durationS, 60);
  assert.deepEqual(s.warnings, ['Odd amplitude', 'EOG very large']);
  assert.equal(s.sizeBytes, 1234);
  const many = Array.from({ length: 95 }, (_, i) => manifest(`sub-${i}/eeg/x.edf`));
  const groups = m.chunkManifests(many, { maxCount: 40 });
  assert.deepEqual(groups.map((g) => g.length), [40, 40, 15]);
  const big = m.chunkManifests(many.slice(0, 4), { maxBytes: JSON.stringify(many[0]).length * 2 + 10 });
  assert.deepEqual(big.map((g) => g.length), [2, 2]);
  assert.deepEqual(m.mergeRegisterResults([{ added: ['a'], replaced: [], skipped: [] }, { added: ['b'], replaced: ['c'], skipped: [{ recording_id: 'd', reason: 'x' }] }]),
    { added: ['a', 'b'], replaced: ['c'], skipped: [{ recording_id: 'd', reason: 'x' }] });
  // Whatever the builder reports as progress becomes words and a fraction.
  assert.deepEqual(m.progressText(0.5), { text: 'Reading the recordings…', fraction: 0.5 });
  assert.deepEqual(m.progressText({ done: 2, total: 4, recordingId: 'sub-03/eeg/x.edf' }), { text: 'Reading 3 of 4: sub-03/eeg/x.edf', fraction: 0.5 });
  assert.equal(m.progressText({ stage: 'fingerprint', fraction: 0.25, path: 'x.eeg' }).text, 'Checking: x.eeg');
  assert.equal(m.progressText({ message: 'Reading channels.tsv' }).text, 'Reading channels.tsv');
  assert.deepEqual(m.fileParts('sub-01/eeg/x.edf'), { name: 'x.edf', folder: 'sub-01/eeg' });
});

test('errors: the study\'s message, or a plain explanation when it lacks the operation', () => {
  const err = (status, code, message) => Object.assign(new Error(message), { status, code });
  assert.equal(m.problemText(err(409, 'self', 'You cannot remove your own account.')), 'You cannot remove your own account.');
  for (const e of [err(404, 'not_found', 'There is no /api/v1/admin/overview'), err(404, 'not_found', 'Unknown operation overview'),
    err(404, 'not-found', 'NOT_FOUND'), err(404, '', 'The study server answered with an error (HTTP 404).')]) {
    assert.equal(m.isNotOffered(e), true, e.message);
    assert.match(m.problemText(e), /does not offer this part of the admin area/);
  }
  assert.equal(m.isNotOffered(err(404, 'not_found', 'There is no account A09 in this study.')), false);
  assert.equal(m.isNotOffered(err(501, 'needs_server', 'The demonstration cannot …')), false);
});

test('files: base64, TSV tables and annotation documents', () => {
  assert.deepEqual([...m.base64ToBytes('AAEC/w==')], [0, 1, 2, 255]);
  assert.equal(m.tsvText(['kind', 'onset_s', 'note'], [{ kind: 'time', onset_s: 1.23456, note: 'a\tb' }, { kind: 'channels', onset_s: 2, note: null }]),
    'kind\tonset_s\tnote\ntime\t1.2346\ta b\nchannels\t2\tn/a\n');
  const doc = m.readAnnotationDocument(JSON.stringify({ schema: 'electrotag.annotations', annotations: [] }));
  assert.deepEqual(doc.annotations, []);
  assert.throws(() => m.readAnnotationDocument('{'), /cannot be read as JSON/);
  assert.throws(() => m.readAnnotationDocument('{"a": 1}'), /no list of annotations/);
  assert.throws(() => m.readAnnotationDocument('{"schema": "x", "annotations": []}'), /x document/);
});

test('words for people', () => {
  assert.equal(m.durationText(45), '45 s');
  assert.equal(m.durationText(250), '4 min 10 s');
  assert.equal(m.durationText(3900), '1 h 05 min');
  assert.equal(m.bytesText(1536), '2 kB');
  assert.equal(m.bytesText(5 * 1024 * 1024), '5.0 MB');
  assert.equal(m.whenText(null), 'never');
  assert.match(m.whenText(new Date().toISOString()), /^today at \d\d:\d\d$/);
  assert.equal(m.scopeText('study'), 'The study');
  assert.equal(m.scopeText('set:pilot', [{ set_id: 'pilot', name: 'Pilot set' }]), 'Reference set: Pilot set');
  assert.equal(m.describeProvenance({ method: 'consensus', experts: ['E1', 'E2', 'E3'], min_agreement: 2 }), 'consensus of several experts: E1, E2, E3 (2 needed to agree)');
  assert.equal(m.programmeText({ stages: [{ key: 'guided', status: 'completed', done: 2, total: 2 }, { key: 'practice', status: 'locked', done: 0, total: 1 },
    { key: 'assessment', status: 'not_used', done: 0, total: 0 }] }), 'Guided 2 of 2 (completed) · Practice 0 of 1 (locked)');
  assert.deepEqual(m.progressCounts([{ status: 'done' }, { status: 'todo' }, { status: 'in_progress' }, { status: 'done' }]),
    { assigned: 4, done: 2, in_progress: 1, todo: 1 });
  assert.deepEqual(m.filterAudit([{ by: 'ADMIN', op: 'assign' }, { by: 'command', op: 'register' }], { by: 'admin' }), [{ by: 'ADMIN', op: 'assign' }]);
});
