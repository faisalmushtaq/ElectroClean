// The guided training rules: a port of electrotag/training/guided.py, used by the demonstration
// (in a real study the server applies the Python rules and only sends the feedback).
// Messages are the same, word for word.

import { article, listWords } from '../util.js';

/** How to undo, in the words of the study server's coach (electrotag/web/coach.py UNDO_HINT). */
const UNDO_HINT = 'Ctrl+Z (⌘Z on a Mac) to undo';

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

/** How to change a selected annotation to `label` (a number key, or the type finder). */
function changeTypeHint(label, quickKeys) {
  const key = (quickKeys || {})[label];
  return key ? `press ${key} to change its type` : `press / and choose ${label}`;
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** How to put an annotation's channels right with the controls there are (Shift+click on a channel
 *  inside an annotation takes it off; Edit channels… adds and takes off), as guided.py _channels_fix. */
function channelsFix(missing, extra) {
  if (missing.length) {
    if (extra.length) return `Right-click your annotation, choose Edit channels…, tick ${listWords(missing)} and untick ${listWords(extra)}.`;
    return `Right-click your annotation, choose Edit channels… and tick ${listWords(missing)}.`;
  }
  return `Hold Shift and click your annotation on ${listWords(extra)} to take ${extra.length === 1 ? 'it' : 'them'} off ` +
    '(or right-click it and choose Edit channels…).';
}

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
    messages.push(`Type: the experts marked this as ${article(target.label)} ${target.label}; yours is ` +
      `${article(cand.label)} ${cand.label}. Click your annotation to select it, then ${changeTypeHint(target.label, quickKeys)}.`);
  }
  const win = windowS(tol, target.duration_samples / sfreq);
  const dStart = (cand.onset_sample - target.onset_sample) / sfreq;
  const dEnd = (end(cand) - end(target)) / sfreq;
  Object.assign(deltas, { start_s: r4(dStart), end_s: r4(dEnd), allowed_s: r4(win), iou: r4(iou(cand, target)) });
  if (Math.abs(dStart) > win) {
    problems.push('start');
    messages.push(`Start: ${Math.abs(dStart).toFixed(2)} s too ${dStart < 0 ? 'early' : 'late'}. ` +
      `Drag the left edge of your annotation to the ${dStart < 0 ? 'right' : 'left'}.`);
  }
  if (Math.abs(dEnd) > win) {
    problems.push('end');
    messages.push(`End: ${Math.abs(dEnd).toFixed(2)} s too ${dEnd < 0 ? 'early' : 'late'}. ` +
      `Drag the right edge of your annotation to the ${dEnd < 0 ? 'right' : 'left'}.`);
  }
  if (isGlobal(target) && !isGlobal(cand)) {
    problems.push('scope');
    messages.push('Channels: the experts marked this on the whole montage. Right-click your annotation and choose ' +
      'Apply to whole montage.');
  } else if (!isGlobal(target) && isGlobal(cand)) {
    problems.push('scope');
    const names = listWords(target.channels);
    messages.push(`Channels: the experts marked this on ${names} only. Right-click your annotation, choose Edit ` +
      `channels…, then choose Only these channels and tick ${names}.`);
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
        `. ${channelsFix(missing, extra)}`);
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

/** The first step of marking `label`: its number key or button, or the type finder. */
export function chooseTypeText(label, quickKeys) {
  const key = (quickKeys || {})[label];
  if (label === 'Data-artifact') return 'Press **0** (or click **Uncertain** in the toolbar) to choose Data-artifact, the type for an artifact whose type cannot be told.';
  if (key) return `Press **${key}** (or click **${key}** next to Draw as) to choose ${label}.`;
  return `Press **/**, type ${label} and press **Enter** to choose it.`;
}

const SCOPE_EITHER = 'Decide which channels it affects. For all of them, choose **Whole montage** in the toolbar; for ' +
  'some, choose **Selected channels** and click their names at the left of the EEG (**C** switches ' +
  'between the two).';

/** The second step of marking an annotation on the whole montage or on `channels`. */
export function scopeText(channels) {
  if (!channels || !channels.length) return 'Make sure **Whole montage** is chosen in the toolbar (click it, or press **C** to switch).';
  return `Make sure **Selected channels** is chosen in the toolbar (click it, or press **C** to switch), then ` +
    `click the channel names ${listWords(channels)} at the left of the EEG. Only ` +
    `${channels.length === 1 ? 'this one' : 'these'} should be chosen: click a name again to take it off.`;
}

