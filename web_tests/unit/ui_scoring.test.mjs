// Practice scoring (js/training/scoring.js): event matching, flags and the pass rule, checked
// against small cases and against the desktop application's own scoring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hungarianMax, matchEvents, practiceFeedback, describePassRule, scoreSentence, practiceVerdict, practiceDetail, retryRecording } from '../../electrotag/web/static/js/training/scoring.js';
import { demoSpecs, truthAnnotations } from '../../electrotag/web/static/js/data/synthetic.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ann = (id, label, on, dur, channels = []) => ({ annotation_id: id, label, onset_sample: on, duration_samples: dur, channels });

test('maximum-weight assignment', () => {
  assert.deepEqual(hungarianMax([[1, 2], [2, 1]]), [[0, 1], [1, 0]]);
  assert.deepEqual(hungarianMax([[5, 0, 0], [0, 0, 3]]), [[0, 0], [1, 2]]);
  assert.deepEqual(hungarianMax([[0, 0], [0, 0]]), []);
  assert.deepEqual(hungarianMax([]), []);
});

test('events match one to one at an overlap of at least 0.2', () => {
  const ref = [ann('r1', 'EMG-artifact', 0, 100), ann('r2', 'EMG-artifact', 200, 100)];
  const mine = [ann('m1', 'EMG-artifact', 0, 300)];
  const m = matchEvents(ref, mine);
  assert.equal(m.pairs.length, 1);
  assert.deepEqual(m.unmatchedRef.length, 1);
  assert.equal(matchEvents([ann('r', 'X', 0, 100)], [ann('m', 'X', 90, 100)]).pairs.length, 0); // overlap 10/190
});

test('practice feedback: perfect, empty and mixed', () => {
  const ref = [ann('r1', 'Eye-blink-artifact', 100, 50), ann('r2', 'EMG-artifact', 1000, 500)];
  const perfect = practiceFeedback(ref, ref.map((a) => ({ ...a, annotation_id: `m${a.annotation_id}` })));
  assert.equal(perfect.passed, true);
  assert.equal(perfect.metrics.event_f1, 1);
  assert.equal(perfect.flags.length, 0);
  const empty = practiceFeedback([], []);
  assert.equal(empty.passed, true);
  const none = practiceFeedback(ref, []);
  assert.equal(none.passed, false);
  assert.deepEqual(none.flags.map((f) => f.kind), ['MISSED', 'MISSED']);
  assert.equal(describePassRule({ event_f1: 0.8, label_accuracy: 0.8 }), 'a score of at least 80% and the right type for at least 80% of the artifacts you find');
});

test('the score is explained in plain words, and the verdict fits the number of practice recordings', () => {
  // the finding that started it: 7 of 8 found and 3 extra gave "found 88%" and "F1 78%" side by side
  const ref = Array.from({ length: 8 }, (_, i) => ann(`r${i}`, 'Eye-blink-artifact', 1000 * i, 100));
  const mine = ref.slice(0, 7).map((a) => ({ ...a, annotation_id: `m${a.annotation_id}` }))
    .concat([0, 1, 2].map((i) => ann(`x${i}`, 'EMG-artifact', 9000 + 400 * i, 100)));
  const fb = practiceFeedback(ref, mine);
  assert.deepEqual(fb.counts, { reference_events: 8, your_events: 10, found: 7, extra: 3, other_type: 0 });
  assert.equal(Math.round(fb.score.event_f1 * 100), 78);
  assert.equal(scoreSentence(fb.counts), "You found 7 of the experts' 8 artifacts and made 3 marks they did not make.");
  assert.equal(scoreSentence({ reference_events: 2, your_events: 2, found: 2, extra: 0, other_type: 1 }),
    "You found 2 of the experts' 2 artifacts and made no marks they did not make. 1 of the 2 you found has another type than theirs.");
  const rule = { event_f1: 0.8, label_accuracy: 0.8 };
  assert.match(practiceVerdict(false, rule, 1), /then try this recording again from your training path\.$/);
  assert.match(practiceVerdict(false, rule, 3), /then go on from your training path to another practice recording\.$/);
  assert.doesNotMatch(practiceVerdict(false, rule, 1), /next practice recording/);
  assert.equal(practiceDetail(null, rule, false), `To pass, you need ${describePassRule(rule)}.`);
  assert.match(practiceDetail({ ...fb.score, ...fb.counts }, rule, false), /^Best score: 78%, with the right type for 100% of the artifacts found\. You found 7/);
});

