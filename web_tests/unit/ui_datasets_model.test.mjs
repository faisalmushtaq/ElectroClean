// The Datasets section's words and arithmetic (js/admin/datasets_model.js): a dataset's summary and its
// ratings against the target, the checks of its details and prefix, IDs that belong to another dataset,
// collections built from filters with a sample that a fixed seed repeats, the words of the tracking grids,
// their filters and the rows of the tracking download.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as d from '../../electrotag/web/static/js/admin/datasets_model.js';
import { csvText } from '../../electrotag/web/static/js/admin/model.js';

const DATASET = {
  dataset_id: 'youth-ld-2026', name: 'Youth low-density 2026', ratings_target: 2, n_rated: 3, fully_rated: false,
  summary: { n_recordings: 12, n_retired: 2, formats: { edf: 10, brainvision: 2 }, sfreq: [256, 500], n_channels: { min: 19, max: 32 },
    duration_s: 5400, size_bytes: 3 * 1024 * 1024, first_registered_at: '2026-10-01T10:00:00+01:00', last_registered_at: '2026-10-29T10:00:00+00:00' },
  ratings: { 0: 5, 1: 2, 2: 3, '3+': 0 },
};

test('a dataset\'s summary and its ratings against the target', () => {
  assert.equal(d.inUse(DATASET), 10);
  assert.equal(d.ratingsText(DATASET), '3 of 10 rated by 2 people');
  assert.equal(d.ratingsText({ ...DATASET, n_rated: 10, fully_rated: true }), 'Fully rated: all 10 by 2 people each');
  assert.equal(d.ratingsText({ ...DATASET, ratings_target: 1, n_rated: 10, fully_rated: true }), 'Fully rated: all 10 by 1 person');
  assert.equal(d.ratingsText({ summary: { n_recordings: 0 } }), 'No recordings in use yet');
  assert.equal(d.ratedShare(DATASET), 0.3);
  assert.equal(d.ratedShare({ summary: { n_recordings: 0 } }), null);
  assert.equal(d.ratingsHistogramText(DATASET.ratings), '5 with none, 2 with 1, 3 with 2');
  assert.equal(d.ratingsHistogramText({ 0: 0, '3+': 4 }), '4 with 3 or more');
  assert.equal(d.formatsText(DATASET.summary.formats), 'EDF (10), BrainVision (2)');
  assert.equal(d.channelsText({ min: 19, max: 32 }), '19 to 32');
  assert.equal(d.channelsText({ min: 64, max: 64 }), '64');
  assert.equal(d.channelsText(null), '–');
  assert.equal(d.hoursText(5400), '1.5 h');
  assert.equal(d.hoursText(90), '1 min 30 s');
  const rows = Object.fromEntries(d.summaryRows(DATASET));
  assert.equal(rows.Recordings, '12 (2 retired)');
  assert.equal(rows['Sampling rates'], '256 Hz, 500 Hz');
  assert.equal(rows['Total size'], '3.0 MB');
  assert.match(rows.Ratings, /^3 of 10 rated by 2 people\. 5 with none/);
  assert.deepEqual(d.recordingRatings({ n_rated: 1 }, 2), { text: '1 of 2', met: false });
  assert.deepEqual(d.recordingRatings({ n_rated: 3, ratings_target: 3 }), { text: '3 of 3', met: true });
});

test('a dataset\'s details are checked in plain words, and only what is given is sent', () => {
  assert.throws(() => d.datasetBody({ name: '  ' }, { creating: true }), /Give the dataset a name/);
  assert.throws(() => d.datasetBody({ name: 'x', licence: 'L'.repeat(201) }, { creating: true }), /Licence: at most 200 characters/);
  assert.throws(() => d.datasetBody({ name: 'x', ratings_target: '0' }, { creating: true }), /from 1 to 20/);
  assert.throws(() => d.datasetBody({ name: 'x', ratings_target: '2.5' }, { creating: true }), /whole number/);
  assert.throws(() => d.datasetBody({ name: 'x', dataset_id: 'with.dot' }, { creating: true }), /letters, digits, hyphens and underscores/);
  assert.throws(() => d.datasetBody({ name: 'x', path_prefix: '../up' }, { creating: true }), /plain folder name/);
  assert.deepEqual(d.datasetBody({ name: ' OpenNeuro ds003420 ', licence: 'CC0', description: '', path_prefix: '/ds003420/', ratings_target: '3', dataset_id: 'ds003420' }, { creating: true }),
    { name: 'OpenNeuro ds003420', licence: 'CC0', path_prefix: 'ds003420', ratings_target: 3, dataset_id: 'ds003420' });
  // An update sends every field the form holds, the emptied ones too, so that a detail can be cleared.
  assert.deepEqual(d.datasetBody({ name: 'A', licence: '', notes: 'n' }), { name: 'A', licence: '', notes: 'n' });
  assert.equal(d.prefixProblem(''), '');
  assert.equal(d.prefixProblem('ds/003420'), '');
  assert.match(d.prefixProblem('a/./b'), /without \. or \.\./);
  assert.match(d.prefixProblem('a:b'), /plain folder name/);
  assert.equal(d.ratingsTarget('20'), 20);
});

