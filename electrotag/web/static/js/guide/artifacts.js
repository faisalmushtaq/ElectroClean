// What the artifact reference guide (guide.js) says of each type of the catalogue, beside the
// HED-SCORE description the catalogue gives (electrotag/config/artifact_labels.json): where it shows
// on the scalp, its frequency, its shape and typical duration, how to tell it from the types it is
// most often confused with, and the simulated example it shows. The words are standard descriptions
// of EEG artifacts, kept general on purpose: the catalogue's description is the definition, and a
// study's own examples (Meet the artifacts, on the training path) show its real recordings.
//
// web_tests/unit/ui_guide.test.mjs checks that every type of the catalogue is here and nothing else,
// that each look-alike named is a type of the catalogue, and that each example draws its artifact.

import { local } from '../util.js';
import './shapes.js'; // the simulation of the types only the guide's examples draw

/** This browser's note of the keys 1 to 9 of the person's study, and of the type to show first, for the guide in a new tab. */
export const GUIDE_KEYS = 'electrotag.guide.keys';
export const GUIDE_FOCUS = 'electrotag.guide.focus';

/** Note the study's keys (and a type to show first) for the guide about to open in a new tab (an <a target="_blank">). */
export function noteForGuideTab(keys, focus = null) {
  if (Array.isArray(keys)) local.set(GUIDE_KEYS, keys);
  if (focus) local.set(GUIDE_FOCUS, focus); else local.remove(GUIDE_FOCUS);
}

/** The channels of every example: the 10-20 positions most artifacts show on, the EOG and the ECG. */
export const GUIDE_CHANNELS = Object.freeze(['Fp1', 'Fp2', 'F7', 'F3', 'Fz', 'F4', 'F8', 'T7', 'C3', 'Cz', 'C4', 'T8', 'P3', 'P4', 'O1', 'O2',
  'HEOG', 'VEOG', 'ECG']);

const BLINK = ['Fp1', 'Fp2', 'VEOG'];
const SIDES = ['F7', 'F8', 'HEOG'];

/**
 * label -> { where, frequency, shape, duration, apart: [[label, how]], example: [onset_s, duration_s,
 * channels] in a 10 s simulated stretch, or null when the sandbox has no simulation of the type }.
 */
