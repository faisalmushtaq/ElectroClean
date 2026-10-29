// History, revisions, game elements and phones: an annotator revises a recording they finished (in
// the demonstration and on the real study server, which keeps the earlier files untouched), the
// history pages through a couple of hundred recordings, milestones and the anonymised leaderboard
// appear on the home page, and a phone says plainly that annotating needs a larger screen.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { signIn, waitForRoute, waitForTraces, annotations, eegPoint, drag, clickDialogButton, openExample, pressSave } from './helpers.mjs';

const PASSWORD = 'electroclean';

async function events(page) {
  await page.evaluate(() => globalThis.ElectroClean.flushLog());
  return page.evaluate(() => [...globalThis.ElectroClean.backend.visits.values()].flatMap((v) => v.events));
}

async function mark(page, from, to) {
  await page.keyboard.press('1');
  await drag(page, await eegPoint(page, from), await eegPoint(page, to));
}

/** The texts of a table row's cells. */
async function cells(row) {
  return row.locator('td').evaluateAll((tds) => tds.map((td) => td.textContent.trim()));
}

const HISTORY_ROWS = '.recordings-card table.history tbody tr';

async function homeTab(page, tab) {
  await page.click(`.rec-tabs [data-tab="${tab}"]`);
  await page.waitForSelector(`table.list[data-tab="${tab}"], .rec-empty`);
}

/** A demonstration with `n` extra recordings assigned to A01 (`done` of them saved) and three colleagues. */
async function bigDemo(page, n, done) {
  await page.evaluate(([n, done]) => {
    const b = globalThis.ElectroClean.backend;
    const s = b._admin.s;
    const day = 86400000;
    const start = Date.now() - done * 3600000;
    for (let i = 0; i < n; i++) {
      const id = `n${String(i).padStart(4, '0')}`;
      const rid = `sub-${id}/eeg/sub-${id}_task-rest_eeg.edf`;
      s.recordings.push({ scope: 'study', recording_id: rid, file_name: `sub-${id}_task-rest_eeg.edf`, format: 'edf', sfreq: 100, n_samples: 6000 + i,
        n_channels: 4, size_bytes: 50000 + i, sha256: `${String(i).padStart(64, '0')}`, registered_at: '2026-10-01T09:00:00+00:00', registered_by: 'test',
        registered_via: 'admin', notes: '', retired: false, warnings: [],
        manifest: { recording_id: rid, file_name: `sub-${id}_task-rest_eeg.edf`, format: 'edf', files: { stem: `sub-${id}_task-rest` },
          timing: { sfreq: 100, n_samples: 6000 + i }, ch_names: ['Fp1', 'Fp2', 'Cz', 'O1'] } });
      s.assignments.push({ annotator_id: 'A01', recording_id: rid, mode: 'standard', context_id: '', at: '2026-10-01T09:00:00+00:00' });
      if (i < done) {
        const key = b._key('A01', rid, 'standard', '');
        const saved = new Date(start + i * 3600000).toISOString();
        b.state.submissions.push({ key, annotator_id: 'A01', recording_id: rid, mode: 'standard', context_id: '', attempt: 1, saved_at: saved,
          annotations: [], session: { elapsed_s: 300, viewed_fraction: i % 2 ? 1 : 0.5 }, sha256: '', recording: null, guided: null, feedback: null, revision: null });
        b.state.done[key] = { saved_at: saved, attempt: 1 };
      }
    }
    // Colleagues, so that the leaderboard has enough people on it.
    for (const [id, count] of [['C01', 150], ['C02', 40], ['C03', 7]]) {
      s.users.push({ annotator_id: id, display_name: `Colleague ${id}`, email: null, role: 'annotator', status: 'active', created_at: '2026-10-02T09:00:00+00:00',
        last_seen: null, notes: '', programme: null });
      for (let i = 0; i < count; i++) {
        const rid = s.recordings.filter((r) => r.manifest)[i].recording_id;
        s.assignments.push({ annotator_id: id, recording_id: rid, mode: 'standard', context_id: '', at: '2026-10-01T09:00:00+00:00' });
        const key = b._key(id, rid, 'standard', '');
        b.state.submissions.push({ key, annotator_id: id, recording_id: rid, mode: 'standard', context_id: '', attempt: 1,
          saved_at: new Date(Date.now() - day).toISOString(), annotations: [], session: { elapsed_s: 200 }, sha256: '', recording: null });
        b.state.done[key] = { saved_at: new Date().toISOString(), attempt: 1 };
      }
    }
    b._save();
  }, [n, done]);
}

