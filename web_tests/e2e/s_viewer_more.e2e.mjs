// More ways of looking at the EEG: the value under the pointer (V), the overlay of the channels on one
// axis (O) with one channel alone (I), Go to time (G) and Show all (Shift+End), and the channel
// chooser's map of the head, with the mouse and the keyboard and on an iPad by touch. Runs in
// Chromium and in WebKit (node web_tests/run_e2e.mjs s_viewer_more --browser webkit).
import { annotations, clickDialogButton, drag, eegPoint, openExample, signIn, waitForRoute, waitForTraces } from './helpers.mjs';

const ws = (page, fn, arg) => page.evaluate(([src, a]) => (0, eval)(src)(globalThis.ElectroTag.ws, a), [String(fn), arg]);
const view = (page) => ws(page, (w) => ({ ...w.viewer.view }));

async function logged(page) {
  return page.evaluate(async () => {
    await globalThis.ElectroTag.flushLog();
    return [...globalThis.ElectroTag.backend.visits.values()].flatMap((vs) => vs.events);
  });
}

async function openSynthetic(page, channels, id, { sidecars = null, sfreq = 256, durationS = 20 } = {}) {
  await page.evaluate(async ([channels, id, sidecars, sfreq, durationS]) => {
    const { makeSyntheticRecording } = await import(new URL('js/data/synthetic.js', location.href).href);
    const recording = makeSyntheticRecording({ id, stem: `sub-${id}_task-rest_eeg`, sfreq, durationS, seed: 3, channels, artifacts: [] });
    if (sidecars) recording.source = { kind: 'chosen', sidecars: sidecars.map(([name, text]) => new File([text], name)) };
    await globalThis.ElectroTag.openWorkspace({ recording, match: { status: 'unknown' }, sha: '', tryOut: true });
  }, [channels, id, sidecars, sfreq, durationS]);
  await waitForTraces(page);
}

async function openChooser(page) {
  await page.click('.ws-toolbar button:has-text("Channels…")');
  await page.waitForSelector('.dialog .channel-chooser');
}

/** The map in the open chooser: its electrodes with their centres and sizes, and its note. */
async function mapState(page) {
  return page.evaluate(() => {
    const block = document.querySelector('.dialog .channel-map-block');
    const els = [...block.querySelectorAll('.map-electrode')].map((b) => {
      const r = b.getBoundingClientRect();
      return { name: b.dataset.name, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, pressed: b.getAttribute('aria-pressed') === 'true',
        colour: b.style.getPropertyValue('--el-colour'), bad: b.classList.contains('bad') };
    });
    const box = document.querySelector('.dialog').getBoundingClientRect();
    return { source: block.dataset.source, note: block.querySelector('.map-note').textContent, els, hidden: block.hidden,
      count: document.querySelector('.dialog .channel-count').textContent,
      fits: box.top >= 0 && box.bottom <= innerHeight + 1 && box.left >= 0 && box.right <= innerWidth + 1 };
  });
}
const el = (m, name) => m.els.find((e) => e.name === name);

/** 126 names of the 10-05 system, as on a 128-channel cap (the 10-10 names, then the 5% rows), with two EOG channels. */
const CAP_128 = [...('Fp1 Fpz Fp2 AF9 AF7 AF5 AF3 AF1 AFz AF2 AF4 AF6 AF8 AF10 F9 F7 F5 F3 F1 Fz F2 F4 F6 F8 F10 FT9 FT7 FC5 FC3 FC1 FCz FC2 FC4 FC6 FT8 FT10 T9 T7 C5 C3 C1 Cz C2 C4 C6 T8 T10 TP9 TP7 CP5 CP3 CP1 CPz CP2 CP4 CP6 TP8 TP10 P9 P7 P5 P3 P1 Pz P2 P4 P6 P8 P10 PO9 PO7 PO5 PO3 PO1 POz PO2 PO4 PO6 PO8 PO10 O1 Oz O2 Iz M1 M2 A1 A2 I1 I2 AFp9h AFp7h AFp5h AFp3h AFp1h AFp2h AFp4h AFp6h AFp8h AFp10h AFF9h AFF7h AFF5h AFF3h AFF1h AFF2h AFF4h AFF6h AFF8h AFF10h FFT9h FFT7h FFC5h FFC3h FFC1h FFC2h FFC4h FFC6h FFT8h FFT10h FTT9h FTT7h FCC5h FCC3h FCC1h FCC2h').split(' '), 'HEOG', 'VEOG'];

