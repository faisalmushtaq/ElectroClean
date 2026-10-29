// Channels coloured by group (js/viewer/channel_colours.js): which group each channel joins, and the
// palette's rules. Every colour reaches 4.5:1 on the white of the EEG (1-pixel traces), none is
// grey, red, orange-red, pink or teal, none can be taken for the selected channels, the bad
// channels, the experimental events or a warning, and the colours that sit side by side (touching
// regions, the two sides, the types) stay apart under simulated red-green colour blindness
// (Machado, Oliveira and Fernandes 2009, severity 1, distances in OKLab x 100, as the palette
// checks of the design work use: at least 8 under simulation and 15 with full colour vision).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, '..', '..', 'electrotag', 'web', 'static');
const { CHANNEL_COLOUR_MODES, GROUP_COLOURS, GROUPS, REGION_NEIGHBOURS, channelColours, legendOf, groupOf, normaliseMode } =
  await import('../../electrotag/web/static/js/viewer/channel_colours.js');
const { COLOURS } = await import('../../electrotag/web/static/js/ui/theme.js');
const { contrast, hexToRgb } = await import('../../electrotag/web/static/js/util.js');
const { DEMO_CHANNELS, channelType } = await import('../../electrotag/web/static/js/data/synthetic.js');

// ---------------------------------------------------------------- colour science
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const enc = (c) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
function oklab(rgb) {
  const [r, g, b] = rgb.map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
};
const simulate = (hex, kind) => {
  const v = hexToRgb(hex).map(lin);
  return MACHADO[kind].map((row) => enc(Math.min(1, Math.max(0, row[0] * v[0] + row[1] * v[1] + row[2] * v[2]))));
};
const dist = (a, b) => Math.hypot(...a.map((x, i) => (x - b[i]) * 100));
const normal = (a, b) => dist(oklab(hexToRgb(a)), oklab(hexToRgb(b)));
const cvd = (a, b) => Math.min(...['protan', 'deutan'].map((k) => dist(oklab(simulate(a, k)), oklab(simulate(b, k)))));
const chroma = (hex) => { const [, a, b] = oklab(hexToRgb(hex)); return Math.hypot(a, b); };
const hue = (hex) => { const [, a, b] = oklab(hexToRgb(hex)); return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360; };
const colourOf = (mode, group) => GROUP_COLOURS[GROUPS[mode].find(([g]) => g === group)[1]];

