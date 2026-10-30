// The replay of a session from its interaction log (js/replay/model.js): the annotation store is driven
// as an annotator drives it, its changes are logged with the annotation view's own events
// (js/log/annotation_events.js), and the replay rebuilds the annotations from the log, through
// snapshots in chunks, undo, redo, merges and later sessions, ending where the saved version ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnnotationStore } from '../../electrotag/web/static/js/annotate/store.js';
import { SNAPSHOT_CHUNK, annotationEvents, snapshotEvents } from '../../electrotag/web/static/js/log/annotation_events.js';
import { buildTimeline, captionOf, clock, compareWithSaved, compressIdle, indexAt, mapTime, nextChange, nextEvent, prevChange, prevEvent,
  seedOf, stateAt } from '../../electrotag/web/static/js/replay/model.js';

const SF = 256;
const LABELS = ['Eye-blink-artifact', 'EMG-artifact', 'Chewing-artifact', 'Eye-artifact'];
const CH = ['Fp1', 'Fp2', 'F7', 'F8', 'T7', 'T8'];

/** A session: a store whose changes are logged as the annotation view logs them, at one event a second. */
function session({ initial = [], window = 1, t0 = 0, snapshot = true, restored = 0 } = {}) {
  const store = new AnnotationStore({ chNames: CH, nSamples: SF * 600, sfreq: SF, labels: LABELS, autoMerge: true });
  if (initial.length) store.reset(initial);
  const events = [];
  let t = t0;
  let seq = 1000 * window;
  const log = (type, fields = {}) => { events.push({ t: (t += 1), seq: (seq += 1), type, window_no: window, ...fields }); };
  log('recording_opened', { session_id: `s${window}`, annotations_restored: restored });
  if (snapshot) for (const [type, f] of snapshotEvents(store.annotations(), SF)) log(type, f);
  log('viewer_ready');
  let prev = new Map(store.annotations().map((a) => [a.annotation_id, a]));
  store.addListener((change) => {
    const now = new Map(store.annotations().map((a) => [a.annotation_id, a]));
    for (const [type, f] of annotationEvents(change, prev, now, { sf: SF, via: 'key:M', autoMerged: store.lastAutoMerged })) log(type, f);
    prev = now;
  });
  return { store, events, log, wait: (d) => { t += d; } };
}

const saved = (store) => store.toJSON().map((a) => ({ ...a }));

test('the replay ends with the annotations as saved, through every kind of change', () => {
  const s = session();
  const blink = s.store.add('Eye-blink-artifact', 500, 100, ['Fp1', 'Fp2']);
  s.log('view', { t_start: 1.5, duration: 10, ch_start: 0, n_channels: 6, scale_factor: 1 });
  const emg = s.store.add('EMG-artifact', 3000, 250);
  s.store.add('EMG-artifact', 3200, 200); // overlaps: merged into the one before
  s.store.setLabel(blink.annotation_id, 'Eye-artifact');
  s.store.setSamples(blink.annotation_id, 480, 610);
  s.store.setChannels(blink.annotation_id, ['Fp1']);
  s.store.setConfidence(blink.annotation_id, 4);
  s.store.setNote(blink.annotation_id, 'a clear one');
  const c1 = s.store.add('Chewing-artifact', 8000, 100);
  const c2 = s.store.add('Chewing-artifact', 8300, 100);
  s.store.merge([c1.annotation_id, c2.annotation_id]);
  s.store.undo();
  s.store.redo();
  s.store.deleteMany([s.store.annotations().find((a) => a.label === 'EMG-artifact').annotation_id]);
  s.store.undo();
  s.store.replaceAll([...s.store.toJSON(), { annotation_id: 'x1', label: 'EMG-artifact', onset_sample: 20000, duration_samples: 300, channels: [] }]);
  s.log('recording_finished', { session_id: 's1', attempt: 1 });
  assert.ok(emg);
  const tl = buildTimeline([{ segment: { window_no: 1 }, events: s.events }], { sfreq: SF });
  const end = stateAt(tl, tl.duration);
  const cmp = compareWithSaved(end, saved(s.store), SF);
  assert.deepEqual(cmp, { same: true, differing: 0, changed: 0, missing: 0, extra: 0 });
  assert.equal(end.annotations.get(blink.annotation_id).note_length, 'a clear one'.length, 'only the note\'s length');
  assert.equal(end.view.startS, 1.5);
  // half-way it is as it was then: the merge's two marks are there before it
  const beforeMerge = tl.items.find((x) => x.e.type === 'annotations_merged').t - 0.5;
  const mid = stateAt(tl, beforeMerge);
  assert.equal([...mid.annotations.values()].filter((a) => a.label === 'Chewing-artifact').length, 2);
  // and the saved version differing is said so
  const other = saved(s.store).map((a, i) => (i === 0 ? { ...a, onset_sample: a.onset_sample + 10 } : a)).slice(0, -1);
  assert.deepEqual(compareWithSaved(end, other, SF), { same: false, differing: 2, changed: 1, missing: 0, extra: 1 });
});

test('a session that opens with annotations starts from its snapshot, in chunks of at most 60', () => {
  const many = Array.from({ length: 2 * SNAPSHOT_CHUNK + 5 }, (_, i) => ({ annotation_id: `a${i}`, label: 'EMG-artifact',
    onset_sample: i * 1000, duration_samples: 100, channels: [] }));
  const s = session({ initial: many });
  const snaps = s.events.filter((e) => e.type === 'annotations_snapshot');
  assert.deepEqual(snaps.map((e) => [e.part, e.n_parts, e.annotations.length]), [[1, 3, 60], [2, 3, 60], [3, 3, 5]]);
  assert.ok(snaps.every((e) => JSON.stringify(e).length < 16 * 1024), 'each event under the log\'s 16 KB');
  s.store.deleteMany(['a3']);
  const tl = buildTimeline([{ events: s.events }], { sfreq: SF });
  assert.equal(seedOf(s.events, 0), 'snapshot');
  assert.ok(compareWithSaved(stateAt(tl, tl.duration), saved(s.store), SF).same);
  assert.equal(stateAt(tl, tl.items.find((x) => x.e.type === 'annotations_snapshot').t).annotations.size, 60, 'the first chunk replaces whatever was there');
  assert.deepEqual(snapshotEvents([], SF), []);
});

