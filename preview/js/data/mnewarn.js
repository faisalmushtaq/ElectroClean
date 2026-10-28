// What MNE-Python says while it reads a recording, for the manifests the browser builds
// (register.js). The desktop's loader keeps MNE's warnings ("MNE: ...") among a recording's
// warnings, so the browser works out the same ones from the header (duplicate channel names, empty
// ranges, differing filter settings, unreadable dates, unusual BrainVision headers, coordinates and
// montages), and holds the annotations the way MNE does (sorted, clipped to the recording, times to
// the microsecond). Plain ES module.

import { parseIni } from "./brainvision.js";
import {
  measDateMicros,
  pyCompare,
  pyFixed,
  pyFloat,
  pyFloatRepr,
  pyIntText,
  pyListRepr,
  pyRstrip,
  pySetRepr,
  pyStrip,
  pyStrRepr,
  timedeltaMicros,
} from "./pyfmt.js";
import { decodeAsciiIgnore, decodeBrainVisionText, decodeLatin1, daysInMonth } from "./util.js";

const TAL_LABELS = ["EDF Annotations", "BDF Annotations"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Python's \s in a str pattern. */
const PY_WS = "[\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const SPLIT_WS = new RegExp(`${PY_WS}+`);
const SPLIT_WS2 = new RegExp(`${PY_WS}${PY_WS}+`);

/** _pl: "s" unless there is exactly one. */
const pl = (n) => (n === 1 ? "" : "s");

/** Line boundaries of Python's str.splitlines() (written as a string, like PY_WS). */
const LINE_BREAK = "\\r\\n|[\\n\\r\\x0b\\x0c\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]";
const SPLIT_LINES = new RegExp(LINE_BREAK);
const ENDS_WITH_BREAK = new RegExp(`(?:${LINE_BREAK})$`);

/** Python's str.splitlines(). */
export function pySplitlines(text) {
  if (text === "") return [];
  const out = text.split(SPLIT_LINES);
  if (out.length && out[out.length - 1] === "" && ENDS_WITH_BREAK.test(text)) out.pop();
  return out;
}

/** MNE's _edf_str: Latin-1 up to the first NUL. */
function edfStr(bytes) {
  const s = decodeLatin1(bytes);
  const nul = s.indexOf("\x00");
  return nul >= 0 ? s.slice(0, nul) : s;
}

/** bytes.strip() then Latin-1, as MNE reads labels and units. */
function stripBytes(bytes) {
  const ws = (b) => b === 0x20 || (b >= 0x09 && b <= 0x0d);
  let a = 0;
  let b = bytes.length;
  while (a < b && ws(bytes[a])) a++;
  while (b > a && ws(bytes[b - 1])) b--;
  return decodeLatin1(bytes.subarray(a, b));
}

/** Python's int() of a str, as a number, or null. */
function pyInt(text) {
  const t = pyIntText(text);
  return t === null ? null : Number(t);
}

/** datetime.strptime(text, "%d-%b-%Y") in the C locale: a valid date, or null. */
function strptimeDayMonYear(text) {
  const m = /^(3[01]|[12]\d|0[1-9]|[1-9]| [1-9])-([A-Za-z]{3})-(\d{4})$/.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
  if (!month) return null;
  const day = Number(m[1].trim());
  const year = Number(m[3]);
  if (year < 1 || day > daysInMonth(year, month)) return null;
  return [year, month, day];
}

/** MNE's _unique_channel_names: the warning for repeated names, or null. */
export function duplicateNamesWarning(names) {
  const seen = new Set();
  const dups = new Set();
  for (const n of names) {
    if (seen.has(n)) dups.add(n);
    seen.add(n);
  }
  if (!dups.size) return null;
  return `Channel names are not unique, found duplicates for: ${pySetRepr(dups)}. Applying running numbers for duplicates.`;
}

/** _parse_prefilter_string: the HP and LP values of each channel's prefiltering text. */
function parsePrefilter(prefiltering) {
  const hp = [];
  const lp = [];
  for (const filt of prefiltering) {
    for (const [t, list] of [["HP", hp], ["LP", lp]]) {
      const re = new RegExp(`${t}:${PY_WS}*([a-zA-Z0-9,.]+)(Hz)?`, "g");
      let value = "";
      let m;
      while ((m = re.exec(filt)) !== null) if (m[1]) value = m[1].replace(/Hz/g, "").replace(/,/g, ".");
      list.push(value);
    }
  }
  return [hp, lp];
}

/** _prefilter_float. */
function prefilterFloat(filt) {
  if (filt === "DC") return 0.0;
  if (/^\p{Nd}+$/u.test(filt.replace(".", ""))) return pyFloat(filt) ?? NaN;
  return NaN;
}

/**
 * The warnings MNE-Python gives while reading an EDF, EDF+ or BDF header with read_raw_edf /
 * read_raw_bdf (infer_types=False), in the order it gives them. The warning about the number of
 * data records is left out, as the desktop leaves it out (it reports the size itself).
 * @param {Uint8Array} head the whole header (256 bytes per signal plus 256)
 * @returns {string[]}
 */
export function edfReadWarnings(head) {
  const out = [];
  const field = (a, b) => head.subarray(a, b);
  // patient identification
  const idInfo = pyRstrip(decodeLatin1(field(8, 88))).split(" ");
  if (idInfo.length >= 4 && idInfo.length > 4) {
    for (const info of idInfo.slice(4)) {
      if (!info.includes("=")) continue;
      const parts = info.split("=");
      if (parts.length !== 2) continue; // MNE fails to read such a file
      const [key, value] = parts;
      if (key === "weight" || key === "height") continue;
      if (key === "hand") continue;
      out.push(`Invalid patient information ${key}`);
    }
  }
  // measurement date: the recording field, else the date field
  const recInfo = pyRstrip(decodeLatin1(field(88, 168))).split(" ");
  let date = recInfo.length === 5 ? strptimeDayMonYear(recInfo[1]) : null;
  if (!date) {
    const parts = decodeLatin1(field(168, 176)).split(".");
    if (parts.length === 3) {
      const [d, mo, y] = parts.map(pyInt);
      if (d !== null && mo !== null && y !== null) {
        const year = y < 85 ? y + 2000 : y + 1900;
        if (mo >= 1 && mo <= 12 && year >= 1 && year <= 9999 && d >= 1 && d <= daysInMonth(year, mo)) date = [year, mo, d];
      }
    }
  }
  if (!date) out.push("Invalid measurement date encountered in the header.");
  const recordLength = pyFloat(edfStr(field(244, 252)));
  if (recordLength === 0) {
    out.push(
      "Header information is incorrect for record length. Default record length set to 1.\nIt is possible that this file only" +
        " contains annotations and no signals. In that case, please use mne.read_annotations() to load these annotations.",
    );
  }
  const ns = pyInt(edfStr(field(252, 256)));
  if (!(ns > 0) || head.length < 256 * (ns + 1)) return out;
  const sig = head.subarray(256, 256 * (ns + 1));
  const f = (base, width, i) => sig.subarray(base + i * width, base + (i + 1) * width);
  const labels = [];
  for (let i = 0; i < ns; i++) labels.push(stripBytes(f(0, 16, i)));
  const sel = [];
  for (let i = 0; i < ns; i++) if (!TAL_LABELS.includes(labels[i])) sel.push(i);
  const selNames = sel.map((i) => labels[i]);
  const dup = duplicateNamesWarning(selNames);
  if (dup) out.push(dup);
  const names = uniqueNames(selNames);
  let off = 16 * ns + 80 * ns + 8 * ns;
  const nums = (o) => sel.map((i) => pyFloat(edfStr(f(o, 8, i)).replace(/,/g, ".")));
  const physMin = nums(off);
  const physMax = nums(off + 8 * ns);
  const digMin = nums(off + 16 * ns);
  const digMax = nums(off + 24 * ns);
  off += 32 * ns;
  const prefiltering = [];
  for (let i = 0; i < ns; i++) prefiltering.push(pyStrip(edfStr(f(off, 80, i))));
  off += 80 * ns;
  const nSamps = [];
  for (let i = 0; i < ns; i++) nSamps.push(pyInt(edfStr(f(off, 8, i))));
  const badDig = [];
  const badPhys = [];
  sel.forEach((_, j) => {
    const dr = digMax[j] - digMin[j];
    if (!Number.isFinite(dr) || dr === 0) badDig.push(names[j]);
    if (physMax[j] - physMin[j] === 0) badPhys.push(names[j]);
  });
  if (badDig.length) out.push(`Scaling factor will not be defined in the following channels:\n${badDig.join(", ")}`);
  if (badPhys.length) out.push(`Physical range is not defined in following channels:\n${badPhys.join(", ")}`);
  // prefiltering: MNE compares the values of the channels that are not trigger channels (by their
  // position among the recording's channels, as MNE indexes them)
  const low = names.map((n) => n.toLowerCase());
  const stimIdx = new Set();
  for (const want of ["status", "trigger"]) {
    const k = low.indexOf(want);
    if (k >= 0) stimIdx.add(k);
  }
  const filtIdx = [];
  for (let x = 0; x < sel.length; x++) if (!stimIdx.has(x)) filtIdx.push(x);
  const notStim = sel.filter((_, j) => !stimIdx.has(j));
  const rate = notStim.length ? notStim : sel;
  const sfreq = (Math.max(...rate.map((i) => nSamps[i])) * 1.0) / (recordLength === 0 ? 1.0 : recordLength);
  let highpass = 0.0;
  let lowpass = sfreq / 2.0;
  if (filtIdx.length) {
    const [hp, lp] = parsePrefilter(prefiltering);
    for (const [key, values] of [["highpass", hp], ["lowpass", lp]]) {
      if (!values.length) continue;
      const vals = values.filter((_, i) => filtIdx.includes(i));
      let value;
      if (new Set(vals).size > 1) {
        out.push(`Channels contain different ${key} filters. ${key === "highpass" ? "Highest" : "Lowest"} filter setting will be stored.`);
        const fl = vals.map(prefilterFloat).filter((v) => !Number.isNaN(v));
        if (!fl.length) {
          out.push("All-NaN slice encountered");
          value = NaN;
        } else value = key === "highpass" ? Math.max(...fl) : Math.min(...fl);
      } else value = vals.length ? prefilterFloat(vals[0]) : NaN;
      if (!Number.isNaN(value) && value !== 0) {
        if (key === "highpass") highpass = value;
        else lowpass = value;
      }
    }
  }
  if (Number.isNaN(lowpass) || lowpass <= 0) lowpass = sfreq / 2.0;
  if (highpass > lowpass) {
    out.push(
      `Highpass cutoff frequency ${pyFloatRepr(highpass)} is greater than lowpass cutoff frequency ${pyFloatRepr(lowpass)}, ` +
        "setting values to 0 and Nyquist.",
    );
  }
  return out;
}

/** MNE's _unique_channel_names (the renaming; channels.js has the same). */
function uniqueNames(names) {
  const out = names.slice();
  const counts = new Map();
  for (const n of out) counts.set(n, (counts.get(n) || 0) + 1);
  const suffixes = "abcdefghijklmnopqrstuvwxyz".split("");
  for (const [stem, count] of counts) {
    if (count < 2) continue;
    let idx = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== stem) continue;
      for (const suffix of [idx, ...suffixes]) {
        const candidate = `${stem}-${suffix}`;
        if (!out.includes(candidate)) {
          out[i] = candidate;
          break;
        }
      }
      idx++;
    }
  }
  return out;
}

