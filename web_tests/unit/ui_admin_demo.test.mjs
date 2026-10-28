// The demonstration's admin area (js/api/demo_admin.js): what it runs in the browser on the
// demonstration's own state (accounts, assignments, recordings added as manifests, settings,
// reference sets, the audit log and visits), and the operations it leaves to a study server.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DemoBackend, exampleRecording, TRAINING_SET } from '../../electroclean/web/static/js/api/demo.js';
import { manifestProblem, publicManifest } from '../../electroclean/web/static/js/api/demo_admin.js';

const memory = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)), remove: (k) => m.delete(k) };
};

async function demo(id = 'ADMIN') {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login(id, 'demo');
  return b;
}

/** Sign out and in as someone else, as the page does (one backend per page). */
async function as(b, id, password = 'demo') {
  await b.logout();
  await b.login(id, password);
  return b;
}

const SHA = 'c'.repeat(64);
function manifest(rid = 'sub-new/eeg/sub-new_task-rest_eeg.edf', extra = {}) {
  return {
    schema: 'electroclean.web_manifest', schema_version: '1.0.0', scope: 'study', recording_id: rid, relative_path: rid,
    format: 'edf', format_name: 'EDF', file_name: rid.split('/').pop(), files: { stem: 'sub-new_task-rest', path: rid },
    timing: { sfreq: 100, n_samples: 6000, first_samp: 0, meas_date: null, duration_s: 60 },
    ch_names: ['Fp1', 'Fp2', 'Cz', 'HEOG'], hidden_channels: ['Status'], trigger_channels: ['Status'],
    channel_types: { Fp1: 'eeg', Fp2: 'eeg', Cz: 'eeg', HEOG: 'eog' }, bad_channels: ['Cz'],
    fingerprint: { eeg: { path: rid, size: 48256, sha256: SHA } },
    original_events: { source: 'events_tsv', path: null, columns: ['onset', 'duration', 'trial_type', 'value'],
      rows: [['1.0', '0.0', 'stimulus', '1'], ['2.5', '0.5', 'n/a', '7']], onset_s: [1, 2.5], sample: [100, 250] },
    amplitude: { suggested_scalings: { eog: 0.0005 }, warnings: [] }, acquisition_gaps: [[5900, 6000]],
    warnings: ['One warning'], notes: ['A note'], ...extra,
  };
}

const ann = (id, label, onset, dur, channels = []) => ({ annotation_id: id.padEnd(32, '0'), label, onset_sample: onset, duration_samples: dur,
  channels, created_at: 'x', modified_at: 'x' });

test('only administrators can use the admin area; ADMIN is a built-in account', async () => {
  const a = await demo('A01');
  await assert.rejects(() => a.admin('overview'), (e) => e.status === 403 && e.code === 'forbidden');
  const b = await demo('ADMIN');
  assert.equal((await b.me()).role, 'admin');
  const o = await b.admin('overview');
  assert.deepEqual(o.counts, { recordings: 3, annotators: 2, admins: 1, assignments: 6, done: 0, in_progress: 0, todo: 6 });
  assert.equal(o.recent[0].op, 'init');
  await assert.rejects(() => b.admin('no_such_operation'), (e) => e.status === 404);
});

