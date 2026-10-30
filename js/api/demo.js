// The sandbox: the Backend interface of http.js, entirely in the browser.
//
// A stand-in for the study server (electrotag/web/service.py, coach.py, quiz.py, games.py) for the
// public sandbox, which has no server: three demo accounts (A01 annotates, T01 follows the training
// programme, ADMIN runs the study in the admin area; password "demo"), three built-in example
// recordings with simulated artifacts (synthetic.js), drafts and results kept in this browser (and
// downloadable), the guided training rules (training/rules.js) and the practice scoring
// (training/scoring.js). Its answers follow docs/web/api.md as the server gives them, which
// web_tests/unit/api_contract_parity.test.mjs checks call by call against the real service; the
// few places where they differ for good reason are listed there. The admin area's operations are in
// demo_admin.js, problem reports and reviews in demo_feedback.js.

import {
  CATALOGUE, CATALOGUE_NAME, DEFAULT_QUICK_LABELS,
} from './demo_catalogue.js';
import {
  channelType, demoSpecs, exampleNote, makeSyntheticRecording, syntheticEdfBytes, truthAnnotations,
} from '../eeg/synthetic.js';
import { ApiError } from './http.js';
import { DEMO_NOTICE } from './notice.js';
import { DemoAdmin } from './demo_admin.js';
import { DemoFeedback } from './demo_feedback.js';
import { loadPart } from '../lazy.js';
import { primaryRole, rolesOf } from '../admin/model.js';

export { DEMO_NOTICE };
import * as rules from '../training/rules.js';
import { DEFAULT_PASS, practiceDetail, practiceFeedback, practiceVerdict, retryRecording, scoreSentence } from '../training/scoring.js';
import { STAGE_TITLES, browserStep, correctionsDetail, isFinished, isUnlocked, stageMarks, stagePolicy, stageStates } from '../training/stages.js';
import { local, newId, nowLocalIso, session } from '../util.js';
import { sha256Hex } from '../eeg/sha256.js';
import { coveredS, fromDraft } from '../viewer/coverage.js';
import { ADJECTIVES, ANIMALS } from '../games/words.js';
import { isConfidence, noteProblem } from '../annotate/confidence.js';

const STATE_KEY = 'electrotag.demo.v2';
/** The admin operations of the training path, which come with demo_training_stages.js. */
/** The sandbox's calls that wait for the sign-up questionnaire (questionnaire.py GATED_OPERATIONS), and the admin
 *  operations that come with its part (demo_questionnaire.js, loaded at its first use). */
const QUESTIONNAIRE_GATED = ['match', 'putDraft', 'submit', 'training', 'guided', 'guidedCheck', 'guidedContinue', 'guidedShowMe',
  'trainingStage', 'trainingSnippets', 'quiz', 'expert'];
const QUESTIONNAIRE_ADMIN_OPS = ['questionnaire_get', 'questionnaire_summary', 'contacts_download', 'users_list'];
const TRAINING_ADMIN_OPS = ['snippets_list', 'snippet_add', 'snippet_remove', 'training_gate_get', 'training_reopen', 'training_assessment_set'];
const TOKEN_KEY = 'electrotag.demo.token';
export const DEMO_PASSWORD = 'demo';
const FIND_WINDOW_S = 10;
const MAX_ELAPSED_S = 7 * 24 * 3600;
const SHA_RE = /^[0-9a-f]{64}$/;
const ANN_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;

const SPECS = demoSpecs();
const SPEC_BY_ID = new Map(SPECS.map((s) => [s.id, s]));
const TITLES = {
  'demo-01': 'Example 1: blinks, muscle and a pop',
  'demo-02': 'Example 2: chewing, heartbeat and slow eye movements',
  'demo-03': 'Example 3: a longer recording with a gap at the end',
};

export function recordingIdOf(spec) {
  const sub = spec.stem.split('_')[0];
  return `${sub}/eeg/${spec.stem}_eeg.edf`;
}

const RID = new Map(SPECS.map((s) => [recordingIdOf(s), s]));

export const TRAINING_SET = Object.freeze({
  set_id: 'example',
  name: 'Demonstration training set',
  guided: [{ rid: recordingIdOf(SPEC_BY_ID.get('demo-01')), guidance: 'show' },
    { rid: recordingIdOf(SPEC_BY_ID.get('demo-02')), guidance: 'find' }],
  practice: [recordingIdOf(SPEC_BY_ID.get('demo-03'))],
  pass: DEFAULT_PASS,
});


/** The answer for a segment without an artifact (electrotag.training.reference.NONE_OPTION). */
export const QUIZ_NONE_OPTION = 'No artifact / none of these';

/** The sandbox's short-segment quiz, on the training set: segments of the first two examples, with feedback after each answer. */
export const QUIZ = Object.freeze({
  set_id: TRAINING_SET.set_id,
  feedback: 'immediate',
  items: [
    ['q01', 'demo-01', 9.2, 10.8, 'EMG-artifact', [],
      'Fast, irregular activity on F7, F8, T7 and T8 that starts and stops abruptly: muscle activity.'],
    ['q02', 'demo-01', 3.0, 3.4, 'Eye-blink-artifact', ['Eye-artifact'],
      'A large, smooth deflection of about 0.4 s on Fp1, Fp2 and VEOG, weaker on F3, Fz and F4: the eyes closing and opening.'],
    ['q03', 'demo-02', 5.0, 8.0, 'Chewing-artifact', [],
      'Bursts of fast activity on T7 and T8 that repeat about one and a half times a second: chewing.'],
    ['q04', 'demo-02', 20.0, 25.0, 'ECG-artifact', ['Pulse-artifact'],
      'Sharp spikes on T7, P7 and O1 about every 0.8 s, in time with the heartbeat.'],
    ['q05', 'demo-01', 14.0, 14.5, 'Electrode-pops-artifact', [],
      'A sudden jump on C3 alone that dies away within a fraction of a second: an electrode pop.'],
    ['q06', 'demo-02', 40.0, 44.0, 'Slow-eye-movement-artifact', ['Eye-movement-artifact', 'Eye-artifact'],
      'Slow waves of opposite sign on the two sides of the head over four seconds, largest on HEOG and at F7 and F8, smaller at Fp1 and Fp2: a slow eye movement.'],
    ['q07', 'demo-01', 50.0, 52.0, QUIZ_NONE_OPTION, [],
      'Only the background EEG: there is no artifact in this segment.'],
  ].map(([item_id, spec, start_s, end_s, correct_label, accepted_labels, explanation]) => Object.freeze({
    item_id, recording_id: recordingIdOf(SPEC_BY_ID.get(spec)), start_s, end_s, correct_label, accepted_labels, explanation, context_s: 2.0,
  })),
});

