// A few helper workers (filterworker.js) that filter pairs of channels in parallel. Used by the
// reading worker when the browser lets a worker start workers of its own; otherwise the engine
// filters everything itself. Plain ES module.

import { nextPow2 } from "./fft.js";
import { filterPair, planFilters } from "./filters.js";

export class FilterPool {
  /**
   * A pool of `size` helper workers, or null when workers cannot be started here.
   * @param {number} size
   */
  static create(size) {
    if (typeof Worker === "undefined" || !(size > 0)) return null;
    const workers = [];
    try {
      for (let i = 0; i < size; i++) {
        workers.push(new Worker(new URL("./filterworker.js", import.meta.url), { type: "module" }));
      }
    } catch {
      for (const w of workers) w.terminate();
      return null;
    }
    return new FilterPool(workers);
  }

  constructor(workers) {
    this.workers = workers;
    this.seq = 0;
    this.calls = new Map();
    this.broken = false;
    for (const w of workers) {
      w.onmessage = (ev) => {
        const { id, out, error } = ev.data || {};
        const call = this.calls.get(id);
        if (!call) return;
        this.calls.delete(id);
        if (error) call.reject(new Error(error));
        else call.resolve(out);
      };
      w.onerror = (ev) => {
        if (ev && ev.preventDefault) ev.preventDefault();
        this._break(new Error("A filtering worker stopped"));
      };
    }
  }

  get size() {
    return this.workers.length;
  }

  _break(err) {
    this.broken = true;
    for (const c of this.calls.values()) c.reject(err);
    this.calls.clear();
    for (const w of this.workers) w.terminate();
  }

  /** Send jobs to one worker. */
  _run(worker, sfreq, filters, jobs) {
    const id = ++this.seq;
    const transfer = [];
    for (const j of jobs) {
      transfer.push(j.a.buffer);
      if (j.b) transfer.push(j.b.buffer);
    }
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      worker.postMessage({ id, sfreq, filters, jobs }, transfer);
    });
  }

  /**
   * Filter pairs of channels; the job arrays are transferred to the workers (and so emptied here).
   * Background work (prefetching) passes waitIdle: it is sent a pair per worker at a time and
   * waits between rounds while the annotator's own requests are served.
   * @param {(() => Promise<void>) | null} [waitIdle]
   * @returns {Promise<[Float32Array, Float32Array | null][]>}
   */
  async filter(sfreq, filters, jobs, waitIdle = null) {
    if (this.broken) throw new Error("The filtering workers are not available");
    const n = this.workers.length;
    if (waitIdle) {
      const out = [];
      for (let k = 0; k < jobs.length; k += n) {
        await waitIdle();
        const round = jobs.slice(k, k + n);
        const res = await Promise.all(round.map((j, w) => this._run(this.workers[w], sfreq, filters, [j])));
        for (const r of res) out.push(r[0]);
      }
      return out;
    }
    const parts = Array.from({ length: n }, () => []);
    const where = [];
    // contiguous shares, so that each worker gets about the same number of pairs
    const per = Math.ceil(jobs.length / n);
    jobs.forEach((j, k) => {
      const w = Math.min(n - 1, Math.floor(k / per));
      where.push([w, parts[w].length]);
      parts[w].push(j);
    });
    const results = await Promise.all(parts.map((p, w) => (p.length ? this._run(this.workers[w], sfreq, filters, p) : Promise.resolve([]))));
    return where.map(([w, i]) => results[w][i]);
  }

  /** Design the filters in every worker ahead of the first window. */
  warm(sfreq, filters) {
    if (this.broken || !filters) return;
    const plan = planFilters(sfreq, filters);
    if (!plan.steps.length) return;
    // one pair of the size the engine computes far from edges: designs the filters, computes the
    // kernel spectra and compiles the code in every worker
    const L = plan.combined ? plan.combined.length : plan.steps[0].length;
    const W = plan.halfWidth;
    const m = nextPow2(2 * L) - L + 1;
    const n = m + 2 * W;
    for (const w of this.workers) {
      const job = { a: new Float64Array(n), b: new Float64Array(n), srcStart: 0, s0: 0, s1: n, o0: W, o1: W + m };
      this._run(w, sfreq, filters, [job]).catch(() => {});
    }
  }

  close() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.calls.clear();
  }
}

/** The same work without workers (used when there is no pool). */
export function filterJobsHere(sfreq, filters, jobs) {
  const plan = planFilters(sfreq, filters);
  return jobs.map((j) => {
    const [fa, fb] = filterPair(plan, j.a, j.b, j.srcStart, j.s0, j.s1, j.o0, j.o1);
    return [new Float32Array(fa), fb ? new Float32Array(fb) : null];
  });
}
