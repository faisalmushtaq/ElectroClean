// The home page's Due card (docs/web/using.md, "Due dates"): one line for each hand-out of the study team
// that has a due date, earliest first, from GET /assignments `due`: "Youth recordings: 12 of 40 left, due
// Friday 20 November", with an Overdue badge once the day has passed and work remains. Show these narrows the
// list of recordings to that hand-out. Annotators see a hand-out only by the title the study team gave it,
// never the name or details of the dataset or collection behind it (decision 1 of the project lead).
//
// Loaded on demand (js/lazy.js part homeDue), only when the person has something due.

import { h } from '../ui/dom.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Friday 20 November" for 2026-11-20 (the year too when it is not this one's), or '' for something else. */
export function dayText(day, today = '') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const year = today && String(today).slice(0, 4) !== m[1] ? ` ${m[1]}` : '';
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}`;
}

/** The words of one due hand-out: "Youth recordings: 12 of 40 left, due Friday 20 November". */
export function dueText(d, today = '') {
  const total = Number(d.total) || 0;
  const left = Number(d.remaining) || 0;
  const when = dayText(d.due_at, today);
  const done = !left ? (total === 1 ? 'done' : `all ${total} done`) : `${left} of ${total} left`;
  const due = !when ? '' : d.overdue ? `, was due ${when}` : `, due ${when}`;
  return `${d.title}: ${done}${due}`;
}

/** The Due card, or null when nothing is due. `show(title)` narrows the list of recordings to one hand-out. */
export function dueCard(app, { show = null, today = '' } = {}) {
  const due = (app.assignments && Array.isArray(app.assignments.due) && app.assignments.due) || [];
  if (!due.length) return null;
  return h('section.card.due-card', { 'aria-label': 'Due dates', 'data-section': 'due' },
    h('h2', {}, 'Due'),
    h('ul.due-list', {}, due.map((d) => h('li.due-line', { 'data-handout': d.handout_id },
      h('span.due-text', {}, dueText(d, today)),
      d.overdue ? h('span.chip.warning', {}, 'Overdue') : null,
      show ? h('button.btn.small.quiet', { type: 'button', 'data-log': 'due-show', 'aria-label': `Show the recordings of ${d.title}`,
        onclick: () => show(d.title) }, 'Show these') : null))),
    h('p.caption', {}, 'Due dates help you plan. The order of your recordings stays as the study sets it.'));
}
