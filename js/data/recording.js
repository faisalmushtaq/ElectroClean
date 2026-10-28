// openRecording(files) -> Recording: the browser's reader of EDF, EDF+, BDF and BrainVision files
// (docs/web/architecture.md, "The Recording interface"). The files stay on the annotator's computer
// and are read in pieces with Blob.slice. The reading runs in a Web Worker when the browser allows
// one and on the page otherwise; either way the page stays responsive, because every read is
// asynchronous and the work is done a piece at a time. Plain ES module; nothing outside js/data/.

import { Engine } from "./engine.js";
import { findRecordings } from "./files.js";
import { edgeZonesFor, planFilters } from "./filters.js";
import { CHANNEL_TYPES, HOUSEKEEPING_PATTERNS, inferChannelType } from "./channels.js";
import { RecordingError } from "./util.js";

export { findRecordings, HOUSEKEEPING_PATTERNS, inferChannelType, RecordingError };

/** How long a new worker may take to answer before the page reads the files itself (ms). */
const WORKER_START_TIMEOUT_MS = 4000;

/** Talks to a worker.js Web Worker. */
class WorkerBackend {
  constructor(worker) {
    this.worker = worker;
    this.kind = "worker";
    this.seq = 0;
    this.calls = new Map();
    this.broken = null;
    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      const call = this.calls.get(msg.id);
      if (!call) return;
      if (msg.progress !== undefined) {
        if (call.onProgress) call.onProgress(msg.progress);
        return;
      }
      this.calls.delete(msg.id);
      if (msg.ok) call.resolve(msg.result);
      else {
        const err = new RecordingError(msg.error.message, msg.error.kind);
        call.reject(err);
      }
    };
    worker.onerror = (ev) => {
      ev.preventDefault?.();
      this._fail(new Error(`The reading worker stopped: ${ev.message || "unknown error"}`));
    };
    worker.onmessageerror = () => this._fail(new Error("A message from the reading worker could not be read"));
  }

  _fail(err) {
    this.broken = err;
    for (const call of this.calls.values()) call.reject(err);
    this.calls.clear();
  }

  call(op, args, onProgress, transfer = []) {
    if (this.broken) return Promise.reject(this.broken);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject, onProgress });
      try {
        this.worker.postMessage({ id, op, args }, transfer);
      } catch (e) {
        this.calls.delete(id);
        reject(e);
      }
    });
  }

  terminate() {
    try {
      this.worker.terminate();
    } catch {
      /* already gone */
    }
  }
}

/** Runs the same engine on the page (no worker). */
class LocalBackend {
  constructor() {
    this.kind = "page";
    this.engine = null;
  }

  async call(op, args, onProgress) {
    // let the page draw between operations
    await new Promise((r) => setTimeout(r, 0));
    switch (op) {
      case "open":
        this.engine = new Engine({ ...(args.options || {}), cooperative: true });
        return this.engine.open(args.files, args.options || {}, onProgress || (() => {}));
      case "fingerprint":
        return this.engine.fingerprint((fraction) => onProgress && onProgress({ stage: "fingerprint", fraction }));
      case "readWindow":
        return this.engine.readWindow(args);
      case "amplitude":
        return this.engine.amplitudeCheck(args);
      case "findEvents":
        return this.engine.findEvents(args);
      case "close":
        if (this.engine) this.engine.close();
        this.engine = null;
        return null;
      default:
        throw new Error(`Unknown operation ${op}`);
    }
  }

  terminate() {
    if (this.engine) this.engine.close();
    this.engine = null;
  }
}

/** A worker if the browser allows module workers here (and it answers), otherwise the page. */
async function startBackend(mode) {
  if (mode === false || typeof Worker === "undefined") return new LocalBackend();
  let worker;
  try {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  } catch (e) {
    if (mode === true) throw e;
    return new LocalBackend();
  }
  const backend = new WorkerBackend(worker);
  try {
    await Promise.race([
      backend.call("ping", {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error("The reading worker did not start")), WORKER_START_TIMEOUT_MS)),
    ]);
    return backend;
  } catch (e) {
    backend.terminate();
    if (mode === true) throw e;
    return new LocalBackend();
  }
}

/**
 * Open a recording from the files the annotator picked: one EDF or BDF file, or the .vhdr, .vmrk
 * and .eeg files of a BrainVision recording (picked together or as a folder).
 *
 * @param {ArrayLike<File>} files
 * @param {{onProgress?: (p: {stage: string, fraction: number}) => void, fileName?: string,
 *          fingerprint?: boolean, filters?: object, worker?: boolean,
 *          blockCacheBytes?: number, filterCacheBytes?: number}} [options]
 *   onProgress: progress of the opening (stages "scan", "scan+fingerprint", "amplitude");
 *   fileName: which recording to open when the files hold several;
 *   fingerprint: compute the SHA-256 in the same pass when the file has to be scanned anyway
 *     (EDF+ annotations, trigger channels; default true);
 *   filters: the display filters the amplitude check uses (default: high-pass 1 Hz);
 *   worker: true to require a worker, false to read on the page (default: a worker if possible).
 * @returns {Promise<Recording>}
 */
export async function openRecording(files, options = {}) {
  const list = Array.from(files || []);
  const backend = await startBackend(options.worker);
  const { onProgress, worker, ...rest } = options;
  let info;
  try {
    info = await backend.call("open", { files: list, options: rest }, onProgress);
  } catch (e) {
    backend.terminate();
    throw e;
  }
  return new Recording(info, backend);
}

/**
 * An open recording (docs/web/architecture.md). Besides the interface's fields it has
 * suggestedHidden, discontinuities, notes, markerSource, amplitudes, suggestedScalings,
 * readerKind ("worker" or "page"), edgeZones(filters) and setChannelTypes(types).
 */
