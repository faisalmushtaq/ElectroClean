// The demonstration's recordings (js/data/synthetic.js): the EDF writer, and reading the file
// back with the application's readers (js/data/recording.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { demoSpecs, makeSyntheticRecording, syntheticEdfBytes, truthAnnotations, sha256Hex, edgeHalfWidthS } from '../../electrotag/web/static/js/data/synthetic.js';
import { openRecording } from '../../electrotag/web/static/js/data/recording.js';

const [spec1, , spec3] = demoSpecs();

test('three example recordings with their artifacts as annotations', () => {
  assert.deepEqual(demoSpecs().map((s) => s.id), ['demo-01', 'demo-02', 'demo-03']);
  const truth = truthAnnotations(spec1);
  assert.equal(truth.length, 6);
  assert.deepEqual(truth[0], {
    annotation_id: truth[0].annotation_id, label: 'Eye-blink-artifact', onset_sample: 750, duration_samples: 100,
    channels: ['Fp1', 'Fp2', 'VEOG'], created_at: truth[0].created_at, modified_at: truth[0].modified_at,
  });
  assert.equal(new Set(truthAnnotations(spec3).map((a) => a.annotation_id)).size, 8);
});

test('the EDF file reads back as the same EEG, with the same fingerprint', async () => {
  const bytes = syntheticEdfBytes(spec1);
  const rec = makeSyntheticRecording(spec1);
  assert.equal(bytes.length, rec.sizeBytes);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)).trim(), '0');
  const file = new File([bytes], 'sub-demo01_task-rest_eeg.edf');
  const read = await openRecording([file]);
  assert.equal(read.sfreq, 250);
  assert.equal(read.nSamples, rec.nSamples);
  assert.deepEqual(read.channels.map((c) => c.name), rec.channels.map((c) => c.name));
  const a = await rec.readWindow({ startSample: 700, nSamples: 200, channels: [0, 20], filters: null });
  const b = await read.readWindow({ startSample: 700, nSamples: 200, channels: [0, 20], filters: null });
  for (let ch = 0; ch < 2; ch++) {
    const diff = Math.max(...a.data[ch].map((v, i) => Math.abs(v - b.data[ch][i])));
    assert.ok(diff < 1e-7, `channel ${ch}: ${diff} V apart`); // 0.1 µV resolution
  }
  assert.equal((await read.fingerprint()).hex, (await rec.fingerprint()).hex);
  assert.equal((await rec.fingerprint()).hex, await sha256Hex(bytes));
});

test('display filters mark their edge zones; a gap has no data', async () => {
  const rec = makeSyntheticRecording(spec3);
  assert.deepEqual(rec.gaps, [[21500, 22500]]);
  const w = await rec.readWindow({ startSample: 21600, nSamples: 100, channels: [0], filters: null });
  assert.ok(w.data[0].every((v) => v === 0));
  const f = { highpassHz: 1, notchHz: 50, notchHarmonics: false };
  assert.ok(Math.abs(edgeHalfWidthS(f) - 4.95) < 1e-9);
  const filtered = await rec.readWindow({ startSample: 0, nSamples: 2500, channels: [0], filters: f });
  assert.deepEqual(filtered.edgeZones[0], [0, Math.round(edgeHalfWidthS(f) * 250)]);
});

test('a horizontal eye movement shows where it really would, with opposite signs on the two sides', async () => {
  const rec = makeSyntheticRecording(spec1);
  const names = rec.channels.map((c) => c.name);
  const hem = truthAnnotations(spec1).find((a) => a.label === 'Horizontal-eye-movement-artifact');
  assert.deepEqual(hem.channels, ['Fp1', 'Fp2', 'F7', 'F8', 'HEOG'], 'the reference marks the EOG and the scalp channels where it is clear');
  const mid = hem.onset_sample + Math.round(hem.duration_samples / 2);
  const read = async (s0) => rec.readWindow({ startSample: s0, nSamples: 25, channels: names.map((_, i) => i), filters: null });
  const during = await read(mid - 12);
  const before = await read(hem.onset_sample - 300);
  const shift = (name) => { const i = names.indexOf(name); const m = (d) => d.data[i].reduce((a, b) => a + b, 0) / d.data[i].length; return (m(during) - m(before)) * 1e6; };
  assert.ok(shift('HEOG') > 120 && shift('F7') > 50 && shift('F8') < -50, 'largest on the horizontal EOG and beside the eyes');
  assert.ok(shift('Fp1') > 20 && shift('Fp2') < -20, 'smaller above the eyes, opposite on the two sides');
  assert.ok(Math.abs(shift('O1')) < 10 && Math.abs(shift('Cz')) < 10, 'nothing at the back or the top of the head');
});
