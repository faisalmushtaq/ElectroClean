// The design system (app.css, admin.css and js/ui/theme.js): the colours drawn on canvas are those of
// the style sheet, text meets WCAG 2.1 AA, and the rules that keep the pages crisp and consistent
// hold: one typeface, sizes from one scale of whole pixels on whole-pixel lines, flat controls (no
// shadows, no gradients), square panels with pill-shaped buttons and badges, nothing in capitals,
// and icons that are drawn rather than borrowed from a font.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COLOURS, FONT } from '../../electrotag/web/static/js/ui/theme.js';

const STATIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'electrotag', 'web', 'static');
const APP_CSS = fs.readFileSync(path.join(STATIC, 'app.css'), 'utf8');
const ADMIN_CSS = fs.readFileSync(path.join(STATIC, 'admin.css'), 'utf8');
const SHEETS = [['app.css', APP_CSS], ['admin.css', ADMIN_CSS]];
const uncommented = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The custom properties of :root, with var() references resolved. */
function tokens() {
  const start = APP_CSS.indexOf(':root {');
  const root = APP_CSS.slice(start, APP_CSS.indexOf('\n}', start));
  const raw = Object.fromEntries([...root.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const resolve = (v, depth = 0) => {
    const ref = /^var\(--([a-z0-9-]+)\)$/.exec(v);
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

/** Every JavaScript file of the application, with its text. */
function scripts() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push([path.relative(STATIC, p), fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(path.join(STATIC, 'js'));
  return out;
}

test('the canvas uses the colours and the typeface of the style sheet', () => {
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
  assert.match(FONT, /^"Newsreader"/);
  assert.match(t.font, /^"Newsreader"/);
});

test('text meets WCAG 2.1 AA on the backgrounds it is shown on', () => {
  const t = tokens();
  const pairs = [];
  for (const bg of ['page', 'surface', 'band', 'surface-alt', 'hover']) {
    for (const fg of ['text', 'text-secondary', 'accent', 'destructive']) pairs.push([fg, bg]);
  }
  // Controls: words on the grey fill (and its hover), the done and warning chips, destructive buttons.
  for (const bg of ['fill', 'fill-hover']) pairs.push(['ink', bg], ['text-secondary', bg]);
  pairs.push(['text-tertiary', 'page'], ['text-tertiary', 'surface'], ['text-tertiary', 'band'],
    ['accent', 'accent-soft'], ['accent-hover', 'success-bg'], ['text', 'accent-soft'],
    ['destructive', 'danger-bg'], ['warning-text', 'warning-bg'], ['selection-channel', 'surface'], ['flag-type', 'surface']);
  for (const [fg, bg] of pairs) {
    const c = contrast(t[fg], t[bg]);
    assert.ok(c >= 4.5, `--${fg} on --${bg}: ${c.toFixed(2)}:1, below 4.5:1`);
  }
  assert.ok(contrast('#FFFFFF', t.ink) >= 4.5, 'white text on the black buttons');
  assert.ok(contrast('#FFFFFF', t.accent) >= 4.5, 'white on the accent blue (done badges, steps)');
  // The edges of fields: 3:1 for the parts of a control (WCAG 1.4.11).
  for (const bg of ['page', 'surface', 'band']) assert.ok(contrast(t.border, t[bg]) >= 3, `--border on --${bg}`);
});

test('one typeface, set from one scale of whole-pixel sizes on whole-pixel lines', () => {
  const t = tokens();
  const scale = Object.entries(t).filter(([k]) => /^t-\d+$/.test(k));
  assert.ok(scale.length >= 6);
  for (const [k, v] of scale) {
    const m = /^400 (\d+)px\/(\d+)px var\(--font\)$/.exec(v);
    assert.ok(m, `--${k}: ${v}`);
    assert.equal(Number(k.slice(2)), Number(m[1]), `--${k} is ${m[1]} pixels`);
    assert.ok(Number(m[2]) >= Number(m[1]) && Number(m[2]) % 4 === 0, `--${k}: its line is a multiple of 4 pixels`);
  }
  for (const [name, css] of SHEETS) {
    const code = uncommented(css).replace(/@font-face\s*\{[^}]*\}/g, '');
    // Sizes come from the scale: no loose font sizes, no unitless or fractional line heights.
    assert.doesNotMatch(code, /font-size\s*:/, `${name} sets a font size outside the scale`);
    assert.doesNotMatch(code, /line-height\s*:/, `${name} sets a line height outside the scale`);
    for (const m of code.matchAll(/(?<![-\w])font\s*:\s*([^;]+);/g)) {
      const v = m[1].trim();
      const ok = v === 'inherit' || /^var\(--t-\d+\)$/.test(v) || /^(600 )?1[236]px\/(16|20|24)px var\(--font-code\)$/.test(v);
      assert.ok(ok, `${name}: font: ${v}`);
    }
    for (const m of code.matchAll(/font-family\s*:\s*([^;]+);/g)) {
      assert.match(m[1], /^var\(--font(-display|-code)?\)$/, `${name}: font-family: ${m[1]}`);
    }
    assert.doesNotMatch(code, /\d+\.\d+px/, `${name} has a fractional pixel value`);
  }
});

test('the design is flat and quiet: no shadows, no gradients, no capitals; square panels; pills and circles for controls', () => {
  for (const [name, css] of SHEETS) {
    const code = uncommented(css);
    assert.doesNotMatch(code, /box-shadow\s*:|text-shadow\s*:/, `${name} has a shadow`);
    assert.doesNotMatch(code, /gradient\(/, `${name} has a gradient`);
    // Nothing is set in capitals: labels and headings keep the case they are written in.
    assert.doesNotMatch(code, /text-transform\s*:\s*uppercase|font-variant(-caps)?\s*:[^;]*(all-)?small-caps/, `${name} sets text in capitals`);
    for (const m of code.matchAll(/border-radius\s*:\s*([^;]+);/g)) {
      for (const part of m[1].trim().split(/\s+/)) {
        const ok = part === '0' || part === '50%' || part === 'var(--pill)' || part.startsWith('var(--radius') || /^[0-2]px$/.test(part);
        assert.ok(ok, `${name}: border-radius ${m[1]}`);
      }
    }
    // Hover styles only where there is a pointer that hovers: on a touch screen they would stay on a
    // tapped control.
    for (const line of code.split('\n').filter((l) => l.includes(':hover'))) {
      assert.match(line.trim(), /^@media \(hover: hover\) \{/, `${name}: ${line.trim().slice(0, 80)}`);
    }
    // Generated content is empty or a counter: arrows and ticks are drawn icons.
    for (const m of code.matchAll(/(?<![-\w])content\s*:\s*([^;]+);/g)) {
      assert.match(m[1].trim(), /^(""|none|attr\([a-z-]+\)|counter\([^)]*\))$/, `${name}: content: ${m[1]}`);
    }
  }
  const t = tokens();
  assert.ok(['0', '2px'].includes(t.radius) && ['0', '2px'].includes(t['radius-card']));
});

test('icons are drawn: no arrows, ticks or stars from a font, and every icon used has a drawing', () => {
  const drawn = new Set([...APP_CSS.matchAll(/\.ico-([a-z-]+)\s*\{\s*--i:\s*var\(--i-\1\)/g)].map((m) => m[1]));
  for (const name of drawn) assert.match(APP_CSS, new RegExp(`--i-${name}: url\\("data:image/svg\\+xml,`), `--i-${name} is drawn`);
  const used = new Set();
  for (const [file, text] of scripts()) {
    for (const line of text.split('\n')) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      assert.doesNotMatch(line, /[‹›▾▸▼←→↑↓✓✔✕✗★☆]/, `${file}: ${line.trim().slice(0, 80)}`);
    }
    for (const m of text.matchAll(/icon\('([a-z-]+)'\)/g)) used.add(m[1]);
    // the viewer's touch buttons name their icons
    if (file.endsWith('viewer.js')) for (const m of text.matchAll(/btn\('([a-z-]+)', '/g)) used.add(m[1]);
  }
  for (const dir of ['left', 'right', 'up', 'down']) used.add(`arrow-${dir}`); // the help's arrow keys
  for (const name of ['star', 'star-empty']) used.add(name); // starIcons()
  assert.ok(used.size >= 8);
  for (const name of used) assert.ok(drawn.has(name), `icon('${name}') has a drawing in app.css`);
});

test('the typeface is served with the application, with its licence', () => {
  const urls = [...APP_CSS.matchAll(/url\("(fonts\/[^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(urls.sort(), ['fonts/Newsreader-Italic-Variable.woff2', 'fonts/Newsreader-Variable.woff2']);
  for (const u of urls) assert.ok(fs.statSync(path.join(STATIC, u)).size > 10000, `${u} is missing or empty`);
  assert.match(fs.readFileSync(path.join(STATIC, 'fonts', 'Newsreader-OFL.txt'), 'utf8'), /SIL Open Font License, Version 1\.1/);
  assert.deepEqual(fs.readdirSync(path.join(STATIC, 'fonts')).sort(),
    ['Newsreader-Italic-Variable.woff2', 'Newsreader-OFL.txt', 'Newsreader-Variable.woff2']);
  // index.html preloads the roman by a relative path (the application also runs under /preview/);
  // the italic loads when a page first uses it.
  const html = fs.readFileSync(path.join(STATIC, 'index.html'), 'utf8');
  assert.ok(html.includes('href="fonts/Newsreader-Variable.woff2"'), 'index.html preloads the roman');
  for (const m of html.matchAll(/href="(fonts\/[^"]+)"/g)) assert.ok(fs.existsSync(path.join(STATIC, m[1])), `${m[1]} exists`);
});
