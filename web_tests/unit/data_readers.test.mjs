// EDF, EDF+, BDF and BrainVision recordings read in the browser compared with what MNE-Python
// reads from the same files (scripts/make_web_fixtures.py): sampling rate, length, channel names
// and types, measurement date, samples in volts, markers, gaps, discontinuities, triggers and the
// desktop application's refusals.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { openAsBlob, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import test from "node:test";

import { openRecording } from "../../electrotag/web/static/js/eeg/recording.js";
import { finishStimSteps, parseTals, stimEvents, stimSteps } from "../../electrotag/web/static/js/eeg/edf.js";
import { parseIni, parseVhdr, parseVmrk } from "../../electrotag/web/static/js/eeg/brainvision.js";
import { ensureFixtures, expected, fixtureFiles, fixturePython, ROOT } from "./_fixtures.mjs";

const manifest = ensureFixtures();
const READABLE = Object.entries(manifest.fixtures)
  .filter(([, f]) => !f.error && !f.mne_error)
  .map(([name]) => name);
const REFUSED = Object.entries(manifest.fixtures).filter(([, f]) => f.error);
/** Channels whose samples MNE resamples with an FFT and the browser interpolates linearly. */
const LOWER_RATE = { edf_mixed: ["Resp"] };
for (const [name, f] of Object.entries(manifest.fixtures)) if (f.lower_rate) LOWER_RATE[name] = f.lower_rate;

async function open(name, options = {}) {
  return openRecording(await fixtureFiles(manifest, name), { worker: false, ...options });
}

/**
 * The comparisons with MNE-Python for one recording: its header, channels and markers, its samples
 * and its fingerprint. openIt opens it, expOf gives what MNE read (make_web_fixtures.describe) and
 * lowerNames its channels at a lower rate than the others.
 */
