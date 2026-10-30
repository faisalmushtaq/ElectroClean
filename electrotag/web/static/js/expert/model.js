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

/** The reason chips' keys: Shift and the chip's number (Shift+1 a clear artifact, ... Shift+7 another reason). */
export const REASON_KEYS = Object.freeze(Object.fromEntries(Object.keys(REASON_TEXT).map((code, i) => [code, String(i + 1)])));

/** The reason code of Shift and a digit (KeyboardEvent.code 'Digit3' or 'Numpad3'), or null. */
export function reasonForCode(code) {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(String(code || ''));
  if (!m) return null;
  return Object.keys(REASON_TEXT)[Number(m[1]) - 1] || null;
}

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

/** Why a unit cannot be started by this person, in a few words, or '' when it can (or there is nothing to start). */
export function blockedText(u) {
  if (u.own && ['ready', 'adjudicating', 'collecting'].includes(u.status)) return 'Your own work: someone else adjudicates it';
  if (u.status === 'adjudicating' && !u.yours) return `${u.adjudicator_id || 'Another expert'} is adjudicating it`;
  return '';
}

/** Whether a finished unit can become a training reference: the whole recording only (a part cannot). */
export function canBecomeReference(u) {
  return u.status === 'adjudicated' && !u.window;
}

/** The conflicts not decided yet in units that can be worked on (ready, or in progress). */
export function conflictsLeft(units) {
  return (units || []).filter((u) => ['ready', 'adjudicating'].includes(u.status))
    .reduce((n, u) => n + Math.max(0, (u.conflicts || 0) - (u.decided || 0)), 0);
}

/** The text a queue's search matches: the recording, the people (IDs and names), the adjudicator, the notes. */
export function unitSearchText(u) {
  return [u.recording_id, u.file_name, u.unit_id, u.notes, u.adjudicator_id, u.adjudicator_name,
    u.corrected ? u.corrected.annotator_id : '', ...(u.annotators || []).flatMap((a) => [a.annotator_id, a.display_name])]
    .filter(Boolean).join(' ').toLowerCase();
}

/** The units whose text holds every word of the search (case does not matter). */
export function searchUnits(units, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return units || [];
  return (units || []).filter((u) => { const t = unitSearchText(u); return words.every((w) => t.includes(w)); });
}

/** The tab the queue opens on: one's own adjudications in progress first, then what is ready. */
export function defaultTab(units) {
  const list = units || [];
  if (list.some((u) => u.status === 'adjudicating' && u.yours)) return 'progress';
  if (list.some((u) => u.status === 'ready')) return 'ready';
  return 'all';
}

/** Rows in the order the queue shows them: yours first, then those you can start, then the rest. */
export function queueOrder(units) {
  const rank = (u) => (u.yours && u.status === 'adjudicating' ? 0 : queueAction(u) ? 1 : 2);
  return [...(units || [])].sort((a, b) => rank(a) - rank(b));
}

