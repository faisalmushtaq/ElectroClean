// The scales of the EEG (js/viewer/scales.js): what the wheel and the trackpad do, the toolbar's time scales,
// the edges of a mark, the fine adjustment of an edge; the store's channels marked bad; and the uncertain type
// (js/catalogue.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AMPLITUDE_STEP, TIME_SCALES, edgeAt, nudgeSamples, timeScaleChoices, timeScaleText, wheelAction, wheelPixels, zoomAround } from '../../electrotag/web/static/js/viewer/scales.js';
import { AnnotationStore, AnnotationError } from '../../electrotag/web/static/js/annotate/store.js';
import { Catalogue, UNCERTAIN_LABEL, needsReview } from '../../electrotag/web/static/js/catalogue.js';
import { CATALOGUE, DEFAULT_QUICK_LABELS } from '../../electrotag/web/static/js/api/demo_catalogue.js';

const G = { plotW: 1000, durationS: 10 };
const wheel = (o) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...o });

test('the wheel alone changes the amplitude, one notch as much as one press of + or −', () => {
  const up = wheelAction(wheel({ deltaY: -100 }), G);
  assert.equal(up.kind, 'amplitude');
  assert.ok(Math.abs(up.factor - AMPLITUDE_STEP) < 1e-9);
  const down = wheelAction(wheel({ deltaY: 100 }), G);
  assert.ok(Math.abs(down.factor - 1 / AMPLITUDE_STEP) < 1e-9);
  // a flick is capped, and lines count as 30 pixels
  assert.ok(wheelAction(wheel({ deltaY: -2000 }), G).factor < AMPLITUDE_STEP ** 1.3);
  assert.equal(wheelPixels(3, 1, 1000), 90);
  assert.equal(wheelAction(wheel({}), G), null);
});

test('Shift+wheel and a sideways trackpad movement move along time; Ctrl or a pinch shows more or less; Alt moves through the channels', () => {
  assert.deepEqual(wheelAction(wheel({ deltaY: 100, shiftKey: true }), G), { kind: 'time', seconds: 1 });
  // a Mac turns Shift+wheel into deltaX
  assert.deepEqual(wheelAction(wheel({ deltaX: -50, shiftKey: true }), G), { kind: 'time', seconds: -0.5 });
  assert.deepEqual(wheelAction(wheel({ deltaX: 200, deltaY: 10 }), G), { kind: 'time', seconds: 2 });
  const out = wheelAction(wheel({ deltaY: 20, ctrlKey: true }), G);
  assert.equal(out.kind, 'zoom');
  assert.ok(out.factor > 1);
  assert.ok(wheelAction(wheel({ deltaY: -20, metaKey: true }), G).factor < 1);
  assert.deepEqual(wheelAction(wheel({ deltaY: 80, altKey: true }), G), { kind: 'channels', rows: 2 });
});

test('a pinch keeps the moment under the pointer where it is, within the recording', () => {
  const v = zoomAround({ startS: 20, durationS: 10 }, 2, 600, { x0: 100, plotW: 1000, durationTotal: 600 });
  assert.equal(v.durationS, 20);
  // the pointer was at 25 s, half way across: it is half way across again
  assert.equal(v.startS + 0.5 * v.durationS, 25);
  assert.equal(zoomAround({ startS: 0, durationS: 1 }, 0.01, 100, { x0: 100, plotW: 1000, durationTotal: 600 }).durationS, 0.5);
  assert.equal(zoomAround({ startS: 0, durationS: 300 }, 5, 100, { x0: 100, plotW: 1000, durationTotal: 600 }).durationS, 600);
});

test('the toolbar offers 1 to 60 s, the whole of a short recording, and the time shown now', () => {
  assert.deepEqual(TIME_SCALES, [1, 2, 5, 10, 20, 30, 60]);
  assert.deepEqual(timeScaleChoices(10, 600), [1, 2, 5, 10, 20, 30, 60]);
  assert.deepEqual(timeScaleChoices(14.2, 600), [1, 2, 5, 10, 14.2, 20, 30, 60]);
  assert.deepEqual(timeScaleChoices(10, 25), [1, 2, 5, 10, 20, 25]);
  assert.deepEqual(timeScaleChoices(120, 600), [1, 2, 5, 10, 20, 30, 60, 120]);
  assert.equal(timeScaleText(10), '10 s');
  assert.equal(timeScaleText(2.5), '2.5 s');
  assert.equal(timeScaleText(150), '2:30');
});

