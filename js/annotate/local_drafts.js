// This browser's copies of drafts of unsaved work, as the annotation session keeps them (session.js)
// and the home view reads them (what it shows of unfinished work). Apart from the session so that
// the home page does not load the annotation store.

import { local } from '../util.js';

/** The key of this browser's copy of a draft (also read by the home view, for what it shows of unfinished work). */
export function localDraftKey(backend, annotatorId, recordingId, mode, contextId) {
  const where = backend.server || backend.kind;
  return `electrotag.draft|${where}|${annotatorId || 'anon'}|${recordingId}|${mode}|${contextId || ''}`;
}

/** This browser's copy of a draft, or null. */
export function localDraft(backend, annotatorId, recordingId, mode, contextId) {
  const d = local.get(localDraftKey(backend, annotatorId, recordingId, mode, contextId), null);
  return d && Array.isArray(d.annotations) ? d : null;
}

/** The moment a draft was kept, in milliseconds (drafts written in different time zones compare as instants), or -Infinity. */
export function draftTime(d) {
  const t = Date.parse(String((d && d.saved_at) || ''));
  return Number.isFinite(t) ? t : -Infinity;
}
