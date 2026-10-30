// The audit log in words (the admin area's Records and Overview): a title for every kind of change the
// study writes to its audit log, and a decision on a conflict told by whose version it kept. Kept apart
// from model.js, which the sandbox's sign-in page loads, so that it comes with the admin area alone.

/** What each audited operation did, for the records' filter and table. */
export const AUDIT_OPS = Object.freeze({
  settings_update: 'Study settings changed',
  user_add: 'Account added',
  user_update: 'Account changed',
  user_reset_password: 'Password reset',
  user_invite: 'Invitation link made',
  user_invite_revoke: 'Invitation link withdrawn',
  user_remove: 'Account removed',
  assign: 'Recordings assigned',
  unassign: 'Assignment removed',
  programme_set: 'Training programme changed',
  recordings_register: 'Recordings added',
  recording_update: 'Recording changed',
  recording_remove: 'Recording removed',
  set_create: 'Reference set created',
  set_update: 'Reference set changed',
  set_delete: 'Reference set deleted',
  set_add_reference: 'Reference added',
  set_recording_update: 'Use or guidance changed',
  set_remove_recording: 'Recording removed from a set',
  set_guided_note: 'Guided note changed',
  set_example_create: 'Example set created',
  quiz_item_add: 'Quiz item added',
  quiz_item_remove: 'Quiz item removed',
  register: 'Recordings registered (command)',
  init: 'Study created (an earlier command)',
  problem_report: 'Problem reported',
  problem_resolve: 'Problem resolved',
  problem_return: 'Recording returned to its annotator',
  problem_reassign: 'Recording given to someone else',
  review_save: 'Review saved',
  replay_consent_set: 'Replay consent changed',
  study_create: 'Study created (command)',
  save_recovered: 'Interrupted save completed',
  // tasks (electrotag/web/tasks.py)
  tasks_create: 'Recordings shared out as tasks',
  task_update: 'Task changed',
  task_remove: 'Task removed',
  // the training path (training_path.py, correct_marks.py)
  snippet_add: 'Snippet added',
  snippet_remove: 'Snippet removed',
  training_reopen: 'Training reopened',
  training_assessment_set: 'New assessment set given',
  set_planted_make: 'Correct-the-marks exercise made',
  set_planted_from: 'Correct-the-marks exercise made from an expert\'s version',
  set_planted_remove: 'Correct-the-marks exercise removed',
  // the experts' work (corrections.py, adjudication.py, library.py)
  correction_save: 'Correction saved',
  adjudication_start: 'Adjudication started',
  adjudication_decide: 'Conflict decided',
  adjudication_finish: 'Adjudication finished',
  adjudication_reopen: 'Adjudication reopened',
  library_promote: 'Library entry made into training material',
  // datasets, collections, groups and hand-outs (datasets.py)
  dataset_create: 'Dataset made',
  dataset_update: 'Dataset changed',
  dataset_remove: 'Dataset removed',
  recordings_move: 'Recordings moved to another dataset',
  collection_create: 'Collection made',
  collection_update: 'Collection changed',
  collection_remove: 'Collection removed',
  group_create: 'Group made',
  group_update: 'Group changed',
  group_remove: 'Group removed',
  handout_create: 'Recordings handed out',
  handout_update: 'Hand-out changed',
  handout_withdraw: 'Hand-out withdrawn',
});

/**
 * Whose version a decision on a conflict kept, in words, from the adjudication_start entry of the same
 * adjudication (its details.inputs give each letter's person): "kept A01's version (A)", "kept E01's
 * correction of A01's work (B)", "kept every version's mark", "kept none of the marks", "made an edited
 * mark". Without the start entry (an older page not loaded yet) the letter is named: "kept version A".
 */
export function decisionWords(choice, inputs = null) {
  if (choice === 'all') return 'kept every version\'s mark';
  if (choice === 'none') return 'kept none of the marks';
  if (choice === 'edited') return 'made an edited mark';
  const found = Object.entries(inputs || {}).find(([, x]) => x && x.letter === choice);
  if (!found) return `kept version ${choice}`;
  const [person, x] = found;
  const whose = x.annotator_id || person;
  const who = x.source === 'correction' ? `${person}'s correction of ${whose}'s work` : `${whose}'s version`;
  return `kept ${who} (${choice})`;
}

/** An audit entry's summary as the records show it: a decision on a conflict names whose version it kept. */
export function auditSummary(e, entries = []) {
  const summary = String((e && e.summary) || '');
  if (!e || e.op !== 'adjudication_decide' || !e.details || !e.details.choice) return summary;
  const unit = e.details.unit_id;
  const start = (entries || []).find((x) => x.op === 'adjudication_start' && x.details && x.details.unit_id === unit);
  const words = decisionWords(String(e.details.choice), start ? start.details.inputs : null);
  const tail = `: ${e.details.choice}`;
  return summary.endsWith(tail) ? `${summary.slice(0, -tail.length)}: ${words}` : `${summary} (${words})`;
}

export function opText(op) {
  const t = AUDIT_OPS[op] || String(op || '').replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
