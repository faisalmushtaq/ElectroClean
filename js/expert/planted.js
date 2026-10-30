// Correct the marks, in the expert area (docs/web/admin.md, "Correct the marks"): every reference set's
// guided recordings, each with its exercise (a copy of the experts' marks with deliberate mistakes that
// trainees put right), to make, look at, try, make again or remove (js/admin/planted.js). Experts supply
// training material, so they reach this as administrators do.

import { h, clear } from '../ui/dom.js';
import { card, chip, loading, messageArea, recordingName, sectionHead } from '../admin/ui.js';
import { madeText, plantedPanel, startPlantedTry } from '../admin/planted.js';

export class PlantedSection {
  constructor(area) {
    this.area = area;
    this.msg = messageArea();
    this.body = h('div.admin-stack', {}, loading());
    this.detail = h('div.admin-stack');
    this.el = h('section.admin-section', { 'data-section': 'planted' },
      sectionHead('Correct the marks', 'An exercise for trainees in Learn with the experts: a copy of the experts\' marks for a guided recording, with '
        + 'deliberate mistakes to put right. Make one for a recording, try it as a trainee would, then give it to trainees in Training '
        + '(How much help the guided recording gives: Correct the marks).'),
      this.msg, this.body, this.detail);
  }

  async show(params) {
    clear(this.detail);
    const sets = await this._list();
    const want = sets && params && params.recording && sets.flatMap((s) => s.recordings.map((r) => [s, r])).find(([, r]) => r.recording_id === params.recording);
    if (want) this._open(want[0], want[1]);
  }

  /** The sets and their guided recordings (again after a change), the open recording left as it is. */
  async _list() {
    this.msg.clear();
    clear(this.body);
    this.body.append(loading());
    let got;
    try {
      got = await this.area.read('planted_list', {});
    } catch (exc) {
      clear(this.body);
      this.msg.problem(exc);
      return null;
    }
    clear(this.body);
    const sets = got.sets || [];
    if (!sets.length) {
      this.body.append(card(null, h('p.caption', {}, 'No reference set has a recording for learning with the experts yet. Add one in Training first.')));
      return sets;
    }
    for (const s of sets) {
      const list = h('ul.planted-recordings');
      for (const r of s.recordings) {
        const state = r.planted ? (r.planted.stale ? chip('Made before the reference changed', 'warning') : chip(`${r.planted.n_errors} mistakes`, 'done')) : chip('No exercise');
        list.append(h('li.planted-row', { 'data-recording': r.recording_id },
          h('span', {}, recordingName(r.recording_id), h('span.caption.block', {}, r.planted ? madeText(r.planted) : `${r.n_reference} marks in the reference`)),
          state,
          h('button.btn.small', { type: 'button', 'data-log': 'planted-open', onclick: () => this._open(s, r) }, r.planted ? 'Open' : 'Make one')));
      }
      this.body.append(card(s.name || s.set_id, list));
    }
    return sets;
  }

  _open(s, r) {
    clear(this.detail);
    const api = { read: (op, b) => this.area.read(op, b), write: (op, b) => this.area.write(op, b) };
    const panel = plantedPanel({ api, setId: s.set_id, recordingId: r.recording_id,
      onTry: (target) => startPlantedTry(this.area.app, target, { route: 'expert-planted', params: { recording: r.recording_id } }),
      onChanged: () => this._list() });
    const c = card(null, h('div.card-head', {}, h('h3', {}, recordingName(r.recording_id)),
      h('button.btn.quiet', { type: 'button', onclick: () => clear(this.detail) }, 'Close')), panel);
    this.detail.append(c);
    const head = c.querySelector('h3');
    head.tabIndex = -1;
    head.focus({ preventScroll: false });
  }
}
