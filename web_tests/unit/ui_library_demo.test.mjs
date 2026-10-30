// The sandbox's datasets, collections, groups and hand-outs (js/api/demo_library.js) where it differs from the
// study server or goes beyond the parity script (api_contract_parity.test.mjs): a hand-out shared out k per
// recording needs the server's Tasks, registering into a dataset applies its prefix and leaves another
// dataset's IDs alone, later group members get what the group holds, withdrawing keeps started work, a removed
// recording leaves its collections, and the tracking grid's statuses come from the sandbox's own saves, drafts
// and reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DemoBackend } from '../../electrotag/web/static/js/api/demo.js';
import { dayLong, defaultTitle, prefixManifest, prefixProblem, ratingsHistogram } from '../../electrotag/web/static/js/api/demo_library.js';
import { EXAMPLE_ANSWERS } from '../../electrotag/web/static/js/api/demo_questionnaire.js';

const memory = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)), remove: (k) => m.delete(k) };
};
const hex = (n) => n.toString(16).padStart(32, '0');
const SHA = 'ab'.repeat(32);

function manifest(rid, sha = SHA) {
  return {
    schema: 'electrotag.web_manifest', schema_version: '1.0.0', scope: 'study', recording_id: rid, relative_path: rid,
    format: 'edf', format_name: 'EDF', file_name: rid.split('/').pop(), files: { stem: 'sub-new_task-rest', path: rid },
    timing: { sfreq: 100, n_samples: 6000, first_samp: 0, meas_date: null, duration_s: 60 },
    ch_names: ['Fp1', 'Fp2', 'Cz', 'HEOG'], hidden_channels: [], trigger_channels: [],
    channel_types: { Fp1: 'eeg', Fp2: 'eeg', Cz: 'eeg', HEOG: 'eog' }, bad_channels: [],
    fingerprint: { eeg: { path: rid, size: 48256, sha256: sha } },
    original_events: { source: 'none', path: null, columns: [], rows: [], onset_s: [], sample: [] },
    amplitude: { suggested_scalings: {}, warnings: [] }, warnings: [], notes: [],
  };
}

async function admin() {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login('ADMIN', 'demo');
  const rids = (await b.admin('recordings_list', { scope: 'study' })).recordings.map((r) => r.recording_id);
  return { b, rids };
}
const as = async (b, aid, password = 'demo') => { await b.logout(); await b.login(aid, password); };

test('the words and checks the sandbox shares with datasets.py', () => {
  assert.equal(defaultTitle('dataset', 'Youth', '2026-11-20'), 'Youth');
  assert.equal(defaultTitle('collection', 'Pilot: hard', '2026-11-20'), 'Recordings due 20 November');
  assert.equal(defaultTitle('collection', 'Pilot: hard', null), 'Recordings to annotate');
  assert.equal(dayLong('2026-11-20'), 'Friday 20 November');
  assert.deepEqual(ratingsHistogram(['a', 'b', 'c', 'd'], { a: 1, b: 2, c: 5 }), { 0: 1, 1: 1, 2: 1, '3+': 1 });
  assert.equal(prefixProblem('youth/2026'), '');
  assert.match(prefixProblem('../up'), /plain relative folder/);
  const m = prefixManifest(manifest('sub-01/eeg/a.edf'), 'youth');
  assert.equal(m.recording_id, 'youth/sub-01/eeg/a.edf');
  assert.equal(m.fingerprint.eeg.path, 'youth/sub-01/eeg/a.edf');
  assert.equal(m.files.stem, 'sub-new_task-rest');
});

test('a hand-out shared out k per recording needs the study server; everyone-gets-all works', async () => {
  const { b } = await admin();
  const body = { target: { kind: 'dataset', id: 'study-recordings' }, people: ['A01'], mode: 'k', k: 2 };
  await assert.rejects(() => b.admin('handouts_preview_get', body), (e) => e.status === 501 && e.code === 'needs_server' && /electrotag-web demo/.test(e.message));
  await assert.rejects(() => b.admin('handout_create', { ...body, request_id: hex(1) }), (e) => e.code === 'needs_server');
  const made = await b.admin('handout_create', { ...body, mode: 'all', request_id: hex(2) });
  assert.equal(made.handout.mode, 'all');
  assert.equal(made.added, 0, 'A01 had them all already: linked to the hand-out');
  assert.equal(made.already_had, 3);
  const again = await b.admin('handout_create', { ...body, mode: 'all', request_id: hex(2) });
  assert.equal(again.already, true, 'the same request ID again: the hand-out kept');
  assert.equal((await b.admin('handouts_list', {})).handouts.length, 1);
});

test('registering into a dataset applies its prefix, and another dataset\'s IDs are left alone', async () => {
  const { b } = await admin();
  await b.admin('dataset_create', { request_id: hex(1), dataset_id: 'youth', name: 'Youth', path_prefix: 'youth' });
  const r = await b.admin('recordings_register', { scope: 'study', dataset_id: 'youth', manifests: [manifest('sub-01/eeg/a.edf')] });
  assert.deepEqual(r.added, ['youth/sub-01/eeg/a.edf']);
  const plain = await b.admin('recordings_register', { scope: 'study', manifests: [manifest('youth/sub-01/eeg/a.edf', 'cd'.repeat(32))], replace: true });
  assert.equal(plain.added.length + plain.replaced.length, 0);
  assert.match(plain.skipped[0].reason, /Registered already in the dataset youth/);
  await assert.rejects(() => b.admin('recordings_register', { scope: 'study', dataset_id: 'nothing', manifests: [manifest('x.edf')] }), (e) => e.code === 'unknown_dataset');
  const listed = await b.admin('recordings_list', { dataset_id: 'youth' });
  assert.deepEqual(listed.recordings.map((x) => [x.recording_id, x.dataset_id]), [['youth/sub-01/eeg/a.edf', 'youth']]);
  const ds = (await b.admin('datasets_list', {})).datasets;
  assert.deepEqual(ds.map((d) => [d.dataset_id, d.summary.n_recordings]), [['study-recordings', 3], ['youth', 1]]);
  // a removed recording leaves every collection
  const c = await b.admin('collection_create', { request_id: hex(2), name: 'Some', recording_ids: ['youth/sub-01/eeg/a.edf'] });
  await b.admin('recording_remove', { scope: 'study', recording_id: 'youth/sub-01/eeg/a.edf' });
  const after = await b.admin('collection_get', { collection_id: c.collection.collection_id });
  assert.deepEqual(after.collection.recording_ids, []);
  assert.equal(after.collection.changes.at(-1).why, 'recording_removed');
});

