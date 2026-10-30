// After a reload of the page (or a browser that brought the tab back after closing), the recording
// that was open opens again where it was, with its work restored without a question: the annotation
// view notes in this tab which recording it shows (noteOpen), and the application asks this module
// after signing in when the page's address was the annotation view's (reopenAfterReload in app.js).
// A built-in example of the sandbox and a copy kept on this device open by themselves; a file from the
// computer has to be chosen again, which the open page says, as the page cannot read it again unasked.

import { h } from '../ui/dom.js';
import { session as tabStorage } from '../util.js';

export const REOPEN_KEY = 'electrotag.open-recording';

/** Where a marker belongs: the same back end and the same person. */
function whereOf(backend) { return (backend && (backend.server || backend.kind)) || ''; }

/** The annotation view of `s` (an AnnotationSession) is on screen: noted in this tab, to open again after a reload. */
export function noteOpen(s) {
  if (!s || s.readOnly || s.finished) return;
  tabStorage.set(REOPEN_KEY, {
    where: whereOf(s.backend), annotator_id: (s.me && s.me.annotator_id) || '',
    recording_id: s.recordingId, mode: s.mode, context_id: s.contextId || '', file_name: s.recording.fileName,
    try_out: Boolean(s.tryOut), revises: s.revision ? s.revision.revises : null,
  });
}

/** The recording was left (closed, saved or set aside): nothing is opened again. */
export function forgetOpen() { tabStorage.remove(REOPEN_KEY); }

/** The recording noted as open in this tab for this back end and person, or null. */
export function openBeforeReload(backend, annotatorId) {
  const m = tabStorage.get(REOPEN_KEY, null);
  if (!m || typeof m !== 'object' || m.where !== whereOf(backend) || m.annotator_id !== (annotatorId || '')) return null;
  return m;
}

/** The person's item (GET /assignments) for a marker, or null. */
export function itemFor(items, m) {
  return (items || []).find((i) => i.recording_id === m.recording_id && (i.mode || 'standard') === (m.mode || 'standard')
    && (i.context_id || '') === (m.context_id || '')) || null;
}

/** What the open page says when the file has to be chosen again. */
export function reopenText(m) {
  return m.try_out
    ? `The page was reloaded while ${m.file_name} was open. Choose it again and the marks you made come back (they are kept only in this browser).`
    : `The page was reloaded while ${m.file_name} was open. Your work is kept: choose the file again and it opens where you left off.`;
}

/**
 * Open again the recording that was open before a reload. True when it took over (the open page, or
 * the recording itself), false when there was nothing to open again and the usual first page follows.
 */
export async function reopenAfterReload(app) {
  const m = openBeforeReload(app.backend, app.me && app.me.annotator_id);
  forgetOpen(); // one try: a recording that cannot be opened again is not tried at every reload
  if (!m) return false;
  if (m.try_out) {
    const view = await app.openFromComputer(null);
    if (view) { view.resume = true; addNote(view, m); }
    return Boolean(view);
  }
  const item = itemFor(app.assignments && app.assignments.items, m);
  if (!item || item.status === 'done' && !(m.revises !== null && item.revising)) return false;
  const view = await app.openAssignment(item, { revise: m.revises !== null });
  if (!view) return false;
  view.resume = true; // the work comes back without asking, as Continue does
  const b = app.backend;
  if (b.isDemo && b.exampleRecordings().some((x) => x.recording_id === item.recording_id)) {
    await app.useExample(item.recording_id);
  } else {
    addNote(view, m);
  }
  return true;
}

function addNote(view, m) {
  const title = view.el && view.el.querySelector('h1');
  if (title) title.after(h('p.note.reopen-note', { 'data-log': 'reopen-note' }, reopenText(m)));
}
