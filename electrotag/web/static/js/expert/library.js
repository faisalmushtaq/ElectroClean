// The library of contradictory annotations (docs/web/admin.md, "Library"): every conflict between
// annotators, decided or not, from every adjudication and from what waits for one. Filters by artifact
// type, by confused pair (an eye blink against an eye movement), by kind of conflict, by status and
// decision, by annotator and by recording, and a search of the reasons. Each entry opens at its moment
// in the EEG (the file from this computer, checked against the study's copy) with every version and
// the decision; the filtered list downloads as TSV or JSON; an entry becomes a quiz item or an
// artifact snippet of a reference set, keeping where it came from. The study derives the library
// afresh each time (electrotag/web/library.py); nothing here is kept apart from what is promoted.

import { h, clear } from '../ui/dom.js';
import { showDialog } from '../ui/dialog.js';
import { logger } from '../log/logger.js';
import { newId } from '../util.js';
import { card, chip, dataTable, downloadText, field, loading, messageArea, recordingName, sectionHead, select, textArea, textInput, numberInput } from '../admin/ui.js';
import { KIND_TEXT, REASON_TEXT, STATUS_TEXT, decisionText, filterKeys, libraryJson, libraryQuery, libraryTsv, promoteDefaults, spanText } from './model.js';
import { startAdjudication } from './adjudicate.js';

const STATUS_KIND = { awaiting: '', open: 'warning', decided: 'done' };
const CHOICE_TEXT = { one: 'Kept one version', all: 'Kept all', none: 'Kept neither', edited: 'Edited' };

export class LibrarySection {
  constructor(area) {
    this.area = area;
    this.msg = messageArea();
    this.answer = null;
    this.f = {};
    const any = (text) => [['', text]];
    this.fields = {
      label: select(any('Every type')), pair: select(any('Every pair')), kind: select(any('Every kind')), status: select(any('Any status')),
      choice: select(any('Any decision')), annotator_id: select(any('Every annotator')), recording_id: select(any('Every recording')),
      q: textInput({ placeholder: 'Search the reasons' }),
    };
    const names = { label: 'Artifact type', pair: 'Confused pair', kind: 'Kind of conflict', status: 'Status', choice: 'Decision', annotator_id: 'Annotator',
      recording_id: 'Recording', q: 'Search the reasons' };
    for (const [k, el] of Object.entries(this.fields)) {
      el.setAttribute('aria-label', names[k]);
      el.dataset.filter = k;
      el.addEventListener(k === 'q' ? 'input' : 'change', () => this._changed(k));
    }
    this.count = h('p.caption', { role: 'status' });
    this.table = dataTable(this._columns(), [], { empty: 'No conflict matches these filters.', pageSize: 20, sortable: true, caption: 'Library of conflicts',
      rowKey: (e) => e.entry_id });
    this.tsvBtn = h('button.btn.small', { type: 'button', 'data-log': 'library-tsv', onclick: () => this._download('tsv') }, 'Download TSV');
    this.jsonBtn = h('button.btn.small', { type: 'button', 'data-log': 'library-json', onclick: () => this._download('json') }, 'Download JSON');
    this.body = h('div.admin-stack', {}, loading());
    this.el = h('section.admin-section', { 'data-section': 'library' },
      sectionHead('Library', 'Every conflict between annotators, decided or not, from the adjudications and from what waits for one: where people disagree, '
        + 'which types they confuse, and how the disagreements were settled. Open an entry at its moment in the EEG, download the list, '
        + 'or make an entry a quiz item or an artifact snippet for training.'),
      this.msg, this.body);
  }

