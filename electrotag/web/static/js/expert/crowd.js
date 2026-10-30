// The overlay of everyone's marks on one recording, without the page (docs/web/admin.md, "Everyone's
// marks on one recording"), so that it can be tested in Node: the answer of overlay_get decoded, the
// colours and patterns of the lanes, the filters, the crowd's share of people marking each moment
// (under each channel, and once for the whole-montage marks), who marked a moment, the disagreements
// to step through, the counts per time bin (as electrotag/web/overlay.py crowd_counts counts them)
// and the view's summary as TSV.
//
// A person's marks come as five whole numbers each: the type (an index into `labels`), the samples
// since the person's previous mark's onset, the duration in samples, the channel set (an index into
// `sets`, each runs of channel indexes such as "0-3,7"; "" is the whole montage) and the confidence
// (0 when none was given).

/** Most people shown in lanes of their own (overlay.py MAX_LANES). */
export const MAX_LANES = 8;

/**
 * The lanes' colours: after Okabe and Ito's palette for colour-blind readers, with the sky blue and the
 * purple moved so that every pair stays apart under simulated protanopia and deuteranopia (checked in
 * web_tests/unit/ui_overlay.test.mjs). A pattern is the second cue, and each mark carries its person's name.
 */
export const LANE_COLOURS = Object.freeze(['#0072B2', '#E69F00', '#00957F', '#D55E00', '#2FD7FF', '#F0E442', '#FFA4A8', '#000000']);
/** Each lane's pattern, in the lanes (CSS) and as the outline on the EEG (canvas line dashes). */
export const LANE_PATTERNS = Object.freeze(['solid', 'stripes', 'dots', 'back-stripes', 'checks', 'cross', 'vertical', 'horizontal']);
export const PATTERN_WORDS = Object.freeze({ solid: 'plain', stripes: 'striped', dots: 'dotted', 'back-stripes': 'striped the other way',
  checks: 'chequered', cross: 'cross-hatched', vertical: 'with upright stripes', horizontal: 'with level stripes' });
export const LANE_DASHES = Object.freeze([[], [9, 3], [2, 3], [9, 3, 2, 3], [5, 5], [14, 4], [2, 3, 2, 3, 9, 3], [1, 6]]);


/** Channel indexes of a set's runs: "0-3,7" -> [0, 1, 2, 3, 7]. */
export function parseSet(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    if (!part) continue;
    const [a, b] = part.split('-').map(Number);
    for (let i = a; i <= (Number.isFinite(b) ? b : a); i++) out.push(i);
  }
  return out;
}

/** The text and pattern of a lane's mark: dark text on the light colours, white on the dark ones. */
export function laneInk(hex) {
  const v = String(hex).replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? '#000000' : '#FFFFFF';
}

/** A CSS background for a lane's pattern in its colour, the pattern drawn in its ink at low strength. */
export function patternCss(pattern, colour) {
  const ink = laneInk(colour) === '#000000' ? 'rgba(0, 0, 0, 0.32)' : 'rgba(255, 255, 255, 0.45)';
  const stripes = (deg) => `repeating-linear-gradient(${deg}deg, ${ink} 0 2px, transparent 2px 6px)`;
  const img = {
    solid: 'none', stripes: stripes(45), 'back-stripes': stripes(-45), vertical: stripes(90), horizontal: stripes(0),
    dots: `radial-gradient(${ink} 1.2px, transparent 1.6px)`,
    checks: `repeating-conic-gradient(${ink} 0 25%, transparent 0 50%)`,
    cross: `${stripes(45)}, ${stripes(-45)}`,
  }[pattern] || 'none';
  const size = pattern === 'dots' ? '5px 5px' : pattern === 'checks' ? '8px 8px' : 'auto';
  return { backgroundColor: colour, backgroundImage: img, backgroundSize: size };
}

