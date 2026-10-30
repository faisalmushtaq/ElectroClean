// The replay of a session from its interaction log, without the page (docs/web/admin.md, "Replaying
// a session"; tested in Node). A segment is one recording opened in one window of a visit
// (replay_index_get), with its events (replay_events_get). buildTimeline puts the events of one or
// more segments on one time line, in order, a second apart; stateAt rebuilds what the annotator saw
// at any moment: the annotations, the view, the pointer, the selection, the chosen type and scope,
// a started mark, an open dialog and whether they had paused.
//
// Where a segment starts from: its annotations_snapshot (logged since the browser has logged one when
// a session opens with annotations already present: a restored draft, a revision, a correction), or,
// in a log written before that, the end of the segment before it when the session restored a draft
// or revised the saved version, or nothing. Notes are never in the log: only their length.

const GAP_S = 1;
const CHECKPOINT_EVERY = 250;

/** The events that change annotations (their ticks on the scrubber, Shift+, and Shift+.). */
export const CHANGE_TYPES = Object.freeze(['annotations_snapshot', 'annotation_created', 'annotation_deleted', 'annotation_edited',
  'annotation_relabelled', 'annotation_channels_changed', 'confidence_set', 'note_set', 'undo', 'redo', 'annotations_merged',
  'annotations_reset']);
const CHANGES = new Set(CHANGE_TYPES);
/** Events the step keys pass over (, and .): the pointer moves on its own. */
const QUIET = new Set(['pointer', 'mouse_release', 'wheel', 'field_edited', 'app_state', 'window_activated', 'window_deactivated', 'status_message']);

/** An annotation from the log's summary of it (id, label, onset_s, offset_s, channels, confidence, note_length). */
export function fromSummary(s, sf) {
  const onset = Math.round(Number(s.onset_s) * sf);
  const end = Math.round(Number(s.offset_s) * sf);
  return { annotation_id: String(s.id), label: String(s.label || ''), onset_sample: onset, duration_samples: Math.max(1, end - onset),
    channels: Array.isArray(s.channels) ? [...s.channels] : [], confidence: Number.isInteger(s.confidence) ? s.confidence : null,
    note_length: Number(s.note_length) || 0 };
}

/** An empty state: what a replay shows before the first event. */
export function emptyState() {
  return { annotations: new Map(), view: null, pointer: null, selection: [], label: null, scope: 'whole', markStartS: null,
    dialog: null, paused: false, filters: null, overlay: false, event: null, segment: -1 };
}

export function cloneState(s) {
  return { ...s, annotations: new Map(s.annotations), selection: [...s.selection], pointer: s.pointer ? { ...s.pointer } : null,
    view: s.view ? { ...s.view } : null, dialog: s.dialog ? { ...s.dialog } : null };
}

function summaries(list) { return Array.isArray(list) ? list.filter((x) => x && x.id !== undefined) : []; }

/** Apply one event of the timeline to a state (in place). */
export function applyEvent(state, item, sf) {
  const e = item.e;
  const put = (list) => { for (const s of summaries(list)) state.annotations.set(String(s.id), fromSummary(s, sf)); };
  const drop = (list) => { for (const s of Array.isArray(list) ? list : []) state.annotations.delete(String(typeof s === 'object' && s ? s.id : s)); };
  state.event = item;
  state.segment = item.seg;
  switch (e.type) {
    case 'recording_opened':
      if (item.seed !== 'chained') state.annotations = new Map();
      state.selection = []; state.markStartS = null; state.dialog = null; state.paused = false; state.pointer = null;
      break;
    case 'annotations_snapshot':
      if (!(Number(e.part) > 1)) state.annotations = new Map();
      put(e.annotations);
      break;
    case 'annotation_created': drop(e.merged_away); put(e.annotations); break;
    case 'annotation_deleted': drop(e.annotations); break;
    case 'annotation_edited': case 'annotation_relabelled': case 'annotation_channels_changed':
      drop(e.merged_away); put(e.annotations); break;
    case 'undo': case 'redo': case 'annotations_merged': case 'annotations_reset':
      drop(e.removed); put(e.added); put(e.changed); break;
    case 'confidence_set':
      for (const s of summaries(e.annotations)) {
        const a = state.annotations.get(String(s.id));
        if (a) state.annotations.set(a.annotation_id, { ...a, confidence: Number.isInteger(s.confidence) ? s.confidence : null });
      }
      break;
    case 'note_set':
      for (const s of summaries(e.annotations)) {
        const a = state.annotations.get(String(s.id));
        if (a) state.annotations.set(a.annotation_id, { ...a, note_length: Number(s.note_length) || 0 });
      }
      break;
    case 'view':
      state.view = { startS: Number(e.t_start) || 0, durationS: Number(e.duration) || 10, firstChannel: Number(e.ch_start) || 0,
        nChannels: Number(e.n_channels) || 1, scaleFactor: Number(e.scale_factor) || 1 };
      if (typeof e.butterfly === 'boolean') state.overlay = e.butterfly;
      break;
    case 'pointer': case 'mouse_press': case 'mouse_release': case 'double_click': case 'wheel':
      if (typeof e.eeg_t === 'number') state.pointer = { t: e.eeg_t, channel: e.eeg_channel || null };
      break;
    case 'selection': state.selection = e.annotation_id ? [String(e.annotation_id)] : []; break;
    case 'state':
      if ('current_label' in e) state.label = e.current_label;
      if ('scope' in e) state.scope = e.scope;
      if ('mark_start_s' in e) state.markStartS = e.mark_start_s;
      if ('filters' in e) state.filters = e.filters;
      if ('overlay' in e) state.overlay = Boolean(e.overlay);
      break;
    case 'dialog_shown': state.dialog = { title: e.title || '', dialog: e.dialog || '' }; break;
    case 'dialog_closed': state.dialog = null; break;
    case 'pause': state.paused = true; break;
    case 'resume': state.paused = false; break;
    default: break;
  }
  return state;
}

