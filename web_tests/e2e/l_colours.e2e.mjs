// Channels coloured by group: the Recording tab's "Colour channels by" (none, region, side, type)
// with its legend, the choice remembered for the annotator, the study's default, bad channels kept
// grey, and a 128-channel 10-10 montage. Screenshots of each mode are saved with --screenshots.
import { signIn, waitForRoute, waitForTraces } from './helpers.mjs';
import { DEMO_CHANNELS } from '../../electrotag/web/static/js/data/synthetic.js';

async function openSynthetic(page, channels, id, durationS = 20) {
  await page.evaluate(async ([channels, id, durationS]) => {
    const { makeSyntheticRecording } = await import(new URL('js/data/synthetic.js', location.href).href);
    const recording = makeSyntheticRecording({ id, stem: `sub-${id}_task-rest`, sfreq: 256, durationS, seed: 3, channels, artifacts: [] });
    await globalThis.ElectroTag.openWorkspace({ recording, match: { status: 'unknown' }, sha: '', tryOut: true });
  }, [channels, id, durationS]);
  await waitForTraces(page);
}

async function choose(page, mode) {
  await page.click('[data-tab="recording"]');
  await page.selectOption('#channel-colours', mode);
  await page.waitForTimeout(100);
  return page.evaluate(() => {
    const ws = globalThis.ElectroTag.ws;
    const v = ws.viewer;
    return {
      mode: ws.channelColourMode,
      colours: v.channelColours ? Object.fromEntries(v.channelColours) : null,
      legend: [...document.querySelectorAll('.channel-legend li')].map((li) => li.textContent),
      legendShown: !document.querySelector('.channel-legend').hidden,
    };
  });
}

async function close(page) {
  await page.click('[data-log="close"]');
  await page.locator('.dialog-buttons button').first().waitFor({ timeout: 3000 }).then(() => page.locator('.dialog-buttons button', { hasText: /Close|Discard/ }).first().click()).catch(() => {});
  await waitForRoute(page, 'home');
}

/** 10-10 names, as far as 128 channels go (every name the channel grouping places). */
function tenTenNames(n) {
  const out = [];
  for (const row of ['FP', 'AF', 'F', 'FT', 'FC', 'T', 'C', 'TP', 'CP', 'P', 'PO', 'O', 'I']) {
    for (const k of [9, 7, 5, 3, 1, 'z', 2, 4, 6, 8, 10]) out.push(`${row[0]}${row.slice(1).toLowerCase()}${k}`);
  }
  return out.slice(0, n);
}

export const tests = [
  {
    name: 'colour channels by region, side or type, with a legend; remembered; bad channels stay grey',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1600, height: 950 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openSynthetic(page, DEMO_CHANNELS, 'colours');
      let s = await page.evaluate(() => ({ mode: globalThis.ElectroTag.ws.channelColourMode, colours: globalThis.ElectroTag.ws.viewer.channelColours }));
      assert.deepEqual(s, { mode: 'off', colours: null }, 'off unless the study or the annotator says otherwise');

      s = await choose(page, 'region');
      assert.equal(s.colours.Fp1, '#4360E6');
      assert.equal(s.colours.C3, '#4A7D23');
      assert.equal(s.colours.T7, '#74209C');
      assert.equal(s.colours.P3, '#90609A');
      assert.equal(s.colours.HEOG, undefined, 'EOG keeps the ink colour by region');
      assert.deepEqual(s.legend, ['Frontal7', 'Central3', 'Temporal2', 'Parietal5', 'Occipital2', 'Other3']);
      await t.screenshot(page, 'colours_region');
      s = await choose(page, 'side');
      assert.deepEqual(s.legend, ['Left8', 'Right8', 'Midline3', 'Other3']);
      assert.equal(s.colours.Cz, undefined, 'the midline keeps the ink colour');
      await t.screenshot(page, 'colours_side');
      s = await choose(page, 'type');
      assert.deepEqual(s.legend, ['EOG2', 'ECG1', 'EEG19']);
      await t.screenshot(page, 'colours_type');

      // a bad channel keeps its grey, whatever its group
      const bad = await page.evaluate(() => {
        const v = globalThis.ElectroTag.ws.viewer;
        const ch = v.channels.find((c) => c.name === 'VEOG');
        const before = v.groupColour(ch);
        ch.bad = true;
        v.invalidate(['under', 'traces']);
        return { before, after: v.groupColour(ch) };
      });
      assert.deepEqual(bad, { before: '#4360E6', after: null });

      // remembered for this annotator in this browser
      s = await choose(page, 'region');
      await close(page);
      await openSynthetic(page, DEMO_CHANNELS, 'colours2');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.channelColourMode), 'region');
      assert.equal(await page.inputValue('#channel-colours'), 'region');
      s = await choose(page, 'off');
      assert.equal(s.colours, null);
      assert.equal(s.legendShown, false);
      const events = await page.evaluate(() => globalThis.ElectroTag.debugState().loggedEvents);
      assert.ok(events > 0);
      await close(page);

      // the study's default, for an annotator who has not chosen
      await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) if (k.startsWith('electrotag.channel_colours')) localStorage.removeItem(k);
        globalThis.ElectroTag.me.study.display.channel_colours = 'side';
      });
      await openSynthetic(page, DEMO_CHANNELS, 'colours3');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.channelColourMode), 'side');
    },
  },
  {
    name: 'a 128-channel 10-10 montage by region, and a BioSemi montage left in ink',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 720 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      const names = tenTenNames(128);
      await openSynthetic(page, names, 'tenten', 10);
      const s = await choose(page, 'region');
      assert.equal(Object.keys(s.colours).length, 128);
      await page.evaluate(() => globalThis.ElectroTag.ws.viewer.setView({ nChannels: 64 }, 'test'));
      await page.waitForTimeout(300);
      await t.screenshot(page, 'colours_128_region');
      await choose(page, 'side');
      await t.screenshot(page, 'colours_128_side');
      await close(page);
      const banks = [...'ABCD'].flatMap((b) => Array.from({ length: 32 }, (_, i) => `${b}${i + 1}`));
      await openSynthetic(page, banks, 'biosemi', 10);
      const b = await choose(page, 'region');
      assert.equal(b.colours, null, 'BioSemi\'s C1 to C32 are a bank, not central sites');
      assert.deepEqual(b.legend, ['Other128']);
    },
  },
];
