// Confidence ratings on a 5-point scale, and notes. In an optional study (the default) a new mark has no
// rating: D then a digit rates the selected or newest annotation (the digit does not choose a type while
// the prompt is open), and the context menu and the control under the Annotations table rate or clear
// it with one choice. In an every-mark study (chosen in the admin area's Study settings) the prompt
// opens after each new mark, carrying on leaves the mark unrated, and Save and Finish lists the
// unrated marks with Rate them and Save anyway. A note is added from the menu, the table and Edit
// times…, saved with the annotation, and logged only by its length. On an iPad the table's numbers,
// the prompt's bar and a long press do the same. The last test saves on the real study server and
// reads the saved row of events.tsv.
import fs from 'node:fs';
import path from 'node:path';
import { SkipTest, annotations, clickDialogButton, drag, eegPoint, openExample, pressSave, signIn, state, waitForRoute, waitForTraces } from './helpers.mjs';

const NOTE = 'Could be an eye movement rather than a blink';
const PASSWORD = 'electrotag';
const UNDO = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';

/** Every event logged in this visit so far (the demonstration's own copy). */
async function events(page) {
  return page.evaluate(async () => {
    await globalThis.ElectroTag.flushLog();
    return globalThis.ElectroTag.backend.resultsDocument().interaction_logs.flatMap((l) => l.events);
  });
}

/** Change the demonstration's study settings (annotation block) and read GET /me again. */
async function studySettings(page, annotation) {
  await page.evaluate(async (a) => {
    const app = globalThis.ElectroTag;
    Object.assign(app.backend._admin.s.settings.annotation, a);
    app.backend._save();
    await app.refreshMe();
  }, annotation);
}

const ratings = async (page) => (await annotations(page)).map((a) => a.confidence ?? null);
const firstRating = async (page) => (await ratings(page))[0];
const labelCell = (page) => page.locator('.ann-table tbody tr').first().locator('td.label');
const statusText = (page) => page.evaluate(() => globalThis.ElectroTag.ws.msgEl.textContent);
const promptShown = (page) => page.isVisible('.conf-prompt');

/** The prompt's bar sits beside the annotations it asks about (outlined), off their stretch and below the band of their tags. */
async function barBesideMark(page, assert) {
  const r = await page.evaluate(() => {
    const ws = globalThis.ElectroTag.ws;
    const v = ws.viewer;
    const over = v.over.getBoundingClientRect();
    const bar = document.querySelector('.conf-prompt').getBoundingClientRect();
    const a = ws.store.get(ws._prompt.ids[0]);
    return { bar: [bar.left, bar.right, bar.top], mark: [over.left + v.sampleToX(a.onset_sample), over.left + v.sampleToX(a.onset_sample + a.duration_samples)],
      top: over.top + v.y0, outlined: (v.markers || []).some((m) => m.outline && m.onset_sample === a.onset_sample) };
  });
  assert.ok(r.bar[0] >= r.mark[1] || r.bar[1] <= r.mark[0], `the bar ${r.bar} is beside the mark ${r.mark}`);
  assert.ok(r.bar[2] >= r.top, `the bar (top ${r.bar[2]}) is below the band of tags (${r.top})`);
  assert.ok(r.outlined, 'the mark asked about is outlined');
}

/** The middle of the first annotation, in client coordinates. */
async function middleOfFirst(page) {
  const a = (await annotations(page))[0];
  return eegPoint(page, (a.onset_sample + a.duration_samples / 2) / 250);
}

/** Right-click the first annotation and choose `item` under Confidence; returns the submenu's items. */
async function menuConfidence(page, item) {
  const p = await middleOfFirst(page);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await page.waitForSelector('.menu');
  await page.locator('.menu-item', { hasText: /^Confidence/ }).click();
  await page.waitForSelector('.menu.sub');
  const items = (await page.locator('.menu.sub .menu-item').allTextContents()).map((s) => s.replace(/\s+/g, ' ').trim());
  await page.locator('.menu.sub .menu-item', { hasText: item }).click();
  await page.waitForSelector('.menu', { state: 'detached' });
  return items;
}

