// Colouring the EEG's channels by group: by region (frontal, central, temporal, parietal,
// occipital), by side (left, midline, right) or by type (EEG, EOG, ECG, EMG, misc), using the
// grouping of the channel chooser (tenTwentyPosition in js/annotate/dialogs.js: odd numbers on the
// left, even on the right, z on the midline, as MNE-Python's make_1020_channel_selections groups
// them). Plain ES module without DOM access, so that Node can test it.
//
// The colours say which group a channel belongs to and nothing else, so they are calm and dark:
// no red or orange (alarm), no pink or magenta (the selected channels), no teal (the experimental
// events), no grey (bad channels keep their grey) and no amber (warnings). Each has at least 4.5:1
// contrast on the white of the EEG, so that a 1-pixel trace stays readable, and the colours of
// neighbouring regions, of the two sides and of the types stay apart for people with red-green
// colour blindness (checked in web_tests/unit/ui_channel_colours.test.mjs). Channels outside the
// groups (the midline, EEG in the type view, names that are not 10-20 or 10-10) keep the ink colour.

import { tenTwentyPosition } from '../annotate/dialogs.js';
import { COLOURS } from '../ui/theme.js';

/** The ways of colouring, as the study setting display.channel_colours names them. */
export const CHANNEL_COLOUR_MODES = Object.freeze(['off', 'region', 'side', 'type']);

/** The group colours (js/ui/theme.js, and app.css as --group-*). */
export const GROUP_COLOURS = Object.freeze({
  blue: COLOURS.group_blue,
  green: COLOURS.group_green,
  violet: COLOURS.group_violet,
  mauve: COLOURS.group_mauve,
});

/** Which colour each group of each mode takes; groups not listed keep the ink colour. */
export const GROUPS = Object.freeze({
  // Four hues are all that stay dark, calm and apart for everyone; regions that touch never share
  // one, and frontal and occipital, at opposite ends of the head, share blue.
  region: Object.freeze([['Frontal', 'blue'], ['Central', 'green'], ['Temporal', 'violet'], ['Parietal', 'mauve'], ['Occipital', 'blue']]),
  side: Object.freeze([['Left', 'blue'], ['Right', 'green']]),
  type: Object.freeze([['EOG', 'blue'], ['ECG', 'green'], ['EMG', 'violet'], ['Misc', 'mauve']]),
});

/** Regions that touch on the scalp, whose colours must never be confused. */
export const REGION_NEIGHBOURS = Object.freeze([
  ['Frontal', 'Central'], ['Frontal', 'Temporal'], ['Central', 'Temporal'], ['Central', 'Parietal'],
  ['Temporal', 'Parietal'], ['Temporal', 'Occipital'], ['Parietal', 'Occipital'],
]);

/** What the uncoloured channels of each mode are called in the legend. */
const INK_GROUP = { region: 'Other', side: 'Midline', type: 'EEG' };
const TYPE_GROUP = { eog: 'EOG', ecg: 'ECG', emg: 'EMG', misc: 'Misc', stim: 'Misc' };

export const MODE_TEXT = Object.freeze({ off: 'None', region: 'Region', side: 'Side', type: 'Type' });

/**
 * Whether a montage is named by the 10-20 or 10-10 system: 60% or more of its EEG channels, the
 * channel chooser's rule (BioSemi's C1 to C32 are a bank of channels, not central sites).
 */
export function namedByTenTwenty(channels) {
  const eeg = channels.filter((c) => ['eeg', ''].includes(String(c.type || '').toLowerCase()));
  const n = eeg.filter((c) => tenTwentyPosition(c.name)).length;
  return eeg.length > 0 && n >= 0.6 * eeg.length;
}

/** A mode as given (a setting, a remembered choice), or 'off' for anything else. */
export function normaliseMode(mode) {
  return CHANNEL_COLOUR_MODES.includes(mode) ? mode : 'off';
}

/**
 * The group of a channel in a mode, or the ink group's name.
 * @param {{name: string, type?: string}} ch
 */
export function groupOf(ch, mode) {
  if (mode === 'type') return TYPE_GROUP[String(ch.type || '').toLowerCase()] || 'EEG';
  const type = String(ch.type || 'eeg').toLowerCase();
  if (type !== 'eeg') return 'Other';
  const pos = tenTwentyPosition(ch.name);
  if (!pos) return 'Other';
  return mode === 'region' ? pos.region : mode === 'side' ? pos.side : 'Other';
}

function colourOfGroup(mode, group) {
  const hit = (GROUPS[mode] || []).find(([g]) => g === group);
  return hit ? GROUP_COLOURS[hit[1]] : null;
}

/**
 * The colour of each coloured channel: Map name -> colour (channels in the ink colour are left
 * out, and so is everything when the mode is 'off'). The viewer draws bad and selected channels
 * as before, whatever this says.
 * @param {{name: string, type?: string}[]} channels
 */
export function channelColours(channels, mode) {
  const out = new Map();
  if (normaliseMode(mode) === 'off') return out;
  const placed = mode === 'type' || namedByTenTwenty(channels);
  for (const ch of channels) {
    const c = placed ? colourOfGroup(mode, groupOf(ch, mode)) : null;
    if (c) out.set(ch.name, c);
  }
  return out;
}

/**
 * The legend of a mode for these channels: the coloured groups present, in a fixed order, then the
 * channels left in ink. [{group, colour, count, ink}]
 */
export function legendOf(channels, mode, ink = COLOURS.trace) {
  if (normaliseMode(mode) === 'off') return [];
  const placed = mode === 'type' || namedByTenTwenty(channels);
  const counts = new Map();
  for (const ch of channels) {
    const g = placed ? groupOf(ch, mode) : 'Other';
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const out = [];
  for (const [g, key] of GROUPS[mode]) if (counts.get(g)) out.push({ group: g, colour: GROUP_COLOURS[key], count: counts.get(g), ink: false });
  for (const [g, n] of counts) if (!colourOfGroup(mode, g)) out.push({ group: g, colour: ink, count: n, ink: true });
  return out;
}
