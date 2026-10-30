// The admin area without the page: its sections, the words it uses, and the checks and
// conversions behind its forms. Nothing here touches the DOM, so the unit tests import it in Node
// and the demonstration (js/api/demo_admin.js) checks settings with the same rules.

// ------------------------------------------------------------------ sections
/** The groups of the admin area's menu, each with its own sections (in the order shown). */
export const GROUPS = Object.freeze([
  { key: 'study', title: 'Study' },
  { key: 'people', title: 'People' },
  { key: 'data', title: 'Data' },
  { key: 'config', title: 'Settings' },
]);

export const SECTIONS = Object.freeze([
  { key: 'overview', route: 'admin', title: 'Overview', group: 'study' },
  { key: 'progress', route: 'admin-progress', title: 'Progress', group: 'study' },
  { key: 'results', route: 'admin-results', title: 'Results', group: 'study' },
  { key: 'analyses', route: 'admin-analyses', title: 'Analyses', group: 'study' },
  { key: 'records', route: 'admin-records', title: 'Records', group: 'study' },
  { key: 'annotators', route: 'admin-annotators', title: 'Annotators', group: 'people' },
  { key: 'groups', route: 'admin-groups', title: 'Groups', group: 'people' },
  { key: 'assignments', route: 'admin-assignments', title: 'Assignments', group: 'people' },
  { key: 'handouts', route: 'admin-handouts', title: 'Hand-outs', group: 'people' },
  { key: 'tasks', route: 'admin-tasks', title: 'Tasks', group: 'people' },
  { key: 'training', route: 'admin-training', title: 'Training', group: 'people' },
  { key: 'questionnaire', route: 'admin-questionnaire', title: 'Questionnaire', group: 'people' },
  { key: 'datasets', route: 'admin-datasets', title: 'Datasets', group: 'data' },
  { key: 'recordings', route: 'admin-recordings', title: 'Recordings', group: 'data' },
  { key: 'problems', route: 'admin-problems', title: 'Problems', group: 'data' },
  { key: 'settings', route: 'admin-settings', title: 'Study settings', group: 'config' },
]);

/** Links of the admin menu to the expert area, which administrators may use too: {group, route, title}. */
export const EXPERT_LINKS = Object.freeze([
  { group: 'study', route: 'expert-queue', title: 'Adjudication' },
]);

export function sectionsOf(group) {
  return SECTIONS.filter((s) => s.group === group);
}

export function groupOf(sectionKey) {
  const s = SECTIONS.find((x) => x.key === sectionKey);
  return s ? s.group : null;
}

/** Which groups of the menu are folded away, read from what the browser kept ({study: true, ...}). */
export function foldedGroups(saved) {
  const out = {};
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const g of GROUPS) if (saved[g.key] === true) out[g.key] = true;
  }
  return out;
}

/** True for the plain hashes of the admin area (#admin, #admin-recordings, ...). */
export function isAdminRoute(route) {
  return SECTIONS.some((s) => s.route === route);
}

export function sectionForRoute(route) {
  const s = SECTIONS.find((x) => x.route === route);
  return s ? s.key : null;
}

export function routeForSection(key) {
  const s = SECTIONS.find((x) => x.key === key);
  return s ? s.route : 'admin';
}

// --------------------------------------------------------------------- words
export const MODES = Object.freeze({ standard: 'Annotation', guided: 'Guided training', practice: 'Practice', assessment: 'Assessment' });
export const STATUS = Object.freeze({ todo: 'To do', in_progress: 'In progress', done: 'Done', unusable: 'Cannot be annotated',
  locked: 'Locked until the assessment is passed' });
export const USES = Object.freeze({
  guided: 'Guided: learn with the experts',
  practice: 'Practice: on their own, with feedback',
  assessment: 'Assessment: blinded',
});
export const USE_SHORT = Object.freeze({ guided: 'Guided', practice: 'Practice', assessment: 'Assessment' });
export const GUIDANCE = Object.freeze({
  auto: 'By its place in the set',
  show: 'Show each artifact',
  find: 'Name each artifact, trainee finds it',
  find_unnamed: 'Only say an artifact follows',
  correct: 'Correct the marks (an exercise made first)',
});
export const SELECTION = Object.freeze({
  random: 'Random order',
  seeded: 'Reproducible order (with a seed)',
  manual: 'Assignment order',
});
/** The roles a person can be given (electrotag/web/store.py ROLES); one person may hold several. */
export const ROLES = Object.freeze({ annotator: 'Annotator', expert: 'Expert', admin: 'Administrator' });
/** The order of precedence: a person's primary role (the older single role) is the first they hold. */
export const ROLE_ORDER = Object.freeze(['admin', 'expert', 'annotator', 'participant']);
const KNOWN_ROLES = new Set(ROLE_ORDER);

/** A person's roles in ROLE_ORDER, from a list, a comma-separated text or the older single role (as parse_roles). */
export function parseRoles(value, fallback = 'annotator') {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',').map((x) => x.trim()) : [];
  const out = ROLE_ORDER.filter((r) => items.includes(r) && KNOWN_ROLES.has(r));
  return out.length ? out : fallback ? [fallback] : [];
}

/** The first of the roles in ROLE_ORDER ("annotator" when there is none), as primary_role. */
export function primaryRole(roles) {
  return ROLE_ORDER.find((r) => (roles || []).includes(r)) || 'annotator';
}

/** The roles of an account record: its `roles`, or the older single `role`. */
export function rolesOf(u) {
  return parseRoles(u && Array.isArray(u.roles) && u.roles.length ? u.roles : u && u.role);
}

