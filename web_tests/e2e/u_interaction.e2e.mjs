// How the annotation view behaves (the usability check of October 2026): a draft is never thrown
// away by Esc or a click beside the question, and work discarded can be brought back in the tab; the
// header's buttons act only when they can, never while paused, and leave the keyboard with the EEG;
// channels are added to or taken out of an annotation with Shift+click on any of its rows or a click
// on a name; the channel chooser switches to "Only these channels" by itself; Draw/edit off says so;
// N starts from the screen; keyboard-only marking at the time cursor; Edit times takes m:ss; the
// coverage check can be closed; Report a problem chooses no reason; Ctrl+F is the browser's.
import { signIn, waitForRoute, waitForTraces, openExample, state, eegPoint, drag, annotations, clickDialogButton } from './helpers.mjs';

const msg = (page) => page.evaluate(() => globalThis.ElectroTag.ws.msgEl.textContent);
const nameAt = (page, n) => page.evaluate((n) => {
  const v = globalThis.ElectroTag.ws.viewer;
  const r = v.over.getBoundingClientRect();
  return { x: r.left + 20, y: r.top + v.rowCentre(v.channels.findIndex((c) => c.name === n)) };
}, n);
async function shiftClick(page, t, ch) {
  const p = await eegPoint(page, t, ch);
  await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
}
const channelsOf = async (page, i) => (await annotations(page))[i].channels;
const disabled = (page, log) => page.locator(`[data-log="${log}"]`).isDisabled();

async function closeLater(page) {
  await page.click('[data-log="close"]');
  await page.waitForSelector('.dialog');
  await clickDialogButton(page, 'Close and finish later');
  await waitForRoute(page, 'home');
}

