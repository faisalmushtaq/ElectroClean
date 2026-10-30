// The ? key of the expert's views and the replay (docs/web/admin.md, "The expert area"): a sheet of the
// keys of the view that is open, in a dialog, instead of the annotation view's general Help tab. The
// correction view, the annotator's view of a correction and the replay player each give their own
// rows; the same next and previous keys (N and P) are used across the expert views.

import { h } from '../ui/dom.js';
import { showDialog } from '../ui/dialog.js';
import { logger } from '../log/logger.js';

/** One key or a few ("Shift+1–7", "N / P") as <kbd> elements. */
function keys(text) {
  const out = [];
  String(text).split(' / ').forEach((k, i) => {
    if (i) out.push(' / ');
    out.push(h('kbd', {}, k));
  });
  return out;
}

/** The sheet's body: one table of the keys, each group {title, rows: [[keys, what]]} under its heading, so that the columns line up. */
export function keySheetBody(groups, foot = null) {
  return h('div.key-sheet-body', {},
    h('table.keys', {}, h('tbody', {}, groups.map((g) => [g.title ? h('tr', {}, h('th', { colspan: '2', scope: 'colgroup' }, g.title)) : null,
      g.rows.map(([k, what]) => h('tr', {}, h('td', {}, keys(k)), h('td', {}, what)))]))),
    foot ? h('p.caption', {}, foot) : null);
}

/** Show the sheet of a view's keys (`view` names it in the log). */
export async function showKeySheet(title, groups, { view = '', foot = 'The annotation view\'s other keys are in its Help tab.' } = {}) {
  logger.event('key_sheet_shown', { view });
  await showDialog({ title, className: 'key-sheet', body: keySheetBody(groups, foot), logText: title,
    buttons: [{ label: 'Close', value: true, kind: 'primary' }], cancelValue: true });
}

/** True for the ? key (with or without Shift, as keyboards differ), without Ctrl, Cmd or Alt. */
export function isHelpKey(e) {
  return e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey;
}
