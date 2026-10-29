// The guided training rules (js/training/rules.js): the desktop's feedback, word for word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as rules from '../../electrotag/web/static/js/training/rules.js';
import { demoSpecs, exampleNote } from '../../electrotag/web/static/js/data/synthetic.js';

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
  { target: blink, annotations: [ann('a', 'Eye-blink-artifact', 750, 100, ['Fp1', 'F3'])] },
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
  assert.equal(r[2].messages[0], 'Type: the experts marked this as an Eye-blink-artifact; yours is an EMG-artifact. Click your annotation to select it, then press 1 to change its type.');
  assert.equal(r[2].messages[1], 'Channels: the experts marked this on Fp1, Fp2 and VEOG only. Right-click your annotation, choose Edit channels…, then choose Only these channels and tick Fp1, Fp2 and VEOG.');
  // each line names what is wrong and which way to drag, without "Almost" for a large error
  assert.deepEqual(r[3].messages, ['Start: 0.24 s too early. Drag the left edge of your annotation to the right.']);
  assert.equal(r[4].messages[0], 'End: 0.44 s too late. Drag the right edge of your annotation to the left.');
  // Shift+click on a channel inside an annotation takes it off; adding one needs Edit channels…
  assert.equal(r[5].messages[0], 'Channels: the experts marked this on Fp1, Fp2 and VEOG; Fp2 and VEOG are missing. Right-click your annotation, choose Edit channels… and tick Fp2 and VEOG.');
  assert.equal(r[6].messages[0], 'Channels: the experts marked this on Fp1, Fp2 and VEOG; F3 and F4 are not part of it. Hold Shift and click your annotation on F3 and F4 to take them off (or right-click it and choose Edit channels…).');
  assert.equal(r[7].candidate_id, 'b'); // of the right type first
  // an annotation already there cannot be drawn again over itself (a drag at its edge moves the edge), so no "mark it again"
  assert.equal(r[8].messages[0], 'Channels: the experts marked this on the whole montage. Right-click your annotation and choose Apply to whole montage.');
  for (const c of r) for (const m of c.messages) assert.doesNotMatch(m, /mark it again|^Almost/);
  assert.deepEqual(r[9].messages, ['Right type and timing.']);
  assert.match(r[10].messages[0], /then press \/ and choose Movement-artifact\.$/);
  assert.match(r[12].messages[0], /; Fp2 and VEOG are missing; F3 is not part of it\. Right-click your annotation, choose Edit channels…, tick Fp2 and VEOG and untick F3\.$/);
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

const STEP_CASES = [
  { guidance: 'show', label: 'Eye-blink-artifact', channels: ['Fp1', 'Fp2', 'VEOG'], quick_keys: KEYS },
  { guidance: 'show', label: 'Electrode-pops-artifact', channels: ['C3'], quick_keys: KEYS },
  { guidance: 'show', label: 'Movement-artifact', channels: [], quick_keys: KEYS },
  { guidance: 'find', label: 'EMG-artifact', channels: ['T7', 'T8'], quick_keys: KEYS },
  { guidance: 'find', label: 'Chewing-artifact', channels: ['T7', 'T8'], quick_keys: {} },
  { guidance: 'find_unnamed', label: null, channels: [], quick_keys: KEYS },
];
// every artifact of the demonstration's example recordings
const NOTE_CASES = demoSpecs().flatMap((s) => s.artifacts.map((a) => ({ label: a.label, duration_s: a.durationS, channels: s.channels.filter((c) => a.channels.includes(c)) })))
  .concat([{ label: 'Line-noise-artifact', duration_s: 3, channels: [] }, { label: 'Eye-artifact', duration_s: 1, channels: ['Fp1'] }]);

