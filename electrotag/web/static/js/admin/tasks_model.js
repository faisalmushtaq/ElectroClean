// The words and the arithmetic of the admin area's Tasks section (tasks.js), kept apart from the page
// so that they can be tested without one: the request a share-out sends, what its preview says, the
// statuses and the filters of the list (docs/web/admin.md, "Tasks"; docs/web/api.md, "Tasks, windows
// and known answers").

import { clockText } from '../viewer/bounds.js';
import { plural } from './model.js';

/** How many annotators a task may have (electrotag/web/tasks.py K_MIN, K_MAX) and the shortest window. */
export const K_MIN = 2;
export const K_MAX = 6;
export const MIN_WINDOW_S = 2;

/** A task's derived status, as the list shows it, with the kind of its chip. */
export const STATUS = Object.freeze({
  collecting: ['Collecting', 'active'],
  saved: ['All saved', 'done'],
  ready: ['Conflicts to resolve', 'warning'],
  agreed: ['Agreed', 'done'],
  adjudicating: ['Being adjudicated', 'active'],
  adjudicated: ['Adjudicated', 'done'],
  gold: ['Known answer', ''],
});

/** Where each person in a task stands. */
export const PERSON = Object.freeze({
  todo: 'To do', in_progress: 'In progress', done: 'Saved', unusable: 'Cannot be annotated', closed: 'Taken away (closed)',
});

/** Why a recording, or a part of one, got no task (electrotag/web/tasks.py SKIP_REASONS), in plain words. */
export const SKIPPED = Object.freeze({
  retired: 'The recording is retired.',
  has_task: 'It already has an open task.',
  too_few_annotators: 'Too few of the chosen annotators are free for it (nobody holds two parts of one recording).',
  window_outside: 'The part lies beyond the end of the recording.',
  window_too_short: 'The part left at the end of the recording is too short.',
  no_gold_reference: 'The known-answer set has no reference for it.',
  gold_mismatch: "The known-answer set's copy of this recording is a different file.",
  fewer_than_two: 'Fewer than two of the chosen annotators have it.',
  too_many_annotators: `More than ${K_MAX} people have it.`,
});

export const PARTS = Object.freeze([
  ['whole', 'The whole recording'],
  ['one', 'One stretch of each recording'],
  ['many', 'Consecutive parts of each recording'],
]);

export const statusText = (s) => (STATUS[s] || [s])[0];
export const statusKind = (s) => (STATUS[s] || ['', ''])[1];

/** A task's part of its recording: "0:20 to 0:40", or "Whole recording". */
export function partText(window) {
  if (!window) return 'Whole recording';
  return `${clockText(window.start_s)} to ${clockText(window.end_s)}`;
}

/** The part of a recording a skipped row names: "Whole recording" or "From 0:40". */
export function skippedPart(x) {
  return x && typeof x.start_s === 'number' ? `From ${clockText(x.start_s)}` : 'Whole recording';
}

const number = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

/**
 * The body of tasks_preview_get and tasks_create from what the form holds:
 * {pool, all, recordingIds, k, part, startS, endS, lengthS, overlapS, gold, adopt, batch, notes}.
 * Throws an Error in plain words when something needed is missing.
 */
