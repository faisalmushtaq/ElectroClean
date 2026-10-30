// The scales of the EEG and what the mouse wheel and the trackpad do to them, as plain functions
// that the viewer calls and the unit tests check.
//
// The wheel alone changes the amplitude (up: larger traces), keeping each channel's centre line where
// it is, so that the trace under the pointer stays in its row. Shift with the wheel, and a sideways
// movement of two fingers on a trackpad, move along time. Ctrl (or Cmd) with the wheel, which is what a
// trackpad's pinch sends, shows more or less time, keeping the moment under the pointer where it is.
// Alt (Option) with the wheel moves through the channels.

/** The time scales the toolbar offers, in seconds on screen. */
export const TIME_SCALES = [1, 2, 5, 10, 20, 30, 60];

/** How much one notch of a mouse wheel (100 pixels) changes the amplitude: as the + and − keys do. */
export const AMPLITUDE_STEP = 1.25;

/** The largest movement taken from one wheel event (pixels), so that a fast flick does not jump. */
const MAX_DELTA = 120;

/** A wheel event's movement in pixels: its deltaMode in lines (30 pixels each) or pages (`pagePx`). */
export function wheelPixels(delta, deltaMode, pagePx) {
  const unit = deltaMode === 1 ? 30 : deltaMode === 2 ? pagePx : 1;
  return delta * unit;
}

const capped = (d) => Math.max(-MAX_DELTA, Math.min(MAX_DELTA, d));

/**
 * What a wheel event does: {kind: 'time', seconds} (along time), {kind: 'amplitude', factor},
 * {kind: 'zoom', factor} (the time shown is multiplied by factor) or {kind: 'channels', rows}
 * (fractions of a row, to be summed until whole), or null for no movement.
 * e: {deltaX, deltaY, deltaMode, shiftKey, ctrlKey, metaKey, altKey}; g: {plotW, durationS}.
 */
export function wheelAction(e, g) {
  const dx = wheelPixels(e.deltaX || 0, e.deltaMode, g.plotW);
  const dy = wheelPixels(e.deltaY || 0, e.deltaMode, g.plotW);
  const main = Math.abs(dx) > Math.abs(dy) ? dx : dy; // the larger of the two (Shift+wheel arrives as deltaX on a Mac)
  if (!main) return null;
  if (e.ctrlKey || e.metaKey) {
    // A trackpad's pinch (or Ctrl+wheel): out (positive) shows more time.
    return { kind: 'zoom', factor: Math.exp(capped(dy || dx) * 0.005) };
  }
  if (e.altKey) return { kind: 'channels', rows: main / 40 };
  if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
    return { kind: 'time', seconds: (main / Math.max(1, g.plotW)) * g.durationS };
  }
  // The wheel alone: up (negative) gives larger traces, one notch as much as one press of +.
  return { kind: 'amplitude', factor: AMPLITUDE_STEP ** (-capped(dy) / 100) };
}

/**
 * The view after the time shown is multiplied by `factor` around the moment at `x` (pixels in the
 * plot): {startS, durationS}, which EegViewer.setView keeps within the recording.
 */
export function zoomAround(view, factor, x, g) {
  const frac = Math.max(0, Math.min(1, (x - g.x0) / Math.max(1, g.plotW)));
  const t = view.startS + frac * view.durationS;
  const durationS = Math.min(g.durationTotal, Math.max(Math.min(0.5, g.durationTotal), view.durationS * factor));
  return { startS: t - frac * durationS, durationS };
}

/** The toolbar's choices of time scale: TIME_SCALES within the recording, with the time shown now when it is another. */
export function timeScaleChoices(current, durationTotal) {
  const list = TIME_SCALES.filter((s) => s < durationTotal - 1e-9);
  if (durationTotal <= TIME_SCALES[TIME_SCALES.length - 1] + 1e-9) list.push(durationTotal); // a short recording: all of it
  else list.push(TIME_SCALES[TIME_SCALES.length - 1]);
  if (!list.some((s) => Math.abs(s - current) < 1e-3)) list.push(current);
  return [...new Set(list.map((s) => Math.round(s * 1000) / 1000))].sort((a, b) => a - b);
}

/** "10 s", "2.5 s", "1:30" for a time scale. */
export function timeScaleText(s) {
  if (s >= 120) return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  return `${+s.toFixed(s < 10 ? 2 : 1)} s`;
}

/**
 * The edge of an annotation spanning pixels [xa, xb] at pixel x: 'start', 'end' or null. Inside the
 * annotation an edge is taken within `edge` pixels; outside it only within `outside` pixels (a third of
 * that by default: 2 pixels for the mouse), so that a new mark started just after another (across a
 * brief gap) is drawn as a new mark rather than stretching the one before it over the gap. A finger
 * keeps more of its reach outside (the viewer passes three quarters), since it cannot point so finely.
 */
export function edgeAt(x, xa, xb, edge, outside = null) {
  const out = outside === null ? Math.max(1, Math.round(edge / 3)) : outside;
  const inside = Math.min(edge, Math.max(1, (xb - xa) / 2));
  if (x >= xa - out && x <= xa + inside) return 'start';
  if (x >= xb - inside && x <= xb + out) return 'end';
  return null;
}

/** The step of the fine adjustment of a mark's edge (Alt with the arrow keys): 10 ms, and at least one sample. */
export function nudgeSamples(sfreq) {
  return Math.max(1, Math.round(0.01 * sfreq));
}
