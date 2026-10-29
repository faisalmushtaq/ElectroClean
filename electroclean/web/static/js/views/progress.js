// The annotator's own progress on the home page, as plain functions that the home view uses and the
// unit tests check: recordings done of those assigned, the time worked in all and per recording, the
// work of today, the unfinished recording to continue, and an estimate of the time left at the
// annotator's own pace. The times are those saved with each recording (elapsed_s, pauses left out).

/** Finished recordings needed before the time left is estimated. */
export const MIN_FOR_ESTIMATE = 2;

/** The median of a list of numbers (null for none). */
export function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** A span of time to the minute, as the home page shows it: "under a minute", "41 min", "2 h 10 min". */
export function spanText(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 60) return 'under a minute';
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** An estimate rounded as honestly as it deserves: to 5 minutes, or 15 beyond two hours. */
export function roundEstimate(seconds) {
  const step = seconds > 2 * 3600 ? 900 : 300;
  return Math.max(step, Math.round(seconds / step) * step);
}

/** Whether an ISO date and time (with its offset) falls on the local day of `now`. */
export function isToday(iso, now = new Date()) {
  if (!iso) return false;
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.toDateString() === now.toDateString();
}

/**
 * The figures of the progress card. items: GET /assignments items (with elapsed_s, n_annotations
 * and completed_at for finished ones, and draft for unfinished ones); `drafts(item)` gives this
 * browser's copy of an item's draft, if any; todayS: the working time of today in this browser.
 */
export function progressSummary(items, { drafts = () => null, todayS = 0, now = new Date(), next = null } = {}) {
  const counted = items.filter((i) => !i.repeat || i.status === 'done');
  const done = counted.filter((i) => i.status === 'done');
  // A revised recording took the time of every version (saved.total_elapsed_s); it was done when first saved.
  const workS = (i) => Number(i.saved && Number.isFinite(i.saved.total_elapsed_s) ? i.saved.total_elapsed_s : i.elapsed_s);
  const doneAt = (i) => (i.saved && i.saved.first_saved_at) || i.completed_at;
  const times = done.map(workS).filter((x) => Number.isFinite(x) && x > 0);
  const totalDoneS = times.reduce((a, b) => a + b, 0);
  // Unfinished work: the newer of the study's draft summary and this browser's copy.
  const unfinished = new Map();
  for (const i of counted.filter((x) => x.status === 'in_progress')) {
    const mine = drafts(i);
    const theirs = i.draft || null;
    const pick = [theirs, mine && { elapsed_s: Number(mine.elapsed_s) || 0, n_annotations: (mine.annotations || []).length,
      viewed_s: Array.isArray(mine.viewed) ? mine.viewed.reduce((t, [a, b]) => t + Math.max(0, b - a), 0) : null, saved_at: mine.saved_at || null }]
      .filter(Boolean).sort((a, b) => String(b.saved_at || '').localeCompare(String(a.saved_at || '')))[0] || null;
    unfinished.set(i, pick);
  }
  const startedS = [...unfinished.values()].reduce((t, d) => t + (d && Number(d.elapsed_s) > 0 ? Number(d.elapsed_s) : 0), 0);
  // The pace: working time per second of recording, over the recordings finished with a time.
  const timedDone = done.filter((i) => workS(i) > 0 && Number(i.duration_s) > 0);
  let remainingS = null;
  if (timedDone.length >= MIN_FOR_ESTIMATE) {
    const pace = timedDone.reduce((t, i) => t + workS(i), 0) / timedDone.reduce((t, i) => t + Number(i.duration_s), 0);
    remainingS = counted.filter((i) => i.status !== 'done').reduce((t, i) => {
      const d = unfinished.get(i);
      const spent = d && Number(d.elapsed_s) > 0 ? Number(d.elapsed_s) : 0;
      return t + Math.max(0, Number(i.duration_s) * pace - spent);
    }, 0);
  }
  const cont = (next && next.status === 'in_progress' ? next : null) || counted.find((i) => i.status === 'in_progress') || null;
  const c = cont ? unfinished.get(cont) : null;
  return {
    total: counted.length,
    done: done.length,
    workedS: totalDoneS + startedS,
    medianS: median(times),
    doneToday: done.filter((i) => isToday(doneAt(i), now)).length,
    todayS,
    remainingS: remainingS === null ? null : remainingS,
    basedOn: timedDone.length,
    left: counted.length - done.length,
    continue: cont ? {
      item: cont,
      elapsedS: c && Number.isFinite(Number(c.elapsed_s)) ? Number(c.elapsed_s) : null,
      nAnnotations: c && Number.isInteger(c.n_annotations) ? c.n_annotations : null,
      viewedFraction: c && Number.isFinite(c.viewed_s) && Number(cont.duration_s) > 0 ? Math.min(1, c.viewed_s / Number(cont.duration_s)) : null,
      savedAt: c ? c.saved_at : null,
    } : null,
  };
}
