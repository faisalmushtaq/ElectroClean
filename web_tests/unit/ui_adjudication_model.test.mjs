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
  assert.deepEqual(labels, ['Keep A', 'Keep B', 'Keep both', 'Neither', 'Choose marks', 'Your own marks']);
  assert.deepEqual(m.choicesFor(['A', 'B', 'C']).slice(3, 5).map((c) => c.label), ['Keep all', 'None']);
  assert.deepEqual(m.keyAction('m', two), { action: 'choose', choice: 'pick' });
  // Shift and a digit chooses a reason (the digit read from the key's place, since Shift+1 types "!")
  assert.deepEqual(m.keyAction('!', two, { shift: true, code: 'Digit1' }), { action: 'reason_code', code: 'clear_artifact' });
  assert.deepEqual(m.keyAction('&', two, { shift: true, code: 'Digit7' }), { action: 'reason_code', code: 'other' });
  assert.deepEqual(m.keyAction('2', two, { shift: true, code: 'Numpad2' }), { action: 'reason_code', code: 'not_artifact' });
  assert.equal(m.keyAction('(', two, { shift: true, code: 'Digit9' }), null);
  assert.deepEqual(m.keyAction('1', two, { code: 'Digit1' }), { action: 'choose', choice: 'A' }); // without Shift, a version
  assert.deepEqual(Object.values(m.REASON_KEYS), ['1', '2', '3', '4', '5', '6', '7']);
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
  assert.match(m.decisionProblem({ choice: 'edited', rule: 'never', marks: Array(6).fill({}) }), /At most 5/);
  assert.match(m.decisionProblem({ choice: 'pick', rule: 'never', picks: [] }), /Tick the marks/);
  assert.equal(m.decisionProblem({ choice: 'pick', rule: 'never', picks: [{ letter: 'A', annotation_id: 'a1' }] }), '');
  assert.match(m.decisionProblem({ choice: 'A', reason: 'x'.repeat(201) }), /200/);
  assert.equal(m.reasonNeeded('edited_or_none', 'edited'), true);
  assert.equal(m.reasonNeeded('never', 'none'), false);
  const body = m.decisionBody({ unitId: 'r-1', conflictId: 'c-1', choice: 'edited', reasonCode: 'boundary_evidence', reason: '  starts earlier  ',
    marks: [{ label: 'Eye-blink-artifact', onset_sample: 490, duration_samples: 130, channels: ['Fp1'], extra: 1 }] });
  assert.deepEqual(body, { unit_id: 'r-1', conflict_id: 'c-1', choice: 'edited', reason: 'starts earlier', reason_code: 'boundary_evidence',
    marks: [{ annotation_id: 'e1', label: 'Eye-blink-artifact', onset_sample: 490, duration_samples: 130, channels: ['Fp1'] }] });
  assert.deepEqual(m.decisionBody({ unitId: 'r-1', conflictId: 'c-1', choice: 'A' }), { unit_id: 'r-1', conflict_id: 'c-1', choice: 'A', reason: '' });
  const two = m.decisionBody({ unitId: 'r-1', conflictId: 'c-1', choice: 'edited', reason: 'two blinks', marks: [
    { label: 'Eye-blink-artifact', onset_sample: 490, duration_samples: 50, channels: [] }, { label: 'Eye-blink-artifact', onset_sample: 560, duration_samples: 50, channels: [] }] });
  assert.deepEqual(two.marks.map((x) => x.annotation_id), ['e1', 'e2']);
  assert.deepEqual(m.decisionBody({ unitId: 'r-1', conflictId: 'c-1', choice: 'pick', reasonCode: 'both_valid', picks: [{ letter: 'A', annotation_id: 'a1', label: 'x' }, { letter: 'C', annotation_id: 'c2' }] }),
    { unit_id: 'r-1', conflict_id: 'c-1', choice: 'pick', reason: '', reason_code: 'both_valid', picks: [{ letter: 'A', annotation_id: 'a1' }, { letter: 'C', annotation_id: 'c2' }] });
  assert.equal(m.decisionText({ choice: 'A' }, { A: 'A01' }), 'Kept A (A01)');
  assert.equal(m.decisionText({ choice: 'all' }), 'Kept all');
  assert.equal(m.decisionText({ choice: 'none' }), 'Kept none');
  assert.equal(m.decisionText({ choice: 'pick', picks: [{ letter: 'C', annotation_id: 'c1' }, { letter: 'A', annotation_id: 'a1' }] }, { A: 'A01', C: 'A09' }),
    'Kept 2 chosen marks of A (A01) and C (A09)');
  assert.equal(m.decisionText({ choice: 'edited', marks: [{}, {}] }), 'Replaced by 2 marks of the adjudicator\'s own');
  assert.equal(m.whoText([{ letter: 'A', annotator_id: 'A08' }, { letter: 'B', annotator_id: 'A03' }, { letter: 'C', annotator_id: 'A09' }]), 'A08 (A), A03 (B) and A09 (C)');
  assert.equal(m.decisionText(null), 'Not decided');
  assert.equal(m.conflictSentence(conflict('c1')), 'Different types. A: Eye-blink-artifact; B: Eye-movement-artifact.');
  assert.equal(m.spanText(12.3, 12.714), '12.30–12.71 s');
});

