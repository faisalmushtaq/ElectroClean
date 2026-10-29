// The channel chooser's rules (js/annotate/dialogs.js): finding channels by name, the 10-20 and
// 10-10 positions, and the group buttons for regions, sides, banks and types, as the desktop's
// channel dialog has them. The dialog itself is tried in Chromium (web_tests/e2e/j_channels.e2e.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { searchTerms, findChannels, tenTwentyPosition, channelGroups, toggleGroup, typeSuffixes, MANY_CHANNELS, BANK_BLOCK } =
  await import('../../electrotag/web/static/js/annotate/dialogs.js');
const { DEMO_CHANNELS, channelType } = await import('../../electrotag/web/static/js/data/synthetic.js');

const typed = (names, type = 'eeg') => names.map((name) => ({ name, type: typeof type === 'function' ? type(name) : type }));
const range = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
const biosemi = (banks) => [...[...'ABCDEFGH'].slice(0, banks).flatMap((b) => typed(range(b, 1, 32))), ...typed(range('EXG', 1, 8), 'misc')];
const demo = () => typed(DEMO_CHANNELS, channelType);
const TEN_TEN = ['Fp1', 'Fpz', 'Fp2', 'AF7', 'AF3', 'AFz', 'AF4', 'AF8', 'F7', 'F5', 'F3', 'F1', 'Fz', 'F2', 'F4', 'F6', 'F8',
  'FT7', 'FC5', 'FC3', 'FC1', 'FCz', 'FC2', 'FC4', 'FC6', 'FT8', 'T7', 'C5', 'C3', 'C1', 'Cz', 'C2', 'C4', 'C6', 'T8', 'TP7', 'CP5',
  'CP3', 'CP1', 'CPz', 'CP2', 'CP4', 'CP6', 'TP8', 'P7', 'P5', 'P3', 'P1', 'Pz', 'P2', 'P4', 'P6', 'P8', 'PO7', 'PO3', 'POz', 'PO4',
  'PO8', 'O1', 'Oz', 'O2', 'Iz', 'TP9', 'TP10'];
const found = (names, text) => {
  const f = findChannels(names, text);
  return f === null ? null : names.filter((n) => f.has(n));
};
const rows = (channels) => channelGroups(channels).map((r) => [r.caption, r.groups.map((g) => [g.name, g.channels.length])]);

test('the thresholds are the desktop\'s', () => {
  assert.equal(MANY_CHANNELS, 16);
  assert.equal(BANK_BLOCK, 32);
});

test('search terms are separated by commas, semicolons or spaces', () => {
  assert.deepEqual(searchTerms(''), []);
  assert.deepEqual(searchTerms('   '), []);
  assert.deepEqual(searchTerms(' Fp1, F3;C3  Cz,,'), ['Fp1', 'F3', 'C3', 'Cz']);
});

test('a term finds the names that begin with it, ignoring case', () => {
  const names = biosemi(4).map((c) => c.name);
  assert.equal(found(names, ''), null, 'nothing typed: every channel is listed');
  assert.deepEqual(found(names, 'b1'), ['B1', ...range('B', 10, 19)]);
  assert.deepEqual(found(names, 'B1'), found(names, 'b1'));
  assert.deepEqual(found(names, 'a3, d32'), ['A3', 'A30', 'A31', 'A32', 'D32']);
  assert.deepEqual(found(names, 'exg'), range('EXG', 1, 8));
  assert.deepEqual(found(DEMO_CHANNELS, 'c, p'), ['C3', 'Cz', 'C4', 'P7', 'P3', 'Pz', 'P4', 'P8']);
  assert.deepEqual(found(DEMO_CHANNELS, 'f'), ['Fp1', 'Fp2', 'F7', 'F3', 'Fz', 'F4', 'F8']);
  assert.deepEqual(found(DEMO_CHANNELS, 'q'), [], 'a term that finds nothing lists nothing');
});

test('a term that begins no name finds the names that contain it', () => {
  assert.deepEqual(found(DEMO_CHANNELS, 'z'), ['Fz', 'Cz', 'Pz']);
  assert.deepEqual(found(DEMO_CHANNELS, 'eog'), ['HEOG', 'VEOG']);
  assert.deepEqual(found(DEMO_CHANNELS, '1'), ['Fp1', 'O1']);
  // per term: "z" contains, "o" begins
  assert.deepEqual(found(DEMO_CHANNELS, 'z o'), ['Fz', 'Cz', 'Pz', 'O1', 'O2']);
});

test('EDF names are found by what follows "EEG "', () => {
  const names = ['EEG Fp1-REF', 'EEG Fp2-REF', 'EEG F3-REF', 'EEG C3-REF', 'EEG Cz-REF', 'EEG_Oz_LE', 'ECG'];
  assert.deepEqual(found(names, 'f'), ['EEG Fp1-REF', 'EEG Fp2-REF', 'EEG F3-REF']);
  assert.deepEqual(found(names, 'o'), ['EEG_Oz_LE']);
  assert.deepEqual(found(names, 'eeg'), names.slice(0, 6));
  assert.deepEqual(found(names, 'e'), names, 'every name begins with e');
});

