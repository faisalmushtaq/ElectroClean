// Study settings: the parts of electroclean_study.json that a study may change (settings_get and
// settings_update): its name, the display filters and whether they are fixed, the display, the
// channels to hide and channel types by name pattern, how the next recording is chosen, the types
// on the number keys, the shortest annotation, the comfort of long sessions (break reminders, the
// pause after a while without input, the check of what has been viewed before Save and Finish), and
// the interaction log with its notice.

import { h, clear } from '../ui/dom.js';
import { CHANNEL_TYPES, SCALING_TYPES, SELECTION, deepCopy, fromMicrovolts, mergeSettings, parseNumber, settingsProblems, toMicrovolts } from './model.js';
import { actionButton, card, checkbox, field, loading, messageArea, numberInput, sectionHead, select, textArea, textInput } from './ui.js';

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
    this.msg = messageArea();
    this.form = h('div.admin-stack');
    this.el = h('section.admin-section', { 'data-section': 'settings' },
      sectionHead('Study settings', 'What every annotator of the study sees and uses. Changes apply when an annotator next opens a recording.'),
      this.msg, this.form);
  }

  async show() {
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
      const row = h('div.row.pattern-row', {}, p, t, h('button.btn.small.quiet.destructive-text', { type: 'button', onclick: () => row.remove() }, 'Remove'));
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
    // logging
    const interactions = checkbox('Record how annotators use ElectroClean (clicks, keys and what is on the screen; never what they type)', lg.interactions !== false);
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
        filters: { highpass_enabled: hp.input.checked, highpass_hz: parseNumber(hpHz.value, 'High-pass frequency', { min: 0.01, max: 39 }),
          notch_enabled: notch.input.checked, notch_hz: Number(notchHz.value), notch_harmonics: harmonics.input.checked, locked: locked.input.checked },
        display: { duration_s: parseNumber(seconds.value, 'Seconds on the screen', { min: 1, max: 600 }),
          n_channels: parseNumber(nch.value, 'Channels on the screen', { min: 1, integer: true }),
          scalings: Object.fromEntries(SCALING_TYPES.filter((t) => String(scal[t].value).trim() !== '')
            .map((t) => [t, fromMicrovolts(parseNumber(scal[t].value, `Scale for ${t.toUpperCase()}`, { min: 0.001 }))])) },
        channels: { hide: hide.value.split('\n').map((x) => x.trim()).filter(Boolean), types },
        loading: { apply_channel_types_from_bids: bidsTypes.input.checked, show_bids_bad_channels: bidsBad.input.checked },
        selection: { strategy: strategy.value, seed: strategy.value === 'seeded' ? parseNumber(seed.value, 'Seed', { min: 0, integer: true }) : (sel.seed ?? null) },
        annotation: { quick_labels: chosen, min_duration_samples: parseNumber(shortest.value, 'Shortest annotation', { min: 1, integer: true }),
          break_reminder_minutes: parseNumber(breakAfter.value, 'Break reminder after', { min: 0, max: 240 }),
          idle_pause_minutes: parseNumber(idlePause.value, 'Pause after', { min: 0, max: 60 }),
          coverage_check: coverage.input.checked ? 'warn' : 'off' },
        logging: { interactions: interactions.input.checked, pointer_hz: parseNumber(pointer.value, 'Pointer samples per second', { min: 0, max: 60 }),
          idle_after_s: parseNumber(idle.value, 'Idle after', { min: 5, max: 3600 }) },
      };
      const problems = settingsProblems(mergeSettings(st, wanted), labels.map((l) => l.label));
      if (problems.length) throw new Error(problems[0]);
      return wanted;
    };
    const save = actionButton('Save the settings', { kind: 'primary', working: 'Saving…', msg, log: 'settings-save', onClick: async () => {
      msg.clear();
      const body = {};
      const diff = changes(st, read());
      if (Object.keys(diff).length) body.settings = diff;
      if (name.value.trim() !== (this.data.name || '')) body.name = name.value.trim();
      if (notice.value !== (this.data.logging_notice || '')) body.logging_notice = notice.value;
      if (!Object.keys(body).length) { msg.show('note', 'Nothing has changed.'); return; }
      this.data = await this.area.write('settings_update', body);
      this._build();
      this.msg.show('success', 'The settings are saved. Annotators see them the next time they open a recording or sign in.');
      if (this.area.app.refreshMe) this.area.app.refreshMe().catch(() => {});
    } });

    this.form.append(
      card('The study', field('Name', name, { hint: 'Shown to annotators on the sign-in page and in the header.' })),
      card('Display filters',
        h('p.caption', {}, 'Zero-phase filters for display only: the recordings are never changed.'),
        h('div.row.controls', {}, hp, hpHz, h('span', {}, 'Hz')), h('div.row.controls', {}, notch, notchHz, harmonics), locked),
      card('The display',
        h('div.form-grid', {}, field('Seconds on the screen', seconds), field('Channels on the screen', nch)),
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
        h('h3', {}, 'Long sessions'),
        h('p.caption', {}, 'The time worked on a recording is research data: it leaves out the time an annotator is paused.'),
        h('div.form-grid', {},
          field('Break reminder after (minutes of work)', breakAfter, { hint: 'A gentle offer of a break, which the annotator can put off for 15 minutes. 0 turns reminders off.' }),
          field('Pause after (minutes without input)', idlePause, { hint: 'The clock also pauses when the page is out of sight for more than 10 seconds. 0 turns this pause off.' })),
        coverage,
        h('p.caption', {}, 'The list gives the stretches of at least a second that were never on the screen, with Go to the first and Save anyway.')),
      card('Interaction log',
        interactions,
        h('div.form-grid', {}, field('Pointer samples per second over the EEG', pointer, { hint: '0 records none.' }), field('Idle after (seconds without input)', idle)),
        field('Notice shown to annotators', notice, { hint: 'Say what is recorded and why, as the study\'s information sheet does.' })),
      h('div.btn-row.sticky-save', {}, save), msg);
  }
}
