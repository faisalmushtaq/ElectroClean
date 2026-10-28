// The admin area's screens for what only a study can compute, against a stand-in for the study
// server that answers with the shapes of docs/web/api.md ("Administration"): the agreement and
// activity reports in their sandboxed frames and their downloads, a competency report, a consensus
// reference with its disagreements, the example set's recordings, every result as a zip file (and
// the command when it is too large), an invitation link, and that an analysis is not started twice.
import fs from 'node:fs';
import { signIn, waitForRoute } from './helpers.mjs';

const REC = 'sub-01/eeg/sub-01_task-rest_eeg.vhdr';

/** The stand-in study: routes every /api/v1 request of the page. */
function contractStudy(catalogue) {
  const s = { calls: [], tooLarge: false, sets: [], users: [
    { annotator_id: 'ADMIN', display_name: 'Lead', email: null, role: 'admin', status: 'active', created_at: '2026-10-01T09:00:00+00:00', last_seen: null, notes: '', assigned: 0, done: 0, programme: null },
    { annotator_id: 'E1', display_name: 'Expert one', email: 'e1@example.org', role: 'annotator', status: 'active', created_at: '2026-10-01T09:00:00+00:00', last_seen: null, notes: '', assigned: 1, done: 1, programme: null },
    { annotator_id: 'E2', display_name: 'Expert two', email: 'e2@example.org', role: 'annotator', status: 'active', created_at: '2026-10-01T09:00:00+00:00', last_seen: null, notes: '', assigned: 1, done: 1, programme: null },
  ] };
  const rec = (scope) => ({ scope, recording_id: REC, file_name: 'sub-01_task-rest_eeg.vhdr', format: 'brainvision', sfreq: 250, n_samples: 15000,
    duration_s: 60, n_channels: 32, size_bytes: 1000, sha256: 'a'.repeat(64), registered_at: '2026-10-01T09:00:00+00:00', registered_by: 'command',
    registered_via: 'command', notes: '', retired: false, assigned: 2, done: 2, warnings: [] });
  const set = (id, name) => ({ set_id: id, name, description: '', created_at: '2026-10-01T09:00:00+00:00', created_by: 'ADMIN', practice_review: true,
    allowed_annotators: [], practice_pass: { event_f1: 0.8, label_accuracy: 0.8 }, guided_tolerance: { seconds: 0.2, fraction: 0.2, channel_jaccard: 0.75 },
    criteria: { criteria: [], min_reference_events: 3, categories: null }, recordings: [], quiz_items: 0 });
  s.sets.push(set('pilot', 'Pilot set'));
  const b64 = (text) => Buffer.from(text).toString('base64');
  const ops = {
    overview: () => ({ study: { study_id: 'pilot', name: 'Pilot study' }, counts: { recordings: 1, annotators: 2, admins: 1, assignments: 2, done: 2, in_progress: 0, todo: 0 },
      recent: [{ at: '2026-10-28T10:15:02.120+00:00', by: 'command', op: 'register', summary: 'Registered 1 recording', details: {} }],
      last_saved: [{ annotator_id: 'E1', recording_id: REC, mode: 'standard', context_id: '', at: '2026-10-28T10:20:00+00:00' }] }),
    users_list: () => ({ users: s.users }),
    user_add: (b) => {
      const u = { annotator_id: b.annotator_id, display_name: b.display_name, email: b.email, role: b.role, status: 'active', created_at: '2026-10-28T11:00:00+00:00',
        last_seen: null, notes: '', assigned: 0, done: 0, programme: null };
      s.users.push(u);
      return { user: u, invite_link: `https://pilot.example.org/invite?code=${b.annotator_id}`, temporary_password: null };
    },
    recordings_list: (b) => ({ recordings: [rec('study'), ...s.sets.filter((x) => x.recordings.length).map((x) => rec(`set:${x.set_id}`))].filter((r) => !b.scope || r.scope === b.scope) }),
    sets_list: () => ({ sets: s.sets }),
    settings_get: () => ({ name: 'Pilot study', settings: { filters: {}, display: {}, channels: {}, selection: { strategy: 'random', seed: null }, logging: {}, annotation: {}, loading: {} }, logging_notice: '' }),
    set_example_create: () => {
      s.sets.push({ ...set('example', 'Example training set'), recordings: [{ recording_id: 'sub-example01/eeg/sub-example01_task-example_eeg.vhdr', use: 'guided', guidance: 'auto',
        effective_guidance: 'show', provenance: { method: 'single_expert', experts: ['SIM'] }, n_reference_events: 6, registered: true }] });
      return { set: s.sets[s.sets.length - 1], recordings_zip: { file_name: 'example_recordings.zip', base64: b64('PK example') } };
    },
    set_add_reference: (b) => {
      const x = s.sets.find((y) => y.set_id === b.set_id);
      x.recordings.push({ recording_id: b.recording_id, use: b.use, guidance: 'auto', effective_guidance: null,
        provenance: { method: 'consensus', experts: b.source.annotator_ids, min_agreement: 2 }, n_reference_events: 4, registered: true });
      return { set: x, disagreements: [
        { kind: 'time', label: 'Eye-blink-artifact', onset_s: 3.0, offset_s: 3.05, experts_marking: 'E1', experts_not_marking: 'E2', note: '1 of 2 experts; not in consensus' },
        { kind: 'channels', label: 'EMG-artifact', onset_s: 10, offset_s: 12, experts_marking: 'E1, E2', experts_not_marking: '', note: 'channel selections differ' },
      ] };
    },
    quiz_items: () => ({ items: [] }),
    agreement: async (b) => {
      await new Promise((r) => setTimeout(r, 700));
      return { summary: { n_recordings: 1, annotators: ['E1', 'E2'], kappa_any_artifact: 0.71234 }, warnings: ['One recording has only one annotator.'],
        report_html: '<!doctype html><title>Agreement</title><h1>Agreement report</h1><script>document.body.dataset.ran = "yes";</script>',
        tables: { 'events_summary.tsv': 'category\tf1\nANY-artifact\t0.8\n', 'timeresolved_pairwise.tsv': 'a\tb\n' } };
    },
    activity: () => ({ report_html: '<!doctype html><h1>Activity</h1>', tables: { 'visits.tsv': 'visit\tseconds\n1\t30\n' } }),
    competency: (b) => ({ report: { annotator_id: b.annotator_id, status: 'met', status_text: 'Competency criteria met' }, html: '<!doctype html><h1>Competency of E1</h1>' }),
    results_zip: () => (s.tooLarge ? { status: 413, body: { error: 'too_large', message: 'The results are larger than 25 MB.' } }
      : { file_name: 'pilot_results.zip', base64: b64('PK results'), size_bytes: 10 }),
    progress: () => ({ study: 'Pilot study', generated_at: '2026-10-28T11:00:00+00:00', annotators: [] }),
  };
  const me = { annotator_id: 'ADMIN', display_name: 'Lead', role: 'admin', programme: null, catalogue, quizzes: [],
    study: { study_id: 'pilot', name: 'Pilot study', filters: { highpass_enabled: true, highpass_hz: 1, notch_enabled: true, notch_hz: 50, notch_harmonics: false, locked: false },
      display: { duration_s: 10, n_channels: 32 }, annotation: { min_duration_samples: 1, quick_labels: [] },
      logging: { interactions: false, pointer_hz: 5, idle_after_s: 30 }, logging_notice: '' } };
  s.handle = async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^.*\/api\/v1/, '');
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    const send = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (p === '/health') return send(200, { ok: true, version: '1.1.0', study: 'Pilot study', demo: false });
    if (p === '/login') return send(200, { token: 'tok', expires_in_s: 43200, annotator_id: 'ADMIN', display_name: 'Lead', role: 'admin' });
    if (p === '/me') return send(200, me);
    if (p === '/assignments') return send(200, { items: [], next: null });
    if (p === '/visits') return send(200, { visit_id: null, logging: me.study.logging });
    if (p === '/logout') return send(200, {});
    const m = /^\/admin\/([a-z_]+)$/.exec(p);
    if (m && ops[m[1]]) {
      s.calls.push({ op: m[1], body, headers: req.headers() });
      const out = await ops[m[1]](body);
      return out && out.status && out.body ? send(out.status, out.body) : send(200, out);
    }
    return send(404, { error: 'not_found', message: `There is no /api/v1${p}` });
  };
  return s;
}

