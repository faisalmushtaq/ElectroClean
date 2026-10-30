// A recording's own electrode positions when it is opened from a link or from a copy kept on this
// device: a stand-in cloud service serves the demonstration's EDF file at a plain web address with
// the recording's BIDS electrodes.tsv and coordsystem.json beside it. The positions are made
// distinctive (the front of the head swapped with the back), so that the channel map shows whether
// it uses the file's positions or the standard ones. Opened from the link the map uses the file;
// the copy kept on the device keeps the two files, and after a reload, with the service gone, opens
// with the same positions. A link with nothing beside it opens with standard positions. The
// interaction log says which positions were used, never the link.
import { clickDialogButton, signIn, waitForRoute, waitForTraces } from './helpers.mjs';
import { cloudService, recordEvents, sentEvents, NAME } from './l_links.e2e.mjs';
import { profilePage, kept, waitKept } from './l_device.e2e.mjs';
import { demoSpecs, syntheticEdfBytes } from '../../electrotag/web/static/js/eeg/synthetic.js';

/** Positions in CapTrak (x to the right, y to the nose, z up), with the front and back swapped. */
export const SWAPPED_TSV = [
  'name\tx\ty\tz\ttype',
  'Fp1\t-30\t-85\t-5\tEEG', 'Fp2\t30\t-85\t-5\tEEG', 'Fz\t0\t-60\t60\tEEG',
  'Cz\t0\t0\t100\tEEG', 'T7\t-85\t0\t-5\tEEG', 'T8\t85\t0\t-5\tEEG',
  'Pz\t0\t60\t60\tEEG', 'O1\t-30\t85\t-5\tEEG', 'O2\t30\t85\t-5\tEEG', '',
].join('\n');
const COORDSYSTEM = '{"EEGCoordinateSystem": "CapTrak", "EEGCoordinateUnits": "mm"}';

/** Open the channel chooser's map and read it: its note, where it says the positions come from, and the electrodes' centres. */
async function readMap(page) {
  await page.click('.ws-toolbar button:has-text("Channels…")');
  await page.waitForSelector('.dialog .channel-chooser');
  if (await page.isHidden('.dialog .channel-map-block')) await page.click('[data-log="channel-view-map"]');
  const m = await page.evaluate(() => {
    const block = document.querySelector('.dialog .channel-map-block');
    const els = Object.fromEntries([...block.querySelectorAll('.map-electrode')].map((b) => {
      const r = b.getBoundingClientRect();
      return [b.dataset.name, { x: r.left + r.width / 2, y: r.top + r.height / 2 }];
    }));
    return { source: block.dataset.source, note: block.querySelector('.map-note').textContent, els };
  });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.dialog .channel-chooser', { state: 'detached' });
  return m;
}

/** Wait for the workspace's note of the positions it uses (the `n`th of those sent so far, from 0), and return it. */
async function positionsEvent(page, n) {
  const t0 = Date.now();
  for (;;) {
    const e = (await sentEvents(page)).filter((x) => x.type === 'electrode_positions')[n];
    if (e) return e;
    if (Date.now() - t0 > 20000) throw new Error(`no electrode_positions event number ${n}`);
    await page.waitForTimeout(100);
  }
}

