// The annotations of one recording while they are edited: a port of the desktop application's
// AnnotationStore (electrotag/app/annotations/store.py), so the rules are the same in both.
//
// Annotations are plain objects in samples:
//   {annotation_id, label, onset_sample, duration_samples, channels: [...], created_at, modified_at,
//    confidence?, note?}
// `channels` is [] for the whole montage, otherwise channel names in recording order. `confidence`
// ('definite', 'probable' or 'possible') and `note` (one line of at most 200 characters) are there
// only when given (confidence.js).
//
// Automatic merging: when an annotation is created or changed so that it overlaps in time another
// annotation of the same type with the same channels (both whole montage, or exactly the same
// channels), the two become one annotation spanning both. The older one keeps its identifier, and
// the merge is part of the same undo step. Annotations that only touch, or cover different
// channels, stay separate. The merged annotation keeps the lowest confidence and the notes of
// both, joined with "; " (confidence.js).

import { newId, nowLocalIso } from '../util.js';
import { CONFIDENCE_LEVELS, cleanNote, joinNotes, lowerConfidence, noteProblem } from './confidence.js';

export class AnnotationError extends Error {}

export const endSample = (a) => a.onset_sample + a.duration_samples;
export const isGlobal = (a) => a.channels.length === 0;

function freeze(a) {
  const out = { ...a, channels: Object.freeze([...a.channels]) };
  // A confidence or note is kept only when given, so that annotations without them stay as they were.
  if (out.confidence) out.confidence = String(out.confidence); else delete out.confidence;
  if (typeof out.note === 'string' && out.note.trim()) out.note = out.note.trim(); else delete out.note;
  return Object.freeze(out);
}

