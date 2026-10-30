// Tasks in the browser: a task's part of the recording (js/viewer/bounds.js) as the viewer keeps the
// view in it and the annotation store refuses marks outside it, and the admin area's Tasks section's
// words and arithmetic (js/admin/tasks_model.js): the request a share-out sends and what its preview says.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTEXT_S, boundsOf, clampView, clockText, insideBounds, itemWindow, outsideStretches, outsideText, viewSpan } from '../../electrotag/web/static/js/viewer/bounds.js';
import { AnnotationStore, AnnotationError } from '../../electrotag/web/static/js/annotate/store.js';
import { CATALOGUE } from '../../electrotag/web/static/js/api/demo_catalogue.js';
import { changeChoices, filterTasks, partText, previewSummary, requestBody, savedText, skippedPart, statusKind, statusText, SKIPPED } from '../../electrotag/web/static/js/admin/tasks_model.js';

const SF = 128;
const N = 7680; // 60 s
const W = { start_sample: 2560, end_sample: 5120, start_s: 20, end_s: 40 };

test('the times of a part read as the server writes them', () => {
  // the same as electrotag/web/tasks.py clock (tests/test_web_tasks.py)
  assert.deepEqual([5, 90, 3725, 12.5, 59.96, 0].map(clockText), ['0:05', '1:30', '1:02:05', '0:12.5', '1:00', '0:00']);
  const b = boundsOf(W, SF, N);
  assert.deepEqual(b, { startSample: 2560, endSample: 5120, startS: 20, endS: 40, text: '0:20 to 0:40' });
  assert.equal(boundsOf(null, SF, N), null);
  assert.equal(boundsOf({ start_sample: 0, end_sample: N }, SF, N), null, 'the whole recording has no bounds');
  assert.equal(boundsOf({ start_sample: 10, end_sample: 5 }, SF, N), null);
  assert.equal(boundsOf({ start_sample: 0, end_sample: 99999 }, SF, N), null, 'clipped to the recording');
  const items = [{ recording_id: 'r1', mode: 'standard', context_id: '', task: { task_id: 't-1', window: W } },
    { recording_id: 'r2', mode: 'standard', context_id: '', task: null }, { recording_id: 'r1', mode: 'practice', context_id: 'set' }];
  assert.deepEqual(itemWindow(items, { recordingId: 'r1' }), W);
  assert.equal(itemWindow(items, { recordingId: 'r2' }), null);
  assert.equal(itemWindow(items, { recordingId: 'r1', mode: 'practice', contextId: 'set' }), null);
  assert.equal(itemWindow(undefined, { recordingId: 'r1' }), null);
});

test('the view stays inside the part, with a second of context on each side', () => {
  const b = boundsOf(W, SF, N);
  assert.deepEqual(viewSpan(b, 60), [20 - CONTEXT_S, 40 + CONTEXT_S]);
  assert.deepEqual(viewSpan(null, 60), [0, 60]);
  const v = (startS, durationS) => clampView({ startS, durationS, firstChannel: 3 }, b, 60);
  assert.deepEqual(v(0, 10), { startS: 19, durationS: 10, firstChannel: 3 }, 'moved forward to the part');
  assert.deepEqual(v(55, 10), { startS: 31, durationS: 10, firstChannel: 3 }, 'moved back to the part');
  assert.deepEqual(v(25, 10), { startS: 25, durationS: 10, firstChannel: 3 }, 'inside: as it was');
  assert.deepEqual(v(0, 60), { startS: 19, durationS: 22, firstChannel: 3 }, 'Show all shows the part with its context');
  // a part at the very start of the recording has no context before it
  const first = boundsOf({ start_sample: 0, end_sample: 2560 }, SF, N);
  assert.deepEqual(clampView({ startS: 30, durationS: 60 }, first, 60), { startS: 0, durationS: 21 });
  assert.deepEqual(outsideStretches(b, 60), [[0, 20], [40, 60]]);
  assert.deepEqual(outsideStretches(first, 60), [[20, 60]]);
  assert.deepEqual(outsideStretches(null, 60), []);
  assert.equal(clampView({ startS: 3, durationS: 10 }, null, 60).startS, 3);
});

