// The sign-up questionnaire in the sandbox (docs/web/api.md, "The sign-up questionnaire"), as
// electrotag/web/questionnaire.py keeps it on a study server: GET and POST /me/questionnaire, the gate on
// work until it is answered, the field `questionnaire` of GET /me, and the admin area's
// questionnaire_get, questionnaire_summary and contacts_download. The answers and the contact details are
// kept apart in the sandbox's state, in this browser only.
//
// The sandbox's own accounts (A01, T01, E01) start with example answers, so that a visitor is never
// stopped by the questionnaire; they can open it from the home page. Accounts a visitor adds in the
// admin area are asked, as in a study.

import { ApiError } from './http.js';
import { nowLocalIso } from '../util.js';
import { rolesOf } from '../admin/model.js';
import {
  CONTACT_FIELDS, CONTACT_TITLES, CONTACTS_WARNING, DEMOGRAPHICS_NOTE, GROUPS, GROUP_TITLES, PREFER_NOT, PREFER_NOT_LABEL,
  QuestionnaireProblem, REQUIRED_TEXT, checkAnswers, checkContactValues, effectiveQuestions, versionOf,
} from '../views/questionnaire_model.js';
import { DEFAULT_SETTINGS } from './demo_catalogue.js';

/** The answers the sandbox's own accounts start with (questionnaire.py EXAMPLE_ANSWERS). */
export const EXAMPLE_ANSWERS = Object.freeze({
  datasets_analysed: '3–10', eeg_years: '3–5', annotation_hours: '10–50', artifact_training: 'A course or workshop',
  eeg_systems: ['Brain Products'], eeg_setting: 'Research', confidence: '3', career_stage: 'PhD', discipline: 'Neuroscience',
  country: 'United Kingdom', age_band: PREFER_NOT, gender: PREFER_NOT, first_language: PREFER_NOT,
});
export const EXAMPLE_AT = '2026-10-28T09:00:00.000+00:00';
const CONTACT_COLUMNS = ['annotator_id', 'full_name', 'email', 'phone', 'institution', 'updated_at', 'account'];