function readerTests(name, openIt, expOf, lowerNames, options = {}) {
  test(`${name}: header, channels and markers as MNE reads them`, options, async () => {
    const exp = expOf();
    const rec = await openIt();
    try {
      assert.equal(rec.format, exp.format);
      assert.equal(rec.sfreq, exp.sfreq);
      assert.equal(rec.nSamples, exp.n_samples);
      assert.equal(rec.durationS, exp.n_samples / exp.sfreq);
      assert.equal(rec.sizeBytes, exp.size_bytes);
      assert.deepEqual(
        rec.channels.map((c) => c.name),
        exp.ch_names,
      );
      assert.deepEqual(
        rec.channels.map((c) => c.type),
        exp.browser_types,
      );
      assert.equal(rec.measDate, exp.meas_date);
      const events = exp.annotations.filter((a) => !a.description.toLowerCase().startsWith("bad_acq_skip"));
      if (events.length) {
        assert.equal(rec.markerSource, "annotations");
        assert.deepEqual(
          rec.markers.map((m) => [m.onsetSample, m.durationSamples, m.description]),
          events.map((a) => [a.onset_sample, a.duration_samples, a.description]),
        );
      } else if (exp.triggers.length) {
        assert.equal(rec.markerSource, "triggers");
        assert.deepEqual(
          rec.markers.map((m) => [m.onsetSample, m.value, m.channel]),
          exp.triggers.map((t) => [t.sample, t.code, t.channel]),
        );
      } else assert.equal(rec.markers.length, 0);
      assert.deepEqual(rec.triggers.map((t) => [t.sample, t.code, t.channel]), exp.triggers.map((t) => [t.sample, t.code, t.channel]));
      assert.deepEqual(rec.gaps, exp.gaps);
      assert.deepEqual(rec.discontinuities, exp.discontinuities);
      if (exp.warning) assert.ok(rec.warnings.some((w) => w.includes(exp.warning)), rec.warnings.join("\n"));
    } finally {
      rec.close();
    }
  });

  test(`${name}: samples in volts within float32 precision of MNE's`, options, async () => {
    const exp = expOf();
    const rec = await openIt();
    try {
      const lower = new Set(lowerNames.map((n) => exp.ch_names.indexOf(n)));
      // lower-rate channels: MNE resamples with an FFT, the browser interpolates linearly; they
      // agree to a few per cent of the channel's range (more at the very end, where the FFT wraps)
      const range = exp.ch_names.map((_, c) => {
        let m = 0;
        for (const w of exp.windows) for (const v of w.values[c]) m = Math.max(m, Math.abs(v));
        return m;
      });
      // options.lowerFactors (real recordings): each lower-rate channel's factor to the recording's rate;
      // such a channel is compared at its own sample times only, where both readers give the stored
      // value (between them MNE's FFT resampling and the browser's straight lines can differ by much
      // more than 5% of the range for a signal sampled at 1 Hz)
      const factors = options.lowerFactors || null;
      const check = (got, want, c, where, first = 0) => {
        let only = null;
        if (lower.has(c)) {
          if (!factors) {
            for (let i = 0; i < want.length; i++) assert.ok(Math.abs(got[i] - want[i]) <= 0.05 * range[c], `${where} ${exp.ch_names[c]}: ${got[i]} vs ${want[i]}`);
            return;
          }
          only = factors[exp.ch_names[c]];
        }
        for (let i = 0; i < want.length; i++) {
          if (only && (first + i) % only !== 0) continue;
          const tol = Math.abs(want[i]) * 2 ** -24 * 1.001 + 1e-300;
          assert.ok(Math.abs(got[i] - want[i]) <= tol, `${where} ${exp.ch_names[c]}[${i}]: ${got[i]} vs ${want[i]}`);
        }
      };
      for (const w of exp.windows) {
        const r = await rec.readWindow({ startSample: w.start, nSamples: w.n });
        assert.equal(r.startSample, w.start);
        assert.equal(r.nSamples, w.n);
        assert.equal(r.data.length, exp.ch_names.length);
        assert.ok(r.data.every((d) => d instanceof Float32Array && d.length === w.n));
        w.values.forEach((row, c) => check(r.data[c], row, c, `window ${w.start}`, w.start));
      }
      // single samples, read one at a time and in a single request
      for (const [k, idx] of exp.samples.indices.entries()) {
        const r = await rec.readWindow({ startSample: idx, nSamples: 1 });
        exp.samples.values.forEach((vals, c) => check([r.data[c][0]], [vals[k]], c, `sample ${idx}`, idx));
      }
    } finally {
      rec.close();
    }
  });

  test(`${name}: fingerprint is hashlib's SHA-256 of the data file`, options, async () => {
    const exp = expOf();
    const rec = await openIt();
    try {
      const progress = [];
      const fp = await rec.fingerprint((f) => progress.push(f));
      assert.deepEqual(fp, { algorithm: "sha256", role: "eeg", hex: exp.sha256, sizeBytes: exp.size_bytes });
      assert.equal(progress.at(-1), 1);
    } finally {
      rec.close();
    }
  });
}

for (const name of READABLE) readerTests(name, () => open(name), () => expected(name), LOWER_RATE[name] || []);

for (const [name, info] of REFUSED) {
  test(`${name}: refused as the desktop refuses it`, async () => {
    await assert.rejects(open(name), (e) => {
      assert.ok(e.message.includes(info.error), e.message);
      assert.ok(e.kind && e.kind !== "load_error", e.kind);
      return true;
    });
  });
}

test("EDF+ refusal and size messages use the desktop's wording", async () => {
  await assert.rejects(open("edfplusd"), /is an EDF\+D file \(discontinuous: its data records are not contiguous in time\)\. MNE-Python reads such files as if they were continuous/);
  await assert.rejects(open("truncated"), /the header announces 10 data record\(s\) of 1 s but the file holds only 9 and part of another, so it is probably truncated/);
  await assert.rejects(open("longer"), /the file is 12 byte\(s\) longer than the 10 data record\(s\) its header announces/);
});

test("housekeeping and trigger channels are suggested as hidden", async () => {
  const rec = await open("emotiv");
  try {
    assert.deepEqual(rec.suggestedHidden, ["COUNTER", "INTERPOLATED", "CQ_Fp1", "CQ_Fp2", "BATTERY"]);
    assert.ok(rec.notes.some((n) => n.includes("housekeeping")));
    assert.ok(rec.warnings.some((w) => w.includes("BAD_ACQ_SKIP") && w.includes("padding of the last data record")));
  } finally {
    rec.close();
  }
  const bdf = await open("bdf_status");
  try {
    assert.deepEqual(bdf.suggestedHidden, ["Status"]);
    assert.equal(bdf.channels.find((c) => c.name === "Status").type, "stim");
    assert.ok(bdf.notes.some((n) => n.includes("Status") && n.includes("original events were read from them")));
  } finally {
    bdf.close();
  }
});

