// Reading JSON and UTF-8 text the way Python does, with Python's error messages, for the BIDS JSON
// sidecars of a recording (register.js): the desktop records "Could not read JSON sidecar x: <the
// error>", and NaN or Infinity in a sidecar (not valid JSON, but common) are read as null and
// reported. Plain ES module.

import { pyFloatRepr } from "./pyfmt.js";

/**
 * Strict UTF-8 decoding with the message of Python's UnicodeDecodeError when the bytes are not
 * UTF-8 ("'utf-8' codec can't decode byte 0xff in position 7: invalid start byte").
 * @param {Uint8Array} bytes
 * @returns {{text: string} | {error: string}}
 */
export function decodeUtf8Python(bytes) {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    /* find the first bad sequence below */
  }
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const b = bytes[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    let need;
    let lo = 0x80;
    let hi = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      if (b === 0xe0) lo = 0xa0;
      if (b === 0xed) hi = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      if (b === 0xf0) lo = 0x90;
      if (b === 0xf4) hi = 0x8f;
    } else return { error: errorText(b, i, i + 1, "invalid start byte", bytes) };
    for (let k = 1; k <= need; k++) {
      if (i + k >= n) return { error: errorText(b, i, n, "unexpected end of data", bytes) };
      const c = bytes[i + k];
      const okLo = k === 1 ? lo : 0x80;
      const okHi = k === 1 ? hi : 0xbf;
      if (c < okLo || c > okHi) return { error: errorText(b, i, i + k, "invalid continuation byte", bytes) };
    }
    i += need + 1;
  }
  return { text: new TextDecoder("utf-8").decode(bytes) };
}

function errorText(b, start, end, reason, bytes) {
  if (end - start === 1) return `'utf-8' codec can't decode byte 0x${bytes[start].toString(16).padStart(2, "0")} in position ${start}: ${reason}`;
  return `'utf-8' codec can't decode bytes in position ${start}-${end - 1}: ${reason}`;
}

