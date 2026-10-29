// Confidence and notes: in an optional study (the default) a new mark has none and D, the context
// menu and the Annotations table give one or clear it; in an every-mark study (chosen in the admin
// area's Study settings) every new mark starts as definite and D skips "not given". A note is added
// from the menu, the table and Edit times…, saved with the annotation, and logged only by its length.
// On an iPad the table's buttons and a long press do the same. The last test saves on the real study
// server and reads the saved row of events.tsv.
import fs from 'node:fs';
import path from 'node:path';
import { SkipTest, annotations, clickDialogButton, drag, eegPoint, openExample, pressSave, signIn, waitForRoute, waitForTraces } from './helpers.mjs';

const NOTE = 'Could be an eye movement rather than a blink';
const PASSWORD = 'electrotag';

/** Every event logged in this visit so far (the demonstration's own copy). */
async function events(page) {
  return page.evaluate(async () => {
    await globalThis.ElectroTag.flushLog();
    return globalThis.ElectroTag.backend.resultsDocument().interaction_logs.flatMap((l) => l.events);
  });
}

const firstConfidence = async (page) => (await annotations(page))[0].confidence || '';
const labelCell = (page) => page.locator('.ann-table tbody tr').first().locator('td.label');

/** The middle of the first annotation, in client coordinates. */
async function middleOfFirst(page) {
  const a = (await annotations(page))[0];
  return eegPoint(page, (a.onset_sample + a.duration_samples / 2) / 250);
}

/** Right-click the first annotation and choose `level` under Set confidence…. */
async function menuConfidence(page, level) {
  const p = await middleOfFirst(page);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await page.waitForSelector('.menu');
  await page.locator('.menu-item', { hasText: 'Set confidence…' }).click();
  await page.waitForSelector('.menu.sub');
  const items = await page.locator('.menu.sub .menu-item').allTextContents();
  await page.locator('.menu.sub .menu-item', { hasText: level }).click();
  await page.waitForSelector('.menu', { state: 'detached' });
  return items.map((s) => s.trim());
}

/** Choose a confidence setting in the admin area's Study settings and save it. */
async function chooseSetting(page, value) {
  await signIn(page, 'ADMIN');
  await page.waitForFunction(() => /^admin/.test(globalThis.ElectroTag.route || ''));
  await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-settings'));
  const section = '.admin-section[data-section="settings"]';
  await page.waitForSelector(`${section} input[name="confidence"]`);
  return { section, async save() {
    await page.check(`${section} input[name="confidence"][value="${value}"]`);
    await page.click('[data-log="settings-save"]');
    await page.waitForFunction((s) => /The settings are saved/.test(document.querySelector(`${s} > .admin-msg`)?.textContent || ''), section);
  } };
}