test('recordings found here whose IDs belong to another dataset are pointed out, with the prefix applied', () => {
  const registered = [
    { scope: 'study', recording_id: 'sub-001/eeg/a.edf', dataset_id: null },
    { scope: 'study', recording_id: 'ds1/sub-001/eeg/a.edf', dataset_id: 'ds1' },
    { scope: 'set:example', recording_id: 'sub-002/eeg/b.edf', dataset_id: null },
  ];
  const found = [{ recording_id: 'sub-001/eeg/a.edf' }, { recording_id: 'sub-002/eeg/b.edf' }];
  assert.deepEqual([...d.collisionsOf(found, registered, 'youth')], [['sub-001/eeg/a.edf', 'study-recordings']]);
  assert.deepEqual([...d.collisionsOf(found, registered, 'study-recordings')], [], 'the same dataset is no collision');
  assert.deepEqual([...d.collisionsOf(found, registered, 'ds1', 'ds1')], [], 'with its prefix, the ID is its own');
  assert.deepEqual([...d.collisionsOf(found, registered, 'ds2', 'ds1')], [['sub-001/eeg/a.edf', 'ds1']]);
  assert.equal(d.prefixed('sub-1/a.edf', 'ds9/'), 'ds9/sub-1/a.edf');
  assert.equal(d.prefixed('sub-1/a.edf', ''), 'sub-1/a.edf');
});

const ROWS = [
  { recording_id: 'sub-03/c.edf', file_name: 'c.edf', dataset_id: 'a', format: 'edf', duration_s: 600, n_rated: 0, retired: false },
  { recording_id: 'sub-01/a.edf', file_name: 'a.edf', dataset_id: 'a', format: 'edf', duration_s: 120, n_rated: 2, retired: false },
  { recording_id: 'sub-02/b.vhdr', file_name: 'b.vhdr', dataset_id: 'b', format: 'brainvision', duration_s: 300, n_rated: 1, retired: false },
  { recording_id: 'sub-04/d.edf', file_name: 'd.edf', dataset_id: null, format: 'edf', duration_s: 900, n_rated: 0, retired: false },
  { recording_id: 'sub-05/e.edf', file_name: 'e.edf', dataset_id: 'a', format: 'edf', duration_s: 900, n_rated: 0, retired: true },
];

test('a collection from filters: datasets, name, format, length and ratings; retired recordings left out; in the order of the IDs', () => {
  const ids = (f) => d.filterForCollection(ROWS, f).map((r) => r.recording_id);
  assert.deepEqual(ids({}), ['sub-01/a.edf', 'sub-02/b.vhdr', 'sub-03/c.edf', 'sub-04/d.edf']);
  assert.deepEqual(ids({ datasetIds: ['a'] }), ['sub-01/a.edf', 'sub-03/c.edf']);
  assert.deepEqual(ids({ datasetIds: ['study-recordings'] }), ['sub-04/d.edf'], 'no dataset is the built-in one');
  assert.deepEqual(ids({ query: 'B.VH' }), ['sub-02/b.vhdr']);
  assert.deepEqual(ids({ format: 'edf', minS: 200 }), ['sub-03/c.edf', 'sub-04/d.edf']);
  assert.deepEqual(ids({ maxS: '300' }), ['sub-01/a.edf', 'sub-02/b.vhdr']);
  assert.deepEqual(ids({ nRatedMax: '0' }), ['sub-03/c.edf', 'sub-04/d.edf']);
  assert.deepEqual(ids({ nRatedMax: '' }).length, 4, 'an empty field filters nothing');
});

