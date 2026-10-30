// Correct the marks in the browser: the scoring (js/training/planted_scoring.js) against the study's own
// (electrotag/training/planted.py, through web_tests/planted_parity.py), the sandbox's ready-made
// exercise (js/api/demo_planted.js) against what the study would plant, and the admin panel's checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreCorrections, scoreMessage } from '../../electrotag/web/static/js/training/planted_scoring.js';
import { KINDS, madeText, makeBody } from '../../electrotag/web/static/js/admin/planted.js';
import { READY_MADE } from '../../electrotag/web/static/js/api/demo_planted.js';
import { demoSpecs, truthAnnotations } from '../../electrotag/web/static/js/eeg/synthetic.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function findPython() {
  for (const p of [process.env.ELECTROTAG_PYTHON, path.join(REPO, '.venv', 'bin', 'python'), 'python3']) {
    if (!p || (p.includes('/') && !fs.existsSync(p))) continue;
    const r = spawnSync(p, ['-c', 'import electrotag.training.planted'], { cwd: REPO, encoding: 'utf8' });
    if (r.status === 0) return p;
  }
  return null;
}
const PYTHON = findPython();
const python = (cases) => {
  const res = spawnSync(PYTHON, [path.join(REPO, 'web_tests', 'planted_parity.py')], { input: JSON.stringify(cases), encoding: 'utf8', cwd: REPO });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
};

const SPEC = demoSpecs().find((s) => s.id === READY_MADE.spec);
const wire = ({ annotation_id, label, onset_sample, duration_samples, channels }) => ({ annotation_id, label, onset_sample, duration_samples, channels: [...channels] });
const TRUTH = truthAnnotations(SPEC).map(wire);
const base = { sfreq: SPEC.sfreq, n_samples: SPEC.nSamples, ch_names: SPEC.channels, reference: TRUTH };

test('the sandbox\'s ready-made exercise is what the study plants from its reference', { skip: !PYTHON && 'no Python with ElectroTag installed' }, () => {
  const [p] = python([{ ...base, op: 'plant', seed: READY_MADE.seed }]);
  assert.deepEqual(p.annotations, READY_MADE.annotations);
  assert.deepEqual(p.errors, READY_MADE.errors);
  assert.deepEqual(p.made, READY_MADE.counts);
  assert.equal(p.capped, READY_MADE.capped);
});

test('the browser scores corrections as the study does', { skip: !PYTHON && 'no Python with ElectroTag installed' }, () => {
  const planted = READY_MADE.annotations;
  const errors = READY_MADE.errors;
  const nudge = (a, d) => ({ ...a, annotation_id: `n-${a.annotation_id}`, onset_sample: a.onset_sample + d });
  const mines = [
    planted, // left as it was
    TRUTH, // the experts' own
    TRUTH.slice(1).concat([{ annotation_id: 'x1', label: 'EMG-artifact', onset_sample: 100, duration_samples: 50, channels: [] }]), // one broken, one added
    TRUTH.map((a, i) => (i === 2 ? { ...a, channels: ['Cz'] } : nudge(a, i % 2 ? 30 : -10))), // channels changed, small shifts
    [], // everything deleted
    planted.filter((a) => a.label !== 'EMG-artifact').concat(TRUTH.filter((a) => a.label === 'Movement-artifact')),
  ];
  const tolerances = [undefined, { seconds: 0.5, fraction: 0.1, channel_jaccard: 0.5, accepted_labels: { 'EMG-artifact': ['Movement-artifact'] } }];
  const cases = [];
  for (const tol of tolerances) for (const mine of mines) cases.push({ ...base, op: 'score', errors, mine, planted, ...(tol ? { tolerance: tol } : {}) });
  const py = python(cases);
  cases.forEach((c, i) => {
    const tol = c.tolerance ? { ...c.tolerance } : undefined;
    const js = scoreCorrections(c.errors, c.mine, c.reference, c.sfreq, tol, c.planted);
    assert.deepEqual(js, py[i], `case ${i}`);
  });
  assert.equal(py[0].fixed, 0);
  assert.equal(py[1].fixed, errors.length);
});

test('the scoring without Python: the experts\' marks fix everything, the copy fixes nothing', () => {
  const all = scoreCorrections(READY_MADE.errors, TRUTH, TRUTH, SPEC.sfreq);
  assert.equal(all.fixed, all.n_errors);
  assert.equal(all.new_mistakes, 0);
  const none = scoreCorrections(READY_MADE.errors, READY_MADE.annotations, TRUTH, SPEC.sfreq, undefined, READY_MADE.annotations);
  assert.equal(none.fixed, 0);
  assert.equal(none.message, `You fixed 0 of ${READY_MADE.errors.length} planted mistakes.`);
  assert.equal(scoreMessage(1, 1, 2), 'You fixed 1 of 1 planted mistake. 2 new mistakes: look at the list below.');
});

test('the Make form is checked in plain words', () => {
  const ones = Object.fromEntries(KINDS.map((k) => [k, '1']));
  assert.deepEqual(makeBody('', ones), { counts: { missing: 1, type: 1, boundary: 1, extra: 1 } });
  assert.deepEqual(makeBody(' 42 ', { ...ones, extra: '3' }).seed, 42);
  assert.throws(() => makeBody('4.5', ones), /whole number from 0 to 999999/);
  assert.throws(() => makeBody('', { ...ones, type: '21' }), /Wrong type: give a whole number/);
  assert.throws(() => makeBody('', Object.fromEntries(KINDS.map((k) => [k, '0']))), /at least one/);
  assert.equal(madeText(null), 'No exercise yet.');
  assert.equal(madeText({ n_errors: 4, seed: 7, method: 'auto', made_by: 'E01', made_at: '2026-10-30T10:00:00' }),
    '4 deliberate mistakes, made from seed 7 by E01 on 2026-10-30.');
  assert.match(madeText({ n_errors: 1, method: 'from_annotations' }), /^1 deliberate mistake, made from an expert's own annotations\.$/);
});
