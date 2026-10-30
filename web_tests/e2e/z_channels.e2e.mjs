// Recordings of 1, 32, 128 and 256 channels opened from the computer, as an annotator opens a file:
// EDF files written at test time (10-20 names, EGI's E1 to E128, BioSemi's A1 to H32 with an
// electrodes.tsv), checked against rules that hold at every channel count rather than against
// pixel positions. Rows are never taller than the viewer's MAX_ROW_H and stay inside the plot;
// channel names are never under 11 pixels, never closer than their size, and the last one is never
// cut off by the time axis; with most of 256 channels selected, the selected names never cover each
// other. A redraw of 256 channels stays under a budget. The channel map opens with the whole head in
// view and the count of channels chosen visible without scrolling; the recording's positions give
// Regions and Sides and the colours by region. The overlay of 256 channels redraws within the
// budget, and Show all of a long read keeps blocks' minima and maxima rather than every sample. A
// marker file of 100,000 events (as a 256-channel EGI recording can have) leaves redraws as fast.
// Runs in Chromium and WebKit (node web_tests/run_e2e.mjs z_channels --browser webkit).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signIn, waitForRoute, waitForTraces } from './helpers.mjs';
import { syntheticEdfBytes } from '../../electrotag/web/static/js/eeg/synthetic.js';

const range = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
const BIOSEMI = [...'ABCDEFGH'].flatMap((b) => range(b, 1, 32));
const TEN_TWENTY_32 = ['Fp1', 'Fp2', 'F7', 'F3', 'Fz', 'F4', 'F8', 'FC5', 'FC1', 'FC2', 'FC6', 'T7', 'C3', 'Cz', 'C4', 'T8', 'CP5', 'CP1',
  'CP2', 'CP6', 'P7', 'P3', 'Pz', 'P4', 'P8', 'PO3', 'PO4', 'O1', 'Oz', 'O2', 'HEOG', 'VEOG'];
// Generous for test machines, which are slow and busy; the figures are printed.
const REDRAW_BUDGET_MS = 250;

/** Positions on a cap (CapTrak, mm): `n` points spread evenly from the vertex to below the ears. */
function capPositions(names) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const rows = names.map((name, i) => {
    const z = 1 - ((i + 0.5) / names.length) * 1.3;
    const r = Math.sqrt(1 - z * z);
    return `${name}\t${(90 * r * Math.cos(i * golden)).toFixed(2)}\t${(90 * r * Math.sin(i * golden)).toFixed(2)}\t${(90 * z).toFixed(2)}`;
  });
  return ['name\tx\ty\tz', ...rows, ''].join('\n');
}

/** An EDF file (and the electrodes.tsv beside it) in a folder of its own; returns the paths to choose. */
function writeRecording(dir, id, channels, { sfreq = 256, durationS = 30, positions = false } = {}) {
  const stem = `sub-${id}_task-rest`;
  const folder = path.join(dir, id);
  fs.mkdirSync(folder, { recursive: true });
  const edf = path.join(folder, `${stem}_eeg.edf`);
  fs.writeFileSync(edf, syntheticEdfBytes({ id, stem, sfreq, durationS, seed: 11, channels, artifacts: [] }));
  const out = [edf];
  if (positions) {
    out.push(path.join(folder, `${stem}_electrodes.tsv`), path.join(folder, `${stem}_coordsystem.json`));
    fs.writeFileSync(out[1], capPositions(channels));
    fs.writeFileSync(out[2], '{"EEGCoordinateSystem": "CapTrak", "EEGCoordinateUnits": "mm"}');
  }
  return out;
}

/** Open files from the computer as a file outside the study (try-out), and wait for the EEG; returns the time taken (ms). */
async function openFiles(page, files) {
  await page.evaluate(() => { location.hash = '#home'; });
  await waitForRoute(page, 'home');
  await page.click('text=Open a recording from your computer…');
  await waitForRoute(page, 'open');
  const t0 = Date.now();
  await page.setInputFiles('input[data-log="file-input"]', files);
  await page.click('text=Look at it without saving', { timeout: 60000 });
  await waitForRoute(page, 'annotate');
  await waitForTraces(page);
  return Date.now() - t0;
}

const ws = (page, fn, arg) => page.evaluate(([src, a]) => (0, eval)(src)(globalThis.ElectroTag.ws, a), [String(fn), arg]);

