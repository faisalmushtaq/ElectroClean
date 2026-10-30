// The adjudication queue, pass and library without the page (js/expert/model.js): the keys of every
// choice, the progress, the order of the conflicts, the body of a decision, the reason rule, the lanes,
// the library's export, and the sections and purposes that bring them into the application.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const m = await import('../../electrotag/web/static/js/expert/model.js');
const { EXPERT_SECTIONS, EXPERT_ROUTE } = await import('../../electrotag/web/static/js/expert/sections.js');
const { EXPERT_LINKS, SECTIONS } = await import('../../electrotag/web/static/js/admin/model.js');
const { DemoExpert } = await import('../../electrotag/web/static/js/api/demo_expert.js');
const { ADJUDICATION_OP_NAMES } = await import('../../electrotag/web/static/js/api/demo_adjudication.js');

const conflict = (id, decided = null, extra = {}) => ({ conflict_id: id, kinds: ['type'], onset_s: 2, offset_s: 2.4, onset_sample: 500, offset_sample: 600,
  marks: [{ letter: 'A', annotator_id: 'A01', annotation_id: 'a1', label: 'Eye-blink-artifact', channels: [] },
    { letter: 'B', annotator_id: 'A02', annotation_id: 'b1', label: 'Eye-movement-artifact', channels: [] }],
  missing: [], decision: decided, ...extra });

test('every choice has its key: the digits and the letters keep a version, K both, X neither, E edit', () => {
  const two = ['A', 'B'];
  assert.deepEqual(m.keyAction('1', two), { action: 'choose', choice: 'A' });
  assert.deepEqual(m.keyAction('a', two), { action: 'choose', choice: 'A' });
  assert.deepEqual(m.keyAction('B', two), { action: 'choose', choice: 'B' });
  assert.deepEqual(m.keyAction('2', two), { action: 'choose', choice: 'B' });
  assert.equal(m.keyAction('3', two), null); // no third version
  assert.equal(m.keyAction('c', two), null);
  assert.deepEqual(m.keyAction('k', two), { action: 'choose', choice: 'all' });
  assert.deepEqual(m.keyAction('X', two), { action: 'choose', choice: 'none' });
  assert.deepEqual(m.keyAction('e', two), { action: 'choose', choice: 'edited' });
  assert.deepEqual(m.keyAction('Enter', two), { action: 'save' });
  assert.deepEqual(m.keyAction('r', two), { action: 'reason' });
  assert.deepEqual(m.keyAction('s', two), { action: 'skip' });
  assert.deepEqual(m.keyAction('n', two), { action: 'step', delta: 1 });
  assert.deepEqual(m.keyAction('P', two), { action: 'step', delta: -1 });
  assert.deepEqual(m.keyAction('t', two), { action: 'lanes', delta: 1 });
  assert.deepEqual(m.keyAction('T', two, { shift: true }), { action: 'lanes', delta: -1 });
  assert.deepEqual(m.keyAction('f', two), { action: 'finish' });
  assert.equal(m.keyAction('a', two, { ctrl: true }), null);
  // the workspace's own keys stay its own: view, overlay, isolate, go to time, help
  for (const k of ['v', 'o', 'i', 'g', '?', 'ArrowLeft', 'Home', 'Escape']) assert.equal(m.keyAction(k, two), null, k);
  // six versions: digits for all; the letter E edits, so letters are keys for A to D only
  const six = ['A', 'B', 'C', 'D', 'E', 'F'];
  assert.deepEqual(m.keyAction('5', six), { action: 'choose', choice: 'E' });
  assert.deepEqual(m.keyAction('e', six), { action: 'choose', choice: 'edited' });
  assert.deepEqual(m.keyAction('d', six), { action: 'choose', choice: 'D' });
  const labels = m.choicesFor(two).map((c) => c.label);
  assert.deepEqual(labels, ['Keep A', 'Keep B', 'Keep both', 'Neither', 'Edit a mark']);
  assert.equal(m.choicesFor(['A', 'B', 'C'])[3].label, 'Keep all');
  // every key is given once
  const keys = m.choicesFor(six).flatMap((c) => c.keys);
  assert.equal(new Set(keys).size, keys.length);
});

