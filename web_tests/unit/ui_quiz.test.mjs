// The short-segment quiz: the helpers of js/training/quiz.js, the demonstration's quiz (in
// js/api/demo.js), and the quiz(setId, body) calls of the study server and Firebase backends.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), keys: () => [...m.keys()] };
};
globalThis.sessionStorage = store();
globalThis.localStorage = store();

const { groupOptions, nextIndex, scoreText, feedbackText, segmentBounds, segmentRecording, verdictText, quizMode, NONE_OPTION, QUESTION } =
  await import('../../electrotag/web/static/js/training/quiz.js');
const { DemoBackend, QUIZ, QUIZ_NONE_OPTION, quizOrder, quizScore, exampleRecording } = await import('../../electrotag/web/static/js/api/demo.js');
const { Catalogue } = await import('../../electrotag/web/static/js/catalogue.js');
const { CATALOGUE } = await import('../../electrotag/web/static/js/api/demo_catalogue.js');
const { HttpBackend } = await import('../../electrotag/web/static/js/api/http.js');
const { FirebaseBackend } = await import('../../electrotag/web/static/js/api/firebase.js');

const memory = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)), remove: (k) => m.delete(k) };
};

test('the desktop\'s question and "none" answer', () => {
  assert.equal(QUESTION, 'Which artifact type is the main one in the shaded segment?');
  assert.equal(NONE_OPTION, 'No artifact / none of these');
  assert.equal(QUIZ_NONE_OPTION, NONE_OPTION);
  assert.equal(quizMode('immediate'), 'practice');
  assert.equal(quizMode('end'), 'assessment');
});

test('the next item is the first one not answered', () => {
  const items = [{ item_id: 'b' }, { item_id: 'a' }, { item_id: 'c' }];
  assert.equal(nextIndex(items, {}), 0);
  assert.equal(nextIndex(items, { b: { label: 'x' } }), 1);
  assert.equal(nextIndex(items, { b: {}, c: {} }), 1);
  assert.equal(nextIndex(items, { a: {}, b: {}, c: {} }), 3);
});

test('a segment and its context are cut as the desktop cuts them', () => {
  // 2 s of context on both sides, within the recording; Python's round() at the edges
  assert.deepEqual(segmentBounds({ start_s: 9.2, end_s: 10.8, context_s: 2 }, 250, 250 * 70), { s0: 1800, s1: 3200, h0: 500, h1: 900 });
  assert.deepEqual(segmentBounds({ start_s: 1.0, end_s: 1.5, context_s: 2 }, 100, 1000), { s0: 0, s1: 350, h0: 100, h1: 150 });
  assert.deepEqual(segmentBounds({ start_s: 8.5, end_s: 9.9, context_s: 2 }, 100, 1000), { s0: 650, s1: 1000, h0: 200, h1: 340 });
  assert.equal(segmentBounds({ start_s: 0.0125, end_s: 0.5 }, 200, 400).s0, 0); // context defaults to 2 s
});

test('answers under their family headings, group terms marked, "none" under Other', () => {
  const cat = new Catalogue(CATALOGUE);
  const groups = groupOptions(['Eye-blink-artifact', 'Eye-artifact', 'EMG-artifact', 'Data-artifact', NONE_OPTION], cat);
  assert.deepEqual(groups.map((g) => g.heading), ['Eye', 'Other biological', 'Type unknown', 'Other']);
  assert.equal(groups[0].options[1].text, 'Eye-artifact  (group: exact type unclear)');
  assert.equal(groups[0].options[1].group, true);
  assert.equal(groups[0].options[0].colour, cat.colourFor('Eye-blink-artifact'));
  assert.equal(groups[3].options[0].colour, null);
  assert.match(groups[3].options[0].description, /no artifact/);
});

test('a segment of a recording is a recording of its own', async () => {
  const calls = [];
  const rec = {
    format: 'edf', fileName: 'x.edf', sfreq: 100, nSamples: 1000, channels: [{ name: 'Cz' }],
    async readWindow(req) {
      calls.push(req);
      return { startSample: req.startSample, nSamples: req.nSamples, data: [new Float32Array(req.nSamples)], edgeZones: [[req.startSample, req.startSample + 5]] };
    },
  };
  const seg = segmentRecording(rec, 300, 500);
  assert.equal(seg.nSamples, 200);
  assert.equal(seg.durationS, 2);
  const r = await seg.readWindow({ startSample: 150, nSamples: 400, channels: [0], filters: null });
  assert.deepEqual([calls[0].startSample, calls[0].nSamples], [450, 50], 'never past the end of the segment');
  assert.equal(r.startSample, 150);
  assert.deepEqual(r.edgeZones, [[150, 155]]);
});

