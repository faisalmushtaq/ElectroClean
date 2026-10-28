// EDF, EDF+ and BDF recordings read in the browser, giving the same values as MNE-Python's
// read_raw_edf / read_raw_bdf with infer_types=False (what the desktop application uses), and
// checked against the header the same way as the desktop (electroclean/app/io/edf.py).
// Plain ES module.

import { inferChannelType, isMneEdfStim, uniqueChannelNames } from "./channels.js";
import { RecordingError, decodeLatin1, isoUtc, daysInMonth, timeToSample } from "./util.js";

const TAL_LABELS = ["EDF Annotations", "BDF Annotations"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
/** Decoded samples per channel aimed for in one block of the cache. */
const TARGET_BLOCK_SAMPLES = 32768;
/** At most this many bytes are read for one block (unless one data record is larger). */
const MAX_BLOCK_BYTES = 16 * 1024 * 1024;
/** Bytes read at a time while scanning annotations and triggers. */
const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Python's bytes.strip(): ASCII whitespace at both ends. */
function stripAsciiBytes(bytes) {
  const ws = (b) => b === 0x20 || (b >= 0x09 && b <= 0x0d);
  let a = 0;
  let b = bytes.length;
  while (a < b && ws(bytes[a])) a++;
  while (b > a && ws(bytes[b - 1])) b--;
  return bytes.subarray(a, b);
}

/** MNE's _edf_str: latin-1, up to the first NUL. */
function edfStr(bytes) {
  const s = decodeLatin1(bytes);
  const nul = s.indexOf("\x00");
  return nul >= 0 ? s.slice(0, nul) : s;
}

/** Python's int() of a header field (surrounding whitespace allowed). */
function pyInt(text) {
  const t = text.trim();
  if (!/^[+-]?\d+$/.test(t.replace(/_/g, ""))) throw new Error(`invalid literal for int(): '${text}'`);
  return parseInt(t.replace(/_/g, ""), 10);
}

/** Python's float() of a header field. */
function pyFloat(text) {
  const t = text.trim();
  if (!/^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|inf|infinity|nan)$/i.test(t)) {
    throw new Error(`could not convert string to float: '${text}'`);
  }
  return Number(t.replace(/^([+-]?)inf(inity)?$/i, "$1Infinity"));
}

/** The desktop's _field: latin-1, Unicode whitespace stripped. */
function deskField(bytes) {
  return decodeLatin1(bytes).trim();
}

