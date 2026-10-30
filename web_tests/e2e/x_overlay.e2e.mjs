// Everyone's marks on one recording (js/expert/overlay.js), on a study server of the test's own (electrotag-web
// demo in a fresh folder, so that what other specs save does not change who marked what).
//
// Three people: E01 opens Saved work, Everyone beside A01's row, then gives A02 and A03 lanes too; the
// three lanes have distinct colours and patterns and each mark carries its person's ID; the EEG outlines
// each person's marks in their own colour and dash; N steps to the disagreements; the summary downloads
// as TSV. Two hundred people (made and saved through the API): the administrator opens the recording's
// page, Everyone's marks, and the view opens in a few seconds; the crowd's band under Fp1 shows the
// share, the types and who on hover, a click lists everyone there, and Show in a lane promotes one of
// them; a redraw with the crowd stays fast. An annotator is refused. A trainee, once the study allows it, sees
// the unnamed crowd of a training recording for learning with the experts from the training path.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkipTest, signIn, skipFirstStages, waitForRoute, waitForTraces } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'electrotag';
const SUB1 = 'sub-001/eeg/sub-001_task-rest_eeg.vhdr';
const FILE = 'sub-001_task-rest_eeg.vhdr';
const N_CROWD = 200;
// the speed rules: everyone's marks loaded and the view open within OPEN_S of choosing the file; a redraw within REDRAW_MS
const OPEN_S = 8;
const REDRAW_MS = 100;
let seq = 0;
const ann = (label, onset, dur, channels = []) => ({ annotation_id: crypto.createHash('md5').update(String(++seq)).digest('hex'), label, onset_sample: onset,
  duration_samples: dur, channels, created_at: '2026-10-30T10:00:00.000+00:00', modified_at: '2026-10-30T10:00:00.000+00:00' });

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
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'et-overlay-'));
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

const login = async (s, id, password = PASSWORD) => (await api(s, null, '/login', { annotator_id: id, password })).token;

function sha(s) {
  const eeg = filesFor(s.dir, FILE).find((f) => f.endsWith('.eeg'));
  return crypto.createHash('sha256').update(fs.readFileSync(eeg)).digest('hex');
}

async function save(s, id, annotations, password = PASSWORD) {
  const token = await login(s, id, password);
  await api(s, token, '/submissions', { recording_id: SUB1, mode: 'standard', context_id: '', annotations, sha256: sha(s),
    session: { started_at: '2026-10-30T10:00:00.000+00:00', elapsed_s: 60 } });
}

/** Accounts made by the administrator, given SUB1, with the training gate and the sign-up questionnaire off so that
 *  they may save it at once. */
async function people(s, ids, password) {
  const admin = await login(s, 'ADMIN');
  await api(s, admin, '/admin/settings_update', { settings: { training: { gate: 'off' }, questionnaire: { enabled: false } } });
  for (const id of ids) await api(s, admin, '/admin/user_add', { annotator_id: id, display_name: `Person ${id}`, password });
  await api(s, admin, '/admin/assign', { annotator_ids: ids, recording_ids: [SUB1] });
}

/** n at a time, in order. */
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

const view = (page) => page.evaluate(() => {
  const p = globalThis.ElectroTag.ws && globalThis.ElectroTag.ws.pass;
  if (!p || !p.data) return null;
  return { lanes: [...p.laneKeys], crowd: p.crowd.length, total: p.data.people.length, dis: p.list.length, current: p.current,
    layers: p.ws.viewer.layers.map((l) => ({ id: l.id, colour: l.colour, dash: (l.dash || []).join(','), n: l.annotations.length })) };
});

async function openFile(page, s) {
  await page.setInputFiles('input[data-log="file-input"]', filesFor(s.dir, FILE));
  await page.waitForSelector('.overlay-panel', { timeout: 60000 });
  await waitForTraces(page);
}

