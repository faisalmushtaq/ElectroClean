// Synthetic EEG with known artifacts, for the demonstration and for tests.
//
// makeSyntheticRecording(spec) returns an object with the Recording interface of
// docs/web/architecture.md. Every sample is computed from the spec on demand (a deterministic
// function of the seed, the channel and the sample), so a recording of any size can be shown
// without holding it in memory. syntheticEdfBytes(spec) writes the same recording as an EDF file
// (16-bit, 0.1 µV resolution), which is what the demonstration's fingerprints are computed from,
// so a downloaded example opened "from the computer" matches its built-in twin.
//
// The artifacts are simulated, not recorded: their placement is exact by construction, which is
// what lets them stand in for expert annotations in the demonstration.

export const DEMO_CHANNELS = ['Fp1', 'Fp2', 'F7', 'F3', 'Fz', 'F4', 'F8', 'T7', 'C3', 'Cz', 'C4', 'T8', 'P7', 'P3',
  'Pz', 'P4', 'P8', 'O1', 'O2', 'HEOG', 'VEOG', 'ECG'];

const TYPES = { HEOG: 'eog', VEOG: 'eog', ECG: 'ecg' };
export const channelType = (name) => TYPES[name] || (/^(EXG|STATUS|STI)/i.test(name) ? 'misc' : 'eeg');

const BLINK = ['Fp1', 'Fp2', 'VEOG'];
// A horizontal (or slow) eye movement as the electrodes see it (µV at the peak), as
// electrotag/synthetic.py: largest on the horizontal EOG and at the outer corners of the eyes (F7,
// F8), smaller at Fp1 and Fp2, smaller still further back, with opposite signs on the two sides.
// The experts' reference marks the channels where it is clear.
export const EYE_MOVEMENT_GAINS_UV = Object.freeze({ HEOG: 160, F7: 75, F8: -75, Fp1: 35, Fp2: -35, T7: 15, T8: -15, F3: 12, F4: -12 });
const SIDES = ['Fp1', 'Fp2', 'F7', 'F8', 'HEOG'];

/** The three example recordings of the demonstration (two for guided learning, one for practice). */
export function demoSpecs() {
  return [
    {
      id: 'demo-01', stem: 'sub-demo01_task-rest', sfreq: 250, durationS: 70, seed: 11,
      artifacts: [
        ['Eye-blink-artifact', 3.0, 0.40, BLINK],
        ['EMG-artifact', 9.2, 1.60, ['F7', 'F8', 'T7', 'T8']],
        ['Electrode-pops-artifact', 14.0, 0.50, ['C3']],
        ['Horizontal-eye-movement-artifact', 18.0, 1.20, SIDES],
        ['Movement-artifact', 24.0, 2.00, []],
        ['Eye-blink-artifact', 35.2, 0.38, BLINK],
      ],
    },
    {
      id: 'demo-02', stem: 'sub-demo02_task-rest', sfreq: 250, durationS: 70, seed: 23,
      artifacts: [
        ['Chewing-artifact', 5.0, 3.00, ['T7', 'T8']],
        ['Eye-blink-artifact', 12.4, 0.38, BLINK],
        ['ECG-artifact', 20.0, 5.00, ['T7', 'P7', 'O1']],
        ['Electrode-pops-artifact', 31.0, 0.40, ['O2']],
        ['Slow-eye-movement-artifact', 40.0, 4.00, SIDES],
        ['Eye-blink-artifact', 52.3, 0.40, BLINK],
      ],
    },
    {
      id: 'demo-03', stem: 'sub-demo03_task-rest', sfreq: 250, durationS: 90, seed: 37,
      artifacts: [
        ['Eye-blink-artifact', 4.1, 0.38, BLINK],
        ['EMG-artifact', 11.0, 2.00, ['T7', 'T8']],
        ['Horizontal-eye-movement-artifact', 20.5, 1.00, SIDES],
        ['Movement-artifact', 30.0, 2.50, []],
        ['Line-noise-artifact', 44.0, 3.00, []],
        ['Electrode-pops-artifact', 58.0, 0.45, ['P3']],
        ['Eye-blink-artifact', 66.6, 0.40, BLINK],
        ['Chewing-artifact', 74.0, 3.00, ['T7', 'T8']],
      ],
      gapsS: [[86, 90]], // the amplifier stopped recording: no data at the end
    },
  ].map(normaliseSpec);
}

