// A minimal stand-in for js/data/recording.js (which another part of the project provides): reads
// whole EDF, BDF or BrainVision files into memory and applies the simple display filters of
// synthetic.js. main.js uses it only when recording.js cannot be loaded.

import { applySimpleFilters, channelType, edgeHalfWidthS, sha256Hex } from './synthetic.js';

const text = (bytes, a, n) => new TextDecoder('latin1').decode(bytes.subarray(a, a + n)).trim();

function stemOf(name) {
  return name.replace(/\.[^.]+$/, '').replace(/_eeg$/, '');
}

function makeRecording({ format, fileName, dataFile, sfreq, nSamples, channels, markers, readChannel, warnings = [] }) {
  let fp = null;
  return {
    format, fileName, stem: stemOf(fileName), sizeBytes: dataFile.size, sfreq, nSamples,
    durationS: nSamples / sfreq, measDate: null, channels, markers, gaps: [], warnings,
    async fingerprint(onProgress) {
      if (!fp) {
        const bytes = new Uint8Array(await dataFile.arrayBuffer());
        fp = { algorithm: 'sha256', role: 'eeg', hex: await sha256Hex(bytes), sizeBytes: bytes.length };
      }
      if (onProgress) onProgress(1);
      return fp;
    },
    async readWindow({ startSample, nSamples: n, channels: idx, filters }) {
      const active = filters && (filters.highpassHz || filters.notchHz);
      const s0 = Math.max(0, Math.floor(startSample));
      const s1 = Math.min(nSamples, s0 + Math.floor(n));
      const pad = active ? Math.round(3 * sfreq) : 0;
      const p0 = Math.max(0, s0 - pad);
      const p1 = Math.min(nSamples, s1 + pad);
      const data = (idx || channels.map((_, i) => i)).map((ci) => {
        const x = Float64Array.from(readChannel(ci, p0, p1));
        if (active) applySimpleFilters(x, sfreq, filters);
        return Float32Array.from(x.subarray(s0 - p0, s1 - p0));
      });
      const hw = Math.round(edgeHalfWidthS(active ? filters : null) * sfreq);
      return { startSample: s0, nSamples: s1 - s0, data, edgeZones: hw ? [[0, hw], [nSamples - hw, nSamples]] : [] };
    },
    close() {},
  };
}

async function openEdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const bdf = bytes[0] === 255;
  const ns = parseInt(text(bytes, 252, 4), 10);
  const nRec = parseInt(text(bytes, 236, 8), 10);
  const recDur = parseFloat(text(bytes, 244, 8));
  const reserved = text(bytes, 192, 44);
  if (reserved.startsWith('EDF+D') || reserved.startsWith('BDF+D')) throw new Error('This EDF+ file has gaps (EDF+D), which ElectroClean does not open.');
  const f = (offset, width) => Array.from({ length: ns }, (_, i) => text(bytes, 256 + offset * ns + i * width, width));
  const labels = f(0, 16);
  const units = f(16 + 80, 8);
  const pmin = f(16 + 80 + 8, 8).map(Number);
  const pmax = f(16 + 80 + 16, 8).map(Number);
  const dmin = f(16 + 80 + 24, 8).map(Number);
  const dmax = f(16 + 80 + 32, 8).map(Number);
  const spr = f(16 + 80 + 40 + 80, 8).map((v) => parseInt(v, 10));
  const bps = bdf ? 3 : 2;
  const recBytes = spr.reduce((a, b) => a + b, 0) * bps;
  const head = 256 + 256 * ns;
  const sigs = [];
  let off = 0;
  labels.forEach((label, i) => { sigs.push({ i, label, off }); off += spr[i] * bps; });
  const data = sigs.filter((s) => !/annotations/i.test(s.label));
  const sfreq = spr[data[0].i] / recDur;
  const nSamples = spr[data[0].i] * nRec;
  const scale = (u) => (/^uv$|^µv$/i.test(u) ? 1e-6 : /^mv$/i.test(u) ? 1e-3 : /^nv$/i.test(u) ? 1e-9 : 1);
  const readChannel = (ci, s0, s1) => {
    const sig = data[ci];
    const n = spr[sig.i];
    const g = (pmax[sig.i] - pmin[sig.i]) / (dmax[sig.i] - dmin[sig.i]);
    const u = scale(units[sig.i]);
    const out = new Float64Array(s1 - s0);
    for (let s = s0; s < s1; s++) {
      const r = Math.floor(s / n);
      const k = s % n;
      const p = head + r * recBytes + sig.off + k * bps;
      let d;
      if (bdf) { d = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16); if (d & 0x800000) d -= 0x1000000; }
      else { d = bytes[p] | (bytes[p + 1] << 8); if (d & 0x8000) d -= 0x10000; }
      out[s - s0] = ((d - dmin[sig.i]) * g + pmin[sig.i]) * u;
    }
    return out;
  };
  return makeRecording({
    format: bdf ? 'bdf' : 'edf', fileName: file.name, dataFile: file, sfreq, nSamples,
    channels: data.map((s) => ({ name: s.label, type: /status/i.test(s.label) ? 'stim' : channelType(s.label), unit: 'V' })),
    markers: [], readChannel,
  });
}