const BV_VERSION_RE = (kind, v) => new RegExp(`Brain ?Vision( Core| V-Amp)? Data( Exchange)? ${kind} File,? Version ${v}\\.0`);

/** _check_bv_version: the warning for a header line MNE does not recognise, or null. */
function bvVersionWarning(line, kind) {
  const cap = kind[0].toUpperCase() + kind.slice(1);
  if (BV_VERSION_RE(cap, 1).test(line) || BV_VERSION_RE(cap, 2).test(line)) return null;
  if (line === "") return `Missing header in ${kind} file.`;
  return `MNE-Python currently only supports ${kind} versions 1.0 and 2.0, got unparsable ${pyStrRepr(line)}. Contact MNE-Python developers for support.`;
}

/** The first line of a file, as MNE reads it (ASCII, other bytes dropped, stripped). */
function firstLine(bytes) {
  let nl = bytes.indexOf(0x0a);
  if (nl < 0) nl = bytes.length;
  return pyStrip(decodeAsciiIgnore(bytes.subarray(0, nl + 1 <= bytes.length ? nl + 1 : nl)));
}

/**
 * The warnings MNE-Python gives while reading a BrainVision recording with read_raw_brainvision,
 * in its order, and the error it raises when the header's coordinates leave out an EEG channel.
 * @param {{vhdrBytes: Uint8Array, vmrkBytes: Uint8Array | null, header: object}} p header from parseVhdr
 * @returns {{warnings: string[], fatal: string | null}}
 */
