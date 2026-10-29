// The colours of the application's design system, for drawing on canvas (the EEG viewer, the
// practice review). app.css defines the same values as CSS custom properties; the canvas keeps a
// white plot for the traces, inside the warm off-white page.

export const COLOURS = Object.freeze({
  window: '#FDFCFB', // the page
  surface: '#FFFFFF',
  surface_alt: '#F3EFE8',
  hover: '#F4F1EC',
  pressed: '#EAE6DF',
  border: '#8C8A86',
  separator: '#E6E3DF', // the hairline
  text: '#242422',
  text_secondary: '#63615D',
  text_tertiary: '#6B6965',
  text_disabled: '#A8A6A2',
  accent: '#2B4392', // the one accent: ink blue
  accent_soft: '#E9EDF7',
  destructive: '#A8321C',
  warning_bg: '#FAEFD7',
  warning_border: '#D9A441',
  warning_text: '#6B4700',
  success: '#2B4392', // matched annotations in the practice review
  success_bg: '#E9EDF7',
  flag_type: '#6A1B9A',
  selection_channel: '#C2185B',
  event: '#00796B', // original experimental events (teal)
  trace: '#1E1E1E',
  trace_ecg: '#5D4037',
  trace_bad: '#A8A6A2',
  grid: '#EFECE7',
  hatch: '#BDB8B0',
  // channels coloured by group (js/viewer/channel_colours.js): dark enough for 1-pixel traces
  group_blue: '#4360E6',
  group_green: '#4A7D23',
  group_violet: '#74209C',
  group_mauve: '#90609A',
});

// Labels, channel names and figures on the canvas are set in the application's one typeface.
export const FONT = '"Newsreader", "Iowan Old Style", "Palatino Linotype", Georgia, serif';
