// Drafts of unfinished work (js/annotate/session.js): work discarded with Start afresh, Discard and
// close or Leave without changes is set aside in the browser tab and can be brought back, with its
// time worked and the parts it had viewed; a draft that does not reach the study is noted (the
// annotation view then says "Draft kept in this browser only") and tried again soon, as a draft
// replaces the one before; Save and Finish forgets what was set aside.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { AnnotationSession, discardedWork } = await import('../../electrotag/web/static/js/annotate/session.js');
const { Catalogue } = await import('../../electrotag/web/static/js/catalogue.js');
const { CATALOGUE } = await import('../../electrotag/web/static/js/api/demo_catalogue.js');

// What Save and Finish reads of the browser window.
globalThis.screen ??= { width: 1440, height: 900 };
globalThis.window ??= { innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1 };

const recording = (name = 'sub-01_task-rest_eeg.edf') => ({
  fileName: name, sfreq: 250, nSamples: 250 * 60, durationS: 60, format: 'edf', markers: [], warnings: [], gaps: [],
  channels: ['Fp1', 'Fp2', 'C3', 'C4'].map((n) => ({ name: n, type: 'eeg' })),
});

function fakeBackend() {
  const b = { kind: 'server', server: 'http://study', drafts: [], deleted: 0, fail: false };
  b.putDraft = async (rid, mode, ctx, draft) => { if (b.fail) { const e = new Error('Failed to fetch'); e.status = 0; throw e; } b.drafts.push(draft); return { saved_at: 'now' }; };
  b.deleteDraft = async () => { b.deleted += 1; return {}; };
  b.submit = async () => ({ saved: true, files: [] });
  return b;
}

function session(backend, name) {
  return new AnnotationSession({ backend, recording: recording(name), manifest: null, recordingId: name || 'sub-01', mode: 'standard',
    me: { annotator_id: 'A01', study: {} }, catalogue: new Catalogue(CATALOGUE) });
}

test('Start afresh sets the offered draft aside in this tab, and Bring it back restores it as one undoable step', async () => {
  const b = fakeBackend();
  const s = session(b, 'rec-afresh');
  const draft = { annotations: [{ annotation_id: 'a'.repeat(32), label: 'Eye-blink-artifact', onset_sample: 250, duration_samples: 100, channels: [], created_at: '', modified_at: '' }],
    elapsed_s: 300, viewed: [[0, 20]], saved_at: '2026-10-29T10:00:00' };
  assert.equal(s.discarded, null);
  await s.discardDrafts({ draft });
  assert.equal(b.deleted, 1, 'the study\'s draft is deleted');
  assert.equal(s.discarded.annotations.length, 1, 'and the work is set aside in the tab');
  assert.ok(s.discarded.discarded_at);
  // A new start, with one annotation of its own and a little time worked.
  s.startClock();
  s.store.add('EMG-artifact', 5000, 100);
  s.noteViewed([[30, 40]]);
  const r = s.bringBackDiscarded();
  assert.deepEqual(r, { n: 1, elapsedS: 300 });
  assert.deepEqual(s.store.annotations().map((a) => a.label), ['Eye-blink-artifact']);
  assert.ok(s.elapsedS >= 300 && s.elapsedS < 310, `the time worked before is added: ${s.elapsedS}`);
  assert.deepEqual(s.viewed, [[0, 20], [30, 40]], 'the parts viewed before are added');
  assert.equal(s.discarded, null, 'brought back once');
  s.store.undo();
  assert.deepEqual(s.store.annotations().map((a) => a.label), ['EMG-artifact'], 'Undo takes it back');
});

test('Discard and close sets aside what is open; nothing is set aside when there was nothing to lose', async () => {
  const b = fakeBackend();
  const empty = session(b, 'rec-empty');
  await empty.discardDrafts();
  assert.equal(empty.discarded, null);
  const s = session(b, 'rec-close');
  s.store.add('Chewing-artifact', 100, 100);
  await s.discardDrafts();
  assert.equal(discardedWork(s.localKey).annotations[0].label, 'Chewing-artifact');
  // The next session on the same recording in this tab finds it.
  const again = session(b, 'rec-close');
  assert.equal(again.discarded.annotations.length, 1);
  // Saved with Save and Finish: nothing is offered for it any more.
  await again.submit('visit');
  assert.equal(discardedWork(again.localKey), null);
});

