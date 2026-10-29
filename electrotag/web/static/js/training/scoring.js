// Practice scoring for the demonstration: the event matching of the desktop application's agreement
// analysis (electrotag/reliability/matching.py) with its defaults (time only, IoU of at least 0.2,
// each event matched at most once, the most matches and then the largest total overlap), and the
// pass rule of the training programme (electrotag/training/programme.py PassRule).
// In a real study the server scores practice recordings with the Python code.

export const DEFAULT_IOU = 0.2;
export const DEFAULT_PASS = Object.freeze({ event_f1: 0.8, label_accuracy: 0.8 });

const end = (a) => a.onset_sample + a.duration_samples;

function iouOf(a, b) {
  const inter = Math.min(end(a), end(b)) - Math.max(a.onset_sample, b.onset_sample);
  const union = Math.max(end(a), end(b)) - Math.min(a.onset_sample, b.onset_sample);
  return union > 0 ? Math.max(inter, 0) / union : 0;
}

/** Maximum-weight assignment (Hungarian algorithm, rectangular). Returns pairs [row, col] with weight > 0. */
export function hungarianMax(weights) {
  const n = weights.length;
  const m = n ? weights[0].length : 0;
  if (!n || !m) return [];
  const size = Math.max(n, m);
  let maxW = 0;
  for (const row of weights) for (const w of row) maxW = Math.max(maxW, w);
  // Minimise cost = maxW - weight on a square matrix (padding costs maxW, i.e. weight 0).
  const cost = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) =>
    (i < n && j < m ? maxW - weights[i][j] : maxW)));
  const INF = Infinity;
  const u = new Array(size + 1).fill(0);
  const v = new Array(size + 1).fill(0);
  const p = new Array(size + 1).fill(0);
  const way = new Array(size + 1).fill(0);
  for (let i = 1; i <= size; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(size + 1).fill(INF);
    const used = new Array(size + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= size; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= size; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const pairs = [];
  for (let j = 1; j <= size; j++) {
    const i = p[j] - 1;
    const c = j - 1;
    if (i < n && c < m && weights[i][c] > 0) pairs.push([i, c]);
  }
  return pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** One-to-one matching of reference and test events at an IoU threshold (time only). */
export function matchEvents(ref, test, { iouThreshold = DEFAULT_IOU, preferSameLabel = false } = {}) {
  const n = ref.length;
  const m = test.length;
  if (!n || !m) return { pairs: [], unmatchedRef: [...Array(n).keys()], unmatchedTest: [...Array(m).keys()] };
  const big = Math.min(n, m) + 1;
  const weights = ref.map((r) => test.map((t) => {
    const ov = iouOf(r, t);
    const ok = iouThreshold <= 0 ? ov > 0 : ov >= iouThreshold - 1e-12;
    if (!ok) return 0;
    let w = big * big + ov;
    if (preferSameLabel && r.label === t.label) w += big;
    return w;
  }));
  const pairs = hungarianMax(weights);
  const mr = new Set(pairs.map(([i]) => i));
  const mt = new Set(pairs.map(([, j]) => j));
  return {
    pairs,
    unmatchedRef: [...Array(n).keys()].filter((i) => !mr.has(i)),
    unmatchedTest: [...Array(m).keys()].filter((j) => !mt.has(j)),
  };
}

const byOnset = (a, b) => a.onset_sample - b.onset_sample || end(a) - end(b) ||
  (a.annotation_id < b.annotation_id ? -1 : a.annotation_id > b.annotation_id ? 1 : 0);

/**
 * Practice feedback in the shape of PracticeFeedback (docs/web/api.md).
 * @param {object[]} reference the experts' annotations
 * @param {object[]} mine the trainee's annotations
 * @param {{iouThreshold?: number, passRule?: object, sfreq?: number}} opts sfreq gives the flags' times in seconds
 */
export function practiceFeedback(reference, mine, { iouThreshold = DEFAULT_IOU, passRule = DEFAULT_PASS, sfreq = 1 } = {}) {
  const ref = [...reference].sort(byOnset);
  const you = [...mine].sort(byOnset);
  // Event F1: the micro-average over the single-label categories.
  let nRef = 0; let nYou = 0; let matched = 0;
  for (const label of new Set([...ref, ...you].map((a) => a.label))) {
    const r = ref.filter((a) => a.label === label);
    const t = you.filter((a) => a.label === label);
    nRef += r.length; nYou += t.length;
    matched += matchEvents(r, t, { iouThreshold }).pairs.length;
  }
  const recall = nRef ? matched / nRef : NaN;
  const precision = nYou ? matched / nYou : NaN;
  const f1 = nRef + nYou ? (2 * matched) / (nRef + nYou) : NaN;
  // Any artifact: what was found at all, then whether its type was right.
  const any = matchEvents(ref, you, { iouThreshold, preferSameLabel: true });
  const same = any.pairs.filter(([i, j]) => ref[i].label === you[j].label).length;
  const labelAccuracy = any.pairs.length ? same / any.pairs.length : NaN;
  // The flags of the review, as the server words them (electrotag/web/coach.py practice_result with
  // electrotag/training/review.py): each on the annotation it is about, the experts' or the trainee's.
  const flags = [];
  const flag = (kind, a, source, label, yourLabel) => {
    const on = a.onset_sample / sfreq;
    const off = end(a) / sfreq;
    const span = `${on.toFixed(2)}–${off.toFixed(2)} s`;
    flags.push({ kind, label, your_label: yourLabel, onset_sample: a.onset_sample, duration_samples: a.duration_samples,
      channels: [...a.channels], annotation_id: a.annotation_id, source, onset_s: on, offset_s: off,
      text: kind === 'MISSED' ? `Missed: ${label}, ${span}` : kind === 'EXTRA' ? `Extra: your ${label}, ${span} (not in the experts' annotations)`
        : `Type: you chose ${yourLabel}; the experts chose ${label}, ${span}` });
  };
  for (const i of any.unmatchedRef) flag('MISSED', ref[i], 'reference', ref[i].label, null);
  for (const j of any.unmatchedTest) flag('EXTRA', you[j], 'yours', you[j].label, you[j].label);
  for (const [i, j] of any.pairs) if (ref[i].label !== you[j].label) flag('TYPE', you[j], 'yours', ref[i].label, you[j].label);
  flags.sort((a, b) => a.onset_s - b.onset_s);
  // The pass rule, as PassRule.evaluate.
  let f = Number.isNaN(f1) ? null : f1;
  let acc = Number.isNaN(labelAccuracy) ? null : labelAccuracy;
  if (nRef === 0 && nYou === 0) { f = 1; acc = 1; } else if ((nRef === 0 || nYou === 0) && f === null) f = 0;
  if (acc === null) acc = 0;
  if (f === null) f = 0;
  const passed = f >= passRule.event_f1 && acc >= passRule.label_accuracy;
  return {
    passed,
    pass_rule: describePassRule(passRule),
    score: { event_f1: f, label_accuracy: acc },
    counts: { reference_events: nRef, your_events: nYou, found: any.pairs.length, extra: any.unmatchedTest.length,
      other_type: any.pairs.length - same },
    metrics: { event_f1: f, event_recall: recall, event_precision: precision, label_accuracy: acc },
    flags,
    reference: ref.map((a) => ({ ...a, channels: [...a.channels], confidence: a.confidence ?? null, note: a.note || '' })),
  };
}

/** 78% for 0.78 (as electrotag/training/programme.py percent). */
export function percent(v) { return `${Math.round(v * 100)}%`; }

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the practice score measures, in plain words (programme.py SCORE_EXPLAINED). */
export const SCORE_EXPLAINED = 'The score is highest when you find every artifact the experts marked, with the right type, ' +
  'and make no marks they did not make; each missed artifact, extra mark or wrong type lowers it.';

/** The pass mark in plain words (programme.py PassRule.describe). */
export function describePassRule(rule) {
  return `a score of at least ${percent(rule.event_f1)} and the right type for at least ${percent(rule.label_accuracy)} of the artifacts you find`;
}

/** What a practice score is made of, from its counts (programme.py score_sentence). */
export function scoreSentence(c) {
  const nRef = c.reference_events || 0;
  const nYou = c.your_events || 0;
  const found = c.found || 0;
  const extra = c.extra || 0;
  if (!nRef) {
    if (!nYou) return 'The experts marked no artifacts in this recording, and neither did you.';
    return `The experts marked no artifacts in this recording; you made ${plural(nYou, 'mark')}.`;
  }
  const extraText = extra === 0 ? 'no marks they did not make' : `${plural(extra, 'mark')} they did not make`;
  let text = `You found ${found} of the experts' ${plural(nRef, 'artifact')} and made ${extraText}.`;
  const other = c.other_type || 0;
  if (other) text += ` ${other} of the ${found} you found ${other === 1 ? 'has' : 'have'} another type than theirs.`;
  return text;
}

/** The practice stage's line on the training path (programme.py practice_detail). */
export function practiceDetail(best, rule, passed) {
  const need = `To pass, you need ${describePassRule(rule)}.`;
  if (!best) return need;
  let text = `Best score: ${percent(best.event_f1 || 0)}, with the right type for ${percent(best.label_accuracy || 0)} of the artifacts found.`;
  if (best.reference_events !== undefined) text += ` ${scoreSentence(best)}`;
  return `${text} ${passed ? 'Passed.' : need}`;
}

/** The verdict at the top of a practice review (programme.py practice_verdict). */
export function practiceVerdict(passed, rule, nPractice, unlocked = '') {
  if (passed) return `Passed: you reached the pass mark, ${describePassRule(rule)}.${unlocked ? ` ${unlocked}` : ''}`;
  const again = nPractice <= 1 ? 'then try this recording again from your training path'
    : 'then go on from your training path to another practice recording';
  return `Not yet: you need ${describePassRule(rule)}. Look at what you missed below, ${again}.`;
}

/** The practice recording to try again: the one practised longest ago (programme.py retry_recording). */
export function retryRecording(recordings, attempts) {
  const last = (rid) => (attempts[rid] || []).reduce((m, a) => (String(a.completed_at || '') > m ? String(a.completed_at || '') : m), '');
  return recordings.reduce((best, r) => (last(r) < last(best) ? r : best), recordings[0]);
}
