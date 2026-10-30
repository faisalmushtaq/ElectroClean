// The artifact reference guide (js/guide/artifacts.js, js/guide/guide.js): every type of the catalogue
// (electrotag/config/artifact_labels.json) is described, and nothing else; each look-alike it names is
// a type of the catalogue; each simulated example draws its artifact where the guide outlines it; the
// types of the sandbox's examples and training snippets all have an example; the search finds types by
// what they look like; and the text keeps the house style.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { GUIDE, GUIDE_CHANNELS, exampleSpec, guideMatches } = await import('../../electrotag/web/static/js/guide/artifacts.js');
const { keyText } = await import('../../electrotag/web/static/js/guide/guide.js');
const { demoSpecs, makeSyntheticRecording } = await import('../../electrotag/web/static/js/eeg/synthetic.js');

const CAT = JSON.parse(readFileSync(new URL('../../electrotag/config/artifact_labels.json', import.meta.url), 'utf8'));
const LABELS = CAT.labels.map((l) => l.label);

test('every type of the catalogue is in the guide, and nothing else', () => {
  assert.deepEqual(Object.keys(GUIDE).sort(), [...LABELS].sort());
});

test('every look-alike named is a type of the catalogue, and a type is never its own look-alike', () => {
  for (const [label, g] of Object.entries(GUIDE)) {
    for (const [other, how] of g.apart) {
      assert.ok(LABELS.includes(other), `${label}: ${other}`);
      assert.notEqual(other, label);
      assert.ok(how.length > 10, `${label}: what tells it from ${other}`);
    }
  }
});

test('a specific type says where, at what frequency, in what shape and for how long; a group term says what it is for', () => {
  for (const l of CAT.labels) {
    const g = GUIDE[l.label];
    if (l.kind === 'group') {
      assert.equal(g.example, null, `${l.label}: no example for a group term`);
      assert.match(g.where, /group term|most general term/, l.label);
    } else {
      for (const k of ['where', 'frequency', 'shape', 'duration']) assert.ok(g[k] && g[k].endsWith('.'), `${l.label}: ${k}`);
    }
  }
});

/** The size of the signal of channel `ci` from a to b seconds: its peak-to-peak range, in µV. */
function range(rec, ci, a, b) {
  const sf = rec.sfreq;
  const x = rec.__raw[ci].subarray(Math.round(a * sf), Math.round(b * sf));
  return (Math.max(...x) - Math.min(...x)) * 1e6;
}

async function read(spec) {
  const rec = makeSyntheticRecording(spec);
  const w = await rec.readWindow({ startSample: 0, nSamples: rec.nSamples, channels: null, filters: null });
  rec.__raw = w.data;
  return rec;
}

test('each example draws its artifact: the outlined channels change clearly while it lasts', async () => {
  for (const l of CAT.labels) {
    const spec = exampleSpec(l.label, l.value);
    if (!spec) continue;
    assert.deepEqual(spec.channels, [...GUIDE_CHANNELS]);
    const [{ onsetS, durationS, channels }] = spec.artifacts.map((a) => ({ onsetS: a[1], durationS: a[2], channels: a[3] }));
    assert.ok(onsetS >= 0 && onsetS + durationS <= spec.durationS, l.label);
    for (const c of channels) assert.ok(GUIDE_CHANNELS.includes(c), `${l.label}: ${c}`);
    const withIt = await read(spec);
    const without = await read({ ...spec, artifacts: [] });
    const on = (channels.length ? channels : GUIDE_CHANNELS.filter((c) => !['HEOG', 'VEOG', 'ECG'].includes(c)))
      .map((c) => GUIDE_CHANNELS.indexOf(c));
    const gain = Math.max(...on.map((ci) => range(withIt, ci, onsetS, onsetS + durationS) / range(without, ci, onsetS, onsetS + durationS)));
    assert.ok(gain > 2, `${l.label}: the example's artifact stands out (${gain.toFixed(2)} times the background)`);
  }
});

test('the types of the sandbox\'s examples and training snippets all have an example in the guide', () => {
  const used = new Set(demoSpecs().flatMap((s) => s.artifacts.map((a) => a.label)));
  for (const label of used) assert.ok(exampleSpec(label, 1), label);
  const withExamples = LABELS.filter((l) => exampleSpec(l, 1));
  assert.ok(withExamples.length >= 16, `${withExamples.length} types have an example`);
});

test('the search finds a type by its names and codes, and by what it looks like', () => {
  const find = (text) => CAT.labels.filter((l) => guideMatches(l, text)).map((l) => l.label);
  assert.ok(find('blink').includes('Eye-blink-artifact'));
  assert.ok(find('BLINK').includes('Eye-blink-artifact'));
  assert.ok(find('103').includes('Eye-blink-artifact'));
  assert.deepEqual(find('50 Hz').filter((l) => l === 'Line-noise-artifact'), ['Line-noise-artifact']);
  assert.ok(find('heart rate').includes('ECG-artifact') && find('heart rate').includes('Pulse-artifact'));
  assert.ok(find('loose electrode').includes('Electrode-pops-artifact'));
  assert.deepEqual(find('no such thing at all'), []);
});

test('the key of a type is its number key in the study, or / (Find a type)', () => {
  const keys = ['Eye-blink-artifact', 'EMG-artifact'];
  assert.equal(keyText('EMG-artifact', keys), 'Key 2');
  assert.equal(keyText('Sweat-artifact', keys), 'Find a type (/)');
});

test('the guide\'s words keep the house style: no em dashes, UK spellings', () => {
  const text = JSON.stringify(GUIDE);
  assert.doesNotMatch(text, /—/);
  assert.doesNotMatch(text, /\b(color|behavior|center|analyze)\b/i);
});
