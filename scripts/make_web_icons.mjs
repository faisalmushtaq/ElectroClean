// Make the application's PNG icons from electrotag/web/static/icon.svg: a 32-pixel tab icon for
// browsers that do not take SVG icons, and the 180-pixel icon an iPad shows on its home screen. The
// home-screen icon has no frame (iPadOS rounds the corners itself) and the page colour to its edges.
// Run with Node.js and Playwright: node scripts/make_web_icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Playwright as the browser tests load it (installed globally or beside the repository).
const { chromium } = createRequire(import.meta.url)('playwright');

const STATIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'electrotag', 'web', 'static');
const svg = fs.readFileSync(path.join(STATIC, 'icon.svg'), 'utf8');
// Without the frame: the band and the trace, drawn larger on the page colour.
const bare = svg.replace(/<!--[\s\S]*?-->/, '').replace(/<rect x="1\.75"[^>]*\/>/, '')
  .replace('viewBox="0 0 32 32"', 'viewBox="2 3 28 26"');

const browser = await chromium.launch();
async function render(markup, size, file, background) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:${background}}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`);
  await page.screenshot({ path: path.join(STATIC, file), omitBackground: background === 'transparent' });
  await page.close();
}
await render(svg, 32, 'icon-32.png', 'transparent');
await render(`<div style="padding:28px;background:#FBFAF8">${bare.replace(/width:\d+px;height:\d+px/, '')}</div>`.replace('<svg ', '<svg style="width:124px;height:124px" '), 180, 'icon-180.png', '#FBFAF8');
await browser.close();
console.log('icon-32.png and icon-180.png written to', STATIC);
