// Correct the marks, as the study team and the experts make it (docs/web/admin.md, "Correct the marks"):
// for a guided recording of a reference set, a copy of the experts' marks with deliberate mistakes that
// trainees put right. The study plants the mistakes from a seed (electrotag/training/planted.py), or
// finds them in an expert's own deliberately flawed annotation file; the panel lists them, makes the
// exercise again with another seed, removes it, and opens it to try (js/training/correct.js). It talks to
// the expert channel, which administrators use too: planted_get, set_planted_make, set_planted_from and
// set_planted_remove. Used by the expert area's Correct the marks and by Training's Manage.

import { h, append, clear } from '../ui/dom.js';
import { logger } from '../log/logger.js';
import { actionButton, card, chip, confirmInline, dataTable, field, loading, messageArea, numberInput } from './ui.js';

export const KIND_TEXT = Object.freeze({ missing: 'Left out', type: 'Wrong type', boundary: 'Start or end moved', extra: 'Not an artifact', channels: 'Channels' });
export const KINDS = ['missing', 'type', 'boundary', 'extra'];

/** The seed and counts of the Make form, checked: {seed?, counts} or an Error in plain words. */
export function makeBody(seedText, counts) {
  const body = {};
  const s = String(seedText ?? '').trim();
  if (s) {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0 || n > 999999) throw new Error('The seed is a whole number from 0 to 999999, or empty for a new one.');
    body.seed = n;
  }
  const c = {};
  for (const k of KINDS) {
    const n = Number(counts[k]);
    if (!Number.isInteger(n) || n < 0 || n > 20) throw new Error(`${KIND_TEXT[k]}: give a whole number of mistakes from 0 to 20.`);
    c[k] = n;
  }
  if (!Object.values(c).some(Boolean)) throw new Error('Plant at least one mistake.');
  body.counts = c;
  return body;
}

/** One line on how the exercise was made. */
export function madeText(p) {
  if (!p) return 'No exercise yet.';
  const how = p.method === 'from_annotations' ? 'from an expert\'s own annotations' : `from seed ${p.seed}`;
  const when = p.made_at ? ` on ${String(p.made_at).slice(0, 10)}` : '';
  return `${p.n_errors} deliberate mistake${p.n_errors === 1 ? '' : 's'}, made ${how}${p.made_by ? ` by ${p.made_by}` : ''}${when}.`;
}

/**
 * The panel for one guided recording. `api` is {read(op, body), write(op, body)} on the expert channel;
 * `onTry(target)` opens the exercise to try.
 */
