// The training path: the programme's three stages as cards, with one Continue button
// (as guided_gui.TrainingPathWindow).

import { h } from '../ui/dom.js';
import { starText } from './rules.js';
import { minutesText } from './coach.js';

export const STAGE_TEXT = {
  guided: 'Mark each artifact the way the experts did, one at a time, with help and instant feedback.',
  practice: 'Annotate a recording by yourself, then see your score and what you missed.',
  assessment: 'Annotate without feedback. Your result is shown when every recording is done.',
};
export const STAGE_TITLES = { guided: 'Learn with the experts', practice: 'On your own', assessment: 'Competency assessment' };

const CHIPS = {
  locked: ['Locked', ''], available: ['Ready', 'active'], in_progress: ['In progress', 'active'],
  completed: ['Completed', 'done'], not_used: ['Not part of this set', ''],
};

function nextText(next) {
  if (!next) return 'You have completed every stage of this training programme.';
  if (next.text) return next.text;
  return `Next: ${STAGE_TITLES[next.stage] || next.stage}.`;
}

/** The quizzes of the programme's reference sets, under the stages (null when there are none). */
function quizSection(quizzes, onQuiz) {
  if (!quizzes || !quizzes.length || !onQuiz) return null;
  return h('section.card.quiz-card', { 'data-log': 'quiz-card' },
    h('h2', {}, quizzes.length === 1 ? 'Short-segment quiz' : 'Short-segment quizzes'),
    h('p.caption', {}, 'Short pieces of EEG: choose the main artifact type in each. You can take it at any stage of the programme.'),
    h('ul.quiz-list', {}, quizzes.map((q) => h('li', { 'data-set': q.set_id },
      h('div', {}, h('b', {}, q.name || q.set_id), h('br'), h('span.caption', {}, `${q.n_items} segment${q.n_items === 1 ? '' : 's'}`)),
      q.finished ? h('span.chip.done', {}, 'Finished')
        : h('button.btn.small', { type: 'button', 'data-log': `quiz-${q.set_id}`, onclick: () => onQuiz(q) }, 'Take the quiz')))));
}

export function trainingPath(data, { annotatorId, message = '', onContinue, onBack, quizzes = [], onQuiz = null }) {
  const pc = (v) => `${Math.round((v || 0) * 100)}%`;
  const cards = data.stages.map((s, i) => {
    const [chip, chipState] = CHIPS[s.status] || [s.status, ''];
    const current = data.next && data.next.stage === s.key;
    const unit = s.total === 1 ? 'recording' : 'recordings';
    let detail = '';
    if (s.key === 'practice' && s.status !== 'not_used') {
      const need = s.pass_rule ? `You need ${s.pass_rule}.` : '';
      detail = s.best_score !== null && s.best_score !== undefined
        ? `Best: ${pc(s.best_score)} found${s.best_label_accuracy !== undefined && s.best_label_accuracy !== null ? `, ${pc(s.best_label_accuracy)} right type` : ''}. ${s.status === 'completed' ? 'Passed.' : need}`
        : need;
    }
    if (s.time_s >= 1) detail = `${detail ? `${detail}  ` : ''}Time so far: ${minutesText(s.time_s)}.`;
    if (s.status === 'locked') detail = 'Unlocks when you complete the stage before.';
    const state = current ? '.current' : s.status === 'locked' || s.status === 'not_used' ? '.locked' : '';
    return h(`article.card.stage${state}`, { 'data-stage': s.key },
      h('div.stage-head', {}, h(`span.badge${s.status === 'completed' ? '.done' : s.status === 'locked' || s.status === 'not_used' ? '.locked' : ''}`, {}, s.status === 'completed' ? '✓' : String(i + 1)),
        h('h2', {}, s.title || STAGE_TITLES[s.key])),
      h('div', {}, h(`span.chip${chipState ? `.${chipState}` : ''}`, {}, chip)),
      h('p.caption', {}, STAGE_TEXT[s.key] || ''),
      s.total ? h('p.subtitle', {}, `${s.done} of ${s.total} ${unit} done`) : null,
      s.key === 'guided' && s.max_stars ? h('p.subtitle', {}, `${starText(s.stars, s.max_stars)}  ${s.stars} of ${s.max_stars} stars`) : null,
      detail ? h('p.caption', {}, detail) : null);
  });
  const cont = data.next
    ? h('button.btn.primary.wide', { type: 'button', onclick: () => onContinue(data.next) }, data.next.label || 'Continue')
    : null;
  const back = h(`button.btn${data.next ? '' : '.primary'}`, { type: 'button', onclick: onBack }, 'Back to my recordings');
  return h('main.page.training', {},
    h('h1', {}, 'Training programme'),
    h('p.subtitle', {}, `${data.name || data.set_id}  ·  annotator ${annotatorId}`),
    message ? h('p.success', { role: 'status' }, message) : null,
    h('div.stages', {}, cards),
    h('p.subtitle.next-text', {}, nextText(data.next)),
    h('div.btn-row.spread', {}, back, cont),
    quizSection(quizzes, onQuiz));
}
