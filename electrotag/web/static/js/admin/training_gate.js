// A trainee's training path on their page in People (js/admin/annotators.js): each stage as the trainee
// sees it, the stages they skipped and when, whether their study recordings are open, and, after an
// assessment that did not meet the criteria, the study team's two ways on: reopen the training (the
// trainee practises again and retakes the assessment) or give them a new assessment set. Both ask
// first, are sent once and are kept in the audit log (training_reopen, training_assessment_set).

import { h, clear } from '../ui/dom.js';
import { actionButton, card, chip, confirmInline, loading, messageArea, select } from './ui.js';
import { whenText } from './model.js';
import { STAGE_TITLES } from '../training/stages.js';

const STATUS_WORDS = { locked: 'locked', available: 'ready', in_progress: 'in progress', completed: 'completed', skipped: 'skipped', not_used: 'not included' };
const EVENT_WORDS = {
  stage_skipped: 'skipped', stage_resumed: 'took up again', stage_completed: 'finished',
  training_reopened: 'training reopened', assessment_set_assigned: 'new assessment set',
};

/** One line of a stage event, for the study team: "Find your way around skipped, 30 October at 10:15". */
export function eventText(e) {
  const what = e.stage ? `${STAGE_TITLES[e.stage] || e.stage} ${EVENT_WORDS[e.event] || e.event}` : (EVENT_WORDS[e.event] || e.event);
  const extra = e.event === 'training_reopened' && e.from ? ` (from ${STAGE_TITLES[e.from] || e.from})`
    : e.event === 'assessment_set_assigned' && e.from_set ? ` (after ${e.from_set})` : '';
  const by = e.by ? ` by ${e.by}` : '';
  return `${what.charAt(0).toUpperCase()}${what.slice(1)}${extra}${by}, ${whenText(e.at)}`;
}

/** The card, or null for someone outside a training programme. */
export function trainingGateCard(area, u, reload) {
  if (!u.programme) return null;
  const body = h('div.admin-stack', {}, loading());
  const box = card('Training path', body);
  area.read('training_gate_get', { annotator_id: u.annotator_id }).then((g) => {
    clear(body);
    body.append(...content(area, u, g, reload));
  }, (exc) => {
    clear(body);
    const msg = messageArea();
    body.append(msg);
    msg.problem(exc);
  });
  return box;
}

function content(area, u, g, reload) {
  const msg = messageArea();
  const out = [];
  const gate = g.training_gate || { open: true };
  out.push(h('p', {}, gate.open ? chip('Study recordings open', 'done') : chip('Study recordings locked', 'warning'),
    gate.open ? '' : h('span.caption.block', {}, gate.message)));
  const prog = g.programme;
  if (prog && prog.stages) {
    out.push(h('ol.gate-stages', {}, prog.stages.map((s) => h('li', {}, h('b', {}, s.title || STAGE_TITLES[s.key]), `: ${STATUS_WORDS[s.status] || s.status}`,
      s.key === 'assessment' && s.result ? ` (${s.result.replace('_', ' ')})` : ''))));
  }
  const events = g.events || [];
  if (events.length) {
    out.push(h('details.admin-details', {}, h('summary', {}, `What happened to the stages (${events.length})`),
      h('ul.gate-events', {}, events.map((e) => h('li.caption', {}, eventText(e))))));
  }
  if (g.can_reopen || g.can_assign_set) {
    out.push(h('h3', {}, 'After the assessment'),
      h('p.caption', {}, `${u.annotator_id}'s assessment did not meet the criteria. Reopen the training, so that they practise again and take `
        + 'the assessment once more (what they saved before is kept, and only what they save from now on counts), or give them the '
        + 'assessment of another set.'));
    if (g.can_reopen) {
      const from = select([['practice', 'From On your own (practice)'], ['guided', 'From Learn with the experts']], 'practice');
      const host = h('div.btn-row');
      const go = actionButton('Reopen the training', { working: 'Reopening…', msg, log: 'training-reopen', onClick: async () => {
        if (!(await confirmInline(host, { text: `Reopen ${u.annotator_id}'s training ${from.value === 'guided' ? 'from Learn with the experts' : 'from On your own'}?`, yes: 'Reopen it', destructive: false }))) return;
        await area.write('training_reopen', { annotator_id: u.annotator_id, from: from.value });
        await reload(['success', `${u.annotator_id}'s training is reopened: their training path shows what to do next.`]);
      } });
      host.append(from, go);
      out.push(host);
    }
    if (g.can_assign_set) {
      const sets = g.assessment_sets || [];
      if (!sets.length) {
        out.push(h('p.caption', {}, 'To give a new assessment, make another reference set with assessment recordings in Training.'));
      } else {
        const which = select(sets.map((s) => [s.set_id, `${s.name} (${s.n_assessment} assessment recording${s.n_assessment === 1 ? '' : 's'})`]));
        const host = h('div.btn-row');
        const go = actionButton('Give this assessment', { working: 'Saving…', msg, log: 'training-assessment-set', onClick: async () => {
          if (!(await confirmInline(host, { text: `Give ${u.annotator_id} the assessment of ${which.value}? Their learning stages count as done there.`, yes: 'Give it', destructive: false }))) return;
          await area.write('training_assessment_set', { annotator_id: u.annotator_id, set_id: which.value });
          await reload(['success', `${u.annotator_id} now takes the assessment of ${which.value}.`]);
        } });
        host.append(which, go);
        out.push(host);
      }
    }
  }
  out.push(msg);
  return out;
}
