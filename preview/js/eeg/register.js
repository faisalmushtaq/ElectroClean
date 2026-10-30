// Registering recordings in the browser (docs/web/architecture.md, "Registering recordings in the
// browser"). The administrator picks a dataset folder (or files) on their own computer; this module
// finds the recordings in it as the desktop's discovery does, reads each one with the browser's
// readers and builds the same internal manifest that electrotag.web.manifest.build_manifest builds
// from MNE-Python's reading of the files (electrotag/app/eeg/loading.py): timing, the channels
// shown, hidden and their types, the BIDS sidecars, the original events, gaps, the amplitude check,
// the fingerprints, the warnings and the notes, with the desktop's wording. Only the manifests go
// to the study; the EEG stays on the administrator's computer. Plain ES module.

import { folderTree, loadJsonChain, readTsv, resolveSidecars, TsvError } from "./bids.js";
import { parseVhdr } from "./brainvision.js";
import { readEdfHeader, sizeProblems } from "./edf.js";
import {
  column,
  compareWithMarkers,
  eventCodeReport,
  eventsFromAnnotations,
  eventsFromTriggers,
  eventsFromTsv,
  SOURCE_NONE,
} from "./events.js";
import { bvReadWarnings, cropWarnings, edfReadWarnings, mneAnnotations, pySplitlines } from "./mnewarn.js";
import { pyCompare, pyFixed, pyFloatRepr, pyFormatG, pyListRepr, pyStrip } from "./pyfmt.js";
import { decodeUtf8Python, pyValueText } from "./pyjson.js";
import { openRecording } from "./recording.js";
import { sha256Blob } from "./sha256.js";
import { decodeLatin1, extensionOf, fnmatchCase, RecordingError, timeToSample } from "./util.js";

export const SCHEMA = "electrotag.web_manifest";
export const SCHEMA_VERSION = "1.0.0";
export const SCOPE_STUDY = "study";
/** Recording formats by extension, and their names, as electrotag/app/io/discovery.py. */
export const FORMATS = Object.freeze({ ".vhdr": "brainvision", ".edf": "edf", ".bdf": "bdf" });
export const FORMAT_NAMES = Object.freeze({ brainvision: "BrainVision", edf: "EDF", bdf: "BDF" });
/** The columns ElectroTag adds to an events.tsv (electrotag/app/io/export.py). */
const ELECTROTAG_COLUMNS = ["artifact_code", "event_source", "annotation_id", "annotator_id", "original_row"];
/** MNE's default names of BrainVision EOG channels. */
const MNE_BV_EOG = ["HEOGL", "HEOGR", "VEOGb"];
/** Channel types the channels.types setting may give (electrotag/config/settings.py). */
const CHANNEL_TYPES = ["eeg", "eog", "ecg", "emg", "misc", "stim", "resp", "bio", "gsr", "temperature"];
/** BIDS channels.tsv types (electrotag/app/eeg/channels.py). */
const BIDS_TO_MNE_TYPES = Object.freeze({
  EEG: "eeg", EOG: "eog", VEOG: "eog", HEOG: "eog", ECG: "ecg", EMG: "emg", MISC: "misc", TRIG: "stim", RESP: "resp",
  GSR: "gsr", TEMP: "temperature", REF: "eeg", PPG: "bio", AUDIO: "misc", SYSCLOCK: "misc",
}); // prettier-ignore

/**
 * The blocks of electrotag/config/default_settings.json that registration uses
 * (web_tests/unit/data_register.test.mjs checks they are the same).
 */
export const DEFAULT_SETTINGS = Object.freeze({
  output: { directory_name: "Annotated_Events", directory: null },
  discovery: {
    suffixes: ["_eeg.vhdr", "_eeg.edf", "_eeg.bdf"],
    exclude_dir_names: ["derivatives", "Annotated_Events", ".git", ".electrotag"],
    follow_symlinks: false,
  },
  filters: {
    highpass_enabled: true, highpass_hz: 1.0, notch_enabled: true, notch_hz: 50.0, notch_harmonics: false, method: "fir",
    iir_order: 4, locked: false,
  },
  loading: { preload_memory_limit_mb: 2048, hash_source_files: true, apply_channel_types_from_bids: true, show_bids_bad_channels: true },
  channels: {
    hide: [
      "TIME_STAMP_s", "TIME_STAMP_ms", "OR_TIME_STAMP_s", "OR_TIME_STAMP_ms", "COUNTER", "INTERPOLATED", "RAW_CQ", "BATTERY",
      "BATTERY_PERCENT", "MarkerIndex", "MarkerType", "MarkerValueInt", "MARKER_HARDWARE", "CQ_*", "EQ_*",
    ],
    types: {},
  },
}); // prettier-ignore

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (isObject(v) && isObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = structuredClone(v);
  }
  return out;
}

