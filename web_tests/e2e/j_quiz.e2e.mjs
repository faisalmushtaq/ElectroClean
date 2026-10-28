// The short-segment quiz in the demonstration: the entry on the home view, the recordings opened
// (built-in copies, then files from the computer, a changed copy refused), each segment shaded in
// the viewer, feedback after each answer, stopping and carrying on, the score, and the interaction
// log's quiz events.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signIn, waitForRoute, clickDialogButton } from './helpers.mjs';
import { QUIZ } from '../../electroclean/web/static/js/api/demo.js';
import { demoSpecs, syntheticEdfBytes } from '../../electroclean/web/static/js/data/synthetic.js';

const TRUTH = new Map(QUIZ.items.map((i) => [i.item_id, i]));

async function current(page) {
  try {
    await page.waitForFunction(() => {
      const q = globalThis.ElectroClean.quizView;
      return q && q.viewer && q.current && q.viewer.stats.traceMs > 0 && !q.busy;
    }, null, { timeout: 15000 });
  } catch (exc) {
    const why = await page.evaluate(() => {
      const q = globalThis.ElectroClean.quizView;
      return { route: globalThis.ElectroClean.route, quiz: Boolean(q), viewer: Boolean(q && q.viewer), busy: q && q.busy, current: Boolean(q && q.current),
        stats: q && q.viewer ? q.viewer.stats : null, error: q && q.viewer ? String(q.viewer.loadError || '') : '', body: document.querySelector('.quiz-body')?.textContent.slice(0, 400) };
    });
    throw new Error(`the quiz did not show its segment: ${JSON.stringify(why)}`);
  }
  return page.evaluate(() => {
    const q = globalThis.ElectroClean.quizView;
    const v = q.viewer;
    return { item: q.current.item, index: q.current.index, ghost: v.ghost, view: { ...v.view }, total: v.durationTotal, rows: v.channels.length,
      progress: document.querySelector('.quiz-progress').textContent };
  });
}

async function answer(page, label) {
  await page.check(`input[name="quiz-answer"][value="${label}"]`);
  await page.click('[data-log="quiz-submit"]');
}

function writeExamples() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-quiz-'));
  const specs = demoSpecs().slice(0, 2);
  const files = specs.map((s) => {
    const p = path.join(dir, `${s.stem}_eeg.edf`);
    fs.writeFileSync(p, syntheticEdfBytes(s));
    return p;
  });
  const changedDir = path.join(dir, 'changed');
  fs.mkdirSync(changedDir);
  const changed = path.join(changedDir, path.basename(files[0]));
  const copy = Buffer.from(fs.readFileSync(files[0]));
  copy[copy.length - 1] ^= 0x01;
  fs.writeFileSync(changed, copy);
  return { dir, files, changed };
}

