// Which parts of a recording have been on screen, as plain functions that the annotation view uses
// and the unit tests check. The parts are kept as merged intervals [start_s, end_s] in seconds,
// sorted and without overlaps, which is also how a draft keeps them; the unviewed stretches are
// what is left of the recording, leaving out the stretches without recorded data.

/** A view counts as seen once it has stayed on screen this long (milliseconds). */
export const DWELL_MS = 400;
/** Save and Finish lists unviewed stretches at least this long (seconds). */
export const MIN_UNVIEWED_S = 1;
/** Intervals closer than this (seconds) are joined, so that rounding leaves no slivers. */
const JOIN_S = 0.02;
/** At most this many intervals are kept (a draft stays small); the closest are joined first. */
export const MAX_INTERVALS = 2000;

const round2 = (v) => Math.round(v * 100) / 100;

/** Merge a list of [a, b] intervals: sorted, overlaps and near neighbours joined, empty ones dropped. */
export function mergeIntervals(list, joinS = JOIN_S) {
  const xs = (list || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > p[0])
    .map(([a, b]) => [a, b]).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of xs) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + joinS) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Add the interval [a, b] (clipped to the recording, 0 to totalS) to a merged list; returns a new list. */
export function addInterval(list, a, b, totalS = Infinity) {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(totalS, Math.max(a, b));
  if (!(hi > lo)) return list;
  let merged = mergeIntervals([...list, [lo, hi]]);
  if (merged.length > MAX_INTERVALS) {
    // Join the intervals with the smallest gaps between them until few enough are left.
    const gaps = merged.slice(1).map((p, i) => p[0] - merged[i][1]).sort((x, y) => x - y);
    merged = mergeIntervals(merged, gaps[merged.length - MAX_INTERVALS - 1] + 1e-9);
  }
  return merged;
}

/** Seconds covered by a merged list. */
export function coveredS(list) {
  return list.reduce((s, [a, b]) => s + (b - a), 0);
}

/** The parts of [0, totalS] not in a merged list (also merged). */
export function complement(list, totalS) {
  const out = [];
  let at = 0;
  for (const [a, b] of list) {
    if (a > at) out.push([at, Math.min(a, totalS)]);
    at = Math.max(at, b);
    if (at >= totalS) break;
  }
  if (at < totalS) out.push([at, totalS]);
  return out.filter(([a, b]) => b > a);
}

/**
 * The stretches not yet on screen, at least `minS` seconds long. `noData` lists stretches without
 * recorded data ([a, b] in seconds), which have nothing to look at and count as seen.
 */
export function unviewed(list, totalS, { noData = [], minS = MIN_UNVIEWED_S } = {}) {
  const seen = mergeIntervals([...list, ...noData]);
  return complement(seen, totalS).filter(([a, b]) => b - a >= minS - 1e-9);
}

/** The proportion of the recording on screen so far (0 to 1), not counting stretches without data. */
export function viewedFraction(list, totalS, noData = []) {
  const blank = coveredS(mergeIntervals(noData.map(([a, b]) => [Math.max(0, a), Math.min(totalS, b)])));
  const total = totalS - blank;
  if (!(total > 0)) return 1;
  const seen = coveredS(mergeIntervals([...list, ...noData])) - blank;
  return Math.max(0, Math.min(1, seen / total));
}

/** The whole-number percentage shown ("Viewed 64%"), rounded down: 100 only when nothing is left to see. */
export function percentText(fraction) {
  return `${Math.floor(Math.max(0, Math.min(1, fraction)) * 100 + 1e-9)}%`;
}

/**
 * The next unviewed stretch after `fromS` (or the first one, coming round from the start): one of
 * `gaps` (from unviewed), or null when everything has been seen.
 */
export function nextUnviewed(gaps, fromS) {
  if (!gaps.length) return null;
  return gaps.find(([, b]) => b > fromS + 1e-6 && b - Math.max(fromS, 0) >= 0.05) || gaps[0];
}

/**
 * Where to put the view to show an unviewed stretch: its start, with a little seen EEG before it
 * when the whole stretch still fits on the screen (or when it is longer than the screen anyway).
 */
export function viewStartFor(gap, durationS) {
  const [a, b] = gap;
  const lead = Math.min(0.1 * durationS, 1);
  return b - a > durationS ? Math.max(0, a - lead) : Math.max(0, a - Math.min(lead, (durationS - (b - a)) / 2));
}

/** A merged list as a draft keeps it: [start_s, end_s] pairs to a hundredth of a second. */
export function toDraft(list) {
  return mergeIntervals(list.map(([a, b]) => [Math.floor(a * 100) / 100, Math.ceil(b * 100) / 100])).map(([a, b]) => [round2(a), round2(b)]);
}

/** A draft's list (anything) as a merged list within the recording. */
export function fromDraft(value, totalS) {
  if (!Array.isArray(value)) return [];
  return mergeIntervals(value.filter((p) => Array.isArray(p) && p.length === 2)
    .map(([a, b]) => [Math.max(0, Number(a)), Math.min(totalS, Number(b))]));
}
