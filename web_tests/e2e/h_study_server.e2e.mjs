// The browser application with the real study server (`electroclean-web demo`, started by
// run_e2e.mjs): recordings opened from disk and recognised by their fingerprint, saving into
// ElectroClean's folders, drafts kept on the server, the training programme checked and scored by
// the server, and the interaction logs it writes.
import fs from 'node:fs';
import path from 'node:path';
import { pressSave, signIn, waitForRoute, waitForTraces, annotations, eegPoint, drag, clickDialogButton } from './helpers.mjs';

const PASSWORD = 'electroclean';

/** The files of one recording in the demonstration's recordings folder (all three for BrainVision). */
function filesFor(dir, fileName) {
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

function outputsOf(dir, annotator) {
  const root = path.join(dir, 'study', 'Annotated_Events', `annotator-${annotator}`);
  const out = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p); else out.push(path.relative(root, p));
    }
  })(root);
  return out.sort();
}

function logEvents(dir, annotator) {
  const root = path.join(dir, 'study', 'Annotated_Events', 'interaction_logs', `annotator-${annotator}`);
  return fs.readdirSync(root).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(root, f), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line)));
}

async function signInAt(t, id) {
  const page = await t.newPage({ url: t.study.base });
  await signIn(page, id, PASSWORD);
  return page;
}

async function openFile(t, page, fileName) {
  await waitForRoute(page, 'open');
  await page.setInputFiles('input[data-log="file-input"]', filesFor(t.study.dir, fileName));
}

async function saveAndFinish(page) {
  await pressSave(page);
  await clickDialogButton(page, 'Save and Finish');
}

async function coachText(page) { return (await page.textContent('.coach')).replace(/\s+/g, ' '); }

async function waitForCoach(page, re) {
  // As long as the other waits of this test: each step is a request to the study server, which a
  // busy computer (such as a CI runner) can answer slowly.
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.coach')?.textContent || ''), re.source, { timeout: 30000 });
}

