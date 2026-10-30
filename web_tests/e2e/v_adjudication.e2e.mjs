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

async function save(s, id, annotations) {
  const eeg = filesFor(s.dir, FILE).find((f) => f.endsWith('.eeg'));
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(eeg)).digest('hex');
  await api(s, await login(s, id), '/submissions', { recording_id: SUB1, mode: 'standard', context_id: '', annotations, sha256,
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
        await page.evaluate(async () => { await globalThis.ElectroTag.signOut(); });
        await signIn(page, 'E01', PASSWORD);
        await waitForRoute(page, 'home');
        await page.evaluate(() => globalThis.ElectroTag.showExpert('expert-queue'));
        const row = page.locator('[data-section="queue"] tr', { hasText: FILE });
        await row.waitFor({ timeout: 20000 });
        assert.match(await row.textContent(), /A01 and A02/);
        assert.match(await row.textContent(), /Ready/);
        assert.match(await page.textContent('[data-section="queue"] .adj-summary'), /recordings? ready/);
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
        await t.screenshot(page, 'adjudication_pass');

        // 1: keep B, with a reason written after R; Enter saves and goes on
        await focusEeg(page);
        await page.keyboard.press('2');
        assert.equal((await pass(page)).choice, 'B');
        await page.keyboard.press('Enter'); // a reason is needed first: the field takes the focus
        await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains('adj-reason'));
        await page.keyboard.type('The eyes move sideways');
        await page.keyboard.press('Enter');
        await decided(page, 1);
        st = await pass(page);
        assert.equal(st.row, 1);
        // 2: neither, with a reason chip
        await focusEeg(page);
        await page.keyboard.press('x');
        await page.click('.adj-reasons [data-reason="not_artifact"]');
        await focusEeg(page);
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
        await page.click('.adj-reasons [data-reason="both_valid"]');
        await focusEeg(page);
        await page.keyboard.press('Enter');
        await decided(page, 3);
        // P goes back; a decision can be changed until the end: E replaces the marks with one of the adjudicator's own
        await page.keyboard.press('p');
        await page.waitForSelector('.adj-item.current[data-decided="yes"]');
        assert.equal((await pass(page)).row, 1);
        await page.keyboard.press('e');
        await page.waitForSelector('.adj-edit:not([hidden]) select.adj-edit-label');
        await page.fill('.adj-edit input.adj-edit-time >> nth=0', '19.9');
        await page.fill('.adj-edit input.adj-edit-time >> nth=1', '20.5');
        await page.focus('.adj-edit input.adj-edit-time >> nth=1');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => {
          const p = globalThis.ElectroTag.ws.review;
          return !p.sending && p.conflicts[1].decision && p.conflicts[1].decision.choice === 'edited';
        }, null, { timeout: 15000 });
        assert.ok(await page.locator('.ws-actions [data-log="adjudication-finish"]:not([hidden])').count(), 'Finish shows once all are decided');
        await t.screenshot(page, 'adjudication_decided');
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
          [['Eye-movement-artifact', 500, 100], ['EMG-artifact', 3000, 250], ['Eye-blink-artifact', 4975, 150], ['Eye-blink-artifact', 8000, 75]]);
        assert.deepEqual(originals.map(checksums), before, 'the versions compared are never changed');
        const fb = await api(s, await login(s, 'A01'), '/me/feedback');
        assert.deepEqual(fb.adjudications.items[0].conflicts.map((c) => c.decision.outcome), ['other_kept', 'edited', 'all_kept']);
        assert.equal(fb.adjudications.items[0].conflicts[0].decision.reason, 'The eyes move sideways');
        // ... and on A01's home page, in plain words, nobody named
        const annotator = await t.newPage({ url: s.base, width: 1440, height: 900 });
        await signIn(annotator, 'A01', PASSWORD);
        await waitForRoute(annotator, 'home');
        await annotator.waitForSelector('.outcomes-card', { timeout: 15000 });
        await annotator.click('.outcomes-card details summary');
        const said = await annotator.textContent('.outcomes-card');
        assert.match(said, /3 conflicts decided: 1 another version kept, 1 both kept, 1 replaced/);
        assert.match(said, /A colleague's mark was kept instead/);
        assert.match(said, /Why: The eyes move sideways/);
        assert.ok(!/A02|E01/.test(said), 'nobody else is named');
        await t.screenshot(annotator, 'adjudication_outcomes_home');

        // the library: filter by the confused pair, open nothing, promote the first entry to a quiz item
        await page.evaluate(() => globalThis.ElectroTag.showExpert('expert-library'));
        await page.waitForSelector('[data-section="library"] table.admin-list tbody tr');
        assert.equal(await page.locator('[data-section="library"] table.admin-list tbody tr').count(), 3);
        await page.selectOption('[data-section="library"] select[data-filter="pair"]', 'Eye-blink-artifact | Eye-movement-artifact');
        await page.waitForFunction(() => document.querySelectorAll('[data-section="library"] table.admin-list tbody tr').length === 1);
        assert.match(await page.textContent('[data-section="library"] table.admin-list tbody'), /Kept B \(A02\)/);
        await t.screenshot(page, 'adjudication_library');
        await page.click('[data-section="library"] [data-log="library-promote"]');
        await page.waitForSelector('.dialog.promote-dialog');
        assert.equal(await page.inputValue('.promote-dialog select >> nth=2'), 'Eye-movement-artifact');
        await t.screenshot(page, 'adjudication_promote');
        await clickDialogButton(page, 'Promote');
        await page.waitForSelector('[data-section="library"] .admin-msg .success', { timeout: 15000 });
        assert.match(await page.textContent('[data-section="library"] .admin-msg'), /Added as quiz item q\d+ of/);
        // promoted again: the item already made
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
        // an entry opens at its moment, read only, with the decision
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
        const view = await page.evaluate(() => globalThis.ElectroTag.ws.viewer.view);
        assert.ok(view.startS <= 32 && view.startS + view.durationS >= 32.3, 'the EEG shows the moment of the entry');
        await page.click('.ws-title button.back');
        await waitForRoute(page, 'expert-library');
      } finally {
        s.stop();
      }
    },
  },
];
