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
  x = s.toggleChannel(a.annotation_id, 'C4');
  assert.deepEqual(x.channels, []); // no channel left: the whole montage
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
