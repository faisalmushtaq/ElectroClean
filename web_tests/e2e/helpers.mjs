// Helpers shared by the end-to-end tests.

/** Thrown by a test that cannot run here yet (the runner reports it as skipped, with the reason). */
export class SkipTest extends Error {
  constructor(reason) {
    super(reason);
    this.skip = true;
  }
}

export async function signIn(page, id = 'A01', password = 'demo') {
  await page.waitForSelector('#signin-id');
  await page.fill('#signin-id', id);
  await page.fill('#signin-password', password);
  await page.click('form.signin-form button[type="submit"]');
  // Signing in ends in the logging notice (when the study logs, before the first view), in another
  // view, or in an error on the sign-in view. A busy computer or a cold Firebase function can take a
  // while, so wait for whichever comes first, then answer the notice: the application waits for it.
  await page.waitForFunction(() => Boolean(document.querySelector('.dialog.logging-notice'))
    || (globalThis.ElectroClean && globalThis.ElectroClean.route !== 'signin')
    || document.querySelector('form.signin-form .error:not([hidden])') !== null, null, { timeout: 60000 });
  const notice = page.locator('.dialog.logging-notice button', { hasText: 'Continue' });
  if (await notice.count()) await notice.click();
}

export async function state(page) {
  return page.evaluate(() => globalThis.ElectroClean.debugState());
}

export async function waitForRoute(page, route, timeout = 15000) {
  await page.waitForFunction((r) => globalThis.ElectroClean && globalThis.ElectroClean.route === r, route, { timeout });
}

/** Wait until the viewer has drawn traces. */
export async function waitForTraces(page) {
  await page.waitForFunction(() => {
    const ws = globalThis.ElectroClean.ws;
    return ws && ws.viewer._cache && ws.viewer.stats.traceMs > 0;
  }, null, { timeout: 15000 });
}

/** Client coordinates of time t (s) on channel `name` (or the middle of the plot). */
export async function eegPoint(page, t, name = null) {
  return page.evaluate(([t, name]) => {
    const v = globalThis.ElectroClean.ws.viewer;
    const r = v.over.getBoundingClientRect();
    let y = (v.y0 + v.y1) / 2;
    if (name) {
      const row = v.channels.findIndex((c) => c.name === name);
      y = v.rowCentre(row);
    }
    const x = r.left + v.tToX(t);
    // WebKit (Safari's engine) reports the pointer in whole pixels: aim at the pixel at or just after t.
    const webkit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
    return { x: webkit ? Math.ceil(x) : x, y: r.top + y };
  }, [t, name]);
}

export async function drag(page, a, b, { shift = false } = {}) {
  await page.mouse.move(a.x, a.y);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.down();
  const steps = 8;
  for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

export async function annotations(page) {
  return (await state(page)).annotations;
}

/**
 * Press Save and Finish and wait for its question. When it first lists the parts of the recording not
 * yet viewed (the study's coverage check), choose Save anyway.
 */
export async function pressSave(page) {
  await page.click('.ws-actions button.primary');
  await page.waitForSelector('.dialog');
  if (await page.locator('.dialog.coverage-check').count()) {
    await clickDialogButton(page, 'Save anyway');
    await page.waitForSelector('.dialog:not(.coverage-check)');
  }
}

export async function clickDialogButton(page, text) {
  const b = page.locator('.dialog-buttons button', { hasText: text });
  await b.first().waitFor({ timeout: 8000 });
  await b.first().click();
}

/** Open a built-in example from the home view and wait for the EEG. */
export async function openExample(page, index = 0) {
  await page.locator('ul.examples button').nth(index).click();
  await waitForRoute(page, 'annotate');
  await waitForTraces(page);
}