/**
 * What to do for a step, one line per action (plain text with **bold** marks for the keys and
 * controls): the same words as electrotag/training/guided.py step_text.
 */
export function stepBody(guidance, label, channels, quickKeys) {
  if (guidance === 'show' && label) {
    return [
      "The experts' annotation is outlined with a dashed line. To mark it:",
      `1. ${chooseTypeText(label, quickKeys)}`,
      `2. ${scopeText(channels)}`,
      '3. Drag across the EEG from the start of the outline to its end (or point at the start and press **M**, ' +
        'then at the end and press **M** again).',
    ].join('\n');
  }
  if (guidance === 'find' && label) {
    return [
      `There is ${article(label)} ${label} somewhere on this screen. Find it, then mark it:`,
      `1. ${chooseTypeText(label, quickKeys)}`,
      `2. ${SCOPE_EITHER}`,
      '3. Drag across the EEG from where it starts to where it ends.',
    ].join('\n');
  }
  return [
    'Move on to the next artifact (the **right arrow** key, with **Shift** for a whole screen), then mark it:',
    '1. Choose its type: press its number (the numbers next to Draw as), or press **/** and type its name.',
    `2. ${SCOPE_EITHER}`,
    '3. Drag across the EEG from where it starts to where it ends. The feedback tells you how close you are ' +
      'to the experts.',
  ].join('\n');
}

/**
 * The coach's words for a touch screen (an iPad): the same steps and fixes, with taps, press and hold,
 * and the buttons on screen in place of keys, right-clicks and Shift. The study and the demonstration
 * give the keyboard's words (step_text and check_step in electrotag/training/guided.py, stepBody and
 * checkStep here); the coach turns them into these where the main pointer is a finger.
 */
export function touchWords(text) {
  return String(text)
    .replace(/Press \*\*(\d)\*\* \(or click \*\*\1\*\* next to Draw as\) to choose/g, 'Tap **$1** next to Draw as to choose')
    .replace(/Press \*\*\/\*\*, type (\S+) and press \*\*Enter\*\* to choose it\./g, 'Tap the menu of all types after the numbered buttons next to Draw as and choose $1.')
    .replace(/press its number \(the numbers next to Draw as\), or press \*\*\/\*\* and type its name/g, 'tap its number next to Draw as, or choose it in the menu of all types after them')
    .replace(/ \(click it, or press \*\*C\*\* to switch\)/g, ' (tap it)')
    .replace(/ \(\*\*C\*\* switches between the two\)/g, '')
    .replace(/then click the channel names/g, 'then tap the channel names')
    .replace(/click their names/g, 'tap their names')
    .replace(/click a name again to take it off/g, 'tap a name again to take it off')
    .replace(/ \(or point at the start and press \*\*M\*\*, then at the end and press \*\*M\*\* again\)/g, '')
    .replace(/Drag across the EEG/g, 'Drag one finger across the EEG')
    .replace(/\(the \*\*right arrow\*\* key, with \*\*Shift\*\* for a whole screen\)/g, '(move the EEG sideways with two fingers, or use the buttons under it)')
    .replace(/Hold Shift and click your annotation on (.+?) to take (?:it|them) off \(or right-click it and choose Edit channels…\)\./g,
      'Press and hold your annotation, choose Edit channels… and untick $1.')
    .replace(/Right-click your annotation/g, 'Press and hold your annotation')
    .replace(/Click your annotation to select it, then press (\d) to change its type\./g, 'Tap your annotation to select it, then tap $1 next to Change to.')
    .replace(/Click your annotation to select it, then press \/ and choose (\S+?)\./g, 'Tap your annotation to select it, then choose $1 in the menu of all types.')
    .replace(/\(select it and press Delete\)/g, '(tap it, then Delete at the top)')
    .replace(/\(it is selected; press Delete\)/g, '(it is selected; tap Delete at the top)')
    .replace(/press (?:Ctrl|⌘)\+Z(?: \(⌘Z on a Mac\))? to undo/g, 'tap Undo at the top')
    .replace(/press \*\*Continue\*\* \(Enter\)/g, 'tap **Continue**')
    .replace(/Press \*\*Continue\*\* \(Enter\)/g, 'Tap **Continue**');
}
