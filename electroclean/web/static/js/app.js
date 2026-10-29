// The application: which backend, signing in, the views and the moves between them.
//
// Views are addressed by a plain hash (#signin, #home, #open, #annotate, #review, #training, and
// for administrators #admin and #admin-<section>), so the page also works where only such a hash
// survives (an embedded preview).

import { h, clear } from './ui/dom.js';
import { ask, inform, showDialog, setDialogLogger, dialogOpen } from './ui/dialog.js';
import { Catalogue } from './catalogue.js';
import { findBackend, connectServer, connectFirebase, makeDemo, rememberServer } from './api/choose.js';
import { DEMO_NOTICE } from './api/notice.js';
import { logger } from './log/logger.js';
import { AnnotationSession } from './annotate/session.js';
import { Workspace, friendlyDuration } from './annotate/workspace.js';
import { GuidedCoach, minutesText } from './training/coach.js';
import { PracticeReview, reviewAnnotations } from './training/review.js';
import { trainingPath } from './training/path.js';
import { QuizView } from './training/quiz.js';
import { signinView } from './views/signin.js';
import { homeView } from './views/home.js';
import { OpenView } from './views/open.js';
import { appHeader, downloadFiles, smallScreenNotice } from './views/common.js';
import { nowLocalIso } from './util.js';
import { newlyReached } from './games/milestones.js';
import { logMilestones } from './views/home_games.js';
import { canRevise } from './views/home_list.js';

const VIEWS = ['signin', 'home', 'open', 'annotate', 'review', 'training', 'quiz'];
/** The admin area's plain hashes (js/admin/model.js lists its sections). */
const ADMIN_ROUTE = /^admin(-[a-z]+)?$/;

// The file readers are loaded when the first recording is opened (the demonstration may not need them).
let recordingModule = null;
async function openRecordingFiles(files) {
  if (!recordingModule) recordingModule = await import('./data/recording.js');
  return recordingModule.openRecording(files);
}

function friendlyTime(iso) {
  if (!iso) return 'earlier';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'earlier';
  const same = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return same ? `today at ${time}` : `on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} at ${time}`;
}

export class App {
  constructor(root) {
    this.root = root;
    this.backend = null;
    this.where = null;
    this.me = null;
    this.catalogue = null;
    this.assignments = null;
    this.achievements = null; // GET /me/achievements, for the home page's game elements (null: none)
    this.celebrate = null; // milestones that the last save reached, shown once on the home page
    this.adminArea = null;
    this.visitId = null;
    this.ws = null;
    this.route = null;
    this.windowCount = 0;
    this.pathMessage = '';
    this.content = h('div.app-content');
    this.notice = smallScreenNotice(this);
    this.root.append(this.content, this.notice);
    setDialogLogger(logger);
    window.addEventListener('hashchange', () => this._onHash());
  }

