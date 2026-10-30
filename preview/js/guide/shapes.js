// The simulated artifact types that only the artifact reference guide's examples draw (guide.js),
// added to the sandbox's simulation (js/eeg/synthetic.js registerArtifactShape) when the guide loads,
// so that the sign-in page does not carry them. Each gives volts for one channel at time t; x runs
// from 0 to 1 through the artifact and `on` says whether the channel is one of the artifact's.

import { EYE_MOVEMENT_GAINS_UV, registerArtifactShape } from '../eeg/synthetic.js';

const UV = 1e-6;
const ECG_PERIOD = 0.83; // as the simulation's heartbeat (synthetic.js ecgShape), whose QRS is at 0.20 s of each period

const SHAPES = {
  'Vertical-eye-movement-artifact': ({ name, x }) => {
    const gain = { VEOG: 170, Fp1: 95, Fp2: 95, F3: 30, Fz: 35, F4: 30, F7: 25, F8: 25 }[name] || 0;
    return gain * UV * Math.min(1, x * 8, (1 - x) * 8);
  },
  // jerk nystagmus: a slow drift and a quick return, three beats a second
  'Nystagmus-artifact': ({ art, name, t, x }) => {
    const gain = (EYE_MOVEMENT_GAINS_UV[name] || 0) * 0.6;
    const p = ((t - art.onsetS) * 3) % 1;
    return gain * UV * (p < 0.8 ? p / 0.8 : (1 - p) / 0.2) * Math.min(1, x * 10, (1 - x) * 10);
  },
  // broad, frontal and inferior, in the delta range
  'Tongue-movement-artifact': ({ name, t, x }) => {
    const w = /^Fp/.test(name) ? 1 : /^F/.test(name) ? 0.8 : /^T/.test(name) ? 0.7 : /^C/.test(name) ? 0.5 : /^P/.test(name) ? 0.35 : /^O/.test(name) ? 0.25 : 0;
    return w * 45 * UV * (Math.sin(2 * Math.PI * 2.2 * t) + 0.6 * Math.sin(2 * Math.PI * 3.1 * t + 1)) * Math.min(1, x * 6, (1 - x) * 6);
  },
  // a slow wave about 0.25 s after each heartbeat
  'Pulse-artifact': ({ t, x, on }) => {
    if (!on) return 0;
    const ph = (((t - 0.2) % ECG_PERIOD) + ECG_PERIOD) % ECG_PERIOD; // the time since the last QRS
    return 45 * UV * Math.exp(-(((ph - 0.25) / 0.07) ** 2)) * Math.min(1, x * 20, (1 - x) * 20);
  },
  // slow and regular, with each breath (15 a minute)
  'Respiration-artifact': ({ art, t, x, on }) => (on ? 45 * UV * Math.sin(2 * Math.PI * 0.25 * (t - art.onsetS)) * Math.min(1, x * 8, (1 - x) * 8) : 0),
  // a low, irregular, very slow undulation of the baseline
  'Sweat-artifact': ({ art, t, x, on }) => (on ? 30 * UV * (Math.sin(2 * Math.PI * 0.17 * (t - art.onsetS)) + 0.5 * Math.sin(2 * Math.PI * 0.29 * (t - art.onsetS) + 2))
    * Math.min(1, x * 6, (1 - x) * 6) : 0),
  // irregular shifts of the baseline on the electrode that moved
  'Electrode-movement-artifact': ({ art, t, x, on, ci, s, seed, noise }) => (on ? UV * (110 * Math.sin(2 * Math.PI * 0.8 * (t - art.onsetS))
    + 50 * Math.sin(2 * Math.PI * 2.3 * (t - art.onsetS) + 1) + 25 * noise(seed + 404, ci, s)) * Math.min(1, x * 12, (1 - x) * 12) : 0),
};

for (const [label, fn] of Object.entries(SHAPES)) registerArtifactShape(label, fn);

export const GUIDE_SHAPES = Object.freeze(Object.keys(SHAPES));
