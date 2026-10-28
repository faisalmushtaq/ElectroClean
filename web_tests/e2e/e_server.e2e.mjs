// Choosing the study: ?server=, config.json and the Study address field, against a stand-in
// study server; a server that does not answer; and a config.json naming a Firebase project.
import { signIn, waitForRoute } from './helpers.mjs';

async function signInToStub(t, page) {
  await page.waitForSelector('#signin-id');
  t.assert.match(await page.textContent('.signin-card'), /Study: Stub study/);
  await page.fill('#signin-id', 'S01');
  await page.fill('#signin-password', 'wrong');
  await page.click('form.signin-form button[type="submit"]');
  await page.waitForSelector('form.signin-form .error:not([hidden])');
  t.assert.match(await page.textContent('form.signin-form .error'), /not right/);
  await signIn(page, 'S01', 'secret');
  await waitForRoute(page, 'home');
  t.assert.match(await page.textContent('main'), /No recordings are assigned to you/);
}

function checkHeaders(t) {
  const reqs = t.stub.requests;
  const health = reqs.filter((r) => r.path === '/api/v1/health');
  t.assert.ok(health.length >= 1);
  t.assert.ok(health.every((r) => !r.headers.authorization), 'health is asked without a token');
  const me = reqs.filter((r) => r.path === '/api/v1/me').at(-1);
  t.assert.match(me.headers.authorization, /^Bearer tok-\d+$/);
  t.assert.equal(me.headers['x-electroclean'], '1');
  t.assert.ok(!me.headers.cookie, 'no cookies');
}

const FAKE_FIREBASE = {
  'firebase-app.js': 'export function initializeApp(config, name) { return { config, name }; }',
  'firebase-auth.js': `export const browserSessionPersistence = 'SESSION';
    export function getAuth() { return { currentUser: null, authStateReady: async () => {} }; }
    export async function setPersistence() {}
    export async function signInWithEmailAndPassword() { const e = new Error('no'); e.code = 'auth/invalid-credential'; throw e; }
    export async function sendPasswordResetEmail() { globalThis.__resetAsked = true; }
    export async function signOut() {}`,
  'firebase-functions.js': `export function getFunctions(app, region) { return { region }; }
    export function httpsCallable() { return async () => ({ data: {} }); }`,
};

export const tests = [
  {
    name: '?server= picks the study server; requests carry the token and the header',
    async run(t) {
      t.stub.requests.length = 0;
      const page = await t.newPage({ url: `${t.base}?server=${encodeURIComponent(t.api)}` });
      await signInToStub(t, page);
      checkHeaders(t);
      // The address is remembered in this browser (localStorage), the token only for this tab.
      const kept = await page.evaluate(() => [localStorage.getItem('electroclean.server'), Object.keys(sessionStorage)]);
      t.assert.equal(JSON.parse(kept[0]), t.api);
      t.assert.ok(kept[1].includes('electroclean.token'));
      t.assert.ok(!Object.keys(await page.evaluate(() => ({ ...localStorage }))).some((k) => /token/.test(k)));
      await t.screenshot(page, 'home_study');
      await page.click('[data-log="sign-out"]');
      await page.waitForSelector('.signin-card .success');
    },
  },
  {
    name: 'config.json names the study server',
    async run(t) {
      t.stub.requests.length = 0;
      t.cfg.config = { server: t.api };
      const page = await t.newPage({ url: t.cfgBase });
      await signInToStub(t, page);
      checkHeaders(t);
      t.cfg.config = null;
    },
  },
  {
    name: 'the Study address field connects to a server; a dead address says so',
    async run(t) {
      t.stub.requests.length = 0;
      const page = await t.newPage();
      await page.waitForSelector('details.connect');
      await page.click('details.connect summary');
      await page.fill('#study-address', 'http://127.0.0.1:9');
      await page.click('.connect-fields button');
      await page.waitForSelector('.connect-fields .error:not([hidden])');
      t.assert.match(await page.textContent('.connect-fields .error'), /no ElectroClean study at http:\/\/127\.0\.0\.1:9/);
      await page.fill('#study-address', t.api);
      await page.click('.connect-fields button');
      await signInToStub(t, page);
      checkHeaders(t);
      // A link to a server that does not answer.
      const dead = await t.newPage({ url: `${t.base}?server=${encodeURIComponent('http://127.0.0.1:9')}` });
      await dead.waitForSelector('.signin-card .banner');
      t.assert.match(await dead.textContent('.signin-card .banner'), /does not answer/);
      await t.screenshot(dead, 'signin_server_down');
      await dead.click('text=Try the demonstration instead');
      await dead.waitForSelector('form.signin-form');
      t.assert.match(await dead.textContent('.signin-card'), /Demonstration/);
    },
  },
  {
    name: 'config.json with a Firebase project asks for an email address',
    async run(t) {
      t.cfg.config = { firebase: { apiKey: 'test-key', authDomain: 'demo.firebaseapp.com', projectId: 'demo-project', appId: '1:2:web:3' }, study: 'pilot', region: 'europe-west2' };
      const page = await t.newPage({ url: null });
      const sdkUrls = [];
      await page.route('https://www.gstatic.com/firebasejs/**', (route) => {
        const name = route.request().url().split('/').pop();
        sdkUrls.push(route.request().url());
        route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_FIREBASE[name] || '' });
      });
      await page.goto(`${t.cfgBase}?study=other-study`);
      await page.waitForSelector('#signin-id');
      t.assert.equal(await page.getAttribute('#signin-id', 'type'), 'email');
      t.assert.match(await page.textContent('label[for="signin-id"]'), /Email address/);
      t.assert.match(await page.textContent('.signin-card'), /Study: other-study/);
      t.assert.match(await page.textContent('.signin-card'), /Forgot password\?/);
      t.assert.ok(sdkUrls.length === 3 && sdkUrls.every((u) => /firebasejs\/\d+\.\d+\.\d+\/firebase-(app|auth|functions)\.js$/.test(u)));
      await page.fill('#signin-id', 'someone@example.org');
      await page.fill('#signin-password', 'x');
      await page.click('form.signin-form button[type="submit"]');
      await page.waitForSelector('form.signin-form .error:not([hidden])');
      t.assert.match(await page.textContent('form.signin-form .error'), /email address or password is not right/);
      await page.click('text=Forgot password?');
      await page.waitForSelector('.dialog');
      t.assert.match(await page.textContent('.dialog'), /Check your email/);
      await t.screenshot(page, 'signin_firebase');
      t.cfg.config = null;
      // The demonstration never loads the Firebase SDK.
      const demo = await t.newPage({ url: null });
      let loaded = false;
      await demo.route('https://www.gstatic.com/**', (route) => { loaded = true; route.abort(); });
      await demo.goto(t.base);
      await demo.waitForSelector('form.signin-form');
      t.assert.equal(loaded, false);
    },
  },
];
