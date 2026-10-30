// The admin area's usability fixes (the review of October 2026): plain words for the agreement
// summary and the audit log, the settings file that electrotag-agreement --config reads, copies of a
// registered file, a recording set aside that Unassign leaves alone, a reassignment that would do
// nothing, the pace of a young study, readable reviews, Help links into the guides, and the
// demonstration doing as the study server does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
globalThis.sessionStorage = globalThis.sessionStorage || store();
globalThis.localStorage = globalThis.localStorage || store();

const m = await import('../../electrotag/web/static/js/admin/model.js');
const { DemoBackend } = await import('../../electrotag/web/static/js/api/demo.js');
const { docsUrl, DOCS_BASE } = await import('../../electrotag/web/static/js/ui/docs.js');
const { annotatorSays, reviewStatusText } = await import('../../electrotag/web/static/js/annotate/review_pass.js');
const { filterReviews, reviewItemText } = await import('../../electrotag/web/static/js/admin/reviews.js');
const { resolutionText, statusWords } = await import('../../electrotag/web/static/js/admin/problems.js');
const { guideAnchor } = await import('../../electrotag/web/static/js/admin/ui.js');
const { removeQuestion } = await import('../../electrotag/web/static/js/admin/recordings.js');

const memory = () => {
  const s = new Map();
  return { get: (k, f = null) => (s.has(k) ? JSON.parse(s.get(k)) : f), set: (k, v) => s.set(k, JSON.stringify(v)), remove: (k) => s.delete(k) };
};
async function demo(id = 'ADMIN') {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login(id, 'demo');
  return b;
}
async function as(b, id, password = 'demo') {
  await b.logout();
  await b.login(id, password);
  return b;
}
const hex = (n) => n.toString(16).padStart(32, '0');
const root = new URL('../../', import.meta.url);
const headings = (path) => readFileSync(new URL(`docs/${path}`, root), 'utf8').split('\n').filter((l) => /^#{1,3} /.test(l)).map((l) => guideAnchor(l.replace(/^#+ /, '')));

test('the agreement summary is in plain words, without objects or code names', () => {
  const rows = m.agreementSummaryRows({ n_recordings: 58, n_comparable_recordings: 57, annotators: ['A01', 'A02'], config: { x: 1 },
    key_results: [{ category: 'ANY-artifact', kappa: 0.5 }], unusable: { recordings_left_out: 2, recording_ids: ['sub-011/eeg/sub-011.edf', 'sub-015/eeg/sub-015.edf'] } });
  const text = rows.flat().join(' | ');
  assert.equal(text.includes('[object Object]'), false);
  assert.equal(/n recordings|n_|key results/.test(text), false);
  assert.deepEqual(rows[0], ['Recordings analysed', '58']);
  assert.match(text, /Left out \(set aside as ones that cannot be annotated\) \| 2: sub-011\.edf, sub-015\.edf/);
});

test('the settings used are the file electrotag-agreement --config reads, with the recordings set aside', () => {
  const sent = { settings_file: { config: { resolutions_s: [0.1], modes: ['standard'], annotators: null }, recording_ids: null, exclude_recording_ids: ['r2'] } };
  const f = m.agreementSettingsFile(sent, {});
  assert.deepEqual(f.config.resolutions_s, [0.1]);
  assert.deepEqual(f.exclude_recording_ids, ['r2']);
  assert.equal(f.command, 'electrotag-agreement Annotated_Events --config agreement_settings.json');
  // An older study sends no settings file: it is made from the summary and the request, in the same form.
  const old = m.agreementSettingsFile({ summary: { config: { resolutions_s: [0.05] }, unusable: { recording_ids: ['r9'] } } }, { recording_ids: ['r1', 'r9'] });
  assert.deepEqual([old.config.resolutions_s, old.recording_ids, old.exclude_recording_ids], [[0.05], ['r1', 'r9'], ['r9']]);
});

test('the audit log names every kind of change, in words, with the value before and after', () => {
  for (const op of ['problem_report', 'problem_resolve', 'problem_return', 'problem_reassign', 'review_save']) {
    assert.ok(m.AUDIT_OPS[op], op);
    assert.match(m.opText(op), /^[A-Z]/);
  }
  assert.equal(m.opText('something_new'), 'Something new');
  assert.equal(m.settingChangeText('annotation.allow_reviews', true, false), 'allow reviews (annotation) from on to off');
  assert.equal(m.settingChangeText('display.duration_s', 10, 20), 'duration s (display) from 10 to 20');
  assert.equal(m.settingChangeText('channels.hide', [], ['COUNTER']), 'hide (channels) from nothing to COUNTER');
});

test('the projected finish of a young study waits for three days of work', () => {
  assert.equal(m.projectionText({ status: 'not_enough', reason: 'too_early' }), 'After three days of work');
  assert.match(m.projectionFigure({ status: 'not_enough', reason: 'too_early' }).note, /first days/);
  assert.equal(m.projectionFigure({ status: 'projected', date: '2026-12-01' }, 5, new Date('2026-11-20T12:00:00')).note, 'Around then, at the pace of the last 5 days');
});

test('recordings: formats as people write them, one name in a reading error, and copies of the same file found', () => {
  assert.deepEqual(['edf', 'brainvision', 'BDF', 'xyz'].map(m.formatName), ['EDF', 'BrainVision', 'BDF', 'xyz']);
  assert.equal(m.failureText('sub-203/eeg/sub-203_eeg.edf', 'sub-203_eeg.edf is not a readable EDF file: sub-203_eeg.edf: the signal headers are incomplete'),
    'It is not a readable EDF file: the signal headers are incomplete');
  const man = (rid, sha, size = 10) => ({ recording_id: rid, fingerprint: { eeg: { sha256: sha, size } }, timing: {}, ch_names: [] });
  const same = m.duplicatesOf([man('a', 'x'), man('b', 'x'), man('c', 'y'), man('d', 'z')], [{ recording_id: 'old', sha256: 'Z', size_bytes: 10 }]);
  assert.deepEqual([...same], [['b', 'a'], ['d', 'old']]);
  assert.match(removeQuestion({ recording_id: 'sub-200', assigned: 10 }, 'the study'), /taken away from the 10 people.*work in progress is kept.*retire it instead/);
  assert.doesNotMatch(removeQuestion({ recording_id: 'sub-200', assigned: 0 }, 'the study'), /taken away/);
});

test('Unassign says what happens to work already started', () => {
  assert.match(m.unassignQuestion({ recording_id: 'sub-199/eeg/s.edf', status: 'in_progress' }, 'A06'), /^Take s\.edf away from A06\? They have started it: their unsaved work stays/);
  assert.equal(m.unassignQuestion({ recording_id: 'x/s.edf', status: 'todo' }, 'A06'), 'Take s.edf away from A06?');
});

test('a consensus lists its boundary slivers apart from the disagreements worth adjudicating', () => {
  const { main, slivers } = m.splitSlivers([{ onset_s: 3, offset_s: 3.05 }, { onset_s: 10, offset_s: 12 }, { onset_s: 20, offset_s: 20.07 }]);
  assert.deepEqual([main.length, slivers.length], [1, 2]);
});

test('reference sets are named once, and channel colours are a study setting', () => {
  assert.equal(m.setLabel({ set_id: 'example', name: 'Example training set (placeholder)' }), 'Example training set (placeholder) · example');
  assert.equal(m.setLabel({ set_id: 'pilot', name: '' }), 'pilot');
  assert.deepEqual(m.CHANNEL_COLOUR_CHOICES.map(([v]) => v), ['off', 'region', 'side', 'type']);
  assert.deepEqual(m.settingsProblems({ display: { channel_colours: 'rainbow' } }), ['Channel colours are none, by region, by side or by type.']);
  assert.deepEqual(m.settingsProblems({ display: { channel_colours: 'side' } }), []);
});

test('problems: who a recording went to, and an assignment status inside a sentence', () => {
  assert.equal(resolutionText({ resolution: 'reassigned', reassigned_to: 'A06' }), 'Given to A06');
  assert.equal(resolutionText({ resolution: 'returned' }), 'Returned to the annotator');
  assert.equal(statusWords('todo'), 'to do');
  assert.equal(statusWords('in_progress'), 'in progress');
  assert.equal(statusWords(''), 'assigned');
});

test('reviews can be read: each mark with its place and note, and filtered', () => {
  assert.equal(reviewItemText({ annotation_id: 'a', label: 'Eye-blink-artifact', status: 'caveat', onset_s: 1.2, offset_s: 1.5, note: 'too long' }),
    'Caveat: Eye-blink-artifact, 1.20–1.50 s. “too long”');
  assert.equal(reviewItemText({ annotation_id: null, status: 'comment', onset_s: 3, offset_s: 4, note: 'missed artifact?' }),
    'Comment: A stretch without an annotation, 3.00–4.00 s. “missed artifact?”');
  const rows = [{ annotator_id: 'A01', reviewer_id: 'ADMIN', items: [{ status: 'agree' }] }, { annotator_id: 'A02', reviewer_id: 'L01', items: [{ status: 'caveat' }] }];
  assert.deepEqual(filterReviews(rows, { mark: 'caveat' }).map((r) => r.annotator_id), ['A02']);
  assert.deepEqual(filterReviews(rows, { reviewer: 'ADMIN' }).map((r) => r.annotator_id), ['A01']);
});

test('the review mode names the annotator reviewed and shows their own doubt', () => {
  assert.equal(reviewStatusText({ annotator_id: 'A01', display_name: 'Ann', attempt: 2 }, { annotator_id: 'ADMIN' }),
    'Reviewing the work of A01 (Ann), version 2   |   Reviewer: ADMIN');
  assert.equal(annotatorSays({ confidence: 2, note: ' unsure ' }), 'confidence 2 of 5 · “unsure”');
  assert.equal(annotatorSays({ confidence: null, note: '' }), '');
});

test('Help links: one address for the guides, and every section and setting links to a heading that exists', () => {
  assert.equal(DOCS_BASE, 'https://github.com/faisalmushtaq/ElectroTag/blob/main/docs/');
  assert.equal(docsUrl('web/admin.md', 'progress'), `${DOCS_BASE}web/admin.md#progress`);
  const admin = headings('web/admin.md');
  for (const s of m.SECTIONS) assert.ok(admin.includes(guideAnchor(s.title)), `admin.md has no heading for ${s.title}`);
  const reliability = headings('reliability_guide.md');
  const used = [...readFileSync(new URL('electrotag/web/static/js/admin/analyses.js', root), 'utf8').matchAll(/guide\('([a-z0-9-]+)'/g)].map((x) => x[1])
    .concat([...readFileSync(new URL('electrotag/web/static/js/admin/analyses.js', root), 'utf8').matchAll(/hintWith\([^)]*'([a-z0-9-]+)'\)/g)].map((x) => x[1]));
  assert.ok(used.length >= 5);
  for (const a of used) assert.ok(reliability.includes(a), `reliability_guide.md has no heading #${a}`);
  assert.equal(guideAnchor('1. Time-resolved agreement'), '1-time-resolved-agreement');
});

test('demonstration: Unassign leaves a recording set aside alone, and a reassignment that changes nothing is refused', async () => {
  const b = await demo('A01');
  const rid = (await b.assignments()).items[0].recording_id;
  await b.reportProblem({ problem_id: hex(1), recording_id: rid, mode: 'standard', context_id: '', reason: 'bad_channels', note: '', outcome: 'unusable', where: 'home' });
  await as(b, 'ADMIN');
  await assert.rejects(() => b.admin('unassign', { annotator_id: 'A01', recording_id: rid, mode: 'standard', context_id: '' }),
    (e) => e.status === 409 && e.code === 'set_aside' && /Problems/.test(e.message));
  await b.admin('user_add', { annotator_id: 'A06', password: 'long enough' });
  await b.admin('assign', { annotator_ids: ['A06'], recording_ids: [rid] });
  await assert.rejects(() => b.admin('problem_reassign', { problem_id: hex(1), annotator_id: 'A06' }), (e) => e.code === 'already_assigned');
  assert.equal((await b.admin('problems_list', {})).problems[0].state, 'open');
  await b.admin('user_add', { annotator_id: 'A07', password: 'long enough' });
  const out = await b.admin('problem_reassign', { problem_id: hex(1), annotator_id: 'A07' });
  assert.equal(resolutionText(out.problem), 'Given to A07');
});

test('demonstration: switching off an account that is off already changes nothing and is not audited', async () => {
  const b = await demo();
  assert.equal((await b.admin('user_update', { annotator_id: 'A01', status: 'disabled' })).changed, true);
  const n = (await b.admin('audit', {})).entries.length;
  assert.equal((await b.admin('user_update', { annotator_id: 'A01', status: 'disabled' })).changed, false);
  assert.equal((await b.admin('audit', {})).entries.length, n);
  await b.admin('settings_update', { settings: { annotation: { allow_reviews: false } } });
  assert.match((await b.admin('audit', {})).entries[0].summary, /allow reviews \(annotation\) from on to off/);
});

test('demonstration: the pace of a study in its first days is that of the days so far', async () => {
  const b = await demo();
  await b.admin('user_add', { annotator_id: 'A02', password: 'long enough' });
  await b.admin('assign', { annotator_ids: ['A02'], all: true }); // work still to do
  await as(b, 'A01');
  const items = (await b.assignments()).items;
  for (const it of items.slice(0, 3)) await b.submit({ recording_id: it.recording_id, mode: 'standard', context_id: '', annotations: [], session: {}, sha256: 'f'.repeat(64) });
  await as(b, 'ADMIN');
  const t = (await b.admin('stats', {})).totals;
  assert.equal(t.pace_days, 1);
  assert.equal(t.pace_per_day, 3);
  assert.deepEqual(t.projection, { status: 'not_enough', date: null, reason: 'too_early' });
});
