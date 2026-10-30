// Snippets, a tab of a reference set in Training: the short examples of each artifact type that
// trainees look through in the training path's "Meet the artifacts" (docs/web/api.md, "Training
// stages"). The set offers one for each of the experts' annotations on its guided recordings, with the
// guided note as its explanation; the study team adds its own here (snippet_add), from any recording
// of the set that is not used for practice or the assessment, whose snippets would give the answers
// away. A snippet sent twice is kept once: the browser chooses its ID before sending it.

import { h, clear } from '../ui/dom.js';
import {
  actionButton, card, confirmInline, dataTable, field, loading, messageArea, numberInput, recordingName, select, textArea, textInput,
} from './ui.js';

const time = (s) => `${Number(s.start_s).toFixed(2)}–${Number(s.end_s).toFixed(2)} s`;
const chans = (s) => (s.channels && s.channels.length ? s.channels.join(', ') : 'Every channel');

/** The next free ID of the study team's snippets (s01, s02, …), as the study would choose it. */
export function nextSnippetId(snippets) {
  const taken = new Set((snippets || []).map((x) => x.snippet_id));
  let n = 1;
  while (taken.has(`s${String(n).padStart(2, '0')}`)) n += 1;
  return `s${String(n).padStart(2, '0')}`;
}

/** The channels typed in the form ("T7, T8"), checked against the recording's: [names] or a problem. */
export function parseChannels(text, chNames) {
  const names = String(text || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  const byLower = new Map((chNames || []).map((c) => [c.toLowerCase(), c]));
  const out = [];
  for (const n of names) {
    const c = byLower.get(n.toLowerCase());
    if (!c) return { problem: `${n} is not a channel of this recording.` };
    if (!out.includes(c)) out.push(c);
  }
  return { channels: out };
}

/** The tab's content for set `s`: what it shows is read from the study (snippets_list) as it opens. */
export function snippetsTab(area, s) {
  const host = h('div.admin-stack', {}, loading());
  const reload = async (note = null) => {
    let data;
    try {
      data = await area.read('snippets_list', { set_id: s.set_id });
    } catch (exc) {
      const msg = messageArea();
      clear(host);
      host.append(msg);
      msg.problem(exc);
      return;
    }
    clear(host);
    host.append(...view(area, s, data, reload, note));
  };
  reload();
  return host;
}

function view(area, s, data, reload, note) {
  const msg = messageArea();
  if (note) msg.show(...note);
  const own = dataTable([
    { title: 'Type', render: (x) => x.label },
    { title: 'Recording', render: (x) => recordingName(x.recording_id) },
    { title: 'Time', render: (x) => time(x) },
    { title: 'Channels', render: (x) => chans(x) },
    { title: 'Explanation', render: (x) => x.explanation || '–' },
    { title: '', cls: 'actions', render: (x) => removeButton(area, s, x, msg, reload) },
  ], data.snippets || [], { empty: 'None added yet. Add one below.', pageSize: 20, caption: 'Snippets added by the study team' });
  const guided = dataTable([
    { title: 'Type', render: (x) => x.label },
    { title: 'Recording', render: (x) => recordingName(x.recording_id) },
    { title: 'Time', render: (x) => time(x) },
    { title: 'The experts\' note', render: (x) => x.explanation || '–' },
  ], data.guided || [], { empty: 'The set has no guided recordings, so none come from them.', pageSize: 20, caption: 'Snippets of the guided recordings' });
  return [
    msg,
    card('Snippets of this set',
      h('p.caption', {}, 'Trainees look through these short examples in the second stage of their training path, Meet the artifacts, '
        + 'each with a little EEG on either side, its type and the explanation. Snippets never come from practice or assessment '
        + 'recordings, which would give their answers away.'),
      own),
    addCard(area, s, data, reload),
    card('From the guided recordings',
      h('p.caption', {}, 'One for each of the experts\' annotations on the guided recordings, with its guided note as the explanation. '
        + 'Change the notes with Edit the guided notes, under Recordings and references.'),
      guided),
  ];
}

function removeButton(area, s, x, msg, reload) {
  const host = h('span.inline-confirm');
  host.append(h('button.btn.small', { type: 'button', 'data-log': 'snippet-remove', onclick: async () => {
    if (!(await confirmInline(host, { text: `Remove the snippet ${x.snippet_id} (${x.label}, ${time(x)})?`, yes: 'Remove', no: 'Keep' }))) return;
    try {
      await area.write('snippet_remove', { set_id: s.set_id, snippet_id: x.snippet_id });
      await reload(['success', `The snippet ${x.snippet_id} was removed.`]);
    } catch (exc) { msg.problem(exc); }
  } }, 'Remove'));
  return host;
}

function addCard(area, s, data, reload) {
  const msg = messageArea();
  const recs = data.recordings || [];
  if (!recs.length) {
    return card('Add a snippet', h('p.caption', {}, 'Add a guided recording to the set first: snippets come from the set\'s own recordings, '
      + 'other than its practice and assessment recordings.'));
  }
  const recording = select(recs.map((r) => [r.recording_id, `${r.file_name} (${r.use})`]));
  const labels = (area.labels || []).map((l) => [l.label, l.label]);
  const label = select(labels, 'Eye-blink-artifact');
  const start = numberInput({ min: 0, step: 0.01, value: '' });
  const end = numberInput({ min: 0, step: 0.01, value: '' });
  const context = numberInput({ min: 0, max: 10, step: 0.5, value: 2 });
  const channels = textInput({ placeholder: 'for example T7, T8 (empty: every channel)' });
  const explanation = textArea({ rows: 3, placeholder: 'What to look for, and why it is marked on these channels' });
  // The ID is chosen here, so that a snippet sent twice (a slow answer, a second press) is kept once.
  let pending = nextSnippetId(data.snippets);
  const add = actionButton('Add the snippet', { kind: 'primary', working: 'Adding…', msg, log: 'snippet-add', onClick: async () => {
    msg.clear();
    const rec = recs.find((r) => r.recording_id === recording.value);
    const a = Number(start.value);
    const b = Number(end.value);
    if (start.value === '' || end.value === '' || !Number.isFinite(a) || !Number.isFinite(b)) throw new Error('Give the start and the end of the artifact in seconds.');
    if (b <= a) throw new Error('The end must be after the start.');
    if (rec && b > rec.duration_s) throw new Error(`The recording is ${rec.duration_s.toFixed(1)} s long.`);
    const ch = parseChannels(channels.value, rec ? rec.ch_names : []);
    if (ch.problem) throw new Error(ch.problem);
    await area.write('snippet_add', { set_id: s.set_id, snippet_id: pending, recording_id: recording.value, start_s: a, end_s: b,
      label: label.value, channels: ch.channels, context_s: Number(context.value || 2), explanation: explanation.value.trim() });
    const added = pending;
    pending = null;
    await reload(['success', `Added the snippet ${added}. Trainees see it in Meet the artifacts.`]);
  } });
  return card('Add a snippet',
    h('p.caption', {}, 'Choose a stretch of a recording that shows one artifact clearly, as the experts would mark it.'),
    h('form.admin-form', { onsubmit: (e) => { e.preventDefault(); add.click(); } },
      field('Recording', recording),
      h('div.row.wrap', {}, field('Type', label), field('Starts at (s)', start), field('Ends at (s)', end),
        field('EEG on each side (s)', context, { hint: 'From 0 to 10.' })),
      field('Channels', channels, { hint: 'The channels the artifact is on, outlined for the trainee.' }),
      field('Explanation', explanation, { hint: 'Up to 1000 characters.' }),
      h('div.btn-row', {}, add), msg));
}