export const tests = [
  {
    name: 'a draft survives Esc and a click beside "Restore unfinished work?"; Start afresh asks again, and Bring it back undoes it',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      for (const s of [3, 5, 7]) await drag(page, await eegPoint(page, s), await eegPoint(page, s + 0.4));
      await closeLater(page);
      // Esc: the work is restored.
      await page.locator('ul.examples button').nth(0).click();
      await page.waitForSelector('.dialog.restore-question');
      assert.match(await page.textContent('.dialog'), /3 annotations and \d+ s of work on sub-demo01_task-rest_eeg\.edf/);
      assert.doesNotMatch(await page.textContent('.dialog'), /sub-demo01\/eeg\//, 'the file name, not the study\'s internal name');
      await page.keyboard.press('Escape');
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      assert.equal((await annotations(page)).length, 3, 'Esc restores');
      await closeLater(page);
      // A click on the grey beside the question: restored too.
      await page.locator('ul.examples button').nth(0).click();
      await page.waitForSelector('.dialog.restore-question');
      await page.waitForTimeout(600);
      await page.mouse.click(5, 5);
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      assert.equal((await annotations(page)).length, 3, 'a click beside the question restores');
      await closeLater(page);
      // Start afresh asks a second time; Keep them goes back to the question.
      await page.locator('ul.examples button').nth(0).click();
      await page.waitForSelector('.dialog.restore-question');
      await clickDialogButton(page, 'Start afresh');
      await page.waitForFunction(() => /Delete your unfinished work\?/.test(document.querySelector('.dialog')?.textContent || ''));
      assert.equal(await page.locator('.dialog-buttons button.primary').textContent(), 'Keep them', 'the safe answer is the default');
      await clickDialogButton(page, 'Keep them');
      await page.waitForSelector('.dialog.restore-question');
      await clickDialogButton(page, 'Start afresh');
      await page.waitForFunction(() => /Delete your unfinished work\?/.test(document.querySelector('.dialog')?.textContent || ''));
      await clickDialogButton(page, 'Delete them');
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      assert.equal((await annotations(page)).length, 0);
      // The work deleted is kept in this tab, and comes back as one step that Undo takes back.
      assert.match(await page.textContent('.discarded-work'), /3 annotations/);
      await t.screenshot(page, 'bring_back');
      await page.click('[data-log="bring-back"]');
      assert.equal((await annotations(page)).length, 3);
      assert.match(await msg(page), /^Brought back 3 annotations/);
      assert.equal(await page.locator('.discarded-work').count(), 0);
      await page.click('[data-log="undo"]');
      assert.equal((await annotations(page)).length, 0);
      await page.click('[data-log="redo"]');
      assert.equal((await annotations(page)).length, 3);
      await page.evaluate(() => globalThis.ElectroTag.flushLog());
      const ev = await page.evaluate(() => globalThis.ElectroTag.backend.resultsDocument().interaction_logs.flatMap((l) => l.events));
      assert.deepEqual(ev.filter((e) => e.type === 'draft_discarded').map((e) => e.n_annotations), [3]);
      assert.deepEqual(ev.filter((e) => e.type === 'discarded_work_restored').map((e) => [e.n_annotations, e.replaced]), [[3, 0]]);
      // Discard and close is kept in the tab as well: the next opening offers it.
      await page.click('[data-log="close"]');
      await page.waitForSelector('.dialog');
      await clickDialogButton(page, 'Discard and close');
      await clickDialogButton(page, 'Delete them');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      assert.equal(await page.locator('.dialog').count(), 0, 'no draft left to restore');
      assert.match(await page.textContent('.discarded-work'), /3 annotations/);
    },
  },
  {
    name: 'Delete, Undo and Redo act only when they can, nothing changes while paused, and a click leaves the keys with the EEG',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      assert.deepEqual([await disabled(page, 'delete'), await disabled(page, 'undo'), await disabled(page, 'redo')], [true, true, true]);
      assert.equal(await page.getAttribute('[data-log="undo"]', 'title'), 'Nothing to undo');
      for (const s of [2, 4, 6]) await drag(page, await eegPoint(page, s), await eegPoint(page, s + 0.4));
      assert.deepEqual([await disabled(page, 'delete'), await disabled(page, 'undo'), await disabled(page, 'redo')], [true, false, true]);
      assert.match(await page.getAttribute('[data-log="undo"]', 'title'), /^Undo add Eye-blink-artifact/);
      // A click on Undo leaves the keyboard with the EEG: Space and Enter afterwards do not press it again.
      await page.click('[data-log="undo"]');
      assert.equal((await annotations(page)).length, 2);
      assert.equal(await page.evaluate(() => document.activeElement === globalThis.ElectroTag.ws.viewer.over), true);
      await page.keyboard.press(' ');
      await page.keyboard.press('Enter');
      assert.equal((await annotations(page)).length, 2, 'Space and Enter did not undo again');
      assert.equal(await disabled(page, 'redo'), false);
      // Delete with a selection.
      await page.keyboard.press('n');
      assert.equal(await disabled(page, 'delete'), false);
      // Paused: Draw/edit, Delete, Undo and Redo wait for Resume, and the button shows a play sign.
      await page.keyboard.press('b');
      for (const b of ['draw-edit', 'delete', 'undo', 'redo']) assert.equal(await disabled(page, b), true, `${b} while paused`);
      assert.equal(await page.locator('.pause-btn .ico-play').count(), 1);
      await t.screenshot(page, 'paused_header');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.undo()), undefined);
      assert.equal((await annotations(page)).length, 2, 'nothing changes behind the pause panel');
      await page.keyboard.press('b');
      assert.equal(await disabled(page, 'undo'), false);
      assert.equal(await page.locator('.pause-btn .ico-pause').count(), 1);
    },
  },
  {
    name: 'channels of the selected annotation: Shift+click on any of its rows, a click on a name, never the last one, and never the channels for new marks',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      // A whole-montage annotation: Shift+click F3 takes it out, again puts it back.
      await drag(page, await eegPoint(page, 3.0, 'Cz'), await eegPoint(page, 3.6, 'Cz'));
      await shiftClick(page, 3.3, 'F3');
      let ch = await channelsOf(page, 0);
      assert.equal(ch.length, (await page.evaluate(() => globalThis.ElectroTag.ws.s.channels.length)) - 1);
      assert.ok(!ch.includes('F3'));
      assert.match(await msg(page), /every channel but F3/);
      await shiftClick(page, 3.3, 'F3');
      assert.deepEqual(await channelsOf(page, 0), [], 'whole montage again');
      // Two channel-specific marks (extra finding: the second could not be changed by clicking).
      await page.keyboard.press('Escape');
      await page.keyboard.press('c');
      const o1 = await nameAt(page, 'O1');
      await page.mouse.click(o1.x, o1.y);
      await drag(page, await eegPoint(page, 5.0, 'O1'), await eegPoint(page, 5.5, 'O1'));
      await drag(page, await eegPoint(page, 7.0, 'O1'), await eegPoint(page, 7.5, 'O1'));
      for (const [i, s] of [[1, 5.2], [2, 7.2]]) {
        const p = await eegPoint(page, s, 'O1');
        await page.mouse.click(p.x, p.y);
        assert.equal((await state(page)).selection[0], (await annotations(page))[i].annotation_id);
        // Shift+click on a row the annotation does not have yet adds that channel.
        await shiftClick(page, s, 'O2');
        assert.deepEqual(await channelsOf(page, i), ['O1', 'O2'], `annotation ${i}: O2 added by Shift+click`);
        // A click on a name adds or takes out a channel of the selected annotation.
        const p3 = await nameAt(page, 'P3');
        await page.mouse.click(p3.x, p3.y);
        assert.deepEqual(await channelsOf(page, i), ['P3', 'O1', 'O2'], `annotation ${i}: P3 added by a click on its name`);
        await page.mouse.click(p3.x, p3.y);
        assert.deepEqual(await channelsOf(page, i), ['O1', 'O2']);
        assert.deepEqual(await page.evaluate(() => globalThis.ElectroTag.ws.selectedChannels), ['O1'], 'the channels for new marks stay as they were');
        await page.keyboard.press('Escape');
      }
      // The last channel stays.
      const p = await eegPoint(page, 5.2, 'O1');
      await page.mouse.click(p.x, p.y);
      await shiftClick(page, 5.2, 'O1');
      await shiftClick(page, 5.2, 'O2');
      assert.deepEqual(await channelsOf(page, 1), ['O2']);
      assert.match(await msg(page), /An annotation needs at least one channel/);
      // Shift+click on empty EEG changes nothing.
      await page.keyboard.press('Escape');
      await shiftClick(page, 9.5, 'Cz');
      assert.deepEqual(await page.evaluate(() => globalThis.ElectroTag.ws.selectedChannels), ['O1']);
    },
  },
  {
    name: 'Edit channels… on a whole-montage annotation: choosing a channel in the list or on the map switches to Only these channels',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.6));
      for (const view of ['list', 'map']) {
        const mid = await eegPoint(page, 3.3, 'Cz');
        await page.mouse.click(mid.x, mid.y, { button: 'right' });
        await page.locator('.menu .menu-item', { hasText: 'Edit channels…' }).click();
        await page.waitForSelector('.channel-chooser');
        assert.equal(await page.isChecked('#scope-whole'), true);
        if (view === 'map') {
          await page.click('.channel-view-row [data-view="map"]');
          await page.click('.map-electrode[data-name="Fp1"]');
        } else {
          await page.click('.channel-chip input[data-name="Fp2"]');
        }
        assert.equal(await page.isChecked('#scope-some'), true, `${view}: a choice switches to Only these channels`);
        if (view === 'list') assert.deepEqual(await page.locator('.channel-chooser .row button').allTextContents(), ['Select all', 'Clear all']);
        else assert.deepEqual(await page.locator('.map-tools > button').allTextContents(), ['Select all', 'Clear all', 'Invert']);
        await clickDialogButton(page, 'OK');
        assert.deepEqual(await channelsOf(page, 0), [view === 'map' ? 'Fp1' : 'Fp2']);
        await page.click('[data-log="undo"]');
      }
    },
  },
  {
    name: 'Draw/edit off says so; a plain click on a trace says nothing about bad channels; N starts from the screen; Ctrl+F is the browser\'s',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 2);
      await drag(page, await eegPoint(page, 4.2), await eegPoint(page, 9.0));
      // Moving and resizing give the new times.
      const end = await eegPoint(page, 9.0);
      await drag(page, end, { x: end.x + 30, y: end.y });
      assert.match(await msg(page), /^Eye-blink-artifact now 4\.\d{3}–9\.\d{3} s \(/);
      await page.click('[data-log="draw-edit"]');
      assert.equal(await page.textContent('.ws-caption'), 'View only');
      await drag(page, await eegPoint(page, 1.0), await eegPoint(page, 2.0));
      assert.equal((await annotations(page)).length, 1);
      assert.match(await msg(page), /^View only: annotations cannot be drawn or changed\. Press Draw\/edit to mark artifacts\./);
      await t.screenshot(page, 'view_only');
      await page.click('[data-log="draw-edit"]');
      assert.equal(await page.textContent('.ws-caption'), 'Draw as');
      // A plain click near a trace in Whole montage places the time cursor and says nothing about channels.
      await page.evaluate(() => globalThis.ElectroTag.ws._clearMessage());
      const tr = await eegPoint(page, 1.5, 'Cz');
      await page.mouse.click(tr.x, tr.y);
      assert.doesNotMatch(await msg(page), /bad|Selected channels/);
      // N with nothing selected: the annotation reaching into the screen, even if it started before it.
      await page.evaluate(() => globalThis.ElectroTag.ws.viewer.setView({ startS: 5 }, 'test'));
      await page.keyboard.press('Escape');
      await page.keyboard.press('n');
      assert.equal((await state(page)).selection.length, 1, 'N selects the mark that runs on into the screen');
      // Ctrl+F is left to the browser's Find.
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+f');
      assert.equal(await page.locator('.picker-dialog').count(), 0);
    },
  },
  {
    name: 'without a mouse: G places the time cursor, , and . move it, and M marks there; the mark waiting for its end is shown',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await page.mouse.move(5, 5); // the pointer is away from the EEG
      assert.equal(await page.getAttribute('.ws-eeg canvas.layer.top', 'tabindex'), '0', 'the EEG is in the Tab order');
      await page.keyboard.press('g');
      await page.keyboard.type('3');
      await page.keyboard.press('Enter');
      await page.keyboard.press('m');
      assert.match(await msg(page), /^Start of Eye-blink-artifact marked at 3\.000 s/);
      assert.match(await page.textContent('.mark-pending'), /^Marking Eye-blink-artifact from 3\.000 s/);
      await t.screenshot(page, 'mark_pending');
      for (let i = 0; i < 5; i++) await page.keyboard.press('.');
      await page.keyboard.press('m');
      const [a] = await annotations(page);
      assert.equal(a.onset_sample, 750);
      assert.equal(a.onset_sample + a.duration_samples, 750 + 5 * 25, 'five steps of 1% of a 10 s screen');
      assert.equal(await page.isVisible('.mark-pending'), false);
      // The pointer resting on the EEG wins unless the cursor was moved since.
      const p = await eegPoint(page, 8.0);
      await page.mouse.move(p.x, p.y);
      await page.keyboard.press('[');
      assert.match(await msg(page), /marked at 8\.0\d\d s/);
      await page.keyboard.press('Escape');
    },
  },
  {
    name: 'Edit times… takes m:ss; the coverage check can be closed and agrees in number; Report a problem chooses no reason',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.6));
      await page.keyboard.press('n');
      await page.click('.btn-grid button:has-text("Edit times…")');
      await page.fill('#times-start', '0:04.5');
      await page.fill('#times-end', '0:05');
      assert.match(await page.textContent('.dialog'), /Duration 0\.500 s/);
      await page.fill('#times-end', 'soon');
      assert.equal(await page.locator('.dialog-buttons button.primary').isDisabled(), true);
      await page.fill('#times-end', '5');
      await clickDialogButton(page, 'OK');
      const [a] = await annotations(page);
      assert.deepEqual([a.onset_sample, a.duration_samples], [1125, 125]);
      assert.equal(await page.textContent('.ann-table thead th'), 'TypeTime (s)');
      // The coverage check: Keep annotating closes it.
      await page.click('.ws-actions button.primary');
      await page.waitForSelector('.dialog.coverage-check');
      const text = await page.textContent('.dialog.coverage-check');
      assert.match(text, /This part has not been on the screen yet[\s\S]*Look at it before you save/);
      assert.deepEqual(await page.locator('.dialog.coverage-check .dialog-buttons button').allTextContents(), ['Keep annotating', 'Save anyway', 'Go to that part']);
      await clickDialogButton(page, 'Keep annotating');
      assert.equal(await page.locator('.dialog').count(), 0);
      // Report a problem: no reason chosen, and none about a file that will not open.
      await page.click('[data-log="ws-more"]');
      await page.locator('.menu .menu-item', { hasText: 'Report a problem' }).click();
      await page.waitForSelector('.problem-dialog');
      assert.equal(await page.locator('.problem-dialog input[data-reason]:checked').count(), 0);
      assert.equal(await page.locator('.problem-dialog input[data-reason="file_wont_open"]').count(), 0);
      const send = page.locator('.problem-dialog .dialog-buttons button', { hasText: 'Send the report' });
      assert.equal(await send.isDisabled(), true);
      await page.check('.problem-dialog input[data-reason="bad_channels"]');
      assert.equal(await send.isDisabled(), false);
      await clickDialogButton(page, 'Cancel');
    },
  },
  {
    name: 'on an iPad the messages speak of taps and buttons, not keys',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1180, height: 820, ipad: true });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await page.evaluate(() => globalThis.ElectroTag.ws.createAnnotation(3.0, 3.6));
      assert.match(await msg(page), /^Added Eye-blink-artifact/);
      await page.evaluate(() => { const ws = globalThis.ElectroTag.ws; ws.select([ws.store.annotations()[0].annotation_id]); ws.askConfidence(); });
      assert.equal(await msg(page), 'Confidence for Eye-blink-artifact: tap a number from 1 to 5 on the bar, or Later.');
      await page.tap('.conf-prompt .seg:has-text("3")');
      assert.match(await msg(page), /\(Undo at the top takes it back\)$/);
      assert.doesNotMatch(await msg(page), /Ctrl|⌘/);
      const p = await eegPoint(page, 3.3);
      await page.evaluate(([x, y]) => { const ws = globalThis.ElectroTag.ws; ws.showContextMenu(ws.store.annotations()[0].annotation_id, x, y); }, [p.x, p.y]);
      await page.waitForSelector('.menu');
      assert.equal(await page.locator('.menu .menu-shortcut').count(), 0, 'no key letters in the menu on a touch screen');
    },
  },
];