test('a mark\'s edge reaches only a little way outside it, so that a mark begun across a brief gap is a new one', () => {
  // a mark from pixel 100 to 300, with an edge of 6 pixels (the mouse)
  assert.equal(edgeAt(104, 100, 300, 6), 'start');
  assert.equal(edgeAt(98, 100, 300, 6), 'start');
  assert.equal(edgeAt(96, 100, 300, 6), null, 'four pixels before the start: a new mark');
  assert.equal(edgeAt(296, 100, 300, 6), 'end');
  assert.equal(edgeAt(302, 100, 300, 6), 'end');
  assert.equal(edgeAt(304, 100, 300, 6), null, 'four pixels after the end: a new mark, not the old one stretched');
  assert.equal(edgeAt(200, 100, 300, 6), null);
  // a finger has a wider edge, and keeps three quarters of it outside (as the viewer asks)
  assert.equal(edgeAt(114, 100, 300, 16, 12), 'start');
  assert.equal(edgeAt(89, 100, 300, 16, 12), 'start');
  assert.equal(edgeAt(87, 100, 300, 16, 12), null);
  // a narrow mark: its two edges share its width
  assert.equal(edgeAt(101, 100, 104, 6), 'start');
  assert.equal(edgeAt(103.5, 100, 104, 6), 'end');
});

test('the fine adjustment of an edge moves it by 10 ms, and at least one sample', () => {
  assert.equal(nudgeSamples(1000), 10);
  assert.equal(nudgeSamples(256), 3);
  assert.equal(nudgeSamples(50), 1);
});

const CH = ['Fp1', 'Fp2', 'C3', 'C4', 'O1', 'O2'];
const store = (opts = {}) => new AnnotationStore({ chNames: CH, nSamples: 10000, sfreq: 250, labels: CATALOGUE.labels.map((l) => l.label), ...opts });

test('channels marked bad are in recording order, undone and redone with the annotations, and kept apart from them', () => {
  const s = store({ initialBadChannels: ['O1'] });
  assert.deepEqual(s.badChannels, ['O1']);
  const seen = [];
  s.addListener((c) => seen.push(c.action));
  s.add('EMG-artifact', 100, 50);
  assert.equal(s.setChannelBad('Fp2'), true);
  assert.equal(s.setChannelBad('Fp2'), false, 'already bad: nothing happens');
  assert.deepEqual(s.badChannels, ['Fp2', 'O1']);
  assert.equal(s.undoDescription, 'mark Fp2 bad');
  assert.deepEqual(seen, ['add', 'bad_channels']);
  s.undo();
  assert.deepEqual(s.badChannels, ['O1']);
  assert.equal(s.size, 1);
  s.undo();
  assert.equal(s.size, 0);
  assert.deepEqual(s.badChannels, ['O1']);
  s.redo(); s.redo();
  assert.deepEqual(s.badChannels, ['Fp2', 'O1']);
  s.setChannelBad('O1', false);
  assert.deepEqual(s.badChannels, ['Fp2']);
  assert.throws(() => s.setChannelBad('Cz'), AnnotationError);
  assert.ok(s.isBad('Fp2') && !s.isBad('O1'));
  s.replaceAll([], 'bring back', ['C4']);
  assert.deepEqual(s.badChannels, ['C4']);
  s.undo();
  assert.deepEqual(s.badChannels, ['Fp2']);
  s.reset([], ['C3']);
  assert.deepEqual(s.badChannels, ['C3']);
  assert.equal(s.canUndo, false);
  assert.equal(JSON.stringify(s.toJSON()), '[]', 'the annotations as sent are unchanged by the bad channels');
});

test('marks with a gap between them never join; with joining off, overlapping marks stay apart too', () => {
  const s = store();
  s.add('EMG-artifact', 100, 100);
  s.add('EMG-artifact', 201, 100); // a gap of one sample
  assert.equal(s.size, 2);
  assert.equal(s.lastAutoMerged, 0);
  s.add('EMG-artifact', 150, 100);
  assert.equal(s.size, 1);
  const off = store({ autoMerge: false });
  off.add('EMG-artifact', 100, 100);
  off.add('EMG-artifact', 150, 100);
  assert.equal(off.size, 2);
});

test('Uncertain / needs review is HED\'s Data-artifact, on its own key rather than among the numbered types', () => {
  const c = new Catalogue(CATALOGUE);
  assert.equal(UNCERTAIN_LABEL, 'Data-artifact');
  assert.equal(c.uncertain.value, 130);
  assert.ok(DEFAULT_QUICK_LABELS.includes(UNCERTAIN_LABEL), 'the study\'s default keys name it');
  assert.ok(!c.quickLabels(DEFAULT_QUICK_LABELS).includes(UNCERTAIN_LABEL), 'and the toolbar gives it key 0 instead');
  assert.equal(c.quickLabels(DEFAULT_QUICK_LABELS).length, DEFAULT_QUICK_LABELS.length - 1);
  assert.ok(needsReview({ label: 'Data-artifact' }) && needsReview('Data-artifact'));
  assert.ok(!needsReview({ label: 'Eye-artifact' }) && !needsReview(null));
  assert.match(c.labelText('Data-artifact'), /uncertain \/ needs review/);
});
