// The admin area's menu in groups, Find, private invitation links, adding several people at once,
// the Progress section and actions on many recordings and people, in the demonstration and on the
// real study server (`electrotag-web demo`, started by run_e2e.mjs for the tests marked
// needs: 'study'). An invitation is followed end to end: the administrator makes the link, the
// person opens it in another browser, chooses a password and lands on their recordings.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { answerQuestionnaire, signIn, waitForRoute } from './helpers.mjs';

const PASSWORD = 'electrotag';

async function goSection(page, title, route) {
  await page.locator('.admin-nav a', { hasText: title }).click();
  await waitForRoute(page, route);
  await page.waitForFunction((r) => document.querySelector(`.admin-section[data-section="${r}"]`), route.replace(/^admin-?/, '') || 'overview');
}

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** The welcome card of an invitation link: the password twice, then the person's recordings. */
async function acceptInvite(page, { id, study, password }) {
  await page.waitForSelector('.invite-card[data-invite="welcome"]', { timeout: 20000 });
  const card = (await page.innerText('.invite-card')).replace(/\s+/g, ' ');
  if (!card.includes(id)) throw new Error(`the welcome card does not name ${id}: ${card}`);
  if (study && !card.includes(study)) throw new Error(`the welcome card does not name the study ${study}: ${card}`);
  // In the address the token is gone at once (out of the history and bookmarks).
  if (/invite=/.test(page.url())) throw new Error(`the token stayed in the address: ${page.url()}`);
  await page.fill('#invite-password', password);
  await page.fill('#invite-password-again', `${password}x`);
  await page.click('.invite-form button[type="submit"]');
  await page.waitForSelector('.invite-form .error:not([hidden])');
  if (!/not the same/.test(await page.innerText('.invite-form .error'))) throw new Error('two different passwords were accepted');
  await page.fill('#invite-password-again', password);
  await page.click('.invite-form button[type="submit"]');
  await page.waitForFunction(() => Boolean(document.querySelector('.dialog.logging-notice'))
    || (globalThis.ElectroTag && globalThis.ElectroTag.route !== 'signin'), null, { timeout: 30000 });
  const notice = page.locator('.dialog.logging-notice button', { hasText: 'Continue' });
  if (await notice.count()) await notice.click();
  // a person who has just chosen their password answers the sign-up questionnaire before anything else
  await waitForRoute(page, 'questionnaire', 30000);
  await answerQuestionnaire(page);
  await waitForRoute(page, 'home');
}

/** "Add several" in the Annotators section: check the lines, create them, and read the private links. */
async function addSeveral(page, lines) {
  await page.click('.admin-section[data-section="annotators"] .admin-tabs [data-tab="several"]');
  await page.fill('[data-log="several-text"]', lines);
  await page.click('[data-log="several-check"]');
  await page.waitForSelector('[data-log="several-create"]:not([hidden])');
  await page.click('[data-log="several-create"]');
  await page.waitForSelector('.links-made output.link-value', { timeout: 30000 });
  return page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.links-made tr[data-key]')]
    .map((tr) => [tr.dataset.key, tr.querySelector('output.link-value').textContent.trim()])));
}

