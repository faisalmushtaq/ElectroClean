// Display filters, designed and applied exactly as the desktop application asks MNE-Python to:
// a high-pass filter (mne.io.Raw.filter) followed by a notch filter (mne.io.Raw.notch_filter),
// both FIR, zero-phase, window design (firwin) with a Hamming window, filter length "auto",
// padding "reflect_limited", each continuous segment of the recording filtered on its own and
// stretches without recorded data (BAD_ACQ_SKIP) left unfiltered. Trigger channels are never
// filtered. Plain ES module; only fft.js is used.
//
// The designs reproduce mne.filter.create_filter (MNE 1.x) and scipy.signal.firwin; the
// coefficients agree with MNE's to about 1e-15. Filtering is FFT convolution (overlap-save).
// Far from the edges of a segment (more than the summed half lengths of the two filters) the
// two filters are applied as one combined convolution, which is mathematically the same as
// MNE's two passes; near an edge the two passes are made one after the other with MNE's
// reflect_limited padding at that edge, so the edge transients match MNE's as well.

import { FFT, nextPow2 } from "./fft.js";

/** MNE's _length_factors["hamming"]: transition bandwidth times length, in seconds times Hz. */
export const HAMMING_LENGTH_FACTOR = 3.3;
/** MNE's default notch transition bandwidth (Hz) as the desktop passes it. */
export const NOTCH_TRANS_BANDWIDTH = 1.0;

/** Python's round() (halves to even), as used by MNE's _firwin_design. */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * scipy.signal.get_window("hamming", M, fftbins=False): the symmetric Hamming window.
 * @param {number} M
 */
export function hammingSymmetric(M) {
  const w = new Float64Array(M);
  if (M === 1) {
    w[0] = 1;
    return w;
  }
  const alpha = 0.54;
  const beta = 1 - alpha; // general_hamming uses [alpha, 1 - alpha]
  const step = (2 * Math.PI) / (M - 1); // numpy.linspace(-pi, pi, M)
  for (let i = 0; i < M; i++) {
    const fac = i === M - 1 ? Math.PI : i * step + -Math.PI;
    w[i] = alpha + beta * Math.cos(fac);
  }
  return w;
}

/** numpy.sinc */
function sinc(x) {
  const y = Math.PI * (x === 0 ? 1e-20 : x);
  return Math.sin(y) / y;
}

/**
 * scipy.signal.firwin(numtaps, cutoff, window="hamming", pass_zero=True, fs=2): a low-pass
 * filter with the cutoff given relative to the Nyquist frequency, scaled to unit gain at 0 Hz.
 * @param {number} numtaps
 * @param {number} cutoff
 */
export function firwinLowpass(numtaps, cutoff) {
  const alpha = 0.5 * (numtaps - 1);
  const h = new Float64Array(numtaps);
  const win = hammingSymmetric(numtaps);
  let s = 0;
  for (let i = 0; i < numtaps; i++) {
    const m = i - alpha;
    h[i] = cutoff * sinc(cutoff * m) * win[i];
    s += h[i];
  }
  for (let i = 0; i < numtaps; i++) h[i] /= s;
  return h;
}

/**
 * MNE's _firwin_design: a filter of odd length N with the piecewise-constant gain (0 or 1)
 * given at the normalised frequencies freq (0 to 1, 1 being Nyquist), built from low-pass
 * filters, one per change of gain, each as long as its transition band requires.
 * @param {number} N
 * @param {number[]} freq
 * @param {number[]} gain
 * @param {number} sfreq used only in the error message
 */
