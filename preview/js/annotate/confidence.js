// How confident the annotator is of each annotation, and the short note an annotation may carry: the
// rules shared by the annotation store (store.js), the annotation view (workspace.js) and the EEG
// viewer, as in electrotag/app/annotations/model.py.
//
// A confidence is a rating on a 5-point Likert scale, a whole number from 1 (not at all confident) to
// 5 (completely confident), or none (not rated). No mark ever starts with a rating. The study's
// setting annotation.confidence is 'optional' (the default: the annotator rates a mark when they
// wish) or 'every_mark' (the annotator is asked to rate each new mark, and Save and Finish lists the
// marks left unrated). A note is one line of at most 200 characters; it is research content, so the
// interaction log records only its length.

export const CONFIDENCE_LEVELS = [1, 2, 3, 4, 5];
export const MAX_NOTE_CHARS = 200;

/** The anchors of the scale, as the annotator reads them. */
export const CONFIDENCE_ANCHORS = {
  1: 'Not at all confident',
  2: 'Slightly confident',
  3: 'Moderately confident',
  4: 'Very confident',
  5: 'Completely confident',
};

/** True for a rating of the scale: a whole number from 1 to 5. */
export const isConfidence = (v) => Number.isInteger(v) && v >= 1 && v <= 5;

/** A rating as text: "3/5", or '' when not rated. */
export const confidenceText = (v) => (isConfidence(v) ? `${v}/5` : '');

/** The study's setting from GET /me ('off' and 'on', from the first design, read as the two modes). */
export function confidenceMode(value) {
  return value === 'every_mark' || value === 'on' ? 'every_mark' : 'optional';
}

/** The lowest rating given (null when none was rated): what a merged annotation keeps. */
export function lowerConfidence(levels) {
  const given = levels.filter(isConfidence);
  return given.length ? Math.min(...given) : null;
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

/** How strongly an annotation is filled on the EEG: lighter for ratings 1 and 2, as usual otherwise. */
export function confidenceFill(a) {
  return a.confidence === 1 || a.confidence === 2 ? 0.5 : 1;
}

/** What the tag above the EEG adds: " · 3/5" for a rated mark, nothing for an unrated one. */
export function confidenceTagText(a) {
  return isConfidence(a.confidence) ? ` · ${a.confidence}/5` : '';
}
