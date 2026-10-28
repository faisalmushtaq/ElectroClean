// The annotator's own progress on the home page (js/views/progress.js): done of assigned, the time
// worked, today, the recording to continue and the time left at their own pace.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isToday, median, progressSummary, roundEstimate, spanText } from '../../electroclean/web/static/js/views/progress.js';

// --------------------------------------------------------------- the progress

const NOW = new Date(2026, 9, 28, 15, 0);
const item = (o) => ({ recording_id: o.id, file_name: `${o.id}.edf`, mode: 'standard', context_id: '', status: 'todo', duration_s: 600, n_channels: 32, ...o });

test('median, spans of time and honest estimates', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(spanText(59), 'under a minute');
  assert.equal(spanText(41 * 60), '41 min');
  assert.equal(spanText(130 * 60), '2 h 10 min');
  assert.equal(spanText(120 * 60), '2 h');
  assert.equal(roundEstimate(10), 300);
  assert.equal(roundEstimate(46 * 60), 45 * 60);
  assert.equal(roundEstimate(3 * 3600 + 500), 3 * 3600 + 900);
  assert.equal(isToday('2026-10-28T09:00:00+00:00', NOW), true);
  assert.equal(isToday('2026-10-20T09:00:00+00:00', NOW), false);
  assert.equal(isToday('', NOW), false);
  assert.equal(isToday('nonsense', NOW), false);
});

test('the progress card: done of assigned, the time worked, today, continue and the time left', () => {
  const items = [
    item({ id: 'r1', status: 'done', elapsed_s: 1200, n_annotations: 30, completed_at: '2026-10-28T10:00:00+00:00' }),
    item({ id: 'r2', status: 'done', elapsed_s: 2400, n_annotations: 12, completed_at: '2026-10-27T10:00:00+00:00', duration_s: 1200 }),
    item({ id: 'r3', status: 'in_progress', draft: { elapsed_s: 300, n_annotations: 4, viewed_s: 150, saved_at: '2026-10-28T11:00:00+00:00' } }),
    item({ id: 'r4' }),
    item({ id: 'p1', repeat: true }),
  ];
  const p = progressSummary(items, { now: NOW, todayS: 900 });
  assert.equal(p.total, 4, 'practice that may be repeated counts only once done');
  assert.equal(p.done, 2);
  assert.equal(p.left, 2);
  assert.equal(p.workedS, 1200 + 2400 + 300);
  assert.equal(p.medianS, 1800);
  assert.equal(p.doneToday, 1);
  assert.equal(p.todayS, 900);
  // The pace: 3600 s of work for 1800 s of recording; 2 s per second for the two left, less the 300 s spent.
  assert.equal(p.basedOn, 2);
  assert.equal(p.remainingS, 600 * 2 - 300 + 600 * 2);
  assert.equal(p.continue.item.recording_id, 'r3');
  assert.deepEqual({ ...p.continue, item: undefined },
    { item: undefined, elapsedS: 300, nAnnotations: 4, viewedFraction: 0.25, savedAt: '2026-10-28T11:00:00+00:00' });
});

test('the progress card: this browser\'s newer draft wins, and no estimate before two recordings', () => {
  const items = [
    item({ id: 'r1', status: 'done', elapsed_s: 1200 }),
    item({ id: 'r2', status: 'in_progress', draft: { elapsed_s: 100, n_annotations: 1, viewed_s: 60, saved_at: '2026-10-28T11:00:00+00:00' } }),
  ];
  const mine = { elapsed_s: 160, annotations: [{}, {}, {}], viewed: [[0, 120], [300, 360]], saved_at: '2026-10-28T11:05:00+00:00' };
  const p = progressSummary(items, { now: NOW, drafts: (i) => (i.recording_id === 'r2' ? mine : null) });
  assert.equal(p.remainingS, null);
  assert.equal(p.continue.elapsedS, 160);
  assert.equal(p.continue.nAnnotations, 3);
  assert.equal(p.continue.viewedFraction, 0.3);
  assert.equal(p.workedS, 1360);
  const none = progressSummary([item({ id: 'a' })], { now: NOW });
  assert.equal(none.continue, null);
  assert.equal(none.medianS, null);
  assert.equal(none.workedS, 0);
});
