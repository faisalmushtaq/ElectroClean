// The demonstration backend: accounts, matching by fingerprint and by name, drafts, saving,
// the guided training steps and practice scoring.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DemoBackend, exampleRecording, TRAINING_SET } from '../../electrotag/web/static/js/api/demo.js';
import { truthAnnotations, demoSpecs } from '../../electrotag/web/static/js/eeg/synthetic.js';
import { stageChip } from '../../electrotag/web/static/js/training/path.js';

const memory = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)), remove: (k) => m.delete(k) };
};

/** Any file's checksum: the study keeps the one sent with the saved annotations. */
const SHA = 'f'.repeat(64);

async function signedIn(id) {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login(id, 'demo');
  return b;
}

/** T01 past the first two stages of the training path (the tour and the snippets, skipped). */
async function trainee() {
  const b = await signedIn('T01');
  for (const stage of ['tour', 'snippets']) await b.trainingStage({ stage, action: 'skip' });
  return b;
}

async function matchBody(rid) {
  const rec = exampleRecording(rid);
  const fp = await rec.fingerprint();
  return { file_name: rec.fileName, size_bytes: rec.sizeBytes, format: 'edf', sha256: fp.hex, sfreq: rec.sfreq,
    n_samples: rec.nSamples, ch_names: rec.channels.map((c) => c.name) };
}

test('sign-in needs a demo account and the demo password', async () => {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await assert.rejects(() => b.login('A01', 'wrong'), (e) => e.status === 401 && e.code === 'bad_credentials');
  await assert.rejects(() => b.me(), (e) => e.status === 401);
  const who = await b.login(' a01 ', 'demo');
  assert.equal(who.annotator_id, 'A01');
  const me = await b.me();
  assert.equal(me.programme, null);
  assert.equal(me.catalogue.labels.length, 29);
  assert.equal(me.study.annotation.quick_labels.length, 9);
});

