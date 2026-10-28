// Training: the reference sets behind the training programme and the quiz. For each set, its
// recordings with their use (guided, practice, assessment) and where each reference came from;
// adding a reference from someone's saved annotations, an annotation file, a consensus of several
// annotators or an adjudicated consensus; the guided notes; the set's settings, its competency
// criteria (electroclean.training.assessment.CompetencyCriteria) and its quiz items. Also the
// example training set, whose simulated recordings stand in until real expert files exist.

import { h, clear } from '../ui/dom.js';
import {
  GUIDANCE, METRICS, USES, USE_SHORT, checkSetId, criteriaFromRows, criteriaRows, describeProvenance, parseNumber, plural,
  readAnnotationDocument, scopeText, tsvText,
} from './model.js';
import {
  actionButton, card, checkbox, checkList, chip, confirmInline, dataTable, downloadBase64, downloadText, field, loading, messageArea,
  numberInput, radios, recordingName, sectionHead, select, tabBar, textArea, textInput,
} from './ui.js';

const TABS = [
  { key: 'references', title: 'Recordings and references' },
  { key: 'settings', title: 'Settings' },
  { key: 'criteria', title: 'Competency criteria' },
  { key: 'quiz', title: 'Quiz' },
];
const DISAGREEMENT_COLUMNS = ['kind', 'label', 'onset_s', 'offset_s', 'experts_marking', 'experts_not_marking', 'note'];

export class TrainingSection {
  constructor(area) {
    this.area = area;
    this.sets = [];
    this.users = [];
    this.recordings = [];
    this.setId = null;
    this.tab = 'references';
    this.msg = messageArea();
    this.setList = h('div.set-list', { role: 'list' });
    this.detail = h('div.admin-stack');
    this.el = h('section.admin-section', { 'data-section': 'training' },
      sectionHead('Training', 'Reference sets hold the recordings and the experts\' annotations behind the training programme, the competency assessment and the quiz. Trainees never see a reference until the programme shows it to them.'),
      this.msg,
      h('div.admin-grid.side-first', {},
        h('div.admin-stack', {}, card('Reference sets', this.setList), this._newSetCard(), this._exampleCard()),
        this.detail));
  }

  async show(params) {
    this.msg.clear();
    if (params.set) this.setId = params.set;
    await this.reload();
  }

  async reload(note = null) {
    clear(this.setList);
    this.setList.append(loading());
    try {
      const [s, u, r] = await Promise.all([this.area.read('sets_list'), this.area.read('users_list'), this.area.read('recordings_list')]);
      this.sets = s.sets || [];
      this.users = u.users || [];
      this.recordings = r.recordings || [];
    } catch (exc) {
      clear(this.setList);
      this.msg.problem(exc);
      return;
    }
    if (!this.sets.some((x) => x.set_id === this.setId)) this.setId = this.sets.length ? this.sets[0].set_id : null;
    this._renderSetList();
    this._renderDetail(note);
  }

  get set() { return this.sets.find((x) => x.set_id === this.setId) || null; }

  _renderSetList() {
    clear(this.setList);
    if (!this.sets.length) { this.setList.append(h('p.caption', {}, 'No reference sets yet. Create one below, or the example set.')); return; }
    for (const s of this.sets) {
      const counts = ['guided', 'practice', 'assessment'].map((u) => [u, s.recordings.filter((r) => r.use === u).length]).filter(([, n]) => n)
        .map(([u, n]) => `${n} ${u}`).join(', ');
      this.setList.append(h('button.set-item', { type: 'button', role: 'listitem', 'aria-current': s.set_id === this.setId ? 'true' : null,
        onclick: () => { this.setId = s.set_id; this._renderSetList(); this._renderDetail(); } },
      h('span.set-name', {}, s.name || s.set_id), h('span.caption', {}, `${s.set_id}${counts ? ` · ${counts}` : ' · no recordings yet'}${s.quiz_items ? ` · ${plural(s.quiz_items, 'quiz item')}` : ''}`)));
    }
  }

