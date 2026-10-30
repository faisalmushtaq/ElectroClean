// The study team's screens after the usability check of the trainee path (October 2026): every kind
// of change in the audit log has a title and a filter entry, a decision on a conflict names whose
// version it kept, and a trainee's training path on their page in People is written for the study
// team rather than to the trainee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const m = await import('../../electrotag/web/static/js/admin/audit_words.js');
const { gateText } = await import('../../electrotag/web/static/js/admin/training_gate.js');

const WEB = new URL('../../electrotag/web/', import.meta.url).pathname;

/** Every operation the study's Python code writes to the audit log. */
function auditedOps() {
  const ops = new Set();
  for (const name of readdirSync(WEB).filter((f) => f.endsWith('.py'))) {
    const src = readFileSync(path.join(WEB, name), 'utf8');
    const patterns = [
      /audit\.record\(\s*[\w.]+,\s*[\w."]+,\s*"([a-z_]+)"/g, // audit.record(store, by, "op", ...)
      /_audit\(\s*\w+,\s*"([a-z_]+)"/g, // administration._audit(user, "op", ...)
      /_audit\(\s*\w+,\s*"([a-z_]+)" if [^"]+ else "([a-z_]+)"/g, // the command line's study_create
      /\*, op: str = "([a-z_]+)"/g, // snippet_add(..., op="snippet_add")
      /_keep\([^)]*?"(set_planted_[a-z]+)"/gs, // correct_marks.py
    ];
    for (const re of patterns) for (const x of src.matchAll(re)) for (const op of x.slice(1)) if (op) ops.add(op);
  }
  return ops;
}

test('every kind of change the study audits has a title in plain words and an entry in the filter', () => {
  const ops = auditedOps();
  for (const op of ['tasks_create', 'task_update', 'task_remove', 'snippet_add', 'snippet_remove', 'training_reopen', 'training_assessment_set',
    'set_planted_make', 'set_planted_from', 'set_planted_remove', 'correction_save', 'adjudication_start', 'adjudication_decide',
    'adjudication_finish', 'library_promote', 'user_add', 'study_create']) {
    assert.ok(ops.has(op), `the scan finds ${op}`);
  }
  for (const op of ops) {
    assert.ok(m.AUDIT_OPS[op], `${op} has a title`);
    assert.match(m.opText(op), /^[A-Z][a-z]/);
    assert.doesNotMatch(m.AUDIT_OPS[op], /_/, `${op}'s title is in words`);
  }
  assert.equal(m.opText('tasks_create'), 'Recordings shared out as tasks');
  assert.equal(m.opText('adjudication_decide'), 'Conflict decided');
  assert.equal(new Set(Object.values(m.AUDIT_OPS)).size, Object.keys(m.AUDIT_OPS).length, 'no two kinds read the same');
});

test('a decision on a conflict says whose version it kept', () => {
  const inputs = { A01: { letter: 'A', source: 'original', annotator_id: 'A01' }, A02: { letter: 'B', source: 'original', annotator_id: 'A02' } };
  assert.equal(m.decisionWords('A', inputs), "kept A01's version (A)");
  assert.equal(m.decisionWords('B', { E02: { letter: 'B', source: 'correction', annotator_id: 'A01' } }), "kept E02's correction of A01's work (B)");
  assert.equal(m.decisionWords('all'), "kept every version's mark");
  assert.equal(m.decisionWords('none'), 'kept none of the marks');
  assert.equal(m.decisionWords('edited'), 'made an edited mark');
  assert.equal(m.decisionWords('C', inputs), 'kept version C', 'a letter not found is named as it is');
  const start = { op: 'adjudication_start', summary: 'Started adjudicating sub-01 (A01, A02): 2 conflicts', details: { unit_id: 't-1', inputs } };
  const decide = { op: 'adjudication_decide', summary: 'Decided a type conflict of sub-01: A', details: { unit_id: 't-1', choice: 'A' } };
  assert.equal(m.auditSummary(decide, [decide, start]), "Decided a type conflict of sub-01: kept A01's version (A)");
  assert.equal(m.auditSummary(decide, [decide]), 'Decided a type conflict of sub-01: kept version A', 'the start not loaded yet');
  assert.equal(m.auditSummary({ ...decide, summary: 'Decided' }, [start]), "Decided (kept A01's version (A))");
  assert.equal(m.auditSummary(start, [start]), start.summary, 'other entries are as the study wrote them');
  assert.equal(m.auditSummary({ op: 'user_add' }), '');
});

test("a trainee's training path is described to the study team, never as \"your\"", () => {
  const prog = (status, result = '') => ({ stages: [{ key: 'practice', status: 'completed' }, { key: 'assessment', status, result }] });
  const closed = { open: false, reason: 'training_required', message: 'Your study recordings open once you pass…' };
  assert.equal(gateText('T03', { open: true }, prog('completed', 'met')), "T03's study recordings are open.");
  assert.equal(gateText('T03', closed, prog('locked')),
    "T03's study recordings stay locked until they pass the competency assessment at the end of their training path.");
  assert.match(gateText('T03', closed, prog('available'), 'completed'), /until they finish the competency assessment/);
  assert.match(gateText('T03', closed, prog('completed', 'not_met')),
    /^T03's assessment did not meet the competency criteria, so their study recordings stay locked until the study team reopens the training/);
  assert.match(gateText('T03', closed, prog('completed', 'not_determined')), /^T03 has finished the competency assessment, and its result is not settled yet/);
  for (const s of [prog('locked'), prog('completed', 'not_met'), prog('completed', 'not_determined')]) {
    assert.doesNotMatch(gateText('T03', closed, s), /\b[Yy]our\b/);
  }
});

test('snippet authoring says how long the recording and the snippet are, and what trainees see', async () => {
  const { spanText } = await import('../../electrotag/web/static/js/admin/snippets.js');
  assert.equal(spanText({ start: '4', end: '5.2', context: '2', duration: 300 }),
    'The recording is 5:00 long (300.0 s). The snippet lasts 1.20 s, from 4.00 to 5.20 s; trainees see 2.00 to 7.20 s of the recording (5.20 s).');
  assert.equal(spanText({ start: '', end: '', duration: 61.5 }), 'The recording is 1:01.5 long (61.5 s).');
  assert.equal(spanText({ start: '1', end: '0.5', duration: 60 }), 'The recording is 1:00 long (60.0 s). The end must come after the start.');
  assert.equal(spanText({ start: '59', end: '61', duration: 60 }), 'The recording is 1:00 long (60.0 s). The snippet ends after the recording does.');
  assert.match(spanText({ start: '0.5', end: '59.5', context: '2', duration: 60 }), /trainees see 0\.00 to 60\.00 s/, 'the EEG shown stops at the ends of the recording');
  assert.equal(spanText({ start: '1', end: '2' }), 'The snippet lasts 1.00 s, from 1.00 to 2.00 s; trainees see 0.00 to 4.00 s of the recording (4.00 s).');
});
