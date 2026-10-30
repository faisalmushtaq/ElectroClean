// The adjudication queue, the adjudication pass and the library without the page (docs/web/admin.md,
// "Adjudication" and "Library"): the words, the keys, the progress, the order of the conflicts, the body
// of a decision and the library's export, so that the unit tests check them in Node. The study
// recomputes the conflicts (electrotag/web/adjudication.py); nothing here compares annotations.

export const LETTERS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F']);
export const MAX_REASON = 200;
export const MAX_EDITED = 5;

/** The kinds of conflict, as the side panel and the library name them. */
export const KIND_TEXT = Object.freeze({
  presence: 'Marked by some only', type: 'Different types', timing: 'Start or end apart', channels: 'Different channels',
  split: 'Split differently',
});

/** Why the adjudicator decided as they did (adjudication.py REASON_CODES), as the reason chips say it. */
export const REASON_TEXT = Object.freeze({
  clear_artifact: 'Clear artifact', not_artifact: 'Not an artifact', type_evidence: 'Type shows in the EEG',
  boundary_evidence: 'Start and end show', channels_evidence: 'Channels show', both_valid: 'Both are valid', other: 'Other',
});

/** The statuses of the queue's units and of the library's entries, in words. */
export const STATUS_TEXT = Object.freeze({
  collecting: 'Waiting for annotators', ready: 'Ready', agreed: 'They agree', adjudicating: 'In progress', adjudicated: 'Finished',
  awaiting: 'Not started', open: 'Open', decided: 'Decided',
});

/** The queue's tabs: the statuses each shows. */
export const QUEUE_TABS = Object.freeze([
  { key: 'ready', title: 'Ready', statuses: ['ready'] },
  { key: 'progress', title: 'In progress', statuses: ['adjudicating'] },
  { key: 'finished', title: 'Finished', statuses: ['adjudicated'] },
  { key: 'waiting', title: 'Waiting', statuses: ['collecting', 'agreed'] },
  { key: 'all', title: 'All', statuses: null },
]);

export function tabRows(units, key) {
  const tab = QUEUE_TABS.find((t) => t.key === key) || QUEUE_TABS[0];
  return (units || []).filter((u) => !tab.statuses || tab.statuses.includes(u.status));
}

export function tabCounts(units) {
  return Object.fromEntries(QUEUE_TABS.map((t) => [t.key, tabRows(units, t.key).length]));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the queue's action button does for a unit, or null when nothing can be done. */
export function queueAction(u) {
  if (u.own) return null;
  if (u.status === 'ready') return { op: 'start', label: 'Start' };
  if (u.status === 'adjudicating') return u.yours ? { op: 'continue', label: 'Continue' } : null;
  if (u.status === 'adjudicated') return { op: 'view', label: 'Open' };
  return null;
}

/** "A01 and A02" or "E01 and E02, correcting A01". */
export function peopleText(u) {
  const names = (u.annotators || []).map((a) => a.annotator_id);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
  return u.corrected ? `${list}, correcting ${u.corrected.annotator_id}` : list;
}

/** What part of the recording is adjudicated: "Whole recording" or "0:30–1:00". */
export function windowText(w) {
  if (!w) return 'Whole recording';
  const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  return `${clock(w.start_s)}–${clock(w.end_s)}`;
}

export function queueSummary(units) {
  const c = tabCounts(units);
  const mine = (units || []).filter((u) => u.status === 'adjudicating' && u.yours).length;
  const parts = [`${plural(c.ready, 'recording')} ready`];
  if (c.progress) parts.push(`${c.progress} in progress${mine ? ` (${mine} yours)` : ''}`);
  if (c.finished) parts.push(`${c.finished} finished`);
  if (c.waiting) parts.push(`${c.waiting} waiting or agreed`);
  return parts.join(' · ');
}

// ------------------------------------------------------------------ the pass
/** The choices of a conflict, in the order of the decision bar: one per letter, then all, none and edited. */
export function choicesFor(letters) {
  const two = letters.length === 2;
  return [
    ...letters.map((x, i) => ({ choice: x, label: `Keep ${x}`, keys: [String(i + 1), ...(i < 4 ? [x.toLowerCase()] : [])] })),
    { choice: 'all', label: two ? 'Keep both' : 'Keep all', keys: ['k'] },
    { choice: 'none', label: 'Neither', keys: ['x'] },
    { choice: 'edited', label: 'Edit a mark', keys: ['e'] },
  ];
}

/**
 * What a key does in the adjudication pass (null when it is not one of its keys): {action, choice?}.
 * The letters A to D and the digits keep a version; K keeps all, X none, E edits; R goes to the reason,
 * Enter saves the decision and goes on, S skips, N and P move, T changes the lanes, F finishes.
 */
export function keyAction(key, letters, { shift = false, ctrl = false } = {}) {
  if (ctrl) return null;
  const k = String(key || '');
  if (k === 'Enter') return { action: 'save' };
  const lk = k.toLowerCase();
  for (const c of choicesFor(letters)) if (c.keys.includes(lk)) return { action: 'choose', choice: c.choice };
  if (lk === 'r') return { action: 'reason' };
  if (lk === 's') return { action: 'skip' };
  if (lk === 'n') return { action: 'step', delta: 1 };
  if (lk === 'p') return { action: 'step', delta: -1 };
  if (lk === 't') return { action: 'lanes', delta: shift ? -1 : 1 };
  if (lk === 'f') return { action: 'finish' };
  return null;
}

/** The lanes shown: every letter, then each letter alone (T moves through them). */
export function laneModes(letters) {
  return [null, ...letters];
}

export function nextLaneMode(letters, mode, delta = 1) {
  const modes = laneModes(letters);
  const i = Math.max(0, modes.indexOf(mode));
  return modes[(i + delta + modes.length) % modes.length];
}

/** "Conflict 4 of 17, 3 decided". */
export function progressText(conflicts, index) {
  const n = conflicts.length;
  const decided = conflicts.filter((c) => c.decision).length;
  if (!n) return 'No conflicts';
  return `${index >= 0 ? `Conflict ${index + 1} of ${n}` : `${plural(n, 'conflict')}`}, ${decided} decided`;
}

export function decidedShare(conflicts) {
  return conflicts.length ? conflicts.filter((c) => c.decision).length / conflicts.length : 0;
}

/** The next conflict without a decision after `from` (going round), or -1 when every conflict is decided. */
export function nextUndecided(conflicts, from = -1) {
  const n = conflicts.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + step) % n) + n) % n;
    if (!conflicts[i].decision) return i;
  }
  return -1;
}

