// Small helpers shared by the readers. Plain ES module, no dependencies.

/**
 * Python's round(): to the nearest integer, halves to the even neighbour.
 * @param {number} x
 * @returns {number}
 */
export function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * The nearest sample to a time (halves round up), as the desktop's RecordingTiming.time_to_sample.
 * @param {number} seconds
 * @param {number} sfreq
 */
export function timeToSample(seconds, sfreq) {
  return Math.floor(seconds * sfreq + 0.5);
}

/**
 * Bytes as ISO-8859-1 (Python's "latin-1": every byte is the code point of the same value).
 * TextDecoder("latin1") would be windows-1252, which differs for bytes 0x80 to 0x9F.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeLatin1(bytes) {
  let out = "";
  const step = 0x4000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(bytes.length, i + step))));
  }
  return out;
}

/**
 * Strict UTF-8 decoding; returns null when the bytes are not valid UTF-8.
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
export function decodeUtf8Strict(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

// Bytes that Python's cp1252 codec cannot decode (it raises; MNE then falls back to latin-1).
const CP1252_UNDEFINED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);
// Windows-1252 for 0x80 to 0x9F (the rest is Latin-1). Written out because some TextDecoder
// implementations decode "windows-1252" as Latin-1.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

/** Bytes as Windows-1252 (Python's cp1252 for every byte it can decode). @param {Uint8Array} bytes */
export function decodeCp1252(bytes) {
  let out = "";
  const step = 0x4000;
  for (let i = 0; i < bytes.length; i += step) {
    const part = Array.from(bytes.subarray(i, Math.min(bytes.length, i + step)), (b) => (b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : b));
    out += String.fromCharCode.apply(null, part);
  }
  return out;
}

/**
 * Decode text the way MNE decodes BrainVision files: the Codepage= setting (UTF-8 when absent,
 * ANSI meaning cp1252), falling back to latin-1 when the bytes do not fit that code page.
 * @param {Uint8Array} bytes
 * @returns {{text: string, encoding: string}}
 */
export function decodeBrainVisionText(bytes) {
  const ascii = decodeAsciiIgnore(bytes);
  const m = /Codepage=(.+)/i.exec(ascii);
  let codepage = m ? m[1].trim() : "utf-8";
  if (codepage === "ANSI") codepage = "cp1252";
  const lower = codepage.toLowerCase().replace(/_/g, "-");
  if (lower === "utf-8" || lower === "utf8") {
    const text = decodeUtf8Strict(bytes);
    if (text !== null) return { text, encoding: "utf-8" };
    return { text: decodeLatin1(bytes), encoding: "latin-1" };
  }
  if (lower === "cp1252" || lower === "windows-1252") {
    for (const b of bytes) {
      if (CP1252_UNDEFINED.has(b)) return { text: decodeLatin1(bytes), encoding: "latin-1" };
    }
    return { text: decodeCp1252(bytes), encoding: "cp1252" };
  }
  if (lower === "latin-1" || lower === "latin1" || lower === "iso-8859-1") {
    return { text: decodeLatin1(bytes), encoding: "latin-1" };
  }
  try {
    return { text: new TextDecoder(codepage, { fatal: true }).decode(bytes), encoding: codepage };
  } catch {
    return { text: decodeLatin1(bytes), encoding: "latin-1" };
  }
}

/**
 * Bytes as ASCII, dropping every byte above 0x7F (Python's decode("ascii", "ignore")).
 * @param {Uint8Array} bytes
 */
export function decodeAsciiIgnore(bytes) {
  let out = "";
  const step = 0x4000;
  for (let i = 0; i < bytes.length; i += step) {
    const part = [];
    const end = Math.min(bytes.length, i + step);
    for (let j = i; j < end; j++) if (bytes[j] < 0x80) part.push(bytes[j]);
    out += String.fromCharCode.apply(null, part);
  }
  return out;
}

const globCache = new Map();

/**
 * Case-sensitive shell-style match, as Python's fnmatch.fnmatchcase (*, ?, [seq], [!seq]).
 * @param {string} name
 * @param {string} pattern
 */
