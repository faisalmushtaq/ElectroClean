// The admin area's invitations, progress and actions on many (js/admin/model.js, js/admin/chart.js,
// js/api/demo_admin.js): the grouped menu, private links and their message, the lines of "Add
// several", sorting and CSV, the chart's ticks, and the demonstration's invitations and `stats`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as m from '../../electroclean/web/static/js/admin/model.js';
import { niceTicks } from '../../electroclean/web/static/js/admin/chart.js';
import { DemoBackend } from '../../electroclean/web/static/js/api/demo.js';
import { inviteToken } from '../../electroclean/web/static/js/api/demo_admin.js';
import { sha256Hex } from '../../electroclean/web/static/js/data/sha256.js';

const memory = () => {
  const s = new Map();
  return { get: (k, f = null) => (s.has(k) ? JSON.parse(s.get(k)) : f), set: (k, v) => s.set(k, JSON.stringify(v)), remove: (k) => s.delete(k) };
};

async function demo(id = 'ADMIN', storage = memory()) {
  const b = new DemoBackend({ storage, tokens: memory() });
  await b.login(id, 'demo');
  return b;
}

test('the menu: four groups, every section in one, and what was folded read back safely', () => {
  assert.deepEqual(m.GROUPS.map((g) => g.title), ['Study', 'People', 'Data', 'Settings']);
  assert.deepEqual(m.sectionsOf('study').map((s) => s.title), ['Overview', 'Progress', 'Results', 'Analyses', 'Records']);
  assert.deepEqual(m.sectionsOf('people').map((s) => s.title), ['Annotators', 'Assignments', 'Training']);
  assert.deepEqual(m.sectionsOf('data').map((s) => s.title), ['Recordings']);
  assert.deepEqual(m.sectionsOf('config').map((s) => s.title), ['Study settings']);
  for (const s of m.SECTIONS) assert.ok(m.GROUPS.some((g) => g.key === s.group), s.key);
  assert.equal(m.groupOf('progress'), 'study');
  assert.equal(m.routeForSection('progress'), 'admin-progress');
  assert.deepEqual(m.foldedGroups({ study: true, people: false, nonsense: true }), { study: true });
  for (const bad of [null, 'study', ['study'], 3]) assert.deepEqual(m.foldedGroups(bad), {});
});

test('a private link is made from the page\'s own address', () => {
  const token = 'T'.repeat(43);
  assert.equal(m.inviteLink(token, { pageHref: 'https://study.example.org/app/#admin-annotators' }), `https://study.example.org/app/?invite=${token}`);
  // A page served by the study server itself needs no ?server=
  assert.equal(m.inviteLink(token, { pageHref: 'http://localhost:8000/?x=1#admin', server: 'http://localhost:8000' }), `http://localhost:8000/?invite=${token}`);
  // A page served from elsewhere names its study server.
  const other = new URL(m.inviteLink(token, { pageHref: 'https://pages.example.org/preview/index.html#admin', server: 'https://eeg.example.ac.uk' }));
  assert.equal(other.pathname, '/preview/index.html');
  assert.equal(other.searchParams.get('server'), 'https://eeg.example.ac.uk');
  assert.equal(other.searchParams.get('invite'), token);
  assert.equal(new URL(m.inviteLink(token, { pageHref: 'http://localhost/?demo=1', forcedDemo: true })).searchParams.get('demo'), '1');
});

test('the invitation\'s states and its friendly message', () => {
  assert.equal(m.invitationText(null), 'Not invited');
  assert.match(m.invitationText({ state: 'invited', invited_at: '2026-10-28T10:00:00+00:00', expires_at: '2026-11-11T10:00:00+00:00' }),
    /^Invited on 28 Oct 2026, expires on 11 Nov 2026$/);
  assert.match(m.invitationText({ state: 'accepted', ended_at: '2026-10-29T10:00:00+00:00' }), /^Accepted on 29 Oct 2026$/);
  assert.match(m.invitationText({ state: 'expired', expires_at: '2026-11-11T10:00:00+00:00' }), /^Expired on 11 Nov 2026$/);
  assert.match(m.invitationText({ state: 'revoked' }), /^Withdrawn/);
  const text = m.inviteMessage({ annotatorId: 'A11', name: 'Alex', study: 'Pilot', link: 'https://x.org/?invite=abc', expiresAt: '2026-11-11T10:00:00+00:00', from: 'Sam' });
  assert.match(text, /^Dear Alex,/);
  assert.match(text, /https:\/\/x\.org\/\?invite=abc/);
  assert.match(text, /Your annotator ID is A11\. The link works once and until 11 Nov 2026/);
  assert.match(text, /Sam$/);
  const href = m.mailtoHref('alex@example.org', 'Your invitation', text);
  assert.match(href, /^mailto:alex@example\.org\?subject=Your%20invitation&body=Dear%20Alex/);
  assert.equal(decodeURIComponent(href.split('body=')[1]), text);
});