/** Whether the study asks for a reason with this choice (review.reason_required). */
export function reasonNeeded(rule, choice) {
  return rule === 'always' || (rule === 'edited_or_none' && (choice === 'edited' || choice === 'none'));
}

/** What is missing before a decision can be sent, in plain words, or '' when it can be sent. */
export function decisionProblem({ choice, reasonCode = null, reason = '', marks = [], rule = 'always' }) {
  if (!choice) return 'Choose what to keep first.';
  const text = String(reason || '').trim();
  if (text.length > MAX_REASON) return `The reason has at most ${MAX_REASON} characters.`;
  if (reasonNeeded(rule, choice) && !reasonCode && !text) return 'Give a reason: choose one, or write a few words (R).';
  if (reasonCode === 'other' && !text) return 'You chose another reason: write it in a few words (R).';
  if (choice === 'edited' && !(marks && marks.length)) return 'Set the mark first: its type and its start and end.';
  return '';
}

/** The body of adjudication_decide. */
export function decisionBody({ unitId, conflictId, choice, reasonCode = null, reason = '', marks = [] }) {
  const body = { unit_id: unitId, conflict_id: conflictId, choice, reason: String(reason || '').trim().slice(0, MAX_REASON) };
  if (reasonCode) body.reason_code = reasonCode;
  if (choice === 'edited') {
    body.marks = marks.slice(0, MAX_EDITED).map((m, i) => ({ annotation_id: `e${i + 1}`, label: m.label, onset_sample: m.onset_sample,
      duration_samples: m.duration_samples, channels: [...(m.channels || [])] }));
  }
  return body;
}

/** A decision in words: "Kept A (A01)", "Kept both", "Kept neither", "Edited". */
export function decisionText(d, people = {}) {
  if (!d) return 'Not decided';
  const c = d.choice;
  if (c === 'all') return 'Kept all';
  if (c === 'none') return 'Kept neither';
  if (c === 'edited') return 'Edited';
  return `Kept ${c}${people[c] ? ` (${people[c]})` : ''}`;
}

/** The kinds of a conflict, and what each version holds, in one sentence. */
export function conflictSentence(c) {
  const kinds = (c.kinds || []).map((k) => KIND_TEXT[k] || k).join(', ');
  const by = (c.marks || []).map((m) => `${m.letter}: ${m.label}`).join('; ');
  const missing = (c.missing || []).length ? `; no mark from ${(c.missing || []).join(' and ')}` : '';
  return `${kinds}. ${by}${missing}.`;
}

/** The time of a conflict: "12.30–12.71 s". */
export function spanText(onsetS, offsetS) {
  return `${Number(onsetS).toFixed(2)}–${Number(offsetS).toFixed(2)} s`;
}

/** The marks of every version as annotations of one read-only view: each ID prefixed with its letter. */
export function overlayAnnotations(versions, mode = null) {
  const out = [];
  for (const v of versions || []) {
    if (mode && v.letter !== mode) continue;
    for (const a of v.annotations || []) {
      const ann = { annotation_id: `${v.letter}-${a.annotation_id}`, label: a.label, onset_sample: a.onset_sample,
        duration_samples: a.duration_samples, channels: [...(a.channels || [])] };
      if (Number.isInteger(a.confidence)) ann.confidence = a.confidence;
      if (a.note) ann.note = a.note;
      out.push(ann);
    }
  }
  return out;
}