export const tests = [
  {
    name: 'the short-segment quiz: segments shaded, feedback, stopping and carrying on, the score and its log',
    async run(t) {
      const { assert } = t;
      const disk = writeExamples();
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      const card = page.locator('.quiz-card');
      assert.match(await card.textContent(), /Demonstration quiz/);
      await page.click('[data-log="quiz-example"]');
      await waitForRoute(page, 'quiz');
      await page.waitForSelector('[data-log="quiz-use-examples"]');
      assert.match(await page.textContent('.quiz-body'), /Open sub-demo0\d_task-rest_eeg\.edf/);
      await t.screenshot(page, 'quiz_open');
      await page.click('[data-log="quiz-use-examples"]');

      // the first segment: its context around it, the item's interval shaded, every channel shown
      let c = await current(page);
      const first = TRUTH.get(c.item.item_id);
      assert.equal(c.progress, `Segment 1 of ${QUIZ.items.length}`);
      const sf = 250;
      const tmin = Math.max(0, first.start_s - 2);
      assert.ok(Math.abs(c.total - (Math.min(70, first.end_s + 2) - tmin)) < 1 / sf, `segment of ${c.total} s`);
      assert.equal(c.ghost.onset_sample, Math.round((first.start_s - tmin) * sf));
      assert.equal(c.ghost.duration_samples, Math.round((first.end_s - first.start_s) * sf));
      assert.equal(c.view.startS, 0);
      assert.equal(c.view.nChannels, c.rows);
      assert.match(await page.textContent('.quiz-side'), /Which artifact type is the main one in the shaded segment\?/);
      assert.match(await page.textContent('.quiz-side'), /Eye-artifact {2}\(group: exact type unclear\)/);
      await t.screenshot(page, 'quiz_segment');
      // no answer chosen
      await page.click('[data-log="quiz-submit"]');
      assert.match(await page.textContent('.quiz-feedback'), /Please choose an answer/);
      await answer(page, first.correct_label);
      await page.waitForSelector('.quiz-feedback.success');
      assert.match(await page.textContent('.quiz-feedback'), /^Correct\./);
      assert.equal(await page.textContent('[data-log="quiz-submit"]'), 'Next segment');
      await t.screenshot(page, 'quiz_feedback');
      await page.click('[data-log="quiz-submit"]');

      // the second, answered wrongly
      c = await current(page);
      const second = TRUTH.get(c.item.item_id);
      const wrong = second.correct_label === 'Movement-artifact' ? 'EMG-artifact' : 'Movement-artifact';
      await answer(page, wrong);
      await page.waitForSelector('.quiz-feedback.banner');
      assert.match(await page.textContent('.quiz-feedback'), new RegExp(`Not quite: the expected answer is ${second.correct_label}\\.`));
      assert.ok(await page.isDisabled(`input[name="quiz-answer"][value="${wrong}"]`), 'answers are fixed once sent');

      // stop: the answers are kept; carry on later from the third segment
      await page.click('[data-log="quiz-stop"]');
      await clickDialogButton(page, 'Stop for now');
      await waitForRoute(page, 'home');
      await page.click('[data-log="quiz-example"]');
      await waitForRoute(page, 'quiz');
      await page.waitForSelector('[data-log="quiz-file-input"]', { state: 'attached' });
      assert.match(await page.textContent('.quiz-progress'), new RegExp(`Segment 3 of ${QUIZ.items.length}`));
      // a changed copy is refused; the study's copies (from the computer) are accepted
      await page.setInputFiles('[data-log="quiz-file-input"]', [disk.changed]);
      await page.waitForSelector('.quiz-body .banner');
      assert.match(await page.textContent('.quiz-body .banner'), /is not the study's copy .*its fingerprint differs/);
      await page.setInputFiles('[data-log="quiz-file-input"]', disk.files);
      for (let i = 2; i < QUIZ.items.length; i++) {
        c = await current(page);
        assert.equal(c.progress, `Segment ${i + 1} of ${QUIZ.items.length}`);
        await answer(page, TRUTH.get(c.item.item_id).correct_label);
        await page.waitForSelector('.quiz-feedback.success');
        if (i === QUIZ.items.length - 1) assert.equal(await page.textContent('[data-log="quiz-submit"]'), 'See my result');
        await page.click('[data-log="quiz-submit"]');
      }
      await page.waitForSelector('.quiz-score');
      const n = QUIZ.items.length;
      assert.equal(await page.textContent('.quiz-score'), `You answered ${n - 1} of ${n} segments correctly (${Math.round((100 * (n - 1)) / n)}%).`);
      assert.match(await page.textContent('table.quiz-categories'), new RegExp(second.correct_label));
      await t.screenshot(page, 'quiz_score');
      await page.click('[data-log="quiz-done"]');
      await waitForRoute(page, 'home');
      assert.match(await page.textContent('.quiz-card'), /Finished/);

      // the interaction log has the desktop's quiz events
      const events = await page.evaluate(async () => {
        await globalThis.ElectroClean.flushLog();
        return [...globalThis.ElectroClean.backend.visits.values()].flatMap((v) => v.events);
      });
      const of = (type) => events.filter((e) => e.type === type);
      assert.equal(of('quiz_item_shown').length, n);
      assert.equal(of('quiz_answer').length, n);
      assert.ok(of('quiz_answer').every((e) => typeof e.response_time_s === 'number' && e.quiz_mode === 'practice'));
      assert.equal(of('quiz_answer').filter((e) => e.correct === false).length, 1);
      assert.equal(of('quiz_stopped').length, 1);
      assert.equal(of('quiz_finished')[0].n_correct, n - 1);
      assert.equal(of('quiz_recording_checked').filter((e) => !e.matched).length, 1);
      fs.rmSync(disk.dir, { recursive: true, force: true });
    },
  },
  {
    name: 'an answer given on another page is the one kept, and a quiz finished elsewhere shows its score',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      assert.match(await page.textContent('.quiz-card'), /7 segments; whether each answer is right, straight away/);
      await page.click('[data-log="quiz-example"]');
      await waitForRoute(page, 'quiz');
      await page.click('[data-log="quiz-use-examples"]');
      const c = await current(page);
      const truth = TRUTH.get(c.item.item_id);
      const elsewhere = truth.correct_label === 'EMG-artifact' ? 'Chewing-artifact' : 'EMG-artifact';
      // the same segment answered on another page (the demonstration's study is in this browser)
      await page.evaluate(([id, label]) => globalThis.ElectroClean.backend.quiz('example', { action: 'answer', item_id: id, label }), [c.item.item_id, elsewhere]);
      await answer(page, truth.correct_label);
      await page.waitForSelector('.quiz-feedback.note');
      assert.equal(await page.textContent('.quiz-feedback.note'), `Your earlier answer to that segment, ${elsewhere}, is the one kept.`);
      const c2 = await current(page);
      assert.equal(c2.progress, `Segment 2 of ${QUIZ.items.length}`);
      assert.notEqual(c2.item.item_id, c.item.item_id);
      // the quiz finished on another page: the next answer finds it finished, and its score is shown
      await page.evaluate(() => globalThis.ElectroClean.backend.quiz('example', { action: 'finish' }));
      await answer(page, TRUTH.get(c2.item.item_id).correct_label);
      await page.waitForSelector('.quiz-score');
      assert.equal(await page.textContent('.quiz-score'), `You answered 0 of 1 segment correctly (0%). ${QUIZ.items.length - 1} of the ${QUIZ.items.length} segments were not answered.`);
      assert.match(await page.textContent('.quiz-body'), /You have finished this quiz[\s\S]*This quiz was finished on another page or computer\./);
      const refused = await page.evaluate(async () => {
        await globalThis.ElectroClean.flushLog();
        return [...globalThis.ElectroClean.backend.visits.values()].flatMap((v) => v.events).filter((e) => e.type === 'quiz_answer_refused');
      });
      assert.deepEqual(refused.map((e) => [e.reason, e.kept_answer]), [['already_answered', elsewhere], ['finished', null]]);
    },
  },
  {
    name: 'ending the quiz early gives the score of the segments answered, as the desktop did',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await page.click('[data-log="quiz-example"]');
      await waitForRoute(page, 'quiz');
      await page.click('[data-log="quiz-use-examples"]');
      const c = await current(page);
      await answer(page, TRUTH.get(c.item.item_id).correct_label);
      await page.waitForSelector('.quiz-feedback.success');
      await page.click('[data-log="quiz-stop"]');
      assert.match(await page.textContent('.dialog'), /End the quiz now gives your score for the segments you answered/);
      await clickDialogButton(page, 'End the quiz now');
      await page.waitForSelector('.quiz-score');
      const n = QUIZ.items.length;
      assert.equal(await page.textContent('.quiz-score'), `You answered 1 of 1 segment correctly (100%). ${n - 1} of the ${n} segments were not answered.`);
      const ended = await page.evaluate(async () => {
        await globalThis.ElectroClean.flushLog();
        return [...globalThis.ElectroClean.backend.visits.values()].flatMap((v) => v.events).filter((e) => e.type === 'quiz_ended_early');
      });
      assert.equal(ended.length, 1);
      assert.equal(ended[0].answered, 1);
    },
  },
  {
    name: 'a trainee finds the quiz on the training path',
    async run(t) {
      const page = await t.newPage();
      await signIn(page, 'T01');
      await waitForRoute(page, 'training');
      t.assert.match(await page.textContent('main.training .quiz-card'), /Demonstration quiz/);
      await page.click('main.training [data-log="quiz-example"]');
      await waitForRoute(page, 'quiz');
      await page.waitForSelector('[data-log="quiz-use-examples"]');
      await page.click('[data-log="quiz-stop"]');
      await waitForRoute(page, 'training');
    },
  },
];
