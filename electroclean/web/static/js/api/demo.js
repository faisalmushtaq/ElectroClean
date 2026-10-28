// The demonstration: the Backend interface of http.js, entirely in the browser.
//
// Three demo accounts (A01 annotates, T01 follows the training programme, ADMIN runs the study in
// the admin area; password "demo"), three built-in example recordings with simulated artifacts
// (synthetic.js), a register of their fingerprints so a downloaded example opened from the
// computer is recognised, drafts and results kept in this browser (and downloadable), the guided
// training rules (training/rules.js) and the practice scoring (training/scoring.js). In a real
// study the server does this work and keeps the experts' answers to itself. The admin area's
// operations (accounts, assignments, recordings added from this computer, settings, reference
// sets, the audit log) work on the same state, in demo_admin.js.

import {
  CATALOGUE, DEFAULT_QUICK_LABELS,
} from './demo_catalogue.js';
import {
  channelType, demoSpecs, exampleNote, makeSyntheticRecording, syntheticEdfBytes, truthAnnotations,
} from '../data/synthetic.js';
import { ApiError } from './http.js';
import { DEMO_NOTICE } from './notice.js';
import { DemoAdmin } from './demo_admin.js';

export { DEMO_NOTICE };
import * as rules from '../training/rules.js';
import { DEFAULT_PASS, describePassRule, practiceFeedback } from '../training/scoring.js';
import { escapeHtml, local, newId, nowLocalIso, session } from '../util.js';
import { sha256Hex } from '../data/sha256.js';

const STATE_KEY = 'electroclean.demo.v1';
const TOKEN_KEY = 'electroclean.demo.token';
export const DEMO_PASSWORD = 'demo';
const FIND_WINDOW_S = 10;

/** The built-in accounts (the admin area can add others, kept in this browser). */
export const ACCOUNTS = Object.freeze({
  A01: { display_name: 'Demo annotator', role: 'annotator', programme: false },
  T01: { display_name: 'Demo trainee', role: 'annotator', programme: true },
  ADMIN: { display_name: 'Demo administrator', role: 'admin', programme: false },
});

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

const STAGE_TITLES = { guided: 'Learn with the experts', practice: 'On your own', assessment: 'Competency assessment' };

/** The answer for a segment without an artifact (electroclean.training.reference.NONE_OPTION). */
export const QUIZ_NONE_OPTION = 'No artifact / none of these';

/** The demonstration's short-segment quiz: segments of the first two examples, with feedback after each answer. */
export const QUIZ = Object.freeze({
  set_id: TRAINING_SET.set_id,
  name: 'Demonstration quiz',
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
      'Slow waves of opposite sign on F7 and F8, largest on HEOG, over four seconds: a slow eye movement.'],
    ['q07', 'demo-01', 50.0, 52.0, QUIZ_NONE_OPTION, [],
      'Only the background EEG: there is no artifact in this segment.'],
  ].map(([item_id, spec, start_s, end_s, correct_label, accepted_labels, explanation]) => Object.freeze({
    item_id, recording_id: recordingIdOf(SPEC_BY_ID.get(spec)), start_s, end_s, correct_label, accepted_labels, explanation, context_s: 2.0,
  })),
});

/** The items in the annotator's own order, the same at every visit (the desktop's item_order, shuffled the demonstration's way). */
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

const LABELS = new Map(CATALOGUE.labels.map((l) => [l.label, l]));