test('feedback and score in the desktop\'s words', () => {
  assert.equal(verdictText({ correct: true }), 'Correct.');
  assert.equal(verdictText({ correct: false, correct_label: 'EMG-artifact' }), 'Not quite: the expected answer is EMG-artifact.');
  assert.equal(scoreText({ n_items: 6, n_correct: 4, proportion_correct: 4 / 6 }), 'You answered 4 of 6 segments correctly (67%).');
  assert.equal(scoreText({ n_items: 6, n_answered: 6, n_correct: 4, proportion_correct: 4 / 6 }), 'You answered 4 of 6 segments correctly (67%).');
  assert.equal(scoreText({ n_items: 0, n_correct: 0, proportion_correct: null }), 'You answered 0 of 0 segments correctly.');
  // an incomplete result: the proportion is of the segments answered, as QuizSession.score()
  assert.equal(scoreText({ n_items: 7, n_answered: 5, n_correct: 4, proportion_correct: 0.8 }),
    'You answered 4 of 5 segments correctly (80%). 2 of the 7 segments were not answered.');
  assert.equal(scoreText({ n_items: 7, n_answered: 6, n_correct: 6, proportion_correct: 1 }),
    'You answered 6 of 6 segments correctly (100%). 1 of the 7 segments was not answered.');
  assert.equal(scoreText({ n_items: 3, n_answered: 0, n_correct: 0, proportion_correct: null }),
    'You answered 0 of 0 segments correctly. 3 of the 3 segments were not answered.');
  assert.equal(feedbackText('immediate'), 'whether each answer is right, straight away');
  assert.equal(feedbackText('end'), 'your result at the end');
  assert.equal(feedbackText(undefined), '');
});

test('the demonstration\'s quiz: listed in /me, items in each annotator\'s own order, manifests with fingerprints', async () => {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login('A01', 'demo');
  const me = await b.me();
  assert.deepEqual(me.quizzes, [{ set_id: 'example', name: 'Demonstration quiz', n_items: QUIZ.items.length, n_answered: 0, finished: false, feedback: 'immediate' }]);
  const q = await b.quiz('example', { action: 'get' });
  assert.equal(q.feedback, 'immediate');
  assert.equal(q.finished, false);
  assert.equal(q.score, null);
  assert.equal(q.n_items, QUIZ.items.length);
  assert.deepEqual(q.answered, {});
  assert.deepEqual(q.items.map((i) => i.item_id), quizOrder(QUIZ.items, 'A01', 'example').map((i) => i.item_id));
  assert.notDeepEqual(quizOrder(QUIZ.items, 'A01', 'example').map((i) => i.item_id), quizOrder(QUIZ.items, 'T01', 'example').map((i) => i.item_id));
  assert.deepEqual(quizOrder(QUIZ.items, 'A01', 'example'), quizOrder([...QUIZ.items].reverse(), 'A01', 'example'), 'the same at every visit');
  for (const it of q.items) {
    assert.deepEqual(Object.keys(it).sort(), ['context_s', 'end_s', 'file_name', 'item_id', 'options', 'recording_id', 'start_s'], 'the answers stay with the study');
    assert.ok(it.options.includes(NONE_OPTION) && it.options.includes('Eye-blink-artifact'));
    assert.match(it.file_name, /_eeg\.edf$/);
  }
  const rids = Object.keys(q.recordings);
  assert.equal(rids.length, 2);
  for (const rid of rids) {
    const fp = await exampleRecording(rid).fingerprint();
    assert.equal(q.recordings[rid].fingerprint.hex, fp.hex);
    assert.equal(q.recordings[rid].fingerprint.size_bytes, fp.sizeBytes);
  }
  // the study server's errors (electrotag/web/quiz.py)
  const code = (status, c) => (e) => e.status === status && e.code === c;
  await assert.rejects(() => b.quiz('other', { action: 'get' }), code(404, 'no_reference_set'));
  await assert.rejects(() => b.quiz('example', { action: 'guess' }), code(400, 'bad_request'));
  await assert.rejects(() => b.quiz('example', { action: 'answer', item_id: 'q99', label: 'EMG-artifact' }), code(404, 'unknown_item'));
  await assert.rejects(() => b.quiz('example', { action: 'answer', item_id: 'q01', label: 'Not a label' }), code(400, 'bad_label'));
  await assert.rejects(() => b.quiz('example', { action: 'answer', item_id: 'q01', label: 'EMG-artifact', response_time_s: -1 }), code(400, 'bad_request'));
  await assert.rejects(() => b.quiz('example', { action: 'answer', item_id: 'q01', label: 'EMG-artifact', response_time_s: '2' }), code(400, 'bad_request'));
});