  _newSetCard() {
    const id = textInput({ placeholder: 'for example pilot' });
    const name = textInput({ placeholder: 'for example Pilot training set' });
    const description = textArea({ rows: 2, placeholder: 'optional' });
    const msg = messageArea();
    const go = actionButton('Create the set', { kind: 'primary', working: 'Creating…', msg, log: 'set-create', onClick: async () => {
      const body = { set_id: checkSetId(id.value), name: name.value.trim(), description: description.value.trim() };
      const r = await this.area.write('set_create', body);
      this.setId = (r.set && r.set.set_id) || body.set_id;
      this.tab = 'references';
      for (const f of [id, name, description]) f.value = '';
      await this.reload(['success', `Created ${this.setId}. Add its recordings and references next.`]);
    } });
    const form = h('form.admin-form', { onsubmit: (e) => { e.preventDefault(); go.click(); } },
      field('Identifier', id, { hint: 'Letters, digits, dots, hyphens or underscores; it cannot be changed.' }), field('Name', name), field('Description', description),
      h('div.btn-row', {}, go), msg);
    const details = h('details.admin-details', {}, h('summary', {}, 'New reference set'), form);
    return h('section.card.admin-card', {}, details);
  }

  _exampleCard() {
    const msg = messageArea();
    const out = h('div.admin-result');
    const go = actionButton('Create the example training set', { working: 'Creating…', msg, onClick: async () => {
      clear(out);
      const r = await this.area.write('set_example_create', {});
      this.setId = r.set ? r.set.set_id : this.setId;
      await this.reload(['success', 'The example training set is ready.']);
      const zip = r.recordings_zip;
      if (zip && zip.base64) {
        out.append(h('p.success', {}, 'Give trainees its simulated recordings, which they open from their own computers.'),
          h('div.btn-row', {}, h('button.btn', { type: 'button', onclick: () => downloadBase64(zip.file_name || 'example_recordings.zip', zip.base64, 'application/zip') },
            'Download the example recordings (zip)')));
      }
    } });
    return h('section.card.admin-card', {}, h('details.admin-details', {}, h('summary', {}, 'Example training set'),
      h('p.caption', {}, 'Three simulated recordings with known artifacts (two to learn with the experts, one to practise on), as placeholders until your experts\' recordings are ready.'),
      h('div.btn-row', {}, go), msg, out));
  }

  // ---------------------------------------------------------------- detail
  _renderDetail(note = null) {
    clear(this.detail);
    const s = this.set;
    if (!s) { this.detail.append(card(null, h('p.caption', {}, 'Create a reference set, or choose one, to see its recordings and settings.'))); return; }
    this.body = h('div.admin-stack');
    this.detailMsg = messageArea();
    const tabs = tabBar(TABS, (key) => { this.tab = key; this._renderTab(); });
    this.detail.append(h('div.admin-head', {}, h('h2.set-title', { tabindex: '-1' }, s.name || s.set_id),
      h('p.subtitle', {}, `${s.set_id}${s.description ? ` · ${s.description}` : ''}`)), this.detailMsg, tabs, this.body);
    tabs.select(this.tab);
    if (note) this.detailMsg.show(...note);
  }

  _renderTab() {
    clear(this.body);
    const s = this.set;
    if (!s) return;
    if (this.tab === 'settings') this.body.append(this._settingsTab(s));
    else if (this.tab === 'criteria') this.body.append(this._criteriaTab(s));
    else if (this.tab === 'quiz') this.body.append(this._quizTab(s));
    else this.body.append(this._referencesTab(s));
  }

  // ------------------------------------------------------------ references
  _referencesTab(s) {
    const manage = h('div.admin-stack');
    const table = dataTable([
      { title: 'Recording', render: (r) => recordingName(r.recording_id) },
      { title: 'Used for', render: (r) => h('span', {}, USE_SHORT[r.use] || r.use, r.use === 'guided' ? h('span.caption.block', {}, GUIDANCE[r.effective_guidance || r.guidance] || r.guidance) : null) },
      { title: 'Reference', render: (r) => h('span', {}, describeProvenance(r.provenance), h('span.caption.block', {}, plural(r.n_reference_events ?? 0, 'annotation'))) },
      { title: '', render: (r) => (r.registered === false ? chip('No description', 'warning') : null) },
      { title: '', cls: 'actions', render: (r) => h('button.btn.small', { type: 'button', onclick: () => this._manageRecording(manage, s, r) }, 'Manage') },
    ], s.recordings, { empty: 'This set has no recordings yet. Add one below with its reference.', pageSize: 20, caption: 'Recordings of the set' });
    return h('div.admin-stack', {}, card('Recordings of the set', table), manage, this._addReferenceCard(s));
  }

