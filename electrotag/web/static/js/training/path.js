// The training path: the programme's five stages as cards, in order (GET /training), each with its
// progress and result, and one Continue button for the next step. A stage the study lets trainees skip
// has "Skip this stage", which asks first; a skipped stage says so and offers "Do it after all". Both
// are sent to the study (POST /training/stage), once, and the path is drawn again from its answer.
// While real study work waits for the competency assessment, a line says so and why; once the assessment
// is finished, the line above the stages says how it went (pathOutcome): passed, with the study recordings
// open and the next one a press away, or not met, waiting for the study team. The tour and the snippets
// can be looked at again once done, and the earlier rounds of the assessment (before the study team
// reopened the training or gave a new assessment set) are listed on its card.
//
// Other parts of the training add to the path without this file knowing them: STAGE_LINES[stage]
// and WATCH_EXPERT take functions (app, stage, data) => a node, a line of text or null, drawn on
// the stage's card (WATCH_EXPERT on "Learn with the experts", for watching an expert's session).

import { h } from '../ui/dom.js';
import { ask } from '../ui/dialog.js';
import { logger } from '../log/logger.js';
import { icon, starIcons } from '../views/common.js';
import { minutesText } from './coach.js';
import { quizCard } from './quiz_card.js';
import { STAGE_TEXT as TEXTS, STAGE_TITLES as TITLES } from './stages.js';
import { watchExpertEntry } from '../replay/watch.js';
import { crowdEntry } from '../expert/crowd_entry.js';

export const STAGE_TEXT = TEXTS;
export const STAGE_TITLES = TITLES;
export const COMPLETE_TEXT = 'You have completed every stage of this training programme.';
export const LOCKED_TEXT = 'Unlocks when you finish or skip the stage before.';

/** Lines other parts of the training add to a stage's card: (app, stage, data) => Node | string | null. */
export const STAGE_LINES = { tour: [], snippets: [], guided: [], practice: [], assessment: [] };
/**
 * The slot for watching an expert's session, on "Learn with the experts": the replay part's way in (js/replay/watch.js).
 * It is shown on an open stage only, and only once the study has a session to watch (teaching_list).
 */
export const WATCH_EXPERT = [(app) => (app ? watchExpertEntry(app) : null),
  (app) => (app ? crowdEntry(app) : null)]; // how everyone marked a training recording (js/expert/crowd_entry.js)

const CHIPS = {
  locked: ['Locked', ''], available: ['Ready', 'active'], in_progress: ['In progress', 'active'],
  completed: ['Completed', 'done'], skipped: ['Skipped', 'skipped'], not_used: ['Not included', ''],
};
/** A finished stage's chip by its result: only a pass or criteria met are shown as done. */
const RESULT_CHIPS = {
  not_passed: ['Not passed yet', 'active'],
  met: ['Criteria met', 'done'],
  not_met: ['Criteria not met yet', ''],
  not_determined: ['Result to come', ''],
};
/** What a stage holds when the set has nothing for it. */
const NOT_USED = {
  tour: 'Your study does not include the tour.',
  snippets: 'Your training set has no examples to show.',
};

/** The chip of a stage: its status, or for a practice tried without a pass and a finished assessment, its result. */
export function stageChip(s) {
  if (s.key === 'practice' && s.status === 'in_progress' && s.result === 'not_passed') return RESULT_CHIPS.not_passed;
  if (s.key === 'assessment' && s.status === 'completed' && RESULT_CHIPS[s.result]) return RESULT_CHIPS[s.result];
  return CHIPS[s.status] || [s.status, ''];
}

/** Whether a stage is done with a good result (a tick in its badge). */
function doneWell(s) {
  if (s.status !== 'completed') return false;
  return s.key !== 'assessment' || !s.result || s.result === 'met';
}

/** How much of a stage is done: practice recordings are tried, as they can be done again. */
export function countText(s) {
  if (!s.total) return '';
  const unit = s.total === 1 ? 'recording' : 'recordings';
  return s.key === 'practice' ? `${s.done} of ${s.total} practice ${unit} tried` : `${s.done} of ${s.total} ${unit} done`;
}

