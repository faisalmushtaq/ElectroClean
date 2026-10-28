// One recording being annotated: the recording, the study's manifest for it, the annotation store,
// the time spent, and the drafts of unsaved work (in this browser and on the server).

import { AnnotationStore } from './store.js';
import { local, newId, nowLocalIso } from '../util.js';
import { DEFAULT_HIDE, DEFAULT_SCALINGS } from '../api/demo_catalogue.js';

const REMOTE_EVERY_MS = 30000;

function hiddenByDefault(name) {
  return DEFAULT_HIDE.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

/** The channels to show, in display order: the manifest's montage, or (try-out) the file's own. */
export function displayChannels(recording, manifest) {
  const byName = new Map(recording.channels.map((c, i) => [c.name, { ...c, index: i }]));
  if (manifest) {
    const bad = new Set(manifest.bad_channels || []);
    const types = manifest.channel_types || {};
    const missing = manifest.ch_names.filter((n) => !byName.has(n));
    if (missing.length) throw new Error(`The file does not have the channel(s) ${missing.slice(0, 5).join(', ')} that the study expects.`);
    return manifest.ch_names.map((n) => {
      const c = byName.get(n);
      return { name: n, index: c.index, type: types[n] || c.type || 'eeg', bad: bad.has(n) };
    });
  }
  return recording.channels.map((c, i) => ({ name: c.name, index: i, type: c.type || 'eeg', bad: false }))
    .filter((c) => c.type !== 'stim' && !hiddenByDefault(c.name));
}

export class AnnotationSession {
  /**
   * @param {object} o backend, recording, manifest (null in try-out), recordingId, mode, contextId,
   *   me (GET /me), catalogue (Catalogue), match (POST /match answer), sha256, readOnly
   */
  constructor(o) {
    this.backend = o.backend;
    this.recording = o.recording;
    this.manifest = o.manifest || null;
    this.recordingId = o.recordingId || o.recording.fileName;
    this.mode = o.mode || 'standard';
    this.contextId = o.contextId || '';
    this.me = o.me;
    this.catalogue = o.catalogue;
    this.sha256 = o.sha256 || '';
    this.readOnly = Boolean(o.readOnly);
    this.tryOut = this.mode === 'tryout';
    this.sessionId = newId();
    this.channels = displayChannels(this.recording, this.manifest);
    const study = (o.me && o.me.study) || {};
    this.minDuration = (study.annotation && study.annotation.min_duration_samples) || 1;
    this.quickLabels = this.catalogue.quickLabels(study.annotation && study.annotation.quick_labels);
    this.store = new AnnotationStore({
      chNames: this.channels.map((c) => c.name), nSamples: this.recording.nSamples, sfreq: this.recording.sfreq,
      labels: this.catalogue.labelNames, minDurationSamples: this.minDuration,
    });
    this.scalings = { ...DEFAULT_SCALINGS, ...((this.manifest && this.manifest.display && this.manifest.display.scalings) || {}) };
    this.events = this.manifest ? this.manifest.original_events || []
      : this.recording.markers.map((m) => ({ onset_sample: m.onsetSample, duration_samples: m.durationSamples, label: m.description }));
    this.gaps = (this.manifest ? this.manifest.gaps : this.recording.gaps) || [];
    this.warnings = [...new Set([...(this.recording.warnings || []), ...((this.manifest && this.manifest.display && this.manifest.display.warnings) || [])])];
    this.startedAt = nowLocalIso();
    this.elapsedBase = 0;
    this.openedAt = performance.now();
    this.view = null;
    this.filters = null;
    this.finished = false;
    this.resumed = false;
    this.restored = 0;
    this._dirty = false;
    this._lastRemote = performance.now();
    this._remoteBusy = false;
    this.store.addListener(() => { this._dirty = true; this._scheduleLocal(); });
  }

  get elapsedS() { return this.elapsedBase + (performance.now() - this.openedAt) / 1000; }

  get localKey() {
    const who = (this.me && this.me.annotator_id) || 'anon';
    const where = this.backend.server || this.backend.kind;
    return `electroclean.draft|${where}|${who}|${this.recordingId}|${this.mode}|${this.contextId}`;
  }

  get canSave() { return !this.readOnly && !this.tryOut && !this.finished; }

  // ----------------------------------------------------------------- drafts
  draftPayload() {
    return {
      annotations: this.store.toJSON(),
      view: this.view ? { ...this.view } : null,
      elapsed_s: Math.round(this.elapsedS * 10) / 10,
      saved_at: nowLocalIso(),
    };
  }

  /** The unfinished work to offer: the newer of the server's draft and this browser's copy. */
  pickDraft(remote) {
    const mine = local.get(this.localKey, null);
    const candidates = [remote, mine].filter((d) => d && Array.isArray(d.annotations));
    if (!candidates.length) return null;
    candidates.sort((a, b) => String(b.saved_at || '').localeCompare(String(a.saved_at || '')));
    const d = candidates[0];
    return d.annotations.length || (d.elapsed_s || 0) > 5 ? d : null;
  }

  restore(draft) {
    const ok = draft.annotations.filter((a) => this.catalogue.has(a.label));
    this.store.reset(ok);
    this.elapsedBase = Number(draft.elapsed_s) || 0;
    this.openedAt = performance.now();
    this.resumed = true;
    this.restored = ok.length;
    this._dirty = false;
    return draft.view || null;
  }

  _scheduleLocal() {
    if (!this.canSave) return;
    clearTimeout(this._localTimer);
    this._localTimer = setTimeout(() => this.saveLocal(), 1200);
  }

  saveLocal() {
    if (!this.canSave) return;
    local.set(this.localKey, this.draftPayload());
  }

  forgetLocal() {
    clearTimeout(this._localTimer);
    local.remove(this.localKey);
  }

  /** Send the draft to the server when something changed (at most every 30 s unless forced). */
  async saveRemote({ force = false, keepalive = false } = {}) {
    if (!this.canSave || this._remoteBusy) return false;
    if (!force && (!this._dirty || performance.now() - this._lastRemote < REMOTE_EVERY_MS)) return false;
    this._remoteBusy = true;
    const payload = this.draftPayload();
    try {
      await this.backend.putDraft(this.recordingId, this.mode, this.contextId, payload, { keepalive });
      this._dirty = false;
      this._lastRemote = performance.now();
      return true;
    } catch {
      return false;
    } finally {
      this._remoteBusy = false;
    }
  }

  async discardDrafts() {
    this.forgetLocal();
    if (this.tryOut) return;
    try { await this.backend.deleteDraft(this.recordingId, this.mode, this.contextId); } catch { /* nothing to delete */ }
  }

  // ----------------------------------------------------------------- saving
  sessionInfo(visitId) {
    const f = this.filters || {};
    return {
      started_at: this.startedAt,
      elapsed_s: Math.round(this.elapsedS * 1000) / 1000,
      visit_id: visitId || '',
      filters: { highpass_hz: f.highpassHz || null, notch_hz: f.notchHz || null, notch_harmonics: Boolean(f.notchHarmonics), method: 'fir' },
      view: this.view ? { ...this.view } : null,
      client: {
        user_agent: navigator.userAgent,
        screen: { width: screen.width, height: screen.height, pixel_ratio: window.devicePixelRatio || 1 },
        window: { width: window.innerWidth, height: window.innerHeight },
      },
    };
  }

  async submit(visitId) {
    const result = await this.backend.submit({
      recording_id: this.recordingId, mode: this.mode, context_id: this.contextId,
      annotations: this.store.toJSON(), session: this.sessionInfo(visitId), sha256: this.sha256,
    });
    this.finished = true;
    this.forgetLocal();
    return result;
  }

  countsByLabel() {
    const counts = new Map();
    for (const a of this.store.annotations()) counts.set(a.label, (counts.get(a.label) || 0) + 1);
    return counts;
  }
}
