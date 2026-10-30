// The channel chooser (Channels… in the annotation view) for high-density montages: the
// 128-channel recording of the timing test (E1 to E128, as EGI names them) laid out in columns,
// banks ticked with one click, channels found by name, "Show chosen only", and the channels chosen
// becoming the selection; a 10-20 montage with its regions and sides; a BioSemi montage with its
// banks; and a small montage keeping the plain list it always had.
import { signIn, waitForRoute, waitForTraces, clickDialogButton } from './helpers.mjs';
import { DEMO_CHANNELS } from '../../electrotag/web/static/js/eeg/synthetic.js';

const range = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

async function openSynthetic(page, channels, id) {
  await page.evaluate(async ([channels, id]) => {
    const { makeSyntheticRecording } = await import(new URL('js/eeg/synthetic.js', location.href).href);
    const recording = makeSyntheticRecording({ id, stem: `sub-${id}_task-rest`, sfreq: 256, durationS: 20, seed: 3, channels, artifacts: [] });
    await globalThis.ElectroTag.openWorkspace({ recording, match: { status: 'unknown' }, sha: '', tryOut: true });
  }, [channels, id]);
  await waitForTraces(page);
}

async function openChooser(page) {
  await page.click('.ws-toolbar button:has-text("Channels…")');
  await page.waitForSelector('.dialog .channel-chooser');
}

