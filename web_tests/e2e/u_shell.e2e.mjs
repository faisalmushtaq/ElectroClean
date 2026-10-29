// The pages around the annotation view, after the usability review of 29 October 2026: menus that
// fit a 720-pixel screen and give the focus back, the outcome of choosing a file shown where the
// person is looking (and worded for training on a training page), a study recording chosen on a
// training page opened only after a question, a lost connection told apart from a broken file (a
// kept copy is not removed for it), the home page's names for screen readers and its links to the
// guide, an invitation opened on a phone, and a study server that does not answer.
import fs from 'node:fs';
import path from 'node:path';
import { signIn, waitForRoute, waitForTraces, openExample, eegPoint, drag, clickDialogButton } from './helpers.mjs';
import { profilePage, kept, waitKept } from './l_device.e2e.mjs';
import { demoSpecs, syntheticEdfBytes } from '../../electrotag/web/static/js/data/synthetic.js';

const PASSWORD = 'electrotag';
const GUIDE = 'https://github.com/faisalmushtaq/ElectroTag/blob/main/docs/web/using.md';
const NAME = 'sub-demo01_task-rest_eeg.edf';

/** A file that is no recording of the study: the example with one data byte changed, under another name. */
function strangerFile() {
  const copy = Buffer.from(syntheticEdfBytes(demoSpecs()[0]));
  copy[copy.length - 1] ^= 0x01;
  return { name: 'my_own_recording.edf', mimeType: 'application/octet-stream', buffer: copy };
}

/** Where the open view's answer is, and whether it has the focus. */
async function outcome(page) {
  await page.waitForSelector('.view.open .result [role]');
  await page.waitForTimeout(400); // the scroll, smooth unless reduced motion is asked for
  return page.evaluate(() => {
    const box = document.querySelector('.view.open .result [role]');
    const r = box.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: innerHeight, focused: box.contains(document.activeElement), text: box.textContent.replace(/\s+/g, ' ') };
  });
}

function assertInView(t, o, where) {
  t.assert.ok(o.top >= 0 && o.top < o.height, `${where}: the answer starts on the screen (${o.top} of ${o.height})`);
  t.assert.ok(o.focused, `${where}: the answer has the focus`);
}

/** The files of one recording in the demonstration server's recordings folder. */
function filesFor(dir, fileName) {
  const stem = fileName.replace(/\.(vhdr|edf|bdf)$/i, '');
  const found = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.startsWith(stem) && /\.(vhdr|vmrk|eeg|edf|bdf)$/i.test(f)) found.push(p);
    }
  })(path.join(dir, 'recordings'));
  return found;
}