test('a built-in recording matches by fingerprint; a changed copy by name; anything else is unknown', async () => {
  const b = await signedIn('A01');
  const { items, next } = await b.assignments();
  assert.equal(items.length, 3);
  assert.equal(next, items[0].recording_id);
  assert.match(next, /^sub-demo01\/eeg\/sub-demo01_task-rest_eeg\.edf$/);
  const body = await matchBody(next);
  const m = await b.match(body);
  assert.equal(m.status, 'matched');
  assert.equal(m.manifest.ch_names.length, 22);
  assert.equal(m.manifest.fingerprint.hex, body.sha256);
  const changed = await b.match({ ...body, sha256: '0'.repeat(64) });
  assert.equal(changed.status, 'matched_metadata');
  assert.match(changed.message, /but is not byte for byte the study's copy/);
  assert.match(changed.differences[0], /^The file's checksum differs/);
  const other = await b.match({ ...body, file_name: 'something_else.edf', sha256: '1'.repeat(64) });
  assert.equal(other.status, 'unknown');
});

test('drafts are kept and saving marks the recording done; a second save is refused', async () => {
  const b = await signedIn('A01');
  const { next } = await b.assignments();
  const body = await matchBody(next);
  const m = await b.match(body);
  const ann = { annotation_id: 'a'.repeat(32), label: 'Eye-blink-artifact', onset_sample: 750, duration_samples: 100,
    channels: ['Fp1', 'Fp2'], created_at: 'x', modified_at: 'x' };
  await b.putDraft(m.recording_id, m.mode, m.context_id, { annotations: [ann], view: {}, elapsed_s: 5 });
  assert.equal((await b.match(body)).draft.annotations.length, 1);
  assert.equal((await b.assignments()).items[0].status, 'in_progress');
  await assert.rejects(() => b.submit({ recording_id: m.recording_id, mode: 'standard', context_id: '',
    annotations: [{ ...ann, label: 'Not-a-type' }], sha256: body.sha256 }), (e) => e.status === 422);
  const saved = await b.submit({ recording_id: m.recording_id, mode: 'standard', context_id: '', annotations: [ann], session: {}, sha256: body.sha256 });
  assert.equal(saved.saved, true);
  assert.equal(saved.feedback, null);
  assert.notEqual(saved.next, m.recording_id);
  assert.equal((await b.match(body)).status, 'done');
  await assert.rejects(() => b.submit({ recording_id: m.recording_id, mode: 'standard', context_id: '', annotations: [], sha256: body.sha256 }),
    (e) => e.status === 409 && e.code === 'already_done');
  const doc = b.resultsDocument();
  assert.equal(doc.annotation_documents[0].schema, 'electrotag.annotations');
  assert.equal(doc.annotation_documents[0].annotations[0].onset, 3);
});

test('guided training: a wrong attempt is explained, Show me places the answer, and the path moves on', async () => {
  const b = await trainee();
  const rid = TRAINING_SET.guided[0].rid;
  // Practice is locked until the guided recordings are done.
  const practice = await b.match(await matchBody(TRAINING_SET.practice[0]));
  assert.equal(practice.status, 'not_assigned');
  const m = await b.match(await matchBody(rid));
  assert.equal(m.status, 'matched');
  assert.equal(m.mode, 'guided');
  const g = await b.guided(rid);
  assert.equal(g.guidance, 'show');
  assert.equal(g.current.instruction, 'Mark this Eye-blink-artifact');
  assert.ok(g.current.ghost);
  const first = await b.guidedCheck(rid, { step: 1, annotations: [] });
  assert.deepEqual(first.problems, ['missing']);
  const target = g.current.ghost;
  const wrong = { annotation_id: 'w'.repeat(32), label: 'EMG-artifact', onset_sample: target.onset_sample + 40,
    duration_samples: target.duration_samples, channels: target.channels, created_at: '', modified_at: '' };
  const c1 = await b.guidedCheck(rid, { step: 1, annotations: [wrong] });
  assert.equal(c1.matched, false);
  assert.ok(c1.problems.includes('type'));
  assert.ok(c1.messages.some((t) => t.startsWith('Type: the experts marked this as an Eye-blink-artifact; yours is')));
  assert.ok(!c1.problems.includes('start')); // 0.16 s late is within the 0.2 s tolerance
  await assert.rejects(() => b.guidedContinue(rid, { step: 1 }), (e) => e.status === 409);
  const right = { ...wrong, label: 'Eye-blink-artifact', onset_sample: target.onset_sample };
  const c2 = await b.guidedCheck(rid, { step: 1, annotations: [right] });
  assert.equal(c2.can_continue, true);
  assert.equal(c2.stars, 2); // one failed attempt
  let next = await b.guidedContinue(rid, { step: 1 });
  assert.equal(next.step, 2);
  const anns = [right];
  for (let s = 2; ; s++) {
    const shown = await b.guidedShowMe(rid, { step: s });
    anns.push(shown.annotation);
    const c = await b.guidedCheck(rid, { step: s, annotations: anns });
    assert.equal(c.can_continue, true, c.messages.join(' '));
    next = await b.guidedContinue(rid, { step: s });
    if (next.complete) break;
  }
  assert.equal(next.summary.steps, 6);
  assert.equal(next.summary.stars, 2 + 5);
  const saved = await b.submit({ recording_id: rid, mode: 'guided', context_id: 'example', annotations: anns, session: {}, sha256: SHA });
  assert.equal(saved.saved, true);
  const t = await b.training();
  assert.equal(t.stages[2].status, 'in_progress');
  assert.equal(t.next.recording_id, TRAINING_SET.guided[1].rid);
  assert.equal(t.next.label, 'Start recording 2 of 2');
});

test('an extra annotation blocks Continue with the desktop message', async () => {
  const b = await trainee();
  const rid = TRAINING_SET.guided[0].rid;
  const g = await b.guided(rid);
  const t = g.current.ghost;
  const right = { annotation_id: 'r'.repeat(32), label: 'Eye-blink-artifact', onset_sample: t.onset_sample,
    duration_samples: t.duration_samples, channels: t.channels };
  const stray = { annotation_id: 's'.repeat(32), label: 'EMG-artifact', onset_sample: 0, duration_samples: 50, channels: [] };
  const c = await b.guidedCheck(rid, { step: 1, annotations: [right, stray] });
  assert.equal(c.matched, true);
  assert.equal(c.can_continue, false);
  assert.deepEqual(c.extras, [stray.annotation_id]);
  assert.match(c.messages[0], /^Nothing is marked at 0\.00–0\.20 s in the experts' annotations: delete this EMG-artifact/);
});

test('practice is scored with MISSED, EXTRA and TYPE flags', async () => {
  const b = await trainee();
  // Finish both guided recordings first (Show me for every step).
  for (const g of TRAINING_SET.guided) {
    const anns = [];
    for (let s = 1; ; s++) {
      anns.push((await b.guidedShowMe(g.rid, { step: s })).annotation);
      await b.guidedCheck(g.rid, { step: s, annotations: anns });
      const n = await b.guidedContinue(g.rid, { step: s });
      if (n.complete) break;
    }
    await b.submit({ recording_id: g.rid, mode: 'guided', context_id: 'example', annotations: anns, session: {}, sha256: SHA });
  }
  const rid = TRAINING_SET.practice[0];
  assert.equal((await b.match(await matchBody(rid))).status, 'matched');
  const spec = demoSpecs().find((s) => s.id === 'demo-03');
  const truth = truthAnnotations(spec);
  const mine = truth.slice(0, 6).map((a, i) => ({ ...a, annotation_id: `m${i}`.padEnd(32, '0'), label: i === 0 ? 'EMG-artifact' : a.label }));
  mine.push({ ...truth[0], annotation_id: 'x'.padEnd(32, '0'), onset_sample: 21000, duration_samples: 100, channels: [] });
  const r = await b.submit({ recording_id: rid, mode: 'practice', context_id: 'example', annotations: mine, session: {}, sha256: SHA });
  const kinds = r.feedback.flags.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['EXTRA', 'MISSED', 'MISSED', 'TYPE']);
  assert.equal(r.feedback.reference.length, truth.length);
  // the plain words of the review, as the server's (coach.py practice_result)
  assert.deepEqual(r.feedback.counts, { reference_events: truth.length, your_events: 7, found: 6, extra: 1, other_type: 1 });
  assert.equal(r.feedback.summary, `You found 6 of the experts' ${truth.length} artifacts and made 1 mark they did not make. 1 of the 6 you found has another type than theirs.`);
  assert.match(r.feedback.verdict, /^Not yet: you need a score of at least 80% .* then try this recording again from your training path\.$/);
  const t = await b.training();
  assert.equal(t.stages[2].status, 'completed');
  assert.equal(t.stages[3].status, r.feedback.passed ? 'completed' : 'in_progress');
  assert.equal(t.stages[3].result, 'not_passed');
  assert.match(t.stages[3].detail, /^Best score: \d+%, with the right type for \d+% of the artifacts found\. You found 6 of/);
  // one practice recording: it is the one tried again, and the words say so
  assert.equal(t.next.recording_id, rid);
  assert.equal(t.next.label, 'Try the practice recording again');
  assert.equal(t.complete, false);
  assert.equal((await b.me()).programme.complete, false);
});

test("a guided step's time leaves out the time the recording was closed (as coach.py)", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000 });
  const b = await trainee();
  const rid = TRAINING_SET.guided[0].rid;
  const g = await b.guided(rid); // opened: step 1 starts
  const target = g.current.ghost;
  const right = { annotation_id: 'r'.repeat(32), label: 'Eye-blink-artifact', onset_sample: target.onset_sample,
    duration_samples: target.duration_samples, channels: target.channels };
  t.mock.timers.tick(20_000); // 20 s, then a first try
  await b.guidedCheck(rid, { step: 1, annotations: [{ ...right, label: 'EMG-artifact' }] });
  t.mock.timers.tick(600_000); // closed for ten minutes
  await b.guided(rid); // opened again
  t.mock.timers.tick(5_000);
  await b.guidedCheck(rid, { step: 1, annotations: [right] });
  t.mock.timers.tick(2_000);
  await b.guidedContinue(rid, { step: 1 });
  assert.equal(b.state.guided[`T01|${rid}`].seconds[0], 27);
});

