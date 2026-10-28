// The review of a practice recording after it is saved: the trainee's annotations and the
// experts' side by side, the disagreements labelled on the EEG (MISSED, EXTRA, TYPE) and listed
// under "What to look at", which N and P step through (as guided_gui.add_review_flags).

import { h } from '../ui/dom.js';
import { safeFragment } from '../ui/sanitize.js';
import { logger } from '../log/logger.js';
import { COLOURS } from '../ui/theme.js';
import { DEMO_NOTICE } from '../api/notice.js';

export const FLAG_COLOURS = { MISSED: COLOURS.destructive, EXTRA: COLOURS.warning_text, TYPE: COLOURS.flag_type };

/** The review store's annotations: yours as "you-…" and the experts' as "ref-…". */
export function reviewAnnotations(mine, reference) {
  return [
    ...mine.map((a) => ({ ...a, annotation_id: `you-${a.annotation_id}` })),
    ...reference.map((a) => ({ ...a, annotation_id: `ref-${a.annotation_id}` })),
  ];
}

/** Each flag tied to an annotation of the review, with its text, prefix and colour. */
export function reviewFlags(feedback, mine, sfreq) {
  const byId = new Map(mine.map((a) => [a.annotation_id, a]));
  const span = (on, dur) => `${(on / sfreq).toFixed(2)}–${((on + dur) / sfreq).toFixed(2)} s`;
  return (feedback.flags || []).map((f) => {
    if (f.kind === 'MISSED') {
      return { kind: f.kind, region: `ref-${f.annotation_id}`, label: f.label, onset_s: f.onset_sample / sfreq,
        offset_s: (f.onset_sample + f.duration_samples) / sfreq, text: `Missed: ${f.label}, ${span(f.onset_sample, f.duration_samples)}`, prefix: 'MISSED · REF: ' };
    }
    if (f.kind === 'EXTRA') {
      return { kind: f.kind, region: `you-${f.annotation_id}`, label: f.label, onset_s: f.onset_sample / sfreq,
        offset_s: (f.onset_sample + f.duration_samples) / sfreq,
        text: `Extra: your ${f.label}, ${span(f.onset_sample, f.duration_samples)} (not in the experts' annotations)`, prefix: 'EXTRA · YOU: ' };
    }
    const yours = byId.get(f.annotation_id);
    const on = yours ? yours.onset_sample : f.onset_sample;
    const dur = yours ? yours.duration_samples : f.duration_samples;
    const label = f.your_label || (yours && yours.label) || '';
    return { kind: 'TYPE', region: `you-${f.annotation_id}`, label, should_be: f.label, onset_s: on / sfreq, offset_s: (on + dur) / sfreq,
      text: `Type: you chose ${label}; the experts chose ${f.label}, ${span(on, dur)}`,
      prefix: `TYPE: should be ${f.label.replace(/-artifact$/, '')} · YOU: ` };
  }).sort((a, b) => a.onset_s - b.onset_s);
}

export class PracticeReview {
  constructor(ws, { feedback, mine, backend, inProgramme = true }) {
    this.ws = ws;
    this.feedback = feedback;
    this.flags = reviewFlags(feedback, mine, ws.sf);
    this.backend = backend;
    this.inProgramme = inProgramme;
    this.row = -1;
    const prefix = {};
    const colours = {};
    for (const a of ws.store.annotations()) prefix[a.annotation_id] = a.annotation_id.startsWith('ref-') ? 'REF: ' : 'YOU: ';
    for (const f of this.flags) { prefix[f.region] = f.prefix; colours[f.region] = FLAG_COLOURS[f.kind]; }
    ws.prefix = prefix;
    ws.labelColours = colours;
    ws.viewer.setPrefix(prefix);
    ws.viewer.setLabelColours(colours);
    ws.review = this;
    this._build();
    ws._refreshList();
    logger.event('practice_review_opened', { recording: ws.s.recordingId, flags: this.flags.length, passed: feedback.passed });
  }

  _build() {
    const fb = this.feedback;
    const verdict = fb.passed
      ? h('p.verdict.passed', {}, h('b', {}, 'Passed:'), ` you reached the pass mark (${fb.pass_rule}).`)
      : h('p.verdict.not-yet', {}, h('b', {}, 'Not yet:'), ` you need ${fb.pass_rule}. Review what you missed in the viewer, then try the next practice recording or this one again.`);
    const summary = h('div.summary');
    summary.appendChild(safeFragment(fb.summary_html || ''));
    this.items = [];
    let list;
    if (this.flags.length) {
      list = h('ol.flag-list', { 'aria-label': 'What to look at' });
      this.flags.forEach((f, i) => {
        const li = h('li', { 'data-log': 'review-item', tabindex: '0', style: { color: FLAG_COLOURS[f.kind] }, onclick: () => this.go(i),
          onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.go(i); } } }, f.text);
        this.items.push(li);
        list.appendChild(li);
      });
    }
    this.el = h('section.review.card', { 'aria-label': 'Practice result' },
      h('h2', {}, 'Practice result'), verdict, summary,
      this.flags.length ? [h('h3', {}, `What to look at (${this.flags.length})`), h('p.caption', {}, 'Click an item, or press N and P, to go to it.'), list]
        : h('p.success', {}, '✓ Nothing missed, nothing extra and every type matches the experts.'),
      h('p.caption', {}, 'Your annotations are labelled YOU and the experts\' REF.'),
      this.backend.isDemo ? h('p.caption.demo-note', {}, DEMO_NOTICE) : null);
    this.ws.reviewHost.appendChild(this.el);
  }

  go(i) {
    if (i < 0 || i >= this.flags.length) return;
    const f = this.flags[i];
    this.row = i;
    this.items.forEach((li, k) => li.classList.toggle('current', k === i));
    this.items[i].scrollIntoView({ block: 'nearest' });
    if (this.ws.store.has(f.region)) this.ws.jumpTo(f.region);
    logger.event('review_item_jumped', { recording: this.ws.s.recordingId, flag: f.kind, label: f.label, onset_s: f.onset_s, offset_s: f.offset_s, item: i + 1 });
  }

  step(delta) {
    if (!this.flags.length) { this.ws.stepSelection(delta); return; }
    const row = this.row;
    const next = row >= 0 ? row + delta : delta > 0 ? 0 : this.flags.length - 1;
    this.go(Math.min(Math.max(0, next), this.flags.length - 1));
  }
}
