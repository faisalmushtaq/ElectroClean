// The Annotations list in the side panel shows every label in full at the sizes annotators use
// (1280 × 720, 1440 × 900 and 1920 × 1080 on a computer, an iPad upright and on its side): each row
// gives the label the panel's whole width, with the channels, the rating, the note sign and the times
// on a second line. The rule is checked for all 29 types, with ratings, notes and channels, with the
// larger panel text, and with the long prefix of a training review; the row's title also carries
// the full label. Upright on an iPad, the buttons stand beside the list so that rows stay in view.
import { openExample, signIn, waitForRoute } from './helpers.mjs';

const SIZES = [
  { width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 },
  { width: 820, height: 1180, ipad: true }, { width: 1180, height: 820, ipad: true },
];
const REVIEW_PREFIX = 'TYPE: should be Horizontal-eye-movement · YOU: ';

/** Mark every type of the catalogue once: ratings on most, notes and channels on some. */
async function markEveryType(page) {
  return page.evaluate(() => {
    const ws = globalThis.ElectroTag.ws;
    const names = ws.cat.labelNames;
    const chans = ws.s.channels.slice(0, 2).map((c) => c.name);
    const step = (ws.s.recording.durationS - 1) / names.length;
    ws.store.reset(names.map((label, i) => ({
      annotation_id: `t${String(i).padStart(2, '0')}`, label, onset_sample: Math.round(i * step * ws.sf), duration_samples: Math.round(0.4 * ws.sf),
      channels: i % 4 === 1 ? chans : [], confidence: i % 3 === 2 ? null : (i % 5) + 1, note: i % 3 === 0 ? 'Could be an eye movement rather than a blink' : '',
    })));
    return names;
  });
}

/** For every row of the list: whether any part of it is cut short or reaches outside the list. */
async function listReport(page) {
  return page.evaluate(() => {
    const wrap = document.querySelector('.tab-panel[data-panel="annotations"] .table-wrap');
    const box = wrap.getBoundingClientRect();
    const right = box.left + wrap.clientLeft + wrap.clientWidth;
    const cut = (el) => el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().right > right + 1;
    const rows = [...wrap.querySelectorAll('tbody tr[data-id]')];
    return {
      sideways: wrap.scrollWidth > wrap.clientWidth + 1,
      visibleRows: rows.filter((tr) => { const r = tr.getBoundingClientRect(); return r.top >= box.top - 1 && r.bottom <= box.bottom + 1; }).length,
      rows: rows.map((tr) => {
        const text = tr.querySelector('.label-text');
        const parts = [text, tr.querySelector('td.label'), tr.querySelector('.ann-details'), ...tr.querySelectorAll('.ann-details > *')];
        return { label: tr.dataset.logText, shown: text.textContent, title: tr.title, cut: parts.filter(cut).map((el) => el.className || el.tagName) };
      }),
    };
  });
}

function checkList(assert, report, names, where) {
  assert.equal(report.rows.length, names.length, `${where}: one row per annotation`);
  assert.equal(report.sideways, false, `${where}: the list does not scroll sideways`);
  for (const r of report.rows) {
    assert.deepEqual(r.cut, [], `${where}: ${r.shown} is shown in full`);
    assert.ok(r.shown.endsWith(r.label), `${where}: the row shows the whole label ${r.label}`);
    assert.ok(r.title.startsWith(`${r.label} (`), `${where}: the row's title names ${r.label} and its code`);
  }
  assert.ok(report.visibleRows >= 3, `${where}: at least three rows in view (${report.visibleRows})`);
}

export const tests = [
  {
    name: 'every label in the Annotations list is shown in full at 1280 × 720, 1440 × 900, 1920 × 1080 and on an iPad, with ratings, notes, larger text and a review',
    async run(t) {
      const { assert } = t;
      for (const size of SIZES) {
        const where = `${size.width} × ${size.height}${size.ipad ? ' (iPad)' : ''}`;
        const page = await t.newPage(size);
        await signIn(page, 'A01');
        await waitForRoute(page, 'home');
        await openExample(page, 0);
        const names = await markEveryType(page);
        assert.equal(names.length, 29);
        await page.evaluate(() => globalThis.ElectroTag.ws.select(['t02']));
        checkList(assert, await listReport(page), names, where);
        // The second line: channels, then the rating and the note sign, then the times.
        const second = await page.locator('.ann-table tr[data-id="t01"] .ann-details').evaluate((el) => [...el.children].map((c) => c.className));
        assert.deepEqual(second, ['chans', 'conf-mark', 'ann-time'], `${where}: the second line of a channel-specific rated row`);
        assert.match(await page.locator('.ann-table tr[data-id="t00"] .ann-time').textContent(), /^0\.000–0\.400$/);
        if (size.width === 820) {
          const [list, buttons] = await Promise.all(['.ann-body > .table-wrap', '.ann-body > .btn-grid'].map((s) => page.locator(s).boundingBox()));
          assert.ok(buttons.x >= list.x + list.width, `${where}: the buttons stand beside the list`);
        }
        await t.screenshot(page, 'annotation_list');
        if (size.width === 1280) {
          // The larger panel text, chosen on the Recording tab.
          await page.click('.tab[data-tab="recording"]');
          await page.check('input[data-comfort="panel:large"]');
          await page.click('.tab[data-tab="annotations"]');
          assert.ok(await page.evaluate(() => document.querySelector('.ws-side').classList.contains('large-text')));
          checkList(assert, await listReport(page), names, `${where}, larger text`);
          await t.screenshot(page, 'annotation_list_large_text');
          // A training review puts "TYPE: should be … · YOU: " before a label; the row wraps and keeps the whole text.
          await page.evaluate((prefix) => {
            const ws = globalThis.ElectroTag.ws;
            ws.prefix = { t00: prefix };
            ws._refreshList();
          }, REVIEW_PREFIX);
          const report = await listReport(page);
          checkList(assert, report, names, `${where}, a review`);
          assert.equal(report.rows[0].shown, REVIEW_PREFIX + names[0]);
        }
        await page.context().close();
      }
    },
  },
];
