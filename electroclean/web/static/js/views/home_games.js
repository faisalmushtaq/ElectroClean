// The game elements of the home page, drawn from GET /me/achievements (app.achievements): the
// counters, the personal goal for the week, the team's progress, the milestones and the anonymised
// leaderboard, and a short celebration of a milestone reached by the last Save and Finish.
//
// What is rewarded is progress through the recordings and thoroughness, never speed and never the
// number of annotations (docs/design_decisions.md, "Game elements"): the number of annotations is
// shown for interest only and nothing ranks or rewards it. A study switches all of this off with
// gamification.enabled, and the leaderboard alone with gamification.leaderboard.

import { h, clear } from '../ui/dom.js';
import { logger } from '../log/logger.js';
import {
  doneThisWeek, goalShare, hoursText, milestones, nextRecordingStep, streaks, teamShare,
} from '../games/milestones.js';

const SVG = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * A milestone's badge, drawn: a ring (solid and ink blue once reached, dashed and grey before),
 * and inside it the count for recordings and recordings viewed in full, a row of day marks for a
 * streak, or the share of the study for the team.
 */
export function badge(m, { size = 40 } = {}) {
  const svg = svgEl('svg', { viewBox: '0 0 40 40', width: size, height: size, 'aria-hidden': 'true' });
  svg.classList.add('badge', `badge-${m.kind}`);
  if (m.reached) svg.classList.add('reached');
  svg.append(svgEl('circle', { class: 'badge-ring', cx: 20, cy: 20, r: 18, pathLength: 100 }));
  if (m.kind === 'streak') {
    const n = m.target;
    const w = 2;
    const gap = n > 5 ? 1 : 2;
    const total = n * w + (n - 1) * gap;
    for (let i = 0; i < n; i++) svg.append(svgEl('rect', { class: 'badge-mark', x: 20 - total / 2 + i * (w + gap), y: 14, width: w, height: 12 }));
  } else if (m.kind === 'team') {
    const f = Math.min(1, m.target);
    if (f >= 1) svg.append(svgEl('circle', { class: 'badge-fill', cx: 20, cy: 20, r: 11 }));
    else {
      const a = 2 * Math.PI * f;
      const x = 20 + 11 * Math.sin(a);
      const y = 20 - 11 * Math.cos(a);
      svg.append(svgEl('circle', { class: 'badge-track', cx: 20, cy: 20, r: 11 }),
        svgEl('path', { class: 'badge-fill', d: `M20 20 L20 9 A11 11 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z` }));
    }
  } else {
    if (m.kind === 'thorough') svg.append(svgEl('circle', { class: 'badge-inner', cx: 20, cy: 20, r: 13 }));
    const t = svgEl('text', { class: 'badge-text', x: 20, y: 20, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    t.textContent = String(m.target);
    svg.append(t);
  }
  return svg;
}

function percent(x) { return `${Math.round(x * 100)} %`; }

function bar(share, label) {
  return h('span.progress.games-bar', { role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(share * 100)) },
    h('span.progress-bar', { style: { width: `${Math.round(share * 100)}%` } }));
}

/** Log each milestone that the last save reached (docs/activity_logs.md, milestone_reached), once. */
export function logMilestones(list) {
  for (const m of list) logger.event('milestone_reached', { milestone: m.id, kind: m.kind, name: m.name, target: m.target });
}

function celebration(app, list) {
  const card = h('div.celebrate', { role: 'status', 'data-log': 'milestone-celebration' },
    h('div.celebrate-badges', {}, list.slice(0, 3).map((m) => badge(m, { size: 48 }))),
    h('div.celebrate-text', {},
      h('p.celebrate-title', {}, list.length === 1 ? `Milestone reached: ${list[0].name}` : `${list.length} milestones reached`),
      h('p.caption', {}, list.length === 1 ? list[0].text : list.map((m) => m.name).join(', ') + '.')),
    h('button.btn.small.quiet', { type: 'button', 'data-log': 'milestone-dismiss', onclick: () => card.remove() }, 'Dismiss'));
  return card;
}

function goalBlock(app, facts) {
  const host = h('div.games-goal');
  const goal = facts.goal && Number.isInteger(facts.goal.per_week) ? facts.goal.per_week : null;
  const week = doneThisWeek(facts.completions);
  const draw = (editing = false, problem = '') => {
    clear(host);
    if (editing) {
      const input = h('input.field.goal-input', { type: 'number', min: '1', max: '200', step: '1', inputmode: 'numeric', value: goal ? String(goal) : '5',
        'aria-label': 'Recordings this week', name: 'goal_per_week' });
      const err = h('p.error', { role: 'alert', hidden: !problem }, problem);
      const save = h('button.btn.small.primary', { type: 'button', 'data-log': 'goal-save', onclick: async () => {
        const n = Number(input.value);
        if (!Number.isInteger(n) || n < 1 || n > 200) { draw(true, 'Choose a whole number of recordings from 1 to 200.'); return; }
        save.disabled = true;
        try {
          app.achievements = await app.backend.setAchievements({ goal_per_week: n });
          logger.event('goal_set', { goal_per_week: n });
          app.refreshGames();
        } catch (exc) { draw(true, exc.message); }
      } }, 'Save the goal');
      const clearBtn = goal ? h('button.btn.small', { type: 'button', 'data-log': 'goal-clear', onclick: async () => {
        try {
          app.achievements = await app.backend.setAchievements({ goal_per_week: null });
          logger.event('goal_set', { goal_per_week: null });
          app.refreshGames();
        } catch (exc) { draw(true, exc.message); }
      } }, 'No goal') : null;
      host.append(h('label.goal-edit', {}, h('span', {}, 'Recordings this week'), input),
        h('div.btn-row', {}, save, clearBtn, h('button.btn.small.quiet', { type: 'button', onclick: () => draw(false) }, 'Cancel')), err);
      setTimeout(() => input.focus(), 0);
      return;
    }
    if (goal) {
      host.append(h('div.games-line', {}, h('span', {}, 'Your goal this week'), h('span.games-figure', {}, `${Math.min(week, goal)} of ${goal}`)),
        bar(goalShare(week, goal), 'Your goal this week'),
        h('p.caption', {}, week >= goal ? 'Goal reached for this week. Well done.' : `${goal - week} more to reach it. Weeks start on Monday.`),
        h('button.btn.small.quiet', { type: 'button', 'data-log': 'goal-change', onclick: () => draw(true) }, 'Change the goal'));
    } else {
      host.append(h('p.caption', {}, `${week} recording${week === 1 ? '' : 's'} saved this week.`),
        h('button.btn.small', { type: 'button', 'data-log': 'goal-set', onclick: () => draw(true) }, 'Set a goal for this week'));
    }
  };
  draw();
  return host;
}

function milestonesBlock(facts) {
  const all = milestones(facts);
  const got = all.filter((m) => m.reached);
  const next = nextRecordingStep(facts.counters.done);
  const { current } = streaks(facts.save_times);
  const item = (m) => h('li', { class: m.reached ? 'reached' : 'open', 'data-milestone': m.id }, badge(m),
    h('div', {}, h('b', {}, m.name), h('br'), h('span.caption', {}, m.text)));
  return h('div.games-milestones', {},
    h('h3', {}, 'Milestones'),
    got.length ? h('ul.badge-row', { 'aria-label': 'Milestones reached' }, got.map((m) => h('li', { title: `${m.name}: ${m.text}`, 'data-milestone': m.id }, badge(m))))
      : h('p.caption', {}, 'Save your first recording to reach your first milestone.'),
    got.length ? h('p.caption', {}, [next ? `Next: ${next.name}, ${next.remaining} to go.` : 'Every recording milestone is reached.',
      current > 1 ? ` You have saved recordings ${current} days running.` : ''].join('')) : null,
    h('details.games-all', {}, h('summary', {}, `All milestones (${got.length} of ${all.length} reached)`), h('ul.milestone-list', {}, all.map(item))));
}

/** The "Your progress" card: counters, goal, team, milestones (and a celebration after a save). */
function progressCard(app, facts) {
  const c = facts.counters || {};
  const team = facts.team || {};
  const share = teamShare(team);
  const celebrate = app.celebrate && app.celebrate.length ? celebration(app, app.celebrate) : null;
  app.celebrate = null;
  return h('section.card.games-card', { 'data-section': 'progress' },
    celebrate,
    h('h2', {}, 'Your progress'),
    h('dl.games-counters', {},
      h('div', {}, h('dt', {}, 'Recordings done'), h('dd', {}, String(c.done || 0), c.assigned ? h('span.caption', {}, ` of ${c.assigned}`) : null)),
      h('div', {}, h('dt', {}, 'Time worked'), h('dd', {}, hoursText(c.worked_s))),
      h('div', {}, h('dt', {}, 'Annotations'), h('dd', {}, String(c.annotations || 0)))),
    h('p.caption.games-note', {}, 'Annotations are counted for interest only: mark what you see, as many or as few as there are.'),
    goalBlock(app, facts),
    share !== null ? h('div.games-team', {},
      h('div.games-line', {}, h('span', {}, 'The whole team'), h('span.games-figure', {}, `${team.done} of ${team.assigned} recordings · ${percent(share)}`)),
      bar(share, 'The whole team')) : null,
    milestonesBlock(facts));
}

/** The anonymised leaderboard: pseudonyms only, top ten and the annotator's own place. */
function leaderboardCard(app, facts) {
  const lb = facts.leaderboard;
  if (!facts.leaderboard_enabled || !lb) return null;
  const you = lb.you || {};
  const what = lb.ranked_by === 'viewed_in_full' ? 'Recordings viewed in full' : 'Recordings';
  const show = h('label.check', {}, h('input', { type: 'checkbox', checked: !you.hidden, 'data-log': 'leaderboard-show', onchange: async (e) => {
    const box = e.target;
    box.disabled = true;
    try {
      app.achievements = await app.backend.setAchievements({ leaderboard_hidden: !box.checked });
      logger.event('leaderboard_visibility', { shown: box.checked });
      app.refreshGames();
    } catch {
      box.checked = !box.checked;
      box.disabled = false;
    }
  } }), h('span', {}, 'Show me on the leaderboard'));
  let body;
  if (!lb.rows || !lb.rows.length) {
    body = h('p.caption', {}, `The leaderboard appears once at least ${lb.min_people || 3} people have saved a recording and chosen to be on it.`);
  } else {
    const rows = lb.rows.map((r) => h(`tr${r.you ? '.you' : ''}`, {}, h('td.num', {}, String(r.rank)), h('td', {}, r.name, r.you ? h('span.caption', {}, ' (you)') : null), h('td.num', {}, String(r.count))));
    if (!you.hidden && you.rank && !lb.rows.some((r) => r.you)) {
      rows.push(h('tr.gap', {}, h('td', { colspan: '3' }, '')),
        h('tr.you', {}, h('td.num', {}, String(you.rank)), h('td', {}, you.name, h('span.caption', {}, ' (you)')), h('td.num', {}, String(you.count))));
    }
    body = h('table.list.leaderboard', {}, h('thead', {}, h('tr', {}, h('th.num', {}, 'Place'), h('th', {}, 'Pseudonym'), h('th.num', {}, what))), h('tbody', {}, rows));
  }
  return h('section.card.leaderboard-card', { 'data-section': 'leaderboard' },
    h('h2', {}, 'Leaderboard'),
    h('p.caption', {}, `Your pseudonym in this study is ${you.name || 'kept for you'}. Everyone appears under a pseudonym; nobody sees anyone's annotator ID.`),
    body, show);
}

/** The game cards of the home page, or [] when the study has them switched off or they could not be read. */
export function gameCards(app) {
  const facts = app.achievements;
  if (!facts || !facts.enabled) return [];
  return [progressCard(app, facts), leaderboardCard(app, facts)].filter(Boolean);
}
