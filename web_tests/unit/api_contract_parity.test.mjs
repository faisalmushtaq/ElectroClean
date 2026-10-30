// The sandbox's stand-in for the study server (js/api/demo.js and the demo_*.js modules) against
// the real service layer. web_tests/contract_parity.py makes a fresh study from the sandbox's own
// recordings, accounts, training set and quiz, and serves the FastAPI application in-process; this
// test sends one scripted series of calls (what a visitor does in the sandbox) through
// js/api/http.js to that server and through js/api/demo.js to the stand-in, and compares the
// answers: their shapes (keys and types) everywhere, and their values (statuses, counts, error codes
// and the texts shown to the person) except where ALLOWED below says why they differ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { DemoBackend, exampleRecording, QUIZ, recordingIdOf, TRAINING_SET } from '../../electrotag/web/static/js/api/demo.js';
import { HttpBackend } from '../../electrotag/web/static/js/api/http.js';
import { READY_MADE, READY_RID } from '../../electrotag/web/static/js/api/demo_planted.js';
import { channelType, demoSpecs, exampleNote, syntheticEdfBytes, truthAnnotations } from '../../electrotag/web/static/js/eeg/synthetic.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A Python with ElectroTag's server (FastAPI and MNE-Python): $ELECTROTAG_PYTHON, the repository's .venv, or python3.
function findPython() {
  for (const p of [process.env.ELECTROTAG_PYTHON, path.join(REPO, '.venv', 'bin', 'python'), 'python3']) {
    if (!p || (p.includes('/') && !fs.existsSync(p))) continue;
    const r = spawnSync(p, ['-c', 'import fastapi, httpx, mne, electrotag.web.app'], { cwd: REPO, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO } });
    if (r.status === 0) return p;
  }
  return null;
}
const PYTHON = findPython();

// ------------------------------------------------------------------ differences allowed
// Each entry: the calls it is for (a regular expression of their names in the script below), the
// path in the answer (dots between keys, [] for any element of a list, a regular expression), how
// the two may differ, and why. Everything else must be the same.
//   type      the same type, any value
//   numbers   the same text once every number in it is set aside (times worked out from the clock)
//   prefix    the sandbox's text starts with the server's and adds a sentence
//   sorted:k  a list in another order: compared once both are sorted by the key k
//   any       anything, or missing on one side
const TIMES = ['saved_at', 'created_at', 'modified_at', 'reported_at', 'reviewed_at', 'registered_at', 'first_saved_at', 'completed_at',
  'generated_at', 'started_at', 'answered_at', 'finished_at', 'closed_at', 'last_seen', 'last_activity', 'last_active', 'at', 'resolved_at',
  'returned_at', 'expires_at', 'invited_at', 'ended_at', 'added_at', 'changed_at', 'save_times\\[\\]', 'today', 'days\\[\\]'].join('|');
export const ALLOWED = [
  ['.*', `(.*\\.)?(${TIMES})`, 'type', 'times: each side stamps its own'],
  ['.*', '(.*\\.)?(token|visit_id|session_id|problem_id|review_id|annotation\\.annotation_id)', 'type', 'IDs and tokens: each side makes its own'],
  ['.*', '(.*\\.)?(summary\\.time_s|previous\\.seconds|stages\\[\\]\\.time_s)', 'type', "a guided step's time is measured by each side's clock"],
  ['login A01 \\(wrong password\\)', 'error\\.message', 'prefix', 'the sandbox adds its accounts and password'],
  ['guided \\d (continue step \\d+|submit)', '(guided\\.)?message', 'numbers', 'messages that give a time worked (the coach\'s "in 0 s", "Recording saved … (0 s)") come from each side\'s clock'],
  ['.*', '(.*\\.)?demo_notice', 'any', 'the sandbox reminds the visitor, where the server checks and keeps things, that this is a demonstration'],
  ['.*', '(.*\\.)?display\\.warnings', 'any', 'the sandbox says its recordings are simulated; the server notes how it read their BIDS sidecars'],
  ['.*', '(entries|recent)\\[\\]\\.details', 'any', "the audit log's details, kept for the record and shown as they are behind Show; the summaries a person reads are compared"],
  ['.*', 'temporary_password', 'type', 'made afresh by each side'],
  ['.*', '(.*\\.)?logging_notice', 'any', 'the sandbox says that its record of use stays in this browser'],
  ['.*', 'leaderboard\\.(you|rows\\[\\])\\.name', 'type', 'pseudonyms come from each study\'s own secret'],
  ['quiz get.*', 'items', 'sorted:item_id', 'each shuffles the segments its own way (the same for a person at every visit)'],
  ['.*practice submit.*', 'feedback\\.metrics\\.(time_kappa|time_positive_agreement|channel_positive_agreement|mean_iou|mean_channel_jaccard|false_positives_per_min)',
    'any', 'agreement figures the sandbox does not compute; the review shows only the score, the share found and the share of the right type'],
  ['.*practice submit.*', 'feedback\\.per_category', 'any', 'the scores by type, which the review does not show'],
  ['.*', 'manifest\\.gaps|recordings\\..*\\.gaps', 'any', "the sandbox's third example has a stretch without data at its end, which its EDF file cannot hold"],
  ['.*', '(.*\\.)?corrected_at', 'type', 'times: each side stamps its own'],
  ['.*', '(.*\\.)?corrected_from\\.annotations_sha256', 'type', 'the checksum of the saved _annotations.json file, which only the server writes'],
  ['expert replay_events_get.*', 'events\\[\\]\\.(t|wall|choose_recording|reference_set|assessment_kind)', 'any',
    "the visit's log as each side keeps it: the server writes the desktop's visit_started and times log_closed by its clock"],

  // Until the sandbox's own answers (js/api/demo.js) carry `task: null`, the browser reads a missing task as none.
  ['.*', '(items\\[\\]\\.)?task', 'any', 'the sandbox makes no tasks (they need the study server: demo_admin.js SERVER_ONLY), so its items and matches have none'],
];