export function firwinDesign(N, freq, gain, sfreq) {
  if (N % 2 !== 1) throw new Error(`filter length must be odd, got ${N}`);
  const h = new Float64Array(N);
  let prevFreq = freq[freq.length - 1];
  let prevGain = gain[gain.length - 1];
  if (prevGain === 1) h[(N - 1) / 2] = 1;
  for (let k = freq.length - 2; k >= 0; k--) {
    const thisFreq = freq[k];
    const thisGain = gain[k];
    if (thisGain !== prevGain) {
      const transition = (prevFreq - thisFreq) / 2.0;
      let thisN = Math.trunc(pyRound(HAMMING_LENGTH_FACTOR / transition));
      thisN += 1 - (thisN % 2);
      if (thisN > N) {
        throw new Error(
          `The requested filter length ${N} is too short for the requested ` +
            `${((transition * sfreq) / 2).toFixed(2)} Hz transition band, which requires ${thisN} samples`,
        );
      }
      const lp = firwinLowpass(thisN, (prevFreq + thisFreq) / 2.0);
      const offset = (N - thisN) >> 1;
      if (thisGain === 0) for (let i = 0; i < thisN; i++) h[offset + i] -= lp[i];
      else for (let i = 0; i < thisN; i++) h[offset + i] += lp[i];
    }
    prevGain = thisGain;
    prevFreq = thisFreq;
  }
  return h;
}

/**
 * MNE's filter_length="auto" for a firwin design: 3.3 / (narrowest transition band) seconds,
 * rounded up to whole samples and made odd.
 * @param {number} minTransHz
 * @param {number} sfreq
 */
export function autoFilterLength(minTransHz, sfreq) {
  const seconds = (HAMMING_LENGTH_FACTOR * 1.0) / minTransHz;
  let n = Math.max(Math.ceil(seconds * 1 * sfreq), 1);
  n += (n - 1) % 2;
  return n;
}

/**
 * The high-pass design of mne.filter.create_filter(l_freq=lFreq, h_freq=None, ...).
 * @param {number} sfreq
 * @param {number} lFreq
 */
export function designHighpass(sfreq, lFreq) {
  const lTrans = Math.min(Math.max(0.25 * lFreq, 2.0), lFreq);
  const stop = lFreq - lTrans;
  const length = autoFilterLength(lTrans, sfreq);
  let freq = [stop, lFreq, sfreq / 2.0];
  let gain = [0, 1, 1];
  if (stop !== 0) {
    freq = [0, ...freq];
    gain = [0, ...gain];
  }
  const nyq = sfreq / 2.0;
  const h = firwinDesign(length, freq.map((f) => f / nyq), gain, sfreq);
  return { name: "high-pass", h, length, transitionHz: lTrans, freq, gain };
}

/**
 * The band-stop design of mne.filter.notch_filter(freqs, notch_widths=None, trans_bandwidth=1)
 * with method "fir": one filter with a stop band of width f/200 Hz at each frequency.
 * @param {number} sfreq
 * @param {number[]} freqs
 */
export function designNotch(sfreq, freqs) {
  const tb2 = NOTCH_TRANS_BANDWIDTH / 2.0;
  const lows = freqs.map((f) => f - f / 200.0 / 2.0 - tb2);
  const highs = freqs.map((f) => f + f / 200.0 / 2.0 + tb2);
  // create_filter's band-stop branch: _triage_filter_params(h_freq=lows, l_freq=highs, reverse=True)
  const fP1 = lows.map((v) => v - tb2 + tb2);
  const fS1 = lows.map((v) => v + tb2);
  const fS2 = highs.map((v) => v - tb2);
  const fP2 = highs.map((v) => v + tb2 - tb2);
  const pairs = [];
  fP1.forEach((f) => pairs.push([f, 1]));
  fS1.forEach((f) => pairs.push([f, 0]));
  fS2.forEach((f) => pairs.push([f, 0]));
  fP2.forEach((f) => pairs.push([f, 1]));
  pairs.sort((a, b) => a[0] - b[0]);
  let freq = pairs.map((p) => p[0]);
  let gain = pairs.map((p) => p[1]);
  if (freq[0] !== 0) {
    freq = [0, ...freq];
    gain = [1, ...gain];
  }
  if (freq[freq.length - 1] !== sfreq / 2.0) {
    freq = [...freq, sfreq / 2.0];
    gain = [...gain, 1];
  }
  for (let i = 2; i < gain.length; i++) {
    if (Math.abs(gain[i] - 2 * gain[i - 1] + gain[i - 2]) > 1) throw new Error("Stop bands are not sufficiently separated.");
  }
  const length = autoFilterLength(Math.min(tb2, tb2), sfreq);
  const nyq = sfreq / 2.0;
  const h = firwinDesign(length, freq.map((f) => f / nyq), gain, sfreq);
  return { name: "notch", h, length, transitionHz: tb2, freq, gain, freqs: freqs.slice() };
}