  _manageRecording(host, s, r) {
    clear(host);
    const msg = messageArea();
    const use = radios(`use-${r.recording_id}`, Object.entries(USES).map(([v, t]) => [v, t]), r.use);
    const guidance = select(GUIDANCE, r.guidance || 'auto');
    const save = actionButton('Save', { kind: 'primary', working: 'Saving…', msg, onClick: async () => {
      const body = { set_id: s.set_id, recording_id: r.recording_id };
      if (use.value() && use.value() !== r.use) body.use = use.value();
      if ((use.value() || r.use) === 'guided' && guidance.value !== (r.guidance || 'auto')) body.guidance = guidance.value;
      const out = await this.area.write('set_recording_update', body);
      const warnings = out.warnings || [];
      await this.reload(warnings.length ? ['banner', `Saved, with a warning: ${warnings.join(' ')}`]
        : ['success', `Saved: ${r.recording_id} is used for ${(USE_SHORT[body.use || r.use] || '').toLowerCase()}.`]);
    } });
    const guidanceField = field('How much help the guided recording gives', guidance, { hint: 'By its place: the first guided recording shows each artifact, the second names it, later ones only say one follows.' });
    const syncGuidance = () => { guidanceField.hidden = (use.value() || r.use) !== 'guided'; };
    use.addEventListener('change', syncGuidance);
    syncGuidance();
    const notesHost = h('div.admin-stack');
    const notesBtn = actionButton('Edit the guided notes', { working: 'Loading…', msg, onClick: () => this._guidedNotes(notesHost, s, r) });
    const removeHost = h('div.btn-row');
    removeHost.append(h('button.btn.destructive', { type: 'button', onclick: async () => {
      if (!(await confirmInline(removeHost, { text: `Remove ${r.recording_id} from ${s.name || s.set_id}? Its reference goes with it.`, yes: 'Remove it' }))) return;
      try {
        await this.area.write('set_remove_recording', { set_id: s.set_id, recording_id: r.recording_id });
        await this.reload(['success', `${r.recording_id} was removed from the set.`]);
      } catch (exc) { msg.problem(exc); }
    } }, 'Remove from the set'));
    host.append(card(null,
      h('div.card-head', {}, h('h3', {}, r.recording_id), h('button.btn.quiet', { type: 'button', onclick: () => clear(host) }, 'Close')),
      h('p.caption', {}, `Reference: ${describeProvenance(r.provenance)}${r.provenance && r.provenance.notes ? `. ${r.provenance.notes}` : ''}`),
      msg,
      h('fieldset.admin-fieldset', {}, h('legend', {}, 'Used for'), use), guidanceField,
      h('div.btn-row', {}, save),
      h('h3', {}, 'Guided notes'),
      h('p.caption', {}, 'The note shown with each of the experts\' annotations while a trainee is guided through the recording.'),
      h('div.btn-row', {}, notesBtn), notesHost,
      h('h3', {}, 'Remove'), removeHost));
    host.querySelector('h3').tabIndex = -1;
    host.querySelector('h3').focus({ preventScroll: false });
  }

  async _guidedNotes(host, s, r) {
    clear(host);
    const res = await this.area.read('set_guided_notes', { set_id: s.set_id, recording_id: r.recording_id });
    const notes = res.notes || [];
    if (!notes.length) { host.append(h('p.caption', {}, 'This reference has no annotations, so there are no notes to write.')); return; }
    for (const n of notes) {
      const text = textArea({ value: n.note || '', rows: 2 });
      const m = messageArea();
      const save = actionButton('Save note', { kind: 'small', working: 'Saving…', msg: m, onClick: async () => {
        await this.area.write('set_guided_note', { set_id: s.set_id, annotation_id: n.annotation_id, text: text.value });
        m.show('success', 'Saved.');
      } });
      host.append(h('div.note-row', {}, field(`${n.label}, ${Number(n.onset_s).toFixed(2)}–${Number(n.offset_s).toFixed(2)} s`, text), h('div.row', {}, save, m)));
    }
  }

