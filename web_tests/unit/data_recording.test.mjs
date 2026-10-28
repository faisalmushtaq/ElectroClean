// The Recording interface of docs/web/architecture.md as openRecording returns it: fields and their
// types, the choice among picked files, channel types from a manifest, closing, and the helpers.

import assert from "node:assert/strict";
import test from "node:test";

import { findRecordings, openRecording, Recording } from "../../electroclean/web/static/js/data/recording.js";
import { inferChannelType, uniqueChannelNames, HOUSEKEEPING_PATTERNS, isHousekeeping } from "../../electroclean/web/static/js/data/channels.js";
import {
  decodeBrainVisionText,
  decodeLatin1,
  fnmatchCase,
  median,
  percentile,
  pyRound,
  recordingStem,
  timeToSample,
} from "../../electroclean/web/static/js/data/util.js";
import { ensureFixtures, fixtureFiles } from "./_fixtures.mjs";

const manifest = ensureFixtures();
const files = (name) => fixtureFiles(manifest, name);

test("the interface's fields and methods", async () => {
  const progress = [];
  const rec = await openRecording(await files("edfplus_gap"), { worker: false, onProgress: (p) => progress.push(p) });
  try {
    assert.ok(rec instanceof Recording);
    assert.equal(rec.readerKind, "page");
    assert.equal(rec.format, "edf");
    assert.equal(rec.fileName, "edfplus_gap_eeg.edf");
    assert.equal(rec.stem, "edfplus_gap");
    for (const k of ["sizeBytes", "sfreq", "nSamples", "durationS"]) assert.equal(typeof rec[k], "number", k);
    assert.equal(rec.measDate, "2024-01-01T12:00:00+00:00");
    for (const c of rec.channels) {
      assert.ok(["eeg", "eog", "ecg", "emg", "misc", "stim"].includes(c.type));
      assert.equal(typeof c.name, "string");
      assert.equal(c.unit, "V");
    }
    for (const m of rec.markers) {
      assert.ok(Number.isInteger(m.onsetSample) && Number.isInteger(m.durationSamples) && typeof m.description === "string");
    }
    assert.ok(rec.gaps.every(([a, b]) => Number.isInteger(a) && b > a));
    assert.ok(Array.isArray(rec.warnings));
    assert.equal(typeof rec.fingerprint, "function");
    assert.equal(typeof rec.readWindow, "function");
    assert.equal(typeof rec.close, "function");
    assert.ok(progress.some((p) => p.stage.startsWith("scan")) && progress.some((p) => p.stage === "amplitude"));
    // EDF+ files are scanned for their annotations, and the fingerprint comes with that pass
    const t = Date.now();
    const fp = await rec.fingerprint();
    assert.ok(Date.now() - t < 50);
    assert.equal(fp.algorithm, "sha256");
    const r = await rec.readWindow({ startSample: 256, nSamples: 512, channels: [3, 0], filters: { highpassHz: 1, notchHz: 50, notchHarmonics: false } });
    assert.deepEqual(Object.keys(r).sort(), ["data", "edgeZones", "elapsedMs", "nSamples", "startSample"].sort());
    assert.equal(r.data.length, 2);
    const both = await rec.readWindow({ startSample: 256, nSamples: 512, filters: { highpassHz: 1, notchHz: 50 } });
    assert.deepEqual(r.data[0], both.data[3]);
    assert.deepEqual(r.data[1], both.data[0]);
  } finally {
    rec.close();
  }
  await assert.rejects(rec.readWindow({ startSample: 0, nSamples: 1 }), /closed/);
  rec.close(); // closing twice is harmless
});

test("BrainVision: the .vhdr names the recording, the .eeg is fingerprinted", async () => {
  const rec = await openRecording(await files("bv_float32"), { worker: false });
  try {
    assert.equal(rec.fileName, "sub-01_task-rest_eeg.vhdr");
    assert.equal(rec.dataFileName, "sub-01_task-rest_eeg.eeg");
    assert.equal(rec.stem, "sub-01_task-rest");
    assert.equal(rec.measDate, "2024-01-01T12:00:00+00:00");
    assert.deepEqual(rec.discontinuities, [10000]);
    assert.ok(rec.warnings.some((w) => w.includes("discontinuity")));
  } finally {
    rec.close();
  }
});

