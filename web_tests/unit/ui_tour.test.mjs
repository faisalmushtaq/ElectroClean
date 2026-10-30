// The platform tour's rules (js/training/tour.js): its practice recording and the artifacts it points
// at, the words of each step (which name the keys and controls, as the guided coach does, and become
// taps on a touch screen), and when each step counts as done. The tour in the browser is
// web_tests/e2e/c_training.e2e.mjs ("the platform tour").
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOUR_SPEC, overlapShare, stepBody, stepDone, tourSteps, tourTargets } from '../../electrotag/web/static/js/training/tour.js';
import { touchWords } from '../../electrotag/web/static/js/training/rules.js';
import { makeSyntheticRecording, truthAnnotations } from '../../electrotag/web/static/js/eeg/synthetic.js';

const QUICK = { 'Eye-blink-artifact': 1, 'Horizontal-eye-movement-artifact': 2, 'EMG-artifact': 3 };
const obs = (over = {}) => ({ annotations: [], startS: 0, maxStartS: 0, undone: false, redone: false, saved: false, ...over });
const ann = (label, onset, dur, channels = [], extra = {}) => ({ annotation_id: `${label}-${onset}`, label, onset_sample: onset, duration_samples: dur, channels, ...extra });

test('the tour\'s recording holds the artifacts its steps point at', () => {
  const rec = makeSyntheticRecording(TOUR_SPEC);
  assert.equal(rec.durationS, 30);
  const { blink, muscle } = tourTargets(rec.sfreq);
  assert.deepEqual(blink, { label: 'Eye-blink-artifact', onset_sample: 1625, duration_samples: 100, channels: ['Fp1', 'Fp2', 'VEOG'] });
  assert.deepEqual(muscle, { label: 'EMG-artifact', onset_sample: 2000, duration_samples: 375, channels: ['T7', 'T8'] });
  const truth = truthAnnotations(TOUR_SPEC);
  assert.deepEqual(truth.slice(0, 2).map((a) => [a.label, a.onset_sample, a.duration_samples]),
    [[blink.label, blink.onset_sample, blink.duration_samples], [muscle.label, muscle.onset_sample, muscle.duration_samples]]);
  // both are on the first screen (10 s), where the tour shows them, after the filters' edge zone (about 5 s)
  assert.ok((muscle.onset_sample + muscle.duration_samples) / rec.sfreq < 10);
  assert.ok(blink.onset_sample / rec.sfreq >= 6);
});

test('six steps, each naming the keys and controls to use', () => {
  const steps = tourSteps({ quickKeys: QUICK });
  assert.deepEqual(steps.map((s) => s.key), ['move', 'mark', 'channels', 'undo', 'confidence', 'save']);
  const [move, mark, channels, undo, confidence, save] = steps;
  assert.match(move.body, /Press the \*\*right arrow\*\* key/);
  assert.match(mark.body, /^1\. Press \*\*1\*\* \(or click \*\*1\*\* next to Draw as\) to choose Eye-blink-artifact\.$/m);
  assert.match(mark.body, /^2\. Make sure \*\*Whole montage\*\* is chosen in the toolbar/m);
  assert.match(channels.body, /^1\. Press \*\*3\*\* \(or click \*\*3\*\* next to Draw as\) to choose EMG-artifact\.$/m);
  assert.match(channels.body, /click the channel names T7 and T8 at the left of the EEG/);
  assert.match(undo.body, /\*\*Ctrl\+Z\*\* \(\*\*⌘Z\*\* on a Mac\), or click \*\*Undo\*\* at the top, to take back your last change: your EMG-artifact goes\./);
  assert.match(undo.body, /^2\. Press \*\*Ctrl\+Y\*\*, or click \*\*Redo\*\*, to bring it back\.$/m);
  assert.match(confidence.body, /Press \*\*D\*\*, then a number from \*\*1\*\* \(not at all sure\) to \*\*5\*\* \(completely sure\)/);
  assert.match(save.body, /press \*\*Save and Finish\*\* at the top right/);
  assert.equal(mark.ghost.label, 'Eye-blink-artifact');
  assert.deepEqual(channels.ghost.channels, ['T7', 'T8']);
  // a type without a number key is chosen by its name
  assert.match(tourSteps({ quickKeys: {} })[1].body, /Press \*\*\/\*\*, type Eye-blink-artifact and press \*\*Enter\*\* to choose it\./);
  // on a touch screen: taps
  assert.match(touchWords(mark.body), /^1\. Tap \*\*1\*\* next to Draw as to choose Eye-blink-artifact\.$/m);
  assert.match(touchWords(channels.body), /then tap the channel names T7 and T8/);
  assert.equal(stepBody(mark, true), touchWords(mark.body));
});

