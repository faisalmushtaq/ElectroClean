// The difference between a saved version and its correction (js/expert/diff.js), against the cases that
// electrotag/web/corrections.py is tested with (correction_diff_cases.json), and the words the
// correction view and the annotator's feedback use for each change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REASONS, changeCounts, changeText, countsText, diffAnnotations, needsReason, suggestedReason } from '../../electrotag/web/static/js/expert/diff.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(path.join(HERE, 'correction_diff_cases.json'), 'utf8'));

test('the difference is the server\'s, case by case', () => {
  assert.ok(cases.length >= 10);
  for (const c of cases) {
    const got = diffAnnotations(c.original, c.current).map(({ annotation_id, change, fields }) => ({ annotation_id, change, fields }));
    assert.deepEqual(got, c.expected, c.name);
  }
});

test('which changes need a reason, and the reason offered first', () => {
  assert.deepEqual(['added', 'removed', 'changed'].map((k) => needsReason(k, 'always')), [true, true, true]);
  assert.deepEqual(['added', 'removed', 'changed'].map((k) => needsReason(k, 'edited_or_none')), [false, true, true]);
  assert.deepEqual(['added', 'removed', 'changed'].map((k) => needsReason(k, 'never')), [false, false, false]);
  assert.deepEqual(Object.keys(REASONS), ['missed', 'not_artifact', 'wrong_type', 'boundaries', 'channels', 'split_merge', 'other']);
  const [several] = cases.filter((c) => c.name.startsWith('several'));
  const changes = diffAnnotations(several.original, several.current);
  assert.deepEqual(changes.map(suggestedReason), ['boundaries', 'missed', 'not_artifact', 'wrong_type']);
  assert.deepEqual(changeCounts(changes), { added: 1, removed: 1, changed: 2 });
  assert.equal(countsText(changeCounts(changes)), '1 added, 1 removed, 2 changed');
  assert.equal(countsText({ added: 0, removed: 0, changed: 0 }), 'no changes');
});

test('each change in plain words', () => {
  const [several] = cases.filter((c) => c.name.startsWith('several'));
  const words = diffAnnotations(several.original, several.current).map((c) => changeText(c, 256));
  assert.deepEqual(words, [
    'Changed start and end: Eye-blink-artifact 1.97–2.36 s (was 1.95–2.34 s)',
    'Added Eye-blink-artifact 3.52–3.83 s',
    'Removed Chewing-artifact 4.69–5.86 s',
    'Changed type: EMG-artifact to Chewing-artifact 11.72–12.70 s',
  ]);
});

test('the correction\'s body, the changes still without a reason, and where the work in progress is kept', async () => {
  const { correctionBody, correctionKey, missingReasons } = await import('../../electrotag/web/static/js/expert/correction_pass.js');
  const [several] = cases.filter((c) => c.name.startsWith('several'));
  const changes = diffAnnotations(several.original, several.current);
  const reasons = { b1: { reason: 'boundaries', note: '  starts earlier  ' }, c1: { reason: 'not_artifact', note: '' } };
  assert.deepEqual(missingReasons(changes, reasons, 'always'), ['n2', 'e1']);
  assert.deepEqual(missingReasons(changes, reasons, 'edited_or_none'), ['e1'], 'an added mark needs no reason then');
  assert.deepEqual(missingReasons(changes, {}, 'never'), []);
  const target = { annotator_id: 'A01', recording_id: 'sub-01/eeg/x.edf', attempt: 2 };
  const body = correctionBody({ correctionId: 'f'.repeat(32), target, annotations: several.current, changes, reasons, overall: 'x'.repeat(1200), session: { elapsed_s: 3 }, sha256: '0'.repeat(64) });
  assert.equal(body.attempt, 2);
  assert.equal(body.mode, 'standard');
  assert.deepEqual(body.changes.map((c) => [c.annotation_id, c.reason, c.note]), [['b1', 'boundaries', 'starts earlier'], ['n2', '', ''], ['c1', 'not_artifact', ''], ['e1', '', '']]);
  assert.equal(body.overall_note.length, 1000, 'the overall note is cut to 1000 characters');
  assert.equal(correctionKey({ kind: 'demo' }, 'E01', target), 'electrotag.correction|demo|E01|A01|sub-01/eeg/x.edf|v2');
});

test('the replay plays every session up to the one that saved the version shown', async () => {
  const { segmentText, segmentsFor } = await import('../../electrotag/web/static/js/replay/player.js');
  const segs = [{ attempt: null, outcome: 'closed_without_saving' }, { attempt: 1, outcome: 'finished' }, { attempt: 2, outcome: 'finished' }];
  assert.equal(segmentsFor(segs, 1).length, 2);
  assert.equal(segmentsFor(segs, 2).length, 3);
  assert.equal(segmentsFor(segs, 7).length, 3, 'a version without its session: every session');
  assert.match(segmentText({ ...segs[1], started_at: '2026-10-14T10:05:00+01:00' }, 1), /^Session 2: 14 October at \d\d:\d\d, saved as version 1$/);
  assert.match(segmentText(segs[0], 0), /Session 1: an earlier visit, closed without saving/);
});

