// The short-segment quiz, which follows the quiz of the former desktop application: one short EEG
// segment at a time, with the question "Which artifact type is the main one in the shaded
// segment?", the answers grouped by family as in the annotation view, feedback after each answer
// or at the end as the quiz requires, and the score. The segments are shown from the annotator's own
// copies of the recordings, opened from their computer and checked against the fingerprints in the
// study's manifests; the EEG never leaves the computer. The study keeps the answers and the
// correct ones (POST /quiz/{set_id}, docs/web/api.md), so an annotator can stop and carry on later.

import { h, clear } from '../ui/dom.js';
import { choose } from '../ui/dialog.js';
import { appHeader, icon } from '../views/common.js';
import { filesForRecording } from '../views/open.js';
import { EegViewer } from '../viewer/viewer.js';
import { displayChannels } from '../annotate/session.js';
import { logger } from '../log/logger.js';
import { DEFAULT_SCALINGS } from '../api/demo_catalogue.js';
import { CAN_CHOOSE_FOLDER, acceptFiles } from '../util.js';
import { linkPanel } from '../views/links_panel.js';
import { loadPart } from '../lazy.js';
import { feedbackText, quizCard } from './quiz_card.js';

export { feedbackText, quizCard };

/** The answer for a segment without an artifact (electrotag.training.reference.NONE_OPTION). */
export const NONE_OPTION = 'No artifact / none of these';
export const QUESTION = 'Which artifact type is the main one in the shaded segment?';
/** The label of the shaded segment in the viewer (drawn in the accent colour). */
const SEGMENT_LABEL = '\u0000quiz-segment';
const SEGMENT_COLOUR = '#2B4392'; // the design's accent (ink blue), its colour for what is chosen

// ------------------------------------------------------------------ pure helpers
/** Python's round(): halves to the even neighbour (the desktop application cut segments with it). */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** The position of the first item not answered yet (items.length when all are). */
export function nextIndex(items, answered) {
  const i = items.findIndex((it) => !(answered && Object.hasOwn(answered, it.item_id)));
  return i < 0 ? items.length : i;
}

/**
 * The samples of an item's segment with its context, and of the shaded part within it, as the
 * desktop application cut them (tmin = start - context, tmax = end + context, within the recording).
 * @returns {{s0: number, s1: number, h0: number, h1: number}} h0, h1 relative to s0
 */
export function segmentBounds(item, sfreq, nSamples) {
  const duration = nSamples / sfreq;
  const context = Number.isFinite(Number(item.context_s)) ? Number(item.context_s) : 2.0;
  const tmin = Math.max(0, Number(item.start_s) - context);
  const tmax = Math.min(duration, Number(item.end_s) + context);
  const s0 = Math.max(0, Math.min(nSamples, pyRound(tmin * sfreq)));
  const s1 = Math.max(s0 + 1, Math.min(nSamples, pyRound(tmax * sfreq)));
  const h0 = Math.max(0, Math.round((Number(item.start_s) - tmin) * sfreq));
  const h1 = Math.min(s1 - s0, Math.max(h0 + 1, Math.round((Number(item.end_s) - tmin) * sfreq)));
  return { s0, s1, h0, h1 };
}

/**
 * The answers under their family headings, in the order given (the catalogue's, as the study sends
 * them): an answer that is not in the catalogue (the "no artifact" answer) comes under "Other".
 * @param {string[]} options
 * @param {import('../catalogue.js').Catalogue} catalogue
 */
export function groupOptions(options, catalogue) {
  const groups = [];
  for (const value of options) {
    const lab = catalogue && catalogue.has(value) ? catalogue.get(value) : null;
    const heading = lab ? lab.section || 'Other' : 'Other';
    let g = groups[groups.length - 1];
    if (!g || g.heading !== heading) {
      g = { heading, options: [] };
      groups.push(g);
    }
    g.options.push({
      value,
      text: lab && lab.is_group ? `${value}  (group: exact type unclear)` : value,
      colour: lab ? lab.colour : null,
      group: Boolean(lab && lab.is_group),
      description: lab ? lab.description || '' : value === NONE_OPTION ? 'The segment holds no artifact, or none of the types listed.' : '',
    });
  }
  return groups;
}