test('the training path shows results, not only progress: a failed assessment has no tick', () => {
  assert.deepEqual(stageChip({ key: 'practice', status: 'in_progress', result: 'not_passed' }), ['Not passed yet', 'active']);
  assert.deepEqual(stageChip({ key: 'practice', status: 'completed', result: 'passed' }), ['Completed', 'done']);
  assert.deepEqual(stageChip({ key: 'assessment', status: 'completed', result: 'met' }), ['Criteria met', 'done']);
  assert.deepEqual(stageChip({ key: 'assessment', status: 'completed', result: 'not_met' }), ['Criteria not met yet', '']);
  assert.deepEqual(stageChip({ key: 'assessment', status: 'completed', result: 'not_determined' }), ['Result to come', '']);
  assert.deepEqual(stageChip({ key: 'assessment', status: 'not_used' }), ['Not included', '']);
});

test('E01 is an expert who also annotates, and the expert channel is for experts and administrators', async () => {
  const e = await signedIn('E01');
  const me = await e.me();
  assert.deepEqual([me.role, me.roles], ['expert', ['expert', 'annotator']]);
  assert.deepEqual(me.study.review, { show_corrections_to_annotators: true, show_outcomes_to_annotators: true });
  assert.deepEqual(me.study.training, { skippable: ['tour', 'snippets', 'guided', 'practice'], gate: 'met' });
  const got = await e.expert('replay_consent_get', {});
  assert.deepEqual(got.consent, { teaching: false, changed_at: null });
  const set = await e.expert('replay_consent_set', { teaching: true });
  assert.equal(set.changed, true);
  assert.equal((await e.expert('replay_consent_set', { teaching: true })).changed, false);
  await assert.rejects(() => e.expert('no_such_op', {}), (x) => x.status === 404 && x.code === 'not_found');
  await assert.rejects(() => e.admin('overview', {}), (x) => x.status === 403);
  const a = await signedIn('A01');
  assert.deepEqual((await a.me()).roles, ['annotator']);
  await assert.rejects(() => a.expert('replay_consent_get', {}), (x) => x.status === 403 && x.code === 'forbidden');
  assert.deepEqual(await a.myFeedback(), { corrections: { shown: true, items: [] }, adjudications: { shown: true, items: [] } });
  const admin = await signedIn('ADMIN');
  assert.equal((await admin.expert('replay_consent_get', {})).consent.teaching, false); // an administrator may do what an expert does
  const t = await signedIn('T01');
  await assert.rejects(() => t.trainingStage({ stage: 'assessment', action: 'skip' }), (x) => x.status === 409 && x.code === 'cannot_skip');
  assert.equal((await t.trainingStage({ stage: 'tour', action: 'done' })).stages[0].status, 'completed');
  assert.ok((await t.trainingSnippets()).snippets.length); // web_tests/unit/ui_training_path.test.mjs has more
});

