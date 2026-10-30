// Reloading the page while annotating loses nothing (docs/web/using.md, "Saving and drafts"): the
// work made a moment before the reload is in this browser's copy (written when the page goes), and
// the recording opens again where it was. In the sandbox a built-in example and a training recording
// open by themselves; a file from the computer, in the sandbox (a try-out) or on a study server, is
// chosen again and its work comes back without a question.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signIn, waitForRoute, waitForTraces, openExample, eegPoint, drag, annotations, skipFirstStages, state } from './helpers.mjs';
import { demoSpecs, syntheticEdfBytes } from '../../electrotag/web/static/js/eeg/synthetic.js';

/** Reload, and wait for the application to have started again. */
async function reload(page) {
  await page.reload();
  await page.waitForFunction(() => globalThis.ElectroTag && !['signin', undefined].includes(globalThis.ElectroTag.route)
    && !document.querySelector('main.page.loading'), null, { timeout: 30000 });
}

/** The recording opens again by itself after the reload. */
async function backInRecording(page) {
  await waitForRoute(page, 'annotate', 30000);
  await waitForTraces(page);
}

function studyFiles(dir, fileName) {
  const stem = fileName.replace(/\.(vhdr|edf|bdf)$/i, '');
  const found = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.startsWith(stem) && /\.(vhdr|vmrk|eeg|edf|bdf)$/i.test(f)) found.push(p);
    }
  })(path.join(dir, 'recordings'));
  return found;
}

export const tests = [
  {
    name: 'sandbox example: a reload right after a mark, and right after an edit, opens it again with the work',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      // A mark, then a reload at once: well within the moment before this browser's copy is written.
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
      await reload(page);
      await backInRecording(page);
      assert.equal(await page.locator('.dialog').count(), 0, 'no question: the work comes back as with Continue');
      let anns = await annotations(page);
      assert.deepEqual(anns.map((a) => a.label), ['Eye-blink-artifact']);
      // An edit (its type changed), then a reload at once.
      const p = await eegPoint(page, 3.2);
      await page.keyboard.press('Escape');
      await page.mouse.click(p.x, p.y);
      await page.waitForFunction(() => globalThis.ElectroTag.debugState().selection.length === 1);
      await page.keyboard.press('3');
      assert.equal((await annotations(page))[0].label, 'EMG-artifact');
      await reload(page);
      await backInRecording(page);
      anns = await annotations(page);
      assert.deepEqual(anns.map((a) => a.label), ['EMG-artifact']);
      // Leaving the recording on purpose: a reload then shows the page it went to.
      await page.click('[data-log="close"]');
      await page.locator('.dialog-buttons button', { hasText: 'Close and finish later' }).click();
      await waitForRoute(page, 'home');
      await reload(page);
      assert.equal((await state(page)).route, 'home');
    },
  },
  {
    name: 'sandbox training: a reload during a coach step opens the step again with its marks',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'T01');
      await waitForRoute(page, 'training');
      await skipFirstStages(page);
      await page.locator('main.training .btn.primary').click();
      await waitForRoute(page, 'open');
      await page.locator('.example-card button').click();
      await backInRecording(page);
      await page.waitForFunction(() => /Step 1 of 6/.test(document.querySelector('.coach')?.textContent || ''));
      await page.keyboard.press('3');
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
      await page.waitForFunction(() => /Not quite yet/.test(document.querySelector('.coach')?.textContent || ''));
      await reload(page);
      await backInRecording(page);
      await page.waitForFunction(() => /Step 1 of 6/.test(document.querySelector('.coach')?.textContent || ''), null, { timeout: 15000 });
      assert.deepEqual((await annotations(page)).map((a) => a.label), ['EMG-artifact']);
    },
  },
  {
    name: 'sandbox, a file from this computer (a try-out): after a reload, choosing it again brings the marks back',
    async run(t) {
      const { assert } = t;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-refresh-'));
      const copy = Buffer.from(syntheticEdfBytes(demoSpecs()[0]));
      copy[copy.length - 1] ^= 0x01; // not one of the study's recordings
      const file = path.join(dir, 'my_own_recording.edf');
      fs.writeFileSync(file, copy);
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      const tryOut = async () => {
        await page.setInputFiles('input[data-log="file-input"]', file);
        await page.locator('button', { hasText: 'Look at it without saving' }).click();
        await backInRecording(page);
      };
      await page.click('[data-log="open-next"]');
      await waitForRoute(page, 'open');
      await tryOut();
      await page.keyboard.press('3');
      await drag(page, await eegPoint(page, 1.0), await eegPoint(page, 2.0));
      await reload(page);
      await waitForRoute(page, 'open');
      assert.match(await page.textContent('.reopen-note'), /reloaded while my_own_recording\.edf was open\. Choose it again and the marks you made come back/);
      await tryOut();
      assert.equal(await page.locator('.dialog').count(), 0);
      assert.deepEqual((await annotations(page)).map((a) => a.label), ['EMG-artifact']);
      // Close lets the marks go: they are not offered again.
      await page.click('[data-log="close"]');
      await page.locator('.dialog-buttons button', { hasText: /^Close$/ }).click();
      await waitForRoute(page, 'home');
      assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('|tryout|'))), []);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: 'study server: a reload right after a mark; the file chosen again opens with the work',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ url: t.study.base });
      await signIn(page, 'A02', 'electrotag');
      await waitForRoute(page, 'home');
      await page.click('[data-log="open-next"]');
      await waitForRoute(page, 'open');
      const name = (await page.textContent('main h1')).replace(/^Open\s+/, '').trim();
      await page.setInputFiles('input[data-log="file-input"]', studyFiles(t.study.dir, name));
      await backInRecording(page);
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
      await page.keyboard.press('3');
      await drag(page, await eegPoint(page, 5.0), await eegPoint(page, 5.5));
      await reload(page);
      await waitForRoute(page, 'open');
      assert.match(await page.textContent('main h1'), new RegExp(`Open ${name.replace(/\./g, '\\.')}`));
      assert.match(await page.textContent('.reopen-note'), /Your work is kept: choose the file again and it opens where you left off/);
      await page.setInputFiles('input[data-log="file-input"]', studyFiles(t.study.dir, name));
      await backInRecording(page);
      assert.equal(await page.locator('.dialog').count(), 0);
      assert.deepEqual((await annotations(page)).map((a) => a.label).sort(), ['EMG-artifact', 'Eye-blink-artifact']);
      // The study had the draft too: it is deleted with the work, so that the server is left as it was.
      await page.click('[data-log="close"]');
      await page.locator('.dialog-buttons button', { hasText: 'Discard and close' }).click();
      await page.locator('.dialog-buttons button', { hasText: 'Delete them' }).click();
      await waitForRoute(page, 'home');
    },
  },
];
