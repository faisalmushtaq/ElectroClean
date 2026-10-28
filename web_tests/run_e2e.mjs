// End-to-end tests of the browser application, with Playwright.
//
//   node web_tests/run_e2e.mjs [name-filter] [--screenshots DIR] [--scale N] [--headed]
//
// --scale draws pages at N device pixels per CSS pixel (2 for a retina screen) for screenshots to
// review; tests that choose their own scale keep it.
//
// Serves electroclean/web/static with `python -m http.server`, runs a stand-in study server
// (GET /api/v1/health, POST /login and the few calls the sign-in needs, as docs/web/api.md) and a
// second static server whose config.json each test can set, and (for h_study_server) the real
// demonstration server, `electroclean-web demo`, then runs web_tests/e2e/*.e2e.mjs.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const STATIC = path.join(REPO, 'electroclean', 'web', 'static');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const shotsDir = opt('--screenshots') || process.env.ELECTROCLEAN_SCREENSHOTS || null;
const headed = args.includes('--headed');
const defaultScale = Number(opt('--scale')) || 1;
const filter = args.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--screenshots', '--scale'].includes(args[i - 1]))) || '';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitForHttp(url, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ }
    if (Date.now() - t0 > ms) throw new Error(`${url} did not start`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ------------------------------------------------------------ the stand-in study server
function stubStudy(catalogue) {
  const state = { requests: [], tokens: new Set(), events: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    state.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-ElectroClean',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      Vary: 'Origin',
    };
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const p = url.pathname;
    if (p === '/api/v1/health') return send(200, { ok: true, version: '1.1.0', study: 'Stub study', demo: false });
    if (req.headers['x-electroclean'] !== '1') return send(400, { error: 'missing_header', message: 'X-ElectroClean header missing' });
    if (p === '/api/v1/login' && req.method === 'POST') {
      const b = JSON.parse(body || '{}');
      if (b.annotator_id === 'S01' && b.password === 'secret') {
        const token = `tok-${state.tokens.size + 1}`;
        state.tokens.add(token);
        return send(200, { token, expires_in_s: 43200, annotator_id: 'S01', display_name: 'Stub annotator', role: 'annotator' });
      }
      return send(401, { error: 'bad_credentials', message: 'The annotator ID or password is not right.' });
    }
    const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!state.tokens.has(auth)) return send(401, { error: 'not_signed_in', message: 'Please sign in again.' });
    if (p === '/api/v1/me') {
      return send(200, { annotator_id: 'S01', display_name: 'Stub annotator', role: 'annotator', programme: null, catalogue,
        study: { study_id: 'stub', name: 'Stub study', filters: { highpass_enabled: true, highpass_hz: 1, notch_enabled: true, notch_hz: 50, notch_harmonics: false, locked: true },
          display: { duration_s: 10, n_channels: 32 }, annotation: { min_duration_samples: 1, quick_labels: [] },
          logging: { interactions: true, pointer_hz: 5, idle_after_s: 30 }, logging_notice: 'This study records how you use ElectroClean, never what you type.' } });
    }
    if (p === '/api/v1/assignments') return send(200, { items: [], next: null });
    if (p === '/api/v1/visits') return send(200, { visit_id: 'v-1', logging: { interactions: true, pointer_hz: 5, idle_after_s: 30 } });
    if (p.startsWith('/api/v1/visits/')) { if (p.endsWith('/events')) state.events.push(...JSON.parse(body).events); return send(200, {}); }
    if (p === '/api/v1/logout') { state.tokens.delete(auth); return send(200, {}); }
    return send(404, { error: 'not_found', message: `No ${p}` });
  });
  return { server, state };
}

