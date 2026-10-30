// The application: which backend, signing in, the views and the moves between them.
//
// Views are addressed by a plain hash (#signin, #home, #open, #annotate, #review, #training, for
// experts #expert and #expert-<section>, and for administrators #admin and #admin-<section>), so the
// page also works where only such a hash survives (an embedded preview).
//
// The sign-in page loads only this module, what it shows and the chosen back end's client; every
// other view is a part loaded at its first use (js/lazy.js), with a Loading… page while it comes
// and a plain message with Try again when it cannot be loaded.

import { h, clear } from './ui/dom.js';
import { ask, inform, showDialog, setDialogLogger, dialogOpen } from './ui/dialog.js';
import { Catalogue } from './catalogue.js';
import { findBackend, connectServer, connectFirebase, makeDemo, rememberServer, unreachableText } from './api/choose.js';
import { DEMO_NOTICE } from './api/notice.js';
import { logger } from './log/logger.js';
import { signinView } from './views/signin.js';
import { appHeader, downloadFiles, smallScreenNotice } from './views/common.js';
import { friendlyDuration, nowLocalIso, plural, session } from './util.js';
import { loadPart, loadParts, partNow, preloadParts } from './lazy.js';

const VIEWS = ['signin', 'home', 'open', 'annotate', 'review', 'training', 'quiz', 'guide'];
/** The admin area's plain hashes (js/admin/model.js lists its sections). */
const ADMIN_ROUTE = /^admin(-[a-z]+)?$/;
/** The expert area's plain hashes (js/expert/sections.js lists its sections; the same rule as its EXPERT_ROUTE). */
const EXPERT_ROUTE = /^expert(-[a-z]+)?$/;
/** The token of a private invitation link, kept for the browser tab until it is used. */
const INVITE_KEY = 'electrotag.invite';

/**
 * The token of an invitation link (?invite=<token>), taken out of the address at once so that it
 * stays out of the history and bookmarks; kept for the tab until it is used.
 */
function takeInvite() {
  let token = null;
  try {
    const q = new URLSearchParams(location.search);
    token = q.get('invite');
    if (token) {
      q.delete('invite');
      const rest = q.toString();
      history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
      session.set(INVITE_KEY, token);
    }
  } catch { /* an address without one */ }
  if (!token) token = session.get(INVITE_KEY, null);
  return typeof token === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(token) ? token : null;
}

// The file readers (js/eeg/recording.js) are loaded when the first recording is opened (the
// demonstration may not need them), or in idle time just after signing in to a study, so that a
// connection lost later does not stop a file from being read. A failed load is tried again under
// another address (js/lazy.js).
async function openRecordingFiles(files) {
  return (await loadPart('readers')).openRecording(files);
}

/** What is fetched in idle time after signing in, so that opening a recording does not wait for it. */
const PRELOAD = ['open', 'device', 'deviceStore', 'session', 'workspace'];

const PART_TEXT = 'This part of ElectroTag could not be loaded, most probably because the internet connection was lost. ' +
  'Check your connection, then press Try again; if it still fails, reload the page.';

/** The page shown while a part of the application is loaded. */
function loadingPage(text = 'Loading…') {
  return h('main.page.loading', { 'aria-busy': 'true' }, h('p.subtitle', { role: 'status' }, text));
}

/** Reading errors that mean the files themselves cannot be read as a recording (eeg/util.js, RecordingError). */
const FORMAT_ERRORS = new Set(['corrupt_recording', 'unsupported_format', 'missing_companion', 'no_files', 'malformed_bids_metadata']);

/** True for an error in the files' format, the only reason a copy kept on this device is removed. */
function isFormatError(exc) {
  return Boolean(exc && exc.name === 'RecordingError' && FORMAT_ERRORS.has(exc.kind));
}

/** True when an error most probably comes from a lost connection (a part of the page that could not be loaded). */
function isConnectionError(exc, online = globalThis.navigator ? globalThis.navigator.onLine !== false : true) {
  if (!exc || isFormatError(exc)) return false;
  if (!online) return true;
  return exc.name === 'TypeError' && /fetch|import|module|network|load/i.test(String(exc.message || ''));
}

const CONNECTION_TEXT = 'This page could not load the part of ElectroTag that reads recordings, most probably because the ' +
  'internet connection was lost. Check your connection, then press Try again; if it still fails, reload the page.';
