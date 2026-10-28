// A recording's original events as the desktop records them (electroclean/app/eeg/events.py): from
// events.tsv (its rows kept as strings), otherwise from the EDF+/BDF+ annotations or the
// BrainVision markers (with the codes MNE-Python gives them), otherwise from the trigger channels;
// and the desktop's checks of their codes. Used by register.js to build manifests. Plain ES module.

import { pyCompare, pyFloat, pyFloatRepr, pyIntText, pyJsonList, pyListRepr, pyStrRepr, pyStrip, pySorted } from "./pyfmt.js";
import { timeToSample } from "./util.js";

export const SOURCE_EVENTS_TSV = "events_tsv";
export const SOURCE_VMRK = "brainvision_vmrk";
export const SOURCE_EDF = "edf_annotations";
export const SOURCE_BDF = "bdf_annotations";
export const SOURCE_STIM = "stim_channel";
export const SOURCE_NONE = "none";
/** Annotations describing the recording itself rather than an experimental event. */
export const NON_EVENT_PREFIXES = ["new segment", "bad_acq_skip"];
const MAX_ROW_PROBLEMS = 10;

/** MNE's codes for BrainVision markers (mne.io.brainvision._BV_EVENT_IO_OFFSETS and friends). */
const BV_OFFSETS = { "Event/": 0, "Stimulus/S": 0, "Response/R": 1000, "Optic/O": 2000 };
const BV_OTHER_ACCEPTED = { "New Segment/": 99999, "SyncStatus/Sync On": 99998 };
const BV_OTHER_OFFSET = 10001;

/** format_seconds: the shortest text that reads back to the same float ("12.004", "3.0"). */
export function formatSeconds(value) {
  if (!Number.isFinite(value)) throw new Error(`Cannot format non-finite time ${pyFloatRepr(value)}`);
  return pyFloatRepr(value);
}

/** parse_float: a finite float, or null. */
export function parseFloatPy(text) {
  const v = pyFloat(text);
  return v !== null && Number.isFinite(v) ? v : null;
}

/**
 * parse_int_code: an event code such as "101" or "101.0" as its decimal text, or null.
 * @param {string | null | undefined} text
 */
export function parseIntCode(text) {
  if (text === null || text === undefined) return null;
  const s = pyStrip(String(text));
  const i = pyIntText(s);
  if (i !== null) return i;
  const f = parseFloatPy(s);
  if (f !== null && Number.isInteger(f)) return BigInt(f).toString();
  return null;
}

/** An OriginalEvents record, with the fields of the desktop's dataclass in its order. */
export function newEvents(source, path, columns, rows) {
  return {
    source,
    path,
    columns,
    rows,
    onset_s: [],
    sample: [],
    sample_computed: false,
    sample_column_ignored: false,
    problems: [],
    comparison: {},
    stim_channels: [],
  };
}

/** OriginalEvents.column: the values of a column, or "n/a" for each row when there is none. */
export function column(ev, name) {
  const i = ev.columns.indexOf(name);
  if (i < 0) return ev.rows.map(() => "n/a");
  return ev.rows.map((r) => r[i]);
}

/** _parse_rows: onsets and samples of the rows, with the desktop's problems. */
export function parseRows(ev, sfreq) {
  const onsetCol = column(ev, "onset");
  let hasSample = ev.columns.includes("sample");
  const sampleCol = column(ev, "sample");
  if (hasSample) {
    const given = sampleCol.filter((v) => v !== "n/a" && v !== "");
    if (given.length && given.every((v) => parseIntCode(v) === null)) {
      ev.sample_column_ignored = true;
      ev.problems.push(
        `The sample column does not hold sample numbers (for example ${pyStrRepr(given[0])}); ` +
          "the onset column is used for timing and the sample column is kept unchanged",
      );
      hasSample = false;
    }
  }
  const rowProblems = [];
  for (let i = 0; i < ev.rows.length; i++) {
    const onset = parseFloatPy(onsetCol[i]);
    ev.onset_s.push(onset);
    let sample = null;
    if (hasSample) {
      const code = parseIntCode(sampleCol[i]);
      sample = code === null ? null : Number(code);
      if (sample === null && sampleCol[i] !== "n/a" && sampleCol[i] !== "") {
        rowProblems.push(`Row ${i + 1}: sample value ${pyStrRepr(sampleCol[i])} is not an integer`);
      }
    }
    if (sample === null && onset !== null) sample = timeToSample(onset, sfreq);
    if (onset === null) rowProblems.push(`Row ${i + 1}: onset ${pyStrRepr(onsetCol[i])} is not a number`);
    else if (hasSample && sample !== null) {
      const implied = timeToSample(onset, sfreq);
      if (Math.abs(implied - sample) > 1) {
        rowProblems.push(`Row ${i + 1}: onset ${onsetCol[i]} s implies sample ${implied} but the sample column says ${sample}`);
      }
    }
    ev.sample.push(sample);
  }
  ev.problems.push(...rowProblems.slice(0, MAX_ROW_PROBLEMS));
  if (rowProblems.length > MAX_ROW_PROBLEMS) {
    ev.problems.push(`... and ${rowProblems.length - MAX_ROW_PROBLEMS} more row(s) with the same kinds of problem`);
  }
  ev.sample_computed = !hasSample;
  return ev;
}

