// The card of the short-segment quizzes (GET /me's quizzes) on the home view and the training path.
// Kept apart from the quiz itself (quiz.js), which loads the EEG viewer, so that the home page does
// not have to load it.

import { h } from '../ui/dom.js';

/** How a quiz gives its feedback, for the list of quizzes. */
export function feedbackText(feedback) {
  if (feedback === 'immediate') return 'whether each answer is right, straight away';
  if (feedback === 'end') return 'your result at the end';
  return '';
}

/** The quizzes of GET /me, as a card for the home view or the training path (null when none). */
export function quizCard(app, { onOpen = null } = {}) {
  const quizzes = (app.me && app.me.quizzes) || [];
  if (!quizzes.length) return null;
  const open = onOpen || ((q) => app.showQuiz(q.set_id));
  return h('section.card.quiz-card', { 'data-log': 'quiz-card' },
    h('h2', {}, quizzes.length === 1 ? 'Short-segment quiz' : 'Short-segment quizzes'),
    h('p.caption', {}, 'Short pieces of EEG: choose the main artifact type in each. It tests recognising the types only, not marking them.'),
    h('ul.quiz-list', {}, quizzes.map((q) => {
      const answered = q.finished ? 0 : Number(q.n_answered) || 0;
      return h('li', { 'data-set': q.set_id },
        h('div', {}, h('b', {}, q.name || q.set_id), h('br'),
          h('span.caption', {}, `${q.n_items} segment${q.n_items === 1 ? '' : 's'}` + (feedbackText(q.feedback) ? `; ${feedbackText(q.feedback)}` : '')),
          answered ? [h('br'), h('span.caption.quiz-answered', {}, `You have answered ${answered} of ${q.n_items}.`)] : null),
        // a finished quiz opens on its result; a started one carries on where it stopped
        h('div.quiz-actions', {}, q.finished ? h('span.chip.done', {}, 'Finished') : null,
          h('button.btn.small', { type: 'button', 'data-log': `quiz-${q.set_id}`, onclick: () => open(q) },
            q.finished ? 'See my result' : answered ? 'Continue the quiz' : 'Take the quiz')));
    })));
}