const TRAINING_MODES = { guided: 'a guided training recording', practice: 'a practice recording', assessment: 'a recording of your competency assessment' };

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
    this.reviews = null; // GET /me/reviews: the feedback on the annotator's saved work ({shown, reviews}, or null)
    this.celebrate = null; // milestones that the last save reached, shown once on the home page
    this.adminArea = null;
    this.expertArea = null;
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
    if (ADMIN_ROUTE.test(asked) || EXPERT_ROUTE.test(asked)) this._adminReturn = asked;
    this._reloadedIn = asked; // annotate/reopen.js
    const invite = takeInvite();
    this._render(h('main.page.loading', {}, h('p.subtitle', {}, 'Starting ElectroTag…')), 'signin');
    if (asked === 'guide') { await this.showGuide(); return; } // no sign-in
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
    if (invite && this.backend.acceptsInvites) {
      await this.showInvite(invite);
      return;
    }
    if (invite) session.remove(INVITE_KEY); // Firebase's invitations are its own links
    if (this.backend.signedIn) {
      try {
        await this._afterSignIn({ quiet: true });
        return;
      } catch { /* sign in again */ }
    }
    this.showSignin();
  }

  _unreachable(where, exc) {
    return unreachableText(where, exc);
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
      throw new Error(`There is no ElectroTag study at ${address}, or it does not answer. Check the address and try again.`);
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

  /** The welcome card of an invitation link: whose it is, then choosing a password. */
  async showInvite(token) {
    loadPart('invite').catch(() => {}); // fetched while the study is asked
    this._render(h('main.page.loading', {}, h('p.subtitle', {}, 'Checking your invitation…')), 'signin');
    let info = null;
    let problem = '';
    let code = '';
    let retry = false;
    try {
      info = await this.backend.inviteCheck(token);
    } catch (exc) {
      problem = exc.message;
      code = exc.code || '';
      if (exc.code && /^invite_/.test(exc.code)) session.remove(INVITE_KEY);
      else retry = true; // the study could not answer: the link may be good, so it is kept to ask again
    }
    if (this.route !== 'signin') return; // the person went on while the study answered
    await this._withParts(['invite'], 'signin', ({ inviteView }) => this._render(inviteView(this, token, { info, problem, code, retry }), 'signin'));
  }

  /** Set the password with the invitation and sign in (POST /invite/accept). */
  async acceptInvite(token, password) {
    await this.backend.inviteAccept(token, password);
    session.remove(INVITE_KEY);
    await this._afterSignIn({ quiet: false });
  }

  leaveInvite() {
    session.remove(INVITE_KEY);
    this.showSignin();
  }

  async signIn(id, password) {
    await this.backend.login(id, password);
    await this._afterSignIn({ quiet: false });
  }

  async _afterSignIn({ quiet }) {
    this.me = await this.backend.me();
    this.catalogue = new Catalogue(this.me.catalogue);
    // The first view's part is fetched while the visit and the assignments are asked for.
    const first = this.isAdmin ? ['admin', 'adminModel'] : this.inTraining() ? ['training'] : ['home'];
    loadParts(...first).catch(() => {}); // tried again, with a message, when the view is shown
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
    // In idle time: the readers (for a study; the demonstration's examples need none) and the
    // annotation view, so that opening a recording does not wait for them. A part that fails here is
    // tried again when it is needed.
    preloadParts([...(this.backend.isDemo ? [] : ['readers']), ...(this.isAdmin ? [] : ['home']), ...PRELOAD, ...(this.me.programme ? ['coach', 'practice'] : [])]);
    const want = (location.hash || '').replace(/^#/, '');
    // a reload while a recording was open: it opens again
    const reloadedIn = this._reloadedIn;
    this._reloadedIn = null;
    if (want === 'annotate' || reloadedIn === 'annotate') {
      const reopen = await loadPart('reopen').catch(() => null);
      if (reopen && await reopen.reopenAfterReload(this)) return;
    }
    // Administrators start in the admin area (or where a reload left them); they can still annotate.
    const back = this._adminReturn;
    this._adminReturn = null;
    const expertWanted = [want, back].find((r) => EXPERT_ROUTE.test(r || ''));
    if (this.isExpert && expertWanted && (EXPERT_ROUTE.test(want) || !want || want === 'signin')) await this.showExpert(expertWanted);
    else if (this.isAdmin && (ADMIN_ROUTE.test(want) || !want || want === 'signin')) await this.showAdmin(ADMIN_ROUTE.test(want) ? want : (ADMIN_ROUTE.test(back || '') ? back : 'admin'));
    else if (this.inTraining() && (!want || want === 'signin' || want === 'training' || quiet)) await this.showTraining();
    else this.showHome();
  }

  /** A trainee with stages still to do (once training is complete, home and its next recording come first). */
  inTraining() { return Boolean(this.me && this.me.programme && !this.me.programme.complete); }

  async loadAssignments() {
    const games = this.loadAchievements();
    const reviews = this.loadReviews();
    try { this.assignments = await this.backend.assignments(); } catch (exc) {
      if (exc.status === 401) throw exc;
      this.assignments = { items: [], next: null };
    }
    await games;
    await reviews;
  }

  /** The reviews of the annotator's saved work, when the study shows them (null otherwise, or when they cannot be read). */
  async loadReviews() {
    const a = this.me && this.me.study && this.me.study.annotation;
    if (!a || a.show_reviews_to_annotators === false || this.me.programme || !this.backend.myReviews) { this.reviews = null; return null; }
    try {
      this.reviews = await this.backend.myReviews();
    } catch (exc) {
      if (exc.status === 401) throw exc;
      this.reviews = null; // the home page works without them
    }
    return this.reviews;
  }

  /** The facts of the home page's game elements, when the study has them on (null otherwise, or when they cannot be read). */
  async loadAchievements() {
    const g = this.me && this.me.study && this.me.study.gamification;
    if (!g || !g.enabled || this.me.programme || !this.backend.achievements) { this.achievements = null; return null; }
    const changes = this._gamesSeq || 0;
    // The game elements' own code, fetched with the facts; the home page works without either.
    const part = loadParts('games', 'milestones').catch(() => null);
    try {
      const facts = await this.backend.achievements();
      await part;
      // A change of the goal made while this was read is newer than what it read.
      if ((this._gamesSeq || 0) === changes) this.achievements = facts;
    } catch (exc) {
      if (exc.status === 401) throw exc;
      this.achievements = null; // the home page works without them
    }
    return this.achievements;
  }

  /**
   * POST /me/achievements: changes are sent one after another, never two at once, and the answer
   * is kept only when no newer change was made meanwhile, so that a late answer never brings back
   * an older goal. Never repeated by itself after a failure, like every change.
   */
  changeAchievements(body) {
    const seq = (this._gamesSeq = (this._gamesSeq || 0) + 1);
    const sent = (this._gamesChain || Promise.resolve()).catch(() => {}).then(() => this.backend.setAchievements(body));
    this._gamesChain = sent;
    return sent.then((facts) => {
      if (seq === this._gamesSeq) this.achievements = facts;
      return facts;
    });
  }

  /** Draw the home page again after a change to the goal or the leaderboard (its list keeps its tab, search and page). */
  refreshGames() {
    if (this.route === 'home' && !this.ws) this.showHome();
  }

  /** The roles of the account signed in (GET /me: roles, or the older single role). */
  get roles() {
    if (!this.me) return [];
    return Array.isArray(this.me.roles) && this.me.roles.length ? this.me.roles : [this.me.role || 'annotator'];
  }

  /** True for an account with the role admin, who may use the admin area. */
  get isAdmin() { return this.roles.includes('admin'); }

  /** True for an expert or an administrator, who may use the expert area. */
  get isExpert() { return this.roles.includes('expert') || this.isAdmin; }

  /** Read GET /me again, after the admin area changed the study's settings. */
  async refreshMe() {
    if (!this.me) return;
    this.me = await this.backend.me();
    this.catalogue = new Catalogue(this.me.catalogue);
  }

  async signOut() {
    if (this.ws && !(await this.ws.close())) return;
    this._resumeLog();
    try {
      const { offerRemovalAtSignOut } = await loadPart('device');
      await offerRemovalAtSignOut(this);
    } catch { /* the part could not be loaded: signing out goes on without the offer */ }
    this.adminArea = null;
    this.expertArea = null;
    await logger.end('sign_out');
    await this.backend.logout();
    this.me = null;
    this.visitId = null;
    this.showSignin({ message: 'You have signed out.' });
  }

  sessionExpired() {
    if (this._expiring) return;
    this._expiring = true;
    if (ADMIN_ROUTE.test(this.route || '') || EXPERT_ROUTE.test(this.route || '')) this._adminReturn = this.route;
    if (this.ws) {
      this.ws.s.saveLocal();
      this.ws.destroy();
      this.ws = null;
    }
    this.me = null;
    this.adminArea = null;
    this.expertArea = null;
    this._adminLogPaused = false;
    logger.enabled = false;
    this.showSignin({ error: 'Your sign-in has ended. Sign in again to continue; your unsaved work is kept in this browser.' });
    setTimeout(() => { this._expiring = false; }, 500);
  }

  // ===================================================================== views
  /** Show `el` as the page; `route` null keeps the route (a Loading… page between two views). */
  _render(el, route) {
    this._renders = (this._renders || 0) + 1;
    // Leaving the open view stops its download from a link: a late file must not open by itself.
    if (this.openView && this.openView.el !== el) this.openView.leave();
    if (this.quizView && this.quizView.el !== el) {
      this.quizView.destroy(); // the quiz's answers are with the study; its recordings are closed
      this.quizView = null;
    }
    if (this.guideView && this.guideView.el !== el) {
      this.guideView.destroy();
      this.guideView = null;
    }
    if (this.snippetsView && this.snippetsView.el !== el) {
      this.snippetsView.destroy(); // the training path's snippets (js/training/snippets.js): their recordings are closed
      this.snippetsView = null;
    }
    // the snippets wait, with their recordings open, while the recognition check is taken from them; anything
    // else shown (a Loading… page aside) closes them
    const waiting = this.suspendedSnippets;
    if (waiting && route !== null && waiting.el !== el && !(this.quizView && this.quizView.el === el)) {
      waiting.destroy();
      this.suspendedSnippets = null;
    }
    clear(this.content);
    this.content.appendChild(el);
    if (route !== null) this._setRoute(route);
  }

  /**
   * The parts a view needs (js/lazy.js), then `show(...modules)`: at once when they have loaded
   * already, otherwise after a Loading… page. When one cannot be loaded, a plain message with Try
   * again takes the view's place. Nothing is shown when the person went elsewhere meanwhile.
   * Resolves with what `show` returns (undefined when it was not called).
   */
  _withParts(names, route, show) {
    const now = names.map(partNow);
    if (now.every(Boolean)) return Promise.resolve(show(...now));
    this._render(loadingPage(), null);
    const mine = this._renders;
    return loadParts(...names).then((mods) => (this._renders === mine ? show(...mods) : undefined), () => {
      if (this._renders === mine) this._render(this._partProblem(() => this._withParts(names, route, show)), route);
      return undefined;
    });
  }

  /** The page for a part that could not be loaded, with Try again. */
  _partProblem(again) {
    return h('div.view', { 'data-view': 'load-failed' }, this.me ? appHeader(this) : null,
      h('main.page', {}, h('h1', {}, 'This page could not be loaded'), h('p.banner', { role: 'alert' }, PART_TEXT),
        h('div.btn-row', {}, h('button.btn.primary', { type: 'button', 'data-log': 'load-again', onclick: again }, 'Try again'))));
  }

  /**
   * The parts needed on the way from the open view to the annotation view, or null when they cannot
   * be loaded: the open view then says so, with Try again (`again`).
   */
  async _openingParts(names, again) {
    const view = this.openView;
    const showing = view && this._stillOpen(view);
    const waiting = showing && !names.every(partNow);
    if (waiting) view.step('load', 'Loading the annotation view…');
    try {
      const mods = await loadParts(...names);
      if (waiting && this._stillOpen(view)) view.step('load', 'Loaded the annotation view', 'done');
      return mods;
    } catch {
      if (showing && this._stillOpen(view)) {
        view.step('load', 'Loading the annotation view', 'failed');
        view.showProblem(PART_TEXT, [h('button.btn.primary', { type: 'button', 'data-log': 'load-again', onclick: again }, 'Try again'), view.chooseAgainButton(false)]);
      } else if (!showing) {
        this._render(this._partProblem(again), this.route);
      }
      return null;
    }
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
    document.title = { signin: 'ElectroTag – sign in', home: 'ElectroTag – your recordings', open: 'ElectroTag – open a recording',
      annotate: `ElectroTag – ${this.ws ? this.ws.s.recording.fileName : 'annotate'}`, review: 'ElectroTag – practice review',
      training: 'ElectroTag – training programme', quiz: 'ElectroTag – quiz' }[route]
      || (ADMIN_ROUTE.test(route) ? 'ElectroTag – admin' : EXPERT_ROUTE.test(route) ? 'ElectroTag – expert work' : 'ElectroTag');
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
    if (want === this.route || (!VIEWS.includes(want) && !ADMIN_ROUTE.test(want) && !EXPERT_ROUTE.test(want))) return;
    if (this.ws) {
      // Back or forward while a recording is open: the same as its Close button.
      this._settingHash = true;
      location.hash = this.route;
      if (!dialogOpen()) this.ws.close();
      return;
    }
    if (want === 'guide') { this.showGuide(); return; }
    if (!this.me) { if (want !== 'signin') this.showSignin(); return; }
    if (ADMIN_ROUTE.test(want)) { if (this.isAdmin) this.showAdmin(want); else this.showHome(); return; }
    if (EXPERT_ROUTE.test(want)) { if (this.isExpert) this.showExpert(want); else this.showHome(); return; }
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

  /** The artifact reference guide as a page of its own (js/guide/guide.js). */
  showGuide() {
    return this._withParts(['guide'], 'guide', ({ showGuidePage }) => showGuidePage(this));
  }

  showHome() {
    this._fromTraining = false;
    return this._withParts(['home'], 'home', ({ homeView }) => this._render(homeView(this), 'home'));
  }

  /**
   * The admin area (js/admin/area.js, loaded the first time it is needed): `route` is #admin or
   * #admin-<section>; `params` passes something to the section, such as the annotator to assign to.
   */
  async showAdmin(route = 'admin', params = null) {
    if (!this.isAdmin) { this.showHome(); return; }
    await this._withParts(['admin', 'adminModel'], ADMIN_ROUTE.test(route) ? route : 'admin', async ({ AdminArea }, { sectionForRoute }) => {
      const section = sectionForRoute(route);
      if (!section) route = 'admin';
      if (!this.adminArea || this.adminArea.backend !== this.backend || this.adminArea.annotatorId !== this.me.annotator_id) {
        this.adminArea = new AdminArea(this);
        await this.adminArea.ready();
      }
      if (ADMIN_ROUTE.test(this.route || '') && this.content.contains(this.adminArea.el)) this._setRoute(route);
      else this._render(this.adminArea.el, route);
      await this.adminArea.show(section || 'overview', params);
    });
  }

  /**
   * The expert area (js/expert/area.js, loaded the first time it is needed): `route` is #expert or
   * #expert-<section>. For experts and administrators; anyone else goes home.
   */
  async showExpert(route = 'expert', params = null) {
    if (!this.isExpert) { this.showHome(); return; }
    await this._withParts(['expert', 'expertSections'], EXPERT_ROUTE.test(route) ? route : 'expert', async ({ ExpertArea }, { expertSectionForRoute }) => {
      const section = expertSectionForRoute(route);
      if (!section) route = 'expert';
      if (!this.expertArea || this.expertArea.backend !== this.backend || this.expertArea.annotatorId !== this.me.annotator_id) {
        this.expertArea = new ExpertArea(this);
        await this.expertArea.ready();
      }
      if (EXPERT_ROUTE.test(this.route || '') && this.content.contains(this.expertArea.el)) this._setRoute(route);
      else this._render(this.expertArea.el, route);
      await this.expertArea.show(section || 'overview', params);
    });
  }

  async reloadHome() {
    await this.loadAssignments();
    this.showHome();
  }

  /**
   * The short-segment quiz of a reference set (one of me.quizzes). From the snippets (the recognition check),
   * `shared` lends it the recordings already open there and `onLeave` goes back to them.
   */
  showQuiz(setId, { fromTraining = false, shared = null, onLeave = null } = {}) {
    this._fromTraining = Boolean(fromTraining);
    this.quizSetId = setId;
    return this._withParts(['quiz'], 'quiz', ({ QuizView }) => {
      const view = new QuizView(this, setId, { shared, onLeave });
      if (this.quizView) this.quizView.destroy();
      this.quizView = view;
      this._render(view.el, 'quiz');
      view.start();
    });
  }

  async showTraining(message = this.pathMessage) {
    this.pathMessage = '';
    loadPart('training').catch(() => {}); // fetched while the study is asked
    let data;
    try {
      data = await this.backend.training();
    } catch (exc) {
      if (exc.status === 401) return;
      this._render(h('div.view', {}, appHeader(this), h('main.page', {}, h('h1', {}, 'Training programme'), h('p.banner', {}, `The training path could not be loaded: ${exc.message}`))), 'training');
      return;
    }
    if (this.me && this.me.programme) this.me.programme.complete = !data.next;
    await this._withParts(['training'], 'training', ({ trainingPath }) => {
      logger.event('training_path_opened', { reference_set: data.set_id, stages: data.stages.map((s) => ({ key: s.key, status: s.status, done: s.done, total: s.total })),
        next_stage: data.next ? data.next.stage : null, next_recording: data.next ? data.next.recording_id : null, message });
      this._fromTraining = true;
      const page = trainingPath(data, {
        app: this, annotatorId: this.me.annotator_id, message, // the path opens the tour and the snippets itself
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
    });
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
    // Continue (where you left off, or the revision): the unfinished work is restored without asking.
    const resume = Boolean(item && (item.status === 'in_progress' || (revise && item.revising)));
    return this.openFromComputer(item, { revise, resume });
  }

  /** The open view (js/views/open.js); resolves with it once it is shown (undefined when it could not be loaded). */
  openFromComputer(expected, { revise = false, purpose = null, resume = false } = {}) {
    if (this.openView) this.openView.leave();
    const route = purpose && purpose.route ? purpose.route : 'open';
    return this._withParts(['open'], route, ({ OpenView }) => {
      this.openView = new OpenView(this, { expected, revise: Boolean(expected && revise), purpose });
      if (resume) this.openView.resume = true;
      this._render(this.openView.el, this.openView.route);
      return this.openView;
    });
  }

  // ===================================================== problem reports and reviews
  /** Report a problem with a recording from the home page (annotate/problem.js); the list is drawn again after. */
  async reportProblemFor(item) { return (await loadPart('homeFeedback')).reportFromHome(this, item); }

  /** The annotator reads the feedback on a reviewed recording: its file is opened, and the latest saved version shown read only. */
  openFeedback(item) {
    this.openFromComputer(item, { purpose: { kind: 'feedback', route: 'open', title: `See the feedback on ${item.file_name}`,
      note: 'Your latest saved version opens to read, with the feedback on it beside your annotations. Nothing changes unless you open it to revise.' } });
  }

  /**
   * An administrator reviews someone's saved recording (docs/web/admin.md, "Reviewing saved work"): the
   * EEG file is opened from this computer and checked against the study's manifest, because the EEG
   * never reaches the study; then the saved annotations are shown read only, with the review panel.
   * `back` is the admin area's section (and its parameters) to return to.
   */
  async startReview({ annotator_id: aid, recording_id: rid, back = { route: 'admin-results', params: null } }) {
    let target;
    try {
      target = await this.backend.admin('saved_attempt_get', { annotator_id: aid, recording_id: rid });
    } catch (exc) {
      if (exc.status !== 401) await inform('The review cannot start', exc.message);
      return;
    }
    const m = target.manifest || {};
    const goBack = () => this.showAdmin(back.route, back.params);
    await this.openFromComputer({ recording_id: rid, file_name: target.file_name, format: m.format }, { purpose: { kind: 'review', route: 'admin-review', target, back, onBack: goBack,
      title: `Review ${target.file_name}`,
      note: `${aid}${target.display_name ? ` (${target.display_name})` : ''} saved version ${target.attempt}. Open the recording from this computer: its fingerprint is checked against the study's copy, then the saved annotations are shown read only, ready to review.` } });
  }

  /**
   * Someone's saved work opened for a purpose (an administrator's review, the expert area's corrections,
   * replays, adjudications ...): js/views/purposes.js checks the file against the study's copy and opens it.
   */
  async _openForPurpose(recording, fp, view) {
    const parts = await this._openingParts(['purposes'], () => this._openForPurpose(recording, fp, view));
    if (!parts || !this._stillOpen(view)) return;
    await parts[0].openForPurpose(this, recording, fp, view);
  }

  /** The annotator's read-only view of a reviewed recording, with Open to revise when the study allows it. */
  async _openFeedbackView({ recording, match: m, sha }) {
    const names = ['session', 'workspace', 'reviewPass', 'homeList', 'homeFeedback'];
    const view = this.openView;
    const waited = !names.every(partNow);
    const parts = await this._openingParts(names, () => this._openFeedbackView({ recording, match: m, sha }));
    if (!parts || (waited && view && !this._stillOpen(view))) return; // the person went elsewhere while they loaded
    const [{ AnnotationSession }, { Workspace }, { FeedbackPanel }, { canRevise }, { reviewsOf }] = parts;
    const item = (this.assignments.items || []).find((i) => i.recording_id === m.recording_id && i.mode === m.mode) || { recording_id: m.recording_id, mode: m.mode, status: 'done' };
    let session;
    try {
      session = new AnnotationSession({ backend: this.backend, recording, manifest: m.manifest, recordingId: m.recording_id, mode: m.mode, contextId: m.context_id,
        me: this.me, catalogue: this.catalogue, sha256: sha, readOnly: true });
      session.store.reset((m.saved.annotations || []).filter((a) => this.catalogue.has(a.label)));
    } catch (exc) {
      this.openView && this.openView.showProblem(exc.message, [this.openView.chooseAgainButton()]);
      return;
    }
    if (this.ws) this.ws.destroy();
    const ws = new Workspace(this, session, { kind: 'feedback' });
    this.ws = ws;
    this._render(ws.el, 'annotate');
    ws.mount(this.content);
    const revise = canRevise(this, item) ? () => this._reviseFromFeedback(ws, recording, sha) : null;
    new FeedbackPanel(ws, { reviews: reviewsOf(this, item), onRevise: revise, stepper: true }); // eslint-disable-line no-new
    ws.logOpened({ recording_id: m.recording_id, match: m.status, segment: 'feedback', version: m.saved.version });
  }

  /** From the feedback to a revision of the same file (already read here): the study is asked again with revise. */
  async _reviseFromFeedback(ws, recording, sha) {
    if (this._revising) return;
    this._revising = true;
    try {
      const m = await this.backend.match({ file_name: recording.fileName, size_bytes: recording.sizeBytes, format: recording.format === 'synthetic' ? 'edf' : recording.format,
        sha256: sha, sfreq: recording.sfreq, n_samples: recording.nSamples, ch_names: recording.channels.map((c) => c.name), revise: true });
      if (this.ws !== ws) return; // the person left meanwhile
      if (!m.revision) { ws.say(m.message || 'This recording cannot be revised now.'); return; }
      logger.event('feedback_closed', { recording_id: ws.s.recordingId, to: 'revision' });
      ws.destroy();
      this.ws = null;
      await this.openWorkspace({ recording, match: m, sha });
    } catch (exc) {
      if (exc.status !== 401 && this.ws === ws) ws.say(`The study could not be asked: ${exc.message}`);
    } finally {
      this._revising = false;
    }
  }

  /** Demonstration: the built-in copy of an example recording. */
  async useExample(recordingId) {
    const recording = this.backend.exampleRecording(recordingId);
    const view = this.openView && this.route === this.openView.route ? this.openView : await this.openFromComputer(null);
    if (view) await this._process(recording, view);
  }

  /** Whether `view` is still the open view on screen: work for one that was left is dropped. */
  _stillOpen(view) {
    return this.openView === view && this.route === view.route;
  }

  async processFiles(files, view, source = null) {
    if (!this._stillOpen(view)) return;
    view.reset();
    view.step('read', source && source.kind === 'device' ? 'Reading the copy kept on this device…' : 'Reading the file…');
    let recording;
    try {
      recording = await openRecordingFiles(files);
      recording.source = source; // where the files came from, and whether to keep them (js/views/device.js)
      recording.sourceFiles = files;
    } catch (exc) {
      logger.event('load_failed', { kind: 'read', reason: exc.message });
      // A copy kept on this device is removed only when its files cannot be read as a recording.
      if (source && source.kind === 'device' && isFormatError(exc)) await this._dropBrokenCopy(source.sha256);
      if (!this._stillOpen(view)) return;
      view.step('read', 'Reading the file', 'failed');
      if (isConnectionError(exc)) {
        // Nothing is wrong with the file: the same files are read again once the connection is back.
        view.showProblem(CONNECTION_TEXT, [h('button.btn.primary', { type: 'button', 'data-log': 'read-again', onclick: () => this.processFiles(files, view, source) }, 'Try again'),
          view.chooseAgainButton(false)]);
        return;
      }
      view.showProblem(`This file could not be opened: ${exc.message}`, [view.chooseAgainButton()]);
      return;
    }
    if (!this._stillOpen(view)) return; // the person went elsewhere while the file was read
    await this._process(recording, view);
  }

  async _process(recording, view) {
    view.reset();
    view.step('read', `Read ${recording.fileName}: ${recording.channels.length} channels, ${friendlyDuration(recording.durationS)} at ${recording.sfreq} Hz`, 'done');
    view.step('fp', 'Checking the file (its fingerprint)…', 'working', 0);
    let fp;
    try {
      fp = await recording.fingerprint((f) => view.step('fp', `Checking the file (its fingerprint) ${Math.round(f * 100)}%`, 'working', f));
    } catch (exc) {
      view.step('fp', 'Checking the file', 'failed');
      view.showProblem(`The file could not be read to the end: ${exc.message}`, [view.chooseAgainButton()]);
      return;
    }
    if (!this._stillOpen(view)) return;
    if (!(await this._checkKeptCopy(recording, fp, view))) return;
    view.step('fp', 'Checked the file', 'done');
    if (view.purpose && view.purpose.target) { await this._openForPurpose(recording, fp, view); return; }
    view.step('match', this.backend.isDemo ? 'Looking it up in the demonstration study…' : 'Asking the study whether this is one of your recordings…');
    let m;
    try {
      m = await this.backend.match({
        file_name: recording.fileName, size_bytes: recording.sizeBytes, format: recording.format === 'synthetic' ? 'edf' : recording.format,
        sha256: fp.hex, sfreq: recording.sfreq, n_samples: recording.nSamples, ch_names: recording.channels.map((c) => c.name),
        ...(view.revise ? { revise: true } : {}),
        ...(view.purpose && view.purpose.kind === 'feedback' ? { view_saved: true } : {}),
      });
    } catch (exc) {
      if (exc.code === 'training_required' && this._stillOpen(view)) {
        // a study recording, while study work waits for the competency assessment (js/training/path.js)
        view.step('match', 'A study recording: locked until you pass your assessment', 'failed');
        view.showProblem(exc.message, [h('button.btn.primary', { type: 'button', 'data-log': 'training-path', onclick: () => this.showTraining() },
          'Go to my training path'), view.chooseAgainButton(false)]);
        return;
      }
      view.step('match', 'Asking the study', 'failed');
      if (exc.status !== 401 && this._stillOpen(view)) {
        // Asking is a read: the person may ask again with the file already read and checked.
        view.showProblem(`The study could not be reached to check this file: ${exc.message}. Check your internet connection, then press Try again.`,
          [h('button.btn.primary', { type: 'button', 'data-log': 'match-again', onclick: () => this._process(recording, view) }, 'Try again'), view.chooseAgainButton(false)]);
      }
      return;
    }
    // A late answer (a slow study) for a view that was left opens nothing: the person has moved on,
    // perhaps to another recording, which must not be closed under them.
    if (!this._stillOpen(view)) return;
    logger.event('recording_loading', { recording_id: m.recording_id, match: m.status, file_name: recording.fileName, size_bytes: recording.sizeBytes });
    const back = view.backButton();
    if (m.saved && view.purpose && view.purpose.kind === 'feedback') {
      view.step('match', m.message, 'done');
      await this._openFeedbackView({ recording, match: m, sha: fp.hex });
      return;
    }
    if (m.status === 'unusable') {
      view.step('match', 'Set aside', 'done');
      view.showMessage(m.message, [back, view.chooseAgainButton(false)], 'note');
      return;
    }
    if (m.status === 'matched') {
      view.step('match', m.message, 'done');
      if (!(await this._confirmOther(view, m))) return;
      await this.openWorkspace({ recording, match: m, sha: fp.hex });
    } else if (m.status === 'matched_metadata') {
      view.step('match', m.message, 'done');
      if (!(await this._confirmOther(view, m))) return;
      const body = h('div', {}, h('p.dialog-text', {}, m.message), h('ul', {}, (m.differences || []).map((d) => h('li', {}, d))),
        h('p.dialog-text', {}, 'You can open it anyway: your annotations are saved with this file\'s fingerprint, so the study team can check it. Or choose the study\'s copy of the file.'));
      const go = await showDialog({ title: 'Not exactly the study\'s copy', body, logText: m.message,
        buttons: [{ label: 'Choose another file', value: false }, { label: 'Open it anyway', value: true, kind: 'primary' }], cancelValue: false });
      if (go) await this.openWorkspace({ recording, match: m, sha: fp.hex });
      else view.showMessage('Choose the study\'s copy of the recording.', [view.chooseAgainButton()]);
    } else if (m.status === 'unknown') {
      view.step('match', 'Not a recording of this study', 'failed');
      view.showMessage(view.training ? this._notTheTrainingFile(view) : m.message, [view.chooseAgainButton(),
        h('button.btn', { type: 'button', onclick: () => this.openWorkspace({ recording, match: m, sha: fp.hex, tryOut: true }) }, 'Look at it without saving')], 'banner');
    } else if (m.status === 'not_assigned') {
      view.step('match', 'Not one of your recordings now', 'failed');
      view.showMessage(view.training ? this._notTheTrainingFile(view, m.recording_id) : m.message, [view.chooseAgainButton(false), back], 'banner');
    } else if (m.status === 'done') {
      view.step('match', 'Already finished', 'done');
      // A finished study recording can be revised from here too, when the study allows it.
      const item = (this.assignments.items || []).find((i) => i.recording_id === m.recording_id && i.mode === m.mode && (i.context_id || '') === (m.context_id || ''));
      const homeList = item ? await loadPart('homeList').catch(() => null) : null;
      if (!this._stillOpen(view)) return;
      const revise = homeList && homeList.canRevise(this, item) && !view.revise
        ? h('button.btn', { type: 'button', 'data-log': 'open-to-revise', onclick: () => { view.revise = true; this._process(recording, view); } }, 'Open to revise')
        : null;
      view.showMessage(m.message, [back, revise, view.chooseAgainButton(false)].filter(Boolean), 'note');
    } else {
      view.step('match', m.message || m.status, 'failed');
    }
  }

  /** What a training page says of a file that is not the recording its step needs. */
  _notTheTrainingFile(view, rid = null) {
    const want = view.expected.file_name || view.expected.recording_id;
    return `This step of your training needs ${want}, and ${rid ? `the file you chose is ${rid}, another recording of the study` : 'this file is not that recording'}. ` +
      `Choose ${want}: your study team sent it to you with your training recordings.`;
  }

  /**
   * The page asked for one recording and the file is another of the person's recordings: asked first
   * when it would change what kind of work is done (a study recording chosen on a training page, or the
   * other way round) or which training step is done. Two study recordings need no question.
   */
  async _confirmOther(view, m) {
    const exp = view.expected;
    if (!exp || view.purpose || view.revise) return true;
    const modeOf = (x) => x || 'standard';
    if (m.recording_id === exp.recording_id && modeOf(m.mode) === modeOf(exp.mode)) return true;
    if (modeOf(m.mode) === 'standard' && modeOf(exp.mode) === 'standard') return true;
    const what = (mode) => TRAINING_MODES[modeOf(mode)] || 'one of your study recordings, which counts as real work';
    const want = exp.file_name || exp.recording_id;
    const go = await showDialog({ title: 'A different recording', logText: `chose ${m.recording_id} (${modeOf(m.mode)}) for ${exp.recording_id} (${modeOf(exp.mode)})`,
      className: 'other-recording',
      body: h('div', {}, h('p.dialog-text', {}, `You chose ${m.recording_id}, ${what(m.mode)}. This page is for ${want}, ${what(exp.mode)}.`),
        h('p.dialog-text', {}, `Choose ${want} for this page, or open ${m.recording_id} anyway.`)),
      buttons: [{ label: 'Open it anyway', value: true }, { label: 'Choose another file', value: false, kind: 'primary' }], cancelValue: false });
    if (go && this._stillOpen(view)) return true;
    if (this._stillOpen(view)) view.showMessage(`Choose ${want}.`, [view.chooseAgainButton()]);
    return false;
  }

  /** A copy kept on this device must still be the file it was kept as (its fingerprint). */
  async _checkKeptCopy(recording, fp, view) {
    const src = recording.source;
    if (!src || src.kind !== 'device' || fp.hex === src.sha256) return true;
    view.step('fp', 'Checking the copy kept on this device', 'failed');
    await this._dropBrokenCopy(src.sha256);
    view.showProblem('The copy of this recording kept on this device has changed, so it has been removed. Choose the file, or open its link again.', [view.chooseAgainButton()]);
    return false;
  }

  /** Remove a copy kept on this device whose files are broken (js/views/device.js, loaded with the open view). */
  async _dropBrokenCopy(sha256) {
    const { dropBrokenCopy } = await loadPart('device');
    await dropBrokenCopy(this, sha256);
  }

  _position(recordingId) {
    const guided = (this.assignments.items || []).filter((i) => i.mode === 'guided');
    const i = guided.findIndex((x) => x.recording_id === recordingId);
    return [i >= 0 ? i + 1 : 1, Math.max(1, guided.length)];
  }

  async openWorkspace({ recording, match, sha, tryOut = false }) {
    const view = this.openView;
    const names = ['session', 'workspace', 'device', 'deviceStore'];
    if (!tryOut && match.mode === 'guided') names.push('coach');
    if (!tryOut && match.revision) names.push('reviewPass');
    const waited = !names.every(partNow);
    const parts = await this._openingParts(names, () => this.openWorkspace({ recording, match, sha, tryOut }));
    if (!parts || (waited && view && !this._stillOpen(view))) return; // the person went elsewhere while they loaded
    const [{ AnnotationSession }, { Workspace }, { keepOnDevice }, { DeviceStore }] = parts;
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
    {
      // a try-out's work is only in this browser
      const draft = session.pickDraft(tryOut ? null : match.draft);
      if (draft) {
        const resume = Boolean(this.openView && this.openView.resume);
        const yes = resume || await this._askRestore(session, draft);
        if (yes) {
          const view = session.restore(draft);
          if (view) session.view = view;
        } else {
          // Set aside in this tab, so that it can still be brought back (the Annotations tab offers it).
          logger.event('draft_discarded', { recording_id: session.recordingId, n_annotations: draft.annotations.length,
            elapsed_s: Math.round((Number(draft.elapsed_s) || 0) * 10) / 10, ...(session.revision ? { revises: session.revision.revises } : {}) });
          await session.discardDrafts({ draft });
        }
      }
    }
    if (!tryOut) void keepOnDevice(this, recording, match, sha);
    if (this.ws) this.ws.destroy();
    const ws = new Workspace(this, session, { kind: tryOut ? 'tryout' : 'annotate' });
    this.ws = ws;
    // A recording opened from a copy kept on this device reads its files as it is viewed: the copy is
    // marked in use, so that no tab removes it until the recording is closed.
    if (recording.source && recording.source.kind === 'device') void DeviceStore.holdInUse(sha).then((release) => ws.onDestroy(release));
    this._render(ws.el, 'annotate');
    ws.mount(this.content);
    if (session.mode === 'guided') {
      const { GuidedCoach } = partNow('coach');
      ws.coach = new GuidedCoach(ws, { backend: this.backend, recordingId: session.recordingId, position: this._position(session.recordingId) });
      await ws.coach.start();
      ws._refreshState();
    }
    if (session.revision) partNow('reviewPass').attachFeedback(this, ws); // the review notes beside a revision of a reviewed recording
    ws.logOpened({ recording_id: session.recordingId, match: match.status, ...(session.revision ? { revision: session.revision.version } : {}) });
    if (session.revision) {
      logger.event('revision_started', { session_id: session.sessionId, recording_id: session.recordingId, version: session.revision.version,
        revises: session.revision.revises, revises_saved_at: session.revision.saved_at || null, annotations_loaded: session.store.size, resumed: session.resumed });
    }
  }

  /**
   * Restore unfinished work, or start afresh? Esc or a click beside the question keeps the work (it
   * restores), and starting afresh asks a second time, as Discard and close does. True to restore.
   */
  async _askRestore(session, draft) {
    const n = draft.annotations.length;
    const rev = session.revision;
    const what = `${plural(n, 'annotation')} and ${friendlyDuration(draft.elapsed_s || 0)} of ${rev ? 'revising' : 'work on'} ${session.recording.fileName}, kept automatically ${friendlyTime(draft.saved_at)}.`;
    const afresh = rev ? `Start again from version ${rev.revises}` : 'Start afresh';
    const keep = rev ? 'Continue the revision' : 'Restore and continue';
    const body = h('div', {}, h('p.dialog-text', {}, what),
      h('p.dialog-text', {}, rev ? `Continue the revision, or start again from version ${rev.revises} as it was saved?` : 'Restore it and continue?'));
    for (;;) {
      const choice = await showDialog({ title: rev ? 'Continue your revision?' : 'Restore unfinished work?', body, className: 'restore-question', logText: what,
        buttons: [{ label: afresh, value: 'afresh' }, { label: keep, value: 'restore', kind: 'primary' }], cancelValue: 'restore' });
      if (choice !== 'afresh') return true;
      const sure = await ask(rev ? 'Discard your changes?' : 'Delete your unfinished work?',
        `${rev ? `Your changes in this revision (${plural(n, 'annotation')}, ${friendlyDuration(draft.elapsed_s || 0)})` : `Your ${plural(n, 'annotation')} and ${friendlyDuration(draft.elapsed_s || 0)} of work`} ` +
        `are deleted from your draft. Until you close this tab, the Annotations tab offers to bring them back.`,
        { yes: rev ? 'Discard them' : 'Delete them', no: 'Keep them', defaultYes: false, destructive: true });
      if (sure) return false;
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
    const device = partNow('device'); // loaded with the annotation view
    if (device) await device.afterFinishOnDevice(this, s.recordingId); // the save is complete and verified by now
    // Milestones that this save reached: celebrated once on the home page, never in the way of the next recording.
    const games = partNow('games');
    const ms = partNow('milestones');
    const reached = before && this.achievements && ms ? ms.newlyReached(before, this.achievements) : [];
    if (reached.length && games) games.logMilestones(reached);
    if (s.mode === 'practice' && result.feedback) {
      logger.event('practice_scored', { recording: s.recordingId, event_f1: result.feedback.metrics.event_f1, label_accuracy: result.feedback.metrics.label_accuracy,
        passed: result.feedback.passed, missed: result.feedback.flags.filter((f) => f.kind === 'MISSED').length,
        extra: result.feedback.flags.filter((f) => f.kind === 'EXTRA').length, other_type: result.feedback.flags.filter((f) => f.kind === 'TYPE').length });
      await this.openReview(s, result.feedback);
      return;
    }
    if (s.mode === 'guided' && ws.coach && typeof ws.coach.afterSaved === 'function') { await ws.coach.afterSaved(this, result); return; }
    if (s.mode === 'guided') {
      const g = ws.coach && ws.coach.summary;
      const coach = partNow('coach');
      this.pathMessage = g && g.steps && coach ? `Recording saved: ${g.stars} of ${g.max_stars} stars (${coach.minutesText(g.time_s || 0)}).` : 'Recording saved.';
      await this.showTraining();
      return;
    }
    if (this.me.programme && s.contextId === this.me.programme.set_id) {
      // the last assessment recording: the training path says how it went (passed, or waiting for the study team)
      const a = s.mode === 'assessment' ? result.assessment : null;
      this.pathMessage = a && a.complete ? 'Your last assessment recording is saved.' : 'Recording saved.';
      await this.showTraining();
      return;
    }
    const next = result.next ? (this.assignments.items || []).find((i) => i.recording_id === result.next) : null;
    const demo = this.backend.isDemo ? `\n\n${DEMO_NOTICE}` : '';
    const extra = await loadPart('myFiles').then((m) => m.savedFor(this, s, result), () => null); // the files just saved, to keep
    const milestone = reached.length ? `\n\nMilestone reached: ${reached.map((m) => m.name).join(', ')}.` : '';
    this.celebrate = reached;
    this.showHome();
    if (s.revision) {
      const v = (result.revision && result.revision.version) || s.revision.version;
      const go = next ? await ask('Revision saved', `Your revision of ${fileName} is saved as version ${v}. Version ${v - 1} is kept as it was.${milestone}${demo}\n\nNext: ${next.file_name}.`,
        { yes: 'Open next recording', no: 'Back to my recordings', extra })
        : await inform('Revision saved', `Your revision of ${fileName} is saved as version ${v}. Version ${v - 1} is kept as it was.${milestone}${demo}`, { extra });
      if (next && go) this.openAssignment(next);
      return;
    }
    if (next) {
      const go = await ask('Saved', `Your annotations of ${fileName} are saved and the recording is complete.${milestone}${demo}\n\nNext: ${next.file_name}.`,
        { yes: 'Open next recording', no: 'Back to my recordings', extra });
      if (go) this.openAssignment(next);
    } else {
      await inform('Saved', `Your annotations of ${fileName} are saved and the recording is complete. That was your last recording.${milestone}${demo}`, { extra });
    }
  }

  /** The practice review after a practice recording is saved (js/training/review.js, loaded at its first use). */
  openReview(session, feedback) {
    return this._withParts(['session', 'workspace', 'practice'], 'review', (sm, wm, pm) => this._openReview(session, feedback, sm, wm, pm));
  }

  _openReview(session, feedback, { AnnotationSession }, { Workspace }, { PracticeReview, reviewAnnotations }) {
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
    if (ws.kind === 'feedback') logger.event('feedback_closed', { recording_id: ws.s.recordingId, to: 'home' });
    ws.destroy();
    if (this.ws === ws) this.ws = null;
    void reason;
    if (ws.kind === 'reviewing') {
      const back = ws.reviewBack || { route: 'admin-results', params: null };
      await this.showAdmin(back.route, back.params);
      return;
    }
    await this.loadAssignments();
    if (this.inTraining()) await this.showTraining();
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
      expert: this.expertArea && EXPERT_ROUTE.test(this.route || '') ? this.expertArea.debugState() : null, roles: this.roles,
    };
  }
}
