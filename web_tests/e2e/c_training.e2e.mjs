// The training programme in the demonstration: guided steps (a wrong attempt, then the match),
// Show me, saving, and a practice recording with its review.
import { signIn, waitForRoute, waitForTraces, state, eegPoint, drag, annotations, clickDialogButton } from './helpers.mjs';

async function coachText(page) { return page.textContent('.coach'); }

async function waitForCoach(page, re) {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.coach')?.textContent || ''), re.source, { timeout: 10000 });
}

async function startNext(page) {
  await page.locator('main.training .btn.primary').click();
  await waitForRoute(page, 'open');
  await page.locator('.example-card button').click();
  await waitForRoute(page, 'annotate');
  await waitForTraces(page);
}

async function showMeToTheEnd(page) {
  for (let i = 0; i < 12; i++) {
    if (/Recording complete/.test(await coachText(page))) return;
    await page.locator('.coach button', { hasText: 'Show me' }).click();
    await waitForCoach(page, /This is how the experts marked it/);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
  }
}

async function saveAndFinish(page) {
  await page.click('.ws-actions button.primary');
  await page.waitForSelector('.dialog');
  await clickDialogButton(page, 'Save and Finish');
}

export const tests = [
  {
    name: 'guided training, practice and its review',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'T01');
      await waitForRoute(page, 'training');
      assert.match(await page.textContent('main.training'), /Learn with the experts/);
      assert.match(await page.textContent('main.training'), /Unlocks when you complete the stage before/);
      await t.screenshot(page, 'training_path');

      // Recording 1 (show): the experts' blink is outlined.
      await startNext(page);
      await waitForCoach(page, /Mark this Eye-blink-artifact/);
      assert.match(await coachText(page), /Recording 1 of 2 +· +Step 1 of 6/);
      // A wrong attempt: EMG on the whole montage.
      await page.keyboard.press('3');
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
      await waitForCoach(page, /Not quite yet/);
      const wrong = await coachText(page);
      assert.match(wrong, /Type: the experts marked this as an Eye-blink-artifact \(press 1\); yours is an EMG-artifact\./);
      assert.match(wrong, /Channels: the experts marked this on Fp1, Fp2 and VEOG only\./);
      await t.screenshot(page, 'guided_wrong');
      // Put it right: undo, type 1, Selected channels and the three channels, drag again.
      await page.keyboard.press('Control+z');
      await page.keyboard.press('1');
      await page.keyboard.press('c');
      for (const ch of ['Fp1', 'Fp2', 'VEOG']) {
        const p = await eegPoint(page, 0, ch);
        await page.mouse.click(p.x - 40, p.y);
      }
      await drag(page, await eegPoint(page, 3.0, 'Fp1'), await eegPoint(page, 3.4, 'Fp1'));
      await waitForCoach(page, /✓ Right type, timing and channels\. Press Continue \(Enter\) for the next one\./);
      await t.screenshot(page, 'guided_matched');
      await page.keyboard.press('Enter');
      await waitForCoach(page, /Step 2 of 6/);
      assert.match(await coachText(page), /★★☆ {2}2 of 3 stars so far \(18 possible\)/);
      // The rest with Show me.
      await page.keyboard.press('c'); // back to the whole montage
      await showMeToTheEnd(page);
      await waitForCoach(page, /Recording complete/);
      assert.match(await coachText(page), /You matched all 6 of the experts' annotations/);
      await saveAndFinish(page);
      await waitForRoute(page, 'training');
      assert.match(await page.textContent('main.training'), /Recording saved: 7 of 18 stars/);

      // Recording 2 (find), all with Show me.
      await startNext(page);
      await waitForCoach(page, /Find the Chewing-artifact on this screen/);
      await t.screenshot(page, 'guided_find');
      await showMeToTheEnd(page);
      await saveAndFinish(page);
      await waitForRoute(page, 'training');
      assert.match(await page.textContent('main.training'), /On your own/);
      assert.match(await page.locator('[data-stage="guided"]').textContent(), /Completed/);

      // Practice: mark two of the eight artifacts, one of them with the wrong type.
      await startNext(page);
      assert.equal(await page.locator('.coach').count(), 0);
      await page.keyboard.press('2');
      await drag(page, await eegPoint(page, 4.1), await eegPoint(page, 4.5));
      const s0 = await state(page);
      assert.equal(s0.annotations.length, 1);
      await page.evaluate(() => globalThis.ElectroClean.ws.viewer.setView({ startS: 6 }));
      await page.waitForTimeout(200);
      await page.keyboard.press('3');
      await drag(page, await eegPoint(page, 11.0), await eegPoint(page, 13.0));
      await saveAndFinish(page);
      await waitForRoute(page, 'review');
      const review = await page.textContent('.review');
      assert.match(review, /Not yet:/);
      assert.match(review, /What to look at \(\d+\)/);
      assert.match(review, /Missed: Horizontal-eye-movement-artifact, 20\.50–21\.50 s/);
      assert.match(review, /Type: you chose Horizontal-eye-movement-artifact; the experts chose Eye-blink-artifact, 4\.10–4\.50 s/);
      await t.screenshot(page, 'practice_review');
      await page.keyboard.press('n');
      await page.keyboard.press('n');
      const sel = (await state(page)).selection;
      assert.equal(sel.length, 1);
      assert.match(sel[0], /^(ref|you)-/);
      // Back to the path: practice is in progress, with the best score.
      await page.locator('.ws-actions button.primary').click();
      await waitForRoute(page, 'training');
      assert.match(await page.locator('[data-stage="practice"]').textContent(), /In progress/);
      assert.match(await page.locator('[data-stage="practice"]').textContent(), /Best: \d+% found/);
      assert.match(await page.textContent('main.training'), /Try a practice recording again/);
      await page.evaluate(() => globalThis.ElectroClean.flushLog());
      const events = await page.evaluate(() => globalThis.ElectroClean.backend.resultsDocument().interaction_logs[0].events.map((e) => e.type));
      for (const kind of ['guided_step_started', 'guided_check', 'guided_show_me', 'guided_step_completed', 'guided_recording_completed',
        'practice_scored', 'practice_review_opened', 'review_item_jumped', 'training_path_opened', 'stage_started']) {
        assert.ok(events.includes(kind), `no ${kind} event; got ${[...new Set(events)].join(', ')} (${events.length})`);
      }
    },
  },
];
