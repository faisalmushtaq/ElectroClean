// The training programme in the demonstration: guided steps (a wrong attempt, then the match),
// Show me, saving, and a practice recording with its review.
import { pressSave, signIn, waitForRoute, waitForTraces, state, eegPoint, drag, annotations, clickDialogButton } from './helpers.mjs';

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
  await pressSave(page);
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
      // what to do, with the actual controls, one line per action
      const body = await page.evaluate(() => document.querySelector('.coach-body').innerText);
      assert.match(body, /^1\. Press 1 \(or click 1 next to Draw as\) to choose Eye-blink-artifact\.$/m);
      assert.match(body, /^2\. Make sure Selected channels is chosen in the toolbar .* click the channel names Fp1, Fp2 and VEOG at the left of the EEG/m);
      assert.match(body, /^3\. Drag across the EEG from the start of the outline to its end/m);
      assert.equal(await page.locator('.coach .coach-more').isVisible(), true, 'the coach says there is more below');
      // A wrong attempt: EMG on the whole montage.
      await page.keyboard.press('3');
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.4));
      await waitForCoach(page, /Not quite yet/);
      const wrong = await coachText(page);
      assert.match(wrong, /Type: the experts marked this as an Eye-blink-artifact; yours is an EMG-artifact\. Click your annotation to select it, then press 1 to change its type\./);
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
      await waitForCoach(page, /Right type, timing and channels\. Press Continue \(Enter\) for the next one\./);
      await t.screenshot(page, 'guided_matched');
      await page.keyboard.press('Enter');
      await waitForCoach(page, /Step 2 of 6/);
      assert.match(await coachText(page), /2 of 3 stars so far \(18 possible\)/);
      // the stars are drawn: two filled and one empty
      assert.equal(await page.locator('.coach-stars .ico-star').count(), 2);
      assert.equal(await page.locator('.coach-stars .ico-star-empty').count(), 1);
      // Show me by its key, H
      await page.keyboard.press('h');
      await waitForCoach(page, /This is how the experts marked it/);
      await page.keyboard.press('Enter');
      await waitForCoach(page, /Step 3 of 6/);
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
      await page.evaluate(() => globalThis.ElectroTag.ws.viewer.setView({ startS: 6 }));
      await page.waitForTimeout(200);
      await page.keyboard.press('3');
      await drag(page, await eegPoint(page, 11.0), await eegPoint(page, 13.0));
      await saveAndFinish(page);
      await waitForRoute(page, 'review');
      const review = await page.textContent('.review');
      // one plain summary: the verdict, the score with what it is made of, then what to look at
      assert.match(review, /Not yet: you need a score of at least 80% and the right type for at least 80% of the artifacts you find\. Look at what you missed below, then try this recording again from your training path\./);
      assert.match(review, /Your score: \d+%\. You found 2 of the experts' 8 artifacts and made no marks they did not make\. 1 of the 2 you found has another type than theirs\./);
      assert.doesNotMatch(await page.locator('.review').innerText(), /sensitivity|precision/, 'the statistics wait behind the disclosure');
      assert.equal(await page.locator('.review-details').getAttribute('open'), null);
      await page.locator('.review-details summary').click();
      assert.match(await page.textContent('.review-details'), /The experts' artifacts you found with their type \(sensitivity\)\s*13%/);
      assert.match(review, /What to look at \(\d+\)/);
      assert.match(review, /Missed: Horizontal-eye-movement-artifact, 20\.50–21\.50 s/);
      // (within a pixel of 4.10 s: WebKit reports the pointer in whole pixels)
      assert.match(review, /Type: you chose Horizontal-eye-movement-artifact; the experts chose Eye-blink-artifact, 4\.1[01]–4\.50 s/);
      await t.screenshot(page, 'practice_review');
      await page.keyboard.press('n');
      await page.keyboard.press('n');
      const sel = (await state(page)).selection;
      assert.equal(sel.length, 1);
      assert.match(sel[0], /^(ref|you)-/);
      // Back to the path: practice is in progress, with the best score.
      await page.locator('.ws-actions button.primary').click();
      await waitForRoute(page, 'training');
      const practice = await page.locator('[data-stage="practice"]').textContent();
      assert.match(practice, /Not passed yet/);
      assert.match(practice, /1 of 1 practice recording tried/);
      assert.match(practice, /Best score: \d+%, with the right type for 50% of the artifacts found\. You found 2 of the experts' 8 artifacts/);
      assert.match(practice, /To pass, you need a score of at least 80%/);
      // the only practice recording comes again, and the words say so
      assert.match(await page.textContent('main.training'), /Try the practice recording again/);
      await t.screenshot(page, 'training_path_after_practice');
      await page.evaluate(() => globalThis.ElectroTag.flushLog());
      const events = await page.evaluate(() => globalThis.ElectroTag.backend.resultsDocument().interaction_logs[0].events.map((e) => e.type));
      for (const kind of ['guided_step_started', 'guided_check', 'guided_show_me', 'guided_step_completed', 'guided_recording_completed',
        'practice_scored', 'practice_review_opened', 'review_item_jumped', 'training_path_opened', 'stage_started']) {
        assert.ok(events.includes(kind), `no ${kind} event; got ${[...new Set(events)].join(', ')} (${events.length})`);
      }
    },
  },
  {
    name: 'every guided step can be done by following its words, with the controls they name',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'T01');
      await waitForRoute(page, 'training');
      await startNext(page);
      for (let n = 1; n <= 6; n++) {
        await waitForCoach(page, new RegExp(`Step ${n} of 6`));
        const lines = (await page.evaluate(() => document.querySelector('.coach-body').innerText)).split('\n');
        assert.match(lines[0], /^The experts' annotation is outlined with a dashed line\. To mark it:$/);
        // 1. the type: its number key
        const key = /^1\. Press (\d) \(or click \1 next to Draw as\) to choose ([A-Za-z-]+)\.$/.exec(lines[1]);
        assert.ok(key, `step ${n}: ${lines[1]}`);
        await page.keyboard.press(key[1]);
        assert.equal((await state(page)).currentLabel, key[2], `step ${n}: the key chooses the type it names`);
        // 2. the channels: Whole montage, or Selected channels and the names it lists
        const scope = await page.evaluate(() => globalThis.ElectroTag.ws.scope);
        const named = /^2\. Make sure Selected channels is chosen .* then click the channel names (.+) at the left of the EEG\./.exec(lines[2]);
        if (named) {
          if (scope !== 'channels') await page.keyboard.press('c');
          const want = named[1].split(/, | and /);
          const have = await page.evaluate(() => [...globalThis.ElectroTag.ws.selectedChannels]);
          // "Only these should be chosen: click a name again to take it off."
          for (const ch of [...have.filter((c) => !want.includes(c)), ...want.filter((c) => !have.includes(c))]) {
            const p = await page.evaluate((name) => { // the channel's name, at the left of the EEG
              const v = globalThis.ElectroTag.ws.viewer;
              const r = v.over.getBoundingClientRect();
              return { x: r.left + v.x0 - 30, y: r.top + v.rowCentre(v.channels.findIndex((c) => c.name === name)) };
            }, ch);
            await page.mouse.click(p.x, p.y);
          }
          assert.deepEqual((await page.evaluate(() => [...globalThis.ElectroTag.ws.selectedChannels])).sort(), [...want].sort(), `step ${n}: the channels it names`);
        } else {
          assert.match(lines[2], /^2\. Make sure Whole montage is chosen in the toolbar \(click it, or press C to switch\)\.$/);
          if (scope !== 'whole') await page.keyboard.press('c');
        }
        // 3. drag across the EEG from the start of the outline to its end
        assert.match(lines[3], /^3\. Drag across the EEG from the start of the outline to its end/);
        const g = await page.evaluate(() => { const v = globalThis.ElectroTag.ws.viewer; return { t0: v.ghost.onset_sample / v.sfreq, t1: (v.ghost.onset_sample + v.ghost.duration_samples) / v.sfreq }; });
        await drag(page, await eegPoint(page, g.t0 + 0.01), await eegPoint(page, g.t1 - 0.01));
        await waitForCoach(page, /Right type(, timing and channels| and timing)\./);
        if (n === 4) {
          // the eye movement: marked where it shows, on the EOG and the scalp beside and above the eyes, and the note says why
          assert.match(await coachText(page), /largest on the horizontal EOG and at F7 and F8/);
          await t.screenshot(page, 'guided_eye_movement');
        }
        await page.keyboard.press('Enter');
      }
      await waitForCoach(page, /Recording complete/);
      assert.match(await coachText(page), /18 of 18 stars/);
    },
  },
  {
    name: 'after training, the home page comes first, with the study recordings and a line back to the path',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'T01');
      await waitForRoute(page, 'training');
      // the programme done behind the scenes (both guided recordings with Show me, a perfect practice)
      await page.evaluate(async () => {
        const b = globalThis.ElectroTag.backend;
        const { TRAINING_SET } = await import('./js/api/demo.js');
        const { truthAnnotations, demoSpecs } = await import('./js/data/synthetic.js');
        for (const g of TRAINING_SET.guided) {
          const anns = [];
          for (let s = 1; ; s++) {
            anns.push((await b.guidedShowMe(g.rid, { step: s })).annotation);
            await b.guidedCheck(g.rid, { step: s, annotations: anns });
            if ((await b.guidedContinue(g.rid, { step: s })).complete) break;
          }
          await b.submit({ recording_id: g.rid, mode: 'guided', context_id: 'example', annotations: anns, session: {} });
        }
        const truth = truthAnnotations(demoSpecs().find((x) => x.id === 'demo-03'));
        await b.submit({ recording_id: TRAINING_SET.practice[0], mode: 'practice', context_id: 'example', annotations: truth, session: {} });
      });
      await page.evaluate(() => globalThis.ElectroTag.showTraining());
      await page.waitForSelector('[data-stage="practice"] .chip.done');
      assert.match(await page.textContent('main.training .next-text'), /You have completed every stage of this training programme\./);
      assert.equal(await page.textContent('main.training .btn.primary'), 'Go to my recordings');
      await t.screenshot(page, 'training_complete');
      // signing in again lands on home, where the training path is a line away
      await page.reload();
      await waitForRoute(page, 'home');
      assert.match(await page.textContent('.training-done'), /Training complete: .*See my training path/);
      assert.equal(await page.locator('.next-card h2').textContent(), 'Nothing to do yet');
      await page.click('[data-log="training-path"]');
      await waitForRoute(page, 'training');
    },
  },
  {
    name: 'on an iPad the coach speaks of taps and press and hold',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1180, height: 820, ipad: true });
      await signIn(page, 'T01');
      await waitForRoute(page, 'training');
      await startNext(page);
      await waitForCoach(page, /Mark this Eye-blink-artifact/);
      const body = await page.evaluate(() => document.querySelector('.coach-body').innerText);
      assert.match(body, /^1\. Tap 1 next to Draw as to choose Eye-blink-artifact\.$/m);
      assert.match(body, /^2\. Make sure Selected channels is chosen in the toolbar \(tap it\), then tap the channel names Fp1, Fp2 and VEOG/m);
      assert.match(body, /^3\. Drag one finger across the EEG from the start of the outline to its end\.$/m);
      assert.doesNotMatch(body, /Press|click|\bM\b/);
      await t.screenshot(page, 'guided_ipad');
    },
  },
];
