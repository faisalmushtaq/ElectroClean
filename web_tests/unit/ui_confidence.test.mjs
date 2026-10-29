// Confidence and notes on annotations (js/annotate/confidence.js and the store): the cycle of D in
// both study settings, the checks of a note, the merge rule, undo and redo, and what a draft keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnnotationStore, AnnotationError } from '../../electrotag/web/static/js/annotate/store.js';
import {
  CONFIDENCE_LEVELS, MAX_NOTE_CHARS, confidenceChoices, confidenceFill, confidenceMode, confidenceTagText,
  defaultConfidence, joinNotes, lowerConfidence, nextConfidence, noteProblem,
} from '../../electrotag/web/static/js/annotate/confidence.js';
import { CATALOGUE, DEFAULT_ANNOTATION } from '../../electrotag/web/static/js/api/demo_catalogue.js';

const CH = ['Fp1', 'Fp2', 'C3', 'C4'];
const store = (opts = {}) => new AnnotationStore({ chNames: CH, nSamples: 10000, sfreq: 250, labels: CATALOGUE.labels.map((l) => l.label), ...opts });

test('the study setting: optional by default, every mark on request (and the first design\'s off and on)', () => {
  assert.equal(DEFAULT_ANNOTATION.confidence, 'optional');
  assert.equal(confidenceMode(undefined), 'optional');
  assert.equal(confidenceMode('off'), 'optional');
  assert.equal(confidenceMode('on'), 'every_mark');
  assert.equal(confidenceMode('every_mark'), 'every_mark');
  assert.equal(defaultConfidence('optional'), '');
  assert.equal(defaultConfidence('every_mark'), 'definite');
});

test('D cycles through not given in an optional study and skips it when every mark has a confidence', () => {
  const seq = (mode, from) => { const out = []; let c = from; for (let i = 0; i < 4; i++) { c = nextConfidence(c, mode); out.push(c); } return out; };
  assert.deepEqual(seq('optional', ''), ['definite', 'probable', 'possible', '']);
  assert.deepEqual(seq('every_mark', 'definite'), ['probable', 'possible', 'definite', 'probable']);
  assert.equal(nextConfidence(undefined, 'every_mark'), 'definite');
  assert.deepEqual(confidenceChoices('optional'), ['', ...CONFIDENCE_LEVELS]);
  assert.deepEqual(confidenceChoices('every_mark'), CONFIDENCE_LEVELS);
});

test('the EEG shows probable and possible calmly and leaves other marks as they were', () => {
  assert.equal(confidenceFill({}), 1);
  assert.equal(confidenceFill({ confidence: 'definite' }), 1);
  assert.ok(confidenceFill({ confidence: 'possible' }) < confidenceFill({ confidence: 'probable' }));
  assert.equal(confidenceTagText({}), '');
  assert.equal(confidenceTagText({ confidence: 'definite' }), '');
  assert.equal(confidenceTagText({ confidence: 'probable' }), ' · probable');
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
  assert.equal(lowerConfidence(['definite', 'possible', '']), 'possible');
  assert.equal(lowerConfidence(['', undefined]), '');
});

test('a new mark has no confidence in an optional study; setting and clearing it undo and redo', () => {
  const s = store();
  const a = s.add('EMG-artifact', 100, 50);
  assert.equal('confidence' in a, false);
  assert.equal('note' in a, false);
  s.setConfidence(a.annotation_id, 'probable');
  assert.equal(s.get(a.annotation_id).confidence, 'probable');
  assert.equal(s.undoDescription, 'set confidence probable');
  s.setConfidence(a.annotation_id, '');
  assert.equal('confidence' in s.get(a.annotation_id), false);
  assert.equal(s.undoDescription, 'remove confidence');
  s.setNote(a.annotation_id, '  could be a cable  ');
  assert.equal(s.get(a.annotation_id).note, 'could be a cable');
  assert.equal(s.undoDescription, 'add note');
  s.setNote(a.annotation_id, 'a cable');
  assert.equal(s.undoDescription, 'change note');
  s.setNote(a.annotation_id, '');
  assert.equal(s.undoDescription, 'remove note');
  const states = [];
  for (let i = 0; i < 5; i++) { s.undo(); const c = s.get(a.annotation_id); states.push([c.confidence || '', c.note || '']); }
  assert.deepEqual(states, [['', 'a cable'], ['', 'could be a cable'], ['', ''], ['probable', ''], ['', '']]);
  s.redo();
  assert.equal(s.get(a.annotation_id).confidence, 'probable');
  assert.throws(() => s.setConfidence(a.annotation_id, 'sure'), AnnotationError);
  assert.throws(() => s.setNote(a.annotation_id, 'x'.repeat(201)), /at most 200/);
});

test('every new mark starts as definite in an every-mark study, and several change in one step', () => {
  const s = store({ defaultConfidence: 'definite' });
  const a = s.add('EMG-artifact', 100, 50);
  const b = s.add('Movement-artifact', 2000, 50);
  assert.equal(a.confidence, 'definite');
  s.setConfidenceMany([a.annotation_id, b.annotation_id], 'possible');
  assert.deepEqual(s.annotations().map((x) => x.confidence), ['possible', 'possible']);
  assert.equal(s.undoDescription, 'set confidence possible (2 annotations)');
  s.undo();
  assert.deepEqual(s.annotations().map((x) => x.confidence), ['definite', 'definite']);
});

test('an automatic merge keeps the lower confidence and both notes, as store.py does', () => {
  const s = store();
  const a = s.add('EMG-artifact', 100, 100, [], null, { confidence: 'definite', note: 'jaw' });
  s.add('Eye-blink-artifact', 120, 30, [], null, { confidence: 'possible' });
  const b = s.add('EMG-artifact', 150, 100, [], null, { confidence: 'probable', note: 'chewing?' });
  assert.equal(b.annotation_id, a.annotation_id);
  const m = s.get(a.annotation_id);
  assert.deepEqual([m.onset_sample, m.duration_samples, m.confidence, m.note], [100, 150, 'probable', 'jaw; chewing?']);
  const c = s.add('EMG-artifact', 5000, 100, ['C3'], null, { note: 'left' });
  const d = s.add('EMG-artifact', 6000, 100, ['C4'], null, { confidence: 'possible', note: 'right' });
  const merged = s.merge([d.annotation_id, c.annotation_id]);
  assert.deepEqual([merged.confidence, merged.note], ['possible', 'left; right']);
});

test('drafts and revisions keep both fields; a draft from the server with none stays as it was', () => {
  const s = store();
  const a = s.add('EMG-artifact', 100, 50, [], null, { confidence: 'possible', note: 'jaw' });
  const json = s.toJSON();
  assert.deepEqual([json[0].confidence, json[0].note], ['possible', 'jaw']);
  const t = store();
  t.reset([...json, { annotation_id: 'x1', label: 'Movement-artifact', onset_sample: 3000, duration_samples: 10, channels: [], confidence: null, note: '' }]);
  assert.equal(t.get(a.annotation_id).note, 'jaw');
  assert.deepEqual(Object.keys(t.get('x1')).includes('confidence'), false);
  assert.throws(() => t.reset([{ ...json[0], confidence: 'maybe' }]), AnnotationError);
});
