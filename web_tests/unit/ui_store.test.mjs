// The annotation store (js/annotate/store.js): the desktop application's rules for creating,
// editing, merging and undoing annotations.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnnotationStore, AnnotationError } from '../../electrotag/web/static/js/annotate/store.js';
import { CATALOGUE } from '../../electrotag/web/static/js/api/demo_catalogue.js';

const CH = ['Fp1', 'Fp2', 'C3', 'C4', 'O1', 'O2'];
const store = (opts = {}) => new AnnotationStore({ chNames: CH, nSamples: 10000, sfreq: 250, labels: CATALOGUE.labels.map((l) => l.label), ...opts });

test('times snap to the nearest sample and channels follow the recording order', () => {
  const s = store();
  const a = s.addInterval('Eye-blink-artifact', 3.0019, 3.4021, ['O1', 'Fp1']);
  assert.equal(a.onset_sample, 750); // floor(750.475 + 0.5)
  assert.equal(a.duration_samples, 101); // the end: floor(850.525 + 0.5) = 851
  assert.deepEqual(a.channels, ['Fp1', 'O1']);
  assert.equal(a.annotation_id.length, 32);
  const b = s.addInterval('EMG-artifact', 5, 5); // a zero-length drag becomes one sample
  assert.equal(b.duration_samples, 1);
  assert.throws(() => s.add('Not-a-type', 0, 10), AnnotationError);
  assert.throws(() => s.add('EMG-artifact', 9995, 10), /ends after the recording/);
  assert.throws(() => s.add('EMG-artifact', 0, 10, ['Cz']), /Unknown channel/);
});

test('overlapping annotations of one type on the same channels merge; others stay apart', () => {
  const s = store();
  const a = s.add('EMG-artifact', 100, 100);
  s.add('EMG-artifact', 300, 100);
  s.add('EMG-artifact', 200, 100); // touches both ends only: not merged
  assert.equal(s.size, 3);
  const m = s.add('EMG-artifact', 150, 200); // overlaps all three
  assert.equal(s.size, 1);
  assert.equal(s.lastAutoMerged, 3);
  assert.equal(m.annotation_id, a.annotation_id); // the oldest keeps its identifier
  assert.equal(m.onset_sample, 100);
  assert.equal(m.duration_samples, 300);
  s.add('EMG-artifact', 150, 50, ['C3']); // other channels: separate
  s.add('Eye-blink-artifact', 150, 50); // other type: separate
  assert.equal(s.size, 3);
  // One undo step takes back the add and its merge.
  s.undo(); s.undo(); s.undo();
  assert.equal(s.size, 3);
  assert.deepEqual(s.annotations().map((x) => x.onset_sample), [100, 200, 300]);
  s.redo();
  assert.equal(s.size, 1);
});

test('moving an annotation onto another of its type merges them', () => {
  const s = store();
  const a = s.add('Movement-artifact', 1000, 100);
  const b = s.add('Movement-artifact', 2000, 100);
  const r = s.setSamples(b.annotation_id, 1050, 1150);
  assert.equal(s.size, 1);
  assert.equal(r.annotation_id, a.annotation_id);
  assert.equal(s.lastSurvivors.get(b.annotation_id), a.annotation_id);
  assert.match(s.undoDescription, /merged with 1 overlapping/);
});

test('channels, labels, explicit merges and deleting', () => {
  const s = store();
  const a = s.add('Electrode-pops-artifact', 100, 50, ['C3']);
  let x = s.toggleChannel(a.annotation_id, 'C4');
  assert.deepEqual(x.channels, ['C3', 'C4']);
  x = s.toggleChannel(a.annotation_id, 'C3');
  assert.deepEqual(x.channels, ['C4']);
  // The last channel cannot be taken out: the annotation would otherwise spread to every channel.
  assert.throws(() => s.toggleChannel(a.annotation_id, 'C4'), /needs at least one channel/);
  assert.deepEqual(s.get(a.annotation_id).channels, ['C4']);
  x = s.toggleChannel(a.annotation_id, 'C3');
  const b = s.add('EMG-artifact', 500, 50);
  const c = s.add('EMG-artifact', 700, 50, ['O1']);
  s.setLabelMany([a.annotation_id, b.annotation_id], 'Chewing-artifact');
  assert.deepEqual(s.annotations().map((y) => y.label), ['Chewing-artifact', 'Chewing-artifact', 'EMG-artifact']);
  assert.match(s.undoDescription, /relabel 2 annotations as Chewing-artifact/);
  assert.throws(() => s.merge([a.annotation_id, c.annotation_id]), /same label/);
  const m = s.merge([a.annotation_id, b.annotation_id]);
  assert.equal(m.onset_sample, 100);
  assert.equal(m.duration_samples, 450);
  s.deleteMany([m.annotation_id, c.annotation_id]);
  assert.equal(s.size, 0);
  assert.equal(s.undo(), 'delete 2 annotations');
  assert.equal(s.size, 2);
});

