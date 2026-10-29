// Opening a recording from a link: a stand-in cloud service on another port serves the
// demonstration's EDF file with CORS headers (the page reads it, as from Dropbox) and without them
// (the page cannot, and offers to download the file and then choose it). The link must never reach
// the interaction log.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signIn, waitForRoute, waitForTraces, clickDialogButton } from './helpers.mjs';
import { demoSpecs, syntheticEdfBytes } from '../../electrotag/web/static/js/data/synthetic.js';

export const NAME = 'sub-demo01_task-rest_eeg.edf';

/**
 * A stand-in cloud service: /cors/<name> lets any page read the file, /nocors/<name> does not.
 * `files` maps other file names (such as an electrodes.tsv) to the text served under them, in any
 * folder; every other name is answered with the recording.
 */
export async function cloudService(bytes, { files = {} } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push({ path: url.pathname, headers: req.headers });
    const cors = url.pathname.startsWith('/cors/');
    const base = cors ? { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length' } : {};
    if (req.method === 'OPTIONS') { res.writeHead(204, base); res.end(); return; }
    const own = Object.hasOwn(files, decodeURIComponent(url.pathname.split('/').pop())) ? files[decodeURIComponent(url.pathname.split('/').pop())] : null;
    if (own !== null) { res.writeHead(200, { ...base, 'Content-Type': 'text/plain', 'Content-Length': String(Buffer.byteLength(own)) }); res.end(own); return; }
    if (url.pathname.endsWith('/missing.edf')) { res.writeHead(404, { ...base, 'Content-Type': 'text/plain' }); res.end('no such file'); return; }
    res.writeHead(200, { ...base, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length),
      'Content-Disposition': `attachment; filename="${NAME}"` });
    // in pieces, so that the page shows its progress
    let at = 0;
    const step = Math.ceil(bytes.length / 8);
    const next = () => {
      if (at >= bytes.length) { res.end(); return; }
      res.write(Buffer.from(bytes.subarray(at, at + step)));
      at += step;
      setTimeout(next, 5);
    };
    next();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

/** Keep a copy of every interaction event the page sends. */
export async function recordEvents(page) {
  await page.evaluate(() => {
    const b = globalThis.ElectroTag.backend;
    const send = b.sendEvents.bind(b);
    globalThis.__events = [];
    b.sendEvents = (id, batch, o) => { globalThis.__events.push(...batch); return send(id, batch, o); };
  });
}

export async function sentEvents(page) {
  return page.evaluate(async () => { await globalThis.ElectroTag.flushLog(); return globalThis.__events; });
}

/** Remove the browser's own console report of the request the stand-in service refused. */
export function forgetRefusals(errors) {
  for (let i = errors.length - 1; i >= 0; i--) if (/\/nocors\/|not allowed by Access-Control-Allow-Origin/.test(errors[i])) errors.splice(i, 1);
}

export const tests = [
  {
    name: 'open a recording from a link that the page may read, and fall back to download and choose for one it may not',
    async run(t) {
      const { assert } = t;
      const bytes = syntheticEdfBytes(demoSpecs()[0]);
      const cloud = await cloudService(bytes);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-links-'));
      try {
        const page = await t.newPage();
        await signIn(page, 'A01');
        await waitForRoute(page, 'home');
        await recordEvents(page);
        await page.click('[data-log="open-next"]');
        await waitForRoute(page, 'open');
        await t.screenshot(page, 'links_open_view');

        // A link the page may read: fetched, fingerprinted, recognised and opened.
        // (not kept on the device here, so that the next Open asks again: l_device.e2e.mjs keeps)
        // (WebKit's private profiles store nothing, and the tick box is then a sentence instead)
        await page.evaluate(async () => (await import('./js/views/device.js')).deviceStore(globalThis.ElectroTag).usable());
        if (await page.locator('[data-log="keep-link"]').count()) await page.uncheck('[data-log="keep-link"]');
        const good = `${cloud.base}/cors/${NAME}?rlkey=secret-key-123`;
        await page.fill('.link-panel textarea', good);
        await page.click('[data-log="open-link"]');
        await waitForRoute(page, 'annotate', 30000);
        await waitForTraces(page);
        const s = await page.evaluate(() => ({ file: globalThis.ElectroTag.ws.s.recording.fileName, mode: globalThis.ElectroTag.ws.s.mode }));
        assert.equal(s.file, NAME);
        assert.equal(s.mode, 'standard');
        const fetched = cloud.seen.find((r) => r.path.startsWith('/cors/'));
        assert.ok(fetched, 'the page asked the stand-in service');
        assert.equal(fetched.headers.referer, undefined, 'no referrer is sent to the service');
        assert.equal(fetched.headers.cookie, undefined, 'no cookies are sent to the service');
        await page.click('[data-log="close"]');
        await clickDialogButton(page, 'Discard and close');
        await waitForRoute(page, 'home');

        // A file that is not there: said in plain words.
        await page.click('[data-log="open-next"]');
        await waitForRoute(page, 'open');
        await page.fill('.link-panel textarea', `${cloud.base}/cors/missing.edf`);
        await page.click('[data-log="open-link"]');
        await page.waitForSelector('.link-status .banner');
        assert.match(await page.textContent('.link-status'), /no file at this link any more/);

        // Not a web link, and http:// for another computer: refused before anything is fetched.
        await page.fill('.link-panel textarea', 'http://files.example.org/a.edf');
        await page.click('[data-log="open-link"]');
        assert.match(await page.textContent('.link-status'), /starts with http:\/\/, which is not private/);

        // A link the page may not read (no CORS): the error and the two steps of the fallback.
        const blocked = `${cloud.base}/nocors/${NAME}`;
        await page.fill('.link-panel textarea', blocked);
        await page.click('[data-log="open-link"]');
        await page.waitForSelector('.link-status .banner');
        const text = await page.textContent('.link-status');
        assert.match(text, /did not let this page read the file/);
        assert.match(text, /download the file instead, then choose it here/);
        assert.match(text, /cannot reach that folder/);
        await t.screenshot(page, 'links_fallback');
        // "Download the file" opens the download address in a new tab, without opener or referrer.
        await page.evaluate(() => { globalThis.__opened = []; window.open = (...a) => { globalThis.__opened.push(a); return null; }; });
        await page.click('[data-log="link-download"]');
        assert.deepEqual(await page.evaluate(() => globalThis.__opened), [[blocked, '_blank', 'noopener,noreferrer']]);
        const local = path.join(dir, NAME);
        fs.writeFileSync(local, bytes);
        const chooser = page.waitForEvent('filechooser');
        await page.click('[data-log="link-choose"]');
        await (await chooser).setFiles(local);
        await waitForRoute(page, 'annotate', 30000);
        await waitForTraces(page);
        await page.click('[data-log="close"]');
        await clickDialogButton(page, 'Discard and close');
        await waitForRoute(page, 'home');

        // The interaction log has the service and the size, never the link or its key.
        const events = await sentEvents(page);
        const all = JSON.stringify(events);
        assert.ok(events.some((e) => e.type === 'link_fetched' && e.size_bytes === bytes.length && e.files === 1), 'link_fetched logged');
        assert.ok(events.some((e) => e.type === 'link_failed' && e.kind === 'blocked'), 'link_failed logged');
        assert.ok(!all.includes('secret-key-123'), 'the link\'s key is not logged');
        assert.ok(!all.includes(cloud.base.replace('http://', '')), 'the link is not logged');
        // The browser itself reports the refused request on the console, as it should.
        forgetRefusals(t.errors);
      } finally {
        await cloud.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];
