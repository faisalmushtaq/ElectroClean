// The application on an iPad: touch on the EEG (one finger draws, two move and pinch, a long press
// opens the menu, a double tap the list of types, a finger finds an edge), the buttons that stand in
// for the keys, the layouts upright and on their side, the phone's notice, and the file pickers.
// Several fingers at once need Chromium's DevTools protocol; the rest also runs in WebKit, Safari's
// engine (node web_tests/run_e2e.mjs k_ipad --browser webkit).
import { SkipTest, annotations, openExample, signIn, waitForRoute } from './helpers.mjs';

/** Fingers on the screen through Chromium's DevTools protocol: points [{ x, y }] in CSS pixels. */
function fingers(cdp) {
  const send = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
  return {
    down: (points) => send('touchStart', points),
    move: (points) => send('touchMove', points),
    up: () => send('touchEnd', []),
    /** Move every finger from `from` to `to` in a few steps. */
    async slide(from, to, steps = 8) {
      for (let s = 1; s <= steps; s++) await send('touchMove', from.map((p, i) => ({ x: p.x + ((to[i].x - p.x) * s) / steps, y: p.y + ((to[i].y - p.y) * s) / steps })));
    },
  };
}

/** Client coordinates of time t (s), in the middle of the plot (or on row `row`). */
async function at(page, t, row = null) {
  return page.evaluate(([t, row]) => {
    const v = globalThis.ElectroTag.ws.viewer;
    const r = v.over.getBoundingClientRect();
    return { x: r.left + v.tToX(t), y: r.top + (row === null ? (v.y0 + v.y1) / 2 : v.rowCentre(row)) };
  }, [t, row]);
}

const view = (page) => page.evaluate(() => ({ ...globalThis.ElectroTag.ws.viewer.view }));
const resetView = (page) => page.evaluate(() => globalThis.ElectroTag.ws.viewer.setView({ startS: 0, durationS: 10, firstChannel: 0 }, 'code'));

