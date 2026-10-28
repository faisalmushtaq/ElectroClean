// BIDS file names, the sidecars that belong to a recording (with the inheritance principle), and
// the exact reading of TSV and JSON sidecars, as the desktop does them (electroclean/app/io/bids.py
// and tsv.py), for files the administrator picked in the browser (register.js). Plain ES module.

import { decodeUtf8Python, parsePythonJson } from "./pyjson.js";
import { pyCompare, pyListRepr, pyStrip } from "./pyfmt.js";
import { decodeLatin1 } from "./util.js";

/**
 * parse_bids_name: "sub-01_task-rest_eeg.vhdr" -> entities, suffix, extension and the raw prefix.
 * @param {string} name
 * @returns {{entities: Map<string, string>, suffix: string, extension: string, rawPrefix: string}}
 */
export function parseBidsName(name) {
  const base = String(name).replace(/^.*\//, "");
  const dot = base.indexOf(".");
  const stem = dot < 0 ? base : base.slice(0, dot);
  const ext = dot < 0 ? "" : base.slice(dot);
  const parts = stem.split("_");
  const last = parts[parts.length - 1];
  const suffix = parts.length > 1 || !last.includes("-") ? last : "";
  const entityParts = suffix ? parts.slice(0, -1) : parts;
  const entities = new Map();
  for (const part of entityParts) {
    const i = part.indexOf("-");
    if (i < 0) continue;
    const key = part.slice(0, i);
    const value = part.slice(i + 1);
    if (key && value) entities.set(key, value);
  }
  return { entities, suffix, extension: ext, rawPrefix: entityParts.join("_") };
}

function applies(candidate, target) {
  if (!candidate.entities.size) return Boolean(candidate.rawPrefix) && candidate.rawPrefix === target.rawPrefix;
  for (const [k, v] of candidate.entities) if (target.entities.get(k) !== v) return false;
  return true;
}

/**
 * The picked files as folders: the folder (relative to the dataset root, "" for the root) maps to
 * the files directly in it, sorted by name as Python sorts paths.
 * @param {{path: string, file: File}[]} entries path relative to the dataset root
 * @returns {Map<string, {name: string, path: string, file: File}[]>}
 */
export function folderTree(entries) {
  const tree = new Map();
  for (const e of entries) {
    const slash = e.path.lastIndexOf("/");
    const dir = slash < 0 ? "" : e.path.slice(0, slash);
    const name = e.path.slice(slash + 1);
    if (!tree.has(dir)) tree.set(dir, []);
    tree.get(dir).push({ name, path: e.path, file: e.file });
  }
  for (const list of tree.values()) list.sort((a, b) => pyCompare(a.name, b.name));
  return tree;
}

/**
 * resolve_sidecars: the channels.tsv, events.tsv and the chains of events.json and <suffix>.json
 * files that apply to a recording, from the dataset root down to the recording's folder (closer
 * files win; for JSON every level contributes, least specific first).
 * @param {string} recordingPath relative to the dataset root
 * @param {Map<string, {name: string, path: string, file: File}[]>} tree from folderTree
 * @param {(dir: string) => string} [describeDir] how a folder is named in a warning
 * @returns {{channelsTsv: object | null, eventsTsv: object | null, eventsJsonChain: object[], eegJsonChain: object[],
 *            warnings: string[]}}
 */
export function resolveSidecars(recordingPath, tree, describeDir = (d) => d || ".") {
  const target = parseBidsName(recordingPath);
  const res = { channelsTsv: null, eventsTsv: null, eventsJsonChain: [], eegJsonChain: [], warnings: [] };
  const slash = recordingPath.lastIndexOf("/");
  const recDir = slash < 0 ? "" : recordingPath.slice(0, slash);
  const chain = [""];
  if (recDir) {
    const parts = recDir.split("/");
    for (let i = 1; i <= parts.length; i++) chain.push(parts.slice(0, i).join("/"));
  }
  const pickLevel = (dir, suffix, ext) => {
    const cands = [];
    for (const f of tree.get(dir) || []) {
      if (f.name.startsWith(".")) continue;
      const parsed = parseBidsName(f.name);
      if (parsed.suffix === suffix && parsed.extension === ext && applies(parsed, target)) cands.push([f, parsed]);
    }
    if (!cands.length) return null;
    if (cands.length > 1) {
      // the most specific file (stable, as Python's sort with reverse=True)
      cands.sort((a, b) => b[1].entities.size - a[1].entities.size);
      if (cands[0][1].entities.size === cands[1][1].entities.size) {
        res.warnings.push(
          `Ambiguous ${suffix}${ext} files in ${describeDir(dir)}: ` +
            cands.map(([f]) => f.name).join(", ") +
            `; using ${cands[0][0].name}`,
        );
      }
    }
    return cands[0][0];
  };
  for (const dir of chain) {
    for (const [suffix, ext, key] of [["channels", ".tsv", "channelsTsv"], ["events", ".tsv", "eventsTsv"]]) {
      const found = pickLevel(dir, suffix, ext);
      if (found) res[key] = found;
    }
    const ev = pickLevel(dir, "events", ".json");
    if (ev) res.eventsJsonChain.push(ev);
    const eeg = pickLevel(dir, target.suffix || "eeg", ".json");
    if (eeg) res.eegJsonChain.push(eeg);
  }
  return res;
}

/** The desktop's TSVError. */
export class TsvError extends Error {
  constructor(message) {
    super(message);
    this.name = "TSVError";
  }
}

/**
 * parse_tsv_text: header and rows as strings, exactly as written (line feeds split rows, a
 * carriage return before one is dropped, blank lines at the end are ignored).
 * @param {string} text
 * @param {string} source how the file is named in errors
 * @returns {[string[], string[][]]}
 */
export function parseTsvText(text, source) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // a byte-order mark
  const lines = text.split("\n").map((ln) => (ln.endsWith("\r") ? ln.slice(0, -1) : ln));
  while (lines.length && !lines[lines.length - 1].includes("\t") && pyStripEmpty(lines[lines.length - 1])) lines.pop();
  if (!lines.length) throw new TsvError(`${source} is empty (no header row)`);
  const header = lines[0].split("\t");
  if (header.some((h) => pyStripEmpty(h))) throw new TsvError(`${source} has an empty column name in its header`);
  if (new Set(header).size !== header.length) throw new TsvError(`${source} has duplicate column names: ${pyListRepr(header)}`);
  const rows = [];
  for (let n = 2; n <= lines.length; n++) {
    const cells = lines[n - 1].split("\t");
    if (cells.length !== header.length) {
      throw new TsvError(`${source} line ${n} has ${cells.length} fields but the header has ${header.length}`);
    }
    rows.push(cells);
  }
  return [header, rows];
}

