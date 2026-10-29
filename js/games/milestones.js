// The milestones of the home page, drawn from the facts of GET /me/achievements (docs/web/api.md,
// "Achievements"; electroclean/web/games.py gives the facts).
//
// Milestones reward progress through the recordings and thoroughness, never speed and never the
// number of annotations: a reward for marking more would push annotators to mark artifacts they do
// not see, and the annotations are the research data (docs/design_decisions.md, "Game elements").
// Every rule here is a pure function of the facts and a date, so it is tested on its own
// (web_tests/unit/ui_milestones.test.mjs).

/** Recordings saved: the counts that earn a milestone, with its name. */
export const RECORDING_STEPS = Object.freeze([
  [1, 'First recording', 'You saved your first recording.'],
  [10, 'Ten recordings', 'Ten recordings saved.'],
  [25, 'Twenty-five recordings', 'Twenty-five recordings saved.'],
  [50, 'Fifty recordings', 'Fifty recordings saved.'],
  [100, 'One hundred recordings', 'One hundred recordings saved.'],
  [150, 'One hundred and fifty', 'One hundred and fifty recordings saved.'],
  [200, 'Two hundred recordings', 'Two hundred recordings saved.'],
  [300, 'Three hundred recordings', 'Three hundred recordings saved.'],
]);
/** Days in a row on which a recording was saved. */
export const STREAK_STEPS = Object.freeze([
  [3, 'Three days running', 'You saved recordings on three days in a row.'],
  [5, 'Five days running', 'You saved recordings on five days in a row.'],
  [10, 'Ten days running', 'You saved recordings on ten days in a row.'],
]);
/** Recordings viewed from start to end before they were saved (when the study measures what was viewed). */
export const THOROUGH_STEPS = Object.freeze([
  [5, 'Thorough', 'Five recordings viewed from start to end.'],
  [25, 'Very thorough', 'Twenty-five recordings viewed from start to end.'],
  [100, 'Every second seen', 'One hundred recordings viewed from start to end.'],
]);
/** The whole team's share of the recordings it was given. */
export const TEAM_STEPS = Object.freeze([
  [0.25, 'A quarter of the study', 'The team has finished a quarter of its recordings.'],
  [0.5, 'Half of the study', 'The team has finished half of its recordings.'],
  [0.75, 'Three quarters', 'The team has finished three quarters of its recordings.'],
  [1, 'The whole study', 'The team has finished every recording it was given.'],
]);

/** A date as the day it falls on in this browser's time zone ("2026-10-28"). */
export function localDay(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayNumber(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

/**
 * Streaks of days on which something was saved: `longest`, and `current`, the run that ends today
 * or yesterday (a streak is not lost before the day is over).
 */
export function streaks(saveTimes, now = new Date()) {
  const days = [...new Set((saveTimes || []).map(localDay).filter(Boolean))].map(dayNumber).sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i && days[i] === days[i - 1] + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const today = dayNumber(localDay(now));
  const last = days.length ? days[days.length - 1] : null;
  const current = last !== null && today - last <= 1 ? run : 0;
  return { longest, current };
}

/** The start of the week (Monday, 00:00 in this browser's time zone) of a date. */
export function weekStart(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** Recordings first saved this week (a revision is not a new recording). */
export function doneThisWeek(completions, now = new Date()) {
  const start = weekStart(now).getTime();
  const end = start + 7 * 86400000;
  return (completions || []).filter((c) => {
    const t = new Date(c.first_saved_at).getTime();
    return Number.isFinite(t) && t >= start && t < end;
  }).length;
}

/** The share of a goal reached, from 0 to 1 (0 when there is no goal). */
export function goalShare(done, goal) {
  return goal > 0 ? Math.min(1, Math.max(0, done / goal)) : 0;
}

/** The team's share of its recordings, from 0 to 1, or null when it was given none. */
export function teamShare(team) {
  return team && team.assigned > 0 ? Math.min(1, team.done / team.assigned) : null;
}

/**
 * Every milestone with whether it is reached: [{id, kind, name, text, reached, target}]. Kinds:
 * recordings, streak, thorough (only when the study measures what was viewed) and team.
 */
export function milestones(facts, now = new Date()) {
  if (!facts || !facts.enabled) return [];
  const done = (facts.counters && facts.counters.done) || 0;
  const { longest } = streaks(facts.save_times, now);
  const share = teamShare(facts.team);
  const out = [];
  for (const [n, name, text] of RECORDING_STEPS) out.push({ id: `recordings-${n}`, kind: 'recordings', name, text, target: n, reached: done >= n });
  for (const [n, name, text] of STREAK_STEPS) out.push({ id: `streak-${n}`, kind: 'streak', name, text, target: n, reached: longest >= n });
  if (facts.viewed_in_full !== null && facts.viewed_in_full !== undefined) {
    for (const [n, name, text] of THOROUGH_STEPS) {
      out.push({ id: `thorough-${n}`, kind: 'thorough', name, text, target: n, reached: facts.viewed_in_full >= n });
    }
  }
  if (share !== null) {
    for (const [f, name, text] of TEAM_STEPS) out.push({ id: `team-${Math.round(f * 100)}`, kind: 'team', name, text, target: f, reached: share >= f - 1e-9 });
  }
  return out;
}

/** The milestones reached in `after` that were not reached in `before` (what a save has just earned). */
export function newlyReached(before, after, now = new Date()) {
  const had = new Set(milestones(before, now).filter((m) => m.reached).map((m) => m.id));
  return milestones(after, now).filter((m) => m.reached && !had.has(m.id));
}

/** The next recording milestone to reach: {name, target, remaining}, or null after the last. */
export function nextRecordingStep(done) {
  const step = RECORDING_STEPS.find(([n]) => n > (done || 0));
  return step ? { name: step[1], target: step[0], remaining: step[0] - (done || 0) } : null;
}

/** Hours and minutes from seconds, for the counters ("3 h 05 min", "12 min"). */
export function hoursText(seconds) {
  const m = Math.floor((Number(seconds) || 0) / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
