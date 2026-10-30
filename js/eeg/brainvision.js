// BrainVision recordings (.vhdr header, .vmrk markers, .eeg data) read in the browser, giving the
// same values, channel names, markers and measurement date as MNE-Python's read_raw_brainvision,
// with the desktop application's checks of the data file's size. BINARY data only, MULTIPLEXED
// or VECTORIZED, INT_16, INT_32 or IEEE_FLOAT_32. Plain ES module.

import { inferChannelType } from "./channels.js";
import { RecordingError, decodeAsciiIgnore, decodeBrainVisionText, isoUtc, daysInMonth } from "./util.js";
import { describeRecording } from "./edf.js";
import { pyStrRepr } from "./pyfmt.js";

/** MNE's _unit_dict: factors to SI units. */
const UNIT_FACTORS = {
  V: 1.0,
  "µV": 1e-6,
  uV: 1e-6,
  mV: 1e-3,
  nV: 1e-9,
  C: 1,
  "°C": 1,
  "n/a": 1,
  "µS": 1e-6,
  uS: 1e-6,
  ARU: 1,
  S: 1,
  N: 1,
};
const VOLTAGE_UNITS = ["V", "mV", "µV", "uV", "nV"];
const FORMATS = { INT_16: { bytes: 2, kind: "int16" }, INT_32: { bytes: 4, kind: "int32" }, IEEE_FLOAT_32: { bytes: 4, kind: "float32" } };
/** The desktop's BYTES_PER_SAMPLE, used for its size check. */
const DESKTOP_BYTES = { INT_16: 2, INT_32: 4, IEEE_FLOAT_32: 4, UINT_16: 2 };
/** MNE's default EOG channel names for BrainVision. */
const MNE_EOG = ["HEOGL", "HEOGR", "VEOGb"];
const TARGET_BLOCK_SAMPLES = 32768;
const MAX_BLOCK_BYTES = 16 * 1024 * 1024;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const VERSION_RE = (kind, v) => new RegExp(`Brain ?Vision( Core| V-Amp)? Data( Exchange)? ${kind} File,? Version ${v}\\.0`);

/**
 * Python configparser semantics for a BrainVision header: sections are case-sensitive, option
 * names are lower case, values are stripped, full-line comments start with ';' or '#', indented
 * lines continue the previous value.
 * @param {string} text
 * @returns {Map<string, Map<string, string>>}
 */
export function parseIni(text) {
  const sections = new Map();
  let current = null;
  let lastKey = null;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const stripped = rawLine.trim();
    if (!stripped) {
      lastKey = null;
      continue;
    }
    if (stripped.startsWith(";") || stripped.startsWith("#")) continue;
    const indented = /^\s/.test(rawLine);
    if (indented && current && lastKey !== null) {
      current.set(lastKey, current.get(lastKey) + "\n" + stripped);
      continue;
    }
    const sec = /^\[(.+)\]$/.exec(stripped);
    if (sec) {
      const name = sec[1];
      if (!sections.has(name)) sections.set(name, new Map());
      current = sections.get(name);
      lastKey = null;
      continue;
    }
    if (!current) throw new RecordingError("The BrainVision header has text before its first section", "corrupt_recording");
    const m = /^(.*?)\s*[=:]\s*(.*)$/.exec(stripped);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    current.set(key, m[2].trim());
    lastKey = key;
  }
  return sections;
}

/** MNE's _str_to_meas_date for the 20-digit BrainVision date (YYYYMMDDhhmmssffffff). */
function bvDate(s) {
  const t = s.trim();
  if (t === "" || t === "0" || t === "00000000000000000000") return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{6})$/.exec(t);
  if (!m) return null;
  const [y, mo, d, h, mi, se, us] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || se > 59) return null;
  return isoUtc(y, mo, d, h, mi, se, us);
}