test("BDF Status triggers: lower 16 bits, consecutive codes, no initial event, a code on the last sample", async () => {
  const rec = await open("bdf_status");
  try {
    const got = rec.markers.map((m) => [m.onsetSample, m.value]);
    // codes from the fixture: 7 at the start (not an event), 5, 3 then 4 directly, (1 << 16) | 9
    // read as 9, bit 16 or 20 alone (no event), a negative 24-bit value with 12 below, 255, and
    // a 6 on the last sample (MNE ends the channel with a zero, so it counts)
    assert.deepEqual(got, [
      [1000, 5],
      [2000, 3],
      [2100, 4],
      [3000, 9],
      [5000, 12],
      [6000, 255],
      [rec.nSamples - 1, 6],
    ]);
    const status = rec.channels.findIndex((c) => c.name === "Status");
    const r = await rec.readWindow({ startSample: 3000, nSamples: 1, channels: [status], filters: { highpassHz: 1, notchHz: 60 } });
    assert.equal(r.data[0][0], (1 << 16) | 9, "trigger channels are never filtered and keep MNE's 17 bits");
  } finally {
    rec.close();
  }
});

test("EDF+ annotations: TAL parsing as MNE's _read_annotations_edf", () => {
  const tal = "+0\x14\x14\x00\x00+0.5\x15\x31.25\x14Blink\x14\x00+2\x14A\x14B\x14\x00+2\x14A\x14\x00+3\x14X@@Cz\x14\x00+3\x14X@@Pz\x14\x00";
  const anns = parseTals(tal, ["Cz", "Pz"]);
  assert.deepEqual(
    anns.map((a) => [a.onset, a.duration, a.description, a.channels]),
    [
      [0.5, 1.25, "Blink", []],
      [2, 0, "A", []],
      [2, 0, "B", []],
      [2, 0, "A", []],
      [3, 0, "X", ["Cz", "Pz"]],
    ],
  );
  // a first time-keeping TAL that does not start at 0 shifts every onset
  const shifted = parseTals("+0.25\x14\x14\x00+1.25\x14E\x14\x00", []);
  assert.equal(shifted[0].onset, 1);
});

test("trigger steps and events as mne.find_events with consecutive=True", () => {
  const st = { prev: null, steps: [] };
  stimSteps(st, [7, 7, 0, 5, 0, 3, 4, 4, 0, 0x10000, 0, 6], 0, 0xffff);
  assert.deepEqual(stimEvents(st.steps), [
    [3, 5],
    [5, 3],
    [6, 4],
  ]);
  finishStimSteps(st, 12, 0xffff);
  assert.deepEqual(stimEvents(st.steps).at(-1), [11, 6], "the channel is padded with zero after its end");
  assert.deepEqual(stimEvents([[10, 0, 4]]), [], "a code that never steps down gives no events");
  const constant = { prev: null, steps: [] };
  stimSteps(constant, [3, 3, 3], 0, -1);
  finishStimSteps(constant, 3, -1);
  assert.deepEqual(stimEvents(constant.steps), [], "a channel that never changes has no events");
});