test('a random sample of a collection is the same for the same seed, and differs for another', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ recording_id: `sub-${String(i).padStart(3, '0')}/x.edf`, dataset_id: 'a', duration_s: 60, n_rated: 0 }));
  const a = d.filterForCollection(many, { sampleN: 20, seed: 42 }).map((r) => r.recording_id);
  const b = d.filterForCollection([...many].reverse(), { sampleN: '20', seed: '42' }).map((r) => r.recording_id);
  const c = d.filterForCollection(many, { sampleN: 20, seed: 43 }).map((r) => r.recording_id);
  assert.equal(a.length, 20);
  assert.deepEqual(a, b, 'the same filters and seed draw the same recordings, whatever order they came in');
  assert.notDeepEqual(a, c);
  assert.deepEqual(a, [...a].sort(), 'kept in the order of the IDs');
  assert.equal(d.filterForCollection(many, { sampleN: 500, seed: 1 }).length, 200, 'a sample larger than the matches is all of them');
  const r1 = d.seededRandom(7);
  const r2 = d.seededRandom(7);
  for (let i = 0; i < 5; i++) assert.equal(r1(), r2());
  assert.deepEqual(d.builtFrom({ datasetIds: ['a'], query: ' x ', format: '', minS: 60, maxS: '', nRatedMax: '0', sampleN: '20', seed: '42' }),
    { dataset_ids: ['a'], query: 'x', format: '', min_duration_s: 60, max_duration_s: null, n_rated_max: 0, sample: { n: 20, seed: 42 } });
  assert.equal(d.builtFromText(null), 'Chosen by hand.');
  assert.equal(d.builtFromText({ dataset_ids: ['a'], query: 'rest', format: 'edf', min_duration_s: 60, max_duration_s: null, n_rated_max: 0, sample: { n: 20, seed: 42 } }),
    'Built from filters: from a; names with "rest"; EDF; at least 1 min; rated by at most 0 people; a random 20 of them (seed 42).');
  assert.match(d.builtFromText({ dataset_ids: ['a'] }, (id) => `Dataset ${id.toUpperCase()}`), /^Built from filters: from Dataset A\.$/);
  assert.deepEqual(d.moved(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(d.moved(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c']);
});

test('the words of the tracking grids: counts by people, each cell\'s status and its dates', () => {
  assert.deepEqual(d.summaryCell(null), { text: '–', title: 'Nothing given', overdue: false, done: false, given: 0 });
  const c = d.summaryCell({ given: 40, saved: 38, revised: 2, set_aside: 1, in_progress: 1, opened: 0, locked: 0, due_at: '2026-11-20', overdue: true });
  assert.equal(c.text, '38 of 40');
  assert.equal(c.overdue, true);
  assert.equal(c.done, false);
  assert.match(c.title, /^38 of 40 saved · 2 revised · 1 set aside · 1 in progress · due Friday 20 November 2026$/);
  assert.equal(d.summaryCell({ given: 3, saved: 2, set_aside: 1 }).done, true, 'set aside counts as finished');
  assert.deepEqual(d.cellWord({ status: 'revised', version: 2 }), { text: 'Revised v2', kind: 'done' });
  assert.deepEqual(d.cellWord({ status: 'set_aside' }), { text: 'Set aside', kind: 'warning' });
  assert.deepEqual(d.cellWord(null), { text: 'Not given', kind: '' });
  for (const s of d.STATUS_ORDER) assert.ok(d.CELL_STATUS[s], s);
  assert.equal(d.cellTitle({ status: 'not_given' }), 'Not given to this person');
  const t = d.cellTitle({ status: 'saved', assigned_at: '2026-10-01T10:00:00+01:00', assigned_by: 'ADMIN', first_saved_at: '2026-10-02T10:00:00+01:00',
    saved_at: '2026-10-02T10:00:00+01:00', version: 1, due_at: '2026-11-20' });
  assert.match(t, /^Given 1 Oct 2026, \d\d:\d\d by ADMIN · first saved 2 Oct 2026, \d\d:\d\d · due Friday 20 November 2026$/);
  assert.equal(d.dueText('2026-11-20'), 'Friday 20 November 2026');
  assert.equal(d.dayWords('2026-11-02'), '2 November');
  assert.equal(d.figuresText({ generated_at: '2026-10-30T10:42:00', cached: true }, new Date('2026-10-30T12:00:00')), 'Figures from 10:42, kept for up to two minutes');
  assert.equal(d.figuresText({}), '');
});

test('the people of the grids carry their names beside their IDs where the study team has them', () => {
  const people = d.peopleById([{ annotator_id: 'A01', display_name: 'Annotator one' }, { annotator_id: 'A02', display_name: '' }],
    [{ annotator_id: 'A01', full_name: 'Ann Smith' }, { annotator_id: 'A03', display_name: 'Three', full_name: '' }]);
  assert.equal(d.personText('A01', people), 'A01 · Ann Smith');
  assert.equal(d.personText('A02', people), 'A02');
  assert.equal(d.personText('A03', people), 'A03 · Three');
  assert.equal(d.personText('A09', people), 'A09');
});

const SUMMARY = {
  people: [{ annotator_id: 'A01' }, { annotator_id: 'A02' }, { annotator_id: 'A03' }],
  rows: [
    { kind: 'dataset', id: 'x', name: 'X', complete: false, cells: { A01: { given: 4, saved: 1, overdue: true }, A02: { given: 4, saved: 4 } } },
    { kind: 'dataset', id: 'y', name: 'Y', complete: true, cells: { A02: { given: 2, saved: 2 }, A03: { given: 0 } } },
  ],
};

test('the summary grid filters by person, overdue and complete, and shows only the people given something', () => {
  const ids = (f) => d.filterSummary(SUMMARY.rows, f).map((r) => r.id);
  assert.deepEqual(ids({}), ['x', 'y']);
  assert.deepEqual(ids({ person: 'A01' }), ['x']);
  assert.deepEqual(ids({ person: 'A03' }), []);
  assert.deepEqual(ids({ overdue: true }), ['x']);
  assert.deepEqual(ids({ overdue: true, person: 'A02' }), [], 'overdue for the person chosen');
  assert.deepEqual(ids({ complete: 'yes' }), ['y']);
  assert.deepEqual(ids({ complete: 'no' }), ['x']);
  assert.deepEqual(d.peopleShown(SUMMARY.people, SUMMARY.rows).map((p) => p.annotator_id), ['A01', 'A02']);
  assert.deepEqual(d.peopleShown(SUMMARY.people, SUMMARY.rows, 'A03').map((p) => p.annotator_id), ['A03']);
});

test('the recording grid asks for pages with its filters, and the download has one row per recording and person', () => {
  const target = { kind: 'dataset', id: 'youth-ld-2026' };
  assert.deepEqual(d.recordingsQuery(target, {}, 0), { kind: 'dataset', id: 'youth-ld-2026', offset: 0, limit: 1000 });
  assert.deepEqual(d.recordingsQuery(target, { status: 'saved', person: 'A01', overdue: true, query: ' sub ', refresh: true }, 1000),
    { kind: 'dataset', id: 'youth-ld-2026', offset: 1000, limit: 1000, status: 'saved', annotator_id: 'A01', overdue: true, query: 'sub', refresh: true });
  const rows = [
    { recording_id: 'sub-01/a.edf', file_name: 'a.edf', dataset_id: 'youth-ld-2026', n_rated: 1, ratings_target: 2,
      cells: { A01: { status: 'revised', version: 2, assigned_at: '2026-10-01T10:00:00', assigned_by: 'ADMIN', handout_id: 'h-1', saved_at: '2026-10-03T10:00:00', overdue: false } } },
  ];
  const out = d.trackingCsvRows(target, [{ annotator_id: 'A01' }, { annotator_id: 'A02' }], rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].status, 'revised');
  assert.equal(out[0].version, 2);
  assert.equal(out[1].status, 'not_given');
  assert.equal(out[1].overdue, 'false');
  assert.deepEqual(Object.keys(out[0]), [...d.TRACKING_COLUMNS]);
  assert.equal(d.trackingCsvRows(target, [{ annotator_id: 'A01' }, { annotator_id: 'A02' }], rows, { person: 'A02' }).length, 1);
  const csv = csvText(d.TRACKING_COLUMNS, out);
  assert.match(csv.split('\r\n')[0], /^target_kind,target_id,recording_id,file_name,dataset_id,annotator_id,status,assigned_at,/);
  assert.match(csv.split('\r\n')[1], /^dataset,youth-ld-2026,sub-01\/a\.edf,a\.edf,youth-ld-2026,A01,revised,2026-10-01T10:00:00,ADMIN,h-1,/);
  assert.equal(d.trackingFileName({ kind: 'collection', id: 'c-12 ab' }), 'tracking_collection_c-12-ab.csv');
});