export const tests = [
  {
    name: 'three people: their own lanes, colours, patterns and names, the disagreements and the summary',
    async run(t) {
      const { assert } = t;
      const s = await ownStudy();
      try {
        await people(s, ['A03'], 'long enough');
        // 250 Hz: everyone marks the blink at 2 s (two of them on Fp1 and Fp2), A02 calls it an eye movement; only A01 marks the EMG
        await save(s, 'A01', [ann('Eye-blink-artifact', 500, 100, ['Fp1', 'Fp2']), ann('EMG-artifact', 3000, 250)]);
        await save(s, 'A02', [ann('Eye-movement-artifact', 510, 90, ['Fp1', 'Fp2'])]);
        await save(s, 'A03', [ann('Eye-blink-artifact', 490, 110)], 'long enough');
        const page = await t.newPage({ url: s.base, width: 1600, height: 950 });
        await signIn(page, 'E01', PASSWORD);
        await waitForRoute(page, 'home');
        await page.evaluate(() => globalThis.ElectroTag.showExpert('expert-work'));
        const row = page.locator('[data-section="work"] tr', { hasText: 'A01' }).first();
        await row.waitFor({ timeout: 20000 });
        await row.locator('button[data-log="work-overlay"]').click();
        await waitForRoute(page, 'expert-overlay');
        await openFile(page, s);
        let st = await view(page);
        assert.deepEqual(st.lanes, ['A01'], 'the person whose row it was has the first lane');
        assert.equal(st.crowd, 2);
        // the others join from the crowd's list
        for (const id of ['A02', 'A03']) await page.click(`.ov-people li[data-person="${id}"] button[data-log="overlay-promote"]`);
        st = await view(page);
        assert.deepEqual(st.lanes, ['A01', 'A02', 'A03']);
        assert.equal(st.crowd, 0);
        assert.equal(await page.locator('.ov-lanes .lane:not(.ov-crowd-lane)').count(), 3);
        // on the EEG: each person outlined in their own colour and dash
        assert.equal(new Set(st.layers.map((l) => l.colour)).size, 3);
        assert.equal(new Set(st.layers.map((l) => l.dash)).size, 3);
        // in the lanes: distinct colours and patterns, the ID on each mark that is wide enough, and a legend
        await page.evaluate(() => globalThis.ElectroTag.ws.viewer.setView({ startS: 0, durationS: 4 }));
        await page.waitForFunction(() => document.querySelectorAll('.ov-lanes .lane-mark').length >= 3);
        const marks = await page.$$eval('.ov-lanes .lane:not(.ov-crowd-lane)', (lanes) => lanes.map((l) => {
          const m = l.querySelector('.lane-mark');
          const cs = m && getComputedStyle(m);
          return { name: l.querySelector('.lane-name').textContent, text: m ? m.textContent : '', bg: cs ? cs.backgroundColor : '', img: cs ? cs.backgroundImage : '' };
        }));
        assert.deepEqual(marks.map((m) => m.name), ['A01', 'A02', 'A03']);
        assert.deepEqual(marks.map((m) => m.text), ['A01', 'A02', 'A03'], 'each mark carries its person\'s ID');
        assert.equal(new Set(marks.map((m) => m.bg)).size, 3, 'three colours');
        assert.equal(new Set(marks.map((m) => m.img)).size, 3, 'three patterns');
        assert.equal(await page.locator('.ov-legend li[data-lane]').count(), 3);
        await t.screenshot(page, 'overlay_three');
        // N: the disagreements (the type at 2 s, the EMG only A01 marked)
        await page.evaluate(() => globalThis.ElectroTag.ws.viewer.over.focus());
        await page.keyboard.press('n');
        st = await view(page);
        assert.ok(st.dis >= 2, `${st.dis} disagreements`);
        assert.equal(st.current, 0);
        assert.match(await page.textContent('.ov-dis'), /^Disagreement 1 of \d+: /);
        await page.keyboard.press('n');
        assert.equal((await view(page)).current, 1);
        await page.keyboard.press('p');
        assert.equal((await view(page)).current, 0);
        // the summary as TSV
        const [download] = await Promise.all([page.waitForEvent('download'), page.click('button[data-log="overlay-tsv"]')]);
        const text = fs.readFileSync(await download.path(), 'utf8');
        assert.match(text.split('\n')[0], /^onset_s\toffset_s\tpeople_marking\tpeople_shown\tshare\tdisagreement\ttypes\tlanes_marking$/);
        assert.ok(text.split('\n').some((l) => /\tEMG-artifact:1\tA01$/.test(l)), 'the EMG only A01 marked');
        // removing a lane puts the person back in the crowd
        await page.click('.ov-legend li[data-lane="A03"] button[data-log="overlay-lane-remove"]');
        st = await view(page);
        assert.deepEqual([st.lanes, st.crowd], [['A01', 'A02'], 1]);
        // Back returns to Saved work
        await page.click('button.back[data-log="close"]');
        await waitForRoute(page, 'expert-work');
      } finally {
        s.stop();
      }
    },
  },
  {
    name: 'two hundred people: the crowd band and its hover, promoting someone, the speed rules, and an annotator refused',
    async run(t) {
      const { assert } = t;
      const s = await ownStudy();
      try {
        const ids = Array.from({ length: N_CROWD }, (_, i) => `C${String(i + 1).padStart(3, '0')}`);
        await people(s, ids, 'long enough');
        // three in four mark a blink on Fp1 and Fp2 near 2 s (a few call it an eye movement); one in two the EMG at 12 s on the whole montage
        await pool(ids, 8, async (id, i) => {
          const marks = [];
          if (i % 4 !== 3) marks.push(ann(i % 10 === 0 ? 'Eye-movement-artifact' : 'Eye-blink-artifact', 480 + (i % 7) * 4, 100 + (i % 5) * 6, ['Fp1', 'Fp2']));
          if (i % 2 === 0) marks.push(ann('EMG-artifact', 3000 + (i % 9) * 10, 250));
          for (let k = 0; k < 6; k++) marks.push(ann('Electrode-pops-artifact', 5000 + ((i * 37 + k * 211) % 9000), 25, ['O1']));
          await save(s, id, marks, 'long enough');
        });
        // an annotator is refused, with words for them
        const a01 = await login(s, 'A01');
        const refused = await fetch(`${s.base}api/v1/expert/overlay_get`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ElectroTag': '1', Authorization: `Bearer ${a01}` },
          body: JSON.stringify({ recording_id: SUB1 }) });
        assert.equal(refused.status, 403);
        assert.match((await refused.json()).message, /does not show trainees other people's marks/);

        const page = await t.newPage({ url: s.base, width: 1600, height: 950 });
        await signIn(page, 'A01', PASSWORD);
        await waitForRoute(page, 'home');
        const inPage = await page.evaluate(async (rid) => {
          try { await globalThis.ElectroTag.backend.expert('overlay_get', { recording_id: rid }); return 'answered'; } catch (exc) { return `${exc.status} ${exc.code}`; }
        }, SUB1);
        assert.equal(inPage, '403 forbidden');
        await page.evaluate(async () => { await globalThis.ElectroTag.signOut(); });

        // the administrator: the recording's page, Everyone's marks
        await signIn(page, 'ADMIN', PASSWORD);
        await waitForRoute(page, 'admin', 30000);
        await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-recordings'));
        await waitForRoute(page, 'admin-recordings');
        const rrow = page.locator('table.admin-list tr', { hasText: FILE }).first();
        await rrow.waitFor({ timeout: 20000 });
        await rrow.locator('button', { hasText: 'Manage' }).click();
        await page.click('button[data-log="recording-overlay"]');
        await page.waitForSelector('input[data-log="file-input"]', { state: 'attached', timeout: 30000 });
        const t0 = Date.now();
        await openFile(page, s);
        const openS = (Date.now() - t0) / 1000;
        const loadMs = await page.evaluate(() => globalThis.ElectroTag.ws.pass.target.loadMs);
        console.log(`     ${N_CROWD} people: marks read in ${Math.round(loadMs)} ms; the view open ${openS.toFixed(1)} s after the file was chosen`);
        assert.ok(openS + loadMs / 1000 < OPEN_S, `opening took ${openS.toFixed(1)} s and ${Math.round(loadMs)} ms`);
        let st = await view(page);
        assert.ok(st.total >= N_CROWD, `${st.total} people`);
        assert.deepEqual(st.lanes, [], 'too many for lanes: everyone is the crowd');
        assert.match(await page.textContent('.ov-count'), new RegExp(`^${st.total} people saved it: 0 in lanes, ${st.total} in the crowd\\.$`));
        assert.ok(await page.locator('.ov-crowd-lane:not([hidden])').count(), 'the whole-montage lane of the crowd');

        // a redraw with the crowd's bands stays fast
        await page.evaluate(() => globalThis.ElectroTag.ws.viewer.setView({ startS: 0, durationS: 10 }));
        const redraw = await page.evaluate(async () => {
          const v = globalThis.ElectroTag.ws.viewer;
          const times = [];
          for (const startS of [0, 2.5, 0, 2.5, 1, 1.5, 0, 2, 0.5, 0]) {
            v.setView({ startS });
            const t1 = performance.now();
            v._dirty = { under: true, traces: true, over: true, overview: true };
            v._render();
            times.push(performance.now() - t1);
            await new Promise((r) => requestAnimationFrame(r));
          }
          times.sort((a, b) => a - b);
          return { median: times[Math.floor(times.length / 2)], crowd: v.stats.crowd };
        });
        console.log(`     redraw with the crowd: ${redraw.median.toFixed(1)} ms (the bands ${redraw.crowd.toFixed(1)} ms)`);
        assert.ok(redraw.median < REDRAW_MS, `a redraw took ${redraw.median.toFixed(1)} ms`);

        // hovering Fp1's band at 2.1 s: the share, the types and who
        const spot = await page.evaluate(() => {
          const v = globalThis.ElectroTag.ws.viewer;
          const p = globalThis.ElectroTag.ws.pass;
          const row = v.channels.findIndex((c) => c.name === 'Fp1');
          const r = v.over.getBoundingClientRect();
          return { x: r.left + v.tToX(2.1), y: r.top + v.rowCentre(row) + v.rowH / 2 - p.bandHeight(v) / 2 };
        });
        await page.mouse.move(spot.x, spot.y);
        await page.waitForSelector('.ov-tip:not([hidden])', { timeout: 5000 });
        const tip = await page.textContent('.ov-tip');
        assert.match(tip, /^Fp1 at 2\.10 s: \d+% of the crowd \(\d+ of \d+\)/);
        assert.match(tip, /Eye-blink-artifact \d+ · Eye-movement-artifact \d+/);
        assert.match(tip, /C\d{3}, C\d{3}.* and \d+ more/);
        await t.screenshot(page, 'overlay_crowd_hover');
        // a click lists everyone there; Show in a lane promotes one
        await page.mouse.click(spot.x, spot.y);
        await page.waitForSelector('.ov-who-dialog');
        const listed = await page.locator('.ov-who-dialog button[data-log="overlay-promote-who"]').count();
        assert.ok(listed >= 100, `${listed} people listed`);
        const first = await page.getAttribute('.ov-who-dialog button[data-log="overlay-promote-who"]', 'data-pick');
        await t.screenshot(page, 'overlay_who');
        await page.click('.ov-who-dialog button[data-log="overlay-promote-who"]');
        await page.waitForFunction((k) => globalThis.ElectroTag.ws.pass.laneKeys.includes(k), first);
        st = await view(page);
        assert.deepEqual(st.lanes, [first]);
        assert.equal(st.crowd, st.total - 1);
        assert.equal(await page.locator('.ov-lanes .lane:not(.ov-crowd-lane)').count(), 1);
        // the type filter: only the EMG's marks
        await page.selectOption('select[data-log="overlay-filter-type"]', 'EMG-artifact');
        assert.ok((await view(page)).layers[0].n <= 1);
        await t.screenshot(page, 'overlay_crowd');
      } finally {
        s.stop();
      }
    },
  },
  {
    name: 'a trainee sees the unnamed crowd of a training recording, once the study allows it',
    async run(t) {
      const { assert } = t;
      const s = await ownStudy();
      try {
        const file = 'sub-example01_task-example_eeg.vhdr';
        const rid = `sub-example01/eeg/${file}`;
        const admin = await login(s, 'ADMIN');
        const data = filesFor(s.dir, file).find((f) => f.endsWith('.eeg'));
        const sha256 = crypto.createHash('sha256').update(fs.readFileSync(data)).digest('hex');
        for (const [id, marks] of [['E01', [ann('Eye-blink-artifact', 500, 100)]], ['A01', [ann('Eye-blink-artifact', 510, 90), ann('EMG-artifact', 2000, 200)]]]) {
          await api(s, admin, '/admin/assign', { annotator_ids: [id], recording_ids: [rid], mode: 'practice', context_id: 'example' });
          await api(s, await login(s, id), '/submissions', { recording_id: rid, mode: 'practice', context_id: 'example', annotations: marks, sha256,
            session: { started_at: '2026-10-30T10:00:00.000+00:00', elapsed_s: 20 } });
        }
        const page = await t.newPage({ url: s.base, width: 1280, height: 800 });
        await signIn(page, 'T01', PASSWORD);
        await page.waitForFunction(() => globalThis.ElectroTag && globalThis.ElectroTag.me);
        // off by default: refused, and no way in
        const off = await page.evaluate(async (r) => {
          try { await globalThis.ElectroTag.backend.expert('overlay_get', { recording_id: r, mode: 'practice', context_id: 'example' }); return 'answered'; } catch (e) { return e.code; }
        }, rid);
        assert.equal(off, 'forbidden');
        await api(s, admin, '/admin/settings_update', { settings: { replay: { trainees_see_crowd: true } } });
        await page.reload();
        await page.waitForFunction(() => globalThis.ElectroTag && globalThis.ElectroTag.me && globalThis.ElectroTag.me.study.replay.trainees_see_crowd === true);
        await page.evaluate(() => globalThis.ElectroTag.showTraining());
        await waitForRoute(page, 'training');
        await skipFirstStages(page);
        await page.waitForSelector('[data-stage="guided"] [data-log="crowd-entry"]', { timeout: 20000 });
        await page.click('[data-stage="guided"] [data-log="crowd-entry"]');
        await page.waitForSelector('.dialog.watch-dialog .watch-list li');
        assert.match(await page.textContent('.watch-list li'), new RegExp(`${file.replace(/\./g, '\\.')}: 2 people`));
        await page.click('.watch-list li button[data-log="crowd-recording"]');
        await waitForRoute(page, 'open');
        await page.setInputFiles('input[data-log="file-input"]', filesFor(s.dir, file));
        await page.waitForSelector('.overlay-panel', { timeout: 60000 });
        await waitForTraces(page);
        const st = await view(page);
        assert.deepEqual(st.lanes, [], 'no lanes for a trainee');
        assert.equal(st.crowd, 2);
        const text = await page.textContent('.overlay-panel');
        assert.doesNotMatch(text, /E01|A01/, 'nobody is named');
        assert.equal(await page.locator('.ov-people, .ov-legend li[data-lane]').count(), 0);
        await t.screenshot(page, 'overlay_trainee');
        await page.click('button.back[data-log="close"]');
        await page.waitForFunction(() => globalThis.ElectroTag.route !== 'open' && !globalThis.ElectroTag.ws);
      } finally {
        s.stop();
      }
    },
  },
];
