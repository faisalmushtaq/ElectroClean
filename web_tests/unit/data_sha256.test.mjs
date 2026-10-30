// SHA-256 of the browser data layer against the FIPS 180-4 examples and node:crypto (the same
// digest as Python's hashlib), in pieces of every size and streamed from files.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import test from "node:test";

import { Sha256, sha256Blob, sha256Hex } from "../../electrotag/web/static/js/eeg/sha256.js";
import { ensureFixtures, fixturePath, expected } from "./_fixtures.mjs";

const enc = (s) => new TextEncoder().encode(s);
const ref = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("FIPS 180-4 examples", () => {
  assert.equal(sha256Hex(enc("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(enc("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(
    sha256Hex(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  const million = new Uint8Array(1_000_000).fill(0x61);
  assert.equal(sha256Hex(million), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("every length around the block and padding boundaries, fed in uneven pieces", () => {
  for (let n = 0; n <= 300; n++) {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = (i * 131 + n) & 255;
    const h = new Sha256();
    let p = 0;
    let step = 1;
    while (p < n) {
      h.update(b.subarray(p, p + step));
      p += step;
      step = (step * 7 + 3) % 97 || 1;
    }
    assert.equal(h.hex(), ref(b), `length ${n}`);
  }
});

test("a finished hash refuses more data", () => {
  const h = new Sha256().update(enc("x"));
  h.hex();
  assert.throws(() => h.update(enc("y")));
});

test("streamed from a Blob in pieces, with and without the browser's own SHA-256", async () => {
  const b = new Uint8Array(3 * 1024 * 1024 + 17);
  for (let i = 0; i < b.length; i++) b[i] = (i * 2654435761) >>> 24;
  const blob = new Blob([b]);
  const want = ref(b);
  const seen = [];
  assert.equal(await sha256Blob(blob, { native: false, chunkBytes: 1 << 20, onProgress: (f) => seen.push(f) }), want);
  assert.equal(seen.at(-1), 1);
  assert.ok(seen.every((f, i) => i === 0 || f >= seen[i - 1]));
  assert.equal(await sha256Blob(blob), want);
  let chunks = 0;
  await sha256Blob(blob, { chunkBytes: 1 << 20, onChunk: () => chunks++ });
  assert.equal(chunks, 4);
  assert.equal(await sha256Blob(new Blob([])), ref(new Uint8Array(0)));
});

test("fixture files hash as hashlib does", async () => {
  const manifest = ensureFixtures();
  for (const name of ["edfplus_gap", "bdf_status", "bv_float32", "bv_vec_int32"]) {
    const exp = expected(name);
    const blob = await openAsBlob(fixturePath(manifest, name, exp.data_file));
    assert.equal(await sha256Blob(blob, { native: false, chunkBytes: 65536 + 3 }), exp.sha256, name);
  }
});

test("the browser's own SHA-256 reports progress while it reads and while it hashes, and ends at 1", async () => {
  const bytes = new Uint8Array(48 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i & 0xff;
  const seen = [];
  const hex = await sha256Blob(new Blob([bytes]), { chunkBytes: 1 << 20, onProgress: (f) => seen.push(f) });
  assert.equal(hex, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(seen.at(-1), 1);
  assert.ok(seen.some((f) => f > 0 && f <= 0.5), "reading");
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `progress goes back: ${seen[i - 1]} then ${seen[i]}`);
  assert.ok(seen.slice(0, -1).every((f) => f < 1), "1 only once the hash is ready");
});
