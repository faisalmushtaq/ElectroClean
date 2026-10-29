// The home view: the annotator's recordings, with one primary action (Open next recording).

import { h } from '../ui/dom.js';
import { appHeader } from './common.js';
import { ask } from '../ui/dialog.js';
import { formatHms } from '../util.js';
import { quizCard } from '../training/quiz.js';
import { recordingsCard } from './home_list.js';
import { gameCards } from './home_games.js';

export function homeView(app) {
  const items = (app.assignments && app.assignments.items) || [];
  const nextId = app.assignments && app.assignments.next;
  const next = items.find((i) => i.recording_id === nextId) || null;
  const programme = app.me && app.me.programme;
  const b = app.backend;

  const nextCard = h('section.card.next-card', {},
    programme
      ? [h('h2', {}, 'Training programme'), h('p.subtitle', {}, `${programme.name}. Your training path shows each stage and what to do next.`),
        h('div.btn-row', {}, h('button.btn.primary', { type: 'button', onclick: () => app.go('training') }, 'Go to my training path'))]
      : next
        ? [h('h2', {}, 'Next recording'),
          h('p.next-file', {}, next.file_name),
          h('p.caption', {}, `${formatHms(next.duration_s)} · ${next.n_channels} channels${next.status === 'in_progress' ? ' · you have started this one' : ''}`),
          h('div.btn-row', {}, h('button.btn.primary', { type: 'button', 'data-log': 'open-next', onclick: () => app.openAssignment(next) },
            next.status === 'in_progress' ? 'Continue the next recording' : 'Open next recording')),
          h('p.caption', {}, 'You choose the file on your computer. It is read in this browser and never uploaded.')]
        : [h('h2', {}, items.length ? 'All done' : 'Nothing to do yet'),
          h('p.success', {}, items.length ? `You have finished all ${items.length} of your recordings. Thank you.` : 'No recordings are assigned to you at the moment.')]);

  // The list of recordings, with its tabs, history, search and pages (home_list.js).
  const list = recordingsCard(app);

  let demo = null;
  if (b && b.isDemo) {
    const examples = b.exampleRecordings();
    demo = h('section.card', {},
      h('h2', {}, 'Example recordings'),
      h('p.caption', {}, 'Simulated EEG with known artifacts. Use one straight away, or download them as EDF files and open them "from your computer" to try that way too.'),
      h('ul.examples', {}, examples.map((ex) => h('li', {},
        h('div', {}, h('b', {}, ex.title), h('br'), h('span.caption', {}, `${ex.file_name} · ${formatHms(ex.duration_s)} · ${ex.n_channels} channels`)),
        h('button.btn.small', { type: 'button', 'data-log': `example-${ex.id}`, onclick: () => app.useExample(ex.recording_id) }, 'Use this example')))),
      h('div.btn-row', {},
        h('button.btn.quiet', { type: 'button', onclick: async () => app.download(await b.downloadRecordings()) }, 'Download the example recordings (EDF)'),
        h('button.btn.quiet', { type: 'button', onclick: () => app.downloadResults() }, 'Download my results'),
        h('button.btn.quiet.destructive-text', { type: 'button', onclick: async () => {
          if (await ask('Reset the demonstration?', 'Forget every annotation, draft and training result saved by the demonstration in this browser?', { yes: 'Reset', no: 'Cancel', defaultYes: false, destructive: true })) {
            b.reset();
            await app.reloadHome();
          }
        } }, 'Reset the demonstration')),
      h('p.caption.demo-note', {}, 'Demonstration: in a real study the server checks and stores your work, and the study team receives it.'));
  } else if (b && b.canDownloadRecordings) {
    demo = h('section.card', {}, h('h2', {}, 'Demonstration server'),
      h('p.caption', {}, 'This study server offers its example recordings for download, so you can open them from your computer.'),
      h('div.btn-row', {}, h('button.btn.quiet', { type: 'button', onclick: async () => app.download(await b.downloadRecordings()) }, 'Download the example recordings')));
  }
  return h('div.view.home', { 'data-view': 'home' }, appHeader(app),
    h('main.page', {},
      h('h1', {}, `Hello${app.me && app.me.display_name ? `, ${app.me.display_name}` : ''}`),
      h('div.home-grid', {}, h('div.col', {}, nextCard, list, quizCard(app)), sideColumn([...gameCards(app), demo]))));
}

/** The right-hand column: the game cards (home_games.js) and the demonstration's card, when there are any. */
function sideColumn(cards) {
  const list = cards.filter(Boolean);
  return list.length ? h('div.col.side-col', {}, list) : null;
}
