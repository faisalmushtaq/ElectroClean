// Study settings: the parts of electrotag_study.json that a study may change (settings_get and
// settings_update): its name, the display filters and whether they are fixed, the display, the
// channels to hide and channel types by name pattern, how the next recording is chosen, the types
// on the number keys, the shortest annotation, whether finished recordings may be revised, the
// comfort of long sessions (break reminders, the pause after a while without input, the check of what
// has been viewed before Save and Finish), the game elements of the home page, corrections and the
// adjudication of disagreements with their matching rules, who may watch replays of sessions, the
// training path's policy (the stages a trainee may skip and what real study work waits for), and the
// interaction log with its notice.
//
// The answer to Save appears in the bar that stays at the foot of the window, with the field to
// correct focused; the bar says when there are unsaved changes, and leaving the section or the
// page with unsaved changes asks first.

import { h, clear } from '../ui/dom.js';
import {
  CHANNEL_COLOUR_CHOICES, CHANNEL_TYPES, MATCH_CRITERIA, SCALING_TYPES, SELECTION, deepCopy, fromMicrovolts, mergeSettings, parseNumber, settingsProblems, toMicrovolts,
} from './model.js';
import { REASON_RULES, SKIPPABLE_STAGES, TRAINING_GATES, expertSettingsProblems } from './settings_checks.js';
import { actionButton, card, checkbox, confirmInline, field, loading, messageArea, numberInput, radios, sectionHead, select, textArea, textInput } from './ui.js';

/** A number from a field, or an error that names the field and knows which control to focus. */
function numberOf(control, what, limits) {
  try {
    return parseNumber(control.value, what, limits);
  } catch (exc) {
    exc.field = control;
    throw exc;
  }
}

// Closing or reloading the page with unsaved settings asks first.
const askBeforeLeaving = (e) => { e.preventDefault(); e.returnValue = ''; };

/** Only what differs from the current settings, block by block and key by key. */
function changes(current, wanted) {
  const out = {};
  for (const [block, values] of Object.entries(wanted)) {
    for (const [key, v] of Object.entries(values)) {
      if (JSON.stringify((current[block] || {})[key]) !== JSON.stringify(v)) (out[block] = out[block] || {})[key] = v;
    }
  }
  return out;
}

export class SettingsSection {
  constructor(area) {
    this.area = area;
    this.data = null;
    this.dirty = false;
    this.msg = messageArea();
    this.form = h('div.admin-stack');
    // Any edit in the form counts as an unsaved change until Save.
    for (const type of ['input', 'change']) this.form.addEventListener(type, (e) => { if (!e.target.closest('.sticky-save')) this._setDirty(true); });
    this.el = h('section.admin-section', { 'data-section': 'settings' },
      sectionHead('Study settings', 'What every annotator of the study sees and uses. Changes apply when an annotator next opens a recording.'),
      this.msg, this.form);
  }

  /** True while the form holds changes that are not saved (AdminArea asks before leaving the section). */
  unsaved() { return this.dirty; }

  _setDirty(on) {
    this.dirty = Boolean(on);
    if (this.dirtyNote) this.dirtyNote.hidden = !this.dirty;
    if (typeof window !== 'undefined') {
      if (this.dirty) window.addEventListener('beforeunload', askBeforeLeaving);
      else window.removeEventListener('beforeunload', askBeforeLeaving);
    }
  }

  /** Ask, in the bar at the foot of the window, before leaving with unsaved changes; `go` leaves. */
  async askLeave(go) {
    if (!this.leaveHost) { go(); return; }
    if (this._asking) return; // the question is on the page already
    this._asking = true;
    let yes;
    try {
      yes = await confirmInline(this.leaveHost, { text: 'The study settings have changes that are not saved. Leave without saving them?', yes: 'Leave without saving', no: 'Stay here' });
    } finally {
      this._asking = false;
    }
    if (!yes) return;
    this._setDirty(false);
    go();
  }

  async show() {
    // Coming back to the section with unsaved changes (the question was answered with Stay) keeps them.
    if (this.dirty && this.form.childElementCount) return;
    this.msg.clear();
    clear(this.form);
    this.form.append(loading());
    try {
      this.data = await this.area.read('settings_get');
    } catch (exc) {
      clear(this.form);
      this.msg.problem(exc);
      return;
    }
    this._build();
  }