/** The answer of overlay_get, with its later pages (each has tables of its own), as people with their marks. */
export function decode(answer, pages = []) {
  const sets = [''];
  const setAt = new Map([['', 0]]);
  const people = [];
  const add = (p, page) => {
    const local = (page.sets || ['']).map((text) => {
      if (!setAt.has(text)) { setAt.set(text, sets.length); sets.push(text); }
      return setAt.get(text);
    });
    const labels = page.labels || [];
    const m = p.marks || [];
    const marks = [];
    let onset = 0;
    for (let i = 0, k = 0; i < m.length; i += 5, k++) {
      onset += m[i + 1];
      const set = local[m[i + 3]] ?? 0;
      marks.push({ id: (p.ids && p.ids[k]) || `${p.annotator_id}-${k + 1}`, label: labels[m[i]], onset, dur: m[i + 2],
        end: onset + Math.max(1, m[i + 2]), set, whole: set === 0, conf: m[i + 4] || null });
    }
    people.push({ key: p.annotator_id, annotator_id: p.annotator_id, display_name: p.display_name || '', roles: p.roles || [], you: Boolean(p.you),
      source: p.source || 'saved', of: p.of ?? null, by: p.by ?? null, attempt: p.attempt, saved_at: p.saved_at || null, facets: p.facets || {}, marks });
  };
  for (const page of [answer, ...pages]) for (const p of page.people || []) add(p, page);
  for (const p of answer.derived || []) add(p, answer);
  const labels = [...new Set([answer, ...pages].flatMap((pg) => pg.labels || []))].sort();
  return { recording_id: answer.recording_id, file_name: answer.file_name, sfreq: Number(answer.sfreq), nSamples: Number(answer.n_samples),
    channels: answer.channels || [], labels, sets, setChannels: sets.map(parseSet), people, anonymous: Boolean(answer.anonymous),
    facets: answer.facets || [], crowd: answer.crowd || null, total: answer.total ?? people.length };
}

/** A mark of a lane as the viewer's annotations: {annotation_id, label, onset_sample, duration_samples, channels}. */
export function asAnnotation(data, m) {
  return { annotation_id: m.id, label: m.label, onset_sample: m.onset, duration_samples: m.dur, channels: data.setChannels[m.set].map((i) => data.channels[i]) };
}

/** A person's name as the view shows it: "A01 (Annotator one)", "You", "A01 corrected by E01". */
export function personName(p) {
  if (p.you && p.source === 'saved') return `You (${p.annotator_id})`;
  if (p.source !== 'saved') return p.display_name || p.annotator_id;
  return p.display_name ? `${p.annotator_id} (${p.display_name})` : p.annotator_id;
}

/** The short name on each mark: the ID, or "Adjudicated", "A01 corr. E01". */
export function shortName(p) {
  if (p.source === 'adjudicated') return 'Adjudicated';
  if (p.source === 'corrected') return `${p.of} corr. ${p.by}`;
  return p.annotator_id;
}

// ------------------------------------------------------------------ filters
/** The filters a view starts with: every type, role, date and facet. */
export const NO_FILTERS = Object.freeze({ label: '', role: '', from: '', to: '', facets: Object.freeze({}) });

/** True for a person the filters keep in the crowd (role, saved date and facets). */
export function personPasses(p, f = NO_FILTERS) {
  if (p.source !== 'saved') return false;
  if (f.role && !(p.roles || []).includes(f.role)) return false;
  const day = String(p.saved_at || '').slice(0, 10);
  if (f.from && (!day || day < f.from)) return false;
  if (f.to && (!day || day > f.to)) return false;
  for (const [k, want] of Object.entries(f.facets || {})) {
    if (!want) continue;
    const v = p.facets && p.facets[k];
    if (!(Array.isArray(v) ? v.includes(want) : v === want)) return false;
  }
  return true;
}

/** True for a mark the type filter keeps. */
export const markPasses = (m, f = NO_FILTERS) => !f.label || m.label === f.label;

/** The crowd: everyone who saved, apart from the people in lanes, as the filters keep them. */
export function crowdOf(people, laneKeys, f = NO_FILTERS) {
  const lanes = new Set(laneKeys);
  return people.filter((p) => !lanes.has(p.key) && personPasses(p, f));
}

// ------------------------------------------------------------------ the crowd's share
/**
 * How many people marked each moment, from intervals [onset, end, person] (end exclusive): the
 * boundaries `at` (samples) and the number of people `n[i]` marking from at[i] to at[i + 1]. A person's
 * overlapping marks count once.
 */
