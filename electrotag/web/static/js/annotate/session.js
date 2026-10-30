// One recording being annotated: the recording, the study's manifest for it, the annotation store,
// the time worked (a clock that stops while the annotator is paused, clock.js), the parts of the
// recording that have been on screen, and the drafts of unsaved work (in this browser and on the
// server).

import { AnnotationStore } from './store.js';
import { WorkClock } from './clock.js';
import { confidenceMode } from './confidence.js';
import { addInterval, fromDraft, toDraft, viewedFraction as coverageFraction } from '../viewer/coverage.js';
import { local, newId, nowLocalIso, session as tabStorage } from '../util.js';
import { DEFAULT_ANNOTATION, DEFAULT_HIDE, DEFAULT_SCALINGS } from '../api/demo_catalogue.js';
import { localDraft, localDraftKey } from './local_drafts.js';

export { localDraft, localDraftKey };

const REMOTE_EVERY_MS = 30000;
/** After a draft that did not reach the study, the next try comes this much later (or at once when the connection returns). */
const RETRY_MS = 5000;
/** A discard or Save and Finish waits at most this long for a draft still on its way to the study. */
const SETTLE_MS = 15000;

function hiddenByDefault(name) {
  return DEFAULT_HIDE.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

// Work discarded in this tab (Start afresh, Discard and close, Start again from the saved version, Leave
// without changes) is set aside until the tab is closed, so that it can be brought back: in the tab's
// sessionStorage, or in memory where that cannot be written.
const DISCARDED = 'electrotag.discarded|';
const discardedInMemory = new Map();

/** The work set aside under a draft's key in this tab, or null. */
export function discardedWork(key) {
  const d = tabStorage.get(DISCARDED + key, null) || discardedInMemory.get(key) || null;
  return d && Array.isArray(d.annotations) ? d : null;
}

function keepDiscarded(key, draft) {
  const d = { ...draft, discarded_at: nowLocalIso() };
  tabStorage.set(DISCARDED + key, d); // survives a reload of the tab
  discardedInMemory.set(key, d); // and where the tab's storage is blocked
}

function forgetDiscarded(key) {
  tabStorage.remove(DISCARDED + key);
  discardedInMemory.delete(key);
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
    if (missing.length) throw new Error(`The file does not have the ${missing.length === 1 ? 'channel' : 'channels'} ${missing.slice(0, 5).join(', ')} that the study expects.`);
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
    // annotation.confidence: 'optional' (a rating when the annotator wishes) or 'every_mark' (asked after each mark).
    this.confidenceMode = confidenceMode(study.annotation && study.annotation.confidence);
    this.store = new AnnotationStore({
      chNames: this.channels.map((c) => c.name), nSamples: this.recording.nSamples, sfreq: this.recording.sfreq,
      labels: this.catalogue.labelNames, minDurationSamples: this.minDuration,
      // annotation.merge_overlapping: overlapping marks of one type on the same channels join (marks apart never do)
      autoMerge: !(study.annotation && study.annotation.merge_overlapping === false),
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
    this.onSaved = null; // (where: 'browser' | 'study' | 'study_failed', at: Date) after a draft is kept, or not received by the study
    this.view = null;
    this.filters = null;
    this.finished = false;
    this.resumed = false;
    this.restored = 0;
    this._dirty = false;
    this._lastRemote = performance.now();
    this._remotePut = null; // the draft on its way to the study, if any
    this._discarding = false; // the drafts are being deleted: nothing is written meanwhile
    this.closed = false; // the view has closed, or its work was discarded: no draft is written for it again
    this.remoteFailing = false; // the last draft sent did not reach the study
    this.submitting = false; // Save and Finish is waiting for the study's answer: no draft is sent meanwhile
    // A revision opens with the annotations of the latest saved version (docs/web/using.md, "History and revisions").
    this.revision = o.revision && Number.isInteger(o.revision.revises) ? { ...o.revision } : null;
    if (this.revision) {
      this.store.reset((this.revision.annotations || []).filter((a) => this.catalogue.has(a.label)), this._knownBad(this.revision.bad_channels));
      this.savedVersion = this._versionText();
    }
    this.store.addListener(() => { this._dirty = true; this._scheduleLocal(); });
  }

  /** True when the annotations differ from the version being revised. */
  get changedSinceSaved() { return Boolean(this.revision) && this._versionText() !== this.savedVersion; }

  /** The annotations and the channels marked bad, as text to compare. */
  _versionText() { return JSON.stringify([this.store.toJSON(), this.store.badChannels]); }

  /** Of a list of channel names (from a draft or a saved version), those shown, as the store takes them. */
  _knownBad(list) {
    const shown = new Set(this.channels.map((c) => c.name));
    return Array.isArray(list) ? list.filter((n) => typeof n === 'string' && shown.has(n)) : [];
  }

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
      bad_channels: this.store.badChannels,
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
    this.store.reset(ok, this._knownBad(draft.bad_channels));
    this.elapsedBase = Number(draft.elapsed_s) || 0;
    this.clock = null;
    this.viewed = fromDraft(draft.viewed, this.recording.durationS);
    this.resumed = true;
    this.restored = ok.length;
    this._dirty = false;
    return draft.view || null;
  }

  /** Drafts may be written: never once the session has closed, nor while its drafts are deleted. */
  get mayKeepDraft() { return this.canSave && !this.closed && !this._discarding; }

  _scheduleLocal() {
    if (!this.mayKeepDraft) return;
    clearTimeout(this._localTimer);
    this._localTimer = setTimeout(() => this.saveLocal(), 1200);
  }

  saveLocal() {
    clearTimeout(this._localTimer); // this save replaces one waiting
    if (!this.mayKeepDraft || this.submitting) return;
    if (local.set(this.localKey, this.draftPayload()) && this.onSaved) this.onSaved('browser', new Date());
  }

  forgetLocal() {
    clearTimeout(this._localTimer);
    local.remove(this.localKey);
  }

  /** Send the draft to the server when something changed (at most every 30 s unless forced). */
  async saveRemote({ force = false, keepalive = false } = {}) {
    // While Save and Finish waits for its answer, a draft that arrived after it would linger beside the saved result.
    if (!this.mayKeepDraft || this.submitting) return false;
    if (this._remotePut) {
      // One draft at a time, so that they reach the study in order: a forced one goes once the one before has arrived.
      if (!force) return false;
      await this._settleRemote();
      if (!this.mayKeepDraft || this.submitting || this._remotePut) return false;
    }
    if (!force && (!this._dirty || performance.now() - this._lastRemote < REMOTE_EVERY_MS)) return false;
    // The session's id goes with the draft: once its work is discarded and closed, the study refuses a draft
    // of it that arrives late (409 draft_discarded), instead of keeping it again.
    const payload = { ...this.draftPayload(), session_id: this.sessionId };
    const put = this.backend.putDraft(this.recordingId, this.mode, this.contextId, payload, { keepalive });
    this._remotePut = put;
    try {
      await put;
      this._dirty = false;
      this._lastRemote = performance.now();
      this.remoteFailing = false;
      if (this.onSaved) this.onSaved('study', new Date());
      return true;
    } catch (exc) {
      if (exc && exc.code === 'draft_discarded') return false; // this work was discarded: nothing to send again
      // The study did not get it (no connection, or it failed once): the browser's copy is kept, and the
      // draft goes again with the next change, the next tick after 30 s, or when the connection returns.
      // A draft replaces the one before, so sending it again is harmless.
      this._lastRemote = performance.now() - REMOTE_EVERY_MS + RETRY_MS;
      this.remoteFailing = true;
      if (this.onSaved) this.onSaved('study_failed', new Date());
      return false;
    } finally {
      if (this._remotePut === put) this._remotePut = null;
    }
  }

  /** Wait for a draft on its way to the study (at most SETTLE_MS: a later one is refused by the study, see saveRemote). */
  async _settleRemote() {
    const put = this._remotePut;
    if (!put) return;
    let timer;
    await Promise.race([put.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, SETTLE_MS); })]);
    clearTimeout(timer);
  }

  /** The view of this session has closed: no draft is written for it any more, in this browser or with the study. */
  close() {
    this.closed = true;
    clearTimeout(this._localTimer);
  }

  /**
   * Delete the drafts in this browser and with the study. The work they held (`draft`, the one offered
   * to restore, or else what is open now) is set aside in this tab first, so that it can be brought back
   * (bringBackDiscarded); nothing is set aside when there was nothing to lose.
   */
  async discardDrafts({ draft = null, close = false } = {}) {
    if (this.tryOut) return;
    const work = draft || this.draftPayload();
    const worth = draft ? draft.annotations.length || (draft.elapsed_s || 0) > 5
      : this.revision ? this.changedSinceSaved : this.store.size > 0 || this.store.badChannels.length > 0;
    if (close) this.close();
    // No draft may be written once it is deleted: nothing new starts, and one already on its way arrives first.
    this._discarding = true;
    clearTimeout(this._localTimer);
    try {
      if (worth) keepDiscarded(this.localKey, work);
      await this._settleRemote();
      local.remove(this.localKey);
      // Closing: the study also refuses any draft of this session that might still arrive.
      try { await this.backend.deleteDraft(this.recordingId, this.mode, this.contextId, close ? { sessionId: this.sessionId } : {}); } catch { /* nothing to delete */ }
    } finally {
      this._discarding = false;
    }
  }

  /** The work set aside in this tab for this recording (discardDrafts), or null. */
  get discarded() { return this.tryOut || !this.canSave ? null : discardedWork(this.localKey); }

  /**
   * Bring back the work set aside: its annotations replace those open now as one step that Undo takes
   * back, and its time worked and the parts it had viewed are added to this session's.
   */
  bringBackDiscarded() {
    const d = this.discarded;
    if (!d) return null;
    const ok = d.annotations.filter((a) => this.catalogue.has(a.label));
    this.store.replaceAll(ok, 'bring back the work set aside', this._knownBad(d.bad_channels));
    const extra = Number(d.elapsed_s) || 0;
    if (this.clock) this.clock.baseS += extra; else this.elapsedBase += extra;
    const before = fromDraft(d.viewed, this.recording.durationS);
    let viewed = this.viewed;
    for (const [a, b] of before) viewed = addInterval(viewed, a, b, this.recording.durationS);
    this.noteViewed(viewed);
    forgetDiscarded(this.localKey);
    this.saveLocal();
    return { n: ok.length, elapsedS: extra };
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
    if (this.submitting) throw new Error('This recording is being saved already.');
    this.submitting = true;
    let result;
    try {
      await this._settleRemote(); // a draft on its way arrives before the saved result, never after it
      result = await this.backend.submit({
        recording_id: this.recordingId, mode: this.mode, context_id: this.contextId,
        // the session's ID goes with it, so that the saved files and the interaction log of this session carry the same ID
        annotations: this.store.toJSON(), bad_channels: this.store.badChannels,
        session: { ...this.sessionInfo(visitId), session_id: this.sessionId }, sha256: this.sha256,
        ...(this.revision ? { revises: this.revision.revises } : {}),
      });
    } finally {
      this.submitting = false;
    }
    this.finished = true;
    this.forgetLocal();
    forgetDiscarded(this.localKey); // saved: nothing set aside is offered for it again
    return result;
  }

  countsByLabel() {
    const counts = new Map();
    for (const a of this.store.annotations()) counts.set(a.label, (counts.get(a.label) || 0) + 1);
    return counts;
  }
}
