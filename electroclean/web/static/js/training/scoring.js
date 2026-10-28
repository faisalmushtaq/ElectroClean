// Practice scoring for the demonstration: the event matching of the desktop application's agreement
// analysis (electroclean/reliability/matching.py) with its defaults (time only, IoU of at least 0.2,
// each event matched at most once, the most matches and then the largest total overlap), and the
// pass rule of the training programme (electroclean/training/programme.py PassRule).
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
 */
export function practiceFeedback(reference, mine, { iouThreshold = DEFAULT_IOU, passRule = DEFAULT_PASS } = {}) {
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
  const flags = [];
  for (const i of any.unmatchedRef) {
    const a = ref[i];
    flags.push({ kind: 'MISSED', label: a.label, your_label: null, onset_sample: a.onset_sample,
      duration_samples: a.duration_samples, channels: [...a.channels], annotation_id: a.annotation_id });
  }
  for (const j of any.unmatchedTest) {
    const a = you[j];
    flags.push({ kind: 'EXTRA', label: a.label, your_label: a.label, onset_sample: a.onset_sample,
      duration_samples: a.duration_samples, channels: [...a.channels], annotation_id: a.annotation_id });
  }
  for (const [i, j] of any.pairs) {
    if (ref[i].label === you[j].label) continue;
    const a = ref[i];
    flags.push({ kind: 'TYPE', label: a.label, your_label: you[j].label, onset_sample: a.onset_sample,
      duration_samples: a.duration_samples, channels: [...a.channels], annotation_id: you[j].annotation_id });
  }
  flags.sort((a, b) => a.onset_sample - b.onset_sample);
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
    metrics: { event_f1: f, event_recall: recall, event_precision: precision, label_accuracy: acc,
      reference_events: nRef, your_events: nYou, found: any.pairs.length },
    flags,
    reference: ref.map((a) => ({ ...a, channels: [...a.channels] })),
  };
}

export function describePassRule(rule) {
  const pc = (v) => `${Math.round(v * 100)}%`;
  if (rule.event_f1 === rule.label_accuracy) return `${pc(rule.event_f1)} for finding the artifacts and for their types`;
  return `${pc(rule.event_f1)} for finding the artifacts and ${pc(rule.label_accuracy)} for their types`;
}
