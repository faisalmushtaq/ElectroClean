// Drawing speed: 128 channels × 10 s × 1024 Hz on screen (the aim is under 30 ms per redraw).
import { signIn, waitForRoute, waitForTraces } from './helpers.mjs';

async function measure(t, scale) {
  const page = await t.newPage({ scale });
  await signIn(page, 'A01');
  await waitForRoute(page, 'home');
  await page.evaluate(async () => {
    const { makeSyntheticRecording } = await import(new URL('js/data/synthetic.js', location.href).href);
    const channels = Array.from({ length: 128 }, (_, i) => `E${i + 1}`);
    const recording = makeSyntheticRecording({ id: 'perf', stem: 'sub-perf_task-rest', sfreq: 1024, durationS: 30, seed: 5, channels, artifacts: [] });
    await globalThis.ElectroTag.openWorkspace({ recording, match: { status: 'unknown' }, sha: '', tryOut: true });
    globalThis.ElectroTag.ws.viewer.setView({ nChannels: 128, durationS: 10, startS: 5 });
  });
  await waitForTraces(page);
  await page.waitForFunction(() => globalThis.ElectroTag.ws.viewer._covers());
  const r = await page.evaluate(async () => {
    const v = globalThis.ElectroTag.ws.viewer;
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const run = async (positions, cold) => {
      const full = []; const dec = []; let layers = null;
      for (const startS of positions) {
        if (cold) v._decimated = null;
        v.setView({ startS });
        const t0 = performance.now();
        v._dirty = { under: true, traces: true, over: true, overview: true };
        v._render();
        full.push(performance.now() - t0);
        dec.push(v.stats.decimateMs || 0);
        layers = v.stats.layers;
        await new Promise((res) => requestAnimationFrame(res));
      }
      return { full: med(full), max: Math.max(...full), decimate: med(dec), layers };
    };
    // A whole new screen each time (as after a jump or a change of zoom) …
    const cold = await run([5, 5.2, 5.4, 5.6, 5.8, 5, 5.2, 5.4, 5.6, 5.8, 5, 5.2, 5.4, 5.6, 5.8], true);
    // … and scrolling with the arrow keys (a quarter of a screen) and the wheel (smaller steps).
    const scroll = await run([5, 7.5, 5, 7.5, 5, 7.5, 5.5, 6, 6.5, 7, 7.5, 7, 6.5, 6, 5.5], false);
    return { cold, scroll, rows: v.visibleRows().length, cols: Math.round(v.plotW * v.dpr), dpr: v.dpr };
  });
  if (t.shots) await t.screenshot(page, `perf_128ch_dpr${scale}`);
  return r;
}

export const tests = [
  {
    name: '128 channels × 10 s × 1024 Hz: redraw times',
    async run(t) {
      for (const scale of [1, 2]) {
        const r = await measure(t, scale);
        console.log(`     device pixel ratio ${r.dpr}, ${r.rows} channels × ${r.cols} pixel columns: new screen ${r.cold.full.toFixed(1)} ms ` +
          `(min/max ${r.cold.decimate.toFixed(1)} ms, slowest ${r.cold.max.toFixed(1)} ms); scrolling ${r.scroll.full.toFixed(1)} ms (slowest ${r.scroll.max.toFixed(1)} ms; last ${JSON.stringify(r.scroll.layers)})`);
        t.assert.equal(r.rows, 128);
        // The aim is under 30 ms on an annotator's computer. Test machines are often slower and
        // busy with other work, so the test only catches large slowdowns; the figures are printed.
        t.assert.ok(r.scroll.full < 100, `scrolling redraw took ${r.scroll.full.toFixed(1)} ms`);
        t.assert.ok(r.cold.full < 100, `a new screen took ${r.cold.full.toFixed(1)} ms`);
      }
    },
  },
];
