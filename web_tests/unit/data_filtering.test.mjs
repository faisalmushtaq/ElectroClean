// Display filters in the browser compared with the desktop application's own filtering
// (electrotag.app.eeg.filtering.apply_view_filters, which calls MNE-Python), window by window:
// at the start and end of the recording, around stretches without data (BAD_ACQ_SKIP), around a
// BrainVision discontinuity and in segments shorter than the filter. Also the hatched edge zones,
// the caching of filtered pieces and the channels that are never filtered.

import assert from "node:assert/strict";
import test from "node:test";

import { Engine } from "../../electrotag/web/static/js/eeg/engine.js";
import { planFilters } from "../../electrotag/web/static/js/eeg/filters.js";
import { openRecording } from "../../electrotag/web/static/js/eeg/recording.js";
import { ensureFixtures, expected, fixtureFiles } from "./_fixtures.mjs";

const manifest = ensureFixtures();
const LOWER_RATE = { edf_mixed: ["Resp"] };
for (const [name, f] of Object.entries(manifest.fixtures)) if (f.lower_rate) LOWER_RATE[name] = f.lower_rate;
const WITH_FILTERS = Object.entries(manifest.fixtures)
  .filter(([name, f]) => !f.error && !f.mne_error && expected(name).filtered.length)
  .map(([name]) => name);

async function open(name, options = {}) {
  return openRecording(await fixtureFiles(manifest, name), { worker: false, ...options });
}

/**
 * The tolerance: the browser returns float32 samples, so each value may differ from MNE's float64 by
 * half a float32 step (6e-8 of the value); 1.2e-7 of the largest value of the channel in the
 * window covers that and the rounding of the FFT, plus 1e-12 of the unfiltered input for channels
 * whose filtered output is almost zero (a constant channel, say).
 */
function compare(got, want, raw, label) {
  let scale = 0;
  let rawScale = 0;
  for (const v of want) scale = Math.max(scale, Math.abs(v));
  for (const v of raw) rawScale = Math.max(rawScale, Math.abs(v));
  const tol = 1.2e-7 * scale + 1e-12 * rawScale + 1e-300;
  let worst = 0;
  for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
  assert.ok(worst <= tol, `${label}: largest difference ${worst} > ${tol}`);
  return scale ? worst / scale : 0;
}

for (const name of WITH_FILTERS) {
  test(`${name}: filtered windows match the desktop's MNE filtering`, async (t) => {
    const exp = expected(name);
    const rec = await open(name);
    const skip = new Set((LOWER_RATE[name] || []).map((n) => exp.ch_names.indexOf(n)));
    let worst = 0;
    try {
      for (const f of exp.filtered) {
        for (const w of f.windows) {
          const r = await rec.readWindow({ startSample: w.start, nSamples: w.n, filters: f.filters });
          const raw = await rec.readWindow({ startSample: w.start, nSamples: w.n });
          w.values.forEach((row, c) => {
            if (skip.has(c)) return; // resampled differently, see data_readers.test.mjs
            worst = Math.max(worst, compare(r.data[c], row, raw.data[c], `${JSON.stringify(f.filters)} ${exp.ch_names[c]} @${w.start}`));
          });
        }
        // the hatched zones are the desktop's (FilterReport.transient_zones), in samples
        const zones = rec.edgeZones(f.filters).map(([a, b]) => [a / rec.sfreq, b / rec.sfreq]);
        assert.equal(zones.length, f.zones_s.length);
        zones.forEach(([a, b], i) => {
          assert.ok(Math.abs(a - f.zones_s[i][0]) < 1e-9 && Math.abs(b - f.zones_s[i][1]) < 1e-9, `zone ${i}`);
        });
      }
      t.diagnostic(`largest difference relative to the window's largest value: ${worst.toExponential(2)}`);
    } finally {
      rec.close();
    }
  });
}

test("windows report the edge zones they touch", async () => {
  const rec = await open("edfplus_gap");
  try {
    const filters = { highpassHz: 1, notchHz: 50 };
    const all = rec.edgeZones(filters);
    const r = await rec.readWindow({ startSample: 7000, nSamples: 1000, filters });
    assert.deepEqual(r.edgeZones, all.filter(([a, b]) => a < 8000 && b > 7000));
    assert.ok(r.edgeZones.length >= 1);
    const none = await rec.readWindow({ startSample: 7000, nSamples: 1000 });
    assert.deepEqual(none.edgeZones, []);
    assert.deepEqual(rec.edgeZones(null), []);
  } finally {
    rec.close();
  }
});

