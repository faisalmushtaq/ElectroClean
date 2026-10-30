// How experts' corrections of an annotator's version stand, in words (docs/web/using.md, "Corrections of
// your work"). One expert's correction is shown as it is. When two or more experts corrected the same
// version, the annotator is never taught one expert's version: until the study has adjudicated their
// disagreements the history says only who corrected it and that the study is settling it, and once it
// has, the adjudicated corrected version is shown with an outcome card, the decisions on each place
// where the experts disagreed (what the annotator had, what each expert made of it, what was kept and
// why). The words are here for the home page's history (js/views/home_list.js, which loads this module
// only when there is something settled to show, and shows the card in a dialog) and the annotator's
// view of the correction (correction_feedback.js). Calm, in the accent blue: the point is to learn.

import { h } from '../ui/dom.js';
import { logger } from '../log/logger.js';

/** The kinds of disagreement (expert/model.js KIND_TEXT), in the outcome card's words. */
const KIND_WORDS = Object.freeze({ presence: 'Marked by some only', type: 'Different types', timing: 'Start or end apart', channels: 'Different channels',
  split: 'Split differently' });

const span = (a, b) => `${Number(a).toFixed(2)}–${Number(b).toFixed(2)} s`;

/** "Expert one", "Expert one and Expert two", "E01, E02 and E03". */
export function namesText(people) {
  const names = (people || []).map((p) => p.corrector_name || p.corrector_id).filter(Boolean);
  return names.length <= 1 ? names[0] || '' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The number of changes an item counts. */
export function changesOf(item) {
  return Object.values(item.counts || {}).reduce((a, b) => a + (Number(b) || 0), 0);
}

/** The history's line for the corrections of one version: how it stands, in plain words. */
export function standingText(item) {
  if (!item) return null;
  const n = changesOf(item);
  const changes = `${n} change${n === 1 ? '' : 's'}`;
  if (item.standing === 'pending') return `Corrected by ${namesText(item.correctors)}, who disagree in places: the study is settling it`;
  if (item.standing === 'adjudicated') {
    const a = item.adjudication || {};
    return `Corrected by ${namesText(item.correctors)}, settled by ${a.adjudicator_name || a.adjudicator_id || 'an expert'}: ${changes}`;
  }
  return `Corrected by ${item.corrector_name || item.corrector_id}: ${changes}`;
}

/** What a decision kept, from the annotator's side: "Expert one's correction was kept". */
export function decisionWords(d) {
  const kept = (d && d.kept_names) || [];
  if (!d || !d.choice) return 'Not decided';
  if (d.choice === 'edited') return 'Replaced by the adjudicator\'s own mark';
  if (d.choice === 'none') return 'Neither expert\'s mark was kept';
  if (d.choice === 'all') return 'Both experts\' marks were kept';
  return kept.length ? `${kept.join(' and ')}'s correction was kept` : 'One correction was kept';
}

/** The reason of a decision: "the type shows in the EEG: the eyes move sideways", or ''. */
export function whyText(d) {
  return [d && d.reason_text, d && d.reason].filter(Boolean).join(': ');
}

const marksText = (list) => (list && list.length ? list.map((m) => `${m.label} ${span(m.onset_s, m.offset_s)}`).join('; ') : 'no mark');

/** One place where the experts disagreed, as a list item of the outcome card. */
export function settledRow(c) {
  const d = c.decision || {};
  const why = whyText(d);
  return h('li.outcome-row.settled-row', { 'data-choice': d.choice || '' },
    h('span.outcome-head', {}, h('b', {}, decisionWords(d)), h('span.caption', {}, ` · ${span(c.onset_s, c.offset_s)} · ${(c.kinds || []).map((k) => KIND_WORDS[k] || k).join(', ')}`)),
    h('span.caption.block', {}, `You: ${marksText(c.yours)}`),
    (c.versions || []).map((v) => h('span.caption.block', {}, `${v.corrector_name || v.corrector_id}: ${marksText(v.marks)}`)),
    h('span.caption.block', {}, `Kept: ${marksText(d.marks)}`),
    why ? h('span.block.outcome-reason', {}, `Why: ${why}`) : null);
}

/** The list of places where the experts disagreed, each with its decision. */
export function settledList(item) {
  return h('ol.outcome-list.settled-list', {}, ((item.adjudication || {}).conflicts || []).map(settledRow));
}

/** "3 places, decided by Expert three". */
export function settledSummary(item) {
  const a = item.adjudication || {};
  const n = (a.conflicts || []).length;
  return `${n} place${n === 1 ? '' : 's'}, decided by ${a.adjudicator_name || a.adjudicator_id || 'an expert'}`;
}

/**
 * The home page's way to the outcome card (the history, js/views/home_list.js): a link that shows each place where the
 * experts disagreed and the decision in a dialog, readable without the recording's file.
 */
export function settledLink(item) {
  const rows = (item.adjudication || {}).conflicts || [];
  if (!rows.length) return null;
  return h('button.link.caption.block.settled-open', { type: 'button', 'data-log': 'correction-outcome-open',
    onclick: async () => {
      const { showDialog } = await import('../ui/dialog.js');
      logger.event('correction_outcome_opened', { places: rows.length, via: 'history' });
      await showDialog({ title: 'Where the experts disagreed', className: 'settled-dialog', wide: true, logText: settledSummary(item),
        body: h('div', {}, h('p.dialog-text', {}, `${namesText(item.correctors)} corrected your version ${item.attempt} and disagreed in ${rows.length === 1 ? 'one place' : `${rows.length} places`}; `
          + `${(item.adjudication || {}).adjudicator_name || (item.adjudication || {}).adjudicator_id || 'an expert'} decided each. Your own files stay as you saved them.`), settledList(item)),
        buttons: [{ label: 'Close', value: true, kind: 'primary' }], cancelValue: true });
    } }, `Where the experts disagreed: ${settledSummary(item)}`);
}

/** The outcome card of an adjudicated item: each place where the experts disagreed, and the decision. */
export function settledCard(item, { open = false } = {}) {
  const a = item.adjudication || {};
  const rows = a.conflicts || [];
  if (!rows.length) return null;
  const el = h('details.outcome.settled-card', { 'data-unit': a.unit_id || '', ...(open ? { open: '' } : {}) },
    h('summary', {}, h('span', {}, h('b', {}, 'Where the experts disagreed'), h('span.caption.block', {}, settledSummary(item)))),
    settledList(item));
  el.addEventListener('toggle', () => { if (el.open) logger.event('correction_outcome_opened', { places: rows.length }); });
  return el;
}