// ------------------------------------------------------------------ comparison
function compile(rules) {
  return rules.map(([call, where, how, why]) => ({ call: new RegExp(`^(${call})$`), where: new RegExp(`^(${where})$`), how, why }));
}
const RULES = compile(ALLOWED);
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function ruleFor(call, where) {
  return RULES.find((r) => r.call.test(call) && r.where.test(where)) || null;
}

/** The differences between two answers to one call, as readable lines. */
export function differences(call, py, js, where = '', out = []) {
  const rule = ruleFor(call, where);
  if (rule && rule.how === 'any') return out;
  const name = where || '(answer)';
  const show = (v) => JSON.stringify(v)?.slice(0, 160);
  if (rule && rule.how === 'type') {
    if (typeOf(py) !== typeOf(js)) out.push(`${call}: ${name} is ${typeOf(py)} on the server, ${typeOf(js)} in the sandbox`);
    return out;
  }
  if (typeOf(py) !== typeOf(js)) {
    out.push(`${call}: ${name} is ${show(py)} on the server, ${show(js)} in the sandbox`);
    return out;
  }
  if (rule && typeof py === 'string' && (rule.how === 'prefix' ? js.startsWith(py) : rule.how === 'numbers' ? py.replace(/\d+(\.\d+)?/g, '#') === js.replace(/\d+(\.\d+)?/g, '#') : false)) return out;
  if (Array.isArray(py)) {
    if (py.length !== js.length) out.push(`${call}: ${name} has ${py.length} items on the server, ${js.length} in the sandbox`);
    const by = rule && rule.how.startsWith('sorted:') ? rule.how.slice(7) : null;
    const order = (list) => (by ? [...list].sort((x, y) => String(x[by]).localeCompare(String(y[by]))) : list);
    const [a, b] = [order(py), order(js)];
    for (let i = 0; i < Math.min(a.length, b.length); i++) differences(call, a[i], b[i], `${where}[]`, out);
    return out;
  }
  if (py && typeof py === 'object') {
    for (const k of new Set([...Object.keys(py), ...Object.keys(js)])) {
      const sub = where ? `${where}.${k}` : k;
      if (!(k in js) || !(k in py)) {
        const r = ruleFor(call, sub);
        if (!(r && r.how === 'any')) out.push(`${call}: ${sub} is ${k in py ? 'only on the server' : 'only in the sandbox'} (${JSON.stringify(k in py ? py[k] : js[k])?.slice(0, 120)})`);
        continue;
      }
      differences(call, py[k], js[k], sub, out);
    }
    return out;
  }
  const same = typeof py === 'number' ? Math.abs(py - js) <= 1e-9 * Math.max(1, Math.abs(py)) : py === js;
  if (!same) out.push(`${call}: ${name} is ${show(py)} on the server, ${show(js)} in the sandbox`);
  return out;
}

// ------------------------------------------------------------------ the two sides
const memory = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)), remove: (k) => m.delete(k) };
};

const SPECS = demoSpecs();
const RIDS = SPECS.map(recordingIdOf);
const PY_PASSWORD = 'electrotag';

/** What contract_parity.py needs to make the same study: the sandbox's recordings and its state as it starts. */
function writeSandbox(dir) {
  const admin = new DemoBackend({ storage: memory(), tokens: memory() })._admin.s;
  const set = admin.sets[0];
  for (const spec of SPECS) {
    const file = path.join(dir, 'recordings', recordingIdOf(spec));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, syntheticEdfBytes(spec));
    // The BIDS sidecars a study keeps with such a file: the channel types and the events, which the
    // sandbox's built-in examples carry.
    const stem = file.replace(/_eeg\.edf$/, '');
    const bids = { eeg: 'EEG', eog: 'EOG', ecg: 'ECG', misc: 'MISC' };
    fs.writeFileSync(`${stem}_channels.tsv`, `name\ttype\tunits\n${spec.channels.map((c) => `${c}\t${bids[channelType(c)]}\tuV`).join('\n')}\n`);
    fs.writeFileSync(`${stem}_events.tsv`, `onset\tduration\ttrial_type\n${spec.events.map((e) => `${e.onsetS}\t0\t${e.label}`).join('\n')}\n`);
  }
  const truthOf = (rid) => truthAnnotations(SPECS[RIDS.indexOf(rid)]);
  const sandbox = {
    study_id: 'demo', study_name: admin.name,
    users: admin.users.map((u) => ({ annotator_id: u.annotator_id, display_name: u.display_name, role: u.role, roles: u.roles, password: PY_PASSWORD })),
    assignments: Object.fromEntries([...new Set(admin.assignments.map((a) => a.annotator_id))]
      .map((aid) => [aid, RIDS.filter((rid) => admin.assignments.some((a) => a.annotator_id === aid && a.recording_id === rid))])),
    programmes: Object.fromEntries(admin.users.filter((u) => u.programme).map((u) => [u.annotator_id, u.programme])),
    training_set: {
      set_id: set.set_id, name: set.name, description: set.description, pass: set.practice_pass, guided_tolerance: set.guided_tolerance,
      recordings: set.recordings.map((r) => {
        const spec = SPECS[RIDS.indexOf(r.recording_id)];
        const truth = truthOf(r.recording_id);
        return { recording_id: r.recording_id, use: r.use, guidance: r.guidance, truth,
          notes: Object.fromEntries(truth.map((a) => [a.annotation_id, exampleNote(a.label, a.duration_samples / spec.sfreq, a.channels)])) };
      }),
    },
    quiz: { feedback: QUIZ.feedback, items: QUIZ.items },
  };
  sandbox.training_set.planted = { [READY_RID]: READY_MADE }; // the sandbox's ready-made correct-the-marks exercise
  fs.writeFileSync(path.join(dir, 'sandbox.json'), JSON.stringify(sandbox, null, 1));
}