/** "an annotator and expert", "an administrator": the roles as the audit log's summaries say them (roles_text). */
export function rolesText(roles) {
  const words = { annotator: 'annotator', expert: 'expert', admin: 'administrator', participant: 'participant' };
  const names = ['annotator', 'expert', 'admin', 'participant'].filter((r) => (roles || []).includes(r)).map((r) => words[r]);
  const list = names.length ? names : ['annotator'];
  const joined = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `${/^[aeiou]/.test(joined) ? 'an' : 'a'} ${joined}`;
}

/** The roles as words for a page: "Annotator, Expert". */
export function roleWords(roles) {
  return ['admin', 'expert', 'annotator'].filter((r) => (roles || []).includes(r)).map((r) => ROLES[r]).join(', ') || ROLES.annotator;
}
export const METHOD_NAMES = Object.freeze({
  single_expert: "one expert's annotations",
  annotator: "one person's saved annotations",
  document: 'an annotation file',
  consensus: 'consensus of several experts',
  adjudicated: 'adjudicated consensus',
  simulation: 'the simulation that made the recording',
});
/** MNE-Python's channel types that the study's channel-type patterns may give (electrotag.config.settings). */
export const CHANNEL_TYPES = Object.freeze(['eeg', 'eog', 'ecg', 'emg', 'misc', 'stim', 'resp', 'bio', 'gsr', 'temperature']);
export const SCALING_TYPES = Object.freeze(['eeg', 'eog', 'ecg', 'emg', 'misc']);
/** The study's starting choice of channel colours (display.channel_colours; js/viewer/channel_colours.js). */
export const CHANNEL_COLOUR_CHOICES = Object.freeze([['off', 'None: every trace in ink'], ['region', 'By region of the head'], ['side', 'By side of the head'], ['type', 'By channel type']]);