test('"Add several": every line is checked before anything is made', () => {
  const ok = m.parseBulkPeople('annotator_id, name, email\nA11, Alex Smith, alex@example.org\n\na12\tSam Jones\tsam@example.org\nA13;Kim', { existing: ['A01'] });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.rows.map((r) => [r.line, r.annotator_id, r.display_name, r.email]),
    [[2, 'A11', 'Alex Smith', 'alex@example.org'], [4, 'A12', 'Sam Jones', 'sam@example.org'], [5, 'A13', 'Kim', null]]);
  const bad = m.parseBulkPeople('A01, Taken\nA11, One, one@example.org\nA11, Again\nA12, Two, one@example.org\nA 13, Space\nA14, Four, not-an-address\nA15,a,b@c.org,extra', { existing: ['a01'] });
  assert.deepEqual(bad.problems.map((p) => p.line), [1, 3, 4, 5, 6, 7]);
  assert.match(bad.problems[0].text, /A01 already has an account/);
  assert.match(bad.problems[1].text, /A11 is also on line 2/);
  assert.match(bad.problems[2].text, /one@example\.org is also on line 2/);
  assert.match(m.parseBulkPeople('A11, Alex', { emailRequired: true }).problems[0].text, /^Line 1 \(A11\)/);
  assert.equal(m.parseBulkPeople('   \n').problems.length, 1);
  assert.match(m.parseBulkPeople(Array.from({ length: 3 }, (_, i) => `B${i}`).join('\n'), { max: 2 }).problems[0].text, /At most 2/);
});

test('CSV, sorting and the words of the progress figures', () => {
  assert.equal(m.csvText(['a', 'b'], [{ a: 'x,y', b: 1.5 }, { a: '=SUM(A1)', b: null }, { a: 'say "hi"', b: 2 }]),
    'a,b\r\n"x,y",1.5000\r\n\'=SUM(A1),\r\n"say ""hi""",2\r\n');
  const rows = [{ id: 'A10', n: 3 }, { id: 'A2', n: null }, { id: 'A1', n: 7 }];
  assert.deepEqual(m.sortRows(rows, (r) => r.id).map((r) => r.id), ['A1', 'A2', 'A10']);
  assert.deepEqual(m.sortRows(rows, (r) => r.n, 'desc').map((r) => r.id), ['A1', 'A10', 'A2'], 'missing values last either way');
  assert.deepEqual(m.sortRows(rows, (r) => r.n, 'asc').map((r) => r.id), ['A10', 'A1', 'A2']);
  assert.equal(m.median([3, 1, 2]), 2);
  assert.equal(m.median([4, 1, 2, 3]), 2.5);
  assert.equal(m.median([]), null);
  assert.equal(m.minutesText(null), '–');
  assert.equal(m.minutesText(42), '42 s');
  assert.equal(m.minutesText(12 * 60 + 10), '12 min');
  assert.equal(m.minutesText(65 * 60), '1 h 05 min');
  assert.equal(m.projectionText({ status: 'not_enough' }), 'Not enough work yet');
  assert.equal(m.projectionText({ status: 'complete' }), 'Every assigned recording is done');
  assert.equal(m.projectionText({ status: 'projected', date: '2026-12-01' }), 'Around 1 Dec 2026');
  assert.equal(m.numberText(2.25, 1), '2.3');
  assert.equal(m.numberText(1200), '1,200');
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(7), [0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(23), [0, 10, 20, 30]);
});

test('Find: people and recordings, the closest first', () => {
  const data = { users: [{ annotator_id: 'A01', display_name: 'Alex', email: 'alex@example.org' }, { annotator_id: 'A10', display_name: 'Sam' }],
    recordings: [{ recording_id: 'sub-01/eeg/sub-01_task-rest_eeg.edf', file_name: 'sub-01_task-rest_eeg.edf', scope: 'study' }] };
  assert.deepEqual(m.findMatches('', data), []);
  assert.deepEqual(m.findMatches('a01', data).map((x) => [x.kind, x.id]), [['person', 'A01']]);
  assert.deepEqual(m.findMatches('sam', data).map((x) => x.id), ['A10']);
  const rec = m.findMatches('task-rest', data);
  assert.equal(rec[0].kind, 'recording');
  assert.equal(rec[0].scope, 'study');
});

