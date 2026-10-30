// The sign-up questionnaire's rules, in the browser (docs/web/api.md, "The sign-up questionnaire"): the
// checks of a definition (electrotag/config/questionnaire.py) and of the answers
// (electrotag/web/questionnaire.py check_answers), with the same words, the questions people are asked, and
// the version of a wording. The person's page (questionnaire.js), the admin area's editor and the
// sandbox (demo_questionnaire.js) use them; web_tests/unit/api_contract_parity.test.mjs keeps them the same
// as the study's.

import { sha256Hex } from '../eeg/sha256.js';
import { pyStrRepr } from '../eeg/pyfmt.js';

export const PREFER_NOT = 'prefer_not_to_say';
export const PREFER_NOT_LABEL = 'Prefer not to say';
export const GROUPS = ['experience', 'career', 'demographics'];
export const GROUP_TITLES = { experience: 'Your experience of EEG', career: 'Your career stage and field', demographics: 'About you' };
export const DEMOGRAPHICS_NOTE = 'Age, gender and first language are personal data of a more sensitive kind. Include them only if '
  + "the study's ethics approval covers collecting them.";
export const QUESTION_TYPES = ['choice', 'multi', 'text'];
export const TYPE_WORDS = { choice: 'One answer', multi: 'Several answers', text: 'A short answer in their own words' };
export const CONTACT_FIELDS = ['full_name', 'email', 'phone', 'institution'];
export const CONTACT_TITLES = { full_name: 'Full name', email: 'Email', phone: 'Phone', institution: 'Institution' };
export const CONTACT_LEVELS = ['required', 'optional', 'off'];
export const DEFAULT_CONTACTS = { full_name: 'required', email: 'required', phone: 'optional', institution: 'optional' };
export const CONTACT_LIMITS = { full_name: 200, email: 254, phone: 40, institution: 200 };
export const MAX_QUESTIONS = 60;
export const MAX_OPTIONS = 30;
export const MAX_ANSWER = 200;
export const EXPERIENCE_QUESTION = 'datasets_analysed';
export const GATED = 'questionnaire_required';
export const REQUIRED_TEXT = 'Please answer the short sign-up questionnaire first. Your recordings, training and expert work open '
  + 'once it is answered; you can change your answers later from your home page.';
export const CONTACTS_WARNING = 'This file names people and gives their contact details. Keep it apart from the research data, '
  + 'share it only with the study team, and delete it when it is no longer needed.';
const ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,63}$/;
const PHONE_RE = /^[0-9+()./ -]{3,40}$/;
const FIELDS = ['id', 'group', 'text', 'type', 'options', 'other_option', 'required', 'help'];

/** An error of a definition or of answers, with the code the study answers (422 for answers). */
export class QuestionnaireProblem extends Error {
  constructor(message, code = 'invalid_answers') {
    super(message);
    this.code = code;
  }
}

const squash = (s) => s.split(/\s+/).filter(Boolean).join(' ');
const repr = (v) => (typeof v === 'string' ? pyStrRepr(v) : JSON.stringify(v));

function plain(value, what, limit, { required = true } = {}) {
  if ((value === undefined || value === null) && !required) return '';
  if (typeof value !== 'string' || /[\n\r]/.test(value)) throw new QuestionnaireProblem(`${what} must be text on one line`);
  const text = squash(value);
  if (required && !text) throw new QuestionnaireProblem(`${what} is missing`);
  if (text.length > limit) throw new QuestionnaireProblem(`${what} must be at most ${limit} characters`);
  return text;
}

