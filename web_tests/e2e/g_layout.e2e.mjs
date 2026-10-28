// Layout: a laptop screen (1280 × 720) for every view, and a phone-sized window, where sign-in
// still works and the rest asks for a computer screen without scrolling sideways.
import { signIn, waitForRoute, waitForTraces, eegPoint, drag, clickDialogButton } from './helpers.mjs';

async function noSideways(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

export const tests = [
  {
    name: 'every view fits a 1280 × 720 screen',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 720 });
      await page.waitForSelector('form.signin-form');
      await t.screenshot(page, 'signin');
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      assert.ok(await noSideways(page));
      await t.screenshot(page, 'home');
      await page.click('[data-log="open-next"]');
      await waitForRoute(page, 'open');
      await t.screenshot(page, 'open');
      await page.locator('.example-card button').click();
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      // Everything in the toolbar is on screen (the type buttons show only their numbers if needed).
      const fits = await page.evaluate(() => {
        const tb = document.querySelector('.ws-toolbar');
        const hd = document.querySelector('.ws-header');
        return tb.scrollWidth <= tb.clientWidth + 1 && hd.scrollWidth <= hd.clientWidth + 1;
      });
      assert.ok(fits, 'the toolbar and header fit');
      const save = await page.locator('.ws-actions button.primary').boundingBox();
      assert.ok(save && save.x + save.width <= 1280, 'Save and Finish is on screen');
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
      await page.keyboard.press('3');
      await drag(page, await eegPoint(page, 9.2, 'F7'), await eegPoint(page, 9.9, 'F7'));
      await t.screenshot(page, 'annotate');
      await page.keyboard.press('/');
      await page.waitForSelector('.picker-dialog');
      await t.screenshot(page, 'picker');
      await page.keyboard.press('Escape');
      await page.click('.tab[data-tab="recording"]');
      await t.screenshot(page, 'recording_tab');
      await page.click('.tab[data-tab="help"]');
      await t.screenshot(page, 'help_tab');
      await page.click('[data-log="close"]');
      await clickDialogButton(page, 'Close and finish later');
      await waitForRoute(page, 'home');
      await page.click('[data-log="sign-out"]');
      // The trainee's views.
      await signIn(page, 'T01');
      await waitForRoute(page, 'training');
      assert.ok(await noSideways(page));
      await t.screenshot(page, 'training_path');
      await page.locator('main.training .btn.primary').click();
      await page.locator('.example-card button').click();
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      await page.waitForSelector('.coach-title');
      await t.screenshot(page, 'guided');
      const coach = await page.locator('.coach-buttons .btn.primary').boundingBox();
      assert.ok(coach && coach.y + coach.height <= 720, 'Continue is on screen');
    },
  },
  {
    name: 'a narrow window: sign-in works, then a calm notice',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 400, height: 800 });
      await page.waitForSelector('form.signin-form');
      assert.ok(await noSideways(page), 'no sideways scrolling on the sign-in view');
      await t.screenshot(page, 'signin_narrow');
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await page.waitForSelector('.small-screen', { state: 'visible' });
      assert.match(await page.textContent('.small-screen'), /ElectroClean needs a computer screen/);
      assert.ok(await noSideways(page));
      await t.screenshot(page, 'small_screen');
      // Widening the window brings the view back.
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForSelector('.small-screen', { state: 'hidden' });
      await page.waitForSelector('.next-card', { state: 'visible' });
    },
  },
];
