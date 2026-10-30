// The artifact reference guide (docs/web/using.md, "The artifact reference guide"): its own page at
// #guide, without signing in, with every type, a search and Print, and live examples drawn as they come
// into view; beside the EEG as the annotation view's Guide tab, opened from the Help tab and from the
// type picker's About this type; and a link to it on the training path.
import { signIn, waitForRoute, openExample } from './helpers.mjs';

const N_TYPES = 29;

export const tests = [
  {
    name: 'the guide as its own page: every type, a search, examples drawn, and print',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ url: `${t.base}#guide` });
      await waitForRoute(page, 'guide');
      assert.equal(await page.textContent('main h1'), 'Artifact reference guide');
      assert.equal(await page.locator('.guide-type').count(), N_TYPES);
      assert.match(await page.textContent('.guide-count'), /29 types in 4 families/);
      const blink = page.locator('.guide-type[data-label="Eye-blink-artifact"]');
      assert.match(await blink.textContent(), /HED-SCORE: Artifact from eye blinking/);
      assert.match(await blink.textContent(), /Key 1/);
      assert.match(await blink.textContent(), /Telling it apart/);
      // the first example is drawn as it comes into view
      await page.waitForFunction(() => document.querySelectorAll('.guide-type[data-label="Eye-blink-artifact"] .guide-eeg canvas').length > 0, null, { timeout: 15000 });
      await t.screenshot(page, 'guide_page');
      for (const label of ['Pulse-artifact', 'Sweat-artifact', 'Nystagmus-artifact']) {
        await page.locator(`.guide-type[data-label="${label}"]`).scrollIntoViewIfNeeded();
        await page.waitForFunction((l) => document.querySelectorAll(`.guide-type[data-label="${l}"] .guide-eeg canvas`).length > 0, label);
        await page.waitForTimeout(300);
        await t.screenshot(page, `guide_${label.split('-')[0].toLowerCase()}`);
      }
      // a group term has no example, and says what it is for
      const group = page.locator('.guide-type[data-label="Eye-artifact"]');
      assert.equal(await group.locator('.guide-eeg').count(), 0);
      assert.match(await group.textContent(), /group term/);
      // search
      await page.fill('.guide-search', '50 Hz');
      assert.equal(await page.locator('.guide-type:not([hidden])[data-label="Line-noise-artifact"]').count(), 1);
      assert.ok(await page.locator('.guide-type:not([hidden])').count() < N_TYPES);
      await page.fill('.guide-search', 'nothing like this');
      assert.match(await page.textContent('.guide-count'), /No type matches/);
      await page.fill('.guide-search', '');
      // print: every example is drawn first, and the print page leaves out the tools
      await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
      await page.click('[data-log="guide-print"]');
      await page.waitForFunction(() => window.__printed === true);
      const drawn = await page.locator('.guide-eeg canvas.top').count();
      assert.equal(drawn, await page.locator('.guide-eeg').count());
      await page.emulateMedia({ media: 'print' });
      assert.equal(await page.locator('.guide-tools').isVisible(), false);
      await page.emulateMedia({ media: 'screen' });
    },
  },
  {
    name: 'beside the EEG: the Guide tab, from Help and from the type picker\'s About this type',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await page.click('.side-tabs [data-tab="help"]');
      assert.equal(await page.locator('[data-panel="help"] a[data-log="help-guide-tab"]').getAttribute('href'), './#guide');
      await page.click('[data-panel="help"] [data-log="help-guide"]');
      await page.waitForSelector('[data-panel="guide"] .guide-type');
      assert.equal(await page.locator('[data-panel="guide"]').isVisible(), true);
      assert.equal(await page.locator('[data-panel="guide"] .guide-type').count(), N_TYPES);
      await t.screenshot(page, 'guide_panel');
      // the type picker: / (Find a type), the highlighted type, About this type
      await page.click('.side-tabs [data-tab="annotations"]');
      await page.keyboard.press('/');
      await page.waitForSelector('.picker-dialog');
      await page.fill('.picker-dialog input[type="search"]', 'sweat');
      await t.screenshot(page, 'guide_picker_about');
      await page.click('.picker-dialog [data-log="type-about"]');
      await page.waitForSelector('.picker-dialog', { state: 'detached' });
      await page.waitForSelector('[data-panel="guide"] .guide-type.focused[data-label="Sweat-artifact"]');
      assert.match(await page.textContent('[data-panel="guide"] .guide-type.focused'), /Find a type \(\/\)/);
      await page.waitForFunction(() => document.querySelectorAll('[data-panel="guide"] .guide-type[data-label="Sweat-artifact"] .guide-eeg canvas').length > 0);
      // the recording is left as it was: nothing marked
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.size), 0);
    },
  },
  {
    name: 'the training path links to the guide, which opens in a new tab',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'T01');
      await waitForRoute(page, 'training');
      const link = page.locator('main.training a[data-log="training-guide"]');
      assert.equal(await link.getAttribute('href'), './#guide');
      assert.equal(await link.getAttribute('target'), '_blank');
      const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
      await tab.waitForFunction(() => globalThis.ElectroTag && globalThis.ElectroTag.route === 'guide', null, { timeout: 15000 });
      assert.equal(await tab.locator('.guide-type').count(), N_TYPES);
      await tab.close();
      // the training path is still there
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.route), 'training');
    },
  },
];