/**
 * The notch frequencies the desktop uses: the base frequency and, with harmonics, its multiples,
 * each below Nyquist minus 1 Hz (electrotag.app.eeg.filtering.notch_frequencies).
 * @param {number} sfreq
 * @param {number} baseHz
 * @param {boolean} harmonics
 */
export function notchFrequencies(sfreq, baseHz, harmonics) {
  const nyq = sfreq / 2.0;
  const base = Number(baseHz);
  const freqs = [base];
  if (harmonics) {
    let k = 2;
    while (base * k < nyq - 1.0) {
      freqs.push(base * k);
      k += 1;
    }
  }
  return freqs.filter((f) => f < nyq - 1.0);
}

/**
 * @typedef {{highpassHz: number | null, notchHz: number | null, notchHarmonics?: boolean}} FilterSettings
 * @typedef {{name: string, h: Float64Array, length: number, half: number, spectra: Map<number, {re: Float64Array, im: Float64Array}>}} FilterStep
 * @typedef {{key: string, steps: FilterStep[], halfWidth: number, skipped: string[], combined: FilterStep | null,
 *            description: object}} FilterPlan
 */

const planCache = new Map();

/** A canonical key for filter settings (equal settings give equal keys). */
export function filterKey(sfreq, filters) {
  if (!filters) return "none";
  const hp = filters.highpassHz == null || !(Number(filters.highpassHz) > 0) ? "" : String(Number(filters.highpassHz));
  const notch = filters.notchHz == null || !(Number(filters.notchHz) > 0) ? "" : String(Number(filters.notchHz));
  if (!hp && !notch) return "none";
  return `${sfreq}|hp=${hp}|notch=${notch}|harm=${notch && filters.notchHarmonics ? 1 : 0}`;
}

/**
 * The filters the desktop would apply for these settings at this sampling rate, designed once and
 * kept (designs and kernel spectra are cached per settings).
 * @param {number} sfreq
 * @param {FilterSettings | null | undefined} filters
 * @returns {FilterPlan}
 */
export function planFilters(sfreq, filters) {
  const key = filterKey(sfreq, filters);
  const cached = planCache.get(key);
  if (cached) return cached;
  const steps = [];
  const skipped = [];
  const description = { sfreq, method: "fir", phase: "zero", fir_window: "hamming", fir_design: "firwin", pad: "reflect_limited", steps: [] };
  if (filters && key !== "none") {
    const hp = filters.highpassHz == null ? null : Number(filters.highpassHz);
    if (hp != null && hp > 0) {
      if (hp >= sfreq / 2) skipped.push(`High-pass ${hp} Hz skipped: not below Nyquist (${sfreq / 2} Hz)`);
      else steps.push(designHighpass(sfreq, hp));
    }
    const notch = filters.notchHz == null ? null : Number(filters.notchHz);
    if (notch != null && notch > 0) {
      let freqs = notchFrequencies(sfreq, notch, Boolean(filters.notchHarmonics));
      // MNE refuses stop bands that reach past Nyquist; leave those frequencies out
      freqs = freqs.filter((f) => f + f / 400 + 0.5 < sfreq / 2 && f + f / 400 + 1.0 <= sfreq / 2);
      if (!freqs.length) skipped.push(`Notch at ${notch} Hz skipped: not below Nyquist (${sfreq / 2} Hz)`);
      else steps.push(designNotch(sfreq, freqs));
    }
  }
  for (const s of steps) {
    s.half = (s.length - 1) / 2;
    s.spectra = new Map();
    description.steps.push({
      name: s.name,
      filter_length_samples: s.length,
      transition_bandwidth_hz: s.transitionHz,
      transient_half_width_samples: s.half,
      ...(s.freqs ? { freqs: s.freqs } : {}),
    });
  }
  let combined = null;
  if (steps.length > 1) {
    let length = 1;
    for (const s of steps) length += s.length - 1;
    combined = { name: "combined", h: null, length, half: (length - 1) / 2, spectra: new Map(), parts: steps };
  }
  const plan = {
    key,
    spec: filters
      ? { highpassHz: filters.highpassHz ?? null, notchHz: filters.notchHz ?? null, notchHarmonics: Boolean(filters.notchHarmonics) }
      : null,
    steps,
    combined,
    halfWidth: steps.reduce((a, s) => a + s.half, 0),
    skipped,
    description,
  };
  planCache.set(key, plan);
  return plan;
}