test('on a touch screen every step is in taps: no keys, no clicks', () => {
  const steps = tourSteps({ quickKeys: QUICK });
  for (const st of steps) {
    const words = stepBody(st, true);
    assert.doesNotMatch(words, /\bPress\b|\bpress \*\*|\bkey\b|Ctrl|⌘|\bclick|\bClick/, `${st.key}: ${words}`);
    assert.equal(stepBody(st, false), st.body);
  }
  const [move, , , undo, confidence, save] = steps;
  assert.match(stepBody(move, true), /beside \*\*Time\*\*, tap the last arrow \(\*\*Forward a screen\*\*\)/);
  assert.match(stepBody(undo, true), /Tap \*\*Undo\*\* at the top.*\n2\. Tap \*\*Redo\*\*/s);
  assert.match(stepBody(confidence, true), /tap a number for \*\*Confidence\*\*.*Pressing and holding the mark/s);
  assert.match(stepBody(save, true), /tap \*\*Save and Finish\*\*/);
});

test('a step is done by what the annotation view shows, not by pressing Next', () => {
  const [move, mark, channels, undo, confidence, save] = tourSteps({ quickKeys: QUICK });
  const { blink, muscle } = tourTargets();
  assert.equal(stepDone(move, obs()), false);
  assert.equal(stepDone(move, obs({ maxStartS: 2.5, startS: 2.5 })), false, 'moved on, not yet back');
  assert.equal(stepDone(move, obs({ maxStartS: 2.5, startS: 0 })), true);
  assert.equal(stepDone(mark, obs({ annotations: [ann('Eye-blink-artifact', 1620, 110)] })), true);
  assert.equal(stepDone(mark, obs({ annotations: [ann('EMG-artifact', 1620, 110)] })), false, 'the right type');
  assert.equal(stepDone(mark, obs({ annotations: [ann('Eye-blink-artifact', 3000, 100)] })), false, 'on the outlined blink');
  assert.equal(stepDone(channels, obs({ annotations: [ann('EMG-artifact', muscle.onset_sample, muscle.duration_samples, [])] })), false, 'on its channels');
  assert.equal(stepDone(channels, obs({ annotations: [ann('EMG-artifact', muscle.onset_sample + 20, 340, ['T7', 'T8'])] })), true);
  assert.equal(stepDone(undo, obs()), false);
  assert.equal(stepDone(undo, obs({ undone: true })), false, 'taken back, not yet brought back');
  assert.equal(stepDone(undo, obs({ undone: true, redone: true })), true);
  assert.equal(stepDone(confidence, obs({ annotations: [ann(blink.label, blink.onset_sample, blink.duration_samples)] })), false);
  assert.equal(stepDone(confidence, obs({ annotations: [ann(blink.label, blink.onset_sample, blink.duration_samples, [], { confidence: 4 })] })), true);
  assert.equal(stepDone(save, obs({ saved: true })), true);
});

test('the overlap of a mark with the outlined artifact', () => {
  const target = { onset_sample: 100, duration_samples: 100 };
  assert.equal(overlapShare({ onset_sample: 100, duration_samples: 100 }, target), 1);
  assert.equal(overlapShare({ onset_sample: 150, duration_samples: 100 }, target), 50 / 150);
  assert.equal(overlapShare({ onset_sample: 300, duration_samples: 10 }, target), 0);
});