// str.strip() == "" in Python: only whitespace
function pyStripEmpty(s) {
  return pyStrip(s) === "";
}

/**
 * read_tsv: UTF-8, or Latin-1 when the bytes are not UTF-8.
 * @param {Blob} file
 * @param {string} source how the file is named in errors
 */
export async function readTsv(file, source) {
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    throw new TsvError(`Cannot read ${source}: ${e.message}`);
  }
  const dec = decodeUtf8Python(bytes);
  const text = "text" in dec ? dec.text : decodeLatin1(bytes);
  return parseTsvText(text, source);
}

/**
 * load_json_chain: the JSON sidecars merged from least to most specific (later keys win), with
 * the desktop's problems for files that cannot be read, hold NaN or Infinity, or no object.
 * @param {{name: string, file: Blob}[]} chain
 * @returns {Promise<{merged: object, problems: string[], numberText: Map<string, string>}>}
 */
export async function loadJsonChain(chain) {
  const merged = {};
  const numberText = new Map();
  const problems = [];
  for (const p of chain) {
    let parsed;
    try {
      let bytes = new Uint8Array(await p.file.arrayBuffer());
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3); // utf-8-sig
      const dec = decodeUtf8Python(bytes);
      if ("error" in dec) throw new Error(dec.error);
      // read_text() reads with universal newlines
      parsed = parsePythonJson(dec.text.replace(/\r\n?/g, "\n"));
    } catch (e) {
      problems.push(`Could not read JSON sidecar ${p.name}: ${e.message}`);
      continue;
    }
    if (parsed.constants.length) {
      problems.push(
        `JSON sidecar ${p.name} contains ${[...new Set(parsed.constants)].sort(pyCompare).join(", ")}, which is not valid JSON; ` +
          "these values are written as null in ElectroClean's outputs",
      );
    }
    const data = parsed.value;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      problems.push(`JSON sidecar ${p.name} does not contain an object`);
      continue;
    }
    for (const [k, v] of Object.entries(data)) {
      Object.defineProperty(merged, k, { value: v, enumerable: true, writable: true, configurable: true });
      if (parsed.numberText.has(k)) numberText.set(k, parsed.numberText.get(k));
      else numberText.delete(k);
    }
  }
  return { merged, problems, numberText };
}