test('the annotation store refuses marks outside the part and stops a drag at its edge', () => {
  const s = new AnnotationStore({ chNames: ['Fp1', 'O1'], nSamples: N, sfreq: SF, labels: CATALOGUE.labels.map((l) => l.label) });
  const before = s.add('EMG-artifact', 100, 50); // made before the window was set: kept as it is
  const b = boundsOf(W, SF, N);
  s.setWindow(b);
  assert.ok(insideBounds(2560, 2560, b) && !insideBounds(2559, 10, b) && !insideBounds(5000, 121, b) && insideBounds(1, 1, null));
  assert.throws(() => s.add('EMG-artifact', 1000, 100), (e) => e instanceof AnnotationError && e.message === outsideText(b));
  assert.match(outsideText(b), /^it lies outside your part of the recording, 0:20 to 0:40\. Only that part is annotated in this task\.$/);
  assert.throws(() => s.addInterval('EMG-artifact', 5, 10), /outside your part/, 'a drag wholly before the part');
  assert.throws(() => s.addInterval('EMG-artifact', 41, 50), /outside your part/, 'a drag wholly after the part');
  const across = s.addInterval('EMG-artifact', 38, 45);
  assert.deepEqual([across.onset_sample, across.onset_sample + across.duration_samples], [Math.round(38 * SF), 5120], 'stopped at the end of the part');
  const start = s.addInterval('Eye-blink-artifact', 15, 21);
  assert.equal(start.onset_sample, 2560, 'stopped at the start of the part');
  s.setSamples(start.annotation_id, 2000, 2700);
  assert.equal(s.get(start.annotation_id).onset_sample, 2560, 'an edge dragged past the start stops there');
  assert.throws(() => s.setInterval(start.annotation_id, 10, 15), /outside your part/, 'moved wholly out of the part');
  assert.throws(() => s.update(start.annotation_id, { onset_sample: 2000 }), /outside your part/, 'an edit that leaves the part');
  assert.ok(s.has(before.annotation_id), 'marks already there are kept');
  s.setWindow(null);
  assert.equal(s.add('EMG-artifact', 1000, 100).onset_sample, 1000, 'without a window, anywhere in the recording');
});

test('the request of a share-out, with its checks in plain words', () => {
  const base = { pool: ['A01', 'A02', 'A03'], all: true, k: '2', part: 'whole', gold: '', adopt: false };
  assert.deepEqual(requestBody(base), { annotator_ids: ['A01', 'A02', 'A03'], all: true, k: 2 });
  assert.deepEqual(requestBody({ ...base, all: false, recordingIds: ['r1'], part: 'one', startS: '20', endS: '40', batch: ' Pilot ' }),
    { annotator_ids: ['A01', 'A02', 'A03'], recording_ids: ['r1'], k: 2, window: { start_s: 20, end_s: 40 }, batch: 'Pilot' });
  assert.deepEqual(requestBody({ ...base, part: 'many', lengthS: '30', overlapS: '' }).windows, { length_s: 30, overlap_s: 0 });
  assert.deepEqual(requestBody({ ...base, gold: 'known', k: '9' }), { annotator_ids: ['A01', 'A02', 'A03'], all: true, gold: { set_id: 'known' } },
    'known answers go to everyone chosen: k does not apply');
  assert.deepEqual(requestBody({ ...base, adopt: true, part: 'many' }), { annotator_ids: ['A01', 'A02', 'A03'], all: true, adopt: true },
    'adopted assignments are whole recordings, to the people who have them');
  assert.throws(() => requestBody({ ...base, pool: [] }), /Choose the annotators/);
  assert.throws(() => requestBody({ ...base, all: false, recordingIds: [] }), /at least one recording/);
  assert.throws(() => requestBody({ ...base, k: '4' }), /choose at least 4 annotators/);
  assert.throws(() => requestBody({ ...base, k: '7' }), /2 to 6/);
  assert.throws(() => requestBody({ ...base, part: 'one', startS: '20', endS: '21' }), /at least 2 seconds/);
  assert.throws(() => requestBody({ ...base, part: 'one', startS: '', endS: '21' }), /start and the end/);
  assert.throws(() => requestBody({ ...base, part: 'many', lengthS: '30', overlapS: '15' }), /less than half/);
});

