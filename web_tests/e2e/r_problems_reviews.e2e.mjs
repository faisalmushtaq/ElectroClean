// Problem reports and reviews of saved work: an annotator reports a problem with a recording from
// the home page or the annotation view (noted, or set aside as one that cannot be annotated), the
// report is kept once however often it is pressed or sent again after a late answer, and the
// administrator deals with it in Problems; an administrator reviews a saved recording in the
// read-only annotation view (keys, a missed stretch, a review saved once), and the annotator sees
// the feedback beside their annotations and while revising. In the demonstration, on the real
// study server (the files stay untouched), and on an iPad by touch.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clickDialogButton, drag, eegPoint, openExample, pressSave, signIn, waitForRoute, waitForTraces } from './helpers.mjs';

const PASSWORD = 'electrotag';

async function mark(page, from, to) {
  await page.keyboard.press('1');
  await drag(page, await eegPoint(page, from), await eegPoint(page, to));
}

async function events(page) {
  await page.evaluate(() => globalThis.ElectroTag.flushLog());
  return page.evaluate(() => [...globalThis.ElectroTag.backend.visits.values()].flatMap((v) => v.events));
}

/** Sign out and in as someone else (the demonstration keeps its state in this browser). */
async function switchTo(page, id, password = 'demo') {
  await page.evaluate(async () => { await globalThis.ElectroTag.signOut(); });
  const leave = page.locator('.dialog-buttons button', { hasText: /Keep|Sign out/ });
  if (await leave.count()) await leave.first().click();
  await signIn(page, id, password);
}

/** The admin area's section `route`, once the area has opened after signing in. */
async function toAdmin(page, route) {
  await page.waitForFunction(() => /^admin/.test(globalThis.ElectroTag.route || '') && globalThis.ElectroTag.adminArea);
  await page.waitForSelector('.admin-main .admin-section');
  await page.evaluate((r) => globalThis.ElectroTag.showAdmin(r), route);
  await page.waitForSelector(`.admin-main [data-section="${route.replace(/^admin-?/, '') || 'overview'}"]`);
}

/** Choose the reason and outcome in the report's dialog, write the note and send it. */
async function fillReport(page, { reason = 'bad_channels', note = '', outcome = 'noted' } = {}) {
  await page.waitForSelector('.dialog.problem-dialog');
  await page.check(`.problem-dialog input[data-reason="${reason}"]`);
  if (note) await page.fill('.problem-dialog textarea.problem-note', note);
  await page.check(`.problem-dialog input[data-outcome="${outcome}"]`);
  await clickDialogButton(page, 'Send the report');
}

async function rowMenu(page, fileName, item) {
  await page.locator('.recordings-card tr', { hasText: fileName }).locator('button.row-more').click();
  await page.locator('.menu .menu-item', { hasText: item }).click();
}

/** Slow down a method of the demonstration's backend (and count its calls in globalThis.__calls). */
async function slowDemo(page, name, ms, { loseFirstAnswer = false } = {}) {
  await page.evaluate(([n, wait, lose]) => {
    const b = globalThis.ElectroTag.backend;
    globalThis.__calls = globalThis.__calls || {};
    globalThis.__calls[n] = 0;
    const orig = b[n].bind(b);
    b[n] = async (...args) => {
      globalThis.__calls[n] += 1;
      await new Promise((r) => setTimeout(r, wait));
      const out = await orig(...args);
      // The study kept it, but its answer never arrived (a dropped connection, a function that stopped).
      if (lose && globalThis.__calls[n] === 1) { const e = new Error('The study could not be reached.'); e.status = 0; e.code = 'network'; throw e; }
      return out;
    };
  }, [name, ms, loseFirstAnswer]);
}

const calls = (page, name) => page.evaluate((n) => (globalThis.__calls || {})[n] || 0, name);
const demoState = (page) => page.evaluate(() => JSON.parse(JSON.stringify(globalThis.ElectroTag.backend.state)));

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

