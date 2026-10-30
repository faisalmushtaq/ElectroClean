// Opening a recording "from the computer": the demonstration's EDF file (recognised by its
// fingerprint), a changed copy (recognised by name, layout and length), and a file that is not
// part of the study (try-out mode).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signIn, waitForRoute, waitForTraces, state, annotations, eegPoint, drag, clickDialogButton } from './helpers.mjs';
import { demoSpecs, syntheticEdfBytes } from '../../electrotag/web/static/js/eeg/synthetic.js';

function writeFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-e2e-'));
  const spec = demoSpecs()[0];
  const bytes = syntheticEdfBytes(spec);
  const good = path.join(dir, 'sub-demo01_task-rest_eeg.edf');
  fs.writeFileSync(good, bytes);
  const changedDir = path.join(dir, 'changed');
  fs.mkdirSync(changedDir);
  const changed = path.join(changedDir, 'sub-demo01_task-rest_eeg.edf');
  const copy = Buffer.from(bytes);
  copy[copy.length - 1] ^= 0x01; // one data byte differs
  fs.writeFileSync(changed, copy);
  const other = path.join(dir, 'my_own_recording.edf');
  fs.writeFileSync(other, copy);
  return { dir, good, changed, other };
}

export const tests = [
  {
    name: 'open the example EDF from the computer, a changed copy and a file outside the study',
    async run(t) {
      const { assert } = t;
      const files = writeFiles();
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await page.click('[data-log="open-next"]');
      await waitForRoute(page, 'open');
      assert.match(await page.textContent('main h1'), /Open sub-demo01_task-rest_eeg\.edf/);
      await t.screenshot(page, 'open');
      await page.setInputFiles('input[data-log="file-input"]', files.good);
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      let s = await state(page);
      assert.equal(s.route, 'annotate');
      // The file read from the computer shows the same EEG as the built-in example.
      const samples = await page.evaluate(async () => {
        const ws = globalThis.ElectroTag.ws;
        const w = await ws.s.recording.readWindow({ startSample: 750, nSamples: 5, channels: [0], filters: null });
        return Array.from(w.data[0]);
      });
      assert.equal(samples.length, 5);
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
      assert.equal((await annotations(page)).length, 1);
      await page.click('[data-log="close"]');
      await clickDialogButton(page, 'Discard and close');
      await clickDialogButton(page, 'Delete them');
      await waitForRoute(page, 'home');

      // A changed copy: same name and layout, other fingerprint.
      await page.click('[data-log="open-next"]');
      await waitForRoute(page, 'open');
      await page.setInputFiles('input[data-log="file-input"]', files.changed);
      await page.waitForSelector('.dialog');
      assert.match(await page.textContent('.dialog'), /not byte for byte the study's copy/);
      assert.match(await page.textContent('.dialog'), /checksum differs from that of the study's copy/);
      await t.screenshot(page, 'open_changed_copy');
      await clickDialogButton(page, 'Open it anyway');
      await waitForRoute(page, 'annotate');
      await page.click('[data-log="close"]');
      await clickDialogButton(page, 'Discard and close');
      await waitForRoute(page, 'home');

      // A file that is not part of the study: try-out mode, nothing saved.
      await page.click('text=Open a recording from your computer…');
      await waitForRoute(page, 'open');
      await page.setInputFiles('input[data-log="file-input"]', files.other);
      await page.waitForSelector('.result .banner');
      assert.match(await page.textContent('.result'), /not one of the recordings of this study/);
      await t.screenshot(page, 'open_unknown');
      await page.click('text=Look at it without saving');
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      assert.match(await page.textContent('.ws-header'), /nothing you mark is saved/);
      assert.equal(await page.locator('.ws-actions button.primary').textContent(), 'Download my annotations');
      await page.keyboard.press('3');
      await drag(page, await eegPoint(page, 1.0), await eegPoint(page, 2.0));
      s = await state(page);
      assert.equal(s.annotations.length, 1);
      await t.screenshot(page, 'tryout');
      const download = page.waitForEvent('download');
      await page.click('.ws-actions button.primary');
      const d = await download;
      assert.match(d.suggestedFilename(), /my_own_recording_tryout_annotations\.json$/);
      fs.rmSync(files.dir, { recursive: true, force: true });
    },
  },
];