/** A part [s0, s1) of a recording, shown as a recording of its own (time starts at 0). */
export function segmentRecording(recording, s0, s1) {
  return {
    format: recording.format,
    fileName: recording.fileName,
    sfreq: recording.sfreq,
    nSamples: s1 - s0,
    durationS: (s1 - s0) / recording.sfreq,
    channels: recording.channels,
    async readWindow(req) {
      const start = Math.max(0, Math.floor(req.startSample || 0));
      const n = Math.max(0, Math.min(Math.floor(req.nSamples || 0), s1 - s0 - start));
      const r = await recording.readWindow({ ...req, startSample: s0 + start, nSamples: n });
      return { ...r, startSample: r.startSample - s0, edgeZones: (r.edgeZones || []).map(([a, b]) => [a - s0, b - s0]) };
    },
  };
}

/** "Correct." or what the right answer was. */
export function verdictText(result) {
  if (result.correct) return 'Correct.';
  return result.correct_label ? `Not quite: the expected answer is ${result.correct_label}.` : 'Not quite.';
}

/**
 * "You answered 4 of 6 segments correctly (67%)." For a quiz finished before every segment was
 * answered (an incomplete result), the proportion is of the segments answered, as in
 * QuizSession.score() (electrotag/training/quiz.py).
 */
export function scoreText(score) {
  const items = score.n_items ?? score.n_answered ?? 0;
  const answered = score.n_answered ?? items;
  const n = Math.min(items, answered);
  const p = Number.isFinite(score.proportion_correct) ? score.proportion_correct : (n ? (score.n_correct || 0) / n : NaN);
  const text = `You answered ${score.n_correct || 0} of ${n} segment${n === 1 ? '' : 's'} correctly${Number.isFinite(p) ? ` (${Math.round(100 * p)}%)` : ''}.`;
  const missing = items - answered;
  return missing > 0 ? `${text} ${missing} of the ${items} segments ${missing === 1 ? 'was' : 'were'} not answered.` : text;
}

/** The quiz mode as the logs and the saved results name it: feedback after each answer is practice. */
export function quizMode(feedback) {
  return feedback === 'immediate' ? 'practice' : 'assessment';
}

/** Keep the card's count of answers (GET /me's quizzes) in step with this page's. */
function noteAnswered(app, setId, n, finished = false) {
  for (const q of (app.me && app.me.quizzes) || []) {
    if (q.set_id !== setId) continue;
    q.n_answered = n;
    if (finished) q.finished = true;
  }
}

// --------------------------------------------------------------------- the view
async function openRecordingFiles(files, options) {
  return (await loadPart('readers')).openRecording(files, options);
}

function studyFilters(me) {
  const f = (me && me.study && me.study.filters) || {};
  return {
    highpassHz: f.highpass_enabled === false ? null : (f.highpass_hz || 1.0),
    notchHz: f.notch_enabled === false ? null : (f.notch_hz || 50.0),
    notchHarmonics: Boolean(f.notch_harmonics),
  };
}

const round3 = (x) => Math.round(x * 1000) / 1000;

export class QuizView {
  /**
   * @param {object} app the application (backend, me, catalogue, goBack)
   * @param {string} setId
   * @param {object} [o] from the training path's snippets: `shared`, the recordings already open there
   *   (recording_id -> {recording, channels, manifest}), used without opening them again when they are the
   *   study's same copies, and `onLeave`, which goes back there instead of app.goBack()
   */
  constructor(app, setId, { shared = null, onLeave = null } = {}) {
    this.app = app;
    this.shared = shared;
    this.onLeave = onLeave;
    this.backend = app.backend;
    this.setId = setId;
    this.catalogue = app.catalogue;
    this.opened = new Map(); // recording_id -> {recording, channels, manifest, owned}
    this.answered = {};
    this.items = [];
    this.data = null;
    this.viewer = null;
    this.busy = false;
    this.closed = false;
    this.awaitingNext = false;
    this.progress = h('p.subtitle.quiz-progress', { 'aria-live': 'polite' });
    this.title = h('h1', {}, 'Quiz');
    this.stopBtn = h('button.btn.quiet', { type: 'button', 'data-log': 'quiz-stop', onclick: () => this.stop() }, icon('arrow-left'), 'Stop the quiz');
    this.body = h('div.quiz-body');
    // one main landmark holds the quiz's bar and whatever it shows (the pages, or a segment and its question)
    this.el = h('div.view.quiz', { 'data-view': 'quiz' }, appHeader(app),
      h('main.quiz-frame', {}, h('div.quiz-bar', {}, this.stopBtn, h('div.quiz-heading', {}, this.title, this.progress)),
        this.body));
  }