function sortKey(a, b) {
  return a.onset_sample - b.onset_sample || a.duration_samples - b.duration_samples ||
    (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
    (a.annotation_id < b.annotation_id ? -1 : a.annotation_id > b.annotation_id ? 1 : 0);
}

export class AnnotationStore {
  /**
   * @param {{chNames: string[], nSamples: number, sfreq: number, labels: string[] | Set<string>,
   *          minDurationSamples?: number, initial?: object[], autoMerge?: boolean, maxHistory?: number}} opts
   */
  constructor(opts) {
    this.chNames = [...opts.chNames];
    this._chIndex = new Map(this.chNames.map((c, i) => [c, i]));
    this.nSamples = opts.nSamples;
    this.sfreq = opts.sfreq;
    this.labels = new Set(opts.labels);
    this.minDurationSamples = opts.minDurationSamples ?? 1;
    this.autoMerge = opts.autoMerge ?? true;
    // The confidence of a new annotation: '' (none given) or 'definite' (the study's every-mark setting).
    this.defaultConfidence = opts.defaultConfidence || '';
    this.maxHistory = opts.maxHistory ?? 2000;
    this.lastAutoMerged = 0;
    this.lastSurvivors = new Map();
    this._items = new Map();
    this._undo = [];
    this._redo = [];
    this._listeners = new Set();
    this.revision = 0;
    for (const a of opts.initial || []) {
      const ann = this._check(freeze({ ...a, channels: this.normaliseChannels(a.channels || []) }));
      if (this._items.has(ann.annotation_id)) throw new AnnotationError(`Duplicate annotation id ${ann.annotation_id}`);
      this._items.set(ann.annotation_id, ann);
    }
  }

  // ------------------------------------------------------------------ access
  get size() { return this._items.size; }

  has(id) { return this._items.has(id); }

  get(id) {
    const a = this._items.get(id);
    if (!a) throw new AnnotationError(`No annotation with id ${id}`);
    return a;
  }

  /** All annotations ordered by onset, then duration, label and id. */
  annotations() {
    return [...this._items.values()].sort(sortKey);
  }

  snapshot() { return this.annotations(); }

  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }
  get undoDescription() { return this._undo.length ? this._undo[this._undo.length - 1][0] : ''; }
  get redoDescription() { return this._redo.length ? this._redo[this._redo.length - 1][0] : ''; }

  // --------------------------------------------------------------- listeners
  addListener(cb) { this._listeners.add(cb); }
  removeListener(cb) { this._listeners.delete(cb); }

  _notify(change) {
    this.revision += 1;
    for (const cb of [...this._listeners]) cb(change);
  }

  // -------------------------------------------------------------- validation
  normaliseChannels(channels) {
    const chosen = new Set((channels || []).map(String));
    const unknown = [...chosen].filter((c) => !this._chIndex.has(c)).sort();
    if (unknown.length) throw new AnnotationError(`Unknown channel(s): ${unknown.join(', ')}`);
    return this.chNames.filter((c) => chosen.has(c));
  }

  _check(a) {
    if (!a.annotation_id) throw new AnnotationError('Annotation has no identifier');
    if (!this.labels.has(a.label)) throw new AnnotationError(`Unknown artifact type: ${a.label}`);
    const { onset_sample: on, duration_samples: dur } = a;
    if (!Number.isInteger(on) || !Number.isInteger(dur)) throw new AnnotationError('Onset and duration must be whole samples');
    if (on < 0) throw new AnnotationError(`${a.label} at sample ${on}: onset before the start of the recording`);
    if (dur < this.minDurationSamples) {
      throw new AnnotationError(`${a.label} at sample ${on}: shorter than ${this.minDurationSamples} sample(s)`);
    }
    if (on + dur > this.nSamples) throw new AnnotationError(`${a.label} at sample ${on}: ends after the recording`);
    if (new Set(a.channels).size !== a.channels.length) throw new AnnotationError('A channel is listed more than once');
    const unknown = a.channels.filter((c) => !this._chIndex.has(c));
    if (unknown.length) throw new AnnotationError(`Channels not in the recording: ${unknown.join(', ')}`);
    if (a.confidence && !CONFIDENCE_LEVELS.includes(a.confidence)) throw new AnnotationError(`Unknown confidence: ${a.confidence}`);
    const problem = noteProblem(a.note);
    if (problem) throw new AnnotationError(problem);
    return a;
  }

  /** Seconds to samples, as the desktop: nearest sample (halves round up), clipped, at least the minimum. */
  snapInterval(tStart, tStop) {
    const [lo, hi] = [Number(tStart), Number(tStop)].sort((x, y) => x - y);
    const toS = (t) => Math.floor(t * this.sfreq + 0.5);
    let start = Math.min(Math.max(toS(lo), 0), this.nSamples);
    let stop = Math.min(Math.max(toS(hi), 0), this.nSamples);
    return this.snapSamples(start, stop);
  }

  snapSamples(start, stop) {
    let s = Math.min(Math.max(Math.min(start, stop), 0), this.nSamples);
    let e = Math.min(Math.max(Math.max(start, stop), 0), this.nSamples);
    if (e - s < this.minDurationSamples) {
      e = Math.min(s + this.minDurationSamples, this.nSamples);
      s = Math.max(e - this.minDurationSamples, 0);
    }
    if (e - s < this.minDurationSamples) throw new AnnotationError('Recording is shorter than the minimum annotation duration');
    return [s, e - s];
  }

  // ----------------------------------------------------------------- merging
  static mergeable(a, b) {
    return a.label === b.label && a.channels.length === b.channels.length &&
      a.channels.every((c, i) => c === b.channels[i]) &&
      a.onset_sample < endSample(b) && b.onset_sample < endSample(a);
  }

  _absorb(items, id) {
    let current = items.get(id);
    let absorbed = 0;
    for (;;) {
      const partners = [...items.values()].filter((a) => a.annotation_id !== current.annotation_id &&
        AnnotationStore.mergeable(current, a));
      if (!partners.length) return [current.annotation_id, absorbed];
      const group = [current, ...partners];
      const order = new Map([...items.keys()].map((k, i) => [k, i]));
      const survivor = group.reduce((m, a) => (order.get(a.annotation_id) < order.get(m.annotation_id) ? a : m));
      const start = Math.min(...group.map((a) => a.onset_sample));
      const stop = Math.max(...group.map(endSample));
      const byAge = [...group].sort((x, y) => order.get(x.annotation_id) - order.get(y.annotation_id));
      current = this._check(freeze({ ...survivor, onset_sample: start, duration_samples: stop - start, modified_at: nowLocalIso(),
        confidence: lowerConfidence(byAge.map((x) => x.confidence)), note: joinNotes(byAge.map((x) => x.note)) }));
      const gone = new Set(group.map((a) => a.annotation_id));
      gone.delete(survivor.annotation_id);
      const kept = new Map();
      for (const [k, v] of items) if (!gone.has(k)) kept.set(k, k === survivor.annotation_id ? current : v);
      items.clear();
      for (const [k, v] of kept) items.set(k, v);
      absorbed += partners.length;
    }
  }

  _commit(action, description, newItems, ids) {
    this.lastAutoMerged = 0;
    this.lastSurvivors = new Map(ids.map((i) => [i, i]));
    if (this.autoMerge && ['add', 'update', 'merge'].includes(action)) {
      newItems = new Map(newItems);
      for (const id of ids) {
        const live = this.lastSurvivors.get(id);
        if (!newItems.has(live)) continue;
        const [survivor, n] = this._absorb(newItems, live);
        this.lastAutoMerged += n;
        for (const [k, v] of this.lastSurvivors) if (!newItems.has(v)) this.lastSurvivors.set(k, survivor);
      }
      if (this.lastAutoMerged) {
        description += ` (merged with ${this.lastAutoMerged} overlapping annotation(s) of the same type)`;
        ids = [...new Set(this.lastSurvivors.values())];
      }
    }
    this._undo.push([description, this.snapshot()]);
    if (this._undo.length > this.maxHistory) this._undo.shift();
    this._redo = [];
    this._items = newItems;
    this._notify({ action, description, ids: [...ids] });
  }

  undo() {
    if (!this._undo.length) return null;
    const [description, previous] = this._undo.pop();
    this._redo.push([description, this.snapshot()]);
    this._items = new Map(previous.map((a) => [a.annotation_id, a]));
    this._notify({ action: 'undo', description: `Undo ${description}`, ids: [] });
    return description;
  }

  redo() {
    if (!this._redo.length) return null;
    const [description, following] = this._redo.pop();
    this._undo.push([description, this.snapshot()]);
    this._items = new Map(following.map((a) => [a.annotation_id, a]));
    this._notify({ action: 'redo', description: `Redo ${description}`, ids: [] });
    return description;
  }

  /** Replace everything (a restored draft); clears the history. */
  reset(annotations) {
    const items = new Map();
    for (const a of annotations) {
      const ann = this._check(freeze({ ...a, channels: this.normaliseChannels(a.channels || []) }));
      items.set(ann.annotation_id, ann);
    }
    this._items = items;
    this._undo = [];
    this._redo = [];
    this._notify({ action: 'reset', description: 'restore', ids: [] });
  }

  // ----------------------------------------------------------------- editing
  /** Add an annotation; its confidence is the store's default unless `confidence` is given. */
  add(label, onsetSample, durationSamples, channels = [], annotationId = null, { confidence = null, note = '' } = {}) {
    const stamp = nowLocalIso();
    const ann = this._check(freeze({
      annotation_id: annotationId || newId(), label, onset_sample: Math.round(onsetSample),
      duration_samples: Math.round(durationSamples), channels: this.normaliseChannels(channels),
      created_at: stamp, modified_at: stamp, confidence: confidence ?? this.defaultConfidence, note,
    }));
    if (this._items.has(ann.annotation_id)) throw new AnnotationError(`Duplicate annotation id ${ann.annotation_id}`);
    const items = new Map(this._items);
    items.set(ann.annotation_id, ann);
    this._commit('add', `add ${label}`, items, [ann.annotation_id]);
    return this._items.get(this.lastSurvivors.get(ann.annotation_id));
  }

  addInterval(label, tStart, tStop, channels = []) {
    const [on, dur] = this.snapInterval(tStart, tStop);
    return this.add(label, on, dur, channels);
  }

  /** Change an annotation (a field left out stays as it is; a confidence or note of '' removes it). */
  update(id, { label, onset_sample, duration_samples, channels, confidence, note, description } = {}) {
    const current = this.get(id);
    const changes = {};
    if (label != null && label !== current.label) changes.label = label;
    if (onset_sample != null && Math.round(onset_sample) !== current.onset_sample) changes.onset_sample = Math.round(onset_sample);
    if (duration_samples != null && Math.round(duration_samples) !== current.duration_samples) {
      changes.duration_samples = Math.round(duration_samples);
    }
    if (channels != null) {
      const nc = this.normaliseChannels(channels);
      if (nc.length !== current.channels.length || nc.some((c, i) => c !== current.channels[i])) changes.channels = nc;
    }
    if (confidence != null && confidence !== (current.confidence || '')) changes.confidence = confidence;
    if (note != null) {
      const problem = noteProblem(note);
      if (problem) throw new AnnotationError(problem);
      if (cleanNote(note) !== (current.note || '')) changes.note = cleanNote(note);
    }
    const keys = Object.keys(changes);
    if (!keys.length) return current;
    const updated = this._check(freeze({ ...current, ...changes, modified_at: nowLocalIso() }));
    const items = new Map(this._items);
    items.set(id, updated);
    this._commit('update', description || 'edit ' + keys.sort().join(', '), items, [id]);
    return this._items.get(this.lastSurvivors.get(id));
  }

  setInterval(id, tStart, tStop) {
    const [on, dur] = this.snapInterval(tStart, tStop);
    return this.update(id, { onset_sample: on, duration_samples: dur, description: 'move/resize' });
  }

  setSamples(id, start, stop, description = 'move/resize') {
    const [on, dur] = this.snapSamples(start, stop);
    return this.update(id, { onset_sample: on, duration_samples: dur, description });
  }

  setLabel(id, label) {
    return this.update(id, { label, description: `relabel as ${label}` });
  }

  /** Relabel several annotations as one undoable step. */
  setLabelMany(ids, label) {
    const unique = [...new Set(ids)];
    const items = new Map(this._items);
    const changed = [];
    const stamp = nowLocalIso();
    for (const id of unique) {
      const current = this.get(id);
      if (current.label !== label) {
        items.set(id, this._check(freeze({ ...current, label, modified_at: stamp })));
        changed.push(id);
      }
    }
    if (changed.length) {
      const what = changed.length === 1 ? `relabel as ${label}` : `relabel ${changed.length} annotations as ${label}`;
      this._commit('update', what, items, changed);
    }
  }

  /** Give an annotation a confidence, or remove it with ''. */
  setConfidence(id, confidence) {
    return this.update(id, { confidence: confidence || '', description: confidenceDescription(confidence) });
  }

  /** Give several annotations one confidence as one undoable step. */
  setConfidenceMany(ids, confidence) {
    const level = confidence || '';
    const items = new Map(this._items);
    const changed = [];
    const stamp = nowLocalIso();
    for (const id of [...new Set(ids)]) {
      const current = this.get(id);
      if ((current.confidence || '') !== level) {
        items.set(id, this._check(freeze({ ...current, confidence: level, modified_at: stamp })));
        changed.push(id);
      }
    }
    if (changed.length) {
      const what = confidenceDescription(level);
      this._commit('update', changed.length === 1 ? what : `${what} (${changed.length} annotations)`, items, changed);
    }
  }

  /** Add, change or (with '') remove an annotation's note. */
  setNote(id, note) {
    const current = this.get(id);
    const text = cleanNote(note);
    const what = !text ? 'remove note' : current.note ? 'change note' : 'add note';
    return this.update(id, { note: text, description: what });
  }

  setChannels(id, channels) {
    return this.update(id, { channels: [...channels], description: 'change channels' });
  }

  toggleChannel(id, ch) {
    const current = this.get(id);
    if (!this._chIndex.has(ch)) throw new AnnotationError(`Unknown channel ${ch}`);
    const chans = new Set(current.channels);
    if (chans.has(ch)) chans.delete(ch); else chans.add(ch);
    return this.update(id, { channels: [...chans], description: `toggle channel ${ch}` });
  }

  delete(id) { this.deleteMany([id]); }

  deleteMany(ids) {
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    unique.forEach((id) => this.get(id));
    const items = new Map([...this._items].filter(([k]) => !unique.includes(k)));
    this._commit('delete', unique.length === 1 ? 'delete annotation' : `delete ${unique.length} annotations`, items, unique);
  }

  /** Explicitly merge annotations that share a label into one interval (only when asked). */
  merge(ids) {
    const unique = [...new Set(ids)];
    if (unique.length < 2) throw new AnnotationError('Select at least two annotations to merge');
    const anns = unique.map((id) => this.get(id));
    if (new Set(anns.map((a) => a.label)).size !== 1) throw new AnnotationError('Only annotations with the same label can be merged');
    const start = Math.min(...anns.map((a) => a.onset_sample));
    const stop = Math.max(...anns.map(endSample));
    const channels = anns.some(isGlobal) ? [] : this.normaliseChannels(anns.flatMap((a) => a.channels));
    const stamp = nowLocalIso();
    const order = new Map([...this._items.keys()].map((k, i) => [k, i])); // the oldest first
    const byAge = [...anns].sort((x, y) => order.get(x.annotation_id) - order.get(y.annotation_id));
    const merged = this._check(freeze({
      annotation_id: newId(), label: anns[0].label, onset_sample: start, duration_samples: stop - start,
      channels, created_at: stamp, modified_at: stamp,
      confidence: lowerConfidence(anns.map((a) => a.confidence)), note: joinNotes(byAge.map((a) => a.note)),
    }));
    const items = new Map([...this._items].filter(([k]) => !unique.includes(k)));
    items.set(merged.annotation_id, merged);
    this._commit('merge', `merge ${unique.length} ${merged.label} annotations`, items, [merged.annotation_id]);
    return this._items.get(this.lastSurvivors.get(merged.annotation_id));
  }

  /** As sent to the server (Annotation in docs/web/api.md). */
  toJSON() {
    return this.annotations().map((a) => ({ ...a, channels: [...a.channels] }));
  }
}

/** How a change of confidence is described in the undo history (as in store.py). */
export function confidenceDescription(confidence) {
  return confidence ? `set confidence ${confidence}` : 'remove confidence';
}
