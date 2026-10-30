// Finding the recordings among files the annotator picked (one EDF or BDF file, or the .vhdr,
// .vmrk and .eeg files of a BrainVision recording, picked together or as a folder). Plain ES module.

import { parseVhdr } from "./brainvision.js";
import { RecordingError, extensionOf } from "./util.js";

/** Recording formats by file extension (lower case), as the desktop's discovery. */
export const FORMATS = Object.freeze({ ".vhdr": "brainvision", ".edf": "edf", ".bdf": "bdf" });

function relDir(file) {
  const rel = file.webkitRelativePath || "";
  const slash = rel.lastIndexOf("/");
  return slash >= 0 ? rel.slice(0, slash) : "";
}

function baseName(name) {
  return String(name).replace(/^.*[\\/]/, "");
}

/** The picked file a header names: same folder first, then by name alone, then ignoring case. */
function findCompanion(list, header, wanted) {
  const name = baseName(wanted);
  const dir = relDir(header);
  const same = list.filter((f) => f.name === name);
  if (same.length) return same.find((f) => relDir(f) === dir) || same[0];
  const lower = name.toLowerCase();
  const loose = list.filter((f) => f.name.toLowerCase() === lower);
  return loose.find((f) => relDir(f) === dir) || loose[0] || null;
}

/**
 * The recordings among the picked files.
 * @param {ArrayLike<File>} files
 * @returns {Promise<{fileName: string, format: string, files: File[], path: string, problems: string[]}[]>}
 */
export async function findRecordings(files) {
  const list = Array.from(files);
  const out = [];
  for (const f of list) {
    const format = FORMATS[extensionOf(f.name)];
    if (!format || f.name.startsWith(".")) continue;
    const path = f.webkitRelativePath || f.name;
    if (format !== "brainvision") {
      out.push({ fileName: f.name, format, files: [f], path, problems: [] });
      continue;
    }
    const problems = [];
    const group = [f];
    try {
      const h = parseVhdr(new Uint8Array(await f.arrayBuffer()), f.name);
      for (const [label, wanted] of [["Data", h.dataFile], ["Marker", h.markerFile]]) {
        if (!wanted) {
          problems.push(`Header ${f.name} does not name a ${label.toLowerCase()} file (${label}File=)`);
          continue;
        }
        const c = findCompanion(list, f, wanted);
        if (c) group.push(c);
        else problems.push(`${label} file '${wanted}' named in ${f.name} was not picked`);
      }
    } catch (e) {
      problems.push(e.message);
    }
    out.push({ fileName: f.name, format, files: group, path, problems });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * The one recording to open from the picked files.
 * @param {ArrayLike<File>} files
 * @param {{fileName?: string}} [options] fileName chooses among several recordings
 * @returns {Promise<{format: string, fileName: string, dataFile: File, vhdr?: File, vmrk?: File | null,
 *          eeg?: File, header?: object}>}
 */
export async function selectRecording(files, options = {}) {
  const list = Array.from(files || []);
  if (!list.length) throw new RecordingError("No file was picked", "no_files");
  let candidates = list.filter((f) => FORMATS[extensionOf(f.name)] && !f.name.startsWith("."));
  if (options.fileName) {
    const want = options.fileName;
    candidates = candidates.filter((f) => f.name === want || f.webkitRelativePath === want);
    if (!candidates.length) throw new RecordingError(`${want} is not among the picked files`, "no_files");
  }
  if (!candidates.length) {
    const exts = new Set(list.map((f) => extensionOf(f.name)));
    if (exts.has(".eeg") || exts.has(".vmrk")) {
      throw new RecordingError(
        "These look like parts of a BrainVision recording, but its header (.vhdr) was not picked. " +
          "Pick the .vhdr, .vmrk and .eeg files together, or their folder.",
        "missing_companion",
      );
    }
    throw new RecordingError("None of the picked files is an EDF, BDF or BrainVision (.vhdr) recording", "unsupported_format");
  }
  if (candidates.length > 1) {
    const names = candidates.map((f) => f.webkitRelativePath || f.name).sort();
    throw new RecordingError(
      `${candidates.length} recordings were picked (${names.slice(0, 5).join(", ")}${names.length > 5 ? ", ..." : ""}); open one at a time`,
      "several_recordings",
    );
  }
  const f = candidates[0];
  const format = FORMATS[extensionOf(f.name)];
  if (format !== "brainvision") return { format, fileName: f.name, dataFile: f };
  const header = parseVhdr(new Uint8Array(await f.arrayBuffer()), f.name);
  const hint = " Pick the .vhdr, .vmrk and .eeg files together, or their folder.";
  if (!header.dataFile) throw new RecordingError(`Header ${f.name} does not name a data file (DataFile=)`, "missing_companion");
  if (!header.markerFile) throw new RecordingError(`Header ${f.name} does not name a marker file (MarkerFile=)`, "missing_companion");
  const eeg = findCompanion(list, f, header.dataFile);
  if (!eeg) throw new RecordingError(`Data file '${header.dataFile}' named in ${f.name} was not found among the picked files.${hint}`, "missing_companion");
  const vmrk = findCompanion(list, f, header.markerFile);
  if (!vmrk) throw new RecordingError(`Marker file '${header.markerFile}' named in ${f.name} was not found among the picked files.${hint}`, "missing_companion");
  return { format, fileName: f.name, dataFile: eeg, vhdr: f, vmrk, eeg, header };
}