/** The line under a stage's description: its results, or why it is locked. */
export function detailText(s) {
  if (s.status === 'not_used') return '';
  if (s.status === 'locked') return LOCKED_TEXT;
  return s.detail || '';
}

function nextText(data) {
  if (data.next) return data.next.text || `Next: ${STAGE_TITLES[data.next.stage] || data.next.stage}.`;
  return data.message || COMPLETE_TEXT;
}

export const PASSED_TEXT = 'You passed: your study recordings are now open.';
export const NOT_MET_TEXT = 'Assessment not met: waiting for your study team.';
export const TO_COME_TEXT = 'Assessment finished: waiting for your study team to confirm the result.';

/**
 * What the line above the stages says once there is no next step: {state, text}. "waiting" while the
 * study recordings stay locked after the assessment (the gate's result), "passed" when the assessment met
 * the criteria and the recordings are open, "complete" otherwise; "next" while there is a next step.
 */
export function pathOutcome(data) {
  if (data.next) return { state: 'next', text: nextText(data) };
  const gate = data.gate || { open: true };
  if (gate.open === false && gate.result === 'not_met') return { state: 'waiting', text: NOT_MET_TEXT };
  if (gate.open === false && gate.result) return { state: 'waiting', text: TO_COME_TEXT };
  const a = (data.stages || []).find((s) => s.key === 'assessment');
  if (gate.open !== false && a && a.status === 'completed' && a.result === 'met') return { state: 'passed', text: PASSED_TEXT };
  return { state: 'complete', text: nextText(data) };
}

/** An earlier round of the assessment in words: "Round 1, Pilot training set: Does not yet meet the competency criteria." */
export function roundText(r) {
  const result = r.status_text || { met: 'Criteria met.', not_met: 'Criteria not met.' }[r.status] || 'No result.';
  return `Round ${r.round}${r.set_name ? `, ${r.set_name}` : ''}: ${result}`;
}

/** The stages done in the browser can be looked at again once done (not those carried over from an earlier set). */
export const canLookAgain = (s) => s.status === 'completed' && !s.carried && (s.key === 'tour' || s.key === 'snippets');

/** The way in to watching an expert: on an open stage, once the study has a session to show. */
function watchSlot(app, s, data) {
  if (!app || s.status === 'locked' || s.status === 'not_used') return null;
  const nodes = lines(WATCH_EXPERT, app, s, data);
  if (!nodes.length || !app.backend || typeof app.backend.expert !== 'function') return null;
  const host = h('div.watch-slot', { hidden: true });
  // the crowd of a training recording (crowd_entry.js) is offered once one has been saved, the experts' sessions once there is one
  const crowd = nodes.filter((n) => n.dataset && n.dataset.log === 'crowd-entry');
  const watch = nodes.filter((n) => !crowd.includes(n));
  const offer = (list, ask, has) => (list.length ? Promise.resolve().then(ask).then((got) => {
    if (got && got.shown && has(got)) { host.append(...list); host.hidden = false; }
  }, () => { /* nothing to show: the stage reads as it is */ }) : null);
  offer(watch, () => app.backend.expert('teaching_list', {}), (got) => (got.sessions || []).length);
  offer(crowd, () => app.backend.expert('overlay_teaching_list', {}), (got) => (got.recordings || []).length);
  return host;
}

/** What a skip question says: what the stage gives, and that it can be done later. */
export function skipQuestion(s) {
  return `${STAGE_TEXT[s.key] || s.description || ''}\n\nYou can do it after all at any time, from this page. ` +
    'The study notes that you skipped it.';
}

