// The sign-up questionnaire in the admin area (docs/web/admin.md, "Questionnaire"):
//
// * the section Questionnaire, under People: everyone's current answers by annotator ID
//   (questionnaire_summary), how often each answer was given, who has not answered yet, the answers as a
//   table to download, and the contacts list (contacts_download, written to the audit log, with a warning
//   that the file identifies people);
// * the card on a person's page in Annotators (questionnaire_get): their answers with each earlier version
//   and its date, and their name and contact details;
// * the editor in Study settings (the settings block questionnaire): whether it is asked, the demographic
//   questions with the ethics note, which contact details are asked, and the questions themselves.
//
// The answers are research data kept by annotator ID; names and contact details are for the study team only
// and never go into the research files except contacts.csv when it is asked for.

import { h, clear } from '../ui/dom.js';
import { actionButton, card, checkbox, chip, confirmInline, dataTable, downloadText, field, infoTable, loading, messageArea, sectionHead, select, textArea, textInput } from './ui.js';
import { csvText, whenText } from './model.js';
import {
  CONTACT_FIELDS, CONTACT_TITLES, DEMOGRAPHICS_NOTE, GROUPS, GROUP_TITLES, PREFER_NOT, PREFER_NOT_LABEL, TYPE_WORDS, answerText, checkQuestions,
} from '../views/questionnaire_model.js';

const LEVEL_WORDS = { required: 'Required', optional: 'Optional', off: 'Not asked' };

/** The answers as a table: one row per person, a column per question (and the words given with "Other"). */
export function answersCsv(questions, rows) {
  const cols = ['annotator_id', 'answered_at', 'questionnaire_version', 'n_changes'];
  for (const q of questions) { cols.push(q.id); if (q.other_option) cols.push(`${q.id}_other`); }
  const cell = (v) => (v === undefined || v === null ? '' : Array.isArray(v) ? v.join('; ') : String(v));
  const data = rows.map((r) => {
    const out = { annotator_id: r.annotator_id, answered_at: r.answered_at || '', questionnaire_version: r.version || '', n_changes: r.n_changes || 0 };
    for (const q of questions) {
      out[q.id] = cell(r.answers[q.id]);
      if (q.other_option) out[`${q.id}_other`] = cell((r.other || {})[q.id]);
    }
    return out;
  });
  return csvText(cols, data);
}

/** How often each answer to a question was given, most often first, as "3–10: 4 · 1–2: 2". */
export function countsText(q, counts) {
  const c = counts || {};
  const order = [...(q.options || []), 'answered', PREFER_NOT_LABEL];
  const keys = Object.keys(c).sort((a, b) => (c[b] - c[a]) || (order.indexOf(a) - order.indexOf(b)));
  if (!keys.length) return 'No answers yet';
  return keys.map((k) => `${k === 'answered' ? 'Answered' : k}: ${c[k]}`).join(' · ');
}

// ===================================================================== the section
export class QuestionnaireSection {
  constructor(area) {
    this.area = area;
    this.data = null;
    this.msg = messageArea();
    this.body = h('div.admin-stack');
    this.el = h('section.admin-section', { 'data-section': 'questionnaire' },
      sectionHead('Questionnaire', 'What annotators and experts said about their experience, career and background when they signed up, by annotator ID.'),
      this.msg, this.body);
  }

  async show() {
    this.msg.clear();
    clear(this.body);
    this.body.append(loading());
    try {
      this.data = await this.area.read('questionnaire_summary');
    } catch (exc) {
      clear(this.body);
      this.msg.problem(exc);
      return;
    }
    this._build();
  }