export const tests = [
  {
    name: 'the value under the pointer: on with a mouse, V and the Recording tab switch it, no trace redraws while the pointer moves',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1600, height: 950 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      // Count trace redraws from here on.
      await ws(page, (w) => { w.viewer._traceDraws = 0; const f = w.viewer._renderTraces.bind(w.viewer); w.viewer._renderTraces = () => { w.viewer._traceDraws += 1; f(); }; });
      const p = await eegPoint(page, 3.0, 'Fp1');
      for (let i = 0; i < 12; i++) await page.mouse.move(p.x + i * 3, p.y);
      await page.waitForFunction(() => !document.querySelector('.ws-readout').hidden);
      const text = await page.textContent('.ws-readout');
      assert.match(text, /^Fp1 {3}3\.\d{3} s {3}−?\d+\.\d µV$/, text);
      // The figure is the trace as drawn: its sample minus the trace's mean on screen.
      const check = await ws(page, (w, at) => { const r = w.viewer.valueAt(at.x, at.y); return r && { ...r, uv: Math.round(r.volts * 1e7) / 10 }; }, { x: p.x + 33, y: p.y });
      assert.equal(check.channel, 'Fp1');
      assert.ok(text.endsWith(`${check.uv < 0 ? '−' : ''}${Math.abs(check.uv).toFixed(1)} µV`), `${text} for ${check.uv}`);
      assert.equal(await ws(page, (w) => w.viewer._traceDraws), 0, 'moving the pointer redraws no traces');
      // V switches it off, the Recording tab's button on again.
      await page.keyboard.press('v');
      assert.equal(await page.isHidden('.ws-readout'), true);
      await page.click('.tab[data-tab="recording"]');
      assert.equal(await page.getAttribute('[data-log="value-readout"]', 'aria-pressed'), 'false');
      await page.click('[data-log="value-readout"]');
      assert.equal(await page.getAttribute('[data-log="value-readout"]', 'aria-pressed'), 'true');
      await page.mouse.move(p.x, p.y + 1);
      await page.waitForFunction(() => !document.querySelector('.ws-readout').hidden);
      const events = await logged(page);
      assert.deepEqual(events.filter((e) => e.type === 'state' && 'value_readout' in e).map((e) => [e.value_readout, e.via]), [[false, 'key'], [true, 'button']]);
      await t.screenshot(page, 'viewer_readout');
    },
  },
  {
    name: 'the overlay: O and the toolbar, marks on the whole montage, the legend, one channel alone with the arrow keys, kept for the annotator',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 720 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await page.click('.ws-toolbar .seg:has-text("Selected channels")');
      await page.keyboard.press('o');
      assert.equal(await ws(page, (w) => w.viewer.overlay), true);
      assert.equal(await page.getAttribute('.ws-toolbar [data-log="overlay"]', 'aria-pressed'), 'true');
      assert.equal(await page.isDisabled('.ws-toolbar .seg:has-text("Selected channels")'), true, 'no channel-specific marks in the overlay');
      assert.match(await page.textContent('.ws-chansummary'), /all channels in the overlay/);
      const fits = await page.evaluate(() => { const tb = document.querySelector('.ws-toolbar'); return tb.scrollWidth <= tb.clientWidth + 1; });
      assert.ok(fits, 'the toolbar fits 1280 pixels');
      await page.waitForFunction(() => globalThis.ElectroTag.ws.viewer.stats.traceMs > 0);
      // A drag marks the whole montage.
      await drag(page, await eegPoint(page, 2.0), await eegPoint(page, 2.6));
      let anns = await annotations(page);
      assert.equal(anns.length, 1);
      assert.deepEqual(anns[0].channels, [], 'the mark is on the whole montage');
      await page.keyboard.press('c');
      assert.match(await page.textContent('.ws-message'), /whole montage/);
      await t.screenshot(page, 'viewer_overlay');
      // Pointing at a name shows that channel on top; clicking it shows it alone.
      const name = await ws(page, (w) => { const v = w.viewer; const r = v.over.getBoundingClientRect(); return { x: r.left + v.x0 - 20, y: r.top + v.rowCentre(2) }; });
      await page.mouse.move(name.x, name.y);
      await page.mouse.click(name.x, name.y);
      assert.equal(await ws(page, (w) => w.viewer.isolated), 2, 'a click on a name isolates it');
      await page.keyboard.press('ArrowDown');
      assert.equal(await ws(page, (w) => w.viewer.isolated), 3, 'the arrow key goes to the next channel');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      assert.equal(await ws(page, (w) => w.viewer.isolated), 1);
      await t.screenshot(page, 'viewer_isolate');
      await page.keyboard.press('i');
      assert.equal(await ws(page, (w) => w.viewer.isolated), null, 'I shows them all again');
      // Kept for the annotator: the next recording opens in the overlay.
      await page.click('[data-log="close"]');
      await clickDialogButton(page, 'Close and finish later');
      await waitForRoute(page, 'home');
      await page.click('[data-log="open-next"]');
      await waitForRoute(page, 'open');
      await page.locator('.example-card button').click();
      await clickDialogButton(page, 'Restore and continue');
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      assert.equal(await ws(page, (w) => w.viewer.overlay), true, 'the choice is kept in this browser');
      await page.keyboard.press('o');
      assert.equal(await ws(page, (w) => w.viewer.overlay), false);
      const events = await logged(page);
      const states = events.filter((e) => e.type === 'state' && ('overlay' in e || 'isolated_channel' in e)).map((e) => ('overlay' in e ? `overlay ${e.overlay} ${e.via}` : `alone ${e.isolated_channel}`));
      assert.deepEqual(states.slice(0, 5), ['overlay true key', `alone ${await ws(page, (w) => w.s.channels[2].name)}`, `alone ${await ws(page, (w) => w.s.channels[3].name)}`,
        `alone ${await ws(page, (w) => w.s.channels[2].name)}`, `alone ${await ws(page, (w) => w.s.channels[1].name)}`]);
      assert.ok(events.some((e) => e.type === 'view' && e.butterfly === true), 'the view events say the overlay was on');
    },
  },
  {
    name: 'the overlay of 128 channels draws as fast as the rows',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1600, height: 950 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openSynthetic(page, Array.from({ length: 128 }, (_, i) => `E${i + 1}`), 'perf', { sfreq: 1024, durationS: 30 });
      const r = await ws(page, async (w) => {
        const v = w.viewer;
        v.setView({ nChannels: 128, durationS: 10, startS: 5 });
        v.setOverlay(true);
        await new Promise((res) => { const f = () => (v._covers() ? res() : requestAnimationFrame(f)); f(); });
        const times = [];
        for (const startS of [5, 7.5, 5, 7.5, 5.5, 6, 6.5, 7, 5, 6]) {
          v.setView({ startS });
          const t0 = performance.now();
          v._dirty = { under: true, traces: true, over: true, overview: true };
          v._render();
          times.push(performance.now() - t0);
          await new Promise((res) => requestAnimationFrame(res));
        }
        return { med: [...times].sort((a, b) => a - b)[5], rows: v.visibleRows().length };
      });
      console.log(`     overlay of ${r.rows} channels: ${r.med.toFixed(1)} ms per redraw`);
      assert.equal(r.rows, 128);
      assert.ok(r.med < 100, `the overlay took ${r.med.toFixed(1)} ms`);
      await t.screenshot(page, 'viewer_overlay_128');
    },
  },
  {
    name: 'Go to time (G): seconds, m:ss and h:mm:ss, kept within the recording, plain words for a mistake, Esc; Show all and back; only the time is logged',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1600, height: 950 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      const total = await ws(page, (w) => w.viewer.durationTotal);
      await page.keyboard.press('g');
      await page.waitForSelector('.goto-bar:not([hidden])');
      assert.equal(await page.evaluate(() => document.activeElement.name), 'goto-time');
      await page.keyboard.type('half past');
      await page.keyboard.press('Enter');
      assert.match(await page.textContent('.goto-note'), /cannot read that as a time/);
      await page.fill('.goto-field', '0:75');
      await page.keyboard.press('Enter');
      assert.match(await page.textContent('.goto-note'), /seconds after a colon go up to 59/);
      await page.keyboard.press('Escape');
      assert.equal(await page.isHidden('.goto-bar'), true, 'Esc closes the field');
      await page.keyboard.press('g');
      await page.keyboard.type('0:12.5');
      await page.keyboard.press('Enter');
      assert.equal(await page.isHidden('.goto-bar'), true);
      let v = await view(page);
      assert.ok(Math.abs(v.startS + v.durationS / 2 - 12.5) < 1e-6, `centred on 12.5 s (${v.startS})`);
      assert.equal(await ws(page, (w) => w.viewer.cursorT), 12.5);
      await page.keyboard.press('g');
      await page.keyboard.type('1:00:00');
      await page.click('[data-log="goto-go"]');
      v = await view(page);
      assert.ok(Math.abs(v.startS + v.durationS - total) < 1e-6, 'a time past the end shows the end');
      assert.match(await page.textContent('.ws-message'), /long: the time cursor is at its end/);
      // Show all, and back to where it was.
      const before = await view(page);
      const viewedBefore = await ws(page, (w) => w._viewedFraction());
      await page.keyboard.press('Shift+End');
      v = await view(page);
      assert.equal(v.startS, 0);
      assert.equal(v.durationS, total);
      await page.waitForTimeout(700);
      assert.equal(await ws(page, (w) => w._viewedFraction()), viewedBefore, 'an overview does not count as viewed');
      await t.screenshot(page, 'viewer_show_all');
      await page.keyboard.press('Shift+End');
      v = await view(page);
      assert.equal(v.durationS, before.durationS);
      assert.ok(Math.abs(v.startS - before.startS) < 1e-6);
      const events = await logged(page);
      const jumps = events.filter((e) => e.type === 'go_to_time');
      assert.deepEqual(jumps.map((e) => [e.valid, e.t_s, e.clamped]), [[false, undefined, undefined], [false, undefined, undefined], [true, 12.5, false], [true, total, true]]);
      const all = JSON.stringify(events);
      for (const typed of ['half past', '0:75', '0:12.5', '1:00:00']) assert.ok(!all.includes(typed), `"${typed}" is not in the log`);
      assert.deepEqual(events.filter((e) => e.type === 'show_all').map((e) => e.on), [true, false]);
      await page.keyboard.press('g');
      await t.screenshot(page, 'viewer_goto');
    },
  },
  {
    name: 'the channel map: Map and List, a click, a box, Select all, None, Invert, the arrow keys and Space, group colours, and the montages it places',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 720 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await ws(page, (w) => { w.s.channels.find((c) => c.name === 'T8').bad = true; });
      await openChooser(page);
      assert.equal(await page.isHidden('.channel-map-block'), true, 'the list comes first');
      await page.click('[data-log="channel-view-map"]');
      let m = await mapState(page);
      assert.equal(m.source, 'standard');
      assert.match(m.note, /Standard positions/);
      assert.ok(m.fits, 'the dialog fits 1280 × 720');
      assert.ok(el(m, 'Fz').y < el(m, 'Cz').y && el(m, 'Cz').y < el(m, 'Pz').y, 'the nose at the top');
      assert.ok(el(m, 'F3').x < el(m, 'Fz').x && el(m, 'Fz').x < el(m, 'F4').x, 'left on the left');
      assert.ok(el(m, 'HEOG').y > el(m, 'O1').y, 'other channels under the head');
      assert.equal(el(m, 'T8').bad, true, 'a bad channel is grey');
      await page.click('.map-electrode[data-name="Fp1"]');
      m = await mapState(page);
      assert.equal(el(m, 'Fp1').pressed, true);
      assert.match(m.count, /^1 of 22/);
      // a box round the left frontal electrodes
      const a = el(m, 'F7'); const b = el(m, 'F3');
      await page.mouse.move(Math.min(a.x, b.x) - 16, Math.min(a.y, b.y) - 16);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) await page.mouse.move(Math.min(a.x, b.x) - 16 + (i * (Math.abs(b.x - a.x) + 32)) / 6, Math.min(a.y, b.y) - 16 + (i * (Math.abs(b.y - a.y) + 32)) / 6);
      await page.mouse.up();
      m = await mapState(page);
      assert.deepEqual(m.els.filter((e) => e.pressed).map((e) => e.name).sort(), ['F3', 'F7', 'Fp1'], 'the box chose F7 and F3');
      await t.screenshot(page, 'channel_map');
      await page.click('[data-log="channel-map-invert"]');
      assert.match((await mapState(page)).count, /^19 of 22/);
      await page.click('[data-log="channel-map-none"]');
      assert.match((await mapState(page)).count, /^0 of 22/);
      await page.click('[data-log="channel-map-all"]');
      assert.match((await mapState(page)).count, /^22 of 22/);
      await page.click('[data-log="channel-map-none"]');
      // the keyboard: from Cz, right is C4; Space chooses it
      await page.focus('.map-electrode[data-name="Cz"]');
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.name), 'C4');
      await page.keyboard.press('ArrowUp');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.name), 'F4');
      await page.keyboard.press('Space');
      assert.equal(el(await mapState(page), 'F4').pressed, true);
      // the list shows the same choice
      await page.click('[data-log="channel-view-list"]');
      assert.equal(await page.isChecked('.channel-grid input[data-name="F4"]'), true);
      await page.click('[data-log="channel-view-map"]');
      await page.click('.dialog-buttons button:has-text("OK")');
      assert.deepEqual(await ws(page, (w) => w.selectedChannels), ['F4']);
      // Map is remembered; with channels coloured by region the map takes the colours.
      await page.click('.tab[data-tab="recording"]');
      await page.selectOption('#channel-colours', 'region');
      await openChooser(page);
      m = await mapState(page);
      assert.equal(m.hidden, false, 'the map comes back');
      assert.ok(el(m, 'Fz').colour && el(m, 'Cz').colour && el(m, 'Fz').colour !== el(m, 'Cz').colour, 'the group colours');
      await page.keyboard.press('Escape');
      const events = await logged(page);
      const map = events.filter((e) => e.type === 'channel_map').map((e) => [e.action, e.n_changed]);
      assert.deepEqual(map.slice(0, 6), [['toggle', 1], ['box', 2], ['invert', 22], ['none', 19], ['all', 22], ['none', 22]]);
      assert.ok(events.filter((e) => e.type === 'channel_map' && e.action === 'box').every((e) => !('channels' in e)), 'a box is logged as a count');

      // EGI's 128 channels: rings in order, said so plainly.
      await openSynthetic(page, Array.from({ length: 128 }, (_, i) => `E${i + 1}`), 'egi');
      await openChooser(page);
      m = await mapState(page);
      assert.equal(m.source, 'order');
      assert.match(m.note, /Positions not known: arranged in order/);
      assert.equal(m.els.length, 128);
      assert.ok(m.fits);
      await t.screenshot(page, 'channel_map_128');
      await page.keyboard.press('Escape');
      // A recording's own electrodes.tsv.
      const tsv = 'name\tx\ty\tz\nFp1\t-30\t85\t-5\nFp2\t30\t85\t-5\nCz\t0\t0\t100\nO1\t-30\t-85\t-5\nO2\t30\t-85\t-5\nT7\t-85\t0\t-5\nT8\t85\t0\t-5\n';
      await openSynthetic(page, ['Fp1', 'Fp2', 'Cz', 'O1', 'O2', 'T7', 'T8', 'EXG1'], 'tsv', { sidecars: [['sub-tsv_electrodes.tsv', tsv], ['sub-tsv_coordsystem.json', '{"EEGCoordinateSystem": "CapTrak"}']] });
      await page.waitForFunction(() => Boolean(globalThis.ElectroTag.ws.electrodes));
      await openChooser(page);
      m = await mapState(page);
      assert.equal(m.source, 'file');
      assert.match(m.note, /Positions from sub-tsv_electrodes\.tsv/);
      assert.ok(el(m, 'Fp1').y < el(m, 'Cz').y && el(m, 'T7').x < el(m, 'Cz').x);
      await page.keyboard.press('Escape');
    },
  },
  {
    name: 'a 128-channel cap: names of at least 11 pixels and the row under the pointer named; the map opens whole; Show all shows how much it has read',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openSynthetic(page, CAP_128, 'cap128', { sfreq: 128, durationS: 120 });
      await ws(page, (w) => w.viewer.setView({ nChannels: 128 }));
      await page.waitForFunction(() => globalThis.ElectroTag.ws.viewer._covers());
      // The names: never under 11 pixels; rows too short name every few channels, and the row under the pointer is named too.
      const names = await ws(page, (w) => { w.viewer._render(); return { ...w.viewer._names, rowH: w.viewer.rowH }; });
      assert.ok(names.px >= 11 && names.every > 1, `names of ${names.px} px, every ${names.every} on rows of ${names.rowH.toFixed(1)} px`);
      await ws(page, (w) => { w._boxed = []; const f = w.viewer._boxedName.bind(w.viewer); w.viewer._boxedName = (ctx, row, ch, c) => { w._boxed.push(ch.name); f(ctx, row, ch, c); }; });
      const p = await eegPoint(page, 3, CAP_128[1]); // Fpz, the second row: not among the rows named
      await page.mouse.move(p.x, p.y);
      await page.waitForFunction(() => globalThis.ElectroTag.ws._boxed.includes('Fpz'));
      await t.screenshot(page, 'cap128_names');
      // The map: the whole head in its frame first, every electrode a dot with its name under the pointer; + until every name shows.
      await openChooser(page);
      await page.click('[data-log="channel-view-map"]');
      const first = await page.evaluate(() => {
        const vp = document.querySelector('.map-viewport'); const c = document.querySelector('.map-canvas');
        return { crowded: document.querySelector('.channel-map-block').classList.contains('crowded'), whole: c.offsetWidth <= vp.clientWidth && c.offsetHeight <= vp.clientHeight,
          smaller: document.querySelector('[data-log="channel-map-smaller"]').disabled, note: document.querySelector('.map-note').textContent };
      });
      assert.ok(first.crowded && first.whole && first.smaller, 'the map opens with the whole head in view');
      assert.match(first.note, /Point at an electrode for its name/);
      await page.hover('.map-electrode[data-name="AF7"]');
      assert.equal(await page.isVisible('.map-electrode[data-name="AF7"] > span'), true, 'the name under the pointer');
      await t.screenshot(page, 'cap128_map');
      for (let i = 0; i < 12 && await page.evaluate(() => document.querySelector('.channel-map-block').classList.contains('crowded')); i++) await page.click('[data-log="channel-map-larger"]');
      assert.equal(await page.isVisible('.map-electrode[data-name="FFC1h"] > span'), true, 'every name at the larger size');
      await page.keyboard.press('Escape');
      // Show all: read in pieces, drawn as they come, with the share read over the EEG and a caption while it lasts.
      await ws(page, (w) => {
        w.viewer.pieceValues = 1e5;
        w.viewer.setFilters({ highpassHz: null, notchHz: null, notchHarmonics: false }); // unfiltered, so that the samples can be compared exactly
        const rec = w.viewer.recording; const read = rec.readWindow.bind(rec);
        w._progress = [];
        rec.readWindow = async (req) => { await new Promise((r) => setTimeout(r, 30)); const res = await read(req); w._progress.push(w.viewer.readProgress); return res; };
      });
      await page.keyboard.press('Shift+End');
      await page.waitForFunction(() => { const v = globalThis.ElectroTag.ws.viewer; return v.readProgress > 0.2 && v.readProgress < 0.8; });
      const mid = await ws(page, (w) => ({ caption: w.viewer.caption, partial: w.viewer._cache.nSamples < w.viewer.nSamples }));
      assert.match(mid.caption, /The whole recording, as an overview · Shift\+End goes back/);
      assert.ok(mid.partial, 'what has been read is drawn before the rest');
      await t.screenshot(page, 'cap128_show_all_reading');
      await page.waitForFunction(() => globalThis.ElectroTag.ws.viewer.readProgress === null && globalThis.ElectroTag.ws.viewer._covers(), null, { timeout: 60000 });
      const done = await ws(page, async (w) => {
        const v = w.viewer; const c = v._cache; const ch = v.channels[5].index;
        const direct = await v.recording.readWindow({ startSample: 7000, nSamples: 4, channels: [ch], filters: { ...v.filters } });
        return { pieces: w._progress.length, whole: c.nSamples === v.nSamples, same: Array.from(c.rows.get(ch).subarray(7000, 7004)).every((x, i) => x === direct.data[0][i]) };
      });
      assert.ok(done.pieces > 3 && done.whole, `read in ${done.pieces} pieces`);
      assert.ok(done.same, 'the pieces together are the samples a single read gives');
      // Back: the caption goes with the overview.
      await page.keyboard.press('Shift+End');
      assert.equal(await ws(page, (w) => w.viewer.caption), null);
    },
  },
  {
    name: 'on an iPad: the View buttons for the overlay, one channel alone, Go to time and Show all; the readout off; the map by touch, upright and on its side',
    async run(t) {
      const { assert } = t;
      for (const [width, height] of [[820, 1180], [1180, 820]]) {
        const page = await t.newPage({ width, height, ipad: true });
        await signIn(page, 'A01');
        await waitForRoute(page, 'home');
        await openExample(page, 0);
        assert.equal(await ws(page, (w) => w.readoutOn), false, 'the readout is off on a touch screen');
        assert.equal(await page.isVisible('[data-log="touch-overlay"]'), true);
        const noSideways = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
        assert.ok(noSideways, `${width} × ${height}: nothing scrolls sideways`);
        const plot = await page.evaluate(() => document.querySelector('.viewer-plot').getBoundingClientRect().height);
        assert.ok(plot >= 300, `room for the EEG (${plot})`);
        await page.tap('[data-log="touch-overlay"]');
        assert.equal(await ws(page, (w) => w.viewer.overlay), true);
        await page.tap('[data-log="touch-isolate"]');
        assert.equal(await ws(page, (w) => w.viewer.isolated), 0);
        await page.tap('[data-log="touch-isolate-next"]');
        assert.equal(await ws(page, (w) => w.viewer.isolated), 1);
        if (width === 820) await t.screenshot(page, 'ipad_isolate');
        await page.tap('[data-log="touch-isolate"]');
        await page.tap('[data-log="touch-overlay"]');
        assert.equal(await ws(page, (w) => w.viewer.overlay), false);
        await page.tap('[data-log="touch-goto"]');
        await page.fill('.goto-field', '15');
        await page.tap('[data-log="goto-go"]');
        assert.equal(await ws(page, (w) => w.viewer.cursorT), 15);
        await page.tap('[data-log="touch-show-all"]');
        assert.equal((await view(page)).startS, 0);
        await page.tap('[data-log="touch-show-all"]');
        // the map by touch
        await page.tap('.ws-toolbar .seg:has-text("Selected channels")');
        await page.tap('.ws-toolbar button:has-text("Channels…")');
        await page.waitForSelector('.dialog .channel-chooser');
        await page.tap('[data-log="channel-view-map"]');
        let m = await mapState(page);
        assert.ok(m.fits, `${width} × ${height}: the dialog fits`);
        assert.ok(m.els.every((e) => e.w >= 40 && e.h >= 40), 'targets of 40 pixels for a finger');
        await page.tap('.map-electrode[data-name="O1"]');
        await page.tap('.map-electrode[data-name="O2"]');
        m = await mapState(page);
        assert.deepEqual(m.els.filter((e) => e.pressed).map((e) => e.name), ['O1', 'O2']);
        await t.screenshot(page, `ipad_channel_map_${width > height ? 'side' : 'upright'}`);
        await page.tap('.dialog-buttons button:has-text("OK")');
        assert.deepEqual(await ws(page, (w) => w.selectedChannels), ['O1', 'O2']);
        await page.context().close();
      }
    },
  },
];