function settingValueText(v) {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Object.keys(v).length)) return 'nothing';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k} ${x}`).join(', ');
  return String(v);
}

/** A setting's change in words for the audit log (electrotag/web/admin.py setting_change_text). */
export function settingChangeText(key, old, value) {
  const [block, ...rest] = String(key).split('.');
  return `${rest.join('.').replace(/_/g, ' ')} (${block}) from ${settingValueText(old)} to ${settingValueText(value)}`;
}

/** The competency measures of electrotag.training.assessment.METRICS, in the same order. */
export const METRICS = Object.freeze({
  event_f1: {
    label: 'Event F1 (time only)', better: 'higher', range: [0, 1],
    description: 'Combines sensitivity and precision (their harmonic mean): 1 means every reference artifact was found and nothing extra was marked; 0 means no artifact was found.',
  },
  event_recall: {
    label: 'Sensitivity: proportion of reference events found', better: 'higher', range: [0, 1],
    description: "The proportion of the reference's artifacts that the annotator found.",
  },
  event_precision: {
    label: 'Precision: proportion of your events that match the reference', better: 'higher', range: [0, 1],
    description: "The proportion of the annotator's annotations that match an artifact in the reference.",
  },
  time_kappa: {
    label: "Cohen's kappa over time (exact)", better: 'higher', range: [-1, 1],
    description: 'Agreement, moment by moment, on whether an artifact is present, corrected for the agreement expected by chance: 1 is perfect agreement, 0 is no better than chance.',
  },
  time_positive_agreement: {
    label: 'Positive agreement over time (exact)', better: 'higher', range: [0, 1],
    description: 'Agreement on the time marked as artifact: twice the time both marked, divided by the time each marked. Clean time that both left unmarked does not count.',
  },
  channel_positive_agreement: {
    label: 'Positive agreement over time and channels', better: 'higher', range: [0, 1],
    description: 'Positive agreement counted separately for every channel, so choosing the wrong channels lowers it.',
  },
  mean_iou: {
    label: 'Mean temporal overlap (IoU) of matched events', better: 'higher', range: [0, 1],
    description: 'For artifacts that were found: the time both marked divided by the time either marked (intersection over union), averaged. 1 means identical start and end.',
  },
  mean_channel_jaccard: {
    label: 'Mean channel overlap (Jaccard) of matched events', better: 'higher', range: [0, 1],
    description: 'For artifacts that were found: the channels both chose divided by the channels either chose, averaged (a whole-montage annotation counts as every channel).',
  },
  label_accuracy: {
    label: 'Same label as the reference for detected artifacts', better: 'higher', range: [0, 1], overallOnly: true,
    description: 'The proportion of found artifacts that were given the same artifact type as in the reference.',
  },
  false_positives_per_min: {
    label: 'Extra events (matching no reference artifact) per minute', better: 'lower', range: [0, 1000], overallOnly: true,
    description: "Annotations that match no reference artifact of any type, per minute of recording (lower is better). An artifact found with a different type counts under 'Same label' instead.",
  },
});

// ------------------------------------------------------------------ formatting
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "45 s", "4 min 10 s", "1 h 05 min". */
export function durationText(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
}

/** "today at 10:15", "28 Oct 2026, 10:15"; "never" for nothing. */
export function whenText(iso, { now = new Date(), never = 'never' } = {}) {
  if (!iso) return never;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `today at ${time}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${time}`;
}

export function bytesText(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} bytes`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} kB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(v < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(v / 1024 ** 3).toFixed(1)} GB`;
}

export function percent(v, digits = 0) {
  return v === null || v === undefined || Number.isNaN(Number(v)) ? '–' : `${(Number(v) * 100).toFixed(digits)}%`;
}

/** 'The study' or 'Reference set: Pilot set'. */
export function scopeText(scope, sets = []) {
  if (!scope || scope === 'study') return 'The study';
  const id = String(scope).replace(/^set:/, '');
  const s = (sets || []).find((x) => x.set_id === id);
  return `Reference set: ${s ? s.name || s.set_id : id}`;
}

/** 'sub-001/eeg/sub-001_eeg.edf' -> {name: 'sub-001_eeg.edf', folder: 'sub-001/eeg'}. */
export function fileParts(rid) {
  const parts = String(rid || '').split('/');
  return { name: parts.pop(), folder: parts.join('/') };
}

/** One phrase for where a reference came from (electrotag.training.assessment.describe_provenance). */
export function describeProvenance(prov) {
  const p = prov || {};
  let text = METHOD_NAMES[p.method] || p.method || 'method not recorded';
  const experts = (p.experts || []).join(', ');
  if (experts) text += `: ${experts}`;
  if (p.min_agreement) text += ` (${p.min_agreement} needed to agree)`;
  if (p.adjudicator) text += `; adjudicated by ${p.adjudicator}`;
  return text;
}

// --------------------------------------------------------------------- errors
/** True when the study answered that it does not have this operation (an older server or functions). */
export function isNotOffered(exc) {
  if (!exc) return false;
  if (exc.code === 'not-found' || exc.code === 'unimplemented') return true;
  // The service's "Unknown operation …", or a server without the route ("There is no /api/v1/admin/…").
  if (exc.status === 404 && (!exc.code || /^Unknown operation|There is no \/api\/v1\//i.test(exc.message || ''))) return true;
  return exc.status === 501 && exc.code !== 'needs_server';
}

/** The words to show for a failed operation: the study's own message, or a plain explanation. */
export function problemText(exc) {
  if (!exc) return 'Something went wrong. Please try again.';
  if (isNotOffered(exc)) {
    return 'This study does not offer this part of the admin area yet. Its server or functions may need updating to the current version of ElectroTag.';
  }
  return exc.message || 'Something went wrong. Please try again.';
}

// ------------------------------------------------------------- numbers and ids
/** Numbers separated by spaces or commas, with a plain-words error (the agreement analysis's time bins and thresholds). */
export function parseNumbers(text, what, example) {
  const parts = String(text || '').replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  if (!parts.length) throw new Error(`${what}: give at least one number, for example ${example}.`);
  return parts.map((part) => {
    const v = Number(part);
    if (!Number.isFinite(v)) throw new Error(`${what}: '${part}' is not a number. Give numbers separated by spaces, for example ${example}.`);
    return v;
  });
}

/** A number from a form field, within limits, or an error that names the field. */
export function parseNumber(text, what, { min = -Infinity, max = Infinity, integer = false, optional = false } = {}) {
  const t = String(text ?? '').trim();
  if (!t) {
    if (optional) return null;
    throw new Error(`${what}: enter a number.`);
  }
  const v = Number(t);
  if (!Number.isFinite(v)) throw new Error(`${what}: '${t}' is not a number.`);
  if (integer && !Number.isInteger(v)) throw new Error(`${what}: enter a whole number.`);
  if (v < min || v > max) {
    const range = max === Infinity ? `at least ${min}` : min === -Infinity ? `at most ${max}` : `between ${min} and ${max}`;
    throw new Error(`${what}: enter a number ${range}.`);
  }
  return v;
}

/** Words separated by commas, spaces, semicolons or new lines. */
export function parseList(text) {
  return String(text || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const SET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function checkAnnotatorId(text) {
  const id = String(text || '').trim().toUpperCase();
  if (!id) throw new Error('Enter an annotator ID, for example A03.');
  if (!ID_RE.test(id)) throw new Error('An annotator ID has up to 32 letters, digits, hyphens or underscores, and starts with a letter or digit.');
  return id;
}

export function checkSetId(text) {
  const id = String(text || '').trim();
  if (!id) throw new Error('Enter an identifier for the set, for example pilot.');
  if (!SET_ID_RE.test(id)) throw new Error('A set identifier has up to 64 letters, digits, dots, hyphens or underscores, and starts with a letter or digit.');
  return id;
}

export function checkEmail(text, { required = false } = {}) {
  const e = String(text || '').trim();
  if (!e) {
    if (required) throw new Error('Enter the person\'s email address: they sign in with it.');
    return null;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error(`${e} does not look like an email address.`);
  return e;
}

// ----------------------------------------------------------------- settings
export function deepCopy(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** The blocks of the study settings with the changes merged in, key by key. */
export function mergeSettings(current, changes) {
  const out = deepCopy(current || {});
  for (const [block, values] of Object.entries(changes || {})) {
    if (values && typeof values === 'object' && !Array.isArray(values)) out[block] = { ...(out[block] || {}), ...deepCopy(values) };
    else out[block] = deepCopy(values);
  }
  return out;
}

/**
 * Problems with study settings, in plain words (the rules of electrotag.config.settings, which the
 * study checks again). `labels` are the catalogue's label names, to check the quick labels.
 */
export function settingsProblems(s, labels = null) {
  const out = [];
  const f = s.filters || {};
  if (f.highpass_enabled && !(Number(f.highpass_hz) > 0)) out.push('The high-pass filter needs a positive frequency.');
  if (f.highpass_enabled && Number(f.highpass_hz) >= 40) out.push('A high-pass filter at 40 Hz or more would remove most of the EEG; choose a lower frequency.');
  if (f.notch_enabled && ![50, 60].includes(Number(f.notch_hz))) out.push('The notch filter is at 50 or 60 Hz (the mains frequency).');
  const d = s.display || {};
  if ('duration_s' in d && !(Number(d.duration_s) > 0 && Number(d.duration_s) <= 600)) out.push('The screen shows between 1 and 600 seconds.');
  if ('n_channels' in d && !(Number.isInteger(Number(d.n_channels)) && Number(d.n_channels) >= 1)) out.push('The screen shows at least one channel.');
  if ('channel_colours' in d && !CHANNEL_COLOUR_CHOICES.some(([v]) => v === d.channel_colours)) out.push('Channel colours are none, by region, by side or by type.');
  for (const [type, v] of Object.entries(d.scalings || {})) {
    if (!(Number(v) > 0)) out.push(`The display scale for ${type.toUpperCase()} must be a positive number.`);
  }
  const c = s.channels || {};
  if (c.hide && (!Array.isArray(c.hide) || c.hide.some((p) => !String(p).trim()))) out.push('The channels to hide are names or patterns, one per line, none of them empty.');
  if (c.types && typeof c.types === 'object') {
    for (const [pattern, type] of Object.entries(c.types)) {
      if (!pattern.trim()) out.push('A channel-type pattern is empty.');
      if (!CHANNEL_TYPES.includes(String(type).toLowerCase())) out.push(`${pattern} is given the type ${type}; choose one of ${CHANNEL_TYPES.join(', ')}.`);
    }
  }
  const sel = s.selection || {};
  if (sel.strategy && !Object.keys(SELECTION).includes(sel.strategy)) out.push('Choose how the next recording is selected.');
  if (sel.strategy === 'seeded' && !Number.isInteger(sel.seed)) out.push('A reproducible order needs a seed: a whole number.');
  const lg = s.logging || {};
  if ('pointer_hz' in lg && !(Number(lg.pointer_hz) >= 0 && Number(lg.pointer_hz) <= 60)) out.push('Pointer samples per second are between 0 (none) and 60.');
  if ('idle_after_s' in lg && !(Number(lg.idle_after_s) >= 5 && Number(lg.idle_after_s) <= 3600)) out.push('An annotator counts as idle after between 5 and 3600 seconds.');
  const a = s.annotation || {};
  if ('min_duration_samples' in a && !(Number.isInteger(Number(a.min_duration_samples)) && Number(a.min_duration_samples) >= 1)) {
    out.push('The shortest annotation is at least one sample.');
  }
  const minutes = (k, hi) => k in a && !(typeof a[k] === 'number' && a[k] >= 0 && a[k] <= hi);
  if (minutes('break_reminder_minutes', 240)) out.push('A break reminder comes after between 0 (no reminders) and 240 minutes of work.');
  if (minutes('idle_pause_minutes', 60)) out.push('The clock pauses itself after between 0 (never) and 60 minutes without input.');
  if ('coverage_check' in a && !['warn', 'off'].includes(a.coverage_check)) out.push('The check of the parts not yet viewed is either on (warn) or off.');
  if ('confidence' in a && !['optional', 'every_mark', 'off', 'on'].includes(a.confidence)) out.push('Confidence is either optional or asked for every mark.');
  const q = a.quick_labels || [];
  if (q.length > 9) out.push('At most nine artifact types fit on the keys 1 to 9.');
  if (new Set(q).size !== q.length) out.push('An artifact type is on two number keys; give each key a different type.');
  if (labels) for (const l of q) if (!labels.includes(l)) out.push(`${l} is not one of the artifact types.`);
  if ('allow_revisions' in a && typeof a.allow_revisions !== 'boolean') out.push('Whether finished recordings may be revised is on or off.');
  if ('allow_reviews' in a && typeof a.allow_reviews !== 'boolean') out.push('Whether saved recordings may be reviewed is on or off.');
  if ('show_reviews_to_annotators' in a && typeof a.show_reviews_to_annotators !== 'boolean') out.push('Whether annotators see the reviews of their work is on or off.');
  const g = s.gamification || {};
  for (const k of ['enabled', 'leaderboard', 'leaderboard_viewed_only']) {
    if (k in g && typeof g[k] !== 'boolean') out.push(`gamification.${k} is on or off (true or false).`);
  }
  return out;
}

/** Volts (as stored) to microvolts (as shown), and back. */
export const toMicrovolts = (v) => Math.round(Number(v) * 1e6 * 1000) / 1000;
export const fromMicrovolts = (uv) => Number(uv) / 1e6;

// ------------------------------------------------------------------ analyses
/** The defaults of electrotag.reliability.config.AnalysisConfig. */
export function defaultAnalysisConfig() {
  return {
    resolutions_s: [0.01, 0.05, 0.1],
    min_bin_coverage: 0.5,
    channel_modes: ['time_only', 'time_and_channel'],
    include_any_artifact: true,
    include_group_rollups: true,
    match_criterion: 'iou',
    iou_thresholds: [0.0, 0.2, 0.5],
    primary_iou_threshold: 0.2,
    onset_tolerance_s: 0.5,
    offset_tolerance_s: 0.5,
    allow_many_to_one: false,
    min_channel_jaccard: 0.0,
    categories: null,
    reference_annotator: null,
    duplicate_policy: 'latest',
    channel_exclude: [],
    timeline_max_recordings: 12,
    min_events_per_category: 5,
  };
}

/** The agreement answer's summary as a few rows of plain words ([label, text]); the key results are in the report. */
export function agreementSummaryRows(summary) {
  const s = summary || {};
  const rows = [];
  if (s.n_recordings !== undefined && s.n_recordings !== null) rows.push(['Recordings analysed', String(s.n_recordings)]);
  if (s.n_comparable_recordings !== undefined && s.n_comparable_recordings !== null) rows.push(['Recordings with two or more annotators to compare', String(s.n_comparable_recordings)]);
  if (Array.isArray(s.annotators)) rows.push(['Annotators', s.annotators.join(', ') || '–']);
  const u = s.unusable || {};
  if (u.recordings_left_out) rows.push(['Left out (set aside as ones that cannot be annotated)', `${u.recordings_left_out}: ${(u.recording_ids || []).map((r) => String(r).split('/').pop()).join(', ')}`]);
  return rows;
}

/** The command that repeats the admin area's agreement analysis on the results zip's folder. */
export const AGREEMENT_COMMAND = 'electrotag-agreement Annotated_Events --config agreement_settings.json';

/**
 * The Settings used (JSON) of an agreement report, in the form electrotag-agreement --config reads:
 * the settings under "config", the recordings chosen and those left out because they were set aside.
 * The study sends it (settings_file); an older study's answer is completed from the request.
 */
export function agreementSettingsFile(answer, request = {}) {
  const r = answer || {};
  if (r.settings_file && r.settings_file.config) return { command: AGREEMENT_COMMAND, ...r.settings_file };
  const s = r.summary || {};
  const config = { ...(s.config || request.config || {}) };
  if (!s.config) {
    config.annotators = request.annotator_ids || null;
    config.modes = request.modes || ['standard'];
  }
  return { config, recording_ids: request.recording_ids || null, exclude_recording_ids: (s.unusable && s.unusable.recording_ids) || [], command: AGREEMENT_COMMAND };
}

/** A reference set as a choice shows it: "Pilot set · pilot", or the identifier alone. */
export function setLabel(s) {
  const name = String((s && s.name) || '').trim();
  return name && name !== s.set_id ? `${name} · ${s.set_id}` : String((s && s.set_id) || '');
}

export const MATCH_CRITERIA = Object.freeze({
  iou: 'Overlap (IoU)',
  tolerance: 'Onset and offset tolerance',
  iou_and_tolerance: 'Overlap and tolerance',
});

/** Problems with an analysis configuration, in plain words (AnalysisConfig.validate). */
export function analysisProblems(c) {
  const out = [];
  const r = c.resolutions_s || [];
  if (!r.length || r.some((x) => !(x > 0))) out.push('Time bins: give positive numbers of seconds.');
  if (new Set(r).size !== r.length) out.push('Time bins: give each width only once.');
  if (!(c.min_bin_coverage >= 0 && c.min_bin_coverage <= 1)) out.push('Bin coverage needed is between 0 and 1.');
  if (!(c.channel_modes || []).length) out.push('Compare by time, by time and channel, or both.');
  if (!Object.keys(MATCH_CRITERIA).includes(c.match_criterion)) out.push('Choose how events are matched.');
  if ((c.iou_thresholds || []).some((t) => !(t >= 0 && t < 1))) out.push('Overlap thresholds are from 0 up to (not including) 1.');
  if (!(c.primary_iou_threshold >= 0 && c.primary_iou_threshold < 1)) out.push('The main overlap threshold is from 0 up to (not including) 1.');
  if (!(c.min_channel_jaccard >= 0 && c.min_channel_jaccard <= 1)) out.push('Channel overlap needed is between 0 and 1.');
  if (c.onset_tolerance_s < 0 || c.offset_tolerance_s < 0) out.push('Tolerances cannot be negative.');
  if (!(c.min_events_per_category >= 0)) out.push('The fewest annotations for figures cannot be negative.');
  if (!(c.timeline_max_recordings >= 0)) out.push('The number of recordings drawn as timelines cannot be negative.');
  if (!['latest', 'error'].includes(c.duplicate_policy)) out.push('Choose what happens when someone saved a recording twice.');
  if (c.categories && !c.categories.length) out.push('Choose at least one artifact category, or all of them.');
  return out;
}

// ------------------------------------------------------------------ criteria
/** One row per competency measure, from a reference set's criteria (CompetencyCriteria.to_dict()). */
export function criteriaRows(criteria) {
  const chosen = new Map(((criteria && criteria.criteria) || []).map((c) => [c.metric, c]));
  return Object.entries(METRICS).map(([metric, meta]) => {
    const c = chosen.get(metric);
    return { metric, enabled: Boolean(c), threshold: c ? Number(c.threshold) : meta.better === 'higher' ? 0.7 : 1.0, scope: c ? c.scope || 'overall' : 'overall' };
  });
}

/** CompetencyCriteria.to_dict() from the editor's rows, or an error in plain words. */
export function criteriaFromRows(rows, minReferenceEvents, categories = null) {
  const out = [];
  for (const r of rows) {
    if (!r.enabled) continue;
    const meta = METRICS[r.metric];
    if (!meta) throw new Error(`${r.metric} is not a competency measure.`);
    const t = Number(r.threshold);
    if (!Number.isFinite(t) || t < meta.range[0] || t > meta.range[1]) {
      throw new Error(`${meta.label}: the threshold is between ${meta.range[0]} and ${meta.range[1]}.`);
    }
    const scope = r.scope === 'each_category' && !meta.overallOnly ? 'each_category' : 'overall';
    out.push({ metric: r.metric, threshold: t, scope });
  }
  const n = Number(minReferenceEvents);
  if (!Number.isInteger(n) || n < 1) throw new Error('A category is assessed when the reference has at least one event of it: enter a whole number of 1 or more.');
  return { criteria: out, min_reference_events: n, categories: categories && categories.length ? [...categories] : null };
}

/** Disagreements of a consensus shorter than this (seconds) are boundary differences, listed apart. */
export const SLIVER_S = 0.1;

/** A consensus's disagreements: those worth adjudicating, and the slivers where boundaries differ a little. */
export function splitSlivers(rows, minS = SLIVER_S) {
  const main = [];
  const slivers = [];
  for (const d of rows || []) ((Number(d.offset_s) - Number(d.onset_s)) < minS ? slivers : main).push(d);
  return { main, slivers };
}

/** "Event F1 (time only) ≥ 0.8 (overall)". */
export function describeCriterion(c) {
  const meta = METRICS[c.metric] || { label: c.metric, better: 'higher' };
  return `${meta.label} ${meta.better === 'lower' ? '≤' : '≥'} ${c.threshold} (${c.scope === 'each_category' ? 'in every assessed category' : 'overall'})`;
}

// ------------------------------------------------------------- registration
/** What the review table shows of an internal manifest (electrotag/web/manifest.py). */
export function manifestSummary(m) {
  const t = m.timing || {};
  const sfreq = Number(t.sfreq ?? m.sfreq);
  const n = Number(t.n_samples ?? m.n_samples);
  const fp = (m.fingerprint && (m.fingerprint.eeg || m.fingerprint)) || {};
  const warnings = [...new Set([...(m.warnings || []), ...((m.amplitude && m.amplitude.warnings) || [])].map(String))];
  return {
    recordingId: m.recording_id, fileName: m.file_name || String(m.recording_id || '').split('/').pop(),
    format: m.format_name || m.format || '', nChannels: (m.ch_names || []).length, nHidden: (m.hidden_channels || []).length,
    sfreq, durationS: sfreq > 0 ? n / sfreq : 0, warnings, notes: (m.notes || []).map(String),
    sha256: fp.sha256 || fp.hex || '', sizeBytes: Number(fp.size ?? fp.size_bytes ?? 0),
  };
}

/** A recording format as people write it: EDF, BDF, BrainVision. */
export function formatName(format) {
  const f = String(format || '').toLowerCase();
  return { edf: 'EDF', bdf: 'BDF', brainvision: 'BrainVision', vhdr: 'BrainVision', rec: 'EDF' }[f] || String(format || '');
}

/** Why a file could not be read, without its name again (the list names it already). */
export function failureText(path, reason) {
  const name = String(path || '').split('/').pop();
  let t = String(reason || 'not readable');
  if (name) {
    t = t.split(`${name}: `).join('');
    if (t.startsWith(`${name} is `)) t = `It is ${t.slice(name.length + 4)}`;
  }
  return t;
}

/**
 * Recordings found that are byte-identical to another (the same fingerprint and size) under another
 * ID: a registered recording of the same place, or one found earlier in the same batch. Gives a Map
 * of recording ID -> the ID of the recording it copies.
 */
export function duplicatesOf(manifests, registered = []) {
  const key = (sha, size) => `${String(sha || '').toLowerCase()}|${Number(size) || 0}`;
  const known = new Map();
  for (const r of registered) if (r.sha256) known.set(key(r.sha256, r.size_bytes), r.recording_id);
  const out = new Map();
  for (const m of manifests) {
    const sm = manifestSummary(m);
    if (!sm.sha256) continue;
    const k = key(sm.sha256, sm.sizeBytes);
    const other = known.get(k);
    if (other && other !== sm.recordingId) out.set(sm.recordingId, other);
    else if (!other) known.set(k, sm.recordingId);
  }
  return out;
}

/** Manifests in groups small enough for one request each (the study refuses very large requests). */
export function chunkManifests(manifests, { maxBytes = 3_000_000, maxCount = 40 } = {}) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const m of manifests) {
    const n = JSON.stringify(m).length;
    if (cur.length && (cur.length >= maxCount || size + n > maxBytes)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(m);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function mergeRegisterResults(results) {
  const out = { added: [], replaced: [], skipped: [] };
  for (const r of results) {
    out.added.push(...(r.added || []));
    out.replaced.push(...(r.replaced || []));
    out.skipped.push(...(r.skipped || []));
  }
  return out;
}

/** The text of an onProgress report of the recording builder, whatever it says. */
export function progressText(p) {
  if (p === null || p === undefined) return { text: 'Reading the recordings…', fraction: null };
  if (typeof p === 'number') return { text: 'Reading the recordings…', fraction: Math.max(0, Math.min(1, p)) };
  const done = p.done ?? p.index ?? p.current;
  const total = p.total ?? p.count;
  const name = p.recordingId || p.recording_id || p.path || p.file || p.name || '';
  let fraction = typeof p.fraction === 'number' ? p.fraction : null;
  if (fraction === null && Number.isFinite(done) && Number.isFinite(total) && total > 0) fraction = done / total;
  const stage = p.stage === 'fingerprint' || p.stage === 'hash' ? 'Checking' : 'Reading';
  const count = Number.isFinite(done) && Number.isFinite(total) ? ` ${Math.min(done + (p.stage === 'done' ? 0 : 1), total)} of ${total}` : '';
  return { text: p.message || `${stage}${count}${name ? `: ${name}` : '…'}`, fraction: fraction === null ? null : Math.max(0, Math.min(1, fraction)) };
}

/** The question before Unassign, saying what happens to work already started. */
export function unassignQuestion(item, aid) {
  const name = String(item.recording_id || '').split('/').pop();
  if (item.status === 'in_progress') {
    return `Take ${name} away from ${aid}? They have started it: their unsaved work stays with the study and comes back if the recording is assigned to them again.`;
  }
  return `Take ${name} away from ${aid}?`;
}

// ---------------------------------------------------------------- records
export function filterAudit(entries, { by = '', op = '' } = {}) {
  return (entries || []).filter((e) => (!by || String(e.by).toUpperCase() === by.toUpperCase()) && (!op || e.op === op));
}

/** Counts of one annotator's work items in the progress answer. */
export function progressCounts(items) {
  const c = { assigned: 0, done: 0, in_progress: 0, todo: 0, unusable: 0 };
  for (const i of items || []) {
    c.assigned += 1;
    const st = i.status === 'locked' ? 'todo' : i.status; // locked: to do once the trainee has passed the assessment
    if (st in c) c[st] += 1;
  }
  return c;
}

/** "Guided 2 of 2 · Practice 1 of 1 (passed)" from a training view (GET /training). */
export function programmeText(p) {
  if (!p) return '';
  if (p.error) return p.message || p.error;
  const names = { tour: 'Tour', snippets: 'Snippets', guided: 'Guided', practice: 'Practice', assessment: 'Assessment' };
  const state = { completed: ' (completed)', locked: ' (locked)', skipped: ' (skipped)' };
  return (p.stages || []).filter((s) => s.status !== 'not_used' && (s.total || s.status === 'skipped'))
    .map((s) => (s.total ? `${names[s.key] || s.key} ${s.done} of ${s.total}${state[s.status] || ''}` : `${names[s.key] || s.key} skipped`))
    .join(' · ') || 'Not started';
}

// ------------------------------------------------------------- invitations
/** What each state of an invitation is called (UserRecord.invitation.state). */
export const INVITE_STATES = Object.freeze({
  none: 'Not invited', invited: 'Invited', accepted: 'Accepted', expired: 'Expired', revoked: 'Withdrawn',
});

/** 28 Oct 2026. */
export function dateText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Invited on 28 Oct 2026, expires on 11 Nov 2026", "Accepted on …", "Not invited". */
export function invitationText(inv) {
  const i = inv || {};
  const state = i.state || 'none';
  if (state === 'invited') {
    return `Invited on ${dateText(i.invited_at)}${i.expires_at ? `, expires on ${dateText(i.expires_at)}` : ''}`;
  }
  if (state === 'accepted') return `Accepted${i.ended_at ? ` on ${dateText(i.ended_at)}` : ''}`;
  if (state === 'expired') return `Expired on ${dateText(i.expires_at)}`;
  if (state === 'revoked') return `Withdrawn${i.ended_at ? ` on ${dateText(i.ended_at)}` : ''}`;
  return 'Not invited';
}

/**
 * The private link of an invitation, made from this page's own address: the page itself with
 * ?invite=<token>, and ?server=<address> when the study server is on another site than the page
 * (a page that the study server serves itself finds it without). `forcedDemo` keeps ?demo=1.
 */
export function inviteLink(token, { pageHref, server = '', forcedDemo = false } = {}) {
  const page = new URL(pageHref);
  page.hash = '';
  page.search = '';
  const params = new URLSearchParams();
  if (server) {
    let other = true;
    try { other = new URL(server).origin !== page.origin; } catch { other = true; }
    if (other) params.set('server', server);
  }
  if (forcedDemo) params.set('demo', '1');
  params.set('invite', token);
  return `${page.href}?${params.toString()}`;
}

/** The short, friendly message of "Email the link", in UK English, for the administrator to edit. */
export function inviteMessage({ annotatorId, name = '', study = '', link, expiresAt = null, from = '' }) {
  const lines = [
    `Dear ${name || annotatorId},`,
    '',
    `You are invited to annotate EEG recordings for ${study || 'our study'}, using ElectroTag in your web browser. This private link lets you choose your own password and sign in. Please open it on the tablet (such as an iPad) or computer you will annotate on: annotating needs a larger screen than a phone has.`,
    '',
    link,
    '',
    `Your annotator ID is ${annotatorId}. The link works once${expiresAt ? ` and until ${dateText(expiresAt)}` : ''}; please keep it to yourself. We will send you the recordings separately, and they stay on your own computer while you work.`,
    '',
    'If the link does not work, reply to this message and we will send a new one.',
    '',
    'With thanks,',
    from || 'The study team',
  ];
  return lines.join('\n');
}

/** A mailto: address that opens the person's email with the subject and message filled in. */
export function mailtoHref(email, subject, body) {
  return `mailto:${encodeURIComponent(String(email || '')).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * The lines of "Add several": ID, name and email address, separated by commas, semicolons or tabs.
 * Every line is checked before anything is created: `rows` are the accounts to make and
 * `problems` the lines to correct, [{line, text}], in plain words. A first line of column names is
 * skipped.
 */
export function parseBulkPeople(text, { existing = [], emailRequired = false, max = 200 } = {}) {
  const taken = new Set(existing.map((x) => String(x).toUpperCase()));
  const rows = [];
  const problems = [];
  const ids = new Map();
  const emails = new Map();
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    const parts = raw.split(/[,;\t]/).map((p) => p.trim());
    if (rows.length + problems.length === 0 && /^(annotator[ _-]?)?id$/i.test(parts[0])) return; // column names
    if (parts.length > 3) { problems.push({ line, text: `Line ${line} has more than three parts; give the ID, the name and the email address.` }); return; }
    const [idText, name = '', emailText = ''] = parts;
    let id;
    let email;
    try { id = checkAnnotatorId(idText); } catch (exc) { problems.push({ line, text: `Line ${line}: ${exc.message}` }); return; }
    try { email = checkEmail(emailText, { required: emailRequired }); } catch (exc) { problems.push({ line, text: `Line ${line} (${id}): ${exc.message}` }); return; }
    if (taken.has(id)) { problems.push({ line, text: `Line ${line}: ${id} already has an account in this study.` }); return; }
    if (ids.has(id)) { problems.push({ line, text: `Line ${line}: ${id} is also on line ${ids.get(id)}.` }); return; }
    if (email && emails.has(email.toLowerCase())) { problems.push({ line, text: `Line ${line}: ${email} is also on line ${emails.get(email.toLowerCase())}.` }); return; }
    if (name.length > 200) { problems.push({ line, text: `Line ${line}: the name has more than 200 characters.` }); return; }
    ids.set(id, line);
    if (email) emails.set(email.toLowerCase(), line);
    rows.push({ line, annotator_id: id, display_name: name, email });
  });
  if (rows.length + problems.length > max) problems.unshift({ line: 0, text: `At most ${max} people can be added at once; split the list.` });
  if (!rows.length && !problems.length) problems.push({ line: 0, text: 'Paste one line for each person: their ID, then their name and email address, separated by commas.' });
  return { rows, problems };
}