/** Show `n` channels from the first and wait until they are read and drawn. */
async function showChannels(page, n) {
  await ws(page, (w, k) => w.viewer.setView({ nChannels: k, firstChannel: 0 }), n);
  await page.waitForFunction(() => { const v = globalThis.ElectroTag.ws.viewer; return v._covers() && !v._loading; }, null, { timeout: 30000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
}

/** The rows and names as drawn now: their geometry and every name's centre (y), selected or not. */
async function rowsAndNames(page) {
  return ws(page, (w) => {
    const v = w.viewer;
    v._render();
    const rows = v.visibleRows();
    const first = v.view.firstChannel;
    const named = rows.filter(({ row }) => !((row - first) % v._names.every)).map(({ row, ch }) => ({ name: ch.name, y: v.rowCentre(row) }));
    const boxed = (v._names.boxed || []).map((name) => ({ name, y: v.rowCentre(v.channels.findIndex((c) => c.name === name)) }));
    const selected = new Set(v.channelsActive ? v.selectedChannels : []);
    return { rowH: v.rowH, top: v.rowsTop, y0: v.y0, y1: v.y1, H: v.H, n: rows.length, lastBottom: v.rowCentre(rows[rows.length - 1].row) + v.rowH / 2,
      px: v._names.px, every: v._names.every, named, boxed, selectedNamed: [...named.filter((x) => selected.has(x.name)), ...boxed] };
  });
}

/** The median time of a whole redraw (every layer, the columns worked out again), in ms. */
async function redrawMs(page) {
  return ws(page, (w) => {
    const v = w.viewer;
    const times = [];
    for (let i = 0; i < 7; i++) {
      v._decimated = null;
      v._dirty = { under: true, traces: true, over: true, overview: true };
      const t0 = performance.now();
      v._render();
      times.push(performance.now() - t0);
    }
    return times.sort((a, b) => a - b)[3];
  });
}

function checkRows(assert, r, label) {
  assert.ok(r.rowH <= 120 + 1e-9, `${label}: rows of ${r.rowH.toFixed(1)} px, never over 120`);
  assert.ok(r.top >= r.y0 - 1e-9 && r.lastBottom <= r.y1 + 1e-6, `${label}: the rows inside the plot`);
  assert.ok(r.px >= 11, `${label}: names of ${r.px} px`);
  assert.ok(r.every * r.rowH >= r.px - 1 - 1e-9, `${label}: names ${(r.every * r.rowH).toFixed(1)} px apart, for ${r.px} px names`);
  const last = r.named[r.named.length - 1];
  assert.ok(last && last.y + r.px / 2 <= r.H, `${label}: the last name (${last && last.name}) inside the canvas`);
}

export const tests = [
  {
    name: 'recordings of 1, 32, 128 and 256 channels from the computer: rows, names and redraws by rule',
    async run(t) {
      const { assert } = t;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-channels-'));
      try {
        const page = await t.newPage({ width: 1440, height: 900 });
        await signIn(page, 'A01');
        await waitForRoute(page, 'home');
        const cases = [
          { id: 'one', channels: ['Cz'], durationS: 20 },
          { id: 'tentwenty', channels: TEN_TWENTY_32, durationS: 20 },
          { id: 'egi', channels: range('E', 1, 128), sfreq: 500, durationS: 20 },
          { id: 'egiall', channels: range('E', 1, 256), sfreq: 256, durationS: 30 },
        ];
        for (const c of cases) {
          const ms = await openFiles(page, writeRecording(dir, c.id, c.channels, c));
          const n = c.channels.length;
          const first = await rowsAndNames(page);
          checkRows(assert, first, `${n} channels, first view`);
          await showChannels(page, n);
          const all = await rowsAndNames(page);
          checkRows(assert, all, `${n} channels, all on screen`);
          assert.equal(all.n, n);
          const redraw = await redrawMs(page);
          console.log(`     ${n} channels: opened in ${ms} ms; rows of ${all.rowH.toFixed(1)} px, names of ${all.px} px every ${all.every}; a whole redraw ${redraw.toFixed(1)} ms`);
          assert.ok(redraw < REDRAW_BUDGET_MS, `a redraw of ${n} channels took ${redraw.toFixed(1)} ms`);
          if (n <= 2) assert.ok(all.top > all.y0 + 50, 'one channel sits in the middle of the plot');
          await t.screenshot(page, `channels_${n}`);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '256 BioSemi channels with an electrodes.tsv: the map, regions from the positions, 180 channels selected and marked, the overlay and Show all',
    async run(t) {
      const { assert } = t;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-channels-'));
      try {
        const page = await t.newPage({ width: 1440, height: 900 });
        await signIn(page, 'A01');
        await waitForRoute(page, 'home');
        await openFiles(page, writeRecording(dir, 'biosemi', BIOSEMI, { sfreq: 256, durationS: 60, positions: true }));
        await page.waitForFunction(() => Boolean(globalThis.ElectroTag.ws.electrodes));

        // the map: the recording's positions, the whole head in view, the count under it without scrolling
        let t0 = Date.now();
        await page.click('.ws-toolbar button:has-text("Channels…")');
        await page.waitForSelector('.dialog .channel-chooser');
        if (await page.isHidden('.dialog .channel-map-block')) await page.click('[data-log="channel-view-map"]');
        await page.waitForSelector('.dialog .channel-map-block:not([hidden]) .map-electrode');
        const openMs = Date.now() - t0;
        const map = await page.evaluate(() => {
          const block = document.querySelector('.dialog .channel-map-block');
          const vp = block.querySelector('.map-viewport').getBoundingClientRect();
          const head = block.querySelector('.map-head svg').getBoundingClientRect();
          const inVp = (r) => r.left >= vp.left - 1 && r.right <= vp.right + 1 && r.top >= vp.top - 1 && r.bottom <= vp.bottom + 1;
          const els = [...block.querySelectorAll('.map-electrode')].map((b) => b.getBoundingClientRect());
          const body = document.querySelector('.dialog .dialog-body').getBoundingClientRect();
          const count = document.querySelector('.dialog .channel-count').getBoundingClientRect();
          return { source: block.dataset.source, head: inVp(head), all: els.every((r) => inVp({ left: r.left + r.width / 2, right: r.left + r.width / 2, top: r.top + r.height / 2, bottom: r.top + r.height / 2 })),
            n: els.length, countVisible: count.top >= body.top && count.bottom <= body.bottom + 1, groups: [...document.querySelectorAll('.dialog .channel-groups-caption')].map((e) => e.textContent) };
        });
        console.log(`     the map of 256 electrodes opened in ${openMs} ms`);
        assert.equal(map.source, 'file');
        assert.equal(map.n, 256);
        assert.ok(map.head && map.all, 'the whole head and every electrode in view');
        assert.ok(map.countVisible, 'the count of channels chosen is in view without scrolling');
        assert.deepEqual(map.groups, ['Regions', 'Sides', 'Banks'], 'regions and sides from the positions, beside the banks');
        await t.screenshot(page, 'channels_256_map');
        // a box round most of the head, then OK
        const box = await page.evaluate(() => {
          const r = document.querySelector('.dialog .map-head svg').getBoundingClientRect();
          return { x0: r.left + 2, y0: r.top + 2, x1: r.right - 2, y1: r.top + r.height * 0.8 };
        });
        await page.mouse.move(box.x0, box.y0);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) await page.mouse.move(box.x0 + ((box.x1 - box.x0) * i) / 8, box.y0 + ((box.y1 - box.y0) * i) / 8);
        await page.mouse.up();
        const chosen = Number((await page.textContent('.dialog .channel-count')).match(/^(\d+)/)[1]);
        assert.ok(chosen > 100 && chosen < 256, `${chosen} chosen with the box`);
        await page.click('.dialog-buttons button:has-text("OK")');

        // 180 channels selected: every name at least 11 px, and the selected names never cover each other
        await ws(page, (w) => { w.setScope('channels'); w.setSelectedChannels(w.s.channels.slice(0, 180).map((c) => c.name)); });
        await showChannels(page, 256);
        const r = await rowsAndNames(page);
        checkRows(assert, r, '256 channels, 180 selected');
        const ys = r.selectedNamed.map((x) => x.y).sort((a, b) => a - b);
        for (const b of r.boxed) {
          const near = ys.filter((y) => y !== b.y && Math.abs(y - b.y) < r.px + 4);
          assert.deepEqual(near, [], `the boxed name ${b.name} covers no other selected name`);
        }
        assert.ok(r.selectedNamed.length >= 180 / (2 * r.every), `${r.selectedNamed.length} of the selected channels named`);
        // a mark on them: one short line in the list
        await page.keyboard.press('1');
        const p = await ws(page, (w) => { const v = w.viewer; const b = v.over.getBoundingClientRect(); return { y: b.top + v.rowCentre(10), x0: b.left + v.tToX(2), x1: b.left + v.tToX(3) }; });
        await page.mouse.move(p.x0, p.y);
        await page.mouse.down();
        for (let i = 1; i <= 6; i++) await page.mouse.move(p.x0 + ((p.x1 - p.x0) * i) / 6, p.y);
        await page.mouse.up();
        assert.match(await page.textContent('tr[data-id] .chans'), /^180 ch: A1, A2, A3, …$/);
        await t.screenshot(page, 'channels_256_selected');

        // colours by region from the positions
        await page.click('.tab[data-tab="recording"]');
        await page.selectOption('#channel-colours', 'region');
        const legend = await page.$$eval('.channel-legend li', (lis) => lis.map((li) => li.textContent));
        assert.ok(legend.some((x) => /^Frontal\d+$/.test(x)) && legend.some((x) => /^Occipital\d+$/.test(x)), legend.join(', '));
        assert.ok(await ws(page, (w) => w.viewer.channelColours && w.viewer.channelColours.size > 200), 'the traces take the colours');
        await page.selectOption('#channel-colours', 'off');

        // the overlay of 256 channels
        await page.evaluate(() => globalThis.ElectroTag.ws.viewer.over.focus());
        await page.keyboard.press('o');
        await page.waitForFunction(() => globalThis.ElectroTag.ws.viewer.overlay);
        const overlay = await redrawMs(page);
        console.log(`     the overlay of 256 channels: a whole redraw ${overlay.toFixed(1)} ms`);
        assert.ok(overlay < REDRAW_BUDGET_MS, `the overlay's redraw took ${overlay.toFixed(1)} ms`);
        await t.screenshot(page, 'channels_256_overlay');
        await page.keyboard.press('o');

        // Show all, read in pieces: blocks' minima and maxima, a few values per pixel column
        await ws(page, (w) => { w.viewer.pieceValues = 2e5; });
        t0 = Date.now();
        await page.keyboard.press('Shift+End');
        await page.waitForFunction(() => { const v = globalThis.ElectroTag.ws.viewer; return v.view.durationS >= v.durationTotal - 1e-6 && v._covers() && !v._loading; }, null, { timeout: 60000 });
        const all = await ws(page, (w) => {
          const v = w.viewer;
          let values = 0;
          for (const d of v._cache.rows.values()) values += d.length;
          return { step: v._cache.step, values, cols: Math.round(v.plotW), rows: v._cache.rows.size, readout: v.valueAt(v.over.getBoundingClientRect().left + v.x0 + 50, v.over.getBoundingClientRect().top + v.rowCentre(3)) };
        });
        console.log(`     Show all of 256 channels × 60 s in ${Date.now() - t0} ms: blocks of ${all.step} samples, ${all.values} values kept`);
        assert.ok(all.step >= 4, 'kept as blocks');
        // two blocks or more to a column: at most 8 values a column, however long the recording
        assert.ok(all.values <= 8 * all.cols * all.rows + 4 * all.rows, `${all.values} values for ${all.rows} channels × ${all.cols} columns`);
        assert.equal(all.readout, null, 'no value under the pointer from blocks');
        await t.screenshot(page, 'channels_256_show_all');
        await page.keyboard.press('Shift+End');
        await page.waitForFunction(() => { const v = globalThis.ElectroTag.ws.viewer; return v.view.durationS < 30 && v._covers() && !v._loading; }, null, { timeout: 30000 });
        assert.equal(await ws(page, (w) => w.viewer._cache.step), 1, 'back to the samples themselves');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '256 channels with 100,000 events: the events on screen and the overview leave a redraw within the budget',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await page.evaluate(async () => {
        const { makeSyntheticRecording } = await import(new URL('js/eeg/synthetic.js', location.href).href);
        const channels = Array.from({ length: 256 }, (_, i) => `E${i + 1}`);
        const events = Array.from({ length: 100000 }, (_, i) => ({ onsetS: (i * 400) / 100000, label: `DIN${i % 4}` }));
        const recording = makeSyntheticRecording({ id: 'events', stem: 'sub-events_task-rest', sfreq: 250, durationS: 400, seed: 5, channels, artifacts: [], events });
        await globalThis.ElectroTag.openWorkspace({ recording, match: { status: 'unknown' }, sha: '', tryOut: true });
      });
      await waitForTraces(page);
      await showChannels(page, 256);
      const redraw = await redrawMs(page);
      const layers = await ws(page, (w) => w.viewer.stats.layers);
      console.log(`     256 channels and 100,000 events: a whole redraw ${redraw.toFixed(1)} ms (${JSON.stringify(layers)})`);
      assert.equal(await ws(page, (w) => w.viewer.events.length), 100000);
      assert.ok(layers.overview < 20 && layers.under < 20, `the overview took ${layers.overview} ms and the background ${layers.under} ms`);
      assert.ok(redraw < REDRAW_BUDGET_MS, `a redraw took ${redraw.toFixed(1)} ms`);
    },
  },
];
