// Robustness under real conditions: a study (or a Firebase function waking up) that answers late or
// fails once, a key or button pressed again while the first press waits, a tab hidden overnight, a
// computer that slept, an administrator who moves on mid-run, a download that is stopped, left or
// cut off, and a recording kept on the device that another tab wants to remove. The demonstration's
// backend is slowed or made to fail from the page; the real study server's answers are held back
// with Playwright's routing.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { clickDialogButton, drag, eegPoint, openExample, pressSave, signIn, state, waitForRoute, waitForTraces, answerQuestionnaire } from './helpers.mjs';
import { demoSpecs, syntheticEdfBytes } from '../../electrotag/web/static/js/eeg/synthetic.js';
import { cloudService } from './l_links.e2e.mjs';

const require = createRequire(import.meta.url);

const PASSWORD = 'electrotag';
const HOUR_MS = 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mark(page, from, to) {
  await page.keyboard.press('1');
  await drag(page, await eegPoint(page, from), await eegPoint(page, to));
}

/** Change the demonstration's study settings (annotation block) and read GET /me again. */
async function studySettings(page, annotation) {
  await page.evaluate(async (a) => {
    const app = globalThis.ElectroTag;
    Object.assign(app.backend._admin.s.settings.annotation, a);
    app.backend._save();
    await app.refreshMe();
  }, annotation);
}

/**
 * Slow down (and count) calls of the demonstration's backend: `name` is a method of the backend;
 * each call waits `ms` first, and `fail(i, args)` may make call i throw instead. The calls are
 * counted in globalThis.__calls[name].
 */
async function slowDemo(page, name, ms, failSource = null) {
  await page.evaluate(([n, wait, failSrc]) => {
    const b = globalThis.ElectroTag.backend;
    globalThis.__calls = globalThis.__calls || {};
    globalThis.__calls[n] = [];
    const orig = (b.__orig = b.__orig || {})[n] || b[n].bind(b);
    b.__orig[n] = orig;
    // eslint-disable-next-line no-new-func
    const fail = failSrc ? new Function('i', 'args', failSrc) : null;
    b[n] = async (...args) => {
      const i = globalThis.__calls[n].length;
      globalThis.__calls[n].push(JSON.parse(JSON.stringify(args.length > 1 ? args.slice(0, 2) : args[0] ?? null)));
      const delay = typeof wait === 'number' ? wait : (wait[i] ?? wait[wait.length - 1]);
      await new Promise((r) => setTimeout(r, delay));
      const problem = fail ? fail(i, args) : null;
      if (problem) { const e = new Error(problem.message); Object.assign(e, problem); throw e; }
      return orig(...args);
    };
  }, [name, ms, failSource]);
}

const calls = (page, name) => page.evaluate((n) => (globalThis.__calls && globalThis.__calls[n]) || [], name);

/** Every event logged in this visit so far (the demonstration). */
async function events(page) {
  return page.evaluate(async () => {
    await globalThis.ElectroTag.flushLog();
    return [...globalThis.ElectroTag.backend.visits.values()].flatMap((v) => v.events);
  });
}