test('the queue: its tabs, its actions, its search and its honest summary', () => {
  const units = [
    { unit_id: 'r-1', recording_id: 'sub-001/eeg/a.vhdr', status: 'ready', conflicts: 12, decided: 0, annotators: [{ letter: 'A', annotator_id: 'A01', display_name: 'Jonas Berg' }, { letter: 'B', annotator_id: 'A02' }] },
    { unit_id: 'r-2', recording_id: 'sub-002/eeg/a.vhdr', status: 'adjudicating', yours: true, conflicts: 10, decided: 4, annotators: [] },
    { unit_id: 'r-3', recording_id: 'sub-003/eeg/a.vhdr', status: 'adjudicating', yours: false, adjudicator_id: 'E02', conflicts: 5, decided: 1, annotators: [] },
    { unit_id: 'r-4', recording_id: 'sub-004/eeg/a.vhdr', status: 'adjudicated', annotators: [], notes: 'pilot batch' },
    { unit_id: 'r-5', recording_id: 'sub-005/eeg/a.vhdr', status: 'collecting', annotators: [] },
    { unit_id: 'r-6', recording_id: 'sub-006/eeg/a.vhdr', status: 'ready', own: true, conflicts: 7, decided: 0, annotators: [] },
    { unit_id: 't-1', recording_id: 'sub-001/eeg/a.vhdr', status: 'ready', conflicts: 3, decided: 0, window: { start_s: 0, end_s: 45 }, annotators: [], kind: 'task' },
  ];
  assert.deepEqual(m.tabCounts(units), { ready: 3, progress: 2, finished: 1, waiting: 1, all: 7 });
  assert.deepEqual(m.tabRows(units, 'progress').map((u) => u.unit_id), ['r-2', 'r-3']);
  assert.deepEqual(units.map((u) => (m.queueAction(u) || {}).label || null), ['Start', 'Continue', null, 'Open', null, null, 'Start']);
  // three ready on two recordings (sub-001 whole and a part of it, and sub-006), one of them the person's own; the conflicts left
  // are those they can work on (12 + 3 ready, 6 left in theirs)
  assert.equal(m.queueSummary(units), '3 ready to adjudicate (on 2 recordings), 1 of them your own work · 1 of yours in progress · 1 in progress with others · 1 finished · '
    + '1 waiting or agreed. 21 conflicts left to decide, 6 of them in yours.');
  assert.equal(m.queueSummary([units[0], units[6]]), '2 ready to adjudicate (on 1 recording). 15 conflicts left to decide.');
  assert.equal(m.queueSummary([units[3]]), 'Nothing ready to adjudicate · 1 finished. 0 conflicts left to decide.');
  assert.equal(m.blockedText(units[5]), 'Your own work: someone else adjudicates it');
  assert.equal(m.blockedText(units[2]), 'E02 is adjudicating it');
  assert.equal(m.blockedText(units[0]), '');
  assert.equal(m.defaultTab(units), 'progress'); // one's own in progress first
  assert.equal(m.defaultTab([units[0]]), 'ready');
  assert.deepEqual(m.queueOrder(m.tabRows(units, 'ready')).map((u) => u.unit_id), ['r-1', 't-1', 'r-6']); // what cannot be started last
  assert.deepEqual(m.searchUnits(units, 'jonas').map((u) => u.unit_id), ['r-1']);
  assert.deepEqual(m.searchUnits(units, 'PILOT sub-004').map((u) => u.unit_id), ['r-4']);
  assert.equal(m.searchUnits(units, '  ').length, 7);
  assert.equal(m.unitWhat(units[6]), 'Part 0:00–0:45');
  assert.equal(m.unitWhat({ kind: 'corrections', corrected: { annotator_id: 'A01', attempt: 1 } }), 'Corrections of A01\'s version 1');
  assert.equal(m.canBecomeReference(units[3]), true);
  assert.equal(m.canBecomeReference({ ...units[3], window: { start_s: 0, end_s: 45 } }), false);
  assert.deepEqual(m.expertCardLines(units), ['1 adjudication of yours in progress, 6 conflicts left.', '2 ready to adjudicate, 15 conflicts in all.']);
  assert.deepEqual(m.expertCardLines([]), []);
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
      letters: { A02: 'B', A01: 'A' }, promoted: [{ set_id: 'practice', to: 'quiz_item', id: 'q04' }],
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
  assert.equal(row.choice, 'B');
  // the letters change from unit to unit: the row says who each one is, and whose marks were kept
  assert.equal(row.letters, 'A=A01,B=A02');
  assert.equal(row.kept_annotator_ids, 'A02');
  assert.equal(row.reason, 'eyes move sideways'); // no tab inside a cell
  const second = Object.fromEntries(m.LIBRARY_COLUMNS.map((c, i) => [c, tsv[2].split('\t')[i]]));
  assert.equal(second.choice, 'n/a');
  assert.equal(second.kept_annotator_ids, 'n/a');
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
  assert.equal(m.promotedText(entries[0]), 'Quiz item q04 of practice');
  assert.equal(row.promoted, 'practice/q04');
  assert.deepEqual(m.keptPeople({ marks: [{ letter: 'A', annotator_id: 'A08', annotation_id: 'a1' }, { letter: 'B', annotator_id: 'A03', annotation_id: 'b1' },
    { letter: 'B', annotator_id: 'A03', annotation_id: 'b2' }], decision: { choice: 'pick', picks: [{ letter: 'B', annotation_id: 'b2' }] } }), ['A03']);
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
  assert.equal(o.outcomeSummary(item), '3 decided: 1 as you had it, 1 where a colleague\'s mark was kept, 1 where your mark was not kept.');
  assert.equal(o.outcomeSummary({ k: 3, conflicts: [{ decision: { outcome: 'all_kept' } }, { decision: { outcome: 'yours_kept' } }, { decision: { outcome: 'yours_kept' } }] }),
    '3 decided: 2 as you had them, 1 with yours kept among others.');
  assert.equal(o.outcomesLead([item]), 'In 1 of the 3 places where you and a colleague disagreed, the expert decided as you had it.');
  assert.deepEqual(o.conflictLines(item.conflicts[2]), { yours: 'You: no mark here', others: 'Others: Eye-blink-artifact 32.00–32.30 s', kept: 'Kept: no mark' });
  assert.equal(o.conflictLines(item.conflicts[0]).kept, 'Kept: Eye-movement-artifact 2.00–2.40 s');
  assert.equal(o.OUTCOME_TEXT.all_kept, 'Kept with the others');
  const { adjudicatedText } = await import('../../electrotag/web/static/js/views/home_list.js');
  assert.equal(adjudicatedText([{ recording_id: 'r', conflicts: item.conflicts }], 'r'), 'Adjudicated: 1 of 3 disagreements decided as you had them');
  assert.equal(adjudicatedText([{ recording_id: 'r', conflicts: item.conflicts }], 'other'), '');
  assert.equal(o.outcomesCard([]), null);
  assert.equal(o.outcomesCard([], []), null);
  // versions two experts corrected differently, once settled, are on the same card (in settled.js's words)
  const settled = { standing: 'adjudicated', recording_id: 'r', attempt: 1, correctors: [{ corrector_id: 'E01' }, { corrector_id: 'E02' }],
    adjudication: { unit_id: 'k-1', conflicts: [{ kinds: ['type'], onset_s: 2, offset_s: 2.4, decision: { choice: 'A' } }] } };
  assert.deepEqual(o.settledOf([settled, { ...settled, standing: 'pending' }, { ...settled, adjudication: { conflicts: [] } }, { standing: 'single' }]), [settled]);
});