test('a name in quotes finds that channel only; * and ? stand for any characters', () => {
  const egi = range('E', 1, 128);
  assert.deepEqual(found(egi, '"e1"'), ['E1']);
  assert.deepEqual(found(egi, "'E12'"), ['E12']);
  assert.deepEqual(found(egi, 'E1?'), range('E', 10, 19));
  assert.deepEqual(found(egi, '*8'), ['E8', 'E18', 'E28', 'E38', 'E48', 'E58', 'E68', 'E78', 'E88', 'E98', 'E108', 'E118', 'E128']);
  assert.deepEqual(found(TEN_TEN, '*z'), ['Fpz', 'AFz', 'Fz', 'FCz', 'Cz', 'CPz', 'Pz', 'POz', 'Oz', 'Iz']);
  assert.deepEqual(found(TEN_TEN, 'f?z'), ['Fpz', 'FCz']);
  assert.deepEqual(found(['A.1', 'AB1', 'A(1)'], 'a.*'), ['A.1'], 'other characters are taken literally');
  assert.deepEqual(found(['A.1', 'AB1', 'A(1)'], 'a(*'), ['A(1)']);
  // a quote being typed lists everything, then narrows as for any term
  assert.deepEqual(found(egi, '"'), egi);
  assert.deepEqual(found(egi, '"e12'), ['E12', ...range('E', 120, 128)]);
});

test('10-20 and 10-10 names give a region and a side, also as EDF files write them', () => {
  assert.deepEqual(tenTwentyPosition('Fp1'), { region: 'Frontal', side: 'Left' });
  assert.deepEqual(tenTwentyPosition('AF8'), { region: 'Frontal', side: 'Right' });
  assert.deepEqual(tenTwentyPosition('FCz'), { region: 'Central', side: 'Midline' });
  assert.deepEqual(tenTwentyPosition('CP3'), { region: 'Central', side: 'Left' });
  assert.deepEqual(tenTwentyPosition('FT7'), { region: 'Temporal', side: 'Left' });
  assert.deepEqual(tenTwentyPosition('TP10'), { region: 'Temporal', side: 'Right' });
  assert.deepEqual(tenTwentyPosition('P8'), { region: 'Parietal', side: 'Right' });
  assert.deepEqual(tenTwentyPosition('POz'), { region: 'Occipital', side: 'Midline' });
  assert.deepEqual(tenTwentyPosition('Iz'), { region: 'Occipital', side: 'Midline' });
  assert.deepEqual(tenTwentyPosition('EEG T3-REF'), { region: 'Temporal', side: 'Left' });
  assert.deepEqual(tenTwentyPosition('eeg_fp2_le'), { region: 'Frontal', side: 'Right' });
  assert.deepEqual(tenTwentyPosition('EEG O1-A2'), { region: 'Occipital', side: 'Left' });
  for (const name of ['A1', 'M2', 'EXG1', 'E12', 'HEOG', 'Status', 'FFC1h', 'EEG A1-REF', 'Fp1-F3']) {
    assert.equal(tenTwentyPosition(name), null, name);
  }
});

test('a 10-20 montage has Regions, Sides and Types', () => {
  const r = channelGroups(demo());
  assert.deepEqual(r.map((x) => x.caption), ['Regions', 'Sides', 'Types']);
  const groups = Object.fromEntries(r.flatMap((x) => x.groups.map((g) => [g.name, g.channels])));
  assert.deepEqual(groups.Frontal, ['Fp1', 'Fp2', 'F7', 'F3', 'Fz', 'F4', 'F8']);
  assert.deepEqual(groups.Central, ['C3', 'Cz', 'C4']);
  assert.deepEqual(groups.Temporal, ['T7', 'T8']);
  assert.deepEqual(groups.Parietal, ['P7', 'P3', 'Pz', 'P4', 'P8']);
  assert.deepEqual(groups.Occipital, ['O1', 'O2']);
  assert.deepEqual(groups.Left, ['Fp1', 'F7', 'F3', 'T7', 'C3', 'P7', 'P3', 'O1']);
  assert.deepEqual(groups.Midline, ['Fz', 'Cz', 'Pz']);
  assert.deepEqual(groups.Right, ['Fp2', 'F4', 'F8', 'C4', 'T8', 'P4', 'P8', 'O2']);
  assert.deepEqual(groups.EEG.length, 19);
  assert.deepEqual(groups.EOG, ['HEOG', 'VEOG']);
  assert.deepEqual(groups.ECG, ['ECG']);
});

test('a 10-10 montage of 64 channels: every channel in one region', () => {
  const r = rows(typed(TEN_TEN));
  assert.deepEqual(r, [
    ['Regions', [['Frontal', 17], ['Central', 21], ['Temporal', 8], ['Parietal', 9], ['Occipital', 9]]],
    ['Sides', [['Left', 27], ['Midline', 10], ['Right', 27]]],
  ]);
});

