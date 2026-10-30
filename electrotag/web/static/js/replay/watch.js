// "Watch an expert": the way in for trainees to replays of experts' sessions (docs/web/using.md,
// "Watching an expert at work"). Only the sessions of experts who agreed to their sessions being used
// for teaching are listed (teaching_list), and only while the study shows them to trainees; the study
// checks both again for every replay. The entry is one small button (watchExpertEntry), for the
// training path or the home page; it lists the sessions in a dialog, and Watch opens the recording
// from this computer, as every replay does.

import { h } from '../ui/dom.js';
import { inform, showDialog } from '../ui/dialog.js';

/** True when the study shows experts' sessions to trainees (GET /me's study.replay) and the person is no expert. */
export function canWatchExperts(me) {
  const r = me && me.study && me.study.replay;
  const roles = (me && Array.isArray(me.roles) && me.roles.length) ? me.roles : [me && me.role];
  return Boolean(r && r.enabled !== false && r.trainees_watch_experts !== false) && !roles.includes('expert') && !roles.includes('admin');
}

/** One session to watch in words: "Expert one (E01): sub-001_task-rest_eeg.vhdr, 4 annotations". */
export function sessionText(s) {
  const who = s.display_name ? `${s.display_name} (${s.annotator_id})` : s.annotator_id;
  const n = Number.isFinite(s.n_annotations) ? `, ${s.n_annotations} annotation${s.n_annotations === 1 ? '' : 's'}` : '';
  return `${who}: ${s.file_name}${n}`;
}

/** Ask the study what there is to watch, and offer it in a dialog. */
export async function openWatchList(app) {
  let got;
  try {
    got = await app.backend.expert('teaching_list', {});
  } catch (exc) {
    if (exc.status !== 401) await inform('Watch an expert', `The list of experts' sessions could not be loaded: ${exc.message}`);
    return null;
  }
  if (!got.shown || !got.sessions.length) {
    await inform('Watch an expert', got.shown
      ? 'No expert has a session to show yet. Sessions appear here once an expert agrees to their work being used for teaching.'
      : 'This study does not show experts\' sessions to trainees at the moment.');
    return null;
  }
  const chosen = await showDialog({ title: 'Watch an expert at work', className: 'watch-dialog', wide: true, cancelValue: null,
    body: h('div', {},
      h('p.dialog-text', {}, 'See how an expert worked on a recording, step by step: where they looked, what they marked and how they changed it. '
        + 'You need the recording\'s file on this computer, as when you annotate.'),
      h('ul.watch-list', {}, got.sessions.map((s, i) => h('li', {}, h('span', {}, sessionText(s)),
        h('button.btn.small', { type: 'button', 'data-log': 'watch-session', 'data-pick': String(i) }, 'Watch'))))),
    buttons: [{ label: 'Close', value: null }],
    onOpen: ({ box, close }) => { for (const b of box.querySelectorAll('[data-pick]')) b.addEventListener('click', () => close(Number(b.dataset.pick))); } });
  if (chosen === null || chosen === undefined) return null;
  const s = got.sessions[chosen];
  const { startReplay } = await import('../expert/work.js');
  return startReplay(app, { annotator_id: s.annotator_id, recording_id: s.recording_id, attempt: s.attempt }, null);
}

/** The small entry: "Watch an expert at work", or null when the study shows trainees no experts' sessions. */
export function watchExpertEntry(app) {
  if (!canWatchExperts(app && app.me)) return null;
  return h('button.btn.small.quiet.watch-entry', { type: 'button', 'data-log': 'watch-expert', title: 'Replays of experts\' sessions, shown with their agreement',
    onclick: () => openWatchList(app) }, 'Watch an expert at work');
}