test("gaps keep their samples unfiltered; trigger channels are never filtered", async () => {
  const rec = await open("edfplus_gap");
  try {
    const [g0, g1] = rec.gaps[0];
    const raw = await rec.readWindow({ startSample: g0, nSamples: g1 - g0 });
    const f = await rec.readWindow({ startSample: g0, nSamples: g1 - g0, filters: { highpassHz: 1, notchHz: 50 } });
    raw.data.forEach((d, c) => assert.deepEqual(f.data[c], d));
  } finally {
    rec.close();
  }
  const mixed = await open("edf_mixed");
  try {
    const trig = mixed.channels.findIndex((c) => c.name === "Trigger");
    const raw = await mixed.readWindow({ startSample: 0, nSamples: 5120, channels: [trig] });
    const f = await mixed.readWindow({ startSample: 0, nSamples: 5120, channels: [trig], filters: { highpassHz: 1, notchHz: 50 } });
    assert.deepEqual(f.data[0], raw.data[0]);
    // a channel made a trigger channel by the study's types is not filtered either
    mixed.setChannelTypes({ Fp1: "stim" });
    const fp1 = mixed.channels.findIndex((c) => c.name === "Fp1");
    const a = await mixed.readWindow({ startSample: 100, nSamples: 1000, channels: [fp1], filters: { highpassHz: 1, notchHz: 50 } });
    const b = await mixed.readWindow({ startSample: 100, nSamples: 1000, channels: [fp1] });
    assert.deepEqual(a.data[0], b.data[0]);
  } finally {
    mixed.close();
  }
});

test("cached, prefetched and freshly computed pieces give the same samples", async () => {
  const exp = expected("bv_float32");
  const f = exp.filtered[0];
  const filters = f.filters;
  const scroll = await open("bv_float32");
  const fresh = await open("bv_float32");
  try {
    // scroll forwards, backwards and jump, with subsets of channels, then compare with a reader
    // that computes each window from nothing
    const steps = [
      [0, 2500, null],
      [2500, 2500, [0, 1, 2]],
      [5000, 2500, null],
      [2500, 2500, null],
      [15000, 5000, [3, 4, 5, 6, 7]],
      [17000, 3000, null],
      [9000, 2000, null],
    ];
    for (const [start, n, chans] of steps) {
      const a = await scroll.readWindow({ startSample: start, nSamples: n, channels: chans, filters });
      await new Promise((r) => setTimeout(r, 5)); // let a prefetch start
      const fresh2 = await open("bv_float32");
      const b = await fresh2.readWindow({ startSample: start, nSamples: n, channels: chans, filters, prefetch: false });
      fresh2.close();
      a.data.forEach((d, c) => {
        for (let i = 0; i < d.length; i++) assert.ok(Math.abs(d[i] - b.data[c][i]) <= 1e-12 + 1e-6 * Math.abs(b.data[c][i]), `window ${start} ch ${c}`);
      });
    }
    // a window across the discontinuity is assembled from two segments, as the desktop filters them
    const w = f.windows.find((x) => x.start < 10000 && x.start + x.n > 10000);
    const r = await fresh.readWindow({ startSample: w.start, nSamples: w.n, filters });
    const raw = await fresh.readWindow({ startSample: w.start, nSamples: w.n });
    w.values.forEach((row, c) => compare(r.data[c], row, raw.data[c], `across the discontinuity, channel ${c}`));
  } finally {
    scroll.close();
    fresh.close();
  }
});

test("requests outside the recording are clipped to it", async () => {
  const rec = await open("bdfplus");
  try {
    const r = await rec.readWindow({ startSample: -100, nSamples: 300, channels: [0], filters: { highpassHz: 1, notchHz: 50 } });
    assert.equal(r.startSample, 0);
    assert.equal(r.nSamples, 200);
    const end = await rec.readWindow({ startSample: rec.nSamples - 10, nSamples: 100, channels: [1] });
    assert.equal(end.nSamples, 10);
    const empty = await rec.readWindow({ startSample: rec.nSamples + 5, nSamples: 10, channels: [1] });
    assert.equal(empty.nSamples, 0);
    assert.equal(empty.data[0].length, 0);
    await assert.rejects(rec.readWindow({ startSample: 0, nSamples: 10, channels: [999] }), /No channel 999/);
  } finally {
    rec.close();
  }
});

test("a window that a prefetch is already filtering waits for it, without a deadlock", { timeout: 30000 }, async () => {
  // A prefetch pauses while the annotator's own requests are served; when such a request needs the
  // very piece the prefetch is filtering, the prefetch must carry on instead of waiting for it.
  const engine = new Engine({ cooperative: true });
  await engine.open(await fixtureFiles(manifest, "bv_float32"), {});
  try {
    const filters = { highpassHz: 1, notchHz: 50 };
    const plan = planFilters(engine.sfreq, filters);
    const chans = engine.channels.map((_, i) => i);
    engine.foreground = 1; // as if another window were being read
    const prefetch = engine._prefetch(plan, 4500, 7000, chans, 1);
    await new Promise((r) => setTimeout(r, 0)); // the prefetch now waits for the reads to finish
    const next = await engine.readWindow({ startSample: 4500, nSamples: 2500, filters });
    await prefetch;
    const fresh = await open("bv_float32");
    const ref = await fresh.readWindow({ startSample: 4500, nSamples: 2500, filters, prefetch: false });
    fresh.close();
    next.data.forEach((d, c) => assert.deepEqual(d, ref.data[c]));
  } finally {
    engine.foreground = 0;
    engine.close();
  }
});