/** What a unit is, in words: the whole recording, a part of it, or corrections of someone's version. */
export function unitWhat(u) {
  if (u.kind === 'corrections' && u.corrected) return `Corrections of ${u.corrected.annotator_id}'s version ${u.corrected.attempt}`;
  return u.window ? `Part ${windowText(u.window)}` : 'Whole recording';
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

/**
 * The queue's summary, counting honestly: what can be adjudicated (whole recordings, parts of one, or sets of
 * corrections) is not always a recording of its own, so the number of recordings is given beside it; units this
 * person cannot start (their own work) are said apart; and the conflicts left to decide are totalled.
 */
export function queueSummary(units) {
  const list = units || [];
  const ready = list.filter((u) => u.status === 'ready');
  const startable = ready.filter((u) => !u.own);
  const recs = new Set(ready.map((u) => u.recording_id)).size;
  const mine = list.filter((u) => u.status === 'adjudicating' && u.yours);
  const others = list.filter((u) => u.status === 'adjudicating' && !u.yours).length;
  const finished = list.filter((u) => u.status === 'adjudicated').length;
  const waiting = list.filter((u) => ['collecting', 'agreed'].includes(u.status)).length;
  const parts = [ready.length ? `${ready.length} ready to adjudicate${recs !== ready.length ? ` (on ${plural(recs, 'recording')})` : ''}` : 'Nothing ready to adjudicate'];
  if (ready.length && startable.length !== ready.length) parts[0] += `, ${ready.length - startable.length} of them your own work`;
  if (mine.length) parts.push(`${mine.length} of yours in progress`);
  if (others) parts.push(`${others} in progress with others`);
  if (finished) parts.push(`${finished} finished`);
  if (waiting) parts.push(`${waiting} waiting or agreed`);
  const left = conflictsLeft(list.filter((u) => !u.own && (u.status === 'ready' || u.yours)));
  const leftMine = conflictsLeft(mine);
  return `${parts.join(' · ')}. ${plural(left, 'conflict')} left to decide${leftMine ? `, ${leftMine} of them in yours` : ''}.`;
}

/** The lines of the home page's Expert work card, from adjudication_list: [] when there is nothing to say. */
export function expertCardLines(units) {
  const list = units || [];
  const mine = list.filter((u) => u.status === 'adjudicating' && u.yours);
  const ready = list.filter((u) => u.status === 'ready' && !u.own);
  const out = [];
  if (mine.length) out.push(`${plural(mine.length, 'adjudication')} of yours in progress, ${plural(conflictsLeft(mine), 'conflict')} left.`);
  if (ready.length) out.push(`${ready.length} ready to adjudicate, ${plural(conflictsLeft(ready), 'conflict')} in all.`);
  return out;
}

// ------------------------------------------------------------------ the pass
/** The choices of a conflict, in the order of the decision bar: one per letter, then all, none and edited. */
export function choicesFor(letters) {
  const two = letters.length === 2;
  return [
    ...letters.map((x, i) => ({ choice: x, label: `Keep ${x}`, keys: [String(i + 1), ...(i < 4 ? [x.toLowerCase()] : [])] })),
    { choice: 'all', label: two ? 'Keep both' : 'Keep all', keys: ['k'] },
    { choice: 'none', label: two ? 'Neither' : 'None', keys: ['x'] },
    { choice: 'pick', label: 'Choose marks', keys: ['m'] },
    { choice: 'edited', label: 'Your own marks', keys: ['e'] },
  ];
}

/** The digits that keep a version, in words: "1 or 2" (two versions), "1 to 3". */
function digitsText(letters) {
  return letters.length === 2 ? '1 or 2' : `1 to ${letters.length}`;
}

/** The line at the bottom of the adjudication view, from the versions compared. */
export function hintText(letters, mode = 'decide') {
  if (mode !== 'decide') return 'N / P  next, previous conflict  ·  T lanes  ·  ? keys';
  const all = letters.length === 2 ? 'K both' : 'K all';
  const none = letters.length === 2 ? 'X neither' : 'X none';
  return `${digitsText(letters)} keep ${letters.length === 2 ? 'A or B' : 'a version'}  ·  ${all}  ·  ${none}  ·  M choose marks  ·  E your own  ·  `
    + 'Shift+1–7 reason  ·  Enter save and next  ·  N / P move  ·  ? keys';
}

/** Every key of the adjudication view, for its key sheet (?): [[keys, what they do]]. */
export function keySheet(letters, mode = 'decide') {
  const view = [['N, P', 'Next and previous conflict'], ['T', 'The lanes: every version, then each one alone (Shift+T back)'],
    ['?', 'These keys'], ['Arrows, Home, End, + and -', 'Move and scale the EEG, as when annotating']];
  if (mode !== 'decide') return view;
  const letterKeys = letters.slice(0, 4).map((x) => x).join(', ');
  return [
    [`${digitsText(letters)}${letterKeys ? ` (or ${letterKeys})` : ''}`, 'Keep that version: its marks as they are'],
    ['K', letters.length === 2 ? 'Keep both versions\' marks' : 'Keep every version\'s marks'],
    ['X', letters.length === 2 ? 'Keep neither: no mark here' : 'Keep none: no mark here'],
    ['M', 'Choose the marks to keep, one by one, from different people if need be'],
    ['E', 'Your own marks instead (up to 5): type, start and end, channels; or drag across the EEG'],
    ['Shift+1 to Shift+7', `The reason: ${Object.values(REASON_TEXT).map((t, i) => `${i + 1} ${t.toLowerCase()}`).join(', ')}`],
    ['R', 'Write the reason in a few words'],
    ['Enter', 'Save the decision and go to the next undecided conflict'],
    ['S', 'Skip to the next undecided conflict'],
    ...view,
    ['F', 'Finish the adjudication, once every conflict is decided'],
  ];
}

/**
 * What a key does in the adjudication pass (null when it is not one of its keys): {action, choice?}.
 * The letters A to D and the digits keep a version; K keeps all, X none, E edits; R goes to the reason,
 * Enter saves the decision and goes on, S skips, N and P move, T changes the lanes, F finishes.
 */
export function keyAction(key, letters, { shift = false, ctrl = false, code = '' } = {}) {
  if (ctrl) return null;
  const k = String(key || '');
  if (shift) {
    const reason = reasonForCode(code);
    if (reason) return { action: 'reason_code', code: reason };
  }
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
export function decisionProblem({ choice, reasonCode = null, reason = '', marks = [], picks = [], rule = 'always' }) {
  if (!choice) return 'Choose what to keep first.';
  if (choice === 'pick' && !(picks && picks.length)) return 'Tick the marks to keep first.';
  const text = String(reason || '').trim();
  if (text.length > MAX_REASON) return `The reason has at most ${MAX_REASON} characters.`;
  if (reasonNeeded(rule, choice) && !reasonCode && !text) return 'Give a reason: Shift and a number chooses one, or R to write a few words.';
  if (reasonCode === 'other' && !text) return 'You chose another reason: write it in a few words (R).';
  if (choice === 'edited' && !(marks && marks.length)) return 'Set the mark first: its type and its start and end.';
  if (choice === 'edited' && marks.length > MAX_EDITED) return `At most ${MAX_EDITED} marks of your own.`;
  return '';
}

/** The body of adjudication_decide. */
export function decisionBody({ unitId, conflictId, choice, reasonCode = null, reason = '', marks = [], picks = [] }) {
  const body = { unit_id: unitId, conflict_id: conflictId, choice, reason: String(reason || '').trim().slice(0, MAX_REASON) };
  if (reasonCode) body.reason_code = reasonCode;
  if (choice === 'pick') body.picks = picks.map((p) => ({ letter: p.letter, annotation_id: p.annotation_id }));
  if (choice === 'edited') {
    body.marks = marks.slice(0, MAX_EDITED).map((m, i) => ({ annotation_id: `e${i + 1}`, label: m.label, onset_sample: m.onset_sample,
      duration_samples: m.duration_samples, channels: [...(m.channels || [])] }));
  }
  return body;
}

/** A decision in words: "Kept A (A01)", "Kept all", "Kept none", "Kept marks of A and C", "Replaced by 2 marks". */
export function decisionText(d, people = {}) {
  if (!d) return 'Not decided';
  const c = d.choice;
  if (c === 'all') return 'Kept all';
  if (c === 'none') return 'Kept none';
  if (c === 'edited') {
    const n = (d.marks || []).length;
    return n > 1 ? `Replaced by ${n} marks of the adjudicator's own` : 'Replaced by the adjudicator\'s own mark';
  }
  if (c === 'pick') {
    const letters = [...new Set((d.picks || []).map((p) => p.letter))].sort();
    const who = letters.map((x) => (people[x] ? `${x} (${people[x]})` : x));
    const n = (d.picks || []).length;
    return `Kept ${plural(n, 'chosen mark')} of ${who.length > 1 ? `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}` : who.join('')}`;
  }
  return `Kept ${c}${people[c] ? ` (${people[c]})` : ''}`;
}

/** "A01 (A), A02 (B) and A03 (C)": the people compared, each with their letter. */
export function whoText(versions) {
  const names = (versions || []).map((v) => `${v.annotator_id} (${v.letter})`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
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
/** The columns of the library's TSV: the same as library/library.tsv of the results (electrotag/web/library.py). */
export const LIBRARY_COLUMNS = Object.freeze(['entry_id', 'unit_id', 'unit_kind', 'recording_id', 'status', 'kinds', 'labels', 'pair', 'onset_s',
  'offset_s', 'letters', 'people', 'missing', 'choice', 'kept_annotator_ids', 'kept_labels', 'reason_code', 'reason', 'adjudicator_id',
  'decided_at', 'promoted']);

/** Whose marks a decided entry kept (library.py kept_people). */
export function keptPeople(e) {
  const d = e.decision || {};
  const marks = e.marks || [];
  const ids = (list) => [...new Set(list.map((m) => m.annotator_id))].sort();
  if (d.choice === 'all') return ids(marks);
  if (d.choice === 'pick') {
    const picked = new Set((d.picks || []).map((p) => `${p.letter}|${p.annotation_id}`));
    return ids(marks.filter((m) => picked.has(`${m.letter}|${m.annotation_id}`)));
  }
  return ids(marks.filter((m) => m.letter === d.choice));
}

const cell = (v) => (v === null || v === undefined || v === '' ? 'n/a' : Array.isArray(v) ? v.join(',') : String(v).replace(/[\t\r\n]+/g, ' '));

/** One library entry as a row of the export. */
export function libraryRow(e) {
  const d = e.decision || {};
  const letters = Object.entries(e.letters || {}).sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([p, x]) => `${x}=${p}`);
  return {
    entry_id: e.entry_id, unit_id: e.unit_id || '', unit_kind: e.unit_kind || '', recording_id: e.recording_id, status: e.status,
    kinds: e.kinds || [], labels: e.labels || [], pair: e.pair ? e.pair.join(' | ') : '', onset_s: e.onset_s, offset_s: e.offset_s, letters,
    people: [...new Set((e.marks || []).map((m) => m.annotator_id))].sort(), missing: e.missing_ids || [],
    choice: d.choice || '', kept_annotator_ids: e.decision ? keptPeople(e) : null, kept_labels: [...new Set((d.result || []).map((a) => a.label))].sort(),
    reason_code: d.reason_code || '', reason: d.reason || '', adjudicator_id: e.adjudicator_id || '', decided_at: d.decided_at || '',
    promoted: (e.promoted || []).map((p) => `${p.set_id}/${p.id}`),
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
/** Where an entry was promoted, in words: "Quiz item q04 of practice", or ''. */
export function promotedText(e) {
  return (e.promoted || []).map((p) => `${p.to === 'snippet' ? 'Snippet' : 'Quiz item'} ${p.id} of ${p.set_id}`).join('; ');
}

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