  get mode() { return quizMode(this.data && this.data.feedback); }

  get immediate() { return Boolean(this.data && this.data.feedback === 'immediate'); }

  _set(...children) {
    if (this.viewer) {
      this.viewer.destroy();
      this.viewer = null;
    }
    clear(this.body);
    this.body.append(...children.flat());
  }

  _page(...children) {
    return h('div.page.narrow.quiz-page', {}, ...children);
  }

  async start() {
    this._set(this._page(h('p.subtitle', {}, 'Loading the quiz…')));
    let data;
    try {
      data = await this.backend.quiz(this.setId, { action: 'get' });
    } catch (exc) {
      if (this.closed || exc.status === 401) return;
      // a quiz that is not the annotator's (403) or no longer exists (404) will not load on a second try
      const final = exc.status === 403 || exc.status === 404;
      this._set(this._page(h('div.banner', { role: 'alert' }, h('p', {}, `The quiz could not be loaded: ${exc.message}`),
        h('div.btn-row', {}, final ? null : h('button.btn.primary', { type: 'button', onclick: () => this.start() }, 'Try again'),
          h(`button.btn${final ? '.primary' : ''}`, { type: 'button', onclick: () => this.leave() }, 'Back')))));
      return;
    }
    if (this.closed) return;
    this.data = data;
    this.items = data.items || [];
    this.answered = { ...(data.answered || {}) };
    this.title.textContent = `Quiz: ${data.name || this.setId}`;
    logger.event('quiz_opened', { set_id: this.setId, n_items: this.items.length, answered: Object.keys(this.answered).length,
      quiz_mode: this.mode, finished: Boolean(data.finished) });
    if (data.finished) {
      this._showFinished();
      return;
    }
    this._borrow();
    this.next();
  }

  /** The recordings the snippets have open already, when they are the study's same copies: lent, never closed here. */
  _borrow() {
    for (const [rid, o] of (this.shared instanceof Map ? this.shared : new Map())) {
      const m = this._manifest(rid);
      const want = m && m.fingerprint ? String(m.fingerprint.hex || '').toLowerCase() : '';
      const have = o.manifest && o.manifest.fingerprint ? String(o.manifest.fingerprint.hex || '').toLowerCase() : '';
      if (!want || want !== have || this.opened.has(rid)) continue;
      this.opened.set(rid, { recording: o.recording, channels: o.channels, manifest: m, owned: false });
      logger.event('quiz_recording_reused', { recording_id: rid });
    }
  }

  /** The items still to answer, and which recordings they need (in order). */
  _needed() {
    const out = [];
    for (const it of this.items) {
      if (Object.hasOwn(this.answered, it.item_id)) continue;
      if (!out.includes(it.recording_id)) out.push(it.recording_id);
    }
    return out;
  }

  _manifest(recordingId) {
    return (this.data.recordings || {})[recordingId] || null;
  }

  next() {
    if (this.closed) return;
    this.awaitingNext = false;
    if (this.stale) {
      this.stale = false;
      this._reload();
      return;
    }
    const i = nextIndex(this.items, this.answered);
    if (i >= this.items.length) {
      this.finish();
      return;
    }
    const item = this.items[i];
    if (!this.opened.has(item.recording_id)) this._showOpen(item);
    else this._showItem(i);
  }

