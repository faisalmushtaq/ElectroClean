// Opening recordings from links (js/data/links.js and js/data/fetch_links.js): share links of
// Dropbox and OneDrive turned into the addresses their files are read from, file names from the
// service's answer, and the plain-words problems of a fetch that fails. The application itself is
// tried in a browser (web_tests/e2e/l_links.e2e.mjs) against a stand-in cloud service.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { directLink, parseLinks, fileNameFromDisposition, base64Url, safeFileName, formatBytes, LinkProblem } =
  await import('../../electrotag/web/static/js/data/links.js');
const { fetchLinkedFiles, LinkError, problemForStatus } = await import('../../electrotag/web/static/js/data/fetch_links.js');

const kindOf = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof LinkProblem); return e.kind; } return null; };

test('a Dropbox file link (scl/fi) is read from dl.dropboxusercontent.com, keeping its rlkey', () => {
  const l = directLink('https://www.dropbox.com/scl/fi/x3gvxeqyjc0qj2ddctmdl/sub-01_eeg.edf?rlkey=2gh1n2fufpm4ldba36ghedvmd&dl=0');
  assert.equal(l.service, 'dropbox');
  assert.equal(l.url, 'https://dl.dropboxusercontent.com/scl/fi/x3gvxeqyjc0qj2ddctmdl/sub-01_eeg.edf?rlkey=2gh1n2fufpm4ldba36ghedvmd&dl=1');
  assert.equal(l.downloadUrl, 'https://www.dropbox.com/scl/fi/x3gvxeqyjc0qj2ddctmdl/sub-01_eeg.edf?rlkey=2gh1n2fufpm4ldba36ghedvmd&dl=1');
  assert.equal(l.name, 'sub-01_eeg.edf');
  assert.equal(l.readable, true);
  // st (a newer link's extra key) is kept too; raw and dl are replaced by dl=1
  const st = directLink('https://www.dropbox.com/scl/fi/abc/rec.vhdr?rlkey=k1&st=s2&raw=1');
  assert.equal(st.url, 'https://dl.dropboxusercontent.com/scl/fi/abc/rec.vhdr?rlkey=k1&st=s2&dl=1');
});

test('an older Dropbox link (s/) and links already pointing at a download are converted the same way', () => {
  for (const text of ['https://www.dropbox.com/s/q8lax9ary32c7t9/rec.eeg?dl=0', 'https://dropbox.com/s/q8lax9ary32c7t9/rec.eeg',
    'https://dl.dropbox.com/s/q8lax9ary32c7t9/rec.eeg?dl=1', 'https://dl.dropboxusercontent.com/s/q8lax9ary32c7t9/rec.eeg?raw=1']) {
    const l = directLink(text);
    assert.equal(l.url, 'https://dl.dropboxusercontent.com/s/q8lax9ary32c7t9/rec.eeg?dl=1', text);
    assert.equal(l.name, 'rec.eeg');
  }
  assert.equal(directLink('https://www.dropbox.com/s/abc/my%20file.edf?dl=0').name, 'my file.edf');
});

test('Dropbox folders and pages that are not a file are refused in plain words', () => {
  assert.equal(kindOf(() => directLink('https://www.dropbox.com/scl/fo/abc/def?rlkey=x&dl=0')), 'folder');
  assert.equal(kindOf(() => directLink('https://www.dropbox.com/sh/abc/def?dl=0')), 'folder');
  assert.equal(kindOf(() => directLink('https://www.dropbox.com/home')), 'not_a_file');
});

test('OneDrive links are read through the shares API with the link encoded as base64url', () => {
  const share = 'https://1drv.ms/u/s!AkR0q-0Mzw9vgQwTq2_cAm0j3P6p?e=abc';
  const l = directLink(share);
  assert.equal(l.service, 'onedrive');
  assert.equal(l.url, `https://api.onedrive.com/v1.0/shares/u!${base64Url(share)}/root/content`);
  assert.equal(l.downloadUrl, share);
  assert.equal(l.name, '');
  // Microsoft's own example: base64, then without '=' and with '-' and '_' for '+' and '/'
  assert.equal(base64Url('https://onedrive.live.com/redir?resid=1231244193912!12&authKey=1201919!12921!1'),
    'aHR0cHM6Ly9vbmVkcml2ZS5saXZlLmNvbS9yZWRpcj9yZXNpZD0xMjMxMjQ0MTkzOTEyITEyJmF1dGhLZXk9MTIwMTkxOSExMjkyMSEx');
  assert.equal(base64Url('??>'), 'Pz8-');
  assert.equal(base64Url('???'), 'Pz8_');
  const live = directLink('https://onedrive.live.com/redir?resid=ABC!123&authkey=!xyz');
  assert.equal(live.service, 'onedrive');
  assert.match(live.url, /^https:\/\/api\.onedrive\.com\/v1\.0\/shares\/u!aHR0cHM6Ly9vbmVkcml2ZS5saXZlLmNvbS9yZWRpcj/);
  assert.equal(live.name, '');
});

