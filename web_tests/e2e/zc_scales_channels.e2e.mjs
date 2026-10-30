// A team member's feedback of 30 October: the scales (the wheel changes the amplitude, Shift+wheel and a sideways
// trackpad movement move along time, a pinch or Ctrl+wheel shows more or less time, the toolbar's time and
// amplitude controls, Alt with the arrow keys for a precise start and end), choosing channels by dragging down
// their names (with Ctrl, Shift+click and Clear channel selection), channels marked bad for the whole recording
// (saved, restored from a draft and undone), Uncertain / needs review one key away and listed for the experts, and
// separate occurrences of one type kept apart across a brief gap. Runs in Chromium and in WebKit
// (node web_tests/run_e2e.mjs zc_scales --browser webkit).
import { annotations, clickDialogButton, drag, eegPoint, openExample, pressSave, signIn, state, waitForRoute } from './helpers.mjs';

const ws = (page, fn, arg) => page.evaluate(([src, a]) => (0, eval)(src)(globalThis.ElectroTag.ws, a), [String(fn), arg]);
const view = (page) => ws(page, (w) => ({ ...w.viewer.view }));

async function logged(page) {
  return page.evaluate(async () => {
    await globalThis.ElectroTag.flushLog();
    return [...globalThis.ElectroTag.backend.visits.values()].flatMap((vs) => vs.events);
  });
}

/** The centre of a channel's name at the left of the EEG (client coordinates). */
async function namePoint(page, name) {
  return page.evaluate((n) => {
    const v = globalThis.ElectroTag.ws.viewer;
    const r = v.over.getBoundingClientRect();
    const row = v.channels.findIndex((c) => c.name === n);
    return { x: r.left + v.x0 - 30, y: r.top + v.rowCentre(row) };
  }, name);
}

async function switchTo(page, id) {
  await page.evaluate(async () => { await globalThis.ElectroTag.signOut(); });
  const leave = page.locator('.dialog-buttons button', { hasText: /Keep|Sign out/ });
  if (await leave.count()) await leave.first().click();
  await signIn(page, id);
}