export function bvReadWarnings({ vhdrBytes, vmrkBytes, header }) {
  const out = [];
  const versionWarning = bvVersionWarning(firstLine(vhdrBytes), "header");
  if (versionWarning) out.push(versionWarning);
  let nl = vhdrBytes.indexOf(0x0a);
  if (nl < 0) nl = vhdrBytes.length;
  const { text } = decodeBrainVisionText(vhdrBytes.subarray(Math.min(nl + 1, vhdrBytes.length)));
  const cut = text.indexOf("[Comment]");
  const params = cut >= 0 ? text.slice(0, cut) : text;
  const comment = cut >= 0 ? text.slice(cut + "[Comment]".length) : "";
  const cfg = parseIni(params);
  const common = cfg.has("Common Infos") ? "Common Infos" : "Common infos";
  const ci = cfg.get(common) || new Map();
  if (header.orientation === "VECTORIZED" && !ci.has("datapoints")) {
    out.push("No info on DataPoints found. Inferring number of  samples from the data file size.");
  }
  // channels at the origin of the coordinates become misc
  const names = header.names;
  const keyToName = new Map();
  for (const [key] of cfg.get("Channel Infos") || new Map()) {
    const m = /ch(\d+)/.exec(key);
    if (!m) continue;
    const n = parseInt(m[1], 10) - 1;
    if (n >= 0 && n < names.length) keyToName.set(key, names[n]);
  }
  const types = header.mneTypes;
  const coords = cfg.get("Coordinates");
  const montage = [];
  if (coords) {
    // misc by unit (MNE's misc="auto"); the reader's types also hold the channels found here
    const unitMisc = new Set(names.filter((_, i) => !["V", "mV", "µV", "uV", "nV"].includes(header.units[i])));
    const toMisc = [];
    for (const [key, value] of coords) {
      const name = keyToName.get(key);
      if (name === undefined) continue;
      montage.push(name);
      const rad = pyFloat(value.split(",")[0]);
      if (rad === 0 && !["HEOGL", "HEOGR", "VEOGb"].includes(name) && !unitMisc.has(name) && !toMisc.includes(name)) toMisc.push(name);
    }
    if (toMisc.length) {
      out.push(
        `No coordinate information found for channels ${pyListRepr(toMisc)}. Setting channel types to misc. To avoid this ` +
          "warning, set channel types explicitly.",
      );
    }
  }
  out.push(...bvFilterWarnings(comment, names, header.sfreq));
  let fatal = null;
  if (coords) {
    // set_montage: every EEG channel needs a position; other channels' positions are not set
    const pos = new Set(montage.filter((n) => n !== "EEG000" && n !== "REF"));
    const eeg = names.filter((_, i) => types[i] === "eeg");
    const missing = eeg.filter((n) => !pos.has(n));
    if (missing.length) {
      const p = pl(missing.length);
      const areIs = p ? "are" : "is";
      fatal =
        `DigMontage is only a subset of info. There ${areIs} ${missing.length} channel position${p} not present in the ` +
        `DigMontage. The channel${p} missing from the montage ${areIs}:\n\n${pyListRepr(missing)}.\n\nConsider using ` +
        `inst.rename_channels to match the montage nomenclature, or inst.set_channel_types if ${p ? "these" : "this"} ${areIs} ` +
        `not ${p ? "" : "an "}EEG channel${p}, or use the on_missing parameter if the channel position${p} ${areIs} allowed ` +
        "to be unknown in your analyses.";
    }
    const extra = [];
    const extraTypes = new Set();
    names.forEach((n, i) => {
      if (types[i] !== "eeg" && pos.has(n)) {
        extra.push(n);
        extraTypes.add(types[i]);
      }
    });
    if (!fatal && extra.length) {
      const p = pl(extra.length);
      out.push(
        `Not setting position${p} of ${extra.length} ${[...extraTypes].sort(pyCompare).join("/")} channel${p} found in montage:\n` +
          `${pyListRepr(extra)}\nConsider setting the channel types to be of EEG/sEEG/ECoG/DBS/fNIRS using ` +
          "inst.set_channel_types before calling inst.set_montage, or omit these channels when creating your montage.",
      );
    }
  }
  if (fatal) return { warnings: out, fatal };
  if (versionWarning) out.push(versionWarning); // MNE reads the header line a second time
  if (vmrkBytes) {
    const w = bvVersionWarning(firstLine(vmrkBytes), "marker");
    if (w) out.push(w);
  }
  return { warnings: out, fatal: null };
}