test('SharePoint asks for the file with download=1; Google Drive is known to refuse web pages', () => {
  const sp = directLink('https://contoso-my.sharepoint.com/:u:/g/personal/a_b/EaBcD?e=x1');
  assert.equal(sp.service, 'sharepoint');
  assert.equal(sp.url, 'https://contoso-my.sharepoint.com/:u:/g/personal/a_b/EaBcD?e=x1&download=1');
  const g = directLink('https://drive.google.com/file/d/1AbC_dE/view?usp=sharing');
  assert.equal(g.service, 'google');
  assert.equal(g.readable, false);
  assert.equal(g.url, null);
  assert.equal(g.downloadUrl, 'https://drive.google.com/uc?export=download&id=1AbC_dE');
});

test('other https links are used as they are; http, other schemes and non-links are refused', () => {
  const w = directLink('  https://files.example.org/eeg/sub-02_task-rest_eeg.bdf?token=abc  ');
  assert.deepEqual(w, { service: 'web', url: 'https://files.example.org/eeg/sub-02_task-rest_eeg.bdf?token=abc',
    downloadUrl: 'https://files.example.org/eeg/sub-02_task-rest_eeg.bdf?token=abc', name: 'sub-02_task-rest_eeg.bdf', readable: true });
  assert.equal(kindOf(() => directLink('http://files.example.org/a.edf')), 'insecure');
  assert.equal(kindOf(() => directLink('http://www.dropbox.com/s/abc/a.edf')), 'insecure');
  assert.equal(kindOf(() => directLink('ftp://files.example.org/a.edf')), 'not_a_link');
  assert.equal(kindOf(() => directLink('file:///Users/me/a.edf')), 'not_a_link');
  assert.equal(kindOf(() => directLink('javascript:alert(1)')), 'not_a_link');
  assert.equal(kindOf(() => directLink('www.dropbox.com/s/abc/a.edf')), 'not_a_link');
  assert.equal(kindOf(() => directLink('https://me:secret@files.example.org/a.edf')), 'not_a_link');
  assert.equal(kindOf(() => directLink('   ')), 'empty');
  // a stand-in service on this computer (the tests) may use http
  assert.equal(directLink('http://127.0.0.1:8123/a.edf').url, 'http://127.0.0.1:8123/a.edf');
  assert.equal(directLink('http://localhost:8123/a.edf').service, 'web');
});

test('a text field holds one link per line', () => {
  const p = parseLinks('https://www.dropbox.com/s/a/r.vhdr?dl=0\n\n  https://www.dropbox.com/s/b/r.vmrk?dl=0 \r\nnot a link\n');
  assert.equal(p.length, 3);
  assert.deepEqual(p.slice(0, 2).map((x) => x.link.name), ['r.vhdr', 'r.vmrk']);
  assert.equal(p[2].problem.kind, 'not_a_link');
  assert.deepEqual(parseLinks(''), []);
});

test('file names come from Content-Disposition, safely', () => {
  assert.equal(fileNameFromDisposition('attachment; filename="pytorch_model.bin"; filename*=UTF-8\'\'pytorch_model.bin'), 'pytorch_model.bin');
  assert.equal(fileNameFromDisposition("attachment; filename*=UTF-8''sub-01%20%C3%A9t%C3%A9.edf"), 'sub-01 été.edf');
  assert.equal(fileNameFromDisposition('attachment; filename=rec.vhdr'), 'rec.vhdr');
  assert.equal(fileNameFromDisposition('attachment; filename="a \\"b\\".edf"'), 'a "b".edf');
  assert.equal(fileNameFromDisposition('attachment; filename="../../etc/passwd"'), 'passwd');
  assert.equal(fileNameFromDisposition('inline'), '');
  assert.equal(fileNameFromDisposition(null), '');
  assert.equal(safeFileName('C:\\data\\x.edf'), 'x.edf');
  assert.equal(safeFileName('..'), '');
});

test('sizes are shown in decimal units', () => {
  assert.equal(formatBytes(0), '0 bytes');
  assert.equal(formatBytes(999), '999 bytes');
  assert.equal(formatBytes(1500), '1.5 kB');
  assert.equal(formatBytes(1_200_000_000), '1.2 GB');
  assert.equal(formatBytes(340_000_000), '340 MB');
  assert.equal(formatBytes(12_000_000), '12 MB');
});

// ------------------------------------------------------------------ fetching
function answer(status, body, headers = {}) {
  return async () => new Response(status === 204 ? null : body, { status, headers });
}

