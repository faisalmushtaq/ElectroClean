// An annotator's own saved files of one recording (GET /me/results, docs/web/api.md "Your own saved
// files"): the files the study keeps of the saved version, which are the BIDS _events.tsv and its
// _events.json, the _annotations.json with the ratings and notes, the _session.json and
// _time_viewed.txt, downloaded as one small zip or as separate files. Offered in the Saved dialog
// after Save and Finish (app.js afterSave) and on each saved recording of the History
// (views/home_list.js), in the sandbox and on a study alike. Asking for them is a read, so a click
// that waits for an answer can be pressed again harmlessly; the button waits meanwhile.

import { h } from '../ui/dom.js';
import { inform } from '../ui/dialog.js';
import { logger } from '../log/logger.js';
import { zipBytes } from '../data/zip.js';

/** What the files are, in plain words (the Saved dialog and the History's menu). */
export const WHAT_FILES = 'the events table (BIDS events.tsv) with its description, your annotations with your ratings and notes (JSON), and the session details';

const TYPES = { tsv: 'text/tab-separated-values', json: 'application/json', txt: 'text/plain' };

/** The files to give the browser to save: one zip, or each file on its own. */
export function filesToSave(answer, { separate = false } = {}) {
  const files = answer.files || [];
  if (separate) {
    return files.map((f) => ({ name: f.name, blob: new Blob([f.text], { type: TYPES[f.name.split('.').pop()] || 'text/plain' }) }));
  }
  return [{ name: answer.file_name, blob: new Blob([zipBytes(files)], { type: 'application/zip' }) }];
}

/**
 * Download one's own files of a saved recording (`item`: recording_id, mode, context_id, and the
 * version, or the latest). Resolves with a sentence that says what happened, for a status line.
 */
export async function downloadMine(app, item, { separate = false, version = null } = {}) {
  const b = app.backend;
  const mode = item.mode || 'standard';
  let answer;
  try {
    answer = await b.myResults(item.recording_id, mode, item.context_id || '', version);
  } catch (exc) {
    if (exc && exc.status === 401) return '';
    const why = exc && exc.code === 'not_saved' ? exc.message : `Your files could not be fetched: ${exc && exc.message ? exc.message : exc}. Try again in a moment.`;
    await inform('Download my annotations', why);
    return '';
  }
  app.download(filesToSave(answer, { separate }));
  logger.event('own_results_downloaded', { recording_id: answer.recording_id, mode: answer.mode, version: answer.version,
    n_files: answer.files.length, as: separate ? 'files' : 'zip' });
  return separate ? `${answer.files.length} files offered to save, version ${answer.version}.` : `${answer.file_name} offered to save.`;
}

/** The Saved dialog's offer of the files of session `s` (annotate/session.js) just saved with `result` (POST /submissions). */
export function savedFor(app, s, result) {
  const version = (result.revision && result.revision.version) || result.attempt || null;
  return savedDownload(app, { recording_id: s.recordingId, mode: s.mode, context_id: s.contextId }, version);
}

/** The part of the Saved dialog that offers the files just saved. */
export function savedDownload(app, item, version) {
  const status = h('p.caption.saved-download-status', { 'aria-live': 'polite' });
  const press = (separate) => async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { status.textContent = await downloadMine(app, item, { separate, version }); } finally { btn.disabled = false; }
  };
  return h('div.saved-download', { 'data-log': 'saved-download' },
    h('p.dialog-text', {}, `You can keep a copy of what you saved: ${WHAT_FILES}, the same files the study keeps. History offers them again at any time.`),
    h('div.btn-row', {},
      h('button.btn.small', { type: 'button', 'data-log': 'download-mine', onclick: press(false) }, 'Download my annotations (zip)'),
      h('button.btn.small.quiet', { type: 'button', 'data-log': 'download-mine-files', onclick: press(true) }, 'As separate files')),
    status);
}