function pyFloat(text, what) {
  const t = String(text).trim();
  if (!/^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|inf|infinity|nan)$/i.test(t)) {
    throw new RecordingError(`The BrainVision header gives an unreadable ${what}: '${text}'`, "corrupt_recording");
  }
  return Number(t.replace(/^([+-]?)inf(inity)?$/i, "$1Infinity"));
}

function pyInt(text, what) {
  const t = String(text).trim();
  if (!/^[+-]?\d+$/.test(t)) throw new RecordingError(`The BrainVision header gives an unreadable ${what}: '${text}'`, "corrupt_recording");
  return parseInt(t, 10);
}

/**
 * Names given to more than one channel, with the channels' numbers (from 1), in the order of
 * their first channel (VhdrHeader.duplicate_names in electrotag/app/io/discovery.py).
 * @param {string[]} names
 * @returns {[string, number[]][]}
 */
export function duplicateNames(names) {
  const seen = new Map();
  names.forEach((name, i) => {
    if (!name) return;
    if (!seen.has(name)) seen.set(name, []);
    seen.get(name).push(i + 1);
  });
  return [...seen].filter(([, idx]) => idx.length > 1);
}

/**
 * Plain words for names shared by several channels, as duplicate_names_problem words them in
 * electrotag/app/eeg/loading.py.
 * @param {[string, number[]][]} duplicates
 */
export function duplicateNamesProblem(duplicates) {
  const numbers = (idx) => `${idx.slice(0, -1).join(", ")} and ${idx[idx.length - 1]}`;
  const parts = duplicates.slice(0, 5).map(([name, idx]) => `${pyStrRepr(name)} to channels ${numbers(idx)}`);
  if (duplicates.length > 5) parts.push(`${duplicates.length - 5} more name(s) to several channels`);
  const listed = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return (
    `its header gives the name ${listed}. MNE-Python, which ElectroTag uses to read recordings, cannot ` +
    "read a BrainVision recording whose channels share a name: give each channel a name of its own in a " +
    "copy of the header (the .vhdr file, which is text) and open the copy"
  );
}

/**
 * The header of a BrainVision recording.
 * @param {Uint8Array} bytes the .vhdr file
 * @param {string} fileName
 */
