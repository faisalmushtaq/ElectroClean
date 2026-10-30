// Correct the marks (docs/web/admin.md "Correct the marks", docs/web/using.md "Learn with the experts"):
// an expert opens the sandbox's ready-made exercise in the expert area, tries it and checks the
// corrections in the browser; on a study server, the study team makes an exercise for a guided
// recording and a trainee corrects the marks on the training path and reads how they did.
import fs from 'node:fs';
import path from 'node:path';
import { clickDialogButton, pressSave, signIn, skipFirstStages, waitForRoute, waitForTraces } from './helpers.mjs';

export const tests = [
  {
    name: 'an expert tries the sandbox\'s exercise: the planted mistakes, the copy to correct, and the check',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'E01');
      await page.waitForFunction(() => globalThis.ElectroTag && globalThis.ElectroTag.route !== 'signin');
      await page.evaluate(() => globalThis.ElectroTag.showExpert('expert-planted'));
      await waitForRoute(page, 'expert-planted');
      await page.waitForSelector('[data-section="planted"] .planted-row');
      assert.equal(await page.locator('[data-section="planted"] .planted-row').count(), 2, 'the two guided recordings of the set');
      assert.match(await page.locator('.planted-row').first().textContent(), /4 mistakes/);
      assert.match(await page.locator('.planted-row').nth(1).textContent(), /No exercise/);
      await page.locator('.planted-row').first().locator('[data-log="planted-open"]').click();
      await page.waitForSelector('.planted-admin table');
      assert.equal(await page.locator('.planted-admin tbody tr').count(), 4);
      assert.match(await page.textContent('.planted-admin'), /4 deliberate mistakes, made from seed 2026/);
      await t.screenshot(page, 'planted_expert_section');
      // making another needs a study server, said in plain words
      await page.locator('.planted-admin summary', { hasText: 'Make it again' }).click();
      await page.click('[data-log="planted-make"]');
      await page.waitForFunction(() => /study server or Firebase/.test(document.querySelector('.planted-admin').textContent));
      // Try it: the example opens with the exercise's copy of the marks
      await page.click('[data-log="planted-try"]');
      await waitForRoute(page, 'expert-planted-try');
      await page.locator('button[data-log^="example-"]').click();
      await page.waitForSelector('.planted-panel');
      await waitForTraces(page);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.size), 6);
      assert.match(await page.textContent('.planted-panel'), /4 deliberate mistakes/);
      await page.click('[data-log="planted-check"]');
      await page.waitForSelector('.planted-panel .planted-item');
      assert.match(await page.textContent('.planted-panel .coach-feedback'), /^You fixed 0 of 4 planted mistakes\.$/);
      assert.equal(await page.locator('.planted-panel .planted-item.not-fixed').count(), 4);
      await t.screenshot(page, 'planted_try_checked');
      // the experts' marks as dashed outlines, then the marks put right: every mistake fixed
      await page.click('[data-log="planted-layer"]');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.viewer.layers[0].visible), true);
      await page.evaluate(() => { const ws = globalThis.ElectroTag.ws; ws.store.reset(ws.coach.target.reference.map((a) => ({ ...a }))); });
      await page.click('[data-log="planted-check"]');
      await page.waitForFunction(() => /^You fixed 4 of 4/.test(document.querySelector('.planted-panel .coach-feedback').textContent));
      assert.equal(await page.locator('.planted-panel .planted-item.fixed').count(), 4);
      await t.screenshot(page, 'planted_try_fixed');
      await page.click('[data-log="planted-restart"]');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.size), 6);
      const events = await page.evaluate(() => JSON.stringify(globalThis.ElectroTag.backend.state.visits || {}));
      assert.ok(events.length > 0);
    },
  },
  {
    name: 'on a study server: the study team makes an exercise, and a trainee corrects the marks and reads how they did',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const call = async (token, method, p, body) => {
        const r = await fetch(`${t.study.base}api/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined,
          headers: { 'Content-Type': 'application/json', 'X-ElectroTag': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
        const j = await r.json();
        if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j)}`);
        return j;
      };
      const login = async (id, password) => (await call(null, 'POST', '/login', { annotator_id: id, password })).token;
      const GUIDED = 'sub-example01/eeg/sub-example01_task-example_eeg.vhdr';
      // a set of its own with the example's first guided recording, for a trainee of its own (nothing else is touched)
      const refs = path.join(t.study.dir, 'study', 'derivatives', 'electrotag_reference_sets', 'example', 'references');
      const reference = JSON.parse(fs.readFileSync(path.join(refs, fs.readdirSync(refs).find((f) => f.includes('example01'))), 'utf8'));
      const admin = await login('ADMIN', 'electrotag');
      const op = (name, body) => call(admin, 'POST', `/admin/${name}`, body);
      await op('set_create', { set_id: 'correct-check', name: 'Correct the marks check' });
      await op('set_add_reference', { set_id: 'correct-check', recording_id: GUIDED, recording_scope: 'set:example', use: 'guided',
        source: { kind: 'document', document: reference } });
      const made = await call(admin, 'POST', '/expert/set_planted_make', { set_id: 'correct-check', recording_id: GUIDED, seed: 7 });
      assert.ok(made.planted.n_errors >= 3);
      await op('set_recording_update', { set_id: 'correct-check', recording_id: GUIDED, guidance: 'correct' });
      await op('user_add', { annotator_id: 'T06', display_name: 'Trainee six', password: 'trainee six' });
      await op('programme_set', { annotator_id: 'T06', set_id: 'correct-check' });

      const page = await t.newPage({ url: t.study.base, width: 1440, height: 900 });
      await signIn(page, 'T06', 'trainee six');
      await waitForRoute(page, 'training');
      await skipFirstStages(page);
      await page.click('main.training [data-log="training-continue"]');
      await waitForRoute(page, 'open');
      const folder = path.join(t.study.dir, 'recordings', 'training', 'sub-example01', 'eeg');
      await page.setInputFiles('input[data-log="file-input"]', fs.readdirSync(folder).filter((f) => /\.(vhdr|vmrk|eeg)$/.test(f)).map((f) => path.join(folder, f)));
      await waitForRoute(page, 'annotate', 30000);
      await page.waitForSelector('.planted-panel');
      await waitForTraces(page);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.size), made.planted.annotations.length);
      assert.match(await page.textContent('.planted-panel'), /Some of these marks are wrong/);
      assert.equal(await page.locator('.planted-panel [data-log="planted-check"]').count(), 0, 'a trainee saves to find out');
      await t.screenshot(page, 'planted_trainee');
      // the trainee puts the marks right (as one who knows the experts' would), and saves
      await page.evaluate((anns) => { const ws = globalThis.ElectroTag.ws; ws.store.reset([]); for (const a of anns) ws.store.add(a.label, a.onset_sample, a.duration_samples, a.channels || []); },
        reference.annotations.map((a) => ({ label: a.label, onset_sample: a.onset_sample, duration_samples: a.duration_samples, channels: a.channels })));
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog.planted-dialog', { timeout: 30000 });
      assert.match(await page.textContent('.dialog.planted-dialog'), new RegExp(`You fixed ${made.planted.n_errors} of ${made.planted.n_errors} planted mistakes`));
      await t.screenshot(page, 'planted_trainee_result');
      await clickDialogButton(page, 'Back to my training path');
      await waitForRoute(page, 'training', 30000);
      assert.match(await page.textContent('main.training'), /You fixed/);
      const prog = JSON.parse(fs.readFileSync(path.join(t.study.dir, 'study', 'Annotated_Events', 'training_progress', 'correct-check', 'annotator-T06.json'), 'utf8'));
      assert.equal(prog.guided[GUIDED].kind, 'correct');
      assert.equal(prog.guided[GUIDED].fixed, made.planted.n_errors);
    },
  },
];
