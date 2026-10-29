// A helper worker of the reading worker: it filters pairs of channels (filters.js) so that several
// processor cores share the work of a window with many channels. Messages are
// {id, sfreq, filters, jobs: [{a, b, srcStart, s0, s1, o0, o1}]}; the reply is
// {id, out: [[Float32Array, Float32Array | null], ...]} or {id, error}.

import { filterPair, planFilters } from "./filters.js";

self.onmessage = (event) => {
  const { id, sfreq, filters, jobs } = event.data || {};
  try {
    const plan = planFilters(sfreq, filters);
    const out = [];
    const transfer = [];
    for (const j of jobs || []) {
      const [fa, fb] = filterPair(plan, j.a, j.b, j.srcStart, j.s0, j.s1, j.o0, j.o1);
      const a = new Float32Array(fa);
      const b = fb ? new Float32Array(fb) : null;
      transfer.push(a.buffer);
      if (b) transfer.push(b.buffer);
      out.push([a, b]);
    }
    self.postMessage({ id, out }, transfer);
  } catch (e) {
    self.postMessage({ id, error: (e && e.message) || String(e) });
  }
};
