// Saved work, a section of the expert area (docs/web/admin.md, "Saved work"): every saved study
// attempt, the latest of each person and recording, filtered by person, recording and whether it was
// corrected. Each row offers Correct (js/expert/correction_pass.js) and Replay (js/replay/player.js),
// with the number of corrections it has. Both open the EEG file from this computer, checked against
// the study's copy, because the EEG never reaches the study.

import { h, clear } from '../ui/dom.js';
import { inform } from '../ui/dialog.js';
import { whenText } from '../admin/model.js';
import { card, chip, dataTable, loading, messageArea, recordingName, sectionHead, select } from '../admin/ui.js';

/**
 * An expert corrects someone's saved attempt: the attempt is read, then its EEG file is opened from this
 * computer (purpose correct). `back` is where the correction returns to ({route, params}).
 */
export async function startCorrection(app, { annotator_id: aid, recording_id: rid, attempt = null }, back = { route: 'expert-work', params: null }) {
  let target;
  try {
    target = await app.backend.expert('saved_attempt_get', { annotator_id: aid, recording_id: rid, ...(attempt ? { attempt } : {}) });
  } catch (exc) {
    if (exc.status !== 401) await inform('The correction cannot start', exc.message);
    return null;
  }
  if (target.own) { await inform('Your own work', 'This is your own saved work. To change it, revise it from your history on the home page; corrections are for other people\'s work.'); return null; }
  if (target.corrections_on === false) { await inform('Corrections are switched off', 'This study does not take corrections of saved work. The study team can switch them on in the study settings.'); return null; }
  const m = target.manifest || {};
  return app.openFromComputer({ recording_id: rid, file_name: target.file_name, format: m.format }, { purpose: { kind: 'correct', route: 'expert-correct', target, back,
    onBack: () => app.showExpert(back.route, back.params),
    title: `Correct ${target.file_name}`,
    note: `${aid}${target.display_name ? ` (${target.display_name})` : ''} saved version ${target.attempt}. Open the recording from this computer: its fingerprint is checked against the study's copy, then the saved annotations open for you to change and add to, with the original beside them.` } });
}

/**
 * A replay of how someone worked on a recording: the record of their sessions is read, then the EEG file is
 * opened from this computer (purpose replay). Without `back` (a trainee watching an expert) it returns home.
 */
export async function startReplay(app, { annotator_id: aid, recording_id: rid, attempt = null }, back = null) {
  let target;
  try {
    target = await app.backend.expert('replay_index_get', { annotator_id: aid, recording_id: rid, ...(attempt ? { attempt } : {}) });
  } catch (exc) {
    if (exc.status !== 401) await inform('The replay cannot start', exc.message);
    return null;
  }
  const m = target.manifest || {};
  const n = (target.segments || []).length;
  return app.openFromComputer({ recording_id: rid, file_name: target.file_name, format: m.format }, { purpose: { kind: 'replay', route: back ? 'expert-replay' : 'open', target, back,
    onBack: back ? () => app.showExpert(back.route, back.params) : null,
    title: `Replay ${target.file_name}`,
    note: `${n ? `${n} session${n === 1 ? '' : 's'} of ${aid}${target.display_name ? ` (${target.display_name})` : ''} on this recording ${n === 1 ? 'is' : 'are'} in the record.` : `The record holds no session of ${aid} on this recording; the saved version is shown.`} `
      + 'Open the recording from this computer: its fingerprint is checked against the study\'s copy, then the session plays back on the EEG.' } });
}

export class SavedWork {
  constructor(area) {
    this.area = area;
    this.msg = messageArea();
    this.filters = { annotator_id: '', recording_id: '', corrected: '' };
    this.filterRow = h('div.row.filters.work-filters');
    this.host = h('div.admin-stack');
    this.el = h('section.admin-section', { 'data-section': 'work' },
      sectionHead('Saved work', 'Every saved study recording, the latest version of each person\'s work. Correct it to save a new version credited to you, with a reason for each change, '
        + 'or replay how the session went. The original is never changed.'),
      this.msg, this.filterRow, this.host);
  }