/** One question of a definition, checked and tidied as the study does it (check_question). */
export function checkQuestion(q, n) {
  let where = `Question ${n}`;
  if (!q || typeof q !== 'object' || Array.isArray(q)) throw new QuestionnaireProblem(`${where} must be an object with id, group, text and type`);
  const unknown = Object.keys(q).filter((k) => !FIELDS.includes(k)).sort();
  if (unknown.length) throw new QuestionnaireProblem(`${where} has a field ${repr(unknown[0])} that questions do not have`);
  if (typeof q.id !== 'string' || !ID_RE.test(q.id)) {
    throw new QuestionnaireProblem(`${where}: id must be a short name of lower-case letters, digits and _ that starts with a letter, such as eeg_years`);
  }
  where = `Question ${q.id}`;
  if (!GROUPS.includes(q.group)) throw new QuestionnaireProblem(`${where}: group must be one of ${GROUPS.join(', ')}`);
  if (!QUESTION_TYPES.includes(q.type)) throw new QuestionnaireProblem(`${where}: type must be choice (one answer), multi (several) or text`);
  const out = { id: q.id, group: q.group, text: plain(q.text, `${where}: the question`, 300), type: q.type };
  const required = q.required === undefined ? true : q.required;
  if (typeof required !== 'boolean') throw new QuestionnaireProblem(`${where}: required must be true or false`);
  out.required = required;
  if (q.type === 'text') {
    if ((q.options && q.options.length) || q.other_option) throw new QuestionnaireProblem(`${where}: a text question has no options`);
  } else {
    const opts = q.options;
    if (!Array.isArray(opts) || opts.length < 2 || opts.length > MAX_OPTIONS) throw new QuestionnaireProblem(`${where}: give from 2 to ${MAX_OPTIONS} options`);
    const clean = opts.map((o) => plain(o, `${where}: an option`, 120));
    if (new Set(clean.map((c) => c.toLowerCase())).size !== clean.length) throw new QuestionnaireProblem(`${where}: an option is given twice`);
    if (clean.some((c) => [PREFER_NOT_LABEL.toLowerCase(), PREFER_NOT].includes(c.toLowerCase()))) {
      throw new QuestionnaireProblem(`${where}: leave out "${PREFER_NOT_LABEL}"; ElectroTag offers it with every question`);
    }
    out.options = clean;
    if (q.other_option !== undefined && q.other_option !== null && q.other_option !== '') {
      const other = plain(q.other_option, `${where}: other_option`, 120);
      if (!clean.includes(other)) {
        throw new QuestionnaireProblem(`${where}: other_option must be one of its options (the one that asks the person to describe it in their own words)`);
      }
      out.other_option = other;
    }
  }
  const help = plain(q.help, `${where}: help`, 500, { required: false });
  if (help) out.help = help;
  return out;
}

/** questionnaire.questions: null (the default questionnaire) or a list of questions, checked (check_questions). */
export function checkQuestions(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_QUESTIONS) {
    throw new QuestionnaireProblem(`questionnaire.questions must be null (the default questionnaire) or a list of 1 to ${MAX_QUESTIONS} questions`);
  }
  const out = value.map((q, i) => checkQuestion(q, i + 1));
  const ids = out.map((q) => q.id);
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) throw new QuestionnaireProblem(`The question id ${dup} is used twice; each question needs its own`);
  return out;
}

/** questionnaire.contacts: each contact detail required, optional or off (check_contacts). */
export function checkContacts(value) {
  if (value === null || value === undefined) return { ...DEFAULT_CONTACTS };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new QuestionnaireProblem('questionnaire.contacts must give each contact detail (full_name, email, phone, institution) as required, optional or off');
  }
  const unknown = Object.keys(value).filter((k) => !CONTACT_FIELDS.includes(k)).sort();
  if (unknown.length) throw new QuestionnaireProblem(`questionnaire.contacts has no detail ${repr(unknown[0])}; it has ${CONTACT_FIELDS.join(', ')}`);
  const out = { ...DEFAULT_CONTACTS };
  for (const [k, v] of Object.entries(value)) {
    if (!CONTACT_LEVELS.includes(v)) throw new QuestionnaireProblem(`questionnaire.contacts.${k} must be required, optional or off`);
    out[k] = v;
  }
  return out;
}

/** Problems with the questionnaire block of a study's settings, in the words the study gives (for Study settings). */
export function questionnaireProblems(block) {
  const b = block || {};
  const out = [];
  for (const k of ['enabled', 'demographics']) if (k in b && typeof b[k] !== 'boolean') out.push(`questionnaire.${k} must be true or false, not ${repr(b[k])}`);
  try { checkQuestions(b.questions); } catch (exc) { out.push(exc.message); }
  try { checkContacts(b.contacts); } catch (exc) { out.push(exc.message); }
  return out.map((m) => `These settings cannot be used: ${m}`);
}

