// Touch on the EEG (js/viewer/touch.js): two fingers move and pinch the view, taps and edges.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EDGE_PX_PEN, EDGE_PX_TOUCH, MIN_PINCH_SPAN, PINCH_DEAD_PX, edgePx, isDoubleTap, pinchView, twoFingers } from '../../electrotag/web/static/js/viewer/touch.js';

const G = { x0: 100, plotW: 1000, rowH: 20, durationTotal: 70 };
const start = (cx, cy, spanX, view = { startS: 10, durationS: 10, firstChannel: 4 }) =>
  ({ cx, cy, spanX, view, tAtC: view.startS + ((cx - G.x0) / G.plotW) * view.durationS });

test('two fingers: their centre and spread', () => {
  assert.deepEqual(twoFingers({ x: 100, y: 50 }, { x: 300, y: 70 }), { cx: 200, cy: 60, spanX: 200 });
});

test('two fingers moving together carry the time under them and keep the time shown', () => {
  const s = start(600, 200, 300);
  const v = pinchView(s, { cx: 400, cy: 200, spanX: 303 }, G); // a spread that wavers a little is still a move
  assert.equal(v.durationS, 10);
  assert.equal(v.startS + ((400 - G.x0) / G.plotW) * v.durationS, s.tAtC, 'the moment under the fingers stays under them');
  assert.equal(v.startS, 12);
  assert.equal(v.firstChannel, 4);
});

test('two fingers up and down move through the channels, a row at a time', () => {
  assert.equal(pinchView(start(600, 200, 300), { cx: 600, cy: 140, spanX: 300 }, G).firstChannel, 7);
  assert.equal(pinchView(start(600, 200, 300), { cx: 600, cy: 251, spanX: 300 }, G).firstChannel, 1);
});

test('a pinch shows more or less time about the moment between the fingers, within the recording', () => {
  const s = start(600, 200, 200);
  const closer = pinchView(s, { cx: 600, cy: 200, spanX: 400 }, G);
  assert.equal(closer.durationS, 5);
  assert.equal(closer.startS + 0.5 * closer.durationS, s.tAtC);
  assert.equal(pinchView(s, { cx: 600, cy: 200, spanX: 100 }, G).durationS, 20);
  assert.equal(pinchView(s, { cx: 600, cy: 200, spanX: 4000 }, G).durationS, 0.5, 'no less than half a second');
  assert.equal(pinchView(s, { cx: 600, cy: 200, spanX: MIN_PINCH_SPAN }, { ...G, durationTotal: 30 }).durationS, 30, 'no more than the recording');
  assert.equal(pinchView(start(600, 200, MIN_PINCH_SPAN - 1), { cx: 600, cy: 200, spanX: 300 }, G).durationS, 10, 'fingers too close together only move');
  assert.equal(pinchView(s, { cx: 600, cy: 200, spanX: 200 + PINCH_DEAD_PX - 1 }, G).durationS, 10, 'a spread within the dead zone only moves');
});

test('a double tap is two taps close in time and place', () => {
  const a = { x: 100, y: 100, t: 1000 };
  assert.equal(isDoubleTap(a, { x: 110, y: 105, t: 1250 }), true);
  assert.equal(isDoubleTap(a, { x: 110, y: 105, t: 1500 }), false);
  assert.equal(isDoubleTap(a, { x: 160, y: 100, t: 1100 }), false);
  assert.equal(isDoubleTap(null, a), false);
});

test('a finger and a pencil find an annotation\'s edge from further away than the mouse', () => {
  assert.equal(edgePx('mouse', 6), 6);
  assert.equal(edgePx('touch', 6), EDGE_PX_TOUCH);
  assert.equal(edgePx('pen', 6), EDGE_PX_PEN);
  assert.ok(EDGE_PX_TOUCH > EDGE_PX_PEN && EDGE_PX_PEN > 6);
});