/** The study server in a Python process; fetch() is sent to it, one request a line. */
async function startServer(dir) {
  const proc = spawn(PYTHON, [path.join(REPO, 'web_tests', 'contract_parity.py'), dir], { cwd: REPO, env: { ...process.env, PYTHONPATH: REPO }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
  const lines = readline.createInterface({ input: proc.stdout });
  const waiting = [];
  let ready;
  const started = new Promise((resolve, reject) => {
    ready = resolve;
    proc.on('exit', (code) => reject(new Error(`contract_parity.py stopped (${code}):\n${stderr}`)));
  });
  lines.on('line', (line) => {
    if (line === 'ready') { ready(); return; }
    const w = waiting.shift();
    if (w) w(JSON.parse(line));
  });
  await started;
  let queue = Promise.resolve();
  const fetchPy = (url, init = {}) => {
    const u = new URL(url);
    const req = { method: init.method || 'GET', path: u.pathname + u.search, headers: init.headers || {}, body: init.body ?? null };
    // one request at a time, in order
    const answer = queue.then(() => new Promise((resolve) => { waiting.push(resolve); proc.stdin.write(`${JSON.stringify(req)}\n`); }));
    queue = answer.catch(() => {});
    return answer.then((r) => new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } }));
  };
  return { fetch: fetchPy, stop: () => { proc.stdin.end(); proc.kill(); } };
}

// ------------------------------------------------------------------ the visitor's calls
async function matchBody(rid, extra = {}) {
  const rec = exampleRecording(rid);
  const fp = await rec.fingerprint();
  return { file_name: rec.fileName, size_bytes: rec.sizeBytes, format: 'edf', sha256: fp.hex, sfreq: rec.sfreq,
    n_samples: rec.nSamples, ch_names: rec.channels.map((c) => c.name), ...extra };
}

const STAMP = '2026-10-29T10:00:00.000+00:00';
const ann = (id, label, onset, dur, channels = [], extra = {}) => ({ annotation_id: id, label, onset_sample: onset, duration_samples: dur, channels, created_at: STAMP, modified_at: STAMP, ...extra });
const hex = (n) => n.toString(16).padStart(32, '0');

/**
 * The script: `call(name, fn)` runs fn(side) on the server's side and then the sandbox's, where a
 * side is {b: the Backend, password, mem: what this side has seen}, and records both answers (or
 * errors). The answers are compared afterwards.
 */