/** The questions people are asked: without the demographic group when it is off, in the order of the groups. */
export function effectiveQuestions(block, defaults) {
  const b = block || {};
  const chosen = checkQuestions(b.questions) || JSON.parse(JSON.stringify(defaults || []));
  const kept = chosen.filter((q) => b.demographics !== false || q.group !== 'demographics');
  return kept.map((q, i) => [q, i]).sort((x, y) => (GROUPS.indexOf(x[0].group) - GROUPS.indexOf(y[0].group)) || (x[1] - y[1])).map(([q]) => q);
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** The version of a wording: "q-" and ten hexadecimal digits of the SHA-256 of its JSON (version_of). */
export function versionOf(questions) {
  return `q-${sha256Hex(new TextEncoder().encode(canonical(questions))).slice(0, 10)}`;
}

function line(value, what, limit) {
  if (typeof value !== 'string') throw new QuestionnaireProblem(`${what} must be text`);
  if (/[\n\r]/.test(value)) throw new QuestionnaireProblem(`${what} must be on one line`);
  const text = squash(value);
  if (text.length > limit) throw new QuestionnaireProblem(`${what} must be at most ${limit} characters`);
  return text;
}

/** The answers of a submission checked against the questions (check_answers): [answers, other]. */
export function checkAnswers(questions, answers, other) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new QuestionnaireProblem('answers must map each question\'s id to its answer');
  const words = other === undefined || other === null ? {} : other;
  if (typeof words !== 'object' || Array.isArray(words)) throw new QuestionnaireProblem('other must map a question\'s id to the words given with its "Other" option');
  const ids = new Set(questions.map((q) => q.id));
  const unknown = Object.keys(answers).filter((k) => !ids.has(k)).sort();
  if (unknown.length) {
    throw new QuestionnaireProblem(`There is no question ${repr(unknown[0])} in this study's questionnaire; reload the page to see the questions as they are now`, 'unknown_question');
  }
  const out = {};
  const said = {};
  for (const q of questions) {
    let value = answers[q.id];
    const title = `“${q.text}”`;
    const missing = () => {
      if (q.required !== false) throw new QuestionnaireProblem(`Please answer ${title}, or choose ${PREFER_NOT_LABEL}.`, 'questionnaire_incomplete');
    };
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) { missing(); continue; }
    if (q.type === 'choice') {
      if (value !== PREFER_NOT && !q.options.includes(value)) throw new QuestionnaireProblem(`${repr(value)} is not one of the answers to ${title}`);
    } else if (q.type === 'multi') {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new QuestionnaireProblem(`The answer to ${title} must be a list of its options`);
      if (new Set(value).size !== value.length) throw new QuestionnaireProblem(`The answer to ${title} names an option twice`);
      if (value.includes(PREFER_NOT) && value.length > 1) throw new QuestionnaireProblem(`${PREFER_NOT_LABEL} cannot be chosen together with other answers to ${title}`);
      const bad = value.filter((v) => v !== PREFER_NOT && !q.options.includes(v));
      if (bad.length) throw new QuestionnaireProblem(`${repr(bad[0])} is not one of the answers to ${title}`);
      const ordered = q.options.filter((o) => value.includes(o));
      value = ordered.length ? ordered : [PREFER_NOT];
    } else {
      value = line(value, `The answer to ${title}`, MAX_ANSWER);
      if (!value) { missing(); continue; }
    }
    out[q.id] = value;
    const chosen = Array.isArray(value) ? value : [value];
    if (q.other_option && chosen.includes(q.other_option) && words[q.id] !== undefined && words[q.id] !== null && words[q.id] !== '') {
      const text = line(words[q.id], `The words given with ${q.other_option}`, MAX_ANSWER);
      if (text) said[q.id] = text;
    }
  }
  for (const k of Object.keys(words).sort()) {
    if (!(k in said) && words[k] !== undefined && words[k] !== null && words[k] !== '' && !ids.has(k)) {
      throw new QuestionnaireProblem(`There is no question ${repr(k)} in this study's questionnaire`, 'unknown_question');
    }
  }
  return [out, said];
}

/** The contact details of a submission checked against the study's levels (_contacts_in). */
export function checkContactValues(levels, given) {
  const g = given === undefined || given === null ? {} : given;
  if (typeof g !== 'object' || Array.isArray(g)) throw new QuestionnaireProblem('contacts must be an object with full_name, email, phone and institution');
  const unknown = Object.keys(g).filter((k) => !CONTACT_FIELDS.includes(k)).sort();
  if (unknown.length) throw new QuestionnaireProblem(`There is no contact detail ${repr(unknown[0])}`);
  const out = {};
  for (const k of CONTACT_FIELDS) {
    const level = levels[k] || 'optional';
    if (level === 'off') continue;
    const value = g[k];
    const text = value === undefined || value === null ? '' : line(value, CONTACT_TITLES[k], CONTACT_LIMITS[k]);
    if (!text && level === 'required') throw new QuestionnaireProblem(`Please give your ${CONTACT_TITLES[k].toLowerCase()}.`, 'questionnaire_incomplete');
    if (text && k === 'email' && !EMAIL_RE.test(text)) throw new QuestionnaireProblem(`${text} does not look like an email address`);
    if (text && k === 'phone' && !PHONE_RE.test(text)) throw new QuestionnaireProblem('A phone number may have digits, spaces, +, brackets and dashes');
    out[k] = text;
  }
  return out;
}

/** An answer as people read it: the option, the options joined, "Prefer not to say", or a dash. */
export function answerText(value, other = '') {
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return '–';
  const words = (Array.isArray(value) ? value : [value]).map((v) => (v === PREFER_NOT ? PREFER_NOT_LABEL : String(v)));
  return words.join(', ') + (other ? ` (${other})` : '');
}

/** How many questions a set of answers answers. */
export function answeredCount(answers) {
  return Object.values(answers || {}).filter((v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)).length;
}
