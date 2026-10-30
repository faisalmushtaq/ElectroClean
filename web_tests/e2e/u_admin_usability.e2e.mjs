// The admin area after its usability review, in the demonstration: Help beside each section's
// heading, figures that open their section and fill their rows, Study settings that answer in the
// bar at the foot of the window and ask before unsaved changes are left, the starting channel
// colours, All in Assignments leaving out switched-off accounts and administrators, a recording set
// aside offered See the report rather than Unassign, a reassignment to someone who has it already
// refused, readable reviews, and no stray "null" after a table of results.
import { signIn, waitForRoute } from './helpers.mjs';

const DOCS = 'https://github.com/faisalmushtaq/ElectroTag/blob/main/docs/';

async function goSection(page, title, route) {
  await page.locator('.admin-nav a', { hasText: title }).click();
  await waitForRoute(page, route);
  await page.waitForFunction((r) => document.querySelector(`.admin-section[data-section="${r}"]`), route.replace(/^admin-?/, '') || 'overview');
}

/** True when the element is wholly inside the window. */
const inView = (page, sel) => page.evaluate((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0;
}, sel);

export const tests = [
  {
    name: 'demonstration: Help, figures that open their section, and Study settings that answer in sight and keep unsaved changes',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1400, height: 900, url: `${t.base}#admin` });
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin');
      await page.waitForSelector('.stat-tile');
      // Help: this section of the administrators' guide, in a new tab.
      const help = page.locator('.admin-section[data-section="overview"] a[data-help]');
      assert.equal(await help.getAttribute('href'), `${DOCS}web/admin.md#overview`);
      assert.equal(await help.getAttribute('target'), '_blank');
      // The figures fill their rows: no grey block behind an incomplete row, and each opens its section.
      const tiles = await page.evaluate(() => {
        const grid = document.querySelector('.stat-tiles');
        const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
        return { cols, n: grid.children.length, background: getComputedStyle(grid).backgroundColor };
      });
      assert.equal(tiles.n % tiles.cols, 0, `${tiles.n} figures in rows of ${tiles.cols}`);
      assert.match(tiles.background, /rgba\(0, 0, 0, 0\)|transparent/);
      await t.screenshot(page, 'usability_overview');
      // The first Tab stop skips to the section.
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Skip to the section');
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.matches('.admin-section[data-section="overview"] h1')), true);
      await page.click('a.stat-tile[data-to="problems"]');
      await waitForRoute(page, 'admin-problems');
      assert.equal(await page.getAttribute('.admin-section[data-section="problems"] a[data-help]', 'href'), `${DOCS}web/admin.md#problems`);

      // Study settings: a mistake halfway down the page is answered beside Save, with its field focused.
      await goSection(page, 'Study settings', 'admin-settings');
      const sel = '.admin-section[data-section="settings"]';
      await page.waitForSelector(`${sel} input[name="break_reminder_minutes"]`);
      await page.fill(`${sel} input[name="break_reminder_minutes"]`, '-5');
      assert.equal(await page.isVisible(`${sel} .unsaved-note`), true);
      await page.evaluate(() => window.scrollTo(0, 900));
      await page.click('[data-log="settings-save"]');
      await page.waitForSelector(`${sel} .sticky-save .error-banner`);
      assert.match(await page.innerText(`${sel} .sticky-save .error-banner`), /Break reminder after: enter a number between 0 and 240/);
      assert.ok(await inView(page, `${sel} .sticky-save .error-banner`), 'the message is in sight');
      assert.equal(await page.evaluate(() => document.activeElement.name), 'break_reminder_minutes');
      assert.equal(await page.getAttribute(`${sel} input[name="break_reminder_minutes"]`, 'aria-invalid'), 'true');
      await t.screenshot(page, 'usability_settings_invalid');
      // Leaving with unsaved changes asks first; Stay keeps them.
      await page.locator('.admin-nav a', { hasText: 'Overview' }).click();
      await page.waitForSelector(`${sel} .sticky-save .confirm-strip`);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.route), 'admin-settings');
      assert.match(await page.innerText(`${sel} .sticky-save .confirm-strip`), /changes that are not saved/);
      await page.click(`${sel} .sticky-save .confirm-strip button:has-text("Stay here")`);
      assert.equal(await page.inputValue(`${sel} input[name="break_reminder_minutes"]`), '-5');
      // Corrected, with the starting channel colours, and saved: the answer is in the bar too.
      await page.fill(`${sel} input[name="break_reminder_minutes"]`, '45');
      await page.locator(`${sel} .admin-field`, { hasText: 'Channel colours at first' }).locator('select').selectOption('side');
      await page.click('[data-log="settings-save"]');
      await page.waitForSelector(`${sel} .sticky-save .success`);
      assert.equal(await page.isVisible(`${sel} .unsaved-note`), false);
      const st = await page.evaluate(() => globalThis.ElectroTag.backend.admin('settings_get', {}));
      assert.deepEqual([st.settings.display.channel_colours, st.settings.annotation.break_reminder_minutes], ['side', 45]);
      await goSection(page, 'Overview', 'admin');
      // Records: the change in words.
      await goSection(page, 'Records', 'admin-records');
      await page.waitForFunction(() => /channel colours \(display\) from off to side/.test(document.querySelector('.admin-section[data-section="records"]').innerText));
    },
  },
  {
    name: 'demonstration: All leaves out switched-off accounts and administrators; a recording set aside is settled in Problems',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1400, height: 900, url: `${t.base}#admin` });
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin');
      // A01 sets a recording aside as one that cannot be annotated; A06 has it already, A07 does not.
      const rid = await page.evaluate(async () => {
        const b = globalThis.ElectroTag.backend;
        await b.admin('user_add', { annotator_id: 'A06', password: 'long enough' });
        await b.admin('user_add', { annotator_id: 'A07', password: 'long enough' });
        await b.admin('user_add', { annotator_id: 'B03', password: 'long enough' });
        await b.admin('user_update', { annotator_id: 'B03', status: 'disabled' });
        const items = (await b.admin('assignments_list', { annotator_id: 'A01' })).items;
        const r = items[0].recording_id;
        await b.admin('assign', { annotator_ids: ['A06'], recording_ids: [r] });
        await b.logout();
        await b.login('A01', 'demo');
        await b.reportProblem({ problem_id: '1'.padStart(32, '0'), recording_id: r, mode: 'standard', context_id: '', reason: 'bad_channels', note: 'Flat', outcome: 'unusable', where: 'home' });
        await b.logout();
        await b.login('ADMIN', 'demo');
        return r;
      });
      await page.reload();
      await waitForRoute(page, 'admin');
      await goSection(page, 'Assignments', 'admin-assignments');
      const sel = '.admin-section[data-section="assignments"]';
      await page.waitForSelector(`${sel} input[data-name="annotators"]`);
      await page.locator(`${sel} fieldset:has(legend:text-is("Annotators")) button`, { hasText: 'All' }).click();
      const ticked = await page.$$eval(`${sel} input[data-name="annotators"]:checked`, (els) => els.map((e) => e.value));
      assert.ok(ticked.includes('A01') && ticked.includes('A07'), ticked.join(' '));
      assert.equal(ticked.includes('ADMIN') || ticked.includes('B03'), false, ticked.join(' '));
      // The set-aside recording has See the report instead of Unassign.
      await page.selectOption(`${sel} .filters select >> nth=0`, 'A01');
      const row = page.locator(`${sel} tbody tr`, { hasText: 'Cannot be annotated' });
      assert.equal(await row.locator('button', { hasText: 'Unassign' }).count(), 0);
      await row.locator('[data-log="set-aside-problems"]').click();
      await waitForRoute(page, 'admin-problems');
      await page.click('[data-log="problem-open"]');
      const detail = '.admin-section[data-section="problems"] .admin-stack .admin-card';
      await page.waitForFunction((s) => document.querySelector(`${s} option[value="A06"]`), detail);
      assert.equal(await page.getAttribute(`${detail} option[value="A06"]`, 'disabled'), '');
      assert.match(await page.textContent(`${detail} option[value="A06"]`), /has it already/);
      assert.match(await page.innerText(detail), /when the recording was (to do|in progress)\./);
      await page.selectOption(`${detail} select`, 'A07');
      await page.click('[data-log="problem-reassign"]');
      await page.waitForSelector('.admin-section[data-section="problems"] > .admin-msg .success');
      await page.selectOption('.admin-section[data-section="problems"] .problem-filters select >> nth=0', 'resolved');
      assert.match(await page.innerText('.admin-section[data-section="problems"] tbody'), /Given to A07/);
      await t.screenshot(page, 'usability_problems');
      assert.ok(rid);
    },
  },
  {
    name: 'demonstration: the Accounts list has the page\'s width, Last seen on one line, and no stray "null" after a table of results',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1400, height: 900, url: `${t.base}#admin-annotators` });
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin-annotators');
      const sel = '[data-panel="accounts"]';
      await page.waitForSelector(`${sel} tbody tr`);
      const widths = await page.evaluate((s) => [document.querySelector(`${s} .admin-card`).getBoundingClientRect().width, document.querySelector('.admin-section[data-section="annotators"]').getBoundingClientRect().width], sel);
      assert.ok(widths[0] >= widths[1] - 2, `the list is ${widths[0]} of ${widths[1]} pixels`);
      const lines = await page.evaluate((s) => {
        const td = document.querySelector(`${s} tbody td.when`);
        return Math.round(td.getBoundingClientRect().height / parseFloat(getComputedStyle(td).lineHeight));
      }, sel);
      assert.ok(lines <= 2, `Last seen takes ${lines} lines`);
      // Two passwords made one after the other: both stay on the page.
      const form = page.locator(`${sel} form.admin-form`);
      for (const id of ['N01', 'N02']) {
        await form.locator('input').nth(0).fill(id);
        await page.click('[data-log="user-add"]');
        await page.waitForSelector(`${sel} [data-made="${id}"] .secret-value`);
      }
      assert.equal(await page.locator(`${sel} .made-one .secret-value`).count(), 2);
      // An Expert ticked for one person never carries over to the next: after the add, the roles are Annotator again.
      await form.locator('input').nth(0).fill('N03');
      await form.locator('input[data-role="expert"]').check();
      await page.click('[data-log="user-add"]');
      await page.waitForSelector(`${sel} [data-made="N03"] .secret-value`);
      const ticked = await form.locator('input[data-role]').evaluateAll((els) => els.filter((e) => e.checked).map((e) => e.dataset.role));
      assert.deepEqual(ticked, ['annotator'], `ticked after adding N03: ${ticked}`);
      assert.equal(await form.locator('input').nth(0).inputValue(), '');
      // The invitation link is not offered for an administrator.
      await form.locator('input[data-role="admin"]').check();
      assert.equal(await form.locator('select').first().locator('option[value="invite"]').getAttribute('disabled'), '');
      assert.match(await form.innerText(), /Administrators are given a password rather than an invitation link/);
      // Switch on for people already on: nothing changed, and no "null" written after the table.
      await page.check(`${sel} input[data-select="N01"]`);
      assert.ok(await inView(page, `${sel} .bulk-bar`), 'the bar of actions is in sight');
      await page.click('[data-log="bulk-switch-on"]');
      await page.waitForSelector(`${sel} .bulk-result h3`);
      assert.match(await page.innerText(`${sel} .bulk-result`), /Switched on already: nothing changed/);
      assert.doesNotMatch(await page.innerText(`${sel} .bulk-result`), /\bnull\b/);
      await t.screenshot(page, 'usability_accounts');
    },
  },
];