/** The mean colour of a strip of the first annotation's fill (after the next frames are drawn). */
function fillOf(page) {
  return page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const v = globalThis.ElectroTag.ws.viewer;
    const a = globalThis.ElectroTag.ws.store.annotations()[0];
    const dpr = window.devicePixelRatio || 1;
    const x = Math.round(v.tToX((a.onset_sample + a.duration_samples / 2) / 250) * dpr);
    const d = v.under.getContext('2d').getImageData(x - 2, Math.round(v.y0 * dpr), 5, Math.round((v.y1 - v.y0) * dpr)).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return sum / (d.length / 4);
  });
}

export const tests = [
  {
    name: 'an optional study: no rating until given; D and a digit, the menu and the table rate and clear it; a note is kept and saved; the log has only its length',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.s.confidenceMode), 'optional');
      const type = (await state(page)).currentLabel;
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.6));
      assert.equal((await annotations(page)).length, 1);
      // A new mark has no rating and looks as marks always have; no prompt in an optional study.
      assert.equal(await firstRating(page), null);
      assert.equal(await labelCell(page).locator('.conf-mark, .note-mark').count(), 0);
      assert.equal(await promptShown(page), false);
      const plainFill = await fillOf(page);

      // D, then a digit: the newest annotation is rated, and the digit does not choose a type.
      await page.keyboard.press('d');
      assert.equal(await statusText(page), 'Confidence for Eye-blink-artifact: press 1–5, 0 to clear, Esc to cancel.');
      assert.equal(await promptShown(page), true);
      await barBesideMark(page, assert);
      await page.keyboard.press('3');
      assert.equal(await firstRating(page), 3);
      assert.equal((await state(page)).currentLabel, type, 'the digit rated the mark and did not change the type');
      assert.equal(await promptShown(page), false);
      assert.equal((await labelCell(page).locator('.conf-mark').textContent()).trim(), '3/5');
      assert.equal(await labelCell(page).locator('.conf-mark').getAttribute('title'), 'Confidence 3 of 5: Moderately confident');
      assert.ok(Math.abs((await fillOf(page)) - plainFill) < 1, 'a mark rated 3 is drawn as before');
      await page.keyboard.press('d');
      await page.keyboard.press('2');
      assert.equal(await firstRating(page), 2);
      const lighter = await fillOf(page);
      assert.ok(lighter > plainFill + 5, `a mark rated 2 is filled more lightly (${lighter} vs ${plainFill})`);
      await t.screenshot(page, 'likert_rated_2');
      await page.keyboard.press('d');
      await page.keyboard.press('0');
      assert.equal(await firstRating(page), null, '0 clears the rating');
      await page.keyboard.press('d');
      await page.keyboard.press('Escape');
      assert.equal(await firstRating(page), null);
      assert.equal(await promptShown(page), false, 'Esc cancels');
      // The prompt never ends by itself: after a while a digit still rates (the bar says so) ...
      await page.keyboard.press('d');
      await page.waitForTimeout(3500);
      assert.equal(await promptShown(page), true, 'the prompt waits');
      // ... and another key ends it and does what it does: a digit afterwards chooses a type again.
      await page.keyboard.press('ArrowRight');
      assert.equal(await promptShown(page), false);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('4');
      assert.equal(await firstRating(page), null);
      assert.notEqual((await state(page)).currentLabel, type, 'after the prompt, 4 chose a type');
      await page.keyboard.press('1');
      await page.keyboard.press(UNDO); // nothing to undo from the type keys; the rating history is intact
      assert.equal(await firstRating(page), 2, 'undo takes back the clearing');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+y' : 'Control+y');

      // The context menu: 1 to 5 with their anchors, and Clear.
      const offered = await menuConfidence(page, 'Completely confident');
      assert.deepEqual(offered, ['1 Not at all confident', '2 Slightly confident', '3 Moderately confident', '4 Very confident',
        '5 Completely confident', 'Clear']);
      assert.equal(await firstRating(page), 5);
      await menuConfidence(page, 'Clear');
      assert.equal(await firstRating(page), null);

      // The control under the table: one press rates the selected annotation, and shows the rating.
      await page.locator('.ann-table tbody tr').first().click();
      assert.equal(await page.getAttribute('[data-log="confidence-4"]', 'aria-pressed'), 'false');
      await page.click('[data-log="confidence-4"]');
      assert.equal(await firstRating(page), 4);
      assert.equal(await page.getAttribute('[data-log="confidence-4"]', 'aria-pressed'), 'true');
      await page.click('[data-log="confidence-clear"]');
      assert.equal(await firstRating(page), null);
      await page.click('[data-log="confidence-4"]');

      // A note, from the context menu: kept, shown as a small icon with the text as its title.
      const p = await middleOfFirst(page);
      await page.mouse.click(p.x, p.y, { button: 'right' });
      await page.locator('.menu-item', { hasText: 'Add a note…' }).click();
      await page.waitForSelector('.note-dialog input[name="note"]');
      await page.fill('.note-dialog input[name="note"]', 'x'.repeat(200));
      assert.match(await page.textContent('.note-dialog .note-count'), /200 of 200 characters/);
      await page.fill('.note-dialog input[name="note"]', NOTE);
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
      await page.keyboard.press(UNDO);
      assert.equal((await annotations(page))[0].note, NOTE);
      await t.screenshot(page, 'likert_table');

      // The interaction log: the ratings, the prompts and the note's length, never its text.
      const ev = await events(page);
      const conf = ev.filter((e) => e.type === 'confidence_set');
      assert.deepEqual(conf.slice(0, 3).map((e) => [e.annotations[0].confidence, e.annotations[0].before]), [[3, null], [2, 3], [null, 2]]);
      assert.equal(conf[0].via, 'shortcut:Confidence 3');
      const prompts = ev.filter((e) => e.type === 'confidence_prompt').map((e) => [e.trigger, e.outcome]);
      assert.deepEqual(prompts.slice(0, 5), [['key', 'rated'], ['key', 'rated'], ['key', 'cleared'], ['key', 'cancelled'], ['key', 'other_input']]);
      const notes = ev.filter((e) => e.type === 'note_set');
      assert.deepEqual(notes.map((e) => [e.annotations[0].change, e.annotations[0].note_length]), [['added', NOTE.length], ['changed', NOTE.length + 1]]);
      assert.ok(!JSON.stringify(ev).includes('eye movement rather'), 'the note text is never logged');

      // Saved with the annotation (the draft first, then Save and Finish).
      await page.evaluate(() => globalThis.ElectroTag.ws.s.saveLocal());
      const draft = await page.evaluate(() => JSON.parse(localStorage.getItem(globalThis.ElectroTag.ws.s.localKey)));
      assert.deepEqual([draft.annotations[0].confidence, draft.annotations[0].note], [4, NOTE]);
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 20000 });
      const saved = await page.evaluate(() => globalThis.ElectroTag.backend.resultsDocument().annotation_documents.at(-1));
      assert.equal(saved.session.confidence, 'optional');
      assert.deepEqual([saved.annotations[0].confidence, saved.annotations[0].note], [4, NOTE]);
    },
  },
  {
    name: 'every mark: chosen in the admin area\'s Study settings; the prompt follows each new mark, never blocks, and Save and Finish lists the unrated marks',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => /^admin/.test(globalThis.ElectroTag.route || ''));
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-settings'));
      const section = '.admin-section[data-section="settings"]';
      await page.waitForSelector(`${section} input[name="confidence"]`);
      const text = (await page.textContent(section)).replace(/\s+/g, ' ');
      assert.match(text, /rate their confidence in a mark from 1 \(not at all confident\) to 5 \(completely confident\)/);
      assert.match(text, /Optional\s*Annotators rate a mark only when they wish/);
      assert.match(text, /Every mark\s*After each new mark annotators are asked for a rating/);
      assert.equal(await page.isChecked(`${section} input[name="confidence"][value="optional"]`), true, 'optional by default');
      await page.check(`${section} input[name="confidence"][value="every_mark"]`);
      await page.click('[data-log="settings-save"]');
      await page.waitForFunction((s) => /The settings are saved/.test(document.querySelector(`${s} .sticky-save .admin-msg`)?.textContent || ''), section);
      await page.locator(`${section} h3`, { hasText: 'Confidence' }).scrollIntoViewIfNeeded();
      await t.screenshot(page, 'likert_admin_settings');
      assert.equal(await page.evaluate(async () => (await globalThis.ElectroTag.backend.me()).study.annotation.confidence), 'every_mark');

      await page.click('[data-log="sign-out"]');
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 1);
      // A new mark has no rating either; the bar asks for one beside it and waits. The number keys keep
      // choosing the type (a habit of drawing, then pressing the next type, never gives a rating);
      // D and a number, or a click on the bar, rate it.
      await drag(page, await eegPoint(page, 2.0), await eegPoint(page, 2.5));
      assert.equal(await firstRating(page), null, 'no default rating');
      assert.equal(await promptShown(page), true);
      assert.match(await statusText(page), /^Confidence for .+: press D and then 1–5, or click a number on the bar\. Later or Esc leaves it unrated\.$/);
      await barBesideMark(page, assert);
      await t.screenshot(page, 'likert_prompt');
      const before = (await state(page)).currentLabel;
      await page.keyboard.press('3');
      assert.deepEqual(await ratings(page), [null], '3 chose the type, and did not rate');
      assert.equal((await state(page)).currentLabel, (await page.evaluate(() => globalThis.ElectroTag.ws.quick[2])));
      assert.notEqual((await state(page)).currentLabel, before);
      await page.waitForTimeout(3500);
      assert.equal(await promptShown(page), true, 'the bar waits for an answer');
      await page.keyboard.press('d');
      await page.keyboard.press('5');
      assert.deepEqual(await ratings(page), [5]);
      assert.equal(await promptShown(page), false);
      // Carrying on leaves a mark unrated: Later (or Esc), or the next mark.
      await drag(page, await eegPoint(page, 4.0), await eegPoint(page, 4.5));
      assert.equal(await promptShown(page), true);
      await page.keyboard.press('ArrowRight');
      assert.equal(await promptShown(page), true, 'moving through the recording keeps the bar');
      await page.keyboard.press('ArrowLeft');
      await page.click('[data-log="confidence-prompt-later"]');
      assert.equal(await promptShown(page), false);
      await drag(page, await eegPoint(page, 6.0), await eegPoint(page, 6.5));
      await page.keyboard.press('Escape');
      assert.equal(await promptShown(page), false, 'Esc puts the bar away');
      assert.deepEqual(await ratings(page), [5, null, null]);

      // Save and Finish lists them; Rate them steps through them, one key each.
      await pressSave(page);
      await page.waitForSelector('.dialog.confidence-check');
      assert.match(await page.textContent('.dialog.confidence-check'), /2 annotations have no confidence/);
      await t.screenshot(page, 'likert_save_check');
      await clickDialogButton(page, 'Rate them');
      await page.waitForSelector('.conf-prompt:not([hidden])');
      let sel = (await state(page)).selection[0];
      assert.equal(sel, (await annotations(page))[1].annotation_id, 'the first unrated mark is selected');
      await page.keyboard.press('2');
      sel = (await state(page)).selection[0];
      assert.equal(sel, (await annotations(page))[2].annotation_id, 'then the next');
      await page.waitForSelector('.conf-prompt:not([hidden])');
      await page.keyboard.press('4');
      assert.deepEqual(await ratings(page), [5, 2, 4]);
      assert.match(await statusText(page), /Every annotation has a confidence now/);
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 20000 });
      const saved = await page.evaluate(() => globalThis.ElectroTag.backend.resultsDocument().annotation_documents.at(-1));
      assert.equal(saved.session.confidence, 'every_mark');
      assert.deepEqual(saved.annotations.map((a) => a.confidence), [5, 2, 4]);
      const ev = await events(page);
      const prompts = ev.filter((e) => e.type === 'confidence_prompt').map((e) => [e.trigger, e.outcome]);
      assert.deepEqual(prompts, [['new_mark', 'replaced'], ['key', 'rated'], ['new_mark', 'later'], ['new_mark', 'later'],
        ['rate_them', 'rated'], ['rate_them', 'rated']]);
      assert.deepEqual(ev.filter((e) => e.type === 'confidence_check').map((e) => [e.n_unrated, e.choice]), [[2, 'rate']]);
    },
  },
  {
    name: 'on an iPad: the numbers under the table, the prompt\'s bar after a new mark, and a long press rate a mark',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1180, height: 820, ipad: true, scale: 2 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await studySettings(page, { confidence: 'every_mark' });
      await openExample(page, 0);
      await page.evaluate(() => globalThis.ElectroTag.ws.createAnnotation(4.0, 4.8));
      await page.waitForSelector('.conf-prompt:not([hidden])');
      const bar = await page.evaluate(() => [...document.querySelectorAll('.conf-prompt .seg')].map((b) => b.getBoundingClientRect().height));
      assert.ok(bar.every((hgt) => hgt >= 40), `the bar's numbers are ${bar} px high`);
      await t.screenshot(page, 'likert_ipad_prompt');
      await page.locator('.conf-prompt .seg', { hasText: '4' }).tap();
      assert.equal(await firstRating(page), 4);
      assert.equal(await promptShown(page), false);
      await page.locator('.ann-table tbody tr').first().tap();
      const segs = await page.evaluate(() => [...document.querySelectorAll('.conf-row .seg')].map((b) => { const r = b.getBoundingClientRect(); return [r.width, r.height]; }));
      assert.ok(segs.length === 5 && segs.every(([w, hgt]) => w >= 40 && hgt >= 40), `the table's numbers are ${JSON.stringify(segs)}`);
      await page.tap('[data-log="confidence-2"]');
      assert.equal(await firstRating(page), 2);
      await page.tap('[data-log="confidence-clear"]');
      assert.equal(await firstRating(page), null);
      await page.tap('[data-log="note"]');
      await page.waitForSelector('.note-dialog input[name="note"]');
      await page.fill('.note-dialog input[name="note"]', NOTE);
      await page.locator('.dialog-buttons button', { hasText: 'Keep note' }).tap();
      assert.equal((await annotations(page))[0].note, NOTE);
      await t.screenshot(page, 'likert_ipad_table');
      if (t.browserName !== 'chromium') return; // a long press needs Chromium's DevTools protocol (k_ipad)
      const cdp = await page.context().newCDPSession(page);
      const p = await middleOfFirst(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 0 }] });
      await page.waitForTimeout(800);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForSelector('.menu');
      assert.match(await page.textContent('.menu'), /Confidence/);
      assert.match(await page.textContent('.menu'), /Edit note…/);
      await page.locator('.menu-item', { hasText: /^Confidence/ }).tap();
      await page.waitForSelector('.menu.sub');
      await t.screenshot(page, 'likert_ipad_menu');
      await page.locator('.menu.sub .menu-item', { hasText: 'Slightly confident' }).tap();
      assert.equal(await firstRating(page), 2);
    },
  },
  {
    name: 'on the study server: the saved events.tsv row has the rating and the note',
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
      await page.keyboard.press('2');
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
      assert.deepEqual(rows.map((r) => [r.confidence, r.annotation_note]), [['n/a', 'n/a'], ['2', NOTE]]);
      const session = JSON.parse(fs.readFileSync(path.join(folder, 'sub-003_task-rest_eeg_annotator-C01_session.json'), 'utf8'));
      assert.equal(session.annotations.confidence.setting, 'optional');
      assert.deepEqual(session.annotations.confidence.by_level, { 1: 0, 2: 1, 3: 0, 4: 0, 5: 0 });
      assert.equal(session.annotations.n_with_note, 1);
    },
  },
];
