// The sign-up questionnaire in the browser: its rules (js/views/questionnaire_model.js, the same as
// electrotag/config/questionnaire.py and electrotag/web/questionnaire.py, which the contract parity test
// compares call by call), the sandbox's stand-in (js/api/demo_questionnaire.js) with its gate on work,
// and the admin area's table of answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DemoBackend } from '../../electrotag/web/static/js/api/demo.js';
import { DEFAULT_SETTINGS } from '../../electrotag/web/static/js/api/demo_catalogue.js';
import { EXAMPLE_ANSWERS } from '../../electrotag/web/static/js/api/demo_questionnaire.js';
import {
  PREFER_NOT, answerText, answeredCount, checkAnswers, checkContactValues, checkQuestions, effectiveQuestions, questionnaireProblems, versionOf,
} from '../../electrotag/web/static/js/views/questionnaire_model.js';

const memory = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)), remove: (k) => m.delete(k) };
};
const DEFAULTS = DEFAULT_SETTINGS.questionnaire;
const QUESTIONS = effectiveQuestions(DEFAULTS, DEFAULTS.questions);

test('the default questionnaire: the three groups, the project lead\'s bands, and Prefer not to say never listed', () => {
  assert.deepEqual([...new Set(QUESTIONS.map((q) => q.group))], ['experience', 'career', 'demographics']);
  assert.deepEqual(QUESTIONS[0].options, ['0', '1–2', '3–10', '11–30', '31–100', 'Over 100']);
  for (const q of QUESTIONS) assert.ok(!(q.options || []).some((o) => /prefer not/i.test(o)), q.id);
  const without = effectiveQuestions({ ...DEFAULTS, demographics: false }, DEFAULTS.questions);
  assert.equal(without.length, QUESTIONS.length - 3);
  assert.notEqual(versionOf(without), versionOf(QUESTIONS));
  assert.match(versionOf(QUESTIONS), /^q-[0-9a-f]{10}$/);
  assert.equal(versionOf(JSON.parse(JSON.stringify(QUESTIONS))), versionOf(QUESTIONS), 'the version depends on the wording, not on the object');
});

test('a study\'s own questions are checked in the study\'s words', () => {
  const q = (extra) => [{ id: 'x', group: 'career', text: 'X?', type: 'choice', options: ['Yes', 'No'], ...extra }];
  assert.deepEqual(checkQuestions(q({ text: '  Spaces   squashed ' }))[0], { id: 'x', group: 'career', text: 'Spaces squashed', type: 'choice', required: true, options: ['Yes', 'No'] });
  assert.throws(() => checkQuestions(q({ options: ['Yes', 'yes'] })), /an option is given twice/);
  assert.throws(() => checkQuestions(q({ options: ['Yes', 'Prefer not to say'] })), /leave out "Prefer not to say"/);
  assert.throws(() => checkQuestions(q({ other_option: 'Maybe' })), /other_option must be one of its options/);
  assert.throws(() => checkQuestions(q({ id: 'Bad' })), /id must be a short name/);
  assert.throws(() => checkQuestions([...q({}), ...q({})]), /used twice/);
  assert.throws(() => checkQuestions(q({ type: 'text' })), /a text question has no options/);
  assert.equal(checkQuestions(null), null);
  assert.deepEqual(questionnaireProblems({ contacts: { phone: 'sometimes' } }), ['These settings cannot be used: questionnaire.contacts.phone must be required, optional or off']);
  assert.deepEqual(questionnaireProblems(DEFAULTS), []);
});

