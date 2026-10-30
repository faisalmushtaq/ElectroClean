// The foundation of the expert work in the browser: the expert area's sections and routes, who may use
// it, the purposes a recording is opened for, the roles as the admin area and the sandbox read them,
// and the checks of the review and training settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { EXPERT_ROUTE, EXPERT_SECTIONS, canUseExpertArea, expertSectionForRoute, routeForExpertSection } = await import('../../electrotag/web/static/js/expert/sections.js');
const { PURPOSES, registerPurpose, openForPurpose } = await import('../../electrotag/web/static/js/views/purposes.js');
const m = { ...(await import('../../electrotag/web/static/js/admin/model.js')), ...(await import('../../electrotag/web/static/js/admin/settings_checks.js')) };
const both = (s) => [...m.settingsProblems(s), ...m.expertSettingsProblems(s)];
const { rolesFrom } = await import('../../electrotag/web/static/js/api/demo_admin.js');
const { expertOps } = await import('../../electrotag/web/static/js/api/demo_expert.js');

test('the expert area has its routes, and only experts and administrators use it', () => {
  assert.ok(EXPERT_ROUTE.test('expert') && EXPERT_ROUTE.test('expert-work') && !EXPERT_ROUTE.test('experts') && !EXPERT_ROUTE.test('admin'));
  // the overview first, then one line per part of the expert work (each part adds its own)
  assert.equal(EXPERT_SECTIONS[0].key, 'overview');
  assert.ok(EXPERT_SECTIONS.some((s) => s.key === 'work' && s.route === 'expert-work'), 'Saved work (corrections and replay)');
  assert.equal(expertSectionForRoute('expert'), 'overview');
  assert.equal(expertSectionForRoute('expert-nothing'), null);
  assert.equal(routeForExpertSection('overview'), 'expert');
  assert.equal(routeForExpertSection('nothing'), 'expert');
  const later = [...EXPERT_SECTIONS, { key: 'work', route: 'expert-work', title: 'Saved work', load: async () => class {} }];
  assert.equal(expertSectionForRoute('expert-work', later), 'work'); // a later part adds one line
  for (const s of EXPERT_SECTIONS) assert.ok(EXPERT_ROUTE.test(s.route), s.route);
  assert.equal(canUseExpertArea({ roles: ['expert', 'annotator'] }), true);
  assert.equal(canUseExpertArea({ roles: ['admin'] }), true);
  assert.equal(canUseExpertArea({ role: 'admin' }), true); // an older answer, with one role
  assert.equal(canUseExpertArea({ roles: ['annotator'] }), false);
  assert.equal(canUseExpertArea(null), false);
  // app.js keeps the same rule for its routes, without loading the area
  const app = readFileSync(new URL('../../electrotag/web/static/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /const EXPERT_ROUTE = \/\^expert\(-\[a-z\]\+\)\?\$\/;/);
});

test('a recording is opened for its purpose; an unknown purpose says so', async () => {
  for (const k of ['review', 'correct', 'replay', 'corrected', 'adjudicate', 'library']) assert.equal(typeof PURPOSES[k], 'function', k);
  const seen = [];
  registerPurpose('try', async (app, args) => { seen.push(args.target.recording_id); });
  assert.throws(() => registerPurpose('try', async () => {}), /registered twice/);
  const view = { purpose: { kind: 'try', target: { recording_id: 'r1' } } };
  await openForPurpose({}, {}, { hex: 'x' }, view);
  assert.deepEqual(seen, ['r1']);
  const said = [];
  const lost = { purpose: { kind: 'nothing', target: {} }, step: (...a) => said.push(a), showProblem: (text) => said.push(text), backButton: () => null };
  await openForPurpose({}, {}, { hex: 'x' }, lost);
  assert.match(said.at(-1), /cannot open the recording for this/);
  delete PURPOSES.try;
});

test('roles are read and named as the study names them', () => {
  assert.deepEqual(m.parseRoles(['annotator', 'expert']), ['expert', 'annotator']);
  assert.deepEqual(m.parseRoles('admin,annotator'), ['admin', 'annotator']);
  assert.deepEqual(m.parseRoles(['wizard']), ['annotator']);
  assert.equal(m.primaryRole(['annotator', 'expert']), 'expert');
  assert.equal(m.primaryRole([]), 'annotator');
  assert.deepEqual(m.rolesOf({ role: 'admin' }), ['admin']);
  assert.deepEqual(m.rolesOf({ role: 'expert', roles: ['expert', 'annotator'] }), ['expert', 'annotator']);
  // the words of the audit log's summaries, as electrotag/web/store.py roles_text gives them
  assert.equal(m.rolesText(['annotator', 'expert']), 'an annotator and expert');
  assert.equal(m.rolesText(['admin']), 'an administrator');
  assert.equal(m.rolesText(['admin', 'expert', 'annotator']), 'an annotator, expert and administrator');
  assert.equal(m.roleWords(['expert', 'annotator']), 'Expert, Annotator');
  assert.deepEqual(Object.keys(m.ROLES), ['annotator', 'expert', 'admin']);
});

test('the sandbox reads the roles of a request as admin.py does', () => {
  assert.deepEqual(rolesFrom({}, { required: true }), ['annotator']);
  assert.equal(rolesFrom({}, { required: false }), null);
  assert.deepEqual(rolesFrom({ role: 'admin' }, { required: true }), ['admin']);
  assert.deepEqual(rolesFrom({ roles: ['annotator', 'expert'] }, { required: true }), ['expert', 'annotator']);
  assert.deepEqual(rolesFrom({ role: 'expert', roles: ['annotator', 'expert'] }, { required: true }), ['expert', 'annotator']);
  assert.throws(() => rolesFrom({ roles: ['participant'] }, { required: true }), (e) => e.code === 'role_not_offered' && e.status === 400);
  assert.throws(() => rolesFrom({ roles: [] }, { required: true }), (e) => e.code === 'bad_request');
  assert.throws(() => rolesFrom({ roles: ['wizard'] }, { required: true }), (e) => e.code === 'bad_request');
  assert.throws(() => rolesFrom({ role: 'annotator', roles: ['admin'] }, { required: true }), /say different things/);
  const ops = Object.keys(expertOps());
  for (const op of ['replay_consent_get', 'replay_consent_set', 'work_list', 'saved_attempt_get', 'correction_save', 'corrections_list', 'correction_get',
    'my_correction_get', 'replay_index_get', 'replay_events_get', 'teaching_list', 'adjudication_list', 'adjudication_get', 'adjudication_start',
    'adjudication_decide', 'adjudication_finish', 'adjudication_reference', 'library_list', 'library_promote', 'tasks_list', 'snippet_add', 'snippet_remove', 'snippets_list']) assert.ok(ops.includes(op), op);
  assert.throws(() => expertOps([{ a_get: () => {} }, { a_get: () => {} }]), /given twice/);
});

test('the review and training settings are checked in plain words', () => {
  assert.deepEqual(both({ review: { k_default: 2, matching: { match_criterion: 'iou', iou_threshold: 0.2 } }, training: { skippable: ['tour'], gate: 'met' } }), []);
  const problems = both;
  assert.match(problems({ review: { k_default: 7 } })[0], /between 2 and 6/);
  assert.match(problems({ review: { reason_required: 'sometimes' } })[0], /reason/);
  assert.match(problems({ review: { matching: { iou_threshold: 1 } } })[0], /just below 1/);
  assert.match(problems({ review: { matching: { match_criterion: 'nearby' } } })[0], /matched/);
  assert.match(problems({ review: { gold_min_items: 0 } })[0], /known-answer/);
  assert.match(problems({ training: { skippable: ['assessment'] } })[0], /cannot be skipped/);
  assert.match(problems({ training: { skippable: ['dancing'] } })[0], /Only the tour/);
  assert.match(problems({ training: { gate: 'maybe' } })[0], /waits for/);
  assert.match(problems({ replay: { enabled: 'yes' } })[0], /replay\.enabled is on or off/);
});

test('the settings the demonstration starts with pass the checks', async () => {
  const { DEFAULT_SETTINGS } = await import('../../electrotag/web/static/js/api/demo_catalogue.js');
  assert.deepEqual(both(DEFAULT_SETTINGS), []);
  assert.deepEqual(DEFAULT_SETTINGS.training.skippable, Object.keys(m.SKIPPABLE_STAGES));
  assert.ok(DEFAULT_SETTINGS.training.gate in m.TRAINING_GATES && DEFAULT_SETTINGS.review.reason_required in m.REASON_RULES);
});
