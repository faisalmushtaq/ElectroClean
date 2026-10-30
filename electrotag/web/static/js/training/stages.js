// The five stages of the training path, as electrotag/training/programme.py works them out: the
// sandbox's stand-in for the study (js/api/demo.js) uses it, and the training path's page uses its
// words. Pure: no page, no study. web_tests/unit/api_contract_parity.test.mjs checks that the sandbox's
// answers are the server's, word for word.

export const STAGES = ['tour', 'snippets', 'guided', 'practice', 'assessment'];
/** The stages a trainee may skip, when the study's policy allows it (never the assessment). */
export const LEARNING_STAGES = ['tour', 'snippets', 'guided', 'practice'];
/** The stages finished in the browser (POST /training/stage with done); the others by what is saved. */
export const DONE_IN_BROWSER = ['tour', 'snippets'];

export const STAGE_TITLES = {
  tour: 'Find your way around',
  snippets: 'Meet the artifacts',
  guided: 'Learn with the experts',
  practice: 'On your own',
  assessment: 'Competency assessment',
};
export const STAGE_TEXT = {
  tour: 'A short, hands-on tour on a practice recording: mark an artifact with a key and a drag, choose channels, undo, rate your confidence and save. Nothing you mark is kept.',
  snippets: 'Short examples of each type of artifact, with the experts\' notes, then a quick check that you can recognise them.',
  guided: 'Mark each artifact the way the experts did, one at a time, with help and instant feedback.',
  practice: 'Annotate a recording by yourself, then see your score and what you missed.',
  assessment: 'Annotate without feedback. Your result appears here when every recording is done.',
};
export const SKIPPED_TEXT = 'You skipped this stage. You can still do it: choose Do it after all.';
export const REOPENED_TEXT = 'Your study team has reopened your training: practise again, then take the assessment once more. Only what you save from now on counts.';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The study's policy (GET /me study.training, or the admin settings' training block). */
export function stagePolicy(training = {}) {
  const t = training || {};
  return {
    skippable: LEARNING_STAGES.filter((s) => (Array.isArray(t.skippable) ? t.skippable : LEARNING_STAGES).includes(s)),
    tour: t.tour !== false,
    snippets_quiz_required: t.snippets_quiz_required === true,
  };
}

export const maySkip = (policy, stage) => LEARNING_STAGES.includes(stage) && policy.skippable.includes(stage);

/** The progress events replayed in order (programme.py stage_marks): flags by stage, the latest reopening and carry-over. */
export function stageMarks(events = []) {
  const flags = {};
  let reopened = null;
  let carried = null;
  for (const e of events || []) {
    if (!e || typeof e !== 'object') continue;
    const { event, stage } = e;
    if (event === 'stage_skipped' && LEARNING_STAGES.includes(stage)) flags[stage] = 'skipped';
    else if (event === 'stage_completed' && DONE_IN_BROWSER.includes(stage)) flags[stage] = 'completed';
    else if (event === 'stage_resumed' && LEARNING_STAGES.includes(stage) && flags[stage] === 'skipped') delete flags[stage];
    else if (event === 'training_reopened') {
      const first = STAGES.includes(e.from) ? e.from : 'practice';
      for (const s of STAGES.slice(STAGES.indexOf(first))) delete flags[s];
      reopened = e;
    } else if (event === 'assessment_set_assigned') {
      for (const s of LEARNING_STAGES) flags[s] = 'carried';
      carried = e;
      reopened = null;
    }
  }
  return { flags, reopened, carried, skipped: LEARNING_STAGES.filter((s) => flags[s] === 'skipped') };
}

/** The snippets stage's line on the training path (programme.py snippets_detail). */
export function snippetsDetail(n, quiz, required) {
  let text = `${plural(n, 'example')} of the experts' artifacts, with their notes`;
  text += quiz ? ', then a quick recognition check.' : '.';
  if (quiz && required) text += ' To finish this stage, also finish the recognition check.';
  return text;
}