test('the outcome is said from the annotator\'s side: whether what they marked, or left unmarked, stood', async () => {
  const { outcomeWords } = await import('../../electrotag/web/static/js/expert/outcomes.js');
  const mark = [{ label: 'Eye-blink-artifact', onset_s: 1, offset_s: 2 }];
  const w = (outcome, yours, k = 2) => outcomeWords({ yours, decision: { outcome } }, k);
  // every outcome the study gives (conflicts.OUTCOMES), with a mark of one's own there and without, for two and three versions
  const expected = {
    yours_kept: [['Your mark was kept', true], ['No mark here, as you had it', true]],
    all_kept: [['Both marks were kept', true], ['Both marks were kept', true]],
    part_kept: [['Some of your marks were kept, not all', false], ['Some of your marks were kept, not all', false]],
    other_kept: [['A colleague\'s mark was kept instead of yours', false], ['A colleague\'s mark was kept where you had none', false]],
    none_kept: [['Your mark was not kept: no mark here', false], ['Your mark was not kept: no mark here', false]],
    edited: [['The adjudicator drew their own mark instead', false], ['The adjudicator drew their own mark where you had none', false]],
  };
  for (const [outcome, [withMark, without]] of Object.entries(expected)) {
    assert.deepEqual(w(outcome, mark), { text: withMark[0], yours: withMark[1] }, outcome);
    assert.deepEqual(w(outcome, []), { text: without[0], yours: without[1] }, outcome);
  }
  // with three or more, never "both"
  assert.deepEqual(w('all_kept', mark, 3), { text: 'Your mark was kept, with colleagues\' marks', yours: true });
  for (const outcome of Object.keys(expected)) for (const yours of [mark, []]) assert.doesNotMatch(w(outcome, yours, 3).text, /[Bb]oth/);
});

