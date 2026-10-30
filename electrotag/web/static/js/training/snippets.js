// "Meet the artifacts", the second stage of the training path: a gallery of short examples of each
// artifact type from the trainee's reference set (GET /training/snippets), each shown in the EEG with a
// little context on each side, its type, the type's description and the experts' explanation. The
// recordings are the trainee's own copies, opened from their computer and checked against the study's
// fingerprints as the quiz checks them; nothing is uploaded. The recognition check is the set's quiz.
// "I have looked at them" finishes the stage (POST /training/stage {snippets, done}, never sent twice
// by itself); the study may ask for the recognition check to be finished first.

import { h, clear } from '../ui/dom.js';
import { appHeader, icon } from '../views/common.js';
import { filesForRecording } from '../views/open.js';
import { EegViewer } from '../viewer/viewer.js';
import { displayChannels } from '../annotate/session.js';
import { logger } from '../log/logger.js';
import { DEFAULT_SCALINGS } from '../api/demo_catalogue.js';
import { CAN_CHOOSE_FOLDER, acceptFiles, listWords, plural } from '../util.js';
import { loadPart } from '../lazy.js';
import { segmentBounds, segmentRecording } from './quiz.js';

/**
 * The snippets by family and type, in the catalogue's order (the order of the annotation view's types):
 * [{section, types: [{label, description, colour, items: [index into snippets]}]}]. A type the
 * catalogue does not know comes last, under "Other".
 */
export function groupSnippets(snippets, catalogue) {
  const order = new Map((catalogue && catalogue.labelNames ? catalogue.labelNames : []).map((n, i) => [n, i]));
  const rank = (label) => (order.has(label) ? order.get(label) : Number.MAX_SAFE_INTEGER);
  const byLabel = new Map();
  snippets.forEach((s, i) => {
    if (!byLabel.has(s.label)) byLabel.set(s.label, []);
    byLabel.get(s.label).push(i);
  });
  const labels = [...byLabel.keys()].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const out = [];
  for (const label of labels) {
    const lab = catalogue && catalogue.has && catalogue.has(label) ? catalogue.get(label) : null;
    const section = lab ? lab.section || 'Other' : 'Other';
    let g = out[out.length - 1];
    if (!g || g.section !== section) { g = { section, types: [] }; out.push(g); }
    g.types.push({ label, description: lab ? lab.description || '' : '', colour: lab ? lab.colour : null, items: byLabel.get(label) });
  }
  return out;
}

/** The order the gallery shows the snippets in: type by type, as grouped. */
export function galleryOrder(groups) {
  return groups.flatMap((g) => g.types.flatMap((t) => t.items));
}

/**
 * What is outlined, in words: "0.40 s on Fp1, Fp2 and VEOG, at 3.00 s in the recording" (or "on every
 * channel"). The EEG shown starts at the context before it, so its time axis starts at 0.
 */
export function whereText(s) {
  const chans = s.channels && s.channels.length ? `on ${listWords(s.channels)}` : 'on every channel';
  const len = Number(s.end_s) - Number(s.start_s);
  return `${len.toFixed(2)} s ${chans}, at ${Number(s.start_s).toFixed(2)} s in the recording`;
}

function studyFilters(me) {
  const f = (me && me.study && me.study.filters) || {};
  return { highpassHz: f.highpass_enabled === false ? null : (f.highpass_hz || 1.0),
    notchHz: f.notch_enabled === false ? null : (f.notch_hz || 50.0), notchHarmonics: Boolean(f.notch_harmonics) };
}

export class SnippetsView {
  constructor(app) {
    this.app = app;
    this.backend = app.backend;
    this.catalogue = app.catalogue;
    this.opened = new Map(); // recording_id -> {recording, channels, manifest, owned}
    this.seen = new Set();
    this.data = null;
    this.viewer = null;
    this.busy = false;
    this.closed = false;
    this.title = h('h1', {}, 'Meet the artifacts');
    this.progress = h('p.subtitle.quiz-progress', { 'aria-live': 'polite' });
    this.backBtn = h('button.btn.quiet', { type: 'button', 'data-log': 'snippets-back', onclick: () => this.leave() }, icon('arrow-left'), 'Training path');
    this.body = h('div.quiz-body');
    this.el = h('div.view.quiz.snippets', { 'data-view': 'snippets' }, appHeader(app),
      h('main.quiz-frame', {}, h('div.quiz-bar', {}, this.backBtn, h('div.quiz-heading', {}, this.title, this.progress)), this.body));
  }