export function normaliseSpec(spec) {
  const channels = spec.channels || DEMO_CHANNELS;
  const nSamples = Math.round(spec.durationS * spec.sfreq);
  const artifacts = (spec.artifacts || []).map((a) => (Array.isArray(a)
    ? { label: a[0], onsetS: a[1], durationS: a[2], channels: [...a[3]] } : a));
  const events = spec.events || Array.from({ length: Math.floor((spec.durationS - 1) / 5) }, (_, i) => ({
    onsetS: 2 + i * 5, label: `stimulus/${(i % 2) + 1}`,
  }));
  const gaps = (spec.gapsS || []).map(([a, b]) => [Math.round(a * spec.sfreq), Math.min(nSamples, Math.round(b * spec.sfreq))]);
  return { ...spec, channels, nSamples, artifacts, events, gaps };
}

// ------------------------------------------------------------------ randomness
function hash32(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/** A deterministic number in [-1, 1) for (seed, channel, sample). */
function noise(seed, ch, s) {
  return hash32(seed, ch + 1, s) / 2147483648 - 1;
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------------------------------------------------------- signals
const UV = 1e-6;

function backgroundFor(spec) {
  const rnd = mulberry32(spec.seed * 7919);
  const freqs = [1.3, 2.7, 4.1, 6.3, 9.8, 10.4, 13.5, 21.0];
  return spec.channels.map((name) => {
    const posterior = /^(O|P)/.test(name);
    const type = channelType(name);
    return freqs.map((f) => ({
      f,
      a: (type === 'eeg' ? (f > 9 && f < 11 ? (posterior ? 9 : 3) : 4.5 / Math.sqrt(f)) : 2) * (0.7 + 0.6 * rnd()) * UV,
      ph: rnd() * 2 * Math.PI,
    }));
  });
}

function hann(x) { // x in [0, 1]
  return x <= 0 || x >= 1 ? 0 : 0.5 - 0.5 * Math.cos(2 * Math.PI * x);
}

const MORE_SHAPES = new Map();

/** A further type's drawing (js/guide/shapes.js). */
export function registerArtifactShape(label, fn) { MORE_SHAPES.set(label, fn); }

/** Artifact contribution (volts) for channel `name` at time t (s). */
function artifactValue(art, name, t, ci, s, seed, sfreq) {
  const x = (t - art.onsetS) / art.durationS; // 0..1 inside
  if (art.label === 'Electrode-pops-artifact') {
    if (!art.channels.includes(name) || t < art.onsetS || t > art.onsetS + art.durationS) return 0;
    return 260 * UV * Math.exp(-(t - art.onsetS) / 0.12);
  }
  if (x < 0 || x > 1) return 0;
  const on = art.channels.length === 0 || art.channels.includes(name);
  switch (art.label) {
    case 'Eye-blink-artifact': {
      const amp = name === 'VEOG' ? 220 : on ? 130 : ['F3', 'Fz', 'F4'].includes(name) ? 35 : 0;
      return amp * UV * hann(x);
    }
    case 'Horizontal-eye-movement-artifact':
    case 'Slow-eye-movement-artifact': {
      const gain = EYE_MOVEMENT_GAINS_UV[name] || 0;
      if (!gain) return 0;
      const shape = art.label.startsWith('Slow') ? Math.sin(Math.PI * x) : Math.min(1, x * 8, (1 - x) * 8);
      return gain * UV * shape;
    }
    case 'EMG-artifact':
      return on ? 28 * UV * noise(seed + 101, ci, s) * Math.min(1, x * 10, (1 - x) * 10) : 0;
    case 'Chewing-artifact': {
      if (!on) return 0;
      const burst = Math.max(0, Math.sin(2 * Math.PI * 1.6 * (t - art.onsetS)));
      return 40 * UV * noise(seed + 202, ci, s) * burst ** 2;
    }
    case 'Movement-artifact':
      return (150 + 40 * Math.sin(ci)) * UV * Math.sin(Math.PI * x) + 20 * UV * noise(seed + 303, ci, s);
    case 'ECG-artifact':
      return on ? 0.06 * ecgShape(t) : 0;
    case 'Line-noise-artifact':
      return 30 * UV * Math.sin(2 * Math.PI * 50 * t + ci);
    default: {
      const more = MORE_SHAPES.get(art.label);
      if (more) return more({ art, name, t, x, on, ci, s, seed, noise });
      return on ? 50 * UV * Math.sin(Math.PI * x) : 0;
    }
  }
}

/** An ECG-like waveform (volts): QRS spikes about every 0.83 s and a T wave. */
function ecgShape(t) {
  const period = 0.83;
  const ph = ((t % period) + period) % period;
  const qrs = Math.exp(-(((ph - 0.20) / 0.012) ** 2)) * 900 - Math.exp(-(((ph - 0.225) / 0.01) ** 2)) * 180;
  const tw = Math.exp(-(((ph - 0.45) / 0.05) ** 2)) * 160;
  return (qrs + tw) * UV;
}

/** Raw (unfiltered) samples of channel `ci` from `s0` (inclusive) to `s1` (exclusive), in volts. */
function rawChannel(spec, bg, ci, s0, s1) {
  const name = spec.channels[ci];
  const out = new Float64Array(Math.max(0, s1 - s0));
  const sf = spec.sfreq;
  const comps = bg[ci];
  const type = channelType(name);
  const arts = spec.artifacts.filter((a) => a.onsetS < s1 / sf + 1 && a.onsetS + a.durationS + 1 > s0 / sf);
  const gaps = (spec.gaps || []).filter(([a, b]) => a < s1 && b > s0);
  for (let k = 0; k < out.length; k++) {
    const s = s0 + k;
    if (gaps.length && gaps.some(([a, b]) => s >= a && s < b)) { out[k] = 0; continue; }
    const t = s / sf;
    let v = 0;
    if (type === 'ecg') v = ecgShape(t) + 8 * UV * noise(spec.seed, ci, s);
    else {
      for (const c of comps) v += c.a * Math.sin(2 * Math.PI * c.f * t + c.ph);
      v += 3.5 * UV * noise(spec.seed, ci, s) + 1.5 * UV * Math.sin(2 * Math.PI * 50 * t); // a little mains
    }
    for (const a of arts) v += artifactValue(a, name, t, ci, s, spec.seed, sf);
    out[k] = v;
  }
  return out;
}

// --------------------------------------------------------------------- filters
/** How far (s) the display filters may distort the signal at an edge (MNE-like filter lengths). */
export function edgeHalfWidthS(filters) {
  let hw = 0;
  if (filters && filters.highpassHz) hw += 3.3 / Math.min(Math.max(0.25 * filters.highpassHz, 2.0), filters.highpassHz) / 2;
  if (filters && filters.notchHz) hw += 3.3;
  return hw;
}

function biquadNotch(f0, sfreq, q = 30) {
  const w0 = (2 * Math.PI * f0) / sfreq;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return { b0: 1 / a0, b1: (-2 * Math.cos(w0)) / a0, b2: 1 / a0, a1: (-2 * Math.cos(w0)) / a0, a2: (1 - alpha) / a0 };
}

function runBiquad(x, c) {
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
}

/**
 * Simple zero-phase display filters (in place) for synthetic and stub recordings: a high-pass that
 * subtracts a centred moving average one cycle of the cut-off long, and notch filters run forwards
 * and backwards. The real data layer (js/eeg/filters.js) uses FIR designs like MNE's.
 */
export function applySimpleFilters(x, sfreq, filters) {
  if (!filters) return x;
  if (filters.highpassHz) {
    const w = Math.max(3, Math.round(sfreq / filters.highpassHz)) | 1;
    const half = (w - 1) >> 1;
    const prefix = new Float64Array(x.length + 1);
    for (let i = 0; i < x.length; i++) prefix[i + 1] = prefix[i] + x[i];
    const y = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const a = Math.max(0, i - half);
      const b = Math.min(x.length, i + half + 1);
      y[i] = x[i] - (prefix[b] - prefix[a]) / (b - a);
    }
    x.set(y);
  }
  if (filters.notchHz) {
    const freqs = [filters.notchHz];
    if (filters.notchHarmonics) for (let f = 2 * filters.notchHz; f < sfreq / 2; f += filters.notchHz) freqs.push(f);
    for (const f of freqs) {
      if (f >= sfreq / 2) continue;
      const c = biquadNotch(f, sfreq);
      runBiquad(x, c);
      x.reverse(); runBiquad(x, c); x.reverse();
    }
  }
  return x;
}

// --------------------------------------------------------------------- the recording
export function makeSyntheticRecording(specIn) {
  const spec = normaliseSpec(specIn);
  const bg = backgroundFor(spec);
  const sfreq = spec.sfreq;
  let fingerprintCache = null;
  // Small recordings keep each channel once it has been computed; large ones are computed per window.
  const cache = spec.nSamples * spec.channels.length <= 8e6 ? new Map() : null;
  return {
    format: 'synthetic',
    fileName: `${spec.stem}_eeg.edf`,
    stem: spec.stem,
    sizeBytes: edfSize(spec),
    sfreq,
    nSamples: spec.nSamples,
    durationS: spec.nSamples / sfreq,
    measDate: '2026-01-01T10:00:00+00:00',
    channels: spec.channels.map((name) => ({ name, type: channelType(name), unit: 'V' })),
    markers: spec.events.map((e) => ({ onsetSample: Math.round(e.onsetS * sfreq), durationSamples: 0, description: e.label })),
    gaps: spec.gaps.map((g) => [...g]),
    warnings: ['Simulated EEG for the demonstration: the artifacts were placed by a program, not marked by experts.'],
    spec,
    async fingerprint(onProgress) {
      if (!fingerprintCache) {
        const bytes = syntheticEdfBytes(spec);
        fingerprintCache = { algorithm: 'sha256', role: 'eeg', hex: await sha256Hex(bytes), sizeBytes: bytes.length };
      }
      if (onProgress) onProgress(1);
      return fingerprintCache;
    },
    async readWindow({ startSample, nSamples, channels, filters }) {
      return readSynthetic(spec, bg, { startSample, nSamples, channels, filters }, cache);
    },
    close() {},
  };
}

function rawRange(spec, bg, ci, p0, p1, cache) {
  if (!cache) return rawChannel(spec, bg, ci, p0, p1);
  let full = cache.get(ci);
  if (!full) { full = rawChannel(spec, bg, ci, 0, spec.nSamples); cache.set(ci, full); }
  return Float64Array.from(full.subarray(p0, p1));
}

function readSynthetic(spec, bg, { startSample, nSamples, channels, filters }, cache = null) {
  const sfreq = spec.sfreq;
  const s0 = Math.max(0, Math.floor(startSample));
  const s1 = Math.min(spec.nSamples, s0 + Math.max(0, Math.floor(nSamples)));
  const active = filters && (filters.highpassHz || filters.notchHz);
  const pad = active ? Math.round(Math.max(1.5, 3 / (filters.highpassHz || 1)) * sfreq) : 0;
  const p0 = Math.max(0, s0 - pad);
  const p1 = Math.min(spec.nSamples, s1 + pad);
  const data = (channels || spec.channels.map((_, i) => i)).map((ci) => {
    const x = rawRange(spec, bg, ci, p0, p1, cache);
    if (active) applySimpleFilters(x, sfreq, filters);
    return Float32Array.from(x.subarray(s0 - p0, s0 - p0 + (s1 - s0)));
  });
  const hw = Math.round(edgeHalfWidthS(active ? filters : null) * sfreq);
  const edgeZones = hw > 0 ? [[0, Math.min(hw, spec.nSamples)], [Math.max(spec.nSamples - hw, 0), spec.nSamples]] : [];
  return { startSample: s0, nSamples: s1 - s0, data, edgeZones };
}

// --------------------------------------------------------------------- ground truth
/** The simulated artifacts as annotations in samples (stable identifiers), sorted by onset. */
export function truthAnnotations(specIn) {
  const spec = normaliseSpec(specIn);
  const sf = spec.sfreq;
  return spec.artifacts.map((a, i) => ({
    annotation_id: (spec.id.replace(/[^0-9a-z]/gi, '') + 'ref' + String(i).padStart(3, '0')).padEnd(32, '0').slice(0, 32),
    label: a.label,
    onset_sample: Math.round(a.onsetS * sf),
    duration_samples: Math.round(a.durationS * sf),
    channels: spec.channels.filter((c) => a.channels.includes(c)),
    created_at: '2026-01-01T10:00:00.000+00:00',
    modified_at: '2026-01-01T10:00:00.000+00:00',
  })).sort((x, y) => x.onset_sample - y.onset_sample);
}

/** What the example set's simulated artifacts look like and where they are marked: the same words
 *  as electrotag/training/guided.py EXAMPLE_NOTES ({where} the channels, {duration} the length). */
export const EXAMPLE_NOTES = Object.freeze({
  'Eye-blink-artifact': "A blink: the eyelid sliding over the eye changes the eye's electrical field, which the electrodes " +
    'nearest the eyes pick up most. It shows as one smooth deflection of {duration} on {where}, and more ' +
    'weakly on F3, Fz and F4 behind them.',
  'Horizontal-eye-movement-artifact': "A look to the side: the eye's electrical field swings sideways, so the two sides of the head change " +
    'in opposite directions. It is largest on the horizontal EOG and at F7 and F8, beside the eyes, ' +
    'smaller at Fp1 and Fp2 above them, and fades further back. It lasts {duration}; mark it on {where}.',
  'Slow-eye-movement-artifact': 'A slow eye movement, as when drowsy: slow waves of opposite sign on the two sides of the head over ' +
    '{duration}, largest on the horizontal EOG and at F7 and F8, smaller at Fp1 and Fp2. Mark it on ' +
    '{where}.',
  'EMG-artifact': 'Muscle activity: fast, irregular activity that starts and stops abruptly, on {where} (over the jaw ' +
    'and temple muscles) for {duration}.',
  'Chewing-artifact': 'Chewing: bursts of fast muscle activity on {where}, over the jaw muscles, that repeat about one and a ' +
    'half times a second for {duration}.',
  'Electrode-pops-artifact': 'An electrode pop: a sudden jump on {where} alone that dies away within a fraction of a second. No ' +
    'neighbouring channel shows it, which tells it apart from brain activity.',
  'Movement-artifact': 'Movement: a large, slow shift on every channel at once for {duration}, so it is marked on the whole ' +
    'montage.',
  'ECG-artifact': 'The heartbeat: sharp spikes on {where} at the rate of the beats on the ECG channel, for {duration}.',
});

/** The note of a simulated artifact in the example set, for trainees (the same words as guided.py example_note). */
export function exampleNote(label, durationS, channels) {
  const where = !channels.length ? 'every channel'
    : channels.length === 1 ? channels[0] : channels.slice(0, -1).join(', ') + ' and ' + channels[channels.length - 1];
  const duration = `${durationS.toFixed(2)} s`;
  let text = EXAMPLE_NOTES[label];
  if (!text) {
    const kind = label.replace(/-artifact$/, '').split('-').map((w) => (w === w.toUpperCase() ? w : w.toLowerCase())).join(' ');
    text = `${/^[AEIOU]/i.test(kind) ? 'An' : 'A'} ${kind} artifact on {where}, lasting {duration}.`;
  }
  return `Simulated example. ${text.replace('{where}', where).replace('{duration}', duration)}`;
}

// --------------------------------------------------------------------- EDF
function edfSize(spec) {
  const ns = spec.channels.length;
  const nRec = Math.ceil(spec.nSamples / spec.sfreq);
  return 256 + 256 * ns + nRec * ns * spec.sfreq * 2;
}

function ascii(text, width) {
  const s = String(text).slice(0, width).padEnd(width, ' ');
  return Uint8Array.from(s, (c) => (c.charCodeAt(0) < 128 ? c.charCodeAt(0) : 63));
}

/** The recording as an EDF file (1-s data records, 16-bit, 0.1 µV resolution, labels = channel names). */
export function syntheticEdfBytes(specIn) {
  const spec = normaliseSpec(specIn);
  if (!Number.isInteger(spec.sfreq)) throw new Error('The EDF writer needs a whole number of samples per second');
  const bg = backgroundFor(spec);
  const ns = spec.channels.length;
  const sf = spec.sfreq;
  const nRec = Math.ceil(spec.nSamples / sf);
  const headerBytes = 256 + 256 * ns;
  const out = new Uint8Array(edfSize(spec));
  let o = 0;
  const put = (bytes) => { out.set(bytes, o); o += bytes.length; };
  put(ascii('0', 8));
  put(ascii('X X X X', 80));
  put(ascii('Startdate 01-JAN-2026 X ElectroTag demonstration X', 80));
  put(ascii('01.01.26', 8));
  put(ascii('10.00.00', 8));
  put(ascii(String(headerBytes), 8));
  put(ascii('', 44));
  put(ascii(String(nRec), 8));
  put(ascii('1', 8));
  put(ascii(String(ns), 4));
  const field = (fn, width) => spec.channels.forEach((c, i) => put(ascii(fn(c, i), width)));
  field((c) => c, 16);
  field((c) => (channelType(c) === 'eeg' ? 'AgAgCl electrode' : ''), 80);
  field(() => 'uV', 8);
  field(() => '-3276.8', 8);
  field(() => '3276.7', 8);
  field(() => '-32768', 8);
  field(() => '32767', 8);
  field(() => '', 80);
  field(() => String(sf), 8);
  field(() => '', 32);
  const dv = new DataView(out.buffer);
  const data = spec.channels.map((_, ci) => rawChannel(spec, bg, ci, 0, nRec * sf));
  for (let r = 0; r < nRec; r++) {
    for (let ci = 0; ci < ns; ci++) {
      const x = data[ci];
      for (let k = 0; k < sf; k++) {
        const s = r * sf + k;
        const uv = s < spec.nSamples ? x[s] / UV : 0;
        const d = Math.max(-32768, Math.min(32767, Math.round(uv * 10)));
        dv.setInt16(o, d, true);
        o += 2;
      }
    }
  }
  return out;
}

export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