/**
 * The study's settings as registration uses them: the defaults with the study's blocks merged in
 * (the answer of settings_get, {name, settings: {...}}, or the blocks themselves).
 * @param {object} [settings]
 */
export function registrationSettings(settings) {
  const blocks = settings && isObject(settings.settings) ? settings.settings : settings || {};
  const merged = deepMerge(DEFAULT_SETTINGS, blocks);
  const disc = merged.discovery || {};
  const suffixes = disc.suffix ? [String(disc.suffix)] : (disc.suffixes || []).map(String);
  const f = merged.filters || {};
  const types = isObject(merged.channels.types) ? merged.channels.types : {};
  return {
    suffixes: suffixes.length ? suffixes : [...DEFAULT_SETTINGS.discovery.suffixes],
    excludeDirNames: (disc.exclude_dir_names || []).map(String),
    outputDirName: String((merged.output || {}).directory_name || "Annotated_Events"),
    filters: {
      highpass_enabled: Boolean(f.highpass_enabled),
      highpass_hz: Number(f.highpass_hz),
      notch_enabled: Boolean(f.notch_enabled),
      notch_hz: Number(f.notch_hz),
      notch_harmonics: Boolean(f.notch_harmonics),
      method: String(f.method || "fir").toLowerCase(),
    },
    hide: (merged.channels.hide || []).map(String),
    typePatterns: Object.entries(types).map(([k, v]) => [String(k), pyStrip(String(v)).toLowerCase()]),
    applyTypes: merged.loading.apply_channel_types_from_bids !== false,
    showBads: merged.loading.show_bids_bad_channels !== false,
  };
}

// --------------------------------------------------------------------------- discovery
/** Where a picked file lies: the folder picked (the dataset root) and the path below it. */
function locate(file) {
  const rel = String(file.webkitRelativePath || file.relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel.includes("/")) return { root: "", path: file.name };
  const i = rel.indexOf("/");
  return { root: rel.slice(0, i), path: rel.slice(i + 1) };
}

/** A path with "." and ".." resolved (POSIX). */
function normPath(p) {
  const out = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p) => p.slice(p.lastIndexOf("/") + 1);
/** Path.suffix / the name without it, as Python's pathlib. */
function stemOf(name) {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(0, i) : name;
}

/**
 * The recordings among the picked files, found as the desktop's discovery finds them: files whose
 * names end in one of the discovery suffixes (any case), outside hidden folders, the folders the
 * settings exclude and the results folder; recording IDs are the paths below the folder picked.
 * @param {ArrayLike<File>} files from a folder picker (webkitRelativePath) or chosen one by one
 * @param {{settings?: object}} [options]
 * @returns {{recordings: {recordingId: string, format: string, fileName: string, files: File[], sizeBytes: number,
 *            root: string, sidecars: object}[], ignored: {path: string, reason: string}[]}}
 */
export function findDatasetRecordings(files, options = {}) {
  const s = registrationSettings(options.settings);
  const roots = new Map();
  for (const file of Array.from(files || [])) {
    const { root, path } = locate(file);
    if (!roots.has(root)) roots.set(root, []);
    roots.get(root).push({ path, file });
  }
  const recordings = [];
  const ignored = [];
  const endings = s.suffixes.map((x) => x.toLowerCase());
  for (const [root, entries] of roots) {
    const tree = folderTree(entries);
    const byPath = new Map(entries.map((e) => [e.path, e]));
    const dataset = { root, tree, byPath };
    const shown = (p) => (root ? `${root}/${p}` : p);
    for (const { path, file } of entries) {
      const name = baseOf(path);
      const format = FORMATS[extensionOf(name)];
      if (!format) continue;
      const dirs = dirOf(path) ? dirOf(path).split("/") : [];
      const hiddenDir = dirs.find((d) => d.startsWith("."));
      const excluded = dirs.find((d) => s.excludeDirNames.includes(d));
      if (hiddenDir || excluded) {
        ignored.push({ path: shown(path), reason: `It is inside the folder ${hiddenDir || excluded}, which is not searched for recordings` });
        continue;
      }
      if (dirs[0] === s.outputDirName) {
        ignored.push({ path: shown(path), reason: `It is inside the results folder ${s.outputDirName}` });
        continue;
      }
      if (name.startsWith(".")) {
        ignored.push({ path: shown(path), reason: "It is a hidden file" });
        continue;
      }
      if (!endings.some((e) => name.toLowerCase().endsWith(e))) {
        ignored.push({ path: shown(path), reason: `Its name does not end with ${s.suffixes.join(", ")}` });
        continue;
      }
      const sidecars = resolveSidecars(path, tree, (d) => describeDir(root, d));
      const list = [file];
      if (format === "brainvision") {
        // the usual companions; buildManifest finds the ones the header names
        for (const ext of [".eeg", ".vmrk"]) {
          const c = byPath.get(`${dirOf(path) ? `${dirOf(path)}/` : ""}${stemOf(name)}${ext}`);
          if (c) list.push(c.file);
        }
      }
      for (const sc of [sidecars.channelsTsv, sidecars.eventsTsv, ...sidecars.eventsJsonChain, ...sidecars.eegJsonChain]) {
        if (sc && !list.includes(sc.file)) list.push(sc.file);
      }
      const rec = { recordingId: path, format, fileName: name, files: list, sizeBytes: list.reduce((a, f) => a + f.size, 0), root, sidecars };
      Object.defineProperty(rec, "dataset", { value: dataset, enumerable: false });
      recordings.push(rec);
    }
  }
  recordings.sort((a, b) => pyCompare(a.recordingId, b.recordingId) || pyCompare(a.root, b.root));
  ignored.sort((a, b) => pyCompare(a.path, b.path));
  return { recordings, ignored };
}

