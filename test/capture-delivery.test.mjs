// Unit tests for capture delivery's pure pieces: target ranking (target.js)
// and the delivery wire validation (delivery.js). The browser-bound halves —
// tab creation, the ping handshake, injection — are exercised for real by the
// headless harness against the built extension.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTarget } from "../src/capture/target.js";
import { deliveredFiles, MAX_DELIVER_FILES } from "../src/capture/delivery.js";
import { bufferToBase64 } from "../src/convert/codec.js";
import { MAX_RELAY_BYTES } from "../src/convert/relay.js";

const tab = (id, host, lastAccessed) => ({ id, url: `https://${host}/chat`, lastAccessed });
const ENABLED = ["claude.ai", "chatgpt.com", "gemini.google.com"];

// ------------------------------------------------------------- pickTarget ---

test("most recently accessed open tab wins", () => {
  const t = pickTarget({
    tabs: [tab(1, "claude.ai", 100), tab(2, "chatgpt.com", 300), tab(3, "claude.ai", 200)],
    enabled: ENABLED,
  });
  assert.deepEqual(t, { host: "chatgpt.com", tabId: 2, via: "open tab" });
});

test("a forced pick targets that host's newest tab", () => {
  const t = pickTarget({
    tabs: [tab(1, "claude.ai", 100), tab(2, "chatgpt.com", 300), tab(3, "claude.ai", 200)],
    enabled: ENABLED,
    forcedHost: "claude.ai",
  });
  assert.deepEqual(t, { host: "claude.ai", tabId: 3, via: "picked" });
});

test("a forced pick with no open tab creates one (tabId null)", () => {
  const t = pickTarget({ tabs: [tab(2, "chatgpt.com", 300)], enabled: ENABLED, forcedHost: "gemini.google.com" });
  assert.deepEqual(t, { host: "gemini.google.com", tabId: null, via: "picked" });
});

test("no open tabs falls back to the stored last-injected host", () => {
  const t = pickTarget({ tabs: [], enabled: ENABLED, storedHost: "chatgpt.com" });
  assert.deepEqual(t, { host: "chatgpt.com", tabId: null, via: "last injected" });
});

test("a stored host no longer enabled is skipped for the first enabled", () => {
  const t = pickTarget({ tabs: [], enabled: ENABLED, storedHost: "chat.mistral.ai" });
  assert.deepEqual(t, { host: "claude.ai", tabId: null, via: "first enabled" });
});

test("nothing enabled means no target", () => {
  assert.equal(pickTarget({ tabs: [], enabled: [] }), null);
});

test("tabs without lastAccessed still rank (as oldest)", () => {
  // Defensive floor: the field is Chrome 121+/Firefox — an older engine just
  // degrades to "any open tab beats none".
  const t = pickTarget({
    tabs: [{ id: 9, url: "https://claude.ai/x" }, tab(2, "chatgpt.com", 1)],
    enabled: ENABLED,
  });
  assert.deepEqual(t, { host: "chatgpt.com", tabId: 2, via: "open tab" });
});

// --------------------------------------------------------- deliveredFiles ---

test("text wire becomes a Markdown File", async () => {
  const [f] = deliveredFiles({
    files: [{ name: "page.md", type: "text/markdown", text: "# Hi\n" }],
  });
  assert.equal(f.name, "page.md");
  assert.equal(f.type, "text/markdown");
  assert.equal(await f.text(), "# Hi\n");
});

test("base64 wire becomes a binary File", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const [f] = deliveredFiles({
    files: [{ name: "fig.png", type: "image/png", data: bufferToBase64(bytes) }],
  });
  assert.equal(f.name, "fig.png");
  assert.deepEqual(new Uint8Array(await f.arrayBuffer()), bytes);
});

test("malformed deliveries throw", () => {
  assert.throws(() => deliveredFiles({}), /no files/);
  assert.throws(() => deliveredFiles({ files: [] }), /no files/);
  assert.throws(() => deliveredFiles({ files: [{ name: "", type: "t", text: "x" }] }), /malformed/);
  assert.throws(() => deliveredFiles({ files: [{ name: "a", type: "t" }] }), /no content/);
  assert.throws(
    () =>
      deliveredFiles({
        files: Array.from({ length: MAX_DELIVER_FILES + 1 }, (_, i) => ({
          name: `f${i}.md`,
          type: "text/markdown",
          text: "x",
        })),
      }),
    /too many/
  );
});

test("the size cap counts decoded bytes across the batch", () => {
  const half = "x".repeat(MAX_RELAY_BYTES / 2 + 1);
  assert.throws(
    () =>
      deliveredFiles({
        files: [
          { name: "a.md", type: "text/markdown", text: half },
          { name: "b.md", type: "text/markdown", text: half },
        ],
      }),
    /size cap/
  );
});

test("names are capped, content is preserved verbatim", async () => {
  const [f] = deliveredFiles({
    files: [{ name: "n".repeat(400), type: "text/markdown", text: "body" }],
  });
  assert.equal(f.name.length, 128);
  assert.equal(await f.text(), "body");
});