  _columns() {
    return [
      { title: 'Where', sort: (e) => `${e.recording_id} ${String(e.onset_s).padStart(12, '0')}`, render: (e) => h('span', {},
        recordingName(e.recording_id, e.file_name), h('span.caption.block', {}, spanText(e.onset_s, e.offset_s))) },
      { title: 'Conflict', sort: (e) => (e.kinds || []).join(','), render: (e) => h('span.adj-kinds', {},
        (e.kinds || []).map((k) => h('span.chip.adj-kind', { 'data-kind': k }, KIND_TEXT[k] || k))) },
      { title: 'Types', sort: (e) => (e.labels || []).join(','), render: (e) => h('span', {}, (e.labels || []).join(' against ')) },
      { title: 'Annotators', render: (e) => h('span', {}, [...new Set(e.marks.map((m) => m.annotator_id))].join(', '),
        (e.missing_ids || []).length ? h('span.caption.block', {}, `No mark: ${e.missing_ids.join(', ')}`) : null) },
      { title: 'Decision', sort: (e) => e.status, render: (e) => {
        const d = e.decision;
        const people = Object.fromEntries(Object.entries(e.letters || {}).map(([p, x]) => [x, p]));
        return h('span', {}, chip(STATUS_TEXT[e.status] || e.status, STATUS_KIND[e.status] || ''),
          d ? h('span.caption.block', {}, `${decisionText(d, people)}${d.reason_code ? `: ${REASON_TEXT[d.reason_code] || d.reason_code}` : ''}`) : null,
          d && d.reason ? h('span.caption.block.adj-reason-text', {}, `“${d.reason}”`) : null);
      } },
      { title: '', render: (e) => h('span.btn-row.tight', {},
        h('button.btn.small', { type: 'button', 'data-log': 'library-open', 'data-entry': e.entry_id, onclick: () => this._open(e) }, 'Open at this moment'),
        h('button.btn.small', { type: 'button', 'data-log': 'library-promote', 'data-entry': e.entry_id, onclick: () => this.promote(e) }, 'Promote…')) },
    ];
  }

  _query() {
    const f = {};
    for (const [k, el] of Object.entries(this.fields)) f[k] = el.value;
    return libraryQuery(f);
  }

  _changed(key) {
    clearTimeout(this._typing);
    const run = () => this._load({ quietly: true });
    if (key === 'q') this._typing = setTimeout(run, 300);
    else run();
  }

  async show() {
    this.msg.clear();
    if (!this.answer) { clear(this.body); this.body.append(loading()); }
    await this._load({ quietly: false });
  }

  async _load({ quietly }) {
    const q = this._query();
    let got;
    try {
      got = await this.area.read('library_list', { ...q, limit: 500 });
    } catch (exc) {
      if (!quietly) clear(this.body);
      this.msg.problem(exc);
      return;
    }
    if (JSON.stringify(q) !== JSON.stringify(this._query())) return; // the filters changed meanwhile: a newer answer follows
    this.answer = got;
    this.f = q;
    if (quietly) logger.event('library_filtered', { keys: filterKeys(q), shown: got.total });
    this._fillFilters(got.facets || {});
    if (!this.body.contains(this.table)) {
      clear(this.body);
      const filters = h('div.row.filters.library-filters', {}, Object.values(this.fields));
      this.body.append(card('', filters, this.count, this.table, h('div.btn-row', {}, this.tsvBtn, this.jsonBtn),
        h('p.caption', {}, 'The study derives the library from the adjudications each time, so it always shows the decisions as they stand. The results zip holds the whole library as library/library.tsv.')));
    }
    const all = Object.values(got.facets?.status || {}).reduce((a, b) => a + b, 0);
    this.count.textContent = all ? `${got.total} of ${all} conflict${all === 1 ? '' : 's'}${got.total > got.entries.length ? ` (the first ${got.entries.length} shown)` : ''}.`
      : 'No conflicts yet. Conflicts appear here once two or more people have saved the same recording and their versions disagree.';
    this.table.update(got.entries || []);
  }

  _fillFilters(facets) {
    const fill = (key, values, first, words = (v) => v) => {
      const el = this.fields[key];
      const keep = el.value;
      el.replaceChildren(h('option', { value: '' }, first), ...values.map(([v, n]) => h('option', { value: v }, `${words(v)} (${n})`)));
      el.value = values.some(([v]) => v === keep) ? keep : '';
    };
    const of = (k) => Object.entries(facets[k] || {});
    fill('label', of('labels'), 'Every type');
    fill('pair', of('pairs'), 'Every pair', (v) => v.replace(' | ', ' against '));
    fill('kind', of('kinds'), 'Every kind', (v) => KIND_TEXT[v] || v);
    fill('status', of('status'), 'Any status', (v) => STATUS_TEXT[v] || v);
    fill('choice', of('choices'), 'Any decision', (v) => CHOICE_TEXT[v] || v);
    fill('annotator_id', of('annotators'), 'Every annotator');
    fill('recording_id', of('recordings'), 'Every recording', (v) => v.split('/').pop());
  }