  _addReferenceCard(s) {
    const msg = messageArea();
    const out = h('div.admin-result');
    const recs = this.recordings.filter((r) => r.scope === 'study' || r.scope === `set:${s.set_id}`);
    const recording = select([
      { group: 'This set', options: recs.filter((r) => r.scope !== 'study').map((r) => [`${r.scope}|${r.recording_id}`, r.recording_id]) },
      { group: 'The study', options: recs.filter((r) => r.scope === 'study').map((r) => [`study|${r.recording_id}`, r.recording_id]) },
    ].filter((g) => g.options.length));
    const use = radios(`new-use-${s.set_id}`, Object.entries(USES).map(([v, t]) => [v, t]), '');
    const kinds = [
      ['annotator', 'Someone\'s saved annotations', 'An expert annotates the recording in this study (in Annotation mode), and their saved work becomes the reference.'],
      ['document', 'An annotation file', 'An ElectroClean _annotations.json, for example one saved in another ElectroClean study.'],
      ['consensus', 'A consensus of several annotators', 'Where enough of them agree, sample by sample, for each artifact type.'],
      ['adjudicated', 'An adjudicated consensus', 'An adjudicator\'s saved annotations, made after reviewing the experts\' disagreements.'],
    ];
    const kind = radios(`source-${s.set_id}`, kinds, 'annotator');
    const people = this.users.map((u) => [u.annotator_id, `${u.annotator_id}${u.display_name ? ` · ${u.display_name}` : ''}`]);
    // someone's saved annotations
    const who = select(people);
    const mode = select([['standard', 'Annotation'], ['practice', 'Practice'], ['assessment', 'Assessment'], ['guided', 'Guided training']], 'standard');
    const ctx = textInput({ placeholder: 'the reference set, for training modes' });
    const annotatorPart = h('div.source-part', {}, h('div.row.wrap', {}, field('Whose', who), field('Saved in', mode), field('Context', ctx)));
    // a file
    let documentData = null;
    const fileInfo = h('p.caption', { role: 'status' });
    const file = h('input', { type: 'file', accept: '.json,application/json', onchange: async () => {
      documentData = null;
      fileInfo.textContent = '';
      const f = file.files[0];
      if (!f) return;
      try {
        documentData = readAnnotationDocument(await f.text());
        const by = documentData.annotator && documentData.annotator.annotator_id;
        const rid = documentData.recording && documentData.recording.recording_id;
        fileInfo.textContent = `${plural(documentData.annotations.length, 'annotation')}${by ? ` by ${by}` : ''}${rid ? ` of ${rid}` : ''}.`;
      } catch (exc) { fileInfo.textContent = exc.message; }
    } });
    const documentPart = h('div.source-part', {}, field('Annotation file (*_annotations.json)', file), fileInfo);
    // consensus
    const experts = checkList(this.users.map((u) => ({ value: u.annotator_id, text: u.annotator_id, extra: u.display_name || '' })), { legend: 'Experts (two or more)', name: 'experts' });
    const minAgree = numberInput({ min: 1, step: 1, value: '' });
    const gap = numberInput({ min: 0, step: 0.05, value: 0 });
    const shortest = numberInput({ min: 0, step: 0.05, value: 0 });
    const consensusPart = h('div.source-part', {}, experts, h('div.row.wrap', {},
      field('Needed to agree', minAgree, { hint: 'Empty: more than half of them.' }),
      field('Merge gaps up to (s)', gap), field('Shortest artifact (s)', shortest)));
    // adjudicated
    const adjudicator = select(people);
    const adjExperts = checkList(this.users.map((u) => ({ value: u.annotator_id, text: u.annotator_id, extra: u.display_name || '' })), { legend: 'Experts whose disagreements were adjudicated', name: 'adj-experts' });
    const adjudicatedPart = h('div.source-part', {}, field('Adjudicator', adjudicator, { hint: 'Their saved annotations (in Annotation mode) are the reference.' }), adjExperts);
    const parts = { annotator: annotatorPart, document: documentPart, consensus: consensusPart, adjudicated: adjudicatedPart };
    const sync = () => { for (const [k, el] of Object.entries(parts)) el.hidden = kind.value() !== k; };
    kind.addEventListener('change', sync);
    sync();
    const notes = textArea({ rows: 2, placeholder: 'optional: who the experts are, how they worked' });
    const add = actionButton('Add the reference', { kind: 'primary', working: 'Adding…', msg, log: 'set-add-reference', onClick: async () => {
      msg.clear();
      clear(out);
      if (!recording.value) throw new Error('Choose the recording first (add it on the Recordings page if it is not listed).');
      if (!use.value()) throw new Error('Choose how the recording is used: guided, practice or assessment.');
      const [scope, rid] = [recording.value.slice(0, recording.value.indexOf('|')), recording.value.slice(recording.value.indexOf('|') + 1)];
      let source;
      const k = kind.value();
      if (k === 'annotator') {
        if (!who.value) throw new Error('Choose whose annotations to use.');
        source = { kind: 'annotator', annotator_id: who.value, mode: mode.value, context_id: mode.value === 'standard' ? '' : ctx.value.trim() };
      } else if (k === 'document') {
        if (!documentData) throw new Error('Choose an annotation file that can be read.');
        source = { kind: 'document', document: documentData };
      } else if (k === 'consensus') {
        const ids = experts.values();
        if (ids.length < 2) throw new Error('A consensus needs at least two experts.');
        source = { kind: 'consensus', annotator_ids: ids, min_agreement: parseNumber(minAgree.value, 'Needed to agree', { min: 1, max: ids.length, integer: true, optional: true }),
          merge_gap_s: parseNumber(gap.value || '0', 'Merge gaps', { min: 0 }), min_duration_s: parseNumber(shortest.value || '0', 'Shortest artifact', { min: 0 }) };
      } else {
        if (!adjudicator.value) throw new Error('Choose the adjudicator.');
        source = { kind: 'adjudicated', adjudicator_id: adjudicator.value, expert_ids: adjExperts.values() };
      }
      const r = await this.area.write('set_add_reference', { set_id: s.set_id, recording_id: rid, recording_scope: scope, use: use.value(), source,
        provenance: { notes: notes.value.trim() } });
      const rows = r.disagreements || null;
      await this.reload(['success', `${rid} is now in ${s.name || s.set_id} for ${use.value()}.`]);
      if (rows) this._showDisagreements(rows, rid);
    } });
    return card('Add a recording with its reference',
      h('p.caption', {}, 'The recording must be registered first (Recordings page). A study recording is copied into the set, so it is never offered for study annotation through the set.'),
      field('Recording', recording),
      h('fieldset.admin-fieldset', {}, h('legend', {}, 'Used for'), use),
      h('fieldset.admin-fieldset', {}, h('legend', {}, 'The reference comes from'), kind),
      annotatorPart, documentPart, consensusPart, adjudicatedPart,
      field('Notes about the reference', notes),
      h('div.btn-row', {}, add), msg, out);
  }

