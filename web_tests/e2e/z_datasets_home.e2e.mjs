// The annotator's home after the study team hands recordings out (docs/web/using.md, "Due dates"): the Due card
// with one line per hand-out that has a due date, an Overdue badge once the day has passed, the list grouped
// under the hand-outs' titles (earliest due first, then the recordings given without one), an Overdue badge on
// each row of an overdue hand-out, and Show these. Annotators see a hand-out only by its title: the names,
// descriptions and notes of datasets and collections never reach the page (decision 1 of the project lead).
// In the sandbox (js/api/demo_library.js) and on the real study server.
import { signIn, waitForRoute } from './helpers.mjs';

const PASSWORD = 'electrotag';
const day = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hex = (n) => n.toString(16).padStart(32, '0');
/** What the study team keeps to itself: none of it may appear on the annotator's page. */
const TEAM_ONLY = ['Secret pilot', 'hard ones', 'Only the team reads this', 'A private note', 'Recorded at the clinic'];

/** A study recording's manifest (docs/web/api.md) for registering on the study server. */
function manifest(rid, sha) {
  return {
    schema: 'electrotag.web_manifest', schema_version: '1.0.0', scope: 'study', recording_id: rid, relative_path: rid, format: 'edf',
    format_name: 'EDF', file_name: rid.split('/').pop(), files: { stem: rid.split('/').pop().replace(/_eeg\.edf$/, ''), path: rid },
    timing: { sfreq: 100, n_samples: 6000, first_samp: 0, meas_date: null, duration_s: 60 }, ch_names: ['Fp1', 'Fp2', 'Cz', 'HEOG'],
    hidden_channels: [], trigger_channels: [], channel_types: { Fp1: 'eeg', Fp2: 'eeg', Cz: 'eeg', HEOG: 'eog' }, bad_channels: [],
    fingerprint: { eeg: { path: rid, size: 48256, sha256: sha } },
    original_events: { source: 'none', path: null, columns: [], rows: [], onset_s: [], sample: [] },
    amplitude: { suggested_scalings: {}, warnings: [] }, warnings: [], notes: [],
  };
}

/** The hand-outs both back ends get: a dataset (`inDataset` of the recordings), overdue, and a collection of the first, due later. */
async function handOut(call, rids, aid, inDataset) {
  await call('dataset_create', { request_id: hex(0xd1), dataset_id: 'pilot-ds', name: 'Pilot recordings', description: 'Recorded at the clinic', notes: 'Only the team reads this' });
  await call('recordings_move', { recording_ids: inDataset, dataset_id: 'pilot-ds' });
  const c = await call('collection_create', { request_id: hex(0xc1), name: 'Secret pilot: the hard ones', recording_ids: [rids[0]] });
  await call('handout_create', { request_id: hex(0xe1), target: { kind: 'dataset', id: 'pilot-ds' }, people: [aid], due_at: day(-3), note: 'A private note' });
  await call('handout_create', { request_id: hex(0xe2), target: { kind: 'collection', id: c.collection.collection_id }, people: [aid], due_at: day(20) });
}