test('the demonstration\'s quiz: answers with feedback, the same answer kept once, the score, then finished', async () => {
  const storage = memory();
  const b = new DemoBackend({ storage, tokens: memory() });
  await b.login('T01', 'demo');
  const q = await b.quiz('example', { action: 'get' });
  const truth = new Map(QUIZ.items.map((i) => [i.item_id, i]));
  const n = QUIZ.items.length;
  const [first, second, third] = q.items;
  const a1 = await b.quiz('example', { action: 'answer', item_id: first.item_id, label: truth.get(first.item_id).correct_label, response_time_s: 2.34567 });
  assert.deepEqual(a1, { correct: true, correct_label: truth.get(first.item_id).correct_label, explanation: truth.get(first.item_id).explanation, n_answered: 1, n_items: n });
  // the same answer sent again (a key pressed twice, a reply lost) gives the same answer and is kept once
  assert.deepEqual(await b.quiz('example', { action: 'answer', item_id: first.item_id, label: truth.get(first.item_id).correct_label }), a1);
  const wrong = truth.get(second.item_id).correct_label === 'Chewing-artifact' ? 'EMG-artifact' : 'Chewing-artifact';
  const a2 = await b.quiz('example', { action: 'answer', item_id: second.item_id, label: wrong });
  assert.equal(a2.correct, false);
  assert.equal(a2.n_answered, 2);
  // another label for an answered segment: 409 with the label kept
  const other = truth.get(first.item_id).correct_label === 'EMG-artifact' ? 'Chewing-artifact' : 'EMG-artifact';
  await assert.rejects(() => b.quiz('example', { action: 'answer', item_id: first.item_id, label: other }),
    (e) => e.status === 409 && e.code === 'already_answered' && e.body.label === truth.get(first.item_id).correct_label);
  // a group term the item accepts
  const blink = QUIZ.items.find((i) => i.correct_label === 'Eye-blink-artifact');
  if (blink.item_id !== first.item_id && blink.item_id !== second.item_id) {
    assert.equal((await b.quiz('example', { action: 'answer', item_id: blink.item_id, label: 'Eye-artifact' })).correct, true);
  }
  // another visit (a reload) carries on from the answers kept, with what may be shown
  const again = new DemoBackend({ storage, tokens: memory() });
  await again.login('T01', 'demo');
  const resumed = await again.quiz('example', { action: 'get' });
  const t1 = truth.get(first.item_id);
  assert.deepEqual(resumed.answered[first.item_id], { label: t1.correct_label, correct: true, correct_label: t1.correct_label, explanation: t1.explanation });
  assert.equal(resumed.answered[second.item_id].correct, false);
  assert.equal(resumed.answered[second.item_id].label, wrong);
  // finishing before every segment is answered saves an incomplete result
  const answered = Object.keys(resumed.answered).length;
  assert.ok(answered < n);
  const { score } = await again.quiz('example', { action: 'finish' });
  assert.equal(score.n_items, n);
  assert.equal(score.n_answered, answered);
  assert.equal(score.n_correct, answered - 1);
  assert.equal(score.by_category[truth.get(second.item_id).correct_label].correct, 0);
  assert.equal(score.confusion[truth.get(second.item_id).correct_label][wrong], 1);
  assert.equal((await again.me()).quizzes[0].finished, true);
  const done = await again.quiz('example', { action: 'get' });
  assert.equal(done.finished, true);
  assert.deepEqual(done.score, score);
  await assert.rejects(() => again.quiz('example', { action: 'answer', item_id: third.item_id, label: 'EMG-artifact' }), (e) => e.status === 409 && e.code === 'finished');
  assert.deepEqual((await again.quiz('example', { action: 'finish' })).score, score, 'finishing again changes nothing');
  const doc = again.resultsDocument();
  assert.equal(doc.quiz_results.length, 1);
  assert.equal(doc.quiz_results[0].finished, true);
  assert.equal(doc.quiz_results[0].completed, false, 'not every segment was answered');
  assert.equal(doc.quiz_results[0].answers.length, answered);
  assert.equal(doc.quiz_results[0].answers[0].item_id, first.item_id, 'in the order answered');
  assert.equal(doc.quiz_results[0].answers[0].response_time_s, 2.346);
  assert.equal(doc.quiz_results[0].answers[1].response_time_s, null);
});