/** MNE's reading of the amplifier's filter table in a BrainVision header's comment. */
function bvFilterWarnings(comment, names, sfreq) {
  const out = [];
  let settings = pySplitlines(comment);
  let idx = null;
  let hpCol = 4;
  let lpCol = 5;
  if (settings.includes("Channels")) {
    idx = settings.indexOf("Channels");
    settings = settings.slice(idx + 1);
    for (idx = 0; idx < settings.length; idx++) if (new RegExp(`^#${PY_WS}+Name`).test(settings[idx])) break;
    if (idx >= settings.length) idx = null;
  }
  const idxAmp = idx;
  let listHasName = true;
  const sw = settings.indexOf("S o f t w a r e  F i l t e r s");
  if (sw >= 0) {
    idx = idxAmp;
    for (let k = sw + 1; k < settings.length; k++) {
      if (new RegExp(`^#${PY_WS}+Low Cutoff`).test(settings[k])) {
        idx = k;
        hpCol = 1;
        lpCol = 2;
        listHasName = false;
        out.push("Online software filter detected. Using software filter settings and ignoring hardware values");
        break;
      }
      idx = idxAmp;
    }
  }
  if (!idx) return out;
  const shift = settings[idx].includes("Resolution / Unit") ? 1 : 0;
  const header = settings[idx].split(SPLIT_WS2);
  if (header.length <= Math.max(hpCol, lpCol)) return out;
  const hpS = header[hpCol].includes("[s]");
  const lpS = header[lpCol].includes("[s]");
  const highpass = [];
  const lowpass = [];
  for (let i = 1; i <= names.length; i++) {
    const ch = names[i - 1];
    if (idxAmp === null) return out;
    const lineAmp = idx === idxAmp ? settings[idx + i] : settings[idxAmp + i];
    if (lineAmp === undefined || lineAmp.indexOf(ch) < 0) return out; // MNE fails an assertion here
    const realShift = listHasName ? shift + ch.split(SPLIT_WS).length - 1 : shift;
    const line = (settings[idx + i] || "").split(SPLIT_WS);
    highpass.push(line[hpCol + realShift]);
    lowpass.push(line[lpCol + realShift]);
  }
  const num = (v, off) => (["NaN", "Off", "DC"].includes(v) ? off : pyFloat(v));
  if (highpass.length && new Set(highpass).size > 1) {
    let hp;
    let hetero = true;
    if (hpS) {
      const vals = highpass.map((v) => num(v, Infinity));
      hp = 1.0 / (2 * Math.PI * Math.max(...vals));
      if (hp === 0.0 && new Set(vals).size === 1) hetero = false;
    } else {
      const vals = highpass.map((v) => num(v, 0.0));
      hp = Math.min(...vals);
      if (hp === 0.0 && new Set(vals).size === 1) hetero = false;
    }
    if (hetero) out.push(`Channels contain different highpass filters. Lowest (weakest) filter setting (${pyFixed(hp, 2)} Hz) will be stored.`);
  }
  if (lowpass.length && new Set(lowpass).size > 1) {
    let lp;
    let hetero = true;
    const off = (v, d) => (["NaN", "Off", "0"].includes(v) ? d : pyFloat(v));
    if (lpS) {
      const vals = lowpass.map((v) => off(v, 0.0));
      const m = Math.min(...vals);
      if (m === 0) {
        if (new Set(vals).size === 1) {
          lp = sfreq / 2.0;
          hetero = false;
        } else lp = Infinity;
      } else lp = 1.0 / (2 * Math.PI * m);
    } else {
      const vals = lowpass.map((v) => off(v, Infinity));
      lp = Math.max(...vals);
      if (lp === Infinity) {
        lp = sfreq / 2.0;
        if (new Set(vals).size === 1) hetero = false;
      }
    }
    if (hetero) {
      const nyq = lp === sfreq / 2.0 ? ", Nyquist limit" : "";
      out.push(`Channels contain different lowpass filters. Highest (weakest) filter setting (${pyFixed(lp, 2)} Hz${nyq}) will be stored.`);
    }
  }
  return out;
}