  async show(params = {}) {
    this.msg.clear();
    if (params && typeof params === 'object') {
      for (const k of Object.keys(this.filters)) if (params[k] !== undefined) this.filters[k] = String(params[k] ?? '');
    }
    clear(this.host);
    this.host.append(loading());
    let all;
    try {
      all = await this.area.read('work_list', { limit: 1000 });
    } catch (exc) {
      clear(this.host);
      this.msg.problem(exc);
      return;
    }
    this.all = all.items || [];
    this._filters();
    this._draw(all);
  }

  _filters() {
    clear(this.filterRow);
    const people = [...new Map(this.all.map((i) => [i.annotator_id, i.display_name])).entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const recordings = [...new Map(this.all.map((i) => [i.recording_id, i.file_name])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const person = select([['', 'Everyone'], ...people.map(([a, n]) => [a, n ? `${a} (${n})` : a])], this.filters.annotator_id);
    const rec = select([['', 'Every recording'], ...recordings.map(([r, f]) => [r, f || r])], this.filters.recording_id);
    const corrected = select([['', 'Corrected or not'], ['no', 'Not corrected yet'], ['yes', 'Corrected']], this.filters.corrected);
    for (const [el, key, label] of [[person, 'annotator_id', 'Person'], [rec, 'recording_id', 'Recording'], [corrected, 'corrected', 'Corrections']]) {
      el.setAttribute('aria-label', label);
      el.dataset.log = `work-filter-${key}`;
      el.addEventListener('change', () => { this.filters[key] = el.value; this._draw(); });
    }
    this.filterRow.append(person, rec, corrected);
  }

  _rows() {
    const f = this.filters;
    return this.all.filter((i) => (!f.annotator_id || i.annotator_id === f.annotator_id) && (!f.recording_id || i.recording_id === f.recording_id)
      && (!f.corrected || (f.corrected === 'yes') === (i.corrections > 0)));
  }

  _draw(answer = null) {
    clear(this.host);
    const app = this.area.app;
    const back = { route: 'expert-work', params: { ...this.filters } };
    const off = answer && answer.corrections_on === false;
    const columns = [
      { title: 'Person', sort: (r) => r.annotator_id, render: (r) => h('span', {}, h('b', {}, r.annotator_id), r.own ? ' (you)' : '', r.display_name ? h('span.caption.block', {}, r.display_name) : null) },
      { title: 'Recording', sort: (r) => r.file_name, render: (r) => recordingName(r.recording_id, r.file_name) },
      { title: 'Version', num: true, sort: (r) => r.attempt, render: (r) => String(r.attempt) },
      { title: 'Saved', sort: (r) => r.saved_at || '', render: (r) => whenText(r.saved_at) },
      { title: 'Annotations', num: true, sort: (r) => r.n_annotations ?? -1, render: (r) => (r.n_annotations ?? 'n/a').toString() },
      { title: 'Corrections', sort: (r) => r.corrections, render: (r) => (r.corrections ? chip(`${r.corrections} correction${r.corrections === 1 ? '' : 's'}`, r.corrections > 1 ? 'warning' : 'done') : '–') },
      { title: '', render: (r) => h('span.row-actions', {},
        h('button.btn.small', { type: 'button', 'data-log': 'work-correct', 'data-work': `${r.annotator_id}|${r.recording_id}`, disabled: r.own || off,
          title: r.own ? 'Your own work: revise it from your history on the home page' : off ? 'This study does not take corrections' : `Correct ${r.annotator_id}'s version ${r.attempt}`,
          onclick: () => startCorrection(app, r, back) }, 'Correct'),
        h('button.btn.small', { type: 'button', 'data-log': 'work-replay', 'data-work': `${r.annotator_id}|${r.recording_id}`,
          title: `Replay how ${r.annotator_id} worked on this recording`, onclick: () => startReplay(app, r, back) }, 'Replay')) },
    ];
    const rows = this._rows();
    this.host.append(card(null,
      h('p.caption', {}, `${rows.length} of ${this.all.length} saved recording${this.all.length === 1 ? '' : 's'}. Two corrections of one version are compared, and their disagreements adjudicated.`),
      off ? h('p.note', {}, 'This study does not take corrections at the moment; replays can still be watched.') : null,
      dataTable(columns, rows, { empty: this.all.length ? 'No saved work matches these filters.' : 'Nobody has saved a study recording yet.', pageSize: 25, sortable: true,
        caption: 'Saved work', rowKey: (r) => `${r.annotator_id}|${r.recording_id}` })));
  }
}