export const tests = [
  {
    name: 'an optional study: no confidence until given, D and the menu set and clear it, a note is kept and saved, the log has only its length',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.s.confidenceMode), 'optional');
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.6));
      assert.equal((await annotations(page)).length, 1);
      // A new mark looks as marks always have: no confidence, nothing added to the table or the tag.
      assert.equal(await firstConfidence(page), '');
      assert.equal(await labelCell(page).locator('.conf-mark, .note-mark').count(), 0);
      assert.doesNotMatch(await page.textContent('.ann-table'), /probable|possible|definite/);
      // The mean colour of a strip of the annotation's fill (after the next frames are drawn).
      const fillOf = () => page.evaluate(async () => {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const v = globalThis.ElectroTag.ws.viewer;
        const a = globalThis.ElectroTag.ws.store.annotations()[0];
        const dpr = window.devicePixelRatio || 1;
        const x = Math.round(v.tToX((a.onset_sample + a.duration_samples / 2) / 250) * dpr);
        const y = Math.round(v.y0 * dpr);
        const d = v.under.getContext('2d').getImageData(x - 2, y, 5, Math.round((v.y1 - v.y0) * dpr)).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
        return sum / (d.length / 4);
      });
      const plainFill = await fillOf();

      // D, with the new mark (nothing selected): definite, probable, possible, and not given again.
      const seen = [];
      for (let i = 0; i < 4; i++) { await page.keyboard.press('d'); seen.push(await firstConfidence(page)); }
      assert.deepEqual(seen, ['definite', 'probable', 'possible', '']);
      await page.keyboard.press('d');
      assert.equal(await labelCell(page).locator('.conf-mark.definite .ico-check').count(), 1, 'a tiny mark for definite, in the table only');
      assert.ok(Math.abs((await fillOf()) - plainFill) < 1, 'a definite mark is drawn as before');
      await page.keyboard.press('d');
      assert.equal((await labelCell(page).locator('.conf-mark').textContent()).trim(), 'prob.');
      assert.equal(await labelCell(page).locator('.conf-mark').getAttribute('title'), 'Confidence: probable');
      const lighter = await fillOf();
      assert.ok(lighter > plainFill + 5, `a probable mark is filled more lightly (${lighter} vs ${plainFill})`);
      await t.screenshot(page, 'confidence_probable');

      // Undo goes back a level; the menu sets and clears a level directly.
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
      assert.equal(await firstConfidence(page), 'definite');
      const offered = await menuConfidence(page, 'Possible');
      assert.deepEqual(offered.slice(-4), ['Not given', 'Definite', 'Probable', 'Possible']);
      assert.equal(await firstConfidence(page), 'possible');
      await menuConfidence(page, 'Not given');
      assert.equal(await firstConfidence(page), '');

      // The table's button: one press gives the next level.
      await page.locator('.ann-table tbody tr').first().click();
      assert.equal((await page.textContent('[data-log="confidence"]')).trim(), 'Confidence: not given');
      await page.click('[data-log="confidence"]');
      assert.equal(await firstConfidence(page), 'definite');
      assert.equal((await page.textContent('[data-log="confidence"]')).trim(), 'Confidence: definite');

      // A note, from the context menu: kept, shown as a small icon with the text as its title.
      const p = await middleOfFirst(page);
      await page.mouse.click(p.x, p.y, { button: 'right' });
      await page.locator('.menu-item', { hasText: 'Add a note…' }).click();
      await page.waitForSelector('.note-dialog input[name="note"]');
      await page.fill('.note-dialog input[name="note"]', 'x'.repeat(201).slice(0, 200));
      assert.match(await page.textContent('.note-dialog .note-count'), /200 of 200 characters/);
      await page.fill('.note-dialog input[name="note"]', NOTE);
      await t.screenshot(page, 'confidence_note_dialog');
      await clickDialogButton(page, 'Keep note');
      assert.equal((await annotations(page))[0].note, NOTE);
      assert.equal(await labelCell(page).locator('.note-mark').getAttribute('title'), NOTE);
      assert.equal((await page.textContent('[data-log="note"]')).trim(), 'Edit note…');
      // Edit times… shows the note too, and can change it with the times in one step.
      await page.click('.btn-grid button:has-text("Edit times…")');
      await page.waitForSelector('input[name="note"]#times-note');
      assert.equal(await page.inputValue('#times-note'), NOTE);
      await page.fill('#times-note', `${NOTE}.`);
      await clickDialogButton(page, 'OK');
      assert.equal((await annotations(page))[0].note, `${NOTE}.`);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
      assert.equal((await annotations(page))[0].note, NOTE);
      await t.screenshot(page, 'confidence_table');

      // The interaction log: the levels and the note's length, never its text.
      const ev = await events(page);
      const conf = ev.filter((e) => e.type === 'confidence_set');
      assert.ok(conf.length >= 7, `${conf.length} confidence_set events`);
      assert.deepEqual(conf.slice(0, 4).map((e) => e.annotations[0].confidence), ['definite', 'probable', 'possible', null]);
      assert.equal(conf[0].via, 'shortcut:Confidence');
      const notes = ev.filter((e) => e.type === 'note_set');
      assert.deepEqual(notes.map((e) => [e.annotations[0].change, e.annotations[0].note_length]), [['added', NOTE.length], ['changed', NOTE.length + 1]]);
      assert.ok(!JSON.stringify(ev).includes('eye movement rather'), 'the note text is never logged');

      // Saved with the annotation (the draft first, then Save and Finish).
      await page.evaluate(() => globalThis.ElectroTag.ws.s.saveLocal());
      const draft = await page.evaluate(() => JSON.parse(localStorage.getItem(globalThis.ElectroTag.ws.s.localKey)));
      assert.deepEqual([draft.annotations[0].confidence, draft.annotations[0].note], ['definite', NOTE]);
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 20000 });
      const saved = await page.evaluate(() => globalThis.ElectroTag.backend.resultsDocument().annotation_documents.at(-1));
      assert.equal(saved.session.confidence, 'optional');
      assert.deepEqual([saved.annotations[0].confidence, saved.annotations[0].note], ['definite', NOTE]);
    },
  },
  {
    name: 'every mark: chosen in the admin area\'s Study settings, new marks start as definite and D skips not given',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      const s = await chooseSetting(page, 'every_mark');
      const text = (await page.textContent(s.section)).replace(/\s+/g, ' ');
      assert.match(text, /Confidence/);
      assert.match(text, /Optional\s*A new mark has no confidence/);
      assert.match(text, /Every mark\s*Every new mark starts as definite/);
      assert.equal(await page.isChecked(`${s.section} input[name="confidence"][value="optional"]`), true, 'optional by default');
      await s.save();
      await page.locator(`${s.section} h3`, { hasText: 'Confidence' }).scrollIntoViewIfNeeded();
      await t.screenshot(page, 'confidence_admin_settings');
      assert.equal(await page.evaluate(async () => (await globalThis.ElectroTag.backend.me()).study.annotation.confidence), 'every_mark');

      await page.click('[data-log="sign-out"]');
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 1);
      await drag(page, await eegPoint(page, 2.0), await eegPoint(page, 2.5));
      assert.equal(await firstConfidence(page), 'definite');
      const seen = [];
      for (let i = 0; i < 3; i++) { await page.keyboard.press('D'); seen.push(await firstConfidence(page)); }
      assert.deepEqual(seen, ['probable', 'possible', 'definite']);
      const offered = await menuConfidence(page, 'Possible');
      assert.deepEqual(offered.slice(-3), ['Definite', 'Probable', 'Possible']);
      assert.ok(!offered.includes('Not given'));
      assert.equal(await firstConfidence(page), 'possible');
      await t.screenshot(page, 'confidence_every_mark');
    },
  },
  {
    name: 'on an iPad: the table\'s buttons and a long press set confidence and add a note',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1180, height: 820, ipad: true, scale: 2 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await page.evaluate(() => globalThis.ElectroTag.ws.createAnnotation(4.0, 4.8));
      await page.locator('.ann-table tbody tr').first().tap();
      await page.tap('[data-log="confidence"]');
      assert.equal(await firstConfidence(page), 'definite');
      await page.tap('[data-log="confidence"]');
      assert.equal(await firstConfidence(page), 'probable');
      const h = await page.evaluate(() => document.querySelector('[data-log="confidence"]').getBoundingClientRect().height);
      assert.ok(h >= 40, `the button is ${h} px high, large enough for a finger`);
      await page.tap('[data-log="note"]');
      await page.waitForSelector('.note-dialog input[name="note"]');
      await page.fill('.note-dialog input[name="note"]', NOTE);
      await page.locator('.dialog-buttons button', { hasText: 'Keep note' }).tap();
      assert.equal((await annotations(page))[0].note, NOTE);
      await t.screenshot(page, 'confidence_ipad_table');
      if (t.browserName !== 'chromium') return; // a long press needs Chromium's DevTools protocol (k_ipad)
      const cdp = await page.context().newCDPSession(page);
      const p = await middleOfFirst(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 0 }] });
      await page.waitForTimeout(800);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForSelector('.menu');
      assert.match(await page.textContent('.menu'), /Set confidence…/);
      assert.match(await page.textContent('.menu'), /Edit note…/);
      await page.locator('.menu-item', { hasText: 'Set confidence…' }).tap();
      await page.waitForSelector('.menu.sub');
      await t.screenshot(page, 'confidence_ipad_menu');
      await page.locator('.menu.sub .menu-item', { hasText: 'Possible' }).tap();
      assert.equal(await firstConfidence(page), 'possible');
    },
  },
  {
    name: 'on the study server: the saved events.tsv row has the confidence and the note',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      if (!t.study) throw new SkipTest('the study server is not running');
      const call = async (op, token, body) => {
        const res = await fetch(`${t.study.base}api/v1/admin/${op}`, { method: 'POST', body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-ElectroTag': '1' } });
        if (!res.ok && !(op === 'user_add' && res.status === 409)) throw new Error(`${op}: ${res.status} ${await res.text()}`);
      };
      // An annotator of this test's own, so that the other tests' figures stay as they were.
      const login = await (await fetch(`${t.study.base}api/v1/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ElectroTag': '1' },
        body: JSON.stringify({ annotator_id: 'ADMIN', password: PASSWORD }) })).json();
      await call('user_add', login.token, { annotator_id: 'C01', display_name: 'Confident', password: PASSWORD });
      await call('assign', login.token, { annotator_ids: ['C01'], all: true });
      const page = await t.newPage({ url: t.study.base });
      await signIn(page, 'C01', PASSWORD);
      await waitForRoute(page, 'home');
      const file = 'sub-003_task-rest_eeg.edf';
      await page.locator('table.list tr', { hasText: file }).locator('button', { hasText: 'Open' }).click();
      await waitForRoute(page, 'open');
      await page.setInputFiles('input[data-log="file-input"]', path.join(t.study.dir, 'recordings', 'study', 'sub-003', 'eeg', file));
      await waitForRoute(page, 'annotate', 30000);
      await waitForTraces(page);
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
      await drag(page, await eegPoint(page, 6.0), await eegPoint(page, 6.4));
      await page.keyboard.press('d');
      await page.keyboard.press('d');
      await page.evaluate((n) => { const ws = globalThis.ElectroTag.ws; ws.store.setNote(ws.lastMadeId, n); }, NOTE);
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 30000 });
      const folder = path.join(t.study.dir, 'study', 'Annotated_Events', 'annotator-C01', 'sub-003', 'eeg');
      const lines = fs.readFileSync(path.join(folder, 'sub-003_task-rest_eeg_annotator-C01_events.tsv'), 'utf8').trim().split('\n');
      const head = lines[0].split('\t');
      assert.deepEqual(head.slice(-2), ['confidence', 'annotation_note']);
      const rows = lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i], v])))
        .filter((r) => r.event_source === 'electrotag_artifact').sort((a, b) => Number(a.onset) - Number(b.onset));
      assert.deepEqual(rows.map((r) => [r.confidence, r.annotation_note]), [['n/a', 'n/a'], ['probable', NOTE]]);
      const session = JSON.parse(fs.readFileSync(path.join(folder, 'sub-003_task-rest_eeg_annotator-C01_session.json'), 'utf8'));
      assert.equal(session.annotations.confidence.setting, 'optional');
      assert.equal(session.annotations.n_with_note, 1);
    },
  },
];