test('a later member of a group gets what its following hand-outs hold; withdrawing keeps started work', async () => {
  const { b, rids } = await admin();
  await b.admin('user_add', { annotator_id: 'A02', password: 'long enough' });
  const g = await b.admin('group_create', { request_id: hex(1), name: 'RAs', members: ['A02'] });
  const gid = g.group.group_id;
  const h = await b.admin('handout_create', { request_id: hex(2), target: { kind: 'dataset', id: 'study-recordings' }, groups: [gid], follow_groups: true });
  assert.equal(h.added, 3);
  const joined = await b.admin('group_update', { group_id: gid, add: ['E01'] });
  assert.deepEqual(joined.given, [{ handout_id: h.handout.handout_id, annotator_id: 'E01', added: 3 }]);
  const quiet = await b.admin('group_update', { group_id: gid, add: ['T01'], give_existing: false });
  assert.deepEqual(quiet.given, []);
  // A02 starts one recording (a draft) and saves nothing; E01 starts nothing
  await as(b, 'A02', 'long enough');
  // a new account answers the sign-up questionnaire before any work (demo_questionnaire.js)
  await b.saveQuestionnaire({ answers: EXAMPLE_ANSWERS, contacts: { full_name: 'Test person', email: 'test@example.org' } });
  await b.putDraft(rids[0], 'standard', '', { annotations: [], elapsed_s: 5 });
  await as(b, 'ADMIN');
  const track = await b.admin('tracking_recordings_get', { kind: 'handout', id: h.handout.handout_id });
  assert.deepEqual(track.people.map((p) => p.annotator_id), ['A02', 'E01']);
  assert.equal(track.rows[0].cells.A02.status, 'in_progress');
  assert.equal(track.rows[1].cells.A02.status, 'given');
  assert.equal(track.rows[0].cells.E01.assigned_by, 'ADMIN');
  const w = await b.admin('handout_withdraw', { handout_id: h.handout.handout_id });
  assert.deepEqual([w.removed, w.kept], [5, 1]);
  const left = (await b.admin('assignments_list', { annotator_id: 'A02' })).items.map((i) => i.recording_id);
  assert.deepEqual(left, [rids[0]], 'the recording A02 started stays theirs');
  await assert.rejects(() => b.admin('group_remove', { group_id: 'nothing' }), (e) => e.code === 'unknown_group');
  await b.admin('group_remove', { group_id: gid });
  assert.deepEqual((await b.admin('groups_list', {})).groups, []);
});

test('the tracking grid and the overview read the sandbox\'s saves, revisions and reports', async () => {
  const { b, rids } = await admin();
  await b.admin('handout_create', { request_id: hex(1), target: { kind: 'dataset', id: 'study-recordings' }, people: ['A01'], due_at: '2026-01-05' });
  await b.admin('settings_update', { settings: { annotation: { allow_revisions: true } } });
  await as(b, 'A01');
  const sha = (await b.exampleRecording(rids[0]).fingerprint()).hex;
  const save = (revises) => b.submit({ recording_id: rids[0], mode: 'standard', context_id: '', annotations: [], session: { elapsed_s: 5 }, sha256: sha, ...(revises ? { revises } : {}) });
  await save();
  await save(1);
  await b.reportProblem({ problem_id: hex(0xa1), recording_id: rids[2], mode: 'standard', context_id: '', reason: 'too_noisy', outcome: 'unusable', where: 'home' });
  await as(b, 'ADMIN');
  const t = await b.admin('tracking_recordings_get', { kind: 'dataset', id: 'study-recordings' });
  const st = Object.fromEntries(t.rows.map((r) => [r.recording_id, r.cells.A01.status]));
  assert.deepEqual([st[rids[0]], st[rids[1]], st[rids[2]]], ['revised', 'given', 'set_aside']);
  assert.equal(t.rows[1].cells.A01.overdue, true);
  assert.equal(t.rows[0].cells.A01.overdue, false, 'saved work is never overdue');
  const sum = await b.admin('tracking_datasets_get', { kind: 'dataset' });
  assert.deepEqual(sum.rows[0].cells.A01, { given: 3, opened: 0, in_progress: 0, saved: 1, revised: 1, set_aside: 1, locked: 0,
    first_assigned_at: sum.rows[0].cells.A01.first_assigned_at, last_saved_at: sum.rows[0].cells.A01.last_saved_at, due_at: '2026-01-05', overdue: 1 });
  const o = await b.admin('overview', {});
  assert.deepEqual([o.counts.overdue, o.counts.handouts_open], [1, 1]);
  const n = await b.admin('notify_preview_get', { kind: 'overdue' });
  assert.deepEqual(n.notices.map((x) => [x.kind, x.to, x.subject]), [['overdue', ['A01'], 'Study recordings: 1 recording still to annotate']]);
  assert.equal(n.sent, false);
});