// ------------------------------------------------------------------- the palette
test('the group colours are the style sheet\'s and the canvas\'s', () => {
  const css = fs.readFileSync(path.join(STATIC, 'app.css'), 'utf8');
  for (const [name, hex] of Object.entries(GROUP_COLOURS)) {
    assert.equal(COLOURS[`group_${name}`], hex);
    const m = css.match(new RegExp(`--group-${name}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(m, `--group-${name} in app.css`);
    assert.equal(m[1].toUpperCase(), hex.toUpperCase());
  }
});

test('every group colour is dark enough for 1-pixel traces and channel names on white', () => {
  for (const hex of Object.values(GROUP_COLOURS)) assert.ok(contrast(hex, '#FFFFFF') >= 4.5, `${hex}: ${contrast(hex, '#FFFFFF').toFixed(2)}:1`);
});

test('no group colour is grey, red, orange-red, pink or magenta', () => {
  for (const hex of Object.values(GROUP_COLOURS)) {
    assert.ok(chroma(hex) >= 0.1, `${hex} would read as grey (chroma ${chroma(hex).toFixed(3)})`);
    const h = hue(hex);
    assert.ok(!(h >= 340 || h <= 55), `${hex} has the hue of an alarm or of pink (${h.toFixed(0)} degrees)`);
  }
});

test('no group colour can be taken for the selected or bad channels, the events, the accent or a warning', () => {
  // The events are dashed vertical lines with their codes, never traces: a green is told from their teal by hue.
  for (const hex of Object.values(GROUP_COLOURS)) {
    const apart = Math.abs(hue(hex) - hue(COLOURS.event));
    assert.ok(normal(hex, COLOURS.event) >= 9 && Math.min(apart, 360 - apart) >= 30, `${hex} is too close to the events' teal`);
  }
  // The ink-blue accent marks links and a channel name under the pointer, never a trace: 12 is enough.
  for (const hex of Object.values(GROUP_COLOURS)) assert.ok(normal(hex, COLOURS.accent) >= 12, `${hex} is too close to the accent`);
  const reserved = { selected: COLOURS.selection_channel, bad: COLOURS.trace_bad,
    destructive: COLOURS.destructive, warning: COLOURS.warning_border, warning_text: COLOURS.warning_text, ink: COLOURS.trace };
  for (const hex of Object.values(GROUP_COLOURS)) {
    for (const [what, r] of Object.entries(reserved)) {
      assert.ok(normal(hex, r) >= 15, `${hex} is too close to the ${what} colour ${r} (${normal(hex, r).toFixed(1)})`);
    }
  }
});

test('colours side by side stay apart with full colour vision and with red-green colour blindness', () => {
  const pairs = [
    ...REGION_NEIGHBOURS.map(([a, b]) => [`region ${a}/${b}`, colourOf('region', a), colourOf('region', b)]),
    ['side Left/Right', colourOf('side', 'Left'), colourOf('side', 'Right')],
  ];
  const types = GROUPS.type.map(([g]) => g);
  for (let i = 0; i < types.length; i++) for (let j = i + 1; j < types.length; j++) pairs.push([`type ${types[i]}/${types[j]}`, colourOf('type', types[i]), colourOf('type', types[j])]);
  // and every coloured group against the ink of the uncoloured channels next to it
  for (const hex of Object.values(GROUP_COLOURS)) pairs.push([`${hex}/ink`, hex, COLOURS.trace]);
  for (const [what, a, b] of pairs) {
    assert.notEqual(a, b, what);
    assert.ok(normal(a, b) >= 15, `${what}: ${normal(a, b).toFixed(1)} with full colour vision`);
    assert.ok(cvd(a, b) >= 8, `${what}: ${cvd(a, b).toFixed(1)} under simulated protanopia or deuteranopia`);
  }
  // the four colours differ from one another for everyone, red-green colour blind or not; regions
  // share a colour only when they do not touch (frontal and occipital)
  const all = Object.values(GROUP_COLOURS);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(normal(all[i], all[j]) >= 15 && cvd(all[i], all[j]) >= 8);
  const touching = new Set(REGION_NEIGHBOURS.map((p) => p.join('/')));
  const regions = GROUPS.region.map(([g]) => g);
  for (const a of regions) for (const b of regions) {
    if (a < b && colourOf('region', a) === colourOf('region', b)) assert.ok(!touching.has(`${a}/${b}`) && !touching.has(`${b}/${a}`), `${a} and ${b} touch`);
  }
  assert.equal(colourOf('region', 'Frontal'), colourOf('region', 'Occipital'));
});

// ---------------------------------------------------------------- the groups
const demo = () => DEMO_CHANNELS.map((name) => ({ name, type: channelType(name) }));

test('the modes are those of the study setting, and anything else is off', () => {
  assert.deepEqual(CHANNEL_COLOUR_MODES, ['off', 'region', 'side', 'type']);
  for (const m of CHANNEL_COLOUR_MODES) assert.equal(normaliseMode(m), m);
  for (const m of [null, undefined, '', 'Region', 'hemisphere']) assert.equal(normaliseMode(m), 'off');
  assert.equal(channelColours(demo(), 'off').size, 0);
  assert.deepEqual(legendOf(demo(), 'off'), []);
});

test('by region: 10-20 names by their letters, EDF spellings too, everything else in ink', () => {
  const chs = [{ name: 'Fp1', type: 'eeg' }, { name: 'EEG F3-REF', type: 'eeg' }, { name: 'FC1', type: 'eeg' }, { name: 'T7', type: 'eeg' },
    { name: 'P4', type: 'eeg' }, { name: 'O2', type: 'eeg' }, { name: 'A12', type: 'eeg' }, { name: 'VEOG', type: 'eog' }];
  assert.deepEqual(chs.map((c) => groupOf(c, 'region')), ['Frontal', 'Frontal', 'Central', 'Temporal', 'Parietal', 'Occipital', 'Other', 'Other']);
  const map = channelColours(chs, 'region');
  assert.equal(map.get('Fp1'), GROUP_COLOURS.blue);
  assert.equal(map.get('T7'), GROUP_COLOURS.violet);
  assert.ok(!map.has('A12') && !map.has('VEOG'), 'channels outside the groups keep the ink colour');
  const legend = legendOf(chs, 'region');
  assert.deepEqual(legend.map((l) => [l.group, l.count, l.ink]),
    [['Frontal', 2, false], ['Central', 1, false], ['Temporal', 1, false], ['Parietal', 1, false], ['Occipital', 1, false], ['Other', 2, true]]);
  assert.equal(legend[legend.length - 1].colour, COLOURS.trace);
});

test('by side: odd numbers on the left, even on the right, the midline in ink', () => {
  const map = channelColours(demo(), 'side');
  assert.equal(map.get('Fp1'), GROUP_COLOURS.blue);
  assert.equal(map.get('C3'), GROUP_COLOURS.blue);
  assert.equal(map.get('Fp2'), GROUP_COLOURS.green);
  assert.equal(map.get('O2'), GROUP_COLOURS.green);
  assert.ok(!map.has('Cz') && !map.has('Fz') && !map.has('HEOG'));
  assert.deepEqual(legendOf(demo(), 'side').map((l) => l.group), ['Left', 'Right', 'Midline', 'Other']);
});

test('by type: EEG in ink, the other types coloured', () => {
  const chs = [{ name: 'Fp1', type: 'eeg' }, { name: 'HEOG', type: 'eog' }, { name: 'ECG', type: 'ecg' }, { name: 'EMG1', type: 'emg' },
    { name: 'EXG8', type: 'misc' }, { name: 'Status', type: 'stim' }];
  const map = channelColours(chs, 'type');
  assert.ok(!map.has('Fp1'));
  assert.equal(map.get('HEOG'), GROUP_COLOURS.blue);
  assert.equal(map.get('ECG'), GROUP_COLOURS.green);
  assert.equal(map.get('EMG1'), GROUP_COLOURS.violet);
  assert.equal(map.get('EXG8'), GROUP_COLOURS.mauve);
  assert.equal(map.get('Status'), GROUP_COLOURS.mauve);
  assert.deepEqual(legendOf(chs, 'type').map((l) => [l.group, l.count]), [['EOG', 1], ['ECG', 1], ['EMG', 1], ['Misc', 2], ['EEG', 1]]);
});

test('a BioSemi montage has no 10-20 names: by region and side it stays in ink', () => {
  const chs = [...'ABCD'].flatMap((b) => Array.from({ length: 32 }, (_, i) => ({ name: `${b}${i + 1}`, type: 'eeg' })));
  assert.equal(channelColours(chs, 'region').size, 0);
  assert.equal(channelColours(chs, 'side').size, 0);
  assert.deepEqual(legendOf(chs, 'region'), [{ group: 'Other', colour: COLOURS.trace, count: 128, ink: true }]);
});
