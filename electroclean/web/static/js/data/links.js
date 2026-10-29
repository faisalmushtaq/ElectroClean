// Links to recordings kept with a cloud service (Dropbox, OneDrive, or any web address that lets
// web pages read it): turning a share link into the address its file is downloaded from, and the
// names of the downloaded files. Plain ES module without DOM access, so that Node can test it.
//
// The page fetches the file straight from the service; nothing passes through the study. A share
// link is a secret (whoever has it can read the file), so these functions never store or send it.

/** Hosts whose share links are converted. */
const DROPBOX_HOSTS = new Set(['www.dropbox.com', 'dropbox.com', 'dl.dropbox.com', 'dl.dropboxusercontent.com']);
const ONEDRIVE_HOSTS = new Set(['1drv.ms', 'onedrive.live.com']);
const GOOGLE_HOSTS = new Set(['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A link that cannot be used, with a plain-words message and a kind for the program. */
export class LinkProblem extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

/** Unpadded base64url of a text's UTF-8 bytes, as OneDrive's shares API wants a sharing URL. */
export function base64Url(text) {
  const bytes = new TextEncoder().encode(String(text));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
  return b64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

function lastSegment(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length) return '';
  try { return decodeURIComponent(parts[parts.length - 1]); } catch { return parts[parts.length - 1]; }
}

/** A file name that is safe to use: the base name only, without control characters. */
export function safeFileName(name) {
  const base = String(name || '').replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base === '.' || base === '..' ? '' : base.slice(0, 255);
}

/**
 * A link typed or pasted by the annotator, as the address to fetch.
 * @param {string} text
 * @returns {{service: 'dropbox'|'onedrive'|'sharepoint'|'google'|'web', url: string|null,
 *            downloadUrl: string, name: string, readable: boolean}}
 *   url: the address the page fetches (null when the service never lets a web page read it);
 *   downloadUrl: the address that makes the browser download the file in a new tab (the fallback);
 *   name: the file name the link shows, if any ('' when only the service's answer will tell);
 *   readable: false for services known to refuse web pages (Google Drive).
 * @throws {LinkProblem} for text that is not a usable link
 */
export function directLink(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new LinkProblem('Paste the link to the file.', 'empty');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new LinkProblem('This is not a web address. Copy the whole link, starting with https://.', 'not_a_link');
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'http:' && !LOOPBACK.has(host)) {
    throw new LinkProblem('This link starts with http://, which is not private. Use the https:// link the service gives.', 'insecure');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new LinkProblem('Only web links (https://) can be opened.', 'not_a_link');
  }
  if (u.username || u.password) throw new LinkProblem('Links with a user name or password in them cannot be opened.', 'not_a_link');

  if (DROPBOX_HOSTS.has(host)) return dropbox(u);
  if (ONEDRIVE_HOSTS.has(host)) return onedrive(u);
  if (host.endsWith('.sharepoint.com')) return sharepoint(u);
  if (GOOGLE_HOSTS.has(host)) return google(u);
  return { service: 'web', url: u.href, downloadUrl: u.href, name: safeFileName(lastSegment(u.pathname)), readable: true };
}

function dropbox(u) {
  const path = u.pathname;
  if (/^\/(scl\/fo|sh)\//.test(path)) {
    throw new LinkProblem('This is a link to a Dropbox folder. Share each file of the recording and paste the file links, one per line.', 'folder');
  }
  if (!/^\/(scl\/fi|s)\/[^/]+\/[^/]+/.test(path)) {
    throw new LinkProblem('This Dropbox link does not point to a file. In Dropbox, choose Share, then Copy link, on the file itself.', 'not_a_file');
  }
  // Keep what identifies the file (the rlkey of the newer links, and st if present), drop dl and raw.
  const keep = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (k !== 'dl' && k !== 'raw') keep.append(k, v);
  keep.set('dl', '1');
  const query = `?${keep.toString()}`;
  return {
    service: 'dropbox',
    url: `https://dl.dropboxusercontent.com${path}${query}`,
    downloadUrl: `https://www.dropbox.com${path}${query}`,
    name: safeFileName(lastSegment(path)),
    readable: true,
  };
}

function onedrive(u) {
  // OneDrive's shares API reads a personal OneDrive's share link without signing in.
  const share = `u!${base64Url(u.href)}`;
  const name = u.hostname.toLowerCase() === '1drv.ms' ? '' : safeFileName(lastSegment(u.pathname).replace(/^(redir|embed|download|view\.aspx)$/i, ''));
  return { service: 'onedrive', url: `https://api.onedrive.com/v1.0/shares/${share}/root/content`, downloadUrl: u.href, name, readable: true };
}

function sharepoint(u) {
  // OneDrive for Business and SharePoint: download=1 asks for the file instead of its page.
  const d = new URL(u.href);
  d.searchParams.set('download', '1');
  return { service: 'sharepoint', url: d.href, downloadUrl: d.href, name: '', readable: true };
}

function google(u) {
  const id = u.searchParams.get('id') || (u.pathname.match(/\/d\/([^/]+)/) || [])[1] || '';
  const downloadUrl = id ? `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}` : u.href;
  return { service: 'google', url: null, downloadUrl, name: '', readable: false };
}

/**
 * The links in a text field, one per line (blank lines are ignored).
 * @param {string} text
 * @returns {{text: string, link?: ReturnType<typeof directLink>, problem?: LinkProblem}[]}
 */
export function parseLinks(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((line) => {
    try { return { text: line, link: directLink(line) }; } catch (e) { return { text: line, problem: e }; }
  });
}

/**
 * The file name in a Content-Disposition header (filename* in UTF-8 first, then filename).
 * @param {string|null} header
 * @returns {string} '' when there is none
 */
export function fileNameFromDisposition(header) {
  const h = String(header || '');
  const star = h.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
  if (star) {
    try { return safeFileName(decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''))); } catch { /* fall through */ }
  }
  const quoted = h.match(/filename\s*=\s*"((?:[^"\\]|\\.)*)"/i);
  if (quoted) return safeFileName(quoted[1].replace(/\\(.)/g, '$1'));
  const plain = h.match(/filename\s*=\s*([^;]+)/i);
  return plain ? safeFileName(plain[1].trim()) : '';
}

/** The name a service's sign-in or error page shows as, so that the problem can be explained. */
export const SERVICE_NAMES = Object.freeze({ dropbox: 'Dropbox', onedrive: 'OneDrive', sharepoint: 'OneDrive for work or SharePoint', google: 'Google Drive', web: 'The service that holds the file' });

/** "1.2 GB", "340 MB", "12 kB" (decimal units, as the Files app and Finder show them). */
export function formatBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1000) return `${v} bytes`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let x = v / 1000;
  let i = 0;
  while (x >= 1000 && i < units.length - 1) { x /= 1000; i++; }
  return `${x >= 100 ? Math.round(x) : x.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
}
