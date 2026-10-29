// The browser application with a study on Firebase, on the Firebase Emulator Suite: the
// administrator's commands set up the study, then an annotator signs in with email and password,
// opens a recording from disk, annotates and saves, a trainee works through guided training and a
// practice recording, and the results are exported into ElectroClean's folders.
//
// Run it with scripts/test_web_firebase.sh, which starts the Auth, Firestore and Functions emulators
// and runs this file inside `firebase emulators:exec`. Nothing reaches a real Firebase project: the
// project ID starts with "demo-", which the emulators keep entirely local. The Firebase SDK itself is
// loaded from www.gstatic.com, as on GitHub Pages.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { signIn, waitForRoute, waitForTraces, annotations, eegPoint, drag, clickDialogButton, pressSave } from './e2e/helpers.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const STATIC = path.join(REPO, 'electroclean', 'web', 'static');
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-electroclean';
const STUDY = 'webtest';
const PASSWORD = 'electroclean-test';
const PYTHON = process.env.PYTHON || 'python3';
const shotsDir = process.argv.includes('--screenshots') ? process.argv[process.argv.indexOf('--screenshots') + 1] : null;

for (const name of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
  if (!process.env[name]) throw new Error(`${name} is not set: run this with scripts/test_web_firebase.sh`);
}
const functionsHost = process.env.ELECTROCLEAN_FUNCTIONS_HOST || '127.0.0.1:5001';