export const GUIDE = Object.freeze({
  'Eye-blink-artifact': {
    where: 'Frontal: largest at Fp1 and Fp2 and on the vertical EOG, symmetrical, falling off quickly towards F3, Fz and F4.',
    frequency: 'A single slow wave.',
    shape: 'A smooth, rounded deflection of high amplitude, often well over 100 µV at Fp1 and Fp2.',
    duration: 'About 0.2 to 0.4 s; blinks often come one after another.',
    apart: [
      ['Vertical-eye-movement-artifact', 'lasts as long as the eyes stay up or down, with a plateau, where a blink rises and falls at once.'],
      ['Electrode-pops-artifact', 'shows on one electrode only and rises steeply, where a blink shows on both Fp1 and Fp2 and on the vertical EOG.'],
    ],
    example: [3.0, 0.4, BLINK],
  },
  'Horizontal-eye-movement-artifact': {
    where: 'At the outer corners of the eyes: F7 and F8 and the horizontal EOG, with opposite polarity on the two sides; smaller at Fp1, Fp2, T7 and T8.',
    frequency: 'Slow: a change of level that is held.',
    shape: 'Box-like: a quick change as the eyes move, a plateau while the gaze is held, and a quick change back.',
    duration: 'As long as the gaze is held to one side, from a fraction of a second to a few seconds.',
    apart: [
      ['Slow-eye-movement-artifact', 'rolls slowly and smoothly over several seconds, without the quick changes of a look to the side.'],
      ['Nystagmus-artifact', 'repeats, beat after beat, where a look to the side is one movement.'],
      ['Vertical-eye-movement-artifact', 'has the same polarity on both sides, largest at Fp1 and Fp2.'],
    ],
    example: [3.0, 1.2, SIDES],
  },
  'Vertical-eye-movement-artifact': {
    where: 'Frontal and symmetrical: largest at Fp1 and Fp2 and on the vertical EOG, smaller at F3, Fz and F4, with the same polarity on both sides.',
    frequency: 'Slow: a change of level that is held.',
    shape: 'A step: the level changes as the eyes look up or down, stays while the gaze is held, and returns as they look back.',
    duration: 'As long as the gaze is held, from a fraction of a second to a few seconds.',
    apart: [
      ['Eye-blink-artifact', 'is brief (about 0.2 to 0.4 s) and rises and falls at once, without a plateau.'],
      ['Horizontal-eye-movement-artifact', 'has opposite polarity at F7 and F8.'],
    ],
    example: [3.0, 1.2, ['Fp1', 'Fp2', 'VEOG']],
  },
  'Slow-eye-movement-artifact': {
    where: 'F7 and F8 and the horizontal EOG, with opposite polarity on the two sides, as for other horizontal eye movements.',
    frequency: 'Very slow: each roll of the eyes takes seconds.',
    shape: 'Smooth, rounded, rolling waves without sharp changes.',
    duration: 'Several seconds; seen as a person becomes drowsy.',
    apart: [
      ['Horizontal-eye-movement-artifact', 'changes quickly and holds a plateau, where slow eye movements roll smoothly.'],
      ['Sweat-artifact', 'has no opposite polarity at F7 and F8, and drifts more irregularly.'],
    ],
    example: [2.5, 4.0, SIDES],
  },
  'Nystagmus-artifact': {
    where: 'Most often horizontal: F7 and F8 and the horizontal EOG, with opposite polarity on the two sides.',
    frequency: 'Rhythmic, a few beats a second.',
    shape: 'Repeated beats; in the common form a slow drift one way and a quick return, so that the trace looks like a saw\'s teeth.',
    duration: 'As long as the nystagmus lasts, from seconds to the whole recording.',
    apart: [
      ['Horizontal-eye-movement-artifact', 'is one movement with a plateau.'],
    ],
    example: [3.0, 3.0, SIDES],
  },
  'Eye-movement-artifact': {
    where: 'The group term: an eye movement whose exact kind (horizontal, vertical, slow, nystagmus) is unclear.',
    frequency: '', shape: '', duration: '',
    apart: [['Eye-artifact', 'is wider still: any artifact from the eyes, a blink included.']],
    example: null,
  },
  'Eye-artifact': {
    where: 'The group term: an artifact clearly from the eyes when it is unclear whether it is a blink or a movement.',
    frequency: '', shape: '', duration: '',
    apart: [['Eye-movement-artifact', 'is for an eye movement of unclear kind.']],
    example: null,
  },
  'EMG-artifact': {
    where: 'Over muscles: most often temporal (T7, T8) and frontal, from the jaw and forehead; also posterior, from the neck.',
    frequency: 'Fast: mostly above 20 to 30 Hz, many frequencies at once.',
    shape: 'Dense, irregular, spiky activity that thickens the trace, in bursts or sustained.',
    duration: 'From brief bursts to as long as the muscle stays tense.',
    apart: [
      ['Line-noise-artifact', 'is one fixed frequency (50 or 60 Hz), perfectly regular, where muscle activity is irregular.'],
      ['Chewing-artifact', 'comes in rhythmic bursts, about once or twice a second, with each movement of the jaw.'],
    ],
    example: [3.0, 2.0, ['F7', 'F8', 'T7', 'T8']],
  },
  'Chewing-artifact': {
    where: 'Temporal, on both sides (T7, T8), over the jaw muscles.',
    frequency: 'Bursts of fast muscle activity, repeating with each movement of the jaw (about once or twice a second).',
    shape: 'Rhythmic bursts of spiky muscle activity with quieter EEG between them.',
    duration: 'As long as the chewing, usually a few seconds.',
    apart: [
      ['EMG-artifact', 'from tense muscles is sustained or irregular rather than in regular bursts.'],
      ['Tongue-movement-artifact', 'is slow, in the delta range, without the fast spikes of muscle.'],
    ],
    example: [3.0, 3.0, ['T7', 'T8']],
  },
  'Tongue-movement-artifact': {
    where: 'Broad: largest frontally and inferiorly, falling off towards the back of the head more gently than eye movements do.',
    frequency: 'Slow, usually in the delta range.',
    shape: 'Irregular slow waves over many channels at once, often while the person speaks or swallows.',
    duration: 'As long as the tongue moves, often a few seconds.',
    apart: [
      ['Vertical-eye-movement-artifact', 'falls off steeply away from Fp1 and Fp2, and shows on the vertical EOG.'],
      ['Chewing-artifact', 'is fast muscle activity in bursts.'],
    ],
    example: [3.0, 3.0, []],
  },
  'Movement-artifact': {
    where: 'Often many channels at once, as the head, body or cables move.',
    frequency: 'Mixed: large slow swings with fast components.',
    shape: 'Large and irregular, sometimes beyond the range of the amplifier.',
    duration: 'As long as the movement, usually a second or a few.',
    apart: [
      ['Electrode-movement-artifact', 'shows on one or a few electrodes only.'],
      ['EMG-artifact', 'from tensing muscles is fast activity without the large slow swings.'],
    ],
    example: [3.0, 2.0, []],
  },
  'ECG-artifact': {
    where: 'Often on the left and towards the back or the sides of the head, and on the ECG channel; it depends on the reference.',
    frequency: 'Regular, at the heart rate (about once a second).',
    shape: 'Brief sharp spikes, each at the same moment as the QRS complex on the ECG channel.',
    duration: 'Each spike lasts under 0.1 s; the artifact goes on for as long as it is visible.',
    apart: [
      ['Pulse-artifact', 'is a slow wave on one electrode that comes a fraction of a second after each QRS.'],
      ['Electrode-pops-artifact', 'comes on one electrode at irregular moments, unrelated to the heartbeat.'],
    ],
    example: [1.0, 8.0, ['T7', 'P3', 'O1']],
  },
  'Pulse-artifact': {
    where: 'One electrode, or a few, lying over a pulsating blood vessel of the scalp.',
    frequency: 'Regular, at the heart rate.',
    shape: 'Slow, rounded waves, each a fraction of a second after the QRS complex on the ECG channel.',
    duration: 'Each wave lasts a few tenths of a second; the artifact continues while the electrode stays in place.',
    apart: [
      ['ECG-artifact', 'is a sharp spike at the very moment of the QRS, often on several channels.'],
    ],
    example: [1.0, 8.0, ['F8']],
  },
  'Respiration-artifact': {
    where: 'Varies: often electrodes the head rests on, or that move with breathing.',
    frequency: 'Very slow and regular, with each breath (about 10 to 20 breaths a minute).',
    shape: 'Slow waves or swings of the baseline in time with breathing.',
    duration: 'Seconds per breath, repeating while it lasts.',
    apart: [
      ['Sweat-artifact', 'drifts irregularly, not in time with each breath.'],
      ['Slow-eye-movement-artifact', 'has opposite polarity at F7 and F8.'],
    ],
    example: [0.5, 9.0, ['O1', 'O2']],
  },
  'Sweat-artifact': {
    where: 'Often frontal and temporal, over several channels.',
    frequency: 'Very slow: each undulation usually takes more than 2 seconds.',
    shape: 'A low, undulating swing of the baseline, which looks unstable.',
    duration: 'Many seconds, often long stretches of a recording.',
    apart: [
      ['Respiration-artifact', 'keeps time with breathing.'],
      ['Slow-eye-movement-artifact', 'has opposite polarity at F7 and F8 and is seen with drowsiness.'],
    ],
    example: [0.5, 9.0, ['Fp1', 'Fp2', 'F7', 'F3', 'Fz', 'F4', 'F8', 'T7', 'T8']],
  },
  'Rocking-patting-artifact': {
    where: 'Varies with how the infant is held; often many channels.',
    frequency: 'Quasi-rhythmic, at the pace of the rocking or patting.',
    shape: 'Repeated waves in time with the caregiver\'s movement.',
    duration: 'As long as the rocking or patting.',
    apart: [['Respiration-artifact', 'keeps time with breathing, not with a caregiver\'s movement.']],
    example: null,
  },
  'Sucking-artifact': {
    where: 'Varies; seen in very young infants.',
    frequency: 'Rhythmic, at the pace of sucking.',
    shape: 'Repeated bursts or waves with each suck.',
    duration: 'As long as the sucking.',
    apart: [['Chewing-artifact', 'is the jaw\'s chewing movement, mostly in older children and adults.']],
    example: null,
  },
  'Biological-artifact': {
    where: 'The group term: an artifact from the body when its exact source is unclear.',
    frequency: '', shape: '', duration: '',
    apart: [['Nonbiological-artifact', 'is for artifacts from equipment, electrodes or the surroundings.']],
    example: null,
  },
  'Electrode-movement-artifact': {
    where: 'One electrode or a few, the ones that moved.',
    frequency: 'Irregular; mostly slow.',
    shape: 'Irregular shifts of the baseline, sometimes sharp, when an electrode or its lead is moved or touched.',
    duration: 'As long as the electrode moves.',
    apart: [
      ['Electrode-pops-artifact', 'is a steep rise with a slower fall, which may come back on the same electrode.'],
      ['Movement-artifact', 'shows on many channels at once.'],
    ],
    example: [3.0, 2.5, ['T8']],
  },
  'Electrode-pops-artifact': {
    where: 'One electrode only, most often one that is loose.',
    frequency: 'Single events, at irregular moments.',
    shape: 'A steep rise followed by a slower fall; the neighbouring electrodes stay unaffected.',
    duration: 'Under a second; it may come back on the same electrode.',
    apart: [
      ['Eye-blink-artifact', 'shows on Fp1 and Fp2 together and on the vertical EOG.'],
      ['ECG-artifact', 'repeats regularly at the heart rate.'],
    ],
    example: [3.0, 0.5, ['C3']],
  },
  'Salt-bridge-artifact': {
    where: 'Two neighbouring electrodes joined by gel, paste or sweat.',
    frequency: 'Any: the two channels simply become alike.',
    shape: 'The two channels look almost identical; a derivation between them is very low or flat.',
    duration: 'Usually lasting, often the whole recording once it starts.',
    apart: [['Electrode-pops-artifact', 'is brief, on one electrode.']],
    example: null,
  },
  'Localized-channel-artifact': {
    where: 'The group term: a transient artifact on one channel or a few, when its exact kind is unclear.',
    frequency: '', shape: '', duration: '',
    apart: [['Electrode-pops-artifact', 'is the most common specific kind.']],
    example: null,
  },
  'Induction-artifact': {
    where: 'Varies with where the equipment is; often several channels.',
    frequency: 'Usually high frequency.',
    shape: 'Fast activity induced by nearby electrical equipment.',
    duration: 'As long as the equipment runs near the recording.',
    apart: [
      ['Line-noise-artifact', 'is exactly the mains frequency, 50 or 60 Hz.'],
      ['EMG-artifact', 'comes from muscles and changes with the person\'s tension.'],
    ],
    example: null,
  },
  'Line-noise-artifact': {
    where: 'Often all channels, or the channels whose electrodes have a poor contact.',
    frequency: 'Exactly the mains frequency: 50 Hz (60 Hz in the Americas and some other countries).',
    shape: 'A perfectly regular fast sine wave that thickens the trace evenly.',
    duration: 'Often long stretches, or the whole recording.',
    apart: [['EMG-artifact', 'is irregular and made of many frequencies.']],
    example: [3.0, 3.0, []],
  },
  'Electrical-artifact': {
    where: 'The group term: contamination by extraneous electrical signals when its exact kind is unclear.',
    frequency: '', shape: '', duration: '',
    apart: [['Line-noise-artifact', 'is the specific kind at 50 or 60 Hz.']],
    example: null,
  },
  'Artificial-ventilation-artifact': {
    where: 'Varies; seen in people on a mechanical ventilator.',
    frequency: 'Often at the rate of the ventilator.',
    shape: 'Repeated waves with the ventilator\'s cycle, though other patterns occur.',
    duration: 'As long as the ventilation.',
    apart: [['Respiration-artifact', 'keeps time with the person\'s own breathing.']],
    example: null,
  },
  'Dialysis-artifact': {
    where: 'Varies; seen in recordings during continuous renal replacement therapy (dialysis).',
    frequency: 'Varies with the equipment.',
    shape: 'Varies with the equipment.',
    duration: 'As long as the treatment runs.',
    apart: [['Induction-artifact', 'comes from other nearby equipment.']],
    example: null,
  },
  'Nonbiological-artifact': {
    where: 'The group term: an artifact from a non-biological source when its exact kind is unclear.',
    frequency: '', shape: '', duration: '',
    apart: [['Biological-artifact', 'is for artifacts from the body.']],
    example: null,
  },
  'Data-artifact': {
    where: 'The most general term: something that is clearly an artifact, of a type that cannot be told at all.',
    frequency: '', shape: '', duration: '',
    apart: [['Biological-artifact', 'and Nonbiological-artifact are narrower, when at least the kind of source is clear.']],
    example: null,
  },
});

/** The simulated recording of a type's example (js/eeg/synthetic.js): 10 s at 250 Hz with the artifact, or null. */
export function exampleSpec(label, value = 0) {
  const g = GUIDE[label];
  if (!g || !g.example) return null;
  const [onsetS, durationS, channels] = g.example;
  return { id: `guide-${value}`, stem: `sub-guide${value}_task-example`, sfreq: 250, durationS: 10, seed: 101 + (value % 97),
    channels: [...GUIDE_CHANNELS], events: [], artifacts: [[label, onsetS, durationS, [...channels]]] };
}

/** True when the words typed are all in what the guide says of a type (its names, codes and text). */
export function guideMatches(l, text) {
  const g = GUIDE[l.label] || {};
  const hay = [l.label, l.short_code, l.value, l.section, l.description, g.where, g.frequency, g.shape, g.duration,
    ...(g.apart || []).flat()].join(' ').toLowerCase().replace(/-/g, ' ');
  return String(text || '').toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}