async function adminCall(t, op, body) {
  const login = await fetch(`${t.study.base}api/v1/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ElectroTag': '1' },
    body: JSON.stringify({ annotator_id: 'ADMIN', password: PASSWORD }) });
  const { token } = await login.json();
  const res = await fetch(`${t.study.base}api/v1/admin/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-ElectroTag': '1' },
    body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${op}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

export const tests = [
  {
    name: 'the right-click menu fits whole on a 1280×720 screen',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 720 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 3.0, 'Cz'), await eegPoint(page, 3.6, 'Cz'));
      const at = await eegPoint(page, 3.3, 'Cz');
      await page.mouse.click(at.x, at.y, { button: 'right' });
      await page.waitForSelector('.menu');
      const m = await page.evaluate(() => {
        const menu = document.querySelector('.menu');
        const r = menu.getBoundingClientRect();
        const del = [...menu.querySelectorAll('.menu-item')].find((b) => b.textContent.trim() === 'Delete').getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: innerHeight, scrolls: menu.scrollHeight > menu.clientHeight + 1, delBottom: del.bottom };
      });
      assert.ok(m.top >= 0 && m.bottom <= m.height, `the menu is on the screen (${m.top} to ${m.bottom} of ${m.height})`);
      assert.equal(m.scrolls, false, 'the menu shows every item without scrolling');
      assert.ok(m.delBottom <= m.bottom, 'Delete is shown whole');
      await t.screenshot(page, 'shell_context_menu');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.menu').count(), 0);
    },
  },
  {
    name: 'menus give the focus back to the button that opened them, after Esc, Tab or a dialog',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 800 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      const more = page.locator('.row-more').first();
      const id = await more.getAttribute('data-more');
      const onMore = () => page.evaluate((rid) => document.activeElement && document.activeElement.dataset.more === rid, id);
      await more.focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('.menu.row-menu');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.menu').count(), 0);
      assert.ok(await onMore(), 'Esc returns the focus to the More button');
      // Tab closes the menu and carries on from the More button.
      await page.keyboard.press('Enter');
      await page.waitForSelector('.menu.row-menu');
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('.menu').count(), 0, 'Tab closes the menu');
      assert.ok(await page.evaluate(() => document.activeElement && document.activeElement !== document.body && !document.activeElement.closest('.menu')),
        'the focus moves on in the page');
      // A dialog opened from the menu returns the focus to the More button too.
      await more.focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('.menu.row-menu');
      await page.keyboard.press('Enter'); // Report a problem with this recording…
      await page.waitForSelector('.dialog');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.dialog'));
      assert.ok(await onMore(), 'closing the dialog returns the focus to the More button');
    },
  },
  {
    name: 'the home page: names for screen readers, the review line opens the feedback, and links to the guide',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 800 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      assert.equal(await page.title(), 'ElectroTag – your recordings');
      assert.match(await page.getAttribute('.rec-tabs [data-tab="todo"]', 'aria-label'), /^To do, \d+ recordings?$/);
      assert.equal(await page.getAttribute('.rec-tabs [data-tab="todo"] .tab-count', 'aria-hidden'), 'true');
      const row = page.locator('.recordings-card tbody tr').first();
      const file = await row.locator('.file').textContent();
      assert.equal(await row.locator('.row-actions .btn:not(.row-more)').getAttribute('aria-label'), `Open ${file}`);
      assert.match(await page.getAttribute('ul.examples button', 'aria-label'), /^Use Example 1/);
      const link = page.locator('main .guide-link a');
      assert.equal(await link.getAttribute('href'), GUIDE);
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.equal(await link.getAttribute('rel'), 'noopener');
      // The column guides frame the page and cross no text: the inner pair is gone.
      assert.equal(await page.evaluate(() => getComputedStyle(document.body, '::after').content), 'none');
      await t.screenshot(page, 'shell_home');

      // A reviewed, finished recording: its review line is a button that opens the feedback.
      await page.evaluate(() => {
        const app = globalThis.ElectroTag;
        const it = app.assignments.items[0];
        it.status = 'done';
        app.reviews = { shown: true, reviews: [{ recording_id: it.recording_id, summary: '1 comment' }] };
        app.homeList = { tab: 'all', sort: 'recent', query: '', page: 0 };
        app.showHome();
      });
      await page.click('button.review-line');
      await waitForRoute(page, 'open');
      assert.match(await page.textContent('main h1'), /^See the feedback on /);
      await page.click('.view.open .back');
      await waitForRoute(page, 'home');

      // The Help tab of the annotation view links to the guide as well.
      await page.evaluate(() => { globalThis.ElectroTag.reviews = null; });
      await page.click('[data-log="sign-out"]');
      await waitForRoute(page, 'signin');
      assert.equal(await page.getAttribute('.signin-panel .guide-link a', 'href'), GUIDE);
      await t.screenshot(page, 'shell_signin');
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      assert.equal(await page.getAttribute('.help-text .guide-link a', 'href'), GUIDE);
    },
  },
  {
    name: 'the answer to a chosen file appears in view, with the focus, on a 1280×720 screen',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 720 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await page.click('[data-log="open-next"]');
      await waitForRoute(page, 'open');
      await page.setInputFiles('input[data-log="file-input"]', strangerFile());
      const o = await outcome(page);
      assertInView(t, o, 'a file outside the study');
      assert.match(o.text, /not one of the recordings of this study/);
      assert.ok(await page.evaluate(() => {
        const card = document.querySelector('.view.open section.card');
        return card.querySelector('.result').compareDocumentPosition(card.querySelector('.link-panel')) & Node.DOCUMENT_POSITION_FOLLOWING;
      }), 'the answer comes before Open from a link');
      await t.screenshot(page, 'shell_open_outcome');
    },
  },
  {
    name: 'a lost connection while reading a kept copy says so, offers Try again and keeps the copy',
    async run(t) {
      const { assert } = t;
      const bytes = syntheticEdfBytes(demoSpecs()[0]);
      const { page, close } = await profilePage(t);
      try {
        await signIn(page, 'A01');
        await waitForRoute(page, 'home');
        await page.click('[data-log="open-next"]');
        await waitForRoute(page, 'open');
        await page.check('[data-log="keep-chosen"]');
        await page.setInputFiles('input[data-log="file-input"]', { name: NAME, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
        await waitForRoute(page, 'annotate', 30000);
        await waitKept(page, 1);
        await page.click('[data-log="close"]');
        await clickDialogButton(page, 'Close and finish later');
        await waitForRoute(page, 'home');

        // The page is loaded again, and the part that reads recordings cannot be fetched.
        await page.route('**/js/data/recording.js', (r) => r.abort('internetdisconnected'));
        await page.reload();
        await page.waitForFunction(() => (globalThis.ElectroTag && globalThis.ElectroTag.route === 'home') || document.querySelector('#signin-id'));
        if (await page.evaluate(() => globalThis.ElectroTag.route !== 'home')) await signIn(page, 'A01');
        await waitForRoute(page, 'home');
        await page.click('[data-log="open-next"]'); // the kept copy opens by itself
        await waitForRoute(page, 'open');
        const o = await outcome(page);
        assert.match(o.text, /internet connection/);
        assert.ok(o.focused, 'the answer has the focus');
        assert.equal((await kept(page)).list.length, 1, 'the kept copy is not removed for a lost connection');

        // The connection is back: Try again reads the same copy.
        await page.unroute('**/js/data/recording.js');
        await page.click('[data-log="read-again"]');
        await waitForRoute(page, 'annotate', 30000);
        await waitForTraces(page);
      } finally {
        await close();
      }
    },
  },
  {
    name: 'an invitation opened on a phone says that annotating needs a larger screen before the link is used',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 800 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => /^admin/.test(globalThis.ElectroTag.route || ''));
      const token = await page.evaluate(async () => {
        const out = await globalThis.ElectroTag.backend.admin('user_add', { annotator_id: 'P31', display_name: 'Phone', role: 'annotator', invite: true });
        return out.invite_token || String(out.invite_link || '').split('invite=')[1];
      });
      const phone = await page.context().newPage();
      await phone.setViewportSize({ width: 390, height: 844 });
      await phone.goto(`${t.base}?invite=${token}`);
      await phone.waitForSelector('.invite-card[data-invite="welcome"]');
      assert.ok(await phone.isVisible('.invite-card .invite-phone'), 'the phone is told first');
      assert.match(await phone.innerText('.invite-card .invite-phone'), /Annotating needs a tablet or a computer/);
      await t.screenshot(phone, 'shell_invite_phone');
      // On a computer the note stays hidden.
      await phone.setViewportSize({ width: 1280, height: 800 });
      assert.equal(await phone.isVisible('.invite-card .invite-phone'), false);
    },
  },
  {
    name: 'study server: a study recording chosen on a training page is opened only after a question, and the answers are worded for training',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      await adminCall(t, 'user_add', { annotator_id: 'U31', display_name: 'Una', role: 'annotator', password: 'una chooses this' });
      await adminCall(t, 'programme_set', { annotator_id: 'U31', set_id: 'example' });
      await adminCall(t, 'assign', { annotator_ids: ['U31'], all: true });
      const page = await t.newPage({ url: t.study.base, width: 1280, height: 720 });
      await signIn(page, 'U31', 'una chooses this');
      await waitForRoute(page, 'training');
      const study = await page.evaluate(() => globalThis.ElectroTag.assignments.items.find((i) => i.mode === 'standard'));
      assert.ok(study, 'U31 has study recordings as well as training');
      await page.locator('main.training .btn.primary').first().click();
      await waitForRoute(page, 'open');
      const wanted = (await page.textContent('main h1')).replace(/^Open\s+/, '').trim();
      await page.setInputFiles('input[data-log="file-input"]', filesFor(t.study.dir, study.file_name));
      await page.waitForSelector('.dialog.other-recording', { timeout: 30000 });
      await t.screenshot(page, 'shell_training_other_recording');
      const text = await page.innerText('.dialog.other-recording');
      assert.match(text, /counts as real work/);
      assert.ok(text.includes(wanted), 'the question names the training recording this page is for');
      await clickDialogButton(page, 'Choose another file');
      const o = await outcome(page);
      assertInView(t, o, 'after Choose another file');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.route), 'open', 'nothing was opened');

      // A file outside the study, on a training page: worded for training.
      await page.setInputFiles('input[data-log="file-input"]', strangerFile());
      await page.waitForFunction(() => /step of your training needs/.test(document.querySelector('.view.open .result')?.textContent || ''), null, { timeout: 30000 });
      assertInView(t, await outcome(page), 'a file outside the study on a training page');
      await t.screenshot(page, 'shell_training_wrong_file');
    },
  },
  {
    name: 'study server: once its own site has answered, a start when it does not answer says so rather than starting the demonstration',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ url: t.study.base, width: 1280, height: 800 });
      await page.waitForSelector('#signin-id');
      assert.match(await page.textContent('.signin-card'), /Study:/);
      await page.route('**/api/v1/health', (r) => r.abort('internetdisconnected'));
      await page.reload();
      await page.waitForSelector('.signin-card .banner');
      assert.match(await page.textContent('.signin-card .banner'), /does not answer/);
      assert.equal(await page.locator('.demo-hint').count(), 0, 'the demonstration is not started');
      assert.match(await page.textContent('.signin-status .chip'), /Not connected/);
      assert.doesNotMatch(await page.textContent('.signin-card'), /Connecting…/);
    },
  },
];