function learning(key, base, marks, beforeFinished) {
  const flag = marks.flags[key];
  if (flag === 'carried' || flag === 'completed' || base === 'completed') return 'completed';
  if (base === 'not_used') return 'not_used';
  if (flag === 'skipped') return 'skipped';
  return beforeFinished ? base : 'locked';
}

export const isUnlocked = (s) => ['available', 'in_progress', 'completed'].includes(s.status);
export const isFinished = (s) => ['completed', 'skipped', 'not_used'].includes(s.status);

/**
 * The five stages (programme.py programme_state) from what the caller knows:
 * guided {total, done, stars, max_stars, seconds}, practice {total, done, base, detail, result, seconds},
 * assessment {total, done, result, detail} (lists of recording IDs; base is available, in_progress or completed),
 * the progress events, the policy, the number of snippets and whether the set has a quiz.
 */
export function stageStates({ events = [], policy = stagePolicy(), nSnippets = 0, quiz = false, guided, practice, assessment }) {
  const marks = stageMarks(events);
  const out = [];
  const before = () => out.every(isFinished);
  const add = (s) => {
    const st = { done: 0, total: 0, stars: 0, max_stars: 0, seconds: 0, detail: '', result: '', ...s,
      title: STAGE_TITLES[s.key], description: STAGE_TEXT[s.key] };
    st.carried = marks.flags[st.key] === 'carried';
    if (st.status === 'skipped') st.detail = SKIPPED_TEXT;
    else if (st.carried && marks.carried) st.detail = `Done in ${marks.carried.from_set_name || marks.carried.from_set || 'your earlier training set'}.`;
    st.can_skip = maySkip(policy, st.key) && ['available', 'in_progress'].includes(st.status);
    st.can_resume = st.status === 'skipped';
    out.push(st);
  };
  add({ key: 'tour', status: learning('tour', policy.tour ? 'available' : 'not_used', marks, before()) });
  add({ key: 'snippets', status: learning('snippets', nSnippets ? 'available' : 'not_used', marks, before()),
    detail: nSnippets ? snippetsDetail(nSnippets, quiz, policy.snippets_quiz_required) : '' });
  const g = guided;
  const gBase = !g.total.length ? 'not_used' : g.done.length === g.total.length ? 'completed' : g.done.length ? 'in_progress' : 'available';
  add({ key: 'guided', status: learning('guided', gBase, marks, before()), done: g.done.length, total: g.total.length,
    stars: g.stars || 0, max_stars: g.max_stars || 0, seconds: g.seconds || 0, done_ids: g.done });
  const p = practice;
  add({ key: 'practice', status: learning('practice', p.total.length ? p.base : 'not_used', marks, before()), done: p.done.length,
    total: p.total.length, seconds: p.seconds || 0, detail: p.detail || '', result: p.result || '', done_ids: p.done, best: p.best || null });
  const a = assessment;
  let aStatus;
  if (!a.total.length) aStatus = 'not_used';
  else if (a.done.length === a.total.length) aStatus = 'completed';
  else if (!before()) aStatus = 'locked';
  else aStatus = a.done.length ? 'in_progress' : 'available';
  add({ key: 'assessment', status: aStatus, done: a.done.length, total: a.total.length,
    detail: aStatus === 'completed' ? a.detail || '' : (a.total.length && marks.reopened ? REOPENED_TEXT : ''),
    result: aStatus === 'completed' ? a.result || '' : '', done_ids: a.done });
  return out;
}

/** The first open stage, when it is the tour or the snippets (programme.py next_step); null otherwise. */
export function browserStep(states) {
  const open = (k) => states.find((s) => s.key === k && isUnlocked(s) && !isFinished(s));
  if (open('tour')) return { stage: 'tour', recording_id: null, repeat: false, label: 'Start the tour',
    text: `Next: ${STAGE_TITLES.tour}, a short tour of ElectroTag on a practice recording.` };
  if (open('snippets')) return { stage: 'snippets', recording_id: null, repeat: false, label: 'See the artifacts',
    text: `Next: ${STAGE_TITLES.snippets}, short examples of each type with the experts' notes.` };
  return null;
}
