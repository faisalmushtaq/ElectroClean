// The sign-up questionnaire (docs/web/using.md, "Before your first recording"): a new annotator's first
// sign-in shows it before anything else and the study refuses their work until it is answered; it can be
// changed later from the home page, with the history kept; the administrator sees the answers, the name
// and the contact details on the person's page, and an expert sees none of it. Nothing answered or typed
// reaches the interaction log, which records only questionnaire_answered and the number of questions.
// In the sandbox and against the real study server (electrotag-web demo).
import fs from 'node:fs';
import path from 'node:path';
import { signIn, waitForRoute } from './helpers.mjs';

const TYPED = ['Ama Owusu', 'ama@example.org', '113 000', 'University of Leeds', 'A summer school', 'Twi', 'Ghana'];
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** Answer every question on the page: the second option of each, words where they are asked, then the contacts. */
async function fillIn(page, { skip = null } = {}) {
  const questions = page.locator('fieldset.q-question');
  const n = await questions.count();
  for (let i = 0; i < n; i++) {
    const q = questions.nth(i);
    const id = await q.getAttribute('data-question');
    if (id === skip) continue;
    if (await q.locator('input.q-answer').count()) {
      await q.locator('input.q-answer').fill(id === 'country' ? 'Ghana' : 'Twi');
    } else if (id === 'artifact_training') {
      await q.locator('label.q-choice', { hasText: 'Other' }).click();
      await q.locator('input.q-other').fill('A summer school');
    } else if (id === 'age_band') {
      await q.locator('label.q-prefer').click();
    } else {
      await q.locator('label.q-choice').nth(1).click();
    }
  }
  await page.fill('input[name="full_name"]', 'Ama Owusu');
  await page.fill('input[name="email"]', 'ama@example.org');
  await page.fill('input[name="phone"]', '+44 113 000 0000');
  await page.fill('input[name="institution"]', 'University of Leeds');
}

async function firstSignIn(t, page, id, password) {
  const { assert } = t;
  await signIn(page, id, password, { questionnaire: 'stay' });
  await waitForRoute(page, 'questionnaire', 30000);
  assert.equal(await page.textContent('.q-page h1'), 'A few questions before you start');
  assert.equal(await page.locator('.q-page [data-log="questionnaire-back"]').count(), 0, 'no way past it at the first sign-in');
  // the study refuses work until it is answered, whatever the page shows
  const refused = await page.evaluate(() => globalThis.ElectroTag.backend.match({ sha256: '0'.repeat(64), size_bytes: 1 }).then(() => null, (e) => e.code));
  assert.equal(refused, 'questionnaire_required');
  // every question has Prefer not to say
  const n = await page.locator('fieldset.q-question').count();
  assert.equal(await page.locator('fieldset.q-question .q-prefer').count(), n);
  assert.ok(n >= 10, `${n} questions`);
  await t.screenshot(page, `questionnaire_top_${id}`);
  assert.equal(await page.inputValue('input[name="email"]'), `${id.toLowerCase()}@example.org`, 'the email comes from the account');
  await fillIn(page, { skip: 'eeg_years' });
  await page.click('[data-log="questionnaire-save"]');
  await page.waitForSelector('.q-problem:not([hidden])');
  assert.match(await page.textContent('.q-problem'), /Please answer “How many years have you worked with EEG\?”, or choose Prefer not to say\./);
  assert.equal(await page.evaluate(() => globalThis.ElectroTag.route), 'questionnaire');
  await page.locator('fieldset[data-question="eeg_years"] label.q-choice').first().click();
}

async function personPage(t, page, aid) {
  await page.evaluate((a) => globalThis.ElectroTag.showAdmin('admin-annotators', { annotator: a }), aid);
  await page.waitForSelector('.admin-card:has-text("Questionnaire and contact details") table');
  return (await page.locator('.admin-card', { hasText: 'Questionnaire and contact details' }).innerText()).replace(/\s+/g, ' ');
}

