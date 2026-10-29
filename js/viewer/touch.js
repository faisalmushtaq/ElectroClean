// Touch on the EEG (iPad and other touch screens), as plain functions that the viewer calls and the
// unit tests check. One finger or a pencil works as the mouse does (drag to mark, tap to select);
// two fingers move the view: sideways through time, up and down through the channels, and a pinch
// sideways shows more or less time, keeping the moment between the fingers where it is.

/** Below this horizontal spread (pixels) two fingers only move the view: a pinch needs room. */
export const MIN_PINCH_SPAN = 48;
/** A spread that changes by less than this (pixels) is a move, not a pinch: moving keeps the time shown. */
export const PINCH_DEAD_PX = 8;
/** A press held this long without moving (ms) is a long press: the annotation's menu. */
export const LONG_PRESS_MS = 550;
/** A finger that moves less than this (pixels) is still a tap or a press. */
export const TAP_SLOP_PX = 10;
/** Two taps this close in time (ms) and place (pixels) are a double tap. */
export const DOUBLE_TAP_MS = 350;
export const DOUBLE_TAP_PX = 24;
/** The hit area of an annotation's edge for a finger and for a pencil (the mouse uses 6 pixels). */
export const EDGE_PX_TOUCH = 16;
export const EDGE_PX_PEN = 10;

/** The centre and horizontal spread of two touches ({x, y} in the plot's coordinates). */
export function twoFingers(a, b) {
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, spanX: Math.abs(a.x - b.x) };
}

/**
 * The view while two fingers move. start: { cx, cy, spanX, view: { startS, durationS, firstChannel },
 * tAtC } when the second finger touched (tAtC is the time under the centre then); now: { cx, cy,
 * spanX }; g: { x0, plotW, rowH, durationTotal }. Returns { startS, durationS, firstChannel }, which
 * EegViewer.setView keeps within the recording.
 */
export function pinchView(start, now, g) {
  const pinching = start.spanX >= MIN_PINCH_SPAN && now.spanX >= MIN_PINCH_SPAN && Math.abs(now.spanX - start.spanX) >= PINCH_DEAD_PX;
  const lo = Math.min(0.5, g.durationTotal);
  const durationS = Math.min(g.durationTotal, Math.max(lo, start.view.durationS * (pinching ? start.spanX / now.spanX : 1)));
  const startS = start.tAtC - ((now.cx - g.x0) / g.plotW) * durationS;
  const firstChannel = start.view.firstChannel - Math.round((now.cy - start.cy) / Math.max(1, g.rowH));
  return { startS, durationS, firstChannel };
}

/** Whether a tap ({x, y, t}) follows the previous one closely enough to make a double tap. */
export function isDoubleTap(prev, tap) {
  return Boolean(prev) && tap.t - prev.t <= DOUBLE_TAP_MS && Math.hypot(tap.x - prev.x, tap.y - prev.y) <= DOUBLE_TAP_PX;
}

/** The edge hit area for a pointer type ('mouse', 'touch' or 'pen'). */
export function edgePx(pointerType, mousePx) {
  return pointerType === 'touch' ? EDGE_PX_TOUCH : pointerType === 'pen' ? EDGE_PX_PEN : mousePx;
}