/** The letter of an overlaid annotation's ID ("A-..." -> "A"). */
export const letterOf = (id) => String(id).split('-')[0];

/** Which conflict holds an overlaid annotation (its letter and its own ID), or -1. */
export function conflictOfMark(conflicts, overlayId) {
  const letter = letterOf(overlayId);
  const id = String(overlayId).slice(letter.length + 1);
  return conflicts.findIndex((c) => (c.marks || []).some((m) => m.letter === letter && m.annotation_id === id));
}

/** The lanes' marks between t0 and t1 seconds: [{letter, row, label, t0, t1, current, conflict}]. */
export function laneMarks(versions, conflicts, current, t0, t1, sfreq) {
  const cur = conflicts[current];
  const inCurrent = new Set(cur ? (cur.marks || []).map((m) => `${m.letter}-${m.annotation_id}`) : []);
  const out = [];
  (versions || []).forEach((v, row) => {
    for (const a of v.annotations || []) {
      const s = a.onset_sample / sfreq;
      const e = (a.onset_sample + a.duration_samples) / sfreq;
      if (e < t0 || s > t1) continue;
      out.push({ letter: v.letter, row, label: a.label, t0: s, t1: e, current: inCurrent.has(`${v.letter}-${a.annotation_id}`),
        id: `${v.letter}-${a.annotation_id}` });
    }
  });
  return out;
}

// ------------------------------------------------------------------ the library
export const LIBRARY_COLUMNS = Object.freeze(['entry_id', 'recording_id', 'status', 'kinds', 'labels', 'pair', 'onset_s', 'offset_s',
  'people', 'missing', 'decision', 'kept_labels', 'reason_code', 'reason', 'adjudicator_id', 'decided_at']);

const cell = (v) => (v === null || v === undefined || v === '' ? 'n/a' : Array.isArray(v) ? v.join(',') : String(v).replace(/[\t\r\n]+/g, ' '));

/** One library entry as a row of the export. */
export function libraryRow(e) {
  const d = e.decision || {};
  return {
    entry_id: e.entry_id, recording_id: e.recording_id, status: e.status, kinds: e.kinds || [], labels: e.labels || [],
    pair: e.pair ? e.pair.join(' | ') : '', onset_s: e.onset_s, offset_s: e.offset_s,
    people: [...new Set((e.marks || []).map((m) => m.annotator_id))].sort(), missing: e.missing_ids || [],
    decision: d.choice || '', kept_labels: [...new Set((d.result || []).map((a) => a.label))].sort(), reason_code: d.reason_code || '',
    reason: d.reason || '', adjudicator_id: e.adjudicator_id || '', decided_at: d.decided_at || '',
  };
}

/** The filtered library as a TSV file's text (the study's own export has the same columns: docs/file_formats.md). */
export function libraryTsv(entries) {
  const rows = (entries || []).map(libraryRow);
  return `${[LIBRARY_COLUMNS.join('\t'), ...rows.map((r) => LIBRARY_COLUMNS.map((c) => cell(r[c])).join('\t'))].join('\n')}\n`;
}

export function libraryJson(entries, filters = {}) {
  return `${JSON.stringify({ schema: 'electrotag.library', schema_version: 1, filters, entries: entries || [] }, null, 1)}\n`;
}

/** The body of library_list from the filter fields (empty fields left out). */
export function libraryQuery(f) {
  const out = {};
  for (const k of ['label', 'kind', 'status', 'choice', 'annotator_id', 'recording_id', 'q']) {
    const v = f[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') out[k] = String(v).trim();
  }
  if (f.pair) out.pair = String(f.pair).split('|').map((s) => s.trim());
  return out;
}

/** The keys of a library filter, for the interaction log (never what was typed in the search). */
export function filterKeys(query) {
  return Object.keys(query).sort();
}

/** What a promotion fills in at first: the decided type and times, or the conflict's, and the reason. */
export function promoteDefaults(e) {
  const d = e.decision || {};
  const kept = d.result || [];
  const labels = [...new Set(kept.map((a) => a.label))];
  const label = labels.length === 1 ? labels[0] : (e.labels || [])[0] || '';
  const t0 = kept.length ? Math.min(...kept.map((a) => a.onset_s)) : e.onset_s;
  const t1 = kept.length ? Math.max(...kept.map((a) => a.offset_s)) : e.offset_s;
  return { label, start_s: Math.round(t0 * 1000) / 1000, end_s: Math.round(t1 * 1000) / 1000, decided: Boolean(e.decision),
    explanation: d.reason ? `Annotators disagreed here. The adjudicator's reason: ${d.reason}.` : '' };
}