  // ===================================================================== start
  async boot() {
    // A bookmarked section of the admin area opens again once its administrator has signed in.
    const asked = (location.hash || '').replace(/^#/, '');
    if (ADMIN_ROUTE.test(asked)) this._adminReturn = asked;
    this._render(h('main.page.loading', {}, h('p.subtitle', {}, 'Starting ElectroClean…')), 'signin');
    let where;
    try { where = await findBackend(); } catch { where = { kind: 'demo', source: 'none' }; }
    this.where = where;
    try {
      await this._connect(where);
    } catch (exc) {
      this.where = { ...where, error: this._unreachable(where, exc) };
      this.backend = null;
      this.showSignin();
      return;
    }
    if (this.backend.signedIn) {
      try {
        await this._afterSignIn({ quiet: true });
        return;
      } catch { /* sign in again */ }
    }
    this.showSignin();
  }

  _unreachable(where, exc) {
    if (where.kind === 'firebase') return `The study could not be loaded (${exc.message}). Check your internet connection and try again.`;
    return `The study server at ${where.address} does not answer${exc && exc.code === 'not_electroclean' ? ' as an ElectroClean study server' : ''}. ` +
      'Check your internet connection and the address, then try again. If it keeps happening, tell your study team.';
  }

  async _connect(where) {
    const onUnauthorized = () => this.sessionExpired();
    if (where.kind === 'server') this.backend = await connectServer(where.address, { onUnauthorized, health: where.health });
    else if (where.kind === 'firebase') this.backend = await connectFirebase(where, { onUnauthorized });
    else this.backend = await makeDemo();
  }

  /** The Study address field of the sign-in view. */
  async connectTo(address) {
    const where = { kind: 'server', address, source: 'typed' };
    try {
      this.backend = await connectServer(address, { onUnauthorized: () => this.sessionExpired() });
    } catch (exc) {
      throw new Error(`There is no ElectroClean study at ${address}, or it does not answer. Check the address and try again.`);
    }
    rememberServer(this.backend.server);
    this.where = { ...where, address: this.backend.server };
    this.showSignin();
  }

  async useDemo() {
    rememberServer('');
    this.where = { kind: 'demo', source: 'chosen' };
    this.backend = await makeDemo();
    this.showSignin();
  }

  // ================================================================= signing in
  showSignin(opts = {}) {
    this._render(signinView(this, opts), 'signin');
  }

  async signIn(id, password) {
    await this.backend.login(id, password);
    await this._afterSignIn({ quiet: false });
  }

  async _afterSignIn({ quiet }) {
    this.me = await this.backend.me();
    this.catalogue = new Catalogue(this.me.catalogue);
    try {
      const visit = await this.backend.openVisit({
        client: { app: 'web', backend: this.backend.kind, user_agent: navigator.userAgent,
          screen: { width: screen.width, height: screen.height, pixel_ratio: window.devicePixelRatio || 1 },
          window: { width: window.innerWidth, height: window.innerHeight } },
        programme: Boolean(this.me.programme),
      });
      this.visitId = visit.visit_id;
      logger.begin({ backend: this.backend, visitId: visit.visit_id, logging: visit.logging || this.me.study.logging });
      // A study server and Firebase write the visit's first event themselves (docs/web/api.md).
      if (!this.backend.writesVisitStart) {
        logger.event('visit_started', { mode: this.me.programme ? 'training' : 'standard', programme: Boolean(this.me.programme),
          reference_set: this.me.programme ? this.me.programme.set_id : '', client: 'web', backend: this.backend.kind, annotator_id: this.me.annotator_id });
      }
    } catch {
      this.visitId = null; // annotating still works without the log
    }
    const study = this.me.study || {};
    if (!quiet && study.logging && study.logging.interactions && study.logging_notice) {
      await showDialog({ title: 'Before you start', body: h('div', {}, h('p.dialog-text', {}, study.logging_notice)),
        buttons: [{ label: 'Continue', value: true, kind: 'primary' }], cancelValue: true, className: 'logging-notice' });
    }
    await this.loadAssignments();
    const want = (location.hash || '').replace(/^#/, '');
    // Administrators start in the admin area (or where a reload left them); they can still annotate.
    const back = this._adminReturn;
    this._adminReturn = null;
    if (this.isAdmin && (ADMIN_ROUTE.test(want) || !want || want === 'signin')) await this.showAdmin(ADMIN_ROUTE.test(want) ? want : back || 'admin');
    else if (this.me.programme && (!want || want === 'signin' || want === 'training' || quiet)) await this.showTraining();
    else this.showHome();
  }

  async loadAssignments() {
    const games = this.loadAchievements();
    try { this.assignments = await this.backend.assignments(); } catch (exc) {
      if (exc.status === 401) throw exc;
      this.assignments = { items: [], next: null };
    }
    await games;
  }

  /** The facts of the home page's game elements, when the study has them on (null otherwise, or when they cannot be read). */
  async loadAchievements() {
    const g = this.me && this.me.study && this.me.study.gamification;
    if (!g || !g.enabled || this.me.programme || !this.backend.achievements) { this.achievements = null; return null; }
    try {
      this.achievements = await this.backend.achievements();
    } catch (exc) {
      if (exc.status === 401) throw exc;
      this.achievements = null; // the home page works without them
    }
    return this.achievements;
  }

  /** Draw the home page again after a change to the goal or the leaderboard (its list keeps its tab, search and page). */
  refreshGames() {
    if (this.route === 'home' && !this.ws) this.showHome();
  }

  /** True for an account with the role admin (GET /me), who may use the admin area. */
  get isAdmin() { return Boolean(this.me && this.me.role === 'admin'); }

  /** Read GET /me again, after the admin area changed the study's settings. */
  async refreshMe() {
    if (!this.me) return;
    this.me = await this.backend.me();
    this.catalogue = new Catalogue(this.me.catalogue);
  }

  async signOut() {
    if (this.ws && !(await this.ws.close())) return;
    this._resumeLog();
    this.adminArea = null;
    await logger.end('sign_out');
    await this.backend.logout();
    this.me = null;
    this.visitId = null;
    this.showSignin({ message: 'You have signed out.' });
  }

  sessionExpired() {
    if (this._expiring) return;
    this._expiring = true;
    if (ADMIN_ROUTE.test(this.route || '')) this._adminReturn = this.route;
    if (this.ws) {
      this.ws.s.saveLocal();
      this.ws.destroy();
      this.ws = null;
    }
    this.me = null;
    this.adminArea = null;
    this._adminLogPaused = false;
    logger.enabled = false;
    this.showSignin({ error: 'Your sign-in has ended. Sign in again to continue; your unsaved work is kept in this browser.' });
    setTimeout(() => { this._expiring = false; }, 500);
  }

  // ===================================================================== views
  _render(el, route) {
    if (this.quizView && this.quizView.el !== el) {
      this.quizView.destroy(); // the quiz's answers are with the study; its recordings are closed
      this.quizView = null;
    }
    clear(this.content);
    this.content.appendChild(el);
    this._setRoute(route);
  }

  _setRoute(route) {
    this.route = route;
    // The phone's notice, drawn again for who is signed in now (its link and buttons).
    const notice = smallScreenNotice(this);
    this.notice.replaceWith(notice);
    this.notice = notice;
    document.body.dataset.route = route;
    logger.topWindow = route;
    if (ADMIN_ROUTE.test(route)) this._pauseLog(); else this._resumeLog();
    if (location.hash !== `#${route}`) {
      this._settingHash = true;
      location.hash = route;
    }
    document.title = { signin: 'ElectroClean – sign in', home: 'ElectroClean', open: 'ElectroClean – open a recording',
      annotate: `ElectroClean – ${this.ws ? this.ws.s.recording.fileName : 'annotate'}`, review: 'ElectroClean – practice review',
      training: 'ElectroClean – training programme', quiz: 'ElectroClean – quiz' }[route]
      || (ADMIN_ROUTE.test(route) ? 'ElectroClean – admin' : 'ElectroClean');
  }

  // The interaction log records annotating; what an administrator does in the admin area is not
  // part of it (only that the area was opened and left).
  _pauseLog() {
    if (this._adminLogPaused || !logger.enabled) return;
    logger.event('admin_area_opened', {});
    logger.enabled = false;
    this._adminLogPaused = true;
  }

  _resumeLog() {
    if (!this._adminLogPaused) return;
    this._adminLogPaused = false;
    if (this.me && this.visitId) {
      logger.enabled = true;
      logger.event('admin_area_closed', {});
    }
  }

  async _onHash() {
    if (this._settingHash) { this._settingHash = false; return; }
    const want = (location.hash || '').replace(/^#/, '');
    if (want === this.route || (!VIEWS.includes(want) && !ADMIN_ROUTE.test(want))) return;
    if (this.ws) {
      // Back or forward while a recording is open: the same as its Close button.
      this._settingHash = true;
      location.hash = this.route;
      if (!dialogOpen()) this.ws.close();
      return;
    }
    if (!this.me) { if (want !== 'signin') this.showSignin(); return; }
    if (ADMIN_ROUTE.test(want)) { if (this.isAdmin) this.showAdmin(want); else this.showHome(); return; }
    if (want === 'quiz') {
      if (this.quizSetId) this.showQuiz(this.quizSetId, { fromTraining: this._fromTraining });
      else this.showHome();
      return;
    }
    if (want === 'home') this.showHome();
    else if (want === 'training' && this.me.programme) this.showTraining();
    else if (want === 'open') this.openFromComputer(null);
    else if (want === 'signin') this.showHome();
  }

  go(route) {
    if (route === 'training') this.showTraining();
    else this.showHome();
  }

  goBack() {
    if (this.me && this.me.programme && this._fromTraining) this.showTraining();
    else this.showHome();
  }

  showHome() {
    this._fromTraining = false;
    this._render(homeView(this), 'home');
  }

  /**
   * The admin area (js/admin/area.js, loaded the first time it is needed): `route` is #admin or
   * #admin-<section>; `params` passes something to the section, such as the annotator to assign to.
   */
  async showAdmin(route = 'admin', params = null) {
    if (!this.isAdmin) { this.showHome(); return; }
    const { AdminArea } = await import('./admin/area.js');
    const { sectionForRoute } = await import('./admin/model.js');
    const section = sectionForRoute(route);
    if (!section) route = 'admin';
    if (!this.adminArea || this.adminArea.backend !== this.backend || this.adminArea.annotatorId !== this.me.annotator_id) {
      this.adminArea = new AdminArea(this);
      await this.adminArea.ready();
    }
    if (ADMIN_ROUTE.test(this.route || '') && this.content.contains(this.adminArea.el)) this._setRoute(route);
    else this._render(this.adminArea.el, route);
    await this.adminArea.show(section || 'overview', params);
  }

  async reloadHome() {
    await this.loadAssignments();
    this.showHome();
  }

  /** The short-segment quiz of a reference set (one of me.quizzes). */
  showQuiz(setId, { fromTraining = false } = {}) {
    this._fromTraining = Boolean(fromTraining);
    this.quizSetId = setId;
    const view = new QuizView(this, setId);
    if (this.quizView) this.quizView.destroy();
    this.quizView = view;
    this._render(view.el, 'quiz');
    view.start();
  }

  async showTraining(message = this.pathMessage) {
    this.pathMessage = '';
    let data;
    try {
      data = await this.backend.training();
    } catch (exc) {
      if (exc.status === 401) return;
      this._render(h('div.view', {}, appHeader(this), h('main.page', {}, h('h1', {}, 'Training programme'), h('p.banner', {}, `The training path could not be loaded: ${exc.message}`))), 'training');
      return;
    }
    logger.event('training_path_opened', { reference_set: data.set_id, stages: data.stages.map((s) => ({ key: s.key, status: s.status, done: s.done, total: s.total })),
      next_stage: data.next ? data.next.stage : null, next_recording: data.next ? data.next.recording_id : null, message });
    this._fromTraining = true;
    const page = trainingPath(data, {
      annotatorId: this.me.annotator_id, message,
      onContinue: (next) => {
        logger.event('stage_started', { stage: next.stage, recording: next.recording_id, repeat: Boolean(next.repeat) });
        const item = (this.assignments.items || []).find((i) => i.recording_id === next.recording_id && i.mode === next.stage) ||
          { recording_id: next.recording_id, file_name: next.recording_id.split('/').pop(), mode: next.stage };
        this.openAssignment(item);
      },
      onBack: () => { logger.event('training_path_left', {}); this.showHome(); },
      quizzes: (this.me && this.me.quizzes) || [],
      onQuiz: (q) => this.showQuiz(q.set_id, { fromTraining: true }),
    });
    this._render(h('div.view', { 'data-view': 'training' }, appHeader(this), page), 'training');
  }

  download(files) { downloadFiles(files); }

  /** Send the interaction events still waiting (the demonstration's results include them). */
  async flushLog() { await logger.flush(); }

  async downloadResults() {
    await this.flushLog();
    this.download(await this.backend.downloadResults());
  }

  // ============================================================ opening recordings
  /** Open an assigned recording; with `revise`, a finished one, to revise it (docs/web/using.md, "History and revisions"). */
  openAssignment(item, { revise = false } = {}) {
    this.openFromComputer(item, { revise });
  }

  openFromComputer(expected, { revise = false } = {}) {
    this.openView = new OpenView(this, { expected, revise: Boolean(expected && revise) });
    this._render(this.openView.el, 'open');
  }

  /** Demonstration: the built-in copy of an example recording. */
  async useExample(recordingId) {
    const recording = this.backend.exampleRecording(recordingId);
    if (!this.openView || this.route !== 'open') this.openFromComputer(null);
    await this._process(recording, this.openView);
  }

  async processFiles(files, view) {
    view.reset();
    view.step('read', 'Reading the file…');
    let recording;
    try {
      recording = await openRecordingFiles(files);
    } catch (exc) {
      view.step('read', 'Reading the file', 'failed');
      view.showProblem(`This file could not be opened: ${exc.message}`, [view.chooseAgainButton()]);
      logger.event('load_failed', { kind: 'read', reason: exc.message });
      return;
    }
    await this._process(recording, view);
  }

  async _process(recording, view) {
    view.reset();
    view.step('read', `Read ${recording.fileName}: ${recording.channels.length} channels, ${friendlyDuration(recording.durationS)} at ${recording.sfreq} Hz`, 'done');
    view.step('fp', 'Checking the file (its fingerprint)…', 'working', 0);
    let fp;
    try {
      fp = await recording.fingerprint((f) => view.step('fp', `Checking the file (its fingerprint) ${Math.round(f * 100)} %`, 'working', f));
    } catch (exc) {
      view.step('fp', 'Checking the file', 'failed');
      view.showProblem(`The file could not be read to the end: ${exc.message}`, [view.chooseAgainButton()]);
      return;
    }
    view.step('fp', 'Checked the file', 'done');
    view.step('match', this.backend.isDemo ? 'Looking it up in the demonstration study…' : 'Asking the study whether this is one of your recordings…');
    let m;
    try {
      m = await this.backend.match({
        file_name: recording.fileName, size_bytes: recording.sizeBytes, format: recording.format === 'synthetic' ? 'edf' : recording.format,
        sha256: fp.hex, sfreq: recording.sfreq, n_samples: recording.nSamples, ch_names: recording.channels.map((c) => c.name),
        ...(view.revise ? { revise: true } : {}),
      });
    } catch (exc) {
      view.step('match', 'Asking the study', 'failed');
      if (exc.status !== 401) view.showProblem(`The study could not be asked: ${exc.message}`, [view.chooseAgainButton()]);
      return;
    }
    logger.event('recording_loading', { recording_id: m.recording_id, match: m.status, file_name: recording.fileName, size_bytes: recording.sizeBytes });
    const back = h('button.btn', { type: 'button', onclick: () => this.goBack() }, 'Back to my recordings');
    if (m.status === 'matched') {
      view.step('match', m.message, 'done');
      await this.openWorkspace({ recording, match: m, sha: fp.hex });
    } else if (m.status === 'matched_metadata') {
      view.step('match', m.message, 'done');
      const body = h('div', {}, h('p.dialog-text', {}, m.message), h('ul', {}, (m.differences || []).map((d) => h('li', {}, d))),
        h('p.dialog-text', {}, 'You can open it anyway: your annotations are saved with this file\'s fingerprint, so the study team can check it. Or choose the study\'s copy of the file.'));
      const go = await showDialog({ title: 'Not exactly the study\'s copy', body, logText: m.message,
        buttons: [{ label: 'Choose another file', value: false }, { label: 'Open it anyway', value: true, kind: 'primary' }], cancelValue: false });
      if (go) await this.openWorkspace({ recording, match: m, sha: fp.hex });
      else view.showMessage('Choose the study\'s copy of the recording.', [view.chooseAgainButton()]);
    } else if (m.status === 'unknown') {
      view.step('match', 'Not a recording of this study', 'failed');
      view.showMessage(m.message, [view.chooseAgainButton(),
        h('button.btn', { type: 'button', onclick: () => this.openWorkspace({ recording, match: m, sha: fp.hex, tryOut: true }) }, 'Look at it without saving')], 'banner');
    } else if (m.status === 'not_assigned') {
      view.step('match', 'Not one of your recordings now', 'failed');
      view.showMessage(m.message, [view.chooseAgainButton(false), back], 'banner');
    } else if (m.status === 'done') {
      view.step('match', 'Already finished', 'done');
      // A finished study recording can be revised from here too, when the study allows it.
      const item = (this.assignments.items || []).find((i) => i.recording_id === m.recording_id && i.mode === m.mode && (i.context_id || '') === (m.context_id || ''));
      const revise = item && canRevise(this, item) && !view.revise
        ? h('button.btn', { type: 'button', 'data-log': 'open-to-revise', onclick: () => { view.revise = true; this._process(recording, view); } }, 'Open to revise')
        : null;
      view.showMessage(m.message, [back, revise, view.chooseAgainButton(false)].filter(Boolean), 'note');
    } else {
      view.step('match', m.message || m.status, 'failed');
    }
  }

  _position(recordingId) {
    const guided = (this.assignments.items || []).filter((i) => i.mode === 'guided');
    const i = guided.findIndex((x) => x.recording_id === recordingId);
    return [i >= 0 ? i + 1 : 1, Math.max(1, guided.length)];
  }

  async openWorkspace({ recording, match, sha, tryOut = false }) {
    let session;
    try {
      session = new AnnotationSession({
        backend: this.backend, recording, manifest: tryOut ? null : match.manifest, recordingId: tryOut ? recording.fileName : match.recording_id,
        mode: tryOut ? 'tryout' : match.mode, contextId: tryOut ? '' : match.context_id, me: this.me, catalogue: this.catalogue, sha256: sha,
        revision: tryOut ? null : match.revision || null,
      });
    } catch (exc) {
      this.openView && this.openView.showProblem(exc.message, [this.openView.chooseAgainButton()]);
      return;
    }
    if (!tryOut) {
      const draft = session.pickDraft(match.draft);
      if (draft) {
        const n = draft.annotations.length;
        const rev = session.revision;
        const yes = rev
          ? await ask('Continue your revision?',
            `${n} annotation(s) and ${friendlyDuration(draft.elapsed_s || 0)} of revising ${session.recordingId}, saved automatically ${friendlyTime(draft.saved_at)}.\n\n` +
            `Continue the revision, or start again from version ${rev.revises} as it was saved?`,
            { yes: 'Continue the revision', no: `Start again from version ${rev.revises}` })
          : await ask('Restore unfinished work?',
            `${n} annotation(s) and ${friendlyDuration(draft.elapsed_s || 0)} of work on ${session.recordingId}, saved automatically ${friendlyTime(draft.saved_at)}.\n\nRestore it and continue?`,
            { yes: 'Restore and continue', no: 'Start afresh' });
        if (yes) {
          const view = session.restore(draft);
          if (view) session.view = view;
        } else {
          await session.discardDrafts();
        }
      }
    }
    if (this.ws) this.ws.destroy();
    const ws = new Workspace(this, session, { kind: tryOut ? 'tryout' : 'annotate' });
    this.ws = ws;
    this._render(ws.el, 'annotate');
    ws.mount(this.content);
    if (session.mode === 'guided') {
      ws.coach = new GuidedCoach(ws, { backend: this.backend, recordingId: session.recordingId, position: this._position(session.recordingId) });
      await ws.coach.start();
      ws._refreshState();
    }
    ws.logOpened({ recording_id: session.recordingId, match: match.status, ...(session.revision ? { revision: session.revision.version } : {}) });
    if (session.revision) {
      logger.event('revision_started', { session_id: session.sessionId, recording_id: session.recordingId, version: session.revision.version,
        revises: session.revision.revises, revises_saved_at: session.revision.saved_at || null, annotations_loaded: session.store.size, resumed: session.resumed });
    }
  }

  // ===================================================================== after
  async afterSave(ws, result) {
    const s = ws.s;
    const fileName = s.recording.fileName;
    ws.destroy();
    this.ws = null;
    const before = this.achievements;
    await this.loadAssignments();
    // Milestones that this save reached: celebrated once on the home page, never in the way of the next recording.
    const reached = before && this.achievements ? newlyReached(before, this.achievements) : [];
    if (reached.length) logMilestones(reached);
    if (s.mode === 'practice' && result.feedback) {
      logger.event('practice_scored', { recording: s.recordingId, event_f1: result.feedback.metrics.event_f1, label_accuracy: result.feedback.metrics.label_accuracy,
        passed: result.feedback.passed, missed: result.feedback.flags.filter((f) => f.kind === 'MISSED').length,
        extra: result.feedback.flags.filter((f) => f.kind === 'EXTRA').length, other_type: result.feedback.flags.filter((f) => f.kind === 'TYPE').length });
      this.openReview(s, result.feedback);
      return;
    }
    if (s.mode === 'guided') {
      const g = ws.coach && ws.coach.summary;
      this.pathMessage = g && g.steps ? `Recording saved: ${g.stars} of ${g.max_stars} stars (${minutesText(g.time_s || 0)}).` : 'Recording saved.';
      await this.showTraining();
      return;
    }
    if (this.me.programme) { this.pathMessage = 'Recording saved.'; await this.showTraining(); return; }
    const next = result.next ? (this.assignments.items || []).find((i) => i.recording_id === result.next) : null;
    const demo = this.backend.isDemo ? `\n\n${DEMO_NOTICE}` : '';
    const milestone = reached.length ? `\n\nMilestone reached: ${reached.map((m) => m.name).join(', ')}.` : '';
    this.celebrate = reached;
    this.showHome();
    if (s.revision) {
      const v = (result.revision && result.revision.version) || s.revision.version;
      const go = next ? await ask('Revision saved', `Your revision of ${fileName} is saved as version ${v}. Version ${v - 1} is kept as it was.${milestone}${demo}\n\nNext: ${next.file_name}.`,
        { yes: 'Open next recording', no: 'Back to my recordings' })
        : await inform('Revision saved', `Your revision of ${fileName} is saved as version ${v}. Version ${v - 1} is kept as it was.${milestone}${demo}`);
      if (next && go) this.openAssignment(next);
      return;
    }
    if (next) {
      const go = await ask('Saved', `Your annotations of ${fileName} are saved and the recording is complete.${milestone}${demo}\n\nNext: ${next.file_name}.`,
        { yes: 'Open next recording', no: 'Back to my recordings' });
      if (go) this.openAssignment(next);
    } else {
      await inform('Saved', `Your annotations of ${fileName} are saved and the recording is complete. That was your last recording.${milestone}${demo}`);
    }
  }

  openReview(session, feedback) {
    const mine = session.store.toJSON();
    const rs = new AnnotationSession({
      backend: this.backend, recording: session.recording, manifest: session.manifest, recordingId: session.recordingId,
      mode: 'review', contextId: session.contextId, me: this.me, catalogue: this.catalogue, readOnly: true,
    });
    rs.store.reset(reviewAnnotations(mine, feedback.reference || []).filter((a) => this.catalogue.has(a.label)));
    rs.view = session.view;
    const ws = new Workspace(this, rs, { kind: 'review' });
    this.ws = ws;
    this._render(ws.el, 'review');
    ws.mount(this.content);
    new PracticeReview(ws, { feedback, mine, backend: this.backend }); // eslint-disable-line no-new
    ws.logOpened({ recording_id: session.recordingId, segment: 'review' });
  }

  async leaveRecording(ws, reason) {
    if (ws.kind === 'review') logger.event('practice_review_closed', { recording: ws.s.recordingId });
    ws.destroy();
    if (this.ws === ws) this.ws = null;
    void reason;
    await this.loadAssignments();
    if (this.me && this.me.programme) await this.showTraining();
    else this.showHome();
  }

  // ===================================================================== tests
  /** For the browser tests: the current state, read only. */
  debugState() {
    const ws = this.ws;
    return {
      route: this.route, backend: this.backend && this.backend.kind, signedIn: Boolean(this.me),
      annotations: ws ? ws.store.toJSON() : null, selection: ws ? [...ws.selection] : null, view: ws ? { ...ws.viewer.view } : null,
      viewerStats: ws ? { ...ws.viewer.stats } : null, currentLabel: ws ? ws.currentLabel : null, scope: ws ? ws.scope : null,
      loggedEvents: logger.sent + logger.queue.length, at: nowLocalIso(),
      admin: this.adminArea && ADMIN_ROUTE.test(this.route || '') ? this.adminArea.debugState() : null,
    };
  }
}
