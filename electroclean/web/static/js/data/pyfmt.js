// Python's ways of writing and reading numbers and text, for the manifests the browser builds
// (register.js): they must hold exactly the strings the desktop's Python code writes, such as
// repr() of a float in an events row or a list in a warning. Plain ES module, no dependencies.

/**
 * Python's str.strip() whitespace (Py_UNICODE_ISSPACE): also \x1c-\x1f and \x85, which JavaScript's
 * \s leaves out, and not the byte-order mark, which \s includes.
 */
const PY_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Python's str.strip(). @param {string} s */
export function pyStrip(s) {
  let a = 0;
  let b = s.length;
  while (a < b && PY_SPACE.has(s.charCodeAt(a))) a++;
  while (b > a && PY_SPACE.has(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** Python's str.rstrip(). @param {string} s */
export function pyRstrip(s) {
  let b = s.length;
  while (b > 0 && PY_SPACE.has(s.charCodeAt(b - 1))) b--;
  return s.slice(0, b);
}

/**
 * Compare two strings as Python does (by code point; JavaScript's < compares UTF-16 units, which
 * differs for characters beyond U+FFFF).
 * @returns {number} negative, zero or positive
 */
export function pyCompare(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    if ((x >= 0xd800 && x <= 0xdfff) || (y >= 0xd800 && y <= 0xdfff)) return a.codePointAt(i) < b.codePointAt(i) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Python's sorted() of strings. @param {Iterable<string>} items */
export function pySorted(items) {
  return [...items].sort(pyCompare);
}

// ------------------------------------------------------------------- exact decimals of doubles
/**
 * The exact value of a finite double as digits / 10^scale (BigInt digits, scale >= 0).
 * @param {number} x
 * @returns {{neg: boolean, digits: bigint, scale: number}}
 */
export function exactDecimal(x) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const neg = hi >>> 31 === 1;
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (exp === 0) e = -1074;
  else {
    mant |= 1n << 52n;
    e = exp - 1075;
  }
  if (mant === 0n) return { neg, digits: 0n, scale: 0 };
  if (e >= 0) return { neg, digits: mant << BigInt(e), scale: 0 };
  // mant / 2^k = mant * 5^k / 10^k
  const k = -e;
  return { neg, digits: mant * 5n ** BigInt(k), scale: k };
}

/** digits / 10^drop rounded half to even. */
function roundHalfEven(digits, drop) {
  if (drop <= 0) return digits * 10n ** BigInt(-drop);
  const p = 10n ** BigInt(drop);
  const q = digits / p;
  const r = digits % p;
  const half = p / 2n;
  if (r > half || (r === half && q % 2n === 1n)) return q + 1n;
  return q;
}

/**
 * Python's format(x, ".Nf") (and f"{x:.Nf}"): the exact value rounded half to even, which
 * Number.prototype.toFixed does not do for exact ties (0.0625 to 3 places: "0.062", not "0.063").
 * @param {number} x
 * @param {number} places
 */
export function pyFixed(x, places) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const { neg, digits, scale } = exactDecimal(x);
  const q = roundHalfEven(digits, scale - places);
  let s = q.toString().padStart(places + 1, "0");
  if (places > 0) s = `${s.slice(0, s.length - places)}.${s.slice(s.length - places)}`;
  return (neg ? "-" : "") + s;
}

/**
 * Python's format(x, "g") / ".Ng" (default precision 6): significant digits rounded half to even,
 * trailing zeros removed, exponent notation below 1e-4 and from 10^precision.
 * @param {number} x
 * @param {number} [precision]
 */
export function pyFormatG(x, precision = 6) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const p = Math.max(1, precision);
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const { neg, digits, scale } = exactDecimal(x);
  const nd = digits.toString().length;
  let exp10 = nd - 1 - scale; // decimal exponent of the leading digit
  let q = roundHalfEven(digits, nd - p);
  if (q.toString().length > p) {
    q /= 10n;
    exp10 += 1;
  }
  const ds = q.toString().padStart(p, "0");
  let out;
  if (exp10 >= -4 && exp10 < p) {
    if (exp10 >= 0) {
      const intPart = ds.slice(0, exp10 + 1).padEnd(exp10 + 1, "0");
      const frac = ds.slice(exp10 + 1).replace(/0+$/, "");
      out = frac ? `${intPart}.${frac}` : intPart;
    } else {
      const frac = ("0".repeat(-exp10 - 1) + ds).replace(/0+$/, "");
      out = `0.${frac}`;
    }
  } else {
    const mant = ds.length > 1 ? `${ds[0]}.${ds.slice(1)}`.replace(/0+$/, "").replace(/\.$/, "") : ds;
    out = `${mant}e${exp10 < 0 ? "-" : "+"}${String(Math.abs(exp10)).padStart(2, "0")}`;
  }
  return (neg ? "-" : "") + out;
}

/**
 * Python's repr() of a float (also str() and f"{x}"): the shortest digits that read back to the
 * same value, as JavaScript finds them, laid out the Python way ("3.0", "1e-05", "1e+16").
 * @param {number} x
 */
export function pyFloatRepr(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mant, e] = Math.abs(x).toExponential().split("e");
  const digits = mant.replace(".", "");
  const exp = Number(e);
  const sign = x < 0 ? "-" : "";
  if (exp >= -4 && exp < 16) {
    if (exp >= 0) {
      const intPart = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
      const frac = digits.slice(exp + 1);
      return `${sign}${intPart}.${frac || "0"}`;
    }
    return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  }
  const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${sign}${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/**
 * A number as Python prints it: integers as integers, floats with repr(). JavaScript has one
 * number type, so the caller says which the Python value would be.
 * @param {number} x
 * @param {boolean} isFloat
 */
export function pyNumber(x, isFloat) {
  return isFloat ? pyFloatRepr(x) : String(x);
}

// ------------------------------------------------------------------------- repr of text
const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** Python's repr() of a str. @param {string} s */
export function pyStrRepr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (ch !== " " && NOT_PRINTABLE.test(ch)) {
      if (cp < 0x100) out += `\\x${cp.toString(16).padStart(2, "0")}`;
      else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, "0")}`;
      else out += `\\U${cp.toString(16).padStart(8, "0")}`;
    } else out += ch;
  }
  return out + quote;
}

/**
 * Python's repr() of a list of strings or numbers (numbers given as JavaScript numbers are written
 * as Python ints).
 * @param {Array<string | number>} items
 */
export function pyListRepr(items) {
  return `[${items.map((v) => (typeof v === "string" ? pyStrRepr(v) : String(v))).join(", ")}]`;
}

/**
 * Python's repr() of a set of strings. Python orders a set by the strings' hashes, which change
 * from one run to the next; the browser writes them sorted.
 * @param {Iterable<string>} items
 */
export function pySetRepr(items) {
  return `{${pySorted(new Set(items)).map(pyStrRepr).join(", ")}}`;
}

/**
 * Python's json.dumps(value, ensure_ascii=False) for lists and strings (", " between items).
 * @param {string[]} items
 */
export function pyJsonList(items) {
  return `[${items.map((s) => JSON.stringify(s)).join(", ")}]`;
}

// ------------------------------------------------------------------------ reading numbers
const FLOAT_RE = /^[+-]?(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const SPECIAL_RE = /^([+-]?)(inf|infinity|nan)$/i;

/**
 * Python's float() of a str (whitespace around it, underscores between digits, inf and nan),
 * or null where Python raises ValueError.
 * @param {string} text
 * @returns {number | null}
 */
export function pyFloat(text) {
  if (typeof text !== "string") return null;
  const t = pyStrip(text);
  const sp = SPECIAL_RE.exec(t);
  if (sp) {
    if (sp[2].toLowerCase() === "nan") return NaN;
    return sp[1] === "-" ? -Infinity : Infinity;
  }
  if (!FLOAT_RE.test(t)) return null;
  return Number(t.replace(/_/g, ""));
}

const INT_RE = /^[+-]?\d(?:_?\d)*$/;

/**
 * Python's int() of a str, as its decimal text ("007" -> "7", "+5" -> "5"), or null where Python
 * raises ValueError.
 * @param {string} text
 * @returns {string | null}
 */
export function pyIntText(text) {
  if (typeof text !== "string") return null;
  const t = pyStrip(text);
  if (!INT_RE.test(t)) return null;
  return BigInt(t.replace(/_/g, "").replace(/^\+/, "")).toString();
}

/** Python's str.isdigit() for ASCII digits (and the other decimal digits Unicode knows). */
export function pyIsDigit(s) {
  return s.length > 0 && /^\p{Nd}+$/u.test(s);
}

// ---------------------------------------------------------------------- times as datetime
/**
 * Microseconds of Python's datetime.timedelta(seconds=x) for a float x (CPython's rounding: whole
 * seconds exactly, the fraction to the nearest microsecond, halves to even).
 * @param {number} x
 * @returns {number}
 */
export function timedeltaMicros(x) {
  const ip = Math.trunc(x);
  const fp = x - ip;
  let us = ip * 1e6;
  if (fp === 0) return us;
  const d = fp * 1e6;
  const ip2 = Math.trunc(d);
  us += ip2;
  const left = d - ip2;
  let whole = cRound(left);
  if (Math.abs(whole - left) === 0.5) {
    const odd = Math.abs(us % 2) === 1 ? 1 : 0;
    whole = 2.0 * cRound((left + odd) * 0.5) - odd;
  }
  return us + whole;
}

/** C's round(): to the nearest integer, halves away from zero. */
function cRound(v) {
  const t = Math.trunc(v);
  return Math.abs(v - t) >= 0.5 ? t + Math.sign(v) : t;
}

/**
 * Microseconds of mne.annotations._handle_meas_date(x) for a float x (numpy's modf, the fraction
 * times 1e6 rounded half to even).
 * @param {number} x
 */
export function measDateMicros(x) {
  const ip = Math.trunc(x);
  const v = (x - ip) * 1e6;
  const f = Math.floor(v);
  const d = v - f;
  const r = d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  return ip * 1e6 + r;
}
