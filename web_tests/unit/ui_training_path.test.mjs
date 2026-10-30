// The five-stage training path in the browser: the stages' rules (js/training/stages.js, the same as
// electrotag/training/programme.py, which tests/test_training_stages.py checks), the words of the path
// (js/training/path.js), the snippets' gallery order (js/training/snippets.js), the sandbox's stage
// actions and snippets (js/api/demo_training_stages.js) and the admin area's helpers for snippets and a
// trainee's path. That the sandbox answers as the server does is web_tests/unit/api_contract_parity.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STAGES, REOPENED_TEXT, SKIPPED_TEXT, browserStep, correctionsDetail, isFinished, isUnlocked, maySkip, snippetsDetail, stageMarks, stagePolicy, stageStates,
} from '../../electrotag/web/static/js/training/stages.js';
import { COMPLETE_TEXT, LOCKED_TEXT, NOT_MET_TEXT, PASSED_TEXT, STAGE_LINES, TO_COME_TEXT, WATCH_EXPERT, canLookAgain, countText, detailText, pathOutcome, roundText, skipQuestion, stageChip } from '../../electrotag/web/static/js/training/path.js';
import { galleryOrder, groupSnippets, keyStep, quizResultText, whereText } from '../../electrotag/web/static/js/training/snippets.js';
import { nextSnippetId, parseChannels } from '../../electrotag/web/static/js/admin/snippets.js';
import { eventText, roundLine } from '../../electrotag/web/static/js/admin/training_gate.js';
import { programmeText, progressCounts } from '../../electrotag/web/static/js/admin/model.js';
import { DemoBackend, TRAINING_SET } from '../../electrotag/web/static/js/api/demo.js';
import { Catalogue } from '../../electrotag/web/static/js/catalogue.js';
import { CATALOGUE } from '../../electrotag/web/static/js/api/demo_catalogue.js';

function memory() {
  const m = new Map();
  return { get: (k, d = null) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) };
}

const G = ['g1', 'g2'];
const P = ['p1'];
const A = ['a1'];
const base = (over = {}) => ({
  guided: { total: G, done: [] }, practice: { total: P, done: [], base: 'available' }, assessment: { total: A, done: [] },
  nSnippets: 5, quiz: true, ...over,
});
const statuses = (states) => states.map((s) => s.status);
const ev = (event, stage, extra = {}) => ({ event, stage, at: '2026-10-30T10:00:00+00:00', ...extra });

// ---------------------------------------------------------------- the stages' rules
test('the stages unlock in order; a skipped stage counts as finished and its recordings are not offered', () => {
  let s = stageStates(base());
  assert.deepEqual(statuses(s), ['available', 'locked', 'locked', 'locked', 'locked']);
  assert.deepEqual(s.map((x) => x.can_skip), [true, false, false, false, false]);
  assert.deepEqual(browserStep(s), { stage: 'tour', recording_id: null, repeat: false, label: 'Start the tour',
    text: 'Next: Find your way around, a short tour of ElectroTag on a practice recording.' });
  s = stageStates(base({ events: [ev('stage_skipped', 'tour'), ev('stage_completed', 'snippets'), ev('stage_skipped', 'guided')] }));
  assert.deepEqual(statuses(s), ['skipped', 'completed', 'skipped', 'available', 'locked']);
  assert.equal(s[0].detail, SKIPPED_TEXT);
  assert.ok(s[0].can_resume && isFinished(s[0]) && !isUnlocked(s[2]));
  assert.equal(browserStep(s), null);
  // the guided stage done afterwards stays done when the trainee takes the tour up again
  s = stageStates(base({ events: [ev('stage_skipped', 'tour'), ev('stage_skipped', 'snippets'), ev('stage_resumed', 'tour')],
    guided: { total: G, done: G } }));
  assert.deepEqual(statuses(s), ['available', 'skipped', 'completed', 'locked', 'locked']);
});

