// The admin area in the demonstration: the demo administrator adds an annotator and assigns
// recordings, changes the study settings and reads the audit log; recordings are added from
// "this computer" (with a stand-in for js/eeg/register.js that reads the files with the real
// readers) and then opened and saved by an annotator; the analyses say they need a study server;
// and the area works at 1280 × 720 and in a window 400 pixels wide.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { signIn, state, waitForRoute, waitForTraces, eegPoint, drag, clickDialogButton, pressSave } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.resolve(HERE, '..', '..', 'electrotag', 'web', 'static');

/**
 * A stand-in for js/eeg/register.js with the interface of docs/web/architecture.md: it reads each
 * EDF file with the application's own reader (./recording.js beside it) for the fingerprint, timing
 * and channels, reports progress, lists other files as failures, and can be held until released.
 */
const STUB_BUILDER = `
import { openRecording } from './recording.js';
export function findDatasetRecordings(files) {
  return { recordings: [...files].filter((f) => /\\.edf$/i.test(f.name)).map((f) => ({ recordingId: f.name, files: [f] })), ignored: [] };
}
export async function buildManifest(recording, { scope = 'study' } = {}) { throw new Error('not used by the admin area'); }
export async function buildManifests(files, { settings, scope, onProgress } = {}) {
  globalThis.__builder = { calls: (globalThis.__builder?.calls || 0) + 1, settings, scope };
  if (globalThis.__holdBuilder) await new Promise((r) => { globalThis.__releaseBuilder = r; });
  const list = [...files];
  const manifests = [];
  const failures = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const p = f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name;
    onProgress && onProgress({ done: i, total: list.length, path: p });
    if (!/\\.edf$/i.test(f.name)) { failures.push({ path: p, reason: 'This is not an EEG recording.' }); continue; }
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
      amplitude: { suggested_scalings: {}, warnings: [] }, acquisition_gaps: [], discontinuity_samples: [],
      warnings: ['Read by the test builder'], notes: [],
    });
    rec.close();
  }
  onProgress && onProgress({ done: list.length, total: list.length, stage: 'done' });
  return { manifests, failures };
}
`;

