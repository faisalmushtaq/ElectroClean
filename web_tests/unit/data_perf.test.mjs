// Timing of the data layer on a 128-channel, 30-minute, 1024 Hz BDF recording (713 MB) with a
// Status channel. The recording is large, so this test runs only when it exists
// (python scripts/make_web_fixtures.py --perf) or when ELECTROCLEAN_PERF=1 asks for it to be made.
// It checks the results and reports the times; it does not fail on slow machines.

import assert from "node:assert/strict";
import { existsSync, openAsBlob, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { openRecording } from "../../electroclean/web/static/js/data/recording.js";
import { sha256Blob } from "../../electroclean/web/static/js/data/sha256.js";
import { FIXTURES, ensureFixtures } from "./_fixtures.mjs";

function perfInfo() {
  if (process.env.ELECTROCLEAN_PERF === "1") return ensureFixtures({ perf: true }).perf;
  try {
    const m = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));
    return m.perf && existsSync(join(FIXTURES, m.perf.file)) ? m.perf : null;
  } catch {
    return null;
  }
}

const perf = perfInfo();

test("timing on a 128-channel, 30-minute BDF", { skip: perf ? false : "no timing recording (python scripts/make_web_fixtures.py --perf)", timeout: 15 * 60 * 1000 }, async (t) => {
  const file = new File([await openAsBlob(join(FIXTURES, perf.file))], perf.file);
  const mb = perf.size_bytes / 1e6;
  const ms = (t0) => performance.now() - t0;

  let t0 = performance.now();
  const hex = await sha256Blob(file, { native: false });
  const shaMs = ms(t0);
  assert.equal(hex, perf.sha256);
  t.diagnostic(`SHA-256 streamed (JavaScript): ${(mb / (shaMs / 1000)).toFixed(0)} MB/s (${(shaMs / 1000).toFixed(1)} s for ${mb.toFixed(0)} MB)`);

  t0 = performance.now();
  const quick = await openRecording([file], { worker: false, fingerprint: false });
  t.diagnostic(`open, scanning the Status channel, no fingerprint: ${(ms(t0) / 1000).toFixed(2)} s`);
  assert.equal(quick.markers.length, perf.n_events);
  quick.close();

  t0 = performance.now();
  const rec = await openRecording([file], { worker: false });
  t.diagnostic(`open with the fingerprint computed in the same pass: ${(ms(t0) / 1000).toFixed(2)} s`);
  assert.equal(rec.nSamples, perf.n_samples);
  assert.equal(rec.channels.length, perf.n_channels);
  assert.equal((await rec.fingerprint()).hex, perf.sha256);

  const chans = rec.channels.map((_, i) => i).filter((i) => rec.channels[i].type !== "stim");
  const filters = { highpassHz: 1, notchHz: 50, notchHarmonics: false };
  const n = 10 * 1024;
  const time = async (label, req) => {
    const t1 = performance.now();
    const r = await rec.readWindow(req);
    const d = ms(t1);
    assert.equal(r.data.length, req.channels.length);
    t.diagnostic(`${label}: ${d.toFixed(0)} ms`);
    return d;
  };
  await time("128 channels x 10 s unfiltered (cold)", { startSample: 400 * 1024, nSamples: n, channels: chans });
  await time("128 channels x 10 s, high-pass 1 Hz and notch 50 Hz (cold)", { startSample: 600 * 1024, nSamples: n, channels: chans, filters });
  await new Promise((r) => setTimeout(r, 3000)); // the next window is prefetched meanwhile
  await time("the next 10 s (prefetched)", { startSample: 610 * 1024, nSamples: n, channels: chans, filters });
  await new Promise((r) => setTimeout(r, 3000));
  await time("the next 10 s (prefetched)", { startSample: 620 * 1024, nSamples: n, channels: chans, filters });
  await time("32 channels x 10 s elsewhere (cold)", { startSample: 1200 * 1024, nSamples: n, channels: chans.slice(0, 32), filters });
  rec.close();
});
