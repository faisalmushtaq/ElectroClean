// Corrections of saved work and replays of sessions (docs/web/using.md, "Correcting saved work",
// "Corrections of your work" and "Replaying a session"): A01 saves a recording; E01 opens it from Saved
// work in the expert area, changes, removes and adds marks with the original as dashed outlines, gives
// a reason for each change (refused without them) and submits the correction once; A01 sees the
// changes and their reasons beside their own version; and E01 replays A01's session, which plays back
// to the saved version. In the demonstration, and on the real study server with the files from this
// computer, where the original files stay untouched and the correction is a derived version.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clickDialogButton, drag, eegPoint, openExample, pressSave, signIn, state, waitForRoute, waitForTraces } from './helpers.mjs';

const PASSWORD = 'electrotag';

async function mark(page, from, to, key = '1') {
  await page.keyboard.press(key);
  await drag(page, await eegPoint(page, from), await eegPoint(page, to));
}

async function events(page) {
  await page.evaluate(() => globalThis.ElectroTag.flushLog());
  return page.evaluate(() => [...globalThis.ElectroTag.backend.visits.values()].flatMap((v) => v.events));
}

async function switchTo(page, id, password = 'demo') {
  await page.evaluate(async () => { await globalThis.ElectroTag.signOut(); });
  const leave = page.locator('.dialog-buttons button', { hasText: /Keep|Sign out/ });
  if (await leave.count()) await leave.first().click();
  await signIn(page, id, password);
}

/** E01 in Saved work: the row of `who`'s work, and its Correct or Replay button. */
async function fromSavedWork(page, who, button) {
  // signed in, and the first view shown (home, or the expert area)
  await page.waitForFunction(() => { const a = globalThis.ElectroTag; return a && a.me && a.isExpert && /^(home|expert)/.test(a.route || ''); }, null, { timeout: 30000 });
  await page.evaluate(() => globalThis.ElectroTag.showExpert('expert-work'));
  await page.waitForSelector('[data-section="work"] tbody tr');
  const row = page.locator('[data-section="work"] tbody tr', { hasText: who }).first();
  await row.locator(`button[data-log="work-${button}"]`).click();
}

/** Change the first mark's type (2), delete the second (Delete) and add one (1, a drag): three changes. */
async function makeChanges(page, at) {
  await page.evaluate(() => globalThis.ElectroTag.ws.viewer.over.focus());
  await page.keyboard.press('n');
  await page.keyboard.press('2');
  await page.keyboard.press('n');
  await page.keyboard.press('Delete');
  await mark(page, at, at + 0.5);
  await page.waitForFunction(() => globalThis.ElectroTag.ws.pass.changes.length === 3);
}

/** The reasons, by the chips; a note on the first. */
async function giveReasons(page, note) {
  const rows = page.locator('.correction-row');
  for (let i = 0; i < 3; i++) {
    const kind = await rows.nth(i).getAttribute('data-change');
    const reason = { added: 'missed', removed: 'not_artifact', changed: 'wrong_type' }[kind];
    await rows.nth(i).locator(`[data-reason="${reason}"]`).click();
  }
  await rows.nth(0).locator('input.review-note').fill(note);
}

async function playToTheEnd(page) {
  await page.waitForSelector('.replay-panel');
  await page.waitForFunction(() => globalThis.ElectroTag.ws && globalThis.ElectroTag.ws.pass && globalThis.ElectroTag.ws.pass.timeline, null, { timeout: 30000 });
  await page.evaluate(() => globalThis.ElectroTag.ws.viewer.over.focus());
  for (let i = 0; i < 4; i++) await page.keyboard.press('=');
  await page.keyboard.press(' ');
  await page.waitForSelector('.replay-end:not([hidden])', { timeout: 60000 });
  return page.textContent('.replay-end');
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

async function api(t, token, method, p, body) {
  const res = await fetch(`${t.study.base}api/v1${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-ElectroTag': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok && !(p.endsWith('user_add') && res.status === 409)) throw new Error(`${p}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function checksums(folder) {
  if (!fs.existsSync(folder)) return {};
  return Object.fromEntries(fs.readdirSync(folder).sort().map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, f))).digest('hex')]));
}

