// The demonstration: the Backend interface of http.js, entirely in the browser.
//
// Two demo accounts (A01 annotates, T01 follows the training programme; password "demo"), three
// built-in example recordings with simulated artifacts (synthetic.js), a register of their
// fingerprints so a downloaded example opened from the computer is recognised, drafts and
// results kept in this browser (and downloadable), the guided training rules (training/rules.js)
// and the practice scoring (training/scoring.js). In a real study the server does this work and
// keeps the experts' answers to itself.

import {
  CATALOGUE, DEFAULT_DISPLAY, DEFAULT_FILTERS, DEFAULT_LOGGING, DEFAULT_QUICK_LABELS, DEFAULT_SCALINGS,
} from './demo_catalogue.js';
import {
  channelType, demoSpecs, exampleNote, makeSyntheticRecording, syntheticEdfBytes, truthAnnotations,
} from '../data/synthetic.js';
import { ApiError } from './http.js';
import { DEMO_NOTICE } from './notice.js';

export { DEMO_NOTICE };
import * as rules from '../training/rules.js';
import { DEFAULT_PASS, describePassRule, practiceFeedback } from '../training/scoring.js';
import { escapeHtml, local, newId, nowLocalIso, session } from '../util.js';

const STATE_KEY = 'electroclean.demo.v1';
const TOKEN_KEY = 'electroclean.demo.token';
export const DEMO_PASSWORD = 'demo';
const FIND_WINDOW_S = 10;

