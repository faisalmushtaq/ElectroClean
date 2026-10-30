// The versions of the annotations an agreement analysis compares (electrotag/reliability/versions.py,
// docs/web/api.md "Derived versions in the analyses"), and "Compare with the original versions":
// the key results of two analyses side by side with their differences, built here from each
// answer's summary.key_results. Pure functions, tested in Node.

export const VERSION_CHOICES = [
  ['original', 'The originals, as annotated'],
  ['corrected', 'As the experts corrected them'],
  ['adjudicated', 'Each annotator against the adjudicated versions'],
];

export const UNIT_CHOICES = [
  ['recording', 'Whole recordings'],
  ['task', "Each task's part on its own"],
];

/** The hint under the Versions control, for the version chosen. */
export function versionHint(versions) {
  if (versions === 'corrected') {
    return "Each annotator's latest work as an expert corrected it, where it was corrected. When two or more experts corrected the same work, their adjudication stands for it; until it is finished, that recording is left out and named in the warnings.";
  }
  if (versions === 'adjudicated') {
    return 'Everyone is compared with the adjudicated version of each finished adjudication (the reference is ADJUDICATED). Recordings without a finished adjudication are left out.';
  }
  return 'The annotations as the annotators saved them; corrections and adjudicated versions are left out.';
}

/** The key measures of an agreement answer (summary.key_results), with their headings. */
export const KEY_MEASURES = [
  ['any_artifact_positive_agreement', 'Positive agreement, any artifact'],
  ['any_artifact_kappa', "Cohen's kappa, any artifact"],
  ['event_f1', 'Event F1, all categories'],
];

const MEAN = 'Mean over pairs';
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/** summary.versions as rows of plain words ([label, text]) for the answer's summary table. */
export function versionSummaryRows(summary) {
  const s = summary || {};
  const v = s.versions || {};
  const rows = [];
  if (v.used && v.used !== 'original') {
    const words = Object.fromEntries(VERSION_CHOICES);
    rows.push(['Versions compared', words[v.used] || v.used]);
    const by = Object.entries(v.by || {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(', ');
    const n = Number(v.replaced) || 0;
    rows.push([v.used === 'adjudicated' ? 'Adjudications used' : 'Saved versions replaced by a correction', `${n}${by ? ` (${by})` : ''}`]);
    if ((v.pending || []).length) rows.push(['Correction pending adjudication (left out)', v.pending.map((r) => String(r).split('/').pop()).join(', ')]);
  }
  if (s.unit === 'task') rows.push(['Compared', "Each task's part of a recording on its own"]);
  return rows;
}

/**
 * The key results of two analyses side by side: one row per annotator pair and measure, with the
 * value in the originals, in the version analysed, and the difference (version minus originals).
 * Pairs appear in the version's order, then those only in the originals; the mean over pairs comes
 * last, so that an analysis against the adjudicated versions (whose pairs are ADJUDICATED – A01 and
 * so on) still has a row to compare.
 */
export function compareKeyResults(originalSummary, versionSummary) {
  const index = (s) => new Map(((s && s.key_results) || []).map((r) => [String(r.pair), r]));
  const a = index(originalSummary);
  const b = index(versionSummary);
  const pairs = [...b.keys(), ...[...a.keys()].filter((p) => !b.has(p))].filter((p) => p !== MEAN);
  if (a.has(MEAN) || b.has(MEAN)) pairs.push(MEAN);
  const rows = [];
  for (const pair of pairs) {
    for (const [key, measure] of KEY_MEASURES) {
      const o = a.has(pair) && finite(a.get(pair)[key]) ? a.get(pair)[key] : null;
      const v = b.has(pair) && finite(b.get(pair)[key]) ? b.get(pair)[key] : null;
      if (o === null && v === null) continue;
      rows.push({ pair, measure, key, original: o, version: v, difference: o !== null && v !== null ? v - o : null });
    }
  }
  return rows;
}

/** A number as the comparison shows it (three decimals; a difference with its sign; '–' for none). */
export function numberText(x, { signed = false } = {}) {
  if (!finite(x)) return '–';
  const t = (Math.abs(x) < 5e-4 ? 0 : x).toFixed(3);
  return signed && x > 0 && t !== '0.000' ? `+${t}` : t;
}

/** The comparison as a TSV file. */
export function comparisonTsv(rows, versions) {
  const head = ['pair', 'measure', 'original', versions || 'version', 'difference'];
  const cell = (x) => (finite(x) ? String(Math.round(x * 1e6) / 1e6) : 'n/a');
  return [head.join('\t'), ...rows.map((r) => [r.pair, r.key, cell(r.original), cell(r.version), cell(r.difference)].join('\t'))].join('\n') + '\n';
}