test('a draft that does not reach the study is noted, tried again a few seconds later, and cleared when one arrives', async () => {
  const b = fakeBackend();
  const s = session(b, 'rec-offline');
  const seen = [];
  s.onSaved = (where) => seen.push(where);
  s.store.add('EMG-artifact', 100, 100);
  b.fail = true;
  assert.equal(await s.saveRemote({ force: true }), false);
  assert.equal(s.remoteFailing, true);
  assert.deepEqual(seen, ['study_failed']);
  // Not at once again (no request every second while offline) ...
  assert.equal(await s.saveRemote(), false);
  assert.deepEqual(seen, ['study_failed']);
  // ... but well before the usual 30 s.
  s._lastRemote -= 6000;
  b.fail = false;
  assert.equal(await s.saveRemote(), true);
  assert.equal(s.remoteFailing, false);
  assert.deepEqual(seen, ['study_failed', 'study']);
  assert.equal(b.drafts.length, 1);
  // The connection returning sends it again by force; the same draft twice is harmless (it replaces the one before).
  assert.equal(await s.saveRemote({ force: true }), true);
  assert.deepEqual(b.drafts[0].annotations, b.drafts[1].annotations);
});

// ------------------------------------------------- no draft after the session has closed
// This browser's copy of drafts needs a localStorage: Node has none, so one in memory stands in.
if (!globalThis.localStorage) {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('no draft is written for a session once it has closed: not by a save still waiting, nor by one asked for later', async () => {
  const b = fakeBackend();
  const s = session(b, 'rec-closed');
  s.store.add('EMG-artifact', 5000, 100); // this browser's copy is kept in a moment
  s.close();
  await wait(1400);
  assert.equal(localStorage.getItem(s.localKey), null, 'the save that was waiting did not happen');
  s.saveLocal();
  assert.equal(localStorage.getItem(s.localKey), null);
  assert.equal(await s.saveRemote({ force: true }), false);
  assert.equal(b.drafts.length, 0);
});

test('Discard and close waits for the draft on its way to the study, then deletes, naming the session that closes', async () => {
  const b = fakeBackend();
  const order = [];
  let release;
  b.putDraft = (rid, mode, ctx, draft) => new Promise((resolve) => { release = resolve; })
    .then(() => { order.push(['put', draft.session_id]); return { saved_at: 'now' }; });
  b.deleteDraft = async (rid, mode, ctx, opts = {}) => { order.push(['delete', opts.sessionId || '']); return {}; };
  const s = session(b, 'rec-on-its-way');
  s.store.add('EMG-artifact', 5000, 100);
  const sent = s.saveRemote({ force: true });
  assert.equal(await s.saveRemote(), false, 'one draft at a time');
  const discarded = s.discardDrafts({ close: true });
  s.saveLocal(); // nothing new is written meanwhile
  assert.equal(localStorage.getItem(s.localKey), null);
  await wait(50);
  assert.deepEqual(order, [], 'the delete waits for the draft on its way');
  release();
  await discarded;
  assert.equal(await sent, true);
  assert.deepEqual(order, [['put', s.sessionId], ['delete', s.sessionId]]);
  assert.equal(localStorage.getItem(s.localKey), null);
  assert.equal(await s.saveRemote({ force: true }), false, 'the session has closed');
  // A draft refused by the study as discarded is not tried again.
  const t = session(fakeBackend(), 'rec-refused');
  t.backend.putDraft = async () => { const e = new Error('discarded'); e.status = 409; e.code = 'draft_discarded'; throw e; };
  t.store.add('EMG-artifact', 5000, 100);
  assert.equal(await t.saveRemote({ force: true }), false);
  assert.equal(t.remoteFailing, false);
});

test('Start afresh names no session, so the work begun afterwards is kept as usual', async () => {
  const b = fakeBackend();
  const seen = [];
  b.deleteDraft = async (rid, mode, ctx, opts) => { seen.push(opts); return {}; };
  const s = session(b, 'rec-afresh-again');
  await s.discardDrafts({ draft: { annotations: [], elapsed_s: 0 } });
  assert.deepEqual(seen, [{}]);
  s.store.add('EMG-artifact', 5000, 100);
  assert.equal(await s.saveRemote({ force: true }), true);
  assert.equal(b.drafts.at(-1).session_id, s.sessionId);
  assert.ok(localStorage.getItem(s.localKey) === null || !('session_id' in JSON.parse(localStorage.getItem(s.localKey))));
});

test('Save and Finish waits for a draft on its way, so that no draft reaches the study after the saved result', async () => {
  const b = fakeBackend();
  const order = [];
  let release;
  b.putDraft = () => new Promise((resolve) => { release = resolve; }).then(() => { order.push('draft'); return { saved_at: 'now' }; });
  b.submit = async () => { order.push('submit'); return { saved: true, files: [] }; };
  const s = session(b, 'rec-save');
  s.store.add('EMG-artifact', 5000, 100);
  void s.saveRemote({ force: true });
  const saved = s.submit('v1');
  await wait(20);
  assert.deepEqual(order, []);
  release();
  await saved;
  assert.deepEqual(order, ['draft', 'submit']);
});
