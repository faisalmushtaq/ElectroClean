// The sign-up questionnaire (docs/web/using.md, "Before your first recording"): asked once, at the first
// sign-in of an annotator or expert, before any recording, training or expert work opens, and open again
// from the home page to change the answers. Every question offers "Prefer not to say". The answers are
// research data kept by annotator ID; the name and contact details are kept apart, for the study team.
//
// Nothing on this page reaches the interaction log: the app pauses the log while it is shown (as in
// the admin area), and once the answers are saved it records only that the questionnaire was answered
// and how many questions were (questionnaire_answered). Saving is sent once, never repeated by itself;
// a second press while it is on its way does nothing.

import { h } from '../ui/dom.js';
import { appHeader } from './common.js';
import { PREFER_NOT, PREFER_NOT_LABEL, answeredCount } from './questionnaire_model.js';

let seq = 0;
const uid = (what) => `q-${what}-${++seq}`;

/** One question as a fieldset: its options (radio buttons or tick boxes), or a short answer, and Prefer not to say. */
function questionField(q, answer, other) {
  const name = uid(q.id);
  const fs = h('fieldset.q-question', { 'data-question': q.id });
  const legend = h('legend.q-text', {}, q.text, q.required === false ? h('span.caption.q-optional', {}, ' (optional)') : null);
  fs.append(legend);
  if (q.help) fs.append(h('p.caption.q-help', {}, q.help));
  const otherField = q.other_option ? h('input.field.q-other', { type: 'text', maxlength: '200', 'aria-label': `${q.other_option}: in your own words`,
    placeholder: 'In your own words (optional)', value: other || '' }) : null;
  const choices = h('div.q-choices');
  const inputs = [];
  const check = (value, label, kind) => {
    const input = h('input', { type: kind, name, value });
    inputs.push(input);
    choices.append(h('label.check.q-choice', {}, input, h('span', {}, label)));
    return input;
  };
  let read;
  if (q.type === 'text') {
    const text = h('input.field.q-answer', { type: 'text', maxlength: '200', 'aria-labelledby': '', value: answer && answer !== PREFER_NOT ? answer : '' });
    const pnts = h('input', { type: 'checkbox', value: PREFER_NOT });
    pnts.checked = answer === PREFER_NOT;
    text.disabled = pnts.checked;
    pnts.addEventListener('change', () => { text.disabled = pnts.checked; });
    const lid = uid('legend');
    legend.id = lid;
    text.setAttribute('aria-labelledby', lid);
    fs.append(text, h('label.check.q-choice.q-prefer', {}, pnts, h('span', {}, PREFER_NOT_LABEL)));
    read = () => (pnts.checked ? PREFER_NOT : text.value.trim() || null);
    return { el: fs, id: q.id, read, readOther: () => '' };
  }
  const kind = q.type === 'multi' ? 'checkbox' : 'radio';
  const given = Array.isArray(answer) ? answer : answer ? [answer] : [];
  for (const o of q.options) check(o, o, kind).checked = given.includes(o);
  const pnts = check(PREFER_NOT, PREFER_NOT_LABEL, kind);
  pnts.checked = given.includes(PREFER_NOT);
  pnts.closest('label').classList.add('q-prefer');
  fs.append(choices);
  const sync = (changed) => {
    if (kind === 'checkbox' && changed) {
      // Prefer not to say stands alone: choosing it clears the others, choosing another clears it
      if (changed === pnts && pnts.checked) inputs.forEach((i) => { if (i !== pnts) i.checked = false; });
      else if (changed !== pnts && changed.checked) pnts.checked = false;
    }
    if (otherField) {
      const on = inputs.some((i) => i.checked && i.value === q.other_option);
      otherField.hidden = !on;
    }
  };
  inputs.forEach((i) => i.addEventListener('change', () => sync(i)));
  if (otherField) fs.append(otherField);
  sync(null);
  read = () => {
    const chosen = inputs.filter((i) => i.checked).map((i) => i.value);
    if (kind === 'radio') return chosen[0] || null;
    return chosen.length ? chosen : null;
  };
  const readOther = () => (otherField && !otherField.hidden ? otherField.value.trim() : '');
  return { el: fs, id: q.id, read, readOther };
}

