// Comfort for long sessions: Pause (the button, the key B, by itself after a while without input and
// when the page is out of sight) with the paused time left out of the working time, the break
// reminder, the parts of the recording viewed (on the overview bar, Next part not yet viewed and the
// check before Save and Finish), resuming a draft where it was left, the annotator's progress on the
// home page, the study's settings in the admin area, display comfort, a pause in guided training,
// and the Pause button on an iPad.
import { clickDialogButton, drag, eegPoint, openExample, pressSave, signIn, state, waitForRoute, waitForTraces } from './helpers.mjs';

/** Change the demonstration's study settings (annotation block) and read GET /me again. */
async function studySettings(page, annotation) {
  await page.evaluate(async (a) => {
    const app = globalThis.ElectroClean;
    Object.assign(app.backend._admin.s.settings.annotation, a);
    app.backend._save();
    await app.refreshMe();
  }, annotation);
}

/** Every event logged in this visit so far. */
async function events(page) {
  return page.evaluate(async () => {
    await globalThis.ElectroClean.flushLog();
    return globalThis.ElectroClean.backend.resultsDocument().interaction_logs.flatMap((l) => l.events);
  });
}

/** The working-time clock: worked, paused in all, and the wall-clock time since it started (seconds). */
async function clock(page) {
  return page.evaluate(() => {
    const c = globalThis.ElectroClean.ws.clock;
    return { elapsed: c.elapsedS, paused: c.pausedTotalS, wall: (c.now() - c.startedAt) / 1000, isPaused: c.paused, sinceBreak: c.sinceBreakS };
  });
}

const panelShown = (page) => page.waitForSelector('.pause-panel:not([hidden])', { timeout: 10000 });
const panelHidden = (page) => page.waitForSelector('.pause-panel', { state: 'hidden', timeout: 10000 });

