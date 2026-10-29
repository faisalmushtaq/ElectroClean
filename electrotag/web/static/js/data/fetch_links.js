// Fetching recordings from links (js/data/links.js converts share links): the page reads each file
// straight from the cloud service, with its progress, and makes File objects that the rest of the
// application opens as if they had been chosen on the computer. Nothing passes through the study:
// the request carries no cookies and no referrer, and the link is never stored or logged.
// Plain ES module; `fetch` can be passed in, so that Node can test it.

import { directLink, fileNameFromDisposition, formatBytes, LinkProblem, SERVICE_NAMES } from './links.js';

/** The largest file fetched from a link: it is held in the browser's memory until it is opened. */
export const LINK_MAX_BYTES = 2 * 1024 ** 3;

/** A link whose file could not be fetched; `link` (when known) has the fallback's downloadUrl. */
export class LinkError extends Error {
  constructor(message, kind, { link = null, index = 0, status = 0 } = {}) {
    super(message);
    this.kind = kind;
    this.link = link;
    this.index = index;
    this.status = status;
  }
}

function serviceName(link) {
  return SERVICE_NAMES[link && link.service] || SERVICE_NAMES.web;
}

/** The plain-words problem for an answer that is not the file. */
export function problemForStatus(status, link) {
  const who = serviceName(link);
  if (status === 401 || status === 403) {
    return ['The file is not shared with everyone who has the link, or the link has expired. Ask for a link that anyone with it can open.', 'not_public'];
  }
  if (status === 404 || status === 410) return ['There is no file at this link any more. Ask for a new link.', 'not_found'];
  if (status === 429) return [`${who} is limiting downloads of this file at the moment. Try again later.`, 'busy'];
  return [`${who} answered with an error (${status}).`, 'http'];
}

/**
 * Fetch the files of one recording from their links.
 * @param {{role?: string, url: string}[]} items one entry per file (role is for later use, such as
 *   'header', 'markers' or 'data' when an administrator registers a link for each file)
 * @param {{onProgress?: (p: {index: number, count: number, name: string, loaded: number, total: number|null}) => void,
 *          signal?: AbortSignal, fetchImpl?: typeof fetch, maxBytes?: number, online?: () => boolean}} [options]
 * @returns {Promise<{files: File[], links: object[], bytes: number}>}
 * @throws {LinkError}
 */
export async function fetchLinkedFiles(items, options = {}) {
  const { onProgress = () => {}, signal, maxBytes = LINK_MAX_BYTES } = options;
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
  const online = options.online || (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const list = Array.from(items || []);
  if (!list.length) throw new LinkError('Paste the link to the file.', 'empty');
  const links = list.map((it, index) => {
    try { return directLink(it.url); } catch (e) {
      if (e instanceof LinkProblem) throw new LinkError(e.message, e.kind, { index });
      throw e;
    }
  });
  const files = [];
  let bytes = 0;
  for (let index = 0; index < links.length; index++) {
    const link = links[index];
    const file = await fetchOne(link, index, links.length, { fetchImpl, signal, maxBytes, onProgress, online });
    files.push(file);
    bytes += file.size;
  }
  return { files, links, bytes };
}

async function fetchOne(link, index, count, { fetchImpl, signal, maxBytes, onProgress, online }) {
  const who = serviceName(link);
  const fail = (message, kind, status = 0) => new LinkError(message, kind, { link, index, status });
  if (!link.readable || !link.url) {
    throw fail(`${who} does not let other web pages read its files.`, 'refuses');
  }
  let res;
  try {
    // No cookies, no referrer and no custom headers (which would need the service's permission first).
    res = await fetchImpl(link.url, { method: 'GET', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', cache: 'no-store', signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw fail('The download was stopped.', 'aborted');
    if (!online()) throw fail('This device is not connected to the internet.', 'offline');
    throw fail(`${who} did not let this page read the file. Some services, and some kinds of link, allow only their own pages to read files.`, 'blocked');
  }
  if (!res.ok) {
    const [message, kind] = problemForStatus(res.status, link);
    throw fail(message, kind, res.status);
  }
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type.startsWith('text/html')) {
    throw fail('The link opens a web page instead of the file: the file may not be shared with everyone who has the link.', 'page');
  }
  const lengthHeader = res.headers.get('content-length');
  const encoded = Boolean(res.headers.get('content-encoding'));
  const total = lengthHeader !== null && !encoded && Number.isFinite(Number(lengthHeader)) ? Number(lengthHeader) : null;
  if (total !== null && total > maxBytes) {
    throw fail(`This file is too large to open from a link (${formatBytes(total)}; at most ${formatBytes(maxBytes)}).`, 'too_large');
  }
  const name = fileNameFromDisposition(res.headers.get('content-disposition')) || link.name || `recording-${index + 1}`;
  const chunks = [];
  let loaded = 0;
  onProgress({ index, count, name, loaded, total });
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        loaded += value.byteLength;
        if (loaded > maxBytes) {
          try { await reader.cancel(); } catch { /* already closed */ }
          throw fail(`This file is too large to open from a link (more than ${formatBytes(maxBytes)}).`, 'too_large');
        }
        chunks.push(value);
        onProgress({ index, count, name, loaded, total });
      }
    } else {
      const buf = await res.arrayBuffer();
      loaded = buf.byteLength;
      chunks.push(new Uint8Array(buf));
      onProgress({ index, count, name, loaded, total });
    }
  } catch (e) {
    if (e instanceof LinkError) throw e;
    if (e && e.name === 'AbortError') throw fail('The download was stopped.', 'aborted');
    if (e instanceof RangeError) throw fail('This file is too large for this device to hold in memory.', 'too_large');
    throw fail(`The download from ${who} was interrupted. Try again.`, 'interrupted');
  }
  if (total !== null && loaded !== total) throw fail(`The download from ${who} ended early. Try again.`, 'interrupted');
  try {
    return new File(chunks, name, { type: 'application/octet-stream', lastModified: Date.now() });
  } catch {
    throw fail('This file is too large for this device to hold in memory.', 'too_large');
  }
}