async function stubBuilder(page) {
  await page.route('**/js/eeg/register.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB_BUILDER }));
}

/** A dataset folder with one new simulated EDF recording and a file that is not a recording. */
async function dataset() {
  const { syntheticEdfBytes } = await import(pathToFileURL(path.join(STATIC, 'js', 'eeg', 'synthetic.js')).href);
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'et-admin-'));
  const dir = path.join(root, 'dataset', 'sub-new01', 'eeg');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sub-new01_task-rest_eeg.edf');
  fs.writeFileSync(file, syntheticEdfBytes({ id: 'new-01', stem: 'sub-new01_task-rest', sfreq: 200, durationS: 30, seed: 5,
    artifacts: [['Eye-blink-artifact', 3, 0.4, ['Fp1', 'Fp2']]] }));
  fs.writeFileSync(path.join(root, 'dataset', 'README.txt'), 'Not a recording.');
  return { root, folder: path.join(root, 'dataset'), file, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function noSideways(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

async function goSection(page, title, route) {
  await page.locator('.admin-nav a', { hasText: title }).click();
  await waitForRoute(page, route);
  await page.waitForFunction((r) => document.querySelector(`.admin-section[data-section="${r}"]`), route.replace(/^admin-?/, '') || 'overview');
}

async function sectionText(page) {
  return (await page.innerText('.admin-main')).replace(/\s+/g, ' ');
}

export const tests = [
  {
    name: 'the demo administrator adds an annotator, assigns recordings, changes settings and reads the audit log',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 720 });
      // Reading the clipboard back needs Chromium's permissions; WebKit checks the button's answer only.
      if (t.browserName === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.waitForSelector('form.signin-form');
      assert.match(await page.textContent('.demo-hint'), /ADMIN/);
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin');
      await page.waitForSelector('.stat-tile');
      assert.match(await sectionText(page), /3 Recordings registered for the study 2 Annotators and 1 administrator/i); // labels shown in capitals
      assert.ok(await noSideways(page));
      await t.screenshot(page, 'admin_overview');
      // From the keyboard: a section's link, then the focus is on that section's heading; Back returns.
      await page.focus('.admin-nav a[data-section="records"]');
      await page.keyboard.press('Enter');
      await waitForRoute(page, 'admin-records');
      await page.waitForFunction(() => document.activeElement && document.activeElement.matches('.admin-section[data-section="records"] h1'));
      await page.goBack(); // the browser's Back button moves between sections
      await waitForRoute(page, 'admin');

      // An annotator, with a temporary password shown once and copied.
      await goSection(page, 'Annotators', 'admin-annotators');
      await t.screenshot(page, 'admin_annotators');
      const form = page.locator('form.admin-form').first();
      await form.locator('input').nth(0).fill('a05');
      await form.locator('input').nth(1).fill('Annotator five');
      await page.click('[data-log="user-add"]');
      await page.waitForSelector('.secret-value');
      const password = (await page.textContent('.secret-value')).trim();
      assert.match(password, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
      await page.click('.secret [data-copy]');
      await page.waitForFunction(() => /Copied|Select it/.test(document.querySelector('.secret [data-copy]').textContent));
      if (t.browserName === 'chromium') assert.equal(await page.evaluate(() => navigator.clipboard.readText()), password);
      await page.waitForSelector('tr[data-key="A05"]');

      // Its page: the account, the programme and its (empty) assignments.
      await page.click('[data-manage="A05"]');
      await page.waitForSelector('h2.person-title');
      assert.match(await page.textContent('h2.person-title'), /A05 · Annotator five/);
      await t.screenshot(page, 'admin_person');

      // Assign every study recording to A05, from the person's page.
      await page.locator('button', { hasText: 'Assign recordings to A05' }).last().click();
      await waitForRoute(page, 'admin-assignments');
      await page.waitForSelector('input[data-name="annotators"][value="A05"]');
      assert.equal(await page.isChecked('input[data-name="annotators"][value="A05"]'), true);
      await page.locator('label.check', { hasText: 'Every recording' }).click();
      await page.click('[data-log="assign"]');
      await page.waitForFunction(() => /Assigned: 3 new assignments/.test(document.querySelector('.admin-section[data-section="assignments"] .admin-msg')?.textContent || ''));
      assert.equal(await page.locator('.admin-section[data-section="assignments"] tr', { hasText: 'A05' }).count(), 3);
      await t.screenshot(page, 'admin_assignments');

      // Study settings: the name and the type on key 1.
      await goSection(page, 'Study settings', 'admin-settings');
      await page.fill('input[name="study_name"]', 'Pilot study');
      await page.selectOption('select[aria-label="Key 1"]', 'Nystagmus-artifact');
      await page.selectOption('select[aria-label="Key 2"]', 'Nystagmus-artifact');
      await page.click('[data-log="settings-save"]');
      await page.waitForSelector('.admin-section[data-section="settings"] .error-banner');
      assert.match(await page.textContent('.admin-section[data-section="settings"] .error-banner'), /two number keys/);
      await page.selectOption('select[aria-label="Key 2"]', 'Horizontal-eye-movement-artifact');
      await page.click('[data-log="settings-save"]');
      // The answer is in the bar beside Save, at the foot of the window.
      await page.waitForFunction(() => /The settings are saved/.test(document.querySelector('.admin-section[data-section="settings"] .sticky-save .admin-msg')?.textContent || ''));
      await t.screenshot(page, 'admin_settings');

      // The audit log has each change, newest first, and can be filtered.
      await goSection(page, 'Records', 'admin-records');
      await page.waitForSelector('.admin-section[data-section="records"] td');
      const log = await sectionText(page);
      for (const re of [/Added A05 \(Annotator five\)/, /Assigned 3 recordings to A05/, /Changed quick labels \(annotation\) from .* to Nystagmus-artifact, Horizontal-eye-movement-artifact.*; the study's name/, /Study created/]) assert.match(log, re);
      await page.selectOption('select[aria-label="Kind of change"]', 'assign');
      assert.match(await page.textContent('.admin-section[data-section="records"] .admin-card'), /1 of \d+ entries shown/);
      await t.screenshot(page, 'admin_records');

      // The analyses need a study server, and say how to try one.
      await goSection(page, 'Analyses', 'admin-analyses');
      await page.click('[data-log="agreement-run"]');
      await page.waitForFunction(() => /needs a study server or Firebase/.test(document.querySelector('.admin-section[data-section="analyses"] .note')?.textContent || ''));
      assert.match(await sectionText(page), /electrotag-web demo/);

      // Back to annotating, and in again from the header.
      await page.click('[data-log="leave-admin"]');
      await waitForRoute(page, 'home');
      await page.click('[data-log="admin"]');
      await waitForRoute(page, 'admin');
      const s = await state(page);
      assert.equal(s.admin.section, 'overview');

      // A05 signs in with the temporary password and finds the recordings and the study's keys.
      await page.click('[data-log="sign-out"]');
      await signIn(page, 'A05', password);
      await waitForRoute(page, 'home');
      assert.match(await page.textContent('main'), /0 of 3\s*recordings done/);
      assert.equal(await page.locator('[data-log="admin"]').count(), 0);
      const me = await page.evaluate(() => globalThis.ElectroTag.me);
      assert.equal(me.study.name, 'Pilot study');
      assert.equal(me.study.annotation.quick_labels[0], 'Nystagmus-artifact');
      // The admin area is for administrators only.
      await page.evaluate(() => { location.hash = 'admin-annotators'; });
      await page.waitForTimeout(300);
      assert.equal((await state(page)).route, 'home');
    },
  },
  {
    name: 'recordings added from this computer are registered as manifests, then annotated',
    async run(t) {
      const { assert } = t;
      const data = await dataset();
      try {
        const page = await t.newPage({ width: 1280, height: 720 });
        await stubBuilder(page);
        await page.waitForSelector('form.signin-form');
        await signIn(page, 'ADMIN');
        await waitForRoute(page, 'admin');
        await goSection(page, 'Recordings', 'admin-recordings');
        // While the files are read, they cannot be chosen again.
        await page.evaluate(() => { globalThis.__holdBuilder = true; });
        await page.setInputFiles('input[data-log="register-folder"]', data.folder);
        await page.waitForFunction(() => typeof globalThis.__releaseBuilder === 'function');
        assert.equal(await page.isDisabled('.admin-section[data-section="recordings"] .btn.primary >> text=Choose a folder…'), true);
        assert.equal(await page.isDisabled('text=Choose files…'), true);
        assert.equal(await page.isVisible('.admin-progress'), true);
        await page.evaluate(() => { globalThis.__holdBuilder = false; globalThis.__releaseBuilder(); });
        await page.waitForSelector('.admin-review h3');
        const builder = await page.evaluate(() => globalThis.__builder);
        assert.equal(builder.calls, 1);
        assert.equal(builder.scope, 'study');
        assert.ok(builder.settings && builder.settings.channels && Array.isArray(builder.settings.channels.hide), 'the study settings go to the builder');
        const review = (await page.innerText('.admin-review')).replace(/\s+/g, ' ');
        assert.match(review, /Found 1 recording/);
        assert.match(review, /sub-new01_task-rest_eeg\.edf/);
        assert.match(review, /Read by the test builder/);
        assert.match(review, /1 file could not be read README\.txt: This is not an EEG recording\./);
        await t.screenshot(page, 'admin_register_review');
        await page.click('[data-log="register"]');
        await page.waitForFunction(() => /Added 1 recording/.test(document.querySelector('.admin-review')?.textContent || ''));
        await t.screenshot(page, 'admin_register_done');
        await page.waitForSelector('tr[data-key="study|sub-new01/eeg/sub-new01_task-rest_eeg.edf"]');
        // Its page: where it came from, and retiring it.
        await page.locator('tr[data-key="study|sub-new01/eeg/sub-new01_task-rest_eeg.edf"] button', { hasText: 'Manage' }).click();
        const detail = page.locator('.admin-detail');
        await detail.waitFor();
        assert.match((await detail.innerText()).replace(/\s+/g, ' '), /by ADMIN, from a browser/);
        // Adding the same folder again changes nothing.
        await page.setInputFiles('input[data-log="register-folder"]', data.folder);
        await page.waitForSelector('[data-log="register"]');
        assert.match(await page.textContent('.admin-review'), /registered already/);
        await page.click('[data-log="register"]');
        await page.waitForFunction(() => /skipped 1/.test(document.querySelector('.admin-review')?.textContent || ''));

        // Assign it to A01, who opens the file from disk, annotates and saves.
        await goSection(page, 'Assignments', 'admin-assignments');
        await page.check('input[data-name="annotators"][value="A01"]');
        await page.check('input[data-name="recordings"][value="sub-new01/eeg/sub-new01_task-rest_eeg.edf"]');
        await page.click('[data-log="assign"]');
        await page.waitForFunction(() => /Assigned: 1 new assignment/.test(document.querySelector('.admin-section[data-section="assignments"] .admin-msg')?.textContent || ''));
        await page.click('[data-log="sign-out"]');
        await signIn(page, 'A01');
        await waitForRoute(page, 'home');
        assert.match(await page.textContent('main'), /0 of 4\s*recordings done/);
        await page.locator('tr', { hasText: 'sub-new01_task-rest_eeg.edf' }).locator('button', { hasText: 'Open' }).click();
        await waitForRoute(page, 'open');
        await page.setInputFiles('input[data-log="file-input"]', data.file);
        await waitForRoute(page, 'annotate', 30000);
        await waitForTraces(page);
        await page.keyboard.press('1');
        await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
        await pressSave(page);
        await clickDialogButton(page, 'Save and Finish');
        await waitForRoute(page, 'home', 30000);
        await page.locator('.dialog-buttons button').first().click();
        assert.match(await page.textContent('main'), /1 of 4\s*recordings done/);
        const doc = await page.evaluate(() => globalThis.ElectroTag.backend.resultsDocument().annotation_documents
          .find((d) => d.recording.recording_id === 'sub-new01/eeg/sub-new01_task-rest_eeg.edf'));
        assert.equal(doc.recording.sfreq, 200);
        assert.equal(doc.annotations.length, 1);

        // The administrator sees the saved work.
        await page.click('[data-log="sign-out"]');
        await signIn(page, 'ADMIN');
        await waitForRoute(page, 'admin');
        await page.waitForSelector('.stat-tile');
        assert.match(await sectionText(page), /sub-new01_task-rest_eeg\.edf/);
        assert.match(await sectionText(page), /4 Recordings registered/i);
      } finally {
        data.cleanup();
      }
    },
  },
  {
    name: 'the admin area in a window 400 pixels wide: every section without sideways scrolling',
    async run(t) {
      const { assert } = t;
      // A bookmarked section opens again once the administrator has signed in.
      const page = await t.newPage({ width: 400, height: 800, url: `${t.base}#admin-records` });
      await page.waitForSelector('form.signin-form');
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin-records');
      await page.waitForSelector('.admin-section[data-section="records"] td');
      assert.equal(await page.isVisible('.small-screen'), false);
      for (const [title, route] of [['Overview', 'admin'], ['Progress', 'admin-progress'], ['Annotators', 'admin-annotators'], ['Recordings', 'admin-recordings'],
        ['Assignments', 'admin-assignments'], ['Training', 'admin-training'], ['Analyses', 'admin-analyses'], ['Results', 'admin-results'],
        ['Records', 'admin-records'], ['Study settings', 'admin-settings']]) {
        await goSection(page, title, route);
        await page.waitForTimeout(150);
        assert.ok(await noSideways(page), `${title} scrolls sideways`);
        await t.screenshot(page, `admin_narrow_${route}`);
      }
      // Reference sets: a new set, its tabs and the criteria editor.
      await goSection(page, 'Training', 'admin-training');
      await page.locator('summary', { hasText: 'New reference set' }).click();
      const form = page.locator('details.admin-details[open] form');
      await form.locator('input').first().fill('pilot');
      await form.locator('input').nth(1).fill('Pilot set');
      await page.click('[data-log="set-create"]');
      await page.waitForFunction(() => /Pilot set/.test(document.querySelector('h2.set-title')?.textContent || ''));
      await page.click('.admin-tabs [data-tab="criteria"]');
      await page.locator('.criterion', { hasText: 'Event F1' }).locator('input[type="checkbox"]').check();
      await page.locator('.criterion', { hasText: 'Event F1' }).locator('input[type="number"]').fill('0.8');
      await page.click('[data-log="criteria-save"]');
      await page.waitForFunction(() => /Saved 1 criterion/.test(document.querySelector('.admin-section[data-section="training"]')?.textContent || ''));
      assert.ok(await noSideways(page));
      await t.screenshot(page, 'admin_narrow_criteria');
      // Narrowing and widening keeps the admin area (the annotating views still ask for a larger screen).
      await page.setViewportSize({ width: 1280, height: 720 });
      assert.equal(await page.isVisible('.admin-nav'), true);
    },
  },
];
