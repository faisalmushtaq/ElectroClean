// Reports in the admin area receive the application's typeface with the page (withReportFont in
// js/admin/ui.js), since a sandboxed frame cannot load the font file itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withReportFont } from '../../electroclean/web/static/js/admin/ui.js';

const CSS = '<style>@font-face{font-family:"Newsreader"}</style>';

test('the typeface goes at the start of the report\'s head', () => {
  assert.equal(withReportFont('<!doctype html><html><head lang="en"><title>R</title></head><body>x</body></html>', CSS),
    `<!doctype html><html><head lang="en">${CSS}<title>R</title></head><body>x</body></html>`);
});

test('a report without a head gets it first, and no font leaves the report as it is', () => {
  assert.equal(withReportFont('<h1>R</h1>', CSS), `${CSS}<h1>R</h1>`);
  assert.equal(withReportFont('<head></head><h1>R</h1>', ''), '<head></head><h1>R</h1>');
  assert.equal(withReportFont(null, CSS), CSS);
});
