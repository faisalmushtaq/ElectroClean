// The words and the arithmetic of the admin area's Hand-outs section (handouts.js), kept apart from the
// page so that they can be tested without one: the request a hand-out sends, the title annotators see,
// what its preview says (in k mode through the Tasks section's own words, tasks_model.js), its progress
// and due date, and the notices that would be sent (docs/web/admin.md, "Hand-outs"; docs/web/api.md,
// "Datasets, collections, groups and hand-outs").

import { plural } from './model.js';
import { K_MAX, K_MIN, SKIPPED, poolEntry, previewSummary } from './tasks_model.js';
import { dayWords, dueText, personText } from './datasets_model.js';

/** The longest name, title and note of a hand-out. */
export const HANDOUT_LIMITS = Object.freeze({ name: 120, title: 120, note: 2000 });

/** Why a recording of a hand-out's target is left out ("retired" from datasets.py, the others from Tasks). */
export const HANDOUT_SKIPPED = Object.freeze({ ...SKIPPED, not_registered: 'The recording is no longer registered.' });

/**
 * What annotators see of a hand-out unless the study team gives a title (datasets.py default_title): a
 * source dataset's name; for a collection "Recordings due 20 November", or "Recordings to annotate"
 * without a due date, so that a collection's name never reaches them.
 */
export function defaultTitle(kind, name, dueAt) {
  if (kind === 'dataset') return String(name || '');
  return dueAt ? `Recordings due ${dayWords(dueAt)}` : 'Recordings to annotate';
}

/** A target's value in the form's list ("dataset:youth-ld-2026") and back. */
export const targetValue = (kind, id) => `${kind}:${id}`;
export function parseTarget(value) {
  const i = String(value || '').indexOf(':');
  if (i < 1) return null;
  const kind = value.slice(0, i);
  return ['dataset', 'collection'].includes(kind) ? { kind, id: value.slice(i + 1) } : null;
}

/**
 * The body of handouts_preview_get and handout_create from what the form holds:
 * {target, people, groups, mode, k, dueAt, title, name, note, followGroups}. Throws an Error in plain
 * words when something needed is missing. `today` ("2026-10-30") refuses a due date in the past.
 */
export function handoutBody(f, { today = '' } = {}) {
  const target = typeof f.target === 'string' ? parseTarget(f.target) : f.target;
  if (!target || !target.id) throw new Error('Choose the dataset or collection to hand out.');
  const people = [...new Set(f.people || [])];
  const groups = [...new Set(f.groups || [])];
  if (!people.length && !groups.length) throw new Error('Choose the people or groups to hand it out to.');
  const mode = f.mode === 'k' ? 'k' : 'all';
  const body = { target: { kind: target.kind, id: target.id }, people, groups, mode };
  if (mode === 'k') {
    const k = Number(f.k);
    if (!Number.isInteger(k) || k < K_MIN || k > K_MAX) throw new Error(`Each recording goes to ${K_MIN} to ${K_MAX} people.`);
    body.k = k;
  } else {
    body.follow_groups = Boolean(f.followGroups) && groups.length > 0;
  }
  const due = String(f.dueAt || '').trim();
  if (due) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(`${due}T00:00:00Z`))) throw new Error('Give the due date as a day, for example 2026-11-20.');
    if (today && due < today) throw new Error('The due date has passed. Choose a day from today on, or leave it empty.');
    body.due_at = due;
  } else body.due_at = null;
  for (const key of ['title', 'name', 'note']) {
    const v = String(f[key] || '').trim();
    if (v.length > HANDOUT_LIMITS[key]) throw new Error(`The ${key === 'note' ? 'note' : key} has at most ${HANDOUT_LIMITS[key].toLocaleString('en-GB')} characters.`);
    if (v) body[key] = v;
  }
  return body;
}

/** The people a hand-out goes to, from its preview: "A01 and A02, and 3 through the group Leeds RAs". */
export function recipientsText(recipients, groups = []) {
  const names = Object.fromEntries((groups || []).map((g) => [g.group_id, g.name || g.group_id]));
  const direct = (recipients || []).filter((r) => r.via === 'person').length;
  const byGroup = {};
  for (const r of recipients || []) if (String(r.via).startsWith('group:')) byGroup[r.via.slice(6)] = (byGroup[r.via.slice(6)] || 0) + 1;
  const parts = [];
  if (direct) parts.push(`${plural(direct, 'person', 'people')} chosen`);
  for (const [gid, n] of Object.entries(byGroup)) parts.push(`${n} through ${names[gid] || gid}`);
  return parts.join(', ');
}

/**
 * What a preview (handouts_preview_get) says, for the page. In "all" mode: one sentence of new and
 * already-held recordings, each person's row and the warnings. In k mode: the Tasks section's own
 * summary of `tasks_preview` (previewSummary), so that the words and the table are the same.
 */
