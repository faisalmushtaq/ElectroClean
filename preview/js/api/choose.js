// Which backend the application uses: a study on Firebase, a study server, or the demonstration.
//
// In order:
//   ?demo=1                      the demonstration (for local testing only)
//   ?server=https://…            a study server (remembered in this browser)
//   config.json beside index.html
//       {"firebase": {...}, "study": "<id>", "functions_region": "europe-west2"}   a study on Firebase
//                                (?study=<id> picks another study of the same project; "emulators":
//                                {"auth": "http://127.0.0.1:9099", "functions": "127.0.0.1:5001"} for
//                                testing on the Firebase Emulator Suite)
//       {"server": "https://…"}  a study server
//   the server remembered in this browser
//   the server that serves this page itself (api/v1/health beside index.html)
//   otherwise the demonstration.

import { checkHealth, HttpBackend, normaliseServer } from './http.js';
import { local } from '../util.js';

const SERVER_KEY = 'electrotag.server';

function queryParams() {
  try { return new URLSearchParams(globalThis.location ? globalThis.location.search : ''); } catch { return new URLSearchParams(''); }
}

async function readConfigFile() {
  try {
    const res = await fetch('config.json', { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data === 'object' ? data : null;
  } catch { return null; }
}

export function rememberServer(address) {
  if (address) local.set(SERVER_KEY, normaliseServer(address));
  else local.remove(SERVER_KEY);
}

export function rememberedServer() {
  const v = local.get(SERVER_KEY, '');
  return typeof v === 'string' ? v : '';
}

/** The folder of index.html as a server address ('https://host/app'), or null in a sandbox. */
function sameSiteBase() {
  try {
    const loc = globalThis.location;
    if (!loc || !/^https?:$/.test(loc.protocol)) return null;
    return new URL('.', loc.href).href.replace(/\/+$/, '');
  } catch { return null; }
}

/**
 * Where the study is. Resolves with one of
 *   {kind: 'demo', source}
 *   {kind: 'server', address, source, health?}
 *   {kind: 'firebase', config, study, region, source}
 * where source is 'query', 'config', 'remembered', 'same-site', 'forced-demo' or 'none'.
 */
export async function findBackend() {
  const q = queryParams();
  if (q.get('demo') === '1') return { kind: 'demo', source: 'forced-demo' };
  const fromQuery = q.get('server');
  if (fromQuery) {
    const address = normaliseServer(fromQuery);
    rememberServer(address);
    return { kind: 'server', address, source: 'query' };
  }
  const cfg = await readConfigFile();
  if (cfg && cfg.firebase && typeof cfg.firebase === 'object') {
    return {
      kind: 'firebase', config: cfg.firebase, study: q.get('study') || cfg.study || '',
      region: cfg.functions_region || cfg.region || 'europe-west2', sdkBase: cfg.sdk_base || undefined,
      emulators: cfg.emulators && typeof cfg.emulators === 'object' ? cfg.emulators : null, source: 'config',
    };
  }
  if (cfg && typeof cfg.server === 'string' && cfg.server) {
    return { kind: 'server', address: normaliseServer(cfg.server), source: 'config' };
  }
  const remembered = rememberedServer();
  if (remembered) return { kind: 'server', address: remembered, source: 'remembered' };
  const here = sameSiteBase();
  if (here !== null) {
    try {
      const health = await checkHealth(here, { timeoutMs: 2500 });
      return { kind: 'server', address: here, source: 'same-site', health };
    } catch { /* not served by a study server */ }
  }
  return { kind: 'demo', source: 'none' };
}

/**
 * What the sign-in page says when the backend chosen by findBackend() cannot be started: a study
 * server that does not answer, a Firebase study that does not load, or the demonstration itself.
 */
export function unreachableText(where, exc = null) {
  if (where && where.kind === 'firebase') return `The study could not be loaded (${exc && exc.message ? exc.message : 'no answer'}). Check your internet connection and try again.`;
  if (!where || where.kind !== 'server' || !where.address) {
    return 'The demonstration could not be started in this browser. Reload the page to try again; if it keeps happening, try another browser.';
  }
  return `The study server at ${where.address} does not answer${exc && exc.code === 'not_electrotag' ? ' as an ElectroTag study server' : ''}. ` +
    'Check your internet connection and the address, then try again. If it keeps happening, tell your study team.';
}

/** A study server's backend, once it has answered GET /health. */
export async function connectServer(address, opts = {}) {
  const server = normaliseServer(address);
  const health = opts.health || await checkHealth(server);
  return new HttpBackend(server, { ...opts, health });
}

export async function connectFirebase(where, opts = {}) {
  const { FirebaseBackend } = await import('./firebase.js');
  return FirebaseBackend.create({ ...where, ...opts });
}

export async function makeDemo() {
  const { DemoBackend } = await import('./demo.js');
  return new DemoBackend();
}
