// The annotation view: the EEG viewer with the annotation tools around it (the type buttons and
// keys 1 to 9, the type menu and picker, Whole montage / Selected channels, M / [ / ] marks, N / P,
// undo and redo, the annotations list, the recording panel, the help and the status line), and
// Save and Finish. Every change goes through the annotation store (store.js); the behaviour and
// messages follow those of the former desktop application's annotation window.
//
// For long sessions it also has a Pause (the button or B; by itself after a while without input or
// with the page out of sight), during which the working-time clock (clock.js) stops and a calm panel
// covers the EEG; a gentle break reminder; a record of the parts of the recording that have been on
// screen (coverage.js), shown on the overview bar, with Next part not yet viewed (U) and a check
// before Save and Finish; a line that welcomes the annotator back to a restored draft; the time the
// draft was last kept; and each annotator's display comfort (ui/comfort.js).
//
// Each annotation may carry a confidence rating on a 5-point scale (D then a digit, the menu or the
// Annotations table; in an every-mark study the prompt opens after each new mark) and a short note
// (confidence.js); the functions for them are together under "confidence and notes".
//
// A task may give the annotator only part of a recording (its window): the rest is hatched, the view
// stays inside the part, marks outside it are refused, and coverage counts the part only ("a task's
// part of the recording" below).

import { h, clear } from '../ui/dom.js';
import { showDialog, ask, inform, choose, dialogOpen } from '../ui/dialog.js';
import { showMenu, closeMenu } from '../ui/menu.js';
import { EegViewer } from '../viewer/viewer.js';
import { pickType, chooseChannels, editTimes, editNote } from './dialogs.js';
import { CONFIDENCE_ANCHORS, CONFIDENCE_LEVELS, isConfidence } from './confidence.js';
import { AnnotationError, endSample } from './store.js';
import { helpHtml, KEY_HINT, REVIEW_HINT, TOUCH_HINT, TOUCH_REVIEW_HINT, TOUCH_VIEW_HINT } from './help.js';
import { edgeHalfWidthS } from '../eeg/synthetic.js';
import { logger, keyName } from '../log/logger.js';
import { annotationEvents, snapshotEvents } from '../log/annotation_events.js';
import { channelsText, clamp, formatHms, friendlyDuration, local, plural, readableTextColour, UNDO_HINT, CTRL, debounce, touchFirst } from '../util.js';
import { isTyping } from '../ui/dom.js';
import { displayCode } from '../catalogue.js';
import { icon } from '../views/common.js';
import { CHANNEL_COLOUR_MODES, MODE_TEXT as COLOUR_MODE_TEXT, channelColours, legendOf, normaliseMode } from '../viewer/channel_colours.js';
import { BREAK_MIN_S, HIDDEN_PAUSE_MS, SNOOZE_S, idleDue, todayKey } from './clock.js';
import * as cov from '../viewer/coverage.js';
import { NAME_SIZES, PANEL_TEXT, TRACE_WIDTHS, loadComfort, saveComfort } from '../ui/comfort.js';
import { microvoltText } from '../viewer/geometry.js';
import { mapLayout, projectPositions } from '../viewer/head_map.js';
import { readElectrodes, sidecarsOf } from '../eeg/electrodes.js';
import { centredStart, clampTime, parseTimeText } from './goto.js';
import { CONTEXT_S, boundsOf, itemWindow, outsideStretches } from '../viewer/bounds.js';

export { friendlyDuration, plural };

const MODE_TEXT = { standard: 'Annotation', guided: 'Guided training', practice: 'Practice', assessment: 'Assessment', tryout: 'Try-out', review: 'Practice review',
  reviewing: 'Review', feedback: 'Feedback', correcting: 'Correction', replay: 'Replay', corrected: 'Corrected version' };
/**
 * Views that only show annotations (no toolbar): a practice review, an administrator's review pass, the feedback on saved work,
 * a replay of a session and an annotator's view of a correction of their work (js/expert/, js/replay/).
 */
const VIEW_ONLY_KINDS = ['review', 'reviewing', 'feedback', 'replay', 'corrected'];
/** Views of someone's work opened from the expert area or for its feedback, which their own part closes (opts.onLeave). */
const PART_KINDS = ['correcting', 'replay', 'corrected'];
const DRAG_PX = 3;
const DRAW_ON_TITLE = 'Draw/edit is on: drag across the EEG to mark artifacts and change annotations. Press it to switch to view only, where nothing can change.';
const DRAWING_OFF = 'View only: annotations cannot be drawn or changed. Press Draw/edit to mark artifacts.';
const DRAW_OFF_TITLE = 'View only: annotations cannot be drawn or changed. Press Draw/edit to mark artifacts again.';

/** Channel names for a message: "O1, O2 and P3", or the first few and how many more. */
function namesText(names, shown = 4) {
  if (names.length <= shown) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}

/** A mouse click on `b` leaves the keyboard focus where it was (the EEG); the keyboard still reaches it with Tab. */
function keepFocusOnClick(b) {
  b.addEventListener('mousedown', (e) => e.preventDefault());
  return b;
}

/** The undo hint for a message: the keys with a keyboard, the Undo button on a touch screen. */
const undoHint = () => (touchFirst() ? 'Undo at the top takes it back' : UNDO_HINT);

