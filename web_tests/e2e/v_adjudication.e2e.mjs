// Screening-style adjudication and the library, on the real study server (the sandbox cannot find
// conflicts: they need the study's Python code, and it says so). Two annotators save the same
// recording and disagree; E01, who annotated neither, opens the adjudication queue, starts with the
// file from this computer, decides every conflict with the keys (a version, neither, both, with
// reasons) and finishes; the adjudicated version is in the derived tree and the originals are
// untouched; A01 sees the outcome of their conflicts; then E01 filters the library and promotes an
// entry to a quiz item, once, with where it came from.
//
// The test starts a study server of its own (electrotag-web demo in a fresh folder), so that what the
// other specs save on the shared server does not change which conflicts there are.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkipTest, clickDialogButton, signIn, waitForRoute, waitForTraces } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'electrotag';
const SUB1 = 'sub-001/eeg/sub-001_task-rest_eeg.vhdr';
const FILE = 'sub-001_task-rest_eeg.vhdr';
const ann = (id, label, onset, dur, channels = []) => ({ annotation_id: id, label, onset_sample: onset, duration_samples: dur, channels,
  created_at: '2026-10-30T10:00:00.000+00:00', modified_at: '2026-10-30T10:00:00.000+00:00' });
// 250 Hz: they disagree on the type at 2 s, each marks a blink the other did not, and agree on the EMG at 12 s
const MINE = [ann('a'.repeat(32), 'Eye-blink-artifact', 500, 100, ['Fp1', 'Fp2']), ann('b'.repeat(32), 'EMG-artifact', 3000, 250), ann('c'.repeat(32), 'Eye-blink-artifact', 5000, 100)];
const THEIRS = [ann('d'.repeat(32), 'Eye-movement-artifact', 500, 100, ['Fp1', 'Fp2']), ann('e'.repeat(32), 'EMG-artifact', 3000, 250), ann('f'.repeat(32), 'Eye-blink-artifact', 8000, 75)];