test('demonstration: an invitation is a private link used once, kept only as a fingerprint', async () => {
  const storage = memory();
  const b = await demo('ADMIN', storage);
  const r = await b.admin('user_add', { annotator_id: 'a11', display_name: 'Alex', invite: true, expires_days: 7 });
  assert.equal(r.temporary_password, null);
  assert.match(r.invite_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(r.user.invitation.state, 'invited');
  const days = (Date.parse(r.expires_at) - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days <= 7, String(days));
  // Only the token's SHA-256 is kept, and the audit log never has the token.
  const kept = JSON.stringify(storage.get('electroclean.demo.v1') || b.state);
  assert.ok(!kept.includes(r.invite_token));
  assert.ok(kept.includes(sha256Hex(new TextEncoder().encode(r.invite_token))));
  const audit = await b.admin('audit', { limit: 10 });
  assert.match(audit.entries[0].summary, /Added A11 \(Alex\) with an invitation link/);
  assert.ok(!JSON.stringify(audit).includes(r.invite_token));

  // The person's own browser: check, choose a password, signed in.
  const p = new DemoBackend({ storage, tokens: memory() });
  assert.deepEqual(await p.inviteCheck(r.invite_token), { annotator_id: 'A11', display_name: 'Alex', study_name: 'Demonstration', expires_at: r.expires_at });
  await assert.rejects(() => p.inviteAccept(r.invite_token, 'short'), (e) => e.code === 'bad_password');
  const s = await p.inviteAccept(r.invite_token, 'a long new password');
  assert.equal(s.annotator_id, 'A11');
  assert.equal(p.signedIn, true);
  await assert.rejects(() => p.inviteCheck(r.invite_token), (e) => e.code === 'invite_used' && /used already/.test(e.message));
  await assert.rejects(() => p.inviteAccept(r.invite_token, 'another password'), (e) => e.code === 'invite_used');
  await p.logout();
  await p.login('A11', 'a long new password');
  await assert.rejects(() => p.inviteCheck(inviteToken()), (e) => e.code === 'invite_unknown' && e.status === 404);
});

test('demonstration: a new link, withdrawing it and switching the account off end the old one', async () => {
  const b = await demo();
  await b.admin('user_add', { annotator_id: 'A12' });
  assert.equal((await b.admin('users_list')).users.find((u) => u.annotator_id === 'A12').invitation.state, 'none');
  const first = await b.admin('user_invite', { annotator_id: 'A12' });
  const second = await b.admin('user_invite', { annotator_id: 'A12', expires_days: 30 });
  await assert.rejects(() => b.inviteCheck(first.invite_token), (e) => e.code === 'invite_unknown');
  assert.equal((await b.inviteCheck(second.invite_token)).annotator_id, 'A12');
  assert.equal((await b.admin('user_invite_revoke', { annotator_id: 'A12' })).invitation.state, 'revoked');
  await assert.rejects(() => b.inviteCheck(second.invite_token), (e) => e.code === 'invite_unknown');
  await assert.rejects(() => b.admin('user_invite_revoke', { annotator_id: 'A12' }), (e) => e.code === 'no_invitation');
  const third = await b.admin('user_invite', { annotator_id: 'A12' });
  await b.admin('user_update', { annotator_id: 'A12', status: 'disabled' });
  await assert.rejects(() => b.inviteCheck(third.invite_token), (e) => e.code === 'invite_unknown');
  await assert.rejects(() => b.admin('user_invite', { annotator_id: 'A12' }), (e) => e.code === 'disabled');
  await assert.rejects(() => b.admin('user_invite', { annotator_id: 'A12', expires_days: 365 }), (e) => e.status === 400);
  await assert.rejects(() => b.admin('user_add', { annotator_id: 'A13', invite: true, password: 'a password here' }), (e) => e.status === 400);
  // An expired link says so.
  await b.admin('user_update', { annotator_id: 'A12', status: 'active' });
  const fourth = await b.admin('user_invite', { annotator_id: 'A12' });
  b._admin.s.invites.A12.expires_ms = Date.now() - 1000;
  await assert.rejects(() => b.inviteCheck(fourth.invite_token), (e) => e.code === 'invite_expired' && /expired/.test(e.message));
  assert.equal((await b.admin('users_list')).users.find((u) => u.annotator_id === 'A12').invitation.state, 'expired');
});

test('demonstration: administrators are never invited, and a new password or role ends a link', async () => {
  const b = await demo();
  await assert.rejects(() => b.admin('user_add', { annotator_id: 'B01', role: 'admin', invite: true }), (e) => e.code === 'admin_account' && e.status === 409);
  assert.ok(!(await b.admin('users_list')).users.some((u) => u.annotator_id === 'B01'));
  await assert.rejects(() => b.admin('user_invite', { annotator_id: 'ADMIN' }), (e) => e.code === 'admin_account');
  await b.admin('user_add', { annotator_id: 'A14' });
  const first = await b.admin('user_invite', { annotator_id: 'A14' });
  await b.admin('user_update', { annotator_id: 'A14', role: 'admin' });
  await assert.rejects(() => b.inviteAccept(first.invite_token, 'a long new password'), (e) => e.code === 'invite_unknown');
  await b.admin('user_update', { annotator_id: 'A14', role: 'annotator' });
  const second = await b.admin('user_invite', { annotator_id: 'A14' });
  b._admin.user('A14').role = 'admin'; // changed behind the admin area's back
  await assert.rejects(() => b.inviteCheck(second.invite_token), (e) => e.code === 'invite_unknown');
  b._admin.user('A14').role = 'annotator';
  const third = await b.admin('user_invite', { annotator_id: 'A14' });
  await b.admin('user_reset_password', { annotator_id: 'A14' });
  await assert.rejects(() => b.inviteCheck(third.invite_token), (e) => e.code === 'invite_unknown');
  assert.equal((await b.admin('users_list')).users.find((u) => u.annotator_id === 'A14').invitation.state, 'revoked');
});

test('demonstration: stats counts the work done, its time and annotations, by person, recording and day', async () => {
  const b = await demo('ADMIN');
  const empty = await b.admin('stats');
  assert.equal(empty.days.length, 30);
  assert.equal(empty.days[29], empty.today);
  assert.equal(empty.totals.assigned, 3, "A01's three recordings (the trainee's programme is training)");
  assert.equal(empty.totals.done, 0);
  assert.deepEqual(empty.totals.projection, { status: 'not_enough', date: null });
  const items = (await b.admin('assignments_list', { annotator_id: 'A01' })).items;
  // Two recordings saved by A01 with their times and annotations, one left as a draft.
  const today = empty.today;
  b.state.submissions.push(
    { key: b._key('A01', items[0].recording_id, 'standard', ''), annotator_id: 'A01', recording_id: items[0].recording_id, mode: 'standard', context_id: '',
      attempt: 1, saved_at: `${today}T10:00:00.000+00:00`, annotations: [1, 2, 3], session: { elapsed_s: 600 } },
    { key: b._key('A01', items[1].recording_id, 'standard', ''), annotator_id: 'A01', recording_id: items[1].recording_id, mode: 'standard', context_id: '',
      attempt: 1, saved_at: `${today}T11:00:00.000+00:00`, annotations: [1], session: { elapsed_s: 1200 } });
  b.state.done[b._key('A01', items[0].recording_id, 'standard', '')] = { saved_at: today, attempt: 1 };
  b.state.done[b._key('A01', items[1].recording_id, 'standard', '')] = { saved_at: today, attempt: 1 };
  b.state.drafts[b._key('A01', items[2].recording_id, 'standard', '')] = { annotations: [], elapsed_s: 300, saved_at: `${today}T12:00:00.000+00:00` };
  const s = await b.admin('stats');
  assert.equal(s.totals.done, 2);
  assert.equal(s.totals.in_progress, 1);
  assert.equal(s.totals.todo, 0);
  assert.ok(Math.abs(s.totals.share_done - 2 / 3) < 1e-9);
  assert.ok(Math.abs(s.totals.annotator_hours - 2100 / 3600) < 1e-9, 'saved work and the draft');
  assert.equal(s.totals.median_minutes, 15);
  assert.equal(s.totals.done_7d, 2);
  assert.equal(s.daily[29], 2);
  const a01 = s.annotators.find((p) => p.annotator_id === 'A01');
  assert.deepEqual([a01.assigned, a01.done, a01.in_progress, a01.todo, a01.time_s, a01.in_progress_s, a01.median_s, a01.median_annotations, a01.done_7d],
    [3, 2, 1, 0, 1800, 300, 900, 2, 2]);
  assert.equal(a01.last_active, `${today}T12:00:00.000+00:00`);
  const rec = s.recordings.find((r) => r.recording_id === items[0].recording_id);
  assert.deepEqual([rec.assigned, rec.done, rec.median_s, rec.min_annotations, rec.max_annotations], [1, 1, 600, 3, 3]);
  // The trainee's programme counts only when training is asked for too.
  assert.ok((await b.admin('stats', { work: 'all' })).totals.assigned > s.totals.assigned);
  await assert.rejects(() => b.admin('stats', { work: 'some' }), (e) => e.status === 400);
  // A person's work, recording by recording.
  const work = (await b.admin('assignments_list', { annotator_id: 'A01' })).items;
  assert.deepEqual(work.map((i) => [i.elapsed_s, i.n_annotations]), [[600, 3], [1200, 1], [300, null]]);
});
