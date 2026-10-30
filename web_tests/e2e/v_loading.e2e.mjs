// Loading on demand (js/lazy.js, docs/web/architecture.md "Loading on demand"): the sign-in page
// loads only what it shows and the chosen back end's client, within a budget of JavaScript that
// catches a view creeping back into it; the open view and the annotation view arrive in idle time
// after signing in; and a part that cannot be loaded says so, with Try again.
import { signIn, waitForRoute, openExample } from './helpers.mjs';

/**
 * At most this much JavaScript (uncompressed, in KB of 1024 bytes) on the sign-in page. Measured on
 * 29 October 2026: 130 KB with a study server, 430 KB in the demonstration, which also loads its
 * own back end (js/api/demo*.js and what they use). On 30 October the roles and the expert account
 * brought them to 132 KB and 447 KB (the sandbox's expert operations and the newer settings' checks
 * load only when used); loading the sandbox's admin half only for its administrator is the way down.
 */
const SIGNIN_BUDGET_KB = { server: 140, demo: 455 };

/**
 * Modules that belong to later views and must not load with the sign-in page (the demonstration's
 * back end uses a few small helpers of theirs, such as viewer/coverage.js, which are not listed).
 */
const LATER = [/\/js\/annotate\/(workspace|session|store)\.js$/, /\/js\/viewer\/(viewer|geometry|touch|head_map)\.js$/, /\/js\/admin\/area\.js$/,
  /\/js\/training\/(quiz|path|coach)\.js$/, /\/js\/eeg\/(recording|engine|edf|brainvision|filters)\.js$/, /\/js\/views\/(home|open|device|home_games)\.js$/,
  /\/js\/games\/milestones\.js$/];

/** Every JavaScript file a page fetches, with its size: [{path, bytes}]. */
function scriptsOf(page) {
  const seen = new Map();
  page.on('response', async (res) => {
    const u = new URL(res.url());
    if (!u.pathname.endsWith('.js') || seen.has(u.pathname)) return;
    seen.set(u.pathname, 0);
    try { seen.set(u.pathname, (await res.body()).length); } catch { /* a failed load has no body */ }
  });
  return () => [...seen].map(([path, bytes]) => ({ path, bytes }));
}

async function signinScripts(t, url, budget) {
  const page = await t.newPage({ url: null });
  const scripts = scriptsOf(page);
  await page.goto(url);
  await page.waitForSelector('form.signin-form button[type="submit"]');
  await page.waitForLoadState('networkidle');
  const list = scripts();
  const kb = list.reduce((n, s) => n + s.bytes, 0) / 1024;
  console.log(`     ${list.length} modules, ${kb.toFixed(0)} KB of JavaScript (budget ${budget} KB)`);
  t.assert.ok(kb <= budget, `the sign-in page loads ${kb.toFixed(0)} KB of JavaScript, more than its budget of ${budget} KB: ${list.map((s) => s.path).join(', ')}`);
  const later = list.filter((s) => LATER.some((re) => re.test(s.path))).map((s) => s.path);
  t.assert.deepEqual(later, [], 'the sign-in page loads only what it shows');
  return page;
}

export const tests = [
  {
    name: 'the sign-in page of a study server loads only itself and the server\'s client, within its budget',
    async run(t) {
      const page = await signinScripts(t, `${t.base}?server=${encodeURIComponent(t.api)}`, SIGNIN_BUDGET_KB.server);
      const list = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname));
      t.assert.ok(!list.some((p) => /\/js\/api\/(demo|firebase)/.test(p)), 'neither the demonstration nor Firebase is loaded for a study server');
    },
  },
  {
    name: 'the demonstration\'s sign-in page stays within its budget; after signing in the open view and the annotation view arrive in idle time',
    async run(t) {
      const page = await signinScripts(t, t.base, SIGNIN_BUDGET_KB.demo);
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      // The parts fetched in idle time (js/lazy.js keeps the list).
      const wanted = ['home', 'open', 'device', 'deviceStore', 'session', 'workspace'];
      let got = [];
      for (let i = 0; i < 100 && !wanted.every((p) => got.includes(p)); i++) {
        if (i) await page.waitForTimeout(200);
        got = await page.evaluate(async () => (await import(new URL('js/lazy.js', location.href).href)).loadedParts());
      }
      t.assert.deepEqual(wanted.filter((p) => !got.includes(p)), [], 'the annotation view arrives in idle time');
      const fetched = [];
      page.on('request', (r) => { if (new URL(r.url()).pathname.endsWith('.js')) fetched.push(new URL(r.url()).pathname); });
      await openExample(page, 0);
      t.assert.deepEqual(fetched, [], 'opening a recording needs no new download');
    },
  },
  {
    name: 'a part that cannot be loaded says so with Try again; while it loads the page says Loading',
    async run(t) {
      const page = await t.newPage();
      const isHome = (u) => u.pathname.endsWith('/js/views/home.js');
      await page.route(isHome, (r) => r.abort('internetdisconnected'));
      await signIn(page, 'A01');
      await page.waitForSelector('[data-view="load-failed"]');
      t.assert.match(await page.textContent('[data-view="load-failed"]'), /could not be loaded.*internet connection.*Try again/s);
      await t.screenshot(page, 'load_failed');
      // The connection is back, slowly: Try again shows Loading… until the home page is there.
      await page.unroute(isHome);
      let release;
      let asked = '';
      const held = new Promise((r) => { release = r; });
      await page.route(isHome, async (r) => {
        asked = r.request().url();
        await held;
        await r.continue();
      });
      await page.click('[data-log="load-again"]');
      await page.waitForSelector('main.page.loading [role="status"]');
      t.assert.match(await page.textContent('main.page.loading'), /Loading…/);
      await t.screenshot(page, 'loading');
      for (let i = 0; i < 50 && !asked; i++) await page.waitForTimeout(100);
      release();
      t.assert.match(asked, /home\.js\?attempt=\d+$/, 'the part is asked for again under another address');
      await page.waitForSelector('.view.home');
      await waitForRoute(page, 'home');
    },
  },
  {
    name: 'a bookmarked section of the admin area opens after signing in, its part loaded then',
    async run(t) {
      const page = await t.newPage({ url: `${t.base}#admin-recordings` });
      const scripts = scriptsOf(page);
      await page.waitForSelector('#signin-id');
      t.assert.ok(!scripts().some((s) => /\/js\/admin\/area\.js$/.test(s.path)), 'the admin area waits for an administrator');
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin-recordings', 20000);
      t.assert.ok(scripts().some((s) => /\/js\/admin\/area\.js$/.test(s.path)));
    },
  },
];
