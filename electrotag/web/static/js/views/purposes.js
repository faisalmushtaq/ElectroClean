// What a recording is opened for, when it is someone's saved work rather than one's own assignment: an
// administrator's review, and the expert area's purposes (a correction, a replay, an adjudication, a
// moment of the library, an annotator's view of a corrected version). The open view reads and
// fingerprints the file on this computer as usual; then, instead of asking the study whether it is one
// of the person's recordings, it checks the file against the manifest of the work to be shown
// (checkStudyCopy) and hands it to the purpose.
//
// PURPOSES[kind] = async (app, {recording, fp, view, target}) => ..., where `view` is the open view (its
// `purpose` holds `kind`, `target` and what to say), `recording` the file read, `fp` its fingerprint and
// `target` the work to show (from the study: its manifest, annotations, ...). Each later part of the
// expert work adds its purpose here with one line, loading its own module when it is used.

import { h } from '../ui/dom.js';
import { showDialog } from '../ui/dialog.js';

/**
 * The file is the study's copy of the target's recording (its fingerprint), or one the person confirms is
 * the same recording (its name, sampling rate and length match). True to go on; false when the open view
 * now says what to do instead. `verb` names what happens next on the buttons ("Review with it anyway").
 */
export async function checkStudyCopy(app, recording, fp, view, target, { verb = 'Open', kind = 'purpose' } = {}) {
  const t = target || {};
  const m = t.manifest || {};
  const want = m.fingerprint || {};
  view.step('match', 'Comparing it with the study\'s copy…');
  if (!(want.hex === fp.hex && (!want.size_bytes || Number(want.size_bytes) === Number(recording.sizeBytes)))) {
    const same = recording.fileName === m.file_name && Number(recording.sfreq) === Number(m.sfreq) && Number(recording.nSamples) === Number(m.n_samples);
    if (!same) {
      view.step('match', 'Not the recording that was annotated', 'failed');
      view.showProblem(`This file is not ${t.file_name}: its fingerprint differs from the study's copy. Choose the file that ${t.annotator_id || 'was annotated'}${t.annotator_id ? ' annotated' : ''}.`, [view.chooseAgainButton()]);
      return false;
    }
    const go = await showDialog({ title: 'Not exactly the study\'s copy', logText: `${kind} fingerprint differs`,
      body: h('p.dialog-text', {}, `This file has the name, sampling rate and length of ${t.file_name}, but its fingerprint differs from the study's copy, so its contents are not exactly the same. ${verb} with it only if you are sure it is the same recording.`),
      buttons: [{ label: 'Choose another file', value: false }, { label: `${verb} with it anyway`, value: true, kind: 'primary' }], cancelValue: false });
    if (!go || !app._stillOpen(view)) {
      if (app._stillOpen(view)) view.showMessage('Choose the study\'s copy of the recording.', [view.chooseAgainButton()]);
      return false;
    }
  }
  view.step('match', t.attempt ? `This is ${t.file_name}: version ${t.attempt} of ${t.annotator_id}` : `This is ${t.file_name}`, 'done');
  return true;
}

/** An administrator's review of someone's saved recording (docs/web/admin.md, "Reviewing saved work"). */
async function openReview(app, { recording, fp, view, target }) {
  if (!(await checkStudyCopy(app, recording, fp, view, target, { verb: 'Review', kind: 'review' }))) return;
  const t = target;
  const m = t.manifest || {};
  const parts = await app._openingParts(['session', 'workspace', 'reviewPass'], () => openReview(app, { recording, fp, view, target }));
  if (!parts || !app._stillOpen(view)) return;
  const [{ AnnotationSession }, { Workspace }, { ReviewPass, savedReviewMessage }] = parts;
  let session;
  try {
    session = new AnnotationSession({ backend: app.backend, recording, manifest: m, recordingId: t.recording_id, mode: 'standard', contextId: '',
      me: app.me, catalogue: app.catalogue, sha256: fp.hex, readOnly: true });
    session.store.reset((t.annotations || []).filter((a) => app.catalogue.has(a.label)));
  } catch (exc) {
    view.showProblem(exc.message, [view.chooseAgainButton()]);
    return;
  }
  if (app.ws) app.ws.destroy();
  const ws = new Workspace(app, session, { kind: 'reviewing' });
  ws.reviewBack = view.purpose.back;
  app.ws = ws;
  app._render(ws.el, 'admin-review');
  ws.mount(app.content);
  new ReviewPass(ws, { target: t, backend: app.backend, onSaved: async (review) => { // eslint-disable-line no-new
    await savedReviewMessage(review);
    if (app.ws === ws) app.leaveRecording(ws, 'review saved');
  } });
}

/** What each purpose does once its file is read: one line per purpose. */
export const PURPOSES = {
  review: openReview,
  adjudicate: async (app, o) => (await import('../expert/adjudicate.js')).openAdjudication(app, o), // the adjudication pass
  library: async (app, o) => (await import('../expert/adjudicate.js')).openAdjudication(app, o), // a library entry, read only
};

/** Add a purpose (a later part may also add its line to PURPOSES above). */
export function registerPurpose(kind, fn) {
  if (PURPOSES[kind] && PURPOSES[kind] !== fn) throw new Error(`The purpose ${kind} is registered twice`);
  PURPOSES[kind] = fn;
}

/** Open the file read in the open view for its purpose (app.js calls this for every purpose with a target). */
export async function openForPurpose(app, recording, fp, view) {
  const fn = PURPOSES[view.purpose && view.purpose.kind];
  if (!fn) {
    view.step('match', 'This page cannot open the recording', 'failed');
    view.showProblem('This version of ElectroTag cannot open the recording for this. Reload the page and try again.', [view.backButton()]);
    return;
  }
  await fn(app, { recording, fp, view, target: view.purpose.target });
}