export function parseVhdr(bytes, fileName) {
  let nl = bytes.indexOf(0x0a);
  if (nl < 0) nl = bytes.length;
  const firstLine = decodeAsciiIgnore(bytes.subarray(0, nl)).trim();
  const warnings = [];
  if (!VERSION_RE("Header", 1).test(firstLine) && !VERSION_RE("Header", 2).test(firstLine)) {
    warnings.push(firstLine === "" ? "MNE: Missing header in header file." : `MNE: MNE-Python currently only supports header versions 1.0 and 2.0, got unparsable '${firstLine}'.`);
  }
  const { text, encoding } = decodeBrainVisionText(bytes.subarray(Math.min(nl + 1, bytes.length)));
  const cut = text.indexOf("[Comment]");
  const params = cut >= 0 ? text.slice(0, cut) : text;
  const cfg = parseIni(params);
  let common = "Common Infos";
  if (!cfg.has(common)) common = "Common infos";
  const ci = cfg.get(common) || new Map();
  const need = (key, label) => {
    const v = ci.get(key);
    if (v === undefined) throw new RecordingError(`${fileName} does not give ${label} (${common}: ${label})`, "corrupt_recording");
    return v;
  };
  const sfreq = 1e6 / pyFloat(need("samplinginterval", "SamplingInterval"), "SamplingInterval");
  const orientation = need("dataorientation", "DataOrientation");
  if (orientation !== "MULTIPLEXED" && orientation !== "VECTORIZED") {
    throw new RecordingError(`${fileName}: data orientation ${orientation} is not supported`, "unsupported_format");
  }
  const dataFormat = need("dataformat", "DataFormat");
  if (dataFormat !== "BINARY") {
    throw new RecordingError(
      `${fileName} holds its data as ${dataFormat} text, which the browser version cannot read; ` +
        "convert the recording to binary BrainVision, EDF or BDF first.",
      "unsupported_format",
    );
  }
  const binary = cfg.get("Binary Infos") || new Map();
  const binaryFormat = binary.get("binaryformat");
  if (!binaryFormat || !FORMATS[binaryFormat]) {
    throw new RecordingError(`${fileName}: binary format ${binaryFormat || "(missing)"} is not supported`, "unsupported_format");
  }
  const dataFile = need("datafile", "DataFile");
  const markerFile = ci.get("markerfile") || "";
  const nChannels = pyInt(need("numberofchannels", "NumberOfChannels"), "NumberOfChannels");
  const dataPointsText = ci.get("datapoints");
  const names = new Array(nChannels).fill("");
  const cals = new Array(nChannels).fill(NaN);
  const ranges = new Array(nChannels).fill(NaN);
  const units = new Array(nChannels).fill("");
  const keyToName = new Map();
  const misc = new Set();
  if (!cfg.has("Channel Infos")) {
    // configparser's NoSectionError, which MNE-Python raises
    throw new RecordingError(`${fileName} could not be read as a BrainVision recording: No section: 'Channel Infos'`, "corrupt_recording");
  }
  const chInfos = cfg.get("Channel Infos");
  for (const [key, value] of chInfos) {
    const m = /ch(\d+)/.exec(key);
    if (!m) continue;
    const n = parseInt(m[1], 10) - 1;
    if (n >= nChannels || n < 0) continue;
    const props = value.split(",");
    if (props.length < 4) props.push("µV");
    else if (props[3] === "") props[3] = "µV";
    const name = props[0].replace(/\\1/g, ",");
    let resolution = props[2];
    let unit = props[3];
    if (resolution === "") resolution = unit ? 1.0 : 0.000001;
    unit = unit.replace(/Â/g, "");
    keyToName.set(key, name);
    names[n] = name;
    units[n] = unit;
    cals[n] = typeof resolution === "number" ? resolution : pyFloat(resolution, `resolution of ${name}`);
    ranges[n] = (UNIT_FACTORS[unit] ?? 1) * 1.0;
    if (!VOLTAGE_UNITS.includes(unit)) misc.add(name);
  }
  const missing = cals.map((c, i) => (Number.isNaN(c) ? i : -1)).filter((i) => i >= 0);
  const duplicates = duplicateNames(names);
  if (duplicates.length) {
    // MNE-Python renames duplicates and then fails ("Channel Cz-0 has no associated original unit")
    throw new RecordingError(`${fileName} could not be read as a BrainVision recording: ${duplicateNamesProblem(duplicates)}`, "corrupt_recording");
  }
  if (missing.length) {
    throw new RecordingError(`${fileName}: incomplete [Channel Infos]: missing entries at indices [${missing.join(", ")}]`, "corrupt_recording");
  }
  // channels placed at the origin in [Coordinates] are not electrodes (MNE makes them misc)
  const coords = cfg.get("Coordinates");
  if (coords) {
    for (const [key, value] of coords) {
      const name = keyToName.get(key);
      if (name === undefined) continue;
      const rad = Number(value.split(",")[0]);
      if (rad === 0 && !MNE_EOG.includes(name) && !misc.has(name)) misc.add(name);
    }
  }
  const mneTypes = names.map((name) => (MNE_EOG.includes(name) ? "eog" : misc.has(name) ? "misc" : name === "STI 014" ? "stim" : "eeg"));
  return { sfreq, orientation, binaryFormat, dataFile, markerFile, nChannels, dataPointsText, names, cals, ranges, units, mneTypes, encoding, warnings };
}

/**
 * Markers of a .vmrk file as MNE's _read_mrk reads them, and the measurement date.
 * @param {Uint8Array} bytes
 */
