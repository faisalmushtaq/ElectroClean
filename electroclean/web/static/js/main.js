// ElectroClean in the browser: start-up. The page has one element (#app) and this one module.

import { App } from './app.js';

const root = document.getElementById('app');
const app = new App(root);
// For the browser tests and for curious annotators: the application object (nothing secret in it).
globalThis.ElectroClean = app;
app.boot();