/** How a folder of the dataset is named in a message (Python gives the full path, unknown here). */
function describeDir(root, dir) {
  if (root) return dir ? `${root}/${dir}` : root;
  return dir || ".";
}

/** read_vhdr_header: the companion files a BrainVision header names (the desktop's own reading). */
function vhdrCompanions(bytes) {
  const dec = decodeUtf8Python(bytes);
  const text = "text" in dec ? dec.text : decodeLatin1(bytes);
  let section = "";
  const values = new Map();
  for (const line of pySplitlines(text)) {
    const stripped = pyStrip(line);
    if (!stripped || stripped.startsWith(";")) continue;
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      section = pyStrip(stripped.slice(1, -1)).toLowerCase();
      continue;
    }
    const m = /^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(stripped);
    if (m) values.set(`${section}\u0000${m[1].toLowerCase()}`, m[2]);
  }
  return { dataFile: values.get("common infos\u0000datafile") || null, markerFile: values.get("common infos\u0000markerfile") || null };
}

/** The picked file at a path of the dataset (exactly, else ignoring case as Windows and macOS do). */
function lookup(dataset, path) {
  const exact = dataset.byPath.get(path);
  if (exact) return exact;
  const dir = dirOf(path);
  const lower = baseOf(path).toLowerCase();
  return (dataset.tree.get(dir) || []).find((f) => f.name.toLowerCase() === lower) || null;
}

// ----------------------------------------------------------------------------- helpers
function nowLocalIso() {
  const d = new Date();
  const p = (v, n = 2) => String(v).padStart(n, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  );
}

/**
 * The label catalogue that the event codes are compared with, which the caller gives: the admin area
 * passes ElectroTag's own (js/api/demo_catalogue.js), as electrotag-web register uses
 * default_catalogue(). This folder never imports the application, so there is no default here.
 */
function catalogueOf(options) {
  const c = options.catalogue;
  if (!c) throw new TypeError("buildManifest needs options.catalogue, the label catalogue that event codes are compared with");
  return c.labels ? c : { labels: c };
}

/** check_channels: the recording's channels against channels.tsv. */
async function checkChannels(names, tsv, source) {
  const report = {
    channels_tsv: tsv ? tsv.name : null,
    n_recording_channels: names.length,
    n_tsv_channels: 0,
    missing_from_channels_tsv: [],
    missing_from_recording: [],
    order_differs: false,
    bids_types: {},
    bids_bad_channels: [],
    problems: [],
    consistent: true,
  };
  const types = new Map();
  if (!tsv) return { report, types };
  let columns;
  let rows;
  try {
    [columns, rows] = await readTsv(tsv.file, source);
  } catch (e) {
    if (!(e instanceof TsvError)) throw e;
    report.problems.push(`channels.tsv could not be read: ${e.message}`);
    report.consistent = false;
    return { report, types };
  }
  if (!columns.includes("name")) {
    report.problems.push("channels.tsv has no 'name' column");
    report.consistent = false;
    return { report, types };
  }
  const records = rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
  const tsvNames = records.map((r) => r.name);
  report.n_tsv_channels = tsvNames.length;
  const counts = new Map();
  for (const n of tsvNames) counts.set(n, (counts.get(n) || 0) + 1);
  const dupes = [...counts].filter(([, c]) => c > 1).map(([n]) => n).sort(pyCompare);
  if (dupes.length) report.problems.push(`channels.tsv lists channels more than once: ${pyListRepr(dupes)}`);
  const recSet = new Set(names);
  const tsvSet = new Set(tsvNames);
  report.missing_from_channels_tsv = names.filter((c) => !tsvSet.has(c));
  report.missing_from_recording = tsvNames.filter((c) => !recSet.has(c));
  const commonRec = names.filter((c) => tsvSet.has(c));
  const commonTsv = tsvNames.filter((c) => recSet.has(c));
  report.order_differs = commonRec.length !== commonTsv.length || commonRec.some((c, i) => c !== commonTsv[i]);
  for (const r of records) {
    if (!recSet.has(r.name)) continue;
    const btype = pyStrip(r.type ?? "").toUpperCase();
    if (Object.hasOwn(BIDS_TO_MNE_TYPES, btype)) types.set(r.name, BIDS_TO_MNE_TYPES[btype]);
    if (pyStrip(r.status ?? "").toLowerCase() === "bad") report.bids_bad_channels.push(r.name);
  }
  report.bids_types = Object.fromEntries(types);
  if (report.missing_from_channels_tsv.length) {
    report.problems.push(`Channels in the recording but not in channels.tsv: ${report.missing_from_channels_tsv.join(", ")}`);
  }
  if (report.missing_from_recording.length) {
    report.problems.push(`Channels in channels.tsv but not in the recording: ${report.missing_from_recording.join(", ")}`);
  }
  report.consistent = !(report.missing_from_channels_tsv.length || report.missing_from_recording.length || report.problems.length);
  return { report, types };
}

