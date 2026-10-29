// Problem reports and reviews of saved work on the three backends: the demonstration's own
// (demo_feedback.js, as electrotag/web/feedback.py), the study server's routes (http.js) and the
// Firebase functions (firebase.js), where only the read may be asked again after a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
globalThis.sessionStorage = globalThis.sessionStorage || store();
globalThis.localStorage = globalThis.localStorage || store();

const { DemoBackend } = await import('../../electrotag/web/static/js/api/demo.js');
const { countText, reviewCounts } = await import('../../electrotag/web/static/js/api/demo_feedback.js');
const { HttpBackend } = await import('../../electrotag/web/static/js/api/http.js');
const { FirebaseBackend } = await import('../../electrotag/web/static/js/api/firebase.js');
const { visibleItems } = await import('../../electrotag/web/static/js/views/home_list.js');
const { progressSummary } = await import('../../electrotag/web/static/js/views/progress.js');

const memory = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)), remove: (k) => m.delete(k) };
};

async function demo(id = 'A01') {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login(id, 'demo');
  return b;
}

async function as(b, id) {
  await b.logout();
  await b.login(id, 'demo');
  return b;
}

const hex = (n) => n.toString(16).padStart(32, '0');
const ann = (id, label, onset, dur) => ({ annotation_id: id.padEnd(32, '0'), label, onset_sample: onset, duration_samples: dur, channels: [],
  created_at: '2026-10-28T10:00:00.000+00:00', modified_at: '2026-10-28T10:00:00.000+00:00' });

async function matchBody(b, rid) {
  const rec = b.exampleRecording(rid);
  const fp = await rec.fingerprint();
  return { file_name: rec.fileName, size_bytes: rec.sizeBytes, sha256: fp.hex, sfreq: rec.sfreq, n_samples: rec.nSamples, ch_names: rec.channels.map((c) => c.name) };
}

test('the words of a review summary', () => {
  assert.equal(countText({ caveat: 2, comment: 1 }), '2 caveats, 1 comment');
  assert.equal(countText({ agree: 1 }), '1 agreement');
  assert.equal(countText({}), 'no marks');
  assert.deepEqual(reviewCounts([{ status: 'agree', annotation_id: 'a' }, { status: 'comment', annotation_id: null }]), { agree: 1, caveat: 0, comment: 1, missed: 1 });
});

