// The home view: the annotator's recordings, with one primary action (Continue where you left off,
// or Open next recording), and their own progress: done of assigned, the time worked, today's work
// and an estimate of the time left at their own pace (progress.js).

import { h } from '../ui/dom.js';
import { appHeader, icon } from './common.js';
import { docsUrl } from '../ui/docs.js';
import { ask } from '../ui/dialog.js';
import { formatHms, local } from '../util.js';
import { quizCard } from '../training/quiz_card.js';
import { deviceHomeLine } from './device.js';
import { recordingsCard } from './home_list.js';
import { partNow } from '../lazy.js';
import { localDraft } from '../annotate/local_drafts.js';
import { todayKey } from '../annotate/clock.js';
import { percentText } from '../viewer/coverage.js';
import { MIN_FOR_ESTIMATE, progressSummary, roundEstimate, spanText, todayText } from './progress.js';

function friendlyWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `today at ${time}` : `on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
}

/** The annotator's progress (progress.js), from the assignments, this browser's drafts and today's time. */
function annotatorProgress(app, items, next) {
  const b = app.backend;
  const who = app.me && app.me.annotator_id;
  return progressSummary(items, { next, todayS: Number(local.get(todayKey(who || 'anon'), 0)) || 0,
    drafts: (i) => (b ? localDraft(b, who, i.recording_id, i.mode, i.context_id) : null) });
}

/** The first card's content for an unfinished recording: Continue where you left off, with what is known of it. */
function continueContent(app, cont) {
  const facts = [
    `${formatHms(cont.item.duration_s)} · ${cont.item.n_channels} channels`,
    cont.viewedFraction !== null ? `viewed ${percentText(cont.viewedFraction)}` : null,
    cont.nAnnotations !== null ? `${cont.nAnnotations} annotation${cont.nAnnotations === 1 ? '' : 's'}` : null,
    cont.elapsedS ? `${spanText(cont.elapsedS)} worked` : null,
    cont.savedAt ? `kept ${friendlyWhen(cont.savedAt)}` : null,
  ].filter(Boolean);
  return [h('h2', {}, 'In progress'),
    h('p.next-file', {}, cont.item.file_name),
    h('p.caption.continue-facts', {}, facts.join(' · ')),
    h('div.btn-row', {}, h('button.btn.primary', { type: 'button', 'data-log': 'open-next', onclick: () => app.openAssignment(cont.item) }, 'Continue where you left off')),
    h('p.caption', {}, 'Choose the same file on your computer: ElectroTag shows the EEG as you left it, with your annotations.')];
}

/** The progress card: done of assigned with a thin bar, the time worked, today, and the time left. */
function progressCard(p) {
  const finished = p.finished ?? p.done;
  const pc = p.total ? Math.round((finished / p.total) * 100) : 0;
  const capitalised = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const stat = (value, caption, name) => h('div.stat', { 'data-stat': name }, h('p.stat-value', {}, value), h('p.caption', {}, caption));
  const left = !p.left ? 'Nothing left to do'
    : p.remainingS === null ? 'Not estimated yet'
      : p.remainingS < 60 ? 'Nearly done' : spanText(roundEstimate(p.remainingS));
  const leftCaption = !p.left ? 'You have finished every recording.'
    : p.remainingS === null ? `An estimate of the time left appears after your first ${MIN_FOR_ESTIMATE} recordings.`
      : `left, roughly, at your pace so far, judged from ${p.basedOn} recordings. Recordings differ, so take it as a guide.`;
  const today = todayText(Number(p.todayS) || 0, p.doneToday);
  return h('section.card.progress-card', { 'aria-label': 'Your progress' },
    h('div.card-head', {}, h('h2', {}, 'Your progress'), h('span.caption', {}, `${pc}% done`)),
    h('div.progress', { role: 'progressbar', 'aria-label': 'Recordings done', 'aria-valuemin': '0', 'aria-valuemax': String(p.total), 'aria-valuenow': String(finished) },
      h('div.progress-bar', { style: { width: `${pc}%` } })),
    h('div.stats', {},
      stat(`${finished} of ${p.total}`, p.unusable ? `recordings done (${p.unusable} could not be annotated)` : 'recordings done', 'done'),
      stat(p.workedS > 0 ? capitalised(spanText(p.workedS)) : 'None yet', p.medianS ? `worked in all; ${spanText(p.medianS)} per recording (median)` : 'worked in all, pauses not counted', 'worked'),
      stat(left, leftCaption, 'left')),
    h('p.caption.today', { 'data-stat': 'today' }, `Today: ${today}.`));
}


export function homeView(app) {
  const allItems = (app.assignments && app.assignments.items) || [];
  const programme = app.me && app.me.programme;
  // A trainee's training recordings are counted on the training path; home counts the study's own.
  const items = programme ? allItems.filter((i) => i.context_id !== programme.set_id) : allItems;
  const nextId = app.assignments && app.assignments.next;
  const next = items.find((i) => i.recording_id === nextId) || null;
  const training = programme && !programme.complete;
  // Real study work waits for the competency assessment (GET /me training_gate): the list shows those recordings locked.
  const gate = app.me && app.me.training_gate;
  const waiting = Boolean(gate && gate.open === false && items.some((i) => i.status === 'locked'));
  const b = app.backend;
  const p = annotatorProgress(app, items, next);
  const cont = p.continue;

  const nextCard = h('section.card.next-card', {},
    training
      ? [h('h2', {}, 'Training programme'), h('p.subtitle', {}, `${programme.name}. Your training path shows each stage and what to do next.`),
        waiting ? gateLine(gate) : null,
        h('div.btn-row', {}, h('button.btn.primary', { type: 'button', onclick: () => app.go('training') }, 'Go to my training path'))]
      : waiting && !cont && !next
        ? [h('h2', {}, gateHeading(gate)), gateLine(gate),
          h('div.btn-row', {}, h('button.btn.primary', { type: 'button', 'data-log': 'training-path', onclick: () => app.go('training') }, 'See my training path'))]
      : cont
        ? continueContent(app, cont)
      : next
        ? [h('h2', {}, 'Next recording'),
          h('p.next-file', {}, next.file_name),
          h('p.caption', {}, `${formatHms(next.duration_s)} · ${next.n_channels} channels${next.status === 'in_progress' ? ' · you have started this one' : ''}`),
          h('div.btn-row', {}, h('button.btn.primary', { type: 'button', 'data-log': 'open-next', onclick: () => app.openAssignment(next) },
            next.status === 'in_progress' ? 'Continue the next recording' : 'Open next recording')),
          h('p.caption', {}, 'You choose the file on your computer. It is read in this browser and never uploaded.')]
        : [h('h2', {}, items.length ? 'All done' : 'Nothing to do yet'),
          h('p.success', {}, items.length ? `You have finished all ${items.length} of your recordings. Thank you.` : 'No recordings are assigned to you at the moment.')]);

  // The list of recordings, with its tabs, history, search and pages (home_list.js), and the
  // recordings kept on this device under it (device.js).
  const list = recordingsCard(app);
  list.append(deviceHomeLine(app));

  let demo = null;
  if (b && b.isDemo) {
    const examples = b.exampleRecordings();
    demo = h('section.card', {},
      h('h2', {}, 'Example recordings'),
      h('p.caption', {}, 'Simulated EEG with known artifacts. Use one straight away, or download them as EDF files and open them "from your computer" to try that way too.'),
      h('ul.examples', {}, examples.map((ex) => h('li', {},
        h('div', {}, h('b', {}, ex.title), h('br'), h('span.caption', {}, `${ex.file_name} · ${formatHms(ex.duration_s)} · ${ex.n_channels} channels`)),
        h('button.btn.small', { type: 'button', 'data-log': `example-${ex.id}`, 'aria-label': `Use ${ex.title}`, onclick: () => app.useExample(ex.recording_id) }, 'Use this example')))),
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
      guideLine(),
      questionnaireLine(app),
      h('div.home-grid', {},
        h('div.col', {}, nextCard, outcomesHost(app), expertCard(app), !training && items.length ? progressCard(p) : null, programme && !training && !waiting ? trainingDoneCard(app) : null,
          list, quizCard(app)),
        sideColumn([...games(app), demo]))));
}

/** The game elements' cards (home_games.js, loaded with GET /me/achievements when the study has them on). */
function games(app) {
  const part = app.achievements ? partNow('games') : null;
  return part ? part.gameCards(app) : [];
}

/**
 * The sign-up questionnaire (js/views/questionnaire.js): when it was answered, with the way to change the answers;
 * before it is answered, the way to answer it (the study refuses work until then).
 */
export function questionnaireLine(app) {
  const q = app.me && app.me.questionnaire;
  if (!q || !q.asked) return null;
  if (!q.answered) {
    return h('p.banner.q-home', { role: 'status' }, 'Your recordings, training and expert work open once you have answered the short sign-up questionnaire. ',
      h('button.link', { type: 'button', 'data-log': 'questionnaire-open', onclick: () => app.showQuestionnaire({ first: true, then: () => app.showHome() }) }, 'Answer the questionnaire'));
  }
  const d = q.answered_at ? new Date(q.answered_at) : null;
  const when = d && !Number.isNaN(d.getTime()) ? ` on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}` : '';
  return h('p.caption.q-home', {}, `You answered the sign-up questionnaire${when}${q.missing ? `; the study team has added ${q.missing === 1 ? 'a question' : `${q.missing} questions`} since` : ''}. `,
    h('button.link', { type: 'button', 'data-log': 'questionnaire-open', onclick: () => app.showQuestionnaire() }, q.missing ? 'Answer the new questions' : 'See or change my answers'));
}

/** Where the annotators' guide is read (docs/web/using.md, in a new tab). */
export function guideLine() {
  return h('p.caption.guide-link', {}, 'How each step works, from opening a recording to saving it, is in the ',
    h('a', { href: docsUrl('web/using.md'), target: '_blank', rel: 'noopener', 'data-log': 'guide' }, 'annotators\' guide'), ' (it opens in a new tab).');
}

/**
 * For experts (and administrators): the way into the expert area, where they correct saved work, replay
 * sessions, adjudicate and supply training material. The later parts of the expert work add a line each to
 * EXPERT_CARD_LINES, from what GET /me tells them (a count of work waiting, say); empty lines are left out.
 */
export const EXPERT_CARD_LINES = [];

export function expertCard(app) {
  if (!app.isExpert) return null;
  const lines = EXPERT_CARD_LINES.map((fn) => { try { return fn(app); } catch { return null; } }).filter(Boolean);
  const counts = h('div.expert-counts', { role: 'status' });
  const queue = h('button.btn.quiet', { type: 'button', 'data-log': 'open-expert-queue', hidden: true, onclick: () => app.showExpert('expert-queue') }, 'Open the adjudication queue');
  if (app.backend && !app.backend.isDemo && app.backend.expert) {
    // what waits for adjudication (js/expert/model.js expertCardLines); the card works without it
    Promise.all([import('../expert/model.js'), app.backend.expert('adjudication_list', {})]).then(([m, got]) => {
      const said = m.expertCardLines(got.units);
      counts.replaceChildren(...said.map((l) => h('p.expert-count', {}, l)));
      queue.hidden = !said.length;
    }, () => { /* nothing to add */ });
  }
  return h('section.card.expert-card', { 'aria-label': 'Expert work' },
    h('h2', {}, 'Expert work'),
    h('p.caption', {}, 'Correct and add to saved work, replay how sessions went, adjudicate disagreements and supply training material. '
      + 'The originals are never changed: a correction is a new version, credited to you.'),
    lines.map((l) => h('p.caption', {}, l)), counts,
    h('div.btn-row', {}, h('button.btn', { type: 'button', 'data-log': 'open-expert', onclick: () => app.showExpert('expert') }, 'Open the expert area'), queue));
}

/**
 * The heading of the first card while the study recordings wait: after an assessment that did not meet the
 * criteria (or whose result is to come), it says that the study team has the next step.
 */
export function gateHeading(gate) {
  if (gate && gate.result === 'not_met') return 'Assessment not met: waiting for your study team';
  if (gate && gate.result) return 'Assessment finished: waiting for your study team';
  return 'Your study recordings are locked';
}

/** Why the study recordings are locked (the gate's message, in the study's words), with the lock drawn beside it. */
function gateLine(gate) {
  return h('p.caption.gate-line', { 'data-log': 'training-gate' }, icon('lock'), h('span', {}, gate.message || 'Your study recordings open once you pass the competency assessment.'));
}

/** The decisions on the annotator's disagreements (js/expert/outcomes.js), filled in once they are read. */
function outcomesHost(app) {
  const review = app.me && app.me.study && app.me.study.review;
  if (!review || review.show_outcomes_to_annotators === false || !app.backend || !app.backend.myFeedback || (app.me && app.me.programme)) return null;
  const host = h('div.outcomes-host');
  import('../expert/outcomes.js').then((m) => m.fillOutcomes(app, host)).catch(() => host.remove());
  return host;
}

/** After training: a line that it is complete, with the way back to the training path. */
function trainingDoneCard(app) {
  return h('section.card.training-done', { 'data-log': 'training-done' },
    h('p.caption', {}, `Training complete: ${app.me.programme.name}. `,
      h('button.link', { type: 'button', 'data-log': 'training-path', onclick: () => app.go('training') }, 'See my training path')));
}

/** The right-hand column: the game cards (home_games.js) and the demonstration's card, when there are any. */
function sideColumn(cards) {
  const list = cards.filter(Boolean);
  return list.length ? h('div.col.side-col', {}, list) : null;
}
