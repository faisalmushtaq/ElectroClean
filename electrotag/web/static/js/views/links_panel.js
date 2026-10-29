// "Open from a link": a field for the links of one recording's files (Dropbox, OneDrive or any
// address that lets web pages read it), fetched straight from the service with their progress
// (js/data/fetch_links.js) and handed to the same code as files chosen on the computer. When a
// service does not let the page read the file, the panel offers the next step: download the file
// in a new tab, then choose it. The link is a secret: it is never stored, sent to the study or
// written to the interaction log (only the service's name, the number of files and their size).

import { h, clear } from '../ui/dom.js';
import { logger } from '../log/logger.js';
import { fetchLinkedFiles, LinkError } from '../data/fetch_links.js';
import { formatBytes, parseLinks, SERVICE_NAMES } from '../data/links.js';
import { IS_IOS } from '../util.js';

let panelSeq = 0;

/** Open a converted download address in a new tab, without telling it where the person came from. */
export function openDownload(url) {
  try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* a blocked pop-up: the link is shown instead */ }
}

/**
 * The panel.
 * @param {{onFiles: (files: File[], info: {service: string, bytes: number}) => void,
 *          chooseFile: () => void, extra?: Node | null, multiple?: string}} options
 *   onFiles: receives the fetched files (as if they had been chosen on the computer);
 *   chooseFile: opens the ordinary file chooser (the fallback's second step);
 *   extra: shown under the field (the open view's "Keep a copy on this device").
 * @returns {{el: HTMLElement, open: (items: {role?: string, url: string}[]) => Promise<boolean>, busy: () => boolean, cancel: () => void}}
 */
export function linkPanel({ onFiles, chooseFile, extra = null }) {
  const id = `open-links-${++panelSeq}`;
  const field = h('textarea.field.area', {
    id, name: 'links', rows: 3, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-describedby': `${id}-help`,
    placeholder: 'https://www.dropbox.com/scl/fi/…',
  });
  const status = h('div.link-status', { 'aria-live': 'polite' });
  let controller = null;
  const go = h('button.btn', { type: 'button', 'data-log': 'open-link', onclick: () => run() }, 'Open the link');
  const stop = h('button.btn.quiet', { type: 'button', hidden: true, 'data-log': 'stop-link', onclick: () => controller && controller.abort() }, 'Stop');

  function progress(p) {
    clear(status);
    const of = p.total ? ` of ${formatBytes(p.total)}` : '';
    const which = p.count > 1 ? ` (file ${p.index + 1} of ${p.count})` : '';
    status.append(h('p.caption', {}, `Downloading ${p.name}${which}: ${formatBytes(p.loaded)}${of}`),
      h('span.progress', {}, h('span.progress-bar', { style: { width: p.total ? `${Math.round((p.loaded / p.total) * 100)}%` : '0%' } })));
  }

  function problem(message, links) {
    clear(status);
    const downloads = (links || []).filter((l) => l && l.downloadUrl);
    const where = IS_IOS ? 'On an iPad the file goes to Downloads in the Files app.' : 'The file goes to your Downloads folder.';
    status.append(h('div.banner', { role: 'alert' },
      h('p', {}, message),
      downloads.length ? [
        h('p', {}, downloads.length > 1 ? 'You can download the files instead, then choose them here:' : 'You can download the file instead, then choose it here:'),
        h('div.btn-row', {},
          downloads.map((l, i) => h('button.btn', { type: 'button', 'data-log': 'link-download', onclick: () => { logger.event('link_fallback', { service: l.service, step: 'download' }); openDownload(l.downloadUrl); } },
            downloads.length > 1 ? `Download ${l.name || `file ${i + 1}`}` : 'Download the file')),
          h('button.btn', { type: 'button', 'data-log': 'link-choose', onclick: () => { logger.event('link_fallback', { step: 'choose' }); chooseFile(); } },
            downloads.length > 1 ? 'Choose the downloaded files' : 'Choose the downloaded file')),
        h('p.caption', {}, `${where} ElectroTag cannot reach that folder, so delete the file there yourself when you no longer need it.`),
      ] : null));
  }

  async function open(items) {
    if (controller) return false;
    controller = new AbortController();
    go.disabled = true;
    stop.hidden = false;
    clear(status);
    status.append(h('p.caption', {}, 'Asking the service for the file…'));
    try {
      const r = await fetchLinkedFiles(items, { onProgress: progress, signal: controller.signal });
      const service = r.links[0].service;
      logger.event('link_fetched', { service, files: r.files.length, size_bytes: r.bytes });
      clear(status);
      status.append(h('p.caption', {}, `Downloaded from ${SERVICE_NAMES[service] === SERVICE_NAMES.web ? 'the link' : SERVICE_NAMES[service]}: ${formatBytes(r.bytes)}.`));
      onFiles(r.files, { service, bytes: r.bytes });
      return true;
    } catch (e) {
      if (!(e instanceof LinkError)) throw e;
      logger.event('link_failed', { service: e.link ? e.link.service : '', kind: e.kind, status: e.status || 0 });
      const all = items.map((it) => { const p = parseLinks(it.url)[0]; return p && p.link ? p.link : null; });
      problem(e.message, e.kind === 'aborted' || !e.link ? [] : all);
      return false;
    } finally {
      controller = null;
      go.disabled = false;
      stop.hidden = true;
    }
  }

  function run() {
    const parsed = parseLinks(field.value);
    if (!parsed.length) { problem('Paste the link to the file first.', []); field.focus(); return; }
    const bad = parsed.find((p) => p.problem);
    if (bad) { problem(bad.problem.message, []); return; }
    if (parsed.length > 3) { problem('Paste the links of one recording: one file, or the three files of a BrainVision recording.', []); return; }
    void open(parsed.map((p) => ({ role: '', url: p.text })));
  }

  const el = h('div.link-panel', { role: 'group', 'aria-labelledby': `${id}-title` },
    h('h3', { id: `${id}-title` }, 'Open from a link'),
    h('p.caption', { id: `${id}-help` }, 'Paste a share link from Dropbox, OneDrive or another service, one per line (a BrainVision recording has three files). '
      + 'The file comes straight from that service to this browser and is never sent to the study.'),
    h('label.form-label', { for: id }, 'Links to the recording\'s files'),
    field,
    extra,
    h('div.btn-row', {}, go, stop),
    status);
  return { el, open, busy: () => Boolean(controller), cancel: () => { if (controller) controller.abort(); }, field };
}