export function handoutPreview(p, mode) {
  const recipients = p.recipients || [];
  const skipped = p.skipped || [];
  const warnings = [...(p.warnings || [])];
  if (mode === 'k') {
    const tp = p.tasks_preview;
    if (!tp) return { mode, sentence: p.recordings ? 'Nothing would be shared out.' : 'The target has no recordings in use to share out.', warnings, skipped, people: [], tasks: null, n: 0 };
    const s = previewSummary(tp);
    // the hand-out's warnings hold the Tasks preview's, and add its own
    return { mode, sentence: s.sentence, pairs: s.pairs, warnings, skipped, people: s.people, tasks: tp, n: s.n };
  }
  const added = recipients.reduce((x, r) => x + (r.new || 0), 0);
  const already = recipients.reduce((x, r) => x + (r.already || 0), 0);
  let sentence;
  if (!p.recordings) sentence = 'The target has no recordings in use to hand out.';
  else if (!recipients.length) sentence = 'Nobody would be given anything.';
  else {
    sentence = `${plural(p.recordings, 'recording')} to ${plural(recipients.length, 'person', 'people')}: ${plural(added, 'new assignment')}`;
    if (already) sentence += `; ${plural(already, 'recording')} that people hold already ${already === 1 ? 'stays' : 'stay'} as ${already === 1 ? 'it is' : 'they are'}, with this hand-out's due date`;
    sentence += '.';
  }
  if (skipped.length) sentence += ` ${plural(skipped.length, 'recording')} left out (below).`;
  return { mode, sentence, warnings, skipped, people: recipients, tasks: null, n: added };
}

/** The words of a recording left out of a hand-out. */
export const skippedReason = (x) => HANDOUT_SKIPPED[x.reason] || x.reason || '';

/** "12 of 40 saved" for a hand-out, with the share (0 to 1) of the work finished (saved or set aside). */
export function handoutProgress(o) {
  const c = o.counts || {};
  const given = c.given || 0;
  const finished = (c.saved || 0) + (c.set_aside || 0);
  return { text: given ? `${c.saved || 0} of ${given} saved${c.set_aside ? `, ${c.set_aside} set aside` : ''}` : 'Nothing given',
    share: given ? finished / given : null };
}

/** How a hand-out shares its recordings out: "Everyone gets all of it" or "Each recording to 2 people". */
export function modeText(o) {
  return o.mode === 'k' ? `Each recording to ${plural(o.k || 0, 'person', 'people')}` : 'Everyone gets all of it';
}

/** A hand-out's due date in words, and whether it has passed ("today" is the study's day, handouts_list's `today`). */
export function dueState(dueAt, today) {
  if (!dueAt) return { text: 'No due date', late: false };
  const late = Boolean(today) && today > dueAt;
  return { text: dueText(dueAt), late };
}

/** The hand-outs the list keeps: by state ('open', 'withdrawn' or ''), overdue only, and a search of names and titles. */
export function filterHandouts(list, { state = '', overdue = false, q = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return (list || []).filter((o) => (!state || o.state === state)
    && (!overdue || (o.counts || {}).overdue_people > 0)
    && (!needle || `${o.name} ${o.title} ${(o.target || {}).name || ''} ${(o.target || {}).id || ''}`.toLowerCase().includes(needle)));
}

/** "2 people overdue" for a hand-out, or ''. */
export function overdueText(o) {
  const n = (o.counts || {}).overdue_people || 0;
  return n ? `${plural(n, 'person', 'people')} overdue` : '';
}

/**
 * What adding people to a group would give them through the open hand-outs that follow it (mode "all"
 * with follow_groups): {handouts, recordings, text}; text is '' when nothing follows the group.
 */
export function followText(handouts, groupId, adding) {
  const follow = (handouts || []).filter((o) => o.state === 'open' && o.mode !== 'k' && o.follow_groups && (o.groups || []).includes(groupId));
  if (!follow.length || !adding.length) return { handouts: follow, recordings: 0, text: '' };
  const recordings = follow.reduce((x, o) => x + ((o.counts || {}).recordings || 0), 0);
  const who = adding.length === 1 ? adding[0] : plural(adding.length, 'person', 'people');
  return { handouts: follow, recordings,
    text: `Adding ${who} gives ${adding.length === 1 ? 'them' : 'each of them'} ${plural(follow.length, 'hand-out')} that ${follow.length === 1 ? 'follows' : 'follow'} this group (${plural(recordings, 'recording')}).` };
}

/** The kinds of notice that would be sent (notify_preview_get), as the panel names them. */
export const NOTICE_KINDS = Object.freeze({
  weekly: 'Weekly summary', complete: 'Fully rated', dataset_complete: 'Fully rated', handout_complete: 'Hand-out complete', overdue: 'Overdue work',
});

/** A notice's kind in words (a kind not known is shown as it is). */
export function noticeKind(n) {
  const k = String(n.kind || '');
  return NOTICE_KINDS[k] || NOTICE_KINDS[k.split('-')[0]] || k;
}

/**
 * One account in the lists of people to give to (Tasks' poolEntry): "A03 · Ann Smith" with the name the
 * study team has, and under it only what is not the name (roles, switched off, locked).
 */
export function personEntry(u, people = {}) {
  const e = poolEntry(u);
  const names = new Set([u.display_name, u.full_name].filter(Boolean));
  return { ...e, text: personText(u.annotator_id, people), extra: String(e.extra || '').split(' · ').filter((x) => x && !names.has(x)).join(' · ') };
}