function py(...args) {
  const r = spawnSync(PYTHON, ['-m', 'electroclean.web.cli', ...args], { cwd: WORK, env: { ...process.env, PYTHONPATH: REPO }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`electroclean-web ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

const store = ['--firebase-project', PROJECT, '--study', STUDY];
const WORK = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ec-firebase-'));

function setUpStudy() {
  // The demonstration's recordings, then the commands of docs/web/firebase.md.
  py('demo', '--dir', path.join(WORK, 'demo'), '--no-serve');
  const demo = path.join(WORK, 'demo');
  py('init-study', ...store, '--name', 'Browser on Firebase');
  py('register', path.join(demo, 'recordings', 'study'), ...store);
  py('register', path.join(demo, 'training-source'), ...store);
  py('add-user', 'A01', ...store, '--email', 'a01@example.org', '--password', PASSWORD, '--name', 'Annotator one');
  py('add-user', 'T01', ...store, '--email', 't01@example.org', '--password', PASSWORD, '--name', 'Trainee one');
  py('add-user', 'ADMIN', ...store, '--email', 'admin@example.org', '--password', PASSWORD, '--name', 'Study lead', '--admin');
  py('assign', 'A01', '--all', ...store);
  py('assign', 'T01', '--programme', 'example', ...store);
  return demo;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** The application with a config.json for the study on the emulators. */
function staticServer(config) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  return http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/config.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(config));
      return;
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(STATIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(STATIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

function filesFor(demo, fileName) {
  const stem = fileName.replace(/\.(vhdr|edf|bdf)$/i, '');
  const found = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.startsWith(stem) && /\.(vhdr|vmrk|eeg|edf|bdf)$/i.test(f)) found.push(p);
    }
  })(path.join(demo, 'recordings'));
  return found;
}

async function main() {
  const demo = setUpStudy();
  const port = await freePort();
  const config = {
    firebase: { apiKey: 'demo-api-key', authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT, appId: '1:1:web:1' },
    study: STUDY, functions_region: 'europe-west2',
    emulators: { auth: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, functions: functionsHost },
  };
  const server = staticServer(config);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  const errors = [];
  let failed = 0;

  let lastPage = null;
  async function newPage() {
    const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, locale: 'en-GB' });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(`console: ${m.text()}`); });
    await page.goto(base);
    lastPage = page;
    return page;
  }
  async function shot(page, name) { if (shotsDir) { fs.mkdirSync(shotsDir, { recursive: true }); await page.screenshot({ path: path.join(shotsDir, `firebase_${name}.png`) }); } }
  async function openFile(page, fileName) {
    await waitForRoute(page, 'open');
    await page.setInputFiles('input[data-log="file-input"]', filesFor(demo, fileName));
  }
  async function saveAndFinish(page) {
    await pressSave(page);
    await clickDialogButton(page, 'Save and Finish');
  }
  const coach = async (page) => (await page.textContent('.coach')).replace(/\s+/g, ' ');
  const waitForCoach = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.coach')?.textContent || ''), re.source, { timeout: 30000 });

  const tests = [
    ['an annotator signs in with email, opens a recording from disk and saves it', async () => {
      const page = await newPage();
      await page.waitForSelector('#signin-id[type="email"]');
      await shot(page, 'signin');
      await signIn(page, 'a01@example.org', 'wrong password');
      await page.waitForFunction(() => /not right/.test(document.querySelector('form.signin-form')?.textContent || ''));
      await signIn(page, 'a01@example.org', PASSWORD);
      await waitForRoute(page, 'home', 30000);
      assert.match(await page.textContent('main'), /0 of 3\s*recordings done/);
      await page.click('[data-log="open-next"]');
      await waitForRoute(page, 'open');
      const name = (await page.textContent('main h1')).replace(/^Open\s+/, '').trim();
      await openFile(page, name);
      await waitForRoute(page, 'annotate', 60000);
      await waitForTraces(page);
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
      assert.equal((await annotations(page)).length, 1);
      assert.equal(await page.evaluate(() => globalThis.ElectroClean.ws.s.saveRemote({ force: true })), true);
      await shot(page, 'annotate');
      await saveAndFinish(page);
      await waitForRoute(page, 'home', 60000);
      await clickDialogButton(page, 'Back to my recordings');
      assert.match(await page.textContent('main'), /1 of 3\s*recordings done/);
      // The functions give the history and the achievements (ec_assignments' saved, ec_achievements).
      assert.match(await page.textContent('.progress-card [data-stat="done"]'), /^1 of 3/);
      await page.click('.rec-tabs [data-tab="history"]');
      await page.locator('.recordings-card table.history tbody tr button', { hasText: 'Open to revise' }).waitFor();
      await page.evaluate(() => globalThis.ElectroClean.flushLog());
    }],
    ['a trainee is guided by the functions and a practice recording is scored', async () => {
      const page = await newPage();
      await signIn(page, 't01@example.org', PASSWORD);
      await waitForRoute(page, 'training', 30000);
      const startNext = async () => {
        await page.locator('main.training .btn.primary').first().click();
        await openFile(page, (await page.textContent('main h1')).replace(/^Open\s+/, '').trim());
        await waitForRoute(page, 'annotate', 60000);
        await waitForTraces(page);
      };
      const showMeToTheEnd = async () => {
        for (let i = 0; i < 20 && !/Recording complete/.test(await coach(page)); i++) {
          await page.locator('.coach button', { hasText: 'Show me' }).click();
          await waitForCoach(page, /This is how the experts marked it/);
          const before = await page.textContent('.coach-header');
          await page.keyboard.press('Enter');
          await page.waitForFunction((h) => document.querySelector('.coach-header')?.textContent !== h, before, { timeout: 30000 });
        }
        await waitForCoach(page, /Recording complete/);
      };
      await startNext();
      await waitForCoach(page, /Step 1 of 6/);
      await page.keyboard.press('3');
      await drag(page, await eegPoint(page, 1.0), await eegPoint(page, 1.4));
      await waitForCoach(page, /Nothing is marked at 1\.00–1\.40 s/);
      await shot(page, 'guided_wrong');
      await page.keyboard.press('Control+z');
      await showMeToTheEnd();
      await saveAndFinish(page);
      await waitForRoute(page, 'training', 60000);
      assert.match(await page.textContent('main.training'), /Recording saved: 6 of 18 stars/);
      await startNext();
      await showMeToTheEnd();
      await saveAndFinish(page);
      await waitForRoute(page, 'training', 60000);
      // Practice: scored by the function, with the experts' annotations revealed for the review.
      await startNext();
      await page.keyboard.press('2');
      await drag(page, await eegPoint(page, 4.1), await eegPoint(page, 4.5));
      await saveAndFinish(page);
      await waitForRoute(page, 'review', 120000);
      const review = (await page.textContent('.review')).replace(/\s+/g, ' ');
      assert.match(review, /Not yet: you need 80% for finding the artifacts and for their types/);
      assert.match(review, /You found 0 of 15 reference artifacts/);
      await shot(page, 'practice_review');
      await page.evaluate(() => globalThis.ElectroClean.flushLog());
    }],
    ['a lead researcher runs the study from the admin area on Firebase', async () => {
      const page = await newPage();
      await signIn(page, 'admin@example.org', PASSWORD);
      await waitForRoute(page, 'admin', 60000);
      await page.waitForSelector('.stat-tile', { timeout: 60000 });
      assert.match((await page.innerText('.admin-main')).replace(/\s+/g, ' '), /\d+ Recordings registered for the study/i); // the label is shown in capitals
      const go = async (title, route) => { await page.locator('.admin-nav a', { hasText: title }).click(); await waitForRoute(page, route); };

      // An annotator invited by email: Firebase Authentication makes the account, the page shows the link once.
      await go('Annotators', 'admin-annotators');
      const form = page.locator('form.admin-form').first();
      await form.locator('input').nth(0).fill('A07');
      await form.locator('input').nth(1).fill('Annotator seven');
      await form.locator('input[type="email"]').fill('a07@example.org');
      await page.click('[data-log="user-add"]');
      await page.waitForSelector('.secret-value', { timeout: 60000 });
      assert.match(await page.textContent('.secret-value'), /^https?:\/\//);
      await page.waitForSelector('tr[data-key="A07"]', { timeout: 60000 });
      // Firebase's own link counts as an invitation, and Progress reads the study through the function.
      await page.click('.admin-section[data-section="annotators"] [data-tab="invitations"]');
      await page.waitForFunction(() => /Invited on/.test(document.querySelector('[data-panel="invitations"] tr[data-key="A07"]')?.innerText || ''), null, { timeout: 60000 });
      await go('Progress', 'admin-progress');
      await page.waitForSelector('.admin-section[data-section="progress"] .stat-tile', { timeout: 120000 });
      await page.waitForSelector('.admin-section[data-section="progress"] svg.chart-svg');
      await shot(page, 'admin_progress');

      // Recordings chosen on this computer: the study's own, so all three are already registered.
      await go('Recordings', 'admin-recordings');
      await page.setInputFiles('input[data-log="register-folder"]', path.join(demo, 'recordings', 'study'));
      await page.waitForSelector('[data-log="register"]', { timeout: 120000 });
      assert.match(await page.innerText('.admin-review'), /Found 3 recordings/);
      await page.click('[data-log="register"]');
      await page.waitForFunction(() => /skipped 3/.test(document.querySelector('.admin-review')?.innerText || ''), null, { timeout: 120000 });

      // The activity analysis runs in the function, from the interaction logs of the visits above.
      await go('Analyses', 'admin-analyses');
      await page.click('[data-log="activity-run"]');
      await page.waitForSelector('.admin-section[data-section="analyses"] iframe.report-frame', { timeout: 300000 });
      await shot(page, 'admin_activity');

      // The change log names the new account.
      await go('Records', 'admin-records');
      await page.waitForFunction(() => /A07/.test(document.querySelector('.admin-section[data-section="records"]')?.innerText || ''), null, { timeout: 60000 });
    }],
  ];

  try {
    for (const [name, run] of tests) {
      const t0 = Date.now();
      errors.length = 0;
      try {
        await run();
        if (errors.length) throw new Error(`errors in the page:\n  ${errors.join('\n  ')}`);
        console.log(`ok   ${name} (${Date.now() - t0} ms)`);
      } catch (exc) {
        failed += 1;
        if (lastPage) {
          await shot(lastPage, 'failure').catch(() => {});
          const coachNow = await lastPage.textContent('.coach').catch(() => null);
          if (coachNow) console.log(`     the coach said: ${coachNow.replace(/\s+/g, ' ').slice(0, 300)}`);
        }
        console.log(`FAIL ${name}\n     ${String(exc && exc.stack || exc).split('\n').slice(0, 8).join('\n     ')}`);
      }
    }
    if (!failed) {
      // The administrator's export: ElectroClean's usual results folders.
      const out = path.join(WORK, 'export');
      py('export', ...store, '--to', out);
      const root = path.join(out, 'Annotated_Events');
      const expect = [
        path.join('annotator-A01', 'sub-001', 'eeg', 'sub-001_task-rest_eeg_annotator-A01_events.tsv'),
        path.join('training', 'example', 'guided', 'annotator-T01', 'sub-example01', 'eeg', 'sub-example01_task-example_eeg_annotator-T01_events.tsv'),
        path.join('training', 'example', 'practice', 'annotator-T01', 'sub-example03', 'eeg', 'sub-example03_task-example_eeg_annotator-T01_events.tsv'),
        path.join('training_progress', 'example', 'annotator-T01.json'),
      ];
      for (const rel of expect) assert.ok(fs.existsSync(path.join(root, rel)), `the export has no ${rel}`);
      const tsv = fs.readFileSync(path.join(root, expect[0]), 'utf8');
      assert.match(tsv, /\n3\.0\t0\.4\tEye-blink-artifact\tn\/a\t750\t\[\]\t103\telectroclean_artifact\t[0-9a-f]+\tA01\t/);
      const logs = path.join(root, 'interaction_logs', 'annotator-A01');
      const lines = fs.readdirSync(logs).flatMap((f) => fs.readFileSync(path.join(logs, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
      assert.equal(lines[0].type, 'header');
      const kinds = lines.map((e) => e.type);
      assert.equal(kinds.filter((k) => k === 'visit_started').length, 1);
      for (const kind of ['recording_opened', 'annotation_created', 'recording_finished']) assert.ok(kinds.includes(kind), `no ${kind} in the exported log`);
      console.log('ok   the export holds the results and the interaction logs');
    }
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(WORK, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} test(s) failed` : '\nall Firebase end-to-end tests passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
