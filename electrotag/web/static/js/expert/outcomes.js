// What an annotator sees of the adjudication of their own work (docs/web/using.md, "Decisions on your
// disagreements"): once an adjudication that compared their version is finished, and while the study
// shows outcomes (review.show_outcomes_to_annotators), the home page lists each conflict of theirs with
// what they marked, what the others marked (nobody is named), the decision and its reason. Calm marks in
// the accent blue, never red: the point is to learn, and the adjudicator may have kept their version.

import { h, clear } from '../ui/dom.js';
import { logger } from '../log/logger.js';
import { KIND_TEXT, REASON_TEXT, spanText } from './model.js';

export const OUTCOME_TEXT = Object.freeze({
  yours_kept: 'As you had it', all_kept: 'Kept with the others', part_kept: 'Partly kept', other_kept: 'A colleague\'s mark was kept',
  none_kept: 'Your mark was not kept', edited: 'Redrawn by the adjudicator',
});

/** Outcomes in which what the annotator did stood (their marks kept, or no mark where they had none). */
const STOOD = new Set(['yours_kept', 'all_kept']);

/**
 * The decision as it concerns the annotator: whether what they marked (or did not mark) stood. The study works
 * it out from what was kept (adjudication.py, conflicts.outcome_for), so these words follow the outcome and
 * whether the annotator had a mark there; k is how many versions were compared ("both" for two, "all" for more).
 */
export function outcomeWords(c, k = 2) {
  const d = c.decision || {};
  const had = Boolean(c.yours && c.yours.length);
  switch (d.outcome) {
    case 'yours_kept': return { text: had ? 'Your mark was kept' : 'No mark here, as you had it', yours: true };
    case 'all_kept': return { text: k > 2 ? 'Your mark was kept, with colleagues\' marks' : 'Both marks were kept', yours: true };
    case 'part_kept': return { text: 'Some of your marks were kept, not all', yours: false };
    case 'other_kept': return { text: had ? 'A colleague\'s mark was kept instead of yours' : 'A colleague\'s mark was kept where you had none', yours: false };
    case 'none_kept': return { text: 'Your mark was not kept: no mark here', yours: false };
    case 'edited': {
      const own = (d.marks || []).length > 1 ? 'their own marks' : 'their own mark';
      return { text: had ? `The adjudicator drew ${own} instead` : `The adjudicator drew ${own} where you had none`, yours: false };
    }
    default: return { text: OUTCOME_TEXT[d.outcome] || String(d.outcome || ''), yours: false };
  }
}

/** How many of the item's (or items') conflicts were decided as the annotator had them. */
export function stoodCount(conflicts) {
  return (conflicts || []).filter((c) => STOOD.has(c.decision && c.decision.outcome)).length;
}

/** "17 decided: 9 as you had them, 4 where a colleague's mark was kept, 1 redrawn by the adjudicator." */
export function outcomeSummary(item) {
  const list = item.conflicts || [];
  const n = list.length;
  const by = {};
  for (const c of list) by[c.decision.outcome] = (by[c.decision.outcome] || 0) + 1;
  const two = (item.k || 2) <= 2;
  const words = {
    yours_kept: (x) => `${x} as you had ${x === 1 ? 'it' : 'them'}`,
    all_kept: (x) => (two ? `${x} with both marks kept` : `${x} with yours kept among others`),
    part_kept: (x) => `${x} with some of your marks kept`,
    other_kept: (x) => `${x} where a colleague's mark was kept`,
    none_kept: (x) => `${x} where your mark was not kept`,
    edited: (x) => `${x} redrawn by the adjudicator`,
  };
  const parts = Object.keys(words).filter((k) => by[k]).map((k) => words[k](by[k]));
  return `${n} decided${parts.length ? `: ${parts.join(', ')}` : ''}.`;
}

