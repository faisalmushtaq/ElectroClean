// The sandbox's GET /me/results (docs/web/api.md, "Your own saved files"): the files of one saved
// version of a recording, made in this browser in the formats the study server writes them
// (electrotag/app/io/export.py and the journalled save): the _events.tsv, built row for row as
// build_events_table does (web_tests/unit/api_contract_parity.test.mjs compares it with the server's),
// the _events.json sidecar, the _annotations.json document with the ratings and notes, a
// _session.json with what the sandbox keeps of the session, and _time_viewed.txt.

import { ApiError } from './http.js';
import { CATALOGUE, CATALOGUE_NAME } from './demo_catalogue.js';
import { DEMO_NOTICE } from './notice.js';
import { pyFloatRepr } from '../eeg/pyfmt.js';

const NA = 'n/a';
const REQUIRED_COLUMNS = ['onset', 'duration', 'trial_type', 'value', 'sample', 'channels'];
const ELECTROTAG_COLUMNS = ['artifact_code', 'event_source', 'annotation_id', 'annotator_id', 'original_row', 'confidence', 'annotation_note'];
const ARTIFACT_SOURCE = 'electrotag_artifact';
const MODES = ['standard', 'guided', 'practice', 'assessment'];
const LABELS = new Map(CATALOGUE.labels.map((l) => [l.label, l]));

/** Python's sorted() of strings (code point order), as MNE numbers the descriptions of EDF+ annotations. */
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The rows of a built-in example's events.tsv (onset, duration and trial_type, as the sandbox's
 * examples carry them: web_tests/unit/api_contract_parity.test.mjs writes the same file for the
 * server), as the server reads them: the cells as written, value n/a and the sample worked out from
 * the onset (time_to_sample: the nearest sample, halves up), no channels.
 */
export function exampleEventRows(events, sfreq) {
  return events.map((e) => ({ onset_s: e.onsetS,
    cells: [String(e.onsetS), '0', String(e.label), NA, String(Math.floor(e.onsetS * sfreq + 0.5)), NA] }));
}

/**
 * The rows of a recording's original events as the server reads them from an EDF+ file
 * (electrotag/app/eeg/events.py events_from_raw_annotations): onset and duration in seconds, the
 * annotation text, MNE's number for it (the sorted texts numbered from 1), the sample, no channels.
 */
export function edfEventRows(events, sfreq) {
  const texts = [...new Set(events.map((e) => String(e.label)))].sort(byCodePoint);
  const value = new Map(texts.map((t, i) => [t, i + 1]));
  return events.map((e) => {
    const sample = Math.round(Number(e.onset_sample) || 0);
    return { onset_s: sample / sfreq, cells: [pyFloatRepr(sample / sfreq), pyFloatRepr((Number(e.duration_samples) || 0) / sfreq),
      String(e.label), String(value.get(String(e.label))), String(sample), NA] };
  });
}