test("choosing among picked files", async () => {
  const many = [...(await files("bdfplus")), ...(await files("bv_int16")), ...(await files("emotiv"))];
  await assert.rejects(openRecording(many, { worker: false }), /3 recordings were picked/);
  const rec = await openRecording(many, { worker: false, fileName: "int16_eeg.vhdr" });
  assert.equal(rec.format, "brainvision");
  rec.close();
  const found = await findRecordings(many);
  assert.deepEqual(
    found.map((r) => [r.fileName, r.format, r.files.length, r.problems.length]),
    [
      ["bdfplus_eeg.bdf", "bdf", 1, 0],
      ["int16_eeg.vhdr", "brainvision", 3, 0],
      ["sub-01_task-rest_eeg.edf", "edf", 1, 0],
    ],
  );
  await assert.rejects(openRecording([], { worker: false }), /No file was picked/);
  await assert.rejects(openRecording([new File(["x"], "notes.txt")], { worker: false }), /None of the picked files/);
  await assert.rejects(openRecording([new File(["0       "], "short_eeg.edf")], { worker: false }), /too short to hold an EDF header/);
});

test("channel types from a manifest", async () => {
  const rec = await openRecording(await files("bv_vec_float32"), { worker: false });
  try {
    assert.deepEqual(
      rec.channels.map((c) => c.type),
      ["eeg", "eeg", "emg", "eeg"],
    );
    rec.setChannelTypes({ Abs: "misc", Cz: "EOG", Pz: "nonsense" });
    assert.deepEqual(
      rec.channels.map((c) => c.type),
      ["eog", "eeg", "emg", "misc"],
    );
    rec.setChannelTypes(["stim"]);
    assert.equal(rec.channels[0].type, "stim");
  } finally {
    rec.close();
  }
});

test("channel names and types", () => {
  assert.equal(inferChannelType("Status"), "stim");
  assert.equal(inferChannelType("STI 014"), "stim");
  assert.equal(inferChannelType("HEOG"), "eog");
  assert.equal(inferChannelType("EKG"), "ecg");
  assert.equal(inferChannelType("EMG chin"), "emg");
  assert.equal(inferChannelType("CQ_AF3"), "misc");
  assert.equal(inferChannelType("Fp1"), "eeg");
  assert.ok(isHousekeeping("EQ_OVERALL") && !isHousekeeping("counter"));
  assert.ok(HOUSEKEEPING_PATTERNS.includes("BATTERY_PERCENT"));
  assert.deepEqual(uniqueChannelNames(["A", "B", "A", "A"]), ["A-0", "B", "A-1", "A-2"]);
  assert.deepEqual(uniqueChannelNames(["A", "A-0", "A"]), ["A-a", "A-0", "A-1"]);
});

test("small helpers behave like their Python counterparts", () => {
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, -1.5, 2.4, 2.6].map(pyRound), [0, 2, 2, 0, -2, 2, 3]);
  assert.equal(timeToSample(0.5 / 256, 256), 1);
  assert.equal(decodeLatin1(new Uint8Array([0x41, 0xb5, 0x80, 0xff])), "Aµ\u0080ÿ");
  assert.ok(fnmatchCase("CQ_Fp1", "CQ_*") && !fnmatchCase("cq_Fp1", "CQ_*") && fnmatchCase("A1", "A[0-9]") && fnmatchCase("Ab", "A[!0-9]"));
  assert.equal(recordingStem("sub-01_task-rest_eeg.vhdr"), "sub-01_task-rest");
  assert.equal(recordingStem("folder/rec.EDF"), "rec");
  assert.equal(percentile(Float64Array.of(1, 2, 3, 4), 50), 2.5);
  assert.ok(Math.abs(percentile(Float64Array.of(5, 1, 4, 2, 3), 99.5) - 4.98) < 1e-12);
  assert.equal(median(Float64Array.of(3, 1, 2)), 2);
  assert.equal(median(Float64Array.of(4, 1, 3, 2)), 2.5);
  const ansi = decodeBrainVisionText(new Uint8Array([...new TextEncoder().encode("Codepage=ANSI\n"), 0x80, 0xe9]));
  assert.equal(ansi.text, "Codepage=ANSI\n€é");
  const bad = decodeBrainVisionText(new Uint8Array([...new TextEncoder().encode("Codepage=ANSI\n"), 0x81, 0x80]));
  assert.equal(bad.encoding, "latin-1", "cp1252 cannot decode 0x81, so MNE falls back to latin-1");
  const utf = decodeBrainVisionText(new Uint8Array([0xc3, 0xa9]));
  assert.equal(utf.text, "é");
  const notUtf = decodeBrainVisionText(new Uint8Array([0xe9]));
  assert.equal(notUtf.text, "é");
});
