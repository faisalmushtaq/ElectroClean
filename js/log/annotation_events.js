// The interaction log's events for changes of the annotations (docs/activity_logs.md), made from one
// change of the annotation store (annotate/store.js) and the annotations before and after it. The
// annotation view logs them (annotate/workspace.js) and the replay rebuilds the annotations from
// them (replay/model.js), so the two are kept in one place. Each annotation is summarised with its
// ID, type, times in seconds, channels and confidence, and only the length of its note: a note's text
// is research content and never logged.

import { endSample } from '../annotate/store.js';

/** At most this many annotations in one annotations_snapshot event (each event stays under 16 KB). */
export const SNAPSHOT_CHUNK = 60;

export function annSummary(a, sf) {
  return { id: a.annotation_id, label: a.label, onset_s: Math.round((a.onset_sample / sf) * 1e4) / 1e4,
    offset_s: Math.round((endSample(a) / sf) * 1e4) / 1e4, channels: [...a.channels], n_channels: a.channels.length,
    confidence: a.confidence ?? null, note_length: (a.note || '').length };
}

function noteEvents(changed, prev, now, base) {
  const notes = changed.filter((k) => (now.get(k).note || '') !== (prev.get(k).note || '')).map((k) => {
    const before = prev.get(k).note || '';
    const after = now.get(k).note || '';
    return { id: k, label: now.get(k).label, change: !before ? 'added' : !after ? 'removed' : 'changed',
      note_length: after.length, previous_length: before.length };
  });
  return notes.length ? [['note_set', { ...base, annotations: notes }]] : [];
}

/**
 * The events for one change of the store: [[type, fields], ...]. `prev` and `now` are Maps of the
 * annotations by ID before and after it; `via` is what caused it, `autoMerged` the store's lastAutoMerged.
 */
export function annotationEvents(change, prev, now, { sf, via = 'unknown', autoMerged = null } = {}) {
  const added = [...now.keys()].filter((k) => !prev.has(k));
  const removed = [...prev.keys()].filter((k) => !now.has(k));
  const changed = [...now.keys()].filter((k) => prev.has(k) && prev.get(k) !== now.get(k));
  const sum = (a) => annSummary(a, sf);
  const base = { description: change.description, n_total: now.size, via };
  const merged = autoMerged ? { auto_merged: autoMerged, merged_away: removed } : {};
  const act = change.action;
  const d = change.description || '';
  if (act === 'add') return [['annotation_created', { ...base, annotations: added.concat(changed).map((k) => sum(now.get(k))), ...merged }]];
  if (act === 'delete') return [['annotation_deleted', { ...base, annotations: removed.map((k) => sum(prev.get(k))) }]];
  if (act === 'update') {
    if (/^(set|clear) confidence/.test(d)) {
      return [['confidence_set', { ...base, annotations: changed.map((k) => ({ id: k, label: now.get(k).label,
        confidence: now.get(k).confidence ?? null, before: prev.get(k).confidence ?? null })) }]];
    }
    if (/^(add|change|remove) note$/.test(d)) return noteEvents(changed, prev, now, base);
    const type = d.startsWith('relabel') ? 'annotation_relabelled' : /channel/.test(d) ? 'annotation_channels_changed' : 'annotation_edited';
    return [[type, { ...base, annotations: changed.map((k) => sum(now.get(k))), before: changed.map((k) => sum(prev.get(k))), ...merged }],
      ...noteEvents(changed, prev, now, base)]; // a note changed together with the times (Edit times…)
  }
  // a merge, undo, redo, a reset, or work brought back (replace): what was added, removed and changed
  const type = { merge: 'annotations_merged', undo: 'undo', redo: 'redo', reset: 'annotations_reset', replace: 'annotations_reset' }[act];
  if (!type) return [];
  return [[type, { ...base, added: added.map((k) => sum(now.get(k))), removed: removed.map((k) => sum(prev.get(k))), changed: changed.map((k) => sum(now.get(k))) }]];
}

/**
 * The annotations present when a recording opens (a restored draft, a revision, a correction), as
 * annotations_snapshot events of at most SNAPSHOT_CHUNK each ({part, n_parts, annotations}); none for none.
 */
export function snapshotEvents(annotations, sf, reason = 'opened') {
  const list = [...(annotations || [])];
  if (!list.length) return [];
  const n = Math.ceil(list.length / SNAPSHOT_CHUNK);
  return Array.from({ length: n }, (_, i) => ['annotations_snapshot', { part: i + 1, n_parts: n, reason, n_total: list.length,
    annotations: list.slice(i * SNAPSHOT_CHUNK, (i + 1) * SNAPSHOT_CHUNK).map((a) => annSummary(a, sf)) }]);
}