test('the progress, the next undecided conflict and the lanes', () => {
  const list = [conflict('c1', { choice: 'A' }), conflict('c2'), conflict('c3', { choice: 'none' }), conflict('c4')];
  assert.equal(m.progressText(list, 1), 'Conflict 2 of 4, 2 decided');
  assert.equal(m.progressText(list, -1), '4 conflicts, 2 decided');
  assert.equal(m.progressText([], -1), 'No conflicts');
  assert.equal(m.decidedShare(list), 0.5);
  assert.equal(m.nextUndecided(list, 1), 3);
  assert.equal(m.nextUndecided(list, 3), 1); // round to the start
  assert.equal(m.nextUndecided(list, -1), 1);
  assert.equal(m.nextUndecided(list.map((c) => ({ ...c, decision: { choice: 'A' } })), 0), -1);
  assert.deepEqual(m.laneModes(['A', 'B']), [null, 'A', 'B']);
  assert.equal(m.nextLaneMode(['A', 'B'], null), 'A');
  assert.equal(m.nextLaneMode(['A', 'B'], 'B'), null);
  assert.equal(m.nextLaneMode(['A', 'B'], null, -1), 'B');
  const versions = [{ letter: 'A', annotations: [{ annotation_id: 'a1', label: 'Eye-blink-artifact', onset_sample: 500, duration_samples: 100, channels: [] },
    { annotation_id: 'a2', label: 'EMG-artifact', onset_sample: 9000, duration_samples: 100, channels: [] }] },
  { letter: 'B', annotations: [{ annotation_id: 'b1', label: 'Eye-movement-artifact', onset_sample: 500, duration_samples: 100, channels: ['Fp1'] }] }];
  const lanes = m.laneMarks(versions, list, 0, 0, 10, 250);
  assert.deepEqual(lanes.map((x) => [x.letter, x.row, x.current, x.t0]), [['A', 0, true, 2], ['B', 1, true, 2]]);
  const over = m.overlayAnnotations(versions);
  assert.deepEqual(over.map((a) => a.annotation_id), ['A-a1', 'A-a2', 'B-b1']);
  assert.equal(m.overlayAnnotations(versions, 'B').length, 1);
  assert.equal(m.conflictOfMark(list, 'B-b1'), 0);
  assert.equal(m.conflictOfMark(list, 'A-a2'), -1);
  assert.equal(m.letterOf('A-x-y'), 'A');
});

test('a decision needs what the study asks for, and its body is what adjudication_decide takes', () => {
  assert.equal(m.decisionProblem({ choice: null }), 'Choose what to keep first.');
  assert.match(m.decisionProblem({ choice: 'A', rule: 'always' }), /Give a reason/);
  assert.equal(m.decisionProblem({ choice: 'A', rule: 'always', reasonCode: 'clear_artifact' }), '');
  assert.equal(m.decisionProblem({ choice: 'A', rule: 'always', reason: 'clear blink' }), '');
  assert.match(m.decisionProblem({ choice: 'A', rule: 'always', reasonCode: 'other' }), /write it/);
  assert.equal(m.decisionProblem({ choice: 'A', rule: 'edited_or_none' }), '');
  assert.match(m.decisionProblem({ choice: 'none', rule: 'edited_or_none' }), /reason/);
  assert.equal(m.decisionProblem({ choice: 'none', rule: 'never' }), '');
  assert.match(m.decisionProblem({ choice: 'edited', rule: 'never', marks: [] }), /Set the mark/);
  assert.match(m.decisionProblem({ choice: 'A', reason: 'x'.repeat(201) }), /200/);
  assert.equal(m.reasonNeeded('edited_or_none', 'edited'), true);
  assert.equal(m.reasonNeeded('never', 'none'), false);
  const body = m.decisionBody({ unitId: 'r-1', conflictId: 'c-1', choice: 'edited', reasonCode: 'boundary_evidence', reason: '  starts earlier  ',
    marks: [{ label: 'Eye-blink-artifact', onset_sample: 490, duration_samples: 130, channels: ['Fp1'], extra: 1 }] });
  assert.deepEqual(body, { unit_id: 'r-1', conflict_id: 'c-1', choice: 'edited', reason: 'starts earlier', reason_code: 'boundary_evidence',
    marks: [{ annotation_id: 'e1', label: 'Eye-blink-artifact', onset_sample: 490, duration_samples: 130, channels: ['Fp1'] }] });
  assert.deepEqual(m.decisionBody({ unitId: 'r-1', conflictId: 'c-1', choice: 'A' }), { unit_id: 'r-1', conflict_id: 'c-1', choice: 'A', reason: '' });
  assert.equal(m.decisionText({ choice: 'A' }, { A: 'A01' }), 'Kept A (A01)');
  assert.equal(m.decisionText({ choice: 'all' }), 'Kept all');
  assert.equal(m.decisionText(null), 'Not decided');
  assert.equal(m.conflictSentence(conflict('c1')), 'Different types. A: Eye-blink-artifact; B: Eye-movement-artifact.');
  assert.equal(m.spanText(12.3, 12.714), '12.30–12.71 s');
});

