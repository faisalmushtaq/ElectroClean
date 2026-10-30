// Corrections of saved work and replays of sessions (docs/web/using.md, "Correcting saved work",
// "Corrections of your work" and "Replaying a session"): A01 saves a recording; E01 opens it from Saved
// work in the expert area, changes, removes and adds marks with the original as dashed outlines, gives
// a reason for each change (refused without them) and submits the correction once; A01 sees the
// changes and their reasons beside their own version; and E01 replays A01's session, which plays back
// to the saved version. In the demonstration, and on the real study server with the files from this
// computer, where the original files stay untouched and the correction is a derived version. Also:
// the keys of the correction view (N and P, the reason chips as a radio group, ? for a key sheet), a
// correction kept in this browser in Saved work, the replay's end in view at 1280 by 720, trainees
// never watching an expert on a recording that can be study work (and watching one on a training
// recording, on the study server), and an administrator's way back from the expert area.
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

/** Change the first mark's type (2), delete the second (Delete) and add one (1, a drag): three changes. Shift+N selects the
 *  next mark, changed or not (N alone goes to the next change, as in the other expert views). */
async function makeChanges(page, at) {
  await page.evaluate(() => globalThis.ElectroTag.ws.viewer.over.focus());
  await page.keyboard.press('Shift+N');
  await page.keyboard.press('2');
  await page.keyboard.press('Shift+N');
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
      // N and P move between the changes, as in the other expert views
      await page.evaluate(() => globalThis.ElectroTag.ws.viewer.over.focus());
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.pass.current), 0, 'the first change without a reason is the current one');
      await page.keyboard.press('n');
      await page.keyboard.press('n');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.pass.current), 2);
      await page.keyboard.press('p');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.pass.current), 1);
      // the rows in plain words, and only the reasons that suit each change
      const rowText = await page.locator('.correction-row .correction-text').allTextContents();
      assert.deepEqual(rowText.map((x) => x.split(' ')[0]).sort(), ['Added', 'Changed', 'Removed']);
      assert.equal(await page.locator('.correction-kind').count(), 0, 'no raw added, changed or removed chips');
      assert.equal(await page.locator('.correction-row[data-change="added"] [data-reason="not_artifact"]').count(), 0, 'an added mark is never "Not an artifact"');
      assert.equal(await page.locator('.correction-row[data-change="removed"] [data-reason="missed"]').count(), 0);
      // R goes to the reasons, a radio group: the arrow keys choose, and the focus stays on the chosen chip after the list is drawn again
      await page.keyboard.press('r');
      const focused = () => page.evaluate(() => { const a = document.activeElement; return a && a.dataset ? [a.getAttribute('role'), a.dataset.reason || '', a.closest('.correction-row') && a.closest('.correction-row').dataset.change] : null; });
      const first = await focused();
      assert.equal(first[0], 'radio');
      await page.keyboard.press('ArrowRight');
      const second = await focused();
      assert.equal(second[0], 'radio', 'the focus is on a chip after the list was drawn again');
      assert.notEqual(second[1], first[1]);
      assert.equal(await page.locator(`.correction-row.current [data-reason="${second[1]}"][aria-checked="true"]`).count(), 1, 'the arrow key chose it');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.pass.changes.length), 3, 'the arrow keys did not reach the EEG');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Shift+Digit7'); // anywhere: Other for the current change
      assert.equal(await page.locator('.correction-row.current [data-reason="other"][aria-checked="true"]').count(), 1);
      await t.screenshot(page, 'correction_keyboard_reasons');
      // ? lists the view's keys
      await page.evaluate(() => globalThis.ElectroTag.ws.viewer.over.focus());
      await page.keyboard.press('?');
      await page.waitForSelector('.dialog.key-sheet');
      assert.match(await page.textContent('.dialog.key-sheet'), /N \/ P.*next and previous change/);
      await t.screenshot(page, 'correction_key_sheet');
      await page.keyboard.press('Escape');
      await giveReasons(page, 'Eyes, not muscle');
      // Back keeps the correction in this browser; Saved work says so, and Carry on brings it back
      await page.click('.ws-header button.back');
      await clickDialogButton(page, 'Keep it in this browser');
      await waitForRoute(page, 'expert-work');
      const row = page.locator('[data-section="work"] tbody tr', { hasText: 'A01' }).first();
      await row.locator('.chip', { hasText: 'Yours in progress, in this browser' }).waitFor();
      assert.equal(await row.locator('button[data-log="work-correct"]').textContent(), 'Carry on');
      await t.screenshot(page, 'saved_work_kept');
      await row.locator('button[data-log="work-correct"]').click();
      await waitForRoute(page, 'expert-correct');
      await page.locator('button[data-log^="example-"]').click();
      await clickDialogButton(page, 'Carry on');
      await page.waitForSelector('.correction-pass');
      await page.waitForFunction(() => globalThis.ElectroTag.ws.pass.changes.length === 3);
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

      // E01 replays A01's session: it plays back to the saved version, and says so in view on a small screen
      await page.setViewportSize({ width: 1280, height: 720 });
      await fromSavedWork(page, 'A01', 'replay');
      await waitForRoute(page, 'expert-replay');
      await page.locator('button[data-log^="example-"]').click();
      const end = await playToTheEnd(page);
      assert.match(end, /The replay matches the saved version 1/);
      for (const sel of ['.replay-end', '.replay-caption']) {
        const box = await page.locator(sel).boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= 720, `${sel} is in view at 1280 by 720 (${JSON.stringify(box)})`);
      }
      assert.match(await page.textContent('.replay-caption'), /The end\. The replay matches the saved version 1/);
      await t.screenshot(page, 'replay_end');
      await page.keyboard.press('?');
      await page.waitForSelector('.dialog.key-sheet');
      assert.match(await page.textContent('.dialog.key-sheet'), /Space.*play or pause/);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.size), 2, 'the annotations built up as they were made');
      await page.keyboard.press('Home');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.size), 0, 'back at the start');
      await page.keyboard.press('>');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.size), 1, 'the first change');
      await page.keyboard.press('n'); // N and P step through the changes too, as in the other expert views
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.size), 2, 'the second change');
      await page.keyboard.press('p');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.size), 1);
      assert.match(await page.textContent('.replay-caption'), /Created Eye-blink-artifact|Created /);
      await t.screenshot(page, 'replay_player');
      await page.click('.ws-header button.back');
      await waitForRoute(page, 'expert-work');
      await page.setViewportSize({ width: 1440, height: 900 });
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
    name: 'a trainee never watches an expert on a recording that can be study work, and an administrator goes back to the admin area from the expert area',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'ADMIN');
      await page.evaluate(() => globalThis.ElectroTag.backend.admin('assign', { annotator_ids: ['E01'], all: true }));
      // the administrator's way back from the expert area (once the first view after signing in is shown)
      await page.waitForFunction(() => (globalThis.ElectroTag.route || '').startsWith('admin') && document.querySelector('.admin-nav'), null, { timeout: 30000 });
      await page.evaluate(() => globalThis.ElectroTag.showExpert('expert'));
      await waitForRoute(page, 'expert');
      await page.click('.app-header [data-log="expert-to-admin"]');
      await waitForRoute(page, 'admin');
      // the planted exercise's panel has no stray "null" before an exercise is made
      await page.evaluate(() => globalThis.ElectroTag.showExpert('expert-planted'));
      await page.waitForSelector('[data-section="planted"] .planted-row');
      await page.locator('.planted-row').nth(1).locator('[data-log="planted-open"]').click();
      await page.waitForSelector('.planted-admin summary');
      assert.doesNotMatch(await page.textContent('.planted-admin'), /null/);
      await page.locator('.planted-row').first().locator('[data-log="planted-open"]').click();
      await page.waitForSelector('.planted-admin table');
      assert.doesNotMatch(await page.textContent('.planted-admin'), /null/);
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
      const rid = await page.evaluate(() => globalThis.ElectroTag.backend.state.submissions.find((x) => x.annotator_id === 'E01').recording_id);
      // T01, and A01 who holds the same recording as study work: nothing to watch, and the study refuses the replay
      for (const who of ['T01', 'A01']) {
        await switchTo(page, who);
        const refused = await page.evaluate(async (r) => {
          const out = [];
          for (const body of [{ annotator_id: 'E01', recording_id: r }, { annotator_id: 'E01', recording_id: r, mode: 'guided', context_id: 'example' }]) {
            try { await globalThis.ElectroTag.backend.expert('replay_index_get', body); out.push('answered'); } catch (e) { out.push(e.code); }
          }
          const list = await globalThis.ElectroTag.backend.expert('teaching_list', {});
          return [...out, list.sessions.length];
        }, rid);
        assert.deepEqual(refused, ['forbidden', 'forbidden', 0], who);
      }
      // The sandbox's training recordings are also its study recordings, so even with E01's consent there is
      // nothing a trainee may watch, and the training path offers no way in (the real study server's test watches)
      await switchTo(page, 'T01');
      await page.evaluate(() => globalThis.ElectroTag.showTraining());
      await waitForRoute(page, 'training');
      await page.waitForSelector('[data-stage="guided"][data-status="available"]');
      await page.waitForTimeout(300);
      assert.equal(await page.locator('[data-stage="guided"] .watch-entry').count(), 0, 'nothing a trainee may watch in the sandbox');
    },
  },
  {
    name: 'on an iPad: the reason chips are large enough for a finger, and no keyboard hints are shown',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1180, height: 820, ipad: true });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await page.evaluate(() => { const ws = globalThis.ElectroTag.ws; ws.store.addInterval('Eye-blink-artifact', 2.0, 2.4, []); ws.store.addInterval('EMG-artifact', 5.0, 5.6, []); });
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 15000 });
      await page.locator('.dialog-buttons button', { hasText: /Back to my recordings|^OK$/ }).first().click();
      await switchTo(page, 'E01');
      await fromSavedWork(page, 'A01', 'correct');
      await waitForRoute(page, 'expert-correct');
      await page.locator('button[data-log^="example-"]').click();
      await page.waitForSelector('.correction-pass');
      await page.evaluate(() => { const ws = globalThis.ElectroTag.ws; const [a, b] = ws.store.annotations(); ws.store.setLabel(a.annotation_id, 'Eye-movement-artifact'); ws.store.delete(b.annotation_id); });
      await page.waitForFunction(() => globalThis.ElectroTag.ws.pass.changes.length === 2);
      const heights = await page.$$eval('.reason-chips .seg', (els) => els.map((e) => e.getBoundingClientRect().height));
      assert.ok(heights.length && heights.every((x) => x >= 40), `chips at least 40 pixels tall: ${heights.join(', ')}`);
      assert.equal(await page.locator('.key-hint:visible').count(), 0, 'no keys on the chips');
      assert.doesNotMatch(await page.textContent('.ws-hint'), /N \/ P|\?  keys/, 'the hint names no keys');
      assert.doesNotMatch(await page.textContent('.correction-pass'), /N and P go to/);
      await t.screenshot(page, 'correction_ipad');
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

      // A second expert corrects the same version differently: K01 is told the experts disagree, and sees neither version
      const target = await api(t, admin, 'POST', '/expert/saved_attempt_get', { annotator_id: 'K01', recording_id: 'sub-003/eeg/sub-003_task-rest_eeg.edf' });
      const [m1, ...rest] = target.annotations;
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filesFor(t.study.dir, file)[0])).digest('hex');
      await api(t, admin, 'POST', '/expert/correction_save', { correction_id: crypto.randomBytes(16).toString('hex'), annotator_id: 'K01', recording_id: target.recording_id,
        attempt: target.attempt, annotations: [{ ...m1, label: 'Chewing-artifact' }, ...rest], sha256, session: { elapsed_s: 30 },
        changes: [{ annotation_id: m1.annotation_id, reason: 'wrong_type', note: 'Jaw, not eyes' }] });
      await page.click('.ws-header button.back');
      await page.waitForFunction(() => ['home', 'training'].includes(globalThis.ElectroTag.route));
      await page.evaluate(() => globalThis.ElectroTag.reloadHome());
      await page.click('.rec-tabs [data-tab="history"]');
      await page.waitForSelector('.corrected-line.pending');
      assert.match(await page.textContent('.corrected-line.pending'), /who disagree in places: the study is settling it/);
      assert.equal(await page.locator('button.corrected-line').count(), 0, 'nothing to open: neither expert\'s version is shown');
      await t.screenshot(page, 'history_corrections_pending');
      const pending = await page.evaluate(async () => { const fb = await globalThis.ElectroTag.backend.myFeedback(); return fb.corrections.items[0]; });
      assert.equal(pending.standing, 'pending');
      assert.deepEqual(pending.changes, []);
      // E03 adjudicates the two corrections and keeps E01's; K01 then sees the settled version and the decision
      await api(t, admin, 'POST', '/admin/user_add', { annotator_id: 'E03', display_name: 'Expert three', password: PASSWORD, roles: ['expert'] });
      const e03 = (await api(t, null, 'POST', '/login', { annotator_id: 'E03', password: PASSWORD })).token;
      { // a new expert answers the sign-up questionnaire before expert work opens
        const q = await api(t, e03, 'GET', '/me/questionnaire');
        const answers = Object.fromEntries(q.questions.map((x) => [x.id, x.type === 'multi' ? [q.prefer_not.value] : q.prefer_not.value]));
        await api(t, e03, 'POST', '/me/questionnaire', { answers, contacts: { full_name: 'Expert three', email: 'e03@example.org' } });
      }
      const unit = (await api(t, e03, 'POST', '/expert/adjudication_list', {})).units.find((u) => u.kind === 'corrections' && u.corrected && u.corrected.annotator_id === 'K01');
      const got = await api(t, e03, 'POST', '/expert/adjudication_start', { unit_id: unit.unit_id });
      for (const c of got.conflicts) {
        const letter = (c.marks.find((x) => x.annotator_id === 'E01') || c.marks[0]).letter;
        await api(t, e03, 'POST', '/expert/adjudication_decide', { unit_id: unit.unit_id, conflict_id: c.conflict_id, choice: letter, reason_code: 'type_evidence', reason: 'the eyes move' });
      }
      await api(t, e03, 'POST', '/expert/adjudication_finish', { unit_id: unit.unit_id });
      await page.evaluate(() => globalThis.ElectroTag.reloadHome());
      await page.click('.rec-tabs [data-tab="history"]');
      await page.waitForSelector('button.corrected-line');
      assert.match(await page.textContent('button.corrected-line'), /settled by Expert three/);
      await t.screenshot(page, 'history_corrections_settled');
      // the outcome card, readable without the recording's file
      await page.click('button.settled-open');
      await page.waitForSelector('.dialog.settled-dialog .settled-row');
      assert.match(await page.textContent('.dialog.settled-dialog'), /Expert one's correction was kept/);
      assert.match(await page.textContent('.dialog.settled-dialog'), /Why: the type shows in the EEG: the eyes move/);
      await t.screenshot(page, 'history_corrections_outcome');
      await clickDialogButton(page, 'Close');
      // the home page's Decisions on your disagreements card has it too
      await page.waitForSelector('.outcomes-card .settled-card', { timeout: 15000 });
      assert.match(await page.textContent('.outcomes-card .settled-card summary'), /corrected by Expert one and .+, who disagreed: \d+ places?, decided by Expert three/);
      await page.click('button.corrected-line');
      await waitForRoute(page, 'open');
      await page.setInputFiles('input[data-log="file-input"]', filesFor(t.study.dir, file));
      await page.waitForSelector('.correction-feedback[data-standing="adjudicated"]', { timeout: 30000 });
      assert.doesNotMatch(await page.textContent('.correction-feedback'), /Jaw, not eyes/, 'the rejected version\'s change is not taught');
      assert.match(await page.textContent('.correction-feedback'), /Where the experts disagreed/);
      await t.screenshot(page, 'correction_feedback_settled');
    },
  },
  {
    name: 'on the study server: a trainee watches an expert on a training recording for learning with the experts, never on study work',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const file = 'sub-example01_task-example_eeg.vhdr';
      const rid = `sub-example01/eeg/${file}`;
      const admin = (await api(t, null, 'POST', '/login', { annotator_id: 'ADMIN', password: PASSWORD })).token;
      await api(t, admin, 'POST', '/admin/assign', { annotator_ids: ['E01'], recording_ids: [rid], mode: 'practice', context_id: 'example' });
      const e01 = (await api(t, null, 'POST', '/login', { annotator_id: 'E01', password: PASSWORD })).token;
      // E01 annotates the example set's first guided recording in practice mode: a session in the log, then the save
      const sid = crypto.randomBytes(16).toString('hex');
      const visit = (await api(t, e01, 'POST', '/visits', { client: { user_agent: 'e2e' }, mode: 'practice', context_id: 'example' })).visit_id;
      const at = { recording: rid, window_no: 1 };
      const mark = { annotation_id: crypto.randomBytes(16).toString('hex'), label: 'Eye-blink-artifact', onset_sample: 500, duration_samples: 100, channels: [],
        created_at: '2026-10-30T10:00:00.000+00:00', modified_at: '2026-10-30T10:00:00.000+00:00' };
      const summary = { id: mark.annotation_id, label: mark.label, onset_s: 2, offset_s: 2.4, channels: [], confidence: null, note_length: 0 };
      await api(t, e01, 'POST', `/visits/${visit}/events`, { events: [
        { t: 1, type: 'recording_opened', ...at, session_id: sid, mode: 'practice', annotations_restored: 0 },
        { t: 1.5, type: 'view', ...at, t_start: 0, duration: 10, ch_start: 0, n_channels: 20, scale_factor: 1 },
        { t: 3, type: 'annotation_created', ...at, annotations: [summary], n_total: 1, via: 'drag' },
        { t: 5, type: 'recording_finished', ...at, session_id: sid, attempt: 1 }] });
      await api(t, e01, 'POST', `/visits/${visit}/close`, { reason: 'signed_out' });
      const data = filesFor(t.study.dir, file).find((f) => f.endsWith('.eeg'));
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(data)).digest('hex');
      await api(t, e01, 'POST', '/submissions', { recording_id: rid, mode: 'practice', context_id: 'example', annotations: [mark], sha256,
        session: { started_at: '2026-10-30T10:00:00.000+00:00', elapsed_s: 20, session_id: sid, client: { user_agent: 'e2e' } } });
      await api(t, e01, 'POST', '/expert/replay_consent_set', { teaching: true });
      // T01 finds it under Watch an expert at work, and only it: E01's study work is never listed
      const page = await t.newPage({ url: t.study.base, width: 1280, height: 720 });
      await signIn(page, 'T01', PASSWORD);
      await page.waitForFunction(() => globalThis.ElectroTag && globalThis.ElectroTag.me);
      const listed = await page.evaluate(() => globalThis.ElectroTag.backend.expert('teaching_list', {}));
      assert.ok(listed.sessions.length >= 1 && listed.sessions.every((x) => x.mode !== 'standard' && x.context_id === 'example'), JSON.stringify(listed));
      await page.evaluate(() => globalThis.ElectroTag.showTraining());
      await waitForRoute(page, 'training');
      await page.click('[data-stage="guided"] .watch-entry');
      await page.waitForSelector('.dialog.watch-dialog .watch-list li');
      const item = page.locator('.watch-list li', { hasText: file }).first();
      await t.screenshot(page, 'watch_dialog_training');
      await item.locator('button[data-log="watch-session"]').click();
      await waitForRoute(page, 'open');
      await page.setInputFiles('input[data-log="file-input"]', filesFor(t.study.dir, file));
      assert.match(await playToTheEnd(page), /The replay matches the saved version 1/);
      // and a study recording E01 saved stays out of reach
      const study = await api(t, admin, 'POST', '/expert/work_list', { annotator_id: 'E01' });
      for (const w of study.items) {
        const code = await page.evaluate(async (r) => { try { await globalThis.ElectroTag.backend.expert('replay_index_get', { annotator_id: 'E01', recording_id: r }); return 'answered'; } catch (e) { return e.code; } }, w.recording_id);
        assert.equal(code, 'forbidden');
      }
    },
  },
];