/** The kernel spectrum of a step at FFT size n (cached). @param {FilterStep} step @param {number} n */
function spectrumOf(step, n) {
  let sp = step.spectra.get(n);
  if (sp) return sp;
  if (step.parts) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    re.fill(1);
    for (const part of step.parts) {
      const p = spectrumOf(part, n);
      for (let i = 0; i < n; i++) {
        const r = re[i] * p.re[i] - im[i] * p.im[i];
        im[i] = re[i] * p.im[i] + im[i] * p.re[i];
        re[i] = r;
      }
    }
    sp = { re, im };
  } else {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    re.set(step.h);
    FFT.of(n).forward(re, im);
    sp = { re, im };
  }
  step.spectra.set(n, sp);
  return sp;
}

const scratch = new Map();
function scratchOf(n) {
  let s = scratch.get(n);
  if (!s) {
    s = { re: new Float64Array(n), im: new Float64Array(n) };
    scratch.set(n, s);
  }
  return s;
}

/**
 * Write the padded input of one stage for output samples [o0, o1) into buf: the samples
 * [o0 - half, o1 + half) of the segment [s0, s1), with MNE's reflect_limited padding beyond the
 * segment (2 x[edge] - x[edge -/+ k] for k up to nEdge = min(L, segment length) - 1, zero
 * beyond). src holds the input for indices from srcStart.
 */
function fillExtended(buf, src, srcStart, s0, s1, o0, o1, step) {
  const L = step.length;
  const half = step.half;
  const nEdge = Math.max(Math.min(L, s1 - s0) - 1, 0);
  const extLen = o1 - o0 + L - 1;
  const first = o0 - half;
  // inside the segment
  const a = Math.max(first, s0);
  const b = Math.min(first + extLen, s1);
  for (let pos = a; pos < b; pos++) buf[pos - first] = src[pos - srcStart];
  // left padding
  if (first < s0) {
    const x0 = src[s0 - srcStart];
    for (let pos = first; pos < Math.min(s0, first + extLen); pos++) {
      const k = s0 - pos;
      buf[pos - first] = k <= nEdge ? 2 * x0 - src[s0 + k - srcStart] : 0;
    }
  }
  // right padding
  if (first + extLen > s1) {
    const xl = src[s1 - 1 - srcStart];
    for (let pos = Math.max(s1, first); pos < first + extLen; pos++) {
      const k = pos - (s1 - 1);
      buf[pos - first] = k <= nEdge ? 2 * xl - src[s1 - 1 - k - srcStart] : 0;
    }
  }
  for (let q = extLen; q < buf.length; q++) buf[q] = 0;
}

/**
 * One zero-phase FIR stage for up to two signals at once (as the real and imaginary parts of one
 * complex FFT): outputs for [o0, o1) of the segment [s0, s1).
 * @returns {Float64Array[]}
 */