/** A cell as Python's csv module writes it, with an apostrophe before a leading =, +, - or @ (questionnaire.py _safe_cell). */
const csvCell = (v) => {
  let t = String(v ?? '');
  if (/^[=+\-@]/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export class DemoQuestionnaire {
  /** @param backend the DemoBackend whose state and accounts this works on */
  constructor(backend) {
    this.b = backend;
    const admin = backend._admin;
    admin.op_questionnaire_get = (body) => this.adminGet(body);
    admin.op_questionnaire_summary = () => this.summary();
    admin.op_contacts_download = () => this.contactsList();
    const users = admin.op_users_list.bind(admin);
    admin.op_users_list = (body) => { const out = users(body); this.addToUsers(out.users); return out; };
  }

  get block() { return (this.b._admin.s.settings || {}).questionnaire || DEFAULT_SETTINGS.questionnaire; }

  questions() { return effectiveQuestions(this.block, DEFAULT_SETTINGS.questionnaire.questions); }

  get _answers() { return this.b.state.questionnaires || (this.b.state.questionnaires = {}); }

  get _contacts() { return this.b.state.contacts || (this.b.state.contacts = {}); }

  /** Annotators and experts are asked; an administrator who does not annotate is not. */
  asked(u) {
    const roles = u ? rolesOf(u) : [];
    return this.block.enabled !== false && roles.some((r) => ['annotator', 'expert', 'participant'].includes(r));
  }

  /** A person's answers, with the sandbox's own accounts given the example ones (to the default questions, as when
   *  the sandbox began), kept from their first use. */
  record(aid) {
    const kept = this._answers[aid];
    if (kept) return kept;
    const u = this.b._admin.user(aid);
    if (!u || !u.builtin || !this.asked(u)) return null;
    const questions = effectiveQuestions(DEFAULT_SETTINGS.questionnaire, DEFAULT_SETTINGS.questionnaire.questions);
    const version = versionOf(questions);
    const answers = Object.fromEntries(questions.filter((q) => q.id in EXAMPLE_ANSWERS).map((q) => [q.id, EXAMPLE_ANSWERS[q.id]]));
    this._answers[aid] = { annotator_id: aid, history: [{ at: EXAMPLE_AT, version, answers, other: {} }], definitions: { [version]: questions } };
    return this._answers[aid];
  }

  contacts(aid) {
    const kept = this._contacts[aid];
    if (kept) return kept;
    const u = this.b._admin.user(aid);
    if (!u || !u.builtin || !this.asked(u)) return null;
    return { annotator_id: aid, full_name: u.display_name || aid, email: `${aid.toLowerCase()}@example.org`, phone: '',
      institution: 'ElectroTag demonstration', updated_at: EXAMPLE_AT };
  }

  _latest(aid) {
    const rec = this.record(aid);
    const h = (rec && rec.history) || [];
    return h.length ? h[h.length - 1] : null;
  }

  /** 403 questionnaire_required while the person signed in is asked and has not answered. */
  require() {
    const aid = this.b._aid();
    const u = this.b._admin.user(aid);
    if (this.asked(u) && !this._latest(aid)) throw new ApiError(403, 'questionnaire_required', REQUIRED_TEXT);
  }

  /** `questionnaire` of GET /me. */
  status(aid) {
    const u = this.b._admin.user(aid);
    const latest = this._latest(aid);
    const questions = this.questions();
    const given = (latest && latest.answers) || {};
    return { enabled: this.block.enabled !== false, asked: this.asked(u), answered: Boolean(latest), answered_at: latest ? latest.at : null,
      version: latest ? latest.version : null, current_version: versionOf(questions),
      missing: latest ? questions.filter((q) => q.required !== false && !(q.id in given)).length : 0 };
  }

  /** GET /me/questionnaire. */
  view() {
    const aid = this.b._aid();
    const u = this.b._admin.user(aid);
    const questions = this.questions();
    const latest = this._latest(aid);
    const rec = this.record(aid);
    const c = this.contacts(aid);
    const levels = { ...DEFAULT_SETTINGS.questionnaire.contacts, ...(this.block.contacts || {}) };
    const values = Object.fromEntries(CONTACT_FIELDS.map((k) => [k, String((c && c[k]) || '')]));
    if (!c) values.email = String((u && u.email) || '');
    const shown = CONTACT_FIELDS.filter((k) => (levels[k] || 'optional') !== 'off');
    return {
      enabled: this.block.enabled !== false, asked: this.asked(u),
      groups: GROUPS.filter((g) => questions.some((q) => q.group === g)).map((g) => ({ key: g, title: GROUP_TITLES[g] })),
      questions, version: versionOf(questions), prefer_not: { value: PREFER_NOT, label: PREFER_NOT_LABEL },
      answers: { ...((latest && latest.answers) || {}) }, other: { ...((latest && latest.other) || {}) },
      answered_at: latest ? latest.at : null, answered_version: latest ? latest.version : null,
      n_versions: ((rec && rec.history) || []).length,
      contacts: { fields: shown.map((k) => ({ key: k, title: CONTACT_TITLES[k], level: levels[k] || 'optional' })),
        values: Object.fromEntries(shown.map((k) => [k, values[k]])) },
    };
  }

  /** POST /me/questionnaire: the same answers sent again change nothing. */
  save(body) {
    const aid = this.b._aid();
    if (this.block.enabled === false) throw new ApiError(409, 'questionnaire_off', 'This study does not ask the sign-up questionnaire.');
    const questions = this.questions();
    const version = versionOf(questions);
    const levels = { ...DEFAULT_SETTINGS.questionnaire.contacts, ...(this.block.contacts || {}) };
    let answers; let other; let contacts;
    try {
      [answers, other] = checkAnswers(questions, body.answers, body.other);
      contacts = checkContactValues(levels, body.contacts);
    } catch (exc) {
      if (exc instanceof QuestionnaireProblem) throw new ApiError(422, exc.code, exc.message);
      throw exc;
    }
    const now = nowLocalIso();
    const rec = JSON.parse(JSON.stringify(this.record(aid) || { annotator_id: aid, history: [], definitions: {} }));
    const last = rec.history[rec.history.length - 1];
    let changed = false;
    if (!(last && last.version === version && JSON.stringify(last.answers) === JSON.stringify(answers)
      && JSON.stringify(last.other || {}) === JSON.stringify(other))) {
      rec.history.push({ at: now, version, answers, other });
      if (!rec.definitions[version]) rec.definitions[version] = questions;
      changed = true;
    }
    this._answers[aid] = rec;
    const old = this.contacts(aid);
    const before = Object.fromEntries(CONTACT_FIELDS.map((k) => [k, String((old && old[k]) || '')]));
    const after = { ...before, ...contacts };
    if (!old || JSON.stringify(before) !== JSON.stringify(after)) {
      this._contacts[aid] = { annotator_id: aid, ...after, updated_at: now };
      this.b._admin._audit('contacts_changed', `${aid}'s contact details changed`, { annotator_id: aid });
      changed = true;
    } else if (!this._contacts[aid]) {
      this._contacts[aid] = old;
    }
    this.b._save();
    return { ...this.view(), changed, n_answered: Object.keys(answers).length };
  }

  // ------------------------------------------------------------ the study team
  adminGet(body) {
    const aid = String((body && body.annotator_id) || '').trim().toUpperCase();
    if (!aid) throw new ApiError(400, 'bad_request', 'annotator_id is missing');
    const u = this.b._admin.user(aid);
    const rec = this.record(aid) || {};
    const c = this.contacts(aid);
    const questions = this.questions();
    return { annotator_id: aid, asked: u ? this.asked(u) : false, answered: Boolean((rec.history || []).length), questions,
      version: versionOf(questions), history: [...(rec.history || [])].reverse(), definitions: rec.definitions || {},
      contacts: c ? { ...Object.fromEntries(CONTACT_FIELDS.map((k) => [k, String(c[k] || '')])), updated_at: c.updated_at } : null,
      prefer_not: { value: PREFER_NOT, label: PREFER_NOT_LABEL } };
  }

  summary() {
    const questions = this.questions();
    const counts = Object.fromEntries(questions.map((q) => [q.id, {}]));
    const rows = [];
    const waiting = [];
    const accounts = [...this.b._admin.s.users].sort((a, b) => (a.annotator_id < b.annotator_id ? -1 : 1));
    const known = new Set(accounts.map((u) => u.annotator_id));
    const row = (aid, rec, extra = {}) => {
      const latest = rec.history[rec.history.length - 1];
      rows.push({ annotator_id: aid, answered_at: latest.at, version: latest.version, n_changes: rec.history.length - 1,
        answers: latest.answers || {}, other: latest.other || {}, ...extra });
    };
    for (const u of accounts) {
      const rec = this.record(u.annotator_id);
      if (!rec || !rec.history.length) {
        if (this.asked(u) && u.status === 'active') waiting.push(u.annotator_id);
        continue;
      }
      row(u.annotator_id, rec);
    }
    for (const aid of Object.keys(this._answers).sort()) if (!known.has(aid) && this._answers[aid].history.length) row(aid, this._answers[aid], { removed: true });
    for (const r of rows) {
      for (const [qid, value] of Object.entries(r.answers)) {
        if (!(qid in counts)) continue;
        const q = questions.find((x) => x.id === qid);
        for (const v of Array.isArray(value) ? value : [value]) {
          const key = v === PREFER_NOT ? PREFER_NOT_LABEL : q.type === 'text' ? 'answered' : String(v);
          counts[qid][key] = (counts[qid][key] || 0) + 1;
        }
      }
    }
    return { questions, version: versionOf(questions), rows, counts, not_answered: waiting, enabled: this.block.enabled !== false,
      demographics: this.block.demographics !== false, demographics_note: DEMOGRAPHICS_NOTE, prefer_not: { value: PREFER_NOT, label: PREFER_NOT_LABEL } };
  }

  contactRows() {
    const accounts = new Map(this.b._admin.s.users.map((u) => [u.annotator_id, u]));
    const ids = [...new Set([...Object.keys(this._contacts), ...[...accounts.keys()].filter((aid) => this.contacts(aid))])].sort();
    return ids.map((aid) => {
      const c = this.contacts(aid);
      const u = accounts.get(aid);
      return { ...Object.fromEntries(CONTACT_FIELDS.map((k) => [k, String(c[k] || '')])), annotator_id: aid, updated_at: String(c.updated_at || ''),
        account: u ? String(u.status || 'active') : 'removed' };
    });
  }

  contactsList() {
    const rows = this.contactRows();
    this.b._admin._audit('contacts_download', `Downloaded the contact details of ${plural(rows.length, 'person', 'people')}`, { n_people: rows.length });
    const csv = [CONTACT_COLUMNS.join(','), ...rows.map((r) => CONTACT_COLUMNS.map((c) => csvCell(r[c] ?? '')).join(','))].join('\n') + '\n';
    return { columns: CONTACT_COLUMNS, rows, csv, warning: CONTACTS_WARNING, file_name: 'demo_contacts.csv' };
  }

  addToUsers(users) {
    for (const u of users) {
      const c = this.contacts(u.annotator_id);
      u.full_name = (c && c.full_name) || '';
      u.questionnaire_answered = Boolean(this._latest(u.annotator_id));
    }
  }
}