/** MNE's measurement date of an EDF header (ISO string or null). */
function parseMeasDate(recordingField, dateField, timeField) {
  const recInfo = decodeLatin1(recordingField).replace(/\s+$/, "").split(" ");
  let ymd = null;
  if (recInfo.length === 5) {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(recInfo[1]);
    if (m) {
      const month = MONTHS.indexOf(m[2].toUpperCase()) + 1;
      const day = Number(m[1]);
      const year = Number(m[3]);
      if (month > 0 && day >= 1 && day <= daysInMonth(year, month)) ymd = [year, month, day];
    }
  }
  if (ymd === null) {
    try {
      const parts = decodeLatin1(dateField).split(".");
      if (parts.length !== 3) throw new Error("date");
      const [day, month, yy] = parts.map(pyInt);
      const year = yy < 85 ? yy + 2000 : yy + 1900;
      if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw new Error("date");
      ymd = [year, month, day];
    } catch {
      return null;
    }
  }
  let hour = 0;
  let minute = 0;
  let second = 0;
  try {
    const parts = decodeLatin1(timeField).split(".");
    if (parts.length !== 3) throw new Error("time");
    [hour, minute, second] = parts.map(pyInt);
  } catch {
    hour = minute = second = 0;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  return isoUtc(ymd[0], ymd[1], ymd[2], hour, minute, second);
}

/** MNE's unit factor for an EDF physical dimension. */
function unitFactor(unit) {
  if (unit === "μV" || unit === "µV" || unit === "\x83\xcaV" || unit === "uV") return 1e-6;
  if (unit === "mV") return 1e-3;
  return 1;
}

/**
 * The header of an EDF, EDF+ or BDF file, checked as the desktop checks it before opening.
 * @param {Blob} file
 * @param {string} fileName
 * @param {"edf" | "bdf"} format from the file name's extension
 */
export async function readEdfHeader(file, fileName, format) {
  const familyName = format === "bdf" ? "BDF" : "EDF";
  const notReadable = (why) => new RecordingError(`${fileName} is not a readable ${familyName} file: ${why}`, "corrupt_recording");
  const main = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  if (main.length < 256) throw notReadable(`${fileName} is too short to hold an EDF header (${main.length} bytes)`);
  const isBdf = main[0] === 0xff;
  if (isBdf) {
    if (decodeLatin1(main.subarray(1, 8)).trim() !== "BIOSEMI") throw notReadable(`${fileName} does not start with a BDF identification code`);
  } else if (deskField(main.subarray(0, 8)) !== "0") {
    throw notReadable(`${fileName} does not start with the EDF version code '0'`);
  }
  if (isBdf !== (format === "bdf")) {
    throw new RecordingError(
      `${fileName} holds a ${isBdf ? "BDF" : "EDF"} header but its name ends in .${format}; ` +
        `rename it to .${isBdf ? "bdf" : "edf"} to open it`,
      "corrupt_recording",
    );
  }
  let headerBytes;
  let nRecords;
  let recordDuration;
  let nSignals;
  try {
    headerBytes = pyInt(deskField(main.subarray(184, 192)));
    nRecords = pyInt(deskField(main.subarray(236, 244)));
    recordDuration = pyFloat(deskField(main.subarray(244, 252)));
    nSignals = pyInt(deskField(main.subarray(252, 256)));
  } catch (e) {
    throw notReadable(`${fileName} has an unreadable header field: ${e.message}`);
  }
  if (nSignals < 1 || headerBytes !== 256 * (nSignals + 1)) {
    throw notReadable(`${fileName}: header size ${headerBytes} does not match ${nSignals} signal(s)`);
  }
  const sig = new Uint8Array(await file.slice(256, 256 * (nSignals + 1)).arrayBuffer());
  if (sig.length < 256 * nSignals) throw notReadable(`${fileName}: the signal headers are incomplete`);
  const reserved = deskField(main.subarray(192, 236));
  let fileType = familyName;
  for (const kind of ["+C", "+D"]) if (reserved.startsWith("EDF" + kind) || reserved.startsWith("BDF" + kind)) fileType = familyName + kind;

  const ns = nSignals;
  const field = (base, width, i) => sig.subarray(base + i * width, base + (i + 1) * width);
  let off = 0;
  const labelsMne = [];
  const labelsDesk = [];
  for (let i = 0; i < ns; i++) {
    labelsMne.push(decodeLatin1(stripAsciiBytes(field(off, 16, i))));
    labelsDesk.push(deskField(field(off, 16, i)));
  }
  off += 16 * ns;
  off += 80 * ns; // transducer
  const units = [];
  for (let i = 0; i < ns; i++) units.push(decodeLatin1(stripAsciiBytes(field(off, 8, i))));
  off += 8 * ns;
  const nums = (o) => {
    const out = [];
    for (let i = 0; i < ns; i++) out.push(pyFloat(edfStr(field(o, 8, i)).replace(/,/g, ".")));
    return out;
  };
  let physMin;
  let physMax;
  let digMin;
  let digMax;
  try {
    physMin = nums(off);
    physMax = nums(off + 8 * ns);
    digMin = nums(off + 16 * ns);
    digMax = nums(off + 24 * ns);
  } catch (e) {
    throw notReadable(`${fileName} has an unreadable header field: ${e.message}`);
  }
  off += 32 * ns;
  off += 80 * ns; // prefiltering
  const spr = [];
  try {
    for (let i = 0; i < ns; i++) spr.push(pyInt(deskField(field(off, 8, i))));
  } catch (e) {
    throw notReadable(`${fileName}: unreadable number of samples per record: ${e.message}`);
  }
  const bps = isBdf ? 3 : 2;
  const recordBytes = spr.reduce((a, b) => a + b, 0) * bps;
  return {
    fileType,
    isBdf,
    bps,
    headerBytes,
    nRecords,
    recordDuration,
    nSignals: ns,
    labelsMne,
    labelsDesk,
    units,
    physMin,
    physMax,
    digMin,
    digMax,
    spr,
    recordBytes,
    measDate: parseMeasDate(main.subarray(88, 168), main.subarray(168, 176), main.subarray(176, 184)),
  };
}

/** The desktop's EdfHeader.size_problems: [fatal problems, notes]. */
export function sizeProblems(h, fileSize) {
  const fatal = [];
  const notes = [];
  const dataBytes = fileSize - h.headerBytes;
  if (h.recordBytes <= 0) {
    fatal.push("the header gives no samples per data record");
    return [fatal, notes];
  }
  if (dataBytes <= 0) {
    fatal.push("the file contains a header but no data");
    return [fatal, notes];
  }
  const whole = Math.floor(dataBytes / h.recordBytes);
  const rest = dataBytes - whole * h.recordBytes;
  const g = (x) => String(Number(x.toPrecision(6)));
  if (h.nRecords === -1) {
    notes.push(
      "the header does not give the number of data records (the recording may not have been stopped " +
        `properly); ${whole} complete record(s) were found`,
    );
    if (rest) notes.push(`the last ${rest} byte(s) do not form a complete data record and are ignored`);
    if (whole === 0) fatal.push("the file does not contain a single complete data record");
    return [fatal, notes];
  }
  if (whole < h.nRecords) {
    fatal.push(
      `the header announces ${h.nRecords} data record(s) of ${g(h.recordDuration)} s but the file holds only ${whole}` +
        (rest ? " and part of another" : "") +
        ", so it is probably truncated (for example an interrupted copy)",
    );
  } else if (whole > h.nRecords || rest) {
    fatal.push(
      `the file is ${dataBytes - h.nRecords * h.recordBytes} byte(s) longer than the ` +
        `${h.nRecords} data record(s) its header announces, so header and data disagree`,
    );
  }
  return [fatal, notes];
}

/**
 * A regular expression for EDF+ TALs (MNE's pattern; '.' does not cross line breaks, as in Python).
 */
const TAL_RE = /([+-]\d+\.?\d*)(\x15(\d+\.?\d*))?(\x14.*?)\x14\x00/g;

/**
 * Annotations from the bytes of the annotation signal(s), as MNE's _read_annotations_edf.
 * @param {string} text the TAL bytes decoded as UTF-8
 * @param {string[]} chNames for channel-specific annotations ("text@@channel")
 * @returns {{onset: number, duration: number, description: string, channels: string[]}[]}
 */
export function parseTals(text, chNames) {
  const events = new Map();
  let offset = 0.0;
  let k = 0;
  TAL_RE.lastIndex = 0;
  let m;
  while ((m = TAL_RE.exec(text)) !== null) {
    const onset = parseFloat(m[1]) + offset;
    const duration = m[3] ? parseFloat(m[3]) : 0;
    const parts = m[4].split("\x14").slice(1);
    for (let description of parts) {
      if (description) {
        let chName = null;
        let key;
        if (description.includes("@@") && chNames && chNames.includes(description.split("@@")[1])) {
          [description, chName] = description.split("@@");
          key = `${onset}_${duration}_${description}`;
        } else {
          key = `${onset}_${duration}_${description}`;
          if (events.has(key)) key += `_${k}`;
        }
        if (events.has(key) && chName) events.get(key).channels.push(chName);
        else events.set(key, { onset, duration, description, channels: chName ? [chName] : [] });
      } else if (k === 0) {
        offset = -onset;
      }
    }
    k++;
  }
  return [...events.values()].sort((a, b) => a.onset - b.onset);
}

/** BioSemi's Status channel carries trigger codes in its lower 16 bits (desktop: BDF_TRIGGER_MASK). */
export const BDF_TRIGGER_MASK = 0xffff;

/**
 * Add the steps of a trigger channel's values (starting at sample0) to state.steps, as MNE's
 * _find_stim_steps and _mask_trigs find them: every change of the value, kept when the masked
 * values before and after differ.
 * @param {{prev: number | null, steps: number[][], changed?: boolean}} state
 * @param {ArrayLike<number>} values non-negative integers
 * @param {number} sample0
 * @param {number} mask -1 for no mask
 */
export function stimSteps(state, values, sample0, mask) {
  let prev = state.prev;
  for (let q = 0; q < values.length; q++) {
    const v = values[q];
    if (prev !== null && v !== prev) {
      state.changed = true;
      const pre = mask === -1 ? prev : prev & mask;
      const post = mask === -1 ? v : v & mask;
      if (pre !== post) state.steps.push([sample0 + q, pre, post]);
    }
    prev = v;
  }
  state.prev = prev;
}

/**
 * The end of a trigger channel: mne.find_events pads the channel with zero after its last sample
 * (pad_stop=0), so a code that lasts to the end of the recording still ends there. A channel that
 * never changes has no steps at all.
 * @param {{prev: number | null, steps: number[][], changed?: boolean}} state
 * @param {number} nSamples
 * @param {number} mask -1 for no mask
 */
export function finishStimSteps(state, nSamples, mask) {
  if (!state.changed || state.prev === null || state.prev === 0) return;
  const pre = mask === -1 ? state.prev : state.prev & mask;
  if (pre !== 0) state.steps.push([nSamples, pre, 0]);
}

/**
 * Events from trigger steps as mne.find_events(consecutive=True, output="onset") returns them:
 * every step to a non-zero code, none at all when the channel never steps down from a code, and
 * without a final step to a code that is never followed by another step.
 * @param {number[][]} steps [sample, before, after]
 * @returns {number[][]} [sample, code]
 */
export function stimEvents(steps) {
  const onsets = [];
  const offsets = [];
  steps.forEach((s, i) => {
    if (s[2] > 0) onsets.push(i);
    if (s[1] > 0) offsets.push(i);
  });
  if (!onsets.length || !offsets.length) return [];
  if (onsets[onsets.length - 1] > offsets[offsets.length - 1]) onsets.pop();
  return onsets.map((i) => [steps[i][0], steps[i][2]]);
}

/**
 * An open EDF/EDF+/BDF recording: header, layout and decoding of blocks of data records.
 */
export class EdfSource {
  /**
   * @param {Blob} file
   * @param {string} fileName
   * @param {"edf" | "bdf"} format
   */
  static async open(file, fileName, format) {
    const h = await readEdfHeader(file, fileName, format);
    const familyName = format === "bdf" ? "BDF" : "EDF";
    if (h.fileType.endsWith("+D")) {
      throw new RecordingError(
        `${fileName} is an ${h.fileType} file (discontinuous: its data records are not ` +
          "contiguous in time). MNE-Python reads such files as if they were continuous, so annotation times " +
          "would not match the recording. Convert it to a continuous file first.",
        "unsupported_format",
      );
    }
    const [fatal, notes] = sizeProblems(h, file.size);
    if (fatal.length) throw new RecordingError(`${fileName}: ${fatal.join("; ")}.`, "corrupt_recording");
    return new EdfSource(file, fileName, format, h, notes.map((n) => `${familyName}: ${n}`));
  }

  constructor(file, fileName, format, h, notes) {
    this.file = file;
    this.format = format;
    this.fileName = fileName;
    this.h = h;
    this.notes = notes;
    const ns = h.nSignals;
    // signals of the recording (MNE's sel): all but the annotation signals
    const tal = [];
    const sel = [];
    for (let i = 0; i < ns; i++) (TAL_LABELS.includes(h.labelsMne[i]) ? tal : sel).push(i);
    this.talIdx = tal;
    this.sel = sel;
    const names = uniqueChannelNames(sel.map((i) => h.labelsMne[i]));
    this.names = names;
    const stim = sel.map((i, j) => isMneEdfStim(names[j]));
    this.isStim = stim;
    // byte offset of each signal inside a data record
    const sigOffset = [];
    let o = 0;
    for (let i = 0; i < ns; i++) {
      sigOffset.push(o);
      o += h.spr[i] * h.bps;
    }
    this.sigOffset = sigOffset;
    const spr = sel.map((i) => h.spr[i]);
    this.maxSamp = spr.length ? Math.max(...spr) : Math.max(...h.spr);
    const notStim = sel.filter((_, j) => !stim[j]);
    const rateFrom = notStim.length ? notStim : sel.length ? sel : [0];
    let rl = h.recordDuration;
    if (rl === 0) {
      rl = 1.0;
      this.notes.push(`${format === "bdf" ? "BDF" : "EDF"}: the header gives a record length of 0; 1 s is assumed (as MNE does)`);
    }
    this.recordLength = rl;
    this.sfreq = (Math.max(...rateFrom.map((i) => h.spr[i])) * 1.0) / rl;
    const dataBytes = file.size - h.headerBytes;
    this.nRecords = Math.floor(dataBytes / h.recordBytes);
    this.nSamples = this.nRecords * this.maxSamp;
    // calibration (MNE: cal = physical range / digital range, offset = phys_min - dig_min * cal)
    this.cal = [];
    this.offset = [];
    this.unit = [];
    this.scaleWarnings = [];
    const badDigital = [];
    const badPhysical = [];
    sel.forEach((i, j) => {
      let dr = h.digMax[i] - h.digMin[i];
      let pr = h.physMax[i] - h.physMin[i];
      if (!Number.isFinite(dr) || dr === 0) {
        dr = 1;
        badDigital.push(names[j]);
      }
      if (pr === 0) {
        pr = 1;
        badPhysical.push(names[j]);
      }
      let cal = pr / dr;
      let offset = h.physMin[i] - h.digMin[i] * cal;
      let unit = stim[j] ? 1 : unitFactor(h.units[i]);
      if (h.isBdf && stim[j]) {
        cal = 1;
        offset = 0;
      }
      this.cal.push(cal);
      this.offset.push(offset);
      this.unit.push(unit);
    });
    if (badDigital.length) this.scaleWarnings.push(`The digital range of ${badDigital.join(", ")} is empty; its samples are scaled as MNE does`);
    if (badPhysical.length) this.scaleWarnings.push(`The physical range of ${badPhysical.join(", ")} is empty; its samples are scaled as MNE does`);
    this.spr = spr;
    // block layout of the decoded cache: whole data records
    const recsByTarget = Math.max(1, Math.floor(TARGET_BLOCK_SAMPLES / this.maxSamp));
    const recsByBytes = Math.max(1, Math.floor(MAX_BLOCK_BYTES / h.recordBytes));
    this.recordsPerBlock = Math.max(1, Math.min(recsByTarget, recsByBytes));
    this.blockSamples = this.recordsPerBlock * this.maxSamp;
    this.channels = names.map((name, j) => ({
      name,
      type: stim[j] ? "stim" : inferChannelType(name),
      unit: stim[j] ? "" : "V",
      origUnit: h.units[sel[j]],
    }));
    this.needsScan = this.talIdx.length > 0 || stim.some(Boolean);
    this._scan = null;
  }

  get measDate() {
    return this.h.measDate;
  }

  /** Byte ranges [start, end) that cover the file in order, cut at whole data records. */
  scanRanges(chunkBytes = SCAN_CHUNK_BYTES) {
    const h = this.h;
    const ranges = [[0, h.headerBytes]];
    const perChunk = Math.max(1, Math.floor(chunkBytes / h.recordBytes));
    for (let r = 0; r < this.nRecords; r += perChunk) {
      const r1 = Math.min(this.nRecords, r + perChunk);
      ranges.push([h.headerBytes + r * h.recordBytes, h.headerBytes + r1 * h.recordBytes]);
    }
    const end = h.headerBytes + this.nRecords * h.recordBytes;
    if (end < this.file.size) ranges.push([end, this.file.size]);
    return ranges;
  }

  /** Collect TAL bytes and trigger changes from bytes [offset, offset + bytes.length). */
  scan(bytes, offset) {
    const h = this.h;
    if (!this._scan) {
      this._scan = {
        tal: [],
        talBytes: 0,
        stim: this.sel
          .map((i, j) => (this.isStim[j] ? { j, i, prev: null, steps: [] } : null))
          .filter(Boolean),
      };
    }
    const st = this._scan;
    if (offset < h.headerBytes) return;
    const r0 = (offset - h.headerBytes) / h.recordBytes;
    if (!Number.isInteger(r0)) return; // trailing bytes after the last whole record
    const n = Math.floor(bytes.length / h.recordBytes);
    for (let k = 0; k < n; k++) {
      const base = k * h.recordBytes;
      for (const ti of this.talIdx) {
        const a = base + this.sigOffset[ti];
        st.tal.push(bytes.slice(a, a + h.spr[ti] * h.bps));
      }
      for (const s of st.stim) {
        const values = this._decodeStim(bytes, base, s.j);
        const sample0 = (r0 + k) * this.maxSamp;
        stimSteps(s, values, sample0, this.format === "bdf" ? BDF_TRIGGER_MASK : -1);
      }
    }
  }

  /** Stim values of one record as MNE gives them, masked with the desktop's trigger mask. */
  _decodeStim(bytes, base, j) {
    const i = this.sel[j];
    const n = this.h.spr[i];
    const raw = new Float64Array(n);
    this._decodeSignal(bytes, base + this.sigOffset[i], n, raw, 0, j);
    let out = raw;
    if (n !== this.maxSamp) {
      // zero-order hold onto the record's samples, as MNE interpolates trigger channels
      out = new Float64Array(this.maxSamp);
      for (let q = 0; q < this.maxSamp; q++) out[q] = raw[Math.min(n - 1, Math.floor((q * n) / this.maxSamp))];
    }
    const codes = new Float64Array(out.length);
    for (let q = 0; q < out.length; q++) codes[q] = Math.abs(Math.trunc(out[q]));
    return codes;
  }

  /** Markers, gaps and discontinuities once the file has been scanned (or without a scan). */
  finishScan() {
    const st = this._scan || { tal: [], stim: [] };
    let annotations = [];
    if (this.talIdx.length) {
      let total = 0;
      for (const t of st.tal) total += t.length;
      const all = new Uint8Array(total);
      let p = 0;
      for (const t of st.tal) {
        all.set(t, p);
        p += t.length;
      }
      const text = new TextDecoder("utf-8").decode(all);
      annotations = parseTals(text, this.names);
    }
    const triggers = [];
    const mask = this.format === "bdf" ? BDF_TRIGGER_MASK : -1;
    for (const s of st.stim) {
      finishStimSteps(s, this.nSamples, mask);
      for (const [sample, code] of stimEvents(s.steps)) triggers.push({ sample, code, channel: this.names[s.j] });
    }
    triggers.sort((a, b) => a.sample - b.sample || (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));
    this._scan = null;
    return { annotations, triggers };
  }

  /**
   * Decode n samples of signal i at byte position p of bytes into out[o..] as MNE scales them.
   * j is the index of the signal among the recording's channels.
   */
  _decodeSignal(bytes, p, n, out, o, j) {
    const cal = this.cal[j];
    const off = this.offset[j];
    const unit = this.unit[j];
    const stim = this.isStim[j] && this.spr[j] === this.maxSamp;
    if (this.h.isBdf) {
      if (stim) {
        for (let q = 0; q < n; q++, p += 3) {
          const d = ((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)) << 8) >> 8;
          out[o + q] = Math.trunc((d * cal + off) * unit) & 0x1ffff;
        }
      } else {
        for (let q = 0; q < n; q++, p += 3) {
          const d = ((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)) << 8) >> 8;
          out[o + q] = (d * cal + off) * unit;
        }
      }
      return;
    }
    let ints;
    if (LITTLE_ENDIAN && (bytes.byteOffset + p) % 2 === 0) ints = new Int16Array(bytes.buffer, bytes.byteOffset + p, n);
    else {
      const dv = new DataView(bytes.buffer, bytes.byteOffset);
      ints = new Int16Array(n);
      for (let q = 0; q < n; q++) ints[q] = dv.getInt16(p + 2 * q, true);
    }
    if (stim) for (let q = 0; q < n; q++) out[o + q] = Math.trunc((ints[q] * cal + off) * unit) & 0x1ffff;
    else for (let q = 0; q < n; q++) out[o + q] = (ints[q] * cal + off) * unit;
  }

  get nBlocks() {
    return Math.ceil(this.nRecords / this.recordsPerBlock);
  }

  /**
   * Read one block of the cache: data records [b * recordsPerBlock, ...) as they are stored (the
   * bytes are kept and decoded on demand, which needs less memory than samples and keeps the full
   * precision for the filters).
   * @param {number} b
   * @returns {Promise<EdfBlock>}
   */
  async readBlock(b) {
    const h = this.h;
    const r0 = b * this.recordsPerBlock;
    const r1 = Math.min(this.nRecords, r0 + this.recordsPerBlock);
    const lowRate = this.spr.some((s) => s !== this.maxSamp);
    // one extra record lets lower-rate channels interpolate across the end of the block
    const rEnd = lowRate ? Math.min(this.nRecords, r1 + 1) : r1;
    const start = h.headerBytes + r0 * h.recordBytes;
    const bytes = new Uint8Array(await this.file.slice(start, h.headerBytes + rEnd * h.recordBytes).arrayBuffer());
    if (bytes.length < (rEnd - r0) * h.recordBytes) throw new RecordingError(`${this.fileName} could not be read`, "read_error");
    return new EdfBlock(this, bytes, r1 - r0, rEnd - r0);
  }

  /**
   * Everything the Recording needs, once annotations and triggers are known.
   * @param {{annotations: any[], triggers: any[]}} scanned
   */
  describe(scanned) {
    return describeRecording({
      format: this.format,
      sfreq: this.sfreq,
      nSamples: this.nSamples,
      annotations: scanned.annotations,
      triggers: scanned.triggers,
      channels: this.channels,
      warnings: [...this.notes, ...this.scaleWarnings],
      lowRateNames: this.names.filter((_, j) => this.spr[j] !== this.maxSamp),
    });
  }
}

