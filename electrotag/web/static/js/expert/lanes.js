// The annotation lanes of the adjudication view (docs/web/admin.md, "Adjudication"): a strip above the
// EEG with one lane per version compared, named by its letter and the person who made it, on the
// viewer's own time axis (viewer.tToX), so that each annotator's marks sit side by side over the same
// stretch of EEG. The marks of the current conflict are drawn full, the others lighter; a click on a
// mark goes to its conflict. T shows every lane, then each version alone (the EEG follows).

import { h, clear } from '../ui/dom.js';
import { laneMarks } from './model.js';

export class Lanes {
  /**
   * @param {object} viewer the workspace's EegViewer
   * @param {{versions: object[], catalogue: object, onPick?: Function}} o versions: [{letter, annotator_id, display_name, annotations}]
   */
  constructor(viewer, { versions, catalogue, onPick = null }) {
    this.viewer = viewer;
    this.versions = versions;
    this.catalogue = catalogue;
    this.onPick = onPick;
    this.conflicts = [];
    this.current = -1;
    this.mode = null;
    this.rows = versions.map((v) => {
      const track = h('div.lane-track');
      const name = h('span.lane-name', { title: `${v.letter}: ${v.annotator_id}${v.display_name ? ` (${v.display_name})` : ''}` },
        h('b', {}, v.letter), ` ${v.annotator_id}`);
      const row = h('div.lane', { 'data-letter': v.letter }, name, track);
      return { v, row, track };
    });
    this.el = h('div.lanes', { role: 'group', 'aria-label': 'Each version in its own lane' }, this.rows.map((r) => r.row));
    // The viewer lays itself out once it is on the page (and again when the window changes): follow it.
    if (typeof ResizeObserver !== 'undefined' && viewer.el) {
      this._ro = new ResizeObserver(() => requestAnimationFrame(() => this.draw()));
      this._ro.observe(viewer.el);
    }
  }

  destroy() { if (this._ro) this._ro.disconnect(); }

  /** The conflicts (to know which marks are the current one's) and the current index. */
  setConflicts(conflicts, current) {
    this.conflicts = conflicts;
    this.current = current;
    this.draw();
  }

  /** null for every lane, or one letter alone. */
  setMode(mode) {
    this.mode = mode;
    for (const r of this.rows) r.row.classList.toggle('dimmed', Boolean(mode) && r.v.letter !== mode);
    this.draw();
  }

  draw() {
    const v = this.viewer;
    if (!v || !v.view) return;
    const t0 = v.view.startS;
    const t1 = t0 + v.view.durationS;
    const marks = laneMarks(this.versions, this.conflicts, this.current, t0, t1, v.sfreq);
    const left = v.x0;
    for (const r of this.rows) {
      clear(r.track);
      r.track.style.marginLeft = `${Math.round(left)}px`;
      r.track.style.width = `${Math.max(0, Math.round(v.plotW))}px`;
    }
    for (const m of marks) {
      const r = this.rows[m.row];
      const xa = Math.max(0, v.tToX(m.t0) - left);
      const xb = Math.min(v.plotW, v.tToX(m.t1) - left);
      if (xb <= xa) continue;
      const colour = this.catalogue.get(m.label)?.colour || null;
      const b = h('button.lane-mark', { type: 'button', class: m.current ? 'current' : null, tabindex: '-1',
        title: `${m.letter}: ${m.label}, ${m.t0.toFixed(2)}–${m.t1.toFixed(2)} s`, 'data-id': m.id,
        style: { left: `${Math.round(xa)}px`, width: `${Math.max(2, Math.round(xb - xa))}px`, background: colour, borderColor: colour },
        onclick: () => this.onPick && this.onPick(m.id) });
      r.track.append(b);
    }
  }
}