  _build() {
    clear(this.body);
    const d = this.data;
    const qs = d.questions || [];
    const off = d.enabled === false
      ? h('p.banner', {}, 'The study does not ask the questionnaire at the moment: switch it on in Study settings.') : null;
    const counts = dataTable([
      { title: 'Question', render: (q) => h('span', {}, q.text, h('span.caption.block', {}, `${GROUP_TITLES[q.group] || q.group} · ${q.id}`)) },
      { title: 'Answers given', render: (q) => countsText(q, d.counts[q.id]) },
    ], qs, { empty: 'The questionnaire has no questions.', pageSize: 60, caption: 'How often each answer was given' });
    const shown = qs.slice(0, 4);
    const people = dataTable([
      { title: 'Annotator', sort: (r) => r.annotator_id, render: (r) => h('span', {}, h('b', {}, r.annotator_id), r.removed ? h('span.caption.block', {}, 'account removed') : null) },
      { title: 'Answered', sort: (r) => r.answered_at, render: (r) => whenText(r.answered_at) },
      ...shown.map((q) => ({ title: q.text, sort: (r) => answerText(r.answers[q.id]), render: (r) => answerText(r.answers[q.id], (r.other || {})[q.id]) })),
      { title: 'Changes', num: true, sort: (r) => r.n_changes, render: (r) => String(r.n_changes || 0) },
      { title: '', cls: 'actions', render: (r) => (r.removed ? '' : h('button.btn.small', { type: 'button', onclick: () => this.area.go('annotators', { annotator: r.annotator_id }) }, 'Open')) },
    ], d.rows || [], { empty: 'Nobody has answered yet.', pageSize: 25, sortable: true, caption: 'Each person\'s current answers' });
    const csv = h('button.btn', { type: 'button', 'data-log': 'questionnaire-csv', onclick: () => downloadText('questionnaire_answers.csv', answersCsv(qs, d.rows || []), 'text/csv;charset=utf-8') }, 'Download the answers (CSV)');
    const waiting = d.not_answered && d.not_answered.length
      ? h('p.caption', {}, `Not answered yet: ${d.not_answered.join(', ')}. Their recordings, training and expert work open once they have answered.`)
      : h('p.caption', {}, 'Everyone who is asked has answered.');
    if (off) this.body.append(off);
    this.body.append(
      card('Answers',
        h('p.caption', {}, `Version ${d.version} of the questionnaire. ${PREFER_NOT_LABEL} counts as an answer. Each person's page in Annotators shows all their answers and the earlier versions; the results zip has the full history (questionnaire/answers.tsv).`),
        people, waiting, h('div.btn-row', {}, csv)),
      card('Answers by question', counts),
      this._contactsCard(),
      card('The questions', h('p.caption', {}, 'Add, remove and reword questions, choose the options and the contact details asked, and switch the demographic questions off, in Study settings.'),
        h('div.btn-row', {}, h('button.btn', { type: 'button', onclick: () => this.area.go('settings') }, 'Edit the questionnaire in Study settings'))));
  }

  _contactsCard() {
    const msg = messageArea();
    const host = h('div.inline-host');
    const get = actionButton('Download the contacts list (CSV)', { working: 'Preparing…', msg, log: 'contacts-download', onClick: async () => {
      const yes = await confirmInline(host, { text: 'The contacts list names people and gives their contact details. Download it?', yes: 'Download the contacts list', destructive: false });
      host.replaceChildren(get);
      if (!yes) return;
      const r = await this.area.write('contacts_download', {});
      const cols = r.columns || ['annotator_id', ...CONTACT_FIELDS, 'updated_at', 'account'];
      downloadText(r.file_name || 'contacts.csv', csvText(cols, r.rows || []), 'text/csv;charset=utf-8');
      msg.show('success', `Downloaded the contact details of ${(r.rows || []).length} ${(r.rows || []).length === 1 ? 'person' : 'people'}. The download is noted in the audit log.`);
    } });
    host.append(get);
    return card('Contact details',
      h('p.banner.contacts-warning', {}, 'The contacts list identifies people. Keep it apart from the research data, share it only with the study team, and delete it when it is no longer needed. Each download is noted in the audit log.'),
      h('p.caption', {}, 'Names and contact details are also on each person\'s page in Annotators. The research files (the results zip and the analyses) use annotator IDs only, unless you tick Include names and contact details in Results.'),
      h('div.btn-row', {}, host), msg);
  }
}

