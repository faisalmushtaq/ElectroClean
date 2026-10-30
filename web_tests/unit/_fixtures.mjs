// Shared helpers for the data-layer tests: the test recordings written by
// scripts/make_web_fixtures.py (generated here when missing or out of date) and File objects for
// them. Not a test file itself (node --test only runs *.test.mjs).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openAsBlob, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURES = join(ROOT, "web_tests", "fixtures");
export const DATA = join(ROOT, "electrotag", "web", "static", "js", "data");
/** Must equal FIXTURE_VERSION in scripts/make_web_fixtures.py. */
export const FIXTURE_VERSION = 5;

/** The Python that writes the fixtures: ELECTROTAG_PYTHON, the repository's .venv, or python3. */
export function fixturePython() {
  return python();
}

function python() {
  if (process.env.ELECTROTAG_PYTHON) return process.env.ELECTROTAG_PYTHON;
  for (const p of [join(ROOT, ".venv", "bin", "python"), join(ROOT, ".venv", "Scripts", "python.exe")]) if (existsSync(p)) return p;
  return process.platform === "win32" ? "python" : "python3";
}

function manifestOk(needPerf) {
  try {
    const m = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));
    if (m.version !== FIXTURE_VERSION) return false;
    if (needPerf && !(m.perf && existsSync(join(FIXTURES, m.perf.file)))) return false;
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Make sure the fixtures exist (several test files may ask at once: one generates them, the others
 * wait). With perf, also the 128-channel, 30-minute BDF used for timing.
 */
export function ensureFixtures({ perf = false } = {}) {
  if (manifestOk(perf)) return JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));
  mkdirSync(FIXTURES, { recursive: true });
  const lock = join(FIXTURES, ".lock");
  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      // another test process is writing the fixtures; a lock older than 15 minutes is stale
      try {
        if (Date.now() - statSync(lock).mtimeMs > 15 * 60 * 1000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* gone already */
      }
      if (manifestOk(perf)) return JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));
      if (Date.now() > deadline) throw new Error("Timed out waiting for the test fixtures");
      sleep(500);
    }
  }
  try {
    if (!manifestOk(perf)) {
      const args = [join(ROOT, "scripts", "make_web_fixtures.py"), ...(perf ? ["--perf"] : [])];
      const r = spawnSync(python(), args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (r.status !== 0) {
        throw new Error(
          "Could not write the test recordings. Run `python scripts/make_web_fixtures.py` from the repository root " +
            "with the development dependencies installed (mne, numpy, scipy, pybv), or set ELECTROTAG_PYTHON.\n" +
            (r.stderr || r.error || "").toString().slice(-2000),
        );
      }
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
  return JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));
}

/** The fixture's description from the manifest. */
export function fixtureInfo(manifest, name) {
  const f = manifest.fixtures[name];
  if (!f) throw new Error(`No fixture ${name}`);
  return f;
}

/** Path of one of a fixture's files. */
export function fixturePath(manifest, name, file) {
  const f = fixtureInfo(manifest, name);
  return join(FIXTURES, f.folder || "", file);
}

/** File objects for a fixture, read lazily from disk as a browser File would be. */
export async function fixtureFiles(manifest, name) {
  const f = fixtureInfo(manifest, name);
  return Promise.all(f.files.map(async (n) => new File([await openAsBlob(fixturePath(manifest, name, n))], n)));
}

/** What MNE reads from a fixture (scripts/make_web_fixtures.py). */
export function expected(name) {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.expected.json`), "utf8"));
}

/** The largest |a - b| / scale over arrays. */
export function maxRelDiff(a, b, scale) {
  let m = 0;
  for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]) / scale);
  return m;
}