export function steps(intervals, nPeople) {
  const ev = [];
  for (const [a, b, p] of intervals) { ev.push([a, 1, p]); ev.push([b, -1, p]); }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const per = new Int32Array(Math.max(1, nPeople));
  const at = [];
  const n = [];
  let distinct = 0;
  let i = 0;
  while (i < ev.length) {
    const t = ev[i][0];
    for (; i < ev.length && ev[i][0] === t; i++) {
      const [, d, p] = ev[i];
      const before = per[p];
      per[p] += d;
      if (before === 0 && per[p] > 0) distinct++;
      else if (before > 0 && per[p] === 0) distinct--;
    }
    if (n.length && n[n.length - 1] === distinct) continue;
    at.push(t);
    n.push(distinct);
  }
  return { at, n };
}

/** The number of people marking at sample s, from steps. */
export function countAt(st, s) {
  let lo = 0;
  let hi = st.at.length - 1;
  if (hi < 0 || s < st.at[0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (st.at[mid] <= s) lo = mid; else hi = mid - 1;
  }
  return st.n[lo];
}

/**
 * The crowd's share of people marking, band by band: `whole` for the whole-montage marks, one band per
 * channel for the marks on chosen channels (each made when it is first asked for), and `any` for every
 * mark of the people shown (the disagreements and the summary).
 */
export class CrowdBands {
  constructor(data, members, f = NO_FILTERS) {
    this.data = data;
    this.members = members;
    this.f = f;
    this.n = members.length;
    this._bands = new Map();
    this._byChannel = null;
  }

  _intervals(keep) {
    const out = [];
    this.members.forEach((p, i) => { for (const m of p.marks) if (markPasses(m, this.f) && keep(m)) out.push([m.onset, m.end, i]); });
    return out;
  }

  /** The steps of a band: 'whole', 'any' or a channel's index. */
  band(key) {
    if (this._bands.has(key)) return this._bands.get(key);
    let iv;
    if (key === 'whole') iv = this._intervals((m) => m.whole);
    else if (key === 'any') iv = this._intervals(() => true);
    else {
      if (!this._byChannel) this._index();
      iv = this._byChannel.get(key) || [];
    }
    const st = steps(iv, this.n);
    this._bands.set(key, st);
    return st;
  }

  _index() {
    const by = new Map();
    const sets = this.data.setChannels;
    this.members.forEach((p, i) => {
      for (const m of p.marks) {
        if (m.whole || !markPasses(m, this.f)) continue;
        for (const c of sets[m.set]) {
          let l = by.get(c);
          if (!l) by.set(c, (l = []));
          l.push([m.onset, m.end, i]);
        }
      }
    });
    this._byChannel = by;
  }

  /** The share of the crowd marking band `key` at sample s (0 to 1). */
  shareAt(key, s) { return this.n ? countAt(this.band(key), s) / this.n : 0; }
}

/**
 * Who marked a moment, and with which types: [{person, labels}] of the people given (lanes and crowd), for
 * band `key` ('whole', 'any' or a channel's index), as the filters keep their marks.
 */
export function whoAt(data, people, key, s, f = NO_FILTERS) {
  const out = [];
  for (const p of people) {
    const labels = new Set();
    for (const m of p.marks) {
      if (m.onset > s) break;
      if (s >= m.end || !markPasses(m, f)) continue;
      if (key === 'whole' ? !m.whole : key === 'any' ? false : (m.whole || !data.setChannels[m.set].includes(key))) continue;
      labels.add(m.label);
    }
    if (labels.size) out.push({ person: p, labels: [...labels].sort() });
  }
  return out;
}

/** How many chose each type: [[label, n]], the most chosen first. */
export function typeCounts(who) {
  const by = new Map();
  for (const w of who) for (const l of w.labels) by.set(l, (by.get(l) || 0) + 1);
  return [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The share of people at which a moment counts as a disagreement: between `lo` and `hi`, which depend on how many are shown. */
export function splitShares(n) {
  return { lo: Math.max(1 / Math.max(1, n), 0.2), hi: Math.min(1 - 1 / Math.max(1, n), 0.8) };
}

/**
 * The disagreements among the people shown: the stretches where some of them marked an artifact and
 * others did not (between a fifth and four fifths of them, or with two or three people, any split), from
 * the steps of band 'any'. [{start, end, n, peak}] in samples, in order; stretches closer than `join`
 * samples are one.
 */
export function disagreements(st, n, join = 0) {
  if (n < 2) return [];
  const { lo, hi } = splitShares(n);
  const out = [];
  for (let i = 0; i < st.at.length - 1; i++) {
    const share = st.n[i] / n;
    if (st.n[i] === 0 || share < lo - 1e-9 || share > hi + 1e-9) continue;
    const last = out[out.length - 1];
    if (last && st.at[i] - last.end <= join) { last.end = st.at[i + 1]; last.peak = Math.max(last.peak, st.n[i]); continue; }
    out.push({ start: st.at[i], end: st.at[i + 1], peak: st.n[i] });
  }
  return out;
}

/** The disagreement after (delta 1) or before (-1) sample s: its index, or -1. */
export function stepDisagreement(list, s, delta) {
  if (!list.length) return -1;
  if (delta > 0) return list.findIndex((d) => d.start > s);
  for (let i = list.length - 1; i >= 0; i--) if (list[i].start < s) return i;
  return -1;
}

// ------------------------------------------------------------------ counts per time bin
/** The crowd's bin: one second, or as many whole seconds as keep the bins to 1000 (overlay.py bin_seconds). */
export const binSeconds = (durationS) => Math.max(1, Math.ceil(Math.max(0, Number(durationS)) / 1000));

/**
 * How many people marked each bin: `marking` (any mark) and `whole` (on the whole montage), from each
 * person's marks as [onset, duration, whole] (overlay.py crowd_counts, the same cases checked on both sides).
 */
export function binCounts(people, nSamples, sfreq) {
  const binS = binSeconds(sfreq > 0 ? nSamples / sfreq : 0);
  const width = binS * sfreq;
  const nBins = width > 0 ? Math.max(1, Math.ceil(nSamples / width)) : 1;
  const marking = new Array(nBins).fill(0);
  const whole = new Array(nBins).fill(0);
  for (const marks of people) {
    const any = new Set();
    const wh = new Set();
    for (const [onset, dur, isWhole] of marks) {
      const a = Math.min(nBins - 1, Math.max(0, Math.floor(onset / width)));
      const b = Math.min(nBins - 1, Math.max(a, Math.floor((onset + Math.max(1, dur) - 1) / width)));
      for (let i = a; i <= b; i++) { any.add(i); if (isWhole) wh.add(i); }
    }
    for (const i of any) marking[i] += 1;
    for (const i of wh) whole[i] += 1;
  }
  return { bin_s: binS, n_bins: nBins, n_people: people.length, marking, whole };
}

// ------------------------------------------------------------------ the summary
const cell = (v) => (v === null || v === undefined || v === '' ? 'n/a' : String(v).replace(/[\t\r\n]+/g, ' '));
export const SUMMARY_COLUMNS = Object.freeze(['onset_s', 'offset_s', 'people_marking', 'people_shown', 'share', 'disagreement', 'types', 'lanes_marking']);

/**
 * The view's summary as TSV: one row for each stretch in which the number of people marking stays the
 * same (any channel, as the filters keep them), with the share, whether it is a disagreement, the types
 * chosen ("Eye-blink-artifact:12,EMG-artifact:3") and which of the lanes' people marked it.
 */
export function summaryTsv(data, shown, laneKeys, f = NO_FILTERS) {
  const bands = new CrowdBands(data, shown, f);
  const st = bands.band('any');
  const n = shown.length;
  const { lo, hi } = splitShares(n);
  const lanes = new Set(laneKeys);
  const rows = [SUMMARY_COLUMNS.join('\t')];
  const sf = data.sfreq;
  for (let i = 0; i < st.at.length - 1; i++) {
    if (!st.n[i]) continue;
    const who = whoAt(data, shown, 'any', st.at[i], f);
    const share = st.n[i] / n;
    const split = n >= 2 && share >= lo - 1e-9 && share <= hi + 1e-9;
    rows.push([(st.at[i] / sf).toFixed(3), (st.at[i + 1] / sf).toFixed(3), st.n[i], n, share.toFixed(3), split ? 'yes' : 'no',
      typeCounts(who).map(([l, k]) => `${l}:${k}`).join(','), who.filter((w) => lanes.has(w.person.key)).map((w) => shortName(w.person)).join(',')].map(cell).join('\t'));
  }
  return `${rows.join('\n')}\n`;
}

