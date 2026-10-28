// A helper worker that computes the SHA-256 of the data file while the reading worker scans it, so
// that the fingerprint is ready sooner. Message: {file}; replies: {progress}, then {hex} or {error}.

import { sha256Blob } from "./sha256.js";

self.onmessage = async (event) => {
  const { file } = event.data || {};
  try {
    let last = -1;
    const hex = await sha256Blob(file, {
      onProgress: (fraction) => {
        if (fraction - last >= 0.01 || fraction === 1) {
          last = fraction;
          self.postMessage({ progress: fraction });
        }
      },
    });
    self.postMessage({ hex });
  } catch (e) {
    self.postMessage({ error: (e && e.message) || String(e) });
  }
};