test('the assessment is never skipped, and the policy decides the rest', () => {
  assert.equal(maySkip(stagePolicy({ skippable: STAGES }), 'assessment'), false);
  const skipAll = [ev('stage_skipped', 'tour'), ev('stage_skipped', 'snippets'), ev('stage_skipped', 'guided'), ev('stage_skipped', 'practice'),
    ev('stage_skipped', 'assessment')];
  const s = stageStates(base({ events: skipAll }));
  assert.equal(s[4].status, 'available');
  assert.equal(s[4].can_skip, false);
  assert.deepEqual(stageMarks(skipAll).skipped, ['tour', 'snippets', 'guided', 'practice']);
  const policy = stagePolicy({ skippable: ['practice'], tour: false });
  const p = stageStates(base({ policy }));
  assert.deepEqual(statuses(p), ['not_used', 'available', 'locked', 'locked', 'locked']);
  assert.equal(p[1].can_skip, false);
  assert.deepEqual(stagePolicy({}), { skippable: ['tour', 'snippets', 'guided', 'practice'], tour: true, snippets_quiz_required: false });
  assert.deepEqual(stagePolicy({ skippable: ['practice', 'assessment', 'tour'] }).skippable, ['tour', 'practice']);
});

test('reopening and a new assessment set, as the progress events say', () => {
  const reopened = stageMarks([ev('stage_skipped', 'tour'), ev('stage_skipped', 'guided'), ev('training_reopened', undefined, { from: 'guided' })]);
  assert.deepEqual(reopened.flags, { tour: 'skipped' });
  assert.equal(reopened.reopened.from, 'guided');
  const s = stageStates(base({ events: [ev('training_reopened', undefined, { from: 'practice' })], nSnippets: 0, policy: stagePolicy({ tour: false }),
    guided: { total: G, done: G } }));
  assert.equal(s[4].detail, REOPENED_TEXT);
  const carried = stageStates(base({ events: [ev('assessment_set_assigned', undefined, { from_set: 'pilot', from_set_name: 'Pilot set' })] }));
  assert.deepEqual(statuses(carried), ['completed', 'completed', 'completed', 'completed', 'available']);
  assert.ok(carried.slice(0, 4).every((x) => x.carried && x.detail === 'Done in Pilot set.'));
});

test('a new assessment set keeps each stage as it was in the earlier set: a skip stays a skip', () => {
  const stages = { tour: { status: 'skipped', set_id: 'pilot', set_name: 'Pilot set' }, snippets: { status: 'completed', set_id: 'pilot', set_name: 'Pilot set' },
    guided: { status: 'skipped', set_id: 'first', set_name: 'First set' }, practice: { status: 'not_used', set_id: 'pilot', set_name: 'Pilot set' } };
  const events = [ev('assessment_set_assigned', undefined, { from_set: 'pilot', from_set_name: 'Pilot set', stages,
    skips: [{ stage: 'guided', at: '0', set_id: 'first', set_name: 'First set' }, { stage: 'tour', at: '1', set_id: 'pilot', set_name: 'Pilot set' }],
    earlier_rounds: [{ set_id: 'first', set_name: 'First set', status: 'not_met', status_text: 'x', at: '0' }],
    round: { set_id: 'pilot', set_name: 'Pilot set', status: 'not_met', status_text: 'y', at: '1' } })];
  const s = stageStates(base({ events }));
  assert.deepEqual(statuses(s), ['skipped', 'completed', 'skipped', 'not_used', 'available']);
  assert.deepEqual(s.slice(0, 4).map((x) => x.detail), ['Skipped in Pilot set.', 'Done in Pilot set.', 'Skipped in First set.', 'Not part of your training in Pilot set.']);
  assert.ok(s.slice(0, 4).every((x) => x.carried && !x.can_resume && !x.can_skip));
  const marks = stageMarks(events);
  assert.deepEqual(marks.skipped, ['tour', 'guided']);
  assert.deepEqual(marks.rounds.map((r) => [r.round, r.set_id]), [[1, 'first'], [2, 'pilot']]);
  assert.equal(roundText({ ...marks.rounds[1], status_text: 'Does not yet meet the competency criteria.' }), 'Round 2, Pilot set: Does not yet meet the competency criteria.');
  // a stage the study team reopened is done again, never skipped
  const re = stageStates(base({ events: [ev('stage_skipped', 'tour'), ev('stage_skipped', 'snippets'), ev('stage_skipped', 'guided'),
    ev('training_reopened', undefined, { from: 'guided' })] }));
  assert.equal(re[2].status, 'available');
  assert.equal(re[2].can_skip, false);
  assert.ok(re[0].can_resume);
});