export const tests = [
  {
    name: 'A01 saves, E01 corrects with a reason for each change, A01 sees the changes, and the replay plays back to the saved version',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await mark(page, 2.0, 2.4);
      await page.keyboard.press('Escape');
      await mark(page, 5.0, 5.6);
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 15000 });
      await clickDialogButton(page, 'Back to my recordings');
      await waitForRoute(page, 'home');
      const saved = (await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.ElectroTag.backend.state)))).submissions[0];
      assert.equal(saved.annotations.length, 2);
      assert.equal(saved.session.session_id.length, 32, 'the session\'s ID goes with the save');

      // E01: Saved work, Correct, the file (the example), the original as a dashed layer
      await switchTo(page, 'E01');
      await fromSavedWork(page, 'A01', 'correct');
      await waitForRoute(page, 'expert-correct');
      assert.match(await page.textContent('h1'), /^Correct /);
      await t.screenshot(page, 'correction_open_view');
      await page.locator('button[data-log^="example-"]').click();
      await page.waitForSelector('.correction-pass');
      await waitForTraces(page);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.readOnly), false);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.size), 2);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.viewer.layers[0].annotations.length), 2);
      assert.equal(await page.locator('.ws-header button.primary').count(), 1, 'one black button: Submit the correction');
      await makeChanges(page, 7.0);
      assert.match(await page.textContent('.correction-progress'), /3 changes \(1 added, 1 removed, 1 changed\), 3 without a reason/);
      // L hides the original, and shows it again
      await page.evaluate(() => globalThis.ElectroTag.ws.viewer.over.focus());
      await page.keyboard.press('l');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.viewer.layers[0].visible), false);
      await page.keyboard.press('l');
      // Submit without reasons: refused here, the rows outlined
      await page.click('[data-log="correction-submit"]');
      await page.waitForSelector('.correction-row.needs-reason');
      assert.equal(await page.locator('.correction-row.needs-reason').count(), 3);
      assert.equal(await page.locator('.dialog').count(), 0);
      await t.screenshot(page, 'correction_reasons_missing');
      // J and K move between the changes
      await page.evaluate(() => globalThis.ElectroTag.ws.viewer.over.focus());
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.pass.current), 0, 'the first change without a reason is the current one');
      await page.keyboard.press('j');
      await page.keyboard.press('j');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.pass.current), 2);
      await page.keyboard.press('k');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.pass.current), 1);
      await giveReasons(page, 'Eyes, not muscle');
      assert.match(await page.textContent('.correction-progress'), /each with its reason/);
      assert.equal(await page.locator('.correction-row.needs-reason').count(), 0);
      await t.screenshot(page, 'correction_pass');
      // pressed twice while the study answers slowly: one correction
      await page.evaluate(() => {
        const b = globalThis.ElectroTag.backend;
        const orig = b.expert.bind(b);
        globalThis.__saves = 0;
        b.expert = async (op, body) => { if (op === 'correction_save') { globalThis.__saves += 1; await new Promise((r) => setTimeout(r, 800)); } return orig(op, body); };
      });
      await page.click('[data-log="correction-submit"]');
      await clickDialogButton(page, 'Submit the correction');
      await page.click('[data-log="correction-submit"]', { force: true });
      await page.waitForSelector('.dialog .dialog-title:text("Correction saved")', { timeout: 15000 });
      assert.equal(await page.evaluate(() => globalThis.__saves), 1);
      await clickDialogButton(page, 'OK');
      await waitForRoute(page, 'expert-work');
      await page.waitForSelector('[data-section="work"] tbody tr .chip');
      assert.match(await page.textContent('[data-section="work"] tbody'), /1 correction/);
      await t.screenshot(page, 'saved_work');
      const st = await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.ElectroTag.backend.state)));
      assert.equal(st.corrections.length, 1);
      assert.deepEqual(st.submissions[0].annotations, saved.annotations, 'the original is never changed');
      assert.deepEqual(st.corrections[0].changes.map((c) => c.reason).sort(), ['missed', 'not_artifact', 'wrong_type']);
      const ev = await events(page);
      const reasons = ev.filter((e) => e.type === 'correction_reason_set');
      assert.ok(reasons.length >= 3 && reasons.some((e) => e.note_length === 'Eyes, not muscle'.length));
      assert.deepEqual(ev.filter((e) => JSON.stringify(e).includes('Eyes, not muscle')).map((e) => e.type), [], 'the note is never logged');
      assert.ok(ev.some((e) => e.type === 'correction_started') && ev.some((e) => e.type === 'correction_submitted' && e.added === 1));
      // the correction opened with A01's two marks: a snapshot of them, so that a replay of it starts from them
      const snap = ev.find((e) => e.type === 'annotations_snapshot' && e.reason === 'correction');
      assert.ok(snap && snap.annotations.length === 2 && snap.n_parts === 1);

      // E01 replays A01's session: it plays back to the saved version
      await fromSavedWork(page, 'A01', 'replay');
      await waitForRoute(page, 'expert-replay');
      await page.locator('button[data-log^="example-"]').click();
      const end = await playToTheEnd(page);
      assert.match(end, /The replay matches the saved version 1/);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.size), 2, 'the annotations built up as they were made');
      await page.keyboard.press('Home');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.size), 0, 'back at the start');
      await page.keyboard.press('>');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.size), 1, 'the first change');
      assert.match(await page.textContent('.replay-caption'), /Created Eye-blink-artifact|Created /);
      await t.screenshot(page, 'replay_player');
      await page.click('.ws-header button.back');
      await waitForRoute(page, 'expert-work');
      const watched = (await events(page)).map((e) => e.type);
      assert.ok(watched.includes('replay_opened') && watched.includes('replay_closed') && watched.includes('replay_control'));

      // A01: the history says so, and the changes open beside their own version
      await switchTo(page, 'A01');
      await waitForRoute(page, 'home');
      await page.click('.rec-tabs [data-tab="history"]');
      await page.waitForSelector('.corrected-line');
      assert.match(await page.textContent('.corrected-line'), /Corrected by .*: 3 changes/);
      await t.screenshot(page, 'history_corrected');
      await page.click('.corrected-line');
      await waitForRoute(page, 'open');
      await page.locator('button[data-log^="example-"]').click();
      await page.waitForSelector('.correction-feedback');
      await waitForTraces(page);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.readOnly), true);
      assert.equal(await page.locator('.correction-feedback-row').count(), 3);
      assert.match(await page.textContent('.correction-feedback'), /Eyes, not muscle/);
      assert.match(await page.textContent('.correction-feedback'), /Missed artifact/);
      await page.keyboard.press('n');
      assert.equal(await page.locator('.correction-feedback-row.current').count(), 1);
      await t.screenshot(page, 'correction_feedback');
      const seen = (await events(page)).map((e) => e.type);
      assert.ok(seen.includes('correction_feedback_shown') && seen.includes('correction_feedback_item_jumped'));
      assert.equal((await state(page)).route, 'annotate');
    },
  },
  {
    name: 'a trainee watches an expert who agreed to it: Watch an expert at work, and the replay of the expert\'s session',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'ADMIN');
      await page.evaluate(() => globalThis.ElectroTag.backend.admin('assign', { annotator_ids: ['E01'], all: true }));
      await switchTo(page, 'E01');
      await page.evaluate(() => globalThis.ElectroTag.showHome());
      await waitForRoute(page, 'home');
      await openExample(page, 1);
      await mark(page, 3.0, 3.6);
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 15000 });
      await page.locator('.dialog-buttons button', { hasText: /Back to my recordings|^OK$/ }).first().click();
      // T01 sees nothing to watch until E01 agrees: Watch an expert at work appears on Learn with the experts, on the
      // training path, once that stage is open and there is a session to watch
      await switchTo(page, 'T01');
      await page.evaluate(async () => { for (const stage of ['tour', 'snippets']) await globalThis.ElectroTag.backend.trainingStage({ stage, action: 'skip' }); });
      await page.evaluate(() => globalThis.ElectroTag.showTraining());
      await waitForRoute(page, 'training');
      await page.waitForSelector('[data-stage="guided"][data-status="available"]');
      await page.waitForTimeout(300); // the study is asked what there is to watch
      assert.equal(await page.locator('[data-stage="guided"] .watch-entry').count(), 0, 'nothing to watch yet: no way in');
      assert.equal(await page.evaluate(async () => { try { await globalThis.ElectroTag.backend.expert('replay_index_get', { annotator_id: 'E01', recording_id: 'x' }); return 'answered'; } catch (e) { return e.code; } }), 'forbidden');
      await switchTo(page, 'E01');
      await page.evaluate(() => globalThis.ElectroTag.backend.expert('replay_consent_set', { teaching: true }));
      await switchTo(page, 'T01');
      await page.evaluate(() => globalThis.ElectroTag.showTraining());
      await waitForRoute(page, 'training');
      await page.waitForSelector('[data-stage="guided"] .watch-entry');
      await t.screenshot(page, 'watch_entry');
      await page.click('[data-stage="guided"] .watch-entry');
      await page.waitForSelector('.dialog.watch-dialog .watch-list li');
      assert.match(await page.textContent('.watch-list'), /E01\): sub-demo02_task-rest_eeg\.edf, 1 annotation/);
      await t.screenshot(page, 'watch_dialog');
      await page.click('.watch-list button[data-log="watch-session"]');
      await waitForRoute(page, 'open');
      await page.locator('button[data-log^="example-"]').click();
      assert.match(await playToTheEnd(page), /The replay matches the saved version 1/);
      assert.equal(await page.locator('.ws-toolbar').count(), 0, 'view only');
      await page.click('.ws-header button.back');
      await page.waitForFunction(() => ['home', 'training'].includes(globalThis.ElectroTag.route));
    },
  },
  {
    name: 'on the study server: the correction is a derived version beside the untouched original, the annotator reads it, and the replay matches',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      // an annotator of its own, whose recordings no other test has touched
      const admin = (await api(t, null, 'POST', '/login', { annotator_id: 'ADMIN', password: PASSWORD })).token;
      await api(t, admin, 'POST', '/admin/user_add', { annotator_id: 'K01', display_name: 'Corrected annotator', password: PASSWORD });
      await api(t, admin, 'POST', '/admin/assign', { annotator_ids: ['K01'], all: true });
      const page = await t.newPage({ url: t.study.base, width: 1440, height: 900 });
      await signIn(page, 'K01', PASSWORD);
      await waitForRoute(page, 'home');
      const file = 'sub-003_task-rest_eeg.edf';
      // the study may hold many recordings by now (other tests register them): the list's search finds it
      await page.fill('.recordings-card input.rec-search', 'sub-003');
      await page.locator('.recordings-card tr', { hasText: file }).locator('button', { hasText: 'Open' }).click();
      await waitForRoute(page, 'open');
      await page.setInputFiles('input[data-log="file-input"]', filesFor(t.study.dir, file));
      await waitForRoute(page, 'annotate', 30000);
      await waitForTraces(page);
      await mark(page, 3.0, 3.4);
      await page.keyboard.press('Escape');
      await mark(page, 5.0, 5.5);
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 30000 });
      await page.locator('.dialog-buttons button', { hasText: /Back to my recordings|^OK$/ }).first().click();
      await page.evaluate(() => globalThis.ElectroTag.flushLog());
      const folder = path.join(t.study.dir, 'study', 'Annotated_Events', 'annotator-K01', 'sub-003', 'eeg');
      const before = checksums(folder);
      assert.equal(Object.keys(before).length, 5);

      const expert = await t.newPage({ url: t.study.base, width: 1440, height: 900 });
      await signIn(expert, 'E01', PASSWORD);
      await fromSavedWork(expert, 'K01', 'correct');
      await waitForRoute(expert, 'expert-correct');
      await expert.setInputFiles('input[data-log="file-input"]', filesFor(t.study.dir, file));
      await expert.waitForSelector('.correction-pass', { timeout: 30000 });
      await waitForTraces(expert);
      await makeChanges(expert, 7.0);
      await giveReasons(expert, 'Starts with the eyes');
      await expert.click('[data-log="correction-submit"]');
      await clickDialogButton(expert, 'Submit the correction');
      await expert.waitForSelector('.dialog .dialog-title:text("Correction saved")', { timeout: 30000 });
      await clickDialogButton(expert, 'OK');
      await waitForRoute(expert, 'expert-work');
      assert.deepEqual(checksums(folder), before, 'the original files are never changed');
      const derived = path.join(t.study.dir, 'study', 'Annotated_Events', 'derived', 'corrections', 'annotator-K01', 'sub-003', 'eeg');
      const files = fs.readdirSync(derived).sort();
      assert.equal(files.length, 5);
      const doc = JSON.parse(fs.readFileSync(path.join(derived, files.find((f) => f.endsWith('_annotations.json'))), 'utf8'));
      assert.equal(doc.session.context.derived.corrector_id, 'E01');
      assert.equal(doc.annotations.length, 2);

      // the replay of K01's session, from the server's log
      await fromSavedWork(expert, 'K01', 'replay');
      await waitForRoute(expert, 'expert-replay');
      await expert.setInputFiles('input[data-log="file-input"]', filesFor(t.study.dir, file));
      assert.match(await playToTheEnd(expert), /The replay matches the saved version 1/);

      // K01 reads the correction beside their own version
      await page.evaluate(() => globalThis.ElectroTag.reloadHome());
      await page.click('.rec-tabs [data-tab="history"]');
      await page.waitForSelector('.corrected-line');
      await page.click('.corrected-line');
      await waitForRoute(page, 'open');
      await page.setInputFiles('input[data-log="file-input"]', filesFor(t.study.dir, file));
      await page.waitForSelector('.correction-feedback', { timeout: 30000 });
      assert.equal(await page.locator('.correction-feedback-row').count(), 3);
      assert.match(await page.textContent('.correction-feedback'), /Starts with the eyes/);
    },
  },
];
