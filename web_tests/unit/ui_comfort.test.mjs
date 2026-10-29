// Comfort for long sessions, the pure parts: the working-time clock that stops while paused
// (js/annotate/clock.js) and each annotator's display comfort (js/ui/comfort.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BREAK_MIN_S, SNOOZE_S, WorkClock, idleDue, todayKey } from '../../electrotag/web/static/js/annotate/clock.js';
import { DEFAULT_COMFORT, MIN_NAME_PX, nameEvery, namePx, normaliseComfort, traceWidths } from '../../electrotag/web/static/js/ui/comfort.js';

/** A clock whose time (milliseconds) the test moves by hand. */
function fakeClock(o = {}) {
  let t = 1000;
  const c = new WorkClock({ ...o, now: () => t });
  return { c, wait: (s) => { t += s * 1000; }, at: () => t };
}

// ------------------------------------------------------------------ the clock

test('the clock counts the time open, and stops while paused', () => {
  const { c, wait } = fakeClock({ baseS: 100 });
  wait(30);
  assert.equal(c.elapsedS, 130, 'a restored draft\'s time comes first');
  assert.deepEqual(c.pause('button'), { reason: 'button', at: 31000, elapsedS: 130 });
  assert.equal(c.paused, true);
  assert.equal(c.pause('key'), null, 'a second pause changes nothing');
  wait(600);
  assert.equal(c.elapsedS, 130, 'stopped');
  assert.equal(c.pausedForS, 600);
  assert.equal(c.pauseReason, 'button');
  const r = c.resume();
  assert.deepEqual(r, { reason: 'button', pausedS: 600, isBreak: true });
  assert.equal(c.resume(), null);
  wait(5);
  assert.equal(c.elapsedS, 135);
  assert.equal(c.pausedTotalS, 600);
  assert.equal(c.nPauses, 1);
});

test('a pause can start earlier (the page hidden since then), never before the clock last ran', () => {
  const { c, wait, at } = fakeClock();
  wait(20);
  const hiddenAt = at();
  wait(15);
  c.pause('hidden', hiddenAt);
  assert.equal(c.elapsedS, 20, 'the 15 s out of sight are not counted');
  wait(5);
  assert.equal(c.resume().pausedS, 20);
  wait(1);
  c.pause('hidden', 0);
  assert.equal(c.elapsedS, 20, 'a pause from long ago starts no earlier than the resume');
});

test('the break reminder: due after the interval of work, put off by Remind me later, reset by a break', () => {
  const { c, wait } = fakeClock({ sinceBreakS: 600 });
  assert.equal(c.breakDue(0), false, '0 turns reminders off');
  wait(2399);
  assert.equal(c.breakDue(3000), false);
  wait(1);
  assert.equal(c.breakDue(3000), true, 'work carried over from the recording before counts');
  c.snooze();
  assert.equal(c.breakDue(3000), false);
  wait(SNOOZE_S - 1);
  assert.equal(c.breakDue(3000), false);
  wait(1);
  assert.equal(c.breakDue(3000), true);
  // A short pause is no break; one of at least BREAK_MIN_S is.
  c.pause('button');
  assert.equal(c.breakDue(3000), false, 'never while paused');
  wait(BREAK_MIN_S - 1);
  assert.equal(c.resume().isBreak, false);
  assert.equal(c.breakDue(3000), true);
  c.pause('button');
  wait(BREAK_MIN_S);
  assert.equal(c.resume().isBreak, true);
  assert.equal(c.sinceBreakS, 0);
  assert.equal(c.breakDue(3000), false);
  wait(3000);
  assert.equal(c.breakDue(3000), true, 'the study\'s interval again after a break');
  c.pause('break');
  wait(1);
  assert.equal(c.resume().isBreak, true, 'Take a break counts as a break however short');
  assert.equal(c.sinceBreakS, 0);
});

test('a pause after a while without input, and today\'s key', () => {
  assert.equal(idleDue(179999, 3), false);
  assert.equal(idleDue(180000, 3), true);
  assert.equal(idleDue(1e9, 0), false, '0 never pauses');
  assert.equal(todayKey('A01', new Date(2026, 0, 5, 23, 59)), 'electrotag.worked|A01|2026-01-05');
});

// ------------------------------------------------------------ display comfort

test('display comfort: unknown choices fall back, traces and names in whole pixels', () => {
  assert.deepEqual(normaliseComfort(null), DEFAULT_COMFORT);
  assert.deepEqual(normaliseComfort({ trace: 'thick', names: 'huge', panel: 'large', toString: 'x' }), { trace: 'thick', names: 'normal', panel: 'large' });
  assert.deepEqual(normaliseComfort({ trace: 'constructor' }), DEFAULT_COMFORT);
  assert.deepEqual(traceWidths('normal', 2), { device: 2, css: 1 });
  assert.deepEqual(traceWidths('thin', 2), { device: 1, css: 0.6 });
  assert.deepEqual(traceWidths('thick', 2), { device: 4, css: 2 });
  assert.equal(traceWidths('thick', 1).device, 2);
  assert.equal(traceWidths('normal', 1, true).css, 0.6);
  for (const rowH of [4, 8, 12, 20, 40]) {
    assert.ok(Number.isInteger(namePx('normal', rowH)) && Number.isInteger(namePx('large', rowH)));
    assert.ok(namePx('large', rowH) >= namePx('normal', rowH));
  }
  assert.equal(namePx('normal', 40), 12);
  assert.equal(namePx('large', 40), 15);
});

test('channel names are never drawn below 11 pixels (13 when large): short rows name every second or third channel', () => {
  for (const rowH of [2, 4, 5.5, 8.9, 12, 20]) {
    assert.ok(namePx('normal', rowH) >= MIN_NAME_PX.normal && namePx('normal', rowH) <= 12);
    assert.ok(namePx('large', rowH) >= MIN_NAME_PX.large && namePx('large', rowH) <= 15);
    // the names drawn are at least a name's height apart
    const every = nameEvery(namePx('normal', rowH), rowH);
    assert.ok(every * rowH >= namePx('normal', rowH) - 1, `rows of ${rowH} px: every ${every}`);
  }
  assert.equal(nameEvery(12, 20), 1, 'rows tall enough: every channel is named');
  assert.equal(nameEvery(11, 8.9), 2, '22 channels on a short screen: every second');
  assert.equal(nameEvery(11, 5), 2);
  assert.equal(nameEvery(11, 3), 4, '128 channels on a laptop: every fourth');
});
