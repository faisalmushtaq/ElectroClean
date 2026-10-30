// The training programme: its five stages in the demonstration (skipping the tour and the snippets
// with a question each, the tour done step by step, the snippets' gallery), guided steps (a wrong
// attempt, then the match), Show me, saving, a practice recording with its review, and on the real
// study server the competency gate: a study recording stays locked until the assessment is met.
import fs from 'node:fs';
import path from 'node:path';
import { pressSave, signIn, waitForRoute, waitForTraces, state, eegPoint, drag, annotations, clickDialogButton, skipFirstStages } from './helpers.mjs';

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
      const path0 = await page.textContent('main.training');
      for (const title of ['Find your way around', 'Meet the artifacts', 'Learn with the experts', 'On your own', 'Competency assessment']) {
        assert.match(path0, new RegExp(title));
      }
      assert.match(path0, /Unlocks when you finish or skip the stage before/);
      assert.equal(await page.textContent('main.training .btn.primary'), 'Start the tour');
      await t.screenshot(page, 'training_path');
      // T01 skips the tour and the snippets: each asks first, and says so on its card
      await page.click('main.training [data-log="skip-tour"]');
      await page.waitForSelector('.dialog');
      assert.match(await page.textContent('.dialog'), /You can do it after all at any time/);
      await t.screenshot(page, 'training_skip_question');
      await clickDialogButton(page, 'Keep it');
      assert.equal(await page.locator('main.training [data-stage="tour"]').getAttribute('data-status'), 'available');
      await skipFirstStages(page);
      const tour = await page.locator('[data-stage="tour"]').textContent();
      assert.match(tour, /Skipped/);
      assert.match(tour, /You skipped this stage\. You can still do it: choose Do it after all\./);
      assert.equal(await page.locator('[data-stage="tour"] [data-log="resume-tour"]').count(), 1);
      assert.match(await page.textContent('main.training .success'), /You skipped Meet the artifacts\./);
      await t.screenshot(page, 'training_path_skipped');

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
        'practice_scored', 'practice_review_opened', 'review_item_jumped', 'training_path_opened', 'stage_started', 'stage_skipped',
        'stage_skip_cancelled']) {
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
      await skipFirstStages(page);
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
        const { truthAnnotations, demoSpecs } = await import('./js/eeg/synthetic.js');
        for (const stage of ['tour', 'snippets']) await b.trainingStage({ stage, action: 'skip' });
        for (const g of TRAINING_SET.guided) {
          const anns = [];
          for (let s = 1; ; s++) {
            anns.push((await b.guidedShowMe(g.rid, { step: s })).annotation);
            await b.guidedCheck(g.rid, { step: s, annotations: anns });
            if ((await b.guidedContinue(g.rid, { step: s })).complete) break;
          }
          await b.submit({ recording_id: g.rid, mode: 'guided', context_id: 'example', annotations: anns, session: {}, sha256: 'f'.repeat(64) });
        }
        const truth = truthAnnotations(demoSpecs().find((x) => x.id === 'demo-03'));
        await b.submit({ recording_id: TRAINING_SET.practice[0], mode: 'practice', context_id: 'example', annotations: truth, session: {}, sha256: 'f'.repeat(64) });
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
      await page.evaluate(async () => { // the first two stages skipped behind the scenes; the skip itself is tested above
        for (const stage of ['tour', 'snippets']) await globalThis.ElectroTag.backend.trainingStage({ stage, action: 'skip' });
        await globalThis.ElectroTag.showTraining();
      });
      await page.waitForSelector('main.training [data-stage="snippets"][data-status="skipped"]');
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
  {
    name: 'the platform tour: each step is done for real, with the keys and controls it names',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'T01');
      await waitForRoute(page, 'training');
      await page.click('main.training [data-log="training-continue"]');
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      await page.waitForSelector('.coach.tour');
      const tourText = () => page.textContent('.coach.tour');
      const waitDone = async () => page.waitForFunction(() => !document.querySelector('.coach.tour [data-log="tour-next"]').disabled, null, { timeout: 10000 });
      assert.match(await tourText(), /Tour +· +Step 1 of 6/);
      assert.match(await page.textContent('.ws-banner'), /nothing you mark is kept/);
      await t.screenshot(page, 'tour_start');
      // 1. moving: on and back
      assert.equal(await page.locator('.coach.tour [data-log="tour-next"]').isDisabled(), true, 'a step is done before it goes on');
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(300);
      await page.keyboard.press('ArrowLeft');
      await waitDone();
      await page.keyboard.press('Enter');
      // 2. the type with its key, then a drag across the outlined blink
      await page.waitForFunction(() => /Step 2 of 6/.test(document.querySelector('.coach.tour').textContent));
      const body2 = await page.evaluate(() => document.querySelector('.coach.tour .coach-body').innerText);
      const key = /^1\. Press (\d) \(or click \1 next to Draw as\) to choose Eye-blink-artifact\.$/m.exec(body2);
      assert.ok(key, body2);
      await page.keyboard.press(key[1]);
      await drag(page, await eegPoint(page, 6.5), await eegPoint(page, 6.9));
      await waitDone();
      assert.match(await tourText(), /Done\. Press Next step \(Enter\) to go on\./);
      await t.screenshot(page, 'tour_marked');
      await page.keyboard.press('Enter');
      // 3. the channels: Selected channels, the names at the left, then the drag
      await page.waitForFunction(() => /Step 3 of 6/.test(document.querySelector('.coach.tour').textContent));
      const body3 = await page.evaluate(() => document.querySelector('.coach.tour .coach-body').innerText);
      assert.match(body3, /click the channel names T7 and T8 at the left of the EEG/);
      const emgKey = /^1\. Press (\d) \(or click \1 next to Draw as\) to choose EMG-artifact\.$/m.exec(body3);
      await page.keyboard.press(emgKey[1]);
      await page.keyboard.press('c');
      for (const ch of ['T7', 'T8']) {
        const p = await eegPoint(page, 0, ch);
        await page.mouse.click(p.x - 40, p.y);
      }
      await drag(page, await eegPoint(page, 8.05, 'T7'), await eegPoint(page, 9.45, 'T7'));
      await waitDone();
      await page.keyboard.press('Enter');
      // 4. undo, then redo: the muscle mark goes and comes back
      await page.waitForFunction(() => /Step 4 of 6/.test(document.querySelector('.coach.tour').textContent));
      const before = (await annotations(page)).length;
      await page.keyboard.press('Control+z');
      await page.waitForFunction(() => /bring it back with Redo/.test(document.querySelector('.coach.tour').textContent));
      assert.equal((await annotations(page)).length, before - 1);
      await page.keyboard.press('Control+y');
      await waitDone();
      assert.equal((await annotations(page)).length, before);
      await page.keyboard.press('Enter');
      // 5. confidence: select the blink, D, a number
      await page.waitForFunction(() => /Step 5 of 6/.test(document.querySelector('.coach.tour').textContent));
      await page.keyboard.press('c'); // back to the whole montage
      const mid = await eegPoint(page, 6.7);
      await page.mouse.click(mid.x, mid.y);
      await page.keyboard.press('d');
      await page.keyboard.press('4');
      await waitDone();
      assert.equal((await annotations(page)).find((a) => a.label === 'Eye-blink-artifact').confidence, 4);
      await page.keyboard.press('Enter');
      // 6. Save and Finish: here it ends the tour, and the study is told
      await page.waitForFunction(() => /Step 6 of 6/.test(document.querySelector('.coach.tour').textContent));
      await t.screenshot(page, 'tour_save');
      await page.click('[data-log="tour-save"]');
      await waitForRoute(page, 'training');
      assert.match(await page.textContent('main.training .success'), /Tour finished/);
      assert.equal(await page.locator('[data-stage="tour"]').getAttribute('data-status'), 'completed');
      assert.equal(await page.textContent('main.training .btn.primary'), 'See the artifacts');
      await page.evaluate(() => globalThis.ElectroTag.flushLog());
      const events = await page.evaluate(() => globalThis.ElectroTag.backend.resultsDocument().interaction_logs[0].events);
      const steps = events.filter((e) => e.type === 'tour_step');
      assert.deepEqual(steps.map((e) => [e.step, e.completed_by]), [['move', 'action'], ['mark', 'action'], ['channels', 'action'],
        ['undo', 'action'], ['confidence', 'action'], ['save', 'action']]);
      assert.ok(events.some((e) => e.type === 'tour_finished'));
      // nothing of the tour was saved
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.backend.state.submissions.length), 0);
    },
  },
  {
    name: 'Meet the artifacts: the examples by type with the experts\' notes, then the stage is done',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'T01');
      await waitForRoute(page, 'training');
      await page.click('main.training [data-log="skip-tour"]');
      await clickDialogButton(page, 'Skip this stage');
      await page.waitForSelector('main.training [data-stage="tour"][data-status="skipped"]');
      assert.match(await page.locator('[data-stage="snippets"]').textContent(), /12 examples of the experts' artifacts, with their notes, then a quick recognition check\./);
      await page.click('main.training [data-log="training-continue"]');
      await page.waitForSelector('.view.snippets [data-log="snippets-use-examples"]');
      await t.screenshot(page, 'snippets_open');
      await page.click('[data-log="snippets-use-examples"]');
      await page.waitForSelector('.snippet-label');
      await page.waitForFunction(() => globalThis.ElectroTag.snippetsView && globalThis.ElectroTag.snippetsView.viewer
        && globalThis.ElectroTag.snippetsView.viewer.stats.traceMs > 0, null, { timeout: 15000 });
      assert.match(await page.textContent('.snippet-position'), /Example 1 of 12/);
      assert.match(await page.textContent('.snippet-note'), /^The experts' note: Simulated example\./);
      // the stretch at its place in the recording, without the filters' edge zones
      const shown = await page.evaluate(() => {
        const v = globalThis.ElectroTag.snippetsView;
        const s = v.data.snippets[v.current];
        return { startS: v.viewer.view.startS, want: Math.max(0, s.start_s - s.context_s), edges: v.viewer.showEdgeZones, onset: v.viewer.ghost.onset_sample,
          sample: Math.round(s.start_s * v.viewer.sfreq) };
      });
      assert.ok(Math.abs(shown.startS - shown.want) < 0.01, JSON.stringify(shown));
      assert.equal(shown.edges, false);
      assert.ok(Math.abs(shown.onset - shown.sample) <= 1, JSON.stringify(shown));
      await t.screenshot(page, 'snippets_gallery');
      // the arrow keys go from example to example
      await page.keyboard.press('ArrowRight');
      assert.match(await page.textContent('.snippet-position'), /Example 2 of 12/);
      await page.keyboard.press('ArrowLeft');
      assert.match(await page.textContent('.snippet-position'), /Example 1 of 12/);
      await page.click('[data-log="snippet-next"]');
      assert.match(await page.textContent('.snippet-position'), /Example 2 of 12/);
      await page.locator('.snippet-type', { hasText: 'EMG-artifact' }).locator('.snippet-dot').first().click();
      assert.match(await page.textContent('.snippet-label'), /EMG-artifact/);
      assert.match(await page.textContent('.snippet-where'), /on F7, T7, F8 and T8|on F7, F8, T7 and T8/);
      assert.equal(await page.locator('.snippet-dot.seen').count(), 3);
      // the recognition check uses the recordings already open, and comes back to the gallery with its result
      const before = await page.textContent('.snippet-position');
      await page.click('[data-log="snippets-quiz"]');
      await waitForRoute(page, 'quiz');
      await page.waitForSelector('input[name="quiz-answer"]', { timeout: 15000 });
      assert.equal(await page.locator('[data-log="quiz-use-examples"]').count(), 0, 'no file to open again');
      await page.locator('input[name="quiz-answer"]').first().check();
      await page.click('[data-log="quiz-submit"]');
      await page.click('[data-log="quiz-stop"]');
      await clickDialogButton(page, 'End the quiz now');
      await page.waitForSelector('[data-log="quiz-done"]');
      assert.equal(await page.textContent('[data-log="quiz-done"]'), 'Back to the examples');
      await page.click('[data-log="quiz-done"]');
      await waitForRoute(page, 'training');
      await page.waitForSelector('.snippet-quiz-result');
      assert.match(await page.textContent('.snippet-quiz-result'), /^Recognition check: [01] of 7 right$/);
      assert.equal(await page.textContent('.snippet-position'), before);
      assert.equal(await page.locator('.snippet-dot.seen').count(), 3);
      await t.screenshot(page, 'snippets_after_check');
      await page.click('[data-log="snippets-done"]');
      await waitForRoute(page, 'training');
      assert.match(await page.textContent('main.training .success'), /Meet the artifacts is done/);
      assert.equal(await page.locator('[data-stage="snippets"]').getAttribute('data-status'), 'completed');
      assert.match(await page.textContent('main.training .btn.primary'), /Start recording 1 of 2/);
      assert.match(await page.textContent('[data-stage="snippets"]'), /You have taken the recognition check\./);
      // a finished stage can be looked at again
      assert.equal(await page.locator('[data-stage="snippets"] [data-log="look-again-snippets"]').count(), 1);
      assert.equal(await page.locator('[data-stage="tour"] [data-log="look-again-tour"]').count(), 0, 'skipped, not done');
      await page.evaluate(() => globalThis.ElectroTag.flushLog());
      const kinds = await page.evaluate(() => globalThis.ElectroTag.backend.resultsDocument().interaction_logs[0].events.map((e) => e.type));
      assert.equal(kinds.filter((k) => k === 'snippet_viewed').length, 3);
      assert.ok(kinds.includes('snippets_done') && kinds.includes('stage_skipped'));
    },
  },
  {
    name: 'on a study server, a study recording stays locked until the competency assessment is met',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const call = async (token, method, p, body) => {
        const r = await fetch(`${t.study.base}api/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined,
          headers: { 'Content-Type': 'application/json', 'X-ElectroTag': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
        const j = await r.json();
        if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j)}`);
        return j;
      };
      const login = async (id, password) => (await call(null, 'POST', '/login', { annotator_id: id, password })).token;
      const SUB1 = 'sub-001/eeg/sub-001_task-rest_eeg.vhdr';
      const PRACTICE = 'sub-example03/eeg/sub-example03_task-example_eeg.vhdr';
      // The study team: the example set's practice reference becomes the assessment of a set of its own, for a new
      // trainee who also has a study recording. (Nothing is saved in the study's own work, which other specs count.)
      const refs = path.join(t.study.dir, 'study', 'derivatives', 'electrotag_reference_sets', 'example', 'references');
      const reference = JSON.parse(fs.readFileSync(path.join(refs, fs.readdirSync(refs).find((f) => f.includes('example03'))), 'utf8'));
      const admin = await login('ADMIN', 'electrotag');
      const op = (name, body) => call(admin, 'POST', `/admin/${name}`, body);
      await op('set_create', { set_id: 'gate-check', name: 'Gate check' });
      await op('set_add_reference', { set_id: 'gate-check', recording_id: PRACTICE, recording_scope: 'set:example', use: 'assessment',
        source: { kind: 'document', document: reference } });
      await op('set_update', { set_id: 'gate-check', criteria: { criteria: [{ metric: 'event_f1', threshold: 0.5, scope: 'overall' }], min_reference_events: 1, categories: null } });
      await op('user_add', { annotator_id: 'T05', display_name: 'Trainee five', password: 'trainee five' });
      await op('programme_set', { annotator_id: 'T05', set_id: 'gate-check' });
      await op('assign', { annotator_ids: ['T05'], recording_ids: [SUB1] });

      const page = await t.newPage({ url: t.study.base });
      await signIn(page, 'T05', 'trainee five');
      await waitForRoute(page, 'training');
      assert.match(await page.textContent('main.training .gate-card'), /^Your study recordings open once you pass the competency assessment at the end of your training path\.$/);
      // T05 skips the tour; the set has nothing else before its assessment
      await page.click('main.training [data-log="skip-tour"]');
      await clickDialogButton(page, 'Skip this stage');
      await page.waitForSelector('main.training [data-stage="tour"][data-status="skipped"]');
      assert.equal(await page.textContent('main.training .btn.primary'), 'Start the assessment');
      await t.screenshot(page, 'training_gate_path');
      // the home page: the study recording is locked, and says why
      await page.click('[data-log="training-back"]');
      await waitForRoute(page, 'home');
      // a locked recording is not one to do yet: it waits under Locked (To do holds the assessment recording)
      assert.match(await page.textContent('.rec-tabs [data-tab="todo"]'), /To do\s*1/);
      await page.click('.rec-tabs [data-tab="locked"]');
      const row = page.locator('.recordings-card tr', { hasText: 'sub-001_task-rest_eeg.vhdr' });
      assert.match(await row.textContent(), /Locked/);
      assert.match(await row.textContent(), /Opens once you pass the competency assessment\./);
      assert.equal(await row.locator('button', { hasText: /^Open/ }).count(), 0);
      await t.screenshot(page, 'training_gate_home');
      // opened from the computer all the same, it is refused with the reason and the way on
      await page.click('.recordings-card button:has-text("Open a recording from your computer")');
      await waitForRoute(page, 'open');
      const sub1 = path.join(t.study.dir, 'recordings', 'study', 'sub-001', 'eeg');
      await page.setInputFiles('input[data-log="file-input"]', fs.readdirSync(sub1).filter((f) => /\.(vhdr|vmrk|eeg)$/.test(f)).map((f) => path.join(sub1, f)));
      await page.waitForSelector('main [data-log="training-path"]', { timeout: 30000 });
      assert.match(await page.textContent('main'), /Your study recordings open once you pass the competency assessment/);
      await t.screenshot(page, 'training_gate_open');
      // the assessment, saved well: its result is met, and the recording opens
      await page.click('main [data-log="training-path"]');
      await waitForRoute(page, 'training');
      await page.click('main.training [data-log="training-continue"]');
      await waitForRoute(page, 'open');
      const training = path.join(t.study.dir, 'recordings', 'training', 'sub-example03', 'eeg');
      await page.setInputFiles('input[data-log="file-input"]', fs.readdirSync(training).filter((f) => /\.(vhdr|vmrk|eeg)$/.test(f)).map((f) => path.join(training, f)));
      await waitForRoute(page, 'annotate', 30000);
      await waitForTraces(page);
      // the experts' marks, as a trainee who knows them would make them
      await page.evaluate((anns) => { for (const a of anns) globalThis.ElectroTag.ws.store.add(a.label, a.onset_sample, a.duration_samples, a.channels || []); },
        reference.annotations.map((a) => ({ label: a.label, onset_sample: a.onset_sample, duration_samples: a.duration_samples, channels: a.channels })));
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await waitForRoute(page, 'training', 30000);
      assert.match(await page.locator('[data-stage="assessment"]').textContent(), /Criteria met/);
      assert.equal(await page.locator('main.training .gate-card').count(), 0);
      // a clear moment: passed, the study recordings open, and the next one a press away
      assert.equal(await page.textContent('main.training .next-outcome'), 'You passed: your study recordings are now open.');
      assert.equal(await page.textContent('main.training .btn.primary'), 'Open next recording');
      assert.match(await page.textContent('main.training .success'), /Your last assessment recording is saved\./);
      await t.screenshot(page, 'training_passed');
      await page.click('[data-log="training-back"]');
      await waitForRoute(page, 'home');
      assert.equal(await page.locator('.recordings-card tr', { hasText: 'sub-001_task-rest_eeg.vhdr' }).locator('button', { hasText: /^Open/ }).count(), 1);
      // the skip is in T05's progress, kept by the study
      const prog = JSON.parse(fs.readFileSync(path.join(t.study.dir, 'study', 'Annotated_Events', 'training_progress', 'gate-check', 'annotator-T05.json'), 'utf8'));
      assert.deepEqual(prog.events.map((e) => [e.event, e.stage]), [['stage_skipped', 'tour']]);
    },
  },
  {
    name: 'on a study server, an assessment not met: waiting for the study team, who reopen the training; the round is kept with its report',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const call = async (token, method, p, body) => {
        const r = await fetch(`${t.study.base}api/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined,
          headers: { 'Content-Type': 'application/json', 'X-ElectroTag': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
        const j = await r.json();
        if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j)}`);
        return j;
      };
      const login = async (id, password) => (await call(null, 'POST', '/login', { annotator_id: id, password })).token;
      const SUB2 = 'sub-002/eeg/sub-002_task-rest_eeg.vhdr';
      const PRACTICE = 'sub-example03/eeg/sub-example03_task-example_eeg.vhdr';
      const refs = path.join(t.study.dir, 'study', 'derivatives', 'electrotag_reference_sets', 'example', 'references');
      const reference = JSON.parse(fs.readFileSync(path.join(refs, fs.readdirSync(refs).find((f) => f.includes('example03'))), 'utf8'));
      const admin = await login('ADMIN', 'electrotag');
      const op = (name, body) => call(admin, 'POST', `/admin/${name}`, body);
      await op('set_create', { set_id: 'notmet-check', name: 'Not met check' });
      await op('set_add_reference', { set_id: 'notmet-check', recording_id: PRACTICE, recording_scope: 'set:example', use: 'assessment',
        source: { kind: 'document', document: reference } });
      await op('set_update', { set_id: 'notmet-check', criteria: { criteria: [{ metric: 'event_f1', threshold: 0.9, scope: 'overall' }], min_reference_events: 1, categories: null } });
      await op('user_add', { annotator_id: 'T07', display_name: 'Trainee seven', password: 'trainee seven' });
      await op('programme_set', { annotator_id: 'T07', set_id: 'notmet-check' });
      await op('assign', { annotator_ids: ['T07'], recording_ids: [SUB2] });

      const page = await t.newPage({ url: t.study.base, width: 1440, height: 900 });
      await signIn(page, 'T07', 'trainee seven');
      await waitForRoute(page, 'training');
      await page.click('main.training [data-log="skip-tour"]');
      await clickDialogButton(page, 'Skip this stage');
      await page.waitForSelector('main.training [data-stage="tour"][data-status="skipped"]');
      await page.click('main.training [data-log="training-continue"]');
      await waitForRoute(page, 'open');
      const training = path.join(t.study.dir, 'recordings', 'training', 'sub-example03', 'eeg');
      await page.setInputFiles('input[data-log="file-input"]', fs.readdirSync(training).filter((f) => /\.(vhdr|vmrk|eeg)$/.test(f)).map((f) => path.join(training, f)));
      await waitForRoute(page, 'annotate', 30000);
      await waitForTraces(page);
      // one mark where the experts have none: far from the criteria
      await page.evaluate(() => globalThis.ElectroTag.ws.store.add('EMG-artifact', 100, 50, []));
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await waitForRoute(page, 'training', 30000);
      // one clear line: not met, waiting for the study team; no button points at the locked recordings
      assert.equal(await page.textContent('main.training .next-outcome'), 'Assessment not met: waiting for your study team.');
      assert.equal(await page.locator('main.training .gate-card').count(), 0);
      assert.equal(await page.locator('main.training .next-step .btn.primary').count(), 0);
      assert.match(await page.textContent('main.training .next-step .gate-line'), /did not meet the competency criteria yet/);
      await t.screenshot(page, 'training_not_met');
      await page.click('[data-log="training-back"]');
      await waitForRoute(page, 'home');
      assert.equal(await page.textContent('.next-card h2'), 'Assessment not met: waiting for your study team');
      assert.equal(await page.locator('.training-done').count(), 0, 'not "Training complete"');
      assert.match(await page.locator('.recordings-card tr', { hasText: 'sub-002_task-rest_eeg.vhdr' }).textContent(), /Assessment not met: waiting for your study team\./);
      await t.screenshot(page, 'training_not_met_home');
      await page.click('[data-log="sign-out"]');
      // the study team reopens the training on T07's page; the round that ended stays, with its report
      await signIn(page, 'ADMIN', 'electrotag');
      await waitForRoute(page, 'admin');
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-annotators', { annotator: 'T07' }));
      await page.waitForSelector('.gate-stages');
      await page.click('[data-log="training-reopen"]');
      await page.click('.inline-confirm button:has-text("Reopen it"), button:has-text("Reopen it")');
      await page.waitForSelector('.gate-round-list li');
      assert.match(await page.textContent('.gate-round-list li'), /^Round 1, Not met check: not met, /);
      await page.click('[data-log="training-round-report"]');
      await page.waitForSelector('.gate-round-report .report-frame');
      await t.screenshot(page, 'admin_trainee_rounds');
      await page.click('[data-log="sign-out"]');
      await signIn(page, 'T07', 'trainee seven');
      await waitForRoute(page, 'training');
      assert.match(await page.textContent('[data-stage="assessment"] .stage-rounds'), /^Round 1, Not met check: /);
      assert.equal(await page.textContent('main.training .btn.primary'), 'Start the assessment');
      assert.match(await page.textContent('[data-stage="assessment"]'), /reopened your training/);
    },
  },
  {
    name: 'the study team sees a trainee\'s skips, adds a snippet and finds the training policy',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'T01');
      await waitForRoute(page, 'training');
      await skipFirstStages(page);
      await page.click('[data-log="sign-out"]');
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin'); // the admin area's first page, before going to the trainee's
      await page.waitForSelector('.admin-section[data-section="overview"]');
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-annotators', { annotator: 'T01' }));
      await page.waitForSelector('.gate-stages');
      const card = await page.locator('.admin-card', { hasText: 'Training path' }).textContent();
      assert.match(card, /Study recordings open/);
      assert.match(card, /Find your way around: skipped/);
      await page.click('.admin-card summary:has-text("What happened to the stages")');
      assert.match(await page.textContent('.gate-events'), /Find your way around skipped, /);
      await t.screenshot(page, 'admin_trainee_path');
      // Training, Snippets: the guided recordings' snippets, and one of the team's own
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-training'));
      await page.click('.admin-tabs [data-tab="snippets"]');
      await page.waitForSelector('.admin-card:has-text("Add a snippet") form');
      const form = page.locator('.admin-card', { hasText: 'Add a snippet' });
      await form.locator('select').nth(1).selectOption('EMG-artifact');
      const inputs = form.locator('input.field');
      await inputs.nth(0).fill('9.2');
      await inputs.nth(1).fill('10.8');
      await inputs.nth(3).fill('F7, F8, T7, T8');
      await form.locator('textarea').fill('Fast, spiky activity over the temples: muscle.');
      await page.click('[data-log="snippet-add"]');
      await page.waitForSelector('.admin-msg .success');
      assert.match(await page.textContent('.admin-section'), /Added the snippet s01/);
      assert.match(await page.locator('.admin-card', { hasText: 'Snippets of this set' }).textContent(), /EMG-artifact.*9\.20–10\.80 s.*F7, F8, T7, T8/s);
      await t.screenshot(page, 'admin_snippets');
      // Study settings: the training policy
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-settings'));
      await page.waitForSelector('.admin-card:has-text("Training policy")');
      assert.match(await page.locator('.admin-card', { hasText: 'Training policy' }).textContent(), /every skip is noted/);
    },
  },
];
