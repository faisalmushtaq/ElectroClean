// The history, revisions and game elements in the browser: the demonstration's revisions (a new
// version, the earlier one kept, only the latest revisable), its achievements and leaderboard
// (pseudonyms only, hidden people left out), the home page's list helpers (tabs, search, sorting,
// pages), and the pseudonyms' words, which must be those of electroclean/web/games.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DemoBackend, demoPseudonym, leaderboardOf } from '../../electroclean/web/static/js/api/demo.js';
import { ADJECTIVES, ANIMALS } from '../../electroclean/web/static/js/games/words.js';
import { PAGE_SIZE, pageOf, savedOf, visibleItems } from '../../electroclean/web/static/js/views/home_list.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const memory = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)), remove: (k) => m.delete(k) };
};

async function demo(id = 'A01') {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login(id, 'demo');
  return b;
}

async function as(b, id, password = 'demo') {
  await b.logout();
  await b.login(id, password);
  return b;
}

const ann = (id, label, onset, dur, channels = []) => ({ annotation_id: id.padEnd(32, '0'), label, onset_sample: onset, duration_samples: dur, channels,
  created_at: '2026-10-28T10:00:00.000+00:00', modified_at: '2026-10-28T10:00:00.000+00:00' });

async function matchBody(b, rid) {
  const rec = b.exampleRecording(rid);
  const fp = await rec.fingerprint();
  return { file_name: rec.fileName, size_bytes: rec.sizeBytes, sha256: fp.hex, sfreq: rec.sfreq, n_samples: rec.nSamples, ch_names: rec.channels.map((c) => c.name) };
}

const submit = (b, rid, anns, extra = {}) => b.submit({ recording_id: rid, mode: 'standard', context_id: '', annotations: anns,
  session: { elapsed_s: 30, viewed_fraction: 1 }, sha256: '', ...extra });

test('the pseudonyms\' words are those of the server', () => {
  const py = fs.readFileSync(path.join(ROOT, 'electroclean', 'web', 'games.py'), 'utf8');
  const words = (name) => [...py.slice(py.indexOf(`${name} = (`), py.indexOf(')', py.indexOf(`${name} = (`))).matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...ADJECTIVES], words('ADJECTIVES'));
  assert.deepEqual([...ANIMALS], words('ANIMALS'));
  assert.equal(new Set(ADJECTIVES).size, ADJECTIVES.length);
  assert.equal(new Set(ANIMALS).size, ANIMALS.length);
});

test('a revision in the demonstration: a new version, the earlier one kept, only the latest revisable', async () => {
  const b = await demo();
  const [first] = (await b.assignments()).items;
  const rid = first.recording_id;
  assert.equal(first.saved, null);
  assert.equal((await b.me()).study.annotation.allow_revisions, true);
  const one = await submit(b, rid, [ann('a', 'EMG-artifact', 100, 50)]);
  assert.equal(one.attempt, 1);
  assert.equal(one.revision, null);
  let item = (await b.assignments()).items.find((i) => i.recording_id === rid);
  assert.equal(item.status, 'done');
  assert.deepEqual([item.saved.version, item.n_annotations, item.elapsed_s, item.saved.total_elapsed_s, item.revising], [1, 1, 30, 30, false]);
  assert.equal(item.saved.first_saved_at, item.completed_at);

  const body = await matchBody(b, rid);
  const done = await b.match(body);
  assert.equal(done.status, 'done');
  assert.match(done.message, /Open to revise/);
  const m = await b.match({ ...body, revise: true });
  assert.equal(m.status, 'matched');
  assert.deepEqual([m.revision.version, m.revision.revises], [2, 1]);
  assert.deepEqual(m.revision.annotations.map((a) => a.label), ['EMG-artifact']);

  // A draft of the revision marks the recording as being revised, and is offered when it is opened again.
  await b.putDraft(rid, 'standard', '', { annotations: [], view: null, elapsed_s: 5 });
  item = (await b.assignments()).items.find((i) => i.recording_id === rid);
  assert.equal(item.status, 'done');
  assert.equal(item.revising, true);
  assert.equal((await b.match({ ...body, revise: true })).draft.revises, 1);

  await assert.rejects(() => submit(b, rid, []), (e) => e.status === 409 && e.code === 'already_done');
  await assert.rejects(() => submit(b, rid, [], { revises: 2 }), (e) => e.status === 409 && e.code === 'already_revised');
  const two = await submit(b, rid, [ann('a', 'EMG-artifact', 100, 50), ann('b', 'Eye-blink-artifact', 900, 40)], { revises: 1 });
  assert.equal(two.attempt, 2);
  assert.deepEqual(two.revision, { version: 2, revises: 1 });
  assert.ok(two.files.every((f) => f.includes('_attempt-02_')));
  // the same revision sent twice saves nothing more
  await assert.rejects(() => submit(b, rid, [], { revises: 1 }), (e) => e.code === 'already_revised');
  const subs = b.state.submissions.filter((s) => s.recording_id === rid);
  assert.deepEqual(subs.map((s) => [s.attempt, s.annotations.length]), [[1, 1], [2, 2]]);
  item = (await b.assignments()).items.find((i) => i.recording_id === rid);
  assert.deepEqual([item.saved.version, item.n_annotations, item.elapsed_s, item.saved.total_elapsed_s, item.revising], [2, 2, 30, 60, false]);
  const docs = b.resultsDocument().annotation_documents.filter((d) => d.recording.recording_id === rid);
  assert.deepEqual(docs.map((d) => d.session.context.revision ? d.session.context.revision.version : 1), [1, 2]);

  // Switched off by the study: done is final again.
  await as(b, 'ADMIN');
  await b.admin('settings_update', { settings: { annotation: { allow_revisions: false } } });
  await as(b, 'A01');
  assert.equal((await b.me()).study.annotation.allow_revisions, false);
  assert.equal((await b.match({ ...body, revise: true })).status, 'done');
  await assert.rejects(() => submit(b, rid, [], { revises: 2 }), (e) => e.code === 'revisions_off');
  await assert.rejects(() => b.putDraft(rid, 'standard', '', { annotations: [] }), (e) => e.code === 'already_done');
});

