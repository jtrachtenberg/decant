// Unit tests for the picker-bridge protocol (src/content/bridge.js) — the
// postMessage channel between the MAIN-world detached-picker shim and the
// isolated-world pipeline (ADR 0019). Pure message construction/validation;
// the DOM halves are covered by the headless e2e run (verify skill).
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { CHANNEL, MSG, bridgeMsg, isBridgeMsg, bridgeFiles } from "../src/content/bridge.js";

test("bridgeMsg stamps the channel and round-trips through isBridgeMsg", () => {
  const m = bridgeMsg(MSG.PICK, { id: 7 });
  assert.equal(m.channel, CHANNEL);
  assert.equal(m.id, 7);
  assert.ok(isBridgeMsg(m, MSG.PICK));
  assert.ok(!isBridgeMsg(m, MSG.INJECT)); // type must match exactly
});

test("isBridgeMsg rejects junk, other channels, and non-objects", () => {
  for (const bad of [null, undefined, 42, "pick", [], {}]) {
    assert.ok(!isBridgeMsg(bad, MSG.PICK), `accepted: ${JSON.stringify(bad)}`);
  }
  // A page message that happens to share the type but not the channel — the
  // realistic collision on a busy site using postMessage for its own plumbing.
  assert.ok(!isBridgeMsg({ channel: "site-bus", type: MSG.PICK }, MSG.PICK));
});

test("bridgeFiles keeps only real File instances", () => {
  const f = new File(["x"], "doc.pdf", { type: "application/pdf" });
  // Forged/malformed payloads must not smuggle non-Files into the pipeline:
  // plain objects shaped like files, blobs, strings, nulls all drop.
  const m = bridgeMsg(MSG.INJECT, {
    id: 1,
    files: [f, { name: "fake.pdf" }, new Blob(["y"]), "doc.pdf", null],
  });
  assert.deepEqual(bridgeFiles(m), [f]);
});

test("bridgeFiles tolerates a missing or non-array files field", () => {
  assert.deepEqual(bridgeFiles(bridgeMsg(MSG.READY)), []);
  assert.deepEqual(bridgeFiles(bridgeMsg(MSG.INJECT, { id: 2, files: "nope" })), []);
  assert.deepEqual(bridgeFiles(null), []);
});
