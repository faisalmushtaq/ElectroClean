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

import { h, clear } from '../ui/dom.js';
import { showDialog, ask, inform, choose, dialogOpen } from '../ui/dialog.js';
import { showMenu, closeMenu } from '../ui/menu.js';
import { EegViewer } from '../viewer/viewer.js';
import { pickType, chooseChannels, editTimes } from './dialogs.js';
import { AnnotationError, endSample } from './store.js';
import { helpHtml, KEY_HINT, REVIEW_HINT, TOUCH_HINT, TOUCH_REVIEW_HINT, TOUCH_VIEW_HINT } from './help.js';
import { edgeHalfWidthS } from '../data/synthetic.js';
import { logger, keyName } from '../log/logger.js';
import { channelsText, clamp, formatHms, local, readableTextColour, UNDO_HINT, CTRL, debounce, touchFirst } from '../util.js';
import { isTyping } from '../ui/dom.js';
import { displayCode } from '../catalogue.js';
import { icon } from '../views/common.js';
import { CHANNEL_COLOUR_MODES, MODE_TEXT as COLOUR_MODE_TEXT, channelColours, legendOf, normaliseMode } from '../viewer/channel_colours.js';
import { BREAK_MIN_S, HIDDEN_PAUSE_MS, SNOOZE_S, idleDue, todayKey } from './clock.js';
import * as cov from '../viewer/coverage.js';
import { NAME_SIZES, PANEL_TEXT, TRACE_WIDTHS, loadComfort, saveComfort } from '../ui/comfort.js';

const MODE_TEXT = { standard: 'Annotation', guided: 'Guided training', practice: 'Practice', assessment: 'Assessment', tryout: 'Try-out', review: 'Practice review' };
const DRAG_PX = 3;