  _showDisagreements(rows, rid) {
    const box = card(`Where the experts disagreed (${rows.length})`,
      h('p.caption', {}, 'For adjudication: every stretch where the experts differ, and what the consensus kept.'),
      dataTable([
        { title: 'Kind', render: (d) => d.kind }, { title: 'Type', render: (d) => d.label },
        { title: 'From (s)', num: true, render: (d) => Number(d.onset_s).toFixed(2) }, { title: 'To (s)', num: true, render: (d) => Number(d.offset_s).toFixed(2) },
        { title: 'Marked by', render: (d) => d.experts_marking || '–' }, { title: 'Not by', render: (d) => d.experts_not_marking || '–' },
        { title: 'Note', render: (d) => d.note },
      ], rows, { empty: 'The experts agreed everywhere.', pageSize: 20 }),
      rows.length ? h('div.btn-row', {}, h('button.btn', { type: 'button', onclick: () => downloadText(`${rid.split('/').pop().replace(/\.[^.]+$/, '')}_disagreements.tsv`, tsvText(DISAGREEMENT_COLUMNS, rows.map((d) => ({ ...d, onset_s: Number(d.onset_s).toFixed(4), offset_s: Number(d.offset_s).toFixed(4) }))), 'text/tab-separated-values') }, 'Download the table (TSV)')) : null);
    this.body.append(box);
    box.scrollIntoView({ block: 'nearest' });
  }