test('a practice recording tried again is the one practised longest ago', () => {
  const at = (t) => [{ completed_at: t }];
  assert.equal(retryRecording(['a', 'b', 'c'], { a: at('2026-01-03'), b: at('2026-01-01'), c: at('2026-01-02') }), 'b');
  assert.equal(retryRecording(['a', 'b'], { a: at('2026-01-03') }), 'b'); // never tried first
  assert.equal(retryRecording(['a'], { a: at('2026-01-03') }), 'a');
});

// A Python that can import ElectroTag: $ELECTROTAG_PYTHON, the repository's .venv, or python3.
function findPython() {
  for (const p of [process.env.ELECTROTAG_PYTHON, path.join(REPO, '.venv', 'bin', 'python'), 'python3']) {
    if (!p || (p.includes('/') && !fs.existsSync(p))) continue;
    const r = spawnSync(p, ['-c', 'import electrotag.training.assessment'], { cwd: REPO, encoding: 'utf8' });
    if (r.status === 0) return p;
  }
  return null;
}
const PYTHON = findPython();

test('the same scores and flags as the desktop application (Python)', { skip: !PYTHON && 'no Python with ElectroTag installed' }, () => {
  const spec = demoSpecs()[2];
  const truth = truthAnnotations(spec);
  const shift = (a, d) => ({ ...a, annotation_id: `m-${a.annotation_id}`, onset_sample: a.onset_sample + d });
  const cases = [
    truth.map((a) => shift(a, 10)),
    truth.slice(0, 6).map((a, i) => ({ ...shift(a, 0), label: i === 0 ? 'EMG-artifact' : a.label })).concat([ann('x', 'Chewing-artifact', 21000, 300)]),
    [ann('y', 'Eye-blink-artifact', 1000, 120), ann('z', 'Movement-artifact', 7400, 700)],
    [],
    truth.map((a, i) => ({ ...shift(a, 0), label: i % 2 ? 'Data-artifact' : a.label })),
  ].map((mine, i) => ({ sfreq: spec.sfreq, n_samples: spec.nSamples, ch_names: spec.channels, reference: truth, mine,
    n_practice: i % 2 ? 3 : 1, rule: i === 4 ? { event_f1: 0.65, label_accuracy: 0.5 } : undefined }));
  const res = spawnSync(PYTHON, [path.join(REPO, 'web_tests', 'practice_parity.py')], { input: JSON.stringify(cases), encoding: 'utf8', cwd: REPO });
  assert.equal(res.status, 0, res.stderr);
  const py = JSON.parse(res.stdout);
  const r3 = (v) => (v === null || Number.isNaN(v) ? null : Math.round(v * 1e6) / 1e6);
  cases.forEach((c, i) => {
    const rule = c.rule || { event_f1: 0.8, label_accuracy: 0.8 };
    const fb = practiceFeedback(c.reference, c.mine, { passRule: rule });
    const sf = c.sfreq;
    const flags = (kind) => fb.flags.filter((f) => f.kind === kind);
    const mine = {
      event_f1: r3(fb.metrics.event_f1),
      label_accuracy: fb.metrics.found ? r3(fb.metrics.label_accuracy) : null,
      passed: fb.passed,
      missed: flags('MISSED').map((f) => [f.label, Math.round((f.onset_sample / sf) * 1000) / 1000]).sort(),
      extra: flags('EXTRA').map((f) => [f.label, Math.round((f.onset_sample / sf) * 1000) / 1000]).sort(),
      type: flags('TYPE').map((f) => [f.label, f.your_label, Math.round((f.onset_sample / sf) * 1000) / 1000]).sort(),
      counts: fb.counts,
      // the words the trainee reads, the same from the study and the demonstration
      words: {
        rule: describePassRule(rule),
        sentence: scoreSentence(fb.counts),
        verdict: practiceVerdict(fb.passed, rule, c.n_practice),
        detail: practiceDetail({ ...fb.score, ...fb.counts }, rule, fb.passed),
      },
    };
    assert.deepEqual(mine, py[i], `case ${i + 1}`);
  });
});