/**
 * Markers, gaps, discontinuities and warnings from annotations in seconds (EDF+) or samples
 * (BrainVision), as the desktop derives them.
 * @param {object} p
 */
export function describeRecording(p) {
  const { sfreq, nSamples } = p;
  const warnings = [...(p.warnings || [])];
  const markers = [];
  const gaps = [];
  const breaks = [];
  let beyond = 0;
  let clipped = 0;
  for (const a of p.annotations) {
    const onsetSample = a.onsetSample != null ? a.onsetSample : timeToSample(a.onset, sfreq);
    let durationSamples = a.durationSamples != null ? a.durationSamples : timeToSample(a.duration, sfreq);
    if (onsetSample > nSamples || onsetSample + durationSamples < 0) {
      beyond++;
      continue;
    }
    if (onsetSample + durationSamples > nSamples) {
      durationSamples = nSamples - onsetSample;
      clipped++;
    }
    const low = a.description.toLowerCase();
    if (low.startsWith("bad_acq_skip")) {
      const start = Math.max(0, onsetSample);
      const stop = Math.min(nSamples, onsetSample + Math.max(1, durationSamples));
      if (stop > start) gaps.push([start, stop]);
      continue;
    }
    if (low.startsWith("new segment") && onsetSample > 0) breaks.push(onsetSample);
    const m = { onsetSample, durationSamples, description: a.description };
    if (a.channels && a.channels.length) m.channels = a.channels.slice();
    markers.push(m);
  }
  if (beyond) {
    throw new RecordingError(
      "The recording appears to be incomplete or inconsistent. Some markers lie beyond the end of the EEG data, " +
        "so the data file is probably truncated (for example an interrupted copy). Details: " +
        `Omitted ${beyond} annotation(s) that were outside data range.`,
      "inconsistent_recording",
    );
  }
  if (clipped) warnings.push(`MNE: Limited ${clipped} annotation(s) that were expanding outside the data range.`);
  const uniqueGaps = [];
  const seen = new Set();
  for (const g of gaps.sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const k = `${g[0]}:${g[1]}`;
    if (!seen.has(k)) {
      seen.add(k);
      uniqueGaps.push(g);
    }
  }
  const discontinuities = [...new Set(breaks)].sort((x, y) => x - y);
  // Event markers: the file's annotations, or the trigger codes when there are none.
  let source = markers.length ? "annotations" : "none";
  let out = markers;
  if (!markers.length && p.triggers && p.triggers.length) {
    source = "triggers";
    out = p.triggers.map((t) => ({ onsetSample: t.sample, durationSamples: 0, description: String(t.code), value: t.code, channel: t.channel }));
  }
  out.sort((a, b) => a.onsetSample - b.onsetSample);
  if (discontinuities.length) {
    warnings.push(`The recording has ${discontinuities.length} discontinuity marker(s) (BrainVision 'New Segment')`);
  }
  if (uniqueGaps.length) {
    const total = uniqueGaps.reduce((a, [s, e]) => a + (e - s), 0) / sfreq;
    const tail = uniqueGaps.length === 1 && uniqueGaps[0][1] === nSamples ? " (at the end of the file, probably padding of the last data record)" : "";
    warnings.push(
      `The file marks ${uniqueGaps.length} stretch(es) without recorded data (BAD_ACQ_SKIP), ${total.toFixed(3)} s in total` +
        `${tail}; they are hatched in the viewer and filtered separately`,
    );
  }
  if (p.lowRateNames && p.lowRateNames.length) {
    warnings.push(
      `${p.lowRateNames.join(", ")} ${p.lowRateNames.length > 1 ? "are" : "is"} sampled more slowly than the other channels ` +
        "and shown interpolated to the recording's rate (linearly; MNE-Python resamples with an FFT, which differs slightly)",
    );
  }
  return { markers: out, markerSource: source, gaps: uniqueGaps, discontinuities, warnings, triggers: p.triggers || [] };
}