function runStage(srcA, srcB, srcStart, s0, s1, o0, o1, step) {
  const M = o1 - o0;
  const L = step.length;
  const n = nextPow2(M + L - 1);
  const { re, im } = scratchOf(n);
  fillExtended(re, srcA, srcStart, s0, s1, o0, o1, step);
  if (srcB) fillExtended(im, srcB, srcStart, s0, s1, o0, o1, step);
  else im.fill(0);
  const fft = FFT.of(n);
  fft.forward(re, im);
  const sp = spectrumOf(step, n);
  const hr = sp.re;
  const hi = sp.im;
  for (let i = 0; i < n; i++) {
    const r = re[i] * hr[i] - im[i] * hi[i];
    im[i] = re[i] * hi[i] + im[i] * hr[i];
    re[i] = r;
  }
  fft.inverse(re, im);
  const outA = re.slice(L - 1, L - 1 + M);
  const outB = srcB ? im.slice(L - 1, L - 1 + M) : null;
  return [outA, outB];
}

/** Whether every sample of a signal is zero. */
function isAllZero(src) {
  for (let i = 0; i < src.length; i++) if (src[i] !== 0) return false;
  return true;
}

/**
 * Filter up to two signals of the segment [s0, s1) and return the filtered samples [o0, o1).
 * srcA and srcB hold the unfiltered samples from srcStart and must cover
 * [max(s0, o0 - plan.halfWidth), min(s1, o1 + plan.halfWidth)).
 * @param {FilterPlan} plan
 * @returns {Float64Array[]} [a, b] (b is null when srcB is null)
 */
export function filterPair(plan, srcA, srcB, srcStart, s0, s1, o0, o1) {
  if (!plan.steps.length) throw new Error("no filter steps");
  // A channel that holds only zeros (an electrode switched off, say) filters to exact zeros, as
  // MNE's filter gives; sharing a complex FFT with its partner would leave rounding residue of
  // the partner (about 1e-18 V) in it, and the amplitude check would then count it as not flat.
  const zeroA = isAllZero(srcA);
  const zeroB = srcB ? isAllZero(srcB) : false;
  if (zeroA || zeroB) {
    const M = o1 - o0;
    const a = zeroA ? new Float64Array(M) : filterPair(plan, srcA, null, srcStart, s0, s1, o0, o1)[0];
    const b = !srcB ? null : zeroB ? new Float64Array(M) : filterPair(plan, srcB, null, srcStart, s0, s1, o0, o1)[0];
    return [a, b];
  }
  const W = plan.halfWidth;
  if (plan.combined && o0 - W >= s0 && o1 + W <= s1) {
    return runStage(srcA, srcB, srcStart, s0, s1, o0, o1, plan.combined);
  }
  // The stages one after another, each over the range the later stages need.
  let curA = srcA;
  let curB = srcB;
  let curStart = srcStart;
  for (let k = 0; k < plan.steps.length; k++) {
    const later = plan.steps.slice(k + 1).reduce((acc, s) => acc + s.half, 0);
    const r0 = Math.max(s0, o0 - later);
    const r1 = Math.min(s1, o1 + later);
    const [a, b] = runStage(curA, curB, curStart, s0, s1, r0, r1, plan.steps[k]);
    curA = a;
    curB = b;
    curStart = r0;
  }
  return [curA, curB];
}

/**
 * The stretches distorted by filter edge effects, in samples, as the desktop hatches them
 * (FilterReport.transient_zones): halfWidth samples at both ends of the recording and on each side
 * of every segment boundary, merged where they overlap.
 * @param {number} nSamples
 * @param {number[]} boundaries sample indices where segments meet (discontinuities, gap edges)
 * @param {number} halfWidth
 * @returns {number[][]}
 */
export function edgeZonesFor(nSamples, boundaries, halfWidth) {
  if (!(halfWidth > 0)) return [];
  const zones = [
    [0, Math.min(halfWidth, nSamples)],
    [Math.max(nSamples - halfWidth, 0), nSamples],
  ];
  for (const s of boundaries) zones.push([Math.max(s - halfWidth, 0), Math.min(s + halfWidth, nSamples)]);
  zones.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [a, b] of zones) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}