  // -------------------------------------------------------------- settings
  _settingsTab(s) {
    const msg = messageArea();
    const name = textInput({ value: s.name || '' });
    const description = textArea({ value: s.description || '', rows: 2 });
    const review = checkbox('After each practice recording, offer a review of the trainee\'s work against the reference', s.practice_review !== false);
    const allowed = checkList(this.users.map((u) => ({ value: u.annotator_id, text: u.annotator_id, extra: u.display_name || '' })),
      { selected: s.allowed_annotators || [], legend: 'Who may use the set (none ticked: everyone)', name: 'allowed' });
    const pass = s.practice_pass || {};
    const f1 = numberInput({ value: Math.round((pass.event_f1 ?? 0.8) * 100), min: 0, max: 100, step: 1 });
    const acc = numberInput({ value: Math.round((pass.label_accuracy ?? 0.8) * 100), min: 0, max: 100, step: 1 });
    const tol = s.guided_tolerance || {};
    const secs = numberInput({ value: tol.seconds ?? 0.2, min: 0, max: 5, step: 0.05 });
    const frac = numberInput({ value: Math.round((tol.fraction ?? 0.2) * 100), min: 0, max: 100, step: 1 });
    const chans = numberInput({ value: Math.round((tol.channel_jaccard ?? 0.75) * 100), min: 1, max: 100, step: 1 });
    for (const [input, label] of [[f1, 'Pass mark: share of the experts\' artifacts found (%)'], [acc, 'Pass mark: share given the right type (%)'],
      [secs, 'Guided steps: start and end within (seconds)'], [frac, 'Guided steps: or share of the artifact\'s length (%)'],
      [chans, 'Guided steps: channels the same (%)']]) input.setAttribute('aria-label', label);
    const save = actionButton('Save the settings', { kind: 'primary', working: 'Saving…', msg, log: 'set-update', onClick: async () => {
      const body = {
        set_id: s.set_id, name: name.value.trim(), description: description.value.trim(), practice_review: review.input.checked,
        allowed_annotators: allowed.values(),
        practice_pass: { event_f1: parseNumber(f1.value, 'Artifacts found', { min: 0, max: 100 }) / 100, label_accuracy: parseNumber(acc.value, 'Right type', { min: 0, max: 100 }) / 100 },
        guided_tolerance: { seconds: parseNumber(secs.value, 'Start and end within', { min: 0, max: 5 }), fraction: parseNumber(frac.value, 'Share of its length', { min: 0, max: 100 }) / 100,
          channel_jaccard: parseNumber(chans.value, 'Channels the same', { min: 1, max: 100 }) / 100 },
      };
      await this.area.write('set_update', body);
      await this.reload(['success', 'The set\'s settings are saved.']);
    } });
    const deleteHost = h('div.btn-row');
    deleteHost.append(h('button.btn.destructive', { type: 'button', onclick: async () => {
      if (!(await confirmInline(deleteHost, { text: `Delete the reference set ${s.set_id}, with its references and quiz? This cannot be undone.`, yes: 'Delete the set' }))) return;
      try {
        await this.area.write('set_delete', { set_id: s.set_id });
        this.setId = null;
        await this.reload();
        this.msg.show('success', `The reference set ${s.set_id} has been deleted.`);
      } catch (exc) { msg.problem(exc); }
    } }, 'Delete the set'));
    return h('div.admin-stack', {},
      card('About the set', field('Name', name), field('Description', description), review, allowed),
      card('Practice and guided matching',
        h('p.caption', {}, 'A practice recording is passed when the trainee finds enough of the experts\' artifacts and gives enough of them the right type.'),
        h('div.row.wrap.sentence', {}, h('span', {}, 'Pass mark: at least'), f1, h('span', {}, '% of the experts\' artifacts found, and'), acc, h('span', {}, '% of them given the right type.')),
        h('p.caption', {}, 'A guided step matches when the trainee\'s annotation starts and ends close enough to the experts\' and covers enough of the same channels.'),
        h('div.row.wrap.sentence', {}, h('span', {}, 'Start and end within'), secs, h('span', {}, 's or'), frac, h('span', {}, '% of its length; channels'), chans, h('span', {}, '% the same.'))),
      h('div.btn-row', {}, save), msg,
      card('Delete the set', h('p.caption', {}, 'A set that trainees are enrolled in, or have saved work in, stays.'), deleteHost));
  }

