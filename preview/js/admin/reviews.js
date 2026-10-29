// Reviews of saved work in the admin area (docs/web/admin.md, "Reviewing saved work"): the Review
// button on a saved study recording (in a person's Work and in Results), the number of reviews of
// each, and the list of a person's reviews. The review itself happens in the annotation view
// (js/annotate/review_pass.js), with the EEG file opened from this computer.

import { h } from '../ui/dom.js';
import { whenText } from './model.js';
import { card, dataTable, recordingName } from './ui.js';

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

/** A person's reviews, newest first. */
export function reviewsCard(reviews) {
  return card('Reviews of this person\'s work',
    h('p.caption', {}, 'Each review is kept as a record of its own, beside the annotations it is about, which stay as they were saved. The agreement analyses do not use reviews.'),
    dataTable([
      { title: 'Reviewed', sort: (r) => r.reviewed_at, render: (r) => whenText(r.reviewed_at) },
      { title: 'Recording', sort: (r) => r.recording_id, render: (r) => recordingName(r.recording_id, r.file_name) },
      { title: 'Version', num: true, sort: (r) => r.attempt, render: (r) => String(r.attempt) },
      { title: 'By', sort: (r) => r.reviewer_id, render: (r) => r.reviewer_id },
      { title: 'Marks', render: (r) => h('span', {}, r.summary, r.overall_note ? h('span.caption.block', {}, r.overall_note) : null) },
    ], reviews, { empty: 'Nothing of this person\'s has been reviewed yet.', pageSize: 10, sortable: true, caption: 'Reviews' }));
}