/** types_from_patterns: the channels.types setting, the first matching pattern wins. */
function typesFromPatterns(names, patterns) {
  const out = new Map();
  for (const ch of names) {
    for (const [pattern, type] of patterns) {
      if (fnmatchCase(ch, pattern)) {
        out.set(ch, type);
        break;
      }
    }
  }
  return out;
}

/** notch_frequencies of the desktop (filtering.py). */
function notchFrequencies(f, sfreq) {
  if (!f.notch_enabled) return [];
  const nyq = sfreq / 2.0;
  const base = f.notch_hz;
  const freqs = [base];
  if (f.notch_harmonics) for (let k = 2; base * k < nyq - 1.0; k++) freqs.push(base * k);
  return freqs.filter((x) => x < nyq - 1.0);
}

// ----------------------------------------------------------------------- the manifest
/**
 * The manifest of one recording found by findDatasetRecordings, as the desktop's
 * register_recording builds it (the files are read here; nothing is sent anywhere).
 * @param {object} recording an item of findDatasetRecordings().recordings
 * @param {{settings?: object, scope?: string, onProgress?: (p: {stage: string, fraction: number}) => void,
 *          catalogue?: object, worker?: boolean, version?: string}} [options]
 *   catalogue: the label catalogue that event codes are compared with (required; {labels} or the list);
 *   worker: false to read on the page; version: the study's ElectroTag version, if known
 * @returns {Promise<{manifest: object, problems: string[]}>} problems: the checks' findings (the
 *   manifest's warnings), for the administrator to look at
 */