  _set(...children) {
    if (this.viewer) { this.viewer.destroy(); this.viewer = null; }
    clear(this.body);
    this.body.append(...children.flat());
  }

  _page(...children) { return h('div.page.narrow.quiz-page', {}, ...children); }

  async start() {
    this._set(this._page(h('p.subtitle', {}, 'Loading the examples…')));
    let data;
    try {
      data = await this.backend.trainingSnippets();
    } catch (exc) {
      if (this.closed || exc.status === 401) return;
      this._set(this._page(h('div.banner', { role: 'alert' }, h('p', {}, `The examples could not be loaded: ${exc.message}`),
        h('div.btn-row', {}, h('button.btn.primary', { type: 'button', onclick: () => this.start() }, 'Try again'),
          h('button.btn', { type: 'button', onclick: () => this.leave() }, 'Back to my training path')))));
      return;
    }
    if (this.closed) return;
    this.data = data;
    this.groups = groupSnippets(data.snippets || [], this.catalogue);
    this.order = galleryOrder(this.groups);
    logger.event('snippets_opened', { set_id: data.set_id, n_snippets: this.order.length, n_recordings: Object.keys(data.recordings || {}).length });
    if (!this.order.length) { this._showEmpty(); return; }
    this._showOpen();
  }

  _showEmpty() {
    this._set(this._page(h('section.card', {}, h('h2', {}, 'No examples yet'),
      h('p.caption', {}, 'Your training set has no examples to show yet. Finish this stage, or go back to your training path.'),
      h('div.btn-row', {}, this._doneButton(), h('button.btn', { type: 'button', onclick: () => this.leave() }, 'Back to my training path')))));
  }

  _needed() {
    const out = [];
    for (const i of this.order) {
      const rid = this.data.snippets[i].recording_id;
      if (!out.includes(rid)) out.push(rid);
    }
    return out;
  }

  _manifest(rid) { return (this.data.recordings || {})[rid] || null; }

