// "How everyone marked it": the way in for trainees to the crowd of a training recording (docs/web/using.md,
// "How everyone marked a training recording"). The study shows it only when its setting
// replay.trainees_see_crowd is on, only on the training recordings for learning with the experts, and with
// nobody named (overlay_get checks all of this on the server). The entry is one small button on the training
// path's "Learn with the experts" card; it lists the recordings in a dialog, and See opens the recording from
// this computer, as a replay does.

import { h } from '../ui/dom.js';
import { inform, showDialog } from '../ui/dialog.js';

/** True when the study shows trainees the crowd (GET /me's study.replay) and the person is no expert. */
export function canSeeCrowd(me) {
  const r = me && me.study && me.study.replay;
  const roles = (me && Array.isArray(me.roles) && me.roles.length) ? me.roles : [me && me.role];
  return Boolean(r && r.trainees_see_crowd === true) && !roles.includes('expert') && !roles.includes('admin');
}

/** One recording in words: "sub-example01_task-example_eeg.vhdr: 14 people, you among them". */
export function crowdText(r) {
  return `${r.file_name}: ${r.n_people} ${r.n_people === 1 ? 'person' : 'people'}${r.yours ? ', you among them' : ''}`;
}

/** Ask the study which training recordings have a crowd to show, and offer them in a dialog. */
export async function openCrowdList(app) {
  let got;
  try {
    got = await app.backend.expert('overlay_teaching_list', {});
  } catch (exc) {
    if (exc.status !== 401) await inform('How everyone marked it', `The list could not be loaded: ${exc.message}`);
    return null;
  }
  if (!got.shown || !got.recordings.length) {
    await inform('How everyone marked it', got.shown
      ? 'No training recording has been saved by anyone yet. Come back once people have worked on the recordings for learning with the experts.'
      : 'This study does not show trainees how others marked the training recordings at the moment.');
    return null;
  }
  const chosen = await showDialog({ title: 'How everyone marked a training recording', className: 'watch-dialog', wide: true, cancelValue: null,
    body: h('div', {},
      h('p.dialog-text', {}, 'See where everyone who worked on a training recording marked artifacts, as a shaded band under each channel: the darker, '
        + 'the more people marked that moment. Nobody is named. You need the recording\'s file on this computer, as when you annotate.'),
      h('ul.watch-list', {}, got.recordings.map((r, i) => h('li', {}, h('span', {}, crowdText(r)),
        h('button.btn.small', { type: 'button', 'data-log': 'crowd-recording', 'data-pick': String(i) }, 'See'))))),
    buttons: [{ label: 'Close', value: null }],
    onOpen: ({ box, close }) => { for (const b of box.querySelectorAll('[data-pick]')) b.addEventListener('click', () => close(Number(b.dataset.pick))); } });
  if (chosen === null || chosen === undefined) return null;
  const r = got.recordings[chosen];
  const { startOverlay } = await import('./overlay.js');
  return startOverlay(app, { recording_id: r.recording_id, mode: r.mode, context_id: r.context_id }, null);
}

/** The small entry, or null when the study does not show trainees the crowd. */
export function crowdEntry(app) {
  if (!canSeeCrowd(app && app.me)) return null;
  return h('button.btn.small.quiet.watch-entry', { type: 'button', 'data-log': 'crowd-entry', title: 'Everyone\'s marks on the training recordings, with nobody named',
    onclick: () => openCrowdList(app) }, 'How everyone marked it');
}
