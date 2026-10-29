// Report a problem with a recording (docs/web/using.md, "When a recording cannot be annotated"):
// the dialog that asks for the reason, an optional note and what happens next, and the report
// sent to the study (POST /problems, et_problem_report). Used from the home page's list (a file
// that will not even open) and from the annotation view's header.
//
// The report carries an ID made when it is first sent, so a press while the first one waits, or a
// "Try again" after an answer that came too late, keeps one report. The interaction log records
// the reason and the outcome, never the note's text (only its length).

import { h } from '../ui/dom.js';
import { showDialog, ask, inform } from '../ui/dialog.js';
import { logger } from '../log/logger.js';
import { newId } from '../util.js';

export const REASONS = Object.freeze([
  ['file_wont_open', 'The file will not open'],
  ['wrong_recording', 'This is the wrong recording'],
  ['bad_channels', 'Channels are flat, missing or disconnected'],
  ['too_noisy', 'Too noisy or too short to annotate'],
  ['other', 'Something else'],
]);
export const MAX_NOTE = 300;

/** Whether the annotator may set the recording aside (only an unfinished study recording). */
export function canSetAside(item) {
  return Boolean(item) && (item.mode || 'standard') === 'standard' && item.status !== 'done' && item.status !== 'unusable';
}

/**
 * The dialog: resolves {reason, note, outcome} or null when the person cancels. `item` is the
 * recording (an item of GET /assignments, or {recording_id, file_name, mode, context_id, status}).
 */
export async function problemDialog(item, { reason = null } = {}) {
  const name = `problem-reason-${newId().slice(0, 6)}`;
  const reasons = REASONS.map(([value, label], i) => {
    const input = h('input', { type: 'radio', name, value, checked: reason ? value === reason : i === 0, 'data-reason': value });
    return h('label.problem-option', {}, input, h('span', {}, label));
  });
  const note = h('textarea.field.problem-note', { rows: 3, maxlength: String(MAX_NOTE), 'aria-label': 'Note for the study team (optional)',
    placeholder: 'For example: Fp1 and Fp2 are flat from 2:10 on', 'data-log': 'problem-note' });
  const counter = h('span.caption.problem-count', { 'aria-live': 'polite' }, `0 of ${MAX_NOTE} characters`);
  note.addEventListener('input', () => { counter.textContent = `${note.value.length} of ${MAX_NOTE} characters`; });
  const setAside = canSetAside(item);
  const outName = `${name}-outcome`;
  const carryOn = h('input', { type: 'radio', name: outName, value: 'noted', checked: true, 'data-outcome': 'noted' });
  const aside = h('input', { type: 'radio', name: outName, value: 'unusable', disabled: !setAside, 'data-outcome': 'unusable' });
  const body = h('div.problem-form', {},
    h('p.dialog-text', {}, `${item.file_name || item.recording_id}. Tell the study team what is wrong. Saving a recording you could not judge as having no artifacts would mix "clean" with "could not be judged".`),
    h('fieldset.problem-reasons', {}, h('legend', {}, 'What is wrong'), reasons),
    h('label.problem-note-label', {}, h('span', {}, 'Note (optional)'), note, counter),
    h('fieldset.problem-outcomes', {}, h('legend', {}, 'What happens next'),
      h('label.problem-option', {}, carryOn, h('span', {}, 'Tell the study team and carry on')),
      h('label.problem-option', { class: setAside ? null : 'disabled' }, aside,
        h('span', {}, 'This recording cannot be annotated', h('span.caption.block', {}, setAside
          ? 'It is set aside: finished for your progress, and kept apart from the recordings you saved. The study team can give it back to you.'
          : 'Only an unfinished study recording can be set aside.')))));
  const ok = await showDialog({ title: 'Report a problem with this recording', body, className: 'problem-dialog', cancelValue: false,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Send the report', value: true, kind: 'primary' }],
    onOpen: ({ box }) => { const first = box.querySelector('input[type="radio"]:checked'); if (first) first.focus(); } });
  if (!ok) return null;
  const chosen = reasons.map((l) => l.querySelector('input')).find((i) => i.checked);
  return { reason: chosen ? chosen.value : 'other', note: note.value.slice(0, MAX_NOTE).trim(), outcome: aside.checked && setAside ? 'unusable' : 'noted' };
}

/**
 * Ask, send and confirm. Resolves with the study's answer ({problem, already}) or null when nothing
 * was sent. `where`: home or annotate. The same report is sent again with the same ID on "Try again".
 */
export async function reportProblem(app, item, { where = 'home', reason = null } = {}) {
  const choice = await problemDialog(item, { reason });
  if (!choice) return null;
  const body = { problem_id: newId(), recording_id: item.recording_id, mode: item.mode || 'standard', context_id: item.context_id || '',
    reason: choice.reason, note: choice.note, outcome: choice.outcome, where };
  let answer = null;
  for (;;) {
    try {
      answer = await app.backend.reportProblem(body);
      break;
    } catch (exc) {
      if (exc.status === 401) return null;
      logger.event('problem_report_failed', { recording_id: item.recording_id, reason: choice.reason, outcome: choice.outcome, code: exc.code || null });
      if (exc.status >= 400 && exc.status < 500) { await inform('The report was not sent', exc.message); return null; }
      if (!(await ask('The report was not sent', `${exc.message}\n\nTry again? A report the study already received is kept once.`, { yes: 'Try again', no: 'Cancel' }))) return null;
    }
  }
  logger.event('problem_reported', { recording_id: item.recording_id, mode: body.mode, reason: choice.reason, outcome: choice.outcome,
    note_length: choice.note.length, where, already: Boolean(answer && answer.already) });
  await inform('Thank you', choice.outcome === 'unusable'
    ? 'The study team has your report, and this recording is set aside. It counts as finished for your progress; the study team can give it back to you.'
    : 'The study team has your report. Carry on as before.');
  return answer;
}
