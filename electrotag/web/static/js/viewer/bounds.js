// The part of a recording a task gives an annotator (docs/web/api.md, "Tasks, windows and known
// answers"): a window of whole samples, [start_sample, end_sample). The viewer hatches the rest of
// the recording and keeps the view inside the window (with a second of context on each side, so that
// an artifact at the edge can be judged), and the annotation store refuses marks outside it. Plain
// functions, so that the rules can be tested without a screen.

/** Seconds of the recording shown beyond each end of the window, as context (never annotated). */
export const CONTEXT_S = 1;

/** A time as people read it: 0:05, 1:30, 1:02:05, with tenths when they matter (as electrotag/web/tasks.py clock). */
export function clockText(seconds) {
  const tenths = Math.floor(Math.max(0, Number(seconds) || 0) * 10 + 0.5);
  const whole = Math.floor(tenths / 10);
  const tenth = tenths % 10;
  const hh = Math.floor(whole / 3600);
  const mm = Math.floor((whole % 3600) / 60);
  const sec = `${String(whole % 60).padStart(2, '0')}${tenth ? `.${tenth}` : ''}`;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${sec}` : `${mm}:${sec}`;
}

/**
 * The bounds of a task's window ({start_sample, end_sample, ...} of GET /assignments), or null for a
 * whole recording: {startSample, endSample, startS, endS, text}.
 */
export function boundsOf(window, sfreq, nSamples = Infinity) {
  if (!window || !(sfreq > 0)) return null;
  const a = Math.max(0, Math.trunc(Number(window.start_sample)));
  const b = Math.min(nSamples, Math.trunc(Number(window.end_sample)));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  if (a === 0 && b >= nSamples) return null; // the whole recording after all
  const startS = a / sfreq;
  const endS = b / sfreq;
  return { startSample: a, endSample: b, startS, endS, text: `${clockText(startS)} to ${clockText(endS)}` };
}

/** The window of a person's work item, from GET /assignments (its `task`), or null. */
export function itemWindow(items, { recordingId, mode = 'standard', contextId = '' }) {
  const it = (items || []).find((i) => i.recording_id === recordingId && (i.mode || 'standard') === mode && (i.context_id || '') === (contextId || ''));
  return it && it.task && it.task.window ? it.task.window : null;
}

/** The stretch the view may show: the window with its context, inside the recording ([lo, hi] seconds). */
export function viewSpan(bounds, totalS, context = CONTEXT_S) {
  if (!bounds) return [0, totalS];
  return [Math.max(0, bounds.startS - context), Math.min(totalS, bounds.endS + context)];
}

/** A view {startS, durationS} kept inside the window and its context (the view's other fields are kept). */
export function clampView(view, bounds, totalS, context = CONTEXT_S) {
  if (!bounds) return view;
  const [lo, hi] = viewSpan(bounds, totalS, context);
  const durationS = Math.min(view.durationS, hi - lo);
  const startS = Math.min(Math.max(view.startS, lo), hi - durationS);
  return { ...view, durationS, startS };
}

/** The stretches outside the window, in seconds: [[0, start], [end, total]] (empty ones left out). */
export function outsideStretches(bounds, totalS) {
  if (!bounds) return [];
  const out = [];
  if (bounds.startS > 0) out.push([0, bounds.startS]);
  if (bounds.endS < totalS) out.push([bounds.endS, totalS]);
  return out;
}

/** True when a mark of these samples lies wholly inside the window (or there is no window). */
export function insideBounds(onsetSample, durationSamples, bounds) {
  return !bounds || (onsetSample >= bounds.startSample && onsetSample + durationSamples <= bounds.endSample);
}

/** Why a mark is refused (the same words for every way of making or changing one). */
export function outsideText(bounds) {
  return `it lies outside your part of the recording, ${bounds.text}. Only that part is annotated in this task.`;
}