  // ---------------------------------------------------- opening the recordings
  _showOpen(problems = []) {
    this.progress.textContent = `${plural(this.order.length, 'example')} of ${plural(this.groups.reduce((n, g) => n + g.types.length, 0), 'type')}`;
    const needed = this._needed();
    const pick = (input) => () => { if (input.files.length) this._openFiles([...input.files]); input.value = ''; };
    const fileInput = h('input', { type: 'file', multiple: true, accept: acceptFiles('.edf,.bdf,.rec,.vhdr,.vmrk,.eeg'), hidden: true, 'data-log': 'snippets-file-input' });
    fileInput.onchange = pick(fileInput);
    const folderInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, hidden: true, 'data-log': 'snippets-folder-input' });
    folderInput.onchange = pick(folderInput);
    const list = h('ul.quiz-files', {}, needed.map((rid) => {
      const m = this._manifest(rid);
      const ok = this.opened.has(rid);
      const n = this.order.filter((i) => this.data.snippets[i].recording_id === rid).length;
      return h('li', { 'data-recording': rid }, h('span.file', { title: rid }, m ? m.file_name : rid),
        h('span.caption', {}, plural(n, 'example')), h(`span.chip${ok ? '.done' : ''}`, {}, ok ? 'Opened' : 'To open'));
    }));
    this.steps = h('ol.steps', { hidden: true, 'aria-live': 'polite' });
    const drop = h('div.dropzone', { 'aria-label': 'Drop the recordings here' },
      h('p.drop-title', {}, 'Drop the recordings here'), h('p.caption', {}, 'or'),
      h('div.btn-row.center', {},
        h('button.btn.primary', { type: 'button', 'data-log': 'snippets-choose-files', onclick: () => fileInput.click() }, 'Choose files…'),
        CAN_CHOOSE_FOLDER ? h('button.btn', { type: 'button', 'data-log': 'snippets-choose-folder', onclick: () => folderInput.click() }, 'Choose a folder…') : null),
      fileInput, folderInput);
    for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
      if (files.length) this._openFiles(files);
    });
    const example = this.backend.isDemo && typeof this.backend.exampleRecording === 'function'
      ? h('section.card.example-card', {}, h('h2', {}, 'No EEG files to hand?'),
        h('p.caption', {}, 'Use the built-in copies of the example recordings.'),
        h('div.btn-row', {}, h('button.btn', { type: 'button', 'data-log': 'snippets-use-examples', onclick: () => this._useExamples() }, 'Use the example recordings')))
      : null;
    const some = this.opened.size > 0;
    this._set(this._page(
      h('h2', {}, needed.length === 1 ? 'Open the recording of the examples' : 'Open the recordings of the examples'),
      h('p.subtitle', {}, 'The examples are short stretches of your training recordings. Open your copy of each from your computer: it is read here, in your browser, and never uploaded, and its fingerprint is checked against the study\'s copy.'),
      problems.length ? h('div.banner', { role: 'alert' }, problems.map((p) => h('p', {}, p))) : null,
      h('section.card', {}, h('h2', {}, needed.length === 1 ? 'The recording' : 'The recordings'),
        h('p.caption', {}, 'For a BrainVision recording choose its .vhdr, .vmrk and .eeg files together, or the folder that holds them. A folder may hold all of them.'),
        list, drop, this.steps,
        some ? h('div.btn-row', {}, h('button.btn', { type: 'button', 'data-log': 'snippets-show-opened', onclick: () => this._showGallery() }, 'See the examples opened so far')) : null),
      example));
  }

  _step(key, text, state = 'working') {
    if (!this.steps) return;
    this.steps.hidden = false;
    let li = this.steps.querySelector(`[data-step="${CSS.escape(key)}"]`);
    if (!li) { li = h('li.step', { 'data-step': key }); this.steps.appendChild(li); }
    li.className = `step ${state}`;
    clear(li);
    li.append(h('span.step-icon', { 'aria-hidden': 'true' }, state === 'done' ? icon('check') : state === 'failed' ? icon('close') : '…'), h('span', {}, text));
  }

  async _openFiles(files) {
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
    this._afterOpening(problems);
  }

  async _useExamples() {
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
    this._afterOpening(problems);
  }

  _afterOpening(problems) {
    if (!problems.length && this._needed().every((rid) => this.opened.has(rid))) this._showGallery();
    else this._showOpen(problems);
  }

  /** Read a recording and compare it with the study's manifest; a problem in words, or null. */
  async _check(rid, manifest, { files = null, recording = null }) {
    const name = manifest.file_name;
    const owned = !recording;
    this._step(rid, `Reading ${name}…`);
    let rec = recording;
    try {
      if (!rec) rec = await (await loadPart('readers')).openRecording(files, { fileName: name, filters: studyFilters(this.app.me) });
      const fp = await rec.fingerprint((f) => this._step(rid, `Checking ${name} (its fingerprint) ${Math.round(f * 100)}%`));
      const want = manifest.fingerprint || {};
      const same = fp.hex === String(want.hex || '').toLowerCase() && (!want.size_bytes || fp.sizeBytes === want.size_bytes);
      logger.event('snippets_recording_checked', { recording_id: rid, file_name: rec.fileName, matched: same });
      if (!same) {
        if (owned) rec.close();
        this._step(rid, `${name} is not the study's copy`, 'failed');
        return `${rec.fileName} is not the study's copy of ${name}: its fingerprint differs, so its contents are not exactly the same. Choose the study's copy.`;
      }
      if (manifest.channel_types && typeof rec.setChannelTypes === 'function') rec.setChannelTypes(manifest.channel_types);
      this.opened.set(rid, { recording: rec, channels: displayChannels(rec, manifest), manifest, owned });
      this._step(rid, `Opened ${name}`, 'done');
      return null;
    } catch (exc) {
      if (rec && owned) rec.close();
      this._step(rid, `${name} could not be opened`, 'failed');
      return `${name} could not be opened: ${exc.message}`;
    }
  }

  // ---------------------------------------------------------------- the gallery
  _available() { return this.order.filter((i) => this.opened.has(this.data.snippets[i].recording_id)); }

  _showGallery(index = null) {
    const shown = this._available();
    if (!shown.length) { this._showOpen(); return; }
    this.host = h('div.quiz-eeg.snippet-eeg');
    this.label = h('h2.snippet-label');
    this.where = h('p.caption.snippet-where');
    this.description = h('p.caption.snippet-description');
    this.note = h('p.note.snippet-note');
    this.position = h('p.caption.snippet-position', { 'aria-live': 'polite' });
    this.prevBtn = h('button.btn.small', { type: 'button', 'data-log': 'snippet-previous', onclick: () => this._go(-1) }, icon('arrow-left'), 'Previous');
    this.nextBtn = h('button.btn.small', { type: 'button', 'data-log': 'snippet-next', onclick: () => this._go(1) }, 'Next', icon('arrow-right'));
    this.index = h('div.snippet-index', { role: 'list', 'aria-label': 'The examples, by type' });
    this.doneMsg = h('div.quiz-feedback', { 'aria-live': 'polite' });
    const quiz = this.data.quiz;
    const missing = this.order.length - shown.length;
    const side = h('aside.quiz-side.snippet-side', { 'aria-label': 'The example' },
      h('div.snippet-text', {}, this.position, this.label, this.where, this.description, this.note),
      h('div.btn-row', {}, this.prevBtn, this.nextBtn),
      h('div.quiz-scroll', {}, this.index),
      missing ? h('p.caption', {}, `${plural(missing, 'more example')} ${missing === 1 ? 'needs' : 'need'} a recording not opened yet. `,
        h('button.link', { type: 'button', 'data-log': 'snippets-open-more', onclick: () => this._showOpen() }, 'Open it')) : null,
      this.doneMsg,
      h('div.snippet-actions', {},
        quiz ? h('button.btn', { type: 'button', 'data-log': 'snippets-quiz', onclick: () => this.takeQuiz() },
          quiz.finished ? 'See the recognition check' : 'Take the recognition check') : null,
        this._doneButton()));
    this._set(h('div.quiz-main', {}, this.host, side));
    this._drawIndex();
    this._show(index ?? shown.find((i) => !this.seen.has(i)) ?? shown[0]);
  }

  _doneButton() {
    this.doneBtn = h('button.btn.primary.wide', { type: 'button', 'data-log': 'snippets-done', onclick: () => this.done() }, 'I have looked at them: finish this stage');
    return this.doneBtn;
  }

  _drawIndex() {
    clear(this.index);
    for (const g of this.groups) {
      this.index.append(h('p.snippet-section', {}, g.section));
      for (const t of g.types) {
        const items = t.items.filter((i) => this.opened.has(this.data.snippets[i].recording_id));
        if (!items.length) continue;
        this.index.append(h('div.snippet-type', { role: 'listitem' },
          h('span.swatch', { style: { background: t.colour || 'var(--hairline)' } }),
          h('span.snippet-type-name', {}, t.label),
          h('span.snippet-dots', {}, items.map((i, k) => h(`button.snippet-dot${this.current === i ? '.current' : ''}${this.seen.has(i) ? '.seen' : ''}`,
            { type: 'button', 'data-log': 'snippet-choose', 'aria-label': `${t.label}, example ${k + 1} of ${items.length}${this.seen.has(i) ? ' (seen)' : ''}`,
              'aria-current': this.current === i ? 'true' : null, onclick: () => this._show(i) }, String(k + 1))))));
      }
    }
  }

  _go(step) {
    const shown = this._available();
    const at = shown.indexOf(this.current);
    const next = shown[Math.min(shown.length - 1, Math.max(0, at + step))];
    if (next !== undefined && next !== this.current) this._show(next);
  }

  _show(i) {
    const s = this.data.snippets[i];
    const o = this.opened.get(s.recording_id);
    if (!o) return;
    this.current = i;
    const rec = o.recording;
    const { s0, s1, h0, h1 } = segmentBounds(s, rec.sfreq, rec.nSamples);
    const seg = segmentRecording(rec, s0, s1);
    if (this.viewer) this.viewer.destroy();
    clear(this.host);
    const study = (this.app.me && this.app.me.study) || {};
    const scalings = { ...DEFAULT_SCALINGS, ...((study.display && study.display.scalings) || {}), ...((o.manifest.display && o.manifest.display.scalings) || {}) };
    const gaps = (o.manifest.gaps || []).map(([a, b]) => [Math.max(0, a - s0), Math.min(s1 - s0, b - s0)]).filter(([a, b]) => b > a);
    this.viewer = new EegViewer(this.host, {
      recording: seg, channels: o.channels, scalings, events: [], gaps, catalogue: this.catalogue, filters: studyFilters(this.app.me),
      view: { duration_s: seg.durationS, n_channels: o.channels.length },
    });
    this.viewer.setView({ startS: 0, durationS: seg.durationS, nChannels: o.channels.length, firstChannel: 0 }, 'snippet');
    this.viewer.setGhost({ label: s.label, onset_sample: h0, duration_samples: h1 - h0, channels: [...(s.channels || [])] });
    const shown = this._available();
    const lab = this.catalogue && this.catalogue.has(s.label) ? this.catalogue.get(s.label) : null;
    this.position.textContent = `Example ${shown.indexOf(i) + 1} of ${shown.length}`;
    this.progress.textContent = `${this.seen.size + (this.seen.has(i) ? 0 : 1)} of ${this.order.length} seen`;
    this.label.replaceChildren(h('span.swatch', { style: { background: lab ? lab.colour : 'var(--hairline)' } }), s.label);
    this.where.textContent = `Outlined: ${whereText(s)}. Shown with up to ${Number(s.context_s).toFixed(0)} s of EEG on each side.`;
    this.description.textContent = lab ? lab.description || '' : '';
    this.description.hidden = !this.description.textContent;
    this.note.textContent = s.explanation ? `The experts' note: ${s.explanation}` : '';
    this.note.hidden = !s.explanation;
    this.prevBtn.disabled = shown.indexOf(i) <= 0;
    this.nextBtn.disabled = shown.indexOf(i) >= shown.length - 1;
    if (!this.seen.has(i)) {
      this.seen.add(i);
      logger.event('snippet_viewed', { snippet_id: s.snippet_id, label: s.label, recording_id: s.recording_id, n_seen: this.seen.size, n_snippets: this.order.length });
    }
    this._drawIndex();
  }

  // ------------------------------------------------------------------- leaving
  takeQuiz() {
    logger.event('snippets_quiz_opened', { set_id: this.data.set_id, n_seen: this.seen.size });
    this.destroy();
    this.app.showQuiz(this.data.set_id, { fromTraining: true });
  }

  /** Finish the stage: sent once while it is on its way; after a failure, the button tries again. */
  async done() {
    if (this.busy || this.closed) return;
    this.busy = true;
    if (this.doneBtn) this.doneBtn.disabled = true;
    try {
      await this.backend.trainingStage({ stage: 'snippets', action: 'done' });
    } catch (exc) {
      this.busy = false;
      if (exc.status === 401 || this.closed) return;
      if (this.doneBtn) this.doneBtn.disabled = false;
      const box = this.doneMsg || null;
      if (box) { clear(box); box.append(h('p.banner', { role: 'alert' }, exc.message)); } else this._set(this._page(h('p.banner', { role: 'alert' }, exc.message)));
      return;
    }
    logger.event('snippets_done', { set_id: this.data ? this.data.set_id : '', n_seen: this.seen.size, n_snippets: this.order ? this.order.length : 0 });
    this.destroy();
    this.app.pathMessage = 'Meet the artifacts is done. Your training path goes on with the next stage.';
    await this.app.loadAssignments(); // the next stage's recordings are offered now
    await this.app.showTraining();
  }

  leave() {
    logger.event('snippets_left', { n_seen: this.seen.size, n_snippets: this.order ? this.order.length : 0 });
    this.destroy();
    this.app.showTraining();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    if (this.viewer) this.viewer.destroy();
    this.viewer = null;
    for (const o of this.opened.values()) if (o.owned) o.recording.close();
    this.opened.clear();
  }
}

/** Show the gallery (the training path's Continue, or its card). */
export function showSnippets(app) {
  if (app.snippetsView) app.snippetsView.destroy();
  const view = new SnippetsView(app);
  app.snippetsView = view;
  app._render(view.el, 'training');
  view.start();
  return view;
}
