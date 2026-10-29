// One recording being annotated: the recording, the study's manifest for it, the annotation store,
// the time worked (a clock that stops while the annotator is paused, clock.js), the parts of the
// recording that have been on screen, and the drafts of unsaved work (in this browser and on the
// server).

import { AnnotationStore } from './store.js';
import { WorkClock } from './clock.js';
import { fromDraft, toDraft, viewedFraction as coverageFraction } from '../viewer/coverage.js';
import { local, newId, nowLocalIso } from '../util.js';
import { DEFAULT_ANNOTATION, DEFAULT_HIDE, DEFAULT_SCALINGS } from '../api/demo_catalogue.js';

const REMOTE_EVERY_MS = 30000;

function hiddenByDefault(name) {
  return DEFAULT_HIDE.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

/** The key of this browser's copy of a draft (also read by the home view, for what it shows of unfinished work). */
export function localDraftKey(backend, annotatorId, recordingId, mode, contextId) {
  const where = backend.server || backend.kind;
  return `electroclean.draft|${where}|${annotatorId || 'anon'}|${recordingId}|${mode}|${contextId || ''}`;
}

/** This browser's copy of a draft, or null. */
export function localDraft(backend, annotatorId, recordingId, mode, contextId) {
  const d = local.get(localDraftKey(backend, annotatorId, recordingId, mode, contextId), null);
  return d && Array.isArray(d.annotations) ? d : null;
}

/** The study's comfort settings (the annotation block of GET /me), with the defaults for any left out. */
export function comfortSettings(study) {
  const a = (study && study.annotation) || {};
  const num = (v, d, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= hi ? v : d);
  return {
    breakReminderMinutes: num(a.break_reminder_minutes, DEFAULT_ANNOTATION.break_reminder_minutes, 240),
    idlePauseMinutes: num(a.idle_pause_minutes, DEFAULT_ANNOTATION.idle_pause_minutes, 60),
    coverageCheck: a.coverage_check === 'off' ? 'off' : 'warn',
  };
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
   *   me (GET /me), catalogue (Catalogue), match (POST /match answer), sha256, readOnly, and for a
   *   revision of a finished recording `revision` ({version, revises, saved_at, annotations} of POST /match)
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
    this.comfort = comfortSettings(study);
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
    this.clock = null; // started when the recording is on screen (startClock)
    this.viewed = []; // merged [start_s, end_s] on screen so far (coverage.js)
    this.onSaved = null; // (where: 'browser' | 'study', at: Date) after a draft is kept
    this.view = null;
    this.filters = null;
    this.finished = false;
    this.resumed = false;
    this.restored = 0;
    this._dirty = false;
    this._lastRemote = performance.now();
    this._remoteBusy = false;
    // A revision opens with the annotations of the latest saved version (docs/web/using.md, "History and revisions").
    this.revision = o.revision && Number.isInteger(o.revision.revises) ? { ...o.revision } : null;
    if (this.revision) {
      this.store.reset((this.revision.annotations || []).filter((a) => this.catalogue.has(a.label)));
      this.savedVersion = JSON.stringify(this.store.toJSON());
    }
    this.store.addListener(() => { this._dirty = true; this._scheduleLocal(); });
  }

  /** True when the annotations differ from the version being revised. */
  get changedSinceSaved() { return Boolean(this.revision) && JSON.stringify(this.store.toJSON()) !== this.savedVersion; }

  /** Seconds worked on the recording, earlier sessions included and pauses left out. */
  get elapsedS() { return this.clock ? this.clock.elapsedS : this.elapsedBase; }

  /** Start the working-time clock (the recording is on screen); `sinceBreakS` carries the work since the last break. */
  startClock({ sinceBreakS = 0, now } = {}) {
    if (!this.clock) this.clock = new WorkClock({ baseS: this.elapsedBase, sinceBreakS, ...(now ? { now } : {}) });
    return this.clock;
  }

  get localKey() {
    // A revision's copy is kept apart, so that it is never confused with older unfinished work.
    const rev = this.revision ? `|revises-${this.revision.revises}` : '';
    return localDraftKey(this.backend, this.me && this.me.annotator_id, this.recordingId, this.mode, this.contextId) + rev;
  }

  /** The parts on screen so far changed (a merged list): kept in the drafts like a change of annotations. */
  noteViewed(list) {
    this.viewed = list;
    this._dirty = true;
    this._scheduleLocal();
  }

  get canSave() { return !this.readOnly && !this.tryOut && !this.finished; }

  // ----------------------------------------------------------------- drafts
  draftPayload() {
    return {
      annotations: this.store.toJSON(),
      view: this.view ? { ...this.view } : null,
      elapsed_s: Math.round(this.elapsedS * 10) / 10,
      viewed: toDraft(this.viewed),
      saved_at: nowLocalIso(),
      ...(this.revision ? { revises: this.revision.revises } : {}),
    };
  }

  /** The unfinished work to offer: the newer of the server's draft and this browser's copy. */
  pickDraft(remote) {
    const mine = local.get(this.localKey, null);
    const rev = this.revision ? this.revision.revises : undefined;
    const candidates = [remote, mine].filter((d) => d && Array.isArray(d.annotations) && (rev === undefined || d.revises === rev));
    if (!candidates.length) return null;
    candidates.sort((a, b) => String(b.saved_at || '').localeCompare(String(a.saved_at || '')));
    const d = candidates[0];
    return d.annotations.length || (d.elapsed_s || 0) > 5 ? d : null;
  }

  restore(draft) {
    const ok = draft.annotations.filter((a) => this.catalogue.has(a.label));
    this.store.reset(ok);
    this.elapsedBase = Number(draft.elapsed_s) || 0;
    this.clock = null;
    this.viewed = fromDraft(draft.viewed, this.recording.durationS);
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
    if (local.set(this.localKey, this.draftPayload()) && this.onSaved) this.onSaved('browser', new Date());
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
      if (this.onSaved) this.onSaved('study', new Date());
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
      ...(this.viewedFraction() !== null ? { viewed_fraction: this.viewedFraction() } : {}),
    };
  }

  /**
   * The share of the recording that has been on the screen (0 to 1), from the stretches viewed so far
   * (coverage.js, as the Recording tab shows it; stretches without data are left out); null in a try-out.
   * It is sent with the session and feeds the "viewed in full" milestones.
   */
  viewedFraction() {
    if (this.tryOut || !this.recording.durationS) return null;
    const sf = this.recording.sfreq;
    const noData = (this.gaps || []).map(([a, b]) => [a / sf, b / sf]);
    const f = coverageFraction(this.viewed, this.recording.durationS, noData);
    return Number.isFinite(f) ? Math.round(Math.min(1, Math.max(0, f)) * 10000) / 10000 : null;
  }

  async submit(visitId) {
    const result = await this.backend.submit({
      recording_id: this.recordingId, mode: this.mode, context_id: this.contextId,
      annotations: this.store.toJSON(), session: this.sessionInfo(visitId), sha256: this.sha256,
      ...(this.revision ? { revises: this.revision.revises } : {}),
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