test('Shift+click on a whole-montage annotation takes that channel out, and putting it back makes it whole again', () => {
  const s = store();
  const a = s.add('Eye-blink-artifact', 100, 50);
  let x = s.toggleChannel(a.annotation_id, 'C3');
  assert.deepEqual(x.channels, ['Fp1', 'Fp2', 'C4', 'O1', 'O2'], 'every channel but C3');
  assert.match(s.undoDescription, /toggle channel C3/);
  x = s.toggleChannel(a.annotation_id, 'C3');
  assert.deepEqual(x.channels, [], 'every channel again: the whole montage');
  assert.throws(() => s.toggleChannel(a.annotation_id, 'Cz'), /Unknown channel/);
  const one = store({ chNames: ['Cz'] });
  const b = one.add('EMG-artifact', 0, 10);
  assert.throws(() => one.toggleChannel(b.annotation_id, 'Cz'), /needs at least one channel/, 'a one-channel montage cannot lose its only channel');
});

test('work brought back replaces everything as one step that Undo takes back', () => {
  const s = store();
  const mine = s.add('EMG-artifact', 0, 10);
  const earlier = [{ annotation_id: 'e'.repeat(32), label: 'Eye-blink-artifact', onset_sample: 5, duration_samples: 5, channels: ['O2', 'Fp1'], created_at: '', modified_at: '' },
    { annotation_id: 'd'.repeat(32), label: 'Chewing-artifact', onset_sample: 50, duration_samples: 20, channels: [], created_at: '', modified_at: '' }];
  const seen = [];
  s.addListener((c) => seen.push(c.action));
  s.replaceAll(earlier);
  assert.deepEqual(s.annotations().map((a) => a.annotation_id), ['e'.repeat(32), 'd'.repeat(32)]);
  assert.deepEqual(s.get('e'.repeat(32)).channels, ['Fp1', 'O2']);
  assert.deepEqual(seen, ['replace']);
  assert.equal(s.undoDescription, 'bring back earlier work');
  assert.equal(s.undo(), 'bring back earlier work');
  assert.deepEqual(s.annotations().map((a) => a.annotation_id), [mine.annotation_id]);
  s.redo();
  assert.equal(s.size, 2);
  assert.throws(() => s.replaceAll([{ ...earlier[0], label: 'Not-a-type' }]), AnnotationError);
  assert.equal(s.size, 2, 'nothing changes when the work brought back is not valid');
});

test('a restored draft replaces everything and clears the history', () => {
  const s = store();
  s.add('EMG-artifact', 0, 10);
  const draft = [{ annotation_id: 'f'.repeat(32), label: 'Eye-blink-artifact', onset_sample: 5, duration_samples: 5, channels: ['O2', 'Fp1'], created_at: '', modified_at: '' }];
  s.reset(draft);
  assert.equal(s.size, 1);
  assert.deepEqual(s.get('f'.repeat(32)).channels, ['Fp1', 'O2']);
  assert.equal(s.canUndo, false);
  assert.deepEqual(Object.keys(s.toJSON()[0]).sort(), ['annotation_id', 'channels', 'created_at', 'duration_samples', 'label', 'modified_at', 'onset_sample']);
});

test('the minimum duration of the study is kept', () => {
  const s = store({ minDurationSamples: 25 });
  const a = s.addInterval('EMG-artifact', 1.0, 1.01);
  assert.equal(a.duration_samples, 25);
  assert.throws(() => s.add('EMG-artifact', 0, 10), /shorter than 25 sample/);
});
