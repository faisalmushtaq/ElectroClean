// Annotating an example recording with the keyboard and the mouse, then Save and Finish.
import { signIn, waitForRoute, openExample, state, eegPoint, drag, annotations, clickDialogButton, pressSave } from './helpers.mjs';

export const tests = [
  {
    name: 'type keys, drag, M marks, N/P, edits, undo and Save and Finish',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);

      // 1. Key 1 (Eye-blink) then a drag across the first blink (3.0–3.4 s).
      await page.keyboard.press('1');
      let s = await state(page);
      assert.equal(s.currentLabel, 'Eye-blink-artifact');
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
      let anns = await annotations(page);
      assert.equal(anns.length, 1);
      assert.equal(anns[0].label, 'Eye-blink-artifact');
      assert.deepEqual(anns[0].channels, []);
      assert.ok(Math.abs(anns[0].onset_sample - 750) <= 3, `onset ${anns[0].onset_sample}`);
      assert.match(await page.textContent('.ws-message'), /^Added Eye-blink-artifact 3\.0\d\d–3\.\d+ s \(whole montage\)/);
      assert.equal(await page.locator('.ann-table tbody tr').count(), 1);

      // 2. Key 3 (EMG) and M at the start, M at the end (with the pointer over the EEG).
      await page.keyboard.press('3');
      const a = await eegPoint(page, 6.0, 'T7');
      await page.mouse.move(a.x, a.y);
      await page.keyboard.press('m');
      assert.match(await page.textContent('.ws-message'), /^Start of EMG-artifact marked at 6\.0\d\d s/);
      const b = await eegPoint(page, 7.0, 'T7');
      await page.mouse.move(b.x, b.y);
      await page.keyboard.press('m');
      anns = await annotations(page);
      assert.equal(anns.length, 2);
      assert.equal(anns[1].label, 'EMG-artifact');

      // 3. Selected channels: C, click two channel names, drag.
      await page.keyboard.press('c');
      s = await state(page);
      assert.equal(s.scope, 'channels');
      for (const ch of ['C3', 'Cz']) {
        const p = await eegPoint(page, 0, ch);
        await page.mouse.click(p.x - 40, p.y); // the channel name, left of the traces
      }
      assert.match(await page.textContent('.ws-chansummary'), /C3, Cz/);
      await page.keyboard.press('5');
      await drag(page, await eegPoint(page, 8.0, 'C3'), await eegPoint(page, 8.6, 'C3'));
      anns = await annotations(page);
      const pop = anns.find((x) => x.label === 'Electrode-pops-artifact');
      assert.deepEqual(pop.channels, ['C3', 'Cz']);

      // 4. Shift+click a channel inside it removes that channel.
      const inside = await eegPoint(page, 8.3, 'Cz');
      await page.keyboard.down('Shift');
      await page.mouse.click(inside.x, inside.y);
      await page.keyboard.up('Shift');
      anns = await annotations(page);
      assert.deepEqual(anns.find((x) => x.label === 'Electrode-pops-artifact').channels, ['C3']);

      // 5. N selects the first annotation; key 2 changes its type ("Change to").
      await page.keyboard.press('Escape');
      await page.keyboard.press('n');
      s = await state(page);
      assert.equal(s.selection.length, 1);
      assert.equal(await page.textContent('.ws-caption'), 'Change to');
      await page.keyboard.press('2');
      anns = await annotations(page);
      assert.equal(anns[0].label, 'Horizontal-eye-movement-artifact');
      // P at the first one says so.
      await page.keyboard.press('p');
      assert.match(await page.textContent('.ws-message'), /That was the first annotation/);

      // 6. Undo (Ctrl+Z) brings the blink back; redo and undo again.
      await page.keyboard.press('Control+z');
      anns = await annotations(page);
      assert.equal(anns[0].label, 'Eye-blink-artifact');
      await page.keyboard.press('Control+y');
      assert.equal((await annotations(page))[0].label, 'Horizontal-eye-movement-artifact');
      await page.keyboard.press('Control+z');

      // 7. Drag the right edge of the selected annotation to resize it.
      await page.keyboard.press('Escape');
      await page.keyboard.press('n');
      const sel = (await state(page)).selection[0];
      const first = (await annotations(page)).find((x) => x.annotation_id === sel);
      const edge = await eegPoint(page, (first.onset_sample + first.duration_samples) / 250);
      await drag(page, edge, { x: edge.x + 40, y: edge.y });
      const resized = (await annotations(page)).find((x) => x.annotation_id === sel);
      assert.ok(resized.duration_samples > first.duration_samples + 20, `resized ${first.duration_samples} → ${resized.duration_samples}`);

      // 8. The type picker (/) finds a type by its code.
      await page.keyboard.press('Escape');
      await page.keyboard.press('/');
      await page.waitForSelector('.picker-dialog input[type="search"]');
      await page.keyboard.type('120');
      await t.screenshot(page, 'picker');
      await page.keyboard.press('Enter');
      assert.equal((await state(page)).currentLabel, 'Rocking-patting-artifact');

      // 9. Right-click menu on an annotation.
      const emg = (await annotations(page)).find((x) => x.label === 'EMG-artifact');
      const mid = await eegPoint(page, (emg.onset_sample + emg.duration_samples / 2) / 250, 'F3');
      await page.mouse.click(mid.x, mid.y, { button: 'right' });
      await page.waitForSelector('.menu');
      await t.screenshot(page, 'context_menu');
      await page.locator('.menu .menu-item', { hasText: /^Movement-artifact/ }).first().click();
      assert.ok((await annotations(page)).some((x) => x.label === 'Movement-artifact'));

      // 10. Delete the selected annotation, then Save and Finish.
      await page.keyboard.press('Delete');
      const before = (await annotations(page)).length;
      await t.screenshot(page, 'annotate_marked');
      await pressSave(page);
      assert.match(await page.textContent('.dialog'), new RegExp(`Save ${before} annotation\\(s\\) and finish this recording\\?`));
      await t.screenshot(page, 'save_confirm');
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title');
      assert.equal(await page.textContent('.dialog .dialog-title'), 'Saved');
      assert.match(await page.textContent('.dialog'), /Demonstration: in a real study/);
      await clickDialogButton(page, 'Back to my recordings');
      await waitForRoute(page, 'home');
      await page.click('.rec-tabs [data-tab="all"]');
      assert.match(await page.textContent('table.list'), /Done/);
      // The saved results can be downloaded.
      await page.evaluate(() => globalThis.ElectroClean.flushLog());
      const doc = await page.evaluate(() => globalThis.ElectroClean.backend.resultsDocument());
      assert.equal(doc.annotation_documents.length, 1);
      assert.equal(doc.annotation_documents[0].n_annotations, before);
      assert.ok(doc.interaction_logs[0].events.some((e) => e.type === 'annotation_created' && e.via === 'eeg_drag'));
      assert.ok(doc.interaction_logs[0].events.some((e) => e.type === 'shortcut' && e.action === 'Mark start, then end'));
    },
  },
  {
    name: 'closing keeps a draft that can be restored',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 1);
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 2.0), await eegPoint(page, 2.5));
      await page.click('[data-log="close"]');
      await page.waitForSelector('.dialog');
      assert.match(await page.textContent('.dialog'), /Close without saving\?/);
      await clickDialogButton(page, 'Close and finish later');
      await waitForRoute(page, 'home');
      assert.match(await page.textContent('table.list'), /In progress/);
      await page.locator('ul.examples button').nth(1).click();
      await page.waitForSelector('.dialog');
      assert.match(await page.textContent('.dialog'), /Restore unfinished work\?/);
      assert.match(await page.textContent('.dialog'), /1 annotation\(s\)/);
      await clickDialogButton(page, 'Restore and continue');
      await waitForRoute(page, 'annotate');
      assert.equal((await annotations(page)).length, 1);
    },
  },
  {
    name: 'an artifact longer than the screen: M, scroll with the arrow keys, M',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 2);
      await page.keyboard.press('4');
      const p = await eegPoint(page, 8.0, 'Cz');
      await page.mouse.move(p.x, p.y);
      await page.keyboard.press('m');
      await page.keyboard.press('ArrowRight'); // a quarter of a screen later: the pointer now points at 10.5 s
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('m');
      const [a] = await annotations(page);
      assert.equal(a.label, 'Movement-artifact');
      assert.ok(Math.abs(a.onset_sample / 250 - 8.0) < 0.02, `start ${a.onset_sample / 250}`);
      assert.ok(Math.abs((a.onset_sample + a.duration_samples) / 250 - 13.0) < 0.02, `end ${(a.onset_sample + a.duration_samples) / 250}`);
    },
  },
];