test('achievements in the demonstration: no team progress that would give away one other person\'s', async () => {
  const b = await demo('ADMIN');
  await as(b, 'A01');
  assert.equal((await b.achievements()).team.people, 1);
  assert.notEqual((await b.achievements()).team.assigned, null); // alone: their own figures
  await as(b, 'T01');
  assert.deepEqual((await b.achievements()).team, { done: null, assigned: null, people: 1 }); // A01's
  await as(b, 'ADMIN');
  await b.admin('user_add', { annotator_id: 'B01', password: 'password-1234' });
  const rids = (await as(b, 'A01').then(() => b.assignments())).items.map((i) => i.recording_id);
  await as(b, 'ADMIN');
  await b.admin('assign', { annotator_ids: ['B01'], recording_ids: rids });
  await as(b, 'A01');
  assert.deepEqual((await b.achievements()).team, { done: null, assigned: null, people: 2 });
});

test('achievements in the demonstration: counters, goal, team and a leaderboard of pseudonyms', async () => {
  const b = await demo('ADMIN');
  for (const id of ['B01', 'B02', 'B03']) {
    await b.admin('user_add', { annotator_id: id, display_name: `Person ${id}`, password: 'password-1234' });
  }
  const rids = (await as(b, 'A01').then(() => b.assignments())).items.map((i) => i.recording_id);
  await as(b, 'ADMIN');
  for (const id of ['B01', 'B02', 'B03']) await b.admin('assign', { annotator_ids: [id], recording_ids: rids });
  await as(b, 'A01');
  let a = await b.achievements();
  assert.equal(a.enabled, true);
  assert.deepEqual(a.counters, { done: 0, assigned: 3, worked_s: 0, annotations: 0 });
  assert.equal(a.viewed_in_full, null);
  assert.deepEqual(a.team, { done: 0, assigned: 12, people: 4 });
  assert.equal(a.leaderboard.rows.length, 0);

  await submit(b, rids[0], [ann('a', 'EMG-artifact', 100, 50)]);
  await submit(b, rids[1], []);
  for (const [id, n] of [['B01', 3], ['B02', 1], ['B03', 2]]) {
    await as(b, id, 'password-1234');
    for (const rid of rids.slice(0, n)) await submit(b, rid, []);
  }
  await as(b, 'A01');
  a = await b.achievements();
  assert.deepEqual(a.counters, { done: 2, assigned: 3, worked_s: 60, annotations: 1 });
  assert.equal(a.viewed_in_full, 2);
  assert.deepEqual(a.team, { done: 8, assigned: 12, people: 4 });
  const lb = a.leaderboard;
  assert.deepEqual(lb.rows.map((r) => r.count), [3, 2, 2, 1]);
  assert.deepEqual(lb.rows.map((r) => r.rank), [1, 2, 2, 4]);
  assert.equal(lb.rows.filter((r) => r.you).length, 1);
  assert.equal(lb.you.rank, 2);
  // No annotator ID reaches the browser: only pseudonyms.
  const text = JSON.stringify(a);
  for (const id of ['A01', 'B01', 'B02', 'B03']) assert.ok(!text.includes(id), `${id} is not in the answer`);
  for (const r of lb.rows) assert.match(r.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  // Pseudonyms are stable.
  assert.deepEqual((await b.achievements()).leaderboard.rows.map((r) => r.name), lb.rows.map((r) => r.name));

  // The goal, and hiding oneself.
  await assert.rejects(() => b.setAchievements({ goal_per_week: 0 }), (e) => e.status === 400);
  await assert.rejects(() => b.setAchievements({ leaderboard_hidden: 'yes' }), (e) => e.status === 400);
  a = await b.setAchievements({ goal_per_week: 10, leaderboard_hidden: true });
  assert.equal(a.goal.per_week, 10);
  assert.equal(a.leaderboard.you.hidden, true);
  assert.equal(a.leaderboard.rows.length, 3);
  assert.ok(!a.leaderboard.rows.some((r) => r.you || r.name === lb.you.name));
  // Fewer than three people on it: no rows.
  await as(b, 'B03', 'password-1234');
  await b.setAchievements({ leaderboard_hidden: true });
  assert.deepEqual((await b.achievements()).leaderboard.rows, []);

  // Switched off by the study.
  await as(b, 'ADMIN');
  await b.admin('settings_update', { settings: { gamification: { leaderboard: false } } });
  await as(b, 'A01');
  assert.equal((await b.achievements()).leaderboard, null);
  assert.equal((await b.me()).study.gamification.leaderboard, false);
  await as(b, 'ADMIN');
  await b.admin('settings_update', { settings: { gamification: { enabled: false } } });
  await as(b, 'A01');
  assert.deepEqual(await b.achievements(), { enabled: false, leaderboard_enabled: false });
  await as(b, 'ADMIN');
  await assert.rejects(() => b.admin('settings_update', { settings: { gamification: { enabled: 'no' } } }), (e) => e.code === 'invalid_settings');
});

test('the leaderboard ranks by count, shares ranks on ties, and keeps the person\'s own place', () => {
  const ids = Array.from({ length: 14 }, (_, i) => `P${String(i).padStart(2, '0')}`);
  const team = { ids, names: Object.fromEntries(ids.map((id) => [id, demoPseudonym('ab', id)])),
    completed: Object.fromEntries(ids.map((id, i) => [id, 20 - i])), full: Object.fromEntries(ids.map((id) => [id, 0])), hidden: new Set(['P03']) };
  const lb = leaderboardOf('P13', team);
  assert.equal(lb.rows.length, 10);
  assert.ok(!lb.rows.some((r) => r.name === team.names.P03));
  assert.equal(lb.you.rank, 13);
  assert.equal(lb.rows.some((r) => r.you), false);
  assert.deepEqual(leaderboardOf('P13', team, { byFull: true }).rows, []); // nobody viewed one in full
  assert.equal(demoPseudonym('ab', 'p01'), demoPseudonym('ab', 'P01'));
  assert.notEqual(demoPseudonym('ab', 'P01'), demoPseudonym('cd', 'P01'));
});

test('the list of recordings: tabs, search, sorting and pages', () => {
  const items = Array.from({ length: 300 }, (_, i) => ({
    recording_id: `sub-${String(i).padStart(3, '0')}/eeg/sub-${String(i).padStart(3, '0')}_eeg.edf`,
    file_name: `sub-${String(i).padStart(3, '0')}_eeg.edf`, mode: 'standard', duration_s: 600 - i,
    status: i < 120 ? 'done' : i < 125 ? 'in_progress' : 'todo',
    completed_at: i < 120 ? new Date(Date.UTC(2026, 9, 1) + i * 3600e3).toISOString() : null, n_annotations: i < 120 ? i : null, elapsed_s: i < 120 ? 60 : null,
    saved: i < 120 ? { version: i % 7 === 0 ? 2 : 1, first_saved_at: null, total_elapsed_s: 60 } : null,
    revising: i === 3,
  }));
  assert.equal(visibleItems(items, { tab: 'todo' }).length, 180); // started or not
  assert.equal(visibleItems(items, { tab: 'in_progress' }).length, 5);
  assert.equal(visibleItems(items, { tab: 'all' }).length, 300);
  const history = visibleItems(items, { tab: 'history' });
  assert.equal(history.length, 120);
  // newest first, with a revision under way at the top
  assert.equal(history[0].file_name, 'sub-003_eeg.edf');
  assert.equal(history[1].file_name, 'sub-119_eeg.edf');
  assert.deepEqual(visibleItems(items, { tab: 'all', query: 'SUB-04', sort: 'name' }).map((i) => i.file_name).slice(0, 2), ['sub-040_eeg.edf', 'sub-041_eeg.edf']);
  assert.equal(visibleItems(items, { tab: 'all', sort: 'length' })[0].file_name, 'sub-299_eeg.edf');
  assert.equal(visibleItems(items, { tab: 'all', sort: 'name' })[0].file_name, 'sub-000_eeg.edf');
  const p = pageOf(history, 4);
  assert.equal(PAGE_SIZE, 25);
  assert.deepEqual([p.page, p.pages, p.from, p.to, p.rows.length], [4, 5, 101, 120, 20]);
  assert.equal(pageOf(history, 99).page, 4);
  assert.equal(pageOf([], 3).from, 0);
  // what the history shows, read defensively
  assert.deepEqual(savedOf({ status: 'done', saved: null, elapsed_s: 12, n_annotations: 4, completed_at: 'x' }), { version: 1, saved_at: 'x', n_annotations: 4, elapsed_s: 12 });
  assert.equal(savedOf({ status: 'todo' }), null);
  assert.equal(savedOf(items[7]).version, 2);
});