/** Pretend the page is hidden (another tab, the iPad locked) or shown again. */
async function setHidden(page, hidden) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { value: h, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/** The colour of a pixel of the overview bar, at a fraction of its width, `y` pixels from the top. */
async function overviewPixel(page, fraction, y) {
  return page.evaluate(([f, yy]) => {
    const c = globalThis.ElectroClean.ws.viewer.overviewCanvas;
    const dpr = window.devicePixelRatio || 1;
    const d = c.getContext('2d').getImageData(Math.floor(c.width * f), Math.floor(yy * dpr), 1, 1).data;
    return `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  }, [fraction, y]);
}

export const tests = [
  {
    name: 'pause by the button, the key, after a while without input and with the page out of sight: the time is not counted',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1600, height: 950 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await studySettings(page, { idle_pause_minutes: 0.05, break_reminder_minutes: 0 });
      await openExample(page, 0);
      await page.waitForTimeout(800);

      // The button: a calm panel over the EEG, the clock stopped, the keys asleep.
      await page.click('[data-log="pause"]');
      await panelShown(page);
      const atPause = await clock(page);
      assert.ok(atPause.isPaused && atPause.elapsed > 0.5, JSON.stringify(atPause));
      const panel = (await page.textContent('.pause-panel')).replace(/\s+/g, ' ');
      assert.match(panel, /Paused/);
      assert.match(panel, /Time worked on this recording: \d+ s\./);
      await page.waitForFunction(() => /Your draft is saved/.test(document.querySelector('.pause-draft').textContent));
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.log), 'resume', 'Resume has the focus');
      assert.equal(await page.getAttribute('[data-log="pause"]', 'aria-pressed'), 'true');
      await page.keyboard.press('3');
      assert.equal((await state(page)).currentLabel, 'Eye-blink-artifact', 'keys other than B do nothing while paused');
      await page.waitForTimeout(1500);
      const later = await clock(page);
      assert.ok(Math.abs(later.elapsed - atPause.elapsed) < 0.01, 'the clock is stopped');
      assert.match(await page.textContent('.pause-away'), /Paused for \d+ s; that time is not counted\./);
      await t.screenshot(page, 'comfort_paused');
      await page.click('[data-log="resume"]');
      await panelHidden(page);
      assert.match(await page.textContent('.ws-message'), /Welcome back\. The \d+ s you were paused were not counted\./);
      assert.ok(await page.evaluate(() => document.activeElement === globalThis.ElectroClean.ws.viewer.over), 'the EEG has the focus again');

      // The key B pauses and resumes.
      await page.keyboard.press('b');
      await panelShown(page);
      await page.keyboard.press('b');
      await panelHidden(page);

      // Three seconds without any input (the study's 0.05 minutes).
      await panelShown(page);
      assert.match(await page.textContent('.pause-reason'), /paused itself after 3 seconds without any input/);
      await page.waitForFunction(() => /^You were away for \d+ s; that time is not counted\.$/.test(document.querySelector('.pause-away').textContent));
      await page.click('[data-log="resume"]');
      await panelHidden(page);

      // The page out of sight for longer than the limit (shortened here from 10 s).
      await page.evaluate(() => { globalThis.ElectroClean.ws.hiddenPauseMs = 300; });
      await setHidden(page, true);
      await page.waitForTimeout(1300);
      await setHidden(page, false);
      await panelShown(page);
      assert.match(await page.textContent('.pause-reason'), /while the page was out of sight/);
      assert.match(await page.textContent('.pause-away'), /You were away for \d+ s; that time is not counted\./);
      await page.click('[data-log="resume"]');
      await panelHidden(page);
      // A short look away does not pause.
      await setHidden(page, true);
      await page.waitForTimeout(100);
      await setHidden(page, false);
      assert.equal((await clock(page)).isPaused, false);

      const c = await clock(page);
      assert.ok(c.paused > 3, `paused ${c.paused} s in all`);
      assert.ok(Math.abs(c.elapsed + c.paused - c.wall) < 0.05, 'worked and paused make up the time the recording was open');
      const ev = await events(page);
      assert.deepEqual(ev.filter((e) => e.type === 'pause').map((e) => e.reason), ['button', 'key', 'idle', 'hidden']);
      const resumes = ev.filter((e) => e.type === 'resume');
      assert.deepEqual(resumes.map((e) => e.via), ['button', 'key', 'button', 'button']);
      assert.ok(resumes[0].paused_s >= 1.4 && resumes[0].reason === 'button', JSON.stringify(resumes[0]));
      assert.ok(ev.find((e) => e.type === 'pause' && e.reason === 'idle').idle_s >= 2.9);
      assert.ok(ev.find((e) => e.type === 'pause' && e.reason === 'hidden').hidden_s >= 0.3);

      // The draft and the saved result keep the time without the pauses.
      const draft = await page.evaluate(() => globalThis.ElectroClean.ws.s.draftPayload());
      assert.ok(draft.elapsed_s <= c.wall - c.paused + 0.2, `draft ${draft.elapsed_s} s`);
      await pressSave(page);
      await clickDialogButton(page, 'Save with no artifacts');
      await waitForRoute(page, 'home');
      const sub = await page.evaluate(() => globalThis.ElectroClean.backend.state.submissions[0]);
      assert.ok(sub.session.elapsed_s < c.wall - 3, `saved ${sub.session.elapsed_s} s of ${c.wall} s open`);
      const finished = (await events(page)).find((e) => e.type === 'recording_finished');
      assert.equal(finished.n_pauses, 4);
      assert.ok(finished.paused_s > 3 && finished.viewed_fraction > 0 && finished.viewed_fraction < 1, JSON.stringify(finished));
      await clickDialogButton(page, 'Back to my recordings');
    },
  },
  {
    name: 'the break reminder offers a break or a reminder in 15 minutes, without stopping the work',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1600, height: 950 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await studySettings(page, { idle_pause_minutes: 0, break_reminder_minutes: 0.05 });
      await openExample(page, 0);
      await page.waitForSelector('.break-reminder', { timeout: 10000 });
      assert.match(await page.textContent('.break-reminder'), /You have worked for \d seconds since your last break/);
      await t.screenshot(page, 'comfort_break_reminder');
      // Work goes on while it is shown.
      await page.keyboard.press('3');
      assert.equal((await state(page)).currentLabel, 'EMG-artifact');
      await page.click('[data-log="break-later"]');
      assert.equal(await page.locator('.break-reminder').count(), 0);
      const snoozed = await page.evaluate(() => { const k = globalThis.ElectroClean.ws.clock; return k.remindAtS - k.sinceBreakS; });
      assert.ok(snoozed > 890 && snoozed <= 900, `asks again after ${snoozed} s`);
      // Fifteen minutes later (brought forward here), Take a break pauses.
      await page.evaluate(() => { const k = globalThis.ElectroClean.ws.clock; k.remindAtS = k.sinceBreakS + 1; });
      await page.waitForSelector('.break-reminder', { timeout: 10000 });
      await page.click('[data-log="break-take"]');
      await panelShown(page);
      assert.match(await page.textContent('.pause-reason'), /Enjoy your break/);
      await page.click('[data-log="resume"]');
      await panelHidden(page);
      assert.ok((await clock(page)).sinceBreak < 1, 'the work since the break counts from now');
      const ev = await events(page);
      assert.equal(ev.filter((e) => e.type === 'break_reminder').length, 2);
      assert.deepEqual(ev.filter((e) => e.type === 'break_reminder_closed').map((e) => e.choice), ['remind_later', 'take_break']);
      assert.ok(ev.some((e) => e.type === 'pause' && e.reason === 'break'));
      assert.ok(ev.some((e) => e.type === 'resume' && e.counts_as_break === true));
    },
  },
  {
    name: 'the parts viewed: the overview bar, Next part not yet viewed, the check before Save and Finish, and fast drawing',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1600, height: 950 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await studySettings(page, { idle_pause_minutes: 0, break_reminder_minutes: 0 });
      await openExample(page, 0); // 70 s, 10 s on the screen
      await page.waitForFunction(() => globalThis.ElectroClean.ws.s.viewed.length === 1);
      let viewed = await page.evaluate(() => globalThis.ElectroClean.ws.s.viewed);
      assert.deepEqual(viewed, [[0, 10]]);
      assert.match(await page.textContent('.ws-viewed'), /^Viewed 14 %/);
      // On the overview bar: the rest white with a thin grey line above it (calm: no warning colour).
      assert.equal(await overviewPixel(page, 0.9, 1), '#BDB8B0');
      assert.equal(await overviewPixel(page, 0.9, 12), '#FFFFFF');
      // Recording a view redraws the overview only.
      await waitForTraces(page);
      await page.evaluate(() => { const ws = globalThis.ElectroClean.ws; ws.viewer.stats.layers = null; ws.viewer.setCoverage(ws.s.viewed); });
      await page.waitForFunction(() => globalThis.ElectroClean.ws.viewer.stats.layers);
      assert.deepEqual(Object.keys(await page.evaluate(() => globalThis.ElectroClean.ws.viewer.stats.layers)), ['overview']);

      // U and the button show the next part not yet viewed.
      await page.keyboard.press('u');
      let v = (await state(page)).view;
      assert.equal(v.startS, 9, 'the next part, with a second of what was seen before it');
      assert.match(await page.textContent('.ws-message'), /Not yet viewed: 0:10 to 1:10\. This is the last such part\./);
      await page.waitForFunction(() => globalThis.ElectroClean.ws.s.viewed[0][1] === 19);
      // What has been seen, away from the view, keeps the overview's warm grey.
      assert.equal(await overviewPixel(page, 0.05, 12), '#F3EFE8');
      await page.click('.tab[data-tab="recording"]');
      assert.match(await page.textContent('.coverage-text'), /Viewed 27 % of the recording/);
      await t.screenshot(page, 'comfort_coverage_tab');
      await page.click('.coverage-block [data-log="next-unviewed"]');
      v = (await state(page)).view;
      assert.equal(v.startS, 18);
      await page.waitForFunction(() => globalThis.ElectroClean.ws.s.viewed[0][1] === 28);
      // An unviewed part in the middle: the next one comes round from wherever the view is.
      await page.evaluate(() => globalThis.ElectroClean.ws.viewer.setView({ startS: 50 }, 'key'));
      await page.waitForFunction(() => globalThis.ElectroClean.ws.s.viewed.length === 2);
      viewed = await page.evaluate(() => globalThis.ElectroClean.ws.s.viewed);
      assert.deepEqual(viewed, [[0, 28], [50, 60]]);
      await page.keyboard.press('u');
      assert.equal((await state(page)).view.startS, 60, 'after the view comes 60 to 70 s, which just fits on the screen');
      // The draft keeps them.
      await page.waitForFunction(() => {
        const ws = globalThis.ElectroClean.ws;
        const d = JSON.parse(localStorage.getItem(ws.s.localKey) || 'null');
        return d && d.viewed && d.viewed.some(([a, b]) => a <= 50 && b >= 70);
      });

      // Save and Finish lists what has not been on the screen, and goes to the first part.
      await page.click('.ws-actions button.primary');
      await page.waitForSelector('.dialog.coverage-check');
      const text = (await page.textContent('.dialog.coverage-check')).replace(/\s+/g, ' ');
      assert.match(text, /You have viewed 68 % of this recording\. This part has not been on the screen yet:/);
      assert.match(text, /0:28 to 0:50 \(22 s\)/);
      await t.screenshot(page, 'comfort_coverage_check');
      await clickDialogButton(page, 'Go to the first');
      assert.equal(await page.locator('.dialog').count(), 0, 'nothing is saved');
      assert.equal((await state(page)).view.startS, 27);
      await page.waitForFunction(() => globalThis.ElectroClean.ws.s.viewed.length === 2 && globalThis.ElectroClean.ws.s.viewed[0][1] === 37);
      // With everything seen, Save and Finish asks its own question straight away.
      await page.evaluate(() => { const ws = globalThis.ElectroClean.ws; ws.s.noteViewed([[0, 70]]); ws.viewer.setCoverage(ws.s.viewed); ws._refreshCoverage(); });
      assert.match(await page.textContent('.ws-viewed'), /^Viewed 100 %/);
      await page.keyboard.press('u');
      assert.match(await page.textContent('.ws-message'), /Every part of the recording has been on the screen\./);
      await page.click('.ws-actions button.primary');
      await page.waitForSelector('.dialog');
      assert.equal(await page.locator('.dialog.coverage-check').count(), 0);
      await clickDialogButton(page, 'Keep annotating');
      const ev = await events(page);
      const check = ev.find((e) => e.type === 'coverage_check');
      assert.equal(check.choice, 'goto');
      assert.equal(check.n_unviewed, 1);
      assert.ok(ev.filter((e) => e.type === 'next_unviewed').length >= 3);
    },
  },
  {
    name: 'a draft opens where it was left: the view, the parts viewed, a welcome back and the time the draft was kept',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1600, height: 950 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await studySettings(page, { idle_pause_minutes: 0, break_reminder_minutes: 0 });
      await openExample(page, 1);
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
      // Somewhere else, with more time, fewer channels and larger traces.
      for (const key of ['End', 'PageUp', '+']) await page.keyboard.press(key);
      await page.evaluate(() => globalThis.ElectroClean.ws.viewer.setView({ startS: 24, firstChannel: 3 }, 'key'));
      const before = (await state(page)).view;
      await page.waitForSelector('.ws-saved:not(:empty)');
      assert.match(await page.textContent('.ws-saved'), /^Draft saved \d\d:\d\d$/);
      await page.waitForFunction(() => globalThis.ElectroClean.ws.s.viewed.some(([a, b]) => a <= 24 && b >= 24 + globalThis.ElectroClean.ws.viewer.view.durationS));
      const viewed = await page.evaluate(() => globalThis.ElectroClean.ws.s.viewed);
      await page.click('[data-log="close"]');
      await clickDialogButton(page, 'Close and finish later');
      await waitForRoute(page, 'home');

      // The home page offers to continue, with what it knows of the draft.
      assert.match(await page.textContent('.next-card h2'), /Continue where you left off/);
      const facts = await page.textContent('.continue-facts');
      assert.match(facts, /viewed \d+ %/);
      assert.match(facts, /1 annotation\b/);
      assert.match(facts, /kept today at \d\d:\d\d/);
      await t.screenshot(page, 'comfort_home_continue');
      await page.click('[data-log="open-next"]');
      await waitForRoute(page, 'open');
      await page.locator('.example-card button').click();
      await clickDialogButton(page, 'Restore and continue');
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      const after = (await state(page)).view;
      for (const k of ['startS', 'durationS', 'firstChannel', 'nChannels', 'scaleFactor']) assert.equal(after[k], before[k], `${k} restored`);
      assert.deepEqual(await page.evaluate(() => globalThis.ElectroClean.ws.s.viewed.slice(0, 2)), viewed.slice(0, 2), 'the parts viewed are restored');
      const welcome = await page.textContent('.welcome-back');
      assert.match(welcome, /^Welcome back\. You were at 0:24, channels \S+ to \S+, with 1 annotation kept and \d+ s worked so far\.$/);
      assert.match(await page.textContent('.ws-message'), /^Welcome back/);
      await t.screenshot(page, 'comfort_welcome_back');
      const opened = (await events(page)).filter((e) => e.type === 'recording_opened').pop();
      assert.equal(opened.resumed, true);
      assert.ok(opened.viewed_fraction > 0 && opened.elapsed_restored_s > 0, JSON.stringify(opened));
    },
  },
  {
    name: 'the home page: done of assigned, the time worked, today and an estimate of the time left',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1600, height: 950 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await studySettings(page, { idle_pause_minutes: 0, break_reminder_minutes: 0, coverage_check: 'off' });
      assert.match(await page.textContent('.progress-card'), /0 of 3\s*recordings done/);
      assert.match(await page.textContent('.progress-card .card-head'), /0 % done/);
      assert.match(await page.textContent('[data-stat="left"]'), /Not estimated yet.*after your first 2 recordings/);
      for (const i of [0, 1]) {
        await openExample(page, i);
        await page.waitForTimeout(1200);
        await page.click('.ws-actions button.primary');
        await clickDialogButton(page, 'Save with no artifacts');
        await waitForRoute(page, 'home');
        await page.locator('.dialog-buttons button', { hasText: 'Back to my recordings' }).click();
      }
      const items = await page.evaluate(async () => (await globalThis.ElectroClean.backend.assignments()).items);
      const done = items.filter((i) => i.status === 'done');
      assert.equal(done.length, 2);
      for (const i of done) {
        assert.ok(i.elapsed_s > 1 && i.n_annotations === 0 && i.completed_at, JSON.stringify(i));
      }
      assert.match(await page.textContent('.progress-card .card-head'), /67 % done/);
      assert.equal(await page.textContent('[data-stat="worked"] .stat-value'), 'Under a minute');
      assert.equal(await page.textContent('[data-stat="worked"] .caption'), 'worked in all; under a minute per recording (median)');
      // Two quick recordings: the one left takes a few seconds at this pace (progress.test.mjs checks the sums).
      assert.match(await page.textContent('[data-stat="left"]'), /Nearly done.*judged from 2 recordings/);
      assert.match(await page.textContent('[data-stat="today"]'), /Today: no work yet in this browser, 2 recordings finished\./);
      assert.equal(await page.getAttribute('.progress-card [role="progressbar"]', 'aria-valuenow'), '2');
      // Today's time in this browser, once there is a minute of it.
      await page.evaluate(() => {
        const who = globalThis.ElectroClean.me.annotator_id;
        const d = new Date(); const p = (n) => String(n).padStart(2, '0');
        localStorage.setItem(`electroclean.worked|${who}|${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, '3900');
        globalThis.ElectroClean.showHome();
      });
      assert.match(await page.textContent('[data-stat="today"]'), /Today: 1 h 5 min of work in this browser, 2 recordings finished\./);
      await t.screenshot(page, 'comfort_home_progress');
    },
  },
  {
    name: 'the study settings for long sessions in the admin area, and the annotator\'s display comfort',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => /^admin/.test(globalThis.ElectroClean.route || ''));
      await page.evaluate(() => globalThis.ElectroClean.showAdmin('admin-settings'));
      await page.waitForSelector('.admin-section[data-section="settings"] input[name="break_reminder_minutes"]');
      assert.equal(await page.inputValue('input[name="break_reminder_minutes"]'), '50');
      assert.equal(await page.inputValue('input[name="idle_pause_minutes"]'), '3');
      const section = '.admin-section[data-section="settings"]';
      assert.match(await page.textContent(section), /Long sessions/);
      await page.fill('input[name="idle_pause_minutes"]', '90');
      await page.click('[data-log="settings-save"]');
      await page.waitForSelector(`${section} .error-banner`);
      assert.match(await page.textContent(`${section} .error-banner`), /Pause after: enter a number between 0 and 60/);
      await page.fill('input[name="idle_pause_minutes"]', '5');
      await page.fill('input[name="break_reminder_minutes"]', '45');
      await page.locator(`${section} label.check`, { hasText: 'list the parts of the recording' }).locator('input').uncheck();
      await page.click('[data-log="settings-save"]');
      await page.waitForFunction((s) => /The settings are saved/.test(document.querySelector(`${s} > .admin-msg`)?.textContent || ''), section);
      await page.locator(`${section} h3`, { hasText: 'Long sessions' }).scrollIntoViewIfNeeded();
      await t.screenshot(page, 'comfort_admin_settings');
      const me = await page.evaluate(async () => (await globalThis.ElectroClean.backend.me()).study.annotation);
      assert.equal(me.idle_pause_minutes, 5);
      assert.equal(me.break_reminder_minutes, 45);
      assert.equal(me.coverage_check, 'off');

      // An annotator's display comfort, kept in this browser.
      await page.click('[data-log="sign-out"]');
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      assert.equal(await page.evaluate(() => globalThis.ElectroClean.ws.settings.coverageCheck), 'off');
      await page.click('.tab[data-tab="recording"]');
      await page.check('input[data-comfort="trace:thick"]');
      await page.check('input[data-comfort="names:large"]');
      await page.check('input[data-comfort="panel:large"]');
      assert.deepEqual(await page.evaluate(() => globalThis.ElectroClean.ws.viewer.comfort), { trace: 'thick', names: 'large' });
      assert.ok(await page.evaluate(() => document.querySelector('.ws-side').classList.contains('large-text')));
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.tab-panel[data-panel="recording"]')).fontSize), '16px');
      await page.waitForTimeout(200);
      await t.screenshot(page, 'comfort_display');
      const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('electroclean.comfort|A01')));
      assert.deepEqual(kept, { trace: 'thick', names: 'large', panel: 'large' });
      assert.ok((await events(page)).some((e) => e.type === 'state' && e.comfort && e.comfort.trace === 'thick'));
    },
  },
  {
    name: 'guided training pauses too, and a step\'s time leaves the pause out',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1600, height: 950 });
      await signIn(page, 'T01');
      await waitForRoute(page, 'training');
      await page.locator('main.training .btn.primary').click();
      await waitForRoute(page, 'open');
      await page.locator('.example-card button').click();
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      await page.waitForSelector('.coach-title');
      await page.click('[data-log="pause"]');
      await panelShown(page);
      assert.ok(await page.evaluate(() => document.querySelector('.ws-side').inert), 'the coach waits behind the panel');
      await page.waitForTimeout(2000);
      await page.click('[data-log="resume"]');
      await panelHidden(page);
      await page.locator('.coach button', { hasText: 'Show me' }).click();
      await page.waitForFunction(() => /This is how the experts marked it/.test(document.querySelector('.coach')?.textContent || ''));
      const wall = await page.evaluate(() => (performance.now() - globalThis.ElectroClean.ws.coach.stepT0) / 1000);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => /Step 2 of/.test(document.querySelector('.coach-header')?.textContent || ''));
      const step = (await events(page)).find((e) => e.type === 'guided_step_completed');
      assert.ok(step.seconds < wall - 1.8, `the step took ${step.seconds} s of ${wall} s`);
      const kept = await page.evaluate(() => Object.values(globalThis.ElectroClean.backend.state.guided).find((g) => g.seconds && g.seconds[0] !== undefined).seconds[0]);
      assert.ok(kept < wall - 1.8, `the study keeps ${kept} s`);
    },
  },
  {
    name: 'on an iPad: Pause and Resume by touch, and Next part not yet viewed in the row of touch buttons',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 820, height: 1180, ipad: true });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await studySettings(page, { idle_pause_minutes: 0, break_reminder_minutes: 0 });
      await openExample(page, 0);
      const pause = await page.locator('[data-log="pause"]').boundingBox();
      assert.ok(pause.height >= 40, `the Pause button is ${pause.height} px high`);
      await page.tap('[data-log="pause"]');
      await panelShown(page);
      const resume = await page.locator('[data-log="resume"]').boundingBox();
      assert.ok(resume.height >= 44 && resume.width >= 120, JSON.stringify(resume));
      assert.equal(await page.locator('.pause-key').count(), 0, 'no key to mention on a touch screen');
      // The panel covers the EEG and the panels below it, upright.
      const box = await page.locator('.pause-panel').boundingBox();
      const main = await page.locator('.ws-main').boundingBox();
      assert.ok(Math.abs(box.height - main.height) < 1 && Math.abs(box.width - main.width) < 1);
      await t.screenshot(page, 'comfort_ipad_paused');
      await page.tap('[data-log="resume"]');
      await panelHidden(page);
      await page.waitForFunction(() => globalThis.ElectroClean.ws.s.viewed.length === 1);
      await page.tap('[data-log="touch-next-unviewed"]');
      assert.equal((await state(page)).view.startS, 9);
      await t.screenshot(page, 'comfort_ipad_after');
      // On its side, the panel covers the EEG and the side panel beside it.
      await page.setViewportSize({ width: 1180, height: 820 });
      await page.tap('[data-log="pause"]');
      await panelShown(page);
      await t.screenshot(page, 'comfort_ipad_paused_landscape');
      await page.tap('[data-log="resume"]');
      await panelHidden(page);
    },
  },
];