  _build() {
    clear(this.form);
    const st = deepCopy(this.data.settings || {});
    const f = st.filters || {};
    const d = st.display || {};
    const c = st.channels || {};
    const sel = st.selection || {};
    const lg = st.logging || {};
    const an = st.annotation || {};
    const ld = st.loading || {};
    const gm = st.gamification || {};
    const rv = st.review || {};
    const mt = rv.matching || {};
    const tr = st.training || {};
    const rp = st.replay || {};

    const name = textInput({ value: this.data.name || '', name: 'study_name' });
    // filters
    const hp = checkbox('High-pass filter', f.highpass_enabled !== false);
    const hpHz = numberInput({ value: f.highpass_hz ?? 1, min: 0.01, max: 39, step: 0.1 });
    hpHz.setAttribute('aria-label', 'High-pass frequency (Hz)');
    const notch = checkbox('Notch filter at the mains frequency', f.notch_enabled !== false);
    const notchHz = select([['50', '50 Hz (UK, Europe)'], ['60', '60 Hz (North America)']], String(f.notch_hz ?? 50));
    notchHz.setAttribute('aria-label', 'Mains frequency');
    const harmonics = checkbox('Also its harmonics', Boolean(f.notch_harmonics));
    const locked = checkbox('Fix these filters for every annotator (recommended for reliability studies)', Boolean(f.locked));
    // display
    const seconds = numberInput({ value: d.duration_s ?? 10, min: 1, max: 600, step: 1 });
    const colours = select(CHANNEL_COLOUR_CHOICES, d.channel_colours || 'off');
    const nch = numberInput({ value: d.n_channels ?? 32, min: 1, step: 1 });
    const scal = Object.fromEntries(SCALING_TYPES.map((t) => [t, numberInput({ value: (d.scalings || {})[t] !== undefined ? toMicrovolts(d.scalings[t]) : '', min: 0, step: 'any' })]));
    // channels
    const hide = textArea({ value: (c.hide || []).join('\n'), rows: 5, placeholder: 'One name or pattern per line, for example COUNTER or CQ_*' });
    const typesHost = h('div.pattern-rows');
    const addType = (pattern = '', type = 'misc') => {
      const p = textInput({ value: pattern, placeholder: 'for example EXG*' });
      p.setAttribute('aria-label', 'Channel name pattern');
      const t = select(CHANNEL_TYPES.map((x) => [x, x.toUpperCase()]), type);
      t.setAttribute('aria-label', 'Channel type');
      const row = h('div.row.pattern-row', {}, p, t, h('button.btn.small.quiet.destructive-text', { type: 'button', onclick: () => { row.remove(); this._setDirty(true); } }, 'Remove'));
      row.read = () => [p.value.trim(), t.value];
      typesHost.append(row);
    };
    for (const [p, t] of Object.entries(c.types || {})) addType(p, t);
    const bidsTypes = checkbox('Take channel types from the recordings\' channels.tsv files', ld.apply_channel_types_from_bids !== false);
    const bidsBad = checkbox('Show the bad channels listed in channels.tsv in grey', ld.show_bids_bad_channels !== false);
    // selection
    const strategy = select(SELECTION, sel.strategy || 'random');
    const seed = numberInput({ value: sel.seed ?? '', min: 0, step: 1 });
    const syncSeed = () => { seed.disabled = strategy.value !== 'seeded'; };
    strategy.addEventListener('change', syncSeed);
    syncSeed();
    // number keys
    const labels = this.area.labels;
    const groups = [];
    for (const l of labels) {
      let g = groups[groups.length - 1];
      if (!g || g.group !== l.section) { g = { group: l.section || 'Other', options: [] }; groups.push(g); }
      g.options.push([l.label, l.label]);
    }
    const quick = an.quick_labels || [];
    const keys = Array.from({ length: 9 }, (_, i) => {
      const s = select([['', '(no type)'], ...groups], quick[i] || '');
      s.setAttribute('aria-label', `Key ${i + 1}`);
      return s;
    });
    const shortest = numberInput({ value: an.min_duration_samples ?? 1, min: 1, step: 1 });
    const breakAfter = numberInput({ value: an.break_reminder_minutes ?? 50, min: 0, max: 240, step: 1 });
    breakAfter.name = 'break_reminder_minutes';
    const idlePause = numberInput({ value: an.idle_pause_minutes ?? 3, min: 0, max: 60, step: 1 });
    idlePause.name = 'idle_pause_minutes';
    const coverage = checkbox('Before Save and Finish, list the parts of the recording that have not been on the screen', (an.coverage_check ?? 'warn') !== 'off');
    const revisions = checkbox('Let annotators revise recordings they have finished', an.allow_revisions !== false);
    const confidence = confidenceChoice(an.confidence);
    const reviews = checkbox('Let administrators review saved recordings (Agree, Caveat or Comment on each annotation)', an.allow_reviews !== false);
    const showReviews = checkbox('Show reviews to the annotators whose work was reviewed (off: blind reviews)', an.show_reviews_to_annotators !== false);
    // game elements
    const games = checkbox('Show goals, milestones and the team\'s progress on the home page', gm.enabled !== false);
    const board = checkbox('Show an anonymised leaderboard (pseudonyms only)', gm.leaderboard !== false);
    const boardFull = checkbox('Rank the leaderboard by recordings viewed in full, rather than all recordings finished', gm.leaderboard_viewed_only === true);
    const syncGames = () => { board.input.disabled = !games.input.checked; boardFull.input.disabled = !games.input.checked || !board.input.checked; };
    games.input.addEventListener('change', syncGames);
    board.input.addEventListener('change', syncGames);
    syncGames();
    // corrections, adjudication and replays
    const corrections = checkbox('Let experts correct saved work, as new versions linked to the original', rv.corrections !== false);
    const showCorrections = checkbox('Show annotators the corrections of their work, with the reasons given', rv.show_corrections_to_annotators !== false);
    const showOutcomes = checkbox('Show annotators the decisions on the conflicts in their work (who else marked what is never said)', rv.show_outcomes_to_annotators !== false);
    const kDefault = numberInput({ value: rv.k_default ?? 2, min: 2, max: 6, step: 1 });
    kDefault.name = 'k_default';
    const reasons = select(Object.entries(REASON_RULES), rv.reason_required || 'always');
    const criterion = select(Object.entries(MATCH_CRITERIA), mt.match_criterion || 'iou');
    const overlap = numberInput({ value: mt.iou_threshold ?? 0.2, min: 0, max: 0.99, step: 0.05 });
    const onsetTol = numberInput({ value: mt.onset_tolerance_s ?? 0.5, min: 0, max: 60, step: 0.1 });
    const offsetTol = numberInput({ value: mt.offset_tolerance_s ?? 0.5, min: 0, max: 60, step: 0.1 });
    const channelShare = numberInput({ value: mt.channel_jaccard ?? 0.5, min: 0, max: 1, step: 0.05 });
    const goldMin = numberInput({ value: rv.gold_min_items ?? 3, min: 1, max: 100, step: 1 });
    const replays = checkbox('Let experts and administrators replay annotators\' sessions step by step, from the interaction log', rp.enabled !== false);
    const traineesWatch = checkbox('Let trainees watch the sessions of experts who have agreed to it', rp.trainees_watch_experts !== false);
    const traineesCrowd = checkbox('Let trainees see everyone\'s marks as a crowd, with nobody named, on the training recordings for learning with the experts', rp.trainees_see_crowd === true);
    // the training path
    const skippable = new Set(Array.isArray(tr.skippable) ? tr.skippable : Object.keys(SKIPPABLE_STAGES));
    const skipBoxes = Object.entries(SKIPPABLE_STAGES).map(([stage, text]) => {
      const box = checkbox(text, skippable.has(stage));
      box.input.dataset.stage = stage;
      return box;
    });
    const gate = select(Object.entries(TRAINING_GATES), tr.gate || 'met');
    gate.name = 'training_gate';
    const tour = checkbox('Begin the training path with a tour of the platform on a practice recording', tr.tour !== false);
    const snippetsQuiz = checkbox('Count the snippets stage as done only once its recognition check is finished', tr.snippets_quiz_required === true);
    // logging
    const interactions = checkbox('Record how annotators use ElectroTag (clicks, keys and what is on the screen; never what they type)', lg.interactions !== false);
    const pointer = numberInput({ value: lg.pointer_hz ?? 5, min: 0, max: 60, step: 1 });
    const idle = numberInput({ value: lg.idle_after_s ?? 30, min: 5, max: 3600, step: 5 });
    const notice = textArea({ value: this.data.logging_notice || '', rows: 4, placeholder: 'Shown to each annotator once after signing in, when interactions are recorded' });

    const msg = messageArea();
    const read = () => {
      const types = {};
      for (const row of typesHost.children) {
        const [p, t] = row.read();
        if (p) types[p] = t;
      }
      const chosen = keys.map((k) => k.value).filter(Boolean);
      const wanted = {
        filters: { highpass_enabled: hp.input.checked, highpass_hz: numberOf(hpHz, 'High-pass frequency', { min: 0.01, max: 39 }),
          notch_enabled: notch.input.checked, notch_hz: Number(notchHz.value), notch_harmonics: harmonics.input.checked, locked: locked.input.checked },
        display: { duration_s: numberOf(seconds, 'Seconds on the screen', { min: 1, max: 600 }),
          n_channels: numberOf(nch, 'Channels on the screen', { min: 1, integer: true }),
          channel_colours: colours.value,
          scalings: Object.fromEntries(SCALING_TYPES.filter((t) => String(scal[t].value).trim() !== '')
            .map((t) => [t, fromMicrovolts(numberOf(scal[t], `Scale for ${t.toUpperCase()}`, { min: 0.001 }))])) },
        channels: { hide: hide.value.split('\n').map((x) => x.trim()).filter(Boolean), types },
        loading: { apply_channel_types_from_bids: bidsTypes.input.checked, show_bids_bad_channels: bidsBad.input.checked },
        selection: { strategy: strategy.value, seed: strategy.value === 'seeded' ? numberOf(seed, 'Seed', { min: 0, integer: true }) : (sel.seed ?? null) },
        annotation: { quick_labels: chosen, min_duration_samples: numberOf(shortest, 'Shortest annotation', { min: 1, integer: true }),
          break_reminder_minutes: numberOf(breakAfter, 'Break reminder after', { min: 0, max: 240 }),
          idle_pause_minutes: numberOf(idlePause, 'Pause after', { min: 0, max: 60 }),
          coverage_check: coverage.input.checked ? 'warn' : 'off', allow_revisions: revisions.input.checked,
          allow_reviews: reviews.input.checked, show_reviews_to_annotators: showReviews.input.checked,
          confidence: confidence.value() },
        gamification: { enabled: games.input.checked, leaderboard: board.input.checked, leaderboard_viewed_only: boardFull.input.checked },
        review: { corrections: corrections.input.checked, show_corrections_to_annotators: showCorrections.input.checked,
          k_default: numberOf(kDefault, 'Annotators per task', { min: 2, max: 6, integer: true }),
          show_outcomes_to_annotators: showOutcomes.input.checked, reason_required: reasons.value,
          // in the order the study keeps them, so that an unchanged block is not sent again
          matching: { ...mt, match_criterion: criterion.value, iou_threshold: numberOf(overlap, 'Overlap needed', { min: 0, max: 0.99 }),
            onset_tolerance_s: numberOf(onsetTol, 'Start tolerance', { min: 0, max: 60 }), offset_tolerance_s: numberOf(offsetTol, 'End tolerance', { min: 0, max: 60 }),
            channel_jaccard: numberOf(channelShare, 'Share of channels in common', { min: 0, max: 1 }) },
          gold_min_items: numberOf(goldMin, 'Known-answer recordings before accuracy counts', { min: 1, max: 100, integer: true }) },
        replay: { enabled: replays.input.checked, trainees_watch_experts: traineesWatch.input.checked, trainees_see_crowd: traineesCrowd.input.checked },
        training: { skippable: skipBoxes.filter((b) => b.input.checked).map((b) => b.input.dataset.stage), gate: gate.value,
          tour: tour.input.checked, snippets_quiz_required: snippetsQuiz.input.checked },
        logging: { interactions: interactions.input.checked, pointer_hz: numberOf(pointer, 'Pointer samples per second', { min: 0, max: 60 }),
          idle_after_s: numberOf(idle, 'Idle after', { min: 5, max: 3600 }) },
      };
      const merged = mergeSettings(st, wanted);
      const problems = [...settingsProblems(merged, labels.map((l) => l.label)), ...expertSettingsProblems(merged)];
      if (problems.length) throw new Error(problems[0]);
      return wanted;
    };
    const save = actionButton('Save the settings', { kind: 'primary', working: 'Saving…', msg, log: 'settings-save', onClick: async () => {
      msg.clear();
      for (const el of this.form.querySelectorAll('[aria-invalid="true"]')) el.removeAttribute('aria-invalid');
      const body = {};
      let wanted;
      try {
        wanted = read();
      } catch (exc) {
        // The field to correct is marked and focused, and the message is in the bar beside Save.
        if (exc.field) { exc.field.setAttribute('aria-invalid', 'true'); exc.field.focus(); }
        throw exc;
      }
      const diff = changes(st, wanted);
      if (Object.keys(diff).length) body.settings = diff;
      if (name.value.trim() !== (this.data.name || '')) body.name = name.value.trim();
      if (notice.value !== (this.data.logging_notice || '')) body.logging_notice = notice.value;
      if (!Object.keys(body).length) { this._setDirty(false); msg.show('note', 'Nothing has changed.'); return; }
      this.data = await this.area.write('settings_update', body);
      this._setDirty(false);
      this._build();
      this.saveMsg.show('success', 'The settings are saved. Annotators see them the next time they open a recording or sign in.');
      if (this.area.app.refreshMe) this.area.app.refreshMe().catch(() => {});
    } });

    this.form.append(
      card('The study', field('Name', name, { hint: 'Shown to annotators on the sign-in page and in the header.' })),
      card('Display filters',
        h('p.caption', {}, 'Zero-phase filters for display only: the recordings are never changed.'),
        h('div.row.controls', {}, hp, hpHz, h('span', {}, 'Hz')), h('div.row.controls', {}, notch, notchHz, harmonics), locked),
      card('The display',
        h('div.form-grid', {}, field('Seconds on the screen', seconds), field('Channels on the screen', nch),
          field('Channel colours at first', colours, { hint: 'Colours the traces by region, side or type, in a palette checked for colour-blind readers; each annotator can change it for themselves.' })),
        h('h3', {}, 'Starting amplitude of each channel type (µV; the scale bar shows twice the value)'),
        h('div.form-grid.narrow', {}, SCALING_TYPES.map((t) => field(t.toUpperCase(), scal[t]))),
        h('p.caption', {}, 'A recording whose amplitudes are unusual is shown with a scale of its own, and says so.')),
      card('Channels',
        field('Channels to hide', hide, { hint: 'Not shown and not annotated: headset housekeeping channels, for example. * stands for any characters.' }),
        h('h3', {}, 'Channel types by name'),
        h('p.caption', {}, 'For channels whose type cannot be told from the name, for example EXG1 to EXG8 as EOG.'),
        typesHost, h('div.btn-row', {}, h('button.btn.small', { type: 'button', onclick: () => addType() }, 'Add a pattern')),
        bidsTypes, bidsBad),
      card('The next recording',
        h('div.form-grid', {}, field('How it is chosen', strategy), field('Seed', seed, { hint: 'For a reproducible order: the same seed gives the same order.' })),
        h('p.caption', {}, 'Random: a recording the annotator has not finished, chosen at random. Reproducible: an order made from the seed and the annotator ID. Assignment order: as the recordings were assigned. Unfinished work always comes first.')),
      card('Annotation',
        h('p.caption', {}, 'The artifact types on the number keys 1 to 9 (the toolbar shows them in this order).'),
        h('div.key-grid', {}, keys.map((k, i) => h('label.key-row', {}, h('kbd', {}, String(i + 1)), k))),
        field('Shortest annotation (samples)', shortest),
        revisions,
        h('p.caption', {}, 'A revision is saved as a new version beside the earlier ones, which are kept unchanged; analyses use the latest version.'),
        reviews, showReviews,
        h('p.caption', {}, 'A review is kept as a record of its own: it never changes the saved annotations, and the agreement analyses do not use it.'),
        h('h3', {}, 'Confidence'),
        h('p.caption', {}, 'Annotators can always rate their confidence in a mark from 1 (not at all confident) to 5 (completely confident), with D and a number, the menu or the Annotations list, and add a short note. No mark starts with a rating.'),
        confidence,
        h('h3', {}, 'Long sessions'),
        h('p.caption', {}, 'The time worked on a recording is research data: it leaves out the time an annotator is paused.'),
        h('div.form-grid', {},
          field('Break reminder after (minutes of work)', breakAfter, { hint: 'A gentle offer of a break, which the annotator can put off for 15 minutes. 0 turns reminders off.' }),
          field('Pause after (minutes without input)', idlePause, { hint: 'The clock also pauses when the page is out of sight for more than 10 seconds. 0 turns this pause off.' })),
        coverage,
        h('p.caption', {}, 'The list gives the stretches of at least a second that were never on the screen, with Go to the first part and Save anyway.')),
      card('Game elements',
        games, board, boardFull,
        h('p.caption', {}, 'Milestones reward finishing recordings and viewing them in full, never speed or the number of annotations.'),
        h('p.caption.games-warning', {}, 'Game elements may change how annotators work. If they are on, say so in the study\'s methods.')),
      card('Corrections and adjudication',
        h('p.caption', {}, 'An expert\'s correction is a new version of the saved work, credited to the expert; the original never changes, and the analyses use the originals. '
          + 'These choices apply to the expert area\'s corrections, tasks and adjudication as the study offers them.'),
        corrections, showCorrections, showOutcomes,
        h('div.form-grid', {},
          field('Annotators per task', kDefault, { hint: 'When the study shares recordings out as tasks: between 2 and 6.' }),
          field('A reason for each decision', reasons),
          field('Known-answer recordings before accuracy counts', goldMin, { hint: 'A person\'s measured accuracy on known-answer tasks weighs their marks once this many are scored.' })),
        h('h3', {}, 'When two marks are the same'),
        h('p.caption', {}, 'The rules that find disagreements between annotators, as in the agreement analysis.'),
        h('div.form-grid', {},
          field('Matched', criterion), field('Overlap needed', overlap, { hint: 'From 0 (any overlap) to just below 1.' }),
          field('Start tolerance (s)', onsetTol), field('End tolerance (s)', offsetTol),
          field('Share of channels in common', channelShare, { hint: 'Below it, two marks differ in their channels. From 0 to 1.' })),
        h('h3', {}, 'Replays'),
        replays, traineesWatch, traineesCrowd,
        h('p.caption', {}, 'Each expert decides for their own sessions in the expert area, and every change is in the audit log. Replays use the interaction log for teaching and checking work: say so in the study\'s information for participants, and check that the ethics approval covers it.')),
      card('Training policy',
        h('p.caption', {}, 'The training path has five stages: a tour of the platform, examples of each artifact type, learning with '
          + 'the experts, practice on one\'s own and the blind competency assessment. Choose the stages a trainee may skip; the '
          + 'assessment is never skipped, and every skip is noted in the trainee\'s progress and their competency report.'),
        h('fieldset.admin-checks.skip-stages', {}, h('legend', {}, 'Trainees may skip'), h('div.radio-col', {}, skipBoxes)),
        field('Real study work waits', gate, { hint: 'Experts and administrators never wait.' }),
        tour, snippetsQuiz,
        h('p.caption', {}, 'While study work waits, a trainee\'s study recordings are listed as locked, with the reason. After an '
          + 'assessment that does not meet the criteria, reopen the training or give a new assessment on the trainee\'s page in People.')),
      card('Interaction log',
        interactions,
        h('div.form-grid', {}, field('Pointer samples per second over the EEG', pointer, { hint: '0 records none.' }), field('Idle after (seconds without input)', idle)),
        field('Notice shown to annotators', notice, { hint: 'Say what is recorded and why, as the study\'s information sheet does.' })),
      this._saveBar(save, msg));
  }

  /** The bar at the foot of the window: Save, whether anything is unsaved, and the answer to Save. */
  _saveBar(save, msg) {
    this.saveMsg = msg;
    this.dirtyNote = h('span.caption.unsaved-note', { role: 'status', hidden: !this.dirty }, 'Unsaved changes');
    this.leaveHost = h('div.leave-host');
    return h('div.sticky-save', {}, h('div.btn-row', {}, save, this.dirtyNote), msg, this.leaveHost);
  }
}

/** The two choices of annotation.confidence, each with what it does (the first design's 'off' and 'on' read as these). */
function confidenceChoice(value) {
  const current = value === 'every_mark' || value === 'on' ? 'every_mark' : 'optional';
  const el = radios('confidence', [
    ['optional', 'Optional', 'Annotators rate a mark only when they wish. Costs nothing, and records confidence when they want to say it.'],
    ['every_mark', 'Every mark', 'After each new mark annotators are asked for a rating, answered with one key or tap; Save and Finish lists the marks left unrated.'],
  ], current);
  el.setAttribute('aria-label', 'Confidence');
  return el;
}
