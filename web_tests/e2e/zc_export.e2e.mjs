// An annotator downloads their own saved files of a recording (docs/web/using.md, "Your own files"):
// from the Saved dialog after Save and Finish, and from the History, as one zip or as separate files,
// in the sandbox and on the study server, where they are exactly the files the study keeps.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { signIn, waitForRoute, waitForTraces, openExample, eegPoint, drag, pressSave, clickDialogButton } from './helpers.mjs';

/** The files of a downloaded zip, read with Python's zipfile: {name: text}. */
function unzip(file) {
  const py = process.env.ELECTROTAG_PYTHON || 'python3';
  const r = spawnSync(py, ['-I', '-c', 'import json, sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\n'
    + 'print(json.dumps({i.filename: z.read(i).decode("utf-8") for i in z.infolist()}))', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

async function download(page, click) {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), click()]);
  return { name: d.suggestedFilename(), file: await d.path() };
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
    name: 'sandbox: after Save and Finish, and from the History, my annotations download as a zip and as separate files',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .saved-download');
      const text = await page.textContent('.dialog');
      assert.match(text, /You can keep a copy of what you saved: the events table \(BIDS events\.tsv\)/);
      await t.screenshot(page, 'saved_download');
      const zip = await download(page, () => page.click('.dialog [data-log="download-mine"]'));
      assert.equal(zip.name, 'sub-demo01_task-rest_eeg_annotator-A01.zip');
      const files = unzip(zip.file);
      assert.deepEqual(Object.keys(files).sort(), ['annotations.json', 'events.json', 'events.tsv', 'session.json', 'time_viewed.txt']
        .map((s) => `sub-demo01_task-rest_eeg_annotator-A01_${s}`));
      const tsv = files['sub-demo01_task-rest_eeg_annotator-A01_events.tsv'];
      assert.match(tsv, /\tEye-blink-artifact\tn\/a\t7\d\d\t\[\]\t103\telectrotag_artifact\t[0-9a-f]{32}\tA01\tn\/a\tn\/a\tn\/a\n/);
      assert.equal(JSON.parse(files['sub-demo01_task-rest_eeg_annotator-A01_annotations.json']).n_annotations, 1);
      assert.match(await page.textContent('.saved-download-status'), /offered to save/);
      // the dialog stays open: the download is beside its own buttons
      await clickDialogButton(page, 'Back to my recordings');
      await waitForRoute(page, 'home');
      await page.click('.rec-tabs [data-tab="history"]');
      const row = page.locator('table.history tbody tr', { hasText: 'sub-demo01_task-rest_eeg.edf' });
      await t.screenshot(page, 'history_download');
      const again = await download(page, () => row.locator('[data-log="download-mine"]').click());
      assert.deepEqual(unzip(again.file)[`sub-demo01_task-rest_eeg_annotator-A01_events.tsv`], tsv);
      // separate files, from the row's menu
      const seen = [];
      page.on('download', (d) => seen.push(d.suggestedFilename()));
      await row.locator('[data-log="recording-more"]').click();
      await page.locator('.row-menu [role="menuitem"], .row-menu button', { hasText: 'as separate files' }).first().click();
      await page.waitForFunction(() => true);
      for (let i = 0; i < 50 && seen.length < 5; i++) await page.waitForTimeout(100);
      assert.deepEqual(seen.sort(), Object.keys(files).sort());
    },
  },
  {
    name: 'study server: the History gives exactly the files the study keeps',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ url: t.study.base });
      await signIn(page, 'A01', 'electrotag');
      await waitForRoute(page, 'home');
      await page.click('.rec-tabs [data-tab="history"]');
      let rows = await page.locator('table.history tbody tr').count();
      if (!rows) { // nothing saved yet by the specs before: save one
        await page.click('[data-log="open-next"]');
        await waitForRoute(page, 'open');
        const name = (await page.textContent('main h1')).replace(/^Open\s+/, '').trim();
        await page.setInputFiles('input[data-log="file-input"]', studyFiles(t.study.dir, name));
        await waitForRoute(page, 'annotate', 30000);
        await waitForTraces(page);
        await page.keyboard.press('1');
        await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
        await pressSave(page);
        await clickDialogButton(page, 'Save and Finish');
        await page.waitForSelector('.dialog .saved-download', { timeout: 30000 });
        await clickDialogButton(page, 'Back to my recordings');
        await page.click('.rec-tabs [data-tab="history"]');
        rows = await page.locator('table.history tbody tr').count();
      }
      assert.ok(rows >= 1);
      const row = page.locator('table.history tbody tr').first();
      const zip = await download(page, () => row.locator('[data-log="download-mine"]').click());
      const files = unzip(zip.file);
      const root = path.join(t.study.dir, 'study', 'Annotated_Events', 'annotator-A01');
      const kept = {};
      (function walk(d) {
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f);
          if (fs.statSync(p).isDirectory()) walk(p); else kept[f] = fs.readFileSync(p, 'utf8');
        }
      })(root);
      assert.equal(Object.keys(files).length, 5);
      for (const [name, text] of Object.entries(files)) assert.equal(text, kept[name], `${name} is the study's file`);
      assert.equal(zip.name, `${Object.keys(files)[0].replace(/_(annotations|events|session|time_viewed)\.\w+$/, '')}.zip`);
    },
  },
];
