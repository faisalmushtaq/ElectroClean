// The Hand-outs section's words and arithmetic (js/admin/handouts_model.js): the request a hand-out sends,
// the title annotators see by default, what its preview says (in k mode the Tasks section's own words,
// through tasks_model.js), its progress, due date and overdue people, the words before adding people to
// a group that hand-outs follow, and the kinds of notice that would be sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as m from '../../electrotag/web/static/js/admin/handouts_model.js';
import { previewSummary } from '../../electrotag/web/static/js/admin/tasks_model.js';

test('the title annotators see by default never names a collection', () => {
  assert.equal(m.defaultTitle('dataset', 'Youth low-density 2026', null), 'Youth low-density 2026');
  assert.equal(m.defaultTitle('dataset', 'Youth low-density 2026', '2026-11-20'), 'Youth low-density 2026');
  assert.equal(m.defaultTitle('collection', 'Pilot: 20 hard recordings', '2026-11-20'), 'Recordings due 20 November');
  assert.equal(m.defaultTitle('collection', 'Pilot: 20 hard recordings', ''), 'Recordings to annotate');
  assert.deepEqual(m.parseTarget(m.targetValue('collection', 'c-12:3')), { kind: 'collection', id: 'c-12:3' });
  assert.equal(m.parseTarget('set:x'), null);
  assert.equal(m.parseTarget(''), null);
});

test('the request of a hand-out, checked in plain words', () => {
  const base = { target: 'dataset:youth', people: ['A01', 'A01'], groups: [], mode: 'all', dueAt: '', title: '', name: '', note: '' };
  assert.throws(() => m.handoutBody({ ...base, target: '' }), /Choose the dataset or collection/);
  assert.throws(() => m.handoutBody({ ...base, people: [] }), /Choose the people or groups/);
  assert.throws(() => m.handoutBody({ ...base, mode: 'k', k: '7' }), /2 to 6 people/);
  assert.throws(() => m.handoutBody({ ...base, dueAt: '20/11/2026' }), /as a day/);
  assert.throws(() => m.handoutBody({ ...base, dueAt: '2026-10-29' }, { today: '2026-10-30' }), /has passed/);
  assert.throws(() => m.handoutBody({ ...base, title: 'x'.repeat(121) }), /title has at most 120/);
  assert.deepEqual(m.handoutBody(base), { target: { kind: 'dataset', id: 'youth' }, people: ['A01'], groups: [], mode: 'all', follow_groups: false, due_at: null });
  assert.deepEqual(m.handoutBody({ ...base, groups: ['g-1'], followGroups: true, dueAt: '2026-11-20', title: ' First pass ', note: 'n' }, { today: '2026-10-30' }),
    { target: { kind: 'dataset', id: 'youth' }, people: ['A01'], groups: ['g-1'], mode: 'all', follow_groups: true, due_at: '2026-11-20', title: 'First pass', note: 'n' });
  // following groups needs groups, and a k hand-out never follows them
  assert.equal(m.handoutBody({ ...base, followGroups: true }).follow_groups, false);
  const k = m.handoutBody({ ...base, mode: 'k', k: '3', groups: ['g-1'], followGroups: true });
  assert.equal(k.k, 3);
  assert.equal('follow_groups' in k, false);
});

const TASKS_PREVIEW = {
  k: 2, created: 3, assigned: 6, per_annotator: [{ annotator_id: 'A01', open_before: 0, new: 3, linked: 0 }, { annotator_id: 'A02', open_before: 1, new: 3, linked: 1 }],
  tasks: [{ recording_id: 'a' }, { recording_id: 'b' }, { recording_id: 'c' }], skipped: [{ recording_id: 'd', reason: 'has_task' }], warnings: ['w'],
  pairs: { n_pairs: 1, least: 3, most: 3, counts: { 3: 1 } },
};

test('the preview of a k hand-out says what the Tasks section\'s preview says', () => {
  const p = { recipients: [{ annotator_id: 'A01', via: 'person', new: 3, already: 0 }], recordings: 4, skipped: TASKS_PREVIEW.skipped,
    tasks_preview: TASKS_PREVIEW, warnings: ['w', '1 recording has an open task already, so the share-out leaves them out.'] };
  const s = m.handoutPreview(p, 'k');
  const t = previewSummary(TASKS_PREVIEW);
  assert.equal(s.sentence, t.sentence);
  assert.equal(s.pairs, t.pairs);
  assert.deepEqual(s.people, t.people);
  assert.equal(s.n, 3);
  assert.equal(m.handoutPreview({ recipients: [], recordings: 0, tasks_preview: null }, 'k').sentence, 'The target has no recordings in use to share out.');
});