test("BrainVision header semantics: configparser, codepages, defaults", () => {
  const ini = parseIni("[A]\nKey = value \n; comment\n# comment\nOther: x\n  continued\n[B]\nk=1\n");
  assert.equal(ini.get("A").get("key"), "value");
  assert.equal(ini.get("A").get("other"), "x\ncontinued");
  assert.equal(ini.get("B").get("k"), "1");
  const cp1252 = new Uint8Array([
    ...new TextEncoder().encode(
      "Brain Vision Data Exchange Header File Version 1.0\n[Common Infos]\nCodepage=ANSI\nDataFile=x.eeg\nMarkerFile=x.vmrk\n" +
        "DataFormat=BINARY\nDataOrientation=MULTIPLEXED\nNumberOfChannels=2\nSamplingInterval=2000\n" +
        "[Binary Infos]\nBinaryFormat=INT_16\n[Channel Infos]\nCh1=Fp1,,0.1,",
    ),
    0xb5,
    0x56,
    ...new TextEncoder().encode("\nCh2=T\\1emp,,0.5,"),
    0xb0,
    0x43,
    0x0a,
  ]);
  const h = parseVhdr(cp1252, "x.vhdr");
  assert.equal(h.sfreq, 500);
  assert.deepEqual(h.names, ["Fp1", "T,emp"]);
  assert.deepEqual(h.units, ["µV", "°C"]);
  assert.deepEqual(h.mneTypes, ["eeg", "misc"]);
  assert.ok(Math.abs(h.ranges[0] * h.cals[0] - 1e-7) < 1e-22);
  const m = parseVmrk(
    new TextEncoder().encode(
      "Brain Vision Data Exchange Marker File, Version 1.0\r\n[Marker Infos]\r\nMk1=New Segment,,1,1,0,20200102030405060708\r\n" +
        "Mk2=Stimulus,S  1,10,1,0\r\nMk3=Comment,a\\1b,20,x\r\n",
    ),
  );
  assert.equal(m.measDate, "2020-01-02T03:04:05.060708+00:00");
  assert.deepEqual(m.markers, [
    { type: "Stimulus", desc: "S  1", onset: 9, duration: 1 },
    { type: "Comment", desc: "a,b", onset: 19, duration: 0 },
  ]);
});

test("BrainVision: missing companions, ASCII data and unknown formats are explained", async () => {
  const files = await fixtureFiles(manifest, "bv_int16");
  const vhdr = files.find((f) => f.name.endsWith(".vhdr"));
  const eeg = files.find((f) => f.name.endsWith(".eeg"));
  const vmrk = files.find((f) => f.name.endsWith(".vmrk"));
  await assert.rejects(openRecording([vhdr, eeg], { worker: false }), /Marker file 'int16_eeg.vmrk' named in int16_eeg.vhdr was not found among the picked files/);
  await assert.rejects(openRecording([vhdr, vmrk], { worker: false }), /Data file 'int16_eeg.eeg' named in int16_eeg.vhdr was not found/);
  await assert.rejects(openRecording([eeg, vmrk], { worker: false }), /its header \(\.vhdr\) was not picked/);
  const text = new TextEncoder().encode(
    "Brain Vision Data Exchange Header File Version 1.0\n[Common Infos]\nDataFile=a.eeg\nMarkerFile=a.vmrk\nDataFormat=ASCII\n" +
      "DataOrientation=MULTIPLEXED\nNumberOfChannels=1\nSamplingInterval=1000\n[Channel Infos]\nCh1=Cz,,1,µV\n",
  );
  assert.throws(() => parseVhdr(text, "a.vhdr"), /ASCII text, which the browser version cannot read/);
});

// Real recordings, when ELECTROTAG_REAL_EEG names a folder: every .edf, .bdf and .vhdr file below it is
// read here and by MNE-Python (web_tests/register_parity.py --describe) and compared as the test
// recordings are; a file MNE-Python cannot read must be refused here too. docs/testing_guide.md says
// which public recordings were used. The recordings stay where they are and are only read.
const REAL = process.env.ELECTROTAG_REAL_EEG;
if (REAL) {
  const found = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (statSync(p).isDirectory()) walk(p); // folders given as symbolic links too
      else if (/\.(edf|bdf|vhdr)$/i.test(e.name)) found.push(p);
    }
  };
  walk(REAL);
  found.sort();
  const r = spawnSync(fixturePython(), ["-I", join(ROOT, "web_tests", "register_parity.py"), "--describe"], {
    cwd: ROOT,
    input: JSON.stringify(found.map((path) => ({ path }))),
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  if (r.status !== 0) throw new Error(`register_parity.py --describe failed:\n${(r.stderr || "").slice(-3000)}`);
  const described = JSON.parse(r.stdout);
  const filesOf = (paths) => Promise.all(paths.map(async (p) => new File([await openAsBlob(p)], basename(p))));
  described.forEach((exp, k) => {
    const label = `real recording ${relative(REAL, found[k])}`;
    if (exp.error) {
      test(`${label}: refused, as MNE-Python cannot read it`, async () => {
        await assert.rejects(filesOf(exp.paths).then((files) => openRecording(files, { worker: false })));
      });
      return;
    }
    readerTests(label, async () => openRecording(await filesOf(exp.paths), { worker: false }), () => exp, exp.lower_rate,
      { timeout: 30 * 60 * 1000, lowerFactors: exp.lower_rate_factor || {} });
  });
}