export const tests = [
  {
    name: 'touch on the EEG: one finger marks, two fingers move and pinch, a long press and a double tap, edges for a finger',
    async run(t) {
      const { assert } = t;
      if (t.browserName !== 'chromium') throw new SkipTest('several fingers at once need Chromium\'s DevTools protocol');
      const page = await t.newPage({ width: 1180, height: 820, ipad: true, scale: 2 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      const cdp = await page.context().newCDPSession(page);
      const f = fingers(cdp);

      // The buttons under the EEG stand in for the keys.
      assert.ok(await page.isVisible('.viewer-touchbar'), 'the touch buttons are shown');
      const v0 = await view(page);
      await page.tap('[data-log="touch-page-forward"]');
      assert.equal((await view(page)).startS, v0.startS + v0.durationS, 'forward a screen');
      await page.tap('[data-log="touch-page-back"]');
      await page.tap('[data-log="touch-less-time"]');
      assert.ok((await view(page)).durationS < v0.durationS, 'less time');
      await page.tap('[data-log="touch-larger"]');
      assert.ok((await view(page)).scaleFactor > v0.scaleFactor, 'larger traces');
      await resetView(page);
      await page.evaluate(() => globalThis.ElectroTag.ws.viewer.setView({ scaleFactor: 1 }, 'code'));

      // One finger draws an annotation of the chosen type.
      let a = await at(page, 3.0); let b = await at(page, 3.4);
      await f.down([a]); await f.slide([a], [b]); await f.up();
      let anns = await annotations(page);
      assert.equal(anns.length, 1);
      assert.equal(anns[0].label, 'Eye-blink-artifact');
      assert.ok(Math.abs(anns[0].onset_sample - 750) <= 2 && Math.abs(anns[0].onset_sample + anns[0].duration_samples - 850) <= 2, JSON.stringify(anns[0]));

      // Two fingers move the view sideways without marking anything; the time under them stays under them.
      let p = [await at(page, 4.0), await at(page, 7.0)];
      const tUnder = 5.5;
      await f.down(p); await f.slide(p, p.map((q) => ({ x: q.x - 240, y: q.y }))); await f.up();
      let v = await view(page);
      assert.ok(v.startS > 1, `moved forward to ${v.startS}`);
      assert.equal(v.durationS, 10, 'moving keeps the time shown');
      assert.equal((await annotations(page)).length, 1, 'two fingers mark nothing');
      // a pinch outwards shows less time, about the moment between the fingers
      await resetView(page);
      p = [await at(page, 5.0), await at(page, 6.0)];
      const mid = (p[0].x + p[1].x) / 2;
      await f.down(p); await f.slide(p, [{ x: mid - 240, y: p[0].y }, { x: mid + 240, y: p[1].y }]); await f.up();
      v = await view(page);
      assert.ok(v.durationS < 4, `pinched to ${v.durationS} s`);
      const centre = await page.evaluate((x) => { const vw = globalThis.ElectroTag.ws.viewer; return vw.xToT(x - vw.over.getBoundingClientRect().left); }, mid);
      assert.ok(Math.abs(centre - tUnder) < 0.15, `the moment between the fingers stays put (${centre})`);
      // two fingers up and down move through the channels
      await resetView(page);
      await page.evaluate(() => globalThis.ElectroTag.ws.viewer.setView({ nChannels: 8 }, 'code'));
      p = [await at(page, 4.0, 6), await at(page, 6.0, 6)];
      await f.down(p); await f.slide(p, p.map((q) => ({ x: q.x, y: q.y - 150 }))); await f.up();
      assert.ok((await view(page)).firstChannel >= 2, 'moved down the channels');
      await page.evaluate(() => globalThis.ElectroTag.ws.viewer.setView({ nChannels: 22, firstChannel: 0 }, 'code'));
      await resetView(page);

      // A second finger cancels the mark the first had begun.
      a = await at(page, 6.0); b = await at(page, 6.6);
      await f.down([a]); await f.slide([a], [b], 4);
      await f.move([b, { x: b.x + 200, y: b.y + 40 }]);
      await f.slide([b, { x: b.x + 200, y: b.y + 40 }], [{ x: b.x - 50, y: b.y }, { x: b.x + 150, y: b.y + 40 }], 3);
      await f.up();
      assert.equal((await annotations(page)).length, 1, 'no annotation from a cancelled mark');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.viewer.dragPreview), null);
      await resetView(page);

      // A finger finds an annotation's edge within its larger reach and resizes it.
      const edge = await at(page, 3.4);
      await f.down([{ x: edge.x + 11, y: edge.y }]); await f.slide([{ x: edge.x + 11, y: edge.y }], [await at(page, 3.8)]); await f.up();
      anns = await annotations(page);
      assert.equal(anns.length, 1);
      assert.ok(Math.abs(anns[0].onset_sample + anns[0].duration_samples - 950) <= 3, `end at ${(anns[0].onset_sample + anns[0].duration_samples) / 250} s`);

      // A long press on the annotation opens its menu.
      const inside = await at(page, 3.5);
      await f.down([inside]); await page.waitForTimeout(800); await f.up();
      await page.waitForSelector('.menu');
      const menu = await page.textContent('.menu');
      assert.match(menu, /Edit times…/);
      assert.match(menu, /Delete/);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.menu', { state: 'detached' });

      // A double tap opens the list of types.
      for (let i = 0; i < 2; i++) { await f.down([inside]); await f.up(); await page.waitForTimeout(80); }
      await page.waitForSelector('.picker-dialog');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.picker-dialog', { state: 'detached' });
      assert.equal((await annotations(page)).length, 1);

      // The interaction log says the presses were made with a finger, and names the long press.
      const events = await page.evaluate(async () => {
        await globalThis.ElectroTag.flushLog();
        return [...globalThis.ElectroTag.backend.visits.values()].flatMap((vs) => vs.events);
      });
      const presses = events.filter((e) => e.type === 'mouse_press' && e.area === 'eeg');
      assert.ok(presses.length >= 6 && presses.every((e) => e.pointer === 'touch'), 'presses on the EEG are logged as touch');
      assert.ok(events.some((e) => e.type === 'annotation_created' && e.via === 'eeg_drag'), 'the finger\'s mark is a drag');
      await t.screenshot(page, 'ipad_touch');
    },
  },
  {
    name: 'an iPad upright and on its side: every view fits, the panels go below the EEG upright, and a phone is asked for a larger screen',
    async run(t) {
      const { assert } = t;
      const sizes = [[744, 1133], [820, 1180], [1024, 1366], [1180, 820], [1366, 1024]];
      for (const [width, height] of sizes) {
        const page = await t.newPage({ width, height, ipad: true });
        await signIn(page, 'A01');
        await waitForRoute(page, 'home');
        await openExample(page, 0);
        const fit = await page.evaluate(() => {
          const outside = [...document.querySelectorAll('.view.annotate button, .view.annotate .chip, .view.annotate h1')]
            .filter((el) => el.offsetParent && el.getBoundingClientRect().right > window.innerWidth + 1)
            .map((el) => el.textContent.trim() || el.getAttribute('aria-label'));
          const eeg = document.querySelector('.ws-eeg').getBoundingClientRect();
          const side = document.querySelector('.ws-side').getBoundingClientRect();
          const plot = document.querySelector('.viewer-plot').getBoundingClientRect();
          return { sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, outside,
            below: side.top >= eeg.bottom - 1, beside: side.left >= eeg.right - 1, plotH: plot.height, plotW: plot.width,
            notice: getComputedStyle(document.querySelector('.small-screen')).display };
        });
        const label = `${width} × ${height}`;
        assert.equal(fit.sideways, false, `${label}: nothing scrolls sideways`);
        assert.deepEqual(fit.outside, [], `${label}: every control on the screen`);
        assert.equal(fit.notice, 'none', `${label}: no notice`);
        if (width <= 1024) assert.ok(fit.below, `${label}: the panels below the EEG`);
        else assert.ok(fit.beside, `${label}: the panels beside the EEG`);
        assert.ok(fit.plotH >= 300 && fit.plotW >= 600, `${label}: room for the EEG (${fit.plotW} × ${fit.plotH})`);
        assert.ok(await page.isVisible('.viewer-touchbar'), `${label}: the touch buttons`);
        // The line at the bottom gives the hint in full, and the figures on its right are never cut short.
        const status = await page.evaluate(() => {
          const cut = (el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
          return { left: cut(document.querySelector('.ws-status-left')), right: [...document.querySelectorAll('.ws-status-right > *')].filter(cut).map((e) => e.textContent) };
        });
        assert.equal(status.left, false, `${label}: the hint in the line at the bottom is shown in full`);
        assert.deepEqual(status.right, [], `${label}: the figures at the bottom are shown in full`);
        if (width === 820) await t.screenshot(page, 'ipad_upright');
        if (width === 1180) {
          await t.screenshot(page, 'ipad_on_its_side');
          // Every choice of the Recording tab is a row of at least 40 pixels to tap, the notch's frequencies set in under it.
          await page.tap('.tab[data-tab="recording"]');
          const rows = await page.evaluate(() => [...document.querySelectorAll('.tab-panel[data-panel="recording"] input[type="radio"], .tab-panel[data-panel="recording"] input[type="checkbox"]')]
            .map((i) => ({ id: i.id || i.dataset.comfort, h: i.closest('label').getBoundingClientRect().height, x: i.getBoundingClientRect().left })));
          for (const r of rows) assert.ok(r.h >= 40, `${label}: ${r.id} is ${r.h} pixels high`);
          const x = (id) => rows.find((r) => r.id === id).x;
          assert.ok(x('notch-50') > x('notch-on') + 8 && x('notch-60') === x('notch-50'), 'the 50 and 60 Hz choices are set in under the notch filter');
          await t.screenshot(page, 'ipad_recording_tab');
        }
        await page.context().close();
      }
      // A phone: the sign-in works, then a calm notice instead of the views.
      const phone = await t.newPage({ width: 390, height: 844, ipad: true });
      await signIn(phone, 'A01');
      await waitForRoute(phone, 'home');
      assert.ok(await phone.isVisible('.small-screen'));
      assert.match(await phone.textContent('.small-screen'), /needs a larger screen/);
      assert.equal(await phone.isVisible('[data-log="continue-small-screen"]'), false, 'a phone is not offered to carry on');
      await phone.context().close();
    },
  },
  {
    name: 'on an iPad: the file pickers take any file and no folder, the help starts with touch, and the hints speak of fingers',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1180, height: 820, ipad: true });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await page.click('[data-log="open-next"]');
      await waitForRoute(page, 'open');
      // iPadOS greys out files whose extension it does not know, so the picker takes any file; it cannot pick folders.
      assert.equal(await page.getAttribute('input[data-log="file-input"]', 'accept'), null);
      assert.equal(await page.locator('[data-log="choose-folder"]').count(), 0);
      await page.locator('.example-card button').click();
      await waitForRoute(page, 'annotate');
      await page.locator('.tab', { hasText: 'Help' }).click();
      assert.equal((await page.textContent('.help-text h3')).trim(), 'On a touch screen (an iPad)');
      assert.match(await page.textContent('.ws-hint'), /two fingers move, pinch/);
      await page.context().close();
      // On a computer: the extensions, the folder button, the keys first.
      const desk = await t.newPage({ width: 1440, height: 900 });
      await signIn(desk, 'A01');
      await waitForRoute(desk, 'home');
      await desk.click('[data-log="open-next"]');
      await waitForRoute(desk, 'open');
      assert.match(await desk.getAttribute('input[data-log="file-input"]', 'accept'), /\.edf/);
      assert.equal(await desk.locator('[data-log="choose-folder"]').count(), 1);
      assert.equal(await desk.isVisible('.viewer-touchbar').catch(() => false), false);
    },
  },
];