test('the preview of an "all" hand-out counts what is new and what people hold already', () => {
  const p = { recipients: [{ annotator_id: 'A01', via: 'person', new: 10, already: 2 }, { annotator_id: 'A02', via: 'group:g-1', new: 12, already: 0 }],
    recordings: 12, skipped: [{ recording_id: 'r', reason: 'retired' }], tasks_preview: null, warnings: [] };
  const s = m.handoutPreview(p, 'all');
  assert.equal(s.sentence, '12 recordings to 2 people: 22 new assignments; 2 recordings that people hold already stay as they are, with this hand-out\'s due date. 1 recording left out (below).');
  assert.equal(s.n, 22);
  assert.equal(m.skippedReason(p.skipped[0]), 'The recording is retired.');
  assert.equal(m.skippedReason({ reason: 'not_registered' }), 'The recording is no longer registered.');
  assert.equal(m.recipientsText(p.recipients, [{ group_id: 'g-1', name: 'Leeds RAs' }]), '1 person chosen, 1 through Leeds RAs');
  assert.equal(m.handoutPreview({ recipients: [], recordings: 3 }, 'all').sentence, 'Nobody would be given anything.');
});

const HANDOUTS = [
  { handout_id: 'h-1', name: 'Youth: first pass', title: 'Youth low-density 2026', state: 'open', mode: 'all', groups: ['g-1'], follow_groups: true,
    due_at: '2026-10-20', target: { kind: 'dataset', id: 'youth', name: 'Youth low-density 2026' },
    counts: { people: 2, recordings: 40, given: 80, saved: 30, set_aside: 2, overdue_people: 1 } },
  { handout_id: 'h-2', name: 'Pilot', title: 'Recordings to annotate', state: 'open', mode: 'k', k: 2, groups: ['g-1'], follow_groups: false,
    due_at: null, target: { kind: 'collection', id: 'c-1', name: 'Pilot: 20 hard recordings' }, counts: { people: 3, recordings: 20, given: 40, saved: 0 } },
  { handout_id: 'h-3', name: 'Old', title: 'Old', state: 'withdrawn', mode: 'all', groups: ['g-1'], follow_groups: true, counts: {} },
];

test('a hand-out\'s progress, its way of sharing out, its due date and its overdue people', () => {
  assert.deepEqual(m.handoutProgress(HANDOUTS[0]), { text: '30 of 80 saved, 2 set aside', share: 0.4 });
  assert.deepEqual(m.handoutProgress(HANDOUTS[2]), { text: 'Nothing given', share: null });
  assert.equal(m.modeText(HANDOUTS[0]), 'Everyone gets all of it');
  assert.equal(m.modeText(HANDOUTS[1]), 'Each recording to 2 people');
  assert.deepEqual(m.dueState('2026-10-20', '2026-10-30'), { text: 'Tuesday 20 October 2026', late: true });
  assert.deepEqual(m.dueState('2026-10-30', '2026-10-30'), { text: 'Friday 30 October 2026', late: false }, 'overdue from the day after');
  assert.deepEqual(m.dueState(null, '2026-10-30'), { text: 'No due date', late: false });
  assert.equal(m.overdueText(HANDOUTS[0]), '1 person overdue');
  assert.equal(m.overdueText(HANDOUTS[1]), '');
  assert.deepEqual(m.filterHandouts(HANDOUTS, { state: 'open' }).map((o) => o.handout_id), ['h-1', 'h-2']);
  assert.deepEqual(m.filterHandouts(HANDOUTS, { overdue: true }).map((o) => o.handout_id), ['h-1']);
  assert.deepEqual(m.filterHandouts(HANDOUTS, { q: 'hard' }).map((o) => o.handout_id), ['h-2'], 'the target\'s name is searched too');
});

test('adding people to a group says what the hand-outs that follow it would give them', () => {
  assert.deepEqual(m.followText(HANDOUTS, 'g-1', []).text, '');
  assert.equal(m.followText(HANDOUTS, 'g-2', ['A12']).text, '');
  const f = m.followText(HANDOUTS, 'g-1', ['A12']);
  assert.equal(f.text, 'Adding A12 gives them 1 hand-out that follows this group (40 recordings).');
  assert.deepEqual(f.handouts.map((o) => o.handout_id), ['h-1'], 'neither a k hand-out nor a withdrawn one follows');
  assert.equal(m.followText([HANDOUTS[0], { ...HANDOUTS[0], handout_id: 'h-4' }], 'g-1', ['A12', 'A13']).text,
    'Adding 2 people gives each of them 2 hand-outs that follow this group (80 recordings).');
});

test('the kinds of notice that would be sent have names', () => {
  assert.equal(m.noticeKind({ kind: 'weekly' }), 'Weekly summary');
  assert.equal(m.noticeKind({ kind: 'dataset_complete' }), 'Fully rated');
  assert.equal(m.noticeKind({ kind: 'overdue' }), 'Overdue work');
  assert.equal(m.noticeKind({ kind: 'overdue-h-1-A03' }), 'Overdue work');
  assert.equal(m.noticeKind({ kind: 'something' }), 'something');
});

test('a person in the lists to give to: the name beside the ID, and under it only what is not the name', () => {
  const people = { A03: { full_name: 'Ann Smith' } };
  const e = m.personEntry({ annotator_id: 'A03', display_name: 'Annotator three', full_name: 'Ann Smith', roles: ['annotator', 'expert'], status: 'active' }, people);
  assert.equal(e.text, 'A03 · Ann Smith');
  assert.equal(e.extra, 'expert');
  const off = m.personEntry({ annotator_id: 'A04', display_name: 'Four', roles: ['annotator'], status: 'disabled' }, {});
  assert.equal(off.extra, 'switched off');
  assert.equal(off.notInAll, true);
});
