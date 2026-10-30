// Tasks: the administrator shares recordings out in the admin area's Tasks section (people, recordings,
// k and a part of each recording), sees the share-out before anything is made, and makes it once; the
// annotator then annotates only their part (the rest hatched, the view kept inside it, a mark outside
// refused with a plain message) and saves it; the study refuses a mark outside the part too. On the
// real study server (the sandbox says plainly that tasks need one).
import fs from 'node:fs';
import path from 'node:path';
import { drag, eegPoint, pressSave, clickDialogButton, signIn, waitForRoute, waitForTraces } from './helpers.mjs';

const PASSWORD = 'electrotag';
const FILE = 'sub-003_task-rest_eeg.edf';

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

async function api(t, token, method, p, body) {
  const res = await fetch(`${t.study.base}api/v1${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-ElectroTag': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok && !(p.endsWith('user_add') && res.status === 409)) throw new Error(`${p}: ${res.status} ${JSON.stringify(data)}`);
  return { status: res.status, ...data };
}

const login = async (t, id) => (await api(t, null, 'POST', '/login', { annotator_id: id, password: PASSWORD })).token;


export const tests = [
  {
    name: 'on the study server: the administrator shares a part of a recording out with a preview, and the annotator annotates only that part',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const admin = await login(t, 'ADMIN');
      for (const id of ['Q31', 'Q32']) await api(t, admin, 'POST', '/admin/user_add', { annotator_id: id, display_name: `Task annotator ${id}`, password: PASSWORD });

      // ---------------------------------------------- the share-out, previewed first
      const page = await t.newPage({ url: `${t.study.base}#admin-tasks` });
      await signIn(page, 'ADMIN', PASSWORD);
      await waitForRoute(page, 'admin-tasks');
      await page.waitForSelector('[data-section="tasks"] [data-log="tasks-preview"]');
      const form = page.locator('.admin-section[data-section="tasks"] .admin-card').first();
      await form.locator('fieldset', { hasText: 'Annotators to share among' }).locator('button', { hasText: 'None' }).click();
      for (const id of ['Q31', 'Q32']) await form.locator(`input[data-name="task-people"][value="${id}"]`).check();
      await form.locator('label.check', { hasText: 'Every recording of the study' }).locator('input').uncheck();
      await form.locator('.check-item', { hasText: FILE }).locator('input').check();
      const part = form.locator('.admin-field', { hasText: 'Part of each recording' }).locator('select');
      await part.selectOption('one');
      await form.locator('.admin-field', { hasText: 'From (seconds)' }).locator('input').fill('20');
      await form.locator('.admin-field', { hasText: 'To (seconds)' }).locator('input').fill('40');
      assert.equal(await page.isDisabled('[data-log="tasks-create"]'), true, 'nothing is made before the preview');
      await page.click('[data-log="tasks-preview"]');
      await page.waitForSelector('.tasks-preview .tasks-summary');
      assert.match(await page.textContent('.tasks-summary'), /^1 task, each to 2 people: 2 new assignments\. Everyone gets 1\./);
      assert.match(await page.innerText('.tasks-preview'), /0:20 to 0:40/);
      const tasksNow = await api(t, admin, 'POST', '/admin/tasks_list', {});
      assert.equal(tasksNow.tasks.length, 0, 'the preview makes nothing');
      await page.locator('.tasks-preview').scrollIntoViewIfNeeded();
      await t.screenshot(page, 'tasks_preview');
      // A change after the preview asks for it again.
      await form.locator('.admin-field', { hasText: 'To (seconds)' }).locator('input').fill('41');
      await page.waitForFunction(() => document.querySelector('[data-log="tasks-create"]').disabled);
      await form.locator('.admin-field', { hasText: 'To (seconds)' }).locator('input').fill('40');
      await page.click('[data-log="tasks-preview"]');
      await page.waitForSelector('[data-log="tasks-create"]:not([disabled])');
      assert.equal(await page.textContent('[data-log="tasks-create"]'), 'Make 1 task');
      await page.click('[data-log="tasks-create"]');
      await page.waitForFunction(() => /Made: 1 task, 2 new assignments/.test(document.querySelector('.admin-main').textContent));
      assert.match(await page.innerText('.admin-section[data-section="tasks"] .btn-row + .admin-msg'), /Made: 1 task/, 'said beside the button pressed');
      await page.waitForSelector('[data-section="tasks"] table.admin-list tbody tr');
      const row = await page.innerText('[data-section="tasks"] table.admin-list tbody tr');
      assert.match(row, /0:20 to 0:40/);
      assert.match(row, /Q31/);
      assert.match(row, /Collecting/);
      await page.locator('.admin-section[data-section="tasks"] table.admin-list').first().scrollIntoViewIfNeeded();
      await t.screenshot(page, 'tasks_list');
      const made = (await api(t, admin, 'POST', '/admin/tasks_list', {})).tasks;
      assert.equal(made.length, 1);
      assert.deepEqual(made[0].annotators, ['Q31', 'Q32']);
      assert.deepEqual(made[0].window, { start_sample: 2560, end_sample: 5120, start_s: 20, end_s: 40 });
      const audit = await api(t, admin, 'POST', '/admin/audit', { limit: 5 });
      assert.ok(audit.entries.some((e) => e.op === 'tasks_create'), 'the share-out is in the audit log');

      // ------------------------------------------------- the annotator's part
      const ann = await t.newPage({ url: t.study.base });
      await signIn(ann, 'Q31', PASSWORD);
      await waitForRoute(ann, 'home');
      const item = await ann.evaluate((f) => globalThis.ElectroTag.assignments.items.find((i) => i.file_name === f), FILE);
      assert.deepEqual(item.task.window, made[0].window);
      await ann.locator('.recordings-card tr', { hasText: FILE }).locator('button', { hasText: 'Open' }).click();
      await waitForRoute(ann, 'open');
      await ann.setInputFiles('input[data-log="file-input"]', filesFor(t.study.dir, FILE));
      await waitForRoute(ann, 'annotate', 30000);
      await waitForTraces(ann);
      assert.equal(await ann.textContent('[data-log="task-part"]'), 'Your part: 0:20 to 0:40');
      const view = () => ann.evaluate(() => ({ ...globalThis.ElectroTag.ws.viewer.view }));
      assert.ok((await view()).startS >= 19 - 1e-6, 'the view opens at the part');
      // Paging back to the start of the recording stops at the part (with its second of context), and on to the end too.
      await ann.evaluate(() => globalThis.ElectroTag.ws.viewer.over.focus());
      for (let i = 0; i < 6; i++) await ann.keyboard.press('Shift+ArrowLeft');
      await ann.waitForTimeout(300);
      assert.ok(Math.abs((await view()).startS - 19) < 1e-6, `paged back to the start of the part: ${(await view()).startS}`);
      for (let i = 0; i < 6; i++) await ann.keyboard.press('Shift+ArrowRight');
      await ann.waitForTimeout(300);
      let v = await view();
      assert.ok(Math.abs(v.startS + v.durationS - 41) < 1e-6, `paged on to the end of the part: ${v.startS + v.durationS}`);
      // The widest view is the part with its context.
      for (let i = 0; i < 8; i++) await ann.keyboard.press('End');
      await ann.waitForTimeout(300);
      v = await view();
      assert.ok(Math.abs(v.durationS - 22) < 1e-6 && Math.abs(v.startS - 19) < 1e-6, `the widest view: ${JSON.stringify(v)}`);
      await ann.evaluate(() => globalThis.ElectroTag.ws.viewer.setView({ startS: 31, durationS: 10 }, 'code'));
      await ann.waitForTimeout(300);
      // A mark across the end of the part stops at it; one outside is refused, with a plain message.
      await ann.keyboard.press('1');
      await drag(ann, await eegPoint(ann, 38.5), await eegPoint(ann, 40.8));
      let anns = await ann.evaluate(() => globalThis.ElectroTag.ws.store.annotations());
      assert.equal(anns.length, 1);
      assert.equal(anns[0].onset_sample + anns[0].duration_samples, 5120, 'stopped at the end of the part');
      await drag(ann, await eegPoint(ann, 40.3), await eegPoint(ann, 40.9));
      await ann.waitForFunction(() => /outside your part of the recording, 0:20 to 0:40/.test(document.querySelector('.ws-message')?.textContent || ''));
      anns = await ann.evaluate(() => globalThis.ElectroTag.ws.store.annotations());
      assert.equal(anns.length, 1, 'nothing made outside the part');
      await ann.evaluate(() => globalThis.ElectroTag.ws.viewer.setView({ startS: 15 }, 'code'));
      await ann.waitForTimeout(400);
      await t.screenshot(ann, 'tasks_annotate_part');
      // The study refuses a mark outside the part too (a browser that did not keep to it).
      const token = await login(t, 'Q31');
      const outside = { annotation_id: 'f'.repeat(32), label: 'EMG-artifact', onset_sample: 100, duration_samples: 50, channels: [] };
      const r = await api(t, token, 'PUT', `/drafts/${encodeURIComponent(item.recording_id)}?mode=standard&context=`, { annotations: [outside], elapsed_s: 1 }).catch((e) => e);
      assert.match(String(r && r.message), /422.*outside_window/);
      // Saved, with the coverage of the part only.
      await ann.evaluate(() => globalThis.ElectroTag.ws.viewer.setView({ startS: 19, durationS: 22 }, 'code'));
      await ann.waitForTimeout(2500); // a view counts as seen after it has stayed a moment
      const fraction = await ann.evaluate(() => globalThis.ElectroTag.ws._viewedFraction());
      assert.ok(fraction > 0.99, `the part is all of what there is to view: ${fraction}`);
      await pressSave(ann);
      await clickDialogButton(ann, 'Save and Finish');
      await ann.waitForSelector('.dialog .dialog-title', { timeout: 30000 });
      await ann.locator('.dialog-buttons button', { hasText: /Back to my recordings|^OK$/ }).first().click();
      const after = (await api(t, admin, 'POST', '/admin/tasks_list', {})).tasks[0];
      assert.equal(after.counts.saved, 1);
      assert.deepEqual(after.people.map((p) => [p.annotator_id, p.status]), [['Q31', 'done'], ['Q32', 'todo']]);
      // The administrator's list shows it once read again.
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-tasks'));
      await page.waitForFunction(() => /1 of 2 saved/.test(document.querySelector('[data-section="tasks"] table.admin-list')?.textContent || ''));
    },
  },
  {
    name: 'in the sandbox: the Tasks section says that sharing out needs a study server',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ url: `${t.base}#admin-tasks` });
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin-tasks');
      await page.waitForSelector('[data-section="tasks"] [data-log="tasks-preview"]');
      // the list of tasks says so as it opens, and so does a preview
      await page.waitForFunction(() => /cannot list the tasks that share recordings out in the browser: that needs a study server or Firebase/.test(document.querySelector('.admin-section[data-section="tasks"]').textContent));
      await page.locator('.admin-section[data-section="tasks"] fieldset', { hasText: 'Annotators to share among' }).locator('button', { hasText: 'All' }).click();
      await page.click('[data-log="tasks-preview"]');
      await page.waitForFunction(() => /cannot work out a share-out of recordings among annotators \(tasks\) in the browser/.test(document.querySelector('.admin-section[data-section="tasks"]').textContent));
      assert.ok(await page.isDisabled('[data-log="tasks-create"]'));
      await t.screenshot(page, 'tasks_sandbox');
    },
  },
];