/** The bytes of whole data records, decoded on demand. */
class EdfBlock {
  constructor(src, bytes, nRec, nRecRead) {
    this.src = src;
    this.bytes = bytes;
    this.n = nRec * src.maxSamp;
    this.nRecRead = nRecRead;
    this.byteLength = bytes.byteLength;
  }

  /**
   * Samples [a, b) of the block (relative to its first sample) of channel j, in volts, into out
   * from index o.
   */
  decode(j, a, b, out, o) {
    const src = this.src;
    const M = src.maxSamp;
    const rb = src.h.recordBytes;
    const i = src.sel[j];
    const n = src.h.spr[i];
    const bps = src.h.bps;
    if (n === M) {
      for (let k = Math.floor(a / M); k * M < b; k++) {
        const q0 = Math.max(a, k * M) - k * M;
        const q1 = Math.min(b, (k + 1) * M) - k * M;
        src._decodeSignal(this.bytes, k * rb + src.sigOffset[i] + q0 * bps, q1 - q0, out, o + k * M + q0 - a, j);
      }
      return;
    }
    // a channel stored with fewer samples per record than the others
    const ratio = n / M;
    const avail = this.nRecRead * n;
    const lo0 = Math.floor(a * ratio);
    const lo1 = Math.min(avail, Math.floor((b - 1) * ratio) + 2);
    const low = new Float64Array(Math.max(0, lo1 - lo0));
    for (let k = Math.floor(lo0 / n); k * n < lo1; k++) {
      const q0 = Math.max(lo0, k * n) - k * n;
      const q1 = Math.min(lo1, (k + 1) * n) - k * n;
      src._decodeSignal(this.bytes, k * rb + src.sigOffset[i] + q0 * bps, q1 - q0, low, k * n + q0 - lo0, j);
    }
    if (src.isStim[j]) {
      // zero-order hold within each record, as MNE interpolates trigger channels
      for (let q = a; q < b; q++) {
        const k = Math.floor(q / M);
        out[o + q - a] = low[k * n + Math.min(n - 1, Math.floor(((q - k * M) * n) / M)) - lo0];
      }
      return;
    }
    // linear interpolation between the channel's own samples (MNE resamples with an FFT)
    const last = avail - 1;
    for (let q = a; q < b; q++) {
      const x = q * ratio;
      const p = Math.floor(x);
      const f = x - p;
      out[o + q - a] = p >= last ? low[last - lo0] : low[p - lo0] + f * (low[p + 1 - lo0] - low[p - lo0]);
    }
  }
}
