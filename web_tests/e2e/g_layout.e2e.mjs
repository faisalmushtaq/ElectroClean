// Layout: a laptop screen (1280 × 720) for every view, and a phone-sized window, where sign-in
// still works and the rest asks for a larger screen without scrolling sideways. The annotation view
// at the common laptop sizes and with the browser's zoom at 150% and 200%: the type buttons keep
// their codes, the line at the bottom gives a whole instruction, nothing is drawn over anything else,
// and a window made small by zooming in can carry on.
import { signIn, waitForRoute, waitForTraces, eegPoint, drag, clickDialogButton, openExample } from './helpers.mjs';

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
    name: 'the annotation view at 1280 × 720 to 1440 × 900 and zoomed to 150%: whole type buttons, a whole instruction, nothing drawn over anything else',
    async run(t) {
      const { assert } = t;
      const sizes = [{ width: 1280, height: 720 }, { width: 1366, height: 768 }, { width: 1440, height: 900 },
        { width: 960, height: 600, scale: 1.5 }, { width: 853, height: 533, scale: 1.5 }];
      for (const size of sizes) {
        const where = `${size.width} × ${size.height}${size.scale ? ' (zoomed to 150%)' : ''}`;
        const page = await t.newPage(size);
        await signIn(page, 'A01');
        await waitForRoute(page, 'home');
        await openExample(page, 0);
        // An instruction as long as the one after M: shown whole in the line at the bottom.
        await page.evaluate(() => globalThis.ElectroTag.ws.say('Start of Horizontal-eye-movement-artifact marked at 14.208 s. Point at the end (scroll if you need to) and press M again. Esc cancels.'));
        const r = await page.evaluate(() => {
          const box = (sel) => document.querySelector(sel).getBoundingClientRect();
          const tb = document.querySelector('.ws-toolbar');
          const left = document.querySelector('.ws-status-left');
          const chips = [...document.querySelectorAll('.chip-btn')];
          return {
            sideways: document.documentElement.scrollWidth > innerWidth + 1,
            toolbar: tb.scrollWidth <= tb.clientWidth + 1,
            codes: chips.map((c) => c.querySelector('.chip-code')).every((c) => c.offsetWidth > 0),
            names: chips.map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
            onScreen: chips.every((c) => c.getBoundingClientRect().right <= innerWidth),
            message: left.scrollHeight <= left.clientHeight + 1 && left.scrollWidth <= left.clientWidth + 1,
            status: box('.ws-status'), side: box('.ws-side'), eeg: box('.ws-eeg'), plot: box('.viewer-plot'),
            figures: [...document.querySelectorAll('.ws-status-right > *')].every((e) => e.scrollWidth <= e.clientWidth + 1),
          };
        });
        assert.equal(r.sideways, false, `${where}: nothing scrolls sideways`);
        assert.ok(r.toolbar && r.onScreen, `${where}: the toolbar fits, wrapping when it needs to`);
        assert.ok(r.codes, `${where}: every type button shows its code`);
        assert.equal(r.names[0], '1 Blink, Eye-blink-artifact', `${where}: a type button is named in full for screen readers`);
        assert.ok(r.message, `${where}: the instruction is shown to its end`);
        assert.ok(r.figures, `${where}: the figures at the bottom are shown in full`);
        assert.ok(r.status.top >= r.side.bottom - 1 && r.status.top >= r.eeg.bottom - 1, `${where}: the line at the bottom is drawn under the panel and the EEG`);
        assert.ok(r.plot.height >= 200, `${where}: room for the EEG (${r.plot.height})`);
        // The break reminder sits over the foot of the side panel, never over the EEG.
        const reminder = await page.evaluate(() => {
          const ws = globalThis.ElectroTag.ws;
          ws._showBreakReminder();
          const b = ws.breakEl.getBoundingClientRect();
          const p = document.querySelector('.viewer-plot').getBoundingClientRect();
          const side = document.querySelector('.ws-side').getBoundingClientRect();
          ws._hideBreakReminder(null);
          return { overEeg: b.left < p.right && b.right > p.left && b.top < p.bottom && b.bottom > p.top, inSide: b.left >= side.left - 1 && b.right <= side.right + 1 };
        });
        assert.ok(!reminder.overEeg && reminder.inSide, `${where}: the break reminder is over the side panel`);
        // A field with the focus has the 2-pixel ring of a focused button.
        await page.keyboard.press('g');
        assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineWidth), '2px', `${where}: the focus ring of a field`);
        await page.keyboard.press('Escape');
        if (size.width === 1440 || size.scale) await t.screenshot(page, 'annotate_size');
        await page.context().close();
      }
    },
  },
  {
    name: 'zoomed to 200% on a laptop: the notice says how to make room, and the view can be used in the small window',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 720, height: 450, scale: 2 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await page.waitForSelector('.small-screen', { state: 'visible' });
      assert.match(await page.textContent('.small-screen'), /zoom/);
      await t.screenshot(page, 'zoom_200_notice');
      await page.click('[data-log="continue-small-screen"]');
      await page.waitForSelector('.small-screen', { state: 'hidden' });
      await openExample(page, 0);
      const r = await page.evaluate(() => {
        const v = document.querySelector('.view.annotate');
        const status = document.querySelector('.ws-status').getBoundingClientRect();
        const side = document.querySelector('.ws-side').getBoundingClientRect();
        return { sideways: document.documentElement.scrollWidth > innerWidth + 1, scrolls: v.scrollHeight > v.clientHeight, apart: status.top >= side.bottom - 1 };
      });
      assert.equal(r.sideways, false);
      assert.ok(r.scrolls && r.apart, 'the view scrolls down to the panel and the line at the bottom, drawn one under the other');
      // The choice lasts for this tab: a reload keeps the views.
      await page.reload();
      await waitForRoute(page, 'home');
      assert.equal(await page.isVisible('.small-screen'), false);
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
      assert.match(await page.textContent('.small-screen'), /ElectroTag needs a larger screen/);
      assert.ok(await noSideways(page));
      await t.screenshot(page, 'small_screen');
      // Widening the window brings the view back.
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForSelector('.small-screen', { state: 'hidden' });
      await page.waitForSelector('.next-card', { state: 'visible' });
    },
  },
];
