// The review of a practice recording after it is saved: the trainee's annotations and the
// experts' side by side, the disagreements labelled on the EEG (Missed, Extra, Should be …) and
// listed under "What to look at", which N and P step through. The verdict and the score's summary
// come first, in plain words, and the figures behind the score are behind a disclosure. The flags
// and the words come from the study's practice feedback (electrotag/web/coach.py with
// electrotag/training/review.py and programme.py on the server, scoring.js in the demonstration).

import { h } from '../ui/dom.js';
import { SCORE_EXPLAINED, percent } from './scoring.js';
import { logger } from '../log/logger.js';
import { COLOURS } from '../ui/theme.js';
import { DEMO_NOTICE } from '../api/notice.js';

/** The labels' prefixes on the EEG: the experts' annotations and yours (short, so that neighbours fit). */
export const REF_PREFIX = 'Experts: ';
export const YOU_PREFIX = 'You: ';

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
        offset_s: (f.onset_sample + f.duration_samples) / sfreq, text: `Missed: ${f.label}, ${span(f.onset_sample, f.duration_samples)}`, prefix: 'Missed: ' };
    }
    if (f.kind === 'EXTRA') {
      return { kind: f.kind, region: `you-${f.annotation_id}`, label: f.label, onset_s: f.onset_sample / sfreq,
        offset_s: (f.onset_sample + f.duration_samples) / sfreq,
        text: `Extra: your ${f.label}, ${span(f.onset_sample, f.duration_samples)} (not in the experts' annotations)`, prefix: 'Extra: ' };
    }
    const yours = byId.get(f.annotation_id);
    const on = yours ? yours.onset_sample : f.onset_sample;
    const dur = yours ? yours.duration_samples : f.duration_samples;
    const label = f.your_label || (yours && yours.label) || '';
    return { kind: 'TYPE', region: `you-${f.annotation_id}`, label, should_be: f.label, onset_s: on / sfreq, offset_s: (on + dur) / sfreq,
      text: `Type: you chose ${label}; the experts chose ${f.label}, ${span(on, dur)}`,
      prefix: `Should be ${f.label.replace(/-artifact$/, '')}: ` };
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
    for (const a of ws.store.annotations()) prefix[a.annotation_id] = a.annotation_id.startsWith('ref-') ? REF_PREFIX : YOU_PREFIX;
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
    // the same plain words from the study and the demonstration (programme.py, scoring.js)
    const [head, ...rest] = String(fb.verdict || (fb.passed ? 'Passed.' : 'Not yet.')).split(': ');
    const verdict = h(`p.verdict.${fb.passed ? 'passed' : 'not-yet'}`, {}, h('b', {}, rest.length ? `${head}:` : head), rest.length ? ` ${rest.join(': ')}` : '');
    const score = fb.score || {};
    const summary = h('div.summary', {},
      h('p.review-score', {}, h('b', {}, `Your score: ${percent(score.event_f1 || 0)}.`), fb.summary ? ` ${fb.summary}` : ''),
      h('p.caption', {}, SCORE_EXPLAINED));
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
        : fb.review === false ? null : h('p.success', {}, 'Nothing missed, nothing extra and every type matches the experts.'),
      h('p.caption', {}, `On the EEG your annotations are labelled ${YOU_PREFIX.replace(/:\s*$/, '')} and the experts' annotations ${REF_PREFIX.replace(/:\s*$/, '')}.`),
      this._details(),
      this.backend.isDemo ? h('p.caption.demo-note', {}, DEMO_NOTICE) : null);
    this.ws.reviewHost.appendChild(this.el);
  }

  /** The figures behind the score, for those who want them (closed at first). */
  _details() {
    const fb = this.feedback;
    const m = fb.metrics || {};
    const c = fb.counts || {};
    const pc = (v) => (v === null || v === undefined || Number.isNaN(v) ? 'not defined' : percent(v));
    const rows = [
      ['Score (event F1)', pc((fb.score || {}).event_f1)],
      ["The experts' artifacts you found with their type (sensitivity)", pc(m.event_recall)],
      ["Your marks that match one of theirs, type and all (precision)", pc(m.event_precision)],
      ['The right type, of the artifacts you found', pc((fb.score || {}).label_accuracy)],
      ["The experts' artifacts", String(c.reference_events ?? '')],
      ['Your marks', String(c.your_events ?? '')],
      ['Missed', String((c.reference_events ?? 0) - (c.found ?? 0))],
      ['Extra marks', String(c.extra ?? '')],
      ['Found with another type', String(c.other_type ?? '')],
    ];
    return h('details.review-details', { 'data-log': 'review-details' }, h('summary', {}, 'The figures behind the score'),
      h('table.review-figures', {}, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, k), h('td.num', {}, v))))),
      h('p.caption', {}, "The score counts an artifact as found when your mark overlaps the experts' enough in time and has " +
        `the same type.${fb.pass_rule ? ` To pass, you need ${fb.pass_rule}.` : ''}`));
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