async function script(call) {
  const [r1, r2, r3] = RIDS;
  const B1 = ann(hex(1), 'Eye-blink-artifact', 750, 100, ['Fp1', 'Fp2', 'VEOG'], { confidence: 4, note: 'clear blink' });
  const E1 = ann(hex(2), 'EMG-artifact', 2300, 400, ['F7', 'F8', 'T7', 'T8']);

  // ------------------------------------------------------------ an annotator (A01)
  await call('login A01 (wrong password)', (s) => s.b.login('A01', 'not-this-one'));
  await call('login', (s) => s.b.login('A01', s.password));
  await call('me', (s) => s.b.me());
  await call('assignments (new)', (s) => s.b.assignments());
  await call('match by fingerprint', async (s) => s.b.match(await matchBody(r1)));
  await call('match a changed copy', async (s) => s.b.match(await matchBody(r1, { sha256: '0'.repeat(64) })));
  await call('match another file', async (s) => s.b.match(await matchBody(r1, { file_name: 'something_else.edf', sha256: '1'.repeat(64) })));
  await call('put_draft', (s) => s.b.putDraft(r1, 'standard', '', { annotations: [B1], elapsed_s: 42.5, viewed: [[0, 10], [5, 20]],
    view: { start_s: 10, duration_s: 10, first_channel: 0, n_channels: 32, scale_factor: 1 } }));
  await call('put_draft (bad confidence)', (s) => s.b.putDraft(r1, 'standard', '', { annotations: [{ ...B1, confidence: 7 }], elapsed_s: 1 }));
  await call('assignments (in progress)', (s) => s.b.assignments());
  await call('match with a draft', async (s) => s.b.match(await matchBody(r1)));
  await call('submit (unknown type)', (s) => s.b.submit({ recording_id: r1, mode: 'standard', context_id: '', annotations: [{ ...B1, label: 'Not-an-artifact' }], session: { elapsed_s: 60 }, sha256: s.mem.sha[RIDS.indexOf(r1)] }));
  await call('submit (outside the recording)', (s) => s.b.submit({ recording_id: r1, mode: 'standard', context_id: '', annotations: [{ ...B1, onset_sample: 10 ** 7 }], session: { elapsed_s: 60 }, sha256: s.mem.sha[RIDS.indexOf(r1)] }));
  await call('submit', async (s) => s.b.submit({ recording_id: r1, mode: 'standard', context_id: '', annotations: [B1, E1],
    session: { elapsed_s: 60, viewed_fraction: 1 }, sha256: s.mem.sha[0] }));
  await call('submit again', (s) => s.b.submit({ recording_id: r1, mode: 'standard', context_id: '', annotations: [B1], session: { elapsed_s: 5 }, sha256: s.mem.sha[RIDS.indexOf(r1)] }));
  await call('match a finished recording', async (s) => s.b.match(await matchBody(r1)));
  await call('match to revise', async (s) => s.b.match(await matchBody(r1, { revise: true })));
  await call('submit a revision (wrong version)', (s) => s.b.submit({ recording_id: r1, mode: 'standard', context_id: '', annotations: [B1], session: { elapsed_s: 5 }, sha256: s.mem.sha[0], revises: 3 }));
  await call('submit a revision', (s) => s.b.submit({ recording_id: r1, mode: 'standard', context_id: '', annotations: [B1], session: { elapsed_s: 5 }, sha256: s.mem.sha[0], revises: 1 }));
  await call('match to read the saved version', async (s) => s.b.match(await matchBody(r1, { view_saved: true })));
  await call('problem_report (noted)', (s) => s.b.reportProblem({ problem_id: hex(0xa1), recording_id: r2, mode: 'standard', context_id: '', reason: 'bad_channels', note: 'T7 is flat', outcome: 'noted', where: 'home' }));
  await call('problem_report (sent again)', (s) => s.b.reportProblem({ problem_id: hex(0xa1), recording_id: r2, mode: 'standard', context_id: '', reason: 'bad_channels', note: 'T7 is flat', outcome: 'noted', where: 'home' }));
  await call('problem_report (bad reason)', (s) => s.b.reportProblem({ problem_id: hex(0xa2), recording_id: r2, mode: 'standard', context_id: '', reason: 'boring', outcome: 'noted', where: 'home' }));
  await call('problem_report (unusable)', (s) => s.b.reportProblem({ problem_id: hex(0xa3), recording_id: r3, mode: 'standard', context_id: '', reason: 'too_noisy', note: '', outcome: 'unusable', where: 'annotate' }));
  await call('problem_report (unusable, saved already)', (s) => s.b.reportProblem({ problem_id: hex(0xa4), recording_id: r1, mode: 'standard', context_id: '', reason: 'other', outcome: 'unusable', where: 'home' }));
  await call('match a recording set aside', async (s) => s.b.match(await matchBody(r3)));
  await call('put_draft (set aside)', (s) => s.b.putDraft(r3, 'standard', '', { annotations: [], elapsed_s: 1 }));
  await call('assignments (after the reports)', (s) => s.b.assignments());
  await call('reviews (none yet)', (s) => s.b.myReviews());
  await call('achievements', (s) => s.b.achievements());
  await call('achievements (set a goal)', (s) => s.b.setAchievements({ goal_per_week: 5 }));
  await call('achievements (bad goal)', (s) => s.b.setAchievements({ goal_per_week: 0 }));
  await call('quiz get', (s) => s.b.quiz(QUIZ.set_id, { action: 'get' }));
  await call('quiz answer (right)', (s) => s.b.quiz(QUIZ.set_id, { action: 'answer', item_id: 'q01', label: 'EMG-artifact', response_time_s: 3.2 }));
  await call('quiz answer (accepted)', (s) => s.b.quiz(QUIZ.set_id, { action: 'answer', item_id: 'q02', label: 'Eye-artifact', response_time_s: 2 }));
  await call('quiz answer (wrong)', (s) => s.b.quiz(QUIZ.set_id, { action: 'answer', item_id: 'q03', label: 'EMG-artifact', response_time_s: 4 }));
  await call('quiz answer (sent again)', (s) => s.b.quiz(QUIZ.set_id, { action: 'answer', item_id: 'q03', label: 'EMG-artifact', response_time_s: 4 }));
  await call('quiz answer (changed)', (s) => s.b.quiz(QUIZ.set_id, { action: 'answer', item_id: 'q03', label: 'Chewing-artifact' }));
  await call('quiz answer (not an option)', (s) => s.b.quiz(QUIZ.set_id, { action: 'answer', item_id: 'q04', label: 'Banana' }));
  await call('quiz answer (no such item)', (s) => s.b.quiz(QUIZ.set_id, { action: 'answer', item_id: 'q99', label: 'EMG-artifact' }));
  await call('quiz (no such set)', (s) => s.b.quiz('nothing', { action: 'get' }));
  await call('quiz get (part answered)', (s) => s.b.quiz(QUIZ.set_id, { action: 'get' }));
  await call('quiz finish', (s) => s.b.quiz(QUIZ.set_id, { action: 'finish' }));
  await call('quiz answer (finished)', (s) => s.b.quiz(QUIZ.set_id, { action: 'answer', item_id: 'q05', label: 'EMG-artifact' }));
  await call('me (quiz finished)', (s) => s.b.me());
  await call('visit open', async (s) => { const v = await s.b.openVisit({ client: { user_agent: 'node' }, programme: false, mode: 'standard', context_id: '' }); s.mem.visit = v.visit_id; return v; });
  await call('visit events', (s) => s.b.sendEvents(s.mem.visit, [{ t: 1.5, wall: STAMP, type: 'key_press', key: 'b' }, { t: 2, wall: STAMP, type: 'view_change' }]));
  await call('visit close', (s) => s.b.closeVisit(s.mem.visit, 'signed_out'));
  await call('admin as an annotator', (s) => s.b.admin('overview', {}));
  await call('expert as an annotator', (s) => s.b.expert('replay_consent_get', {}));
  // Adjudication and the library (adjudication_*, library_*) are server-only: conflicts are found with the study's
  // Python code (the agreement analysis's matching), so the sandbox answers needs_server for each of them
  // (js/api/demo_adjudication.js, checked in ui_adjudication_model.test.mjs). Both sides refuse an annotator alike.
  await call('expert adjudication_list as an annotator', (s) => s.b.expert('adjudication_list', {}));
  await call('expert library_list as an annotator', (s) => s.b.expert('library_list', {}));
  await call('expert planted_list as an annotator', (s) => s.b.expert('planted_list', {}));
  await call('my feedback', (s) => s.b.myFeedback());
  await call('my_correction_get (none)', (s) => s.b.expert('my_correction_get', { correction_id: hex(0xc0) }));
  await call('replay_index_get as an annotator', (s) => s.b.expert('replay_index_get', { annotator_id: 'A01', recording_id: r1 }));
  await call('teaching_list as an annotator', (s) => s.b.expert('teaching_list', {}));
  await call('correction_save as an annotator', (s) => s.b.expert('correction_save', { correction_id: hex(0xc0) }));
  await call('training stage (not a trainee)', (s) => s.b.trainingStage({ stage: 'tour', action: 'skip' }));
  await call('training snippets (not a trainee)', (s) => s.b.trainingSnippets());
  await call('logout', (s) => s.b.logout());

  // ------------------------------------------------------------ an expert who also annotates (E01)
  await call('login', (s) => s.b.login('E01', s.password));
  await call('me (expert)', (s) => s.b.me());
  // Correct the marks: the sandbox has one ready-made exercise (js/api/demo_planted.js), which the server's study is
  // given too, so the reads compare exactly. Making, replacing and removing one (set_planted_make, set_planted_from,
  // set_planted_remove, and the admin channel's set_planted_*) are server-only: the mistakes are planted with the
  // study's Python code (electrotag/training/planted.py), and the sandbox answers needs_server (demo_planted.js,
  // demo_admin.js SERVER_ONLY); tests/test_web_correct_marks.py and ui_planted.test.mjs check them.
  await call('expert planted_list', (s) => s.b.expert('planted_list', {}));
  await call('expert planted_get', (s) => s.b.expert('planted_get', { set_id: QUIZ.set_id, recording_id: RIDS[0] }));
  await call('expert planted_get (no exercise)', (s) => s.b.expert('planted_get', { set_id: QUIZ.set_id, recording_id: RIDS[1] }));
  await call('expert planted_get (a practice recording)', (s) => s.b.expert('planted_get', { set_id: QUIZ.set_id, recording_id: RIDS[2] }));
  await call('expert planted_get (no recording)', (s) => s.b.expert('planted_get', { set_id: QUIZ.set_id }));
  await call('assignments (expert)', (s) => s.b.assignments());
  await call('expert replay_consent_get', (s) => s.b.expert('replay_consent_get', {}));
  await call('expert replay_consent_set', (s) => s.b.expert('replay_consent_set', { teaching: true }));
  await call('expert replay_consent_set (again)', (s) => s.b.expert('replay_consent_set', { teaching: true }));
  await call('expert replay_consent_set (not a choice)', (s) => s.b.expert('replay_consent_set', { teaching: 'yes' }));
  await call('expert replay_consent_get (after)', (s) => s.b.expert('replay_consent_get', {}));
  await call('expert unknown operation', (s) => s.b.expert('frobnicate_list', {}));
  // corrections of A01's saved work (r1, saved twice) and the replay of how it went
  await call('expert work_list', (s) => s.b.expert('work_list', {}));
  await call('expert saved_attempt_get', (s) => s.b.expert('saved_attempt_get', { annotator_id: 'A01', recording_id: r1 }));
  await call('expert saved_attempt_get (version 1)', (s) => s.b.expert('saved_attempt_get', { annotator_id: 'a01', recording_id: r1, attempt: 1 }));
  await call('expert saved_attempt_get (no such version)', (s) => s.b.expert('saved_attempt_get', { annotator_id: 'A01', recording_id: r1, attempt: 9 }));
  const C1 = ann(hex(0xc1), 'EMG-artifact', 4000, 200);
  const correction = (s, extra = {}) => ({ correction_id: hex(0xc0), annotator_id: 'A01', recording_id: r1, attempt: 2,
    annotations: [{ ...B1, label: 'Eye-artifact' }, C1], session: { elapsed_s: 30 }, sha256: s.mem.sha[0],
    changes: [{ annotation_id: B1.annotation_id, reason: 'wrong_type', note: 'a slow roll' }, { annotation_id: C1.annotation_id, reason: 'missed' }], overall_note: 'Look at F7', ...extra });
  await call('expert correction_save (a reason missing)', (s) => s.b.expert('correction_save', correction(s, { changes: [{ annotation_id: C1.annotation_id, reason: 'missed' }] })));
  await call('expert correction_save (not a reason)', (s) => s.b.expert('correction_save', correction(s, { changes: [{ annotation_id: C1.annotation_id, reason: 'lunch' }] })));
  await call('expert correction_save (a reason that does not suit the change)', (s) => s.b.expert('correction_save', correction(s, { changes: [{ annotation_id: B1.annotation_id, reason: 'wrong_type' }, { annotation_id: C1.annotation_id, reason: 'not_artifact' }] })));
  await call('expert correction_save (unchanged)', (s) => s.b.expert('correction_save', correction(s, { annotations: [B1] })));
  await call('expert correction_save (an older version)', (s) => s.b.expert('correction_save', correction(s, { attempt: 1 })));
  await call('expert correction_save (a mark outside the recording)', (s) => s.b.expert('correction_save', correction(s, { annotations: [{ ...C1, onset_sample: 10 ** 7 }] })));
  await call('expert correction_save', (s) => s.b.expert('correction_save', correction(s)));
  await call('expert correction_save (again)', (s) => s.b.expert('correction_save', correction(s)));
  await call('expert corrections_list', (s) => s.b.expert('corrections_list', { annotator_id: 'A01' }));
  await call('expert correction_get', (s) => s.b.expert('correction_get', { correction_id: hex(0xc0) }));
  await call('expert work_list (corrected)', (s) => s.b.expert('work_list', { corrected: true }));
  await call('expert saved_attempt_get (corrected)', (s) => s.b.expert('saved_attempt_get', { annotator_id: 'A01', recording_id: r1 }));
  await call('expert replay_index_get', (s) => s.b.expert('replay_index_get', { annotator_id: 'A01', recording_id: r1 }));
  await call('expert replay_events_get (a whole visit)', (s) => s.b.expert('replay_events_get', { visit_id: s.mem.visit }));
  await call('expert replay_events_get (no such part)', (s) => s.b.expert('replay_events_get', { visit_id: s.mem.visit, window_no: 4 }));
  await call('expert teaching_list', (s) => s.b.expert('teaching_list', {}));
  await call('admin as an expert', (s) => s.b.admin('overview', {}));
  await call('logout', (s) => s.b.logout());
  await call('login', (s) => s.b.login('A01', s.password));
  await call('my feedback (one correction)', (s) => s.b.myFeedback());
  await call('my_correction_get (one expert)', (s) => s.b.expert('my_correction_get', { correction_id: hex(0xc0) }));
  await call('logout', (s) => s.b.logout());

  // ------------------------------------------------------------ the administrator (ADMIN)
  await call('login', (s) => s.b.login('ADMIN', s.password));
  for (const op of ['overview', 'users_list', 'assignments_list', 'recordings_list', 'sets_list', 'settings_get', 'progress', 'stats', 'problems_list', 'reviews_list', 'quiz_items', 'audit', 'visits']) {
    await call(`admin ${op}`, (s) => s.b.admin(op, op === 'quiz_items' ? { set_id: QUIZ.set_id } : {}));
  }
  await call('admin saved_attempt_get', (s) => s.b.admin('saved_attempt_get', { annotator_id: 'A01', recording_id: r1, mode: 'standard', context_id: '' }));
  await call('admin review_save', (s) => s.b.admin('review_save', { review_id: hex(0xb1), annotator_id: 'A01', recording_id: r1, mode: 'standard', context_id: '', attempt: 2,
    overall_note: 'Good work', items: [{ annotation_id: B1.annotation_id, status: 'agree', note: '' }, { annotation_id: null, onset_sample: 5000, duration_samples: 250, channels: [], status: 'comment', note: 'a blink here?' }] }));
  await call('admin user_add (taken)', (s) => s.b.admin('user_add', { annotator_id: 'A01', display_name: 'Again' }));
  await call('admin assign (nobody)', (s) => s.b.admin('assign', { annotator_ids: ['Z99'], recording_ids: [r1] }));
  await call('admin problem_return', (s) => s.b.admin('problem_return', { problem_id: hex(0xa3), note: 'Try it again, please' }));
  await call('admin problems_list (after)', (s) => s.b.admin('problems_list', {}));
  await call('admin unknown operation', (s) => s.b.admin('frobnicate', {}));
  // what a visitor tries in the admin area: a colleague, their work, the settings, the training set
  await call('admin user_add', (s) => s.b.admin('user_add', { annotator_id: 'a02', display_name: 'Second annotator', password: 'long enough' }));
  await call('admin user_add (short password)', (s) => s.b.admin('user_add', { annotator_id: 'A03', password: 'short' }));
  await call('admin assign', (s) => s.b.admin('assign', { annotator_ids: ['A02'], all: true }));
  await call('admin assign (again)', (s) => s.b.admin('assign', { annotator_ids: ['A02'], recording_ids: [r1] }));
  await call('admin unassign', (s) => s.b.admin('unassign', { annotator_id: 'A02', recording_id: r3, mode: 'standard', context_id: '' }));
  await call('admin unassign (finished)', (s) => s.b.admin('unassign', { annotator_id: 'A01', recording_id: r1, mode: 'standard', context_id: '' }));
  await call('admin user_update', (s) => s.b.admin('user_update', { annotator_id: 'A02', notes: 'Starts on Monday' }));
  await call('admin user_update (own role)', (s) => s.b.admin('user_update', { annotator_id: 'ADMIN', role: 'annotator' }));
  await call('admin user_update (own roles)', (s) => s.b.admin('user_update', { annotator_id: 'ADMIN', roles: ['annotator', 'expert'] }));
  await call('admin user_add (an expert)', (s) => s.b.admin('user_add', { annotator_id: 'e02', display_name: 'Second expert', roles: ['annotator', 'expert'], password: 'long enough' }));
  await call('admin user_add (participant)', (s) => s.b.admin('user_add', { annotator_id: 'P01', roles: ['participant'] }));
  await call('admin user_add (reserved ID)', (s) => s.b.admin('user_add', { annotator_id: 'adjudicated' }));
  await call('admin user_add (roles disagree)', (s) => s.b.admin('user_add', { annotator_id: 'P02', role: 'annotator', roles: ['admin'] }));
  await call('admin user_add (no roles)', (s) => s.b.admin('user_add', { annotator_id: 'P03', roles: [] }));
  await call('admin user_update (roles)', (s) => s.b.admin('user_update', { annotator_id: 'A02', roles: ['expert', 'annotator'] }));
  await call('admin user_update (same roles)', (s) => s.b.admin('user_update', { annotator_id: 'A02', roles: ['annotator', 'expert'] }));
  await call('admin user_update (one role)', (s) => s.b.admin('user_update', { annotator_id: 'A02', role: 'annotator' }));
  await call('admin expert operations', (s) => s.b.expert('replay_consent_get', {}));
  // a second expert's correction of the same version: A01 then sees that the experts disagree, and neither version
  await call('admin correction_save (a second expert)', (s) => s.b.expert('correction_save', correction(s, { correction_id: hex(0xc2), annotations: [{ ...B1, label: 'EMG-artifact' }],
    changes: [{ annotation_id: B1.annotation_id, reason: 'wrong_type' }], overall_note: '' })));
  await call('admin recording_update', (s) => s.b.admin('recording_update', { scope: 'study', recording_id: r2, notes: 'T7 is noisy' }));
  await call('admin problem_resolve', (s) => s.b.admin('problem_resolve', { problem_id: hex(0xa1), note: 'Known; carry on' }));
  await call('admin problem_resolve (again)', (s) => s.b.admin('problem_resolve', { problem_id: hex(0xa1) }));
  await call('admin settings_update', (s) => s.b.admin('settings_update', { settings: { annotation: { min_duration_samples: 2 } } }));
  await call('admin settings_update (unknown block)', (s) => s.b.admin('settings_update', { settings: { output: { directory: '/' } } }));
  await call('admin set_update', (s) => s.b.admin('set_update', { set_id: QUIZ.set_id, practice_pass: { event_f1: 0.75, label_accuracy: 0.75 } }));
  await call('admin set_update (quiz only for T01)', (s) => s.b.admin('set_update', { set_id: QUIZ.set_id, allowed_annotators: ['t01'] }));
  await call('admin set_update (nothing)', (s) => s.b.admin('set_update', { set_id: QUIZ.set_id }));
  await call('admin set_guided_notes', (s) => s.b.admin('set_guided_notes', { set_id: QUIZ.set_id, recording_id: r1 }));
  await call('admin users_list (after)', (s) => s.b.admin('users_list', {}));
  await call('admin audit (after)', (s) => s.b.admin('audit', {}));
  await call('logout', (s) => s.b.logout());

  await call('login', (s) => s.b.login('A01', s.password));
  await call('reviews', (s) => s.b.myReviews());
  await call('my feedback (corrected)', (s) => s.b.myFeedback());
  await call('my_correction_get (two experts disagree)', (s) => s.b.expert('my_correction_get', { correction_id: hex(0xc0) }));
  await call('assignments (returned)', (s) => s.b.assignments());
  await call('me (the quiz is for T01)', (s) => s.b.me());
  await call('quiz (for T01)', (s) => s.b.quiz(QUIZ.set_id, { action: 'get' }));
  await call('logout', (s) => s.b.logout());

  // ------------------------------------------------------------ a trainee (T01)
  await call('login', (s) => s.b.login('T01', s.password));
  await call('me (trainee)', (s) => s.b.me());
  await call('training (new)', (s) => s.b.training());
  await call('training stage (skip the assessment)', (s) => s.b.trainingStage({ stage: 'assessment', action: 'skip' }));
  await call('training stage (no such stage)', (s) => s.b.trainingStage({ stage: 'lunch', action: 'skip' }));
  // the five-stage path: the tour first, then the snippets (docs/web/api.md, "Training stages")
  await call('training stage (skip a stage not open yet)', (s) => s.b.trainingStage({ stage: 'guided', action: 'skip' }));
  await call('training stage (done of a stage that saves)', (s) => s.b.trainingStage({ stage: 'practice', action: 'done' }));
  await call('training stage (finish the tour)', (s) => s.b.trainingStage({ stage: 'tour', action: 'done' }));
  await call('training stage (finish the tour again)', (s) => s.b.trainingStage({ stage: 'tour', action: 'done' }));
  await call('training stage (skip the tour, finished)', (s) => s.b.trainingStage({ stage: 'tour', action: 'skip' }));
  await call('training snippets', (s) => s.b.trainingSnippets());
  await call('training stage (skip the snippets)', (s) => s.b.trainingStage({ stage: 'snippets', action: 'skip' }));
  await call('training stage (skip the snippets again)', (s) => s.b.trainingStage({ stage: 'snippets', action: 'skip' }));
  await call('training stage (resume the snippets)', (s) => s.b.trainingStage({ stage: 'snippets', action: 'resume' }));
  await call('training stage (finish the snippets)', (s) => s.b.trainingStage({ stage: 'snippets', action: 'done' }));
  await call('training (after the first two stages)', (s) => s.b.training());
  await call('assignments (trainee)', (s) => s.b.assignments());
  await call('match practice before the guided recordings', async (s) => s.b.match(await matchBody(r3)));
  for (const [gi, g] of TRAINING_SET.guided.entries()) {
    const truth = truthAnnotations(SPECS[RIDS.indexOf(g.rid)]);
    const tag = `guided ${gi + 1}`;
    await call(`match (${tag})`, async (s) => s.b.match(await matchBody(g.rid)));
    await call(`${tag} open`, (s) => s.b.guided(g.rid));
    await call(`${tag} check (nothing marked)`, (s) => s.b.guidedCheck(g.rid, { step: 1, annotations: [] }));
    await call(`${tag} check (wrong step)`, (s) => s.b.guidedCheck(g.rid, { step: 2, annotations: [] }));
    const mine = [];
    for (const [i, t] of truth.entries()) {
      const step = i + 1;
      if (i === 0) {
        // late, and on the wrong type first, then right
        const late = ann(hex(0x100 + i), t.label === 'EMG-artifact' ? 'Chewing-artifact' : 'EMG-artifact', t.onset_sample + 60, t.duration_samples, t.channels);
        await call(`${tag} check step ${step} (late, wrong type)`, (s) => s.b.guidedCheck(g.rid, { step, annotations: [...mine, late] }));
        await call(`${tag} continue step ${step} (not matched)`, (s) => s.b.guidedContinue(g.rid, { step }));
      }
      if (i === 1) {
        await call(`${tag} show me step ${step}`, (s) => s.b.guidedShowMe(g.rid, { step, annotations: mine }));
      }
      mine.push(ann(hex(0x200 + 16 * gi + i), t.label, t.onset_sample, t.duration_samples, t.channels));
      await call(`${tag} check step ${step}`, (s) => s.b.guidedCheck(g.rid, { step, annotations: [...mine] }));
      await call(`${tag} continue step ${step}`, (s) => s.b.guidedContinue(g.rid, { step, paused_s: 0 }));
    }
    await call(`${tag} check (complete)`, (s) => s.b.guidedCheck(g.rid, { step: truth.length + 1, annotations: [...mine] }));
    await call(`${tag} check (complete, an extra)`, (s) => s.b.guidedCheck(g.rid, { step: truth.length + 1, annotations: [...mine, ann(hex(0x3ff), 'EMG-artifact', 100, 50)] }));
    await call(`${tag} open (complete)`, (s) => s.b.guided(g.rid));
    await call(`${tag} submit`, (s) => s.b.submit({ recording_id: g.rid, mode: 'guided', context_id: TRAINING_SET.set_id, annotations: [...mine], session: { elapsed_s: 100 }, sha256: s.mem.sha[RIDS.indexOf(g.rid)] }));
    await call(`training (after ${tag})`, (s) => s.b.training());
  }
  const [pr] = TRAINING_SET.practice;
  const ptruth = truthAnnotations(SPECS[RIDS.indexOf(pr)]);
  await call('match (practice)', async (s) => s.b.match(await matchBody(pr)));
  const half = ptruth.slice(0, 3).map((t, i) => ann(hex(0x400 + i), i === 2 ? 'EMG-artifact' : t.label, t.onset_sample, t.duration_samples, t.channels));
  await call('practice submit (not passed)', (s) => s.b.submit({ recording_id: pr, mode: 'practice', context_id: TRAINING_SET.set_id, annotations: half, session: { elapsed_s: 200 }, sha256: s.mem.sha[RIDS.indexOf(pr)] }));
  await call('training (practice not passed)', (s) => s.b.training());
  await call('assignments (practice again)', (s) => s.b.assignments());
  await call('match (practice again)', async (s) => s.b.match(await matchBody(pr)));
  const all = ptruth.map((t, i) => ann(hex(0x500 + i), t.label, t.onset_sample, t.duration_samples, t.channels));
  await call('practice submit (passed)', (s) => s.b.submit({ recording_id: pr, mode: 'practice', context_id: TRAINING_SET.set_id, annotations: all, session: { elapsed_s: 150 }, sha256: s.mem.sha[RIDS.indexOf(pr)] }));
  await call('training (complete)', (s) => s.b.training());
  await call('me (trainee, complete)', (s) => s.b.me());
  await call('match (practice, passed)', async (s) => s.b.match(await matchBody(pr)));
  await call('logout', (s) => s.b.logout());

  await call('login', (s) => s.b.login('ADMIN', s.password));
  await call('admin progress (after training)', (s) => s.b.admin('progress', {}));
  await call('admin training_gate_get', (s) => s.b.admin('training_gate_get', { annotator_id: 't01' }));
  await call('admin training_gate_get (not a trainee)', (s) => s.b.admin('training_gate_get', { annotator_id: 'A01' }));
  await call('admin training_reopen (before an assessment)', (s) => s.b.admin('training_reopen', { annotator_id: 'T01' }));
  await call('admin training_reopen (not a trainee)', (s) => s.b.admin('training_reopen', { annotator_id: 'A01' }));
  await call('admin training_assessment_set (the same set)', (s) => s.b.admin('training_assessment_set', { annotator_id: 'T01', set_id: QUIZ.set_id }));
  await call('admin snippets_list', (s) => s.b.admin('snippets_list', { set_id: QUIZ.set_id }));
  const snippet = { set_id: QUIZ.set_id, recording_id: RIDS[1], start_s: 14, end_s: 17, label: 'Chewing-artifact', explanation: 'Rhythmic bursts on T7 and T8', channels: ['T7', 'T8'], snippet_id: 'chew' };
  await call('admin snippet_add', (s) => s.b.admin('snippet_add', snippet));
  await call('admin snippet_add (sent again)', (s) => s.b.admin('snippet_add', snippet));
  await call('admin snippet_add (a practice recording)', (s) => s.b.admin('snippet_add', { ...snippet, recording_id: RIDS[2] }));
  await call('admin snippet_add (backwards)', (s) => s.b.admin('snippet_add', { ...snippet, end_s: 13 }));
  await call('admin snippet_add (no ID)', (s) => s.b.admin('snippet_add', { ...snippet, snippet_id: null, label: 'EMG-artifact', channels: [] }));
  await call('admin snippets_list (after)', (s) => s.b.admin('snippets_list', { set_id: QUIZ.set_id }));
  await call('admin snippet_remove', (s) => s.b.admin('snippet_remove', { set_id: QUIZ.set_id, snippet_id: 's01' }));
  await call('admin snippet_remove (gone)', (s) => s.b.admin('snippet_remove', { set_id: QUIZ.set_id, snippet_id: 's01' }));
  await call('admin snippet_remove (a guided one)', (s) => s.b.admin('snippet_remove', { set_id: QUIZ.set_id, snippet_id: 'g-x' }));
  await call('admin expert snippets_list', (s) => s.b.expert('snippets_list', { set_id: QUIZ.set_id }));
  await call('logout', (s) => s.b.logout());
  await call('login', (s) => s.b.login('T01', s.password));
  await call('training snippets (with the team\'s own)', (s) => s.b.trainingSnippets());
  await call('admin stats (all work)', (s) => s.b.admin('stats', { work: 'all' }));
  await call('admin overview (after training)', (s) => s.b.admin('overview', {}));
}

