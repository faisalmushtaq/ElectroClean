// The words and the arithmetic of the admin area's Datasets section (datasets.js), kept apart from the
// page so that they can be tested without one: a dataset's summary, its ratings against the target, the
// words of the tracking grids, collections built from filters (with a sample that a fixed seed repeats),
// the rows of the tracking download, and the checks of a dataset's details (docs/web/admin.md,
// "Datasets"; the operations are in docs/web/api.md, "Datasets, collections, groups and hand-outs").

import { bytesText, dateText, durationText, formatName, plural, whenText } from './model.js';

/** The built-in dataset (electrotag/web/datasets.py DEFAULT_DATASET_ID), and the bounds of a target of ratings. */
export const DEFAULT_DATASET_ID = 'study-recordings';
export const RATINGS_TARGET = 2;
export const RATINGS_MIN = 1;
export const RATINGS_MAX = 20;
/** The most recordings a collection may hold (datasets.py MAX_COLLECTION) and a page of the recording grid. */
export const MAX_COLLECTION = 2000;
export const TRACKING_PAGE = 1000;

/** The longest text of each detail of a dataset (datasets.py, as admin.py _text checks it). */
export const DATASET_LIMITS = Object.freeze({
  name: 120, description: 5000, origin: 500, licence: 200, citation: 2000, contact: 200, notes: 5000, path_prefix: 120,
});

/** The details of a dataset as the form shows them: [key, label, hint, rows (0 for one line)]. */
export const DATASET_FIELDS = Object.freeze([
  ['name', 'Name', 'For the study team, for example Youth low-density 2026. Annotators never see it.', 0],
  ['description', 'Description', 'What the recordings are and how they were made.', 3],
  ['origin', 'Origin or address', 'Where the recordings came from, for example https://openneuro.org/datasets/ds003420.', 0],
  ['licence', 'Licence', 'For example CC0 or CC BY 4.0.', 0],
  ['citation', 'Citation', 'How to cite the dataset in a paper.', 2],
  ['contact', 'Contact', 'Who to ask about the recordings.', 0],
  ['notes', 'Notes', 'Anything else the study team should know.', 3],
]);

/** The statuses of one person and one recording in the recording grid (tracking.py), with the kind of chip. */
export const CELL_STATUS = Object.freeze({
  not_given: ['Not given', ''],
  given: ['Given', ''],
  opened: ['Opened', 'active'],
  in_progress: ['In progress', 'active'],
  locked: ['Locked', 'warning'],
  saved: ['Saved', 'done'],
  revised: ['Revised', 'done'],
  set_aside: ['Set aside', 'warning'],
});

/** The order of the statuses in the grid's filter, from not yet given to saved. */
export const STATUS_ORDER = Object.freeze(['not_given', 'given', 'opened', 'in_progress', 'locked', 'saved', 'revised', 'set_aside']);

/** The kinds of row of the summary grid. */
export const TRACK_KINDS = Object.freeze([['dataset', 'Datasets'], ['collection', 'Collections'], ['handout', 'Hand-outs']]);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** "A03 · Ann Smith" (the study team sees the name beside the ID once the person has given it), or "A03". */
export function personText(aid, people = {}) {
  const p = people[aid] || {};
  const name = p.full_name || p.display_name || '';
  return name && name !== aid ? `${aid} · ${name}` : String(aid);
}

/** The people of an answer by annotator ID, with the full names users_list gives where it gives them. */
export function peopleById(people = [], users = []) {
  const out = {};
  for (const p of people || []) out[p.annotator_id] = { ...p };
  for (const u of users || []) out[u.annotator_id] = { ...(out[u.annotator_id] || { annotator_id: u.annotator_id }), display_name: (out[u.annotator_id] || {}).display_name || u.display_name || '', full_name: u.full_name || '' };
  return out;
}

/** The number of recordings in use (not retired) of a dataset or collection record. */
export function inUse(rec) {
  const s = rec.summary || rec;
  return Math.max(0, num(s.n_recordings) - num(s.n_retired));
}

/** "12 of 40 rated by 2 people", "Fully rated: 40 by 2 people each", "No recordings yet". */
export function ratingsText(rec) {
  const n = inUse(rec);
  const target = num(rec.ratings_target) || RATINGS_TARGET;
  const who = plural(target, 'person', 'people');
  if (!n) return 'No recordings in use yet';
  if (rec.fully_rated || rec.complete || num(rec.n_rated) >= n) return `Fully rated: all ${n} by ${who}${target > 1 ? ' each' : ''}`;
  return `${num(rec.n_rated)} of ${n} rated by ${who}`;
}

