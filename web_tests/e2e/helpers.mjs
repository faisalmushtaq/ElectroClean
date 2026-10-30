// Helpers shared by the end-to-end tests.

/** Thrown by a test that cannot run here yet (the runner reports it as skipped, with the reason). */
export class SkipTest extends Error {
  constructor(reason) {
    super(reason);
    this.skip = true;
  }
}

/**
 * Sign in. A new account's first sign-in shows the sign-up questionnaire, which is answered here (with
 * answerQuestionnaire) so that the test goes on where the person starts; `{ questionnaire: 'stay' }`
 * leaves it on the screen, for the tests of the questionnaire itself.
 */
export async function signIn(page, id = 'A01', password = 'demo', { questionnaire = 'answer' } = {}) {
  await page.waitForSelector('#signin-id');
  await page.fill('#signin-id', id);
  await page.fill('#signin-password', password);
  await page.click('form.signin-form button[type="submit"]');
  // Signing in ends in the logging notice (when the study logs, before the first view), in another
  // view, or in an error on the sign-in view. A busy computer or a cold Firebase function can take a
  // while, so wait for whichever comes first, then answer the notice: the application waits for it.
  await page.waitForFunction(() => Boolean(document.querySelector('.dialog.logging-notice'))
    || (globalThis.ElectroTag && globalThis.ElectroTag.route !== 'signin')
    || document.querySelector('form.signin-form .error:not([hidden])') !== null, null, { timeout: 60000 });
  const notice = page.locator('.dialog.logging-notice button', { hasText: 'Continue' });
  if (await notice.count()) await notice.click();
  if (questionnaire === 'answer') await answerQuestionnaire(page);
}

/**
 * A new account's first sign-in shows the sign-up questionnaire before anything else
 * (js/views/questionnaire.js): answer every question with Prefer not to say, give a name and an email
 * address, and save, which goes on to where the person starts. Nothing happens when it is not shown.
 */
export async function answerQuestionnaire(page, { name = 'Test person', email = 'test@example.org' } = {}) {
  // signed in (the first view is shown) or refused (an error on the sign-in view)
  await page.waitForFunction(() => (globalThis.ElectroTag && globalThis.ElectroTag.route && globalThis.ElectroTag.route !== 'signin')
    || document.querySelector('form.signin-form .error:not([hidden])') !== null, null, { timeout: 30000 });
  if (await page.evaluate(() => globalThis.ElectroTag && globalThis.ElectroTag.route) !== 'questionnaire') return;
  await page.waitForSelector('form.q-form');
  const prefer = page.locator('fieldset.q-question label.q-prefer');
  for (let i = 0; i < await prefer.count(); i++) await prefer.nth(i).click();
  await page.fill('input[name="full_name"]', name);
  await page.fill('input[name="email"]', email);
  await page.click('[data-log="questionnaire-save"]');
  await page.waitForFunction(() => globalThis.ElectroTag.route !== 'questionnaire', null, { timeout: 30000 });
}

export async function state(page) {
  return page.evaluate(() => globalThis.ElectroTag.debugState());
}

export async function waitForRoute(page, route, timeout = 15000) {
  await page.waitForFunction((r) => globalThis.ElectroTag && globalThis.ElectroTag.route === r, route, { timeout });
}

/** Wait until the viewer has drawn traces. */
export async function waitForTraces(page) {
  await page.waitForFunction(() => {
    const ws = globalThis.ElectroTag.ws;
    return ws && ws.viewer._cache && ws.viewer.stats.traceMs > 0;
  }, null, { timeout: 15000 });
}

/** Client coordinates of time t (s) on channel `name` (or the middle of the plot). */
export async function eegPoint(page, t, name = null) {
  return page.evaluate(([t, name]) => {
    const v = globalThis.ElectroTag.ws.viewer;
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

/**
 * On the training path, skip its first two stages (the platform tour and the snippets) as a trainee
 * does, answering each question, so that the next step is learning with the experts.
 */
export async function skipFirstStages(page, timeout = 30000) {
  for (const stage of ['tour', 'snippets']) {
    await page.locator(`main.training [data-log="skip-${stage}"]`).click({ timeout });
    await clickDialogButton(page, 'Skip this stage');
    await page.waitForSelector(`main.training [data-stage="${stage}"][data-status="skipped"]`, { timeout });
  }
}