function python() {
  for (const p of [process.env.ELECTROTAG_PYTHON, path.join(REPO, '.venv', 'bin', 'python'), 'python3']) {
    if (!p || (p.includes('/') && !fs.existsSync(p))) continue;
    if (spawnSync(p, ['-c', 'import fastapi, uvicorn, mne'], { stdio: 'ignore' }).status === 0) return p;
  }
  return null;
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** A study server of this test's own: electrotag-web demo in a fresh folder. */
async function ownStudy() {
  const py = python();
  if (!py) throw new SkipTest('the study server needs the packages of requirements.txt');
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'et-adjudication-'));
  const proc = spawn(py, ['-m', 'electrotag.web.cli', 'demo', '--dir', path.join(dir, 'demo'), '--host', '127.0.0.1', '--port', String(port), '--fresh'],
    { cwd: dir, env: { ...process.env, PYTHONPATH: REPO }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const base = `http://127.0.0.1:${port}/`;
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(`${base}api/v1/health`)).ok) break; } catch { /* not yet */ }
    if (Date.now() - t0 > 300000 || proc.exitCode !== null) { proc.kill(); throw new Error(`the study server did not start:\n${stderr}`); }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { base, dir: path.join(dir, 'demo'), stop: () => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

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

async function api(s, token, p, body) {
  const res = await fetch(`${s.base}api/v1${p}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ElectroTag': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${p}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const login = async (s, id) => (await api(s, null, '/login', { annotator_id: id, password: PASSWORD })).token;

async function save(s, id, annotations, password = PASSWORD) {
  const eeg = filesFor(s.dir, FILE).find((f) => f.endsWith('.eeg'));
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(eeg)).digest('hex');
  const token = (await api(s, null, '/login', { annotator_id: id, password })).token;
  await api(s, token, '/submissions', { recording_id: SUB1, mode: 'standard', context_id: '', annotations, sha256,
    session: { started_at: '2026-10-30T10:00:00.000+00:00', elapsed_s: 60 } });
}

function checksums(folder) {
  if (!fs.existsSync(folder)) return {};
  return Object.fromEntries(fs.readdirSync(folder).sort().map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, f))).digest('hex')]));
}

const pass = (page) => page.evaluate(() => {
  const p = globalThis.ElectroTag.ws && globalThis.ElectroTag.ws.review;
  return p ? { row: p.row, decided: p.conflicts.filter((c) => c.decision).length, n: p.conflicts.length, choice: p.pending && p.pending.choice,
    sending: Boolean(p.sending), kinds: p.conflicts.map((c) => c.kinds.join('+')) } : null;
});

async function focusEeg(page) {
  await page.evaluate(() => globalThis.ElectroTag.ws.viewer.over.focus());
}

/** Wait until `n` conflicts are decided (each decision goes to the study on its own). */
async function decided(page, n) {
  await page.waitForFunction((k) => {
    const p = globalThis.ElectroTag.ws && globalThis.ElectroTag.ws.review;
    return p && !p.sending && p.conflicts.filter((c) => c.decision).length === k;
  }, n, { timeout: 15000 });
}

export const tests = [
  {
    name: 'in the sandbox, the queue says that adjudication needs a study server',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'E01');
      await waitForRoute(page, 'home');
      await page.evaluate(() => globalThis.ElectroTag.showExpert('expert-queue'));
      await waitForRoute(page, 'expert-queue');
      await page.waitForSelector('[data-section="queue"] .admin-msg .note', { timeout: 15000 });
      assert.match(await page.textContent('[data-section="queue"] .admin-msg'), /The demonstration cannot compare annotators' versions and adjudicate their disagreements in the browser: that needs a study server or Firebase/);
      assert.ok(await page.locator('.expert-nav a[data-section="library"]').count(), 'the library is in the menu');
    },
  },
  {
    name: 'on the study server: two annotators disagree, E01 adjudicates with the keys and finishes, A01 sees the outcome, and an entry of the library becomes a quiz item once',
    async run(t) {
      const { assert } = t;
      const s = await ownStudy();
      try {
        await save(s, 'A01', MINE);
        await save(s, 'A02', THEIRS);
        const originals = ['A01', 'A02'].map((id) => path.join(s.dir, 'study', 'Annotated_Events', `annotator-${id}`, 'sub-001', 'eeg'));
        const before = originals.map(checksums);
        assert.equal(Object.keys(before[0]).length, 5);

        const page = await t.newPage({ url: s.base, width: 1600, height: 950 });
        await signIn(page, 'ADMIN', PASSWORD);
        // the admin menu links to the queue, in the expert area
        await page.waitForSelector('.admin-nav a[data-expert="expert-queue"]');
        await page.click('.admin-nav a[data-expert="expert-queue"]');
        await page.waitForSelector('[data-section="queue"] table.admin-list');
        assert.ok(await page.locator('.expert-nav a.to-admin[href="#admin"]').count(), 'an administrator has a way back to the admin area');
        await page.evaluate(async () => { await globalThis.ElectroTag.signOut(); });
        await signIn(page, 'E01', PASSWORD);
        await waitForRoute(page, 'home');
        // the home page's Expert work card says what waits
        await page.waitForSelector('.expert-card .expert-count', { timeout: 15000 });
        assert.match(await page.textContent('.expert-card'), /1 ready to adjudicate, 3 conflicts in all/);
        await page.click('.expert-card [data-log="open-expert-queue"]');
        const row = page.locator('[data-section="queue"] tr', { hasText: FILE });
        await row.waitFor({ timeout: 20000 });
        assert.match(await row.textContent(), /A01 and A02/);
        assert.match(await row.textContent(), /Ready/);
        assert.match(await page.textContent('[data-section="queue"] .adj-summary'), /^1 ready to adjudicate · \d+ waiting or agreed\. 3 conflicts left to decide\.$/);
        // the search finds a person or a recording, and nothing else
        await page.fill('[data-section="queue"] input[data-log="adjudication-search"]', 'nobody-like-this');
        await page.waitForSelector('[data-section="queue"] .empty');
        await page.fill('[data-section="queue"] input[data-log="adjudication-search"]', 'a02');
        await row.waitFor();
        await t.screenshot(page, 'adjudication_queue');
        await row.locator('button[data-log="adjudication-start"]').click();
        await waitForRoute(page, 'expert-adjudicate');
        await page.setInputFiles('input[data-log="file-input"]', filesFor(s.dir, FILE));
        await page.waitForSelector('.adjudication-pass', { timeout: 30000 });
        await waitForTraces(page);
        await page.waitForSelector('.lanes .lane-mark.current');
        let st = await pass(page);
        assert.deepEqual(st.kinds, ['type', 'presence', 'presence']);
        assert.equal(st.row, 0);
        assert.equal(await page.locator('.lanes .lane').count(), 2);
        assert.match(await page.textContent('.adj-whose'), /A A01 \(Annotator one\).*B A02 \(Annotator two\)/);
        assert.match(await page.textContent('.adj-progress'), /Conflict 1 of 3, 0 decided/);
        assert.match(await page.textContent('.ws-hint'), /^1 or 2 keep A or B {2}· {2}K both/);
        // the panel's tabs are folded away while adjudicating
        assert.ok(await page.locator('.side-tabs.folded').count(), 'the side tabs are folded');
        await t.screenshot(page, 'adjudication_pass');

        // 1: keep B, with a reason written after R; Enter saves and goes on
        await focusEeg(page);
        await page.keyboard.press('2');
        assert.equal((await pass(page)).choice, 'B');
        await page.keyboard.press('Enter'); // a reason is needed first: the message says how, and nothing is sent
        assert.match(await page.textContent('.adj-msg'), /Shift and a number/);
        await page.keyboard.press('r');
        await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains('adj-reason'));
        await page.keyboard.type('The eyes move sideways');
        await page.keyboard.press('Enter');
        await decided(page, 1);
        st = await pass(page);
        assert.equal(st.row, 1);
        assert.notEqual(await page.evaluate(() => document.activeElement && document.activeElement.tagName), 'BODY', 'the focus is never lost');
        // the conflict and the bar stay in view (only the list scrolls), also at 1280 by 720
        // (within the panel's top part, which never scrolls with the list: nothing of it is cut off)
        const inView = () => page.evaluate(() => {
          const top = document.querySelector('.adj-top');
          const box = top.getBoundingClientRect();
          const r = document.querySelector('[data-log="adjudication-save"]').getBoundingClientRect();
          const d = document.querySelector('.adj-detail-head').getBoundingClientRect();
          const inside = (x) => x.top >= box.top - 1 && x.bottom <= box.bottom + 1 && x.bottom <= innerHeight;
          return inside(r) && inside(d) && top.scrollHeight <= top.clientHeight + 1;
        });
        assert.ok(await inView(), 'Save and the conflict are in view');
        // 2: neither, with Shift and a digit for the reason; a choice not saved stays with its conflict when moving
        await focusEeg(page);
        await page.keyboard.press('x');
        await page.keyboard.press('n');
        assert.equal((await pass(page)).row, 2);
        await page.keyboard.press('p');
        assert.equal((await pass(page)).choice, 'none', 'the choice is kept with its conflict');
        assert.match(await page.textContent('.adj-item[data-unsaved="yes"]'), /Chosen, not saved: Kept none/);
        await page.keyboard.press('Shift+Digit2');
        assert.equal(await page.getAttribute('.adj-reasons [data-reason="not_artifact"]', 'aria-checked'), 'true');
        await page.keyboard.press('Enter');
        await decided(page, 2);
        // 3: keep both (K), then the lanes: T shows one version alone, and back
        await focusEeg(page);
        await page.keyboard.press('t');
        assert.equal(await page.locator('.lanes .lane.dimmed').count(), 1);
        await page.keyboard.press('t');
        await page.keyboard.press('t');
        assert.equal(await page.locator('.lanes .lane.dimmed').count(), 0);
        await page.keyboard.press('k');
        // the reason chips are one radio group: the arrows choose, Enter on a chip saves
        await page.click('.adj-reasons [data-reason="type_evidence"]');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.getAttribute('.adj-reasons [data-reason="both_valid"]', 'aria-checked'), 'true');
        await page.keyboard.press('Enter');
        await decided(page, 3);
        assert.notEqual(await page.evaluate(() => document.activeElement && document.activeElement.tagName), 'BODY');
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.waitForTimeout(300);
        // P goes back; a decision can be changed until the end: E replaces the marks with two of the adjudicator's own
        await focusEeg(page);
        await page.keyboard.press('p');
        await page.waitForSelector('.adj-item.current[data-decided="yes"]');
        assert.equal((await pass(page)).row, 1);
        assert.ok(await inView(), 'Save and the conflict are in view at 1280 by 720');
        await t.screenshot(page, 'adjudication_pass_small');
        await page.keyboard.press('e');
        await page.waitForSelector('.adj-edit:not([hidden]) select.adj-edit-label');
        await page.fill('.adj-edit input.adj-edit-time >> nth=0', '19.9');
        await page.fill('.adj-edit input.adj-edit-time >> nth=1', '20.1');
        await page.click('[data-log="adjudication-edit-add"]');
        await page.fill('.adj-edit input.adj-edit-time >> nth=2', '20.2');
        await page.fill('.adj-edit input.adj-edit-time >> nth=3', '20.5');
        await page.focus('.adj-edit input.adj-edit-time >> nth=3');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => {
          const p = globalThis.ElectroTag.ws.review;
          return !p.sending && p.conflicts[1].decision && p.conflicts[1].decision.choice === 'edited' && p.conflicts[1].decision.marks.length === 2;
        }, null, { timeout: 15000 });
        // 1 again: keep marks of both people, chosen one by one (M, then the boxes), Shift+6 both valid
        await page.click('.adj-item >> nth=0');
        await focusEeg(page);
        await page.keyboard.press('m');
        await page.waitForSelector('.adj-pick:not([hidden]) input[type="checkbox"]');
        for (const box of await page.locator('.adj-pick input[type="checkbox"]').all()) await box.check();
        await t.screenshot(page, 'adjudication_pick');
        await focusEeg(page);
        await page.keyboard.press('Shift+Digit6');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => {
          const p = globalThis.ElectroTag.ws.review;
          return !p.sending && p.conflicts[0].decision && p.conflicts[0].decision.choice === 'pick';
        }, null, { timeout: 15000 });
        // ?: the keys of this view, in the panel's Help
        await focusEeg(page);
        await page.keyboard.press('?');
        await page.waitForSelector('.adj-keysheet');
        assert.match(await page.textContent('.adj-keysheet'), /Shift\+1 to Shift\+7/);
        assert.equal(await page.locator('.side-tabs.folded').count(), 0);
        await page.setViewportSize({ width: 1600, height: 950 });
        assert.ok(await page.locator('.ws-actions [data-log="adjudication-finish"]:not([hidden])').count(), 'Finish shows once all are decided');
        await t.screenshot(page, 'adjudication_decided');
        await focusEeg(page);
        await page.keyboard.press('f');
        await clickDialogButton(page, 'Finish adjudication');
        await page.waitForSelector('.dialog .dialog-title:text("Adjudication finished")', { timeout: 30000 });
        await clickDialogButton(page, 'OK');
        await waitForRoute(page, 'expert-queue');
        const decisions = await api(s, await login(s, 'E01'), '/expert/adjudication_list', {});
        const unit = decisions.units.find((u) => u.recording_id === SUB1);
        assert.equal(unit.status, 'adjudicated');
        assert.equal(unit.decided, 3);
        const folder = path.join(s.dir, 'study', 'Annotated_Events', 'derived', 'adjudications', 'annotator-ADJUDICATED', 'sub-001', 'eeg');
        const made = fs.readdirSync(folder);
        assert.equal(made.length, 5);
        const doc = JSON.parse(fs.readFileSync(path.join(folder, made.find((f) => f.endsWith('_annotations.json'))), 'utf8'));
        assert.deepEqual(doc.annotations.map((a) => [a.label, a.onset_sample, a.duration_samples]),
          [['Eye-blink-artifact', 500, 100], ['Eye-movement-artifact', 500, 100], ['EMG-artifact', 3000, 250], ['Eye-blink-artifact', 4975, 50],
            ['Eye-blink-artifact', 5050, 75], ['Eye-blink-artifact', 8000, 75]]);
        assert.deepEqual(originals.map(checksums), before, 'the versions compared are never changed');
        const fb = await api(s, await login(s, 'A01'), '/me/feedback');
        assert.deepEqual(fb.adjudications.items[0].conflicts.map((c) => c.decision.outcome), ['all_kept', 'edited', 'other_kept']);
        assert.equal(fb.adjudications.items[0].conflicts[0].decision.reason, 'The eyes move sideways');
        // ... and on A01's home page, near the top, in plain words, nobody named; the history says it too
        const annotator = await t.newPage({ url: s.base, width: 1440, height: 900 });
        await signIn(annotator, 'A01', PASSWORD);
        await waitForRoute(annotator, 'home');
        await annotator.waitForSelector('.outcomes-card', { timeout: 15000 });
        assert.ok(await annotator.evaluate(() => {
          const card = document.querySelector('.outcomes-card');
          const list = document.querySelector('.rec-tabs');
          return Boolean(list) && Boolean(card.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
        }), 'the decisions come before the list of recordings');
        assert.match(await annotator.textContent('.outcomes-lead'), /In 1 of the 3 places where you and a colleague disagreed, the expert decided as you had it/);
        await annotator.click('.outcomes-card details summary');
        const said = await annotator.textContent('.outcomes-card');
        assert.match(said, /3 decided: 1 with both marks kept, 1 where a colleague's mark was kept, 1 redrawn by the adjudicator/);
        assert.match(said, /A colleague's mark was kept where you had none/);
        assert.match(said, /The adjudicator drew their own marks instead/);
        assert.match(said, /Why: Both are valid: The eyes move sideways/);
        assert.ok(!/A02|E01/.test(said), 'nobody else is named');
        await t.screenshot(annotator, 'adjudication_outcomes_home');
        await annotator.click('.rec-tabs [data-tab="history"]');
        await annotator.waitForSelector('.adjudicated-line');
        assert.match(await annotator.textContent('.adjudicated-line'), /Adjudicated: 1 of 3 disagreements decided as you had them/);

        // the queue: a finished adjudication becomes a training reference
        await page.click('[data-section="queue"] [data-tab="finished"]');
        await page.click('[data-section="queue"] [data-log="adjudication-make-reference"]');
        await page.waitForSelector('.dialog.reference-dialog');
        await t.screenshot(page, 'adjudication_make_reference');
        await clickDialogButton(page, 'Make it a reference');
        await page.waitForSelector('[data-section="queue"] .admin-msg .success', { timeout: 15000 });
        assert.match(await page.textContent('[data-section="queue"] .admin-msg'), /is now a practice reference of/);

        // the library: filter by the confused pair, promote the first entry to a quiz item
        await page.evaluate(() => globalThis.ElectroTag.showExpert('expert-library'));
        await page.waitForSelector('[data-section="library"] table.admin-list tbody tr');
        assert.equal(await page.locator('[data-section="library"] table.admin-list tbody tr').count(), 3);
        await page.selectOption('[data-section="library"] select[data-filter="pair"]', 'Eye-blink-artifact | Eye-movement-artifact');
        await page.waitForFunction(() => document.querySelectorAll('[data-section="library"] table.admin-list tbody tr').length === 1);
        assert.match(await page.textContent('[data-section="library"] table.admin-list tbody'), /Kept 2 chosen marks of A \(A01\) and B \(A02\)/);
        await t.screenshot(page, 'adjudication_library');
        await page.click('[data-section="library"] [data-log="library-promote"]');
        await page.waitForSelector('.dialog.promote-dialog');
        await page.selectOption('.promote-dialog select >> nth=2', 'Eye-movement-artifact');
        await t.screenshot(page, 'adjudication_promote');
        await clickDialogButton(page, 'Promote');
        await page.waitForSelector('[data-section="library"] .admin-msg .success', { timeout: 15000 });
        assert.match(await page.textContent('[data-section="library"] .admin-msg'), /Added as quiz item q\d+ of/);
        // the row says where it went; promoted again: the item already made
        await page.waitForSelector('[data-section="library"] .lib-promoted');
        assert.match(await page.textContent('[data-section="library"] .lib-promoted'), /Promoted: Quiz item q\d+ of/);
        await page.click('[data-section="library"] [data-log="library-promote"]');
        await page.waitForSelector('.dialog.promote-dialog');
        await clickDialogButton(page, 'Promote');
        await page.waitForSelector('[data-section="library"] .admin-msg .success:has-text("already")', { timeout: 15000 });
        const admin = await login(s, 'ADMIN');
        const sets = await api(s, admin, '/admin/sets_list', {});
        const promoted = [];
        for (const set of sets.sets) {
          const quiz = await api(s, admin, '/admin/quiz_items', { set_id: set.set_id });
          promoted.push(...quiz.items.filter((it) => it.source && it.source.library_entry));
        }
        assert.equal(promoted.length, 1);
        assert.equal(promoted[0].correct_label, 'Eye-movement-artifact');
        assert.equal(promoted[0].source.task_id, unit.unit_id);
        // the export names who each letter is and whose marks were kept
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-section="library"] [data-log="library-tsv"]')]);
        const tsv = fs.readFileSync(await dl.path(), 'utf8').trimEnd().split('\n');
        const head = tsv[0].split('\t');
        const first = Object.fromEntries(head.map((c, i) => [c, tsv[1].split('\t')[i]]));
        assert.equal(first.letters, 'A=A01,B=A02');
        assert.equal(first.kept_annotator_ids, 'A01,A02');
        // an entry opens at its moment, read only, with the decision; its adjudicator can reopen it
        await page.selectOption('[data-section="library"] select[data-filter="pair"]', '');
        await page.waitForFunction(() => document.querySelectorAll('[data-section="library"] table.admin-list tbody tr').length === 3);
        await page.locator('[data-section="library"] [data-log="library-open"]').nth(2).click();
        await waitForRoute(page, 'expert-adjudicate');
        await page.setInputFiles('input[data-log="file-input"]', filesFor(s.dir, FILE));
        await page.waitForSelector('.adjudication-pass', { timeout: 30000 });
        await waitForTraces(page);
        st = await pass(page);
        assert.equal(st.row, 2);
        assert.equal(await page.locator('.adj-bar').count(), 0, 'read only: no decision bar');
        assert.match(await page.textContent('.adj-detail'), /Kept all/);
        assert.match(await page.textContent('.adjudication-pass h2'), /Adjudicated conflicts/);
        const view = await page.evaluate(() => globalThis.ElectroTag.ws.viewer.view);
        assert.ok(view.startS <= 32 && view.startS + view.durationS >= 32.3, 'the EEG shows the moment of the entry');
        await page.click('.ws-actions [data-log="adjudication-reopen"]');
        await page.waitForSelector('.dialog.reopen-dialog');
        await page.fill('.reopen-dialog input', 'a second look at 32 s');
        await clickDialogButton(page, 'Reopen');
        await page.waitForSelector('.adj-bar', { timeout: 15000 });
        assert.match(await page.textContent('.adj-reopened'), /Reopened: adjudicated version 1 stays the one that counts/);
        assert.equal((await pass(page)).row, 2);
        await focusEeg(page);
        await page.keyboard.press('x');
        await page.keyboard.press('Shift+Digit2');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => { const p = globalThis.ElectroTag.ws.review; return !p.sending && p.conflicts[2].decision.choice === 'none'; }, null, { timeout: 15000 });
        await focusEeg(page);
        await page.keyboard.press('f');
        await clickDialogButton(page, 'Finish adjudication');
        await page.waitForSelector('.dialog .dialog-title:text("Adjudication finished")', { timeout: 30000 });
        assert.match(await page.textContent('.dialog'), /version 2/);
        await clickDialogButton(page, 'OK');
        await waitForRoute(page, 'expert-library');
        assert.equal(fs.readdirSync(folder).length, 10, 'the earlier adjudicated version is kept beside the newer one');
        const audit = await api(s, admin, '/admin/audit', {});
        assert.ok(audit.entries.some((e) => e.op === 'adjudication_reopen'), 'reopening is audited');
      } finally {
        s.stop();
      }
    },
  },
  {
    name: 'three annotators on an iPad held sideways: the bar says all and none, the decision bar stays in view, and each annotator is told what stood',
    async run(t) {
      const { assert } = t;
      const s = await ownStudy();
      try {
        const admin = await login(s, 'ADMIN');
        await api(s, admin, '/admin/user_add', { annotator_id: 'A03', display_name: 'Annotator three', password: 'pass-word-1234', role: 'annotator' });
        await api(s, admin, '/admin/assign', { annotator_ids: ['A03'], recording_ids: [SUB1], mode: 'standard' });
        await api(s, admin, '/admin/training_gate_set', { annotator_id: 'A03', open: true }).catch(() => null); // when the study has a gate
        // all three agree on the blink and the EMG; only A02 marks a blink at 20 s
        const both = [ann('1'.repeat(32), 'Eye-blink-artifact', 500, 100, ['Fp1', 'Fp2']), ann('2'.repeat(32), 'EMG-artifact', 3000, 250)];
        await save(s, 'A01', both);
        await save(s, 'A02', [...both.map((a) => ({ ...a, annotation_id: a.annotation_id.replace(/./g, (c) => String(Number(c) + 2)) })),
          ann('9'.repeat(32), 'Eye-blink-artifact', 5000, 100)]);
        await save(s, 'A03', both.map((a) => ({ ...a, annotation_id: a.annotation_id.replace(/./g, (c) => String(Number(c) + 4)) })), 'pass-word-1234');
        const page = await t.newPage({ url: s.base, width: 1194, height: 834, ipad: true });
        await signIn(page, 'E01', PASSWORD);
        await waitForRoute(page, 'home');
        await page.evaluate(() => globalThis.ElectroTag.showExpert('expert-queue'));
        const row = page.locator('[data-section="queue"] tr', { hasText: FILE });
        await row.waitFor({ timeout: 20000 });
        assert.match(await row.textContent(), /A01, A02 and A03/);
        await row.locator('button[data-log="adjudication-start"]').click();
        await waitForRoute(page, 'expert-adjudicate');
        await page.setInputFiles('input[data-log="file-input"]', filesFor(s.dir, FILE));
        await page.waitForSelector('.adjudication-pass', { timeout: 30000 });
        await waitForTraces(page);
        assert.equal((await pass(page)).n, 1);
        assert.deepEqual(await page.locator('.adj-choice').allTextContents().then((x) => x.slice(3, 5)), ['Keep allK', 'NoneX']);
        assert.match(await page.textContent('.adj-whose'), /A A01.*B A02.*C A03/);
        const coarse = await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches);
        const touch = await page.evaluate(async () => (await import('./js/util.js')).touchFirst());
        assert.match(await page.textContent('.ws-hint'), touch ? /^Tap what to keep/ : /^1 to 3 keep a version {2}· {2}K all {2}· {2}X none/);
        // the keys are said for three versions (the hint of a keyboard)
        assert.match(await page.evaluate(async () => (await import('./js/expert/model.js')).hintText(['A', 'B', 'C'])), /^1 to 3 keep a version {2}· {2}K all {2}· {2}X none/);
        if (coarse) assert.equal(await page.locator('.adj-choice .chip-key').first().isVisible(), false, 'no keyboard hints without a keyboard');
        const saveVisible = await page.evaluate(() => {
          const top = document.querySelector('.adj-top').getBoundingClientRect();
          const r = document.querySelector('[data-log="adjudication-save"]').getBoundingClientRect();
          return r.top >= top.top - 1 && r.bottom <= top.bottom + 1 && r.bottom <= innerHeight && r.height >= 40;
        });
        assert.ok(saveVisible, 'Save is whole and in view, with a finger-sized target');
        await t.screenshot(page, 'adjudication_ipad');
        // keep A: A01 had no mark there, so no mark is kept
        await page.click('.adj-choice[data-choice="A"]');
        await page.click('.adj-reasons [data-reason="not_artifact"]');
        await page.click('[data-log="adjudication-save"]');
        await decided(page, 1);
        await page.click('.ws-actions [data-log="adjudication-finish"]');
        await clickDialogButton(page, 'Finish adjudication');
        await page.waitForSelector('.dialog .dialog-title:text("Adjudication finished")', { timeout: 30000 });
        await clickDialogButton(page, 'OK');
        const outcome = async (id, pw = PASSWORD) => {
          const token = (await api(s, null, '/login', { annotator_id: id, password: pw })).token;
          return (await api(s, token, '/me/feedback')).adjudications.items[0].conflicts[0].decision.outcome;
        };
        // from what was kept, not from the letter chosen: A03 had no mark either, so what A03 did stood
        assert.deepEqual([await outcome('A01'), await outcome('A02'), await outcome('A03', 'pass-word-1234')], ['yours_kept', 'none_kept', 'yours_kept']);
        const a3 = await t.newPage({ url: s.base, width: 1194, height: 834, ipad: true });
        await signIn(a3, 'A03', 'pass-word-1234');
        await waitForRoute(a3, 'home');
        await a3.waitForSelector('.outcomes-card');
        await a3.click('.outcomes-card details summary');
        const said = await a3.textContent('.outcomes-card');
        assert.match(said, /No mark here, as you had it/);
        assert.match(said, /1 decided: 1 as you had it\./);
        assert.doesNotMatch(said, /[Bb]oth|colleague's mark was kept/);
      } finally {
        s.stop();
      }
    },
  },
];