export const tests = [
  {
    name: 'electrode positions from the electrodes.tsv beside a link, kept with the copy on the device and used again after a reload; standard positions without one',
    async run(t) {
      const { assert } = t;
      const bytes = syntheticEdfBytes(demoSpecs()[0]);
      const plain = await cloudService(bytes);
      const cloud = await cloudService(bytes, { files: { 'sub-demo01_electrodes.tsv': SWAPPED_TSV, 'sub-demo01_coordsystem.json': COORDSYSTEM } });
      const { page, close } = await profilePage(t);
      try {
        await signIn(page, 'A01');
        await waitForRoute(page, 'home');
        await recordEvents(page);

        // A link with nothing beside it: the standard positions, and the recording opens as ever.
        await page.click('[data-log="open-next"]');
        await waitForRoute(page, 'open');
        await page.evaluate(async () => (await import('./js/views/device.js')).deviceStore(globalThis.ElectroTag).usable());
        if (await page.locator('[data-log="keep-link"]').count()) await page.uncheck('[data-log="keep-link"]');
        await page.fill('.link-panel textarea', `${plain.base}/cors/data/${NAME}?token=plain-secret-1`);
        await page.click('[data-log="open-link"]');
        await waitForRoute(page, 'annotate', 30000);
        await waitForTraces(page);
        let e = await positionsEvent(page, 0);
        assert.equal(e.source, 'standard');
        assert.equal(e.opened_from, 'link');
        let m = await readMap(page);
        assert.equal(m.source, 'standard');
        assert.match(m.note, /Standard positions/);
        assert.ok(m.els.Fp1.y < m.els.Cz.y && m.els.Cz.y < m.els.O1.y, 'standard positions: the nose at the top');
        assert.ok(plain.seen.some((r) => r.path === '/cors/data/sub-demo01_electrodes.tsv'), 'the page looked beside the recording');
        await page.click('[data-log="close"]');
        await clickDialogButton(page, 'Discard and close');
        await waitForRoute(page, 'home');
        await plain.close();

        // A link with the recording's electrodes.tsv beside it, kept on the device.
        await page.click('[data-log="open-next"]');
        await waitForRoute(page, 'open');
        if (await page.locator('[data-log="keep-link"]').count()) await page.check('[data-log="keep-link"]');
        await page.fill('.link-panel textarea', `${cloud.base}/cors/data/${NAME}?token=secret-key-789`);
        await page.click('[data-log="open-link"]');
        await waitForRoute(page, 'annotate', 30000);
        await waitForTraces(page);
        await page.waitForFunction(() => Boolean(globalThis.ElectroTag.ws.electrodes), null, { timeout: 15000 });
        m = await readMap(page);
        assert.equal(m.source, 'file');
        assert.match(m.note, /Positions from sub-demo01_electrodes\.tsv/);
        assert.ok(m.els.O1.y < m.els.Cz.y && m.els.Cz.y < m.els.Fp1.y, 'the file\'s positions: Fp1 at the back, O1 at the front');
        assert.ok(m.els.T7.x < m.els.Cz.x && m.els.Cz.x < m.els.T8.x, 'left on the left');
        await t.screenshot(page, 'electrodes_from_link');
        const asked = cloud.seen.filter((r) => /_(electrodes|coordsystem)\./.test(r.path));
        assert.deepEqual(asked.map((r) => r.path), ['/cors/data/sub-demo01_electrodes.tsv', '/cors/data/sub-demo01_coordsystem.json']);
        for (const r of asked) {
          assert.equal(r.headers.referer, undefined, 'no referrer is sent to the service');
          assert.equal(r.headers.cookie, undefined, 'no cookies are sent to the service');
        }
        e = await positionsEvent(page, 1);
        assert.equal(e.source, 'file');
        assert.equal(e.opened_from, 'link');
        assert.equal(e.coordinate_system, 'CapTrak');
        assert.equal(e.n_placed, 9);
        let store = null;
        if ((await kept(page)).kind) {
          store = await waitKept(page, 1);
          const names = store.list[0].files.map((f) => f.name).sort();
          assert.deepEqual(names, [NAME, 'sub-demo01_coordsystem.json', 'sub-demo01_electrodes.tsv'].sort(), 'the copy keeps the electrode files');
          assert.ok(!JSON.stringify(store.list).includes('secret-key-789') && !JSON.stringify(store.list).includes('127.0.0.1'), 'the link is not kept');
        }
        await page.click('[data-log="close"]');
        await clickDialogButton(page, 'Close and finish later');
        await waitForRoute(page, 'home');
        const events = await sentEvents(page);
        if (store) assert.ok(events.some((x) => x.type === 'device_kept' && x.electrodes === true), 'device_kept says the positions were kept');
        const all = JSON.stringify(events);
        for (const secret of ['secret-key-789', 'plain-secret-1', cloud.base.replace('http://', ''), '/cors/data']) assert.ok(!all.includes(secret), `the log holds no ${secret}`);
        await cloud.close(); // the service is gone: the copy on the device is all there is
        if (!store) return; // a browser that keeps nothing: the link part is all there is to test

        // After a reload the kept copy opens with the same positions.
        await page.reload();
        await waitForRoute(page, 'home', 30000);
        await recordEvents(page);
        await page.click('[data-log="open-next"]');
        await waitForRoute(page, 'annotate', 30000);
        await waitForTraces(page);
        const restore = page.locator('.dialog-buttons button', { hasText: 'Restore and continue' });
        if (await restore.count()) await restore.click();
        assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.s.recording.source.kind), 'device');
        await page.waitForFunction(() => Boolean(globalThis.ElectroTag.ws.electrodes), null, { timeout: 15000 });
        m = await readMap(page);
        assert.equal(m.source, 'file');
        assert.match(m.note, /Positions from sub-demo01_electrodes\.tsv/);
        assert.ok(m.els.O1.y < m.els.Cz.y && m.els.Cz.y < m.els.Fp1.y, 'the kept copy\'s positions: Fp1 at the back');
        e = await positionsEvent(page, 0); // the events sent since the reload
        assert.equal(e.source, 'file');
        assert.equal(e.opened_from, 'device');
        assert.equal(e.coordinate_system, 'CapTrak');
        await page.click('[data-log="close"]');
        await clickDialogButton(page, 'Close and finish later');
        await waitForRoute(page, 'home');
      } finally {
        await plain.close().catch(() => {});
        await cloud.close().catch(() => {});
        await close();
      }
    },
  },
];
