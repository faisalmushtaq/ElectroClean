// The design system (app.css, admin.css and js/ui/theme.js): the colours drawn on canvas are those of
// the style sheet, text meets WCAG 2.1 AA, the rules of the design hold (flat: no shadows; square
// panels, pill-shaped buttons and badges), and every font the style sheet names is served with its
// licence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COLOURS, FONT } from '../../electroclean/web/static/js/ui/theme.js';

const STATIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'electroclean', 'web', 'static');
const APP_CSS = fs.readFileSync(path.join(STATIC, 'app.css'), 'utf8');
const ADMIN_CSS = fs.readFileSync(path.join(STATIC, 'admin.css'), 'utf8');

/** The colour tokens of :root, with var() references resolved. */
function tokens() {
  const root = APP_CSS.slice(APP_CSS.indexOf(':root {'), APP_CSS.indexOf('}', APP_CSS.indexOf(':root {')));
  const raw = Object.fromEntries([...root.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const resolve = (v, depth = 0) => {
    const ref = /^var\(--([a-z-]+)\)$/.exec(v);
    return ref && depth < 5 ? resolve(raw[ref[1]], depth + 1) : v;
  };
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolve(v)]));
}

function luminance(hex) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test('the canvas uses the colours of the style sheet', () => {
  const t = tokens();
  const same = {
    window: 'page', surface: 'surface', surface_alt: 'surface-alt', hover: 'hover', pressed: 'pressed', border: 'border',
    separator: 'hairline', text: 'text', text_secondary: 'text-secondary', text_tertiary: 'text-tertiary',
    text_disabled: 'text-disabled', accent: 'accent', accent_soft: 'accent-soft', destructive: 'destructive',
    warning_bg: 'warning-bg', warning_border: 'warning-bar', warning_text: 'warning-text', success_bg: 'success-bg',
    flag_type: 'flag-type', selection_channel: 'selection-channel',
  };
  for (const [canvas, css] of Object.entries(same)) {
    assert.equal(COLOURS[canvas].toUpperCase(), t[css].toUpperCase(), `${canvas} on canvas and --${css} in app.css`);
  }
  assert.match(FONT, /^"JetBrains Mono"/);
});

test('text meets WCAG 2.1 AA on the backgrounds it is shown on', () => {
  const t = tokens();
  const pairs = [];
  for (const bg of ['page', 'surface', 'band', 'surface-alt', 'hover']) {
    for (const fg of ['text', 'text-secondary', 'accent', 'destructive']) pairs.push([fg, bg]);
  }
  pairs.push(['text-tertiary', 'page'], ['text-tertiary', 'surface'], ['text-tertiary', 'band'],
    ['accent', 'accent-soft'], ['accent-hover', 'success-bg'], ['text', 'accent-soft'],
    ['destructive', 'danger-bg'], ['warning-text', 'warning-bg'], ['selection-channel', 'surface'], ['flag-type', 'surface']);
  for (const [fg, bg] of pairs) {
    const c = contrast(t[fg], t[bg]);
    assert.ok(c >= 4.5, `--${fg} on --${bg}: ${c.toFixed(2)}:1, below 4.5:1`);
  }
  assert.ok(contrast('#FFFFFF', t.ink) >= 4.5, 'white text on the black buttons');
  assert.ok(contrast('#FFFFFF', t.accent) >= 4.5, 'white on the green (done badges, steps)');
  // The edges of fields: 3:1 for the parts of a control (WCAG 1.4.11).
  for (const bg of ['page', 'surface', 'band']) assert.ok(contrast(t.border, t[bg]) >= 3, `--border on --${bg}`);
});

test('the design is flat: no shadows; square panels; pills and circles for buttons, badges and dots', () => {
  for (const [name, css] of [['app.css', APP_CSS], ['admin.css', ADMIN_CSS]]) {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /box-shadow\s*:/, `${name} has a shadow`);
    // Gradients are used only to draw lines: the corner markers (ink) and the column guides.
    assert.doesNotMatch(code, /(radial|conic)-gradient|linear-gradient\((?!var\(--(ink|guide)\), var\(--\2\)\))/, `${name} has a gradient`);
    for (const m of code.matchAll(/border-radius\s*:\s*([^;]+);/g)) {
      for (const part of m[1].trim().split(/\s+/)) {
        const ok = part === '0' || part === '50%' || part === 'var(--pill)' || part.startsWith('var(--radius') || /^[0-2](\.\d+)?px$/.test(part);
        assert.ok(ok, `${name}: border-radius ${m[1]}`);
      }
    }
  }
  const t = tokens();
  assert.ok(['0', '2px'].includes(t.radius) && ['0', '2px'].includes(t['radius-card']));
});

test('every font the style sheet names is served with the application, with its licence', () => {
  const urls = [...APP_CSS.matchAll(/url\("(fonts\/[^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(urls.sort(), ['fonts/JetBrainsMono-Variable.woff2', 'fonts/Newsreader-Italic-Variable.woff2', 'fonts/Newsreader-Variable.woff2']);
  for (const u of urls) {
    const file = path.join(STATIC, u);
    assert.ok(fs.statSync(file).size > 10000, `${u} is missing or empty`);
    const family = path.basename(u).replace(/(-Italic)?-Variable\.woff2$/, '');
    const licence = fs.readFileSync(path.join(STATIC, 'fonts', `${family}-OFL.txt`), 'utf8');
    assert.match(licence, /SIL Open Font License, Version 1\.1/);
  }
  // index.html preloads the faces every page uses, by relative paths (the application also runs
  // under /preview/); the italic loads when a page first uses it.
  const html = fs.readFileSync(path.join(STATIC, 'index.html'), 'utf8');
  for (const u of ['fonts/Newsreader-Variable.woff2', 'fonts/JetBrainsMono-Variable.woff2']) {
    assert.ok(html.includes(`href="${u}"`), `index.html preloads ${u}`);
  }
  for (const m of html.matchAll(/href="(fonts\/[^"]+)"/g)) assert.ok(fs.existsSync(path.join(STATIC, m[1])), `${m[1]} exists`);
});