test('the queue: its tabs, its actions and its summary', () => {
  const units = [
    { unit_id: 'r-1', status: 'ready', annotators: [{ letter: 'A', annotator_id: 'A01' }, { letter: 'B', annotator_id: 'A02' }] },
    { unit_id: 'r-2', status: 'adjudicating', yours: true, annotators: [] },
    { unit_id: 'r-3', status: 'adjudicating', yours: false, annotators: [] },
    { unit_id: 'r-4', status: 'adjudicated', annotators: [] },
    { unit_id: 'r-5', status: 'collecting', annotators: [] },
    { unit_id: 'r-6', status: 'ready', own: true, annotators: [] },
  ];
  assert.deepEqual(m.tabCounts(units), { ready: 2, progress: 2, finished: 1, waiting: 1, all: 6 });
  assert.deepEqual(m.tabRows(units, 'progress').map((u) => u.unit_id), ['r-2', 'r-3']);
  assert.deepEqual(units.map((u) => (m.queueAction(u) || {}).label || null), ['Start', 'Continue', null, 'Open', null, null]);
  assert.equal(m.queueSummary(units), '2 recordings ready · 2 in progress (1 yours) · 1 finished · 1 waiting or agreed');
  assert.equal(m.peopleText(units[0]), 'A01 and A02');
  assert.equal(m.peopleText({ annotators: [{ letter: 'A', annotator_id: 'E01' }, { letter: 'B', annotator_id: 'E02' }], corrected: { annotator_id: 'A01' } }),
    'E01 and E02, correcting A01');
  assert.equal(m.windowText(null), 'Whole recording');
  assert.equal(m.windowText({ start_s: 30, end_s: 90 }), '0:30–1:30');
});

test('the library downloads as a TSV with the study\'s columns, and promotions start from the decision', () => {
  const entries = [
    { entry_id: 'r-1:c-1', unit_id: 'r-1', recording_id: 'sub-001/eeg/x.vhdr', status: 'decided', kinds: ['type'], labels: ['Eye-blink-artifact', 'Eye-movement-artifact'],
      pair: ['Eye-blink-artifact', 'Eye-movement-artifact'], onset_s: 2, offset_s: 2.4, marks: conflict('c-1').marks, missing_ids: [], adjudicator_id: 'E01',
      decision: { choice: 'B', reason_code: null, reason: 'eyes\tmove sideways', decided_at: '2026-10-30T10:00:00+00:00',
        result: [{ label: 'Eye-movement-artifact', onset_s: 2, offset_s: 2.4 }] } },
    { entry_id: 'r-1:c-2', unit_id: 'r-1', recording_id: 'sub-001/eeg/x.vhdr', status: 'awaiting', kinds: ['presence'], labels: ['Eye-blink-artifact'], pair: null,
      onset_s: 20, offset_s: 20.4, marks: [{ letter: 'A', annotator_id: 'A01' }], missing_ids: ['A02'], decision: null },
  ];
  const tsv = m.libraryTsv(entries).trimEnd().split('\n');
  assert.equal(tsv[0], m.LIBRARY_COLUMNS.join('\t'));
  assert.equal(tsv.length, 3);
  const row = Object.fromEntries(m.LIBRARY_COLUMNS.map((c, i) => [c, tsv[1].split('\t')[i]]));
  assert.equal(row.pair, 'Eye-blink-artifact | Eye-movement-artifact');
  assert.equal(row.people, 'A01,A02');
  assert.equal(row.decision, 'B');
  assert.equal(row.reason, 'eyes move sideways'); // no tab inside a cell
  const second = Object.fromEntries(m.LIBRARY_COLUMNS.map((c, i) => [c, tsv[2].split('\t')[i]]));
  assert.equal(second.decision, 'n/a');
  assert.equal(second.missing, 'A02');
  const json = JSON.parse(m.libraryJson(entries, { status: 'decided' }));
  assert.equal(json.schema, 'electrotag.library');
  assert.equal(json.entries.length, 2);
  assert.deepEqual(m.libraryQuery({ label: '', kind: 'type', q: '  blink ', pair: 'Eye-blink-artifact | Eye-movement-artifact' }),
    { kind: 'type', q: 'blink', pair: ['Eye-blink-artifact', 'Eye-movement-artifact'] });
  assert.deepEqual(m.filterKeys({ q: 'secret words', kind: 'type' }), ['kind', 'q']); // the log never has what was typed
  assert.deepEqual(m.promoteDefaults(entries[0]), { label: 'Eye-movement-artifact', start_s: 2, end_s: 2.4, decided: true,
    explanation: 'Annotators disagreed here. The adjudicator\'s reason: eyes\tmove sideways.' });
  assert.equal(m.promoteDefaults(entries[1]).decided, false);
  assert.equal(m.promoteDefaults(entries[1]).label, 'Eye-blink-artifact');
});

