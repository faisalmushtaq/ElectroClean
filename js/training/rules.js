// The guided training rules: a port of electroclean/training/guided.py, used by the demonstration
// (in a real study the server applies the Python rules and only sends the feedback).
// Messages are the same, word for word.

import { article, listWords, UNDO_HINT } from '../util.js';

export const STARS_FIRST = 3;
export const STARS_FEW = 2;
export const STARS_SHOWN = 1;
export const FEW_ATTEMPTS = 3;

export const DEFAULT_TOLERANCE = Object.freeze({ seconds: 0.2, fraction: 0.2, channel_jaccard: 0.75, accepted_labels: {} });

const end = (a) => a.onset_sample + a.duration_samples;
const isGlobal = (a) => !a.channels || a.channels.length === 0;

export function windowS(tol, durationS) {
  return Math.max(tol.seconds, tol.fraction * Math.max(durationS, 0));
}

export function accepts(tol, expertLabel, label) {
  return label === expertLabel || ((tol.accepted_labels || {})[expertLabel] || []).includes(label);
}

/** The expert annotations as steps, in order of onset (then end, then label). */
export function buildSteps(reference, notes = {}) {
  const ordered = [...reference].sort((a, b) => a.onset_sample - b.onset_sample || end(a) - end(b) ||
    (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return ordered.map((a, i) => ({ index: i, target: a, note: notes[a.annotation_id] || '' }));
}

export function overlaps(a, b) {
  return a.onset_sample < end(b) && b.onset_sample < end(a);
}

export function iou(a, b) {
  const inter = Math.min(end(a), end(b)) - Math.max(a.onset_sample, b.onset_sample);
  const union = Math.max(end(a), end(b)) - Math.min(a.onset_sample, b.onset_sample);
  return union > 0 ? Math.max(inter, 0) / union : 0;
}

export function channelJaccard(a, b) {
  const x = new Set(a.channels);
  const y = new Set(b.channels);
  const union = new Set([...x, ...y]);
  if (!union.size) return 1;
  let inter = 0;
  for (const c of x) if (y.has(c)) inter += 1;
  return inter / union.size;
}

function keyHint(label, quickKeys) {
  const key = (quickKeys || {})[label];
  return key ? ` (press ${key})` : ' (press / and type its name)';
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Check the trainee's annotations against one step. Returns
 * {matched, candidate_id, problems, messages, deltas}.
 */
export function checkStep(step, annotations, sfreq, tol = DEFAULT_TOLERANCE, { taken = new Set(), quickKeys = null } = {}) {
  const target = step.target;
  const candidates = annotations.filter((a) => !taken.has(a.annotation_id) && overlaps(a, target));
  if (!candidates.length) return { matched: false, candidate_id: null, problems: ['missing'], messages: ['Not marked yet.'], deltas: {} };
  // One of an accepted type first, then the one that overlaps most.
  let cand = candidates[0];
  for (const a of candidates.slice(1)) {
    const ka = [accepts(tol, target.label, a.label) ? 1 : 0, iou(a, target)];
    const kc = [accepts(tol, target.label, cand.label) ? 1 : 0, iou(cand, target)];
    if (ka[0] > kc[0] || (ka[0] === kc[0] && ka[1] > kc[1])) cand = a;
  }
  const problems = [];
  const messages = [];
  const deltas = {};
  if (!accepts(tol, target.label, cand.label)) {
    problems.push('type');
    messages.push(`Type: the experts marked this as ${article(target.label)} ${target.label}` +
      `${keyHint(target.label, quickKeys)}; yours is ${article(cand.label)} ${cand.label}.`);
  }
  const win = windowS(tol, target.duration_samples / sfreq);
  const dStart = (cand.onset_sample - target.onset_sample) / sfreq;
  const dEnd = (end(cand) - end(target)) / sfreq;
  Object.assign(deltas, { start_s: r4(dStart), end_s: r4(dEnd), allowed_s: r4(win), iou: r4(iou(cand, target)) });
  if (Math.abs(dStart) > win) {
    problems.push('start');
    messages.push(`Almost: the start is ${Math.abs(dStart).toFixed(2)} s too ${dStart < 0 ? 'early' : 'late'}. Drag the left edge to move it.`);
  }
  if (Math.abs(dEnd) > win) {
    problems.push('end');
    messages.push(`Almost: the end is ${Math.abs(dEnd).toFixed(2)} s too ${dEnd < 0 ? 'early' : 'late'}. Drag the right edge to move it.`);
  }
  if (isGlobal(target) && !isGlobal(cand)) {
    problems.push('scope');
    messages.push('Channels: the experts marked this on the whole montage. Right-click it and choose ' +
      'Apply to whole montage, or switch to Whole montage (C) and mark it again.');
  } else if (!isGlobal(target) && isGlobal(cand)) {
    problems.push('scope');
    messages.push(`Channels: the experts marked this on ${listWords(target.channels)} only. Right-click it and ` +
      'choose Edit channels…, or choose those channels (Selected channels, C) and mark it again.');
  } else if (!isGlobal(target)) {
    const jac = channelJaccard(cand, target);
    deltas.channel_jaccard = r4(jac);
    if (jac < tol.channel_jaccard) {
      problems.push('channels');
      const missing = target.channels.filter((c) => !cand.channels.includes(c));
      const extra = cand.channels.filter((c) => !target.channels.includes(c));
      const parts = [];
      if (missing.length) parts.push(`${listWords(missing)} ${missing.length === 1 ? 'is' : 'are'} missing`);
      if (extra.length) parts.push(`${listWords(extra)} ${extra.length === 1 ? 'is' : 'are'} not part of it`);
      messages.push(`Channels: the experts marked this on ${listWords(target.channels)}; ` + parts.join('; ') +
        '. Shift+click a channel inside the annotation to add or remove it.');
    }
  }
  if (problems.length) return { matched: false, candidate_id: cand.annotation_id, problems, messages, deltas };
  const what = isGlobal(target) ? 'Right type and timing' : 'Right type, timing and channels';
  return { matched: true, candidate_id: cand.annotation_id, problems: [], messages: [what + '.'], deltas };
}

/** Annotations to remove: those over no expert annotation, and second attempts at a matched or current step. */
export function extras(steps, annotations, matched, current = null, currentIndex = null) {
  const keep = new Set(Object.values(matched));
  if (current && current.candidate_id) keep.add(current.candidate_id);
  const out = [];
  for (const a of annotations) {
    if (keep.has(a.annotation_id)) continue;
    const hits = steps.filter((s) => overlaps(a, s.target));
    if (!hits.length) { out.push(a); continue; }
    if (!hits.some((s) => !(s.index in matched) && s.index !== currentIndex)) out.push(a);
  }
  return out;
}

/** The coach's message about the first extra annotation (the same text as the desktop coach). */
export function extraMessage(extra, steps, sfreq) {
  const a = (extra.onset_sample / sfreq).toFixed(2);
  const b = (end(extra) / sfreq).toFixed(2);
  if (steps.some((s) => overlaps(extra, s.target))) {
    return `You have marked this artifact twice (${extra.label}, ${a}–${b} s): delete the extra one ` +
      `(select it and press Delete) or press ${UNDO_HINT}.`;
  }
  return `Nothing is marked at ${a}–${b} s in the experts' annotations: delete this ${extra.label} ` +
    `(it is selected; press Delete) or press ${UNDO_HINT}.`;
}

export function starsFor(failedAttempts, shown) {
  if (shown) return STARS_SHOWN;
  if (failedAttempts === 0) return STARS_FIRST;
  if (failedAttempts < FEW_ATTEMPTS) return STARS_FEW;
  return STARS_SHOWN;
}

export function starText(stars, maxStars) {
  return maxStars <= 9 ? '★'.repeat(stars) + '☆'.repeat(Math.max(maxStars - stars, 0)) : `★ ${stars}`;
}

/** 'Eye-blink-artifact, 3.00–3.40 s, on Fp1, Fp2 and VEOG'. */
export function describeTarget(target, sfreq) {
  const where = isGlobal(target) ? 'whole montage' : 'on ' + listWords(target.channels);
  return `${target.label}, ${(target.onset_sample / sfreq).toFixed(2)}–${(end(target) / sfreq).toFixed(2)} s, ${where}`;
}

/** The instruction (title) for a step, by guidance level: the same words as the desktop coach. */
export function instruction(label, guidance) {
  if (guidance === 'show') return `Mark this ${label}`;
  if (guidance === 'find') return `Find the ${label} on this screen`;
  return 'Find the next artifact';
}

/** The explanation under the title (plain text with **bold** marks for the keys). */
export function stepBody(guidance, label, channels, quickKeys) {
  const key = label ? (quickKeys || {})[label] : null;
  const keyText = key ? `press **${key}**` : 'press **/** and type its name';
  if (guidance === 'show') {
    const where = !channels || channels.length === 0 ? 'the whole montage (Whole montage, or C)'
      : `${listWords(channels)} (Selected channels, then click the channel names)`;
    return `The experts' annotation is outlined with a dashed line. Choose its type (${keyText}), choose ${where}, ` +
      'and drag across it from start to end (or press **M** at the start and at the end).';
  }
  if (guidance === 'find') {
    return `There is ${article(label)} ${label} somewhere on this screen. Choose its type (${keyText}), decide which ` +
      'channels it affects, and mark it.';
  }
  return 'Scroll on from here. Mark the next artifact you see, choose its type and channels, and the feedback tells ' +
    'you how close you are to the experts.';
}