const outcome = async (fn) => {
  try {
    return { ok: await fn() };
  } catch (e) {
    if (!e || e.status === undefined) throw e;
    return { error: { status: e.status, code: e.code, message: e.message } };
  }
};

test('the comparison finds a changed value, a missing key and another type, and keeps to the allowed differences', () => {
  const server = { status: 'matched', n: 2, saved_at: 'a', manifest: { display: { warnings: ['x'] }, ch_names: ['Fp1'] }, extra: 1 };
  assert.deepEqual(differences('match', server, { ...server }), []);
  assert.deepEqual(differences('match', server, { ...server, saved_at: 'b', manifest: { display: { warnings: [] }, ch_names: ['Fp1'] } }), []);
  const found = differences('match', server, { status: 'done', n: '2', saved_at: 3, manifest: { ch_names: ['Fp1', 'Fp2'] }, more: true });
  assert.deepEqual(found, [
    'match: status is "matched" on the server, "done" in the sandbox',
    'match: n is 2 on the server, "2" in the sandbox',
    'match: saved_at is string on the server, number in the sandbox',
    'match: manifest.display is only on the server ({"warnings":["x"]})',
    'match: manifest.ch_names has 1 items on the server, 2 in the sandbox',
    'match: extra is only on the server (1)',
    'match: more is only in the sandbox (true)',
  ]);
  assert.deepEqual(differences('quiz get', { items: [{ item_id: 'b' }, { item_id: 'a' }] }, { items: [{ item_id: 'a' }, { item_id: 'b' }] }), []);
  assert.equal(differences('me', { items: [{ item_id: 'b' }, { item_id: 'a' }] }, { items: [{ item_id: 'a' }, { item_id: 'b' }] }).length, 2);
});

