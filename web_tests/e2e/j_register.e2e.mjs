// Registering recordings in Chromium (js/data/register.js), with the folder chosen in a folder
// picker and every recording read in the reading worker: the manifests must be those Node builds
// from the same files (which web_tests/unit/data_register.test.mjs compares with the desktop's), and
// the page must keep answering while the recordings are read.
import fs from 'node:fs';
import path from 'node:path';

import { buildManifests } from '../../electrotag/web/static/js/data/register.js';
import { ensureFixtures, FIXTURES } from '../unit/_fixtures.mjs';

async function nodeFiles(dir, name) {
  const out = [];
  const walk = async (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const file = new File([await fs.openAsBlob(p)], e.name, { lastModified: Math.floor(fs.statSync(p).mtimeMs) });
        Object.defineProperty(file, 'webkitRelativePath', { value: `${name}/${path.relative(dir, p).split(path.sep).join('/')}` });
        out.push(file);
      }
    }
  };
  await walk(dir);
  return out;
}

/** A manifest without what differs from one registration to the next. */
function comparable(m) {
  const c = structuredClone(m);
  delete c.created_at;
  for (const fp of Object.values(c.fingerprint)) delete fp.mtime_ns;
  return c;
}

export const tests = [
  {
    name: 'a dataset folder registered in the reading worker gives the same manifests, and the page keeps answering',
    async run(t) {
      const { assert } = t;
      const manifest = ensureFixtures();
      for (const name of ['edf_mix', 'bids_bv']) {
        const dir = path.join(FIXTURES, manifest.datasets[name].root);
        const expected = await buildManifests(await nodeFiles(dir, name), { worker: false });
        const page = await t.newPage();
        await page.evaluate(() => {
          const input = document.createElement('input');
          input.type = 'file';
          input.id = 'register-input';
          input.webkitdirectory = true;
          input.multiple = true;
          document.body.append(input);
        });
        await page.setInputFiles('#register-input', dir);
        const got = await page.evaluate(async () => {
          const { buildManifests } = await import(new URL('js/data/register.js', location.href).href);
          const files = document.getElementById('register-input').files;
          const stages = new Set();
          let overall = 0;
          let last = performance.now();
          let longest = 0;
          const tick = setInterval(() => {
            const now = performance.now();
            longest = Math.max(longest, now - last);
            last = now;
          }, 20);
          const t0 = performance.now();
          const out = await buildManifests(files, {
            worker: true, // every recording in the reading worker (fails without one)
            onProgress: (p) => {
              stages.add(p.stage);
              overall = Math.max(overall, p.overall);
            },
          });
          clearInterval(tick);
          return { out, ms: performance.now() - t0, longest, stages: [...stages], overall, paths: [...files].map((f) => f.webkitRelativePath) };
        });
        console.log(`     ${name}: ${got.out.manifests.length} recordings in ${got.ms.toFixed(0)} ms; the page answered within ${got.longest.toFixed(0)} ms throughout`);
        assert.ok(got.paths.every((p) => p.startsWith(`${name}/`)), 'the folder picked is the dataset root');
        assert.deepEqual(got.out.manifests.map((m) => m.recording_id), expected.manifests.map((m) => m.recording_id));
        got.out.manifests.forEach((m, i) => assert.deepEqual(comparable(m), comparable(expected.manifests[i]), m.recording_id));
        got.out.manifests.forEach((m, i) => {
          for (const [role, fp] of Object.entries(m.fingerprint)) {
            // (WebKit's test harness dates files given to an input by the time they are given, so only Chromium keeps it)
            if (t.browserName === 'chromium') assert.ok(Math.abs(fp.mtime_ns - expected.manifests[i].fingerprint[role].mtime_ns) <= 1e6 + 1024, `${m.recording_id} ${role}`);
          }
        });
        assert.deepEqual(got.out.failures, expected.failures);
        // (WebKit's test harness leaves hidden folders out of a folder it gives to an input)
        const shown = (list) => (t.browserName === 'chromium' ? list : list.filter((x) => !/(^|\/)\./.test(x.path || x)));
        assert.deepEqual(shown(got.out.ignored), shown(expected.ignored));
        assert.equal(got.overall, 1);
        assert.ok(got.stages.includes('fingerprint') && got.stages.includes('amplitude'), got.stages.join(', '));
        assert.ok(got.longest < 1000, `the page did not answer for ${got.longest.toFixed(0)} ms`);
      }
    },
  },
];
