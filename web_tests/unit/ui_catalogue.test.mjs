// The demonstration's copy of the label catalogue and settings is the desktop application's.
// (Regenerate it with: python web_tests/make_demo_catalogue.py)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOGUE, CATALOGUE_NAME, DEFAULT_QUICK_LABELS, DEFAULT_SCALINGS, DEFAULT_SETTINGS } from '../../electrotag/web/static/js/api/demo_catalogue.js';
import { Catalogue, displayCode } from '../../electrotag/web/static/js/catalogue.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(REPO, p), 'utf8'));

test('the same 29 artifact types, codes, colours and descriptions as artifact_labels.json', () => {
  const file = read('electrotag/config/artifact_labels.json');
  const src = file.labels;
  assert.equal(CATALOGUE_NAME, `${file.catalogue_id} ${file.catalogue_version}`);
  const byLabel = new Map(CATALOGUE.labels.map((l) => [l.label, l]));
  assert.equal(CATALOGUE.labels.length, src.length);
  for (const s of src) {
    const l = byLabel.get(s.label);
    assert.ok(l, s.label);
    for (const k of ['value', 'short_code', 'colour', 'section', 'description']) assert.equal(l[k], s[k], `${s.label} ${k}`);
    assert.equal(l.is_group, s.kind !== 'specific', `${s.label} is_group`);
    assert.equal(l.parent, s.parent ?? null, `${s.label} parent`);
  }
});

test('the same quick types, scalings and filters as default_settings.json', () => {
  const s = read('electrotag/config/default_settings.json');
  assert.deepEqual(DEFAULT_QUICK_LABELS, s.annotation.quick_labels);
  assert.deepEqual(DEFAULT_SCALINGS, s.display.scalings);
  // every block the admin area shows, as the study server's settings_get gives them
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS), ['filters', 'display', 'channels', 'selection', 'logging', 'annotation', 'loading', 'discovery', 'gamification',
    'review', 'training', 'replay']);
  for (const [block, values] of Object.entries(DEFAULT_SETTINGS)) assert.deepEqual(values, s[block], block);
});

test('the catalogue helpers', () => {
  const c = new Catalogue(CATALOGUE);
  assert.equal(c.labelText('Eye-artifact'), 'Eye-artifact  (132)  – exact type unclear');
  assert.deepEqual(c.quickLabels(['EMG-artifact', 'Nope', 'Eye-blink-artifact']), ['EMG-artifact', 'Eye-blink-artifact']);
  assert.equal(c.quickLabels([]).length, 9);
  assert.ok(Catalogue.matches(c.get('Eye-blink-artifact'), 'blink'));
  assert.ok(Catalogue.matches(c.get('Eye-blink-artifact'), '103'));
  assert.ok(Catalogue.matches(c.get('Electrode-pops-artifact'), 'electrode pop'));
  assert.ok(!Catalogue.matches(c.get('Electrode-pops-artifact'), 'blink'));
  assert.deepEqual(c.sections().map((s) => s.section), ['Eye', 'Other biological', 'Non-biological', 'Type unknown']);
});

test('short codes are shown in ordinary case, acronyms in capitals', () => {
  assert.equal(displayCode('BLINK'), 'Blink');
  assert.equal(displayCode('ARTIFACT'), 'Artifact');
  assert.equal(displayCode('ELMOVE'), 'Elmove');
  for (const acronym of ['EMG', 'ECG', 'HEM', 'VEM', 'SEM']) assert.equal(displayCode(acronym), acronym);
  assert.equal(displayCode('Mixed'), 'Mixed'); // a code a study wrote in its own case is left alone
  assert.equal(displayCode(''), '');
});
