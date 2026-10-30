// The demonstration starts, signs in and shows an example recording; an expert finds the expert area.
import { signIn, waitForRoute, openExample, state } from './helpers.mjs';

/** E01, an expert who also annotates: the home page's Expert work card opens the expert area, where the
 *  expert's own consent to teaching with their sessions is saved once (a second save changes nothing). */
async function expertFindsTheExpertArea(t, page) {
  await waitForRoute(page, 'home');
  const s = await state(page);
  t.assert.deepEqual(s.roles, ['expert', 'annotator']);
  const card = page.locator('.expert-card');
  await card.waitFor();
  t.assert.match(await card.textContent(), /Expert work/);
  await t.screenshot(page, 'expert-home');
  await card.locator('button[data-log="open-expert"]').click();
  await waitForRoute(page, 'expert');
  await page.waitForSelector('[data-view="expert"] input[data-log="replay-consent"]');
  t.assert.equal(await page.isChecked('input[data-log="replay-consent"]'), false);
  await page.check('input[data-log="replay-consent"]');
  await page.click('button[data-log="replay-consent-save"]');
  await page.waitForSelector('[data-view="expert"] .success');
  t.assert.match(await page.textContent('[data-view="expert"] .success'), /trainees may watch replays of your sessions/);
  await page.click('button[data-log="replay-consent-save"]');
  await page.waitForFunction(() => /Nothing has changed/.test(document.querySelector('[data-view="expert"] .success')?.textContent || ''));
  t.assert.equal((await state(page)).expert.section, 'overview');
  await t.screenshot(page, 'expert-area');
  // The header leads back to the expert's recordings, and the address opens the area again.
  await page.click('button[data-log="leave-expert"]');
  await waitForRoute(page, 'home');
  await page.evaluate(() => { location.hash = 'expert'; });
  await waitForRoute(page, 'expert');
  await page.waitForSelector('input[data-log="replay-consent"]:checked');
}

export const tests = [
  {
    name: 'sign in to the demonstration and open an example',
    async run(t) {
      const page = await t.newPage();
      await page.waitForSelector('form.signin-form');
      t.assert.match(await page.textContent('.signin-card'), /Demonstration/);
      await t.screenshot(page, 'signin');
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      t.assert.equal(await page.locator('.expert-card').count(), 0); // an annotator has no expert area
      await t.screenshot(page, 'home');
      await openExample(page, 0);
      const s = await state(page);
      t.assert.equal(s.backend, 'demo');
      t.assert.equal(s.route, 'annotate');
      await t.screenshot(page, 'annotate');
    },
  },
  {
    name: 'the demonstration\'s expert, E01, finds the expert area from the home page',
    async run(t) {
      const page = await t.newPage();
      await signIn(page, 'E01');
      await expertFindsTheExpertArea(t, page);
      // An annotator who asks for the expert area by its address is taken home.
      await page.click('button[data-log="sign-out"]');
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await page.evaluate(() => { location.hash = 'expert'; });
      await page.waitForTimeout(300);
      t.assert.equal((await state(page)).route, 'home');
    },
  },
  {
    name: 'on the study server, E01 finds the expert area from the home page',
    needs: 'study',
    async run(t) {
      const page = await t.newPage({ url: t.study.base });
      await signIn(page, 'E01', 'electrotag');
      await expertFindsTheExpertArea(t, page);
    },
  },
];