async function goSection(page, title, route) {
  await page.locator('.admin-nav a', { hasText: title }).click();
  await waitForRoute(page, route);
}

async function download(page, click) {
  const [d] = await Promise.all([page.waitForEvent('download'), click()]);
  return { name: d.suggestedFilename(), text: fs.readFileSync(await d.path(), 'utf8') };
}

export const tests = [
  {
    name: 'the screens of the analyses, references and downloads, against a stand-in study server',
    async run(t) {
      const { assert } = t;
      const { CATALOGUE } = await import('../../electroclean/web/static/js/api/demo_catalogue.js');
      const study = contractStudy(CATALOGUE);
      const page = await t.newPage({ width: 1280, height: 720, url: null });
      await page.route('**/api/v1/**', study.handle);
      await page.goto(t.base);
      await signIn(page, 'ADMIN', 'secret');
      await waitForRoute(page, 'admin');
      await page.waitForSelector('.stat-tile');
      assert.equal(study.calls[0].op, 'overview');
      assert.equal(study.calls[0].headers['x-electroclean'], '1');
      assert.equal(study.calls[0].headers.authorization, 'Bearer tok');

      // An invitation link, shown once (as a study on Firebase answers).
      await goSection(page, 'Annotators', 'admin-annotators');
      const form = page.locator('form.admin-form').first();
      await form.locator('input').nth(0).fill('E3');
      await form.locator('input[type="email"]').fill('e3@example.org');
      await page.click('[data-log="user-add"]');
      await page.waitForSelector('.secret-value');
      assert.match(await page.innerText('.secret'), /Invitation link for E3/);
      assert.equal(await page.textContent('.secret-value'), 'https://pilot.example.org/invite?code=E3');
      assert.deepEqual(study.calls.find((c) => c.op === 'user_add').body, { annotator_id: 'E3', display_name: '', email: 'e3@example.org', role: 'annotator' });

      // The agreement analysis: the settings sent, one run at a time, the report and its tables.
      await goSection(page, 'Analyses', 'admin-analyses');
      await page.check('input[data-name="agreement-annotators"][value="E1"]');
      await page.check('input[data-name="agreement-annotators"][value="E2"]');
      await page.locator('summary', { hasText: 'Settings of the analysis' }).click();
      await page.locator('.admin-field', { hasText: 'Time bins (s)' }).locator('input').fill('0.1, 0.5');
      await page.click('[data-log="agreement-run"]');
      await page.locator('[data-log="agreement-run"]').click({ force: true }).catch(() => {});
      await page.waitForSelector('iframe.report-frame');
      assert.equal(study.calls.filter((c) => c.op === 'agreement').length, 1, 'the analysis ran once');
      const sent = study.calls.find((c) => c.op === 'agreement').body;
      assert.deepEqual(sent.annotator_ids, ['E1', 'E2']);
      assert.deepEqual(sent.modes, ['standard']);
      assert.equal(sent.recording_ids, undefined);
      assert.deepEqual(sent.config.resolutions_s, [0.1, 0.5]);
      assert.equal(sent.config.match_criterion, 'iou');
      assert.equal(sent.config.categories, null);
      assert.equal('annotators' in sent.config || 'modes' in sent.config, false);
      const text = await page.innerText('.admin-section[data-section="analyses"]');
      assert.match(text, /One recording has only one annotator\./);
      assert.match(text, /kappa any artifact\s+0\.712/i); // the label is shown in capitals
      const frame = page.frameLocator('iframe.report-frame').first();
      assert.equal(await frame.locator('h1').textContent(), 'Agreement report');
      await frame.locator('body[data-ran="yes"]').waitFor({ timeout: 5000 }); // the report's own script runs in its sandbox
      assert.equal(await page.locator('iframe.report-frame').first().getAttribute('sandbox'), 'allow-scripts');
      const tsv = await download(page, () => page.locator('.downloads button', { hasText: 'events_summary.tsv' }).click());
      assert.deepEqual(tsv, { name: 'events_summary.tsv', text: 'category\tf1\nANY-artifact\t0.8\n' });
      const html = await download(page, () => page.locator('button', { hasText: 'Download the report (HTML)' }).first().click());
      assert.equal(html.name, 'agreement_report.html');
      assert.match(html.text, /Agreement report/);
      const settings = await download(page, () => page.locator('button', { hasText: 'The settings used (JSON)' }).click());
      assert.deepEqual(JSON.parse(settings.text).config.resolutions_s, [0.1, 0.5]);
      await t.screenshot(page, 'admin_contract_agreement');

      // Activity, and a competency report.
      await page.click('[data-log="activity-run"]');
      await page.waitForFunction(() => document.querySelectorAll('iframe.report-frame').length === 2);
      await page.locator('.admin-card', { hasText: 'Competency reports' }).locator('select').nth(1).selectOption('E1');
      await page.click('[data-log="competency-run"]');
      await page.waitForSelector('text=Competency criteria met');
      assert.deepEqual(study.calls.find((c) => c.op === 'competency').body, { set_id: 'pilot', annotator_id: 'E1' });

      // The example set, with its recordings to download; a consensus reference and its disagreements.
      await goSection(page, 'Training', 'admin-training');
      await page.locator('summary', { hasText: 'Example training set' }).click();
      await page.locator('button', { hasText: 'Create the example training set' }).click();
      const zip = await download(page, () => page.locator('button', { hasText: 'Download the example recordings (zip)' }).click());
      assert.deepEqual(zip, { name: 'example_recordings.zip', text: 'PK example' });
      await page.locator('.set-item', { hasText: 'Pilot set' }).click();
      const card = page.locator('.admin-card', { hasText: 'Add a recording with its reference' });
      await card.locator('select').first().selectOption(`study|${REC}`);
      await card.locator('label.check', { hasText: 'Assessment: blinded' }).click();
      await card.locator('label.check', { hasText: 'A consensus of several annotators' }).click();
      await card.locator('input[data-name="experts"][value="E1"]').check();
      await page.click('[data-log="set-add-reference"]');
      await page.waitForSelector('.admin-section[data-section="training"] .error-banner');
      assert.match(await page.innerText('.admin-section[data-section="training"] .error-banner'), /at least two experts/);
      await card.locator('input[data-name="experts"][value="E2"]').check();
      await card.locator('.admin-field', { hasText: 'Needed to agree' }).locator('input').fill('2');
      await page.click('[data-log="set-add-reference"]');
      await page.waitForSelector('text=Where the experts disagreed (2)');
      const ref = study.calls.find((c) => c.op === 'set_add_reference').body;
      assert.deepEqual(ref, { set_id: 'pilot', recording_id: REC, recording_scope: 'study', use: 'assessment',
        source: { kind: 'consensus', annotator_ids: ['E1', 'E2'], min_agreement: 2, merge_gap_s: 0, min_duration_s: 0 }, provenance: { notes: '' } });
      const dis = await download(page, () => page.locator('button', { hasText: 'Download the table (TSV)' }).click());
      assert.equal(dis.name, 'sub-01_task-rest_eeg_disagreements.tsv');
      assert.match(dis.text, /^kind\tlabel\tonset_s\toffset_s\texperts_marking\texperts_not_marking\tnote\ntime\tEye-blink-artifact\t3\.0000\t3\.0500\tE1\tE2\t/);
      assert.match(await page.innerText('.admin-section[data-section="training"]'), /consensus of several experts: E1, E2 \(2 needed to agree\)/);
      await t.screenshot(page, 'admin_contract_consensus');

      // Every result as one zip file, or the command when it is too large.
      await goSection(page, 'Results', 'admin-results');
      const results = await download(page, () => page.click('[data-log="results-zip"]'));
      assert.deepEqual(results, { name: 'pilot_results.zip', text: 'PK results' });
      study.tooLarge = true;
      await page.click('[data-log="results-zip"]');
      await page.waitForSelector('pre.command');
      assert.match(await page.textContent('pre.command'), /Annotated_Events/);
      assert.match(await page.innerText('.admin-section[data-section="results"]'), /too large to send through the page/);
    },
  },
];
