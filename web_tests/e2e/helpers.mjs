// Helpers shared by the end-to-end tests.

export async function signIn(page, id = 'A01', password = 'demo') {
  await page.waitForSelector('#signin-id');
  await page.fill('#signin-id', id);
  await page.fill('#signin-password', password);
  await page.click('form.signin-form button[type="submit"]');
  // The logging notice (shown once after signing in when the study logs).
  const notice = page.locator('.dialog.logging-notice button', { hasText: 'Continue' });
  await notice.waitFor({ timeout: 8000 }).then(() => notice.click()).catch(() => {});
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
    return { x: r.left + v.tToX(t), y: r.top + y };
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