/** The card's first line, said at once: "In 9 of 17 places where you and a colleague disagreed, the decision was yours." */
export function outcomesLead(items) {
  const all = (items || []).flatMap((it) => it.conflicts || []);
  if (!all.length) return '';
  return `In ${stoodCount(all)} of the ${all.length} place${all.length === 1 ? '' : 's'} where you and a colleague disagreed, the expert decided as you had it.`;
}

/** A conflict in words for the annotator: what they marked and what the others marked. */
export function conflictLines(c) {
  const marks = (list) => list.map((m) => `${m.label} ${spanText(m.onset_s, m.offset_s)}`).join('; ');
  return {
    yours: c.yours && c.yours.length ? `You: ${marks(c.yours)}` : 'You: no mark here',
    others: c.others && c.others.length ? `Others: ${marks(c.others)}` : 'Others: no mark here',
    kept: c.decision && c.decision.marks && c.decision.marks.length ? `Kept: ${marks(c.decision.marks)}` : 'Kept: no mark',
  };
}

/** The card of the home page, or null when there is nothing to show. */
export function outcomesCard(items) {
  if (!items || !items.length) return null;
  const blocks = items.map((it) => h('details.outcome', { 'data-unit': it.task_id, 'data-recording': it.recording_id },
    h('summary', {}, h('b', {}, it.file_name || it.recording_id), h('span.caption', {}, ` ${outcomeSummary(it)}`),
      it.reopened ? h('span.caption', {}, 'The expert is looking at it again; these decisions stand until they finish.') : null),
    h('ol.outcome-list', {}, (it.conflicts || []).map((c) => {
      const l = conflictLines(c);
      const d = c.decision || {};
      const w = outcomeWords(c, it.k || 2);
      return h('li.outcome-row', { 'data-outcome': d.outcome, 'data-yours': w.yours ? 'kept' : '' },
        h('span.outcome-head', {}, h('b', {}, w.text), h('span.caption', {}, ` · ${spanText(c.onset_s, c.offset_s)} · ${(c.kinds || []).map((k) => KIND_TEXT[k] || k).join(', ')}`)),
        h('span.caption.block', {}, l.yours), h('span.caption.block', {}, l.others), h('span.caption.block', {}, l.kept),
        d.reason || d.reason_code ? h('span.block.outcome-reason', {}, `Why: ${[d.reason_code ? REASON_TEXT[d.reason_code] : '', d.reason].filter(Boolean).join(': ')}`) : null);
    }))));
  const el = h('section.card.outcomes-card', { 'aria-label': 'Decisions on your disagreements' },
    h('h2', {}, 'Decisions on your disagreements'),
    h('p.outcomes-lead', {}, outcomesLead(items)),
    h('p.caption', {}, 'Where your annotations and a colleague\'s disagreed, an expert decided each place. Open a recording to see each one, with the reason. Your own files stay as you saved them.'),
    blocks);
  el.addEventListener('toggle', (e) => { if (e.target.open) logger.event('adjudication_outcome_opened', { conflicts: (e.target.querySelectorAll('li') || []).length }); }, true);
  return el;
}

/** The expert area's styles, which hold the card's few rules (loaded once, as js/expert/area.js does). */
function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-expert-css]')) return;
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('../../expert.css', import.meta.url).href, 'data-expert-css': '' }));
}

/** Fill `host` (on the home page) with the card, once GET /me/feedback has answered; nothing when it fails. */
export async function fillOutcomes(app, host) {
  try {
    const fb = await app.backend.myFeedback();
    const part = fb && fb.adjudications;
    clear(host);
    const card = part && part.shown ? outcomesCard(part.items) : null;
    if (card) {
      loadStyles();
      host.append(card);
      logger.event('adjudication_outcomes_shown', { recordings: part.items.length, conflicts: part.items.reduce((n, it) => n + (it.conflicts || []).length, 0) });
    } else host.remove();
  } catch {
    host.remove(); // the home page works without it
  }
}
