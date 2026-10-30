// The annotation lanes of the adjudication view (docs/web/admin.md, "Adjudication"): a strip above the
// EEG with one lane per version compared, named by its letter and the person who made it, on the
// viewer's own time axis (viewer.tToX), so that each annotator's marks sit side by side over the same
// stretch of EEG. The marks of the current conflict are drawn full, the others lighter; a click on a
// mark goes to its conflict (or, while choosing marks one by one, ticks it). T shows every lane, then
// each version alone (the EEG follows). Each letter has the colour it has in the panel and on the EEG.
// For two or more corrections, a last lane shows the original they corrected, outlined.
//
// The overlay of everyone's marks (overlay.js) uses the same lanes with a look of its own: `name(v)`
// gives a lane's name, `style(v, m)` each mark's colours and pattern, and `text(v, m)` the words on a
// mark where they fit (the person's ID).

import { h, clear } from '../ui/dom.js';
import { laneMarks } from './model.js';

export class Lanes {
  /**
   * @param {object} viewer the workspace's EegViewer
   * @param {{versions: object[], catalogue: object, colours?: object, original?: object|null, onPick?: Function}} o
   *   versions: [{letter, annotator_id, display_name, annotations}]; colours: letter -> colour; original: {annotator_id, annotations}
   */
  constructor(viewer, { versions, catalogue, colours = {}, original = null, onPick = null, name = null, style = null, text = null, className = '' }) {
    this.viewer = viewer;
    this.styleOf = style;
    this.textOf = text;
    this.versions = original ? [...versions, { letter: 'O', annotator_id: original.annotator_id, annotations: original.annotations, original: true }] : versions;
    this.catalogue = catalogue;
    this.onPick = onPick;
    this.conflicts = [];
    this.current = -1;
    this.picks = null;
    this.mode = null;
    this.rows = this.versions.map((v) => {
      const track = h('div.lane-track');
      const label = name ? name(v) : v.original
        ? h('span.lane-name', { title: `The original: ${v.annotator_id}'s version, which was corrected` }, h('b', {}, 'Original'))
        : h('span.lane-name', { title: `${v.letter}: ${v.annotator_id}${v.display_name ? ` (${v.display_name})` : ''}` },
          h('b', { style: { color: colours[v.letter] || null } }, v.letter), ` ${v.annotator_id}`);
      const row = h(`div.lane${v.original ? '.original' : ''}`, { 'data-letter': v.letter }, label, track);
      return { v, row, track };
    });
    this.el = h('div.lanes', { role: 'group', class: className || null, 'aria-label': 'Each version in its own lane' }, this.rows.map((r) => r.row));
    // The viewer lays itself out once it is on the page (and again when the window changes): follow it.
    if (typeof ResizeObserver !== 'undefined' && viewer.el) {
      this._ro = new ResizeObserver(() => requestAnimationFrame(() => this.draw()));
      this._ro.observe(viewer.el);
    }
  }

  destroy() { if (this._ro) this._ro.disconnect(); }

  /** The conflicts (to know which marks are the current one's) and the current index. */
  setConflicts(conflicts, current, picks = null) {
    this.conflicts = conflicts;
    this.current = current;
    this.picks = picks ? new Set(picks.map((p) => `${p.letter}-${p.annotation_id}`)) : null;
    this.draw();
  }

  /** null for every lane, or one letter alone. */
  setMode(mode) {
    this.mode = mode;
    for (const r of this.rows) r.row.classList.toggle('dimmed', Boolean(mode) && r.v.letter !== mode && !r.v.original);
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
      const original = Boolean(r.v.original);
      const cls = [m.current ? 'current' : '', this.picks && this.picks.has(m.id) ? 'picked' : ''].filter(Boolean).join(' ') || null;
      const b = h('button.lane-mark', { type: 'button', class: cls, tabindex: '-1', disabled: original || null,
        title: `${original ? 'Original' : m.letter}: ${m.label}, ${m.t0.toFixed(2)}–${m.t1.toFixed(2)} s`, 'data-id': m.id,
        style: { left: `${Math.round(xa)}px`, width: `${Math.max(2, Math.round(xb - xa))}px`, background: original ? 'transparent' : colour, borderColor: colour },
        onclick: () => this.onPick && !original && this.onPick(m.id) });
      if (this.styleOf) Object.assign(b.style, this.styleOf(r.v, m));
      const words = this.textOf ? this.textOf(r.v, m) : '';
      if (words && xb - xa >= words.length * 6.5 + 8) b.append(h('span.lane-words', {}, words));
      if (words) b.title = `${words}: ${m.label}, ${m.t0.toFixed(2)}–${m.t1.toFixed(2)} s`;
      r.track.append(b);
    }
  }
}
