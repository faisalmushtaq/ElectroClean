// The demonstration starts, signs in and shows an example recording.
import { signIn, waitForRoute, openExample, state } from './helpers.mjs';

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
      await t.screenshot(page, 'home');
      await openExample(page, 0);
      const s = await state(page);
      t.assert.equal(s.backend, 'demo');
      t.assert.equal(s.route, 'annotate');
      await t.screenshot(page, 'annotate');
    },
  },
];