/** Comma-separated text (RFC 4180) with a header row; text that a spreadsheet would run as a formula is kept as text. */
export function csvText(columns, rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let t = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [columns.map(cell).join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

// ------------------------------------------------------------------ progress
export function median(values) {
  const v = (values || []).filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** "12 min", "1 h 05 min", "–" for nothing: the time spent with recordings open. */
export function minutesText(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '–';
  const s = Number(seconds);
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** The projected finish of stats.totals.projection, in words. */
export function projectionText(p) {
  if (p && p.status === 'not_enough' && p.reason === 'too_early') return 'After three days of work';
  if (!p || p.status === 'not_enough') return 'Not enough work yet';
  if (p.status === 'complete') return 'Every assigned recording is done';
  return `Around ${dateText(p.date)}`;
}

/**
 * The projected finish as a tile shows it: a short figure that fits on one line (the day and month,
 * with the year only when it is not this year's) and a note that keeps the "around".
 */
export function projectionFigure(p, paceDays = 14, now = new Date()) {
  if (p && p.status === 'not_enough' && p.reason === 'too_early') return { value: projectionText(p), note: 'The first days say too little about the pace' };
  if (!p || p.status !== 'projected') return { value: projectionText(p), note: '' };
  const d = new Date(p.date);
  if (Number.isNaN(d.getTime())) return { value: projectionText(p), note: `At the pace of the last ${paceDays} days` };
  const sameYear = d.getFullYear() === now.getFullYear();
  const value = d.toLocaleDateString('en-GB', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  return { value, note: `Around then, at the pace of the last ${paceDays === 1 ? 'day' : `${paceDays} days`}` };
}

/** The number to show for a value that may be missing (one decimal for fractions). */
export function numberText(v, digits = 0) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '–';
  const n = Number(v);
  return Number.isInteger(n) ? n.toLocaleString('en-GB') : n.toFixed(digits || 1);
}

/** Rows sorted by a value (numbers, then text; missing values last), in either direction. */
export function sortRows(rows, value, direction = 'asc') {
  const sign = direction === 'desc' ? -1 : 1;
  return [...rows].map((r, i) => ({ r, i, v: value(r) })).sort((a, b) => {
    const am = a.v === null || a.v === undefined || a.v === '';
    const bm = b.v === null || b.v === undefined || b.v === '';
    if (am || bm) return am && bm ? a.i - b.i : am ? 1 : -1;
    const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v), 'en-GB', { numeric: true });
    return c ? sign * c : a.i - b.i;
  }).map((x) => x.r);
}

/** People and recordings that a quick search finds, best first: [{kind, id, text, extra, scope}]. */
export function findMatches(query, { users = [], recordings = [] } = {}, limit = 12) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const u of users) {
    const hay = `${u.annotator_id} ${u.display_name || ''} ${u.email || ''}`.toLowerCase();
    const at = hay.indexOf(q);
    if (at >= 0) out.push({ kind: 'person', id: u.annotator_id, text: `${u.annotator_id}${u.display_name ? ` · ${u.display_name}` : ''}`, extra: u.email || '', rank: u.annotator_id.toLowerCase() === q ? 0 : at === 0 ? 1 : 2 });
  }
  for (const r of recordings) {
    const hay = `${r.recording_id} ${r.file_name || ''}`.toLowerCase();
    const at = hay.indexOf(q);
    if (at >= 0) out.push({ kind: 'recording', id: r.recording_id, scope: r.scope, text: r.file_name || r.recording_id, extra: r.recording_id, rank: (r.file_name || '').toLowerCase() === q ? 0 : 3 });
  }
  return out.sort((a, b) => a.rank - b.rank || a.text.localeCompare(b.text, 'en-GB', { numeric: true })).slice(0, limit);
}

// ------------------------------------------------------------------ files
export function base64ToBytes(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Tab-separated text with a header row (values with tabs or new lines are flattened). */
export function tsvText(columns, rows) {
  const cell = (v) => (v === null || v === undefined ? 'n/a' : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(4) : String(v))
    .replace(/[\t\r\n]+/g, ' ');
  return [columns.join('\t'), ...rows.map((r) => columns.map((c) => cell(r[c])).join('\t'))].join('\n') + '\n';
}

/** The annotations of an ElectroTag _annotations.json, checked enough to say what is wrong in plain words. */
export function readAnnotationDocument(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('This file is not an ElectroTag annotation file: it cannot be read as JSON.'); }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.annotations)) {
    throw new Error('This file is not an ElectroTag annotation file (*_annotations.json): it has no list of annotations.');
  }
  if (doc.schema && doc.schema !== 'electrotag.annotations') throw new Error(`This file is a ${doc.schema} document, not ElectroTag annotations.`);
  return doc;
}