test('demonstration: a report is kept once, and "cannot be annotated" sets the recording aside', async () => {
  const b = await demo('A01');
  const { items } = await b.assignments();
  const rid = items[0].recording_id;
  const body = { problem_id: hex(1), recording_id: rid, mode: 'standard', context_id: '', reason: 'bad_channels', note: 'Flat', outcome: 'unusable', where: 'home' };
  assert.equal((await b.reportProblem(body)).already, false);
  assert.equal((await b.reportProblem(body)).already, true);
  const after = await b.assignments();
  const it = after.items.find((i) => i.recording_id === rid);
  assert.equal(it.status, 'unusable');
  assert.equal(it.problem.reason, 'bad_channels');
  assert.notEqual(after.next, rid);
  const m = await b.match(await matchBody(b, rid));
  assert.equal(m.status, 'unusable');
  await assert.rejects(() => b.putDraft(rid, 'standard', '', { annotations: [], elapsed_s: 1 }), (e) => e.code === 'unusable');
  await assert.rejects(() => b.submit({ recording_id: rid, mode: 'standard', context_id: '', annotations: [], sha256: 'f'.repeat(64) }), (e) => e.code === 'unusable');
  await assert.rejects(() => b.reportProblem({ ...body, problem_id: 'x' }), (e) => e.status === 400);
  await assert.rejects(() => b.reportProblem({ ...body, problem_id: hex(2), note: 'x'.repeat(301) }), (e) => e.status === 400);
  // the home page: finished for the annotator, kept apart from done
  assert.equal(visibleItems(after.items, { tab: 'todo' }).some((i) => i.recording_id === rid), false);
  assert.equal(visibleItems(after.items, { tab: 'done' }).some((i) => i.recording_id === rid), true);
  const p = progressSummary(after.items, { next: null });
  assert.equal(p.finished, 1);
  assert.equal(p.unusable, 1);
  assert.equal(p.done, 0);
  assert.equal(p.left, after.items.length - 1);
  // the admin area
  await as(b, 'ADMIN');
  const list = await b.admin('problems_list', {});
  assert.deepEqual(list.counts, { open: 1, resolved: 0, unusable: 1 });
  assert.equal(list.problems[0].unusable_now, true);
  const o = await b.admin('overview', {});
  assert.equal(o.counts.unusable, 1);
  assert.equal(o.counts.problems_open, 1);
  const st = await b.admin('stats', {});
  assert.equal(st.totals.unusable, 1);
  assert.equal(st.totals.done, 0);
  assert.equal(st.totals.remaining, st.totals.assigned - 1);
  await b.admin('problem_return', { problem_id: hex(1), note: 'Replaced the file' });
  await assert.rejects(() => b.admin('problem_return', { problem_id: hex(1) }), (e) => e.code === 'not_unusable');
  await assert.rejects(() => b.admin('problem_resolve', { problem_id: hex(1) }), (e) => e.code === 'already_resolved');
  const audit = await b.admin('audit', {});
  const reported = audit.entries.find((e) => e.op === 'problem_report');
  assert.equal(reported.details.note_length, 4);
  assert.equal('note' in reported.details, false);
  await as(b, 'A01');
  const back = (await b.assignments()).items.find((i) => i.recording_id === rid);
  assert.equal(back.status, 'todo');
  assert.equal(back.problem.resolution, 'returned');
  assert.equal(back.problem.resolution_note, 'Replaced the file');
});

test('demonstration: a review of a saved recording, seen by its annotator unless reviews are blind', async () => {
  const b = await demo('A01');
  const rid = (await b.assignments()).items[0].recording_id;
  const blink = ann('b1', 'Eye-blink-artifact', 500, 50);
  const emg = ann('e1', 'EMG-artifact', 2000, 200);
  await b.submit({ recording_id: rid, mode: 'standard', context_id: '', annotations: [blink, emg], session: { elapsed_s: 30 }, sha256: 'f'.repeat(64) });
  await as(b, 'ADMIN');
  const got = await b.admin('saved_attempt_get', { annotator_id: 'A01', recording_id: rid });
  assert.equal(got.attempt, 1);
  assert.equal(got.annotations.length, 2);
  assert.ok(got.manifest.fingerprint && got.manifest.fingerprint.hex);
  const body = { review_id: hex(9), annotator_id: 'A01', recording_id: rid, attempt: 1, overall_note: 'Good',
    items: [{ annotation_id: blink.annotation_id, status: 'caveat', note: 'Early' }, { annotation_id: emg.annotation_id, status: 'agree' },
      { annotation_id: null, onset_sample: 4000, duration_samples: 100, status: 'comment' }] };
  const saved = await b.admin('review_save', body);
  assert.equal(saved.already, false);
  assert.equal(saved.review.summary, '1 caveat, 1 comment, 1 agreement');
  assert.equal(saved.review.items[2].note, 'missed artifact?');
  assert.equal((await b.admin('review_save', body)).already, true);
  await assert.rejects(() => b.admin('review_save', { ...body, review_id: hex(10), attempt: 2 }), (e) => e.code === 'not_latest');
  await assert.rejects(() => b.admin('review_save', { ...body, review_id: hex(10), items: [], overall_note: '' }), (e) => e.code === 'empty_review');
  await assert.rejects(() => b.admin('review_save', { ...body, review_id: hex(10), items: [{ annotation_id: 'nope', status: 'agree' }] }), (e) => e.code === 'unknown_annotation');
  assert.equal((await b.admin('reviews_list', { annotator_id: 'A01' })).reviews.length, 1);
  assert.equal((await b.admin('overview', {})).counts.reviewed, 1);
  await as(b, 'A01');
  const mine = await b.myReviews();
  assert.equal(mine.shown, true);
  assert.equal(mine.reviews[0].summary, '1 caveat, 1 comment, 1 agreement');
  await as(b, 'ADMIN');
  await b.admin('settings_update', { settings: { annotation: { show_reviews_to_annotators: false } } });
  await as(b, 'A01');
  assert.deepEqual(await b.myReviews(), { shown: false, reviews: [] });
  assert.equal((await b.me()).study.annotation.show_reviews_to_annotators, false);
  await as(b, 'ADMIN');
  await b.admin('settings_update', { settings: { annotation: { allow_reviews: false } } });
  await assert.rejects(() => b.admin('review_save', { ...body, review_id: hex(11) }), (e) => e.code === 'reviews_off');
  await assert.rejects(() => b.admin('settings_update', { settings: { annotation: { allow_reviews: 'yes' } } }), (e) => e.status === 400);
});

