// The rule of js/eeg/ (its README.md): the EEG library imports only its neighbours in the folder,
// never the application (views, api, annotate and the rest), so that it could become a package of
// its own. Static imports, re-exports, dynamic import() and the addresses of workers are all checked,
// and each must name a module of the folder by a relative path.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const EEG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "electrotag", "web", "static", "js", "eeg");

/** Every module address a source names: [kind, address], with null for an address that is not a plain string. */
export function addressesIn(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out = [];
  for (const m of code.matchAll(/^\s*(?:import|export)\b[^;'"`]*?\bfrom\s*(['"])([^'"]+)\1/gm)) out.push(["import", m[2]]);
  for (const m of code.matchAll(/^\s*import\s*(['"])([^'"]+)\1/gm)) out.push(["import", m[2]]);
  for (const m of code.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
    const lit = /^(['"])([^'"`]+)\1$/.exec(m[1].trim());
    out.push(["import()", lit ? lit[2] : null]);
  }
  for (const m of code.matchAll(/\bnew\s+URL\s*\(\s*([^,)]*),\s*import\.meta\.url\s*\)/g)) {
    const lit = /^(['"])([^'"`]+)\1$/.exec(m[1].trim());
    out.push(["new URL", lit ? lit[2] : null]);
  }
  for (const m of code.matchAll(/\bimportScripts\s*\(([^)]*)\)/g)) out.push(["importScripts", m[1].trim()]);
  return out;
}

test("the address finder sees every kind of import", () => {
  const src = [
    'import { a } from "./a.js";',
    "import './side.js';",
    "export { b } from '../views/b.js';",
    "export * from './c.js';",
    "const m = await import('../api/demo.js');",
    "const n = await import(name);",
    'new Worker(new URL("./worker.js", import.meta.url), { type: "module" });',
    "// import { x } from '../ui/x.js'; (a comment is not an import)",
  ].join("\n");
  assert.deepEqual(addressesIn(src), [
    ["import", "./a.js"], ["import", "../views/b.js"], ["import", "./c.js"], ["import", "./side.js"],
    ["import()", "../api/demo.js"], ["import()", null], ["new URL", "./worker.js"],
  ]);
});

test("js/eeg imports only its own modules, by relative paths", () => {
  const modules = readdirSync(EEG).filter((f) => f.endsWith(".js"));
  assert.ok(modules.length >= 20, `the EEG library is in ${EEG}`);
  const problems = [];
  for (const f of modules) {
    for (const [kind, address] of addressesIn(readFileSync(join(EEG, f), "utf8"))) {
      if (address === null) problems.push(`${f}: ${kind} of an address worked out at run time`);
      else if (!/^\.\/[a-z0-9_]+\.js$/.test(address)) problems.push(`${f}: ${kind} "${address}" is outside js/eeg/`);
      else if (!existsSync(join(EEG, address))) problems.push(`${f}: ${kind} "${address}" does not exist`);
    }
  }
  assert.deepEqual(problems, [], "js/eeg/ must not import the application (see js/eeg/README.md)");
});

test("the folder's guide describes every module", () => {
  const guide = readFileSync(join(EEG, "README.md"), "utf8");
  const missing = readdirSync(EEG).filter((f) => f.endsWith(".js") && !guide.includes(`\`${f}\``));
  assert.deepEqual(missing, []);
});