export function plantedPanel({ api, setId, recordingId, onTry, onChanged = null }) {
  const host = h('div.admin-stack.planted-admin', { 'data-recording': recordingId });
  const msg = messageArea();
  const body = h('div.admin-stack', {}, loading());
  host.append(msg, body);
  const show = (got) => {
    clear(body);
    const p = got.planted;
    const errorsTable = p ? dataTable([
      { title: 'Mistake', render: (e) => chip(KIND_TEXT[e.kind] || e.kind) },
      { title: 'What was done', render: (e) => h('span', {}, e.detail) },
    ], p.errors || [], { pageSize: 20, caption: 'The planted mistakes' }) : null;
    const tryBtn = p && !p.stale ? h('button.btn.primary', { type: 'button', 'data-log': 'planted-try', onclick: () => onTry(got) }, 'Try it') : null;
    const removeHost = h('div.btn-row');
    if (p) {
      removeHost.append(h('button.btn.destructive', { type: 'button', 'data-log': 'planted-remove', onclick: async () => {
        if (!(await confirmInline(removeHost, { text: `Remove this exercise? Trainees then learn ${recordingId.split('/').pop()} step by step again.`, yes: 'Remove it' }))) return;
        try {
          await api.write('set_planted_remove', { set_id: setId, recording_id: recordingId });
          logger.event('planted_removed', { set_id: setId });
          await load(['success', 'The exercise was removed.']);
          if (onChanged) onChanged();
        } catch (exc) { msg.problem(exc); }
      } }, 'Remove the exercise'));
    }
    const seed = numberInput({ value: '', min: 0, max: 999999, step: 1 });
    seed.placeholder = 'a new one';
    const counts = Object.fromEntries(KINDS.map((k) => [k, numberInput({ value: 1, min: 0, max: 20, step: 1 })]));
    const make = actionButton(p ? 'Make it again' : 'Make the exercise', { kind: p ? '' : 'primary', working: 'Making…', msg, log: 'planted-make', onClick: async () => {
      const out = await api.write('set_planted_make', { set_id: setId, recording_id: recordingId,
        ...makeBody(seed.value, Object.fromEntries(KINDS.map((k) => [k, counts[k].value]))) });
      logger.event('planted_made', { set_id: setId, n_errors: out.planted.n_errors, capped: out.planted.capped });
      await load(['success', `The exercise is made.${(out.warnings || []).length ? ` ${out.warnings.join(' ')}` : ''}`]);
      if (onChanged) onChanged();
    } });
    const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'An annotation file with deliberate mistakes' });
    const fromFile = actionButton('Use this file', { working: 'Reading…', msg, log: 'planted-from', onClick: async () => {
      const f = file.files && file.files[0];
      if (!f) throw new Error('Choose an annotation file (_annotations.json) first.');
      let doc;
      try { doc = JSON.parse(await f.text()); } catch { throw new Error(`${f.name} is not an annotation file (it is not JSON).`); }
      const out = await api.write('set_planted_from', { set_id: setId, recording_id: recordingId, source: { kind: 'document', document: doc } });
      logger.event('planted_made', { set_id: setId, n_errors: out.planted.n_errors, from: 'document' });
      await load(['success', `The exercise is made from ${f.name}.`]);
      if (onChanged) onChanged();
    } });
    append(body, [ // append() leaves out the parts this state has not got (body.append would write "null")
      h('p', {}, madeText(p)),
      p && p.stale ? h('div.banner', {}, 'The reference of this recording was replaced after the exercise was made, so trainees are not given it. Make it again.') : null,
      ...(p && p.capped ? (p.notes || []).map((n) => h('p.caption', {}, n)) : []),
      errorsTable,
      p ? h('div.btn-row', {}, tryBtn) : null,
      got.done_by ? h('p.caption', {}, `${got.done_by} trainee${got.done_by === 1 ? ' has' : 's have'} done this recording already; their results stay as they were.`) : null,
      h('details.admin-details', p ? {} : { open: '' }, h('summary', {}, p ? 'Make it again' : 'Make the exercise'),
        h('p.caption', {}, 'The study copies the experts\' marks and plants mistakes in the copy: a mark left out, a mark given a type it is easily '
          + 'mistaken for, a start or end moved by two to three times the guided tolerance, and a mark where the experts marked nothing. The same '
          + 'seed always gives the same exercise, so every trainee meets the same one. Small references take fewer mistakes, and the study says so.'),
        h('div.form-grid', {}, field('Seed', seed, { hint: 'Empty: the study chooses one.' }),
          ...KINDS.map((k) => field(KIND_TEXT[k], counts[k]))),
        h('div.btn-row', {}, make)),
      h('details.admin-details', {}, h('summary', {}, 'Use an annotation file with deliberate mistakes'),
        h('p.caption', {}, 'An expert can make the exercise themselves: annotate the recording with the mistakes they want trainees to find, save the '
          + '_annotations.json, and give it here. The study finds the mistakes by comparing it with the reference.'),
        h('div.row.wrap', {}, file, fromFile)),
      removeHost]);
  };
  const load = async (note = null) => {
    msg.clear();
    try {
      const got = await api.read('planted_get', { set_id: setId, recording_id: recordingId });
      show(got);
      if (note) msg.show(note[0], note[1]);
    } catch (exc) {
      clear(body);
      msg.problem(exc);
    }
  };
  host.load = load;
  void load();
  return host;
}

/**
 * Open an exercise to try (purpose "planted"): the recording's file from this computer, checked against
 * the study's copy (in the sandbox, its built-in example), then the annotation view with the exercise.
 */
export function startPlantedTry(app, target, back = { route: 'expert-planted', params: null }) {
  const m = target.manifest || {};
  return app.openFromComputer({ recording_id: target.recording_id, file_name: target.file_name, format: m.format },
    { purpose: { kind: 'planted', route: 'expert-planted-try', target, back, onBack: () => app.showExpert(back.route, back.params),
      title: `Try the exercise: ${target.file_name}`,
      note: 'Open the recording from this computer: its fingerprint is checked against the study\'s copy. The exercise\'s copy of the experts\' marks '
        + 'then opens for you to correct as a trainee would; nothing you change is saved.' } });
}

export { card };
