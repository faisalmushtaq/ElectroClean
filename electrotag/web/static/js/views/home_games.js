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
  doneThisWeek, goalShare, milestones, nextRecordingStep, streaks, teamShare,
} from '../games/milestones.js';

const SVG = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** What a milestone's badge says, for screen readers and as its title ("5 days in a row, reached"). */
export function badgeLabel(m) {
  const what = {
    recordings: `${m.target} recording${m.target === 1 ? '' : 's'} saved`,
    streak: `${m.target} days in a row`,
    thorough: `${m.target} recordings viewed in full`,
    team: `The team at ${Math.round(m.target * 100)}% of the study`,
  }[m.kind] || m.name;
  return `${what}, ${m.reached ? 'reached' : 'not yet reached'}`;
}

/**
 * A milestone's badge, drawn at 44 pixels so that its figures are set at the type scale's sizes. A
 * reached badge has a solid ink-blue ring on a blue ground; one not yet reached a dashed grey ring
 * and no ground. Inside: the count for recordings; the count over a small calendar for days in a
 * row; a disc with the count for recordings viewed in full; and the share of the study as a pie for
 * the team.
 */
export function badge(m) {
  const svg = svgEl('svg', { viewBox: '0 0 44 44', width: 44, height: 44, role: 'img', 'aria-label': badgeLabel(m) });
  const title = svgEl('title', {});
  title.textContent = badgeLabel(m);
  svg.append(title);
  svg.classList.add('ms-badge', `ms-badge-${m.kind}`);
  if (m.reached) svg.classList.add('reached');
  svg.append(svgEl('circle', { class: 'badge-ring', cx: 22, cy: 22, r: 20, pathLength: 100 }));
  const text = (y, cls = '') => {
    const t = svgEl('text', { class: `badge-text${cls}`, x: 22, y, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    t.textContent = String(m.target);
    return t;
  };
  if (m.kind === 'streak') {
    // the count, and under it a small calendar: a box with its top band and two rings
    svg.append(text(16),
      svgEl('rect', { class: 'badge-glyph', x: 16.5, y: 27.5, width: 11, height: 8 }),
      svgEl('path', { class: 'badge-glyph', d: 'M16.5 30.5h11M19.5 25.5v3M24.5 25.5v3' }));
  } else if (m.kind === 'team') {
    const f = Math.min(1, m.target);
    svg.append(svgEl('circle', { class: 'badge-track', cx: 22, cy: 22, r: 12 }));
    if (f >= 1) svg.append(svgEl('circle', { class: 'badge-fill', cx: 22, cy: 22, r: 12 }));
    else {
      const a = 2 * Math.PI * f;
      const x = 22 + 12 * Math.sin(a);
      const y = 22 - 12 * Math.cos(a);
      svg.append(svgEl('path', { class: 'badge-fill', d: `M22 22 L22 10 A12 12 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z` }));
    }
  } else if (m.kind === 'thorough') {
    svg.append(svgEl('circle', { class: 'badge-disc', cx: 22, cy: 22, r: 15 }), text(22, ' on-disc'));
  } else {
    svg.append(text(22));
  }
  return svg;
}

function percent(x) { return `${Math.round(x * 100)}%`; }

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
    h('div.celebrate-badges', {}, list.slice(0, 3).map((m) => badge(m))),
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
        await change(n);
      } }, 'Save the goal');
      const clearBtn = goal ? h('button.btn.small', { type: 'button', 'data-log': 'goal-clear', onclick: () => change(null) }, 'No goal') : null;
      // One change at a time: both buttons wait for the study's answer (a slow one too), which is kept
      // only when no newer change has been made meanwhile (App.changeAchievements).
      const change = async (n) => {
        if (save.disabled) return;
        save.disabled = true;
        if (clearBtn) clearBtn.disabled = true;
        try {
          await app.changeAchievements({ goal_per_week: n });
          logger.event('goal_set', { goal_per_week: n });
          app.refreshGames();
        } catch (exc) { draw(true, exc.message); }
      };
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
    got.length ? h('ul.badge-row', { 'aria-label': 'Milestones reached' }, got.map((m) => h('li', { 'data-milestone': m.id }, badge(m))))
      : h('p.caption', {}, 'Save your first recording to reach your first milestone.'),
    got.length ? h('p.caption', {}, [next ? `Next: ${next.name}, ${next.remaining} to go.` : 'Every recording milestone is reached.',
      current > 1 ? ` You have saved recordings ${current} days running.` : ''].join('')) : null,
    h('details.games-all', {}, h('summary', {}, `All milestones (${got.length} of ${all.length} reached)`), h('ul.milestone-list', {}, all.map(item))));
}

/**
 * The "Goals and milestones" card of the side column: the milestones, the weekly goal, the team's
 * progress and the annotations made (for interest only). The annotator's own recordings done and
 * time worked are on the progress card at the top of the page (home.js), so they are not repeated.
 */
function progressCard(app, facts) {
  const c = facts.counters || {};
  const team = facts.team || {};
  const share = teamShare(team);
  const celebrate = app.celebrate && app.celebrate.length ? celebration(app, app.celebrate) : null;
  app.celebrate = null;
  return h('section.card.games-card', { 'data-section': 'milestones' },
    celebrate,
    h('h2', {}, 'Goals and milestones'),
    milestonesBlock(facts),
    goalBlock(app, facts),
    share !== null ? h('div.games-team', {},
      h('div.games-line', {}, h('span', {}, 'The whole team'), h('span.games-figure', {}, `${team.done} of ${team.assigned} · ${percent(share)}`)),
      bar(share, 'The whole team')) : null,
    h('p.caption.games-note', { 'data-stat': 'annotations' },
      `${c.annotations || 0} annotation${c.annotations === 1 ? '' : 's'} made, counted for interest only: mark what you see, as many or as few as there are.`));
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
      await app.changeAchievements({ leaderboard_hidden: !box.checked });
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
