// Reports in the admin area receive the application's typeface with the page (withReportFont in
// js/admin/ui.js), since a sandboxed frame cannot load the font file itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withReportFont } from '../../electrotag/web/static/js/admin/ui.js';

const CSS = '<style>@font-face{font-family:"Newsreader"}</style>';

test('the typeface goes at the start of the report\'s head', () => {
  assert.equal(withReportFont('<!doctype html><html><head lang="en"><title>R</title></head><body>x</body></html>', CSS),
    `<!doctype html><html><head lang="en">${CSS}<title>R</title></head><body>x</body></html>`);
});

test('a report without a head gets it first, and no font leaves the report as it is', () => {
  assert.equal(withReportFont('<h1>R</h1>', CSS), `${CSS}<h1>R</h1>`);
  assert.equal(withReportFont('<head></head><h1>R</h1>', ''), '<head></head><h1>R</h1>');
  assert.equal(withReportFont(null, CSS), CSS);
});

// "Compare with the original versions" (js/admin/versions_model.js): the key results of two agreement
// analyses side by side, from each answer's summary.key_results.
import { compareKeyResults, comparisonTsv, numberText, versionHint, versionSummaryRows } from '../../electrotag/web/static/js/admin/versions_model.js';

const ORIGINAL = { key_results: [
  { pair: 'A01 – A02', any_artifact_positive_agreement: 0.5, any_artifact_kappa: 0.4, event_f1: 0.4 },
  { pair: 'A01 – A03', any_artifact_positive_agreement: 0.7, any_artifact_kappa: 0.6, event_f1: null },
  { pair: 'Mean over pairs', any_artifact_positive_agreement: 0.6, any_artifact_kappa: 0.5, event_f1: 0.4 },
] };

test('the comparison has one row per pair and measure, the version minus the originals', () => {
  const corrected = { key_results: [
    { pair: 'A01 – A02', any_artifact_positive_agreement: 0.75, any_artifact_kappa: 0.4, event_f1: 1 },
    { pair: 'Mean over pairs', any_artifact_positive_agreement: 0.75, any_artifact_kappa: 0.4, event_f1: 1 },
  ] };
  const rows = compareKeyResults(ORIGINAL, corrected);
  assert.deepEqual(rows.map((r) => [r.pair, r.key]), [
    ['A01 – A02', 'any_artifact_positive_agreement'], ['A01 – A02', 'any_artifact_kappa'], ['A01 – A02', 'event_f1'],
    ['A01 – A03', 'any_artifact_positive_agreement'], ['A01 – A03', 'any_artifact_kappa'],
    ['Mean over pairs', 'any_artifact_positive_agreement'], ['Mean over pairs', 'any_artifact_kappa'], ['Mean over pairs', 'event_f1'],
  ]);
  const f1 = rows.find((r) => r.pair === 'A01 – A02' && r.key === 'event_f1');
  assert.equal(f1.measure, 'Event F1, all categories');
  assert.ok(Math.abs(f1.difference - 0.6) < 1e-12);
  // a pair only in the originals has no value in the version and no difference
  const gone = rows.find((r) => r.pair === 'A01 – A03' && r.key === 'any_artifact_kappa');
  assert.deepEqual([gone.original, gone.version, gone.difference], [0.6, null, null]);
  assert.equal(rows.at(-1).pair, 'Mean over pairs');
  assert.equal(comparisonTsv(rows, 'corrected').split('\n')[0], 'pair\tmeasure\toriginal\tcorrected\tdifference');
  assert.equal(comparisonTsv(rows, 'corrected').split('\n')[3], 'A01 – A02\tevent_f1\t0.4\t1\t0.6');
  assert.equal(comparisonTsv(rows, 'corrected').split('\n')[5], 'A01 – A03\tany_artifact_kappa\t0.6\tn/a\tn/a');
});

test('against the adjudicated versions the pairs differ and the mean over pairs is compared', () => {
  const adjudicated = { key_results: [
    { pair: 'ADJUDICATED – A01', any_artifact_positive_agreement: 0.9, any_artifact_kappa: 0.8, event_f1: 0.8 },
    { pair: 'ADJUDICATED – A02', any_artifact_positive_agreement: 0.8, any_artifact_kappa: 0.7, event_f1: 0.6 },
    { pair: 'Mean over pairs', any_artifact_positive_agreement: 0.85, any_artifact_kappa: 0.75, event_f1: 0.7 },
  ] };
  const rows = compareKeyResults(ORIGINAL, adjudicated);
  assert.deepEqual([...new Set(rows.map((r) => r.pair))], ['ADJUDICATED – A01', 'ADJUDICATED – A02', 'A01 – A02', 'A01 – A03', 'Mean over pairs']);
  const mean = rows.filter((r) => r.pair === 'Mean over pairs');
  assert.deepEqual(mean.map((r) => numberText(r.difference, { signed: true })), ['+0.250', '+0.250', '+0.300']);
  assert.equal(compareKeyResults({}, {}).length, 0);
  assert.equal(numberText(null), '–');
  assert.equal(numberText(-0.12345, { signed: true }), '-0.123');
  assert.equal(numberText(0.0001, { signed: true }), '0.000');
});

test('the versions analysed are listed in plain words', () => {
  assert.deepEqual(versionSummaryRows({ versions: { used: 'original' }, unit: 'recording' }), []);
  assert.deepEqual(versionSummaryRows({ versions: { used: 'corrected', replaced: 3, by: { E02: 1, E01: 2 }, pending: ['sub-01/eeg/a.vhdr'] } }), [
    ['Versions compared', 'As the experts corrected them'], ['Saved versions replaced by a correction', '3 (E01 2, E02 1)'],
    ['Correction pending adjudication (left out)', 'a.vhdr']]);
  assert.deepEqual(versionSummaryRows({ versions: { used: 'adjudicated', replaced: 1, by: {} }, unit: 'task' }), [
    ['Versions compared', 'Each annotator against the adjudicated versions'], ['Adjudications used', '1'],
    ['Compared', "Each task's part of a recording on its own"]]);
  assert.match(versionHint('adjudicated'), /ADJUDICATED/);
  assert.match(versionHint('corrected'), /left out/);
});