/** The contact details: each field the study asks for, with its level (required or optional). */
function contactFields(spec) {
  const out = [];
  const box = h('div.q-contacts');
  const types = { email: 'email', phone: 'tel' };
  const auto = { full_name: 'name', email: 'email', phone: 'tel', institution: 'organization' };
  for (const f of spec.fields || []) {
    const id = uid(f.key);
    const input = h('input.field', { id, name: f.key, type: types[f.key] || 'text', maxlength: f.key === 'phone' ? '40' : '200',
      autocomplete: auto[f.key], required: f.level === 'required', value: (spec.values || {})[f.key] || '' });
    box.append(h('label.form-label', { for: id }, f.title, f.level === 'required' ? null : h('span', {}, ' (optional)')), input);
    out.push({ key: f.key, input });
  }
  return { el: box, read: () => Object.fromEntries(out.map((f) => [f.key, f.input.value.trim()])) };
}

/**
 * The page. `first`: the first sign-in (Save and continue; no way past it but signing out); otherwise the
 * person came from home to change their answers (Save my answers, or Back to my recordings).
 * `onSaved(answer, nAnswered)` follows a save the study accepted; `onLeave()` goes back without saving.
 */
export function questionnaireView(app, data, { first = false, onSaved, onLeave }) {
  const groups = data.groups || [];
  const fields = [];
  const cards = groups.map((g) => {
    const qs = (data.questions || []).filter((q) => q.group === g.key);
    const made = qs.map((q) => questionField(q, (data.answers || {})[q.id], (data.other || {})[q.id]));
    fields.push(...made);
    return h('section.card.q-group', { 'data-group': g.key }, h('h2', {}, g.title), made.map((f) => f.el));
  });
  const contacts = contactFields(data.contacts || {});
  const problem = h('p.banner.q-problem', { role: 'alert', hidden: true });
  const status = h('p.caption.q-status', { role: 'status' });
  const save = h('button.btn.primary', { type: 'submit', 'data-log': 'questionnaire-save' }, first ? 'Save and continue' : 'Save my answers');
  let sending = false;
  const form = h('form.q-form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (sending) return; // a second press while the answers are on their way does nothing
    problem.hidden = true;
    const answers = {};
    const other = {};
    for (const f of fields) {
      const v = f.read();
      if (v !== null) answers[f.id] = v;
      const words = f.readOther();
      if (words) other[f.id] = words;
    }
    sending = true;
    save.disabled = true;
    status.textContent = 'Saving your answers…';
    try {
      const answer = await app.backend.saveQuestionnaire({ answers, other, contacts: contacts.read() });
      status.textContent = '';
      await onSaved(answer, answeredCount(answers));
    } catch (exc) {
      status.textContent = '';
      if (exc.status === 401) return;
      problem.textContent = exc.status === 0 || exc.code === 'network'
        ? 'Your answers could not be sent: the study could not be reached. Check your connection, then press the button again.'
        : exc.message || 'Your answers could not be saved. Press the button again.';
      problem.hidden = false;
      const q = /“(.+)”/.exec(problem.textContent);
      const where = q ? fields.find((f) => f.el.querySelector('legend').firstChild.textContent === q[1]) : null;
      (where ? where.el : problem).scrollIntoView({ block: 'center' });
    } finally {
      sending = false;
      save.disabled = false;
    }
  } },
  cards,
  h('section.card.q-group', { 'data-group': 'contacts' }, h('h2', {}, 'How the study team can reach you'),
    h('p.caption', {}, 'Your name and contact details are kept apart from your answers and seen only by the study team. They never appear in the research data, which uses your annotator ID.'),
    contacts.el),
  problem,
  h('div.btn-row.q-actions', {}, save, first ? null : h('button.btn.quiet', { type: 'button', 'data-log': 'questionnaire-back', onclick: () => onLeave() }, 'Back to my recordings')),
  status);
  const when = data.answered_at ? new Date(data.answered_at) : null;
  const intro = first
    ? 'Before your first recording, a few questions about your experience of EEG and your career, and how the study team can reach you. It takes about three minutes.'
    : `You answered these questions${when && !Number.isNaN(when.getTime()) ? ` on ${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}. Change anything that is different now: the study keeps each version with its date.`;
  return h('div.view.questionnaire', { 'data-view': 'questionnaire' }, appHeader(app),
    h('main.page.q-page', {},
      h('h1', {}, first ? 'A few questions before you start' : 'Your answers'),
      h('p.subtitle', {}, intro),
      h('p.caption.q-privacy', {}, `Every question has ${PREFER_NOT_LABEL}. Your answers are research data, kept under your annotator ID (${data.annotator_id || app.me.annotator_id}) and seen only by the study team; other annotators and experts never see them.`),
      form));
}