export function fnmatchCase(name, pattern) {
  let re = globCache.get(pattern);
  if (!re) {
    let src = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "*") src += "[\\s\\S]*";
      else if (c === "?") src += "[\\s\\S]";
      else if (c === "[") {
        let j = i + 1;
        if (j < pattern.length && pattern[j] === "!") j++;
        if (j < pattern.length && pattern[j] === "]") j++;
        while (j < pattern.length && pattern[j] !== "]") j++;
        if (j >= pattern.length) {
          src += "\\[";
        } else {
          let stuff = pattern.slice(i + 1, j).replace(/\\/g, "\\\\");
          if (stuff[0] === "!") stuff = "^" + stuff.slice(1);
          else if (stuff[0] === "^") stuff = "\\" + stuff;
          src += "[" + stuff + "]";
          i = j;
        }
      } else src += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
    re = new RegExp("^(?:" + src + ")$");
    globCache.set(pattern, re);
  }
  return re.test(name);
}

/**
 * The recording's stem: the file name without its extension and without a trailing _eeg.
 * @param {string} fileName
 */
export function recordingStem(fileName) {
  const base = fileName.replace(/^.*[\\/]/, "");
  const dot = base.lastIndexOf(".");
  const noExt = dot > 0 ? base.slice(0, dot) : base;
  return noExt.replace(/_eeg$/i, "");
}

/**
 * The extension in lower case, with its dot ("" when there is none).
 * @param {string} fileName
 */
export function extensionOf(fileName) {
  const base = fileName.replace(/^.*[\\/]/, "");
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

/**
 * A UTC date and time as Python's datetime.isoformat() writes it ("2024-01-01T12:00:00+00:00").
 * @param {number} year @param {number} month 1-12 @param {number} day
 * @param {number} hour @param {number} minute @param {number} second
 * @param {number} [microsecond]
 */
export function isoUtc(year, month, day, hour, minute, second, microsecond = 0) {
  const p = (v, n = 2) => String(v).padStart(n, "0");
  const frac = microsecond ? "." + p(microsecond, 6) : "";
  return `${p(year, 4)}-${p(month)}-${p(day)}T${p(hour)}:${p(minute)}:${p(second)}${frac}+00:00`;
}

/** Days in a month (month 1-12). */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The k-th smallest value (0-based) of arr, which is reordered in place. Hoare's selection.
 * @param {Float64Array} arr
 * @param {number} k
 */
export function selectKth(arr, k) {
  let lo = 0;
  let hi = arr.length - 1;
  while (hi > lo) {
    const mid = (lo + hi) >>> 1;
    // median of three as the pivot
    let a = arr[lo], b = arr[mid], c = arr[hi];
    let pivot;
    if (a < b) pivot = b < c ? b : a < c ? c : a;
    else pivot = a < c ? a : b < c ? c : b;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (arr[i] < pivot) i++;
      while (arr[j] > pivot) j--;
      if (i <= j) {
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return arr[k];
  }
  return arr[k];
}

/**
 * numpy.percentile(values, q) with the default linear interpolation. values is reordered.
 * @param {Float64Array} values
 * @param {number} q 0-100
 */
export function percentile(values, q) {
  const n = values.length;
  if (n === 0) return NaN;
  const pos = (q / 100) * (n - 1);
  const lo = Math.floor(pos);
  const frac = pos - lo;
  const a = selectKth(values, lo);
  if (frac === 0 || lo + 1 >= n) return a;
  // the next order statistic is the minimum of the upper part after selection
  let b = Infinity;
  for (let i = lo + 1; i < n; i++) if (values[i] < b) b = values[i];
  return a + (b - a) * frac;
}

/**
 * numpy.median(values). values is reordered.
 * @param {Float64Array} values
 */
export function median(values) {
  const n = values.length;
  if (n === 0) return NaN;
  if (n % 2 === 1) return selectKth(values, (n - 1) / 2);
  const hi = selectKth(values, n / 2);
  let lo = -Infinity;
  for (let i = 0; i < n / 2; i++) if (values[i] > lo) lo = values[i];
  return (lo + hi) / 2;
}

/** Merge [start, end) intervals that overlap or touch; returns a new sorted list. */
export function mergeIntervals(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [a, b] of sorted) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}

/** A readable error that carries a kind, like the desktop's RecordingLoadError. */
export class RecordingError extends Error {
  /** @param {string} message @param {string} [kind] */
  constructor(message, kind = "load_error") {
    super(message);
    this.name = "RecordingError";
    this.kind = kind;
  }
}
