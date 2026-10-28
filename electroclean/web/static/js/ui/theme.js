// The colours of the application's design system, for drawing on canvas (the EEG viewer, the
// practice review). app.css defines the same values as CSS custom properties; the canvas keeps a
// white plot for the traces, inside the warm off-white page.

export const COLOURS = Object.freeze({
  window: '#FDFCFB', // the page
  surface: '#FFFFFF',
  surface_alt: '#F3EFE8',
  hover: '#F1EDE6',
  pressed: '#E8E3DA',
  border: '#8C8984',
  separator: '#E4E0DA', // the hairline
  text: '#1E1E1E',
  text_secondary: '#64625E',
  text_tertiary: '#6B6863',
  text_disabled: '#A8A5A0',
  accent: '#067843', // the one green
  accent_soft: '#E6F1EA',
  destructive: '#A8321C',
  warning_bg: '#FAEFD7',
  warning_border: '#D9A441',
  warning_text: '#6B4700',
  success: '#067843', // matched annotations in the practice review
  success_bg: '#E6F1EA',
  flag_type: '#6A1B9A',
  selection_channel: '#C2185B',
  event: '#00796B', // original experimental events (teal)
  trace: '#1E1E1E',
  trace_ecg: '#5D4037',
  trace_bad: '#A8A5A0',
  grid: '#EFECE7',
  hatch: '#BDB8B0',
});

// Labels, channel names and figures on the canvas are set in the monospaced face, as elsewhere.
export const FONT = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