export const tests = [
  {
    name: 'demonstration: the first sign-in asks the questionnaire before any work, it is changed later, and only the study team sees it',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 900 });
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin');
      await page.evaluate(async () => {
        const b = globalThis.ElectroTag.backend;
        await b.admin('user_add', { annotator_id: 'Q01', display_name: 'New annotator', password: 'long enough', email: 'q01@example.org' });
        await b.admin('assign', { annotator_ids: ['Q01'], all: true });
      });
      await page.evaluate(() => globalThis.ElectroTag.signOut());
      await waitForRoute(page, 'signin');
      await firstSignIn(t, page, 'Q01', 'long enough');
      await t.screenshot(page, 'questionnaire_first');
      await page.click('[data-log="questionnaire-save"]');
      await waitForRoute(page, 'home');
      assert.match(await page.textContent('.q-home'), /You answered the sign-up questionnaire on \d+ \w+\. See or change my answers/);
      // the log has questionnaire_answered with the number answered, and nothing answered or typed
      await page.evaluate(() => globalThis.ElectroTag.flushLog());
      const events = await page.evaluate(() => [...globalThis.ElectroTag.backend.visits.values()].flatMap((v) => v.events));
      const answered = events.filter((e) => e.type === 'questionnaire_answered');
      assert.equal(answered.length, 1);
      assert.equal(answered[0].n_answered, 13);
      const logged = JSON.stringify(events);
      for (const w of [...TYPED, 'Postdoc', 'prefer_not_to_say']) assert.ok(!logged.includes(w), `the log holds ${w}`);
      // changing an answer later, from home: a second version is kept
      await page.click('[data-log="questionnaire-open"]');
      await waitForRoute(page, 'questionnaire');
      assert.equal(await page.textContent('.q-page h1'), 'Your answers');
      assert.equal(await page.inputValue('fieldset[data-question="artifact_training"] input.q-other'), 'A summer school');
      await page.locator('fieldset[data-question="datasets_analysed"] label.q-choice', { hasText: '31–100' }).click();
      await t.screenshot(page, 'questionnaire_edit');
      await page.click('[data-log="questionnaire-save"]');
      await waitForRoute(page, 'home');
      // an annotator never reads anyone's answers
      const forbidden = await page.evaluate(() => globalThis.ElectroTag.backend.admin('questionnaire_get', { annotator_id: 'Q01' }).then(() => null, (e) => e.code));
      assert.equal(forbidden, 'forbidden');
      // the administrator sees the answers, the history, the name and the contact details
      await page.evaluate(() => globalThis.ElectroTag.signOut());
      await waitForRoute(page, 'signin');
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin');
      const card = await personPage(t, page, 'Q01');
      assert.match(card, /Full name Ama Owusu/);
      assert.match(card, /Email ama@example\.org/);
      assert.match(card, /Institution University of Leeds/);
      assert.match(card, /How many EEG datasets have you analysed\? 31–100/);
      assert.match(card, /Earlier answers \(1\)/);
      await page.locator('.admin-card:has-text("Questionnaire and contact details")').scrollIntoViewIfNeeded();
      await t.screenshot(page, 'admin_person_questionnaire');
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-questionnaire'));
      await page.waitForSelector('.admin-section[data-section="questionnaire"] table');
      const section = (await page.innerText('.admin-section[data-section="questionnaire"]')).replace(/\s+/g, ' ');
      assert.match(section, /Q01/);
      assert.ok(!section.includes('Ama Owusu'), 'the summary is by annotator ID');
      assert.match(section, /The contacts list identifies people/);
      assert.ok(await noSideways(page));
      await t.screenshot(page, 'admin_questionnaire');
      // the editor in Study settings, with the ethics note
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-settings'));
      await page.waitForSelector('.admin-card:has-text("Sign-up questionnaire") .q-edit');
      assert.match(await page.textContent('.demographics-note'), /ethics approval covers/);
      await page.locator('.admin-card:has-text("Sign-up questionnaire")').scrollIntoViewIfNeeded();
      await page.locator('.q-edit summary').first().click();
      await t.screenshot(page, 'admin_questionnaire_editor');
      await page.close();
      // an expert sees nobody's answers or details
      const expert = await t.newPage({ width: 1280, height: 900 });
      await signIn(expert, 'E01');
      await expert.waitForFunction(() => globalThis.ElectroTag && ['home', 'expert'].includes(globalThis.ElectroTag.route));
      const got = await expert.evaluate(() => globalThis.ElectroTag.backend.admin('questionnaire_summary', {}).then(() => null, (e) => e.code));
      assert.equal(got, 'forbidden');
      await expert.evaluate(() => globalThis.ElectroTag.showExpert('expert'));
      await waitForRoute(expert, 'expert');
      const shown = await expert.innerText('body');
      for (const w of ['Ama Owusu', 'ama@example.org', '31–100']) assert.ok(!shown.includes(w), `the expert area shows ${w}`);
      await expert.close();
    },
  },
  {
    name: 'demonstration: the questionnaire at phone width keeps to the screen',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 400, height: 860 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      const stay = page.locator('button', { hasText: 'Continue in this window' });
      if (await stay.count()) await stay.click(); // a phone is told that annotating needs a larger screen
      await page.evaluate(() => globalThis.ElectroTag.showQuestionnaire());
      await waitForRoute(page, 'questionnaire');
      assert.equal(await page.isChecked('fieldset[data-question="datasets_analysed"] input[value="3–10"]'), true, 'the example answers are filled in');
      assert.ok(await noSideways(page), 'nothing runs off the side');
      await t.screenshot(page, 'questionnaire_phone');
    },
  },
  {
    name: 'study server: a new annotator answers before work, the log keeps no answers, and the administrator sees the contact details',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ url: t.study.base });
      await signIn(page, 'ADMIN', 'electrotag');
      await waitForRoute(page, 'admin');
      await page.evaluate(async () => {
        const b = globalThis.ElectroTag.backend;
        await b.admin('user_add', { annotator_id: 'Q02', display_name: 'New annotator', password: 'long enough', email: 'q02@example.org' });
        await b.admin('assign', { annotator_ids: ['Q02'], all: true });
      });
      await page.evaluate(() => globalThis.ElectroTag.signOut());
      await waitForRoute(page, 'signin');
      await firstSignIn(t, page, 'Q02', 'long enough');
      await page.click('[data-log="questionnaire-save"]');
      await waitForRoute(page, 'home');
      const ok = await page.evaluate(() => globalThis.ElectroTag.backend.match({ sha256: '0'.repeat(64), size_bytes: 1 }).then((r) => r.status, (e) => e.code));
      assert.equal(ok, 'unknown', 'work opens once it is answered');
      await page.evaluate(() => globalThis.ElectroTag.signOut());
      await waitForRoute(page, 'signin');
      // the interaction log written by the study
      const root = path.join(t.study.dir, 'study', 'Annotated_Events', 'interaction_logs', 'annotator-Q02');
      const text = fs.readdirSync(root).map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
      const events = text.trim().split('\n').map((line) => JSON.parse(line));
      const answered = events.filter((e) => e.type === 'questionnaire_answered');
      assert.equal(answered.length, 1);
      assert.equal(answered[0].n_answered, 13);
      for (const w of [...TYPED, 'Postdoc', 'prefer_not_to_say']) assert.ok(!text.includes(w), `the log holds ${w}`);
      await signIn(page, 'ADMIN', 'electrotag');
      await waitForRoute(page, 'admin');
      const card = await personPage(t, page, 'Q02');
      assert.match(card, /Full name Ama Owusu/);
      assert.match(card, /Phone \+44 113 000 0000/);
      assert.match(card, /What is your career stage\? Master's/);
      // the audit log says only that the details changed
      const audit = await page.evaluate(() => globalThis.ElectroTag.backend.admin('audit', {}));
      const said = JSON.stringify(audit);
      assert.match(said, /Q02's contact details changed/);
      for (const w of TYPED) assert.ok(!said.includes(w), `the audit log holds ${w}`);
    },
  },
];
