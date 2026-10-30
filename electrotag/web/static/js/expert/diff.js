// What changed between a saved version and its correction (docs/web/api.md, "Corrections and replay"):
// the same function as electrotag/web/corrections.py diff_annotations, tested with the same cases
// (web_tests/unit/correction_diff_cases.json). Marks are matched by annotation_id, because a
// correction keeps the IDs of the marks it changes; each change is added, removed or changed, with
// the fields that changed (label, onset, end, channels, confidence, note), in the order of the
// recording. The words for the changes and their reasons are here too, for the correction view and
// the annotator's feedback, with the reasons that suit each kind of change.

/** Why a mark was changed (corrections.py REASONS), in the order of the chips. */
export const REASONS = Object.freeze({
  missed: 'Missed artifact',
  not_artifact: 'Not an artifact',
  wrong_type: 'Wrong type',
  boundaries: 'Start or end',
  channels: 'Channels',
  split_merge: 'Should be split or merged',
  other: 'Other',
});
export const CHANGES = Object.freeze(['added', 'removed', 'changed']);
/** The reasons that suit each kind of change (corrections.py REASONS_FOR): an added mark is never "Not an artifact". */
export const REASONS_FOR = Object.freeze({
  added: Object.freeze(['missed', 'wrong_type', 'boundaries', 'channels', 'split_merge', 'other']),
  removed: Object.freeze(['not_artifact', 'wrong_type', 'boundaries', 'channels', 'split_merge', 'other']),
  changed: Object.freeze(['wrong_type', 'boundaries', 'channels', 'split_merge', 'other']),
});
/** The words for a kind of change in a sentence (corrections.py CHANGE_WORDS). */
export const CHANGE_WORDS = Object.freeze({ added: 'an added mark', removed: 'a removed mark', changed: 'a changed mark' });
/** The key of each reason, shown on its chip: its place in REASONS (Shift and the digit chooses it). */
export const REASON_KEYS = Object.freeze(Object.fromEntries(Object.keys(REASONS).map((k, i) => [k, String(i + 1)])));
export const MAX_NOTE = 300;
export const MAX_OVERALL = 1000;

/** An annotation as the difference compares it. */
export function mark(a) {
  const c = a.confidence;
  return {
    annotation_id: String(a.annotation_id || ''), label: String(a.label || ''),
    onset_sample: Number(a.onset_sample) || 0, duration_samples: Number(a.duration_samples) || 0,
    channels: (a.channels || []).map(String),
    confidence: Number.isInteger(c) ? c : null, note: String(a.note || ''),
  };
}

const sameSet = (x, y) => {
  const a = new Set(x);
  const b = new Set(y);
  return a.size === b.size && [...a].every((v) => b.has(v));
};

/** The fields in which two versions of one mark differ (channels as a set). */
export function changedFields(b, a) {
  const out = [];
  if (b.label !== a.label) out.push('label');
  if (b.onset_sample !== a.onset_sample) out.push('onset');
  if (b.onset_sample + b.duration_samples !== a.onset_sample + a.duration_samples) out.push('end');
  if (!sameSet(b.channels, a.channels)) out.push('channels');
  if (b.confidence !== a.confidence) out.push('confidence');
  if (b.note !== a.note) out.push('note');
  return out;
}

/** What changed from `original` to `current` (see the top of this file): [{annotation_id, change, fields, before, after}]. */
export function diffAnnotations(original, current) {
  const before = new Map((original || []).map(mark).map((m) => [m.annotation_id, m]));
  const after = new Map((current || []).map(mark).map((m) => [m.annotation_id, m]));
  const out = [];
  for (const [id, b] of before) if (!after.has(id)) out.push({ annotation_id: id, change: 'removed', fields: [], before: b, after: null });
  for (const [id, a] of after) {
    if (!before.has(id)) { out.push({ annotation_id: id, change: 'added', fields: [], before: null, after: a }); continue; }
    const fields = changedFields(before.get(id), a);
    if (fields.length) out.push({ annotation_id: id, change: 'changed', fields, before: before.get(id), after: a });
  }
  const where = (c) => {
    const m = c.after || c.before;
    return [m.onset_sample, m.onset_sample + m.duration_samples, c.annotation_id];
  };
  // by start, end, then ID, as Python sorts the tuples (IDs compared by their code points)
  return out.sort((x, y) => {
    const [a, b] = [where(x), where(y)];
    return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
  });
}

/** Whether a change of this kind needs a reason under the study's review.reason_required (corrections.py needs_reason). */
export function needsReason(change, rule) {
  if (rule === 'never') return false;
  if (rule === 'edited_or_none') return change === 'changed' || change === 'removed';
  return true;
}

export function changeCounts(changes) {
  const out = { added: 0, removed: 0, changed: 0 };
  for (const c of changes) out[c.change] += 1;
  return out;
}

/** Where a correction in progress is kept in this browser: by the expert, the person and the version corrected. */
export function correctionKey(backend, me, target) {
  return `electrotag.correction|${(backend && backend.kind) || ''}|${me || ''}|${target.annotator_id}|${target.recording_id}|v${target.attempt}`;
}

/** The reasons a change may be given, in the order of the chips. */
export function reasonsFor(change) { return REASONS_FOR[change] || Object.keys(REASONS); }

/** What a kind of change is called on its row, in plain words. */
export const KIND_WORDS = Object.freeze({ added: 'Added', removed: 'Removed', changed: 'Changed' });

/** "2 added, 1 removed" (corrections.py counts_text), or "no changes". */
export function countsText(counts) {
  const parts = CHANGES.filter((k) => Number(counts[k]) > 0).map((k) => `${counts[k]} ${k}`);
  return parts.join(', ') || 'no changes';
}

const span = (m, sf) => `${(m.onset_sample / sf).toFixed(2)}–${((m.onset_sample + m.duration_samples) / sf).toFixed(2)} s`;
const FIELD_WORDS = { label: 'type', onset: 'start', end: 'end', channels: 'channels', confidence: 'confidence', note: 'note' };

/** One change in plain words: "Added Eye-blink-artifact 12.30–12.71 s", "Changed type: Eye-blink-artifact to Eye-artifact". */
export function changeText(c, sf) {
  if (c.change === 'added') return `Added ${c.after.label} ${span(c.after, sf)}`;
  if (c.change === 'removed') return `Removed ${c.before.label} ${span(c.before, sf)}`;
  if (c.fields.length === 1 && c.fields[0] === 'label') return `Changed type: ${c.before.label} to ${c.after.label} ${span(c.after, sf)}`;
  const what = c.fields.map((f) => FIELD_WORDS[f] || f);
  const list = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}` : what[0];
  const times = c.fields.includes('onset') || c.fields.includes('end') ? ` (was ${span(c.before, sf)})` : '';
  return `Changed ${list}: ${c.after.label} ${span(c.after, sf)}${times}`;
}

/** The reason that suits a change best, offered first: a missed artifact for an added mark, and so on. */
export function suggestedReason(c) {
  if (c.change === 'added') return 'missed';
  if (c.change === 'removed') return 'not_artifact';
  if (c.fields.includes('label')) return 'wrong_type';
  if (c.fields.includes('onset') || c.fields.includes('end')) return 'boundaries';
  if (c.fields.includes('channels')) return 'channels';
  return 'other';
}
