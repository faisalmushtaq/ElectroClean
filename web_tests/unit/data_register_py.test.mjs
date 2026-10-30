// The small imitations of Python behind the manifests the browser builds (js/eeg/pyfmt.js and
// pyjson.js), checked against Python itself on a corpus of values: repr of floats, format
// specifications with their rounding of ties, repr of strings, the messages of json and UTF-8
// errors, the desktop's parse_float and parse_int_code, and datetime.timedelta's rounding.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { pyCompare, pyFixed, pyFloatRepr, pyFormatG, pyIntText, pyListRepr, pySetRepr, pyStrip, pyStrRepr, timedeltaMicros } from "../../electrotag/web/static/js/eeg/pyfmt.js";
import { decodeUtf8Python, parsePythonJson, pyValueText } from "../../electrotag/web/static/js/eeg/pyjson.js";
import { parseFloatPy, parseIntCode } from "../../electrotag/web/static/js/eeg/events.js";
import { parseBidsName, parseTsvText, TsvError } from "../../electrotag/web/static/js/eeg/bids.js";
import { ROOT } from "./_fixtures.mjs";

function python() {
  for (const p of [process.env.ELECTROTAG_PYTHON, join(ROOT, ".venv", "bin", "python"), join(ROOT, ".venv", "Scripts", "python.exe"), "python3"]) {
    if (!p || ((p.includes("/") || p.includes("\\")) && !existsSync(p))) continue;
    const r = spawnSync(p, ["-I", "-c", "import mne"], { cwd: ROOT, encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}
const PYTHON = python();

/** A small deterministic generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20261028);
const floats = [0, -0, 1, -1, 0.1, 0.5, 1 / 3, 2 / 3, 100, 1e15, 1e16, 1e17, 123456789012345680, 1e-4, 1e-5, 0.00012, 1.5e-300, 5e-324,
  1.7976931348623157e308, 256, 512.5, 3.0000000000000004, 0.30000000000000004, 1e21, 1e22, 2 ** 53, 2 ** 53 + 2, 9.999999999999999e15];
for (let i = 0; i < 300; i++) {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setUint32(0, Math.floor(rand() * 2 ** 32));
  buf.setUint32(4, Math.floor(rand() * 2 ** 32));
  const x = buf.getFloat64(0);
  if (Number.isFinite(x)) floats.push(x);
}
for (const sfreq of [128, 250, 256, 500, 512, 1000, 1024, 2048]) for (let i = 0; i < 25; i++) floats.push(Math.floor(rand() * 1e7) / sfreq);
const fixed = [[0.0625, 3], [-0.0625, 3], [0.125, 2], [0.375, 2], [2.5, 0], [3.5, 0], [1.005, 2], [0.0005, 3], [1e20, 3], [123.456, 3], [0, 3], [-0, 2]];
for (let i = 0; i < 100; i++) fixed.push([Math.floor(rand() * 4e6) / 256, 3]);
for (let i = 0; i < 60; i++) fixed.push([(rand() - 0.5) * 10 ** Math.floor(rand() * 8 - 4), 2]);
const g = [[50, null], [60, null], [0.0001, null], [1e-5, null], [123456, null], [1234567, null], [0.1, null], [100, null], [1e16, null],
  [999999.5, null], [3.14159265, 3], [0.000123456, 3], [9.9999995, 3], [-2.5e-7, null], [0.5, null], [1.25, 2]];
for (let i = 0; i < 60; i++) g.push([(rand() - 0.5) * 10 ** Math.floor(rand() * 14 - 7), rand() < 0.5 ? null : 1 + Math.floor(rand() * 8)]);
const cp = (...codes) => String.fromCodePoint(...codes);
const strings = ["abc", "it's", 'say "hi"', `both ' and "`, "back\\slash", "tab\tnew\nline\rend", cp(0, 0x1f, 0x7f), "café",
  `${cp(0xa0)}nbsp`, cp(0x2028), cp(0x1f600), cp(0x200b), String.fromCharCode(0xd800), cp(0x85), "", "2026-01-01_12:00:02.000000",
  cp(0xe9, 0x301), cp(0x10ffff)];
const json = ["", " ", "{", '{"a"', '{"a":', '{"a": 1,}', "[1,]", "[1 2]", '{"a" 1}', "{1: 2}", "nul", "tru", '"abc', '"a\\x"', '"\\u12"',
  '"\\u12G4"', '{"a": "b\nc"}', "01", "1.", "-", "1e", "{} []", "NaN", "-Infinity", "[NaN, Infinity]", '\n\n  {"a": ]', '"\\ud800\\u00"',
  '{"a": 1}\n\n x', "[1, 2,\n 3,,]", '{"a": {"b": [1, {"c": }]}}', '{"é": 1, "a": tru}', `{"${cp(0x1f600)}": x}`, "[\t1,\r\n2 ,]"];
const utf8 = [[0xff], [0x61, 0x80], [0xe2, 0x82], [0xe2, 0x28, 0xa1], [0xf0, 0x90, 0x80], [0xed, 0xa0, 0x80], [0xc0, 0x80],
  [0xf4, 0x90, 0x80, 0x80], [0xe0, 0x80, 0x80], [0x61, 0xf0, 0x9f, 0x98], [0xf0, 0x9f, 0x98, 0x41], [0x41, 0x42, 0xc3], [0xc3, 0xa9]];
const parse = ["1", " 2 ", "+3", "-0", "007", "1_000", "1__0", "1.5", "1.0", "1e3", "1E-2", ".5", "5.", "inf", "-Infinity", "nan", "abc", "",
  "n/a", "0x10", "1 2", "\t42\n", "1e400", "-1e400", "2.0000000000000001", "123456789012345678901234567890", "1e20", "_1", "1_"];
const seconds = [0.5e-6, 1.5e-6, 2.5e-6, 0.1, 1 / 3, 2 / 3, 1e-7, 12345.6789, -0.5e-6, -1.5e-6, 59.999999, 0.0000005, 0.0000015];
for (const sfreq of [128, 250, 256, 500, 512, 1000, 1024, 2048]) for (let i = 0; i < 25; i++) seconds.push(Math.floor(rand() * 1e7) / sfreq);

// JSON has no NaN, infinities or negative zero: those go as text, which Python's float() reads
const enc = (x) => (Number.isNaN(x) ? "nan" : x === Infinity ? "inf" : x === -Infinity ? "-inf" : Object.is(x, -0) ? "-0.0" : x);
let answers = null;
function pythonAnswers() {
  if (answers) return answers;
  const cases = { floats: floats.map(enc), fixed: fixed.map(([x, n]) => [enc(x), n]), g: g.map(([x, p]) => [enc(x), p]), strings, json, utf8, parse, seconds };
  const r = spawnSync(PYTHON, ["-I", join(ROOT, "web_tests", "register_parity.py"), "--python-text"], { cwd: ROOT, input: JSON.stringify(cases), encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr.slice(-2000));
  answers = JSON.parse(r.stdout);
  return answers;
}
const skip = !PYTHON && "no Python with MNE-Python (set ELECTROTAG_PYTHON)";

const mismatches = (got, want, label) => got.map((v, i) => (v === want[i] ? null : `${label}[${i}]: ${JSON.stringify(v)} vs ${JSON.stringify(want[i])}`)).filter(Boolean);

test("repr() of floats", { skip }, () => {
  const want = pythonAnswers().repr;
  assert.deepEqual(mismatches(floats.map(pyFloatRepr), want, "repr"), []);
  assert.equal(pyFloatRepr(NaN), "nan");
  assert.equal(pyFloatRepr(-Infinity), "-inf");
});

test("format(x, '.Nf') and format(x, 'g'), ties rounded to even", { skip }, () => {
  const a = pythonAnswers();
  assert.deepEqual(mismatches(fixed.map(([x, n]) => pyFixed(x, n)), a.fixed, "fixed"), []);
  assert.deepEqual(mismatches(g.map(([x, p]) => (p === null ? pyFormatG(x) : pyFormatG(x, p))), a.g, "g"), []);
});

test("repr() of strings", { skip }, () => {
  assert.deepEqual(mismatches(strings.map(pyStrRepr), pythonAnswers().str_repr, "repr"), []);
  assert.equal(pyListRepr(["a", "b'c", 3]), `['a', "b'c", 3]`);
  assert.equal(pySetRepr(["b", "a", "b"]), "{'a', 'b'}");
});

test("json errors and UTF-8 errors in Python's words", { skip }, () => {
  const a = pythonAnswers();
  const jsErrors = json.map((t) => {
    try {
      parsePythonJson(t);
      return "";
    } catch (e) {
      return e.message;
    }
  });
  assert.deepEqual(mismatches(jsErrors, a.json_errors, "json"), []);
  const u = utf8.map((b) => {
    const r = decodeUtf8Python(Uint8Array.from(b));
    return "error" in r ? r.error : "";
  });
  assert.deepEqual(mismatches(u, a.utf8_errors, "utf8"), []);
  const parsed = parsePythonJson('{"a": NaN, "b": 1, "c": 2.0, "b": 3, "d": [Infinity]}');
  assert.deepEqual(parsed.value, { a: null, b: 3, c: 2, d: [null] });
  assert.deepEqual(parsed.constants, ["NaN", "Infinity"]);
  assert.equal(pyValueText(parsed.value.c, parsed.numberText.get("c")), "2.0");
  assert.equal(pyValueText(parsed.value.b, parsed.numberText.get("b")), "3");
  assert.equal(pyValueText(true, undefined), "True");
});

test("the desktop's parse_float and parse_int_code", { skip }, () => {
  const a = pythonAnswers();
  assert.deepEqual(mismatches(parse.map((t) => (parseFloatPy(t) === null ? null : pyFloatRepr(parseFloatPy(t)))), a.parse_float, "parse_float"), []);
  assert.deepEqual(mismatches(parse.map(parseIntCode), a.parse_int, "parse_int_code"), []);
  assert.equal(pyIntText(" -007 "), "-7");
});

test("datetime.timedelta(seconds=x) to the microsecond", { skip }, () => {
  assert.deepEqual(mismatches(seconds.map(timedeltaMicros), pythonAnswers().timedelta_us, "timedelta"), []);
});

test("small helpers: Python's ordering, strip, BIDS names and TSV", () => {
  assert.ok(pyCompare(String.fromCodePoint(0x1f600), String.fromCodePoint(0xffff)) > 0, "by code point, not UTF-16 unit");
  assert.ok(pyCompare("a", "b") < 0 && pyCompare("b", "a") > 0 && pyCompare("a", "a") === 0 && pyCompare("a", "ab") < 0);
  assert.equal(pyStrip(`${String.fromCharCode(0x1c, 0x85)} x ${String.fromCharCode(0xa0)}`), "x");
  const n = parseBidsName("sub-01_ses-a_task-rest_run-1_eeg.vhdr");
  assert.deepEqual([...n.entities], [["sub", "01"], ["ses", "a"], ["task", "rest"], ["run", "1"]]);
  assert.equal(n.suffix, "eeg");
  assert.equal(n.extension, ".vhdr");
  assert.equal(parseBidsName("rec1.edf").suffix, "rec1");
  assert.equal(parseBidsName("sub-01.edf").suffix, "");
  assert.equal(parseBidsName("x.nii.gz").extension, ".nii.gz");
  assert.deepEqual(parseTsvText("a\tb\r\n1\t2\r\n\n\n", "x.tsv"), [["a", "b"], [["1", "2"]]]);
  // a byte-order mark is dropped; a row of tabs is a row, not a blank line
  assert.deepEqual(parseTsvText(`${String.fromCharCode(0xfeff)}a\tb\n\t\n`, "x.tsv"), [["a", "b"], [["", ""]]]);
  assert.throws(() => parseTsvText("a\n\t\n", "x.tsv"), /x.tsv line 2 has 2 fields but the header has 1/);
  assert.throws(() => parseTsvText("a\ta\n", "x.tsv"), (e) => e instanceof TsvError && e.message === "x.tsv has duplicate column names: ['a', 'a']");
  assert.throws(() => parseTsvText("\n\n", "x.tsv"), /x.tsv is empty \(no header row\)/);
  assert.throws(() => parseTsvText("a\t \n", "x.tsv"), /has an empty column name/);
});