test('the sandbox answers the visitor\'s calls as the study server does', { skip: !PYTHON && 'no Python with ElectroTag\'s server', timeout: 600000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-parity-'));
  writeSandbox(dir);
  const server = await startServer(dir);
  const realFetch = globalThis.fetch;
  globalThis.fetch = server.fetch;
  try {
    const sha = await Promise.all(RIDS.map(async (rid) => (await exampleRecording(rid).fingerprint()).hex));
    const py = { b: new HttpBackend('http://parity.invalid'), password: PY_PASSWORD, mem: { sha } };
    const js = { b: new DemoBackend({ storage: memory(), tokens: memory() }), password: 'demo', mem: { sha } };
    const found = [];
    const seen = new Map();
    let both = 0;
    await script(async (name, fn) => {
      const n = (seen.get(name) || 0) + 1;
      seen.set(name, n);
      const label = n > 1 ? `${name} #${n}` : name;
      const a = await outcome(() => fn(py));
      const b = await outcome(() => fn(js));
      if (a.ok !== undefined && b.ok !== undefined) { both += 1; differences(label, a.ok, b.ok, '', found); }
      else if (a.error && b.error) differences(label, a.error, b.error, 'error', found);
      else found.push(`${label}: ${a.error ? `the server refuses (${a.error.status} ${a.error.code}: ${a.error.message})` : 'the server answers'}, ${b.error ? `the sandbox refuses (${b.error.status} ${b.error.code}: ${b.error.message})` : 'the sandbox answers'}`);
    });
    // the script ran to its end, with answers (not only refusals) from both
    assert.ok(seen.size > 120 && both > 100, `${seen.size} calls, ${both} answered by both`);
    if (process.env.ELECTROTAG_PARITY_DUMP) fs.writeFileSync(process.env.ELECTROTAG_PARITY_DUMP, found.join('\n'));
    assert.deepEqual(found, [], `${found.length} differences between the sandbox and the study server:\n${found.slice(0, 80).join('\n')}`);
  } finally {
    globalThis.fetch = realFetch;
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
