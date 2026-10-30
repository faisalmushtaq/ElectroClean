// The admin area with the real study server (`electrotag-web demo`, started by run_e2e.mjs):
// accounts, the agreement and activity reports, a consensus reference, every result as a zip
// file, and recordings added from this computer. The server's admin operations
// (POST /api/v1/admin/{op}) come with the service layer's admin work; until a server has them,
// the admin area says so in plain words and the tests that need them are skipped.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkipTest, signIn, waitForRoute } from './helpers.mjs';

const PASSWORD = 'electrotag';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTER_JS = path.resolve(HERE, '..', '..', 'electrotag', 'web', 'static', 'js', 'eeg', 'register.js');
const NO_ADMIN = 'the study server has no admin operations yet (POST /api/v1/admin/overview answers 404)';

async function api(t, method, p, body, token) {
  const headers = { 'X-ElectroTag': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${t.study.base}api/v1${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

async function login(t, id) {
  const r = await api(t, 'POST', '/login', { annotator_id: id, password: PASSWORD });
  if (r.status !== 200) throw new Error(`${id} could not sign in: ${JSON.stringify(r.json)}`);
  return r.json.token;
}

/** Skips the test unless the server answers the admin area's operations. */
async function needsAdminOperations(t) {
  const token = await login(t, 'ADMIN');
  const r = await api(t, 'POST', '/admin/overview', {}, token);
  if (r.status === 404) throw new SkipTest(NO_ADMIN);
  if (r.status !== 200) throw new Error(`admin/overview answered ${r.status}: ${JSON.stringify(r.json)}`);
  return token;
}

function recordingFile(t, name) {
  let found = null;
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f === name) found = p;
    }
  })(path.join(t.study.dir, 'recordings'));
  if (!found) throw new Error(`no ${name} in the demonstration's recordings`);
  return found;
}