// ============================================================ a person's page
/** The card on a person's page in Annotators: their answers, with the earlier versions, and their contact details. */
export function questionnaireCard(area, u) {
  const body = h('div.admin-stack', {}, loading());
  const box = card('Questionnaire and contact details', body);
  area.read('questionnaire_get', { annotator_id: u.annotator_id }).then((d) => {
    clear(body);
    const c = d.contacts;
    body.append(h('h3', {}, 'Contact details'),
      c ? infoTable([...CONTACT_FIELDS.map((k) => [CONTACT_TITLES[k], c[k] || '–']), ['Last changed', whenText(c.updated_at)]])
        : h('p.caption', {}, d.asked ? `${u.annotator_id} has not given their contact details yet.` : 'Not asked: this account does not annotate.'));
    const [latest, ...earlier] = d.history || [];
    body.append(h('h3', {}, 'Answers'));
    if (!latest) {
      body.append(h('p.caption', {}, d.asked ? `${u.annotator_id} has not answered the questionnaire yet. Their recordings, training and expert work open once they have.` : 'Not asked: administrators who do not annotate are not asked.'));
      return;
    }
    const defs = d.definitions || {};
    const questions = (v) => defs[v] || d.questions || [];
    const table = (e) => infoTable(questions(e.version).map((q) => [q.text, answerText(e.answers[q.id], (e.other || {})[q.id])]));
    body.append(h('p.caption', {}, `Given ${whenText(latest.at)}, to version ${latest.version} of the questionnaire${latest.version !== d.version ? ' (the questions have changed since)' : ''}.`), table(latest));
    if (earlier.length) {
      body.append(h('details.q-history', {}, h('summary', {}, `Earlier answers (${earlier.length})`),
        earlier.map((e) => h('div.q-earlier', {}, h('p.caption', {}, `Given ${whenText(e.at)}, version ${e.version}`), table(e)))));
    }
  }, (exc) => { clear(body); body.append(h('p.caption', {}, `The answers could not be read: ${exc.message}`)); });
  return box;
}

// ============================================================ Study settings
const slug = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'q_$1').slice(0, 40) || 'question';

/**
 * The editor of the settings block questionnaire, for SettingsSection: `read()` gives the block as the study
 * keeps it (the questions in the order of electrotag/config/questionnaire.py check_question, so that an
 * unchanged list is not sent again), or throws with the problem in the study's words. `changed()` is called
 * after each edit that is not an input event (moving and removing questions).
 */
export function questionnaireEditor(block, changed = () => {}) {
  const b = block || {};
  const enabled = checkbox('Ask annotators and experts these questions before their first recording, training or expert work', b.enabled !== false);
  const demographics = checkbox('Include the demographic questions (age, gender and first language)', b.demographics !== false);
  const levels = Object.fromEntries(CONTACT_FIELDS.map((k) => {
    const s = select(Object.entries(LEVEL_WORDS), ((b.contacts || {})[k]) || 'optional');
    s.name = `contact_${k}`;
    return [k, s];
  }));
  const list = h('div.q-edit-list');
  const rows = [];
  const add = (q, { open = false } = {}) => {
    const row = questionRow(q, { open, move: (dir) => move(row, dir), remove: () => { rows.splice(rows.indexOf(row), 1); row.el.remove(); changed(); } });
    rows.push(row);
    list.append(row.el);
    return row;
  };
  const move = (row, dir) => {
    const i = rows.indexOf(row);
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    list.replaceChildren(...rows.map((r) => r.el));
    row.el.querySelector('summary').focus();
    changed();
  };
  for (const q of b.questions || []) add(q);
  const restoreHost = h('div.inline-host');
  const restore = h('button.btn.small.quiet', { type: 'button', 'data-log': 'questionnaire-defaults', onclick: async () => {
    const yes = await confirmInline(restoreHost, { text: 'Put back the default questions? Questions you added or changed are taken out.', yes: 'Put back the defaults' });
    restoreHost.replaceChildren(restore);
    if (!yes) return;
    const { DEFAULT_SETTINGS } = await import('../api/demo_catalogue.js');
    rows.splice(0).forEach((r) => r.el.remove());
    for (const q of DEFAULT_SETTINGS.questionnaire.questions) add(q);
    changed();
  } }, 'Put back the default questions');
  restoreHost.append(restore);
  const addButton = h('button.btn.small', { type: 'button', 'data-log': 'questionnaire-add', onclick: () => {
    const row = add({ id: '', group: 'experience', text: '', type: 'choice', required: true, options: [] }, { open: true });
    row.focus();
    changed();
  } }, 'Add a question');
  const el = card('Sign-up questionnaire',
    h('p.caption', {}, `Asked once, at the first sign-in of each annotator and expert, before any work opens; administrators who do not annotate are not asked. Every question offers ${PREFER_NOT_LABEL}. People can change their answers later from their home page, and each version is kept with its date.`),
    enabled,
    demographics,
    h('p.banner.demographics-note', {}, DEMOGRAPHICS_NOTE, ' Switch them off otherwise.'),
    h('h3', {}, 'Contact details'),
    h('p.caption', {}, 'Asked with the questions, kept apart from the answers and seen only by the study team. The email address is filled in from the account where it has one.'),
    h('div.form-grid', {}, CONTACT_FIELDS.map((k) => field(CONTACT_TITLES[k], levels[k]))),
    h('h3', {}, 'Questions'),
    h('p.caption', {}, 'Changing the wording or the options of a question starts a new version of the questionnaire: earlier answers keep the version they were given to, and the results say which it was.'),
    list,
    h('div.btn-row', {}, addButton, restoreHost));
  return {
    el,
    read() {
      const questions = rows.map((r) => r.read());
      const seen = new Set(questions.map((q) => q.id).filter(Boolean));
      for (const q of questions) {
        if (q.id) continue;
        let id = slug(q.text);
        for (let n = 2; seen.has(id); n++) id = `${slug(q.text).slice(0, 36)}_${n}`;
        q.id = id;
        seen.add(id);
      }
      const tidy = checkQuestions(questions); // the study's own checks, in its words
      return { enabled: enabled.input.checked, demographics: demographics.input.checked, questions: tidy,
        contacts: Object.fromEntries(CONTACT_FIELDS.map((k) => [k, levels[k].value])) };
    },
  };
}