/** How a segment starts: from its snapshot, from where the one before ended, or from nothing. */
export function seedOf(events, i) {
  if (events.some((e) => e.type === 'annotations_snapshot')) return 'snapshot';
  const opened = events.find((e) => e.type === 'recording_opened') || {};
  if (i > 0 && (Number(opened.annotations_restored) > 0 || opened.resumed === true || events.some((e) => e.type === 'revision_started'))) return 'chained';
  return 'empty';
}

/**
 * The time line of one or more segments ([{segment, events}], oldest first): each event with its time
 * on the line (t), its segment (seg) and, for each segment's opening, how it starts (seed). Pauses and
 * idle stretches are listed (idle) for the scrubber and Skip pauses; checkpoints keep stateAt quick.
 */
export function buildTimeline(segments, { sfreq = 256 } = {}) {
  const items = [];
  const bounds = [];
  const idle = [];
  let offset = 0;
  (segments || []).forEach((sg, i) => {
    const events = [...(sg.events || [])].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
    if (!events.length) { bounds.push({ start: offset, end: offset, seed: 'empty', segment: sg.segment || {} }); return; }
    const t0 = Number(events[0].t) || 0;
    const seed = seedOf(events, i);
    let open = null;
    let last = offset;
    for (const e of events) {
      const t = offset + Math.max(0, (Number(e.t) || 0) - t0);
      const it = { t, orig: t, seg: i, e, change: CHANGES.has(e.type) };
      if (e.type === 'recording_opened') it.seed = seed;
      items.push(it);
      if ((e.type === 'pause' || e.type === 'idle_start') && open === null) open = t;
      if ((e.type === 'resume' || e.type === 'idle_end') && open !== null) { idle.push([open, t]); open = null; }
      last = t;
    }
    if (open !== null) idle.push([open, last]);
    bounds.push({ start: offset, end: last, seed, segment: sg.segment || {}, unknownStart: seed === 'empty' && events.some((e) => e.type === 'recording_opened' && Number(e.annotations_restored) > 0) });
    offset = last + GAP_S;
  });
  const timeline = { items, segments: bounds, idle, sfreq, duration: items.length ? items[items.length - 1].t : 0, checkpoints: [] };
  addCheckpoints(timeline);
  return timeline;
}

function addCheckpoints(timeline) {
  const st = emptyState();
  timeline.checkpoints = [{ index: -1, state: cloneState(st) }];
  timeline.items.forEach((it, i) => {
    applyEvent(st, it, timeline.sfreq);
    if ((i + 1) % CHECKPOINT_EVERY === 0) timeline.checkpoints.push({ index: i, state: cloneState(st) });
  });
  timeline.finalState = cloneState(st);
}