test('a fetched file keeps the name the service gives and reports its progress', async () => {
  const body = new Uint8Array(3000).map((_, i) => i % 251);
  const seen = [];
  let asked = null;
  const r = await fetchLinkedFiles([{ role: 'data', url: 'https://www.dropbox.com/s/abc/link-name.edf?dl=0' }], {
    fetchImpl: async (url, init) => {
      asked = { url, init };
      return new Response(body, { status: 200, headers: { 'Content-Length': '3000', 'Content-Disposition': 'attachment; filename="sub-01.edf"' } });
    },
    onProgress: (p) => seen.push(p.loaded),
  });
  assert.equal(asked.url, 'https://dl.dropboxusercontent.com/s/abc/link-name.edf?dl=1');
  assert.equal(asked.init.credentials, 'omit');
  assert.equal(asked.init.referrerPolicy, 'no-referrer');
  assert.equal(asked.init.headers, undefined, 'no custom headers, so the service needs no preflight');
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].name, 'sub-01.edf');
  assert.equal(r.files[0].size, 3000);
  assert.equal(r.bytes, 3000);
  assert.deepEqual(new Uint8Array(await r.files[0].arrayBuffer()), body);
  assert.equal(seen[0], 0);
  assert.equal(seen[seen.length - 1], 3000);
});

test('without Content-Disposition the name comes from the link', async () => {
  const r = await fetchLinkedFiles([{ url: 'https://www.dropbox.com/s/a/r.vhdr?dl=0' }, { url: 'https://www.dropbox.com/s/b/r.eeg?dl=0' }],
    { fetchImpl: answer(200, 'x') });
  assert.deepEqual(r.files.map((f) => f.name), ['r.vhdr', 'r.eeg']);
});

test('the problems of a link are told in plain words, with the link for the fallback', async () => {
  const blocked = async () => { throw new TypeError('Failed to fetch'); };
  const cases = [
    [blocked, 'blocked', /did not let this page read the file/],
    [answer(403, 'no'), 'not_public', /not shared with everyone/],
    [answer(401, 'no'), 'not_public', /not shared with everyone/],
    [answer(404, 'gone'), 'not_found', /no file at this link/],
    [answer(500, 'oops'), 'http', /answered with an error \(500\)/],
    [answer(200, '<html></html>', { 'Content-Type': 'text/html; charset=utf-8' }), 'page', /opens a web page/],
    [answer(200, 'x', { 'Content-Length': String(3 * 1024 ** 3) }), 'too_large', /too large/],
  ];
  for (const [fetchImpl, kind, message] of cases) {
    await assert.rejects(fetchLinkedFiles([{ url: 'https://www.dropbox.com/s/abc/a.edf?dl=0' }], { fetchImpl }), (e) => {
      assert.ok(e instanceof LinkError);
      assert.equal(e.kind, kind);
      assert.match(e.message, message);
      assert.equal(e.link.downloadUrl, 'https://www.dropbox.com/s/abc/a.edf?dl=1');
      return true;
    });
  }
  await assert.rejects(fetchLinkedFiles([{ url: 'https://x.example/a.edf' }], { fetchImpl: blocked, online: () => false }), (e) => e.kind === 'offline');
  await assert.rejects(fetchLinkedFiles([{ url: 'https://drive.google.com/file/d/1A/view' }], { fetchImpl: answer(200, 'x') }),
    (e) => e.kind === 'refuses' && /Google Drive does not let/.test(e.message));
  await assert.rejects(fetchLinkedFiles([{ url: 'http://x.example/a.edf' }], { fetchImpl: answer(200, 'x') }), (e) => e.kind === 'insecure');
  await assert.rejects(fetchLinkedFiles([], {}), (e) => e.kind === 'empty');
  assert.equal(problemForStatus(429, { service: 'onedrive' })[0], 'OneDrive is limiting downloads of this file at the moment. Try again later.');
});

test('a file larger than the limit is stopped while it streams, and a short download is noticed', async () => {
  const big = () => new Response(new ReadableStream({
    start(c) { for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(1000)); c.close(); },
  }), { status: 200 });
  await assert.rejects(fetchLinkedFiles([{ url: 'https://x.example/a.edf' }], { fetchImpl: async () => big(), maxBytes: 2500 }), (e) => e.kind === 'too_large');
  const short = async () => new Response(new Uint8Array(10), { status: 200, headers: { 'Content-Length': '10' } });
  const ok = await fetchLinkedFiles([{ url: 'https://x.example/a.edf' }], { fetchImpl: short });
  assert.equal(ok.files[0].size, 10);
  await assert.rejects(fetchLinkedFiles([{ url: 'https://x.example/a.edf' }], {
    fetchImpl: async () => { const r = new Response(new Uint8Array(10), { status: 200 }); Object.defineProperty(r, 'headers', { value: new Headers({ 'Content-Length': '20' }) }); return r; },
  }), (e) => e.kind === 'interrupted');
});

test('stopping a download says so', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(fetchLinkedFiles([{ url: 'https://x.example/a.edf' }], {
    signal: ac.signal, fetchImpl: async (_u, init) => { if (init.signal.aborted) throw new DOMException('aborted', 'AbortError'); return new Response('x'); },
  }), (e) => e.kind === 'aborted');
});