test('the adjudication view says its own keys: the hint and the key sheet follow the versions compared', () => {
  assert.match(m.hintText(['A', 'B']), /^1 or 2 keep A or B {2}· {2}K both {2}· {2}X neither/);
  assert.match(m.hintText(['A', 'B', 'C']), /^1 to 3 keep a version {2}· {2}K all {2}· {2}X none/);
  assert.doesNotMatch(m.hintText(['A', 'B', 'C']), /both|neither|A or B/);
  assert.match(m.hintText(['A', 'B'], 'view'), /N \/ P/);
  const sheet = m.keySheet(['A', 'B', 'C']);
  const rows = sheet.flatMap((g) => g.rows);
  assert.deepEqual(rows[0], ['1–3 / A / B / C', 'keep that version: its marks as they are']);
  for (const k of ['K', 'X', 'M', 'E', 'Shift+1–7', 'R', 'Enter', 'S', 'N / P', 'T / Shift+T', '?', 'F', '1–7']) assert.ok(rows.some(([x]) => x === k), k);
  assert.match(rows.find(([x]) => x === 'Shift+1–7')[1], /1 clear artifact, 2 not an artifact/);
  assert.equal(m.keySheet(['A', 'B'])[0].rows[0][0], '1 / 2 / A / B');
  assert.ok(!m.keySheet(['A', 'B'], 'view').flatMap((g) => g.rows).some(([x]) => x === 'K'));
  // the keys of the sheet are the keys keyAction answers
  for (const k of ['k', 'x', 'm', 'e', 'r', 's', 'n', 'p', 't', 'f', 'Enter', '3', 'c']) assert.ok(m.keyAction(k, ['A', 'B', 'C']), k);
});

test('the library export has the columns of the study\'s own library.tsv', async () => {
  const fs = await import('node:fs');
  const py = fs.readFileSync(new URL('../../electrotag/web/library.py', import.meta.url), 'utf8');
  const cols = /LIBRARY_COLUMNS = \(([^)]*)\)/s.exec(py)[1].match(/"([a-z_]+)"/g).map((x) => x.slice(1, -1));
  assert.deepEqual([...m.LIBRARY_COLUMNS], cols);
});
