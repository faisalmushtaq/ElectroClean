// The parts of the application that are loaded when they are first needed (docs/web/architecture.md,
// "Loading on demand"). The sign-in page loads only what it shows and the chosen back end's client;
// the home page, the annotation view, training, the quiz, the admin area, the expert area, the games
// and the EEG readers each come with the first view that uses them, and the readers and the annotation view are
// fetched in idle time after signing in, so that opening a recording does not wait for them.
//
// Each part is a module of this folder, imported once: its promise is kept, so every caller shares
// one download. A part that failed (most often a connection lost while it was fetched) is asked for
// again at the next use, under another address, because Chromium remembers a module that failed to
// load for the page's life (the module itself is the same file).

const PARTS = Object.freeze({
  home: './views/home.js',
  invite: './views/invite.js',
  open: './views/open.js',
  device: './views/device.js',
  deviceStore: './data/device_store.js',
  workspace: './annotate/workspace.js',
  session: './annotate/session.js',
  reviewPass: './annotate/review_pass.js',
  homeList: './views/home_list.js',
  homeFeedback: './views/home_feedback.js',
  homeDue: './views/home_due.js',
  games: './views/home_games.js',
  milestones: './games/milestones.js',
  training: './training/path.js',
  coach: './training/coach.js',
  practice: './training/review.js',
  quiz: './training/quiz.js',
  readers: './eeg/recording.js',
  admin: './admin/area.js',
  adminModel: './admin/model.js',
  expert: './expert/area.js',
  expertSections: './expert/sections.js',
  purposes: './views/purposes.js',
  settingsChecks: './admin/settings_checks.js',
  demoExpert: './api/demo_expert.js',
  demoLibrary: './api/demo_library.js',
  corrections: './expert/correction_pass.js',
  correctionFeedback: './expert/correction_feedback.js',
  replay: './replay/player.js',
  overlay: './expert/overlay.js',
  demoTraining: './api/demo_training_stages.js',
  tour: './training/tour.js',
  snippets: './training/snippets.js',
  viewer: './viewer/viewer.js',
  questionnaire: './views/questionnaire.js',
  demoQuestionnaire: './api/demo_questionnaire.js',
});

const pending = new Map(); // name -> the promise of its module
const ready = new Map(); // name -> its module, once loaded
const failures = new Map(); // name -> how many times it failed to load

/** The address a part is imported from: its own, or with ?attempt=N after N failures. */
export function partAddress(name, failed = failures.get(name) || 0) {
  const path = PARTS[name];
  if (!path) throw new Error(`No part of ElectroTag is called ${name}.`);
  return failed ? `${path}?attempt=${failed}` : path;
}

/** The module of a part, loaded at its first use (one download, however many ask). */
export function loadPart(name) {
  let p = pending.get(name);
  if (!p) {
    p = import(partAddress(name)).then((mod) => {
      ready.set(name, mod);
      return mod;
    }, (exc) => {
      pending.delete(name);
      failures.set(name, (failures.get(name) || 0) + 1);
      throw exc;
    });
    pending.set(name, p);
  }
  return p;
}

/** The modules of several parts, in the order asked. */
export function loadParts(...names) {
  return Promise.all(names.map(loadPart));
}

/** The module of a part that has loaded already, or null (for drawing a page at once when it can be). */
export function partNow(name) {
  return ready.get(name) || null;
}

/** Load parts in idle time, one after the other, so that they are there when wanted; failures are tried again at use. */
export function preloadParts(names) {
  const idle = (fn) => (typeof globalThis.requestIdleCallback === 'function'
    ? globalThis.requestIdleCallback(fn, { timeout: 2000 })
    : setTimeout(fn, 200));
  let i = 0;
  const next = () => {
    if (i >= names.length) return;
    const name = names[i++];
    loadPart(name).catch(() => {}).then(() => idle(next));
  };
  idle(next);
}

/** For the tests: the parts that have loaded. */
export function loadedParts() {
  return [...ready.keys()];
}
