// One's own saved files of a recording (js/views/my_files.js, js/data/zip.js, js/api/demo_export.js):
// the zip made in the browser is read by Python's zipfile exactly; the files can also go one by one;
// the sandbox's events.tsv puts the original events and the artifacts in onset order, with the
// ratings and notes, as the server's build_events_table does (the parity test compares the two).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { zipBytes, crc32 } = await import('../../electrotag/web/static/js/data/zip.js');
const { filesToSave, WHAT_FILES } = await import('../../electrotag/web/static/js/views/my_files.js');
const { eventsTsv, exampleEventRows, edfEventRows } = await import('../../electrotag/web/static/js/api/demo_export.js');

function python() {
  for (const p of [process.env.ELECTROTAG_PYTHON, 'python3']) {
    if (p && spawnSync(p, ['-c', 'import zipfile'], { encoding: 'utf8' }).status === 0) return p;
  }
  return null;
}

test('the CRC-32 is the standard one', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('the zip holds the files exactly, as Python\'s zipfile reads them', { skip: !python() && 'no Python here' }, () => {
  const files = [{ name: 'sub-01_annotator-A01_events.tsv', text: 'onset\tduration\n3.0\t0.4\n' },
    { name: 'sub-01_annotator-A01_annotations.json', text: '{"note": "clear blink · Fp1"}\n' }, { name: 'empty.txt', text: '' }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-zip-'));
  const file = path.join(dir, 'mine.zip');
  fs.writeFileSync(file, zipBytes(files, new Date(2026, 9, 30, 16, 41, 7)));
  const r = spawnSync(python(), ['-I', '-c', `import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps([[i.filename, z.read(i).decode("utf-8"), list(i.date_time)] for i in z.infolist()]))`, file], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(got.map(([n, t]) => [n, t]), files.map((f) => [f.name, f.text]));
  assert.deepEqual(got[0][2], [2026, 10, 30, 16, 41, 6], 'the time, in two-second steps');
});

test('the files go as one zip named after the saved version, or one by one', async () => {
  const answer = { file_name: 'sub-01_annotator-A01.zip', files: [{ name: 'a_events.tsv', text: 'x\n' }, { name: 'a_annotations.json', text: '{}\n' }] };
  const [zip] = filesToSave(answer);
  assert.equal(zip.name, 'sub-01_annotator-A01.zip');
  assert.equal(zip.blob.type, 'application/zip');
  const head = new Uint8Array(await zip.blob.arrayBuffer()).slice(0, 4);
  assert.deepEqual([...head], [0x50, 0x4b, 0x03, 0x04]);
  const one = filesToSave(answer, { separate: true });
  assert.deepEqual(one.map((f) => [f.name, f.blob.type]), [['a_events.tsv', 'text/tab-separated-values'], ['a_annotations.json', 'application/json']]);
  assert.match(WHAT_FILES, /BIDS events\.tsv/);
  assert.match(WHAT_FILES, /ratings and notes/);
});

test('the sandbox\'s events.tsv: the example\'s events and the artifacts in onset order, with ratings and notes', () => {
  const ann = (id, label, onset, dur, channels, extra = {}) => ({ annotation_id: id, label, onset_sample: onset, duration_samples: dur, channels, ...extra });
  const tsv = eventsTsv({
    annotations: [ann('b', 'EMG-artifact', 2300, 400, []), ann('a', 'Eye-blink-artifact', 750, 100, ['Fp1', 'Fp2'], { confidence: 4, note: 'clear blink' })],
    sfreq: 250, annotatorId: 'A01', original: exampleEventRows([{ onsetS: 2, label: 'stimulus/1' }, { onsetS: 7.5, label: 'stimulus/2' }], 250), originalSource: 'events_tsv',
  });
  const rows = tsv.trimEnd().split('\n').map((l) => l.split('\t'));
  assert.deepEqual(rows[0], ['onset', 'duration', 'trial_type', 'value', 'sample', 'channels', 'artifact_code', 'event_source', 'annotation_id', 'annotator_id',
    'original_row', 'confidence', 'annotation_note']);
  assert.deepEqual(rows.slice(1).map((r) => [r[0], r[2], r[7]]), [['2', 'stimulus/1', 'original:events_tsv'], ['3.0', 'Eye-blink-artifact', 'electrotag_artifact'],
    ['7.5', 'stimulus/2', 'original:events_tsv'], ['9.2', 'EMG-artifact', 'electrotag_artifact']]);
  assert.deepEqual(rows[2], ['3.0', '0.4', 'Eye-blink-artifact', 'n/a', '750', '["Fp1","Fp2"]', '103', 'electrotag_artifact', 'a', 'A01', 'n/a', '4', 'clear blink']);
  assert.deepEqual(rows[4].slice(5), ['[]', '102', 'electrotag_artifact', 'b', 'A01', 'n/a', 'n/a', 'n/a'], 'whole montage, unrated, no note');
  assert.equal(rows[3][4], '1875', 'the sample of an original row, from its onset');
  // EDF+ annotations: MNE numbers the sorted texts from 1
  assert.deepEqual(edfEventRows([{ onset_sample: 500, label: 'b' }, { onset_sample: 250, label: 'a' }], 250).map((r) => r.cells),
    [['2.0', '0.0', 'b', '2', '500', 'n/a'], ['1.0', '0.0', 'a', '1', '250', 'n/a']]);
});