export const tests = [
  {
    name: 'demonstration: the menu in groups, Find, the Progress section and actions on many recordings',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 800, url: `${t.base}#admin` });
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin');
      assert.deepEqual(await page.$$eval('.admin-group-toggle', (els) => els.map((e) => e.textContent.trim())), ['Study', 'People', 'Data', 'Settings']);
      // A group folds away from the keyboard and stays folded for this administrator.
      await page.focus('.admin-group-toggle[data-group="people"]');
      await page.keyboard.press('Enter');
      assert.equal(await page.getAttribute('.admin-group-toggle[data-group="people"]', 'aria-expanded'), 'false');
      assert.equal(await page.isVisible('.admin-nav a[data-section="assignments"]'), false);
      await page.reload();
      await page.waitForSelector('.admin-group-toggle[data-group="people"]');
      assert.equal(await page.getAttribute('.admin-group-toggle[data-group="people"]', 'aria-expanded'), 'false');
      // Find jumps to a person, through a folded group: the section shown stays in the menu.
      await page.fill('.admin-find-input', 'a01');
      await page.waitForSelector('.admin-find-item');
      await page.keyboard.press('Enter');
      await waitForRoute(page, 'admin-annotators');
      await page.waitForSelector('.admin-section[data-section="annotators"] h2.person-title');
      assert.match(await page.innerText('h2.person-title'), /A01/);
      assert.equal(await page.isVisible('.admin-nav a[data-section="annotators"]'), true);
      assert.equal(await page.isVisible('.admin-nav a[data-section="assignments"]'), false);
      await page.click('.admin-group-toggle[data-group="people"]');
      assert.equal(await page.isVisible('.admin-nav a[data-section="assignments"]'), true);
      await page.goBack();
      await waitForRoute(page, 'admin');

      // Progress: the study's figures, the chart, and a table of people that sorts and downloads.
      await goSection(page, 'Progress', 'admin-progress');
      await page.waitForSelector('.admin-section[data-section="progress"] .stat-tile');
      const text = (await page.innerText('.admin-section[data-section="progress"]')).replace(/\s+/g, ' ');
      assert.match(text, /0 Done of 3 assigned/);
      assert.match(text, /Not enough work yet/);
      assert.match(text, /open in the annotator's browser and not paused/);
      await page.waitForSelector('.admin-section[data-section="progress"] svg.chart-svg');
      assert.equal(await page.locator('svg.chart-svg text.chart-tick').count() >= 4, true);
      await t.screenshot(page, 'admin_progress');
      await page.click('.admin-section[data-section="progress"] [data-tab="people"]');
      await page.click('.admin-section[data-section="progress"] [data-panel="people"] .th-sort:has-text("Assigned")');
      await page.click('.admin-section[data-section="progress"] [data-panel="people"] .th-sort:has-text("Assigned")');
      assert.equal(await page.getAttribute('.admin-section[data-section="progress"] [data-panel="people"] th[aria-sort="descending"] .th-sort', 'data-col'), '1');
      const first = await page.getAttribute('.admin-section[data-section="progress"] [data-panel="people"] tbody tr', 'data-key');
      assert.equal(first, 'A01', 'the most assigned first');
      const [csv] = await Promise.all([page.waitForEvent('download'), page.click('[data-log="progress-people-csv"]')]);
      assert.equal(csv.suggestedFilename(), 'progress_annotators.csv');
      assert.match(fs.readFileSync(await csv.path(), 'utf8'), /^annotator_id,display_name,role,status,assigned,done/);
      await t.screenshot(page, 'admin_progress_people');
      // A person's name opens their page, with their work recording by recording.
      await page.click('[data-person="A01"]');
      await waitForRoute(page, 'admin-annotators');
      await page.waitForSelector('.admin-card:has(h2:text-is("Work")) tbody tr');
      assert.match(await page.innerText('.admin-card:has(h2:text-is("Work"))'), /not paused/);

      // Recordings: choose all, retire them, bring them back; removing keeps those with results.
      await goSection(page, 'Recordings', 'admin-recordings');
      const sel = '.admin-section[data-section="recordings"]';
      await page.waitForSelector(`${sel} tbody tr`);
      await page.selectOption(`${sel} .filters select >> nth=0`, 'study');
      await page.check(`${sel} input[data-select-all]`);
      await page.waitForSelector(`${sel} .bulk-bar:not([hidden])`);
      assert.match(await page.innerText(`${sel} .bulk-bar`), /3 recordings chosen/);
      await page.click(`${sel} [data-log="bulk-retire"]`);
      await page.waitForSelector(`${sel} .bulk-result h3`);
      assert.match(await page.innerText(`${sel} .bulk-result`), /Done for 3 of 3 recordings/);
      assert.equal(await page.locator(`${sel} tbody .chip:has-text("Retired")`).count(), 3);
      await page.check(`${sel} input[data-select-all]`);
      await page.click(`${sel} [data-log="bulk-unretire"]`);
      await page.waitForFunction((s) => document.querySelectorAll(`${s} tbody .chip`).length && ![...document.querySelectorAll(`${s} tbody .chip`)].some((c) => c.textContent === 'Retired'), sel);
      await page.check(`${sel} input[data-select-all]`);
      await page.click(`${sel} [data-log="bulk-remove"]`);
      assert.match(await page.innerText(`${sel} .confirm-strip`), /EEG files never reached the study/);
      await page.click(`${sel} .confirm-strip button:has-text("Remove 3 registrations")`);
      await page.waitForSelector(`${sel} .bulk-result [data-log="bulk-retire-kept"]`);
      assert.match(await page.innerText(`${sel} .bulk-result`), /3 recordings kept.*research results are never deleted/s);
      await t.screenshot(page, 'admin_bulk_recordings');
      await page.click(`${sel} [data-log="bulk-retire-kept"]`);
      await page.waitForFunction((s) => [...document.querySelectorAll(`${s} tbody .chip`)].filter((c) => c.textContent === 'Retired').length === 3, sel);
      // Assign to… takes the recordings chosen to the Assignments section.
      await page.check(`${sel} input[data-select-all]`);
      await page.click(`${sel} [data-log="bulk-assign-to"]`);
      await waitForRoute(page, 'admin-assignments');
      await page.waitForFunction(() => document.querySelectorAll('.admin-section[data-section="assignments"] input[data-name="recordings"]:checked').length === 3);
    },
  },
  {
    name: 'demonstration: people added several at once get private links; one opens in another tab, chooses a password and lands on home',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 800, url: `${t.base}#admin-annotators` });
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin-annotators');
      await page.waitForSelector('.admin-section[data-section="annotators"] tbody tr');
      // Every line is checked before anything is made.
      await page.click('.admin-section[data-section="annotators"] .admin-tabs [data-tab="several"]');
      await page.fill('[data-log="several-text"]', 'L11, Lee One, lee@example.org\nA01, Taken\nL12, Lee Two');
      await page.click('[data-log="several-check"]');
      await page.waitForSelector('[data-panel="several"] .error-banner');
      assert.match(await page.innerText('[data-panel="several"] .error-banner'), /Line 2: A01 already has an account/);
      assert.equal(await page.isVisible('[data-log="several-create"]'), false);
      const links = await addSeveral(page, 'L11, Lee One, lee@example.org\nL12, Lee Two');
      assert.deepEqual(Object.keys(links).sort(), ['L11', 'L12']);
      assert.match(links.L11, /\?invite=[A-Za-z0-9_-]{43}$/);
      assert.equal(await page.locator('.links-made button[data-copy]', { hasText: 'Copy all' }).count(), 1);
      const [csv] = await Promise.all([page.waitForEvent('download'), page.click('[data-log="links-csv"]')]);
      const table = fs.readFileSync(await csv.path(), 'utf8');
      assert.match(table, /^annotator_id,display_name,email,link,expires_at\r\nL11,Lee One,lee@example\.org,http/);
      // Email the link: a short message to edit, in a mailto: address.
      await page.click('.links-made [data-mail="L11"]');
      await page.waitForSelector('a[data-log="mail-open"]');
      const href = await page.getAttribute('a[data-log="mail-open"]', 'href');
      assert.match(href, /^mailto:lee@example\.org\?subject=/);
      assert.ok(decodeURIComponent(href).includes(links.L11));
      await t.screenshot(page, 'admin_add_several');
      // The Invitations tab: where each link stands.
      await page.click('.admin-section[data-section="annotators"] .admin-tabs [data-tab="invitations"]');
      const row = page.locator('[data-panel="invitations"] tr[data-key="L12"]');
      assert.match(await row.innerText(), /Invited on .*expires on/);
      await row.locator('[data-revoke="L12"]').click();
      await row.locator('.confirm-strip button', { hasText: 'Withdraw it' }).click();
      await page.waitForFunction(() => /Withdrawn/.test(document.querySelector('[data-panel="invitations"] tr[data-key="L12"]')?.innerText || ''));
      await t.screenshot(page, 'admin_invitations');

      // The person opens their link (the demonstration keeps its study in this browser: another tab).
      const other = await page.context().newPage();
      await other.goto(links.L11);
      await acceptInvite(other, { id: 'L11', study: 'Demonstration', password: 'lee chooses this' });
      // Used once.
      const again = await page.context().newPage();
      await again.goto(links.L11);
      await again.waitForSelector('.invite-card[data-invite="problem"]');
      assert.match(await again.innerText('.invite-card'), /used already/);
      // The withdrawn link says so.
      await again.goto(links.L12);
      await again.waitForSelector('.invite-card[data-invite="problem"]');
      assert.match(await again.innerText('.invite-card'), /not known to the study/);
      await again.click('.invite-card button:has-text("Go to sign in")');
      await again.waitForSelector('form.signin-form');
      // The administrator sees the link accepted.
      await page.reload();
      await page.waitForSelector('.admin-section[data-section="annotators"] tr[data-key="L11"]');
      assert.match(await page.innerText('[data-panel="accounts"] tr[data-key="L11"]'), /Accepted/);
      // Several people: switched off, then on again, with what happened to each.
      await page.check('[data-panel="accounts"] input[data-select="L11"]');
      await page.check('[data-panel="accounts"] input[data-select="L12"]');
      await page.click('[data-log="bulk-switch-off"]');
      // Switching off signs people out at once, so it asks first.
      assert.match(await page.innerText('[data-panel="accounts"] .bulk-bar .confirm-strip'), /Switch off 2 accounts\? They are signed out at once/);
      await page.click('[data-panel="accounts"] .bulk-bar .confirm-strip button:has-text("Switch off")');
      await page.waitForSelector('[data-panel="accounts"] .bulk-result h3');
      assert.match(await page.innerText('[data-panel="accounts"] .bulk-result'), /Done for 2 of 2 people/);
      assert.equal(await page.locator('[data-panel="accounts"] tbody .chip:has-text("Switched off")').count(), 2);
      await page.check('[data-panel="accounts"] input[data-select="L11"]');
      await page.check('[data-panel="accounts"] input[data-select="L12"]');
      await page.click('[data-log="bulk-switch-on"]');
      await page.waitForFunction(() => !document.querySelector('[data-panel="accounts"] tbody .chip.warning'));
      // New links for several people at once.
      await page.check('[data-panel="accounts"] input[data-select="L12"]');
      await page.click('[data-log="bulk-invite"]');
      await page.waitForSelector('[data-panel="accounts"] .links-made output.link-value');
    },
  },
  {
    name: 'the new parts of the admin area in a window 400 pixels wide and on an iPad',
    async run(t) {
      const { assert } = t;
      for (const [opts, tag] of [[{ width: 400, height: 800 }, 'narrow'], [{ width: 1024, height: 768, ipad: true }, 'ipad']]) {
        const page = await t.newPage({ ...opts, url: `${t.base}#admin-progress` });
        await signIn(page, 'ADMIN');
        await waitForRoute(page, 'admin-progress');
        await page.waitForSelector('.admin-section[data-section="progress"] .stat-tile');
        assert.ok(await noSideways(page), `Progress scrolls sideways (${tag})`);
        await t.screenshot(page, `admin_${tag}_progress`);
        for (const tab of ['people', 'recordings']) {
          await page.click(`.admin-section[data-section="progress"] [data-tab="${tab}"]`);
          assert.ok(await noSideways(page), `Progress, ${tab}, scrolls sideways (${tag})`);
        }
        await goSection(page, 'Annotators', 'admin-annotators');
        for (const tab of ['accounts', 'invitations', 'several']) {
          await page.click(`.admin-section[data-section="annotators"] [data-tab="${tab}"]`);
          assert.ok(await noSideways(page), `Annotators, ${tab}, scrolls sideways (${tag})`);
        }
        await page.click('.admin-section[data-section="annotators"] [data-tab="accounts"]');
        await page.check('[data-panel="accounts"] input[data-select="A01"]');
        assert.ok(await noSideways(page), `the bar of actions scrolls sideways (${tag})`);
        await t.screenshot(page, `admin_${tag}_annotators`);
        if (opts.ipad) {
          // Fingers: the menu's headings and Find are large enough to tap.
          const box = await page.locator('.admin-group-toggle').first().boundingBox();
          assert.ok(box.height >= 40, `the group heading is ${box.height} pixels high`);
          const find = await page.locator('.admin-find-input').boundingBox();
          assert.ok(find.height >= 40, `Find is ${find.height} pixels high`);
        }
      }
    },
  },
  // ------------------------------------------------------------- the study server
  {
    name: 'study server: a private link made by the administrator, opened in another browser, signs the person in',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ url: `${t.study.base}#admin-annotators`, width: 1280, height: 800 });
      await signIn(page, 'ADMIN', PASSWORD);
      await waitForRoute(page, 'admin-annotators');
      await page.waitForSelector('.admin-section[data-section="annotators"] tr[data-key="A01"]');
      // One person, added with an invitation link.
      const form = page.locator('[data-panel="accounts"] form.admin-form');
      await form.locator('input').nth(0).fill('L31');
      await form.locator('input').nth(1).fill('Lane');
      await form.locator('select').first().selectOption('invite'); // First sign-in (the roles are boxes)
      await page.click('[data-log="user-add"]');
      await page.waitForSelector('[data-panel="accounts"] .secret-value');
      const link = (await page.textContent('[data-panel="accounts"] .secret-value')).trim();
      assert.ok(link.startsWith(t.study.base), link);
      assert.match(link, /\?invite=[A-Za-z0-9_-]{43}$/, 'the page is served by the study server: no ?server=');
      const person = await t.newPage({ url: link });
      await acceptInvite(person, { id: 'L31', password: 'lane chooses this' });
      await t.screenshot(person, 'admin_invite_home');
      // Several people, with a table of links; the second one welcomes its person.
      const links = await addSeveral(page, 'L32, Lou\nL33, Lin, lin@example.org');
      const welcome = await t.newPage({ url: links.L33, width: 1280, height: 800 });
      await welcome.waitForSelector('.invite-card[data-invite="welcome"]');
      await t.screenshot(welcome, 'admin_invite_welcome');
      // A new link replaces the old one.
      await page.click('.admin-section[data-section="annotators"] .admin-tabs [data-tab="invitations"]');
      const row = page.locator('[data-panel="invitations"] tr[data-key="L32"]');
      await row.locator('[data-invite="L32"]').click();
      await row.locator('.confirm-strip button', { hasText: 'Make a new link' }).click();
      await page.waitForSelector('[data-panel="invitations"] .success');
      const stale = await t.newPage({ url: links.L32 });
      await stale.waitForSelector('.invite-card[data-invite="problem"]');
      assert.match(await stale.innerText('.invite-card'), /not known to the study/);
      assert.equal(stale.url().includes('invite='), false);
      // The audit log has every change and never a token.
      await goSection(page, 'Records', 'admin-records');
      await page.waitForFunction(() => /Made an invitation link for L32/.test(document.querySelector('.admin-section[data-section="records"]')?.innerText || ''), null, { timeout: 20000 });
      const audit = await page.innerText('.admin-section[data-section="records"]');
      for (const l of Object.values(links)) assert.ok(!audit.includes(l.split('invite=')[1]));
    },
  },
  {
    name: 'study server: Progress counts saved work, and removing recordings keeps those with results',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const api = async (method, p, body, token) => {
        const headers = { 'X-ElectroTag': '1', 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(`${t.study.base}api/v1${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, json: await res.json() };
      };
      // A02 saves one recording through the API, as the browser does, after 30 minutes' work.
      const token = (await api('POST', '/login', { annotator_id: 'A02', password: PASSWORD })).json.token;
      const name = 'sub-003_task-rest_eeg.edf';
      let file = null;
      (function walk(d) {
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f);
          if (fs.statSync(p).isDirectory()) walk(p); else if (f === name) file = p;
        }
      })(path.join(t.study.dir, 'recordings'));
      const bytes = fs.readFileSync(file);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const m = (await api('POST', '/match', { file_name: name, size_bytes: bytes.length, format: 'edf', sha256 }, token)).json;
      if (m.status !== 'done') {
        assert.equal(m.status, 'matched', JSON.stringify(m));
        const stamp = new Date().toISOString();
        const annotations = [1, 2].map((i) => ({ annotation_id: `l${i}`.padEnd(32, '0'), label: 'Eye-blink-artifact', onset_sample: 100 * i,
          duration_samples: 50, channels: [], created_at: stamp, modified_at: stamp }));
        const r = await api('POST', '/submissions', { recording_id: m.recording_id, mode: m.mode, context_id: m.context_id, annotations,
          session: { started_at: stamp, elapsed_s: 1800 }, sha256 }, token);
        assert.ok(r.status === 200 || r.json.error === 'already_done', JSON.stringify(r.json));
      }
      const page = await t.newPage({ url: `${t.study.base}#admin-progress`, width: 1280, height: 800 });
      await signIn(page, 'ADMIN', PASSWORD);
      await waitForRoute(page, 'admin-progress');
      await page.waitForSelector('.admin-section[data-section="progress"] .stat-tile');
      const text = (await page.innerText('.admin-section[data-section="progress"]')).replace(/\s+/g, ' ');
      assert.match(text, /[1-9]\d* Done of \d+ assigned/);
      await page.waitForSelector('svg.chart-svg path.chart-col');
      // Today's column reads out from the keyboard (it is empty when the work was saved just before midnight).
      await page.focus('svg.chart-svg');
      await page.keyboard.press('End');
      await page.waitForSelector('.chart-tip:not([hidden])');
      assert.match(await page.innerText('.chart-tip'), /\d+ recordings?/);
      await t.screenshot(page, 'admin_server_progress');
      await page.click('.admin-section[data-section="progress"] [data-tab="recordings"]');
      await page.waitForSelector('[data-panel="recordings"] tbody tr');
      await page.selectOption('.admin-section[data-section="progress"] #progress-work', 'all');
      await page.waitForFunction(() => /As of/.test(document.querySelector('.admin-section[data-section="progress"] .progress-filters')?.innerText || ''));
      // Removing every study recording keeps the one with results and says why.
      await goSection(page, 'Recordings', 'admin-recordings');
      const sel = '.admin-section[data-section="recordings"]';
      await page.waitForSelector(`${sel} tbody tr`);
      await page.selectOption(`${sel} .filters select >> nth=0`, 'study');
      await page.check(`${sel} input[data-select-all]`);
      const n = await page.locator(`${sel} tbody input[data-select]:checked`).count();
      await page.click(`${sel} [data-log="bulk-remove"]`);
      await page.click(`${sel} .confirm-strip button.destructive`);
      await page.waitForSelector(`${sel} .bulk-result h3`, { timeout: 30000 });
      const result = (await page.innerText(`${sel} .bulk-result`)).replace(/\s+/g, ' ');
      assert.match(result, /recordings? kept/);
      assert.match(result, new RegExp(`of ${n} recordings`));
      await t.screenshot(page, 'admin_server_bulk_remove');
    },
  },
];
