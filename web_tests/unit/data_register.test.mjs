// Registration in the browser (js/data/register.js): the manifests built from the datasets of
// scripts/make_web_fixtures.py must equal, field by field, those the desktop's loader builds for the
// same files and settings (web_tests/register_parity.py runs electroclean.web.registration.collect).
//
// Tolerances: amplitudes (amplitude.report.amplitudes_v) to 1 part in 100,000, as the data layer's
// own amplitude tests (the browser filters the display copy in single precision); mtime_ns to the
// millisecond (a browser knows a file's time only to the millisecond). created_at and
// electroclean_version are not compared. Paths that Python writes in full in a message (an
// ambiguous sidecar's folder, a malformed TSV) are compared from the dataset folder on, which is
// all a browser knows of them.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, openAsBlob, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import {
  buildManifest,
  buildManifests,
  DEFAULT_SETTINGS,
  findDatasetRecordings,
  registrationSettings,
} from "../../electroclean/web/static/js/data/register.js";
import { ensureFixtures, FIXTURES, ROOT } from "./_fixtures.mjs";

const manifest = ensureFixtures();

function python() {
  for (const p of [process.env.ELECTROCLEAN_PYTHON, join(ROOT, ".venv", "bin", "python"), join(ROOT, ".venv", "Scripts", "python.exe"), "python3"]) {
    if (!p || ((p.includes("/") || p.includes("\\")) && !existsSync(p))) continue;
    const r = spawnSync(p, ["-I", "-c", "import mne, pybv"], { cwd: ROOT, encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}
const PYTHON = python();

/** The files of a dataset as a folder picker gives them (webkitRelativePath from the folder picked). */
async function datasetFiles(name) {
  const base = join(FIXTURES, manifest.datasets[name].root);
  const out = [];
  const walk = async (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else {
        const st = statSync(p);
        const file = new File([await openAsBlob(p)], entry.name, { lastModified: Math.floor(st.mtimeMs) });
        Object.defineProperty(file, "webkitRelativePath", { value: `${name}/${relative(base, p).split("\\").join("/")}` });
        out.push(file);
      }
    }
  };
  await walk(base);
  return out;
}

const CUSTOM_EDF = {
  channels: {
    hide: ["CQ_*", "COUNTER", "INTERPOLATED", "BATTERY", "Flat"],
    types: { HEOG: "eog", VEOG: "eog", ECG: "ecg", Resp: "misc", Fp2: "emg" },
  },
  filters: { highpass_hz: 0.5, notch_hz: 60.0, notch_harmonics: true },
  loading: { apply_channel_types_from_bids: false, show_bids_bad_channels: false },
};
const JOBS = [
  { name: "bids_bv default", dataset: "bids_bv", settings: {} },
  {
    name: "bids_bv without filters, EOG by pattern, BrainVision only",
    dataset: "bids_bv",
    settings: { filters: { highpass_enabled: false, notch_enabled: false }, channels: { types: { "*EOG": "eog" } }, discovery: { suffixes: ["_eeg.vhdr"] } },
  },
  { name: "edf_mix default", dataset: "edf_mix", settings: {} },
  { name: "edf_mix with a study's own settings, for a reference set", dataset: "edf_mix", settings: CUSTOM_EDF, scope: "set:demo" },
  { name: "bv_hand default", dataset: "bv_hand", settings: {} },
  { name: "edge cases, default settings", dataset: "edge", settings: {} },
  {
    name: "edge cases, a trigger channel by pattern and a high-pass above Nyquist",
    dataset: "edge",
    settings: { channels: { types: { DIN: "stim" } }, filters: { highpass_hz: 60.0 } },
  },
];

let expectedCache = null;
function expectedManifests() {
  if (expectedCache) return expectedCache;
  const jobs = JOBS.map((j) => ({ root: join(FIXTURES, manifest.datasets[j.dataset].root), settings: j.settings, scope: j.scope || "study" }));
  const r = spawnSync(PYTHON, ["-I", join(ROOT, "web_tests", "register_parity.py")], {
    cwd: ROOT,
    input: JSON.stringify(jobs),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`register_parity.py failed:\n${(r.stderr || "").slice(-3000)}`);
  expectedCache = JSON.parse(r.stdout);
  return expectedCache;
}

/** Every difference between the browser's value and Python's, as "path: browser vs python". */
function differences(js, py, path, ctx, out = []) {
  if (path.endsWith(".created_at") || path.endsWith(".electroclean_version")) return out;
  if (/\.mtime_ns$/.test(path)) {
    if (!(typeof js === "number" && Math.abs(js - py) <= 1e6 + 1024)) out.push(`${path}: ${js} vs ${py}`);
    return out;
  }
  if (typeof py === "string") {
    const want = py.split(ctx.rootParent).join("");
    if (js !== want) out.push(`${path}: ${JSON.stringify(js)} vs ${JSON.stringify(want)}`);
    return out;
  }
  if (typeof py === "number") {
    const ok = /amplitudes_v\.\w+$/.test(path) ? Math.abs(js - py) <= 1e-5 * Math.abs(py) : js === py;
    if (!ok) out.push(`${path}: ${js} vs ${py}`);
    return out;
  }
  if (py === null || typeof py !== "object") {
    if (js !== py) out.push(`${path}: ${JSON.stringify(js)} vs ${JSON.stringify(py)}`);
    return out;
  }
  if (Array.isArray(py)) {
    if (!Array.isArray(js)) return out.push(`${path}: not a list (${JSON.stringify(js)})`), out;
    if (js.length !== py.length) out.push(`${path}: ${js.length} items vs ${py.length}: ${JSON.stringify(js).slice(0, 400)} vs ${JSON.stringify(py).slice(0, 400)}`);
    for (let i = 0; i < Math.min(js.length, py.length); i++) differences(js[i], py[i], `${path}[${i}]`, ctx, out);
    return out;
  }
  if (js === null || typeof js !== "object" || Array.isArray(js)) return out.push(`${path}: not an object (${JSON.stringify(js)})`), out;
  const keys = new Set([...Object.keys(py), ...Object.keys(js)]);
  for (const k of keys) {
    if (!(k in py)) out.push(`${path}.${k}: only in the browser's (${JSON.stringify(js[k]).slice(0, 200)})`);
    else if (!(k in js)) out.push(`${path}.${k}: missing (${JSON.stringify(py[k]).slice(0, 200)})`);
    else differences(js[k], py[k], `${path}.${k}`, ctx, out);
  }
  return out;
}

const skipPython = !PYTHON && "no Python with ElectroClean and MNE-Python (set ELECTROCLEAN_PYTHON)";

JOBS.forEach((job, k) => {
  test(`the same manifests as the desktop's registration: ${job.name}`, { skip: skipPython, timeout: 300000 }, async () => {
    const py = expectedManifests()[k];
    const ctx = { rootParent: `${dirname(py.root)}/` };
    const files = await datasetFiles(job.dataset);
    const stages = new Set();
    const out = await buildManifests(files, { settings: job.settings, scope: job.scope, worker: false, onProgress: (p) => stages.add(p.stage) });
    assert.deepEqual(out.manifests.map((m) => m.recording_id), py.manifests.map((m) => m.recording_id), "the same recordings");
    const diffs = [];
    out.manifests.forEach((m, i) => differences(m, py.manifests[i], m.recording_id, ctx, diffs));
    assert.deepEqual(diffs, [], `differences:\n${diffs.join("\n")}`);
    assert.deepEqual(
      out.failures.map((f) => [f.path, f.reason]),
      py.failures.map((f) => [f.recording_id, f.reason.split(ctx.rootParent).join("")]),
      "the same recordings refused, for the same reasons",
    );
    assert.ok(stages.has("start") && stages.has("done") && stages.has("fingerprint"), [...stages].join(", "));
  });
});

// The study server checks every manifest a browser sends before storing it (recordings_register,
// electroclean/web/manifest_check.py), and keeps only the fields it knows: every manifest built
// here must pass, and come back unchanged. Until the server side is in this tree, the test says so.
//
// One refusal is known: the server requires every original event to lie inside the recording,
// while the desktop's loader keeps an events.tsv row past the end with a warning ("1 original
// event(s) lie outside the recording"), so the desktop's own manifest of bids_bv's sub-02 (whose
// events.tsv has such a row on purpose) is refused as well. It is allowed here only with that reason.
const KNOWN_REFUSALS = new Map([
  ["sub-02/eeg/sub-02_task-rest_eeg.vhdr", /an original event at sample 249750 lies outside the recording \(0 to 5000\)$/],
]);
test("the study server accepts every manifest the browser builds, and keeps it as it is", { skip: skipPython, timeout: 300000 }, async (t) => {
  const built = [];
  for (const job of JOBS) {
    const out = await buildManifests(await datasetFiles(job.dataset), { settings: job.settings, scope: job.scope, worker: false });
    built.push({ job, manifests: out.manifests });
  }
  const input = built.map(({ job, manifests }) => ({ manifests, scope: job.scope || "study", suffixes: registrationSettings(job.settings).suffixes }));
  const r = spawnSync(PYTHON, ["-I", join(ROOT, "web_tests", "register_parity.py"), "--check"], {
    cwd: ROOT,
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`register_parity.py --check failed:\n${(r.stderr || "").slice(-3000)}`);
  const answer = JSON.parse(r.stdout);
  if (answer.unavailable) {
    t.skip(`the study server's checks of a manifest are not in this tree yet: ${answer.unavailable}. This test runs once the server side is merged`);
    return;
  }
  const problems = [];
  let n = 0;
  answer.results.forEach((results, i) => results.forEach((res, j) => {
    const m = built[i].manifests[j];
    n += 1;
    const known = KNOWN_REFUSALS.get(m.recording_id);
    if (!res.ok && !(known && built[i].job.dataset === "bids_bv" && known.test(res.reason))) {
      problems.push(`${built[i].job.name}, ${m.recording_id}: refused: ${res.reason}`);
    } else if (res.ok) {
      for (const d of differences(m, res.checked, m.recording_id, { rootParent: "//none//" })) problems.push(`${built[i].job.name}: ${d}`);
    }
  }));
  assert.ok(n >= 15, `${n} manifests checked`);
  assert.deepEqual(problems, [], `the server's checks:\n${problems.join("\n")}`);
});

test("discovery: recording IDs below the folder picked, the folders and files left out", { skip: false }, async () => {
  const files = await datasetFiles("bids_bv");
  const { recordings, ignored } = findDatasetRecordings(files);
  assert.deepEqual(recordings.map((r) => r.recordingId), [
    "sub-01/eeg/sub-01_task-rest_eeg.vhdr",
    "sub-02/eeg/sub-02_task-rest_eeg.vhdr",
    "sub-03/eeg/sub-03_task-rest_eeg.vhdr",
  ]);
  assert.deepEqual(ignored.map((i) => i.path), [
    "bids_bv/derivatives/sub-01/eeg/sub-01_task-rest_eeg.vhdr",
    "bids_bv/extra/pilot.vhdr",
    "bids_bv/sub-01/eeg/._sub-01_task-rest_eeg.vhdr",
  ]);
  assert.match(ignored[0].reason, /derivatives/);
  const sub1 = recordings[0];
  assert.deepEqual(sub1.files.map((f) => f.name).sort(), [
    "sub-01_task-rest_channels.tsv",
    "sub-01_task-rest_eeg.eeg",
    "sub-01_task-rest_eeg.json",
    "sub-01_task-rest_eeg.vhdr",
    "sub-01_task-rest_eeg.vmrk",
    "sub-01_task-rest_events.json",
    "sub-01_task-rest_events.tsv",
    "task-rest_eeg.json",
    "task-rest_events.json",
  ]);
  assert.deepEqual(sub1.sidecars.eegJsonChain.map((e) => e.path), ["task-rest_eeg.json", "sub-01/eeg/sub-01_task-rest_eeg.json"]);
  assert.equal(sub1.sizeBytes, sub1.files.reduce((a, f) => a + f.size, 0));
  const edf = findDatasetRecordings(await datasetFiles("edf_mix"));
  assert.ok(edf.ignored.some((i) => i.path === "edf_mix/notes.edf" && /does not end with/.test(i.reason)));
  assert.ok(edf.ignored.some((i) => i.path === "edf_mix/Annotated_Events/sub-07_task-rest_eeg.edf"));
  assert.ok(edf.ignored.some((i) => i.path === "edf_mix/.cache/sub-09_task-rest_eeg.edf"));
  // the discovery suffixes come from the settings
  const only = findDatasetRecordings(files, { settings: { settings: { discovery: { suffixes: ["_EEG.VHDR"] } } } });
  assert.equal(only.recordings.length, 3);
  assert.equal(findDatasetRecordings(files, { settings: { discovery: { suffixes: ["_eeg.edf"] } } }).recordings.length, 0);
});

test("files chosen one by one: recording IDs are their names", async () => {
  const files = (await datasetFiles("edf_mix")).filter((f) => !f.webkitRelativePath.slice(8).includes("/"));
  const plain = files.map((f) => new File([f], f.name, { lastModified: f.lastModified }));
  const { recordings } = findDatasetRecordings(plain);
  assert.ok(recordings.some((r) => r.recordingId === "sub-02_task-rest_eeg.edf"));
  const r = recordings.find((x) => x.recordingId === "sub-02_task-rest_eeg.edf");
  assert.deepEqual(r.files.map((f) => f.name).sort(), [
    "sub-02_task-rest_channels.tsv",
    "sub-02_task-rest_eeg.edf",
    "sub-02_task-rest_eeg.json",
    "sub-02_task-rest_events.json",
    "sub-02_task-rest_events.tsv",
  ]);
  // buildManifest also takes a recording given as its own files
  const { manifest: m, problems } = await buildManifest({ recordingId: r.recordingId, files: r.files }, { worker: false });
  assert.equal(m.recording_id, "sub-02_task-rest_eeg.edf");
  assert.equal(m.files.channels_tsv, "sub-02_task-rest_channels.tsv");
  assert.deepEqual(problems, m.warnings);
  assert.equal(m.schema, "electroclean.web_manifest");
  assert.match(m.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
});

test("a BrainVision recording whose companions are missing is refused in the desktop's words", async () => {
  const files = (await datasetFiles("bids_bv")).filter((f) => !f.name.endsWith(".eeg"));
  const out = await buildManifests(files, { worker: false });
  assert.equal(out.manifests.length, 0);
  assert.deepEqual(out.failures[0], {
    path: "sub-01/eeg/sub-01_task-rest_eeg.vhdr",
    reason: "Data file 'sub-01_task-rest_eeg.eeg' named in sub-01_task-rest_eeg.vhdr was not found",
    kind: "missing_companion",
  });
});

test("the default settings are those of default_settings.json", () => {
  const defaults = JSON.parse(readFileSync(join(ROOT, "electroclean", "config", "default_settings.json"), "utf8"));
  for (const block of Object.keys(DEFAULT_SETTINGS)) assert.deepEqual(DEFAULT_SETTINGS[block], defaults[block], block);
  const s = registrationSettings({ name: "x", settings: { channels: { types: { "EXG*": " MISC " } } } });
  assert.deepEqual(s.typePatterns, [["EXG*", "misc"]]);
  assert.deepEqual(s.hide, defaults.channels.hide);
});

test("registration can be stopped between recordings", async () => {
  const controller = new AbortController();
  const files = await datasetFiles("edf_mix");
  const out = await buildManifests(files, {
    worker: false,
    signal: controller.signal,
    onProgress: (p) => {
      if (p.stage === "done" && p.index === 0) controller.abort();
    },
  });
  assert.equal(out.manifests.length + out.failures.length, 1);
});