async function api(t, token, method, p, body) {
  const res = await fetch(`${t.study.base}api/v1${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-ElectroTag': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok && !(p.endsWith('user_add') && res.status === 409)) throw new Error(`${p}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const login = async (t, id) => (await api(t, null, 'POST', '/login', { annotator_id: id, password: PASSWORD })).token;

/** The review pass: N to the first annotation, A to agree, a caveat with a note on the next, and a dragged stretch. */
async function reviewSome(page, { note = 'Starts a little early' } = {}) {
  await page.waitForSelector('.review-pass');
  await page.evaluate(() => globalThis.ElectroTag.ws.viewer.over.focus());
  await page.keyboard.press('n');
  await page.keyboard.press('a');
  await page.keyboard.press('n');
  await page.keyboard.press('c');
  await page.keyboard.press('Enter');
  await page.keyboard.type(note);
  await page.evaluate(() => globalThis.ElectroTag.ws.viewer.over.focus());
  await drag(page, await eegPoint(page, 7.0), await eegPoint(page, 8.0));
}

export const tests = [
  {
    name: 'a problem reported from the home page is kept once, sets the recording aside, and the study team gives it back',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      const first = await page.evaluate(() => globalThis.ElectroTag.assignments.items[0]);
      // The study keeps the report, but its answer is lost: Try again sends the same report, kept once.
      await slowDemo(page, 'reportProblem', 600, { loseFirstAnswer: true });
      await rowMenu(page, first.file_name, 'Report a problem');
      await fillReport(page, { reason: 'bad_channels', note: 'Two channels show no signal', outcome: 'unusable' });
      // pressed again while the first report waits: nothing more opens
      await page.locator('.recordings-card tr', { hasText: first.file_name }).locator('button.row-more').click();
      assert.equal(await page.locator('.dialog.problem-dialog').count(), 0);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.dialog .dialog-title:text("The report was not sent")', { timeout: 10000 });
      await clickDialogButton(page, 'Try again');
      await page.waitForSelector('.dialog .dialog-title:text("Thank you")', { timeout: 10000 });
      await clickDialogButton(page, 'OK');
      assert.equal(await calls(page, 'reportProblem'), 2);
      const st = await demoState(page);
      assert.equal(Object.keys(st.problems).length, 1, 'one report, however often it was sent');
      await page.waitForFunction(() => globalThis.ElectroTag.assignments.items[0].status === 'unusable');
      // finished for the annotator's progress, kept apart from done
      assert.match(await page.textContent('.progress-card [data-stat="done"]'), /^1 of 3.*could not be annotated/);
      await page.click('.rec-tabs [data-tab="done"]');
      const row = page.locator('.recordings-card tr', { hasText: first.file_name });
      assert.match(await row.textContent(), /Cannot be annotated/);
      assert.match(await row.textContent(), /Set aside: channels are flat, missing/);
      // the interaction log has the reason and the outcome, and the note's length only
      const ev = (await events(page)).filter((e) => e.type === 'problem_reported');
      assert.equal(ev.length, 1);
      assert.equal(ev[0].reason, 'bad_channels');
      assert.equal(ev[0].outcome, 'unusable');
      assert.equal(ev[0].note_length, 'Two channels show no signal'.length);
      const holding = (await events(page)).filter((e) => JSON.stringify(e).includes('Two channels show no signal'));
      assert.deepEqual(holding.map((e) => e.type), [], 'the note is never logged');
      await t.screenshot(page, 'problem_home_set_aside');

      // the administrator: Problems, under Data, with the report; the recording goes back to the list
      await switchTo(page, 'ADMIN');
      await toAdmin(page, 'admin-problems');
      await page.waitForSelector('[data-section="problems"] tbody tr');
      assert.match(await page.textContent('[data-section="problems"] tbody'), /Channels are flat/);
      assert.match(await page.textContent('[data-section="problems"] .stat-tiles'), /1\s*Open reports/);
      await t.screenshot(page, 'problems_section');
      await page.selectOption('[data-section="problems"] .problem-filters select >> nth=1', 'too_noisy');
      assert.match(await page.textContent('[data-section="problems"] .admin-table'), /No reports match/);
      await page.selectOption('[data-section="problems"] .problem-filters select >> nth=1', '');
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-log="problems-csv"]')]);
      const csv = fs.readFileSync(await download.path(), 'utf-8');
      assert.match(csv.split('\r\n')[0], /^"problem_id","reported_at","annotator_id"/);
      assert.match(csv, /"Two channels show no signal"/);
      await page.click('[data-log="problem-open"]');
      await page.fill('[data-section="problems"] .admin-stack input.field', 'Replaced the file');
      await page.click('[data-log="problem-return"]');
      await page.waitForSelector('[data-section="problems"] .success');
      const o = await page.evaluate(() => globalThis.ElectroTag.backend.admin('overview', {}));
      assert.equal(o.counts.unusable, 0);

      await switchTo(page, 'A01');
      await waitForRoute(page, 'home');
      assert.match(await page.textContent('.returned-line'), /gave .* back to your list after your report: Replaced the file/);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.assignments.items[0].status), 'todo');
    },
  },
  {
    name: 'a problem reported from the annotation view: told and carried on, or set aside, which closes the recording',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 720 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 1);
      await mark(page, 3.0, 3.4);
      assert.equal(await page.locator('.ws-header button.primary').count(), 1, 'one black button');
      await page.click('[data-log="ws-more"]');
      await page.locator('.menu .menu-item', { hasText: 'Report a problem' }).click();
      await fillReport(page, { reason: 'too_noisy', outcome: 'noted' });
      await clickDialogButton(page, 'OK');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.route), 'annotate', 'carried on');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.size), 1);
      await page.click('[data-log="ws-more"]');
      await page.locator('.menu .menu-item', { hasText: 'Report a problem' }).click();
      await fillReport(page, { reason: 'wrong_recording', outcome: 'unusable' });
      await clickDialogButton(page, 'OK');
      await waitForRoute(page, 'home');
      const st = await demoState(page);
      const reports = Object.values(st.problems);
      assert.deepEqual(reports.map((r) => r.where), ['annotate', 'annotate']);
      assert.ok(Object.values(st.unusable).some((m) => m.active));
      // opening it again says it is set aside
      const it = await page.evaluate(() => globalThis.ElectroTag.assignments.items[1]);
      assert.equal(it.status, 'unusable');
    },
  },
  {
    name: 'an administrator reviews saved work in the read-only viewer; the review is saved once and the annotator sees it',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await mark(page, 2.0, 2.4);
      await mark(page, 5.0, 5.6);
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 15000 });
      await clickDialogButton(page, 'Back to my recordings');
      await waitForRoute(page, 'home');
      const saved = (await demoState(page)).submissions[0];

      await switchTo(page, 'ADMIN');
      await toAdmin(page, 'admin-results');
      await page.locator('[data-section="results"] tr', { hasText: 'A01' }).locator('button', { hasText: 'Work' }).click();
      await page.locator('[data-log="review-start"]').first().click();
      await waitForRoute(page, 'admin-review');
      assert.match(await page.textContent('h1'), /^Review /);
      await page.locator('button[data-log^="example-"]').click();
      await waitForRoute(page, 'admin-review');
      await page.waitForSelector('.review-pass');
      await waitForTraces(page);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.readOnly), true);
      assert.equal(await page.locator('.ws-toolbar').count(), 0, 'no annotation tools');
      assert.equal(await page.locator('.ws-header button.primary').count(), 1);
      await reviewSome(page);
      assert.match(await page.textContent('.review-progress'), /2 of 2 annotations marked, 1 stretch without an annotation/);
      const marks = await page.evaluate(() => globalThis.ElectroTag.ws.viewer.markers.length);
      assert.equal(marks, 3);
      await t.screenshot(page, 'review_pass');
      // The overlay (O) works in the review mode too: the marks stay, and the review's keys still answer.
      await page.evaluate(() => globalThis.ElectroTag.ws.viewer.over.focus());
      await page.keyboard.press('o');
      assert.equal(await page.evaluate(() => Boolean(globalThis.ElectroTag.ws.viewer.overlay)), true);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.viewer.markers.length), 3);
      await t.screenshot(page, 'review_pass_overlay');
      await page.keyboard.press('p');
      await page.keyboard.press('m');
      assert.match(await page.textContent('.review-progress'), /2 of 2 annotations marked/);
      await page.keyboard.press('a');
      await page.keyboard.press('o');
      assert.equal(await page.evaluate(() => Boolean(globalThis.ElectroTag.ws.viewer.overlay)), false);
      // Save the review pressed twice while a slow study answers: one review.
      await slowDemo(page, 'admin', 1200);
      await page.click('[data-log="review-save"]');
      await page.click('[data-log="review-save"]', { force: true });
      await page.waitForSelector('.dialog .dialog-title:text("Review saved")', { timeout: 15000 });
      const st = await demoState(page);
      assert.equal(st.reviews.length, 1);
      assert.deepEqual(st.reviews[0].counts, { agree: 1, caveat: 1, comment: 1, missed: 1 });
      assert.equal(st.reviews[0].items[1].note, 'Starts a little early');
      assert.equal(st.reviews[0].items[2].note, 'missed artifact?');
      assert.deepEqual(st.submissions[0].annotations, saved.annotations, 'the saved annotations are as they were');
      await clickDialogButton(page, 'OK');
      await waitForRoute(page, 'admin-results');

      // The annotator: the history says so, and the feedback opens beside the annotations.
      await switchTo(page, 'A01');
      await waitForRoute(page, 'home');
      await page.click('.rec-tabs [data-tab="history"]');
      const row = page.locator('.recordings-card table.history tr', { hasText: saved.recording.file_name });
      assert.match(await row.textContent(), /Reviewed: 1 caveat, 1 comment, 1 agreement/);
      await rowMenu(page, saved.recording.file_name, 'See the feedback');
      await waitForRoute(page, 'open');
      await page.locator('button[data-log^="example-"]').click();
      await page.waitForSelector('.feedback-panel');
      await waitForTraces(page);
      assert.equal(await page.locator('.feedback-row').count(), 3);
      assert.match(await page.textContent('.feedback-panel'), /Starts a little early/);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.readOnly), true);
      await page.keyboard.press('n');
      assert.equal(await page.locator('.feedback-row.current').count(), 1);
      await t.screenshot(page, 'feedback_view');
      // Open to revise: the notes stay in the side panel while revising.
      await page.click('[data-log="feedback-revise"]');
      await page.waitForSelector('.ws-revision');
      await page.waitForSelector('.feedback-panel');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.readOnly), false);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.size), 2);
      const ev = (await events(page)).map((e) => e.type);
      assert.ok(ev.includes('feedback_shown') && ev.includes('revision_started'));
      await t.screenshot(page, 'feedback_while_revising');
    },
  },
  {
    name: 'blind reviews: the annotator sees nothing of them; switched off, the Review button goes',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'ADMIN');
      await page.evaluate(async () => {
        const b = globalThis.ElectroTag.backend;
        await b.admin('settings_update', { settings: { annotation: { show_reviews_to_annotators: false } } });
      });
      await switchTo(page, 'A01');
      await waitForRoute(page, 'home');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.reviews), null);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.me.study.annotation.show_reviews_to_annotators), false);
    },
  },
  {
    name: 'on an iPad: the report and the review pass by touch',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1180, height: 820, ipad: true });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      const first = await page.evaluate(() => globalThis.ElectroTag.assignments.items[2]);
      await page.locator('.recordings-card tr', { hasText: first.file_name }).locator('button.row-more').tap();
      await page.locator('.menu .menu-item', { hasText: 'Report a problem' }).tap();
      await page.waitForSelector('.dialog.problem-dialog');
      const box = await page.locator('.problem-dialog .problem-option').first().boundingBox();
      assert.ok(box.height >= 24, 'a reason is easy to tap');
      await t.screenshot(page, 'ipad_problem_dialog');
      await page.locator('.problem-dialog input[data-reason="file_wont_open"]').tap();
      await page.locator('.dialog-buttons button', { hasText: 'Send the report' }).tap();
      await page.waitForSelector('.dialog .dialog-title:text("Thank you")');
      await page.locator('.dialog-buttons button', { hasText: 'OK' }).tap();
      // the review pass: the marks are buttons a finger can reach
      await openExample(page, 0);
      await mark(page, 2.0, 2.4);
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 15000 });
      await clickDialogButton(page, 'Back to my recordings');
      await switchTo(page, 'ADMIN');
      await page.waitForFunction(() => /^admin/.test(globalThis.ElectroTag.route || '') && globalThis.ElectroTag.adminArea);
      await page.waitForSelector('.admin-main .admin-section');
      await page.evaluate(() => globalThis.ElectroTag.startReview({ annotator_id: 'A01', recording_id: globalThis.ElectroTag.backend.state.submissions[0].recording_id }));
      await waitForRoute(page, 'admin-review');
      await page.locator('button[data-log^="example-"]').tap();
      await page.waitForSelector('.review-pass');
      await waitForTraces(page);
      const seg = page.locator('.review-row .seg[data-status="caveat"]').first();
      const sb = await seg.boundingBox();
      assert.ok(sb.height >= 40, `a mark is at least 40 px high on a touch screen (${sb.height})`);
      await seg.tap();
      assert.equal(await seg.getAttribute('aria-pressed'), 'true');
      await t.screenshot(page, 'ipad_review_pass');
      await page.locator('[data-log="review-save"]').tap();
      await page.waitForSelector('.dialog .dialog-title:text("Review saved")', { timeout: 15000 });
    },
  },
  {
    name: 'on the study server: a report from the home page, a review of a saved recording with the file from this computer, the files untouched',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const admin = await login(t, 'ADMIN');
      await api(t, admin, 'POST', '/admin/user_add', { annotator_id: 'P01', display_name: 'Reporter', password: PASSWORD });
      await api(t, admin, 'POST', '/admin/assign', { annotator_ids: ['P01'], all: true });
      const page = await t.newPage({ url: t.study.base });
      await signIn(page, 'P01', PASSWORD);
      await waitForRoute(page, 'home');
      const file = 'sub-003_task-rest_eeg.edf';
      const other = await page.evaluate((f) => globalThis.ElectroTag.assignments.items.find((i) => i.file_name !== f).file_name, file);
      await rowMenu(page, other, 'Report a problem');
      await fillReport(page, { reason: 'file_wont_open', note: 'Says it is damaged', outcome: 'unusable' });
      await clickDialogButton(page, 'OK');
      await page.waitForFunction((f) => globalThis.ElectroTag.assignments.items.find((i) => i.file_name === f).status === 'unusable', other);
      const list = await api(t, admin, 'POST', '/admin/problems_list', { annotator_id: 'P01' });
      assert.equal(list.problems.length, 1);
      assert.equal(list.problems[0].unusable_now, true);

      // P01 saves sub-003; ADMIN reviews it in the browser with the file from this computer.
      await page.locator('.recordings-card tr', { hasText: file }).locator('button', { hasText: 'Open' }).click();
      await waitForRoute(page, 'open');
      await page.setInputFiles('input[data-log="file-input"]', filesFor(t.study.dir, file));
      await waitForRoute(page, 'annotate', 30000);
      await waitForTraces(page);
      await mark(page, 3.0, 3.4);
      await mark(page, 5.0, 5.5);
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 30000 });
      // "Back to my recordings", or OK when that was the last recording left to do
      await page.locator('.dialog-buttons button', { hasText: /Back to my recordings|^OK$/ }).first().click();
      const folder = path.join(t.study.dir, 'study', 'Annotated_Events', 'annotator-P01', 'sub-003', 'eeg');
      const before = checksums(folder);
      assert.equal(Object.keys(before).length, 5);

      const reviewer = await t.newPage({ url: t.study.base });
      await signIn(reviewer, 'ADMIN', PASSWORD);
      await reviewer.waitForFunction(() => /^admin/.test(globalThis.ElectroTag.route || ''));
      await reviewer.evaluate(() => globalThis.ElectroTag.showAdmin('admin-annotators', { annotator: 'P01' }));
      await reviewer.waitForSelector('[data-log="review-start"]');
      await reviewer.click('[data-log="review-start"]');
      await waitForRoute(reviewer, 'admin-review');
      // the wrong file first: refused, as its fingerprint differs
      await reviewer.setInputFiles('input[data-log="file-input"]', filesFor(t.study.dir, 'sub-001_task-rest_eeg.vhdr'));
      await reviewer.waitForSelector('.result .banner', { timeout: 30000 });
      assert.match(await reviewer.textContent('.result'), /fingerprint differs/);
      await reviewer.setInputFiles('input[data-log="file-input"]', filesFor(t.study.dir, file));
      await reviewer.waitForSelector('.review-pass', { timeout: 30000 });
      await waitForTraces(reviewer);
      await reviewSome(reviewer, { note: 'Ends late' });
      await reviewer.click('[data-log="review-save"]');
      await reviewer.waitForSelector('.dialog .dialog-title:text("Review saved")', { timeout: 15000 });
      await clickDialogButton(reviewer, 'OK');
      await waitForRoute(reviewer, 'admin-annotators');
      await reviewer.waitForSelector('[data-section="annotators"] .admin-stack h2:text("Reviews of this person\'s work")');
      const reviews = await api(t, admin, 'POST', '/admin/reviews_list', { annotator_id: 'P01' });
      assert.equal(reviews.reviews.length, 1);
      assert.equal(reviews.reviews[0].summary, '1 caveat, 1 comment, 1 agreement');
      assert.deepEqual(checksums(folder), before, 'the annotation files are never changed by a review');

      // the annotator's history says so
      await page.evaluate(() => globalThis.ElectroTag.reloadHome());
      await page.click('.rec-tabs [data-tab="history"]');
      assert.match(await page.locator('.recordings-card table.history tr', { hasText: file }).textContent(), /Reviewed: 1 caveat/);
      const zip = await api(t, admin, 'POST', '/admin/results_zip', {});
      const names = Buffer.from(zip.base64, 'base64').toString('latin1');
      assert.ok(names.includes('problem_reports/problem_reports.tsv') && names.includes('reviews/annotator-P01/'), 'the results zip holds them');
    },
  },
];
