// The short-segment quiz with the real study server (`electroclean-web demo`): quiz items added to
// the example set by the administrator (the demonstration study has none of its own), the quiz
// listed in GET /me, its recordings opened from the demonstration's folder and checked against the
// server's manifests, every segment answered, the score, and the result saved in the study folder
// as the desktop saves it. Until the server offers POST /quiz/{set_id}, the test says so and stops.
import fs from 'node:fs';
import path from 'node:path';
import { signIn, waitForRoute } from './helpers.mjs';

const PASSWORD = 'electroclean';

async function api(base, method, route, body, token = null) {
  const headers = { 'X-ElectroClean': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base.replace(/\/+$/, '')}/api/v1${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data };
}

async function login(base, id) {
  const r = await api(base, 'POST', '/login', { annotator_id: id, password: PASSWORD });
  if (r.status !== 200) throw new Error(`${id} could not sign in: ${JSON.stringify(r.data)}`);
  return r.data.token;
}

function findFiles(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findFiles(p, prefix));
    else if (e.name.startsWith(prefix) && e.name.endsWith('.json') && p.split(path.sep).includes('quiz')) out.push(p);
  }
  return out;
}

/** The administrator adds three segments of the example set's recordings to its quiz. */
async function addQuizItems(base) {
  const admin = await login(base, 'ADMIN');
  const sets = await api(base, 'POST', '/admin/sets_list', {}, admin);
  if (sets.status === 404) return { skip: `the server offers the quiz but not the admin operations (POST /admin/sets_list answered 404: ${sets.data && sets.data.message})` };
  if (sets.status !== 200) throw new Error(`sets_list: ${JSON.stringify(sets.data)}`);
  const set = sets.data.sets.find((s) => s.recordings.some((r) => r.registered));
  if (!set) return { skip: 'the demonstration study has no reference set with registered recordings' };
  const scope = set.scope || `set:${set.set_id}`;
  const recs = (await api(base, 'POST', '/admin/recordings_list', { scope }, admin)).data.recordings;
  const ids = new Set(set.recordings.map((r) => r.recording_id));
  const mine = recs.filter((r) => ids.has(r.recording_id));
  const labels = ['EMG-artifact', 'Eye-blink-artifact', 'Movement-artifact'];
  for (let i = 0; i < 3; i++) {
    const rec = mine[i % mine.length];
    const start = 4 + 6 * i;
    const r = await api(base, 'POST', '/admin/quiz_item_add', { set_id: set.set_id, recording_id: rec.recording_id, start_s: start, end_s: start + 1.5,
      correct_label: labels[i], explanation: `A segment for the test (${labels[i]}).` }, admin);
    if (r.status !== 200) throw new Error(`quiz_item_add: ${JSON.stringify(r.data)}`);
  }
  return { setId: set.set_id };
}

export const tests = [
  {
    name: 'the quiz with the study server: recordings checked against its manifests, answers, score and result file',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const base = t.study.base;
      const token = await login(base, 'A01');
      let me = (await api(base, 'GET', '/me', undefined, token)).data;
      const probeSet = ((me.quizzes || [])[0] || {}).set_id || 'example';
      const probe = await api(base, 'POST', `/quiz/${encodeURIComponent(probeSet)}`, { action: 'get' }, token);
      if (probe.status === 404 && /There is no \/api\/v1\/quiz/.test((probe.data && probe.data.message) || '')) {
        console.log(`     skip: the study server does not offer the quiz yet (POST /api/v1/quiz/{set_id} answered 404: ${probe.data.message}). ` +
          'This test runs once the server side of the quiz is merged.');
        return;
      }
      if (!(me.quizzes || []).length) {
        const added = await addQuizItems(base);
        if (added.skip) {
          console.log(`     skip: ${added.skip}.`);
          return;
        }
        me = (await api(base, 'GET', '/me', undefined, token)).data;
      }
      const set = (me.quizzes || []).find((q) => !q.finished);
      assert.ok(set, `GET /me lists no quiz to take: ${JSON.stringify(me.quizzes)}`);
      assert.ok(['immediate', 'end'].includes(set.feedback), `the quiz's feedback: ${set.feedback}`);

      const page = await t.newPage({ url: base });
      await signIn(page, 'A01', PASSWORD);
      await waitForRoute(page, 'home');
      await page.click(`[data-log="quiz-${set.set_id}"]`);
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
      console.log(`     ${set.set_id}: ${n} segments answered, feedback ${set.feedback}`);
      assert.equal(n, set.n_items);
      const score = await page.textContent('.quiz-score');
      assert.match(score, new RegExp(`You answered \\d+ of ${n} segments? correctly`));
      // the server's record: finished, with the score; the answers with the browser's response times
      const after = await api(base, 'POST', `/quiz/${encodeURIComponent(set.set_id)}`, { action: 'get' }, token);
      assert.equal(after.data.finished, true);
      assert.equal(after.data.score.n_answered, n);
      const files = findFiles(t.study.dir, 'annotator-A01_quiz_');
      assert.equal(files.length, 1, `the quiz result in the study folder: ${files.join(', ')}`);
      const result = JSON.parse(fs.readFileSync(files[0], 'utf8'));
      assert.equal(result.schema, 'electroclean.quiz_result');
      assert.equal(result.completed, true);
      assert.equal(result.answers.length, n);
      assert.ok(result.answers.every((a) => typeof a.response_time_s === 'number' && a.response_time_s > 0), 'response times kept');
      assert.match(path.relative(t.study.dir, files[0]).split(path.sep).join('/'), new RegExp(`training/${set.set_id}/quiz/annotator-A01_quiz_(practice|assessment)_`));
    },
  },
];