export const tests = [
  {
    name: 'the wheel changes the amplitude, Shift+wheel and a sideways scroll move along time, Ctrl+wheel shows more or less, and the toolbar sets both',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      const mid = await eegPoint(page, 5);
      await page.mouse.move(mid.x, mid.y);
      const v0 = await view(page);
      // the wheel alone: larger traces up, smaller down, the time shown unchanged
      await page.mouse.wheel(0, -100);
      await page.waitForFunction((f) => globalThis.ElectroTag.ws.viewer.view.scaleFactor > f, v0.scaleFactor);
      let v = await view(page);
      assert.ok(Math.abs(v.scaleFactor - v0.scaleFactor * 1.25) < 1e-6, `one notch up is one press of + (${v.scaleFactor})`);
      assert.equal(v.startS, v0.startS);
      assert.equal(v.durationS, v0.durationS);
      await page.mouse.wheel(0, 100);
      await page.waitForFunction((f) => Math.abs(globalThis.ElectroTag.ws.viewer.view.scaleFactor - f) < 1e-6, v0.scaleFactor);
      // the amplitude shown in the toolbar follows
      const amp = await page.textContent('.ws-scales .scale-value');
      assert.match(amp, /µV|mV/);
      await page.click('.ws-scales [data-log="amplitude-more"]');
      assert.notEqual(await page.textContent('.ws-scales .scale-value'), amp);
      // Shift+wheel: along time (the pointer back on the EEG)
      await page.mouse.move(mid.x, mid.y);
      await page.keyboard.down('Shift');
      await page.mouse.wheel(0, 200);
      await page.keyboard.up('Shift');
      await page.waitForFunction((s) => globalThis.ElectroTag.ws.viewer.view.startS > s, v0.startS);
      v = await view(page);
      assert.ok(v.startS > v0.startS, 'Shift+wheel moved along time');
      // a sideways scroll (two fingers on a trackpad): along time, back again
      const before = v.startS;
      await page.mouse.wheel(-150, 0);
      await page.waitForFunction((s) => globalThis.ElectroTag.ws.viewer.view.startS < s, before);
      // Ctrl+wheel (what a trackpad's pinch sends): more time, around the pointer
      const d0 = (await view(page)).durationS;
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, 60);
      await page.keyboard.up('Control');
      await page.waitForFunction((d) => globalThis.ElectroTag.ws.viewer.view.durationS > d, d0);
      // Safari's pinch on a Mac trackpad arrives as gesture events: the time shown follows the pinch
      const d1 = (await view(page)).durationS;
      await page.evaluate((p) => {
        const over = globalThis.ElectroTag.ws.viewer.over;
        const fire = (type, scale) => { const e = new Event(type, { cancelable: true }); Object.assign(e, { scale, clientX: p.x, clientY: p.y }); over.dispatchEvent(e); };
        fire('gesturestart', 1); fire('gesturechange', 2); fire('gestureend', 2);
      }, mid);
      assert.ok(Math.abs((await view(page)).durationS - d1 / 2) < 1e-6, 'pinching out shows half the time');
      // the toolbar's time scale: 1 to 60 s, the middle of the screen kept
      const opts = await page.$$eval('.ws-scales select option', (o) => o.map((x) => x.textContent));
      for (const s of ['1 s', '2 s', '5 s', '10 s', '20 s']) assert.ok(opts.includes(s), `${s} is offered (${opts.join(', ')})`);
      await page.selectOption('.ws-scales select', '2');
      await page.waitForFunction(() => globalThis.ElectroTag.ws.viewer.view.durationS === 2);
      assert.equal(await page.$eval('.ws-scales select', (s) => s.value), '2');
      await page.click('.ws-scales [data-log="time-more"]');
      await page.waitForFunction(() => globalThis.ElectroTag.ws.viewer.view.durationS === 5);
      await page.keyboard.press('End'); // the keys step through the same scales
      await page.waitForFunction(() => globalThis.ElectroTag.ws.viewer.view.durationS === 10);
      assert.equal(await page.$eval('.ws-scales select', (s) => s.value), '10');
      // nothing of the toolbar is cut off or overflows at this width
      const fits = await page.evaluate(() => {
        const bar = document.querySelector('.ws-toolbar').getBoundingClientRect();
        return [...document.querySelectorAll('.ws-scales > *')].every((e) => { const r = e.getBoundingClientRect(); return r.right <= bar.right + 1 && r.left >= bar.left - 1; });
      });
      assert.ok(fits, 'the scales fit in the toolbar');
      await t.screenshot(page, 'scales_toolbar');
      await page.waitForTimeout(400); // the view is logged once it settles
      const ev = await logged(page);
      assert.ok(ev.some((e) => e.type === 'wheel'), 'the wheel is logged');
      assert.ok(ev.some((e) => e.type === 'view' && e.scale_factor !== undefined));
    },
  },
  {
    name: 'a precise start and end: Alt with the arrow keys moves the selected mark\'s edges by 10 ms, each step undoable',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.5));
      const [a] = await annotations(page);
      await page.keyboard.press('n');
      const sf = await ws(page, (w) => w.sf);
      const step = Math.max(1, Math.round(0.01 * sf));
      await page.keyboard.press('Alt+ArrowLeft');
      await page.keyboard.press('Alt+ArrowLeft');
      await page.keyboard.press('Alt+Shift+ArrowRight');
      const [b] = await annotations(page);
      assert.equal(b.onset_sample, a.onset_sample - 2 * step);
      assert.equal(b.onset_sample + b.duration_samples, a.onset_sample + a.duration_samples + step);
      assert.match(await page.textContent('.ws-message'), /^End of .* at \d+\.\d{3} s/);
      await page.keyboard.press('Control+z');
      const [c] = await annotations(page);
      assert.equal(c.onset_sample + c.duration_samples, a.onset_sample + a.duration_samples);
      assert.equal(c.onset_sample, a.onset_sample - 2 * step);
    },
  },
  {
    name: 'channels chosen by dragging down their names, Ctrl+drag adds, Shift+click a range, X and the button clear them',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      const names = await ws(page, (w) => w.s.channels.map((c) => c.name));
      await drag(page, await namePoint(page, names[1]), await namePoint(page, names[4]));
      let s = await ws(page, (w) => ({ chosen: [...w.selectedChannels], scope: w.scope }));
      assert.deepEqual(s.chosen, names.slice(1, 5));
      assert.equal(s.scope, 'channels', 'a drag down the names switches to Selected channels');
      assert.match(await page.textContent('.ws-message'), /4 channels selected/);
      assert.equal(await page.isVisible('[data-log="clear-channels"]'), true);
      await t.screenshot(page, 'channels_dragged');
      // Ctrl (or Cmd) and a drag: added
      const mod = await page.evaluate(() => (/Mac/.test(navigator.platform) ? 'Meta' : 'Control'));
      await page.keyboard.down(mod);
      await drag(page, await namePoint(page, names[8]), await namePoint(page, names[9]));
      await page.keyboard.up(mod);
      s = await ws(page, (w) => [...w.selectedChannels]);
      assert.deepEqual(s, [...names.slice(1, 5), names[8], names[9]]);
      // X clears
      await page.keyboard.press('x');
      assert.deepEqual(await ws(page, (w) => [...w.selectedChannels]), []);
      // a click, then Shift+click: the range between
      const p2 = await namePoint(page, names[2]);
      await page.mouse.click(p2.x, p2.y);
      const p6 = await namePoint(page, names[6]);
      await page.keyboard.down('Shift');
      await page.mouse.click(p6.x, p6.y);
      await page.keyboard.up('Shift');
      assert.deepEqual(await ws(page, (w) => [...w.selectedChannels]), names.slice(2, 7));
      // the button clears too, and a drawn mark uses the channels chosen
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 2.0, names[3]), await eegPoint(page, 2.6, names[3]));
      assert.deepEqual((await annotations(page))[0].channels, names.slice(2, 7));
      await page.click('[data-log="clear-channels"]');
      assert.deepEqual(await ws(page, (w) => [...w.selectedChannels]), []);
      assert.equal(await page.isVisible('[data-log="clear-channels"]'), false);
      const ev = await logged(page);
      assert.ok(ev.some((e) => e.type === 'channel_selection_cleared' && e.via === 'button'));
      assert.ok(ev.some((e) => e.type === 'state' && Array.isArray(e.selected_channels) && e.selected_channels.length === 4));
    },
  },
  {
    name: 'a channel marked bad for the whole recording: from its name\'s menu and the chooser, undone, kept in the draft and saved',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 1);
      const names = await ws(page, (w) => w.s.channels.map((c) => c.name));
      const p = await namePoint(page, names[2]);
      await page.mouse.click(p.x, p.y, { button: 'right' });
      await page.waitForSelector('.menu.channel-menu');
      await t.screenshot(page, 'channel_menu');
      await page.locator('.menu .menu-item', { hasText: 'Mark as bad for the whole recording' }).click();
      assert.deepEqual(await ws(page, (w) => w.store.badChannels), [names[2]]);
      assert.deepEqual(await ws(page, (w) => [...w.viewer.markedBad]), [names[2]]);
      assert.match(await page.textContent('.ws-message'), /marked bad for the whole recording/);
      assert.match(await page.textContent('.ann-body .count'), new RegExp(`${names[2]} marked bad`));
      await t.screenshot(page, 'channel_marked_bad');
      // undone and redone with Ctrl+Z and Ctrl+Y
      await page.keyboard.press('Control+z');
      assert.deepEqual(await ws(page, (w) => w.store.badChannels), []);
      await page.keyboard.press('Control+y');
      assert.deepEqual(await ws(page, (w) => w.store.badChannels), [names[2]]);
      // the chooser: choose two, mark them bad
      await page.click('.ws-toolbar button:has-text("Channels…")');
      await page.waitForSelector('.dialog .channel-chooser');
      assert.equal(await page.locator('.dialog .channel-chip.marked-bad').count(), 1);
      await page.locator(`.dialog .channel-chip input[data-name="${names[5]}"]`).check();
      await page.locator(`.dialog .channel-chip input[data-name="${names[6]}"]`).check();
      await page.click('.dialog [data-log="channels-mark-bad"]');
      assert.deepEqual(await ws(page, (w) => w.store.badChannels), [names[2], names[5], names[6]]);
      const ev = await logged(page);
      const bad = ev.filter((e) => e.type === 'channel_bad');
      assert.ok(bad.some((e) => e.channel === names[2] && e.bad === true));
      assert.ok(bad.some((e) => e.bad === false && e.via === 'undo'));
      for (const e of bad) assert.deepEqual(Object.keys(e).filter((k) => /text|note|typed/.test(k)), [], 'no typed text is logged');
      // closed and opened again: the draft keeps them
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 2.0), await eegPoint(page, 2.5));
      await page.click('[data-log="close"]');
      await clickDialogButton(page, 'Close and finish later');
      await waitForRoute(page, 'home');
      await page.locator('ul.examples button').nth(1).click();
      await clickDialogButton(page, 'Restore and continue');
      await waitForRoute(page, 'annotate');
      await page.waitForFunction(() => globalThis.ElectroTag.ws && globalThis.ElectroTag.ws.store.badChannels.length === 3);
      assert.deepEqual(await ws(page, (w) => [...w.viewer.markedBad]), [names[2], names[5], names[6]]);
      // saved with the annotations
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title');
      const files = await page.evaluate(() => [...document.querySelectorAll('.dialog')].map((d) => d.textContent).join(' '));
      await clickDialogButton(page, 'Back to my recordings');
      await waitForRoute(page, 'home');
      const saved = (await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.ElectroTag.backend.state)))).submissions[0];
      assert.deepEqual(saved.bad_channels, [names[2], names[5], names[6]]);
      const doc = await page.evaluate(() => globalThis.ElectroTag.backend.resultsDocument());
      assert.deepEqual(doc.annotation_documents[0].bad_channels, [names[2], names[5], names[6]]);
      assert.ok(files.length > 0);
    },
  },
  {
    name: 'Uncertain / needs review is one key away, and an expert finds it in Saved work',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      assert.equal(await page.isVisible('.ws-toolbar .uncertain-chip'), true);
      await page.keyboard.press('0');
      assert.equal((await state(page)).currentLabel, 'Data-artifact');
      assert.equal(await page.getAttribute('.ws-toolbar .uncertain-chip', 'aria-pressed'), 'true');
      await drag(page, await eegPoint(page, 6.0), await eegPoint(page, 6.6));
      const [a] = await annotations(page);
      assert.equal(a.label, 'Data-artifact');
      assert.match(await page.textContent('.ann-table tbody'), /needs review/);
      await t.screenshot(page, 'uncertain_marked');
      // the numbered keys stay for the specific types: the uncertain one is not among them
      const chips = await page.$$eval('.ws-toolbar .chip-btn:not(.uncertain-chip)', (b) => b.map((x) => x.dataset.label));
      assert.ok(!chips.includes('Data-artifact'));
      // a selected mark changes to it with 0 too
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 8.0), await eegPoint(page, 8.4));
      await page.keyboard.press('n');
      await page.keyboard.press('n');
      await page.keyboard.press('0');
      assert.equal((await annotations(page)).filter((x) => x.label === 'Data-artifact').length, 2);
      await pressSave(page);
      await clickDialogButton(page, 'Save and Finish');
      await page.waitForSelector('.dialog .dialog-title');
      await clickDialogButton(page, 'Back to my recordings');
      await waitForRoute(page, 'home');
      // E01: Saved work lists the marks that need review, with a filter for them
      await switchTo(page, 'E01');
      await page.waitForFunction(() => { const a = globalThis.ElectroTag; return a && a.me && a.isExpert && /^(home|expert)/.test(a.route || ''); }, null, { timeout: 30000 });
      await page.evaluate(() => globalThis.ElectroTag.showExpert('expert-work'));
      await page.waitForSelector('[data-section="work"] tbody tr');
      const row = page.locator('[data-section="work"] tbody tr', { hasText: 'A01' }).first();
      assert.match(await row.textContent(), /2 marks need review/);
      await page.selectOption('[data-log="work-filter-review"]', 'yes');
      assert.equal(await page.locator('[data-section="work"] tbody tr', { hasText: 'A01' }).count(), 1);
      await t.screenshot(page, 'saved_work_needs_review');
    },
  },
  {
    name: 'separate occurrences stay separate across a brief gap; an overlap joins, says so, and Ctrl+Z takes it back',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      await page.keyboard.press('3');
      await drag(page, await eegPoint(page, 2.0), await eegPoint(page, 2.5));
      await page.keyboard.press('Escape');
      // the next starts four pixels after the first ends: a new mark, not the first one stretched
      const end = await eegPoint(page, 2.5);
      const later = await eegPoint(page, 3.0);
      await drag(page, { x: end.x + 4, y: end.y }, later);
      await page.keyboard.press('Escape');
      let list = await annotations(page);
      assert.equal(list.length, 2, 'two occurrences with a gap between them');
      assert.ok(list[0].onset_sample + list[0].duration_samples < list[1].onset_sample, 'with the gap kept');
      // a third that overlaps the second: joined, and the line at the bottom says so
      await drag(page, await eegPoint(page, 2.9), await eegPoint(page, 3.4));
      list = await annotations(page);
      assert.equal(list.length, 2);
      assert.match(await page.textContent('.ws-message'), /Merged with 1 overlapping .* annotation/);
      await page.keyboard.press('Control+z');
      assert.equal((await annotations(page)).length, 2);
      assert.equal((await annotations(page))[1].onset_sample, list[1].onset_sample);
    },
  },
];
