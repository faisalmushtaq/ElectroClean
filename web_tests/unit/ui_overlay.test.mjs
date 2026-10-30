// Everyone's marks on one recording (js/expert/crowd.js, js/api/demo_overlay.js): the lanes' colours stay
// apart for colour-blind readers (Machado, Oliveira and Fernandes 2009, severity 1, distances in OKLab x
// 100, as the channel colours are checked), each with a pattern and a dash of its own; the answer of
// overlay_get decodes back to the marks saved; the crowd is counted as the server counts it (the cases
// shared with tests/test_web_overlay.py), a person's overlapping marks once; who marked a moment, the
// disagreements, the filters and the summary; and counting 200 people of 50 marks on 256 channels is fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const C = await import('../../electrotag/web/static/js/expert/crowd.js');
const { rangesText } = await import('../../electrotag/web/static/js/api/demo_overlay.js');
const { contrast } = await import('../../electrotag/web/static/js/util.js');
const { cvd, normal } = await import('./_colour_science.mjs');
const CASES = JSON.parse(fs.readFileSync(path.join(HERE, 'overlay_crowd_cases.json'), 'utf8'));

// ------------------------------------------------------------------ the lanes' look
test('eight lane colours that stay apart with full colour vision and with red-green colour blindness', () => {
  const P = C.LANE_COLOURS;
  assert.equal(P.length, C.MAX_LANES);
  assert.equal(new Set(P.map((x) => x.toUpperCase())).size, P.length);
  for (let i = 0; i < P.length; i++) {
    for (let j = i + 1; j < P.length; j++) {
      assert.ok(normal(P[i], P[j]) >= 15, `${P[i]}/${P[j]}: ${normal(P[i], P[j]).toFixed(1)} with full colour vision`);
      assert.ok(cvd(P[i], P[j]) >= 8, `${P[i]}/${P[j]}: ${cvd(P[i], P[j]).toFixed(1)} under simulated protanopia or deuteranopia`);
    }
  }
});

test('each lane has a pattern and a dash of its own, and its ID is legible on its colour', () => {
  assert.equal(new Set(C.LANE_PATTERNS).size, C.MAX_LANES);
  assert.equal(new Set(C.LANE_DASHES.map((d) => d.join(','))).size, C.MAX_LANES);
  for (const p of C.LANE_PATTERNS) assert.ok(C.PATTERN_WORDS[p], p);
  C.LANE_COLOURS.forEach((hex, i) => {
    const ink = C.laneInk(hex);
    assert.ok(contrast(ink, hex) >= 4.5, `${ink} on ${hex}: ${contrast(ink, hex).toFixed(2)}:1`);
    const css = C.patternCss(C.LANE_PATTERNS[i], hex);
    assert.equal(css.backgroundColor, hex);
    assert.equal(css.backgroundImage === 'none', C.LANE_PATTERNS[i] === 'solid');
  });
});

// ------------------------------------------------------------------ the answer
test('channel sets as runs, both ways', () => {
  assert.equal(rangesText([]), '');
  assert.equal(rangesText([9, 0, 1, 2, 3, 7, 10]), '0-3,7,9-10');
  assert.deepEqual(C.parseSet('0-3,7,9-10'), [0, 1, 2, 3, 7, 9, 10]);
  assert.deepEqual(C.parseSet(''), []);
  for (const set of [[5], [0, 2, 4], [1, 2, 3, 200, 201, 255]]) assert.deepEqual(C.parseSet(rangesText(set)), set);
});