export function friendlyDuration(s) {
  s = Math.round(s);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

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

function annSummary(a, sf) {
  return { id: a.annotation_id, label: a.label, onset_s: Math.round((a.onset_sample / sf) * 1e4) / 1e4,
    offset_s: Math.round((endSample(a) / sf) * 1e4) / 1e4, channels: [...a.channels], n_channels: a.channels.length };
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
    this._build();
  }

  /** The working-time clock (session.js), once the recording is on screen. */
  get clock() { return this.s.clock; }

  // ===================================================================== building
  _build() {
    const s = this.s;
    const study = (s.me && s.me.study) || {};
    const fl = study.filters || {};
    const saved = fl.locked ? null : local.get(`electroclean.filters|${study.study_id || ''}`, null);
    const f = saved || fl;
    s.filters = {
      highpassHz: f.highpass_enabled === false ? null : (f.highpass_hz || 1.0),
      notchHz: f.notch_enabled === false ? null : (f.notch_hz || 50.0),
      notchHarmonics: Boolean(f.notch_harmonics),
    };
    this.filtersLocked = Boolean(fl.locked);
    this.el = h('main.view.annotate', { 'data-view': 'annotate', class: s.revision && this.kind === 'annotate' ? 'revising' : null },
      this._header(), this._revisionBar(), this.kind === 'review' ? null : this._toolbar(),
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
    if (s.view) {
      this.viewer.setView({ startS: s.view.start_s || 0, durationS: s.view.duration_s || 10, firstChannel: s.view.first_channel || 0,
        nChannels: s.view.n_channels || 32, scaleFactor: s.view.scale_factor || 1 }, 'restore');
    }
    this._applyChannelColours();
    this._syncViewState();
    this.viewer.onView = (v, cause) => {
      this._syncViewState(); this._logView();
      if (this.timed) this._noteViewDwell();
      if (cause !== 'restore') this._afterViewChange();
    };
    this.viewer.onPointer = (type, info, e) => this._pointer(type, info, e);
    this.viewer.setComfort(this.comfort);
    if (this.timed) {
      this.viewer.setCoverage(s.viewed);
      this.viewer.onNextUnviewed = (via) => { logger.noteInput(`button:Next part not yet viewed`); this.nextUnviewed(via); };
    } else {
      this.viewer.nextUnviewedGroup.hidden = true;
    }
    this.viewer.setAnnotations(this.store.annotations());
    this._storeListener = (change) => this._onStore(change);
    this.store.addListener(this._storeListener);
    this._refreshAll();
  }

  _header() {
    const s = this.s;
    const title = h('div.ws-title', {},
      this.closeBtn = h('button.btn.quiet.back', { type: 'button', 'data-log': 'close', onclick: () => this.close() },
        icon('arrow-left'), this.kind === 'review' ? 'Training path' : 'Close'),
      h('div.ws-name', {}, h('h1', { title: s.recordingId }, s.recording.fileName),
        h('span.chip', { class: this.kind === 'tryout' ? 'warning' : 'active' }, MODE_TEXT[this.kind === 'annotate' ? s.mode : this.kind] || s.mode)),
      this.kind === 'tryout' ? h('span.ws-banner', {}, 'This file is not part of the study, so nothing you mark is saved.') : null);
    const actions = h('div.ws-actions');
    if (!this.readOnly) {
      this.drawBtn = h('button.btn.toggle', { type: 'button', 'aria-pressed': 'true', title: 'When off, the recording can be inspected without changing annotations · Delete removes the selected annotation', onclick: () => this.setDrawing(!this.drawing) }, 'Draw/edit');
      this.deleteBtn = h('button.btn', { type: 'button', title: 'Delete the selected annotation (Delete or Backspace)', onclick: () => this.deleteSelection() }, 'Delete');
      this.undoBtn = h('button.btn', { type: 'button', onclick: () => this.undo() }, 'Undo');
      this.redoBtn = h('button.btn', { type: 'button', onclick: () => this.redo() }, 'Redo');
      actions.append(this.drawBtn, this.deleteBtn, this.undoBtn, this.redoBtn, h('span.sep'));
    }
    if (this.timed) {
      this.savedEl = h('span.ws-saved', { 'data-saved': 'none' });
      this.pauseBtn = h('button.btn.pause-btn', { type: 'button', 'data-log': 'pause', 'aria-pressed': 'false',
        title: 'Stop the clock while you are away (B). Your draft is kept.', onclick: () => (this.clock && this.clock.paused ? this.resume('button') : this.pause('button')) },
      icon('pause'), h('span.pause-label', {}, 'Pause'));
      actions.append(this.savedEl, this.pauseBtn);
    }
    actions.append(h('button.btn.quiet', { type: 'button', title: 'Keys and mouse actions (?)', onclick: () => this.showHelp() }, 'Help'));
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
    if (s.changedSinceSaved && !(await ask('Leave without changes?',
      `Your changes in this revision are discarded. Version ${s.revision.revises} stays as it was saved.`,
      { yes: 'Leave without changes', no: 'Keep revising', defaultYes: false, destructive: true }))) return false;
    await s.discardDrafts();
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
      }, h('span.swatch', { style: { background: l.colour } }), h('span.chip-key', {}, String(i + 1)), h('span.chip-code', {}, displayCode(l.short_code)));
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
      h('div.segmented', { role: 'group', 'aria-label': 'Applies to' }, this.scopeWhole, this.scopeSome), this.chooseBtn, this.chanSummary);
    this._ro = new ResizeObserver(() => this._fitToolbar());
    this._ro.observe(this.toolbar);
    return this.toolbar;
  }

  _fitToolbar() {
    // The type buttons show their code when there is room, otherwise only their number.
    const tb = this.toolbar;
    if (!tb) return;
    tb.classList.remove('compact');
    if (tb.scrollWidth > tb.clientWidth + 1) tb.classList.add('compact');
  }

  _statusBar() {
    const s = this.s;
    const who = s.me ? `${s.me.annotator_id}${s.me.display_name ? ` (${s.me.display_name})` : ''}` : '';
    const touch = touchFirst();
    this.hintEl = h('span.ws-hint', {}, this.kind === 'review' ? (touch ? TOUCH_REVIEW_HINT : REVIEW_HINT)
      : this.readOnly ? (touch ? TOUCH_VIEW_HINT : 'N / P  next, previous annotation')
        : touch ? TOUCH_HINT : this.timed ? KEY_HINT : KEY_HINT.replace('  ·  B pause', '')); // a try-out has no Pause
    this.msgEl = h('span.ws-message', { role: 'status', 'aria-live': 'polite' });
    this.fixedEl = h('span.ws-fixed');
    this.countEl = h('span.ws-fixed');
    this.viewedEl = h('span.ws-fixed.ws-viewed', { title: 'How much of the recording has been on the screen' });
    this._fixedText = `Annotator: ${who}   |   Mode: ${MODE_TEXT[this.kind === 'annotate' ? s.mode : this.kind] || s.mode}`;
    return h('footer.ws-status', {}, h('div.ws-status-left', {}, this.hintEl, this.msgEl),
      h('div.ws-status-right', {}, this.timed ? this.viewedEl : null, this.countEl, this.fixedEl));
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
    this.tabPanels.help.appendChild(h('div.help-text', { html: helpHtml(touchFirst()) }));
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
      h('thead', {}, h('tr', {}, h('th', {}, 'Label'), h('th.code', {}, 'Code'), h('th.num', { title: 'Start, in seconds' }, 'Start'), h('th.num', { title: 'End, in seconds' }, 'End'), h('th', {}, 'Channels'))),
      this.tbody);
    this.tableWrap = h('div.table-wrap', {}, this.table);
    const btn = (label, fn, cls = '') => h(`button.btn${cls}`, { type: 'button', onclick: fn }, label);
    this.btnGoto = btn('Go to', () => this.selection[0] && this.jumpTo(this.selection[0]));
    this.btnTimes = btn('Edit times…', () => this.editTimesOfSelected());
    this.btnLabel = btn('Change label…', () => this.relabelSelected());
    this.btnChans = btn('Edit channels…', () => this.selection[0] && this.editChannelsOf(this.selection[0]));
    this.btnMerge = btn('Merge', () => this.mergeSelected());
    this.btnMerge.title = 'Merge the selected annotations (same label only) into one interval';
    this.btnDel = btn('Delete', () => this.deleteSelectedRows(), '.destructive');
    p.append(this.countLabel, this.tableWrap,
      this.readOnly ? h('div.btn-row', {}, this.btnGoto)
        : h('div.btn-grid', {}, this.btnGoto, this.btnTimes, this.btnLabel, this.btnChans, this.btnMerge, this.btnDel));
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
    p.append(h('label.check', {}, zones, ' Show filter edge zones'), opts, this._comfortOptions(), table);
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
      local.set(`electroclean.filters|${study.study_id || ''}`, {
        highpass_enabled: Boolean(nf.highpassHz), highpass_hz: hpHz, notch_enabled: Boolean(nf.notchHz), notch_hz: nf.notchHz || 50, notch_harmonics: nf.notchHarmonics,
      });
      logger.event('state', { filters: this._filtersLog(), via: logger.via() });
    };
    for (const el of [hpOn, hpOff, notch, n50, n60, harm]) el.addEventListener('change', apply);
    for (const el of [n50, n60, harm]) el.disabled = locked || !notch.checked;
    return h('fieldset.viewing', {},
      h('legend', {}, 'Viewing options'),
      locked ? h('p.banner', {}, 'These settings are fixed by the study administrator.') : null,
      h('div.opt', {}, h('label', {}, hpOn, ` Apply ${hpHz} Hz high-pass filter (recommended)`)),
      h('div.opt', {}, h('label', {}, hpOff, ' No high-pass filter')),
      h('div.opt', {}, h('label', {}, notch, ' Apply notch filter'), ' ', h('label', {}, n50, ' 50 Hz (UK, Europe)'), ' ', h('label', {}, n60, ' 60 Hz (North America)')),
      h('div.opt', {}, h('label', {}, harm, ' Also remove harmonics (100, 150 Hz … or 120, 180 Hz …)')),
      this._channelColourOption());
  }

  /** "Colour channels by" (js/viewer/channel_colours.js), remembered for the annotator in this browser. */
  _channelColourOption() {
    const s = this.s;
    const study = (s.me && s.me.study) || {};
    const key = `electroclean.channel_colours|${study.study_id || ''}|${(s.me && s.me.annotator_id) || ''}`;
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
      h('p.caption', {}, 'On the overview bar under the EEG, the parts not yet on the screen are white with an amber line above them.'),
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
    return parts.join(', ') + (this.filtersLocked ? ' (fixed by administrator)' : '');
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
    requestAnimationFrame(() => this._fitToolbar());
    const visibility = () => this._visibility();
    document.addEventListener('visibilitychange', visibility);
    this._listeners.push(() => document.removeEventListener('visibilitychange', visibility));
    if (this.s.resumed && this.timed) this._welcomeBack();
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
      comfort: { ...this.comfort }, ...extra,
    });
    logger.event('viewer_ready', {});
  }

  destroy() {
    clearInterval(this._clock);
    clearTimeout(this._hiddenTimer);
    clearInterval(this._pauseTimer);
    this._noteViewDwell.cancel();
    if (this.clock) {
      if (this.clock.paused) this.resume('close', { quiet: true });
      this._tally(true);
      this.app.sinceBreak = { s: this.clock.sinceBreakS, at: Date.now() };
    }
    this.s.onSaved = null;
    this._listeners.forEach((f) => f());
    this.store.removeListener(this._storeListener);
    if (this._ro) this._ro.disconnect();
    if (this.coach) this.coach.destroy();
    this.viewer.destroy();
    closeMenu();
    logger.eegAt = null;
    logger.setContext(null);
    this.el.remove();
  }

  _tick() {
    const t = formatHms(this.s.elapsedS);
    if (this.clockLabel) this.clockLabel.textContent = `Time worked on this recording: ${t}`;
    const c = this.clock;
    if (this.timed && c) {
      // (while paused, the panel's own timer counts the pause)
      if (!c.paused && document.visibilityState !== 'hidden') {
        if (idleDue(performance.now() - this._lastInput, this.settings.idlePauseMinutes)) this.pause('idle');
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
    if (!this.timed || !c || c.paused || this.s.finished) return false;
    const idleS = (performance.now() - this._lastInput) / 1000;
    const p = c.pause(reason, at === undefined ? c.now() : at);
    // Nothing half-done stays behind the panel: a drag, a started mark, an open menu.
    if (this.gesture) { this.gesture = null; this.viewer.setDragPreview(null); this.viewer.setAnnotations(this.store.annotations()); }
    this.cancelMark(true);
    closeMenu();
    this._hideBreakReminder(null);
    for (const el of [this.toolbar, this.eegHost, this.side]) if (el) el.inert = true;
    this.el.classList.add('paused');
    this.pauseBtn.setAttribute('aria-pressed', 'true');
    this.pauseBtn.querySelector('.pause-label').textContent = 'Resume';
    this.pauseBtn.title = 'Start the clock again (B)';
    this.panel.hidden = false;
    this.pauseReasonEl.textContent = {
      idle: `ElectroClean paused itself after ${minutesWords(this.settings.idlePauseMinutes * 60)} without any input.`,
      hidden: 'ElectroClean paused itself while the page was out of sight.',
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
    if (document.visibilityState !== 'hidden') this.resumeBtn.focus({ preventScroll: true });
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
    this.pauseBtn.setAttribute('aria-pressed', 'false');
    this.pauseBtn.querySelector('.pause-label').textContent = 'Pause';
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
    const was = this._returned || c.pauseReason === 'hidden' || c.pauseReason === 'idle' ? 'You were away for' : 'Paused for';
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
    this.eegHost.append(this.breakEl);
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
  _noData() { return (this.s.gaps || []).map(([a, b]) => [a / this.sf, b / this.sf]); }

  _viewedFraction() {
    return Math.round(cov.viewedFraction(this.s.viewed, this.s.recording.durationS, this._noData()) * 10000) / 10000;
  }

  _unviewed() { return cov.unviewed(this.s.viewed, this.s.recording.durationS, { noData: this._noData() }); }

  /** A view that has stayed on screen for a moment counts as seen (not while paused or out of sight). */
  _noteViewDwell = debounce(() => this._recordViewed(), cov.DWELL_MS);

  _recordViewed() {
    if (!this.timed || !this.clock || this.clock.paused || document.visibilityState === 'hidden') return;
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
    this.viewedEl.textContent = `${text}   |   `;
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

  // ================================================================ drafts kept
  _showSaved(where, at) {
    this._saved[where] = at;
    if (!this.savedEl) return;
    const latest = [this._saved.browser, this._saved.study].filter(Boolean).sort((a, b) => b - a)[0];
    this.savedEl.textContent = `Draft saved ${timeOfDay(latest)}`;
    this.savedEl.dataset.saved = where;
    const t = (d) => d.toLocaleTimeString('en-GB');
    this.savedEl.title = 'Your work is kept as a draft while you annotate, so nothing is lost if the page closes. ' +
      `Last kept ${this._saved.browser ? `in this browser at ${t(this._saved.browser)}` : ''}` +
      `${this._saved.browser && this._saved.study ? ' and ' : ''}${this._saved.study ? `with the study at ${t(this._saved.study)}` : ''}.`;
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
    if (this.editable) return true;
    this.say(this.readOnly ? 'This view is read-only' : 'Drawing and editing is off: tick Draw/edit to change annotations');
    return false;
  }

  _logState(fields) { logger.event('state', { ...fields, via: logger.via() }); }

  setDrawing(on) {
    if (this.readOnly) on = false;
    this.drawing = Boolean(on);
    this._logState({ drawing_enabled: this.drawing });
    this.say(on ? 'Drawing and editing on' : 'Drawing and editing off (view only)');
    this._refreshState();
  }

  setCurrentLabel(label) {
    this.cat.get(label);
    if (label !== this.currentLabel) { this.currentLabel = label; this._logState({ current_label: label }); }
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
    this.setScope(this.scope === 'whole' ? 'channels' : 'whole');
    this.say(this.scope === 'whole' ? 'Next annotation: whole montage' : 'Next annotation: selected channels (click channel names to choose them)');
  }

  onChannelClicked(name) {
    if (this.scope !== 'channels') {
      this.say(`${name}: switch to 'Selected channels' to choose channels by clicking. Channels are not marked bad in ElectroClean.`);
      return;
    }
    const sel = new Set(this.selectedChannels);
    if (sel.has(name)) sel.delete(name); else sel.add(name);
    this.setSelectedChannels([...sel]);
    this.say(`${this.selectedChannels.length} channel(s) selected for new annotations`);
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
      this.toolbar.classList.toggle('changing', ids.length > 0);
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
      this.drawBtn.setAttribute('aria-pressed', String(this.drawing));
      this.undoBtn.title = this.store.canUndo ? `Undo ${this.store.undoDescription}` : 'Nothing to undo';
      this.redoBtn.title = this.store.canRedo ? `Redo ${this.store.redoDescription}` : 'Nothing to redo';
      this.deleteBtn.disabled = !this.editable;
    }
    const anns = this.targetIds().map((i) => this.store.get(i));
    const ed = this.editable;
    this.btnGoto.disabled = !anns.length;
    this.btnTimes.disabled = !(ed && anns.length === 1);
    this.btnLabel.disabled = !(ed && anns.length);
    this.btnChans.disabled = !(ed && anns.length === 1);
    this.btnDel.disabled = !(ed && anns.length);
    this.btnMerge.disabled = !(ed && anns.length >= 2 && new Set(anns.map((a) => a.label)).size === 1);
    if (this.saveBtn && this.coach) this.coach.syncSaveButton(this.saveBtn);
  }

  _refreshFixed() {
    this.fixedEl.textContent = `${this._fixedText}   |   Filters: ${this.filtersText()}`;
  }

  _refreshList() {
    const anns = this.store.annotations();
    const sel = new Set(this.selection);
    const scroll = this.tableWrap.scrollTop;
    clear(this.tbody);
    anns.forEach((a, i) => {
      const l = this.cat.get(a.label);
      const prefix = (this.prefix && this.prefix[a.annotation_id]) || '';
      const tr = h(`tr${sel.has(a.annotation_id) ? '.selected' : ''}`, {
        'data-id': a.annotation_id, 'data-log-text': a.label, 'aria-selected': String(sel.has(a.annotation_id)),
        title: `${a.label}\n${l.description}`.trim(),
        onclick: (e) => this._rowClick(e, i, anns),
        ondblclick: () => this.jumpTo(a.annotation_id),
      },
      h('td.label', {}, h('span.swatch', { style: { background: l.colour } }), h('span', { style: { color: this.labelColours?.[a.annotation_id] || null } }, prefix + a.label)),
      h('td.code', {}, String(l.value)),
      h('td.num', { title: `${(a.onset_sample / this.sf).toFixed(3)} to ${(endSample(a) / this.sf).toFixed(3)} s, duration ${(a.duration_samples / this.sf).toFixed(3)} s` }, (a.onset_sample / this.sf).toFixed(3)),
      h('td.num', {}, (endSample(a) / this.sf).toFixed(3)),
      h('td.chans', { title: a.channels.length ? a.channels.join(', ') : 'Whole montage' }, channelsText(a.channels)));
      this.tbody.appendChild(tr);
    });
    if (!anns.length) this.tbody.appendChild(h('tr.empty', {}, h('td', { colspan: '5' }, this.readOnly ? 'No annotations.' : 'No annotations yet. Choose a type and drag across the EEG.')));
    this.tableWrap.scrollTop = scroll;
    const n = anns.length;
    const nCh = anns.filter((a) => a.channels.length).length;
    this.countLabel.textContent = `${n} annotation(s): ${n - nCh} whole montage, ${nCh} channel-specific`;
    this.countEl.textContent = `Annotations: ${n}   |   `;
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
      first_channel: ch[v.firstChannel]?.name, last_channel: ch[last]?.name, scale_factor: Math.round(v.scaleFactor * 1e4) / 1e4, butterfly: false,
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
    const added = [...now.keys()].filter((k) => !prev.has(k));
    const removed = [...prev.keys()].filter((k) => !now.has(k));
    const changed = [...now.keys()].filter((k) => prev.has(k) && prev.get(k) !== now.get(k));
    const via = logger.via();
    const sum = (a) => annSummary(a, this.sf);
    const base = { description: change.description, n_total: now.size, via };
    const act = change.action;
    if (act === 'add') {
      logger.event('annotation_created', { ...base, annotations: added.concat(changed).map((k) => sum(now.get(k))),
        ...(this.store.lastAutoMerged ? { auto_merged: this.store.lastAutoMerged, merged_away: removed } : {}) });
    } else if (act === 'delete') {
      logger.event('annotation_deleted', { ...base, annotations: removed.map((k) => sum(prev.get(k))) });
    } else if (act === 'update') {
      const d = change.description || '';
      const type = d.startsWith('relabel') ? 'annotation_relabelled' : /channel/.test(d) ? 'annotation_channels_changed' : 'annotation_edited';
      logger.event(type, { ...base, annotations: changed.map((k) => sum(now.get(k))), before: changed.map((k) => sum(prev.get(k))),
        ...(this.store.lastAutoMerged ? { auto_merged: this.store.lastAutoMerged, merged_away: removed } : {}) });
    } else if (act === 'merge' || act === 'undo' || act === 'redo' || act === 'reset') {
      const type = { merge: 'annotations_merged', undo: 'undo', redo: 'redo', reset: 'annotations_reset' }[act];
      logger.event(type, { ...base, added: added.map((k) => sum(now.get(k))), removed: removed.map((k) => sum(prev.get(k))), changed: changed.map((k) => sum(now.get(k))) });
    }
    this.selection = this.selection.map((i) => (this.store.has(i) ? i : this.store.lastSurvivors.get(i))).filter((i) => i && this.store.has(i));
    this.viewer.setAnnotations(this.store.annotations());
    this.viewer.setSelection(this.selection);
    this._refreshList();
    this._refreshState();
    if (this.welcomeEl && act !== 'reset') { this.welcomeEl.remove(); this.welcomeEl = null; }
    if (this.coach) this.coach.scheduleCheck();
  }

  createAnnotation(t0, t1) {
    if (!this._checkEditable()) return null;
    if (this.scope === 'channels' && !this.selectedChannels.length) {
      this.say("No channels selected: click channel names, use 'Channels…', or choose 'Whole montage'.");
      return null;
    }
    const channels = this.scope === 'channels' ? [...this.selectedChannels] : [];
    let ann;
    try {
      ann = this.store.addInterval(this.currentLabel, t0, t1, channels);
    } catch (exc) {
      if (exc instanceof AnnotationError) { this.say(`Annotation not created: ${exc.message}`); return null; }
      throw exc;
    }
    this._revealRow(ann.annotation_id);
    const where = ann.channels.length ? `${ann.channels.length} channel(s)` : 'whole montage';
    const span = `${(ann.onset_sample / this.sf).toFixed(3)}–${(endSample(ann) / this.sf).toFixed(3)} s`;
    if (this.store.lastAutoMerged) {
      this.say(`Merged with ${this.store.lastAutoMerged} overlapping ${ann.label} annotation(s) on the same channels: now ${span} (${where}). ${UNDO_HINT}.`);
    } else {
      this.say(`Added ${ann.label} ${span} (${where})`);
    }
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
        this.say(`Changed ${what} to ${name} (${UNDO_HINT}). Esc or a click on empty EEG ends the selection.`);
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
    showMenu(items, r.left, r.bottom + 2, { className: 'type-menu-list', minWidth: Math.max(300, r.width) });
  }

  showContextMenu(id, x, y) {
    if (!this._checkEditable()) return;
    const a = this.store.get(id);
    const items = [{ section: a.label }];
    this.quick.forEach((name, i) => {
      const l = this.cat.get(name);
      items.push({ label: `${l.label}  (${l.value})`, swatch: l.colour, shortcut: String(i + 1), disabled: name === a.label, title: l.description,
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
      { label: 'Edit channels…', onSelect: () => this.editChannelsOf(id) });
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

  toggleAnnotationChannel(id, ch) {
    if (!this._checkEditable()) return;
    try {
      const a = this.store.toggleChannel(id, ch);
      this.say(a.channels.length ? `${a.label}: channels ${a.channels.join(', ')}` : `${a.label}: now applies to the whole montage`);
    } catch (exc) {
      this.say(exc.message);
    }
  }

  deleteOne(id) {
    if (!this._checkEditable()) return;
    const a = this.store.get(id);
    this.store.delete(id);
    this.select(null);
    this.say(`Deleted ${a.label} (${UNDO_HINT})`);
  }

  deleteSelection() {
    if (!this._checkEditable()) return;
    const ids = this.targetIds();
    if (ids.length > 1) { this.deleteSelectedRows(); return; }
    if (!ids.length) { this.say(`Nothing is selected: click an annotation (or press N) to select it, or ${UNDO_HINT} the last change`); return; }
    this.deleteOne(ids[0]);
  }

  deleteSelectedRows() {
    const ids = this.targetIds();
    if (!ids.length || !this._checkEditable()) return;
    this.store.deleteMany(ids);
    this.select(null);
    this.say(`Deleted ${ids.length} annotation(s) (${UNDO_HINT})`);
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
      this.say(`Merged ${ids.length} annotations into one ${merged.label} (${UNDO_HINT})`);
    } catch (exc) {
      inform('Cannot merge', exc.message);
    }
  }

  async relabelSelected() {
    const ids = this.targetIds();
    if (!ids.length || !this._checkEditable()) return;
    const current = this.store.get(ids[0]).label;
    const label = await pickType({ title: 'Change label', catalogue: this.cat, current, quick: this.quick });
    if (!label || (label === current && ids.length === 1)) return;
    logger.noteInput('dialog:Change label');
    this.store.setLabelMany(ids, label);
  }

  async editTimesOfSelected() {
    const ids = this.targetIds();
    if (ids.length !== 1 || !this._checkEditable()) return;
    const a = this.store.get(ids[0]);
    const v = await editTimes({ start: a.onset_sample / this.sf, end: endSample(a) / this.sf, sfreq: this.sf, duration: this.s.recording.durationS });
    if (!v) return;
    logger.noteInput('dialog:Edit times');
    try {
      this.store.setInterval(ids[0], v[0], v[1]);
    } catch (exc) {
      inform('Times not changed', exc.message);
    }
  }

  async editChannelsOf(id) {
    if (!this.store.has(id) || !this._checkEditable()) return;
    const a = this.store.get(id);
    const chosen = await chooseChannels({ title: `Channels affected by this ${a.label}`, channels: this.s.channels, chosen: a.channels,
      allowWholeMontage: true, wholeMontage: !a.channels.length });
    if (!chosen) return;
    logger.noteInput(`dialog:Channels affected by this ${a.label}`);
    if (!chosen.wholeMontage && !chosen.channels.length) { inform('Channels not changed', 'Choose at least one channel, or Whole montage.'); return; }
    this.setAnnotationChannels(id, chosen.wholeMontage ? [] : chosen.channels);
  }

  async chooseChannelsForNew() {
    const chosen = await chooseChannels({ title: 'Channels for new annotations', channels: this.s.channels, chosen: this.selectedChannels });
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
      const v = this.viewer.view;
      if (step > 0) { const k = anns.findIndex((a) => a.onset_sample / this.sf >= v.startS - 1e-9); i = k >= 0 ? k : anns.length; }
      else { let k = -1; anns.forEach((a, j) => { if (a.onset_sample / this.sf < v.startS + v.durationS) k = j; }); i = k; }
    }
    if (i < 0 || i >= anns.length) { this.say(step > 0 ? 'That was the last annotation' : 'That was the first annotation'); return; }
    const a = anns[i];
    this.jumpTo(a.annotation_id);
    this.say(`${i + 1} of ${anns.length}: ${a.label} ${(a.onset_sample / this.sf).toFixed(3)}–${(endSample(a) / this.sf).toFixed(3)} s. Press 1 to 9 to change its type, Delete to remove it, N or P to move on.`);
  }

  // ====================================================================== marks
  markKey(kind) {
    // The time under the pointer now (the EEG may have scrolled since the pointer last moved).
    const p = this.pointerXY ? this.viewer.hit(this.pointerXY.x, this.pointerXY.y) : null;
    const t = p && p.area === 'eeg' ? p.t : null;
    if (t === null) {
      const where = kind === 'end' || (kind === 'toggle' && this.markStart !== null) ? 'ends' : 'starts';
      const key = { start: '[', end: ']' }[kind] || 'M';
      this.say(`Point at the EEG where the artifact ${where}, then press ${key}.`);
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
    t = clamp(t, 0, this.s.recording.durationS);
    this.markStart = t;
    this.viewer.setMarkStart(t, this.cat.colourFor(this.currentLabel));
    this._logState({ mark_start_s: Math.round(t * 1000) / 1000 });
    this.say(`Start of ${this.currentLabel} marked at ${t.toFixed(3)} s. Point at the end (scroll if you need to) and press M again. Esc cancels.`);
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
    if (had) { this._logState({ mark_start_s: null }); if (!quiet) this.say('Mark cancelled'); }
    return had;
  }

  escape() {
    if (!this.cancelMark()) this.select(null);
  }

  // ============================================================ mouse and touch
  _pointer(type, info, e) {
    if (type === 'pointermove' || type === 'pointerleave') this.pointerXY = info && info.area === 'eeg' ? { x: e.clientX, y: e.clientY } : null;
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
      if (e.shiftKey && info.annotation) {
        this.gesture = { kind: 'shift', id: info.annotation, x: info.x, t: info.t, channel: info.channel, moved: false };
        return;
      }
      this.gesture = { kind: 'press', x: info.x, t: info.t, info, moved: false };
      return;
    }
    if (type === 'pointermove') {
      this._hoverCursor(info, e);
      if (!g || !info) return;
      const dx = Math.abs(info.x - g.x);
      if (g.kind === 'press') {
        if (!g.moved && dx > DRAG_PX && this.editable) {
          g.moved = true;
          g.kind = 'draw';
          this.cancelMark(true);
          if (this.selection.length) this.select(null);
          g.colour = this.cat.colourFor(this.currentLabel);
        }
      }
      if (g.kind === 'draw') {
        const t = clamp(info.t, 0, this.s.recording.durationS);
        this.viewer.setDragPreview({ t0: g.t, t1: t, colour: g.colour, channels: this.scope === 'channels' ? this.selectedChannels : [] });
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
        if (g.t1 !== undefined) this.createAnnotation(Math.min(g.t, g.t1), Math.max(g.t, g.t1));
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
        if (i.annotation) { this.select([i.annotation], { via: 'eeg_click' }); this.viewer.setCursor(null); }
        else {
          if (this.selection.length) this.select(null, { via: 'eeg_click' });
          // A click on a trace chooses its channel.
          if (i.nearTrace && i.channel) this.onChannelClicked(i.channel);
          this.viewer.setCursor(i.t);
        }
      }
    }
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
        this.say(`Merged with ${this.store.lastAutoMerged} overlapping ${ann.label} annotation(s) (${UNDO_HINT})`);
      }
    } catch (exc) {
      this.say(`Change not applied: ${exc.message}`);
    }
    this.viewer.setAnnotations(this.store.annotations());
  }

  _hoverCursor(info, e) {
    const c = this.viewer.over;
    let cursor = 'default';
    if (info && info.area === 'eeg') {
      if (this.gesture && (this.gesture.kind === 'resize')) cursor = 'ew-resize';
      else if (this.gesture && this.gesture.kind === 'move') cursor = 'grabbing';
      else if (info.edge && this.editable) cursor = 'ew-resize';
      else if (info.annotation && e.shiftKey && this.editable) cursor = 'move';
      else if (info.annotation) cursor = 'pointer';
      else cursor = this.editable ? 'crosshair' : 'default';
    } else if (info && (info.area === 'channel_names' || info.area === 'tags')) cursor = 'pointer';
    if (c.style.cursor !== cursor) c.style.cursor = cursor;
  }

  // ======================================================================= keys
  _key(e) {
    if (dialogOpen() || isTyping(e.target) || !this.el.isConnected) return;
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
    if (this.coach && !mod && (k === 'Enter' || k === ' ') && this.coach.takesContinueKey()) {
      return handled('Continue', () => this.coach.continue());
    }
    if (mod && !e.altKey) {
      const lk = k.toLowerCase();
      if (lk === 'z' && !e.shiftKey) return handled('Undo', () => this.undo());
      if ((lk === 'z' && e.shiftKey) || lk === 'y') return handled('Redo', () => this.redo());
      if (lk === 'f') return handled('Find a type…', () => !this.readOnly && this.findType());
      return;
    }
    if (e.altKey) return;
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
    if (k === 'Delete' || k === 'Backspace') return handled('Delete', () => this.deleteSelection());
  }

  // ================================================================ finishing
  async saveAndFinish() {
    const s = this.s;
    if (!s.canSave) return false;
    if (this.clock && this.clock.paused) this.resume('save');
    if (this.coach && !this.coach.canSave()) return false;
    // A revision starts with nothing viewed and may fix one place only, so it is not asked to view everything again.
    if (this.timed && this.settings.coverageCheck === 'warn' && s.mode !== 'guided' && !s.revision && !(await this._coverageCheck())) return false;
    const counts = s.countsByLabel();
    let ok;
    if (s.revision) {
      const summary = counts.size ? [...counts].map(([l, n]) => `  ${l}: ${n}`).join('\n') : '  No artifacts marked';
      ok = await this._askSave(`Submit the revision with ${this.store.size} annotation(s)?`, summary,
        `It is saved as version ${s.revision.version}. Version ${s.revision.revises} is kept as it was, and analyses use the latest version.`,
        'Submit the revision');
    } else if (!counts.size) {
      ok = await ask('Save and Finish', 'You have not marked any artifacts in this recording.\n\nSave it as reviewed with no artifacts found, and finish?',
        { yes: 'Save with no artifacts', no: 'Keep annotating', defaultYes: false });
    } else {
      const summary = [...counts].map(([l, n]) => `  ${l}: ${n}`).join('\n');
      ok = await this._askSave(`Save ${this.store.size} annotation(s) and finish this recording?`, summary);
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
      await inform('Could not save', 'Your annotations could not be saved, so this recording has NOT been marked complete.\n\n' +
        `${exc.message}\n\nYour annotations are still open: you can try Save and Finish again.`);
      if (exc.status === 422 && this.coach) this.coach.refresh();
      return false;
    }
    const c = this.clock;
    logger.event('recording_finished', { session_id: s.sessionId, n_annotations: this.store.size,
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

  /** Before Save and Finish: the stretches never on screen, with Go to the first and Save anyway. True to go on saving. */
  async _coverageCheck() {
    const gaps = this._unviewed();
    if (!gaps.length) return true;
    const total = gaps.reduce((t, [a, b]) => t + (b - a), 0);
    const shown = gaps.slice(0, 6);
    const pc = cov.percentText(cov.viewedFraction(this.s.viewed, this.s.recording.durationS, this._noData()));
    const body = h('div', {},
      h('p.dialog-text', {}, `You have viewed ${pc} of this recording. ${gaps.length === 1 ? 'This part has' : 'These parts have'} not been on the screen yet:`),
      h('ul.unviewed-list', {}, shown.map(([a, b]) => h('li', {}, `${clockText(a)} to ${clockText(b)} (${friendlyDuration(b - a)})`))),
      gaps.length > shown.length ? h('p.dialog-text', {}, `and ${gaps.length - shown.length} more, ${friendlyDuration(total)} in all.`) : null,
      h('p.dialog-text', {}, 'Look at them before you save, or save now if you have reviewed them another way.'));
    const choice = await showDialog({ title: 'Parts not yet viewed', body, className: 'coverage-check', logText: `${gaps.length} unviewed part(s), ${Math.round(total)} s`,
      buttons: [{ label: 'Save anyway', value: 'save' }, { label: 'Go to the first', value: 'goto', kind: 'primary' }], cancelValue: 'cancel' });
    logger.event('coverage_check', { viewed_fraction: this._viewedFraction(), n_unviewed: gaps.length, unviewed_s: Math.round(total * 10) / 10, choice });
    if (choice === 'goto') {
      this.viewer.setView({ startS: cov.viewStartFor(gaps[0], this.viewer.view.durationS) }, 'unviewed');
      this.say(`Not yet viewed: ${clockText(gaps[0][0])} to ${clockText(gaps[0][1])}. Press U (or Next part not yet viewed) for the next one.`);
      this.viewer.over.focus({ preventScroll: true });
    }
    return choice === 'save';
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
    if (this.clock && this.clock.paused) this.resume('close');
    if (this.kind === 'review') { this.app.leaveRecording(this, 'review_closed'); return true; }
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
    const choice = await choose('Close without saving?',
      'This recording has not been saved with Save and Finish, so it is not complete.\n\n' +
      `${later}: ` + (n ? `your ${n} annotation(s) and the time spent are kept` : 'the time spent so far is kept') +
      ', and ElectroClean offers to continue the next time you open this recording.\n\n' +
      `${discard}: your annotations for this recording are deleted.`, [later, discard, stay], 0);
    if (choice === stay) return false;
    if (choice === discard && n && !(await ask('Discard annotations?', `Delete your ${n} annotation(s) for this recording?`, { yes: 'Delete them', no: 'Keep annotating', defaultYes: false, destructive: true }))) return false;
    if (choice === later) {
      s.saveLocal();
      await s.saveRemote({ force: true });
      logger.event('closed_without_saving', { n_annotations: n, kept: true });
      this.app.leaveRecording(this, 'closed to finish later');
    } else {
      await s.discardDrafts();
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
      await s.discardDrafts();
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
      schema: 'electroclean.tryout_annotations', note: 'Annotations of a file that is not part of a study (try-out mode).',
      file_name: s.recording.fileName, sfreq: s.recording.sfreq, n_samples: s.recording.nSamples, ch_names: s.channels.map((c) => c.name),
      annotations: this.store.toJSON().map((a) => ({ ...a, onset: a.onset_sample / this.sf, duration: a.duration_samples / this.sf })),
    };
    this.app.download([{ name: `${s.recording.stem}_tryout_annotations.json`, blob: new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' }) }]);
    this.say('Your annotations were offered as a file to save. They are not stored anywhere else.');
  }
}

export { CTRL };
