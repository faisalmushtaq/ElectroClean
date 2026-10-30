// Datasets, collections, groups and hand-outs in the admin area (js/admin/datasets.js, groups.js,
// handouts.js): the administrator makes a dataset, registers recordings into it (an ID that belongs to
// another dataset is pointed out first), builds collections by picking and from filters, makes a group,
// hands the dataset out to everyone in it with a due date, sees the work turn overdue, follows it in the
// tracking grids and downloads them, and on the study server shares a collection out k per recording
// through the Tasks preview. Annotators see only the hand-out's title. Against the sandbox and the real
// study server, in Chromium and WebKit; screenshots of every new screen at 1440 × 900, 1280 × 720 and 400
// pixels wide.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SkipTest, signIn, waitForRoute } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.resolve(HERE, '..', '..', 'electrotag', 'web', 'static');
const PASSWORD = 'electrotag';
const DATASET = 'Youth low-density 2026';
const COLLECTION = 'Pilot: the hard ones';

// ------------------------------------------------------------------ helpers
async function api(t, token, method, p, body) {
  const res = await fetch(`${t.study.base}api/v1${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-ElectroTag': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ...data };
}
const login = async (t, id) => (await api(t, null, 'POST', '/login', { annotator_id: id, password: PASSWORD })).token;

/** The day `days` from today on this computer, as YYYY-MM-DD. */
function day(days) {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Screenshots of the page at 1440 × 900, 1280 × 720 and 400 pixels wide (the whole page), then back as it was. */
async function shots(t, page, name) {
  if (!t.shots) return;
  const before = page.viewportSize();
  for (const [w, hgt] of [[1440, 900], [1280, 720], [400, 900]]) {
    await page.setViewportSize({ width: w, height: hgt });
    await page.waitForTimeout(200);
    await page.evaluate(() => window.scrollTo(0, 0)); // the whole page, with the header where it belongs
    const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    if (!wide) t.errors.push(`${name} at ${w} pixels scrolls sideways`);
    await page.screenshot({ path: path.join(t.shots, `datasets_${name}_${w}x${hgt}.png`), fullPage: true });
  }
  await page.setViewportSize(before);
}

async function section(page, route) {
  await page.evaluate((r) => { location.hash = r; }, route);
  await waitForRoute(page, route);
  await page.waitForFunction((k) => document.querySelector(`.admin-section[data-section="${k}"]`), route === 'admin' ? 'overview' : route.replace(/^admin-/, ''));
}

/** A dataset's page in the Datasets section, from wherever the section was left. */
async function openDataset(page, id) {
  await section(page, 'admin-datasets');
  await page.locator('.admin-tabs button[data-tab="datasets"]').click();
  await page.waitForSelector(`h2[data-dataset-title], button[data-dataset="${id}"]`);
  if (await page.locator(`h2[data-dataset-title="${id}"]`).count()) return;
  if (await page.locator('[data-log="dataset-back"]').count()) await page.click('[data-log="dataset-back"]');
  await page.click(`button[data-dataset="${id}"]`);
  await page.waitForSelector(`h2[data-dataset-title="${id}"]`);
}

const text = async (page, sel = '.admin-main') => (await page.innerText(sel)).replace(/\s+/g, ' ');

/** Wait until the admin area's text matches. */
async function until(page, re, sel = '.admin-main', timeout = 20000) {
  await page.waitForFunction(([s, src, flags]) => new RegExp(src, flags).test((document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ')),
    [sel, re.source, re.flags], { timeout });
}

/** A stand-in for js/eeg/register.js in the sandbox (as in i_admin_demo.e2e.mjs): reads EDF files with the application's own reader. */
const STUB_BUILDER = `
import { openRecording } from './recording.js';
export async function buildManifests(files, { scope, onProgress } = {}) {
  const manifests = [];
  for (const f of [...files].filter((x) => /\\.edf$/i.test(x.name))) {
    const p = f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name;
    const rec = await openRecording([f]);
    const fp = await rec.fingerprint();
    manifests.push({
      schema: 'electrotag.web_manifest', schema_version: '1.0.0', scope, recording_id: p, relative_path: p, format: 'edf', format_name: 'EDF',
      file_name: f.name, files: { stem: f.name.replace(/_eeg\\.edf$/i, ''), path: p },
      timing: { sfreq: rec.sfreq, n_samples: rec.nSamples, first_samp: 0, meas_date: rec.measDate, duration_s: rec.durationS },
      ch_names: rec.channels.map((c) => c.name), hidden_channels: [], trigger_channels: [],
      channel_types: Object.fromEntries(rec.channels.map((c) => [c.name, c.type])), bad_channels: [],
      fingerprint: { eeg: { path: p, size: fp.sizeBytes, sha256: fp.hex } },
      original_events: { source: 'none', path: null, columns: [], rows: [], onset_s: [], sample: [] },
      amplitude: { suggested_scalings: {}, warnings: [] }, acquisition_gaps: [], discontinuity_samples: [], warnings: [], notes: [],
    });
    rec.close();
  }
  onProgress && onProgress({ done: 1, total: 1, stage: 'done' });
  return { manifests, failures: [] };
}
`;

/** Three simulated EDF recordings in a dataset folder, for the sandbox. */
async function sandboxFolder() {
  const { syntheticEdfBytes } = await import(pathToFileURL(path.join(STATIC, 'js', 'eeg', 'synthetic.js')).href);
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'et-datasets-'));
  for (let i = 1; i <= 3; i++) {
    const dir = path.join(root, 'youth', `sub-y0${i}`, 'eeg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `sub-y0${i}_task-rest_eeg.edf`), syntheticEdfBytes({ id: `y-0${i}`, stem: `sub-y0${i}_task-rest`, sfreq: 200, durationS: 20 + 10 * i, seed: i, artifacts: [] }));
  }
  return { folder: path.join(root, 'youth'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * The whole flow in the admin area, the same in the sandbox and on the study server: `people` are three
 * annotators (the first two make the group), `folder` the dataset folder to register from.
 */
async function flow(t, page, { people, folder, collide, study }) {
  const { assert } = t;
  const [p1, p2] = people;

  // ------------------------------------------------------------ a dataset
  await section(page, 'admin-datasets');
  await page.waitForSelector('[data-log="dataset-new"]');
  assert.match(await text(page), /Study recordings/, 'the built-in dataset is listed');
  await page.click('[data-log="dataset-new"]');
  const form = page.locator('[data-form="dataset-new"]');
  await form.locator('.admin-field', { hasText: 'Name' }).first().locator('input').fill(DATASET);
  await form.locator('.admin-field', { hasText: 'Licence' }).locator('input').fill('CC0');
  await form.locator('.admin-field', { hasText: 'Origin or address' }).locator('input').fill('https://example.org/youth');
  await form.locator('.admin-field', { hasText: 'Path prefix' }).locator('input').fill('youth');
  await form.locator('.admin-field', { hasText: 'Target of ratings' }).locator('select').selectOption('2');
  await shots(t, page, 'new_dataset');
  await page.click('[data-log="dataset-create"]');
  await page.waitForSelector('h2[data-dataset-title]');
  assert.equal(await page.textContent('h2[data-dataset-title]'), DATASET);
  const datasetId = await page.getAttribute('h2[data-dataset-title]', 'data-dataset-title');
  assert.match(await text(page), /Made: the dataset Youth low-density 2026/);

  // ------------------------------------------- registering into it, with a collision pointed out first
  await page.click('[data-log="dataset-add-recordings"]');
  await waitForRoute(page, 'admin-recordings');
  const add = page.locator('.admin-section[data-section="recordings"] .admin-card', { hasText: 'Add recordings from this computer' });
  await add.locator('.admin-field', { hasText: 'Dataset' }).locator('select').waitFor();
  // the section has read the datasets and chosen the one it was opened for
  await page.waitForFunction((id) => [...document.querySelectorAll('.admin-section[data-section="recordings"] select')].some((x) => x.value === id), datasetId);
  assert.equal(await add.locator('.admin-field', { hasText: 'Dataset' }).locator('select').inputValue(), datasetId, 'the dataset is chosen for adding');
  await page.setInputFiles('input[data-log="register-folder"]', folder);
  await page.waitForSelector('[data-log="register"]', { timeout: 120000 });
  assert.match(await text(page, '.admin-review'), /Into the dataset Youth low-density 2026, with their IDs starting youth\//);
  if (collide) {
    // A new dataset without a prefix, made on the page: the IDs belong to the built-in dataset's recordings.
    await add.locator('.admin-field', { hasText: 'Dataset' }).locator('select').selectOption('__new');
    await add.locator('.admin-field', { hasText: 'Name of the new dataset' }).locator('input').fill('No prefix');
    await page.click('[data-log="register-dataset-create"]');
    await until(page, /Made the dataset No prefix/);
    await page.waitForFunction(() => /have the ID of a recording in another dataset/.test(document.querySelector('.admin-review')?.innerText || ''));
    assert.match(await text(page, '.admin-review'), /in the dataset Study recordings/);
    // (an earlier spec on the shared study server may have removed one of the study's recordings: then it is new here)
    const n = await page.locator('.admin-review [data-elsewhere]').count();
    assert.ok(n >= 1, 'IDs that belong to the built-in dataset are marked');
    assert.equal(await page.textContent('[data-log="register"]'), n === 3 ? 'Nothing to add' : `Add ${3 - n} recording${3 - n === 1 ? '' : 's'}`);
    await shots(t, page, 'register_collision');
    await add.locator('.admin-field', { hasText: 'Dataset' }).locator('select').selectOption(datasetId);
  }
  // On the study server the files are the study's own recordings: copies of them, added on purpose here.
  const copies = page.locator('.admin-review .duplicates input[type="checkbox"]');
  if (await copies.count()) await copies.check();
  await page.waitForFunction(() => /^Add \d+ recordings?$/.test(document.querySelector('[data-log="register"]')?.textContent || ''));
  await page.click('[data-log="register"]');
  await until(page, /Added 3 recordings/, '.admin-review', 60000);
  await page.waitForSelector('tr[data-key^="study|youth/"]');
  assert.match(await text(page, 'tr[data-key^="study|youth/"]'), /Youth low-density 2026/, 'the list has a Dataset column');

  // --------------------------------------------- its page, and a collection picked by hand
  await openDataset(page, datasetId);
  await until(page, /Recordings \(3\)/);
  let body = await text(page);
  assert.match(body, /CC0/);
  assert.match(body, /0 of 3 rated by 2 people/);
  assert.match(body, /Formats (EDF|BrainVision)/);
  await shots(t, page, 'dataset_page');
  const recs = page.locator('.admin-card', { hasText: 'Recordings (3)' });
  const boxes = recs.locator('input[data-select]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await recs.locator('.bulk-group', { hasText: 'Add to' }).locator('select').selectOption('new');
  await shots(t, page, 'dataset_bulk');
  await recs.locator('[data-log="collection-add"]').click();
  await page.waitForSelector('[data-form="collection-new"]');
  assert.match(await text(page, '[data-form="collection-new"]'), /2 recordings chosen/);
  await page.locator('[data-form="collection-new"] .admin-field', { hasText: 'Name' }).first().locator('input').fill(COLLECTION);
  await page.click('[data-log="collection-create"]');
  await page.waitForSelector('h2[data-collection-title]');
  const collectionId = await page.getAttribute('h2[data-collection-title]', 'data-collection-title');
  body = await text(page);
  assert.match(body, /Made: the collection Pilot: the hard ones, with 2 recordings/);
  assert.match(body, /Chosen by hand/);
  // the order: the second goes up
  const firstBefore = await page.locator('[data-collection-recordings] tbody tr').first().innerText();
  await page.locator('[data-collection-recordings] tbody tr').nth(1).locator('[data-log="collection-up"]').click();
  await page.waitForFunction((was) => document.querySelector('[data-collection-recordings] tbody tr')?.innerText !== was, firstBefore);
  await shots(t, page, 'collection_page');

  // ------------------------------------------------------- a collection from filters
  await page.click('[data-log="collection-back"]');
  await page.click('[data-log="collection-build"]');
  await page.waitForSelector('[data-form="collection-new"] .ds-matches');
  const builder = page.locator('[data-form="collection-new"]');
  await builder.locator('.admin-field', { hasText: 'File name' }).locator('input').fill('youth/');
  await until(page, /Matches 3/, '[data-form="collection-new"]');
  await builder.locator('.admin-field', { hasText: 'A random sample of' }).locator('input').fill('2');
  await builder.locator('.admin-field', { hasText: 'Seed of the sample' }).locator('input').fill('7');
  await until(page, /Matches 2/, '[data-form="collection-new"]');
  await shots(t, page, 'collection_builder');
  await builder.locator('.admin-field', { hasText: 'Name' }).last().locator('input').fill('A sample of two');
  await page.click('[data-log="collection-create"]');
  await page.waitForSelector('h2[data-collection-title]');
  assert.match(await text(page), /Built from filters: from [^;]*Youth low-density 2026[^;]*; names with "youth\/"; a random 2 of them \(seed 7\)\./);
  await page.click('[data-log="collection-back"]');
  await until(page, /A sample of two/);
  await shots(t, page, 'collections');

  // ------------------------------------------------------------------- a group
  await section(page, 'admin-groups');
  await page.click('[data-log="group-new"]');
  const gform = page.locator('[data-form="group-new"]');
  await gform.locator('.admin-field', { hasText: 'Name' }).locator('input').fill('Leeds RAs');
  await gform.locator(`input[data-name="group-members"][value="${p1}"]`).check();
  await gform.locator(`input[data-name="group-members"][value="${p2}"]`).check();
  await page.click('[data-log="group-create"]');
  await page.waitForSelector('h2[data-group-title]');
  const groupId = await page.getAttribute('h2[data-group-title]', 'data-group-title');
  assert.match(await text(page), /Made: the group Leeds RAs, with 2 members/);
  await shots(t, page, 'group_page');

  // ------------------------------------------- the hand-out: everyone gets all of it, with a due date
  await openDataset(page, datasetId);
  await page.click('[data-log="dataset-handout"]');
  await waitForRoute(page, 'admin-handouts');
  const ho = page.locator('[data-card="handout-form"]');
  await ho.locator('select').first().waitFor();
  assert.equal(await ho.locator('.admin-field', { hasText: 'Dataset or collection' }).locator('select').inputValue(), `dataset:${datasetId}`);
  await ho.locator(`input[data-name="handout-groups"][value="${groupId}"]`).check();
  await ho.locator('.admin-field', { hasText: 'Due date' }).locator('input').fill(day(7));
  assert.equal(await ho.locator('.admin-field', { hasText: 'Title annotators see' }).locator('input').getAttribute('placeholder'), DATASET, 'a dataset\'s title is its name');
  assert.equal(await page.isDisabled('[data-log="handout-create"]'), true, 'nothing is handed out before the preview');
  await page.click('[data-log="handout-preview"]');
  await page.waitForSelector('.ho-preview .tasks-summary');
  assert.match(await text(page, '.ho-preview'), /3 recordings to 2 people: 6 new assignments\./);
  assert.match(await text(page, '.ho-preview'), /2 through Leeds RAs/);
  await shots(t, page, 'handout_preview');
  await page.click('[data-log="handout-create"]');
  await until(page, /Handed out: Youth low-density 2026, to 2 people, 6 new assignments\. Annotators see it as "Youth low-density 2026"\./);
  await page.waitForSelector('h2[data-handout-title]');
  const handoutId = await page.getAttribute('h2[data-handout-title]', 'data-handout-title');
  // A second press after the answer makes nothing more: the list holds one hand-out.
  assert.equal(await page.locator('table.admin-list button[data-handout]').count(), 1);

  // The due date passes: the hand-out turns overdue for both.
  const detail = page.locator('.admin-card', { has: page.locator('h2[data-handout-title]') });
  await detail.locator('.admin-field', { hasText: 'Due date' }).locator('input').fill(day(-2));
  await page.click('[data-log="handout-due"]');
  await until(page, /Due on/);
  await page.waitForSelector('table.admin-list .chip.warning');
  assert.match(await text(page, '.admin-section[data-section="handouts"] .admin-card:has(> .row.filters)'), /2 people overdue/);
  assert.match(await text(page, '.admin-card:has(h2[data-handout-title])'), new RegExp(`${p1}.*Overdue`));
  await shots(t, page, 'handouts');

  // ------------------------------------------------------------------ overview
  await section(page, 'admin');
  await until(page, /2 people have overdue work, across 1 open hand-out\./);
  await shots(t, page, 'overview');
  return { datasetId, collectionId, groupId, handoutId };
}

/** The tracking grids and their download, once the study offers them; skipped before. */
async function tracking(t, page, { datasetId, p1, offered }) {
  const { assert } = t;
  if (!offered) throw new SkipTest('the study does not offer tracking_datasets_get yet');
  await section(page, 'admin-datasets');
  await page.locator('.admin-tabs button[data-tab="tracking"]').click();
  await page.waitForSelector(`button[data-track="dataset:${datasetId}"]`, { timeout: 30000 });
  const row = page.locator('.ds-summary tbody tr', { has: page.locator(`button[data-track="dataset:${datasetId}"]`) });
  const cell = row.locator(`[data-person="${p1}"]`);
  assert.match(await cell.innerText(), /0 of 3/);
  assert.match(await cell.innerText(), /Overdue/);
  assert.match(await text(page, '.ds-figures-row'), /Figures from \d\d:\d\d/);
  await page.locator('.ds-summary th', { hasText: p1 }).first().waitFor();
  await shots(t, page, 'tracking_summary');
  await page.click(`button[data-track="dataset:${datasetId}"]`);
  await page.waitForSelector(`.ds-grid [data-person="${p1}"][data-status]`);
  assert.equal(await page.locator(`.ds-grid [data-person="${p1}"][data-status]`).first().getAttribute('data-status'), 'given');
  assert.match(await text(page, '.ds-grid'), /0 of 2/, 'each recording\'s ratings against the target');
  await shots(t, page, 'tracking_recordings');
  const [d] = await Promise.all([page.waitForEvent('download'), page.click('[data-log="tracking-csv"]')]);
  assert.equal(d.suggestedFilename(), `tracking_dataset_${datasetId}.csv`);
  const csv = fs.readFileSync(await d.path(), 'utf8').trim().split(/\r?\n/);
  assert.match(csv[0], /^target_kind,target_id,recording_id,file_name,dataset_id,annotator_id,status,/);
  const mine = csv.filter((l) => l.includes(`,${p1},`));
  assert.equal(mine.length, 3, 'one row for each recording of the person');
  assert.ok(mine.every((l) => /,given,/.test(l) && /,true,/.test(l)), mine.join('\n'));
}

/** What would be notified, once the study offers it. */
async function notices(t, page, offered) {
  const { assert } = t;
  await section(page, 'admin-handouts');
  await until(page, /ElectroTag sends no email yet/);
  if (!offered) return;
  await page.waitForSelector('.ho-notice', { timeout: 20000 });
  assert.match(await text(page, '.ho-notice:last-of-type, .admin-section[data-section="handouts"]'), /Overdue|overdue/);
  await shots(t, page, 'notices');
}

export const tests = [
  {
    name: 'in the sandbox: a dataset, recordings registered into it, collections, a group, a hand-out with a due date, and the tracking grid',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 720 });
      await page.route('**/js/eeg/register.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB_BUILDER }));
      await page.waitForSelector('form.signin-form');
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin');
      const offered = await page.evaluate(async () => {
        try { await globalThis.ElectroTag.backend.admin('datasets_list', {}); return true; } catch { return false; }
      });
      if (!offered) throw new SkipTest('the sandbox does not answer the datasets operations yet (js/api/demo_library.js)');
      const data = await sandboxFolder();
      try {
        const ids = await flow(t, page, { people: ['A01', 'E01'], folder: data.folder, collide: false, study: false });
        const has = async (op, body) => page.evaluate(async ([o, b]) => { try { await globalThis.ElectroTag.backend.admin(o, b); return true; } catch { return false; } }, [op, body]);
        await tracking(t, page, { datasetId: ids.datasetId, p1: 'A01', offered: await has('tracking_datasets_get', { kind: 'dataset' }) });
        await notices(t, page, await has('notify_preview_get', { kind: 'all' }));
        // the sandbox says plainly that a share-out k per recording needs a study server
        await section(page, 'admin-handouts');
        const ho = page.locator('[data-card="handout-form"]');
        await ho.locator('.admin-field', { hasText: 'Dataset or collection' }).locator('select').selectOption(`collection:${ids.collectionId}`);
        await ho.locator('input[data-name="handout-people"][value="A01"]').check();
        await ho.locator('input[data-name="handout-people"][value="E01"]').check();
        await ho.locator('input[name="handout-mode"][value="k"]').check();
        await page.click('[data-log="handout-preview"]');
        await until(page, /needs? a study server|study server or Firebase/, '[data-card="handout-form"]');
        assert.ok(true);
      } finally {
        data.cleanup();
      }
    },
  },
  {
    name: 'on the study server: the same flow, a k hand-out through the Tasks preview, tracking, and annotators seeing only the title',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const admin = await login(t, 'ADMIN');
      if ((await api(t, admin, 'POST', '/admin/datasets_list', {})).status !== 200) throw new SkipTest('the study server does not offer the datasets operations');
      const people = ['Z11', 'Z12', 'Z13'];
      for (const id of people) {
        const r = await api(t, admin, 'POST', '/admin/user_add', { annotator_id: id, display_name: `Dataset annotator ${id}`, password: PASSWORD });
        assert.ok(r.status === 200 || r.status === 409, JSON.stringify(r));
      }
      // Z11 signs in once and gives their name in the sign-up questionnaire: the study team then sees it beside the ID.
      const z = await t.newPage({ url: t.study.base });
      await signIn(z, 'Z11', PASSWORD);
      await z.context().close();

      const page = await t.newPage({ url: t.study.base, width: 1280, height: 720 });
      await signIn(page, 'ADMIN', PASSWORD);
      await waitForRoute(page, 'admin');
      const ids = await flow(t, page, { people, folder: path.join(t.study.dir, 'recordings', 'study'), collide: true, study: true });

      // the name beside the ID, in the group's list
      await section(page, 'admin-groups');
      await page.waitForSelector(`h2[data-group-title="${ids.groupId}"], button[data-group="${ids.groupId}"]`);
  if (!(await page.locator(`h2[data-group-title="${ids.groupId}"]`).count())) await page.click(`button[data-group="${ids.groupId}"]`);
      await until(page, /Z11 · Test person/);

      // ---------------------------------- a k hand-out of the collection, through the Tasks preview
      await section(page, 'admin-handouts');
      const ho = page.locator('[data-card="handout-form"]');
      await ho.locator('.admin-field', { hasText: 'Dataset or collection' }).locator('select').selectOption(`collection:${ids.collectionId}`);
      for (const id of people) await ho.locator(`input[data-name="handout-people"][value="${id}"]`).check();
      await ho.locator('input[name="handout-mode"][value="k"]').check();
      assert.equal(await ho.locator('.admin-field', { hasText: 'Title annotators see' }).locator('input').getAttribute('placeholder'), 'Recordings to annotate',
        'a collection\'s name never becomes the title');
      await page.click('[data-log="handout-preview"]');
      await page.waitForSelector('.ho-preview .tasks-summary');
      // Z11 and Z12 hold the collection's recordings already (the dataset's hand-out): the tasks go to them, as Tasks share out.
  assert.match(await text(page, '.ho-preview'), /^2 tasks, each to 2 people: 0 new assignments; 4 assignments that people already hold become part of their tasks\./);
      assert.match(await text(page, '.ho-preview'), /Open tasks now/, 'the Tasks section\'s own table of shares');
      await shots(t, page, 'handout_k_preview');
      await page.click('[data-log="handout-create"]');
      await until(page, /Handed out: Pilot: the hard ones, to 3 people, 2 tasks/);
      const kHandout = (await api(t, admin, 'POST', '/admin/handouts_list', {})).handouts.find((o) => o.mode === 'k');
      assert.equal(kHandout.n_tasks, 2, 'the tasks carry the hand-out');
      assert.equal(kHandout.title, 'Recordings to annotate');

      // ------------------------------------------ annotators see the title, never the collection's name
      for (const id of people) {
        const token = await login(t, id);
        const seen = JSON.stringify(await api(t, token, 'GET', '/assignments')) + JSON.stringify(await api(t, token, 'GET', '/me'));
        assert.ok(!seen.includes(COLLECTION), `${id} never sees the collection's name`);
        assert.ok(!seen.includes('example.org/youth'), `${id} never sees the dataset's details`);
      }

      // ---------------------------------------------------- tracking and notices
      const offered = async (op, body) => (await api(t, admin, 'POST', `/admin/${op}`, body)).status === 200;
      await notices(t, page, await offered('notify_preview_get', { kind: 'all' }));
      await tracking(t, page, { datasetId: ids.datasetId, p1: 'Z11', offered: await offered('tracking_datasets_get', { kind: 'dataset' }) });
    },
  },
];