const ANSWER = {
  recording_id: 'r', file_name: 'r.edf', sfreq: 100, n_samples: 1000, channels: ['Fp1', 'Fp2', 'O1'], anonymous: false,
  labels: ['Eye-blink-artifact', 'EMG-artifact'], sets: ['', '0-1'],
  people: [
    { annotator_id: 'A01', display_name: 'One', roles: ['annotator'], you: false, source: 'saved', of: null, by: null, attempt: 2, saved_at: '2026-10-29T10:00:00', n_marks: 2,
      facets: { group: 'Leeds' }, marks: [0, 100, 50, 1, 0, 1, 200, 100, 0, 3], ids: ['a', 'b'] },
    { annotator_id: 'E01', display_name: '', roles: ['expert'], you: true, source: 'saved', of: null, by: null, attempt: 1, saved_at: '2026-10-30T10:00:00', n_marks: 1,
      facets: {}, marks: [0, 120, 40, 1, 0] },
  ],
  derived: [{ annotator_id: 'A01~E01', display_name: 'A01 corrected by E01', source: 'corrected', of: 'A01', by: 'E01', attempt: 1, saved_at: null, n_marks: 1,
    roles: [], you: false, facets: {}, marks: [0, 100, 50, 1, 0] }],
  facets: [{ key: 'group', title: 'Group', values: ['Leeds'] }], crowd: null, total: 3, next_offset: null,
};
// a later page has tables of its own
const PAGE = { labels: ['Chewing-artifact'], sets: ['', '2'], people: [{ annotator_id: 'A02', display_name: '', roles: ['annotator'], source: 'saved', attempt: 1,
  saved_at: '2026-10-28T10:00:00', facets: {}, marks: [0, 500, 30, 1, 0] }], next_offset: null };

test('the answer and its pages decode back to the marks saved', () => {
  const d = C.decode(ANSWER, [PAGE]);
  assert.deepEqual(d.people.map((p) => p.key), ['A01', 'E01', 'A02', 'A01~E01']);
  const [a01, e01, a02, corr] = d.people;
  assert.deepEqual(a01.marks.map((m) => [m.id, m.label, m.onset, m.dur, d.setChannels[m.set].map((i) => d.channels[i]), m.conf]),
    [['a', 'Eye-blink-artifact', 100, 50, ['Fp1', 'Fp2'], null], ['b', 'EMG-artifact', 300, 100, [], 3]]);
  assert.equal(e01.marks[0].id, 'E01-1', 'without IDs, the marks are numbered');
  assert.deepEqual([a02.marks[0].label, d.setChannels[a02.marks[0].set]], ['Chewing-artifact', [2]]);
  assert.equal(corr.source, 'corrected');
  assert.deepEqual(d.labels, ['Chewing-artifact', 'EMG-artifact', 'Eye-blink-artifact']);
  assert.deepEqual(C.asAnnotation(d, a01.marks[0]), { annotation_id: 'a', label: 'Eye-blink-artifact', onset_sample: 100, duration_samples: 50, channels: ['Fp1', 'Fp2'] });
  assert.equal(C.personName(a01), 'A01 (One)');
  assert.equal(C.personName(e01), 'You (E01)');
  assert.equal(C.shortName(corr), 'A01 corr. E01');
});

// ------------------------------------------------------------------ counting
for (const c of CASES) {
  test(`the crowd's counts per bin, as the server counts them: ${c.name}`, () => {
    assert.deepEqual(C.binCounts(c.people, c.n_samples, c.sfreq), c.counts);
  });
}

test('steps count people, not marks: a person\'s overlapping marks count once', () => {
  const st = C.steps([[0, 100, 0], [50, 150, 0], [80, 120, 1]], 2);
  assert.deepEqual(st, { at: [0, 80, 120, 150], n: [1, 2, 1, 0] });
  assert.equal(C.countAt(st, -1), 0);
  assert.equal(C.countAt(st, 90), 2);
  assert.equal(C.countAt(st, 149), 1);
  assert.equal(C.countAt(st, 150), 0);
});

