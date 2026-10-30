// Correct the marks, scored in the browser: a port of score_corrections and assign in
// electrotag/training/planted.py, for an expert trying an exercise (the study scores a trainee's
// saved corrections itself). web_tests/planted_parity.py checks that both give the same answers.

import { DEFAULT_TOLERANCE, accepts, channelJaccard, iou, overlaps, windowS } from './rules.js';

const endOf = (a) => a.onset_sample + a.duration_samples;
const isGlobal = (a) => !(a.channels || []).length;
const time = (a, b, sf) => `${(a / sf).toFixed(2)}–${(b / sf).toFixed(2)} s`;
const article = (w) => ('aeiou'.includes(String(w).charAt(0).toLowerCase()) ? 'an' : 'a');
const round4 = (x) => Math.round(x * 1e4) / 1e4;

/** What keeps `cand` from being the experts' `target`: type, start, end, scope or channels. */
export function problems(target, cand, sf, tol = DEFAULT_TOLERANCE) {
  const out = [];
  if (!accepts(tol, target.label, cand.label)) out.push('type');
  const w = windowS(tol, target.duration_samples / sf);
  if (Math.abs(cand.onset_sample - target.onset_sample) / sf > w + 1e-9) out.push('start');
  if (Math.abs(endOf(cand) - endOf(target)) / sf > w + 1e-9) out.push('end');
  if (isGlobal(target) !== isGlobal(cand)) out.push('scope');
  else if (!isGlobal(target) && channelJaccard(cand, target) < tol.channel_jaccard - 1e-12) out.push('channels');
  return out;
}

const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/** For each reference mark, in time order, the mark of `mine` that stands for it, and its problems. */
export function assign(refs, mine, sf, tol = DEFAULT_TOLERANCE) {
  const taken = new Set();
  const out = new Map();
  const order = [...refs].sort((a, b) => cmp(a.onset_sample, b.onset_sample) || cmp(endOf(a), endOf(b)) || cmp(a.annotation_id, b.annotation_id));
  for (const r of order) {
    const cands = mine.filter((m) => !taken.has(m.annotation_id) && overlaps(m, r));
    if (!cands.length) continue;
    cands.sort((a, b) => cmp(accepts(tol, r.label, a.label) ? 0 : 1, accepts(tol, r.label, b.label) ? 0 : 1)
      || cmp(-iou(a, r), -iou(b, r)) || cmp(a.onset_sample, b.onset_sample) || cmp(a.annotation_id, b.annotation_id));
    const best = cands[0];
    taken.add(best.annotation_id);
    out.set(r.annotation_id, { mark: best, problems: problems(r, best, sf, tol) });
  }
  return out;
}

/** "You fixed 3 of 4 planted mistakes." and the new ones (planted.score_message). */
export function scoreMessage(fixed, n, added) {
  let text = `You fixed ${fixed} of ${n} planted mistake${n !== 1 ? 's' : ''}.`;
  if (added) text += ` ${added} new mistake${added !== 1 ? 's' : ''}: look at the list below.`;
  return text;
}

/** How the corrected marks `mine` deal with the planted `errors` (planted.score_corrections). */
export function scoreCorrections(errors, mine, ref, sfreq, tol = DEFAULT_TOLERANCE, planted = []) {
  const sf = Number(sfreq);
  const refs = [...ref].sort((a, b) => cmp(a.onset_sample, b.onset_sample) || cmp(endOf(a), endOf(b)) || cmp(a.annotation_id, b.annotation_id));
  const byId = new Map(refs.map((r) => [r.annotation_id, r]));
  const matched = assign(refs, mine, sf, tol);
  const used = new Set([...matched.values()].map((m) => m.mark.annotation_id));
  const loose = mine.filter((m) => !used.has(m.annotation_id));
  const items = [];
  const concerned = new Set();
  const extras = [];
  let fixed = 0;
  for (const e of errors) {
    const rid = e.reference_id;
    let ok;
    let probs;
    if (e.kind === 'extra' || !rid) {
      const span = [Number(e.onset_sample), Number(e.end_sample)];
      extras.push(span);
      const still = loose.filter((m) => m.onset_sample < span[1] && span[0] < endOf(m));
      ok = !still.length;
      probs = still.length ? ['still_there'] : [];
    } else {
      concerned.add(String(rid));
      const got = matched.get(String(rid));
      probs = got ? [...got.problems] : ['missing'];
      ok = !probs.length;
      if (!byId.has(rid)) { ok = false; probs = ['unknown']; }
    }
    if (ok) fixed += 1;
    items.push({ kind: e.kind, fixed: ok, problems: probs, label: e.label ?? null, onset_s: round4(Number(e.onset_sample) / sf),
      offset_s: round4(Number(e.end_sample) / sf), detail: e.detail || '', reference_id: rid ?? null, planted_id: e.planted_id ?? null });
  }
  const added = [];
  for (const r of refs) {
    if (concerned.has(r.annotation_id)) continue;
    const got = matched.get(r.annotation_id);
    if (!got || got.problems.length) {
      added.push({ kind: 'broken', label: r.label, problems: got ? [...got.problems] : ['missing'], onset_s: round4(r.onset_sample / sf),
        offset_s: round4(endOf(r) / sf), detail: `The ${r.label} at ${time(r.onset_sample, endOf(r), sf)} was right, ${got ? 'and no longer matches the experts\'.' : 'and is now missing.'}` });
    }
  }
  const plantedIds = new Set((planted || []).map((a) => a.annotation_id));
  for (const m of loose) {
    if (extras.some(([a, b]) => m.onset_sample < b && a < endOf(m))) continue;
    added.push({ kind: 'added', label: m.label, problems: [], onset_s: round4(m.onset_sample / sf), offset_s: round4(endOf(m) / sf),
      from_copy: plantedIds.has(m.annotation_id),
      detail: `${article(m.label).replace(/^a/, 'A')} ${m.label} at ${time(m.onset_sample, endOf(m), sf)} is where the experts marked nothing.` });
  }
  const n = errors.length;
  return { n_errors: n, fixed, not_fixed: n - fixed, new_mistakes: added.length, items, new: added, message: scoreMessage(fixed, n, added.length) };
}