// ------------------------------------------------------------ the real study server
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

function checksums(folder) {
  if (!fs.existsSync(folder)) return {};
  return Object.fromEntries(fs.readdirSync(folder).sort().map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, f))).digest('hex')]));
}

async function adminCall(t, token, op, body) {
  const res = await fetch(`${t.study.base}api/v1/admin/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-ElectroClean': '1' },
    body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok && !(op === 'user_add' && res.status === 409)) throw new Error(`${op}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

export const tests = [
  {
    name: 'revising a finished recording in the demonstration: a new version, the earlier one kept, logged',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      assert.match(await page.textContent('.progress-card [data-stat="done"]'), /^0 of 3/);
      assert.match(await page.textContent('.games-card'), /Goals and milestones/);
      await openExample(page, 0);
      await page.waitForTimeout(600); // a screen counts as viewed after 400 ms on it
      await mark(page, 3.0, 3.4);
      await pressSave(page);
      assert.match(await page.textContent('.dialog'), /You can still revise them later from your history/);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title');
      assert.match(await page.textContent('.dialog'), /Milestone reached: First recording/);
      await clickDialogButton(page, 'Back to my recordings');
      await waitForRoute(page, 'home');
      // A calm note of the milestone, once, that does not stand in the way.
      assert.match(await page.textContent('.celebrate'), /milestones? reached.*First recording/i);
      await t.screenshot(page, 'history_celebrate');
      assert.ok((await events(page)).some((e) => e.type === 'milestone_reached' && e.milestone === 'recordings-1'));

      // The history: newest first, with the version, the number of annotations and Open to revise.
      await homeTab(page, 'history');
      const row = page.locator(HISTORY_ROWS).first();
      const first = await cells(row);
      assert.match(first[0], /^sub-demo01_task-rest_eeg\.edf/);
      assert.deepEqual([first[1], first[2]], ['1', '1'], first.join(' | '));
      await t.screenshot(page, 'history_tab');
      await row.locator('button', { hasText: 'Open to revise' }).click();
      await waitForRoute(page, 'open');
      assert.match(await page.textContent('main h1'), /^Revise sub-demo01/);
      await page.click('.example-card button');
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      assert.match(await page.textContent('.ws-revision'), /Revising version 1\..*version 2/);
      assert.equal((await annotations(page)).length, 1, 'the latest saved annotations open');
      assert.equal(await page.locator('.ws-actions button', { hasText: 'Save and Finish' }).count(), 0);
      await t.screenshot(page, 'history_revising');
      // A screen counts as viewed after DWELL_MS (400 ms) on screen; a person never saves faster than that.
      await page.waitForTimeout(600);
      await mark(page, 9.2, 10.8);
      await page.click('.ws-revision button.primary');
      await page.waitForSelector('.dialog');
      assert.match(await page.textContent('.dialog'), /saved as version 2\. Version 1 is kept/);
      await clickDialogButton(page, 'Submit the revision');
      await page.waitForSelector('.dialog .dialog-title');
      assert.equal(await page.textContent('.dialog .dialog-title'), 'Revision saved');
      await clickDialogButton(page, 'Back to my recordings');
      await waitForRoute(page, 'home');
      const subs = await page.evaluate(() => globalThis.ElectroClean.backend.state.submissions.filter((s) => s.recording_id.includes('demo01'))
        .map((s) => [s.attempt, s.annotations.length]));
      assert.deepEqual(subs, [[1, 1], [2, 2]]);
      // What was on the screen (the coverage of the Recording tab) goes with each save, for the "viewed in full" milestones.
      const viewed = await page.evaluate(() => globalThis.ElectroClean.backend.state.submissions.map((x) => x.session.viewed_fraction));
      assert.ok(viewed.every((v) => typeof v === 'number' && v > 0 && v <= 1), JSON.stringify(viewed));
      await homeTab(page, 'history');
      const second = await cells(page.locator(HISTORY_ROWS).first());
      assert.match(second[0], /^sub-demo01_task-rest_eeg\.edfSaved /);
      assert.deepEqual([second[1], second[2]], ['2', '2'], second.join(' | '));
      // A revision is not a new recording: the counter stays at one.
      assert.match(await page.textContent('.progress-card [data-stat="done"]'), /^1 of 3/);

      // Opening it again and leaving without changes keeps everything as it was.
      await page.locator(HISTORY_ROWS).first().locator('button', { hasText: 'Open to revise' }).click();
      await page.click('.example-card button');
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      assert.equal((await annotations(page)).length, 2);
      await page.click('.ws-revision button:not(.primary)');
      await waitForRoute(page, 'home');
      assert.equal(await page.evaluate(() => globalThis.ElectroClean.backend.state.submissions.length), 2);
      // Opening the finished file again from the computer offers the revision too.
      await page.locator('ul.examples button').first().click();
      await page.waitForSelector('.result [data-log="open-to-revise"]');
      assert.match(await page.textContent('.result'), /already finished/);
      await page.click('.result [data-log="open-to-revise"]');
      await waitForRoute(page, 'annotate');
      assert.match(await page.textContent('.ws-revision'), /Revising version 2/);
      await page.click('.ws-revision button:not(.primary)');
      await waitForRoute(page, 'home');
      const kinds = (await events(page)).map((e) => e.type);
      for (const k of ['revision_started', 'revision_submitted', 'revision_left']) assert.ok(kinds.includes(k), `no ${k}; got ${[...new Set(kinds)].join(', ')}`);
      const sub = (await events(page)).find((e) => e.type === 'revision_submitted');
      assert.deepEqual([sub.version, sub.revises, sub.n_annotations], [2, 1, 2]);
    },
  },
  {
    name: 'a couple of hundred recordings: tabs, search, pages, milestones, goal and the leaderboard',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 720 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await bigDemo(page, 300, 120);
      const ms = await page.evaluate(async () => {
        const t0 = performance.now();
        await globalThis.ElectroClean.reloadHome();
        return performance.now() - t0;
      });
      assert.ok(ms < 3000, `the home page took ${Math.round(ms)} ms`);
      const count = async (tab) => Number(await page.textContent(`.rec-tabs [data-tab="${tab}"] .tab-count`));
      assert.deepEqual([await count('todo'), await count('done'), await count('all'), await count('history')], [183, 120, 303, 120]);
      assert.equal(await page.locator('.recordings-card table.list tbody tr').count(), 25, 'one page of rows in the document');
      await homeTab(page, 'history');
      assert.match(await page.textContent('.rec-pager'), /1 to 25 of 120/);
      // newest first
      assert.match(await page.locator(HISTORY_ROWS).first().textContent(), /sub-n0119_task-rest_eeg\.edf/);
      await page.click('[data-log="recordings-next"]');
      assert.match(await page.textContent('.rec-pager'), /26 to 50 of 120/);
      assert.match(await page.locator(HISTORY_ROWS).first().textContent(), /sub-n0094/);
      await page.fill('.rec-search', 'n0007');
      await page.waitForFunction(() => document.querySelectorAll('.recordings-card table.list tbody tr').length === 1);
      assert.match(await page.textContent('.recordings-card table.list tbody'), /sub-n0007_task-rest_eeg\.edf/);
      await page.fill('.rec-search', '');
      await page.selectOption('.rec-sort', 'length');
      await page.waitForFunction(() => /sub-n0000_/.test(document.querySelector('.recordings-card table.list tbody tr')?.textContent || ''));
      await page.selectOption('.rec-sort', 'recent');
      await t.screenshot(page, 'history_many');

      // Milestones: progress through the recordings and, where it is measured, viewing them in full.
      const reached = await page.$$eval('.games-milestones .badge-row li', (lis) => lis.map((li) => li.dataset.milestone));
      for (const id of ['recordings-1', 'recordings-10', 'recordings-25', 'recordings-50', 'recordings-100', 'thorough-5', 'thorough-25', 'team-25']) {
        assert.ok(reached.includes(id), `${id} in ${reached.join(', ')}`);
      }
      assert.ok(!reached.includes('recordings-150'));
      // Each badge names itself, for screen readers and as a title.
      assert.equal(await page.getAttribute('.badge-row [data-milestone="recordings-10"] svg', 'aria-label'), '10 recordings saved, reached');
      assert.equal(await page.textContent('.badge-row [data-milestone="streak-3"] svg title'), '3 days in a row, reached');
      assert.equal(await page.getAttribute('.milestone-list [data-milestone="recordings-150"] svg', 'aria-label'), '150 recordings saved, not yet reached');
      assert.match(await page.textContent('.games-milestones'), /Next: One hundred and fifty, 30 to go/);

      // The goal for the week.
      await page.click('[data-log="goal-set"]');
      await page.fill('.goal-input', '400');
      await page.click('[data-log="goal-save"]');
      assert.match(await page.textContent('.games-goal .error'), /from 1 to 200/);
      await page.fill('.goal-input', '150');
      await page.click('[data-log="goal-save"]');
      await page.waitForFunction(() => /Your goal this week/.test(document.querySelector('.games-goal')?.textContent || ''));
      assert.match(await page.textContent('.games-goal'), /\d+ of 150/);

      // The leaderboard: pseudonyms, the person's own row marked, no annotator IDs.
      const board = await page.textContent('.leaderboard-card');
      for (const id of ['A01', 'C01', 'C02', 'C03']) assert.ok(!board.includes(id), `${id} is on the leaderboard`);
      assert.deepEqual(await page.$$eval('table.leaderboard tbody tr', (rows) => rows.map((r) => r.cells[2].textContent)), ['150', '120', '40', '7']);
      assert.match(await page.textContent('table.leaderboard tr.you'), /^2.*\(you\)120$/);
      await t.screenshot(page, 'games_leaderboard');
      await page.uncheck('[data-log="leaderboard-show"]');
      await page.waitForFunction(() => !document.querySelector('table.leaderboard tr.you'));
      assert.equal(await page.locator('table.leaderboard tbody tr').count(), 3);
      assert.ok((await events(page)).some((e) => e.type === 'leaderboard_visibility' && e.shown === false));
      await page.check('[data-log="leaderboard-show"]');
      await page.waitForSelector('table.leaderboard tr.you');

      // An iPad, upright and on its side: the history and the game cards fit without sideways scrolling.
      for (const [w, h] of [[820, 1180], [1180, 820]]) {
        const ipad = await t.newPage({ width: w, height: h, ipad: true });
        await ipad.evaluate((st) => localStorage.setItem('electroclean.demo.v1', st), await page.evaluate(() => localStorage.getItem('electroclean.demo.v1')));
        await ipad.reload();
        await signIn(ipad, 'A01');
        await waitForRoute(ipad, 'home');
        await homeTab(ipad, 'history');
        assert.ok(await ipad.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no sideways scrolling at ${w} × ${h}`);
        const target = await ipad.locator(HISTORY_ROWS).first().locator('button').boundingBox();
        assert.ok(target.height >= 40, `a 40-pixel target at ${w} × ${h}`);
        await t.screenshot(ipad, 'history_ipad');
        await ipad.context().close();
      }
    },
  },
  {
    name: 'a study that switches revisions and game elements off',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 720 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => /^admin/.test(globalThis.ElectroClean.route || '') && globalThis.ElectroClean.adminArea);
      await page.evaluate(() => globalThis.ElectroClean.backend.admin('settings_update', { settings: { annotation: { allow_revisions: false }, gamification: { enabled: false } } }));
      await page.evaluate(() => globalThis.ElectroClean.showAdmin('admin-settings'));
      await page.waitForSelector('.admin-section[data-section="settings"] .games-warning');
      assert.match(await page.textContent('.admin-section[data-section="settings"]'), /Let annotators revise recordings they have finished/);
      assert.match(await page.textContent('.games-warning'), /say so in the study's methods/);
      // Both blocks of the merged settings: Long sessions (annotator comfort) and Game elements.
      await page.locator('h3', { hasText: 'Long sessions' }).scrollIntoViewIfNeeded();
      await t.screenshot(page, 'admin_settings_long_sessions');
      await page.locator('.games-warning').scrollIntoViewIfNeeded();
      await t.screenshot(page, 'games_admin_settings');
      await page.click('button[data-log="sign-out"]');
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      assert.equal(await page.locator('.games-card').count(), 0);
      await openExample(page, 0);
      await mark(page, 3.0, 3.4);
      await pressSave(page);
      assert.match(await page.textContent('.dialog'), /You will not be able to change them afterwards/);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title');
      await clickDialogButton(page, 'Back to my recordings');
      await waitForRoute(page, 'home');
      await homeTab(page, 'history');
      assert.equal(await page.locator('.recordings-card table.history button', { hasText: 'Open to revise' }).count(), 0);
    },
  },
  {
    name: 'a phone: the sign-in page says annotating needs a larger screen, and the notice offers the link and signing out',
    async run(t) {
      const { assert } = t;
      const phone = await t.newPage({ width: 390, height: 844, ipad: true });
      await phone.waitForSelector('form.signin-form');
      assert.ok(await phone.isVisible('.phone-note'));
      assert.match(await phone.textContent('.phone-note'), /Annotating needs a tablet or a computer\..*Administrators can sign in/);
      await t.screenshot(phone, 'phone_signin');
      await signIn(phone, 'A01');
      await waitForRoute(phone, 'home');
      assert.ok(await phone.isVisible('.small-screen'));
      const notice = await phone.textContent('.small-screen');
      assert.match(notice, /needs a larger screen/);
      assert.doesNotMatch(notice, /You can still sign in/);
      const href = await phone.getAttribute('.small-screen a[data-log="email-link"]', 'href');
      assert.match(href, /^mailto:\?subject=.*&body=.*/);
      assert.ok(decodeURIComponent(href).includes(t.base), decodeURIComponent(href));
      assert.ok(!decodeURIComponent(href).includes('#home'));
      await t.screenshot(phone, 'phone_notice');
      await phone.click('.small-screen button[data-log="sign-out"]');
      await waitForRoute(phone, 'signin');
      assert.ok(await phone.isVisible('form.signin-form'));
      // An administrator can go on to the admin area, which works on a phone.
      await signIn(phone, 'ADMIN');
      await phone.waitForFunction(() => /^admin/.test(globalThis.ElectroClean.route || ''));
      await phone.evaluate(() => globalThis.ElectroClean.showHome());
      await phone.waitForSelector('.small-screen button[data-log="admin"]', { state: 'visible' });
      await phone.click('.small-screen button[data-log="admin"]');
      await phone.waitForFunction(() => /^admin/.test(globalThis.ElectroClean.route || ''));
      // The larger screen is unaffected.
      const desk = await t.newPage({ width: 1280, height: 720 });
      await desk.waitForSelector('form.signin-form');
      assert.equal(await desk.isVisible('.phone-note'), false);
    },
  },
  {
    name: 'revising on the study server: a new attempt beside the untouched files, and the history',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      // An annotator of this test's own, so that the other tests' figures stay as they were.
      const login = await (await fetch(`${t.study.base}api/v1/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ElectroClean': '1' },
        body: JSON.stringify({ annotator_id: 'ADMIN', password: PASSWORD }) })).json();
      await adminCall(t, login.token, 'user_add', { annotator_id: 'R01', display_name: 'Reviser', password: PASSWORD });
      await adminCall(t, login.token, 'assign', { annotator_ids: ['R01'], all: true });
      const page = await t.newPage({ url: t.study.base });
      await signIn(page, 'R01', PASSWORD);
      await waitForRoute(page, 'home');
      const file = 'sub-003_task-rest_eeg.edf';
      await page.locator('table.list tr', { hasText: file }).locator('button', { hasText: 'Open' }).click();
      await waitForRoute(page, 'open');
      await page.setInputFiles('input[data-log="file-input"]', filesFor(t.study.dir, file));
      await waitForRoute(page, 'annotate', 30000);
      await waitForTraces(page);
      await mark(page, 3.0, 3.4);
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 30000 });
      await clickDialogButton(page, 'Back to my recordings');
      await waitForRoute(page, 'home');
      const folder = path.join(t.study.dir, 'study', 'Annotated_Events', 'annotator-R01', 'sub-003', 'eeg');
      const before = checksums(folder);
      assert.equal(Object.keys(before).length, 5);

      await homeTab(page, 'history');
      const row = page.locator(HISTORY_ROWS, { hasText: file });
      assert.equal((await cells(row))[1], '1');
      await row.locator('button', { hasText: 'Open to revise' }).click();
      await waitForRoute(page, 'open');
      await page.setInputFiles('input[data-log="file-input"]', filesFor(t.study.dir, file));
      await waitForRoute(page, 'annotate', 30000);
      await waitForTraces(page);
      assert.match(await page.textContent('.ws-revision'), /Revising version 1/);
      assert.equal((await annotations(page)).length, 1);
      await mark(page, 6.0, 6.6);
      await page.click('.ws-revision button.primary');
      await clickDialogButton(page, 'Submit the revision');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 30000 });
      assert.match(await page.textContent('.dialog'), /saved as version 2/);
      await clickDialogButton(page, 'Back to my recordings');
      await waitForRoute(page, 'home');

      const after = checksums(folder);
      assert.equal(Object.keys(after).length, 10);
      for (const [f, sum] of Object.entries(before)) assert.equal(after[f], sum, `${f} is unchanged`);
      assert.ok(Object.keys(after).some((f) => f.includes('_attempt-02_annotations.json')));
      const doc = JSON.parse(fs.readFileSync(path.join(folder, Object.keys(after).find((f) => f.includes('_attempt-02_annotations.json'))), 'utf8'));
      assert.equal(doc.annotations.length, 2);
      assert.equal(doc.session.context.revision.revises_version, 1);
      await homeTab(page, 'history');
      const v2 = await cells(page.locator(HISTORY_ROWS, { hasText: file }));
      assert.deepEqual([v2[1], v2[2]], ['2', '2'], v2.join(' | '));
      // The interaction log, written by the server, has the revision.
      await page.evaluate(() => globalThis.ElectroClean.flushLog());
      const logs = path.join(t.study.dir, 'study', 'Annotated_Events', 'interaction_logs', 'annotator-R01');
      const kinds = fs.readdirSync(logs).filter((f) => f.endsWith('.jsonl'))
        .flatMap((f) => fs.readFileSync(path.join(logs, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type));
      for (const k of ['revision_started', 'revision_submitted', 'milestone_reached']) assert.ok(kinds.includes(k), `no ${k} in the server's log`);
      // The game elements come from the server: one recording done, and the milestone reached.
      assert.match(await page.textContent('.progress-card [data-stat="done"]'), /^1 of \d+/);
    },
  },
];