test('the same feedback, step texts and notes as the Python rules', { skip: !PYTHON && 'no Python with ElectroTag installed' }, () => {
  const python = PYTHON;
  const input = JSON.stringify({ checks: CASES.map((c) => ({ ...c, sfreq: SF, quick_keys: c.quick_keys ?? KEYS })), steps: STEP_CASES, notes: NOTE_CASES });
  const res = spawnSync(python, [path.join(REPO, 'web_tests', 'guided_parity.py')], { input, encoding: 'utf8', cwd: REPO });
  assert.equal(res.status, 0, res.stderr);
  const py = JSON.parse(res.stdout);
  assert.deepEqual(jsChecks(), py.checks);
  assert.deepEqual(STEP_CASES.map((c) => rules.stepBody(c.guidance, c.label, c.channels, c.quick_keys)), py.steps);
  assert.deepEqual(NOTE_CASES.map((c) => exampleNote(c.label, c.duration_s, c.channels)), py.notes);
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
  // each step says what to do with the actual controls: the type key or button, the channels, the drag
  const blinkStep = rules.stepBody('show', 'Eye-blink-artifact', ['Fp1', 'Fp2', 'VEOG'], KEYS).split('\n');
  assert.equal(blinkStep.length, 4);
  assert.equal(blinkStep[1], '1. Press **1** (or click **1** next to Draw as) to choose Eye-blink-artifact.');
  assert.match(blinkStep[2], /^2\. Make sure \*\*Selected channels\*\* is chosen in the toolbar \(click it, or press \*\*C\*\* to switch\), then click the channel names Fp1, Fp2 and VEOG at the left of the EEG\./);
  assert.match(blinkStep[3], /^3\. Drag across the EEG from the start of the outline to its end/);
  assert.match(rules.stepBody('show', 'Movement-artifact', [], KEYS), /2\. Make sure \*\*Whole montage\*\* is chosen/);
  assert.match(rules.stepBody('find', 'Movement-artifact', [], KEYS), /^There is a Movement-artifact somewhere on this screen\. Find it, then mark it:\n1\. Press \*\*\/\*\*, type Movement-artifact and press \*\*Enter\*\*/);
  assert.doesNotMatch(rules.stepBody('find_unnamed', null, [], KEYS), /[A-Z][a-z]+-artifact/, 'an unnamed step does not name the type');
});

test('the example notes explain the artifact to trainees, without an authoring hint', () => {
  const note = exampleNote('Horizontal-eye-movement-artifact', 1.2, ['Fp1', 'Fp2', 'F7', 'F8', 'HEOG']);
  assert.match(note, /^Simulated example\. A look to the side/);
  assert.match(note, /horizontal EOG and at F7 and F8/);
  assert.match(note, /mark it on Fp1, Fp2, F7, F8 and HEOG\.$/);
  for (const c of NOTE_CASES) assert.doesNotMatch(exampleNote(c.label, c.duration_s, c.channels), /[Pp]laceholder|Replace it|your experts/);
});

test('on a touch screen the coach speaks of taps, press and hold and the buttons on screen', () => {
  const texts = [
    ...STEP_CASES.map((c) => rules.stepBody(c.guidance, c.label, c.channels, c.quick_keys)),
    ...jsChecks().flatMap((c) => c.messages),
    // the study server's undo hint, and the extra-annotation messages
    "Nothing is marked at 0.00–0.20 s in the experts' annotations: delete this EMG-artifact (it is selected; press Delete) or press Ctrl+Z (⌘Z on a Mac) to undo.",
    'You have marked this artifact twice (EMG-artifact, 0.00–0.20 s): delete the extra one (select it and press Delete) or press ⌘+Z to undo.',
    'Right type, timing and channels. Press **Continue** (Enter) for the next one.',
  ];
  for (const t of texts) {
    const touch = rules.touchWords(t);
    assert.doesNotMatch(touch, /right-click|Shift|Ctrl|⌘|\bclick\b|Press \*\*\d|\*\*[MC/]\*\*|arrow|press Delete|Enter/i, touch);
  }
  assert.equal(rules.touchWords('1. Press **1** (or click **1** next to Draw as) to choose Eye-blink-artifact.'), '1. Tap **1** next to Draw as to choose Eye-blink-artifact.');
  assert.match(rules.touchWords(jsChecks()[6].messages[0]), /Press and hold your annotation, choose Edit channels… and untick F3 and F4\.$/);
});