/** One question in the editor: a summary line that opens on its fields. */
function questionRow(q, { open, move, remove }) {
  const text = textInput({ value: q.text || '', maxlength: 300 });
  const id = textInput({ value: q.id || '', maxlength: 40, placeholder: 'made from the question' });
  const group = select(GROUPS.map((g) => [g, GROUP_TITLES[g]]), q.group || 'experience');
  const type = select(Object.entries(TYPE_WORDS), q.type || 'choice');
  const options = textArea({ value: (q.options || []).join('\n'), rows: Math.min(10, Math.max(3, (q.options || []).length)), placeholder: 'One option per line' });
  const other = textInput({ value: q.other_option || '', maxlength: 120, placeholder: 'for example Other' });
  const help = textInput({ value: q.help || '', maxlength: 500 });
  const required = checkbox('An answer is needed (Prefer not to say counts as one)', q.required !== false);
  const title = h('span.q-edit-title');
  const sync = () => {
    title.replaceChildren(h('span', {}, text.value.trim() || 'New question'), h('span.caption', {}, ` · ${GROUP_TITLES[group.value]} · ${TYPE_WORDS[type.value]}`));
    const choice = type.value !== 'text';
    options.closest('.admin-field') && (options.closest('.admin-field').hidden = !choice);
    other.closest('.admin-field') && (other.closest('.admin-field').hidden = !choice);
  };
  const removeHost = h('span.inline-host');
  const removeButton = h('button.btn.small.quiet.destructive-text', { type: 'button', onclick: async () => {
    const yes = await confirmInline(removeHost, { text: 'Remove this question? Answers already given to it are kept.', yes: 'Remove the question' });
    removeHost.replaceChildren(removeButton);
    if (yes) remove();
  } }, 'Remove');
  removeHost.append(removeButton);
  const el = h('details.q-edit', { open: open || null }, h('summary', {}, title),
    h('div.q-edit-body', {},
      field('Question', text, { wide: true }),
      h('div.form-grid', {}, field('Group', group), field('Answers', type), field('Name in the results', id, { hint: 'Lower-case letters, digits and _.' })),
      field('Options', options, { hint: `One per line. ${PREFER_NOT_LABEL} is added by itself.`, wide: true }),
      field('Option that asks for their own words', other, { hint: 'Must be one of the options, written the same way; leave empty for none.' }),
      field('Help under the question', help, { wide: true }),
      required,
      h('div.btn-row', {}, h('button.btn.small.quiet', { type: 'button', onclick: () => move(-1) }, 'Move up'),
        h('button.btn.small.quiet', { type: 'button', onclick: () => move(1) }, 'Move down'), removeHost)));
  for (const c of [text, group, type]) c.addEventListener('input', sync);
  group.addEventListener('change', sync);
  type.addEventListener('change', sync);
  sync();
  return {
    el,
    focus: () => text.focus(),
    read() {
      const out = { id: id.value.trim(), group: group.value, text: text.value, type: type.value, required: required.input.checked };
      if (type.value !== 'text') {
        out.options = options.value.split('\n').map((x) => x.trim()).filter(Boolean);
        if (other.value.trim()) out.other_option = other.value.trim();
      }
      if (help.value.trim()) out.help = help.value.trim();
      return out;
    },
  };
}

/** A chip for the Annotators list: whether someone who is asked has answered. */
export function answeredChip(u) {
  if (u.questionnaire_answered === undefined) return null;
  return u.questionnaire_answered ? null : chip('Questionnaire to answer', 'warn');
}

export { PREFER_NOT };