test('correct the marks on the stage card, and the snippets\' keys and check', () => {
  assert.equal(correctionsDetail({ g1: { kind: 'correct', n_errors: 4, fixed: 2 }, g2: { stars: 3 } }, ['g1', 'g2']),
    'Correct the marks: you fixed 2 of 4 planted mistakes.');
  assert.equal(correctionsDetail({ g1: { kind: 'correct', n_errors: 1, fixed: 1 } }, ['g1']), 'Correct the marks: you fixed 1 of 1 planted mistake.');
  assert.equal(correctionsDetail({}, []), '');
  assert.equal(stageStates(base({ guided: { total: G, done: ['g1'], detail: 'Correct the marks: you fixed 2 of 4 planted mistakes.' } }))[2].detail,
    'Correct the marks: you fixed 2 of 4 planted mistakes.');
  assert.equal(quizResultText({ finished: true, n_correct: 1, n_items: 1 }), 'Recognition check: 1 of 1 right');
  assert.equal(quizResultText({ finished: false, n_items: 3 }), null);
  assert.equal(keyStep({ key: 'ArrowRight' }), 1);
  assert.equal(keyStep({ key: 'ArrowLeft' }), -1);
  assert.equal(keyStep({ key: 'ArrowLeft', shiftKey: true }), 0);
  assert.equal(keyStep({ key: 'n' }), 0);
});

test('once every stage is done, the path says how the assessment went, and finished stages can be looked at again', () => {
  const stages = (result) => [{ key: 'tour', status: 'completed' }, { key: 'assessment', status: 'completed', result }];
  assert.deepEqual(pathOutcome({ next: { text: 'Next: x.' }, stages: [] }), { state: 'next', text: 'Next: x.' });
  assert.deepEqual(pathOutcome({ stages: stages('met'), gate: { open: true } }), { state: 'passed', text: PASSED_TEXT });
  assert.equal(PASSED_TEXT, 'You passed: your study recordings are now open.');
  assert.deepEqual(pathOutcome({ stages: stages('not_met'), gate: { open: false, result: 'not_met' } }), { state: 'waiting', text: NOT_MET_TEXT });
  assert.equal(NOT_MET_TEXT, 'Assessment not met: waiting for your study team.');
  assert.deepEqual(pathOutcome({ stages: stages('not_determined'), gate: { open: false, result: 'not_determined' } }), { state: 'waiting', text: TO_COME_TEXT });
  assert.equal(pathOutcome({ stages: stages('not_met'), gate: { open: true }, message: 'Done.' }).state, 'complete');
  assert.ok(canLookAgain({ key: 'tour', status: 'completed' }) && canLookAgain({ key: 'snippets', status: 'completed' }));
  assert.ok(!canLookAgain({ key: 'snippets', status: 'completed', carried: true }) && !canLookAgain({ key: 'guided', status: 'completed' }));
});

test('the snippets stage says what it holds', () => {
  assert.equal(snippetsDetail(3, true, true), "3 examples of the experts' artifacts, with their notes, then a quick recognition check. To finish this stage, also finish the recognition check.");
  assert.equal(snippetsDetail(1, false, true), "1 example of the experts' artifacts, with their notes.");
  assert.equal(stageStates(base({ nSnippets: 0 }))[1].status, 'not_used');
});