export function parseVmrk(bytes) {
  const warnings = [];
  const headerLine = decodeAsciiIgnore(bytes).split("\n")[0].trim();
  if (!VERSION_RE("Marker", 1).test(headerLine) && !VERSION_RE("Marker", 2).test(headerLine)) {
    warnings.push(headerLine === "" ? "MNE: Missing header in marker file." : `MNE: MNE-Python currently only supports marker versions 1.0 and 2.0, got unparsable '${headerLine}'.`);
  }
  const { text } = decodeBrainVisionText(bytes);
  const markers = [];
  let measDate = null;
  // measurement date: the first New Segment marker with a 20-digit date (MNE's regexp on stripped lines)
  for (const line of text.split("\n")) {
    const m = /^Mk\d+=New Segment,.*,\d+,\d+,-?\d+,(\d{20})$/.exec(line.trim());
    if (m) {
      measDate = bvDate(m[1]);
      break;
    }
  }
  const start = /\[Marker Infos\]/i.exec(text);
  if (!start) return { markers, measDate, warnings };
  const mkText = text.slice(start.index + start[0].length);
  const re = /^Mk\d+=([^\n]*)/gm;
  let m;
  while ((m = re.exec(mkText)) !== null) {
    const info = m[1].split(",");
    if (info.length < 4) throw new RecordingError(`A marker line of the .vmrk file has fewer than four fields: ${m[0].trim()}`, "corrupt_recording");
    const type = info[0].replace(/\\1/g, ",");
    const desc = info[1].replace(/\\1/g, ",");
    const pos = String(info[2]).trim();
    if (!/^[+-]?\d+$/.test(pos)) throw new RecordingError(`A marker of the .vmrk file has an unreadable position: ${m[0].trim()}`, "corrupt_recording");
    const durText = info[3];
    const duration = /^\d+$/.test(durText) ? parseInt(durText, 10) : 0;
    markers.push({ type, desc, onset: parseInt(pos, 10) - 1, duration });
  }
  if (markers.length && markers[0].type === "New Segment") markers.shift();
  return { markers, measDate, warnings };
}

/** An open BrainVision recording. */
export class BrainVisionSource {
  /**
   * @param {{vhdr: File, vmrk: File | null, eeg: File}} files
   * @param {object} header from parseVhdr
   */
  static async open(files, header) {
    const vhdrName = files.vhdr.name;
    const eeg = files.eeg;
    const size = eeg.size;
    // the desktop's check of the data file (loading._check_data_size)
    const bps = DESKTOP_BYTES[header.binaryFormat];
    const frame = header.nChannels * bps;
    if (size === 0) throw new RecordingError(`Data file ${eeg.name} is empty`, "corrupt_recording");
    if (size % frame !== 0) {
      throw new RecordingError(
        `Data file ${eeg.name} has ${size} bytes, which is not a whole number of samples ` +
          `for ${header.nChannels} channels of ${header.binaryFormat}. The file is probably truncated or corrupted.`,
        "corrupt_recording",
      );
    }
    if (header.dataPointsText !== undefined && header.dataPointsText !== "") {
      const dp = /^[+-]?\d+$/.test(header.dataPointsText.trim()) ? parseInt(header.dataPointsText, 10) : null;
      if (dp !== null && dp !== size / frame) {
        throw new RecordingError(`Header says ${dp} samples but ${eeg.name} contains ${size / frame}`, "corrupt_recording");
      }
    }
    let mrk = { markers: [], measDate: null, warnings: [] };
    if (files.vmrk) mrk = parseVmrk(new Uint8Array(await files.vmrk.arrayBuffer()));
    return new BrainVisionSource(files, header, mrk, vhdrName);
  }