/** The index of the last event at or before time t (-1 before the first). */
export function indexAt(timeline, t) {
  const it = timeline.items;
  let lo = 0;
  let hi = it.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (it[mid].t <= t + 1e-9) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** What the annotator saw at time t (a state; see emptyState). */
export function stateAt(timeline, t) {
  const idx = indexAt(timeline, t);
  let cp = timeline.checkpoints[0];
  for (const c of timeline.checkpoints) if (c.index <= idx) cp = c; else break;
  const st = cloneState(cp.state);
  for (let i = cp.index + 1; i <= idx; i++) applyEvent(st, timeline.items[i], timeline.sfreq);
  return st;
}

function find(timeline, t, dir, ok) {
  const it = timeline.items;
  if (dir > 0) {
    for (let i = Math.max(0, indexAt(timeline, t) + 1); i < it.length; i++) if (it[i].t > t + 1e-6 && ok(it[i])) return it[i].t;
  } else {
    for (let i = indexAt(timeline, t); i >= 0; i--) if (it[i].t < t - 1e-6 && ok(it[i])) return it[i].t;
  }
  return null;
}

/** The time of the next or previous change of annotations (null at either end). */
export const nextChange = (timeline, t) => find(timeline, t, 1, (x) => x.change);
export const prevChange = (timeline, t) => find(timeline, t, -1, (x) => x.change);
/** The time of the next or previous event worth stepping to (the pointer's own moves are passed over). */
export const nextEvent = (timeline, t) => find(timeline, t, 1, (x) => !QUIET.has(x.e.type));
export const prevEvent = (timeline, t) => find(timeline, t, -1, (x) => !QUIET.has(x.e.type));

/**
 * The same time line with every stillness longer than maxGapS (between two events, and the pauses and
 * idle stretches) shortened to maxGapS: Skip pauses. Each event keeps its original time in `orig`.
 */
export function compressIdle(timeline, maxGapS = 3) {
  let shift = 0;
  let prev = null;
  const items = timeline.items.map((x) => {
    if (prev !== null && x.orig - prev > maxGapS) shift += x.orig - prev - maxGapS;
    prev = x.orig;
    return { ...x, t: x.orig - shift };
  });
  const origs = { items: timeline.items.map((x) => ({ t: x.orig })) };
  const map = (t) => {
    const i = indexAt(origs, t);
    if (i < 0) return t;
    return items[i].t + Math.min(t - timeline.items[i].orig, maxGapS);
  };
  const out = { ...timeline, items, duration: items.length ? items[items.length - 1].t : 0,
    idle: timeline.idle.map(([a, b]) => [map(a), map(b)]),
    segments: timeline.segments.map((s) => ({ ...s, start: map(s.start), end: map(s.end) })) };
  out.checkpoints = timeline.checkpoints;
  out.finalState = timeline.finalState;
  return out;
}

/** The time on `to` of the moment at time t on `from` (two versions of one time line: with and without pauses). */
export function mapTime(from, to, t) {
  const i = indexAt(from, t);
  if (i < 0) return 0;
  const room = to.items[i + 1] ? to.items[i + 1].t - to.items[i].t : 0;
  return to.items[i].t + Math.min(Math.max(0, t - from.items[i].t), room);
}

const sameSet = (x, y) => {
  const a = new Set(x || []);
  const b = new Set(y || []);
  return a.size === b.size && [...a].every((v) => b.has(v));
};

/**
 * The end of a replay against the saved version ({annotations}): the same when every mark has the same
 * type, start and end (to a sample, as the log keeps times to a tenth of a millisecond), channels and
 * confidence, and a note of the same length. {same, differing, missing, extra}.
 */
export function compareWithSaved(finalState, saved, sfreq) {
  void sfreq;
  const mine = finalState.annotations instanceof Map ? finalState.annotations : new Map((finalState.annotations || []).map((a) => [a.annotation_id, a]));
  const theirs = new Map((saved || []).map((a) => [a.annotation_id, a]));
  let differing = 0;
  let missing = 0;
  let extra = 0;
  for (const [id, a] of theirs) {
    const b = mine.get(id);
    if (!b) { missing += 1; continue; }
    const same = a.label === b.label && Math.abs(a.onset_sample - b.onset_sample) <= 1
      && Math.abs((a.onset_sample + a.duration_samples) - (b.onset_sample + b.duration_samples)) <= 1
      && sameSet(a.channels, b.channels) && (a.confidence ?? null) === (b.confidence ?? null)
      && String(a.note || '').length === (b.note_length ?? String(b.note || '').length);
    if (!same) differing += 1;
  }
  for (const id of mine.keys()) if (!theirs.has(id)) extra += 1;
  const n = differing + missing + extra;
  return { same: n === 0, differing: n, changed: differing, missing, extra };
}

const at = (s) => `${Number(s).toFixed(2)} s`;
const labelsOf = (list) => [...new Set(summaries(list).map((s) => s.label))].join(', ');

/** The caption of an event: what the annotator did, in plain words (null for an event that only moves the pointer). */
export function captionOf(e) {
  const n = (list) => summaries(list).length;
  switch (e.type) {
    case 'recording_opened': return 'Opened the recording';
    case 'viewer_ready': return 'The EEG is on screen';
    case 'annotations_snapshot': return `Started with ${n(e.annotations)} annotation${n(e.annotations) === 1 ? '' : 's'} already there`;
    case 'annotation_created': return `Created ${labelsOf(e.annotations)}${/^key|^shortcut/.test(e.via || '') ? ' with the keyboard' : /^button|^menu/.test(e.via || '') ? '' : ' by dragging on the EEG'}${e.merged_away && e.merged_away.length ? ', merged with the mark beside it' : ''}`;
    case 'annotation_deleted': return `Deleted ${labelsOf(e.annotations)}`;
    case 'annotation_edited': return `Changed the times of ${labelsOf(e.annotations)}`;
    case 'annotation_relabelled': return `Changed the type${e.before ? ` from ${labelsOf(e.before)}` : ''} to ${labelsOf(e.annotations)}`;
    case 'annotation_channels_changed': return `Changed the channels of ${labelsOf(e.annotations)}`;
    case 'confidence_set': return summaries(e.annotations).map((a) => (a.confidence ? `Rated ${a.label} ${a.confidence} of 5` : `Cleared the rating of ${a.label}`)).join('; ');
    case 'note_set': return summaries(e.annotations).map((a) => (a.change === 'removed' ? `Removed the note of ${a.label}` : `${a.change === 'changed' ? 'Changed' : 'Added'} a note to ${a.label} (${a.note_length} characters)`)).join('; ');
    case 'undo': return 'Undo';
    case 'redo': return 'Redo';
    case 'annotations_merged': return `Merged ${n(e.removed) + n(e.changed)} annotations`;
    case 'annotations_reset': return 'The annotations were replaced';
    case 'shortcut': return `Pressed ${e.key}: ${e.action}`;
    case 'key': return `Pressed ${e.key}`;
    case 'view': return `Showing ${at(e.t_start)} to ${at(Number(e.t_start) + Number(e.duration))}`;
    case 'selection': return e.annotation_id ? `Selected ${e.label}` : 'Cleared the selection';
    case 'state':
      if ('current_label' in e) return `Chose the type ${e.current_label}`;
      if ('scope' in e) return e.scope === 'channels' ? 'Marks on selected channels' : 'Marks on the whole montage';
      if ('mark_start_s' in e) return e.mark_start_s === null ? 'Cancelled the started mark' : `Started a mark at ${at(e.mark_start_s)}`;
      if ('selected_channels' in e) return `Selected ${(e.selected_channels || []).length} channels`;
      if ('overlay' in e) return e.overlay ? 'Overlaid the channels' : 'Channels in rows again';
      if ('filters' in e) return 'Changed the display filters';
      return 'Changed a display setting';
    case 'mouse_press': return e.area === 'eeg' || e.eeg_t !== undefined ? `Pressed the mouse on the EEG at ${at(e.eeg_t)}` : null;
    case 'dialog_shown': return `A dialog opened: ${e.title || e.dialog}`;
    case 'dialog_closed': return e.button ? `Chose ${e.button}` : 'Closed the dialog';
    case 'go_to_time': return e.valid ? `Went to ${at(e.t_s)}` : 'Typed a time that could not be read';
    case 'show_all': return e.on ? 'Showed the whole recording' : 'Back from Show all';
    case 'pause': return 'Paused';
    case 'resume': return 'Resumed';
    case 'idle_start': return 'No input for a while';
    case 'idle_end': return 'Back after a while without input';
    case 'recording_finished': return `Save and Finish with ${e.n_annotations ?? 'the'} annotations`;
    case 'closed_without_saving': return e.kept ? 'Closed, to finish later' : 'Closed without saving';
    case 'coverage_check': return 'Checked the parts not yet viewed';
    default: return null;
  }
}

/** A replay's time with tenths of a second, for the transport bar: "0:04.2", "1:05.0". */
export function clockTenths(t) {
  const s = Math.max(0, Math.round(t * 10) / 10);
  const whole = Math.floor(s);
  return `${clock(whole)}.${Math.round((s - whole) * 10) % 10}`;
}

/** A replay's time in words: "1:05" or "1:02:05". */
export function clock(t) {
  const s = Math.max(0, Math.floor(t));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

export const SPEEDS = Object.freeze([0.5, 1, 2, 4, 8, 16]);