test('the bands: whole montage, each channel, and who marked a moment with which types', () => {
  const d = C.decode(ANSWER, [PAGE]);
  const crowd = C.crowdOf(d.people, [], C.NO_FILTERS);
  assert.deepEqual(crowd.map((p) => p.key), ['A01', 'E01', 'A02'], 'the derived versions are never in the crowd');
  const bands = new C.CrowdBands(d, crowd);
  assert.equal(bands.shareAt(0, 130), 2 / 3, 'Fp1 at 130: A01 and E01');
  assert.equal(bands.shareAt(2, 510), 1 / 3, 'O1 at 510: A02');
  assert.equal(bands.shareAt('whole', 350), 1 / 3);
  assert.equal(bands.shareAt('whole', 130), 0);
  assert.deepEqual(C.whoAt(d, crowd, 0, 130).map((w) => [w.person.key, w.labels]), [['A01', ['Eye-blink-artifact']], ['E01', ['Eye-blink-artifact']]]);
  assert.deepEqual(C.whoAt(d, crowd, 'any', 350).map((w) => w.person.key), ['A01']);
  assert.deepEqual(C.typeCounts(C.whoAt(d, crowd, 'any', 130)), [['Eye-blink-artifact', 2]]);
  // the type filter
  const emg = { ...C.NO_FILTERS, label: 'EMG-artifact' };
  assert.equal(new C.CrowdBands(d, crowd, emg).shareAt(0, 130), 0);
  assert.equal(new C.CrowdBands(d, crowd, emg).shareAt('whole', 350), 1 / 3);
});

test('the filters keep people by role, saved date and facet, and the lanes are never in the crowd', () => {
  const d = C.decode(ANSWER);
  const keys = (f, lanes = []) => C.crowdOf(d.people, lanes, { ...C.NO_FILTERS, ...f }).map((p) => p.key);
  assert.deepEqual(keys({}), ['A01', 'E01']);
  assert.deepEqual(keys({}, ['A01']), ['E01']);
  assert.deepEqual(keys({ role: 'expert' }), ['E01']);
  assert.deepEqual(keys({ from: '2026-10-30' }), ['E01']);
  assert.deepEqual(keys({ to: '2026-10-29' }), ['A01']);
  assert.deepEqual(keys({ facets: { group: 'Leeds' } }), ['A01']);
  assert.deepEqual(keys({ facets: { group: '' } }), ['A01', 'E01']);
  assert.ok(C.personPasses({ source: 'saved', roles: [], facets: { band: ['3–10', '11–30'] } }, { ...C.NO_FILTERS, facets: { band: '11–30' } }), 'a facet with several values');
});

test('the disagreements: a split among the people shown, stepped through with N and P', () => {
  assert.deepEqual(C.splitShares(2), { lo: 0.5, hi: 0.5 });
  const three = C.splitShares(3);
  assert.ok(Math.abs(three.lo - 1 / 3) < 1e-12 && Math.abs(three.hi - 2 / 3) < 1e-12);
  assert.deepEqual(C.splitShares(200), { lo: 0.2, hi: 0.8 });
  // ten people: all ten at 0-100 (agreed), five at 200-300 (split), one at 400-500 (too few), three at 600-700
  const iv = [];
  for (let p = 0; p < 10; p++) iv.push([0, 100, p]);
  for (let p = 0; p < 5; p++) iv.push([200, 300, p]);
  iv.push([400, 500, 0]);
  for (let p = 0; p < 3; p++) iv.push([600, 700, p]);
  const list = C.disagreements(C.steps(iv, 10), 10);
  assert.deepEqual(list.map((x) => [x.start, x.end, x.peak]), [[200, 300, 5], [600, 700, 3]]);
  assert.deepEqual(C.disagreements(C.steps(iv, 10), 10, 300).map((x) => [x.start, x.end]), [[200, 700]], 'close stretches joined');
  assert.equal(C.stepDisagreement(list, -1, 1), 0);
  assert.equal(C.stepDisagreement(list, 200, 1), 1);
  assert.equal(C.stepDisagreement(list, 600, 1), -1);
  assert.equal(C.stepDisagreement(list, 600, -1), 0);
  assert.equal(C.stepDisagreement(list, 200, -1), -1);
  assert.deepEqual(C.disagreements(C.steps([[0, 10, 0]], 1), 1), [], 'one person never disagrees');
});