export const tests = [
  {
    name: 'annotate a recording opened from disk and save it into the study folder',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const page = await signInAt(t, 'A01');
      await waitForRoute(page, 'home');
      assert.match(await page.textContent('main'), /0 of 3\s*recordings done/);
      await page.click('[data-log="open-next"]');
      await waitForRoute(page, 'open');
      const name = (await page.textContent('main h1')).replace(/^Open\s+/, '').trim();
      assert.equal(name, 'sub-001_task-rest_eeg.vhdr');
      await openFile(t, page, name);
      await waitForRoute(page, 'annotate', 30000);
      await waitForTraces(page);
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
      assert.equal((await annotations(page)).length, 1);
      await saveAndFinish(page);
      await waitForRoute(page, 'home', 30000);
      await page.waitForSelector('.dialog');
      assert.match(await page.textContent('.dialog'), /are saved and the recording is complete\.\s*(Milestone reached: First recording\.\s*)?Next: sub-002_task-rest_eeg\.vhdr/);
      await clickDialogButton(page, 'Back to my recordings');
      assert.match(await page.textContent('main'), /1 of 3\s*recordings done/);

      const files = outputsOf(t.study.dir, 'A01');
      for (const suffix of ['_annotations.json', '_events.tsv', '_events.json', '_session.json']) {
        assert.ok(files.includes(`sub-001/eeg/sub-001_task-rest_eeg_annotator-A01${suffix}`), `no ${suffix} in ${files.join(', ')}`);
      }
      const tsv = fs.readFileSync(path.join(t.study.dir, 'study', 'Annotated_Events', 'annotator-A01', 'sub-001', 'eeg',
        'sub-001_task-rest_eeg_annotator-A01_events.tsv'), 'utf8');
      if (t.browserName === 'chromium') {
        assert.match(tsv, /\n3\.0\t0\.4\tEye-blink-artifact\tn\/a\t750\t\[\]\t103\telectroclean_artifact\t[0-9a-f]+\tA01\t/);
      } else {
        // WebKit (Safari's engine) reports the pointer in whole pixels, so the drag is within a pixel of 3.0–3.4 s.
        const row = tsv.split('\n').find((l) => l.includes('\tEye-blink-artifact\t')).split('\t');
        assert.ok(Math.abs(Number(row[0]) - 3.0) <= 0.01 && Math.abs(Number(row[1]) - 0.4) <= 0.02 && Math.abs(Number(row[4]) - 750) <= 3, row.join(' '));
        assert.deepEqual([row[3], row[5], row[6], row[7], row[9]], ['n/a', '[]', '103', 'electroclean_artifact', 'A01']);
        assert.match(row[8], /^[0-9a-f]+$/);
      }

      // The same file again: already done.
      await page.locator('button', { hasText: 'Open a recording from your computer' }).click();
      await openFile(t, page, name);
      await page.waitForFunction(() => /already completed/.test(document.querySelector('.result')?.textContent || ''), null, { timeout: 20000 });
      assert.equal(await page.evaluate(() => globalThis.ElectroClean.route), 'open');

      // The interaction log, written by the server: one visit_started, then the browser's events.
      await page.evaluate(() => globalThis.ElectroClean.flushLog());
      const [log] = logEvents(t.study.dir, 'A01');
      assert.equal(log[0].type, 'header');
      assert.equal(log[0].client, 'web');
      const kinds = log.map((e) => e.type);
      assert.equal(kinds.filter((k) => k === 'visit_started').length, 1);
      for (const kind of ['recording_opened', 'key', 'shortcut', 'mouse_press', 'annotation_created', 'recording_finished']) {
        assert.ok(kinds.includes(kind), `no ${kind} event; got ${[...new Set(kinds)].join(', ')}`);
      }
    },
  },
  {
    name: 'unfinished work is kept on the server and restored in another browser',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const file = 'sub-003_task-rest_eeg.edf';
      let page = await signInAt(t, 'A02');
      await waitForRoute(page, 'home');
      await page.locator('tr', { hasText: file }).locator('button', { hasText: 'Open' }).click();
      await openFile(t, page, file);
      await waitForRoute(page, 'annotate', 30000);
      await waitForTraces(page);
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 2.0), await eegPoint(page, 2.5));
      await page.keyboard.press('3');
      await drag(page, await eegPoint(page, 5.0), await eegPoint(page, 6.0));
      assert.equal(await page.evaluate(() => globalThis.ElectroClean.ws.s.saveRemote({ force: true })), true);
      await page.context().close();

      // A new browser has no local copy: the draft comes from the server.
      page = await signInAt(t, 'A02');
      await waitForRoute(page, 'home');
      assert.match(await page.locator('tr', { hasText: file }).textContent(), /In progress/);
      await page.locator('tr', { hasText: file }).locator('button', { hasText: 'Continue' }).click();
      await openFile(t, page, file);
      await page.waitForSelector('.dialog', { timeout: 20000 });
      assert.match(await page.textContent('.dialog'), /2 annotation\(s\)/);
      await clickDialogButton(page, 'Restore and continue');
      await waitForRoute(page, 'annotate', 30000);
      const restored = (await annotations(page)).map((a) => [a.label, a.onset_sample]);
      assert.deepEqual(restored.map((r) => r[0]), ['Eye-blink-artifact', 'EMG-artifact']);
      // where they were drawn (within a pixel in WebKit, which reports the pointer in whole pixels)
      const slack = t.browserName === 'chromium' ? 0 : 3;
      assert.ok(Math.abs(restored[0][1] - 256) <= slack && Math.abs(restored[1][1] - 640) <= slack, JSON.stringify(restored));
      await saveAndFinish(page);
      await waitForRoute(page, 'home', 30000);
      await clickDialogButton(page, 'Back to my recordings');
      const drafts = path.join(t.study.dir, 'study', 'drafts', 'annotator-A02');
      assert.deepEqual(fs.existsSync(drafts) ? fs.readdirSync(drafts) : [], []);
      assert.ok(outputsOf(t.study.dir, 'A02').includes('sub-003/eeg/sub-003_task-rest_eeg_annotator-A02_events.tsv'));
    },
  },
  {
    name: 'the training programme, checked and scored by the server',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const page = await signInAt(t, 'T01');
      await waitForRoute(page, 'training');
      assert.match(await page.textContent('main.training'), /Learn with the experts/);
      const startNext = async () => {
        await page.locator('main.training .btn.primary').first().click();
        await waitForRoute(page, 'open');
        await openFile(t, page, (await page.textContent('main h1')).replace(/^Open\s+/, '').trim());
        await waitForRoute(page, 'annotate', 30000);
        await waitForTraces(page);
      };
      const showMeToTheEnd = async () => {
        for (let i = 0; i < 20 && !/Recording complete/.test(await coachText(page)); i++) {
          await page.locator('.coach button', { hasText: 'Show me' }).click();
          await waitForCoach(page, /This is how the experts marked it/);
          const before = await page.textContent('.coach-header');
        await page.keyboard.press('Enter');
        await page.waitForFunction((h) => document.querySelector('.coach-header')?.textContent !== h, before, { timeout: 30000 });
        }
        await waitForCoach(page, /Recording complete/);
      };

      // Guided recording 1: a wrong attempt is explained by the server, then Show me throughout.
      await startNext();
      await waitForCoach(page, /Recording 1 of 2 +· +Step 1 of 6/);
      await page.keyboard.press('3');
      await drag(page, await eegPoint(page, 1.0), await eegPoint(page, 1.4));
      await waitForCoach(page, /Nothing is marked at (0\.99|1\.0[01])–1\.(39|4[01]) s in the experts' annotations/); // within a pixel
      await page.keyboard.press('Control+z');
      await showMeToTheEnd();
      await saveAndFinish(page);
      await waitForRoute(page, 'training', 30000);
      assert.match(await page.textContent('main.training'), /Recording saved: 6 of 18 stars/);

      // Guided recording 2, then practice: one annotation, scored with a review.
      await startNext();
      await showMeToTheEnd();
      await saveAndFinish(page);
      await waitForRoute(page, 'training', 30000);
      assert.match(await page.locator('[data-stage="guided"]').textContent(), /Completed/);
      await startNext();
      assert.equal(await page.locator('.coach').count(), 0);
      await page.keyboard.press('2');
      await drag(page, await eegPoint(page, 4.1), await eegPoint(page, 4.5));
      await saveAndFinish(page);
      await waitForRoute(page, 'review', 30000);
      const review = (await page.textContent('.review')).replace(/\s+/g, ' ');
      assert.match(review, /Not yet: you need 80% for finding the artifacts and for their types/);
      assert.match(review, /You found 0 of 15 reference artifacts/);
      await page.keyboard.press('n');
      assert.match((await page.evaluate(() => globalThis.ElectroClean.debugState())).selection[0], /^(ref|you)-/);
      await page.locator('.ws-actions button.primary').click();
      await waitForRoute(page, 'training');
      assert.match(await page.locator('[data-stage="practice"]').textContent(), /In progress/);

      // Saved as the desktop application saves training work, with the trainee's progress.
      const events = path.join(t.study.dir, 'study', 'Annotated_Events', 'training', 'example');
      for (const [stage, sub] of [['guided', 'sub-example01'], ['guided', 'sub-example02'], ['practice', 'sub-example03']]) {
        const f = path.join(events, stage, 'annotator-T01', sub, 'eeg', `${sub}_task-example_eeg_annotator-T01_events.tsv`);
        assert.ok(fs.existsSync(f), `no ${f}`);
      }
      assert.ok(fs.existsSync(path.join(t.study.dir, 'study', 'Annotated_Events', 'training_progress', 'example', 'annotator-T01.json')));
      await page.evaluate(() => globalThis.ElectroClean.flushLog());
      const kinds = logEvents(t.study.dir, 'T01').flat().map((e) => e.type);
      for (const kind of ['guided_step_started', 'guided_check', 'guided_show_me', 'guided_step_completed', 'practice_scored']) {
        assert.ok(kinds.includes(kind), `no ${kind} event; got ${[...new Set(kinds)].join(', ')}`);
      }
    },
  },
];
