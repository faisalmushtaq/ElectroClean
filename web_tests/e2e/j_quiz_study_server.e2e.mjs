// The short-segment quiz with the real study server (`electroclean-web demo`): the quiz listed in
// GET /me, its recordings opened from the demonstration's folder and checked against the server's
// manifests, every segment answered, the score, and the result saved in the study folder as the
// desktop saves it. Until the server offers POST /quiz/{set_id}, the test says so and stops.
import fs from 'node:fs';
import path from 'node:path';
import { signIn, waitForRoute } from './helpers.mjs';

const PASSWORD = 'electroclean';

function quizResults(dir, setId, annotator) {
  const folder = path.join(dir, 'study', 'Annotated_Events', 'training', setId, 'quiz');
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((f) => f.startsWith(`annotator-${annotator}_quiz_`) && f.endsWith('.json'));
}

export const tests = [
  {
    name: 'the quiz with the study server: recordings checked against its manifests, answers, score and result file',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      let page = null;
      let probe = null;
      for (const id of ['A01', 'T01']) {
        page = await t.newPage({ url: t.study.base });
        await signIn(page, id, PASSWORD);
        await page.waitForFunction(() => globalThis.ElectroClean && globalThis.ElectroClean.me && ['home', 'training'].includes(globalThis.ElectroClean.route));
        probe = await page.evaluate(async () => {
          const app = globalThis.ElectroClean;
          const quizzes = app.me.quizzes || [];
          const set = quizzes.find((q) => !q.finished) || quizzes[0] || null;
          try {
            await app.backend.quiz(set ? set.set_id : 'example', { action: 'get' });
            return { ok: true, set: set && set.set_id, id: app.me.annotator_id };
          } catch (e) {
            return { ok: false, status: e.status, code: e.code, message: e.message, set: set && set.set_id, id: app.me.annotator_id };
          }
        });
        if (probe.set) break;
      }
      if (!probe.set) {
        if (!probe.ok && probe.status === 404 && /There is no \/api\/v1\/quiz/.test(probe.message || '')) {
          console.log(`     skip: the study server does not offer the quiz yet (POST /api/v1/quiz/{set_id} answered 404: ${probe.message}). ` +
            'This test runs once the server side of the quiz is merged.');
        } else {
          console.log('     skip: the demonstration server lists no quiz in GET /me for A01 or T01.');
        }
        return;
      }
      assert.ok(probe.ok, `the quiz could not be loaded: ${probe.message}`);
      await page.click(`[data-log="quiz-${probe.set}"]`);
      await waitForRoute(page, 'quiz');
      await page.waitForSelector('[data-log="quiz-folder-input"]', { state: 'attached' });
      await page.setInputFiles('[data-log="quiz-folder-input"]', path.join(t.study.dir, 'recordings'));
      let n = 0;
      for (let guard = 0; guard < 200; guard++) {
        await page.waitForFunction(() => {
          const q = globalThis.ElectroClean.quizView;
          return q && !q.busy && (document.querySelector('.quiz-score') || (q.viewer && q.viewer.stats.traceMs > 0) || document.querySelector('.quiz-body .banner'));
        }, null, { timeout: 30000 });
        if (await page.$('.quiz-score')) break;
        const banner = await page.$('.quiz-body .banner');
        if (banner) assert.fail(`the quiz stopped: ${await banner.textContent()}`);
        const first = await page.$('input[name="quiz-answer"]:not(:disabled)');
        await first.check();
        await page.click('[data-log="quiz-submit"]');
        n += 1;
        const immediate = await page.evaluate(() => globalThis.ElectroClean.quizView.immediate);
        if (immediate) {
          await page.waitForSelector('.quiz-feedback.success, .quiz-feedback.banner');
          assert.match(await page.textContent('.quiz-feedback'), /^(Correct\.|Not quite)/);
          await page.click('[data-log="quiz-submit"]');
        }
      }
      const score = await page.textContent('.quiz-score');
      assert.match(score, new RegExp(`You answered \\d+ of ${n} segments correctly`));
      const files = quizResults(t.study.dir, probe.set, probe.id);
      assert.ok(files.length >= 1, `no quiz result in Annotated_Events/training/${probe.set}/quiz for ${probe.id}`);
      const result = JSON.parse(fs.readFileSync(path.join(t.study.dir, 'study', 'Annotated_Events', 'training', probe.set, 'quiz', files[files.length - 1]), 'utf8'));
      assert.equal(result.answers.length, n);
    },
  },
];