export class Recording {
  constructor(info, backend) {
    this._backend = backend;
    this.format = info.format;
    this.fileName = info.fileName;
    this.stem = info.stem;
    this.sizeBytes = info.sizeBytes;
    this.sfreq = info.sfreq;
    this.nSamples = info.nSamples;
    this.durationS = info.durationS;
    this.measDate = info.measDate;
    /** @type {{name: string, type: string, unit: string, origUnit?: string, hidden?: boolean}[]} */
    this.channels = info.channels;
    this.markers = info.markers;
    this.gaps = info.gaps;
    this.warnings = info.warnings;
    // additions to the interface
    this.dataFileName = info.dataFileName;
    this.discontinuities = info.discontinuities;
    this.notes = info.notes;
    this.markerSource = info.markerSource;
    this.triggers = info.triggers;
    this.amplitudes = info.amplitudes;
    this.suggestedScalings = info.suggestedScalings;
    this.suggestedHidden = info.channels.filter((c) => c.hidden).map((c) => c.name);
    this.readerKind = backend.kind;
    this.openMs = info.openMs;
    // for register.js: the annotations as read and the channel types MNE-Python gives
    this.annotations = info.annotations || [];
    this.mneTypes = info.mneTypes || info.channels.map((c) => (c.type === "stim" ? "stim" : "eeg"));
    this._fingerprint = info.fingerprint || null;
    this._boundaries = boundariesOf(info);
    this._closed = false;
  }

  /**
   * The SHA-256 of the data file (the .edf/.bdf, or the BrainVision .eeg), as hashlib computes it.
   * @param {(fraction: number) => void} [onProgress]
   */
  async fingerprint(onProgress) {
    if (this._fingerprint) {
      if (onProgress) onProgress(1);
      return { ...this._fingerprint };
    }
    this._check();
    const fp = await this._backend.call("fingerprint", {}, (p) => onProgress && onProgress(p.fraction));
    this._fingerprint = fp;
    return { ...fp };
  }

  /**
   * Samples of a window in volts, filtered for display as the desktop filters them (trigger
   * channels are never filtered; stretches without data are left as they are).
   * @param {{startSample: number, nSamples: number, channels?: number[], filters?: {highpassHz: number | null,
   *          notchHz: number | null, notchHarmonics?: boolean} | null}} req
   * @returns {Promise<{startSample: number, nSamples: number, data: Float32Array[], edgeZones: number[][]}>}
   */
  async readWindow(req) {
    this._check();
    const channels = req.channels ? Array.from(req.channels) : this.channels.map((_, i) => i);
    const filterable = channels.map((c) => this.channels[c] && this.channels[c].type !== "stim");
    const r = await this._backend.call("readWindow", {
      startSample: req.startSample,
      nSamples: req.nSamples,
      channels,
      filters: req.filters || null,
      filterable,
    });
    return { startSample: r.startSample, nSamples: r.nSamples, data: r.data, edgeZones: r.edgeZones, elapsedMs: r.elapsedMs };
  }

  /**
   * The desktop's amplitude check with other channel types and hidden channels than the
   * recording's own (register.js gives those of the manifest it builds).
   * @param {{filters?: object | null, types?: string[], hidden?: boolean[]}} [p] filters: null for none
   * @returns {Promise<{amplitudesV: object, suggestedScalings: object, warnings: string[]}>}
   */
  async checkAmplitude(p = {}) {
    this._check();
    return this._backend.call("amplitude", { filters: p.filters ?? null, types: p.types ?? null, hidden: p.hidden ?? null });
  }

  /**
   * Trigger codes read from the given channels as mne.find_events reads them (for channels that
   * the file does not mark as trigger channels but a channels.tsv or a study's settings do).
   * @param {number[]} channels indices
   * @param {{mask?: number}} [options] mask: the bits kept (-1 for all)
   * @returns {Promise<{sample: number, code: number, channel: string}[]>}
   */
  async findTriggerEvents(channels, options = {}) {
    this._check();
    return this._backend.call("findEvents", { channels: Array.from(channels), mask: options.mask ?? -1 });
  }

  /**
   * The stretches distorted by the filters' edge effects in the whole recording (samples), as the
   * desktop hatches them: half the filter lengths at both ends and around every discontinuity and
   * gap.
   */
  edgeZones(filters) {
    const plan = planFilters(this.sfreq, filters);
    return edgeZonesFor(this.nSamples, this._boundaries, plan.steps.length ? plan.halfWidth : 0);
  }

  /**
   * Change channel types (for example to those of the study's manifest): an object mapping names to
   * types, or an array of types in channel order. Trigger ("stim") channels are not filtered.
   */
  setChannelTypes(types) {
    const byName = Array.isArray(types) ? null : types || {};
    this.channels = this.channels.map((c, i) => {
      const t = byName ? byName[c.name] : types[i];
      if (!t) return c;
      const type = String(t).toLowerCase();
      return CHANNEL_TYPES.includes(type) ? { ...c, type } : c;
    });
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    const b = this._backend;
    Promise.resolve(b.call("close", {}))
      .catch(() => {})
      .finally(() => b.terminate());
  }

  _check() {
    if (this._closed) throw new RecordingError("The recording has been closed", "closed");
  }
}

function boundariesOf(info) {
  const edges = new Set(info.discontinuities.filter((s) => s > 0));
  for (const [a, b] of info.gaps) for (const x of [a, b]) if (x > 0 && x < info.nSamples) edges.add(x);
  return [...edges].sort((x, y) => x - y);
}
