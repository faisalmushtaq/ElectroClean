// The study team's screens after the usability check of the trainee path (October 2026), in the
// sandbox: snippet authoring says how long the recording and the snippet are and shows the stretch on
// the EEG as trainees will see it; Study settings groups the stages a trainee may skip under Trainees
// may skip and keeps the known-answer setting with the other choices about tasks; and the audit log's
// filter names every kind of change in words.
import { signIn, waitForRoute } from './helpers.mjs';

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

export const tests = [
  {
    name: 'demonstration: snippet authoring shows the times in words and the stretch on the EEG, at 1280 and 400 pixels',
    async run(t) {
      const { assert } = t;
      for (const [width, height] of [[1280, 720], [400, 860]]) {
        const page = await t.newPage({ width, height, url: `${t.base}#admin-training` });
        await signIn(page, 'ADMIN');
        await waitForRoute(page, 'admin-training');
        await page.click('.admin-tabs [data-tab="snippets"]');
        await page.waitForSelector('.admin-card:has-text("Add a snippet") form');
        const form = page.locator('.admin-card', { hasText: 'Add a snippet' });
        assert.match(await page.textContent('.snippet-span'), /^The recording is \d+:\d\d long \(\d+\.\d s\)\.$/);
        const inputs = form.locator('input.field');
        await inputs.nth(0).fill('9.2');
        await inputs.nth(1).fill('10.8');
        await inputs.nth(3).fill('F7, T7');
        assert.match(await page.textContent('.snippet-span'), /The snippet lasts 1\.60 s, from 9\.20 to 10\.80 s; trainees see 7\.20 to 12\.80 s of the recording \(5\.60 s\)\./);
        await page.waitForFunction(() => /open your copy of .* it is read here and never uploaded/.test(document.querySelector('.snippet-preview-status').textContent));
        await page.click('[data-log="snippet-preview-example"]');
        await page.waitForSelector('.admin-snippet-eeg:not([hidden]) canvas', { timeout: 20000 });
        await page.waitForFunction(() => /^As trainees see it: 5\.60 s from 7\.20 s of .*, the artifact outlined on F7, T7\.$/.test(document.querySelector('.snippet-preview-status').textContent));
        // the stretch follows the times
        await inputs.nth(1).fill('11.8');
        await page.waitForFunction(() => /^As trainees see it: 6\.60 s from 7\.20 s/.test(document.querySelector('.snippet-preview-status').textContent));
        const box = await page.locator('.admin-snippet-eeg').boundingBox();
        assert.ok(box.height >= 300, `the EEG is ${box.height} pixels high`);
        assert.ok(await noSideways(page), 'nothing runs off the side');
        await page.locator('.snippet-preview').scrollIntoViewIfNeeded();
        await t.screenshot(page, `admin_snippet_preview_${width}`);
        await page.close();
      }
    },
  },
  {
    name: 'demonstration: Trainees may skip groups the stages, and the audit filter names every kind of change in words',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900, url: `${t.base}#admin-settings` });
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin-settings');
      await page.waitForSelector('fieldset.skip-stages');
      assert.equal(await page.textContent('fieldset.skip-stages legend'), 'Trainees may skip');
      assert.equal(await page.locator('fieldset.skip-stages input[type="checkbox"]').count(), 4);
      const review = page.locator('.admin-card', { hasText: 'Corrections and adjudication' });
      const grids = review.locator('.form-grid');
      assert.match(await grids.first().innerText(), /Annotators per task[\s\S]*Known-answer recordings before accuracy counts/);
      assert.doesNotMatch(await grids.nth(1).innerText(), /Known-answer/, 'not among the rules for two marks being the same');
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-records'));
      await page.waitForSelector('.admin-section[data-section="records"] select');
      const kinds = await page.locator('.admin-section[data-section="records"] select').nth(1).locator('option').allInnerTexts();
      for (const k of ['Recordings shared out as tasks', 'Snippet added', 'Training reopened', 'Conflict decided', 'Correction saved']) {
        assert.ok(kinds.includes(k), `the filter offers ${k}`);
      }
      assert.ok(kinds.every((k) => !/_/.test(k)), 'every kind in words');
    },
  },
];