/** The items in the annotator's own order, the same at every visit (shuffled the sandbox's way; the server uses Python's random). */
export function quizOrder(items, annotatorId, setId) {
  const order = [...items].sort((a, b) => (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0));
  const hex = sha256Hex(new TextEncoder().encode(`${setId}:${annotatorId}`));
  let a = parseInt(hex.slice(0, 8), 16) >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** QuizSession.score(): the counts, by correct answer, and what was answered instead. */
export function quizScore(items, answers) {
  const byItem = new Map(items.map((it) => [it.item_id, it]));
  const list = Object.entries(answers).map(([id, a]) => ({ ...a, correct_label: byItem.get(id) ? byItem.get(id).correct_label : a.correct_label }));
  const n = list.length;
  const correct = list.filter((a) => a.correct).length;
  const byCategory = {};
  const confusion = {};
  for (const a of list) {
    const c = byCategory[a.correct_label] || (byCategory[a.correct_label] = { items: 0, correct: 0 });
    c.items += 1;
    c.correct += a.correct ? 1 : 0;
    const row = confusion[a.correct_label] || (confusion[a.correct_label] = {});
    row[a.label] = (row[a.label] || 0) + 1;
  }
  return { n_items: items.length, n_answered: n, n_correct: correct, proportion_correct: n ? correct / n : null, by_category: byCategory, confusion };
}

// The built-in recordings are made once per page and shared with the viewer, so their
// fingerprints are computed only once.
const recordings = new Map();
export function exampleRecording(recordingId) {
  const spec = RID.get(recordingId);
  if (!spec) throw new ApiError(404, 'not_found', 'There is no example recording with that name.');
  if (!recordings.has(spec.id)) recordings.set(spec.id, makeSyntheticRecording(spec));
  return recordings.get(spec.id);
}

function fileNameOf(spec) { return `${spec.stem}_eeg.edf`; }

/** Seconds of a recording a draft's viewed stretches cover. */
function viewedSeconds(viewed) { return Math.round(coveredS(fromDraft(viewed, Infinity)) * 100) / 100; }

const LABELS = new Map(CATALOGUE.labels.map((l) => [l.label, l]));

function emptyState() {
  return { version: 2, drafts: {}, done: {}, submissions: [], guided: {}, progress: {}, quiz: {}, records: {}, problems: {}, unusable: {}, reviews: [] };
}

/** A number of seconds for the person ("12 s", "2.5 min"), as coach.py minutes_text. */
const minutesText = (s) => (s < 60 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`);

/** An annotation as the server returns saved ones (service.py annotation_dict). */
const annotationOut = (a) => ({ annotation_id: a.annotation_id, label: a.label, onset_sample: a.onset_sample, duration_samples: a.duration_samples,
  channels: [...(a.channels || [])], created_at: a.created_at, modified_at: a.modified_at, confidence: a.confidence ?? null, note: a.note || '' });

// ------------------------------------------------------------ game elements
// As electrotag/web/games.py: the share of a recording seen from which it counts as viewed in full,
// the fewest people a leaderboard is shown for, how many rows it shows, and the largest weekly goal.
const VIEWED_IN_FULL = 0.99;
const MIN_PEOPLE = 3;
const TOP = 10;
const MAX_GOAL = 200;

function viewedFraction(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? Math.round(v * 10000) / 10000 : null;
}

/** A pseudonym from a hash of the study's secret and the annotator ID (the server keys an HMAC with its secret). */
export function demoPseudonym(secret, annotatorId, salt = 0) {
  const hex = sha256Hex(new TextEncoder().encode(`${secret}:${String(annotatorId).toUpperCase()}:${salt}`));
  const n = parseInt(hex.slice(0, 12), 16);
  return `${ADJECTIVES[n % ADJECTIVES.length]} ${ANIMALS[Math.floor(n / ADJECTIVES.length) % ANIMALS.length]}`;
}

/**
 * The leaderboard of games.py's Games._leaderboard: people with at least one recording, without those
 * who chose to be hidden, ranked by count (ties share a rank), shown only when MIN_PEOPLE are on it.
 * `team` holds ids, counts, hidden and names; only pseudonyms leave this function.
 */
export function leaderboardOf(aid, team, { hiddenMe = false, byFull = false } = {}) {
  const counts = byFull ? team.full : team.completed;
  const on = team.ids.filter((a) => (counts[a] || 0) > 0 && !team.hidden.has(a) && a !== aid);
  if (!hiddenMe && (counts[aid] || 0) > 0) on.push(aid);
  on.sort((a, b) => (counts[b] - counts[a]) || (team.names[a] < team.names[b] ? -1 : team.names[a] > team.names[b] ? 1 : 0));
  const ranks = {};
  on.forEach((a, i) => { ranks[a] = i && counts[on[i - 1]] === counts[a] ? ranks[on[i - 1]] : i + 1; });
  const enough = on.length >= MIN_PEOPLE;
  return {
    ranked_by: byFull ? 'viewed_in_full' : 'completed',
    rows: enough ? on.slice(0, TOP).map((a) => ({ rank: ranks[a], name: team.names[a], count: counts[a], you: a === aid })) : [],
    you: { name: team.names[aid] || '', hidden: hiddenMe, count: counts[aid] || 0, rank: enough ? ranks[aid] ?? null : null },
    people: on.length, min_people: MIN_PEOPLE,
  };
}

export class DemoBackend {
  constructor({ storage = local, tokens = session } = {}) {
    this.kind = 'demo';
    this.signInWith = 'id';
    this.eventFlushMs = 4000;
    this.server = '';
    this.storage = storage;
    this.tokens = tokens;
    this.health = { ok: true, version: 'web', study: 'Demonstration', demo: true };
    this.state = { ...emptyState(), ...(storage.get(STATE_KEY, null) || {}) };
    this._admin = new DemoAdmin(this);
    this.feedback = new DemoFeedback(this); // problem reports and reviews (demo_feedback.js)
    this.experts = null; // the expert area's operations (demo_expert.js), loaded at the first expert call
    // The sign-up questionnaire (demo_questionnaire.js): work waits until it is answered, as on a study server.
    this.questionnaires = null;
    for (const name of QUESTIONNAIRE_GATED) {
      const call = this[name].bind(this);
      this[name] = async (...args) => { (await this._questionnairePart()).require(); return call(...args); };
    }
    const saved = tokens.get(TOKEN_KEY, null);
    const user = saved ? this._admin.user(saved.annotator_id) : null;
    this.annotatorId = user && user.status === 'active' ? user.annotator_id : null;
    this.visits = new Map();
    // Another tab of the sandbox (a person opening their invitation link, say) changed the state
    // kept in this browser: carry on from it, so that this tab does not write an older copy back.
    if (storage === local && typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('storage', (e) => {
        if (e.key !== STATE_KEY || !e.newValue) return;
        try { this.state = { ...emptyState(), ...JSON.parse(e.newValue) }; } catch { /* kept as it was */ }
      });
    }
  }

  get isDemo() { return true; }

  get signedIn() { return Boolean(this.annotatorId); }

  _save() { this.storage.set(STATE_KEY, this.state); }

  _aid() {
    if (!this.annotatorId) throw new ApiError(401, 'not_signed_in', 'Please sign in again.');
    return this.annotatorId;
  }

  _account() { return this._admin.user(this._aid()); }

  /** True when the account follows the sandbox's training programme. */
  _inProgramme(aid) { return this._admin.programmeOf(aid) === TRAINING_SET.set_id; }

  // ------------------------------------------------------------------ signing in
  async getHealth() { return this.health; }

  async login(annotatorId, password) {
    const aid = String(annotatorId || '').trim().toUpperCase();
    const user = this._admin.user(aid);
    if (!user || !this._admin.passwordOk(aid, password)) {
      throw new ApiError(401, 'bad_credentials',
        `The ID or password is not right. In the demonstration, sign in as A01, T01, E01 or ADMIN with the password ${DEMO_PASSWORD}.`);
    }
    if (user.status !== 'active') throw new ApiError(403, 'account_disabled', 'This account has been switched off. Ask the study team.');
    return this._signInAs(user);
  }

  _signInAs(user) {
    const aid = user.annotator_id;
    this.annotatorId = aid;
    this._admin.touch(aid);
    const token = `demo-${newId()}`;
    this.tokens.set(TOKEN_KEY, { annotator_id: aid, token });
    const roles = rolesOf(user);
    return { token, expires_in_s: 43200, annotator_id: aid, display_name: user.display_name, role: primaryRole(roles), roles };
  }

  /** The sandbox takes private invitation links (?invite=<token>) made in its admin area, in this browser. */
  get acceptsInvites() { return true; }

  /** POST /invite/check: whose invitation a link's token is. */
  async inviteCheck(token) { return this._admin.inviteCheck(token); }

  /** POST /invite/accept: choose the password with the invitation and sign in. */
  async inviteAccept(token, password) { return this._signInAs(this._admin.inviteAccept(token, password)); }

  async logout() {
    this.annotatorId = null;
    this.tokens.remove(TOKEN_KEY);
    return {};
  }

  async me() {
    const aid = this._aid();
    const acc = this._account();
    if (!acc) throw new ApiError(401, 'not_signed_in', 'Please sign in again.');
    const quiz = this._quizState(aid, false);
    return {
      annotator_id: aid, display_name: acc.display_name, role: primaryRole(rolesOf(acc)), roles: rolesOf(acc),
      study: this._admin.studyBlock(),
      catalogue: CATALOGUE,
      programme: this._inProgramme(aid) ? { set_id: TRAINING_SET.set_id, name: this._exampleSet().name, complete: !this._nextStep(aid).stage } : null,
      training_gate: this._gate(),
      questionnaire: (await this._questionnairePart()).status(aid),
      quizzes: this._quizAllowed(aid) ? [{ set_id: QUIZ.set_id, name: this._exampleSet().name, n_items: QUIZ.items.length,
        n_answered: Object.keys(quiz.answers).length, finished: Boolean(quiz.finished), feedback: QUIZ.feedback }] : [],
    };
  }

  // -------------------------------------------------------------------- quiz
  _quizState(aid, create = true) {
    const key = `${aid}|${QUIZ.set_id}`;
    const fresh = { answers: {}, finished: false, score: null, started_at: nowLocalIso() };
    if (!create) return this.state.quiz[key] || fresh;
    if (!this.state.quiz[key]) this.state.quiz[key] = fresh;
    return this.state.quiz[key];
  }

  /** A set's quiz is for the annotators allowed to use the set, everyone when it names nobody (quiz.py allowed). */
  _quizAllowed(aid) {
    const names = this._exampleSet().allowed_annotators || [];
    return !names.length || names.includes(aid);
  }

  _quizOptions() { return [...CATALOGUE.labels.map((l) => l.label), QUIZ_NONE_OPTION]; }

  // The study server's rules (electrotag/web/quiz.py): the same answer sent again is kept once,
  // another label for an answered segment is 409 already_answered (with the kept label), and the
  // correct answers are given only when the annotator may know them.
  async quiz(setId, body = {}) {
    const aid = this._aid();
    const action = body && body.action;
    if (!['get', 'answer', 'finish'].includes(action)) throw new ApiError(400, 'bad_request', 'action must be one of get, answer, finish');
    if (setId !== QUIZ.set_id) throw new ApiError(404, 'no_reference_set', `There is no reference set ${setId} in this study`);
    if (!this._quizAllowed(aid)) throw new ApiError(403, 'not_allowed', 'This quiz is not one of yours. Ask your study administrator.');
    const st = this._quizState(aid);
    const immediate = QUIZ.feedback === 'immediate';
    const reveal = immediate || st.finished;
    const byId = new Map(QUIZ.items.map((it) => [it.item_id, it]));
    if (action === 'get') {
      this._save();
      const recordings = {};
      for (const it of QUIZ.items) {
        if (!recordings[it.recording_id]) recordings[it.recording_id] = await this._publicManifest(it.recording_id);
      }
      const options = this._quizOptions();
      return {
        set_id: QUIZ.set_id, name: this._exampleSet().name, feedback: QUIZ.feedback, finished: Boolean(st.finished),
        items: quizOrder(QUIZ.items, aid, QUIZ.set_id).map((it) => ({
          item_id: it.item_id, recording_id: it.recording_id, file_name: fileNameOf(RID.get(it.recording_id)), start_s: it.start_s,
          end_s: it.end_s, context_s: it.context_s, options: [...options],
        })),
        answered: Object.fromEntries(Object.entries(st.answers).map(([id, a]) => [id, reveal && byId.has(id)
          ? { label: a.label, correct: a.correct, correct_label: byId.get(id).correct_label, explanation: byId.get(id).explanation || null }
          : { label: a.label, correct: null }])),
        score: st.finished ? st.score : null, n_items: QUIZ.items.length,
        recordings,
        demo_notice: DEMO_NOTICE,
      };
    }
    if (action === 'answer') {
      const item = byId.get(body.item_id);
      if (!item) throw new ApiError(404, 'unknown_item', 'This quiz has no such segment');
      if (typeof body.label !== 'string' || !this._quizOptions().includes(body.label)) {
        throw new ApiError(400, 'bad_label', "The answer must be one of the quiz's artifact types");
      }
      const rt = body.response_time_s;
      if (rt !== undefined && rt !== null && (typeof rt !== 'number' || !Number.isFinite(rt) || rt < 0 || rt > 86400)) {
        throw new ApiError(400, 'bad_request', 'response_time_s must be a number of seconds');
      }
      if (st.finished) throw new ApiError(409, 'finished', 'You have already finished this quiz');
      const prev = st.answers[item.item_id];
      if (prev && prev.label !== body.label) {
        throw new ApiError(409, 'already_answered', 'You have already answered this segment', { error: 'already_answered', label: prev.label });
      }
      if (!prev) {
        const correct = body.label === item.correct_label || item.accepted_labels.includes(body.label);
        st.answers[item.item_id] = { label: body.label, correct, response_time_s: rt === undefined || rt === null ? null : Math.round(rt * 1000) / 1000,
          answered_at: nowLocalIso(), index: Object.keys(st.answers).length + 1 };
        this._save();
      }
      const kept = st.answers[item.item_id];
      const counts = { n_answered: Object.keys(st.answers).length, n_items: QUIZ.items.length };
      return immediate ? { correct: kept.correct, correct_label: item.correct_label, explanation: item.explanation || null, ...counts }
        : { correct: null, correct_label: null, explanation: null, ...counts };
    }
    // finish: also before every segment is answered (an incomplete result); finishing again gives the same score
    if (!st.finished) {
      st.finished = true;
      st.finished_at = nowLocalIso();
      st.score = quizScore(QUIZ.items, st.answers);
      this._save();
    }
    return { score: st.score };
  }

  // ------------------------------------------------------------ work items
  _key(aid, rid, mode, ctx) { return `${aid}|${rid}|${mode}|${mode === 'standard' ? '' : ctx || ''}`; }

  /** What saving and listing need of a recording: a built-in example or one added in the admin area. */
  _recordingInfo(rid) {
    const spec = RID.get(rid);
    if (spec) {
      return { rid, builtin: true, spec, file_name: fileNameOf(spec), format: 'edf', sfreq: spec.sfreq, n_samples: spec.nSamples,
        ch_names: [...spec.channels], size_bytes: exampleRecording(rid).sizeBytes, stem: `${spec.stem}_eeg` };
    }
    const r = this._admin.registered(rid);
    if (!r) return null;
    const m = r.manifest;
    return { rid, builtin: false, record: r, file_name: m.file_name, format: m.format, sfreq: Number(m.timing.sfreq),
      n_samples: Number(m.timing.n_samples), ch_names: [...m.ch_names], size_bytes: Number(r.size_bytes),
      stem: String(m.file_name).replace(/\.[^.]+$/, '') };
  }

  /** The saved attempts of one assignment, oldest first. */
  _attempts(key) {
    return this.state.submissions.filter((s) => s.key === key).sort((x, y) => x.attempt - y.attempt);
  }

  /** What the history shows of a saved recording (games.py saved_summary), or null. */
  _savedSummary(key) {
    const list = this._attempts(key);
    if (!list.length) return null;
    const last = list[list.length - 1];
    const times = list.map((s) => Number(s.session && s.session.elapsed_s)).filter(Number.isFinite);
    const elapsed = Number(last.session && last.session.elapsed_s);
    return { version: last.attempt, saved_at: last.saved_at, first_saved_at: list[0].saved_at, n_annotations: last.annotations.length,
      elapsed_s: Number.isFinite(elapsed) ? elapsed : null,
      total_elapsed_s: times.length ? Math.round(times.reduce((x, y) => x + y, 0) * 1000) / 1000 : null };
  }

  /**
   * The recordings a person may open now, as service.py work_items: the training programme's
   * recordings of its unlocked stages first, then the study's assignments, each with its status.
   */
  _workItems(aid) {
    const items = [];
    const seen = new Set();
    const add = (rid, mode, ctx, position, source, repeat = false) => {
      const key = this._key(aid, rid, mode, ctx);
      const info = this._recordingInfo(rid);
      if (seen.has(key) || !info) return;
      seen.add(key);
      let status = 'todo';
      if (this.state.done[key] && !repeat) status = 'done';
      else if (this.feedback.isUnusable(key)) status = 'unusable';
      else if (this.state.drafts[key] || (mode === 'guided' && this.state.guided[`${aid}|${rid}`])) status = 'in_progress';
      const saved = this._savedSummary(key);
      items.push({ rid, mode, context_id: mode === 'standard' ? '' : ctx, key, info, status, position, source, repeat, saved,
        revising: Boolean(saved && status === 'done' && this.state.drafts[key]) });
    };
    if (this._inProgramme(aid)) {
      const stages = this._stages(aid);
      const nxt = this._nextStep(aid, stages);
      const lists = { guided: TRAINING_SET.guided.map((g) => g.rid), practice: TRAINING_SET.practice, assessment: [] };
      for (const s of stages) {
        if (!lists[s.key] || !isUnlocked(s) || s.carried) continue;
        for (const rid of lists[s.key]) add(rid, s.key, TRAINING_SET.set_id, 0, 'programme', Boolean(nxt.repeat && nxt.stage === s.key && nxt.recording_id === rid));
      }
    }
    this._admin.standardAssignments(aid).forEach((a, i) => add(a.rid, a.mode, a.context_id, i + 1, 'assignment'));
    return items;
  }

  /** The item to do next (service.py _next): the programme's next step, then unfinished work, then the assignment order. */
  _nextItem(aid, items) {
    if (this._inProgramme(aid)) {
      const nxt = this._nextStep(aid);
      if (nxt.stage === 'tour' || nxt.stage === 'snippets') return null;
      const mine = items.filter((i) => i.source === 'programme' && i.mode === nxt.stage);
      const hit = nxt.stage ? mine.find((i) => i.rid === nxt.recording_id) : null;
      if (hit) return hit;
    }
    const open = items.filter((i) => !['done', 'unusable'].includes(i.status) && i.source === 'assignment');
    return open.find((i) => i.status === 'in_progress') || open.sort((a, b) => a.position - b.position)[0] || null;
  }

  _revisionsAllowed() { return this._admin.s.settings.annotation.allow_revisions !== false; }

  _canRevise(i) { return i.status === 'done' && i.mode === 'standard' && Boolean(i.saved) && this._revisionsAllowed(); }

  _draftSummary(i) {
    const d = this.state.drafts[i.key];
    if (!d) return null;
    return { elapsed_s: Number(d.elapsed_s) || 0, n_annotations: (d.annotations || []).length, viewed_s: viewedSeconds(d.viewed), saved_at: d.saved_at || null };
  }

  async assignments() {
    const aid = this._aid();
    const items = this._workItems(aid);
    const nxt = this._nextItem(aid, items);
    const out = {
      items: items.map((i) => {
        // As the completion register says of a finished recording: its time and annotations (the latest save).
        const last = i.status === 'done' ? this._attempts(i.key).pop() : null;
        return {
          recording_id: i.rid, file_name: i.info.file_name, format: i.info.format, mode: i.mode, context_id: i.context_id,
          status: i.status, duration_s: i.info.n_samples / i.info.sfreq, n_channels: i.info.ch_names.length,
          size_bytes: i.info.size_bytes, repeat: i.repeat, locked: i.status === 'locked' ? 'training_required' : null,
          elapsed_s: last ? Number((last.session || {}).elapsed_s) || 0 : null,
          n_annotations: last ? (last.annotations || []).length : null,
          completed_at: last ? last.saved_at : null,
          draft: i.status === 'in_progress' || i.revising ? this._draftSummary(i) : null,
          saved: i.saved ? { version: i.saved.version, first_saved_at: i.saved.first_saved_at, total_elapsed_s: i.saved.total_elapsed_s } : null,
          revising: i.revising,
          problem: this.feedback.problemOf(aid, i),
          handout: null,
        };
      }),
      due: [],
      next: nxt ? nxt.rid : null,
      next_item: nxt ? { recording_id: nxt.rid, mode: nxt.mode, context_id: nxt.context_id } : null,
    };
    const ho = (this._admin.s.library || {}).handouts; // hand-outs' titles and due dates (demo_library.js)
    return ho && Object.keys(ho).length ? (await this._admin._library()).decorate(aid, items, out) : out;
  }

  /** service.py find_item: one of the person's work items, or the error the server gives. */
  _findItem(aid, rid, mode, ctx) {
    if (typeof rid !== 'string' || !rid) throw new ApiError(400, 'bad_request', 'recording_id is missing');
    const m = mode || 'standard';
    if (!['standard', 'guided', 'practice', 'assessment'].includes(m)) throw new ApiError(400, 'bad_request', 'mode must be one of standard, guided, practice, assessment');
    const key = this._key(aid, rid, m, ctx);
    const item = this._workItems(aid).find((i) => i.key === key);
    if (item) return item;
    if (!this._recordingInfo(rid)) throw new ApiError(404, 'unknown_recording', `${rid} is not a registered recording of this study`);
    throw new ApiError(403, 'not_assigned', `${rid} is not one of your recordings at the moment`);
  }

  // ---------------------------------------------------------------- matching
  /** The Manifest of docs/web/api.md for a recording of the sandbox. */
  async _publicManifest(rid) {
    const info = this._recordingInfo(rid);
    if (!info.builtin) return this._admin.publicManifestOf(info.record);
    const spec = info.spec;
    const rec = exampleRecording(rid);
    const sf = spec.sfreq;
    const fp = await rec.fingerprint();
    return {
      recording_id: rid, file_name: info.file_name, format: 'edf',
      sfreq: sf, n_samples: spec.nSamples, duration_s: spec.nSamples / sf,
      ch_names: [...spec.channels], hidden_channels: [],
      channel_types: Object.fromEntries(spec.channels.map((c) => [c, channelType(c)])),
      bad_channels: [],
      original_events: spec.events.map((e) => ({ onset_sample: Math.round(e.onsetS * sf), duration_samples: 0, label: e.label })),
      gaps: spec.gaps.map((g) => [...g]),
      display: { scalings: { ...this._admin.s.settings.display.scalings }, warnings: [...rec.warnings] },
      fingerprint: { algorithm: 'sha256', role: 'eeg', hex: fp.hex, size_bytes: fp.sizeBytes },
    };
  }

  /** Every registered recording of the study and of its training set, with what matching needs of it. */
  async _registered() {
    const out = [];
    for (const r of this._admin.s.recordings) {
      const info = this._recordingInfo(r.recording_id);
      if (!info) continue;
      const sha = info.builtin ? (await exampleRecording(r.recording_id).fingerprint()).hex : String(r.sha256 || '').toLowerCase();
      out.push({ ...info, scope: r.scope, sha });
    }
    return out;
  }

  static _answer(status, message, fields = {}) {
    return { status, message, recording_id: null, mode: null, context_id: null, manifest: null, draft: null, differences: [], repeat: false,
      revision: null, saved: null, ...fields };
  }

  async match(body) {
    const aid = this._aid();
    const sha = String(body.sha256 || '').toLowerCase();
    if (!SHA_RE.test(sha)) throw new ApiError(400, 'bad_request', 'sha256 must be the 64-character hexadecimal checksum of the file');
    const size = body.size_bytes;
    if (!Number.isInteger(size) || size < 0) throw new ApiError(400, 'bad_request', 'size_bytes must be the size of the file in bytes');
    const items = this._workItems(aid);
    const nxt = this._nextItem(aid, items);
    const opts = { revise: body.revise === true, viewSaved: body.view_saved === true };
    const registered = await this._registered();
    const exact = registered.filter((r) => r.sha === sha && r.size_bytes === size);
    if (exact.length) return this._matchAnswer(aid, items, exact, 'matched', [], nxt, opts);
    const name = String(body.file_name || '').trim().toLowerCase();
    const chans = Array.isArray(body.ch_names) ? body.ch_names.map(String) : null;
    // One recording counts once, also when it is both a study recording and one of the training set's
    // (the server counts it twice and answers that the file cannot be told apart: reported, see
    // api_contract_parity.test.mjs).
    const candidates = name && chans ? [...new Map(registered.filter((r) => r.file_name.toLowerCase() === name && Math.abs(r.sfreq - Number(body.sfreq)) <= 1e-6
      && r.n_samples === Number(body.n_samples) && r.ch_names.every((c) => chans.includes(c))).map((r) => [r.rid, r])).values()] : [];
    if (candidates.length === 1) {
      const differences = ["The file's checksum differs from that of the study's copy, so its contents are not exactly the same (it may have been copied with changes, exported again or edited)."];
      if (size !== candidates[0].size_bytes) differences.push(`The file is ${size} bytes; the study's copy is ${candidates[0].size_bytes} bytes.`);
      return this._matchAnswer(aid, items, candidates, 'matched_metadata', differences, nxt, opts);
    }
    if (candidates.length > 1) {
      return DemoBackend._answer('unknown', 'This file looks like several recordings of the study and cannot be told apart from them. Open the exact file you were given, or ask your study administrator.');
    }
    return DemoBackend._answer('unknown', 'This file is not one of the recordings of this study. Check that you opened the file you were given (the name is shown in your list of recordings).');
  }

  async _matchAnswer(aid, items, found, status, differences, nxt, { revise, viewSaved }) {
    const rids = new Set(found.map((r) => r.rid));
    const mine = items.filter((i) => rids.has(i.rid));
    const rid = found[0].rid;
    if (!mine.length) {
      return DemoBackend._answer('not_assigned', `${rid} is a recording of this study, but it is not one of yours at the moment. Open one of the recordings in your list, or ask your study administrator.`, { recording_id: rid });
    }
    const open = mine.filter((i) => !['done', 'unusable'].includes(i.status));
    const where = (i) => ({ recording_id: i.rid, mode: i.mode, context_id: i.context_id });
    if (!open.length && mine.some((i) => i.status === 'unusable')) {
      const i = mine.find((x) => x.status === 'unusable');
      return DemoBackend._answer('unusable', `You reported that ${rid} cannot be annotated, so it is set aside. If the study team returns it to your list, you can annotate it then. Choose another recording from your list.`, where(i));
    }
    if (!open.length) {
      const revisable = mine.find((i) => this._canRevise(i));
      const viewable = mine.find((i) => i.mode === 'standard' && i.saved);
      const latest = (i) => this._attempts(i.key).pop();
      if (viewSaved && viewable) { // to read the feedback on it (docs/web/api.md, "Reviews")
        const last = latest(viewable);
        return DemoBackend._answer(status, `Recording found: ${viewable.rid}. Your latest saved version opens to read, with the feedback on it.`, {
          ...where(viewable), manifest: await this._publicManifest(viewable.rid), differences,
          saved: { version: last.attempt, saved_at: last.saved_at, annotations: last.annotations.map(annotationOut) } });
      }
      if (revise && revisable) {
        const last = latest(revisable);
        const version = last.attempt;
        const draft = this.state.drafts[revisable.key];
        return DemoBackend._answer(status, status === 'matched'
          ? `Recording found: ${revisable.rid}. You are revising it: your version ${version} opens, and submitting the revision saves version ${version + 1}, keeping the earlier one.`
          : this._metadataMessage(revisable.rid), {
          ...where(revisable), manifest: await this._publicManifest(revisable.rid), differences,
          draft: draft && draft.revises === version ? draft : null,
          revision: { version: version + 1, revises: version, saved_at: last.saved_at, annotations: last.annotations.map(annotationOut),
            bad_channels: [...(last.bad_channels || [])] } });
      }
      const hint = revisable ? ' To change your annotations, open it from your history with Open to revise.' : '';
      return DemoBackend._answer('done', `You have already completed ${rid}.${hint} Choose another recording from your list.`, where(mine[0]));
    }
    const chosen = open.find((i) => nxt && i.key === nxt.key) || open.find((i) => i.status === 'in_progress') || open[0];
    return DemoBackend._answer(status, status === 'matched' ? `Recording found: ${chosen.rid}` : this._metadataMessage(chosen.rid), {
      ...where(chosen), manifest: await this._publicManifest(chosen.rid), draft: this.state.drafts[chosen.key] || null, differences, repeat: chosen.repeat });
  }

  _metadataMessage(rid) {
    return `This file has the name, sampling rate, length and channels of ${rid} but is not byte for byte the study's copy. Continue only if you are sure it is the same recording.`;
  }

  // ------------------------------------------------------------------- drafts
  async putDraft(recordingId, mode, contextId, draft) {
    const aid = this._aid();
    const item = this._findItem(aid, recordingId, mode, contextId);
    this._refuseUnusable(item);
    let revises = null;
    if (item.status === 'done' && !item.repeat) {
      if (!this._canRevise(item)) throw new ApiError(409, 'already_done', `${item.rid} has already been completed`);
      revises = item.saved.version; // the draft of a revision
    }
    if (draft && typeof draft === 'object' && draft.session_id !== undefined && (typeof draft.session_id !== 'string' || draft.session_id.length > 64)) {
      throw new ApiError(422, 'invalid_draft', 'draft.session_id must be a short string');
    }
    if (draft && draft.session_id && ((this.state.closedSessions || {})[item.key] || []).includes(draft.session_id)) {
      throw new ApiError(409, 'draft_discarded', 'This draft belongs to work that was discarded when it was closed, so it is not kept.');
    }
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new ApiError(400, 'bad_request', 'A draft must be an object');
    const anns = draft.annotations === undefined ? [] : draft.annotations;
    if (!Array.isArray(anns) || anns.some((a) => !a || typeof a !== 'object')) throw new ApiError(422, 'invalid_draft', 'draft.annotations must be a list of annotations');
    anns.forEach((a, i) => this._checkConfidenceAndNote(a, `draft annotation ${i + 1}`, 'invalid_draft'));
    if (draft.view !== undefined && draft.view !== null && typeof draft.view !== 'object') throw new ApiError(422, 'invalid_draft', 'draft.view must be an object');
    const elapsed = draft.elapsed_s === undefined ? 0 : draft.elapsed_s;
    if (typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < 0) throw new ApiError(422, 'invalid_draft', 'draft.elapsed_s must be a number of seconds');
    const viewed = draft.viewed === undefined || draft.viewed === null ? [] : draft.viewed;
    if (!Array.isArray(viewed) || viewed.length > 5000 || viewed.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((x) => typeof x !== 'number' || !Number.isFinite(x)) || !(p[0] >= 0 && p[0] <= p[1]))) {
      throw new ApiError(422, 'invalid_draft', 'draft.viewed must be a list of [start_s, end_s] pairs of seconds');
    }
    const bad = draft.bad_channels === undefined ? [] : draft.bad_channels;
    if (!Array.isArray(bad) || bad.length > 4096 || bad.some((c) => typeof c !== 'string' || c.length > 200)) throw new ApiError(422, 'invalid_draft', 'draft.bad_channels must be a list of channel names');
    const saved_at = nowLocalIso();
    this.state.drafts[item.key] = { annotations: anns, view: draft.view || {}, elapsed_s: Math.min(elapsed, MAX_ELAPSED_S), viewed, saved_at, bad_channels: [...new Set(bad)],
      ...(revises !== null ? { revises } : {}) };
    this._save();
    return { saved_at };
  }

  async deleteDraft(recordingId, mode, contextId, { sessionId = '' } = {}) {
    const aid = this._aid();
    const key = this._key(aid, recordingId, mode || 'standard', contextId);
    delete this.state.drafts[key];
    if (sessionId) { // a session that discarded its work and closed: its drafts arriving late are refused
      const closed = (this.state.closedSessions ||= {});
      closed[key] = [...(closed[key] || []).filter((x) => x !== sessionId), String(sessionId)].slice(-20);
    }
    this._save();
    return {};
  }

  // ------------------------------------------------------------------- saving
  /** As service.py parse_annotations: each annotation checked as the server checks it, in its words. */
  _validate(annotations, info) {
    if (!Array.isArray(annotations)) throw new ApiError(422, 'invalid_annotation', 'annotations must be a list');
    const chans = new Set(info.ch_names);
    const shortest = Math.max(1, Number(this._admin.s.settings.annotation.min_duration_samples) || 1);
    const seen = new Set();
    annotations.forEach((a, n) => {
      const i = n + 1;
      const refuse = (why) => { throw new ApiError(422, 'invalid_annotation', why); };
      if (!a || typeof a !== 'object') refuse(`Annotation ${i} is not an object`);
      if (typeof a.annotation_id !== 'string' || !ANN_ID_RE.test(a.annotation_id)) refuse(`Annotation ${i} has no valid annotation_id`);
      if (seen.has(a.annotation_id)) refuse(`Annotation ${a.annotation_id} appears twice`);
      seen.add(a.annotation_id);
      if (typeof a.label !== 'string') refuse(`Annotation ${i} has no label`);
      for (const k of ['onset_sample', 'duration_samples']) if (!Number.isInteger(a[k])) refuse(`Annotation ${i}: ${k} must be a whole number of samples`);
      const channels = a.channels === undefined ? [] : a.channels;
      if (!Array.isArray(channels) || channels.some((c) => typeof c !== 'string')) refuse(`Annotation ${i}: channels must be a list of channel names`);
      if (new Set(channels).size !== channels.length) refuse(`Annotation ${i} (${a.label}) lists a channel more than once`);
      this._checkConfidenceAndNote(a, `Annotation ${i} (${a.label})`, 'invalid_annotation');
      const where = `Annotation ${i} (${a.label} at sample ${a.onset_sample})`;
      const unknown = channels.filter((c) => !chans.has(c)).sort();
      if (unknown.length) refuse(`${where}: Unknown channel(s): ${unknown.join(', ')}`);
      if (!LABELS.has(a.label)) refuse(`${where}: '${a.label}' is not a permitted artifact label. Only the ${LABELS.size} labels of catalogue ${CATALOGUE_NAME} may be used.`);
      const at = `${where}: ${a.label} at sample ${a.onset_sample}:`;
      if (a.duration_samples < shortest) refuse(`${at} Annotation must last at least ${shortest} sample(s); got ${a.duration_samples}`);
      if (a.onset_sample < 0) refuse(`${at} Annotation starts before the recording (sample ${a.onset_sample})`);
      if (a.onset_sample + a.duration_samples > info.n_samples) {
        refuse(`${at} Annotation extends beyond the end of the recording (ends at sample ${a.onset_sample + a.duration_samples}, recording has ${info.n_samples})`);
      }
    });
    // in the recording's channel order, as the server keeps them
    return annotations.map((a) => ({ ...a, channels: info.ch_names.filter((c) => (a.channels || []).includes(c)), confidence: a.confidence ?? null, note: (a.note || '').trim() }));
  }

  /** As service.py parse_bad_channels. */
  _badChannels(list, info) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.some((c) => typeof c !== 'string')) throw new ApiError(422, 'invalid_annotation', 'bad_channels must be a list of channel names');
    if (new Set(list).size !== list.length) throw new ApiError(422, 'invalid_annotation', 'bad_channels lists a channel more than once');
    const unknown = [...new Set(list)].filter((c) => !info.ch_names.includes(c)).sort();
    if (unknown.length) throw new ApiError(422, 'invalid_annotation', `bad_channels names channels that are not shown: ${unknown.slice(0, 5).join(', ')}`);
    return info.ch_names.filter((c) => list.includes(c));
  }

  /** As service.py confidence_and_note: a confidence is a whole number from 1 to 5 or none, and a note one line of at most 200 characters. */
  _checkConfidenceAndNote(a, where, code) {
    if (a.confidence !== undefined && a.confidence !== null && !isConfidence(a.confidence)) {
      throw new ApiError(422, code, `${where}: confidence must be a whole number from 1 to 5, or none`);
    }
    const problem = noteProblem(a.note);
    if (problem) throw new ApiError(422, code, `${where}: ${problem}`);
  }

  async submit(body) {
    const aid = this._aid();
    const item = this._findItem(aid, body.recording_id, body.mode, body.context_id);
    this._refuseUnusable(item);
    const { rid, info, key } = item;
    let revision = null;
    if (item.status === 'done' && !item.repeat) {
      if (body.revises === undefined || body.revises === null) throw new ApiError(409, 'already_done', `You have already completed ${rid}; it is not saved twice.`);
      if (!this._canRevise(item)) {
        throw new ApiError(409, 'revisions_off', `You have already completed ${rid}, and this study does not take revisions of finished recordings.`);
      }
      if (!Number.isInteger(body.revises)) throw new ApiError(400, 'bad_request', 'revises must be the version being revised (a whole number)');
      if (body.revises !== item.saved.version) {
        throw new ApiError(409, 'already_revised', `${rid} has been saved again since you opened it (version ${item.saved.version}). ` +
          'Open it again from your history to revise the latest version.');
      }
      revision = { version: item.saved.version + 1, revises_version: item.saved.version };
    }
    const sessionInfo = body.session && typeof body.session === 'object' ? body.session : {};
    if (!SHA_RE.test(String(body.sha256 || '').toLowerCase())) throw new ApiError(400, 'bad_request', 'sha256 (the checksum of the annotated file) is missing');
    const elapsed = sessionInfo.elapsed_s === undefined ? 0 : sessionInfo.elapsed_s;
    if (typeof elapsed !== 'number' || !Number.isFinite(elapsed)) throw new ApiError(422, 'invalid_session', 'session.elapsed_s must be a number');
    if (elapsed < 0) throw new ApiError(422, 'invalid_session', 'session.elapsed_s must be at least 0');
    const annotations = this._validate(body.annotations, info);
    const badChannels = this._badChannels(body.bad_channels, info);
    const guidedSummary = item.mode === 'guided' ? this._verifyGuided(aid, rid, annotations) : null;
    const sid = sessionInfo.session_id;
    if (sid !== undefined && sid !== null && (typeof sid !== 'string' || !/^[0-9a-f]{32}$/i.test(sid))) {
      throw new ApiError(400, 'bad_request', 'session.session_id must be 32 hexadecimal characters');
    }
    const attempt = this._attempts(key).length + 1;
    const saved_at = nowLocalIso();
    const out = { saved: true, attempt, feedback: null, guided: null, assessment: null, demo_notice: DEMO_NOTICE,
      revision: revision ? { version: attempt, revises: revision.revises_version } : null };
    if (item.mode === 'practice') {
      const rule = this._passRule();
      const fb = practiceFeedback(truthAnnotations(info.spec), annotations, { passRule: rule, sfreq: info.sfreq });
      this._progress(aid).practice[rid] = [...(this._progress(aid).practice[rid] || []),
        { passed: fb.passed, ...fb.score, ...fb.counts, completed_at: saved_at, seconds: Math.round(Math.min(elapsed, MAX_ELAPSED_S) * 1000) / 1000 }];
      // the review's plain words, as the server's (electrotag/web/coach.py practice_result)
      out.feedback = { ...fb, rule: { ...rule }, verdict: practiceVerdict(fb.passed, rule, TRAINING_SET.practice.length), summary: scoreSentence(fb.counts),
        per_category: [], review: true, demo_notice: DEMO_NOTICE };
    }
    if (guidedSummary) {
      this._progress(aid).guided[rid] = { ...guidedSummary, completed_at: saved_at };
      delete this.state.guided[`${aid}|${rid}`];
      const s = DemoBackend._publicSummary(guidedSummary);
      out.guided = { summary: s, message: s.steps ? `Recording saved: ${s.stars} of ${s.max_stars} stars (${minutesText(s.time_s)}).` : 'Recording saved.' };
    }
    this.state.submissions.push({
      key, annotator_id: aid, recording_id: rid, mode: item.mode, context_id: item.context_id, attempt, saved_at,
      annotations, bad_channels: badChannels, session: { ...sessionInfo, elapsed_s: Math.min(elapsed, MAX_ELAPSED_S) }, sha256: String(body.sha256).toLowerCase(),
      confidence_setting: this._admin.studyBlock().annotation.confidence,
      recording: { file_name: info.file_name, sfreq: info.sfreq, n_samples: info.n_samples, ch_names: info.ch_names, size_bytes: info.size_bytes },
      guided: guidedSummary, feedback: out.feedback ? { passed: out.feedback.passed, metrics: out.feedback.metrics } : null,
      revision,
    });
    this.state.done[key] = { saved_at, attempt };
    delete this.state.drafts[key];
    this._save();
    // the output files, named as the server's OutputLayout names them
    const base = this._outputBasename(info, aid, attempt);
    out.files = ['annotations.json', ...(badChannels.length ? ['channels.tsv'] : []), 'events.json', 'events.tsv', 'session.json', 'time_viewed.txt'].map((f) => `${base}_${f}`);
    out.next = (await this.assignments()).next;
    return out;
  }

  /** The name the server gives a saved attempt's files (electrotag/app/io/naming.py OutputLayout). */
  _outputBasename(info, aid, attempt) {
    return `${info.stem}_annotator-${aid}${attempt > 1 ? `_attempt-${String(attempt).padStart(2, '0')}` : ''}`;
  }

  // ------------------------------------------- problem reports and reviews
  _refuseUnusable(item) {
    if (item.status === 'unusable') {
      throw new ApiError(409, 'unusable', `You reported that ${item.rid} cannot be annotated, so it is set aside. If the study team returns it to your list, you can annotate it then.`);
    }
  }

  /** POST /problems: a problem with a recording, kept once however often it is sent (demo_feedback.js). */
  async reportProblem(body) { return this.feedback.report(body || {}); }

  /** GET /me/reviews: the reviews of this annotator's saved work, when the study shows them. */
  async myReviews() { return this.feedback.mine(); }

  /** GET /me/results (demo_export.js). */
  async myResults(recordingId, mode, contextId, version) { return (await import('./demo_export.js')).myResults(this, recordingId, mode, contextId, version); }

  // ------------------------------------------------------------ achievements
  /** GET /me/achievements (docs/web/api.md, "Achievements"), from the sandbox's own state. */
  /** GET /me/questionnaire: the sign-up questionnaire, the answers and contact details (demo_questionnaire.js). */
  async questionnaire() { this._aid(); return JSON.parse(JSON.stringify((await this._questionnairePart()).view())); }

  /** The sign-up questionnaire's part of the sandbox, loaded at its first use (js/lazy.js, part demoQuestionnaire). */
  async _questionnairePart() {
    if (!this.questionnaires) {
      const { DemoQuestionnaire } = await loadPart('demoQuestionnaire');
      this.questionnaires = this.questionnaires || new DemoQuestionnaire(this);
    }
    return this.questionnaires;
  }

  /** POST /me/questionnaire: saves the answers and contact details. */
  async saveQuestionnaire(body) {
    this._aid();
    const sent = JSON.parse(JSON.stringify({ answers: null, ...(body || {}) })); // as it would travel
    return JSON.parse(JSON.stringify((await this._questionnairePart()).save(sent)));
  }

  async achievements() { return this._achievements({}); }

  /** POST /me/achievements: the personal goal ({goal_per_week}) or being hidden from the leaderboard. */
  async setAchievements(body) { return this._achievements(body || {}); }

  _achievements(body) {
    const aid = this._aid();
    const g = this._admin.s.settings.gamification || {};
    if (g.enabled === false) return { enabled: false, leaderboard_enabled: false };
    const records = this.state.records || (this.state.records = {});
    if ('goal_per_week' in body || 'leaderboard_hidden' in body) {
      const change = {};
      if ('goal_per_week' in body) {
        const v = body.goal_per_week;
        if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= MAX_GOAL)) {
          throw new ApiError(400, 'bad_request', `goal_per_week must be a whole number from 1 to ${MAX_GOAL} (or null for no goal)`);
        }
        change.goal_per_week = v;
      }
      if ('leaderboard_hidden' in body) {
        if (typeof body.leaderboard_hidden !== 'boolean') throw new ApiError(400, 'bad_request', 'leaderboard_hidden must be true or false');
        change.leaderboard_hidden = body.leaderboard_hidden;
      }
      records[aid] = { ...(records[aid] || {}), ...change };
      this._save();
    }
    const record = records[aid] || {};
    const mine = this._savedByKey(aid);
    let worked = 0;
    let annotations = 0;
    const completions = [];
    for (const [key, list] of mine) {
      const sum = this._savedSummary(key);
      worked += sum.total_elapsed_s || 0;
      annotations += sum.n_annotations || 0;
      completions.push({ first_saved_at: sum.first_saved_at, viewed_fraction: this._viewed(list) });
    }
    completions.sort((x, y) => String(x.first_saved_at).localeCompare(String(y.first_saved_at)));
    const withCoverage = completions.filter((c) => c.viewed_fraction !== null);
    const team = this._team();
    const assigned = this._admin.standardAssignments(aid).filter((a) => a.mode === 'standard').length;
    return {
      enabled: true,
      leaderboard_enabled: g.leaderboard !== false,
      counters: { done: mine.size, assigned, worked_s: Math.round(worked * 1000) / 1000, annotations },
      completions,
      save_times: [...mine.values()].flat().map((s) => s.saved_at).sort(),
      viewed_in_full: withCoverage.length ? withCoverage.filter((c) => c.viewed_fraction >= VIEWED_IN_FULL).length : null,
      goal: { per_week: record.goal_per_week ?? null },
      // Left out when exactly one other person has recordings: the team's figures less one's own would be theirs (games.py).
      team: team.people - (team.withWork.has(aid) ? 1 : 0) === 1 ? { done: null, assigned: null, people: team.people } : { done: team.done, assigned: team.assigned, people: team.people },
      leaderboard: g.leaderboard !== false
        ? leaderboardOf(aid, team, { hiddenMe: record.leaderboard_hidden === true, byFull: g.leaderboard_viewed_only === true }) : null,
    };
  }

  /** An annotator's saved study recordings: key -> submissions. */
  _savedByKey(aid) {
    const out = new Map();
    for (const s of this.state.submissions) {
      if (s.annotator_id !== aid || s.mode !== 'standard') continue;
      if (!out.has(s.key)) out.set(s.key, []);
      out.get(s.key).push(s);
    }
    return out;
  }

  /** The most of a recording viewed in any of its saved attempts, or null when that was not measured. */
  _viewed(list) {
    const vs = list.map((s) => viewedFraction(s.session && s.session.viewed_fraction)).filter((v) => v !== null);
    return vs.length ? Math.max(...vs) : null;
  }

  _team() {
    if (!this.state.secret) { this.state.secret = sha256Hex(new TextEncoder().encode(`${newId()}${newId()}`)); this._save(); }
    const people = this._admin.s.users.filter((u) => rolesOf(u).includes('annotator'))
      .sort((x, y) => String(x.created_at || '').localeCompare(String(y.created_at || '')) || (x.annotator_id < y.annotator_id ? -1 : 1));
    const ids = people.map((u) => u.annotator_id);
    const names = {};
    const taken = new Set();
    for (const id of ids) {
      let salt = 0;
      let name = demoPseudonym(this.state.secret, id, salt);
      while (taken.has(name) && salt < 1000) name = demoPseudonym(this.state.secret, id, ++salt);
      taken.add(name);
      names[id] = name;
    }
    const completed = {};
    const full = {};
    let done = 0;
    let assigned = 0;
    const withWork = new Set();
    const records = this.state.records || {};
    for (const id of ids) {
      const given = this._admin.standardAssignments(id).filter((a) => a.mode === 'standard' && this._recordingInfo(a.rid));
      const mine = this._savedByKey(id);
      completed[id] = mine.size;
      full[id] = [...mine.values()].filter((list) => (this._viewed(list) || 0) >= VIEWED_IN_FULL).length;
      assigned += given.length;
      done += given.filter((a) => this.state.done[this._key(id, a.rid, 'standard', '')]).length;
      if (given.length) withWork.add(id);
    }
    const hidden = new Set(ids.filter((id) => (records[id] || {}).leaderboard_hidden === true));
    return { ids, names, completed, full, hidden, done, assigned, people: withWork.size, withWork };
  }

  // ---------------------------------------------------------------- training
  _trainingSetId() { return TRAINING_SET.set_id; }

  /** The built-in recordings and training set, for the admin area's first state (demo_admin.js). */
  _builtIn() {
    return {
      recordings: SPECS.map((s) => ({ recording_id: recordingIdOf(s), file_name: fileNameOf(s), sfreq: s.sfreq, n_samples: s.nSamples,
        n_channels: s.channels.length, size_bytes: exampleRecording(recordingIdOf(s)).sizeBytes })),
      trainingSet: TRAINING_SET,
    };
  }

  _truthOf(rid) { const spec = RID.get(rid); return spec ? truthAnnotations(spec) : []; }

  _exampleNoteOf(rid, a) { const spec = RID.get(rid); return spec ? exampleNote(a.label, a.duration_samples / spec.sfreq, a.channels) : ''; }

  /** The training set as the admin area keeps it (its pass mark, matching and guidance can be changed). */
  _exampleSet() { return this._admin.s.sets.find((x) => x.set_id === TRAINING_SET.set_id); }

  /** The types on the number keys, as the coach names them ("press 1"). */
  _quickKeys() {
    const chosen = this._admin.s.settings.annotation.quick_labels;
    return Object.fromEntries((chosen && chosen.length ? chosen : DEFAULT_QUICK_LABELS).map((n, i) => [n, i + 1]));
  }

  /** The quiz of a reference set: the sandbox's own, on its training set. */
  _quizItemsOf(setId) { return setId === QUIZ.set_id ? QUIZ.items : []; }

  _passRule() { return { ...TRAINING_SET.pass, ...(this._exampleSet().practice_pass || {}) }; }

  _tolerance() { return { ...rules.DEFAULT_TOLERANCE, ...(this._exampleSet().guided_tolerance || {}) }; }

  /** A trainee's progress (training/programme.py Progress): the guided summaries, the practice attempts and the stage events. */
  _progress(aid) {
    if (!this.state.progress[aid]) this.state.progress[aid] = { guided: {}, practice: {}, events: [] };
    const p = this.state.progress[aid];
    if (!Array.isArray(p.events)) p.events = [];
    return p;
  }

  /** The study's policy for the training path (the settings' training block). */
  _policy() { return stagePolicy((this._admin.s.settings || {}).training); }

  /** The snippets of the training set (its own, then one for each reference annotation of a guided recording). */
  _snippetCount() {
    const own = (this._exampleSet().snippets || []).length;
    return own + TRAINING_SET.guided.reduce((n, g) => n + this._truthOf(g.rid).length, 0);
  }

  /** The five stages for one trainee (programme.py programme_state; the sandbox's set has no assessment). */
  _stages(aid) {
    const ctx = TRAINING_SET.set_id;
    const prog = this._progress(aid);
    const doneIn = (mode, list) => list.filter((rid) => this.state.done[this._key(aid, rid, mode, ctx)]);
    const gTotal = TRAINING_SET.guided.map((g) => g.rid);
    const gDone = doneIn('guided', gTotal);
    const sum = (k) => gDone.reduce((a, rid) => a + Number((prog.guided[rid] || {})[k] || 0), 0);
    const attempts = Object.values(prog.practice).flat();
    const passed = attempts.some((a) => a.passed);
    // the best attempt, as Progress.best_practice: a pass first, then the score, then the type
    const better = (a, b) => (Number(a.passed) - Number(b.passed)) || (a.event_f1 - b.event_f1) || (a.label_accuracy - b.label_accuracy);
    const best = attempts.length ? attempts.reduce((b, a) => (better(a, b) > 0 ? a : b)) : null;
    return stageStates({
      events: prog.events, policy: this._policy(), nSnippets: this._snippetCount(), quiz: this._quizItemsOf(ctx).length > 0,
      guided: { total: gTotal, done: gDone, stars: sum('stars'), max_stars: sum('max_stars'), seconds: sum('seconds'), detail: correctionsDetail(prog.guided, gDone) },
      practice: { total: TRAINING_SET.practice, done: doneIn('practice', TRAINING_SET.practice), base: passed ? 'completed' : attempts.length ? 'in_progress' : 'available',
        seconds: attempts.reduce((a, x) => a + (x.seconds || 0), 0), detail: practiceDetail(best, this._passRule(), passed),
        result: best ? (passed ? 'passed' : 'not_passed') : '', best },
      assessment: { total: [], done: [] },
    });
  }

  /** What the Continue button of the training path does next (programme.py next_step). */
  _nextStep(aid, stages = this._stages(aid)) {
    const ctx = TRAINING_SET.set_id;
    const first = browserStep(stages);
    if (first) return first;
    const open = (k) => { const s = stages.find((x) => x.key === k); return isUnlocked(s) && !isFinished(s); };
    const n = TRAINING_SET.guided.length;
    if (open('guided')) {
      const i = TRAINING_SET.guided.findIndex((x) => !this.state.done[this._key(aid, x.rid, 'guided', ctx)]);
      return { stage: 'guided', recording_id: TRAINING_SET.guided[i].rid, repeat: false, label: `Start recording ${i + 1} of ${n}`,
        text: `Next: ${STAGE_TITLES.guided}, recording ${i + 1} of ${n}.` };
    }
    const list = TRAINING_SET.practice;
    if (open('practice')) {
      const left = list.findIndex((rid) => !this.state.done[this._key(aid, rid, 'practice', ctx)]);
      if (left >= 0) {
        return { stage: 'practice', recording_id: list[left], repeat: false, label: 'Start a practice recording',
          text: `Next: ${STAGE_TITLES.practice}, practice recording ${left + 1} of ${list.length}.` };
      }
      // the one practised longest ago comes again, so that the answers just seen in a review are not the next test
      const rid = retryRecording(list, this._progress(aid).practice);
      if (list.length === 1) {
        return { stage: 'practice', recording_id: rid, repeat: true, label: 'Try the practice recording again',
          text: 'Not passed yet. Try the practice recording again, looking out for what its review showed you.' };
      }
      const k = list.indexOf(rid) + 1;
      return { stage: 'practice', recording_id: rid, repeat: true, label: `Try practice recording ${k} again`,
        text: `Not passed yet. Try practice recording ${k} of ${list.length} again, the one you did longest ago.` };
    }
    return { stage: null, recording_id: null, repeat: false, label: 'Training complete', text: 'You have completed every stage of this training programme.' };
  }

  /**
   * The competency gate of real study work (training_path.py gate). The sandbox's training set has no
   * assessment recordings (they need the competency report, which needs ElectroTag's Python code), so study
   * work is always open here; a study server or Firebase locks it until the assessment is passed.
   */
  _gate() { return { open: true, reason: '', message: '', result: '' }; }

  async training() {
    return this._trainingView(this._aid());
  }

  /** GET /training for one account (coach.py programme_view; the admin area's progress shows it for every trainee). */
  _trainingView(aid) {
    if (!this._inProgramme(aid)) throw new ApiError(404, 'no_programme', 'You are not taking part in a training programme');
    const set = this._exampleSet();
    const stages = this._stages(aid);
    const nxt = this._nextStep(aid, stages);
    const item = nxt.stage ? this._nextItem(aid, this._workItems(aid)) : null;
    return {
      set_id: TRAINING_SET.set_id, name: set.name, description: set.description,
      stages: stages.map((s) => ({ key: s.key, title: s.title, description: s.description, status: s.status, done: s.done, total: s.total,
        stars: s.stars, max_stars: s.max_stars, best_score: s.key === 'practice' && s.best ? Math.round(s.best.event_f1 * 10000) / 10000 : null,
        time_s: Math.round(s.seconds * 10) / 10, detail: s.detail, result: s.result || null, can_skip: s.can_skip, can_resume: s.can_resume,
        carried_from: s.carried_from || null })),
      next: nxt.stage ? { stage: nxt.stage, recording_id: item ? item.rid : null, label: nxt.label, text: nxt.text, mode: nxt.stage,
        context_id: TRAINING_SET.set_id, file_name: item ? item.info.file_name : null, repeat: nxt.repeat } : null,
      complete: !nxt.stage,
      message: nxt.text,
      gate: this._gate(),
      rounds: stageMarks(this._progress(aid).events).rounds.map(({ round, set_id, set_name, status, status_text, at }) => ({ round, set_id, set_name, status, status_text, at })),
    };
  }

  // ------------------------------------------------------- the guided coach
  // As electrotag/web/coach.py, with the rules of training/rules.js (a port of training/guided.py).
  _guided(aid, rid) {
    const item = this._workItems(aid).find((i) => i.mode === 'guided' && i.rid === rid);
    if (!item) throw new ApiError(404, 'not_assigned', `${rid} is not one of your recordings for learning with the experts`);
    if (item.status === 'done') throw new ApiError(409, 'already_done', `You have already completed ${rid}`);
    const spec = RID.get(rid);
    const chosen = (this._exampleSet().recordings || []).find((r) => r.recording_id === rid);
    const levels = ['show', 'find', 'find_unnamed'];
    const guidance = chosen && levels.includes(chosen.guidance) ? chosen.guidance
      : levels[Math.min(TRAINING_SET.guided.findIndex((g) => g.rid === rid), levels.length - 1)];
    const truth = truthAnnotations(spec);
    const notes = Object.fromEntries(truth.map((a) => [a.annotation_id,
      this._admin.guidedNote(TRAINING_SET.set_id, a.annotation_id) ?? exampleNote(a.label, a.duration_samples / spec.sfreq, a.channels)]));
    return { item, spec, rid, guidance, steps: rules.buildSteps(truth, notes), sfreq: spec.sfreq };
  }

  _guidedState(aid, rid, create = true) {
    const k = `${aid}|${rid}`;
    if (!this.state.guided[k] && create) {
      const now = Date.now() / 1000;
      this.state.guided[k] = { index: 0, matched: {}, failed: {}, shown: [], stars: {}, seconds: {}, step_started: now, last_active: now,
        signature: null, last: null, complete: false, summary: null };
    }
    return this.state.guided[k];
  }

  _view(g, i, guidance) {
    const t = g.steps[i].target;
    const display = Number(this._admin.s.settings.display.duration_s) || 10;
    const total = g.spec.nSamples / g.sfreq;
    const t0 = t.onset_sample / g.sfreq;
    const t1 = (t.onset_sample + t.duration_samples) / g.sfreq;
    let window = display;
    let start;
    if (guidance === 'show') start = t1 - t0 > window ? t0 : t0 - (window - (t1 - t0)) / 2;
    else if (guidance === 'find') {
      window = Math.max(display, FIND_WINDOW_S);
      start = t1 - t0 >= window - 1 ? t0 - 0.5 : t0 - (0.15 + 0.7 * ((i * 0.618) % 1.0)) * (window - (t1 - t0));
    } else return null;
    return { start_s: Math.round(Math.min(Math.max(0, start), Math.max(0, total - window)) * 10000) / 10000, duration_s: window };
  }

  _stepView(g, i) {
    const t = g.steps[i].target;
    const named = g.guidance !== 'find_unnamed';
    return {
      step: i + 1, n_steps: g.steps.length, guidance: g.guidance,
      instruction: rules.instruction(t.label, g.guidance),
      text: rules.stepBody(g.guidance, named ? t.label : null, [...t.channels], this._quickKeys()),
      label: named ? t.label : null,
      description: named ? (LABELS.get(t.label)?.description || '') : '',
      note: named ? (g.steps[i].note || null) : null,
      ghost: g.guidance === 'show' ? { onset_sample: t.onset_sample, duration_samples: t.duration_samples, channels: [...t.channels] } : null,
      view: this._view(g, i, g.guidance),
    };
  }

  _summary(st, n, guidance) {
    return { steps: n, stars: Object.values(st.stars).reduce((a, b) => a + b, 0), max_stars: rules.STARS_FIRST * n,
      failed_attempts: Object.values(st.failed).reduce((a, b) => a + b, 0), shown: st.shown.length,
      seconds: Math.round(Object.values(st.seconds).reduce((a, b) => a + b, 0) * 1000) / 1000, guidance };
  }

  static _publicSummary(s) {
    return { steps: s.steps, stars: s.stars, max_stars: s.max_stars, attempts: s.failed_attempts + s.steps - s.shown,
      failed_attempts: s.failed_attempts, shown: s.shown, time_s: s.seconds };
  }

  _expectStep(st, step, n) {
    if (!Number.isInteger(step)) throw new ApiError(400, 'bad_request', 'step must be the number of the current step');
    if (st.complete || st.index >= n) throw new ApiError(409, 'complete', 'Every step of this recording is already matched; save it now.');
    if (step !== st.index + 1) {
      throw new ApiError(409, 'wrong_step', `You are at step ${st.index + 1} of ${n}, not step ${step}.`, { error: 'wrong_step', current_step: st.index + 1 });
    }
    return st.index;
  }

  _extraMessages(ext, g) { return ext.slice(0, 1).map((a) => rules.extraMessage(a, g.steps, g.sfreq)); }

  async guided(recordingId) {
    const aid = this._aid();
    const g = this._guided(aid, recordingId);
    const fresh = !this._guidedState(aid, recordingId, false);
    const st = this._guidedState(aid, recordingId);
    if (!fresh && !st.complete) {
      // opened again: the step's time carries on from the trainee's last action on it (coach.py _resume_clock)
      const now = Date.now() / 1000;
      st.step_started = now - Math.max(0, Math.min(st.last_active, now) - st.step_started);
      st.last_active = now;
    }
    this._save();
    const tol = this._tolerance();
    return {
      recording_id: recordingId, context_id: TRAINING_SET.set_id, n_steps: g.steps.length, guidance: g.guidance,
      tolerance: { seconds: tol.seconds, fraction: tol.fraction, channel_jaccard: tol.channel_jaccard },
      completed: Object.keys(st.matched).map(Number).sort((a, b) => a - b).map((i) => ({ step: i + 1, stars: st.stars[i] || 0, annotation_id: st.matched[i] })),
      current: st.complete ? null : this._stepView(g, st.index),
      complete: st.complete,
      summary: st.complete && st.summary ? DemoBackend._publicSummary(st.summary) : null,
      empty_message: null,
      demo_notice: DEMO_NOTICE,
    };
  }

  async guidedCheck(recordingId, body) {
    const aid = this._aid();
    const g = this._guided(aid, recordingId);
    const st = this._guidedState(aid, recordingId);
    const anns = this._validate(body.annotations, g.item.info);
    if (st.complete || st.index >= g.steps.length) {
      const ext = rules.extras(g.steps, anns, st.matched);
      return { matched: true, candidate_id: null, problems: ext.length ? ['extra'] : [],
        messages: ext.length ? this._extraMessages(ext, g) : ['Everything matches the experts.'],
        extras: ext.map((a) => a.annotation_id), can_continue: false, stars: null, complete: true };
    }
    const i = this._expectStep(st, body.step, g.steps.length);
    const step = g.steps[i];
    const result = rules.checkStep(step, anns, g.sfreq, this._tolerance(), { taken: new Set(Object.values(st.matched)), quickKeys: this._quickKeys() });
    const ext = rules.extras(g.steps, anns, st.matched, result, i);
    const sig = JSON.stringify(anns.map((a) => [a.annotation_id, a.label, a.onset_sample, a.duration_samples, a.channels]).sort());
    if (sig !== st.signature && result.candidate_id && !result.matched) st.failed[i] = (st.failed[i] || 0) + 1;
    st.signature = sig;
    st.last_active = Date.now() / 1000;
    const can = Boolean(result.matched && !ext.length);
    const shown = st.shown.includes(i);
    st.last = { step: i + 1, can_continue: can, candidate_id: result.candidate_id };
    this._save();
    let problems = [...result.problems.filter((p) => p !== 'missing'), ...(ext.length ? ['extra'] : [])];
    if (result.problems.length === 1 && result.problems[0] === 'missing') problems = ['missing', ...(ext.length ? ['extra'] : [])];
    const messages = ext.length ? this._extraMessages(ext, g)
      : result.matched && shown ? ['This is how the experts marked it. Look at where it starts and ends and which channels it covers, then press Continue.']
        : result.matched ? [`${result.messages[0].replace(/\.+$/, '')}. Press Continue (Enter) for the next one.`] : [...result.messages];
    const out = { matched: result.matched, candidate_id: result.candidate_id, problems, messages, extras: ext.map((a) => a.annotation_id),
      can_continue: can, stars: can ? rules.starsFor(st.failed[i] || 0, shown) : null, failed_attempts: st.failed[i] || 0, deltas: { ...result.deltas } };
    if (result.matched && g.guidance === 'find_unnamed') {
      out.found = { label: step.target.label, description: LABELS.get(step.target.label)?.description || '', note: step.note || null };
    }
    return out;
  }

  async guidedContinue(recordingId, body) {
    const aid = this._aid();
    const g = this._guided(aid, recordingId);
    const st = this._guidedState(aid, recordingId);
    const i = this._expectStep(st, body.step, g.steps.length);
    const last = st.last || {};
    if (last.step !== i + 1 || !last.can_continue) throw new ApiError(409, 'not_matched', "Match the experts' annotation (and remove anything extra) first.");
    const shown = st.shown.includes(i);
    const failed = st.failed[i] || 0;
    st.matched[i] = last.candidate_id || '';
    st.stars[i] = rules.starsFor(failed, shown);
    // the time paused during the step (the page's pause) does not count
    const paused = typeof body.paused_s === 'number' && Number.isFinite(body.paused_s) && body.paused_s > 0 ? body.paused_s : 0;
    st.seconds[i] = Math.round(Math.max(0, Date.now() / 1000 - st.step_started - paused) * 1000) / 1000;
    const previous = { step: i + 1, stars: st.stars[i], attempts: failed + (shown ? 0 : 1), failed_attempts: failed, used_show_me: shown, seconds: st.seconds[i] };
    st.index = i + 1;
    st.step_started = st.last_active = Date.now() / 1000;
    st.last = null;
    if (st.index >= g.steps.length) {
      st.complete = true;
      st.summary = this._summary(st, g.steps.length, g.guidance);
      this._save();
      const s = DemoBackend._publicSummary(st.summary);
      return { complete: true, summary: s, previous,
        message: `You matched all ${s.steps} of the experts' annotations in ${minutesText(s.time_s)}${s.shown ? `, ${s.shown} with Show me` : ''}. Press Save and Finish to save your work.` };
    }
    this._save();
    return { ...this._stepView(g, st.index), previous };
  }

  async guidedShowMe(recordingId, body) {
    const aid = this._aid();
    const g = this._guided(aid, recordingId);
    const st = this._guidedState(aid, recordingId);
    const i = this._expectStep(st, body.step, g.steps.length);
    const t = g.steps[i].target;
    let replace = [];
    if (body.annotations !== undefined && body.annotations !== null) {
      const taken = new Set(Object.values(st.matched));
      const candidate = (st.last || {}).candidate_id;
      replace = this._validate(body.annotations, g.item.info).filter((a) => !taken.has(a.annotation_id) && rules.overlaps(a, t)
        && (a.annotation_id === candidate || a.label === t.label)).map((a) => a.annotation_id);
    }
    if (!st.shown.includes(i)) st.shown.push(i);
    st.last_active = Date.now() / 1000;
    st.last = null;
    this._save();
    const stamp = nowLocalIso();
    return {
      ghost: { onset_sample: t.onset_sample, duration_samples: t.duration_samples, channels: [...t.channels] },
      annotation: { annotation_id: newId(), label: t.label, onset_sample: t.onset_sample, duration_samples: t.duration_samples,
        channels: [...t.channels], created_at: stamp, modified_at: stamp },
      replace, view: this._view(g, i, 'show'), stars: rules.starsFor(0, true),
    };
  }

  /** Save and Finish of a guided recording (coach.py verify_for_saving): every step must still match and nothing extra be marked. */
  _verifyGuided(aid, rid, anns) {
    const g = this._guided(aid, rid);
    const st = this._guidedState(aid, rid);
    if (!st.complete) {
      throw new ApiError(422, 'guided_incomplete', `Match each of the experts' annotations first: you are at step ${st.index + 1} of ${g.steps.length}.`);
    }
    const matched = { ...st.matched };
    for (let i = 0; i < g.steps.length; i++) {
      const others = new Set(Object.entries(matched).filter(([k]) => Number(k) !== i).map(([, v]) => v));
      const r = rules.checkStep(g.steps[i], anns, g.sfreq, this._tolerance(), { taken: others, quickKeys: this._quickKeys() });
      if (!r.matched) {
        // that step is the current one again
        for (const k of Object.keys(st.matched).map(Number).filter((k) => k >= i)) for (const f of ['matched', 'stars', 'seconds']) delete st[f][k];
        Object.assign(st, { index: i, complete: false, summary: null, last: null, signature: null, step_started: Date.now() / 1000, last_active: Date.now() / 1000 });
        this._save();
        throw new ApiError(422, 'guided_incomplete', `Step ${i + 1} (${g.steps[i].target.label}) no longer matches the experts' annotation: ` +
          `${r.messages.join(' ')} It is shown again so you can put it right.`, { error: 'guided_incomplete', step: i + 1 });
      }
      matched[i] = r.candidate_id || matched[i];
    }
    if (rules.extras(g.steps, anns, matched).length) {
      throw new ApiError(422, 'guided_incomplete', "Some of your annotations are not in the experts' annotations. Delete them before you save.");
    }
    return { ...st.summary };
  }

  // ---------------------------------------------------------- interaction log
  async openVisit(body) {
    const aid = this._aid();
    const logging = { ...this._admin.s.settings.logging };
    if (!logging.interactions) return { visit_id: null, logging };
    const visit_id = newId();
    const started_at = nowLocalIso();
    const programme = Boolean(body && body.programme) && this._inProgramme(aid);
    const mode = body && ['standard', 'guided', 'practice', 'assessment'].includes(body.mode) ? body.mode : programme ? 'guided' : 'standard';
    const context_id = programme ? TRAINING_SET.set_id : mode !== 'standard' ? String((body && body.context_id) || '') : '';
    this.visits.set(visit_id, {
      header: { visit_id, annotator_id: aid, started_at, client: 'web', mode, context_id, programme, browser: body && body.client },
      events: [{ seq: 1, t: 0, wall: started_at, type: 'visit_started', mode, client: 'web' }], closed: null,
    });
    this._admin.visitOpened({ visit_id, annotator_id: aid, mode, context_id, started_at, closed_at: null, n_events: 1 });
    return { visit_id, logging };
  }

  async sendEvents(visitId, events) {
    const v = this.visits.get(visitId);
    if (!v) throw new ApiError(404, 'unknown_visit', "This visit's log was not found");
    if (v.closed) throw new ApiError(409, 'visit_closed', "This visit's log is already closed");
    if (!Array.isArray(events) || events.length > 2000) throw new ApiError(400, 'bad_request', 'events must be a list of at most 2000 events');
    let received = 0;
    for (const e of events) {
      if (!e || typeof e.type !== 'string' || !/^[a-z0-9_]+$/.test(e.type) || typeof e.t !== 'number' || !Number.isFinite(e.t) || e.t < 0) continue;
      const { password, token, ...rest } = e; // eslint-disable-line no-unused-vars
      v.events.push({ ...rest, seq: v.events.length + 1 });
      received += 1;
    }
    return { received, skipped: events.length - received };
  }

  async closeVisit(visitId, reason) {
    const v = this.visits.get(visitId);
    if (v && !v.closed) {
      v.closed = { reason: String(reason || 'closed').slice(0, 200), at: nowLocalIso() };
      v.events.push({ seq: v.events.length + 1, t: v.events[v.events.length - 1].t, wall: v.closed.at, type: 'log_closed', reason: v.closed.reason });
      this._admin.visitClosed(visitId, v.events.length);
    }
    return {};
  }

  // ----------------------------------------------------- the sandbox's extras
  exampleRecordings() {
    return SPECS.map((s) => ({
      id: s.id, recording_id: recordingIdOf(s), file_name: fileNameOf(s), title: TITLES[s.id] || s.stem,
      duration_s: s.nSamples / s.sfreq, n_channels: s.channels.length,
    }));
  }

  exampleRecording(recordingId) { return exampleRecording(recordingId); }

  get canDownloadRecordings() { return true; }

  async downloadRecordings() {
    return SPECS.map((s) => ({ name: fileNameOf(s), blob: new Blob([syntheticEdfBytes(s)], { type: 'application/octet-stream' }) }));
  }

  /** Everything saved in this browser, as ElectroTag annotation documents plus the logs. */
  resultsDocument() {
    const docs = this.state.submissions.map((s) => {
      const spec = RID.get(s.recording_id);
      const rec = s.recording || (spec ? { sfreq: spec.sfreq, n_samples: spec.nSamples, ch_names: [...spec.channels],
        size_bytes: exampleRecording(s.recording_id).sizeBytes } : { sfreq: 1, n_samples: 0, ch_names: [], size_bytes: 0 });
      const sf = rec.sfreq;
      const used = [...new Set(s.annotations.map((a) => a.label))].map((l) => LABELS.get(l)).filter(Boolean);
      return {
        schema: 'electrotag.annotations', schema_version: '1.0.0',
        recording: { recording_id: s.recording_id, relative_path: s.recording_id, sfreq: sf, n_samples: rec.n_samples,
          first_samp: 0, meas_date: spec ? '2026-01-01T10:00:00+00:00' : null, duration_s: rec.n_samples / sf, ch_names: [...rec.ch_names],
          fingerprint: { algorithm: 'sha256', role: 'eeg', hex: s.sha256, size_bytes: rec.size_bytes } },
        annotator: { annotator_id: s.annotator_id, display_name: this._admin.user(s.annotator_id)?.display_name || '' },
        session: { session_id: `${s.annotator_id}-${s.saved_at}`, mode: s.mode, created_at: s.saved_at, app_version: 'web demonstration',
          confidence: s.confidence_setting || 'optional',
          context: { context_id: s.context_id, attempt: s.attempt, browser_session: s.session, guided: s.guided, practice: s.feedback,
            ...(s.revision ? { revision: s.revision } : {}) } },
        time_conventions: {
          onset_origin: 'first_sample',
          onset: 'Seconds from the first sample stored in the data file (BIDS events.tsv convention; equal to MNE raw.times).',
          sample: '0-based sample index relative to the first stored sample: sample = onset * sfreq.',
          interval: 'Half-open: an annotation covers samples [onset_sample, onset_sample + duration_samples).',
        },
        channel_convention: {
          encoding: 'List of channel names exactly as they appear in the recording.',
          empty_list_means: 'The annotation applies to the whole recording montage, i.e. every channel in recording.ch_names, over the annotated time interval.',
          non_empty_list_means: 'The annotation applies only to the listed channels.',
        },
        label_catalogue: { catalogue_id: 'hed-score-artifacts', labels: used.map((l) => ({ value: l.value, label: l.label, colour: l.colour, short_code: l.short_code, section: l.section })) },
        n_annotations: s.annotations.length,
        annotations: [...s.annotations].sort((a, b) => a.onset_sample - b.onset_sample).map((a) => ({
          annotation_id: a.annotation_id, label: a.label, value: LABELS.get(a.label)?.value ?? null,
          onset: a.onset_sample / sf, duration: a.duration_samples / sf, onset_sample: a.onset_sample,
          duration_samples: a.duration_samples, end_sample: a.onset_sample + a.duration_samples, channels: [...a.channels],
          scope: a.channels.length ? 'channels' : 'whole_montage', created_at: a.created_at, modified_at: a.modified_at,
          confidence: a.confidence ?? null, note: a.note || '',
        })),
        bad_channels: [...(s.bad_channels || [])],
      };
    });
    return {
      schema: 'electrotag.web_demo_results', created_at: nowLocalIso(), note: DEMO_NOTICE,
      annotation_documents: docs,
      interaction_logs: [...this.visits.values()].map((v) => ({ header: v.header, closed: v.closed, events: v.events })),
      quiz_results: Object.entries(this.state.quiz || {}).filter(([, s]) => Object.keys(s.answers).length).map(([key, s]) => ({
        schema: 'electrotag.quiz_result', annotator_id: key.split('|')[0], reference_set_id: QUIZ.set_id,
        // completed as on the desktop: every segment answered (a quiz finished early is incomplete)
        mode: QUIZ.feedback === 'immediate' ? 'practice' : 'assessment', finished: Boolean(s.finished),
        completed: Object.keys(s.answers).length === QUIZ.items.length, started_at: s.started_at, finished_at: s.finished_at || null,
        answers: Object.entries(s.answers).sort((x, y) => (x[1].index || 0) - (y[1].index || 0)).map(([item_id, a]) => ({
          item_id, answer: a.label, correct: a.correct, response_time_s: a.response_time_s ?? null, answered_at: a.answered_at,
          correct_label: (QUIZ.items.find((it) => it.item_id === item_id) || {}).correct_label || null })),
        score: s.score || quizScore(QUIZ.items, s.answers),
      })),
      // as the results zip's problem_reports/ and reviews/ (docs/file_formats.md)
      problem_reports: Object.values(this.state.problems || {}),
      reviews: [...(this.state.reviews || [])],
    };
  }

  async downloadResults() {
    const text = JSON.stringify(this.resultsDocument(), null, 1);
    return [{ name: 'electrotag_demo_results.json', blob: new Blob([text], { type: 'application/json' }) }];
  }

  get hasResults() { return this.state.submissions.length > 0; }

  // ------------------------------------------------------------ administration
  /** The admin area's operations (docs/web/api.md, "Administration"), in this browser: demo_admin.js. */
  async admin(op, body = {}) {
    if (TRAINING_ADMIN_OPS.includes(op)) await this._trainingPart(); // its operations come with it (demo_training_stages.js)
    if (QUESTIONNAIRE_ADMIN_OPS.includes(op)) await this._questionnairePart(); // and these with demo_questionnaire.js
    return this._admin.run(op, body || {});
  }

  // ---------------------------------------------------------------- experts
  /** The expert area's operations (docs/web/api.md, "Experts"), in this browser: demo_expert.js. */
  async expert(op, body = {}) {
    if (!this.experts) {
      const { DemoExpert } = await loadPart('demoExpert');
      this.experts = this.experts || new DemoExpert(this);
    }
    return this.experts.run(op, body || {});
  }

  /** GET /me/feedback: the corrections of the annotator's work and the outcomes of its conflicts, when shown. */
  async myFeedback() {
    this._aid();
    const r = (this._admin.s.settings || {}).review || {};
    const shown = { corrections: r.show_corrections_to_annotators !== false, adjudications: r.show_outcomes_to_annotators !== false };
    const items = async (part) => {
      if (!shown[part]) return [];
      if (!this.experts) {
        const { DemoExpert } = await loadPart('demoExpert');
        this.experts = this.experts || new DemoExpert(this);
      }
      return this.experts.feedback(part);
    };
    return { corrections: { shown: shown.corrections, items: await items('corrections') },
      adjudications: { shown: shown.adjudications, items: await items('adjudications') } };
  }

  /** The training path's stages and snippets (training_path.py), loaded at their first use: demo_training_stages.js. */
  async _trainingPart() {
    if (!this.trainingStages) {
      const { DemoTrainingStages } = await loadPart('demoTraining');
      this.trainingStages = this.trainingStages || new DemoTrainingStages(this);
    }
    return this.trainingStages;
  }

  /** POST /training/stage: skip, finish or resume a stage of the training path. */
  async trainingStage(body = {}) { return (await this._trainingPart()).stageAction(body || {}); }

  /** GET /training/snippets: the artifact snippets of the trainee's set. */
  async trainingSnippets() { return (await this._trainingPart()).snippetsView(); }

  /** Forget everything saved by the sandbox in this browser. */
  reset() {
    this.state = emptyState();
    this._save();
    this.visits.clear();
  }
}