/** Save annotations of an EDF recording for an annotator, through the API (as the browser does). */
async function saveAs(t, id, fileName, marks) {
  const token = await login(t, id);
  const file = recordingFile(t, fileName);
  const bytes = fs.readFileSync(file);
  const m = await api(t, 'POST', '/match', { file_name: fileName, size_bytes: bytes.length, format: 'edf',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, token);
  if (m.json.status === 'done') return;
  if (m.json.status !== 'matched') throw new Error(`${fileName} is not ${id}'s: ${JSON.stringify(m.json)}`);
  const sf = m.json.manifest.sfreq;
  const stamp = new Date().toISOString();
  const annotations = marks.map(([label, from, to], i) => ({ annotation_id: `${id.toLowerCase()}${i}`.padEnd(32, '0'), label,
    onset_sample: Math.round(from * sf), duration_samples: Math.round((to - from) * sf), channels: [], created_at: stamp, modified_at: stamp }));
  const r = await api(t, 'POST', '/submissions', { recording_id: m.json.recording_id, mode: m.json.mode, context_id: m.json.context_id,
    annotations, session: { started_at: stamp, elapsed_s: 30 }, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, token);
  if (r.status !== 200 && r.json.error !== 'already_done') throw new Error(`saving for ${id}: ${JSON.stringify(r.json)}`);
}

async function adminPage(t, { width = 1280, height = 720 } = {}) {
  const page = await t.newPage({ url: t.study.base, width, height });
  await signIn(page, 'ADMIN', PASSWORD);
  await waitForRoute(page, 'admin');
  return page;
}

async function goSection(page, title, route) {
  await page.locator('.admin-nav a', { hasText: title }).click();
  await waitForRoute(page, route);
}

export const tests = [
  {
    name: 'the admin area on the study server: its overview, or a plain message while the server has no admin operations',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const page = await adminPage(t);
      await page.waitForSelector('.stat-tile, .admin-section[data-section="overview"] .error-banner', { timeout: 20000 });
      const token = await login(t, 'ADMIN');
      const offered = (await api(t, 'POST', '/admin/overview', {}, token)).status !== 404;
      if (!offered) {
        assert.match(await page.innerText('.admin-main'), /This study does not offer this part of the admin area yet/);
        await t.screenshot(page, 'admin_server_not_offered');
        return;
      }
      const text = (await page.innerText('.admin-main')).replace(/\s+/g, ' ');
      assert.match(text, /\d+ Recordings registered for the study/i); // the label is shown in capitals
      await t.screenshot(page, 'admin_server_overview');
    },
  },
  {
    name: 'accounts on the study server: an annotator added with a temporary password signs in with it',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      await needsAdminOperations(t);
      const page = await adminPage(t);
      await goSection(page, 'Annotators', 'admin-annotators');
      const form = page.locator('form.admin-form').first();
      await form.locator('input').nth(0).fill('A07');
      await form.locator('input').nth(1).fill('Annotator seven');
      await page.click('[data-log="user-add"]');
      await page.waitForSelector('.secret-value', { timeout: 20000 });
      const password = (await page.textContent('.secret-value')).trim();
      assert.ok(password.length >= 8);
      await page.waitForSelector('tr[data-key="A07"]');
      const other = await t.newPage({ url: t.study.base });
      await signIn(other, 'A07', password);
      await waitForRoute(other, 'home');
      assert.equal(await other.locator('[data-log="admin"]').count(), 0);
      // The change is in the audit log.
      await goSection(page, 'Records', 'admin-records');
      await page.waitForFunction(() => /A07/.test(document.querySelector('.admin-section[data-section="records"]')?.innerText || ''), null, { timeout: 20000 });
    },
  },
  {
    name: 'the agreement and activity reports, a consensus reference and every result as a zip file',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      await needsAdminOperations(t);
      // Two annotators' work on the same recording.
      await saveAs(t, 'A01', 'sub-003_task-rest_eeg.edf', [['Eye-blink-artifact', 3.0, 3.4], ['EMG-artifact', 10, 12]]);
      await saveAs(t, 'A02', 'sub-003_task-rest_eeg.edf', [['Eye-blink-artifact', 3.05, 3.45], ['Movement-artifact', 20, 21]]);
      const page = await adminPage(t);

      await goSection(page, 'Analyses', 'admin-analyses');
      await page.click('[data-log="agreement-run"]');
      assert.equal(await page.isDisabled('[data-log="agreement-run"]'), true, 'an analysis cannot be started twice');
      await page.waitForSelector('.admin-section[data-section="analyses"] iframe.report-frame', { timeout: 240000 });
      const frame = page.locator('iframe.report-frame').first();
      assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
      assert.ok((await page.locator('.downloads button', { hasText: '.tsv' }).count()) > 0, 'the tables are offered');
      const [report] = await Promise.all([page.waitForEvent('download'), page.locator('button', { hasText: 'Download the report (HTML)' }).first().click()]);
      assert.equal(report.suggestedFilename(), 'agreement_report.html');
      await t.screenshot(page, 'admin_server_agreement');
      await page.click('[data-log="activity-run"]');
      await page.waitForFunction(() => document.querySelectorAll('.admin-section[data-section="analyses"] iframe.report-frame').length >= 2, null, { timeout: 240000 });

      // A reference set whose practice reference is the consensus of A01 and A02, with its disagreements.
      await goSection(page, 'Training', 'admin-training');
      await page.locator('summary', { hasText: 'New reference set' }).click();
      const form = page.locator('details.admin-details[open] form');
      await form.locator('input').first().fill('pilot');
      await form.locator('input').nth(1).fill('Pilot set');
      await page.click('[data-log="set-create"]');
      await page.waitForFunction(() => /Pilot set/.test(document.querySelector('h2.set-title')?.textContent || ''), null, { timeout: 20000 });
      const card = page.locator('.admin-card', { hasText: 'Add a recording with its reference' });
      await card.locator('select').first().selectOption('study|sub-003/eeg/sub-003_task-rest_eeg.edf');
      await card.locator('label.check', { hasText: 'Practice: on their own' }).click();
      await card.locator('label.check', { hasText: 'A consensus of several annotators' }).click();
      await card.locator('input[data-name="experts"][value="A01"]').check();
      await card.locator('input[data-name="experts"][value="A02"]').check();
      await page.click('[data-log="set-add-reference"]');
      await page.waitForSelector('text=Where the experts disagreed', { timeout: 60000 });
      assert.match(await page.innerText('.admin-section[data-section="training"]'), /consensus of several experts: A01, A02/);
      await t.screenshot(page, 'admin_server_consensus');

      // Every result.
      await goSection(page, 'Results', 'admin-results');
      await page.waitForSelector('.admin-section[data-section="results"] tr');
      const [zip] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('[data-log="results-zip"]')]);
      assert.match(zip.suggestedFilename(), /\.zip$/);
      const saved = await zip.path();
      assert.ok(fs.statSync(saved).size > 1000);
    },
  },
  {
    name: 'the agreement of the corrected and the adjudicated versions, compared with the originals',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      await needsAdminOperations(t);
      const fileName = 'sub-003_task-rest_eeg.edf';
      const rid = 'sub-003/eeg/sub-003_task-rest_eeg.edf';
      await saveAs(t, 'A01', fileName, [['Eye-blink-artifact', 3.0, 3.4], ['EMG-artifact', 10, 12]]);
      await saveAs(t, 'A02', fileName, [['Eye-blink-artifact', 3.05, 3.45], ['Movement-artifact', 20, 21]]);
      // E01 corrects A01's latest version (through the expert channel, as the correction view does): the EMG was a
      // movement artifact, as A02 saw it.
      const e01 = await login(t, 'E01');
      const got = await api(t, 'POST', '/expert/saved_attempt_get', { annotator_id: 'A01', recording_id: rid }, e01);
      assert.equal(got.status, 200, JSON.stringify(got.json));
      const original = got.json.annotations;
      const bytes = fs.readFileSync(recordingFile(t, fileName));
      const sf = got.json.manifest.sfreq;
      const emg = original.find((a) => a.label === 'EMG-artifact');
      const corrected = original.map((a) => (a === emg ? { ...a, label: 'Movement-artifact', onset_sample: Math.round(20 * sf), duration_samples: Math.round(sf) } : a));
      const cid = crypto.randomBytes(16).toString('hex');
      const saved = await api(t, 'POST', '/expert/correction_save', { correction_id: cid, annotator_id: 'A01', recording_id: rid,
        attempt: got.json.attempt, annotations: corrected, changes: [{ annotation_id: emg.annotation_id, reason: 'wrong_type' }],
        session: { started_at: new Date().toISOString(), elapsed_s: 20 }, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, e01);
      assert.equal(saved.status, 200, JSON.stringify(saved.json));

      const page = await adminPage(t);
      await goSection(page, 'Analyses', 'admin-analyses');
      const form = page.locator('.admin-card', { hasText: 'Agreement between annotators' });
      await form.locator('input[data-name="agreement-annotators"][value="A01"]').check();
      await form.locator('input[data-name="agreement-annotators"][value="A02"]').check();
      await page.selectOption('select[data-field="versions"]', 'corrected');
      assert.ok(await page.isVisible('label.check:has-text("Compare with the original versions")'));
      await page.click('[data-log="agreement-run"]');
      const compared = page.locator('.admin-card', { hasText: 'Compared with the original versions' });
      await compared.waitFor({ timeout: 240000 });
      const table = (await compared.innerText()).replace(/\s+/g, ' ');
      assert.match(table, /A01 – A02 Event F1, all categories/);
      assert.match(await page.innerText('.admin-section[data-section="analyses"]'), /Saved versions replaced by a correction\s+1 \(E01 1\)/);
      assert.ok(await page.locator('.downloads button', { hasText: 'corrections_effect.tsv' }).count(), 'the corrections\' table is offered');
      await t.screenshot(page, 'admin_server_agreement_corrected');
      const html = await page.frameLocator('iframe.report-frame').first().locator('body').innerText();
      assert.match(html, /Versions analysed/);

      // E01 adjudicates A01's and A02's versions, and the agreement is measured against the adjudicated version.
      const units = await api(t, 'POST', '/expert/adjudication_list', {}, e01);
      const unit = (units.json.units || []).find((u) => u.recording_id === rid && u.kind === 'recording');
      if (unit && unit.status !== 'adjudicated') {
        const started = await api(t, 'POST', '/expert/adjudication_start', { unit_id: unit.unit_id }, e01);
        if (started.status === 200) {
          for (const c of started.json.conflicts) {
            if (c.decision) continue;
            await api(t, 'POST', '/expert/adjudication_decide', { unit_id: unit.unit_id, conflict_id: c.conflict_id, choice: 'A', reason_code: 'clear_artifact' }, e01);
          }
          const fin = await api(t, 'POST', '/expert/adjudication_finish', { unit_id: unit.unit_id }, e01);
          assert.equal(fin.status, 200, JSON.stringify(fin.json));
        }
      }
      await page.selectOption('select[data-field="versions"]', 'adjudicated');
      assert.equal(await page.isVisible('select[data-field="reference"]'), false, 'the adjudicated versions are the reference');
      await page.click('[data-log="agreement-run"]');
      await page.waitForFunction(() => /against the adjudicated/i.test(document.querySelector('.admin-section[data-section="analyses"]')?.innerText || ''), null, { timeout: 240000 });
      await page.waitForFunction(() => /Adjudications used/.test(document.querySelector('.admin-section[data-section="analyses"]')?.innerText || ''), null, { timeout: 240000 });
      const report = await page.frameLocator('iframe.report-frame').first().locator('body').innerText();
      assert.match(report, /Before and after adjudication/);
      assert.match(report, /ADJUDICATED/);
      await t.screenshot(page, 'admin_server_agreement_adjudicated');
    },
  },
  {
    name: 'recordings chosen on this computer reach the study server as manifests',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      await needsAdminOperations(t);
      if (!fs.existsSync(REGISTER_JS)) throw new SkipTest('js/eeg/register.js, which reads recordings for the register, is not in this copy yet');
      const page = await adminPage(t);
      await goSection(page, 'Recordings', 'admin-recordings');
      await page.setInputFiles('input[data-log="register-folder"]', path.join(t.study.dir, 'recordings', 'study'));
      await page.waitForSelector('[data-log="register"]', { timeout: 120000 });
      assert.match(await page.innerText('.admin-review'), /Found 3 recordings/);
      await page.click('[data-log="register"]');
      // They are the study's recordings already: nothing is replaced without asking.
      await page.waitForFunction(() => /skipped 3/.test(document.querySelector('.admin-review')?.innerText || ''), null, { timeout: 60000 });
    },
  },
];