test('each kind of change is offered only the reasons that suit it, each with its key', async () => {
  const { CHANGES, REASONS_FOR, REASON_KEYS, reasonsFor, correctionKey, KIND_WORDS } = await import('../../electrotag/web/static/js/expert/diff.js');
  assert.deepEqual(Object.keys(REASONS_FOR), [...CHANGES]);
  assert.ok(!reasonsFor('added').includes('not_artifact'), 'an added mark is never "Not an artifact"');
  assert.ok(!reasonsFor('removed').includes('missed') && !reasonsFor('changed').includes('missed') && !reasonsFor('changed').includes('not_artifact'));
  for (const list of Object.values(REASONS_FOR)) for (const k of list) assert.ok(REASONS[k], k);
  assert.deepEqual(Object.values(REASON_KEYS), ['1', '2', '3', '4', '5', '6', '7'], 'the keys follow the order of the chips');
  assert.deepEqual(KIND_WORDS, { added: 'Added', removed: 'Removed', changed: 'Changed' });
  const { correctionBody, missingReasons, CORRECTION_KEYS } = await import('../../electrotag/web/static/js/expert/correction_pass.js');
  const [several] = cases.filter((c) => c.name.startsWith('several'));
  const changes = diffAnnotations(several.original, several.current);
  // a reason kept from before that does not suit the change counts as none, and is not sent
  const reasons = { b1: { reason: 'boundaries' }, n2: { reason: 'not_artifact' }, c1: { reason: 'not_artifact' }, e1: { reason: 'wrong_type' } };
  assert.deepEqual(missingReasons(changes, reasons, 'always'), ['n2']);
  const body = correctionBody({ correctionId: 'f'.repeat(32), target: { annotator_id: 'A01', recording_id: 'r', attempt: 1 }, annotations: several.current, changes, reasons, overall: '', session: {}, sha256: '0'.repeat(64) });
  assert.equal(body.changes.find((c) => c.annotation_id === 'n2').reason, '');
  assert.equal(correctionKey({ kind: 'server' }, 'E01', { annotator_id: 'A01', recording_id: 'r', attempt: 3 }), 'electrotag.correction|server|E01|A01|r|v3');
  // the key sheet of the correction view: N and P for the changes, as in the other expert views
  const rows = CORRECTION_KEYS.flatMap((g) => g.rows.map((r) => r[0]));
  assert.ok(rows.includes('N / P') && rows.includes('R') && rows.includes('Shift+1–7') && rows.includes('?'));
  assert.ok(!rows.some((k) => /\bJ\b|\bK\b/.test(k)), 'no J and K any more');
});

test('the replay folds a key pressed several times in a row into one line of What happened last', async () => {
  const { recentLines, REPLAY_KEYS } = await import('../../electrotag/web/static/js/replay/player.js');
  const items = ['Pressed N', 'Pressed N', 'Pressed N', 'Created EMG-artifact', 'Pressed N', 'Pressed P'].map((text, i) => ({ e: { text }, t: i, change: text.startsWith('Created') }));
  const got = recentLines(items, items.length - 1, (e) => e.text, 3);
  assert.deepEqual(got.map((x) => [x.text, x.times]), [['Pressed P', 1], ['Pressed N', 1], ['Created EMG-artifact', 1]]);
  const early = recentLines(items, 2, (e) => e.text, 6);
  assert.deepEqual(early.map((x) => [x.text, x.times, x.t]), [['Pressed N', 3, 2]], 'three presses, one line, at the latest of them');
  assert.ok(REPLAY_KEYS.flatMap((g) => g.rows.map((r) => r[0])).includes('?'));
});

test('the history says how experts\' corrections of a version stand, never one expert\'s version where they disagree', async () => {
  const { correctedText } = await import('../../electrotag/web/static/js/views/home_list.js');
  const { standingText, decisionWords, whyText, namesText } = await import('../../electrotag/web/static/js/expert/settled.js');
  const people = [{ corrector_id: 'E01', corrector_name: 'Expert one' }, { corrector_id: 'E02', corrector_name: '' }];
  const single = { standing: 'single', corrector_id: 'E01', corrector_name: 'Expert one', counts: { added: 1, removed: 0, changed: 2 }, correctors: people.slice(0, 1) };
  const pending = { standing: 'pending', corrector_id: 'E02', counts: { added: 0, removed: 0, changed: 0 }, correctors: people };
  const settled = { standing: 'adjudicated', counts: { added: 0, removed: 0, changed: 1 }, correctors: people, adjudication: { adjudicator_id: 'E03', adjudicator_name: 'Expert three' } };
  assert.equal(correctedText([single]), 'Corrected by Expert one: 3 changes');
  assert.equal(correctedText([pending]), 'Corrected by Expert one and E02, who disagree in places: the study is settling it');
  assert.equal(correctedText([settled]), 'Corrected by Expert one and E02, settled by Expert three: 1 change');
  for (const it of [single, pending, settled]) assert.equal(standingText(it), correctedText([it]));
  assert.equal(namesText([...people, { corrector_id: 'E04' }]), 'Expert one, E02 and E04');
  assert.equal(decisionWords({ choice: 'B', kept_names: ['Expert one'] }), 'Expert one\'s correction was kept');
  assert.equal(decisionWords({ choice: 'none' }), 'Neither expert\'s mark was kept');
  assert.equal(decisionWords({ choice: 'edited' }), 'Replaced by the adjudicator\'s own mark');
  assert.equal(whyText({ reason_text: 'the type shows in the EEG', reason: 'the eyes move sideways' }), 'the type shows in the EEG: the eyes move sideways');
});