test('the expert area has the queue and the library, the admin menu links to the queue, and the sandbox says it needs a server', async () => {
  const queue = EXPERT_SECTIONS.find((s) => s.key === 'queue');
  const library = EXPERT_SECTIONS.find((s) => s.key === 'library');
  assert.equal(queue.route, 'expert-queue');
  assert.equal(library.route, 'expert-library');
  for (const s of [queue, library]) assert.ok(EXPERT_ROUTE.test(s.route) && typeof s.load === 'function');
  assert.deepEqual(EXPERT_LINKS.map((l) => [l.group, l.route, l.title]), [['study', 'expert-queue', 'Adjudication']]);
  assert.ok(!SECTIONS.some((s) => s.route === 'expert-queue')); // a link out, not an admin section
  const users = [{ annotator_id: 'E01', status: 'active', roles: ['annotator', 'expert'], role: 'expert' }];
  const backend = { _aid: () => 'E01', _admin: { user: (aid) => users.find((u) => u.annotator_id === aid), s: { settings: {} } }, state: {} };
  const x = new DemoExpert(backend);
  for (const op of ADJUDICATION_OP_NAMES) {
    await assert.rejects(() => x.run(op, {}), (e) => e.status === 501 && e.code === 'needs_server' && /study server or Firebase/.test(e.message), op);
  }
  backend._aid = () => 'A01';
  users.push({ annotator_id: 'A01', status: 'active', roles: ['annotator'], role: 'annotator' });
  await assert.rejects(() => x.run('adjudication_list', {}), (e) => e.status === 403 && e.code === 'forbidden');
});

test('an annotator reads the outcome of their conflicts in plain words, nobody named', async () => {
  const o = await import('../../electrotag/web/static/js/expert/outcomes.js');
  const item = { task_id: 'r-1', file_name: 'x.vhdr', conflicts: [
    { kinds: ['type'], onset_s: 2, offset_s: 2.4, yours: [{ label: 'Eye-blink-artifact', onset_s: 2, offset_s: 2.4 }], others: [{ label: 'Eye-movement-artifact', onset_s: 2, offset_s: 2.4 }],
      decision: { outcome: 'other_kept', marks: [{ label: 'Eye-movement-artifact', onset_s: 2, offset_s: 2.4 }], reason: 'sideways', reason_code: null } },
    { kinds: ['presence'], onset_s: 20, offset_s: 20.4, yours: [{ label: 'Eye-blink-artifact', onset_s: 20, offset_s: 20.4 }], others: [],
      decision: { outcome: 'yours_kept', marks: [{ label: 'Eye-blink-artifact', onset_s: 20, offset_s: 20.4 }], reason: '', reason_code: 'clear_artifact' } },
    { kinds: ['presence'], onset_s: 32, offset_s: 32.3, yours: [], others: [{ label: 'Eye-blink-artifact', onset_s: 32, offset_s: 32.3 }],
      decision: { outcome: 'none_kept', marks: [], reason: '', reason_code: 'not_artifact' } },
  ] };
  assert.equal(o.outcomeSummary(item), '3 conflicts decided: 1 yours kept, 1 another version kept, 1 neither kept.');
  assert.deepEqual(o.conflictLines(item.conflicts[2]), { yours: 'You: no mark here', others: 'Others: Eye-blink-artifact 32.00–32.30 s', kept: 'Kept: no mark' });
  assert.equal(o.conflictLines(item.conflicts[0]).kept, 'Kept: Eye-movement-artifact 2.00–2.40 s');
  assert.equal(o.OUTCOME_TEXT.all_kept, 'Both were kept');
  assert.equal(o.outcomesCard([]), null);
});

test('the outcome is said from the annotator\'s side: whether what they marked, or left unmarked, stood', async () => {
  const { outcomeWords } = await import('../../electrotag/web/static/js/expert/outcomes.js');
  const mark = [{ label: 'Eye-blink-artifact', onset_s: 1, offset_s: 2 }];
  const w = (outcome, yours) => outcomeWords({ yours, decision: { outcome } });
  assert.deepEqual(w('yours_kept', mark), { text: 'Your mark was kept', yours: true });
  assert.deepEqual(w('yours_kept', []), { text: 'No mark, as you had it', yours: true });
  assert.deepEqual(w('other_kept', []), { text: 'A colleague\'s mark was kept where you had none', yours: false });
  assert.deepEqual(w('all_kept', mark), { text: 'Both marks were kept', yours: true });
  assert.deepEqual(w('all_kept', []), { text: 'A colleague\'s mark was kept where you had none', yours: false });
  assert.deepEqual(w('none_kept', mark), { text: 'Your mark was not kept', yours: false });
  assert.deepEqual(w('none_kept', []), { text: 'No mark, as you had it', yours: true });
  assert.equal(w('edited', mark).text, 'Replaced by the adjudicator\'s own mark');
});
