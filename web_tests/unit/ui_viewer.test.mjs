// The viewer's arithmetic (js/viewer/geometry.js) and choosing files from a folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { columnMinMax, decimateColumns, layoutTags, niceStep, stepOption, tickLabel, voltsText, DURATIONS, CHANNEL_COUNTS } from '../../electrotag/web/static/js/viewer/geometry.js';
import { filesForRecording } from '../../electrotag/web/static/js/views/open.js';

test('min and max per pixel column', () => {
  const data = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 5));
  const { min, max } = columnMinMax(data, 0, 0, 100, 10);
  for (let c = 0; c < 10; c++) {
    const part = Array.from(data.subarray(c * 10, c * 10 + 10));
    assert.equal(min[c], Math.min(...part));
    assert.equal(max[c], Math.max(...part));
  }
  const outside = columnMinMax(data, 1000, 0, 100, 10);
  assert.ok(outside.min.every(Number.isNaN));
});

test('scrolling reuses the columns already worked out', () => {
  const data = Float32Array.from({ length: 5000 }, (_, i) => Math.cos(i / 7) + (i % 13) / 10);
  const grid = 9.41;
  const first = decimateColumns(data, 0, grid, 100, 200);
  const moved = decimateColumns(data, 0, grid, 150, 200, first);
  const fresh = decimateColumns(data, 0, grid, 150, 200);
  assert.deepEqual(Array.from(moved.min), Array.from(fresh.min));
  assert.deepEqual(Array.from(moved.max), Array.from(fresh.max));
  assert.deepEqual(Array.from(moved.sum), Array.from(fresh.sum));
});

test('axis ticks, tags, steps and scale bars', () => {
  assert.equal(niceStep(10, 1000), 1);
  assert.equal(niceStep(60, 1000), 5);
  assert.equal(tickLabel(12, 1), '12');
  assert.equal(tickLabel(12.5, 0.5), '12.5');
  assert.equal(tickLabel(3725, 600), '1:02:05');
  assert.deepEqual(layoutTags([{ x: 100, w: 80 }, { x: 150, w: 80 }, { x: 400, w: 50 }]), [0, 1, 0]);
  assert.equal(stepOption(DURATIONS, 10, 1), 15);
  assert.equal(stepOption(DURATIONS, 10, -1), 5);
  assert.equal(stepOption(CHANNEL_COUNTS, 22, 1, 22), 22);
  assert.equal(stepOption(CHANNEL_COUNTS, 20, 1, 22), 22);
  assert.equal(stepOption(CHANNEL_COUNTS, 22, -1, 22), 20);
  assert.equal(stepOption(DURATIONS, 60, 1, 70), 70);
  assert.equal(voltsText(1e-4), '100 µV');
  assert.equal(voltsText(1e-3), '1 mV');
});

test('the files of one recording from a folder', () => {
  const f = (name) => ({ name });
  assert.deepEqual(filesForRecording([f('a.edf'), f('notes.txt')]).map((x) => x.name), ['a.edf']);
  assert.deepEqual(filesForRecording([f('a.vhdr'), f('a.vmrk'), f('a.eeg'), f('x.txt')]).map((x) => x.name), ['a.vhdr', 'a.vmrk', 'a.eeg']);
  assert.equal(filesForRecording([f('a.edf'), f('b.edf')]), null);
  assert.deepEqual(filesForRecording([f('a.edf'), f('b.edf')], 'b.edf').map((x) => x.name), ['b.edf']);
  assert.deepEqual(filesForRecording([f('x.txt')]), []);
});
