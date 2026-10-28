// Channel types and device housekeeping channels. Plain ES module, no dependencies.

import { fnmatchCase } from "./util.js";

/**
 * Device housekeeping channels (Emotiv timestamps, counters, contact quality and so on), as in
 * the desktop's default channels.hide setting: case-sensitive shell-style patterns. They hold no
 * EEG, so they are suggested as hidden; a study's manifest says what is actually shown.
 */
export const HOUSEKEEPING_PATTERNS = Object.freeze([
  "TIME_STAMP_s",
  "TIME_STAMP_ms",
  "OR_TIME_STAMP_s",
  "OR_TIME_STAMP_ms",
  "COUNTER",
  "INTERPOLATED",
  "RAW_CQ",
  "BATTERY",
  "BATTERY_PERCENT",
  "MarkerIndex",
  "MarkerType",
  "MarkerValueInt",
  "MARKER_HARDWARE",
  "CQ_*",
  "EQ_*",
]);

/** Channel types of the Recording interface. */
export const CHANNEL_TYPES = Object.freeze(["eeg", "eog", "ecg", "emg", "misc", "stim"]);

/**
 * True for the names MNE's EDF and BDF readers treat as trigger channels ("status" and "trigger",
 * case-insensitive). Their samples are read without physical scaling and masked as MNE does.
 * @param {string} name
 */
export function isMneEdfStim(name) {
  const low = name.toLowerCase();
  return low === "status" || low === "trigger";
}

/**
 * True for channel names matching a housekeeping pattern.
 * @param {string} name
 * @param {readonly string[]} [patterns]
 */
export function isHousekeeping(name, patterns = HOUSEKEEPING_PATTERNS) {
  return patterns.some((p) => fnmatchCase(name, p));
}

/**
 * A channel's type from its name: trigger channels (Status, Trigger, STI 014, TRIG), EOG, ECG
 * (or EKG) and EMG by the usual abbreviations, housekeeping channels as misc, everything else EEG.
 * @param {string} name
 * @returns {"eeg" | "eog" | "ecg" | "emg" | "misc" | "stim"}
 */
export function inferChannelType(name) {
  const n = name.trim();
  if (/^(status|trigger|trig|triggers|stim|sti\s*\d*)$/i.test(n)) return "stim";
  if (isHousekeeping(n)) return "misc";
  if (/EOG/i.test(n)) return "eog";
  if (/ECG|EKG/i.test(n)) return "ecg";
  if (/EMG/i.test(n)) return "emg";
  return "eeg";
}

/**
 * MNE's _unique_channel_names: every copy of a repeated name becomes name-0, name-1, ...
 * (or name-a, name-b, ... when that name is taken).
 * @param {string[]} names
 * @returns {string[]}
 */
export function uniqueChannelNames(names) {
  const out = names.slice();
  const counts = new Map();
  for (const n of out) counts.set(n, (counts.get(n) || 0) + 1);
  const suffixes = "abcdefghijklmnopqrstuvwxyz".split("");
  for (const [stem, count] of counts) {
    if (count < 2) continue;
    let idx = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== stem) continue;
      let chosen = null;
      for (const suffix of [idx, ...suffixes]) {
        const candidate = `${stem}-${suffix}`;
        if (!out.includes(candidate)) {
          chosen = candidate;
          break;
        }
      }
      if (chosen === null) throw new Error(`Could not make the channel name ${stem} unique`);
      out[i] = chosen;
      idx++;
    }
  }
  return out;
}
