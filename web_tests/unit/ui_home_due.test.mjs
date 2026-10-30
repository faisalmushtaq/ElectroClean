// The annotator's home with hand-outs (js/views/home_list.js, js/views/home_due.js): rows grouped under each
// hand-out's title, earliest due first, then "Other recordings"; the words of the Due card; and, through the
// sandbox (js/api/demo_library.js), that GET /assignments carries only a hand-out's title and due date, never
// the name, description or notes of the dataset or collection behind it, nor the study team's note.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DemoBackend } from '../../electrotag/web/static/js/api/demo.js';
import { groupOf, grouped, groupOrder, OTHER_GROUP, visibleItems } from '../../electrotag/web/static/js/views/home_list.js';
import { dayText, dueText } from '../../electrotag/web/static/js/views/home_due.js';
import { loadedParts } from '../../electrotag/web/static/js/lazy.js';

const memory = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)), remove: (k) => m.delete(k) };
};
const hex = (n) => n.toString(16).padStart(32, '0');
const ho = (title, due_at = null, overdue = false) => ({ handout_id: `h-${title.length.toString(16).padStart(10, '0')}`, title, due_at, overdue });
const item = (id, status, handout = null, extra = {}) => ({ recording_id: id, file_name: `${id}.edf`, status, mode: 'standard', duration_s: 60, handout, ...extra });

test('rows are grouped under the hand-outs\' titles, earliest due first, then those without a date, then the rest', () => {
  const later = ho('Recordings due 20 November', '2026-11-20');
  const sooner = ho('Youth recordings', '2026-11-02', true);
  const undated = ho('Recordings to annotate');
  const items = [item('a', 'todo'), item('b', 'todo', later), item('c', 'in_progress', undated), item('d', 'todo', sooner), item('e', 'done', sooner), item('f', 'todo', later)];
  assert.deepEqual(groupOrder(items), ['Youth recordings', 'Recordings due 20 November', 'Recordings to annotate', '']);
  assert.equal(grouped(items, 'todo'), true);
  assert.equal(grouped(items, 'all'), true);
  assert.equal(grouped(items, 'done'), false, 'only To do and All are grouped');
  assert.equal(grouped([item('a', 'todo')], 'todo'), false, 'nothing handed out: no groups');
  const todo = visibleItems(items, { tab: 'todo', group: true });
  assert.deepEqual(todo.map((i) => i.recording_id), ['d', 'b', 'f', 'c', 'a']);
  assert.deepEqual(todo.map(groupOf), ['Youth recordings', 'Recordings due 20 November', 'Recordings due 20 November', 'Recordings to annotate', '']);
  // inside a group the chosen sorting holds: by file name, the later hand-out's two rows keep their order
  assert.deepEqual(visibleItems(items, { tab: 'all', group: true, sort: 'name' }).map((i) => i.recording_id), ['d', 'e', 'b', 'f', 'c', 'a']);
  // without grouping, the order is the list's own (in progress first)
  assert.deepEqual(visibleItems(items, { tab: 'todo' }).map((i) => i.recording_id), ['c', 'a', 'b', 'd', 'f']);
  // Show these: one hand-out's rows only
  assert.deepEqual(visibleItems(items, { tab: 'all', handout: 'Youth recordings' }).map((i) => i.recording_id), ['d', 'e']);
  assert.equal(OTHER_GROUP, 'Other recordings');
});

test('two hand-outs with the same title make one group, dated by the earlier', () => {
  const a = { ...ho('Recordings to annotate', '2026-12-01'), handout_id: 'h-000000000a' };
  const b = { ...ho('Recordings to annotate', '2026-11-01'), handout_id: 'h-000000000b' };
  const items = [item('x', 'todo', ho('Pilot', '2026-11-15')), item('y', 'todo', a), item('z', 'todo', b)];
  assert.deepEqual(groupOrder(items), ['Recordings to annotate', 'Pilot', '']);
});

