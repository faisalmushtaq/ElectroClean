// The desktop's check that the signal amplitude is plausible (electroclean/app/eeg/amplitude.py),
// so that traces stored in the wrong unit (microvolts written as volts, say) can still be seen.
// The amplitude of a channel is the 99.5th percentile of |x - median| in a few short windows
// spread through the recording; the amplitude of a type is the median over its channels that are
// not flat. Plain ES module.

import { median, percentile, pyRound } from "./util.js";

/** Plausible amplitude (half the peak-to-peak range, in volts) for each channel type. */
export const PLAUSIBLE_AMPLITUDE_V = Object.freeze({
  eeg: [0.25e-6, 2.5e-3],
  eog: [0.25e-6, 5e-3],
  emg: [0.25e-6, 5e-3],
  ecg: [1e-6, 2e-2],
});
export const TYPE_NAMES = Object.freeze({ eeg: "EEG", eog: "EOG", emg: "EMG", ecg: "ECG" });
export const N_WINDOWS = 10;
export const WINDOW_S = 2.0;

/** Python's format(value, ".3g") (and other precisions). */
export function formatG(value, precision = 3) {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(Number(value.toPrecision(precision)))));
  if (exp < -4 || exp >= precision) {
    const [mant, e] = value.toExponential(precision - 1).split("e");
    const m = mant.includes(".") ? mant.replace(/0+$/, "").replace(/\.$/, "") : mant;
    const n = Number(e);
    return `${m}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  }
  const s = value.toFixed(Math.max(0, precision - 1 - exp));
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** "14 V", "230 µV", "0.03 µV" and so on. */
export function formatVolts(value) {
  for (const [unit, factor] of [["kV", 1e3], ["V", 1.0], ["mV", 1e-3], ["µV", 1e-6], ["nV", 1e-9]]) {
    if (Math.abs(value) >= factor || unit === "nV") return `${formatG(value / factor)} ${unit}`;
  }
  return `${formatG(value)} V`;
}

/** The smallest 1, 2 or 5 times a power of ten that is at least value. */
export function niceScale(value) {
  if (!(value > 0) || !Number.isFinite(value)) throw new Error(String(value));
  const exponent = Math.floor(Math.log10(value));
  for (const step of [1.0, 2.0, 5.0, 10.0]) {
    const candidate = step * 10.0 ** exponent;
    if (candidate >= value * (1 - 1e-12)) return Number(candidate.toPrecision(6));
  }
  return Number((10.0 ** (exponent + 1)).toPrecision(6));
}

/**
 * The windows [start, end) the check reads: N_WINDOWS of WINDOW_S seconds spread evenly between
 * the filter edge zones, leaving out those that overlap a stretch without recorded data.
 * @param {number} nTimes
 * @param {number} sfreq
 * @param {number[][]} avoid
 * @param {number} edge
 */
export function amplitudeWindows(nTimes, sfreq, avoid, edge) {
  const length = Math.max(1, Math.min(Math.trunc(WINDOW_S * sfreq), nTimes));
  let lo = Math.min(edge, Math.max(0, nTimes - length));
  let hi = Math.max(0, nTimes - length - edge);
  if (hi < lo) {
    lo = 0;
    hi = Math.max(0, nTimes - length);
  }
  const starts = new Set();
  const step = (hi - lo) / (N_WINDOWS - 1);
  for (let i = 0; i < N_WINDOWS; i++) starts.add(pyRound(i === N_WINDOWS - 1 ? hi : lo + i * step));
  const out = [];
  for (const s of [...starts].sort((a, b) => a - b)) {
    const e = s + length;
    if (avoid.some(([a, b]) => a < e && s < b)) continue;
    out.push([s, e]);
  }
  return out.length ? out : [[0, length]];
}

/**
 * The amplitude report from the sampled data of each channel type.
 * @param {Record<string, Float32Array[] | Float64Array[]>} byType per type, one array per channel
 *   holding that channel's samples of all windows one after another
 */
export function amplitudeReport(byType) {
  const report = { amplitudesV: {}, suggestedScalings: {}, warnings: [] };
  for (const [type, [low, high]] of Object.entries(PLAUSIBLE_AMPLITUDE_V)) {
    const chans = byType[type];
    if (!chans || !chans.length) continue;
    const perChannel = [];
    for (const x of chans) {
      let finite = true;
      const work = new Float64Array(x.length);
      for (let i = 0; i < x.length; i++) {
        work[i] = x[i];
        if (!Number.isFinite(x[i])) finite = false;
      }
      if (!finite || !x.length) continue;
      const med = median(work.slice());
      for (let i = 0; i < work.length; i++) work[i] = Math.abs(work[i] - med);
      const v = percentile(work, 99.5);
      if (Number.isFinite(v) && v > 0) perChannel.push(v);
    }
    if (!perChannel.length) continue; // every channel of the type is flat
    const amplitude = median(Float64Array.from(perChannel));
    report.amplitudesV[type] = amplitude;
    if (low <= amplitude && amplitude <= high) continue;
    const scale = niceScale(amplitude);
    report.suggestedScalings[type] = scale;
    const name = TYPE_NAMES[type];
    let why;
    if (amplitude > high) {
      why =
        `far larger than any ${name} signal (normally microvolts to a few millivolts). The file's unit ` +
        "is probably wrong, for example microvolts stored as volts";
    } else {
      why =
        `far smaller than any ${name} signal, even the amplifier's noise. The file's unit is probably ` +
        "wrong, for example volts stored as microvolts";
    }
    report.warnings.push(
      `The ${name} channels' amplitude is about ${formatVolts(amplitude)}, ${why}. The display scale has ` +
        `been set to ${formatVolts(scale)} so that the traces can be seen; the scale bar shows the ` +
        "amplitude as the file states it. Please check the recording with whoever exported it.",
    );
  }
  return report;
}