export async function buildManifest(recording, options = {}) {
  catalogueOf(options);
  const s = registrationSettings(options.settings);
  const scope = options.scope || SCOPE_STUDY;
  const progress = (stage, fraction) => {
    if (options.onProgress) options.onProgress({ stage, fraction });
  };
  const dataset = recording.dataset || datasetOf(recording);
  const root = dataset.root;
  const path = recording.recordingId;
  const shown = (p) => (root ? `${root}/${p}` : p);
  const main = lookup(dataset, path);
  if (!main) throw new RecordingError(`${path} is not among the picked files`, "no_files");
  const format = recording.format || FORMATS[extensionOf(path)];
  const formatName = FORMAT_NAMES[format];
  const fileName = baseOf(path);

  // the companion files (discovery.describe_recording)
  let eegEntry = main;
  let vmrkEntry = null;
  let vhdrBytes = null;
  if (format === "brainvision") {
    progress("header", 0);
    vhdrBytes = new Uint8Array(await main.file.arrayBuffer());
    const named = vhdrCompanions(vhdrBytes);
    const problems = [];
    eegEntry = null;
    if (!named.dataFile) problems.push(`Header ${fileName} does not name a data file (DataFile=)`);
    else {
      eegEntry = lookup(dataset, normPath(`${dirOf(path)}/${named.dataFile}`));
      if (!eegEntry) problems.push(`Data file '${named.dataFile}' named in ${fileName} was not found`);
    }
    if (!named.markerFile) problems.push(`Header ${fileName} does not name a marker file (MarkerFile=)`);
    else {
      vmrkEntry = lookup(dataset, normPath(`${dirOf(path)}/${named.markerFile}`));
      if (!vmrkEntry) problems.push(`Marker file '${named.markerFile}' named in ${fileName} was not found`);
    }
    if (problems.length) throw new RecordingError(problems.join("; "), "missing_companion");
  }
  // the desktop reads an EDF/BDF header (and refuses one it cannot read) before anything else
  const edfHeader = format === "brainvision" ? null : await readEdfHeader(main.file, fileName, format);
  const sidecars = recording.sidecars || resolveSidecars(path, dataset.tree, (d) => describeDir(root, d));

  // fingerprints of every input file (loading.fingerprint_sources)
  const roles = [];
  if (format === "brainvision") roles.push(["vhdr", main]);
  roles.push(["eeg", eegEntry]);
  if (vmrkEntry) roles.push(["vmrk", vmrkEntry]);
  for (const [key, entry] of [
    ["channels_tsv", sidecars.channelsTsv],
    ["events_tsv", sidecars.eventsTsv],
    ["events_json", sidecars.eventsJsonChain[sidecars.eventsJsonChain.length - 1]],
    ["eeg_json", sidecars.eegJsonChain[sidecars.eegJsonChain.length - 1]],
  ]) {
    if (entry) roles.push([key, entry]);
  }
  for (const [key, chain] of [["events_json", sidecars.eventsJsonChain], ["eeg_json", sidecars.eegJsonChain]]) {
    chain.slice(0, -1).forEach((entry, i) => roles.push([`${key}_inherited_${i + 1}`, entry]));
  }

  // MNE's warnings while reading the header, and the desktop's notes on the EDF/BDF size
  const edfNotes = [];
  let mneWarnings = [];
  let header = null;
  let vmrkBytes = null;
  if (format === "brainvision") {
    header = parseVhdr(vhdrBytes, fileName);
    vmrkBytes = new Uint8Array(await vmrkEntry.file.arrayBuffer());
  } else {
    const [fatal, notes] = sizeProblems(edfHeader, main.file.size);
    if (!fatal.length) edfNotes.push(...notes.map((n) => `${formatName}: ${n}`));
    const head = new Uint8Array(await main.file.slice(0, edfHeader.headerBytes).arrayBuffer());
    mneWarnings = edfReadWarnings(head);
  }

  progress("open", 0);
  const files = format === "brainvision" ? [main.file, eegEntry.file, vmrkEntry.file] : [main.file];
  const rec = await openRecording(files, {
    fileName,
    fingerprint: true,
    amplitude: false,
    requireShown: false,
    worker: options.worker,
    onProgress: (p) => progress(p.stage, p.fraction),
  });
  try {
    const sfreq = rec.sfreq;
    const nSamples = rec.nSamples;
    const names = rec.channels.map((c) => c.name);
    if (format === "brainvision") {
      const bv = bvReadWarnings({ vhdrBytes, vmrkBytes, header });
      if (bv.fatal) throw new RecordingError(`${fileName} could not be read as a ${formatName} recording: ${bv.fatal}`, "corrupt_recording");
      mneWarnings = bv.warnings;
    }
    // the annotations as MNE holds them
    const raw =
      format === "brainvision"
        ? rec.annotations.map((a) => ({ onset: a.onsetSample / sfreq, duration: a.durationSamples / sfreq, description: a.description, channels: [] }))
        : rec.annotations;
    const held = mneAnnotations(raw, nSamples, sfreq, format === "brainvision" && rec.measDate !== null);
    if (held.omitted) {
      throw new RecordingError(
        "The recording appears to be incomplete or inconsistent. Some markers lie beyond the end of the EEG data, so the data file is " +
          "probably truncated (for example an interrupted copy). Details: " +
          `Omitted ${held.omitted} annotation(s) that were outside data range.`,
        "inconsistent_recording",
      );
    }
    mneWarnings.push(...cropWarnings(0, held.limited));
    const anns = held.annotations;

    const timing = {
      sfreq,
      n_samples: nSamples,
      first_samp: 0,
      meas_date: rec.measDate,
      duration_s: nSamples / sfreq,
    };
    const warnings = [...edfNotes, ...mneWarnings.map((m) => `MNE: ${m}`), ...sidecars.warnings.map((w) => `BIDS: ${w}`)];

    progress("checks", 0);
    const { report: channelReport, types: tsvTypes } = await checkChannels(
      names,
      sidecars.channelsTsv,
      sidecars.channelsTsv ? shown(sidecars.channelsTsv.path) : "",
    );
    warnings.push(...channelReport.problems.map((p) => `Channels: ${p}`));
    // each channel's type: the file's, then channels.tsv's, then the channels.types setting
    const fileTypes = new Map(names.map((n, i) => [n, rec.mneTypes[i]]));
    const resolved = new Map(fileTypes);
    if (s.applyTypes) for (const [ch, t] of tsvTypes) if (resolved.has(ch)) resolved.set(ch, t);
    for (const [ch, t] of typesFromPatterns(names, s.typePatterns)) resolved.set(ch, t);
    const triggers = names.filter((n) => resolved.get(n) === "stim");

    // original events
    const rel = (entry) => (entry ? entry.path : null);
    let original;
    if (sidecars.eventsTsv) {
      let columns;
      let rows;
      try {
        [columns, rows] = await readTsv(sidecars.eventsTsv.file, shown(sidecars.eventsTsv.path));
      } catch (e) {
        if (e instanceof TsvError) {
          throw new RecordingError(`The BIDS events file ${sidecars.eventsTsv.name} is malformed: ${e.message}`, "malformed_bids_metadata");
        }
        throw e;
      }
      original = eventsFromTsv(columns, rows, sidecars.eventsTsv.name, rel(sidecars.eventsTsv), sfreq);
      original.comparison = compareWithMarkers(original, anns, sfreq, format);
      if (!original.comparison.consistent) {
        const where = format === "brainvision" ? "the BrainVision marker file" : `the ${formatName}+ annotations`;
        warnings.push(
          `events.tsv and ${where} disagree: ${original.comparison.events_tsv_rows_without_marker} events.tsv row(s) have no marker ` +
            `and ${original.comparison.markers_without_events_tsv_row} marker(s) have no events.tsv row`,
        );
      }
    } else {
      original = eventsFromAnnotations(anns, sfreq, format, format === "brainvision" ? rel(vmrkEntry) : path);
      if (original.source === SOURCE_NONE && triggers.length) {
        progress("triggers", 0);
        const mask = format === "bdf" ? 0xffff : -1;
        const found = [];
        const scanned = new Set(format === "brainvision" ? [] : names.filter((n, i) => rec.mneTypes[i] === "stim"));
        for (const t of rec.triggers || []) if (triggers.includes(t.channel) && scanned.has(t.channel)) found.push(t);
        const others = triggers.filter((n) => !scanned.has(n)).map((n) => names.indexOf(n));
        if (others.length) found.push(...(await rec.findTriggerEvents(others, { mask })));
        original = eventsFromTriggers(found, triggers, path, sfreq);
      }
    }
    const clash = ELECTROTAG_COLUMNS.filter((c) => original.columns.includes(c));
    if (clash.length) {
      throw new RecordingError(
        `The recording's events.tsv already has column(s) ${clash.join(", ")}, which ElectroTag uses for its ` +
          "own information (is it an ElectroTag output file?). Rename them in a copy of the dataset.",
        "malformed_bids_metadata",
      );
    }
    const outOfRange = [];
    original.sample.forEach((x, i) => {
      if (x !== null && !(x >= 0 && x < nSamples)) outOfRange.push(i + 1);
    });
    if (outOfRange.length) {
      warnings.push(`${outOfRange.length} original event(s) lie outside the recording: rows ${pyListRepr(outOfRange.slice(0, 10))}`);
    }
    warnings.push(...original.problems.map((p) => `Events: ${p}`));
    const eventReport = eventCodeReport(original, catalogueOf(options));
    warnings.push(...eventReport.summary.map((line) => `Events: ${line}`));

    const eventsSidecar = await loadJsonChain(sidecars.eventsJsonChain);
    warnings.push(...eventsSidecar.problems.map((p) => `BIDS: ${p}`));
    const eegSidecar = await loadJsonChain(sidecars.eegJsonChain);
    warnings.push(...eegSidecar.problems.map((p) => `BIDS: ${p}`));
    const isNum = (v) => typeof v === "number" || typeof v === "boolean";
    const sfJson = eegSidecar.merged.SamplingFrequency;
    if (isNum(sfJson) && Math.abs(Number(sfJson) - sfreq) > 1e-6) {
      warnings.push(
        `eeg.json SamplingFrequency (${pyValueText(sfJson, eegSidecar.numberText.get("SamplingFrequency"))} Hz) differs from the ` +
          `recording (${pyFloatRepr(sfreq)} Hz)`,
      );
    }
    const plf = eegSidecar.merged.PowerLineFrequency;
    if (s.filters.notch_enabled && isNum(plf) && Number(plf) !== s.filters.notch_hz) {
      warnings.push(
        `eeg.json gives a power-line frequency of ${pyValueText(plf, eegSidecar.numberText.get("PowerLineFrequency"))} Hz but the notch ` +
          `filter is set to ${pyFormatG(s.filters.notch_hz)} Hz`,
      );
    }

    // stretches without data and discontinuities (loading._acquisition_gaps, _discontinuities)
    const disc = [...new Set(anns.filter((a) => a.description.toLowerCase().startsWith("new segment")).map((a) => timeToSample(a.onset, sfreq)))]
      .filter((x) => x > 0)
      .sort((a, b) => a - b);
    if (disc.length) warnings.push(`The recording has ${disc.length} discontinuity marker(s) (BrainVision 'New Segment')`);
    const gapSet = new Map();
    for (const a of anns) {
      if (!a.description.toLowerCase().startsWith("bad_acq_skip")) continue;
      let start = timeToSample(a.onset, sfreq);
      let stop = start + Math.max(1, timeToSample(a.duration, sfreq));
      start = Math.max(0, start);
      stop = Math.min(nSamples, stop);
      if (stop > start) gapSet.set(`${start}:${stop}`, [start, stop]);
    }
    const gaps = [...gapSet.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    if (gaps.length) {
      const total = gaps.reduce((acc, [a, b]) => acc + (b - a), 0) / sfreq;
      const tail = gaps.length === 1 && gaps[0][1] === nSamples ? " (at the end of the file, probably padding of the last data record)" : "";
      warnings.push(
        `The file marks ${gaps.length} stretch(es) without recorded data (BAD_ACQ_SKIP), ${pyFixed(total, 3)} s in total` +
          `${tail}; they are hatched in the viewer and filtered separately`,
      );
    }

    // the channels shown, hidden and their display types
    const hiddenBySetting = names.filter((c) => s.hide.some((p) => fnmatchCase(c, p)));
    const hiddenSet = new Set([...hiddenBySetting, ...triggers]);
    const hidden = names.filter((c) => hiddenSet.has(c));
    const shownChannels = names.filter((c) => !hiddenSet.has(c));
    if (!shownChannels.length) {
      throw new RecordingError(
        "Every channel of the recording matches the channels.hide setting or is a trigger channel, so nothing " +
          "could be shown. Change channels.hide or channels.types in the study configuration.",
        "no_channels",
      );
    }
    const notes = [];
    if (hiddenBySetting.length) {
      notes.push(
        `${hiddenBySetting.length} channel(s) matching channels.hide are not shown and cannot be annotated: ${hiddenBySetting.join(", ")}`,
      );
    }
    if (triggers.length) {
      const used = original.stim_channels.length ? "; the original events were read from them" : "";
      notes.push(`Trigger channel(s) not shown and not part of the montage${used}: ${triggers.join(", ")}`);
    }
    const viewTypes = new Map(shownChannels.map((c) => [c, fileTypes.get(c)]));
    if (s.applyTypes && tsvTypes.size) {
      let n = 0;
      for (const [ch, t] of tsvTypes) {
        if (viewTypes.has(ch) && viewTypes.get(ch) !== t) {
          viewTypes.set(ch, t);
          n++;
        }
      }
      if (n) notes.push(`Display channel types set from channels.tsv for ${n} channel(s)`);
    }
    const shownBads = channelReport.bids_bad_channels.filter((c) => viewTypes.has(c));
    const bads = s.showBads && shownBads.length ? shownBads : [];
    if (bads.length) notes.push(`Channels marked bad in channels.tsv are shown in grey: ${bads.join(", ")}`);
    let changed = 0;
    for (const [ch, t] of typesFromPatterns(shownChannels, s.typePatterns)) {
      if (viewTypes.get(ch) !== t) {
        viewTypes.set(ch, t);
        changed++;
      }
    }
    if (changed) notes.push(`Display channel types set from the channels.types setting for ${changed} channel(s)`);

    // the display filters and the amplitude check (on the display copy, as the desktop measures it)
    const f = s.filters;
    const needsData = f.highpass_enabled || f.notch_enabled;
    let jsFilters = null;
    if (needsData) {
      jsFilters = { highpassHz: null, notchHz: null, notchHarmonics: f.notch_harmonics };
      if (f.highpass_enabled) {
        if (f.highpass_hz >= sfreq / 2) warnings.push(`Filters: High-pass ${pyFloatRepr(f.highpass_hz)} Hz skipped: not below Nyquist (${pyFloatRepr(sfreq / 2)} Hz)`);
        else jsFilters.highpassHz = f.highpass_hz;
      }
      if (f.notch_enabled) {
        if (!notchFrequencies(f, sfreq).length) {
          warnings.push(`Filters: Notch at ${pyFloatRepr(f.notch_hz)} Hz skipped: not below Nyquist (${pyFloatRepr(sfreq / 2)} Hz)`);
        } else jsFilters.notchHz = f.notch_hz;
      }
    }
    progress("amplitude", 0);
    let amp;
    try {
      amp = await rec.checkAmplitude({
        filters: jsFilters,
        types: names.map((n) => (viewTypes.has(n) ? viewTypes.get(n) : resolved.get(n))),
        hidden: names.map((n) => hiddenSet.has(n)),
      });
    } catch (e) {
      amp = { amplitudesV: {}, suggestedScalings: {}, warnings: [] };
      warnings.push(`The signal amplitude could not be checked: ${e.message}`);
    }
    warnings.push(...amp.warnings);
    progress("amplitude", 1);

    // fingerprints
    progress("fingerprint", 0);
    const fingerprint = {};
    for (const [role, entry] of roles) {
      let hex;
      if (role === "eeg") hex = (await rec.fingerprint((x) => progress("fingerprint", x))).hex;
      else hex = await sha256Blob(entry.file);
      fingerprint[role] = { path: entry.path, size: entry.file.size, mtime_ns: Math.floor(entry.file.lastModified) * 1e6, sha256: hex };
    }
    progress("fingerprint", 1);

    const manifest = {
      schema: SCHEMA,
      schema_version: SCHEMA_VERSION,
      created_at: nowLocalIso(),
      electrotag_version: options.version || "browser",
      scope,
      recording_id: path,
      relative_path: path,
      format,
      format_name: formatName,
      file_name: fileName,
      files: {
        stem: stemOf(fileName),
        path,
        vhdr: format === "brainvision" ? path : null,
        eeg: eegEntry.path,
        vmrk: vmrkEntry ? vmrkEntry.path : null,
        channels_tsv: rel(sidecars.channelsTsv),
        events_tsv: rel(sidecars.eventsTsv),
        events_json_chain: sidecars.eventsJsonChain.map(rel),
        eeg_json_chain: sidecars.eegJsonChain.map(rel),
      },
      timing,
      ch_names: shownChannels,
      hidden_channels: hidden,
      trigger_channels: triggers,
      channel_types: Object.fromEntries(shownChannels.map((c) => [c, viewTypes.get(c) || "eeg"])),
      bad_channels: bads,
      fingerprint,
      original_events: original,
      events_sidecar: eventsSidecar.merged,
      event_report: eventReport,
      channel_report: channelReport,
      amplitude: {
        report: {
          measure: "median over channels of the 99.5th percentile of |x - median| in sampled windows (V)",
          amplitudes_v: { ...amp.amplitudesV },
          display_scalings_set_automatically: { ...amp.suggestedScalings },
        },
        suggested_scalings: { ...amp.suggestedScalings },
        warnings: [...amp.warnings],
      },
      acquisition_gaps: gaps,
      discontinuity_samples: disc,
      warnings,
      notes,
    };
    return { manifest, problems: [...warnings] };
  } finally {
    rec.close();
  }
}

/** The dataset of a recording given without one (its own files, in one folder). */
function datasetOf(recording) {
  const entries = Array.from(recording.files || []).map((file) => {
    const { root, path } = locate(file);
    return { root, path, file };
  });
  const root = entries.length ? entries[0].root : "";
  const list = entries.filter((e) => e.root === root).map(({ path, file }) => ({ path, file }));
  return { root, tree: folderTree(list), byPath: new Map(list.map((e) => [e.path, e])) };
}

/**
 * Every recording among the picked files, one after the other (each read in its own worker, so the
 * page stays responsive), with progress.
 * @param {ArrayLike<File>} files
 * @param {{settings?: object, scope?: string, catalogue?: object, worker?: boolean, version?: string,
 *          signal?: AbortSignal,
 *          onProgress?: (p: {index: number, total: number, recordingId: string, stage: string, fraction: number,
 *                            overall: number}) => void}} [options]
 * @returns {Promise<{manifests: object[], failures: {path: string, reason: string, kind: string}[],
 *          ignored: {path: string, reason: string}[], problems: Record<string, string[]>}>}
 */
export async function buildManifests(files, options = {}) {
  catalogueOf(options);
  const { recordings, ignored } = findDatasetRecordings(files, options);
  const manifests = [];
  const failures = [];
  const problems = {};
  const total = recordings.length;
  const say = (p) => {
    if (options.onProgress) options.onProgress(p);
  };
  for (let index = 0; index < total; index++) {
    if (options.signal && options.signal.aborted) break;
    const r = recordings[index];
    const base = { index, total, recordingId: r.recordingId };
    say({ ...base, stage: "start", fraction: 0, overall: index / total });
    try {
      const out = await buildManifest(r, {
        ...options,
        onProgress: (p) => say({ ...base, stage: p.stage, fraction: p.fraction, overall: (index + Math.min(1, Math.max(0, p.fraction || 0)) * 0.99) / total }),
      });
      manifests.push(out.manifest);
      problems[r.recordingId] = out.problems;
    } catch (e) {
      failures.push({ path: r.recordingId, reason: e && e.message ? e.message : String(e), kind: (e && e.kind) || "load_error" });
    }
    say({ ...base, stage: "done", fraction: 1, overall: (index + 1) / total });
  }
  return { manifests, failures, ignored, problems };
}

export { column };
