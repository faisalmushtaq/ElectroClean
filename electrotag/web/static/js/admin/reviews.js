// Reviews of saved work in the admin area (docs/web/admin.md, "Reviewing saved work"): the Review
// button on a saved study recording (in a person's Work and in Results), the number of reviews of
// each, a person's reviews, and every review of the study in Results with filters. Each review opens
// to show its marks and notes. The review itself happens in the annotation view
// (js/annotate/review_pass.js), with the EEG file opened from this computer.

import { h } from '../ui/dom.js';
import { whenText } from './model.js';
import { card, dataTable, recordingName, select } from './ui.js';

const MARK_TEXT = Object.freeze({ agree: 'Agree', caveat: 'Caveat', comment: 'Comment' });

/** "Review" for a saved study recording; `back` is the section to come back to ({route, params}). */
export function reviewButton(area, annotatorId, item, back) {
  if (item.status !== 'done' || (item.mode || 'standard') !== 'standard') return null;
  const ann = area.app.me && area.app.me.study && area.app.me.study.annotation;
  if (ann && ann.allow_reviews === false) return null;
  return h('button.btn.small', { type: 'button', 'data-log': 'review-start', 'data-review': item.recording_id,
    title: `Review ${annotatorId}'s saved annotations of this recording`,
    onclick: () => area.app.startReview({ annotator_id: annotatorId, recording_id: item.recording_id, back }) }, 'Review');
}

/** How many reviews a saved recording has (from reviews_list), or a dash. */
export function reviewCount(reviews, annotatorId, item) {
  const n = (reviews || []).filter((r) => r.annotator_id === annotatorId && r.recording_id === item.recording_id).length;
  return n ? String(n) : '–';
}

/** One item of a review in words: what was marked, where, and the reviewer's note. */
export function reviewItemText(it) {
  const where = Number.isFinite(Number(it.onset_s)) && Number.isFinite(Number(it.offset_s))
    ? `${Number(it.onset_s).toFixed(2)}–${Number(it.offset_s).toFixed(2)} s` : '';
  const what = it.annotation_id ? (it.label || 'An annotation') : 'A stretch without an annotation';
  return `${MARK_TEXT[it.status] || it.status}: ${what}${where ? `, ${where}` : ''}${it.note ? `. “${it.note}”` : ''}`;
}

/** A review's summary that opens to show each mark and note, and the overall note. */
export function reviewDetails(r) {
  const items = r.items || [];
  return h('details.review-details', { 'data-review-id': r.review_id || null },
    h('summary', {}, r.summary || 'no marks'),
    items.length ? h('ol.review-items', {}, items.map((it) => h(`li.mark-${it.status}`, {}, reviewItemText(it)))) : h('p.caption', {}, 'No annotation was marked.'),
    r.overall_note ? h('p', {}, h('b', {}, 'Overall: '), r.overall_note) : null);
}

const columns = (withPerson) => [
  { title: 'Reviewed', sort: (r) => r.reviewed_at, render: (r) => whenText(r.reviewed_at) },
  withPerson ? { title: 'Annotator', sort: (r) => r.annotator_id, render: (r) => h('b', {}, r.annotator_id) } : null,
  { title: 'Recording', sort: (r) => r.recording_id, render: (r) => recordingName(r.recording_id, r.file_name) },
  { title: 'Version', num: true, sort: (r) => r.attempt, render: (r) => String(r.attempt) },
  { title: 'By', sort: (r) => r.reviewer_id, render: (r) => r.reviewer_id },
  { title: 'Marks and notes', render: (r) => reviewDetails(r) },
].filter(Boolean);

/** A person's reviews, newest first; each opens to show its marks and notes. */
export function reviewsCard(reviews) {
  return card('Reviews of this person\'s work',
    h('p.caption', {}, 'Each review is kept as a record of its own, beside the annotations it is about, which stay as they were saved. The agreement analyses do not use reviews. Open a review to read its marks and notes.'),
    dataTable(columns(false), reviews, { empty: 'Nothing of this person\'s has been reviewed yet.', pageSize: 10, sortable: true, caption: 'Reviews' }));
}

/** The reviews a filter keeps ({annotator, reviewer, mark}: '' for any). */
export function filterReviews(rows, { annotator = '', reviewer = '', mark = '' } = {}) {
  return (rows || []).filter((r) => (!annotator || r.annotator_id === annotator) && (!reviewer || r.reviewer_id === reviewer)
    && (!mark || (r.items || []).some((it) => it.status === mark)));
}

/** Every review of the study, with filters by annotator, reviewer and mark (in Results). */
export function allReviewsCard() {
  const annotator = select([['', 'Every annotator']]);
  annotator.setAttribute('aria-label', 'Annotator reviewed');
  const reviewer = select([['', 'Every reviewer']]);
  reviewer.setAttribute('aria-label', 'Reviewer');
  const mark = select([['', 'Any mark'], ['caveat', 'With a caveat'], ['comment', 'With a comment'], ['agree', 'With an agreement']]);
  mark.setAttribute('aria-label', 'Mark');
  const note = h('p.caption', { role: 'status' });
  const table = dataTable(columns(true), [], { empty: 'No reviews match.', pageSize: 20, sortable: true, caption: 'Every review' });
  let rows = [];
  const draw = () => {
    const shown = filterReviews(rows, { annotator: annotator.value, reviewer: reviewer.value, mark: mark.value });
    note.textContent = rows.length ? `${shown.length} of ${rows.length} reviews.` : '';
    table.update(shown, { keepPage: true });
  };
  for (const f of [annotator, reviewer, mark]) f.addEventListener('change', draw);
  const fill = (sel, values, first) => {
    const keep = sel.value;
    sel.replaceChildren(h('option', { value: '' }, first), ...values.map((v) => h('option', { value: v }, v)));
    sel.value = values.includes(keep) ? keep : '';
  };
  const el = card('Reviews', h('p.caption', {}, 'Every review of saved work, newest first. Open one to read its marks and notes.'),
    h('div.row.filters', {}, annotator, reviewer, mark), note, table);
  el.update = (reviews) => {
    rows = reviews || [];
    fill(annotator, [...new Set(rows.map((r) => r.annotator_id))].sort(), 'Every annotator');
    fill(reviewer, [...new Set(rows.map((r) => r.reviewer_id))].sort(), 'Every reviewer');
    draw();
  };
  return el;
}
