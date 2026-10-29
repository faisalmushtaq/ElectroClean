// The milestones of the home page (js/games/milestones.js): progress and thoroughness earn them,
// never speed or the number of annotations.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECORDING_STEPS, doneThisWeek, goalShare, hoursText, localDay, milestones, newlyReached, nextRecordingStep, streaks,
  teamShare, weekStart,
} from '../../electroclean/web/static/js/games/milestones.js';

const NOW = new Date(2026, 9, 28, 15, 0); // Wednesday 28 October 2026, 15:00 local time
const at = (y, m, d, hh = 10) => new Date(y, m - 1, d, hh).toISOString();
const facts = (over = {}) => ({
  enabled: true, counters: { done: 0, assigned: 300, worked_s: 0, annotations: 0 }, completions: [], save_times: [],
  viewed_in_full: null, team: { done: 0, assigned: 0, people: 0 }, ...over,
});
const reached = (f) => milestones(f, NOW).filter((m) => m.reached).map((m) => m.id);

test('recordings: the first, then 10, 25, 50, 100, 150, 200 and 300', () => {
  assert.deepEqual(RECORDING_STEPS.map(([n]) => n), [1, 10, 25, 50, 100, 150, 200, 300]);
  assert.deepEqual(reached(facts()), []);
  assert.deepEqual(reached(facts({ counters: { done: 1 } })), ['recordings-1']);
  assert.deepEqual(reached(facts({ counters: { done: 26 } })), ['recordings-1', 'recordings-10', 'recordings-25']);
  assert.equal(reached(facts({ counters: { done: 300 } })).length, 8);
  for (const m of milestones(facts(), NOW)) assert.ok(m.name && m.text && !/annotation/i.test(m.text), m.id);
});

test('the number of annotations and the time taken earn nothing', () => {
  const few = facts({ counters: { done: 10, worked_s: 600, annotations: 3 } });
  const many = facts({ counters: { done: 10, worked_s: 60, annotations: 30000 } });
  assert.deepEqual(reached(few), reached(many));
  const slow = facts({ counters: { done: 10, worked_s: 360000, annotations: 3 } });
  assert.deepEqual(reached(slow), reached(few));
});

test('streaks count days in a row in this browser\'s time zone, and the current one lasts until the day is over', () => {
  assert.deepEqual(streaks([], NOW), { longest: 0, current: 0 });
  const three = [at(2026, 10, 26), at(2026, 10, 26, 18), at(2026, 10, 27), at(2026, 10, 28)];
  assert.deepEqual(streaks(three, NOW), { longest: 3, current: 3 });
  // ended yesterday: still current today
  assert.deepEqual(streaks(three.slice(0, 3), NOW), { longest: 2, current: 2 });
  // a gap breaks it; the longest is kept
  const gap = [at(2026, 10, 1), at(2026, 10, 2), at(2026, 10, 3), at(2026, 10, 4), at(2026, 10, 27)];
  assert.deepEqual(streaks(gap, NOW), { longest: 4, current: 1 });
  assert.deepEqual(streaks([at(2026, 10, 20)], NOW), { longest: 1, current: 0 });
  // across the end of a month
  assert.equal(streaks([at(2026, 9, 30), at(2026, 10, 1), at(2026, 10, 2)], NOW).longest, 3);
  assert.deepEqual(reached(facts({ save_times: three })), ['streak-3']);
  assert.equal(localDay('not a date'), null);
});

test('thoroughness counts only when the study measures what was viewed', () => {
  assert.ok(!milestones(facts(), NOW).some((m) => m.kind === 'thorough'));
  const f = facts({ viewed_in_full: 6 });
  assert.deepEqual(milestones(f, NOW).filter((m) => m.kind === 'thorough').map((m) => [m.target, m.reached]),
    [[5, true], [25, false], [100, false]]);
});

test('the team\'s share of the study: a quarter, a half, three quarters and all of it', () => {
  assert.equal(teamShare({ done: 0, assigned: 0 }), null);
  assert.ok(!milestones(facts(), NOW).some((m) => m.kind === 'team'));
  assert.deepEqual(reached(facts({ team: { done: 450, assigned: 900 } })), ['team-25', 'team-50']);
  assert.equal(reached(facts({ team: { done: 900, assigned: 900 } })).length, 4);
  assert.equal(teamShare({ done: 10, assigned: 4 }), 1);
});

test('what a save has just earned', () => {
  const before = facts({ counters: { done: 9 }, team: { done: 224, assigned: 900 } });
  const after = facts({ counters: { done: 10 }, team: { done: 225, assigned: 900 } });
  assert.deepEqual(newlyReached(before, after, NOW).map((m) => m.id), ['recordings-10', 'team-25']);
  assert.deepEqual(newlyReached(after, after, NOW), []);
  // a revision changes no count, so it earns nothing
  assert.deepEqual(newlyReached(after, { ...after, counters: { ...after.counters, annotations: 99 } }, NOW), []);
  assert.deepEqual(milestones({ enabled: false }, NOW), []);
});

test('the personal goal: recordings first saved this week, Monday to Sunday', () => {
  assert.equal(weekStart(NOW).getDay(), 1);
  assert.equal(localDay(weekStart(NOW)), '2026-10-26');
  const completions = [{ first_saved_at: at(2026, 10, 25, 23) }, { first_saved_at: at(2026, 10, 26, 9) },
    { first_saved_at: at(2026, 10, 28) }, { first_saved_at: null }];
  assert.equal(doneThisWeek(completions, NOW), 2);
  assert.equal(goalShare(2, 8), 0.25);
  assert.equal(goalShare(12, 8), 1);
  assert.equal(goalShare(3, null), 0);
});

test('the next step and the hours worked', () => {
  assert.deepEqual(nextRecordingStep(0), { name: 'First recording', target: 1, remaining: 1 });
  assert.deepEqual(nextRecordingStep(12), { name: 'Twenty-five recordings', target: 25, remaining: 13 });
  assert.equal(nextRecordingStep(300), null);
  assert.equal(hoursText(59), '0 min');
  assert.equal(hoursText(754), '12 min');
  assert.equal(hoursText(3 * 3600 + 5 * 60), '3 h 05 min');
});