test('a sandbox kept by an earlier version gets roles, the expert and the newer settings', async () => {
  const { initialAdminState, upgradeAdminState } = await import('../../electrotag/web/static/js/api/demo_admin.js');
  const fresh = new DemoBackend({ storage: memory(), tokens: memory() });
  const old = initialAdminState(fresh._builtIn());
  old.version = 1;
  old.users = old.users.filter((u) => u.annotator_id !== 'E01').map(({ roles, ...u }) => u); // eslint-disable-line no-unused-vars
  delete old.settings.review;
  delete old.settings.training;
  const up = upgradeAdminState(old);
  assert.equal(up.version, 2);
  assert.deepEqual(up.users.find((u) => u.annotator_id === 'ADMIN').roles, ['admin']);
  assert.deepEqual(up.users.find((u) => u.annotator_id === 'E01').roles, ['expert', 'annotator']);
  assert.equal(up.settings.training.gate, 'met');
  assert.equal(up.settings.review.k_default, 2);
  // brought up to date once: an expert removed afterwards stays removed
  up.users = up.users.filter((u) => u.annotator_id !== 'E01');
  assert.equal(upgradeAdminState(up).users.some((u) => u.annotator_id === 'E01'), false);
});

test('the sandbox, as the study: a trainee never watches an expert on a recording that can be study work', async () => {
  // Finding 4 of the expert review (independence of annotations). The sandbox's training recordings are its study
  // recordings too, so none of its recordings is a teaching recording: E01's sessions are listed for nobody.
  const storage = memory();
  const b = new DemoBackend({ storage, tokens: memory() });
  await b.login('E01', 'demo');
  await b.expert('replay_consent_set', { teaching: true });
  const rid = TRAINING_SET.guided[0].rid;
  const v = (await b.openVisit({ client: {}, programme: false, mode: 'guided', context_id: 'example' })).visit_id;
  await b.sendEvents(v, [{ t: 1, type: 'recording_opened', recording: rid, window_no: 1, mode: 'guided', session_id: '1'.repeat(32) },
    { t: 2, type: 'recording_finished', recording: rid, window_no: 1 }]);
  for (const who of ['T01', 'A01']) {
    await b.login(who, 'demo');
    assert.deepEqual(await b.expert('teaching_list', {}), { shown: true, sessions: [] });
    for (const body of [{ annotator_id: 'E01', recording_id: rid }, { annotator_id: 'E01', recording_id: rid, mode: 'guided', context_id: 'example' }]) {
      await assert.rejects(() => b.expert('replay_index_get', body), (x) => x.status === 403 && /your own judgement/.test(x.message));
    }
    for (const body of [{ visit_id: v, window_no: 1 }, { visit_id: v }]) {
      await assert.rejects(() => b.expert('replay_events_get', body), (x) => x.status === 403 && x.code === 'forbidden');
    }
  }
  await b.login('ADMIN', 'demo'); // the study team replays every session
  assert.equal((await b.expert('replay_index_get', { annotator_id: 'E01', recording_id: rid, mode: 'guided', context_id: 'example' })).segments.length, 1);
});

