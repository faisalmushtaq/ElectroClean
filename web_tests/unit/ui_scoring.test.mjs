// Practice scoring (js/training/scoring.js): event matching, flags and the pass rule, checked
// against small cases and against the desktop application's own scoring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hungarianMax, matchEvents, practiceFeedback, describePassRule } from '../../electroclean/web/static/js/training/scoring.js';
import { demoSpecs, truthAnnotations } from '../../electroclean/web/static/js/data/synthetic.js';

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
  assert.equal(describePassRule({ event_f1: 0.8, label_accuracy: 0.8 }), '80% for finding the artifacts and for their types');
});

// A Python that can import ElectroClean: $ELECTROCLEAN_PYTHON, the repository's .venv, or python3.
function findPython() {
  for (const p of [process.env.ELECTROCLEAN_PYTHON, path.join(REPO, '.venv', 'bin', 'python'), 'python3']) {
    if (!p || (p.includes('/') && !fs.existsSync(p))) continue;
    const r = spawnSync(p, ['-c', 'import electroclean.training.assessment'], { cwd: REPO, encoding: 'utf8' });
    if (r.status === 0) return p;
  }
  return null;
}
const PYTHON = findPython();

test('the same scores and flags as the desktop application (Python)', { skip: !PYTHON && 'no Python with ElectroClean installed' }, () => {
  const spec = demoSpecs()[2];
  const truth = truthAnnotations(spec);
  const shift = (a, d) => ({ ...a, annotation_id: `m-${a.annotation_id}`, onset_sample: a.onset_sample + d });
  const cases = [
    truth.map((a) => shift(a, 10)),
    truth.slice(0, 6).map((a, i) => ({ ...shift(a, 0), label: i === 0 ? 'EMG-artifact' : a.label })).concat([ann('x', 'Chewing-artifact', 21000, 300)]),
    [ann('y', 'Eye-blink-artifact', 1000, 120), ann('z', 'Movement-artifact', 7400, 700)],
    [],
    truth.map((a, i) => ({ ...shift(a, 0), label: i % 2 ? 'Data-artifact' : a.label })),
  ].map((mine) => ({ sfreq: spec.sfreq, n_samples: spec.nSamples, ch_names: spec.channels, reference: truth, mine }));
  const res = spawnSync(PYTHON, [path.join(REPO, 'web_tests', 'practice_parity.py')], { input: JSON.stringify(cases), encoding: 'utf8', cwd: REPO });
  assert.equal(res.status, 0, res.stderr);
  const py = JSON.parse(res.stdout);
  const r3 = (v) => (v === null || Number.isNaN(v) ? null : Math.round(v * 1e6) / 1e6);
  cases.forEach((c, i) => {
    const fb = practiceFeedback(c.reference, c.mine);
    const sf = c.sfreq;
    const flags = (kind) => fb.flags.filter((f) => f.kind === kind);
    const mine = {
      event_f1: r3(fb.metrics.event_f1),
      label_accuracy: fb.metrics.found ? r3(fb.metrics.label_accuracy) : null,
      passed: fb.passed,
      missed: flags('MISSED').map((f) => [f.label, Math.round((f.onset_sample / sf) * 1000) / 1000]).sort(),
      extra: flags('EXTRA').map((f) => [f.label, Math.round((f.onset_sample / sf) * 1000) / 1000]).sort(),
      type: flags('TYPE').map((f) => [f.label, f.your_label, Math.round((f.onset_sample / sf) * 1000) / 1000]).sort(),
    };
    assert.deepEqual(mine, py[i], `case ${i + 1}`);
  });
});