  _download(kind) {
    const rows = this.table.rows();
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === 'tsv') downloadText(`electrotag_library_${stamp}.tsv`, libraryTsv(rows), 'text/tab-separated-values;charset=utf-8');
    else downloadText(`electrotag_library_${stamp}.json`, libraryJson(rows, this.f), 'application/json');
    logger.event('library_downloaded', { kind, n: rows.length });
  }

  _open(e) {
    logger.event('library_opened_entry', { status: e.status, kinds: e.kinds });
    return startAdjudication(this.area.app, { unitId: e.unit_id, mode: 'view', focus: e.conflict_id, msg: this.msg,
      back: () => this.area.app.showExpert('expert-library') });
  }

  /** Make an entry a quiz item or a snippet: a dialog with the set, the label, the explanation and the times. */
  async promote(e) {
    const sets = (this.answer && this.answer.sets) || [];
    if (!sets.length) { this.msg.show('note', 'There is no reference set to add it to yet. An administrator makes reference sets in Training.'); return null; }
    const dflt = promoteDefaults(e);
    const to = select([['quiz_item', 'A quiz item (name the type)'], ['snippet', 'An artifact snippet (shown to trainees)']], 'quiz_item');
    const set = select(sets.map((s) => [s.set_id, s.name === s.set_id ? s.set_id : `${s.name} (${s.set_id})`]), sets[0].set_id);
    const label = select(this.area.app.catalogue.labelNames.map((n) => [n, n]), dflt.label);
    const explanation = textArea({ value: dflt.explanation, rows: 3 });
    const start = numberInput({ value: dflt.start_s, min: 0, step: '0.01' });
    const end = numberInput({ value: dflt.end_s, min: 0, step: '0.01' });
    const msg = messageArea();
    const body = h('div.admin-stack.promote-form', {},
      h('p.dialog-text', {}, `${(e.kinds || []).map((k) => KIND_TEXT[k] || k).join(', ')} in ${e.file_name}, ${spanText(e.onset_s, e.offset_s)}. `
        + (dflt.decided ? 'The type and times start from the decision.' : 'It is not decided yet, so choose the type yourself.')),
      field('Make it', to), field('In the reference set', set), field('Type', label),
      h('div.row', {}, field('From (s)', start), field('To (s)', end)),
      field('Explanation', explanation, { hint: 'Shown with the item or snippet; it starts from the adjudicator\'s reason.' }), msg);
    const promoteId = newId();
    let made = null;
    const send = async () => {
      try {
        const r = await this.area.write('library_promote', { promote_id: promoteId, entry_id: e.entry_id, to: to.value, set_id: set.value, label: label.value,
          explanation: explanation.value, start_s: Number(start.value), end_s: Number(end.value) });
        made = r;
        logger.event('library_promoted', { to: to.value, already: Boolean(r.already), explanation_length: explanation.value.trim().length });
        return true;
      } catch (exc) {
        msg.problem(exc);
        return false;
      }
    };
    for (;;) {
      const go = await showDialog({ title: 'Promote this conflict', body, wide: true, className: 'promote-dialog', logText: 'promote a library entry',
        buttons: [{ label: 'Cancel', value: false }, { label: 'Promote', value: true, kind: 'primary' }], cancelValue: false });
      if (!go) return null;
      if (await send()) break;
    }
    const item = made.item || made.snippet;
    const what = made.item ? `quiz item ${item.item_id}` : `snippet ${item.snippet_id}`;
    this.msg.show('success', made.already ? `This entry is already ${what} of ${set.value}.` : `Added as ${what} of ${set.value}, with a note of the conflict it came from.`);
    return made;
  }
}
