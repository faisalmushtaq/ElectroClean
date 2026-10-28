// The Web Worker that reads one recording (created by recording.js with
// new Worker(new URL("./worker.js", import.meta.url), {type: "module"})). Messages from the page
// are {id, op, args}; replies are {id, ok: true, result}, {id, ok: false, error} or, while an
// operation runs, {id, progress}. The samples of a window are transferred, not copied.

import { Engine } from "./engine.js";

/** @type {Engine | null} */
let engine = null;

function errorOf(e) {
  return { message: (e && e.message) || String(e), kind: (e && e.kind) || "load_error", name: (e && e.name) || "Error" };
}

self.onmessage = async (event) => {
  const { id, op, args = {} } = event.data || {};
  const reply = (msg, transfer = []) => self.postMessage({ id, ...msg }, transfer);
  try {
    switch (op) {
      case "ping":
        reply({ ok: true, result: "pong" });
        break;
      case "open": {
        engine = new Engine({ ...(args.options || {}), pool: true });
        const info = await engine.open(args.files, args.options || {}, (p) => reply({ progress: p }));
        reply({ ok: true, result: info });
        break;
      }
      case "fingerprint": {
        const fp = await engine.fingerprint((fraction) => reply({ progress: { stage: "fingerprint", fraction } }));
        reply({ ok: true, result: fp });
        break;
      }
      case "readWindow": {
        const r = await engine.readWindow(args);
        reply({ ok: true, result: r }, r.data.map((d) => d.buffer));
        break;
      }
      case "close":
        if (engine) engine.close();
        engine = null;
        reply({ ok: true, result: null });
        break;
      default:
        throw new Error(`Unknown operation ${op}`);
    }
  } catch (e) {
    reply({ ok: false, error: errorOf(e) });
  }
};