test('an account added in the admin area signs in with its temporary password and sees what was assigned', async () => {
  const b = await demo('ADMIN');
  const r = await b.admin('user_add', { annotator_id: ' a03 ', display_name: 'Annotator three', email: 'a03@example.org', role: 'annotator' });
  assert.equal(r.user.annotator_id, 'A03');
  assert.equal(r.invite_link, null);
  assert.match(r.temporary_password, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  await assert.rejects(() => b.admin('user_add', { annotator_id: 'A03' }), (e) => e.status === 409 && e.code === 'user_exists');
  await assert.rejects(() => b.admin('user_add', { annotator_id: 'A 04' }), (e) => e.status === 400);
  const rids = (await b.admin('recordings_list', { scope: 'study' })).recordings.map((x) => x.recording_id);
  assert.deepEqual(await b.admin('assign', { annotator_ids: ['A03'], recording_ids: rids.slice(0, 2), mode: 'standard', context_id: '' }), { added: 2, already: 0 });
  assert.deepEqual(await b.admin('assign', { annotator_ids: ['A03'], all: true, mode: 'standard', context_id: '' }), { added: 1, already: 2 });
  await assert.rejects(() => b.admin('assign', { annotator_ids: ['A03'], all: true, mode: 'practice', context_id: 'example' }), (e) => e.code === 'demo_limit');

  // The new account signs in with its temporary password and sees its recordings.
  await assert.rejects(() => as(b, 'A03', 'demo'), (e) => e.status === 401);
  await as(b, 'A03', r.temporary_password);
  const me = await b.me();
  assert.equal(me.display_name, 'Annotator three');
  assert.equal(me.programme, null);
  assert.equal((await b.assignments()).items.length, 3);
  await assert.rejects(() => b.admin('users_list'), (e) => e.status === 403);

  // Reset, switch off, remove.
  await as(b, 'ADMIN');
  const reset = await b.admin('user_reset_password', { annotator_id: 'A03' });
  await assert.rejects(() => as(b, 'A03', r.temporary_password), (e) => e.status === 401);
  await as(b, 'A03', reset.temporary_password);
  await as(b, 'ADMIN');
  await b.admin('user_update', { annotator_id: 'A03', status: 'disabled', notes: 'On leave' });
  await assert.rejects(() => as(b, 'A03', reset.temporary_password), (e) => e.status === 403 && e.code === 'account_disabled');
  await as(b, 'ADMIN');
  const list = (await b.admin('users_list')).users;
  const a03 = list.find((u) => u.annotator_id === 'A03');
  assert.deepEqual([a03.status, a03.notes, a03.assigned, a03.done], ['disabled', 'On leave', 3, 0]);
  await b.admin('user_remove', { annotator_id: 'A03' });
  assert.equal((await b.admin('users_list')).users.some((u) => u.annotator_id === 'A03'), false);
  assert.equal((await b.admin('assignments_list', {})).items.some((i) => i.annotator_id === 'A03'), false);
});

test('an administrator cannot demote, switch off or remove their own account', async () => {
  const b = await demo();
  await assert.rejects(() => b.admin('user_update', { annotator_id: 'ADMIN', role: 'annotator' }), (e) => e.status === 409 && e.code === 'self');
  await assert.rejects(() => b.admin('user_update', { annotator_id: 'ADMIN', status: 'disabled' }), (e) => e.code === 'self');
  await assert.rejects(() => b.admin('user_remove', { annotator_id: 'ADMIN' }), (e) => e.code === 'self');
  assert.equal((await b.admin('user_update', { annotator_id: 'ADMIN', display_name: 'Lead' })).user.display_name, 'Lead');
});

test('assignments: listing, unassigning, and finished work stays', async () => {
  const b = await demo();
  const a01 = (await b.admin('assignments_list', { annotator_id: 'A01' })).items;
  assert.equal(a01.length, 3);
  assert.ok(a01.every((i) => i.mode === 'standard' && i.status === 'todo' && i.attempts === 0));
  const t01 = (await b.admin('assignments_list', { annotator_id: 'T01' })).items;
  assert.deepEqual(t01.map((i) => [i.mode, i.context_id]), [['guided', 'example'], ['guided', 'example'], ['practice', 'example']]);
  await assert.rejects(() => b.admin('unassign', { annotator_id: 'T01', recording_id: t01[0].recording_id, mode: 'guided', context_id: 'example' }),
    (e) => e.code === 'programme');
  // A01 finishes the first recording; it cannot be taken away, the others can.
  await as(b, 'A01');
  await b.submit({ recording_id: a01[0].recording_id, mode: 'standard', context_id: '', annotations: [], session: {}, sha256: '' });
  await as(b, 'ADMIN');
  await assert.rejects(() => b.admin('unassign', { annotator_id: 'A01', recording_id: a01[0].recording_id, mode: 'standard', context_id: '' }),
    (e) => e.status === 409 && e.code === 'done');
  await b.admin('unassign', { annotator_id: 'A01', recording_id: a01[1].recording_id, mode: 'standard', context_id: '' });
  const after = (await b.admin('assignments_list', { annotator_id: 'A01' })).items;
  assert.deepEqual(after.map((i) => i.status), ['done', 'todo']);
  const o = await b.admin('overview');
  assert.equal(o.counts.done, 1);
  assert.equal(o.last_saved[0].annotator_id, 'A01');
});

test('recordings added as manifests are registered, matched by fingerprint and saved like the examples', async () => {
  const b = await demo();
  const bad = { ...manifest('sub-x/eeg/x.edf'), fingerprint: { eeg: { sha256: 'short', size: 3 } } };
  const r = await b.admin('recordings_register', { scope: 'study', manifests: [manifest(), bad, { recording_id: 'nothing' }], replace: false });
  assert.deepEqual(r.added, ['sub-new/eeg/sub-new_task-rest_eeg.edf']);
  assert.deepEqual(r.skipped.map((s) => s.recording_id), ['sub-x/eeg/x.edf', 'nothing']);
  assert.match(r.skipped[0].reason, /fingerprint/);
  const again = await b.admin('recordings_register', { scope: 'study', manifests: [manifest()] });
  assert.match(again.skipped[0].reason, /registered already/);
  const builtIn = await b.admin('recordings_register', { scope: 'study', manifests: [manifest(TRAINING_SET.practice[0])], replace: true });
  assert.match(builtIn.skipped[0].reason, /built-in examples/);
  const rec = (await b.admin('recordings_list', { scope: 'study' })).recordings.find((x) => x.recording_id === 'sub-new/eeg/sub-new_task-rest_eeg.edf');
  assert.deepEqual([rec.registered_via, rec.registered_by, rec.sha256, rec.n_channels, rec.duration_s, rec.manifest], ['browser', 'ADMIN', SHA, 4, 60, undefined]);
  await b.admin('user_add', { annotator_id: 'A02', password: 'long enough' });
  await b.admin('assign', { annotator_ids: ['A02'], recording_ids: [rec.recording_id], mode: 'standard', context_id: '' });

  const a = await as(b, 'A02', 'long enough');
  const items = (await a.assignments()).items;
  assert.deepEqual(items.map((i) => [i.recording_id, i.file_name, i.duration_s, i.n_channels]), [[rec.recording_id, 'sub-new_task-rest_eeg.edf', 60, 4]]);
  const m = await a.match({ file_name: 'sub-new_task-rest_eeg.edf', size_bytes: 48256, sha256: SHA, sfreq: 100, n_samples: 6000, ch_names: ['Fp1', 'Fp2', 'Cz', 'HEOG'] });
  assert.equal(m.status, 'matched');
  assert.deepEqual(m.manifest.original_events, [{ onset_sample: 100, duration_samples: 0, label: 'stimulus' }, { onset_sample: 250, duration_samples: 50, label: 'value 7' }]);
  assert.deepEqual(m.manifest.gaps, [[5900, 6000]]);
  assert.equal(m.manifest.display.scalings.eog, 0.0005);
  assert.deepEqual(m.manifest.display.warnings, ['One warning', 'A note']);
  const changed = await a.match({ file_name: 'sub-new_task-rest_eeg.edf', size_bytes: 48257, sha256: 'd'.repeat(64), sfreq: 100, n_samples: 6000, ch_names: ['Fp1', 'Fp2', 'Cz', 'HEOG'] });
  assert.equal(changed.status, 'matched_metadata');
  await assert.rejects(() => a.submit({ recording_id: m.recording_id, mode: 'standard', context_id: '', annotations: [ann('a', 'Eye-blink-artifact', 5990, 20)] }),
    (e) => e.status === 422);
  const saved = await a.submit({ recording_id: m.recording_id, mode: 'standard', context_id: '', annotations: [ann('a', 'Eye-blink-artifact', 300, 40, ['Fp1'])], session: {}, sha256: SHA });
  assert.deepEqual(saved.files, ['sub-new_task-rest_annotator-A02_annotations.json', 'sub-new_task-rest_annotator-A02_events.tsv', 'sub-new_task-rest_annotator-A02_session.json']);
  const doc = a.resultsDocument().annotation_documents.find((d) => d.recording.recording_id === m.recording_id);
  assert.equal(doc.recording.sfreq, 100);
  assert.equal(doc.annotations[0].onset, 3);

  // Retired: no new assignments; removed: only without results.
  const admin = await as(b, 'ADMIN');
  await admin.admin('recording_update', { scope: 'study', recording_id: rec.recording_id, retired: true, notes: 'Copied from the lab drive' });
  assert.deepEqual(await admin.admin('assign', { annotator_ids: ['A01'], all: true, mode: 'standard', context_id: '' }), { added: 0, already: 3 });
  await assert.rejects(() => admin.admin('recording_remove', { scope: 'study', recording_id: rec.recording_id }), (e) => e.code === 'has_results');
  await admin.admin('recordings_register', { scope: 'study', manifests: [manifest('sub-tmp/eeg/tmp.edf')] });
  await admin.admin('recording_remove', { scope: 'study', recording_id: 'sub-tmp/eeg/tmp.edf' });
  await assert.rejects(() => admin.admin('recording_remove', { scope: 'study', recording_id: TRAINING_SET.practice[0] }), (e) => e.code === 'has_results');
});

test('manifests are checked before they are kept, and shown to annotators as the Manifest of the contract', () => {
  assert.equal(manifestProblem(manifest()), null);
  assert.match(manifestProblem({ ...manifest(), schema: 'x' }), /not an ElectroClean recording description/);
  assert.match(manifestProblem({ ...manifest(), schema_version: '2.0.0' }), /not supported/);
  assert.match(manifestProblem(manifest('../outside.edf')), /not a path inside the dataset/);
  assert.match(manifestProblem({ ...manifest(), ch_names: ['A', 'A'] }), /listed twice/);
  assert.match(manifestProblem({ ...manifest(), timing: { sfreq: 0, n_samples: 10 } }), /sampling rate/);
  const p = publicManifest(manifest(), { eeg: 5e-5, eog: 1.5e-4 });
  assert.deepEqual(Object.keys(p).sort(), ['bad_channels', 'ch_names', 'channel_types', 'display', 'duration_s', 'file_name', 'fingerprint', 'format',
    'gaps', 'hidden_channels', 'n_samples', 'original_events', 'recording_id', 'sfreq'].sort());
  assert.deepEqual(p.fingerprint, { algorithm: 'sha256', role: 'eeg', hex: SHA, size_bytes: 48256 });
  assert.deepEqual(p.display.scalings, { eeg: 5e-5, eog: 0.0005 });
});

test('study settings: checked, changed block by block, and used by the demonstration', async () => {
  const b = await demo();
  const before = await b.admin('settings_get');
  assert.deepEqual(Object.keys(before.settings).sort(), ['annotation', 'channels', 'display', 'filters', 'loading', 'logging', 'selection']);
  await assert.rejects(() => b.admin('settings_update', { settings: { filters: { notch_hz: 55 } } }), (e) => e.status === 400 && e.code === 'invalid_settings');
  await assert.rejects(() => b.admin('settings_update', { settings: { output: { directory: '/' } } }), (e) => e.code === 'invalid_settings');
  const quick = ['EMG-artifact', 'Eye-blink-artifact', 'Chewing-artifact'];
  const after = await b.admin('settings_update', { name: 'Pilot study', settings: { filters: { locked: true }, annotation: { quick_labels: quick, min_duration_samples: 5 } },
    logging_notice: 'We record clicks.' });
  assert.equal(after.name, 'Pilot study');
  assert.equal(after.settings.filters.locked, true);
  assert.equal(after.settings.filters.highpass_hz, 1);
  const me = await b.me();
  assert.equal(me.study.name, 'Pilot study');
  assert.equal(me.study.filters.locked, true);
  assert.deepEqual(me.study.annotation.quick_labels, quick);
  assert.equal(me.study.logging_notice, 'We record clicks.');
  // The shortest annotation applies when work is saved.
  await as(b, 'A01');
  const rid = (await b.assignments()).items[0].recording_id;
  await assert.rejects(() => b.submit({ recording_id: rid, mode: 'standard', context_id: '', annotations: [ann('s', 'EMG-artifact', 10, 3)] }), (e) => /shortest annotation/.test(e.message));
  await as(b, 'ADMIN');
  // Interactions not recorded: no notice to show.
  await b.admin('settings_update', { settings: { logging: { interactions: false } } });
  assert.equal((await b.me()).study.logging_notice, '');
  const audit = (await b.admin('audit', {})).entries;
  assert.equal(audit[0].op, 'settings_update');
  assert.match(audit[1].summary, /name/);
});

test('reference sets: created, given references from saved annotations or a file, and their settings', async () => {
  const b = await demo();
  await assert.rejects(() => b.admin('set_create', { set_id: 'example' }), (e) => e.code === 'set_exists');
  const created = await b.admin('set_create', { set_id: 'pilot', name: 'Pilot set', description: 'For the pilot' });
  assert.deepEqual([created.set.set_id, created.set.recordings.length, created.set.practice_review, created.set.quiz_items], ['pilot', 0, true, 0]);
  // A01 annotates a recording; their saved work becomes the practice reference.
  await as(b, 'A01');
  const [rid, rid2] = (await b.assignments()).items.map((i) => i.recording_id);
  const mine = [ann('e1', 'Eye-blink-artifact', 750, 100, ['Fp1', 'Fp2']), ann('e2', 'EMG-artifact', 2300, 400)];
  await b.submit({ recording_id: rid, mode: 'standard', context_id: '', annotations: mine, session: {}, sha256: '' });
  await as(b, 'ADMIN');
  await assert.rejects(() => b.admin('set_add_reference', { set_id: 'pilot', recording_id: rid, recording_scope: 'study', use: 'practice',
    source: { kind: 'annotator', annotator_id: 'T01', mode: 'standard', context_id: '' } }), (e) => e.status === 404);
  await assert.rejects(() => b.admin('set_add_reference', { set_id: 'pilot', recording_id: rid, recording_scope: 'study', use: 'later',
    source: { kind: 'annotator', annotator_id: 'A01' } }), (e) => e.status === 400);
  const added = await b.admin('set_add_reference', { set_id: 'pilot', recording_id: rid, recording_scope: 'study', use: 'practice',
    source: { kind: 'annotator', annotator_id: 'A01', mode: 'standard', context_id: '' }, provenance: { notes: 'A01 is our expert' } });
  assert.equal(added.disagreements, null);
  const entry = added.set.recordings[0];
  assert.deepEqual([entry.recording_id, entry.use, entry.n_reference_events, entry.registered, entry.provenance.method, entry.provenance.experts, entry.provenance.notes],
    [rid, 'practice', 2, true, 'single_expert', ['A01'], 'A01 is our expert']);
  // The recording is copied into the set's scope.
  assert.ok((await b.admin('recordings_list', { scope: 'set:pilot' })).recordings.some((r) => r.recording_id === rid));
  // A file from the desktop application; it must fit the recording.
  const spec = exampleRecording(rid2);
  const docOk = { schema: 'electroclean.annotations', recording: { recording_id: rid2, sfreq: spec.sfreq, n_samples: spec.nSamples },
    annotator: { annotator_id: 'E1' }, annotations: [{ label: 'Movement-artifact', onset: 24, duration: 2, channels: [] }] };
  await assert.rejects(() => b.admin('set_add_reference', { set_id: 'pilot', recording_id: rid2, recording_scope: 'study', use: 'assessment',
    source: { kind: 'document', document: { ...docOk, recording: { n_samples: 5 } } } }), (e) => e.status === 422);
  const withDoc = await b.admin('set_add_reference', { set_id: 'pilot', recording_id: rid2, recording_scope: 'study', use: 'guided', source: { kind: 'document', document: docOk } });
  const guided = withDoc.set.recordings.find((r) => r.recording_id === rid2);
  assert.deepEqual([guided.use, guided.guidance, guided.effective_guidance, guided.n_reference_events, guided.provenance.experts], ['guided', 'auto', 'show', 1, ['E1']]);
  // Consensus and adjudication need the server.
  await assert.rejects(() => b.admin('set_add_reference', { set_id: 'pilot', recording_id: rid, use: 'practice', source: { kind: 'consensus', annotator_ids: ['A01', 'T01'] } }),
    (e) => e.status === 501 && e.code === 'needs_server' && /electroclean-web demo/.test(e.message));
  // Use and guidance; a warning when a training recording becomes an assessment one.
  b.state.submissions.push({ key: 'x', annotator_id: 'T01', recording_id: rid, mode: 'practice', context_id: 'pilot', attempt: 1, saved_at: 'now', annotations: [], session: {} });
  const changed = await b.admin('set_recording_update', { set_id: 'pilot', recording_id: rid, use: 'assessment' });
  assert.match(changed.warnings[0], /T01 already annotated this recording/);
  const g2 = await b.admin('set_recording_update', { set_id: 'pilot', recording_id: rid2, guidance: 'find_unnamed' });
  assert.equal(g2.set.recordings.find((r) => r.recording_id === rid2).effective_guidance, 'find_unnamed');
  // Settings and criteria.
  const upd = await b.admin('set_update', { set_id: 'pilot', practice_review: false, allowed_annotators: ['a01', 'T01'],
    practice_pass: { event_f1: 0.7, label_accuracy: 0.6 }, guided_tolerance: { seconds: 0.3, fraction: 0.25, channel_jaccard: 0.5 },
    criteria: { criteria: [{ metric: 'event_f1', threshold: 0.75, scope: 'overall' }], min_reference_events: 2, categories: null } });
  assert.deepEqual([upd.set.practice_review, upd.set.allowed_annotators, upd.set.practice_pass.event_f1, upd.set.guided_tolerance.seconds],
    [false, ['A01', 'T01'], 0.7, 0.3]);
  assert.deepEqual(upd.set.criteria, { criteria: [{ metric: 'event_f1', threshold: 0.75, scope: 'overall' }], min_reference_events: 2, categories: null });
  await assert.rejects(() => b.admin('set_update', { set_id: 'pilot', criteria: { criteria: [{ metric: 'speed', threshold: 1 }] } }), (e) => e.status === 400);
  await assert.rejects(() => b.admin('set_update', { set_id: 'pilot', practice_pass: { event_f1: 2, label_accuracy: 0.5 } }), (e) => e.status === 400);
  // Removing; a set with saved work stays.
  await b.admin('set_remove_recording', { set_id: 'pilot', recording_id: rid2 });
  await assert.rejects(() => b.admin('set_delete', { set_id: 'pilot' }), (e) => e.code === 'in_use');
  await assert.rejects(() => b.admin('set_delete', { set_id: 'example' }), (e) => e.code === 'in_use' && /T01/.test(e.message));
  await b.admin('set_create', { set_id: 'empty' });
  await b.admin('set_delete', { set_id: 'empty' });
  assert.deepEqual((await b.admin('sets_list')).sets.map((s) => s.set_id), ['example', 'pilot']);
});

test('the demonstration training set: its guided notes, pass mark and guidance reach the trainee', async () => {
  const b = await demo();
  const rid = TRAINING_SET.guided[0].rid;
  const notes = (await b.admin('set_guided_notes', { set_id: 'example', recording_id: rid })).notes;
  assert.equal(notes.length, 6);
  assert.match(notes[0].note, /^Placeholder note/);
  assert.equal(notes[0].onset_s, 3);
  await b.admin('set_guided_note', { set_id: 'example', annotation_id: notes[0].annotation_id, text: 'A blink: both frontal channels dip together.' });
  await assert.rejects(() => b.admin('set_guided_note', { set_id: 'example', annotation_id: 'nope', text: 'x' }), (e) => e.status === 404);
  await b.admin('set_update', { set_id: 'example', practice_pass: { event_f1: 0.5, label_accuracy: 0.5 } });
  await b.admin('set_recording_update', { set_id: 'example', recording_id: TRAINING_SET.guided[1].rid, guidance: 'find_unnamed' });
  await as(b, 'T01');
  const g = await b.guided(rid);
  assert.equal(g.current.note, 'A blink: both frontal channels dip together.');
  assert.equal((await b.guided(TRAINING_SET.guided[1].rid)).guidance, 'find_unnamed');
  const path = await b.training();
  assert.equal(path.stages[1].pass_rule, '50% for finding the artifacts and for their types');
  await as(b, 'ADMIN');
  // The programme can be given to another account, but only this set runs as a programme here.
  await b.admin('user_add', { annotator_id: 'T02', password: 'trainee two' });
  await b.admin('programme_set', { annotator_id: 'T02', set_id: 'example' });
  await as(b, 'T02', 'trainee two');
  assert.equal((await b.me()).programme.set_id, 'example');
  assert.equal((await b.assignments()).items.length, 3);
  await as(b, 'ADMIN');
  await b.admin('set_create', { set_id: 'other' });
  await assert.rejects(() => b.admin('programme_set', { annotator_id: 'T02', set_id: 'other' }), (e) => e.code === 'demo_limit');
  await b.admin('programme_set', { annotator_id: 'T02', set_id: null });
  await as(b, 'T02', 'trainee two');
  assert.equal((await b.me()).programme, null);
  await as(b, 'ADMIN');
  const progress = await b.admin('progress');
  const t01 = progress.annotators.find((x) => x.annotator_id === 'T01');
  assert.equal(t01.programme.set_id, 'example');
  assert.equal(t01.items.length, 3);
  assert.equal(progress.annotators.find((x) => x.annotator_id === 'A01').programme, null);
});

test('quiz items are kept with the set', async () => {
  const b = await demo();
  const rid = TRAINING_SET.practice[0];
  await assert.rejects(() => b.admin('quiz_item_add', { set_id: 'example', recording_id: rid, start_s: 5, end_s: 4, correct_label: 'EMG-artifact' }), (e) => e.status === 400);
  await assert.rejects(() => b.admin('quiz_item_add', { set_id: 'example', recording_id: rid, start_s: 1, end_s: 2, correct_label: 'Nothing' }), (e) => e.status === 400);
  const one = await b.admin('quiz_item_add', { set_id: 'example', recording_id: rid, start_s: 11, end_s: 13, correct_label: 'EMG-artifact',
    accepted_labels: ['Biological-artifact', 'EMG-artifact'], explanation: 'Fast, spiky activity over the temporal channels.' });
  assert.deepEqual(one.item, { item_id: 'q01', recording_id: rid, start_s: 11, end_s: 13, correct_label: 'EMG-artifact',
    accepted_labels: ['Biological-artifact'], explanation: 'Fast, spiky activity over the temporal channels.', context_s: 2 });
  const two = await b.admin('quiz_item_add', { set_id: 'example', recording_id: rid, start_s: 4, end_s: 4.6, correct_label: 'Eye-blink-artifact', item_id: 'blink', context_s: 3 });
  assert.equal(two.item.item_id, 'blink');
  assert.deepEqual((await b.admin('quiz_items', { set_id: 'example' })).items.map((q) => q.item_id), ['q01', 'blink']);
  assert.equal((await b.admin('sets_list')).sets[0].quiz_items, 2);
  await b.admin('quiz_item_remove', { set_id: 'example', item_id: 'q01' });
  await assert.rejects(() => b.admin('quiz_item_remove', { set_id: 'example', item_id: 'q01' }), (e) => e.status === 404);
  assert.deepEqual((await b.admin('quiz_items', { set_id: 'example' })).items.map((q) => q.item_id), ['blink']);
});

test('the audit log pages newest first; visits are listed', async () => {
  const b = await demo();
  for (let i = 0; i < 7; i++) await b.admin('set_create', { set_id: `s${i}` });
  const first = await b.admin('audit', { limit: 5 });
  assert.deepEqual(first.entries.map((e) => e.details.set_id), ['s6', 's5', 's4', 's3', 's2']);
  assert.ok(first.entries.every((e) => e.by === 'ADMIN' && e.op === 'set_create' && e.at));
  const second = await b.admin('audit', { limit: 5, before: first.next });
  assert.deepEqual(second.entries.map((e) => e.op), ['set_create', 'set_create', 'init']);
  assert.equal(second.next, null);
  const v = await b.openVisit({ client: {}, programme: false });
  await b.sendEvents(v.visit_id, [{ t: 1, type: 'key' }, { t: 2, type: 'key' }]);
  let visits = (await b.admin('visits', {})).visits;
  assert.deepEqual([visits[0].visit_id, visits[0].annotator_id, visits[0].n_events, visits[0].closed_at], [v.visit_id, 'ADMIN', 2, null]);
  await b.closeVisit(v.visit_id, 'test');
  visits = (await b.admin('visits', { annotator_id: 'ADMIN' })).visits;
  assert.ok(visits[0].closed_at);
  assert.deepEqual((await b.admin('visits', { annotator_id: 'A01' })).visits, []);
});

test('what needs a study server says so, and how to try it', async () => {
  const b = await demo();
  for (const op of ['agreement', 'activity', 'competency', 'results_zip', 'set_example_create']) {
    await assert.rejects(() => b.admin(op, {}), (e) => e.status === 501 && e.code === 'needs_server' && /study server or Firebase/.test(e.message) &&
      /electroclean-web demo/.test(e.message), op);
  }
});

test('resetting the demonstration forgets what the admin area changed', async () => {
  const b = await demo();
  await b.admin('user_add', { annotator_id: 'A09' });
  await b.admin('settings_update', { name: 'Changed' });
  b.reset();
  assert.equal((await b.admin('users_list')).users.some((u) => u.annotator_id === 'A09'), false);
  assert.equal((await b.admin('settings_get')).name, 'Demonstration');
});