  constructor(files, header, mrk, vhdrName) {
    this.format = "brainvision";
    this.file = files.eeg;
    this.fileName = vhdrName;
    this.h = header;
    this.mrk = mrk;
    const fmt = FORMATS[header.binaryFormat];
    this.bps = fmt.bytes;
    this.kind = fmt.kind;
    this.nCh = header.nChannels;
    this.sfreq = header.sfreq;
    this.nSamples = Math.floor(this.file.size / (this.bps * this.nCh));
    this.k = header.ranges.map((r, i) => r * header.cals[i]); // MNE's _cals: range * cal
    this.channels = header.names.map((name, i) => {
      const t = header.mneTypes[i];
      const type = t === "eeg" ? inferChannelType(name) : t;
      return { name, type, unit: VOLTAGE_UNITS.includes(header.units[i]) ? "V" : header.units[i], origUnit: header.units[i] };
    });
    const bySamples = Math.max(1, TARGET_BLOCK_SAMPLES);
    const byBytes = Math.max(1, Math.floor(MAX_BLOCK_BYTES / (this.bps * this.nCh)));
    this.blockSamples = Math.max(1, Math.min(bySamples, byBytes));
    this.needsScan = false;
    this.notes = [...header.warnings, ...mrk.warnings];
  }

  get measDate() {
    return this.mrk.measDate;
  }

  get nBlocks() {
    return Math.ceil(this.nSamples / this.blockSamples);
  }

  /** The stored bytes of samples [b * blockSamples, ...), decoded on demand. @param {number} b */
  async readBlock(b) {
    const s0 = b * this.blockSamples;
    const s1 = Math.min(this.nSamples, s0 + this.blockSamples);
    const n = s1 - s0;
    if (this.h.orientation === "MULTIPLEXED") {
      const frame = this.bps * this.nCh;
      const buf = await this.file.slice(s0 * frame, s1 * frame).arrayBuffer();
      if (buf.byteLength < n * frame) throw new RecordingError(`${this.file.name} could not be read`, "read_error");
      return new BvBlock(this, n, [this._view(buf, n * this.nCh)], buf.byteLength);
    }
    const bufs = await Promise.all(
      Array.from({ length: this.nCh }, (_, c) => {
        const a = (c * this.nSamples + s0) * this.bps;
        return this.file.slice(a, a + n * this.bps).arrayBuffer();
      }),
    );
    let bytes = 0;
    const views = bufs.map((buf) => {
      if (buf.byteLength < n * this.bps) throw new RecordingError(`${this.file.name} could not be read`, "read_error");
      bytes += buf.byteLength;
      return this._view(buf, n);
    });
    return new BvBlock(this, n, views, bytes);
  }

  /** The little-endian samples of buf as numbers (a typed view where the platform allows it). */
  _view(buf, count) {
    if (LITTLE_ENDIAN) {
      if (this.kind === "int16") return new Int16Array(buf, 0, count);
      if (this.kind === "int32") return new Int32Array(buf, 0, count);
      return new Float32Array(buf, 0, count);
    }
    const dv = new DataView(buf);
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = this.kind === "int16" ? dv.getInt16(2 * i, true) : this.kind === "int32" ? dv.getInt32(4 * i, true) : dv.getFloat32(4 * i, true);
    }
    return out;
  }

  describe() {
    const annotations = this.mrk.markers.map((m) => ({
      onsetSample: m.onset,
      durationSamples: m.duration,
      description: `${m.type}/${m.desc}`,
    }));
    return describeRecording({
      format: "brainvision",
      sfreq: this.sfreq,
      nSamples: this.nSamples,
      annotations,
      triggers: [],
      channels: this.channels,
      warnings: [...this.notes],
    });
  }
}

/** Samples of a block as stored, decoded on demand. */
class BvBlock {
  constructor(src, n, views, byteLength) {
    this.src = src;
    this.n = n;
    this.views = views;
    this.byteLength = byteLength;
  }

  /** Samples [a, b) of channel c, in volts, into out from index o. */
  decode(c, a, b, out, o) {
    const k = this.src.k[c];
    if (this.views.length === 1) {
      const vals = this.views[0];
      const nCh = this.src.nCh;
      for (let q = a, p = a * nCh + c; q < b; q++, p += nCh) out[o + q - a] = vals[p] * k;
    } else {
      const vals = this.views[c];
      for (let q = a; q < b; q++) out[o + q - a] = vals[q] * k;
    }
  }
}
