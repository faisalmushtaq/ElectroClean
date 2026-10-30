// The parts of the application loaded at their first use (js/lazy.js): one download however many
// ask, the module at hand once loaded, another address after a failure, and every part a module
// that exists, named by a path relative to js/ (so that the application works under /preview/).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const JS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "electrotag", "web", "static", "js");
const lazy = await import("../../electrotag/web/static/js/lazy.js");

test("a part is loaded once, however many ask, and is at hand afterwards", async () => {
  assert.equal(lazy.partNow("milestones"), null);
  const a = lazy.loadPart("milestones");
  const b = lazy.loadPart("milestones");
  assert.equal(a, b, "one promise for every caller");
  const mod = await a;
  assert.equal(typeof mod.newlyReached, "function");
  assert.equal(lazy.partNow("milestones"), mod);
  assert.ok(lazy.loadedParts().includes("milestones"));
  const [again] = await lazy.loadParts("milestones");
  assert.equal(again, mod);
});

test("after a failure a part is asked for under another address", () => {
  assert.equal(lazy.partAddress("readers", 0), "./eeg/recording.js");
  assert.equal(lazy.partAddress("readers", 2), "./eeg/recording.js?attempt=2");
  assert.throws(() => lazy.partAddress("nothing"), /No part of ElectroTag is called nothing/);
});

test("every part is a module of the application, by a relative path", () => {
  const src = readFileSync(join(JS, "lazy.js"), "utf8");
  const parts = [...src.matchAll(/^\s+([a-zA-Z]+): '(\.\/[^']+\.js)',$/gm)].map((m) => [m[1], m[2]]);
  assert.ok(parts.length >= 15);
  for (const [name, path] of parts) {
    assert.equal(lazy.partAddress(name), path);
    assert.ok(existsSync(join(JS, path)), `${name}: ${path} exists`);
  }
});

test("the sign-in page's modules import no later view", () => {
  // app.js and the sign-in view import only what the sign-in page shows; the rest goes through lazy.js.
  const later = /from '\.\/(views\/(home|open|device|invite|home_\w+)|annotate\/|training\/|admin\/|eeg\/|games\/|data\/)/;
  for (const f of ["app.js", "main.js", "views/signin.js", "views/common.js", "api/choose.js"]) {
    const imports = readFileSync(join(JS, f), "utf8").split("\n").filter((l) => /^import /.test(l));
    assert.deepEqual(imports.filter((l) => later.test(l.replace("'../", "'./"))), [], f);
  }
});
