// ElectroClean in the browser: start-up. The page has one element (#app) and this one module.

import { App } from './app.js';

// The EEG is drawn on canvas in the monospaced face, which a canvas does not load by itself: ask for
// it now, so that it is ready when a recording opens (the page's own text loads its faces as usual).
try { document.fonts.load('12px "JetBrains Mono"').catch(() => {}); } catch { /* no font loading API: the fallback is used */ }

const root = document.getElementById('app');
const app = new App(root);
// For the browser tests and for curious annotators: the application object (nothing secret in it).
globalThis.ElectroClean = app;
app.boot();
