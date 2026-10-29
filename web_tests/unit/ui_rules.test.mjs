// The guided training rules (js/training/rules.js): the desktop's feedback, word for word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as rules from '../../electrotag/web/static/js/training/rules.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SF = 250;
const ann = (id, label, on, dur, channels = []) => ({ annotation_id: id, label, onset_sample: on, duration_samples: dur, channels });
const KEYS = { 'Eye-blink-artifact': 1, 'EMG-artifact': 3 };
const blink = ann('t1', 'Eye-blink-artifact', 750, 100, ['Fp1', 'Fp2', 'VEOG']);
const move = ann('t2', 'Movement-artifact', 6000, 500, []);

const CASES = [
  { target: blink, annotations: [] },
  { target: blink, annotations: [ann('a', 'Eye-blink-artifact', 750, 100, ['Fp1', 'Fp2', 'VEOG'])] },
  { target: blink, annotations: [ann('a', 'EMG-artifact', 750, 100, [])] },
  { target: blink, annotations: [ann('a', 'Eye-blink-artifact', 690, 110, ['Fp1', 'Fp2', 'VEOG'])] },
  { target: blink, annotations: [ann('a', 'Eye-blink-artifact', 760, 200, ['Fp1', 'Fp2', 'VEOG'])] },
  { target: blink, annotations: [ann('a', 'Eye-blink-artifact', 750, 100, ['Fp1'])] },
  { target: blink, annotations: [ann('a', 'Eye-blink-artifact', 750, 100, ['Fp1', 'Fp2', 'VEOG', 'F3', 'F4'])] },
  { target: blink, annotations: [ann('a', 'Movement-artifact', 760, 90, ['Fp1', 'Fp2', 'VEOG']), ann('b', 'Eye-blink-artifact', 745, 105, ['Fp1', 'Fp2', 'VEOG'])] },
  { target: move, annotations: [ann('a', 'Movement-artifact', 6050, 500, ['C3'])] },
  { target: move, annotations: [ann('a', 'Movement-artifact', 5990, 520, [])] },
  { target: move, annotations: [ann('a', 'Chewing-artifact', 5000, 2000, [])], quick_keys: {} },
  { target: blink, annotations: [ann('a', 'Eye-blink-artifact', 750, 100, ['Fp1', 'Fp2', 'VEOG'])], taken: ['a'] },
];

function jsChecks() {
  return CASES.map((c) => {
    const r = rules.checkStep({ index: 0, target: c.target, note: '' }, c.annotations, SF, rules.DEFAULT_TOLERANCE,
      { taken: new Set(c.taken || []), quickKeys: c.quick_keys ?? KEYS });
    return { matched: r.matched, candidate_id: r.candidate_id, problems: r.problems, messages: r.messages };
  });
}

test('feedback for the common mistakes', () => {
  const r = jsChecks();
  assert.deepEqual(r[0], { matched: false, candidate_id: null, problems: ['missing'], messages: ['Not marked yet.'] });
  assert.deepEqual(r[1].messages, ['Right type, timing and channels.']);
  assert.equal(r[2].messages[0], 'Type: the experts marked this as an Eye-blink-artifact (press 1); yours is an EMG-artifact.');
  assert.equal(r[2].messages[1], 'Channels: the experts marked this on Fp1, Fp2 and VEOG only. Right-click it and choose Edit channels…, or choose those channels (Selected channels, C) and mark it again.');
  assert.deepEqual(r[3].messages, ['Almost: the start is 0.24 s too early. Drag the left edge to move it.']);
  assert.equal(r[4].messages[0], 'Almost: the end is 0.44 s too late. Drag the right edge to move it.');
  assert.match(r[5].messages[0], /^Channels: the experts marked this on Fp1, Fp2 and VEOG; Fp2 and VEOG are missing\. Shift\+click/);
  assert.match(r[6].messages[0], /F3 and F4 are not part of it/);
  assert.equal(r[7].candidate_id, 'b'); // of the right type first
  assert.equal(r[8].messages[0], 'Channels: the experts marked this on the whole montage. Right-click it and choose Apply to whole montage, or switch to Whole montage (C) and mark it again.');
  assert.deepEqual(r[9].messages, ['Right type and timing.']);
  assert.match(r[10].messages[0], /\(press \/ and type its name\)/);
  assert.deepEqual(r[11].problems, ['missing']); // an annotation already used for another step does not count
});

// A Python that can import ElectroTag: $ELECTROTAG_PYTHON, the repository's .venv, or python3.
function findPython() {
  for (const p of [process.env.ELECTROTAG_PYTHON, path.join(REPO, '.venv', 'bin', 'python'), 'python3']) {
    if (!p || (p.includes('/') && !fs.existsSync(p))) continue;
    const r = spawnSync(p, ['-c', 'import electrotag.training.guided'], { cwd: REPO, encoding: 'utf8' });
    if (r.status === 0) return p;
  }
  return null;
}
const PYTHON = findPython();

test('the same feedback as the desktop application (Python)', { skip: !PYTHON && 'no Python with ElectroTag installed' }, () => {
  const python = PYTHON;
  const input = JSON.stringify(CASES.map((c) => ({ ...c, sfreq: SF, quick_keys: c.quick_keys ?? KEYS })));
  const res = spawnSync(python, [path.join(REPO, 'web_tests', 'guided_parity.py')], { input, encoding: 'utf8', cwd: REPO });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(jsChecks(), JSON.parse(res.stdout));
});

test('extra annotations and their messages', () => {
  const steps = rules.buildSteps([blink, move]);
  const anns = [ann('a', 'Eye-blink-artifact', 750, 100, ['Fp1', 'Fp2', 'VEOG']), ann('b', 'Eye-blink-artifact', 760, 80, []), ann('c', 'EMG-artifact', 0, 50, [])];
  const current = rules.checkStep(steps[0], anns, SF);
  const ex = rules.extras(steps, anns, {}, current, 0);
  assert.deepEqual(ex.map((a) => a.annotation_id), ['b', 'c']);
  assert.match(rules.extraMessage(ex[0], steps, SF), /^You have marked this artifact twice \(Eye-blink-artifact, 3\.04–3\.36 s\): delete the extra one/);
  assert.match(rules.extraMessage(ex[1], steps, SF), /^Nothing is marked at 0\.00–0\.20 s in the experts' annotations: delete this EMG-artifact \(it is selected; press Delete\) or press (Ctrl|⌘)\+Z to undo\.$/);
});

test('stars, instructions and step text', () => {
  assert.equal(rules.starsFor(0, false), 3);
  assert.equal(rules.starsFor(2, false), 2);
  assert.equal(rules.starsFor(3, false), 1);
  assert.equal(rules.starsFor(0, true), 1);
  assert.equal(rules.instruction('EMG-artifact', 'show'), 'Mark this EMG-artifact');
  assert.equal(rules.instruction('EMG-artifact', 'find'), 'Find the EMG-artifact on this screen');
  assert.equal(rules.instruction(null, 'find_unnamed'), 'Find the next artifact');
  assert.match(rules.stepBody('show', 'EMG-artifact', ['T7', 'T8'], KEYS), /Choose its type \(press \*\*3\*\*\), choose T7 and T8 \(Selected channels/);
  assert.match(rules.stepBody('find', 'Movement-artifact', [], KEYS), /^There is a Movement-artifact somewhere on this screen\. Choose its type \(press \*\*\/\*\* and type its name\)/);
});
