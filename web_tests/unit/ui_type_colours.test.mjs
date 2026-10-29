// The colours of the artifact types (electrotag/config/artifact_labels.json, the same in the
// demonstration's catalogue): the nine types on the toolbar's numbered buttons by default stay
// apart for annotators with red-green colour blindness, measured as the channel palettes are
// (ui_channel_colours.test.mjs: Machado, Oliveira and Fernandes 2009, severity 1, OKLab x 100,
// at least 8 under simulation), and every type keeps a colour of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const { cvd, normal } = await import('./_colour_science.mjs');
const { CATALOGUE, DEFAULT_QUICK_LABELS } = await import('../../electrotag/web/static/js/api/demo_catalogue.js');

const labels = JSON.parse(fs.readFileSync(path.join(REPO, 'electrotag', 'config', 'artifact_labels.json'), 'utf8')).labels;
const colour = (name) => labels.find((l) => l.label === name).colour;

test('the nine types of the numbered buttons stay apart under red-green colour blindness', () => {
  assert.equal(DEFAULT_QUICK_LABELS.length, 9);
  for (let i = 0; i < 9; i++) {
    for (let j = i + 1; j < 9; j++) {
      const [a, b] = [DEFAULT_QUICK_LABELS[i], DEFAULT_QUICK_LABELS[j]];
      const d = cvd(colour(a), colour(b));
      assert.ok(d >= 8, `${a} ${colour(a)} and ${b} ${colour(b)}: ${d.toFixed(1)} under simulated protanopia or deuteranopia`);
    }
  }
});

test('every type has a colour of its own, the same in the demonstration', () => {
  const seen = new Map();
  for (const l of labels) {
    assert.match(l.colour, /^#[0-9A-F]{6}$/, l.label);
    assert.ok(!seen.has(l.colour), `${l.label} shares ${l.colour} with ${seen.get(l.colour)}`);
    seen.set(l.colour, l.label);
    assert.equal(CATALOGUE.labels.find((x) => x.label === l.label).colour, l.colour, `${l.label} in demo_catalogue.js`);
  }
  // Movement and Chewing were given new colours for this; they stay clear of every other type.
  for (const name of ['Movement-artifact', 'Chewing-artifact']) {
    for (const l of labels) if (l.label !== name) assert.ok(normal(colour(name), l.colour) >= 10, `${name} and ${l.label}`);
  }
});
