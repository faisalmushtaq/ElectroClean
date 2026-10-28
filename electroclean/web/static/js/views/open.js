// The open view: choose a recording on this computer (a file, several files or a folder, or drop
// them), then follow its fingerprint and the study's answer.

import { h, clear } from '../ui/dom.js';
import { appHeader, icon } from './common.js';
import { CAN_CHOOSE_FOLDER, acceptFiles } from '../util.js';
import { linkPanel } from './links_panel.js';

const FORMAT_HINT = {
  edf: 'Choose the .edf file.',
  bdf: 'Choose the .bdf file.',
  brainvision: 'Choose the .vhdr, .vmrk and .eeg files together, or the folder that holds them.',
};

/** Pick the files of one recording from a folder's files (the expected one, if it is there). */
export function filesForRecording(files, expectedName = null) {
  const list = [...files].filter((f) => /\.(edf|bdf|rec|vhdr|vmrk|eeg)$/i.test(f.name));
  const stemOf = (n) => n.replace(/\.[^.]+$/, '');
  if (expectedName) {
    const hit = list.find((f) => f.name === expectedName);
    if (hit) return /\.vhdr$/i.test(hit.name) ? list.filter((f) => stemOf(f.name) === stemOf(hit.name)) : [hit];
  }
  const heads = list.filter((f) => /\.(edf|bdf|rec|vhdr)$/i.test(f.name));
  if (heads.length === 1) {
    const hd = heads[0];
    // One BrainVision header: its marker and data files may have other names (the header says which).
    return /\.vhdr$/i.test(hd.name) ? list.filter((f) => /\.(vhdr|vmrk|eeg)$/i.test(f.name)) : [hd];
  }
  return heads.length ? null : [];
}

export class OpenView {
  constructor(app, { expected = null } = {}) {
    this.app = app;
    this.expected = expected;
    const b = app.backend;
    const fileInput = h('input', { type: 'file', multiple: true, accept: acceptFiles('.edf,.bdf,.rec,.vhdr,.vmrk,.eeg'), hidden: true, 'data-log': 'file-input',
      onchange: () => { if (fileInput.files.length) this.handle([...fileInput.files]); fileInput.value = ''; } });
    const folderInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, hidden: true, 'data-log': 'folder-input',
      onchange: () => { if (folderInput.files.length) this.handle([...folderInput.files], true); folderInput.value = ''; } });
    this.fileInput = fileInput;
    const isDemo = b && b.isDemo;
    const chooseBtn = h(`button.btn${isDemo && expected ? '' : '.primary'}`, { type: 'button', 'data-log': 'choose-file', onclick: () => fileInput.click() }, 'Choose a file…');
    const folderBtn = h('button.btn', { type: 'button', 'data-log': 'choose-folder', onclick: () => folderInput.click() }, 'Choose a folder…');
    this.drop = h('div.dropzone', { 'aria-label': 'Drop the recording here' },
      h('p.drop-title', {}, 'Drop the recording here'),
      h('p.caption', {}, 'or'),
      h('div.btn-row.center', {}, chooseBtn, CAN_CHOOSE_FOLDER ? folderBtn : null),
      fileInput, folderInput);
    for (const ev of ['dragenter', 'dragover']) this.drop.addEventListener(ev, (e) => { e.preventDefault(); this.drop.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) this.drop.addEventListener(ev, () => this.drop.classList.remove('over'));
    this.drop.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
      if (files.length) this.handle(files);
    });
    this.links = this.linkSection();
    this.steps = h('ol.steps', { hidden: true, 'aria-live': 'polite' });
    this.result = h('div.result');
    const name = expected ? expected.file_name : null;
    const format = expected ? expected.format : null;
    let example = null;
    if (isDemo) {
      const ex = expected ? [b.exampleRecordings().find((x) => x.recording_id === expected.recording_id)].filter(Boolean) : b.exampleRecordings();
      example = h('section.card.example-card', {},
        h('h2', {}, 'No EEG files to hand?'),
        h('p.caption', {}, expected ? 'Use the built-in copy of this example recording.' : 'Use one of the built-in example recordings.'),
        h('div.btn-row', {}, ex.map((x) => h(`button.btn${expected ? '.primary' : ''}`, { type: 'button', 'data-log': `example-${x.id}`, onclick: () => app.useExample(x.recording_id) },
          expected ? 'Use the example recording' : x.title))));
    }
    this.el = h('div.view.open', { 'data-view': 'open' }, appHeader(app),
      h('main.page.narrow', {},
        h('button.btn.quiet.back', { type: 'button', onclick: () => app.goBack() }, icon('arrow-left'), 'Back'),
        h('h1', {}, name ? `Open ${name}` : 'Open a recording from your computer'),
        h('p.subtitle', {}, 'The recording is read here, in your browser, and is never uploaded. Only its fingerprint (a checksum of the file) is sent to the study, to recognise it.'),
        h('p', {}, FORMAT_HINT[format] || 'Choose an EDF or BDF file, or the .vhdr, .vmrk and .eeg files of a BrainVision recording (or their folder).'),
        h('section.card', {}, this.drop, this.links.el, this.steps, this.result),
        example));
  }

  /** "Open from a link" (js/views/links_panel.js): the fetched files take the same path as chosen ones. */
  linkSection() {
    return linkPanel({ onFiles: (files) => this.handle(files), chooseFile: () => this.fileInput.click() });
  }

  async handle(files, fromFolder = false) {
    clear(this.result);
    let chosen = files;
    if (fromFolder || files.length > 3) {
      chosen = filesForRecording(files, this.expected ? this.expected.file_name : null);
      if (chosen === null) {
        this.showProblem('This folder holds more than one recording. Choose the file itself (or, for BrainVision, its three files).');
        return;
      }
      if (!chosen.length) { this.showProblem('There is no EDF, BDF or BrainVision recording in this folder.'); return; }
    }
    this.app.processFiles(chosen, this);
  }

  // progress
  reset() {
    clear(this.steps);
    clear(this.result);
    this.steps.hidden = false;
    this._steps = {};
  }

  step(key, text, state = 'working', fraction = null) {
    let li = this._steps[key];
    if (!li) {
      li = h('li.step');
      this._steps[key] = li;
      this.steps.appendChild(li);
    }
    li.className = `step ${state}`;
    clear(li);
    li.append(h('span.step-icon', { 'aria-hidden': 'true' }, state === 'done' ? icon('check') : state === 'failed' ? icon('close') : '…'), h('span', {}, text));
    if (fraction !== null) li.append(h('span.progress.inline', {}, h('span.progress-bar', { style: { width: `${Math.round(fraction * 100)}%` } })));
  }

  showProblem(text, buttons = []) {
    clear(this.result);
    this.result.append(h('div.banner', { role: 'alert' }, h('p', {}, text), buttons.length ? h('div.btn-row', {}, buttons) : null));
  }

  showMessage(text, buttons = [], kind = 'note') {
    clear(this.result);
    this.result.append(h(`div.${kind}`, { role: 'status' }, h('p', {}, text), buttons.length ? h('div.btn-row', {}, buttons) : null));
  }

  chooseAgainButton(primary = true) {
    return h(`button.btn${primary ? '.primary' : ''}`, { type: 'button', onclick: () => this.fileInput.click() }, 'Choose another file');
  }
}
