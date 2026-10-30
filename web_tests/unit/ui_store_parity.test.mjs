// The browser's annotation store (js/annotate/store.js) and the study's own (electrotag/app/annotations/store.py)
// do exactly the same: the same sequences of edits, with marks that overlap, touch or have a gap between them,
// with automatic merging on and off (annotation.merge_overlapping), channels marked bad, explicit merges, undo
// and redo, give the same annotations, the same bad channels and the same joins after every step
// (through web_tests/store_parity.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AnnotationStore, AnnotationError } from '../../electrotag/web/static/js/annotate/store.js';
import { CATALOGUE } from '../../electrotag/web/static/js/api/demo_catalogue.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function findPython() {
  for (const p of [process.env.ELECTROTAG_PYTHON, path.join(REPO, '.venv', 'bin', 'python'), 'python3']) {
    if (!p || (p.includes('/') && !fs.existsSync(p))) continue;
    const r = spawnSync(p, ['-c', 'import electrotag.app.annotations.store'], { cwd: REPO, encoding: 'utf8' });
    if (r.status === 0) return p;
  }
  return null;
}
const PYTHON = findPython();

const CH = ['Fp1', 'Fp2', 'C3', 'C4', 'O1', 'O2'];
const LABELS = ['EMG-artifact', 'Eye-blink-artifact', 'Data-artifact'];

/** A small reproducible random number generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Edits that put marks next to each other: overlapping, touching, or with a gap of a few samples. */
function makeOps(seed, n = 40) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const ids = [];
  const ops = [];
  let next = 0;
  for (let i = 0; i < n; i++) {
    const x = r();
    if (x < 0.45 || !ids.length) {
      const id = (next++).toString(16).padStart(32, '0');
      ids.push(id);
      const near = ops.filter((o) => o.op === 'add');
      const prev = near.length ? near[near.length - 1] : null;
      // just after the last mark, with a gap of -20 to +5 samples (negative: an overlap; 0: touching)
      const onset = prev && r() < 0.7 ? Math.max(0, prev.onset + prev.duration + Math.floor(r() * 26) - 20) : Math.floor(r() * 900);
      const chans = r() < 0.7 ? [] : [pick(CH), pick(CH)].filter((c, j, a) => a.indexOf(c) === j);
      ops.push({ op: 'add', id, label: r() < 0.8 ? 'EMG-artifact' : pick(LABELS), onset, duration: 5 + Math.floor(r() * 40), channels: chans });
    } else if (x < 0.6) {
      ops.push({ op: 'move', id: pick(ids), onset: Math.floor(r() * 900), duration: 5 + Math.floor(r() * 60) });
    } else if (x < 0.72) {
      ops.push({ op: 'bad', channel: pick(CH), bad: r() < 0.7 });
    } else if (x < 0.8) {
      ops.push({ op: r() < 0.5 ? 'undo' : 'redo' });
    } else if (x < 0.86) {
      ops.push({ op: 'merge', ids: [pick(ids), pick(ids)] });
    } else if (x < 0.9) {
      ops.push({ op: 'delete', id: pick(ids) });
    } else {
      ops.push({ op: 'undo' });
    }
  }
  return ops;
}

function runJs(c) {
  const s = new AnnotationStore({ chNames: c.ch_names, nSamples: c.n_samples, sfreq: c.sfreq, labels: CATALOGUE.labels.map((l) => l.label), autoMerge: c.auto_merge });
  const given = new Set();
  return c.ops.map((op) => {
    let error = null;
    s.lastAutoMerged = 0;
    try {
      if (op.op === 'add') { given.add(op.id); s.add(op.label, op.onset, op.duration, op.channels, op.id); }
      else if (op.op === 'move') { if (s.has(op.id)) s.update(op.id, { onset_sample: op.onset, duration_samples: op.duration, description: 'move/resize' }); }
      else if (op.op === 'bad') s.setChannelBad(op.channel, op.bad);
      else if (op.op === 'merge') s.merge(op.ids.filter((i) => s.has(i)));
      else if (op.op === 'delete') { if (s.has(op.id)) s.delete(op.id); }
      else if (op.op === 'undo') s.undo();
      else if (op.op === 'redo') s.redo();
    } catch (exc) {
      if (!(exc instanceof AnnotationError)) throw exc;
      error = 'AnnotationError';
    }
    return { annotations: s.annotations().map((a) => [given.has(a.annotation_id) ? a.annotation_id : '*', a.label, a.onset_sample, a.duration_samples, [...a.channels]]),
      bad: s.badChannels, merged: s.lastAutoMerged, error };
  });
}

test('the browser\'s store and the study\'s own give the same marks, joins and bad channels after every edit', { skip: !PYTHON && 'no Python with ElectroTag installed' }, () => {
  const cases = [];
  for (let seed = 1; seed <= 40; seed++) cases.push({ sfreq: 250, n_samples: 1200, ch_names: CH, auto_merge: seed % 4 !== 0, ops: makeOps(seed) });
  // by hand: a brief gap, touching, an overlap, and the same with joining off
  const hand = [
    { op: 'add', id: 'a'.repeat(32), label: 'EMG-artifact', onset: 100, duration: 100 },
    { op: 'add', id: 'b'.repeat(32), label: 'EMG-artifact', onset: 203, duration: 50 }, // a gap of 3 samples
    { op: 'add', id: 'c'.repeat(32), label: 'EMG-artifact', onset: 253, duration: 20 }, // touching
    { op: 'add', id: 'd'.repeat(32), label: 'EMG-artifact', onset: 190, duration: 20 }, // overlaps a and b
    { op: 'undo' }, { op: 'bad', channel: 'C3', bad: true }, { op: 'undo' }, { op: 'redo' },
  ];
  cases.push({ sfreq: 250, n_samples: 1200, ch_names: CH, auto_merge: true, ops: hand }, { sfreq: 250, n_samples: 1200, ch_names: CH, auto_merge: false, ops: hand });
  const res = spawnSync(PYTHON, [path.join(REPO, 'web_tests', 'store_parity.py')], { input: JSON.stringify(cases), encoding: 'utf8', cwd: REPO });
  assert.equal(res.status, 0, res.stderr);
  const py = JSON.parse(res.stdout);
  let joins = 0;
  cases.forEach((c, i) => {
    const js = runJs(c);
    js.forEach((step, k) => {
      assert.deepEqual(step, py[i][k], `case ${i}, step ${k} (${JSON.stringify(c.ops[k])})`);
      joins += step.merged;
    });
  });
  assert.ok(joins > 5, 'the random edits joined some overlapping marks');
  // the hand-made case: the gap and the touch stay apart, the overlap joins (and only with joining on)
  const on = py[py.length - 2];
  const off = py[py.length - 1];
  assert.equal(on[2].annotations.length, 3);
  assert.equal(on[3].annotations.length, 2);
  assert.equal(on[3].merged, 2);
  assert.equal(off[3].annotations.length, 4);
  assert.deepEqual(on[5].bad, ['C3']);
  assert.deepEqual(on[6].bad, []);
  assert.deepEqual(on[7].bad, ['C3']);
});