/** What the open chooser shows: count, chips shown, group buttons, its columns and its size. */
async function chooser(page) {
  return page.evaluate(() => {
    const box = document.querySelector('.dialog');
    const grid = box.querySelector('.channel-grid');
    const chips = [...grid.querySelectorAll('.channel-chip')];
    const shown = chips.filter((c) => !c.hidden);
    const rect = box.getBoundingClientRect();
    return {
      many: box.querySelector('.channel-chooser').classList.contains('many'),
      count: box.querySelector('.channel-count').textContent,
      shown: shown.map((c) => c.querySelector('input').dataset.name),
      ticked: chips.filter((c) => c.querySelector('input').checked).map((c) => c.querySelector('input').dataset.name),
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      rows: [...box.querySelectorAll('.channel-groups-caption')].map((c) => c.textContent),
      groups: [...box.querySelectorAll('.channel-groups-row button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
      placeholder: box.querySelector('input[type="search"]').placeholder,
      focused: document.activeElement === box.querySelector('input[type="search"]'),
      buttons: [...box.querySelectorAll('.channel-chooser > .row button')].map((b) => b.textContent),
      fits: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
      clipped: shown.filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.textContent),
    };
  });
}

const group = (page, name) => page.click(`.channel-groups-row button[data-log="channel-group-${name}"]`);

export const tests = [
  {
    name: 'the channel chooser with 128 channels: columns, banks, finding by name, chosen only',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 720 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openSynthetic(page, range('E', 1, 128), 'egi');
      await openChooser(page);
      let c = await chooser(page);
      assert.equal(c.many, true);
      assert.equal(c.shown.length, 128);
      assert.ok(c.columns >= 8, `${c.columns} columns`);
      assert.ok(c.fits, 'the dialog fits a 1280 × 720 window');
      assert.deepEqual(c.clipped, [], 'every name in full');
      assert.ok(c.focused, 'typing finds channels straight away');
      assert.deepEqual(c.rows, ['Banks']);
      assert.deepEqual(c.groups, [['E1–E32 (32)', 'false'], ['E33–E64 (32)', 'false'], ['E65–E96 (32)', 'false'], ['E97–E128 (32)', 'false']]);
      assert.equal(c.count, '0 of 128 channels chosen');
      assert.deepEqual(c.buttons, ['Select all', 'Clear all']);
      await t.screenshot(page, 'channels_128');

      // one click ticks a bank, a second clears it
      await group(page, 'E33–E64');
      c = await chooser(page);
      assert.deepEqual(c.ticked, range('E', 33, 64));
      assert.equal(c.count, '32 of 128 channels chosen');
      assert.deepEqual(c.groups[1], ['E33–E64 (32)', 'true']);
      await group(page, 'E33–E64');
      assert.equal((await chooser(page)).ticked.length, 0);

      // names or their beginnings, separated by commas
      await page.fill('.dialog input[type="search"]', 'e1, e64');
      c = await chooser(page);
      assert.deepEqual(c.shown, ['E1', ...range('E', 10, 19), 'E64', ...range('E', 100, 128)]);
      assert.equal(c.count, `0 of 128 channels chosen · ${c.shown.length} shown`);
      assert.deepEqual(c.buttons, [`Select ${c.shown.length} shown`, 'Clear shown']);
      await page.fill('.dialog input[type="search"]', '"e1"');
      assert.deepEqual((await chooser(page)).shown, ['E1']);
      await page.fill('.dialog input[type="search"]', 'E1?');
      c = await chooser(page);
      assert.deepEqual(c.shown, range('E', 10, 19));
      await page.click('.dialog [data-log="channels-select-shown"]');
      await page.fill('.dialog input[type="search"]', '');
      await group(page, 'E97–E128');
      c = await chooser(page);
      assert.deepEqual(c.ticked, [...range('E', 10, 19), ...range('E', 97, 128)]);
      // only the channels chosen
      await page.check('.dialog [data-log="channels-chosen-only"]');
      c = await chooser(page);
      assert.deepEqual(c.shown, c.ticked);
      assert.equal(c.count, `42 of 128 channels chosen · 42 shown`);
      await page.uncheck('.dialog [data-log="channels-chosen-only"]');
      assert.equal((await chooser(page)).shown.length, 128);
      await clickDialogButton(page, 'OK');
      const ws = await page.evaluate(() => ({ chosen: [...globalThis.ElectroTag.ws.selectedChannels], scope: globalThis.ElectroTag.ws.scope }));
      assert.deepEqual(ws.chosen, [...range('E', 10, 19), ...range('E', 97, 128)]);
      assert.equal(ws.scope, 'channels');

      // the log names the buttons; the text typed to find channels is never kept
      const events = await page.evaluate(async () => {
        await globalThis.ElectroTag.flushLog();
        return [...globalThis.ElectroTag.backend.visits.values()].flatMap((v) => v.events);
      });
      assert.ok(events.some((e) => e.type === 'mouse_press' && e.name === 'channel-group-E97–E128' && e.text === 'E97–E128 (32)'), 'the bank button in the log');
      assert.ok(!JSON.stringify(events).includes('E1?') && !JSON.stringify(events).includes('"e1"'), 'no search text in the log');
    },
  },
  {
    name: 'the channel chooser for 10-20, BioSemi and small montages',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 720 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');

      // the demonstration's 10-20 montage: regions, sides and types
      await openSynthetic(page, DEMO_CHANNELS, 'tentwenty');
      await openChooser(page);
      let c = await chooser(page);
      assert.deepEqual(c.rows, ['Regions', 'Sides', 'Types']);
      assert.deepEqual(c.groups.map((g) => g[0]), ['Frontal (7)', 'Central (3)', 'Temporal (2)', 'Parietal (5)', 'Occipital (2)',
        'Left (8)', 'Midline (3)', 'Right (8)', 'EEG (19)', 'EOG (2)', 'ECG (1)']);
      await group(page, 'Frontal');
      await group(page, 'EOG');
      c = await chooser(page);
      assert.deepEqual(c.ticked, ['Fp1', 'Fp2', 'F7', 'F3', 'Fz', 'F4', 'F8', 'HEOG', 'VEOG']);
      await page.fill('.dialog input[type="search"]', 'z');
      assert.deepEqual((await chooser(page)).shown, ['Fz', 'Cz', 'Pz'], 'a term that begins no name finds the names containing it');
      await t.screenshot(page, 'channels_1020');
      await clickDialogButton(page, 'Cancel');
      assert.deepEqual(await page.evaluate(() => [...globalThis.ElectroTag.ws.selectedChannels]), [], 'Cancel changes nothing');

      // Whole montage, as for an annotation's channels: a group button chooses "Only these channels" by itself
      const pending = page.evaluate(async () => {
        const { chooseChannels } = await import(new URL('js/annotate/dialogs.js', location.href).href);
        globalThis.__chosen = await chooseChannels({ title: 'Channels affected', channels: globalThis.ElectroTag.ws.s.channels, chosen: [], allowWholeMontage: true, wholeMontage: true });
      });
      await page.waitForSelector('.dialog .channel-chooser');
      c = await chooser(page);
      assert.equal(c.count, 'The annotation applies to every channel. Choose a channel to apply it to only some.');
      assert.equal(await page.isDisabled('.channel-groups-row button[data-log="channel-group-Left"]'), false);
      await group(page, 'Left');
      assert.equal(await page.isChecked('#scope-some'), true);
      await clickDialogButton(page, 'OK');
      await pending;
      assert.deepEqual(await page.evaluate(() => globalThis.__chosen), { wholeMontage: false, channels: ['Fp1', 'F7', 'F3', 'T7', 'C3', 'P7', 'P3', 'O1'] });

      // BioSemi: banks A to D and the external channels
      await openSynthetic(page, [...range('A', 1, 32), ...range('B', 1, 32), ...range('C', 1, 32), ...range('D', 1, 32), ...range('EXG', 1, 8)], 'biosemi');
      await openChooser(page);
      c = await chooser(page);
      assert.deepEqual(c.rows, ['Banks', 'Types']);
      assert.deepEqual(c.groups.map((g) => g[0]), ['A (32)', 'B (32)', 'C (32)', 'D (32)', 'EXG (8)', 'EEG (128)', 'MISC (8)']);
      assert.ok(c.fits);
      assert.deepEqual(c.clipped, []);
      await group(page, 'C');
      assert.deepEqual((await chooser(page)).ticked, range('C', 1, 32));
      await t.screenshot(page, 'channels_biosemi');
      await clickDialogButton(page, 'Cancel');

      // a small montage keeps the plain list
      await openSynthetic(page, ['Cz', 'Pz', 'Oz', 'VEOG'], 'small');
      await openChooser(page);
      c = await chooser(page);
      assert.equal(c.many, false);
      assert.deepEqual(c.rows, []);
      assert.equal(c.placeholder, 'Filter by name');
      assert.deepEqual(c.buttons, ['Select all', 'Clear all'], 'the same buttons as in a large montage');
      assert.equal(c.count, '0 of 4 channels chosen');
      await page.fill('.dialog input[type="search"]', 'z');
      assert.deepEqual((await chooser(page)).shown, ['Cz', 'Pz', 'Oz']);
      await page.click('.dialog [data-log="channels-select-shown"]');
      await clickDialogButton(page, 'OK');
      assert.deepEqual(await page.evaluate(() => [...globalThis.ElectroTag.ws.selectedChannels]), ['Cz', 'Pz', 'Oz']);
    },
  },
];
