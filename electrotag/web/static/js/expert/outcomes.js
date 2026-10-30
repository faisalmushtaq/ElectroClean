// What an annotator sees of the adjudication of their own work (docs/web/using.md, "Decisions on your
// disagreements"): once an adjudication that compared their version is finished, and while the study
// shows outcomes (review.show_outcomes_to_annotators), the home page lists each conflict of theirs with
// what they marked, what the others marked (nobody is named), the decision and its reason. Calm marks in
// the accent blue, never red: the point is to learn, and the adjudicator may have kept their version.

import { h, clear } from '../ui/dom.js';
import { logger } from '../log/logger.js';
import { KIND_TEXT, REASON_TEXT, spanText } from './model.js';

export const OUTCOME_TEXT = Object.freeze({
  yours_kept: 'Your mark was kept', other_kept: 'Another version was kept', all_kept: 'Both were kept', none_kept: 'Neither was kept',
  edited: 'Replaced by the adjudicator\'s mark',
});

/** The decision as it concerns the annotator: whether what they marked (or did not mark) stood. */
export function outcomeWords(c) {
  const d = c.decision || {};
  const had = Boolean(c.yours && c.yours.length);
  switch (d.outcome) {
    case 'yours_kept': return { text: had ? 'Your mark was kept' : 'No mark, as you had it', yours: true };
    case 'other_kept': return { text: had ? 'A colleague\'s mark was kept instead' : 'A colleague\'s mark was kept where you had none', yours: false };
    case 'all_kept': return had ? { text: 'Both marks were kept', yours: true } : { text: 'A colleague\'s mark was kept where you had none', yours: false };
    case 'none_kept': return { text: had ? 'Your mark was not kept' : 'No mark, as you had it', yours: !had };
    case 'edited': return { text: 'Replaced by the adjudicator\'s own mark', yours: false };
    default: return { text: OUTCOME_TEXT[d.outcome] || String(d.outcome || ''), yours: false };
  }
}

/** "3 conflicts decided: 1 of yours kept, 1 of another's, 1 both." */
export function outcomeSummary(item) {
  const n = (item.conflicts || []).length;
  const by = {};
  for (const c of item.conflicts || []) by[c.decision.outcome] = (by[c.decision.outcome] || 0) + 1;
  const parts = [['yours_kept', 'yours kept'], ['other_kept', 'another version kept'], ['all_kept', 'both kept'], ['none_kept', 'neither kept'], ['edited', 'replaced']]
    .filter(([k]) => by[k]).map(([k, w]) => `${by[k]} ${w}`);
  return `${n} conflict${n === 1 ? '' : 's'} decided${parts.length ? `: ${parts.join(', ')}` : ''}.`;
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
  const blocks = items.map((it) => h('details.outcome', { 'data-unit': it.task_id },
    h('summary', {}, h('b', {}, it.file_name || it.recording_id), h('span.caption', {}, ` ${outcomeSummary(it)}`)),
    h('ol.outcome-list', {}, (it.conflicts || []).map((c) => {
      const l = conflictLines(c);
      const d = c.decision || {};
      const w = outcomeWords(c);
      return h('li.outcome-row', { 'data-outcome': d.outcome, 'data-yours': w.yours ? 'kept' : '' },
        h('span.outcome-head', {}, h('b', {}, w.text), h('span.caption', {}, ` · ${spanText(c.onset_s, c.offset_s)} · ${(c.kinds || []).map((k) => KIND_TEXT[k] || k).join(', ')}`)),
        h('span.caption.block', {}, l.yours), h('span.caption.block', {}, l.others), h('span.caption.block', {}, l.kept),
        d.reason || d.reason_code ? h('span.block.outcome-reason', {}, `Why: ${[d.reason_code ? REASON_TEXT[d.reason_code] : '', d.reason].filter(Boolean).join(': ')}`) : null);
    }))));
  const el = h('section.card.outcomes-card', { 'aria-label': 'Decisions on your disagreements' },
    h('h2', {}, 'Decisions on your disagreements'),
    h('p.caption', {}, 'Where your annotations and a colleague\'s disagreed, an expert decided each place. Your own files stay as you saved them.'),
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