test('the summary as TSV: a row for each stretch, with its share, types and the lanes that marked it', () => {
  const d = C.decode(ANSWER);
  const shown = d.people.filter((p) => p.source === 'saved');
  const tsv = C.summaryTsv(d, shown, ['A01']).trim().split('\n').map((l) => l.split('\t'));
  assert.deepEqual(tsv[0], [...C.SUMMARY_COLUMNS]);
  assert.deepEqual(tsv[1], ['1.000', '1.200', '1', '2', '0.500', 'yes', 'Eye-blink-artifact:1', 'A01']);
  assert.deepEqual(tsv[2], ['1.200', '1.500', '2', '2', '1.000', 'no', 'Eye-blink-artifact:2', 'A01']);
  assert.deepEqual(tsv[3].slice(0, 2), ['1.500', '1.600']);
  assert.deepEqual(tsv.at(-1), ['3.000', '4.000', '1', '2', '0.500', 'yes', 'EMG-artifact:1', 'A01']);
});

// ------------------------------------------------------------------ speed
test('200 people of 50 marks on 256 channels: counted, and every channel\'s band made, in well under a second', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const sf = 250;
  const n = 20 * 60 * sf;
  const sets = [''];
  const people = [];
  for (let p = 0; p < 200; p++) {
    const marks = [];
    let prev = 0;
    const onsets = Array.from({ length: 50 }, () => Math.floor(rnd() * (n - 1000))).sort((a, b) => a - b);
    for (const onset of onsets) {
      const k = rnd() < 0.4 ? 0 : (() => { const w = [1, 2, 4, 8, 32][Math.floor(rnd() * 5)]; const s = Math.floor(rnd() * (256 - w)); sets.push(`${s}-${s + w - 1}`); return sets.length - 1; })();
      marks.push(0, onset - prev, 25 + Math.floor(rnd() * 900), k, 0);
      prev = onset;
    }
    people.push({ annotator_id: `P${p}`, roles: ['annotator'], source: 'saved', attempt: 1, saved_at: '2026-10-30', marks });
  }
  const answer = { sfreq: sf, n_samples: n, channels: Array.from({ length: 256 }, (_, i) => `E${i + 1}`), labels: ['Eye-blink-artifact'], sets, people };
  const t0 = performance.now();
  const d = C.decode(answer);
  const bands = new C.CrowdBands(d, C.crowdOf(d.people, []));
  for (let c = 0; c < 256; c++) bands.band(c);
  bands.band('whole');
  const list = C.disagreements(bands.band('any'), 200);
  const ms = performance.now() - t0;
  assert.equal(d.people.reduce((k, p) => k + p.marks.length, 0), 10000);
  assert.ok(Array.isArray(list));
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
});

// ------------------------------------------------------------------ the ways in
test('the overlay is a purpose, a part loaded when first used, and two expert operations open to trainees', async () => {
  const { PURPOSES } = await import('../../electrotag/web/static/js/views/purposes.js');
  const { expertOps, OPEN_EXPERT } = await import('../../electrotag/web/static/js/api/demo_expert.js');
  const { partAddress } = await import('../../electrotag/web/static/js/lazy.js');
  const { isExpertRead } = await import('../../electrotag/web/static/js/api/http.js');
  assert.equal(typeof PURPOSES.overlay, 'function');
  assert.equal(partAddress('overlay'), './expert/overlay.js');
  for (const op of ['overlay_get', 'overlay_teaching_list']) {
    assert.equal(typeof expertOps()[op], 'function', op);
    assert.ok(OPEN_EXPERT.has(op), `${op} checks for itself who may see what`);
    assert.ok(isExpertRead(op), `${op} only reads, so it may be asked again`);
  }
});

test('trainees are offered the crowd only when the study shows it, and experts never need the entry', async () => {
  const { canSeeCrowd, crowdText } = await import('../../electrotag/web/static/js/expert/crowd_entry.js');
  const me = (roles, on) => ({ roles, study: { replay: { trainees_see_crowd: on } } });
  assert.equal(canSeeCrowd(me(['annotator'], true)), true);
  assert.equal(canSeeCrowd(me(['annotator'], false)), false);
  assert.equal(canSeeCrowd({ roles: ['annotator'], study: { replay: {} } }), false, 'off unless the study says so');
  assert.equal(canSeeCrowd(me(['annotator', 'expert'], true)), false);
  assert.equal(crowdText({ file_name: 'x.vhdr', n_people: 14, yours: true }), 'x.vhdr: 14 people, you among them');
});