// ---------------------------------------------------------------- the path's words
test('the path names each stage\'s state, and the skip question says what is skipped', () => {
  const [tour, snippets, guided, practice] = stageStates(base({ events: [ev('stage_skipped', 'tour')] }));
  assert.deepEqual(stageChip(tour), ['Skipped', 'skipped']);
  assert.deepEqual(stageChip(snippets), ['Ready', 'active']);
  assert.deepEqual(stageChip({ key: 'assessment', status: 'completed', result: 'not_met' }), ['Criteria not met yet', '']);
  assert.equal(detailText(guided), LOCKED_TEXT);
  assert.equal(detailText(tour), SKIPPED_TEXT);
  assert.equal(countText(tour), '');
  assert.equal(countText({ ...practice, done: 1 }), '1 of 1 practice recording tried');
  assert.match(skipQuestion(snippets), /^Short examples of each type of artifact.*\n\nYou can do it after all at any time, from this page\. The study notes that you skipped it\.$/s);
  assert.equal(COMPLETE_TEXT, 'You have completed every stage of this training programme.');
});

test('other parts of the training add to a stage\'s card through the path\'s registries, without the path knowing them', () => {
  assert.deepEqual(Object.keys(STAGE_LINES), STAGES);
  // the replay part's "Watch an expert at work" (js/replay/watch.js) and the crowd of a training recording
  // (js/expert/crowd_entry.js), shown only to trainees the study lets watch or see the crowd
  assert.equal(WATCH_EXPERT.length, 2);
  const expert = { me: { roles: ['expert'], study: { replay: { enabled: true, trainees_watch_experts: true, trainees_see_crowd: true } } } };
  for (const entry of WATCH_EXPERT) {
    assert.equal(entry(expert, {}, {}), null);
    assert.equal(entry(null, {}, {}), null);
  }
});

// ---------------------------------------------------------------- the snippets
test('the gallery groups the snippets by family and type, in the catalogue\'s order', () => {
  const cat = new Catalogue(CATALOGUE);
  const snippets = [
    { snippet_id: 'a', label: 'EMG-artifact', start_s: 1, end_s: 2, channels: ['T7', 'T8'] },
    { snippet_id: 'b', label: 'Eye-blink-artifact', start_s: 3, end_s: 3.4, channels: [] },
    { snippet_id: 'c', label: 'Eye-blink-artifact', start_s: 5, end_s: 5.4, channels: ['Fp1'] },
    { snippet_id: 'd', label: 'Not-a-type', start_s: 0, end_s: 1, channels: [] },
  ];
  const groups = groupSnippets(snippets, cat);
  assert.deepEqual(groups.map((g) => [g.section, g.types.map((t) => [t.label, t.items])]), [
    ['Eye', [['Eye-blink-artifact', [1, 2]]]], ['Other biological', [['EMG-artifact', [0]]]], ['Other', [['Not-a-type', [3]]]]]);
  assert.deepEqual(galleryOrder(groups), [1, 2, 0, 3]);
  assert.equal(whereText(snippets[0]), '1.00 s on T7 and T8, at 1.00 s in the recording');
  assert.equal(whereText(snippets[1]), '0.40 s on every channel, at 3.00 s in the recording');
});

