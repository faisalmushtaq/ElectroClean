// Recordings kept on this device: a recording fetched from a link is kept, opens again after a
// reload without the service, is finished, and "Remove finished recordings" leaves the storage
// empty; the same with IndexedDB (where the page cannot write to the Origin Private File System),
// the offer at signing out, and a full device.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signIn, waitForRoute, waitForTraces, clickDialogButton, eegPoint, drag } from './helpers.mjs';
import { cloudService, recordEvents, sentEvents, NAME } from './l_links.e2e.mjs';
import { demoSpecs, syntheticEdfBytes } from '../../electroclean/web/static/js/data/synthetic.js';

const require = createRequire(import.meta.url);

/**
 * A page in a browser profile kept on disk. The runner's pages live in fresh, private profiles, in
 * which WebKit (like Safari in a private window) stores no files at all; an annotator's Safari keeps
 * them, and so does this profile.
 */
async function profilePage(t, { init = null } = {}) {
  const pw = require('playwright');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-profile-'));
  const context = await pw[t.browserName].launchPersistentContext(dir, { headless: true, viewport: { width: 1600, height: 950 }, locale: 'en-GB', acceptDownloads: true });
  const page = context.pages()[0] || await context.newPage();
  page.on('pageerror', (e) => t.errors.push(`pageerror: ${(e.stack || e.message).split('\n').slice(0, 4).join(' | ')}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) t.errors.push(`console: ${m.text()}`); });
  if (init) await page.addInitScript(init);
  await page.goto(t.base);
  return { page, close: async () => { await context.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** The kept recordings of the signed-in annotator, as the page's own store lists them. */
async function kept(page) {
  return page.evaluate(async () => {
    const { deviceStore } = await import('./js/views/device.js');
    const s = deviceStore(globalThis.ElectroClean);
    return { kind: s.kind, list: await s.list() };
  });
}

/** Every file under the application's folder of the Origin Private File System. */
async function opfsFiles(page) {
  return page.evaluate(async () => {
    if (!navigator.storage || !navigator.storage.getDirectory) return [];
    const out = [];
    const walk = async (dir, at) => {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') await walk(h, `${at}${name}/`); else out.push(`${at}${name}`);
      }
    };
    try { await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('electroclean-recordings'), ''); } catch { /* none */ }
    return out;
  });
}

async function idbCount(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('electroclean-device', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('recordings', { keyPath: 'key' }).createIndex('owner', 'owner');
    req.onsuccess = () => {
      const tx = req.result.transaction('recordings', 'readonly');
      const c = tx.objectStore('recordings').count();
      c.onsuccess = () => { resolve(c.result); req.result.close(); };
    };
    req.onerror = () => resolve(-1);
  }));
}

async function waitKept(page, n) {
  const t0 = Date.now();
  for (;;) {
    const k = await kept(page);
    if (k.list.length === n) return k;
    if (Date.now() - t0 > 20000) {
      const why = await page.evaluate(() => globalThis.ElectroClean.deviceProblem || 'no problem reported');
      throw new Error(`${k.list.length} recordings kept, expected ${n} (${why})`);
    }
    await page.waitForTimeout(100);
  }
}

async function openFromLink(page, url) {
  await page.fill('.link-panel textarea', url);
  await page.click('[data-log="open-link"]');
  await waitForRoute(page, 'annotate', 30000);
  await waitForTraces(page);
}

async function saveAndFinish(page) {
  await page.keyboard.press('1');
  await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
  await page.click('.ws-actions button.primary');
  await clickDialogButton(page, 'Save and Finish');
  await page.waitForSelector('.dialog .dialog-title');
  await clickDialogButton(page, 'Back to my recordings');
  await waitForRoute(page, 'home');
}

/** Make the page's file system writes fail as a full device does. */
function fullDevice() {
  const full = () => Promise.reject(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
  if (globalThis.FileSystemWritableFileStream) FileSystemWritableFileStream.prototype.write = full;
  if (globalThis.IDBObjectStore) {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) { if (this.name === 'recordings') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); return put.apply(this, a); };
  }
}

export const tests = [
  {
    name: 'keep a recording from a link, reopen it after a reload without the service, finish it and remove finished recordings',
    async run(t) {
      const { assert } = t;
      const bytes = syntheticEdfBytes(demoSpecs()[0]);
      const cloud = await cloudService(bytes);
      const { page, close } = await profilePage(t);
      try {
        await signIn(page, 'A01');
        await waitForRoute(page, 'home');
        await page.click('[data-log="open-next"]');
        await waitForRoute(page, 'open');
        assert.equal(await page.isChecked('[data-log="keep-link"]'), true, 'links are kept unless the annotator says otherwise');
        assert.equal(await page.isChecked('[data-log="keep-chosen"]'), false, 'chosen files are not kept unless asked');
        await openFromLink(page, `${cloud.base}/cors/${NAME}?rlkey=secret-key-456`);
        await waitKept(page, 1);
        const k = await kept(page);
        assert.equal(k.kind, 'opfs', 'Chromium and Safari 26 write to the Origin Private File System from the page');
        assert.equal(k.list[0].fileName, NAME);
        assert.equal(k.list[0].size, bytes.length);
        assert.ok(!JSON.stringify(k.list).includes('secret-key-456') && !JSON.stringify(k.list).includes('127.0.0.1'), 'the link is not kept');
        if (k.kind === 'opfs') assert.equal((await opfsFiles(page)).length, 2, 'the file and its description');
        await page.click('[data-log="close"]');
        await clickDialogButton(page, 'Close and finish later');
        await waitForRoute(page, 'home');
        await cloud.close(); // the service is gone: the copy on the device is all there is

        await page.reload();
        await waitForRoute(page, 'home', 30000);
        await page.waitForSelector('.device-line:not([hidden])');
        assert.match(await page.textContent('.device-line'), /1 recording kept on this device, \d+(\.\d)? (kB|MB)\. Manage/);
        await t.screenshot(page, 'device_home_line');
        await recordEvents(page);
        await page.click('[data-log="open-next"]');
        await waitForRoute(page, 'annotate', 30000);
        await waitForTraces(page);
        const restore = page.locator('.dialog-buttons button', { hasText: 'Restore and continue' });
        if (await restore.count()) await restore.click();
        await saveAndFinish(page);

        // the panel: the recording is finished; removing finished recordings empties the storage
        await page.click('.device-line [data-log="device-manage"]');
        await page.waitForSelector('.dialog.device');
        assert.match(await page.textContent('.dialog.device'), /Finished/);
        assert.match(await page.textContent('.dialog.device'), /never touches your annotations, drafts or results/);
        await t.screenshot(page, 'device_panel');
        await page.click('[data-log="device-remove-finished"]');
        assert.match(await page.textContent('.device-confirm'), /Remove the 1 finished recording from this device\? This frees \d/);
        await page.click('[data-log="device-confirm-yes"]');
        await page.waitForSelector('.device-empty');
        await clickDialogButton(page, 'Close');
        assert.deepEqual((await kept(page)).list, []);
        assert.deepEqual(await opfsFiles(page), []);
        assert.equal(await page.isHidden('.device-line'), true);
        const events = await sentEvents(page);
        assert.ok(events.some((e) => e.type === 'device_opened' && e.size_bytes === bytes.length));
        assert.ok(events.some((e) => e.type === 'device_removed' && e.reason === 'finished' && e.count === 1 && e.size_bytes === bytes.length));
      } finally {
        await close();
      }
    },
  },
  {
    name: 'IndexedDB where the page cannot write files: keep a chosen file, remove it when finished, and the offer at signing out',
    async run(t) {
      const { assert } = t;
      const bytes = syntheticEdfBytes(demoSpecs()[0]);
      const { page, close } = await profilePage(t, { init: () => { if (globalThis.FileSystemFileHandle) delete FileSystemFileHandle.prototype.createWritable; } });
      try {
        await signIn(page, 'A01');
        await waitForRoute(page, 'home');
        await page.click('[data-log="open-next"]');
        await waitForRoute(page, 'open');
        await page.check('[data-log="keep-chosen"]');
        await page.setInputFiles('input[data-log="file-input"]', { name: NAME, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
        await waitForRoute(page, 'annotate', 30000);
        await waitKept(page, 1);
        assert.equal((await kept(page)).kind, 'idb');
        assert.equal(await idbCount(page), 1);
        await page.click('[data-log="close"]');
        await clickDialogButton(page, 'Close and finish later');
        await waitForRoute(page, 'home');

        // "Remove a recording from this device when I finish it", remembered for the annotator
        await page.click('.device-line [data-log="device-manage"]');
        await page.check('[data-log="device-remove-when-finished"]');
        await clickDialogButton(page, 'Close');
        await page.click('[data-log="open-next"]');
        await waitForRoute(page, 'annotate', 30000);
        await waitForTraces(page);
        const restore = page.locator('.dialog-buttons button', { hasText: 'Restore and continue' });
        if (await restore.count()) await restore.click();
        await saveAndFinish(page);
        await waitKept(page, 0);
        assert.equal(await idbCount(page), 0);

        // a second recording kept, then removed at signing out
        await page.click('text=Open a recording from your computer…');
        await waitForRoute(page, 'open');
        assert.equal(await page.isChecked('[data-log="keep-chosen"]'), true, 'the choice is remembered');
        const second = demoSpecs()[1];
        const name2 = `${second.stem}_eeg.edf`;
        await page.setInputFiles('input[data-log="file-input"]', { name: name2, mimeType: 'application/octet-stream', buffer: Buffer.from(syntheticEdfBytes(second)) });
        await waitForRoute(page, 'annotate', 30000);
        await waitKept(page, 1);
        await page.click('[data-log="close"]');
        await clickDialogButton(page, 'Close and finish later');
        await waitForRoute(page, 'home');
        await page.click('[data-log="sign-out"]');
        await page.waitForSelector('.dialog');
        assert.match(await page.textContent('.dialog'), /1 recording is kept on this device for you/);
        await t.screenshot(page, 'device_sign_out');
        await clickDialogButton(page, 'Remove them');
        await waitForRoute(page, 'signin');
        assert.equal(await idbCount(page), 0);
      } finally {
        await close();
      }
    },
  },
  {
    name: 'a full device: the recording opens from memory and the message says so',
    async run(t) {
      const { assert } = t;
      const bytes = syntheticEdfBytes(demoSpecs()[0]);
      const cloud = await cloudService(bytes);
      try {
          const { page, close } = await profilePage(t, { init: fullDevice });
          t.cleanup = close;
          await signIn(page, 'A01');
          await waitForRoute(page, 'home');
          await recordEvents(page);
          await page.click('[data-log="open-next"]');
          await waitForRoute(page, 'open');
          await openFromLink(page, `${cloud.base}/cors/${NAME}`);
          await page.waitForSelector('.dialog.device-full');
          assert.match(await page.textContent('.dialog.device-full'), /The recording is open, but this device has no room to keep a copy of it/);
          await clickDialogButton(page, 'OK');
          assert.equal((await page.evaluate(() => globalThis.ElectroClean.route)), 'annotate');
          assert.deepEqual((await kept(page)).list, []);
          assert.ok((await sentEvents(page)).some((e) => e.type === 'device_full' && e.size_bytes === bytes.length));
      } finally {
        await cloud.close();
        if (t.cleanup) await t.cleanup();
      }
    },
  },
  {
    name: 'a browser that stores nothing (a private window): the tick boxes give way to a plain sentence',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ url: null });
      await page.addInitScript(() => {
        if (navigator.storage) navigator.storage.getDirectory = () => Promise.reject(new DOMException('no', 'SecurityError'));
        const open = indexedDB.open.bind(indexedDB);
        indexedDB.open = (name, v) => { if (name === 'electroclean-device') throw new DOMException('no', 'InvalidStateError'); return open(name, v); };
      });
      await page.goto(t.base);
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await page.click('[data-log="open-next"]');
      await waitForRoute(page, 'open');
      await page.waitForSelector('.device-cannot');
      assert.equal(await page.locator('.device-cannot').count(), 2);
      assert.equal(await page.locator('[data-log="keep-link"], [data-log="keep-chosen"]').count(), 0);
    },
  },
];