/** Python's json.JSONDecodeError. */
export class PyJsonError extends Error {
  /** @param {string} msg @param {number[]} cps the document's code points @param {number} pos */
  constructor(msg, cps, pos) {
    let lineno = 1;
    let lastNl = -1;
    for (let i = 0; i < pos && i < cps.length; i++) {
      if (cps[i] === 0x0a) {
        lineno++;
        lastNl = i;
      }
    }
    super(`${msg}: line ${lineno} column ${pos - lastNl} (char ${pos})`);
    this.name = "JSONDecodeError";
  }
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

/**
 * json.loads(text, parse_constant=...) as Python 3.13 reads it: the value, the constants
 * (NaN, Infinity, -Infinity) that were read as null, and which numbers were written as floats
 * (for the top-level members of an object: their Python repr, so a warning can quote "256" or
 * "256.0" as Python does). Throws PyJsonError with Python's message.
 * @param {string} text
 * @returns {{value: any, constants: string[], numberText: Map<string, string>}}
 */
export function parsePythonJson(text) {
  const cps = Array.from(text, (c) => c.codePointAt(0));
  const n = cps.length;
  const constants = [];
  const numberText = new Map();
  const at = (i) => (i < n ? cps[i] : -1);
  const skip = (i) => {
    while (i < n && WS.has(cps[i])) i++;
    return i;
  };
  const matches = (i, word) => {
    for (let k = 0; k < word.length; k++) if (at(i + k) !== word.charCodeAt(k)) return false;
    return true;
  };

  function scanString(start) {
    // start: index just after the opening quote
    const begin = start - 1;
    let i = start;
    let out = "";
    for (;;) {
      if (i >= n) throw new PyJsonError("Unterminated string starting at", cps, begin);
      const c = cps[i];
      if (c === 0x22) return [out, i + 1];
      if (c === 0x5c) {
        i++;
        if (i >= n) throw new PyJsonError("Unterminated string starting at", cps, begin);
        const e = cps[i];
        if (e !== 0x75) {
          const map = { 0x22: '"', 0x5c: "\\", 0x2f: "/", 0x62: "\b", 0x66: "\f", 0x6e: "\n", 0x72: "\r", 0x74: "\t" };
          if (!(e in map)) throw new PyJsonError("Invalid \\escape", cps, i - 1);
          out += map[e];
          i++;
          continue;
        }
        const hex4 = (p) => {
          let v = 0;
          for (let k = 0; k < 4; k++) {
            const h = at(p + k);
            const d = h >= 0x30 && h <= 0x39 ? h - 0x30 : h >= 0x61 && h <= 0x66 ? h - 87 : h >= 0x41 && h <= 0x46 ? h - 55 : -1;
            if (d < 0) return -1;
            v = v * 16 + d;
          }
          return v;
        };
        i++;
        if (i + 4 >= n) throw new PyJsonError("Invalid \\uXXXX escape", cps, i - 1);
        let u = hex4(i);
        if (u < 0) throw new PyJsonError("Invalid \\uXXXX escape", cps, i - 1);
        i += 4;
        if (u >= 0xd800 && u <= 0xdbff && at(i) === 0x5c && at(i + 1) === 0x75 && i + 6 < n) {
          const u2 = hex4(i + 2);
          if (u2 < 0) throw new PyJsonError("Invalid \\uXXXX escape", cps, i + 1);
          if (u2 >= 0xdc00 && u2 <= 0xdfff) {
            u = 0x10000 + ((u - 0xd800) << 10) + (u2 - 0xdc00);
            i += 6;
          }
        }
        out += String.fromCodePoint(u);
        continue;
      }
      if (c <= 0x1f) throw new PyJsonError("Invalid control character at", cps, i);
      out += String.fromCodePoint(c);
      i++;
    }
  }

  function scanNumber(i) {
    let j = i;
    if (at(j) === 0x2d) j++;
    if (at(j) === 0x30) j++;
    else if (at(j) >= 0x31 && at(j) <= 0x39) {
      while (at(j) >= 0x30 && at(j) <= 0x39) j++;
    } else return null;
    let isFloat = false;
    if (at(j) === 0x2e && at(j + 1) >= 0x30 && at(j + 1) <= 0x39) {
      j += 2;
      while (at(j) >= 0x30 && at(j) <= 0x39) j++;
      isFloat = true;
    }
    if (at(j) === 0x65 || at(j) === 0x45) {
      let k = j + 1;
      if (at(k) === 0x2b || at(k) === 0x2d) k++;
      if (at(k) >= 0x30 && at(k) <= 0x39) {
        while (at(k) >= 0x30 && at(k) <= 0x39) k++;
        j = k;
        isFloat = true;
      }
    }
    const tok = String.fromCodePoint(...cps.slice(i, j));
    return { value: Number(tok), end: j, tok, isFloat };
  }

  // returns [value, end, numberInfo]; throws {expecting: idx} where Python raises StopIteration
  function scanOnce(i, depth) {
    if (depth > 900) throw new PyJsonError("Expecting value", cps, i); // Python would overflow its stack here
    const c = at(i);
    if (c === -1) throw { stop: i };
    if (c === 0x22) return scanString(i + 1);
    if (c === 0x7b) return parseObject(i + 1, depth + 1);
    if (c === 0x5b) return parseArray(i + 1, depth + 1);
    if (c === 0x6e && matches(i, "null")) return [null, i + 4];
    if (c === 0x74 && matches(i, "true")) return [true, i + 4];
    if (c === 0x66 && matches(i, "false")) return [false, i + 5];
    if (c === 0x4e && matches(i, "NaN")) {
      constants.push("NaN");
      return [null, i + 3];
    }
    if (c === 0x49 && matches(i, "Infinity")) {
      constants.push("Infinity");
      return [null, i + 8];
    }
    if (c === 0x2d && matches(i, "-Infinity")) {
      constants.push("-Infinity");
      return [null, i + 9];
    }
    const num = scanNumber(i);
    if (!num) throw { stop: i };
    return [num.value, num.end, num];
  }

  function value(i, depth) {
    try {
      return scanOnce(i, depth);
    } catch (e) {
      if (e && e.stop !== undefined) throw new PyJsonError("Expecting value", cps, e.stop);
      throw e;
    }
  }

  function parseObject(i, depth) {
    const obj = {};
    const top = depth === 1;
    i = skip(i);
    if (at(i) === 0x7d) return [obj, i + 1];
    for (;;) {
      if (at(i) !== 0x22) throw new PyJsonError("Expecting property name enclosed in double quotes", cps, i);
      const [key, afterKey] = scanString(i + 1);
      i = skip(afterKey);
      if (at(i) !== 0x3a) throw new PyJsonError("Expecting ':' delimiter", cps, i);
      i = skip(i + 1);
      const [v, end, num] = value(i, depth);
      Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
      if (top) {
        if (num) numberText.set(key, num.isFloat ? "float" : num.tok);
        else numberText.delete(key);
      }
      i = skip(end);
      if (at(i) === 0x7d) return [obj, i + 1];
      if (at(i) !== 0x2c) throw new PyJsonError("Expecting ',' delimiter", cps, i);
      const comma = i;
      i = skip(i + 1);
      if (at(i) === 0x7d) throw new PyJsonError("Illegal trailing comma before end of object", cps, comma);
    }
  }

  function parseArray(i, depth) {
    const arr = [];
    i = skip(i);
    if (at(i) === 0x5d) return [arr, i + 1];
    for (;;) {
      const [v, end] = value(i, depth);
      arr.push(v);
      i = skip(end);
      if (at(i) === 0x5d) return [arr, i + 1];
      if (at(i) !== 0x2c) throw new PyJsonError("Expecting ',' delimiter", cps, i);
      const comma = i;
      i = skip(i + 1);
      if (at(i) === 0x5d) throw new PyJsonError("Illegal trailing comma before end of array", cps, comma);
    }
  }

  const start = skip(0);
  const [v, end] = value(start, 0);
  const rest = skip(end);
  if (rest !== n) throw new PyJsonError("Extra data", cps, rest);
  return { value: v, constants, numberText };
}

/**
 * How Python prints a top-level member of a parsed object in an f-string: ints as written, floats
 * with repr(), True and False capitalised, None as None.
 * @param {any} v
 * @param {string | undefined} kind "float", the int's text, or undefined (not a number)
 */
export function pyValueText(v, kind) {
  if (v === true) return "True";
  if (v === false) return "False";
  if (v === null || v === undefined) return "None";
  if (typeof v === "number") return kind === "float" ? pyFloatRepr(v) : kind || String(v);
  return String(v);
}