async function openBrainVision(files) {
  const vhdr = files.find((f) => /\.vhdr$/i.test(f.name));
  const head = await vhdr.text();
  const get = (key) => (head.match(new RegExp(`^${key}=(.*)$`, 'mi')) || [])[1]?.trim();
  const dataName = get('DataFile');
  const eeg = files.find((f) => f.name === dataName) || files.find((f) => /\.eeg$/i.test(f.name));
  if (!eeg) throw new Error(`Choose the .eeg file (${dataName}) together with the .vhdr file.`);
  const nCh = parseInt(get('NumberOfChannels'), 10);
  const sfreq = 1e6 / parseFloat(get('SamplingInterval'));
  const fmt = (get('BinaryFormat') || 'INT_16').toUpperCase();
  const orient = (get('DataOrientation') || 'MULTIPLEXED').toUpperCase();
  const chans = [];
  for (let i = 1; i <= nCh; i++) {
    const parts = (get(`Ch${i}`) || `Ch${i}`).split(',');
    const res = parts[2] ? parseFloat(parts[2]) : 1;
    const unit = (parts[3] || 'µV').trim();
    const u = /^(µ|u)v$/i.test(unit) ? 1e-6 : /^mv$/i.test(unit) ? 1e-3 : /^nv$/i.test(unit) ? 1e-9 : unit === 'V' ? 1 : 1e-6;
    chans.push({ name: parts[0], gain: (res || 1) * u });
  }
  const buf = new DataView(await eeg.arrayBuffer());
  const bps = fmt === 'IEEE_FLOAT_32' ? 4 : 2;
  const nSamples = Math.floor(buf.byteLength / bps / nCh);
  const value = (p) => (bps === 4 ? buf.getFloat32(p, true) : buf.getInt16(p, true));
  const readChannel = (ci, s0, s1) => {
    const out = new Float64Array(s1 - s0);
    for (let s = s0; s < s1; s++) {
      const p = orient === 'VECTORIZED' ? (ci * nSamples + s) * bps : (s * nCh + ci) * bps;
      out[s - s0] = value(p) * chans[ci].gain;
    }
    return out;
  };
  const vmrk = files.find((f) => /\.vmrk$/i.test(f.name));
  const markers = [];
  if (vmrk) {
    for (const m of (await vmrk.text()).matchAll(/^Mk\d+=([^,]*),([^,]*),(\d+),(\d+)/gm)) {
      if (/new segment/i.test(m[1])) continue;
      markers.push({ onsetSample: parseInt(m[3], 10) - 1, durationSamples: Math.max(0, parseInt(m[4], 10) - 1), description: m[2] || m[1] });
    }
  }
  return makeRecording({
    format: 'brainvision', fileName: vhdr.name, dataFile: eeg, sfreq, nSamples,
    channels: chans.map((c) => ({ name: c.name, type: channelType(c.name), unit: 'V' })), markers, readChannel,
  });
}

export async function openRecording(files) {
  const list = [...files];
  if (list.some((f) => /\.vhdr$/i.test(f.name))) return openBrainVision(list);
  const edf = list.find((f) => /\.(edf|bdf|rec)$/i.test(f.name));
  if (!edf) throw new Error('Choose an EDF or BDF file, or the .vhdr, .vmrk and .eeg files of a BrainVision recording.');
  return openEdf(edf);
}