test('the preview of 200 recordings among 10 people says what each gets', () => {
  const pool = Array.from({ length: 10 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`);
  const tasks = Array.from({ length: 200 }, (_, i) => ({ recording_id: `r${i}`, window: null, annotators: [pool[i % 10], pool[(i + 3) % 10]], gold: null }));
  const p = { created: 200, assigned: 398, k: 2, tasks, skipped: [{ recording_id: 'x', reason: 'retired' }, { recording_id: 'y', reason: 'has_task' }],
    per_annotator: pool.map((a, i) => ({ annotator_id: a, open_before: i === 0 ? 3 : 0, new: 40, linked: i < 2 ? 1 : 0 })) };
  const s = previewSummary(p);
  assert.equal(s.balanced, true);
  assert.equal(s.people[0].total, 43);
  assert.deepEqual(s.skipped, { retired: 1, has_task: 1 });
  assert.equal(s.sentence, '200 tasks, each to 2 people: 398 new assignments; 2 assignments that people already hold become part of their tasks. ' +
    'Everyone gets 40. 2 recordings or parts left out (below).');
  const uneven = previewSummary({ ...p, skipped: [], per_annotator: [{ annotator_id: 'A01', new: 2 }, { annotator_id: 'A02', new: 3 }],
    tasks: [{ recording_id: 'r', window: { start_s: 0, end_s: 20 } }, { recording_id: 'r', window: { start_s: 20, end_s: 40 } }], created: 2, assigned: 5 });
  assert.equal(uneven.sentence, '2 tasks (1 recording in 2 parts), each to 2 people: 5 new assignments. Each person gets 2 to 3.');
  assert.equal(previewSummary({ created: 0, per_annotator: [], tasks: [], skipped: [] }).sentence, 'Nothing would be made.');
  for (const reason of ['retired', 'has_task', 'too_few_annotators', 'window_outside', 'window_too_short', 'no_gold_reference', 'gold_mismatch', 'fewer_than_two', 'too_many_annotators']) {
    assert.ok(SKIPPED[reason] && /^[A-Z].*\.$/.test(SKIPPED[reason]), `the reason ${reason} is said in a sentence`);
  }
  assert.equal(skippedPart({ start_s: 40 }), 'From 0:40');
  assert.equal(skippedPart({}), 'Whole recording');
});

test('the list of tasks: statuses, filters, the people a task can change', () => {
  assert.equal(statusText('ready'), 'Conflicts to resolve');
  assert.equal(statusKind('ready'), 'warning');
  assert.equal(statusText('mystery'), 'mystery');
  assert.equal(partText(null), 'Whole recording');
  assert.equal(partText(W), '0:20 to 0:40');
  const tasks = [
    { task_id: 't1', recording_id: 'sub-1/a.edf', file_name: 'a.edf', status: 'collecting', annotators: ['A01', 'A02'], batch: 'Pilot',
      people: [{ annotator_id: 'A01', status: 'done' }, { annotator_id: 'A02', status: 'todo' }], counts: { saved: 1, annotators: 2 } },
    { task_id: 't2', recording_id: 'sub-2/b.edf', file_name: 'b.edf', status: 'ready', annotators: ['A02', 'A03'], batch: '' },
  ];
  assert.deepEqual(filterTasks(tasks, { status: 'ready' }).map((t) => t.task_id), ['t2']);
  assert.deepEqual(filterTasks(tasks, { person: 'A01' }).map((t) => t.task_id), ['t1']);
  assert.deepEqual(filterTasks(tasks, { q: 'pilot' }).map((t) => t.task_id), ['t1']);
  assert.deepEqual(filterTasks(tasks, { q: 'B.EDF' }).map((t) => t.task_id), ['t2']);
  assert.equal(savedText(tasks[0]), '1 of 2 saved');
  const users = [{ annotator_id: 'A01', status: 'active' }, { annotator_id: 'A03', status: 'active' }, { annotator_id: 'A04', status: 'disabled' }];
  assert.deepEqual(changeChoices(tasks[0], users), { out: ['A02'], in: ['A03'] }, 'nobody who saved is taken out; switched-off accounts are not put in');
});