  // -------------------------------------------------------------- criteria
  _criteriaTab(s) {
    const msg = messageArea();
    const rows = criteriaRows(s.criteria);
    const controls = rows.map((r) => {
      const meta = METRICS[r.metric];
      const on = checkbox(meta.label, r.enabled, { hint: meta.description });
      const threshold = numberInput({ value: r.threshold, min: meta.range[0], max: meta.range[1], step: meta.range[1] <= 1 ? 0.05 : 0.5 });
      threshold.setAttribute('aria-label', `Threshold for ${meta.label}`);
      const scope = select(meta.overallOnly ? [['overall', 'overall']] : [['overall', 'overall'], ['each_category', 'in every assessed category']], r.scope);
      scope.setAttribute('aria-label', `Where ${meta.label} applies`);
      const sync = () => { threshold.disabled = !on.input.checked; scope.disabled = !on.input.checked || meta.overallOnly; };
      on.input.addEventListener('change', sync);
      sync();
      return { metric: r.metric, on, threshold, scope, el: h('div.criterion', {}, on, h('div.row', {}, h('span.op', { 'aria-hidden': 'true' }, meta.better === 'lower' ? '≤' : '≥'), threshold, scope), h('p.caption', {}, meta.description)) };
    });
    const minRef = numberInput({ value: (s.criteria && s.criteria.min_reference_events) ?? 3, min: 1, step: 1 });
    minRef.setAttribute('aria-label', 'Fewest reference events of a category');
    const save = actionButton('Save the criteria', { kind: 'primary', working: 'Saving…', msg, log: 'criteria-save', onClick: async () => {
      const criteria = criteriaFromRows(controls.map((c) => ({ metric: c.metric, enabled: c.on.input.checked, threshold: c.threshold.value, scope: c.scope.value })),
        Number(minRef.value), s.criteria ? s.criteria.categories : null);
      await this.area.write('set_update', { set_id: s.set_id, criteria });
      this.tab = 'criteria';
      await this.reload(['success', criteria.criteria.length ? `Saved ${plural(criteria.criteria.length, 'criterion', 'criteria')}.` : 'Saved: results are reported without a pass or fail decision.']);
    } });
    return card('Competency criteria',
      h('p.caption', {}, 'The research team sets the criteria for each reference set. Leave all unticked to report results without a pass or fail decision. ElectroClean suggests none: suitable thresholds depend on pilot data and on the experts\' own agreement.'),
      h('div.criteria', {}, controls.map((c) => c.el)),
      h('div.row.wrap.sentence', {}, h('span', {}, 'An artifact category is assessed only if the reference has at least'), minRef, h('span', {}, 'events of it.')),
      h('div.btn-row', {}, save), msg);
  }

