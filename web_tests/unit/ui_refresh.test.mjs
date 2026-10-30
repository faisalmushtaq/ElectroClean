// A reload of the page while annotating (js/annotate/session.js, js/annotate/reopen.js): this browser's
// copy is written a moment after a change and at once when the page goes; the newer of the study's
// draft and this browser's copy is chosen by the moment each was kept, whatever the time zones of
// the study and the person; a try-out keeps its marks in this browser only, by the file's
// fingerprint; and the recording that was open is noted in the tab, to be opened again.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
globalThis.localStorage ??= memoryStorage();
globalThis.sessionStorage ??= memoryStorage();

const { AnnotationSession, LOCAL_DELAY_MS, draftTime } = await import('../../electrotag/web/static/js/annotate/session.js');
const reopen = await import('../../electrotag/web/static/js/annotate/reopen.js');
const { Catalogue } = await import('../../electrotag/web/static/js/catalogue.js');
const { CATALOGUE } = await import('../../electrotag/web/static/js/api/demo_catalogue.js');

const recording = (name) => ({
  fileName: name, sfreq: 250, nSamples: 250 * 60, durationS: 60, format: 'edf', markers: [], warnings: [], gaps: [],
  channels: ['Fp1', 'Fp2', 'C3', 'C4'].map((n) => ({ name: n, type: 'eeg' })),
});

function fakeBackend() {
  const b = { kind: 'server', server: 'http://study', drafts: [] };
  b.putDraft = async (rid, mode, ctx, draft) => { b.drafts.push(draft); return { saved_at: 'now' }; };
  b.deleteDraft = async () => ({});
  return b;
}

function session(backend, name, { mode = 'standard', sha256 = 'a'.repeat(64) } = {}) {
  return new AnnotationSession({ backend, recording: recording(name), manifest: null, recordingId: name, mode, contextId: '', sha256,
    me: { annotator_id: 'A01', study: {} }, catalogue: new Catalogue(CATALOGUE) });
}

const ann = (label, onset) => ({ annotation_id: `${onset}`.padStart(32, '0'), label, onset_sample: onset, duration_samples: 100, channels: [], created_at: '', modified_at: '' });
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('a draft kept in another time zone is compared as a moment, not as text', () => {
  // The study (Firebase runs in UTC) kept one annotation at 16:30 UTC; this browser, in New York, kept two at 12:31 there (16:31 UTC).
  assert.ok(draftTime({ saved_at: '2026-10-30T12:31:00.000-04:00' }) > draftTime({ saved_at: '2026-10-30T16:30:00.000+00:00' }));
  assert.equal(draftTime({ saved_at: 'never' }), -Infinity);
  assert.equal(draftTime(null), -Infinity);
  const s = session(fakeBackend(), 'rec-zones');
  localStorage.setItem(s.localKey, JSON.stringify({ annotations: [ann('Eye-blink-artifact', 250), ann('EMG-artifact', 2500)], elapsed_s: 60,
    saved_at: '2026-10-30T12:31:00.000-04:00' }));
  const study = { annotations: [ann('Eye-blink-artifact', 250)], elapsed_s: 30, saved_at: '2026-10-30T16:30:00.000+00:00' };
  assert.equal(s.pickDraft(study).annotations.length, 2, 'this browser\'s newer copy wins');
  // And the other way round: a newer draft from another computer wins over an older copy here.
  const later = { annotations: [ann('Eye-blink-artifact', 250), ann('EMG-artifact', 2500), ann('Chewing-artifact', 5000)], elapsed_s: 90,
    saved_at: '2026-10-30T17:00:00.000+00:00' };
  assert.equal(s.pickDraft(later).annotations.length, 3);
});

test('this browser\'s copy is written a moment after a change, and at once by saveLocal (as when the page goes)', async () => {
  assert.ok(LOCAL_DELAY_MS <= 500, `a moment: ${LOCAL_DELAY_MS} ms`);
  const s = session(fakeBackend(), 'rec-moment');
  s.store.add('EMG-artifact', 5000, 100);
  assert.equal(localStorage.getItem(s.localKey), null, 'not at once: a burst of changes writes once');
  await wait(LOCAL_DELAY_MS + 100);
  assert.equal(JSON.parse(localStorage.getItem(s.localKey)).annotations.length, 1);
  s.store.add('Chewing-artifact', 8000, 100);
  s.saveLocal();
  assert.equal(JSON.parse(localStorage.getItem(s.localKey)).annotations.length, 2, 'written at once');
});

test('a try-out keeps its marks in this browser only, by the file\'s fingerprint; Close lets them go', async () => {
  const b = fakeBackend();
  const s = session(b, 'my_own.edf', { mode: 'tryout', sha256: 'b'.repeat(64) });
  assert.equal(s.tryOut, true);
  assert.equal(s.canSave, false);
  assert.equal(s.mayKeepLocal, true);
  assert.match(s.localKey, /\|tryout\|.*\|sha-b{64}$/);
  s.store.add('EMG-artifact', 5000, 100);
  s.saveLocal();
  assert.equal(await s.saveRemote({ force: true }), false, 'nothing goes to the study');
  assert.equal(b.drafts.length, 0);
  // The same file opened again in this browser: its marks are offered.
  const again = session(b, 'my_own.edf', { mode: 'tryout', sha256: 'b'.repeat(64) });
  assert.equal(again.pickDraft(null).annotations.length, 1);
  // Another file of the same name: nothing.
  assert.equal(session(b, 'my_own.edf', { mode: 'tryout', sha256: 'c'.repeat(64) }).pickDraft(null), null);
  await again.discardDrafts({ close: true });
  assert.equal(localStorage.getItem(s.localKey), null);
  assert.equal(again.mayKeepLocal, false);
});

test('the recording on screen is noted in the tab for the same study and person, and forgotten when it is left', () => {
  const b = fakeBackend();
  const s = session(b, 'sub-01.edf');
  reopen.noteOpen(s);
  const m = reopen.openBeforeReload(b, 'A01');
  assert.deepEqual({ ...m }, { where: 'http://study', annotator_id: 'A01', recording_id: 'sub-01.edf', mode: 'standard', context_id: '',
    file_name: 'sub-01.edf', try_out: false, revises: null });
  assert.equal(reopen.openBeforeReload(b, 'A02'), null, 'another person');
  assert.equal(reopen.openBeforeReload({ kind: 'demo', server: '' }, 'A01'), null, 'another study');
  const items = [{ recording_id: 'sub-01.edf', mode: 'guided', context_id: 'set' }, { recording_id: 'sub-01.edf', mode: 'standard', context_id: '' }];
  assert.equal(reopen.itemFor(items, m), items[1]);
  assert.match(reopen.reopenText(m), /The page was reloaded while sub-01\.edf was open\. Your work is kept: choose the file again/);
  assert.match(reopen.reopenText({ ...m, try_out: true }), /kept only in this browser/);
  reopen.forgetOpen();
  assert.equal(reopen.openBeforeReload(b, 'A01'), null);
  // A finished or read-only session is not noted.
  s.finished = true;
  reopen.noteOpen(s);
  assert.equal(reopen.openBeforeReload(b, 'A01'), null);
});