/**
 * events_from_tsv, from the rows already read.
 * @param {string[]} columns @param {string[][]} rows
 * @param {string} name the file's name @param {string} path relative to the dataset root
 * @param {number} sfreq
 */
export function eventsFromTsv(columns, rows, name, path, sfreq) {
  const ev = newEvents(SOURCE_EVENTS_TSV, path, columns, rows);
  if (!columns.includes("onset") || !columns.includes("duration")) {
    ev.problems.push(`${name} lacks the required BIDS columns 'onset' and 'duration'`);
  }
  return parseRows(ev, sfreq);
}

/**
 * The codes mne.events_from_annotations(raw, regexp=None) gives each description: for BrainVision
 * the marker's number plus the offset of its type (Stimulus 0, Response 1000, Optic 2000), 99999 for
 * New Segment, 99998 for SyncStatus and 10001, 10002, ... for the others; for EDF+ and BDF+ 1, 2, ...
 * in the sorted order of the descriptions.
 * @param {string[]} descriptions
 * @param {string} format
 * @returns {Map<string, number>}
 */
export function mneEventIds(descriptions, format) {
  const ids = new Map();
  const unique = pySorted(new Set(descriptions));
  if (format === "brainvision") {
    let other = 0;
    for (const d of unique) {
      const cps = Array.from(d);
      const maybe = pyStrip(cps.slice(Math.max(0, cps.length - 3)).join(""));
      const kind = cps.slice(0, Math.max(0, cps.length - 3)).join("");
      let code;
      if (/^[0-9]+$/.test(maybe) && Object.hasOwn(BV_OFFSETS, kind)) code = Number(maybe) + BV_OFFSETS[kind];
      else if (Object.hasOwn(BV_OTHER_ACCEPTED, d)) code = BV_OTHER_ACCEPTED[d];
      else code = BV_OTHER_OFFSET + other++;
      ids.set(d, code);
    }
  } else unique.forEach((d, i) => ids.set(d, i + 1));
  return ids;
}

/**
 * events_from_raw_annotations: one row per annotation (as MNE holds them after reading: sorted,
 * clipped to the recording, onsets to the microsecond).
 * @param {{onset: number, duration: number, description: string, channels?: string[]}[]} annotations
 * @param {number} sfreq @param {string} format @param {string | null} path relative to the dataset root
 */
export function eventsFromAnnotations(annotations, sfreq, format, path) {
  const columns = ["onset", "duration", "trial_type", "value", "sample", "channels"];
  const ids = annotations.length ? mneEventIds(annotations.map((a) => a.description), format) : new Map();
  const rows = annotations.map((a) => {
    const sample = timeToSample(a.onset, sfreq);
    const ch = a.channels || [];
    return [
      formatSeconds(sample / sfreq),
      formatSeconds(a.duration),
      a.description,
      ids.has(a.description) ? String(ids.get(a.description)) : "n/a",
      String(sample),
      ch.length ? pyJsonList(ch) : "n/a",
    ];
  });
  const source = format === "edf" ? SOURCE_EDF : format === "bdf" ? SOURCE_BDF : SOURCE_VMRK;
  return parseRows(newEvents(rows.length ? source : SOURCE_NONE, path, columns, rows), sfreq);
}

/**
 * events_from_stim_channels: every change of a trigger channel to a non-zero code.
 * @param {{sample: number, code: number, channel: string}[]} found
 * @param {string[]} stimChannels @param {string | null} path @param {number} sfreq
 * @param {string[]} [problems]
 */
export function eventsFromTriggers(found, stimChannels, path, sfreq, problems = []) {
  const columns = ["onset", "duration", "trial_type", "value", "sample", "stim_channel"];
  const sorted = [...found].sort((a, b) => a.sample - b.sample || pyCompare(a.channel, b.channel));
  const rows = sorted.map((t) => [formatSeconds(t.sample / sfreq), "n/a", "n/a", String(t.code), String(t.sample), t.channel]);
  const ev = newEvents(rows.length ? SOURCE_STIM : SOURCE_NONE, path, columns, rows);
  ev.stim_channels = rows.length ? [...stimChannels] : [];
  parseRows(ev, sfreq);
  ev.problems.push(...problems);
  return ev;
}

/** True for annotations that describe the recording rather than an event. */
function isNonEvent(description) {
  const low = description.toLowerCase();
  return NON_EVENT_PREFIXES.some((p) => low.startsWith(p));
}