// ------------------------------------------------- a static server with its own config.json
function configStatic() {
  const state = { config: null };
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    if (p === '/config.json') {
      if (!state.config) { res.writeHead(404); res.end('no config'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.config));
      return;
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(STATIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(STATIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return { server, state };
}

// ------------------------------------------- the real study server (electroclean-web demo)
// Started only when a test needs it (h_study_server) and the project's Python has the server's
// packages; the test is skipped otherwise.
async function studyServer(python) {
  const check = spawn(python, ['-c', 'import fastapi, uvicorn, mne'], { stdio: 'ignore' });
  const usable = await new Promise((r) => check.on('exit', (code) => r(code === 0)));
  if (!usable) return null;
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ec-study-'));
  const proc = spawn(python, ['-m', 'electroclean.web.cli', 'demo', '--dir', path.join(dir, 'demo'), '--host', '127.0.0.1', '--port', String(port), '--fresh'],
    { cwd: dir, env: { ...process.env, PYTHONPATH: REPO }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const base = `http://127.0.0.1:${port}/`;
  try {
    await waitForHttp(`${base}api/v1/health`, 300000);
  } catch (exc) {
    proc.kill();
    throw new Error(`the demonstration server did not start:\n${stderr}`);
  }
  return { base, dir: path.join(dir, 'demo'), proc, cleanup: () => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// ---------------------------------------------------------------------------- running
async function main() {
  const [port, apiPort, cfgPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const venv = path.join(REPO, '.venv', 'bin', 'python');
  const python = process.env.ELECTROCLEAN_PYTHON || (fs.existsSync(venv) ? venv : 'python3');
  const py = spawn(python, ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', STATIC], { stdio: ['ignore', 'ignore', 'pipe'] });
  // http.server logs every request to stderr: read it (keeping the end for diagnostics), or the pipe
  // fills up after a few hundred requests and the server stops answering.
  let staticLog = '';
  py.stderr.on('data', (d) => { staticLog = (staticLog + d).slice(-4000); });
  const { CATALOGUE } = await import(pathToFileURL(path.join(STATIC, 'js', 'api', 'demo_catalogue.js')).href);
  const stub = stubStudy(CATALOGUE);
  const cfg = configStatic();
  await new Promise((r) => stub.server.listen(apiPort, '127.0.0.1', r));
  await new Promise((r) => cfg.server.listen(cfgPort, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}/`;
  await waitForHttp(base).catch((exc) => { throw new Error(`${exc.message}\n${staticLog}`); });
  const browser = await chromium.launch({ headless: !headed });
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
  const specs = fs.readdirSync(path.join(HERE, 'e2e')).filter((f) => f.endsWith('.e2e.mjs') && f.includes(filter)).sort();
  const study = specs.some((f) => f.includes('study_server')) ? await studyServer(python) : null;
  let failed = 0;
  for (const file of specs) {
    const mod = await import(pathToFileURL(path.join(HERE, 'e2e', file)).href);
    const tests = mod.tests || [];
    for (const t of tests) {
      const pages = [];
      const openPages = [];
      const errors = [];
      const ctx = {
        assert, base, api: `http://127.0.0.1:${apiPort}`, cfgBase: `http://127.0.0.1:${cfgPort}/`, stub: stub.state, cfg: cfg.state, study,
        shots: shotsDir, errors,
        async newPage({ width = 1600, height = 950, url = base, scale = defaultScale } = {}) {
          const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, acceptDownloads: true, locale: 'en-GB' });
          const page = await context.newPage();
          page.on('pageerror', (e) => errors.push(`pageerror: ${(e.stack || e.message).split("\n").slice(0, 4).join(" | ")}`));
          page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(`console: ${m.text()}`); });
          pages.push(context);
          openPages.push(page);
          if (url) await page.goto(url);
          return page;
        },
        async screenshot(page, name) {
          if (!shotsDir) return;
          const vp = page.viewportSize();
          await page.waitForTimeout(150);
          await page.screenshot({ path: path.join(shotsDir, `${name}_${vp.width}x${vp.height}.png`) });
        },
      };
      const t0 = Date.now();
      if (t.needs === 'study' && !study) {
        console.log(`skip ${file} › ${t.name} (the study server needs the packages of requirements.txt)`);
        continue;
      }
      try {
        await t.run(ctx);
        if (errors.length) throw new Error(`errors in the page:\n  ${errors.join('\n  ')}`);
        console.log(`ok   ${file} › ${t.name} (${Date.now() - t0} ms)`);
      } catch (exc) {
        if (exc && exc.skip) {
          // A test that needs something this copy does not have yet (helpers.mjs, SkipTest).
          console.log(`skip ${file} › ${t.name} (${exc.message})`);
          continue;
        }
        failed += 1;
        console.log(`FAIL ${file} › ${t.name}\n     ${String(exc && exc.stack || exc).split('\n').slice(0, 6).join('\n     ')}`);
        // What each page showed when the test failed, so that a failure on CI can be understood.
        for (const [i, p] of openPages.entries()) {
          const seen = await p.evaluate(() => {
            const shown = (sel) => [...document.querySelectorAll(sel)].filter((e) => !e.hidden && e.offsetParent !== null)
              .map((e) => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean);
            return { route: globalThis.ElectroClean ? globalThis.ElectroClean.route : null, coach: shown('.coach-header, .coach-feedback'),
              dialogs: shown('.dialog'), problems: shown('.banner, .error, .error-banner') };
          }).catch(() => null);
          if (seen) console.log(`     page ${i + 1}: ${JSON.stringify(seen)}`);
          if (shotsDir) await p.screenshot({ path: path.join(shotsDir, `FAIL_${file.replace('.e2e.mjs', '')}_${failed}_${i + 1}.png`) }).catch(() => {});
        }
      } finally {
        for (const c of pages) await c.close().catch(() => {});
      }
    }
  }
  await browser.close();
  if (study) study.cleanup();
  py.kill();
  stub.server.close();
  cfg.server.close();
  console.log(failed ? `\n${failed} test(s) failed` : '\nall end-to-end tests passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
