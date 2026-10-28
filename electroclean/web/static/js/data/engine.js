// The reading engine behind a Recording: it opens the files, scans them once for annotations and
// triggers (computing the fingerprint in the same pass), keeps decoded blocks and filtered pieces in
// memory-bounded caches and answers window requests. It runs in a Web Worker (worker.js) or, when
// workers are not available, on the page itself (recording.js). Plain ES module.

import { amplitudeReport, amplitudeWindows, PLAUSIBLE_AMPLITUDE_V } from "./amplitude.js";
import { BrainVisionSource } from "./brainvision.js";
import { isHousekeeping } from "./channels.js";
import { EdfSource, finishStimSteps, stimEvents, stimSteps } from "./edf.js";
import { selectRecording } from "./files.js";
import { edgeZonesFor, planFilters } from "./filters.js";
import { FilterPool, filterJobsHere } from "./pool.js";
import { nextPow2 } from "./fft.js";
import { Sha256, hasNativeSha256, nativeLimitBytes, sha256Blob } from "./sha256.js";
import { RecordingError, recordingStem } from "./util.js";

/** Default memory budgets (bytes) of the two caches. */
export const DEFAULT_BLOCK_CACHE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_FILTER_CACHE_BYTES = 192 * 1024 * 1024;
/** The filters of the amplitude check when the caller gives none: the desktop's default high-pass. */
export const DEFAULT_AMPLITUDE_FILTERS = Object.freeze({ highpassHz: 1.0, notchHz: null, notchHarmonics: false });