function emptyState() {
  return { version: 1, drafts: {}, done: {}, submissions: [], guided: {}, practice: {}, quiz: {} };
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
    const saved = tokens.get(TOKEN_KEY, null);
    const user = saved ? this._admin.user(saved.annotator_id) : null;
    this.annotatorId = user && user.status === 'active' ? user.annotator_id : null;
    this.visits = new Map();
  }

  get isDemo() { return true; }

  get signedIn() { return Boolean(this.annotatorId); }

  _save() { this.storage.set(STATE_KEY, this.state); }

  _aid() {
    if (!this.annotatorId) throw new ApiError(401, 'not_signed_in', 'Please sign in again.');
    return this.annotatorId;
  }

  _account() { return this._admin.user(this._aid()); }

  /** True when the account follows the demonstration's training programme. */
  _inProgramme(aid) { return this._admin.programmeOf(aid) === TRAINING_SET.set_id; }

  // ------------------------------------------------------------------ signing in
  async getHealth() { return this.health; }

  async login(annotatorId, password) {
    const aid = String(annotatorId || '').trim().toUpperCase();
    const user = this._admin.user(aid);
    if (!user || !this._admin.passwordOk(aid, password)) {
      throw new ApiError(401, 'bad_credentials',
        `The annotator ID or password is not right. In the demonstration, sign in as A01, T01 or ADMIN with the password ${DEMO_PASSWORD}.`);
    }
    if (user.status !== 'active') throw new ApiError(403, 'account_disabled', 'This account has been switched off. Ask the study team.');
    this.annotatorId = aid;
    this._admin.touch(aid);
    const token = `demo-${newId()}`;
    this.tokens.set(TOKEN_KEY, { annotator_id: aid, token });
    return { token, expires_in_s: 43200, annotator_id: aid, display_name: user.display_name, role: user.role };
  }

  async logout() {
    this.annotatorId = null;
    this.tokens.remove(TOKEN_KEY);
    return {};
  }

  async me() {
    const aid = this._aid();
    const acc = this._account();
    if (!acc) throw new ApiError(401, 'not_signed_in', 'Please sign in again.');
    return {
      annotator_id: aid, display_name: acc.display_name, role: acc.role,
      study: this._admin.studyBlock(),
      catalogue: CATALOGUE,
      programme: this._inProgramme(aid) ? { set_id: TRAINING_SET.set_id, name: this._exampleSet().name } : null,
      quizzes: [{ set_id: QUIZ.set_id, name: QUIZ.name, n_items: QUIZ.items.length, finished: Boolean(this._quizState(aid).finished), feedback: QUIZ.feedback }],
    };
  }

  // -------------------------------------------------------------------- quiz
  _quizState(aid) {
    const key = `${aid}|${QUIZ.set_id}`;
    if (!this.state.quiz) this.state.quiz = {};
    if (!this.state.quiz[key]) this.state.quiz[key] = { answers: {}, finished: false, score: null, started_at: nowLocalIso() };
    return this.state.quiz[key];
  }

  _quizOptions() { return [...CATALOGUE.labels.map((l) => l.label), QUIZ_NONE_OPTION]; }

  // The study server's rules (electroclean/web/quiz.py): the same answer sent again is kept once,
  // another label for an answered segment is 409 already_answered (with the kept label), and the
  // correct answers are given only when the annotator may know them.
  async quiz(setId, body = {}) {
    const aid = this._aid();
    const action = body && body.action;
    if (!['get', 'answer', 'finish'].includes(action)) throw new ApiError(400, 'bad_request', 'action must be one of get, answer, finish');
    if (setId !== QUIZ.set_id) throw new ApiError(404, 'no_reference_set', `There is no reference set ${setId} in this study`);
    const st = this._quizState(aid);
    const immediate = QUIZ.feedback === 'immediate';
    const reveal = immediate || st.finished;
    const byId = new Map(QUIZ.items.map((it) => [it.item_id, it]));
    if (action === 'get') {
      const recordings = {};
      for (const it of QUIZ.items) {
        if (recordings[it.recording_id]) continue;
        const spec = RID.get(it.recording_id);
        recordings[it.recording_id] = { ...this._manifest(spec), fingerprint: await this._fingerprint(spec) };
      }
      const options = this._quizOptions();
      return {
        set_id: QUIZ.set_id, name: QUIZ.name, feedback: QUIZ.feedback, finished: Boolean(st.finished),
        items: quizOrder(QUIZ.items, aid, QUIZ.set_id).map((it) => ({
          item_id: it.item_id, recording_id: it.recording_id, file_name: fileNameOf(RID.get(it.recording_id)), start_s: it.start_s,
          end_s: it.end_s, context_s: it.context_s, options: [...options],
        })),
        answered: Object.fromEntries(Object.entries(st.answers).map(([id, a]) => [id, reveal && byId.has(id)
          ? { label: a.label, correct: a.correct, correct_label: byId.get(id).correct_label, explanation: byId.get(id).explanation || null }
          : { label: a.label, correct: null }])),
        feedback: QUIZ.feedback, finished: Boolean(st.finished), score: st.finished ? st.score : null, n_items: QUIZ.items.length,
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
    // finish: also before every segment is answered (an incomplete result, as on the desktop
    // when an annotator stops early); finishing again gives the same score
    if (!st.finished) {
      st.finished = true;
      st.finished_at = nowLocalIso();
      st.score = quizScore(QUIZ.items, st.answers);
      this._save();
    }
    return { score: st.score };
  }

  // ------------------------------------------------------------ assignments
  _assignmentsFor(aid) {
    if (this._inProgramme(aid)) {
      return [
        ...TRAINING_SET.guided.map((g) => ({ rid: g.rid, mode: 'guided', context_id: TRAINING_SET.set_id })),
        ...TRAINING_SET.practice.map((rid) => ({ rid, mode: 'practice', context_id: TRAINING_SET.set_id })),
      ];
    }
    return this._admin.standardAssignments(aid).filter((a) => this._recordingInfo(a.rid));
  }

  /** What saving and listing need of a recording: a built-in example or one added in the admin area. */
  _recordingInfo(rid, rec = null) {
    const spec = RID.get(rid);
    if (spec && (!rec || rec.builtin)) {
      return { rid, builtin: true, spec, file_name: fileNameOf(spec), format: 'edf', sfreq: spec.sfreq, n_samples: spec.nSamples,
        ch_names: [...spec.channels], size_bytes: exampleRecording(rid).sizeBytes, stem: spec.stem };
    }
    const r = rec && rec.manifest ? rec : this._admin.registered(rid);
    if (!r) return null;
    const m = r.manifest;
    return { rid, builtin: false, record: r, file_name: m.file_name, format: m.format, sfreq: Number(m.timing.sfreq),
      n_samples: Number(m.timing.n_samples), ch_names: [...m.ch_names], size_bytes: Number(r.size_bytes),
      stem: (m.files && m.files.stem) || String(m.file_name).replace(/(_eeg)?\.[^.]+$/, '') };
  }

  // For the admin area (demo_admin.js).
  _builtIn() {
    return {
      recordings: SPECS.map((s) => ({ recording_id: recordingIdOf(s), file_name: fileNameOf(s), sfreq: s.sfreq, n_samples: s.nSamples,
        n_channels: s.channels.length, size_bytes: exampleRecording(recordingIdOf(s)).sizeBytes })),
      trainingSet: TRAINING_SET,
    };
  }

  _trainingSetId() { return TRAINING_SET.set_id; }

  _truthOf(rid) { const spec = RID.get(rid); return spec ? truthAnnotations(spec) : []; }

  _exampleNoteOf(rid, a) { const spec = RID.get(rid); return spec ? exampleNote(a.label, a.duration_samples / spec.sfreq, a.channels) : ''; }

  /** The demonstration training set as the admin area keeps it (its pass mark and matching can be changed). */
  _exampleSet() {
    return this._admin.s.sets.find((x) => x.set_id === TRAINING_SET.set_id) ||
      { name: TRAINING_SET.name, practice_pass: TRAINING_SET.pass, guided_tolerance: null, recordings: [] };
  }

  /** The types on the number keys, as the coach names them ("press 1"). */
  _quickKeys() {
    const chosen = this._admin.s.settings.annotation.quick_labels;
    return Object.fromEntries((chosen && chosen.length ? chosen : DEFAULT_QUICK_LABELS).map((n, i) => [n, i + 1]));
  }

  _passRule() { return { ...TRAINING_SET.pass, ...(this._exampleSet().practice_pass || {}) }; }

  _tolerance() { return { ...rules.DEFAULT_TOLERANCE, ...(this._exampleSet().guided_tolerance || {}) }; }

  _key(aid, rid, mode, ctx) { return `${aid}|${rid}|${mode}|${ctx || ''}`; }

  _status(aid, a) {
    const key = this._key(aid, a.rid, a.mode, a.context_id);
    if (this.state.done[key]) return 'done';
    if (this.state.drafts[key]) return 'in_progress';
    if (a.mode === 'guided' && this.state.guided[`${aid}|${a.rid}`]?.index > 0) return 'in_progress';
    return 'todo';
  }

  _locked(aid, a) {
    if (a.mode !== 'practice') return false;
    return TRAINING_SET.guided.some((g) => !this.state.done[this._key(aid, g.rid, 'guided', TRAINING_SET.set_id)]);
  }

  _practicePassed(aid) {
    return TRAINING_SET.practice.some((rid) => (this.state.practice[`${aid}|${rid}`] || []).some((r) => r.passed));
  }

  async assignments() {
    const aid = this._aid();
    const items = this._assignmentsFor(aid).map((a) => {
      const info = this._recordingInfo(a.rid);
      return {
        recording_id: a.rid, file_name: info.file_name, format: info.format, mode: a.mode, context_id: a.context_id,
        status: this._status(aid, a), duration_s: info.n_samples / info.sfreq, n_channels: info.ch_names.length,
        size_bytes: info.size_bytes,
      };
    });
    return { items, next: this._next(aid) };
  }

  _next(aid) {
    const list = this._assignmentsFor(aid);
    if (this._inProgramme(aid)) {
      const t = this._trainingNext(aid);
      return t ? t.recording_id : null;
    }
    const open = list.find((a) => this._status(aid, a) === 'in_progress') || list.find((a) => this._status(aid, a) === 'todo');
    return open ? open.rid : null;
  }

  // ---------------------------------------------------------------- matching
  _manifest(spec) {
    const rec = exampleRecording(recordingIdOf(spec));
    const sf = spec.sfreq;
    return {
      recording_id: recordingIdOf(spec), file_name: fileNameOf(spec), format: 'edf',
      sfreq: sf, n_samples: spec.nSamples, duration_s: spec.nSamples / sf,
      ch_names: [...spec.channels], hidden_channels: [],
      channel_types: Object.fromEntries(spec.channels.map((c) => [c, channelType(c)])),
      bad_channels: [],
      original_events: spec.events.map((e) => ({ onset_sample: Math.round(e.onsetS * sf), duration_samples: 0, label: e.label })),
      gaps: spec.gaps.map((g) => [...g]),
      display: { scalings: { ...this._admin.s.settings.display.scalings }, warnings: [...rec.warnings] },
      fingerprint: null,
    };
  }

  async _fingerprint(spec) {
    const fp = await exampleRecording(recordingIdOf(spec)).fingerprint();
    return { algorithm: 'sha256', role: 'eeg', hex: fp.hex, size_bytes: fp.sizeBytes };
  }

  async match(body) {
    const aid = this._aid();
    const sha = String(body.sha256 || '').toLowerCase();
    let found = null;
    for (const spec of SPECS) {
      const rec = exampleRecording(recordingIdOf(spec));
      if (body.size_bytes !== rec.sizeBytes) continue;
      const fp = await this._fingerprint(spec);
      if (fp.hex === sha) { found = { spec, fp, exact: true }; break; }
    }
    const added = this._admin.registeredRecordings();
    if (!found) {
      const reg = added.find((r) => r.sha256 === sha && Number(r.size_bytes) === Number(body.size_bytes));
      if (reg) found = { reg, exact: true };
    }
    if (!found) {
      const spec = SPECS.find((s) => s.sfreq === Number(body.sfreq) && s.nSamples === Number(body.n_samples) &&
        fileNameOf(s) === body.file_name && JSON.stringify(s.channels) === JSON.stringify(body.ch_names || []));
      if (spec) found = { spec, fp: await this._fingerprint(spec), exact: false };
    }
    if (!found) {
      const reg = added.find((r) => Number(r.sfreq) === Number(body.sfreq) && Number(r.n_samples) === Number(body.n_samples) &&
        r.file_name === body.file_name && JSON.stringify(r.manifest.ch_names) === JSON.stringify(body.ch_names || []));
      if (reg) found = { reg, exact: false };
    }
    const base = { recording_id: null, mode: 'standard', context_id: '', manifest: null, draft: null, differences: [] };
    if (!found) {
      return { ...base, status: 'unknown',
        message: 'This file is not one of the recordings of this study. You can still look at it and try the tools, ' +
          'but nothing you mark is saved.' };
    }
    const rid = found.spec ? recordingIdOf(found.spec) : found.reg.recording_id;
    const fileName = found.spec ? fileNameOf(found.spec) : found.reg.file_name;
    const assignment = this._assignmentsFor(aid).find((a) => a.rid === rid);
    if (!assignment) {
      return { ...base, status: 'not_assigned', recording_id: rid, message: 'This recording of the study is not one of yours at the moment.' };
    }
    const { mode, context_id: ctx } = assignment;
    if (this._locked(aid, assignment)) {
      return { ...base, status: 'not_assigned', recording_id: rid, mode, context_id: ctx,
        message: 'This recording belongs to a later stage of your training. Continue from your training path.' };
    }
    const key = this._key(aid, rid, mode, ctx);
    const repeatable = mode === 'practice' && !this._practicePassed(aid);
    if (this.state.done[key] && !repeatable) {
      return { ...base, status: 'done', recording_id: rid, mode, context_id: ctx,
        message: `You have already finished ${fileName}.` };
    }
    const manifest = found.spec ? { ...this._manifest(found.spec), fingerprint: found.fp } : this._admin.publicManifestOf(found.reg);
    const draft = this.state.drafts[key] || null;
    if (found.exact) {
      return { ...base, status: 'matched', recording_id: rid, mode, context_id: ctx, manifest, draft,
        message: `This is ${fileName}, one of your recordings.` };
    }
    const studySize = manifest.fingerprint.size_bytes;
    const differences = ['Its fingerprint (SHA-256) differs from the study\'s copy, so its contents are not exactly the same.'];
    if (body.size_bytes !== studySize) {
      differences.push(`Its size is ${Number(body.size_bytes).toLocaleString('en-GB')} bytes; the study's copy has ${studySize.toLocaleString('en-GB')}.`);
    }
    return { ...base, status: 'matched_metadata', recording_id: rid, mode, context_id: ctx, manifest, draft, differences,
      message: `This file has the name, sampling rate, length and channels of ${fileName}, but it is not exactly the study's copy.` };
  }

  // ------------------------------------------------------------------- drafts
  async putDraft(recordingId, mode, contextId, draft) {
    const aid = this._aid();
    const saved_at = nowLocalIso();
    this.state.drafts[this._key(aid, recordingId, mode, contextId)] = { ...draft, saved_at };
    this._save();
    return { saved_at };
  }

  async deleteDraft(recordingId, mode, contextId) {
    const aid = this._aid();
    delete this.state.drafts[this._key(aid, recordingId, mode, contextId)];
    if (mode === 'guided') delete this.state.guided[`${aid}|${recordingId}`]; // starting afresh
    this._save();
    return {};
  }

  // ------------------------------------------------------------------- saving
  _validate(annotations, manifest) {
    const chans = new Set(manifest.ch_names);
    const shortest = Math.max(1, Number(this._admin.s.settings.annotation.min_duration_samples) || 1);
    for (const a of annotations || []) {
      const fail = (why) => { throw new ApiError(422, 'invalid_annotation', `${a.label || 'An annotation'} at sample ${a.onset_sample}: ${why}`); };
      if (!a.annotation_id) fail('it has no identifier');
      if (!LABELS.has(a.label)) fail('the artifact type is not in the catalogue');
      if (!Number.isInteger(a.onset_sample) || !Number.isInteger(a.duration_samples)) fail('onset and duration must be whole samples');
      if (a.onset_sample < 0 || a.duration_samples < 1 || a.onset_sample + a.duration_samples > manifest.n_samples) fail('it lies outside the recording');
      if (a.duration_samples < shortest) fail(`it is shorter than the study's shortest annotation (${shortest} samples)`);
      if (!Array.isArray(a.channels) || a.channels.some((c) => !chans.has(c))) fail('a channel is not in the recording');
    }
  }

  async submit(body) {
    const aid = this._aid();
    const rid = body.recording_id;
    const info = this._recordingInfo(rid);
    const spec = info && info.builtin ? info.spec : null;
    const assignment = this._assignmentsFor(aid).find((a) => a.rid === rid && a.mode === body.mode);
    if (!info || !assignment) throw new ApiError(404, 'not_found', 'This recording is not one of yours.');
    const key = this._key(aid, rid, body.mode, body.context_id);
    if (this.state.done[key] && !(body.mode === 'practice' && !this._practicePassed(aid))) {
      throw new ApiError(409, 'already_done', 'This recording has already been saved.');
    }
    const manifest = spec ? this._manifest(spec) : this._admin.publicManifestOf(info.record);
    this._validate(body.annotations, manifest);
    let feedback = null;
    if (body.mode === 'guided') this._checkGuidedComplete(aid, rid, body.annotations);
    if (body.mode === 'practice') {
      feedback = practiceFeedback(truthAnnotations(spec), body.annotations, { passRule: this._passRule() });
      feedback.summary_html = summaryHtml(feedback);
      feedback.demo_notice = DEMO_NOTICE;
      const list = this.state.practice[`${aid}|${rid}`] || [];
      list.push({ event_f1: feedback.metrics.event_f1, label_accuracy: feedback.metrics.label_accuracy, passed: feedback.passed, at: nowLocalIso() });
      this.state.practice[`${aid}|${rid}`] = list;
    }
    const attempt = this.state.submissions.filter((s) => s.key === key).length + 1;
    const saved_at = nowLocalIso();
    this.state.submissions.push({
      key, annotator_id: aid, recording_id: rid, mode: body.mode, context_id: body.context_id || '', attempt, saved_at,
      annotations: body.annotations, session: body.session || {}, sha256: body.sha256 || '',
      recording: { file_name: info.file_name, sfreq: info.sfreq, n_samples: info.n_samples, ch_names: info.ch_names, size_bytes: info.size_bytes },
      guided: body.mode === 'guided' ? this.state.guided[`${aid}|${rid}`]?.summary || null : null,
      feedback: feedback ? { passed: feedback.passed, metrics: feedback.metrics } : null,
    });
    this.state.done[key] = { saved_at, attempt };
    delete this.state.drafts[key];
    this._save();
    const stem = info.stem;
    const tag = `annotator-${aid}`;
    return {
      saved: true, attempt, feedback, next: this._next(aid), demo_notice: DEMO_NOTICE,
      files: [`${stem}_${tag}_annotations.json`, `${stem}_${tag}_events.tsv`, `${stem}_${tag}_session.json`],
    };
  }

  // ---------------------------------------------------------------- training
  _trainingNext(aid) {
    const g = TRAINING_SET.guided;
    const ctx = TRAINING_SET.set_id;
    const gi = g.findIndex((x) => !this.state.done[this._key(aid, x.rid, 'guided', ctx)]);
    if (gi >= 0) {
      return { stage: 'guided', recording_id: g[gi].rid, label: `Start recording ${gi + 1} of ${g.length}`,
        text: `Next: ${STAGE_TITLES.guided}, recording ${gi + 1} of ${g.length}.` };
    }
    if (!this._practicePassed(aid)) {
      const p = TRAINING_SET.practice;
      const pi = p.findIndex((rid) => !this.state.done[this._key(aid, rid, 'practice', ctx)]);
      if (pi >= 0) {
        return { stage: 'practice', recording_id: p[pi], label: 'Start a practice recording',
          text: `Next: ${STAGE_TITLES.practice}, practice recording ${pi + 1} of ${p.length}.` };
      }
      return { stage: 'practice', recording_id: p[0], label: 'Try a practice recording again', repeat: true,
        text: 'Not passed yet. Try a practice recording again; the review shows what you missed.' };
    }
    return null;
  }

  async training() {
    return this._trainingView(this._aid());
  }

  /** GET /training for one account (the admin area's progress shows it for every trainee). */
  _trainingView(aid) {
    if (!this._inProgramme(aid)) throw new ApiError(404, 'no_programme', 'You are not in a training programme.');
    const ctx = TRAINING_SET.set_id;
    const gDone = TRAINING_SET.guided.filter((g) => this.state.done[this._key(aid, g.rid, 'guided', ctx)]);
    const summaries = TRAINING_SET.guided.map((g) => this.state.guided[`${aid}|${g.rid}`]?.summary).filter(Boolean);
    const started = TRAINING_SET.guided.some((g) => this.state.guided[`${aid}|${g.rid}`]);
    const gStatus = gDone.length === TRAINING_SET.guided.length ? 'completed' : (gDone.length || started) ? 'in_progress' : 'available';
    const attempts = TRAINING_SET.practice.flatMap((rid) => this.state.practice[`${aid}|${rid}`] || []);
    const passed = attempts.some((r) => r.passed);
    const pStatus = gStatus !== 'completed' ? 'locked' : passed ? 'completed' : attempts.length ? 'in_progress' : 'available';
    const pDone = TRAINING_SET.practice.filter((rid) => this.state.done[this._key(aid, rid, 'practice', ctx)]);
    const sum = (k) => summaries.reduce((a, s) => a + (s[k] || 0), 0);
    const practiceTime = this.state.submissions.filter((s) => s.annotator_id === aid && s.mode === 'practice')
      .reduce((a, s) => a + (s.session.elapsed_s || 0), 0);
    return {
      set_id: TRAINING_SET.set_id, name: this._exampleSet().name,
      stages: [
        { key: 'guided', title: STAGE_TITLES.guided, status: gStatus, done: gDone.length, total: TRAINING_SET.guided.length,
          stars: sum('stars'), max_stars: sum('max_stars'), best_score: null, time_s: sum('time_s') },
        { key: 'practice', title: STAGE_TITLES.practice, status: pStatus, done: pDone.length, total: TRAINING_SET.practice.length,
          stars: 0, max_stars: 0, best_score: attempts.length ? Math.max(...attempts.map((r) => r.event_f1)) : null,
          best_label_accuracy: attempts.length ? Math.max(...attempts.map((r) => r.label_accuracy)) : null,
          pass_rule: describePassRule(this._passRule()), time_s: practiceTime },
        { key: 'assessment', title: STAGE_TITLES.assessment, status: 'not_used', done: 0, total: 0, stars: 0, max_stars: 0,
          best_score: null, time_s: 0 },
      ],
      next: this._trainingNext(aid),
    };
  }

  _guidedSetup(rid) {
    const spec = RID.get(rid);
    const entry = TRAINING_SET.guided.find((g) => g.rid === rid);
    if (!spec || !entry) throw new ApiError(404, 'not_found', 'This is not a guided training recording.');
    const chosen = (this._exampleSet().recordings || []).find((r) => r.recording_id === rid);
    const guidance = chosen && ['show', 'find', 'find_unnamed'].includes(chosen.guidance) ? chosen.guidance : entry.guidance;
    const truth = truthAnnotations(spec);
    const notes = Object.fromEntries(truth.map((a) => [a.annotation_id,
      this._admin.guidedNote(TRAINING_SET.set_id, a.annotation_id) ?? exampleNote(a.label, a.duration_samples / spec.sfreq, a.channels)]));
    return { spec, guidance, steps: rules.buildSteps(truth, notes), sfreq: spec.sfreq };
  }

  _guidedState(aid, rid) {
    const k = `${aid}|${rid}`;
    if (!this.state.guided[k]) {
      this.state.guided[k] = { index: 0, matched: {}, failed: {}, shown: [], stars: {}, seconds: {}, step_t0: Date.now(),
        signature: null, last: null, complete: false, summary: null };
    }
    return this.state.guided[k];
  }

  _stepJson(setup, i) {
    const { spec, guidance, steps, sfreq } = setup;
    const t = steps[i].target;
    const named = guidance !== 'find_unnamed';
    const window = Number(this._admin.s.settings.display.duration_s) || 10;
    const dur = spec.nSamples / sfreq;
    const t0 = t.onset_sample / sfreq;
    const t1 = (t.onset_sample + t.duration_samples) / sfreq;
    let view = null;
    if (guidance === 'show') {
      const start = (t1 - t0) > window ? t0 : t0 - (window - (t1 - t0)) / 2;
      view = { start_s: Math.min(Math.max(0, start), Math.max(0, dur - window)), duration_s: window };
    } else if (guidance === 'find') {
      const w = Math.max(window, FIND_WINDOW_S);
      const share = 0.15 + 0.7 * ((i * 0.618) % 1.0);
      const start = t1 - t0 >= w - 1 ? t0 - 0.5 : t0 - share * (w - (t1 - t0));
      view = { start_s: Math.min(Math.max(0, start), Math.max(0, dur - w)), duration_s: w };
    }
    return {
      step: i + 1,
      instruction: rules.instruction(t.label, guidance),
      label: named ? t.label : null,
      description: named ? (LABELS.get(t.label)?.description || '') : '',
      note: named ? (steps[i].note || null) : null,
      ghost: guidance === 'show' ? { onset_sample: t.onset_sample, duration_samples: t.duration_samples, channels: [...t.channels] } : null,
      view,
    };
  }

  async guided(recordingId) {
    const aid = this._aid();
    const setup = this._guidedSetup(recordingId);
    const st = this._guidedState(aid, recordingId);
    this._save();
    const completed = Object.keys(st.matched).map(Number).sort((a, b) => a - b)
      .map((i) => ({ step: i + 1, stars: st.stars[i], annotation_id: st.matched[i] }));
    return {
      n_steps: setup.steps.length, guidance: setup.guidance,
      tolerance: { seconds: this._tolerance().seconds, fraction: this._tolerance().fraction,
        channel_jaccard: this._tolerance().channel_jaccard },
      completed,
      current: st.complete || st.index >= setup.steps.length ? null : this._stepJson(setup, st.index),
      summary: st.summary,
      demo_notice: DEMO_NOTICE,
    };
  }

  _check(setup, st, annotations) {
    const { steps, sfreq } = setup;
    const step = steps[st.index];
    const result = rules.checkStep(step, annotations, sfreq, this._tolerance(),
      { taken: new Set(Object.values(st.matched)), quickKeys: this._quickKeys() });
    const extra = rules.extras(steps, annotations, st.matched, result, st.index);
    return { result, extra };
  }

  async guidedCheck(recordingId, { step, annotations }) {
    const aid = this._aid();
    const setup = this._guidedSetup(recordingId);
    const st = this._guidedState(aid, recordingId);
    if (st.complete || st.index >= setup.steps.length) {
      const extra = rules.extras(setup.steps, annotations, st.matched);
      return { matched: true, candidate_id: null, problems: extra.length ? ['extra'] : [],
        messages: extra.length ? [`One more thing: nothing is marked at ${(extra[0].onset_sample / setup.sfreq).toFixed(2)}–` +
          `${((extra[0].onset_sample + extra[0].duration_samples) / setup.sfreq).toFixed(2)} s in the experts' annotations. Delete it before you save.`]
          : ['Everything matches the experts.'],
        extras: extra.map((a) => a.annotation_id), can_continue: false, stars: null };
    }
    if (Number(step) !== st.index + 1) throw new ApiError(409, 'wrong_step', 'This step has changed. The coach is showing the current one.');
    const { result, extra } = this._check(setup, st, annotations);
    const signature = JSON.stringify(annotations.map((a) => [a.annotation_id, a.label, a.onset_sample, a.duration_samples, a.channels]));
    if (signature !== st.signature && st.signature !== null && result.candidate_id && !result.matched) {
      st.failed[st.index] = (st.failed[st.index] || 0) + 1;
    }
    st.signature = signature;
    st.last = annotations;
    this._save();
    const ok = result.matched && !extra.length;
    return {
      matched: result.matched, candidate_id: result.candidate_id,
      problems: extra.length ? [...result.problems.filter((p) => p !== 'missing'), 'extra'] : result.problems,
      messages: extra.length ? [rules.extraMessage(extra[0], setup.steps, setup.sfreq)] : result.messages,
      extras: extra.map((a) => a.annotation_id), can_continue: ok,
      stars: ok ? rules.starsFor(st.failed[st.index] || 0, st.shown.includes(st.index)) : null,
      deltas: result.deltas,
    };
  }

  async guidedContinue(recordingId, { step }) {
    const aid = this._aid();
    const setup = this._guidedSetup(recordingId);
    const st = this._guidedState(aid, recordingId);
    if (st.complete) return { complete: true, summary: st.summary };
    if (Number(step) !== st.index + 1) throw new ApiError(409, 'wrong_step', 'This step has changed. The coach is showing the current one.');
    const { result, extra } = this._check(setup, st, st.last || []);
    if (!result.matched || extra.length) throw new ApiError(409, 'not_matched', 'Match this artifact first.');
    const i = st.index;
    st.matched[i] = result.candidate_id || '';
    st.stars[i] = rules.starsFor(st.failed[i] || 0, st.shown.includes(i));
    st.seconds[i] = Math.max(0, (Date.now() - st.step_t0) / 1000);
    st.index += 1;
    st.step_t0 = Date.now();
    st.signature = null;
    if (st.index >= setup.steps.length) {
      const n = setup.steps.length;
      st.complete = true;
      st.summary = {
        steps: n, stars: Object.values(st.stars).reduce((a, b) => a + b, 0), max_stars: rules.STARS_FIRST * n,
        attempts: Object.keys(st.stars).reduce((a, k) => a + (st.failed[k] || 0) + (st.shown.includes(Number(k)) ? 0 : 1), 0),
        shown: st.shown.length,
        time_s: Math.round(Object.values(st.seconds).reduce((a, b) => a + b, 0) * 1000) / 1000,
      };
      this._save();
      return { complete: true, summary: st.summary };
    }
    this._save();
    return this._stepJson(setup, st.index);
  }

  async guidedShowMe(recordingId, { step }) {
    const aid = this._aid();
    const setup = this._guidedSetup(recordingId);
    const st = this._guidedState(aid, recordingId);
    if (Number(step) !== st.index + 1 || st.complete) throw new ApiError(409, 'wrong_step', 'This step has changed. The coach is showing the current one.');
    if (!st.shown.includes(st.index)) st.shown.push(st.index);
    this._save();
    const t = setup.steps[st.index].target;
    const stamp = nowLocalIso();
    return {
      ghost: { onset_sample: t.onset_sample, duration_samples: t.duration_samples, channels: [...t.channels] },
      annotation: { annotation_id: newId(), label: t.label, onset_sample: t.onset_sample, duration_samples: t.duration_samples,
        channels: [...t.channels], created_at: stamp, modified_at: stamp },
    };
  }

  _checkGuidedComplete(aid, rid, annotations) {
    const setup = this._guidedSetup(rid);
    const st = this._guidedState(aid, rid);
    if (!st.complete) {
      throw new ApiError(422, 'guided_incomplete',
        `Match each of the experts' annotations first: you are at step ${st.index + 1} of ${setup.steps.length}.`);
    }
    const anns = annotations || [];
    for (let i = 0; i < setup.steps.length; i++) {
      const others = new Set(Object.entries(st.matched).filter(([k]) => Number(k) !== i).map(([, v]) => v));
      const r = rules.checkStep(setup.steps[i], anns, setup.sfreq, this._tolerance(), { taken: others, quickKeys: this._quickKeys() });
      if (!r.matched) {
        throw new ApiError(422, 'guided_changed', `Step ${i + 1} (${setup.steps[i].target.label}) no longer matches the ` +
          `experts' annotation:\n\n${r.messages.join('\n')}\n\nPut it right, then save again.`);
      }
      st.matched[i] = r.candidate_id || st.matched[i];
    }
    if (rules.extras(setup.steps, anns, st.matched).length) {
      throw new ApiError(422, 'guided_extra', 'Some of your annotations are not in the experts\' annotations. Delete them before you save.');
    }
  }

  // ---------------------------------------------------------- interaction log
  async openVisit(body) {
    const aid = this._aid();
    const visit_id = `${aid}-${Date.now().toString(36)}-${newId().slice(0, 6)}`;
    const started_at = nowLocalIso();
    this.visits.set(visit_id, {
      header: { visit_id, annotator_id: aid, started_at, client: 'web', programme: Boolean(body && body.programme),
        browser: body && body.client },
      events: [], closed: null,
    });
    this._admin.visitOpened({ visit_id, annotator_id: aid, mode: (body && body.mode) || (body && body.programme ? 'training' : 'standard'),
      context_id: (body && body.context_id) || '', started_at, closed_at: null, n_events: 0 });
    return { visit_id, logging: { ...this._admin.s.settings.logging } };
  }

  async sendEvents(visitId, events) {
    const v = this.visits.get(visitId);
    if (!v) throw new ApiError(404, 'no_visit', 'This visit is closed.');
    for (const e of events || []) {
      if (v.events.length >= 50000) break;
      v.events.push({ seq: v.events.length + 1, ...e });
    }
    return {};
  }

  async closeVisit(visitId, reason) {
    const v = this.visits.get(visitId);
    if (v) v.closed = { reason, at: nowLocalIso() };
    this._admin.visitClosed(visitId, v ? v.events.length : 0);
    return {};
  }

  // ----------------------------------------------------- demonstration extras
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

  /** Everything saved in this browser, as ElectroClean annotation documents plus the logs. */
  resultsDocument() {
    const docs = this.state.submissions.map((s) => {
      const spec = RID.get(s.recording_id);
      const rec = s.recording || (spec ? { sfreq: spec.sfreq, n_samples: spec.nSamples, ch_names: [...spec.channels],
        size_bytes: exampleRecording(s.recording_id).sizeBytes } : { sfreq: 1, n_samples: 0, ch_names: [], size_bytes: 0 });
      const sf = rec.sfreq;
      const used = [...new Set(s.annotations.map((a) => a.label))].map((l) => LABELS.get(l)).filter(Boolean);
      return {
        schema: 'electroclean.annotations', schema_version: '1.0.0',
        recording: { recording_id: s.recording_id, relative_path: s.recording_id, sfreq: sf, n_samples: rec.n_samples,
          first_samp: 0, meas_date: spec ? '2026-01-01T10:00:00+00:00' : null, duration_s: rec.n_samples / sf, ch_names: [...rec.ch_names],
          fingerprint: { algorithm: 'sha256', role: 'eeg', hex: s.sha256, size_bytes: rec.size_bytes } },
        annotator: { annotator_id: s.annotator_id, display_name: this._admin.user(s.annotator_id)?.display_name || ACCOUNTS[s.annotator_id]?.display_name || '' },
        session: { session_id: `${s.annotator_id}-${s.saved_at}`, mode: s.mode, created_at: s.saved_at, app_version: 'web demonstration',
          context: { context_id: s.context_id, attempt: s.attempt, browser_session: s.session, guided: s.guided, practice: s.feedback } },
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
        })),
      };
    });
    return {
      schema: 'electroclean.web_demo_results', created_at: nowLocalIso(), note: DEMO_NOTICE,
      annotation_documents: docs,
      interaction_logs: [...this.visits.values()].map((v) => ({ header: v.header, closed: v.closed, events: v.events })),
      quiz_results: Object.entries(this.state.quiz || {}).filter(([, s]) => Object.keys(s.answers).length).map(([key, s]) => ({
        schema: 'electroclean.quiz_result', annotator_id: key.split('|')[0], reference_set_id: QUIZ.set_id,
        // completed as on the desktop: every segment answered (a quiz finished early is incomplete)
        mode: QUIZ.feedback === 'immediate' ? 'practice' : 'assessment', finished: Boolean(s.finished),
        completed: Object.keys(s.answers).length === QUIZ.items.length, started_at: s.started_at, finished_at: s.finished_at || null,
        answers: Object.entries(s.answers).sort((x, y) => (x[1].index || 0) - (y[1].index || 0)).map(([item_id, a]) => ({
          item_id, answer: a.label, correct: a.correct, response_time_s: a.response_time_s ?? null, answered_at: a.answered_at,
          correct_label: (QUIZ.items.find((it) => it.item_id === item_id) || {}).correct_label || null })),
        score: s.score || quizScore(QUIZ.items, s.answers),
      })),
    };
  }

  async downloadResults() {
    const text = JSON.stringify(this.resultsDocument(), null, 1);
    return [{ name: 'electroclean_demo_results.json', blob: new Blob([text], { type: 'application/json' }) }];
  }

  get hasResults() { return this.state.submissions.length > 0; }

  // ------------------------------------------------------------ administration
  /** The admin area's operations (docs/web/api.md, "Administration"), in this browser: demo_admin.js. */
  async admin(op, body = {}) { return this._admin.run(op, body || {}); }

  /** Forget everything saved by the demonstration in this browser. */
  reset() {
    this.state = emptyState();
    this._save();
    this.visits.clear();
  }
}

function summaryHtml(fb) {
  const pc = (v) => (v === null || v === undefined || Number.isNaN(v) ? '–' : `${Math.round(v * 100)}%`);
  const m = fb.metrics;
  const missed = fb.flags.filter((f) => f.kind === 'MISSED').length;
  const extra = fb.flags.filter((f) => f.kind === 'EXTRA').length;
  const type = fb.flags.filter((f) => f.kind === 'TYPE').length;
  return `<p>You found <b>${m.found}</b> of the experts' <b>${m.reference_events}</b> artifacts ` +
    `(${escapeHtml(pc(m.reference_events ? m.found / m.reference_events : NaN))} of them) and marked <b>${m.your_events}</b>.</p>` +
    '<table><tr><th>Finding the artifacts (F1)</th><td>' + escapeHtml(pc(m.event_f1)) + '</td></tr>' +
    '<tr><th>Right type, of those found</th><td>' + escapeHtml(pc(m.label_accuracy)) + '</td></tr>' +
    `<tr><th>Missed</th><td>${missed}</td></tr><tr><th>Extra</th><td>${extra}</td></tr>` +
    `<tr><th>Another type</th><td>${type}</td></tr></table>`;
}
