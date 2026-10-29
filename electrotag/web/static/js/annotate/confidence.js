// How sure the annotator is of each annotation, and the short note an annotation may carry: the
// rules shared by the annotation store (store.js), the annotation view (workspace.js) and the EEG
// viewer, as in electrotag/app/annotations/model.py.
//
// A confidence is 'definite', 'probable' or 'possible', or none ('' : not given). The study's setting
// annotation.confidence is 'optional' (the default: a new mark has none, and the annotator may give
// one) or 'every_mark' (every new mark starts as definite). A note is one line of at most 200
// characters; it is research content, so the interaction log records only its length.

export const CONFIDENCE_LEVELS = ['definite', 'probable', 'possible'];
export const MAX_NOTE_CHARS = 200;

/** Names as the annotator reads them. */
export const CONFIDENCE_TEXT = { '': 'Not given', definite: 'Definite', probable: 'Probable', possible: 'Possible' };

/** The study's setting from GET /me (the first design's 'off' and 'on' read as the two modes). */
export function confidenceMode(value) {
  return value === 'every_mark' || value === 'on' ? 'every_mark' : 'optional';
}

/** The confidence of a new annotation in a mode. */
export const defaultConfidence = (mode) => (confidenceMode(mode) === 'every_mark' ? 'definite' : '');

/** One press of D: not given, definite, probable, possible and round again ('every_mark' skips not given). */
export function nextConfidence(current, mode) {
  const order = confidenceMode(mode) === 'every_mark' ? CONFIDENCE_LEVELS : ['', ...CONFIDENCE_LEVELS];
  const i = order.indexOf(current || '');
  return order[(i + 1) % order.length];
}

/** The levels offered in a menu, in order (with "Not given" in an optional study). */
export const confidenceChoices = (mode) => (confidenceMode(mode) === 'every_mark' ? CONFIDENCE_LEVELS : ['', ...CONFIDENCE_LEVELS]);

/** The lowest confidence given ('' when none was given): what a merged annotation keeps. */
export function lowerConfidence(levels) {
  let worst = -1;
  for (const lv of levels) worst = Math.max(worst, CONFIDENCE_LEVELS.indexOf(lv || ''));
  return worst < 0 ? '' : CONFIDENCE_LEVELS[worst];
}

/** What is wrong with a note ('' when it can be kept). */
export function noteProblem(note) {
  if (note === null || note === undefined) return '';
  if (typeof note !== 'string') return 'A note must be text.';
  if (/[\u0000-\u001f\u007f]/.test(note)) return 'A note is a single line of text.';
  const text = note.trim();
  if (text.toLowerCase() === 'n/a') return 'A note cannot be just "n/a", which the saved files use for "no note".';
  if (text.length > MAX_NOTE_CHARS) return `A note has at most ${MAX_NOTE_CHARS} characters (this one has ${text.length}).`;
  return '';
}

/** A note as kept: without spaces at either end ('' for none). */
export const cleanNote = (note) => (typeof note === 'string' ? note.trim() : '');

/** The notes of merged annotations as one: each different note once, in order, joined with "; ", at most 200 characters. */
export function joinNotes(notes) {
  const kept = [];
  for (const n of notes) {
    const t = cleanNote(n);
    if (t && !kept.includes(t)) kept.push(t);
  }
  const text = kept.join('; ');
  return text.length <= MAX_NOTE_CHARS ? text : `${text.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…`;
}

/** How strongly an annotation is filled on the EEG: lighter for probable and possible, as usual otherwise. */
export function confidenceFill(a) {
  return a.confidence === 'probable' ? 0.6 : a.confidence === 'possible' ? 0.35 : 1;
}

/** What the tag above the EEG adds: the word for probable and possible, nothing otherwise (calm, never a warning). */
export function confidenceTagText(a) {
  return a.confidence === 'probable' || a.confidence === 'possible' ? ` · ${a.confidence}` : '';
}