test('the demonstration\'s quiz with every segment answered is complete', async () => {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login('A01', 'demo');
  const q = await b.quiz('example', { action: 'get' });
  for (const it of q.items) await b.quiz('example', { action: 'answer', item_id: it.item_id, label: QUIZ.items.find((x) => x.item_id === it.item_id).correct_label });
  const { score } = await b.quiz('example', { action: 'finish' });
  assert.equal(score.n_correct, QUIZ.items.length);
  assert.equal(score.proportion_correct, 1);
  assert.equal(b.resultsDocument().quiz_results[0].completed, true);
});

test('QuizSession.score(): proportion, categories and confusion', () => {
  const items = [{ item_id: 'a', correct_label: 'X' }, { item_id: 'b', correct_label: 'X' }, { item_id: 'c', correct_label: 'Y' }];
  const s = quizScore(items, { a: { label: 'X', correct: true }, b: { label: 'Y', correct: false } });
  assert.deepEqual(s, {
    n_items: 3, n_answered: 2, n_correct: 1, proportion_correct: 0.5,
    by_category: { X: { items: 2, correct: 1 } }, confusion: { X: { X: 1, Y: 1 } },
  });
  assert.equal(quizScore(items, {}).proportion_correct, null);
});

let calls = [];
beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, ...init, headers: init.headers || {} });
    return { ok: true, status: 200, text: async () => JSON.stringify({ correct: null }) };
  };
});

test('the study server: POST /quiz/{set_id} with the body as it is', async () => {
  const b = new HttpBackend('https://s.org');
  b.token = 'T';
  await b.quiz('pilot set', { action: 'answer', item_id: 'q1', label: 'EMG-artifact' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://s.org/api/v1/quiz/pilot%20set');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { action: 'answer', item_id: 'q1', label: 'EMG-artifact' });
  assert.equal(calls[0].headers.Authorization, 'Bearer T');
});

test('Firebase: et_quiz with the set and the body; only "get" is asked a second time', async () => {
  const seen = [];
  let fail = 0;
  const sdk = {
    app: { initializeApp: () => ({}) },
    auth: { getAuth: () => ({ currentUser: null, authStateReady: async () => {} }) },
    functions: {
      getFunctions: (app, region) => ({ region }),
      httpsCallable: (fns, name) => async (data) => {
        seen.push({ name, data });
        if (fail > 0) {
          fail -= 1;
          const e = new Error('unavailable');
          e.code = 'functions/unavailable';
          throw e;
        }
        return { data: { ok: true } };
      },
    },
  };
  const b = await FirebaseBackend.create({ config: { projectId: 'p' }, study: 'pilot', sdk });
  b.retryDelayMs = 1;
  fail = 1;
  assert.deepEqual(await b.quiz('example', { action: 'get' }), { ok: true });
  assert.deepEqual(seen.map((s) => s.name), ['et_quiz', 'et_quiz']);
  assert.deepEqual(seen[0].data, { study: 'pilot', set_id: 'example', action: 'get' });
  seen.length = 0;
  for (const body of [{ action: 'answer', item_id: 'q1', label: 'EMG-artifact' }, { action: 'finish' }]) {
    fail = 1;
    await assert.rejects(() => b.quiz('example', body), (e) => e.code === 'network');
  }
  assert.deepEqual(seen.map((s) => s.data.action), ['answer', 'finish'], 'an answer or a finish is never repeated');
});

test('the quiz card says how far a stopped quiz went, and a finished one opens on its result', async () => {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login('A01', 'demo');
  const q = await b.quiz('example', { action: 'get' });
  await b.quiz('example', { action: 'answer', item_id: q.items[0].item_id, label: 'EMG-artifact' });
  await b.quiz('example', { action: 'answer', item_id: q.items[1].item_id, label: 'EMG-artifact' });
  assert.equal((await b.me()).quizzes[0].n_answered, 2, 'GET /me counts the answers of a stopped quiz');
  await b.quiz('example', { action: 'finish' });
  const me = await b.me();
  assert.equal(me.quizzes[0].finished, true);
});