/** The home page as the annotator sees it: the Due card, the groups, the badges and Show these. */
async function checkHome(t, page, { other = false, n = 2 } = {}) {
  const { assert } = t;
  await page.waitForSelector('.due-card .due-line');
  const lines = await page.locator('.due-card .due-line').allInnerTexts();
  assert.equal(lines.length, 2, lines.join(' | '));
  assert.match(lines[0], new RegExp(`^Pilot recordings: ${n} of ${n} left, was due \\w+day \\d+ \\w+\\s*Overdue\\s*Show these$`));
  assert.match(lines[1], /^Recordings due \d+ \w+: 1 of 1 left, due \w+day \d+ \w+( \d{4})?\s*Show these$/);
  assert.equal(await page.innerText('.due-card h2'), 'Due');
  // the To do tab, grouped: the overdue hand-out first, then the later one, then the rest
  await page.click('[data-tab="todo"]');
  const groups = await page.locator('table.list.grouped tr.group-row').allInnerTexts();
  assert.deepEqual(groups.map((g) => g.trim().replace(/ \d+ \w+$/, ' <date>')), ['Pilot recordings', 'Recordings due <date>', ...(other ? ['Other recordings'] : [])]);
  const rows = page.locator('table.list.grouped tbody tr:not(.group-row)');
  const texts = await rows.allInnerTexts();
  assert.deepEqual(texts.map((x) => /Overdue/.test(x)), texts.map((_x, i) => i < n), `the recordings of the overdue hand-out, and only they, carry the badge: ${texts.join(' | ')}`);
  const body = await page.innerText('body');
  for (const secret of TEAM_ONLY) assert.ok(!body.includes(secret), `the page shows "${secret}"`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await t.screenshot(page, `home_due_${other ? 'study' : 'sandbox'}`);
  // Show these: only that hand-out's recordings, with the way back
  await page.locator('.due-line', { hasText: 'Pilot recordings' }).locator('button', { hasText: 'Show these' }).click();
  await page.waitForSelector('.rec-filter');
  assert.match(await page.innerText('.rec-filter'), /^Showing Pilot recordings only\. Show every recording$/);
  assert.equal(await page.locator('table.list tbody tr:not(.group-row)').count(), n);
  await t.screenshot(page, 'home_due_show');
  await page.click('[data-log="recordings-show-all"]');
  await page.waitForFunction(() => !document.querySelector('.rec-filter'));
  assert.equal(await page.locator('table.list tbody tr:not(.group-row)').count(), texts.length);
}

export const tests = [
  {
    name: 'in the sandbox: after the study team\'s hand-outs, A01 sees the Due card, the list grouped by title and the overdue badges, and nothing of the datasets\' details',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 1000 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => globalThis.ElectroTag && /^admin/.test(globalThis.ElectroTag.route || ''));
      const rids = await page.evaluate(async () => (await globalThis.ElectroTag.backend.admin('recordings_list', { scope: 'study' })).recordings.map((r) => r.recording_id));
      await handOut((op, body) => page.evaluate(([o, b]) => globalThis.ElectroTag.backend.admin(o, b), [op, body]), rids, 'A01', [rids[1], rids[2]]);
      await page.evaluate(() => globalThis.ElectroTag.backend.logout());
      await page.reload();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await checkHome(t, page);
      assert.ok(await page.evaluate(() => globalThis.ElectroTag.assignments.items.every((i) => i.handout)), 'every recording of A01 is handed out');
    },
  },
  {
    name: 'in the sandbox on an iPad held upright: the Due card and the grouped list fit the screen',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 768, height: 1024, ipad: true });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => globalThis.ElectroTag && /^admin/.test(globalThis.ElectroTag.route || ''));
      const rids = await page.evaluate(async () => (await globalThis.ElectroTag.backend.admin('recordings_list', { scope: 'study' })).recordings.map((r) => r.recording_id));
      await handOut((op, body) => page.evaluate(([o, b]) => globalThis.ElectroTag.backend.admin(o, b), [op, body]), rids, 'A01', [rids[1], rids[2]]);
      await page.evaluate(() => globalThis.ElectroTag.backend.logout());
      await page.reload();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await page.waitForSelector('.due-card .due-line');
      await page.locator('.due-card').scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scrolling');
      const box = await page.locator('.due-card').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 769, JSON.stringify(box));
      await t.screenshot(page, 'home_due_ipad');
    },
  },
  {
    name: 'on the study server: an annotator given a dataset and a collection sees them by title and due date, then the recordings given without one',
    needs: 'study',
    async run(t) {
      const api = async (token, p, body) => {
        const res = await fetch(`${t.study.base}api/v1${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ElectroTag': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) throw new Error(`${p}: ${res.status} ${JSON.stringify(data)}`);
        return data;
      };
      const admin = (await api(null, '/login', { annotator_id: 'ADMIN', password: PASSWORD })).token;
      const call = (op, body) => api(admin, `/admin/${op}`, body);
      await call('user_add', { annotator_id: 'Q41', display_name: 'Hand-out annotator', password: PASSWORD });
      // three recordings of this test's own (the earlier specs retire and remove the study's examples); the
      // annotator never opens them, so their manifests need no files
      const rids = [1, 2, 3].map((n) => `handout-e2e/sub-h${n}/eeg/sub-h${n}_task-rest_eeg.edf`);
      const reg = await call('recordings_register', { scope: 'study', manifests: rids.map((rid, n) => manifest(rid, String(n + 1).repeat(64))) });
      if (reg.added.length !== 3) throw new Error(JSON.stringify(reg.skipped));
      await handOut(call, rids, 'Q41', [rids[2]]);
      await call('assign', { annotator_ids: ['Q41'], recording_ids: [rids[1]] }); // given without a hand-out
      const page = await t.newPage({ url: t.study.base, width: 1440, height: 1000 });
      await signIn(page, 'Q41', PASSWORD);
      await waitForRoute(page, 'home');
      await checkHome(t, page, { other: true, n: 1 });
    },
  },
];
