// The checks of the study settings that the expert work brought (the review, training and replay blocks
// of electrotag.config.settings), with the words for their choices. Loaded with the Study settings
// section, and by the sandbox when its settings are changed, so the sign-in page never needs them.

import { MATCH_CRITERIA } from './model.js';
import { questionnaireProblems } from '../views/questionnaire_model.js';

/** When an adjudicator gives a reason (review.reason_required). */
export const REASON_RULES = Object.freeze({
  always: 'For every decision', edited_or_none: 'Only when they keep neither version or edit a mark', never: 'Never',
});
/** The stages of the training path a trainee may be allowed to skip (training.skippable), and the gate. */
export const SKIPPABLE_STAGES = Object.freeze({
  tour: 'Find your way around (the platform tour)', snippets: 'Meet the artifacts (snippets)',
  guided: 'Learn with the experts', practice: 'On your own (practice)',
});
export const TRAINING_GATES = Object.freeze({
  met: 'Until the competency assessment is passed', completed: 'Until the competency assessment is finished', off: 'Never: study work is open at once',
});

function isNumber(v, lo, hi) { return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi; }

/** Problems with the review block (electrotag.config.settings ReviewSettings), in plain words. */
export function reviewProblems(r) {
  const out = [];
  for (const k of ['corrections', 'show_corrections_to_annotators', 'show_outcomes_to_annotators']) {
    if (k in r && typeof r[k] !== 'boolean') out.push(`review.${k} is on or off (true or false).`);
  }
  if ('k_default' in r && !(Number.isInteger(r.k_default) && r.k_default >= 2 && r.k_default <= 6)) out.push('Each task goes to between 2 and 6 annotators.');
  if ('gold_min_items' in r && !(Number.isInteger(r.gold_min_items) && r.gold_min_items >= 1 && r.gold_min_items <= 100)) {
    out.push('A person\'s accuracy counts after between 1 and 100 known-answer items.');
  }
  if ('reason_required' in r && !(r.reason_required in REASON_RULES)) out.push('Choose when an adjudicator gives a reason.');
  const m = r.matching || {};
  if ('match_criterion' in m && !(m.match_criterion in MATCH_CRITERIA)) out.push('Choose how two marks are matched.');
  if ('iou_threshold' in m && !(isNumber(m.iou_threshold, 0, 1) && m.iou_threshold < 1)) out.push('The overlap two marks need is from 0 (any overlap) to just below 1.');
  for (const k of ['onset_tolerance_s', 'offset_tolerance_s']) {
    if (k in m && !isNumber(m[k], 0, 60)) out.push('The start and end tolerances are between 0 and 60 seconds.');
  }
  if ('channel_jaccard' in m && !isNumber(m.channel_jaccard, 0, 1)) out.push('The share of channels in common is between 0 and 1.');
  return [...new Set(out)];
}

/** Problems with the training block (electrotag.config.settings TrainingPolicy), in plain words. */
export function trainingProblems(t) {
  const out = [];
  if ('skippable' in t) {
    if (!Array.isArray(t.skippable)) out.push('The stages that may be skipped are a list.');
    else if (t.skippable.includes('assessment')) out.push('The competency assessment cannot be skipped: trainees pass it before real study work.');
    else if (t.skippable.some((x) => !(x in SKIPPABLE_STAGES))) out.push('Only the tour, the snippets, learning with the experts and practice can be skipped.');
  }
  if ('gate' in t && !(t.gate in TRAINING_GATES)) out.push('Choose what real study work waits for.');
  for (const k of ['tour', 'snippets_quiz_required']) {
    if (k in t && typeof t[k] !== 'boolean') out.push(`training.${k} is on or off (true or false).`);
  }
  return out;
}

/** Problems with the replay block, in plain words. */
export function replayProblems(rp) {
  const out = [];
  for (const k of ['enabled', 'trainees_watch_experts']) {
    if (k in rp && typeof rp[k] !== 'boolean') out.push(`replay.${k} is on or off (true or false).`);
  }
  return out;
}

/** Problems with the review, training and replay blocks of a study's settings (settingsProblems has the others). */
export function expertSettingsProblems(s) {
  return [...reviewProblems(s.review || {}), ...trainingProblems(s.training || {}), ...replayProblems(s.replay || {}),
    ...questionnaireProblems(s.questionnaire)]; // the sign-up questionnaire (questionnaire_model.js)
}