test('the sandbox: skipping, finishing and resuming are kept as events, sent twice changes nothing more', async () => {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login('T01', 'demo');
  const once = await b.trainingStage({ stage: 'tour', action: 'skip' });
  assert.deepEqual(await b.trainingStage({ stage: 'tour', action: 'skip' }), once);
  await assert.rejects(() => b.trainingStage({ stage: 'guided', action: 'skip' }), (e) => e.status === 409 && e.code === 'locked');
  await assert.rejects(() => b.trainingStage({ stage: 'guided', action: 'done' }), (e) => e.code === 'not_done_here');
  const done = await b.trainingStage({ stage: 'snippets', action: 'done' });
  assert.deepEqual(done.stages.map((s) => s.status), ['skipped', 'completed', 'available', 'locked', 'not_used']);
  assert.equal(done.next.recording_id, TRAINING_SET.guided[0].rid);
  assert.deepEqual(b.state.progress.T01.events.map((e) => [e.event, e.stage]), [['stage_skipped', 'tour'], ['stage_completed', 'snippets']]);
  assert.deepEqual((await b.me()).training_gate, { open: true, reason: '', message: '', result: '' }); // the sandbox's set has no assessment
  // the study asks for the recognition check before the snippets count as done
  const admin = new DemoBackend({ storage: memory(), tokens: memory() });
  await admin.login('ADMIN', 'demo');
  await admin.admin('settings_update', { settings: { training: { snippets_quiz_required: true, skippable: ['snippets'] } } });
  await admin.login('T01', 'demo');
  await assert.rejects(() => admin.trainingStage({ stage: 'tour', action: 'skip' }), (e) => e.code === 'cannot_skip');
  await admin.trainingStage({ stage: 'tour', action: 'done' });
  await assert.rejects(() => admin.trainingStage({ stage: 'snippets', action: 'done' }), (e) => e.code === 'quiz_required');
  const sn = await admin.trainingSnippets();
  assert.equal(sn.snippets.length, 12);
  assert.deepEqual(sn.quiz, { n_items: 7, finished: false, required: true, n_correct: null });
  assert.ok(sn.snippets.every((s) => s.recording_id !== TRAINING_SET.practice[0]));
});

// ---------------------------------------------------------------- the admin area
test('the admin area\'s snippets: the next ID, and the channels typed checked against the recording\'s', () => {
  assert.equal(nextSnippetId([]), 's01');
  assert.equal(nextSnippetId([{ snippet_id: 's01' }, { snippet_id: 's03' }]), 's02');
  assert.deepEqual(parseChannels('t7, T8;T7', ['Fp1', 'T7', 'T8']), { channels: ['T7', 'T8'] });
  assert.deepEqual(parseChannels('', ['Fp1']), { channels: [] });
  assert.deepEqual(parseChannels('Cz', ['Fp1']), { problem: 'Cz is not a channel of this recording.' });
  assert.match(eventText({ event: 'stage_skipped', stage: 'tour', at: '2026-10-30T10:15:00+00:00' }), /^Find your way around skipped, /);
  assert.match(eventText({ event: 'training_reopened', from: 'practice', by: 'ADMIN', at: '2026-10-30T10:15:00+00:00' }),
    /^Training reopened \(from On your own\) by ADMIN, /);
  // a skip carried over from an earlier set names it; an earlier round says how it ended
  assert.match(eventText({ event: 'stage_skipped', stage: 'guided', set_name: 'Pilot set', at: '2026-10-30T10:15:00+00:00' }),
    /^Learn with the experts skipped in Pilot set, /);
  assert.match(roundLine({ round: 1, set_name: 'Pilot set', status: 'not_met', at: '2026-10-30T10:15:00+00:00' }), /^Round 1, Pilot set: not met, /);
  // a trainee's path in a line (Results, Progress): skips named; a locked study recording counts as one to do
  const stages = stageStates(base({ events: [ev('stage_skipped', 'tour'), ev('stage_skipped', 'snippets'), ev('stage_skipped', 'guided')] }));
  assert.equal(programmeText({ stages }), 'Tour skipped · Snippets skipped · Guided 0 of 2 (skipped) · Practice 0 of 1 · Assessment 0 of 1 (locked)');
  assert.deepEqual(progressCounts([{ status: 'locked' }, { status: 'done' }]), { assigned: 2, done: 1, in_progress: 0, todo: 1, unusable: 0 });
});