  // ------------------------------------------------------------------ quiz
  _quizTab(s) {
    const msg = messageArea();
    const table = dataTable([
      { title: 'Item', render: (q) => h('b', {}, q.item_id) },
      { title: 'Recording', render: (q) => recordingName(q.recording_id) },
      { title: 'Segment', num: true, render: (q) => `${Number(q.start_s).toFixed(2)}–${Number(q.end_s).toFixed(2)} s` },
      { title: 'Answer', render: (q) => h('span', {}, q.correct_label, (q.accepted_labels || []).length ? h('span.caption.block', {}, `also ${q.accepted_labels.join(', ')}`) : null) },
      { title: 'Explanation', render: (q) => q.explanation || '–' },
      { title: '', cls: 'actions', render: (q) => {
        const host = h('span.inline-confirm');
        host.append(h('button.btn.small', { type: 'button', onclick: async () => {
          if (!(await confirmInline(host, { text: `Remove ${q.item_id}?`, yes: 'Remove', no: 'Keep' }))) return;
          try {
            await this.area.write('quiz_item_remove', { set_id: s.set_id, item_id: q.item_id });
            await this.reload(['success', `Removed the quiz item ${q.item_id}.`]);
          } catch (exc) { msg.problem(exc); }
        } }, 'Remove'));
        return host;
      } },
    ], [], { empty: 'No quiz items yet.', pageSize: 20, caption: 'Quiz items' });
    const note = loading();
    this.area.read('quiz_items', { set_id: s.set_id }).then((r) => { note.remove(); table.update(r.items || []); }).catch((exc) => { note.remove(); msg.problem(exc); });
    // a new item
    const recs = this.recordings.filter((r) => r.scope === `set:${s.set_id}` || r.scope === 'study');
    const recording = select(recs.map((r) => [r.recording_id, `${r.recording_id} (${scopeText(r.scope, this.sets)})`]));
    const itemId = textInput({ placeholder: 'optional, for example q01' });
    const start = numberInput({ min: 0, step: 0.1 });
    const end = numberInput({ min: 0, step: 0.1 });
    const context = numberInput({ value: 2, min: 0, max: 60, step: 0.5 });
    const labels = this.area.labels;
    const sections = [];
    for (const l of labels) {
      let g = sections[sections.length - 1];
      if (!g || g.group !== l.section) { g = { group: l.section || 'Other', options: [] }; sections.push(g); }
      g.options.push([l.label, `${l.label}${l.is_group ? ' (group)' : ''}`]);
    }
    const correct = select(sections, labels.some((l) => l.label === 'Eye-blink-artifact') ? 'Eye-blink-artifact' : '');
    const parentOf = (label) => (labels.find((l) => l.label === label) || {}).parent || null;
    const acceptGroup = checkbox('Also accept its group term');
    const syncGroup = () => {
      const p = parentOf(correct.value);
      acceptGroup.hidden = !p;
      acceptGroup.querySelector('span').textContent = p ? `Also accept its group term (${p})` : 'Also accept its group term';
    };
    correct.addEventListener('change', syncGroup);
    acceptGroup.input.checked = true;
    syncGroup();
    const others = checkList(labels.map((l) => ({ value: l.label, text: l.label })), { legend: 'Other answers to accept', name: 'accepted' });
    const explanation = textArea({ rows: 2, placeholder: 'shown after each answer when the quiz gives feedback' });
    const add = actionButton('Add the item', { kind: 'primary', working: 'Adding…', msg, log: 'quiz-add', onClick: async () => {
      if (!recording.value) throw new Error('Choose the recording the segment comes from.');
      const a = parseNumber(start.value, 'Start', { min: 0 });
      const b = parseNumber(end.value, 'End', { min: 0 });
      if (b <= a) throw new Error('The segment must end after it starts.');
      const accepted = [...new Set([...(acceptGroup.input.checked && parentOf(correct.value) ? [parentOf(correct.value)] : []), ...others.values()])].filter((x) => x !== correct.value);
      const body = { set_id: s.set_id, recording_id: recording.value, start_s: a, end_s: b, correct_label: correct.value, accepted_labels: accepted,
        explanation: explanation.value.trim(), context_s: parseNumber(context.value || '2', 'Context shown', { min: 0, max: 60 }) };
      if (itemId.value.trim()) body.item_id = itemId.value.trim();
      const r = await this.area.write('quiz_item_add', body);
      this.tab = 'quiz';
      await this.reload(['success', `Added the quiz item ${(r.item && r.item.item_id) || ''}.`]);
    } });
    return h('div.admin-stack', {},
      card('Quiz items', h('p.caption', {}, 'Short segments that annotators allowed to use the set classify: which artifact type is the main one in the shaded segment?'), note, table, msg),
      card('Add a quiz item',
        h('div.row.wrap', {}, field('Recording', recording), field('Item ID', itemId)),
        h('div.row.wrap', {}, field('Start (s)', start), field('End (s)', end), field('Context shown (s)', context, { hint: 'EEG shown before and after the segment.' })),
        field('Correct answer', correct), acceptGroup, others, field('Explanation', explanation),
        h('div.btn-row', {}, add)));
  }
}