/** build_events_table and tsv_bytes: the original rows and the artifact annotations in one table, by onset. */
export function eventsTsv({ annotations, sfreq, annotatorId, original = [], originalSource = 'none' }) {
  const columns = [...REQUIRED_COLUMNS, ...ELECTROTAG_COLUMNS];
  const at = Object.fromEntries(columns.map((c, i) => [c, i]));
  const keyed = [];
  original.forEach((r, i) => {
    const out = new Array(columns.length).fill(NA);
    r.cells.forEach((v, k) => { out[k] = v; });
    out[at.event_source] = `original:${originalSource}`;
    out[at.original_row] = String(i + 1);
    keyed.push([[r.onset_s, 0, i], out]);
  });
  const sorted = [...annotations].sort((a, b) => a.onset_sample - b.onset_sample || a.duration_samples - b.duration_samples
    || byCodePoint(a.label, b.label) || byCodePoint(a.annotation_id, b.annotation_id));
  sorted.forEach((a, j) => {
    const out = new Array(columns.length).fill(NA);
    out[at.onset] = pyFloatRepr(a.onset_sample / sfreq);
    out[at.duration] = pyFloatRepr(a.duration_samples / sfreq);
    out[at.trial_type] = a.label;
    out[at.artifact_code] = String(LABELS.get(a.label) ? LABELS.get(a.label).value : NA);
    out[at.sample] = String(a.onset_sample);
    out[at.channels] = JSON.stringify(a.channels || []);
    out[at.event_source] = ARTIFACT_SOURCE;
    out[at.annotation_id] = a.annotation_id;
    out[at.annotator_id] = annotatorId;
    out[at.confidence] = a.confidence === null || a.confidence === undefined ? NA : String(a.confidence);
    out[at.annotation_note] = a.note || NA;
    keyed.push([[a.onset_sample / sfreq, 1, j], out]);
  });
  keyed.sort(([x], [y]) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  // a cell never holds a tab or a line break (a note is one line; the server refuses others)
  const clean = (v) => String(v).replace(/[\t\r\n]+/g, ' ');
  return [columns.join('\t'), ...keyed.map(([, row]) => row.map(clean).join('\t'))].join('\n') + '\n';
}

/** The _events.json sidecar of build_events_sidecar for a recording with no events.json of its own. */
export function eventsSidecar({ recordingId, annotatorId, sessionId, confidence, originalSource }) {
  const labels = CATALOGUE.labels;
  const codes = labels.map((l) => l.value);
  return {
    trial_type: {
      Description: 'Event type. Artifact rows use HED-SCORE artifact terms.',
      Levels: Object.fromEntries(labels.map((l) => [l.label, l.description || l.label])),
      HED: Object.fromEntries(labels.map((l) => [l.label, `sc:${l.label}`])),
    },
    value: { Description: 'Marker value of the original events (n/a on artifact rows).' },
    artifact_code: {
      LongName: 'Artifact code',
      Description: `Fixed ElectroTag code of the artifact type on rows with event_source '${ARTIFACT_SOURCE}' (n/a on original rows). `
        + `Codes never change between datasets or versions: ${Math.min(...codes)}-${Math.max(...codes)}, with group terms from 130.`,
      Levels: Object.fromEntries([...labels].sort((a, b) => a.value - b.value).map((l) => [String(l.value), l.label])),
    },
    sample: { Description: 'Onset as a 0-based sample index relative to the first sample in the data file.' },
    channels: {
      LongName: 'Affected channels',
      Description: "For rows with event_source 'electrotag_artifact': a JSON array of channel names. An empty array [] means the artifact "
        + 'affects the whole recording montage (all channels). For original rows the value comes from the original events file.',
    },
    event_source: {
      Description: 'Origin of the row.',
      Levels: {
        'original:events_tsv': "Unchanged row from the recording's original BIDS events.tsv.",
        'original:edf_annotations': 'Annotation from the EDF+ file itself (read with MNE-Python).',
        [ARTIFACT_SOURCE]: 'Artifact annotation created with ElectroTag.',
      },
    },
    annotation_id: { Description: 'Stable identifier of the ElectroTag artifact annotation (n/a for original rows).' },
    annotator_id: { Description: 'Identifier of the annotator who created the artifact annotation (n/a for original rows).' },
    original_row: { Description: '1-based row number in the original events file (n/a for artifact rows).' },
    confidence: {
      LongName: 'Confidence of the artifact annotation',
      Description: `How confident the annotator was that the artifact annotation is right, on an ordinal 5-point Likert scale, on rows with event_source '${ARTIFACT_SOURCE}' `
        + '(n/a on original rows). n/a on an artifact row means that the annotation was not rated.',
    },
    annotation_note: {
      LongName: "Annotator's note",
      Description: `The annotator's optional short note on the artifact (at most 200 characters), on rows with event_source '${ARTIFACT_SOURCE}'; n/a when there is no note, and on original rows.`,
    },
    ElectroTagMetadata: {
      GeneratedBy: 'ElectroTag web demonstration', recording_id: recordingId, annotator_id: annotatorId, session_id: sessionId,
      original_events_source: originalSource, confidence_setting: confidence || 'optional', catalogue: CATALOGUE_NAME, note: DEMO_NOTICE,
    },
  };
}

/** GET /me/results/{recording_id}: the annotator's own files of one saved version (the latest, or `version`). */
export async function myResults(backend, recordingId, mode = 'standard', contextId = '', version = null) {
  const aid = backend._aid();
  const m = mode || 'standard';
  if (typeof recordingId !== 'string' || !recordingId || !MODES.includes(m)) throw new ApiError(400, 'bad_request', 'recording_id and mode are needed');
  const ctx = m === 'standard' ? '' : String(contextId || '');
  let v = version === null || version === undefined || version === '' ? null : Number(version);
  if (v !== null && !(Number.isInteger(v) && v >= 1)) throw new ApiError(400, 'bad_request', 'version must be a whole number from 1');
  const subs = backend.state.submissions;
  const mine = subs.filter((s) => s.annotator_id === aid && s.recording_id === recordingId && (s.mode || 'standard') === m && (s.context_id || '') === ctx);
  if (v === null && mine.length) v = Math.max(...mine.map((s) => s.attempt));
  const sub = mine.find((s) => s.attempt === v);
  const info = sub ? backend._recordingInfo(recordingId) : null;
  if (!sub || !info) {
    throw new ApiError(404, 'not_saved', `You have no saved annotations of ${recordingId}${version !== null && version !== undefined && version !== '' ? ` in version ${version}` : ''}. `
      + 'Only recordings you finished with Save and Finish can be downloaded.');
  }
  const doc = backend.resultsDocument().annotation_documents[subs.indexOf(sub)];
  // A built-in example carries an events.tsv; a recording added in the admin area its EDF+ annotations.
  let original;
  let source;
  if (info.builtin) {
    original = exampleEventRows(info.spec.events || [], info.sfreq);
    source = original.length ? 'events_tsv' : 'none';
  } else {
    const manifest = await backend._publicManifest(recordingId);
    original = edfEventRows((manifest && manifest.original_events) || [], info.sfreq);
    source = original.length ? 'edf_annotations' : 'none';
  }
  const base = backend._outputBasename(info, aid, v);
  const sessionId = (sub.session && sub.session.session_id) || doc.session.session_id;
  const elapsed = Number(sub.session && sub.session.elapsed_s) || 0;
  const session = {
    schema: 'electrotag.session', note: DEMO_NOTICE, session_id: sessionId, recording_id: recordingId, annotator_id: aid,
    mode: m, context_id: ctx, attempt: v, saved_at: sub.saved_at, sha256: sub.sha256,
    application: { name: 'ElectroTag', client: 'web', version: 'web demonstration' },
    timing: { elapsed_seconds: elapsed }, browser_session: sub.session || {},
  };
  const files = [
    { name: `${base}_annotations.json`, text: `${JSON.stringify(doc, null, 2)}\n` },
    { name: `${base}_events.json`, text: `${JSON.stringify(eventsSidecar({ recordingId, annotatorId: aid, sessionId, confidence: sub.confidence_setting, originalSource: source }), null, 2)}\n` },
    { name: `${base}_events.tsv`, text: eventsTsv({ annotations: sub.annotations, sfreq: info.sfreq, annotatorId: aid, original, originalSource: source }) },
    { name: `${base}_session.json`, text: `${JSON.stringify(session, null, 2)}\n` },
    { name: `${base}_time_viewed.txt`, text: `${elapsed.toFixed(3)}\n` },
  ].sort((a, b) => byCodePoint(a.name, b.name));
  return { recording_id: recordingId, mode: m, context_id: ctx, version: v, file_name: `${base}.zip`, files };
}