  // --------------------------------------------------- opening the recordings
  _showOpen(item, problems = []) {
    this.progress.textContent = `Segment ${nextIndex(this.items, this.answered) + 1} of ${this.items.length}`;
    const needed = this._needed();
    const fileInput = h('input', { type: 'file', multiple: true, accept: acceptFiles('.edf,.bdf,.rec,.vhdr,.vmrk,.eeg'), hidden: true, 'data-log': 'quiz-file-input',
      onchange: () => { if (fileInput.files.length) this._openFiles([...fileInput.files], item); fileInput.value = ''; } });
    const folderInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, hidden: true, 'data-log': 'quiz-folder-input',
      onchange: () => { if (folderInput.files.length) this._openFiles([...folderInput.files], item); folderInput.value = ''; } });
    const list = h('ul.quiz-files', {}, needed.map((rid) => {
      const m = this._manifest(rid);
      const ok = this.opened.has(rid);
      return h('li', { 'data-recording': rid },
        h('span.file', { title: rid }, m ? m.file_name : rid),
        h(`span.chip${ok ? '.done' : rid === item.recording_id ? '.active' : ''}`, {}, ok ? 'Opened' : rid === item.recording_id ? 'Needed now' : 'Needed later'));
    }));
    this.steps = h('ol.steps', { hidden: true, 'aria-live': 'polite' });
    const drop = h('div.dropzone', { 'aria-label': 'Drop the recordings here' },
      h('p.drop-title', {}, 'Drop the recordings here'),
      h('p.caption', {}, 'or'),
      h('div.btn-row.center', {},
        h('button.btn.primary', { type: 'button', 'data-log': 'quiz-choose-files', onclick: () => fileInput.click() }, 'Choose files…'),
        CAN_CHOOSE_FOLDER ? h('button.btn', { type: 'button', 'data-log': 'quiz-choose-folder', onclick: () => folderInput.click() }, 'Choose a folder…') : null),
      fileInput, folderInput);
    for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
      if (files.length) this._openFiles(files, item);
    });
    let example = null;
    if (this.backend.isDemo && typeof this.backend.exampleRecording === 'function') {
      example = h('section.card.example-card', {}, h('h2', {}, 'No EEG files to hand?'),
        h('p.caption', {}, 'Use the built-in copies of the example recordings.'),
        h('div.btn-row', {}, h('button.btn', { type: 'button', 'data-log': 'quiz-use-examples', onclick: () => this._useExamples(item) }, 'Use the example recordings')));
    }
    const m = this._manifest(item.recording_id);
    this._set(this._page(
      h('h2', {}, `Open ${m ? m.file_name : item.recording_id}`),
      h('p.subtitle', {}, 'The segments of this quiz come from recordings of the study. Open your copy of each one from your computer: it is read here, in your browser, and never uploaded. Its fingerprint is checked against the study\'s copy.'),
      this._howItWorks(),
      problems.length ? h('div.banner', { role: 'alert' }, problems.map((p) => h('p', {}, p))) : null,
      h('section.card', {}, h('h2', {}, needed.length === 1 ? 'The recording of this quiz' : 'The recordings of this quiz'),
        h('p.caption', {}, 'For a BrainVision recording choose its .vhdr, .vmrk and .eeg files together, or the folder that holds them. A folder may hold all of them.'),
        list, drop, this._linkPanel(item, fileInput), this.steps),
      example));
  }

  /** What the quiz asks and how to answer (the quiz's help, above the recordings to open). */
  _howItWorks() {
    return h('details.card.quiz-help', { 'data-log': 'quiz-help' }, h('summary', {}, 'How the quiz works'),
      h('p', {}, 'Each segment shows a few seconds of EEG with the part to judge shaded. Choose the main artifact type in the ' +
        'shaded part from the list on the right, then press Submit answer (or Enter). The description of the type you choose ' +
        'appears under the list; the types are grouped by family as in the annotation view, and a group term in italics is for ' +
        'an artifact whose exact type is unclear.'),
      h('p', {}, this.immediate ? 'After each answer you see whether it was right, with the experts\' explanation.'
        : 'Your result is shown at the end, when every segment is answered.'),
      h('p', {}, 'Stop the quiz keeps your answers with the study, so you can carry on another time, or ends the quiz with the ' +
        'score of the segments you answered.'));
  }

  /** "Open from a link" (js/views/links_panel.js) for the recording needed now. */
  _linkPanel(item, fileInput) {
    return linkPanel({ onFiles: (files) => this._openFiles(files, item), chooseFile: () => fileInput.click() }).el;
  }

  _step(key, text, state = 'working') {
    if (!this.steps) return;
    this.steps.hidden = false;
    let li = this.steps.querySelector(`[data-step="${CSS.escape(key)}"]`);
    if (!li) {
      li = h('li.step', { 'data-step': key });
      this.steps.appendChild(li);
    }
    li.className = `step ${state}`;
    clear(li);
    li.append(h('span.step-icon', { 'aria-hidden': 'true' }, state === 'done' ? icon('check') : state === 'failed' ? icon('close') : '…'), h('span', {}, text));
  }

  /** Open the needed recordings found among the picked files and check them. */
  async _openFiles(files, item) {
    if (this.busy) return;
    this.busy = true;
    const problems = [];
    try {
      let any = false;
      for (const rid of this._needed()) {
        if (this.opened.has(rid)) continue;
        const m = this._manifest(rid);
        if (!m) continue;
        const chosen = filesForRecording(files, m.file_name);
        if (!chosen || !chosen.length || !chosen.some((f) => f.name === m.file_name)) continue;
        any = true;
        const problem = await this._check(rid, m, { files: chosen });
        if (problem) problems.push(problem);
        if (this.closed) return;
      }
      if (!any) {
        const names = this._needed().filter((rid) => !this.opened.has(rid)).map((rid) => (this._manifest(rid) || {}).file_name || rid);
        problems.push(`None of the files chosen is ${names.length === 1 ? names[0] : `one of ${names.join(', ')}`}.`);
      }
    } finally {
      this.busy = false;
    }
    if (this.closed) return;
    if (this.opened.has(item.recording_id)) this.next();
    else this._showOpen(item, problems);
  }

  /** Demonstration: the built-in copies of the example recordings. */
  async _useExamples(item) {
    if (this.busy) return;
    this.busy = true;
    const problems = [];
    try {
      for (const rid of this._needed()) {
        if (this.opened.has(rid)) continue;
        const m = this._manifest(rid);
        if (!m) continue;
        let recording;
        try { recording = this.backend.exampleRecording(rid); } catch { continue; }
        const problem = await this._check(rid, m, { recording });
        if (problem) problems.push(problem);
        if (this.closed) return;
      }
    } finally {
      this.busy = false;
    }
    if (this.closed) return;
    if (this.opened.has(item.recording_id)) this.next();
    else this._showOpen(item, problems);
  }

  /** Read a recording and compare it with the study's manifest; returns a problem or null. */
  async _check(rid, manifest, { files = null, recording = null }) {
    const name = manifest.file_name;
    const owned = !recording;
    this._step(rid, `Reading ${name}…`);
    let rec = recording;
    try {
      if (!rec) rec = await openRecordingFiles(files, { fileName: name, filters: studyFilters(this.app.me) });
      const fp = await rec.fingerprint((f) => this._step(rid, `Checking ${name} (its fingerprint) ${Math.round(f * 100)}%`));
      const want = manifest.fingerprint || {};
      const same = fp.hex === String(want.hex || '').toLowerCase() && (!want.size_bytes || fp.sizeBytes === want.size_bytes);
      logger.event('quiz_recording_checked', { set_id: this.setId, recording_id: rid, file_name: rec.fileName, matched: same });
      if (!same) {
        if (owned) rec.close();
        this._step(rid, `${name} is not the study's copy`, 'failed');
        return `${rec.fileName} is not the study's copy of ${name}: its fingerprint differs, so its contents are not exactly the same. Choose the study's copy.`;
      }
      if (manifest.channel_types && typeof rec.setChannelTypes === 'function') rec.setChannelTypes(manifest.channel_types);
      const channels = displayChannels(rec, manifest);
      this.opened.set(rid, { recording: rec, channels, manifest, owned });
      this._step(rid, `Opened ${name}`, 'done');
      return null;
    } catch (exc) {
      if (rec && owned) rec.close();
      this._step(rid, `${name} could not be opened`, 'failed');
      return `${name} could not be opened: ${exc.message}`;
    }
  }

  // --------------------------------------------------------- showing an item
  _showItem(i) {
    const item = this.items[i];
    const o = this.opened.get(item.recording_id);
    const rec = o.recording;
    const sf = rec.sfreq;
    const { s0, s1, h0, h1 } = segmentBounds(item, sf, rec.nSamples);
    const seg = segmentRecording(rec, s0, s1);
    this.progress.textContent = `Segment ${i + 1} of ${this.items.length}`;
    const groups = groupOptions(item.options || [], this.catalogue);
    const form = h('form.quiz-options', { 'aria-label': 'Answers', onsubmit: (e) => { e.preventDefault(); this.submit(); },
      // Enter on a chosen answer sends it (a form of radio buttons alone has no submit of its own)
      onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.submit(); } },
      onchange: () => this._describeChosen() },
      groups.map((g) => h('fieldset.quiz-group', {},
        h('legend', {}, g.heading),
        g.options.map((opt) => h(`label.quiz-option${opt.group ? '.group' : ''}`, { title: opt.description || opt.value },
          h('input', { type: 'radio', name: 'quiz-answer', value: opt.value, 'data-log': 'quiz-option' }),
          opt.colour ? h('span.swatch', { style: { background: opt.colour } }) : h('span.swatch.none'),
          h('span', {}, opt.text))))));
    this.form = form;
    this.optionDescriptions = new Map(groups.flatMap((g) => g.options.map((o) => [o.value, o.description || ''])));
    this.chosenNote = h('p.caption.quiz-chosen', { 'aria-live': 'polite' }, 'Choose the type you see most in the shaded part; its description appears here.');
    this.feedback = h('div.quiz-feedback', { 'aria-live': 'polite' });
    this.submitBtn = h('button.btn.primary.wide', { type: 'button', 'data-log': 'quiz-submit', onclick: () => this.submit() }, 'Submit answer');
    const host = h('div.quiz-eeg');
    const side = h('aside.quiz-side', { 'aria-label': 'Question' },
      h('p.quiz-question', {}, h('b', {}, QUESTION)),
      h('div.quiz-scroll', {}, form),
      this.chosenNote,
      this.feedback,
      this.submitBtn);
    this._set(h('div.quiz-main', {}, host, side));
    const study = (this.app.me && this.app.me.study) || {};
    const scalings = { ...DEFAULT_SCALINGS, ...((study.display && study.display.scalings) || {}),
      ...((o.manifest.display && o.manifest.display.scalings) || {}) };
    const gaps = (o.manifest.gaps || []).map(([a, b]) => [Math.max(0, a - s0), Math.min(s1 - s0, b - s0)]).filter(([a, b]) => b > a);
    const base = this.catalogue;
    const catalogue = {
      colourFor: (label) => (label === SEGMENT_LABEL ? SEGMENT_COLOUR : base.colourFor(label)),
      has: (label) => base.has(label), get: (label) => base.get(label),
    };
    this.viewer = new EegViewer(host, {
      recording: seg, channels: o.channels, scalings, events: [], gaps, catalogue, filters: studyFilters(this.app.me),
      view: { duration_s: seg.durationS, n_channels: o.channels.length },
    });
    this.viewer.setView({ startS: 0, durationS: seg.durationS, nChannels: o.channels.length, firstChannel: 0 }, 'quiz');
    this.viewer.setGhost({ label: SEGMENT_LABEL, onset_sample: h0, duration_samples: h1 - h0, channels: [] });
    this.current = { index: i, item };
    this.shownAt = performance.now();
    logger.event('quiz_item_shown', { item_id: item.item_id, index: i + 1, n_items: this.items.length, quiz_mode: this.mode, set_id: this.setId });
  }

  /** The chosen answer's description under the list (the same text as its tooltip). */
  _describeChosen() {
    const label = this._chosen();
    if (!label || !this.chosenNote) return;
    const d = this.optionDescriptions.get(label);
    this.chosenNote.textContent = d ? `${label}: ${d}` : label;
  }

  _chosen() {
    const checked = this.form && this.form.querySelector('input[name="quiz-answer"]:checked');
    return checked ? checked.value : null;
  }

  async submit() {
    if (this.busy || this.closed || !this.current) return;
    if (this.awaitingNext) {
      this.next();
      return;
    }
    const label = this._chosen();
    if (!label) {
      this.feedback.className = 'quiz-feedback banner';
      this.feedback.textContent = 'Please choose an answer.';
      return;
    }
    const { item } = this.current;
    const rt = round3((performance.now() - this.shownAt) / 1000);
    this.busy = true;
    this.submitBtn.disabled = true;
    this.submitBtn.textContent = 'Sending…';
    let res;
    try {
      // the time from showing the segment to the answer, kept with the answer in the saved result
      res = await this.backend.quiz(this.setId, { action: 'answer', item_id: item.item_id, label, response_time_s: rt });
    } catch (exc) {
      this.busy = false;
      if (this.closed) return;
      this.submitBtn.disabled = false;
      this.submitBtn.textContent = 'Submit answer';
      if (exc.status === 409) {
        // The study already has an answer for this segment (sent from another tab, or before a
        // reply was lost), or the quiz was finished elsewhere: carry on from what the study has.
        const kept = exc.code === 'already_answered' && exc.body && typeof exc.body.label === 'string' ? exc.body.label : null;
        logger.event('quiz_answer_refused', { item_id: item.item_id, reason: exc.code || 'conflict', kept_answer: kept, quiz_mode: this.mode, set_id: this.setId });
        await this._reload(kept ? `Your earlier answer to that segment, ${kept}, is the one kept.`
          : exc.code === 'finished' ? 'This quiz was finished on another page or computer.' : '');
        return;
      }
      if (exc.status !== 401) {
        this.feedback.className = 'quiz-feedback banner';
        this.feedback.textContent = `Your answer could not be sent: ${exc.message} Try again.`;
      }
      return;
    }
    this.busy = false;
    if (this.closed) return;
    const correct = res && typeof res.correct === 'boolean' ? res.correct : null;
    this.answered[item.item_id] = { label, correct };
    noteAnswered(this.app, this.setId, Object.keys(this.answered).length);
    // The study counts more answers than this page knows of (some were given on another page):
    // the next step loads the quiz again rather than offer those segments a second time.
    this.stale = Number.isInteger(res && res.n_answered) && res.n_answered > Object.keys(this.answered).length;
    logger.event('quiz_answer', { item_id: item.item_id, answer: label, correct, response_time_s: rt, quiz_mode: this.mode, set_id: this.setId });
    if (this.immediate && correct !== null) {
      this.feedback.className = `quiz-feedback ${correct ? 'success' : 'banner'}`;
      clear(this.feedback);
      this.feedback.append(h('b', {}, verdictText(res)), res.explanation ? ` ${res.explanation}` : '');
      for (const input of this.form.querySelectorAll('input')) {
        input.disabled = true;
        if (input.checked) input.closest('label').classList.add('chosen'); // your answer stays clear
      }
      const last = nextIndex(this.items, this.answered) >= this.items.length;
      this.submitBtn.disabled = false;
      this.submitBtn.textContent = last ? 'See my result' : 'Next segment';
      this.awaitingNext = true;
      this.submitBtn.focus();
      return;
    }
    this.next();
  }

  /** Load the quiz again and carry on from what the study has; `note` says why, on the next screen. */
  async _reload(note = '') {
    if (this.reloading) return;
    this.reloading = true;
    try {
      const data = await this.backend.quiz(this.setId, { action: 'get' });
      if (this.closed) return;
      this.data = { ...this.data, ...data, recordings: { ...(this.data.recordings || {}), ...(data.recordings || {}) } };
      this.items = data.items || this.items;
      this.answered = { ...(data.answered || {}) };
      noteAnswered(this.app, this.setId, Object.keys(this.answered).length);
      if (data.finished) this._showFinished();
      else this.next();
      if (note) {
        const where = this.body.querySelector('.quiz-feedback') || this.body.querySelector('.quiz-page, .quiz-side');
        if (where && where.classList.contains('quiz-feedback')) {
          where.className = 'quiz-feedback note';
          where.textContent = note;
        } else if (where) {
          const p = h('p.note.quiz-note', {}, note);
          const heading = where.querySelector('h2');
          if (heading) heading.after(p); else where.prepend(p);
        }
      }
    } catch (exc) {
      if (this.closed) return;
      this.feedback.className = 'quiz-feedback banner';
      this.feedback.textContent = `The quiz could not be loaded again: ${exc.message}`;
    } finally {
      this.reloading = false;
    }
  }

  // ------------------------------------------------------------------- the end
  async finish() {
    if (this.busy || this.closed) return;
    this.busy = true;
    const answered = Object.keys(this.answered).length;
    this.progress.textContent = `${answered} of ${this.items.length} segments answered`;
    this._set(this._page(h('p.subtitle', {}, 'Saving your answers…')));
    let res;
    try {
      res = await this.backend.quiz(this.setId, { action: 'finish' });
    } catch (exc) {
      this.busy = false;
      if (this.closed || exc.status === 401) return;
      this._set(this._page(h('div.banner', { role: 'alert' }, h('p', {}, `Your result could not be saved: ${exc.message}`),
        h('div.btn-row', {}, h('button.btn.primary', { type: 'button', 'data-log': 'quiz-finish-again', onclick: () => this.finish() }, 'Try again')))));
      return;
    }
    this.busy = false;
    if (this.closed) return;
    const score = (res && res.score) || {};
    logger.event('quiz_finished', { n_items: score.n_items, n_correct: score.n_correct, proportion_correct: score.proportion_correct ?? null,
      quiz_mode: this.mode, set_id: this.setId });
    this._closeRecordings();
    noteAnswered(this.app, this.setId, answered, true);
    // ended before every segment was answered: the result says so, and is of the segments answered
    this._showScore(score, { heading: answered < this.items.length ? 'Quiz ended early' : 'Quiz complete' });
  }

  _showScore(score, { heading = 'Quiz complete' } = {}) {
    this.stopBtn.replaceChildren(icon('arrow-left'), 'Back');
    const rows = Object.entries(score.by_category || {}).map(([label, c]) => h('tr', {},
      h('td', {}, this.catalogue && this.catalogue.has(label) ? h('span.swatch', { style: { background: this.catalogue.colourFor(label) } }) : null, ` ${label}`),
      h('td.num', {}, String(c.items)), h('td.num', {}, String(c.correct))));
    this._set(this._page(
      h('h2', {}, heading),
      h('p.success.quiz-score', { role: 'status' }, scoreText(score)),
      rows.length ? h('table.list.quiz-categories', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Main artifact type'), h('th.num', {}, 'Segments'), h('th.num', {}, 'Correct'))),
        h('tbody', {}, rows)) : null,
      h('p.caption', {}, 'Your answers are saved with the study. The quiz tests recognising artifact types; the annotation of whole recordings is assessed separately.'),
      h('div.btn-row', {}, h('button.btn.primary', { type: 'button', 'data-log': 'quiz-done', onclick: () => this.leave() },
        this.onLeave ? 'Back to the examples' : this.app.me && this.app.me.programme && this.app._fromTraining ? 'Back to my training path' : 'Back to my recordings'))));
  }

  _showFinished() {
    this._closeRecordings();
    noteAnswered(this.app, this.setId, Object.keys(this.answered).length, true);
    if (this.data && this.data.score && typeof this.data.score === 'object') {
      // the study gives the score of a finished quiz
      this.progress.textContent = '';
      this._showScore(this.data.score, { heading: 'You have finished this quiz' });
      return;
    }
    const answers = Object.values(this.answered);
    const known = answers.filter((a) => typeof a.correct === 'boolean');
    const text = known.length === answers.length && answers.length
      ? scoreText({ n_items: this.items.length || answers.length, n_correct: known.filter((a) => a.correct).length })
      : 'Your answers are saved with the study.';
    this.progress.textContent = '';
    this.stopBtn.replaceChildren(icon('arrow-left'), 'Back');
    this._set(this._page(
      h('h2', {}, 'You have finished this quiz'),
      h('p.note', {}, text),
      h('div.btn-row', {}, h('button.btn.primary', { type: 'button', onclick: () => this.leave() }, 'Back'))));
  }

  // ------------------------------------------------------------------ leaving
  async stop() {
    if (this.closed) return;
    const done = nextIndex(this.items, this.answered) >= this.items.length;
    const answeredCount = Object.keys(this.answered).length;
    if (this.data && !this.data.finished && answeredCount && !done) {
      const STOP = 'Stop for now';
      const END = 'End the quiz now';
      const GO_ON = 'Continue the quiz';
      const pick = await choose('Stop the quiz?',
        `You have answered ${answeredCount} of ${this.items.length} segments.\n\n${STOP} keeps your answers with the study, and you can carry on from here another time. ${END} gives your score for the segments you answered, and the quiz is then finished.`,
        [STOP, END, GO_ON], 2);
      if (pick === GO_ON || this.closed) return;
      if (pick === END) {
        logger.event('quiz_ended_early', { set_id: this.setId, answered: answeredCount, n_items: this.items.length, quiz_mode: this.mode });
        await this.finish();
        return;
      }
      logger.event('quiz_stopped', { set_id: this.setId, answered: answeredCount, n_items: this.items.length, quiz_mode: this.mode });
    }
    this.leave();
  }

  leave() {
    this.destroy();
    if (this.onLeave) this.onLeave();
    else this.app.goBack();
  }

  _closeRecordings() {
    for (const o of this.opened.values()) if (o.owned) o.recording.close();
    this.opened.clear();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    if (this.viewer) this.viewer.destroy();
    this.viewer = null;
    this._closeRecordings();
  }
}