/**
 * The annotations as MNE holds them once set on the recording (Raw.set_annotations): sorted by
 * onset then duration, those outside the recording dropped, those reaching past it clipped, and
 * the onsets (and clipped durations) to the microsecond, as MNE's datetime arithmetic leaves them.
 * @param {{onset: number, duration: number, description: string, channels?: string[]}[]} list seconds
 * @param {number} nSamples
 * @param {number} sfreq
 * @param {boolean} hasOrigTime whether the annotations carry a date (BrainVision markers with one)
 * @returns {{annotations: {onset: number, duration: number, description: string, channels: string[]}[],
 *            omitted: number, limited: number}}
 */
export function mneAnnotations(list, nSamples, sfreq, hasOrigTime = false) {
  const sorted = list
    .map((a, i) => ({ ...a, i }))
    .sort((a, b) => a.onset - b.onset || a.duration - b.duration || a.i - b.i);
  const end = (nSamples - 1) / sfreq + 1.0 / sfreq;
  // tmin is the first sample (0); tmax the end, as a datetime (to the microsecond)
  const tmin = 0;
  const tmax = hasOrigTime ? timedeltaMicros(end) : measDateMicros(end);
  const out = [];
  let omitted = 0;
  let limited = 0;
  for (const a of sorted) {
    const dur = Number.isNaN(a.duration) ? 0.0 : a.duration;
    let on = timedeltaMicros(a.onset);
    let off = on + timedeltaMicros(dur);
    if (on > tmax || off < tmin) {
      omitted++;
      continue;
    }
    const left = on < tmin;
    const right = off > tmax;
    if (left) on = tmin;
    if (right) off = tmax;
    if (left || right) limited++;
    out.push({
      onset: on / 1e6,
      duration: left || right ? (off - on) / 1e6 : a.duration,
      description: a.description,
      channels: a.channels ? [...a.channels] : [],
    });
  }
  return { annotations: out, omitted, limited };
}

/** The warnings of Raw.set_annotations for annotations outside the recording. */
export function cropWarnings(omitted, limited) {
  const out = [];
  if (omitted > 0) out.push(`Omitted ${omitted} annotation(s) that were outside data range.`);
  if (limited > 0) out.push(`Limited ${limited} annotation(s) that were expanding outside the data range.`);
  return out;
}