test('the sandbox, as the study: two experts\' corrections of one version are shown to the annotator as pending', async () => {
  const storage = memory();
  const b = new DemoBackend({ storage, tokens: memory() });
  await b.login('A01', 'demo');
  const body = await matchBody(TRAINING_SET.guided[0].rid);
  const m = await b.match(body);
  const mark = { annotation_id: 'a'.repeat(32), label: 'Eye-blink-artifact', onset_sample: 500, duration_samples: 100, channels: [], created_at: '', modified_at: '' };
  await b.submit({ recording_id: m.recording_id, mode: 'standard', context_id: '', annotations: [mark], session: {}, sha256: body.sha256 });
  const fix = (n, label) => ({ correction_id: n.repeat(32), annotator_id: 'A01', recording_id: m.recording_id, attempt: 1, sha256: body.sha256, session: { elapsed_s: 3 },
    annotations: [{ ...mark, label }], changes: [{ annotation_id: mark.annotation_id, reason: 'wrong_type' }] });
  await b.login('E01', 'demo');
  await assert.rejects(() => b.expert('correction_save', { ...fix('c', 'EMG-artifact'), changes: [{ annotation_id: mark.annotation_id, reason: 'missed' }] }),
    (x) => x.status === 400 && /is not a reason for a changed mark/.test(x.message));
  await b.expert('correction_save', fix('c', 'EMG-artifact'));
  await b.login('A01', 'demo');
  let items = (await b.myFeedback()).corrections.items;
  assert.deepEqual(items.map((i) => [i.standing, i.changes.length]), [['single', 1]]);
  assert.equal((await b.expert('my_correction_get', { correction_id: 'c'.repeat(32) })).standing, 'single');
  await b.login('ADMIN', 'demo');
  await b.expert('correction_save', fix('d', 'Eye-movement-artifact'));
  await b.login('A01', 'demo');
  items = (await b.myFeedback()).corrections.items;
  assert.equal(items.length, 1, 'one item for the version');
  assert.equal(items[0].standing, 'pending');
  assert.deepEqual(items[0].changes, []);
  assert.deepEqual(items[0].correctors.map((p) => p.corrector_id), ['E01', 'ADMIN']);
  await assert.rejects(() => b.expert('my_correction_get', { correction_id: 'c'.repeat(32) }), (x) => x.status === 409 && x.code === 'pending_adjudication');
});