test('answers: Prefer not to say on every question, alone among several, and words only with the option that asks for them', () => {
  const every = Object.fromEntries(QUESTIONS.map((q) => [q.id, q.type === 'multi' ? [PREFER_NOT] : PREFER_NOT]));
  assert.deepEqual(checkAnswers(QUESTIONS, every, {})[0], every);
  assert.throws(() => checkAnswers(QUESTIONS, { ...every, eeg_years: null }, {}), (e) => e.code === 'questionnaire_incomplete' && /“How many years have you worked with EEG\?”/.test(e.message));
  assert.throws(() => checkAnswers(QUESTIONS, { ...every, eeg_systems: ['BioSemi', PREFER_NOT] }, {}), /cannot be chosen together/);
  assert.throws(() => checkAnswers(QUESTIONS, { ...every, shoe: '9' }, {}), (e) => e.code === 'unknown_question');
  const [answers, other] = checkAnswers(QUESTIONS, { ...every, eeg_systems: ['Other', 'BioSemi'], artifact_training: 'Other', country: '  Wales ' },
    { eeg_systems: 'Our own', artifact_training: 'Night classes', age_band: 'ignored' });
  assert.deepEqual(answers.eeg_systems, ['BioSemi', 'Other'], 'in the order of the options');
  assert.equal(answers.country, 'Wales');
  assert.deepEqual(other, { eeg_systems: 'Our own', artifact_training: 'Night classes' });
  assert.equal(answeredCount(answers), QUESTIONS.length);
  assert.equal(answerText(['BioSemi', 'Other'], 'Our own'), 'BioSemi, Other (Our own)');
  assert.equal(answerText(PREFER_NOT), 'Prefer not to say');
  assert.throws(() => checkContactValues({ full_name: 'required' }, { full_name: ' ' }), /Please give your full name\./);
  assert.throws(() => checkContactValues({ email: 'optional' }, { email: 'nope' }), /does not look like an email address/);
  assert.deepEqual(checkContactValues({ full_name: 'required', email: 'required', phone: 'off', institution: 'optional' }, { full_name: 'A', email: 'a@b.org', phone: '123' }),
    { full_name: 'A', email: 'a@b.org', institution: '' });
});

test('the sandbox: its own accounts have answered, a visitor\'s new account waits for the questionnaire, and every change is kept', async () => {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login('A01', 'demo');
  const me = await b.me();
  assert.equal(me.questionnaire.answered, true);
  assert.deepEqual((await b.questionnaire()).answers.datasets_analysed, EXAMPLE_ANSWERS.datasets_analysed);
  await b.login('ADMIN', 'demo');
  assert.equal((await b.me()).questionnaire.asked, false, 'an administrator who does not annotate is not asked');
  await b.admin('user_add', { annotator_id: 'Q01', password: 'long enough', email: 'q01@example.org' });
  await b.admin('assign', { annotator_ids: ['Q01'], all: true });
  await b.login('Q01', 'long enough');
  for (const call of [() => b.match({ sha256: '0'.repeat(64), size_bytes: 1 }), () => b.trainingStage({ stage: 'tour', action: 'skip' }), () => b.expert('replay_consent_get', {}),
    () => b.putDraft('x', 'standard', '', {}), () => b.submit({})]) {
    await assert.rejects(call, (e) => e.status === 403 && e.code === 'questionnaire_required');
  }
  assert.ok((await b.assignments()).items.length, 'the list is not work');
  const q = await b.questionnaire();
  assert.equal(q.contacts.values.email, 'q01@example.org');
  const contacts = { full_name: 'Cerys Jones', email: 'cerys@example.org', phone: '+44 29 0000 0000' };
  const first = await b.saveQuestionnaire({ answers: EXAMPLE_ANSWERS, contacts });
  assert.equal(first.changed, true);
  assert.equal((await b.saveQuestionnaire({ answers: EXAMPLE_ANSWERS, contacts })).changed, false, 'sent twice, kept once');
  await b.saveQuestionnaire({ answers: { ...EXAMPLE_ANSWERS, datasets_analysed: 'Over 100' }, contacts });
  assert.equal((await b.match({ sha256: '0'.repeat(64), size_bytes: 1 })).status, 'unknown');
  await assert.rejects(() => b.admin('questionnaire_get', { annotator_id: 'Q01' }), (e) => e.code === 'forbidden');
  await b.login('ADMIN', 'demo');
  const got = await b.admin('questionnaire_get', { annotator_id: 'q01' });
  assert.deepEqual(got.history.map((h) => h.answers.datasets_analysed), ['Over 100', '3–10']);
  assert.equal(got.contacts.full_name, 'Cerys Jones');
  const summary = await b.admin('questionnaire_summary');
  assert.ok(!JSON.stringify(summary).includes('Cerys'), 'the summary is by annotator ID');
  assert.equal(summary.counts.datasets_analysed['Over 100'], 1);
  const list = await b.admin('contacts_download');
  assert.match(list.csv, /^Q01,Cerys Jones,cerys@example\.org,'\+44 29 0000 0000,,/m);
  const users = (await b.admin('users_list')).users;
  assert.equal(users.find((u) => u.annotator_id === 'Q01').full_name, 'Cerys Jones');
  const audit = JSON.stringify(await b.admin('audit', {}));
  assert.match(audit, /Q01's contact details changed/);
  assert.match(audit, /Downloaded the contact details of 4 people/);
  assert.ok(!audit.includes('Cerys') && !audit.includes('cerys@'), 'no name or contact detail in the audit log');
});
