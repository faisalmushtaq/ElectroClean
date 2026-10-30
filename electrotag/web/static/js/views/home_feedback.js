// What the home page shows of problem reports and reviews (docs/web/using.md, "When a recording
// cannot be annotated" and "Reviews of your work"): the More menu on each recording's row (Report a
// problem…, See the feedback), the line under a file name ("Reviewed: 2 caveats, 1 comment",
// "Problem reported", "Set aside: cannot be annotated"), and a short line when the study team
// gave a recording back. Kept apart from home_list.js so that each change stays in its own place.

import { h } from '../ui/dom.js';
import { showMenu } from '../ui/menu.js';
import { icon } from './common.js';
import { reportProblem } from '../annotate/problem.js';
import { loadPart } from '../lazy.js';

/** The reviews of the annotator's work, newest first (app.reviews, from GET /me/reviews), of one recording. */
export function reviewsOf(app, it) {
  const all = (app.reviews && app.reviews.reviews) || [];
  return all.filter((r) => r.recording_id === it.recording_id && (it.mode || 'standard') === 'standard');
}

/** "Reviewed: 2 caveats, 1 comment" (the latest review), or null. */
export function reviewLine(app, it) {
  const list = reviewsOf(app, it);
  if (!list.length) return null;
  const latest = list[0];
  return `Reviewed: ${latest.summary}${list.length > 1 ? ` (${list.length} reviews)` : ''}`;
}

/** True when the feedback on a recording can be opened (See the feedback…): it was reviewed and is finished. */
export function canSeeFeedback(app, it) {
  return reviewsOf(app, it).length > 0 && it.status === 'done';
}

/** The line under the file name: the review, or what became of a report. */
export function feedbackCaption(app, it) {
  const parts = [];
  const r = reviewLine(app, it);
  // The line opens the feedback when it can be read (a finished recording); otherwise it is plain text.
  if (r) {
    parts.push(canSeeFeedback(app, it)
      ? h('button.link.caption.block.review-line', { type: 'button', 'data-review': it.recording_id, 'data-log': 'review-line',
        title: 'See the feedback', onclick: () => app.openFeedback(it) }, r)
      : h('span.caption.block.review-line.plain', { 'data-review': it.recording_id }, r));
  }
  const p = it.problem;
  if (it.status === 'unusable') parts.push(h('span.caption.block.problem-line', {}, `Set aside: ${String(p && p.reason_text ? p.reason_text : 'cannot be annotated').toLowerCase()}`));
  else if (p && p.state === 'open') parts.push(h('span.caption.block.problem-line', {}, 'Problem reported to the study team'));
  return parts;
}

/** The More button of a row: Report a problem…, and See the feedback when the work was reviewed. */
/** True when the person has a saved version of the item, whose files they can download. */
export function hasSaved(it) { return Boolean(it && (it.status === 'done' || (it.saved && typeof it.saved === 'object'))); }

/** Download one's own files of a saved item (views/my_files.js, loaded at the first download). */
export async function downloadSaved(app, it, opts = {}) {
  const { downloadMine } = await loadPart('myFiles');
  return downloadMine(app, it, opts);
}

export function moreButton(app, it) {
  const name = it.file_name || it.recording_id;
  const b = h('button.btn.small.icon.quiet.row-more', { type: 'button', 'aria-label': `More for ${name}`, title: 'More', 'aria-haspopup': 'menu',
    'data-log': 'recording-more', 'data-more': it.recording_id });
  b.append(icon('more'));
  b.addEventListener('click', () => {
    const r = b.getBoundingClientRect();
    const items = [{ label: 'Report a problem with this recording…', onSelect: () => app.reportProblemFor(it, 'home') }];
    if (canSeeFeedback(app, it)) items.push({ label: 'See the feedback…', onSelect: () => app.openFeedback(it) });
    if (hasSaved(it)) { // one's own saved files of it (views/my_files.js)
      items.push({ label: 'Download my annotations (zip)', onSelect: () => downloadSaved(app, it) },
        { label: 'Download my annotations as separate files', onSelect: () => downloadSaved(app, it, { separate: true }) });
    }
    showMenu(items, r.left, r.bottom + 4, { className: 'row-menu', opener: b });
  });
  return b;
}

/** The line at the top of the list when the study team gave recordings back (after a report). */
export function returnedLine(app) {
  const items = ((app.assignments && app.assignments.items) || []).filter((i) => i.problem && i.problem.resolution === 'returned' && (i.status === 'todo' || i.status === 'in_progress'));
  if (!items.length) return null;
  const first = items[0];
  const note = first.problem.resolution_note ? `: ${first.problem.resolution_note}` : '.';
  const text = items.length === 1
    ? `The study team gave ${first.file_name} back to your list after your report${note}`
    : `The study team gave ${items.length} recordings back to your list after your reports.`;
  return h('p.note.returned-line', { role: 'status', 'data-log': 'returned-line' }, text);
}

/**
 * After the list is drawn again, the focus goes back to the row's More button, or to the list's tab
 * when the row moved to another tab, so that the next Tab carries on in the list.
 */
function refocusRow(it) {
  const esc = (v) => (globalThis.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'));
  const target = document.querySelector(`.row-more[data-more="${esc(it.recording_id)}"]`) || document.querySelector('.rec-tabs [aria-selected="true"]');
  if (target) target.focus({ preventScroll: true });
}

/** Send a report from the home page, then show the list again with what changed. */
export async function reportFromHome(app, it) {
  if (app._reportingProblem) return null; // pressed again while the first report is under way
  app._reportingProblem = true;
  try {
    const answer = await reportProblem(app, it, { where: 'home' });
    if (answer && app.route === 'home' && !app.ws) {
      await app.reloadHome();
      refocusRow(it);
    }
    return answer;
  } finally {
    app._reportingProblem = false;
  }
}