test('later sessions: with a snapshot, chained from the one before (older logs), or from nothing', () => {
  const one = session({ window: 1 });
  one.store.add('EMG-artifact', 100, 50);
  one.store.add('Eye-blink-artifact', 900, 60);
  one.log('recording_finished');
  // a revision logged before snapshots existed: it starts from where the first ended
  const two = session({ window: 2, t0: 100, initial: one.store.toJSON(), snapshot: false, restored: 2 });
  two.store.deleteMany([two.store.annotations()[0].annotation_id]);
  two.log('recording_finished');
  let tl = buildTimeline([{ events: one.events }, { events: two.events }], { sfreq: SF });
  assert.deepEqual(tl.segments.map((x) => x.seed), ['empty', 'chained']);
  assert.ok(tl.segments[1].start > tl.segments[0].end, 'a second apart on the time line');
  assert.ok(compareWithSaved(stateAt(tl, tl.duration), saved(two.store), SF).same);
  // the same revision logged with its snapshot
  const three = session({ window: 3, t0: 200, initial: one.store.toJSON(), snapshot: true });
  three.store.add('Chewing-artifact', 4000, 100);
  tl = buildTimeline([{ events: one.events }, { events: three.events }], { sfreq: SF });
  assert.equal(tl.segments[1].seed, 'snapshot');
  assert.ok(compareWithSaved(stateAt(tl, tl.duration), saved(three.store), SF).same);
  // a fresh start after work was discarded: nothing carried over
  const four = session({ window: 4, t0: 300, snapshot: false });
  four.store.add('Eye-artifact', 50, 50);
  tl = buildTimeline([{ events: one.events }, { events: four.events }], { sfreq: SF });
  assert.equal(tl.segments[1].seed, 'empty');
  assert.ok(compareWithSaved(stateAt(tl, tl.duration), saved(four.store), SF).same);
});

test('stepping, pauses skipped and the state that is shown', () => {
  const s = session();
  s.log('pointer', { eeg_t: 2.5, eeg_channel: 'F7' });
  s.log('state', { current_label: 'EMG-artifact' });
  s.log('state', { mark_start_s: 3.25 });
  s.log('pause', { reason: 'key' });
  s.wait(600); // ten minutes away
  s.log('resume', {});
  s.store.add('EMG-artifact', 832, 100);
  s.log('dialog_shown', { title: 'Save and Finish' });
  s.log('dialog_closed', { button: 'Save and Finish' });
  const tl = buildTimeline([{ events: s.events }], { sfreq: SF });
  assert.equal(tl.idle.length, 1);
  const created = tl.items.find((x) => x.e.type === 'annotation_created').t;
  assert.equal(nextChange(tl, 0), created);
  assert.equal(prevChange(tl, tl.duration), created);
  assert.equal(nextChange(tl, created), null);
  const stepped = nextEvent(tl, tl.items[2].t);
  assert.notEqual(tl.items.find((x) => x.t === stepped).e.type, 'pointer', 'the pointer\'s moves are passed over');
  assert.equal(prevEvent(tl, 0), null);
  const st = stateAt(tl, tl.items.find((x) => x.e.type === 'pause').t);
  assert.deepEqual([st.paused, st.label, st.markStartS, st.pointer], [true, 'EMG-artifact', 3.25, { t: 2.5, channel: 'F7' }]);
  assert.equal(stateAt(tl, tl.items.find((x) => x.e.type === 'dialog_shown').t).dialog.title, 'Save and Finish');
  assert.equal(stateAt(tl, tl.duration).dialog, null);
  // Skip pauses: the ten minutes become three seconds, the order and the states stay
  const quick = compressIdle(tl, 3);
  assert.ok(quick.duration < tl.duration - 590 && quick.duration > 10);
  assert.equal(quick.items.length, tl.items.length);
  assert.ok(compareWithSaved(stateAt(quick, quick.duration), saved(s.store), SF).same);
  assert.equal(indexAt(quick, mapTime(tl, quick, created)), indexAt(tl, created));
  assert.equal(clock(65), '1:05');
  assert.equal(clock(3725), '1:02:05');
});

test('each event in plain words', () => {
  assert.equal(captionOf({ type: 'shortcut', key: 'M', action: 'Mark start, then end' }), 'Pressed M: Mark start, then end');
  assert.equal(captionOf({ type: 'annotation_created', via: 'unknown', annotations: [{ id: 'a', label: 'Eye-blink-artifact' }] }), 'Created Eye-blink-artifact by dragging on the EEG');
  assert.equal(captionOf({ type: 'annotation_created', via: 'shortcut:Mark end', annotations: [{ id: 'a', label: 'EMG-artifact' }] }), 'Created EMG-artifact with the keyboard');
  assert.equal(captionOf({ type: 'note_set', annotations: [{ id: 'a', label: 'EMG-artifact', change: 'added', note_length: 42 }] }), 'Added a note to EMG-artifact (42 characters)');
  assert.equal(captionOf({ type: 'view', t_start: 10, duration: 10 }), 'Showing 10.00 s to 20.00 s');
  assert.equal(captionOf({ type: 'pointer', eeg_t: 1 }), null);
});
