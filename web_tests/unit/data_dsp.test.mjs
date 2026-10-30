// The FFT and the display filter designs, against a direct DFT and MNE-Python's create_filter.

import assert from "node:assert/strict";
import test from "node:test";

import { FFT, kernelSpectrum, nextPow2 } from "../../electrotag/web/static/js/eeg/fft.js";
import {
  autoFilterLength,
  designHighpass,
  designNotch,
  edgeZonesFor,
  filterKey,
  filterPair,
  firwinLowpass,
  hammingSymmetric,
  notchFrequencies,
  planFilters,
} from "../../electrotag/web/static/js/eeg/filters.js";
import { ensureFixtures, expected } from "./_fixtures.mjs";

test("FFT matches a direct DFT and inverts exactly", () => {
  for (const n of [4, 8, 16, 32, 64, 128, 512]) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(i * 0.37) + (i % 5) * 0.1;
      im[i] = Math.cos(i * 1.1) - 0.2;
    }
    const r = re.slice();
    const m = im.slice();
    FFT.of(n).forward(r, m);
    let err = 0;
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * ((k * t) % n)) / n;
        sr += re[t] * Math.cos(a) - im[t] * Math.sin(a);
        si += re[t] * Math.sin(a) + im[t] * Math.cos(a);
      }
      err = Math.max(err, Math.abs(sr - r[k]), Math.abs(si - m[k]));
    }
    assert.ok(err < 1e-10 * n, `n=${n} err=${err}`);
    FFT.of(n).inverse(r, m);
    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(r[i] - re[i]) < 1e-12 && Math.abs(m[i] - im[i]) < 1e-12);
    }
  }
  assert.equal(nextPow2(1), 4);
  assert.equal(nextPow2(1025), 2048);
  assert.throws(() => new FFT(12));
  const sp = kernelSpectrum(Float64Array.of(1), 8);
  assert.deepEqual(Array.from(sp.re), [1, 1, 1, 1, 1, 1, 1, 1]);
});

test("Hamming window and firwin low-pass as scipy computes them", () => {
  const w = hammingSymmetric(5);
  assert.ok(Math.abs(w[0] - 0.08) < 1e-15 && Math.abs(w[2] - 1) < 1e-15 && Math.abs(w[1] - 0.54) < 1e-15);
  const h = firwinLowpass(31, 0.25);
  let s = 0;
  for (const v of h) s += v;
  assert.ok(Math.abs(s - 1) < 1e-14);
  for (let i = 0; i < 15; i++) assert.ok(Math.abs(h[i] - h[30 - i]) < 1e-16);
});

test("filter lengths as MNE gives them for the desktop's settings", () => {
  // high-pass 1 Hz: transition 1 Hz, 3.3 s; notch: 0.5 Hz transitions, 6.6 s
  assert.equal(designHighpass(256, 1).length, 845);
  assert.equal(designHighpass(1024, 1).length, 3381);
  assert.equal(designNotch(256, [50]).length, 1691);
  assert.equal(designNotch(1024, [50]).length, 6759);
  assert.equal(autoFilterLength(1, 1000), 3301); // 3.3 * 1000 is 3299.9999999999995 in floating point
});

test("every design matches mne.filter.create_filter", () => {
  ensureFixtures();
  const designs = expected("filters");
  assert.ok(designs.length > 80);
  for (const r of designs) {
    const label = `${r.kind} ${r.hz} Hz at ${r.sfreq} Hz${r.harmonics ? " with harmonics" : ""}`;
    if (r.error) {
      assert.throws(() => designNotch(r.sfreq, notchFrequencies(r.sfreq, r.hz, r.harmonics)), label);
      continue;
    }
    const d = r.kind === "highpass" ? designHighpass(r.sfreq, r.hz) : designNotch(r.sfreq, notchFrequencies(r.sfreq, r.hz, r.harmonics));
    assert.equal(d.length, r.length, label);
    if (r.freqs) assert.deepEqual(d.freqs, r.freqs, label);
    const vals = r.h.full ?? r.h.values;
    const idx = r.h.full ? vals.map((_, i) => i) : r.h.indices;
    let scale = 0;
    for (const v of vals) scale = Math.max(scale, Math.abs(v));
    idx.forEach((i, k) => assert.ok(Math.abs(d.h[i] - vals[k]) <= 1e-13 * scale, `${label}: tap ${i}`));
    let sum = 0;
    for (const v of d.h) sum += v;
    assert.ok(Math.abs(sum - r.h.sum) < 1e-12, label);
  }
});

test("notch frequencies and harmonics stop below Nyquist minus 1 Hz", () => {
  assert.deepEqual(notchFrequencies(256, 50, false), [50]);
  assert.deepEqual(notchFrequencies(256, 50, true), [50, 100]);
  assert.deepEqual(notchFrequencies(1000, 60, true), [60, 120, 180, 240, 300, 360, 420, 480]);
  assert.deepEqual(notchFrequencies(100, 50, false), []);
  const p = planFilters(100, { highpassHz: 60, notchHz: 50 });
  assert.equal(p.steps.length, 0);
  assert.equal(p.skipped.length, 2);
});

test("filter plans: keys, half widths and the combined kernel", () => {
  assert.equal(filterKey(256, null), "none");
  assert.equal(filterKey(256, { highpassHz: null, notchHz: null }), "none");
  assert.equal(filterKey(256, { highpassHz: 1, notchHz: 50, notchHarmonics: true }), filterKey(256, { highpassHz: 1.0, notchHz: 50.0, notchHarmonics: 1 }));
  assert.notEqual(filterKey(256, { highpassHz: null, notchHz: 50, notchHarmonics: true }), filterKey(256, { highpassHz: null, notchHz: 50 }));
  const p = planFilters(256, { highpassHz: 1, notchHz: 50 });
  assert.equal(p.halfWidth, 422 + 845);
  assert.equal(p.combined.length, 845 + 1691 - 1);
  assert.equal(planFilters(256, { highpassHz: 1, notchHz: 50 }), p, "plans are cached");
});

test("far from edges the one-pass combined filter equals the two passes", () => {
  const plan = planFilters(256, { highpassHz: 1, notchHz: 50 });
  const n = 9000;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = Math.sin(i / 7) + 0.3 * Math.sin((2 * Math.PI * 50 * i) / 256) + 1e-3 * i;
    y[i] = Math.cos(i / 3) * (i % 17);
  }
  const o0 = 3000;
  const o1 = 4500;
  const [fast, fastY] = filterPair(plan, x, y, 0, 0, n, o0, o1); // whole support inside: one pass
  // the same samples computed through the two-pass path (an artificial segment edge far away)
  const seq = { ...plan, combined: null };
  const [slow, slowY] = filterPair(seq, x, y, 0, 0, n, o0, o1);
  for (let i = 0; i < o1 - o0; i++) {
    assert.ok(Math.abs(fast[i] - slow[i]) < 1e-12);
    assert.ok(Math.abs(fastY[i] - slowY[i]) < 1e-11);
  }
});

test("edge zones as the desktop hatches them", () => {
  assert.deepEqual(edgeZonesFor(1000, [], 100), [
    [0, 100],
    [900, 1000],
  ]);
  assert.deepEqual(edgeZonesFor(1000, [500, 550], 100), [
    [0, 100],
    [400, 650],
    [900, 1000],
  ]);
  assert.deepEqual(edgeZonesFor(150, [], 100), [[0, 150]]);
  assert.deepEqual(edgeZonesFor(1000, [500], 0), []);
});