export function requestBody(f) {
  const pool = [...(f.pool || [])];
  if (!pool.length) throw new Error('Choose the annotators to share the recordings among.');
  const body = { annotator_ids: pool };
  if (f.all) body.all = true;
  else {
    if (!f.recordingIds || !f.recordingIds.length) throw new Error('Choose at least one recording, or tick Every recording.');
    body.recording_ids = [...f.recordingIds];
  }
  if (f.adopt) {
    body.adopt = true;
  } else if (f.gold) {
    body.gold = { set_id: f.gold };
  } else {
    const k = Number(f.k);
    if (!Number.isInteger(k) || k < K_MIN || k > K_MAX) throw new Error(`Each recording goes to ${K_MIN} to ${K_MAX} annotators.`);
    if (k > pool.length) throw new Error(`Each recording is to go to ${k} people, so choose at least ${k} annotators.`);
    body.k = k;
  }
  if (!f.adopt && f.part === 'one') {
    const a = number(f.startS);
    const b = number(f.endS);
    if (!(a >= 0) || !(b >= 0)) throw new Error('Give the start and the end of the stretch, in seconds.');
    if (b - a < MIN_WINDOW_S) throw new Error(`The stretch must end at least ${MIN_WINDOW_S} seconds after it starts.`);
    body.window = { start_s: a, end_s: b };
  } else if (!f.adopt && f.part === 'many') {
    const len = number(f.lengthS);
    const overlap = f.overlapS === '' || f.overlapS === undefined ? 0 : number(f.overlapS);
    if (!(len >= MIN_WINDOW_S)) throw new Error(`Give the length of each part, at least ${MIN_WINDOW_S} seconds.`);
    if (!(overlap >= 0) || overlap >= len / 2) throw new Error('The overlap must be less than half the length of a part.');
    body.windows = { length_s: len, overlap_s: overlap };
  }
  const batch = String(f.batch || '').trim();
  if (batch) body.batch = batch.slice(0, 80);
  const notes = String(f.notes || '').trim();
  if (notes) body.notes = notes.slice(0, 1000);
  return body;
}

/**
 * What a preview (tasks_preview_get) says, for the page: the people's rows with their totals after
 * the share-out, the smallest and largest new share, whether everyone gets the same, the skipped
 * recordings by reason, and one sentence.
 */
export function previewSummary(p) {
  const people = (p.per_annotator || []).map((r) => ({ ...r, total: (r.open_before || 0) + (r.new || 0) }));
  const shares = people.map((r) => r.new || 0);
  const least = shares.length ? Math.min(...shares) : 0;
  const most = shares.length ? Math.max(...shares) : 0;
  const skipped = {};
  for (const s of p.skipped || []) skipped[s.reason] = (skipped[s.reason] || 0) + 1;
  const n = p.created || 0;
  const recordings = new Set((p.tasks || []).map((t) => t.recording_id)).size;
  const parts = n > recordings ? ` (${plural(recordings, 'recording')} in ${n} parts)` : '';
  const each = p.k ? `, each to ${p.k} people` : (p.tasks || []).some((t) => t.gold) ? ', each a known answer for everyone chosen' : '';
  const linked = people.reduce((x, r) => x + (r.linked || 0), 0);
  let sentence = n ? `${plural(n, 'task')}${parts}${each}: ${plural(p.assigned || 0, 'new assignment')}` : 'Nothing would be made.';
  if (n && linked) sentence += `; ${plural(linked, 'assignment')} that people already hold ${linked === 1 ? 'becomes' : 'become'} part of their tasks`;
  if (n) sentence += '.';
  if (n && people.length > 1) sentence += least === most ? ` Everyone gets ${least}.` : ` Each person gets ${least} to ${most}.`;
  const nSkipped = (p.skipped || []).length;
  if (nSkipped) sentence += ` ${plural(nSkipped, 'recording or part', 'recordings or parts')} left out (below).`;
  return { people, least, most, balanced: least === most, skipped, sentence, n, recordings };
}

/** The tasks the list shows: by status, by person (in the task) and by a search of the recording's name. */
export function filterTasks(tasks, { status = '', person = '', q = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return (tasks || []).filter((t) => (!status || t.status === status) && (!person || (t.annotators || []).includes(person)) &&
    (!needle || `${t.recording_id} ${t.file_name || ''} ${t.batch || ''}`.toLowerCase().includes(needle)));
}

/** "1 of 2 saved". */
export function savedText(t) {
  const c = t.counts || {};
  return `${c.saved || 0} of ${c.annotators ?? (t.annotators || []).length} saved`;
}

/** The people who can be taken out of a task (nobody who saved it) and those who can be put in (active, not in it). */
export function changeChoices(task, users) {
  const saved = new Set((task.people || []).filter((p) => p.status === 'done').map((p) => p.annotator_id));
  const inTask = new Set(task.annotators || []);
  return {
    out: (task.annotators || []).filter((a) => !saved.has(a)),
    in: (users || []).filter((u) => u.status === 'active' && !inTask.has(u.annotator_id)).map((u) => u.annotator_id),
  };
}

/** A share (0 to 1) as a percentage for the quality table, or a dash. */
export function percent(v) {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 100)}%` : '–';
}