/** Pretend the page is hidden (another tab, the computer locked) or shown again. */
async function setHidden(page, hidden) {
  await page.evaluate((hd) => {
    Object.defineProperty(document, 'visibilityState', { value: hd ? 'hidden' : 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { value: hd, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

async function clock(page) {
  return page.evaluate(() => {
    const c = globalThis.ElectroTag.ws.clock;
    return { elapsed: c.elapsedS, isPaused: c.paused, reason: c.pauseReason, pausedFor: c.pausedForS };
  });
}

/** Whether a beforeunload now asks the person before the page closes. */
const asksBeforeLeaving = (page) => page.evaluate(() => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
});

async function adminLogin(t) {
  const res = await fetch(`${t.study.base}api/v1/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ElectroTag': '1' },
    body: JSON.stringify({ annotator_id: 'ADMIN', password: PASSWORD }) });
  return (await res.json()).token;
}

async function adminCall(t, token, op, body) {
  const res = await fetch(`${t.study.base}api/v1/admin/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-ElectroTag': '1' },
    body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${op}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// ------------------------------------------------------------- a stand-in cloud service
const NAME = 'sub-demo01_task-rest_eeg.edf';

/**
 * Serves the demonstration's EDF file in ways that go wrong: /slow/ sends half and then waits
 * `holdMs` before the rest, /drop/ sends half and then cuts the connection, /huge/ announces 3 GB.
 * Each request is recorded with whether the page hung up before the end.
 */
async function awkwardService(bytes, { holdMs = 2500 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const rec = { path: url.pathname, closedEarly: false, finished: false };
    seen.push(rec);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    res.on('close', () => { if (!rec.finished) rec.closedEarly = true; });
    if (url.pathname.startsWith('/huge/')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream', 'Content-Length': String(3 * 1024 ** 3) });
      res.write(Buffer.alloc(1024));
      setTimeout(() => res.destroy(), 3000);
      return;
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), 'Content-Disposition': `attachment; filename="${NAME}"` });
    const half = Math.floor(bytes.length / 2);
    res.write(Buffer.from(bytes.subarray(0, half)));
    if (url.pathname.startsWith('/drop/')) { setTimeout(() => res.destroy(), 200); return; }
    setTimeout(() => {
      if (res.destroyed) return;
      res.end(Buffer.from(bytes.subarray(half)), () => { rec.finished = true; });
    }, holdMs);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

async function toOpenView(page) {
  await page.click('[data-log="open-next"]');
  await waitForRoute(page, 'open');
  // The tick box gives way to a sentence once the browser says it stores nothing (WebKit's private
  // windows): wait for that answer before touching it.
  await page.evaluate(async () => {
    const { deviceStore } = await import('./js/views/device.js');
    const store = deviceStore(globalThis.ElectroTag);
    if (store && store.available) await store.usable();
  });
  await page.waitForTimeout(50);
  if (await page.locator('[data-log="keep-link"]').count()) await page.uncheck('[data-log="keep-link"]');
}

// ---------------------------------------------------------------- the device's store
/** A browser profile kept on disk (WebKit's private profiles store no files), with pages that share its storage. */
async function profile(t, { init = null } = {}) {
  const pw = require('playwright');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-robust-'));
  const context = await pw[t.browserName].launchPersistentContext(dir, { headless: true, viewport: { width: 1440, height: 900 }, locale: 'en-GB' });
  if (init) await context.addInitScript(init);
  const open = async () => {
    const page = await context.newPage();
    page.on('pageerror', (e) => t.errors.push(`pageerror: ${(e.stack || e.message).split('\n').slice(0, 4).join(' | ')}`));
    await page.goto(t.base);
    return page;
  };
  return { open, close: async () => { await context.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); } };
}

async function keptList(page) {
  return page.evaluate(async () => {
    const { deviceStore } = await import('./js/views/device.js');
    return deviceStore(globalThis.ElectroTag).list();
  });
}

async function opfsFiles(page) {
  return page.evaluate(async () => {
    if (!navigator.storage || !navigator.storage.getDirectory) return [];
    const out = [];
    const walk = async (dir, at) => {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') await walk(h, `${at}${name}/`); else out.push(`${at}${name}`);
      }
    };
    try { await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('electrotag-recordings'), ''); } catch { /* none */ }
    return out;
  });
}

async function waitFor(fn, what, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** The description of a kept copy is written last; make that write fail as a full device does (while __fullAtTheEnd is set). */
function fullAtTheEnd() {
  const quota = () => Promise.reject(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
  if (globalThis.FileSystemWritableFileStream) {
    const write = FileSystemWritableFileStream.prototype.write;
    FileSystemWritableFileStream.prototype.write = function (data) {
      if (globalThis.__fullAtTheEnd && data instanceof Blob && data.type === 'application/json') return quota();
      return write.call(this, data);
    };
  }
}

export const tests = [
  // ================================================================== saving
  {
    name: 'a slow Save and Finish: no draft, no pause and no leaving while it waits; a revision pressed twice and answered late is one new version',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await mark(page, 3.0, 3.4);
      await slowDemo(page, 'submit', 2500);
      await slowDemo(page, 'putDraft', 0);
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForFunction(() => globalThis.ElectroTag.ws && globalThis.ElectroTag.ws.s.submitting);
      // While the study has not answered: the page goes out of sight, B is pressed, Close is pressed.
      await setHidden(page, true);
      await setHidden(page, false);
      await page.keyboard.press('b');
      assert.equal((await clock(page)).isPaused, false, 'nothing to pause while the save waits');
      await page.click('[data-log="close"]');
      assert.equal(await page.locator('.dialog').count(), 0, 'Close asks nothing while the save waits');
      assert.match(await page.textContent('.ws-message'), /wait for the answer/);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.saveAndFinish()), false, 'a second Save and Finish does nothing');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 15000 });
      assert.equal(await page.textContent('.dialog .dialog-title'), 'Saved');
      assert.equal((await calls(page, 'submit')).length, 1);
      assert.equal((await calls(page, 'putDraft')).length, 0, 'no draft was sent while Save and Finish waited');
      await clickDialogButton(page, 'Back to my recordings');
      await waitForRoute(page, 'home');

      // A revision: Submit pressed twice, the answer late, and Leave without changes pressed meanwhile.
      await page.click('.rec-tabs [data-tab="history"]');
      await page.locator('.recordings-card table.history tbody tr').first().locator('button', { hasText: 'Open to revise' }).click();
      await waitForRoute(page, 'open');
      await page.click('.example-card button');
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      await mark(page, 9.2, 10.8);
      await slowDemo(page, 'submit', 2500);
      await page.dblclick('.ws-revision button.primary');
      await page.waitForSelector('.dialog');
      await page.waitForTimeout(300);
      assert.equal(await page.locator('.dialog').count(), 1, 'one question, still open after a double click');
      await clickDialogButton(page, 'Submit the revision');
      await page.waitForFunction(() => globalThis.ElectroTag.ws.s.submitting);
      await page.click('.ws-revision button.primary', { force: true }).catch(() => {});
      await page.click('.ws-revision [data-log="leave-revision"]');
      assert.equal(await page.locator('.dialog').count(), 0, 'Leave without changes waits for the save');
      assert.equal(await state(page).then((s) => s.route), 'annotate');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 15000 });
      assert.equal(await page.textContent('.dialog .dialog-title'), 'Revision saved');
      await clickDialogButton(page, 'Back to my recordings');
      await waitForRoute(page, 'home');
      assert.equal((await calls(page, 'submit')).length, 1, 'one revision sent');
      const subs = await page.evaluate(() => globalThis.ElectroTag.backend.state.submissions.filter((s) => s.recording_id.includes('demo01')).map((s) => s.attempt));
      assert.deepEqual(subs, [1, 2], 'one new attempt');
      const kinds = (await events(page)).map((e) => e.type);
      assert.ok(!kinds.includes('revision_left'), 'the revision was not left');

      // A revision saved by the study whose answer is lost (the connection drops): Submit again is
      // refused as already revised, and the person is told it was most likely saved the first time.
      await page.click('.rec-tabs [data-tab="history"]');
      await page.locator('.recordings-card table.history tbody tr').first().locator('button', { hasText: 'Open to revise' }).click();
      await waitForRoute(page, 'open');
      await page.click('.example-card button');
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      await mark(page, 14.2, 15.0);
      await page.evaluate(() => {
        const b = globalThis.ElectroTag.backend;
        const submit = b.__orig.submit;
        let n = 0;
        b.submit = async (body) => {
          const out = await submit(body);
          if (n++ === 0) { const e = new Error('The study server could not be reached. Check your internet connection and try again.'); e.status = 0; e.code = 'network'; throw e; }
          return out;
        };
      });
      await page.click('.ws-revision button.primary');
      await clickDialogButton(page, 'Submit the revision');
      await page.waitForSelector('.dialog .dialog-title');
      assert.equal(await page.textContent('.dialog .dialog-title'), 'Could not save');
      await clickDialogButton(page, 'OK');
      await page.click('.ws-revision button.primary');
      await clickDialogButton(page, 'Submit the revision');
      await page.waitForSelector('.dialog .dialog-title');
      assert.equal(await page.textContent('.dialog .dialog-title'), 'Probably saved already');
      assert.match(await page.textContent('.dialog'), /most likely saved your revision/);
      await clickDialogButton(page, 'OK');
      await waitForRoute(page, 'home');
      const versions = await page.evaluate(() => globalThis.ElectroTag.backend.state.submissions.filter((x) => x.recording_id.includes('demo01')).map((x) => x.attempt));
      assert.deepEqual(versions, [1, 2, 3], 'the revision whose answer was lost was saved once');
    },
  },
  // ===================================================================== pauses
  {
    name: 'the idle pause during a dialog keeps the dialog\'s focus; a computer that slept does not count the night',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await studySettings(page, { idle_pause_minutes: 0.05, break_reminder_minutes: 0, coverage_check: 'warn' });
      await openExample(page, 0);
      await mark(page, 3.0, 3.4);
      // Save and Finish lists the parts not yet viewed, and the annotator leaves it open.
      await page.click('.ws-actions button.primary');
      await page.waitForSelector('.dialog.coverage-check');
      await page.waitForFunction(() => globalThis.ElectroTag.ws.clock.paused, null, { timeout: 10000 });
      assert.equal((await clock(page)).reason, 'idle');
      assert.ok(await page.evaluate(() => document.querySelector('.dialog').contains(document.activeElement)), 'the focus stays in the dialog');
      await page.keyboard.press('Enter'); // the dialog's own button (Go to the first)
      await page.waitForSelector('.dialog', { state: 'detached' });
      assert.equal((await clock(page)).isPaused, true, 'Enter answered the dialog, not Resume');
      await page.click('.pause-panel [data-log="resume"]');

      // The computer sleeps with the page on screen: the first tick after waking comes hours later.
      const before = (await clock(page)).elapsed;
      await page.evaluate((h8) => {
        const ws = globalThis.ElectroTag.ws;
        const c = ws.clock;
        // The last input was 8 hours ago, with the clock running and the work done by then as now.
        c.runningSince -= h8; c.startedAt -= h8;
        ws._lastInput -= h8;
      }, 8 * HOUR_MS);
      await page.waitForFunction(() => globalThis.ElectroTag.ws.clock.paused, null, { timeout: 5000 });
      const after = await clock(page);
      assert.equal(after.reason, 'idle');
      assert.ok(after.elapsed < before + 10, `the night is not counted: ${before} s before, ${after.elapsed} s after`);
      assert.ok(after.pausedFor > 7.9 * 3600, `the pause began when the idle minutes ran out (${after.pausedFor} s)`);
    },
  },
  {
    name: 'a tab hidden overnight comes back paused from the evening, the clock without the night and one break reminder',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await studySettings(page, { idle_pause_minutes: 0, break_reminder_minutes: 0.05 });
      await openExample(page, 0);
      await page.waitForSelector('.break-reminder', { timeout: 10000 });
      const before = (await clock(page)).elapsed;
      await setHidden(page, true);
      // The night: the page was hidden 8 hours ago, the clock running since before then.
      await page.evaluate((h8) => {
        const ws = globalThis.ElectroTag.ws;
        ws._hiddenAt -= h8;
        ws.clock.runningSince -= h8; ws.clock.startedAt -= h8;
      }, 8 * HOUR_MS);
      // (a hidden page's timers wait: the pause may come only on return)
      await setHidden(page, false);
      const back = await clock(page);
      assert.equal(back.isPaused, true);
      assert.equal(back.reason, 'hidden');
      assert.ok(back.elapsed < before + 2, `the night is not counted (${before} s, then ${back.elapsed} s)`);
      assert.match((await page.textContent('.pause-panel')).replace(/\s+/g, ' '), /You were away for 8 h 00 min/);
      await page.click('.pause-panel [data-log="resume"]');
      await page.waitForTimeout(2000);
      const kinds = (await events(page)).map((e) => e.type);
      assert.equal(kinds.filter((k) => k === 'break_reminder').length, 1, 'the reminder came once, before the night');
      const resume = (await events(page)).find((e) => e.type === 'resume');
      assert.equal(resume.counts_as_break, true, 'the night counts as a break');
    },
  },
  // ========================================================= goals and games
  {
    name: 'the weekly goal: one change at a time, never repeated, and a late answer never brings back an older goal',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await page.click('[data-log="goal-set"]');
      await page.fill('.goal-input', '5');
      await page.click('[data-log="goal-save"]');
      await page.waitForFunction(() => /0 of 5/.test(document.querySelector('.games-goal')?.textContent || ''));
      // A slow answer: Save is pressed, then No goal while it waits.
      await slowDemo(page, 'setAchievements', [1500, 0]);
      await page.click('[data-log="goal-change"]');
      await page.fill('.goal-input', '8');
      await page.click('[data-log="goal-save"]');
      assert.equal(await page.isDisabled('[data-log="goal-clear"]'), true, 'No goal waits for the answer');
      assert.equal(await page.isDisabled('[data-log="goal-save"]'), true);
      await page.waitForFunction(() => /0 of 8/.test(document.querySelector('.games-goal')?.textContent || ''), null, { timeout: 10000 });
      assert.equal((await calls(page, 'setAchievements')).length, 1);
      // A change that fails is not repeated by itself.
      await slowDemo(page, 'setAchievements', 0, 'return { status: 0, code: "network", message: "The study server could not be reached." };');
      await page.click('[data-log="goal-change"]');
      await page.fill('.goal-input', '9');
      await page.click('[data-log="goal-save"]');
      await page.waitForSelector('.games-goal .error:not([hidden])');
      assert.match(await page.textContent('.games-goal .error'), /could not be reached/);
      await page.waitForTimeout(500);
      assert.equal((await calls(page, 'setAchievements')).length, 1, 'never repeated automatically');
      // A slow read of the facts and a change made while it waits: the change stays.
      const kept = await page.evaluate(async () => {
        const app = globalThis.ElectroTag;
        const b = app.backend;
        b.setAchievements = b.__orig.setAchievements;
        const read = b.achievements.bind(b);
        b.achievements = async () => { const old = await read(); await new Promise((r) => setTimeout(r, 800)); return old; };
        const loading = app.loadAchievements();
        await new Promise((r) => setTimeout(r, 100));
        await app.changeAchievements({ goal_per_week: 12 });
        await loading;
        return app.achievements.goal && app.achievements.goal.per_week;
      });
      assert.equal(kept, 12, 'the late read did not bring back the older goal');
      // Two changes at once (the goal, then the leaderboard) go one after the other; the last answer has both.
      const both = await page.evaluate(async () => {
        const app = globalThis.ElectroTag;
        const b = app.backend;
        const set = b.setAchievements.bind(b);
        const order = [];
        let n = 0;
        b.setAchievements = async (body) => { const i = n++; order.push(`start ${i}`); await new Promise((r) => setTimeout(r, i === 0 ? 600 : 0)); const out = await set(body); order.push(`end ${i}`); return out; };
        await Promise.all([app.changeAchievements({ goal_per_week: 6 }), app.changeAchievements({ leaderboard_hidden: true })]);
        return { order, goal: app.achievements.goal.per_week, hidden: app.achievements.leaderboard ? app.achievements.leaderboard.you.hidden : null };
      });
      assert.deepEqual(both.order, ['start 0', 'end 0', 'start 1', 'end 1'], 'one change at a time');
      assert.equal(both.goal, 6);
    },
  },
  // ================================================================ the admin area
  {
    name: 'admin: Progress and Find keep the newest answer; bulk actions report each item, run one at a time and survive moving away; Add several pressed twice',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1400, height: 900, url: `${t.base}#admin-progress` });
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin-progress');
      await page.waitForFunction(() => /As of/.test(document.querySelector('.admin-section[data-section="progress"] [role="status"]')?.textContent || ''));
      // Two answers out of order: the first (slow) one fails, the second (quick) one arrives first.
      await slowDemo(page, 'admin', 0, 'const [op, body] = args; if (op === "stats" && i === 0) return { status: 503, code: "unavailable", message: "Late failure" }; return null;');
      await page.evaluate(() => {
        const b = globalThis.ElectroTag.backend;
        const admin = b.admin;
        let n = 0;
        b.admin = async (op, body) => { if (op === 'stats' && n++ === 0) await new Promise((r) => setTimeout(r, 1200)); return admin(op, body); };
      });
      await page.selectOption('#progress-work', 'all');
      await page.selectOption('#progress-work', 'study');
      await page.waitForTimeout(1800);
      const progressText = await page.textContent('.admin-section[data-section="progress"]');
      assert.ok(!/Late failure/.test(progressText), 'the older request\'s failure does not cover the newer answer');
      assert.match(progressText, /As of/);

      // Find: the lists are read once however fast the person types, and a stale answer shows nothing.
      await slowDemo(page, 'admin', 900);
      await page.click('.admin-find-input');
      await page.keyboard.type('A0zz', { delay: 30 });
      await page.waitForSelector('.admin-find-list:not([hidden])', { timeout: 5000 });
      assert.match(await page.textContent('.admin-find-list'), /Nothing matches/);
      const reads = (await calls(page, 'admin')).map((c) => c[0]);
      assert.equal(reads.filter((op) => op === 'users_list').length, 1, `users_list read once: ${reads.join(', ')}`);
      await page.keyboard.press('Escape');

      // Bulk: the second of three fails half way; Retire again and Remove wait; the admin moves away and back.
      await slowDemo(page, 'admin', 0, 'const [op] = args; return op === "recording_update" && (globalThis.__updates = (globalThis.__updates || 0) + 1) === 2 ? { status: 409, code: "conflict", message: "Refused for the test." } : null;');
      await page.evaluate(() => {
        const b = globalThis.ElectroTag.backend;
        const admin = b.admin;
        b.admin = async (op, body) => { if (op === 'recording_update') await new Promise((r) => setTimeout(r, 500)); return admin(op, body); };
      });
      await page.locator('.admin-nav a', { hasText: 'Recordings' }).click();
      await waitForRoute(page, 'admin-recordings');
      const boxes = page.locator('.admin-section[data-section="recordings"] tbody input[type="checkbox"]');
      await boxes.first().waitFor();
      for (let i = 0; i < 3; i++) await boxes.nth(i).check();
      await page.click('[data-log="bulk-retire"]');
      await page.waitForFunction(() => /Retiring 1 of 3/.test(document.querySelector('.admin-section[data-section="recordings"]')?.textContent || ''));
      assert.equal(await asksBeforeLeaving(page), true, 'closing the page mid-run asks first');
      await page.click('[data-log="bulk-remove"]');
      assert.match(await page.textContent('.admin-section[data-section="recordings"] .bulk-bar'), /still running/);
      await page.locator('.admin-nav a', { hasText: 'Overview' }).click();
      await waitForRoute(page, 'admin');
      await page.waitForTimeout(1200);
      await page.locator('.admin-nav a', { hasText: 'Recordings' }).click();
      await waitForRoute(page, 'admin-recordings');
      await page.waitForSelector('.admin-section[data-section="recordings"] .bulk-result h3', { timeout: 10000 });
      const result = await page.innerText('.admin-section[data-section="recordings"] .bulk-result');
      assert.match(result, /Done for 2 of 3 recordings/);
      assert.match(result, /Not done[\s\S]*Refused for the test/);
      assert.equal(await asksBeforeLeaving(page), false, 'nothing asks once the run is over');
      const updates = (await calls(page, 'admin')).filter((c) => c[0] === 'recording_update').length;
      assert.equal(updates, 3, 'each recording asked once');

      // Add several, Create pressed twice: each account made once.
      await page.locator('.admin-nav a', { hasText: 'Annotators' }).click();
      await waitForRoute(page, 'admin-annotators');
      await slowDemo(page, 'admin', 300);
      await page.click('.admin-section[data-section="annotators"] .admin-tabs [data-tab="several"]');
      await page.fill('[data-log="several-text"]', 'P11, Pat One\nP12, Pat Two');
      await page.click('[data-log="several-check"]');
      await page.waitForSelector('[data-log="several-create"]:not([hidden])');
      await page.dblclick('[data-log="several-create"]');
      await page.evaluate(() => document.querySelector('[data-log="several-create"]').click());
      await page.waitForSelector('[data-panel="several"] h3', { timeout: 10000 });
      assert.match(await page.textContent('[data-panel="several"] h3'), /Created 2 of 2 accounts/);
      const adds = (await calls(page, 'admin')).filter((c) => c[0] === 'user_add').map((c) => c[1].annotator_id);
      assert.deepEqual(adds, ['P11', 'P12']);
    },
  },
  // ============================================================== open from a link
  {
    name: 'open from a link: Stop, a second press, leaving the page while it downloads, a cut connection and a file over 2 GB',
    async run(t) {
      const { assert } = t;
      const cloud = await awkwardService(syntheticEdfBytes(demoSpecs()[0]), { holdMs: 2500 });
      try {
        const page = await t.newPage({ width: 1440, height: 900 });
        await signIn(page, 'A01');
        await waitForRoute(page, 'home');
        await toOpenView(page);
        // Stop, and a second press while the first download runs.
        await page.fill('.link-panel textarea', `${cloud.base}/slow/${NAME}`);
        await page.click('[data-log="open-link"]');
        await page.waitForSelector('[data-log="stop-link"]:not([hidden])');
        await page.click('[data-log="open-link"]', { force: true }).catch(() => {});
        await page.click('[data-log="stop-link"]');
        await page.waitForSelector('.link-status .banner');
        assert.match(await page.textContent('.link-status'), /The download was stopped/);
        assert.equal(cloud.seen.filter((r) => r.path.startsWith('/slow/')).length, 1, 'one download for two presses');
        // Leaving the page while it downloads: nothing opens by itself later.
        await page.click('[data-log="open-link"]');
        await page.waitForSelector('[data-log="stop-link"]:not([hidden])');
        await page.click('main .back');
        await waitForRoute(page, 'home');
        await sleep(3500);
        assert.equal((await state(page)).route, 'home', 'the late file did not open a recording');
        assert.ok(cloud.seen.filter((r) => r.path.startsWith('/slow/')).every((r) => r.closedEarly), 'the download was stopped when the page was left');
        // While another recording is open, a late file from an earlier open view does not close it.
        await toOpenView(page);
        await page.fill('.link-panel textarea', `${cloud.base}/slow/${NAME}`);
        await page.evaluate(() => { globalThis.__late = globalThis.ElectroTag.openView; });
        await page.click('[data-log="open-link"]');
        await page.waitForSelector('[data-log="stop-link"]:not([hidden])');
        await page.click('main .back');
        await waitForRoute(page, 'home');
        await openExample(page, 1);
        const open = await page.evaluate(() => globalThis.ElectroTag.ws.s.recording.fileName);
        await page.evaluate(async () => { // a file that arrives for the view that was left
          const f = new File([new Uint8Array(10)], 'late.edf');
          await globalThis.__late.handle([f]);
        });
        await sleep(500);
        assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws && globalThis.ElectroTag.ws.s.recording.fileName), open, 'the open recording stays open');
        await page.click('[data-log="close"]');
        await clickDialogButton(page, 'Discard and close');
        await waitForRoute(page, 'home');
        // A connection that drops half way, and a file over 2 GB.
        await toOpenView(page);
        await page.fill('.link-panel textarea', `${cloud.base}/drop/${NAME}`);
        await page.click('[data-log="open-link"]');
        await page.waitForSelector('.link-status .banner', { timeout: 10000 });
        assert.match(await page.textContent('.link-status'), /interrupted|ended early/);
        await page.fill('.link-panel textarea', `${cloud.base}/huge/${NAME}`);
        await page.click('[data-log="open-link"]');
        await page.waitForSelector('.link-status .banner', { timeout: 10000 });
        assert.match(await page.textContent('.link-status'), /too large to open from a link \(3\.2 GB; at most 2\.1 GB\)|too large to open from a link/);
        assert.equal((await state(page)).route, 'open');
      } finally {
        await cloud.close();
      }
    },
  },
  // ============================================================== the device's store
  {
    name: 'device: a write that fails half way leaves nothing; two tabs keep one copy; a copy open in another tab is not removed',
    async run(t) {
      const { assert } = t;
      const bytes = syntheticEdfBytes(demoSpecs()[0]);
      const cloud = await cloudService(bytes);
      const p = await profile(t, { init: fullAtTheEnd });
      try {
        const a = await p.open();
        await signIn(a, 'A01');
        await waitForRoute(a, 'home');
        // The device fills up as the copy's description is written: what was written is removed.
        await a.evaluate(() => { globalThis.__fullAtTheEnd = true; });
        await a.click('[data-log="open-next"]');
        await waitForRoute(a, 'open');
        await a.fill('.link-panel textarea', `${cloud.base}/cors/${NAME}`);
        await a.click('[data-log="open-link"]');
        await waitForRoute(a, 'annotate', 30000);
        await a.waitForSelector('.dialog.device-full', { timeout: 20000 });
        await clickDialogButton(a, 'OK');
        assert.deepEqual(await keptList(a), []);
        assert.deepEqual(await opfsFiles(a), [], 'nothing of the half-written copy is left');
        await a.evaluate(() => { globalThis.__fullAtTheEnd = false; });
        await a.click('[data-log="close"]');
        await clickDialogButton(a, 'Discard and close');
        await waitForRoute(a, 'home');

        // Two tabs open the same link at once and both keep it: one copy, whole.
        const b = await p.open();
        await signIn(b, 'A01');
        await waitForRoute(b, 'home');
        for (const pg of [a, b]) {
          await pg.click('[data-log="open-next"]');
          await waitForRoute(pg, 'open');
          await pg.fill('.link-panel textarea', `${cloud.base}/cors/${NAME}`);
        }
        await Promise.all([a.click('[data-log="open-link"]'), b.click('[data-log="open-link"]')]);
        await Promise.all([waitForRoute(a, 'annotate', 30000), waitForRoute(b, 'annotate', 30000)]);
        await waitFor(async () => (await keptList(a)).length === 1 && (await opfsFiles(a)).length === 2, 'one kept copy');
        const sha = (await keptList(a))[0].sha256;
        const whole = await a.evaluate(async (hx) => {
          const { deviceStore } = await import('./js/views/device.js');
          const got = await deviceStore(globalThis.ElectroTag).open(hx);
          return got && got.files[0].size;
        }, sha);
        assert.equal(whole, bytes.length);
        // Tab A saves it; tab B leaves.
        await mark(a, 3.0, 3.4);
        await pressSave(a);
        await clickDialogButton(a, 'Save and Finish');
        await a.waitForSelector('.dialog .dialog-title');
        await clickDialogButton(a, 'Back to my recordings');
        await waitForRoute(a, 'home');
        await b.click('[data-log="close"]');
        await clickDialogButton(b, 'Discard and close');
        await waitForRoute(b, 'home');

        // Tab A revises the finished recording from its kept copy; tab B removes finished recordings.
        await a.click('.rec-tabs [data-tab="history"]');
        await a.locator('.recordings-card table.history tbody tr').first().locator('button', { hasText: 'Open to revise' }).click();
        await waitForRoute(a, 'annotate', 30000);
        await waitForTraces(a);
        assert.equal(await a.evaluate(() => globalThis.ElectroTag.ws.s.recording.source.kind), 'device');
        await sleep(300);
        await b.evaluate(() => globalThis.ElectroTag.loadAssignments().then(() => globalThis.ElectroTag.showHome()));
        await b.click('.device-line [data-log="device-manage"]');
        await b.waitForSelector('.dialog.device');
        await b.click('[data-log="device-remove-finished"]');
        await b.click('[data-log="device-confirm-yes"]');
        await b.waitForSelector('.device-in-use');
        assert.match(await b.textContent('.device-in-use'), /One recording is open in this or another tab or window, so it was kept/);
        assert.equal((await keptList(b)).length, 1);
        // Tab A reads on: its file can still be read, and the next screen draws.
        const readable = await a.evaluate(async () => {
          const f = globalThis.ElectroTag.ws.s.recording.sourceFiles[0];
          try { return (await f.slice(f.size - 64, f.size).arrayBuffer()).byteLength; } catch (e) { return `${e.name}: ${e.message}`; }
        });
        assert.equal(readable, 64, 'the open recording\'s file is still there');
        await a.keyboard.press('ArrowRight');
        await a.waitForTimeout(500);
        assert.equal(await a.evaluate(() => globalThis.ElectroTag.ws.viewer.stats.traceMs > 0), true);
        // Once tab A has left the revision, the copy can go.
        await a.click('.ws-revision [data-log="leave-revision"]');
        await waitForRoute(a, 'home');
        await b.click('[data-log="device-remove-finished"]');
        await b.click('[data-log="device-confirm-yes"]');
        await b.waitForSelector('.device-empty');
        assert.deepEqual(await opfsFiles(b), []);
      } finally {
        await cloud.close();
        await p.close();
      }
    },
  },
  // ================================================================ the home list
  {
    name: 'the home list with 300 recordings: drawn quickly, paged, and searched without a wait at each key',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await page.evaluate((n) => {
        const b = globalThis.ElectroTag.backend;
        const s = b._admin.s;
        for (let i = 0; i < n; i++) {
          const id = `p${String(i).padStart(4, '0')}`;
          const rid = `sub-${id}/eeg/sub-${id}_task-rest_eeg.edf`;
          s.recordings.push({ scope: 'study', recording_id: rid, file_name: `sub-${id}_task-rest_eeg.edf`, format: 'edf', sfreq: 100, n_samples: 6000 + i,
            n_channels: 4, size_bytes: 50000 + i, sha256: `${String(i).padStart(64, '0')}`, registered_at: '2026-10-01T09:00:00+00:00', registered_by: 'test',
            registered_via: 'admin', notes: '', retired: false, warnings: [],
            manifest: { recording_id: rid, file_name: `sub-${id}_task-rest_eeg.edf`, format: 'edf', files: { stem: `sub-${id}_task-rest` },
              timing: { sfreq: 100, n_samples: 6000 + i }, ch_names: ['Fp1', 'Fp2', 'Cz', 'O1'] } });
          s.assignments.push({ annotator_id: 'A01', recording_id: rid, mode: 'standard', context_id: '', at: '2026-10-01T09:00:00+00:00' });
          if (i % 3 === 0) {
            const key = b._key('A01', rid, 'standard', '');
            const saved = new Date(Date.now() - i * 3600000).toISOString();
            b.state.submissions.push({ key, annotator_id: 'A01', recording_id: rid, mode: 'standard', context_id: '', attempt: 1, saved_at: saved,
              annotations: [], session: { elapsed_s: 300 }, sha256: '', recording: null, guided: null, feedback: null, revision: null });
            b.state.done[key] = { saved_at: saved, attempt: 1 };
          }
        }
        b._save();
      }, 300);
      const timing = await page.evaluate(async () => {
        const app = globalThis.ElectroTag;
        await app.loadAssignments();
        const t0 = performance.now();
        app.showHome();
        const home = performance.now() - t0;
        const tab = document.querySelector('.rec-tabs [data-tab="all"]');
        const t1 = performance.now();
        tab.click();
        const tabMs = performance.now() - t1;
        // A key in the search field: the list is drawn again once typing pauses (150 ms); how long that drawing takes.
        const search = document.querySelector('.rec-search');
        const body = document.querySelector('.rec-body');
        const keys = [];
        for (const q of ['p', 'p0', 'p01', 'p012', 'p01']) {
          search.value = q;
          const t2 = performance.now();
          search.dispatchEvent(new Event('input'));
          const keyMs = performance.now() - t2;
          const drawn = await new Promise((r) => {
            const obs = new MutationObserver(() => { obs.disconnect(); r(performance.now()); });
            obs.observe(body, { childList: true, subtree: true });
          });
          keys.push({ keyMs, drawMs: drawn - t2 - 150 });
        }
        return { home, tabMs, keys, items: app.assignments.items.length };
      });
      assert.ok(timing.items >= 300, JSON.stringify(timing));
      console.log(`     home list, ${timing.items} recordings: home ${timing.home.toFixed(1)} ms, tab ${timing.tabMs.toFixed(1)} ms, `
        + `key/redraw ${timing.keys.map((k) => `${k.keyMs.toFixed(1)}/${k.drawMs.toFixed(1)}`).join(' ')} ms`);
      assert.ok(timing.home < 300, `the home page drew in ${timing.home} ms`);
      assert.ok(timing.tabMs < 100, `a tab drew in ${timing.tabMs} ms`);
      for (const k of timing.keys) {
        assert.ok(k.keyMs < 20, `a key took ${k.keyMs} ms`);
        assert.ok(k.drawMs < 100, `the list drew again in ${k.drawMs} ms after typing paused`);
      }
      // Paging: 25 rows a page, and the search keeps to the matches.
      await page.fill('.rec-search', '');
      await page.waitForFunction(() => /1 to 25 of 30\d/.test(document.querySelector('.rec-pager')?.textContent || ''));
      assert.match(await page.textContent('.rec-pager'), /1 to 25 of \d+/);
      await page.click('[data-log="recordings-next"]');
      assert.match(await page.textContent('.rec-pager'), /26 to 50 of \d+/);
      await page.fill('.rec-search', 'p0299');
      await page.waitForFunction(() => document.querySelectorAll('.recordings-card tbody tr').length === 1);
    },
  },
  // ================================================================ invitations
  {
    name: 'an expired invitation link says so and leads to signing in',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 800, url: `${t.base}#admin-annotators` });
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin-annotators');
      const token = await page.evaluate(async () => {
        const b = globalThis.ElectroTag.backend;
        const out = await b.admin('user_add', { annotator_id: 'X41', display_name: 'Exp', role: 'annotator', invite: true, expires_days: 1 });
        b._admin._invites.X41.expires_ms = Date.now() - 1000;
        b._save();
        return out.invite_token || String(out.invite_link || '').split('invite=')[1];
      });
      const other = await page.context().newPage();
      await other.goto(`${t.base}?invite=${token}`);
      await other.waitForSelector('.invite-card[data-invite="problem"]');
      assert.match(await other.innerText('.invite-card'), /expired/);
      // whom to ask for a new link, since signing in needs the password the link would have set
      assert.match(await other.innerText('.invite-card'), /contact the study team who invited you/);
      assert.equal(await other.locator('.invite-card button.primary', { hasText: 'Go to sign in' }).count(), 0, 'signing in is not offered as the way forward');
      assert.equal(await other.locator('[data-log="invite-retry"]').count(), 0, 'an expired link is not tried again');
      await other.click('.invite-card button:has-text("Go to sign in")');
      await other.waitForSelector('form.signin-form');
    },
  },
  {
    name: 'study server: an invitation checked late, unreachable once, then accepted late with the button pressed twice',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const admin = await adminLogin(t);
      const made = await adminCall(t, admin, 'user_add', { annotator_id: 'Q51', display_name: 'Quinn', role: 'annotator', invite: true, expires_days: 7 });
      const link = made.invite_link || `${t.study.base}?invite=${made.invite_token}`;
      assert.match(link, /\?invite=/);
      const page = await t.newPage({ url: null, width: 1280, height: 800 });
      const seen = { check: 0, accept: 0 };
      await page.route('**/api/v1/invite/check', async (route) => {
        seen.check += 1;
        if (seen.check === 1) { await route.abort('connectionrefused'); return; }
        await sleep(2000);
        await route.continue();
      });
      await page.route('**/api/v1/invite/accept', async (route) => {
        seen.accept += 1;
        await sleep(2500);
        await route.continue();
      });
      await page.goto(link);
      // The study could not be reached: the link is kept, and Try again asks again.
      await page.waitForSelector('.invite-card[data-invite="unreachable"]', { timeout: 20000 });
      assert.match(await page.innerText('.invite-card'), /could not be checked[\s\S]*could not be reached/);
      await page.click('[data-log="invite-retry"]');
      await page.waitForSelector('main.loading, .page.loading');
      assert.match(await page.textContent('body'), /Checking your invitation/);
      await page.waitForSelector('.invite-card[data-invite="welcome"]', { timeout: 20000 });
      assert.match(await page.innerText('.invite-card'), /Q51/);
      await page.fill('#invite-password', 'quinn chooses this');
      await page.fill('#invite-password-again', 'quinn chooses this');
      await page.click('.invite-form button[type="submit"]');
      await page.waitForFunction(() => document.querySelector('.invite-form button[type="submit"]')?.disabled);
      await page.click('.invite-form button[type="submit"]', { force: true }).catch(() => {});
      await page.press('#invite-password-again', 'Enter').catch(() => {});
      await page.waitForFunction(() => Boolean(document.querySelector('.dialog.logging-notice'))
        || (globalThis.ElectroTag && globalThis.ElectroTag.route !== 'signin'), null, { timeout: 30000 });
      const notice = page.locator('.dialog.logging-notice button', { hasText: 'Continue' });
      if (await notice.count()) await notice.click();
      await answerQuestionnaire(page); // the person's first sign-in: the sign-up questionnaire comes first
      await waitForRoute(page, 'home', 20000);
      assert.equal(seen.accept, 1, 'the password was set with one request');
      assert.equal(seen.check, 2);
    },
  },
];