test('the Due card says how much is left and when it is due, in plain words', () => {
  assert.equal(dayText('2026-11-20', '2026-10-30'), 'Friday 20 November');
  assert.equal(dayText('2027-01-04', '2026-10-30'), 'Monday 4 January 2027', 'another year is named');
  assert.equal(dayText('not a day'), '');
  assert.equal(dueText({ title: 'Youth recordings', total: 40, remaining: 12, due_at: '2026-11-20', overdue: false }, '2026-10-30'),
    'Youth recordings: 12 of 40 left, due Friday 20 November');
  assert.equal(dueText({ title: 'Youth recordings', total: 40, remaining: 3, due_at: '2026-10-20', overdue: true }, '2026-10-30'),
    'Youth recordings: 3 of 40 left, was due Tuesday 20 October');
  assert.equal(dueText({ title: 'Pilot', total: 2, remaining: 0, due_at: '2026-11-20', overdue: false }, '2026-10-30'), 'Pilot: all 2 done, due Friday 20 November');
  assert.equal(dueText({ title: 'One', total: 1, remaining: 0, due_at: '2026-11-20' }, '2026-10-30'), 'One: done, due Friday 20 November');
});

test('in the sandbox an annotator sees a hand-out only by its title and due date (decision 1)', async () => {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login('A01', 'demo');
  const before = await b.assignments();
  assert.deepEqual(before.due, []);
  assert.ok(before.items.every((i) => i.handout === null));
  assert.ok(!loadedParts().includes('demoLibrary'), 'the library is not loaded while nothing is handed out');
  await b.logout();
  await b.login('ADMIN', 'demo');
  const rids = (await b.admin('recordings_list', { scope: 'study' })).recordings.map((r) => r.recording_id);
  await b.admin('dataset_create', { request_id: hex(1), dataset_id: 'youth', name: 'Youth low-density 2026', description: 'Hard to read', notes: 'Secret notes',
    citation: 'Someone et al.' });
  await b.admin('recordings_move', { recording_ids: [rids[1], rids[2]], dataset_id: 'youth' });
  const c = await b.admin('collection_create', { request_id: hex(2), name: 'Pilot: 20 hard recordings', description: 'The noisiest', recording_ids: [rids[0]] });
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  await b.admin('handout_create', { request_id: hex(3), target: { kind: 'dataset', id: 'youth' }, people: ['A01'], due_at: day(-3), title: 'Youth recordings', note: 'Team note' });
  await b.admin('handout_create', { request_id: hex(4), target: { kind: 'collection', id: c.collection.collection_id }, people: ['A01'], due_at: '2099-11-20', note: 'Another note' });
  assert.ok(loadedParts().includes('demoLibrary'), 'the library came with its first operation');
  await b.logout();
  await b.login('A01', 'demo');
  const got = await b.assignments();
  const me = await b.me();
  const text = JSON.stringify([got, me]);
  for (const secret of ['Youth low-density', 'Hard to read', 'Secret notes', 'Someone et al.', 'Pilot', 'hard recordings', 'noisiest', 'Team note', 'Another note', 'youth"']) {
    assert.ok(!text.includes(secret), `A01 is told "${secret}"`);
  }
  assert.deepEqual(got.due.map((d) => [d.title, d.total, d.remaining, d.overdue]), [['Youth recordings', 2, 2, true], ['Recordings due 20 November', 1, 1, false]]);
  assert.deepEqual(Object.keys(got.due[0]).sort(), ['due_at', 'handout_id', 'overdue', 'remaining', 'title', 'total']);
  const byId = Object.fromEntries(got.items.map((i) => [i.recording_id, i.handout]));
  assert.deepEqual(byId[rids[1]], { handout_id: got.due[0].handout_id, title: 'Youth recordings', due_at: day(-3), overdue: true });
  assert.deepEqual(byId[rids[0]].title, 'Recordings due 20 November');
  assert.deepEqual(Object.keys(byId[rids[0]]).sort(), ['due_at', 'handout_id', 'overdue', 'title']);
  // the home page groups them by title, the overdue hand-out first
  assert.deepEqual(groupOrder(got.items), ['Youth recordings', 'Recordings due 20 November', '']);
});