test('study server: POST /problems and GET /me/reviews', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, ...init });
    return { ok: true, status: 200, text: async () => JSON.stringify(url.endsWith('/me/reviews') ? { shown: true, reviews: [] } : { already: false }) };
  };
  const b = new HttpBackend('https://s.org');
  b._setToken('T');
  await b.reportProblem({ problem_id: hex(1), recording_id: 'r', reason: 'other' });
  assert.equal(calls[0].url, 'https://s.org/api/v1/problems');
  assert.equal(calls[0].method, 'POST');
  assert.equal(JSON.parse(calls[0].body).problem_id, hex(1));
  assert.deepEqual(await b.myReviews(), { shown: true, reviews: [] });
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].url, 'https://s.org/api/v1/me/reviews');
  await b.admin('review_save', { review_id: hex(2) });
  assert.equal(calls[2].url, 'https://s.org/api/v1/admin/review_save');
});

test('Firebase: a report and a review are never asked twice; the reviews and the lists are reads', async () => {
  const calls = [];
  const seen = {}; // each function (and admin operation) fails the first time it is called
  const sdk = {
    app: { initializeApp: () => ({}) },
    auth: { getAuth: () => ({ currentUser: null, authStateReady: async () => {} }) },
    functions: {
      getFunctions: (app, region) => ({ region }),
      httpsCallable: (fns, name) => async (data) => {
        calls.push({ name, data });
        const key = `${name}:${data.op || ''}`;
        seen[key] = (seen[key] || 0) + 1;
        if (seen[key] === 1) { const e = new Error('unavailable'); e.code = 'functions/unavailable'; throw e; }
        return { data: { ok: true } };
      },
    },
  };
  const b = await FirebaseBackend.create({ config: {}, study: 's', sdk });
  b.retryDelayMs = 1;
  await assert.rejects(() => b.reportProblem({ problem_id: hex(1) }), (e) => e.code === 'network');
  assert.equal(calls.filter((c) => c.name === 'et_problem_report').length, 1);
  assert.deepEqual(await b.myReviews(), { ok: true });
  assert.equal(calls.filter((c) => c.name === 'et_my_reviews').length, 2);
  await assert.rejects(() => b.admin('review_save', { review_id: hex(2) }), (e) => e.code === 'network');
  assert.equal(calls.filter((c) => c.data.op === 'review_save').length, 1);
  await assert.rejects(() => b.admin('problem_resolve', { problem_id: hex(1) }), (e) => e.code === 'network');
  assert.equal(calls.filter((c) => c.data.op === 'problem_resolve').length, 1);
  for (const op of ['problems_list', 'reviews_list', 'saved_attempt_get']) {
    await b.admin(op, {});
    assert.equal(calls.filter((c) => c.data.op === op).length, 2, op);
  }
});
