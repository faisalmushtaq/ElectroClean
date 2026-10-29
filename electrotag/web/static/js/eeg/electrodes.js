// A recording's own electrode positions: the BIDS electrodes.tsv (with its coordsystem.json) picked
// together with the recording, for the channel chooser's map (js/viewer/head_map.js). The files stay
// on the annotator's computer, as the recording does; nothing of them goes to the study. Plain ES
// module: the reading functions take text, so that Node can test them.

import { parseBidsName } from './bids.js';

const isElectrodes = (name) => /(^|_)electrodes\.tsv$/i.test(name);
const isCoordsystem = (name) => /(^|_)coordsystem\.json$/i.test(name);

/** The picked files that may hold electrode positions (electrodes.tsv and coordsystem.json). */
export function electrodeSidecars(files) {
  return [...(files || [])].filter((f) => f && typeof f.name === 'string' && !f.name.startsWith('.') && (isElectrodes(f.name) || isCoordsystem(f.name)));
}

function applies(candidate, target) {
  if (!candidate.entities.size) return true; // a plain electrodes.tsv: the only one picked
  for (const [k, v] of candidate.entities) {
    if (k === 'space') continue; // the coordinate space is not part of the recording's name
    if (target.entities.get(k) !== v) return false;
  }
  return true;
}

/**
 * The electrodes.tsv (and coordsystem.json) among `files` that belong to the recording named
 * `recordingName`, as BIDS inherits sidecars: every entity of the sidecar's name (sub, ses, acq)
 * matches the recording's, and the most specific wins. Returns {electrodes, coordsystem} (File
 * objects, coordsystem possibly null) or null.
 */
export function pickElectrodeFiles(files, recordingName) {
  const target = parseBidsName(recordingName || '');
  const list = electrodeSidecars(files);
  const best = (pred) => list.filter((f) => pred(f.name)).map((f) => [f, parseBidsName(f.name)])
    .filter(([, p]) => applies(p, target)).sort((a, b) => b[1].entities.size - a[1].entities.size);
  const el = best(isElectrodes);
  if (!el.length) return null;
  const [file, parsed] = el[0];
  const same = (p) => [...parsed.entities].every(([k, v]) => p.entities.get(k) === v);
  const cs = best(isCoordsystem).find(([, p]) => same(p)) || best(isCoordsystem)[0];
  return { electrodes: file, coordsystem: cs ? cs[0] : null };
}

/**
 * The positions of an electrodes.tsv's text: a Map name -> [x, y, z] (z NaN when not given). Rows
 * whose x or y is n/a or not a number are left out. Throws an Error in plain words when the file has
 * no name, x and y columns.
 */
export function parseElectrodesTsv(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) throw new Error('The electrodes.tsv file is empty.');
  const header = lines[0].split('\t').map((s) => s.trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  const [iName, iX, iY, iZ] = ['name', 'x', 'y', 'z'].map(col);
  if (iName < 0 || iX < 0 || iY < 0) throw new Error('The electrodes.tsv file has no name, x and y columns.');
  const out = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const name = (cells[iName] || '').trim();
    const num = (i) => { const s = i < 0 ? '' : (cells[i] || '').trim(); return s === '' || s.toLowerCase() === 'n/a' ? NaN : Number(s); };
    const x = num(iX);
    const y = num(iY);
    if (!name || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.set(name, [x, y, num(iZ)]);
  }
  return out;
}

/** The EEGCoordinateSystem of a coordsystem.json's text, or '' when it says none or cannot be read. */
export function coordinateSystemOf(text) {
  try {
    const doc = JSON.parse(String(text ?? ''));
    return typeof doc.EEGCoordinateSystem === 'string' ? doc.EEGCoordinateSystem : '';
  } catch {
    return '';
  }
}

/**
 * Read the positions picked with a recording: {positions: Map name -> [x, y, z], system, fileName}
 * or null when there are none, or they cannot be read (the map then falls back to the names).
 */
export async function readElectrodes(files, recordingName) {
  const picked = pickElectrodeFiles(files, recordingName);
  if (!picked) return null;
  try {
    const positions = parseElectrodesTsv(await picked.electrodes.text());
    if (!positions.size) return null;
    const system = picked.coordsystem ? coordinateSystemOf(await picked.coordsystem.text()) : '';
    return { positions, system, fileName: picked.electrodes.name };
  } catch {
    return null;
  }
}

/**
 * Every electrodes.tsv and coordsystem.json that came with a recording (js/views/open.js): those
 * picked, fetched or kept with it (`source.sidecars`), and those still arriving from beside a link
 * (`source.laterSidecars`, a promise of File objects). Never rejects.
 * @param {{sidecars?: File[], laterSidecars?: Promise<File[]>} | null} source recording.source
 * @returns {Promise<File[]>}
 */
export async function sidecarsOf(source) {
  if (!source) return [];
  const now = Array.isArray(source.sidecars) ? source.sidecars : [];
  let later = [];
  if (source.laterSidecars) {
    try { later = (await source.laterSidecars) || []; } catch { later = []; }
  }
  return [...now, ...later];
}

/**
 * The electrode files to keep with a copy of a recording on this device (js/views/device.js): the
 * electrodes.tsv that belongs to it and its coordsystem.json, so that the copy opens again with the
 * same positions. Others picked with it (a whole dataset's folder) are not kept.
 * @returns {File[]}
 */
export function electrodeFilesToKeep(files, recordingName) {
  const picked = pickElectrodeFiles(files, recordingName);
  return picked ? [picked.electrodes, picked.coordsystem].filter(Boolean) : [];
}
