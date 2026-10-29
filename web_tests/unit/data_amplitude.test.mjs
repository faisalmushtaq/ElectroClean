// The amplitude check of the browser against the desktop's (electrotag/app/eeg/amplitude.py)
// on the same files, channel types and filters, and its helpers.

import assert from "node:assert/strict";
import test from "node:test";

import {
  amplitudeReport,
  amplitudeWindows,
  formatG,
  formatVolts,
  niceScale,
} from "../../electrotag/web/static/js/data/amplitude.js";
import { openRecording } from "../../electrotag/web/static/js/data/recording.js";
import { ensureFixtures, expected, fixtureFiles } from "./_fixtures.mjs";

const manifest = ensureFixtures();
const CHECKED = Object.entries(manifest.fixtures)
  .filter(([name, f]) => !f.error && expected(name).amplitude)
  .map(([name]) => name);

for (const name of CHECKED) {
  test(`${name}: amplitudes, display scales and warnings as the desktop finds them`, async () => {
    const exp = expected(name).amplitude;
    const rec = await openRecording(await fixtureFiles(manifest, name), { worker: false, filters: exp.filters });
    try {
      assert.deepEqual(Object.keys(rec.amplitudes).sort(), Object.keys(exp.amplitudes_v).sort());
      for (const [type, v] of Object.entries(exp.amplitudes_v)) {
        // the browser measures float32 samples; MNE float64 ones
        assert.ok(Math.abs(rec.amplitudes[type] - v) <= 1e-5 * v, `${type}: ${rec.amplitudes[type]} vs ${v}`);
      }
      assert.deepEqual(rec.suggestedScalings, exp.suggested_scalings);
      for (const w of exp.warnings) assert.ok(rec.warnings.includes(w), `missing warning: ${w}`);
    } finally {
      rec.close();
    }
  });
}

test("microvolts stored as volts: the warning and the scale", async () => {
  const exp = expected("wrong_units").amplitude;
  assert.deepEqual(exp.suggested_scalings, { eeg: 50, eog: 200, ecg: 1000 });
  assert.ok(exp.warnings[0].startsWith("The EEG channels' amplitude is about 31.3 V, far larger than any EEG signal"));
});

test("formatting and nice scales as in amplitude.py", () => {
  assert.equal(formatG(14), "14");
  assert.equal(formatG(230), "230");
  assert.equal(formatG(0.03), "0.03");
  assert.equal(formatG(31.254), "31.3");
  assert.equal(formatG(123456), "1.23e+05");
  assert.equal(formatG(0.000012345), "1.23e-05");
  assert.equal(formatG(999.7), "1e+03");
  assert.equal(formatVolts(14), "14 V");
  assert.equal(formatVolts(230e-6), "230 µV");
  assert.equal(formatVolts(3e-8), "30 nV");
  assert.equal(formatVolts(2e-10), "0.2 nV");
  assert.equal(formatVolts(1500), "1.5 kV");
  assert.equal(niceScale(31.25), 50);
  assert.equal(niceScale(127.3), 200);
  assert.equal(niceScale(1e-7), 1e-7);
  assert.equal(niceScale(2.1e-9), 5e-9);
  assert.equal(niceScale(9.5), 10);
  assert.throws(() => niceScale(0));
});

test("sampled windows: spread between the edge zones, gaps left out", () => {
  const w = amplitudeWindows(10000, 100, [], 300);
  assert.equal(w.length, 10);
  assert.deepEqual(w[0], [300, 500]);
  assert.deepEqual(w[9], [9500, 9700]);
  const avoid = amplitudeWindows(10000, 100, [[4000, 6000]], 300);
  assert.ok(avoid.every(([s, e]) => e <= 4000 || s >= 6000));
  assert.deepEqual(amplitudeWindows(100, 100, [], 300), [[0, 100]]);
  assert.deepEqual(amplitudeWindows(1000, 100, [[0, 1000]], 0), [[0, 200]]);
});

test("flat channels are left out and a flat type says nothing", () => {
  const flat = new Float32Array(100);
  const r = amplitudeReport({ eeg: [flat, flat] });
  assert.deepEqual(r.amplitudesV, {});
  const noisy = Float32Array.from({ length: 1000 }, (_, i) => 1e-5 * Math.sin(i));
  const r2 = amplitudeReport({ eeg: [flat, noisy] });
  assert.ok(Math.abs(r2.amplitudesV.eeg - 1e-5) < 1e-7);
  assert.deepEqual(r2.warnings, []);
});
