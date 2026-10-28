// The colours of the application's design system, for drawing on canvas (the EEG viewer, the
// practice review). app.css defines the same values as CSS custom properties; the canvas keeps a
// white plot for the traces, inside the paper-coloured page.

export const COLOURS = Object.freeze({
  window: '#F7F7F5', // paper
  surface: '#FFFFFF',
  surface_alt: '#EFEFEC',
  hover: '#EAEAE6',
  pressed: '#DEDED9',
  border: '#8A8A84',
  separator: '#D3D3D0', // the hairline
  text: '#171715',
  text_secondary: '#4F4F4A',
  text_tertiary: '#66665F',
  text_disabled: '#9A9A94',
  accent: '#1A3C2B', // forest
  accent_soft: '#E4E9E5',
  destructive: '#A8321C',
  warning_bg: '#FBF1C9',
  warning_border: '#F4D35E',
  warning_text: '#5C4500',
  success: '#1F7A4D', // matched annotations in the practice review: a mid green that reads as a fill
  success_bg: '#E3F9EA',
  flag_type: '#6A1B9A',
  selection_channel: '#C2185B',
  event: '#00796B', // original experimental events (teal)
  trace: '#171715',
  trace_ecg: '#5D4037',
  trace_bad: '#A1A19B',
  grid: '#EDEDE9',
  hatch: '#B9B9B3',
});

// Labels, channel names and figures on the canvas are set in the monospaced face, as elsewhere.
export const FONT = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