test('BioSemi montages have their banks, even with C1 to C32 among them', () => {
  assert.deepEqual(rows(biosemi(2)), [['Banks', [['A', 32], ['B', 32], ['EXG', 8]]], ['Types', [['EEG', 64], ['MISC', 8]]]]);
  const b128 = [...biosemi(4), { name: 'Status', type: 'stim' }];
  assert.deepEqual(rows(b128), [
    ['Banks', [['A', 32], ['B', 32], ['C', 32], ['D', 32], ['EXG', 8]]],
    ['Types', [['EEG', 128], ['MISC', 8], ['STIM', 1]]],
  ]);
  assert.deepEqual(channelGroups(b128)[0].groups[2].channels, range('C', 1, 32));
  assert.equal(rows(biosemi(8))[0][1].length, 9);
});

test('a bank of more than 32 channels is offered in blocks of 32', () => {
  const egi = typed([...range('E', 1, 128), 'Cz']);
  const r = channelGroups(egi);
  assert.deepEqual(r.map((x) => x.caption), ['Banks'], 'one type, and Cz alone is no 10-20 montage');
  assert.deepEqual(r[0].groups.map((g) => g.name), ['E1–E32', 'E33–E64', 'E65–E96', 'E97–E128']);
  assert.deepEqual(r[0].groups[1].channels, range('E', 33, 64));
  // EGI's 129th electrode alone makes no block; zero-padded names keep their spelling
  assert.deepEqual(rows(typed(range('E', 1, 129)))[0][1].map((g) => g[0]), ['E1–E32', 'E33–E64', 'E65–E96', 'E97–E128']);
  const padded = typed(Array.from({ length: 64 }, (_, i) => `E${String(i + 1).padStart(3, '0')}`));
  assert.deepEqual(rows(padded), [['Banks', [['E001–E032', 32], ['E033–E064', 32]]]]);
  // the 128-channel timing recording (A1 to A128), with its Status channel
  const perf = [...typed(range('A', 1, 128)), { name: 'Status', type: 'stim' }];
  assert.deepEqual(rows(perf), [
    ['Banks', [['A1–A32', 32], ['A33–A64', 32], ['A65–A96', 32], ['A97–A128', 32]]],
    ['Types', [['EEG', 128], ['STIM', 1]]],
  ]);
  // a block keeps the montage's order of its channels
  const shuffled = typed(['E40', 'E2', 'E33', 'E1', ...range('E', 3, 32), ...range('E', 34, 39)]);
  assert.deepEqual(channelGroups(shuffled)[0].groups.map((g) => [g.name, g.channels.slice(0, 2)]), [['E1–E32', ['E2', 'E1']], ['E33–E40', ['E40', 'E33']]]);
});

test('no group row that would only repeat Select all', () => {
  assert.deepEqual(rows(typed(range('E', 1, 20))), [], 'one bank of 20');
  assert.deepEqual(rows(typed(['Cz', 'Pz', 'Oz'])), [['Regions', [['Central', 1], ['Parietal', 1], ['Occipital', 1]]], ['Sides', [['Midline', 3]]]]);
  assert.deepEqual(rows([]), []);
});

test('a montage partly named by 10-20 (less than 60%) has banks instead', () => {
  const mixed = typed(['Fp1', 'Fp2', 'Cz', 'Pz', 'X1', 'X2', 'X3', 'Y1', 'Y2', 'Y3']);
  assert.deepEqual(rows(mixed), [['Banks', [['Fp', 2], ['X', 3], ['Y', 3]]]]);
  // channels of other types do not count towards the 60%
  const withExtras = [...typed(['Fp1', 'Fp2', 'Cz', 'Pz', 'X1', 'X2']), ...typed(range('EXG', 1, 8), 'misc')];
  assert.equal(rows(withExtras)[0][0], 'Regions');
  // channels without a type count as EEG; their type group reads OTHER
  assert.deepEqual(rows([{ name: 'A1' }, { name: 'A2' }, { name: 'B1' }, { name: 'B2', type: '' }, { name: 'Fz', type: 'eeg' }]),
    [['Banks', [['A', 2], ['B', 2]]], ['Types', [['OTHER', 4], ['EEG', 1]]]]);
});

test('a group button ticks all its channels, or clears them when all are ticked', () => {
  const picked = new Set(['A1', 'B5']);
  assert.equal(toggleGroup(picked, ['A1', 'A2', 'A3']), true);
  assert.deepEqual([...picked].sort(), ['A1', 'A2', 'A3', 'B5']);
  assert.equal(toggleGroup(picked, ['A1', 'A2', 'A3']), false);
  assert.deepEqual([...picked], ['B5']);
});

test('the type is shown only where it differs from the montage\'s and is not in the name', () => {
  const s = typeSuffixes([...biosemi(1), { name: 'Status', type: 'stim' }, { name: 'HEOG', type: 'eog' }, { name: 'Resp', type: '' }]);
  assert.deepEqual([...s], [...range('EXG', 1, 8).map((n) => [n, 'MISC']), ['Status', 'STIM']]);
  assert.equal(typeSuffixes(demo()).size, 0, 'HEOG, VEOG and ECG say their type already');
});