export const ACCOUNTS = Object.freeze({
  A01: { display_name: 'Demo annotator', role: 'annotator', programme: false },
  T01: { display_name: 'Demo trainee', role: 'annotator', programme: true },
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

function quickKeys() {
  return Object.fromEntries(DEFAULT_QUICK_LABELS.map((n, i) => [n, i + 1]));
}

const LABELS = new Map(CATALOGUE.labels.map((l) => [l.label, l]));

function emptyState() {
  return { version: 1, drafts: {}, done: {}, submissions: [], guided: {}, practice: {} };
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
    const saved = tokens.get(TOKEN_KEY, null);
    this.annotatorId = saved && ACCOUNTS[saved.annotator_id] ? saved.annotator_id : null;
    this.visits = new Map();
  }

  get isDemo() { return true; }

  get signedIn() { return Boolean(this.annotatorId); }

  _save() { this.storage.set(STATE_KEY, this.state); }

  _aid() {
    if (!this.annotatorId) throw new ApiError(401, 'not_signed_in', 'Please sign in again.');
    return this.annotatorId;
  }

  _account() { return ACCOUNTS[this._aid()]; }

  // ------------------------------------------------------------------ signing in
  async getHealth() { return this.health; }

  async login(annotatorId, password) {
    const aid = String(annotatorId || '').trim().toUpperCase();
    if (!ACCOUNTS[aid] || password !== DEMO_PASSWORD) {
      throw new ApiError(401, 'bad_credentials',
        'The annotator ID or password is not right. In the demonstration, sign in as A01 or T01 with the password demo.');
    }
    this.annotatorId = aid;
    const token = `demo-${newId()}`;
    this.tokens.set(TOKEN_KEY, { annotator_id: aid, token });
    return { token, expires_in_s: 43200, annotator_id: aid, display_name: ACCOUNTS[aid].display_name, role: ACCOUNTS[aid].role };
  }

  async logout() {
    this.annotatorId = null;
    this.tokens.remove(TOKEN_KEY);
    return {};
  }

  async me() {
    const aid = this._aid();
    const acc = ACCOUNTS[aid];
    const { method, iir_order, ...filters } = DEFAULT_FILTERS; // eslint-disable-line no-unused-vars
    return {
      annotator_id: aid, display_name: acc.display_name, role: acc.role,
      study: {
        study_id: 'demo', name: 'Demonstration',
        filters: { ...filters, locked: false },
        display: { ...DEFAULT_DISPLAY },
        annotation: { min_duration_samples: 1, quick_labels: [...DEFAULT_QUICK_LABELS] },
        logging: { ...DEFAULT_LOGGING },
        logging_notice: 'This demonstration records how you use ElectroClean (clicks, keys and what is on the ' +
          'screen, never what you type) and keeps the record in this browser only. In a real study the record ' +
          'goes to the study team, as the study\'s information sheet explains.',
      },
      catalogue: CATALOGUE,
      programme: acc.programme ? { set_id: TRAINING_SET.set_id, name: TRAINING_SET.name } : null,
    };
  }

  // ------------------------------------------------------------ assignments
  _assignmentsFor(aid) {
    if (ACCOUNTS[aid].programme) {
      return [
        ...TRAINING_SET.guided.map((g) => ({ rid: g.rid, mode: 'guided', context_id: TRAINING_SET.set_id })),
        ...TRAINING_SET.practice.map((rid) => ({ rid, mode: 'practice', context_id: TRAINING_SET.set_id })),
      ];
    }
    return SPECS.map((s) => ({ rid: recordingIdOf(s), mode: 'standard', context_id: '' }));
  }

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
      const spec = RID.get(a.rid);
      return {
        recording_id: a.rid, file_name: fileNameOf(spec), format: 'edf', mode: a.mode, context_id: a.context_id,
        status: this._status(aid, a), duration_s: spec.nSamples / spec.sfreq, n_channels: spec.channels.length,
        size_bytes: exampleRecording(a.rid).sizeBytes,
      };
    });
    return { items, next: this._next(aid) };
  }

  _next(aid) {
    const list = this._assignmentsFor(aid);
    if (ACCOUNTS[aid].programme) {
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
      display: { scalings: { ...DEFAULT_SCALINGS }, warnings: [...rec.warnings] },
      fingerprint: null,
    };
  }

  async _fingerprint(spec) {
    const fp = await exampleRecording(recordingIdOf(spec)).fingerprint();
    return { algorithm: 'sha256', role: 'eeg', hex: fp.hex, size_bytes: fp.sizeBytes };
  }

  async match(body) {
    const aid = this._aid();
    let found = null;
    for (const spec of SPECS) {
      const rec = exampleRecording(recordingIdOf(spec));
      if (body.size_bytes !== rec.sizeBytes) continue;
      const fp = await this._fingerprint(spec);
      if (fp.hex === String(body.sha256 || '').toLowerCase()) { found = { spec, fp, exact: true }; break; }
    }
    if (!found) {
      const spec = SPECS.find((s) => s.sfreq === Number(body.sfreq) && s.nSamples === Number(body.n_samples) &&
        fileNameOf(s) === body.file_name && JSON.stringify(s.channels) === JSON.stringify(body.ch_names || []));
      if (spec) found = { spec, fp: await this._fingerprint(spec), exact: false };
    }
    const base = { recording_id: null, mode: 'standard', context_id: '', manifest: null, draft: null, differences: [] };
    if (!found) {
      return { ...base, status: 'unknown',
        message: 'This file is not one of the recordings of this study. You can still look at it and try the tools, ' +
          'but nothing you mark is saved.' };
    }
    const rid = recordingIdOf(found.spec);
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
        message: `You have already finished ${fileNameOf(found.spec)}.` };
    }
    const manifest = { ...this._manifest(found.spec), fingerprint: found.fp };
    const draft = this.state.drafts[key] || null;
    if (found.exact) {
      return { ...base, status: 'matched', recording_id: rid, mode, context_id: ctx, manifest, draft,
        message: `This is ${fileNameOf(found.spec)}, one of your recordings.` };
    }
    const differences = ['Its fingerprint (SHA-256) differs from the study\'s copy, so its contents are not exactly the same.'];
    if (body.size_bytes !== found.fp.size_bytes) {
      differences.push(`Its size is ${body.size_bytes.toLocaleString('en-GB')} bytes; the study's copy has ${found.fp.size_bytes.toLocaleString('en-GB')}.`);
    }
    return { ...base, status: 'matched_metadata', recording_id: rid, mode, context_id: ctx, manifest, draft, differences,
      message: `This file has the name, sampling rate, length and channels of ${fileNameOf(found.spec)}, but it is not exactly the study's copy.` };
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
    for (const a of annotations || []) {
      const fail = (why) => { throw new ApiError(422, 'invalid_annotation', `${a.label || 'An annotation'} at sample ${a.onset_sample}: ${why}`); };
      if (!a.annotation_id) fail('it has no identifier');
      if (!LABELS.has(a.label)) fail('the artifact type is not in the catalogue');
      if (!Number.isInteger(a.onset_sample) || !Number.isInteger(a.duration_samples)) fail('onset and duration must be whole samples');
      if (a.onset_sample < 0 || a.duration_samples < 1 || a.onset_sample + a.duration_samples > manifest.n_samples) fail('it lies outside the recording');
      if (!Array.isArray(a.channels) || a.channels.some((c) => !chans.has(c))) fail('a channel is not in the recording');
    }
  }

  async submit(body) {
    const aid = this._aid();
    const rid = body.recording_id;
    const spec = RID.get(rid);
    const assignment = this._assignmentsFor(aid).find((a) => a.rid === rid && a.mode === body.mode);
    if (!spec || !assignment) throw new ApiError(404, 'not_found', 'This recording is not one of yours.');
    const key = this._key(aid, rid, body.mode, body.context_id);
    if (this.state.done[key] && !(body.mode === 'practice' && !this._practicePassed(aid))) {
      throw new ApiError(409, 'already_done', 'This recording has already been saved.');
    }
    const manifest = this._manifest(spec);
    this._validate(body.annotations, manifest);
    let feedback = null;
    if (body.mode === 'guided') this._checkGuidedComplete(aid, rid, body.annotations);
    if (body.mode === 'practice') {
      feedback = practiceFeedback(truthAnnotations(spec), body.annotations, { passRule: TRAINING_SET.pass });
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
      guided: body.mode === 'guided' ? this.state.guided[`${aid}|${rid}`]?.summary || null : null,
      feedback: feedback ? { passed: feedback.passed, metrics: feedback.metrics } : null,
    });
    this.state.done[key] = { saved_at, attempt };
    delete this.state.drafts[key];
    this._save();
    const stem = spec.stem;
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
    const aid = this._aid();
    if (!ACCOUNTS[aid].programme) throw new ApiError(404, 'no_programme', 'You are not in a training programme.');
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
      set_id: TRAINING_SET.set_id, name: TRAINING_SET.name,
      stages: [
        { key: 'guided', title: STAGE_TITLES.guided, status: gStatus, done: gDone.length, total: TRAINING_SET.guided.length,
          stars: sum('stars'), max_stars: sum('max_stars'), best_score: null, time_s: sum('time_s') },
        { key: 'practice', title: STAGE_TITLES.practice, status: pStatus, done: pDone.length, total: TRAINING_SET.practice.length,
          stars: 0, max_stars: 0, best_score: attempts.length ? Math.max(...attempts.map((r) => r.event_f1)) : null,
          best_label_accuracy: attempts.length ? Math.max(...attempts.map((r) => r.label_accuracy)) : null,
          pass_rule: describePassRule(TRAINING_SET.pass), time_s: practiceTime },
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
    const truth = truthAnnotations(spec);
    const notes = Object.fromEntries(truth.map((a) => [a.annotation_id,
      exampleNote(a.label, a.duration_samples / spec.sfreq, a.channels)]));
    return { spec, guidance: entry.guidance, steps: rules.buildSteps(truth, notes), sfreq: spec.sfreq };
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
    const window = DEFAULT_DISPLAY.duration_s;
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
      tolerance: { seconds: rules.DEFAULT_TOLERANCE.seconds, fraction: rules.DEFAULT_TOLERANCE.fraction,
        channel_jaccard: rules.DEFAULT_TOLERANCE.channel_jaccard },
      completed,
      current: st.complete || st.index >= setup.steps.length ? null : this._stepJson(setup, st.index),
      summary: st.summary,
      demo_notice: DEMO_NOTICE,
    };
  }

  _check(setup, st, annotations) {
    const { steps, sfreq } = setup;
    const step = steps[st.index];
    const result = rules.checkStep(step, annotations, sfreq, rules.DEFAULT_TOLERANCE,
      { taken: new Set(Object.values(st.matched)), quickKeys: quickKeys() });
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
      const r = rules.checkStep(setup.steps[i], anns, setup.sfreq, rules.DEFAULT_TOLERANCE, { taken: others, quickKeys: quickKeys() });
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
    this.visits.set(visit_id, {
      header: { visit_id, annotator_id: aid, started_at: nowLocalIso(), client: 'web', programme: Boolean(body && body.programme),
        browser: body && body.client },
      events: [], closed: null,
    });
    return { visit_id, logging: { ...DEFAULT_LOGGING } };
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
      const sf = spec.sfreq;
      const used = [...new Set(s.annotations.map((a) => a.label))].map((l) => LABELS.get(l)).filter(Boolean);
      return {
        schema: 'electroclean.annotations', schema_version: '1.0.0',
        recording: { recording_id: s.recording_id, relative_path: s.recording_id, sfreq: sf, n_samples: spec.nSamples,
          first_samp: 0, meas_date: '2026-01-01T10:00:00+00:00', duration_s: spec.nSamples / sf, ch_names: [...spec.channels],
          fingerprint: { algorithm: 'sha256', role: 'eeg', hex: s.sha256, size_bytes: exampleRecording(s.recording_id).sizeBytes } },
        annotator: { annotator_id: s.annotator_id, display_name: ACCOUNTS[s.annotator_id]?.display_name || '' },
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
    };
  }

  async downloadResults() {
    const text = JSON.stringify(this.resultsDocument(), null, 1);
    return [{ name: 'electroclean_demo_results.json', blob: new Blob([text], { type: 'application/json' }) }];
  }

  get hasResults() { return this.state.submissions.length > 0; }

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
    `(${escapeHtml(pc(m.event_recall))} of them) and marked <b>${m.your_events}</b>.</p>` +
    '<table><tr><th>Finding the artifacts (F1)</th><td>' + escapeHtml(pc(m.event_f1)) + '</td></tr>' +
    '<tr><th>Right type, of those found</th><td>' + escapeHtml(pc(m.label_accuracy)) + '</td></tr>' +
    `<tr><th>Missed</th><td>${missed}</td></tr><tr><th>Extra</th><td>${extra}</td></tr>` +
    `<tr><th>Another type</th><td>${type}</td></tr></table>`;
}