/** A Map used as a least-recently-used cache with a byte budget. */
class LruBytes {
  constructor(budget) {
    this.budget = budget;
    this.map = new Map();
    this.bytes = 0;
  }
  get(key) {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key, value, bytes) {
    if (this.map.has(key)) this.delete(key);
    this.map.set(key, { value, bytes });
    this.bytes += bytes;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.budget || this.map.size <= 1) break;
      this.map.delete(k);
      this.bytes -= v.bytes;
    }
  }
  delete(key) {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.bytes -= v.bytes;
    }
  }
  clear() {
    this.map.clear();
    this.bytes = 0;
  }
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class Engine {
  /**
   * @param {{blockCacheBytes?: number, filterCacheBytes?: number}} [options]
   */
  constructor(options = {}) {
    this.blocks = new LruBytes(options.blockCacheBytes ?? DEFAULT_BLOCK_CACHE_BYTES);
    this.filtered = new LruBytes(options.filterCacheBytes ?? DEFAULT_FILTER_CACHE_BYTES);
    this.pending = new Map();
    this.source = null;
    this.fp = null;
    this.lastStart = 0;
    this.closed = false;
    this.entrySeq = 0;
    this.cooperative = Boolean(options.cooperative);
    // helper workers for the filters (worker.js asks for them; tests and the page do without)
    this.poolWanted = Boolean(options.pool);
    this.poolMax = options.poolMax ?? 4;
    this.pool = null;
    this.poolFailed = false;
    this.inflight = new Set();
    this.foreground = 0;
    this.idleWaiters = [];
    this.fpTask = null;
    this.fpListeners = new Set();
    this.fpProgress = 0;
    this.hashWorker = null;
  }

  /**
   * Open the recording among the picked files.
   * @param {ArrayLike<File>} files
   * @param {{fileName?: string, fingerprint?: boolean, filters?: object, amplitudeFilters?: object}} [options]
   *   fingerprint: compute the SHA-256 while scanning (default true; only files that need a scan)
   * @param {(p: {stage: string, fraction: number}) => void} [onProgress]
   */
  async open(files, options = {}, onProgress = () => {}) {
    const t0 = now();
    const sel = await selectRecording(files, options);
    let src;
    if (sel.format === "brainvision") src = await BrainVisionSource.open({ vhdr: sel.vhdr, vmrk: sel.vmrk, eeg: sel.eeg }, sel.header);
    else src = await EdfSource.open(sel.dataFile, sel.fileName, sel.format);
    this.source = src;
    this.dataFile = sel.dataFile;
    // Inside the reading worker the fingerprint is computed by a helper worker while the file is
    // scanned; elsewhere the scan computes it in the same pass (or fingerprint() later).
    const wantHash = options.fingerprint !== false;
    if (wantHash && this.poolWanted) this._startHashWorker();
    let scanned = { annotations: [], triggers: [] };
    // hash during the scan only when the browser's own (faster) SHA-256 cannot take the file later
    const hashInScan = wantHash && !this.fpTask && !(hasNativeSha256() && sel.dataFile.size <= nativeLimitBytes());
    if (src.needsScan) scanned = await this._scan(src, hashInScan, onProgress);
    const desc = src.describe(scanned);
    this.sfreq = src.sfreq;
    this.nSamples = src.nSamples;
    this.gaps = desc.gaps;
    this.discontinuities = desc.discontinuities;
    this._segments();

    const channels = src.channels.map((c) => {
      const hidden = c.type === "stim" || isHousekeeping(c.name);
      return { ...c, hidden };
    });
    this.channels = channels;
    const notes = [];
    const housekeeping = channels.filter((c) => c.type !== "stim" && isHousekeeping(c.name)).map((c) => c.name);
    const triggerChs = channels.filter((c) => c.type === "stim").map((c) => c.name);
    if (housekeeping.length) {
      notes.push(
        `${housekeeping.length} channel(s) look like device housekeeping channels and are suggested as hidden: ${housekeeping.join(", ")}`,
      );
    }
    if (triggerChs.length) {
      const used = desc.markerSource === "triggers" ? "; the original events were read from them" : "";
      notes.push(`Trigger channel(s) not shown and not part of the montage${used}: ${triggerChs.join(", ")}`);
    }
    if (!channels.some((c) => !c.hidden) && options.requireShown !== false) {
      throw new RecordingError(
        "Every channel of the recording is a trigger channel or a device housekeeping channel, so nothing could be shown.",
        "no_channels",
      );
    }
    const warnings = [...desc.warnings];
    if (this.poolWanted) {
      this._startPool();
      if (this.pool && options.filters) this.pool.warm(this.sfreq, options.filters);
    }
    let amp = { amplitudesV: {}, suggestedScalings: {}, warnings: [] };
    if (options.amplitude !== false) {
      onProgress({ stage: "amplitude", fraction: 0 });
      try {
        amp = await this._amplitude(options.amplitudeFilters || options.filters || DEFAULT_AMPLITUDE_FILTERS);
      } catch (e) {
        warnings.push(`The signal amplitude could not be checked: ${e.message}`);
      }
      warnings.push(...amp.warnings);
      onProgress({ stage: "amplitude", fraction: 1 });
    }
    // what MNE-Python holds before its own checks: the annotations as read (seconds for EDF+ and
    // BDF+, samples for BrainVision markers) and the channel types it gives (register.js)
    const annotations =
      src.format === "brainvision"
        ? src.mrk.markers.map((m) => ({ onsetSample: m.onset, durationSamples: m.duration, description: `${m.type}/${m.desc}` }))
        : scanned.annotations.map((a) => ({ onset: a.onset, duration: a.duration, description: a.description, channels: a.channels || [] }));
    const mneTypes = src.format === "brainvision" ? src.h.mneTypes.slice() : src.isStim.map((s) => (s ? "stim" : "eeg"));
    return {
      format: src.format,
      fileName: sel.fileName,
      dataFileName: sel.dataFile.name,
      stem: recordingStem(sel.fileName),
      sizeBytes: sel.dataFile.size,
      sfreq: src.sfreq,
      nSamples: src.nSamples,
      durationS: src.nSamples / src.sfreq,
      measDate: src.measDate,
      channels,
      markers: desc.markers,
      markerSource: desc.markerSource,
      triggers: desc.triggers,
      gaps: desc.gaps,
      discontinuities: desc.discontinuities,
      warnings,
      notes,
      amplitudes: amp.amplitudesV,
      suggestedScalings: amp.suggestedScalings,
      fingerprint: this.fp,
      blockSamples: src.blockSamples,
      openMs: now() - t0,
      annotations,
      mneTypes,
    };
  }

  /**
   * The desktop's amplitude check with the channel types and hidden channels given (for example
   * those of a manifest), on the display copy filtered as given (null: unfiltered).
   * @param {{filters?: object | null, types?: string[] | null, hidden?: boolean[] | null}} [p]
   */
  async amplitudeCheck({ filters = null, types = null, hidden = null } = {}) {
    return this._amplitude(filters, types, hidden);
  }

  /**
   * Trigger codes read from any channels, as mne.find_events reads them (consecutive=True,
   * shortest_event=1, the channel padded with zero after its end): every change to a non-zero code
   * of the samples' integer parts, with the mask applied (-1 for none).
   * @param {{channels: number[], mask?: number}} p
   * @returns {Promise<{sample: number, code: number, channel: string}[]>}
   */
  async findEvents({ channels, mask = -1 }) {
    const B = this.source.blockSamples;
    const n = this.nSamples;
    const states = channels.map(() => ({ prev: null, steps: [] }));
    let lastYield = now();
    for (let s0 = 0; s0 < n; s0 += B) {
      const s1 = Math.min(n, s0 + B);
      const data = await this.readRaw(s0, s1, channels, Float64Array);
      channels.forEach((_, k) => {
        const v = data[k];
        const codes = new Float64Array(v.length);
        for (let q = 0; q < v.length; q++) codes[q] = Math.abs(Math.trunc(v[q]));
        stimSteps(states[k], codes, s0, mask);
      });
      if (this.cooperative && now() - lastYield > 25) {
        await new Promise((r) => setTimeout(r, 0));
        lastYield = now();
      }
    }
    const out = [];
    channels.forEach((ch, k) => {
      finishStimSteps(states[k], n, mask);
      for (const [sample, code] of stimEvents(states[k].steps)) out.push({ sample, code, channel: this.channels[ch].name });
    });
    return out;
  }

  /** One pass over the file: annotations and triggers, and the SHA-256 when asked. */
  async _scan(src, hash, onProgress) {
    // on the page, smaller pieces keep each pause of the page short
    const ranges = src.scanRanges(this.cooperative ? 2 * 1024 * 1024 : undefined);
    const total = this.dataFile.size || 1;
    const sha = hash ? new Sha256() : null;
    let next = this.dataFile.slice(ranges[0][0], ranges[0][1]).arrayBuffer();
    let done = 0;
    for (let i = 0; i < ranges.length; i++) {
      const buf = await next;
      if (i + 1 < ranges.length) next = this.dataFile.slice(ranges[i + 1][0], ranges[i + 1][1]).arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.length !== ranges[i][1] - ranges[i][0]) throw new RecordingError(`${this.dataFile.name} could not be read to the end`, "read_error");
      if (sha) sha.update(bytes);
      src.scan(bytes, ranges[i][0]);
      done += bytes.length;
      onProgress({ stage: hash ? "scan+fingerprint" : "scan", fraction: done / total });
    }
    if (sha) this.fp = { algorithm: "sha256", role: "eeg", hex: sha.hex(), sizeBytes: this.dataFile.size };
    return src.finishScan();
  }

  /** The continuous segments filtered on their own: between gaps, split at discontinuities. */
  _segments() {
    const n = this.nSamples;
    const gaps = this.gaps;
    const mask = [];
    let pos = 0;
    for (const [a, b] of [...gaps].sort((x, y) => x[0] - y[0])) {
      if (a > pos) mask.push([pos, a]);
      pos = Math.max(pos, b);
    }
    if (pos < n) mask.push([pos, n]);
    const breaks = this.discontinuities.filter((s) => !gaps.some(([a, b]) => a <= s && s <= b));
    const segs = [];
    for (const [a, b] of mask) {
      let start = a;
      for (const s of breaks) {
        if (s > start && s < b) {
          segs.push([start, s]);
          start = s;
        }
      }
      segs.push([start, b]);
    }
    this.segments = segs;
    const edges = new Set(this.discontinuities.filter((s) => s > 0));
    for (const [a, b] of gaps) for (const x of [a, b]) if (x > 0 && x < n) edges.add(x);
    this.boundaries = [...edges].sort((x, y) => x - y);
  }

  /** The SHA-256 of the data file (computed once). */
  async fingerprint(onProgress = () => {}) {
    if (this.fp) {
      onProgress(1);
      return this.fp;
    }
    const size = this.dataFile.size;
    if (this.fpTask) {
      this.fpListeners.add(onProgress);
      onProgress(this.fpProgress);
      try {
        const hex = await this.fpTask;
        this.fp = { algorithm: "sha256", role: "eeg", hex, sizeBytes: size };
        return this.fp;
      } catch {
        this.fpTask = null; // compute it here instead
      } finally {
        this.fpListeners.delete(onProgress);
      }
    }
    const hex = await sha256Blob(this.dataFile, { onProgress, chunkBytes: this.cooperative ? 2 * 1024 * 1024 : undefined });
    this.fp = { algorithm: "sha256", role: "eeg", hex, sizeBytes: size };
    return this.fp;
  }

  /** Start computing the fingerprint in a helper worker (hashworker.js), if one can be started. */
  _startHashWorker() {
    let w;
    try {
      if (typeof Worker === "undefined") return;
      w = new Worker(new URL("./hashworker.js", import.meta.url), { type: "module" });
    } catch {
      return;
    }
    this.hashWorker = w;
    this.fpTask = new Promise((resolve, reject) => {
      w.onmessage = (ev) => {
        const m = ev.data || {};
        if (m.progress !== undefined) {
          this.fpProgress = m.progress;
          for (const l of this.fpListeners) l(m.progress);
          return;
        }
        w.terminate();
        this.hashWorker = null;
        if (m.hex) resolve(m.hex);
        else reject(new Error(m.error || "The fingerprint could not be computed"));
      };
      w.onerror = (ev) => {
        if (ev && ev.preventDefault) ev.preventDefault();
        w.terminate();
        this.hashWorker = null;
        reject(new Error("The fingerprint worker stopped"));
      };
    });
    this.fpTask.catch(() => {});
    try {
      w.postMessage({ file: this.dataFile });
    } catch {
      w.terminate();
      this.hashWorker = null;
      this.fpTask = null;
    }
  }

  /** The hatched filter edge zones of the whole recording for these filters. */
  edgeZones(filters) {
    const plan = planFilters(this.sfreq, filters);
    return edgeZonesFor(this.nSamples, this.boundaries, plan.steps.length ? plan.halfWidth : 0);
  }

  async _block(b) {
    const hit = this.blocks.get(b);
    if (hit) return hit.value;
    let p = this.pending.get(b);
    if (!p) {
      p = this.source.readBlock(b).then((block) => {
        this.pending.delete(b);
        this.blocks.set(b, block, block.byteLength);
        return block;
      }, (e) => {
        this.pending.delete(b);
        throw e;
      });
      this.pending.set(b, p);
    }
    return p;
  }

  /**
   * Unfiltered samples [start, end) of the given channels, in volts.
   * @param {number} start
   * @param {number} end
   * @param {number[]} channels
   * @param {Float32ArrayConstructor | Float64ArrayConstructor} [Type] Float64Array for the filters
   * @returns {Promise<Float32Array[] | Float64Array[]>}
   */
  async readRaw(start, end, channels, Type = Float32Array) {
    const B = this.source.blockSamples;
    const n = end - start;
    const out = channels.map(() => new Type(Math.max(0, n)));
    if (n <= 0) return out;
    const b0 = Math.floor(start / B);
    const b1 = Math.floor((end - 1) / B);
    const blocks = await Promise.all(Array.from({ length: b1 - b0 + 1 }, (_, k) => this._block(b0 + k)));
    for (let k = 0; k < blocks.length; k++) {
      const bs = (b0 + k) * B;
      const a = Math.max(start, bs);
      const e = Math.min(end, bs + blocks[k].n);
      if (e <= a) continue;
      channels.forEach((ch, i) => blocks[k].decode(ch, a - bs, e - bs, out[i], a - start));
    }
    return out;
  }

  /**
   * Samples of a window, filtered for display as the desktop filters them.
   * @param {{startSample: number, nSamples: number, channels?: number[], filters?: object | null,
   *          filterable?: boolean[]}} req filterable gives, per requested channel, whether it may be
   *          filtered (default: every channel that is not a trigger channel)
   */
  async readWindow(req) {
    this.foreground++;
    try {
      return await this._readWindow(req);
    } finally {
      this.foreground--;
      if (this.foreground === 0) {
        const waiting = this.idleWaiters;
        this.idleWaiters = [];
        for (const w of waiting) w.resolve();
      }
    }
  }

  /**
   * Background work waits here while a window the annotator asked for is being read, unless that
   * window needs the background work itself (then the job has been promoted).
   * @param {{promoted?: boolean} | null} job
   */
  _idle(job = null) {
    if (this.foreground === 0 || (job && job.promoted)) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push({ resolve, job }));
  }

  /** A window the annotator asked for waits for this background job: let it run at once. */
  _promote(job) {
    if (job.promoted) return;
    job.promoted = true;
    this.idleWaiters = this.idleWaiters.filter((w) => {
      if (w.job !== job) return true;
      w.resolve();
      return false;
    });
  }

  async _readWindow(req) {
    const t0 = now();
    if (this.poolWanted && !this.pool && !this.poolFailed) this._startPool();
    const n = this.nSamples;
    const want0 = Math.floor(req.startSample || 0);
    const start = Math.max(0, Math.min(n, want0));
    const end = Math.max(start, Math.min(n, want0 + Math.max(0, Math.floor(req.nSamples || 0))));
    const channels = req.channels ? Array.from(req.channels) : this.channels.map((_, i) => i);
    for (const c of channels) if (!(c >= 0 && c < this.channels.length)) throw new RecordingError(`No channel ${c}`, "bad_request");
    const plan = planFilters(this.sfreq, req.filters);
    const data = await this.readRaw(start, end, channels);
    const filterIdx = [];
    if (plan.steps.length && end > start) {
      channels.forEach((c, i) => {
        const ok = req.filterable ? Boolean(req.filterable[i]) : this.channels[c].type !== "stim";
        if (ok) filterIdx.push(i);
      });
    }
    if (filterIdx.length) {
      // Scrolling on (or back) extends the computed piece in that direction; after a jump the
      // piece is centred on the window.
      const step = start - this.lastStart;
      const direction = Math.abs(step) > 4 * Math.max(1, end - start) ? 0 : step >= 0 ? 1 : -1;
      for (const [s0, s1] of this.segments) {
        const p0 = Math.max(start, s0);
        const p1 = Math.min(end, s1);
        if (p1 <= p0) continue;
        const chs = filterIdx.map((i) => channels[i]);
        const pieces = await this._filtered(plan, s0, s1, p0, p1, chs, direction);
        filterIdx.forEach((i, k) => data[i].set(pieces[k], p0 - start));
      }
      if (req.prefetch !== false) {
        // filter the next window in the direction of travel while the annotator looks at this one
        const dir = direction === 0 ? 1 : direction;
        const len = end - start;
        const q0 = dir > 0 ? end : Math.max(0, start - len);
        const q1 = dir > 0 ? Math.min(n, end + len) : start;
        const chs = filterIdx.map((i) => channels[i]);
        if (q1 > q0) setTimeout(() => this._prefetch(plan, q0, q1, chs, dir), 0);
      }
    }
    this.lastStart = start;
    const zones = plan.steps.length ? edgeZonesFor(n, this.boundaries, plan.halfWidth).filter(([a, b]) => a < end && b > start) : [];
    return { startSample: start, nSamples: end - start, data, edgeZones: zones, elapsedMs: now() - t0 };
  }

  /**
   * Filtered samples [p0, p1) of segment [s0, s1) for the channels chs, from the cache of filtered
   * pieces or computed (a piece somewhat longer than asked, in the direction the annotator moves,
   * so that the next window is usually already there).
   * @param {number} direction 1 forwards, -1 backwards, 0 after a jump
   */
  async _filtered(plan, s0, s1, p0, p1, chs, direction, background = false) {
    const result = new Array(chs.length).fill(null);
    let missing = this._fromCache(plan, s0, p0, p1, chs, result, chs.map((_, k) => k));
    if (missing.length) {
      // the same stretch may already be being filtered (by a prefetch, say)
      const waits = [];
      for (const job of this.inflight) {
        if (job.plan === plan.key && job.s0 === s0 && job.start <= p0 && job.end >= p1 && missing.some((k) => job.chs.has(chs[k]))) {
          if (!background) this._promote(job);
          waits.push(job.promise.catch(() => null));
        }
      }
      if (waits.length) {
        await Promise.all(waits);
        missing = this._fromCache(plan, s0, p0, p1, chs, result, missing);
      }
    }
    if (missing.length) {
      const L = plan.combined ? plan.combined.length : plan.steps[0].length;
      const best = nextPow2(2 * L) - L + 1;
      const want = Math.max(best, p1 - p0);
      let i0;
      if (direction > 0) i0 = p0;
      else if (direction < 0) i0 = p1 - want;
      else i0 = p0 - Math.floor((want - (p1 - p0)) / 2);
      i0 = Math.max(s0, Math.min(i0, s1 - want));
      const i1 = Math.min(s1, i0 + want);
      const missCh = missing.map((k) => chs[k]);
      const job = { plan: plan.key, s0, start: i0, end: i1, chs: new Set(missCh), promise: null, promoted: !background };
      job.promise = (async () => {
        const out = await this._filterChannels(plan, s0, s1, i0, i1, missCh, background ? job : null);
        const data = new Map();
        missCh.forEach((ch, k) => data.set(ch, out[k]));
        if (!this.closed) {
          this.filtered.set(`f${++this.entrySeq}`, { plan: plan.key, s0, start: i0, end: i1, data }, missCh.length * (i1 - i0) * 4);
        }
        return data;
      })();
      this.inflight.add(job);
      let data;
      try {
        data = await job.promise;
      } finally {
        this.inflight.delete(job);
      }
      missing.forEach((k) => {
        result[k] = data.get(chs[k]).subarray(p0 - i0, p1 - i0);
      });
    }
    return result;
  }

  /** Fill result[k] for the channels chs[k] (k in `which`) that the cache holds; return the others. */
  _fromCache(plan, s0, p0, p1, chs, result, which) {
    const missing = [];
    for (const k of which) {
      const ch = chs[k];
      let found = false;
      for (const [key, v] of this.filtered.map) {
        const e = v.value;
        if (e.plan === plan.key && e.s0 === s0 && e.start <= p0 && e.end >= p1 && e.data.has(ch)) {
          this.filtered.get(key);
          result[k] = e.data.get(ch).subarray(p0 - e.start, p1 - e.start);
          found = true;
          break;
        }
      }
      if (!found) missing.push(k);
    }
    return missing;
  }

  /** Filter [q0, q1) ahead of need (errors are ignored: the window will be read when asked for). */
  async _prefetch(plan, q0, q1, chs, dir) {
    if (this.closed || !this.source) return;
    try {
      for (const [s0, s1] of this.segments) {
        const a = Math.max(q0, s0);
        const b = Math.min(q1, s1);
        if (b > a) await this._filtered(plan, s0, s1, a, b, chs, dir, true);
      }
    } catch {
      /* the window will be read when it is asked for */
    }
  }

  /**
   * Filtered samples [o0, o1) of segment [s0, s1) for channels chs, two channels per FFT, shared
   * among the helper workers when there are any.
   * @returns {Promise<Float32Array[]>}
   */
  async _filterChannels(plan, s0, s1, o0, o1, chs, backgroundJob = null) {
    const W = plan.halfWidth;
    const r0 = Math.max(s0, o0 - W);
    const r1 = Math.min(s1, o1 + W);
    const makeJobs = async () => {
      const raw = await this.readRaw(r0, r1, chs, Float64Array);
      const jobs = [];
      for (let k = 0; k < chs.length; k += 2) {
        jobs.push({ a: raw[k], b: k + 1 < chs.length ? raw[k + 1] : null, srcStart: r0, s0, s1, o0, o1 });
      }
      return jobs;
    };
    let pairs = null;
    if (this.pool && chs.length > 2) {
      try {
        pairs = await this.pool.filter(this.sfreq, plan.spec, await makeJobs(), backgroundJob ? () => this._idle(backgroundJob) : null);
      } catch {
        this.pool.close();
        this.pool = null;
        this.poolFailed = true;
        pairs = null;
      }
    }
    if (!pairs) {
      const jobs = await makeJobs();
      pairs = [];
      let lastYield = now();
      for (const j of jobs) {
        if (backgroundJob) await this._idle(backgroundJob);
        if (this.cooperative && now() - lastYield > 25) {
          // on the page (no worker): let it draw and respond between pairs of channels
          await new Promise((r) => setTimeout(r, 0));
          lastYield = now();
        }
        pairs.push(filterJobsHere(this.sfreq, plan.spec, [j])[0]);
      }
    }
    const out = [];
    for (const [a, b] of pairs) {
      out.push(a);
      if (b) out.push(b);
    }
    return out;
  }

  /**
   * The amplitude check of the desktop on the display copy (shown channels, filtered).
   * @param {object | null} filters
   * @param {string[] | null} [types] each channel's type (default: the channels' own)
   * @param {boolean[] | null} [hidden] which channels are not shown (default: the channels' own)
   */
  async _amplitude(filters, types = null, hidden = null) {
    const plan = planFilters(this.sfreq, filters);
    const edge = Math.round(plan.steps.length ? plan.halfWidth : 0);
    const windows = amplitudeWindows(this.nSamples, this.sfreq, this.gaps, edge);
    const byType = {};
    const picks = [];
    const typeOf = (i) => (types ? types[i] : this.channels[i].type);
    this.channels.forEach((c, i) => {
      const t = typeOf(i);
      if (!(hidden ? hidden[i] : c.hidden) && Object.hasOwn(PLAUSIBLE_AMPLITUDE_V, t)) picks.push(i);
    });
    if (!picks.length) return amplitudeReport({});
    const total = windows.reduce((a, [s, e]) => a + (e - s), 0);
    const concat = picks.map(() => new Float32Array(total));
    let off = 0;
    const parts = await Promise.all(windows.map(([s, e]) => this._windowFiltered(plan, s, e, picks)));
    windows.forEach(([s, e], w) => {
      parts[w].forEach((d, k) => concat[k].set(d, off));
      off += e - s;
    });
    picks.forEach((ch, k) => {
      const t = typeOf(ch);
      (byType[t] = byType[t] || []).push(concat[k]);
    });
    return amplitudeReport(byType);
  }

  /** Filtered samples of exactly [s, e) (not cached), for the amplitude check. */
  async _windowFiltered(plan, s, e, picks) {
    const raw = await this.readRaw(s, e, picks);
    if (!plan.steps.length) return raw;
    for (const [s0, s1] of this.segments) {
      const p0 = Math.max(s, s0);
      const p1 = Math.min(e, s1);
      if (p1 <= p0) continue;
      const filtered = await this._filterChannels(plan, s0, s1, p0, p1, picks);
      filtered.forEach((f, k) => raw[k].set(f, p0 - s));
    }
    return raw;
  }

  /** Start the helper workers that filter in parallel (inside the reading worker only). */
  _startPool() {
    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2;
    const size = Math.max(1, Math.min(this.poolMax, cores - 1));
    this.pool = size > 1 ? FilterPool.create(size) : null;
    if (!this.pool) this.poolFailed = true;
  }

  close() {
    this.closed = true;
    if (this.pool) this.pool.close();
    this.pool = null;
    if (this.hashWorker) this.hashWorker.terminate();
    this.hashWorker = null;
    this.blocks.clear();
    this.filtered.clear();
    this.pending.clear();
    this.source = null;
    this.dataFile = null;
  }
}