/** The share of the recordings in use that met the target (0 to 1), or null with none. */
export function ratedShare(rec) {
  const n = inUse(rec);
  return n ? Math.min(1, num(rec.n_rated) / n) : null;
}

/** The histogram of ratings ({"0": 30, "1": 12, "2": 4, "3+": 1}) in words: "30 with none, 12 with 1, 4 with 2, 1 with 3 or more". */
export function ratingsHistogramText(ratings) {
  const parts = [];
  for (const [k, n] of Object.entries(ratings || {})) {
    if (!n) continue;
    const who = k === '0' ? 'none' : k.endsWith('+') ? `${k.slice(0, -1)} or more` : k;
    parts.push(`${n} with ${who}`);
  }
  return parts.join(', ') || 'No recordings yet';
}

/** "1 of 2" for a recording's ratings against the target, and whether it met it. */
export function recordingRatings(row, target) {
  const t = num(target ?? row.ratings_target) || RATINGS_TARGET;
  const n = num(row.n_rated);
  return { text: `${n} of ${t}`, met: n >= t };
}

/** The formats of a summary in words: "EDF (120), BrainVision (3)". */
export function formatsText(formats) {
  return Object.entries(formats || {}).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${formatName(f)} (${n})`).join(', ') || '–';
}

/** "19", "19 to 64", or "–". */
export function channelsText(range) {
  if (!range || range.min === null || range.min === undefined) return '–';
  return range.min === range.max ? String(range.min) : `${range.min} to ${range.max}`;
}

/** Hours of recording, to one decimal: "12.5 h". */
export function hoursText(seconds) {
  const s = num(seconds);
  if (!s) return '–';
  return s < 3600 ? durationText(s) : `${(s / 3600).toFixed(1)} h`;
}

/** The derived summary of a dataset (DatasetRecord.summary) as the rows of an information table. */
export function summaryRows(rec) {
  const s = rec.summary || {};
  const rates = (s.sfreq || []).map((f) => `${Number(f)} Hz`).join(', ');
  return [
    ['Recordings', `${num(s.n_recordings)}${num(s.n_retired) ? ` (${s.n_retired} retired)` : ''}`],
    ['Formats', formatsText(s.formats)],
    ['Sampling rates', rates || '–'],
    ['Channels', channelsText(s.n_channels)],
    ['Total length', s.duration_s ? (s.duration_s >= 3600 ? `${hoursText(s.duration_s)} (${durationText(s.duration_s)})` : durationText(s.duration_s)) : '–'],
    ['Total size', s.size_bytes ? bytesText(s.size_bytes) : '–'],
    ['First added', s.first_registered_at ? whenText(s.first_registered_at) : '–'],
    ['Last added', s.last_registered_at ? whenText(s.last_registered_at) : '–'],
    ['Ratings', `${ratingsText(rec)}. ${ratingsHistogramText(rec.ratings)}.`],
  ];
}

/**
 * A dataset's details from the form ({name, description, ..., path_prefix, ratings_target, dataset_id}),
 * checked: the body of dataset_create (with `creating`) or of dataset_update. Throws an Error in plain words.
 */
export function datasetBody(f, { creating = false } = {}) {
  const body = {};
  const name = String(f.name ?? '').trim();
  if (!name) throw new Error('Give the dataset a name.');
  for (const [key, label] of DATASET_FIELDS) {
    const v = String(f[key] ?? '').trim();
    if (v.length > DATASET_LIMITS[key]) throw new Error(`${label}: at most ${DATASET_LIMITS[key].toLocaleString('en-GB')} characters.`);
    if (creating ? v : f[key] !== undefined) body[key] = v;
  }
  body.name = name;
  if (f.ratings_target !== undefined && f.ratings_target !== '') body.ratings_target = ratingsTarget(f.ratings_target);
  if (f.path_prefix !== undefined) {
    const p = prefixProblem(f.path_prefix);
    if (p) throw new Error(p);
    const v = String(f.path_prefix || '').trim().replace(/^\/+|\/+$/g, '');
    if (creating ? v : true) body.path_prefix = v;
  }
  if (creating && String(f.dataset_id || '').trim()) {
    const id = String(f.dataset_id).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error('The ID of a dataset has letters, digits, hyphens and underscores, starting with a letter or digit; at most 64.');
    body.dataset_id = id;
  }
  return body;
}

/** A target of ratings per recording, checked: a whole number from 1 to 20. */
export function ratingsTarget(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < RATINGS_MIN || n > RATINGS_MAX) throw new Error(`The target is a whole number of people from ${RATINGS_MIN} to ${RATINGS_MAX}.`);
  return n;
}

/** Why a path prefix cannot be used ('' when it can): a plain relative folder, without '.' or '..' (datasets.py prefix_problem). */
export function prefixProblem(prefix) {
  const text = String(prefix ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!text) return '';
  if (text.length > DATASET_LIMITS.path_prefix) return `The path prefix has at most ${DATASET_LIMITS.path_prefix} characters.`;
  if (/[\\:*?"<>|]/.test(text) || text.split('/').some((p) => !p || p === '.' || p === '..')) {
    return 'The path prefix is a plain folder name (or folders separated by /), without . or .., for example ds003420.';
  }
  return '';
}

/** A recording ID as it is registered into a dataset with this prefix (manifest.py prefix_manifest). */
export function prefixed(rid, prefix) {
  const p = String(prefix || '').replace(/^\/+|\/+$/g, '');
  return p ? `${p}/${rid}` : rid;
}

/**
 * The recordings found on this computer whose IDs (with the dataset's prefix) belong to a recording of
 * another dataset: Map(recording ID found -> the other dataset's ID). The study skips them, even with
 * Replace; a new dataset with a prefix keeps them apart.
 */
export function collisionsOf(manifests, registered, datasetId, prefix = '') {
  const other = new Map();
  for (const r of registered || []) {
    if (r.scope && r.scope !== 'study') continue;
    other.set(r.recording_id, r.dataset_id || DEFAULT_DATASET_ID);
  }
  const target = datasetId || DEFAULT_DATASET_ID;
  const out = new Map();
  for (const m of manifests || []) {
    const id = prefixed(m.recording_id, prefix);
    const there = other.get(id);
    if (there && there !== target) out.set(m.recording_id, there);
  }
  return out;
}

// ------------------------------------------------------------ collections from filters
/** A generator of numbers in [0, 1) from a seed (mulberry32): the same seed gives the same sample. */
export function seededRandom(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The recordings that filters choose, from the recordings of datasets (RecordingRow): `datasetIds`,
 * `query` (part of the file name or ID), `format`, `minS` and `maxS` (length in seconds), `nRatedMax`
 * (rated by at most n people). Retired recordings are left out. With `sampleN`, a random sample of that
 * many, drawn with `seed` so that the same filters and seed draw the same recordings; the result keeps
 * the order of the recording IDs.
 */
export function filterForCollection(rows, f = {}) {
  const ids = f.datasetIds && f.datasetIds.length ? new Set(f.datasetIds) : null;
  const q = String(f.query || '').trim().toLowerCase();
  const has = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v));
  let out = (rows || []).filter((r) => !r.retired
    && (!ids || ids.has(r.dataset_id || DEFAULT_DATASET_ID))
    && (!q || `${r.recording_id} ${r.file_name || ''}`.toLowerCase().includes(q))
    && (!f.format || r.format === f.format)
    && (!has(f.minS) || num(r.duration_s) >= Number(f.minS))
    && (!has(f.maxS) || num(r.duration_s) <= Number(f.maxS))
    && (!has(f.nRatedMax) || num(r.n_rated) <= Number(f.nRatedMax)));
  out = [...out].sort((a, b) => String(a.recording_id).localeCompare(String(b.recording_id), 'en-GB', { numeric: true }));
  if (has(f.sampleN) && Number(f.sampleN) > 0 && Number(f.sampleN) < out.length) {
    const rand = seededRandom(f.seed);
    const pool = [...out];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const keep = new Set(pool.slice(0, Number(f.sampleN)).map((r) => r.recording_id));
    out = out.filter((r) => keep.has(r.recording_id));
  }
  return out;
}

/** The record of how a collection was built from filters (CollectionRecord.built_from). */
export function builtFrom(f = {}) {
  const has = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v));
  const out = { dataset_ids: [...(f.datasetIds || [])], query: String(f.query || '').trim(), format: f.format || '',
    min_duration_s: has(f.minS) ? Number(f.minS) : null, max_duration_s: has(f.maxS) ? Number(f.maxS) : null,
    n_rated_max: has(f.nRatedMax) ? Number(f.nRatedMax) : null, sample: null };
  if (has(f.sampleN) && Number(f.sampleN) > 0) out.sample = { n: Number(f.sampleN), seed: Number(f.seed) || 0 };
  return out;
}

/** The filters of a built_from record in words, for a collection's page; `nameOf` gives a dataset's name from its ID. */
export function builtFromText(b, nameOf = (id) => id) {
  if (!b) return 'Chosen by hand.';
  const parts = [];
  if (b.dataset_ids && b.dataset_ids.length) parts.push(`from ${b.dataset_ids.map(nameOf).join(', ')}`);
  if (b.query) parts.push(`names with "${b.query}"`);
  if (b.format) parts.push(formatName(b.format));
  if (b.min_duration_s !== null && b.min_duration_s !== undefined) parts.push(`at least ${durationText(b.min_duration_s)}`);
  if (b.max_duration_s !== null && b.max_duration_s !== undefined) parts.push(`at most ${durationText(b.max_duration_s)}`);
  if (b.n_rated_max !== null && b.n_rated_max !== undefined) parts.push(`rated by at most ${plural(b.n_rated_max, 'person', 'people')}`);
  if (b.sample) parts.push(`a random ${b.sample.n} of them (seed ${b.sample.seed})`);
  return parts.length ? `Built from filters: ${parts.join('; ')}.` : 'Built from filters: every recording in use.';
}

/** A collection's list with one recording moved up (-1) or down (+1); the same list at either end. */
export function moved(ids, index, step) {
  const j = index + step;
  if (j < 0 || j >= ids.length) return [...ids];
  const out = [...ids];
  [out[index], out[j]] = [out[j], out[index]];
  return out;
}

// ------------------------------------------------------------------ the tracking grids
/** A cell of the summary grid (datasets by people): "38 of 40", the details in its title, and its overdue flag. */
export function summaryCell(c) {
  if (!c || !num(c.given)) return { text: '–', title: 'Nothing given', overdue: false, done: false, given: 0 };
  const saved = num(c.saved);
  const parts = [`${saved} of ${num(c.given)} saved`];
  if (num(c.revised)) parts.push(`${c.revised} revised`);
  if (num(c.set_aside)) parts.push(`${c.set_aside} set aside`);
  if (num(c.in_progress)) parts.push(`${c.in_progress} in progress`);
  if (num(c.opened)) parts.push(`${c.opened} opened`);
  if (num(c.locked)) parts.push(`${c.locked} locked until the assessment is passed`);
  if (c.first_assigned_at) parts.push(`first given ${dateText(c.first_assigned_at)}`);
  if (c.last_saved_at) parts.push(`last saved ${whenText(c.last_saved_at)}`);
  if (c.due_at) parts.push(`due ${dueText(c.due_at)}`);
  const done = saved + num(c.set_aside) >= num(c.given);
  return { text: `${saved} of ${num(c.given)}`, title: parts.join(' · '), overdue: Boolean(c.overdue), done, given: num(c.given), saved };
}

/** The word of a cell of the recording grid ("Revised v2", "Saved", "Not given"), with the kind of its chip. */
export function cellWord(c) {
  const status = (c && c.status) || 'not_given';
  const [text, kind] = CELL_STATUS[status] || [status, ''];
  if (status === 'revised' && num(c.version) >= 2) return { text: `Revised v${c.version}`, kind };
  return { text, kind };
}

/** The dates of a cell of the recording grid, for its title. */
export function cellTitle(c) {
  if (!c || c.status === 'not_given') return 'Not given to this person';
  const at = (label, v) => (v ? `${label} ${whenText(v)}` : '');
  return [
    c.assigned_at ? `Given ${whenText(c.assigned_at)}${c.assigned_by ? ` by ${c.assigned_by}` : ''}` : (c.assigned_by ? `Given by ${c.assigned_by}` : ''),
    at('opened', c.opened_at), at('first saved', c.first_saved_at),
    c.saved_at && c.saved_at !== c.first_saved_at ? at('last saved', c.saved_at) : '',
    num(c.version) > 1 ? `version ${c.version}` : '',
    at('set aside', c.set_aside_at), c.due_at ? `due ${dueText(c.due_at)}` : '', c.overdue ? 'overdue' : '',
  ].filter(Boolean).join(' · ');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A due date ("2026-11-20") in words: "Friday 20 November 2026". */
export function dueText(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return String(day || '');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "20 November" (as the default titles say a due date; datasets.py day_words). */
export function dayWords(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : String(day || '');
}

/**
 * The rows of the summary grid that the filters keep: `person` (rows that give that person something),
 * `overdue` (rows with overdue work, that person's when one is chosen) and `complete` ('yes', 'no' or '').
 */
export function filterSummary(rows, { person = '', overdue = false, complete = '' } = {}) {
  return (rows || []).filter((r) => {
    const cells = r.cells || {};
    if (person && !num((cells[person] || {}).given)) return false;
    if (overdue && !Object.entries(cells).some(([aid, c]) => c && c.overdue && (!person || aid === person))) return false;
    if (complete === 'yes' && !r.complete) return false;
    if (complete === 'no' && r.complete) return false;
    return true;
  });
}

/** The people of the summary grid that have something in the rows shown (everyone, or the person chosen). */
export function peopleShown(people, rows, person = '') {
  if (person) return (people || []).filter((p) => p.annotator_id === person);
  const used = new Set();
  for (const r of rows || []) for (const [aid, c] of Object.entries(r.cells || {})) if (c && num(c.given)) used.add(aid);
  return (people || []).filter((p) => used.has(p.annotator_id));
}

/** The body of tracking_recordings_get for a page of the recording grid with its filters. */
export function recordingsQuery(target, f = {}, offset = 0) {
  const body = { kind: target.kind, id: target.id, offset, limit: TRACKING_PAGE };
  if (f.status) body.status = f.status;
  if (f.person) body.annotator_id = f.person;
  if (f.overdue) body.overdue = true;
  if (String(f.query || '').trim()) body.query = String(f.query).trim();
  if (f.refresh) body.refresh = true;
  return body;
}

/** The columns of the tracking download: one row for each person and recording (docs/web/admin.md, "Tracking"). */
export const TRACKING_COLUMNS = Object.freeze(['target_kind', 'target_id', 'recording_id', 'file_name', 'dataset_id', 'annotator_id', 'status',
  'assigned_at', 'assigned_by', 'handout_id', 'task_id', 'opened_at', 'first_saved_at', 'saved_at', 'version', 'set_aside_at', 'due_at',
  'overdue', 'n_rated', 'ratings_target']);

/**
 * The rows of the download from pages of tracking_recordings_get: one for each recording and each person
 * of the answer's people (or `person` alone), in the long format a spreadsheet or R reads.
 */
export function trackingCsvRows(target, people, rows, { person = '' } = {}) {
  const ids = person ? [person] : (people || []).map((p) => p.annotator_id);
  const out = [];
  for (const r of rows || []) {
    for (const aid of ids) {
      const c = (r.cells || {})[aid] || { status: 'not_given' };
      out.push({
        target_kind: target.kind, target_id: target.id, recording_id: r.recording_id, file_name: r.file_name || '', dataset_id: r.dataset_id || '',
        annotator_id: aid, status: c.status || 'not_given', assigned_at: c.assigned_at || '', assigned_by: c.assigned_by || '',
        handout_id: c.handout_id || '', task_id: c.task_id || '', opened_at: c.opened_at || '', first_saved_at: c.first_saved_at || '',
        saved_at: c.saved_at || '', version: c.version ?? '', set_aside_at: c.set_aside_at || '', due_at: c.due_at || '',
        overdue: c.overdue ? 'true' : 'false', n_rated: num(r.n_rated), ratings_target: r.ratings_target ?? '',
      });
    }
  }
  return out;
}

/** A file name for the download: "tracking_dataset_youth-ld-2026.csv". */
export function trackingFileName(target) {
  const id = String(target.id || '').replace(/[^A-Za-z0-9_-]+/g, '-');
  return `tracking_${target.kind}_${id}.csv`;
}

/** "Figures from 10:42" (when the figures were worked out), with "kept for up to two minutes" when cached. */
export function figuresText(answer, now = new Date()) {
  if (!answer || !answer.generated_at) return '';
  const d = new Date(answer.generated_at);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = d.toDateString() === now.toDateString() ? '' : ` on ${dateText(answer.generated_at)}`;
  return `Figures from ${time}${day}${answer.cached ? ', kept for up to two minutes' : ''}`;
}
