// The structure that screen readers navigate by, on every page of the demonstration: one main
// landmark, all text inside a landmark (or an open dialog), a heading for every table column
// (columns of buttons have one that only screen readers read), and a scrolling list that the
// keyboard can reach. These are the rules an automated accessibility audit (axe-core) checked when
// the pages were last reviewed; the test keeps them true without that tool.
import { signIn, waitForRoute, openExample } from './helpers.mjs';

const LANDMARKS = 'main, [role="main"], header, footer, nav, aside, [role="navigation"], [role="complementary"], '
  + '[role="region"][aria-label], [role="dialog"], dialog, [role="alertdialog"]';

async function structure(page) {
  return page.evaluate((landmarks) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const mains = [...document.querySelectorAll('main, [role="main"]')].filter(visible).length;
    const outside = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || !visible(el) || el.closest('script, style')) continue;
      if (!el.closest(landmarks)) outside.push(`${el.tagName.toLowerCase()}.${el.className}: ${n.textContent.trim().slice(0, 40)}`);
    }
    const emptyHeadings = [...document.querySelectorAll('thead th')].filter((th) => visible(th.closest('table'))
      && !th.textContent.trim() && !th.querySelector('input, [aria-label]')).length;
    return { mains, outside: outside.slice(0, 5), emptyHeadings };
  }, LANDMARKS);
}

function check(t, s, where) {
  t.assert.equal(s.mains, 1, `${where}: one main landmark`);
  t.assert.deepEqual(s.outside, [], `${where}: text outside the landmarks`);
  t.assert.equal(s.emptyHeadings, 0, `${where}: a table column without a heading`);
}

export const tests = [
  {
    name: 'every page has one main landmark, text inside landmarks and a heading for every column',
    async run(t) {
      const page = await t.newPage({ width: 1440, height: 900 });
      await page.waitForSelector('form.signin-form');
      check(t, await structure(page), 'sign-in');
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      check(t, await structure(page), 'home');
      await openExample(page, 0);
      check(t, await structure(page), 'annotation view');
      await page.keyboard.press('/');
      await page.waitForSelector('.picker-list');
      t.assert.equal(await page.getAttribute('.picker-list', 'tabindex'), '0', 'the type list can take the keyboard focus');
      await page.keyboard.press('Escape');

      const admin = await t.newPage({ width: 1440, height: 900 });
      await admin.waitForSelector('form.signin-form');
      await signIn(admin, 'ADMIN');
      await waitForRoute(admin, 'admin');
      await admin.waitForSelector('.stat-tile');
      check(t, await structure(admin), 'admin overview');
      const sections = await admin.$$eval('.admin-nav a[data-section]', (as) => as.map((a) => a.dataset.section));
      t.assert.ok(sections.length >= 8, 'the admin menu lists its sections');
      for (const section of sections) {
        await admin.click(`.admin-nav a[data-section="${section}"]`);
        await admin.waitForSelector(`.admin-section[data-section="${section}"]`);
        await admin.waitForTimeout(300);
        check(t, await structure(admin), `admin ${section}`);
      }
    },
  },
];