/**
 * compare_with_markers: events.tsv against the recording's own markers (warnings only).
 * @param {object} tsvEvents
 * @param {{onset: number, description: string}[]} annotations as MNE holds them
 * @param {number} sfreq @param {string} format
 */
export function compareWithMarkers(tsvEvents, annotations, sfreq, format) {
  const markerSamples = annotations
    .filter((a) => !isNonEvent(a.description))
    .map((a) => timeToSample(a.onset, sfreq))
    .sort((a, b) => a - b);
  if (format !== "brainvision" && !markerSamples.length) {
    return {
      n_events_tsv: tsvEvents.rows.length,
      n_file_markers: 0,
      compared: false,
      note: "The file has no event annotations; events.tsv is the only record of the events.",
      consistent: true,
    };
  }
  const tsvSamples = tsvEvents.sample.filter((s) => s !== null).sort((a, b) => a - b);
  const remaining = [...markerSamples];
  let unmatched = 0;
  for (const s of tsvSamples) {
    const k = remaining.findIndex((m) => Math.abs(m - s) <= 1);
    if (k < 0) unmatched++;
    else remaining.splice(k, 1);
  }
  const out = { n_events_tsv: tsvEvents.rows.length };
  out[format === "brainvision" ? "n_vmrk_markers" : "n_file_markers"] = markerSamples.length;
  out.compared = true;
  out.events_tsv_rows_without_marker = unmatched;
  out.markers_without_events_tsv_row = remaining.length;
  out.consistent = unmatched === 0 && remaining.length === 0;
  return out;
}

/**
 * check_event_codes and EventCodeReport.to_dict(): the original codes described, inconsistent code
 * meanings flagged, codes shared with artifact codes noted.
 * @param {object} ev
 * @param {{labels: {label: string, value: number}[]}} catalogue
 */
export function eventCodeReport(ev, catalogue) {
  const labels = catalogue && catalogue.labels ? catalogue.labels : [];
  const artifactCodes = new Set(labels.map((l) => Number(l.value)));
  const permitted = new Set(labels.map((l) => l.label));
  const shared = new Set();
  const byValue = new Map();
  const byLabel = new Map();
  const counts = new Map();
  const artifactRows = [];
  const tts = column(ev, "trial_type");
  const vals = column(ev, "value");
  for (let i = 0; i < tts.length; i++) {
    const tt = tts[i];
    const val = vals[i];
    const code = parseIntCode(val);
    const key = code !== null ? code : val;
    if (val !== "" && val !== "n/a") {
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!byValue.has(key)) byValue.set(key, new Set());
      byValue.get(key).add(tt);
    }
    if (tt !== "" && tt !== "n/a") {
      if (!byLabel.has(tt)) byLabel.set(tt, new Set());
      byLabel.get(tt).add(key);
    }
    if (code !== null && artifactCodes.has(Number(code)) && String(Number(code)) === code) shared.add(Number(code));
    if (permitted.has(tt)) artifactRows.push({ row: i + 1, value: val, trial_type: tt });
  }
  const conflicts = (m) => {
    const out = {};
    for (const k of pySorted(m.keys())) {
      const v = m.get(k);
      if ([...v].filter((x) => x !== "" && x !== "n/a").length > 1) out[k] = pySorted(v);
    }
    return out;
  };
  const valueConflicts = conflicts(byValue);
  const labelConflicts = conflicts(byLabel);
  const repeated = {};
  for (const k of pySorted(counts.keys())) if (counts.get(k) > 1) repeated[k] = counts.get(k);
  const summary = [];
  if (artifactRows.length) {
    const names = pySorted(new Set(artifactRows.map((r) => r.trial_type)));
    summary.push(
      `${artifactRows.length} original event(s) already use HED-SCORE artifact names as ` +
        `trial_type (${names.join(", ")}); they are kept as original events.`,
    );
  }
  // in Python's (sorted) order: an object lists keys that look like integers first
  for (const value of pySorted(Object.keys(valueConflicts))) {
    summary.push(`Original code ${value} is used for different events: ${pyListRepr(valueConflicts[value])}.`);
  }
  for (const label of pySorted(Object.keys(labelConflicts))) {
    summary.push(`Original event type ${pyStrRepr(label)} appears with different codes: ${pyListRepr(labelConflicts[label])}.`);
  }
  return {
    artifact_codes_column: "artifact_code",
    codes_also_used_for_artifacts: [...shared].sort((a, b) => a - b),
    note:
      "Original values are kept unchanged in the value column; artifact codes are in the separate " +
      "artifact_code column, so the two can never be confused.",
    artifact_label_rows: artifactRows,
    value_meaning_conflicts: valueConflicts,
    label_value_conflicts: labelConflicts,
    repeated_values: repeated,
    summary,
  };
}
