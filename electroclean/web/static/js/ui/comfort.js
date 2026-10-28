// Display comfort: each annotator's own choices for long sessions (the thickness of the traces, the
// size of the channel names and of the side panel's text), kept in this browser's localStorage. They
// change only how the EEG and the panel look, never what is annotated or recorded as results.

import { local } from '../util.js';

export const TRACE_WIDTHS = Object.freeze({ thin: 'Thin', normal: 'Normal', thick: 'Thick' });
export const NAME_SIZES = Object.freeze({ normal: 'Normal', large: 'Large' });
export const PANEL_TEXT = Object.freeze({ normal: 'Normal', large: 'Larger' });
export const DEFAULT_COMFORT = Object.freeze({ trace: 'normal', names: 'normal', panel: 'normal' });

const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/** The choices with anything unknown replaced by the default. */
export function normaliseComfort(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    trace: has(TRACE_WIDTHS, r.trace) ? r.trace : DEFAULT_COMFORT.trace,
    names: has(NAME_SIZES, r.names) ? r.names : DEFAULT_COMFORT.names,
    panel: has(PANEL_TEXT, r.panel) ? r.panel : DEFAULT_COMFORT.panel,
  };
}

const keyFor = (who) => `electroclean.comfort|${who || 'anon'}`;

/** An annotator's choices (the defaults where none are kept, or storage is not available). */
export function loadComfort(who) {
  return normaliseComfort(local.get(keyFor(who), null));
}

export function saveComfort(who, comfort) {
  return local.set(keyFor(who), normaliseComfort(comfort));
}

/**
 * The thickness of a trace in device pixels, for the pixels of a dense view, and the line width in
 * CSS pixels for a view drawn as lines (`thinRows`: rows too short for full-width lines).
 */
export function traceWidths(trace, dpr = 1, thinRows = false) {
  const d = Math.max(1, dpr || 1);
  const device = trace === 'thin' ? Math.max(1, Math.round(d * 0.5)) : trace === 'thick' ? Math.max(2, Math.round(d * 2)) : Math.max(1, Math.round(d));
  const css = (trace === 'thin' ? 0.6 : trace === 'thick' ? 2 : 1) * (thinRows ? 0.6 : 1);
  return { device, css };
}

/** The size in pixels of the channel names for a row height (whole pixels, never taller than the row allows). */
export function namePx(names, rowH) {
  return names === 'large' ? Math.round(Math.min(15, Math.max(8, rowH * 0.9))) : Math.round(Math.min(12, Math.max(7, rowH * 0.8)));
}