function lines(fns, app, s, data) {
  return fns.map((fn) => {
    try {
      const out = fn(app, s, data);
      return typeof out === 'string' ? h('p.caption', {}, out) : out || null;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * The training path's page. `onContinue(next)` opens the next recording; the tour and the snippets,
 * which need none, open from here. `app` sends the skips and draws the path again.
 */
export function trainingPath(data, { app = null, annotatorId, message = '', onContinue, onBack, quizzes = [], onQuiz = null }) {
  // the study's latest word on the gate, for the home page too (GET /me says it only at signing in)
  if (app && app.me && data.gate) app.me.training_gate = data.gate;
  let busy = false;
  const buttons = [];
  /** POST /training/stage, once: every button of the path waits for the answer. */
  const act = async (s, action, done) => {
    if (busy || !app) return;
    busy = true;
    for (const b of buttons) b.disabled = true;
    try {
      await app.backend.trainingStage({ stage: s.key, action });
    } catch (exc) {
      busy = false;
      for (const b of buttons) b.disabled = false;
      if (exc.status === 401) return;
      app.showTraining(`That did not reach your study: ${exc.message}`);
      return;
    }
    await app.loadAssignments(); // a stage skipped or taken up again changes the recordings offered
    await app.showTraining(done);
  };
  const skip = async (s) => {
    const sure = await ask(`Skip ${s.title || STAGE_TITLES[s.key]}?`, skipQuestion(s), { yes: 'Skip this stage', no: 'Keep it', defaultYes: false });
    if (!sure) { logger.event('stage_skip_cancelled', { set_id: data.set_id, stage: s.key }); return; }
    logger.event('stage_skipped', { set_id: data.set_id, stage: s.key, policy: ((app && app.me && app.me.study && app.me.study.training) || {}).skippable || [] });
    await act(s, 'skip', `You skipped ${s.title || STAGE_TITLES[s.key]}.`);
  };
  const resume = async (s) => {
    logger.event('stage_resumed', { set_id: data.set_id, stage: s.key });
    await act(s, 'resume', `${s.title || STAGE_TITLES[s.key]} is open again.`);
  };
  const cards = data.stages.map((s, i) => {
    const [chip, chipState] = stageChip(s);
    const current = data.next && data.next.stage === s.key;
    const off = s.status === 'locked' || s.status === 'not_used';
    const detail = detailText(s);
    const time = s.time_s >= 1 && s.status !== 'locked' ? `Time so far: ${minutesText(s.time_s)}.` : '';
    const state = current ? '.current' : s.status === 'skipped' ? '.skipped' : off ? '.locked' : '';
    const good = doneWell(s);
    const actions = [];
    if (s.can_skip && app) {
      actions.push(h('button.btn.small.quiet', { type: 'button', 'data-log': `skip-${s.key}`, onclick: () => skip(s) }, 'Skip this stage'));
    }
    if (s.can_resume && app) {
      actions.push(h('button.btn.small', { type: 'button', 'data-log': `resume-${s.key}`, onclick: () => resume(s) }, 'Do it after all'));
    }
    if (canLookAgain(s) && app) {
      actions.push(h('button.btn.small.quiet', { type: 'button', 'data-log': `look-again-${s.key}`, onclick: () => open(s.key, true) }, 'Look again'));
    }
    buttons.push(...actions);
    const quiz = s.key === 'snippets' && s.status === 'completed' && app && app.me
      ? ((app.me.quizzes || []).find((q) => q.set_id === data.set_id && q.finished) || null) : null;
    const rounds = s.key === 'assessment' && (data.rounds || []).length
      ? h('ul.stage-rounds', { 'aria-label': 'Earlier rounds of the assessment' }, data.rounds.map((r) => h('li.caption', {}, roundText(r)))) : null;
    const extra = [...lines(STAGE_LINES[s.key] || [], app, s, data), quiz ? h('p.caption', {}, 'You have taken the recognition check.') : null,
      rounds, s.key === 'guided' ? watchSlot(app, s, data) : null].filter(Boolean);
    return h(`article.card.stage${state}`, { 'data-stage': s.key, 'data-status': s.status },
      h('div.stage-head', {}, h(`span.badge${good ? '.done' : off || s.status === 'skipped' ? '.locked' : ''}`, {}, good ? icon('check') : String(i + 1)),
        h('h2', {}, s.title || STAGE_TITLES[s.key])),
      h('div.stage-body', {},
        h('p.caption', {}, s.status === 'not_used' ? (NOT_USED[s.key] || 'Your programme has no recordings for this stage.') : STAGE_TEXT[s.key] || s.description || ''),
        countText(s) ? h('p.subtitle', {}, countText(s)) : null,
        s.key === 'guided' && s.max_stars ? h('p.subtitle', {}, starIcons(s.stars, s.max_stars), `${s.stars} of ${s.max_stars} stars`) : null,
        detail ? h('p.caption.stage-detail', {}, detail) : null,
        time ? h('p.caption.stage-time', {}, time) : null,
        extra.length ? h('div.stage-extra', { 'data-slot': s.key }, extra) : null),
      h('div.stage-side', {}, h(`span.chip${chipState ? `.${chipState}` : ''}`, {}, chip), actions));
  });
  // The tour and the snippets need no recording: they open from here (also to look at them again).
  function open(stage, again = false) {
    logger.event('stage_started', { stage, recording: null, repeat: again });
    if (stage === 'tour') app._withParts(['tour'], 'annotate', ({ startTour }) => startTour(app));
    else app._withParts(['snippets'], 'training', ({ showSnippets }) => showSnippets(app));
  }
  const go = (next) => {
    if (!app || (next.stage !== 'tour' && next.stage !== 'snippets')) { onContinue(next); return; }
    open(next.stage);
  };
  const outcome = pathOutcome(data);
  // after a pass, the next study recording is one press away
  const items = (app && app.assignments && app.assignments.items) || [];
  const nextStudy = outcome.state === 'passed' && app && app.assignments
    ? items.find((i) => i.recording_id === app.assignments.next && i.mode === 'standard' && i.status !== 'locked') || null : null;
  const cont = data.next
    ? h('button.btn.primary.wide', { type: 'button', 'data-log': 'training-continue', onclick: () => go(data.next) }, data.next.label || 'Continue')
    : nextStudy ? h('button.btn.primary', { type: 'button', 'data-log': 'open-next', onclick: () => app.openAssignment(nextStudy) }, 'Open next recording')
      : null;
  if (cont) buttons.push(cont);
  // the recordings are not the way on while they are locked: no primary button points at them then
  const backPrimary = !data.next && !nextStudy && outcome.state !== 'waiting';
  const back = h(`button.btn${backPrimary ? '.primary' : ''}`, { type: 'button', 'data-log': 'training-back', onclick: onBack },
    data.next || outcome.state === 'waiting' ? 'Back to my recordings' : 'Go to my recordings');
  const waiting = outcome.state === 'waiting';
  const gate = data.gate && data.gate.open === false && !waiting
    ? h('section.card.gate-card', { 'data-log': 'training-gate', role: 'note' }, icon('lock'),
      h('p', {}, data.gate.message || 'Your study recordings open once you pass the competency assessment.'))
    : null;
  // What comes next, and its button, above the stages: the one forward action is in sight at once.
  return h('main.page.training', {},
    h('h1', {}, 'Training programme'),
    h('p.subtitle', {}, `${data.name || data.set_id}  ·  annotator ${annotatorId}`),
    message ? h(`p.${/^That did not reach/.test(message) ? 'banner' : 'success'}`, { role: 'status' }, message) : null,
    gate,
    h(`section.next-step${outcome.state === 'next' ? '' : `.${outcome.state}`}`, { 'aria-label': 'What comes next', 'data-outcome': outcome.state },
      h('div.next-words', {},
        h(`p.${outcome.state === 'passed' || waiting ? 'next-outcome' : 'subtitle.next-text'}`, {}, outcome.text),
        waiting && data.gate.message ? h('p.caption.gate-line', { 'data-log': 'training-gate' }, icon('lock'), h('span', {}, data.gate.message)) : null),
      h('div.btn-row', {}, back, cont)),
    h('ol.stages.path', { 'aria-label': 'The stages of your training' }, cards.map((c) => h('li', {}, c))),
    quizzes && quizzes.length && onQuiz ? quizCard({ me: { quizzes } }, { onOpen: onQuiz }) : null);
}
