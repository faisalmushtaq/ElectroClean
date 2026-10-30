// Channels in a sentence (channelList in js/util.js), as the adjudication, the snippets and the
// annotation view's messages write them: short however many channels a mark has.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { channelList } = await import('../../electrotag/web/static/js/util.js');
const range = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
const BIOSEMI = [...'ABCDEFGH'].flatMap((b) => range(b, 1, 32));

test('a few channels are named as they are', () => {
  assert.equal(channelList(['Fp1']), 'Fp1');
  assert.equal(channelList(['Fp1', 'F7', 'F3']), 'Fp1, F7 and F3');
  assert.equal(channelList(range('E', 1, 8), range('E', 1, 256)), 'E1, E2, E3, E4, E5, E6, E7 and E8');
});

test('many channels are written as runs in the montage\'s order', () => {
  assert.equal(channelList(BIOSEMI.slice(0, 180), BIOSEMI), '180 channels: A1–F20');
  assert.equal(channelList(BIOSEMI.slice(180), BIOSEMI), '76 channels: F21–H32');
  // given in another order, written in the montage's
  assert.equal(channelList([...BIOSEMI.slice(0, 40)].reverse(), BIOSEMI), '40 channels: A1–B8');
  const scattered = [...range('E', 1, 12), 'E20', 'E22', ...range('E', 31, 57)];
  assert.equal(channelList(scattered, range('E', 1, 256)), '41 channels: E1–E12, E20, E22, E31–E57');
});

test('past eight parts the rest are counted, and names outside the montage come last', () => {
  const every3 = range('E', 1, 256).filter((_, i) => i % 3 === 0);
  const text = channelList(every3, range('E', 1, 256));
  assert.match(text, /^86 channels: E1, E4, E7, E10, E13, E16, E19, E22 and 78 more$/);
  assert.equal(channelList([...range('E', 1, 9), 'X1'], range('E', 1, 9)), '10 channels: E1–E9, X1');
  assert.ok(channelList(BIOSEMI, BIOSEMI).length < 40, 'all 256 in a few words');
});
