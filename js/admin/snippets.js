// Snippets, a tab of a reference set in Training: the short examples of each artifact type that
// trainees look through in the training path's "Meet the artifacts" (docs/web/api.md, "Training
// stages"). The set offers one for each of the experts' annotations on its guided recordings, with the
// guided note as its explanation; the study team adds its own here (snippet_add), from any recording
// of the set that is not used for practice or the assessment, whose snippets would give the answers
// away. A snippet sent twice is kept once: the browser chooses its ID before sending it. While
// authoring, the form says how long the recording and the snippet are and what trainees will see, and
// the stretch can be looked at on the EEG from the team's own copy of the recording (read in the
// browser, never uploaded), with the artifact outlined as trainees see it.

import { h, clear } from '../ui/dom.js';
import { clockText } from '../viewer/bounds.js';
import { loadPart } from '../lazy.js';
import { acceptFiles } from '../util.js';
import { DEFAULT_SCALINGS } from '../api/demo_catalogue.js';
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

/**
 * What the times typed so far mean, in one sentence: how long the recording is, how long the snippet
 * lasts and the stretch trainees see with the EEG on each side ("" when the times are not given yet).
 */
export function spanText({ start, end, context, duration }) {
  const dur = Number(duration);
  const long = Number.isFinite(dur) && dur > 0 ? `The recording is ${clockText(dur)} long (${dur.toFixed(1)} s).` : '';
  const a = start === '' || start === null || start === undefined ? NaN : Number(start);
  const b = end === '' || end === null || end === undefined ? NaN : Number(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return long;
  if (b <= a) return `${long} The end must come after the start.`.trim();
  if (Number.isFinite(dur) && dur > 0 && b > dur) return `${long} The snippet ends after the recording does.`.trim();
  const c = Number.isFinite(Number(context)) ? Math.max(0, Number(context)) : 2;
  const from = Math.max(0, a - c);
  const to = Number.isFinite(dur) && dur > 0 ? Math.min(dur, b + c) : b + c;
  return `${long} The snippet lasts ${(b - a).toFixed(2)} s, from ${a.toFixed(2)} to ${b.toFixed(2)} s; trainees see ${from.toFixed(2)} to `
    .concat(`${to.toFixed(2)} s of the recording (${(to - from).toFixed(2)} s).`).trim();
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
  const span = h('p.caption.snippet-span', { 'aria-live': 'polite' });
  const preview = snippetPreview(area, recs, () => ({ recordingId: recording.value, start: start.value, end: end.value, context: context.value,
    label: label.value, channels: channels.value }));
  const sync = () => {
    const rec = recs.find((r) => r.recording_id === recording.value);
    span.textContent = spanText({ start: start.value, end: end.value, context: context.value, duration: rec ? rec.duration_s : NaN });
    preview.redraw();
  };
  for (const el of [recording, start, end, context, label, channels]) {
    el.addEventListener('input', sync);
    el.addEventListener('change', sync);
  }
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
  const box = card('Add a snippet',
    h('p.caption', {}, 'Choose a stretch of a recording that shows one artifact clearly, as the experts would mark it.'),
    h('form.admin-form', { onsubmit: (e) => { e.preventDefault(); add.click(); } },
      field('Recording', recording),
      h('div.row.wrap', {}, field('Type', label), field('Starts at (s)', start), field('Ends at (s)', end),
        field('EEG on each side (s)', context, { hint: 'From 0 to 10.' })),
      span,
      field('Channels', channels, { hint: 'The channels the artifact is on, outlined for the trainee.' }),
      preview.el,
      field('Explanation', explanation, { hint: 'Up to 1000 characters.' }),
      h('div.btn-row', {}, add), msg));
  sync();
  return box;
}

/**
 * Look at the stretch on the EEG while authoring: the team chooses its own copy of the recording (read in
 * the browser, never uploaded; the sandbox offers its built-in copy), and the snippet is drawn as trainees
 * will see it, the artifact outlined on its channels, and drawn again as the times change.
 */
function snippetPreview(area, recs, current) {
  const opened = new Map(); // recording ID -> { recording, channels }
  const status = h('p.caption.snippet-preview-status', { 'aria-live': 'polite' });
  const host = h('div.quiz-eeg.snippet-eeg.admin-snippet-eeg', { hidden: true });
  let viewer = null;
  let drawn = '';
  const input = h('input', { type: 'file', multiple: true, accept: acceptFiles('.edf,.bdf,.rec,.vhdr,.vmrk,.eeg'), hidden: true, 'data-log': 'snippet-preview-file' });
  const look = h('button.btn.small', { type: 'button', 'data-log': 'snippet-preview', onclick: () => input.click() }, 'Look at it on the EEG…');
  const backend = area.backend;
  const example = backend && backend.isDemo && typeof backend.exampleRecording === 'function'
    ? h('button.btn.small', { type: 'button', 'data-log': 'snippet-preview-example', onclick: () => open(null) }, 'Use the built-in copy') : null;
  const meta = () => recs.find((r) => r.recording_id === current().recordingId);
  async function open(files) {
    const m = meta();
    if (!m) return;
    status.textContent = `Reading ${m.file_name}…`;
    try {
      let rec;
      if (files) {
        const { filesForRecording } = await loadPart('open');
        const chosen = filesForRecording(files, m.file_name);
        if (!chosen || !chosen.some((f) => f.name === m.file_name)) throw new Error(`choose the file ${m.file_name} (and its companion files, for BrainVision).`);
        const f = (area.app.me && area.app.me.study && area.app.me.study.filters) || {};
        rec = await (await loadPart('readers')).openRecording(chosen, { fileName: m.file_name, filters: {
          highpassHz: f.highpass_enabled === false ? null : (f.highpass_hz || 1.0), notchHz: f.notch_enabled === false ? null : (f.notch_hz || 50.0),
          notchHarmonics: Boolean(f.notch_harmonics) } });
      } else {
        rec = backend.exampleRecording(m.recording_id);
      }
      const { displayChannels } = await loadPart('session');
      opened.set(m.recording_id, { recording: rec, channels: displayChannels(rec, { ch_names: m.ch_names || rec.channels.map((c) => c.name) }) });
      drawn = '';
      await draw();
    } catch (exc) {
      status.textContent = `${m.file_name} could not be opened: ${exc.message}`;
    }
  }
  input.addEventListener('change', () => { if (input.files.length) open([...input.files]); input.value = ''; });
  async function draw() {
    const c = current();
    const o = opened.get(c.recordingId);
    const m = meta();
    if (!o || !m) {
      host.hidden = true;
      if (viewer) { viewer.destroy(); viewer = null; }
      status.textContent = m ? `To look at the stretch, open your copy of ${m.file_name}: it is read here and never uploaded.` : '';
      return;
    }
    const a = Number(c.start);
    const b = Number(c.end);
    if (c.start === '' || c.end === '' || !(b > a) || b > o.recording.durationS) {
      host.hidden = true;
      status.textContent = 'Give the start and the end of the artifact to see it here.';
      return;
    }
    const key = JSON.stringify(c);
    if (key === drawn && viewer) return;
    drawn = key;
    const [{ segmentBounds, segmentRecording }, { EegViewer }] = await Promise.all([loadPart('quiz'), loadPart('viewer')]);
    const rec = o.recording;
    const item = { start_s: a, end_s: b, context_s: Number(c.context) };
    const { s0, s1, h0, h1 } = segmentBounds(item, rec.sfreq, rec.nSamples);
    const seg = segmentRecording(rec, s0, s1);
    const names = String(c.channels || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const outlined = o.channels.map((ch) => ch.name).filter((n) => names.includes(n.toLowerCase()));
    if (viewer) viewer.destroy();
    clear(host);
    host.hidden = false;
    viewer = new EegViewer(host, {
      recording: seg, channels: o.channels, scalings: { ...DEFAULT_SCALINGS }, events: [], gaps: [], catalogue: area.catalogue,
      view: { duration_s: seg.durationS, n_channels: o.channels.length },
    });
    viewer.setView({ startS: 0, durationS: seg.durationS, nChannels: o.channels.length, firstChannel: 0 }, 'snippet');
    viewer.setGhost({ label: c.label, onset_sample: h0, duration_samples: h1 - h0, channels: outlined });
    status.textContent = `As trainees see it: ${(seg.durationS).toFixed(2)} s from ${(s0 / rec.sfreq).toFixed(2)} s of ${m.file_name}, `
      + `the artifact outlined ${outlined.length ? `on ${outlined.join(', ')}` : 'on every channel'}.`;
  }
  let timer = 0;
  const redraw = () => { clearTimeout(timer); timer = setTimeout(() => { draw(); }, 250); };
  const el = h('div.snippet-preview', {}, h('div.btn-row', {}, look, example, input), status, host);
  return { el, redraw };
}
