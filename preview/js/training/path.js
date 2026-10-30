// The training path: the programme's stages as cards, each with its progress and result, and one
// Continue button for the next step. The stages come from the study (GET /training) in their order,
// so a programme with more stages shows them the same way.

import { h } from '../ui/dom.js';
import { icon, starIcons } from '../views/common.js';
import { minutesText } from './coach.js';
import { quizCard } from './quiz_card.js';

export const STAGE_TEXT = {
  guided: 'Mark each artifact the way the experts did, one at a time, with help and instant feedback.',
  practice: 'Annotate a recording by yourself, then see your score and what you missed.',
  assessment: 'Annotate without feedback. Your result appears here when every recording is done.',
};
export const STAGE_TITLES = { guided: 'Learn with the experts', practice: 'On your own', assessment: 'Competency assessment' };
export const COMPLETE_TEXT = 'You have completed every stage of this training programme.';

const CHIPS = {
  locked: ['Locked', ''], available: ['Ready', 'active'], in_progress: ['In progress', 'active'],
  completed: ['Completed', 'done'], not_used: ['Not included', ''],
};
/** A finished stage's chip by its result: only a pass or criteria met are shown as done. */
const RESULT_CHIPS = {
  not_passed: ['Not passed yet', 'active'],
  met: ['Criteria met', 'done'],
  not_met: ['Criteria not met yet', ''],
  not_determined: ['Result to come', ''],
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
function countText(s) {
  const unit = s.total === 1 ? 'recording' : 'recordings';
  return s.key === 'practice' ? `${s.done} of ${s.total} practice ${unit} tried` : `${s.done} of ${s.total} ${unit} done`;
}

function nextText(data) {
  if (data.next) return data.next.text || `Next: ${STAGE_TITLES[data.next.stage] || data.next.stage}.`;
  return data.message || COMPLETE_TEXT;
}

export function trainingPath(data, { annotatorId, message = '', onContinue, onBack, quizzes = [], onQuiz = null }) {
  const cards = data.stages.map((s, i) => {
    const [chip, chipState] = stageChip(s);
    const current = data.next && data.next.stage === s.key;
    const off = s.status === 'locked' || s.status === 'not_used';
    let detail = s.status === 'not_used' ? '' : s.detail || '';
    if (s.status === 'locked') detail = 'Unlocks when you complete the stage before.';
    const time = s.time_s >= 1 && s.status !== 'locked' ? `Time so far: ${minutesText(s.time_s)}.` : '';
    const state = current ? '.current' : off ? '.locked' : '';
    const good = doneWell(s);
    return h(`article.card.stage${state}`, { 'data-stage': s.key },
      h('div.stage-head', {}, h(`span.badge${good ? '.done' : off ? '.locked' : ''}`, {}, good ? icon('check') : String(i + 1)),
        h('h2', {}, s.title || STAGE_TITLES[s.key])),
      h('div', {}, h(`span.chip${chipState ? `.${chipState}` : ''}`, {}, chip)),
      h('p.caption', {}, s.status === 'not_used' ? 'Your programme has no recordings for this stage.' : STAGE_TEXT[s.key] || s.description || ''),
      s.total ? h('p.subtitle', {}, countText(s)) : null,
      s.key === 'guided' && s.max_stars ? h('p.subtitle', {}, starIcons(s.stars, s.max_stars), `${s.stars} of ${s.max_stars} stars`) : null,
      detail ? h('p.caption.stage-detail', {}, detail) : null,
      time ? h('p.caption.stage-time', {}, time) : null);
  });
  // Once every stage is done, the step forward is the study's own recordings.
  const cont = data.next
    ? h('button.btn.primary.wide', { type: 'button', onclick: () => onContinue(data.next) }, data.next.label || 'Continue')
    : null;
  const back = h(`button.btn${data.next ? '' : '.primary'}`, { type: 'button', 'data-log': 'training-back', onclick: onBack },
    data.next ? 'Back to my recordings' : 'Go to my recordings');
  return h('main.page.training', {},
    h('h1', {}, 'Training programme'),
    h('p.subtitle', {}, `${data.name || data.set_id}  ·  annotator ${annotatorId}`),
    message ? h('p.success', { role: 'status' }, message) : null,
    h('div.stages', {}, cards),
    h('p.subtitle.next-text', {}, nextText(data)),
    h('div.btn-row.spread', {}, back, cont),
    quizzes && quizzes.length && onQuiz ? quizCard({ me: { quizzes } }, { onOpen: onQuiz }) : null);
}
