// Confidence ratings (a 5-point scale) and notes on annotations (js/annotate/confidence.js and the
// store): the scale and its anchors, the study setting, the checks of a note, the merge rule, undo and
// redo, and what a draft keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnnotationStore, AnnotationError } from '../../electrotag/web/static/js/annotate/store.js';
import {
  CONFIDENCE_ANCHORS, CONFIDENCE_LEVELS, MAX_NOTE_CHARS, confidenceFill, confidenceMode, confidenceTagText, confidenceText,
  isConfidence, joinNotes, lowerConfidence, noteProblem,
} from '../../electrotag/web/static/js/annotate/confidence.js';
import { CATALOGUE, DEFAULT_ANNOTATION } from '../../electrotag/web/static/js/api/demo_catalogue.js';

const CH = ['Fp1', 'Fp2', 'C3', 'C4'];
const store = (opts = {}) => new AnnotationStore({ chNames: CH, nSamples: 10000, sfreq: 250, labels: CATALOGUE.labels.map((l) => l.label), ...opts });

test('the scale: whole numbers from 1 to 5 with the standard anchors', () => {
  assert.deepEqual(CONFIDENCE_LEVELS, [1, 2, 3, 4, 5]);
  assert.deepEqual(Object.values(CONFIDENCE_ANCHORS), ['Not at all confident', 'Slightly confident', 'Moderately confident',
    'Very confident', 'Completely confident']);
  assert.deepEqual([1, 5, 0, 6, 2.5, '3', true, null].map(isConfidence), [true, true, false, false, false, false, false, false]);
  assert.equal(confidenceText(3), '3/5');
  assert.equal(confidenceText(null), '');
});

test('the study setting: optional by default, every mark on request (and the first design\'s off and on)', () => {
  assert.equal(DEFAULT_ANNOTATION.confidence, 'optional');
  assert.equal(confidenceMode(undefined), 'optional');
  assert.equal(confidenceMode('off'), 'optional');
  assert.equal(confidenceMode('on'), 'every_mark');
  assert.equal(confidenceMode('every_mark'), 'every_mark');
});

test('the EEG fills low ratings more lightly, names the rating in the tag, and leaves unrated marks as they were', () => {
  assert.equal(confidenceFill({}), 1);
  assert.equal(confidenceFill({ confidence: 3 }), 1);
  assert.equal(confidenceFill({ confidence: 5 }), 1);
  assert.ok(confidenceFill({ confidence: 1 }) < 1 && confidenceFill({ confidence: 2 }) < 1);
  assert.equal(confidenceTagText({}), '');
  assert.equal(confidenceTagText({ confidence: 3 }), ' · 3/5');
});

test('notes are one line of at most 200 characters, and merged notes are joined', () => {
  assert.equal(noteProblem(''), '');
  assert.equal(noteProblem('x'.repeat(MAX_NOTE_CHARS)), '');
  assert.match(noteProblem('x'.repeat(MAX_NOTE_CHARS + 1)), /at most 200/);
  assert.match(noteProblem('two\nlines'), /single line/);
  assert.match(noteProblem('n/a'), /n\/a/);
  assert.equal(joinNotes(['jaw', '', 'chewing?', 'jaw']), 'jaw; chewing?');
  const long = joinNotes(['a'.repeat(150), 'b'.repeat(150)]);
  assert.equal(long.length, MAX_NOTE_CHARS);
  assert.ok(long.endsWith('…'));
  assert.equal(lowerConfidence([5, 2, undefined]), 2);
  assert.equal(lowerConfidence([undefined, null]), null);
});

test('a new mark is never rated; rating, clearing and notes undo and redo', () => {
  const s = store();
  const a = s.add('EMG-artifact', 100, 50);
  assert.equal('confidence' in a, false);
  assert.equal('note' in a, false);
  s.setConfidence(a.annotation_id, 4);
  assert.equal(s.get(a.annotation_id).confidence, 4);
  assert.equal(s.undoDescription, 'set confidence 4');
  s.setConfidence(a.annotation_id, null);
  assert.equal('confidence' in s.get(a.annotation_id), false);
  assert.equal(s.undoDescription, 'clear confidence');
  s.setNote(a.annotation_id, '  could be a cable  ');
  assert.equal(s.get(a.annotation_id).note, 'could be a cable');
  assert.equal(s.undoDescription, 'add note');
  s.setNote(a.annotation_id, 'a cable');
  assert.equal(s.undoDescription, 'change note');
  s.setNote(a.annotation_id, '');
  assert.equal(s.undoDescription, 'remove note');
  const states = [];
  for (let i = 0; i < 5; i++) { s.undo(); const c = s.get(a.annotation_id); states.push([c.confidence ?? null, c.note || '']); }
  assert.deepEqual(states, [[null, 'a cable'], [null, 'could be a cable'], [null, ''], [4, ''], [null, '']]);
  s.redo();
  assert.equal(s.get(a.annotation_id).confidence, 4);
  for (const bad of [6, '4', 2.5, true]) assert.throws(() => s.setConfidence(a.annotation_id, bad), AnnotationError);
  assert.throws(() => s.setNote(a.annotation_id, 'x'.repeat(201)), /at most 200/);
});

test('several marks are rated in one step', () => {
  const s = store();
  const a = s.add('EMG-artifact', 100, 50);
  const b = s.add('Movement-artifact', 2000, 50);
  s.setConfidenceMany([a.annotation_id, b.annotation_id], 2);
  assert.deepEqual(s.annotations().map((x) => x.confidence), [2, 2]);
  assert.equal(s.undoDescription, 'set confidence 2 (2 annotations)');
  s.undo();
  assert.deepEqual(s.annotations().map((x) => x.confidence ?? null), [null, null]);
});

test('an automatic merge keeps the lower rating and both notes, as store.py does', () => {
  const s = store();
  const a = s.add('EMG-artifact', 100, 100, [], null, { confidence: 5, note: 'jaw' });
  s.add('Eye-blink-artifact', 120, 30, [], null, { confidence: 1 });
  const b = s.add('EMG-artifact', 150, 100, [], null, { confidence: 3, note: 'chewing?' });
  assert.equal(b.annotation_id, a.annotation_id);
  const m = s.get(a.annotation_id);
  assert.deepEqual([m.onset_sample, m.duration_samples, m.confidence, m.note], [100, 150, 3, 'jaw; chewing?']);
  const c = s.add('EMG-artifact', 5000, 100, ['C3'], null, { note: 'left' });
  const d = s.add('EMG-artifact', 6000, 100, ['C4'], null, { confidence: 2, note: 'right' });
  const merged = s.merge([d.annotation_id, c.annotation_id]);
  assert.deepEqual([merged.confidence, merged.note], [2, 'left; right']);
});

test('drafts and revisions keep both fields; an annotation from the server without them stays as it was', () => {
  const s = store();
  const a = s.add('EMG-artifact', 100, 50, [], null, { confidence: 2, note: 'jaw' });
  const json = s.toJSON();
  assert.deepEqual([json[0].confidence, json[0].note], [2, 'jaw']);
  const t = store();
  t.reset([...json, { annotation_id: 'x1', label: 'Movement-artifact', onset_sample: 3000, duration_samples: 10, channels: [], confidence: null, note: '' }]);
  assert.equal(t.get(a.annotation_id).note, 'jaw');
  assert.equal('confidence' in t.get('x1'), false);
  for (const bad of ['probable', 7, '3']) assert.throws(() => t.reset([{ ...json[0], confidence: bad }]), AnnotationError);
});