/** A time in the recording as a person reads it: "2:05" or "1:02:05". */
export function clockText(t) {
  const s = Math.max(0, Math.floor(t));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

const timeOfDay = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** A length of time in words, to the minute: "50 minutes", "1 hour 5 minutes" (seconds under a minute). */
export function minutesWords(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return m < 60 ? plural(m, 'minute') : `${plural(Math.floor(m / 60), 'hour')}${m % 60 ? ` ${plural(m % 60, 'minute')}` : ''}`;
}

export class Workspace {
  /**
   * @param {object} app the application (main.js): backend, me, visitId, say, navigation
   * @param {import('./session.js').AnnotationSession} session
   * @param {{kind?: 'annotate'|'tryout'|'review', position?: [number, number], onFinished?: Function}} opts
   */
  constructor(app, session, opts = {}) {
    this.app = app;
    this.s = session;
    this.kind = opts.kind || (session.tryOut ? 'tryout' : 'annotate');
    this.opts = opts;
    this.store = session.store;
    this.cat = session.catalogue;
    this.sf = session.recording.sfreq;
    this.readOnly = session.readOnly || this.kind === 'review';
    this.quick = session.quickLabels;
    this.currentLabel = this.quick[0] || this.cat.labelNames[0];
    this.scope = 'whole';
    this.selectedChannels = [];
    this.selection = [];
    this.drawing = !this.readOnly;
    this.markStart = null;
    this.pointerXY = null;
    this.gesture = null;
    this.listAnchor = null;
    this.coach = null;
    this.review = null;
    this.windowNo = (app.windowCount = (app.windowCount || 0) + 1);
    this._prev = new Map(this.store.annotations().map((a) => [a.annotation_id, a]));
    this._msgTimer = null;
    this._listeners = [];
    // Pauses, breaks and coverage belong to work that is saved: not to a try-out or a practice review.
    this.timed = this.kind === 'annotate' && session.canSave;
    this.settings = session.comfort;
    this.comfort = loadComfort(session.me && session.me.annotator_id);
    this.hiddenPauseMs = HIDDEN_PAUSE_MS;
    this._lastInput = performance.now();
    this._hiddenAt = null;
    this._breakShown = false;
    this._saved = { browser: null, study: null };
    this.lastMadeId = null; // the annotation made last, which D changes when nothing is selected
    this.bounds = this._taskBounds(); // a task's part of the recording, or null for all of it
    this._build();
  }

  /** The working-time clock (session.js), once the recording is on screen. */
  get clock() { return this.s.clock; }

  // ===================================================================== building
  _build() {
    const s = this.s;
    const study = (s.me && s.me.study) || {};
    const fl = study.filters || {};
    const saved = fl.locked ? null : local.get(`electrotag.filters|${study.study_id || ''}`, null);
    const f = saved || fl;
    s.filters = {
      highpassHz: f.highpass_enabled === false ? null : (f.highpass_hz || 1.0),
      notchHz: f.notch_enabled === false ? null : (f.notch_hz || 50.0),
      notchHarmonics: Boolean(f.notch_harmonics),
    };
    this.filtersLocked = Boolean(fl.locked);
    this.el = h('main.view.annotate', { 'data-view': 'annotate',
      class: s.revision && this.kind === 'annotate' ? 'revising' : VIEW_ONLY_KINDS.includes(this.kind) ? 'view-only' : null },
      this._header(), this._revisionBar(), VIEW_ONLY_KINDS.includes(this.kind) ? null : this._toolbar(),
      this.main = h('div.ws-main', {}, this.eegHost = h('div.ws-eeg'), this.side = h('aside.ws-side', { 'aria-label': 'Annotations and help' })),
      this._statusBar());
    this._sidePanel();
    if (this.timed) this.main.append(this._pausePanel());
    const display = study.display || {};
    const view = s.view || { duration_s: display.duration_s || 10, n_channels: display.n_channels || 32 };
    this.viewer = new EegViewer(this.eegHost, {
      recording: s.recording, channels: s.channels, scalings: s.scalings, events: s.events, gaps: s.gaps,
      catalogue: this.cat, filters: s.filters, view,
    });
    if (this.bounds) this._applyBounds();
    if (s.view) {
      this.viewer.setView({ startS: s.view.start_s || 0, durationS: s.view.duration_s || 10, firstChannel: s.view.first_channel || 0,
        nChannels: s.view.n_channels || 32, scaleFactor: s.view.scale_factor || 1 }, 'restore');
    }
    this._applyChannelColours();
    this._syncViewState();
    this._buildViewTools();
    this.viewer.onView = (v, cause) => {
      this._viewToolsOnView(cause);
      this._syncViewState(); this._logView();
      this._placeConfidenceBar();
      if (this.timed && !this._overviewView) this._noteViewDwell();
      if (cause !== 'restore') this._afterViewChange();
    };
    this.viewer.onPointer = (type, info, e) => this._pointer(type, info, e);
    // The EEG takes the keyboard in the Tab order too (with a focus ring), for those who annotate without a mouse.
    this.viewer.over.tabIndex = 0;
    this.viewer.over.setAttribute('aria-label', this.readOnly ? 'EEG. The arrow keys move through the recording.'
      : 'EEG. The arrow keys move through the recording; M, [ and ] mark at the pointer or the time cursor, which G and the , and . keys move.');
    this.viewer.setComfort(this.comfort);
    if (this.timed) {
      this.viewer.setCoverage(s.viewed);
      this.viewer.onNextUnviewed = (via) => { logger.noteInput(`button:Next part not yet viewed`); this.nextUnviewed(via); };
    }
    this.viewer.nextUnviewedGroup.hidden = !this.timed; // only where what has been viewed is kept track of
    this.viewer.setAnnotations(this.store.annotations());
    this._storeListener = (change) => this._onStore(change);
    this.store.addListener(this._storeListener);
    this._refreshAll();
  }

  _header() {
    const s = this.s;
    const title = h('div.ws-title', {},
      this.closeBtn = h('button.btn.quiet.back', { type: 'button', 'data-log': 'close', onclick: () => this.close() },
        icon('arrow-left'), this.kind === 'review' ? 'Training path' : this.kind === 'reviewing' || PART_KINDS.includes(this.kind) ? 'Back' : 'Close'),
      h('div.ws-name', {}, h('h1', { title: s.recordingId }, s.recording.fileName),
        h('span.chip', { class: this.kind === 'tryout' ? 'warning' : 'active' }, MODE_TEXT[this.kind === 'annotate' ? s.mode : this.kind] || s.mode),
        this.bounds ? h('span.chip.ws-part', { 'data-log': 'task-part', title: 'This task gives you this part of the recording: the rest is hatched and is not annotated.' },
          `Your part: ${this.bounds.text}`) : null),
      this.kind === 'tryout' ? h('span.ws-banner', {}, 'This file is not part of the study, so nothing you mark is saved.') : null);
    const actions = h('div.ws-actions');
    this.actionsEl = actions; // a review pass, the feedback view, a correction and a replay add their own forward action
    if (!this.readOnly) {
      this.drawBtn = h('button.btn.toggle', { type: 'button', 'aria-pressed': 'true', 'data-log': 'draw-edit', title: DRAW_ON_TITLE, onclick: () => this.setDrawing(!this.drawing) }, 'Draw/edit');
      this.deleteBtn = h('button.btn', { type: 'button', 'data-log': 'delete', onclick: () => this.deleteSelection() }, 'Delete');
      this.undoBtn = h('button.btn', { type: 'button', 'data-log': 'undo', onclick: () => this.undo() }, 'Undo');
      this.redoBtn = h('button.btn', { type: 'button', 'data-log': 'redo', onclick: () => this.redo() }, 'Redo');
      // A click leaves the keyboard focus with the EEG, so that Space or Enter afterwards does not press the button again.
      for (const b of [this.drawBtn, this.deleteBtn, this.undoBtn, this.redoBtn]) keepFocusOnClick(b);
      actions.append(this.drawBtn, this.deleteBtn, this.undoBtn, this.redoBtn, h('span.sep'));
    }
    if (this.timed) {
      this.savedEl = h('span.ws-saved', { 'data-saved': 'none' });
      this.pauseBtn = h('button.btn.pause-btn', { type: 'button', 'data-log': 'pause', 'aria-pressed': 'false',
        title: 'Stop the clock while you are away (B). Your draft is kept.', onclick: () => (this.clock && this.clock.paused ? this.resume('button') : this.pause('button')) },
      icon('pause'), h('span.pause-label', {}, 'Pause'));
      actions.append(this.savedEl, this.pauseBtn);
    }
    const helpBtn = keepFocusOnClick(h('button.btn.quiet', { type: 'button', title: 'Keys and mouse actions (?)', onclick: () => this.showHelp() }, 'Help'));
    actions.append(...[this._moreButton(), helpBtn].filter(Boolean));
    if (this.kind === 'annotate' && s.revision) {
      // A revision: its two actions are on the banner below (_revisionBar).
    } else if (this.kind === 'annotate') {
      this.saveBtn = h('button.btn.primary', { type: 'button', title: 'Validate and save your annotations, then mark this recording complete', onclick: () => this.saveAndFinish() }, 'Save and Finish');
      actions.append(this.saveBtn);
    } else if (this.kind === 'tryout') {
      actions.append(h('button.btn.primary', { type: 'button', onclick: () => this.downloadTryOut() }, 'Download my annotations'));
    } else if (this.kind === 'review') {
      actions.append(h('button.btn.primary', { type: 'button', onclick: () => this.close() }, 'Back to my training path'));
    }
    return h('header.ws-header', {}, title, actions);
  }

  /** The More menu of the header (an annotated study or training recording): Report a problem with this recording… */
  _moreButton() {
    if (this.kind !== 'annotate') return null;
    const b = h('button.btn.quiet.icon.ws-more', { type: 'button', 'aria-label': 'More', title: 'More: report a problem with this recording', 'aria-haspopup': 'menu', 'data-log': 'ws-more' }, icon('more'));
    b.addEventListener('click', () => {
      const r = b.getBoundingClientRect();
      showMenu([{ label: 'Report a problem with this recording…', onSelect: () => this.reportProblem() }], Math.max(8, r.right - 300), r.bottom + 4, { className: 'ws-more-menu', minWidth: 300, opener: b });
    });
    return b;
  }

  /** Report a problem (annotate/problem.js); "cannot be annotated" closes the recording, its draft kept. */
  async reportProblem() {
    if (this._reporting || this.s.submitting) return;
    this._reporting = true;
    try {
      const { reportProblem } = await import('./problem.js');
      const s = this.s;
      const item = { recording_id: s.recordingId, file_name: s.recording.fileName, mode: s.mode, context_id: s.contextId,
        status: s.revision ? 'done' : 'in_progress' };
      const answer = await reportProblem(this.app, item, { where: 'annotate' });
      if (answer && answer.problem && answer.problem.outcome === 'unusable' && !this._destroyed) {
        s.saveLocal();
        s.finished = true; // nothing more is sent: the recording is set aside
        this.app.leaveRecording(this, 'set aside: cannot be annotated');
      }
    } finally { this._reporting = false; }
  }

  /** The banner of a revision: which version is being revised, and its two ways out. */
  _revisionBar() {
    const r = this.s.revision;
    if (this.kind !== 'annotate' || !r) return null;
    this.saveBtn = h('button.btn.small.primary', { type: 'button', 'data-log': 'submit-revision',
      title: `Validate and save your changes as version ${r.version}; version ${r.revises} is kept as it was`, onclick: () => this.saveAndFinish() }, 'Submit the revision');
    const leave = h('button.btn.small', { type: 'button', 'data-log': 'leave-revision', onclick: () => this.leaveRevision() }, 'Leave without changes');
    return h('div.ws-revision', { role: 'status' },
      h('p', {}, h('b', {}, `Revising version ${r.revises}. `),
        `Submitting saves your changes as version ${r.version}; version ${r.revises} stays as it was saved.`),
      h('div.ws-revision-actions', {}, leave, this.saveBtn));
  }

  /** Leave a revision: the saved versions stay as they are and the revision's draft is deleted. */
  async leaveRevision() {
    const s = this.s;
    if (this._leaving) return false; // pressed again while the first press is still under way
    this._leaving = true;
    try { return await this._leaveRevision(s); } finally { this._leaving = false; }
  }

  async _leaveRevision(s) {
    if (s.submitting) { this._waitForSave(); return false; }
    if (s.changedSinceSaved && !(await ask('Leave without changes?',
      `Your changes in this revision are discarded. Version ${s.revision.revises} stays as it was saved.`,
      { yes: 'Leave without changes', no: 'Keep revising', defaultYes: false, destructive: true }))) return false;
    await s.discardDrafts({ close: true });
    logger.event('revision_left', { session_id: s.sessionId, revises: s.revision.revises, changed: s.changedSinceSaved,
      elapsed_s: Math.round(s.elapsedS * 1000) / 1000 });
    s.finished = true;
    this.app.leaveRecording(this, 'revision left without changes');
    return true;
  }

  _toolbar() {
    this.typeCaption = h('span.ws-caption', { title: 'The type of the next annotation' }, 'Draw as');
    this.chips = this.quick.map((name, i) => {
      const l = this.cat.get(name);
      const b = h('button.chip-btn', {
        type: 'button', 'aria-pressed': 'false', 'data-label': name, 'data-log-text': `${i + 1} ${l.short_code}`,
        title: `${l.label} (${l.value}) · key ${i + 1}\n${l.description}\n\nClick (or press the key) to draw this type next; with annotations selected, to change them to it.`,
        onclick: () => { logger.noteInput(`button:${i + 1} ${l.short_code}`); this.applyType(name); },
        style: { '--chip-colour': l.colour, '--chip-text': readableTextColour(l.colour) },
      }, h('span.swatch', { style: { background: l.colour } }), h('span.chip-key', {}, String(i + 1)), ' ', h('span.chip-code', {}, displayCode(l.short_code)),
      h('span.sr-only', {}, `, ${l.label}`)); // the full name for screen readers: "1 Blink, Eye-blink-artifact"
      b.tabIndex = -1;
      b.addEventListener('mousedown', (e) => e.preventDefault()); // a click leaves the keyboard focus with the EEG
      return b;
    });
    this.typeMenuBtn = h('button.btn.type-menu', { type: 'button', 'aria-haspopup': 'menu',
      title: `All ${this.cat.labels.length} HED-SCORE artifact types (press / to search them by name or code). Group terms, in italics, are for artifacts whose exact type is unclear.`,
      onclick: (e) => this.openTypeMenu(e.currentTarget) });
    this.typeMenuBtn.tabIndex = -1;
    this.scopeWhole = h('button.seg', { type: 'button', title: 'The next drag marks every channel', onclick: () => this.setScope('whole') }, 'Whole montage');
    this.scopeSome = h('button.seg', { type: 'button', title: 'The next drag marks only the selected channels (click channel names to select them)', onclick: () => this.setScope('channels') }, 'Selected channels');
    for (const b of [this.scopeWhole, this.scopeSome]) { b.tabIndex = -1; b.addEventListener('mousedown', (e) => e.preventDefault()); }
    this.chooseBtn = h('button.btn.quiet', { type: 'button', title: 'Choose the channels from a list', onclick: () => this.chooseChannelsForNew() }, 'Channels…');
    this.chanSummary = h('span.ws-chansummary');
    this.toolbar = h('div.ws-toolbar', { role: 'toolbar', 'aria-label': 'Artifact annotation' },
      this.typeCaption, h('div.chips', {}, this.chips), this.typeMenuBtn, h('span.sep'),
      h('div.segmented', { role: 'group', 'aria-label': 'Applies to' }, this.scopeWhole, this.scopeSome), this.chooseBtn, this.chanSummary,
      h('span.ws-overlay-tool', {}, h('span.sep'), this._overlayButton()));
    // Every type button shows its number and code; the toolbar wraps onto a second line when it needs one (app.css).
    return this.toolbar;
  }

  _statusBar() {
    const touch = touchFirst();
    this.hintEl = h('span.ws-hint', {}, this.kind === 'review' ? (touch ? TOUCH_REVIEW_HINT : REVIEW_HINT)
      : this.readOnly ? (touch ? TOUCH_VIEW_HINT : 'N / P  next, previous annotation')
        : touch ? TOUCH_HINT : this.timed ? KEY_HINT : KEY_HINT.replace('  ·  B pause', '')); // a try-out has no Pause
    this.msgEl = h('span.ws-message', { role: 'status', 'aria-live': 'polite' });
    // On the right, one above the other: how much has been viewed and how many annotations there are,
    // then the filters. Who is annotating and in which mode are in the Recording tab and the header.
    this.fixedEl = h('span.ws-fixed');
    this.countEl = h('span.ws-count');
    this.viewedEl = h('span.ws-viewed', { title: 'How much of the recording has been on the screen' });
    this.readoutEl = h('span.ws-readout', { 'aria-hidden': 'true', hidden: true });
    return h('footer.ws-status', {}, h('div.ws-status-left', {}, this.hintEl, this.msgEl), this.readoutEl,
      h('div.ws-status-right', {}, h('span.ws-status-counts', {}, this.timed ? this.viewedEl : null, this.countEl), this.fixedEl));
  }

  _sidePanel() {
    clear(this.side);
    this.coachHost = h('div.coach-host');
    this.reviewHost = h('div.review-host');
    const tabs = [['annotations', 'Annotations'], ['recording', 'Recording'], ['help', 'Help']];
    this.tabButtons = {};
    this.tabPanels = {};
    const bar = h('div.tabs', { role: 'tablist' });
    for (const [key, label] of tabs) {
      const b = h('button.tab', { type: 'button', role: 'tab', 'aria-selected': 'false', 'data-tab': key, onclick: () => this.showTab(key) }, label);
      this.tabButtons[key] = b;
      bar.appendChild(b);
      this.tabPanels[key] = h('div.tab-panel', { role: 'tabpanel', hidden: true, 'data-panel': key });
    }
    this._annotationsPanel();
    this._recordingPanel();
    this.tabPanels.help.appendChild(h('div.help-text', { html: helpHtml(touchFirst(), { training: ['guided', 'practice'].includes(this.s.mode) && this.kind === 'annotate' }) }));
    this.side.append(this.coachHost, this.reviewHost, h('div.side-tabs', {}, bar, ...Object.values(this.tabPanels)));
    this.showTab('annotations');
  }

  showTab(key) {
    for (const [k, b] of Object.entries(this.tabButtons)) {
      b.setAttribute('aria-selected', String(k === key));
      this.tabPanels[k].hidden = k !== key;
    }
  }

  showHelp() { this.showTab('help'); this.tabPanels.help.scrollTop = 0; }

  _annotationsPanel() {
    const p = this.tabPanels.annotations;
    this.countLabel = h('p.caption.count');
    this.tbody = h('tbody');
    this.table = h('table.ann-table', { 'aria-label': 'Annotations' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Type', h('span.th-time', { title: 'Start and end, in seconds' }, 'Time (s)')))),
      this.tbody);
    this.tableWrap = h('div.table-wrap', {}, this.table);
    const btn = (label, fn, cls = '') => h(`button.btn${cls}`, { type: 'button', onclick: fn }, label);
    this.btnGoto = btn('Go to', () => this.selection[0] && this.jumpTo(this.selection[0]));
    this.btnTimes = btn('Edit times…', () => this.editTimesOfSelected());
    this.btnLabel = btn('Change type…', () => this.relabelSelected());
    this.btnChans = btn('Edit channels…', () => this.selection[0] && this.editChannelsOf(this.selection[0]));
    this.btnMerge = btn('Merge', () => this.mergeSelected());
    this.btnMerge.title = 'Merge the selected annotations (of one type only) into one interval';
    this.btnDel = btn('Delete', () => this.deleteSelectedRows(), '.destructive');
    // The buttons that change annotations appear with a selection; until then one line says how to make one.
    this.selectHint = h('p.caption.select-hint', { hidden: true }, touchFirst()
      ? 'Tap an annotation, on the EEG or in the list, to change its times, type, channels, confidence or note.'
      : 'Select an annotation (click it on the EEG or in the list, or press N) to change its times, type, channels, confidence or note.');
    this.btnGrid = this.readOnly ? null : h('div.btn-grid', {}, this.btnGoto, this.btnTimes, this.btnLabel, this.btnChans, this.btnMerge, this.btnDel,
      ...this._confidenceButtons(btn));
    p.append(h('div.ann-body', {}, this.countLabel, this.tableWrap,
      this.readOnly ? h('div.btn-row', {}, this.btnGoto) : this.btnGrid, this.readOnly ? null : this.selectHint));
  }

  _recordingPanel() {
    const s = this.s;
    const p = this.tabPanels.recording;
    this.clockLabel = h('p.heading.clock');
    const zones = h('input', { type: 'checkbox', checked: true, id: 'zones-check', onchange: () => this.viewer.setEdgeZonesVisible(zones.checked) });
    const opts = this._viewingOptions();
    const rows = [
      ['Recording', s.recordingId],
      ['Annotator', s.me ? s.me.annotator_id + (s.me.display_name ? ` – ${s.me.display_name}` : '') : ''],
      ['Mode', (MODE_TEXT[s.mode] || s.mode) + (s.contextId ? ` (${s.contextId})` : '')],
      ['Sampling rate', `${s.recording.sfreq} Hz`],
      ['Duration', `${s.recording.durationS.toFixed(1)} s (${formatHms(s.recording.durationS)})`],
      ['Format', { edf: 'EDF', bdf: 'BDF', brainvision: 'BrainVision', synthetic: 'EDF (example)' }[s.recording.format] || s.recording.format],
      ['Channels', `${s.channels.length} shown` + (s.recording.channels.length > s.channels.length ? ` (${s.recording.channels.length - s.channels.length} in the file not shown)` : '')],
      ['Original events', `${s.events.length}`],
    ];
    this.edgeRow = h('td');
    const table = h('table.info', {}, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))), h('tr', {}, h('th', {}, 'Filter edge zones'), this.edgeRow));
    p.append(this.clockLabel);
    if (this.timed) p.append(h('p.caption.clock-note', {}, 'Time while you are paused is not counted.'), this._coverageBlock());
    p.append(h('label.check', {}, zones, ' Show filter edge zones'), this._viewToolsRow(), opts, this._comfortOptions(), table);
    if (s.warnings.length) p.append(h('h4', {}, 'Checks and warnings'), h('ul.warnings', {}, s.warnings.map((w) => h('li', {}, w))));
    p.append(h('p.caption', {}, 'Filters change only what you see. The recording files are never modified. Zero-phase filters can make sharp transients appear to start slightly earlier; mark the artifact where the underlying event begins.'));
    this._updateEdgeText();
  }

  _viewingOptions() {
    const f = this.s.filters;
    const locked = this.filtersLocked;
    const hpOn = h('input', { type: 'radio', name: 'hp', id: 'hp-on', checked: Boolean(f.highpassHz), disabled: locked });
    const hpOff = h('input', { type: 'radio', name: 'hp', id: 'hp-off', checked: !f.highpassHz, disabled: locked });
    const notch = h('input', { type: 'checkbox', id: 'notch-on', checked: Boolean(f.notchHz), disabled: locked });
    const n50 = h('input', { type: 'radio', name: 'notchf', id: 'notch-50', checked: (f.notchHz || 50) === 50, disabled: locked });
    const n60 = h('input', { type: 'radio', name: 'notchf', id: 'notch-60', checked: f.notchHz === 60, disabled: locked });
    const harm = h('input', { type: 'checkbox', id: 'notch-harm', checked: Boolean(f.notchHarmonics), disabled: locked });
    const study = (this.s.me && this.s.me.study) || {};
    const hpHz = (study.filters && study.filters.highpass_hz) || 1;
    const apply = () => {
      const nf = { highpassHz: hpOn.checked ? hpHz : null, notchHz: notch.checked ? (n60.checked ? 60 : 50) : null, notchHarmonics: notch.checked && harm.checked };
      for (const el of [n50, n60, harm]) el.disabled = locked || !notch.checked;
      this.s.filters = nf;
      this.viewer.setFilters(nf);
      this._updateEdgeText();
      this._refreshFixed();
      local.set(`electrotag.filters|${study.study_id || ''}`, {
        highpass_enabled: Boolean(nf.highpassHz), highpass_hz: hpHz, notch_enabled: Boolean(nf.notchHz), notch_hz: nf.notchHz || 50, notch_harmonics: nf.notchHarmonics,
      });
      logger.event('state', { filters: this._filtersLog(), via: logger.via() });
    };
    for (const el of [hpOn, hpOff, notch, n50, n60, harm]) el.addEventListener('change', apply);
    for (const el of [n50, n60, harm]) el.disabled = locked || !notch.checked;
    return h('fieldset.viewing', {},
      h('legend', {}, 'Viewing options'),
      locked ? h('p.banner', {}, 'These settings are fixed by the study team.') : null,
      h('div.opt', {}, h('label', {}, hpOn, ` Apply ${hpHz} Hz high-pass filter (recommended)`)),
      h('div.opt', {}, h('label', {}, hpOff, ' No high-pass filter')),
      h('div.opt', {}, h('label', {}, notch, ' Apply notch filter')),
      // The notch filter's own choices, set in under it.
      h('div.opt.sub', { role: 'group', 'aria-label': 'Notch filter' }, h('label', {}, n50, ' 50 Hz (UK, Europe)'), h('label', {}, n60, ' 60 Hz (North America)')),
      h('div.opt.sub', {}, h('label', {}, harm, ' Also remove harmonics (100, 150 Hz … or 120, 180 Hz …)')),
      this._channelColourOption());
  }

  /** "Colour channels by" (js/viewer/channel_colours.js), remembered for the annotator in this browser. */
  _channelColourOption() {
    const s = this.s;
    const study = (s.me && s.me.study) || {};
    const key = `electrotag.channel_colours|${study.study_id || ''}|${(s.me && s.me.annotator_id) || ''}`;
    this.channelColourMode = normaliseMode(local.get(key, null) || (study.display && study.display.channel_colours));
    const select = h('select.field', { id: 'channel-colours', name: 'channel-colours', 'data-log': 'channel-colours' },
      CHANNEL_COLOUR_MODES.map((m) => h('option', { value: m }, COLOUR_MODE_TEXT[m])));
    select.value = this.channelColourMode;
    const legend = h('ul.channel-legend', { 'aria-label': 'What the colours mean' });
    const show = () => {
      clear(legend);
      const items = legendOf(s.channels, this.channelColourMode);
      legend.hidden = !items.length;
      legend.append(...items.map((it) => h('li', {}, h('span.legend-line', { style: { background: it.colour } }),
        h('span', {}, it.group), h('span.caption', {}, String(it.count)))));
    };
    select.addEventListener('change', () => {
      this.channelColourMode = normaliseMode(select.value);
      local.set(key, this.channelColourMode);
      this._applyChannelColours();
      show();
      logger.event('state', { channel_colours: this.channelColourMode, via: logger.via() });
    });
    show();
    return h('div.opt.channel-colours', {}, h('label', { for: 'channel-colours' }, 'Colour channels by'), select,
      h('p.caption.legend-note', {}, 'Colours show groups only. Bad channels stay grey.'), legend);
  }

  _applyChannelColours() {
    if (this.viewer) this.viewer.setChannelColours(channelColours(this.s.channels, this.channelColourMode));
  }

  _coverageBlock() {
    this.coverageText = h('p.heading.coverage-text');
    this.coverageBar = h('div.progress-bar');
    this.nextUnviewedBtn = h('button.btn.small', { type: 'button', 'data-log': 'next-unviewed', title: 'Show the next part of the recording that has not been on the screen (U)',
      onclick: () => this.nextUnviewed('button') }, icon('skip-forward'), 'Next part not yet viewed');
    return h('div.coverage-block', {},
      this.coverageText,
      h('div.progress', { role: 'presentation' }, this.coverageBar),
      h('p.caption', {}, 'On the overview bar under the EEG, the parts not yet on the screen are white with a thin grey line above them.'),
      h('div.btn-row', {}, this.nextUnviewedBtn));
  }

  /** Display comfort for long sessions: this annotator's choices, kept in this browser. */
  _comfortOptions() {
    const who = this.s.me && this.s.me.annotator_id;
    const group = (legend, name, options, key) => h('div.opt', { role: 'radiogroup', 'aria-label': legend },
      h('span.opt-name', {}, legend),
      h('span.opt-choices', {}, Object.entries(options).map(([value, label]) => {
        const r = h('input', { type: 'radio', name: `comfort-${name}`, value, checked: this.comfort[key] === value, 'data-comfort': `${key}:${value}` });
        r.addEventListener('change', () => {
          if (!r.checked) return;
          this.comfort = { ...this.comfort, [key]: value };
          saveComfort(who, this.comfort);
          this.viewer.setComfort(this.comfort);
          this._applyPanelComfort();
          logger.event('state', { comfort: { ...this.comfort }, via: logger.via() });
        });
        return h('label', {}, r, ` ${label}`);
      })));
    return h('fieldset.viewing.comfort', {},
      h('legend', {}, 'Comfort'),
      group('Traces', 'trace', TRACE_WIDTHS, 'trace'),
      group('Channel names', 'names', NAME_SIZES, 'names'),
      group('Text in this panel', 'panel', PANEL_TEXT, 'panel'),
      h('p.caption', {}, 'Your own choices, kept in this browser. They change only how the EEG and this panel look.'));
  }

  _applyPanelComfort() { this.side.classList.toggle('large-text', this.comfort.panel === 'large'); }

  _updateEdgeText() {
    const hw = edgeHalfWidthS(this.s.filters);
    if (this.edgeRow) this.edgeRow.textContent = hw ? `±${hw.toFixed(2)} s at edges and discontinuities` : 'none (no filters)';
  }

  _filtersLog() {
    const f = this.s.filters;
    return { highpass_hz: f.highpassHz, notch_hz: f.notchHz, notch_harmonics: f.notchHarmonics, method: 'fir' };
  }

  filtersText() {
    const f = this.s.filters;
    const parts = [];
    parts.push(f.highpassHz ? `${f.highpassHz} Hz high-pass` : 'no high-pass');
    parts.push(f.notchHz ? `${f.notchHz} Hz notch${f.notchHarmonics ? ' and harmonics' : ''}` : 'no notch');
    return parts.join(', ') + (this.filtersLocked ? ' (fixed by the study team)' : '');
  }

  // =================================================================== mounting
  mount(container) {
    container.appendChild(this.el);
    const onKey = (e) => this._key(e);
    document.addEventListener('keydown', onKey);
    this._listeners.push(() => document.removeEventListener('keydown', onKey));
    logger.eegAt = (x, y) => this.viewer.logInfo(x, y);
    logger.setContext({ recording: this.s.recordingId, window_no: this.windowNo });
    // The clock starts with the recording on screen; the work since the last break carries over
    // from the recording before, unless that was closed long enough ago to count as a break.
    const carry = this.app.sinceBreak;
    this.s.startClock({ sinceBreakS: carry && Date.now() - carry.at < BREAK_MIN_S * 1000 ? carry.s : 0 });
    this._tallied = this.s.elapsedS;
    this._applyPanelComfort();
    if (this.timed) {
      this.s.onSaved = (where, at) => this._showSaved(where, at);
      const online = () => this._online();
      const offline = () => { if (this.s.canSave && !this.s.tryOut) this._showSaved('study_failed', new Date()); };
      window.addEventListener('online', online);
      window.addEventListener('offline', offline);
      this._listeners.push(() => { window.removeEventListener('online', online); window.removeEventListener('offline', offline); });
      const input = () => { this._lastInput = performance.now(); };
      for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
        document.addEventListener(type, input, { capture: true, passive: true });
        this._listeners.push(() => document.removeEventListener(type, input, { capture: true, passive: true }));
      }
      this._refreshCoverage();
      this._noteViewDwell();
    }
    this._clock = setInterval(() => this._tick(), 1000);
    this._tick();
    const visibility = () => this._visibility();
    document.addEventListener('visibilitychange', visibility);
    this._listeners.push(() => document.removeEventListener('visibilitychange', visibility));
    if (this.s.resumed && this.timed) this._welcomeBack();
    if (this.kind === 'annotate') this._offerDiscarded();
  }

  /** Work on this recording discarded earlier in this tab (session.js discardDrafts): a note that offers to bring it back. */
  _offerDiscarded() {
    const d = this.s.discarded;
    if (!d || !d.annotations.length) return;
    const n = d.annotations.length;
    const when = d.discarded_at ? ` at ${timeOfDay(new Date(d.discarded_at))}` : '';
    const back = h('button.btn.small', { type: 'button', 'data-log': 'bring-back', onclick: () => this.bringBackDiscarded() }, 'Bring it back');
    const leave = h('button.btn.small.quiet', { type: 'button', 'data-log': 'bring-back-no', onclick: () => { this._hideDiscarded(); } }, 'Leave it');
    this.discardedEl = h('div.note.discarded-work', { 'data-log': 'discarded-work' },
      h('p', {}, `Work you discarded${when} is kept until you close this tab: ${plural(n, 'annotation')} and ${friendlyDuration(Number(d.elapsed_s) || 0)} of work on this recording.`),
      h('div.btn-row', {}, back, leave));
    this.tabPanels.annotations.prepend(this.discardedEl);
  }

  _hideDiscarded() { if (this.discardedEl) { this.discardedEl.remove(); this.discardedEl = null; } }

  async bringBackDiscarded() {
    const d = this.s.discarded;
    if (!d || !this._checkEditable()) { this._hideDiscarded(); return; }
    const n = this.store.size;
    if (n && !(await ask('Bring back the earlier work?', `Your ${plural(n, 'annotation')} open now ${n === 1 ? 'is' : 'are'} replaced by the ${plural(d.annotations.length, 'annotation')} you discarded. Undo takes this back.`,
      { yes: 'Bring it back', no: 'Keep what is open', defaultYes: false }))) return;
    const r = this.s.bringBackDiscarded();
    this._hideDiscarded();
    if (!r) return;
    if (this.timed) { this.viewer.setCoverage(this.s.viewed); this._refreshCoverage(); }
    logger.event('discarded_work_restored', { n_annotations: r.n, elapsed_s: Math.round(r.elapsedS * 10) / 10, replaced: n });
    this.say(`Brought back ${plural(r.n, 'annotation')} and ${friendlyDuration(r.elapsedS)} of work (${undoHint()}).`);
  }

  _visibility() {
    const s = this.s;
    if (document.visibilityState === 'hidden') {
      if (s.canSave) { s.saveLocal(); s.saveRemote({ force: true, keepalive: true }); }
      if (this.clock && this.clock.paused) this._hiddenWhilePaused = true;
      // Out of sight for more than a few seconds (another tab or app, the iPad locked): a pause
      // from the moment the page was hidden.
      if (this.timed && this.clock && !this.clock.paused) {
        this._hiddenAt = this.clock.now();
        clearTimeout(this._hiddenTimer);
        this._hiddenTimer = setTimeout(() => {
          if (document.visibilityState === 'hidden' && this._hiddenAt !== null) this.pause('hidden', { at: this._hiddenAt });
        }, this.hiddenPauseMs);
      }
      return;
    }
    clearTimeout(this._hiddenTimer);
    // Timers wait while a page is hidden, so a return after a long absence is checked here too.
    if (this.timed && this.clock && this._hiddenAt !== null && !this.clock.paused && this.clock.now() - this._hiddenAt >= this.hiddenPauseMs) {
      this.pause('hidden', { at: this._hiddenAt });
    }
    this._hiddenAt = null;
    this._lastInput = performance.now();
    // Back from elsewhere while paused: the panel says how long the annotator was away.
    if (this.clock && this.clock.paused) this._refreshPausePanel(Boolean(this._hiddenWhilePaused));
    this._hiddenWhilePaused = false;
  }

  /** The view is on screen: log recording_opened with its fields (docs/activity_logs.md). */
  logOpened(extra = {}) {
    const s = this.s;
    logger.event('recording_opened', {
      session_id: s.sessionId, mode: s.mode, duration_s: s.recording.durationS, sfreq: s.recording.sfreq, n_samples: s.recording.nSamples,
      n_channels_shown: s.channels.length, n_channels_hidden: s.recording.channels.length - s.channels.length, format: s.recording.format,
      filters: this.filtersText(), filter_settings: this._filtersLog(), original_events: s.events.length, resumed: s.resumed,
      annotations_restored: s.restored, window_px: [window.innerWidth, window.innerHeight],
      ...(this.timed ? { elapsed_restored_s: Math.round(s.elapsedBase * 1000) / 1000, viewed_fraction: this._viewedFraction() } : {}),
      comfort: { ...this.comfort }, overlay: Boolean(this.viewer.overlay), value_readout: Boolean(this.readoutOn),
      ...(this.bounds ? { task_window: { start_s: this.bounds.startS, end_s: this.bounds.endS } } : {}), ...extra,
    });
    this.logSnapshot();
    logger.event('viewer_ready', {});
  }

  /**
   * The annotations there are as the view opens (a restored draft, a revision, a correction), as
   * annotations_snapshot events, so that a replay of the session starts from them (replay/model.js).
   */
  logSnapshot(reason = null) {
    const why = reason || (this.s.revision ? 'revision' : this.s.resumed ? 'draft' : this.kind);
    for (const [type, fields] of snapshotEvents(this.store.annotations(), this.sf, why)) logger.event(type, fields);
  }

  /** Run `fn` when the view closes (at once when it has closed already). */
  onDestroy(fn) {
    if (this._destroyed) fn(); else (this._onDestroy || (this._onDestroy = [])).push(fn);
  }

  destroy() {
    if (this._destroyed) return; // a late answer may close a view that has closed already
    this._destroyed = true;
    for (const fn of this._onDestroy || []) { try { fn(); } catch { /* the view closes anyway */ } }
    clearInterval(this._clock);
    clearTimeout(this._hiddenTimer);
    clearInterval(this._pauseTimer);
    this._noteViewDwell.cancel();
    cancelAnimationFrame(this._readoutRaf);
    if (this.clock) {
      if (this.clock.paused) this.resume('close', { quiet: true });
      this._tally(true);
      this.app.sinceBreak = { s: this.clock.sinceBreakS, at: Date.now() };
    }
    // Closed: a save still waiting (a change just before Close) must not write a draft after the view has
    // gone, where it would bring back work discarded since, or overwrite a newer draft of the recording.
    this.s.close();
    this.s.onSaved = null;
    this._listeners.forEach((f) => f());
    this.store.removeListener(this._storeListener);
    if (this.coach) this.coach.destroy();
    this.viewer.destroy();
    closeMenu();
    logger.eegAt = null;
    logger.setContext(null);
    this.el.remove();
  }

  _tick() {
    // In the words of the paused panel ("3 min 05 s"), so that the two say the same thing the same way.
    if (this.clockLabel) this.clockLabel.textContent = `Time worked on this recording: ${friendlyDuration(this.s.elapsedS)}`;
    const c = this.clock;
    if (this.timed && c) {
      // (while paused, the panel's own timer counts the pause)
      if (!c.paused && document.visibilityState !== 'hidden') {
        // The pause starts when the idle time ran out, not at this tick: after a computer slept, or a
        // page whose timers waited, the first tick can come hours later, and those hours are not work.
        if (idleDue(performance.now() - this._lastInput, this.settings.idlePauseMinutes)) this.pause('idle', { at: this._lastInput + this.settings.idlePauseMinutes * 60 * 1000 });
        else if (!this._breakShown && c.breakDue(this.settings.breakReminderMinutes * 60)) this._showBreakReminder();
      }
      this._tally();
    }
    if (this.s.canSave && !this.s.finished && !(c && c.paused)) {
      this.s.saveRemote().then((sent) => { if (sent) logger.event('autosave', { n_annotations: this.store.size }); });
    }
  }

  /** Today's working time in this browser (the home page shows it), added every few seconds. */
  _tally(now = false) {
    if (!this.timed || !this.clock) return;
    const e = this.s.elapsedS;
    const d = e - this._tallied;
    if (d < 0) { this._tallied = e; return; }
    if (!now && d < 15) return;
    this._tallied = e;
    const key = todayKey((this.s.me && this.s.me.annotator_id) || 'anon');
    local.set(key, Math.round(((Number(local.get(key, 0)) || 0) + d) * 10) / 10);
  }

  // ======================================================== pause and resume
  _pausePanel() {
    this.pauseTitle = h('h2.pause-title', { id: `pause-title-${this.windowNo}` }, 'Paused');
    this.pauseReasonEl = h('p.pause-reason');
    this.pauseWorked = h('p.pause-worked');
    this.pauseAway = h('p.pause-away');
    this.pauseDraft = h('p.caption.pause-draft');
    this.resumeBtn = h('button.btn.primary.resume', { type: 'button', 'data-log': 'resume', onclick: () => this.resume('button') }, 'Resume');
    this.panel = h('div.pause-panel', { hidden: true, role: 'region', 'aria-labelledby': this.pauseTitle.id, 'data-log': 'pause-panel' },
      h('div.pause-card', {}, this.pauseTitle, this.pauseReasonEl, this.pauseWorked, this.pauseAway, this.pauseDraft,
        h('div.btn-row', {}, this.resumeBtn),
        touchFirst() ? null : h('p.caption.pause-key', {}, 'or press B')));
    return this.panel;
  }

  /** Stop the clock and cover the EEG. reason: button, key, idle, hidden or break; `at` starts the pause earlier. */
  pause(reason, { at } = {}) {
    const c = this.clock;
    // While Save and Finish waits for its answer the time is already counted: nothing to pause, and no draft to keep.
    if (!this.timed || !c || c.paused || this.s.finished || this.s.submitting) return false;
    const idleS = (performance.now() - this._lastInput) / 1000;
    const p = c.pause(reason, at === undefined ? c.now() : at);
    // Nothing half-done stays behind the panel: a drag, a started mark, an open menu.
    if (this.gesture) { this.gesture = null; this.viewer.setDragPreview(null); this.viewer.setAnnotations(this.store.annotations()); }
    this.cancelMark(true);
    closeMenu();
    this._hideBreakReminder(null);
    for (const el of [this.toolbar, this.eegHost, this.side]) if (el) el.inert = true;
    this.el.classList.add('paused');
    this._refreshState(); // Draw/edit, Delete, Undo and Redo wait for Resume
    this.pauseBtn.setAttribute('aria-pressed', 'true');
    this.pauseBtn.querySelector('.pause-label').textContent = 'Resume';
    this.pauseBtn.querySelector('.ico')?.replaceWith(icon('play'));
    this.pauseBtn.title = 'Start the clock again (B)';
    this.panel.hidden = false;
    this.pauseReasonEl.textContent = {
      idle: `ElectroTag paused itself after ${minutesWords(this.settings.idlePauseMinutes * 60)} without any input.`,
      hidden: 'ElectroTag paused itself while the page was out of sight.',
      break: 'Enjoy your break. A few minutes away from the screen help you stay sharp.',
    }[reason] || 'The clock is stopped until you resume.';
    this.pauseDraft.textContent = 'Keeping your draft…';
    this._returned = false;
    this._refreshPausePanel();
    // The time paused counts up on the panel, second by second from the start of the pause.
    clearInterval(this._pauseTimer);
    this._pauseTimer = setInterval(() => this._refreshPausePanel(), 1000);
    logger.event('pause', { reason, elapsed_s: Math.round(p.elapsedS * 1000) / 1000,
      ...(reason === 'idle' ? { idle_s: Math.round(idleS * 10) / 10 } : {}),
      ...(reason === 'hidden' ? { hidden_s: Math.round((c.now() - p.at) / 100) / 10 } : {}) });
    this.say('Paused: the clock is stopped and your draft is kept.');
    const s = this.s;
    s.saveLocal();
    s.saveRemote({ force: true, keepalive: reason === 'hidden' }).then((sent) => {
      if (!this.panel.hidden) {
        this.pauseDraft.textContent = sent || s.tryOut ? 'Your draft is saved, in this browser and with the study.' : 'Your draft is saved in this browser.';
      }
    });
    // A dialog left open (the idle pause can come while one waits) keeps the focus: Enter still answers it.
    if (document.visibilityState !== 'hidden' && !dialogOpen()) this.resumeBtn.focus({ preventScroll: true });
    return true;
  }

  /** Start the clock again. via: button, key, save or close (`quiet`: the view is closing). */
  resume(via, { quiet = false } = {}) {
    const c = this.clock;
    if (!c || !c.paused) return false;
    const r = c.resume();
    clearInterval(this._pauseTimer);
    this.panel.hidden = true;
    for (const el of [this.toolbar, this.eegHost, this.side]) if (el) el.inert = false;
    this.el.classList.remove('paused');
    this._refreshState();
    this.pauseBtn.setAttribute('aria-pressed', 'false');
    this.pauseBtn.querySelector('.pause-label').textContent = 'Pause';
    this.pauseBtn.querySelector('.ico')?.replaceWith(icon('pause'));
    this.pauseBtn.title = 'Stop the clock while you are away (B). Your draft is kept.';
    this._lastInput = performance.now();
    if (r.isBreak) this._breakShown = false;
    logger.event('resume', { reason: r.reason, paused_s: Math.round(r.pausedS * 1000) / 1000, via, counts_as_break: r.isBreak,
      elapsed_s: Math.round(this.s.elapsedS * 1000) / 1000 });
    if (this.coach) this.coach.addPaused(r.pausedS);
    if (quiet) return true;
    this.viewer.over.focus({ preventScroll: true });
    this.say(`Welcome back. The ${friendlyDuration(r.pausedS)} you were paused were not counted.`);
    this._noteViewDwell();
    return true;
  }

  _refreshPausePanel(returned = false) {
    const c = this.clock;
    if (!c || !c.paused) return;
    if (returned) this._returned = true;
    this.pauseWorked.textContent = `Time worked on this recording: ${friendlyDuration(this.s.elapsedS)}.`;
    const away = c.pausedForS;
    if (c.pauseReason === 'idle') {
      // The pause began when the minutes without input ran out; those minutes still count (the annotator may have been reading).
      const idle = minutesWords(this.settings.idlePauseMinutes * 60);
      const before = `the ${idle} before the pause still ${/^1 /.test(idle) ? 'counts' : 'count'}`;
      this.pauseAway.textContent = away >= 1 ? `The ${friendlyDuration(away)} since then ${Math.round(away) === 1 ? 'is' : 'are'} not counted; ${before}.`
        : `The time from now on is not counted; ${before}.`;
      return;
    }
    const was = this._returned || c.pauseReason === 'hidden' ? 'You were away for' : 'Paused for';
    this.pauseAway.textContent = away >= 1 ? `${was} ${friendlyDuration(away)}; that time is not counted.` : 'The time you are paused is not counted.';
  }

  // ============================================================ break reminders
  _showBreakReminder() {
    this._breakShown = true;
    const worked = this.clock.sinceBreakS;
    const later = h('button.btn.small', { type: 'button', 'data-log': 'break-later', onclick: () => this._hideBreakReminder('remind_later') }, 'Remind me in 15 minutes');
    const take = h('button.btn.small', { type: 'button', 'data-log': 'break-take', onclick: () => this._hideBreakReminder('take_break') }, 'Take a break');
    this.breakEl = h('div.break-reminder.note', { role: 'status', 'aria-live': 'polite', 'data-log': 'break-reminder' },
      h('p', {}, `You have worked for ${minutesWords(worked)} since your last break. A few minutes away from the screen help you stay sharp.`),
      h('div.btn-row', {}, take, later));
    this.main.append(this.breakEl); // over the foot of the side panel (app.css), never over the EEG
    logger.event('break_reminder', { worked_s: Math.round(worked), interval_s: this.settings.breakReminderMinutes * 60 });
  }

  /** choice: take_break, remind_later, or null (the reminder is no longer needed: a pause began). */
  _hideBreakReminder(choice) {
    if (!this.breakEl) return;
    this.breakEl.remove();
    this.breakEl = null;
    logger.event('break_reminder_closed', { choice: choice || 'paused' });
    if (choice === 'remind_later') {
      this.clock.snooze(SNOOZE_S);
      this._breakShown = false;
      this.say('A reminder comes again in 15 minutes of work.');
    } else if (choice === 'take_break') {
      this.pause('break');
    } else {
      this._breakShown = false;
    }
    if (choice) this.viewer.over.focus({ preventScroll: true });
  }

  // =================================================================== coverage
  /** The stretches of the recording without recorded data, in seconds: nothing to look at. */
  _noData() {
    return [...(this.s.gaps || []).map(([a, b]) => [a / this.sf, b / this.sf]), ...outsideStretches(this.bounds, this.s.recording.durationS)];
  }

  _viewedFraction() {
    return Math.round(cov.viewedFraction(this.s.viewed, this.s.recording.durationS, this._noData()) * 10000) / 10000;
  }

  _unviewed() { return cov.unviewed(this.s.viewed, this.s.recording.durationS, { noData: this._noData() }); }

  /** A view that has stayed on screen for a moment counts as seen (not while paused or out of sight). */
  _noteViewDwell = debounce(() => this._recordViewed(), cov.DWELL_MS);

  _recordViewed() {
    if (!this.timed || !this.clock || this.clock.paused || document.visibilityState === 'hidden') return;
    if (this._overviewView) return; // Show all is a look at the whole recording, not viewing it
    if (!this.viewer._covers()) { this._noteViewDwell(); return; } // still reading the EEG
    const v = this.viewer.view;
    const before = this.s.viewed;
    const next = cov.addInterval(before, v.startS, v.startS + v.durationS, this.s.recording.durationS);
    if (next === before || cov.coveredS(next) - cov.coveredS(before) < 1e-6) return;
    this.s.noteViewed(next);
    this.viewer.setCoverage(next);
    this._refreshCoverage();
  }

  _refreshCoverage() {
    if (!this.timed) return;
    const f = cov.viewedFraction(this.s.viewed, this.s.recording.durationS, this._noData());
    const text = `Viewed ${cov.percentText(f)}`;
    this.viewedEl.textContent = text;
    this.coverageText.textContent = `${text} of the recording`;
    this.coverageBar.style.width = `${Math.floor(f * 100)}%`;
  }

  /** Show the next stretch that has not been on screen (U, or the button). */
  nextUnviewed(via = 'key') {
    if (!this.timed || (this.clock && this.clock.paused)) return;
    const gaps = this._unviewed();
    if (!gaps.length) { this.say('Every part of the recording has been on the screen.'); return; }
    const v = this.viewer.view;
    const end = v.startS + v.durationS;
    const g = cov.nextUnviewed(gaps, end);
    // A stretch that runs on past the screen continues from the screen's end.
    const from = g[0] < end && g[1] > end && g[0] >= v.startS - 1e-6 ? end : g[0];
    const startS = cov.viewStartFor([from, g[1]], v.durationS);
    this.viewer.setView({ startS }, 'unviewed');
    const left = gaps.length;
    this.say(`Not yet viewed: ${clockText(from)} to ${clockText(g[1])}. ${left === 1 ? 'This is the last such part.' : `${left} parts are left to look at.`}`);
    logger.event('next_unviewed', { from_s: Math.round(from * 1000) / 1000, to_s: Math.round(g[1] * 1000) / 1000, n_unviewed: left, via });
  }

  // ===================================================== a task's part of the recording
  /**
   * The window of the task this recording is part of (GET /assignments: the item's `task.window`), as
   * bounds (viewer/bounds.js), or null for the whole recording. Only annotation and the feedback on it
   * have one: the expert area's views open other people's work.
   */
  _taskBounds() {
    if (!['annotate', 'feedback'].includes(this.kind) || this.s.tryOut) return null;
    const s = this.s;
    const w = s.taskWindow || itemWindow((this.app.assignments || {}).items, { recordingId: s.recordingId, mode: s.mode, contextId: s.contextId });
    return boundsOf(w, s.recording.sfreq, s.recording.nSamples);
  }

  /** The viewer keeps to the part and hatches the rest; the store refuses marks outside it. */
  _applyBounds() {
    this.viewer.setBounds(this.bounds);
    this.store.setWindow(this.bounds);
    if (!this.s.view) this.viewer.setView({ startS: this.bounds.startS - CONTEXT_S }, 'restore');
  }

  // ================================================================ drafts kept
  /**
   * The time the draft was last kept, at the top. When the study has stopped receiving drafts (no
   * connection), it says plainly that the draft is in this browser only, and the status line says so
   * once; when a draft reaches the study again, the label is as before and the line says so.
   */
  _showSaved(where, at) {
    if (where === 'study_failed') {
      const first = !this._studyFailing;
      this._studyFailing = true;
      if (first && !this._destroyed) {
        this.say('The study cannot be reached just now. Your draft is kept in this browser and goes to the study when the connection returns.', 15000);
        logger.event('draft_not_sent', { online: navigator.onLine !== false });
      }
    } else {
      this._saved[where] = at;
      if (where === 'study' && this._studyFailing) {
        this._studyFailing = false;
        if (!this._destroyed) this.say('The study can be reached again, and has your latest draft.');
        logger.event('draft_sent_again', {});
      }
    }
    if (!this.savedEl) return;
    const t = (d) => d.toLocaleTimeString('en-GB');
    if (this._studyFailing) {
      this.savedEl.textContent = this._saved.browser ? `Draft kept in this browser only, ${timeOfDay(this._saved.browser)}` : 'Draft kept in this browser only';
      this.savedEl.dataset.saved = 'local-only';
      this.savedEl.title = 'The study cannot be reached just now (the connection may have dropped). Your draft is kept in this browser, and ' +
        `goes to the study when the connection returns.${this._saved.study ? ` The study last received it at ${t(this._saved.study)}.` : ''}`;
      return;
    }
    const latest = [this._saved.browser, this._saved.study].filter(Boolean).sort((a, b) => b - a)[0];
    if (!latest) return;
    this.savedEl.textContent = `Draft saved ${timeOfDay(latest)}`;
    this.savedEl.dataset.saved = where === 'study_failed' ? 'browser' : where;
    this.savedEl.title = 'Your work is kept as a draft while you annotate, so nothing is lost if the page closes. ' +
      `Last kept ${this._saved.browser ? `in this browser at ${t(this._saved.browser)}` : ''}` +
      `${this._saved.browser && this._saved.study ? ' and ' : ''}${this._saved.study ? `with the study at ${t(this._saved.study)}` : ''}.`;
  }

  /** The connection comes back: the draft goes to the study at once (a draft replaces the one before, so this is safe; Save and Finish is never sent again by itself). */
  _online() {
    const s = this.s;
    if (!s.canSave || s.submitting) return;
    s.saveRemote({ force: true });
  }

  /** A restored draft: where the annotator was, what was kept and the time so far. */
  _welcomeBack() {
    const s = this.s;
    const v = this.viewer.view;
    const ch = s.channels;
    const last = Math.min(ch.length, v.firstChannel + v.nChannels) - 1;
    const where = `${clockText(v.startS)}${ch.length > v.nChannels ? `, channels ${ch[v.firstChannel].name} to ${ch[last].name}` : ''}`;
    const n = this.store.size;
    const text = `Welcome back. You were at ${where}, with ${n} annotation${n === 1 ? '' : 's'} kept and ${friendlyDuration(s.elapsedBase)} worked so far.`;
    this.welcomeEl = h('p.note.welcome-back', { 'data-log': 'welcome-back' }, text);
    this.tabPanels.annotations.prepend(this.welcomeEl);
    this.say(text, 20000);
    setTimeout(() => { if (this.welcomeEl) { this.welcomeEl.remove(); this.welcomeEl = null; } }, 60000);
  }

  // ================================================================== messages
  _clearMessage() {
    clearTimeout(this._msgTimer);
    this.msgEl.textContent = '';
    this.hintEl.hidden = false;
  }

  say(msg, ms = 10000) {
    this.msgEl.textContent = msg;
    this.hintEl.hidden = Boolean(msg);
    logger.status(msg);
    clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(() => { this.msgEl.textContent = ''; this.hintEl.hidden = false; }, ms);
  }

  // ===================================================================== state
  get editable() { return this.drawing && !this.readOnly; }

  _checkEditable() {
    if (this.clock && this.clock.paused) return false; // nothing changes behind the pause panel
    if (this.editable) return true;
    this.say(this.readOnly ? 'This view is read-only' : DRAWING_OFF);
    return false;
  }

  _logState(fields) { logger.event('state', { ...fields, via: logger.via() }); }

  setDrawing(on) {
    if (this.readOnly) on = false;
    this.drawing = Boolean(on);
    this._logState({ drawing_enabled: this.drawing });
    this.say(on ? 'Draw/edit is on: drag across the EEG to mark an artifact.' : 'View only: annotations cannot be drawn or changed. Press Draw/edit to mark artifacts again.');
    this._refreshState();
  }

  setCurrentLabel(label) {
    this.cat.get(label);
    if (label !== this.currentLabel) { this.currentLabel = label; this._logState({ current_label: label }); }
    if (this.markStart !== null) { this.viewer.setMarkStart(this.markStart, this.cat.colourFor(label)); this._showPendingMark(); }
    this._refreshState();
  }

  setScope(scope) {
    if (scope === this.scope) { this._refreshState(); return; }
    this.scope = scope;
    this._logState({ scope });
    this._refreshState();
    if (scope === 'channels' && !this.selectedChannels.length) this.say("Click channel names or traces (or use 'Channels…') to select channels.");
  }

  setSelectedChannels(names) {
    const chosen = new Set(names);
    this.selectedChannels = this.s.channels.map((c) => c.name).filter((n) => chosen.has(n));
    this._logState({ selected_channels: [...this.selectedChannels] });
    this._refreshState();
  }

  toggleScope() {
    if (this.viewer.overlay) { this.say('In the overlay, marks apply to the whole montage. Press O for the normal view to mark channels.'); return; }
    this.setScope(this.scope === 'whole' ? 'channels' : 'whole');
    this.say(this.scope === 'whole' ? 'Next annotation: whole montage' : 'Next annotation: selected channels (click channel names to choose them)');
  }

  /**
   * A click on a channel's name. In the overlay it shows that channel alone. With one channel-specific
   * annotation selected it adds the channel to that annotation or takes it out (as Shift+click does on
   * the EEG); otherwise, with Selected channels, it chooses the channels of the next annotation.
   */
  onChannelClicked(name) {
    if (this.viewer.overlay) { this.isolate(name, logger.via()); return; }
    const ids = this.targetIds();
    if (ids.length === 1 && this.editable) {
      if (this.store.get(ids[0]).channels.length) this.toggleAnnotationChannel(ids[0], name);
      else this.say(`The selected annotation applies to the whole montage: Shift+click ${name} inside it to take that channel out, or use Edit channels…. Esc ends the selection.`);
      return;
    }
    if (this.scope !== 'channels') {
      this.say('To mark only some channels, choose Selected channels (C), then click their names.');
      return;
    }
    const sel = new Set(this.selectedChannels);
    if (sel.has(name)) sel.delete(name); else sel.add(name);
    this.setSelectedChannels([...sel]);
    const n = this.selectedChannels.length;
    this.say(`${plural(n, 'channel')} chosen for the next annotation${n ? `: ${namesText(this.selectedChannels)}` : ''}`);
  }

  select(ids, { via = null } = {}) {
    const list = (ids === null ? [] : Array.isArray(ids) ? ids : [ids]).filter((i) => this.store.has(i));
    const same = list.length === this.selection.length && list.every((x, i) => x === this.selection[i]);
    this.selection = list;
    if (!same) {
      const a = list.length ? this.store.get(list[0]) : null;
      logger.event('selection', { annotation_id: a ? a.annotation_id : null, label: a ? a.label : null, n_selected: list.length, via: via || logger.via() });
    }
    this.viewer.setSelection(list);
    this._refreshList();
    this._refreshState();
  }

  targetIds() { return this.selection.filter((i) => this.store.has(i)); }

  _refreshState() {
    if (this.toolbar) {
      const ids = this.targetIds();
      let shown;
      if (ids.length) {
        const labels = new Set(ids.map((i) => this.store.get(i).label));
        shown = labels.size === 1 ? [...labels][0] : null;
        this.typeCaption.textContent = 'Change to';
        this.typeCaption.title = 'Annotations are selected: a type button, key or menu choice changes them';
      } else {
        shown = this.currentLabel;
        this.typeCaption.textContent = 'Draw as';
        this.typeCaption.title = 'The type of the next annotation';
      }
      if (!this.drawing && !this.readOnly) {
        // Draw/edit is off: the caption says so, and how to mark again.
        this.typeCaption.textContent = 'View only';
        this.typeCaption.title = DRAW_OFF_TITLE;
      }
      this.toolbar.classList.toggle('changing', ids.length > 0);
      this.toolbar.classList.toggle('view-only', !this.drawing);
      this.chips.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.label === shown)));
      clear(this.typeMenuBtn);
      if (shown) {
        const l = this.cat.get(shown);
        this.typeMenuBtn.append(h('span.swatch', { style: { background: l.colour } }), h('span.type-name', {}, l.label));
      } else {
        this.typeMenuBtn.append(h('span.type-name.muted', {}, 'Several types'));
      }
      this.typeMenuBtn.append(h('span.chev', {}, icon('chevron-down')));
      this.scopeWhole.setAttribute('aria-pressed', String(this.scope === 'whole'));
      this.scopeSome.setAttribute('aria-pressed', String(this.scope === 'channels'));
      const ch = this.selectedChannels;
      this.chanSummary.className = 'ws-chansummary';
      if (this.scope === 'whole') { this.chanSummary.textContent = 'all channels'; this.chanSummary.title = 'Annotations apply to the whole montage'; }
      else if (!ch.length) { this.chanSummary.textContent = 'none selected'; this.chanSummary.title = 'Click channel names, or use Channels…'; this.chanSummary.classList.add('warning'); }
      else {
        this.chanSummary.textContent = ch.slice(0, 3).join(', ') + (ch.length > 3 ? ` (+${ch.length - 3})` : '');
        this.chanSummary.title = ch.join(', ');
        this.chanSummary.classList.add('selected');
      }
      for (const b of [...this.chips, this.typeMenuBtn, this.scopeWhole, this.scopeSome, this.chooseBtn]) b.disabled = this.readOnly;
    }
    this.viewer.setSelectedChannels(this.selectedChannels, this.scope === 'channels');
    if (this.drawBtn) {
      // Each acts only when it can: Undo and Redo as the history allows, Delete with something selected;
      // none of them, nor Draw/edit, while paused (nothing changes behind the pause panel).
      const paused = Boolean(this.clock && this.clock.paused);
      const keys = touchFirst() ? '' : ` (${CTRL}+Z)`;
      this.drawBtn.setAttribute('aria-pressed', String(this.drawing));
      this.drawBtn.disabled = paused;
      this.drawBtn.title = this.drawing ? DRAW_ON_TITLE : DRAW_OFF_TITLE;
      this.undoBtn.disabled = paused || !this.editable || !this.store.canUndo;
      this.redoBtn.disabled = paused || !this.editable || !this.store.canRedo;
      this.undoBtn.title = this.store.canUndo ? `Undo ${this.store.undoDescription}${keys}` : 'Nothing to undo';
      this.redoBtn.title = this.store.canRedo ? `Redo ${this.store.redoDescription}${touchFirst() ? '' : ` (${CTRL}+Y)`}` : 'Nothing to redo';
      const n = this.targetIds().length;
      this.deleteBtn.disabled = paused || !this.editable || !n;
      this.deleteBtn.title = n ? `Delete the selected ${n === 1 ? 'annotation' : `${n} annotations`}${touchFirst() ? '' : ' (Delete or Backspace)'}`
        : 'Select an annotation to delete it: click it, or press N';
    }
    const anns = this.targetIds().map((i) => this.store.get(i));
    const ed = this.editable;
    this.btnGoto.disabled = !anns.length;
    this.btnTimes.disabled = !(ed && anns.length === 1);
    this.btnLabel.disabled = !(ed && anns.length);
    this.btnChans.disabled = !(ed && anns.length === 1);
    this.btnDel.disabled = !(ed && anns.length);
    this.btnMerge.disabled = !(ed && anns.length >= 2 && new Set(anns.map((a) => a.label)).size === 1);
    this._refreshConfidenceButtons(anns, ed);
    if (this.btnGrid) {
      this.btnGrid.hidden = !anns.length;
      this.selectHint.hidden = Boolean(anns.length) || !this.store.size;
    }
    if (this.saveBtn && this.coach) this.coach.syncSaveButton(this.saveBtn);
    this._refreshOverlayState();
  }

  _refreshFixed() {
    this.fixedEl.textContent = `Filters: ${this.filtersText()}`;
  }

  _refreshList() {
    const anns = this.store.annotations();
    const sel = new Set(this.selection);
    const scroll = this.tableWrap.scrollTop;
    clear(this.tbody);
    anns.forEach((a, i) => {
      const l = this.cat.get(a.label);
      const prefix = (this.prefix && this.prefix[a.annotation_id]) || '';
      const start = (a.onset_sample / this.sf).toFixed(3);
      const end = (endSample(a) / this.sf).toFixed(3);
      const tr = h(`tr${sel.has(a.annotation_id) ? '.selected' : ''}`, {
        'data-id': a.annotation_id, 'data-log-text': a.label, 'aria-selected': String(sel.has(a.annotation_id)),
        title: `${a.label} (${l.value})\n${l.description}`.trim(),
        onclick: (e) => this._rowClick(e, i, anns),
        ondblclick: () => this.jumpTo(a.annotation_id),
      },
      // Two lines, so that the label has the panel's whole width: the label (wrapping at its hyphens
      // only when even that is too narrow), then the channels, the rating, the note sign and the times.
      h('td.label', {},
        h('div.ann-name', {}, h('span.swatch', { style: { background: l.colour } }),
          h('span.label-text', { style: { color: this.labelColours?.[a.annotation_id] || null } }, prefix + a.label)),
        h('div.ann-details', {}, h('span.chans', { title: a.channels.length ? a.channels.join(', ') : 'Whole montage' }, channelsText(a.channels)),
          ...this._confidenceMarks(a),
          h('span.ann-time', { title: `${start} to ${end} s, duration ${(a.duration_samples / this.sf).toFixed(3)} s` },
            `${start}–${end}`))));
      this.tbody.appendChild(tr);
    });
    if (!anns.length) this.tbody.appendChild(h('tr.empty', {}, h('td', {}, this.readOnly ? 'No annotations.' : 'No annotations yet. Choose a type and drag across the EEG.')));
    this.tableWrap.scrollTop = scroll;
    const n = anns.length;
    const nCh = anns.filter((a) => a.channels.length).length;
    this.countLabel.textContent = `${plural(n, 'annotation')}: ${n - nCh} whole montage, ${nCh} channel-specific`;
    this.countEl.textContent = `Annotations: ${n}`;
  }

  _rowClick(e, index, anns) {
    const id = anns[index].annotation_id;
    logger.noteInput('list:annotations');
    if (e.shiftKey && this.listAnchor !== null) {
      const [a, b] = [Math.min(this.listAnchor, index), Math.max(this.listAnchor, index)];
      this.select(anns.slice(a, b + 1).map((x) => x.annotation_id), { via: 'list:annotations' });
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const set = new Set(this.selection);
      if (set.has(id)) set.delete(id); else set.add(id);
      this.listAnchor = index;
      this.select(anns.filter((x) => set.has(x.annotation_id)).map((x) => x.annotation_id), { via: 'list:annotations' });
      return;
    }
    this.listAnchor = index;
    this.select([id], { via: 'list:annotations' });
    this.jumpTo(id, { keepSelection: true });
  }

  _revealRow(id) {
    const tr = this.tbody.querySelector(`tr[data-id="${id}"]`);
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  }

  _refreshAll() {
    this._refreshList();
    this._refreshState();
    this._refreshFixed();
  }

  _syncViewState() {
    const v = this.viewer.view;
    this.s.view = { start_s: Math.round(v.startS * 1000) / 1000, duration_s: v.durationS, first_channel: v.firstChannel, n_channels: v.nChannels, scale_factor: Math.round(v.scaleFactor * 1e4) / 1e4 };
  }

  _logView = debounce(() => {
    const v = this.viewer.view;
    const ch = this.s.channels;
    const last = Math.min(ch.length, v.firstChannel + v.nChannels) - 1;
    logger.event('view', {
      t_start: Math.round(v.startS * 1000) / 1000, duration: v.durationS, ch_start: v.firstChannel, n_channels: v.nChannels,
      first_channel: ch[v.firstChannel]?.name, last_channel: ch[last]?.name, scale_factor: Math.round(v.scaleFactor * 1e4) / 1e4, butterfly: Boolean(this.viewer.overlay),
    });
  }, 250);

  _afterViewChange() {
    if (this.coach) this.coach.onView();
  }

  // ================================================================ annotations
  _onStore(change) {
    const now = new Map(this.store.annotations().map((a) => [a.annotation_id, a]));
    const prev = this._prev;
    this._prev = now;
    for (const [type, fields] of annotationEvents(change, prev, now, { sf: this.sf, via: logger.via(), autoMerged: this.store.lastAutoMerged })) {
      logger.event(type, fields);
    }
    const act = change.action;
    this.selection = this.selection.map((i) => (this.store.has(i) ? i : this.store.lastSurvivors.get(i))).filter((i) => i && this.store.has(i));
    this.viewer.setAnnotations(this.store.annotations());
    this.viewer.setSelection(this.selection);
    this._refreshList();
    this._refreshState();
    if (this.welcomeEl && act !== 'reset') { this.welcomeEl.remove(); this.welcomeEl = null; }
    this._refreshPrompt();
    if (this.coach) this.coach.scheduleCheck();
  }

  createAnnotation(t0, t1) {
    if (!this._checkEditable()) return null;
    const byChannel = this._marksChannels();
    if (byChannel && !this.selectedChannels.length) {
      this.say("No channels selected: click channel names, use 'Channels…', or choose 'Whole montage'.");
      return null;
    }
    const channels = byChannel ? [...this.selectedChannels] : [];
    let ann;
    try {
      ann = this.store.addInterval(this.currentLabel, t0, t1, channels);
    } catch (exc) {
      if (exc instanceof AnnotationError) { this.say(`Annotation not created: ${exc.message}`); return null; }
      throw exc;
    }
    this._revealRow(ann.annotation_id);
    this.lastMadeId = ann.annotation_id;
    const where = ann.channels.length ? plural(ann.channels.length, 'channel') : 'whole montage';
    const span = `${(ann.onset_sample / this.sf).toFixed(3)}–${(endSample(ann) / this.sf).toFixed(3)} s`;
    if (this.store.lastAutoMerged) {
      this.say(`Merged with ${plural(this.store.lastAutoMerged, `overlapping ${ann.label} annotation`)} on the same channels: now ${span} (${where}). ${undoHint()}.`);
    } else {
      this.say(`Added ${ann.label} ${span} (${where})`);
    }
    this._afterNewMark(ann); // in an every-mark study the confidence prompt follows (its line replaces the one above)
    return ann.annotation_id;
  }

  applyType(name) {
    this.cat.get(name);
    const ids = this.targetIds();
    if (ids.length && !this.readOnly) {
      if (!this._checkEditable()) { this._refreshState(); return; }
      if (ids.every((i) => this.store.get(i).label === name)) {
        this.say(`Already ${name}`);
      } else {
        this.store.setLabelMany(ids, name);
        const what = ids.length === 1 ? 'the selected annotation' : `${ids.length} annotations`;
        this.say(`Changed ${what} to ${name} (${undoHint()}). Esc or a click on empty EEG ends the selection.`);
      }
    } else {
      this.setCurrentLabel(name);
      this.say(`Next: ${name}. Drag across the EEG, or press M at the start and again at the end.`);
    }
    this._refreshState();
  }

  async findType() {
    const ids = this.targetIds();
    const current = ids.length ? this.store.get(ids[0]).label : this.currentLabel;
    const title = ids.length ? (ids.length === 1 ? 'Change the selected annotation to' : `Change ${ids.length} annotations to`) : 'Type of the next annotation';
    const r = this.typeMenuBtn ? this.typeMenuBtn.getBoundingClientRect() : null;
    const chosen = await pickType({ title, catalogue: this.cat, current, quick: this.quick, at: r ? { x: r.left, y: r.bottom + 4 } : null });
    if (chosen) { logger.noteInput('dialog:' + title); this.applyType(chosen); }
  }

  async changeTypeOf(id, at) {
    if (this.readOnly || !this.store.has(id)) return;
    this.select([id]);
    if (!this._checkEditable()) return;
    const current = this.store.get(id).label;
    const chosen = await pickType({ title: `Change ${current} to`, catalogue: this.cat, current, quick: this.quick, at });
    if (chosen && chosen !== current) { logger.noteInput(`dialog:Change ${current} to`); this.applyType(chosen); }
  }

  openTypeMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const ids = this.targetIds();
    const shown = ids.length ? this.store.get(ids[0]).label : this.currentLabel;
    const items = [];
    for (const s of this.cat.sections()) {
      items.push({ section: s.section });
      for (const l of s.labels) {
        items.push({ label: `${l.label}  (${l.value})`, swatch: l.colour, italic: l.is_group, checked: l.label === shown,
          title: l.description, onSelect: () => { logger.noteInput(`menu:${l.label}`); this.applyType(l.label); } });
      }
    }
    items.push({ separator: true }, { label: 'Find a type…', shortcut: '/', onSelect: () => this.findType() });
    showMenu(items, r.left, r.bottom + 2, { className: 'type-menu-list', minWidth: Math.max(300, r.width), opener: anchor });
  }

  showContextMenu(id, x, y) {
    if (!this._checkEditable()) return;
    const a = this.store.get(id);
    const items = [{ section: a.label }];
    this.quick.forEach((name, i) => {
      const l = this.cat.get(name);
      items.push({ label: `${l.label}  (${l.value})`, swatch: l.colour, shortcut: touchFirst() ? null : String(i + 1), disabled: name === a.label, title: l.description,
        onSelect: () => { logger.noteInput(`menu:${l.label}`); this.relabel(id, name); } });
    });
    const sub = [];
    for (const s of this.cat.sections()) {
      sub.push({ section: s.section });
      for (const l of s.labels) sub.push({ label: `${l.label}  (${l.value})`, swatch: l.colour, italic: l.is_group, checked: l.label === a.label,
        onSelect: () => { logger.noteInput(`menu:${l.label}`); this.relabel(id, l.label); } });
    }
    items.push({ label: this.quick.length ? 'Other type' : 'Change type to', submenu: sub });
    items.push({ separator: true }, { label: 'Edit times…', onSelect: () => { this.select([id]); this.editTimesOfSelected(); } },
      { label: 'Edit channels…', onSelect: () => this.editChannelsOf(id) }, ...this._confidenceMenuItems(id, a));
    if (a.channels.length) items.push({ label: 'Apply to whole montage', onSelect: () => { logger.noteInput('menu:Apply to whole montage'); this.setAnnotationChannels(id, []); } });
    items.push({ separator: true }, { label: 'Delete', onSelect: () => { logger.noteInput('menu:Delete'); this.deleteOne(id); } });
    showMenu(items, x, y);
  }

  relabel(id, label) {
    if (this._checkEditable()) this.store.setLabel(id, label);
  }

  setAnnotationChannels(id, channels) {
    if (!this._checkEditable()) return;
    try {
      const a = this.store.setChannels(id, channels);
      this.say(a.channels.length ? `${a.label}: channels ${a.channels.join(', ')}` : `${a.label}: now applies to the whole montage`);
    } catch (exc) {
      inform('Channels not changed', exc.message);
    }
  }

  /** Shift+click (or a click on a name, with a channel-specific annotation selected): that channel in or out. */
  toggleAnnotationChannel(id, ch) {
    if (!this._checkEditable()) return;
    try {
      const before = this.store.get(id);
      const a = this.store.toggleChannel(id, ch);
      const where = !a.channels.length ? 'now applies to the whole montage'
        : !before.channels.length ? `every channel but ${ch} (${plural(a.channels.length, 'channel')})`
          : `${a.channels.includes(ch) ? `${ch} added` : `${ch} taken out`}; ${a.channels.length === 1 ? 'channel' : 'channels'} ${namesText(a.channels)}`;
      this.select([a.annotation_id], { via: logger.via() });
      this.say(`${a.label}: ${where} (${undoHint()}).`);
    } catch (exc) {
      this.say(exc.message);
    }
  }

  deleteOne(id) {
    if (!this._checkEditable()) return;
    const a = this.store.get(id);
    this.store.delete(id);
    this.select(null);
    this.say(`Deleted ${a.label} (${undoHint()})`);
  }

  deleteSelection() {
    if (!this._checkEditable()) return;
    const ids = this.targetIds();
    if (ids.length > 1) { this.deleteSelectedRows(); return; }
    if (!ids.length) { this.say(`Nothing is selected: click an annotation (or press N) to select it${touchFirst() ? '' : `, or press ${CTRL}+Z to undo the last change`}.`); return; }
    this.deleteOne(ids[0]);
  }

  deleteSelectedRows() {
    const ids = this.targetIds();
    if (!ids.length || !this._checkEditable()) return;
    this.store.deleteMany(ids);
    this.select(null);
    this.say(`Deleted ${plural(ids.length, 'annotation')} (${undoHint()})`);
  }

  undo() {
    if (!this._checkEditable()) return;
    const what = this.store.undo();
    this.say(what ? `Undid: ${what}` : 'Nothing to undo');
  }

  redo() {
    if (!this._checkEditable()) return;
    const what = this.store.redo();
    this.say(what ? `Redid: ${what}` : 'Nothing to redo');
  }

  mergeSelected() {
    const ids = this.targetIds();
    if (!this._checkEditable()) return;
    try {
      const merged = this.store.merge(ids);
      this.select([merged.annotation_id]);
      this.say(`Merged ${ids.length} annotations into one ${merged.label} (${undoHint()})`);
    } catch (exc) {
      inform('Cannot merge', exc.message);
    }
  }

  async relabelSelected() {
    const ids = this.targetIds();
    if (!ids.length || !this._checkEditable()) return;
    const current = this.store.get(ids[0]).label;
    const label = await pickType({ title: ids.length === 1 ? 'Change type' : `Change the type of ${ids.length} annotations`, catalogue: this.cat, current, quick: this.quick });
    if (!label || (label === current && ids.length === 1)) return;
    logger.noteInput('dialog:Change type');
    this.store.setLabelMany(ids, label);
  }

  async editTimesOfSelected() {
    const ids = this.targetIds();
    if (ids.length !== 1 || !this._checkEditable()) return;
    const a = this.store.get(ids[0]);
    const v = await editTimes({ start: a.onset_sample / this.sf, end: endSample(a) / this.sf, sfreq: this.sf, duration: this.s.recording.durationS, note: a.note || '' });
    if (!v) return;
    logger.noteInput('dialog:Edit times');
    try {
      if (!this.store.has(ids[0])) return;
      const [on, dur] = this.store.snapInterval(v[0], v[1]);
      const cur = this.store.get(ids[0]);
      const moved = on !== cur.onset_sample || dur !== cur.duration_samples;
      const noted = v[2] !== (cur.note || '');
      this.store.update(ids[0], { onset_sample: on, duration_samples: dur, note: v[2],
        description: moved && noted ? 'move/resize and note' : moved ? 'move/resize' : (cur.note ? (v[2] ? 'change note' : 'remove note') : 'add note') });
    } catch (exc) {
      inform('Times not changed', exc.message);
    }
  }

  async editChannelsOf(id) {
    if (!this.store.has(id) || !this._checkEditable()) return;
    const a = this.store.get(id);
    const chosen = await chooseChannels({ title: `Channels affected by this ${a.label}`, channels: this.s.channels, chosen: a.channels,
      allowWholeMontage: true, wholeMontage: !a.channels.length, map: this._channelMapOptions() });
    if (!chosen) return;
    logger.noteInput(`dialog:Channels affected by this ${a.label}`);
    if (!chosen.wholeMontage && !chosen.channels.length) { inform('Channels not changed', 'Choose at least one channel, or Whole montage.'); return; }
    this.setAnnotationChannels(id, chosen.wholeMontage ? [] : chosen.channels);
  }

  async chooseChannelsForNew() {
    const chosen = await chooseChannels({ title: 'Channels for new annotations', channels: this.s.channels, chosen: this.selectedChannels, map: this._channelMapOptions() });
    if (!chosen) return;
    logger.noteInput('dialog:Channels for new annotations');
    this.setSelectedChannels(chosen.channels);
    this.setScope('channels');
  }

  jumpTo(id, { keepSelection = false } = {}) {
    if (!this.store.has(id)) return;
    const a = this.store.get(id);
    this.viewer.showInterval(a.onset_sample, a.duration_samples, a.channels);
    if (!keepSelection) this.select([id]);
    this._revealRow(id);
  }

  stepSelection(step) {
    const anns = [...this.store.annotations()].sort((a, b) => a.onset_sample - b.onset_sample || endSample(a) - endSample(b) || (a.annotation_id < b.annotation_id ? -1 : 1));
    if (!anns.length) { this.say('There are no annotations yet'); return; }
    const ids = anns.map((a) => a.annotation_id);
    const cur = this.selection.length === 1 ? ids.indexOf(this.selection[0]) : -1;
    let i;
    if (cur >= 0) i = cur + step;
    else {
      // Nothing selected: the first annotation that reaches into the screen (N), or the last that starts before its end (P).
      const v = this.viewer.view;
      if (step > 0) { const k = anns.findIndex((a) => endSample(a) / this.sf > v.startS + 1e-9); i = k >= 0 ? k : anns.length; }
      else { let k = -1; anns.forEach((a, j) => { if (a.onset_sample / this.sf < v.startS + v.durationS) k = j; }); i = k; }
    }
    // Past the last (or before the first), N and P come round to the other end.
    let round = '';
    if (i >= anns.length) { i = 0; round = 'Back to the first annotation. '; }
    else if (i < 0) { i = anns.length - 1; round = 'Back to the last annotation. '; }
    const a = anns[i];
    this.jumpTo(a.annotation_id);
    const what = touchFirst() ? '' : ' Press 1 to 9 to change its type, Delete to remove it, N or P to move on.';
    this.say(`${round}${i + 1} of ${anns.length}: ${a.label} ${this._spanText(a)}.${what}`);
  }

  // ====================================================================== marks
  markKey(kind) {
    // The time under the pointer now (the EEG may have scrolled since the pointer last moved), or,
    // with the pointer elsewhere, the time cursor (a click, G, or the , and . keys), so that the
    // keyboard alone can mark an artifact.
    const p = this.pointerXY ? this.viewer.hit(this.pointerXY.x, this.pointerXY.y) : null;
    const cursor = this.viewer.cursorT ?? null;
    const keyed = cursor !== null && (this._cursorKeyedAt || 0) > (this._pointerMovedAt || 0); // moved by key since the pointer last moved
    const t = p && p.area === 'eeg' && !keyed ? p.t : cursor;
    if (t === null || t === undefined) {
      const where = kind === 'end' || (kind === 'toggle' && this.markStart !== null) ? 'ends' : 'starts';
      const key = { start: '[', end: ']' }[kind] || 'M';
      this.say(`Point at the EEG where the artifact ${where}, or place the time cursor there (click, G, or the , and . keys), then press ${key}.`);
      return;
    }
    if (kind === 'start') this.startMark(t);
    else if (kind === 'end') this.endMark(t);
    else if (this.markStart === null) this.startMark(t);
    else this.endMark(t);
  }

  startMark(t) {
    if (!this._checkEditable()) return;
    this.cancelMark(true);
    if (this.selection.length) this.select(null);
    t = this._snapTime(t); // the time it will be saved at, to the sample
    this.markStart = t;
    this.viewer.setMarkStart(t, this.cat.colourFor(this.currentLabel));
    this._logState({ mark_start_s: Math.round(t * 1000) / 1000 });
    this._showPendingMark();
    this.say(`Start of ${this.currentLabel} marked at ${t.toFixed(3)} s. Point at the end (scroll if you need to) and press M again. Esc cancels.`);
  }

  /** A time in seconds at its nearest sample, as the annotation store keeps it. */
  _snapTime(t) {
    const n = this.s.recording.nSamples;
    return clamp(Math.floor(clamp(t, 0, this.s.recording.durationS) * this.sf + 0.5), 0, n) / this.sf;
  }

  /** While a mark started with M or [ waits for its end: a note over the EEG that stays when the start scrolls out of sight. */
  _showPendingMark() {
    if (!this.pendingEl) {
      this.pendingEl = h('p.mark-pending', { 'data-log': 'mark-pending', hidden: true });
      this.eegHost.append(this.pendingEl);
    }
    const on = this.markStart !== null;
    this.pendingEl.hidden = !on;
    if (on) this.pendingEl.textContent = `Marking ${this.currentLabel} from ${this.markStart.toFixed(3)} s (${clockText(this.markStart)}) · M or ] at the end · Esc cancels`;
  }

  /** , and . (Shift: ten times as far): move the time cursor, which M, [ and ] use when the pointer is not on the EEG. */
  nudgeCursor(dir, big = false) {
    const v = this.viewer;
    const step = v.view.durationS * (big ? 0.1 : 0.01);
    const from = v.cursorT === null || v.cursorT === undefined ? v.view.startS + v.view.durationS / 2 : v.cursorT + dir * step;
    const t = this._snapTime(from);
    v.setCursor(t);
    this._cursorKeyedAt = performance.now();
    if (t < v.view.startS || t > v.view.startS + v.view.durationS) v.setView({ startS: centredStart(t, v.view.durationS) }, 'key');
    this.say(`Time cursor at ${t.toFixed(3)} s. M, [ and ] mark at the time cursor while the pointer is away from the EEG.`, 4000);
  }

  endMark(t) {
    if (this.markStart === null) { this.say('Press M (or [) with the pointer at the start of the artifact first, then M (or ]) at its end.'); return; }
    const start = this.markStart;
    this.cancelMark(true);
    t = clamp(t, 0, this.s.recording.durationS);
    if (Math.abs(t - start) < 1e-9) {
      this.say('The start and end are at the same time: point at the end of the artifact and press M.');
      this.startMark(start);
      return;
    }
    this.createAnnotation(Math.min(start, t), Math.max(start, t));
  }

  cancelMark(quiet = false) {
    const had = this.markStart !== null;
    this.markStart = null;
    this.viewer.setMarkStart(null);
    if (this.pendingEl) this.pendingEl.hidden = true;
    if (had) { this._logState({ mark_start_s: null }); if (!quiet) this.say('Mark cancelled'); }
    return had;
  }

  escape() {
    if (!this.cancelMark()) this.select(null);
  }

  // ============================================================ mouse and touch
  /** A review pass marks stretches without an annotation by dragging across the read-only EEG. */
  _marksRanges() { return Boolean(this.readOnly && this.review && this.review.onRange); }

  _pointer(type, info, e) {
    if (type === 'pointermove' || type === 'pointerleave' || type === 'pointerdown') this._noteReadout(type, e);
    if (type === 'pointermove' || type === 'pointerleave') this.pointerXY = info && info.area === 'eeg' ? { x: e.clientX, y: e.clientY } : null;
    if (type === 'pointermove') this._pointerMovedAt = performance.now();
    const g = this.gesture;
    if (type === 'cancel') {
      // A second finger on the EEG (it moves the view instead) or the browser took the touch back.
      this.gesture = null;
      if (g && g.kind === 'draw') this.viewer.setDragPreview(null);
      if (g && (g.kind === 'resize' || g.kind === 'move')) this.viewer.setAnnotations(this.store.annotations());
      return;
    }
    if (type === 'longpress') {
      // On a touch screen, a long press on an annotation is the right-click: its menu.
      if (!info || !info.annotation || this.readOnly || (g && g.moved)) return;
      this.gesture = null;
      logger.noteInput('eeg_long_press');
      this.select([info.annotation], { via: 'eeg_click' });
      this.showContextMenu(info.annotation, e.clientX, e.clientY);
      return;
    }
    if (type === 'contextmenu') {
      e.preventDefault();
      if (info && info.annotation && !this.readOnly) { this.select([info.annotation], { via: 'eeg_click' }); this.showContextMenu(info.annotation, e.clientX, e.clientY); }
      return;
    }
    if (type === 'dblclick') {
      if (info && info.annotation) {
        logger.noteInput(e.pointerType && e.pointerType !== 'mouse' ? 'eeg_double_tap' : 'eeg_double_click');
        this.changeTypeOf(info.annotation, { x: e.clientX + 4, y: e.clientY + 4 });
      }
      return;
    }
    if (type === 'pointerdown') {
      if (e.button !== 0 || !info) return;
      this.viewer.over.focus({ preventScroll: true });
      if (info.area === 'channel_names') { if (info.channel) { logger.noteInput('eeg_click'); this.onChannelClicked(info.channel); } return; }
      if (info.area === 'tags') { logger.noteInput('eeg_click'); this.select([info.tag], { via: 'eeg_click' }); return; }
      if (info.area !== 'eeg') return;
      this.viewer.over.setPointerCapture(e.pointerId);
      if (info.edge && info.annotation && this.editable) {
        const a = this.store.get(info.annotation);
        this.select([a.annotation_id], { via: 'eeg_click' });
        this.gesture = { kind: 'resize', id: a.annotation_id, edge: info.edge, a, x: info.x, moved: false };
        return;
      }
      if (e.shiftKey) {
        // Shift+click a channel inside an annotation: the selected one wherever its time span is (so that
        // a channel can be added on any row), otherwise the one under the pointer. Shift+drag moves it.
        const id = this._shiftTarget(info);
        if (id) { this.gesture = { kind: 'shift', id, x: info.x, t: info.t, channel: info.channel, moved: false }; return; }
      }
      this.gesture = { kind: 'press', x: info.x, t: info.t, info, moved: false, shift: e.shiftKey };
      return;
    }
    if (type === 'pointermove') {
      this._hoverCursor(info, e);
      if (!g || !info) return;
      const dx = Math.abs(info.x - g.x);
      if (g.kind === 'press') {
        if (!g.moved && dx > DRAG_PX && !this.editable && !this.readOnly && !g.warned) { g.warned = true; this.say(DRAWING_OFF); }
        if (!g.moved && dx > DRAG_PX && (this.editable || this._marksRanges())) {
          g.moved = true;
          g.kind = 'draw';
          this.cancelMark(true);
          if (this.selection.length) this.select(null);
          g.colour = this._marksRanges() ? this.review.rangeColour : this.cat.colourFor(this.currentLabel);
        }
      }
      if (g.kind === 'draw') {
        const t = clamp(info.t, 0, this.s.recording.durationS);
        this.viewer.setDragPreview({ t0: g.t, t1: t, colour: g.colour, channels: this._marksChannels() ? this.selectedChannels : [] });
        g.t1 = t;
      } else if (g.kind === 'resize') {
        if (dx > 1) g.moved = true;
        const a = g.a;
        const s = clamp(Math.floor(info.t * this.sf + 0.5), 0, this.s.recording.nSamples);
        let start = a.onset_sample; let stop = endSample(a);
        if (g.edge === 'start') start = s; else stop = s;
        g.range = [Math.min(start, stop), Math.max(start, stop)];
        this._preview(a, g.range[0], Math.max(1, g.range[1] - g.range[0]));
      } else if (g.kind === 'shift') {
        if (!g.moved && dx > DRAG_PX && this.editable) { g.moved = true; g.kind = 'move'; g.a = this.store.get(g.id); this.select([g.id], { via: 'eeg_drag' }); }
      }
      if (g.kind === 'move') {
        const a = g.a;
        const delta = Math.round((info.t - g.t) * this.sf);
        const on = clamp(a.onset_sample + delta, 0, this.s.recording.nSamples - a.duration_samples);
        g.onset = on;
        this._preview(a, on, a.duration_samples);
      }
      return;
    }
    if (type === 'pointerup') {
      this.gesture = null;
      if (!g) return;
      if (g.kind === 'draw') {
        this.viewer.setDragPreview(null);
        logger.noteInput('eeg_drag');
        if (g.t1 !== undefined && this._marksRanges()) this.review.onRange(Math.min(g.t, g.t1), Math.max(g.t, g.t1));
        else if (g.t1 !== undefined) this.createAnnotation(Math.min(g.t, g.t1), Math.max(g.t, g.t1));
      } else if (g.kind === 'resize') {
        if (g.moved && g.range) {
          logger.noteInput('eeg_drag');
          this._applyEdit(() => this.store.setSamples(g.id, g.range[0], g.range[1]));
        } else this.viewer.setAnnotations(this.store.annotations());
      } else if (g.kind === 'move') {
        logger.noteInput('eeg_drag');
        this._applyEdit(() => this.store.update(g.id, { onset_sample: g.onset, description: 'move/resize' }));
      } else if (g.kind === 'shift') {
        logger.noteInput('eeg_click');
        if (g.channel) this.toggleAnnotationChannel(g.id, g.channel);
      } else if (g.kind === 'press') {
        logger.noteInput('eeg_click');
        const i = g.info;
        if (i.annotation && !g.shift) { this.select([i.annotation], { via: 'eeg_click' }); this.viewer.setCursor(null); }
        else {
          if (this.selection.length) this.select(null, { via: 'eeg_click' });
          // With Selected channels, a click on a trace chooses its channel; otherwise the click only places the time cursor.
          if (g.shift && this.editable) this.say('Shift+click a channel inside an annotation to add that channel to it or take it out.');
          else if (i.nearTrace && i.channel && this.scope === 'channels' && !this.viewer.overlay) this.onChannelClicked(i.channel);
          this.viewer.setCursor(i.t);
        }
      }
    }
  }

  /** The annotation a Shift+click acts on: the one selected, when the click is within its time span, or else the one under the pointer. */
  _shiftTarget(info) {
    const ids = this.targetIds();
    if (ids.length === 1 && info.channel) {
      const a = this.store.get(ids[0]);
      if (info.sample >= a.onset_sample && info.sample <= endSample(a)) return a.annotation_id;
    }
    return info.annotation || null;
  }

  _preview(a, onset, dur) {
    const list = this.store.annotations().map((x) => (x.annotation_id === a.annotation_id ? { ...x, onset_sample: onset, duration_samples: dur } : x));
    this.viewer.setAnnotations(list);
  }

  _applyEdit(fn) {
    if (!this._checkEditable()) { this.viewer.setAnnotations(this.store.annotations()); return; }
    try {
      const ann = fn();
      if (this.store.lastAutoMerged && ann) {
        this.select([ann.annotation_id]);
        this.say(`Merged with ${plural(this.store.lastAutoMerged, `overlapping ${ann.label} annotation`)}: now ${this._spanText(ann)} (${undoHint()}).`);
      } else if (ann) {
        this.say(`${ann.label} now ${this._spanText(ann)} (${undoHint()}).`);
      }
    } catch (exc) {
      this.say(`Change not applied: ${exc.message}`);
    }
    this.viewer.setAnnotations(this.store.annotations());
  }

  /** "3.008–3.604 s", as the Annotations list shows an annotation's times. */
  _spanText(a) { return `${(a.onset_sample / this.sf).toFixed(3)}–${(endSample(a) / this.sf).toFixed(3)} s`; }

  _hoverCursor(info, e) {
    const c = this.viewer.over;
    let cursor = 'default';
    if (info && info.area === 'eeg') {
      if (this.gesture && (this.gesture.kind === 'resize')) cursor = 'ew-resize';
      else if (this.gesture && this.gesture.kind === 'move') cursor = 'grabbing';
      else if (info.edge && this.editable) cursor = 'ew-resize';
      else if ((info.annotation || this._shiftTarget(info)) && e.shiftKey && this.editable) cursor = 'move';
      else if (info.annotation && !this.editable) cursor = 'pointer';
      else cursor = this.editable ? 'crosshair' : 'default';
    } else if (info && (info.area === 'channel_names' || info.area === 'tags')) cursor = 'pointer';
    if (c.style.cursor !== cursor) c.style.cursor = cursor;
    this._noteTooltip(info);
  }

  // ===================================================== confidence and notes
  /** The annotations D and the table's control rate: the selected ones, or the one made last. */
  _confidenceTargets() {
    const ids = this.targetIds();
    if (ids.length) return ids;
    return this.lastMadeId && this.store.has(this.lastMadeId) ? [this.lastMadeId] : [];
  }

  /** True where an every-mark study asks for a rating: study recordings annotated and saved here. */
  get _asksEveryMark() {
    return this.s.confidenceMode === 'every_mark' && this.kind === 'annotate' && this.s.mode === 'standard' && !this.readOnly;
  }

  /** D: the prompt for the selected or newest annotation, answered with a digit from 1 to 5 (0 clears). */
  askConfidence() {
    if (!this._checkEditable()) return;
    // The annotation an every-mark study asks about (its bar is open), else the selected ones or the one made last.
    const ids = this._prompt && !this._prompt.captures ? this._prompt.ids : this._confidenceTargets();
    if (!ids.length) { this.say('Select an annotation (click it, or press N), then press D and a number from 1 to 5.'); return; }
    this.startConfidencePrompt(ids, 'key');
  }

  /** In an every-mark study, the prompt opens for each new mark; carrying on without answering leaves it unrated. */
  _afterNewMark(ann) {
    if (this._asksEveryMark) this.startConfidencePrompt([ann.annotation_id], 'new_mark');
  }

  /**
   * The confidence prompt, with its bar beside the annotations it asks about, which are outlined on the
   * EEG. After D (and in Rate them) it is a short mode in which the keys 1 to 5 rate (and do not choose a
   * type), 0 clears and Esc cancels; any other key ends it and does what it does. After a new mark in an
   * every-mark study it only offers the bar: the number keys keep choosing the type, D then a number or
   * a tap on the bar rates, and Later or Esc leaves the mark unrated. It never ends by itself.
   */
  startConfidencePrompt(ids, trigger) {
    this._endConfidencePrompt('replaced');
    const live = ids.filter((i) => this.store.has(i));
    if (!live.length) return;
    const first = this.store.get(live[0]);
    const what = live.length === 1 ? first.label : `${live.length} annotations`;
    const captures = trigger !== 'new_mark';
    this._prompt = { ids: live, trigger, captures, markers: this.viewer.markers || [] };
    const touch = touchFirst();
    this.say(touch ? `Confidence for ${what}: tap a number from 1 to 5 on the bar, or Later.`
      : captures ? `Confidence for ${what}: press 1–5, 0 to clear, Esc to cancel.`
        : `Confidence for ${what}: press D and then 1–5, or click a number on the bar. Later or Esc leaves it unrated.`, 600000);
    this.viewer.setMarkers([...this._prompt.markers, ...live.map((i) => { const a = this.store.get(i); return { onset_sample: a.onset_sample, duration_samples: a.duration_samples, outline: true, current: true }; })]);
    this._showConfidenceBar(what, live.length === 1 ? first.confidence : null);
  }

  _endConfidencePrompt(outcome, level = null) {
    const p = this._prompt;
    if (!p) return;
    this._prompt = null;
    if (this.confBar) this.confBar.hidden = true;
    this.viewer.setMarkers(p.markers);
    if (outcome !== 'rated' && outcome !== 'cleared' && outcome !== 'replaced' && this.msgEl.textContent.startsWith('Confidence for')) this._clearMessage();
    logger.event('confidence_prompt', { trigger: p.trigger, outcome, n_annotations: p.ids.length, ...(level ? { confidence: level } : {}) });
    if (p.trigger === 'rate_them' && outcome === 'rated') this._rateNextUnrated();
    else if (p.trigger === 'rate_them' && outcome === 'cancelled') {
      const left = this.store.annotations().filter((a) => !isConfidence(a.confidence)).length;
      this.say(`Rating stopped: ${plural(left, 'annotation')} still without a confidence.`);
    }
  }

  /** The answer to the prompt: a rating from 1 to 5, or null to clear. */
  _answerPrompt(level) {
    const p = this._prompt;
    if (!p) return;
    this.setConfidenceOf(p.ids, level);
    this._endConfidencePrompt(level ? 'rated' : 'cleared', level);
  }

  /** The keys while the prompt is open; false lets any other key end it and do what it does. */
  _confidencePromptKey(e, handled) {
    if (!this._prompt) return false;
    const k = e.key;
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(k)) return false;
    if (!this._prompt.captures) {
      // The bar after a new mark: only Esc is its own; every other key keeps its meaning (D rates).
      if (k !== 'Escape') return false;
      handled('Later', () => { this._endConfidencePrompt('later'); this.say('Left without a confidence. D and a number rate it later.'); });
      return true;
    }
    if (/^[0-5]$/.test(k) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      handled(k === '0' ? 'Clear confidence' : `Confidence ${k}`, () => this._answerPrompt(Number(k) || null));
      return true;
    }
    if (k === 'Escape') {
      handled('Cancel confidence', () => { const walk = this._prompt.trigger === 'rate_them'; this._endConfidencePrompt('cancelled'); if (!walk) this.say('No confidence given'); });
      return true;
    }
    this._endConfidencePrompt('other_input');
    return false;
  }

  /** The prompt's small bar over the top of the EEG: 1 to 5, Clear and Later, for a finger or the mouse. */
  _showConfidenceBar(what, current) {
    if (!this.confBar) {
      this.confBarLabel = h('span.conf-prompt-label');
      this.confBarSegs = CONFIDENCE_LEVELS.map((lv) => h('button.seg', { type: 'button', 'data-level': String(lv), 'data-log': `confidence-prompt-${lv}`,
        title: `${lv}: ${CONFIDENCE_ANCHORS[lv]}`, 'aria-pressed': 'false', onclick: () => this._answerPrompt(lv) }, String(lv)));
      this.confBar = h('div.conf-prompt', { hidden: true, role: 'group', 'aria-label': 'Confidence, from 1 (not at all confident) to 5 (completely confident)', 'data-log': 'confidence-prompt' },
        this.confBarLabel, h('div.segmented', {}, ...this.confBarSegs),
        h('button.btn.small.quiet', { type: 'button', 'data-log': 'confidence-prompt-clear', onclick: () => this._answerPrompt(null) }, 'Clear'),
        h('button.btn.small.quiet', { type: 'button', 'data-log': 'confidence-prompt-later', onclick: () => this._endConfidencePrompt('later') }, 'Later'));
      this.main.append(this.confBar);
    }
    this.confBarLabel.textContent = `Confidence for ${what}`;
    for (const b of this.confBarSegs) b.setAttribute('aria-pressed', String(Number(b.dataset.level) === current));
    this.confBar.hidden = false;
    this._placeConfidenceBar();
  }

  /**
   * The bar goes beside the annotations it asks about, just under the band of labels, so that it hides
   * neither their tags nor their stretch of EEG: after their end, or before their start when there is
   * no room after it; centred at the foot of the EEG when there is room on neither side.
   */
  _placeConfidenceBar() {
    const p = this._prompt;
    const bar = this.confBar;
    if (!p || !bar || bar.hidden) return;
    const v = this.viewer;
    const anns = p.ids.filter((i) => this.store.has(i)).map((i) => this.store.get(i));
    if (!anns.length) return;
    const host = this.main.getBoundingClientRect();
    const over = v.over.getBoundingClientRect();
    const left0 = over.left - host.left;
    const top0 = over.top - host.top;
    const w = bar.offsetWidth;
    const hgt = bar.offsetHeight;
    const xa = left0 + v.sampleToX(Math.min(...anns.map((a) => a.onset_sample)));
    const xb = left0 + v.sampleToX(Math.max(...anns.map(endSample)));
    const lo = left0 + v.x0 + 4;
    const hi = left0 + v.x1 - 4;
    const gap = 12;
    let x;
    let y = top0 + v.y0 + 4;
    if (xb + gap + w <= hi) x = Math.max(lo, xb + gap);
    else if (xa - gap - w >= lo) x = Math.min(hi - w, xa - gap - w);
    else { x = Math.max(lo, Math.min(hi - w, (xa + xb) / 2 - w / 2)); y = top0 + v.y1 - hgt - 4; }
    Object.assign(bar.style, { left: `${Math.round(x)}px`, top: `${Math.round(y)}px`, transform: 'none' });
  }

  /** After a change: a prompt about annotations that are gone ends; otherwise its outline follows them. */
  _refreshPrompt() {
    const p = this._prompt;
    if (!p) return;
    if (!p.ids.every((i) => this.store.has(i))) { this._endConfidencePrompt('deleted'); return; }
    this.viewer.setMarkers([...p.markers, ...p.ids.map((i) => { const a = this.store.get(i); return { onset_sample: a.onset_sample, duration_samples: a.duration_samples, outline: true, current: true }; })]);
    this._placeConfidenceBar();
  }

  /** A rating from the menu or the table: it answers the prompt when the prompt is about the same annotations. */
  _rateFromControl(ids, level) {
    const p = this._prompt;
    if (p && p.ids.length === ids.length && p.ids.every((x, i) => x === ids[i])) this._answerPrompt(level);
    else this.setConfidenceOf(ids, level);
  }

  /** Rate annotations from 1 to 5, or clear their rating with null. */
  setConfidenceOf(ids, level) {
    if (!this._checkEditable()) return;
    const live = ids.filter((i) => this.store.has(i));
    if (!live.length) return;
    this.store.setConfidenceMany(live, level);
    const what = live.length === 1 ? this.store.get(live[0]).label : `${live.length} annotations`;
    this.say(level ? `Confidence of ${what}: ${level}/5, ${CONFIDENCE_ANCHORS[level].toLowerCase()} (${undoHint()})` : `Confidence of ${what} cleared (${undoHint()})`);
  }

  /** Before Save and Finish in an every-mark study: the marks without a rating, with Rate them and Save anyway. */
  async _confidenceCheck(s) {
    if (!this._asksEveryMark || s.revision) return true;
    const n = this.store.annotations().filter((a) => !isConfidence(a.confidence)).length;
    if (!n) return true;
    const body = h('div', {},
      h('p.dialog-text', {}, `${n === 1 ? '1 annotation has' : `${n} annotations have`} no confidence. This study asks for a confidence rating, from 1 (not at all confident) to 5 (completely confident), on every annotation.`),
      h('p.dialog-text', {}, `Rate ${n === 1 ? 'it' : 'them'} now, one after another with a key from 1 to 5 or a tap, or save without a rating.`));
    const choice = await showDialog({ title: 'Annotations without a confidence', body, className: 'confidence-check', logText: `${plural(n, 'annotation')} without a confidence`,
      buttons: [{ label: 'Save anyway', value: 'save' }, { label: 'Rate them', value: 'rate', kind: 'primary' }], cancelValue: 'cancel' });
    logger.event('confidence_check', { n_unrated: n, n_annotations: this.store.size, choice });
    if (choice === 'rate') this._rateNextUnrated();
    return choice === 'save';
  }

  /** Rate them: the first mark without a rating is selected, brought into view and asked about; then the next. */
  _rateNextUnrated() {
    const next = this.store.annotations().find((a) => !isConfidence(a.confidence));
    if (!next) { this.say('Every annotation has a confidence now. Press Save and Finish when you are ready.'); return; }
    this.select([next.annotation_id], { via: 'confidence_check' });
    this.jumpTo(next.annotation_id, { keepSelection: true });
    this.viewer.over.focus({ preventScroll: true });
    this.startConfidencePrompt([next.annotation_id], 'rate_them');
  }

  async editNoteOf(id) {
    if (!id || !this.store.has(id) || !this._checkEditable()) return;
    const a = this.store.get(id);
    const note = await editNote({ title: `Note on this ${a.label}`, note: a.note || '' });
    if (note === null || !this.store.has(id)) return;
    logger.noteInput(`dialog:Note on this ${a.label}`);
    try {
      const had = Boolean(this.store.get(id).note);
      this.store.setNote(id, note);
      // The note itself is never shown in the status line, which the interaction log records.
      this.say(note ? `Note ${had ? 'changed' : 'added'} (${note.length} characters)` : 'Note removed');
    } catch (exc) {
      inform('Note not kept', exc.message);
    }
  }

  /** The context menu's items: Confidence (1 to 5 with their anchors, and Clear) and Add a note… / Edit note…. */
  _confidenceMenuItems(id, a) {
    const levels = CONFIDENCE_LEVELS.map((lv) => ({ label: `${lv}  ${CONFIDENCE_ANCHORS[lv]}`, checked: a.confidence === lv,
      onSelect: () => { logger.noteInput(`menu:Confidence ${lv}`); this._rateFromControl([id], lv); } }));
    return [{ label: 'Confidence', shortcut: touchFirst() ? null : 'D', submenu: [...levels, { separator: true },
      { label: 'Clear', disabled: !isConfidence(a.confidence), onSelect: () => { logger.noteInput('menu:Clear confidence'); this._rateFromControl([id], null); } }] },
    { label: a.note ? 'Edit note…' : 'Add a note…', onSelect: () => this.editNoteOf(id) }];
  }

  /** Below the Annotations table: the note button, and the confidence control (1 to 5 with one tap, and Clear). */
  _confidenceButtons(btn) {
    this.btnNote = btn('Add a note…', () => this.editNoteOf(this.targetIds()[0]));
    this.btnNote.dataset.log = 'note';
    this.confSegs = CONFIDENCE_LEVELS.map((lv) => h('button.seg', { type: 'button', 'data-level': String(lv), 'data-log': `confidence-${lv}`,
      title: `${lv}: ${CONFIDENCE_ANCHORS[lv]}`, 'aria-pressed': 'false', onclick: () => this._rateFromControl(this.targetIds(), lv) }, String(lv)));
    this.confClear = h('button.btn.small.quiet', { type: 'button', 'data-log': 'confidence-clear', onclick: () => this._rateFromControl(this.targetIds(), null) }, 'Clear');
    this.confRow = h('div.conf-row', { role: 'group', 'aria-label': 'Confidence of the selected annotation' },
      h('span.caption.conf-caption', {}, 'Confidence: 1 not at all, 5 completely'), h('div.segmented.conf-seg', {}, ...this.confSegs), this.confClear);
    return [this.btnNote, this.confRow];
  }

  _refreshConfidenceButtons(anns, editable) {
    if (!this.confRow) return;
    const levels = new Set(anns.map((a) => a.confidence ?? null));
    const shown = anns.length && levels.size === 1 ? [...levels][0] : null;
    for (const b of this.confSegs) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.level) === shown));
      b.disabled = !(editable && anns.length);
    }
    this.confClear.disabled = !(editable && anns.some((a) => isConfidence(a.confidence)));
    this.btnNote.textContent = anns.length === 1 && anns[0].note ? 'Edit note…' : 'Add a note…';
    this.btnNote.disabled = !(editable && anns.length === 1);
  }

  /** What a row of the Annotations table shows below the label, after the channels: the rating ("3/5") and a note icon. */
  _confidenceMarks(a) {
    const out = [];
    if (isConfidence(a.confidence)) out.push(h('span.conf-mark', { title: `Confidence ${a.confidence} of 5: ${CONFIDENCE_ANCHORS[a.confidence]}` }, `${a.confidence}/5`));
    if (a.note) out.push(h('span.note-mark', { title: a.note, 'aria-label': 'Has a note' }, icon('note')));
    return out;
  }

  /** On the EEG, the note of the annotation under the pointer as a tooltip. */
  _noteTooltip(info) {
    const c = this.viewer.over;
    const id = info && info.annotation;
    const note = id && this.store.has(id) ? this.store.get(id).note || '' : '';
    if ((c.title || '') !== note) { if (note) c.title = note; else c.removeAttribute('title'); }
  }

  // ======================================================================= keys
  _key(e) {
    if (dialogOpen() || isTyping(e.target) || !this.el.isConnected) return;
    // A part's own keys come first (a replay's Space, Home, - and =; a correction's J, K, R and L): keyHook(e) true when taken.
    if (this.keyHook && this.keyHook(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const pauseKey = !mod && !e.altKey && (k === 'b' || k === 'B' || k === 'Pause');
    if (this.clock && this.clock.paused) {
      // While paused only B (or the Resume button, which has the focus) goes on.
      if (pauseKey) { e.preventDefault(); logger.shortcut(keyName(e), 'Resume'); this.resume('key'); }
      return;
    }
    if (pauseKey && this.timed) {
      e.preventDefault();
      logger.shortcut(keyName(e), 'Pause');
      this.pause('key');
      return;
    }
    // Arrow keys on an option button or tab belong to that control.
    if (/^Arrow/.test(k) && e.target instanceof HTMLElement && e.target.matches('input, [role="tab"]')) return;
    const handled = (action, fn) => {
      e.preventDefault();
      if (action) logger.shortcut(keyName(e), action);
      fn();
    };
    if (this._confidencePromptKey(e, handled)) return;
    if (this.coach && !mod && (k === 'Enter' || k === ' ') && this.coach.takesContinueKey()) {
      return handled('Continue', () => this.coach.continue());
    }
    if (this.coach && !mod && !e.altKey && (k === 'h' || k === 'H') && this.coach.canShowMe()) {
      return handled('Show me', () => this.coach.showMe());
    }
    if (mod && !e.altKey) {
      const lk = k.toLowerCase();
      if (lk === 'z' && !e.shiftKey) return handled('Undo', () => this.undo());
      if ((lk === 'z' && e.shiftKey) || lk === 'y') return handled('Redo', () => this.redo());
      return;
    }
    if (e.altKey) return;
    if (this._viewKey(e, handled)) return;
    const v = this.viewer;
    switch (k) {
      case 'ArrowLeft': e.preventDefault(); v.scrollBy(-(e.shiftKey ? 1 : 0.25) * v.view.durationS, 'key'); return;
      case 'ArrowRight': e.preventDefault(); v.scrollBy((e.shiftKey ? 1 : 0.25) * v.view.durationS, 'key'); return;
      case 'ArrowUp': e.preventDefault(); v.scrollChannels(e.shiftKey ? -v.view.nChannels : -1, 'key'); return;
      case 'ArrowDown': e.preventDefault(); v.scrollChannels(e.shiftKey ? v.view.nChannels : 1, 'key'); return;
      case 'Home': e.preventDefault(); v.stepDuration(-1, 'key'); return;
      case 'End': e.preventDefault(); v.stepDuration(1, 'key'); return;
      case 'PageUp': e.preventDefault(); v.stepChannels(-1, 'key'); return;
      case 'PageDown': e.preventDefault(); v.stepChannels(1, 'key'); return;
      case '-': case '_': e.preventDefault(); v.scaleBy(1 / 1.25, 'key'); return;
      case '+': case '=': e.preventDefault(); v.scaleBy(1.25, 'key'); return;
      case '?': return handled('Help', () => this.showHelp());
      case 'Escape': return handled('Escape', () => { closeMenu(); this.escape(); });
      default: break;
    }
    if (this.review && this.review.onKey && this.review.onKey(e, k)) return; // a review pass's own keys (review_pass.js)
    if (this.review && (k === 'n' || k === 'N')) return handled('Next annotation', () => this.review.step(1));
    if (this.review && (k === 'p' || k === 'P')) return handled('Previous annotation', () => this.review.step(-1));
    if (k === 'n' || k === 'N') return handled('Next annotation', () => this.stepSelection(1));
    if (k === 'p' || k === 'P') return handled('Previous annotation', () => this.stepSelection(-1));
    if ((k === 'u' || k === 'U') && this.timed) return handled('Next part not yet viewed', () => this.nextUnviewed('key'));
    if (this.readOnly) return;
    const digit = /^[1-9]$/.test(k) ? Number(k) : null;
    if (digit && digit <= this.quick.length) {
      const name = this.quick[digit - 1];
      return handled(`Type ${digit}: ${name}`, () => this.applyType(name));
    }
    if (k === '/') return handled('Find a type…', () => this.findType());
    if (k === 'm' || k === 'M') return handled('Mark start, then end', () => this.markKey('toggle'));
    if (k === '[') return handled('Mark start', () => this.markKey('start'));
    if (k === ']') return handled('Mark end', () => this.markKey('end'));
    if (k === 'c' || k === 'C') return handled('Whole montage or selected channels', () => this.toggleScope());
    if (k === ',' || k === '<') return handled('Time cursor back', () => this.nudgeCursor(-1, e.shiftKey || k === '<'));
    if (k === '.' || k === '>') return handled('Time cursor forward', () => this.nudgeCursor(1, e.shiftKey || k === '>'));
    if (k === 'd' || k === 'D') return handled('Confidence', () => this.askConfidence());
    if (k === 'Delete' || k === 'Backspace') return handled('Delete', () => this.deleteSelection());
  }

  // ============================================ viewing tools: readout, overlay, isolate, go to time
  // The value under the pointer (V), the overlay of the channels on one axis (O) with one channel
  // alone (I), Go to time (G) and Show all (Shift+End), with their buttons in the toolbar, the
  // Recording tab and, on a touch screen, the View group under the EEG. The overlay and the readout
  // are each annotator's own choices, kept in this browser as the comfort settings are.

  _toolKey(name) { return `electrotag.${name}|${(this.s.me && this.s.me.annotator_id) || 'anon'}`; }

  _buildViewTools() {
    const kept = local.get(this._toolKey('value_readout'), null);
    // On by default with a mouse; off on a touch screen, where a finger only moves while it marks.
    this.readoutOn = typeof kept === 'boolean' ? kept : !touchFirst();
    if (local.get(this._toolKey('overlay'), false) === true) this.viewer.setOverlay(true);
    this._viewTouchGroup();
    this.eegHost.append(this._goToBar());
    this._loadElectrodes();
  }

  _overlayButton() {
    this.overlayBtn = h('button.btn.toggle', { type: 'button', 'aria-pressed': 'false', 'data-log': 'overlay',
      title: 'Overlay: the channels on screen on one shared axis, so that what reaches many of them stands out (O). I shows one channel alone.',
      onclick: () => this.setOverlay(!this.viewer.overlay, 'button') }, 'Overlay');
    this.overlayBtn.tabIndex = -1;
    this.overlayBtn.addEventListener('mousedown', (e) => e.preventDefault());
    return this.overlayBtn;
  }

  /** The Recording tab's switch for the value under the pointer. */
  _viewToolsRow() {
    this.readoutBtn = h('button.btn.small.toggle', { type: 'button', 'aria-pressed': 'false', 'data-log': 'value-readout',
      title: 'Show the channel, time and value under the pointer in the line at the bottom (V)',
      onclick: () => this.setReadout(!this.readoutOn, 'button') }, 'Value under the pointer');
    return h('div.btn-row.view-tools', {}, this.readoutBtn,
      h('span.caption', {}, 'The channel, time and value under the pointer, in the line at the bottom (V).'));
  }

  _viewTouchGroup() {
    const btn = (label, log, fn, pressed = null) => h('button.btn.small', { type: 'button', 'data-log': `touch-${log}`, 'data-log-text': label,
      ...(pressed === null ? {} : { 'aria-pressed': String(pressed), class: 'toggle' }), onclick: fn }, label);
    const iconBtn = (name, label, log, fn) => h('button.btn.icon.small', { type: 'button', 'aria-label': label, title: label,
      'data-log': `touch-${log}`, 'data-log-text': label, onclick: fn }, icon(name));
    this.touchOverlay = btn('Overlay', 'overlay', () => this.setOverlay(!this.viewer.overlay, 'button'), false);
    this.touchIsolate = btn('Isolate', 'isolate', () => this.toggleIsolate('button'), false);
    this.touchPrevCh = iconBtn('chevron-up', 'Previous channel alone', 'isolate-previous', () => this.stepIsolated(-1, 'button'));
    this.touchNextCh = iconBtn('chevron-down', 'Next channel alone', 'isolate-next', () => this.stepIsolated(1, 'button'));
    this.viewer.addTouchGroup('View', [this.touchOverlay, this.touchIsolate, this.touchPrevCh, this.touchNextCh,
      btn('Go to time', 'goto', () => this.openGoTo('button')), btn('Show all', 'show-all', () => this.showAll('button'))]);
  }

  _refreshOverlayState() {
    const v = this.viewer;
    if (!v) return;
    const on = v.overlay;
    const iso = on && v.isolated !== null;
    if (this.overlayBtn) this.overlayBtn.setAttribute('aria-pressed', String(on));
    if (this.readoutBtn) this.readoutBtn.setAttribute('aria-pressed', String(Boolean(this.readoutOn)));
    if (this.touchOverlay) {
      this.touchOverlay.setAttribute('aria-pressed', String(on));
      this.touchIsolate.setAttribute('aria-pressed', String(iso));
      this.touchPrevCh.hidden = !iso;
      this.touchNextCh.hidden = !iso;
    }
    if (this.toolbar && on) {
      // Channel-specific marks need a row per channel: in the overlay every mark is on the whole montage.
      this.scopeWhole.setAttribute('aria-pressed', 'true');
      this.scopeSome.setAttribute('aria-pressed', 'false');
      this.scopeSome.disabled = true;
      this.chooseBtn.disabled = true;
      this.chanSummary.className = 'ws-chansummary';
      this.chanSummary.textContent = 'all channels in the overlay';
      this.chanSummary.title = 'In the overlay, new marks apply to the whole montage. Channel-specific marks are made in the normal view (O).';
    }
  }

  /** Whether the next mark is on the selected channels (never in the overlay). */
  _marksChannels() { return this.scope === 'channels' && !this.viewer.overlay; }

  // ------------------------------------------------------------------ the value under the pointer
  setReadout(on, via = 'button') {
    this.readoutOn = Boolean(on);
    local.set(this._toolKey('value_readout'), this.readoutOn);
    if (!this.readoutOn) { this._readoutAt = null; this.readoutEl.hidden = true; this.readoutEl.textContent = ''; }
    logger.event('state', { value_readout: this.readoutOn, via });
    this._refreshOverlayState();
    const touch = touchFirst();
    this.say(this.readoutOn ? `Value under the pointer: on. ${touch ? 'Touch a trace while you draw' : 'Point at a trace'} to see its channel, time and value${touch ? '' : ' (V turns it off)'}.`
      : `Value under the pointer: off${touch ? '' : ' (V turns it on)'}.`);
  }

  /** Pointer moves on the EEG: the readout follows at most once a frame, writing only its text. */
  _noteReadout(type, e) {
    if (!this.readoutOn) return;
    this._readoutAt = type === 'pointerleave' ? null : { x: e.clientX, y: e.clientY };
    if (!this._readoutRaf) this._readoutRaf = requestAnimationFrame(() => { this._readoutRaf = 0; this._showReadout(); });
  }

  _showReadout() {
    if (this._destroyed) return;
    const at = this._readoutAt;
    const r = at && this.readoutOn ? this.viewer.valueAt(at.x, at.y) : null;
    let text = '';
    if (r) {
      const volts = ['eeg', 'eog', 'ecg', 'emg', 'seeg', 'ecog', ''].includes(String(r.type || '').toLowerCase());
      text = `${r.channel}   ${r.t.toFixed(3)} s   ${volts ? microvoltText(r.volts) : `${+r.volts.toPrecision(4)}`}`;
    }
    if (this.readoutEl.textContent !== text) this.readoutEl.textContent = text;
    this.readoutEl.hidden = !text;
  }

  // ------------------------------------------------------------------------- overlay and isolate
  setOverlay(on, via = 'button') {
    on = Boolean(on);
    if (!this.viewer.setOverlay(on)) return;
    local.set(this._toolKey('overlay'), on);
    if (this.gesture && this.gesture.kind === 'draw') { this.gesture = null; this.viewer.setDragPreview(null); }
    logger.event('state', { overlay: on, via });
    this._logView();
    this._refreshState();
    this._showReadout();
    this.say(on ? `Overlay: the channels on screen share one axis, and marks apply to the whole montage. ${touchFirst() ? 'Isolate shows one channel alone; Overlay again goes back.' : 'I shows one channel alone; O goes back.'}`
      : 'Normal view: one channel per row.');
  }

  /** Show one channel alone (by name; the same name again shows them all), turning the overlay on. */
  isolate(name, via = 'button') {
    const row = this.s.channels.findIndex((c) => c.name === name);
    if (row < 0) return;
    if (!this.viewer.overlay) this.setOverlay(true, via);
    this._setIsolated(this.viewer.isolated === row ? null : row, via);
  }

  /** I: one channel alone (the one pointed at, or the first on screen), or all of them again. */
  toggleIsolate(via = 'key') {
    const v = this.viewer;
    if (v.overlay && v.isolated !== null) { this._setIsolated(null, via); return; }
    let row = v.hover && v.hover.area === 'channel_names' ? v.hover.row : null;
    if (row === null && this.pointerXY) {
      const r = v.valueAt(this.pointerXY.x, this.pointerXY.y);
      if (r) row = this.s.channels.findIndex((c) => c.name === r.channel);
    }
    if (row === null || row < 0) row = v.view.firstChannel;
    if (!v.overlay) this.setOverlay(true, via);
    this._setIsolated(row, via);
  }

  /** The next or previous channel alone, moving the channels on screen to keep it there. */
  stepIsolated(dir, via = 'key') {
    const v = this.viewer;
    if (!v.overlay || v.isolated === null) return;
    const row = clamp(v.isolated + dir, 0, this.s.channels.length - 1);
    if (row === v.isolated) { this.say(dir > 0 ? 'That was the last channel.' : 'That was the first channel.'); return; }
    this._setIsolated(row, via);
    const first = v.view.firstChannel;
    const last = first + v.view.nChannels - 1;
    if (row < first) v.scrollChannels(row - first, via);
    else if (row > last) v.scrollChannels(row - last, via);
  }

  _setIsolated(row, via) {
    if (!this.viewer.setIsolated(row)) return;
    const name = row === null ? null : this.s.channels[row].name;
    logger.event('state', { isolated_channel: name, via });
    this._refreshOverlayState();
    this._showReadout();
    this.say(name ? (touchFirst() ? `${name} alone. The buttons beside Isolate move to the previous or next channel; Isolate again shows them all.`
      : `${name} alone. The arrow keys up and down (or the buttons) move to the next channel; I shows them all.`) : 'All the channels on screen again.');
  }

  /** After the view moved: an isolated channel stays on screen, and Show all ends when the view changes. */
  _viewToolsOnView(cause) {
    this._overviewView = cause === 'show_all' && this.viewer.view.durationS >= this.viewer.durationTotal - 1e-6;
    if (!this._overviewView && cause !== 'show_all') this._beforeAll = null;
    // Show all says so over the EEG for as long as it lasts (the message below fades after a while).
    this.viewer.setCaption(this._overviewView ? `The whole recording, as an overview · ${touchFirst() ? 'Show all' : 'Shift+End'} goes back` : null);
    const v = this.viewer;
    if (!v.overlay || v.isolated === null) return;
    const first = v.view.firstChannel;
    const last = Math.min(this.s.channels.length, first + v.view.nChannels) - 1;
    if (v.isolated < first || v.isolated > last) this._setIsolated(clamp(v.isolated, first, last), 'view');
  }

  // --------------------------------------------------------------------- go to time, show all
  _goToBar() {
    const id = `goto-time-${this.windowNo}`;
    this.gotoInput = h('input.field.goto-field', { type: 'text', id, name: 'goto-time', autocomplete: 'off', spellcheck: 'false',
      enterkeyhint: 'go', placeholder: '12.5, 1:05 or 1:02:05', 'aria-describedby': `${id}-note` });
    this.gotoNote = h('p.caption.goto-note', { id: `${id}-note`, 'aria-live': 'polite' });
    this.gotoInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.goToTime(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeGoTo(); }
    });
    const go = h('button.btn.small', { type: 'button', 'data-log': 'goto-go', onclick: () => this.goToTime() }, 'Go');
    const all = h('button.btn.small', { type: 'button', 'data-log': 'goto-show-all', title: 'The whole recording on the screen (Shift+End); again to go back',
      onclick: () => { this.closeGoTo(); this.showAll('button'); } }, 'Show all');
    const close = h('button.btn.icon.small', { type: 'button', 'aria-label': 'Close Go to time', title: 'Close (Esc)', 'data-log': 'goto-close',
      onclick: () => this.closeGoTo() }, icon('close'));
    this.gotoEl = h('div.goto-bar', { role: 'group', 'aria-label': 'Go to time', hidden: true, 'data-log': 'goto-bar' },
      h('div.goto-row', {}, h('label', { for: id }, 'Go to time'), this.gotoInput, go, all, close), this.gotoNote);
    return this.gotoEl;
  }

  /** G (or the touch button): the field for a time to go to. */
  openGoTo(via = 'key') {
    this._gotoVia = via;
    this.gotoEl.hidden = false;
    this.gotoInput.value = '';
    this.gotoNote.classList.remove('error');
    this.gotoNote.textContent = `Seconds, m:ss or h:mm:ss, up to ${clockText(this.s.recording.durationS)}. The time comes to the middle of the screen.`;
    this.gotoInput.focus({ preventScroll: true });
  }

  closeGoTo() {
    if (this.gotoEl.hidden) return;
    this.gotoEl.hidden = true;
    this.viewer.over.focus({ preventScroll: true });
  }

  /** Go to the typed time: the view centred on it, with the time cursor there. Only the time is logged, never the text. */
  goToTime() {
    const r = parseTimeText(this.gotoInput.value);
    const via = this._gotoVia || 'key';
    if (r.error) {
      this.gotoNote.textContent = r.error;
      this.gotoNote.classList.add('error');
      logger.event('go_to_time', { valid: false, via });
      return false;
    }
    const total = this.s.recording.durationS;
    const { t, clamped } = clampTime(r.t, total);
    this.viewer.setView({ startS: centredStart(t, this.viewer.view.durationS) }, 'go_to_time');
    this.viewer.setCursor(t);
    this._cursorKeyedAt = performance.now();
    logger.event('go_to_time', { valid: true, t_s: Math.round(t * 1000) / 1000, clamped, via });
    this.closeGoTo();
    this.say(clamped ? `The recording is ${clockText(total)} long: the time cursor is at its ${t === 0 ? 'start' : 'end'}.`
      : `The time cursor is at ${t.toFixed(3)} s (${clockText(t)}).`);
    return true;
  }

  /** Show all (Shift+End): the whole recording on the screen, and the view before it again. */
  showAll(via = 'key') {
    const v = this.viewer;
    const total = v.spanS; // the whole recording, or a task's part of it
    if (v.view.durationS >= total - 1e-6 && this._beforeAll) {
      const b = this._beforeAll;
      this._beforeAll = null;
      v.setView({ startS: b.startS, durationS: b.durationS }, 'show_all_back');
      logger.event('show_all', { on: false, via });
      this.say('Back to the view before Show all.');
      return;
    }
    const before = { startS: v.view.startS, durationS: v.view.durationS };
    v.setView({ startS: 0, durationS: total }, 'show_all');
    this._beforeAll = before;
    logger.event('show_all', { on: true, duration_s: Math.round(total * 1000) / 1000, via });
    this.say('The whole recording is on the screen, as an overview: it does not count as viewed. Shift+End or Show all goes back.');
  }

  /** V, O, I, G and Shift+End, and the arrow keys up and down while one channel is shown alone. True when the key was taken. */
  _viewKey(e, handled) {
    const k = e.key;
    const v = this.viewer;
    const take = (action, fn) => { handled(action, fn); return true; };
    if (v.overlay && v.isolated !== null && (k === 'ArrowUp' || k === 'ArrowDown')) {
      return take(k === 'ArrowUp' ? 'Previous channel alone' : 'Next channel alone', () => this.stepIsolated(k === 'ArrowUp' ? -1 : 1, 'key'));
    }
    if (k === 'End' && e.shiftKey) return take('Show all', () => this.showAll('key'));
    const lk = k.length === 1 ? k.toLowerCase() : '';
    if (lk === 'v') return take('Value under the pointer', () => this.setReadout(!this.readoutOn, 'key'));
    if (lk === 'o') return take('Overlay', () => this.setOverlay(!v.overlay, 'key'));
    if (lk === 'i') return take('Isolate', () => this.toggleIsolate('key'));
    if (lk === 'g') return take('Go to time', () => this.openGoTo('key'));
    return false;
  }

  // ------------------------------------------------------------------------- the channel map
  /**
   * The recording's own electrode positions, when an electrodes.tsv came with it: picked with it, kept
   * with its copy on this device, or fetched with or beside its link (js/eeg/electrodes.js). The
   * interaction log notes which positions the map uses (electrode_positions), never a file's name.
   */
  async _loadElectrodes() {
    const src = this.s.recording.source;
    const files = await sidecarsOf(src);
    const got = files.length ? await readElectrodes(files, this.s.recording.fileName) : null;
    if (this._destroyed) return;
    if (got) this.electrodes = { positions: projectPositions(got.positions, got.system), fileName: got.fileName, system: got.system };
    const layout = mapLayout(this.s.channels, this.electrodes ? this.electrodes.positions : null);
    logger.event('electrode_positions', { source: layout.source, opened_from: (src && src.kind) || 'other',
      ...(layout.source === 'file' ? { n_placed: layout.points.filter((p) => !p.extra).length, coordinate_system: String(got.system || '').slice(0, 40) } : {}) });
  }

  /** What the channel chooser's map needs: where each channel goes, the group colours, and where the choice of view is kept. */
  _channelMapOptions() {
    return {
      layout: mapLayout(this.s.channels, this.electrodes ? this.electrodes.positions : null),
      fileName: this.electrodes ? this.electrodes.fileName : null,
      colours: channelColours(this.s.channels, this.channelColourMode),
      storageKey: this._toolKey('channel_view'),
    };
  }

  // ================================================================ finishing
  async saveAndFinish() {
    const s = this.s;
    if (!s.canSave || s.submitting || this._finishing) return false;
    this._finishing = true; // pressed again while its questions are open: the first press goes on alone
    try { return await this._saveAndFinish(s); } finally { this._finishing = false; }
  }

  async _saveAndFinish(s) {
    if (this.clock && this.clock.paused) this.resume('save');
    if (this.coach && !this.coach.canSave()) return false;
    // A revision starts with nothing viewed and may fix one place only, so it is not asked to view everything again.
    if (this.timed && this.settings.coverageCheck === 'warn' && s.mode !== 'guided' && !s.revision && !(await this._coverageCheck())) return false;
    if (!(await this._confidenceCheck(s))) return false;
    const counts = s.countsByLabel();
    let ok;
    if (s.revision) {
      const summary = counts.size ? [...counts].map(([l, n]) => `  ${l}: ${n}`).join('\n') : '  No artifacts marked';
      ok = await this._askSave(`Submit the revision with ${plural(this.store.size, 'annotation')}?`, summary,
        `It is saved as version ${s.revision.version}. Version ${s.revision.revises} is kept as it was, and analyses use the latest version.`,
        'Submit the revision');
    } else if (!counts.size) {
      ok = await ask('Save and Finish', 'You have not marked any artifacts in this recording.\n\nSave it as reviewed with no artifacts found, and finish?',
        { yes: 'Save with no artifacts', no: 'Keep annotating', defaultYes: false });
    } else {
      const summary = [...counts].map(([l, n]) => `  ${l}: ${n}`).join('\n');
      ok = await this._askSave(`Save ${plural(this.store.size, 'annotation')} and finish this recording?`, summary);
    }
    if (!ok) return false;
    this.saveBtn.disabled = true;
    const oldText = this.saveBtn.textContent;
    this.saveBtn.textContent = 'Saving…';
    let result;
    try {
      result = await s.submit(this.app.visitId);
    } catch (exc) {
      this.saveBtn.disabled = false;
      this.saveBtn.textContent = oldText;
      // No answer came (the connection, or a study that failed once): the study may have saved it all the same.
      const lostBefore = s.answerLost;
      if (exc.status === 0 || exc.status >= 500) s.answerLost = true;
      if (exc.status === 409 && exc.code === 'already_revised' && lostBefore) {
        await inform('Probably saved already', 'The study has a newer version of this recording than the one you opened. The first time you submitted, '
          + 'the study most likely saved your revision, but its answer did not reach this page.\n\nYour history shows the latest version and when it was saved: open it there to check.');
        s.finished = true;
        s.forgetLocal();
        logger.event('revision_answer_lost', { session_id: s.sessionId, revises: s.revision ? s.revision.revises : null });
        this.app.leaveRecording(this, 'revision saved before its answer arrived');
        return false;
      }
      if (exc.status === 409 && (exc.code === 'already_revised' || exc.code === 'revisions_off')) {
        await inform('Not saved', `${exc.message}\n\nYour changes in this window were not saved.`);
        s.finished = true;
        s.forgetLocal();
        this.app.leaveRecording(this, 'revision refused');
        return false;
      }
      if (exc.status === 409 && exc.code === 'already_done') {
        await inform('Already saved', `${exc.message}\n\nThis recording was saved before, so there is nothing more to do here.`);
        s.finished = true;
        s.forgetLocal();
        this.app.afterSave(this, { saved: true, files: [], next: null, attempt: 0, feedback: null });
        return true;
      }
      await inform('Could not save', 'Your annotations could not be saved, so this recording is not marked complete yet.\n\n' +
        `${exc.message}\n\nYour annotations are still open: you can try Save and Finish again.`);
      if (exc.status === 422 && this.coach) this.coach.refresh();
      return false;
    }
    const c = this.clock;
    logger.event('recording_finished', { session_id: s.sessionId, n_annotations: this.store.size,
      ...(result && Number.isInteger(result.attempt) && result.attempt > 0 ? { attempt: result.attempt } : {}),
      counts_by_label: Object.fromEntries(counts), elapsed_s: Math.round(s.elapsedS * 1000) / 1000,
      ...(this.timed ? { viewed_fraction: this._viewedFraction() } : {}),
      ...(c ? { paused_s: Math.round(c.pausedTotalS * 1000) / 1000, n_pauses: c.nPauses } : {}),
      ...(s.revision ? { version: s.revision.version } : {}) });
    if (s.revision) {
      logger.event('revision_submitted', { session_id: s.sessionId, version: (result.revision && result.revision.version) || s.revision.version,
        revises: s.revision.revises, n_annotations: this.store.size, changed: s.changedSinceSaved, elapsed_s: Math.round(s.elapsedS * 1000) / 1000 });
    }
    this.app.afterSave(this, result);
    return true;
  }

  /** Before Save and Finish: the stretches never on screen, with Go to the first part and Save anyway. True to go on saving. */
  async _coverageCheck() {
    const gaps = this._unviewed();
    if (!gaps.length) return true;
    const total = gaps.reduce((t, [a, b]) => t + (b - a), 0);
    const shown = gaps.slice(0, 6);
    const pc = cov.percentText(cov.viewedFraction(this.s.viewed, this.s.recording.durationS, this._noData()));
    const one = gaps.length === 1;
    const body = h('div', {},
      h('p.dialog-text', {}, `You have viewed ${pc} of this recording. ${one ? 'This part has' : 'These parts have'} not been on the screen yet:`),
      h('ul.unviewed-list', {}, shown.map(([a, b]) => h('li', {}, `${clockText(a)} to ${clockText(b)} (${friendlyDuration(b - a)})`))),
      gaps.length > shown.length ? h('p.dialog-text', {}, `and ${gaps.length - shown.length} more, ${friendlyDuration(total)} in all.`) : null,
      h('p.dialog-text', {}, `Look at ${one ? 'it' : 'them'} before you save, or save now if you have reviewed ${one ? 'it' : 'them'} another way.`));
    const choice = await showDialog({ title: one ? 'A part not yet viewed' : 'Parts not yet viewed', body, className: 'coverage-check', logText: `${plural(gaps.length, 'unviewed part')}, ${Math.round(total)} s`,
      buttons: [{ label: 'Keep annotating', value: 'cancel' }, { label: 'Save anyway', value: 'save' },
        { label: one ? 'Go to that part' : 'Go to the first part', value: 'goto', kind: 'primary' }], cancelValue: 'cancel' });
    logger.event('coverage_check', { viewed_fraction: this._viewedFraction(), n_unviewed: gaps.length, unviewed_s: Math.round(total * 10) / 10, choice });
    if (choice === 'goto') {
      this.viewer.setView({ startS: cov.viewStartFor(gaps[0], this.viewer.view.durationS) }, 'unviewed');
      this.say(`Not yet viewed: ${clockText(gaps[0][0])} to ${clockText(gaps[0][1])}.${one ? '' : ` ${touchFirst() ? 'Next part not yet viewed' : 'U (or Next part not yet viewed)'} shows the next one.`}`);
      this.viewer.over.focus({ preventScroll: true });
    }
    return choice === 'save';
  }

  /** Asked to leave while Save and Finish waits for the study's answer: say so, and stay. */
  _waitForSave() {
    this.say('Saving your annotations: wait for the answer from the study before you leave this recording.', 6000);
  }

  _askSave(question, summary, after = null, label = 'Save and Finish') {
    const allow = this.s.me && this.s.me.study && this.s.me.study.annotation && this.s.me.study.annotation.allow_revisions;
    const note = after || (allow && this.s.mode === 'standard'
      ? 'You can still revise them later from your history; each revision is saved as a new version.'
      : 'You will not be able to change them afterwards.');
    const body = h('div', {}, h('p.dialog-text', {}, question),
      h('pre.dialog-summary', {}, summary), h('p.dialog-text', {}, note));
    return showDialog({ title: label, body, logText: question,
      buttons: [{ label: 'Keep annotating', value: false }, { label, value: true, kind: 'primary' }], cancelValue: false }).then(Boolean);
  }

  /** Close (the Close button, or leaving the page's view): unfinished work is kept for later or discarded, as the annotator chooses. */
  async close() {
    const s = this.s;
    if (s.submitting) { this._waitForSave(); return false; }
    if (this.clock && this.clock.paused) this.resume('close');
    if (this.kind === 'review') { this.app.leaveRecording(this, 'review_closed'); return true; }
    if (PART_KINDS.includes(this.kind)) {
      // A correction, a replay or the view of a corrected version: its part asks what it needs, then leaves (opts.onLeave).
      if (this.pass && this.pass.beforeClose && !(await this.pass.beforeClose())) return false;
      if (this.opts.onLeave) await this.opts.onLeave(this);
      else this.app.leaveRecording(this, `${this.kind}_closed`);
      return true;
    }
    if (this.kind === 'reviewing' || this.kind === 'feedback') {
      if (this.review && this.review.beforeClose && !(await this.review.beforeClose())) return false;
      this.app.leaveRecording(this, `${this.kind}_closed`);
      return true;
    }
    if (this.kind === 'tryout') {
      if (this.store.size) {
        const c = await choose('Close the try-out?', `Nothing you marked in this file is kept.\n\nDownload my annotations: save them as a file first.`,
          ['Download my annotations', 'Close', 'Keep looking'], 0);
        if (c === 'Keep looking') return false;
        if (c === 'Download my annotations') { this.downloadTryOut(); return false; }
      }
      this.app.leaveRecording(this, 'tryout_closed');
      return true;
    }
    if (s.finished) { this.app.leaveRecording(this, 'finished'); return true; }
    if (s.revision) return this._closeRevision();
    const n = this.store.size;
    const later = 'Close and finish later';
    const discard = 'Discard and close';
    const stay = 'Keep annotating';
    const choice = await choose('Close this recording?',
      `${later}: ` + (n ? `your draft is kept, with your ${plural(n, 'annotation')} and the time spent` : 'your draft is kept, with the time spent so far') +
      ', and you continue where you left off the next time you open this recording. It is complete once you press Save and Finish.\n\n' +
      `${discard}: your annotations for this recording are deleted.`, [later, discard, stay], 0);
    if (choice === stay) return false;
    if (choice === discard && n && !(await ask('Discard annotations?', `Delete your ${plural(n, 'annotation')} for this recording?`, { yes: 'Delete them', no: 'Keep annotating', defaultYes: false, destructive: true }))) return false;
    if (choice === later) {
      s.saveLocal();
      await s.saveRemote({ force: true });
      logger.event('closed_without_saving', { n_annotations: n, kept: true });
      this.app.leaveRecording(this, 'closed to finish later');
    } else {
      await s.discardDrafts({ close: true });
      logger.event('closed_without_saving', { n_annotations: n, kept: false });
      this.app.leaveRecording(this, 'viewer closed without Save and Finish');
    }
    return true;
  }

  /** Close during a revision: keep the changes to continue later, or leave without them. */
  async _closeRevision() {
    const s = this.s;
    if (!s.changedSinceSaved) return this.leaveRevision();
    const later = 'Close and revise later';
    const leave = 'Leave without changes';
    const stay = 'Keep revising';
    const choice = await choose('Close the revision?',
      `Version ${s.revision.revises} stays as it was saved until you submit the revision.\n\n` +
      `${later}: your changes and the time spent are kept, and you can continue from your history.\n\n` +
      `${leave}: your changes in this revision are discarded.`, [later, leave, stay], 0);
    if (choice === stay) return false;
    if (choice === leave) {
      await s.discardDrafts({ close: true });
      logger.event('revision_left', { session_id: s.sessionId, revises: s.revision.revises, changed: true, elapsed_s: Math.round(s.elapsedS * 1000) / 1000 });
      this.app.leaveRecording(this, 'revision left without changes');
      return true;
    }
    s.saveLocal();
    await s.saveRemote({ force: true });
    logger.event('closed_without_saving', { n_annotations: this.store.size, kept: true, revises: s.revision.revises });
    this.app.leaveRecording(this, 'closed to revise later');
    return true;
  }

  downloadTryOut() {
    const s = this.s;
    const doc = {
      schema: 'electrotag.tryout_annotations', note: 'Annotations of a file that is not part of a study (try-out mode).',
      file_name: s.recording.fileName, sfreq: s.recording.sfreq, n_samples: s.recording.nSamples, ch_names: s.channels.map((c) => c.name),
      annotations: this.store.toJSON().map((a) => ({ ...a, onset: a.onset_sample / this.sf, duration: a.duration_samples / this.sf })),
    };
    this.app.download([{ name: `${s.recording.stem}_tryout_annotations.json`, blob: new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' }) }]);
    this.say('Your annotations were offered as a file to save. They are not stored anywhere else.');
  }
}

export { CTRL };
